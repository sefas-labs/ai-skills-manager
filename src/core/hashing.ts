import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { UserError } from './types';

/** Content identity of skill folders, compatible with git object ids. */

const DEFAULT_MAX_FILES = 2000;

/** Git blob id of some bytes (what `git hash-object` prints). */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/** Relative POSIX path → git blob SHA for every regular file under `dir`. Symlinks inside the skill are not followed. */
export async function localFileShas(dir: string, maxFiles = DEFAULT_MAX_FILES): Promise<Map<string, string>> {
  const shaByPath = new Map<string, string>();
  const walk = async (currentDir: string, relativeDir: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (shaByPath.size >= maxFiles) throw new UserError(`More than ${maxFiles} files in ${dir}.`);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) await walk(fullPath, relativePath);
      else if (entry.isFile()) shaByPath.set(relativePath, gitBlobSha(await fs.readFile(fullPath)));
    }
  };
  await walk(dir, '');
  return shaByPath;
}

function byPath([firstPath]: [string, string], [secondPath]: [string, string]): number {
  if (firstPath < secondPath) return -1;
  if (firstPath > secondPath) return 1;
  return 0;
}

/** One id for a whole folder: equal ids = byte-identical files at the same paths. */
export async function contentFingerprint(dir: string): Promise<string> {
  const files = await localFileShas(dir);
  const sortedEntries = [...files].sort(byPath);
  return createHash('sha1').update(JSON.stringify(sortedEntries)).digest('hex');
}
