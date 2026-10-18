import * as vscode from 'vscode';
import { tildify } from '../core/paths';
import { executeTransfer, moveBlocker, planTransfer, type TransferMode } from '../core/transfer';
import { UserError } from '../core/types';
import type { SkillsService } from './service';

/** Copy or move a skill to another skills folder, showing which agents gain and lose it before writing anything. */
export async function copyOrMoveSkill(service: SkillsService, skillId: string): Promise<boolean> {
  const s = service.skill(skillId);
  const r = service.current;
  if (!s || !r) return false;
  const from = service.location(s.locationId);
  if (!from) return false;
  const home = r.context.homeDir;
  const names = (ids: string[]) => ids.map((p) => service.providerName(p)).join(', ') || 'none';

  const targets = r.locations.filter((l) => l.id !== from.id && !l.readOnly && l.scope !== 'admin' && (l.exists || !l.origin));
  if (targets.length === 0) {
    vscode.window.showInformationMessage('There is no other writable skills folder (open a workspace or trust it to see project folders).');
    return false;
  }
  const to = (
    await vscode.window.showQuickPick(
      targets.map((l) => ({
        label: l.label,
        description: `Loaded by: ${names(l.readers)}`,
        detail: `${l.scope}${l.exists ? '' : ' · will be created'}`,
        location: l,
      })),
      { title: `Copy or move "${s.name}" to…`, placeHolder: `Currently in ${from.label} (loaded by ${names(s.visibleTo)})` },
    )
  )?.location;
  if (!to) return false;

  const blocked = moveBlocker(s, from);
  const modes: Array<vscode.QuickPickItem & { mode: TransferMode }> = [
    { label: 'Copy', description: 'Keep the original where it is', mode: 'copy' },
    ...(blocked ? [] : [{ label: 'Move', description: 'The original is moved to the backup folder', mode: 'move' as const }]),
  ];
  const picked =
    modes.length === 1
      ? modes[0]
      : await vscode.window.showQuickPick(modes, { title: `"${s.name}" → ${to.label}`, placeHolder: blocked ? `Move unavailable: ${blocked}` : undefined });
  if (!picked) return false;

  try {
    const plan = await planTransfer(s, from, to, picked.mode, r.skills);
    const exec = plan.files.filter((f) => f.executable).map((f) => f.path);
    const verb = plan.mode === 'move' ? 'Move' : 'Copy';
    const detail = [
      `From: ${tildify(s.isSymlink ? s.realDir : s.dir, home)}${s.isSymlink ? ' (link target; the copy is a real folder)' : ''}`,
      `To: ${tildify(plan.targetDir, home)}`,
      '',
      `Gains it: ${names(plan.gained)}`,
      `Loses it: ${names(plan.lost)}`,
      ...(plan.duplicates.length
        ? ['', '⚠ Name clash — these agents will see two different skills named the same:', ...plan.duplicates.map((d) => `  ${service.providerName(d.provider)}: ${tildify(d.dir, home)}`)]
        : []),
      ...(plan.exists ? ['', `⚠ ${to.label} already has "${s.dirName}". It is moved to the backup folder first.`] : []),
      ...(exec.length ? ['', `${exec.length} file(s) lose their execute permission: ${exec.slice(0, 5).join(', ')}${exec.length > 5 ? '…' : ''}`] : []),
      ...(plan.skipped.length ? ['', `Not copied: ${plan.skipped.slice(0, 5).map((x) => `${x.path} (${x.reason})`).join(', ')}${plan.skipped.length > 5 ? '…' : ''}`] : []),
      '',
      `${plan.files.length} file(s).${plan.mode === 'move' ? ' The original folder is kept in the backup folder (recoverable).' : ''}`,
    ].join('\n');
    const action = plan.exists ? `Replace and ${verb}` : verb;
    const choice = await vscode.window.showInformationMessage(`${verb} "${s.name}" to ${to.label}?`, { modal: true, detail }, action);
    if (choice !== action) return false;

    const res = await executeTransfer(plan, plan.exists, { lock: service.lock, backupRoot: service.backupDir, stagingRoot: service.stagingDir });
    await service.refresh();
    if (res.warning) vscode.window.showWarningMessage(res.warning);
    else vscode.window.showInformationMessage(`${plan.mode === 'move' ? 'Moved' : 'Copied'} "${s.name}" to ${to.label}.`);
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Could not copy "${s.name}": ${(e as Error).message}`);
    return false;
  }
}
