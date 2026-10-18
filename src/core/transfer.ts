import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { moveDir, placeStaged, timestamp } from './installer';
import type { LockStore } from './lockfile';
import { isPathInside, pathKey, safeJoin, validateRelativePath } from './paths';
import { ProviderId, ResolvedLocation, SkillRecord, UserError } from './types';

/**
 * Copy or move a skill between skills folders (global ↔ workspace,
 * .claude/skills ↔ .agents/skills…). Files are re-written through a private
 * staging folder with the same rules as a GitHub install: safeJoin, 'wx',
 * 0o644, symlinks inside the skill are not followed. A replaced destination
 * and a moved source both end up in the backup folder, never deleted.
 */
export type TransferMode = 'copy' | 'move';

export interface TransferFile {
  path: string;
  size: number;
  executable: boolean;
}

export interface TransferPlan {
  mode: TransferMode;
  skill: SkillRecord;
  from: ResolvedLocation;
  to: ResolvedLocation;
  targetDir: string;
  exists: boolean;
  files: TransferFile[];
  skipped: Array<{ path: string; reason: string }>;
  /** Agents that see this skill after but not before, and the reverse. */
  gained: ProviderId[];
  lost: ProviderId[];
  /** Other skills with the same name that an agent reading the destination already sees. */
  duplicates: Array<{ provider: ProviderId; dir: string }>;
}

export const TRANSFER_LIMITS = { maxFiles: 2000, maxBytes: 100 * 1024 * 1024 };

/** Why a skill can't be moved (copy is still possible), or undefined. */
export function moveBlocker(skill: SkillRecord, from: ResolvedLocation): string | undefined {
  if (skill.readOnly || from.readOnly) return `${skill.readOnlyReason ?? from.readOnlyReason ?? 'Read-only location'} — copy it instead.`;
  if (skill.isSymlink) return 'It is a symbolic link; moving it would change what other tools point at. Copy it instead.';
  if (pathKey(path.dirname(skill.dir)) !== pathKey(from.path)) return 'It is not directly inside its skills folder.';
  return undefined;
}

export async function planTransfer(
  skill: SkillRecord,
  from: ResolvedLocation,
  to: ResolvedLocation,
  mode: TransferMode,
  allSkills: SkillRecord[],
): Promise<TransferPlan> {
  if (to.readOnly) throw new UserError(`${to.label} is read-only: ${to.readOnlyReason ?? ''}`.trim());
  if (pathKey(to.path) === pathKey(from.path)) throw new UserError('Choose a different folder.');
  if (mode === 'move') {
    const why = moveBlocker(skill, from);
    if (why) throw new UserError(`"${skill.name}" can't be moved: ${why}`);
  }
  const st = await fs.stat(skill.realDir).catch(() => null);
  if (!st?.isDirectory()) throw new UserError(`"${skill.name}" no longer exists or its link is broken. Refresh the list.`);
  const targetDir = safeJoin(to.path, skill.dirName);
  if (isPathInside(targetDir, skill.realDir, true) || isPathInside(skill.realDir, targetDir, true)) {
    throw new UserError('The destination is inside the skill itself (or the other way round).');
  }
  let exists = false;
  try {
    await fs.lstat(targetDir);
    exists = true;
  } catch {
    /* free */
  }

  const files: TransferFile[] = [];
  const skipped: TransferPlan['skipped'] = [];
  let bytes = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      try {
        validateRelativePath(r);
      } catch (err) {
        skipped.push({ path: r, reason: (err as Error).message });
        continue;
      }
      if (e.isSymbolicLink()) skipped.push({ path: r, reason: 'symlink (not followed)' });
      else if (e.isDirectory()) await walk(p, r);
      else if (e.isFile()) {
        const fst = await fs.lstat(p);
        bytes += fst.size;
        if (files.length >= TRANSFER_LIMITS.maxFiles || bytes > TRANSFER_LIMITS.maxBytes) {
          throw new UserError(`"${skill.name}" is too large to copy (limit ${TRANSFER_LIMITS.maxFiles} files / ${TRANSFER_LIMITS.maxBytes / 1024 / 1024} MB).`);
        }
        files.push({ path: r, size: fst.size, executable: (fst.mode & 0o111) !== 0 });
      } else skipped.push({ path: r, reason: 'not a regular file' });
    }
  };
  await walk(skill.realDir, '');
  if (!files.some((f) => f.path === 'SKILL.md')) throw new UserError(`"${skill.name}" has no SKILL.md to copy.`);

  const before = new Set(skill.visibleTo);
  const after = new Set(mode === 'copy' ? [...skill.visibleTo, ...to.readers] : to.readers);
  const gained = [...after].filter((p) => !before.has(p));
  const lost = [...before].filter((p) => !after.has(p));

  const duplicates: TransferPlan['duplicates'] = [];
  for (const provider of to.readers) {
    for (const other of allSkills) {
      if (other.id === skill.id || other.name !== skill.name || !other.visibleTo.includes(provider)) continue;
      if (pathKey(other.realDir) === pathKey(skill.realDir)) continue;
      if (pathKey(other.dir) === pathKey(targetDir)) continue; // the one being replaced
      duplicates.push({ provider, dir: other.dir });
    }
  }
  return { mode, skill, from, to, targetDir, exists, files, skipped, gained, lost, duplicates };
}

export interface TransferResult {
  targetDir: string;
  backupDir?: string;
  /** Where the source went after a move (recoverable). */
  sourceBackupDir?: string;
  /** Set when the copy succeeded but the original could not be moved away. */
  warning?: string;
}

export async function executeTransfer(
  plan: TransferPlan,
  overwrite: boolean,
  deps: { lock: LockStore; backupRoot: string; stagingRoot: string },
): Promise<TransferResult> {
  const { skill, to, targetDir, mode } = plan;
  if (plan.exists && !overwrite) throw new UserError(`"${skill.dirName}" already exists in ${to.label}. Confirm replacement to continue.`, 'conflict');
  // Re-check at action time.
  const src = await fs.lstat(skill.dir).catch(() => null);
  if (!src) throw new UserError(`"${skill.name}" no longer exists. Refresh the list.`);
  if (mode === 'move' && src.isSymbolicLink()) throw new UserError(`"${skill.name}" is now a link; refusing to move it.`);

  const stagingDir = path.join(deps.stagingRoot, randomUUID(), skill.dirName);
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    for (const f of plan.files) {
      const from = safeJoin(skill.realDir, f.path);
      const dest = safeJoin(stagingDir, f.path);
      const fst = await fs.lstat(from);
      if (!fst.isFile()) throw new UserError(`${f.path} changed since the review. Try again.`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // 'wx' never follows or overwrites an existing entry; 0o644 = never executable.
      await fs.writeFile(dest, await fs.readFile(from), { flag: 'wx', mode: 0o644 });
    }
    const entry = deps.lock.get(skill.dir);
    const { backupDir } = await placeStaged({
      stagingDir,
      location: to,
      targetDir,
      exists: plan.exists,
      backupRoot: deps.backupRoot,
      onPlaced: async () => {
        // Provenance follows the files: the copy is the same version from the same source.
        if (entry) await deps.lock.set({ ...entry, dir: targetDir, locationPath: to.path, name: path.basename(targetDir) });
      },
    });
    const result: TransferResult = { targetDir, backupDir };
    if (mode === 'move') {
      try {
        await fs.mkdir(deps.backupRoot, { recursive: true });
        const dest = path.join(deps.backupRoot, `${timestamp()}-moved-${path.basename(skill.dir)}`);
        await moveDir(skill.dir, dest);
        result.sourceBackupDir = dest;
        if (entry) await deps.lock.remove(skill.dir);
      } catch (e) {
        result.warning = `Copied, but the original could not be moved away (${(e as Error).message}). Both copies exist now.`;
      }
    }
    return result;
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`${mode === 'move' ? 'Move' : 'Copy'} of "${skill.name}" failed and was rolled back: ${(e as Error).message}`, 'transfer-failed');
  } finally {
    await fs.rm(path.dirname(stagingDir), { recursive: true, force: true }).catch(() => undefined);
  }
}
