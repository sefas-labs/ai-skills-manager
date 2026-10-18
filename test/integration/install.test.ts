import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discover, resolveLocations } from '../../src/core/discovery';
import { GitHubClient, parseGitHubUrl } from '../../src/core/github';
import { commitInstall, inspectRepository, planInstall, stageCandidates, uninstallSkill } from '../../src/core/installer';
import { LockStore } from '../../src/core/lockfile';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import type { DiscoveryContext, ResolvedLocation } from '../../src/core/types';
import { FakeGitHub, FakeRepo } from '../helpers/fakeGitHub';
import { skillMd, tempDir, writeSkill } from '../helpers/fsFixture';

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);

function fakeRepos(): Record<string, FakeRepo> {
  return {
    'acme/skills': {
      defaultBranch: 'main',
      refs: { main: C1, 'feature/x': C2 },
      commits: {
        [C1]: {
          'README.md': '# Acme skills',
          'skills/alpha/SKILL.md': skillMd('alpha'),
          'skills/alpha/scripts/run.py': 'print("hi")\n',
          'skills/alpha/references/REF.md': 'More docs.',
          'skills/alpha/link-out': { symlink: '../../../etc/passwd' },
          'skills/alpha/vendor': { submodule: true as const },
          'skills/beta/SKILL.md': skillMd('beta', 'Beta skill.', '') + '\nNote:‮hidden‬ text\n',
          'skills/gamma/SKILL.md': skillMd('gamma'),
          'skills/gamma/nested/SKILL.md': skillMd('nested'),
          'skills/Bad Name/SKILL.md': skillMd('Bad Name'),
          'node_modules/junk/SKILL.md': skillMd('junk'),
        },
        [C2]: {
          'skills/alpha/SKILL.md': skillMd('alpha', 'Alpha from feature branch.'),
        },
      },
    },
    'acme/mcp-server': {
      defaultBranch: 'main',
      refs: { main: C1 },
      commits: { [C1]: { 'package.json': '{}', 'src/index.ts': '' } },
    },
    'acme/plugin': {
      defaultBranch: 'main',
      refs: { main: C1 },
      commits: { [C1]: { '.claude-plugin/plugin.json': '{}' } },
    },
    'acme/private': {
      defaultBranch: 'main',
      refs: { main: C1 },
      private: true,
      commits: { [C1]: { 'SKILL.md': skillMd('private') } },
    },
  };
}

async function env() {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const storage = path.join(root, 'storage');
  await fs.mkdir(home, { recursive: true });
  const ctx: DiscoveryContext = { homeDir: home, workspaceFolders: [], platform: 'linux' };
  const locations = resolveLocations(ctx, BUILTIN_PROVIDERS);
  const loc = (rel: string) => locations.find((l) => l.path === path.join(home, rel)) as ResolvedLocation;
  const lock = new LockStore(path.join(storage, 'skills-lock.json'));
  await lock.load();
  return { root, home, storage, ctx, loc, lock };
}

test('repo inspection finds outermost skills, ignores node_modules, skips symlinks/submodules', async () => {
  const gh = new FakeGitHub(fakeRepos());
  const client = new GitHubClient({ fetch: gh.fetch });
  const insp = await inspectRepository(client, parseGitHubUrl('https://github.com/acme/skills'));
  assert.equal(insp.ref, 'main');
  assert.equal(insp.commit, C1);
  const names = insp.candidates.map((c) => c.installName).sort();
  assert.deepEqual(names, ['alpha', 'bad-name', 'beta', 'gamma']); // nested + node_modules excluded
  const alpha = insp.candidates.find((c) => c.installName === 'alpha')!;
  assert.deepEqual(alpha.files.map((f) => f.path).sort(), ['SKILL.md', 'references/REF.md', 'scripts/run.py']);
  assert.deepEqual(alpha.skipped.map((s) => s.path).sort(), ['link-out', 'vendor']);
  assert.ok(alpha.findings.some((f) => f.code === 'contains-code'));
  const beta = insp.candidates.find((c) => c.installName === 'beta')!;
  assert.ok(beta.findings.some((f) => f.code === 'hidden-unicode' && f.severity === 'high'));
  const gamma = insp.candidates.find((c) => c.installName === 'gamma')!;
  assert.ok(gamma.files.some((f) => f.path === 'nested/SKILL.md'));
  const bad = insp.candidates.find((c) => c.installName === 'bad-name')!;
  assert.ok(bad.issues.some((i) => i.code === 'name-format'));
});

test('folder URL on a branch with a slash resolves ref and subpath', async () => {
  const gh = new FakeGitHub(fakeRepos());
  const client = new GitHubClient({ fetch: gh.fetch });
  const insp = await inspectRepository(client, parseGitHubUrl('https://github.com/acme/skills/tree/feature/x/skills/alpha'));
  assert.equal(insp.ref, 'feature/x');
  assert.equal(insp.subpath, 'skills/alpha');
  assert.equal(insp.candidates.length, 1);
  assert.equal(insp.candidates[0].description, 'Alpha from feature branch.');
});

test('non-skill repositories are rejected with a helpful hint', async () => {
  const client = new GitHubClient({ fetch: new FakeGitHub(fakeRepos()).fetch });
  await assert.rejects(inspectRepository(client, parseGitHubUrl('acme/mcp-server')), /not an Agent Skills repository.*MCP server/);
  await assert.rejects(inspectRepository(client, parseGitHubUrl('acme/plugin')), /Claude Code plugin/);
  await assert.rejects(inspectRepository(client, parseGitHubUrl('acme/skills/tree/main/nope'.replace('acme/skills', 'https://github.com/acme/skills'))), /does not exist/);
});

test('private repos need a token; token is only sent to GitHub hosts', async () => {
  const gh = new FakeGitHub(fakeRepos(), 'secret-token');
  await assert.rejects(inspectRepository(new GitHubClient({ fetch: gh.fetch }), parseGitHubUrl('acme/private')), /sign in/i);
  const insp = await inspectRepository(new GitHubClient({ fetch: gh.fetch, token: 'secret-token' }), parseGitHubUrl('acme/private'));
  assert.equal(insp.candidates[0].installName, 'private');
  for (const c of gh.calls) {
    if (c.auth) assert.match(new URL(c.url).hostname, /^(api\.github\.com|raw\.githubusercontent\.com)$/);
  }
});

test('rate limit produces an actionable error', async () => {
  const gh = new FakeGitHub(fakeRepos());
  gh.rateLimited = true;
  await assert.rejects(inspectRepository(new GitHubClient({ fetch: gh.fetch }), parseGitHubUrl('acme/skills')), /rate limit.*Sign in/);
});

test('full flow: stage → install → discovered with provenance → conflict → replace with backup → uninstall', async () => {
  const { home, storage, ctx, loc, lock } = await env();
  const client = new GitHubClient({ fetch: new FakeGitHub(fakeRepos()).fetch });
  const insp = await inspectRepository(client, parseGitHubUrl('https://github.com/acme/skills'));
  const ids = insp.candidates.filter((c) => ['alpha', 'beta'].includes(c.installName)).map((c) => c.id);

  const staged = await stageCandidates(client, insp, ids, path.join(storage, 'staging'));
  assert.equal(staged.length, 2);
  assert.ok(staged.find((s) => s.candidate.installName === 'beta')!.findings.some((f) => f.code === 'hidden-unicode'));

  const target = loc('.agents/skills');
  const plans = await planInstall(staged, target);
  assert.ok(plans.every((p) => !p.exists));
  await commitInstall(plans, false, { lock, backupRoot: path.join(storage, 'backups'), inspection: insp });

  const alphaDir = path.join(home, '.agents/skills/alpha');
  assert.equal(await fs.readFile(path.join(alphaDir, 'scripts/run.py'), 'utf8'), 'print("hi")\n');
  const mode = (await fs.stat(path.join(alphaDir, 'scripts/run.py'))).mode & 0o111;
  assert.equal(mode, 0, 'installed files must not be executable');
  await assert.rejects(fs.lstat(path.join(alphaDir, 'link-out')), 'symlinks from the repo are never created');

  const r = await discover(ctx, BUILTIN_PROVIDERS, { lock });
  const alpha = r.skills.find((s) => s.name === 'alpha')!;
  assert.deepEqual(alpha.visibleTo.sort(), ['codex', 'copilot', 'cursor']);
  assert.equal(alpha.source?.source.commit, C1);
  assert.equal(alpha.source?.source.subpath, 'skills/alpha');

  // Re-install without consent → refused.
  const alphaId = insp.candidates.find((c) => c.installName === 'alpha')!.id;
  const staged2 = await stageCandidates(client, insp, [alphaId], path.join(storage, 'staging'));
  const plans2 = await planInstall(staged2, target);
  assert.equal(plans2[0].exists, true);
  await assert.rejects(commitInstall(plans2, false, { lock, backupRoot: path.join(storage, 'backups'), inspection: insp }), /Already installed/);

  // Local edit, then replace with consent → previous version backed up.
  await fs.writeFile(path.join(alphaDir, 'LOCAL.md'), 'my edit');
  const res = await commitInstall(plans2, true, { lock, backupRoot: path.join(storage, 'backups'), inspection: insp });
  assert.ok(res[0].backupDir);
  assert.equal(await fs.readFile(path.join(res[0].backupDir!, 'LOCAL.md'), 'utf8'), 'my edit');
  await assert.rejects(fs.access(path.join(alphaDir, 'LOCAL.md')));

  // Uninstall moves to trash (recoverable) and clears provenance.
  const r2 = await discover(ctx, BUILTIN_PROVIDERS, { lock });
  const a2 = r2.skills.find((s) => s.name === 'alpha')!;
  const out = await uninstallSkill(a2, r2.locations.find((l) => l.id === a2.locationId)!, { lock, trashRoot: path.join(storage, 'trash') });
  assert.equal(out.kind, 'moved');
  await assert.rejects(fs.access(alphaDir));
  await fs.access(path.join(out.backupDir!, 'SKILL.md'));
  assert.equal(lock.get(alphaDir), undefined);
});

test('failed install rolls back to the previous version', async () => {
  const { home, storage, loc, lock } = await env();
  const existing = await writeSkill(path.join(home, '.claude/skills'), 'alpha', skillMd('alpha', 'Original local version.'));
  const client = new GitHubClient({ fetch: new FakeGitHub(fakeRepos()).fetch });
  const insp = await inspectRepository(client, parseGitHubUrl('https://github.com/acme/skills/tree/main/skills/alpha'));
  const staged = await stageCandidates(client, insp, [insp.candidates[0].id], path.join(storage, 'staging'));
  const plans = await planInstall(staged, loc('.claude/skills'));
  await assert.rejects(
    commitInstall(plans, true, { lock, backupRoot: path.join(storage, 'backups'), inspection: insp, _failAfterBackup: true }),
    /rolled back/,
  );
  assert.match(await fs.readFile(path.join(existing, 'SKILL.md'), 'utf8'), /Original local version/);
});

test('uninstalling a symlinked skill removes only the link', async () => {
  const { root, home, ctx, lock, storage } = await env();
  const canonical = await writeSkill(path.join(root, 'canonical'), 'shared');
  await fs.mkdir(path.join(home, '.cursor/skills'), { recursive: true });
  await fs.symlink(canonical, path.join(home, '.cursor/skills/shared'));
  const r = await discover(ctx, BUILTIN_PROVIDERS, { lock });
  const s = r.skills.find((x) => x.name === 'shared')!;
  assert.equal(s.isSymlink, true);
  const out = await uninstallSkill(s, r.locations.find((l) => l.id === s.locationId)!, { lock, trashRoot: path.join(storage, 'trash') });
  assert.equal(out.kind, 'unlinked');
  await fs.access(path.join(canonical, 'SKILL.md')); // target untouched
  await assert.rejects(fs.lstat(path.join(home, '.cursor/skills/shared')));
});

test('read-only locations refuse install and uninstall', async () => {
  const { home, ctx, lock, storage } = await env();
  await writeSkill(path.join(home, '.claude/skills/synced'), 'web');
  const r = await discover(ctx, BUILTIN_PROVIDERS, { lock });
  const s = r.skills.find((x) => x.name === 'web')!;
  await assert.rejects(uninstallSkill(s, r.locations.find((l) => l.id === s.locationId)!, { lock, trashRoot: path.join(storage, 'trash') }), /read-only/);
  const admin = r.locations.find((l) => l.scope === 'admin')!;
  await assert.rejects(planInstall([], admin), /read-only/);
});
