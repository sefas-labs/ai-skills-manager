import * as vscode from 'vscode';
import { applyFix, cleanDescription, fixesFor, type FixId, type FixOption } from '../core/fixes';
import { tildify } from '../core/paths';
import { UserError } from '../core/types';
import type { SkillsService } from './service';

/** Pick one fix per problem: the first option wins when there are alternatives (e.g. set name vs. rename folder). */
function fixAllSet(options: FixOption[]): FixOption[] {
  const covered = new Set<string>();
  const out: FixOption[] = [];
  for (const f of options) {
    if (f.codes.some((c) => covered.has(c))) continue;
    f.codes.forEach((c) => covered.add(c));
    out.push(f);
  }
  // Folder renames change the path, so they go last.
  return out.sort((a, b) => Number(a.id === 'rename-folder-to-name') - Number(b.id === 'rename-folder-to-name'));
}

/** Fix one problem (fixId) or every fixable one, after showing the exact change in a modal. */
export async function fixSkill(service: SkillsService, skillId: string, fixId?: FixId): Promise<boolean> {
  const s = service.skill(skillId);
  const loc = s && service.location(s.locationId);
  if (!s || !loc) return false;
  const options = fixesFor(s, loc);
  const chosen = fixId ? options.filter((f) => f.id === fixId) : fixAllSet(options);
  if (chosen.length === 0) {
    vscode.window.showInformationMessage(`Nothing to fix automatically in "${s.name}". Open SKILL.md to edit it by hand.`);
    return false;
  }

  let description: string | undefined;
  if (chosen.some((f) => f.needsDescription)) {
    const typed = await vscode.window.showInputBox({
      title: `Description for "${s.name}"`,
      prompt: 'What the skill does and when the agent should use it. Agents read this to decide when to load the skill.',
      placeHolder: 'e.g. Generates release notes from merged PRs. Use when the user asks for a changelog.',
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          cleanDescription(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    if (typed === undefined) return false;
    description = cleanDescription(typed);
  }

  const home = service.current?.context.homeDir ?? '';
  const notes: string[] = [];
  const editsFile = chosen.some((f) => !['rename-folder-to-name', 'remove-broken-link', 'rename-skill-file'].includes(f.id));
  if (s.isSymlink && editsFile) notes.push(`This skill is a link: the change is made in its target (${tildify(s.realDir, home)}), shared by every place that links to it.`);
  if (service.tracked(s) && editsFile) notes.push('It came from GitHub: the edit counts as a local change, and an update will ask before replacing it.');
  const detail = [
    ...chosen.map((f) => `• ${f.detail}`),
    ...(description ? ['', `Description: ${description}`] : []),
    ...(notes.length ? ['', ...notes] : []),
    '',
    'A backup of the original is kept in the backup folder.',
  ].join('\n');
  const action = chosen.length > 1 ? `Apply ${chosen.length} Fixes` : 'Apply Fix';
  const choice = await vscode.window.showInformationMessage(`Fix "${s.name}"?`, { modal: true, detail }, action);
  if (choice !== action) return false;

  const done: string[] = [];
  try {
    for (const f of chosen) {
      const r = await applyFix(s, loc, f.id, { lock: service.lock, backupRoot: service.backupDir, description });
      done.push(r.summary);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`${done.length ? done.join(' ') + ' Then: ' : ''}${e instanceof UserError ? e.message : (e as Error).message}`);
    await service.refresh();
    return false;
  }
  await service.refresh();
  vscode.window.showInformationMessage(done.join(' '), 'Show Backups').then((c) => {
    if (c) vscode.commands.executeCommand('skillsManager.openBackups');
  });
  return true;
}
