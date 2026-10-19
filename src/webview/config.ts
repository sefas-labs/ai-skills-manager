/* Dashboard webview — Config tab: what else each agent loads (instructions,
 * rules, subagents, commands, MCP servers). Read-only; secrets never reach here. */
import type { ViewCustomization } from '../shared/protocol';
import { send, ui } from './store';
import { chip, h, icon } from './dom';
import { agentDots, providerName, shown } from './agents';

const SECTIONS: Array<{ kind: ViewCustomization['kind']; title: string; icon: string; empty: string }> = [
  { kind: 'instructions', title: 'Instructions', icon: 'book', empty: 'No CLAUDE.md, AGENTS.md or copilot-instructions.md here.' },
  { kind: 'rule', title: 'Rules', icon: 'law', empty: 'No .claude/rules, .cursor/rules or .github/instructions files.' },
  { kind: 'agent', title: 'Subagents', icon: 'person', empty: 'No .claude/agents files.' },
  { kind: 'command', title: 'Commands', icon: 'terminal', empty: 'No .claude/commands files.' },
  { kind: 'mcp', title: 'MCP servers', icon: 'plug', empty: 'No MCP server configured in the files these agents read.' },
];

function itemRow(c: ViewCustomization): Node {
  return h(
    'li',
    { class: 'cfg-item' },
    h(
      'div',
      { class: 'cfg-main' },
      h('button', { class: 'linkish cfg-title', type: 'button', title: 'Open the file', onClick: () => send({ type: 'openCustomization', id: c.id }) }, c.title),
      chip(c.scope, `scope-${c.scope === 'project' || c.scope === 'local' ? 'workspace' : c.scope === 'admin' ? 'admin' : 'global'}`),
      c.note ? h('span', { class: 'small muted' }, c.note) : null,
    ),
    c.description ? h('div', { class: 'small cfg-desc' }, c.description) : null,
    h('div', { class: 'row-foot' }, h('span', { class: 'mono small muted' }, c.displayPath), agentDots(c.agents)),
  );
}

function mcpCard(c: ViewCustomization): Node {
  return h(
    'div',
    { class: 'cfg-mcp' },
    h(
      'div',
      { class: 'cfg-main' },
      h('button', { class: 'linkish mono', type: 'button', title: 'Open the file', onClick: () => send({ type: 'openCustomization', id: c.id }) }, c.displayPath),
      chip(c.scope, `scope-${c.scope === 'project' || c.scope === 'local' ? 'workspace' : 'global'}`),
      c.note ? h('span', { class: 'small muted' }, c.note) : null,
      h('span', { class: 'cfg-agents' }, agentDots(c.agents)),
    ),
    h(
      'table',
      { class: 'matrix cfg-servers' },
      h('tbody', null, (c.servers ?? []).map((s) =>
        h(
          'tr',
          { class: s.enabled ? '' : 'dim' },
          h('td', null, h('strong', null, s.name), s.enabled ? null : chip('disabled', 'subtle')),
          h('td', null, chip(s.transport, 'subtle')),
          h('td', { class: 'mono small' }, s.command ?? s.url ?? '—'),
          h('td', { class: 'small' }, [...s.envKeys.map((k) => chip(`env ${k}`, 'subtle', 'Value hidden')), ...s.headerKeys.map((k) => chip(`header ${k}`, 'subtle', 'Value hidden'))]),
        ),
      )),
    ),
  );
}

export function configView(): Node {
  const data = ui.state!.customizations ?? { items: [], mcpDuplicates: [] };
  const visible = new Set(shown().map((p) => p.id));
  const items = data.items.filter((c) => c.agents.some((a) => visible.has(a)));
  const dups = data.mcpDuplicates.filter((d) => visible.has(d.agent));
  return h(
    'div',
    { class: 'config' },
    h('p', { class: 'muted small' }, icon('shield'), ' Read-only view of the other files your agents load. MCP environment variables and headers show names only — their values never leave the extension.'),
    dups.length
      ? h(
          'div',
          { class: 'banner warn' },
          h('strong', null, 'Same MCP server name in more than one file: '),
          dups.map((d, i) => [i ? ' · ' : '', `${providerName(d.agent)}: ${d.name} (${d.files.join(', ')})`]),
          h('span', { class: 'small muted' }, ' — which one is used depends on the agent’s precedence rules.'),
        )
      : null,
    SECTIONS.map((sec) => {
      const list = items.filter((c) => c.kind === sec.kind);
      return h(
        'section',
        { class: 'panel' },
        h('h2', null, icon(sec.icon), ` ${sec.title}`, list.length ? h('span', { class: 'count' }, String(sec.kind === 'mcp' ? list.reduce((n, c) => n + (c.servers?.length ?? 0), 0) : list.length)) : null),
        list.length
          ? sec.kind === 'mcp'
            ? list.map(mcpCard)
            : h('ul', { class: 'cfg-list' }, list.map(itemRow))
          : h('p', { class: 'muted small' }, sec.empty),
      );
    }),
    h('p', { class: 'small muted' }, 'Not shown yet: Cursor user rules (kept in its settings), prompt files and custom agents for Copilot, and nested CLAUDE.md / AGENTS.md below the workspace folder.'),
  );
}
