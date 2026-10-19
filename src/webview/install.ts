/* Dashboard webview — Install tab: browse the catalog, or paste a GitHub URL and
 * go through analyze → choose → review → install. */
import type { Finding, FindingSeverity } from '../core/inspector';
import type { ResolvedLocation } from '../core/types';
import type { ViewCandidate, ViewInspection, ViewStaged } from '../shared/protocol';
import { catalogView } from './catalog';
import { changeView, render } from './main';
import { busy, errors, install, persisted, save, send, ui } from './store';
import { button, chip, h, icon, sevIcon } from './dom';
import { agentPill, fmtBytes, providerName, short, shown } from './agents';
import { issueList } from './skills';

type TargetScope = 'workspace' | 'global';
type InstallMode = 'browse' | 'url';

const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, warning: 1, info: 2 };
const SHORT_COMMIT_LENGTH = 7;
const CUSTOM_READER = 'custom';

function plural(count: number, singular: string): string {
  return count === 1 ? singular : singular + 's';
}

export function findingList(findings: Finding[]) {
  if (!findings.length) return h('p', { class: 'ok' }, 'No findings from the automatic checks. Still review the content before installing.');
  const bySeverity = [...findings].sort((first, second) => SEVERITY_ORDER[first.severity] - SEVERITY_ORDER[second.severity]);
  return h(
    'ul',
    { class: 'issues findings' },
    bySeverity.map((finding) =>
      h(
        'li',
        null,
        sevIcon(finding.severity),
        h(
          'div',
          null,
          h('div', null, finding.message),
          h('div', { class: 'muted small' }, finding.file + (finding.line ? `:${finding.line}` : '')),
          finding.excerpt ? h('code', { class: 'excerpt' }, finding.excerpt) : null,
        ),
      ),
    ),
  );
}

// ---------- where to install ----------

/** Folders an install can write to: not read-only or admin, and not a parent/nested or custom folder that doesn't exist yet. */
export function writableTargets(): ResolvedLocation[] {
  return ui.state!.locations.filter((location) => {
    const isMissingSpecialFolder = !!location.origin && !location.exists;
    const isOnlyCustom = location.readers.length === 1 && location.readers[0] === CUSTOM_READER;
    const isMissingCustomFolder = isOnlyCustom && !location.exists;
    return !location.readOnly && location.scope !== 'admin' && !isMissingSpecialFolder && !isMissingCustomFolder;
  });
}

/** Agents shown in the dashboard (the installed ones) that read a folder. */
function shownReaders(location: ResolvedLocation): string[] {
  return location.readers.filter((reader) => shown().some((provider) => provider.id === reader));
}

/** Best folder of a scope: reaches the most installed agents; an existing folder wins ties. */
export function recommendedTarget(scope: TargetScope): ResolvedLocation | undefined {
  return writableTargets()
    .filter((location) => location.scope === scope && !location.origin)
    .sort(
      (first, second) =>
        shownReaders(second).length - shownReaders(first).length || Number(second.exists) - Number(first.exists) || second.readers.length - first.readers.length,
    )[0];
}

export function defaultTarget(): string {
  return (recommendedTarget('global') ?? recommendedTarget('workspace'))?.id ?? '';
}

function selectTarget(locationId: string): void {
  install.targetId = locationId;
  render();
}

// ---------- tab ----------

export function installView(): Node {
  // An install in progress always shows the URL flow; otherwise browse by default.
  const mode: InstallMode = install.phase !== 'idle' ? 'url' : (persisted.installMode ?? 'browse');
  const modeButton = (value: InstallMode, label: string, iconName: string) =>
    h(
      'button',
      { class: `seg ${mode === value ? 'active' : ''}`, type: 'button', 'aria-pressed': mode === value ? 'true' : 'false', onClick: () => changeView({ installMode: value }) },
      icon(iconName),
      ` ${label}`,
    );
  const head = h(
    'div',
    { class: 'install-head' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Install from' }, modeButton('browse', 'Browse catalog', 'library'), modeButton('url', 'From a URL', 'link')),
  );
  return h('div', { class: 'install' }, head, mode === 'browse' ? catalogView() : urlFlow());
}

function signInLine(): Node {
  if (ui.state!.githubSignedIn) return h('p', { class: 'small ok' }, icon('pass'), ' Using your GitHub sign-in (higher rate limit, private repos you can access).');
  return h(
    'p',
    { class: 'small muted' },
    'Not signed in to GitHub: limited to 60 API requests/hour and public repositories. ',
    button('Sign in', () => send({ type: 'signIn', privateRepos: false }), { kind: 'link' }),
    ' · ',
    button('Sign in with private repo access', () => send({ type: 'signIn', privateRepos: true }), { kind: 'link' }),
  );
}

function urlStep(): Node {
  const inspecting = busy.has('inspect');
  const input = h('input', {
    type: 'url',
    id: 'url',
    class: 'url',
    placeholder: 'https://github.com/owner/repo  or  …/tree/main/path/to/skill',
    value: persisted.url,
    'aria-label': 'GitHub URL',
    onInput: (event: Event) => {
      persisted.url = (event.target as HTMLInputElement).value;
      save();
    },
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') analyze();
    },
  });
  return h(
    'section',
    { class: 'panel' },
    h('h2', null, '1 · Paste a GitHub URL'),
    h('p', { class: 'muted small' }, 'A repository, or a folder inside one. The repository is only read; nothing is installed or executed until you confirm.'),
    h('div', { class: 'inline' }, input, button(inspecting ? 'Analyzing…' : 'Analyze', analyze, { kind: 'primary', disabled: inspecting })),
    signInLine(),
    errors['inspect'] ? h('div', { class: 'banner error' }, errors['inspect']) : null,
  );
}

function installedPanel(done: NonNullable<typeof install.done>): Node {
  const viewSkills = () => {
    const location = ui.state?.locations.find((candidate) => candidate.label === done.locationLabel);
    changeView({ tab: location?.scope === 'workspace' ? 'project' : 'global' });
  };
  return h(
    'div',
    { class: 'install' },
    h(
      'section',
      { class: 'panel success' },
      h('h2', null, icon('pass-filled', 'ok'), ' Installed'),
      h('p', null, `${done.names.join(', ')} → ${done.locationLabel}`),
      h('div', { class: 'inline' }, button('View skills', viewSkills, { kind: 'primary' }), button('Install more', () => resetInstall())),
    ),
  );
}

function urlFlow(): Node {
  if (install.phase === 'done' && install.done) return installedPanel(install.done);
  const steps: Node[] = [urlStep()];
  if (install.inspection) steps.push(chooseStep(install.inspection));
  if (install.phase === 'staged' && install.staged) steps.push(reviewStep(install.staged));
  return h('div', { class: 'install' }, steps);
}

export function analyze() {
  const url = persisted.url.trim();
  if (!url) return;
  persisted.installMode = 'url';
  errors['inspect'] = undefined;
  install.phase = 'idle';
  install.inspection = null;
  install.staged = null;
  send({ type: 'inspect', url });
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

// ---------- step 2: choose ----------

function worstFindingOf(candidate: ViewCandidate): FindingSeverity | '' {
  if (candidate.findings.some((finding) => finding.severity === 'high')) return 'high';
  if (candidate.findings.some((finding) => finding.severity === 'warning')) return 'warning';
  return '';
}

function toggleInSet(set: Set<string>, id: string, included: boolean): void {
  if (included) set.add(id);
  else set.delete(id);
}

function candidatePreview(candidate: ViewCandidate): Node {
  return h(
    'div',
    { class: 'preview' },
    h('pre', { class: 'body' }, candidate.skillMdPreview || '(empty)'),
    h('h4', null, 'Files'),
    h('ul', { class: 'files' }, candidate.files.map((file) => h('li', { class: 'mono' }, file))),
    candidate.skipped.length
      ? [h('h4', null, 'Skipped'), h('ul', { class: 'files' }, candidate.skipped.map((skipped) => h('li', { class: 'mono' }, `${skipped.path} — ${skipped.reason}`)))]
      : null,
  );
}

export function candidateCard(candidate: ViewCandidate): Node {
  const isChecked = install.selected.has(candidate.id);
  const isExpanded = install.expanded.has(candidate.id);
  const worst = worstFindingOf(candidate);
  const toggleExpanded = () => {
    toggleInSet(install.expanded, candidate.id, !isExpanded);
    render();
  };
  return h(
    'div',
    { class: `cand ${isChecked ? 'checked' : ''} ${candidate.installable ? '' : 'blocked'}` },
    h(
      'label',
      { class: 'cand-head' },
      h('input', {
        type: 'checkbox',
        checked: isChecked,
        disabled: !candidate.installable || install.phase === 'staged',
        onChange: (event: Event) => {
          toggleInSet(install.selected, candidate.id, (event.target as HTMLInputElement).checked);
          render();
        },
      }),
      h('span', { class: 'name' }, candidate.installName),
      h('span', { class: 'mono small muted' }, candidate.repoDir || '(repository root)'),
      chip(`${candidate.fileCount} ${plural(candidate.fileCount, 'file')} · ${fmtBytes(candidate.totalBytes)}`, 'subtle'),
      worst ? chip(worst === 'high' ? 'high-risk findings' : 'review findings', worst === 'high' ? 'danger' : 'warn') : null,
    ),
    candidate.description ? h('p', { class: 'desc' }, candidate.description) : h('p', { class: 'desc muted' }, 'No description'),
    !candidate.installable ? h('div', { class: 'banner error small' }, `Can't install: ${candidate.blockReason ?? ''}`) : null,
    candidate.issues.length ? issueList(candidate.issues) : null,
    candidate.findings.length ? findingList(candidate.findings) : null,
    h('button', { class: 'linkish small', type: 'button', onClick: toggleExpanded }, isExpanded ? '▾ Hide content' : '▸ Preview SKILL.md and files'),
    isExpanded ? candidatePreview(candidate) : null,
  );
}

export function chooseStep(inspection: ViewInspection): Node {
  const staging = busy.has('stage');
  const installable = inspection.candidates.filter((candidate) => candidate.installable);
  const selectedCount = install.selected.size;
  const isReviewing = install.phase === 'staged';
  const subpath = inspection.subpath ? ' · ' + inspection.subpath : '';
  const selectAll = () => {
    installable.forEach((candidate) => install.selected.add(candidate.id));
    render();
  };
  const selectNone = () => {
    install.selected.clear();
    render();
  };
  const download = () => {
    errors['stage'] = undefined;
    send({ type: 'stage', candidateIds: [...install.selected] });
  };
  return h(
    'section',
    { class: 'panel' },
    h('h2', null, `2 · Choose skills (${inspection.candidates.length} found)`),
    h('p', { class: 'muted small mono' }, `${inspection.owner}/${inspection.repo} @ ${inspection.ref} · commit ${inspection.commit.slice(0, SHORT_COMMIT_LENGTH)}${subpath}`),
    inspection.notes.map((note) => h('div', { class: 'banner warn small' }, note)),
    installable.length > 1 && !isReviewing
      ? h('div', { class: 'inline small' }, button('Select all', selectAll, { kind: 'link' }), button('Select none', selectNone, { kind: 'link' }))
      : null,
    h('div', { class: 'cands' }, inspection.candidates.map(candidateCard)),
    !isReviewing
      ? h(
          'div',
          { class: 'inline' },
          button(staging ? 'Downloading…' : `Download & review ${selectedCount} ${plural(selectedCount, 'skill')}`, download, { kind: 'primary', disabled: selectedCount === 0 || staging }),
          button('Cancel', resetInstall),
        )
      : null,
    errors['stage'] ? h('div', { class: 'banner error' }, errors['stage']) : null,
  );
}

// ---------- step 3: review and install ----------

/** One of the two main choices (this project / all my projects), with its recommended folder. */
function targetCard(scope: TargetScope, title: string, subtitle: string): Node | null {
  const target = recommendedTarget(scope);
  if (!target) return null;
  const isActive = install.targetId === target.id;
  return h(
    'button',
    { class: `target-card ${isActive ? 'active' : ''}`, type: 'button', 'aria-pressed': isActive ? 'true' : 'false', onClick: () => selectTarget(target.id) },
    h('div', { class: 'target-title' }, icon(scope === 'workspace' ? 'root-folder' : 'home'), ` ${title}`),
    h('div', { class: 'small muted' }, subtitle),
    h('div', { class: 'mono small' }, target.label, target.exists ? '' : ' (will be created)'),
    h('div', { class: 'vis' }, shown().map((provider) => agentPill(provider.id, target.readers.includes(provider.id), short(provider.displayName)))),
  );
}

/** Other folders: the existing ones, plus new ones only when they add an installed agent the recommended ones don't reach. */
function otherTargets(targets: ResolvedLocation[], recommendedIds: Set<string | undefined>): ResolvedLocation[] {
  const reachedByRecommended = new Set(targets.filter((target) => recommendedIds.has(target.id)).flatMap(shownReaders));
  const addsAnAgent = (target: ResolvedLocation) => shownReaders(target).some((reader) => !reachedByRecommended.has(reader));
  return targets.filter((target) => !recommendedIds.has(target.id) && (target.exists || addsAnAgent(target)));
}

function otherTargetsList(others: ResolvedLocation[]): Node {
  return h(
    'div',
    { class: 'target-others', role: 'radiogroup', 'aria-label': 'Other folders' },
    others.map((target) => {
      const isActive = install.targetId === target.id;
      const scopeLabel = target.scope === 'workspace' ? 'project' : 'global';
      const newNote = target.exists ? '' : ' · new folder';
      return h(
        'label',
        { class: `target-row ${isActive ? 'active' : ''}` },
        h('input', { type: 'radio', name: 'target', checked: isActive ? true : undefined, onChange: () => selectTarget(target.id) }),
        h('span', { class: 'mono small' }, target.label),
        h('span', { class: 'small muted' }, `${scopeLabel}${newNote} · ${target.readers.map(providerName).join(', ')}`),
      );
    }),
    others.length ? null : h('p', { class: 'small muted' }, 'No other folder adds an agent you have installed.'),
  );
}

function targetChoice(targets: ResolvedLocation[], recommendedIds: Set<string | undefined>): Node {
  const others = otherTargets(targets, recommendedIds);
  const toggleOthers = () => {
    install.showAllTargets = !install.showAllTargets;
    render();
  };
  return h(
    'div',
    { class: 'target-choice' },
    h(
      'div',
      { class: 'target-cards' },
      targetCard('workspace', 'This project', 'Shared with everyone who clones the repository'),
      targetCard('global', 'All my projects', 'Only on this machine, in every project'),
    ),
    others.length || install.showAllTargets
      ? button(install.showAllTargets ? 'Hide other folders' : `Choose another folder… (${others.length})`, toggleOthers, { kind: 'link' })
      : null,
    install.showAllTargets ? otherTargetsList(others) : null,
  );
}

/** Skills of the chosen folder an install would replace (claude.ai synced, category and plugin skills are never replaced). */
function skillsToReplace(target: ResolvedLocation | undefined, staged: ViewStaged[]) {
  if (!target) return [];
  return ui.state!.skills.filter((skill) => {
    const isDirectlyInFolder = skill.locationId === target.id && !skill.managed && !skill.group && !skill.namespace;
    return isDirectlyInFolder && staged.some((stagedSkill) => stagedSkill.installName === skill.dirName);
  });
}

export function reviewStep(staged: ViewStaged[]): Node {
  const targets = writableTargets();
  const targetStillValid = targets.some((target) => target.id === install.targetId);
  if (!install.targetId || !targetStillValid) install.targetId = defaultTarget();
  const target = targets.find((candidate) => candidate.id === install.targetId);
  const installing = busy.has('install');
  const replaced = skillsToReplace(target, staged);
  const findings = staged.flatMap((stagedSkill) => stagedSkill.findings.map((finding) => ({ ...finding, file: `${stagedSkill.installName}/${finding.file}` })));
  const recommendedIds = new Set([recommendedTarget('workspace')?.id, recommendedTarget('global')?.id]);
  const totalFiles = staged.reduce((sum, stagedSkill) => sum + stagedSkill.fileCount, 0);
  const totalBytes = staged.reduce((sum, stagedSkill) => sum + stagedSkill.bytes, 0);
  const startInstall = () => {
    errors['install'] = undefined;
    send({ type: 'install', locationId: install.targetId });
  };
  return h(
    'section',
    { class: 'panel' },
    h('h2', null, '3 · Review and install'),
    h('p', { class: 'muted small' }, `Downloaded ${totalFiles} files (${fmtBytes(totalBytes)}) to a private staging folder and checked every file.`),
    h('h3', null, 'Automatic checks'),
    findingList(findings),
    h('h3', null, 'Where to install'),
    targets.length ? h('div', null, targetChoice(targets, recommendedIds)) : h('p', { class: 'banner warn' }, 'No writable skill folders available.'),
    target && !recommendedIds.has(target.id) ? h('div', { class: 'vis big' }, shown().map((provider) => agentPill(provider.id, target.readers.includes(provider.id)))) : null,
    target ? h('p', { class: 'mono small muted' }, target.path) : null,
    replaced.length
      ? h(
          'div',
          { class: 'banner warn small' },
          `Already in this folder: ${replaced.map((skill) => skill.name).join(', ')}. Installing replaces them; the current version is kept as a backup.`,
        )
      : null,
    h('div', { class: 'inline' }, button(installing ? 'Installing…' : 'Install…', startInstall, { kind: 'primary', disabled: !target || installing }), button('Cancel', resetInstall)),
    errors['install'] ? h('div', { class: 'banner error' }, errors['install']) : null,
  );
}
