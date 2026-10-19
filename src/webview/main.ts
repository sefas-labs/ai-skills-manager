/* Dashboard webview entry point: rendering shell and host messages. Vanilla
 * TypeScript + DOM, no framework: values from the host go in via textContent. */
import type { HostToWebview } from '../shared/protocol';
import { INSTALL_OPS, type SkillsTab, type Tab, busy, catalog, errors, install, persisted, save, send, ui } from './store';
import { button, h, icon, skeleton } from './dom';
import { inTab, skillsView, tabOf } from './skills';
import { analyze, installView } from './install';
import { overview } from './overview';
import { mapView } from './map';
import { configView } from './config';

declare const __BUILD_ID__: string;

export const app = document.getElementById('app')!;

/** Never leave the user on "Scanning…": a render failure is shown, and reported to the host log. */
export function render(): void {
  try {
    renderView();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
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

export function renderView(): void {
  app.removeAttribute('aria-busy');
  // Re-rendering replaces the DOM: keep scroll positions of the page and of
  // every element tagged with data-scroll-key (same key = same content).
  const scrolls = new Map<string, number>();
  app.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((el) => scrolls.set(el.dataset.scrollKey!, el.scrollTop));
  const pageScroll = document.scrollingElement?.scrollTop ?? 0;
  // Keep keyboard focus (e.g. in the search box) across re-renders triggered by file changes.
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active?.id;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const general = errors['general'];
  app.replaceChildren(
    header(),
    ...(ui.staleHost
      ? [
          h(
            'div',
            { class: 'banner warn' },
            h('strong', null, 'The extension was updated. '),
            'Reload the window so the dashboard and the extension use the same version — until then some buttons may do nothing. ',
            button('Reload Window', () => send({ type: 'reloadWindow' }), { kind: 'primary' }),
            h('span', { class: 'small muted' }, ' (or run “Developer: Reload Window”)'),
          ),
        ]
      : []),
    ...(ui.state && !ui.state.trusted ? [h('div', { class: 'banner warn' }, 'Restricted Mode: this workspace is not trusted, so workspace skills are read-only.')] : []),
    ...(general ? [h('div', { class: 'banner error' }, general, ' ', button('Dismiss', () => ((errors['general'] = undefined), render()), { kind: 'link' }))] : []),
    h('main', { id: 'view' }, body()),
  );
  app.querySelectorAll<HTMLElement>('[data-scroll-key]').forEach((el) => {
    const top = scrolls.get(el.dataset.scrollKey!);
    if (top) el.scrollTop = top;
  });
  if (document.scrollingElement) document.scrollingElement.scrollTop = pageScroll;
  if (focusId) {
    const el = document.getElementById(focusId) as HTMLInputElement | null;
    if (el) {
      el.focus();
      if (sel && sel[0] !== null) {
        try {
          el.setSelectionRange(sel[0], sel[1]);
        } catch {
          /* not a text input */
        }
      }
    }
  }
}

export function header() {
  const total = ui.state?.skills.length ?? 0;
  const count = (t: SkillsTab) => (ui.state ? ` (${inTab(t).length})` : '');
  const scanned = ui.state ? new Date(ui.state.scannedAt).toLocaleTimeString() : '';
  const tab = (id: Tab, label: string, ic: string) =>
    h(
      'button',
      {
        class: `tab ${persisted.tab === id ? 'active' : ''}`,
        role: 'tab',
        'aria-selected': persisted.tab === id ? 'true' : 'false',
        onClick: () => {
          persisted.tab = id;
          save();
          render();
        },
      },
      icon(ic),
      h('span', { class: 'tab-label' }, label),
    );
  return h(
    'header',
    { class: 'top' },
    h('div', { class: 'brand' }, h('div', { class: 'logo', 'aria-hidden': 'true' }), h('div', null, h('h1', null, 'AI Skills', ui.state?.host.agentId ? h('span', { class: 'chip host', title: 'Editor this dashboard runs in' }, ui.state.host.appName) : null), h('p', { class: 'muted small' }, ui.state ? `${total} skill${total === 1 ? '' : 's'} · scanned ${scanned}` : 'Scanning…'))),
    h('nav', { class: 'tabs', role: 'tablist' }, tab('overview', 'Overview', 'dashboard'), tab('project', `Project${count('project')}`, 'root-folder'), tab('global', `Global${count('global')}`, 'home'), tab('map', 'Map', 'type-hierarchy'), tab('config', 'Config', 'settings-gear'), tab('install', 'Install', 'cloud-download')),
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
  if (persisted.tab === 'project' || persisted.tab === 'global') return skillsView(persisted.tab);
  if (persisted.tab === 'install') return installView();
  if (persisted.tab === 'map') return mapView();
  if (persisted.tab === 'config') return configView();
  return overview();
}

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'state':
      ui.staleHost = m.state.buildId !== __BUILD_ID__;
      // Tolerate a host from an older build (e.g. right after reinstalling without reloading).
      ui.state = { ...m.state, host: m.state.host ?? { appName: '' }, agents: m.state.agents ?? {}, merges: m.state.merges ?? [], skills: m.state.skills.map((x) => ({ ...x, fixes: x.fixes ?? [] })) };
      // Files may have changed on disk: refetch the open ui.detail.
      if (ui.detail) ui.requestedDetail = undefined;
      ui.detail = ui.detail && ui.state.skills.some((x) => x.id === ui.detail!.id) ? ui.detail : null;
      if (persisted.selected && !ui.state.skills.some((s) => s.id === persisted.selected)) persisted.selected = undefined;
      break;
    case 'focus':
      if (m.tab) persisted.tab = m.tab === 'skills' ? 'project' : m.tab;
      if (m.skillId) {
        const sk = ui.state?.skills.find((x) => x.id === m.skillId);
        if (sk) persisted.tab = tabOf(sk);
        persisted.selected = m.skillId;
        ui.detail = null;
        ui.requestedDetail = undefined;
        persisted.q = '';
        persisted.provider = persisted.status = 'all';
      }
      if (m.url) {
        persisted.url = m.url;
        persisted.installMode = 'url';
      }
      save();
      if (m.autoInspect && m.url) {
        render();
        analyze();
        return;
      }
      break;
    case 'detail':
      ui.detail = m.detail;
      break;
    case 'catalogSources':
      catalog.sources = m.sources;
      break;
    case 'catalogSkills':
      catalog.bySource.set(m.sourceId, { skills: m.skills, truncated: m.truncated });
      break;
    case 'catalogResults':
      catalog.results = { query: m.query, skills: m.skills };
      break;
    case 'inspection':
      install.inspection = m.inspection;
      install.phase = 'inspected';
      install.selected = new Set(m.inspection.candidates.filter((c) => c.installable).map((c) => c.id));
      install.expanded.clear();
      if (m.inspection.candidates.length === 1) install.expanded.add(m.inspection.candidates[0].id);
      break;
    case 'staged':
      install.staged = m.staged;
      install.phase = 'staged';
      break;
    case 'installed':
      install.phase = 'done';
      install.done = { names: m.names, locationLabel: m.locationLabel };
      install.inspection = null;
      install.staged = null;
      break;
    case 'installCancelled':
      break;
    case 'busy':
      if (m.busy) busy.add(m.op);
      else busy.delete(m.op);
      break;
    case 'error':
      errors[INSTALL_OPS.has(m.op) ? m.op : 'general'] = m.message;
      break;
  }
  render();
});

render();
send({ type: 'ready' });

