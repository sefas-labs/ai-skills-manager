// Sandbox-only subset of @types/vscode, written to type-check the extension
// layer where npm is unavailable. The real build uses @types/vscode
// (see devDependencies) and never includes this file.
declare module 'vscode' {
  export type Thenable<T> = PromiseLike<T>;
  export interface Disposable { dispose(): any }
  export type Event<T> = (listener: (e: T) => any, thisArgs?: any, disposables?: Disposable[]) => Disposable;
  export class EventEmitter<T> { event: Event<T>; fire(data: T): void; dispose(): void }

  export class Uri {
    static file(path: string): Uri;
    static parse(value: string): Uri;
    static joinPath(base: Uri, ...pathSegments: string[]): Uri;
    readonly scheme: string;
    readonly fsPath: string;
    toString(): string;
  }
  export class RelativePattern { constructor(base: Uri | string, pattern: string) }
  export type GlobPattern = string | RelativePattern;

  export interface ExtensionContext {
    readonly subscriptions: Disposable[];
    readonly extensionUri: Uri;
    readonly globalStorageUri: Uri;
  }
  export interface WorkspaceFolder { readonly uri: Uri; readonly name: string; readonly index: number }
  export interface ConfigurationChangeEvent { affectsConfiguration(section: string): boolean }
  export interface WorkspaceConfiguration { get<T>(section: string): T | undefined; get<T>(section: string, defaultValue: T): T }
  export interface FileSystemWatcher extends Disposable { onDidCreate: Event<Uri>; onDidChange: Event<Uri>; onDidDelete: Event<Uri> }
  export namespace workspace {
    const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    const isTrusted: boolean;
    const onDidChangeWorkspaceFolders: Event<unknown>;
    const onDidGrantWorkspaceTrust: Event<void>;
    const onDidChangeConfiguration: Event<ConfigurationChangeEvent>;
    function getConfiguration(section?: string): WorkspaceConfiguration;
    function createFileSystemWatcher(globPattern: GlobPattern): FileSystemWatcher;
    const fs: { createDirectory(uri: Uri): Thenable<void> };
  }

  export interface MessageOptions { modal?: boolean; detail?: string }
  export interface InputBoxOptions {
    title?: string; prompt?: string; placeHolder?: string; value?: string; ignoreFocusOut?: boolean;
    validateInput?(value: string): string | undefined | null | Thenable<string | undefined | null>;
  }
  export interface TextDocumentShowOptions { preview?: boolean }
  export interface WindowState { readonly focused: boolean }
  export interface ViewBadge { readonly tooltip: string; readonly value: number }
  export interface TreeView<T> extends Disposable { badge?: ViewBadge | undefined; message?: string }
  export interface TreeViewOptions<T> { treeDataProvider: TreeDataProvider<T>; showCollapseAll?: boolean }
  export enum ViewColumn { Active = -1, Beside = -2, One = 1 }
  export interface WebviewOptions { enableScripts?: boolean; localResourceRoots?: readonly Uri[] }
  export interface WebviewPanelOptions { retainContextWhenHidden?: boolean }
  export interface Webview {
    html: string;
    readonly cspSource: string;
    postMessage(message: any): Thenable<boolean>;
    onDidReceiveMessage: Event<any>;
    asWebviewUri(localResource: Uri): Uri;
  }
  export interface WebviewPanel extends Disposable {
    readonly webview: Webview;
    iconPath?: Uri | { light: Uri; dark: Uri };
    reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void;
    onDidDispose: Event<void>;
  }
  export interface TextEditor {}
  export namespace window {
    const onDidChangeWindowState: Event<WindowState>;
    function createTreeView<T>(viewId: string, options: TreeViewOptions<T>): TreeView<T>;
    function showInputBox(options?: InputBoxOptions): Thenable<string | undefined>;
    function showTextDocument(uri: Uri, options?: TextDocumentShowOptions): Thenable<TextEditor>;
    function showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function showInformationMessage(message: string, options: MessageOptions, ...items: string[]): Thenable<string | undefined>;
    function showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function showWarningMessage(message: string, options: MessageOptions, ...items: string[]): Thenable<string | undefined>;
    function showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function setStatusBarMessage(text: string, hideAfterTimeout: number): Disposable;
    function createWebviewPanel(viewType: string, title: string, showOptions: ViewColumn, options?: WebviewPanelOptions & WebviewOptions): WebviewPanel;
  }
  export namespace commands {
    function registerCommand(command: string, callback: (...args: any[]) => any): Disposable;
    function executeCommand<T = unknown>(command: string, ...rest: any[]): Thenable<T>;
  }
  export namespace env {
    const clipboard: { writeText(value: string): Thenable<void> };
    function openExternal(target: Uri): Thenable<boolean>;
  }
  export interface AuthenticationSession { readonly accessToken: string }
  export interface AuthenticationGetSessionOptions { createIfNone?: boolean; silent?: boolean }
  export namespace authentication {
    function getSession(providerId: string, scopes: readonly string[], options: AuthenticationGetSessionOptions & { createIfNone: true }): Thenable<AuthenticationSession>;
    function getSession(providerId: string, scopes: readonly string[], options?: AuthenticationGetSessionOptions): Thenable<AuthenticationSession | undefined>;
  }

  export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
  export class ThemeColor { constructor(id: string) }
  export class ThemeIcon { constructor(id: string, color?: ThemeColor) }
  export class MarkdownString {
    supportThemeIcons?: boolean;
    constructor(value?: string, supportThemeIcons?: boolean);
    appendMarkdown(value: string): MarkdownString;
    appendText(value: string): MarkdownString;
  }
  export interface Command { title: string; command: string; arguments?: any[] }
  export class TreeItem {
    label?: string; id?: string; description?: string | boolean; tooltip?: string | MarkdownString;
    iconPath?: ThemeIcon | Uri; contextValue?: string; command?: Command; resourceUri?: Uri;
    collapsibleState?: TreeItemCollapsibleState;
    constructor(label: string, collapsibleState?: TreeItemCollapsibleState);
  }
  export interface TreeDataProvider<T> {
    onDidChangeTreeData?: Event<T | T[] | undefined | null | void>;
    getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
    getChildren(element?: T): T[] | undefined | null | Thenable<T[] | undefined | null>;
  }
}
