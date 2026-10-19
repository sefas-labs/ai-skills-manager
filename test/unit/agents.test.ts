import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { detectAgents, hostAgentFor } from '../../src/core/agents';
import { tempDir } from '../helpers/fsFixture';

const IDS = ['claude-code', 'cursor', 'codex', 'copilot'];

test('detects agents from PATH, home files and extensions, and says why', async () => {
  const root = await tempDir();
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'claude'), '');
  await fs.writeFile(path.join(home, '.codex/config.toml'), '');
  const r = await detectAgents(IDS, { homeDir: home, platform: 'linux', pathDirs: [path.join(root, 'nope'), bin], extensionIds: ['GitHub.copilot-chat'] });
  assert.deepEqual(r['claude-code'], { installed: true, evidence: ['`claude` on PATH'] });
  assert.deepEqual(r['codex'].evidence, ['~/.codex/config.toml']);
  assert.deepEqual(r['copilot'].evidence, ['extension github.copilot-chat'], 'extension ids compare case-insensitively');
  assert.deepEqual(r['cursor'], { installed: false, evidence: [] });
});

test('the host editor counts as evidence; apps are looked up per platform', async () => {
  const seen: string[] = [];
  const exists = async (p: string) => {
    seen.push(p);
    return p === '/Applications/Cursor.app';
  };
  const r = await detectAgents(['cursor', 'windsurf'], { homeDir: '/h', platform: 'darwin', pathDirs: [], extensionIds: [], hostAgent: 'cursor', exists });
  assert.deepEqual(r['cursor'].evidence, ['built into this editor', '/Applications/Cursor.app']);
  assert.ok(seen.includes('/h/Applications/Cursor.app'));
  assert.deepEqual(r['windsurf'], { installed: false, evidence: [] }, 'unknown agents are simply not detected');
});

test('host agent from the editor name', () => {
  assert.equal(hostAgentFor('Cursor'), 'cursor');
  assert.equal(hostAgentFor('Visual Studio Code'), 'copilot');
  assert.equal(hostAgentFor('Visual Studio Code - Insiders'), 'copilot');
  assert.equal(hostAgentFor('Windsurf'), undefined);
});
