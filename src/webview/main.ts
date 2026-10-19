/* Dashboard webview entry point: rendering shell and host messages. Vanilla
 * TypeScript + DOM, no framework: values from the host go in via textContent. */
import type { HostToWebview, ViewState } from '../shared/protocol';
import { INSTALL_OPS, type Persisted, type SkillsTab, type Tab, busy, catalog, errors, install, persisted, save, send, ui } from './store';
import { button, h, icon, skeleton } from './dom';
import { inTab, skillsView, tabOf } from './skills';
import { analyze, installView } from './install';
import { overview } from './overview';
import { mapView } from './map';
import { configView } from './config';

declare const __BUILD_ID__: string;

export const app = document.getElementById('app')!;

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'project', label: 'Project', icon: 'root-folder' },
  { id: 'global', label: 'Global', icon: 'home' },
  { id: 'map', label: 'Map', icon: 'type-hierarchy' },
  { id: 'config', label: 'Config', icon: 'settings-gear' },
  { id: 'install', label: 'Install', icon: 'cloud-download' },
];

/** Changes what is shown (tab, filters, toggles), remembers it and re-renders. */
export function changeView(changes: Partial<Persisted>): void {
  Object.assign(persisted, changes);
  save();
  render();
}

/** Never leave the user on "Scanning…": a render failure is shown, and reported to the host log. */
export function render(): void {
  try {
    renderView();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    app.removeAttribute('aria-busy');
    app.replaceChildren(
      h(
        'div',
        { class: 'panel empty' },
        h('h2', null, 'The dashboard hit an error'),
        h('p', { class: 'mono small' }, message),
        h('p', { class: 'muted' }, 'If you just installed or updated the extension, run “Developer: Reload Window”.'),
        button('Retry', () => send({ type: 'refresh' }), { kind: 'primary' }),
      ),
    );
    send({ type: 'clientError', message });
  }
}

/** Re-rendering replaces the DOM: this remembers scroll positions and keyboard focus, and puts them back. */
function preserveViewPosition(): () => void {
  // Elements tagged with data-scroll-key keep their scroll (same key = same content).
  const scrollByKey = new Map<string, number>();
  app.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((element) => scrollByKey.set(element.dataset.scrollKey!, element.scrollTop));
  const pageScroll = document.scrollingElement?.scrollTop ?? 0;
  // Keep focus (e.g. in the search box) across re-renders triggered by file changes.
  const focused = document.activeElement as HTMLInputElement | null;
  const focusedId = focused?.id;
  const selection = focused && 'selectionStart' in focused ? { start: focused.selectionStart, end: focused.selectionEnd } : null;

  return () => {
    app.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((element) => {
      const scrollTop = scrollByKey.get(element.dataset.scrollKey!);
      if (scrollTop) element.scrollTop = scrollTop;
    });
    if (document.scrollingElement) document.scrollingElement.scrollTop = pageScroll;
    const toFocus = focusedId ? (document.getElementById(focusedId) as HTMLInputElement | null) : null;
    if (!toFocus) return;
    toFocus.focus();
    if (selection && selection.start !== null) {
      try {
        toFocus.setSelectionRange(selection.start, selection.end);
      } catch {
        // Not a text input: nothing to restore.
      }
    }
  };
}

function banners(): Node[] {
  const shown: Node[] = [];
  if (ui.staleHost) {
    shown.push(
      h(
        'div',
        { class: 'banner warn' },
        h('strong', null, 'The extension was updated. '),
        'Reload the window so the dashboard and the extension use the same version — until then some buttons may do nothing. ',
        button('Reload Window', () => send({ type: 'reloadWindow' }), { kind: 'primary' }),
        h('span', { class: 'small muted' }, ' (or run “Developer: Reload Window”)'),
      ),
    );
  }
  if (ui.state && !ui.state.trusted) {
    shown.push(h('div', { class: 'banner warn' }, 'Restricted Mode: this workspace is not trusted, so workspace skills are read-only.'));
  }
  const generalError = errors['general'];
  if (generalError) {
    const dismiss = () => {
      errors['general'] = undefined;
      render();
    };
    shown.push(h('div', { class: 'banner error' }, generalError, ' ', button('Dismiss', dismiss, { kind: 'link' })));
  }
  return shown;
}

export function renderView(): void {
  app.removeAttribute('aria-busy');
  const restoreViewPosition = preserveViewPosition();
  app.replaceChildren(header(), ...banners(), h('main', { id: 'view' }, body()));
  restoreViewPosition();
}

function tabButton(tab: (typeof TABS)[number]): Node {
  const isActive = persisted.tab === tab.id;
  const isSkillsTab = tab.id === 'project' || tab.id === 'global';
  const count = isSkillsTab && ui.state ? ` (${inTab(tab.id as SkillsTab).length})` : '';
  return h(
    'button',
    { class: `tab ${isActive ? 'active' : ''}`, role: 'tab', 'aria-selected': isActive ? 'true' : 'false', onClick: () => changeView({ tab: tab.id }) },
    icon(tab.icon),
    h('span', { class: 'tab-label' }, tab.label + count),
  );
}

export function header() {
  const state = ui.state;
  const total = state?.skills.length ?? 0;
  const summary = state ? `${total} skill${total === 1 ? '' : 's'} · scanned ${new Date(state.scannedAt).toLocaleTimeString()}` : 'Scanning…';
  const editorChip = state?.host.agentId ? h('span', { class: 'chip host', title: 'Editor this dashboard runs in' }, state.host.appName) : null;
  return h(
    'header',
    { class: 'top' },
    h('div', { class: 'brand' }, h('div', { class: 'logo', 'aria-hidden': 'true' }), h('div', null, h('h1', null, 'AI Skills', editorChip), h('p', { class: 'muted small' }, summary))),
    h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(tabButton)),
    h('button', { class: `btn icon ${busy.has('refresh') ? 'spin' : ''}`, title: 'Rescan skill folders', 'aria-label': 'Refresh', onClick: () => send({ type: 'refresh' }) }, icon('refresh')),
  );
}

export function body(): Node {
  if (!ui.state) {
    return h(
      'div',
      { class: 'loading', 'aria-busy': 'true', 'aria-label': 'Scanning skill folders' },
      h('div', { class: 'panel hero' }, h('div', { class: 'sk-ring' }), skeleton(3)),
      h('div', { class: 'panel' }, skeleton(6)),
      h('p', { class: 'muted small center' }, 'Scanning skill folders…'),
    );
  }
  switch (persisted.tab) {
    case 'project':
    case 'global':
      return skillsView(persisted.tab);
    case 'install':
      return installView();
    case 'map':
      return mapView();
    case 'config':
      return configView();
    default:
      return overview();
  }
}

/** Tolerates a host from an older build (e.g. right after reinstalling without reloading): fills fields it didn't send. */
function normalizeState(state: ViewState): ViewState {
  return {
    ...state,
    host: state.host ?? { appName: '' },
    agents: state.agents ?? {},
    merges: state.merges ?? [],
    skills: state.skills.map((skill) => ({ ...skill, fixes: skill.fixes ?? [] })),
  };
}

function onState(state: ViewState): void {
  ui.staleHost = state.buildId !== __BUILD_ID__;
  ui.state = normalizeState(state);
  // Files may have changed on disk: refetch the open detail.
  if (ui.detail) ui.requestedDetail = undefined;
  const detailStillExists = !!ui.detail && ui.state.skills.some((skill) => skill.id === ui.detail!.id);
  if (!detailStillExists) ui.detail = null;
  const selectionStillExists = ui.state.skills.some((skill) => skill.id === persisted.selected);
  if (persisted.selected && !selectionStillExists) persisted.selected = undefined;
}

/** Returns true when the message already rendered (and render() must not run again). */
function onFocus(message: Extract<HostToWebview, { type: 'focus' }>): boolean {
  if (message.tab) persisted.tab = message.tab === 'skills' ? 'project' : message.tab;
  if (message.skillId) {
    const skill = ui.state?.skills.find((candidate) => candidate.id === message.skillId);
    if (skill) persisted.tab = tabOf(skill);
    persisted.selected = message.skillId;
    ui.detail = null;
    ui.requestedDetail = undefined;
    // Clear filters so the skill is visible.
    persisted.searchQuery = '';
    persisted.provider = 'all';
    persisted.status = 'all';
  }
  if (message.url) {
    persisted.url = message.url;
    persisted.installMode = 'url';
  }
  save();
  if (message.autoInspect && message.url) {
    render();
    analyze();
    return true;
  }
  return false;
}

function onInspection(inspection: NonNullable<typeof install.inspection>): void {
  install.inspection = inspection;
  install.phase = 'inspected';
  install.selected = new Set(inspection.candidates.filter((candidate) => candidate.installable).map((candidate) => candidate.id));
  install.expanded.clear();
  if (inspection.candidates.length === 1) install.expanded.add(inspection.candidates[0].id);
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'state':
      onState(message.state);
      break;
    case 'focus':
      if (onFocus(message)) return;
      break;
    case 'detail':
      ui.detail = message.detail;
      break;
    case 'catalogSources':
      catalog.sources = message.sources;
      break;
    case 'catalogSkills':
      catalog.bySource.set(message.sourceId, { skills: message.skills, truncated: message.truncated });
      break;
    case 'catalogResults':
      catalog.results = { query: message.query, skills: message.skills };
      break;
    case 'inspection':
      onInspection(message.inspection);
      break;
    case 'staged':
      install.staged = message.staged;
      install.phase = 'staged';
      break;
    case 'installed':
      install.phase = 'done';
      install.done = { names: message.names, locationLabel: message.locationLabel };
      install.inspection = null;
      install.staged = null;
      break;
    case 'installCancelled':
      break;
    case 'busy':
      if (message.busy) busy.add(message.op);
      else busy.delete(message.op);
      break;
    case 'error':
      errors[INSTALL_OPS.has(message.op) ? message.op : 'general'] = message.message;
      break;
  }
  render();
});

render();
send({ type: 'ready' });
