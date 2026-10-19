import * as path from 'node:path';
import * as vscode from 'vscode';
import { mcpTargets } from '../core/customizations';
import {
  NAME_RE,
  TEMPLATES,
  addMcpServer,
  createFromTemplate,
  deleteToBackup,
  mcpEntry,
  removeMcpServer,
  setCodexMcpEnabled,
  splitArgs,
  templatePath,
  validateServer,
  type McpFlavor,
  type NewMcpServer,
  type TemplateKind,
} from '../core/editing';
import { tildify } from '../core/paths';
import { UserError } from '../core/types';
import { log } from './log';
import type { SkillsService } from './service';

/** Config tab writes: new rule/command/subagent from a template, delete to backup, MCP add/remove/toggle. */

const SECTION_KINDS: Record<'rule' | 'agent' | 'command', TemplateKind[]> = {
  rule: ['claude-rule', 'cursor-rule', 'copilot-instructions'],
  agent: ['claude-agent', 'copilot-agent'],
  command: ['claude-command', 'copilot-prompt'],
};

function agentNames(service: SkillsService, ids: string[]): string {
  return ids.map((id) => service.current?.providers.find((p) => p.id === id)?.displayName ?? id).join(', ');
}

function untrusted(scope: string): boolean {
  if (scope === 'project' && !vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('This workspace is not trusted (Restricted Mode): project files can’t be changed from here.');
    return true;
  }
  return false;
}

async function run(what: string, service: SkillsService, fn: () => Promise<string | undefined>, done: string): Promise<boolean> {
  try {
    const backup = await fn();
    log().info(`${what}${backup ? ` (backup ${backup})` : ''}`);
    await service.refresh();
    vscode.window.showInformationMessage(done);
    return true;
  } catch (e) {
    log().error(`${what} failed`, e as Error);
    vscode.window.showErrorMessage(e instanceof UserError ? e.message : `${what} failed: ${(e as Error).message}`);
    return false;
  }
}

export async function newCustomization(service: SkillsService, section: 'rule' | 'agent' | 'command'): Promise<boolean> {
  const r = service.current;
  if (!r) return false;
  const home = r.context.homeDir;
  const ws = r.context.workspaceFolders[0];
  const installed = (ids: string[]) => ids.some((id) => service.agents[id]?.installed);
  const specs = SECTION_KINDS[section].map((k) => TEMPLATES.find((t) => t.kind === k)!).sort((a, b) => Number(installed(b.agents)) - Number(installed(a.agents)));
  const spec = await vscode.window.showQuickPick(
    specs.map((t) => ({ label: t.label, description: agentNames(service, t.agents), detail: [t.project && `project: ${t.project}/`, t.user && `user: ~/${t.user}/`].filter(Boolean).join(' · '), t })),
    { title: `New ${section === 'agent' ? 'subagent' : section}`, placeHolder: 'Which agent is it for?' },
  );
  if (!spec) return false;
  const t = spec.t;
  const scopes = [...(t.project && ws ? (['project'] as const) : []), ...(t.user ? (['user'] as const) : [])];
  if (!scopes.length) {
    vscode.window.showWarningMessage(`${t.label} needs an open folder.`);
    return false;
  }
  const scope =
    scopes.length === 1
      ? scopes[0]
      : (
          await vscode.window.showQuickPick(
            scopes.map((s) => ({ label: s === 'project' ? 'This project' : 'All projects (user)', description: s === 'project' ? `${t.project}/` : `~/${t.user}/`, s })),
            { title: t.label, placeHolder: 'Where?' },
          )
        )?.s;
  if (!scope || untrusted(scope)) return false;
  const base = { workspace: ws, home };
  const name = await vscode.window.showInputBox({
    title: t.label,
    prompt: `Creates ${tildify(templatePath(t.kind, scope, 'NAME', base), home).replace('NAME', '<name>')} from a template (never overwrites).`,
    placeHolder: 'name',
    validateInput: (v) => (NAME_RE.test(v) ? undefined : 'Letters, numbers, "-" or "_" (max 64), starting with a letter or number.'),
  });
  if (!name) return false;
  try {
    const file = await createFromTemplate(t.kind, scope, name, base);
    log().info(`created ${file}`);
    await service.refresh();
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Could not create it: ${(e as Error).message}`);
    return false;
  }
}

export async function deleteCustomization(service: SkillsService, id: string): Promise<boolean> {
  const item = service.customizations[Number(id)];
  if (!item || item.kind === 'mcp' || item.kind === 'instructions' || item.scope === 'admin') return false;
  if (untrusted(item.scope)) return false;
  const home = service.current!.context.homeDir;
  const ok = await vscode.window.showWarningMessage(
    `Delete ${item.title}?`,
    { modal: true, detail: `${tildify(item.path, home)}\n\nUsed by: ${agentNames(service, item.agents)}.\n\nThe file is moved to the backup folder, so you can restore it.` },
    'Move to Backup',
  );
  if (ok !== 'Move to Backup') return false;
  return run(`delete ${item.path}`, service, () => deleteToBackup(item.path, service.backupDir), `Moved ${path.basename(item.path)} to the backup folder.`);
}

function previewEntry(flavor: McpFlavor, s: NewMcpServer): string {
  if (flavor === 'codex') {
    return [`[mcp_servers.${s.name}]`, s.transport === 'stdio' ? `command = ${JSON.stringify(s.command)}${s.args?.length ? `\nargs = ${JSON.stringify(s.args)}` : ''}` : `url = ${JSON.stringify(s.url)}`].join('\n');
  }
  return `"${s.name}": ${JSON.stringify(mcpEntry(flavor, s))}`;
}

export async function addMcp(service: SkillsService): Promise<boolean> {
  const r = service.current;
  if (!r) return false;
  const home = r.context.homeDir;
  const targets = mcpTargets(service.customizationInput());
  const installed = (ids: string[]) => ids.some((id) => service.agents[id]?.installed);
  const pick = await vscode.window.showQuickPick(
    [
      ...targets
        .sort((a, b) => Number(installed(b.agents)) - Number(installed(a.agents)))
        .map((t) => ({ label: t.label, description: tildify(t.path, home), t })),
      { label: 'Claude Code (user or local scope)', description: 'use `claude mcp add` — it owns ~/.claude.json', t: undefined },
    ],
    { title: 'Add MCP server', placeHolder: 'Which file?' },
  );
  if (!pick) return false;
  if (!pick.t) {
    vscode.window.showInformationMessage('Claude Code keeps user and local MCP servers in ~/.claude.json, which it rewrites itself. Run `claude mcp add --scope user <name> -- <command>` in a terminal.');
    return false;
  }
  const target = pick.t;
  if (untrusted(target.scope)) return false;
  const transport = (
    await vscode.window.showQuickPick(
      [
        { label: 'Local command (stdio)', description: 'the agent starts a program on this machine', v: 'stdio' as const },
        { label: 'Remote URL (HTTP)', description: 'https://…', v: 'http' as const },
      ],
      { title: 'Add MCP server', placeHolder: 'How does the agent reach it?' },
    )
  )?.v;
  if (!transport) return false;
  const name = await vscode.window.showInputBox({ title: 'Server name', placeHolder: 'github', validateInput: (v) => (/^[A-Za-z0-9_.-]{1,64}$/.test(v) ? undefined : 'Letters, numbers, ".", "-" or "_" (max 64).') });
  if (!name) return false;
  const server: NewMcpServer = { name, transport };
  if (transport === 'stdio') {
    server.command = await vscode.window.showInputBox({ title: 'Command', placeHolder: 'npx', prompt: 'The program to run (no arguments here).' });
    if (!server.command) return false;
    const args = await vscode.window.showInputBox({ title: 'Arguments (optional)', placeHolder: '-y @modelcontextprotocol/server-memory', prompt: 'Separated by spaces; quote arguments that contain spaces. Don’t paste tokens here — use env vars.' });
    if (args === undefined) return false;
    server.args = splitArgs(args);
  } else {
    server.url = await vscode.window.showInputBox({ title: 'URL', placeHolder: 'https://example.com/mcp', validateInput: (v) => { try { validateServer({ name, transport, url: v }); return undefined; } catch (e) { return (e as Error).message; } } });
    if (!server.url) return false;
  }
  try {
    validateServer(server);
  } catch (e) {
    vscode.window.showErrorMessage((e as Error).message);
    return false;
  }
  const ok = await vscode.window.showWarningMessage(
    `Add MCP server "${name}" to ${target.label}?`,
    {
      modal: true,
      detail: [
        `Writes to ${tildify(target.path, home)}:`,
        '',
        previewEntry(target.flavor, server),
        '',
        transport === 'stdio' ? `${agentNames(service, target.agents)} will run this command when it starts the server. Only add programs you trust.` : `${agentNames(service, target.agents)} will connect to this URL.`,
        'The rest of the file is kept; a backup is kept.',
      ].join('\n'),
    },
    'Add Server',
  );
  if (ok !== 'Add Server') return false;
  return run(`mcp add "${name}" → ${target.path}`, service, () => addMcpServer(target.path, target.flavor, server, service.backupDir), `Added "${name}". Restart or reload the agent to pick it up.`);
}

export async function removeMcp(service: SkillsService, id: string, name: string): Promise<boolean> {
  const item = service.customizations[Number(id)];
  if (!item?.mcpFlavor || item.readOnlyReason || !item.servers?.some((s) => s.name === name)) return false;
  if (untrusted(item.scope)) return false;
  const home = service.current!.context.homeDir;
  const ok = await vscode.window.showWarningMessage(
    `Remove MCP server "${name}"?`,
    { modal: true, detail: `From ${tildify(item.path, home)} (used by ${agentNames(service, item.agents)}).\n\nOnly this server's entry is removed; the rest of the file is kept and a backup is kept.` },
    'Remove',
  );
  if (ok !== 'Remove') return false;
  const flavor = item.mcpFlavor;
  return run(`mcp remove "${name}" from ${item.path}`, service, () => removeMcpServer(item.path, flavor, name, service.backupDir), `Removed "${name}".`);
}

export async function toggleMcp(service: SkillsService, id: string, name: string, enabled: boolean): Promise<boolean> {
  const item = service.customizations[Number(id)];
  if (item?.mcpFlavor !== 'codex' || !item.servers?.some((s) => s.name === name)) return false;
  if (untrusted(item.scope)) return false;
  const home = service.current!.context.homeDir;
  const ok = await vscode.window.showWarningMessage(
    `Codex: ${enabled ? 'enable' : 'disable'} MCP server "${name}"?`,
    { modal: true, detail: `Sets enabled = ${enabled} in [mcp_servers.${name}] of ${tildify(item.path, home)}. A backup is kept.` },
    enabled ? 'Enable' : 'Disable',
  );
  if (!ok) return false;
  return run(`mcp ${enabled ? 'enable' : 'disable'} "${name}" in ${item.path}`, service, () => setCodexMcpEnabled(item.path, name, enabled, service.backupDir), 'Saved. Restart Codex for the change to take effect.');
}
