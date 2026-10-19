/* Dashboard webview — the Project and Global tabs: toolbar, the skills list
 * (grouped by source and by name) and the detail pane (see skillDetail.ts). */
import type { ViewSkill } from '../shared/protocol';
import { render } from './main';
import { type SkillsTab, persisted, save, send, ui } from './store';
import { type Child, button, chip, h, icon, select, sevIcon } from './dom';
import { agentDots, problems, qname, shown } from './agents';
import { skillDetail, syncedNotice } from './skillDetail';

export { issueList } from './skillDetail';

/** Where a skill came from, when it arrived with others: a plugin, claude.ai, Cursor, a GitHub repo or a category folder. */
export interface Bundle {
  key: string;
  title: string;
  kind: string;
  icon: string;
}

type BundleWithSkills = [Bundle, ViewSkill[]];

/** Same breakpoint as the stacked layout in dashboard.css. */
const WIDE_LAYOUT_QUERY = '(min-width: 821px)';
const MAX_NAMES_IN_COLLAPSED_BUNDLE = 6;
const CURSOR_LOCAL_PLUGIN_LABEL = /^Cursor plugin (.+) \(local\)$/;
const CURSOR_BUILT_IN_LABEL = 'Cursor built-in skills';
const CLAUDE_AI_PLUGIN_LABEL_PREFIX = 'claude.ai plugin';
const GITHUB_REPO_FROM_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)/;

const STATUS_FILTERS: Array<[string, string]> = [
  ['all', 'Any status'],
  ['problems', 'With problems'],
  ['links', 'Symlinks'],
  ['readonly', 'Read-only'],
  ['github', 'From GitHub (tracked)'],
  ['updates', 'Updates available'],
];

/** Skill names expanded in the "same name in several folders" groups. */
export const expandedGroups = new Set<string>();

/** Tabs where the first skill was already opened automatically (never fight the user afterwards). */
export const autoPicked = new Set<SkillsTab>();

export const wideLayout = () => window.matchMedia?.(WIDE_LAYOUT_QUERY).matches ?? true;

/** Project = workspace folders (incl. parent/nested); Global = user and admin/system folders. */
export function tabOf(skill: ViewSkill): SkillsTab {
  return skill.scope === 'workspace' ? 'project' : 'global';
}

export function inTab(tab: SkillsTab): ViewSkill[] {
  return ui.state ? ui.state.skills.filter((skill) => tabOf(skill) === tab) : [];
}

export function selectSkill(id: string) {
  const skill = ui.state?.skills.find((candidate) => candidate.id === id);
  persisted.tab = skill ? tabOf(skill) : 'project';
  persisted.selected = id;
  ui.detail = null;
  ui.requestedDetail = undefined;
  save();
  render();
}

function matchesStatusFilter(skill: ViewSkill): boolean {
  switch (persisted.status) {
    case 'problems':
      return problems(skill).length > 0;
    case 'links':
      return skill.isSymlink;
    case 'readonly':
      return skill.readOnly;
    case 'github':
      return !!skill.tracked;
    case 'updates':
      return skill.update?.status === 'update-available';
    default:
      return true;
  }
}

function matchesAgentFilter(skill: ViewSkill): boolean {
  const agent = persisted.provider;
  // A filter for an agent that is no longer shown is ignored rather than hiding everything.
  const agentIsShown = shown().some((provider) => provider.id === agent);
  return agent === 'all' || !agentIsShown || skill.visibleTo.includes(agent);
}

function matchesSearch(skill: ViewSkill, query: string): boolean {
  if (!query) return true;
  const searchable = [skill.name, skill.description ?? '', skill.displayDir];
  return searchable.some((text) => text.toLowerCase().includes(query));
}

export function filtered(tab: SkillsTab): ViewSkill[] {
  const query = persisted.searchQuery.trim().toLowerCase();
  return inTab(tab)
    .filter((skill) => matchesAgentFilter(skill) && matchesStatusFilter(skill) && matchesSearch(skill, query))
    .sort((first, second) => first.name.localeCompare(second.name) || first.scope.localeCompare(second.scope));
}

/** Small chips for agents that have the skill switched off or manual-only. */
function offChips(skill: ViewSkill): Child[] {
  const toggles = skill.toggles;
  if (!toggles) return [];
  const isShownReader = (agentId: string) => skill.visibleTo.includes(agentId) && shown().some((provider) => provider.id === agentId);
  const chips: Child[] = [];
  const claude = toggles.claude;
  if (isShownReader('claude-code') && claude && claude.value !== 'on') {
    chips.push(chip(claude.value === 'off' ? 'off: Claude' : 'Claude: limited', 'warn', `Claude Code skillOverrides: ${claude.value}`));
  }
  if (isShownReader('codex') && toggles.codex && !toggles.codex.enabled) chips.push(chip('off: Codex', 'warn', 'Disabled in ~/.codex/config.toml'));
  if (!toggles.userInvocable && !toggles.modelInvocation) chips.push(chip('disabled', 'warn', 'disable-model-invocation + user-invocable: false'));
  else if (!toggles.modelInvocation) chips.push(chip('manual', 'subtle', 'Only loads when invoked as /' + skill.name));
  return chips;
}

function originChip(skill: ViewSkill): Child {
  if (skill.namespace) return chip('plugin', 'subtle', skill.readOnlyReason);
  if (skill.managed === 'synced') return chip('claude.ai', 'subtle', 'Synced from claude.ai (read-only)');
  if (skill.readOnly) return chip('read-only', 'subtle', skill.readOnlyReason);
  return null;
}

export function rowChips(skill: ViewSkill): Child[] {
  return [
    skill.scope === 'admin' ? chip('admin', 'scope-admin') : null,
    skill.isSymlink ? chip('link', 'subtle', `→ ${skill.realDir}`) : null,
    originChip(skill),
    skill.group ? chip(`${skill.group}/`, 'subtle', 'Inside a category folder: only Cursor walks skill folders recursively') : null,
    ...offChips(skill),
    skill.update?.status === 'update-available' ? chip('update', 'update', 'A newer version is available on GitHub') : null,
  ];
}

/** 'error', 'warning' or '' for the most severe problem among these skills. */
export function worstOf(skills: ViewSkill[]): string {
  const allProblems = skills.flatMap(problems);
  if (allProblems.some((issue) => issue.severity === 'error')) return 'error';
  return allProblems.length ? 'warning' : '';
}

function severityMark(skills: ViewSkill[]): Child {
  const worst = worstOf(skills);
  return worst ? sevIcon(worst) : null;
}

function skillName(skill: ViewSkill): Node {
  return h('span', { class: 'name' }, skill.namespace ? h('span', { class: 'ns' }, `${skill.namespace}:`) : null, skill.name);
}

/** One skill in the list; `asCopy` is the compact form used inside a "same name" group. */
export function skillRow(skill: ViewSkill, asCopy: boolean): Node {
  const isSelected = persisted.selected === skill.id;
  const content = asCopy
    ? h('div', { class: 'row-head' }, severityMark([skill]), h('span', { class: 'mono loc' }, skill.locationLabel), ...rowChips(skill), agentDots(skill.visibleTo))
    : [
        h('div', { class: 'row-head' }, severityMark([skill]), skillName(skill), ...rowChips(skill)),
        skill.description ? h('div', { class: 'desc' }, skill.description) : h('div', { class: 'desc muted' }, 'No description'),
        h('div', { class: 'row-foot' }, h('span', { class: 'mono small muted loc' }, skill.locationLabel), agentDots(skill.visibleTo)),
      ];
  return h(
    'button',
    { class: `row ${asCopy ? 'child' : ''} ${isSelected ? 'selected' : ''}`, 'aria-current': isSelected ? 'true' : undefined, type: 'button', onClick: () => selectSkill(skill.id) },
    content,
  );
}

export function bundleOf(skill: ViewSkill): Bundle | undefined {
  if (skill.namespace) {
    const isClaudeAiPlugin = skill.locationLabel.startsWith(CLAUDE_AI_PLUGIN_LABEL_PREFIX);
    return { key: `plugin:${skill.namespace}`, title: skill.namespace, kind: isClaudeAiPlugin ? 'claude.ai plugin' : 'Claude Code plugin', icon: 'extensions' };
  }
  const cursorPluginName = CURSOR_LOCAL_PLUGIN_LABEL.exec(skill.locationLabel)?.[1];
  if (cursorPluginName) return { key: `cursor-plugin:${cursorPluginName}`, title: cursorPluginName, kind: 'Cursor plugin', icon: 'extensions' };
  if (skill.locationLabel === CURSOR_BUILT_IN_LABEL) return { key: 'cursor-builtin', title: 'Cursor built-in', kind: 'Ships with Cursor', icon: 'package' };
  if (skill.managed === 'synced') return { key: 'claude-ai', title: 'claude.ai', kind: 'Synced from your account', icon: 'cloud' };
  const repo = skill.source && GITHUB_REPO_FROM_URL.exec(skill.source.url)?.[1];
  if (repo) return { key: `gh:${repo.toLowerCase()}:${skill.scope}`, title: repo, kind: 'Installed from GitHub', icon: 'github' };
  if (skill.group) return { key: `group:${skill.locationId}:${skill.group}`, title: `${skill.group}/`, kind: `Category folder in ${skill.locationLabel}`, icon: 'folder' };
  return undefined;
}

/** Rows for a list of skills: the same name in several folders becomes one expandable copies group. */
function nameRows(skills: ViewSkill[]): Node[] {
  const skillsByName = new Map<string, ViewSkill[]>();
  for (const skill of skills) skillsByName.set(qname(skill), [...(skillsByName.get(qname(skill)) ?? []), skill]);
  return [...skillsByName.values()].map((copies) => (copies.length === 1 ? skillRow(copies[0], false) : groupRows(copies)));
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function collapsedBundlePreview(names: string[]): string {
  const shownNames = names.slice(0, MAX_NAMES_IN_COLLAPSED_BUNDLE).join(' · ');
  const hiddenCount = names.length - MAX_NAMES_IN_COLLAPSED_BUNDLE;
  return hiddenCount > 0 ? `${shownNames} · +${hiddenCount} more` : shownNames;
}

export function bundleRows(bundle: Bundle, skills: ViewSkill[], refill: () => void): Node {
  const containsSelection = skills.some((skill) => skill.id === persisted.selected);
  const isSearching = !!persisted.searchQuery.trim();
  const isOpen = isSearching || (persisted.openBundles ?? []).includes(bundle.key) || containsSelection;
  const names = uniqueValues(skills.map((skill) => skill.name));
  const toggle = () => {
    const openBundles = new Set(persisted.openBundles ?? []);
    if (isOpen) {
      openBundles.delete(bundle.key);
      if (containsSelection) persisted.selected = undefined;
    } else {
      openBundles.add(bundle.key);
    }
    persisted.openBundles = [...openBundles];
    save();
    // Closing the bundle of the selected skill also clears the detail pane: that needs a full render.
    if (persisted.selected === undefined) render();
    else refill();
  };
  return h(
    'div',
    { class: `bundle ${isOpen ? 'open' : ''}` },
    h(
      'button',
      { class: 'row bundle-head', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', onClick: toggle },
      h(
        'div',
        { class: 'row-head' },
        icon(isOpen ? 'chevron-down' : 'chevron-right', 'chev'),
        icon(bundle.icon),
        severityMark(skills),
        h('span', { class: 'name' }, bundle.title),
        chip(`${names.length} skill${names.length === 1 ? '' : 's'}`, 'subtle'),
        h('span', { class: 'small muted' }, bundle.kind),
      ),
      isOpen ? null : h('div', { class: 'desc muted' }, collapsedBundlePreview(names)),
      h(
        'div',
        { class: 'row-foot' },
        h('span', { class: 'mono small muted loc' }, uniqueValues(skills.map((skill) => skill.locationLabel)).join(' · ')),
        agentDots(uniqueValues(skills.flatMap((skill) => skill.visibleTo))),
      ),
    ),
    isOpen ? h('div', { class: 'bundle-children' }, nameRows(skills)) : null,
  );
}

/** Skills in display order: your own first, then one bundle per source. */
export function listLayout(skills: ViewSkill[]): { loose: ViewSkill[]; bundles: BundleWithSkills[] } {
  if (persisted.flatList) return { loose: skills, bundles: [] };
  const bundlesByKey = new Map<string, BundleWithSkills>();
  for (const skill of skills) {
    const bundle = bundleOf(skill);
    if (!bundle) continue;
    const existing = bundlesByKey.get(bundle.key);
    if (existing) existing[1].push(skill);
    else bundlesByKey.set(bundle.key, [bundle, [skill]]);
  }
  // A source with a single skill isn't worth a level of nesting.
  const bundles = [...bundlesByKey.values()].filter(([, members]) => members.length > 1).sort(([first], [second]) => first.title.localeCompare(second.title));
  const bundledIds = new Set(bundles.flatMap(([, members]) => members.map((skill) => skill.id)));
  return { loose: skills.filter((skill) => !bundledIds.has(skill.id)), bundles };
}

export function groupRows(copies: ViewSkill[]): Node {
  const name = copies[0].name;
  const containsSelection = copies.some((copy) => copy.id === persisted.selected);
  const isOpen = expandedGroups.has(name) || containsSelection;
  const allSame = copies.every((copy) => copy.contentId && copy.contentId === copies[0].contentId);
  const toggle = () => {
    if (isOpen) {
      expandedGroups.delete(name);
      if (containsSelection) persisted.selected = undefined;
    } else {
      expandedGroups.add(name);
    }
    save();
    render();
  };
  const copiesChip = chip(`${copies.length} copies`, allSame ? 'subtle' : 'warn', allSame ? 'Same content in every folder' : 'The copies differ — open one to choose which to use');
  return h(
    'div',
    { class: `group ${isOpen ? 'open' : ''}` },
    h(
      'button',
      { class: 'row group-head', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', onClick: toggle },
      h('div', { class: 'row-head' }, icon(isOpen ? 'chevron-down' : 'chevron-right', 'chev'), severityMark(copies), h('span', { class: 'name' }, name), copiesChip),
      copies[0].description ? h('div', { class: 'desc' }, copies[0].description) : null,
      h(
        'div',
        { class: 'row-foot' },
        h('span', { class: 'mono small muted loc' }, copies.map((copy) => copy.locationLabel).join(' · ')),
        agentDots(uniqueValues(copies.flatMap((copy) => copy.visibleTo))),
      ),
    ),
    isOpen ? h('div', { class: 'group-children' }, copies.map((copy) => skillRow(copy, true))) : null,
  );
}

function listContent(tab: SkillsTab, refillKeepingScroll: () => void): Node[] {
  const skills = filtered(tab);
  if (!skills.length) return [h('p', { class: 'muted pad' }, 'No skills match these filters.')];
  const { loose, bundles } = listLayout(skills);
  const sectionLabel = (text: string) => h('div', { class: 'list-label small muted' }, text);
  return [
    ...(bundles.length && loose.length ? [sectionLabel('Your skills')] : []),
    ...nameRows(loose),
    ...(bundles.length ? [sectionLabel(`From plugins & sources · ${bundles.length}`)] : []),
    ...bundles.map(([bundle, members]) => bundleRows(bundle, members, refillKeepingScroll)),
  ];
}

function toolbar(refill: () => void): Node {
  const agentOptions: Array<[string, string]> = [['all', 'All agents'], ...shown().map((provider) => [provider.id, provider.displayName] as [string, string])];
  const toggleGrouping = () => {
    persisted.flatList = !persisted.flatList;
    save();
    render();
  };
  return h(
    'div',
    { class: 'toolbar' },
    h('input', {
      type: 'search',
      id: 'search',
      class: 'search',
      placeholder: 'Search name, description or path',
      value: persisted.searchQuery,
      'aria-label': 'Search skills',
      onInput: (event: Event) => {
        persisted.searchQuery = (event.target as HTMLInputElement).value;
        save();
        refill();
      },
    }),
    select(
      persisted.provider,
      agentOptions,
      (agent) => {
        persisted.provider = agent;
        save();
        refill();
      },
      'Agent',
    ),
    select(
      persisted.status,
      STATUS_FILTERS,
      (status) => {
        persisted.status = status;
        save();
        refill();
      },
      'Status',
    ),
    h(
      'button',
      {
        class: `btn link icon-only ${persisted.flatList ? '' : 'active'}`,
        type: 'button',
        title: persisted.flatList ? 'Group by source (plugins, claude.ai, repos)' : 'Show every skill on its own',
        'aria-label': 'Group by source',
        'aria-pressed': persisted.flatList ? 'false' : 'true',
        onClick: toggleGrouping,
      },
      icon(persisted.flatList ? 'list-flat' : 'list-tree'),
    ),
  );
}

/**
 * One selection for both tabs, shown only in the tab it belongs to. On wide
 * layouts the first skill opens automatically instead of leaving the detail empty.
 */
function selectedSkill(tab: SkillsTab): ViewSkill | undefined {
  const selected = inTab(tab).find((skill) => skill.id === persisted.selected);
  if (selected || !wideLayout() || autoPicked.has(tab)) return selected;
  autoPicked.add(tab);
  const { loose, bundles } = listLayout(filtered(tab));
  const firstInList = loose[0] ?? bundles[0]?.[1][0];
  if (firstInList) {
    persisted.selected = firstInList.id;
    save();
  }
  return firstInList;
}

function requestDetailIfMissing(skill: ViewSkill): void {
  const detailIsLoaded = ui.detail?.id === skill.id;
  const alreadyRequested = ui.requestedDetail === skill.id;
  if (detailIsLoaded || alreadyRequested) return;
  ui.requestedDetail = skill.id;
  send({ type: 'getDetail', skillId: skill.id });
}

export function skillsView(tab: SkillsTab): Node {
  if (inTab(tab).length === 0) return emptyTab(tab);
  const listElement = h('div', { class: 'list', 'aria-label': 'Skills', 'data-scroll-key': `list-${tab}` });
  const fillList = () => listElement.replaceChildren(...listContent(tab, refillKeepingScroll));
  // Emptying the list resets its scroll to 0 in Chromium: opening or closing a bundle must not jump.
  const refillKeepingScroll = () => {
    const scrollTop = listElement.scrollTop;
    fillList();
    listElement.scrollTop = scrollTop;
  };
  fillList();

  const selected = selectedSkill(tab);
  if (selected) requestDetailIfMissing(selected);
  const detailPane = h(
    'aside',
    { class: 'detail', 'aria-live': 'polite', 'data-scroll-key': `detail-${selected?.id ?? ''}` },
    selected ? skillDetail(selected) : h('div', { class: 'empty muted' }, 'Select a skill to see where it lives, who loads it and what it contains.'),
  );
  return h('div', { class: 'skills' }, tab === 'global' ? syncedNotice() : null, toolbar(fillList), h('div', { class: 'split' }, listElement, detailPane));
}

export function emptyTab(tab: SkillsTab): Node {
  if (tab === 'project' && !ui.state!.hasWorkspace) {
    return h(
      'div',
      { class: 'panel empty' },
      h('h2', null, 'No folder open'),
      h('p', { class: 'muted' }, 'Open a folder or workspace to see its project skills (.claude/skills, .agents/skills, .cursor/skills, .github/skills…).'),
    );
  }
  const goToInstall = () => {
    persisted.tab = 'install';
    save();
    render();
  };
  const explanation =
    tab === 'project'
      ? 'Skills in this workspace are shared with everyone who clones it. Install one from GitHub, or copy a global skill here with “Copy / Move…”.'
      : 'Global skills are available in every project. Install one from GitHub, or copy a project skill here with “Copy / Move…”.';
  return h(
    'div',
    { class: 'panel empty' },
    h('h2', null, tab === 'project' ? 'No project skills' : 'No global skills'),
    h('p', { class: 'muted' }, explanation),
    button('Install from GitHub', goToInstall, { kind: 'primary' }),
  );
}
