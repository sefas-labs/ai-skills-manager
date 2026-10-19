/* Dashboard webview — Config tab: what else each agent loads (instructions,
 * rules, subagents, commands, MCP servers), with create / delete / MCP edits
 * done by the host behind native modals. Secrets never reach here. */
import type { ViewCustomization } from '../shared/protocol';
import { busy, send, ui } from './store';
import { button, chip, h, icon } from './dom';
import { agentDots, providerName, shown } from './agents';

type Kind = ViewCustomization['kind'];
type McpServer = NonNullable<ViewCustomization['servers']>[number];

interface Section {
  kind: Kind;
  title: string;
  icon: string;
  empty: string;
}

const SECTIONS: Section[] = [
  { kind: 'instructions', title: 'Instructions', icon: 'book', empty: 'No CLAUDE.md, AGENTS.md or copilot-instructions.md here.' },
  { kind: 'rule', title: 'Rules', icon: 'law', empty: 'No .claude/rules, .cursor/rules or .github/instructions files.' },
  { kind: 'agent', title: 'Subagents & custom agents', icon: 'person', empty: 'No .claude/agents or .github/agents files.' },
  { kind: 'command', title: 'Commands & prompt files', icon: 'terminal', empty: 'No .claude/commands or .github/prompts files.' },
  { kind: 'mcp', title: 'MCP servers', icon: 'plug', empty: 'No MCP server configured in the files these agents read.' },
];

/** The CSS colors scopes as workspace, global or admin; project and local files are workspace-colored. */
function scopeChip(scope: ViewCustomization['scope']): Node {
  let colorClass = 'global';
  if (scope === 'project' || scope === 'local') colorClass = 'workspace';
  else if (scope === 'admin') colorClass = 'admin';
  return chip(scope, `scope-${colorClass}`);
}

function iconButton(iconName: string, label: string, onClick: () => void): Node {
  return h('button', { class: 'btn link icon-only', type: 'button', title: label, 'aria-label': label, disabled: busy.has('edit'), onClick }, icon(iconName));
}

function openFile(item: ViewCustomization): void {
  send({ type: 'openCustomization', id: item.id });
}

function itemRow(item: ViewCustomization): Node {
  const deleteButton = item.deletable
    ? h('span', { class: 'cfg-actions' }, iconButton('trash', `Delete ${item.title} (moved to backup)`, () => send({ type: 'deleteCustomization', id: item.id })))
    : null;
  return h(
    'li',
    { class: 'cfg-item' },
    h(
      'div',
      { class: 'cfg-main' },
      h('button', { class: 'linkish cfg-title', type: 'button', title: 'Open the file', onClick: () => openFile(item) }, item.title),
      scopeChip(item.scope),
      item.note ? h('span', { class: 'small muted' }, item.note) : null,
      deleteButton,
    ),
    item.description ? h('div', { class: 'small cfg-desc' }, item.description) : null,
    h('div', { class: 'row-foot' }, h('span', { class: 'mono small muted' }, item.displayPath), agentDots(item.agents)),
  );
}

/** Env vars and headers show their names only; values never reach the webview. */
function secretNameChips(server: McpServer): Node[] {
  return [...server.envKeys.map((key) => chip(`env ${key}`, 'subtle', 'Value hidden')), ...server.headerKeys.map((key) => chip(`header ${key}`, 'subtle', 'Value hidden'))];
}

function serverActions(file: ViewCustomization, server: McpServer): Node {
  const canEdit = !!file.mcpFlavor && !file.readOnlyReason;
  const canToggle = file.mcpFlavor === 'codex';
  const toggleLabel = `${server.enabled ? 'Disable' : 'Enable'} ${server.name} in Codex`;
  return h(
    'td',
    { class: 'cfg-row-actions' },
    canToggle ? iconButton(server.enabled ? 'circle-slash' : 'pass', toggleLabel, () => send({ type: 'mcpToggle', id: file.id, name: server.name, enabled: !server.enabled })) : null,
    canEdit ? iconButton('trash', `Remove ${server.name} from this file`, () => send({ type: 'mcpRemove', id: file.id, name: server.name })) : null,
  );
}

function serverRow(file: ViewCustomization, server: McpServer): Node {
  return h(
    'tr',
    { class: server.enabled ? '' : 'dim' },
    h('td', null, h('strong', null, server.name), server.enabled ? null : chip('disabled', 'subtle')),
    h('td', null, chip(server.transport, 'subtle')),
    h('td', { class: 'mono small' }, server.command ?? server.url ?? '—'),
    h('td', { class: 'small' }, secretNameChips(server)),
    serverActions(file, server),
  );
}

function mcpCard(file: ViewCustomization): Node {
  return h(
    'div',
    { class: 'cfg-mcp' },
    h(
      'div',
      { class: 'cfg-main' },
      h('button', { class: 'linkish mono', type: 'button', title: 'Open the file', onClick: () => openFile(file) }, file.displayPath),
      scopeChip(file.scope),
      file.note ? h('span', { class: 'small muted' }, file.note) : null,
      h('span', { class: 'cfg-agents' }, agentDots(file.agents)),
    ),
    file.readOnlyReason ? h('p', { class: 'small muted' }, icon('lock'), ' ', file.readOnlyReason) : null,
    h('table', { class: 'matrix cfg-servers' }, h('tbody', null, (file.servers ?? []).map((server) => serverRow(file, server)))),
  );
}

function sectionCount(kind: Kind, items: ViewCustomization[]): number {
  if (kind !== 'mcp') return items.length;
  return items.reduce((serverCount, file) => serverCount + (file.servers?.length ?? 0), 0);
}

function sectionAction(kind: Kind): Node | null {
  if (kind === 'instructions') return null;
  const isMcp = kind === 'mcp';
  const create = () => send(isMcp ? { type: 'mcpAdd' } : { type: 'newCustomization', kind: kind as 'rule' | 'agent' | 'command' });
  return h(
    'span',
    { class: 'h2-actions' },
    button(isMcp ? 'Add server…' : 'New…', create, {
      kind: 'secondary',
      disabled: busy.has('edit'),
      title: isMcp ? 'Add an MCP server to one agent’s config file' : 'Create a file from a template and open it',
    }),
  );
}

function sectionPanel(section: Section, items: ViewCustomization[]): Node {
  const count = items.length ? h('span', { class: 'count' }, String(sectionCount(section.kind, items))) : null;
  let content: Node | Node[];
  if (!items.length) content = h('p', { class: 'muted small' }, section.empty);
  else if (section.kind === 'mcp') content = items.map(mcpCard);
  else content = h('ul', { class: 'cfg-list' }, items.map(itemRow));
  return h('section', { class: 'panel' }, h('h2', null, icon(section.icon), ` ${section.title}`, count, sectionAction(section.kind)), content);
}

function duplicateServersBanner(duplicates: Array<{ agent: string; name: string; files: string[] }>): Node | null {
  if (!duplicates.length) return null;
  return h(
    'div',
    { class: 'banner warn' },
    h('strong', null, 'Same MCP server name in more than one file: '),
    duplicates.map((duplicate, index) => [index ? ' · ' : '', `${providerName(duplicate.agent)}: ${duplicate.name} (${duplicate.files.join(', ')})`]),
    h('span', { class: 'small muted' }, ' — which one is used depends on the agent’s precedence rules.'),
  );
}

export function configView(): Node {
  const data = ui.state!.customizations ?? { items: [], mcpDuplicates: [] };
  const shownAgents = new Set(shown().map((provider) => provider.id));
  const items = data.items.filter((item) => item.agents.some((agent) => shownAgents.has(agent)));
  const duplicates = data.mcpDuplicates.filter((duplicate) => shownAgents.has(duplicate.agent));
  return h(
    'div',
    { class: 'config' },
    h(
      'p',
      { class: 'muted small' },
      icon('shield'),
      ' The other files your agents load. Every change asks first and keeps a backup. MCP environment variables and headers show names only — their values never leave the extension.',
    ),
    duplicateServersBanner(duplicates),
    SECTIONS.map((section) =>
      sectionPanel(
        section,
        items.filter((item) => item.kind === section.kind),
      ),
    ),
    h(
      'p',
      { class: 'small muted' },
      'Not shown: Cursor user rules (kept in its settings). Claude Code’s user and local MCP servers live in ~/.claude.json — change them with `claude mcp`. Files with comments (JSONC) are left for you to edit by hand.',
    ),
  );
}
