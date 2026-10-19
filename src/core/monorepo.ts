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

/** Dependency and build output folders: never worth walking into. */
export const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'venv', '__pycache__', 'coverage']);

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_FOLDERS = 5000;

const pathExists = (fullPath: string) => fs.lstat(fullPath).then(() => true, () => false);
const isDirectory = (fullPath: string) => fs.lstat(fullPath).then((stat) => stat.isDirectory(), () => false);

/**
 * Nearest folder at or above `start` that contains `.git` (a directory, or a
 * file in linked worktrees and submodules — the search stops there, as Claude
 * Code documents for worktrees). undefined when not inside a repository.
 */
export async function findRepoRoot(start: string, stopAt?: string): Promise<string | undefined> {
  let dir = path.resolve(start);
  for (;;) {
    if (await pathExists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    const reachedFilesystemRoot = parent === dir;
    const reachedStop = !!stopAt && dir === path.resolve(stopAt);
    if (reachedFilesystemRoot || reachedStop) return undefined;
    dir = parent;
  }
}

/** Folders strictly above `from` up to and including `root`; empty when `root` is not an ancestor. */
export function ancestorsUpTo(from: string, root: string): string[] {
  const ancestors: string[] = [];
  let dir = path.resolve(from);
  const top = path.resolve(root);
  while (dir !== top) {
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    ancestors.push(parent);
    dir = parent;
  }
  return ancestors;
}

export function shouldWalkInto(entry: { name: string; isDirectory(): boolean }): boolean {
  return entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name);
}

/**
 * Relative folders below `root` (not `root` itself) that contain a
 * `.claude/skills`, `.agents/skills` or `.cursor/skills` directory. Bounded:
 * skips hidden and build/dependency folders, never follows symlinks.
 */
export async function findNestedSkillDirs(root: string, limits: { maxDepth?: number; maxDirs?: number } = {}): Promise<string[]> {
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  let foldersLeft = limits.maxDirs ?? DEFAULT_MAX_FOLDERS;
  const found: string[] = [];

  const hasNestedSkillsFolder = async (dir: string, entryNames: Set<string>) => {
    for (const parentName of NESTED_SKILL_PARENTS) {
      if (entryNames.has(parentName) && (await isDirectory(path.join(dir, parentName, 'skills')))) return true;
    }
    return false;
  };

  const walk = async (dir: string, relativeDir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || foldersLeft-- <= 0) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const isWorkspaceRoot = relativeDir === '';
    const directoryNames = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    if (!isWorkspaceRoot && (await hasNestedSkillsFolder(dir, directoryNames))) found.push(relativeDir);
    for (const entry of entries) {
      if (!shouldWalkInto(entry)) continue;
      const childRelative = isWorkspaceRoot ? entry.name : `${relativeDir}/${entry.name}`;
      await walk(path.join(dir, entry.name), childRelative, depth + 1);
    }
  };

  await walk(root, '', 0);
  return found.sort();
}

/** Fills `repoRoots` and `nestedDirs` for every workspace folder. */
export async function expandContext(context: DiscoveryContext, include: { parents: boolean; nested: boolean }): Promise<DiscoveryContext> {
  const repoRoots: Record<string, string> = {};
  const nestedDirs: Record<string, string[]> = {};
  for (const folder of context.workspaceFolders) {
    if (include.parents) {
      const repoRoot = await findRepoRoot(folder);
      const isAboveFolder = !!repoRoot && path.resolve(repoRoot) !== path.resolve(folder);
      if (isAboveFolder) repoRoots[folder] = repoRoot;
    }
    if (include.nested) nestedDirs[folder] = await findNestedSkillDirs(folder);
  }
  return { ...context, repoRoots, nestedDirs };
}
