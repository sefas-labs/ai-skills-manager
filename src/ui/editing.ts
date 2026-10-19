import * as path from 'node:path';
import * as vscode from 'vscode';
import { mcpTargets, type McpTarget } from '../core/customizations';
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
  type TemplateScope,
  type TemplateSpec,
} from '../core/editing';
import { tildify } from '../core/paths';
import { UserError } from '../core/types';
import { log } from './log';
import type { SkillsService } from './service';

/** Config tab writes: new rule/command/subagent from a template, delete to backup, MCP add/remove/toggle. */

type Section = 'rule' | 'agent' | 'command';

const TEMPLATES_BY_SECTION: Record<Section, TemplateKind[]> = {
  rule: ['claude-rule', 'cursor-rule', 'copilot-instructions'],
  agent: ['claude-agent', 'copilot-agent'],
  command: ['claude-command', 'copilot-prompt'],
};

const SERVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const NAME_PLACEHOLDER = 'NAME';
const MOVE_TO_BACKUP = 'Move to Backup';
const ADD_SERVER = 'Add Server';
const REMOVE = 'Remove';
const CLAUDE_MCP_HINT =
  'Claude Code keeps user and local MCP servers in ~/.claude.json, which it rewrites itself. Run `claude mcp add --scope user <name> -- <command>` in a terminal.';

function isProjectFileInUntrustedWorkspace(scope: string): boolean {
  if (scope !== 'project' || vscode.workspace.isTrusted) return false;
  vscode.window.showWarningMessage('This workspace is not trusted (Restricted Mode): project files can’t be changed from here.');
  return true;
}

/** Runs one write, logs it with its backup, refreshes, and reports success or the error. */
async function runWrite(description: string, service: SkillsService, write: () => Promise<string | undefined>, successMessage: string): Promise<boolean> {
  try {
    const backup = await write();
    log().info(`${description}${backup ? ` (backup ${backup})` : ''}`);
    await service.refresh();
    vscode.window.showInformationMessage(successMessage);
    return true;
  } catch (error) {
    log().error(`${description} failed`, error as Error);
    vscode.window.showErrorMessage(error instanceof UserError ? error.message : `${description} failed: ${(error as Error).message}`);
    return false;
  }
}

function hasInstalledAgent(service: SkillsService, agentIds: string[]): boolean {
  return agentIds.some((agentId) => service.agents[agentId]?.installed);
}

/** Agents that are installed first; otherwise the original order. */
function installedFirst<T extends { agents: string[] }>(service: SkillsService, items: T[]): T[] {
  return [...items].sort((first, second) => Number(hasInstalledAgent(service, second.agents)) - Number(hasInstalledAgent(service, first.agents)));
}

function templateLocations(template: TemplateSpec): string {
  const locations = [template.project && `project: ${template.project}/`, template.user && `user: ~/${template.user}/`];
  return locations.filter(Boolean).join(' · ');
}

async function pickTemplate(service: SkillsService, section: Section): Promise<TemplateSpec | undefined> {
  const templates = TEMPLATES_BY_SECTION[section].map((kind) => TEMPLATES.find((template) => template.kind === kind)!);
  const picked = await vscode.window.showQuickPick(
    installedFirst(service, templates).map((template) => ({
      label: template.label,
      description: service.agentNames(template.agents, ''),
      detail: templateLocations(template),
      template,
    })),
    { title: `New ${section === 'agent' ? 'subagent' : section}`, placeHolder: 'Which agent is it for?' },
  );
  return picked?.template;
}

async function pickScope(template: TemplateSpec, hasWorkspace: boolean): Promise<TemplateScope | undefined> {
  const scopes: TemplateScope[] = [];
  if (template.project && hasWorkspace) scopes.push('project');
  if (template.user) scopes.push('user');
  if (!scopes.length) {
    vscode.window.showWarningMessage(`${template.label} needs an open folder.`);
    return undefined;
  }
  if (scopes.length === 1) return scopes[0];
  const picked = await vscode.window.showQuickPick(
    scopes.map((scope) => ({
      label: scope === 'project' ? 'This project' : 'All projects (user)',
      description: scope === 'project' ? `${template.project}/` : `~/${template.user}/`,
      scope,
    })),
    { title: template.label, placeHolder: 'Where?' },
  );
  return picked?.scope;
}

export async function newCustomization(service: SkillsService, section: Section): Promise<boolean> {
  const result = service.current;
  if (!result) return false;
  const home = result.context.homeDir;
  const workspace = result.context.workspaceFolders[0];
  const template = await pickTemplate(service, section);
  if (!template) return false;
  const scope = await pickScope(template, !!workspace);
  if (!scope || isProjectFileInUntrustedWorkspace(scope)) return false;

  const base = { workspace, home };
  const examplePath = tildify(templatePath(template.kind, scope, NAME_PLACEHOLDER, base), home).replace(NAME_PLACEHOLDER, '<name>');
  const name = await vscode.window.showInputBox({
    title: template.label,
    prompt: `Creates ${examplePath} from a template (never overwrites).`,
    placeHolder: 'name',
    validateInput: (value) => (NAME_RE.test(value) ? undefined : 'Letters, numbers, "-" or "_" (max 64), starting with a letter or number.'),
  });
  if (!name) return false;
  try {
    const file = await createFromTemplate(template.kind, scope, name, base);
    log().info(`created ${file}`);
    await service.refresh();
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof UserError ? error.message : `Could not create it: ${(error as Error).message}`);
    return false;
  }
}

export async function deleteCustomization(service: SkillsService, id: string): Promise<boolean> {
  const item = service.customizations[Number(id)];
  const isDeletable = !!item && item.kind !== 'mcp' && item.kind !== 'instructions' && item.scope !== 'admin';
  if (!isDeletable || isProjectFileInUntrustedWorkspace(item.scope)) return false;
  const home = service.current!.context.homeDir;
  const detail = `${tildify(item.path, home)}\n\nUsed by: ${service.agentNames(item.agents, '')}.\n\nThe file is moved to the backup folder, so you can restore it.`;
  const answer = await vscode.window.showWarningMessage(`Delete ${item.title}?`, { modal: true, detail }, MOVE_TO_BACKUP);
  if (answer !== MOVE_TO_BACKUP) return false;
  return runWrite(`delete ${item.path}`, service, () => deleteToBackup(item.path, service.backupDir), `Moved ${path.basename(item.path)} to the backup folder.`);
}

/** The exact entry that will be written, for the confirmation modal. */
function entryPreview(flavor: McpFlavor, server: NewMcpServer): string {
  if (flavor !== 'codex') return `"${server.name}": ${JSON.stringify(mcpEntry(flavor, server))}`;
  const header = `[mcp_servers.${server.name}]`;
  if (server.transport === 'http') return `${header}\nurl = ${JSON.stringify(server.url)}`;
  const argsLine = server.args?.length ? `\nargs = ${JSON.stringify(server.args)}` : '';
  return `${header}\ncommand = ${JSON.stringify(server.command)}${argsLine}`;
}

async function pickMcpTarget(service: SkillsService): Promise<McpTarget | undefined> {
  const home = service.current!.context.homeDir;
  const targets = installedFirst(service, mcpTargets(service.customizationInput()));
  const picked = await vscode.window.showQuickPick(
    [
      ...targets.map((target) => ({ label: target.label, description: tildify(target.path, home), target })),
      { label: 'Claude Code (user or local scope)', description: 'use `claude mcp add` — it owns ~/.claude.json', target: undefined },
    ],
    { title: 'Add MCP server', placeHolder: 'Which file?' },
  );
  if (picked && !picked.target) vscode.window.showInformationMessage(CLAUDE_MCP_HINT);
  return picked?.target;
}

function urlValidationMessage(name: string, url: string): string | undefined {
  try {
    validateServer({ name, transport: 'http', url });
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Asks for transport, name and command or URL. undefined when the user cancels any step. */
async function askForServer(): Promise<NewMcpServer | undefined> {
  const transport = (
    await vscode.window.showQuickPick(
      [
        { label: 'Local command (stdio)', description: 'the agent starts a program on this machine', transport: 'stdio' as const },
        { label: 'Remote URL (HTTP)', description: 'https://…', transport: 'http' as const },
      ],
      { title: 'Add MCP server', placeHolder: 'How does the agent reach it?' },
    )
  )?.transport;
  if (!transport) return undefined;
  const name = await vscode.window.showInputBox({
    title: 'Server name',
    placeHolder: 'github',
    validateInput: (value) => (SERVER_NAME.test(value) ? undefined : 'Letters, numbers, ".", "-" or "_" (max 64).'),
  });
  if (!name) return undefined;

  if (transport === 'http') {
    const url = await vscode.window.showInputBox({ title: 'URL', placeHolder: 'https://example.com/mcp', validateInput: (value) => urlValidationMessage(name, value) });
    return url ? { name, transport, url } : undefined;
  }
  const command = await vscode.window.showInputBox({ title: 'Command', placeHolder: 'npx', prompt: 'The program to run (no arguments here).' });
  if (!command) return undefined;
  const argsLine = await vscode.window.showInputBox({
    title: 'Arguments (optional)',
    placeHolder: '-y @modelcontextprotocol/server-memory',
    prompt: 'Separated by spaces; quote arguments that contain spaces. Don’t paste tokens here — use env vars.',
  });
  if (argsLine === undefined) return undefined;
  return { name, transport, command, args: splitArgs(argsLine) };
}

export async function addMcp(service: SkillsService): Promise<boolean> {
  if (!service.current) return false;
  const home = service.current.context.homeDir;
  const target = await pickMcpTarget(service);
  if (!target || isProjectFileInUntrustedWorkspace(target.scope)) return false;
  const server = await askForServer();
  if (!server) return false;
  try {
    validateServer(server);
  } catch (error) {
    vscode.window.showErrorMessage((error as Error).message);
    return false;
  }

  const agents = service.agentNames(target.agents, '');
  const whatTheAgentDoes =
    server.transport === 'stdio' ? `${agents} will run this command when it starts the server. Only add programs you trust.` : `${agents} will connect to this URL.`;
  const detail = [
    `Writes to ${tildify(target.path, home)}:`,
    '',
    entryPreview(target.flavor, server),
    '',
    whatTheAgentDoes,
    'The rest of the file is kept; a backup is kept.',
  ].join('\n');
  const answer = await vscode.window.showWarningMessage(`Add MCP server "${server.name}" to ${target.label}?`, { modal: true, detail }, ADD_SERVER);
  if (answer !== ADD_SERVER) return false;
  return runWrite(
    `mcp add "${server.name}" → ${target.path}`,
    service,
    () => addMcpServer(target.path, target.flavor, server, service.backupDir),
    `Added "${server.name}". Restart or reload the agent to pick it up.`,
  );
}

export async function removeMcp(service: SkillsService, id: string, name: string): Promise<boolean> {
  const item = service.customizations[Number(id)];
  const flavor = item?.mcpFlavor;
  const hasServer = !!item?.servers?.some((server) => server.name === name);
  if (!flavor || item.readOnlyReason || !hasServer || isProjectFileInUntrustedWorkspace(item.scope)) return false;
  const home = service.current!.context.homeDir;
  const detail = `From ${tildify(item.path, home)} (used by ${service.agentNames(item.agents, '')}).\n\nOnly this server's entry is removed; the rest of the file is kept and a backup is kept.`;
  const answer = await vscode.window.showWarningMessage(`Remove MCP server "${name}"?`, { modal: true, detail }, REMOVE);
  if (answer !== REMOVE) return false;
  return runWrite(`mcp remove "${name}" from ${item.path}`, service, () => removeMcpServer(item.path, flavor, name, service.backupDir), `Removed "${name}".`);
}

export async function toggleMcp(service: SkillsService, id: string, name: string, enabled: boolean): Promise<boolean> {
  const item = service.customizations[Number(id)];
  const isCodexServer = item?.mcpFlavor === 'codex' && !!item.servers?.some((server) => server.name === name);
  if (!isCodexServer || isProjectFileInUntrustedWorkspace(item.scope)) return false;
  const home = service.current!.context.homeDir;
  const action = enabled ? 'Enable' : 'Disable';
  const detail = `Sets enabled = ${enabled} in [mcp_servers.${name}] of ${tildify(item.path, home)}. A backup is kept.`;
  const answer = await vscode.window.showWarningMessage(`Codex: ${action.toLowerCase()} MCP server "${name}"?`, { modal: true, detail }, action);
  if (!answer) return false;
  return runWrite(
    `mcp ${action.toLowerCase()} "${name}" in ${item.path}`,
    service,
    () => setCodexMcpEnabled(item.path, name, enabled, service.backupDir),
    'Saved. Restart Codex for the change to take effect.',
  );
}
