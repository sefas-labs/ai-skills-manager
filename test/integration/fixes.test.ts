import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discover } from '../../src/core/discovery';
import { addFrontmatter, applyFix, fixesFor, setFrontmatterKey, yamlScalar } from '../../src/core/fixes';
import { LockStore } from '../../src/core/lockfile';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import type { DiscoveryContext } from '../../src/core/types';
import { skillMd, tempDir, writeSkill } from '../helpers/fsFixture';

test('setFrontmatterKey: one-line edit, keeps CRLF/comments/order, refuses block scalars', () => {
  const src = '---\r\nname: Old Name # comment\r\ndescription: Keep me.\r\nmetadata:\r\n  a: b\r\n---\r\nBody\r\n';
  const out = setFrontmatterKey(src, 'name', 'new-name');
  assert.equal(out, '---\r\nname: new-name\r\ndescription: Keep me.\r\nmetadata:\r\n  a: b\r\n---\r\nBody\r\n');
  assert.equal(setFrontmatterKey('---\ndescription: x\n---\n', 'name', 'n'), '---\nname: n\ndescription: x\n---\n');
  assert.throws(() => setFrontmatterKey('---\ndescription: |\n  multi\n---\n', 'description', 'x'), /several lines/);
  assert.throws(() => setFrontmatterKey('no frontmatter', 'name', 'x'), /no frontmatter/);
  const tricky = 'Use when: the user says "hi" #1, or true';
  assert.match(setFrontmatterKey('---\nname: a\n---\n', 'description', tricky), /description: "Use when: the user says \\"hi\\" #1, or true"/);
  assert.equal(yamlScalar('plain words, ok'), 'plain words, ok');
  assert.equal(yamlScalar('true'), '"true"');
  assert.equal(yamlScalar('123'), '"123"');
  assert.match(addFrontmatter('# Title\n', 'x', 'Does x.'), /^---\nname: x\ndescription: Does x\.\n---\n\n# Title\n$/);
});

async function env() {
  const root = await tempDir();
  const home = path.join(root, 'home');
  await fs.mkdir(home, { recursive: true });
  const ctx: DiscoveryContext = { homeDir: home, workspaceFolders: [], platform: 'linux' };
  const lock = new LockStore(path.join(root, 'lock.json'));
  await lock.load();
  const deps = { lock, backupRoot: path.join(root, 'backups') };
  const loc = path.join(home, '.agents/skills');
  const scan = async (dirName: string) => {
    const r = await discover(ctx, BUILTIN_PROVIDERS, { lock });
    const s = r.skills.find((x) => x.dirName === dirName)!;
    return { s, l: r.locations.find((x) => x.id === s.locationId)! };
  };
  return { root, home, loc, lock, deps, scan };
}

test('name mismatch: set name to folder (backup kept) or rename folder (lock follows)', async () => {
  const { loc, lock, deps, scan } = await env();
  await writeSkill(loc, 'my-skill', skillMd('other-name'));
  let { s, l } = await scan('my-skill');
  assert.deepEqual(fixesFor(s, l).map((f) => f.id), ['set-name-to-folder', 'rename-folder-to-name']);

  const r1 = await applyFix(s, l, 'set-name-to-folder', deps);
  assert.match(await fs.readFile(path.join(loc, 'my-skill/SKILL.md'), 'utf8'), /^---\nname: my-skill\n/);
  assert.match(await fs.readFile(r1.backup!, 'utf8'), /name: other-name/);
  ({ s } = await scan('my-skill'));
  assert.ok(!s.issues.some((i) => i.code === 'name-mismatch'));
  assert.equal(((await fs.stat(path.join(loc, 'my-skill/SKILL.md'))).mode & 0o777).toString(8), '644');

  await writeSkill(loc, 'folder-a', skillMd('real-name'));
  await lock.set({ name: 'folder-a', dir: path.join(loc, 'folder-a'), locationPath: loc, installedAt: '', contentHash: '', fileCount: 1, source: { type: 'github', owner: 'o', repo: 'r', ref: 'main', commit: 'c', subpath: '', url: '' } });
  ({ s, l } = await scan('folder-a'));
  const r2 = await applyFix(s, l, 'rename-folder-to-name', deps);
  assert.equal(r2.newDir, path.join(loc, 'real-name'));
  await fs.access(path.join(loc, 'real-name/SKILL.md'));
  assert.ok(lock.get(path.join(loc, 'real-name')));
  assert.equal(lock.get(path.join(loc, 'folder-a')), undefined);
});

test('rename folder refuses to overwrite an existing folder', async () => {
  const { loc, deps, scan } = await env();
  await writeSkill(loc, 'x', skillMd('taken'));
  await writeSkill(loc, 'taken');
  const { s, l } = await scan('x');
  await assert.rejects(applyFix(s, l, 'rename-folder-to-name', deps), /already exists/);
});

test('missing name / description / frontmatter, wrong-case file, broken link', async () => {
  const { home, loc, deps, scan } = await env();
  await writeSkill(loc, 'no-name', '---\ndescription: Has one.\n---\nBody\n');
  await writeSkill(loc, 'no-desc', '---\nname: no-desc\n---\nBody\n');
  await writeSkill(loc, 'bare', '# Just markdown\n');
  await fs.mkdir(path.join(loc, 'lower'), { recursive: true });
  await fs.writeFile(path.join(loc, 'lower/skill.md'), skillMd('lower'));
  await fs.symlink(path.join(home, 'gone'), path.join(loc, 'dangling'));

  let { s, l } = await scan('no-name');
  await applyFix(s, l, 'add-name', deps);
  ({ s } = await scan('no-name'));
  assert.equal(s.frontmatter['name'], 'no-name');

  ({ s, l } = await scan('no-desc'));
  assert.equal(fixesFor(s, l)[0].needsDescription, true);
  await assert.rejects(applyFix(s, l, 'add-description', { ...deps, description: '   ' }), /empty/);
  await applyFix(s, l, 'add-description', { ...deps, description: 'Does things. Use when: testing.' });
  ({ s } = await scan('no-desc'));
  assert.equal(s.frontmatter['description'], 'Does things. Use when: testing.');

  ({ s, l } = await scan('bare'));
  await applyFix(s, l, 'add-frontmatter', { ...deps, description: 'Bare skill.' });
  ({ s } = await scan('bare'));
  assert.deepEqual(s.issues.filter((i) => i.severity !== 'info'), []);
  assert.match(await fs.readFile(path.join(loc, 'bare/SKILL.md'), 'utf8'), /# Just markdown/);

  ({ s, l } = await scan('lower'));
  await applyFix(s, l, 'rename-skill-file', deps);
  assert.deepEqual(await fs.readdir(path.join(loc, 'lower')), ['SKILL.md']);

  ({ s, l } = await scan('dangling'));
  const r = await applyFix(s, l, 'remove-broken-link', deps);
  await assert.rejects(fs.lstat(path.join(loc, 'dangling')));
  assert.equal(await fs.readFile(r.backup!, 'utf8'), path.join(home, 'gone'));
});

test('read-only skills get no fixes; stale fixes are refused', async () => {
  const { home, loc, deps, scan } = await env();
  await writeSkill(path.join(home, '.claude/skills/synced/acct'), 'web', skillMd('wrong'));
  const synced = await scan('web');
  assert.deepEqual(fixesFor(synced.s, synced.l), []);
  await writeSkill(loc, 'ok', skillMd('ok'));
  const fine = await scan('ok');
  await assert.rejects(applyFix(fine.s, fine.l, 'set-name-to-folder', deps), /no longer applies/);
});
