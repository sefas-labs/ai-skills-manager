/**
 * Messages between the extension host and the dashboard webview.
 * Only plain JSON crosses this boundary; no tokens or secrets ever do.
 */
import type { Finding } from '../core/inspector';
import type { Issue, ProviderSummary, ResolvedLocation, Scope } from '../core/types';
import type { UpdateStatus } from '../core/updates';
import type { AgentDetection } from '../core/agents';

export interface ViewSkill {
  id: string;
  name: string;
  dirName: string;
  description?: string;
  dir: string;
  displayDir: string;
  realDir: string;
  isSymlink: boolean;
  locationId: string;
  locationLabel: string;
  scope: Scope;
  visibleTo: string[];
  frontmatter: Array<[string, string]>;
  issues: Issue[];
  readOnly: boolean;
  readOnlyReason?: string;
  /** Managed sub-folder it lives in (e.g. 'synced' for claude.ai). */
  managed?: string;
  /** Invoked as `<namespace>:<name>` (Claude Code plugin skills). */
  namespace?: string;
  /** Category folder (skills/<group>/<skill>) — only Cursor finds it. */
  group?: string;
  /** Per-agent switches (each agent's own mechanism). */
  toggles?: {
    claude?: { value: 'on' | 'name-only' | 'user-invocable-only' | 'off'; from?: 'user' | 'project' | 'local' };
    codex?: { enabled: boolean };
    modelInvocation: boolean;
    userInvocable: boolean;
  };
  /** Content fingerprint (only when another folder has the same name). */
  contentId?: string;
  source?: { url: string; ref: string; commit: string; installedAt: string };
  sourceHint?: string;
  /** Where update information comes from, when the skill is tracked. */
  tracked?: 'lock' | 'gh-skill';
  /** Automatic fixes available for its issues. */
  fixes: Array<{ id: string; codes: string[]; label: string; detail: string }>;
  update?: { status: UpdateStatus; remoteCommit?: string; message?: string; checkedAt: string };
  skillMdLines: number;
}

export interface ViewCatalogSource {
  id: string;
  title: string;
  blurb: string;
}

export interface ViewCatalogSkill {
  sourceId: string;
  owner: string;
  repo: string;
  dir: string;
  name: string;
  description?: string;
  url: string;
  /** Already on this machine: from the same GitHub folder, or only a skill with the same name. */
  installed?: 'same-source' | 'same-name';
  installedIn: string[];
}

export interface ViewMerge {
  id: string;
  name: string;
  scope: Scope;
  verdict: 'remove-redundant' | 'unify-versions' | 'expected';
  identical: boolean;
  seenTwiceBy: string[];
  stillTwiceBy: string[];
  keep: string[];
  remove: string[];
  copies: Array<{
    skillId: string;
    displayDir: string;
    locationLabel: string;
    readers: string[];
    writable: boolean;
    version: number;
    modifiedAt?: string;
    changedFiles: number;
  }>;
}

export interface ViewCustomization {
  id: string;
  kind: 'instructions' | 'rule' | 'agent' | 'command' | 'mcp';
  displayPath: string;
  scope: 'project' | 'user' | 'local' | 'admin';
  agents: string[];
  title: string;
  description?: string;
  note?: string;
  servers?: Array<{ name: string; transport: string; command?: string; url?: string; envKeys: string[]; headerKeys: string[]; enabled: boolean }>;
  /** MCP files the extension can edit (entry format); 'codex' also supports enable/disable. */
  mcpFlavor?: string;
  readOnlyReason?: string;
  /** Rules, subagents and commands can be moved to the backup folder. */
  deletable?: boolean;
}

export interface ViewState {
  scannedAt: string;
  /** Build of the extension host; the webview compares it with its own. */
  buildId?: string;
  /** The editor we run in and the agent built into it (cursor / copilot). */
  host: { appName: string; agentId?: string };
  /** Which agents look installed on this machine, with the evidence found. */
  agents: Record<string, AgentDetection>;
  /** Duplicate skills that can be merged (same name, same scope). */
  merges: ViewMerge[];
  /** Instructions, rules, subagents, commands and MCP servers per agent (read-only). */
  customizations?: { items: ViewCustomization[]; mcpDuplicates: Array<{ agent: string; name: string; files: string[] }> };
  updatesCheckedAt?: string;
  trusted: boolean;
  githubSignedIn: boolean;
  hasWorkspace: boolean;
  providers: ProviderSummary[];
  locations: ResolvedLocation[];
  skills: ViewSkill[];
}

export interface ViewCandidate {
  id: string;
  repoDir: string;
  installName: string;
  name?: string;
  description?: string;
  fileCount: number;
  files: string[];
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
  issues: Issue[];
  findings: Finding[];
  skillMdPreview: string;
  installable: boolean;
  blockReason?: string;
}

export interface ViewInspection {
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  subpath: string;
  url: string;
  notes: string[];
  candidates: ViewCandidate[];
}

export interface ViewStaged {
  candidateId: string;
  installName: string;
  fileCount: number;
  bytes: number;
  findings: Finding[];
}

export interface ViewSkillDetail {
  id: string;
  body: string;
  files: string[];
  truncated: boolean;
}

export type HostToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'focus'; tab?: 'overview' | 'skills' | 'install'; skillId?: string; url?: string; autoInspect?: boolean }
  | { type: 'detail'; detail: ViewSkillDetail }
  | { type: 'inspection'; inspection: ViewInspection }
  | { type: 'staged'; staged: ViewStaged[] }
  | { type: 'installed'; names: string[]; locationLabel: string }
  | { type: 'installCancelled' }
  | { type: 'busy'; op: string; busy: boolean }
  | { type: 'catalogSources'; sources: ViewCatalogSource[] }
  | { type: 'catalogSkills'; sourceId: string; skills: ViewCatalogSkill[]; truncated: boolean }
  | { type: 'catalogResults'; query: string; skills: ViewCatalogSkill[] }
  | { type: 'error'; op: string; message: string; code?: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'reloadWindow' }
  | { type: 'clientError'; message: string }
  | { type: 'refresh' }
  | { type: 'getDetail'; skillId: string }
  | { type: 'openSkillFile'; skillId: string; rel?: string }
  | { type: 'reveal'; skillId: string }
  | { type: 'copyPath'; skillId: string }
  | { type: 'uninstall'; skillId: string }
  | { type: 'copyMove'; skillId: string }
  | { type: 'addToProject'; skillId: string }
  | { type: 'copyTo'; skillId: string; locationId: string }
  | { type: 'chooseCopy'; skillId: string }
  | { type: 'checkUpdates' }
  | { type: 'catalogList'; sourceId: string; force?: boolean }
  | { type: 'catalogSearch'; query: string }
  | { type: 'openUrl'; url: string }
  | { type: 'archiveSynced'; bucket: string }
  | { type: 'openCustomization'; id: string }
  | { type: 'newCustomization'; kind: 'rule' | 'agent' | 'command' }
  | { type: 'deleteCustomization'; id: string }
  | { type: 'mcpAdd' }
  | { type: 'mcpRemove'; id: string; name: string }
  | { type: 'mcpToggle'; id: string; name: string; enabled: boolean }
  | { type: 'setToggle'; skillId: string; agent: 'claude'; value: 'on' | 'name-only' | 'user-invocable-only' | 'off' }
  | { type: 'setToggle'; skillId: string; agent: 'codex'; enabled: boolean }
  | { type: 'setToggle'; skillId: string; agent: 'frontmatter'; mode: 'auto' | 'manual' | 'off' }
  | { type: 'merge'; suggestionId: string; action: 'apply' | 'compare' | 'unify'; skillId?: string }
  | { type: 'fix'; skillId: string; fixId?: string }
  | { type: 'update'; skillId: string }
  | { type: 'inspect'; url: string }
  | { type: 'stage'; candidateIds: string[] }
  | { type: 'install'; locationId: string }
  | { type: 'cancelInstall' }
  | { type: 'signIn'; privateRepos: boolean }
  | { type: 'openDocs'; providerId: string };
