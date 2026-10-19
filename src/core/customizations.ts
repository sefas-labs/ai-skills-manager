import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseFrontmatter } from './frontmatter';
import { ancestorsUpTo, findRepoRoot, shouldWalkInto } from './monorepo';
import { pathKey } from './paths';
import type { McpFlavor } from './editing';
import type { ProviderId } from './types';

/**
 * Read-only inventory of what else each agent loads besides skills:
 * instruction files, rules, subagents, commands and MCP servers. Paths
 * verified 2026-10-19 against the official docs:
 *  - Claude Code: code.claude.com/docs/en/memory, /sub-agents, /mcp, /skills
 *  - Cursor: cursor.com/docs/context/rules, /context/mcp
 *  - Copilot (VS Code): code.visualstudio.com/docs/copilot/customization/custom-instructions,
 *    /customization/mcp-servers, /reference/mcp-configuration
 *  - Codex: learn.chatgpt.com/docs/agent-configuration/agents-md, /docs/extend/mcp
 * Also Copilot prompt files and custom agents, and CLAUDE.md / AGENTS.md
 * nested below the workspace folder. Not covered: Cursor user rules (stored in
 * its settings) and Cursor commands. Writes live in editing.ts.
 *
 * Secrets: MCP `env` / `headers` values are never read into the result, only
 * their names; arguments and URLs that look like credentials are masked.
 */
export type CustomizationKind = 'instructions' | 'rule' | 'agent' | 'command' | 'mcp';
export type CustomizationScope = 'project' | 'user' | 'local' | 'admin';

export interface McpServerInfo {
  name: string;
  transport: 'stdio' | 'http' | 'sse' | 'ws' | 'unknown';
  /** Command + arguments, with secret-looking arguments masked. */
  command?: string;
  /** URL without query string or user info. */
  url?: string;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
}

export interface CustomizationItem {
  kind: CustomizationKind;
  path: string;
  scope: CustomizationScope;
  agents: ProviderId[];
  /** Short label (file name or name from frontmatter). */
  title: string;
  description?: string;
  /** Extra context, e.g. "loaded instead of CLAUDE.md" or the MCP file's key. */
  note?: string;
  servers?: McpServerInfo[];
  /** MCP files we can edit: the entry format to write. */
  mcpFlavor?: McpFlavor;
  /** Why the extension won't write this file (shown instead of edit buttons). */
  readOnlyReason?: string;
}

export interface CustomizationInput {
  homeDir: string;
  workspaceFolders: string[];
  platform: NodeJS.Platform;
  /** VS Code profile `mcp.json` (User/mcp.json), when running in VS Code. */
  vscodeUserMcp?: string;
  /** VS Code profile folder (…/Code/User), when running in VS Code. */
  vscodeUserDir?: string;
  /** VS Code `chat.useNestedAgentsMdFiles` (experimental, off by default). */
  copilotNestedAgentsMd?: boolean;
  codexHome?: string;
}

export interface McpTarget {
  path: string;
  flavor: McpFlavor;
  scope: 'project' | 'user';
  agents: ProviderId[];
  label: string;
}

const CLAUDE_JSON_REASON = 'Claude Code rewrites ~/.claude.json itself — use `claude mcp add` / `claude mcp remove` in a terminal.';

const MANAGED_DIR: Record<string, string> = {
  darwin: '/Library/Application Support/ClaudeCode',
  linux: '/etc/claude-code',
  win32: 'C:\\Program Files\\ClaudeCode',
};

const FRONTMATTER_READ_BYTES = 64 * 1024;
const MAX_DESCRIPTION_LENGTH = 300;
const RULE_FOLDER_DEPTH = 4;
const NESTED_SEARCH_DEPTH = 6;
const NESTED_SEARCH_MAX_FOLDERS = 5000;

const CLAUDE_MD_VARIANTS = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'];
const CLAUDE_LOCAL_MD = 'CLAUDE.local.md';
const INSTRUCTION_FILE_NAME = /^(CLAUDE|CLAUDE\.local|AGENTS)\.md$/;
const AGENT_FILE_SUFFIX = /\.agent\.md$|\.md$/;

const endsWith = (suffix: string) => (fileName: string) => fileName.endsWith(suffix);
const isMarkdown = endsWith('.md');

/** True for a non-empty regular file (an empty instructions file loads nothing). */
const hasContent = (fullPath: string) => fs.stat(fullPath).then((stat) => stat.isFile() && stat.size > 0, () => false);

async function readHead(file: string, maxBytes = FRONTMATTER_READ_BYTES): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function listFiles(dir: string, matches: (fileName: string) => boolean, depth = RULE_FOLDER_DEPTH): Promise<string[]> {
  const files: string[] = [];
  const walk = async (currentDir: string, depthLeft: number) => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory() && depthLeft > 0) await walk(fullPath, depthLeft - 1);
      else if (entry.isFile() && matches(entry.name)) files.push(fullPath);
    }
  };
  await walk(dir, depth);
  return files.sort();
}

async function describeMarkdown(file: string): Promise<{ title?: string; description?: string }> {
  try {
    const frontmatter = parseFrontmatter(await readHead(file)).data;
    const name = frontmatter['name'];
    const description = frontmatter['description'];
    return {
      title: typeof name === 'string' ? name : undefined,
      description: typeof description === 'string' ? description.slice(0, MAX_DESCRIPTION_LENGTH) : undefined,
    };
  } catch {
    return {};
  }
}

// ---------- MCP ----------

/** Known token prefixes, long random-looking strings, and `name=value` secrets. */
const SECRET_ARGUMENT = /^(sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA|AIza|ya29\.)|^[A-Za-z0-9_\-]{32,}$|(token|secret|password|api[-_]?key)=/i;
/** Flags whose next argument is a secret (`--token abc`). */
const SECRET_FLAG = /^--?(token|secret|password|api[-_]?key|key|auth)$/i;
/** `scheme://user:password@host`: captures everything up to the password. */
const CONNECTION_STRING_PASSWORD = /(\w[\w+.-]*:\/\/[^/\s:@]*:)[^@\s]+@/g;
const MASK = '•••';

export function maskArgs(args: unknown[]): string[] {
  return args.map((rawArgument, index) => {
    const argument = String(rawArgument);
    const followsSecretFlag = index > 0 && SECRET_FLAG.test(String(args[index - 1]));
    if (followsSecretFlag || SECRET_ARGUMENT.test(argument)) return MASK;
    return argument.replace(CONNECTION_STRING_PASSWORD, `$1${MASK}@`);
  });
}

export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hiddenQuery = url.search ? '?…' : '';
    return `${url.protocol}//${url.host}${url.pathname}${hiddenQuery}`;
  } catch {
    return '(invalid URL)';
  }
}

function objectKeys(value: unknown): string[] {
  const isObject = value && typeof value === 'object' && !Array.isArray(value);
  return isObject ? Object.keys(value as object).sort() : [];
}

function transportOf(type: string | undefined, hasCommand: boolean, hasUrl: boolean): McpServerInfo['transport'] {
  if (type === 'stdio' || (!type && hasCommand)) return 'stdio';
  if (type === 'http' || type === 'streamable-http' || (!type && hasUrl)) return 'http';
  if (type === 'sse' || type === 'ws') return type;
  return 'unknown';
}

function serverFromJson(name: string, entry: Record<string, unknown>): McpServerInfo {
  const stringOf = (key: string) => (typeof entry[key] === 'string' ? (entry[key] as string) : undefined);
  const command = stringOf('command');
  const url = stringOf('url');
  const args = Array.isArray(entry['args']) ? entry['args'] : [];
  return {
    name,
    transport: transportOf(stringOf('type'), !!command, !!url),
    command: command ? [command, ...maskArgs(args)].join(' ') : undefined,
    url: url ? safeUrl(url) : undefined,
    envKeys: objectKeys(entry['env']),
    headerKeys: objectKeys(entry['headers']),
    enabled: entry['disabled'] !== true && entry['enabled'] !== false,
  };
}

async function jsonServers(file: string, key: 'mcpServers' | 'servers', pickServers?: (root: Record<string, unknown>) => unknown): Promise<McpServerInfo[] | undefined> {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
  const servers = pickServers ? pickServers(root) : root?.[key];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return undefined;
  return Object.entries(servers as Record<string, unknown>)
    .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(([name, entry]) => serverFromJson(name, entry as Record<string, unknown>))
    .sort((first, second) => first.name.localeCompare(second.name));
}

const CODEX_SERVER_HEADER = /^\s*\[\s*mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)(?:\.(env|http_headers))?\s*\]\s*(#.*)?$/;
const ANY_TABLE_HEADER = /^\s*\[/;
const TOML_KEY_VALUE = /^\s*([A-Za-z0-9_"-]+)\s*=\s*(.*)$/;
const TOML_TRAILING_COMMENT = /\s+#.*$/;
const TOML_SINGLE_QUOTED = /^'([^']*)'/;
const TOML_STRING_IN_ARRAY = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
const INLINE_TABLE_KEY = /([A-Za-z0-9_]+)\s*=/g;
const INLINE_TABLE_QUOTED_KEY = /"?([A-Za-z0-9_-]+)"?\s*=/g;

function readTomlString(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value.replace(TOML_TRAILING_COMMENT, '')) as string;
    } catch {
      return undefined;
    }
  }
  return TOML_SINGLE_QUOTED.exec(value)?.[1];
}

function readTomlStringArray(rawValue: string): string[] {
  return [...rawValue.matchAll(TOML_STRING_IN_ARRAY)].map(([, doubleQuoted, singleQuoted]) =>
    doubleQuoted !== undefined ? (JSON.parse(`"${doubleQuoted}"`) as string) : singleQuoted,
  );
}

interface CodexServerDraft {
  command?: string;
  args: string[];
  url?: string;
  envKeys: Set<string>;
  headerKeys: Set<string>;
  enabled: boolean;
}

/** Minimal reader for `[mcp_servers.<name>]` tables in Codex's config.toml (values we show only). */
export function codexMcpServers(toml: string): McpServerInfo[] {
  const drafts = new Map<string, CodexServerDraft>();
  let currentServer: string | undefined;
  let currentSubTable: 'env' | 'http_headers' | undefined;
  const lines = toml.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const header = CODEX_SERVER_HEADER.exec(line);
    if (header) {
      currentServer = header[1].replace(/^"|"$/g, '');
      currentSubTable = header[2] as typeof currentSubTable;
      if (!drafts.has(currentServer)) drafts.set(currentServer, { args: [], envKeys: new Set(), headerKeys: new Set(), enabled: true });
      continue;
    }
    if (ANY_TABLE_HEADER.test(line)) {
      currentServer = undefined;
      continue;
    }
    if (!currentServer) continue;
    const draft = drafts.get(currentServer)!;
    const keyValue = TOML_KEY_VALUE.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1].replace(/"/g, '');
    let value = keyValue[2];

    if (currentSubTable === 'env') {
      draft.envKeys.add(key);
      continue;
    }
    if (currentSubTable === 'http_headers') {
      draft.headerKeys.add(key);
      continue;
    }
    const startsMultiLineArray = value.trim().startsWith('[') && !value.includes(']');
    if (startsMultiLineArray) {
      while (lineIndex + 1 < lines.length && !lines[lineIndex].includes(']')) value += ' ' + lines[++lineIndex];
    }
    const isInlineTable = value.trim().startsWith('{');
    switch (key) {
      case 'command':
        draft.command = readTomlString(value);
        break;
      case 'url':
        draft.url = readTomlString(value);
        break;
      case 'enabled':
        draft.enabled = !/^\s*false/.test(value);
        break;
      case 'args':
        draft.args = readTomlStringArray(value);
        break;
      case 'env':
        if (isInlineTable) for (const [, envKey] of value.matchAll(INLINE_TABLE_KEY)) draft.envKeys.add(envKey);
        break;
      case 'http_headers':
        if (isInlineTable) for (const [, headerKey] of value.matchAll(INLINE_TABLE_QUOTED_KEY)) draft.headerKeys.add(headerKey);
        break;
      case 'bearer_token_env_var':
        draft.headerKeys.add('Authorization');
        break;
    }
  }

  return [...drafts.entries()]
    .map(([name, draft]) => ({
      name,
      transport: draft.url ? ('http' as const) : draft.command ? ('stdio' as const) : ('unknown' as const),
      command: draft.command ? [draft.command, ...maskArgs(draft.args)].join(' ') : undefined,
      url: draft.url ? safeUrl(draft.url) : undefined,
      envKeys: [...draft.envKeys].sort(),
      headerKeys: [...draft.headerKeys].sort(),
      enabled: draft.enabled,
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

/** Sub-folders (not the workspace folder itself) holding CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md or AGENTS.md. Bounded walk. */
export async function findNestedInstructionDirs(root: string, maxDepth = NESTED_SEARCH_DEPTH, maxDirs = NESTED_SEARCH_MAX_FOLDERS): Promise<string[]> {
  const found: string[] = [];
  let foldersLeft = maxDirs;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || foldersLeft-- <= 0) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const isWorkspaceRoot = depth === 0;
    if (!isWorkspaceRoot) {
      const hasInstructionFile = entries.some((entry) => entry.isFile() && INSTRUCTION_FILE_NAME.test(entry.name));
      const hasClaudeFolder = entries.some((entry) => entry.isDirectory() && entry.name === '.claude');
      if (hasInstructionFile || (hasClaudeFolder && (await hasContent(path.join(dir, '.claude', 'CLAUDE.md'))))) found.push(dir);
    }
    for (const entry of entries) {
      if (shouldWalkInto(entry)) await walk(path.join(dir, entry.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found.sort();
}

// ---------- inventory ----------

type NewItem = Omit<CustomizationItem, 'title'> & { title?: string };

class Inventory {
  readonly items: CustomizationItem[] = [];

  /** Adds an item; with `readFrontmatter`, its title and description come from the file's frontmatter. */
  async add(item: NewItem, readFrontmatter = false): Promise<void> {
    const described = readFrontmatter ? await describeMarkdown(item.path) : {};
    this.items.push({ ...item, title: item.title ?? described.title ?? path.basename(item.path), description: item.description ?? described.description });
  }

  async addEach(files: string[], item: (file: string) => NewItem): Promise<void> {
    for (const file of files) await this.add(item(file), true);
  }
}

function claudeMdScope(fileName: string): CustomizationScope {
  return fileName === CLAUDE_LOCAL_MD ? 'local' : 'project';
}

function claudeMdReaders(fileName: string): ProviderId[] {
  return fileName === CLAUDE_LOCAL_MD ? ['claude-code'] : ['claude-code', 'copilot'];
}

function agentFileTitle(file: string): string {
  return path.basename(file).replace(AGENT_FILE_SUFFIX, '');
}

function commandTitle(file: string, extension: string): string {
  return '/' + path.basename(file, extension);
}

async function addUserInstructions(inventory: Inventory, input: CustomizationInput, codexHome: string): Promise<void> {
  const home = input.homeDir;
  const managedClaudeMd = path.join(MANAGED_DIR[input.platform] ?? MANAGED_DIR.linux, 'CLAUDE.md');
  if (await hasContent(managedClaudeMd)) await inventory.add({ kind: 'instructions', path: managedClaudeMd, scope: 'admin', agents: ['claude-code'], note: 'Organization policy' });
  const userClaudeMd = path.join(home, '.claude', 'CLAUDE.md');
  if (await hasContent(userClaudeMd)) await inventory.add({ kind: 'instructions', path: userClaudeMd, scope: 'user', agents: ['claude-code', 'copilot'] });
  const copilotInstructions = path.join(home, '.copilot', 'copilot-instructions.md');
  if (await hasContent(copilotInstructions)) await inventory.add({ kind: 'instructions', path: copilotInstructions, scope: 'user', agents: ['copilot'] });
  // Codex uses only the first non-empty file at this level.
  for (const fileName of ['AGENTS.override.md', 'AGENTS.md']) {
    const file = path.join(codexHome, fileName);
    if (!(await hasContent(file))) continue;
    const note = fileName === 'AGENTS.override.md' ? 'Overrides ~/.codex/AGENTS.md' : undefined;
    await inventory.add({ kind: 'instructions', path: file, scope: 'user', agents: ['codex'], note });
    break;
  }
}

/** From the repo root down to the workspace folder: Claude Code loads every level, Codex one file per level. */
async function addProjectInstructions(inventory: Inventory, workspace: string, levels: string[], repoRoot: string): Promise<void> {
  let hasClaudeMd = false;
  for (const dir of levels) {
    for (const fileName of CLAUDE_MD_VARIANTS) {
      const file = path.join(dir, fileName);
      if (!(await hasContent(file))) continue;
      hasClaudeMd = true;
      await inventory.add({ kind: 'instructions', path: file, scope: claudeMdScope(fileName), agents: claudeMdReaders(fileName) });
    }
  }
  for (const dir of levels) {
    const overrideFile = path.join(dir, 'AGENTS.override.md');
    const agentsFile = path.join(dir, 'AGENTS.md');
    const hasOverride = await hasContent(overrideFile);
    if (hasOverride) await inventory.add({ kind: 'instructions', path: overrideFile, scope: 'project', agents: ['codex'], note: 'Codex reads it instead of AGENTS.md here' });
    if (!(await hasContent(agentsFile))) continue;
    const isWorkspaceOrRepoRoot = dir === workspace || dir === repoRoot;
    const readers: ProviderId[] = [...(hasOverride ? [] : ['codex']), 'cursor', ...(isWorkspaceOrRepoRoot ? ['copilot'] : [])];
    // Claude Code reads AGENTS.md only when there is no CLAUDE.md.
    if (!hasClaudeMd) readers.unshift('claude-code');
    await inventory.add({ kind: 'instructions', path: agentsFile, scope: 'project', agents: readers, note: hasClaudeMd ? 'Claude Code reads CLAUDE.md instead (default)' : undefined });
  }
  const copilotInstructions = path.join(workspace, '.github', 'copilot-instructions.md');
  if (await hasContent(copilotInstructions)) await inventory.add({ kind: 'instructions', path: copilotInstructions, scope: 'project', agents: ['copilot'] });
}

async function addProjectRulesAgentsAndCommands(inventory: Inventory, workspace: string, levels: string[]): Promise<void> {
  const project = (kind: CustomizationKind, agents: ProviderId[], extra: Partial<NewItem> = {}) => (file: string): NewItem => ({ kind, path: file, scope: 'project', agents, ...extra });

  await inventory.addEach(await listFiles(path.join(workspace, '.claude', 'rules'), isMarkdown), project('rule', ['claude-code', 'copilot']));
  await inventory.addEach(await listFiles(path.join(workspace, '.cursor', 'rules'), endsWith('.mdc')), project('rule', ['cursor']));
  await inventory.addEach(await listFiles(path.join(workspace, '.github', 'instructions'), endsWith('.instructions.md')), project('rule', ['copilot']));

  // Claude-format subagents are also read by VS Code / Copilot (custom-agents docs), but only from the workspace folder.
  for (const dir of levels) {
    const readers: ProviderId[] = dir === workspace ? ['claude-code', 'copilot'] : ['claude-code'];
    await inventory.addEach(await listFiles(path.join(dir, '.claude', 'agents'), isMarkdown), project('agent', readers));
  }
  for (const file of await listFiles(path.join(workspace, '.github', 'agents'), isMarkdown)) {
    await inventory.add(project('agent', ['copilot'], { title: agentFileTitle(file) })(file), true);
  }
  for (const file of await listFiles(path.join(workspace, '.claude', 'commands'), isMarkdown)) {
    await inventory.add(project('command', ['claude-code'], { title: commandTitle(file, '.md') })(file), true);
  }
  for (const file of await listFiles(path.join(workspace, '.github', 'prompts'), endsWith('.prompt.md'))) {
    await inventory.add(project('command', ['copilot'], { title: commandTitle(file, '.prompt.md'), note: 'Prompt file' })(file), true);
  }
}

/** Instruction files below the workspace folder: loaded when the agent works in that sub-folder. */
async function addNestedInstructions(inventory: Inventory, workspace: string, copilotReadsNestedAgentsMd: boolean): Promise<void> {
  for (const subfolder of await findNestedInstructionDirs(workspace)) {
    const relativeFolder = path.relative(workspace, subfolder).split(path.sep).join('/');
    for (const fileName of CLAUDE_MD_VARIANTS) {
      const file = path.join(subfolder, fileName);
      if (!(await hasContent(file))) continue;
      await inventory.add({ kind: 'instructions', path: file, scope: claudeMdScope(fileName), agents: ['claude-code'], note: `Nested: Claude Code loads it when it works in ${relativeFolder}/` });
    }
    const agentsFile = path.join(subfolder, 'AGENTS.md');
    if (!(await hasContent(agentsFile))) continue;
    const readers: ProviderId[] = copilotReadsNestedAgentsMd ? ['cursor', 'copilot'] : ['cursor'];
    const copilotNote = copilotReadsNestedAgentsMd ? '' : ' (Copilot only with chat.useNestedAgentsMdFiles)';
    await inventory.add({ kind: 'instructions', path: agentsFile, scope: 'project', agents: readers, note: `Nested: Cursor combines it for files in ${relativeFolder}/${copilotNote}` });
  }
}

async function addUserRulesAgentsAndCommands(inventory: Inventory, input: CustomizationInput): Promise<void> {
  const home = input.homeDir;
  const user = (kind: CustomizationKind, agents: ProviderId[], extra: Partial<NewItem> = {}) => (file: string): NewItem => ({ kind, path: file, scope: 'user', agents, ...extra });

  await inventory.addEach(await listFiles(path.join(home, '.claude', 'rules'), isMarkdown), user('rule', ['claude-code', 'copilot']));
  await inventory.addEach(await listFiles(path.join(home, '.copilot', 'instructions'), isMarkdown), user('rule', ['copilot']));
  await inventory.addEach(await listFiles(path.join(home, '.claude', 'agents'), isMarkdown), user('agent', ['claude-code', 'copilot']));
  for (const file of await listFiles(path.join(home, '.copilot', 'agents'), isMarkdown)) {
    await inventory.add(user('agent', ['copilot'], { title: agentFileTitle(file) })(file), true);
  }
  if (input.vscodeUserDir) {
    // ⚠️ The profile's prompt folder (User/prompts) is where "Chat: New Prompt File" saves user prompts; not documented as a path.
    for (const file of await listFiles(path.join(input.vscodeUserDir, 'prompts'), endsWith('.prompt.md'))) {
      await inventory.add(user('command', ['copilot'], { title: commandTitle(file, '.prompt.md'), note: 'Prompt file (VS Code profile)' })(file), true);
    }
  }
  for (const file of await listFiles(path.join(home, '.claude', 'commands'), isMarkdown)) {
    await inventory.add(user('command', ['claude-code'], { title: commandTitle(file, '.md') })(file), true);
  }
}

async function readCodexServers(file: string): Promise<McpServerInfo[] | undefined> {
  const toml = await fs.readFile(file, 'utf8').catch(() => undefined);
  return toml ? codexMcpServers(toml) : undefined;
}

function copilotCliMcpFile(home: string): string {
  return path.join(process.env.COPILOT_HOME || path.join(home, '.copilot'), 'mcp-config.json');
}

async function addMcpServers(inventory: Inventory, input: CustomizationInput, codexHome: string): Promise<void> {
  const home = input.homeDir;
  const workspace = input.workspaceFolders[0];
  const addFile = (file: string, scope: CustomizationScope, agents: ProviderId[], servers: McpServerInfo[] | undefined, note?: string, mcpFlavor?: McpFlavor) => {
    if (!servers?.length) return;
    const readOnlyReason = mcpFlavor ? undefined : CLAUDE_JSON_REASON;
    inventory.items.push({ kind: 'mcp', path: file, scope, agents, title: path.basename(file), servers, note, mcpFlavor, readOnlyReason });
  };

  const claudeJson = path.join(home, '.claude.json');
  addFile(claudeJson, 'user', ['claude-code'], await jsonServers(claudeJson, 'mcpServers'), 'User scope (top-level mcpServers)');
  if (workspace) {
    const thisProjectServers = (root: Record<string, unknown>) => {
      const projects = root['projects'] as Record<string, { mcpServers?: unknown }> | undefined;
      const entry = projects && Object.entries(projects).find(([projectPath]) => pathKey(projectPath, input.platform) === pathKey(workspace, input.platform));
      return entry?.[1]?.mcpServers;
    };
    addFile(claudeJson, 'local', ['claude-code'], await jsonServers(claudeJson, 'mcpServers', thisProjectServers), 'Local scope (this project, in ~/.claude.json)');
    const projectMcp = path.join(workspace, '.mcp.json');
    const cursorMcp = path.join(workspace, '.cursor', 'mcp.json');
    const vscodeMcp = path.join(workspace, '.vscode', 'mcp.json');
    const codexProject = path.join(workspace, '.codex', 'config.toml');
    addFile(projectMcp, 'project', ['claude-code', 'copilot'], await jsonServers(projectMcp, 'mcpServers'), undefined, 'claude');
    addFile(cursorMcp, 'project', ['cursor'], await jsonServers(cursorMcp, 'mcpServers'), undefined, 'cursor');
    addFile(vscodeMcp, 'project', ['copilot'], await jsonServers(vscodeMcp, 'servers'), undefined, 'vscode');
    addFile(codexProject, 'project', ['codex'], await readCodexServers(codexProject), 'Only for trusted projects', 'codex');
  }
  const cursorUserMcp = path.join(home, '.cursor', 'mcp.json');
  addFile(cursorUserMcp, 'user', ['cursor'], await jsonServers(cursorUserMcp, 'mcpServers'), undefined, 'cursor');
  if (input.vscodeUserMcp) addFile(input.vscodeUserMcp, 'user', ['copilot'], await jsonServers(input.vscodeUserMcp, 'servers'), 'VS Code profile', 'vscode');
  const copilotCli = copilotCliMcpFile(home);
  addFile(copilotCli, 'user', ['copilot'], await jsonServers(copilotCli, 'mcpServers'), 'Copilot CLI', 'copilot-cli');
  const codexUser = path.join(codexHome, 'config.toml');
  addFile(codexUser, 'user', ['codex'], await readCodexServers(codexUser), undefined, 'codex');
}

export async function readCustomizations(input: CustomizationInput): Promise<CustomizationItem[]> {
  const inventory = new Inventory();
  const workspace = input.workspaceFolders[0];
  const codexHome = input.codexHome || path.join(input.homeDir, '.codex');

  await addUserInstructions(inventory, input, codexHome);
  if (workspace) {
    const repoRoot = (await findRepoRoot(workspace)) ?? workspace;
    const levelsFromRepoRoot = [...ancestorsUpTo(workspace, repoRoot).reverse(), workspace];
    await addProjectInstructions(inventory, workspace, levelsFromRepoRoot, repoRoot);
    await addProjectRulesAgentsAndCommands(inventory, workspace, levelsFromRepoRoot);
    await addNestedInstructions(inventory, workspace, !!input.copilotNestedAgentsMd);
  }
  await addUserRulesAgentsAndCommands(inventory, input);
  await addMcpServers(inventory, input, codexHome);
  return inventory.items;
}

/** Files a new MCP server can be written to (they may not exist yet). Claude Code's user/local scopes live in ~/.claude.json: not offered. */
export function mcpTargets(input: CustomizationInput): McpTarget[] {
  const workspace = input.workspaceFolders[0];
  const home = input.homeDir;
  const codexHome = input.codexHome || path.join(home, '.codex');
  const targets: McpTarget[] = [];
  if (workspace) {
    targets.push(
      { path: path.join(workspace, '.mcp.json'), flavor: 'claude', scope: 'project', agents: ['claude-code', 'copilot'], label: 'Claude Code (project, shared)' },
      { path: path.join(workspace, '.cursor', 'mcp.json'), flavor: 'cursor', scope: 'project', agents: ['cursor'], label: 'Cursor (project)' },
      { path: path.join(workspace, '.vscode', 'mcp.json'), flavor: 'vscode', scope: 'project', agents: ['copilot'], label: 'VS Code / Copilot (project)' },
      { path: path.join(workspace, '.codex', 'config.toml'), flavor: 'codex', scope: 'project', agents: ['codex'], label: 'Codex (project, trusted projects only)' },
    );
  }
  targets.push({ path: path.join(home, '.cursor', 'mcp.json'), flavor: 'cursor', scope: 'user', agents: ['cursor'], label: 'Cursor (user)' });
  if (input.vscodeUserMcp) targets.push({ path: input.vscodeUserMcp, flavor: 'vscode', scope: 'user', agents: ['copilot'], label: 'VS Code / Copilot (user profile)' });
  targets.push(
    { path: copilotCliMcpFile(home), flavor: 'copilot-cli', scope: 'user', agents: ['copilot'], label: 'Copilot CLI (user)' },
    { path: path.join(codexHome, 'config.toml'), flavor: 'codex', scope: 'user', agents: ['codex'], label: 'Codex (user)' },
  );
  return targets;
}

/** MCP server names configured more than once for the same agent (which one wins depends on the agent). */
export function mcpDuplicates(items: CustomizationItem[]): Array<{ agent: ProviderId; name: string; files: string[] }> {
  const filesByAgentAndServer = new Map<string, Set<string>>();
  const keySeparator = '\u0000';
  for (const item of items.filter((candidate) => candidate.kind === 'mcp')) {
    // ~/.claude.json holds both user and local scopes: tell them apart.
    const fileKey = item.path + (item.note?.startsWith('Local') ? '#local' : '');
    for (const server of item.servers ?? []) {
      for (const agent of item.agents) {
        const key = `${agent}${keySeparator}${server.name}`;
        filesByAgentAndServer.set(key, (filesByAgentAndServer.get(key) ?? new Set()).add(fileKey));
      }
    }
  }
  return [...filesByAgentAndServer.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([key, files]) => {
      const [agent, name] = key.split(keySeparator);
      return { agent, name, files: [...files] };
    });
}
