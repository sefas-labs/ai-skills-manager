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
    const r = service.current;
    if (!r) return;
    const withProblems = r.skills.filter((s) => s.issues.some((i) => i.severity !== 'info')).length;
    view.badge = withProblems ? { value: withProblems, tooltip: `${withProblems} skill(s) with problems` } : undefined;
  };

  const cmd = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('skillsManager.openDashboard', () => DashboardPanel.show(context, service, { type: 'focus', tab: 'overview' }));
  cmd('skillsManager.refresh', () => service.refresh());
  cmd('skillsManager.installFromGitHub', async (url?: unknown) => {
    let input = typeof url === 'string' ? url : undefined;
    if (!input) {
      input = await vscode.window.showInputBox({
        title: 'Install skills from GitHub',
        prompt: 'Repository or folder URL. Nothing is installed until you review and confirm.',
        placeHolder: 'https://github.com/owner/repo  or  https://github.com/owner/repo/tree/main/skills/name',
        ignoreFocusOut: true,
        validateInput: (v) => {
          if (!v.trim()) return undefined;
          try {
            parseGitHubUrl(v);
            return undefined;
          } catch (e) {
            return (e as Error).message;
          }
        },
      });
    }
    if (!input) {
      DashboardPanel.show(context, service, { type: 'focus', tab: 'install' });
      return;
    }
    DashboardPanel.show(context, service, { type: 'focus', tab: 'install', url: input, autoInspect: true });
  });
  cmd('skillsManager.showInDashboard', (arg) => {
    const id = skillIdFrom(arg);
    DashboardPanel.show(context, service, { type: 'focus', tab: 'skills', skillId: id });
  });
  cmd('skillsManager.openSkillFile', (arg) => {
    const id = skillIdFrom(arg);
    if (id) return openSkillFile(service, id);
  });
  cmd('skillsManager.revealSkill', (arg) => {
    const id = skillIdFrom(arg);
    if (id) return revealSkill(service, id);
  });
  cmd('skillsManager.copySkillPath', (arg) => {
    const id = skillIdFrom(arg);
    if (id) return copySkillPath(service, id);
  });
  cmd('skillsManager.uninstall', (arg) => {
    const id = skillIdFrom(arg);
    if (id) return confirmAndUninstall(service, id);
  });
  cmd('skillsManager.copyMoveSkill', (arg) => {
    const id = skillIdFrom(arg);
    if (id) return copyOrMoveSkill(service, id);
  });
  cmd('skillsManager.fixSkill', (arg) => {
    const id = skillIdFrom(arg);
    if (id) return fixSkill(service, id);
  });
  cmd('skillsManager.chooseCopy', (arg) => {
    const id = skillIdFrom(arg);
    if (id) return chooseCopy(service, id);
  });
  cmd('skillsManager.addToProject', (arg) => {
    const id = skillIdFrom(arg);
    if (id) return copyOrMoveSkill(service, id, { toProject: true });
  });
  cmd('skillsManager.checkUpdates', () => checkForUpdates(service, true));
  cmd('skillsManager.updateSkill', (arg) => {
    const id = skillIdFrom(arg);
    if (id) return confirmAndUpdate(service, id);
  });
  cmd('skillsManager.signInGitHub', async () => {
    const token = await getGitHubToken(service, 'public');
    if (token) vscode.window.showInformationMessage('Signed in to GitHub. Higher API limits are now used for installs.');
  });
  cmd('skillsManager.openBackups', async () => {
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
    .catch((e) => console.error('[skills-manager] initial scan failed', e));
  return { service, tree, dashboardReady: () => DashboardPanel.current?.isReady ?? false, dashboardError: () => DashboardPanel.current?.lastClientError };
}

export function deactivate(): void {
  /* disposables are cleaned up via context.subscriptions */
}
