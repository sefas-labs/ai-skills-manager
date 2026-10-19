import * as path from 'node:path';
import { ancestorsUpTo } from '../monorepo';
import type { DiscoveryContext, ProviderAdapter, ReadLocation } from '../types';

/**
 * Provider adapters. Each one only declares the directories its *official docs*
 * say it loads skills from. Adding a provider = adding an object here (or
 * registering one at runtime); discovery, conflicts and the UI need no change.
 *
 * Verified on 2026-10-18 against:
 *  - Claude Code: https://code.claude.com/docs/en/skills
 *  - Cursor:      https://cursor.com/docs/skills
 *  - Codex:       https://developers.openai.com/codex/skills (now redirects to
 *                 https://learn.chatgpt.com/docs/build-skills)
 *  - Copilot:     https://code.visualstudio.com/docs/agent-customization/agent-skills
 *
 * Monorepos (same date, same pages):
 *  ✅ Claude Code: `.claude/skills` in the launch folder and every parent up to
 *     the repo root (stops at a linked worktree's root); nested
 *     `<subdir>/.claude/skills` load when Claude first reads a file there and
 *     are namespaced (`/apps/web:deploy`), so they don't clash with root skills.
 *  ✅ Codex: `.agents/skills` in each folder from the CWD up to the repo root.
 *     Nested folders below the CWD: not documented → not declared.
 *  ✅ Cursor: a `.cursor/skills` or `.agents/skills` folder anywhere inside the
 *     repository (scoped to its sub-folder). Parent folders: not documented.
 *  ⚠️ Copilot: `chat.useCustomizationsInParentRepositories` discovers skills
 *     "from the parent repository root"; the exact folders are not listed, so
 *     the three project folders are assumed. Nested: not documented.
 *  The editor's workspace folder plays the role of the launch folder / CWD.
 */

const toPosix = (relativePath: string) => relativePath.split(path.sep).join('/');

const inWorkspaceFolders = (context: DiscoveryContext, relativePath: string): ReadLocation[] =>
  context.workspaceFolders.map((folder) => ({
    path: path.join(folder, relativePath),
    scope: 'workspace' as const,
    workspaceFolder: folder,
  }));

/** `relativePath` in every folder above each workspace folder up to its repo root. */
const inParentFolders = (context: DiscoveryContext, relativePath: string): ReadLocation[] =>
  context.workspaceFolders.flatMap((folder) => {
    const repoRoot = context.repoRoots?.[folder];
    if (!repoRoot) return [];
    return ancestorsUpTo(folder, repoRoot).map((parentDir) => ({
      path: path.join(parentDir, relativePath),
      scope: 'workspace' as const,
      workspaceFolder: folder,
      origin: 'parent' as const,
      label: toPosix(path.relative(folder, path.join(parentDir, relativePath))),
    }));
  });

/** `relativePath` inside every nested sub-folder found below each workspace folder. */
const inNestedFolders = (context: DiscoveryContext, relativePath: string): ReadLocation[] =>
  context.workspaceFolders.flatMap((folder) =>
    (context.nestedDirs?.[folder] ?? []).map((subfolder) => ({
      path: path.join(folder, subfolder, relativePath),
      scope: 'workspace' as const,
      workspaceFolder: folder,
      origin: 'nested' as const,
      appliesTo: subfolder,
    })),
  );

/** Only the repo root itself (Copilot's parent-repository setting). */
const inRepoRootOnly = (context: DiscoveryContext, relativePaths: string[]): ReadLocation[] =>
  context.workspaceFolders.flatMap((folder) => {
    const repoRoot = context.repoRoots?.[folder];
    if (!repoRoot) return [];
    return relativePaths.map((relativePath) => ({
      path: path.join(repoRoot, relativePath),
      scope: 'workspace' as const,
      workspaceFolder: folder,
      origin: 'parent' as const,
      label: toPosix(path.relative(folder, path.join(repoRoot, relativePath))),
    }));
  });

const inHome = (context: DiscoveryContext, relativePath: string): ReadLocation => ({
  path: path.join(context.homeDir, relativePath),
  scope: 'global',
});

/** Claude Code's managed settings directory + `.claude/skills` (enterprise skills, highest precedence). */
const CLAUDE_MANAGED_SKILLS: Record<string, string> = {
  darwin: '/Library/Application Support/ClaudeCode/.claude/skills',
  linux: '/etc/claude-code/.claude/skills',
  win32: 'C:\\Program Files\\ClaudeCode\\.claude\\skills',
};

export const claudeCode: ProviderAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  docsUrl: 'https://code.claude.com/docs/en/skills',
  disableHint:
    'Use the `skillOverrides` setting ("off", "name-only", "user-invocable-only") or `disable-model-invocation: true` in the frontmatter.',
  namespacesNested: true,
  readLocations: (context) => [
    {
      ...inHome(context, '.claude/skills'),
      managedSubdirs: { synced: 'Synced from claude.ai — local edits are overwritten on the next sync.' },
    },
    ...inWorkspaceFolders(context, '.claude/skills'),
    ...inParentFolders(context, '.claude/skills'),
    ...inNestedFolders(context, '.claude/skills'),
    // ✅ 2026-10-19 (skills + managed-settings docs): `.claude/skills` inside the managed settings directory.
    { path: CLAUDE_MANAGED_SKILLS[context.platform] ?? CLAUDE_MANAGED_SKILLS.linux, scope: 'admin', readOnly: true, readOnlyReason: 'Deployed by your organization (Claude Code managed settings).' },
    // ✅ 2026-10-19: skills of enabled plugins (namespaced `<plugin>:<skill>`), resolved in plugins.ts.
    ...(context.claudePlugins ?? []),
  ],
};

export const cursor: ProviderAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  docsUrl: 'https://cursor.com/docs/skills',
  // ✅ 2026-10-19: "Cursor walks the skills root recursively and picks up any SKILL.md it finds".
  recursiveRoots: true,
  disableHint: 'Cursor has no per-skill toggle; `disable-model-invocation: true` makes a skill load only via /skill-name.',
  readLocations: (context) => [
    ...inWorkspaceFolders(context, '.agents/skills'),
    ...inWorkspaceFolders(context, '.cursor/skills'),
    ...inWorkspaceFolders(context, '.claude/skills'),
    ...inWorkspaceFolders(context, '.codex/skills'),
    ...inNestedFolders(context, '.agents/skills'),
    ...inNestedFolders(context, '.cursor/skills'),
    // Built-in skills (⚠️ ~/.cursor/skills-cursor, observed) and local plugins (✅ ~/.cursor/plugins/local).
    ...(context.cursorPlugins ?? []),
    inHome(context, '.agents/skills'),
    inHome(context, '.cursor/skills'),
    inHome(context, '.claude/skills'),
    inHome(context, '.codex/skills'),
  ],
};

export const codex: ProviderAdapter = {
  id: 'codex',
  displayName: 'Codex',
  docsUrl: 'https://developers.openai.com/codex/skills',
  disableHint: 'Add a `[[skills.config]]` entry with `path` and `enabled = false` to ~/.codex/config.toml, then restart Codex.',
  readLocations: (context) => {
    const locations: ReadLocation[] = [...inWorkspaceFolders(context, '.agents/skills'), ...inParentFolders(context, '.agents/skills'), inHome(context, '.agents/skills')];
    if (context.platform !== 'win32') {
      locations.push({
        path: '/etc/codex/skills',
        scope: 'admin',
        readOnly: true,
        readOnlyReason: 'Admin-managed location.',
      });
    }
    return locations;
  },
};

export const copilot: ProviderAdapter = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  docsUrl: 'https://code.visualstudio.com/docs/agent-customization/agent-skills',
  disableHint: 'Manage per-skill visibility from Chat: Open Customizations → Skills in VS Code.',
  readLocations: (context) => [
    ...inWorkspaceFolders(context, '.github/skills'),
    ...inWorkspaceFolders(context, '.claude/skills'),
    ...inWorkspaceFolders(context, '.agents/skills'),
    ...(context.copilotParentRepo ? inRepoRootOnly(context, ['.github/skills', '.claude/skills', '.agents/skills']) : []),
    inHome(context, '.copilot/skills'),
    inHome(context, '.claude/skills'),
    inHome(context, '.agents/skills'),
  ],
};

export const BUILTIN_PROVIDERS: ProviderAdapter[] = [claudeCode, cursor, codex, copilot];
