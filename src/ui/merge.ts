import * as vscode from 'vscode';
import * as path from 'node:path';
import { uninstallSkill } from '../core/installer';
import type { MergeCopy, MergeSuggestion } from '../core/merge';
import { tildify } from '../core/paths';
import { executeTransfer, planTransfer } from '../core/transfer';
import { UserError } from '../core/types';
import { diffFiles, localFileShas } from '../core/updates';
import type { SkillsService } from './service';

const names = (service: SkillsService, ids: string[]) => ids.map((p) => service.providerName(p)).join(', ') || 'none';

export async function handleMerge(service: SkillsService, suggestionId: string, action: 'apply' | 'compare' | 'unify', skillId?: string): Promise<void> {
  const m = service.merges.find((x) => x.id === suggestionId);
  if (!m) {
    vscode.window.showInformationMessage('This suggestion is out of date. Refresh the list.');
    return;
  }
  try {
    if (action === 'compare') await compare(service, m);
    else if (action === 'apply') await applyRecommendation(service, m);
    else if (skillId) await unify(service, m, skillId);
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Merge failed: ${(e as Error).message}`);
    await service.refresh();
  }
}

function realDirOf(service: SkillsService, c: MergeCopy): string {
  const s = service.skill(c.skillId);
  if (!s) throw new UserError('The skill list changed. Refresh and try again.');
  return s.realDir;
}

/** Diff two copies file by file in the editor. */
async function compare(service: SkillsService, m: MergeSuggestion): Promise<void> {
  const home = service.current?.context.homeDir ?? '';
  let [a, b] = m.copies;
  if (m.copies.length > 2) {
    const pick = await vscode.window.showQuickPick(
      m.copies.slice(1).map((c) => ({ label: c.locationLabel, description: `compare with ${m.copies[0].locationLabel}`, c })),
      { title: `Compare copies of "${m.name}"` },
    );
    if (!pick) return;
    b = pick.c;
  }
  const left = realDirOf(service, a);
  const right = realDirOf(service, b);
  const d = diffFiles(await localFileShas(left), await localFileShas(right));
  const files = [
    ...d.modified.map((f) => ({ label: f, description: 'different' })),
    ...d.added.map((f) => ({ label: f, description: `only in ${b.locationLabel}` })),
    ...d.removed.map((f) => ({ label: f, description: `only in ${a.locationLabel}` })),
  ];
  if (files.length === 0) {
    vscode.window.showInformationMessage(`Both copies of "${m.name}" are identical.`);
    return;
  }
  const pick = files.length === 1 ? files[0] : await vscode.window.showQuickPick(files, { title: `${tildify(left, home)} ↔ ${tildify(right, home)}` });
  if (!pick) return;
  const empty = vscode.Uri.parse('untitled:' + pick.label);
  const l = d.added.includes(pick.label) ? empty : vscode.Uri.file(path.join(left, pick.label));
  const r = d.removed.includes(pick.label) ? empty : vscode.Uri.file(path.join(right, pick.label));
  await vscode.commands.executeCommand('vscode.diff', l, r, `${m.name}/${pick.label}: ${a.locationLabel} ↔ ${b.locationLabel}`, { preview: true });
}

/** Remove the redundant copies (to the backup folder). Agents keep seeing the skill through the copies that stay. */
async function applyRecommendation(service: SkillsService, m: MergeSuggestion): Promise<void> {
  if (!m.remove.length) return;
  const keep = m.copies.filter((c) => m.keep.includes(c.skillId));
  const drop = m.copies.filter((c) => m.remove.includes(c.skillId));
  const keptVersions = new Set(keep.map((c) => c.version));
  const differing = drop.filter((c) => !keptVersions.has(c.version));
  const detail = [
    'Keep:',
    ...keep.map((c) => `  ${c.locationLabel} — ${names(service, c.readers)}`),
    'Remove (moved to the backup folder):',
    ...drop.map((c) => `  ${c.locationLabel} — ${names(service, c.readers)}`),
    '',
    `Every installed agent that sees "${m.name}" today still sees it.`,
    m.stillTwiceBy.length ? `Still seen twice by: ${names(service, m.stillTwiceBy)} (no single folder reaches every agent).` : 'No agent sees it twice any more.',
    ...(differing.length
      ? ['', `⚠ ${differing.map((c) => c.locationLabel).join(', ')} has different content. It will only remain in the backup — compare first if unsure.`]
      : []),
  ].join('\n');
  const action = drop.length > 1 ? `Remove ${drop.length} Copies` : 'Remove Copy';
  const choice = await vscode.window.showWarningMessage(`Merge duplicates of "${m.name}"?`, { modal: true, detail }, action, 'Compare First');
  if (choice === 'Compare First') return compare(service, m);
  if (choice !== action) return;
  for (const c of drop) {
    const s = service.skill(c.skillId);
    const loc = s && service.location(s.locationId);
    if (!s || !loc) throw new UserError('The skill list changed. Refresh and try again.');
    await uninstallSkill(s, loc, { lock: service.lock, trashRoot: service.backupDir });
  }
  await service.refresh();
  vscode.window.showInformationMessage(`Merged "${m.name}": removed ${drop.length} redundant cop${drop.length === 1 ? 'y' : 'ies'}.`, 'Show Backups').then((c) => {
    if (c) vscode.commands.executeCommand('skillsManager.openBackups');
  });
}

/** Copy one version over every other writable copy, so all agents get the same skill. */
async function unify(service: SkillsService, m: MergeSuggestion, sourceId: string): Promise<void> {
  const r = service.current;
  const source = service.skill(sourceId);
  const from = source && service.location(source.locationId);
  if (!r || !source || !from) throw new UserError('The skill list changed. Refresh and try again.');
  const src = m.copies.find((c) => c.skillId === sourceId)!;
  const targets = m.copies.filter((c) => c.skillId !== sourceId && c.writable && c.version !== src.version);
  const skippedRO = m.copies.filter((c) => c.skillId !== sourceId && !c.writable && c.version !== src.version);
  if (!targets.length) {
    vscode.window.showInformationMessage(skippedRO.length ? 'The other copies are read-only; nothing can be overwritten.' : 'All copies already have this version.');
    return;
  }
  const plans = [];
  for (const t of targets) {
    const skill = service.skill(t.skillId);
    const to = skill && service.location(skill.locationId);
    if (!skill || !to) throw new UserError('The skill list changed. Refresh and try again.');
    if (skill.dirName !== source.dirName || skill.isSymlink) {
      throw new UserError(`${t.locationLabel}/${skill.dirName} can't be overwritten automatically (different folder name or a link). Edit it by hand.`);
    }
    plans.push(await planTransfer(source, from, to, 'copy', r.skills));
  }
  const detail = [
    `Use the version in ${src.locationLabel}${src.modifiedAt ? ` (SKILL.md modified ${new Date(src.modifiedAt).toLocaleString()})` : ''}`,
    'and replace:',
    ...targets.map((t) => `  ${t.locationLabel}${t.modifiedAt ? ` (modified ${new Date(t.modifiedAt).toLocaleString()})` : ''}`),
    ...(skippedRO.length ? ['', `Read-only, left as is: ${skippedRO.map((c) => c.locationLabel).join(', ')}`] : []),
    '',
    'The replaced copies are moved to the backup folder first.',
  ].join('\n');
  const choice = await vscode.window.showWarningMessage(`Use one version of "${m.name}" everywhere?`, { modal: true, detail }, 'Replace', 'Compare First');
  if (choice === 'Compare First') return compare(service, m);
  if (choice !== 'Replace') return;
  for (const p of plans) await executeTransfer(p, true, { lock: service.lock, backupRoot: service.backupDir, stagingRoot: service.stagingDir });
  await service.refresh();
  vscode.window.showInformationMessage(`All writable copies of "${m.name}" now match ${src.locationLabel}.`);
}
