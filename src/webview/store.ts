/* Dashboard webview — store. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { ViewCatalogSkill, ViewCatalogSource, ViewInspection, ViewSkillDetail, ViewStaged, ViewState, WebviewToHost } from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };

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
  q: string;
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
  catalogQ?: string;
}

export const persisted: Persisted = { tab: 'overview', q: '', provider: 'all', status: 'all', url: '', ...((api.getState() as Partial<Persisted>) ?? {}) };
// State saved by v0.2.0 had a single 'skills' tab.
if ((persisted.tab as string) === 'skills') persisted.tab = 'project';

export const busy = new Set<string>();

export const errors: Record<string, string | undefined> = {};

export const install = {
  phase: 'idle' as 'idle' | 'inspected' | 'staged' | 'done',
  inspection: null as ViewInspection | null,
  selected: new Set<string>(),
  expanded: new Set<string>(),
  staged: null as ViewStaged[] | null,
  targetId: '',
  done: null as { names: string[]; locationLabel: string } | null,
};

export const save = () => api.setState(persisted);

export const send = (m: WebviewToHost) => api.postMessage(m);

export const INSTALL_OPS = new Set(['inspect', 'stage', 'install', 'catalogList', 'catalogSearch']);

/** Catalog data received from the host (Install → Browse). */
export const catalog = {
  sources: [] as ViewCatalogSource[],
  bySource: new Map<string, { skills: ViewCatalogSkill[]; truncated: boolean }>(),
  results: null as { query: string; skills: ViewCatalogSkill[] } | null,
};

