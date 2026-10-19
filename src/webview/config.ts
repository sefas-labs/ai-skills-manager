/* Dashboard webview — Config tab: what else each agent loads (instructions,
 * rules, subagents, commands, MCP servers), with create / delete / MCP edits
 * done by the host behind native modals. Secrets never reach here. */
import type { ViewCustomization } from '../shared/protocol';
import { busy, send, ui } from './store';
import { button, chip, h, icon } from './dom';
import { agentDots, providerName, shown } from './agents';

const SECTIONS: Array<{ kind: ViewCustomization['kind']; title: string; icon: string; empty: string }> = [
  { kind: 'instructions', title: 'Instructions', icon: 'book', empty: 'No CLAUDE.md, AGENTS.md or copilot-instructions.md here.' },
  { kind: 'rule', title: 'Rules', icon: 'law', empty: 'No .claude/rules, .cursor/rules or .github/instructions files.' },
  { kind: 'agent', title: 'Subagents & custom agents', icon: 'person', empty: 'No .claude/agents or .github/agents files.' },
  { kind: 'command', title: 'Commands & prompt files', icon: 'terminal', empty: 'No .claude/commands or .github/prompts files.' },
  { kind: 'mcp', title: 'MCP servers', icon: 'plug', empty: 'No MCP server configured in the files these agents read.' },
];

const iconBtn = (name: string, title: string, onClick: () => void) =>
  h('button', { class: 'btn link icon-only', type: 'button', title, 'aria-label': title, disabled: busy.has('edit'), onClick }, icon(name));

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
      c.deletable ? h('span', { class: 'cfg-actions' }, iconBtn('trash', `Delete ${c.title} (moved to backup)`, () => send({ type: 'deleteCustomization', id: c.id }))) : null,
    ),
    c.description ? h('div', { class: 'small cfg-desc' }, c.description) : null,
    h('div', { class: 'row-foot' }, h('span', { class: 'mono small muted' }, c.displayPath), agentDots(c.agents)),
  );
}

function mcpCard(c: ViewCustomization): Node {
  const editable = !!c.mcpFlavor && !c.readOnlyReason;
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
    c.readOnlyReason ? h('p', { class: 'small muted' }, icon('lock'), ' ', c.readOnlyReason) : null,
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
          h(
            'td',
            { class: 'cfg-row-actions' },
            c.mcpFlavor === 'codex'
              ? iconBtn(s.enabled ? 'circle-slash' : 'pass', `${s.enabled ? 'Disable' : 'Enable'} ${s.name} in Codex`, () => send({ type: 'mcpToggle', id: c.id, name: s.name, enabled: !s.enabled }))
              : null,
            editable ? iconBtn('trash', `Remove ${s.name} from this file`, () => send({ type: 'mcpRemove', id: c.id, name: s.name })) : null,
          ),
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
    h('p', { class: 'muted small' }, icon('shield'), ' The other files your agents load. Every change asks first and keeps a backup. MCP environment variables and headers show names only — their values never leave the extension.'),
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
        h(
          'h2',
          null,
          icon(sec.icon),
          ` ${sec.title}`,
          list.length ? h('span', { class: 'count' }, String(sec.kind === 'mcp' ? list.reduce((n, c) => n + (c.servers?.length ?? 0), 0) : list.length)) : null,
          sec.kind === 'instructions'
            ? null
            : h(
                'span',
                { class: 'h2-actions' },
                button(sec.kind === 'mcp' ? 'Add server…' : 'New…', () => send(sec.kind === 'mcp' ? { type: 'mcpAdd' } : { type: 'newCustomization', kind: sec.kind as 'rule' | 'agent' | 'command' }), {
                  kind: 'secondary',
                  disabled: busy.has('edit'),
                  title: sec.kind === 'mcp' ? 'Add an MCP server to one agent’s config file' : 'Create a file from a template and open it',
                }),
              ),
        ),
        list.length
          ? sec.kind === 'mcp'
            ? list.map(mcpCard)
            : h('ul', { class: 'cfg-list' }, list.map(itemRow))
          : h('p', { class: 'muted small' }, sec.empty),
      );
    }),
    h('p', { class: 'small muted' }, 'Not shown: Cursor user rules (kept in its settings). Claude Code’s user and local MCP servers live in ~/.claude.json — change them with `claude mcp`. Files with comments (JSONC) are left for you to edit by hand.'),
  );
}
