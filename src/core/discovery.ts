import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter } from './frontmatter';
import { pathKey, tildify } from './paths';
import { contentFingerprint } from './hashing';
import { timestamp } from './safeWrite';
import { expandContext } from './monorepo';
import { claudePluginSkillRoots, cursorSkillRoots } from './plugins';
import { trackedFromGhFrontmatter } from './provenance';
import { validateSkill } from './validate';
import type { LockStore } from './lockfile';
import { UserError } from './types';
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

const SKILL_FILE_NAME = 'SKILL.md';
const MAX_SKILL_MD_BYTES = 1024 * 1024;
const MAX_ENTRIES_PER_LOCATION = 2000;
const LOCATION_ID_LENGTH = 12;
const SKILL_ID_LENGTH = 16;
/** Synced skills sit in `synced/<skill>` or one level deeper, in `synced/<account bucket>/<skill>`. */
const MANAGED_SCAN_DEPTH = 2;
/** Cursor finds skills inside category folders up to this many levels deep. */
const CATEGORY_SCAN_DEPTH = 3;
/** Frontmatter `metadata` keys that other tools use to record where a skill came from. */
const SOURCE_METADATA_KEY = /repo|source|github|origin/i;

const SCOPE_ORDER = { workspace: 0, global: 1, admin: 2 } as const;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `<organizationUuid>_<accountUuid>`: one synced folder per claude.ai account (observed, not documented). */
const SYNC_BUCKET_NAME = new RegExp(`^${UUID_PATTERN}_${UUID_PATTERN}$`, 'i');

type NotASkill = 'not-a-skill';
const NOT_A_SKILL: NotASkill = 'not-a-skill';

interface ReadOnlyInfo {
  readOnly: boolean;
  readOnlyReason?: string;
}

export interface DiscoverOptions {
  lock?: LockStore;
  /** Extra locations configured by the user (readers = providers listed). */
  extraLocations?: Array<ReadLocation & { readers: string[] }>;
  /** Marks workspace locations read-only (e.g. untrusted workspace). */
  workspaceReadOnlyReason?: string;
  /** Read enabled Claude Code plugins' skills (fills ctx.claudePlugins). */
  plugins?: { pluginsRoot?: string };
  /** Find parent folders up to the repo root and nested skills folders (fills ctx.repoRoots / ctx.nestedDirs). */
  monorepo?: { parents: boolean; nested: boolean };
}

function shortHash(text: string, length: number): string {
  return createHash('sha1').update(text).digest('hex').slice(0, length);
}

function skillIdFor(entryPath: string): string {
  return shortHash(pathKey(entryPath), SKILL_ID_LENGTH);
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/** Merges every adapter's declared directories into one list keyed by real path. */
export function resolveLocations(
  context: DiscoveryContext,
  adapters: ProviderAdapter[],
  options: DiscoverOptions = {},
): ResolvedLocation[] {
  const locationsByKey = new Map<string, ResolvedLocation>();

  const addLocation = (declared: ReadLocation, reader: string, readsRecursively = false) => {
    const absolutePath = path.resolve(declared.path);
    const key = pathKey(absolutePath, context.platform);
    let location = locationsByKey.get(key);
    if (!location) {
      location = {
        id: shortHash(key, LOCATION_ID_LENGTH),
        path: absolutePath,
        label: declared.label ?? labelFor(absolutePath, context),
        scope: declared.scope,
        readers: [],
        readOnly: !!declared.readOnly,
        readOnlyReason: declared.readOnlyReason,
        workspaceFolder: declared.workspaceFolder,
        managedSubdirs: declared.managedSubdirs ? { ...declared.managedSubdirs } : undefined,
        origin: declared.origin,
        appliesTo: declared.appliesTo,
        namespace: declared.namespace,
        exists: false,
        skillCount: 0,
        ignoredEntries: [],
      };
      locationsByKey.set(key, location);
    } else {
      if (declared.readOnly) {
        location.readOnly = true;
        location.readOnlyReason = location.readOnlyReason ?? declared.readOnlyReason;
      }
      if (declared.managedSubdirs) {
        location.managedSubdirs = { ...(location.managedSubdirs ?? {}), ...declared.managedSubdirs };
      }
    }
    if (!location.readers.includes(reader)) location.readers.push(reader);
    if (readsRecursively) {
      location.recursiveReaders ??= [];
      if (!location.recursiveReaders.includes(reader)) location.recursiveReaders.push(reader);
    }
  };

  for (const adapter of adapters) {
    for (const declared of adapter.readLocations(context)) addLocation(declared, adapter.id, adapter.recursiveRoots);
  }
  for (const extra of options.extraLocations ?? []) {
    for (const reader of extra.readers) addLocation(extra, reader);
  }

  const locations = [...locationsByKey.values()];
  if (options.workspaceReadOnlyReason) {
    for (const location of locations) {
      if (location.scope === 'workspace' && !location.readOnly) {
        location.readOnly = true;
        location.readOnlyReason = options.workspaceReadOnlyReason;
      }
    }
  }
  locations.sort((first, second) => SCOPE_ORDER[first.scope] - SCOPE_ORDER[second.scope] || first.path.localeCompare(second.path));
  return locations;
}

function labelFor(absolutePath: string, context: DiscoveryContext): string {
  const workspaceFolder = context.workspaceFolders.find((folder) => absolutePath.startsWith(folder + path.sep));
  if (!workspaceFolder) return toPosix(tildify(absolutePath, context.homeDir));
  const relativePath = toPosix(path.relative(workspaceFolder, absolutePath));
  const hasSeveralFolders = context.workspaceFolders.length > 1;
  return hasSeveralFolders ? `${path.basename(workspaceFolder)}/${relativePath}` : relativePath;
}

async function statOrNull(filePath: string) {
  try {
    return await fs.stat(filePath);
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
  if (names.includes(SKILL_FILE_NAME)) return { file: path.join(dir, SKILL_FILE_NAME) };
  const wrongCase = names.find((name) => name.toLowerCase() === SKILL_FILE_NAME.toLowerCase());
  return wrongCase ? { wrongCase } : {};
}

async function readHead(file: string, maxBytes: number): Promise<{ content: string; size: number }> {
  const { size } = await fs.stat(file);
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    await handle.read(buffer, 0, buffer.length, 0);
    return { content: buffer.toString('utf8'), size };
  } finally {
    await handle.close();
  }
}

function stringField(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === 'string' ? value : undefined;
}

async function readSkill(
  entryPath: string,
  dirName: string,
  location: ResolvedLocation,
  readOnlyInfo: ReadOnlyInfo,
  options: DiscoverOptions,
): Promise<SkillRecord | NotASkill> {
  const issues: Issue[] = [];
  let isSymlink = false;
  let realDir = entryPath;
  const entryStat = await fs.lstat(entryPath);
  if (entryStat.isSymbolicLink()) {
    isSymlink = true;
    try {
      realDir = await fs.realpath(entryPath);
    } catch {
      return {
        ...emptyRecord(entryPath, dirName, location, readOnlyInfo),
        isSymlink: true,
        issues: [{ severity: 'error', code: 'broken-symlink', message: 'Symlink target does not exist. Agents will not load this skill.' }],
        visibleTo: [],
      };
    }
  }
  const targetStat = await statOrNull(realDir);
  if (!targetStat?.isDirectory()) return NOT_A_SKILL;

  const { file, wrongCase } = await findSkillFile(realDir);
  if (!file) {
    if (!wrongCase) return NOT_A_SKILL;
    return {
      ...emptyRecord(entryPath, dirName, location, readOnlyInfo),
      isSymlink,
      realDir,
      skillFile: path.join(entryPath, wrongCase),
      issues: [
        {
          severity: 'error',
          code: 'skill-file-case',
          message: `Found "${wrongCase}" but agents look for "${SKILL_FILE_NAME}" (exact case). It may load on macOS/Windows but not on Linux.`,
        },
      ],
    };
  }

  let content = '';
  let bytes = 0;
  try {
    const head = await readHead(file, MAX_SKILL_MD_BYTES);
    content = head.content;
    bytes = head.size;
    if (head.size > MAX_SKILL_MD_BYTES) {
      const sizeInKb = (head.size / 1024).toFixed(0);
      issues.push({ severity: 'warning', code: 'skill-file-large', message: `SKILL.md is ${sizeInKb} KB; only the first 1 MB was read.` });
    }
  } catch (error) {
    issues.push({ severity: 'error', code: 'skill-file-unreadable', message: `Cannot read SKILL.md: ${(error as Error).message}` });
  }

  const frontmatter = parseFrontmatter(content);
  const lineCount = content.split('\n').length;
  issues.push(
    ...validateSkill({
      dirName,
      frontmatter: frontmatter.data,
      hasFrontmatter: frontmatter.hasFrontmatter,
      parseError: frontmatter.error,
      lineCount,
    }),
  );

  const declaredName = stringField(frontmatter.data, 'name');
  const lockEntry = options.lock?.get(entryPath);

  return {
    id: skillIdFor(entryPath),
    name: declaredName || dirName,
    dirName,
    description: stringField(frontmatter.data, 'description')?.trim(),
    dir: entryPath,
    realDir,
    isSymlink,
    skillFile: path.join(entryPath, SKILL_FILE_NAME),
    locationId: location.id,
    scope: location.scope,
    visibleTo: [...location.readers],
    frontmatter: frontmatter.data,
    issues,
    readOnly: readOnlyInfo.readOnly,
    readOnlyReason: readOnlyInfo.readOnlyReason,
    namespace: location.namespace,
    source: lockEntry,
    sourceHint: lockEntry ? undefined : findSourceHint(frontmatter.data),
    ghSource: lockEntry ? undefined : trackedFromGhFrontmatter(frontmatter.data),
    skillMdBytes: bytes,
    skillMdLines: lineCount,
  };
}

function readSkillOrSkip(
  entryPath: string,
  dirName: string,
  location: ResolvedLocation,
  readOnlyInfo: ReadOnlyInfo,
  options: DiscoverOptions,
): Promise<SkillRecord | NotASkill> {
  return readSkill(entryPath, dirName, location, readOnlyInfo, options).catch(() => NOT_A_SKILL);
}

function emptyRecord(entryPath: string, dirName: string, location: ResolvedLocation, readOnlyInfo: ReadOnlyInfo): SkillRecord {
  return {
    id: skillIdFor(entryPath),
    name: dirName,
    dirName,
    dir: entryPath,
    realDir: entryPath,
    isSymlink: false,
    skillFile: path.join(entryPath, SKILL_FILE_NAME),
    locationId: location.id,
    scope: location.scope,
    visibleTo: [...location.readers],
    frontmatter: {},
    issues: [],
    readOnly: readOnlyInfo.readOnly,
    readOnlyReason: readOnlyInfo.readOnlyReason,
    skillMdBytes: 0,
    skillMdLines: 0,
  };
}

/** Other tools (e.g. `gh skill`) record provenance in frontmatter metadata. Surface it, don't trust it. */
function findSourceHint(frontmatter: Record<string, unknown>): string | undefined {
  const ghSource = trackedFromGhFrontmatter(frontmatter);
  if (ghSource) {
    const subpath = ghSource.subpath ? `/${ghSource.subpath}` : '';
    const pinned = ghSource.pinned ? ' (pinned)' : '';
    return `gh skill — ${ghSource.owner}/${ghSource.repo}${subpath} @ ${ghSource.ref}${pinned}`;
  }
  const metadata = frontmatter['metadata'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    const looksLikeSource = SOURCE_METADATA_KEY.test(key);
    const isPrintable = typeof value === 'string' || typeof value === 'number';
    if (looksLikeSource && isPrintable) return `${key}: ${value}`;
  }
  return undefined;
}

function isFolderLike(entry: Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink();
}

function sameBucket(first: string, second: string): boolean {
  return first.toLowerCase() === second.toLowerCase();
}

/**
 * Folders owned by another tool. Claude Code documents only `~/.claude/skills/synced/`;
 * on disk (v2.1.27x, Oct 2026) skills sit one level deeper, in one bucket per
 * claude.ai account (`synced/<org>_<account>/<skill>/SKILL.md`). Accept both.
 */
async function scanManaged(
  dir: string,
  managedName: string,
  readOnlyReason: string,
  location: ResolvedLocation,
  options: DiscoverOptions,
  depthLeft: number,
  activeBucket?: string,
): Promise<SkillRecord[]> {
  const skills: SkillRecord[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const isSynced = managedName === 'synced' && !!activeBucket;
  for (const entry of entries) {
    if (isHidden(entry.name) || !isFolderLike(entry)) continue;
    const entryPath = path.join(dir, entry.name);
    if (isSynced && sameBucket(entry.name, activeBucket)) {
      location.activeSyncBucket = { bucket: entry.name, lastSynced: await manifestDate(entryPath) };
    }
    // Claude Code syncs "your account's skills": a bucket of another account is a leftover.
    const isOtherAccountBucket = isSynced && SYNC_BUCKET_NAME.test(entry.name) && !sameBucket(entry.name, activeBucket);
    if (isOtherAccountBucket) {
      const leftovers = await scanManaged(entryPath, managedName, readOnlyReason, location, options, depthLeft - 1);
      location.skippedSynced = (location.skippedSynced ?? 0) + leftovers.length;
      location.skippedSyncedBuckets ??= [];
      location.skippedSyncedBuckets.push({
        bucket: entry.name,
        path: entryPath,
        skills: leftovers.map((skill) => skill.name).sort(),
        lastSynced: await manifestDate(entryPath),
      });
      continue;
    }
    const record = await readSkillOrSkip(entryPath, entry.name, location, { readOnly: true, readOnlyReason }, options);
    if (record !== NOT_A_SKILL) {
      skills.push({ ...record, managed: managedName });
    } else if (depthLeft > 1 && entry.isDirectory()) {
      skills.push(...(await scanManaged(entryPath, managedName, readOnlyReason, location, options, depthLeft - 1)));
    }
  }
  return skills;
}

/**
 * Moves the synced bucket of another claude.ai account (a leftover Claude Code
 * no longer loads) to the backup folder. Refuses the signed-in account's
 * bucket and anything that isn't `~/.claude/skills/synced/<org>_<account>`.
 */
export async function archiveSyncedBucket(homeDir: string, bucket: string, backupRoot: string): Promise<string> {
  if (!SYNC_BUCKET_NAME.test(bucket)) throw new UserError('Not a claude.ai sync folder.');
  const activeBucket = await readClaudeSyncBucket(homeDir);
  if (!activeBucket) throw new UserError('Can’t tell which claude.ai account is signed in, so nothing is moved.');
  if (activeBucket === bucket.toLowerCase()) throw new UserError('That folder belongs to the signed-in claude.ai account.');
  const bucketDir = path.join(homeDir, '.claude', 'skills', 'synced', bucket);
  const bucketStat = await fs.lstat(bucketDir).catch(() => null);
  if (!bucketStat?.isDirectory()) throw new UserError('The folder no longer exists. Refresh the list.');
  await fs.mkdir(backupRoot, { recursive: true });
  const shortBucketId = bucket.slice(0, 8);
  const destination = path.join(backupRoot, `${timestamp()}-claude-ai-${shortBucketId}`);
  await fs.rename(bucketDir, destination).catch(async (error: NodeJS.ErrnoException) => {
    const isCrossDevice = error.code === 'EXDEV';
    if (!isCrossDevice) throw error;
    await fs.cp(bucketDir, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await fs.rm(bucketDir, { recursive: true, force: true });
  });
  return destination;
}

/** `lastUpdated` (epoch ms) from a synced bucket's manifest.json; undefined if absent or odd. */
async function manifestDate(bucketDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(bucketDir, 'manifest.json'), 'utf8')) as { lastUpdated?: unknown };
    const lastUpdated = manifest.lastUpdated;
    if (typeof lastUpdated !== 'number' || !Number.isFinite(lastUpdated)) return undefined;
    return new Date(lastUpdated).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * `<organizationUuid>_<accountUuid>` of the claude.ai account Claude Code is
 * signed in with, read from ~/.claude.json (only those two fields).
 */
export async function readClaudeSyncBucket(homeDir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(homeDir, '.claude.json'), 'utf8');
    const account = (JSON.parse(raw) as { oauthAccount?: { organizationUuid?: unknown; accountUuid?: unknown } }).oauthAccount;
    const bucket = `${account?.organizationUuid}_${account?.accountUuid}`;
    return SYNC_BUCKET_NAME.test(bucket) ? bucket.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

async function scanLocation(location: ResolvedLocation, options: DiscoverOptions, context: DiscoveryContext): Promise<SkillRecord[]> {
  const locationStat = await statOrNull(location.path);
  if (!locationStat?.isDirectory()) return [];
  location.exists = true;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(location.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const locationReadOnly: ReadOnlyInfo = { readOnly: location.readOnly, readOnlyReason: location.readOnlyReason };
  const skills: SkillRecord[] = [];
  for (const entry of entries.slice(0, MAX_ENTRIES_PER_LOCATION)) {
    if (isHidden(entry.name)) continue;
    const entryPath = path.join(location.path, entry.name);
    if (!isFolderLike(entry)) {
      if (entry.name.toLowerCase().endsWith('.md')) location.ignoredEntries.push(entry.name);
      continue;
    }
    const managedReason = location.managedSubdirs?.[entry.name];
    if (managedReason) {
      skills.push(...(await scanManaged(entryPath, entry.name, managedReason, location, options, MANAGED_SCAN_DEPTH, context.claudeSyncBucket)));
      continue;
    }
    const record = await readSkillOrSkip(entryPath, entry.name, location, locationReadOnly, options);
    if (record !== NOT_A_SKILL) {
      skills.push(record);
      continue;
    }
    const hasRecursiveReader = !!location.recursiveReaders?.length;
    const skillsInCategory = hasRecursiveReader && entry.isDirectory() ? await scanCategoryFolder(entryPath, entry.name, location, options, CATEGORY_SCAN_DEPTH) : [];
    if (skillsInCategory.length) skills.push(...skillsInCategory);
    else location.ignoredEntries.push(entry.name + '/');
  }
  location.skillCount = skills.length;
  return skills;
}

/** A category folder (skills/<group>/<skill>/SKILL.md): only recursive readers find what's inside. */
async function scanCategoryFolder(dir: string, group: string, location: ResolvedLocation, options: DiscoverOptions, depthLeft: number): Promise<SkillRecord[]> {
  const skills: SkillRecord[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const recursiveReaders = location.recursiveReaders ?? [];
  for (const entry of entries) {
    if (isHidden(entry.name) || !entry.isDirectory()) continue;
    const entryPath = path.join(dir, entry.name);
    const record = await readSkillOrSkip(entryPath, entry.name, location, { readOnly: location.readOnly, readOnlyReason: location.readOnlyReason }, options);
    if (record !== NOT_A_SKILL) {
      skills.push({ ...record, group, visibleTo: record.visibleTo.filter((reader) => recursiveReaders.includes(reader)) });
    } else if (depthLeft > 1) {
      skills.push(...(await scanCategoryFolder(entryPath, `${group}/${entry.name}`, location, options, depthLeft - 1)));
    }
  }
  return skills;
}

/** Two skills only clash when an agent invokes them by the same name: plugin and nested skills get a prefix. */
function invocationName(skill: SkillRecord, location: ResolvedLocation | undefined, adapter: ProviderAdapter): string {
  if (location?.namespace) return `${location.namespace}:${skill.name}`;
  if (adapter.namespacesNested && location?.origin === 'nested') return `nested/${location.appliesTo}:${skill.name}`;
  return skill.name;
}

function addIssueToAll(skills: SkillRecord[], issue: Issue): void {
  for (const skill of skills) addIssueOnce(skill, issue);
}

/** Adds duplicate/shadowing issues: same skill name visible to the same provider from different real folders. */
export function annotateConflicts(skills: SkillRecord[], adapters: ProviderAdapter[], locations: ResolvedLocation[]): ProviderSummary[] {
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const summaries: ProviderSummary[] = [];
  for (const adapter of adapters) {
    const visibleSkills = skills.filter((skill) => skill.visibleTo.includes(adapter.id));
    const skillsByName = new Map<string, SkillRecord[]>();
    for (const skill of visibleSkills) {
      const name = invocationName(skill, locationById.get(skill.locationId), adapter);
      skillsByName.set(name, [...(skillsByName.get(name) ?? []), skill]);
    }

    const duplicateNames: string[] = [];
    for (const sameName of skillsByName.values()) {
      if (sameName.length < 2) continue;
      const name = sameName[0].name;
      const distinctFolders = new Set(sameName.map((skill) => pathKey(skill.realDir))).size;
      const agent = adapter.displayName;

      if (distinctFolders < 2) {
        addIssueToAll(sameName, {
          severity: 'info',
          code: 'linked-copies',
          message: `The same skill folder is linked in ${sameName.length} places; ${agent} sees one skill.`,
        });
        continue;
      }
      const allManagedElsewhere = sameName.every((skill) => skill.managed);
      if (allManagedElsewhere) {
        addIssueToAll(sameName, {
          severity: 'info',
          code: 'synced-copies',
          message: `"${name}" is synced ${sameName.length} times (one copy per claude.ai account/organization).`,
        });
        continue;
      }
      const contentIds = new Set(sameName.map((skill) => skill.contentId));
      const allIdentical = contentIds.size === 1 && !!sameName[0].contentId;
      if (allIdentical) {
        addIssueToAll(sameName, {
          severity: 'info',
          code: 'identical-copies',
          message: `${agent} sees ${distinctFolders} identical copies of "${name}"; whichever it picks, the content is the same.`,
        });
        continue;
      }
      duplicateNames.push(name);
      const where = sameName.map((skill) => locationById.get(skill.locationId)?.label ?? skill.dir).join(', ');
      addIssueToAll(sameName, {
        severity: 'warning',
        code: `duplicate:${adapter.id}`,
        message: `${agent} sees ${distinctFolders} different skills named "${name}" (${where}). Which one wins is decided by ${agent}.`,
      });
    }

    summaries.push({
      id: adapter.id,
      displayName: adapter.displayName,
      docsUrl: adapter.docsUrl,
      disableHint: adapter.disableHint,
      visibleSkills: new Set(visibleSkills.map((skill) => skill.name)).size,
      duplicateNames,
    });
  }
  return summaries;
}

function addIssueOnce(skill: SkillRecord, issue: Issue): void {
  const alreadyThere = skill.issues.some((existing) => existing.code === issue.code);
  if (!alreadyThere) skill.issues.push(issue);
}

/** Fingerprints only skills whose name repeats: identical copies are not a real conflict. */
async function fingerprintRepeatedNames(skills: SkillRecord[]): Promise<void> {
  const countByName = new Map<string, number>();
  for (const skill of skills) countByName.set(skill.name, (countByName.get(skill.name) ?? 0) + 1);
  const needFingerprint = skills.filter((skill) => {
    const nameRepeats = (countByName.get(skill.name) ?? 0) > 1;
    const isBrokenLink = skill.issues.some((issue) => issue.code === 'broken-symlink');
    return nameRepeats && !isBrokenLink;
  });
  await Promise.all(
    needFingerprint.map(async (skill) => {
      skill.contentId = await contentFingerprint(skill.realDir).catch(() => undefined);
    }),
  );
}

function listNames(names: string[]): string {
  return names.join(', ');
}

/** Explains which agents find a skill that sits inside a category folder, and which don't. */
function annotateCategoryFolders(skills: SkillRecord[], locations: ResolvedLocation[], adapters: ProviderAdapter[]): void {
  const displayName = (id: string) => adapters.find((adapter) => adapter.id === id)?.displayName ?? id;
  for (const skill of skills.filter((candidate) => candidate.group)) {
    const location = locations.find((candidate) => candidate.id === skill.locationId)!;
    const agentsThatMissIt = location.readers.filter((reader) => !location.recursiveReaders?.includes(reader));
    const finders = listNames(skill.visibleTo.map(displayName)) || 'no agent';
    let message = `Inside the category folder "${skill.group}/": only ${finders} finds it`;
    if (agentsThatMissIt.length) {
      const verb = agentsThatMissIt.length === 1 ? 'reads' : 'read';
      message += `; ${listNames(agentsThatMissIt.map(displayName))} only ${verb} skills directly in ${location.label}`;
    }
    skill.issues.push({ severity: agentsThatMissIt.length ? 'warning' : 'info', code: 'in-category-folder', message: `${message}.` });
  }
}

export async function discover(context: DiscoveryContext, adapters: ProviderAdapter[], options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  if (options.monorepo) context = await expandContext(context, options.monorepo);
  if (options.plugins) {
    const syncBucket = context.claudeSyncBucket ?? (await readClaudeSyncBucket(context.homeDir));
    const claudePlugins = await claudePluginSkillRoots({
      homeDir: context.homeDir,
      workspaceFolders: context.workspaceFolders,
      platform: context.platform,
      pluginsRoot: options.plugins.pluginsRoot,
      syncBucket,
    }).catch(() => []);
    const cursorPlugins = await cursorSkillRoots(context.homeDir).catch(() => []);
    context = { ...context, claudePlugins, cursorPlugins };
  }
  const locations = resolveLocations(context, adapters, options);
  const skillsPerLocation = await Promise.all(locations.map((location) => scanLocation(location, options, context)));
  const skills = skillsPerLocation.flat();
  await fingerprintRepeatedNames(skills);
  const providers = annotateConflicts(skills, adapters, locations);
  annotateCategoryFolders(skills, locations, adapters);
  return { scannedAt: new Date().toISOString(), context, locations, skills, providers };
}
