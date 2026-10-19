import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseFrontmatter } from './frontmatter';
import type { LockStore } from './lockfile';
import { pathKey, safeJoin, SKILL_NAME_RE } from './paths';
import { pathExists, replaceWithBackup, saveBackup } from './safeWrite';
import { ResolvedLocation, SkillRecord, UserError } from './types';

/**
 * One-click fixes for the problems validation reports. Only fixes whose result
 * is unambiguous are offered; everything else is left to the user ("Open
 * SKILL.md"). Every change keeps a backup and SKILL.md edits are minimal
 * line edits, verified by re-parsing before anything is written.
 */
export type FixId = 'set-name-to-folder' | 'rename-folder-to-name' | 'add-name' | 'add-description' | 'add-frontmatter' | 'rename-skill-file' | 'remove-broken-link';

export interface FixOption {
  id: FixId;
  /** Issue codes this fix resolves. */
  codes: string[];
  label: string;
  /** Exact change, shown in the confirmation. */
  detail: string;
  /** The user must type a description first. */
  needsDescription?: boolean;
}

export interface FixResult {
  /** What changed, for the confirmation toast. */
  summary: string;
  backup?: string;
  /** New folder path when the skill folder was renamed. */
  newDir?: string;
}

const SKILL_FILE_NAME = 'SKILL.md';
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const BYTE_ORDER_MARK = '﻿';
const TEMP_SUFFIX_BYTES = 4;

const FRONTMATTER_FENCE = /^---\s*$/;
const FRONTMATTER_END = /^(---|\.\.\.)\s*$/;
/** Characters that YAML reads as plain text when unquoted. */
const SAFE_PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 _.,()/-]*$/;
/** Words YAML would read as booleans or null. */
const YAML_KEYWORD = /^(true|false|null|yes|no|~)$/i;
const LOOKS_LIKE_NUMBER = /^-?\d/;
/** `|` or `>`: the value continues on the next lines. */
const BLOCK_SCALAR_INDICATOR = /^[|>]/;
const INDENTED_CONTINUATION = /^\s+\S/;

function isValidSkillName(name: string | undefined): name is string {
  return !!name && SKILL_NAME_RE.test(name) && name.length <= MAX_NAME_LENGTH;
}

export function fixesFor(skill: SkillRecord, location: ResolvedLocation | undefined): FixOption[] {
  if (skill.readOnly || location?.readOnly) return [];
  const issueCodes = new Set(skill.issues.map((issue) => issue.code));
  const has = (code: string) => issueCodes.has(code);
  const folderNameIsValid = isValidSkillName(skill.dirName);
  const declaredName = typeof skill.frontmatter['name'] === 'string' ? (skill.frontmatter['name'] as string) : undefined;
  const isDirectlyInLocation = !!location && pathKey(path.dirname(skill.dir)) === pathKey(location.path);

  if (has('broken-symlink')) {
    return [{ id: 'remove-broken-link', codes: ['broken-symlink'], label: 'Remove broken link', detail: `Delete the symbolic link ${skill.dir} (its target no longer exists).` }];
  }
  if (has('skill-file-case')) {
    return [{ id: 'rename-skill-file', codes: ['skill-file-case'], label: `Rename to ${SKILL_FILE_NAME}`, detail: `Rename ${path.basename(skill.skillFile)} to ${SKILL_FILE_NAME}.` }];
  }
  if (has('frontmatter-missing') && folderNameIsValid) {
    return [
      {
        id: 'add-frontmatter',
        codes: ['frontmatter-missing'],
        label: 'Add frontmatter',
        detail: `Add a frontmatter block with name: ${skill.dirName} and the description you type.`,
        needsDescription: true,
      },
    ];
  }

  const fixes: FixOption[] = [];
  if (has('name-missing') && folderNameIsValid) {
    fixes.push({ id: 'add-name', codes: ['name-missing'], label: `Add name: ${skill.dirName}`, detail: `Add \`name: ${skill.dirName}\` to the frontmatter.` });
  }
  if ((has('name-mismatch') || has('name-format')) && folderNameIsValid) {
    fixes.push({
      id: 'set-name-to-folder',
      codes: ['name-mismatch', 'name-format'],
      label: `Set name to "${skill.dirName}"`,
      detail: `Change \`name: ${declaredName}\` to \`name: ${skill.dirName}\` (the folder name).`,
    });
  }
  const canRenameFolder = isValidSkillName(declaredName) && !skill.isSymlink && isDirectlyInLocation && !skill.managed;
  if (has('name-mismatch') && canRenameFolder) {
    fixes.push({
      id: 'rename-folder-to-name',
      codes: ['name-mismatch'],
      label: `Rename folder to "${declaredName}"`,
      detail: `Rename the folder ${skill.dirName} to ${declaredName}.`,
    });
  }
  if (has('description-missing')) {
    fixes.push({ id: 'add-description', codes: ['description-missing'], label: 'Add description', detail: 'Add the description you type to the frontmatter.', needsDescription: true });
  }
  return fixes;
}

/** YAML scalar that our parser (and any YAML parser) reads back as exactly `value`. */
export function yamlScalar(value: string): string {
  const canStayUnquoted = SAFE_PLAIN_SCALAR.test(value) && !YAML_KEYWORD.test(value) && !LOOKS_LIKE_NUMBER.test(value);
  return canStayUnquoted ? value : JSON.stringify(value);
}

function lineEndingOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Sets a top-level frontmatter key with a one-line edit, keeping everything
 * else byte-for-byte (line endings, comments, order). Refuses block scalars.
 */
export function setFrontmatterKey(source: string, key: string, value: string): string {
  const byteOrderMark = source.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : '';
  const text = source.slice(byteOrderMark.length);
  const lineEnding = lineEndingOf(text);
  const lines = text.split(/\r?\n/);
  if (!FRONTMATTER_FENCE.test(lines[0] ?? '')) throw new UserError('SKILL.md has no frontmatter.', 'fix');
  const closingLine = lines.findIndex((line, index) => index > 0 && FRONTMATTER_END.test(line));
  if (closingLine === -1) throw new UserError('The frontmatter is not closed with "---".', 'fix');

  const keyLinePattern = new RegExp(`^${key}\\s*:(.*)$`);
  const keyLine = lines.findIndex((line, index) => index > 0 && index < closingLine && keyLinePattern.test(line));
  const newLine = `${key}: ${yamlScalar(value)}`;
  if (keyLine === -1) {
    lines.splice(1, 0, newLine);
  } else {
    const currentValue = keyLinePattern.exec(lines[keyLine])![1].trim();
    const valueContinuesBelow = currentValue === '' && keyLine + 1 < closingLine && INDENTED_CONTINUATION.test(lines[keyLine + 1]);
    if (BLOCK_SCALAR_INDICATOR.test(currentValue) || valueContinuesBelow) {
      throw new UserError(`\`${key}\` spans several lines; edit it by hand.`, 'fix');
    }
    lines[keyLine] = newLine;
  }

  const result = byteOrderMark + lines.join(lineEnding);
  const reparsed = parseFrontmatter(result);
  if (reparsed.error || reparsed.data[key] !== value) throw new UserError(`Could not set \`${key}\` safely; edit SKILL.md by hand.`, 'fix');
  return result;
}

export function addFrontmatter(source: string, name: string, description: string): string {
  const lineEnding = lineEndingOf(source);
  const body = source.startsWith(BYTE_ORDER_MARK) ? source.slice(BYTE_ORDER_MARK.length) : source;
  const result = ['---', `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`, '---', '', body].join(lineEnding);
  const reparsed = parseFrontmatter(result);
  const roundTrips = !reparsed.error && reparsed.data['name'] === name && reparsed.data['description'] === description;
  if (!roundTrips) throw new UserError('Could not build a valid frontmatter.', 'fix');
  return result;
}

export function cleanDescription(input: string): string {
  const description = input.replace(/\s+/g, ' ').trim();
  if (!description) throw new UserError('The description cannot be empty.', 'fix');
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new UserError(`The description is ${description.length} characters; the spec allows ${MAX_DESCRIPTION_LENGTH}.`, 'fix');
  }
  return description;
}

type FixDeps = { lock: LockStore; backupRoot: string; description?: string };

async function removeBrokenLink(skill: SkillRecord, deps: FixDeps): Promise<FixResult> {
  const linkStat = await fs.lstat(skill.dir).catch(() => null);
  if (!linkStat?.isSymbolicLink()) throw new UserError(`${skill.dir} is no longer a link.`, 'fix');
  const linkWorksAgain = await fs.stat(skill.dir).then(() => true, () => false);
  if (linkWorksAgain) throw new UserError('The link works again; nothing to fix.', 'fix');
  const linkTarget = await fs.readlink(skill.dir);
  const backup = await saveBackup(linkTarget, deps.backupRoot, `${skill.dirName}.symlink.txt`);
  await fs.unlink(skill.dir);
  await deps.lock.remove(skill.dir);
  return { summary: `Removed the broken link "${skill.dirName}".`, backup };
}

async function renameSkillFile(skill: SkillRecord): Promise<FixResult> {
  const names = await fs.readdir(skill.realDir);
  const wrongCaseName = names.find((name) => name !== SKILL_FILE_NAME && name.toLowerCase() === SKILL_FILE_NAME.toLowerCase());
  if (!wrongCaseName) throw new UserError('No mis-cased skill.md found any more.', 'fix');
  if (names.includes(SKILL_FILE_NAME)) throw new UserError('Both SKILL.md and skill.md exist; merge them by hand.', 'fix');
  // Two steps so the case-only rename also works on case-insensitive file systems.
  const tempName = `.skill-md-${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')}.tmp`;
  const tempPath = path.join(skill.realDir, tempName);
  await fs.rename(path.join(skill.realDir, wrongCaseName), tempPath);
  await fs.rename(tempPath, path.join(skill.realDir, SKILL_FILE_NAME));
  return { summary: `Renamed ${wrongCaseName} to ${SKILL_FILE_NAME}.` };
}

async function renameFolderToName(skill: SkillRecord, location: ResolvedLocation, deps: FixDeps): Promise<FixResult> {
  const name = skill.frontmatter['name'] as string;
  const target = safeJoin(location.path, name);
  if (await pathExists(target)) throw new UserError(`A folder named "${name}" already exists in ${location.label}.`, 'fix');
  const folderStat = await fs.lstat(skill.dir);
  if (folderStat.isSymbolicLink() || !folderStat.isDirectory()) throw new UserError(`${skill.dir} is no longer a folder.`, 'fix');
  await fs.rename(skill.dir, target);
  const lockEntry = deps.lock.get(skill.dir);
  if (lockEntry) {
    await deps.lock.set({ ...lockEntry, dir: target, name });
    await deps.lock.remove(skill.dir);
  }
  return { summary: `Renamed the folder to "${name}".`, newDir: target };
}

function editedSkillMd(original: string, skill: SkillRecord, fixId: FixId, typedDescription: string | undefined): string {
  if (fixId === 'set-name-to-folder' || fixId === 'add-name') return setFrontmatterKey(original, 'name', skill.dirName);
  const description = cleanDescription(typedDescription ?? '');
  if (fixId === 'add-frontmatter') return addFrontmatter(original, skill.dirName, description);
  return setFrontmatterKey(original, 'description', description);
}

/**
 * Applies one fix. Re-checks the state on disk first (it may have changed
 * since the scan). SKILL.md is replaced atomically after a backup copy.
 */
export async function applyFix(skill: SkillRecord, location: ResolvedLocation, fixId: FixId, deps: FixDeps): Promise<FixResult> {
  const offered = fixesFor(skill, location).find((fix) => fix.id === fixId);
  if (!offered) throw new UserError('This fix no longer applies. Refresh the list.', 'fix');

  switch (fixId) {
    case 'remove-broken-link':
      return removeBrokenLink(skill, deps);
    case 'rename-skill-file':
      return renameSkillFile(skill);
    case 'rename-folder-to-name':
      return renameFolderToName(skill, location, deps);
    default: {
      const file = path.join(skill.realDir, SKILL_FILE_NAME);
      const original = await fs.readFile(file, 'utf8');
      const edited = editedSkillMd(original, skill, fixId, deps.description);
      const backup = await replaceSkillMd(file, original, edited, skill.dirName, deps.backupRoot);
      return { summary: `${offered.label} — SKILL.md updated.`, backup };
    }
  }
}

async function replaceSkillMd(file: string, original: string, edited: string, dirName: string, backupRoot: string): Promise<string | undefined> {
  const current = await fs.readFile(file, 'utf8');
  if (current !== original) throw new UserError('SKILL.md changed while preparing the fix. Try again.', 'fix');
  return replaceWithBackup(file, edited, backupRoot, `${dirName}-${SKILL_FILE_NAME}`);
}
