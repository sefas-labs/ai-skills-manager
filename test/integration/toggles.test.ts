import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discover } from '../../src/core/discovery';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import { parseCodexSkillConfig, readToggleState, setClaudeOverride, setCodexEnabled, setCodexSkillEnabled, setInvocationFlags, toggleFiles } from '../../src/core/toggles';
import type { DiscoveryContext } from '../../src/core/types';
import { skillMd, tempDir, writeSkill } from '../helpers/fsFixture';

test('codex config: only [[skills.config]] is read; edits keep the rest byte-for-byte', () => {
  const toml = [
    'model = "gpt-5"',
    '# my comment',
    '[[skills.config]]',
    "path = '/a/SKILL.md'",
    'enabled = false # off for now',
    '',
    '[profiles.fast]',
    'path = "/not/a/skill"',
    '[[skills.config]]',
    'path = "/b/SKILL.md"',
    '',
  ].join('\n');
  assert.deepEqual(parseCodexSkillConfig(toml).map((e) => [e.path, e.enabled]), [['/a/SKILL.md', false], ['/b/SKILL.md', true]]);
  const on = setCodexSkillEnabled(toml, '/a/SKILL.md', true);
  assert.equal(on, toml.replace('enabled = false # off for now', 'enabled = true # off for now'));
  const offB = setCodexSkillEnabled(toml, '/b/SKILL.md', false);
  assert.equal(offB, toml.replace('path = "/b/SKILL.md"', 'path = "/b/SKILL.md"\nenabled = false'));
  const offC = setCodexSkillEnabled(toml, '/c d/SKILL.md', false);
  assert.ok(offC.startsWith(toml.trimEnd()));
  assert.match(offC, /\n\n\[\[skills\.config\]\]\npath = "\/c d\/SKILL\.md"\nenabled = false\n$/);
  assert.equal(setCodexSkillEnabled(toml, '/c/SKILL.md', true), toml, 'absent already means enabled');
  assert.equal(setCodexSkillEnabled('', '/x/SKILL.md', false), '[[skills.config]]\npath = "/x/SKILL.md"\nenabled = false\n');
});

async function env() {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  const dir = await writeSkill(path.join(home, '.agents/skills'), 'deploy', skillMd('deploy', 'Ship it.'));
  const ctx: DiscoveryContext = { homeDir: home, workspaceFolders: [ws], platform: 'linux' };
  const scan = async () => (await discover(ctx, BUILTIN_PROVIDERS)).skills.find((s) => s.name === 'deploy')!;
  return { root, home, ws, dir, scan, files: toggleFiles(home, ws), backups: path.join(root, 'backups') };
}

test('claude skillOverrides: local beats user; "on" removes the key; other settings survive', async () => {
  const { home, ws, scan, files, backups } = await env();
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(files.claudeUser, JSON.stringify({ model: 'opus', skillOverrides: { deploy: 'name-only', other: 'off' } }));
  let st = await readToggleState(await scan(), files);
  assert.deepEqual(st.claude, { value: 'name-only', from: 'user' });
  await setClaudeOverride(path.join(ws, '.claude/settings.local.json'), 'deploy', 'off', backups);
  st = await readToggleState(await scan(), files);
  assert.deepEqual(st.claude, { value: 'off', from: 'local' });
  const backup = await setClaudeOverride(files.claudeUser, 'deploy', 'on', backups);
  const user = JSON.parse(await fs.readFile(files.claudeUser, 'utf8'));
  assert.deepEqual(user, { model: 'opus', skillOverrides: { other: 'off' } });
  assert.ok(backup && JSON.parse(await fs.readFile(backup, 'utf8')).skillOverrides.deploy === 'name-only');
  await fs.writeFile(files.claudeUser, '{ not json');
  await assert.rejects(setClaudeOverride(files.claudeUser, 'deploy', 'off', backups), /not valid JSON/);
});

test('codex enabled flag via ~/.codex/config.toml, keyed by the SKILL.md path', async () => {
  const { dir, scan, files, backups } = await env();
  assert.deepEqual((await readToggleState(await scan(), files)).codex, { enabled: true });
  await setCodexEnabled(files.codexConfig, path.join(dir, 'SKILL.md'), false, backups);
  assert.deepEqual((await readToggleState(await scan(), files)).codex, { enabled: false });
  await setCodexEnabled(files.codexConfig, path.join(dir, 'SKILL.md'), true, backups);
  assert.deepEqual((await readToggleState(await scan(), files)).codex, { enabled: true });
});

test('frontmatter flags for Cursor/Copilot: real YAML booleans, defaults left untouched', async () => {
  const { dir, scan, files, backups } = await env();
  await setInvocationFlags(await scan(), { modelInvocation: false, userInvocable: false }, backups);
  const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(text, /^disable-model-invocation: true$/m);
  assert.match(text, /^user-invocable: false$/m);
  let st = await readToggleState(await scan(), files);
  assert.equal(st.modelInvocation, false);
  assert.equal(st.userInvocable, false);
  await setInvocationFlags(await scan(), { modelInvocation: true, userInvocable: true }, backups);
  st = await readToggleState(await scan(), files);
  assert.equal(st.modelInvocation, true);
  assert.equal(st.userInvocable, true);
  // A skill that never had the keys is left byte-for-byte unchanged when nothing changes.
  const { dir: d2, scan: s2, backups: b2 } = await env();
  const before = await fs.readFile(path.join(d2, 'SKILL.md'), 'utf8');
  assert.equal(await setInvocationFlags(await s2(), { modelInvocation: true, userInvocable: true }, b2), undefined);
  assert.equal(await fs.readFile(path.join(d2, 'SKILL.md'), 'utf8'), before);
});
