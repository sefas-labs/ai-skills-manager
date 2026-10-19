import * as path from 'node:path';
import { UserError } from './types';

const MAX_RELATIVE_PATH_LENGTH = 400;
const PATH_PREVIEW_LENGTH = 60;
const MAX_SKILL_NAME_LENGTH = 64;
const FALLBACK_SKILL_NAME = 'skill';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const WINDOWS_INVALID_CHARACTER = /[<>:"|?*\x00-\x1f]/;
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/;
const ENDS_WITH_DOT_OR_SPACE = /[. ]$/;
const COMBINING_ACCENT = /[̀-ͯ]/g;

/** Agent Skills spec: lowercase letters and digits, joined by single hyphens. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** True when `child` is `parent` itself or lives below it (no `..` escape). */
export function isPathInside(child: string, parent: string, allowEqual = false): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  if (relativePath === '') return allowEqual;
  const firstSegment = relativePath.split(path.sep)[0];
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath) && firstSegment !== '..';
}

function badPath(message: string): UserError {
  return new UserError(message, 'bad-path');
}

/**
 * Validates a repository-relative POSIX path coming from an untrusted source
 * (GitHub tree) and returns its segments. Throws on anything that could escape
 * the destination or misbehave on some OS.
 */
export function validateRelativePath(relativePath: string): string[] {
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw badPath('Empty path.');
  if (relativePath.length > MAX_RELATIVE_PATH_LENGTH) throw badPath(`Path too long: ${relativePath.slice(0, PATH_PREVIEW_LENGTH)}…`);
  if (relativePath.includes('\0')) throw badPath('Path contains a NUL byte.');
  if (relativePath.includes('\\')) throw badPath(`Backslashes are not allowed in paths: ${relativePath}`);
  if (relativePath.startsWith('/') || WINDOWS_DRIVE_PREFIX.test(relativePath)) throw badPath(`Absolute paths are not allowed: ${relativePath}`);
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw badPath(`Invalid path segment in "${relativePath}".`);
    if (WINDOWS_INVALID_CHARACTER.test(segment)) throw badPath(`Path "${relativePath}" has characters that are invalid on Windows.`);
    if (WINDOWS_RESERVED_NAME.test(segment)) throw badPath(`Path "${relativePath}" uses a reserved Windows name.`);
    if (ENDS_WITH_DOT_OR_SPACE.test(segment)) throw badPath(`Path "${relativePath}" has a segment ending in a dot or space.`);
  }
  return segments;
}

/** Joins an untrusted relative path onto `root`, guaranteeing the result stays inside it. */
export function safeJoin(root: string, relativePath: string): string {
  const segments = validateRelativePath(relativePath);
  const target = path.resolve(root, ...segments);
  if (!isPathInside(target, root)) throw new UserError(`Path escapes destination: ${relativePath}`, 'path-traversal');
  return target;
}

/** Turns any string into a valid Agent Skills name (spec: a-z0-9 and single hyphens, ≤64). */
export function toSkillDirName(input: string): string {
  const name = input
    .normalize('NFKD')
    .replace(COMBINING_ACCENT, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_SKILL_NAME_LENGTH)
    .replace(/-+$/g, '');
  return name || FALLBACK_SKILL_NAME;
}

/** `~`-style display path. */
export function tildify(fullPath: string, home: string): string {
  const isUnderHome = !!home && (fullPath === home || isPathInside(fullPath, home));
  if (!isUnderHome) return fullPath;
  const relativePath = path.relative(home, fullPath);
  return relativePath ? `~${path.sep}${relativePath}` : '~';
}

/** Stable comparison key for paths (case-insensitive on macOS/Windows default filesystems). */
export function pathKey(fullPath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(fullPath);
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}
