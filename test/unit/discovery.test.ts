import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discover, readClaudeSyncBucket } from '../../src/core/discovery';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import type { DiscoveryContext } from '../../src/core/types';
import { skillMd, tempDir, writeSkill } from '../helpers/fsFixture';

async function setup() {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const ws = path.join(root, 'project');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(ws, { recursive: true });
  const ctx: DiscoveryContext = { homeDir: home, workspaceFolders: [ws], platform: 'linux' };
  return { root, home, ws, ctx };
}

test('visibility follows each provider’s documented folders', async () => {
  const { home, ws, ctx } = await setup();
  await writeSkill(path.join(home, '.claude/skills'), 'claude-only');
  await writeSkill(path.join(home, '.agents/skills'), 'shared');
  await writeSkill(path.join(ws, '.cursor/skills'), 'cursor-project');
  await writeSkill(path.join(ws, '.github/skills'), 'copilot-project');

  const r = await discover(ctx, BUILTIN_PROVIDERS);
  const vis = (name: string) => r.skills.find((s) => s.name === name)!.visibleTo.sort();
  assert.deepEqual(vis('claude-only'), ['claude-code', 'copilot', 'cursor']);
  assert.deepEqual(vis('shared'), ['codex', 'copilot', 'cursor']);
  assert.deepEqual(vis('cursor-project'), ['cursor']);
  assert.deepEqual(vis('copilot-project'), ['copilot']);
  assert.equal(r.skills.find((s) => s.name === 'cursor-project')!.scope, 'workspace');
  assert.equal(r.providers.find((p) => p.id === 'codex')!.visibleSkills, 1);
});

test('same name in two real folders → duplicate warning only for agents that see both', async () => {
  const { home, ctx } = await setup();
  await writeSkill(path.join(home, '.claude/skills'), 'pdf', skillMd('pdf', 'Version A.'));
  await writeSkill(path.join(home, '.agents/skills'), 'pdf', skillMd('pdf', 'Version B.'));
  const r = await discover(ctx, BUILTIN_PROVIDERS);
  const pdfs = r.skills.filter((s) => s.name === 'pdf');
  assert.equal(pdfs.length, 2);
  const dupCodes = new Set(pdfs.flatMap((s) => s.issues.map((i) => i.code)).filter((c) => c.startsWith('duplicate:')));
  assert.deepEqual([...dupCodes].sort(), ['duplicate:copilot', 'duplicate:cursor']);
  assert.deepEqual(r.providers.find((p) => p.id === 'claude-code')!.duplicateNames, []);
});

test('symlinked copies of one folder are not reported as conflicts; target is resolved', async () => {
  const { home, ctx } = await setup();
  const real = await writeSkill(path.join(home, '.agents/skills'), 'linked');
  await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true });
  await fs.symlink(real, path.join(home, '.claude/skills/linked'));
  const r = await discover(ctx, BUILTIN_PROVIDERS);
  const link = r.skills.find((s) => s.isSymlink)!;
  assert.equal(link.realDir, real);
  assert.ok(!link.issues.some((i) => i.code.startsWith('duplicate:')));
  assert.ok(link.issues.some((i) => i.code === 'linked-copies'));
});

test('broken symlink, wrong-case file, folder without SKILL.md, invalid frontmatter', async () => {
  const { home, ctx } = await setup();
  const loc = path.join(home, '.claude/skills');
  await fs.mkdir(loc, { recursive: true });
  await fs.symlink(path.join(home, 'nowhere'), path.join(loc, 'broken'));
  await fs.mkdir(path.join(loc, 'lowercase'));
  await fs.writeFile(path.join(loc, 'lowercase', 'skill.md'), skillMd('lowercase'));
  await fs.mkdir(path.join(loc, 'not-a-skill'));
  await fs.writeFile(path.join(loc, 'not-a-skill', 'README.md'), 'hi');
  await writeSkill(loc, 'bad-fm', '---\nname: bad-fm\ndescription: [oops\n---\n');
  await fs.writeFile(path.join(loc, 'stray.md'), 'x');

  const r = await discover(ctx, BUILTIN_PROVIDERS);
  const by = (n: string) => r.skills.find((s) => s.dirName === n)!;
  assert.equal(by('broken').issues[0].code, 'broken-symlink');
  assert.deepEqual(by('broken').visibleTo, []);
  assert.equal(by('lowercase').issues[0].code, 'skill-file-case');
  assert.equal(by('bad-fm').issues[0].code, 'frontmatter-invalid');
  assert.equal(r.skills.some((s) => s.dirName === 'not-a-skill'), false);
  const l = r.locations.find((x) => x.path === loc)!;
  assert.deepEqual(l.ignoredEntries.sort(), ['not-a-skill/', 'stray.md']);
});

test('claude.ai synced skills are read-only; untrusted workspace makes workspace read-only', async () => {
  const { home, ws, ctx } = await setup();
  await writeSkill(path.join(home, '.claude/skills/synced'), 'from-web');
  await writeSkill(path.join(ws, '.claude/skills'), 'proj');
  const r = await discover(ctx, BUILTIN_PROVIDERS, { workspaceReadOnlyReason: 'untrusted' });
  const synced = r.skills.find((s) => s.name === 'from-web')!;
  assert.equal(synced.readOnly, true);
  assert.match(synced.readOnlyReason ?? '', /claude\.ai/);
  const proj = r.skills.find((s) => s.name === 'proj')!;
  assert.equal(proj.readOnly, true);
  assert.equal(proj.readOnlyReason, 'untrusted');
});

test('extra locations from settings and admin location on non-Windows only', async () => {
  const { root, home, ctx } = await setup();
  const custom = path.join(root, 'custom-skills');
  await writeSkill(custom, 'mine');
  const r = await discover(ctx, BUILTIN_PROVIDERS, { extraLocations: [{ path: custom, scope: 'global', readers: ['windsurf'] }] });
  assert.deepEqual(r.skills.find((s) => s.name === 'mine')!.visibleTo, ['windsurf']);
  assert.ok(r.locations.some((l) => l.scope === 'admin'));
  const win = await discover({ ...ctx, platform: 'win32', homeDir: home }, BUILTIN_PROVIDERS);
  assert.ok(!win.locations.some((l) => l.scope === 'admin'));
});

test('claude.ai synced skills one level below a per-account bucket are found (real layout)', async () => {
  const { home, ctx } = await setup();
  const synced = path.join(home, '.claude/skills/synced');
  await writeSkill(path.join(synced, 'org1_acct1'), 'docs', skillMd('docs', 'Docs, account 1.'));
  await writeSkill(path.join(synced, 'org2_acct2'), 'docs', skillMd('docs', 'Docs, account 2.'));
  await writeSkill(path.join(synced, 'org2_acct2'), 'pdf');
  await fs.writeFile(path.join(synced, 'org1_acct1', 'manifest.json'), '{}');
  await fs.writeFile(path.join(synced, '.bucket-org1_acct1'), '');
  const r = await discover(ctx, BUILTIN_PROVIDERS);
  const found = r.skills.filter((s) => s.readOnly).map((s) => s.name).sort();
  assert.deepEqual(found, ['docs', 'docs', 'pdf']);
  const docs = r.skills.filter((s) => s.name === 'docs');
  // Same name in two synced buckets is not a user-fixable conflict.
  assert.ok(docs.every((s) => !s.issues.some((i) => i.code.startsWith('duplicate:'))));
  assert.ok(docs.every((s) => s.issues.some((i) => i.code === 'synced-copies')));
});

test('synced buckets of other claude.ai accounts are skipped when the signed-in account is known', async () => {
  const { home, ctx } = await setup();
  const synced = path.join(home, '.claude/skills/synced');
  const active = '6ea04121-314f-4adf-8015-7c6afac3adcb_0eee56d7-2202-47a5-a7d2-bf9d59dca953';
  const other = '80e671de-fcd2-4afc-82c7-e7d6937d29a4_ec9373c7-5518-4ee0-a53b-a502be0c969d';
  await writeSkill(path.join(synced, active), 'docs');
  await writeSkill(path.join(synced, other), 'docs');
  await writeSkill(path.join(synced, other), 'old-only');
  await fs.writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { organizationUuid: '6ea04121-314f-4adf-8015-7c6afac3adcb', accountUuid: '0eee56d7-2202-47a5-a7d2-bf9d59dca953', emailAddress: 'x@y' }, other: 'ignored' }),
  );
  assert.equal(await readClaudeSyncBucket(home), active);

  const r = await discover({ ...ctx, claudeSyncBucket: active }, BUILTIN_PROVIDERS);
  const names = r.skills.filter((s) => s.managed).map((s) => s.name);
  assert.deepEqual(names, ['docs']);
  assert.ok(!r.skills[0].issues.some((i) => i.code === 'synced-copies'));
  const loc = r.locations.find((l) => l.path === path.join(home, '.claude/skills'))!;
  assert.equal(loc.skippedSynced, 2);
  assert.deepEqual(loc.skippedSyncedBuckets?.map((b) => [b.bucket, b.skills]), [[other, ['docs', 'old-only']]]);

  // Unknown account (no ~/.claude.json or not signed in): show everything, as before.
  const all = await discover(ctx, BUILTIN_PROVIDERS);
  assert.equal(all.skills.filter((s) => s.managed).length, 3);
  await fs.writeFile(path.join(home, '.claude.json'), '{"oauthAccount":{"organizationUuid":"../../etc","accountUuid":"x"}}');
  assert.equal(await readClaudeSyncBucket(home), undefined);
});

test('identical copies in two folders are informational, different ones a warning', async () => {
  const { home, ws, ctx } = await setup();
  await writeSkill(path.join(home, '.claude/skills'), 'same', skillMd('same', 'Same content.'));
  await writeSkill(path.join(ws, '.agents/skills'), 'same', skillMd('same', 'Same content.'));
  await writeSkill(path.join(home, '.claude/skills'), 'diff', skillMd('diff', 'Version A.'));
  await writeSkill(path.join(ws, '.agents/skills'), 'diff', skillMd('diff', 'Version B.'));
  const r = await discover(ctx, BUILTIN_PROVIDERS);
  const codes = (n: string) => new Set(r.skills.filter((s) => s.name === n).flatMap((s) => s.issues.map((i) => i.code)));
  assert.ok(codes('same').has('identical-copies'));
  assert.ok(![...codes('same')].some((c) => c.startsWith('duplicate:')));
  assert.ok(codes('diff').has('duplicate:cursor'));
  const sameIds = r.skills.filter((s) => s.name === 'same').map((s) => s.contentId);
  assert.ok(sameIds[0] && sameIds[0] === sameIds[1]);
  assert.deepEqual(r.providers.find((p) => p.id === 'cursor')!.duplicateNames, ['diff']);
});
