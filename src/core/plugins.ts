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
 * Also (syncedPluginRoots): plugins synced from claude.ai load as
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

type JsonObject = Record<string, unknown>;
/** Value of `enabledPlugins[id]` across all settings files, highest precedence last; undefined when unset. */
type PluginSetting = (pluginId: string) => boolean | undefined;

const MANAGED_SETTINGS: Record<string, string> = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
};

const DEFAULT_SKILLS_FOLDER = './skills';
const SYNCED_PLUGIN_SUFFIX = '@synced';

async function readJson(file: string): Promise<JsonObject | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringField(object: JsonObject | undefined, key: string): string | undefined {
  const value = object?.[key];
  return typeof value === 'string' ? value : undefined;
}

function enabledPluginsOf(settings: JsonObject | undefined): Record<string, boolean> {
  const enabledPlugins = settings?.['enabledPlugins'];
  if (!enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins)) return {};
  const booleanEntries = Object.entries(enabledPlugins as JsonObject).filter(([, value]) => typeof value === 'boolean');
  return Object.fromEntries(booleanEntries) as Record<string, boolean>;
}

const isDirectory = (fullPath: string) => fs.stat(fullPath).then((stat) => stat.isDirectory(), () => false);
const fileExists = (fullPath: string) => fs.access(fullPath).then(() => true, () => false);

/** Reads `enabledPlugins` from user, project, local and managed settings (later layers win). */
async function pluginSettingReader(input: PluginRootsInput): Promise<PluginSetting> {
  const workspace = input.workspaceFolders[0];
  const layersInPrecedenceOrder = [
    enabledPluginsOf(await readJson(path.join(input.homeDir, '.claude', 'settings.json'))),
    workspace ? enabledPluginsOf(await readJson(path.join(workspace, '.claude', 'settings.json'))) : {},
    workspace ? enabledPluginsOf(await readJson(path.join(workspace, '.claude', 'settings.local.json'))) : {},
    enabledPluginsOf(await readJson(MANAGED_SETTINGS[input.platform] ?? MANAGED_SETTINGS.linux)),
  ];
  return (pluginId) => layersInPrecedenceOrder.reduce<boolean | undefined>((value, layer) => (pluginId in layer ? layer[pluginId] : value), undefined);
}

/** Skill roots of one plugin directory: `skills/` plus the manifest's extra `skills` directories. */
async function pluginSkillDirs(pluginDir: string, manifest: JsonObject | undefined): Promise<string[]> {
  const extra = manifest?.['skills'];
  const extraList = Array.isArray(extra) ? extra : typeof extra === 'string' ? [extra] : [];
  const declared = extraList.filter((entry): entry is string => typeof entry === 'string');
  const candidates = [DEFAULT_SKILLS_FOLDER, ...declared]
    .map((relativeDir) => path.resolve(pluginDir, relativeDir))
    .filter((dir) => isPathInside(dir, pluginDir, true));
  const skillRoots: string[] = [];
  for (const dir of new Set(candidates)) {
    // A folder that is itself one skill is a single-skill plugin: not represented here.
    const isSingleSkill = await fileExists(path.join(dir, 'SKILL.md'));
    if ((await isDirectory(dir)) && !isSingleSkill) skillRoots.push(dir);
  }
  return skillRoots;
}

function rootLabel(pluginName: string, installPath: string, skillRoot: string): string {
  const relativeRoot = path.relative(installPath, skillRoot).split(path.sep).join('/');
  return relativeRoot === 'skills' ? `plugin ${pluginName}` : `plugin ${pluginName} (${relativeRoot})`;
}

export async function claudePluginSkillRoots(input: PluginRootsInput & { syncBucket?: string }): Promise<ReadLocation[]> {
  const pluginsRoot = input.pluginsRoot || path.join(input.homeDir, '.claude', 'plugins');
  const registry = await readJson(path.join(pluginsRoot, 'installed_plugins.json'));
  const registered = registry?.['plugins'];
  const installsByPlugin = registered && typeof registered === 'object' ? (registered as JsonObject) : {};
  const setting = await pluginSettingReader(input);

  const roots: ReadLocation[] = [];
  const seenInstallPaths = new Set<string>();
  for (const [pluginId, installs] of Object.entries(installsByPlugin)) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs as JsonObject[]) {
      const installPath = stringField(install, 'installPath');
      if (!installPath || seenInstallPaths.has(installPath)) continue;
      const projectPathValue = stringField(install, 'projectPath');
      const projectPath = projectPathValue ? path.resolve(projectPathValue) : undefined;
      const workspaceFolder = projectPath ? input.workspaceFolders.find((folder) => path.resolve(folder) === projectPath) : undefined;
      const isForAnotherProject = install['scope'] !== 'user' && !workspaceFolder;
      if (isForAnotherProject) continue;

      const manifest = await readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
      const pluginName = stringField(manifest, 'name') ?? pluginId.split('@')[0];
      const enabledByDefault = manifest?.['defaultEnabled'] !== false;
      if (!(setting(pluginId) ?? enabledByDefault)) continue;
      seenInstallPaths.add(installPath);

      for (const skillRoot of await pluginSkillDirs(installPath, manifest)) {
        roots.push({
          path: skillRoot,
          scope: workspaceFolder ? 'workspace' : 'global',
          workspaceFolder,
          origin: 'plugin',
          namespace: pluginName,
          label: rootLabel(pluginName, installPath, skillRoot),
          readOnly: true,
          readOnlyReason: `Installed by the Claude Code plugin "${pluginId}" — manage it with /plugin in Claude Code.`,
        });
      }
    }
  }
  roots.push(...(await syncedPluginRoots(pluginsRoot, input.syncBucket, setting)));
  return roots;
}

/** claude.ai plugins: `<plugins root>/synced/<org>_<account>/<plugin>/` of the signed-in account (⚠️ layout observed). */
async function syncedPluginRoots(pluginsRoot: string, bucket: string | undefined, setting: PluginSetting): Promise<ReadLocation[]> {
  if (!bucket) return [];
  const bucketDir = path.join(pluginsRoot, 'synced', bucket);
  const roots: ReadLocation[] = [];
  for (const entry of await fs.readdir(bucketDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const pluginDir = path.join(bucketDir, entry.name);
    const manifest = await readJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'));
    const pluginName = stringField(manifest, 'name') ?? entry.name;
    const explicitSetting = setting(pluginName + SYNCED_PLUGIN_SUFFIX);
    const enabledByDefault = manifest?.['defaultEnabled'] !== false;
    if (!(explicitSetting ?? enabledByDefault)) continue;
    for (const skillRoot of await pluginSkillDirs(pluginDir, manifest)) {
      roots.push({
        path: skillRoot,
        scope: 'global',
        origin: 'plugin',
        namespace: pluginName,
        label: `claude.ai plugin ${pluginName}`,
        readOnly: true,
        readOnlyReason: 'Synced from claude.ai — manage it on claude.ai or with /plugin.',
      });
    }
  }
  return roots;
}

/**
 * Cursor: plugins in `~/.cursor/plugins/local/<plugin>/` (✅ cursor.com/docs/plugins: "put either
 * plugin format in ~/.cursor/plugins/local") with skills in `skills/<name>/SKILL.md`, and the
 * built-in skills Cursor ships in `~/.cursor/skills-cursor/` (⚠️ observed: same names as the
 * "built-in skills" the docs list; the folder itself isn't documented).
 */
export async function cursorSkillRoots(homeDir: string): Promise<ReadLocation[]> {
  const roots: ReadLocation[] = [];
  const builtInDir = path.join(homeDir, '.cursor', 'skills-cursor');
  if (await isDirectory(builtInDir)) {
    roots.push({ path: builtInDir, scope: 'global', label: 'Cursor built-in skills', readOnly: true, readOnlyReason: 'Built into Cursor — Cursor manages these.' });
  }
  const localPluginsDir = path.join(homeDir, '.cursor', 'plugins', 'local');
  for (const entry of await fs.readdir(localPluginsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const pluginDir = path.join(localPluginsDir, entry.name);
    const manifest = (await readJson(path.join(pluginDir, '.cursor-plugin', 'plugin.json'))) ?? (await readJson(path.join(pluginDir, '.claude-plugin', 'plugin.json')));
    const pluginName = stringField(manifest, 'name') ?? entry.name;
    for (const skillRoot of await pluginSkillDirs(pluginDir, manifest)) {
      roots.push({
        path: skillRoot,
        scope: 'global',
        origin: 'plugin',
        label: `Cursor plugin ${pluginName} (local)`,
        readOnly: true,
        readOnlyReason: `Part of your local Cursor plugin "${pluginName}" — edit it in ~/.cursor/plugins/local.`,
      });
    }
  }
  return roots;
}
