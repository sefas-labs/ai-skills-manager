import * as vscode from 'vscode';
import * as path from 'node:path';
import { uninstallSkill } from '../core/installer';
import type { MergeCopy, MergeSuggestion } from '../core/merge';
import { tildify } from '../core/paths';
import { executeTransfer, planTransfer, type TransferPlan } from '../core/transfer';
import { UserError } from '../core/types';
import { diffFiles, localFileShas } from '../core/updates';
import type { SkillsService } from './service';

type MergeAction = 'apply' | 'compare' | 'unify';

const COMPARE_FIRST = 'Compare First';
const REPLACE = 'Replace';

function listChanged(): UserError {
  return new UserError('The skill list changed. Refresh and try again.');
}

function modifiedNote(modifiedAt: string | undefined, prefix: string): string {
  return modifiedAt ? ` (${prefix} ${new Date(modifiedAt).toLocaleString()})` : '';
}

export async function handleMerge(service: SkillsService, suggestionId: string, action: MergeAction, skillId?: string): Promise<void> {
  const suggestion = service.merges.find((candidate) => candidate.id === suggestionId);
  if (!suggestion) {
    vscode.window.showInformationMessage('This suggestion is out of date. Refresh the list.');
    return;
  }
  try {
    if (action === 'compare') await compareCopies(service, suggestion);
    else if (action === 'apply') await removeRedundantCopies(service, suggestion);
    else if (skillId) await unifyVersions(service, suggestion, skillId);
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof UserError ? error.message : `Merge failed: ${(error as Error).message}`);
    await service.refresh();
  }
}

function realDirOf(service: SkillsService, copy: MergeCopy): string {
  const skill = service.skill(copy.skillId);
  if (!skill) throw listChanged();
  return skill.realDir;
}

/** Diff two copies file by file in the editor. */
async function compareCopies(service: SkillsService, suggestion: MergeSuggestion): Promise<void> {
  const home = service.current?.context.homeDir ?? '';
  const [first, defaultSecond] = suggestion.copies;
  let second = defaultSecond;
  if (suggestion.copies.length > 2) {
    const picked = await vscode.window.showQuickPick(
      suggestion.copies.slice(1).map((copy) => ({ label: copy.locationLabel, description: `compare with ${first.locationLabel}`, copy })),
      { title: `Compare copies of "${suggestion.name}"` },
    );
    if (!picked) return;
    second = picked.copy;
  }
  const firstDir = realDirOf(service, first);
  const secondDir = realDirOf(service, second);
  const diff = diffFiles(await localFileShas(firstDir), await localFileShas(secondDir));
  const files = [
    ...diff.modified.map((file) => ({ label: file, description: 'different' })),
    ...diff.added.map((file) => ({ label: file, description: `only in ${second.locationLabel}` })),
    ...diff.removed.map((file) => ({ label: file, description: `only in ${first.locationLabel}` })),
  ];
  if (files.length === 0) {
    vscode.window.showInformationMessage(`Both copies of "${suggestion.name}" are identical.`);
    return;
  }
  const picked = files.length === 1 ? files[0] : await vscode.window.showQuickPick(files, { title: `${tildify(firstDir, home)} ↔ ${tildify(secondDir, home)}` });
  if (!picked) return;
  const emptyDocument = vscode.Uri.parse('untitled:' + picked.label);
  const left = diff.added.includes(picked.label) ? emptyDocument : vscode.Uri.file(path.join(firstDir, picked.label));
  const right = diff.removed.includes(picked.label) ? emptyDocument : vscode.Uri.file(path.join(secondDir, picked.label));
  const title = `${suggestion.name}/${picked.label}: ${first.locationLabel} ↔ ${second.locationLabel}`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

/** Remove the redundant copies (to the backup folder). Agents keep seeing the skill through the copies that stay. */
async function removeRedundantCopies(service: SkillsService, suggestion: MergeSuggestion): Promise<void> {
  if (!suggestion.remove.length) return;
  const kept = suggestion.copies.filter((copy) => suggestion.keep.includes(copy.skillId));
  const removed = suggestion.copies.filter((copy) => suggestion.remove.includes(copy.skillId));
  const keptVersions = new Set(kept.map((copy) => copy.version));
  const removedWithOtherContent = removed.filter((copy) => !keptVersions.has(copy.version));
  const copyLine = (copy: MergeCopy) => `  ${copy.locationLabel} — ${service.agentNames(copy.readers)}`;
  const stillTwiceLine = suggestion.stillTwiceBy.length
    ? `Still seen twice by: ${service.agentNames(suggestion.stillTwiceBy)} (no single folder reaches every agent).`
    : 'No agent sees it twice any more.';
  const differentContentWarning = removedWithOtherContent.length
    ? ['', `⚠ ${removedWithOtherContent.map((copy) => copy.locationLabel).join(', ')} has different content. It will only remain in the backup — compare first if unsure.`]
    : [];
  const detail = [
    'Keep:',
    ...kept.map(copyLine),
    'Remove (moved to the backup folder):',
    ...removed.map(copyLine),
    '',
    `Every installed agent that sees "${suggestion.name}" today still sees it.`,
    stillTwiceLine,
    ...differentContentWarning,
  ].join('\n');

  const action = removed.length > 1 ? `Remove ${removed.length} Copies` : 'Remove Copy';
  const choice = await vscode.window.showWarningMessage(`Merge duplicates of "${suggestion.name}"?`, { modal: true, detail }, action, COMPARE_FIRST);
  if (choice === COMPARE_FIRST) return compareCopies(service, suggestion);
  if (choice !== action) return;
  for (const copy of removed) {
    const skill = service.skill(copy.skillId);
    const location = skill && service.location(skill.locationId);
    if (!skill || !location) throw listChanged();
    await uninstallSkill(skill, location, { lock: service.lock, trashRoot: service.backupDir });
  }
  await service.refresh();
  const copies = removed.length === 1 ? 'copy' : 'copies';
  vscode.window.showInformationMessage(`Merged "${suggestion.name}": removed ${removed.length} redundant ${copies}.`, 'Show Backups').then((answer) => {
    if (answer) vscode.commands.executeCommand('skillsManager.openBackups');
  });
}

/** Copy one version over every other writable copy, so all agents get the same skill. */
async function unifyVersions(service: SkillsService, suggestion: MergeSuggestion, chosenSkillId: string): Promise<void> {
  const chosenSkill = service.skill(chosenSkillId);
  const chosenLocation = chosenSkill && service.location(chosenSkill.locationId);
  if (!service.current || !chosenSkill || !chosenLocation) throw listChanged();
  const chosenCopy = suggestion.copies.find((copy) => copy.skillId === chosenSkillId)!;
  const differentCopies = suggestion.copies.filter((copy) => copy.skillId !== chosenSkillId && copy.version !== chosenCopy.version);
  const toReplace = differentCopies.filter((copy) => copy.writable);
  const readOnlyLeftAlone = differentCopies.filter((copy) => !copy.writable);
  if (!toReplace.length) {
    vscode.window.showInformationMessage(readOnlyLeftAlone.length ? 'The other copies are read-only; nothing can be overwritten.' : 'All copies already have this version.');
    return;
  }

  const plans: TransferPlan[] = [];
  for (const copy of toReplace) {
    const skill = service.skill(copy.skillId);
    const location = skill && service.location(skill.locationId);
    if (!skill || !location) throw listChanged();
    if (skill.dirName !== chosenSkill.dirName || skill.isSymlink) {
      throw new UserError(`${copy.locationLabel}/${skill.dirName} can't be overwritten automatically (different folder name or a link). Edit it by hand.`);
    }
    plans.push(await planTransfer(chosenSkill, chosenLocation, location, 'copy', service.current.skills));
  }

  const readOnlyNote = readOnlyLeftAlone.length ? ['', `Read-only, left as is: ${readOnlyLeftAlone.map((copy) => copy.locationLabel).join(', ')}`] : [];
  const detail = [
    `Use the version in ${chosenCopy.locationLabel}${modifiedNote(chosenCopy.modifiedAt, 'SKILL.md modified')}`,
    'and replace:',
    ...toReplace.map((copy) => `  ${copy.locationLabel}${modifiedNote(copy.modifiedAt, 'modified')}`),
    ...readOnlyNote,
    '',
    'The replaced copies are moved to the backup folder first.',
  ].join('\n');
  const choice = await vscode.window.showWarningMessage(`Use one version of "${suggestion.name}" everywhere?`, { modal: true, detail }, REPLACE, COMPARE_FIRST);
  if (choice === COMPARE_FIRST) return compareCopies(service, suggestion);
  if (choice !== REPLACE) return;
  for (const plan of plans) await executeTransfer(plan, true, { lock: service.lock, backupRoot: service.backupDir, stagingRoot: service.stagingDir });
  await service.refresh();
  vscode.window.showInformationMessage(`All writable copies of "${suggestion.name}" now match ${chosenCopy.locationLabel}.`);
}
