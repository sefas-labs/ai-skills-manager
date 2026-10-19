import * as vscode from 'vscode';
import { applyFix, cleanDescription, fixesFor, type FixId, type FixOption } from '../core/fixes';
import { tildify } from '../core/paths';
import { SkillRecord, UserError } from '../core/types';
import type { SkillsService } from './service';

/** Fixes that rename or remove things instead of editing SKILL.md. */
const FIXES_THAT_DO_NOT_EDIT_SKILL_MD: FixId[] = ['rename-folder-to-name', 'remove-broken-link', 'rename-skill-file'];
/** Renaming the folder changes the skill's path, so it runs after every other fix. */
const RUNS_LAST: FixId = 'rename-folder-to-name';

/** Pick one fix per problem: the first option wins when there are alternatives (e.g. set name vs. rename folder). */
function oneFixPerProblem(options: FixOption[]): FixOption[] {
  const coveredCodes = new Set<string>();
  const selected: FixOption[] = [];
  for (const fix of options) {
    if (fix.codes.some((code) => coveredCodes.has(code))) continue;
    fix.codes.forEach((code) => coveredCodes.add(code));
    selected.push(fix);
  }
  return selected.sort((first, second) => Number(first.id === RUNS_LAST) - Number(second.id === RUNS_LAST));
}

function validationMessage(value: string): string | undefined {
  try {
    cleanDescription(value);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

async function askForDescription(skillName: string): Promise<string | undefined> {
  const typed = await vscode.window.showInputBox({
    title: `Description for "${skillName}"`,
    prompt: 'What the skill does and when the agent should use it. Agents read this to decide when to load the skill.',
    placeHolder: 'e.g. Generates release notes from merged PRs. Use when the user asks for a changelog.',
    ignoreFocusOut: true,
    validateInput: validationMessage,
  });
  return typed === undefined ? undefined : cleanDescription(typed);
}

function sideEffectNotes(service: SkillsService, skill: SkillRecord, fixes: FixOption[]): string[] {
  const editsSkillMd = fixes.some((fix) => !FIXES_THAT_DO_NOT_EDIT_SKILL_MD.includes(fix.id));
  if (!editsSkillMd) return [];
  const notes: string[] = [];
  const home = service.current?.context.homeDir ?? '';
  if (skill.isSymlink) notes.push(`This skill is a link: the change is made in its target (${tildify(skill.realDir, home)}), shared by every place that links to it.`);
  if (service.tracked(skill)) notes.push('It came from GitHub: the edit counts as a local change, and an update will ask before replacing it.');
  return notes;
}

/** Fix one problem (fixId) or every fixable one, after showing the exact change in a modal. */
export async function fixSkill(service: SkillsService, skillId: string, fixId?: FixId): Promise<boolean> {
  const skill = service.skill(skillId);
  const location = skill && service.location(skill.locationId);
  if (!skill || !location) return false;
  const available = fixesFor(skill, location);
  const chosen = fixId ? available.filter((fix) => fix.id === fixId) : oneFixPerProblem(available);
  if (chosen.length === 0) {
    vscode.window.showInformationMessage(`Nothing to fix automatically in "${skill.name}". Open SKILL.md to edit it by hand.`);
    return false;
  }

  let description: string | undefined;
  if (chosen.some((fix) => fix.needsDescription)) {
    description = await askForDescription(skill.name);
    if (description === undefined) return false;
  }

  const notes = sideEffectNotes(service, skill, chosen);
  const detail = [
    ...chosen.map((fix) => `• ${fix.detail}`),
    ...(description ? ['', `Description: ${description}`] : []),
    ...(notes.length ? ['', ...notes] : []),
    '',
    'A backup of the original is kept in the backup folder.',
  ].join('\n');
  const action = chosen.length > 1 ? `Apply ${chosen.length} Fixes` : 'Apply Fix';
  const answer = await vscode.window.showInformationMessage(`Fix "${skill.name}"?`, { modal: true, detail }, action);
  if (answer !== action) return false;

  const summaries: string[] = [];
  try {
    for (const fix of chosen) {
      const result = await applyFix(skill, location, fix.id, { lock: service.lock, backupRoot: service.backupDir, description });
      summaries.push(result.summary);
    }
  } catch (error) {
    const alreadyDone = summaries.length ? summaries.join(' ') + ' Then: ' : '';
    vscode.window.showErrorMessage(`${alreadyDone}${error instanceof UserError ? error.message : (error as Error).message}`);
    await service.refresh();
    return false;
  }
  await service.refresh();
  vscode.window.showInformationMessage(summaries.join(' '), 'Show Backups').then((choice) => {
    if (choice) vscode.commands.executeCommand('skillsManager.openBackups');
  });
  return true;
}
