import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { moveDir, placeStaged } from './installer';
import type { LockStore } from './lockfile';
import { isPathInside, pathKey, safeJoin, validateRelativePath } from './paths';
import { NEW_FILE, pathExists, timestamp } from './safeWrite';
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

export interface TransferResult {
  targetDir: string;
  backupDir?: string;
  /** Where the source went after a move (recoverable). */
  sourceBackupDir?: string;
  /** Set when the copy succeeded but the original could not be moved away. */
  warning?: string;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;
export const TRANSFER_LIMITS = { maxFiles: 2000, maxBytes: 100 * BYTES_PER_MEGABYTE };
const ANY_EXECUTE_BIT = 0o111;

/** Why a skill can't be moved (copy is still possible), or undefined. */
export function moveBlocker(skill: SkillRecord, from: ResolvedLocation): string | undefined {
  if (skill.readOnly || from.readOnly) return `${skill.readOnlyReason ?? from.readOnlyReason ?? 'Read-only location'} — copy it instead.`;
  if (skill.isSymlink) return 'It is a symbolic link; moving it would change what other tools point at. Copy it instead.';
  if (pathKey(path.dirname(skill.dir)) !== pathKey(from.path)) return 'It is not directly inside its skills folder.';
  return undefined;
}

/** Every regular file of the skill (symlinks and odd entries are listed as skipped, never followed). */
async function listFilesToCopy(skill: SkillRecord): Promise<{ files: TransferFile[]; skipped: TransferPlan['skipped'] }> {
  const files: TransferFile[] = [];
  const skipped: TransferPlan['skipped'] = [];
  let totalBytes = 0;
  const tooLarge = () =>
    new UserError(`"${skill.name}" is too large to copy (limit ${TRANSFER_LIMITS.maxFiles} files / ${TRANSFER_LIMITS.maxBytes / BYTES_PER_MEGABYTE} MB).`);

  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);
      try {
        validateRelativePath(relativePath);
      } catch (error) {
        skipped.push({ path: relativePath, reason: (error as Error).message });
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.push({ path: relativePath, reason: 'symlink (not followed)' });
      } else if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        const fileStat = await fs.lstat(fullPath);
        totalBytes += fileStat.size;
        if (files.length >= TRANSFER_LIMITS.maxFiles || totalBytes > TRANSFER_LIMITS.maxBytes) throw tooLarge();
        files.push({ path: relativePath, size: fileStat.size, executable: (fileStat.mode & ANY_EXECUTE_BIT) !== 0 });
      } else {
        skipped.push({ path: relativePath, reason: 'not a regular file' });
      }
    }
  };
  await walk(skill.realDir, '');
  return { files, skipped };
}

/** Skills with the same name that an agent reading the destination would also see. */
function duplicatesAtDestination(skill: SkillRecord, to: ResolvedLocation, targetDir: string, allSkills: SkillRecord[]): TransferPlan['duplicates'] {
  const duplicates: TransferPlan['duplicates'] = [];
  for (const provider of to.readers) {
    for (const other of allSkills) {
      const isSameSkill = other.id === skill.id || pathKey(other.realDir) === pathKey(skill.realDir);
      const isBeingReplaced = pathKey(other.dir) === pathKey(targetDir);
      const clashes = other.name === skill.name && other.visibleTo.includes(provider);
      if (clashes && !isSameSkill && !isBeingReplaced) duplicates.push({ provider, dir: other.dir });
    }
  }
  return duplicates;
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
    const blocker = moveBlocker(skill, from);
    if (blocker) throw new UserError(`"${skill.name}" can't be moved: ${blocker}`);
  }
  const sourceStat = await fs.stat(skill.realDir).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new UserError(`"${skill.name}" no longer exists or its link is broken. Refresh the list.`);
  const targetDir = safeJoin(to.path, skill.dirName);
  const nestsIntoItself = isPathInside(targetDir, skill.realDir, true) || isPathInside(skill.realDir, targetDir, true);
  if (nestsIntoItself) throw new UserError('The destination is inside the skill itself (or the other way round).');
  const exists = await pathExists(targetDir);

  const { files, skipped } = await listFilesToCopy(skill);
  if (!files.some((file) => file.path === 'SKILL.md')) throw new UserError(`"${skill.name}" has no SKILL.md to copy.`);

  const agentsBefore = new Set(skill.visibleTo);
  const agentsAfter = new Set(mode === 'copy' ? [...skill.visibleTo, ...to.readers] : to.readers);
  const gained = [...agentsAfter].filter((agent) => !agentsBefore.has(agent));
  const lost = [...agentsBefore].filter((agent) => !agentsAfter.has(agent));

  return { mode, skill, from, to, targetDir, exists, files, skipped, gained, lost, duplicates: duplicatesAtDestination(skill, to, targetDir, allSkills) };
}

/** Writes each reviewed file into the staging folder; fails if anything changed since the review. */
async function copyToStaging(plan: TransferPlan, stagingDir: string): Promise<void> {
  for (const file of plan.files) {
    const source = safeJoin(plan.skill.realDir, file.path);
    const destination = safeJoin(stagingDir, file.path);
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isFile()) throw new UserError(`${file.path} changed since the review. Try again.`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await fs.readFile(source), NEW_FILE);
  }
}

export async function executeTransfer(
  plan: TransferPlan,
  overwrite: boolean,
  deps: { lock: LockStore; backupRoot: string; stagingRoot: string },
): Promise<TransferResult> {
  const { skill, to, targetDir, mode } = plan;
  if (plan.exists && !overwrite) throw new UserError(`"${skill.dirName}" already exists in ${to.label}. Confirm replacement to continue.`, 'conflict');
  const sourceStat = await fs.lstat(skill.dir).catch(() => null);
  if (!sourceStat) throw new UserError(`"${skill.name}" no longer exists. Refresh the list.`);
  if (mode === 'move' && sourceStat.isSymbolicLink()) throw new UserError(`"${skill.name}" is now a link; refusing to move it.`);

  const stagingDir = path.join(deps.stagingRoot, randomUUID(), skill.dirName);
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    await copyToStaging(plan, stagingDir);
    const lockEntry = deps.lock.get(skill.dir);
    const { backupDir } = await placeStaged({
      stagingDir,
      location: to,
      targetDir,
      exists: plan.exists,
      backupRoot: deps.backupRoot,
      onPlaced: async () => {
        // Provenance follows the files: the copy is the same version from the same source.
        if (lockEntry) await deps.lock.set({ ...lockEntry, dir: targetDir, locationPath: to.path, name: path.basename(targetDir) });
      },
    });
    const result: TransferResult = { targetDir, backupDir };
    if (mode === 'move') {
      try {
        await fs.mkdir(deps.backupRoot, { recursive: true });
        const sourceBackup = path.join(deps.backupRoot, `${timestamp()}-moved-${path.basename(skill.dir)}`);
        await moveDir(skill.dir, sourceBackup);
        result.sourceBackupDir = sourceBackup;
        if (lockEntry) await deps.lock.remove(skill.dir);
      } catch (error) {
        result.warning = `Copied, but the original could not be moved away (${(error as Error).message}). Both copies exist now.`;
      }
    }
    return result;
  } catch (error) {
    if (error instanceof UserError) throw error;
    const action = mode === 'move' ? 'Move' : 'Copy';
    throw new UserError(`${action} of "${skill.name}" failed and was rolled back: ${(error as Error).message}`, 'transfer-failed');
  } finally {
    await fs.rm(path.dirname(stagingDir), { recursive: true, force: true }).catch(() => undefined);
  }
}
