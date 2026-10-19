/* Dashboard webview — overview. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { ViewMerge } from '../shared/protocol';
import { render } from './main';
import { type Tab, busy, persisted, save, send, ui } from './store';
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

/** Everything actionable, in the order it's worth doing. */
export function todoItems(): TodoItem[] {
  const s = ui.state!;
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
export function healthRing(ok: number, total: number): Node {
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

export function healthHero(): Node {
  const s = ui.state!;
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

export function overview(): Node {
  const s = ui.state!;
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
            l.exists && l.skillCount && !l.readers.some((r) => ui.state!.agents[r]?.installed) ? h('div', { class: 'small warn-text' }, 'No installed agent reads this folder') : null,
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

export function scrollToMerges(): void {
  persisted.tab = 'overview';
  save();
  render();
  const el = document.getElementById('merges') as HTMLDetailsElement | null;
  if (el) {
    el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

export const VERDICT: Record<ViewMerge['verdict'], string> = {
  'remove-redundant': 'Redundant copies — every agent keeps it with fewer folders',
  'unify-versions': 'Different versions — all copies are needed, but agents see different content',
  expected: 'Copies are needed to reach every agent (no single folder reaches all of them)',
};

export function mergePanel(): Node | null {
  const s = ui.state!;
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

export function agentStatus(id: string): Node | null {
  const a = ui.state!.agents[id];
  if (!a) return null;
  return a.installed
    ? h('p', { class: 'small ok-text', title: a.evidence.join(' · ') }, icon('pass'), ' Detected — ', a.evidence[0], a.evidence.length > 1 ? ` (+${a.evidence.length - 1})` : '')
    : h('p', { class: 'small muted' }, icon('circle-slash'), ' Not detected on this machine');
}

