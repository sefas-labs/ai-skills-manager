import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DiscoveryContext } from './types';

/**
 * Monorepo support: parent folders up to the repository root and skills
 * folders nested deeper inside the workspace. Which agent reads which of
 * these is declared by each provider adapter; this module only finds them.
 */

/** Folder names whose `skills/` sub-folder some agent reads when nested. */
export const NESTED_SKILL_PARENTS = ['.claude', '.agents', '.cursor'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'venv', '__pycache__', 'coverage']);

/**
 * Nearest folder at or above `start` that contains `.git` (a directory, or a
 * file in linked worktrees and submodules — the search stops there, as Claude
 * Code documents for worktrees). undefined when not inside a repository.
 */
export async function findRepoRoot(start: string, stopAt?: string): Promise<string | undefined> {
  let dir = path.resolve(start);
  for (;;) {
    if (await fs.lstat(path.join(dir, '.git')).then(() => true, () => false)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || (stopAt && dir === path.resolve(stopAt))) return undefined;
    dir = parent;
  }
}

/** Folders strictly above `from` up to and including `root`. */
export function ancestorsUpTo(from: string, root: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(from);
  const top = path.resolve(root);
  while (dir !== top) {
    const parent = path.dirname(dir);
    if (parent === dir) return []; // `root` is not an ancestor
    out.push(parent);
    dir = parent;
  }
  return out;
}

/**
 * Relative folders below `root` (not `root` itself) that contain a
 * `.claude/skills`, `.agents/skills` or `.cursor/skills` directory. Bounded:
 * skips hidden and build/dependency folders, never follows symlinks.
 */
export async function findNestedSkillDirs(root: string, opts: { maxDepth?: number; maxDirs?: number } = {}): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 6;
  let budget = opts.maxDirs ?? 5000;
  const found: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth || budget-- <= 0) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel) {
      for (const name of NESTED_SKILL_PARENTS) {
        const e = entries.find((x) => x.name === name && x.isDirectory());
        if (e && (await fs.lstat(path.join(dir, name, 'skills')).then((s) => s.isDirectory(), () => false))) {
          found.push(rel);
          break;
        }
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  await walk(root, '', 0);
  return found.sort();
}

/** Fills `repoRoots` and `nestedDirs` for every workspace folder. */
export async function expandContext(ctx: DiscoveryContext, opts: { parents: boolean; nested: boolean }): Promise<DiscoveryContext> {
  const repoRoots: Record<string, string> = {};
  const nestedDirs: Record<string, string[]> = {};
  for (const folder of ctx.workspaceFolders) {
    if (opts.parents) {
      const root = await findRepoRoot(folder);
      if (root && path.resolve(root) !== path.resolve(folder)) repoRoots[folder] = root;
    }
    if (opts.nested) nestedDirs[folder] = await findNestedSkillDirs(folder);
  }
  return { ...ctx, repoRoots, nestedDirs };
}
