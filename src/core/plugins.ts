import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPathInside } from './paths';
import type { ReadLocation } from './types';

/**
 * Skills that come with Claude Code plugins (read-only: Claude Code manages
 * them). Verified 2026-10-19 against code.claude.com/docs/en/plugins/loading
 * and /plugins-reference, and against this machine's files:
 *  - `<plugins root>/installed_plugins.json` (version 2): `plugins[<name>@<marketplace>]`
 *    is a list of installs with `scope` (user | project | local), `installPath`,
 *    `version` and, for project/local, `projectPath`. The root is
 *    `~/.claude/plugins` unless CLAUDE_CODE_PLUGIN_CACHE_DIR says otherwise.
 *  - Skills live in `<installPath>/skills/<name>/SKILL.md`, plus the directories
 *    the manifest's `skills` key adds (`.claude-plugin/plugin.json`).
 *  - A plugin loads when `enabledPlugins[id]` is true in the settings that
 *    apply (managed > local > project > user); when no source sets it, the
 *    manifest's `defaultEnabled` decides (default true).
 *  - Plugin skills are namespaced (`<plugin>:<skill>`), so they never clash
 *    with your own skills of the same name.
 * Also (claudeSyncedPluginSkillRoots): plugins synced from claude.ai load as
 * `<name>@synced` from `plugins/synced/` (documented); inside it we assume the
 * same per-account bucket layout as synced skills (⚠️ observed, not documented).
 * Not covered: single-skill plugins that keep SKILL.md at their root.
 */
export interface PluginRootsInput {
  homeDir: string;
  workspaceFolders: string[];
  platform: NodeJS.Platform;
  /** CLAUDE_CODE_PLUGIN_CACHE_DIR, when set. */
  pluginsRoot?: string;
}

const MANAGED_SETTINGS: Record<string, string> = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
};

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const v = JSON.parse(await fs.readFile(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function enabledMap(settings: Record<string, unknown> | undefined): Record<string, boolean> {
  const e = settings?.['enabledPlugins'];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
  return Object.fromEntries(Object.entries(e as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
}

const isDir = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false);

export async function claudePluginSkillRoots(input: PluginRootsInput & { syncBucket?: string }): Promise<ReadLocation[]> {
  const root = input.pluginsRoot || path.join(input.homeDir, '.claude', 'plugins');
  const registry = await readJson(path.join(root, 'installed_plugins.json'));
  const registered = registry?.['plugins'];
  const plugins = registered && typeof registered === 'object' ? (registered as Record<string, unknown>) : {};

  const ws = input.workspaceFolders[0];
  const layers = [
    enabledMap(await readJson(path.join(input.homeDir, '.claude', 'settings.json'))),
    ws ? enabledMap(await readJson(path.join(ws, '.claude', 'settings.json'))) : {},
    ws ? enabledMap(await readJson(path.join(ws, '.claude', 'settings.local.json'))) : {},
    enabledMap(await readJson(MANAGED_SETTINGS[input.platform] ?? MANAGED_SETTINGS.linux)),
  ];
  const setting = (id: string) => layers.reduce<boolean | undefined>((v, l) => (id in l ? l[id] : v), undefined);

  const out: ReadLocation[] = [];
  const seen = new Set<string>();
  for (const [id, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;
    for (const inst of installs as Array<Record<string, unknown>>) {
      const installPath = typeof inst['installPath'] === 'string' ? (inst['installPath'] as string) : undefined;
      if (!installPath || seen.has(installPath)) continue;
      const scope = inst['scope'];
      const projectPath = typeof inst['projectPath'] === 'string' ? path.resolve(inst['projectPath'] as string) : undefined;
      const folder = projectPath ? input.workspaceFolders.find((f) => path.resolve(f) === projectPath) : undefined;
      if (scope !== 'user' && !folder) continue; // a project/local install for another project
      const manifest = await readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
      const name = typeof manifest?.['name'] === 'string' ? (manifest['name'] as string) : id.split('@')[0];
      const enabled = setting(id) ?? (manifest?.['defaultEnabled'] === false ? false : true);
      if (!enabled) continue;
      seen.add(installPath);
      const extra = manifest?.['skills'];
      const declared = (Array.isArray(extra) ? extra : typeof extra === 'string' ? [extra] : []).filter((x): x is string => typeof x === 'string');
      const dirs = ['./skills', ...declared].map((rel) => path.resolve(installPath, rel)).filter((d) => isPathInside(d, installPath, true));
      for (const dir of [...new Set(dirs)]) {
        if (!(await isDir(dir))) continue;
        // A folder that is itself one skill is a single-skill plugin: not represented here.
        if (await fs.access(path.join(dir, 'SKILL.md')).then(() => true, () => false)) continue;
        out.push({
          path: dir,
          scope: folder ? 'workspace' : 'global',
          workspaceFolder: folder,
          origin: 'plugin',
          namespace: name,
          label: `plugin ${name}${path.relative(installPath, dir) === 'skills' ? '' : ` (${path.relative(installPath, dir).split(path.sep).join('/')})`}`,
          readOnly: true,
          readOnlyReason: `Installed by the Claude Code plugin "${id}" — manage it with /plugin in Claude Code.`,
        });
      }
    }
  }
  out.push(...(await syncedPluginRoots(root, input.syncBucket, setting)));
  return out;
}

/** Skill roots of one plugin directory: `skills/` plus the manifest's extra `skills` directories. */
async function pluginSkillDirs(pluginDir: string, manifest: Record<string, unknown> | undefined): Promise<string[]> {
  const extra = manifest?.['skills'];
  const declared = (Array.isArray(extra) ? extra : typeof extra === 'string' ? [extra] : []).filter((x): x is string => typeof x === 'string');
  const dirs = [...new Set(['./skills', ...declared].map((rel) => path.resolve(pluginDir, rel)).filter((d) => isPathInside(d, pluginDir, true)))];
  const ok: string[] = [];
  for (const d of dirs) if ((await isDir(d)) && !(await fs.access(path.join(d, 'SKILL.md')).then(() => true, () => false))) ok.push(d);
  return ok;
}

/** claude.ai plugins: `<plugins root>/synced/<org>_<account>/<plugin>/` of the signed-in account (⚠️ layout observed). */
async function syncedPluginRoots(root: string, bucket: string | undefined, setting: (id: string) => boolean | undefined): Promise<ReadLocation[]> {
  if (!bucket) return [];
  const base = path.join(root, 'synced', bucket);
  const out: ReadLocation[] = [];
  for (const e of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(base, e.name);
    const manifest = await readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
    const name = typeof manifest?.['name'] === 'string' ? (manifest['name'] as string) : e.name;
    if (setting(`${name}@synced`) === false || (setting(`${name}@synced`) === undefined && manifest?.['defaultEnabled'] === false)) continue;
    for (const d of await pluginSkillDirs(dir, manifest)) {
      out.push({ path: d, scope: 'global', origin: 'plugin', namespace: name, label: `claude.ai plugin ${name}`, readOnly: true, readOnlyReason: 'Synced from claude.ai — manage it on claude.ai or with /plugin.' });
    }
  }
  return out;
}

/**
 * Cursor: plugins in `~/.cursor/plugins/local/<plugin>/` (✅ cursor.com/docs/plugins: "put either
 * plugin format in ~/.cursor/plugins/local") with skills in `skills/<name>/SKILL.md`, and the
 * built-in skills Cursor ships in `~/.cursor/skills-cursor/` (⚠️ observed: same names as the
 * "built-in skills" the docs list; the folder itself isn't documented).
 */
export async function cursorSkillRoots(homeDir: string): Promise<ReadLocation[]> {
  const out: ReadLocation[] = [];
  const builtIn = path.join(homeDir, '.cursor', 'skills-cursor');
  if (await isDir(builtIn)) out.push({ path: builtIn, scope: 'global', label: 'Cursor built-in skills', readOnly: true, readOnlyReason: 'Built into Cursor — Cursor manages these.' });
  const local = path.join(homeDir, '.cursor', 'plugins', 'local');
  for (const e of await fs.readdir(local, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(local, e.name);
    const manifest = (await readJson(path.join(dir, '.cursor-plugin', 'plugin.json'))) ?? (await readJson(path.join(dir, '.claude-plugin', 'plugin.json')));
    const name = typeof manifest?.['name'] === 'string' ? (manifest['name'] as string) : e.name;
    for (const d of await pluginSkillDirs(dir, manifest)) {
      out.push({ path: d, scope: 'global', origin: 'plugin', label: `Cursor plugin ${name} (local)`, readOnly: true, readOnlyReason: `Part of your local Cursor plugin "${name}" — edit it in ~/.cursor/plugins/local.` });
    }
  }
  return out;
}
