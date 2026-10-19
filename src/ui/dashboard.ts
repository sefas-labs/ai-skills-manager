import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { FEATURED_SOURCES } from '../core/catalog';
import { archiveSyncedBucket } from '../core/discovery';
import { parseGitHubUrl } from '../core/github';
import { cleanupStaging, commitInstall, inspectRepository, planInstall, RepoInspection, stageCandidates, StagedSkill } from '../core/installer';
import { worstSeverity } from '../core/inspector';
import { parseFrontmatter } from '../core/frontmatter';
import { isPathInside, safeJoin } from '../core/paths';
import { UserError } from '../core/types';
import type { FixId } from '../core/fixes';
import type { HostToWebview, ViewInspection, WebviewToHost } from '../shared/protocol';
import { confirmAndUninstall, copySkillPath, getGitHubToken, makeGitHubClient, openSkillFile, revealSkill } from './actions';
import type { SkillsService } from './service';
import { chooseCopy } from './choose';
import { fixSkill } from './fixes';
import { addMcp, deleteCustomization, newCustomization, removeMcp, toggleMcp } from './editing';
import { log } from './log';
import { handleMerge } from './merge';
import { setSkillToggle, type ToggleRequest } from './toggles';
import { copyOrMoveSkill } from './transfer';
import { checkForUpdates, confirmAndUpdate } from './updates';

type SetToggleMessage = Extract<WebviewToHost, { type: 'setToggle' }>;

const MAX_SKILL_BODY_LENGTH = 30000;
const MAX_LISTED_FILES = 300;
const MAX_LISTING_DEPTH = 6;
const MAX_CANDIDATE_FILES_SHOWN = 200;
const SHORT_COMMIT_LENGTH = 7;
const NONCE_BYTES = 16;
const MAX_LOGGED_ERROR_LENGTH = 500;
/** Shown after a symlink's name in the file list; stripped again when the user opens it. */
const SYMLINK_MARKER = ' →';
/** Opened in the OS file browser instead of as text. */
const BINARY_FILE = /\.(png|jpe?g|gif|webp|pdf|zip|exe|dll|so|dylib|bin|woff2?|ttf)$/i;
/** Only GitHub repository pages are opened in the browser. */
const GITHUB_REPO_PAGE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/|$)/;
const MOVE_TO_BACKUP = 'Move to Backup';

function toggleRequestFrom(message: SetToggleMessage): ToggleRequest {
  if (message.agent === 'claude') return { agent: 'claude', value: message.value };
  if (message.agent === 'codex') return { agent: 'codex', enabled: message.enabled };
  return { agent: 'frontmatter', mode: message.mode };
}

/** SKILL.md first, then files, then sub-folders, each alphabetically. */
function listingOrder(entry: { name: string; isDirectory(): boolean }): number {
  if (entry.name === 'SKILL.md') return 0;
  return entry.isDirectory() ? 2 : 1;
}

/** Relative paths of the files in a skill folder, bounded; symlinks are marked and not followed. */
async function listSkillFiles(skillDir: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const walk = async (dir: string, relativeDir: string, depth: number) => {
    if (depth > MAX_LISTING_DEPTH || files.length >= MAX_LISTED_FILES) {
      truncated = truncated || files.length >= MAX_LISTED_FILES;
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((first, second) => listingOrder(first) - listingOrder(second) || first.name.localeCompare(second.name));
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) {
        truncated = true;
        return;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relativePath, depth + 1);
      else if (entry.isSymbolicLink()) files.push(relativePath + SYMLINK_MARKER);
      else files.push(relativePath);
    }
  };
  await walk(skillDir, '', 0);
  return { files, truncated };
}

function viewInspection(inspection: RepoInspection): ViewInspection {
  return {
    owner: inspection.owner,
    repo: inspection.repo,
    ref: inspection.ref,
    commit: inspection.commit,
    subpath: inspection.subpath,
    url: inspection.url,
    notes: inspection.notes,
    candidates: inspection.candidates.map((candidate) => ({
      id: candidate.id,
      repoDir: candidate.repoDir,
      installName: candidate.installName,
      name: candidate.name,
      description: candidate.description,
      fileCount: candidate.files.length,
      files: candidate.files.slice(0, MAX_CANDIDATE_FILES_SHOWN).map((file) => file.path),
      skipped: candidate.skipped,
      totalBytes: candidate.totalBytes,
      issues: candidate.issues,
      findings: candidate.findings,
      skillMdPreview: candidate.skillMdPreview,
      installable: candidate.installable,
      blockReason: candidate.blockReason,
    })),
  };
}

/** Moves the claude.ai skills synced for another account to the backup folder, after a modal. */
async function archiveOtherAccountSkills(service: SkillsService, bucket: string): Promise<void> {
  const location = service.current?.locations.find((candidate) => candidate.skippedSyncedBuckets?.some((skipped) => skipped.bucket === bucket));
  const skipped = location?.skippedSyncedBuckets?.find((candidate) => candidate.bucket === bucket);
  if (!skipped) return;
  const lastSynced = skipped.lastSynced ? new Date(skipped.lastSynced).toLocaleDateString() : 'on an unknown date';
  const answer = await vscode.window.showWarningMessage(
    `Move the claude.ai skills of another account to the backup folder?`,
    {
      modal: true,
      detail: [
        skipped.path,
        '',
        `${skipped.skills.length} skill(s), last synced ${lastSynced}: ${skipped.skills.join(', ')}.`,
        '',
        "Claude Code doesn't load them (they belong to an account you're not signed in with). If you sign in with that account again, Claude Code downloads them again.",
      ].join('\n'),
    },
    MOVE_TO_BACKUP,
  );
  if (answer !== MOVE_TO_BACKUP) return;
  const destination = await archiveSyncedBucket(service.current!.context.homeDir, bucket, service.backupDir);
  log().info(`archive synced bucket ${bucket} → ${destination}`);
  await service.refresh();
  vscode.window.showInformationMessage('Moved the other account’s synced skills to the backup folder.', 'Show Backups').then((choice) => {
    if (choice) vscode.commands.executeCommand('skillsManager.openBackups');
  });
}

export class DashboardPanel implements vscode.Disposable {
  static current: DashboardPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private inspection: RepoInspection | undefined;
  private staged: StagedSkill[] = [];
  private ready = false;
  private pending: HostToWebview[] = [];

  /** Last render error reported by the webview, if any. */
  lastClientError: string | undefined;

  static show(context: vscode.ExtensionContext, service: SkillsService, focus?: Extract<HostToWebview, { type: 'focus' }>): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
    } else {
      const panel = vscode.window.createWebviewPanel('skillsManager.dashboard', 'AI Skills', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'dist')],
      });
      DashboardPanel.current = new DashboardPanel(panel, context, service);
    }
    if (focus) DashboardPanel.current.post(focus);
    return DashboardPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly service: SkillsService,
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message: WebviewToHost) => this.onMessage(message)),
      service.onDidChange(() => this.pushState()),
    );
  }

  /** True once the webview script ran under the CSP and sent 'ready'. */
  get isReady(): boolean {
    return this.ready;
  }

  private post(message: HostToWebview): void {
    if (!this.ready) {
      this.pending.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private pushState(): void {
    const state = this.service.viewState();
    if (state) this.post({ type: 'state', state });
  }

  private async onReady(): Promise<void> {
    this.ready = true;
    if (!this.service.current) await this.service.refresh();
    await getGitHubToken(this.service);
    this.pushState();
    this.post({ type: 'catalogSources', sources: FEATURED_SOURCES.map(({ id, title, blurb }) => ({ id, title, blurb })) });
    for (const queued of this.pending.splice(0)) void this.panel.webview.postMessage(queued);
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    const service = this.service;
    try {
      switch (message.type) {
        case 'ready':
          return await this.onReady();
        case 'clientError':
          this.lastClientError = String(message.message);
          console.error('[skills-manager] dashboard render error:', String(message.message).slice(0, MAX_LOGGED_ERROR_LENGTH));
          return;
        case 'reloadWindow':
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        case 'refresh':
          await this.withBusy('refresh', () => service.refresh());
          return;
        case 'getDetail':
          return await this.sendDetail(message.skillId);
        case 'openSkillFile':
          if (message.rel) return await this.openSkillRelativeFile(message.skillId, message.rel);
          return await openSkillFile(service, message.skillId);
        case 'reveal':
          return await revealSkill(service, message.skillId);
        case 'copyPath':
          return await copySkillPath(service, message.skillId);
        case 'uninstall':
          await confirmAndUninstall(service, message.skillId);
          return;
        case 'copyMove':
          await copyOrMoveSkill(service, message.skillId);
          return;
        case 'chooseCopy':
          await this.withBusy('chooseCopy', () => chooseCopy(service, message.skillId));
          return;
        case 'copyTo':
          await copyOrMoveSkill(service, message.skillId, { targetId: message.locationId });
          return;
        case 'addToProject':
          await this.withBusy('addToProject', () => copyOrMoveSkill(service, message.skillId, { toProject: true }));
          return;
        case 'fix':
          await this.withBusy('fix', () => fixSkill(service, message.skillId, message.fixId as FixId | undefined));
          return;
        case 'merge':
          await this.withBusy('merge', () => handleMerge(service, message.suggestionId, message.action, message.skillId));
          return;
        case 'catalogList': {
          const listing = await this.withBusy(`catalog:${message.sourceId}`, () => service.catalog.list(message.sourceId, message.force));
          this.post({ type: 'catalogSkills', sourceId: message.sourceId, ...listing });
          return;
        }
        case 'catalogSearch': {
          const skills = await this.withBusy('catalogSearch', () => service.catalog.search(message.query));
          this.post({ type: 'catalogResults', query: message.query, skills });
          return;
        }
        case 'setToggle':
          await this.withBusy('toggle', () => setSkillToggle(service, message.skillId, toggleRequestFrom(message)));
          return;
        case 'openCustomization': {
          // Only files from the inventory, opened as text (never executed).
          const item = service.customizations[Number(message.id)];
          if (item) await vscode.window.showTextDocument(vscode.Uri.file(item.path), { preview: true });
          return;
        }
        case 'newCustomization':
          await this.withBusy('edit', () => newCustomization(service, message.kind));
          return;
        case 'deleteCustomization':
          await this.withBusy('edit', () => deleteCustomization(service, message.id));
          return;
        case 'mcpAdd':
          await this.withBusy('edit', () => addMcp(service));
          return;
        case 'mcpRemove':
          await this.withBusy('edit', () => removeMcp(service, message.id, message.name));
          return;
        case 'mcpToggle':
          await this.withBusy('edit', () => toggleMcp(service, message.id, message.name, message.enabled));
          return;
        case 'archiveSynced':
          return await archiveOtherAccountSkills(service, message.bucket);
        case 'openUrl':
          if (GITHUB_REPO_PAGE.test(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
          return;
        case 'checkUpdates':
          await this.withBusy('checkUpdates', () => checkForUpdates(service, true));
          return;
        case 'update':
          await this.withBusy('update', () => confirmAndUpdate(service, message.skillId));
          return;
        case 'signIn':
          await getGitHubToken(service, message.privateRepos ? 'private' : 'public');
          this.pushState();
          return;
        case 'openDocs': {
          const provider = service.current?.providers.find((candidate) => candidate.id === message.providerId);
          if (provider?.docsUrl.startsWith('https://')) await vscode.env.openExternal(vscode.Uri.parse(provider.docsUrl));
          return;
        }
        case 'inspect':
          return await this.inspect(message.url);
        case 'stage':
          return await this.stage(message.candidateIds);
        case 'install':
          return await this.install(message.locationId);
        case 'cancelInstall':
          await this.resetInstall();
          this.post({ type: 'installCancelled' });
          return;
        default:
          // A dashboard from a newer build than this host: say so instead of ignoring the click.
          log().warn(`dashboard: unknown action ${(message as { type: string }).type}`);
          this.post({ type: 'error', op: 'general', message: 'This action is not available in the running extension. Run "Developer: Reload Window" to finish updating.' });
      }
    } catch (error) {
      log().error(`dashboard ${message.type} failed`, error as Error);
      const text = error instanceof UserError ? error.message : `Unexpected error: ${(error as Error).message}`;
      this.post({ type: 'error', op: message.type, message: text, code: (error as UserError).code });
    }
  }

  private async withBusy<T>(operation: string, task: () => Promise<T>): Promise<T> {
    this.post({ type: 'busy', op: operation, busy: true });
    try {
      return await task();
    } finally {
      this.post({ type: 'busy', op: operation, busy: false });
    }
  }

  private async sendDetail(skillId: string): Promise<void> {
    const skill = this.service.skill(skillId);
    if (!skill) return;
    const skillMd = await fs.readFile(skill.skillFile, 'utf8').catch(() => '');
    const body = parseFrontmatter(skillMd).body.trim().slice(0, MAX_SKILL_BODY_LENGTH);
    const { files, truncated } = await listSkillFiles(skill.realDir);
    this.post({ type: 'detail', detail: { id: skill.id, body, files, truncated } });
  }

  private async openSkillRelativeFile(skillId: string, relativePath: string): Promise<void> {
    const skill = this.service.skill(skillId);
    if (!skill) return;
    const target = safeJoin(skill.realDir, relativePath.replace(new RegExp(`${SYMLINK_MARKER}$`), ''));
    const realTarget = await fs.realpath(target).catch(() => target);
    if (!isPathInside(realTarget, skill.realDir)) {
      vscode.window.showWarningMessage('That file is a link pointing outside the skill folder; opening it in the OS file browser instead.');
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
      return;
    }
    if (BINARY_FILE.test(relativePath)) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(realTarget));
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(realTarget), { preview: true });
  }

  // ---------- GitHub install flow ----------

  private async resetInstall(): Promise<void> {
    if (this.staged.length) await cleanupStaging(this.staged);
    this.staged = [];
    this.inspection = undefined;
  }

  private async inspect(url: string): Promise<void> {
    await this.resetInstall();
    const parsed = parseGitHubUrl(url);
    const inspection = await this.withBusy('inspect', async () => inspectRepository(await makeGitHubClient(this.service), parsed));
    this.inspection = inspection;
    this.pushState();
    this.post({ type: 'inspection', inspection: viewInspection(inspection) });
  }

  private async stage(candidateIds: string[]): Promise<void> {
    if (!this.inspection) throw new UserError('Analyze a repository first.');
    if (this.staged.length) await cleanupStaging(this.staged);
    this.staged = [];
    const inspection = this.inspection;
    this.staged = await this.withBusy('stage', async () => stageCandidates(await makeGitHubClient(this.service), inspection, candidateIds, this.service.stagingDir));
    this.post({
      type: 'staged',
      staged: this.staged.map((stagedSkill) => ({
        candidateId: stagedSkill.candidate.id,
        installName: stagedSkill.candidate.installName,
        fileCount: stagedSkill.fileCount,
        bytes: stagedSkill.bytes,
        findings: stagedSkill.findings,
      })),
    });
  }

  /** Asks once more when the review found high-risk content; true to continue. */
  private async acceptHighRiskFindings(): Promise<boolean> {
    const allFindings = this.staged.flatMap((stagedSkill) => stagedSkill.findings);
    if (worstSeverity(allFindings) !== 'high') return true;
    const highRiskCount = allFindings.filter((finding) => finding.severity === 'high').length;
    const answer = await vscode.window.showWarningMessage(
      `${highRiskCount} high-risk finding(s) in the selected skills.`,
      {
        modal: true,
        detail:
          'Skills are instructions your AI agent will follow and may include scripts it can run. Review the highlighted findings in the dashboard before continuing. Only install skills from sources you trust.',
      },
      'I reviewed them, continue',
    );
    return !!answer;
  }

  private async install(locationId: string): Promise<void> {
    const inspection = this.inspection;
    if (!inspection || this.staged.length === 0) throw new UserError('Review the selected skills first.');
    const location = this.service.location(locationId);
    if (!location) throw new UserError('Choose where to install.');
    if (location.scope === 'workspace' && !vscode.workspace.isTrusted) {
      throw new UserError('This workspace is not trusted. Trust it to install skills into the workspace.');
    }
    const plans = await planInstall(this.staged, location);
    if (!(await this.acceptHighRiskFindings())) return;

    const replacesExisting = plans.some((plan) => plan.exists);
    const planLines = plans.map((plan) => {
      const replaceNote = plan.exists ? ' (replaces existing; a backup is kept)' : '';
      return `• ${plan.staged.candidate.installName} — ${plan.staged.fileCount} files${replaceNote}`;
    });
    const detail = [
      `From: ${inspection.owner}/${inspection.repo} @ ${inspection.commit.slice(0, SHORT_COMMIT_LENGTH)} (${inspection.ref})`,
      `Into: ${location.path}`,
      `Visible to: ${this.service.agentNames(location.readers, '')}`,
      '',
      ...planLines,
      '',
      'Nothing is executed. Files are written without execute permission.',
    ].join('\n');
    const action = replacesExisting ? 'Replace and Install' : 'Install';
    const plural = plans.length > 1 ? 's' : '';
    const choice = await vscode.window.showInformationMessage(`Install ${plans.length} skill${plural} into ${location.label}?`, { modal: true, detail }, action);
    if (choice !== action) return;

    const results = await this.withBusy('install', () =>
      commitInstall(plans, replacesExisting, { lock: this.service.lock, backupRoot: this.service.backupDir, inspection }),
    );
    await cleanupStaging(this.staged);
    this.staged = [];
    await this.service.refresh();
    const installedNames = results.map((result) => result.name);
    this.post({ type: 'installed', names: installedNames, locationLabel: location.label });
    const firstInstalled = results[0];
    vscode.window.showInformationMessage(`Installed ${installedNames.join(', ')} into ${location.label}.`, 'Open SKILL.md').then((choice) => {
      if (choice && firstInstalled) vscode.window.showTextDocument(vscode.Uri.file(path.join(firstInstalled.targetDir, 'SKILL.md')));
    });
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(NONCE_BYTES).toString('base64');
    const resource = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...segments));
    const contentSecurityPolicy = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${resource('dist', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${resource('media', 'dashboard.css')}">
<title>AI Skills</title>
</head>
<body>
<div id="app" role="application" aria-busy="true"></div>
<script nonce="${nonce}" src="${resource('dist', 'webview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    void cleanupStaging(this.staged);
    for (const disposable of this.disposables) disposable.dispose();
    this.panel.dispose();
  }
}
