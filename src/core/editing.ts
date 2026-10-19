import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { timestamp } from './installer';
import { pathKey } from './paths';
import { UserError, type ProviderId } from './types';

/**
 * Writes for the Config tab: create / delete rules, commands, prompts and
 * subagents from per-agent templates, and add / remove / enable MCP servers in
 * each agent's own format. Formats verified 2026-10-19 (see customizations.ts).
 * Every write keeps a backup and goes through a temp file + rename. Nothing is
 * ever executed; an MCP server only runs when the agent itself starts it.
 */

// ---------- files from templates ----------

export type TemplateKind =
  | 'claude-rule'
  | 'cursor-rule'
  | 'copilot-instructions'
  | 'claude-command'
  | 'copilot-prompt'
  | 'claude-agent'
  | 'copilot-agent';

export interface TemplateSpec {
  kind: TemplateKind;
  label: string;
  agents: ProviderId[];
  /** Folder relative to the workspace (project) or home (user); undefined = scope not supported. */
  project?: string;
  user?: string;
  ext: string;
  body: (name: string) => string;
}

export const TEMPLATES: TemplateSpec[] = [
  { kind: 'claude-rule', label: 'Claude Code rule', agents: ['claude-code', 'copilot'], project: '.claude/rules', user: '.claude/rules', ext: '.md', body: (n) => `# ${n}\n\nDescribe the rule. Add \`paths:\` frontmatter to scope it to some files.\n` },
  { kind: 'cursor-rule', label: 'Cursor rule (.mdc)', agents: ['cursor'], project: '.cursor/rules', ext: '.mdc', body: () => `---\ndescription: \nglobs: \nalwaysApply: false\n---\n\nDescribe the rule.\n` },
  { kind: 'copilot-instructions', label: 'Copilot instructions file', agents: ['copilot'], project: '.github/instructions', user: '.copilot/instructions', ext: '.instructions.md', body: () => `---\napplyTo: "**"\n---\n\nDescribe the instructions.\n` },
  { kind: 'claude-command', label: 'Claude Code command', agents: ['claude-code'], project: '.claude/commands', user: '.claude/commands', ext: '.md', body: (n) => `Describe what /${n} should do. Use $ARGUMENTS for the text after the command.\n` },
  { kind: 'copilot-prompt', label: 'Copilot prompt file', agents: ['copilot'], project: '.github/prompts', ext: '.prompt.md', body: () => `---\ndescription: \n---\n\nDescribe the task.\n` },
  { kind: 'claude-agent', label: 'Claude Code subagent (also read by Copilot)', agents: ['claude-code', 'copilot'], project: '.claude/agents', user: '.claude/agents', ext: '.md', body: (n) => `---\nname: ${n}\ndescription: When to delegate to this subagent.\n---\n\nYou are ${n}. Describe its role and steps.\n` },
  { kind: 'copilot-agent', label: 'Copilot custom agent', agents: ['copilot'], project: '.github/agents', user: '.copilot/agents', ext: '.agent.md', body: () => `---\ndescription: What this agent does.\n---\n\nDescribe the agent's behaviour.\n` },
];

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function templatePath(kind: TemplateKind, scope: 'project' | 'user', name: string, base: { workspace?: string; home: string }): string {
  const t = TEMPLATES.find((x) => x.kind === kind);
  if (!t) throw new UserError('Unknown file type.', 'edit');
  if (!NAME_RE.test(name)) throw new UserError('Use letters, numbers, "-" or "_" (max 64), starting with a letter or number.', 'edit');
  const dir = scope === 'project' ? t.project : t.user;
  const root = scope === 'project' ? base.workspace : base.home;
  if (!dir || !root) throw new UserError(`${t.label} has no ${scope} location.`, 'edit');
  return path.join(root, dir, name + t.ext);
}

/** Creates a new file from the template; never overwrites. */
export async function createFromTemplate(kind: TemplateKind, scope: 'project' | 'user', name: string, base: { workspace?: string; home: string }): Promise<string> {
  const file = templatePath(kind, scope, name, base);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, TEMPLATES.find((x) => x.kind === kind)!.body(name), { flag: 'wx', mode: 0o644 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new UserError(`${path.basename(file)} already exists.`, 'edit');
    throw e;
  }
  return file;
}

/** Moves a rule/command/agent/prompt file to the backup folder. */
export async function deleteToBackup(file: string, backupRoot: string): Promise<string> {
  const st = await fs.lstat(file).catch(() => null);
  if (!st?.isFile()) throw new UserError(`${path.basename(file)} no longer exists. Refresh.`, 'edit');
  await fs.mkdir(backupRoot, { recursive: true });
  const dest = path.join(backupRoot, `${timestamp()}-${path.basename(file)}`);
  await fs.rename(file, dest).catch(async (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EXDEV') throw e;
    await fs.copyFile(file, dest);
    await fs.rm(file);
  });
  return dest;
}

// ---------- MCP ----------

/**
 * Which agent's file this is, which decides the entry shape (verified 2026-10-19):
 *  - claude (.mcp.json): `mcpServers`, `type: "stdio" | "http"` — code.claude.com/docs/en/mcp
 *  - vscode (.vscode/mcp.json, profile mcp.json): `servers`, same types — code.visualstudio.com/docs/copilot/reference/mcp-configuration
 *  - cursor (.cursor/mcp.json): `mcpServers`, `type: "stdio"`; remote entries only `url` — cursor.com/docs/context/mcp
 *  - copilot-cli (~/.copilot/mcp-config.json): `mcpServers`, `type: "local" | "http"` and `tools: ["*"]` —
 *    docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
 *  - codex (config.toml): `[mcp_servers.<name>]` with command/args or url — learn.chatgpt.com/docs/extend/mcp
 */
export type McpFlavor = 'claude' | 'vscode' | 'cursor' | 'copilot-cli' | 'codex';

const jsonKey = (f: McpFlavor): 'mcpServers' | 'servers' => (f === 'vscode' ? 'servers' : 'mcpServers');

export function mcpEntry(flavor: Exclude<McpFlavor, 'codex'>, s: NewMcpServer): Record<string, unknown> {
  const args = s.args?.length ? { args: s.args } : {};
  const tools = flavor === 'copilot-cli' ? { tools: ['*'] } : {};
  if (s.transport === 'stdio') return { type: flavor === 'copilot-cli' ? 'local' : 'stdio', command: s.command!.trim(), ...args, ...tools };
  return { ...(flavor === 'cursor' ? {} : { type: 'http' }), url: s.url, ...tools };
}

export interface NewMcpServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
}

const SERVER_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function validateServer(s: NewMcpServer): void {
  if (!SERVER_NAME_RE.test(s.name) || ['__proto__', 'constructor', 'prototype'].includes(s.name)) throw new UserError('Server names use letters, numbers, ".", "-" or "_" (max 64).', 'edit');
  if (s.transport === 'stdio') {
    if (!s.command?.trim() || /[\r\n]/.test(s.command)) throw new UserError('Enter the command that starts the server.', 'edit');
  } else {
    let u: URL;
    try {
      u = new URL(s.url ?? '');
    } catch {
      throw new UserError('Enter a valid URL.', 'edit');
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) {
      throw new UserError('Use https:// (http:// only for localhost).', 'edit');
    }
  }
}

/** Splits an arguments line like a shell would for simple quoting ("a b" 'c d' e). */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}

/** True when a JSON file has comments (JSONC): rewriting it would drop them. */
export function hasJsonComments(text: string): boolean {
  const noStrings = text.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  return /\/\/|\/\*/.test(noStrings);
}

async function replaceText(file: string, next: string, backupRoot: string): Promise<string | undefined> {
  let backup: string | undefined;
  const prev = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (prev !== undefined) {
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

/** Files Claude Code rewrites itself: edit them with `claude mcp add/remove`, never here. */
export function isManagedByAgent(file: string, home: string): boolean {
  return pathKey(file) === pathKey(path.join(home, '.claude.json'));
}

async function readJsonForEdit(file: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined || !text.trim()) return {};
  if (hasJsonComments(text)) throw new UserError(`${path.basename(file)} has comments; edit it by hand so they aren't lost.`, 'edit');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new UserError(`${path.basename(file)} is not valid JSON; edit it by hand.`, 'edit');
  }
}

function tomlString(v: string): string {
  return JSON.stringify(v); // TOML basic strings use the same escapes as JSON for what we write
}

function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** Line range of `[mcp_servers.<name>]` and its sub-tables in a TOML text. */
function codexServerRange(lines: string[], name: string): [number, number] | undefined {
  const head = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")(\\.[^\\]]+)?\\s*\\]`);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) {
      if (start === -1) start = i;
      end = i;
      continue;
    }
    if (start !== -1 && /^\s*\[/.test(lines[i])) break;
    if (start !== -1) end = i;
  }
  if (start === -1) return undefined;
  while (end > start && !lines[end].trim()) end--;
  return [start, end];
}

export async function addMcpServer(file: string, flavor: McpFlavor, server: NewMcpServer, backupRoot: string): Promise<string | undefined> {
  validateServer(server);
  if (flavor === 'codex') {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const lines = text.split(/\r?\n/);
    if (codexServerRange(lines, server.name)) throw new UserError(`"${server.name}" already exists in ${path.basename(file)}.`, 'edit');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const block = [
      `[mcp_servers.${tomlKey(server.name)}]`,
      ...(server.transport === 'stdio'
        ? [`command = ${tomlString(server.command!.trim())}`, ...(server.args?.length ? [`args = [${server.args.map(tomlString).join(', ')}]`] : [])]
        : [`url = ${tomlString(server.url!)}`]),
    ];
    const body = text.replace(/\s*$/, '');
    return replaceText(file, (body ? body + eol + eol : '') + block.join(eol) + eol, backupRoot);
  }
  const root = await readJsonForEdit(file);
  const key = jsonKey(flavor);
  const servers = { ...((root[key] as Record<string, unknown>) ?? {}) };
  if (Object.hasOwn(servers, server.name)) throw new UserError(`"${server.name}" already exists in ${path.basename(file)}.`, 'edit');
  servers[server.name] = mcpEntry(flavor, server);
  return replaceText(file, JSON.stringify({ ...root, [key]: servers }, null, 2) + '\n', backupRoot);
}

export async function removeMcpServer(file: string, flavor: McpFlavor, name: string, backupRoot: string): Promise<string | undefined> {
  if (flavor === 'codex') {
    const text = await fs.readFile(file, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const range = codexServerRange(lines, name);
    if (!range) throw new UserError(`"${name}" is not in ${path.basename(file)}.`, 'edit');
    lines.splice(range[0], range[1] - range[0] + 1);
    return replaceText(file, lines.join(eol).replace(/\n{3,}/g, '\n\n'), backupRoot);
  }
  const root = await readJsonForEdit(file);
  const key = jsonKey(flavor);
  const servers = { ...((root[key] as Record<string, unknown>) ?? {}) };
  if (!Object.hasOwn(servers, name)) throw new UserError(`"${name}" is not in ${path.basename(file)}.`, 'edit');
  delete servers[name];
  return replaceText(file, JSON.stringify({ ...root, [key]: servers }, null, 2) + '\n', backupRoot);
}

/** Codex only (`enabled = false` is documented there); other agents toggle servers in their own UI. */
export async function setCodexMcpEnabled(file: string, name: string, enabled: boolean, backupRoot: string): Promise<string | undefined> {
  const text = await fs.readFile(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const range = codexServerRange(lines, name);
  if (!range) throw new UserError(`"${name}" is not in ${path.basename(file)}.`, 'edit');
  // Only the server's own table (before any sub-table) holds `enabled`.
  let end = range[0];
  while (end + 1 <= range[1] && !/^\s*\[/.test(lines[end + 1])) end++;
  const at = lines.slice(range[0] + 1, end + 1).findIndex((l) => /^\s*enabled\s*=/.test(l));
  if (at >= 0) lines[range[0] + 1 + at] = lines[range[0] + 1 + at].replace(/(=\s*)(true|false)/, `$1${enabled}`);
  else lines.splice(range[0] + 1, 0, `enabled = ${enabled}`);
  return replaceText(file, lines.join(eol), backupRoot);
}
