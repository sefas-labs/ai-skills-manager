import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseFrontmatter } from '../../src/core/frontmatter';
import { trackedFromGhFrontmatter, trackedFromLock } from '../../src/core/provenance';
import { diffFiles, gitBlobSha, localFileShas } from '../../src/core/updates';
import { tempDir } from '../helpers/fsFixture';

// Verbatim frontmatter written by `gh skill install anthropics/skills docx --pin <sha>` (gh 2.102.0, 2026-10-18).
const GH_PINNED = `---
description: Use this skill whenever the user wants to create, read, edit, or manipulate Word documents.
license: Proprietary. LICENSE.txt has complete terms
metadata:
    github-path: skills/docx
    github-pinned: dbd4588f9e1033efb41dad4bef2f7947c8993d44
    github-ref: dbd4588f9e1033efb41dad4bef2f7947c8993d44
    github-repo: https://github.com/anthropics/skills
    github-tree-sha: 6e6f5b95c1de6e803cc07b214f5059b074d64e0c
name: docx
---
# DOCX
`;
const GH_BRANCH = `---
description: PDF things.
metadata:
    github-path: skills/pdf
    github-ref: refs/heads/main
    github-repo: https://github.com/anthropics/skills
    github-tree-sha: 6369f4649de69bd6857c9bc3b058a77206009238
name: pdf
---
`;

test('gh skill provenance: branch ref is tracked, --pin is pinned', () => {
  const b = trackedFromGhFrontmatter(parseFrontmatter(GH_BRANCH).data)!;
  assert.deepEqual(b, {
    origin: 'gh-skill',
    owner: 'anthropics',
    repo: 'skills',
    ref: 'main',
    subpath: 'skills/pdf',
    treeSha: '6369f4649de69bd6857c9bc3b058a77206009238',
    pinned: false,
  });
  const p = trackedFromGhFrontmatter(parseFrontmatter(GH_PINNED).data)!;
  assert.equal(p.pinned, true);
  assert.equal(p.subpath, 'skills/docx');
});

test('gh skill provenance: hostile or foreign metadata is ignored', () => {
  const fm = (meta: Record<string, string>) => ({ metadata: { 'github-ref': 'refs/heads/main', 'github-tree-sha': 'a'.repeat(40), ...meta } });
  assert.equal(trackedFromGhFrontmatter(fm({ 'github-repo': 'https://evil.example.com/a/b' })), undefined);
  assert.equal(trackedFromGhFrontmatter(fm({ 'github-repo': 'https://github.com/a/b', 'github-path': '../../etc' })), undefined);
  assert.equal(trackedFromGhFrontmatter(fm({ 'github-repo': 'https://github.com/a/b', 'github-ref': 'main..x' })), undefined);
  assert.equal(trackedFromGhFrontmatter({ metadata: { source: 'whatever' } }), undefined);
  const noSha = trackedFromGhFrontmatter(fm({ 'github-repo': 'https://github.com/a/b', 'github-tree-sha': 'not-a-sha' }))!;
  assert.equal(noSha.treeSha, undefined);
});

test('lock provenance: a commit SHA as ref means pinned', () => {
  const entry = (ref: string) => ({
    name: 'x',
    dir: '/x',
    locationPath: '/',
    installedAt: '',
    contentHash: '',
    fileCount: 1,
    source: { type: 'github' as const, owner: 'o', repo: 'r', ref, commit: 'c'.repeat(40), subpath: 's', url: '' },
  });
  assert.equal(trackedFromLock(entry('main')).pinned, false);
  assert.equal(trackedFromLock(entry('b'.repeat(40))).pinned, true);
});

test('gitBlobSha matches `git hash-object`', async (t) => {
  const dir = await tempDir();
  const f = path.join(dir, 'a.txt');
  await fs.writeFile(f, 'hello\nworld\n');
  let expected: string;
  try {
    expected = execFileSync('git', ['hash-object', f], { encoding: 'utf8' }).trim();
  } catch {
    t.skip('git not installed');
    return;
  }
  assert.equal(gitBlobSha(await fs.readFile(f)), expected);
  assert.equal(gitBlobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('diffFiles and localFileShas', async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'SKILL.md'), 'x');
  await fs.writeFile(path.join(dir, 'sub', 'b.md'), 'y');
  await fs.symlink('/etc/hosts', path.join(dir, 'link'));
  const local = await localFileShas(dir);
  assert.deepEqual([...local.keys()].sort(), ['SKILL.md', 'sub/b.md']); // symlink not followed
  const before = new Map([
    ['SKILL.md', 'old'],
    ['gone.md', 'z'],
    ['sub/b.md', local.get('sub/b.md')!],
  ]);
  assert.deepEqual(diffFiles(before, local), { added: [], modified: ['SKILL.md'], removed: ['gone.md'] });
});
