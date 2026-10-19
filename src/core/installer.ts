import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseFrontmatter } from './frontmatter';
import { GitHubClient, ParsedGitHubUrl, TreeEntry } from './github';
import { Finding, inspectContent, inspectFileList } from './inspector';
import type { LockStore } from './lockfile';
import { isPathInside, pathKey, safeJoin, SKILL_NAME_RE, toSkillDirName, validateRelativePath } from './paths';
import { isCrossDeviceError, NEW_FILE, timestamp } from './safeWrite';
import { mapWithConcurrency } from './concurrency';
import { validateSkill } from './validate';
import { GitHubSource, Issue, ResolvedLocation, SkillRecord, UserError } from './types';

export { timestamp };

export interface InstallLimits {
  maxFilesPerSkill: number;
  maxFileBytes: number;
  maxSkillBytes: number;
  maxCandidates: number;
  concurrency: number;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;

export const DEFAULT_LIMITS: InstallLimits = {
  maxFilesPerSkill: 500,
  maxFileBytes: 5 * BYTES_PER_MEGABYTE,
  maxSkillBytes: 25 * BYTES_PER_MEGABYTE,
  maxCandidates: 200,
  concurrency: 6,
};

const SKILL_FILE_NAME = 'SKILL.md';
const MAX_SKILL_MD_BYTES = BYTES_PER_MEGABYTE;
const MAX_NAME_LENGTH = 64;
const SKILL_MD_PREVIEW_LENGTH = 20000;
const CANDIDATE_ID_LENGTH = 12;
const GIT_SYMLINK_MODE = '120000';
const SYMLINK_BACKUP_SUFFIX = '.symlink.txt';

/** Dependency and VCS folders: never part of a skill. */
const IGNORED_FOLDER = /(^|\/)(\.git|node_modules|__pycache__|\.venv|venv)(\/|$)/;
const TRAILING_SLASHES = /\/+$/;

/** What each hint looks for in the repository, to explain why it holds no skills. */
const CLAUDE_PLUGIN_FOLDER = /^\.claude-plugin\//;
const CURSOR_PLUGIN_FOLDER = /^\.cursor-plugin\//;
const MISCASED_SKILL_FILE = /(^|\/)skill\.md$/i;
const PACKAGE_JSON = /(^|\/)package\.json$/;

export interface CandidateFile {
  /** Relative to the skill folder, POSIX. */
  path: string;
  size: number;
  mode: string;
}

export interface Candidate {
  id: string;
  /** Repo-relative folder ('' = repo root). */
  repoDir: string;
  dirName: string;
  /** Folder name it will be installed as. */
  installName: string;
  name?: string;
  description?: string;
  treeSha?: string;
  files: CandidateFile[];
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
  issues: Issue[];
  findings: Finding[];
  skillMdPreview: string;
  installable: boolean;
  blockReason?: string;
}

export interface RepoInspection {
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  subpath: string;
  url: string;
  candidates: Candidate[];
  notes: string[];
  truncated: boolean;
}

export interface ResolvedTarget {
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  /** Root tree SHA of `commit` (GitHub does not return it from the trees endpoint). */
  rootTreeSha?: string;
  subpath: string;
}

function megabytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MEGABYTE);
}

/** Step 1: resolve the URL, list the tree and find every folder that contains a SKILL.md. Downloads only SKILL.md files. */
export async function inspectRepository(client: GitHubClient, parsed: ParsedGitHubUrl, limits: InstallLimits = DEFAULT_LIMITS): Promise<RepoInspection> {
  const { ref, commit, rootTreeSha, subpath } = await client.resolve(parsed);
  return inspectResolved(client, { owner: parsed.owner, repo: parsed.repo, ref, commit, rootTreeSha, subpath }, limits);
}

function isSkillFile(entry: TreeEntry): boolean {
  return entry.type === 'blob' && !IGNORED_FOLDER.test(entry.path) && (entry.path === SKILL_FILE_NAME || entry.path.endsWith(`/${SKILL_FILE_NAME}`));
}

/**
 * Repo-relative folders that are skills: they contain a SKILL.md (exact case)
 * and aren't inside another skill or a dependency/VCS folder. '' = repo root.
 */
export function findSkillDirs(entries: TreeEntry[]): string[] {
  const skillDirs = entries
    .filter(isSkillFile)
    .map((entry) => (entry.path === SKILL_FILE_NAME ? '' : entry.path.slice(0, -`/${SKILL_FILE_NAME}`.length)))
    .sort((first, second) => first.length - second.length || first.localeCompare(second));
  // A nested SKILL.md belongs to its parent skill's files: keep only the outermost folders.
  const isInsideAnother = (dir: string, index: number) => skillDirs.slice(0, index).some((outer) => outer === '' || dir.startsWith(outer + '/'));
  return skillDirs.filter((dir, index) => !isInsideAnother(dir, index));
}

function noSkillsError(entries: TreeEntry[], entriesInScope: TreeEntry[], subpath: string): UserError {
  const repoHas = (pattern: RegExp) => entries.some((entry) => pattern.test(entry.path));
  const hints: string[] = [];
  if (repoHas(CLAUDE_PLUGIN_FOLDER)) hints.push('It looks like a Claude Code plugin — install it with `/plugin` in Claude Code.');
  if (repoHas(CURSOR_PLUGIN_FOLDER)) hints.push('It looks like a Cursor plugin — install it from Cursor’s Customize panel.');
  if (entriesInScope.some((entry) => MISCASED_SKILL_FILE.test(entry.path))) hints.push('Found a "skill.md" with different casing; agents require exactly "SKILL.md".');
  if (repoHas(PACKAGE_JSON) && !hints.length) hints.push('It may be an MCP server or a VS Code extension, which are not Agent Skills.');
  const where = subpath ? ` under ${subpath}` : '';
  return new UserError(`No SKILL.md found${where} — this is not an Agent Skills repository. ${hints.join(' ')}`.trim(), 'no-skills');
}

/** Two skills of one repository that would install into the same folder: only the first stays installable. */
function blockInstallNameCollisions(candidates: Candidate[]): void {
  const firstByName = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const first = firstByName.get(candidate.installName);
    if (!first) {
      firstByName.set(candidate.installName, candidate);
      continue;
    }
    candidate.installable = false;
    candidate.blockReason = `Another skill in this repository is also named "${candidate.installName}" (${first.repoDir || '/'}).`;
  }
}

/** Same as inspectRepository, for an already-resolved ref/commit (used by updates). */
export async function inspectResolved(client: GitHubClient, target: ResolvedTarget, limits: InstallLimits = DEFAULT_LIMITS): Promise<RepoInspection> {
  const { owner, repo, ref, commit, subpath } = target;
  const { entries, truncated } = await client.tree(owner, repo, commit);
  const notes: string[] = [];
  if (truncated) {
    notes.push('GitHub truncated the file tree (very large repository). Some skills may be missing; paste a folder URL to narrow it down.');
  }

  const subpathPrefix = subpath ? subpath.replace(TRAILING_SLASHES, '') + '/' : '';
  const isInScope = (entry: TreeEntry) => !subpathPrefix || entry.path === subpath || entry.path.startsWith(subpathPrefix);
  const entriesInScope = entries.filter((entry) => isInScope(entry) && !IGNORED_FOLDER.test(entry.path));
  if (subpath && !entries.some((entry) => entry.path === subpath)) throw new UserError(`Path "${subpath}" does not exist at ${ref}.`);

  let skillDirs = findSkillDirs(entriesInScope);
  if (skillDirs.length === 0) throw noSkillsError(entries, entriesInScope, subpath);
  if (skillDirs.length > limits.maxCandidates) {
    notes.push(`Found ${skillDirs.length} skills; showing the first ${limits.maxCandidates}. Paste a folder URL to narrow it down.`);
    skillDirs = skillDirs.slice(0, limits.maxCandidates);
  }

  const treeShaByPath = new Map(entries.filter((entry) => entry.type === 'tree').map((entry) => [entry.path, entry.sha]));
  if (target.rootTreeSha) treeShaByPath.set('', target.rootTreeSha);
  const candidates = await mapWithConcurrency(skillDirs, limits.concurrency, async (skillDir) => {
    const skillEntries = entriesInScope.filter((entry) => skillDir === '' || entry.path.startsWith(skillDir + '/'));
    return buildCandidate(client, { owner, repo, commit }, skillDir, skillEntries, treeShaByPath.get(skillDir), limits);
  });
  blockInstallNameCollisions(candidates);

  const subpathInUrl = subpath ? '/' + subpath : '';
  return { owner, repo, ref, commit, subpath, url: `https://github.com/${owner}/${repo}/tree/${ref}${subpathInUrl}`, candidates, notes, truncated };
}

/**
 * Which tree entries of a skill folder get installed. Shared with the update
 * diff so both agree on what "the installed files" are.
 */
export function selectFiles(
  repoDir: string,
  entries: TreeEntry[],
  limits: InstallLimits = DEFAULT_LIMITS,
): { files: Array<CandidateFile & { sha: string }>; skipped: Candidate['skipped']; total: number } {
  const files: Array<CandidateFile & { sha: string }> = [];
  const skipped: Candidate['skipped'] = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.type === 'tree') continue;
    const relativePath = repoDir === '' ? entry.path : entry.path.slice(repoDir.length + 1);
    const skip = (reason: string) => skipped.push({ path: relativePath, reason });
    if (entry.type === 'commit') {
      skip('git submodule (not downloaded)');
      continue;
    }
    if (entry.mode === GIT_SYMLINK_MODE) {
      skip('symlink (not followed for safety)');
      continue;
    }
    try {
      validateRelativePath(relativePath);
    } catch (error) {
      skip((error as Error).message);
      continue;
    }
    const size = entry.size ?? 0;
    if (size > limits.maxFileBytes) {
      skip(`larger than ${megabytes(limits.maxFileBytes)} MB`);
      continue;
    }
    if (files.length >= limits.maxFilesPerSkill) {
      skip(`over the ${limits.maxFilesPerSkill}-file limit`);
      continue;
    }
    files.push({ path: relativePath, size, mode: entry.mode, sha: entry.sha });
    total += size;
  }
  return { files, skipped, total };
}

/** Installs as the spec-valid `name` when there is one, else a sanitized folder name. */
function installNameFor(declaredName: string | undefined, dirName: string): string {
  const isValid = !!declaredName && SKILL_NAME_RE.test(declaredName) && declaredName.length <= MAX_NAME_LENGTH;
  return isValid ? declaredName : toSkillDirName(dirName);
}

async function buildCandidate(
  client: GitHubClient,
  source: { owner: string; repo: string; commit: string },
  repoDir: string,
  entries: TreeEntry[],
  treeSha: string | undefined,
  limits: InstallLimits,
): Promise<Candidate> {
  const dirName = repoDir === '' ? source.repo : repoDir.split('/').pop()!;
  const selected = selectFiles(repoDir, entries, limits);
  const files: CandidateFile[] = selected.files.map(({ path: filePath, size, mode }) => ({ path: filePath, size, mode }));
  const { skipped, total } = selected;
  const id = createHash('sha1').update(`${source.owner}/${source.repo}@${source.commit}:${repoDir}`).digest('hex').slice(0, CANDIDATE_ID_LENGTH);

  let skillMd = '';
  let issues: Issue[] = [];
  let name: string | undefined;
  let description: string | undefined;
  let blockReason: string | undefined;
  try {
    const skillMdPath = repoDir ? `${repoDir}/${SKILL_FILE_NAME}` : SKILL_FILE_NAME;
    const bytes = await client.file(source.owner, source.repo, source.commit, skillMdPath, MAX_SKILL_MD_BYTES);
    skillMd = Buffer.from(bytes).toString('utf8');
    const frontmatter = parseFrontmatter(skillMd);
    issues = validateSkill({
      dirName,
      frontmatter: frontmatter.data,
      hasFrontmatter: frontmatter.hasFrontmatter,
      parseError: frontmatter.error,
      lineCount: skillMd.split('\n').length,
    });
    if (typeof frontmatter.data['name'] === 'string') name = frontmatter.data['name'];
    if (typeof frontmatter.data['description'] === 'string') description = frontmatter.data['description'].trim();
  } catch (error) {
    blockReason = (error as Error).message;
  }

  const installName = installNameFor(name, dirName);
  if (name && installName !== name) {
    issues.push({ severity: 'info', code: 'install-name', message: `Will be installed in folder "${installName}".` });
  }
  if (total > limits.maxSkillBytes) {
    const sizeInMegabytes = (total / BYTES_PER_MEGABYTE).toFixed(1);
    blockReason = `Skill is ${sizeInMegabytes} MB (limit ${megabytes(limits.maxSkillBytes)} MB).`;
  }
  const frontmatterIsBroken = issues.some((issue) => issue.code === 'frontmatter-invalid' || issue.code === 'frontmatter-missing');
  if (frontmatterIsBroken) blockReason = blockReason ?? 'SKILL.md frontmatter is missing or invalid.';

  const skillMdFindings = skillMd ? inspectContent(SKILL_FILE_NAME, Buffer.from(skillMd, 'utf8')) : [];
  return {
    id,
    repoDir,
    dirName,
    installName,
    name,
    description,
    treeSha,
    files,
    skipped,
    totalBytes: total,
    issues,
    findings: [...inspectFileList(files), ...skillMdFindings],
    skillMdPreview: skillMd.slice(0, SKILL_MD_PREVIEW_LENGTH),
    installable: blockReason === undefined,
    blockReason,
  };
}

export interface StagedSkill {
  candidate: Candidate;
  stagingDir: string;
  findings: Finding[];
  contentHash: string;
  fileCount: number;
  bytes: number;
}

/** Step 2: download every file of the selected candidates into a private staging folder and inspect all content. */
export async function stageCandidates(
  client: GitHubClient,
  inspection: RepoInspection,
  candidateIds: string[],
  stagingRoot: string,
  limits: InstallLimits = DEFAULT_LIMITS,
): Promise<StagedSkill[]> {
  const selected = inspection.candidates.filter((candidate) => candidateIds.includes(candidate.id));
  if (selected.length === 0) throw new UserError('Select at least one skill.');
  const blocked = selected.find((candidate) => !candidate.installable);
  if (blocked) throw new UserError(`"${blocked.installName}" cannot be installed: ${blocked.blockReason}`);

  const staged: StagedSkill[] = [];
  for (const candidate of selected) {
    staged.push(await stageCandidate(client, inspection, candidate, stagingRoot, limits));
  }
  return staged;
}

async function stageCandidate(client: GitHubClient, inspection: RepoInspection, candidate: Candidate, stagingRoot: string, limits: InstallLimits): Promise<StagedSkill> {
  const stagingDir = path.join(stagingRoot, randomUUID(), candidate.installName);
  await fs.mkdir(stagingDir, { recursive: true });
  const contentHash = createHash('sha256');
  const findings: Finding[] = [...inspectFileList(candidate.files)];
  const sortedFiles = [...candidate.files].sort((first, second) => first.path.localeCompare(second.path));
  const downloads = await mapWithConcurrency(sortedFiles, limits.concurrency, (file) => {
    const repoPath = candidate.repoDir ? `${candidate.repoDir}/${file.path}` : file.path;
    return client.file(inspection.owner, inspection.repo, inspection.commit, repoPath, limits.maxFileBytes);
  });

  let totalBytes = 0;
  for (const [index, file] of sortedFiles.entries()) {
    const bytes = downloads[index];
    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxSkillBytes) throw new UserError(`"${candidate.installName}" exceeds the size limit while downloading.`);
    const destination = safeJoin(stagingDir, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, NEW_FILE);
    contentHash.update(file.path).update('\0').update(bytes).update('\0');
    findings.push(...inspectContent(file.path, bytes));
  }
  return { candidate, stagingDir, findings: dedupeFindings(findings), contentHash: contentHash.digest('hex'), fileCount: sortedFiles.length, bytes: totalBytes };
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}|${finding.file}|${finding.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface InstallPlan {
  staged: StagedSkill;
  location: ResolvedLocation;
  targetDir: string;
  exists: boolean;
  existingIsSymlink: boolean;
}

export async function planInstall(staged: StagedSkill[], location: ResolvedLocation): Promise<InstallPlan[]> {
  if (location.readOnly) throw new UserError(`${location.label} is read-only: ${location.readOnlyReason ?? ''}`.trim());
  return Promise.all(
    staged.map(async (stagedSkill) => {
      const targetDir = safeJoin(location.path, stagedSkill.candidate.installName);
      const existing = await fs.lstat(targetDir).catch(() => null);
      return { staged: stagedSkill, location, targetDir, exists: !!existing, existingIsSymlink: !!existing?.isSymbolicLink() };
    }),
  );
}

/** Renames a folder; across devices (where rename fails) copies it and removes the original. */
export async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error;
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

export interface InstallResult {
  name: string;
  targetDir: string;
  backupDir?: string;
}

export interface InstallDeps {
  lock: LockStore;
  backupRoot: string;
  inspection: RepoInspection;
  /** Test hook to simulate a failure after the old copy was moved away. */
  _failAfterBackup?: boolean;
}

function githubSourceFor(inspection: RepoInspection, candidate: Candidate): GitHubSource {
  const { owner, repo, ref, commit } = inspection;
  const subpathInUrl = candidate.repoDir ? '/' + candidate.repoDir : '';
  return {
    type: 'github',
    owner,
    repo,
    ref,
    commit,
    subpath: candidate.repoDir,
    treeSha: candidate.treeSha,
    url: `https://github.com/${owner}/${repo}/tree/${commit}${subpathInUrl}`,
  };
}

/**
 * Step 3: move staged skills into place. Existing folders are only replaced
 * with `overwrite`, and are moved to a backup first. Any failure restores the
 * previous state.
 */
export async function commitInstall(plans: InstallPlan[], overwrite: boolean, deps: InstallDeps): Promise<InstallResult[]> {
  const conflicts = plans.filter((plan) => plan.exists);
  if (conflicts.length && !overwrite) {
    const names = conflicts.map((conflict) => conflict.staged.candidate.installName).join(', ');
    throw new UserError(`Already installed: ${names}. Confirm replacement to continue.`, 'conflict');
  }
  const results: InstallResult[] = [];
  for (const plan of plans) {
    const { location, targetDir, staged } = plan;
    const installName = staged.candidate.installName;
    try {
      const { backupDir } = await placeStaged({
        stagingDir: staged.stagingDir,
        location,
        targetDir,
        exists: plan.exists,
        backupRoot: deps.backupRoot,
        _failAfterBackup: deps._failAfterBackup,
        onPlaced: () =>
          deps.lock.set({
            name: installName,
            dir: targetDir,
            locationPath: location.path,
            source: githubSourceFor(deps.inspection, staged.candidate),
            installedAt: new Date().toISOString(),
            contentHash: staged.contentHash,
            fileCount: staged.fileCount,
          }),
      });
      results.push({ name: installName, targetDir, backupDir });
    } catch (error) {
      if (error instanceof UserError && error.code === 'path-traversal') throw error;
      throw new UserError(`Install of "${installName}" failed and was rolled back: ${(error as Error).message}`, 'install-failed');
    }
  }
  return results;
}

/** Moves whatever is at `targetDir` to the backup folder; a symlink is recorded as a text file with its target. */
async function backUpExisting(targetDir: string, backupRoot: string): Promise<{ backupDir: string; linkTarget?: string }> {
  const existing = await fs.lstat(targetDir);
  const backupDir = path.join(backupRoot, `${timestamp()}-${path.basename(targetDir)}`);
  await fs.mkdir(backupRoot, { recursive: true });
  if (!existing.isSymbolicLink()) {
    await moveDir(targetDir, backupDir);
    return { backupDir };
  }
  const linkTarget = await fs.readlink(targetDir);
  const linkBackup = backupDir + SYMLINK_BACKUP_SUFFIX;
  await fs.writeFile(linkBackup, linkTarget, 'utf8');
  await fs.unlink(targetDir);
  return { backupDir: linkBackup, linkTarget };
}

/**
 * Moves a staged folder to `targetDir` (directly inside `location`). An
 * existing entry is moved to a backup first. If moving or `onPlaced` fails,
 * the previous state is restored and the error is rethrown.
 */
export async function placeStaged(options: {
  stagingDir: string;
  location: ResolvedLocation;
  targetDir: string;
  exists: boolean;
  backupRoot: string;
  onPlaced?: () => Promise<void>;
  _failAfterBackup?: boolean;
}): Promise<{ backupDir?: string }> {
  const { location, targetDir } = options;
  const isDirectlyInLocation = isPathInside(targetDir, location.path) && pathKey(path.dirname(targetDir)) === pathKey(location.path);
  if (!isDirectlyInLocation) throw new UserError('Refusing to write outside the skills folder.', 'path-traversal');
  await fs.mkdir(location.path, { recursive: true });
  // Resolve the location once, so a symlinked skills folder can't redirect the write afterwards.
  const realLocation = await fs.realpath(location.path);
  const realTarget = path.join(realLocation, path.basename(targetDir));

  const previous = options.exists ? await backUpExisting(targetDir, options.backupRoot) : undefined;
  try {
    if (options._failAfterBackup) throw new Error('Simulated failure');
    await moveDir(options.stagingDir, realTarget);
    await options.onPlaced?.();
    return { backupDir: previous?.backupDir };
  } catch (error) {
    await fs.rm(realTarget, { recursive: true, force: true }).catch(() => undefined);
    if (previous?.linkTarget !== undefined) await fs.symlink(previous.linkTarget, targetDir).catch(() => undefined);
    else if (previous) await moveDir(previous.backupDir, targetDir).catch(() => undefined);
    throw error;
  }
}

export interface UninstallResult {
  kind: 'unlinked' | 'moved';
  backupDir?: string;
  linkTarget?: string;
}

/**
 * Removes a skill. Symlinks are unlinked (their target is never touched).
 * Real folders are moved to a recoverable backup instead of being deleted.
 */
export async function uninstallSkill(skill: SkillRecord, location: ResolvedLocation, deps: { lock: LockStore; trashRoot: string }): Promise<UninstallResult> {
  if (skill.readOnly) throw new UserError(`"${skill.name}" is read-only: ${skill.readOnlyReason ?? ''}`.trim());
  if (location.readOnly) throw new UserError(`${location.label} is read-only.`);
  if (pathKey(path.dirname(skill.dir)) !== pathKey(location.path)) {
    throw new UserError('Refusing to remove a folder that is not directly inside a known skills location.', 'path-traversal');
  }
  // Re-check at action time: the folder may have changed since the last scan.
  const current = await fs.lstat(skill.dir).catch(() => null);
  if (!current) throw new UserError(`"${skill.name}" no longer exists. Refresh the list.`);
  if (current.isSymbolicLink()) {
    const linkTarget = await fs.readlink(skill.dir);
    await fs.unlink(skill.dir);
    await deps.lock.remove(skill.dir);
    return { kind: 'unlinked', linkTarget };
  }
  if (!current.isDirectory()) throw new UserError(`"${skill.dir}" is not a folder.`);
  await fs.mkdir(deps.trashRoot, { recursive: true });
  const backupDir = path.join(deps.trashRoot, `${timestamp()}-${path.basename(skill.dir)}`);
  await moveDir(skill.dir, backupDir);
  await deps.lock.remove(skill.dir);
  return { kind: 'moved', backupDir };
}

export async function cleanupStaging(staged: StagedSkill[]): Promise<void> {
  for (const stagedSkill of staged) {
    await fs.rm(path.dirname(stagedSkill.stagingDir), { recursive: true, force: true }).catch(() => undefined);
  }
}
