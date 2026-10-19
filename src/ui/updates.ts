import * as vscode from 'vscode';
import * as path from 'node:path';
import { cleanupStaging, commitInstall, planInstall } from '../core/installer';
import { worstSeverity, type Finding } from '../core/inspector';
import { pathKey } from '../core/paths';
import { trackedFromLock } from '../core/provenance';
import { basisOf, checkUpdates, isEmptyDiff, prepareUpdate, type FileDiff, type UpdatePreview } from '../core/updates';
import { ResolvedLocation, SkillRecord, TrackedSource, UserError } from '../core/types';
import { makeGitHubClient } from './actions';
import type { SkillsService } from './service';

const HOURS_TO_MS = 60 * 60 * 1000;
/** The optional startup check reuses results younger than this. */
const STARTUP_CACHE_MAX_AGE_MS = 12 * HOURS_TO_MS;
const SHORT_COMMIT_LENGTH = 7;
const MAX_FILES_PER_DIFF_SECTION = 12;
const MAX_FINDINGS_SHOWN = 8;
const COMPARE_FILES = 'Compare Files…';
const UPDATE_WITH_GH = 'Update with gh skill…';
const CONTINUE_AFTER_REVIEW = 'I reviewed them, continue';

function shortCommit(commit: string): string {
  return commit.slice(0, SHORT_COMMIT_LENGTH);
}

function isRecent(isoDate: string | undefined, maxAgeMs: number): boolean {
  const checkedAt = isoDate ? Date.parse(isoDate) : 0;
  return Date.now() - checkedAt < maxAgeMs;
}

/** Manual check (interactive=true) or the optional startup check, which reuses a recent cache and never prompts. */
export async function checkForUpdates(service: SkillsService, interactive: boolean): Promise<void> {
  if (!interactive && isRecent(service.updatesCheckedAt, STARTUP_CACHE_MAX_AGE_MS)) return;
  if (!service.current) await service.refresh();
  const items = service.updatable().map(({ skill, source }) => ({ key: skill.dir, source }));
  if (items.length === 0) {
    if (interactive) vscode.window.showInformationMessage('No skills with known GitHub provenance (installed here or with `gh skill`).');
    return;
  }
  const checkAll = async () => {
    const results = await checkUpdates(await makeGitHubClient(service), items);
    await service.storeUpdates(results, true);
    return Object.values(results);
  };
  try {
    const results = interactive
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking ${items.length} skill(s) for updates…` }, checkAll)
      : await checkAll();
    if (!interactive) return;
    const updateCount = results.filter((result) => result.status === 'update-available' || result.status === 'unknown').length;
    const failed = results.find((result) => result.status === 'error');
    if (failed) vscode.window.showWarningMessage(`Some update checks failed: ${failed.message}`);
    else vscode.window.showInformationMessage(updateCount ? `${updateCount} skill update(s) available.` : 'All tracked skills are up to date.');
  } catch (error) {
    if (interactive) vscode.window.showErrorMessage(error instanceof UserError ? error.message : `Update check failed: ${(error as Error).message}`);
  }
}

function fileSection(title: string, files: string[]): string[] {
  if (!files.length) return [];
  const shown = files.slice(0, MAX_FILES_PER_DIFF_SECTION).map((file) => `    ${file}`);
  const hiddenCount = files.length - MAX_FILES_PER_DIFF_SECTION;
  if (hiddenCount > 0) shown.push(`    … and ${hiddenCount} more`);
  return [`  ${title} (${files.length}):`, ...shown];
}

function describeDiff(diff: FileDiff): string[] {
  return [...fileSection('Added', diff.added), ...fileSection('Modified', diff.modified), ...fileSection('Removed', diff.removed)];
}

function allChangedFiles(diff: FileDiff): string[] {
  return [...diff.added, ...diff.modified, ...diff.removed];
}

/** Why this skill can't be updated in place, or undefined when it can. */
function updateBlocker(skill: SkillRecord, location: ResolvedLocation): string | undefined {
  if (skill.isSymlink) return `"${skill.name}" is a link. Update the original folder instead: ${skill.realDir}`;
  if (skill.readOnly || location.readOnly) return `"${skill.name}" can't be updated here: ${skill.readOnlyReason ?? location.readOnlyReason ?? 'read-only location'}`;
  if (pathKey(path.dirname(skill.dir)) !== pathKey(location.path)) return `"${skill.name}" is not directly inside ${location.label}; refusing to update it.`;
  return undefined;
}

async function acceptHighRiskFindings(skillName: string, findings: Finding[]): Promise<boolean> {
  if (worstSeverity(findings) !== 'high') return true;
  const highRisk = findings.filter((finding) => finding.severity === 'high');
  const listed = highRisk
    .slice(0, MAX_FINDINGS_SHOWN)
    .map((finding) => `• ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.message}`)
    .join('\n');
  const answer = await vscode.window.showWarningMessage(
    `The new version of "${skillName}" has ${highRisk.length} high-risk finding(s).`,
    { modal: true, detail: `${listed}\n\nSkills are instructions your agent follows and may include scripts it can run. Only update from sources you trust.` },
    CONTINUE_AFTER_REVIEW,
  );
  return !!answer;
}

function localEditsSummary(preview: UpdatePreview): string[] {
  if (!preview.local) return ['Local edits: unknown (the installed version is not available to compare).'];
  const editedCount = allChangedFiles(preview.local).length;
  const headline = editedCount ? `⚠ Your local edits will be replaced (${editedCount} file(s)):` : 'No local edits since install.';
  return [headline, ...describeDiff(preview.local)];
}

function updateDetail(service: SkillsService, skill: SkillRecord, location: ResolvedLocation, source: TrackedSource, preview: UpdatePreview): string {
  const fromVersion = preview.fromCommit ? shortCommit(preview.fromCommit) : 'installed';
  const comparedWith = preview.upstreamBase === 'local' ? ' (compared with your local copy)' : '';
  return [
    `From: ${source.owner}/${source.repo}/${source.subpath} (${source.ref})`,
    `Version: ${fromVersion} → ${shortCommit(preview.toCommit)}`,
    `Folder: ${skill.dir}`,
    `Visible to: ${service.agentNames(location.readers, '')}`,
    '',
    `Upstream changes${comparedWith}:`,
    ...describeDiff(preview.upstream),
    '',
    ...localEditsSummary(preview),
    ...preview.notes.map((note) => `\nNote: ${note}`),
    '',
    'The current folder is moved to a backup first. Nothing is executed; files are written without execute permission.',
  ].join('\n');
}

/** Shows the update modal until the user updates, cancels or hands over to gh. True to update here. */
async function confirmUpdate(skill: SkillRecord, source: TrackedSource, preview: UpdatePreview, detail: string): Promise<boolean> {
  const hasLocalEdits = !!preview.local && allChangedFiles(preview.local).length > 0;
  const updateAction = hasLocalEdits ? 'Replace Local Edits and Update' : 'Update';
  const extraActions = source.origin === 'gh-skill' ? [UPDATE_WITH_GH] : [];
  for (;;) {
    const choice = await vscode.window.showInformationMessage(`Update "${skill.name}"?`, { modal: true, detail }, updateAction, COMPARE_FILES, ...extraActions);
    if (choice === COMPARE_FILES) {
      await compareFiles(skill.dir, preview);
      continue;
    }
    if (choice === UPDATE_WITH_GH) {
      typeGhUpdateCommand(skill.dirName, path.dirname(skill.dir));
      return false;
    }
    return choice === updateAction;
  }
}

async function rememberCheck(service: SkillsService, skillDir: string, status: 'up-to-date' | 'update-available', basis: string, remoteCommit: string): Promise<void> {
  await service.storeUpdates({ [skillDir]: { status, checkedAt: new Date().toISOString(), basis, remoteCommit } }, false);
}

/** Review an update in native modals (diff, local edits, findings), then replace with a backup. */
export async function confirmAndUpdate(service: SkillsService, skillId: string): Promise<boolean> {
  const skill = service.skill(skillId);
  if (!skill) return false;
  const location = service.location(skill.locationId);
  const source = service.tracked(skill);
  if (!location || !source) {
    vscode.window.showInformationMessage(`"${skill.name}" has no known GitHub source to update from.`);
    return false;
  }
  const blocker = updateBlocker(skill, location);
  if (blocker) {
    vscode.window.showWarningMessage(blocker);
    return false;
  }

  let preview: UpdatePreview | undefined;
  try {
    preview = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading the latest "${skill.name}" for review…` }, async () =>
      prepareUpdate(await makeGitHubClient(service), { source, skillDir: skill.dir, stagingRoot: service.stagingDir }),
    );
    const upToDate = isEmptyDiff(preview.upstream);
    await rememberCheck(service, skill.dir, upToDate ? 'up-to-date' : 'update-available', basisOf(source), preview.toCommit);
    if (upToDate) {
      vscode.window.showInformationMessage(`"${skill.name}" is already up to date with ${source.ref}.`);
      return false;
    }
    if (!(await acceptHighRiskFindings(skill.name, preview.staged.findings))) return false;
    if (!(await confirmUpdate(skill, source, preview, updateDetail(service, skill, location, source, preview)))) return false;

    const plans = await planInstall([preview.staged], location);
    await commitInstall(plans, true, { lock: service.lock, backupRoot: service.backupDir, inspection: preview.inspection });
    const newLockEntry = service.lock.get(skill.dir);
    if (newLockEntry) await rememberCheck(service, skill.dir, 'up-to-date', basisOf(trackedFromLock(newLockEntry)), preview.toCommit);
    await service.refresh();
    vscode.window
      .showInformationMessage(`Updated "${skill.name}" to ${shortCommit(preview.toCommit)}. The previous version was kept as a backup.`, 'Show Backups')
      .then((choice) => {
        if (choice) vscode.commands.executeCommand('skillsManager.openBackups');
      });
    return true;
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof UserError ? error.message : `Update of "${skill.name}" failed: ${(error as Error).message}`);
    return false;
  } finally {
    if (preview) await cleanupStaging([preview.staged]);
  }
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Types (doesn't run) `gh skill update` for this skill in a terminal, keeping gh's own provenance tracking. */
function typeGhUpdateCommand(skillName: string, dir: string): void {
  const terminal = vscode.window.createTerminal({ name: 'gh skill update' });
  terminal.show();
  const pressEnterToRun = false;
  terminal.sendText(`gh skill update ${shellQuote(skillName)} --dir ${shellQuote(dir)}`, pressEnterToRun);
  vscode.window.showInformationMessage('The gh command is typed in the terminal — review it and press Enter to run it.');
}

async function compareFiles(skillDir: string, preview: UpdatePreview): Promise<void> {
  type Change = 'modified upstream' | 'added upstream' | 'removed upstream';
  const item = (file: string, change: Change) => ({ label: file, description: change });
  const items = [
    ...preview.upstream.modified.map((file) => item(file, 'modified upstream')),
    ...preview.upstream.added.map((file) => item(file, 'added upstream')),
    ...preview.upstream.removed.map((file) => item(file, 'removed upstream')),
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'Compare local file with the new version' });
  if (!picked) return;
  const emptyDocument = vscode.Uri.parse('untitled:' + picked.label);
  const localFile = vscode.Uri.file(path.join(skillDir, picked.label));
  const newFile = vscode.Uri.file(path.join(preview.staged.stagingDir, picked.label));
  const left = picked.description === 'added upstream' ? emptyDocument : localFile;
  const right = picked.description === 'removed upstream' ? emptyDocument : newFile;
  await vscode.commands.executeCommand('vscode.diff', left, right, `${picked.label} (local ↔ new)`, { preview: true });
}
