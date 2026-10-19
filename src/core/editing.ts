import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathKey } from './paths';
import { isCrossDeviceError, NEW_FILE, replaceWithBackup, timestamp } from './safeWrite';
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

export type TemplateScope = 'project' | 'user';

export interface TemplateSpec {
  kind: TemplateKind;
  label: string;
  agents: ProviderId[];
  /** Folder relative to the workspace (project) or home (user); undefined = scope not supported. */
  project?: string;
  user?: string;
  extension: string;
  body: (name: string) => string;
}

export const TEMPLATES: TemplateSpec[] = [
  {
    kind: 'claude-rule',
    label: 'Claude Code rule',
    agents: ['claude-code', 'copilot'],
    project: '.claude/rules',
    user: '.claude/rules',
    extension: '.md',
    body: (name) => `# ${name}\n\nDescribe the rule. Add \`paths:\` frontmatter to scope it to some files.\n`,
  },
  {
    kind: 'cursor-rule',
    label: 'Cursor rule (.mdc)',
    agents: ['cursor'],
    project: '.cursor/rules',
    extension: '.mdc',
    body: () => `---\ndescription: \nglobs: \nalwaysApply: false\n---\n\nDescribe the rule.\n`,
  },
  {
    kind: 'copilot-instructions',
    label: 'Copilot instructions file',
    agents: ['copilot'],
    project: '.github/instructions',
    user: '.copilot/instructions',
    extension: '.instructions.md',
    body: () => `---\napplyTo: "**"\n---\n\nDescribe the instructions.\n`,
  },
  {
    kind: 'claude-command',
    label: 'Claude Code command',
    agents: ['claude-code'],
    project: '.claude/commands',
    user: '.claude/commands',
    extension: '.md',
    body: (name) => `Describe what /${name} should do. Use $ARGUMENTS for the text after the command.\n`,
  },
  {
    kind: 'copilot-prompt',
    label: 'Copilot prompt file',
    agents: ['copilot'],
    project: '.github/prompts',
    extension: '.prompt.md',
    body: () => `---\ndescription: \n---\n\nDescribe the task.\n`,
  },
  {
    kind: 'claude-agent',
    label: 'Claude Code subagent (also read by Copilot)',
    agents: ['claude-code', 'copilot'],
    project: '.claude/agents',
    user: '.claude/agents',
    extension: '.md',
    body: (name) => `---\nname: ${name}\ndescription: When to delegate to this subagent.\n---\n\nYou are ${name}. Describe its role and steps.\n`,
  },
  {
    kind: 'copilot-agent',
    label: 'Copilot custom agent',
    agents: ['copilot'],
    project: '.github/agents',
    user: '.copilot/agents',
    extension: '.agent.md',
    body: () => `---\ndescription: What this agent does.\n---\n\nDescribe the agent's behaviour.\n`,
  },
];

/** File names for new rules, commands and agents: no paths, no dots, at most 64 characters. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function findTemplate(kind: TemplateKind): TemplateSpec {
  const template = TEMPLATES.find((candidate) => candidate.kind === kind);
  if (!template) throw new UserError('Unknown file type.', 'edit');
  return template;
}

export function templatePath(kind: TemplateKind, scope: TemplateScope, name: string, base: { workspace?: string; home: string }): string {
  const template = findTemplate(kind);
  if (!NAME_RE.test(name)) throw new UserError('Use letters, numbers, "-" or "_" (max 64), starting with a letter or number.', 'edit');
  const folder = scope === 'project' ? template.project : template.user;
  const root = scope === 'project' ? base.workspace : base.home;
  if (!folder || !root) throw new UserError(`${template.label} has no ${scope} location.`, 'edit');
  return path.join(root, folder, name + template.extension);
}

/** Creates a new file from the template; never overwrites. */
export async function createFromTemplate(kind: TemplateKind, scope: TemplateScope, name: string, base: { workspace?: string; home: string }): Promise<string> {
  const file = templatePath(kind, scope, name, base);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, findTemplate(kind).body(name), NEW_FILE);
  } catch (error) {
    const alreadyExists = (error as NodeJS.ErrnoException).code === 'EEXIST';
    if (alreadyExists) throw new UserError(`${path.basename(file)} already exists.`, 'edit');
    throw error;
  }
  return file;
}

/** Moves a rule/command/agent/prompt file to the backup folder. */
export async function deleteToBackup(file: string, backupRoot: string): Promise<string> {
  const fileStat = await fs.lstat(file).catch(() => null);
  if (!fileStat?.isFile()) throw new UserError(`${path.basename(file)} no longer exists. Refresh.`, 'edit');
  await fs.mkdir(backupRoot, { recursive: true });
  const destination = path.join(backupRoot, `${timestamp()}-${path.basename(file)}`);
  await fs.rename(file, destination).catch(async (error: unknown) => {
    if (!isCrossDeviceError(error)) throw error;
    await fs.copyFile(file, destination);
    await fs.rm(file);
  });
  return destination;
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
type JsonMcpFlavor = Exclude<McpFlavor, 'codex'>;

export interface NewMcpServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
}

const SERVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** Names that would touch Object.prototype instead of adding a key. */
const RESERVED_OBJECT_KEYS = ['__proto__', 'constructor', 'prototype'];
const LINE_BREAK = /[\r\n]/;
const LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const ALL_TOOLS = ['*'];

const SHELL_ARGUMENT = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
const BACKSLASH_ESCAPE = /\\(.)/g;
const JSON_STRING = /"(?:[^"\\\n]|\\.)*"/g;
const JSON_COMMENT_START = /\/\/|\/\*/;

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;
const ANY_TABLE_HEADER = /^\s*\[/;
const ENABLED_LINE = /^\s*enabled\s*=/;
const BOOLEAN_ASSIGNMENT = /(=\s*)(true|false)/;
const TRAILING_WHITESPACE = /\s*$/;
const THREE_OR_MORE_NEWLINES = /\n{3,}/g;
const REGEX_SPECIAL_CHARACTER = /[.*+?^${}()|[\]\\]/g;

function serversKey(flavor: McpFlavor): 'mcpServers' | 'servers' {
  return flavor === 'vscode' ? 'servers' : 'mcpServers';
}

export function mcpEntry(flavor: JsonMcpFlavor, server: NewMcpServer): Record<string, unknown> {
  const isCopilotCli = flavor === 'copilot-cli';
  const tools = isCopilotCli ? { tools: ALL_TOOLS } : {};
  if (server.transport === 'stdio') {
    const args = server.args?.length ? { args: server.args } : {};
    return { type: isCopilotCli ? 'local' : 'stdio', command: server.command!.trim(), ...args, ...tools };
  }
  const type = flavor === 'cursor' ? {} : { type: 'http' };
  return { ...type, url: server.url, ...tools };
}

function isAllowedServerUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCALHOST.test(url.hostname);
}

export function validateServer(server: NewMcpServer): void {
  if (!SERVER_NAME.test(server.name) || RESERVED_OBJECT_KEYS.includes(server.name)) {
    throw new UserError('Server names use letters, numbers, ".", "-" or "_" (max 64).', 'edit');
  }
  if (server.transport === 'stdio') {
    const command = server.command ?? '';
    if (!command.trim() || LINE_BREAK.test(command)) throw new UserError('Enter the command that starts the server.', 'edit');
    return;
  }
  let url: URL;
  try {
    url = new URL(server.url ?? '');
  } catch {
    throw new UserError('Enter a valid URL.', 'edit');
  }
  if (!isAllowedServerUrl(url)) throw new UserError('Use https:// (http:// only for localhost).', 'edit');
}

/** Splits an arguments line like a shell would for simple quoting ("a b" 'c d' e). */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  for (const match of line.matchAll(SHELL_ARGUMENT)) {
    const [, doubleQuoted, singleQuoted, bare] = match;
    if (doubleQuoted !== undefined) args.push(doubleQuoted.replace(BACKSLASH_ESCAPE, '$1'));
    else args.push(singleQuoted ?? bare);
  }
  return args;
}

/** True when a JSON file has comments (JSONC): rewriting it would drop them. */
export function hasJsonComments(text: string): boolean {
  const withoutStrings = text.replace(JSON_STRING, '""');
  return JSON_COMMENT_START.test(withoutStrings);
}

/** Files Claude Code rewrites itself: edit them with `claude mcp add/remove`, never here. */
export function isManagedByAgent(file: string, home: string): boolean {
  return pathKey(file) === pathKey(path.join(home, '.claude.json'));
}

async function readJsonForEdit(file: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined || !text.trim()) return {};
  const fileName = path.basename(file);
  if (hasJsonComments(text)) throw new UserError(`${fileName} has comments; edit it by hand so they aren't lost.`, 'edit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const isObject = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!isObject) throw new UserError(`${fileName} is not valid JSON; edit it by hand.`, 'edit');
  return parsed as Record<string, unknown>;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** TOML basic strings use the same escapes as JSON for the characters we write. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(name: string): string {
  return BARE_TOML_KEY.test(name) ? name : JSON.stringify(name);
}

function lineEndingOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function escapeForRegex(text: string): string {
  return text.replace(REGEX_SPECIAL_CHARACTER, '\\$&');
}

interface LineRange {
  first: number;
  last: number;
}

/** Lines of `[mcp_servers.<name>]` and its sub-tables (e.g. `.env`) in a TOML text. */
function codexServerRange(lines: string[], name: string): LineRange | undefined {
  const escapedName = escapeForRegex(name);
  const serverHeader = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:${escapedName}|"${escapedName}")(\\.[^\\]]+)?\\s*\\]`);
  let first = -1;
  let last = -1;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const insideServer = first !== -1;
    if (serverHeader.test(line)) {
      if (!insideServer) first = lineIndex;
      last = lineIndex;
      continue;
    }
    if (insideServer && ANY_TABLE_HEADER.test(line)) break;
    if (insideServer) last = lineIndex;
  }
  if (first === -1) return undefined;
  while (last > first && !lines[last].trim()) last--;
  return { first, last };
}

function codexServerTable(server: NewMcpServer): string[] {
  const header = `[mcp_servers.${tomlKey(server.name)}]`;
  if (server.transport === 'http') return [header, `url = ${tomlString(server.url!)}`];
  const commandLine = `command = ${tomlString(server.command!.trim())}`;
  const argsLine = server.args?.length ? [`args = [${server.args.map(tomlString).join(', ')}]`] : [];
  return [header, commandLine, ...argsLine];
}

function alreadyExists(name: string, file: string): UserError {
  return new UserError(`"${name}" already exists in ${path.basename(file)}.`, 'edit');
}

function notInFile(name: string, file: string): UserError {
  return new UserError(`"${name}" is not in ${path.basename(file)}.`, 'edit');
}

async function addCodexServer(file: string, server: NewMcpServer, backupRoot: string): Promise<string | undefined> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  if (codexServerRange(text.split(/\r?\n/), server.name)) throw alreadyExists(server.name, file);
  const lineEnding = lineEndingOf(text);
  const body = text.replace(TRAILING_WHITESPACE, '');
  const separator = body ? lineEnding + lineEnding : '';
  const nextText = body + separator + codexServerTable(server).join(lineEnding) + lineEnding;
  return replaceWithBackup(file, nextText, backupRoot);
}

export async function addMcpServer(file: string, flavor: McpFlavor, server: NewMcpServer, backupRoot: string): Promise<string | undefined> {
  validateServer(server);
  if (flavor === 'codex') return addCodexServer(file, server, backupRoot);
  const config = await readJsonForEdit(file);
  const key = serversKey(flavor);
  const servers = { ...((config[key] as Record<string, unknown>) ?? {}) };
  if (Object.hasOwn(servers, server.name)) throw alreadyExists(server.name, file);
  servers[server.name] = mcpEntry(flavor, server);
  return replaceWithBackup(file, serializeJson({ ...config, [key]: servers }), backupRoot);
}

async function removeCodexServer(file: string, name: string, backupRoot: string): Promise<string | undefined> {
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const range = codexServerRange(lines, name);
  if (!range) throw notInFile(name, file);
  lines.splice(range.first, range.last - range.first + 1);
  const nextText = lines.join(lineEndingOf(text)).replace(THREE_OR_MORE_NEWLINES, '\n\n');
  return replaceWithBackup(file, nextText, backupRoot);
}

export async function removeMcpServer(file: string, flavor: McpFlavor, name: string, backupRoot: string): Promise<string | undefined> {
  if (flavor === 'codex') return removeCodexServer(file, name, backupRoot);
  const config = await readJsonForEdit(file);
  const key = serversKey(flavor);
  const servers = { ...((config[key] as Record<string, unknown>) ?? {}) };
  if (!Object.hasOwn(servers, name)) throw notInFile(name, file);
  delete servers[name];
  return replaceWithBackup(file, serializeJson({ ...config, [key]: servers }), backupRoot);
}

/** Codex only (`enabled = false` is documented there); other agents toggle servers in their own UI. */
export async function setCodexMcpEnabled(file: string, name: string, enabled: boolean, backupRoot: string): Promise<string | undefined> {
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const range = codexServerRange(lines, name);
  if (!range) throw notInFile(name, file);

  // `enabled` belongs to the server's own table, before any sub-table such as `.env`.
  let lastLineOfOwnTable = range.first;
  while (lastLineOfOwnTable + 1 <= range.last && !ANY_TABLE_HEADER.test(lines[lastLineOfOwnTable + 1])) lastLineOfOwnTable++;
  const firstKeyLine = range.first + 1;
  const ownTableLines = lines.slice(firstKeyLine, lastLineOfOwnTable + 1);
  const enabledOffset = ownTableLines.findIndex((line) => ENABLED_LINE.test(line));

  if (enabledOffset >= 0) {
    const enabledLine = firstKeyLine + enabledOffset;
    lines[enabledLine] = lines[enabledLine].replace(BOOLEAN_ASSIGNMENT, `$1${enabled}`);
  } else {
    lines.splice(firstKeyLine, 0, `enabled = ${enabled}`);
  }
  return replaceWithBackup(file, lines.join(lineEndingOf(text)), backupRoot);
}
