/* Dashboard webview — skills. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { Issue } from '../core/types';
import type { ViewSkill } from '../shared/protocol';
import { render } from './main';
import { type SkillsTab, busy, persisted, save, send, ui } from './store';
import { type Child, button, chip, h, icon, select, sevIcon, skeleton } from './dom';
import { agentDots, agentPill, fmtDate, problems, providerName, qname, short, shortId, shown, swatch } from './agents';
import { scrollToMerges } from './overview';

/** Issues of an installed skill, each with its fix button (or a pointer to edit by hand). */
export function checksList(sk: ViewSkill): Node {
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
      const merge = i.code.startsWith('duplicate:') && ui.state!.merges.some((m) => m.copies.some((c) => c.skillId === sk.id)) && !offered.has('merge');
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

export function issueList(issues: Issue[]) {
  if (!issues.length) return h('p', { class: 'muted' }, 'No problems found.');
  return h('ul', { class: 'issues' }, issues.map((i) => h('li', null, sevIcon(i.severity), h('span', null, i.message))));
}

/** Project = workspace folders (incl. parent/nested); Global = user and admin/system folders. */
export function tabOf(sk: ViewSkill): SkillsTab {
  return sk.scope === 'workspace' ? 'project' : 'global';
}

export function inTab(t: SkillsTab): ViewSkill[] {
  return ui.state ? ui.state.skills.filter((sk) => tabOf(sk) === t) : [];
}

export function selectSkill(id: string) {
  const sk = ui.state?.skills.find((x) => x.id === id);
  persisted.tab = sk ? tabOf(sk) : 'project';
  persisted.selected = id;
  ui.detail = null;
  ui.requestedDetail = undefined;
  save();
  render();
}

export function filtered(t: SkillsTab): ViewSkill[] {
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

export const expandedGroups = new Set<string>();

/** Tabs where the first skill was already opened automatically (never fight the user afterwards). */
export const autoPicked = new Set<SkillsTab>();

export const wideLayout = () => window.matchMedia?.('(min-width: 821px)').matches ?? true;

export function rowChips(sk: ViewSkill): Child[] {
  return [
    sk.scope === 'admin' ? chip('admin', 'scope-admin') : null,
    sk.isSymlink ? chip('link', 'subtle', `→ ${sk.realDir}`) : null,
    sk.namespace ? chip('plugin', 'subtle', sk.readOnlyReason) : sk.managed === 'synced' ? chip('claude.ai', 'subtle', 'Synced from claude.ai (read-only)') : sk.readOnly ? chip('read-only', 'subtle', sk.readOnlyReason) : null,
    sk.group ? chip(`${sk.group}/`, 'subtle', 'Inside a category folder: only Cursor walks skill folders recursively') : null,
    ...offChips(sk),
    sk.update?.status === 'update-available' ? chip('update', 'update', 'A newer version is available on GitHub') : null,
  ];
}

export function worstOf(skills: ViewSkill[]): string {
  const p = skills.flatMap(problems);
  return p.some((i) => i.severity === 'error') ? 'error' : p.length ? 'warning' : '';
}

export function skillRow(sk: ViewSkill, child: boolean): Node {
  const worst = worstOf([sk]);
  const sel = persisted.selected === sk.id;
  return h(
    'button',
    { class: `row ${child ? 'child' : ''} ${sel ? 'selected' : ''}`, 'aria-current': sel ? 'true' : undefined, type: 'button', onClick: () => selectSkill(sk.id) },
    child
      ? h('div', { class: 'row-head' }, worst ? sevIcon(worst) : null, h('span', { class: 'mono loc' }, sk.locationLabel), ...rowChips(sk), agentDots(sk.visibleTo))
      : [
          h('div', { class: 'row-head' }, worst ? sevIcon(worst) : null, h('span', { class: 'name' }, sk.namespace ? h('span', { class: 'ns' }, `${sk.namespace}:`) : null, sk.name), ...rowChips(sk)),
          sk.description ? h('div', { class: 'desc' }, sk.description) : h('div', { class: 'desc muted' }, 'No description'),
          h('div', { class: 'row-foot' }, h('span', { class: 'mono small muted loc' }, sk.locationLabel), agentDots(sk.visibleTo)),
        ],
  );
}

/** Where a skill came from, when it arrived with others: a plugin, claude.ai, Cursor, a GitHub repo or a category folder. */
export interface Bundle {
  key: string;
  title: string;
  kind: string;
  icon: string;
}

export function bundleOf(sk: ViewSkill): Bundle | undefined {
  if (sk.namespace) {
    const synced = sk.locationLabel.startsWith('claude.ai plugin');
    return { key: `plugin:${sk.namespace}`, title: sk.namespace, kind: synced ? 'claude.ai plugin' : 'Claude Code plugin', icon: 'extensions' };
  }
  const cursorPlugin = /^Cursor plugin (.+) \(local\)$/.exec(sk.locationLabel);
  if (cursorPlugin) return { key: `cursor-plugin:${cursorPlugin[1]}`, title: cursorPlugin[1], kind: 'Cursor plugin', icon: 'extensions' };
  if (sk.locationLabel === 'Cursor built-in skills') return { key: 'cursor-builtin', title: 'Cursor built-in', kind: 'Ships with Cursor', icon: 'package' };
  if (sk.managed === 'synced') return { key: 'claude-ai', title: 'claude.ai', kind: 'Synced from your account', icon: 'cloud' };
  const repo = sk.source && /^https:\/\/github\.com\/([^/]+\/[^/]+)/.exec(sk.source.url)?.[1];
  if (repo) return { key: `gh:${repo.toLowerCase()}:${sk.scope}`, title: repo, kind: 'Installed from GitHub', icon: 'github' };
  if (sk.group) return { key: `group:${sk.locationId}:${sk.group}`, title: `${sk.group}/`, kind: `Category folder in ${sk.locationLabel}`, icon: 'folder' };
  return undefined;
}

/** Rows for a list of skills: same name in several folders → one expandable copies group. */
function nameRows(items: ViewSkill[]): Node[] {
  const groups = new Map<string, ViewSkill[]>();
  for (const sk of items) groups.set(qname(sk), [...(groups.get(qname(sk)) ?? []), sk]);
  return [...groups.values()].map((copies) => (copies.length === 1 ? skillRow(copies[0], false) : groupRows(copies)));
}

export function bundleRows(b: Bundle, items: ViewSkill[], refill: () => void): Node {
  const open = !!persisted.q.trim() || (persisted.openBundles ?? []).includes(b.key) || items.some((c) => c.id === persisted.selected);
  const worst = worstOf(items);
  const union = [...new Set(items.flatMap((c) => c.visibleTo))];
  const names = [...new Set(items.map((c) => c.name))];
  const toggle = () => {
    const set = new Set(persisted.openBundles ?? []);
    if (open) {
      set.delete(b.key);
      if (items.some((c) => c.id === persisted.selected)) persisted.selected = undefined;
    } else set.add(b.key);
    persisted.openBundles = [...set];
    save();
    if (persisted.selected === undefined) render();
    else refill();
  };
  return h(
    'div',
    { class: `bundle ${open ? 'open' : ''}` },
    h(
      'button',
      { class: 'row bundle-head', type: 'button', 'aria-expanded': open ? 'true' : 'false', onClick: toggle },
      h(
        'div',
        { class: 'row-head' },
        icon(open ? 'chevron-down' : 'chevron-right', 'chev'),
        icon(b.icon),
        worst ? sevIcon(worst) : null,
        h('span', { class: 'name' }, b.title),
        chip(`${names.length} skill${names.length === 1 ? '' : 's'}`, 'subtle'),
        h('span', { class: 'small muted' }, b.kind),
      ),
      open ? null : h('div', { class: 'desc muted' }, names.slice(0, 6).join(' · ') + (names.length > 6 ? ` · +${names.length - 6} more` : '')),
      h('div', { class: 'row-foot' }, h('span', { class: 'mono small muted loc' }, [...new Set(items.map((c) => c.locationLabel))].join(' · ')), agentDots(union)),
    ),
    open ? h('div', { class: 'bundle-children' }, nameRows(items)) : null,
  );
}

/** Skills in display order: your own first, then one bundle per source. */
export function listLayout(items: ViewSkill[]): { loose: ViewSkill[]; bundles: Array<[Bundle, ViewSkill[]]> } {
  if (persisted.flatList) return { loose: items, bundles: [] };
  const by = new Map<string, [Bundle, ViewSkill[]]>();
  for (const sk of items) {
    const b = bundleOf(sk);
    if (b) by.set(b.key, [by.get(b.key)?.[0] ?? b, [...(by.get(b.key)?.[1] ?? []), sk]]);
  }
  // A source with a single skill isn't worth a level of nesting.
  const bundles = [...by.values()].filter(([, list]) => list.length > 1).sort((a, b) => a[0].title.localeCompare(b[0].title));
  const inBundle = new Set(bundles.flatMap(([, list]) => list.map((s) => s.id)));
  return { loose: items.filter((s) => !inBundle.has(s.id)), bundles };
}

export function groupRows(copies: ViewSkill[]): Node {
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

/** Small chips for agents that have the skill switched off or manual-only. */
function offChips(sk: ViewSkill): Child[] {
  const t = sk.toggles;
  if (!t) return [];
  const vis = (id: string) => sk.visibleTo.includes(id) && shown().some((p) => p.id === id);
  return [
    vis('claude-code') && t.claude && t.claude.value !== 'on' ? chip(t.claude.value === 'off' ? 'off: Claude' : 'Claude: limited', 'warn', `Claude Code skillOverrides: ${t.claude.value}`) : null,
    vis('codex') && t.codex && !t.codex.enabled ? chip('off: Codex', 'warn', 'Disabled in ~/.codex/config.toml') : null,
    !t.userInvocable && !t.modelInvocation ? chip('disabled', 'warn', 'disable-model-invocation + user-invocable: false') : !t.modelInvocation ? chip('manual', 'subtle', 'Only loads when invoked as /' + sk.name) : null,
  ];
}

/** Per-agent on/off, each with the agent's own mechanism. */
function switchesSection(sk: ViewSkill): Node | null {
  const t = sk.toggles;
  if (!t) return null;
  const agents = shown().filter((p) => sk.visibleTo.includes(p.id));
  if (!agents.length) return null;
  const working = busy.has('toggle');
  const seg = <T extends string>(options: Array<[T, string, string]>, current: T, onPick: (v: T) => void, disabled = false) =>
    h(
      'div',
      { class: 'segmented small-seg', role: 'group' },
      options.map(([v, label, title]) =>
        h('button', { class: `seg ${v === current ? 'active' : ''}`, type: 'button', title, 'aria-pressed': v === current ? 'true' : 'false', disabled: disabled || working || v === current, onClick: () => onPick(v) }, label),
      ),
    );
  const rows: Node[] = [];
  const has = (id: string) => agents.some((a) => a.id === id);
  if (has('claude-code')) {
    rows.push(
      h(
        'div',
        { class: 'switch-row' },
        h('span', { class: 'switch-agent' }, swatch('claude-code'), 'Claude Code'),
        sk.namespace || !t.claude
          ? h('span', { class: 'small muted' }, 'Plugin skill — enable or disable the plugin with /plugin in Claude Code.')
          : [
              seg<'on' | 'name-only' | 'user-invocable-only' | 'off'>(
                [
                  ['on', 'On', 'Listed to Claude with its description'],
                  ['name-only', 'Name only', 'Listed to Claude by name only'],
                  ['user-invocable-only', 'Only /name', 'Hidden from Claude; you can still run /' + sk.name],
                  ['off', 'Off', 'Hidden everywhere'],
                ],
                t.claude.value,
                (value) => send({ type: 'setToggle', skillId: sk.id, agent: 'claude', value }),
              ),
              t.claude.from ? h('span', { class: 'small muted' }, `from ${t.claude.from} settings`) : null,
            ],
      ),
    );
  }
  if (has('codex') && t.codex) {
    rows.push(
      h(
        'div',
        { class: 'switch-row' },
        h('span', { class: 'switch-agent' }, swatch('codex'), 'Codex'),
        seg<'on' | 'off'>([['on', 'On', 'Enabled'], ['off', 'Off', 'Disabled in ~/.codex/config.toml (restart Codex)']], t.codex.enabled ? 'on' : 'off', (v) => send({ type: 'setToggle', skillId: sk.id, agent: 'codex', enabled: v === 'on' })),
      ),
    );
  }
  const fmAgents = agents.filter((a) => a.id === 'cursor' || a.id === 'copilot');
  if (fmAgents.length) {
    const mode = !t.modelInvocation && !t.userInvocable ? 'off' : !t.modelInvocation ? 'manual' : 'auto';
    rows.push(
      h(
        'div',
        { class: 'switch-row' },
        h('span', { class: 'switch-agent' }, fmAgents.map((a) => swatch(a.id)), fmAgents.map((a) => short(a.displayName)).join(' & ')),
        seg<'auto' | 'manual' | 'off'>(
          [
            ['auto', 'Auto', 'Agents load it when relevant'],
            ['manual', 'Only /name', 'disable-model-invocation: true'],
            ['off', 'Off', 'disable-model-invocation: true + user-invocable: false'],
          ],
          mode,
          (v) => send({ type: 'setToggle', skillId: sk.id, agent: 'frontmatter', mode: v }),
          sk.readOnly,
        ),
        h('span', { class: 'small muted', title: 'Cursor and Copilot have no per-skill setting: this edits SKILL.md and also affects Claude Code' }, sk.readOnly ? 'read-only skill' : 'edits SKILL.md'),
      ),
    );
  }
  return h('div', { class: 'switches' }, h('h3', null, 'On / off per agent'), rows);
}

export function skillsView(t: SkillsTab): Node {
  if (inTab(t).length === 0) return emptyTab(t);
  const listEl = h('div', { class: 'list', 'aria-label': 'Skills', 'data-scroll-key': `list-${t}` });
  const fillList = () => {
    const items = filtered(t);
    // Skills that came together (a plugin, claude.ai, a repo) collapse into one bundle;
    // the same name in several folders → one expandable copies group (see "Copies" in the detail).
    const { loose, bundles } = listLayout(items);
    const label = (text: string) => h('div', { class: 'list-label small muted' }, text);
    listEl.replaceChildren(
      ...(items.length
        ? [
            ...(bundles.length && loose.length ? [label('Your skills')] : []),
            ...nameRows(loose),
            ...(bundles.length ? [label(`From plugins & sources · ${bundles.length}`)] : []),
            ...bundles.map(([b, list]) => bundleRows(b, list, fillList)),
          ]
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
    h(
      'button',
      {
        class: `btn link icon-only ${persisted.flatList ? '' : 'active'}`,
        type: 'button',
        title: persisted.flatList ? 'Group by source (plugins, claude.ai, repos)' : 'Show every skill on its own',
        'aria-label': 'Group by source',
        'aria-pressed': persisted.flatList ? 'false' : 'true',
        onClick: () => ((persisted.flatList = !persisted.flatList), save(), render()),
      },
      icon(persisted.flatList ? 'list-flat' : 'list-tree'),
    ),
  );

  // One selection for both tabs; only shown in the tab it belongs to. On wide
  // layouts, open the first skill instead of leaving the ui.detail pane empty.
  let selected = inTab(t).find((x) => x.id === persisted.selected);
  if (!selected && wideLayout() && !autoPicked.has(t)) {
    autoPicked.add(t);
    const { loose, bundles } = listLayout(filtered(t));
    selected = loose[0] ?? bundles[0]?.[1][0];
    if (selected) {
      persisted.selected = selected.id;
      save();
    }
  }
  if (selected && (!ui.detail || ui.detail.id !== selected.id) && ui.requestedDetail !== selected.id) {
    ui.requestedDetail = selected.id;
    send({ type: 'getDetail', skillId: selected.id });
  }
  return h('div', { class: 'skills' }, t === 'global' ? syncedNotice() : null, toolbar, h('div', { class: 'split' }, listEl, h('aside', { class: 'detail', 'aria-live': 'polite', 'data-scroll-key': `detail-${selected?.id ?? ''}` }, selected ? skillDetail(selected) : h('div', { class: 'empty muted' }, 'Select a skill to see where it lives, who loads it and what it contains.'))));
}

/** Explains why skills synced for another claude.ai account are not listed (they used to look like duplicates). */
export function syncedNotice(): Node | null {
  const loc = ui.state!.locations.find((l) => l.skippedSyncedBuckets?.length);
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
      h('p', null, 'Other account ', h('span', { class: 'mono' }, shortId(b.bucket)), ` — last synced ${fmtDate(b.lastSynced)}, not loaded: `, h('span', { class: 'mono' }, b.skills.join(', ')), ' ', button('Move to backup…', () => send({ type: 'archiveSynced', bucket: b.bucket }), { kind: 'link', title: 'Clean up this leftover folder (recoverable from the backup folder)' })),
    ),
    h('p', { class: 'muted small' }, 'Same names in both folders (docs, pdf…) are the same claude.ai skills downloaded once per account — that is why they looked duplicated. Nothing to fix: Claude Code manages this folder and uses the old one again if you sign in with that account.'),
  );
}

/** Every folder that has a skill with this name, and a way to make one of them the version agents use. */
export function copiesSection(sk: ViewSkill): Node | null {
  const copies = ui.state!.skills.filter((x) => qname(x) === qname(sk));
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

export function otherAccountNote(sk: ViewSkill): Node | null {
  if (sk.managed !== 'synced') return null;
  const hit = ui.state!.locations.flatMap((l) => l.skippedSyncedBuckets ?? []).find((b) => b.skills.includes(sk.name));
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

export function emptyTab(t: SkillsTab): Node {
  const goInstall = () => ((persisted.tab = 'install'), save(), render());
  if (t === 'project' && !ui.state!.hasWorkspace) {
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

export function skillDetail(sk: ViewSkill): Node {
  const d = ui.detail && ui.detail.id === sk.id ? ui.detail : null;
  return h(
    'div',
    null,
    h('div', { class: 'detail-head' }, h('h2', null, sk.namespace ? h('span', { class: 'ns' }, `${sk.namespace}:`) : null, sk.name), h('div', { class: 'actions' }, button('Open SKILL.md', () => send({ type: 'openSkillFile', skillId: sk.id }), { kind: 'primary' }), button('Reveal', () => send({ type: 'reveal', skillId: sk.id })), button('Copy path', () => send({ type: 'copyPath', skillId: sk.id })), sk.scope !== 'workspace' ? button('Add to project…', () => send({ type: 'addToProject', skillId: sk.id }), { kind: 'primary', disabled: busy.has('addToProject'), title: 'Copy this skill into a skills folder of the open project' }) : null, button('Copy / Move…', () => send({ type: 'copyMove', skillId: sk.id }), { title: 'Copy or move to another skills folder; shows which agents gain or lose it first' }), button('Remove…', () => send({ type: 'uninstall', skillId: sk.id }), { kind: 'danger', disabled: sk.readOnly, title: sk.readOnly ? sk.readOnlyReason : 'Remove this skill (asks for confirmation)' }))),
    sk.description ? h('p', null, sk.description) : null,
    h('h3', null, 'Available to'),
    h('div', { class: 'vis big' }, shown().map((p) => agentPill(p.id, sk.visibleTo.includes(p.id)))),
    switchesSection(sk),
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

export const UPDATE_TEXT: Record<string, string> = {
  'up-to-date': 'Up to date',
  'update-available': 'Update available',
  pinned: 'Pinned to a commit — not updated',
  'ref-missing': 'Branch or tag no longer exists',
  'path-missing': 'Folder no longer exists upstream',
  unknown: 'Unknown — review to compare',
  error: 'Check failed',
};

export function updateLine(sk: ViewSkill): Node {
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

