import * as vscode from 'vscode';
import { GitHubClient, FetchLike } from '../core/github';
import { uninstallSkill } from '../core/installer';
import { tildify } from '../core/paths';
import { UserError } from '../core/types';
import type { SkillsService } from './service';

export const GITHUB_SCOPES = { public: ['read:user'], private: ['repo'] };

/** Uses an existing GitHub sign-in silently; never prompts unless asked. The token stays in memory. */
export async function getGitHubToken(service: SkillsService, interactive?: 'public' | 'private'): Promise<string | undefined> {
  try {
    if (interactive) {
      const s = await vscode.authentication.getSession('github', GITHUB_SCOPES[interactive], { createIfNone: true });
      service.githubSignedIn = !!s;
      return s?.accessToken;
    }
    for (const scopes of [GITHUB_SCOPES.private, GITHUB_SCOPES.public]) {
      const s = await vscode.authentication.getSession('github', scopes, { silent: true });
      if (s) {
        service.githubSignedIn = true;
        return s.accessToken;
      }
    }
  } catch {
    // No GitHub auth provider (possible in some forks) or user cancelled: continue unauthenticated.
  }
  service.githubSignedIn = false;
  return undefined;
}

export async function makeGitHubClient(service: SkillsService): Promise<GitHubClient> {
  const token = await getGitHubToken(service);
  return new GitHubClient({ fetch: globalThis.fetch as unknown as FetchLike, token });
}

export async function openSkillFile(service: SkillsService, skillId: string): Promise<void> {
  const s = service.skill(skillId);
  if (!s) return;
  await vscode.window.showTextDocument(vscode.Uri.file(s.skillFile), { preview: true });
}

export async function revealSkill(service: SkillsService, skillId: string): Promise<void> {
  const s = service.skill(skillId);
  if (!s) return;
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.skillFile));
}

export async function copySkillPath(service: SkillsService, skillId: string): Promise<void> {
  const s = service.skill(skillId);
  if (!s) return;
  await vscode.env.clipboard.writeText(s.dir);
  vscode.window.setStatusBarMessage(`Copied ${s.dir}`, 2500);
}

export async function confirmAndUninstall(service: SkillsService, skillId: string): Promise<boolean> {
  const s = service.skill(skillId);
  if (!s) return false;
  const loc = service.location(s.locationId);
  if (!loc) return false;
  if (s.readOnly || loc.readOnly) {
    vscode.window.showWarningMessage(`"${s.name}" can't be removed here: ${s.readOnlyReason ?? loc.readOnlyReason ?? 'read-only location'}`);
    return false;
  }
  const home = service.current?.context.homeDir ?? '';
  const who = s.visibleTo.map((p) => service.providerName(p)).join(', ') || 'no agent';
  const detail = s.isSymlink
    ? `This is a symbolic link. Only the link in ${loc.label} is removed; its target (${tildify(s.realDir, home)}) is not touched.\n\nIt will stop being available to: ${who}.`
    : `The folder ${tildify(s.dir, home)} will be moved to the extension's backup folder (recoverable).\n\nIt will stop being available to: ${who}.`;
  const choice = await vscode.window.showWarningMessage(`Remove skill "${s.name}" from ${loc.label}?`, { modal: true, detail }, 'Remove');
  if (choice !== 'Remove') return false;
  try {
    const r = await uninstallSkill(s, loc, { lock: service.lock, trashRoot: service.backupDir });
    await service.refresh();
    if (r.kind === 'moved' && r.backupDir) {
      const backup = r.backupDir;
      vscode.window.showInformationMessage(`Removed "${s.name}". A backup was kept.`, 'Show Backup').then((c) => {
        if (c) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(backup));
      });
    } else {
      vscode.window.showInformationMessage(`Removed link "${s.name}".`);
    }
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Could not remove "${s.name}": ${(e as Error).message}`);
    return false;
  }
}
