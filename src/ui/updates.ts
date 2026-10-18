import * as vscode from 'vscode';
import * as path from 'node:path';
import { cleanupStaging, commitInstall, planInstall } from '../core/installer';
import { worstSeverity } from '../core/inspector';
import { pathKey } from '../core/paths';
import { trackedFromLock } from '../core/provenance';
import { basisOf, checkUpdates, isEmptyDiff, prepareUpdate, type FileDiff, type UpdatePreview } from '../core/updates';
import { UserError } from '../core/types';
import { makeGitHubClient } from './actions';
import type { SkillsService } from './service';

const STARTUP_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Manual check (interactive=true) or the optional startup check, which reuses a recent cache and never prompts. */
export async function checkForUpdates(service: SkillsService, interactive: boolean): Promise<void> {
  if (!interactive) {
    const last = service.updatesCheckedAt ? Date.parse(service.updatesCheckedAt) : 0;
    if (Date.now() - last < STARTUP_MAX_AGE_MS) return;
  }
  if (!service.current) await service.refresh();
  const items = service.updatable().map(({ skill, source }) => ({ key: skill.dir, source }));
  if (items.length === 0) {
    if (interactive) vscode.window.showInformationMessage('No skills with known GitHub provenance (installed here or with `gh skill`).');
    return;
  }
  const run = async () => {
    const client = await makeGitHubClient(service);
    const results = await checkUpdates(client, items);
    await service.storeUpdates(results, true);
    return Object.values(results);
  };
  try {
    const results = interactive
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking ${items.length} skill(s) for updates…` }, run)
      : await run();
    if (!interactive) return;
    const n = results.filter((r) => r.status === 'update-available' || r.status === 'unknown').length;
    const err = results.find((r) => r.status === 'error');
    if (err) vscode.window.showWarningMessage(`Some update checks failed: ${err.message}`);
    else vscode.window.showInformationMessage(n ? `${n} skill update(s) available.` : 'All tracked skills are up to date.');
  } catch (e) {
    if (interactive) vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Update check failed: ${(e as Error).message}`);
  }
}

function list(title: string, files: string[], max = 12): string[] {
  if (!files.length) return [];
  const shown = files.slice(0, max).map((f) => `    ${f}`);
  if (files.length > max) shown.push(`    … and ${files.length - max} more`);
  return [`  ${title} (${files.length}):`, ...shown];
}

function describeDiff(d: FileDiff): string[] {
  return [...list('Added', d.added), ...list('Modified', d.modified), ...list('Removed', d.removed)];
}

/** Review an update in native modals (diff, local edits, findings), then replace with a backup. */
export async function confirmAndUpdate(service: SkillsService, skillId: string): Promise<boolean> {
  const s = service.skill(skillId);
  if (!s) return false;
  const loc = service.location(s.locationId);
  const source = service.tracked(s);
  if (!loc || !source) {
    vscode.window.showInformationMessage(`"${s.name}" has no known GitHub source to update from.`);
    return false;
  }
  if (s.isSymlink) {
    vscode.window.showWarningMessage(`"${s.name}" is a link. Update the original folder instead: ${s.realDir}`);
    return false;
  }
  if (s.readOnly || loc.readOnly) {
    vscode.window.showWarningMessage(`"${s.name}" can't be updated here: ${s.readOnlyReason ?? loc.readOnlyReason ?? 'read-only location'}`);
    return false;
  }
  if (pathKey(path.dirname(s.dir)) !== pathKey(loc.path)) {
    vscode.window.showWarningMessage(`"${s.name}" is not directly inside ${loc.label}; refusing to update it.`);
    return false;
  }

  let preview: UpdatePreview | undefined;
  try {
    preview = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading the latest "${s.name}" for review…` },
      async () => prepareUpdate(await makeGitHubClient(service), { source, skillDir: s.dir, stagingRoot: service.stagingDir }),
    );
    const p = preview;
    await service.storeUpdates(
      { [s.dir]: { status: isEmptyDiff(p.upstream) ? 'up-to-date' : 'update-available', checkedAt: new Date().toISOString(), basis: basisOf(source), remoteCommit: p.toCommit } },
      false,
    );
    if (isEmptyDiff(p.upstream)) {
      vscode.window.showInformationMessage(`"${s.name}" is already up to date with ${source.ref}.`);
      return false;
    }

    const findings = p.staged.findings;
    if (worstSeverity(findings) === 'high') {
      const n = findings.filter((f) => f.severity === 'high').length;
      const detail = findings
        .filter((f) => f.severity === 'high')
        .slice(0, 8)
        .map((f) => `• ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`)
        .join('\n');
      const ok = await vscode.window.showWarningMessage(
        `The new version of "${s.name}" has ${n} high-risk finding(s).`,
        { modal: true, detail: `${detail}\n\nSkills are instructions your agent follows and may include scripts it can run. Only update from sources you trust.` },
        'I reviewed them, continue',
      );
      if (!ok) return false;
    }

    const who = loc.readers.map((r) => service.providerName(r)).join(', ');
    const localEdits = p.local ? [...p.local.added, ...p.local.modified, ...p.local.removed] : [];
    const detail = [
      `From: ${source.owner}/${source.repo}/${source.subpath} (${source.ref})`,
      `Version: ${p.fromCommit ? p.fromCommit.slice(0, 7) : 'installed'} → ${p.toCommit.slice(0, 7)}`,
      `Folder: ${s.dir}`,
      `Visible to: ${who}`,
      '',
      `Upstream changes${p.upstreamBase === 'local' ? ' (compared with your local copy)' : ''}:`,
      ...describeDiff(p.upstream),
      '',
      p.local
        ? localEdits.length
          ? `⚠ Your local edits will be replaced (${localEdits.length} file(s)):`
          : 'No local edits since install.'
        : 'Local edits: unknown (the installed version is not available to compare).',
      ...(p.local ? describeDiff(p.local) : []),
      ...p.notes.map((n) => `\nNote: ${n}`),
      '',
      'The current folder is moved to a backup first. Nothing is executed; files are written without execute permission.',
    ].join('\n');

    for (;;) {
      const action = localEdits.length ? 'Replace Local Edits and Update' : 'Update';
      const choice = await vscode.window.showInformationMessage(`Update "${s.name}"?`, { modal: true, detail }, action, 'Compare Files…');
      if (choice === 'Compare Files…') {
        await compareFiles(s.dir, p);
        continue;
      }
      if (choice !== action) return false;
      break;
    }

    const plans = await planInstall([p.staged], loc);
    await commitInstall(plans, true, { lock: service.lock, backupRoot: service.backupDir, inspection: p.inspection });
    const now = service.lock.get(s.dir);
    if (now) {
      await service.storeUpdates({ [s.dir]: { status: 'up-to-date', checkedAt: new Date().toISOString(), basis: basisOf(trackedFromLock(now)), remoteCommit: p.toCommit } }, false);
    }
    await service.refresh();
    vscode.window.showInformationMessage(`Updated "${s.name}" to ${p.toCommit.slice(0, 7)}. The previous version was kept as a backup.`, 'Show Backups').then((c) => {
      if (c) vscode.commands.executeCommand('skillsManager.openBackups');
    });
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Update of "${s.name}" failed: ${(e as Error).message}`);
    return false;
  } finally {
    if (preview) await cleanupStaging([preview.staged]);
  }
}

async function compareFiles(skillDir: string, p: UpdatePreview): Promise<void> {
  const items = [
    ...p.upstream.modified.map((f) => ({ label: f, description: 'modified upstream' })),
    ...p.upstream.added.map((f) => ({ label: f, description: 'added upstream' })),
    ...p.upstream.removed.map((f) => ({ label: f, description: 'removed upstream' })),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Compare local file with the new version' });
  if (!pick) return;
  const local = vscode.Uri.file(path.join(skillDir, pick.label));
  const next = vscode.Uri.file(path.join(p.staged.stagingDir, pick.label));
  const empty = vscode.Uri.parse('untitled:' + pick.label);
  const left = pick.description === 'added upstream' ? empty : local;
  const right = pick.description === 'removed upstream' ? empty : next;
  await vscode.commands.executeCommand('vscode.diff', left, right, `${pick.label} (local ↔ new)`, { preview: true });
}

