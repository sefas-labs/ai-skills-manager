/* Dashboard webview — Overview tab: health summary, to-do list, folder × agent
 * matrix, agent cards and merge suggestions. */
import type { ResolvedLocation } from '../core/types';
import type { ViewMerge, ViewState } from '../shared/protocol';

type ViewMergeCopy = ViewMerge['copies'][number];
import { changeView, render } from './main';
import { busy, persisted, save, send, ui } from './store';
import { type Child, button, chip, h, icon, svg } from './dom';
import { agentColor, isHost, problems, providerName, short, shown, swatch } from './agents';
import { inTab, selectSkill } from './skills';
import { coverage } from './map';

export interface TodoItem {
  icon: string;
  kind: 'warn' | 'err' | 'info';
  text: Child;
  action?: Node;
}

const RING_SIZE = 80;
const RING_CENTER = RING_SIZE / 2;
const RING_RADIUS = 30;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Versions are labelled A, B, C… */
const FIRST_VERSION_LETTER = 'A'.charCodeAt(0);
const NOT_DETECTED_TOOLTIP = 'Not detected on this machine (no CLI, app, config file or extension found)';

export const VERDICT: Record<ViewMerge['verdict'], string> = {
  'remove-redundant': 'Redundant copies — every agent keeps it with fewer folders',
  'unify-versions': 'Different versions — all copies are needed, but agents see different content',
  expected: 'Copies are needed to reach every agent (no single folder reaches all of them)',
};

function plural(count: number, singular: string, pluralForm = singular + 's'): string {
  return count === 1 ? singular : pluralForm;
}

function isDuplicateIssue(code: string): boolean {
  return code.startsWith('duplicate:');
}

// ---------- to-do list ----------

function fixableTodos(state: ViewState): TodoItem[] {
  return state.skills
    .filter((skill) => skill.fixes.length)
    .map((skill) => {
      const problemCount = new Set(skill.fixes.flatMap((fix) => fix.codes)).size;
      return {
        icon: 'wrench',
        kind: 'warn',
        text: [h('strong', null, skill.name), ` — ${problemCount} fixable ${plural(problemCount, 'problem')}`],
        action: button('Fix…', () => send({ type: 'fix', skillId: skill.id }), { kind: 'primary', disabled: busy.has('fix') }),
      };
    });
}

function conflictTodos(state: ViewState, conflictingNames: Set<string>): TodoItem[] {
  return [...conflictingNames].map((name) => {
    const copies = state.skills.filter((skill) => skill.name === name);
    const agentsSeeingTwo = shown()
      .filter((provider) => provider.duplicateNames.includes(name))
      .map((provider) => provider.displayName);
    const copyToOpen = copies.find((copy) => !copy.readOnly) ?? copies[0];
    return {
      icon: 'files',
      kind: 'warn',
      text: [h('strong', null, name), ` — ${agentsSeeingTwo.join(', ')} ${plural(agentsSeeingTwo.length, 'sees', 'see')} ${copies.length} different versions`],
      action: button('Choose…', () => selectSkill(copyToOpen.id), { kind: 'secondary' }),
    };
  });
}

function mergeTodos(state: ViewState, conflictingNames: Set<string>): TodoItem[] {
  return state.merges
    .filter((merge) => merge.verdict === 'remove-redundant' && !conflictingNames.has(merge.name))
    .map((merge) => ({
      icon: 'git-merge',
      kind: 'info',
      text: [h('strong', null, merge.name), ` — ${merge.remove.length} redundant ${plural(merge.remove.length, 'copy', 'copies')}`],
      action: button('Merge…', () => send({ type: 'merge', suggestionId: merge.id, action: 'apply' }), { kind: 'secondary', disabled: busy.has('merge') }),
    }));
}

function updateTodos(state: ViewState): TodoItem[] {
  return state.skills
    .filter((skill) => skill.update?.status === 'update-available')
    .map((skill) => ({
      icon: 'arrow-circle-up',
      kind: 'info',
      text: [h('strong', null, skill.name), ' — update available'],
      action: button('Review…', () => send({ type: 'update', skillId: skill.id }), { kind: 'secondary', disabled: busy.has('update') }),
    }));
}

/** Problems with no automatic fix (duplicates have their own to-do above). */
function manualProblemTodos(state: ViewState): TodoItem[] {
  const items: TodoItem[] = [];
  for (const skill of state.skills.filter((candidate) => !candidate.fixes.length)) {
    const problem = problems(skill).find((issue) => !isDuplicateIssue(issue.code));
    if (!problem) continue;
    const isError = problem.severity === 'error';
    items.push({
      icon: isError ? 'error' : 'warning',
      kind: isError ? 'err' : 'warn',
      text: [h('strong', null, skill.name), ` — ${problem.message}`],
      action: button('Open', () => selectSkill(skill.id), { kind: 'secondary' }),
    });
  }
  return items;
}

function coverageGapTodo(): TodoItem | null {
  const gaps = coverage('project').filter((row) => row.missing.length && !row.synced);
  if (!gaps.length) return null;
  const perAgent = shown()
    .map((agent) => [short(agent.displayName), gaps.filter((row) => row.missing.includes(agent.id)).length] as const)
    .filter(([, missingCount]) => missingCount)
    .map(([agentName, missingCount]) => `${agentName} ${missingCount}`);
  return {
    icon: 'type-hierarchy',
    kind: 'info',
    text: [h('strong', null, `${gaps.length} project ${plural(gaps.length, 'skill')}`), ` miss an agent (${perAgent.join(' · ')})`],
    action: button('Open Map', () => changeView({ tab: 'map', mapScope: 'project' }), { kind: 'secondary' }),
  };
}

/** Everything actionable, in the order it's worth doing. */
export function todoItems(): TodoItem[] {
  const state = ui.state!;
  const conflictingNames = new Set(shown().flatMap((provider) => provider.duplicateNames));
  const gapTodo = coverageGapTodo();
  return [
    ...fixableTodos(state),
    ...conflictTodos(state, conflictingNames),
    ...mergeTodos(state, conflictingNames),
    ...updateTodos(state),
    ...manualProblemTodos(state),
    ...(gapTodo ? [gapTodo] : []),
  ];
}

// ---------- health summary ----------

/** Ring with the share of skills without problems. */
export function healthRing(healthyCount: number, total: number): Node {
  const healthyShare = total ? healthyCount / total : 1;
  const filledLength = (RING_CIRCUMFERENCE * healthyShare).toFixed(1);
  const circle = (className: string, extra: Record<string, string> = {}) =>
    svg('circle', { cx: RING_CENTER, cy: RING_CENTER, r: RING_RADIUS, class: className, ...extra });
  return h(
    'div',
    { class: 'ring', role: 'img', 'aria-label': `${healthyCount} of ${total} skills without problems` },
    svg(
      'svg',
      { viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`, width: RING_SIZE, height: RING_SIZE },
      circle('ring-bg'),
      // Start at 12 o'clock instead of 3 o'clock.
      circle(`ring-fg ${healthyShare === 1 ? 'full' : ''}`, {
        'stroke-dasharray': `${filledLength} ${RING_CIRCUMFERENCE.toFixed(1)}`,
        transform: `rotate(-90 ${RING_CENTER} ${RING_CENTER})`,
      }),
    ),
    h('div', { class: 'ring-label' }, h('strong', null, String(healthyCount)), h('span', { class: 'muted small' }, `/${total}`)),
  );
}

function healthTitle(needAttention: number): string {
  if (needAttention === 0) return 'All skills look good';
  return `${needAttention} ${plural(needAttention, 'skill')} ${plural(needAttention, 'needs', 'need')} attention`;
}

function hostAgentLine(state: ViewState): Node | null {
  const hostProvider = state.providers.find((provider) => isHost(provider.id));
  if (!hostProvider) return null;
  const loaded = hostProvider.visibleSkills;
  const twoVersions = hostProvider.duplicateNames.length ? `, ${hostProvider.duplicateNames.length} with two versions` : '';
  return h(
    'p',
    { class: 'small hero-host' },
    icon('vm'),
    ' In ',
    h('strong', null, state.host.appName),
    `: ${hostProvider.displayName} loads ${loaded} ${plural(loaded, 'skill')}${twoVersions}`,
    '. ',
    button('Show them', () => changeView({ provider: hostProvider.id, tab: 'project' }), { kind: 'link' }),
  );
}

function agentChips(state: ViewState): Node {
  const notDetected = state.providers.filter((provider) => !state.agents[provider.id]?.installed);
  const someButNotAllMissing = notDetected.length > 0 && notDetected.length < state.providers.length;
  return h(
    'div',
    { class: 'agent-chips' },
    state.providers.map((provider) => {
      const detection = state.agents[provider.id];
      const evidence = (detection?.evidence ?? []).join(' · ');
      return h(
        'span',
        { class: `achip ${detection?.installed ? 'on' : 'off'} ${isHost(provider.id) ? 'host' : ''} c-${agentColor(provider.id)}`, title: evidence || NOT_DETECTED_TOOLTIP },
        h('span', { class: 'swatch' }),
        provider.displayName,
        detection?.installed ? null : h('span', { class: 'muted' }, ' · not detected'),
      );
    }),
    someButNotAllMissing
      ? button(persisted.showAllAgents ? 'Hide not detected' : 'Show all', () => changeView({ showAllAgents: !persisted.showAllAgents }), { kind: 'link' })
      : null,
  );
}

function todoPanel(): Node {
  const items = todoItems();
  return h(
    'div',
    { class: 'hero-right' },
    h('h2', null, icon('checklist'), ' To do', items.length ? h('span', { class: 'count' }, String(items.length)) : null),
    items.length
      ? h(
          'ul',
          { class: 'todo', 'data-scroll-key': 'todo' },
          items.map((item) => h('li', { class: item.kind }, icon(item.icon, 'todo-icon'), h('span', { class: 'todo-text' }, item.text), item.action ?? null)),
        )
      : h('p', { class: 'todo-empty' }, icon('pass-filled', 'ok'), ' Nothing to do — no conflicts, problems or updates.'),
  );
}

export function healthHero(): Node {
  const state = ui.state!;
  const healthyCount = state.skills.filter((skill) => !problems(skill).length).length;
  return h(
    'section',
    { class: 'panel hero' },
    h(
      'div',
      { class: 'hero-left' },
      h(
        'div',
        { class: 'hero-score' },
        healthRing(healthyCount, state.skills.length),
        h(
          'div',
          null,
          h('div', { class: 'hero-title' }, healthTitle(state.skills.length - healthyCount)),
          h(
            'div',
            { class: 'hero-counts' },
            h('button', { class: 'linkish', type: 'button', onClick: () => changeView({ tab: 'project' }) }, icon('root-folder'), ` ${inTab('project').length} project`),
            h('button', { class: 'linkish', type: 'button', onClick: () => changeView({ tab: 'global' }) }, icon('home'), ` ${inTab('global').length} global`),
          ),
        ),
      ),
      hostAgentLine(state),
      agentChips(state),
    ),
    todoPanel(),
  );
}

// ---------- folder × agent matrix ----------

function originNote(location: ResolvedLocation): string {
  if (location.origin === 'nested') return ` · nested, for ${location.appliesTo}/`;
  if (location.origin === 'parent') return ' · parent folder';
  return '';
}

function folderCell(location: ResolvedLocation): Node {
  const hasSkills = location.exists && !!location.skillCount;
  const noInstalledReader = hasSkills && !location.readers.some((reader) => ui.state!.agents[reader]?.installed);
  const skipped = location.skippedSynced;
  return h(
    'td',
    null,
    h('div', { class: 'mono' }, location.readOnly ? [icon('lock', 'muted'), ' '] : null, location.label),
    h('div', { class: 'small muted' }, location.scope + originNote(location) + (location.exists ? '' : ' · not created')),
    noInstalledReader ? h('div', { class: 'small warn-text' }, 'No installed agent reads this folder') : null,
    skipped
      ? h(
          'div',
          { class: 'small muted', title: 'Claude Code only loads the skills of the claude.ai account it is signed in with.' },
          `${skipped} synced ${plural(skipped, 'skill')} of another claude.ai account not listed`,
        )
      : null,
  );
}

function folderMatrix(locations: ResolvedLocation[]): Node {
  const agents = shown();
  const header = h(
    'tr',
    null,
    h('th', null, 'Folder'),
    ...agents.map((agent) =>
      h('th', { class: `c ${isHost(agent.id) ? 'host' : ''}`, title: isHost(agent.id) ? 'The agent built into this editor' : undefined }, swatch(agent.id), short(agent.displayName)),
    ),
    h('th', { class: 'c' }, 'Skills'),
  );
  const row = (location: ResolvedLocation) =>
    h(
      'tr',
      { class: location.exists && location.skillCount ? '' : 'dim' },
      folderCell(location),
      ...agents.map((agent) =>
        h(
          'td',
          { class: `c ${isHost(agent.id) ? 'host' : ''}` },
          location.readers.includes(agent.id)
            ? h('span', { class: `dot-a big c-${agentColor(agent.id)}`, title: `${agent.displayName} loads skills from here` })
            : h('span', { class: 'dot-off', 'aria-hidden': 'true' }),
        ),
      ),
      h('td', { class: 'c num-cell' }, location.exists ? String(location.skillCount) : '—'),
    );
  return h('table', { class: 'matrix' }, h('thead', null, header), h('tbody', null, locations.map(row)));
}

function foldersPanel(state: ViewState): Node {
  // Parent/nested folders are only interesting when they exist; empty ones fold away.
  const relevant = state.locations.filter((location) => location.exists || (location.scope !== 'admin' && !location.origin));
  const empty = relevant.filter((location) => !location.exists || !location.skillCount);
  const visible = persisted.showEmptyFolders ? relevant : relevant.filter((location) => location.exists && location.skillCount);
  const toggleEmpty = empty.length
    ? button(
        persisted.showEmptyFolders ? 'Hide empty folders' : `Show ${empty.length} empty ${plural(empty.length, 'folder')}`,
        () => changeView({ showEmptyFolders: !persisted.showEmptyFolders }),
        { kind: 'link' },
      )
    : null;
  return h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Which agent loads which folder'), toggleEmpty),
    h('p', { class: 'muted small' }, 'Based on each agent’s official documentation. A skill is available to an agent only if it sits in a folder that agent reads.'),
    h('div', { class: 'scroll-x' }, folderMatrix(visible)),
  );
}

// ---------- agent cards ----------

export function agentStatus(agentId: string): Node | null {
  const detection = ui.state!.agents[agentId];
  if (!detection) return null;
  if (!detection.installed) return h('p', { class: 'small muted' }, icon('circle-slash'), ' Not detected on this machine');
  const moreEvidence = detection.evidence.length > 1 ? ` (+${detection.evidence.length - 1})` : '';
  return h('p', { class: 'small ok-text', title: detection.evidence.join(' · ') }, icon('pass'), ' Detected — ', detection.evidence[0], moreEvidence);
}

function agentCards(): Node {
  return h(
    'div',
    { class: 'cards' },
    shown().map((provider) =>
      h(
        'section',
        { class: `card agent-card c-${agentColor(provider.id)} ${isHost(provider.id) ? 'host' : ''}` },
        h(
          'div',
          { class: 'card-head' },
          h('h3', null, swatch(provider.id), provider.displayName),
          isHost(provider.id) ? chip('this editor', 'host') : null,
          h(
            'button',
            {
              class: 'btn link icon-only',
              type: 'button',
              title: `${provider.displayName} documentation`,
              'aria-label': `${provider.displayName} documentation`,
              onClick: () => send({ type: 'openDocs', providerId: provider.id }),
            },
            icon('link-external'),
          ),
        ),
        h('div', { class: 'card-num' }, h('span', { class: 'num' }, String(provider.visibleSkills)), h('span', { class: 'muted small' }, ' skills')),
        agentStatus(provider.id),
        provider.duplicateNames.length ? h('p', { class: 'warn-text small' }, icon('warning'), ` Two versions: ${provider.duplicateNames.join(', ')}`) : null,
        provider.disableHint
          ? h('details', { class: 'hint small' }, h('summary', { class: 'muted' }, 'How to disable a skill'), h('p', { class: 'muted' }, provider.disableHint))
          : null,
      ),
    ),
  );
}

export function overview(): Node {
  const state = ui.state!;
  if (state.skills.length === 0) {
    return h(
      'section',
      { class: 'panel empty' },
      h('h2', null, 'No skills yet'),
      h('p', { class: 'muted' }, 'Skills are folders with a SKILL.md file. Install some from a GitHub repository to get started.'),
      button('Install from GitHub', () => changeView({ tab: 'install' }), { kind: 'primary' }),
    );
  }
  return h('div', { class: 'overview' }, healthHero(), foldersPanel(state), h('h2', { class: 'section-title' }, 'Agents'), agentCards(), mergePanel());
}

// ---------- merge suggestions ----------

export function scrollToMerges(): void {
  persisted.tab = 'overview';
  save();
  render();
  const mergesPanel = document.getElementById('merges') as HTMLDetailsElement | null;
  if (!mergesPanel) return;
  mergesPanel.open = true;
  mergesPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function versionLetter(version: number): string {
  return String.fromCharCode(FIRST_VERSION_LETTER + version);
}

function mergeCopyRow(merge: ViewMerge, copy: ViewMergeCopy, versionCount: number): Node {
  const working = busy.has('merge');
  const versionTitle = copy.changedFiles ? `${copy.changedFiles} file(s) differ from version A` : 'Version A';
  return h(
    'li',
    null,
    merge.remove.includes(copy.skillId) ? chip('remove', 'danger') : chip('keep', 'subtle'),
    versionCount > 1 ? chip(versionLetter(copy.version), 'subtle', versionTitle) : null,
    h('span', { class: 'mono' }, copy.locationLabel),
    h('span', { class: 'small muted' }, ` ${copy.readers.map((reader) => short(providerName(reader))).join(' · ')}`),
    !copy.writable ? h('span', { class: 'small muted' }, ' · read-only') : null,
    copy.modifiedAt ? h('span', { class: 'small muted' }, ` · modified ${new Date(copy.modifiedAt).toLocaleDateString()}`) : null,
    merge.verdict === 'unify-versions'
      ? button('Use this version', () => send({ type: 'merge', suggestionId: merge.id, action: 'unify', skillId: copy.skillId }), {
          kind: 'link',
          disabled: working,
          title: 'Copy this version over the other writable copies (backup kept)',
        })
      : null,
  );
}

function mergeSuggestion(merge: ViewMerge): Node {
  const working = busy.has('merge');
  const versionCount = new Set(merge.copies.map((copy) => copy.version)).size;
  const removeCount = merge.remove.length;
  return h(
    'div',
    { class: `merge ${merge.verdict}` },
    h(
      'div',
      { class: 'merge-head' },
      h('strong', null, merge.name),
      chip(merge.scope === 'workspace' ? 'project' : 'global', `scope-${merge.scope}`),
      merge.identical ? chip('identical', 'subtle') : chip(`${versionCount} versions`, 'warn'),
    ),
    h('p', { class: 'small' }, VERDICT[merge.verdict], merge.seenTwiceBy.length ? h('span', { class: 'muted' }, ` · seen twice by ${merge.seenTwiceBy.map(providerName).join(', ')}`) : null),
    h('ul', { class: 'merge-copies' }, merge.copies.map((copy) => mergeCopyRow(merge, copy, versionCount))),
    h(
      'div',
      { class: 'inline' },
      removeCount
        ? button(`Merge: remove ${removeCount} ${plural(removeCount, 'copy', 'copies')}…`, () => send({ type: 'merge', suggestionId: merge.id, action: 'apply' }), {
            kind: 'primary',
            disabled: working,
          })
        : null,
      !merge.identical ? button('Compare', () => send({ type: 'merge', suggestionId: merge.id, action: 'compare' }), { disabled: working }) : null,
    ),
  );
}

export function mergePanel(): Node | null {
  const merges = ui.state!.merges;
  if (!merges.length) return null;
  const actionableCount = merges.filter((merge) => merge.verdict !== 'expected').length;
  return h(
    'details',
    { class: 'panel merges', id: 'merges', open: actionableCount ? true : undefined },
    h('summary', null, h('h2', null, icon('git-merge'), ` Merge suggestions${actionableCount ? ` (${actionableCount})` : ''}`)),
    h('p', { class: 'muted small' }, 'Same skill name in several folders of the same scope. Only installed agents are taken into account; nothing changes until you confirm.'),
    merges.map(mergeSuggestion),
  );
}
