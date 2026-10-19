// Shared harness for the smoke tests: a fake `vscode` module, a temp HOME and
// a loader for the real bundled extension (dist/extension.js).
import { createRequire } from 'node:module';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
export const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

export function makeFakeVscode(state) {
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
      createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, show() {}, dispose() {} }),
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
    env: { appName: 'Cursor', clipboard: { writeText: async (t) => { state.clipboard = t; } }, openExternal: async () => true },
    extensions: { all: [{ id: 'Anthropic.claude-code' }] },
    authentication: { getSession: async () => undefined },
  };
}

export function setupFs() {
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


/**
 * Activates a fresh copy of dist/extension.js against `fake`. Modals answer
 * with their first action (override fake.window.* to change that).
 */
export async function loadExtension(fake, tmp) {
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return fake;
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve(path.join(root, 'dist/extension.js'))];
  const ext = require(path.join(root, 'dist/extension.js'));
  const memento = new Map();
  const api = await ext.activate({ subscriptions: [], extensionUri: fake.Uri.file(root), globalStorageUri: fake.Uri.file(path.join(tmp, 'storage')), globalState: { get: (k) => memento.get(k), update: async (k, v) => memento.set(k, v) } });
  return { api, restore: () => (Module._load = origLoad) };
}
