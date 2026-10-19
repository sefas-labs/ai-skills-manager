import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discover } from '../../src/core/discovery';
import { mergeSuggestions } from '../../src/core/merge';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import type { DiscoveryContext } from '../../src/core/types';
import { skillMd, tempDir, writeSkill } from '../helpers/fsFixture';

async function setup() {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(ws, { recursive: true });
  const ctx: DiscoveryContext = { homeDir: home, workspaceFolders: [ws], platform: 'linux' };
  const run = async (relevantAgents?: string[]) => {
    const r = await discover(ctx, BUILTIN_PROVIDERS);
    const byDir = (d: string) => r.skills.find((s) => s.dir === d)!.id;
    return { list: await mergeSuggestions(r.skills, r.locations, { relevantAgents }), byDir };
  };
  return { root, home, ws, run };
}

test('a copy whose agents are all covered by another is redundant', async () => {
  const { home, run } = await setup();
  // ~/.cursor/skills is read only by Cursor; ~/.agents/skills reaches Cursor too.
  await writeSkill(path.join(home, '.agents/skills'), 'pdf');
  await writeSkill(path.join(home, '.cursor/skills'), 'pdf');
  const { list, byDir } = await run();
  assert.equal(list.length, 1);
  const s = list[0];
  assert.equal(s.verdict, 'remove-redundant');
  assert.equal(s.identical, true);
  assert.deepEqual(s.seenTwiceBy, ['cursor']);
  assert.deepEqual(s.remove, [byDir(path.join(home, '.cursor/skills/pdf'))]);
  assert.deepEqual(s.stillTwiceBy, []);
});

test('.claude + .agents are both needed for Claude and Codex; differing content → unify', async () => {
  const { home, run } = await setup();
  await writeSkill(path.join(home, '.claude/skills'), 'deploy', skillMd('deploy', 'Version A.'));
  await writeSkill(path.join(home, '.agents/skills'), 'deploy', skillMd('deploy', 'Version B.'), { 'extra.md': 'x' });
  const { list } = await run();
  assert.equal(list[0].verdict, 'unify-versions');
  assert.equal(list[0].remove.length, 0);
  assert.deepEqual(list[0].seenTwiceBy, ['copilot', 'cursor']);
  const other = list[0].copies.find((c) => c.version === 1)!;
  assert.deepEqual([...other.diff!.added, ...other.diff!.removed], ['extra.md']);
  assert.deepEqual(other.diff!.modified, ['SKILL.md']);
});

test('only installed agents count: without Codex, the .agents copy is redundant', async () => {
  const { home, run } = await setup();
  await writeSkill(path.join(home, '.claude/skills'), 'deploy');
  await writeSkill(path.join(home, '.agents/skills'), 'deploy');
  const all = await run();
  assert.equal(all.list[0].verdict, 'expected');
  const noCodex = await run(['claude-code', 'cursor', 'copilot']);
  assert.equal(noCodex.list[0].verdict, 'remove-redundant');
  assert.deepEqual(noCodex.list[0].remove, [noCodex.byDir(path.join(home, '.agents/skills/deploy'))]);
});

test('read-only copies are kept, links to one folder are one copy, scopes are not mixed', async () => {
  const { root, home, ws, run } = await setup();
  await writeSkill(path.join(home, '.claude/skills/synced/acct'), 'web');
  await writeSkill(path.join(home, '.agents/skills'), 'web');
  const canonical = await writeSkill(path.join(root, 'canonical'), 'linked');
  await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true });
  await fs.symlink(canonical, path.join(home, '.claude/skills/linked'));
  await fs.mkdir(path.join(home, '.cursor/skills'), { recursive: true });
  await fs.symlink(canonical, path.join(home, '.cursor/skills/linked'));
  await writeSkill(path.join(ws, '.agents/skills'), 'cross');
  await writeSkill(path.join(home, '.agents/skills'), 'cross');
  const { list } = await run();
  const web = list.find((s) => s.name === 'web');
  assert.ok(!web || web.keep.includes(web.copies.find((c) => !c.writable)!.skillId), 'synced copy is never removed');
  assert.equal(list.some((s) => s.name === 'linked'), false);
  assert.equal(list.some((s) => s.name === 'cross'), false);
});
