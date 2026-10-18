import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discover, resolveLocations } from '../../src/core/discovery';
import { GitHubClient, parseGitHubUrl } from '../../src/core/github';
import { commitInstall, inspectRepository, planInstall, stageCandidates } from '../../src/core/installer';
import { LockStore } from '../../src/core/lockfile';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import { checkUpdates, prepareUpdate, trackedFromLock } from '../../src/core/updates';
import type { DiscoveryContext, ResolvedLocation } from '../../src/core/types';
import { FakeGitHub, FakeRepo } from '../helpers/fakeGitHub';
import { skillMd, tempDir } from '../helpers/fsFixture';

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);

function repos(): Record<string, FakeRepo> {
  return {
    'acme/skills': {
      defaultBranch: 'main',
      refs: { main: C1 },
      commits: {
        [C1]: {
          'skills/alpha/SKILL.md': skillMd('alpha'),
          'skills/alpha/ref.md': 'v1',
          'skills/alpha/old.md': 'to be removed',
          'skills/beta/SKILL.md': skillMd('beta'),
        },
        [C2]: {
          'skills/alpha/SKILL.md': skillMd('alpha', 'Alpha v2.'),
          'skills/alpha/ref.md': 'v1',
          'skills/alpha/new.md': 'added',
          'skills/beta/SKILL.md': skillMd('beta'),
        },
      },
    },
    'acme/single': {
      defaultBranch: 'main',
      refs: { main: C1 },
      commits: { [C1]: { 'SKILL.md': skillMd('single') } },
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
  const loc = locations.find((l) => l.path === path.join(home, '.agents/skills')) as ResolvedLocation;
  const lock = new LockStore(path.join(storage, 'lock.json'));
  await lock.load();
  const gh = new FakeGitHub(repos());
  const client = new GitHubClient({ fetch: gh.fetch });
  const install = async (url: string, names?: string[]) => {
    const insp = await inspectRepository(client, parseGitHubUrl(url));
    const ids = insp.candidates.filter((c) => !names || names.includes(c.installName)).map((c) => c.id);
    const staged = await stageCandidates(client, insp, ids, path.join(storage, 'staging'));
    await commitInstall(await planInstall(staged, loc), false, { lock, backupRoot: path.join(storage, 'backups'), inspection: insp });
  };
  return { home, storage, ctx, loc, lock, gh, client, install };
}

test('root-of-repo installs record a tree SHA (needed for updates)', async () => {
  const { home, lock, install } = await env();
  await install('acme/single');
  assert.match(lock.get(path.join(home, '.agents/skills/single'))!.source.treeSha ?? '', /^[0-9a-f]{40}$/);
});

test('check: only the changed sub-folder reports an update; 2 API calls per repo+ref; pinned costs nothing', async () => {
  const { home, lock, gh, client, install } = await env();
  await install('https://github.com/acme/skills', ['alpha', 'beta']);
  const items = lock.all().map((e) => ({ key: e.dir, source: trackedFromLock(e) }));
  items.push({ key: 'pinned', source: { ...items[0].source, ref: C1, pinned: true } });

  let r = await checkUpdates(client, items);
  assert.equal(r[path.join(home, '.agents/skills/alpha')].status, 'up-to-date');
  assert.equal(r['pinned'].status, 'pinned');

  gh.repos['acme/skills'].refs.main = C2;
  const before = gh.calls.length;
  r = await checkUpdates(client, items);
  assert.equal(gh.calls.length - before, 2, 'one commit lookup + one tree for both skills');
  assert.equal(r[path.join(home, '.agents/skills/alpha')].status, 'update-available');
  assert.equal(r[path.join(home, '.agents/skills/alpha')].remoteCommit, C2);
  assert.equal(r[path.join(home, '.agents/skills/beta')].status, 'up-to-date');

  delete gh.repos['acme/skills'].refs.main;
  r = await checkUpdates(client, items);
  assert.equal(r[path.join(home, '.agents/skills/alpha')].status, 'ref-missing');
});

test('check stops on rate limit and reports it for the rest', async () => {
  const { lock, gh, client, install } = await env();
  await install('https://github.com/acme/skills', ['alpha']);
  await install('acme/single');
  gh.rateLimited = true;
  const r = await checkUpdates(client, lock.all().map((e) => ({ key: e.dir, source: trackedFromLock(e) })));
  const all = Object.values(r);
  assert.equal(all.length, 2);
  assert.ok(all.every((c) => c.status === 'error' && /rate limit/.test(c.message ?? '')));
  assert.equal(gh.calls.length > 0, true);
});

test('prepare + apply update: file diff, local edits detected, backup kept, lock moves to the new commit', async () => {
  const { home, storage, ctx, loc, lock, gh, client, install } = await env();
  await install('https://github.com/acme/skills', ['alpha']);
  const dir = path.join(home, '.agents/skills/alpha');
  await fs.writeFile(path.join(dir, 'ref.md'), 'my local edit');
  gh.repos['acme/skills'].refs.main = C2;

  const p = await prepareUpdate(client, { source: trackedFromLock(lock.get(dir)!), skillDir: dir, stagingRoot: path.join(storage, 'staging') });
  assert.equal(p.toCommit, C2);
  assert.equal(p.upstreamBase, 'installed');
  assert.deepEqual(p.upstream, { added: ['new.md'], modified: ['SKILL.md'], removed: ['old.md'] });
  assert.deepEqual(p.local, { added: [], modified: ['ref.md'], removed: [] });
  // Nothing written outside staging yet.
  assert.equal(await fs.readFile(path.join(dir, 'ref.md'), 'utf8'), 'my local edit');

  const plans = await planInstall([p.staged], loc);
  assert.equal(plans[0].targetDir, dir);
  const [res] = await commitInstall(plans, true, { lock, backupRoot: path.join(storage, 'backups'), inspection: p.inspection });
  assert.equal(await fs.readFile(path.join(res.backupDir!, 'ref.md'), 'utf8'), 'my local edit');
  await fs.access(path.join(dir, 'new.md'));
  await assert.rejects(fs.access(path.join(dir, 'old.md')));
  assert.equal(lock.get(dir)!.source.commit, C2);
  assert.equal(lock.get(dir)!.source.ref, 'main');

  const r = await checkUpdates(client, [{ key: dir, source: trackedFromLock(lock.get(dir)!) }]);
  assert.equal(r[dir].status, 'up-to-date');
  const d = await discover(ctx, BUILTIN_PROVIDERS, { lock });
  assert.equal(d.skills.find((s) => s.name === 'alpha')!.description, 'Alpha v2.');
});

test('a skill installed by `gh skill` can be checked and updated from its frontmatter metadata', async () => {
  const { home, storage, ctx, loc, lock, gh, client } = await env();
  // Recreate what gh writes: upstream files + metadata injected into SKILL.md.
  const tree = (await client.tree('acme', 'skills', C1)).entries;
  const alphaTree = tree.find((e) => e.path === 'skills/alpha')!.sha;
  const dir = path.join(home, '.claude/skills/alpha');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\ndescription: Does alpha things. Use when testing.\nmetadata:\n    github-path: skills/alpha\n    github-ref: refs/heads/main\n    github-repo: https://github.com/acme/skills\n    github-tree-sha: ${alphaTree}\nname: alpha\n---\n\n# alpha\n\nInstructions.\n`,
  );
  await fs.writeFile(path.join(dir, 'ref.md'), 'v1');
  await fs.writeFile(path.join(dir, 'old.md'), 'to be removed');

  const d = await discover(ctx, BUILTIN_PROVIDERS, { lock });
  const s = d.skills.find((x) => x.name === 'alpha')!;
  assert.equal(s.ghSource?.origin, 'gh-skill');
  assert.match(s.sourceHint ?? '', /^gh skill — acme\/skills\/skills\/alpha @ main/);

  gh.repos['acme/skills'].refs.main = C2;
  const r = await checkUpdates(client, [{ key: dir, source: s.ghSource! }]);
  assert.equal(r[dir].status, 'update-available');

  const p = await prepareUpdate(client, { source: s.ghSource!, skillDir: dir, stagingRoot: path.join(storage, 'staging') });
  assert.deepEqual(p.local, { added: [], modified: [], removed: [] }, 'gh-rewritten SKILL.md is not a local edit');
  assert.deepEqual(p.upstream.added, ['new.md']);
  assert.ok(p.notes.some((n) => /gh skill/.test(n)));

  const claudeLoc = d.locations.find((l) => l.path === path.join(home, '.claude/skills'))!;
  await commitInstall(await planInstall([p.staged], claudeLoc), true, { lock, backupRoot: path.join(storage, 'backups'), inspection: p.inspection });
  assert.equal(lock.get(dir)!.source.commit, C2, 'extension takes over tracking');
  void loc;
});
