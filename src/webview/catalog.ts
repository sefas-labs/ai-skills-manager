/* Dashboard webview — skills catalog ("Browse" in the Install tab). Listing only;
 * Install hands the folder URL to the normal analyze → review → confirm flow. */
import type { ViewCatalogSkill } from '../shared/protocol';
import { render } from './main';
import { busy, catalog, errors, persisted, save, send, ui } from './store';
import { button, chip, h, icon, skeleton } from './dom';
import { analyze } from './install';

const RESULTS = '__results';
/** Collections already requested from the host (renders may run before the host's "busy" arrives). */
const requested = new Set<string>();

function activeSource(): string {
  return persisted.catalogSource ?? catalog.sources[0]?.id ?? '';
}

function load(id: string, force = false): void {
  if (id === RESULTS) return;
  if (!force && (catalog.bySource.has(id) || requested.has(id))) return;
  requested.add(id);
  errors['catalogList'] = undefined;
  send({ type: 'catalogList', sourceId: id, force });
}

function choose(id: string): void {
  persisted.catalogSource = id;
  save();
  load(id);
  render();
}

function installSkill(s: ViewCatalogSkill): void {
  persisted.url = s.url;
  persisted.installMode = 'url';
  save();
  analyze();
}

function card(s: ViewCatalogSkill, mixed: boolean): Node {
  return h(
    'article',
    { class: 'cat-card' },
    h(
      'div',
      { class: 'cat-head' },
      h('strong', { class: 'cat-name' }, s.name),
      s.installed === 'same-source'
        ? chip('installed', 'ok-chip', `Installed from this folder in ${s.installedIn.join(', ')}`)
        : s.installed === 'same-name'
          ? chip('same name installed', 'subtle', `A different skill named "${s.name}" is in ${s.installedIn.join(', ')}`)
          : null,
    ),
    h('div', { class: 'mono small muted cat-src', title: s.url }, mixed ? `${s.owner}/${s.repo}${s.dir ? ' · ' + s.dir : ''}` : s.dir || '(repository root)'),
    s.description ? h('p', { class: 'cat-desc' }, s.description) : h('p', { class: 'cat-desc muted' }, 'No description in its SKILL.md.'),
    h(
      'div',
      { class: 'cat-actions' },
      button(s.installed === 'same-source' ? 'Reinstall…' : 'Install…', () => installSkill(s), { kind: s.installed === 'same-source' ? 'secondary' : 'primary', title: 'Download it, review the files and the security checks, then choose where to install' }),
      h('button', { class: 'btn link', type: 'button', title: 'Open on GitHub', onClick: () => send({ type: 'openUrl', url: s.url }) }, icon('link-external'), 'GitHub'),
    ),
  );
}

export function catalogView(): Node {
  const s = ui.state!;
  const id = activeSource();
  if (id && id !== RESULTS) load(id);
  const q = (persisted.catalogQ ?? '').trim().toLowerCase();
  const listed = id === RESULTS ? catalog.results?.skills ?? [] : catalog.bySource.get(id)?.skills ?? [];
  const shownSkills = q && id !== RESULTS ? listed.filter((k) => k.name.toLowerCase().includes(q) || (k.description ?? '').toLowerCase().includes(q) || k.dir.toLowerCase().includes(q)) : listed;
  const loading = id === RESULTS ? busy.has('catalogSearch') : busy.has(`catalog:${id}`) || !catalog.bySource.has(id);
  const src = catalog.sources.find((x) => x.id === id);
  const searchGitHub = () => {
    const query = (persisted.catalogQ ?? '').trim();
    if (query.length < 2) return;
    errors['catalogSearch'] = undefined;
    persisted.catalogSource = RESULTS;
    save();
    send({ type: 'catalogSearch', query });
    render();
  };

  return h(
    'div',
    { class: 'catalog' },
    h(
      'div',
      { class: 'cat-toolbar' },
      h('input', {
        type: 'search',
        id: 'catalog-q',
        class: 'search',
        placeholder: id === RESULTS ? 'Search all of GitHub for skills' : 'Filter this collection, or search all of GitHub',
        value: persisted.catalogQ ?? '',
        'aria-label': 'Search skills',
        onInput: (e: Event) => {
          persisted.catalogQ = (e.target as HTMLInputElement).value;
          save();
          if (id !== RESULTS) render();
        },
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') searchGitHub();
        },
      }),
      s.githubSignedIn
        ? button(busy.has('catalogSearch') ? 'Searching…' : 'Search GitHub', searchGitHub, { kind: 'secondary', disabled: busy.has('catalogSearch') || (persisted.catalogQ ?? '').trim().length < 2, title: 'Code search over every public repository (like `gh skill search`)' })
        : button('Sign in to search GitHub', () => send({ type: 'signIn', privateRepos: false }), { kind: 'link', title: 'GitHub only allows code search for signed-in users' }),
    ),
    h(
      'div',
      { class: 'cat-sources', role: 'tablist', 'aria-label': 'Collections' },
      catalog.sources.map((c) => {
        const n = catalog.bySource.get(c.id)?.skills.length;
        return h('button', { class: `seg-chip ${c.id === id ? 'active' : ''}`, type: 'button', role: 'tab', 'aria-selected': c.id === id ? 'true' : 'false', title: c.blurb, onClick: () => choose(c.id) }, c.title, n !== undefined ? h('span', { class: 'count' }, String(n)) : null);
      }),
      catalog.results ? h('button', { class: `seg-chip ${id === RESULTS ? 'active' : ''}`, type: 'button', role: 'tab', onClick: () => choose(RESULTS) }, icon('search'), ` “${catalog.results.query}”`, h('span', { class: 'count' }, String(catalog.results.skills.length))) : null,
    ),
    src
      ? h('p', { class: 'small muted cat-blurb' }, src.blurb, ' ', button('Open repository', () => send({ type: 'openUrl', url: `https://github.com/${src.id}` }), { kind: 'link' }), catalog.bySource.has(id) ? [' · ', button('Refresh', () => load(id, true), { kind: 'link' })] : null)
      : id === RESULTS
        ? h('p', { class: 'small muted cat-blurb' }, 'Results from GitHub code search: any public repository, ranked by name and description matches. Check the source before installing.')
        : null,
    errors['catalogList'] && id !== RESULTS ? h('div', { class: 'banner error' }, errors['catalogList']) : null,
    errors['catalogSearch'] && id === RESULTS ? h('div', { class: 'banner error' }, errors['catalogSearch']) : null,
    loading && !shownSkills.length
      ? h('div', { class: 'cat-grid' }, Array.from({ length: 6 }, () => h('div', { class: 'cat-card' }, skeleton(4))))
      : shownSkills.length
        ? h('div', { class: 'cat-grid', 'data-scroll-key': `cat-${id}` }, shownSkills.map((k) => card(k, id === RESULTS)))
        : h('p', { class: 'muted pad' }, q ? 'No skills match. Press Enter to search all of GitHub.' : 'No skills found.'),
    catalog.bySource.get(id)?.truncated ? h('p', { class: 'small warn-text' }, 'GitHub truncated this repository’s file list; some skills may be missing.') : null,
    h('p', { class: 'small muted cat-note' }, icon('shield'), ' Collections are popular public repositories, not reviewed by this extension. Every install downloads the exact commit, shows its files and a security review, and asks before writing anything.'),
  );
}
