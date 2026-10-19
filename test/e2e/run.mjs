// Runs test/e2e/suite.cjs inside a real VS Code-compatible editor (VS Code,
// Cursor…) with a throw-away profile, plus a local CONNECT proxy to check
// whether GitHub downloads honour `http.proxy`.
//
//   npm run build && node test/e2e/run.mjs [path-to-editor-binary]
//
// Default binary: VS Code on macOS. The suite only *reads* the real home folder
// (it scans the real skill folders); installs go to a temporary HOME-less
// location inside the profile.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const bin = process.argv[2] ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
if (!fs.existsSync(path.join(root, 'dist/extension.js'))) {
  console.error('Run `npm run build` first.');
  process.exit(1);
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-e2e-')));
const userData = path.join(tmp, 'user-data');
// The workspace is a sub-folder of a git repository (monorepo layout).
const repo = path.join(tmp, 'repo');
const workspace = path.join(repo, 'packages/app');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
for (const [dir, name] of [
  [path.join(repo, '.claude/skills'), 'repo-root-skill'],
  [path.join(workspace, 'web/.cursor/skills'), 'nested-cursor-skill'],
]) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Monorepo e2e skill.\n---\n`);
}
fs.mkdirSync(path.join(workspace, '.agents/skills/e2e-skill'), { recursive: true });
fs.writeFileSync(
  path.join(workspace, '.agents/skills/e2e-skill/SKILL.md'),
  '---\nname: e2e-skill\ndescription: Workspace skill used by the end-to-end test.\n---\nBody.\n',
);

// Two skills with `gh skill` provenance pointing at the real anthropics/skills
// repo: one at the current tree SHA of skills/pdf, one at a made-up old one.
const ghSkill = (name, treeSha) => {
  fs.mkdirSync(path.join(workspace, '.agents/skills', name), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.agents/skills', name, 'SKILL.md'),
    `---\ndescription: e2e update check.\nmetadata:\n    github-path: skills/pdf\n    github-ref: refs/heads/main\n    github-repo: https://github.com/anthropics/skills\n    github-tree-sha: ${treeSha}\nname: ${name}\n---\n`,
  );
};
const head = await fetch('https://api.github.com/repos/anthropics/skills/commits/main', { headers: { 'User-Agent': 'ai-skills-manager-e2e' } }).then((r) => r.json());
const tree = await fetch(`https://api.github.com/repos/anthropics/skills/git/trees/${head.sha}?recursive=1`, { headers: { 'User-Agent': 'ai-skills-manager-e2e' } }).then((r) => r.json());
ghSkill('pdf-current', tree.tree.find((e) => e.path === 'skills/pdf').sha);
ghSkill('pdf-stale', '0'.repeat(40));
// The same skill in .agents/skills and .cursor/skills: the Cursor-only copy is redundant.
fs.mkdirSync(path.join(workspace, '.cursor/skills/e2e-skill'), { recursive: true });
fs.copyFileSync(path.join(workspace, '.agents/skills/e2e-skill/SKILL.md'), path.join(workspace, '.cursor/skills/e2e-skill/SKILL.md'));
// A skill whose `name` doesn't match its folder (fixable).
fs.mkdirSync(path.join(workspace, '.agents/skills/needs-fix'), { recursive: true });
fs.writeFileSync(path.join(workspace, '.agents/skills/needs-fix/SKILL.md'), '---\nname: Wrong Name\ndescription: Fix me.\n---\n');

// Minimal CONNECT proxy that records which hosts went through it.
const proxied = [];
const proxy = net.createServer((client) => {
  client.once('data', (buf) => {
    const m = /^CONNECT ([^:\s]+):(\d+)/.exec(buf.toString('latin1'));
    if (!m) return client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
    proxied.push(m[1]);
    const upstream = net.connect(Number(m[2]), m[1], () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
fs.writeFileSync(
  path.join(userData, 'User/settings.json'),
  JSON.stringify({ 'http.proxy': proxyUrl, 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off' }, null, 2),
);

const out = path.join(tmp, 'result.json');
const env = { ...process.env, SKILLS_E2E_OUT: out, SKILLS_E2E_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;
delete env.http_proxy;
delete env.https_proxy;

const args = [
  workspace,
  `--user-data-dir=${userData}`,
  `--extensions-dir=${path.join(tmp, 'extensions')}`,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(root, 'test/e2e/suite.cjs')}`,
  '--disable-extensions',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-telemetry',
  '--new-window',
];
console.log(`[e2e] ${bin}\n[e2e] profile ${tmp}\n[e2e] proxy ${proxyUrl}`);
const child = spawn(bin, args, { env, stdio: 'inherit' });
const timer = setTimeout(() => {
  console.error('[e2e] timeout');
  child.kill();
}, 120_000);
const code = await new Promise((r) => child.on('exit', r));
clearTimeout(timer);
proxy.close();

let result;
try {
  result = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {
  console.error(`[e2e] no result written (exit ${code})`);
  process.exit(1);
}
result.proxyConnects = [...new Set(proxied)];
console.log(JSON.stringify(result, null, 2));
const passed = code === 0 && result.ok;
// Keep the profile for debugging only when something failed.
if (passed) fs.rmSync(tmp, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
