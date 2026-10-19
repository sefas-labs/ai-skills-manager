import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  addMcpServer,
  createFromTemplate,
  deleteToBackup,
  hasJsonComments,
  isManagedByAgent,
  mcpEntry,
  removeMcpServer,
  setCodexMcpEnabled,
  splitArgs,
  templatePath,
  validateServer,
} from '../../src/core/editing';
import { tempDir } from '../helpers/fsFixture';

test('splitArgs handles simple shell quoting', () => {
  assert.deepEqual(splitArgs(`-y "@scope/pkg x" 'a b' c\\ d`), ['-y', '@scope/pkg x', 'a b', 'c\\', 'd']);
  assert.deepEqual(splitArgs('  '), []);
  assert.deepEqual(splitArgs('"say \\"hi\\""'), ['say "hi"']);
});

test('hasJsonComments ignores slashes inside strings', () => {
  assert.equal(hasJsonComments('{"url":"https://x.dev/a"}'), false);
  assert.equal(hasJsonComments('{\n // c\n "a":1}'), true);
  assert.equal(hasJsonComments('{"a":1 /* c */}'), true);
});

test('validateServer: names, commands and URLs', () => {
  assert.doesNotThrow(() => validateServer({ name: 'gh', transport: 'stdio', command: 'npx' }));
  assert.doesNotThrow(() => validateServer({ name: 'local', transport: 'http', url: 'http://localhost:3000/mcp' }));
  assert.throws(() => validateServer({ name: 'a b', transport: 'stdio', command: 'npx' }), /Server names/);
  assert.throws(() => validateServer({ name: '__proto__', transport: 'stdio', command: 'npx' }), /Server names/);
  assert.throws(() => validateServer({ name: 'x', transport: 'stdio', command: '  ' }), /command/);
  assert.throws(() => validateServer({ name: 'x', transport: 'stdio', command: 'a\nb' }), /command/);
  assert.throws(() => validateServer({ name: 'x', transport: 'http', url: 'http://evil.example/mcp' }), /https/);
  assert.throws(() => validateServer({ name: 'x', transport: 'http', url: 'nope' }), /valid URL/);
});

test('templates: path checks, create never overwrites, delete goes to backup', async () => {
  const root = await tempDir();
  const base = { workspace: path.join(root, 'ws'), home: path.join(root, 'home') };
  assert.throws(() => templatePath('claude-rule', 'project', '../x', base), /letters/);
  assert.throws(() => templatePath('cursor-rule', 'user', 'x', base), /no user location/);
  assert.throws(() => templatePath('claude-rule', 'project', 'x', { home: base.home }), /no project location/);
  assert.equal(templatePath('copilot-agent', 'project', 'reviewer', base), path.join(base.workspace, '.github/agents/reviewer.agent.md'));

  const file = await createFromTemplate('claude-agent', 'project', 'reviewer', base);
  assert.equal(file, path.join(base.workspace, '.claude/agents/reviewer.md'));
  assert.match(await fs.readFile(file, 'utf8'), /^---\nname: reviewer\n/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
  await assert.rejects(createFromTemplate('claude-agent', 'project', 'reviewer', base), /already exists/);

  const backups = path.join(root, 'backups');
  const moved = await deleteToBackup(file, backups);
  assert.equal(await fs.access(file).then(() => true, () => false), false);
  assert.match(await fs.readFile(moved, 'utf8'), /name: reviewer/);
  await assert.rejects(deleteToBackup(file, backups), /no longer exists/);
});

test('MCP JSON: add / remove keeps other keys, backs up, refuses JSONC and duplicates', async () => {
  const root = await tempDir();
  const backups = path.join(root, 'b');
  const file = path.join(root, '.mcp.json');
  // New file: no backup.
  assert.equal(await addMcpServer(file, 'claude', { name: 'gh', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'] }, backups), undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { mcpServers: { gh: { type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'] } } });

  await fs.writeFile(file, JSON.stringify({ other: 1, mcpServers: { gh: { command: 'npx' } } }));
  const backup = await addMcpServer(file, 'claude', { name: 'docs', transport: 'http', url: 'https://docs.example/mcp' }, backups);
  assert.ok(backup);
  assert.deepEqual(JSON.parse(await fs.readFile(backup!, 'utf8')), { other: 1, mcpServers: { gh: { command: 'npx' } } });
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(after.other, 1);
  assert.deepEqual(Object.keys(after.mcpServers), ['gh', 'docs']);
  await assert.rejects(addMcpServer(file, 'claude', { name: 'gh', transport: 'stdio', command: 'x' }, backups), /already exists/);

  await removeMcpServer(file, 'claude', 'gh', backups);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).mcpServers), ['docs']);
  await assert.rejects(removeMcpServer(file, 'claude', 'gh', backups), /is not in/);
  await assert.rejects(removeMcpServer(file, 'claude', 'constructor', backups), /is not in/);

  const vs = path.join(root, 'mcp.json');
  await fs.writeFile(vs, '{\n  // mine\n  "servers": {"a": {"command": "x"}}\n}\n');
  await assert.rejects(removeMcpServer(vs, 'vscode', 'a', backups), /has comments/);
  assert.match(await fs.readFile(vs, 'utf8'), /\/\/ mine/, 'untouched');
  await fs.writeFile(vs, '{"servers": {');
  await assert.rejects(addMcpServer(vs, 'vscode', { name: 'b', transport: 'stdio', command: 'x' }, backups), /not valid JSON/);

  const left = (await fs.readdir(root)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(left, [], 'no temp files left behind');
});

test('MCP Codex TOML: add, enable/disable, remove only touch that server', async () => {
  const root = await tempDir();
  const backups = path.join(root, 'b');
  const file = path.join(root, 'config.toml');
  const original = ['model = "gpt-5"', '', '[mcp_servers.gh]', 'command = "npx"', '', '[mcp_servers.gh.env]', 'TOKEN = "x"', '', '[profiles.fast]', 'model = "o4"', ''].join('\n');
  await fs.writeFile(file, original);

  await addMcpServer(file, 'codex', { name: 'my.docs', transport: 'http', url: 'https://d.example/mcp' }, backups);
  let text = await fs.readFile(file, 'utf8');
  assert.ok(text.startsWith(original.trimEnd() + '\n\n[mcp_servers."my.docs"]\nurl = "https://d.example/mcp"\n'));
  await assert.rejects(addMcpServer(file, 'codex', { name: 'gh', transport: 'stdio', command: 'x' }, backups), /already exists/);

  await setCodexMcpEnabled(file, 'gh', false, backups);
  text = await fs.readFile(file, 'utf8');
  assert.match(text, /\[mcp_servers\.gh\]\nenabled = false\ncommand = "npx"/);
  await setCodexMcpEnabled(file, 'gh', true, backups);
  assert.match(await fs.readFile(file, 'utf8'), /\[mcp_servers\.gh\]\nenabled = true\n/);

  await removeMcpServer(file, 'codex', 'gh', backups);
  text = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(text, /mcp_servers\.gh|TOKEN/);
  assert.match(text, /^model = "gpt-5"\n\n\[profiles\.fast\]\nmodel = "o4"\n/);
  assert.match(text, /\[mcp_servers\."my\.docs"\]/);
  await removeMcpServer(file, 'codex', 'my.docs', backups);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /my\.docs/);
});

test("~/.claude.json is left to Claude Code's own CLI", () => {
  assert.equal(isManagedByAgent('/h/.claude.json', '/h'), true);
  assert.equal(isManagedByAgent('/h/proj/.mcp.json', '/h'), false);
});

test('MCP entry shape follows each agent\'s documented format', () => {
  const stdio = { name: 'x', transport: 'stdio' as const, command: 'npx', args: ['-y', 'pkg'] };
  const http = { name: 'x', transport: 'http' as const, url: 'https://h.example/mcp' };
  assert.deepEqual(mcpEntry('claude', stdio), { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
  assert.deepEqual(mcpEntry('vscode', http), { type: 'http', url: 'https://h.example/mcp' });
  assert.deepEqual(mcpEntry('cursor', stdio), { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
  assert.deepEqual(mcpEntry('cursor', http), { url: 'https://h.example/mcp' });
  assert.deepEqual(mcpEntry('copilot-cli', stdio), { type: 'local', command: 'npx', args: ['-y', 'pkg'], tools: ['*'] });
  assert.deepEqual(mcpEntry('copilot-cli', http), { type: 'http', url: 'https://h.example/mcp', tools: ['*'] });
});
