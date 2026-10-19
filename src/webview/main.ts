/* Dashboard webview. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { Finding } from '../core/inspector';
import type { Issue, ProviderSummary, ResolvedLocation } from '../core/types';
import type {
  HostToWebview,
  ViewCandidate,
  ViewInspection,
  ViewMerge,
  ViewSkill,
  ViewSkillDetail,
  ViewStaged,
  ViewState,
  WebviewToHost,
} from '../shared/protocol';

declare const __BUILD_ID__: string;
/** Set when the extension host is from another build (installed over without reloading). */
let staleHost = false;

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const api = acquireVsCodeApi();

type Tab = 'overview' | 'project' | 'global' | 'map' | 'install';
type SkillsTab = 'project' | 'global';
interface Persisted {
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
}

const persisted: Persisted = { tab: 'overview', q: '', provider: 'all', status: 'all', url: '', ...((api.getState() as Partial<Persisted>) ?? {}) };
// State saved by v0.2.0 had a single 'skills' tab.
if ((persisted.tab as string) === 'skills') persisted.tab = 'project';
let state: ViewState | null = null;
let detail: ViewSkillDetail | null = null;
const busy = new Set<string>();
const errors: Record<string, string | undefined> = {};
const install = {
  phase: 'idle' as 'idle' | 'inspected' | 'staged' | 'done',
  inspection: null as ViewInspection | null,
  selected: new Set<string>(),
  expanded: new Set<string>(),
  staged: null as ViewStaged[] | null,
  targetId: '',
  done: null as { names: string[]; locationLabel: string } | null,
};

const save = () => api.setState(persisted);
const send = (m: WebviewToHost) => api.postMessage(m);

// ---------- tiny DOM helper ----------
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'value') (el as HTMLInputElement).value = String(v);
      else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
      else if (k === 'disabled') (el as HTMLButtonElement).disabled = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, children);
  return el;
}
function add(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) add(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** Agents shown in the dashboard: the detected ones, unless the user asked for all (or none was detected). */
function shown(): ProviderSummary[] {
  if (!state) return [];
  const detected = state.providers.filter((p) => state!.agents[p.id]?.installed);
  return persisted.showAllAgents || detected.length === 0 ? state.providers : detected;
}
const isHost = (id: string) => state?.host.agentId === id;

/** Codicon (VS Code's icon font). Decorative: pair it with text or an aria-label. */
function icon(name: string, cls = ''): HTMLSpanElement {
  return h('span', { class: `codicon codicon-${name} ${cls}`.trim(), 'aria-hidden': 'true' });
}

/** One color per agent everywhere (VS Code chart palette, so every theme works). */
const AGENT_COLOR: Record<string, string> = { 'claude-code': 'orange', cursor: 'blue', codex: 'green', copilot: 'purple' };
const agentColor = (id: string, i = state?.providers.findIndex((p) => p.id === id) ?? 0) => AGENT_COLOR[id] ?? ['yellow', 'red', 'blue', 'green'][Math.max(i, 0) % 4];
const swatch = (id: string) => h('span', { class: `swatch c-${agentColor(id)}`, 'aria-hidden': 'true' });

/** Colored dots for the agents that load a skill, plus "n/m" against the agents shown. */
function agentDots(visibleTo: string[]): Node {
  const agents = shown();
  const on = agents.filter((a) => visibleTo.includes(a.id));
  return h(
    'span',
    { class: 'agent-dots', title: on.length ? `Loaded by ${on.map((a) => a.displayName).join(', ')}` : 'No agent loads it', 'aria-label': `${on.length} of ${agents.length} agents` },
    on.map((a) => h('span', { class: `dot-a c-${agentColor(a.id)}` })),
    h('span', { class: `ratio ${on.length === agents.length ? 'full' : on.length ? '' : 'none'}` }, `${on.length}/${agents.length}`),
  );
}

/** Agent name with its color; struck through when it doesn't load the thing. */
function agentPill(id: string, on: boolean, label = providerName(id)): Node {
  return h('span', { class: `apill ${on ? 'on' : 'off'} c-${agentColor(id)}`, title: `${providerName(id)}: ${on ? 'loads it' : 'does not load it'}` }, icon(on ? 'check' : 'close'), label);
}

const providerName = (id: string) => state?.providers.find((p) => p.id === id)?.displayName ?? (id === 'custom' ? 'Custom' : id);
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const problems = (s: ViewSkill) => s.issues.filter((i) => i.severity !== 'info');

function chip(text: string, kind = '', title?: string) {
  return h('span', { class: `chip ${kind}`, title }, text);
}

function sevIcon(sev: string) {
  const map: Record<string, string> = { error: 'error', high: 'error', warning: 'warning', info: 'info' };
  return h('span', { class: `sev sev-${sev}`, role: 'img', 'aria-label': sev }, icon(map[sev] ?? 'circle-filled'));
}

/** Issues of an installed skill, each with its fix button (or a pointer to edit by hand). */
function checksList(sk: ViewSkill): Node {
  if (!sk.issues.length) return h('p', { class: 'muted' }, 'No problems found.');
  const offered = new Set<string>();
  return h(
    'ul',
    { class: 'issues' },
    sk.issues.map((i) => {
      // Show each fix once, on the first issue it resolves.
      const fixes = sk.fixes.filter((f) => f.codes.includes(i.code) && !offered.has(f.id));
      fixes.forEach((f) => offered.add(f.id));
      const manual = !sk.fixes.some((f) => f.codes.includes(i.code)) && i.severity !== 'info' && !sk.readOnly && !i.code.startsWith('duplicate:');
      const merge = i.code.startsWith('duplicate:') && state!.merges.some((m) => m.copies.some((c) => c.skillId === sk.id)) && !offered.has('merge');
      if (merge) offered.add('merge');
      const choose = i.code.startsWith('duplicate:') && !sk.readOnly && !offered.has('choose');
      if (choose) offered.add('choose');
      return h(
        'li',
        null,
        sevIcon(i.severity),
        h(
          'span',
          null,
          i.message,
          fixes.length || manual
            ? h(
                'span',
                { class: 'fix-actions' },
                fixes.map((f) => button(f.label, () => send({ type: 'fix', skillId: sk.id, fixId: f.id }), { kind: 'secondary', disabled: busy.has('fix'), title: f.detail })),
                manual ? button('Edit SKILL.md', () => send({ type: 'openSkillFile', skillId: sk.id }), { kind: 'link', title: 'No safe automatic fix; edit it by hand' }) : null,
              )
            : null,
          choose || merge
            ? h(
                'span',
                { class: 'fix-actions' },
                choose ? button('Use this copy…', () => send({ type: 'chooseCopy', skillId: sk.id }), { kind: 'secondary', disabled: busy.has('chooseCopy'), title: 'Make every agent use this copy (sync or remove the others)' }) : null,
                merge ? button('See merge suggestion', scrollToMerges, { kind: 'link' }) : null,
              )
            : null,
          i.code === 'synced-copies' ? h('span', { class: 'small muted' }, ' Managed by claude.ai — nothing to fix here.') : null,
        ),
      );
    }),
  );
}

function issueList(issues: Issue[]) {
  if (!issues.length) return h('p', { class: 'muted' }, 'No problems found.');
  return h('ul', { class: 'issues' }, issues.map((i) => h('li', null, sevIcon(i.severity), h('span', null, i.message))));
}

function findingList(findings: Finding[]) {
  if (!findings.length) return h('p', { class: 'ok' }, 'No findings from the automatic checks. Still review the content before installing.');
  const order = { high: 0, warning: 1, info: 2 } as const;
  return h(
    'ul',
    { class: 'issues findings' },
    [...findings]
      .sort((a, b) => order[a.severity] - order[b.severity])
      .map((f) =>
        h(
          'li',
          null,
          sevIcon(f.severity),
          h(
            'div',
            null,
            h('div', null, f.message),
            h('div', { class: 'muted small' }, f.file + (f.line ? `:${f.line}` : '')),
            f.excerpt ? h('code', { class: 'excerpt' }, f.excerpt) : null,
          ),
        ),
      ),
  );
}

function button(label: string, onClick: () => void, opts: { kind?: 'primary' | 'secondary' | 'danger' | 'link'; disabled?: boolean; title?: string } = {}) {
  return h('button', { class: `btn ${opts.kind ?? 'secondary'}`, onClick, disabled: opts.disabled, title: opts.title, type: 'button' }, label);
}

// ---------- shell ----------
const app = document.getElementById('app')!;

const INSTALL_OPS = new Set(['inspect', 'stage', 'install']);
let requestedDetail: string | undefined;

/** Never leave the user on "Scanning…": a render failure is shown, and reported to the host log. */
function render(): void {
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

function renderView(): void {
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
    ...(staleHost
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
    ...(state && !state.trusted ? [h('div', { class: 'banner warn' }, 'Restricted Mode: this workspace is not trusted, so workspace skills are read-only.')] : []),
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

function header() {
  const total = state?.skills.length ?? 0;
  const count = (t: SkillsTab) => (state ? ` (${inTab(t).length})` : '');
  const scanned = state ? new Date(state.scannedAt).toLocaleTimeString() : '';
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
    h('div', { class: 'brand' }, h('div', { class: 'logo', 'aria-hidden': 'true' }), h('div', null, h('h1', null, 'AI Skills', state?.host.agentId ? h('span', { class: 'chip host', title: 'Editor this dashboard runs in' }, state.host.appName) : null), h('p', { class: 'muted small' }, state ? `${total} skill${total === 1 ? '' : 's'} · scanned ${scanned}` : 'Scanning…'))),
    h('nav', { class: 'tabs', role: 'tablist' }, tab('overview', 'Overview', 'dashboard'), tab('project', `Project${count('project')}`, 'root-folder'), tab('global', `Global${count('global')}`, 'home'), tab('map', 'Map', 'type-hierarchy'), tab('install', 'Install', 'cloud-download')),
    h('button', { class: `btn icon ${busy.has('refresh') ? 'spin' : ''}`, title: 'Rescan skill folders', 'aria-label': 'Refresh', onClick: () => send({ type: 'refresh' }) }, icon('refresh')),
  );
}

/** Grey placeholder lines while something loads. */
function skeleton(lines: number): Node {
  return h('div', { class: 'skeleton', 'aria-hidden': 'true' }, Array.from({ length: lines }, (_, i) => h('div', { class: `sk-line w${(i * 37) % 3}` })));
}

function body(): Node {
  if (!state) {
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
  return overview();
}

// ---------- overview ----------
interface TodoItem {
  icon: string;
  kind: 'warn' | 'err' | 'info';
  text: Child;
  action?: Node;
}

/** Everything actionable, in the order it's worth doing. */
function todoItems(): TodoItem[] {
  const s = state!;
  const out: TodoItem[] = [];
  const open = (id: string, label = 'Open') => button(label, () => selectSkill(id), { kind: 'secondary' });
  for (const sk of s.skills.filter((x) => x.fixes.length)) {
    const n = new Set(sk.fixes.flatMap((f) => f.codes)).size;
    out.push({ icon: 'wrench', kind: 'warn', text: [h('strong', null, sk.name), ` — ${n} fixable problem${n === 1 ? '' : 's'}`], action: button('Fix…', () => send({ type: 'fix', skillId: sk.id }), { kind: 'primary', disabled: busy.has('fix') }) });
  }
  const conflicts = new Set(shown().flatMap((p) => p.duplicateNames));
  for (const name of conflicts) {
    const copies = s.skills.filter((x) => x.name === name);
    const who = shown().filter((p) => p.duplicateNames.includes(name)).map((p) => p.displayName);
    out.push({ icon: 'files', kind: 'warn', text: [h('strong', null, name), ` — ${who.join(', ')} see${who.length === 1 ? 's' : ''} ${copies.length} different versions`], action: open(copies.find((c) => !c.readOnly)?.id ?? copies[0].id, 'Choose…') });
  }
  for (const m of s.merges.filter((x) => x.verdict === 'remove-redundant' && !conflicts.has(x.name))) {
    out.push({ icon: 'git-merge', kind: 'info', text: [h('strong', null, m.name), ` — ${m.remove.length} redundant cop${m.remove.length === 1 ? 'y' : 'ies'}`], action: button('Merge…', () => send({ type: 'merge', suggestionId: m.id, action: 'apply' }), { kind: 'secondary', disabled: busy.has('merge') }) });
  }
  for (const sk of s.skills.filter((x) => x.update?.status === 'update-available')) {
    out.push({ icon: 'arrow-circle-up', kind: 'info', text: [h('strong', null, sk.name), ' — update available'], action: button('Review…', () => send({ type: 'update', skillId: sk.id }), { kind: 'secondary', disabled: busy.has('update') }) });
  }
  for (const sk of s.skills.filter((x) => !x.fixes.length && problems(x).some((i) => !i.code.startsWith('duplicate:')))) {
    const p = problems(sk).find((i) => !i.code.startsWith('duplicate:'))!;
    out.push({ icon: p.severity === 'error' ? 'error' : 'warning', kind: p.severity === 'error' ? 'err' : 'warn', text: [h('strong', null, sk.name), ` — ${p.message}`], action: open(sk.id) });
  }
  const gaps = coverage('project').filter((r) => r.missing.length && !r.synced);
  if (gaps.length) {
    const per = shown()
      .map((a) => [short(a.displayName), gaps.filter((r) => r.missing.includes(a.id)).length] as const)
      .filter(([, n]) => n)
      .map(([name, n]) => `${name} ${n}`);
    out.push({ icon: 'type-hierarchy', kind: 'info', text: [h('strong', null, `${gaps.length} project skill${gaps.length === 1 ? '' : 's'}`), ` miss an agent (${per.join(' · ')})`], action: button('Open Map', () => ((persisted.tab = 'map'), (persisted.mapScope = 'project'), save(), render()), { kind: 'secondary' }) });
  }
  return out;
}

/** Ring with the share of skills without problems. */
function healthRing(ok: number, total: number): Node {
  const R = 30, C = 2 * Math.PI * R, frac = total ? ok / total : 1;
  return h(
    'div',
    { class: 'ring', role: 'img', 'aria-label': `${ok} of ${total} skills without problems` },
    svg('svg', { viewBox: '0 0 80 80', width: 80, height: 80 },
      svg('circle', { cx: 40, cy: 40, r: R, class: 'ring-bg' }),
      svg('circle', { cx: 40, cy: 40, r: R, class: `ring-fg ${frac === 1 ? 'full' : ''}`, 'stroke-dasharray': `${(C * frac).toFixed(1)} ${C.toFixed(1)}`, transform: 'rotate(-90 40 40)' })),
    h('div', { class: 'ring-label' }, h('strong', null, String(ok)), h('span', { class: 'muted small' }, `/${total}`)),
  );
}

function healthHero(): Node {
  const s = state!;
  const ok = s.skills.filter((x) => !problems(x).length).length;
  const host = s.providers.find((p) => isHost(p.id));
  const missing = s.providers.filter((p) => !s.agents[p.id]?.installed);
  const items = todoItems();
  const go = (t: Tab) => () => ((persisted.tab = t), save(), render());
  return h(
    'section',
    { class: 'panel hero' },
    h(
      'div',
      { class: 'hero-left' },
      h(
        'div',
        { class: 'hero-score' },
        healthRing(ok, s.skills.length),
        h(
          'div',
          null,
          h('div', { class: 'hero-title' }, ok === s.skills.length ? 'All skills look good' : `${s.skills.length - ok} skill${s.skills.length - ok === 1 ? '' : 's'} need${s.skills.length - ok === 1 ? 's' : ''} attention`),
          h(
            'div',
            { class: 'hero-counts' },
            h('button', { class: 'linkish', type: 'button', onClick: go('project') }, icon('root-folder'), ` ${inTab('project').length} project`),
            h('button', { class: 'linkish', type: 'button', onClick: go('global') }, icon('home'), ` ${inTab('global').length} global`),
          ),
        ),
      ),
      host
        ? h('p', { class: 'small hero-host' }, icon('vm'), ' In ', h('strong', null, s.host.appName), `: ${host.displayName} loads ${host.visibleSkills} skill${host.visibleSkills === 1 ? '' : 's'}`, host.duplicateNames.length ? `, ${host.duplicateNames.length} with two versions` : '', '. ', button('Show them', () => ((persisted.provider = host.id), (persisted.tab = 'project'), save(), render()), { kind: 'link' }))
        : null,
      h(
        'div',
        { class: 'agent-chips' },
        s.providers.map((p) =>
          h(
            'span',
            { class: `achip ${s.agents[p.id]?.installed ? 'on' : 'off'} ${isHost(p.id) ? 'host' : ''} c-${agentColor(p.id)}`, title: (s.agents[p.id]?.evidence ?? []).join(' · ') || 'Not detected on this machine (no CLI, app, config file or extension found)' },
            h('span', { class: 'swatch' }),
            p.displayName,
            s.agents[p.id]?.installed ? null : h('span', { class: 'muted' }, ' · not detected'),
          ),
        ),
        missing.length && missing.length < s.providers.length
          ? button(persisted.showAllAgents ? 'Hide not detected' : 'Show all', () => ((persisted.showAllAgents = !persisted.showAllAgents), save(), render()), { kind: 'link' })
          : null,
      ),
    ),
    h(
      'div',
      { class: 'hero-right' },
      h('h2', null, icon('checklist'), ' To do', items.length ? h('span', { class: 'count' }, String(items.length)) : null),
      items.length
        ? h('ul', { class: 'todo', 'data-scroll-key': 'todo' }, items.map((t) => h('li', { class: t.kind }, icon(t.icon, 'todo-icon'), h('span', { class: 'todo-text' }, t.text), t.action ?? null)))
        : h('p', { class: 'todo-empty' }, icon('pass-filled', 'ok'), ' Nothing to do — no conflicts, problems or updates.'),
    ),
  );
}

function overview(): Node {
  const s = state!;
  if (s.skills.length === 0) {
    return h(
      'section',
      { class: 'panel empty' },
      h('h2', null, 'No skills yet'),
      h('p', { class: 'muted' }, 'Skills are folders with a SKILL.md file. Install some from a GitHub repository to get started.'),
      button('Install from GitHub', () => ((persisted.tab = 'install'), save(), render()), { kind: 'primary' }),
    );
  }
  // Parent/nested folders are only interesting when they exist; empty ones fold away.
  const all = s.locations.filter((l) => l.exists || (l.scope !== 'admin' && !l.origin));
  const empty = all.filter((l) => !l.exists || !l.skillCount);
  const locs = persisted.showEmptyFolders ? all : all.filter((l) => l.exists && l.skillCount);
  const matrix = h(
    'table',
    { class: 'matrix' },
    h('thead', null, h('tr', null, h('th', null, 'Folder'), ...shown().map((p) => h('th', { class: `c ${isHost(p.id) ? 'host' : ''}`, title: isHost(p.id) ? 'The agent built into this editor' : undefined }, swatch(p.id), short(p.displayName))), h('th', { class: 'c' }, 'Skills'))),
    h(
      'tbody',
      null,
      locs.map((l) =>
        h(
          'tr',
          { class: l.exists && l.skillCount ? '' : 'dim' },
          h(
            'td',
            null,
            h('div', { class: 'mono' }, l.readOnly ? icon('lock', 'muted') : null, l.readOnly ? ' ' : null, l.label),
            h('div', { class: 'small muted' }, l.scope + (l.origin === 'nested' ? ` · nested, for ${l.appliesTo}/` : l.origin === 'parent' ? ' · parent folder' : '') + (l.exists ? '' : ' · not created')),
            l.exists && l.skillCount && !l.readers.some((r) => state!.agents[r]?.installed) ? h('div', { class: 'small warn-text' }, 'No installed agent reads this folder') : null,
            l.skippedSynced ? h('div', { class: 'small muted', title: 'Claude Code only loads the skills of the claude.ai account it is signed in with.' }, `${l.skippedSynced} synced skill${l.skippedSynced === 1 ? '' : 's'} of another claude.ai account not listed`) : null,
          ),
          ...shown().map((p) => h('td', { class: `c ${isHost(p.id) ? 'host' : ''}` }, l.readers.includes(p.id) ? h('span', { class: `dot-a big c-${agentColor(p.id)}`, title: `${p.displayName} loads skills from here` }) : h('span', { class: 'dot-off', 'aria-hidden': 'true' }))),
          h('td', { class: 'c num-cell' }, l.exists ? String(l.skillCount) : '—'),
        ),
      ),
    ),
  );

  const providerCards = h(
    'div',
    { class: 'cards' },
    shown().map((p) =>
      h(
        'section',
        { class: `card agent-card c-${agentColor(p.id)} ${isHost(p.id) ? 'host' : ''}` },
        h('div', { class: 'card-head' }, h('h3', null, swatch(p.id), p.displayName), isHost(p.id) ? chip('this editor', 'host') : null, h('button', { class: 'btn link icon-only', type: 'button', title: `${p.displayName} documentation`, 'aria-label': `${p.displayName} documentation`, onClick: () => send({ type: 'openDocs', providerId: p.id }) }, icon('link-external'))),
        h('div', { class: 'card-num' }, h('span', { class: 'num' }, String(p.visibleSkills)), h('span', { class: 'muted small' }, ' skills')),
        agentStatus(p.id),
        p.duplicateNames.length ? h('p', { class: 'warn-text small' }, icon('warning'), ` Two versions: ${p.duplicateNames.join(', ')}`) : null,
        p.disableHint ? h('details', { class: 'hint small' }, h('summary', { class: 'muted' }, 'How to disable a skill'), h('p', { class: 'muted' }, p.disableHint)) : null,
      ),
    ),
  );

  return h(
    'div',
    { class: 'overview' },
    healthHero(),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Which agent loads which folder'), empty.length ? button(persisted.showEmptyFolders ? 'Hide empty folders' : `Show ${empty.length} empty folder${empty.length === 1 ? '' : 's'}`, () => ((persisted.showEmptyFolders = !persisted.showEmptyFolders), save(), render()), { kind: 'link' }) : null),
      h('p', { class: 'muted small' }, 'Based on each agent’s official documentation. A skill is available to an agent only if it sits in a folder that agent reads.'),
      h('div', { class: 'scroll-x' }, matrix),
    ),
    h('h2', { class: 'section-title' }, 'Agents'),
    providerCards,
    mergePanel(),
  );
}

function scrollToMerges(): void {
  persisted.tab = 'overview';
  save();
  render();
  const el = document.getElementById('merges') as HTMLDetailsElement | null;
  if (el) {
    el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const VERDICT: Record<ViewMerge['verdict'], string> = {
  'remove-redundant': 'Redundant copies — every agent keeps it with fewer folders',
  'unify-versions': 'Different versions — all copies are needed, but agents see different content',
  expected: 'Copies are needed to reach every agent (no single folder reaches all of them)',
};

function mergePanel(): Node | null {
  const s = state!;
  if (!s.merges.length) return null;
  const actionable = s.merges.filter((m) => m.verdict !== 'expected');
  const working = busy.has('merge');
  return h(
    'details',
    { class: 'panel merges', id: 'merges', open: actionable.length ? true : undefined },
    h('summary', null, h('h2', null, icon('git-merge'), ` Merge suggestions${actionable.length ? ` (${actionable.length})` : ''}`)),
    h('p', { class: 'muted small' }, 'Same skill name in several folders of the same scope. Only installed agents are taken into account; nothing changes until you confirm.'),
    s.merges.map((m) => {
      const versions = new Set(m.copies.map((c) => c.version)).size;
      const letter = (v: number) => String.fromCharCode(65 + v);
      return h(
        'div',
        { class: `merge ${m.verdict}` },
        h('div', { class: 'merge-head' }, h('strong', null, m.name), chip(m.scope === 'workspace' ? 'project' : 'global', `scope-${m.scope}`), m.identical ? chip('identical', 'subtle') : chip(`${versions} versions`, 'warn')),
        h('p', { class: 'small' }, VERDICT[m.verdict], m.seenTwiceBy.length ? h('span', { class: 'muted' }, ` · seen twice by ${m.seenTwiceBy.map(providerName).join(', ')}`) : null),
        h(
          'ul',
          { class: 'merge-copies' },
          m.copies.map((c) =>
            h(
              'li',
              null,
              m.remove.includes(c.skillId) ? chip('remove', 'danger') : chip('keep', 'subtle'),
              versions > 1 ? chip(letter(c.version), 'subtle', c.changedFiles ? `${c.changedFiles} file(s) differ from version A` : 'Version A') : null,
              h('span', { class: 'mono' }, c.locationLabel),
              h('span', { class: 'small muted' }, ` ${c.readers.map((r) => short(providerName(r))).join(' · ')}`),
              !c.writable ? h('span', { class: 'small muted' }, ' · read-only') : null,
              c.modifiedAt ? h('span', { class: 'small muted' }, ` · modified ${new Date(c.modifiedAt).toLocaleDateString()}`) : null,
              m.verdict === 'unify-versions'
                ? button('Use this version', () => send({ type: 'merge', suggestionId: m.id, action: 'unify', skillId: c.skillId }), { kind: 'link', disabled: working, title: 'Copy this version over the other writable copies (backup kept)' })
                : null,
            ),
          ),
        ),
        h(
          'div',
          { class: 'inline' },
          m.remove.length ? button(`Merge: remove ${m.remove.length} cop${m.remove.length === 1 ? 'y' : 'ies'}…`, () => send({ type: 'merge', suggestionId: m.id, action: 'apply' }), { kind: 'primary', disabled: working }) : null,
          !m.identical ? button('Compare', () => send({ type: 'merge', suggestionId: m.id, action: 'compare' }), { disabled: working }) : null,
        ),
      );
    }),
  );
}

function agentStatus(id: string): Node | null {
  const a = state!.agents[id];
  if (!a) return null;
  return a.installed
    ? h('p', { class: 'small ok-text', title: a.evidence.join(' · ') }, icon('pass'), ' Detected — ', a.evidence[0], a.evidence.length > 1 ? ` (+${a.evidence.length - 1})` : '')
    : h('p', { class: 'small muted' }, icon('circle-slash'), ' Not detected on this machine');
}

// ---------- skills ----------
/** Project = workspace folders (incl. parent/nested); Global = user and admin/system folders. */
function tabOf(sk: ViewSkill): SkillsTab {
  return sk.scope === 'workspace' ? 'project' : 'global';
}

function inTab(t: SkillsTab): ViewSkill[] {
  return state ? state.skills.filter((sk) => tabOf(sk) === t) : [];
}

function selectSkill(id: string) {
  const sk = state?.skills.find((x) => x.id === id);
  persisted.tab = sk ? tabOf(sk) : 'project';
  persisted.selected = id;
  detail = null;
  requestedDetail = undefined;
  save();
  render();
}

function filtered(t: SkillsTab): ViewSkill[] {
  const q = persisted.q.trim().toLowerCase();
  return inTab(t)
    .filter((s) => persisted.provider === 'all' || !shown().some((p) => p.id === persisted.provider) || s.visibleTo.includes(persisted.provider))
    .filter((s) => {
      switch (persisted.status) {
        case 'problems':
          return problems(s).length > 0;
        case 'links':
          return s.isSymlink;
        case 'readonly':
          return s.readOnly;
        case 'github':
          return !!s.tracked;
        case 'updates':
          return s.update?.status === 'update-available';
        default:
          return true;
      }
    })
    .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q) || s.displayDir.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
}

function select(value: string, options: Array<[string, string]>, onChange: (v: string) => void, label: string) {
  return h(
    'label',
    { class: 'select' },
    h('span', { class: 'sr' }, label),
    h(
      'select',
      { onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value), 'aria-label': label },
      options.map(([v, t]) => h('option', { value: v, selected: v === value ? true : undefined }, t)),
    ),
  );
}

const expandedGroups = new Set<string>();
/** Tabs where the first skill was already opened automatically (never fight the user afterwards). */
const autoPicked = new Set<SkillsTab>();
const wideLayout = () => window.matchMedia?.('(min-width: 821px)').matches ?? true;

function rowChips(sk: ViewSkill): Child[] {
  return [
    sk.scope === 'admin' ? chip('admin', 'scope-admin') : null,
    sk.isSymlink ? chip('link', 'subtle', `→ ${sk.realDir}`) : null,
    sk.managed === 'synced' ? chip('claude.ai', 'subtle', 'Synced from claude.ai (read-only)') : sk.readOnly ? chip('read-only', 'subtle', sk.readOnlyReason) : null,
    sk.update?.status === 'update-available' ? chip('update', 'update', 'A newer version is available on GitHub') : null,
  ];
}

function worstOf(skills: ViewSkill[]): string {
  const p = skills.flatMap(problems);
  return p.some((i) => i.severity === 'error') ? 'error' : p.length ? 'warning' : '';
}

function skillRow(sk: ViewSkill, child: boolean): Node {
  const worst = worstOf([sk]);
  const sel = persisted.selected === sk.id;
  return h(
    'button',
    { class: `row ${child ? 'child' : ''} ${sel ? 'selected' : ''}`, 'aria-current': sel ? 'true' : undefined, type: 'button', onClick: () => selectSkill(sk.id) },
    child
      ? h('div', { class: 'row-head' }, worst ? sevIcon(worst) : null, h('span', { class: 'mono loc' }, sk.locationLabel), ...rowChips(sk), agentDots(sk.visibleTo))
      : [
          h('div', { class: 'row-head' }, worst ? sevIcon(worst) : null, h('span', { class: 'name' }, sk.name), ...rowChips(sk)),
          sk.description ? h('div', { class: 'desc' }, sk.description) : h('div', { class: 'desc muted' }, 'No description'),
          h('div', { class: 'row-foot' }, h('span', { class: 'mono small muted loc' }, sk.locationLabel), agentDots(sk.visibleTo)),
        ],
  );
}

function groupRows(copies: ViewSkill[]): Node {
  const name = copies[0].name;
  const open = expandedGroups.has(name) || copies.some((c) => c.id === persisted.selected);
  const same = copies.every((c) => c.contentId && c.contentId === copies[0].contentId);
  const worst = worstOf(copies);
  const union = [...new Set(copies.flatMap((c) => c.visibleTo))];
  const toggle = () => {
    if (open) {
      expandedGroups.delete(name);
      if (copies.some((c) => c.id === persisted.selected)) persisted.selected = undefined;
    } else expandedGroups.add(name);
    save();
    render();
  };
  return h(
    'div',
    { class: `group ${open ? 'open' : ''}` },
    h(
      'button',
      { class: 'row group-head', type: 'button', 'aria-expanded': open ? 'true' : 'false', onClick: toggle },
      h('div', { class: 'row-head' }, icon(open ? 'chevron-down' : 'chevron-right', 'chev'), worst ? sevIcon(worst) : null, h('span', { class: 'name' }, name), chip(`${copies.length} copies`, same ? 'subtle' : 'warn', same ? 'Same content in every folder' : 'The copies differ — open one to choose which to use')),
      copies[0].description ? h('div', { class: 'desc' }, copies[0].description) : null,
      h('div', { class: 'row-foot' }, h('span', { class: 'mono small muted loc' }, copies.map((c) => c.locationLabel).join(' · ')), agentDots(union)),
    ),
    open ? h('div', { class: 'group-children' }, copies.map((c) => skillRow(c, true))) : null,
  );
}

function skillsView(t: SkillsTab): Node {
  if (inTab(t).length === 0) return emptyTab(t);
  const listEl = h('div', { class: 'list', 'aria-label': 'Skills', 'data-scroll-key': `list-${t}` });
  const fillList = () => {
    const items = filtered(t);
    // Same name in several folders → one expandable group (see "Copies" in the detail).
    const groups = new Map<string, ViewSkill[]>();
    for (const sk of items) groups.set(sk.name, [...(groups.get(sk.name) ?? []), sk]);
    listEl.replaceChildren(
      ...(items.length
        ? [...groups.values()].map((copies) => (copies.length === 1 ? skillRow(copies[0], false) : groupRows(copies)))
        : [h('p', { class: 'muted pad' }, 'No skills match these filters.')]),
    );
  };
  fillList();

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('input', {
      type: 'search',
      id: 'search',
      class: 'search',
      placeholder: 'Search name, description or path',
      value: persisted.q,
      'aria-label': 'Search skills',
      onInput: (e: Event) => {
        persisted.q = (e.target as HTMLInputElement).value;
        save();
        fillList();
      },
    }),
    select(persisted.provider, [['all', 'All agents'], ...shown().map((p) => [p.id, p.displayName] as [string, string])], (v) => ((persisted.provider = v), save(), fillList()), 'Agent'),
    select(persisted.status, [['all', 'Any status'], ['problems', 'With problems'], ['links', 'Symlinks'], ['readonly', 'Read-only'], ['github', 'From GitHub (tracked)'], ['updates', 'Updates available']], (v) => ((persisted.status = v), save(), fillList()), 'Status'),
  );

  // One selection for both tabs; only shown in the tab it belongs to. On wide
  // layouts, open the first skill instead of leaving the detail pane empty.
  let selected = inTab(t).find((x) => x.id === persisted.selected);
  if (!selected && wideLayout() && !autoPicked.has(t)) {
    autoPicked.add(t);
    selected = filtered(t)[0];
    if (selected) {
      persisted.selected = selected.id;
      save();
    }
  }
  if (selected && (!detail || detail.id !== selected.id) && requestedDetail !== selected.id) {
    requestedDetail = selected.id;
    send({ type: 'getDetail', skillId: selected.id });
  }
  return h('div', { class: 'skills' }, t === 'global' ? syncedNotice() : null, toolbar, h('div', { class: 'split' }, listEl, h('aside', { class: 'detail', 'aria-live': 'polite', 'data-scroll-key': `detail-${selected?.id ?? ''}` }, selected ? skillDetail(selected) : h('div', { class: 'empty muted' }, 'Select a skill to see where it lives, who loads it and what it contains.'))));
}

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown date');
const shortId = (bucket: string) => bucket.slice(0, 8) + '…';

/** Explains why skills synced for another claude.ai account are not listed (they used to look like duplicates). */
function syncedNotice(): Node | null {
  const loc = state!.locations.find((l) => l.skippedSyncedBuckets?.length);
  if (!loc) return null;
  const n = loc.skippedSynced ?? 0;
  return h(
    'details',
    { class: 'banner info synced-notice' },
    h('summary', null, h('strong', null, `${n} synced skill${n === 1 ? '' : 's'} from another claude.ai account ${n === 1 ? 'is' : 'are'} not listed`), ' — why?'),
    h(
      'p',
      null,
      'Claude Code downloads the skills enabled for the claude.ai account you are signed in with into ',
      h('span', { class: 'mono' }, '~/.claude/skills/synced/<organization>_<account>/'),
      '. Each account gets its own folder, so after signing in with a different account (or organization) the old folder stays on disk. It is no longer updated and Claude Code does not load it.',
    ),
    loc.activeSyncBucket
      ? h('p', null, 'Your current account ', h('span', { class: 'mono' }, shortId(loc.activeSyncBucket.bucket)), ` — synced ${fmtDate(loc.activeSyncBucket.lastSynced)}. These are the skills listed.`)
      : null,
    loc.skippedSyncedBuckets!.map((b) =>
      h('p', null, 'Other account ', h('span', { class: 'mono' }, shortId(b.bucket)), ` — last synced ${fmtDate(b.lastSynced)}, not loaded: `, h('span', { class: 'mono' }, b.skills.join(', '))),
    ),
    h('p', { class: 'muted small' }, 'Same names in both folders (docs, pdf…) are the same claude.ai skills downloaded once per account — that is why they looked duplicated. Nothing to fix: Claude Code manages this folder and uses the old one again if you sign in with that account.'),
  );
}

/** Every folder that has a skill with this name, and a way to make one of them the version agents use. */
function copiesSection(sk: ViewSkill): Node | null {
  const copies = state!.skills.filter((x) => x.name === sk.name);
  if (copies.length < 2) return null;
  const allSame = copies.every((c) => c.contentId && c.contentId === copies[0].contentId);
  const working = busy.has('chooseCopy');
  return h(
    'section',
    { class: 'copies' },
    h('h3', null, `Copies (${copies.length})`),
    h(
      'p',
      { class: 'small muted' },
      allSame
        ? 'All copies have the same content, so it does not matter which one an agent picks.'
        : 'Agents that read several of these folders pick one copy on their own (Cursor and Copilot don’t document which). Choose the one to use: the others are made identical to it, or removed.',
    ),
    h(
      'ul',
      { class: 'copy-list' },
      copies.map((c) =>
        h(
          'li',
          { class: c.id === sk.id ? 'current' : '' },
          chip(c.scope === 'workspace' ? 'project' : c.scope, `scope-${c.scope}`),
          h('button', { class: 'linkish mono', type: 'button', onClick: () => selectSkill(c.id), title: c.displayDir }, c.locationLabel),
          h('span', { class: 'small muted' }, c.visibleTo.map((v) => short(providerName(v))).join(' · ') || 'no agent'),
          !allSame && c.id !== sk.id ? h('span', { class: 'small' }, c.contentId && c.contentId === sk.contentId ? chip('same as this', 'subtle') : chip('different', 'warn')) : null,
          c.id === sk.id ? chip('viewing', 'subtle') : null,
          allSame
            ? button('Keep only this one…', () => send({ type: 'chooseCopy', skillId: c.id }), { kind: 'link', disabled: working, title: 'Remove the other copies (to the backup folder); shows which agents would lose it first' })
            : button('Use this one…', () => send({ type: 'chooseCopy', skillId: c.id }), { kind: c.id === sk.id ? 'primary' : 'secondary', disabled: working, title: 'Make every agent use this copy' }),
        ),
      ),
    ),
  );
}

function otherAccountNote(sk: ViewSkill): Node | null {
  if (sk.managed !== 'synced') return null;
  const hit = state!.locations.flatMap((l) => l.skippedSyncedBuckets ?? []).find((b) => b.skills.includes(sk.name));
  if (!hit) return null;
  return h(
    'p',
    { class: 'small muted' },
    icon('info'),
    ' Another copy of this skill is synced for a different claude.ai account (',
    h('span', { class: 'mono' }, shortId(hit.bucket)),
    `, last synced ${fmtDate(hit.lastSynced)}). Claude Code only loads the signed-in account's copy, so the other one is not listed.`,
  );
}

function emptyTab(t: SkillsTab): Node {
  const goInstall = () => ((persisted.tab = 'install'), save(), render());
  if (t === 'project' && !state!.hasWorkspace) {
    return h('div', { class: 'panel empty' }, h('h2', null, 'No folder open'), h('p', { class: 'muted' }, 'Open a folder or workspace to see its project skills (.claude/skills, .agents/skills, .cursor/skills, .github/skills…).'));
  }
  return h(
    'div',
    { class: 'panel empty' },
    h('h2', null, t === 'project' ? 'No project skills' : 'No global skills'),
    h(
      'p',
      { class: 'muted' },
      t === 'project'
        ? 'Skills in this workspace are shared with everyone who clones it. Install one from GitHub, or copy a global skill here with “Copy / Move…”.'
        : 'Global skills are available in every project. Install one from GitHub, or copy a project skill here with “Copy / Move…”.',
    ),
    button('Install from GitHub', goInstall, { kind: 'primary' }),
  );
}

function short(name: string): string {
  return ({ 'Claude Code': 'Claude', 'GitHub Copilot': 'Copilot' } as Record<string, string>)[name] ?? name;
}

function skillDetail(sk: ViewSkill): Node {
  const d = detail && detail.id === sk.id ? detail : null;
  return h(
    'div',
    null,
    h('div', { class: 'detail-head' }, h('h2', null, sk.name), h('div', { class: 'actions' }, button('Open SKILL.md', () => send({ type: 'openSkillFile', skillId: sk.id }), { kind: 'primary' }), button('Reveal', () => send({ type: 'reveal', skillId: sk.id })), button('Copy path', () => send({ type: 'copyPath', skillId: sk.id })), sk.scope !== 'workspace' ? button('Add to project…', () => send({ type: 'addToProject', skillId: sk.id }), { kind: 'primary', disabled: busy.has('addToProject'), title: 'Copy this skill into a skills folder of the open project' }) : null, button('Copy / Move…', () => send({ type: 'copyMove', skillId: sk.id }), { title: 'Copy or move to another skills folder; shows which agents gain or lose it first' }), button('Remove…', () => send({ type: 'uninstall', skillId: sk.id }), { kind: 'danger', disabled: sk.readOnly, title: sk.readOnly ? sk.readOnlyReason : 'Remove this skill (asks for confirmation)' }))),
    sk.description ? h('p', null, sk.description) : null,
    h('h3', null, 'Available to'),
    h('div', { class: 'vis big' }, shown().map((p) => agentPill(p.id, sk.visibleTo.includes(p.id)))),
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Location'),
      h('dd', { class: 'mono' }, sk.displayDir),
      sk.isSymlink ? [h('dt', null, 'Link target'), h('dd', { class: 'mono' }, sk.realDir || '(broken)')] : null,
      h('dt', null, 'Scope'),
      h('dd', null, sk.scope, sk.readOnly ? ` · read-only — ${sk.readOnlyReason || (sk.managed === 'synced' ? 'synced from claude.ai' : 'managed elsewhere')}` : ''),
      h('dt', null, 'Source'),
      h('dd', null, sk.source ? h('span', { class: 'mono' }, `${sk.source.url} @ ${sk.source.commit.slice(0, 7)} (installed ${new Date(sk.source.installedAt).toLocaleDateString()})`) : sk.sourceHint ? `From frontmatter — ${sk.sourceHint}` : h('span', { class: 'muted' }, 'Unknown — added manually or by another tool')),
      sk.tracked ? [h('dt', null, 'Updates'), h('dd', null, updateLine(sk))] : null,
    ),
    h('div', { class: 'checks-head' }, h('h3', null, 'Checks'), sk.fixes.length > 1 ? button(busy.has('fix') ? 'Fixing…' : `Fix all (${new Set(sk.fixes.flatMap((f) => f.codes)).size})`, () => send({ type: 'fix', skillId: sk.id }), { kind: 'primary', disabled: busy.has('fix'), title: 'Shows every change before applying it; keeps a backup' }) : null),
    checksList(sk),
    otherAccountNote(sk),
    copiesSection(sk),
    sk.frontmatter.length ? [h('h3', null, 'Frontmatter'), h('dl', { class: 'kv' }, sk.frontmatter.map(([k, v]) => [h('dt', { class: 'mono' }, k), h('dd', null, v)]))] : null,
    h('h3', null, 'Files'),
    d
      ? h(
          'ul',
          { class: 'files' },
          d.files.map((f) => h('li', null, h('button', { class: 'linkish mono', type: 'button', onClick: () => send({ type: 'openSkillFile', skillId: sk.id, rel: f }) }, f))),
          d.truncated ? h('li', { class: 'muted' }, '…more files not shown') : null,
        )
      : skeleton(3),
    h('h3', null, 'Instructions (SKILL.md body)'),
    d ? h('pre', { class: 'body' }, d.body || '(empty)') : skeleton(3),
  );
}

const UPDATE_TEXT: Record<string, string> = {
  'up-to-date': 'Up to date',
  'update-available': 'Update available',
  pinned: 'Pinned to a commit — not updated',
  'ref-missing': 'Branch or tag no longer exists',
  'path-missing': 'Folder no longer exists upstream',
  unknown: 'Unknown — review to compare',
  error: 'Check failed',
};

function updateLine(sk: ViewSkill): Node {
  const u = sk.update;
  const working = busy.has('update') || busy.has('checkUpdates');
  const canUpdate = !sk.readOnly && !sk.isSymlink && u?.status !== 'pinned';
  return h(
    'span',
    { class: 'inline' },
    h('span', { class: u?.status === 'update-available' ? 'update-text' : u?.status === 'error' ? 'err-text' : '' }, u ? UPDATE_TEXT[u.status] ?? u.status : 'Not checked yet'),
    u?.remoteCommit && u.status === 'update-available' ? h('span', { class: 'mono small muted' }, `→ ${u.remoteCommit.slice(0, 7)}`) : null,
    u?.message ? h('span', { class: 'small muted' }, u.message) : null,
    u ? h('span', { class: 'small muted' }, `checked ${new Date(u.checkedAt).toLocaleString()}`) : null,
    canUpdate ? button(u?.status === 'update-available' ? 'Review update…' : 'Check & review…', () => send({ type: 'update', skillId: sk.id }), { kind: u?.status === 'update-available' ? 'primary' : 'secondary', disabled: working }) : null,
    button(busy.has('checkUpdates') ? 'Checking…' : 'Check all', () => send({ type: 'checkUpdates' }), { kind: 'link', disabled: working }),
    sk.tracked === 'gh-skill' ? h('span', { class: 'small muted' }, 'Installed with gh skill') : null,
  );
}

// ---------- map ----------
type MapScope = 'project' | 'global';


function mapScope(): MapScope {
  if (persisted.mapScope) return persisted.mapScope;
  return inTab('project').length ? 'project' : 'global';
}

interface CoverageRow {
  name: string;
  copies: ViewSkill[];
  /** agent id → 'ok' | 'twice' | 'missing' */
  cells: Record<string, 'ok' | 'twice' | 'missing'>;
  missing: string[];
  /** Every copy is synced from claude.ai: copying it elsewhere would create a stale, unsynced copy. */
  synced: boolean;
  /** Best writable folder of the same scope that adds the missing agents. */
  fix?: { location: ResolvedLocation; gains: string[]; source: ViewSkill };
}

function coverage(scope: MapScope): CoverageRow[] {
  const s = state!;
  const agents = shown();
  const byName = new Map<string, ViewSkill[]>();
  for (const sk of inTab(scope)) byName.set(sk.name, [...(byName.get(sk.name) ?? []), sk]);
  const targets = s.locations.filter((l) => !l.readOnly && l.scope !== 'admin' && !l.origin && (scope === 'project' ? l.scope === 'workspace' : l.scope === 'global'));
  return [...byName.entries()]
    .map(([name, copies]) => {
      const cells: CoverageRow['cells'] = {};
      for (const a of agents) {
        const seen = copies.filter((c) => c.visibleTo.includes(a.id));
        cells[a.id] = seen.length === 0 ? 'missing' : copies.some((c) => c.issues.some((i) => i.code === `duplicate:${a.id}`)) ? 'twice' : 'ok';
      }
      const missing = agents.filter((a) => cells[a.id] === 'missing').map((a) => a.id);
      const synced = copies.every((c) => c.managed === 'synced');
      let fix: CoverageRow['fix'];
      if (missing.length && !synced) {
        const have = new Set(copies.map((c) => c.locationId));
        const best = targets
          .filter((l) => !have.has(l.id))
          .map((l) => ({ location: l, gains: missing.filter((m) => l.readers.includes(m)) }))
          .filter((x) => x.gains.length)
          .sort((a, b) => b.gains.length - a.gains.length || Number(b.location.exists) - Number(a.location.exists))[0];
        if (best) fix = { ...best, source: copies[0] };
      }
      return { name, copies, cells, missing, synced, fix };
    })
    .sort((a, b) => Number(a.synced) - Number(b.synced) || b.missing.length - a.missing.length || a.name.localeCompare(b.name));
}

function mapView(): Node {
  const scope = mapScope();
  const agents = shown();
  const rows = coverage(scope);
  const scopeBtn = (sc: MapScope, label: string) =>
    h('button', { class: `seg ${scope === sc ? 'active' : ''}`, type: 'button', 'aria-pressed': scope === sc ? 'true' : 'false', onClick: () => ((persisted.mapScope = sc), save(), render()) }, label);
  const gaps = rows.filter((r) => r.missing.length).length;
  const twice = rows.filter((r) => Object.values(r.cells).includes('twice')).length;

  const head = h(
    'div',
    { class: 'map-head' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Scope' }, scopeBtn('project', `Project (${inTab('project').length})`), scopeBtn('global', `Global (${inTab('global').length})`)),
    rows.length
      ? h(
          'div',
          { class: 'map-summary' },
          h('span', { class: 'sum ok-text' }, `${rows.length - gaps} fully covered`),
          h('span', { class: `sum ${gaps ? 'warn-text' : 'muted'}` }, `${gaps} with gaps`),
          h('span', { class: `sum ${twice ? 'warn-text' : 'muted'}` }, `${twice} seen twice`),
        )
      : null,
  );
  if (!rows.length) return h('div', null, head, emptyTab(scope));

  const table = h(
    'table',
    { class: 'matrix coverage' },
    h('thead', null, h('tr', null, h('th', null, 'Skill'), ...agents.map((a) => h('th', { class: `c ${isHost(a.id) ? 'host' : ''}` }, swatch(a.id), short(a.displayName))), h('th', null, ''))),
    h(
      'tbody',
      null,
      rows.map((r, i) => [
        r.synced && !rows[i - 1]?.synced
          ? h('tr', { class: 'group-row' }, h('td', { colspan: String(agents.length + 2) }, 'Synced from claude.ai', h('span', { class: 'muted' }, ' — read-only; managed by Claude Code')))
          : null,
        h(
          'tr',
          null,
          h('td', null, h('button', { class: 'linkish', type: 'button', onClick: () => selectSkill(r.copies[0].id) }, r.name), r.copies.length > 1 ? h('span', { class: 'small muted' }, ` ×${r.copies.length}`) : null),
          ...agents.map((a) => {
            const st = r.cells[a.id];
            const where = r.copies.map((c) => c.locationLabel).join(', ');
            const title =
              st === 'ok' ? `${a.displayName} loads it from ${r.copies.filter((c) => c.visibleTo.includes(a.id)).map((c) => c.locationLabel).join(', ')}`
              : st === 'twice' ? `${a.displayName} sees two different skills named "${r.name}" — see Merge suggestions`
              : `${a.displayName} doesn't read ${where}`;
            return h('td', { class: `c cell ${st} ${isHost(a.id) ? 'host' : ''}`, title, 'aria-label': title }, st === 'ok' ? icon('check') : st === 'twice' ? '2×' : icon('close'));
          }),
          h(
            'td',
            { class: 'act' },
            r.fix
              ? button(`Copy to ${r.fix.location.label}`, () => send({ type: 'copyTo', skillId: r.fix!.source.id, locationId: r.fix!.location.id }), {
                  kind: 'secondary',
                  title: `Adds it for ${r.fix.gains.map(providerName).join(', ')} (asks for confirmation)`,
                })
              : r.missing.length && r.synced
                ? h('span', { class: 'small muted', title: 'Copying it would create a copy that claude.ai never updates. Other agents can only use it if you copy it by hand.' }, 'claude.ai only')
                : r.missing.length
                  ? h('span', { class: 'small muted', title: 'No writable folder of this scope is read by the missing agents' }, 'no folder for it')
                  : null,
          ),
        ),
      ]),
    ),
  );

  return h(
    'div',
    { class: 'map' },
    head,
    h('section', { class: 'panel' }, h('h2', null, 'Coverage'), h('p', { class: 'muted small' }, 'Which installed agent can use each skill. Hover a cell for the reason; the button copies the skill to the folder that closes the gap.'), h('div', { class: 'scroll-x' }, table)),
    h('section', { class: 'panel' }, h('h2', null, 'How agents reach each skill'), h('p', { class: 'muted small' }, 'Agent → folder it reads → skill inside. Hover to trace a path, click a skill to open it.'), flowDiagram(scope)),
  );
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag: string, attrs: Record<string, string | number>, ...children: Array<Node | string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** Three columns (agents, folders, skills) joined by curves; pure SVG, colors from theme tokens via CSS classes. */
function flowDiagram(scope: MapScope): Node {
  const s = state!;
  const agents = shown();
  const skills = inTab(scope).slice().sort((a, b) => a.locationId.localeCompare(b.locationId) || a.name.localeCompare(b.name));
  const folders = s.locations.filter((l) => skills.some((k) => k.locationId === l.id));
  const ROW = 30, NODE_H = 22, W = 860, PAD = 14;
  const col = { agent: { x: 0, w: 150 }, folder: { x: 300, w: 230 }, skill: { x: 660, w: 200 } };
  const rows = Math.max(agents.length, folders.length, skills.length);
  const H = rows * ROW + PAD * 2;
  const yFor = (i: number, n: number) => PAD + ((rows - n) * ROW) / 2 + i * ROW + (ROW - NODE_H) / 2;

  const pos = new Map<string, { y: number; x: number; w: number }>();
  agents.forEach((a, i) => pos.set(`a:${a.id}`, { ...col.agent, y: yFor(i, agents.length) }));
  folders.forEach((l, i) => pos.set(`f:${l.id}`, { ...col.folder, y: yFor(i, folders.length) }));
  skills.forEach((k, i) => pos.set(`s:${k.id}`, { ...col.skill, y: yFor(i, skills.length) }));

  const links: Array<{ from: string; to: string; cls: string }> = [];
  agents.forEach((a, i) => folders.forEach((l) => l.readers.includes(a.id) && links.push({ from: `a:${a.id}`, to: `f:${l.id}`, cls: `c-${agentColor(a.id, i)}` })));
  skills.forEach((k) => links.push({ from: `f:${k.locationId}`, to: `s:${k.id}`, cls: 'neutral' }));

  // Everything connected to a node, following links both ways but never "through" a folder sideways.
  const neighbours = (id: string): Set<string> => {
    const out = new Set([id]);
    const kind = id[0];
    if (kind === 'a') links.filter((l) => l.from === id).forEach((l) => (out.add(l.to), links.filter((m) => m.from === l.to).forEach((m) => out.add(m.to))));
    if (kind === 'f') links.filter((l) => l.to === id || l.from === id).forEach((l) => (out.add(l.from), out.add(l.to)));
    if (kind === 's') links.filter((l) => l.to === id).forEach((l) => (out.add(l.from), links.filter((m) => m.to === l.from).forEach((m) => out.add(m.from))));
    return out;
  };

  // Fixed pixel size (scales down to fit, never up, so text stays at UI size).
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'flow', role: 'img', 'aria-label': `Diagram: ${agents.length} agents, ${folders.length} folders, ${skills.length} skills. The Coverage table above has the same information.` });
  const edgeLayer = svg('g', { class: 'edges' });
  const nodeLayer = svg('g', { class: 'nodes' });
  root.append(edgeLayer, nodeLayer);

  const edgeEls: Array<{ el: SVGElement; from: string; to: string }> = [];
  for (const l of links) {
    const a = pos.get(l.from)!, b = pos.get(l.to)!;
    const x1 = a.x + a.w, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
    const el = svg('path', { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, class: `edge ${l.cls}` });
    edgeLayer.append(el);
    edgeEls.push({ el, from: l.from, to: l.to });
  }

  const nodeEls = new Map<string, SVGElement>();
  const focus = (id?: string) => {
    if (!id) {
      root.classList.remove('focused');
      return;
    }
    const set = neighbours(id);
    root.classList.add('focused');
    nodeEls.forEach((el, k) => el.classList.toggle('hl', set.has(k)));
    edgeEls.forEach((e) => e.el.classList.toggle('hl', set.has(e.from) && set.has(e.to)));
  };
  const node = (id: string, label: string, title: string, cls: string, onClick?: () => void) => {
    const p = pos.get(id)!;
    const g = svg('g', { class: `node ${cls}`, transform: `translate(${p.x},${p.y})`, ...(onClick ? { tabindex: 0, role: 'button' } : {}) },
      svg('title', {}, title),
      svg('rect', { width: p.w, height: NODE_H, rx: 5 }),
      svg('text', { x: 10, y: NODE_H / 2 + 4 }, label));
    g.addEventListener('mouseenter', () => focus(id));
    g.addEventListener('mouseleave', () => focus());
    g.addEventListener('focus', () => focus(id));
    g.addEventListener('blur', () => focus());
    if (onClick) {
      g.addEventListener('click', onClick);
      g.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && onClick());
    }
    nodeEls.set(id, g);
    nodeLayer.append(g);
  };
  agents.forEach((a, i) => node(`a:${a.id}`, clip(a.displayName, 20), `${a.displayName}${isHost(a.id) ? ' (this editor)' : ''}`, `agent c-${agentColor(a.id, i)} ${isHost(a.id) ? 'host' : ''}`));
  folders.forEach((l) => node(`f:${l.id}`, clip(l.label, 32), `${l.label}\nRead by: ${l.readers.map(providerName).join(', ')}`, `folder ${l.readOnly ? 'ro' : ''}`));
  skills.forEach((k) => {
    const dup = k.issues.some((i) => i.code.startsWith('duplicate:'));
    const reached = agents.filter((a) => k.visibleTo.includes(a.id)).length;
    node(`s:${k.id}`, clip(k.name, 26), `${k.name}\n${reached ? `Used by ${agents.filter((a) => k.visibleTo.includes(a.id)).map((a) => a.displayName).join(', ')}` : 'No installed agent uses it'}${dup ? '\nSame name in another folder' : ''}`, `skill ${dup ? 'dup' : ''} ${reached ? '' : 'orphan'}`, () => selectSkill(k.id));
  });

  const legend = h(
    'div',
    { class: 'legend small muted' },
    agents.map((a, i) => h('span', null, h('span', { class: `swatch c-${agentColor(a.id, i)}` }), a.displayName)),
    h('span', null, h('span', { class: 'swatch dupe' }), 'same name in two folders'),
    h('span', null, h('span', { class: 'swatch orphan' }), 'no installed agent uses it'),
  );
  return h('div', { class: 'flow-wrap' }, h('div', { class: 'scroll-x' }, root), legend);
}

// ---------- install ----------
function writableTargets(): ResolvedLocation[] {
  return state!.locations.filter((l) => !l.readOnly && l.scope !== 'admin' && !(l.origin && !l.exists) && !(l.readers.length === 1 && l.readers[0] === 'custom' && !l.exists));
}

function defaultTarget(): string {
  const t = writableTargets();
  const best = [...t].sort((a, b) => b.readers.length - a.readers.length || (a.scope === 'global' ? -1 : 1) - (b.scope === 'global' ? -1 : 1))[0];
  return best?.id ?? '';
}

function installView(): Node {
  const s = state!;
  const inspecting = busy.has('inspect');
  const input = h('input', {
    type: 'url',
    id: 'url',
    class: 'url',
    placeholder: 'https://github.com/owner/repo  or  …/tree/main/path/to/skill',
    value: persisted.url,
    'aria-label': 'GitHub URL',
    onInput: (e: Event) => {
      persisted.url = (e.target as HTMLInputElement).value;
      save();
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') analyze();
    },
  });
  const step1 = h(
    'section',
    { class: 'panel' },
    h('h2', null, '1 · Paste a GitHub URL'),
    h('p', { class: 'muted small' }, 'A repository, or a folder inside one. The repository is only read; nothing is installed or executed until you confirm.'),
    h('div', { class: 'inline' }, input, button(inspecting ? 'Analyzing…' : 'Analyze', analyze, { kind: 'primary', disabled: inspecting })),
    s.githubSignedIn
      ? h('p', { class: 'small ok' }, icon('pass'), ' Using your GitHub sign-in (higher rate limit, private repos you can access).')
      : h('p', { class: 'small muted' }, 'Not signed in to GitHub: limited to 60 API requests/hour and public repositories. ', button('Sign in', () => send({ type: 'signIn', privateRepos: false }), { kind: 'link' }), ' · ', button('Sign in with private repo access', () => send({ type: 'signIn', privateRepos: true }), { kind: 'link' })),
    errors['inspect'] ? h('div', { class: 'banner error' }, errors['inspect']) : null,
  );

  if (install.phase === 'done' && install.done) {
    return h(
      'div',
      { class: 'install' },
      h(
        'section',
        { class: 'panel success' },
        h('h2', null, icon('pass-filled', 'ok'), ' Installed'),
        h('p', null, `${install.done.names.join(', ')} → ${install.done.locationLabel}`),
        h('div', { class: 'inline' }, button('View skills', () => {
          const target = state?.locations.find((l) => l.label === install.done?.locationLabel);
          persisted.tab = target?.scope === 'workspace' ? 'project' : 'global';
          save();
          render();
        }, { kind: 'primary' }), button('Install more', () => resetInstall())),
      ),
    );
  }

  const parts: Node[] = [step1];
  const insp = install.inspection;
  if (insp) parts.push(step2(insp));
  if (install.phase === 'staged' && install.staged) parts.push(step3(install.staged));
  return h('div', { class: 'install' }, parts);
}

function analyze() {
  if (!persisted.url.trim()) return;
  errors['inspect'] = undefined;
  install.phase = 'idle';
  install.inspection = null;
  install.staged = null;
  send({ type: 'inspect', url: persisted.url.trim() });
  render();
}

function resetInstall() {
  install.phase = 'idle';
  install.inspection = null;
  install.staged = null;
  install.done = null;
  install.selected.clear();
  persisted.url = '';
  save();
  send({ type: 'cancelInstall' });
  render();
}

function candidateCard(c: ViewCandidate): Node {
  const checked = install.selected.has(c.id);
  const expanded = install.expanded.has(c.id);
  const worst = c.findings.some((f) => f.severity === 'high') ? 'high' : c.findings.some((f) => f.severity === 'warning') ? 'warning' : '';
  return h(
    'div',
    { class: `cand ${checked ? 'checked' : ''} ${c.installable ? '' : 'blocked'}` },
    h(
      'label',
      { class: 'cand-head' },
      h('input', {
        type: 'checkbox',
        checked,
        disabled: !c.installable || install.phase === 'staged',
        onChange: (e: Event) => {
          if ((e.target as HTMLInputElement).checked) install.selected.add(c.id);
          else install.selected.delete(c.id);
          render();
        },
      }),
      h('span', { class: 'name' }, c.installName),
      c.repoDir ? h('span', { class: 'mono small muted' }, c.repoDir) : h('span', { class: 'mono small muted' }, '(repository root)'),
      chip(`${c.fileCount} file${c.fileCount === 1 ? '' : 's'} · ${fmtBytes(c.totalBytes)}`, 'subtle'),
      worst ? chip(worst === 'high' ? 'high-risk findings' : 'review findings', worst === 'high' ? 'danger' : 'warn') : null,
    ),
    c.description ? h('p', { class: 'desc' }, c.description) : h('p', { class: 'desc muted' }, 'No description'),
    !c.installable ? h('div', { class: 'banner error small' }, `Can't install: ${c.blockReason ?? ''}`) : null,
    c.issues.length ? issueList(c.issues) : null,
    c.findings.length ? findingList(c.findings) : null,
    h('button', { class: 'linkish small', type: 'button', onClick: () => (expanded ? install.expanded.delete(c.id) : install.expanded.add(c.id), render()) }, expanded ? '▾ Hide content' : '▸ Preview SKILL.md and files'),
    expanded
      ? h(
          'div',
          { class: 'preview' },
          h('pre', { class: 'body' }, c.skillMdPreview || '(empty)'),
          h('h4', null, 'Files'),
          h('ul', { class: 'files' }, c.files.map((f) => h('li', { class: 'mono' }, f))),
          c.skipped.length ? [h('h4', null, 'Skipped'), h('ul', { class: 'files' }, c.skipped.map((x) => h('li', { class: 'mono' }, `${x.path} — ${x.reason}`)))] : null,
        )
      : null,
  );
}

function step2(insp: ViewInspection): Node {
  const staging = busy.has('stage');
  const installable = insp.candidates.filter((c) => c.installable);
  const n = install.selected.size;
  return h(
    'section',
    { class: 'panel' },
    h('h2', null, `2 · Choose skills (${insp.candidates.length} found)`),
    h('p', { class: 'muted small mono' }, `${insp.owner}/${insp.repo} @ ${insp.ref} · commit ${insp.commit.slice(0, 7)}${insp.subpath ? ' · ' + insp.subpath : ''}`),
    insp.notes.map((n) => h('div', { class: 'banner warn small' }, n)),
    installable.length > 1 && install.phase !== 'staged'
      ? h('div', { class: 'inline small' }, button('Select all', () => (installable.forEach((c) => install.selected.add(c.id)), render()), { kind: 'link' }), button('Select none', () => (install.selected.clear(), render()), { kind: 'link' }))
      : null,
    h('div', { class: 'cands' }, insp.candidates.map(candidateCard)),
    install.phase !== 'staged'
      ? h(
          'div',
          { class: 'inline' },
          button(staging ? 'Downloading…' : `Download & review ${n} skill${n === 1 ? '' : 's'}`, () => {
            errors['stage'] = undefined;
            send({ type: 'stage', candidateIds: [...install.selected] });
          }, { kind: 'primary', disabled: n === 0 || staging }),
          button('Cancel', resetInstall),
        )
      : null,
    errors['stage'] ? h('div', { class: 'banner error' }, errors['stage']) : null,
  );
}

function step3(staged: ViewStaged[]): Node {
  const s = state!;
  const targets = writableTargets();
  if (!install.targetId || !targets.some((t) => t.id === install.targetId)) install.targetId = defaultTarget();
  const target = targets.find((t) => t.id === install.targetId);
  const installing = busy.has('install');
  const existing = target ? s.skills.filter((sk) => sk.locationId === target.id && staged.some((st) => st.installName === sk.dirName)) : [];
  const findings = staged.flatMap((x) => x.findings.map((f) => ({ ...f, file: `${x.installName}/${f.file}` })));
  const sel = h(
    'select',
    {
      class: 'target',
      'aria-label': 'Install location',
      onChange: (e: Event) => {
        install.targetId = (e.target as HTMLSelectElement).value;
        render();
      },
    },
    (['workspace', 'global'] as const).map((scope) => {
      const group = targets.filter((t) => t.scope === scope);
      if (!group.length) return null;
      return h(
        'optgroup',
        { label: scope === 'workspace' ? 'This workspace' : 'Global (all projects)' },
        group.map((t) => h('option', { value: t.id, selected: t.id === install.targetId ? true : undefined }, `${t.label} — ${t.readers.map(providerName).join(', ')}${t.exists ? '' : ' (new folder)'}`)),
      );
    }),
  );
  return h(
    'section',
    { class: 'panel' },
    h('h2', null, '3 · Review and install'),
    h('p', { class: 'muted small' }, `Downloaded ${staged.reduce((a, x) => a + x.fileCount, 0)} files (${fmtBytes(staged.reduce((a, x) => a + x.bytes, 0))}) to a private staging folder and checked every file.`),
    h('h3', null, 'Automatic checks'),
    findingList(findings),
    h('h3', null, 'Where to install'),
    targets.length ? h('div', null, sel) : h('p', { class: 'banner warn' }, 'No writable skill folders available.'),
    target
      ? h('div', { class: 'vis big' }, shown().map((p) => agentPill(p.id, target.readers.includes(p.id))))
      : null,
    target ? h('p', { class: 'mono small muted' }, target.path) : null,
    existing.length ? h('div', { class: 'banner warn small' }, `Already in this folder: ${existing.map((x) => x.name).join(', ')}. Installing replaces them; the current version is kept as a backup.`) : null,
    h('div', { class: 'inline' }, button(installing ? 'Installing…' : 'Install…', () => {
      errors['install'] = undefined;
      send({ type: 'install', locationId: install.targetId });
    }, { kind: 'primary', disabled: !target || installing }), button('Cancel', resetInstall)),
    errors['install'] ? h('div', { class: 'banner error' }, errors['install']) : null,
  );
}

// ---------- messages ----------
window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'state':
      staleHost = m.state.buildId !== __BUILD_ID__;
      // Tolerate a host from an older build (e.g. right after reinstalling without reloading).
      state = { ...m.state, host: m.state.host ?? { appName: '' }, agents: m.state.agents ?? {}, merges: m.state.merges ?? [], skills: m.state.skills.map((x) => ({ ...x, fixes: x.fixes ?? [] })) };
      // Files may have changed on disk: refetch the open detail.
      if (detail) requestedDetail = undefined;
      detail = detail && state.skills.some((x) => x.id === detail!.id) ? detail : null;
      if (persisted.selected && !state.skills.some((s) => s.id === persisted.selected)) persisted.selected = undefined;
      break;
    case 'focus':
      if (m.tab) persisted.tab = m.tab === 'skills' ? 'project' : m.tab;
      if (m.skillId) {
        const sk = state?.skills.find((x) => x.id === m.skillId);
        if (sk) persisted.tab = tabOf(sk);
        persisted.selected = m.skillId;
        detail = null;
        requestedDetail = undefined;
        persisted.q = '';
        persisted.provider = persisted.status = 'all';
      }
      if (m.url) persisted.url = m.url;
      save();
      if (m.autoInspect && m.url) {
        render();
        analyze();
        return;
      }
      break;
    case 'detail':
      detail = m.detail;
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
