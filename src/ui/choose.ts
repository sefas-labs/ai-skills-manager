import * as vscode from 'vscode';
import { planChoose, removeOthers, syncToChosen } from '../core/choose';
import { tildify } from '../core/paths';
import { UserError } from '../core/types';
import { log } from './log';
import type { SkillsService } from './service';

/** "Use this one": make the chosen copy the version every agent gets, by syncing or removing the other copies. */
export async function chooseCopy(service: SkillsService, skillId: string): Promise<boolean> {
  const r = service.current;
  const s = service.skill(skillId);
  if (!r || !s) {
    vscode.window.showWarningMessage('The skill list changed. Refresh the dashboard and try again.');
    return false;
  }
  const plan = planChoose(s, r.skills, r.locations);
  if (plan.others.length === 0) {
    vscode.window.showInformationMessage(`"${s.name}" has no other copies.`);
    return false;
  }
  const home = r.context.homeDir;
  const names = (ids: string[]) => ids.map((p) => service.providerName(p)).join(', ') || 'none';
  const where = (dir: string) => tildify(dir, home);
  const toSync = plan.others.filter((o) => !o.identical && !o.blocked);
  const removable = plan.others.filter((o) => o.writable);
  const blocked = plan.others.filter((o) => !o.identical && o.blocked);

  type Choice = vscode.QuickPickItem & { action: 'sync' | 'remove' };
  const items: Choice[] = [];
  if (toSync.length) {
    items.push({
      action: 'sync',
      label: '$(sync) Make the other copies identical to this one',
      description: 'Recommended — no agent loses it',
      detail: `Overwrites ${toSync.map((o) => where(o.skill.dir)).join(', ')} (backup kept). Then it no longer matters which copy an agent picks.`,
    });
  }
  if (removable.length) {
    items.push({
      action: 'remove',
      label: '$(trash) Remove the other copies',
      description: plan.loseIfRemoved.length ? `${names(plan.loseIfRemoved)} would lose it` : 'every agent keeps it',
      detail: `Moves ${removable.map((o) => where(o.skill.dir)).join(', ')} to the backup folder.`,
    });
  }
  if (!items.length) {
    vscode.window.showInformationMessage(
      blocked.length
        ? `The other copies can't be changed here: ${blocked.map((o) => `${where(o.skill.dir)} (${o.blocked})`).join('; ')}.`
        : `Every copy of "${s.name}" already has the same content.`,
    );
    return false;
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: `Use ${where(s.dir)} for "${s.name}"`,
    placeHolder: 'Agents that read several folders pick a copy on their own; choose how to make this one win',
  });
  if (!pick) return false;

  const affected = pick.action === 'sync' ? toSync : removable;
  const scopes = new Set(affected.map((o) => o.skill.scope));
  const detail = [
    `Keep: ${where(s.dir)} — ${names(s.visibleTo)}`,
    pick.action === 'sync' ? 'Replace with this version:' : 'Remove (moved to the backup folder):',
    ...affected.map((o) => `  ${where(o.skill.dir)} — ${names(o.skill.visibleTo)}`),
    '',
    pick.action === 'sync'
      ? 'Every agent keeps the skill and gets this exact content.'
      : plan.loseIfRemoved.length
        ? `⚠ ${names(plan.loseIfRemoved)} will no longer see "${s.name}".`
        : 'Every agent keeps the skill through the remaining copies.',
    ...(scopes.has('global') ? ['', 'A global copy changes for all your projects.'] : []),
    ...(scopes.has('workspace') ? ['', 'A project copy changes for everyone who uses this repository.'] : []),
    ...(blocked.length ? ['', `Left as is: ${blocked.map((o) => `${where(o.skill.dir)} (${o.blocked})`).join('; ')}`] : []),
  ].join('\n');
  const action = pick.action === 'sync' ? 'Replace' : 'Remove';
  const ok = await vscode.window.showWarningMessage(`Use this copy of "${s.name}"?`, { modal: true, detail }, action);
  if (ok !== action) return false;

  try {
    const deps = { lock: service.lock, backupRoot: service.backupDir, stagingRoot: service.stagingDir, skills: r.skills };
    const done = pick.action === 'sync' ? await syncToChosen(plan, deps) : await removeOthers(plan, deps);
    log().info(`choose-copy: "${s.name}" ${pick.action} → ${done.join(', ')}`);
    await service.refresh();
    vscode.window.showInformationMessage(
      pick.action === 'sync' ? `All copies of "${s.name}" now match ${where(s.dir)}.` : `Removed ${done.length} other cop${done.length === 1 ? 'y' : 'ies'} of "${s.name}".`,
      'Show Backups',
    ).then((c) => {
      if (c) vscode.commands.executeCommand('skillsManager.openBackups');
    });
    return true;
  } catch (e) {
    log().error(`choose-copy: "${s.name}" failed`, e as Error);
    vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Could not update the copies of "${s.name}": ${(e as Error).message}`);
    await service.refresh();
    return false;
  }
}
