import * as vscode from 'vscode';
import { GitHubClient, FetchLike } from '../core/github';
import { uninstallSkill } from '../core/installer';
import { tildify } from '../core/paths';
import { UserError } from '../core/types';
import type { SkillsService } from './service';

export const GITHUB_SCOPES = { public: ['read:user'], private: ['repo'] };

const STATUS_MESSAGE_MS = 2500;

/** Uses an existing GitHub sign-in silently; never prompts unless asked. The token stays in memory. */
export async function getGitHubToken(service: SkillsService, interactive?: 'public' | 'private'): Promise<string | undefined> {
  try {
    if (interactive) {
      const session = await vscode.authentication.getSession('github', GITHUB_SCOPES[interactive], { createIfNone: true });
      service.githubSignedIn = !!session;
      return session?.accessToken;
    }
    for (const scopes of [GITHUB_SCOPES.private, GITHUB_SCOPES.public]) {
      const session = await vscode.authentication.getSession('github', scopes, { silent: true });
      if (session) {
        service.githubSignedIn = true;
        return session.accessToken;
      }
    }
  } catch {
    // No GitHub auth provider (possible in some forks) or the user cancelled: continue unauthenticated.
  }
  service.githubSignedIn = false;
  return undefined;
}

export async function makeGitHubClient(service: SkillsService): Promise<GitHubClient> {
  const token = await getGitHubToken(service);
  return new GitHubClient({ fetch: globalThis.fetch as unknown as FetchLike, token });
}

export async function openSkillFile(service: SkillsService, skillId: string): Promise<void> {
  const skill = service.skill(skillId);
  if (skill) await vscode.window.showTextDocument(vscode.Uri.file(skill.skillFile), { preview: true });
}

export async function revealSkill(service: SkillsService, skillId: string): Promise<void> {
  const skill = service.skill(skillId);
  if (skill) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(skill.skillFile));
}

export async function copySkillPath(service: SkillsService, skillId: string): Promise<void> {
  const skill = service.skill(skillId);
  if (!skill) return;
  await vscode.env.clipboard.writeText(skill.dir);
  vscode.window.setStatusBarMessage(`Copied ${skill.dir}`, STATUS_MESSAGE_MS);
}

export async function confirmAndUninstall(service: SkillsService, skillId: string): Promise<boolean> {
  const skill = service.skill(skillId);
  const location = skill && service.location(skill.locationId);
  if (!skill || !location) return false;
  if (skill.readOnly || location.readOnly) {
    const reason = skill.readOnlyReason ?? location.readOnlyReason ?? 'read-only location';
    vscode.window.showWarningMessage(`"${skill.name}" can't be removed here: ${reason}`);
    return false;
  }
  const home = service.current?.context.homeDir ?? '';
  const losingAgents = service.agentNames(skill.visibleTo, 'no agent');
  const whatHappens = skill.isSymlink
    ? `This is a symbolic link. Only the link in ${location.label} is removed; its target (${tildify(skill.realDir, home)}) is not touched.`
    : `The folder ${tildify(skill.dir, home)} will be moved to the extension's backup folder (recoverable).`;
  const detail = `${whatHappens}\n\nIt will stop being available to: ${losingAgents}.`;
  const choice = await vscode.window.showWarningMessage(`Remove skill "${skill.name}" from ${location.label}?`, { modal: true, detail }, 'Remove');
  if (choice !== 'Remove') return false;
  try {
    const result = await uninstallSkill(skill, location, { lock: service.lock, trashRoot: service.backupDir });
    await service.refresh();
    const backupDir = result.backupDir;
    if (result.kind === 'moved' && backupDir) {
      vscode.window.showInformationMessage(`Removed "${skill.name}". A backup was kept.`, 'Show Backup').then((answer) => {
        if (answer) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(backupDir));
      });
    } else {
      vscode.window.showInformationMessage(`Removed link "${skill.name}".`);
    }
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof UserError ? error.message : `Could not remove "${skill.name}": ${(error as Error).message}`);
    return false;
  }
}
