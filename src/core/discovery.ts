import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter } from './frontmatter';
import { pathKey, tildify } from './paths';
import { contentFingerprint } from './hashing';
import { expandContext } from './monorepo';
import { trackedFromGhFrontmatter } from './provenance';
import { validateSkill } from './validate';
import type { LockStore } from './lockfile';
import type {
  DiscoveryContext,
  DiscoveryResult,
  Issue,
  ProviderAdapter,
  ProviderSummary,
  ReadLocation,
  ResolvedLocation,
  SkillRecord,
} from './types';

const MAX_SKILL_MD_BYTES = 1024 * 1024;
const MAX_ENTRIES_PER_LOCATION = 2000;

export interface DiscoverOptions {
  lock?: LockStore;
  /** Extra locations configured by the user (readers = providers listed). */
  extraLocations?: Array<ReadLocation & { readers: string[] }>;
  /** Marks workspace locations read-only (e.g. untrusted workspace). */
  workspaceReadOnlyReason?: string;
  /** Find parent folders up to the repo root and nested skills folders (fills ctx.repoRoots / ctx.nestedDirs). */
  monorepo?: { parents: boolean; nested: boolean };
}

/** Merges every adapter's declared directories into one list keyed by real path. */
export function resolveLocations(
  ctx: DiscoveryContext,
  adapters: ProviderAdapter[],
  opts: DiscoverOptions = {},
): ResolvedLocation[] {
  const byKey = new Map<string, ResolvedLocation>();
  const add = (loc: ReadLocation, reader: string) => {
    const abs = path.resolve(loc.path);
    const key = pathKey(abs, ctx.platform);
    let r = byKey.get(key);
    if (!r) {
      r = {
        id: createHash('sha1').update(key).digest('hex').slice(0, 12),
        path: abs,
        label: loc.label ?? labelFor(abs, ctx),
        scope: loc.scope,
        readers: [],
        readOnly: !!loc.readOnly,
        readOnlyReason: loc.readOnlyReason,
        workspaceFolder: loc.workspaceFolder,
        managedSubdirs: loc.managedSubdirs ? { ...loc.managedSubdirs } : undefined,
        origin: loc.origin,
        appliesTo: loc.appliesTo,
        exists: false,
        skillCount: 0,
        ignoredEntries: [],
      };
      byKey.set(key, r);
    } else {
      if (loc.readOnly) {
        r.readOnly = true;
        r.readOnlyReason = r.readOnlyReason ?? loc.readOnlyReason;
      }
      if (loc.managedSubdirs) r.managedSubdirs = { ...(r.managedSubdirs ?? {}), ...loc.managedSubdirs };
    }
    if (!r.readers.includes(reader)) r.readers.push(reader);
  };
  for (const a of adapters) for (const loc of a.readLocations(ctx)) add(loc, a.id);
  for (const extra of opts.extraLocations ?? []) for (const reader of extra.readers) add(extra, reader);

  const list = [...byKey.values()];
  if (opts.workspaceReadOnlyReason) {
    for (const l of list) {
      if (l.scope === 'workspace' && !l.readOnly) {
        l.readOnly = true;
        l.readOnlyReason = opts.workspaceReadOnlyReason;
      }
    }
  }
  const scopeOrder = { workspace: 0, global: 1, admin: 2 } as const;
  list.sort((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope] || a.path.localeCompare(b.path));
  return list;
}

function labelFor(abs: string, ctx: DiscoveryContext): string {
  const folder = ctx.workspaceFolders.find((f) => abs.startsWith(f + path.sep));
  if (folder) {
    const rel = path.relative(folder, abs).split(path.sep).join('/');
    return ctx.workspaceFolders.length > 1 ? `${path.basename(folder)}/${rel}` : rel;
  }
  return tildify(abs, ctx.homeDir).split(path.sep).join('/');
}

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/** Finds the exact-case SKILL.md in a directory (case-insensitive filesystems lie to existsSync). */
async function findSkillFile(dir: string): Promise<{ file?: string; wrongCase?: string }> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return {};
  }
  if (names.includes('SKILL.md')) return { file: path.join(dir, 'SKILL.md') };
  const alt = names.find((n) => n.toLowerCase() === 'skill.md');
  return alt ? { wrongCase: alt } : {};
}

async function readSkill(
  entryPath: string,
  dirName: string,
  loc: ResolvedLocation,
  extra: { readOnly: boolean; readOnlyReason?: string },
  opts: DiscoverOptions,
): Promise<SkillRecord | 'not-a-skill'> {
  const issues: Issue[] = [];
  let isSymlink = false;
  let realDir = entryPath;
  const lst = await fs.lstat(entryPath);
  if (lst.isSymbolicLink()) {
    isSymlink = true;
    try {
      realDir = await fs.realpath(entryPath);
    } catch {
      return {
        ...emptyRecord(entryPath, dirName, loc, extra),
        isSymlink: true,
        issues: [{ severity: 'error', code: 'broken-symlink', message: 'Symlink target does not exist. Agents will not load this skill.' }],
        visibleTo: [],
      };
    }
  }
  const st = await statOrNull(realDir);
  if (!st || !st.isDirectory()) return 'not-a-skill';

  const { file, wrongCase } = await findSkillFile(realDir);
  if (!file) {
    if (wrongCase) {
      return {
        ...emptyRecord(entryPath, dirName, loc, extra),
        isSymlink,
        realDir,
        skillFile: path.join(entryPath, wrongCase),
        issues: [
          {
            severity: 'error',
            code: 'skill-file-case',
            message: `Found "${wrongCase}" but agents look for "SKILL.md" (exact case). It may load on macOS/Windows but not on Linux.`,
          },
        ],
      };
    }
    return 'not-a-skill';
  }

  let content = '';
  let bytes = 0;
  try {
    const fst = await fs.stat(file);
    bytes = fst.size;
    if (fst.size > MAX_SKILL_MD_BYTES) {
      issues.push({ severity: 'warning', code: 'skill-file-large', message: `SKILL.md is ${(fst.size / 1024).toFixed(0)} KB; only the first 1 MB was read.` });
    }
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fst.size, MAX_SKILL_MD_BYTES));
      await fh.read(buf, 0, buf.length, 0);
      content = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch (e) {
    issues.push({ severity: 'error', code: 'skill-file-unreadable', message: `Cannot read SKILL.md: ${(e as Error).message}` });
  }

  const fm = parseFrontmatter(content);
  const lineCount = content.split('\n').length;
  issues.push(
    ...validateSkill({
      dirName,
      frontmatter: fm.data,
      hasFrontmatter: fm.hasFrontmatter,
      parseError: fm.error,
      lineCount,
    }),
  );

  const name = typeof fm.data['name'] === 'string' && fm.data['name'] ? (fm.data['name'] as string) : dirName;
  const description = typeof fm.data['description'] === 'string' ? (fm.data['description'] as string).trim() : undefined;
  const lockEntry = opts.lock?.get(entryPath);

  return {
    id: createHash('sha1').update(pathKey(entryPath)).digest('hex').slice(0, 16),
    name,
    dirName,
    description,
    dir: entryPath,
    realDir,
    isSymlink,
    skillFile: path.join(entryPath, 'SKILL.md'),
    locationId: loc.id,
    scope: loc.scope,
    visibleTo: [...loc.readers],
    frontmatter: fm.data,
    issues,
    readOnly: extra.readOnly,
    readOnlyReason: extra.readOnlyReason,
    source: lockEntry,
    sourceHint: lockEntry ? undefined : findSourceHint(fm.data),
    ghSource: lockEntry ? undefined : trackedFromGhFrontmatter(fm.data),
    skillMdBytes: bytes,
    skillMdLines: lineCount,
  };
}

function emptyRecord(
  entryPath: string,
  dirName: string,
  loc: ResolvedLocation,
  extra: { readOnly: boolean; readOnlyReason?: string },
): SkillRecord {
  return {
    id: createHash('sha1').update(pathKey(entryPath)).digest('hex').slice(0, 16),
    name: dirName,
    dirName,
    dir: entryPath,
    realDir: entryPath,
    isSymlink: false,
    skillFile: path.join(entryPath, 'SKILL.md'),
    locationId: loc.id,
    scope: loc.scope,
    visibleTo: [...loc.readers],
    frontmatter: {},
    issues: [],
    readOnly: extra.readOnly,
    readOnlyReason: extra.readOnlyReason,
    skillMdBytes: 0,
    skillMdLines: 0,
  };
}

/** Other tools (e.g. `gh skill`) record provenance in frontmatter metadata. Surface it, don't trust it. */
function findSourceHint(fm: Record<string, unknown>): string | undefined {
  const gh = trackedFromGhFrontmatter(fm);
  if (gh) return `gh skill — ${gh.owner}/${gh.repo}${gh.subpath ? '/' + gh.subpath : ''} @ ${gh.ref}${gh.pinned ? ' (pinned)' : ''}`;
  const meta = fm['metadata'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (/repo|source|github|origin/i.test(k) && (typeof v === 'string' || typeof v === 'number')) return `${k}: ${v}`;
  }
  return undefined;
}

/**
 * Folders owned by another tool. Claude Code documents only `~/.claude/skills/synced/`;
 * on disk (v2.1.27x, Oct 2026) skills sit one level deeper, in one bucket per
 * claude.ai account (`synced/<org>_<account>/<skill>/SKILL.md`). Accept both.
 */
async function scanManaged(
  dir: string,
  managed: string,
  reason: string,
  loc: ResolvedLocation,
  opts: DiscoverOptions,
  depth: number,
  activeBucket?: string,
): Promise<SkillRecord[]> {
  const out: SkillRecord[] = [];
  const sub = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  for (const s of sub) {
    if (s.name.startsWith('.') || (!s.isDirectory() && !s.isSymbolicLink())) continue;
    const p = path.join(dir, s.name);
    if (managed === 'synced' && activeBucket && s.name.toLowerCase() === activeBucket.toLowerCase()) {
      loc.activeSyncBucket = { bucket: s.name, lastSynced: await manifestDate(p) };
    }
    // Claude Code syncs "your account's skills": a bucket of another account is a leftover.
    if (managed === 'synced' && activeBucket && BUCKET_RE.test(s.name) && s.name.toLowerCase() !== activeBucket.toLowerCase()) {
      const left = await scanManaged(p, managed, reason, loc, opts, depth - 1);
      loc.skippedSynced = (loc.skippedSynced ?? 0) + left.length;
      (loc.skippedSyncedBuckets ??= []).push({ bucket: s.name, path: p, skills: left.map((x) => x.name).sort(), lastSynced: await manifestDate(p) });
      continue;
    }
    const rec = await readSkill(p, s.name, loc, { readOnly: true, readOnlyReason: reason }, opts).catch(() => 'not-a-skill' as const);
    if (rec !== 'not-a-skill') out.push({ ...rec, managed });
    else if (depth > 1 && s.isDirectory()) out.push(...(await scanManaged(p, managed, reason, loc, opts, depth - 1)));
  }
  return out;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BUCKET_RE = new RegExp(`^${UUID}_${UUID}$`, 'i');

/**
 * `<organizationUuid>_<accountUuid>` of the claude.ai account Claude Code is
 * signed in with, read from ~/.claude.json (only those two fields). The synced
 * bucket names use this format (observed 2026-10-18; not documented).
 */
/** `lastUpdated` (epoch ms) from a synced bucket's manifest.json; undefined if absent or odd. */
async function manifestDate(bucketDir: string): Promise<string | undefined> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(bucketDir, 'manifest.json'), 'utf8')) as { lastUpdated?: unknown };
    return typeof m.lastUpdated === 'number' && Number.isFinite(m.lastUpdated) ? new Date(m.lastUpdated).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

export async function readClaudeSyncBucket(homeDir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(homeDir, '.claude.json'), 'utf8');
    const acct = (JSON.parse(raw) as { oauthAccount?: { organizationUuid?: unknown; accountUuid?: unknown } }).oauthAccount;
    const bucket = `${acct?.organizationUuid}_${acct?.accountUuid}`;
    return BUCKET_RE.test(bucket) ? bucket.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

async function scanLocation(loc: ResolvedLocation, opts: DiscoverOptions, ctx: DiscoveryContext): Promise<SkillRecord[]> {
  const st = await statOrNull(loc.path);
  if (!st || !st.isDirectory()) return [];
  loc.exists = true;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(loc.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillRecord[] = [];
  for (const entry of entries.slice(0, MAX_ENTRIES_PER_LOCATION)) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(loc.path, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      if (entry.name.toLowerCase().endsWith('.md')) loc.ignoredEntries.push(entry.name);
      continue;
    }
    const managedReason = loc.managedSubdirs?.[entry.name];
    if (managedReason) {
      out.push(...(await scanManaged(entryPath, entry.name, managedReason, loc, opts, 2, ctx.claudeSyncBucket)));
      continue;
    }
    const rec = await readSkill(entryPath, entry.name, loc, { readOnly: loc.readOnly, readOnlyReason: loc.readOnlyReason }, opts).catch(
      () => 'not-a-skill' as const,
    );
    if (rec === 'not-a-skill') loc.ignoredEntries.push(entry.name + '/');
    else out.push(rec);
  }
  loc.skillCount = out.length;
  return out;
}

/** Adds duplicate/shadowing issues: same skill name visible to the same provider from different real folders. */
export function annotateConflicts(skills: SkillRecord[], adapters: ProviderAdapter[], locations: ResolvedLocation[]): ProviderSummary[] {
  const locById = new Map(locations.map((l) => [l.id, l]));
  const summaries: ProviderSummary[] = [];
  for (const a of adapters) {
    const visible = skills.filter((s) => s.visibleTo.includes(a.id));
    const byName = new Map<string, SkillRecord[]>();
    for (const s of visible) {
      const loc = locById.get(s.locationId);
      const ns = a.namespacesNested && loc?.origin === 'nested' ? `${loc.appliesTo}:` : '';
      const list = byName.get(ns + s.name) ?? [];
      list.push(s);
      byName.set(ns + s.name, list);
    }
    const dupes: string[] = [];
    for (const [, list] of byName) {
      if (list.length < 2) continue;
      const name = list[0].name;
      const distinctReal = new Set(list.map((s) => pathKey(s.realDir)));
      if (distinctReal.size < 2) {
        for (const s of list) {
          addIssueOnce(s, {
            severity: 'info',
            code: 'linked-copies',
            message: `The same skill folder is linked in ${list.length} places; ${a.displayName} sees one skill.`,
          });
        }
        continue;
      }
      if (list.every((s) => s.managed)) {
        // e.g. the same claude.ai skill synced for two accounts: nothing the user can fix locally.
        for (const s of list) {
          addIssueOnce(s, {
            severity: 'info',
            code: 'synced-copies',
            message: `"${name}" is synced ${list.length} times (one copy per claude.ai account/organization).`,
          });
        }
        continue;
      }
      const ids = new Set(list.map((s) => s.contentId));
      if (ids.size === 1 && list[0].contentId) {
        for (const s of list) {
          addIssueOnce(s, {
            severity: 'info',
            code: 'identical-copies',
            message: `${a.displayName} sees ${distinctReal.size} identical copies of "${name}"; whichever it picks, the content is the same.`,
          });
        }
        continue;
      }
      dupes.push(name);
      const where = list.map((s) => locById.get(s.locationId)?.label ?? s.dir).join(', ');
      for (const s of list) {
        addIssueOnce(s, {
          severity: 'warning',
          code: `duplicate:${a.id}`,
          message: `${a.displayName} sees ${distinctReal.size} different skills named "${name}" (${where}). Which one wins is decided by ${a.displayName}.`,
        });
      }
    }
    summaries.push({
      id: a.id,
      displayName: a.displayName,
      docsUrl: a.docsUrl,
      disableHint: a.disableHint,
      visibleSkills: new Set(visible.map((s) => s.name)).size,
      duplicateNames: dupes,
    });
  }
  return summaries;
}

function addIssueOnce(s: SkillRecord, issue: Issue) {
  if (!s.issues.some((i) => i.code === issue.code)) s.issues.push(issue);
}

export async function discover(ctx: DiscoveryContext, adapters: ProviderAdapter[], opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  if (opts.monorepo) ctx = await expandContext(ctx, opts.monorepo);
  const locations = resolveLocations(ctx, adapters, opts);
  const perLocation = await Promise.all(locations.map((l) => scanLocation(l, opts, ctx)));
  const skills = perLocation.flat();
  // Fingerprint only skills whose name repeats: identical copies are not a real conflict.
  const count = new Map<string, number>();
  for (const s of skills) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  await Promise.all(
    skills
      .filter((s) => (count.get(s.name) ?? 0) > 1 && !s.issues.some((i) => i.code === 'broken-symlink'))
      .map(async (s) => {
        s.contentId = await contentFingerprint(s.realDir).catch(() => undefined);
      }),
  );
  const providers = annotateConflicts(skills, adapters, locations);
  return { scannedAt: new Date().toISOString(), context: ctx, locations, skills, providers };
}
