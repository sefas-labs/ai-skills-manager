import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectAgents, hostAgentFor, type AgentDetection } from '../core/agents';
import { discover, DiscoverOptions, readClaudeSyncBucket } from '../core/discovery';
import { fixesFor } from '../core/fixes';
import { mcpDuplicates, readCustomizations, type CustomizationInput, type CustomizationItem } from '../core/customizations';
import { CatalogStore } from './catalog';
import { readToggleState, toggleFiles, type SkillToggleState } from '../core/toggles';
import { mergeSuggestions, type MergeSuggestion } from '../core/merge';
import { LockStore } from '../core/lockfile';
import { BUILTIN_PROVIDERS } from '../core/providers';
import { pathKey, tildify } from '../core/paths';
import { trackedFromLock } from '../core/provenance';
import { basisOf, type UpdateCheck } from '../core/updates';
import type { DiscoveryContext, DiscoveryResult, ProviderAdapter, ReadLocation, ResolvedLocation, SkillRecord, TrackedSource } from '../core/types';
import type { ViewCustomization, ViewSkill, ViewState } from '../shared/protocol';

declare const __BUILD_ID__: string;

const UPDATE_CACHE_KEY = 'skillsManager.updateCache';
const DEFAULT_REFRESH_DELAY_MS = 300;
/** Global folders outside the workspace can change while the editor is in the background. */
const REFRESH_ON_FOCUS_DELAY_MS = 800;
const MAX_FRONTMATTER_VALUE_LENGTH = 600;
const LOCAL_SCOPE_MARKER = '#local';
const UNTRUSTED_WORKSPACE_REASON = 'Workspace is not trusted (Restricted Mode).';
/** Workspace folders where a new skills folder may appear. */
const NEW_SKILL_GLOB = '**/{.claude,.cursor,.agents,.codex,.github}/skills/*/SKILL.md';
/** Settings outside `skillsManager` that change what agents load. */
const RELATED_SETTINGS = ['skillsManager', 'chat.useCustomizationsInParentRepositories', 'chat.useNestedAgentsMdFiles'];

interface UpdateCache {
  checkedAt?: string;
  results: Record<string, UpdateCheck>;
}

interface ExtraLocationSetting {
  path: string;
  scope?: string;
  readers?: string[];
}

/** Owns the current scan result, file watching and storage paths. */
export class SkillsService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DiscoveryResult>();
  readonly onDidChange = this.emitter.event;
  private result: DiscoveryResult | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private watchers: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private refreshing: Promise<DiscoveryResult> | undefined;
  readonly lock: LockStore;
  githubSignedIn = false;
  private updates: Record<string, UpdateCheck>;
  updatesCheckedAt: string | undefined;
  agents: Record<string, AgentDetection> = {};
  readonly catalog = new CatalogStore(this);
  merges: MergeSuggestion[] = [];
  customizations: CustomizationItem[] = [];
  private toggles = new Map<string, SkillToggleState>();
  readonly hostAgent = hostAgentFor(vscode.env.appName);

  constructor(private readonly context: vscode.ExtensionContext) {
    this.lock = new LockStore(path.join(this.storageDir, 'skills-lock.json'));
    const cache = context.globalState.get<UpdateCache>(UPDATE_CACHE_KEY);
    this.updates = cache?.results ?? {};
    this.updatesCheckedAt = cache?.checkedAt;
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (RELATED_SETTINGS.some((setting) => event.affectsConfiguration(setting))) this.scheduleRefresh();
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.scheduleRefresh(REFRESH_ON_FOCUS_DELAY_MS);
      }),
    );
  }

  get storageDir(): string {
    return this.context.globalStorageUri.fsPath;
  }
  get stagingDir(): string {
    return path.join(this.storageDir, 'staging');
  }
  get backupDir(): string {
    return path.join(this.storageDir, 'backups');
  }

  get current(): DiscoveryResult | undefined {
    return this.result;
  }

  adapters(): ProviderAdapter[] {
    const enabledIds = vscode.workspace.getConfiguration('skillsManager').get<string[]>('providers');
    if (!enabledIds || enabledIds.length === 0) return BUILTIN_PROVIDERS;
    return BUILTIN_PROVIDERS.filter((provider) => enabledIds.includes(provider.id));
  }

  discoveryContext(): DiscoveryContext {
    const localFolders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
    return {
      homeDir: os.homedir(),
      workspaceFolders: localFolders.map((folder) => folder.uri.fsPath),
      platform: process.platform,
      copilotParentRepo: vscode.workspace.getConfiguration('chat').get<boolean>('useCustomizationsInParentRepositories') === true,
    };
  }

  /** `skillsManager.extraLocations`, with `~` and workspace-relative paths resolved. */
  private extraLocations(context: DiscoveryContext): Array<ReadLocation & { readers: string[] }> {
    const settings = vscode.workspace.getConfiguration('skillsManager').get<ExtraLocationSetting[]>('extraLocations') ?? [];
    const locations: Array<ReadLocation & { readers: string[] }> = [];
    for (const setting of settings) {
      if (!setting || typeof setting.path !== 'string' || !setting.path.trim()) continue;
      let locationPath = setting.path.trim();
      if (locationPath.startsWith('~')) locationPath = path.join(context.homeDir, locationPath.slice(1));
      const firstFolder = context.workspaceFolders[0];
      if (!path.isAbsolute(locationPath) && firstFolder) locationPath = path.join(firstFolder, locationPath);
      const hasReaders = Array.isArray(setting.readers) && setting.readers.length > 0;
      locations.push({
        path: locationPath,
        scope: setting.scope === 'workspace' ? 'workspace' : 'global',
        readers: hasReaders ? setting.readers! : ['custom'],
      });
    }
    return locations;
  }

  private discoverOptions(context: DiscoveryContext): DiscoverOptions {
    const settings = vscode.workspace.getConfiguration('skillsManager');
    return {
      lock: this.lock,
      extraLocations: this.extraLocations(context),
      workspaceReadOnlyReason: vscode.workspace.isTrusted ? undefined : UNTRUSTED_WORKSPACE_REASON,
      monorepo: { parents: settings.get<boolean>('scanParentFolders', true), nested: settings.get<boolean>('scanNestedFolders', true) },
      plugins: settings.get<boolean>('scanPlugins', true) ? { pluginsRoot: process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR } : undefined,
    };
  }

  private detectInstalledAgents(context: DiscoveryContext, adapters: ProviderAdapter[]): Promise<Record<string, AgentDetection>> {
    return detectAgents(
      adapters.map((adapter) => adapter.id),
      {
        homeDir: context.homeDir,
        platform: context.platform,
        pathDirs: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
        extensionIds: vscode.extensions.all.map((extension) => extension.id),
        hostAgent: this.hostAgent,
      },
    ).catch(() => ({}));
  }

  private async readToggles(result: DiscoveryResult, context: DiscoveryContext): Promise<Map<string, SkillToggleState>> {
    const entries = await Promise.all(
      result.skills.map(async (skill) => {
        const workspaceFolder = skill.scope === 'workspace' ? this.location(skill.locationId, result)?.workspaceFolder : context.workspaceFolders[0];
        const state = await readToggleState(skill, toggleFiles(context.homeDir, workspaceFolder)).catch(() => undefined);
        return [skill.id, state] as const;
      }),
    );
    return new Map(entries.filter((entry): entry is readonly [string, SkillToggleState] => !!entry[1]));
  }

  async refresh(): Promise<DiscoveryResult> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.lock.load();
      const context = { ...this.discoveryContext(), claudeSyncBucket: await readClaudeSyncBucket(os.homedir()) };
      const adapters = this.adapters();
      const [result, agents] = await Promise.all([discover(context, adapters, this.discoverOptions(context)), this.detectInstalledAgents(context, adapters)]);
      this.agents = agents;
      this.customizations = await readCustomizations(this.customizationInput(context)).catch(() => []);
      const installedAgents = Object.entries(agents).filter(([, detection]) => detection.installed).map(([agentId]) => agentId);
      this.merges = await mergeSuggestions(result.skills, result.locations, { relevantAgents: installedAgents }).catch(() => []);
      this.toggles = await this.readToggles(result, context);
      this.result = result;
      this.rewatch(result.locations);
      this.emitter.fire(result);
      return result;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  scheduleRefresh(delayMs = DEFAULT_REFRESH_DELAY_MS): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch((error) => console.error('[skills-manager] refresh failed', error));
    }, delayMs);
  }

  private watch(watcher: vscode.FileSystemWatcher, events: { change: boolean }): void {
    const refresh = () => this.scheduleRefresh();
    watcher.onDidCreate(refresh);
    watcher.onDidDelete(refresh);
    if (events.change) watcher.onDidChange(refresh);
    this.watchers.push(watcher);
  }

  private rewatch(locations: ResolvedLocation[]): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    for (const location of locations.filter((candidate) => candidate.exists)) {
      this.watch(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(location.path), '**/*')), { change: true });
    }
    this.watch(vscode.workspace.createFileSystemWatcher(NEW_SKILL_GLOB), { change: false });
  }

  skill(id: string): SkillRecord | undefined {
    return this.result?.skills.find((skill) => skill.id === id);
  }

  location(id: string, result = this.result): ResolvedLocation | undefined {
    return result?.locations.find((location) => location.id === id);
  }

  providerName(id: string): string {
    return BUILTIN_PROVIDERS.find((provider) => provider.id === id)?.displayName ?? id;
  }

  /** Display names of agents, comma-separated; `whenEmpty` when there are none. */
  agentNames(ids: string[], whenEmpty = 'none', separator = ', '): string {
    return ids.map((id) => this.providerName(id)).join(separator) || whenEmpty;
  }

  /** Provenance usable for updates: our lock first, else what `gh skill` wrote. */
  tracked(skill: SkillRecord): TrackedSource | undefined {
    return skill.source ? trackedFromLock(skill.source) : skill.ghSource;
  }

  /** Skills an update can be applied to in place (real folders directly inside a writable location). */
  updatable(): Array<{ skill: SkillRecord; source: TrackedSource }> {
    const updatable: Array<{ skill: SkillRecord; source: TrackedSource }> = [];
    for (const skill of this.result?.skills ?? []) {
      const source = this.tracked(skill);
      if (source && !skill.isSymlink && !skill.managed) updatable.push({ skill, source });
    }
    return updatable;
  }

  updateFor(skill: SkillRecord): UpdateCheck | undefined {
    const cached = this.updates[pathKey(skill.dir)];
    const source = this.tracked(skill);
    if (!cached || !source || cached.status === 'pinned' || cached.status === 'error') return cached;
    // A cached result is only valid for the version it was computed against.
    return cached.basis === basisOf(source) ? cached : undefined;
  }

  async storeUpdates(results: Record<string, UpdateCheck>, replace: boolean): Promise<void> {
    const byPathKey: Record<string, UpdateCheck> = {};
    for (const [dir, check] of Object.entries(results)) byPathKey[pathKey(dir)] = check;
    this.updates = replace ? byPathKey : { ...this.updates, ...byPathKey };
    if (replace) this.updatesCheckedAt = new Date().toISOString();
    await this.context.globalState.update(UPDATE_CACHE_KEY, { checkedAt: this.updatesCheckedAt, results: this.updates } satisfies UpdateCache);
    if (this.result) this.emitter.fire(this.result);
  }

  /** What readCustomizations / mcpTargets need, for this editor. */
  customizationInput(context: { homeDir: string; workspaceFolders: string[]; platform: NodeJS.Platform } = this.current!.context): CustomizationInput {
    // VS Code keeps the profile's mcp.json next to globalStorage (User/mcp.json); Cursor uses ~/.cursor/mcp.json.
    const vscodeProfileDir = this.hostAgent === 'copilot' ? path.dirname(path.dirname(this.storageDir)) : undefined;
    return {
      homeDir: context.homeDir,
      workspaceFolders: context.workspaceFolders,
      platform: context.platform,
      vscodeUserMcp: vscodeProfileDir ? path.join(vscodeProfileDir, 'mcp.json') : undefined,
      vscodeUserDir: vscodeProfileDir,
      copilotNestedAgentsMd: vscode.workspace.getConfiguration('chat').get<boolean>('useNestedAgentsMdFiles') === true,
      codexHome: process.env.CODEX_HOME,
    };
  }

  private viewSkill(skill: SkillRecord, home: string): ViewSkill {
    const lockSource = skill.source;
    return {
      id: skill.id,
      name: skill.name,
      dirName: skill.dirName,
      description: skill.description,
      dir: skill.dir,
      displayDir: tildify(skill.dir, home),
      realDir: skill.isSymlink ? tildify(skill.realDir, home) : '',
      isSymlink: skill.isSymlink,
      locationId: skill.locationId,
      locationLabel: this.location(skill.locationId)?.label ?? '',
      scope: skill.scope,
      visibleTo: skill.visibleTo,
      frontmatter: Object.entries(skill.frontmatter).map(([key, value]) => [key, displayValue(value)] as [string, string]),
      issues: skill.issues,
      readOnly: skill.readOnly,
      readOnlyReason: skill.readOnlyReason,
      managed: skill.managed,
      namespace: skill.namespace,
      group: skill.group,
      toggles: this.toggles.get(skill.id),
      contentId: skill.contentId,
      source: lockSource ? { url: lockSource.source.url, ref: lockSource.source.ref, commit: lockSource.source.commit, installedAt: lockSource.installedAt } : undefined,
      sourceHint: skill.sourceHint,
      tracked: this.tracked(skill)?.origin,
      fixes: fixesFor(skill, this.location(skill.locationId)).map(({ id, codes, label, detail }) => ({ id, codes, label, detail })),
      update: this.viewUpdate(skill),
      skillMdLines: skill.skillMdLines,
    };
  }

  /** The absolute path stays in the host: the webview gets an index id and a `~` path. */
  private viewCustomization(item: CustomizationItem, index: number, home: string): ViewCustomization {
    const canBeDeleted = item.kind !== 'mcp' && item.kind !== 'instructions' && item.scope !== 'admin';
    const { path: absolutePath, ...visible } = item;
    return { ...visible, id: String(index), displayPath: tildify(absolutePath, home), deletable: canBeDeleted };
  }

  private viewMcpDuplicateFile(fileKey: string, home: string): string {
    const isLocalScope = fileKey.endsWith(LOCAL_SCOPE_MARKER);
    const file = isLocalScope ? fileKey.slice(0, -LOCAL_SCOPE_MARKER.length) : fileKey;
    return tildify(file, home) + (isLocalScope ? ' (local)' : '');
  }

  viewState(): ViewState | undefined {
    const result = this.result;
    if (!result) return undefined;
    const home = result.context.homeDir;
    return {
      scannedAt: result.scannedAt,
      updatesCheckedAt: this.updatesCheckedAt,
      buildId: __BUILD_ID__,
      host: { appName: vscode.env.appName, agentId: this.hostAgent },
      agents: this.agents,
      customizations: {
        items: this.customizations.map((item, index) => this.viewCustomization(item, index, home)),
        mcpDuplicates: mcpDuplicates(this.customizations).map((duplicate) => ({
          ...duplicate,
          files: duplicate.files.map((fileKey) => this.viewMcpDuplicateFile(fileKey, home)),
        })),
      },
      merges: this.merges.map((merge) => ({
        ...merge,
        copies: merge.copies.map((copy) => ({
          skillId: copy.skillId,
          displayDir: tildify(copy.dir, home),
          locationLabel: copy.locationLabel,
          readers: copy.readers,
          writable: copy.writable,
          version: copy.version,
          modifiedAt: copy.modifiedAt,
          changedFiles: copy.diff ? copy.diff.added.length + copy.diff.modified.length + copy.diff.removed.length : 0,
        })),
      })),
      trusted: vscode.workspace.isTrusted,
      githubSignedIn: this.githubSignedIn,
      hasWorkspace: result.context.workspaceFolders.length > 0,
      providers: result.providers,
      locations: result.locations,
      skills: result.skills.map((skill) => this.viewSkill(skill, home)),
    };
  }

  private viewUpdate(skill: SkillRecord): ViewSkill['update'] {
    const check = this.updateFor(skill);
    if (!check) return undefined;
    return { status: check.status, remoteCommit: check.remoteCommit, message: check.message, checkedAt: check.checkedAt };
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const watcher of this.watchers) watcher.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function truncate(text: string): string {
  return text.length > MAX_FRONTMATTER_VALUE_LENGTH ? text.slice(0, MAX_FRONTMATTER_VALUE_LENGTH) + '…' : text;
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return truncate(value);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
