/**
 * Core domain types. Nothing in src/core may import 'vscode', so the whole
 * engine (discovery, validation, GitHub install, uninstall) is testable in
 * plain Node.
 */

export type Scope = 'workspace' | 'global' | 'admin';

/** Provider ids. Kept as string so new adapters don't require a core change. */
export type ProviderId = string;

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
}

/** What a provider adapter declares: "I load skills from this directory". */
export interface ReadLocation {
  path: string;
  scope: Scope;
  /** Optional human label; defaults to a ~-relative path. */
  label?: string;
  readOnly?: boolean;
  readOnlyReason?: string;
  workspaceFolder?: string;
  /**
   * Sub-directories of this root that hold skills one level deeper and are
   * managed by something else (e.g. ~/.claude/skills/synced). Value is the
   * read-only reason shown to the user.
   */
  managedSubdirs?: Record<string, string>;
  /** 'parent': above the workspace folder, up to the repo root. 'nested': below it. */
  origin?: 'parent' | 'nested' | 'plugin';
  /** For nested folders: the sub-folder (relative to the workspace folder) the skills belong to. */
  appliesTo?: string;
  /** Skills here are invoked as `<namespace>:<name>` (plugin skills), so they never clash by name. */
  namespace?: string;
}

export interface SkippedSyncBucket {
  /** Folder name: `<organizationUuid>_<accountUuid>`. */
  bucket: string;
  path: string;
  skills: string[];
  /** From the bucket's manifest.json, when readable. */
  lastSynced?: string;
}

export interface DiscoveryContext {
  homeDir: string;
  workspaceFolders: string[];
  platform: NodeJS.Platform;
  /** Workspace folder → enclosing git repository root, when it is a sub-folder of one. */
  repoRoots?: Record<string, string>;
  /** Workspace folder → relative sub-folders containing nested skills folders. */
  nestedDirs?: Record<string, string[]>;
  /** Skill roots of enabled Claude Code plugins (see plugins.ts). */
  claudePlugins?: ReadLocation[];
  /** VS Code `chat.useCustomizationsInParentRepositories`. */
  copilotParentRepo?: boolean;
  /** `<org>_<account>` of the signed-in claude.ai account: other accounts' synced buckets are skipped. */
  claudeSyncBucket?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** Link to the official doc the locations were validated against. */
  docsUrl: string;
  /** Every directory this provider loads skills from (documented behaviour only). */
  readLocations(ctx: DiscoveryContext): ReadLocation[];
  /** Short note about how enable/disable works for this provider (shown in UI). */
  disableHint?: string;
  /** Nested skills get their own namespace (Claude Code: /apps/web:deploy), so same names don't clash. */
  namespacesNested?: boolean;
  /** Finds SKILL.md in sub-folders of a skills root too (Cursor: skills/<group>/<skill>/SKILL.md). */
  recursiveRoots?: boolean;
}

/** A skills root after merging what all adapters declared. */
export interface ResolvedLocation {
  id: string;
  path: string;
  label: string;
  scope: Scope;
  readers: ProviderId[];
  readOnly: boolean;
  readOnlyReason?: string;
  workspaceFolder?: string;
  managedSubdirs?: Record<string, string>;
  origin?: 'parent' | 'nested' | 'plugin';
  appliesTo?: string;
  /** Readers that also load skills from category sub-folders of this root. */
  recursiveReaders?: ProviderId[];
  namespace?: string;
  exists: boolean;
  skillCount: number;
  /** Entries in the folder that agents will ignore (no SKILL.md, etc). */
  ignoredEntries: string[];
  /** Skills synced for other claude.ai accounts, not loaded by Claude Code and not listed. */
  skippedSynced?: number;
  /** Detail of those leftovers, one entry per other-account bucket. */
  skippedSyncedBuckets?: SkippedSyncBucket[];
  /** The signed-in account's bucket, when known. */
  activeSyncBucket?: { bucket: string; lastSynced?: string };
}

export interface GitHubSource {
  type: 'github';
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  subpath: string;
  treeSha?: string;
  url: string;
}

/** Provenance precise enough to check for updates. */
export interface TrackedSource {
  origin: 'lock' | 'gh-skill';
  owner: string;
  repo: string;
  ref: string;
  subpath: string;
  treeSha?: string;
  commit?: string;
  /** Installed from a commit SHA (or `gh skill --pin`): never offered updates. */
  pinned: boolean;
}

export interface LockEntry {
  name: string;
  dir: string;
  locationPath: string;
  source: GitHubSource;
  installedAt: string;
  contentHash: string;
  fileCount: number;
}

export interface SkillRecord {
  id: string;
  name: string;
  dirName: string;
  description?: string;
  /** Path as found inside the location (may be a symlink). */
  dir: string;
  /** Resolved target when `dir` is a symlink. */
  realDir: string;
  isSymlink: boolean;
  skillFile: string;
  locationId: string;
  scope: Scope;
  visibleTo: ProviderId[];
  frontmatter: Record<string, unknown>;
  issues: Issue[];
  readOnly: boolean;
  readOnlyReason?: string;
  /** Name of the managed sub-folder it was found in (e.g. 'synced'). */
  managed?: string;
  /** Content fingerprint, computed only when another folder has a skill with the same name. */
  contentId?: string;
  /** Category folder it sits in (skills/<group>/<skill>); only recursive readers load it. */
  group?: string;
  /** Invoked as `<namespace>:<name>` (plugin skills). */
  namespace?: string;
  source?: LockEntry;
  /** Hint found in frontmatter metadata (e.g. written by `gh skill`). */
  sourceHint?: string;
  /** Provenance written by `gh skill install`, when present and valid. */
  ghSource?: TrackedSource;
  skillMdBytes: number;
  skillMdLines: number;
}

export interface ProviderSummary {
  id: ProviderId;
  displayName: string;
  docsUrl: string;
  disableHint?: string;
  visibleSkills: number;
  duplicateNames: string[];
}

export interface DiscoveryResult {
  scannedAt: string;
  context: DiscoveryContext;
  locations: ResolvedLocation[];
  skills: SkillRecord[];
  providers: ProviderSummary[];
}

export class UserError extends Error {
  constructor(message: string, readonly code = 'user-error') {
    super(message);
    this.name = 'UserError';
  }
}
