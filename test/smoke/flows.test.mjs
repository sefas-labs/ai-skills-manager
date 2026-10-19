// End-to-end user flows through the real bundled extension: the dashboard
// sends the same messages a click would, every modal answers with its main
// action, and GitHub is the in-memory fake. Checks what lands on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadExtension, makeFakeVscode, root, setupFs } from './harness.mjs';

const require = createRequire(import.meta.url);
const { FakeGitHub } = require(path.join(root, 'out-test/test/helpers/fakeGitHub.js'));

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const md = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`;

async function boot() {
  const env = setupFs();
  process.env.HOME = env.home;
  const state = { workspace: env.workspace, commands: new Map(), executed: [], opened: [], messages: [] };
  const fake = makeFakeVscode(state);
  const asked = [];
  // Modals answer with their first action; pickers take the first item; inputs get a description.
  const modal = async (msg, opts, ...actions) => {
    state.messages.push(msg);
    asked.push(msg);
    return opts && opts.modal ? actions[0] : undefined;
  };
  fake.window.showInformationMessage = modal;
  fake.window.showWarningMessage = modal;
  fake.window.showQuickPick = async (items) => items[0];
  fake.window.showInputBox = async () => 'Typed description. Use when testing.';
  fake.window.withProgress = async (_o, fn) => fn({ report() {} });
  fake.window.createTerminal = () => ({ show() {}, sendText() {} });
  const gh = new FakeGitHub({
    'acme/skills': { defaultBranch: 'main', refs: { main: C1 }, commits: { [C1]: { 'skills/alpha/SKILL.md': md('alpha', 'Alpha v1.'), 'skills/alpha/run.sh': 'echo hi\n' }, [C2]: { 'skills/alpha/SKILL.md': md('alpha', 'Alpha v2.'), 'skills/alpha/run.sh': 'echo hi\n', 'skills/alpha/NEW.md': 'new' } } },
  });
  globalThis.fetch = gh.fetch;
  const { api, restore } = await loadExtension(fake, env.tmp);
  await state.commands.get('skillsManager.refresh')();
  await state.commands.get('skillsManager.openDashboard')();
  await state.send({ type: 'ready' });
  const last = (type) => state.panelMessages.findLast((m) => m.type === type);
  const view = () => last('state').state;
  const skill = (pred) => view().skills.find(pred);
  return { ...env, state, fake, gh, api, restore, asked, last, view, skill };
}

test('install from GitHub: analyze → review → install, no exec bits, provenance recorded', async () => {
  const t = await boot();
  try {
    await t.state.send({ type: 'inspect', url: 'acme/skills' });
    const insp = t.last('inspection').inspection;
    assert.deepEqual(insp.candidates.map((c) => c.installName), ['alpha']);
    await t.state.send({ type: 'stage', candidateIds: [insp.candidates[0].id] });
    assert.ok(t.last('staged'));
    const target = t.view().locations.find((l) => l.path === path.join(t.home, '.agents/skills'));
    await t.state.send({ type: 'install', locationId: target.id });
    assert.deepEqual(t.last('installed').names, ['alpha']);
    const dir = path.join(t.home, '.agents/skills/alpha');
    assert.equal(fs.statSync(path.join(dir, 'run.sh')).mode & 0o111, 0);
    const alpha = t.skill((s) => s.dir === dir);
    assert.equal(alpha.source.commit, C1);
  } finally {
    t.restore();
  }
});

test('update: check finds the new tree, review shows the diff, update replaces with a backup', async () => {
  const t = await boot();
  try {
    await t.state.send({ type: 'inspect', url: 'acme/skills' });
    await t.state.send({ type: 'stage', candidateIds: [t.last('inspection').inspection.candidates[0].id] });
    await t.state.send({ type: 'install', locationId: t.view().locations.find((l) => l.path === path.join(t.home, '.agents/skills')).id });
    t.gh.repos['acme/skills'].refs.main = C2;
    await t.state.send({ type: 'checkUpdates' });
    const alpha = t.skill((s) => s.name === 'alpha' && s.tracked);
    assert.equal(alpha.update.status, 'update-available');
    await t.state.send({ type: 'update', skillId: alpha.id });
    assert.ok(t.asked.some((m) => /^Update "alpha"\?/.test(m)), 'update modal shown');
    const dir = path.join(t.home, '.agents/skills/alpha');
    assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /Alpha v2/);
    assert.ok(fs.existsSync(path.join(dir, 'NEW.md')));
    assert.equal(t.skill((s) => s.dir === dir).source.commit, C2);
  } finally {
    t.restore();
  }
});

test('fix, toggle and remove: each writes only what its modal described', async () => {
  const t = await boot();
  try {
    // Fix: name ≠ folder.
    const bad = path.join(t.workspace, '.agents/skills/needs-fix');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'SKILL.md'), md('Wrong Name', 'Fix me.'));
    await t.state.commands.get('skillsManager.refresh')();
    await t.state.send({ type: 'fix', skillId: t.skill((s) => s.dirName === 'needs-fix').id });
    assert.match(fs.readFileSync(path.join(bad, 'SKILL.md'), 'utf8'), /^name: needs-fix$/m);

    // Toggle: Claude Code off for a global skill → ~/.claude/settings.json.
    const g = t.skill((s) => s.name === 'global-one' && s.displayDir.includes('.claude'));
    await t.state.send({ type: 'setToggle', skillId: g.id, agent: 'claude', value: 'off' });
    const settings = JSON.parse(fs.readFileSync(path.join(t.home, '.claude/settings.json'), 'utf8'));
    assert.deepEqual(settings.skillOverrides, { 'global-one': 'off' });
    assert.equal(t.skill((s) => s.id === g.id).toggles.claude.value, 'off');

    // Remove: moved to the backup folder, not deleted.
    const proj = t.skill((s) => s.name === 'project-skill');
    await t.state.send({ type: 'uninstall', skillId: proj.id });
    assert.ok(!fs.existsSync(path.join(t.workspace, '.agents/skills/project-skill')));
    const backups = fs.readdirSync(path.join(t.tmp, 'storage/backups'));
    assert.ok(backups.some((b) => b.endsWith('project-skill')));
  } finally {
    t.restore();
  }
});

test('merge: a redundant copy is moved to the backup and the duplicate warning disappears', async () => {
  const t = await boot();
  try {
    // Same skill in ~/.agents/skills and ~/.cursor/skills: the Cursor-only copy is redundant.
    const src = path.join(t.home, '.agents/skills/global-one');
    fs.cpSync(src, path.join(t.home, '.cursor/skills/global-one'), { recursive: true });
    await t.state.commands.get('skillsManager.refresh')();
    const m = t.view().merges.find((x) => x.name === 'global-one' && x.verdict === 'remove-redundant');
    assert.ok(m, 'merge suggested');
    const dirOf = (id) => m.copies.find((c) => c.skillId === id).displayDir.replace(/^~/, t.home);
    const removed = m.remove.map(dirOf);
    const kept = m.keep.map(dirOf);
    assert.ok(removed.length >= 1);
    await t.state.send({ type: 'merge', suggestionId: m.id, action: 'apply' });
    for (const d of removed) assert.ok(!fs.existsSync(d), `${d} moved to backup`);
    for (const d of kept) assert.ok(fs.existsSync(d), `${d} kept`);
    assert.ok(!t.view().merges.some((x) => x.name === 'global-one' && x.verdict === 'remove-redundant'), 'nothing left to merge');
  } finally {
    t.restore();
  }
});

test('config edits: new rule from a template, delete to backup, MCP add / toggle / remove', async () => {
  const t = await boot();
  try {
    const typed = [];
    t.fake.window.showInputBox = async () => typed.shift();
    const cfg = () => t.view().customizations.items;

    // New rule: first template (Claude Code rule) → first scope (this project) → name.
    typed.push('house-style');
    await t.state.send({ type: 'newCustomization', kind: 'rule' });
    const rule = path.join(t.workspace, '.claude/rules/house-style.md');
    assert.match(fs.readFileSync(rule, 'utf8'), /^# house-style/);
    assert.ok(t.state.opened.includes(rule), 'opened in the editor');
    const item = cfg().find((c) => c.kind === 'rule' && c.title === 'house-style.md');
    assert.ok(item?.deletable);
    await t.state.send({ type: 'deleteCustomization', id: item.id });
    assert.ok(!fs.existsSync(rule), 'moved to backup');
    assert.ok(t.asked.some((m) => /Delete house-style/.test(m)));

    // MCP: first target is the project's .mcp.json; stdio; name, command, args.
    typed.push('memory', 'npx', '-y "@modelcontextprotocol/server-memory"');
    await t.state.send({ type: 'mcpAdd' });
    const mcpFile = path.join(t.workspace, '.mcp.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(mcpFile, 'utf8')), { mcpServers: { memory: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } } });
    assert.ok(t.asked.some((m) => /Add MCP server "memory"/.test(m)));
    const card = cfg().find((c) => c.kind === 'mcp' && c.displayPath.endsWith('.mcp.json'));
    assert.equal(card.mcpFlavor, 'claude');
    await t.state.send({ type: 'mcpRemove', id: card.id, name: 'memory' });
    assert.deepEqual(JSON.parse(fs.readFileSync(mcpFile, 'utf8')), { mcpServers: {} });

    // Codex: enable/disable writes `enabled` in that server's table only.
    const codex = path.join(t.home, '.codex/config.toml');
    fs.mkdirSync(path.dirname(codex), { recursive: true });
    fs.writeFileSync(codex, 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
    await t.state.commands.get('skillsManager.refresh')();
    const cx = cfg().find((c) => c.mcpFlavor === 'codex');
    await t.state.send({ type: 'mcpToggle', id: cx.id, name: 'docs', enabled: false });
    assert.equal(fs.readFileSync(codex, 'utf8'), 'model = "gpt-5"\n\n[mcp_servers.docs]\nenabled = false\ncommand = "docs-mcp"\n');
    assert.equal(cfg().find((c) => c.mcpFlavor === 'codex').servers[0].enabled, false);

    // ~/.claude.json is never written.
    fs.writeFileSync(path.join(t.home, '.claude.json'), JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp' } } }));
    await t.state.commands.get('skillsManager.refresh')();
    const cj = cfg().find((c) => c.displayPath === '~/.claude.json');
    assert.ok(cj.readOnlyReason && !cj.mcpFlavor);
    await t.state.send({ type: 'mcpRemove', id: cj.id, name: 'gh' });
    assert.match(fs.readFileSync(path.join(t.home, '.claude.json'), 'utf8'), /gh-mcp/);
  } finally {
    t.restore();
  }
});
