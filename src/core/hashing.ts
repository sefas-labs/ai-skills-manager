import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { UserError } from './types';

/** Content identity of skill folders, compatible with git object ids. */

/** Git blob id of some bytes (what `git hash-object` prints). */
export function gitBlobSha(buf: Uint8Array): string {
  return createHash('sha1').update(`blob ${buf.byteLength}\0`).update(buf).digest('hex');
}

/** Relative POSIX path → git blob SHA for every regular file under `dir`. Symlinks inside the skill are not followed. */
export async function localFileShas(dir: string, maxFiles = 2000): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (out.size >= maxFiles) throw new UserError(`More than ${maxFiles} files in ${dir}.`);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, r);
      else if (e.isFile()) out.set(r, gitBlobSha(await fs.readFile(p)));
    }
  };
  await walk(dir, '');
  return out;
}

/** One id for a whole folder: equal ids = byte-identical files at the same paths. */
export async function contentFingerprint(dir: string): Promise<string> {
  const files = await localFileShas(dir);
  return createHash('sha1').update(JSON.stringify([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))).digest('hex');
}
