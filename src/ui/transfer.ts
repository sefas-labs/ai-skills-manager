import * as vscode from 'vscode';
import { pathKey, tildify } from '../core/paths';
import { executeTransfer, moveBlocker, planTransfer, type TransferMode } from '../core/transfer';
import { UserError } from '../core/types';
import { log } from './log';
import type { SkillsService } from './service';

/** Copy or move a skill to another skills folder, showing which agents gain and lose it before writing anything. */
/**
 * `toProject`: the "Add to project…" shortcut for global skills — only the
 * project's own skills folders, best reach (installed agents) first, copy only.
 */
export async function copyOrMoveSkill(service: SkillsService, skillId: string, opts: { toProject?: boolean; targetId?: string } = {}): Promise<boolean> {
  const s = service.skill(skillId);
  const r = service.current;
  const from = s && service.location(s.locationId);
  const action = opts.toProject ? 'add-to-project' : opts.targetId ? 'copy-to' : 'copy-move';
  if (!s || !r || !from) {
    log().warn(`${action}: skill ${skillId} not found (list changed)`);
    vscode.window.showWarningMessage('The skill list changed. Refresh the dashboard and try again.');
    return false;
  }
  log().info(`${action}: "${s.name}" from ${from.label}`);
  const stop = (why: string) => (log().info(`${action}: "${s.name}" stopped — ${why}`), false);
  const home = r.context.homeDir;
  const names = (ids: string[]) => ids.map((p) => service.providerName(p)).join(', ') || 'none';
  const installed = (id: string) => service.agents[id]?.installed !== false;
  // Agents that would start seeing the skill from this folder.
  const gainsAt = (l: { readers: string[] }) => l.readers.filter((id) => installed(id) && !s.visibleTo.includes(id));

  let targets = r.locations.filter((l) => l.id !== from.id && !l.readOnly && l.scope !== 'admin' && (l.exists || !l.origin));
  if (opts.toProject) {
    if (!r.context.workspaceFolders.length) {
      vscode.window.showInformationMessage('Open a folder (File → Open Folder…) to add skills to a project.');
      return stop('no folder open');
    }
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('This workspace is in Restricted Mode. Trust it to add skills to the project.', 'Manage Workspace Trust').then((c) => {
        if (c) vscode.commands.executeCommand('workbench.trust.manage');
      });
      return stop('workspace not trusted');
    }
    const reach = (l: (typeof targets)[number]) => l.readers.filter(installed).length;
    targets = targets
      .filter((l) => l.scope === 'workspace' && !l.origin)
      .sort((a, b) => gainsAt(b).length - gainsAt(a).length || b.readers.length - a.readers.length || reach(b) - reach(a) || Number(b.exists) - Number(a.exists));
  }
  if (targets.length === 0) {
    vscode.window.showInformationMessage(
      opts.toProject ? 'Open a folder to add skills to a project.' : 'There is no other writable skills folder (open a workspace or trust it to see project folders).',
    );
    return stop('no writable destination');
  }
  // `targetId`: the destination was already chosen (Map tab: "copy to the folder this agent reads").
  const preset = opts.targetId ? targets.find((l) => l.id === opts.targetId) : undefined;
  if (opts.targetId && !preset) {
    vscode.window.showWarningMessage('That folder is not writable any more. Refresh the dashboard.');
    return stop('preset destination not writable');
  }
  const to = preset ?? (
    await vscode.window.showQuickPick(
      targets.map((l, i) => {
        const gains = gainsAt(l);
        return {
          label: `${opts.toProject && i === 0 ? '★ ' : ''}${l.label}`,
          description: opts.toProject
            ? `team: ${names(l.readers)}${gains.length ? ` · you gain ${names(gains)}` : ''}`
            : gains.length
              ? `+ ${names(gains)}`
              : 'no new agents',
          detail: opts.toProject
            ? `Everyone who clones the repo gets it in ${names(l.readers)}.${l.exists ? '' : ' Folder will be created.'}`
            : `Loaded by: ${names(l.readers)}${gains.length ? '' : ' — already available to them'}${l.exists ? '' : ' · folder will be created'}`,
          location: l,
        };
      }),
      {
        title: opts.toProject ? `Add "${s.name}" to the project` : `Copy or move "${s.name}" to…`,
        placeHolder: opts.toProject ? 'Project skills are shared with everyone who clones the repository' : `Currently in ${from.label} (loaded by ${names(s.visibleTo)})`,
      },
    )
  )?.location;
  if (!to) return stop('destination picker closed');

  const blocked = moveBlocker(s, from);
  const modes: Array<vscode.QuickPickItem & { mode: TransferMode }> = [
    { label: 'Copy', description: 'Keep the original where it is', mode: 'copy' },
    ...(blocked ? [] : [{ label: 'Move', description: 'The original is moved to the backup folder', mode: 'move' as const }]),
  ];
  const picked =
    opts.toProject || preset || modes.length === 1
      ? modes[0]
      : await vscode.window.showQuickPick(modes, { title: `"${s.name}" → ${to.label}`, placeHolder: blocked ? `Move unavailable: ${blocked}` : undefined });
  if (!picked) return stop('mode picker closed');

  try {
    const plan = await planTransfer(s, from, to, picked.mode, r.skills);
    const exec = plan.files.filter((f) => f.executable).map((f) => f.path);
    const verb = plan.mode === 'move' ? 'Move' : 'Copy';
    const detail = [
      `From: ${tildify(s.isSymlink ? s.realDir : s.dir, home)}${s.isSymlink ? ' (link target; the copy is a real folder)' : ''}`,
      `To: ${tildify(plan.targetDir, home)}`,
      '',
      ...(opts.toProject
        ? [
            `In the repository: ${names(to.readers)} load it for everyone who clones it.`,
            `On this machine: ${plan.gained.length ? `${names(plan.gained)} start${plan.gained.length === 1 ? 's' : ''} seeing it` : 'no change — your global copy already reaches your agents'}.`,
          ]
        : [`Gains it: ${names(plan.gained)}`, `Loses it: ${names(plan.lost)}`]),
      ...(plan.duplicates.length
        ? ['', '⚠ Name clash — these agents will see two different skills named the same:', ...plan.duplicates.map((d) => `  ${service.providerName(d.provider)}: ${tildify(d.dir, home)}`)]
        : []),
      ...(to.scope === 'workspace' && (s.managed || /proprietary/i.test(String(s.frontmatter['license'] ?? '')))
        ? ['', `⚠ License: ${String(s.frontmatter['license'] ?? 'synced from claude.ai')}. Check its terms before committing it to a shared repository.`]
        : []),
      ...(plan.exists ? ['', `⚠ ${to.label} already has "${s.dirName}". It is moved to the backup folder first.`] : []),
      ...(exec.length ? ['', `${exec.length} file(s) lose their execute permission: ${exec.slice(0, 5).join(', ')}${exec.length > 5 ? '…' : ''}`] : []),
      ...(plan.skipped.length ? ['', `Not copied: ${plan.skipped.slice(0, 5).map((x) => `${x.path} (${x.reason})`).join(', ')}${plan.skipped.length > 5 ? '…' : ''}`] : []),
      '',
      `${plan.files.length} file(s).${plan.mode === 'move' ? ' The original folder is kept in the backup folder (recoverable).' : ''}`,
    ].join('\n');
    const action = opts.toProject ? (plan.exists ? 'Replace in Project' : 'Add to Project') : plan.exists ? `Replace and ${verb}` : verb;
    const title = opts.toProject ? `Add "${s.name}" to the project (${to.label})?` : `${verb} "${s.name}" to ${to.label}?`;
    const choice = await vscode.window.showInformationMessage(title, { modal: true, detail }, action);
    if (choice !== action) return stop('confirmation cancelled');

    const res = await executeTransfer(plan, plan.exists, { lock: service.lock, backupRoot: service.backupDir, stagingRoot: service.stagingDir });
    log().info(`${action}: "${s.name}" → ${res.targetDir}${res.backupDir ? ` (replaced; backup ${res.backupDir})` : ''}`);
    await service.refresh();
    const added = service.current?.skills.find((x) => pathKey(x.dir) === pathKey(res.targetDir));
    if (res.warning) vscode.window.showWarningMessage(res.warning);
    const verbDone = plan.mode === 'move' ? 'Moved' : opts.toProject ? 'Added' : 'Copied';
    vscode.window
      .showInformationMessage(`${verbDone} "${s.name}" to ${to.label}${plan.gained.length ? ` — now also available to ${names(plan.gained)}` : ''}.`, ...(added ? ['Show'] : []))
      .then((c) => {
        if (c && added) vscode.commands.executeCommand('skillsManager.showInDashboard', added.id);
      });
    return true;
  } catch (e) {
    log().error(`${action}: "${s.name}" failed`, e as Error);
    vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Could not copy "${s.name}": ${(e as Error).message}`);
    return false;
  }
}
