import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { isPathInside, safeJoin, toSkillDirName, validateRelativePath } from '../../src/core/paths';

test('rejects traversal and absolute paths', () => {
  for (const bad of ['../x', 'a/../../b', 'a/./b', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', '', 'a/\0b', 'con.txt', 'aux', 'a/b.', 'x/y ']) {
    assert.throws(() => validateRelativePath(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});

test('accepts normal nested paths', () => {
  assert.deepEqual(validateRelativePath('scripts/run.py'), ['scripts', 'run.py']);
  assert.deepEqual(validateRelativePath('references/REFERENCE.md'), ['references', 'REFERENCE.md']);
});

test('safeJoin always stays inside root', () => {
  const root = path.resolve('/tmp/root');
  assert.equal(safeJoin(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.throws(() => safeJoin(root, '../escape'));
});

test('isPathInside', () => {
  assert.equal(isPathInside('/a/b/c', '/a/b'), true);
  assert.equal(isPathInside('/a/bc', '/a/b'), false);
  assert.equal(isPathInside('/a/b', '/a/b'), false);
  assert.equal(isPathInside('/a/b', '/a/b', true), true);
  assert.equal(isPathInside('/a/b/../x', '/a/b'), false);
});

test('toSkillDirName produces spec-valid names', () => {
  assert.equal(toSkillDirName('My Cool_Skill!!'), 'my-cool-skill');
  assert.equal(toSkillDirName('Ñandú--Pro'), 'nandu-pro');
  assert.equal(toSkillDirName('***'), 'skill');
  assert.ok(toSkillDirName('x'.repeat(100)).length <= 64);
});
