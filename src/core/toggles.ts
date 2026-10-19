import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setFrontmatterKey } from './fixes';
import { parseFrontmatter } from './frontmatter';
import { timestamp } from './installer';
import { pathKey } from './paths';
import { UserError, type SkillRecord } from './types';

/**
 * Enable / disable a skill per agent, with each agent's own documented
 * mechanism (verified 2026-10-19):
 *  - Claude Code: `skillOverrides` in settings — each key a skill name, value
 *    "on" | "name-only" | "user-invocable-only" | "off" (absent = "on"). Read
 *    from user, project and local settings (local wins). Plugin skills are not
 *    affected. https://code.claude.com/docs/en/skills
 *  - Codex: `[[skills.config]]` with `path` = the SKILL.md and `enabled = false`
 *    in ~/.codex/config.toml; restart Codex. https://learn.chatgpt.com/docs/build-skills
 *  - Cursor and Copilot (VS Code): no per-skill setting, only frontmatter in
 *    the skill itself: `disable-model-invocation: true` (only via /name) and,
 *    for VS Code, `user-invocable: false` too = disabled. Editing the skill
 *    affects every agent that honours those keys (Claude Code does as well).
 */
export type ClaudeOverride = 'on' | 'name-only' | 'user-invocable-only' | 'off';
export const CLAUDE_OVERRIDES: ClaudeOverride[] = ['on', 'name-only', 'user-invocable-only', 'off'];

export interface ToggleFiles {
  claudeUser: string;
  claudeProject?: string;
  claudeLocal?: string;
  codexConfig: string;
}

export function toggleFiles(homeDir: string, workspaceFolder?: string): ToggleFiles {
  return {
    claudeUser: path.join(homeDir, '.claude', 'settings.json'),
    claudeProject: workspaceFolder ? path.join(workspaceFolder, '.claude', 'settings.json') : undefined,
    claudeLocal: workspaceFolder ? path.join(workspaceFolder, '.claude', 'settings.local.json') : undefined,
    codexConfig: path.join(homeDir, '.codex', 'config.toml'),
  };
}

export interface SkillToggleState {
  claude?: { value: ClaudeOverride; from?: 'user' | 'project' | 'local' };
  codex?: { enabled: boolean };
  /** Frontmatter flags (Cursor, Copilot and Claude Code honour them). */
  modelInvocation: boolean;
  userInvocable: boolean;
}

// ---------- Claude settings (JSON) ----------

async function readJsonFile(file?: string): Promise<Record<string, unknown> | undefined> {
  if (!file) return undefined;
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new UserError(`${file} is not valid JSON; edit it by hand.`, 'toggle');
  }
}

function overridesOf(settings?: Record<string, unknown>): Record<string, string> {
  const o = settings?.['skillOverrides'];
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {};
}

// ---------- Codex config (TOML, only [[skills.config]]) ----------

export interface CodexSkillEntry {
  path: string;
  enabled: boolean;
  /** Line range of the table in the file (header line .. last line, inclusive). */
  start: number;
  end: number;
  enabledLine?: number;
  pathLine: number;
}

function tomlString(v: string): string | undefined {
  const t = v.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t.replace(/\s+#.*$/, ''));
    } catch {
      return undefined;
    }
  }
  if (t.startsWith("'")) {
    const m = /^'([^']*)'/.exec(t);
    return m ? m[1] : undefined;
  }
  return undefined;
}

/** Reads only `[[skills.config]]` tables; everything else in the file is left alone. */
export function parseCodexSkillConfig(toml: string): CodexSkillEntry[] {
  const lines = toml.split(/\r?\n/);
  const out: CodexSkillEntry[] = [];
  let cur: Partial<CodexSkillEntry> & { start: number } | undefined;
  const close = (end: number) => {
    if (cur && typeof cur.path === 'string' && cur.pathLine !== undefined) out.push({ enabled: true, ...cur, end } as CodexSkillEntry);
    cur = undefined;
  };
  lines.forEach((line, i) => {
    if (/^\s*\[\[\s*skills\.config\s*\]\]\s*(#.*)?$/.test(line)) {
      close(i - 1);
      cur = { start: i };
      return;
    }
    if (/^\s*\[/.test(line)) {
      close(i - 1);
      return;
    }
    if (!cur) return;
    const kv = /^\s*(path|enabled)\s*=\s*(.+)$/.exec(line);
    if (!kv) return;
    if (kv[1] === 'path') {
      const p = tomlString(kv[2]);
      if (p !== undefined) {
        cur.path = p;
        cur.pathLine = i;
      }
    } else {
      const b = /^(true|false)\b/.exec(kv[2].trim());
      if (b) {
        cur.enabled = b[1] === 'true';
        cur.enabledLine = i;
      }
    }
  });
  close(lines.length - 1);
  // Trailing blank lines don't belong to the last table.
  for (const e of out) while (e.end > e.start && !lines[e.end].trim()) e.end--;
  return out;
}

/** Sets `enabled` for a SKILL.md path with a minimal edit (or appends a new table). */
export function setCodexSkillEnabled(toml: string, skillMd: string, enabled: boolean, platform: NodeJS.Platform = process.platform): string {
  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  const lines = toml.length ? toml.split(/\r?\n/) : [];
  const hit = parseCodexSkillConfig(toml).find((e) => pathKey(e.path, platform) === pathKey(skillMd, platform));
  if (hit) {
    if (hit.enabledLine !== undefined) lines[hit.enabledLine] = lines[hit.enabledLine].replace(/(=\s*)(true|false)/, `$1${enabled}`);
    else lines.splice(hit.pathLine + 1, 0, `enabled = ${enabled}`);
    return lines.join(eol);
  }
  if (enabled) return toml; // absent = enabled
  const block = ['[[skills.config]]', `path = ${JSON.stringify(skillMd)}`, 'enabled = false'];
  const body = lines.join(eol).replace(/\s*$/, '');
  return (body ? body + eol + eol : '') + block.join(eol) + eol;
}

// ---------- read state ----------

export async function readToggleState(skill: SkillRecord, files: ToggleFiles): Promise<SkillToggleState> {
  const layers: Array<['user' | 'project' | 'local', string | undefined]> = [
    ['user', files.claudeUser],
    ['project', files.claudeProject],
    ['local', files.claudeLocal],
  ];
  let claude: SkillToggleState['claude'];
  if (!skill.namespace) {
    claude = { value: 'on' };
    for (const [from, file] of layers) {
      const v = overridesOf(await readJsonFile(file).catch(() => undefined))[skill.name];
      if (typeof v === 'string' && (CLAUDE_OVERRIDES as string[]).includes(v)) claude = { value: v as ClaudeOverride, from };
    }
  }
  let codex: SkillToggleState['codex'] = { enabled: true };
  try {
    const entry = parseCodexSkillConfig(await fs.readFile(files.codexConfig, 'utf8')).find((e) => pathKey(e.path) === pathKey(skill.skillFile));
    if (entry) codex = { enabled: entry.enabled };
  } catch {
    /* no config */
  }
  const fm = skill.frontmatter;
  return {
    claude,
    codex,
    modelInvocation: fm['disable-model-invocation'] !== true,
    userInvocable: fm['user-invocable'] !== false,
  };
}

// ---------- writes (backup + atomic replace) ----------

async function replaceFile(file: string, next: string, backupRoot: string): Promise<string | undefined> {
  let backup: string | undefined;
  const prev = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (prev !== undefined) {
    if (prev === next) return undefined;
    await fs.mkdir(backupRoot, { recursive: true });
    backup = path.join(backupRoot, `${timestamp()}-${path.basename(path.dirname(file))}-${path.basename(file)}`);
    await fs.writeFile(backup, prev, { flag: 'wx', mode: 0o644 });
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, next, { flag: 'wx', mode: 0o644 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return backup;
}

/** Claude Code: write `skillOverrides[name]` ("on" removes the key) in one settings file. */
export async function setClaudeOverride(file: string, skillName: string, value: ClaudeOverride, backupRoot: string): Promise<string | undefined> {
  const settings = (await readJsonFile(file)) ?? {};
  const overrides = { ...overridesOf(settings) };
  if (value === 'on') delete overrides[skillName];
  else overrides[skillName] = value;
  const next = { ...settings };
  if (Object.keys(overrides).length) next['skillOverrides'] = overrides;
  else delete next['skillOverrides'];
  return replaceFile(file, JSON.stringify(next, null, 2) + '\n', backupRoot);
}

/** Codex: `[[skills.config]] path = <SKILL.md> enabled = …` in ~/.codex/config.toml. */
export async function setCodexEnabled(configFile: string, skillMd: string, enabled: boolean, backupRoot: string): Promise<string | undefined> {
  const prev = await fs.readFile(configFile, 'utf8').catch(() => '');
  return replaceFile(configFile, setCodexSkillEnabled(prev, skillMd, enabled), backupRoot);
}

/** Frontmatter flags in the skill itself (Cursor, Copilot, Claude Code). */
export async function setInvocationFlags(skill: SkillRecord, flags: { modelInvocation: boolean; userInvocable: boolean }, backupRoot: string): Promise<string | undefined> {
  if (skill.readOnly) throw new UserError(`"${skill.name}" is read-only: ${skill.readOnlyReason ?? ''}`.trim(), 'toggle');
  const file = path.join(skill.realDir, 'SKILL.md');
  const original = await fs.readFile(file, 'utf8');
  let next = setBoolKey(original, 'disable-model-invocation', !flags.modelInvocation);
  next = setBoolKey(next, 'user-invocable', flags.userInvocable);
  return replaceFile(file, next, backupRoot);
}

/** Sets a boolean frontmatter key; the default value removes nothing but writes it explicitly only when needed. */
function setBoolKey(source: string, key: string, value: boolean): string {
  const fm = parseFrontmatter(source);
  const defaults: Record<string, boolean> = { 'disable-model-invocation': false, 'user-invocable': true };
  if (!(key in fm.data) && value === defaults[key]) return source;
  // setFrontmatterKey quotes strings; write the YAML boolean by replacing the quoted value.
  const withString = setFrontmatterKey(source, key, String(value));
  return withString.replace(new RegExp(`^(${key}:\\s*)"${value}"`, 'm'), `$1${value}`);
}
