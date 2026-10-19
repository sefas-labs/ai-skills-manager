/* Dashboard webview — skills catalog ("Browse" in the Install tab). Listing only;
 * Install hands the folder URL to the normal analyze → review → confirm flow. */
import type { ViewCatalogSkill, ViewCatalogSource } from '../shared/protocol';
import { render } from './main';
import { busy, catalog, errors, persisted, save, send, ui } from './store';
import { type Child, button, chip, h, icon, skeleton } from './dom';
import { analyze } from './install';

/** Pseudo-collection id for the results of a GitHub search. */
const SEARCH_RESULTS = '__results';
const MIN_SEARCH_LENGTH = 2;
const PLACEHOLDER_CARDS = 6;
const PLACEHOLDER_LINES_PER_CARD = 4;

/** Collections already requested from the host (renders may run before the host's "busy" arrives). */
const requested = new Set<string>();

function activeSource(): string {
  return persisted.catalogSource ?? catalog.sources[0]?.id ?? '';
}

function searchText(): string {
  return (persisted.catalogQuery ?? '').trim();
}

function loadCollection(sourceId: string, force = false): void {
  if (sourceId === SEARCH_RESULTS) return;
  const alreadyLoaded = catalog.bySource.has(sourceId) || requested.has(sourceId);
  if (alreadyLoaded && !force) return;
  requested.add(sourceId);
  errors['catalogList'] = undefined;
  send({ type: 'catalogList', sourceId, force });
}

function chooseCollection(sourceId: string): void {
  persisted.catalogSource = sourceId;
  save();
  loadCollection(sourceId);
  render();
}

function installSkill(skill: ViewCatalogSkill): void {
  persisted.url = skill.url;
  persisted.installMode = 'url';
  save();
  analyze();
}

function searchGitHub(): void {
  const query = searchText();
  if (query.length < MIN_SEARCH_LENGTH) return;
  errors['catalogSearch'] = undefined;
  persisted.catalogSource = SEARCH_RESULTS;
  save();
  send({ type: 'catalogSearch', query });
  render();
}

function installedChip(skill: ViewCatalogSkill): Child {
  const where = skill.installedIn.join(', ');
  if (skill.installed === 'same-source') return chip('installed', 'ok-chip', `Installed from this folder in ${where}`);
  if (skill.installed === 'same-name') return chip('same name installed', 'subtle', `A different skill named "${skill.name}" is in ${where}`);
  return null;
}

/** In search results the repository matters; inside a collection only the folder does. */
function sourceLabel(skill: ViewCatalogSkill, fromSearch: boolean): string {
  if (!fromSearch) return skill.dir || '(repository root)';
  return `${skill.owner}/${skill.repo}${skill.dir ? ' · ' + skill.dir : ''}`;
}

function card(skill: ViewCatalogSkill, fromSearch: boolean): Node {
  const isReinstall = skill.installed === 'same-source';
  return h(
    'article',
    { class: 'cat-card' },
    h('div', { class: 'cat-head' }, h('strong', { class: 'cat-name' }, skill.name), installedChip(skill)),
    h('div', { class: 'mono small muted cat-src', title: skill.url }, sourceLabel(skill, fromSearch)),
    skill.description ? h('p', { class: 'cat-desc' }, skill.description) : h('p', { class: 'cat-desc muted' }, 'No description in its SKILL.md.'),
    h(
      'div',
      { class: 'cat-actions' },
      button(isReinstall ? 'Reinstall…' : 'Install…', () => installSkill(skill), {
        kind: isReinstall ? 'secondary' : 'primary',
        title: 'Download it, review the files and the security checks, then choose where to install',
      }),
      h('button', { class: 'btn link', type: 'button', title: 'Open on GitHub', onClick: () => send({ type: 'openUrl', url: skill.url }) }, icon('link-external'), 'GitHub'),
    ),
  );
}

function matchesFilter(skill: ViewCatalogSkill, filter: string): boolean {
  return [skill.name, skill.description ?? '', skill.dir].some((text) => text.toLowerCase().includes(filter));
}

function toolbar(activeId: string): Node {
  const isSearchResults = activeId === SEARCH_RESULTS;
  const searching = busy.has('catalogSearch');
  const searchAction = ui.state!.githubSignedIn
    ? button(searching ? 'Searching…' : 'Search GitHub', searchGitHub, {
        kind: 'secondary',
        disabled: searching || searchText().length < MIN_SEARCH_LENGTH,
        title: 'Code search over every public repository (like `gh skill search`)',
      })
    : button('Sign in to search GitHub', () => send({ type: 'signIn', privateRepos: false }), { kind: 'link', title: 'GitHub only allows code search for signed-in users' });
  return h(
    'div',
    { class: 'cat-toolbar' },
    h('input', {
      type: 'search',
      id: 'catalog-q',
      class: 'search',
      placeholder: isSearchResults ? 'Search all of GitHub for skills' : 'Filter this collection, or search all of GitHub',
      value: persisted.catalogQuery ?? '',
      'aria-label': 'Search skills',
      onInput: (event: Event) => {
        persisted.catalogQuery = (event.target as HTMLInputElement).value;
        save();
        if (!isSearchResults) render();
      },
      onKeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') searchGitHub();
      },
    }),
    searchAction,
  );
}

function collectionTabs(activeId: string): Node {
  const collectionTab = (source: ViewCatalogSource) => {
    const isActive = source.id === activeId;
    const skillCount = catalog.bySource.get(source.id)?.skills.length;
    return h(
      'button',
      { class: `seg-chip ${isActive ? 'active' : ''}`, type: 'button', role: 'tab', 'aria-selected': isActive ? 'true' : 'false', title: source.blurb, onClick: () => chooseCollection(source.id) },
      source.title,
      skillCount !== undefined ? h('span', { class: 'count' }, String(skillCount)) : null,
    );
  };
  const results = catalog.results;
  const resultsTab = results
    ? h(
        'button',
        { class: `seg-chip ${activeId === SEARCH_RESULTS ? 'active' : ''}`, type: 'button', role: 'tab', onClick: () => chooseCollection(SEARCH_RESULTS) },
        icon('search'),
        ` “${results.query}”`,
        h('span', { class: 'count' }, String(results.skills.length)),
      )
    : null;
  return h('div', { class: 'cat-sources', role: 'tablist', 'aria-label': 'Collections' }, catalog.sources.map(collectionTab), resultsTab);
}

function collectionBlurb(activeId: string): Node | null {
  if (activeId === SEARCH_RESULTS) {
    return h('p', { class: 'small muted cat-blurb' }, 'Results from GitHub code search: any public repository, ranked by name and description matches. Check the source before installing.');
  }
  const source = catalog.sources.find((candidate) => candidate.id === activeId);
  if (!source) return null;
  const refresh = catalog.bySource.has(activeId) ? [' · ', button('Refresh', () => loadCollection(activeId, true), { kind: 'link' })] : null;
  return h(
    'p',
    { class: 'small muted cat-blurb' },
    source.blurb,
    ' ',
    button('Open repository', () => send({ type: 'openUrl', url: `https://github.com/${source.id}` }), { kind: 'link' }),
    refresh,
  );
}

function skillGrid(activeId: string, skills: ViewCatalogSkill[], isLoading: boolean, isFiltering: boolean): Node {
  if (isLoading && !skills.length) {
    return h('div', { class: 'cat-grid' }, Array.from({ length: PLACEHOLDER_CARDS }, () => h('div', { class: 'cat-card' }, skeleton(PLACEHOLDER_LINES_PER_CARD))));
  }
  if (!skills.length) return h('p', { class: 'muted pad' }, isFiltering ? 'No skills match. Press Enter to search all of GitHub.' : 'No skills found.');
  return h('div', { class: 'cat-grid', 'data-scroll-key': `cat-${activeId}` }, skills.map((skill) => card(skill, activeId === SEARCH_RESULTS)));
}

export function catalogView(): Node {
  const activeId = activeSource();
  const isSearchResults = activeId === SEARCH_RESULTS;
  if (activeId && !isSearchResults) loadCollection(activeId);
  const filter = searchText().toLowerCase();
  const listed = isSearchResults ? (catalog.results?.skills ?? []) : (catalog.bySource.get(activeId)?.skills ?? []);
  const visible = filter && !isSearchResults ? listed.filter((skill) => matchesFilter(skill, filter)) : listed;
  const isLoading = isSearchResults ? busy.has('catalogSearch') : busy.has(`catalog:${activeId}`) || !catalog.bySource.has(activeId);
  const listError = errors['catalogList'] && !isSearchResults ? h('div', { class: 'banner error' }, errors['catalogList']) : null;
  const searchError = errors['catalogSearch'] && isSearchResults ? h('div', { class: 'banner error' }, errors['catalogSearch']) : null;
  return h(
    'div',
    { class: 'catalog' },
    toolbar(activeId),
    collectionTabs(activeId),
    collectionBlurb(activeId),
    listError,
    searchError,
    skillGrid(activeId, visible, isLoading, !!filter),
    catalog.bySource.get(activeId)?.truncated ? h('p', { class: 'small warn-text' }, 'GitHub truncated this repository’s file list; some skills may be missing.') : null,
    h(
      'p',
      { class: 'small muted cat-note' },
      icon('shield'),
      ' Collections are popular public repositories, not reviewed by this extension. Every install downloads the exact commit, shows its files and a security review, and asks before writing anything.',
    ),
  );
}
