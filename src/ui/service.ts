import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { discover, DiscoverOptions } from '../core/discovery';
import { LockStore } from '../core/lockfile';
import { BUILTIN_PROVIDERS } from '../core/providers';
import { pathKey, tildify } from '../core/paths';
import { trackedFromLock } from '../core/provenance';
import { basisOf, type UpdateCheck } from '../core/updates';
import type { DiscoveryContext, DiscoveryResult, ProviderAdapter, ReadLocation, ResolvedLocation, SkillRecord, TrackedSource } from '../core/types';
import type { ViewSkill, ViewState } from '../shared/protocol';

/** Owns the current scan result, file watching and storage paths. */
export class SkillsService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DiscoveryResult>();
  readonly onDidChange = this.emitter.event;
  private result: DiscoveryResult | undefined;
  private timer: NodeJS.Timeout | undefined;
  private watchers: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private refreshing: Promise<DiscoveryResult> | undefined;
  readonly lock: LockStore;
  githubSignedIn = false;
  private updates: Record<string, UpdateCheck>;
  updatesCheckedAt: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.lock = new LockStore(path.join(this.storageDir, 'skills-lock.json'));
    const cache = context.globalState.get<UpdateCache>(UPDATE_CACHE_KEY);
    this.updates = cache?.results ?? {};
    this.updatesCheckedAt = cache?.checkedAt;
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('skillsManager') || e.affectsConfiguration('chat.useCustomizationsInParentRepositories')) this.scheduleRefresh();
      }),
      // Global folders outside the workspace can appear at any time (another tool installed something).
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.scheduleRefresh(800);
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
    const enabled = vscode.workspace.getConfiguration('skillsManager').get<string[]>('providers');
    if (!enabled || enabled.length === 0) return BUILTIN_PROVIDERS;
    return BUILTIN_PROVIDERS.filter((p) => enabled.includes(p.id));
  }

  context_(): DiscoveryContext {
    return {
      homeDir: os.homedir(),
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
      platform: process.platform,
      copilotParentRepo: vscode.workspace.getConfiguration('chat').get<boolean>('useCustomizationsInParentRepositories') === true,
    };
  }

  private options(ctx: DiscoveryContext): DiscoverOptions {
    const cfg = vscode.workspace.getConfiguration('skillsManager');
    const raw = cfg.get<Array<{ path: string; scope?: string; readers?: string[] }>>('extraLocations') ?? [];
    const extra: Array<ReadLocation & { readers: string[] }> = [];
    for (const e of raw) {
      if (!e || typeof e.path !== 'string' || !e.path.trim()) continue;
      let p = e.path.trim();
      if (p.startsWith('~')) p = path.join(ctx.homeDir, p.slice(1));
      if (!path.isAbsolute(p) && ctx.workspaceFolders[0]) p = path.join(ctx.workspaceFolders[0], p);
      extra.push({
        path: p,
        scope: e.scope === 'workspace' ? 'workspace' : 'global',
        readers: Array.isArray(e.readers) && e.readers.length ? e.readers : ['custom'],
      });
    }
    return {
      lock: this.lock,
      extraLocations: extra,
      workspaceReadOnlyReason: vscode.workspace.isTrusted ? undefined : 'Workspace is not trusted (Restricted Mode).',
      monorepo: { parents: cfg.get<boolean>('scanParentFolders', true), nested: cfg.get<boolean>('scanNestedFolders', true) },
    };
  }

  async refresh(): Promise<DiscoveryResult> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.lock.load();
      const ctx = this.context_();
      const result = await discover(ctx, this.adapters(), this.options(ctx));
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

  scheduleRefresh(delay = 300): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.refresh().catch((e) => console.error('[skills-manager] refresh failed', e));
    }, delay);
  }

  private rewatch(locations: ResolvedLocation[]): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    for (const loc of locations) {
      if (!loc.exists) continue;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(loc.path), '**/*'));
      const fire = () => this.scheduleRefresh();
      w.onDidCreate(fire);
      w.onDidDelete(fire);
      w.onDidChange(fire);
      this.watchers.push(w);
    }
    // Detect skills folders being created inside the workspace.
    const ws = vscode.workspace.createFileSystemWatcher('**/{.claude,.cursor,.agents,.codex,.github}/skills/*/SKILL.md');
    ws.onDidCreate(() => this.scheduleRefresh());
    ws.onDidDelete(() => this.scheduleRefresh());
    this.watchers.push(ws);
  }

  skill(id: string): SkillRecord | undefined {
    return this.result?.skills.find((s) => s.id === id);
  }

  location(id: string): ResolvedLocation | undefined {
    return this.result?.locations.find((l) => l.id === id);
  }

  providerName(id: string): string {
    return BUILTIN_PROVIDERS.find((p) => p.id === id)?.displayName ?? id;
  }

  /** Provenance usable for updates: our lock first, else what `gh skill` wrote. */
  tracked(s: SkillRecord): TrackedSource | undefined {
    return s.source ? trackedFromLock(s.source) : s.ghSource;
  }

  /** Skills an update can be applied to in place (real folders directly inside a writable location). */
  updatable(): Array<{ skill: SkillRecord; source: TrackedSource }> {
    const out: Array<{ skill: SkillRecord; source: TrackedSource }> = [];
    for (const skill of this.result?.skills ?? []) {
      const source = this.tracked(skill);
      if (source && !skill.isSymlink && !skill.managed) out.push({ skill, source });
    }
    return out;
  }

  updateFor(s: SkillRecord): UpdateCheck | undefined {
    const u = this.updates[pathKey(s.dir)];
    const src = this.tracked(s);
    // A cached result is only valid for the version it was computed against.
    if (!u || !src || u.status === 'pinned' || u.status === 'error') return u;
    return u.basis === basisOf(src) ? u : undefined;
  }

  async storeUpdates(results: Record<string, UpdateCheck>, replace: boolean): Promise<void> {
    const keyed: Record<string, UpdateCheck> = {};
    for (const [dir, r] of Object.entries(results)) keyed[pathKey(dir)] = r;
    this.updates = replace ? keyed : { ...this.updates, ...keyed };
    if (replace) this.updatesCheckedAt = new Date().toISOString();
    await this.context.globalState.update(UPDATE_CACHE_KEY, { checkedAt: this.updatesCheckedAt, results: this.updates } satisfies UpdateCache);
    if (this.result) this.emitter.fire(this.result);
  }

  viewState(): ViewState | undefined {
    const r = this.result;
    if (!r) return undefined;
    const home = r.context.homeDir;
    const skills: ViewSkill[] = r.skills.map((s) => ({
      id: s.id,
      name: s.name,
      dirName: s.dirName,
      description: s.description,
      dir: s.dir,
      displayDir: tildify(s.dir, home),
      realDir: s.isSymlink ? tildify(s.realDir, home) : '',
      isSymlink: s.isSymlink,
      locationId: s.locationId,
      locationLabel: this.location(s.locationId)?.label ?? '',
      scope: s.scope,
      visibleTo: s.visibleTo,
      frontmatter: Object.entries(s.frontmatter).map(([k, v]) => [k, stringifyValue(v)] as [string, string]),
      issues: s.issues,
      readOnly: s.readOnly,
      readOnlyReason: s.readOnlyReason,
      source: s.source
        ? { url: s.source.source.url, ref: s.source.source.ref, commit: s.source.source.commit, installedAt: s.source.installedAt }
        : undefined,
      sourceHint: s.sourceHint,
      tracked: this.tracked(s)?.origin,
      update: this.viewUpdate(s),
      skillMdLines: s.skillMdLines,
    }));
    return {
      scannedAt: r.scannedAt,
      updatesCheckedAt: this.updatesCheckedAt,
      trusted: vscode.workspace.isTrusted,
      githubSignedIn: this.githubSignedIn,
      hasWorkspace: r.context.workspaceFolders.length > 0,
      providers: r.providers,
      locations: r.locations,
      skills,
    };
  }

  private viewUpdate(s: SkillRecord): ViewSkill['update'] {
    const u = this.updateFor(s);
    if (!u) return undefined;
    return { status: u.status, remoteCommit: u.remoteCommit, message: u.message, checkedAt: u.checkedAt };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers) w.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

const UPDATE_CACHE_KEY = 'skillsManager.updateCache';

interface UpdateCache {
  checkedAt?: string;
  results: Record<string, UpdateCheck>;
}

function stringifyValue(v: unknown): string {
  if (typeof v === 'string') return v.length > 600 ? v.slice(0, 600) + '…' : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 600 ? s.slice(0, 600) + '…' : s;
  } catch {
    return String(v);
  }
}
