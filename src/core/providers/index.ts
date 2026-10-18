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

const ws = (ctx: DiscoveryContext, rel: string): ReadLocation[] =>
  ctx.workspaceFolders.map((folder) => ({
    path: path.join(folder, rel),
    scope: 'workspace' as const,
    workspaceFolder: folder,
  }));

/** `rel` in every folder above each workspace folder up to its repo root. */
const parents = (ctx: DiscoveryContext, rel: string): ReadLocation[] =>
  ctx.workspaceFolders.flatMap((folder) => {
    const root = ctx.repoRoots?.[folder];
    if (!root) return [];
    return ancestorsUpTo(folder, root).map((dir) => ({
      path: path.join(dir, rel),
      scope: 'workspace' as const,
      workspaceFolder: folder,
      origin: 'parent' as const,
      label: path.relative(folder, path.join(dir, rel)).split(path.sep).join('/'),
    }));
  });

/** `rel` inside every nested sub-folder found below each workspace folder. */
const nested = (ctx: DiscoveryContext, rel: string): ReadLocation[] =>
  ctx.workspaceFolders.flatMap((folder) =>
    (ctx.nestedDirs?.[folder] ?? []).map((sub) => ({
      path: path.join(folder, sub, rel),
      scope: 'workspace' as const,
      workspaceFolder: folder,
      origin: 'nested' as const,
      appliesTo: sub,
    })),
  );

/** Only the repo root itself (Copilot's parent-repository setting). */
const repoRootOnly = (ctx: DiscoveryContext, rels: string[]): ReadLocation[] =>
  ctx.workspaceFolders.flatMap((folder) => {
    const root = ctx.repoRoots?.[folder];
    return root
      ? rels.map((rel) => ({
          path: path.join(root, rel),
          scope: 'workspace' as const,
          workspaceFolder: folder,
          origin: 'parent' as const,
          label: path.relative(folder, path.join(root, rel)).split(path.sep).join('/'),
        }))
      : [];
  });

const home = (ctx: DiscoveryContext, rel: string): ReadLocation => ({
  path: path.join(ctx.homeDir, rel),
  scope: 'global',
});

export const claudeCode: ProviderAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  docsUrl: 'https://code.claude.com/docs/en/skills',
  disableHint:
    'Use the `skillOverrides` setting ("off", "name-only", "user-invocable-only") or `disable-model-invocation: true` in the frontmatter.',
  namespacesNested: true,
  readLocations: (ctx) => [
    {
      ...home(ctx, '.claude/skills'),
      managedSubdirs: { synced: 'Synced from claude.ai — local edits are overwritten on the next sync.' },
    },
    ...ws(ctx, '.claude/skills'),
    ...parents(ctx, '.claude/skills'),
    ...nested(ctx, '.claude/skills'),
  ],
};

export const cursor: ProviderAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  docsUrl: 'https://cursor.com/docs/skills',
  disableHint: 'Cursor has no per-skill toggle; `disable-model-invocation: true` makes a skill load only via /skill-name.',
  readLocations: (ctx) => [
    ...ws(ctx, '.agents/skills'),
    ...ws(ctx, '.cursor/skills'),
    ...ws(ctx, '.claude/skills'),
    ...ws(ctx, '.codex/skills'),
    ...nested(ctx, '.agents/skills'),
    ...nested(ctx, '.cursor/skills'),
    home(ctx, '.agents/skills'),
    home(ctx, '.cursor/skills'),
    home(ctx, '.claude/skills'),
    home(ctx, '.codex/skills'),
  ],
};

export const codex: ProviderAdapter = {
  id: 'codex',
  displayName: 'Codex',
  docsUrl: 'https://developers.openai.com/codex/skills',
  disableHint: 'Add a `[[skills.config]]` entry with `path` and `enabled = false` to ~/.codex/config.toml, then restart Codex.',
  readLocations: (ctx) => {
    const locs: ReadLocation[] = [...ws(ctx, '.agents/skills'), ...parents(ctx, '.agents/skills'), home(ctx, '.agents/skills')];
    if (ctx.platform !== 'win32') {
      locs.push({
        path: '/etc/codex/skills',
        scope: 'admin',
        readOnly: true,
        readOnlyReason: 'Admin-managed location.',
      });
    }
    return locs;
  },
};

export const copilot: ProviderAdapter = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  docsUrl: 'https://code.visualstudio.com/docs/agent-customization/agent-skills',
  disableHint: 'Manage per-skill visibility from Chat: Open Customizations → Skills in VS Code.',
  readLocations: (ctx) => [
    ...ws(ctx, '.github/skills'),
    ...ws(ctx, '.claude/skills'),
    ...ws(ctx, '.agents/skills'),
    ...(ctx.copilotParentRepo ? repoRootOnly(ctx, ['.github/skills', '.claude/skills', '.agents/skills']) : []),
    home(ctx, '.copilot/skills'),
    home(ctx, '.claude/skills'),
    home(ctx, '.agents/skills'),
  ],
};

export const BUILTIN_PROVIDERS: ProviderAdapter[] = [claudeCode, cursor, codex, copilot];
