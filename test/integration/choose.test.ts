import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { planChoose, removeOthers, syncToChosen } from '../../src/core/choose';
import { discover } from '../../src/core/discovery';
import { LockStore } from '../../src/core/lockfile';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import type { DiscoveryContext } from '../../src/core/types';
import { skillMd, tempDir, writeSkill } from '../helpers/fsFixture';

async function env() {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(ws, { recursive: true });
  const ctx: DiscoveryContext = { homeDir: home, workspaceFolders: [ws], platform: 'linux' };
  const lock = new LockStore(path.join(root, 'lock.json'));
  await lock.load();
  const scan = () => discover(ctx, BUILTIN_PROVIDERS, { lock });
  const deps = async () => ({ lock, backupRoot: path.join(root, 'backups'), stagingRoot: path.join(root, 'staging'), skills: (await scan()).skills });
  return { root, home, ws, scan, deps };
}

test('global ~/.claude copy + project .agents copy (the senior-dev-checklist case)', async () => {
  const { home, ws, scan, deps } = await env();
  await writeSkill(path.join(home, '.claude/skills'), 'checklist', skillMd('checklist', 'Global version.'));
  await writeSkill(path.join(ws, '.agents/skills'), 'checklist', skillMd('checklist', 'Project version.'), { 'extra.md': 'x' });
  let r = await scan();
  const project = r.skills.find((s) => s.scope === 'workspace')!;
  let plan = planChoose(project, r.skills, r.locations);
  assert.equal(plan.others.length, 1);
  assert.equal(plan.others[0].identical, false);
  assert.deepEqual(plan.loseIfRemoved, ['claude-code'], 'Claude Code only reads the global copy');

  // Use the project version everywhere: the global copy becomes identical, nobody loses it.
  const synced = await syncToChosen(plan, await deps());
  assert.deepEqual(synced, [path.join(home, '.claude/skills/checklist')]);
  assert.match(await fs.readFile(path.join(home, '.claude/skills/checklist/SKILL.md'), 'utf8'), /Project version/);
  await fs.access(path.join(home, '.claude/skills/checklist/extra.md'));
  r = await scan();
  const issues = r.skills.filter((s) => s.name === 'checklist').flatMap((s) => s.issues.map((i) => i.code));
  assert.ok(issues.includes('identical-copies') && !issues.some((c) => c.startsWith('duplicate:')), 'no longer a conflict');
  plan = planChoose(r.skills.find((s) => s.scope === 'workspace')!, r.skills, r.locations);
  assert.equal(plan.others[0].identical, true);
});

test('remove the others: only writable copies go to the backup; read-only ones stay', async () => {
  const { home, ws, scan, deps } = await env();
  await writeSkill(path.join(home, '.claude/skills'), 'tool', skillMd('tool', 'A'));
  await writeSkill(path.join(home, '.cursor/skills'), 'tool', skillMd('tool', 'B'));
  await writeSkill(path.join(home, '.claude/skills/synced/acct'), 'tool', skillMd('tool', 'C'));
  await writeSkill(path.join(ws, '.agents/skills'), 'tool', skillMd('tool', 'D'));
  const r = await scan();
  const chosen = r.skills.find((s) => s.dir === path.join(ws, '.agents/skills/tool'))!;
  const plan = planChoose(chosen, r.skills, r.locations);
  assert.equal(plan.others.length, 3);
  assert.ok(plan.others.find((o) => o.skill.managed)!.blocked);
  assert.deepEqual(plan.loseIfRemoved, [], 'the synced copy keeps Claude Code covered');
  const removed = await removeOthers(plan, await deps());
  assert.equal(removed.length, 2);
  await assert.rejects(fs.access(path.join(home, '.cursor/skills/tool')));
  await fs.access(path.join(home, '.claude/skills/synced/acct/tool/SKILL.md'));
  await fs.access(path.join(ws, '.agents/skills/tool/SKILL.md'));
});

test('a copy with a different folder name is not overwritten', async () => {
  const { home, ws, scan, deps } = await env();
  await writeSkill(path.join(home, '.claude/skills'), 'other-folder', skillMd('tool', 'A'));
  await writeSkill(path.join(ws, '.agents/skills'), 'tool', skillMd('tool', 'B'));
  const r = await scan();
  const plan = planChoose(r.skills.find((s) => s.scope === 'workspace')!, r.skills, r.locations);
  assert.match(plan.others[0].blocked ?? '', /folder is named/);
  assert.deepEqual(await syncToChosen(plan, await deps()), []);
});
