import * as path from 'node:path';
import { UserError } from './types';

/** True when `child` is `parent` itself or lives below it (no `..` escape). */
export function isPathInside(child: string, parent: string, allowEqual = false): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return allowEqual;
  return !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Validates a repository-relative POSIX path coming from an untrusted source
 * (GitHub tree) and returns its segments. Throws on anything that could escape
 * the destination or misbehave on some OS.
 */
export function validateRelativePath(rel: string): string[] {
  if (typeof rel !== 'string' || rel.length === 0) throw new UserError('Empty path.', 'bad-path');
  if (rel.length > 400) throw new UserError(`Path too long: ${rel.slice(0, 60)}…`, 'bad-path');
  if (rel.includes('\0')) throw new UserError('Path contains a NUL byte.', 'bad-path');
  if (rel.includes('\\')) throw new UserError(`Backslashes are not allowed in paths: ${rel}`, 'bad-path');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new UserError(`Absolute paths are not allowed: ${rel}`, 'bad-path');
  const segments = rel.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') throw new UserError(`Invalid path segment in "${rel}".`, 'bad-path');
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) throw new UserError(`Path "${rel}" has characters that are invalid on Windows.`, 'bad-path');
    if (WINDOWS_RESERVED.test(seg)) throw new UserError(`Path "${rel}" uses a reserved Windows name.`, 'bad-path');
    if (/[. ]$/.test(seg)) throw new UserError(`Path "${rel}" has a segment ending in a dot or space.`, 'bad-path');
  }
  return segments;
}

/** Joins an untrusted relative path onto `root`, guaranteeing the result stays inside it. */
export function safeJoin(root: string, rel: string): string {
  const segments = validateRelativePath(rel);
  const target = path.resolve(root, ...segments);
  if (!isPathInside(target, root)) throw new UserError(`Path escapes destination: ${rel}`, 'path-traversal');
  return target;
}

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Turns any string into a valid Agent Skills name (spec: a-z0-9 and single hyphens, ≤64). */
export function toSkillDirName(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return s || 'skill';
}

/** `~`-style display path. */
export function tildify(p: string, home: string): string {
  if (home && (p === home || isPathInside(p, home))) {
    const rel = path.relative(home, p);
    return rel ? `~${path.sep}${rel}` : '~';
  }
  return p;
}

/** Stable comparison key for paths (case-insensitive on macOS/Windows default filesystems). */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const r = path.resolve(p);
  return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
}
