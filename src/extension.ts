import * as vscode from 'vscode';
import { parseGitHubUrl } from './core/github';
import { confirmAndUninstall, copySkillPath, getGitHubToken, openSkillFile, revealSkill } from './ui/actions';
import { DashboardPanel } from './ui/dashboard';
import { SkillsService } from './ui/service';
import { skillIdFrom, SkillsTreeProvider } from './ui/tree';
import { chooseCopy } from './ui/choose';
import { fixSkill } from './ui/fixes';
import { copyOrMoveSkill } from './ui/transfer';
import { checkForUpdates, confirmAndUpdate } from './ui/updates';

/** Returned from activate() for the end-to-end tests only; not a public API. */
export interface InternalApi {
  service: SkillsService;
  tree: SkillsTreeProvider;
  dashboardReady(): boolean;
  dashboardError(): string | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<InternalApi> {
  const service = new SkillsService(context);
  const tree = new SkillsTreeProvider(service);
  const view = vscode.window.createTreeView('skillsManager.tree', { treeDataProvider: tree, showCollapseAll: true });

  const updateBadge = () => {
    const result = service.current;
    if (!result) return;
    const withProblems = result.skills.filter((skill) => skill.issues.some((issue) => issue.severity !== 'info')).length;
    view.badge = withProblems ? { value: withProblems, tooltip: `${withProblems} skill(s) with problems` } : undefined;
  };

  const command = (id: string, handler: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  /** A command that acts on one skill, given as a tree node or a skill id. */
  const skillCommand = (id: string, action: (skillId: string) => unknown) =>
    command(id, (argument) => {
      const skillId = skillIdFrom(argument);
      if (skillId) return action(skillId);
    });

  command('skillsManager.openDashboard', () => DashboardPanel.show(context, service, { type: 'focus', tab: 'overview' }));
  command('skillsManager.refresh', () => service.refresh());
  command('skillsManager.installFromGitHub', async (url?: unknown) => {
    const input = typeof url === 'string' ? url : await askForGitHubUrl();
    if (!input) {
      DashboardPanel.show(context, service, { type: 'focus', tab: 'install' });
      return;
    }
    DashboardPanel.show(context, service, { type: 'focus', tab: 'install', url: input, autoInspect: true });
  });
  command('skillsManager.showInDashboard', (argument) => {
    DashboardPanel.show(context, service, { type: 'focus', tab: 'skills', skillId: skillIdFrom(argument) });
  });
  skillCommand('skillsManager.openSkillFile', (skillId) => openSkillFile(service, skillId));
  skillCommand('skillsManager.revealSkill', (skillId) => revealSkill(service, skillId));
  skillCommand('skillsManager.copySkillPath', (skillId) => copySkillPath(service, skillId));
  skillCommand('skillsManager.uninstall', (skillId) => confirmAndUninstall(service, skillId));
  skillCommand('skillsManager.copyMoveSkill', (skillId) => copyOrMoveSkill(service, skillId));
  skillCommand('skillsManager.fixSkill', (skillId) => fixSkill(service, skillId));
  skillCommand('skillsManager.chooseCopy', (skillId) => chooseCopy(service, skillId));
  skillCommand('skillsManager.addToProject', (skillId) => copyOrMoveSkill(service, skillId, { toProject: true }));
  skillCommand('skillsManager.updateSkill', (skillId) => confirmAndUpdate(service, skillId));
  command('skillsManager.checkUpdates', () => checkForUpdates(service, true));
  command('skillsManager.signInGitHub', async () => {
    const token = await getGitHubToken(service, 'public');
    if (token) vscode.window.showInformationMessage('Signed in to GitHub. Higher API limits are now used for installs.');
  });
  command('skillsManager.openBackups', async () => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(service.backupDir));
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(service.backupDir));
  });

  context.subscriptions.push(service, view, service.onDidChange(updateBadge));
  // Don't block activation on disk I/O.
  void service
    .refresh()
    .then(() => {
      if (vscode.workspace.getConfiguration('skillsManager').get<boolean>('checkForUpdatesOnStartup')) return checkForUpdates(service, false);
    })
    .catch((error) => console.error('[skills-manager] initial scan failed', error));
  return { service, tree, dashboardReady: () => DashboardPanel.current?.isReady ?? false, dashboardError: () => DashboardPanel.current?.lastClientError };
}

function urlValidationMessage(value: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    parseGitHubUrl(value);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

function askForGitHubUrl(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Install skills from GitHub',
    prompt: 'Repository or folder URL. Nothing is installed until you review and confirm.',
    placeHolder: 'https://github.com/owner/repo  or  https://github.com/owner/repo/tree/main/skills/name',
    ignoreFocusOut: true,
    validateInput: urlValidationMessage,
  });
}

export function deactivate(): void {
  /* disposables are cleaned up via context.subscriptions */
}
