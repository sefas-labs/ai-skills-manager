import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseFrontmatter } from './frontmatter';
import { GitHubClient, ParsedGitHubUrl, TreeEntry } from './github';
import { Finding, inspectContent, inspectFileList } from './inspector';
import type { LockStore } from './lockfile';
import { isPathInside, pathKey, safeJoin, SKILL_NAME_RE, toSkillDirName, validateRelativePath } from './paths';
import { validateSkill } from './validate';
import { GitHubSource, Issue, ResolvedLocation, SkillRecord, UserError } from './types';

export interface InstallLimits {
  maxFilesPerSkill: number;
  maxFileBytes: number;
  maxSkillBytes: number;
  maxCandidates: number;
  concurrency: number;
}

export const DEFAULT_LIMITS: InstallLimits = {
  maxFilesPerSkill: 500,
  maxFileBytes: 5 * 1024 * 1024,
  maxSkillBytes: 25 * 1024 * 1024,
  maxCandidates: 200,
  concurrency: 6,
};

const IGNORED_DIRS = /(^|\/)(\.git|node_modules|__pycache__|\.venv|venv)(\/|$)/;

export interface CandidateFile {
  path: string; // relative to the skill dir, POSIX
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

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Step 1: resolve the URL, list the tree and find every folder that contains a SKILL.md. Downloads only SKILL.md files. */
export async function inspectRepository(
  client: GitHubClient,
  parsed: ParsedGitHubUrl,
  limits: InstallLimits = DEFAULT_LIMITS,
): Promise<RepoInspection> {
  const { ref, commit, rootTreeSha, subpath } = await client.resolve(parsed);
  return inspectResolved(client, { owner: parsed.owner, repo: parsed.repo, ref, commit, rootTreeSha, subpath }, limits);
}

/**
 * Repo-relative folders that are skills: they contain a SKILL.md (exact case)
 * and aren't inside another skill or a dependency/VCS folder. '' = repo root.
 */
export function findSkillDirs(entries: TreeEntry[]): string[] {
  const dirs = entries
    .filter((e) => e.type === 'blob' && !IGNORED_DIRS.test(e.path) && (e.path === 'SKILL.md' || e.path.endsWith('/SKILL.md')))
    .map((e) => (e.path === 'SKILL.md' ? '' : e.path.slice(0, -'/SKILL.md'.length)))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  // Keep only outermost skill folders (a nested SKILL.md belongs to its parent skill's files).
  return dirs.filter((d, i) => !dirs.slice(0, i).some((p) => p === '' || d.startsWith(p + '/')));
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

/** Same as inspectRepository, for an already-resolved ref/commit (used by updates). */
export async function inspectResolved(client: GitHubClient, target: ResolvedTarget, limits: InstallLimits = DEFAULT_LIMITS): Promise<RepoInspection> {
  const { owner, repo, ref, commit, subpath } = target;
  const { entries, truncated } = await client.tree(owner, repo, commit);
  const notes: string[] = [];
  if (truncated) {
    notes.push('GitHub truncated the file tree (very large repository). Some skills may be missing; paste a folder URL to narrow it down.');
  }

  const prefix = subpath ? subpath.replace(/\/+$/, '') + '/' : '';
  const inScope = entries.filter((e) => (prefix ? e.path === subpath || e.path.startsWith(prefix) : true) && !IGNORED_DIRS.test(e.path));
  if (subpath && !entries.some((e) => e.path === subpath)) {
    throw new UserError(`Path "${subpath}" does not exist at ${ref}.`);
  }

  let skillDirs = findSkillDirs(inScope);

  if (skillDirs.length === 0) {
    const hints: string[] = [];
    const has = (re: RegExp) => entries.some((e) => re.test(e.path));
    if (has(/^\.claude-plugin\//)) hints.push('It looks like a Claude Code plugin — install it with `/plugin` in Claude Code.');
    if (has(/^\.cursor-plugin\//)) hints.push('It looks like a Cursor plugin — install it from Cursor’s Customize panel.');
    if (inScope.some((e) => /(^|\/)skill\.md$/i.test(e.path))) hints.push('Found a "skill.md" with different casing; agents require exactly "SKILL.md".');
    if (has(/(^|\/)package\.json$/) && !hints.length) hints.push('It may be an MCP server or a VS Code extension, which are not Agent Skills.');
    throw new UserError(`No SKILL.md found${subpath ? ` under ${subpath}` : ''} — this is not an Agent Skills repository. ${hints.join(' ')}`.trim(), 'no-skills');
  }
  if (skillDirs.length > limits.maxCandidates) {
    notes.push(`Found ${skillDirs.length} skills; showing the first ${limits.maxCandidates}. Paste a folder URL to narrow it down.`);
    skillDirs = skillDirs.slice(0, limits.maxCandidates);
  }

  const treeShaByPath = new Map(entries.filter((e) => e.type === 'tree').map((e) => [e.path, e.sha]));
  if (target.rootTreeSha) treeShaByPath.set('', target.rootTreeSha);
  const candidates = await pool(skillDirs, limits.concurrency, async (dir) => {
    const files = inScope.filter((e) => (dir === '' ? true : e.path.startsWith(dir + '/')));
    return buildCandidate(client, { owner, repo, commit }, dir, files, treeShaByPath.get(dir), limits);
  });

  // Install-name collisions inside the same repo.
  const seen = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = seen.get(c.installName);
    if (prev) {
      c.installable = false;
      c.blockReason = `Another skill in this repository is also named "${c.installName}" (${prev.repoDir || '/'}).`;
    } else seen.set(c.installName, c);
  }

  return {
    owner,
    repo,
    ref,
    commit,
    subpath,
    url: `https://github.com/${owner}/${repo}/tree/${ref}${subpath ? '/' + subpath : ''}`,
    candidates,
    notes,
    truncated,
  };
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
  for (const e of entries) {
    if (e.type === 'tree') continue;
    const rel = repoDir === '' ? e.path : e.path.slice(repoDir.length + 1);
    if (e.type === 'commit') {
      skipped.push({ path: rel, reason: 'git submodule (not downloaded)' });
      continue;
    }
    if (e.mode === '120000') {
      skipped.push({ path: rel, reason: 'symlink (not followed for safety)' });
      continue;
    }
    try {
      validateRelativePath(rel);
    } catch (err) {
      skipped.push({ path: rel, reason: (err as Error).message });
      continue;
    }
    const size = e.size ?? 0;
    if (size > limits.maxFileBytes) {
      skipped.push({ path: rel, reason: `larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB` });
      continue;
    }
    if (files.length >= limits.maxFilesPerSkill) {
      skipped.push({ path: rel, reason: `over the ${limits.maxFilesPerSkill}-file limit` });
      continue;
    }
    files.push({ path: rel, size, mode: e.mode, sha: e.sha });
    total += size;
  }
  return { files, skipped, total };
}

async function buildCandidate(
  client: GitHubClient,
  src: { owner: string; repo: string; commit: string },
  repoDir: string,
  entries: TreeEntry[],
  treeSha: string | undefined,
  limits: InstallLimits,
): Promise<Candidate> {
  const dirName = repoDir === '' ? src.repo : repoDir.split('/').pop()!;
  const selected = selectFiles(repoDir, entries, limits);
  const files: CandidateFile[] = selected.files.map(({ path, size, mode }) => ({ path, size, mode }));
  const { skipped, total } = selected;

  const id = createHash('sha1').update(`${src.owner}/${src.repo}@${src.commit}:${repoDir}`).digest('hex').slice(0, 12);
  let skillMd = '';
  let issues: Issue[] = [];
  let name: string | undefined;
  let description: string | undefined;
  let installable = true;
  let blockReason: string | undefined;
  try {
    const buf = await client.file(src.owner, src.repo, src.commit, repoDir ? `${repoDir}/SKILL.md` : 'SKILL.md', 1024 * 1024);
    skillMd = Buffer.from(buf).toString('utf8');
    const fm = parseFrontmatter(skillMd);
    issues = validateSkill({
      dirName,
      frontmatter: fm.data,
      hasFrontmatter: fm.hasFrontmatter,
      parseError: fm.error,
      lineCount: skillMd.split('\n').length,
    });
    if (typeof fm.data['name'] === 'string') name = fm.data['name'] as string;
    if (typeof fm.data['description'] === 'string') description = (fm.data['description'] as string).trim();
  } catch (e) {
    installable = false;
    blockReason = (e as Error).message;
  }
  // Install as the spec-valid `name` when present, else a sanitized folder name.
  const installName = name && SKILL_NAME_RE.test(name) && name.length <= 64 ? name : toSkillDirName(dirName);
  if (name && installName !== name) {
    issues.push({ severity: 'info', code: 'install-name', message: `Will be installed in folder "${installName}".` });
  }
  if (total > limits.maxSkillBytes) {
    installable = false;
    blockReason = `Skill is ${(total / 1024 / 1024).toFixed(1)} MB (limit ${Math.round(limits.maxSkillBytes / 1024 / 1024)} MB).`;
  }
  if (issues.some((i) => i.code === 'frontmatter-invalid' || i.code === 'frontmatter-missing')) {
    installable = false;
    blockReason = blockReason ?? 'SKILL.md frontmatter is missing or invalid.';
  }

  const findings = [...inspectFileList(files), ...(skillMd ? inspectContent('SKILL.md', Buffer.from(skillMd, 'utf8')) : [])];
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
    findings,
    skillMdPreview: skillMd.slice(0, 20000),
    installable,
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
  const selected = inspection.candidates.filter((c) => candidateIds.includes(c.id));
  if (selected.length === 0) throw new UserError('Select at least one skill.');
  const blocked = selected.find((c) => !c.installable);
  if (blocked) throw new UserError(`"${blocked.installName}" cannot be installed: ${blocked.blockReason}`);

  const out: StagedSkill[] = [];
  for (const c of selected) {
    const stagingDir = path.join(stagingRoot, randomUUID(), c.installName);
    await fs.mkdir(stagingDir, { recursive: true });
    const hash = createHash('sha256');
    const findings: Finding[] = [...inspectFileList(c.files)];
    let bytes = 0;
    const sorted = [...c.files].sort((a, b) => a.path.localeCompare(b.path));
    const bufs = await pool(sorted, limits.concurrency, async (f) => {
      const repoPath = c.repoDir ? `${c.repoDir}/${f.path}` : f.path;
      return client.file(inspection.owner, inspection.repo, inspection.commit, repoPath, limits.maxFileBytes);
    });
    for (let i = 0; i < sorted.length; i++) {
      const f = sorted[i];
      const buf = bufs[i];
      bytes += buf.byteLength;
      if (bytes > limits.maxSkillBytes) throw new UserError(`"${c.installName}" exceeds the size limit while downloading.`);
      const dest = safeJoin(stagingDir, f.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // 'wx' never follows or overwrites an existing entry; 0o644 = never executable.
      await fs.writeFile(dest, buf, { flag: 'wx', mode: 0o644 });
      hash.update(f.path).update('\0').update(buf).update('\0');
      findings.push(...inspectContent(f.path, buf));
    }
    out.push({ candidate: c, stagingDir, findings: dedupeFindings(findings), contentHash: hash.digest('hex'), fileCount: sorted.length, bytes });
  }
  return out;
}

function dedupeFindings(f: Finding[]): Finding[] {
  const seen = new Set<string>();
  return f.filter((x) => {
    const k = `${x.code}|${x.file}|${x.line ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
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
    staged.map(async (s) => {
      const targetDir = safeJoin(location.path, s.candidate.installName);
      let exists = false;
      let existingIsSymlink = false;
      try {
        const st = await fs.lstat(targetDir);
        exists = true;
        existingIsSymlink = st.isSymbolicLink();
      } catch {
        /* not there */
      }
      return { staged: s, location, targetDir, exists, existingIsSymlink };
    }),
  );
}

export async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
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

/**
 * Step 3: move staged skills into place. Existing folders are only replaced
 * with `overwrite`, and are moved to a backup first. Any failure restores the
 * previous state.
 */
export async function commitInstall(plans: InstallPlan[], overwrite: boolean, deps: InstallDeps): Promise<InstallResult[]> {
  const conflicts = plans.filter((p) => p.exists);
  if (conflicts.length && !overwrite) {
    throw new UserError(`Already installed: ${conflicts.map((c) => c.staged.candidate.installName).join(', ')}. Confirm replacement to continue.`, 'conflict');
  }
  const results: InstallResult[] = [];
  for (const plan of plans) {
    const { location, targetDir, staged } = plan;
    try {
      const { backupDir } = await placeStaged({
        stagingDir: staged.stagingDir,
        location,
        targetDir,
        exists: plan.exists,
        backupRoot: deps.backupRoot,
        _failAfterBackup: deps._failAfterBackup,
        onPlaced: async () => {
          const src: GitHubSource = {
            type: 'github',
            owner: deps.inspection.owner,
            repo: deps.inspection.repo,
            ref: deps.inspection.ref,
            commit: deps.inspection.commit,
            subpath: staged.candidate.repoDir,
            treeSha: staged.candidate.treeSha,
            url: `https://github.com/${deps.inspection.owner}/${deps.inspection.repo}/tree/${deps.inspection.commit}${
              staged.candidate.repoDir ? '/' + staged.candidate.repoDir : ''
            }`,
          };
          await deps.lock.set({
            name: staged.candidate.installName,
            dir: targetDir,
            locationPath: location.path,
            source: src,
            installedAt: new Date().toISOString(),
            contentHash: staged.contentHash,
            fileCount: staged.fileCount,
          });
        },
      });
      results.push({ name: staged.candidate.installName, targetDir, backupDir });
    } catch (e) {
      if (e instanceof UserError && e.code === 'path-traversal') throw e;
      throw new UserError(`Install of "${staged.candidate.installName}" failed and was rolled back: ${(e as Error).message}`, 'install-failed');
    }
  }
  return results;
}

/**
 * Moves a staged folder to `targetDir` (directly inside `location`). An
 * existing entry is moved to a backup first (a symlink is recorded as a
 * `.symlink.txt` with its target). If moving or `onPlaced` fails, the previous
 * state is restored and the error is rethrown.
 */
export async function placeStaged(opts: {
  stagingDir: string;
  location: ResolvedLocation;
  targetDir: string;
  exists: boolean;
  backupRoot: string;
  onPlaced?: () => Promise<void>;
  _failAfterBackup?: boolean;
}): Promise<{ backupDir?: string }> {
  const { location, targetDir } = opts;
  if (!isPathInside(targetDir, location.path) || pathKey(path.dirname(targetDir)) !== pathKey(location.path)) {
    throw new UserError('Refusing to write outside the skills folder.', 'path-traversal');
  }
  await fs.mkdir(location.path, { recursive: true });
  // The location itself must not be a symlink that points somewhere unexpected after mkdir.
  const realLoc = await fs.realpath(location.path);
  const realTarget = path.join(realLoc, path.basename(targetDir));

  let backupDir: string | undefined;
  let linkTarget: string | undefined;
  if (opts.exists) {
    const st = await fs.lstat(targetDir);
    backupDir = path.join(opts.backupRoot, `${timestamp()}-${path.basename(targetDir)}`);
    await fs.mkdir(opts.backupRoot, { recursive: true });
    if (st.isSymbolicLink()) {
      linkTarget = await fs.readlink(targetDir);
      await fs.writeFile(backupDir + '.symlink.txt', linkTarget, 'utf8');
      await fs.unlink(targetDir);
      backupDir = backupDir + '.symlink.txt';
    } else {
      await moveDir(targetDir, backupDir);
    }
  }
  try {
    if (opts._failAfterBackup) throw new Error('Simulated failure');
    await moveDir(opts.stagingDir, realTarget);
    await opts.onPlaced?.();
    return { backupDir };
  } catch (e) {
    // Roll back: remove partial copy, restore previous version.
    await fs.rm(realTarget, { recursive: true, force: true }).catch(() => undefined);
    if (linkTarget !== undefined) await fs.symlink(linkTarget, targetDir).catch(() => undefined);
    else if (backupDir) await moveDir(backupDir, targetDir).catch(() => undefined);
    throw e;
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
export async function uninstallSkill(
  skill: SkillRecord,
  location: ResolvedLocation,
  deps: { lock: LockStore; trashRoot: string },
): Promise<UninstallResult> {
  if (skill.readOnly) throw new UserError(`"${skill.name}" is read-only: ${skill.readOnlyReason ?? ''}`.trim());
  if (location.readOnly) throw new UserError(`${location.label} is read-only.`);
  if (pathKey(path.dirname(skill.dir)) !== pathKey(location.path)) {
    throw new UserError('Refusing to remove a folder that is not directly inside a known skills location.', 'path-traversal');
  }
  // Re-check at action time: the folder may have changed since the last scan.
  const st = await fs.lstat(skill.dir).catch(() => null);
  if (!st) throw new UserError(`"${skill.name}" no longer exists. Refresh the list.`);
  if (st.isSymbolicLink()) {
    const linkTarget = await fs.readlink(skill.dir);
    await fs.unlink(skill.dir);
    await deps.lock.remove(skill.dir);
    return { kind: 'unlinked', linkTarget };
  }
  if (!st.isDirectory()) throw new UserError(`"${skill.dir}" is not a folder.`);
  await fs.mkdir(deps.trashRoot, { recursive: true });
  const backupDir = path.join(deps.trashRoot, `${timestamp()}-${path.basename(skill.dir)}`);
  await moveDir(skill.dir, backupDir);
  await deps.lock.remove(skill.dir);
  return { kind: 'moved', backupDir };
}

export async function cleanupStaging(staged: StagedSkill[]): Promise<void> {
  for (const s of staged) await fs.rm(path.dirname(s.stagingDir), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Prefix for backup names: sortable time plus a random suffix, so two backups
 * of same-named folders in the same millisecond never collide.
 */
export function timestamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
}
