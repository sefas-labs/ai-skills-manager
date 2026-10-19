import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { FEATURED_SOURCES } from '../core/catalog';
import { archiveSyncedBucket } from '../core/discovery';
import { parseGitHubUrl } from '../core/github';
import {
  cleanupStaging,
  commitInstall,
  inspectRepository,
  planInstall,
  RepoInspection,
  stageCandidates,
  StagedSkill,
} from '../core/installer';
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
import { log } from './log';
import { handleMerge } from './merge';
import { setSkillToggle, type ToggleRequest } from './toggles';
import { copyOrMoveSkill } from './transfer';
import { checkForUpdates, confirmAndUpdate } from './updates';

export class DashboardPanel implements vscode.Disposable {
  static current: DashboardPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private inspection: RepoInspection | undefined;
  private staged: StagedSkill[] = [];
  private ready = false;
  private pending: HostToWebview[] = [];

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
      panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m)),
      service.onDidChange(() => this.pushState()),
    );
  }

  /** Last render error reported by the webview, if any. */
  lastClientError: string | undefined;

  /** True once the webview script ran under the CSP and sent 'ready'. */
  get isReady(): boolean {
    return this.ready;
  }

  private post(msg: HostToWebview): void {
    if (!this.ready) {
      this.pending.push(msg);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  private pushState(): void {
    const state = this.service.viewState();
    if (state) this.post({ type: 'state', state });
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'ready': {
          this.ready = true;
          if (!this.service.current) await this.service.refresh();
          await getGitHubToken(this.service);
          this.pushState();
          this.post({ type: 'catalogSources', sources: FEATURED_SOURCES.map(({ id, title, blurb }) => ({ id, title, blurb })) });
          for (const p of this.pending.splice(0)) void this.panel.webview.postMessage(p);
          return;
        }
        case 'clientError':
          this.lastClientError = String(m.message);
          console.error('[skills-manager] dashboard render error:', String(m.message).slice(0, 500));
          return;
        case 'reloadWindow':
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        case 'refresh':
          await this.withBusy('refresh', () => this.service.refresh());
          return;
        case 'getDetail':
          return await this.sendDetail(m.skillId);
        case 'openSkillFile':
          if (m.rel) return await this.openRelative(m.skillId, m.rel);
          return await openSkillFile(this.service, m.skillId);
        case 'reveal':
          return await revealSkill(this.service, m.skillId);
        case 'copyPath':
          return await copySkillPath(this.service, m.skillId);
        case 'uninstall':
          await confirmAndUninstall(this.service, m.skillId);
          return;
        case 'copyMove':
          await copyOrMoveSkill(this.service, m.skillId);
          return;
        case 'chooseCopy':
          await this.withBusy('chooseCopy', () => chooseCopy(this.service, m.skillId));
          return;
        case 'copyTo':
          await copyOrMoveSkill(this.service, m.skillId, { targetId: m.locationId });
          return;
        case 'addToProject':
          await this.withBusy('addToProject', () => copyOrMoveSkill(this.service, m.skillId, { toProject: true }));
          return;
        case 'fix':
          await this.withBusy('fix', () => fixSkill(this.service, m.skillId, m.fixId as FixId | undefined));
          return;
        case 'merge':
          await this.withBusy('merge', () => handleMerge(this.service, m.suggestionId, m.action, m.skillId));
          return;
        case 'catalogList': {
          const r = await this.withBusy(`catalog:${m.sourceId}`, () => this.service.catalog.list(m.sourceId, m.force));
          this.post({ type: 'catalogSkills', sourceId: m.sourceId, ...r });
          return;
        }
        case 'catalogSearch': {
          const skills = await this.withBusy('catalogSearch', () => this.service.catalog.search(m.query));
          this.post({ type: 'catalogResults', query: m.query, skills });
          return;
        }
        case 'setToggle': {
          const req = m.agent === 'claude' ? { agent: m.agent, value: m.value } : m.agent === 'codex' ? { agent: m.agent, enabled: m.enabled } : { agent: m.agent, mode: m.mode };
          await this.withBusy('toggle', () => setSkillToggle(this.service, m.skillId, req as ToggleRequest));
          return;
        }
        case 'openCustomization': {
          // Only files from the inventory, opened as text (never executed).
          const item = this.service.customizations[Number(m.id)];
          if (item) await vscode.window.showTextDocument(vscode.Uri.file(item.path), { preview: true });
          return;
        }
        case 'archiveSynced': {
          const loc = this.service.current?.locations.find((l) => l.skippedSyncedBuckets?.some((b) => b.bucket === m.bucket));
          const b = loc?.skippedSyncedBuckets?.find((x) => x.bucket === m.bucket);
          if (!b) return;
          const ok = await vscode.window.showWarningMessage(
            `Move the claude.ai skills of another account to the backup folder?`,
            {
              modal: true,
              detail: `${b.path}\n\n${b.skills.length} skill(s), last synced ${b.lastSynced ? new Date(b.lastSynced).toLocaleDateString() : 'on an unknown date'}: ${b.skills.join(', ')}.\n\nClaude Code doesn't load them (they belong to an account you're not signed in with). If you sign in with that account again, Claude Code downloads them again.`,
            },
            'Move to Backup',
          );
          if (ok !== 'Move to Backup') return;
          const dest = await archiveSyncedBucket(this.service.current!.context.homeDir, m.bucket, this.service.backupDir);
          log().info(`archive synced bucket ${m.bucket} → ${dest}`);
          await this.service.refresh();
          vscode.window.showInformationMessage('Moved the other account’s synced skills to the backup folder.', 'Show Backups').then((c) => {
            if (c) vscode.commands.executeCommand('skillsManager.openBackups');
          });
          return;
        }
        case 'openUrl':
          // Only GitHub pages, opened in the browser.
          if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/|$)/.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
          return;
        case 'checkUpdates':
          await this.withBusy('checkUpdates', () => checkForUpdates(this.service, true));
          return;
        case 'update':
          await this.withBusy('update', () => confirmAndUpdate(this.service, m.skillId));
          return;
        case 'signIn':
          await getGitHubToken(this.service, m.privateRepos ? 'private' : 'public');
          this.pushState();
          return;
        case 'openDocs': {
          const p = this.service.current?.providers.find((x) => x.id === m.providerId);
          if (p && /^https:\/\//.test(p.docsUrl)) await vscode.env.openExternal(vscode.Uri.parse(p.docsUrl));
          return;
        }
        case 'inspect':
          return await this.inspect(m.url);
        case 'stage':
          return await this.stage(m.candidateIds);
        case 'install':
          return await this.install(m.locationId);
        case 'cancelInstall':
          await this.resetInstall();
          this.post({ type: 'installCancelled' });
          return;
        default:
          // A dashboard from a newer build than this host: say so instead of ignoring the click.
          log().warn(`dashboard: unknown action ${(m as { type: string }).type}`);
          this.post({ type: 'error', op: 'general', message: 'This action is not available in the running extension. Run "Developer: Reload Window" to finish updating.' });
      }
    } catch (e) {
      log().error(`dashboard ${m.type} failed`, e as Error);
      this.post({ type: 'error', op: m.type, message: e instanceof UserError ? e.message : `Unexpected error: ${(e as Error).message}`, code: (e as UserError).code });
    }
  }

  private async withBusy<T>(op: string, fn: () => Promise<T>): Promise<T> {
    this.post({ type: 'busy', op, busy: true });
    try {
      return await fn();
    } finally {
      this.post({ type: 'busy', op, busy: false });
    }
  }

  private async sendDetail(skillId: string): Promise<void> {
    const s = this.service.skill(skillId);
    if (!s) return;
    let body = '';
    try {
      const raw = await fs.readFile(s.skillFile, 'utf8');
      body = parseFrontmatter(raw).body.trim().slice(0, 30000);
    } catch {
      body = '';
    }
    const files: string[] = [];
    let truncated = false;
    const walk = async (dir: string, rel: string, depth: number) => {
      if (depth > 6 || files.length >= 300) {
        truncated = truncated || files.length >= 300;
        return;
      }
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      // SKILL.md first, then files, then sub-folders.
      const rank = (e: { name: string; isDirectory(): boolean }) => (e.name === 'SKILL.md' ? 0 : e.isDirectory() ? 2 : 1);
      for (const e of entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))) {
        if (files.length >= 300) {
          truncated = true;
          return;
        }
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r, depth + 1);
        else if (e.isSymbolicLink()) files.push(r + ' →');
        else files.push(r);
      }
    };
    await walk(s.realDir, '', 0);
    this.post({ type: 'detail', detail: { id: s.id, body, files, truncated } });
  }

  private async openRelative(skillId: string, rel: string): Promise<void> {
    const s = this.service.skill(skillId);
    if (!s) return;
    const target = safeJoin(s.realDir, rel.replace(/ →$/, ''));
    const real = await fs.realpath(target).catch(() => target);
    if (!isPathInside(real, s.realDir)) {
      vscode.window.showWarningMessage('That file is a link pointing outside the skill folder; opening it in the OS file browser instead.');
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
      return;
    }
    if (/\.(png|jpe?g|gif|webp|pdf|zip|exe|dll|so|dylib|bin|woff2?|ttf)$/i.test(rel)) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(real));
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(real), { preview: true });
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
    const result = await this.withBusy('inspect', async () => {
      const client = await makeGitHubClient(this.service);
      return inspectRepository(client, parsed);
    });
    this.inspection = result;
    this.pushState();
    const view: ViewInspection = {
      owner: result.owner,
      repo: result.repo,
      ref: result.ref,
      commit: result.commit,
      subpath: result.subpath,
      url: result.url,
      notes: result.notes,
      candidates: result.candidates.map((c) => ({
        id: c.id,
        repoDir: c.repoDir,
        installName: c.installName,
        name: c.name,
        description: c.description,
        fileCount: c.files.length,
        files: c.files.slice(0, 200).map((f) => f.path),
        skipped: c.skipped,
        totalBytes: c.totalBytes,
        issues: c.issues,
        findings: c.findings,
        skillMdPreview: c.skillMdPreview,
        installable: c.installable,
        blockReason: c.blockReason,
      })),
    };
    this.post({ type: 'inspection', inspection: view });
  }

  private async stage(ids: string[]): Promise<void> {
    if (!this.inspection) throw new UserError('Analyze a repository first.');
    if (this.staged.length) await cleanupStaging(this.staged);
    this.staged = [];
    const inspection = this.inspection;
    this.staged = await this.withBusy('stage', async () => {
      const client = await makeGitHubClient(this.service);
      return stageCandidates(client, inspection, ids, this.service.stagingDir);
    });
    this.post({
      type: 'staged',
      staged: this.staged.map((s) => ({
        candidateId: s.candidate.id,
        installName: s.candidate.installName,
        fileCount: s.fileCount,
        bytes: s.bytes,
        findings: s.findings,
      })),
    });
  }

  private async install(locationId: string): Promise<void> {
    if (!this.inspection || this.staged.length === 0) throw new UserError('Review the selected skills first.');
    const loc = this.service.location(locationId);
    if (!loc) throw new UserError('Choose where to install.');
    if (loc.scope === 'workspace' && !vscode.workspace.isTrusted) {
      throw new UserError('This workspace is not trusted. Trust it to install skills into the workspace.');
    }
    const plans = await planInstall(this.staged, loc);
    const allFindings = this.staged.flatMap((s) => s.findings);
    const worst = worstSeverity(allFindings);
    const who = loc.readers.map((r) => this.service.providerName(r)).join(', ');

    if (worst === 'high') {
      const n = allFindings.filter((f) => f.severity === 'high').length;
      const ok = await vscode.window.showWarningMessage(
        `${n} high-risk finding(s) in the selected skills.`,
        {
          modal: true,
          detail:
            'Skills are instructions your AI agent will follow and may include scripts it can run. Review the highlighted findings in the dashboard before continuing. Only install skills from sources you trust.',
        },
        'I reviewed them, continue',
      );
      if (!ok) return;
    }

    const conflicts = plans.filter((p) => p.exists);
    const lines = plans.map(
      (p) => `• ${p.staged.candidate.installName} — ${p.staged.fileCount} files${p.exists ? ' (replaces existing; a backup is kept)' : ''}`,
    );
    const detail = [
      `From: ${this.inspection.owner}/${this.inspection.repo} @ ${this.inspection.commit.slice(0, 7)} (${this.inspection.ref})`,
      `Into: ${loc.path}`,
      `Visible to: ${who}`,
      '',
      ...lines,
      '',
      'Nothing is executed. Files are written without execute permission.',
    ].join('\n');
    const action = conflicts.length ? 'Replace and Install' : 'Install';
    const choice = await vscode.window.showInformationMessage(
      `Install ${plans.length} skill${plans.length > 1 ? 's' : ''} into ${loc.label}?`,
      { modal: true, detail },
      action,
    );
    if (choice !== action) return;

    const results = await this.withBusy('install', () =>
      commitInstall(plans, conflicts.length > 0, { lock: this.service.lock, backupRoot: this.service.backupDir, inspection: this.inspection! }),
    );
    await cleanupStaging(this.staged);
    this.staged = [];
    await this.service.refresh();
    this.post({ type: 'installed', names: results.map((r) => r.name), locationLabel: loc.label });
    const first = results[0];
    vscode.window
      .showInformationMessage(`Installed ${results.map((r) => r.name).join(', ')} into ${loc.label}.`, 'Open SKILL.md')
      .then((c) => {
        if (c && first) vscode.window.showTextDocument(vscode.Uri.file(path.join(first.targetDir, 'SKILL.md')));
      });
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dashboard.css'));
    const icons = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'codicons', 'codicon.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${w.cspSource}`,
      `img-src ${w.cspSource} data:`,
      `font-src ${w.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${icons}">
<link rel="stylesheet" href="${css}">
<title>AI Skills</title>
</head>
<body>
<div id="app" role="application" aria-busy="true"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    void cleanupStaging(this.staged);
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
