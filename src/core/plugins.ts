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
 * Not covered: plugins synced from claude.ai (`plugins/synced/`, layout not
 * documented) and single-skill plugins that keep SKILL.md at their root.
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

export async function claudePluginSkillRoots(input: PluginRootsInput): Promise<ReadLocation[]> {
  const root = input.pluginsRoot || path.join(input.homeDir, '.claude', 'plugins');
  const registry = await readJson(path.join(root, 'installed_plugins.json'));
  const plugins = registry?.['plugins'];
  if (!plugins || typeof plugins !== 'object') return [];

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
  for (const [id, installs] of Object.entries(plugins as Record<string, unknown>)) {
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
  return out;
}
