/**
 * Messages between the extension host and the dashboard webview.
 * Only plain JSON crosses this boundary; no tokens or secrets ever do.
 */
import type { Finding } from '../core/inspector';
import type { Issue, ProviderSummary, ResolvedLocation, Scope } from '../core/types';
import type { UpdateStatus } from '../core/updates';

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
  source?: { url: string; ref: string; commit: string; installedAt: string };
  sourceHint?: string;
  /** Where update information comes from, when the skill is tracked. */
  tracked?: 'lock' | 'gh-skill';
  update?: { status: UpdateStatus; remoteCommit?: string; message?: string; checkedAt: string };
  skillMdLines: number;
}

export interface ViewState {
  scannedAt: string;
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
  | { type: 'error'; op: string; message: string; code?: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'getDetail'; skillId: string }
  | { type: 'openSkillFile'; skillId: string; rel?: string }
  | { type: 'reveal'; skillId: string }
  | { type: 'copyPath'; skillId: string }
  | { type: 'uninstall'; skillId: string }
  | { type: 'copyMove'; skillId: string }
  | { type: 'checkUpdates' }
  | { type: 'update'; skillId: string }
  | { type: 'inspect'; url: string }
  | { type: 'stage'; candidateIds: string[] }
  | { type: 'install'; locationId: string }
  | { type: 'cancelInstall' }
  | { type: 'signIn'; privateRepos: boolean }
  | { type: 'openDocs'; providerId: string };
