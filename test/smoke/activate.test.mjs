// Loads the real bundled extension (dist/extension.js) against a fake `vscode`
// module and exercises activation, the tree view and the dashboard handshake.
// Run after `npm run build`:  node --test "test/smoke/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function makeFakeVscode(state) {
  class EventEmitter {
    constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
    fire(v) { for (const l of this.listeners) l(v); }
    dispose() {}
  }
  const noopEvent = () => ({ dispose() {} });
  class Uri {
    constructor(p) { this.fsPath = p; this.scheme = 'file'; this.path = p; }
    static file(p) { return new Uri(p); }
    static parse(s) { return new Uri(s); }
    static joinPath(base, ...segs) { return new Uri(path.join(base.fsPath, ...segs)); }
    toString() { return 'file://' + this.fsPath; }
  }
  class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
  class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } appendText(s) { this.value += s; return this; } }
  const panelMessages = [];
  let receive;
  return {
    EventEmitter, Uri, TreeItem, MarkdownString,
    RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1 },
    ProgressLocation: { Notification: 15 },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(state.workspace), name: 'project', index: 0 }],
      isTrusted: true,
      onDidChangeWorkspaceFolders: noopEvent,
      onDidGrantWorkspaceTrust: noopEvent,
      onDidChangeConfiguration: noopEvent,
      getConfiguration: () => ({ get: (_k, d) => d }),
      createFileSystemWatcher: () => ({ onDidCreate: noopEvent, onDidChange: noopEvent, onDidDelete: noopEvent, dispose() {} }),
      fs: { createDirectory: async () => {} },
    },
    window: {
      onDidChangeWindowState: noopEvent,
      createTreeView: (id, opts) => { state.tree = opts.treeDataProvider; state.view = { id, dispose() {} }; return state.view; },
      showInputBox: async () => undefined,
      showTextDocument: async (uri) => { state.opened.push(uri.fsPath); },
      showInformationMessage: async (...a) => { state.messages.push(a[0]); return undefined; },
      showWarningMessage: async (...a) => { state.messages.push(a[0]); return undefined; },
      showErrorMessage: async (...a) => { state.messages.push(a[0]); return undefined; },
      setStatusBarMessage: () => ({ dispose() {} }),
      createWebviewPanel: () => {
        const panel = {
          webview: {
            html: '', cspSource: 'vscode-resource:',
            asWebviewUri: (u) => u,
            postMessage: async (m) => { panelMessages.push(m); return true; },
            onDidReceiveMessage: (fn) => { receive = fn; return { dispose() {} }; },
          },
          reveal() {}, onDidDispose: noopEvent, dispose() {},
        };
        state.panel = panel;
        state.panelMessages = panelMessages;
        state.send = (m) => receive(m);
        return panel;
      },
    },
    commands: {
      registerCommand: (id, fn) => { state.commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...args) => { state.executed.push([id, ...args]); },
    },
    env: { clipboard: { writeText: async (t) => { state.clipboard = t; } }, openExternal: async () => true },
    authentication: { getSession: async () => undefined },
  };
}

function setupFs() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-smoke-')));
  const home = path.join(tmp, 'home');
  const workspace = path.join(tmp, 'project');
  const mk = (dir, name, desc = 'A test skill. Use in tests.') => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nBody of ${name}.\n`);
  };
  mk(path.join(home, '.claude/skills'), 'global-one');
  mk(path.join(home, '.agents/skills'), 'global-one', 'A different copy.');
  mk(path.join(workspace, '.agents/skills'), 'project-skill');
  fs.mkdirSync(path.join(workspace, '.agents/skills/project-skill/scripts'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.agents/skills/project-skill/scripts/run.sh'), 'echo hi\n');
  return { tmp, home, workspace };
}

test('extension activates, lists skills and answers the dashboard handshake', async () => {
  const { tmp, home, workspace } = setupFs();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const state = { workspace, commands: new Map(), executed: [], opened: [], messages: [] };
  const fake = makeFakeVscode(state);
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return fake;
    return origLoad.call(this, request, ...rest);
  };
  try {
    const ext = require(path.join(root, 'dist/extension.js'));
    const memento = new Map();
    const globalState = { get: (k) => memento.get(k), update: async (k, v) => { memento.set(k, v); } };
    const context = { subscriptions: [], extensionUri: fake.Uri.file(root), globalStorageUri: fake.Uri.file(path.join(tmp, 'storage')), globalState };
    await ext.activate(context);

    // Every command declared in package.json is registered.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const declared = pkg.contributes.commands.map((c) => c.command).sort();
    assert.deepEqual([...state.commands.keys()].sort(), declared);

    await state.commands.get('skillsManager.refresh')();
    const scopes = await state.tree.getChildren();
    assert.deepEqual(scopes.map((s) => s.scope), ['workspace', 'global']);
    const globalLocs = await state.tree.getChildren(scopes[1]);
    assert.ok(globalLocs.length >= 2);
    const skills = await state.tree.getChildren(globalLocs[0]);
    const item = state.tree.getTreeItem(skills[0]);
    assert.equal(item.label, 'global-one');
    assert.match(item.description, /warning/); // duplicate across .claude and .agents for Cursor/Copilot
    assert.ok(state.view.badge && state.view.badge.value >= 1);

    // Tree commands
    await state.commands.get('skillsManager.copySkillPath')(skills[0]);
    assert.match(state.clipboard, /global-one$/);
    await state.commands.get('skillsManager.openSkillFile')(skills[0]);
    assert.match(state.opened.at(-1), /SKILL\.md$/);

    // Dashboard: CSP + nonce, then ready → state message
    await state.commands.get('skillsManager.openDashboard')();
    assert.match(state.panel.webview.html, /Content-Security-Policy/);
    assert.match(state.panel.webview.html, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
    assert.doesNotMatch(state.panel.webview.html, /unsafe-inline|unsafe-eval/);
    await state.send({ type: 'ready' });
    const st = state.panelMessages.find((m) => m.type === 'state');
    assert.ok(st, 'state posted to webview');
    assert.equal(st.state.skills.length, 3);
    assert.deepEqual(st.state.providers.map((p) => p.id), ['claude-code', 'cursor', 'codex', 'copilot']);
    assert.ok(!JSON.stringify(st.state).includes('accessToken'));

    const proj = st.state.skills.find((s) => s.name === 'project-skill');
    await state.send({ type: 'getDetail', skillId: proj.id });
    const detail = state.panelMessages.find((m) => m.type === 'detail');
    assert.deepEqual(detail.detail.files, ['SKILL.md', 'scripts/run.sh']);
    assert.match(detail.detail.body, /Body of project-skill/);

    // Bad URL is reported back as an error, not thrown.
    await state.send({ type: 'inspect', url: 'https://gitlab.com/x/y' });
    const err = state.panelMessages.find((m) => m.type === 'error');
    assert.match(err.message, /github\.com/);
  } finally {
    Module._load = origLoad;
  }
});
