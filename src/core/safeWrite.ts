import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * The only ways this extension writes files: new files never overwrite
 * anything and are never executable; replaced files keep a backup and are
 * swapped in with a rename so a crash never leaves half a file.
 */

/** `wx` fails if anything (file or link) already exists at the path; 0o644 = never executable. */
export const NEW_FILE = { flag: 'wx', mode: 0o644 } as const;

const TEMP_SUFFIX_BYTES = 4;
const BACKUP_SUFFIX_LENGTH = 6;

/**
 * Prefix for backup names: sortable time plus a random suffix, so two backups
 * of same-named folders in the same millisecond never collide.
 */
export function timestamp(): string {
  const sortableTime = new Date().toISOString().replace(/[:.]/g, '-');
  return `${sortableTime}-${randomUUID().slice(0, BACKUP_SUFFIX_LENGTH)}`;
}

export const pathExists = (fullPath: string) => fs.lstat(fullPath).then(() => true, () => false);

export function isCrossDeviceError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EXDEV';
}

function tempPathNextTo(file: string): string {
  const suffix = randomBytes(TEMP_SUFFIX_BYTES).toString('hex');
  return path.join(path.dirname(file), `.${path.basename(file)}.${suffix}.tmp`);
}

/** Writes `content` to a temp file next to `file`, then renames it over `file`. */
export async function writeAtomically(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = tempPathNextTo(file);
  try {
    await fs.writeFile(tempFile, content, NEW_FILE);
    await fs.rename(tempFile, file);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Saves `content` as a new, timestamped file in the backup folder and returns its path. */
export async function saveBackup(content: string, backupRoot: string, name: string): Promise<string> {
  await fs.mkdir(backupRoot, { recursive: true });
  const backupFile = path.join(backupRoot, `${timestamp()}-${name}`);
  await fs.writeFile(backupFile, content, NEW_FILE);
  return backupFile;
}

/** Backup name that still says which file it was: `<parent folder>-<file name>`. */
export function backupNameFor(file: string): string {
  return `${path.basename(path.dirname(file))}-${path.basename(file)}`;
}

/**
 * Replaces a text file, keeping a backup of the previous content. Returns the
 * backup path, or undefined when the file did not exist or nothing changed.
 */
export async function replaceWithBackup(file: string, nextContent: string, backupRoot: string, backupName = backupNameFor(file)): Promise<string | undefined> {
  const previousContent = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (previousContent === nextContent) return undefined;
  const backup = previousContent === undefined ? undefined : await saveBackup(previousContent, backupRoot, backupName);
  await writeAtomically(file, nextContent);
  return backup;
}
