import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discover } from '../../src/core/discovery';
import { LockStore } from '../../src/core/lockfile';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import { executeTransfer, moveBlocker, planTransfer } from '../../src/core/transfer';
import type { DiscoveryContext, LockEntry } from '../../src/core/types';
import { skillMd, tempDir, writeSkill } from '../helpers/fsFixture';

async function env() {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const ws = path.join(root, 'project');
  const storage = path.join(root, 'storage');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(ws, { recursive: true });
  const ctx: DiscoveryContext = { homeDir: home, workspaceFolders: [ws], platform: 'linux' };
  const lock = new LockStore(path.join(storage, 'lock.json'));
  await lock.load();
  const scan = () => discover(ctx, BUILTIN_PROVIDERS, { lock });
  const deps = { lock, backupRoot: path.join(storage, 'backups'), stagingRoot: path.join(storage, 'staging') };
  return { root, home, ws, ctx, lock, scan, deps };
}

test('copy ~/.claude/skills → workspace .agents/skills: visibility diff, no exec bits, lock follows, source untouched', async () => {
  const { home, ws, lock, scan, deps } = await env();
  const src = await writeSkill(path.join(home, '.claude/skills'), 'deploy', skillMd('deploy'), { 'scripts/run.sh': 'echo hi\n' });
  await fs.chmod(path.join(src, 'scripts/run.sh'), 0o755);
  await fs.symlink('/etc/hosts', path.join(src, 'hosts-link'));
  const entry: LockEntry = {
    name: 'deploy',
    dir: src,
    locationPath: path.dirname(src),
    installedAt: '2026-01-01T00:00:00Z',
    contentHash: 'h',
    fileCount: 2,
    source: { type: 'github', owner: 'o', repo: 'r', ref: 'main', commit: 'c'.repeat(40), subpath: 'deploy', url: 'u' },
  };
  await lock.set(entry);

  const r = await scan();
  const s = r.skills.find((x) => x.name === 'deploy')!;
  const from = r.locations.find((l) => l.id === s.locationId)!;
  const to = r.locations.find((l) => l.path === path.join(ws, '.agents/skills'))!;
  const plan = await planTransfer(s, from, to, 'copy', r.skills);
  assert.deepEqual(plan.gained.sort(), ['codex']); // cursor + copilot already saw it via ~/.claude/skills
  assert.deepEqual(plan.lost, []);
  assert.ok(plan.files.find((f) => f.path === 'scripts/run.sh')!.executable);
  assert.deepEqual(plan.skipped.map((x) => x.path), ['hosts-link']);

  const res = await executeTransfer(plan, false, deps);
  const copied = path.join(ws, '.agents/skills/deploy');
  assert.equal(res.targetDir, copied);
  assert.equal((await fs.stat(path.join(copied, 'scripts/run.sh'))).mode & 0o111, 0);
  await assert.rejects(fs.lstat(path.join(copied, 'hosts-link')));
  await fs.access(path.join(src, 'SKILL.md'));
  assert.equal(lock.get(copied)!.source.commit, 'c'.repeat(40));
  assert.ok(lock.get(src), 'copy keeps the original entry');
  assert.deepEqual(await fs.readdir(deps.stagingRoot).catch(() => []), [], 'staging is cleaned up');
});

test('move global → workspace: original goes to backup, agents that lose it are listed, lock entry moves', async () => {
  const { home, ws, lock, scan, deps } = await env();
  const src = await writeSkill(path.join(home, '.agents/skills'), 'lint');
  await lock.set({
    name: 'lint',
    dir: src,
    locationPath: path.dirname(src),
    installedAt: '',
    contentHash: '',
    fileCount: 1,
    source: { type: 'github', owner: 'o', repo: 'r', ref: 'main', commit: 'd'.repeat(40), subpath: '', url: '' },
  });
  const r = await scan();
  const s = r.skills.find((x) => x.name === 'lint')!;
  const from = r.locations.find((l) => l.id === s.locationId)!;
  const to = r.locations.find((l) => l.path === path.join(ws, '.claude/skills'))!;
  const plan = await planTransfer(s, from, to, 'move', r.skills);
  assert.deepEqual(plan.gained, ['claude-code']);
  assert.deepEqual(plan.lost, ['codex']);
  const res = await executeTransfer(plan, false, deps);
  await assert.rejects(fs.access(src));
  await fs.access(path.join(res.sourceBackupDir!, 'SKILL.md'));
  assert.equal(lock.get(src), undefined);
  assert.equal(lock.get(path.join(ws, '.claude/skills/lint'))!.source.commit, 'd'.repeat(40));
});

test('destination conflicts need consent and keep a backup; duplicates are reported', async () => {
  const { home, ws, scan, deps } = await env();
  await writeSkill(path.join(home, '.claude/skills'), 'pdf', skillMd('pdf', 'Global version.'));
  await writeSkill(path.join(ws, '.claude/skills'), 'pdf', skillMd('pdf', 'Project version.'));
  await writeSkill(path.join(home, '.cursor/skills'), 'pdf', skillMd('pdf', 'Cursor version.'));
  const r = await scan();
  const s = r.skills.find((x) => x.description === 'Global version.')!;
  const to = r.locations.find((l) => l.path === path.join(ws, '.claude/skills'))!;
  const plan = await planTransfer(s, r.locations.find((l) => l.id === s.locationId)!, to, 'copy', r.skills);
  assert.equal(plan.exists, true);
  assert.ok(plan.duplicates.some((d) => d.provider === 'cursor' && d.dir.endsWith(path.join('.cursor', 'skills', 'pdf'))));
  assert.ok(!plan.duplicates.some((d) => d.dir === path.join(ws, '.claude/skills/pdf')), 'the replaced copy is not a duplicate');
  await assert.rejects(executeTransfer(plan, false, deps), /already exists/);
  const res = await executeTransfer(plan, true, deps);
  assert.match(await fs.readFile(path.join(res.backupDir!, 'SKILL.md'), 'utf8'), /Project version/);
  assert.match(await fs.readFile(path.join(ws, '.claude/skills/pdf/SKILL.md'), 'utf8'), /Global version/);
});

test('symlinks, read-only and synced skills can be copied but not moved; read-only destinations refuse', async () => {
  const { root, home, ws, scan, deps } = await env();
  const canonical = await writeSkill(path.join(root, 'canonical'), 'shared');
  await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true });
  await fs.symlink(canonical, path.join(home, '.claude/skills/shared'));
  await writeSkill(path.join(home, '.claude/skills/synced/acct'), 'web');
  const r = await scan();
  const link = r.skills.find((x) => x.name === 'shared')!;
  const synced = r.skills.find((x) => x.name === 'web')!;
  const from = r.locations.find((l) => l.id === link.locationId)!;
  const to = r.locations.find((l) => l.path === path.join(ws, '.agents/skills'))!;
  assert.match(moveBlocker(link, from) ?? '', /symbolic link/);
  assert.match(moveBlocker(synced, from) ?? '', /claude\.ai/);
  await assert.rejects(planTransfer(link, from, to, 'move', r.skills), /can't be moved/);

  const copy = await executeTransfer(await planTransfer(link, from, to, 'copy', r.skills), false, deps);
  assert.equal((await fs.lstat(copy.targetDir)).isSymbolicLink(), false, 'copy of a link is a real folder');
  await fs.access(path.join(canonical, 'SKILL.md'));
  await executeTransfer(await planTransfer(synced, from, to, 'copy', r.skills), false, deps);
  await fs.access(path.join(ws, '.agents/skills/web/SKILL.md'));

  const admin = r.locations.find((l) => l.scope === 'admin')!;
  await assert.rejects(planTransfer(link, from, admin, 'copy', r.skills), /read-only/);
  await assert.rejects(planTransfer(link, from, from, 'copy', r.skills), /read-only|different folder/);
});
