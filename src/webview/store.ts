/* Dashboard webview — store. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { ViewCatalogSkill, ViewCatalogSource, ViewInspection, ViewSkillDetail, ViewStaged, ViewState, WebviewToHost } from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

export const api = acquireVsCodeApi();

/** Shared mutable view state (modules can't reassign each other's bindings). */
export const ui = {
  state: null as ViewState | null,
  detail: null as ViewSkillDetail | null,
  requestedDetail: undefined as string | undefined,
  /** Set when the extension host is from another build (installed over without reloading). */
  staleHost: false,
};

export type Tab = 'overview' | 'project' | 'global' | 'map' | 'config' | 'install';

export type SkillsTab = 'project' | 'global';

export interface Persisted {
  tab: Tab;
  /** Text typed in the skills search box. */
  searchQuery: string;
  provider: string;
  status: string;
  selected?: string;
  url: string;
  /** Also show agents that weren't detected on this machine. */
  showAllAgents?: boolean;
  mapScope?: 'project' | 'global';
  showEmptyFolders?: boolean;
  installMode?: 'browse' | 'url';
  catalogSource?: string;
  /** Text typed in the catalog search box. */
  catalogQuery?: string;
  /** Source bundles (plugins, claude.ai, collections) expanded in the skills list. */
  openBundles?: string[];
  /** Show every skill on its own instead of grouped by where it came from. */
  flatList?: boolean;
}

/** Earlier versions saved some fields under other names. */
function migrateSavedState(saved: Record<string, unknown>): Partial<Persisted> {
  const migrated = { ...saved };
  if (migrated['tab'] === 'skills') migrated['tab'] = 'project';
  if (typeof migrated['q'] === 'string' && migrated['searchQuery'] === undefined) migrated['searchQuery'] = migrated['q'];
  if (typeof migrated['catalogQ'] === 'string' && migrated['catalogQuery'] === undefined) migrated['catalogQuery'] = migrated['catalogQ'];
  delete migrated['q'];
  delete migrated['catalogQ'];
  return migrated as Partial<Persisted>;
}

const savedState = (api.getState() as Record<string, unknown> | undefined) ?? {};
export const persisted: Persisted = { tab: 'overview', searchQuery: '', provider: 'all', status: 'all', url: '', ...migrateSavedState(savedState) };

export const busy = new Set<string>();

export const errors: Record<string, string | undefined> = {};

export const install = {
  phase: 'idle' as 'idle' | 'inspected' | 'staged' | 'done',
  inspection: null as ViewInspection | null,
  selected: new Set<string>(),
  expanded: new Set<string>(),
  staged: null as ViewStaged[] | null,
  targetId: '',
  /** "Choose another folder…" expanded. */
  showAllTargets: false,
  done: null as { names: string[]; locationLabel: string } | null,
};

export const save = () => api.setState(persisted);

export const send = (message: WebviewToHost) => api.postMessage(message);

export const INSTALL_OPS = new Set(['inspect', 'stage', 'install', 'catalogList', 'catalogSearch']);

/** Catalog data received from the host (Install → Browse). */
export const catalog = {
  sources: [] as ViewCatalogSource[],
  bySource: new Map<string, { skills: ViewCatalogSkill[]; truncated: boolean }>(),
  results: null as { query: string; skills: ViewCatalogSkill[] } | null,
};

