// Renders the real bundled dashboard (dist/webview.js) in jsdom: every tab,
// key interactions, and compatibility with an older extension host.
// Run after the build:  npm run test:smoke
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const bundle = fs.readFileSync(path.join(root, 'dist/webview.js'), 'utf8');
const BUILD_ID = /buildId !== "([a-z0-9]+)"/.exec(bundle)?.[1];

const prov = (id, displayName, duplicateNames = []) => ({ id, displayName, docsUrl: 'https://example.com', visibleSkills: 2, duplicateNames, disableHint: 'Toggle it.' });
const loc = (id, label, scope, readers, extra = {}) => ({ id, path: '/x/' + id, label, scope, readers, readOnly: false, exists: true, skillCount: 1, ignoredEntries: [], ...extra });
const skill = (id, name, locationId, locationLabel, scope, visibleTo, extra = {}) => ({
  id, name, dirName: name, description: `${name} does things.`, dir: `/x/${locationId}/${name}`, displayDir: `${locationLabel}/${name}`, realDir: '', isSymlink: false,
  locationId, locationLabel, scope, visibleTo, frontmatter: [['name', name]], issues: [], readOnly: false, fixes: [], skillMdLines: 3, ...extra,
});

function fixture() {
  const dup = (a) => [{ severity: 'warning', code: `duplicate:${a}`, message: `${a} sees 2 different skills named "deploy".` }];
  return {
    buildId: BUILD_ID,
    scannedAt: '2026-10-19T10:00:00Z',
    host: { appName: 'Cursor', agentId: 'cursor' },
    agents: { 'claude-code': { installed: true, evidence: ['~/.claude.json'] }, cursor: { installed: true, evidence: ['built into this editor'] }, codex: { installed: false, evidence: [] }, copilot: { installed: true, evidence: ['~/.copilot'] } },
    trusted: true, githubSignedIn: false, hasWorkspace: true,
    providers: [prov('claude-code', 'Claude Code'), prov('cursor', 'Cursor', ['deploy']), prov('codex', 'Codex'), prov('copilot', 'GitHub Copilot', ['deploy'])],
    locations: [
      loc('wa', '.agents/skills', 'workspace', ['cursor', 'codex', 'copilot']),
      loc('wc', '.claude/skills', 'workspace', ['claude-code', 'cursor', 'copilot']),
      loc('wx', '.codex/skills', 'workspace', ['cursor'], { exists: false, skillCount: 0 }),
      loc('pl', 'plugin dev', 'global', ['claude-code'], { origin: 'plugin', namespace: 'dev', readOnly: true }),
      loc('gc', '~/.claude/skills', 'global', ['claude-code', 'cursor', 'copilot'], { skippedSynced: 1, skippedSyncedBuckets: [{ bucket: '11111111-1111-1111-1111-111111111111_22222222-2222-2222-2222-222222222222', path: '/x', skills: ['docs'], lastSynced: '2026-09-19T00:00:00Z' }] }),
    ],
    merges: [{ id: 'm1', name: 'deploy', scope: 'workspace', verdict: 'unify-versions', identical: false, seenTwiceBy: ['copilot', 'cursor'], stillTwiceBy: ['copilot', 'cursor'], keep: ['d1', 'd2'], remove: [],
      copies: [{ skillId: 'd1', displayDir: '.agents/skills/deploy', locationLabel: '.agents/skills', readers: ['cursor', 'codex', 'copilot'], writable: true, version: 0, changedFiles: 0 }, { skillId: 'd2', displayDir: '.claude/skills/deploy', locationLabel: '.claude/skills', readers: ['claude-code', 'cursor', 'copilot'], writable: true, version: 1, changedFiles: 1 }] }],
    skills: [
      skill('d1', 'deploy', 'wa', '.agents/skills', 'workspace', ['cursor', 'codex', 'copilot'], { issues: dup('cursor'), contentId: 'a' }),
      skill('d2', 'deploy', 'wc', '.claude/skills', 'workspace', ['claude-code', 'cursor', 'copilot'], { issues: dup('cursor'), contentId: 'b' }),
      skill('n1', 'needs-fix', 'wa', '.agents/skills', 'workspace', ['cursor', 'codex', 'copilot'], {
        issues: [{ severity: 'warning', code: 'name-mismatch', message: 'name does not match the folder.' }],
        fixes: [{ id: 'set-name-to-folder', codes: ['name-mismatch'], label: 'Set name to "needs-fix"', detail: 'Change name.' }],
      }),
      skill('g1', 'docs', 'gc', '~/.claude/skills', 'global', ['claude-code', 'cursor', 'copilot'], { readOnly: true, managed: 'synced', readOnlyReason: 'Synced from claude.ai' }),
      skill('g2', 'checklist', 'gc', '~/.claude/skills', 'global', ['claude-code', 'cursor', 'copilot'], { toggles: { claude: { value: 'name-only', from: 'user' }, codex: { enabled: true }, modelInvocation: true, userInvocable: true } }),
      skill('p1', 'checklist', 'pl', 'plugin dev', 'global', ['claude-code'], { namespace: 'dev', readOnly: true, readOnlyReason: 'Installed by a plugin' }),
    ],
  };
}

function mount(persisted = null) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { runScripts: 'outside-only' });
  const sent = []; // postMessage structured-clones: compare plain JSON
  dom.window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))), getState: () => persisted, setState: () => {} });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.eval(bundle);
  const doc = dom.window.document;
  const post = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  const click = (text, scope = doc) => {
    const b = [...scope.querySelectorAll('button')].find((x) => (typeof text === 'string' ? x.textContent.trim() === text : text.test(x.textContent)));
    assert.ok(b, `button ${text} exists`);
    b.click();
  };
  return { dom, doc, sent, post, click, errors: () => sent.filter((m) => m.type === 'clientError') };
}

test('every tab renders the fixture without errors', () => {
  for (const tab of ['overview', 'project', 'global', 'map', 'install']) {
    const { doc, post, errors } = mount({ tab });
    post({ type: 'state', state: fixture() });
    assert.deepEqual(errors(), [], `${tab}: no render errors`);
    assert.ok(!doc.body.textContent.includes('Scanning skill folders'), `${tab}: left the loading state`);
    assert.equal(doc.querySelector('.banner.warn')?.textContent.includes('extension was updated') ?? false, false, `${tab}: no stale-build banner`);
  }
});

test('overview: To do lists the conflict and the fix, and buttons post the right actions', () => {
  const { doc, sent, post, click } = mount({ tab: 'overview' });
  post({ type: 'state', state: fixture() });
  const todo = doc.querySelector('.todo').textContent;
  assert.match(todo, /needs-fix — 1 fixable problem/);
  assert.match(todo, /deploy — Cursor, GitHub Copilot see 2 different versions/);
  click('Fix…', doc.querySelector('.todo'));
  assert.deepEqual(sent.at(-1), { type: 'fix', skillId: 'n1' });
  // Codex is not detected → hidden from the matrix until "Show all".
  assert.ok(![...doc.querySelectorAll('.matrix th')].some((th) => th.textContent.includes('Codex')));
  click('Show all');
  assert.ok([...doc.querySelectorAll('.matrix th')].some((th) => th.textContent.includes('Codex')));
  // Empty folders fold away.
  assert.ok(!doc.querySelector('.matrix').textContent.includes('.codex/skills'));
  click(/Show 1 empty folder/);
  assert.ok(doc.querySelector('.matrix').textContent.includes('.codex/skills'));
});

test('project list groups duplicates; detail offers Use this copy and the fix', () => {
  const { doc, sent, post, click } = mount({ tab: 'project' });
  post({ type: 'state', state: fixture() });
  const groups = doc.querySelectorAll('.group');
  assert.equal(groups.length, 1);
  assert.match(groups[0].textContent, /deploy2 copies/);
  click(/deploy/, groups[0]);
  assert.equal(doc.querySelectorAll('.group .row.child').length, 2);
  click(/\.claude\/skills/, doc.querySelector('.group-children'));
  assert.equal(sent.findLast((m) => m.type === 'getDetail').skillId, 'd2');
  click('Use this copy…');
  assert.deepEqual(sent.at(-1), { type: 'chooseCopy', skillId: 'd2' });
  click(/needs-fix/, doc.querySelector('.list'));
  click('Set name to "needs-fix"');
  assert.deepEqual(sent.at(-1), { type: 'fix', skillId: 'n1', fixId: 'set-name-to-folder' });
});

test('global tab explains the other claude.ai account and offers Add to project', () => {
  const { doc, sent, post, click } = mount({ tab: 'global', selected: 'g2' });
  post({ type: 'state', state: fixture() });
  assert.match(doc.querySelector('.synced-notice').textContent, /1 synced skill from another claude\.ai account is not listed/);
  click('Add to project…');
  assert.deepEqual(sent.at(-1), { type: 'addToProject', skillId: 'g2' });
  // A plugin skill with the same name is a different skill (dev:checklist), not a second copy.
  assert.equal(doc.querySelectorAll('.group').length, 0);
  assert.ok([...doc.querySelectorAll('.list .name')].some((n) => n.textContent === 'dev:checklist'));
  click('Move to backup…');
  assert.deepEqual(sent.at(-1), { type: 'archiveSynced', bucket: '11111111-1111-1111-1111-111111111111_22222222-2222-2222-2222-222222222222' });
});

test('map: coverage gaps offer Copy to; diagram highlights on hover', () => {
  const { doc, dom, sent, post, click } = mount({ tab: 'map', mapScope: 'project' });
  post({ type: 'state', state: fixture() });
  click(/^Copy to /);
  assert.equal(sent.at(-1).type, 'copyTo');
  const agent = [...doc.querySelectorAll('svg .node.agent')].find((g) => g.textContent.includes('Claude Code'));
  agent.dispatchEvent(new dom.window.Event('mouseenter'));
  assert.ok(doc.querySelector('svg.flow').classList.contains('focused'));
  assert.ok([...doc.querySelectorAll('svg .node.hl text')].some((t) => t.textContent === 'deploy'));
});

test('an extension host from an older build still renders and asks to reload', () => {
  const { doc, sent, post, click, errors } = mount({ tab: 'project' });
  const old = fixture();
  for (const k of ['buildId', 'host', 'agents', 'merges']) delete old[k];
  for (const s of old.skills) delete s.fixes;
  post({ type: 'state', state: old });
  assert.deepEqual(errors(), []);
  assert.match(doc.querySelector('.banner.warn').textContent, /extension was updated/);
  click('Reload Window');
  assert.deepEqual(sent.at(-1), { type: 'reloadWindow' });
});

test('selecting a skill keeps the list scroll position', () => {
  const { dom, doc, post } = mount({ tab: 'project' });
  const store = new WeakMap();
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTop', { get() { return store.get(this) ?? 0; }, set(v) { store.set(this, v); }, configurable: true });
  post({ type: 'state', state: fixture() });
  doc.querySelector('.list').scrollTop = 300;
  [...doc.querySelectorAll('.list > .row')].at(-1).click();
  assert.equal(doc.querySelector('.list').scrollTop, 300);
});

test('install → browse catalog: lists a collection, filters, and Install hands the URL to the review flow', () => {
  const { doc, sent, post, click } = mount({ tab: 'install' });
  post({ type: 'state', state: fixture() });
  post({ type: 'catalogSources', sources: [{ id: 'acme/skills', title: 'Acme', blurb: 'Acme skills.' }, { id: 'other/repo', title: 'Other', blurb: '' }] });
  assert.deepEqual(sent.filter((m) => m.type === 'catalogList'), [{ type: 'catalogList', sourceId: 'acme/skills', force: false }], 'first collection requested once');
  const sk = (name, extra = {}) => ({ sourceId: 'acme/skills', owner: 'acme', repo: 'skills', dir: `skills/${name}`, name, description: `${name} helper`, url: `https://github.com/acme/skills/tree/main/skills/${name}`, installedIn: [], ...extra });
  post({ type: 'catalogSkills', sourceId: 'acme/skills', truncated: false, skills: [sk('pdf', { installed: 'same-source', installedIn: ['~/.agents/skills'] }), sk('deploy')] });
  assert.equal(doc.querySelectorAll('.cat-card').length, 2);
  assert.match(doc.querySelector('.cat-card').textContent, /pdfinstalled/);
  const q = doc.getElementById('catalog-q');
  q.value = 'deploy';
  q.dispatchEvent(new doc.defaultView.Event('input'));
  assert.equal(doc.querySelectorAll('.cat-card').length, 1);
  click('Install…', doc.querySelector('.cat-card'));
  assert.deepEqual(sent.at(-1), { type: 'inspect', url: 'https://github.com/acme/skills/tree/main/skills/deploy' });
  assert.ok(doc.getElementById('url'), 'switched to the URL flow');
  // Not signed in: searching all of GitHub asks for a sign-in instead.
  click('From a URL');
  click('Browse catalog');
  click('Sign in to search GitHub');
  assert.equal(sent.at(-1).type, 'signIn');
});

test('per-agent switches post each agent own mechanism', () => {
  const { doc, sent, post, click } = mount({ tab: 'global', selected: 'g2' });
  post({ type: 'state', state: fixture() });
  const rows = [...doc.querySelectorAll('.switch-row')];
  assert.match(rows[0].textContent, /Claude Code.*from user settings/);
  assert.ok(doc.querySelector('.list').textContent.includes('Claude: limited'), 'list shows the limited state');
  click('Off', rows[0]);
  assert.deepEqual(sent.at(-1), { type: 'setToggle', skillId: 'g2', agent: 'claude', value: 'off' });
  const fm = rows.find((r) => /Cursor & Copilot/.test(r.textContent));
  click('Only /name', fm);
  assert.deepEqual(sent.at(-1), { type: 'setToggle', skillId: 'g2', agent: 'frontmatter', mode: 'manual' });
});

test('config tab: sections per kind, MCP servers with names only, duplicates flagged, open posts the id', () => {
  const { doc, sent, post, click, errors } = mount({ tab: 'config' });
  const state = fixture();
  state.customizations = {
    items: [
      { id: '0', kind: 'instructions', displayPath: '~/repo/CLAUDE.md', scope: 'project', agents: ['claude-code', 'copilot'], title: 'CLAUDE.md' },
      { id: '1', kind: 'rule', displayPath: '~/repo/.cursor/rules/react.mdc', scope: 'project', agents: ['cursor'], title: 'react.mdc', description: 'React rules' },
      { id: '2', kind: 'mcp', displayPath: '~/repo/.mcp.json', scope: 'project', agents: ['claude-code', 'copilot'], title: '.mcp.json', servers: [{ name: 'github', transport: 'http', url: 'https://api.example.com/mcp', envKeys: [], headerKeys: ['Authorization'], enabled: true }] },
    ],
    mcpDuplicates: [{ agent: 'claude-code', name: 'github', files: ['~/repo/.mcp.json', '~/.claude.json'] }],
  };
  post({ type: 'state', state });
  assert.deepEqual(errors(), []);
  const text = doc.body.textContent;
  assert.match(text, /Instructions1/);
  assert.match(text, /React rules/);
  assert.match(text, /header Authorization/);
  assert.match(doc.querySelector('.banner.warn').textContent, /Claude Code: github/);
  click('react.mdc');
  assert.deepEqual(sent.at(-1), { type: 'openCustomization', id: '1' });
});
