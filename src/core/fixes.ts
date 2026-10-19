import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseFrontmatter } from './frontmatter';
import { timestamp } from './installer';
import type { LockStore } from './lockfile';
import { pathKey, safeJoin, SKILL_NAME_RE } from './paths';
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

export function fixesFor(skill: SkillRecord, location: ResolvedLocation | undefined): FixOption[] {
  if (skill.readOnly || location?.readOnly) return [];
  const codes = new Set(skill.issues.map((i) => i.code));
  const out: FixOption[] = [];
  const dirOk = SKILL_NAME_RE.test(skill.dirName) && skill.dirName.length <= 64;
  const name = typeof skill.frontmatter['name'] === 'string' ? (skill.frontmatter['name'] as string) : undefined;
  const nameOk = !!name && SKILL_NAME_RE.test(name) && name.length <= 64;
  const directlyInside = !!location && pathKey(path.dirname(skill.dir)) === pathKey(location.path);

  if (codes.has('broken-symlink')) {
    out.push({ id: 'remove-broken-link', codes: ['broken-symlink'], label: 'Remove broken link', detail: `Delete the symbolic link ${skill.dir} (its target no longer exists).` });
    return out;
  }
  if (codes.has('skill-file-case')) {
    out.push({ id: 'rename-skill-file', codes: ['skill-file-case'], label: 'Rename to SKILL.md', detail: `Rename ${path.basename(skill.skillFile)} to SKILL.md.` });
    return out;
  }
  if (codes.has('frontmatter-missing') && dirOk) {
    out.push({
      id: 'add-frontmatter',
      codes: ['frontmatter-missing'],
      label: 'Add frontmatter',
      detail: `Add a frontmatter block with name: ${skill.dirName} and the description you type.`,
      needsDescription: true,
    });
    return out;
  }
  if (codes.has('name-missing') && dirOk) {
    out.push({ id: 'add-name', codes: ['name-missing'], label: `Add name: ${skill.dirName}`, detail: `Add \`name: ${skill.dirName}\` to the frontmatter.` });
  }
  if ((codes.has('name-mismatch') || codes.has('name-format')) && dirOk) {
    out.push({
      id: 'set-name-to-folder',
      codes: ['name-mismatch', 'name-format'],
      label: `Set name to "${skill.dirName}"`,
      detail: `Change \`name: ${name}\` to \`name: ${skill.dirName}\` (the folder name).`,
    });
  }
  if (codes.has('name-mismatch') && nameOk && !skill.isSymlink && directlyInside && !skill.managed) {
    out.push({
      id: 'rename-folder-to-name',
      codes: ['name-mismatch'],
      label: `Rename folder to "${name}"`,
      detail: `Rename the folder ${skill.dirName} to ${name}.`,
    });
  }
  if (codes.has('description-missing')) {
    out.push({ id: 'add-description', codes: ['description-missing'], label: 'Add description', detail: 'Add the description you type to the frontmatter.', needsDescription: true });
  }
  return out;
}

/** YAML scalar that our parser (and any YAML parser) reads back as exactly `v`. */
export function yamlScalar(v: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _.,()/-]*$/.test(v) && !/^(true|false|null|yes|no|~)$/i.test(v) && !/^-?\d/.test(v) ? v : JSON.stringify(v);
}

/**
 * Sets a top-level frontmatter key with a one-line edit, keeping everything
 * else byte-for-byte (line endings, comments, order). Refuses block scalars.
 */
export function setFrontmatterKey(source: string, key: string, value: string): string {
  const bom = source.startsWith('﻿') ? '﻿' : '';
  const text = source.slice(bom.length);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? '')) throw new UserError('SKILL.md has no frontmatter.', 'fix');
  const end = lines.findIndex((l, i) => i > 0 && (/^---\s*$/.test(l) || /^\.\.\.\s*$/.test(l)));
  if (end === -1) throw new UserError('The frontmatter is not closed with "---".', 'fix');
  const re = new RegExp(`^${key}\\s*:(.*)$`);
  const at = lines.findIndex((l, i) => i > 0 && i < end && re.test(l));
  const line = `${key}: ${yamlScalar(value)}`;
  if (at === -1) lines.splice(1, 0, line);
  else {
    const rest = re.exec(lines[at])![1].trim();
    if (/^[|>]/.test(rest) || (rest === '' && at + 1 < end && /^\s+\S/.test(lines[at + 1]))) {
      throw new UserError(`\`${key}\` spans several lines; edit it by hand.`, 'fix');
    }
    lines[at] = line;
  }
  const out = bom + lines.join(eol);
  const check = parseFrontmatter(out);
  if (check.error || check.data[key] !== value) throw new UserError(`Could not set \`${key}\` safely; edit SKILL.md by hand.`, 'fix');
  return out;
}

export function addFrontmatter(source: string, name: string, description: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const out = ['---', `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`, '---', '', source.replace(/^﻿/, '')].join(eol);
  const check = parseFrontmatter(out);
  if (check.error || check.data['name'] !== name || check.data['description'] !== description) throw new UserError('Could not build a valid frontmatter.', 'fix');
  return out;
}

export function cleanDescription(input: string): string {
  const d = input.replace(/\s+/g, ' ').trim();
  if (!d) throw new UserError('The description cannot be empty.', 'fix');
  if (d.length > 1024) throw new UserError(`The description is ${d.length} characters; the spec allows 1024.`, 'fix');
  return d;
}

export interface FixResult {
  /** What changed, for the confirmation toast. */
  summary: string;
  backup?: string;
  /** New folder path when the skill folder was renamed. */
  newDir?: string;
}

/**
 * Applies one fix. Re-checks the state on disk first (it may have changed
 * since the scan). SKILL.md is replaced atomically (new file written with
 * 'wx' + 0o644, then renamed over the old one) after a backup copy.
 */
export async function applyFix(
  skill: SkillRecord,
  location: ResolvedLocation,
  fixId: FixId,
  deps: { lock: LockStore; backupRoot: string; description?: string },
): Promise<FixResult> {
  const offered = fixesFor(skill, location).find((f) => f.id === fixId);
  if (!offered) throw new UserError('This fix no longer applies. Refresh the list.', 'fix');

  switch (fixId) {
    case 'remove-broken-link': {
      const st = await fs.lstat(skill.dir).catch(() => null);
      if (!st?.isSymbolicLink()) throw new UserError(`${skill.dir} is no longer a link.`, 'fix');
      if (await fs.stat(skill.dir).then(() => true, () => false)) throw new UserError('The link works again; nothing to fix.', 'fix');
      const target = await fs.readlink(skill.dir);
      await fs.mkdir(deps.backupRoot, { recursive: true });
      const backup = path.join(deps.backupRoot, `${timestamp()}-${skill.dirName}.symlink.txt`);
      await fs.writeFile(backup, target, { flag: 'wx', mode: 0o644 });
      await fs.unlink(skill.dir);
      await deps.lock.remove(skill.dir);
      return { summary: `Removed the broken link "${skill.dirName}".`, backup };
    }
    case 'rename-skill-file': {
      const names = await fs.readdir(skill.realDir);
      const wrong = names.find((n) => n !== 'SKILL.md' && n.toLowerCase() === 'skill.md');
      if (!wrong) throw new UserError('No mis-cased skill.md found any more.', 'fix');
      if (names.includes('SKILL.md')) throw new UserError('Both SKILL.md and skill.md exist; merge them by hand.', 'fix');
      // Two steps so the case-only rename also works on case-insensitive file systems.
      const tmp = path.join(skill.realDir, `.skill-md-${randomBytes(4).toString('hex')}.tmp`);
      await fs.rename(path.join(skill.realDir, wrong), tmp);
      await fs.rename(tmp, path.join(skill.realDir, 'SKILL.md'));
      return { summary: `Renamed ${wrong} to SKILL.md.` };
    }
    case 'rename-folder-to-name': {
      const name = skill.frontmatter['name'] as string;
      const target = safeJoin(location.path, name);
      if (await fs.lstat(target).then(() => true, () => false)) throw new UserError(`A folder named "${name}" already exists in ${location.label}.`, 'fix');
      const st = await fs.lstat(skill.dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new UserError(`${skill.dir} is no longer a folder.`, 'fix');
      await fs.rename(skill.dir, target);
      const entry = deps.lock.get(skill.dir);
      if (entry) {
        await deps.lock.set({ ...entry, dir: target, name });
        await deps.lock.remove(skill.dir);
      }
      return { summary: `Renamed the folder to "${name}".`, newDir: target };
    }
    default: {
      const file = path.join(skill.realDir, 'SKILL.md');
      const original = await fs.readFile(file, 'utf8');
      let next: string;
      if (fixId === 'set-name-to-folder' || fixId === 'add-name') next = setFrontmatterKey(original, 'name', skill.dirName);
      else {
        const description = cleanDescription(deps.description ?? '');
        next = fixId === 'add-frontmatter' ? addFrontmatter(original, skill.dirName, description) : setFrontmatterKey(original, 'description', description);
      }
      const backup = await replaceSkillMd(file, original, next, skill.dirName, deps.backupRoot);
      return { summary: `${offered.label} — SKILL.md updated.`, backup };
    }
  }
}

async function replaceSkillMd(file: string, original: string, next: string, dirName: string, backupRoot: string): Promise<string> {
  const current = await fs.readFile(file, 'utf8');
  if (current !== original) throw new UserError('SKILL.md changed while preparing the fix. Try again.', 'fix');
  await fs.mkdir(backupRoot, { recursive: true });
  const backup = path.join(backupRoot, `${timestamp()}-${dirName}-SKILL.md`);
  await fs.writeFile(backup, original, { flag: 'wx', mode: 0o644 });
  const tmp = path.join(path.dirname(file), `.SKILL.md.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, next, { flag: 'wx', mode: 0o644 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return backup;
}
