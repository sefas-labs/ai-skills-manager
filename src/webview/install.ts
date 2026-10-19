/* Dashboard webview — install. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { Finding } from '../core/inspector';
import type { ResolvedLocation } from '../core/types';
import type { ViewCandidate, ViewInspection, ViewStaged } from '../shared/protocol';
import { catalogView } from './catalog';
import { render } from './main';
import { busy, errors, install, persisted, save, send, ui } from './store';
import { button, chip, h, icon, sevIcon } from './dom';
import { agentPill, fmtBytes, providerName, short, shown } from './agents';
import { issueList } from './skills';

export function findingList(findings: Finding[]) {
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

export function writableTargets(): ResolvedLocation[] {
  return ui.state!.locations.filter((l) => !l.readOnly && l.scope !== 'admin' && !(l.origin && !l.exists) && !(l.readers.length === 1 && l.readers[0] === 'custom' && !l.exists));
}

/** Agents shown in the dashboard (the installed ones) that read a folder. */
const reach = (t: ResolvedLocation) => t.readers.filter((r) => shown().some((p) => p.id === r));

/** Best folder of a scope: reaches the most installed agents; an existing folder wins ties. */
export function recommendedTarget(scope: 'workspace' | 'global'): ResolvedLocation | undefined {
  return writableTargets()
    .filter((t) => t.scope === scope && !t.origin)
    .sort((a, b) => reach(b).length - reach(a).length || Number(b.exists) - Number(a.exists) || b.readers.length - a.readers.length)[0];
}

export function defaultTarget(): string {
  return (recommendedTarget('global') ?? recommendedTarget('workspace'))?.id ?? '';
}

export function installView(): Node {
  // An install in progress always shows the URL flow; otherwise browse by default.
  const mode = install.phase !== 'idle' ? 'url' : (persisted.installMode ?? 'browse');
  const seg = (m: 'browse' | 'url', label: string, ic: string) =>
    h('button', { class: `seg ${mode === m ? 'active' : ''}`, type: 'button', 'aria-pressed': mode === m ? 'true' : 'false', onClick: () => ((persisted.installMode = m), save(), render()) }, icon(ic), ` ${label}`);
  const head = h('div', { class: 'install-head' }, h('div', { class: 'segmented', role: 'group', 'aria-label': 'Install from' }, seg('browse', 'Browse catalog', 'library'), seg('url', 'From a URL', 'link')));
  if (mode === 'browse') return h('div', { class: 'install' }, head, catalogView());
  return h('div', { class: 'install' }, head, urlFlow());
}

function urlFlow(): Node {
  const s = ui.state!;
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
          const target = ui.state?.locations.find((l) => l.label === install.done?.locationLabel);
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

export function analyze() {
  if (!persisted.url.trim()) return;
  persisted.installMode = 'url';
  errors['inspect'] = undefined;
  install.phase = 'idle';
  install.inspection = null;
  install.staged = null;
  send({ type: 'inspect', url: persisted.url.trim() });
  render();
}

export function resetInstall() {
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

export function candidateCard(c: ViewCandidate): Node {
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

export function step2(insp: ViewInspection): Node {
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

export function step3(staged: ViewStaged[]): Node {
  const s = ui.state!;
  const targets = writableTargets();
  if (!install.targetId || !targets.some((t) => t.id === install.targetId)) install.targetId = defaultTarget();
  const target = targets.find((t) => t.id === install.targetId);
  const installing = busy.has('install');
  // Only skills directly in the folder get replaced (not claude.ai synced ones or category sub-folders).
  const existing = target ? s.skills.filter((sk) => sk.locationId === target.id && !sk.managed && !sk.group && !sk.namespace && staged.some((st) => st.installName === sk.dirName)) : [];
  const findings = staged.flatMap((x) => x.findings.map((f) => ({ ...f, file: `${x.installName}/${f.file}` })));
  // Two clear choices (project / all projects), each with its recommended folder; any other folder is one click away.
  const choice = (scope: 'workspace' | 'global', title: string, sub: string) => {
    const t = recommendedTarget(scope);
    if (!t) return null;
    const active = install.targetId === t.id;
    return h(
      'button',
      { class: `target-card ${active ? 'active' : ''}`, type: 'button', 'aria-pressed': active ? 'true' : 'false', onClick: () => ((install.targetId = t.id), render()) },
      h('div', { class: 'target-title' }, icon(scope === 'workspace' ? 'root-folder' : 'home'), ` ${title}`),
      h('div', { class: 'small muted' }, sub),
      h('div', { class: 'mono small' }, t.label, t.exists ? '' : ' (will be created)'),
      h('div', { class: 'vis' }, shown().map((p) => agentPill(p.id, t.readers.includes(p.id), short(p.displayName)))),
    );
  };
  const recommendedIds = new Set([recommendedTarget('workspace')?.id, recommendedTarget('global')?.id]);
  const covered = new Set(targets.filter((t) => recommendedIds.has(t.id)).flatMap(reach));
  // Other folders: the ones that exist, plus new ones only when they add an installed agent the recommended ones don't reach.
  const others = targets.filter((t) => !recommendedIds.has(t.id) && (t.exists || reach(t).some((r) => !covered.has(r))));
  const otherList = install.showAllTargets
    ? h(
        'div',
        { class: 'target-others', role: 'radiogroup', 'aria-label': 'Other folders' },
        others.map((t) =>
          h(
            'label',
            { class: `target-row ${install.targetId === t.id ? 'active' : ''}` },
            h('input', { type: 'radio', name: 'target', checked: install.targetId === t.id ? true : undefined, onChange: () => ((install.targetId = t.id), render()) }),
            h('span', { class: 'mono small' }, t.label),
            h('span', { class: 'small muted' }, `${t.scope === 'workspace' ? 'project' : 'global'}${t.exists ? '' : ' · new folder'} · ${t.readers.map(providerName).join(', ')}`),
          ),
        ),
        others.length ? null : h('p', { class: 'small muted' }, 'No other folder adds an agent you have installed.'),
      )
    : null;
  const sel = h(
    'div',
    { class: 'target-choice' },
    h('div', { class: 'target-cards' }, choice('workspace', 'This project', 'Shared with everyone who clones the repository'), choice('global', 'All my projects', 'Only on this machine, in every project')),
    others.length || install.showAllTargets
      ? button(install.showAllTargets ? 'Hide other folders' : `Choose another folder… (${others.length})`, () => ((install.showAllTargets = !install.showAllTargets), render()), { kind: 'link' })
      : null,
    otherList,
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
    target && !recommendedIds.has(target.id) ? h('div', { class: 'vis big' }, shown().map((p) => agentPill(p.id, target.readers.includes(p.id)))) : null,
    target ? h('p', { class: 'mono small muted' }, target.path) : null,
    existing.length ? h('div', { class: 'banner warn small' }, `Already in this folder: ${existing.map((x) => x.name).join(', ')}. Installing replaces them; the current version is kept as a backup.`) : null,
    h('div', { class: 'inline' }, button(installing ? 'Installing…' : 'Install…', () => {
      errors['install'] = undefined;
      send({ type: 'install', locationId: install.targetId });
    }, { kind: 'primary', disabled: !target || installing }), button('Cancel', resetInstall)),
    errors['install'] ? h('div', { class: 'banner error' }, errors['install']) : null,
  );
}

