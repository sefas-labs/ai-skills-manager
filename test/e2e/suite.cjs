// Runs inside the real extension host (see run.mjs). Writes a JSON report to
// $SKILLS_E2E_OUT; checks fail the run but every probe is still reported.
const vscode = require('vscode');
const fs = require('node:fs');
const https = require('node:https');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}

exports.run = async function run() {
  const report = { editor: `${vscode.env.appName} ${vscode.version}`, checks: [], ok: true };
  const check = (name, pass, info) => {
    report.checks.push({ name, pass: !!pass, ...(info !== undefined ? { info } : {}) });
    if (!pass) report.ok = false;
  };
  try {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'ai-skills-manager');
    check('extension found', ext);
    const api = await ext.activate();
    check('activates and returns internal api', api && api.service);

    const result = await vscode.commands.executeCommand('skillsManager.refresh');
    const e2e = result.skills.find((s) => s.name === 'e2e-skill');
    check('workspace skill discovered', e2e, e2e && e2e.visibleTo);
    check('workspace skill visible to cursor, codex, copilot', e2e && ['codex', 'copilot', 'cursor'].every((p) => e2e.visibleTo.includes(p)));
    const vis = (n) => result.skills.find((s) => s.name === n)?.visibleTo.slice().sort();
    check('monorepo: repo-root .claude/skills visible to Claude Code only', JSON.stringify(vis('repo-root-skill')) === '["claude-code"]', vis('repo-root-skill'));
    check('monorepo: nested .cursor/skills visible to Cursor', JSON.stringify(vis('nested-cursor-skill')) === '["cursor"]', vis('nested-cursor-skill'));
    report.realHome = {
      locations: result.locations.filter((l) => l.exists).map((l) => `${l.label} [${l.readers.join(',')}] ${l.skillCount}`),
      skills: result.skills.length,
      readOnly: result.skills.filter((s) => s.readOnly).length,
      withIssues: result.skills.filter((s) => s.issues.some((i) => i.severity !== 'info')).map((s) => `${s.name}: ${s.issues.map((i) => i.code).join(',')}`),
    };

    const declared = ext.packageJSON.contributes.commands.map((c) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    check('all declared commands registered', declared.every((c) => registered.has(c)), declared.filter((c) => !registered.has(c)));

    const scopes = api.tree.getChildren();
    check('tree has scope nodes', scopes.length > 0, scopes.map((s) => s.scope));
    const firstLoc = api.tree.getChildren(scopes[0])[0];
    const firstSkill = firstLoc && api.tree.getChildren(firstLoc)[0];
    check('tree renders a skill item', firstSkill && api.tree.getTreeItem(firstSkill).label);

    await vscode.commands.executeCommand('skillsManager.openDashboard');
    check('dashboard webview runs under CSP and sends ready', await waitFor(() => api.dashboardReady()));

    await vscode.commands.executeCommand('skillsManager.checkUpdates');
    const byName = (n) => api.service.current.skills.find((s) => s.name === n);
    const cur = byName('pdf-current');
    const stale = byName('pdf-stale');
    check('gh-skill provenance read from frontmatter', cur && cur.ghSource && cur.ghSource.subpath === 'skills/pdf');
    check('update check (real GitHub): current tree SHA is up to date', cur && api.service.updateFor(cur)?.status === 'up-to-date', cur && api.service.updateFor(cur));
    check('update check (real GitHub): old tree SHA has an update', stale && api.service.updateFor(stale)?.status === 'update-available', stale ? { u: api.service.updateFor(stale), src: stale.ghSource, issues: stale.issues } : 'missing');
    const staleItem = (() => {
      for (const sc of api.tree.getChildren()) for (const l of api.tree.getChildren(sc)) for (const n of api.tree.getChildren(l)) if (n.kind === 'skill' && n.skill.name === 'pdf-stale') return api.tree.getTreeItem(n);
    })();
    check('tree marks the skill with an update', staleItem && /\+update$/.test(staleItem.contextValue) && /update available/.test(staleItem.description), staleItem && staleItem.description);

    const ghAuth = vscode.extensions.getExtension('vscode.github-authentication');
    report.githubAuthExtension = !!ghAuth;
    try {
      const s = await vscode.authentication.getSession('github', ['read:user'], { silent: true });
      report.githubSilentSession = s ? 'session' : 'no session (provider available)';
    } catch (e) {
      report.githubSilentSession = `error: ${e.message}`;
    }

    // Proxy: global fetch (what the extension uses) vs Node's https module.
    report.proxySetting = vscode.workspace.getConfiguration('http').get('proxy');
    report.fetchAdditionalSupport = vscode.workspace.getConfiguration('http').get('fetchAdditionalSupport');
    try {
      const r = await fetch('https://api.github.com/zen', { headers: { 'User-Agent': 'ai-skills-manager-e2e' } });
      report.fetchStatus = r.status;
    } catch (e) {
      report.fetchStatus = `error: ${e.message}`;
    }
    report.httpsStatus = await new Promise((resolve) => {
      https
        .get('https://raw.githubusercontent.com/anthropics/skills/main/README.md', { headers: { 'User-Agent': 'ai-skills-manager-e2e' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', (e) => resolve(`error: ${e.message}`));
    });
  } catch (e) {
    check('no exception', false, String(e && e.stack ? e.stack : e));
  }
  fs.writeFileSync(process.env.SKILLS_E2E_OUT, JSON.stringify(report, null, 2));
  if (!report.ok) throw new Error('e2e checks failed');
};
