import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { codexMcpServers, maskArgs, mcpDuplicates, mcpTargets, readCustomizations, safeUrl } from '../../src/core/customizations';
import { tempDir } from '../helpers/fsFixture';

const w = async (p: string, c: string) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c);
};

test('masking: secret-looking args and URL queries never leave the core', () => {
  assert.deepEqual(maskArgs(['-y', '@acme/mcp', '--token', 'abc', 'ghp_123', 'api_key=zzz', 'plain']), ['-y', '@acme/mcp', '--token', '•••', '•••', '•••', 'plain']);
  assert.equal(safeUrl('https://user:pw@mcp.acme.com/v1?key=SECRET'), 'https://mcp.acme.com/v1?…');
  assert.deepEqual(maskArgs(['postgres://admin:S3cret@db:5432/app', 'redis://:pw@cache', 'https://example.com/x']), ['postgres://admin:•••@db:5432/app', 'redis://:•••@cache', 'https://example.com/x']);
});

test('codex config.toml: [mcp_servers.*] tables, env sub-tables, multi-line args', () => {
  const s = codexMcpServers(`model = "x"
[mcp_servers.docs]
command = "npx"
args = [
  "-y",
  "docs-mcp",
]
env = { DOCS_KEY = "secret-value" }
[mcp_servers.docs.env]
OTHER = "also-secret"
[mcp_servers."ticket-api"]
url = "https://mcp.example.com/mcp?token=nope"
bearer_token_env_var = "TICKETS"
enabled = false
[profiles.x]
command = "not a server"
`);
  assert.deepEqual(s, [
    { name: 'docs', transport: 'stdio', command: 'npx -y docs-mcp', url: undefined, envKeys: ['DOCS_KEY', 'OTHER'], headerKeys: [], enabled: true },
    { name: 'ticket-api', transport: 'http', command: undefined, url: 'https://mcp.example.com/mcp?…', envKeys: [], headerKeys: ['Authorization'], enabled: false },
  ]);
  assert.ok(!JSON.stringify(s).includes('secret'));
});

test('inventory: instructions, rules, agents, commands and MCP per agent, secrets redacted', async () => {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const ws = path.join(repo, 'app');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await w(path.join(repo, 'CLAUDE.md'), '# repo rules');
  await w(path.join(ws, 'AGENTS.md'), '# agents');
  await w(path.join(ws, 'CLAUDE.local.md'), 'mine');
  await w(path.join(ws, '.github/copilot-instructions.md'), 'copilot');
  await w(path.join(ws, '.cursor/rules/front/react.mdc'), '---\ndescription: React rules\nglobs: "*.tsx"\n---\nUse hooks.');
  await w(path.join(ws, '.cursor/rules/ignored.md'), 'plain md is ignored by Cursor');
  await w(path.join(ws, '.claude/agents/review/reviewer.md'), '---\nname: reviewer\ndescription: Reviews code\n---\n');
  await w(path.join(ws, '.claude/commands/ship.md'), 'Ship it');
  await w(path.join(home, '.codex/AGENTS.override.md'), 'override');
  await w(path.join(home, '.codex/AGENTS.md'), 'base');
  await w(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer SECRET-1' } } } }));
  await w(path.join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['gh-mcp', '--token', 'SECRET-2'], env: { GH: 'SECRET-3' } } } }));
  await w(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'stdio', command: 'gh-mcp' } }, projects: { [ws]: { mcpServers: { local: { type: 'stdio', command: 'x' } } } }, oauthAccount: { emailAddress: 'SECRET-4' } }));
  const items = await readCustomizations({ homeDir: home, workspaceFolders: [ws], platform: 'linux' });
  const by = (kind: string) => items.filter((i) => i.kind === kind).map((i) => `${path.relative(root, i.path)}:${i.agents.join('+')}`);
  assert.deepEqual(by('instructions'), [
    'home/.codex/AGENTS.override.md:codex',
    'repo/CLAUDE.md:claude-code+copilot',
    'repo/app/CLAUDE.local.md:claude-code',
    'repo/app/AGENTS.md:codex+cursor+copilot',
    'repo/app/.github/copilot-instructions.md:copilot',
  ]);
  assert.match(items.find((i) => i.path.endsWith('app/AGENTS.md'))!.note ?? '', /Claude Code reads CLAUDE\.md instead/);
  assert.deepEqual(by('rule'), ['repo/app/.cursor/rules/front/react.mdc:cursor']);
  assert.equal(items.find((i) => i.kind === 'rule')!.description, 'React rules');
  assert.deepEqual(items.filter((i) => i.kind === 'agent').map((i) => i.title), ['reviewer']);
  assert.deepEqual(items.filter((i) => i.kind === 'command').map((i) => i.title), ['/ship']);
  const mcp = items.filter((i) => i.kind === 'mcp');
  assert.deepEqual(mcp.map((i) => `${path.relative(root, i.path)}:${i.scope}:${i.servers!.map((s) => s.name)}`).sort(), [
    'home/.claude.json:local:local',
    'home/.claude.json:user:github',
    'home/.cursor/mcp.json:user:github',
    'repo/app/.mcp.json:project:github',
  ]);
  assert.ok(!JSON.stringify(items).includes('SECRET'), 'no secret value in the inventory');
  const cursorGh = mcp.find((i) => i.path.endsWith('.cursor/mcp.json'))!.servers![0];
  assert.deepEqual([cursorGh.command, cursorGh.envKeys], ['npx gh-mcp --token •••', ['GH']]);
  const dups = mcpDuplicates(items);
  assert.deepEqual(dups.map((d) => `${d.agent}:${d.name}:${d.files.length}`).sort(), ['claude-code:github:2']);
  // Editable files carry their entry format; ~/.claude.json is left to `claude mcp`.
  assert.deepEqual(mcp.map((i) => `${path.basename(i.path)}:${i.mcpFlavor ?? 'ro'}:${!!i.readOnlyReason}`).sort(), ['.claude.json:ro:true', '.claude.json:ro:true', '.mcp.json:claude:false', 'mcp.json:cursor:false']);
  const targets = mcpTargets({ homeDir: home, workspaceFolders: [ws], platform: process.platform });
  assert.deepEqual(targets.map((t) => `${path.relative(root, t.path)}:${t.flavor}`), [
    'repo/app/.mcp.json:claude',
    'repo/app/.cursor/mcp.json:cursor',
    'repo/app/.vscode/mcp.json:vscode',
    'repo/app/.codex/config.toml:codex',
    'home/.cursor/mcp.json:cursor',
    ...(process.env.COPILOT_HOME ? [] : ['home/.copilot/mcp-config.json:copilot-cli']),
    ...(process.env.CODEX_HOME ? [] : ['home/.codex/config.toml:codex']),
  ].filter(Boolean));
});

test('nested CLAUDE.md / AGENTS.md, Copilot prompt files and custom agents', async () => {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  await w(path.join(ws, 'apps/web/CLAUDE.md'), 'web');
  await w(path.join(ws, 'apps/api/AGENTS.md'), 'api');
  await w(path.join(ws, 'node_modules/x/CLAUDE.md'), 'ignored');
  await w(path.join(ws, '.github/prompts/release.prompt.md'), '---\ndescription: Write release notes\n---\n');
  await w(path.join(ws, '.github/agents/planner.agent.md'), '---\ndescription: Plans work\n---\n');
  await w(path.join(ws, '.claude/agents/reviewer.md'), '---\nname: reviewer\ndescription: Reviews\n---\n');
  await w(path.join(home, '.copilot/agents/helper.agent.md'), '---\ndescription: Helps\n---\n');
  const vsUser = path.join(root, 'Code/User');
  await w(path.join(vsUser, 'prompts/mine.prompt.md'), 'x');
  const items = await readCustomizations({ homeDir: home, workspaceFolders: [ws], platform: 'linux', vscodeUserDir: vsUser });
  const rel = (p: string) => path.relative(root, p);
  const nested = items.filter((i) => i.note?.startsWith('Nested'));
  assert.deepEqual(nested.map((i) => `${rel(i.path)}:${i.agents.join('+')}`), ['ws/apps/api/AGENTS.md:cursor', 'ws/apps/web/CLAUDE.md:claude-code']);
  assert.match(nested[1].note!, /apps\/web\//);
  assert.deepEqual(items.filter((i) => i.kind === 'command').map((i) => `${i.title}:${i.agents}`).sort(), ['/mine:copilot', '/release:copilot']);
  assert.deepEqual(items.filter((i) => i.kind === 'agent').map((i) => `${i.title}:${i.agents.join('+')}`).sort(), ['helper:copilot', 'planner:copilot', 'reviewer:claude-code+copilot']);
  const withNested = await readCustomizations({ homeDir: home, workspaceFolders: [ws], platform: 'linux', copilotNestedAgentsMd: true });
  assert.deepEqual(withNested.find((i) => i.path.endsWith('apps/api/AGENTS.md'))!.agents, ['cursor', 'copilot']);
});
