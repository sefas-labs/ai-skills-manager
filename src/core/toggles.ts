import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setFrontmatterKey } from './fixes';
import { parseFrontmatter } from './frontmatter';
import { pathKey } from './paths';
import { replaceWithBackup } from './safeWrite';
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

type ClaudeSettingsLayer = 'user' | 'project' | 'local';

const SKILL_OVERRIDES_KEY = 'skillOverrides';
const DISABLE_MODEL_INVOCATION_KEY = 'disable-model-invocation';
const USER_INVOCABLE_KEY = 'user-invocable';
/** Values the agents assume when a frontmatter key is absent. */
const FRONTMATTER_DEFAULTS: Record<string, boolean> = { [DISABLE_MODEL_INVOCATION_KEY]: false, [USER_INVOCABLE_KEY]: true };

const CODEX_SKILL_TABLE_HEADER = /^\s*\[\[\s*skills\.config\s*\]\]\s*(#.*)?$/;
const ANY_TABLE_HEADER = /^\s*\[/;
const CODEX_SKILL_KEY_LINE = /^\s*(path|enabled)\s*=\s*(.+)$/;
const BOOLEAN_VALUE = /^(true|false)\b/;
const BOOLEAN_ASSIGNMENT = /(=\s*)(true|false)/;
const TRAILING_COMMENT = /\s+#.*$/;
const SINGLE_QUOTED_STRING = /^'([^']*)'/;
const TRAILING_WHITESPACE = /\s*$/;

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
  claude?: { value: ClaudeOverride; from?: ClaudeSettingsLayer };
  codex?: { enabled: boolean };
  /** Frontmatter flags (Cursor, Copilot and Claude Code honour them). */
  modelInvocation: boolean;
  userInvocable: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function lineEndingOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isPlainObject(parsed)) throw new UserError(`${file} is not valid JSON; edit it by hand.`, 'toggle');
  return parsed;
}

function overridesOf(settings?: Record<string, unknown>): Record<string, string> {
  const overrides = settings?.[SKILL_OVERRIDES_KEY];
  return isPlainObject(overrides) ? (overrides as Record<string, string>) : {};
}

function isClaudeOverride(value: unknown): value is ClaudeOverride {
  return typeof value === 'string' && (CLAUDE_OVERRIDES as string[]).includes(value);
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

/** Value of a TOML basic ("…") or literal ('…') string, or undefined. */
function readTomlString(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value.replace(TRAILING_COMMENT, ''));
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'")) return SINGLE_QUOTED_STRING.exec(value)?.[1];
  return undefined;
}

/** Reads only `[[skills.config]]` tables; everything else in the file is left alone. */
export function parseCodexSkillConfig(toml: string): CodexSkillEntry[] {
  const lines = toml.split(/\r?\n/);
  const entries: CodexSkillEntry[] = [];
  let current: (Partial<CodexSkillEntry> & { start: number }) | undefined;

  const closeCurrentTable = (lastLine: number) => {
    const isComplete = current && typeof current.path === 'string' && current.pathLine !== undefined;
    if (isComplete) entries.push({ enabled: true, ...current, end: lastLine } as CodexSkillEntry);
    current = undefined;
  };

  lines.forEach((line, lineIndex) => {
    if (CODEX_SKILL_TABLE_HEADER.test(line)) {
      closeCurrentTable(lineIndex - 1);
      current = { start: lineIndex };
      return;
    }
    if (ANY_TABLE_HEADER.test(line)) {
      closeCurrentTable(lineIndex - 1);
      return;
    }
    if (!current) return;
    const keyLine = CODEX_SKILL_KEY_LINE.exec(line);
    if (!keyLine) return;
    const [, key, rawValue] = keyLine;
    if (key === 'path') {
      const skillPath = readTomlString(rawValue);
      if (skillPath !== undefined) {
        current.path = skillPath;
        current.pathLine = lineIndex;
      }
    } else {
      const booleanValue = BOOLEAN_VALUE.exec(rawValue.trim());
      if (booleanValue) {
        current.enabled = booleanValue[1] === 'true';
        current.enabledLine = lineIndex;
      }
    }
  });
  closeCurrentTable(lines.length - 1);

  // Trailing blank lines don't belong to the last table.
  for (const entry of entries) {
    while (entry.end > entry.start && !lines[entry.end].trim()) entry.end--;
  }
  return entries;
}

/** Sets `enabled` for a SKILL.md path with a minimal edit (or appends a new table). */
export function setCodexSkillEnabled(toml: string, skillMd: string, enabled: boolean, platform: NodeJS.Platform = process.platform): string {
  const lineEnding = lineEndingOf(toml);
  const lines = toml.length ? toml.split(/\r?\n/) : [];
  const existing = parseCodexSkillConfig(toml).find((entry) => pathKey(entry.path, platform) === pathKey(skillMd, platform));
  if (existing) {
    if (existing.enabledLine !== undefined) {
      lines[existing.enabledLine] = lines[existing.enabledLine].replace(BOOLEAN_ASSIGNMENT, `$1${enabled}`);
    } else {
      lines.splice(existing.pathLine + 1, 0, `enabled = ${enabled}`);
    }
    return lines.join(lineEnding);
  }
  const absentMeansEnabled = enabled;
  if (absentMeansEnabled) return toml;
  const newTable = ['[[skills.config]]', `path = ${JSON.stringify(skillMd)}`, 'enabled = false'];
  const body = lines.join(lineEnding).replace(TRAILING_WHITESPACE, '');
  const separator = body ? lineEnding + lineEnding : '';
  return body + separator + newTable.join(lineEnding) + lineEnding;
}

// ---------- read state ----------

async function readClaudeOverride(skill: SkillRecord, files: ToggleFiles): Promise<SkillToggleState['claude']> {
  // Plugin skills are not affected by skillOverrides.
  if (skill.namespace) return undefined;
  const layersInPrecedenceOrder: Array<[ClaudeSettingsLayer, string | undefined]> = [
    ['user', files.claudeUser],
    ['project', files.claudeProject],
    ['local', files.claudeLocal],
  ];
  let state: SkillToggleState['claude'] = { value: 'on' };
  for (const [layer, file] of layersInPrecedenceOrder) {
    const settings = await readJsonFile(file).catch(() => undefined);
    const value = overridesOf(settings)[skill.name];
    if (isClaudeOverride(value)) state = { value, from: layer };
  }
  return state;
}

async function readCodexEnabled(skill: SkillRecord, files: ToggleFiles): Promise<SkillToggleState['codex']> {
  const toml = await fs.readFile(files.codexConfig, 'utf8').catch(() => undefined);
  if (toml === undefined) return { enabled: true };
  const entry = parseCodexSkillConfig(toml).find((candidate) => pathKey(candidate.path) === pathKey(skill.skillFile));
  return { enabled: entry ? entry.enabled : true };
}

export async function readToggleState(skill: SkillRecord, files: ToggleFiles): Promise<SkillToggleState> {
  return {
    claude: await readClaudeOverride(skill, files),
    codex: await readCodexEnabled(skill, files),
    modelInvocation: skill.frontmatter[DISABLE_MODEL_INVOCATION_KEY] !== true,
    userInvocable: skill.frontmatter[USER_INVOCABLE_KEY] !== false,
  };
}

// ---------- writes (backup + atomic replace) ----------

/** Claude Code: write `skillOverrides[name]` ("on" removes the key) in one settings file. */
export async function setClaudeOverride(file: string, skillName: string, value: ClaudeOverride, backupRoot: string): Promise<string | undefined> {
  const settings = (await readJsonFile(file)) ?? {};
  const overrides = { ...overridesOf(settings) };
  if (value === 'on') delete overrides[skillName];
  else overrides[skillName] = value;
  const nextSettings = { ...settings };
  if (Object.keys(overrides).length) nextSettings[SKILL_OVERRIDES_KEY] = overrides;
  else delete nextSettings[SKILL_OVERRIDES_KEY];
  return replaceWithBackup(file, JSON.stringify(nextSettings, null, 2) + '\n', backupRoot);
}

/** Codex: `[[skills.config]] path = <SKILL.md> enabled = …` in ~/.codex/config.toml. */
export async function setCodexEnabled(configFile: string, skillMd: string, enabled: boolean, backupRoot: string): Promise<string | undefined> {
  const currentConfig = await fs.readFile(configFile, 'utf8').catch(() => '');
  return replaceWithBackup(configFile, setCodexSkillEnabled(currentConfig, skillMd, enabled), backupRoot);
}

/** Frontmatter flags in the skill itself (Cursor, Copilot, Claude Code). */
export async function setInvocationFlags(skill: SkillRecord, flags: { modelInvocation: boolean; userInvocable: boolean }, backupRoot: string): Promise<string | undefined> {
  if (skill.readOnly) throw new UserError(`"${skill.name}" is read-only: ${skill.readOnlyReason ?? ''}`.trim(), 'toggle');
  const file = path.join(skill.realDir, 'SKILL.md');
  const original = await fs.readFile(file, 'utf8');
  const withModelFlag = setBooleanKey(original, DISABLE_MODEL_INVOCATION_KEY, !flags.modelInvocation);
  const withBothFlags = setBooleanKey(withModelFlag, USER_INVOCABLE_KEY, flags.userInvocable);
  return replaceWithBackup(file, withBothFlags, backupRoot);
}

/** Sets a boolean frontmatter key, but leaves the file alone when the key is absent and the value is the default. */
function setBooleanKey(source: string, key: string, value: boolean): string {
  const keyIsPresent = key in parseFrontmatter(source).data;
  if (!keyIsPresent && value === FRONTMATTER_DEFAULTS[key]) return source;
  // setFrontmatterKey writes a quoted string; unquote it so YAML reads a boolean.
  const withQuotedValue = setFrontmatterKey(source, key, String(value));
  const quotedValue = new RegExp(`^(${key}:\\s*)"${value}"`, 'm');
  return withQuotedValue.replace(quotedValue, `$1${value}`);
}
