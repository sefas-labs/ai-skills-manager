import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discover } from '../../src/core/discovery';
import { ancestorsUpTo, findNestedSkillDirs, findRepoRoot } from '../../src/core/monorepo';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import type { DiscoveryContext } from '../../src/core/types';
import { skillMd, tempDir, writeSkill } from '../helpers/fsFixture';

// repo/                     ← .git, .claude/skills/root-skill, .agents/skills/codex-root
//   packages/
//     .claude/skills/mid    ← between the workspace folder and the repo root
//     app/                  ← workspace folder
//       .claude/skills/deploy
//       web/.claude/skills/deploy      (nested, same name)
//       web/.cursor/skills/web-only
//       node_modules/x/.claude/skills/ignored
async function monorepo() {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const app = path.join(repo, 'packages/app');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await writeSkill(path.join(repo, '.claude/skills'), 'root-skill');
  await writeSkill(path.join(repo, '.agents/skills'), 'codex-root');
  await writeSkill(path.join(repo, 'packages/.claude/skills'), 'mid');
  await writeSkill(path.join(app, '.claude/skills'), 'deploy', skillMd('deploy', 'App deploy.'));
  await writeSkill(path.join(app, 'web/.claude/skills'), 'deploy', skillMd('deploy', 'Web deploy.'));
  await writeSkill(path.join(app, 'web/.cursor/skills'), 'web-only');
  await writeSkill(path.join(app, 'node_modules/x/.claude/skills'), 'ignored');
  const ctx: DiscoveryContext = { homeDir: home, workspaceFolders: [app], platform: 'linux' };
  return { root, home, repo, app, ctx };
}

test('repo root detection, ancestors and bounded nested search', async () => {
  const { repo, app, root } = await monorepo();
  assert.equal(await findRepoRoot(app), repo);
  assert.equal(await findRepoRoot(root), undefined);
  assert.deepEqual(ancestorsUpTo(app, repo), [path.join(repo, 'packages'), repo]);
  assert.deepEqual(ancestorsUpTo(app, app), []);
  assert.deepEqual(ancestorsUpTo(repo, app), [], 'not an ancestor');
  assert.deepEqual(await findNestedSkillDirs(app), ['web']); // node_modules skipped, root itself excluded
});

test('a linked worktree (.git file) is its own root', async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, 'main/.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'main/wt/sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'main/wt/.git'), 'gitdir: ../.git/worktrees/wt\n');
  assert.equal(await findRepoRoot(path.join(root, 'main/wt/sub')), path.join(root, 'main/wt'));
});

test('parent folders follow each agent’s documented rules', async () => {
  const { ctx } = await monorepo();
  const r = await discover(ctx, BUILTIN_PROVIDERS, { monorepo: { parents: true, nested: true } });
  const vis = (name: string) => r.skills.find((s) => s.name === name)!.visibleTo.sort();
  assert.deepEqual(vis('root-skill'), ['claude-code']); // Claude: up to repo root; Cursor parents undocumented
  assert.deepEqual(vis('mid'), ['claude-code']);
  assert.deepEqual(vis('codex-root'), ['codex']);
  const parentLoc = r.locations.find((l) => l.label === '../../.claude/skills')!;
  assert.equal(parentLoc.origin, 'parent');
  assert.equal(parentLoc.scope, 'workspace');
  assert.equal(r.skills.some((s) => s.name === 'ignored'), false);
});

test('nested folders: Claude namespaces them (no clash), Cursor reads .cursor/.agents nested', async () => {
  const { ctx } = await monorepo();
  const r = await discover(ctx, BUILTIN_PROVIDERS, { monorepo: { parents: true, nested: true } });
  const webDeploy = r.skills.find((s) => s.description === 'Web deploy.')!;
  assert.deepEqual(webDeploy.visibleTo, ['claude-code']);
  const loc = r.locations.find((l) => l.id === webDeploy.locationId)!;
  assert.equal(loc.origin, 'nested');
  assert.equal(loc.appliesTo, 'web');
  assert.equal(loc.label, 'web/.claude/skills');
  assert.ok(!webDeploy.issues.some((i) => i.code === 'duplicate:claude-code'));
  assert.deepEqual(r.skills.find((s) => s.name === 'web-only')!.visibleTo, ['cursor']);
});

test('monorepo scanning is opt-in at the core level and Copilot parent repo needs its setting', async () => {
  const { ctx } = await monorepo();
  const plain = await discover(ctx, BUILTIN_PROVIDERS);
  assert.equal(plain.skills.some((s) => s.name === 'root-skill' || s.name === 'web-only'), false);
  const withCopilot = await discover({ ...ctx, copilotParentRepo: true }, BUILTIN_PROVIDERS, { monorepo: { parents: true, nested: false } });
  assert.deepEqual(withCopilot.skills.find((s) => s.name === 'root-skill')!.visibleTo.sort(), ['claude-code', 'copilot']);
  assert.deepEqual(withCopilot.skills.find((s) => s.name === 'codex-root')!.visibleTo.sort(), ['codex', 'copilot']);
});
