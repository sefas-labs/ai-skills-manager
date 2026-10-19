/* Dashboard webview — Map tab: a skill × agent coverage table with a one-click
 * fix per gap, and a diagram of agent → folder → skill. */
import type { ProviderSummary, ResolvedLocation } from '../core/types';
import type { ViewSkill } from '../shared/protocol';
import { changeView } from './main';
import { persisted, send, ui } from './store';
import { type Child, button, clip, h, icon, svg } from './dom';
import { agentColor, isHost, providerName, qname, short, shown, swatch } from './agents';
import { emptyTab, inTab, selectSkill } from './skills';

export type MapScope = 'project' | 'global';
type CellStatus = 'ok' | 'twice' | 'missing';

export interface CoverageRow {
  name: string;
  copies: ViewSkill[];
  cells: Record<string, CellStatus>;
  missing: string[];
  /** Every copy is synced from claude.ai: copying it elsewhere would create a stale, unsynced copy. */
  synced: boolean;
  /** Best writable folder of the same scope that adds the missing agents. */
  fix?: { location: ResolvedLocation; gains: string[]; source: ViewSkill };
}

export function mapScope(): MapScope {
  if (persisted.mapScope) return persisted.mapScope;
  return inTab('project').length ? 'project' : 'global';
}

// ---------- coverage table ----------

function cellStatus(copies: ViewSkill[], agentId: string): CellStatus {
  const loadedBy = copies.some((copy) => copy.visibleTo.includes(agentId));
  if (!loadedBy) return 'missing';
  const seesTwo = copies.some((copy) => copy.issues.some((issue) => issue.code === `duplicate:${agentId}`));
  return seesTwo ? 'twice' : 'ok';
}

/** Writable plain folders of the scope (no parent, nested or plugin folders). */
function writableFoldersOf(scope: MapScope): ResolvedLocation[] {
  const locationScope = scope === 'project' ? 'workspace' : 'global';
  return ui.state!.locations.filter((location) => !location.readOnly && location.scope === locationScope && !location.origin);
}

/** The folder that gives the skill to the most missing agents; existing folders win ties. */
function bestFix(copies: ViewSkill[], missing: string[], candidates: ResolvedLocation[]): CoverageRow['fix'] {
  const foldersWithCopy = new Set(copies.map((copy) => copy.locationId));
  const best = candidates
    .filter((location) => !foldersWithCopy.has(location.id))
    .map((location) => ({ location, gains: missing.filter((agentId) => location.readers.includes(agentId)) }))
    .filter((option) => option.gains.length)
    .sort((first, second) => second.gains.length - first.gains.length || Number(second.location.exists) - Number(first.location.exists))[0];
  return best ? { ...best, source: copies[0] } : undefined;
}

export function coverage(scope: MapScope): CoverageRow[] {
  const agents = shown();
  const copiesByName = new Map<string, ViewSkill[]>();
  for (const skill of inTab(scope)) copiesByName.set(qname(skill), [...(copiesByName.get(qname(skill)) ?? []), skill]);
  const candidates = writableFoldersOf(scope);
  const rows = [...copiesByName.entries()].map(([name, copies]) => {
    const cells: CoverageRow['cells'] = {};
    for (const agent of agents) cells[agent.id] = cellStatus(copies, agent.id);
    const missing = agents.filter((agent) => cells[agent.id] === 'missing').map((agent) => agent.id);
    const synced = copies.every((copy) => copy.managed === 'synced');
    const fix = missing.length && !synced ? bestFix(copies, missing, candidates) : undefined;
    return { name, copies, cells, missing, synced, fix };
  });
  // Your own skills first, the most gaps first, then by name; claude.ai ones at the end.
  return rows.sort((first, second) => Number(first.synced) - Number(second.synced) || second.missing.length - first.missing.length || first.name.localeCompare(second.name));
}

function scopeSwitch(current: MapScope): Node {
  const scopeButton = (scope: MapScope, label: string) =>
    h('button', { class: `seg ${current === scope ? 'active' : ''}`, type: 'button', 'aria-pressed': current === scope ? 'true' : 'false', onClick: () => changeView({ mapScope: scope }) }, label);
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': 'Scope' },
    scopeButton('project', `Project (${inTab('project').length})`),
    scopeButton('global', `Global (${inTab('global').length})`),
  );
}

function coverageSummary(rows: CoverageRow[]): Node | null {
  if (!rows.length) return null;
  const withGaps = rows.filter((row) => row.missing.length).length;
  const seenTwice = rows.filter((row) => Object.values(row.cells).includes('twice')).length;
  return h(
    'div',
    { class: 'map-summary' },
    h('span', { class: 'sum ok-text' }, `${rows.length - withGaps} fully covered`),
    h('span', { class: `sum ${withGaps ? 'warn-text' : 'muted'}` }, `${withGaps} with gaps`),
    h('span', { class: `sum ${seenTwice ? 'warn-text' : 'muted'}` }, `${seenTwice} seen twice`),
  );
}

function cellExplanation(row: CoverageRow, agent: ProviderSummary): string {
  switch (row.cells[agent.id]) {
    case 'ok': {
      const folders = row.copies.filter((copy) => copy.visibleTo.includes(agent.id)).map((copy) => copy.locationLabel);
      return `${agent.displayName} loads it from ${folders.join(', ')}`;
    }
    case 'twice':
      return `${agent.displayName} sees two different skills named "${row.name}" — see Merge suggestions`;
    default:
      return `${agent.displayName} doesn't read ${row.copies.map((copy) => copy.locationLabel).join(', ')}`;
  }
}

const CELL_CONTENT: Record<CellStatus, () => Child> = {
  ok: () => icon('check'),
  twice: () => '2×',
  missing: () => icon('close'),
};

function fixAction(row: CoverageRow): Child {
  if (row.fix) {
    const { location, gains, source } = row.fix;
    return button(`Copy to ${location.label}`, () => send({ type: 'copyTo', skillId: source.id, locationId: location.id }), {
      kind: 'secondary',
      title: `Adds it for ${gains.map(providerName).join(', ')} (asks for confirmation)`,
    });
  }
  if (!row.missing.length) return null;
  if (row.synced) {
    return h('span', { class: 'small muted', title: 'Copying it would create a copy that claude.ai never updates. Other agents can only use it if you copy it by hand.' }, 'claude.ai only');
  }
  return h('span', { class: 'small muted', title: 'No writable folder of this scope is read by the missing agents' }, 'no folder for it');
}

function coverageRow(row: CoverageRow, agents: ProviderSummary[]): Node {
  return h(
    'tr',
    null,
    h(
      'td',
      null,
      h('button', { class: 'linkish', type: 'button', onClick: () => selectSkill(row.copies[0].id) }, row.name),
      row.copies.length > 1 ? h('span', { class: 'small muted' }, ` ×${row.copies.length}`) : null,
    ),
    ...agents.map((agent) => {
      const status = row.cells[agent.id];
      const explanation = cellExplanation(row, agent);
      return h('td', { class: `c cell ${status} ${isHost(agent.id) ? 'host' : ''}`, title: explanation, 'aria-label': explanation }, CELL_CONTENT[status]());
    }),
    h('td', { class: 'act' }, fixAction(row)),
  );
}

function coverageTable(rows: CoverageRow[], agents: ProviderSummary[]): Node {
  const header = h(
    'tr',
    null,
    h('th', null, 'Skill'),
    ...agents.map((agent) => h('th', { class: `c ${isHost(agent.id) ? 'host' : ''}` }, swatch(agent.id), short(agent.displayName))),
    h('th', null, ''),
  );
  const syncedSectionHeader = h(
    'tr',
    { class: 'group-row' },
    h('td', { colspan: String(agents.length + 2) }, 'Synced from claude.ai', h('span', { class: 'muted' }, ' — read-only; managed by Claude Code')),
  );
  const body = rows.map((row, index) => {
    const startsSyncedSection = row.synced && !rows[index - 1]?.synced;
    return [startsSyncedSection ? syncedSectionHeader : null, coverageRow(row, agents)];
  });
  return h('table', { class: 'matrix coverage' }, h('thead', null, header), h('tbody', null, body));
}

export function mapView(): Node {
  const scope = mapScope();
  const agents = shown();
  const rows = coverage(scope);
  const head = h('div', { class: 'map-head' }, scopeSwitch(scope), coverageSummary(rows));
  if (!rows.length) return h('div', null, head, emptyTab(scope));
  return h(
    'div',
    { class: 'map' },
    head,
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Coverage'),
      h('p', { class: 'muted small' }, 'Which installed agent can use each skill. Hover a cell for the reason; the button copies the skill to the folder that closes the gap.'),
      h('div', { class: 'scroll-x' }, coverageTable(rows, agents)),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'How agents reach each skill'),
      h('p', { class: 'muted small' }, 'Agent → folder it reads → skill inside. Hover to trace a path, click a skill to open it.'),
      flowDiagram(scope),
    ),
  );
}

// ---------- flow diagram ----------

const ROW_HEIGHT = 30;
const NODE_HEIGHT = 22;
const DIAGRAM_WIDTH = 860;
const DIAGRAM_PADDING = 14;
const NODE_CORNER_RADIUS = 5;
const LABEL_LEFT = 10;
const LABEL_BASELINE_OFFSET = 4;
const COLUMNS = { agent: { x: 0, width: 150 }, folder: { x: 300, width: 230 }, skill: { x: 660, width: 200 } };
const MAX_LABEL = { agent: 20, folder: 32, skill: 26 };

/** Node ids are prefixed by column: `a:` agent, `f:` folder, `s:` skill. */
const agentNode = (id: string) => `a:${id}`;
const folderNode = (id: string) => `f:${id}`;
const skillNode = (id: string) => `s:${id}`;

interface NodeBox {
  x: number;
  y: number;
  width: number;
}

interface Link {
  from: string;
  to: string;
  className: string;
}

/**
 * Everything connected to a node, following links both ways but never across a
 * folder sideways: an agent highlights its folders and their skills, a skill its
 * folder and the agents that read it.
 */
function connectedTo(nodeId: string, links: Link[]): Set<string> {
  const connected = new Set([nodeId]);
  const linksFrom = (id: string) => links.filter((link) => link.from === id);
  const linksTo = (id: string) => links.filter((link) => link.to === id);
  if (nodeId.startsWith('a:')) {
    for (const toFolder of linksFrom(nodeId)) {
      connected.add(toFolder.to);
      for (const toSkill of linksFrom(toFolder.to)) connected.add(toSkill.to);
    }
  } else if (nodeId.startsWith('f:')) {
    for (const link of [...linksTo(nodeId), ...linksFrom(nodeId)]) {
      connected.add(link.from);
      connected.add(link.to);
    }
  } else {
    for (const fromFolder of linksTo(nodeId)) {
      connected.add(fromFolder.from);
      for (const fromAgent of linksTo(fromFolder.from)) connected.add(fromAgent.from);
    }
  }
  return connected;
}

/** Three columns (agents, folders, skills) joined by curves; pure SVG, colors from theme tokens via CSS classes. */
export function flowDiagram(scope: MapScope): Node {
  const agents = shown();
  const skills = inTab(scope)
    .slice()
    .sort((first, second) => first.locationId.localeCompare(second.locationId) || first.name.localeCompare(second.name));
  const folders = ui.state!.locations.filter((location) => skills.some((skill) => skill.locationId === location.id));
  const rowCount = Math.max(agents.length, folders.length, skills.length);
  const diagramHeight = rowCount * ROW_HEIGHT + DIAGRAM_PADDING * 2;
  // Each column is centred vertically against the tallest one.
  const yFor = (index: number, columnSize: number) => DIAGRAM_PADDING + ((rowCount - columnSize) * ROW_HEIGHT) / 2 + index * ROW_HEIGHT + (ROW_HEIGHT - NODE_HEIGHT) / 2;

  const boxes = new Map<string, NodeBox>();
  agents.forEach((agent, index) => boxes.set(agentNode(agent.id), { x: COLUMNS.agent.x, width: COLUMNS.agent.width, y: yFor(index, agents.length) }));
  folders.forEach((folder, index) => boxes.set(folderNode(folder.id), { x: COLUMNS.folder.x, width: COLUMNS.folder.width, y: yFor(index, folders.length) }));
  skills.forEach((skill, index) => boxes.set(skillNode(skill.id), { x: COLUMNS.skill.x, width: COLUMNS.skill.width, y: yFor(index, skills.length) }));

  const links: Link[] = [];
  agents.forEach((agent, position) => {
    for (const folder of folders) {
      if (folder.readers.includes(agent.id)) links.push({ from: agentNode(agent.id), to: folderNode(folder.id), className: `c-${agentColor(agent.id, position)}` });
    }
  });
  for (const skill of skills) links.push({ from: folderNode(skill.locationId), to: skillNode(skill.id), className: 'neutral' });

  // Fixed pixel size (scales down to fit, never up, so text stays at UI size).
  const root = svg('svg', {
    viewBox: `0 0 ${DIAGRAM_WIDTH} ${diagramHeight}`,
    width: DIAGRAM_WIDTH,
    height: diagramHeight,
    class: 'flow',
    role: 'img',
    'aria-label': `Diagram: ${agents.length} agents, ${folders.length} folders, ${skills.length} skills. The Coverage table above has the same information.`,
  });
  const edgeLayer = svg('g', { class: 'edges' });
  const nodeLayer = svg('g', { class: 'nodes' });
  root.append(edgeLayer, nodeLayer);

  const edgeElements = links.map((link) => {
    const start = boxes.get(link.from)!;
    const end = boxes.get(link.to)!;
    const x1 = start.x + start.width;
    const y1 = start.y + NODE_HEIGHT / 2;
    const x2 = end.x;
    const y2 = end.y + NODE_HEIGHT / 2;
    const middleX = (x1 + x2) / 2;
    const element = svg('path', { d: `M${x1},${y1} C${middleX},${y1} ${middleX},${y2} ${x2},${y2}`, class: `edge ${link.className}` });
    edgeLayer.append(element);
    return { element, link };
  });

  const nodeElements = new Map<string, SVGElement>();
  const highlight = (nodeId?: string) => {
    if (!nodeId) {
      root.classList.remove('focused');
      return;
    }
    const connected = connectedTo(nodeId, links);
    root.classList.add('focused');
    nodeElements.forEach((element, id) => element.classList.toggle('hl', connected.has(id)));
    edgeElements.forEach(({ element, link }) => element.classList.toggle('hl', connected.has(link.from) && connected.has(link.to)));
  };

  const addNode = (nodeId: string, label: string, title: string, className: string, onClick?: () => void) => {
    const box = boxes.get(nodeId)!;
    const clickable: Record<string, string | number> = onClick ? { tabindex: 0, role: 'button' } : {};
    const group = svg(
      'g',
      { class: `node ${className}`, transform: `translate(${box.x},${box.y})`, ...clickable },
      svg('title', {}, title),
      svg('rect', { width: box.width, height: NODE_HEIGHT, rx: NODE_CORNER_RADIUS }),
      svg('text', { x: LABEL_LEFT, y: NODE_HEIGHT / 2 + LABEL_BASELINE_OFFSET }, label),
    );
    group.addEventListener('mouseenter', () => highlight(nodeId));
    group.addEventListener('mouseleave', () => highlight());
    group.addEventListener('focus', () => highlight(nodeId));
    group.addEventListener('blur', () => highlight());
    if (onClick) {
      group.addEventListener('click', onClick);
      group.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') onClick();
      });
    }
    nodeElements.set(nodeId, group);
    nodeLayer.append(group);
  };

  agents.forEach((agent, position) => {
    const title = `${agent.displayName}${isHost(agent.id) ? ' (this editor)' : ''}`;
    addNode(agentNode(agent.id), clip(agent.displayName, MAX_LABEL.agent), title, `agent c-${agentColor(agent.id, position)} ${isHost(agent.id) ? 'host' : ''}`);
  });
  for (const folder of folders) {
    addNode(folderNode(folder.id), clip(folder.label, MAX_LABEL.folder), `${folder.label}\nRead by: ${folder.readers.map(providerName).join(', ')}`, `folder ${folder.readOnly ? 'ro' : ''}`);
  }
  for (const skill of skills) {
    const hasDuplicate = skill.issues.some((issue) => issue.code.startsWith('duplicate:'));
    const users = agents.filter((agent) => skill.visibleTo.includes(agent.id));
    const usage = users.length ? `Used by ${users.map((agent) => agent.displayName).join(', ')}` : 'No installed agent uses it';
    const title = `${qname(skill)}\n${usage}${hasDuplicate ? '\nSame name in another folder' : ''}`;
    addNode(skillNode(skill.id), clip(qname(skill), MAX_LABEL.skill), title, `skill ${hasDuplicate ? 'dup' : ''} ${users.length ? '' : 'orphan'}`, () => selectSkill(skill.id));
  }

  const legend = h(
    'div',
    { class: 'legend small muted' },
    agents.map((agent, position) => h('span', null, h('span', { class: `swatch c-${agentColor(agent.id, position)}` }), agent.displayName)),
    h('span', null, h('span', { class: 'swatch dupe' }), 'same name in two folders'),
    h('span', null, h('span', { class: 'swatch orphan' }), 'no installed agent uses it'),
  );
  return h('div', { class: 'flow-wrap' }, h('div', { class: 'scroll-x' }, root), legend);
}
