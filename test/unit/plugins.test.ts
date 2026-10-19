import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discover } from '../../src/core/discovery';
import { BUILTIN_PROVIDERS } from '../../src/core/providers';
import type { DiscoveryContext } from '../../src/core/types';
import { skillMd, tempDir, writeSkill } from '../helpers/fsFixture';

async function setup() {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const ws = path.join(root, 'proj');
  const cache = path.join(home, '.claude/plugins/cache/mkt');
  const tools = path.join(cache, 'tools/1.0.0');
  const off = path.join(cache, 'off/2.0.0');
  const other = path.join(cache, 'other-project/1.0.0');
  const proj = path.join(cache, 'proj-only/1.0.0');
  await writeSkill(path.join(tools, 'skills'), 'review', skillMd('review', 'Plugin review.'));
  await writeSkill(path.join(tools, 'extra'), 'lint');
  await fs.mkdir(path.join(tools, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(tools, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'dev-tools', skills: ['./extra/', '../escape'] }));
  await writeSkill(path.join(off, 'skills'), 'hidden');
  await writeSkill(path.join(other, 'skills'), 'elsewhere');
  await writeSkill(path.join(proj, 'skills'), 'proj-skill');
  await fs.mkdir(ws, { recursive: true });
  const reg = {
    version: 2,
    plugins: {
      'tools@mkt': [{ scope: 'user', installPath: tools, version: '1.0.0' }, { scope: 'project', installPath: tools, version: '1.0.0', projectPath: ws }],
      'off@mkt': [{ scope: 'user', installPath: off }],
      'other-project@mkt': [{ scope: 'project', installPath: other, projectPath: path.join(root, 'elsewhere') }],
      'proj-only@mkt': [{ scope: 'local', installPath: proj, projectPath: ws }],
    },
  };
  await fs.writeFile(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify(reg));
  await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'tools@mkt': true, 'off@mkt': true } }));
  await fs.mkdir(path.join(ws, '.claude'), { recursive: true });
  await fs.writeFile(path.join(ws, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'off@mkt': false } }));
  // Your own skill with the same name as a plugin skill: namespaced, so no clash.
  await writeSkill(path.join(home, '.claude/skills'), 'review', skillMd('review', 'Mine.'));
  const ctx: DiscoveryContext = { homeDir: home, workspaceFolders: [ws], platform: 'linux' };
  return { ctx, ws };
}

test('enabled plugins contribute namespaced, read-only skills visible to Claude Code only', async () => {
  const { ctx } = await setup();
  const r = await discover(ctx, BUILTIN_PROVIDERS, { plugins: {} });
  const plugin = r.skills.filter((s) => s.namespace);
  assert.deepEqual(plugin.map((s) => `${s.namespace}:${s.name}`).sort(), ['dev-tools:lint', 'dev-tools:review', 'proj-only:proj-skill']);
  for (const s of plugin) {
    assert.deepEqual(s.visibleTo, ['claude-code']);
    assert.equal(s.readOnly, true);
    assert.match(s.readOnlyReason ?? '', /\/plugin/);
  }
  assert.equal(r.skills.find((s) => s.name === 'proj-skill')!.scope, 'workspace', 'local install for this project');
  assert.ok(!r.skills.some((s) => s.name === 'hidden'), 'disabled in settings.local.json (overrides user)');
  assert.ok(!r.skills.some((s) => s.name === 'elsewhere'), 'installed for another project');
  const mine = r.skills.find((s) => s.name === 'review' && !s.namespace)!;
  assert.ok(!mine.issues.some((i) => i.code.startsWith('duplicate:')), 'plugin skills are namespaced, no clash');
  const loc = r.locations.find((l) => l.namespace === 'dev-tools' && l.label === 'plugin dev-tools')!;
  assert.equal(loc.origin, 'plugin');
});

test('plugins are opt-in at the core level and a missing registry is fine', async () => {
  const { ctx } = await setup();
  assert.ok(!(await discover(ctx, BUILTIN_PROVIDERS)).skills.some((s) => s.namespace));
  const empty = await tempDir();
  const r = await discover({ ...ctx, homeDir: empty }, BUILTIN_PROVIDERS, { plugins: {} });
  assert.ok(!r.skills.some((s) => s.namespace));
});
