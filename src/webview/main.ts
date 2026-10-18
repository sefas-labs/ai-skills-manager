/* Dashboard webview. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { Finding } from '../core/inspector';
import type { Issue, ResolvedLocation } from '../core/types';
import type {
  HostToWebview,
  ViewCandidate,
  ViewInspection,
  ViewSkill,
  ViewSkillDetail,
  ViewStaged,
  ViewState,
  WebviewToHost,
} from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const api = acquireVsCodeApi();

type Tab = 'overview' | 'skills' | 'install';
interface Persisted {
  tab: Tab;
  q: string;
  provider: string;
  scope: string;
  status: string;
  selected?: string;
  url: string;
}

const persisted: Persisted = { tab: 'overview', q: '', provider: 'all', scope: 'all', status: 'all', url: '', ...((api.getState() as Partial<Persisted>) ?? {}) };
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

const providerName = (id: string) => state?.providers.find((p) => p.id === id)?.displayName ?? (id === 'custom' ? 'Custom' : id);
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const problems = (s: ViewSkill) => s.issues.filter((i) => i.severity !== 'info');

function chip(text: string, kind = '', title?: string) {
  return h('span', { class: `chip ${kind}`, title }, text);
}

function sevIcon(sev: string) {
  const map: Record<string, string> = { error: '●', high: '●', warning: '▲', info: 'ℹ' };
  return h('span', { class: `sev sev-${sev}`, 'aria-label': sev }, map[sev] ?? '•');
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

function render(): void {
  app.removeAttribute('aria-busy');
  // Keep keyboard focus (e.g. in the search box) across re-renders triggered by file changes.
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active?.id;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const general = errors['general'];
  app.replaceChildren(
    header(),
    ...(state && !state.trusted ? [h('div', { class: 'banner warn' }, 'Restricted Mode: this workspace is not trusted, so workspace skills are read-only.')] : []),
    ...(general ? [h('div', { class: 'banner error' }, general, ' ', button('Dismiss', () => ((errors['general'] = undefined), render()), { kind: 'link' }))] : []),
    h('main', { id: 'view' }, body()),
  );
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
  const scanned = state ? new Date(state.scannedAt).toLocaleTimeString() : '';
  const tab = (id: Tab, label: string) =>
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
      label,
    );
  return h(
    'header',
    { class: 'top' },
    h('div', { class: 'brand' }, h('div', { class: 'logo', 'aria-hidden': 'true' }), h('div', null, h('h1', null, 'AI Skills'), h('p', { class: 'muted small' }, state ? `${total} skill${total === 1 ? '' : 's'} · scanned ${scanned}` : 'Scanning…'))),
    h('nav', { class: 'tabs', role: 'tablist' }, tab('overview', 'Overview'), tab('skills', `Skills${state ? ` (${total})` : ''}`), tab('install', 'Install from GitHub')),
    h('button', { class: `btn icon ${busy.has('refresh') ? 'spin' : ''}`, title: 'Rescan skill folders', 'aria-label': 'Refresh', onClick: () => send({ type: 'refresh' }) }, '↻'),
  );
}

function body(): Node {
  if (!state) return h('div', { class: 'empty' }, h('p', null, 'Scanning skill folders…'));
  if (persisted.tab === 'skills') return skillsView();
  if (persisted.tab === 'install') return installView();
  return overview();
}

// ---------- overview ----------
function overview(): Node {
  const s = state!;
  const ws = s.skills.filter((x) => x.scope === 'workspace').length;
  const gl = s.skills.filter((x) => x.scope !== 'workspace').length;
  const withProblems = s.skills.filter((x) => problems(x).length).length;
  const dupes = new Set(s.providers.flatMap((p) => p.duplicateNames)).size;
  const stat = (n: number, label: string, kind = '', onClick?: () => void) =>
    h(onClick ? 'button' : 'div', { class: `stat ${kind}`, onClick, type: onClick ? 'button' : undefined }, h('div', { class: 'num' }, String(n)), h('div', { class: 'muted small' }, label));

  const goProblems = () => {
    persisted.tab = 'skills';
    persisted.status = 'problems';
    save();
    render();
  };

  // Parent/nested folders are only interesting when they exist.
  const locs = s.locations.filter((l) => l.exists || (l.scope !== 'admin' && !l.origin));
  const matrix = h(
    'table',
    { class: 'matrix' },
    h('thead', null, h('tr', null, h('th', null, 'Folder'), ...s.providers.map((p) => h('th', { class: 'c' }, p.displayName)), h('th', { class: 'c' }, 'Skills'))),
    h(
      'tbody',
      null,
      locs.map((l) =>
        h(
          'tr',
          { class: l.exists ? '' : 'dim' },
          h('td', null, h('div', { class: 'mono' }, l.label), h('div', { class: 'small muted' }, l.scope + (l.origin === 'nested' ? ` · nested, for ${l.appliesTo}/` : l.origin === 'parent' ? ' · parent folder' : '') + (l.exists ? '' : ' · not created') + (l.readOnly ? ' · read-only' : ''))),
          ...s.providers.map((p) => h('td', { class: 'c' }, l.readers.includes(p.id) ? h('span', { class: 'dot on', title: `${p.displayName} loads skills from here` }, '●') : h('span', { class: 'dot off' }, '·'))),
          h('td', { class: 'c' }, l.exists ? String(l.skillCount) : '—'),
        ),
      ),
    ),
  );

  const providerCards = h(
    'div',
    { class: 'cards' },
    s.providers.map((p) =>
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, p.displayName), button('Docs ↗', () => send({ type: 'openDocs', providerId: p.id }), { kind: 'link' })),
        h('div', { class: 'num' }, String(p.visibleSkills)),
        h('div', { class: 'muted small' }, 'skills visible'),
        p.duplicateNames.length ? h('p', { class: 'warn-text small' }, `Duplicates: ${p.duplicateNames.join(', ')}`) : null,
        p.disableHint ? h('p', { class: 'small muted hint' }, h('strong', null, 'Disable: '), p.disableHint) : null,
      ),
    ),
  );

  const problemSkills = s.skills.filter((x) => problems(x).length).slice(0, 8);
  return h(
    'div',
    { class: 'overview' },
    h('div', { class: 'stats' }, stat(s.skills.length, 'skills found'), stat(ws, 'in this workspace'), stat(gl, 'global / admin'), stat(withProblems, 'with problems', withProblems ? 'warn' : '', withProblems ? goProblems : undefined), stat(dupes, 'duplicate names', dupes ? 'warn' : '')),
    h('section', { class: 'panel' }, h('h2', null, 'Which agent loads which folder'), h('p', { class: 'muted small' }, 'Based on each provider’s official documentation. A skill is available to an agent only if it sits in a folder that agent reads.'), h('div', { class: 'scroll-x' }, matrix)),
    h('h2', null, 'Agents'),
    providerCards,
    problemSkills.length
      ? h(
          'section',
          { class: 'panel' },
          h('h2', null, 'Needs attention'),
          h(
            'ul',
            { class: 'plain' },
            problemSkills.map((sk) =>
              h(
                'li',
                null,
                h(
                  'button',
                  {
                    class: 'linkish',
                    type: 'button',
                    onClick: () => selectSkill(sk.id),
                  },
                  sk.name,
                ),
                h('span', { class: 'muted small' }, ` — ${problems(sk)[0].message}`),
              ),
            ),
          ),
        )
      : null,
    s.skills.length === 0
      ? h(
          'section',
          { class: 'panel empty' },
          h('h2', null, 'No skills yet'),
          h('p', { class: 'muted' }, 'Skills are folders with a SKILL.md file. Install some from a GitHub repository to get started.'),
          button('Install from GitHub', () => {
            persisted.tab = 'install';
            save();
            render();
          }, { kind: 'primary' }),
        )
      : null,
  );
}

// ---------- skills ----------
function selectSkill(id: string) {
  persisted.tab = 'skills';
  persisted.selected = id;
  detail = null;
  requestedDetail = undefined;
  save();
  render();
}

function filtered(): ViewSkill[] {
  const q = persisted.q.trim().toLowerCase();
  return state!.skills
    .filter((s) => persisted.provider === 'all' || s.visibleTo.includes(persisted.provider))
    .filter((s) => persisted.scope === 'all' || s.scope === persisted.scope)
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

function skillsView(): Node {
  const s = state!;
  const listEl = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Skills' });
  const fillList = () => {
    const items = filtered();
    listEl.replaceChildren(
      ...(items.length
        ? items.map((sk) => {
            const p = problems(sk);
            const worst = p.some((i) => i.severity === 'error') ? 'error' : p.length ? 'warning' : '';
            return h(
              'button',
              {
                class: `row ${persisted.selected === sk.id ? 'selected' : ''}`,
                role: 'option',
                'aria-selected': persisted.selected === sk.id ? 'true' : 'false',
                type: 'button',
                onClick: () => selectSkill(sk.id),
              },
              h('div', { class: 'row-head' }, worst ? sevIcon(worst) : null, h('span', { class: 'name' }, sk.name), chip(sk.scope, `scope-${sk.scope}`), sk.isSymlink ? chip('link', 'subtle', `→ ${sk.realDir}`) : null, sk.readOnly ? chip('read-only', 'subtle') : null, sk.update?.status === 'update-available' ? chip('update', 'update', 'A newer version is available on GitHub') : null),
              sk.description ? h('div', { class: 'desc' }, sk.description) : h('div', { class: 'desc muted' }, 'No description'),
              h('div', { class: 'row-foot' }, h('span', { class: 'mono small muted' }, sk.locationLabel), h('span', { class: 'vis' }, s.providers.map((pr) => h('span', { class: `pill ${sk.visibleTo.includes(pr.id) ? 'on' : 'off'}`, title: `${pr.displayName}: ${sk.visibleTo.includes(pr.id) ? 'loads it' : 'does not load it'}` }, short(pr.displayName))))),
            );
          })
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
    select(persisted.provider, [['all', 'All agents'], ...s.providers.map((p) => [p.id, p.displayName] as [string, string])], (v) => ((persisted.provider = v), save(), fillList()), 'Agent'),
    select(persisted.scope, [['all', 'All scopes'], ['workspace', 'Workspace'], ['global', 'Global'], ['admin', 'Admin']], (v) => ((persisted.scope = v), save(), fillList()), 'Scope'),
    select(persisted.status, [['all', 'Any status'], ['problems', 'With problems'], ['links', 'Symlinks'], ['readonly', 'Read-only'], ['github', 'From GitHub (tracked)'], ['updates', 'Updates available']], (v) => ((persisted.status = v), save(), fillList()), 'Status'),
  );

  const selected = s.skills.find((x) => x.id === persisted.selected);
  if (selected && (!detail || detail.id !== selected.id) && requestedDetail !== selected.id) {
    requestedDetail = selected.id;
    send({ type: 'getDetail', skillId: selected.id });
  }
  return h('div', { class: 'skills' }, toolbar, h('div', { class: 'split' }, listEl, h('aside', { class: 'detail', 'aria-live': 'polite' }, selected ? skillDetail(selected) : h('div', { class: 'empty muted' }, 'Select a skill to see where it lives, who loads it and what it contains.'))));
}

function short(name: string): string {
  return ({ 'Claude Code': 'Claude', 'GitHub Copilot': 'Copilot' } as Record<string, string>)[name] ?? name;
}

function skillDetail(sk: ViewSkill): Node {
  const s = state!;
  const d = detail && detail.id === sk.id ? detail : null;
  return h(
    'div',
    null,
    h('div', { class: 'detail-head' }, h('h2', null, sk.name), h('div', { class: 'actions' }, button('Open SKILL.md', () => send({ type: 'openSkillFile', skillId: sk.id }), { kind: 'primary' }), button('Reveal', () => send({ type: 'reveal', skillId: sk.id })), button('Copy path', () => send({ type: 'copyPath', skillId: sk.id })), button('Copy / Move…', () => send({ type: 'copyMove', skillId: sk.id }), { title: 'Copy or move to another skills folder; shows which agents gain or lose it first' }), button('Remove…', () => send({ type: 'uninstall', skillId: sk.id }), { kind: 'danger', disabled: sk.readOnly, title: sk.readOnly ? sk.readOnlyReason : 'Remove this skill (asks for confirmation)' }))),
    sk.description ? h('p', null, sk.description) : null,
    h('h3', null, 'Available to'),
    h('div', { class: 'vis big' }, s.providers.map((p) => h('span', { class: `pill ${sk.visibleTo.includes(p.id) ? 'on' : 'off'}` }, sk.visibleTo.includes(p.id) ? '✓ ' : '✕ ', p.displayName))),
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Location'),
      h('dd', { class: 'mono' }, sk.displayDir),
      sk.isSymlink ? [h('dt', null, 'Link target'), h('dd', { class: 'mono' }, sk.realDir || '(broken)')] : null,
      h('dt', null, 'Scope'),
      h('dd', null, sk.scope + (sk.readOnly ? ` · read-only (${sk.readOnlyReason ?? ''})` : '')),
      h('dt', null, 'Source'),
      h('dd', null, sk.source ? h('span', { class: 'mono' }, `${sk.source.url} @ ${sk.source.commit.slice(0, 7)} (installed ${new Date(sk.source.installedAt).toLocaleDateString()})`) : sk.sourceHint ? `From frontmatter — ${sk.sourceHint}` : h('span', { class: 'muted' }, 'Unknown — added manually or by another tool')),
      sk.tracked ? [h('dt', null, 'Updates'), h('dd', null, updateLine(sk))] : null,
    ),
    h('h3', null, 'Checks'),
    issueList(sk.issues),
    sk.frontmatter.length ? [h('h3', null, 'Frontmatter'), h('dl', { class: 'kv' }, sk.frontmatter.map(([k, v]) => [h('dt', { class: 'mono' }, k), h('dd', null, v)]))] : null,
    h('h3', null, 'Files'),
    d
      ? h(
          'ul',
          { class: 'files' },
          d.files.map((f) => h('li', null, h('button', { class: 'linkish mono', type: 'button', onClick: () => send({ type: 'openSkillFile', skillId: sk.id, rel: f }) }, f))),
          d.truncated ? h('li', { class: 'muted' }, '…more files not shown') : null,
        )
      : h('p', { class: 'muted' }, 'Loading…'),
    h('h3', null, 'Instructions (SKILL.md body)'),
    d ? h('pre', { class: 'body' }, d.body || '(empty)') : h('p', { class: 'muted' }, 'Loading…'),
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
      ? h('p', { class: 'small ok' }, '✓ Using your GitHub sign-in (higher rate limit, private repos you can access).')
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
        h('h2', null, '✓ Installed'),
        h('p', null, `${install.done.names.join(', ')} → ${install.done.locationLabel}`),
        h('div', { class: 'inline' }, button('View skills', () => ((persisted.tab = 'skills'), save(), render()), { kind: 'primary' }), button('Install more', () => resetInstall())),
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
      ? h('div', { class: 'vis big' }, s.providers.map((p) => h('span', { class: `pill ${target.readers.includes(p.id) ? 'on' : 'off'}` }, target.readers.includes(p.id) ? '✓ ' : '✕ ', p.displayName)))
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
      state = m.state;
      // Files may have changed on disk: refetch the open detail.
      if (detail) requestedDetail = undefined;
      detail = detail && state.skills.some((x) => x.id === detail!.id) ? detail : null;
      if (persisted.selected && !state.skills.some((s) => s.id === persisted.selected)) persisted.selected = undefined;
      break;
    case 'focus':
      if (m.tab) persisted.tab = m.tab;
      if (m.skillId) {
        persisted.selected = m.skillId;
        detail = null;
        requestedDetail = undefined;
        persisted.q = '';
        persisted.provider = persisted.scope = persisted.status = 'all';
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
