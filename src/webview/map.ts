/* Dashboard webview — map. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { ResolvedLocation } from '../core/types';
import type { ViewSkill } from '../shared/protocol';
import { render } from './main';
import { persisted, save, send, ui } from './store';
import { button, clip, h, icon, svg } from './dom';
import { agentColor, isHost, providerName, qname, short, shown, swatch } from './agents';
import { emptyTab, inTab, selectSkill } from './skills';

export type MapScope = 'project' | 'global';

export function mapScope(): MapScope {
  if (persisted.mapScope) return persisted.mapScope;
  return inTab('project').length ? 'project' : 'global';
}

export interface CoverageRow {
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

export function coverage(scope: MapScope): CoverageRow[] {
  const s = ui.state!;
  const agents = shown();
  const byName = new Map<string, ViewSkill[]>();
  for (const sk of inTab(scope)) byName.set(qname(sk), [...(byName.get(qname(sk)) ?? []), sk]);
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

export function mapView(): Node {
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

/** Three columns (agents, folders, skills) joined by curves; pure SVG, colors from theme tokens via CSS classes. */
export function flowDiagram(scope: MapScope): Node {
  const s = ui.state!;
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
    node(`s:${k.id}`, clip(qname(k), 26), `${qname(k)}\n${reached ? `Used by ${agents.filter((a) => k.visibleTo.includes(a.id)).map((a) => a.displayName).join(', ')}` : 'No installed agent uses it'}${dup ? '\nSame name in another folder' : ''}`, `skill ${dup ? 'dup' : ''} ${reached ? '' : 'orphan'}`, () => selectSkill(k.id));
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

