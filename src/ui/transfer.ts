import * as vscode from 'vscode';
import { pathKey, tildify } from '../core/paths';
import { executeTransfer, moveBlocker, planTransfer, type TransferMode, type TransferPlan } from '../core/transfer';
import { ResolvedLocation, SkillRecord, UserError } from '../core/types';
import { log } from './log';
import type { SkillsService } from './service';

export interface TransferOptions {
  /** The "Add to project…" shortcut for global skills: only the project's own skills folders, best reach first, copy only. */
  toProject?: boolean;
  /** The destination was already chosen (Map tab: "copy to the folder this agent reads"). */
  targetId?: string;
}

type ModeChoice = vscode.QuickPickItem & { mode: TransferMode };

const MAX_LISTED_FILES = 5;
const RECOMMENDED_MARK = '★ ';
const PROPRIETARY_LICENSE = /proprietary/i;

function listSome(items: string[]): string {
  const more = items.length > MAX_LISTED_FILES ? '…' : '';
  return items.slice(0, MAX_LISTED_FILES).join(', ') + more;
}

class TransferDialog {
  private readonly home: string;
  private readonly action: string;

  constructor(
    private readonly service: SkillsService,
    private readonly skill: SkillRecord,
    private readonly from: ResolvedLocation,
    private readonly options: TransferOptions,
  ) {
    this.home = service.current!.context.homeDir;
    this.action = options.toProject ? 'add-to-project' : options.targetId ? 'copy-to' : 'copy-move';
  }

  private names(ids: string[]): string {
    return this.service.agentNames(ids);
  }

  private isInstalled(agentId: string): boolean {
    return this.service.agents[agentId]?.installed !== false;
  }

  /** Installed agents that would start seeing the skill from this folder. */
  private agentsGainedAt(location: ResolvedLocation): string[] {
    return location.readers.filter((agentId) => this.isInstalled(agentId) && !this.skill.visibleTo.includes(agentId));
  }

  private stop(reason: string): false {
    log().info(`${this.action}: "${this.skill.name}" stopped — ${reason}`);
    return false;
  }

  private writableDestinations(): ResolvedLocation[] {
    const locations = this.service.current!.locations;
    return locations.filter((location) => {
      const isOtherFolder = location.id !== this.from.id;
      const isPlainOrExisting = location.exists || !location.origin;
      return isOtherFolder && !location.readOnly && location.scope !== 'admin' && isPlainOrExisting;
    });
  }

  /** Project folders, best first: most agents gained, then most readers, then most installed readers, then existing ones. */
  private projectDestinations(destinations: ResolvedLocation[]): ResolvedLocation[] {
    const installedReaders = (location: ResolvedLocation) => location.readers.filter((agentId) => this.isInstalled(agentId)).length;
    return destinations
      .filter((location) => location.scope === 'workspace' && !location.origin)
      .sort(
        (first, second) =>
          this.agentsGainedAt(second).length - this.agentsGainedAt(first).length ||
          second.readers.length - first.readers.length ||
          installedReaders(second) - installedReaders(first) ||
          Number(second.exists) - Number(first.exists),
      );
  }

  /** Checks that the project can receive skills; shows why not and returns false otherwise. */
  private canAddToProject(): boolean {
    if (!this.service.current!.context.workspaceFolders.length) {
      vscode.window.showInformationMessage('Open a folder (File → Open Folder…) to add skills to a project.');
      return this.stop('no folder open');
    }
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('This workspace is in Restricted Mode. Trust it to add skills to the project.', 'Manage Workspace Trust').then((choice) => {
        if (choice) vscode.commands.executeCommand('workbench.trust.manage');
      });
      return this.stop('workspace not trusted');
    }
    return true;
  }

  private destinationItem(location: ResolvedLocation, index: number) {
    const gained = this.agentsGainedAt(location);
    const createdNote = location.exists ? '' : ' Folder will be created.';
    if (this.options.toProject) {
      const youGain = gained.length ? ` · you gain ${this.names(gained)}` : '';
      return {
        label: `${index === 0 ? RECOMMENDED_MARK : ''}${location.label}`,
        description: `team: ${this.names(location.readers)}${youGain}`,
        detail: `Everyone who clones the repo gets it in ${this.names(location.readers)}.${createdNote}`,
        location,
      };
    }
    const alreadyAvailable = gained.length ? '' : ' — already available to them';
    const willBeCreated = location.exists ? '' : ' · folder will be created';
    return {
      label: location.label,
      description: gained.length ? `+ ${this.names(gained)}` : 'no new agents',
      detail: `Loaded by: ${this.names(location.readers)}${alreadyAvailable}${willBeCreated}`,
      location,
    };
  }

  private async pickDestination(destinations: ResolvedLocation[]): Promise<ResolvedLocation | undefined> {
    const { skill, options } = this;
    const picked = await vscode.window.showQuickPick(
      destinations.map((location, index) => this.destinationItem(location, index)),
      {
        title: options.toProject ? `Add "${skill.name}" to the project` : `Copy or move "${skill.name}" to…`,
        placeHolder: options.toProject
          ? 'Project skills are shared with everyone who clones the repository'
          : `Currently in ${this.from.label} (loaded by ${this.names(skill.visibleTo)})`,
      },
    );
    return picked?.location;
  }

  private async pickMode(to: ResolvedLocation, destinationWasPreset: boolean): Promise<ModeChoice | undefined> {
    const moveUnavailableBecause = moveBlocker(this.skill, this.from);
    const modes: ModeChoice[] = [{ label: 'Copy', description: 'Keep the original where it is', mode: 'copy' }];
    if (!moveUnavailableBecause) modes.push({ label: 'Move', description: 'The original is moved to the backup folder', mode: 'move' });
    const onlyCopyMakesSense = this.options.toProject || destinationWasPreset || modes.length === 1;
    if (onlyCopyMakesSense) return modes[0];
    return vscode.window.showQuickPick(modes, {
      title: `"${this.skill.name}" → ${to.label}`,
      placeHolder: moveUnavailableBecause ? `Move unavailable: ${moveUnavailableBecause}` : undefined,
    });
  }

  private agentChangeLines(plan: TransferPlan, to: ResolvedLocation): string[] {
    if (!this.options.toProject) return [`Gains it: ${this.names(plan.gained)}`, `Loses it: ${this.names(plan.lost)}`];
    const gainedCount = plan.gained.length;
    const onThisMachine = gainedCount
      ? `${this.names(plan.gained)} start${gainedCount === 1 ? 's' : ''} seeing it`
      : 'no change — your global copy already reaches your agents';
    return [`In the repository: ${this.names(to.readers)} load it for everyone who clones it.`, `On this machine: ${onThisMachine}.`];
  }

  private warningLines(plan: TransferPlan, to: ResolvedLocation): string[] {
    const { skill, home } = this;
    const lines: string[] = [];
    if (plan.duplicates.length) {
      lines.push('', '⚠ Name clash — these agents will see two different skills named the same:');
      for (const duplicate of plan.duplicates) lines.push(`  ${this.service.providerName(duplicate.provider)}: ${tildify(duplicate.dir, home)}`);
    }
    const license = String(skill.frontmatter['license'] ?? '');
    const hasRestrictiveTerms = !!skill.managed || PROPRIETARY_LICENSE.test(license);
    if (to.scope === 'workspace' && hasRestrictiveTerms) {
      lines.push('', `⚠ License: ${license || 'synced from claude.ai'}. Check its terms before committing it to a shared repository.`);
    }
    if (plan.exists) lines.push('', `⚠ ${to.label} already has "${skill.dirName}". It is moved to the backup folder first.`);
    const executableFiles = plan.files.filter((file) => file.executable).map((file) => file.path);
    if (executableFiles.length) lines.push('', `${executableFiles.length} file(s) lose their execute permission: ${listSome(executableFiles)}`);
    if (plan.skipped.length) lines.push('', `Not copied: ${listSome(plan.skipped.map((skipped) => `${skipped.path} (${skipped.reason})`))}`);
    return lines;
  }

  private confirmationDetail(plan: TransferPlan, to: ResolvedLocation): string {
    const { skill, home } = this;
    const sourceNote = skill.isSymlink ? ' (link target; the copy is a real folder)' : '';
    const moveNote = plan.mode === 'move' ? ' The original folder is kept in the backup folder (recoverable).' : '';
    return [
      `From: ${tildify(skill.isSymlink ? skill.realDir : skill.dir, home)}${sourceNote}`,
      `To: ${tildify(plan.targetDir, home)}`,
      '',
      ...this.agentChangeLines(plan, to),
      ...this.warningLines(plan, to),
      '',
      `${plan.files.length} file(s).${moveNote}`,
    ].join('\n');
  }

  private confirmLabels(plan: TransferPlan, to: ResolvedLocation): { title: string; action: string } {
    const { skill } = this;
    if (this.options.toProject) {
      return { title: `Add "${skill.name}" to the project (${to.label})?`, action: plan.exists ? 'Replace in Project' : 'Add to Project' };
    }
    const verb = plan.mode === 'move' ? 'Move' : 'Copy';
    return { title: `${verb} "${skill.name}" to ${to.label}?`, action: plan.exists ? `Replace and ${verb}` : verb };
  }

  async run(): Promise<boolean> {
    const { service, skill, options } = this;
    log().info(`${this.action}: "${skill.name}" from ${this.from.label}`);

    let destinations = this.writableDestinations();
    if (options.toProject) {
      if (!this.canAddToProject()) return false;
      destinations = this.projectDestinations(destinations);
    }
    if (destinations.length === 0) {
      vscode.window.showInformationMessage(
        options.toProject ? 'Open a folder to add skills to a project.' : 'There is no other writable skills folder (open a workspace or trust it to see project folders).',
      );
      return this.stop('no writable destination');
    }
    const presetDestination = options.targetId ? destinations.find((location) => location.id === options.targetId) : undefined;
    if (options.targetId && !presetDestination) {
      vscode.window.showWarningMessage('That folder is not writable any more. Refresh the dashboard.');
      return this.stop('preset destination not writable');
    }
    const to = presetDestination ?? (await this.pickDestination(destinations));
    if (!to) return this.stop('destination picker closed');
    const mode = await this.pickMode(to, !!presetDestination);
    if (!mode) return this.stop('mode picker closed');

    try {
      const plan = await planTransfer(skill, this.from, to, mode.mode, service.current!.skills);
      const { title, action } = this.confirmLabels(plan, to);
      const choice = await vscode.window.showInformationMessage(title, { modal: true, detail: this.confirmationDetail(plan, to) }, action);
      if (choice !== action) return this.stop('confirmation cancelled');

      const result = await executeTransfer(plan, plan.exists, { lock: service.lock, backupRoot: service.backupDir, stagingRoot: service.stagingDir });
      const replacedNote = result.backupDir ? ` (replaced; backup ${result.backupDir})` : '';
      log().info(`${action}: "${skill.name}" → ${result.targetDir}${replacedNote}`);
      await service.refresh();
      if (result.warning) vscode.window.showWarningMessage(result.warning);
      this.announceDone(plan, to, result.targetDir);
      return true;
    } catch (error) {
      log().error(`${this.action}: "${skill.name}" failed`, error as Error);
      vscode.window.showErrorMessage(error instanceof UserError ? error.message : `Could not copy "${skill.name}": ${(error as Error).message}`);
      return false;
    }
  }

  private announceDone(plan: TransferPlan, to: ResolvedLocation, targetDir: string): void {
    const added = this.service.current?.skills.find((candidate) => pathKey(candidate.dir) === pathKey(targetDir));
    const verbDone = plan.mode === 'move' ? 'Moved' : this.options.toProject ? 'Added' : 'Copied';
    const gainedNote = plan.gained.length ? ` — now also available to ${this.names(plan.gained)}` : '';
    const actions = added ? ['Show'] : [];
    vscode.window.showInformationMessage(`${verbDone} "${this.skill.name}" to ${to.label}${gainedNote}.`, ...actions).then((choice) => {
      if (choice && added) vscode.commands.executeCommand('skillsManager.showInDashboard', added.id);
    });
  }
}

/** Copy or move a skill to another skills folder, showing which agents gain and lose it before writing anything. */
export async function copyOrMoveSkill(service: SkillsService, skillId: string, options: TransferOptions = {}): Promise<boolean> {
  const skill = service.skill(skillId);
  const from = skill && service.location(skill.locationId);
  if (!skill || !service.current || !from) {
    const action = options.toProject ? 'add-to-project' : options.targetId ? 'copy-to' : 'copy-move';
    log().warn(`${action}: skill ${skillId} not found (list changed)`);
    vscode.window.showWarningMessage('The skill list changed. Refresh the dashboard and try again.');
    return false;
  }
  return new TransferDialog(service, skill, from, options).run();
}
