import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseFrontmatter } from './frontmatter';
import { ancestorsUpTo, findRepoRoot } from './monorepo';
import { pathKey } from './paths';
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
 * Not covered (❓ in the docs or no file): Cursor user rules (stored in settings),
 * Cursor/Copilot custom commands, prompt files and custom agents, nested
 * CLAUDE.md/AGENTS.md below the workspace folder.
 *
 * Secrets: MCP `env` / `headers` values are never read into the result, only
 * their names; arguments and URLs that look like credentials are masked.
 */
export type CustomizationKind = 'instructions' | 'rule' | 'agent' | 'command' | 'mcp';

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
  scope: 'project' | 'user' | 'local' | 'admin';
  agents: ProviderId[];
  /** Short label (file name or name from frontmatter). */
  title: string;
  description?: string;
  /** Extra context, e.g. "loaded instead of CLAUDE.md" or the MCP file's key. */
  note?: string;
  servers?: McpServerInfo[];
}

export interface CustomizationInput {
  homeDir: string;
  workspaceFolders: string[];
  platform: NodeJS.Platform;
  /** VS Code profile `mcp.json` (User/mcp.json), when running in VS Code. */
  vscodeUserMcp?: string;
  codexHome?: string;
}

const MANAGED_DIR: Record<string, string> = {
  darwin: '/Library/Application Support/ClaudeCode',
  linux: '/etc/claude-code',
  win32: 'C:\\Program Files\\ClaudeCode',
};

const exists = (p: string) => fs.stat(p).then((s) => s.isFile() && s.size > 0, () => false);

async function readHead(file: string, max = 64 * 1024): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function listFiles(dir: string, match: (name: string) => boolean, depth = 4): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, left: number) => {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) await walk(p, left - 1);
      else if (e.isFile() && match(e.name)) out.push(p);
    }
  };
  await walk(dir, depth);
  return out.sort();
}

async function describeMd(file: string): Promise<{ title?: string; description?: string }> {
  try {
    const fm = parseFrontmatter(await readHead(file)).data;
    return {
      title: typeof fm['name'] === 'string' ? (fm['name'] as string) : undefined,
      description: typeof fm['description'] === 'string' ? (fm['description'] as string).slice(0, 300) : undefined,
    };
  } catch {
    return {};
  }
}

// ---------- MCP ----------

const SECRET_ARG = /^(sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA|AIza|ya29\.)|^[A-Za-z0-9_\-]{32,}$|(token|secret|password|api[-_]?key)=/i;
const SECRET_FLAG = /^--?(token|secret|password|api[-_]?key|key|auth)$/i;

export function maskArgs(args: unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const prevFlag = i > 0 && SECRET_FLAG.test(String(args[i - 1]));
    // Connection strings carry passwords in the user info: scheme://user:password@host
    const masked = a.replace(/(\w[\w+.-]*:\/\/[^/\s:@]*:)[^@\s]+@/g, '$1•••@');
    out.push(prevFlag || SECRET_ARG.test(a) ? '•••' : masked);
  }
  return out;
}

export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '(invalid URL)';
  }
}

function serverFromJson(name: string, v: Record<string, unknown>): McpServerInfo {
  const type = typeof v['type'] === 'string' ? (v['type'] as string) : undefined;
  const url = typeof v['url'] === 'string' ? (v['url'] as string) : undefined;
  const command = typeof v['command'] === 'string' ? (v['command'] as string) : undefined;
  const args = Array.isArray(v['args']) ? v['args'] : [];
  const transport: McpServerInfo['transport'] =
    type === 'stdio' || (!type && command) ? 'stdio' : type === 'http' || type === 'streamable-http' || (!type && url) ? 'http' : type === 'sse' ? 'sse' : type === 'ws' ? 'ws' : 'unknown';
  const keys = (o: unknown) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o as object).sort() : []);
  return {
    name,
    transport,
    command: command ? [command, ...maskArgs(args)].join(' ') : undefined,
    url: url ? safeUrl(url) : undefined,
    envKeys: keys(v['env']),
    headerKeys: keys(v['headers']),
    enabled: v['disabled'] !== true && v['enabled'] !== false,
  };
}

async function jsonServers(file: string, key: 'mcpServers' | 'servers', pick?: (root: Record<string, unknown>) => unknown): Promise<McpServerInfo[] | undefined> {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
  const node = pick ? pick(root) : root?.[key];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  return Object.entries(node as Record<string, unknown>)
    .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
    .map(([n, v]) => serverFromJson(n, v as Record<string, unknown>))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Minimal reader for `[mcp_servers.<name>]` tables in Codex's config.toml (values we show only). */
export function codexMcpServers(toml: string): McpServerInfo[] {
  const servers = new Map<string, { command?: string; args: string[]; url?: string; env: Set<string>; headers: Set<string>; enabled: boolean }>();
  let cur: string | undefined;
  let sub: 'env' | 'http_headers' | undefined;
  const str = (v: string) => {
    const t = v.trim();
    if (t.startsWith('"')) {
      try {
        return JSON.parse(t.replace(/\s+#.*$/, '')) as string;
      } catch {
        return undefined;
      }
    }
    return /^'([^']*)'/.exec(t)?.[1];
  };
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = /^\s*\[\s*mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)(?:\.(env|http_headers))?\s*\]\s*(#.*)?$/.exec(line);
    if (header) {
      cur = header[1].replace(/^"|"$/g, '');
      sub = header[2] as typeof sub;
      if (!servers.has(cur)) servers.set(cur, { args: [], env: new Set(), headers: new Set(), enabled: true });
      continue;
    }
    if (/^\s*\[/.test(line)) {
      cur = undefined;
      continue;
    }
    if (!cur) continue;
    const s = servers.get(cur)!;
    const kv = /^\s*([A-Za-z0-9_"-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    let value = kv[2];
    if (sub === 'env') {
      s.env.add(key);
      continue;
    }
    if (sub === 'http_headers') {
      s.headers.add(key);
      continue;
    }
    if (value.trim().startsWith('[') && !value.includes(']')) {
      while (i + 1 < lines.length && !lines[i].includes(']')) value += ' ' + lines[++i];
    }
    if (key === 'command') s.command = str(value);
    else if (key === 'url') s.url = str(value);
    else if (key === 'enabled') s.enabled = !/^\s*false/.test(value);
    else if (key === 'args') s.args = [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]));
    else if (key === 'env' && value.trim().startsWith('{')) for (const m of value.matchAll(/([A-Za-z0-9_]+)\s*=/g)) s.env.add(m[1]);
    else if (key === 'http_headers' && value.trim().startsWith('{')) for (const m of value.matchAll(/"?([A-Za-z0-9_-]+)"?\s*=/g)) s.headers.add(m[1]);
    else if (key === 'bearer_token_env_var') s.headers.add('Authorization');
  }
  return [...servers.entries()]
    .map(([name, s]) => ({
      name,
      transport: s.url ? ('http' as const) : s.command ? ('stdio' as const) : ('unknown' as const),
      command: s.command ? [s.command, ...maskArgs(s.args)].join(' ') : undefined,
      url: s.url ? safeUrl(s.url) : undefined,
      envKeys: [...s.env].sort(),
      headerKeys: [...s.headers].sort(),
      enabled: s.enabled,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- inventory ----------

export async function readCustomizations(input: CustomizationInput): Promise<CustomizationItem[]> {
  const out: CustomizationItem[] = [];
  const home = input.homeDir;
  const ws = input.workspaceFolders[0];
  const codexHome = input.codexHome || path.join(home, '.codex');
  const push = async (item: Omit<CustomizationItem, 'title'> & { title?: string }, md = false) => {
    const d = md ? await describeMd(item.path) : {};
    out.push({ ...item, title: item.title ?? d.title ?? path.basename(item.path), description: item.description ?? d.description });
  };

  // --- Instruction files ---
  const managedClaude = path.join(MANAGED_DIR[input.platform] ?? MANAGED_DIR.linux, 'CLAUDE.md');
  if (await exists(managedClaude)) await push({ kind: 'instructions', path: managedClaude, scope: 'admin', agents: ['claude-code'], note: 'Organization policy' });
  if (await exists(path.join(home, '.claude', 'CLAUDE.md'))) await push({ kind: 'instructions', path: path.join(home, '.claude', 'CLAUDE.md'), scope: 'user', agents: ['claude-code', 'copilot'] });
  for (const f of ['copilot-instructions.md']) {
    const p = path.join(home, '.copilot', f);
    if (await exists(p)) await push({ kind: 'instructions', path: p, scope: 'user', agents: ['copilot'] });
  }
  for (const f of ['AGENTS.override.md', 'AGENTS.md']) {
    const p = path.join(codexHome, f);
    if (await exists(p)) {
      await push({ kind: 'instructions', path: p, scope: 'user', agents: ['codex'], note: f === 'AGENTS.override.md' ? 'Overrides ~/.codex/AGENTS.md' : undefined });
      break; // Codex uses only the first non-empty file at this level.
    }
  }
  if (ws) {
    const root = (await findRepoRoot(ws)) ?? ws;
    // From the repo root down to the workspace folder (Claude Code loads every level; Codex one file per level).
    const dirs = [...ancestorsUpTo(ws, root).reverse(), ws];
    let hasClaudeMd = false;
    for (const d of dirs) {
      for (const f of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
        const p = path.join(d, f);
        if (await exists(p)) {
          hasClaudeMd = true;
          await push({ kind: 'instructions', path: p, scope: f === 'CLAUDE.local.md' ? 'local' : 'project', agents: f === 'CLAUDE.local.md' ? ['claude-code'] : ['claude-code', 'copilot'] });
        }
      }
    }
    for (const d of dirs) {
      const override = path.join(d, 'AGENTS.override.md');
      const agents = path.join(d, 'AGENTS.md');
      if (await exists(override)) await push({ kind: 'instructions', path: override, scope: 'project', agents: ['codex'], note: 'Codex reads it instead of AGENTS.md here' });
      if (await exists(agents)) {
        const readers: ProviderId[] = [...(await exists(override) ? [] : (['codex'] as ProviderId[])), 'cursor', ...(d === ws || d === root ? (['copilot'] as ProviderId[]) : [])];
        if (!hasClaudeMd) readers.unshift('claude-code');
        await push({ kind: 'instructions', path: agents, scope: 'project', agents: readers, note: hasClaudeMd ? 'Claude Code reads CLAUDE.md instead (default)' : undefined });
      }
    }
    const gh = path.join(ws, '.github', 'copilot-instructions.md');
    if (await exists(gh)) await push({ kind: 'instructions', path: gh, scope: 'project', agents: ['copilot'] });

    // --- Rules ---
    for (const p of await listFiles(path.join(ws, '.claude', 'rules'), (n) => n.endsWith('.md'))) await push({ kind: 'rule', path: p, scope: 'project', agents: ['claude-code', 'copilot'] }, true);
    for (const p of await listFiles(path.join(ws, '.cursor', 'rules'), (n) => n.endsWith('.mdc'))) await push({ kind: 'rule', path: p, scope: 'project', agents: ['cursor'] }, true);
    for (const p of await listFiles(path.join(ws, '.github', 'instructions'), (n) => n.endsWith('.instructions.md'))) await push({ kind: 'rule', path: p, scope: 'project', agents: ['copilot'] }, true);
    // --- Subagents and commands ---
    for (const d of dirs) for (const p of await listFiles(path.join(d, '.claude', 'agents'), (n) => n.endsWith('.md'))) await push({ kind: 'agent', path: p, scope: 'project', agents: ['claude-code'] }, true);
    for (const p of await listFiles(path.join(ws, '.claude', 'commands'), (n) => n.endsWith('.md'))) await push({ kind: 'command', path: p, scope: 'project', agents: ['claude-code'], title: '/' + path.basename(p, '.md') }, true);
  }
  for (const p of await listFiles(path.join(home, '.claude', 'rules'), (n) => n.endsWith('.md'))) await push({ kind: 'rule', path: p, scope: 'user', agents: ['claude-code', 'copilot'] }, true);
  for (const p of await listFiles(path.join(home, '.copilot', 'instructions'), (n) => n.endsWith('.md'))) await push({ kind: 'rule', path: p, scope: 'user', agents: ['copilot'] }, true);
  for (const p of await listFiles(path.join(home, '.claude', 'agents'), (n) => n.endsWith('.md'))) await push({ kind: 'agent', path: p, scope: 'user', agents: ['claude-code'] }, true);
  for (const p of await listFiles(path.join(home, '.claude', 'commands'), (n) => n.endsWith('.md'))) await push({ kind: 'command', path: p, scope: 'user', agents: ['claude-code'], title: '/' + path.basename(p, '.md') }, true);

  // --- MCP servers ---
  const mcp = async (file: string, scope: CustomizationItem['scope'], agents: ProviderId[], servers: McpServerInfo[] | undefined, note?: string) => {
    if (servers?.length) out.push({ kind: 'mcp', path: file, scope, agents, title: path.basename(file), servers, note });
  };
  const claudeJson = path.join(home, '.claude.json');
  await mcp(claudeJson, 'user', ['claude-code'], await jsonServers(claudeJson, 'mcpServers'), 'User scope (top-level mcpServers)');
  if (ws) {
    await mcp(
      claudeJson,
      'local',
      ['claude-code'],
      await jsonServers(claudeJson, 'mcpServers', (root) => {
        const projects = root['projects'] as Record<string, { mcpServers?: unknown }> | undefined;
        const hit = projects && Object.entries(projects).find(([p]) => pathKey(p, input.platform) === pathKey(ws, input.platform));
        return hit?.[1]?.mcpServers;
      }),
      'Local scope (this project, in ~/.claude.json)',
    );
    await mcp(path.join(ws, '.mcp.json'), 'project', ['claude-code', 'copilot'], await jsonServers(path.join(ws, '.mcp.json'), 'mcpServers'));
    await mcp(path.join(ws, '.cursor', 'mcp.json'), 'project', ['cursor'], await jsonServers(path.join(ws, '.cursor', 'mcp.json'), 'mcpServers'));
    await mcp(path.join(ws, '.vscode', 'mcp.json'), 'project', ['copilot'], await jsonServers(path.join(ws, '.vscode', 'mcp.json'), 'servers'));
    const codexProject = path.join(ws, '.codex', 'config.toml');
    const t = await fs.readFile(codexProject, 'utf8').catch(() => undefined);
    if (t) await mcp(codexProject, 'project', ['codex'], codexMcpServers(t), 'Only for trusted projects');
  }
  await mcp(path.join(home, '.cursor', 'mcp.json'), 'user', ['cursor'], await jsonServers(path.join(home, '.cursor', 'mcp.json'), 'mcpServers'));
  if (input.vscodeUserMcp) await mcp(input.vscodeUserMcp, 'user', ['copilot'], await jsonServers(input.vscodeUserMcp, 'servers'), 'VS Code profile');
  const copilotCli = path.join(process.env.COPILOT_HOME || path.join(home, '.copilot'), 'mcp-config.json');
  await mcp(copilotCli, 'user', ['copilot'], await jsonServers(copilotCli, 'mcpServers'));
  const codexUser = path.join(codexHome, 'config.toml');
  const t = await fs.readFile(codexUser, 'utf8').catch(() => undefined);
  if (t) await mcp(codexUser, 'user', ['codex'], codexMcpServers(t));
  return out;
}

/** MCP server names configured more than once for the same agent (which one wins depends on the agent). */
export function mcpDuplicates(items: CustomizationItem[]): Array<{ agent: ProviderId; name: string; files: string[] }> {
  const seen = new Map<string, Set<string>>();
  for (const it of items.filter((i) => i.kind === 'mcp')) {
    for (const s of it.servers ?? []) {
      for (const a of it.agents) {
        const k = `${a}\u0000${s.name}`;
        seen.set(k, (seen.get(k) ?? new Set()).add(it.path + (it.note?.startsWith('Local') ? '#local' : '')));
      }
    }
  }
  return [...seen.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([k, files]) => {
      const [agent, name] = k.split('\u0000');
      return { agent, name, files: [...files] };
    });
}
