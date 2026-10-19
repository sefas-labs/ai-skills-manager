import * as vscode from 'vscode';
import { planChoose, removeOthers, syncToChosen, type ChoosePlan, type OtherCopy } from '../core/choose';
import { tildify } from '../core/paths';
import { SkillRecord, UserError } from '../core/types';
import { log } from './log';
import type { SkillsService } from './service';

type ChooseAction = 'sync' | 'remove';
type ChoiceItem = vscode.QuickPickItem & { action: ChooseAction };

/** "Use this one": make the chosen copy the version every agent gets, by syncing or removing the other copies. */
export async function chooseCopy(service: SkillsService, skillId: string): Promise<boolean> {
  const result = service.current;
  const chosen = service.skill(skillId);
  if (!result || !chosen) {
    vscode.window.showWarningMessage('The skill list changed. Refresh the dashboard and try again.');
    return false;
  }
  const plan = planChoose(chosen, result.skills, result.locations);
  if (plan.others.length === 0) {
    vscode.window.showInformationMessage(`"${chosen.name}" has no other copies.`);
    return false;
  }

  const home = result.context.homeDir;
  const where = (dir: string) => tildify(dir, home);
  const describeBlocked = (copies: OtherCopy[]) => copies.map((copy) => `${where(copy.skill.dir)} (${copy.blocked})`).join('; ');
  const toSync = plan.others.filter((copy) => !copy.identical && !copy.blocked);
  const removable = plan.others.filter((copy) => copy.writable);
  const blocked = plan.others.filter((copy) => !copy.identical && copy.blocked);

  const items: ChoiceItem[] = [];
  if (toSync.length) {
    items.push({
      action: 'sync',
      label: '$(sync) Make the other copies identical to this one',
      description: 'Recommended — no agent loses it',
      detail: `Overwrites ${toSync.map((copy) => where(copy.skill.dir)).join(', ')} (backup kept). Then it no longer matters which copy an agent picks.`,
    });
  }
  if (removable.length) {
    items.push({
      action: 'remove',
      label: '$(trash) Remove the other copies',
      description: plan.loseIfRemoved.length ? `${service.agentNames(plan.loseIfRemoved)} would lose it` : 'every agent keeps it',
      detail: `Moves ${removable.map((copy) => where(copy.skill.dir)).join(', ')} to the backup folder.`,
    });
  }
  if (!items.length) {
    vscode.window.showInformationMessage(
      blocked.length ? `The other copies can't be changed here: ${describeBlocked(blocked)}.` : `Every copy of "${chosen.name}" already has the same content.`,
    );
    return false;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: `Use ${where(chosen.dir)} for "${chosen.name}"`,
    placeHolder: 'Agents that read several folders pick a copy on their own; choose how to make this one win',
  });
  if (!picked) return false;

  const affected = picked.action === 'sync' ? toSync : removable;
  const detail = confirmationDetail(service, chosen, plan, picked.action, affected, blocked, where, describeBlocked);
  const confirmAction = picked.action === 'sync' ? 'Replace' : 'Remove';
  const answer = await vscode.window.showWarningMessage(`Use this copy of "${chosen.name}"?`, { modal: true, detail }, confirmAction);
  if (answer !== confirmAction) return false;

  try {
    const deps = { lock: service.lock, backupRoot: service.backupDir, stagingRoot: service.stagingDir, skills: result.skills };
    const changedDirs = picked.action === 'sync' ? await syncToChosen(plan, deps) : await removeOthers(plan, deps);
    log().info(`choose-copy: "${chosen.name}" ${picked.action} → ${changedDirs.join(', ')}`);
    await service.refresh();
    const copies = changedDirs.length === 1 ? 'copy' : 'copies';
    const message =
      picked.action === 'sync' ? `All copies of "${chosen.name}" now match ${where(chosen.dir)}.` : `Removed ${changedDirs.length} other ${copies} of "${chosen.name}".`;
    vscode.window.showInformationMessage(message, 'Show Backups').then((choice) => {
      if (choice) vscode.commands.executeCommand('skillsManager.openBackups');
    });
    return true;
  } catch (error) {
    log().error(`choose-copy: "${chosen.name}" failed`, error as Error);
    vscode.window.showErrorMessage(error instanceof UserError ? error.message : `Could not update the copies of "${chosen.name}": ${(error as Error).message}`);
    await service.refresh();
    return false;
  }
}

function confirmationDetail(
  service: SkillsService,
  chosen: SkillRecord,
  plan: ChoosePlan,
  action: ChooseAction,
  affected: OtherCopy[],
  blocked: OtherCopy[],
  where: (dir: string) => string,
  describeBlocked: (copies: OtherCopy[]) => string,
): string {
  const names = (ids: string[]) => service.agentNames(ids);
  const affectedScopes = new Set(affected.map((copy) => copy.skill.scope));
  let outcome: string;
  if (action === 'sync') outcome = 'Every agent keeps the skill and gets this exact content.';
  else if (plan.loseIfRemoved.length) outcome = `⚠ ${names(plan.loseIfRemoved)} will no longer see "${chosen.name}".`;
  else outcome = 'Every agent keeps the skill through the remaining copies.';
  return [
    `Keep: ${where(chosen.dir)} — ${names(chosen.visibleTo)}`,
    action === 'sync' ? 'Replace with this version:' : 'Remove (moved to the backup folder):',
    ...affected.map((copy) => `  ${where(copy.skill.dir)} — ${names(copy.skill.visibleTo)}`),
    '',
    outcome,
    ...(affectedScopes.has('global') ? ['', 'A global copy changes for all your projects.'] : []),
    ...(affectedScopes.has('workspace') ? ['', 'A project copy changes for everyone who uses this repository.'] : []),
    ...(blocked.length ? ['', `Left as is: ${describeBlocked(blocked)}`] : []),
  ].join('\n');
}
