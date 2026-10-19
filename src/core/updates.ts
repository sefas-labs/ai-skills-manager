import * as path from 'node:path';
import { GitHubClient } from './github';
import { DEFAULT_LIMITS, InstallLimits, inspectResolved, RepoInspection, selectFiles, stageCandidates, StagedSkill } from './installer';
import { localFileShas } from './hashing';
import { TrackedSource, UserError } from './types';

export { trackedFromGhFrontmatter, trackedFromLock } from './provenance';
export { gitBlobSha, localFileShas } from './hashing';

/**
 * Update Manager. An update exists when the tree SHA of the same sub-folder at
 * the same ref differs from the one recorded at install time (our lock, or the
 * metadata `gh skill` wrote — see provenance.ts).
 */
export type UpdateStatus = 'up-to-date' | 'update-available' | 'pinned' | 'ref-missing' | 'path-missing' | 'unknown' | 'error';

export interface UpdateCheck {
  status: UpdateStatus;
  checkedAt: string;
  /** The installed version this result was computed against (see basisOf). */
  basis?: string;
  remoteCommit?: string;
  remoteTreeSha?: string;
  message?: string;
}

interface TrackedItem {
  key: string;
  source: TrackedSource;
}

const SHORT_SHA_LENGTH = 12;
const SKILL_FILE_NAME = 'SKILL.md';

/** Identifies an installed version, so cached results go stale when it changes. */
export function basisOf(source: TrackedSource): string {
  const installedVersion = source.treeSha ?? source.commit ?? '';
  return `${source.owner}/${source.repo}@${source.ref}:${source.subpath}#${installedVersion}`.toLowerCase();
}

function repoAndRefKey(source: TrackedSource): string {
  return `${source.owner}/${source.repo}@${source.ref}`.toLowerCase();
}

/** Errors that will fail every following request too, so the run stops early. */
function stopsTheRun(error: unknown): boolean {
  return error instanceof UserError && (error.code === 'rate-limit' || error.code === 'auth');
}

function statusAgainst(item: TrackedItem, headCommit: string, remoteTreeSha: string | undefined): Pick<UpdateCheck, 'status' | 'message'> {
  const { source } = item;
  if (!remoteTreeSha) return { status: 'path-missing', message: `${source.subpath || '/'} no longer exists at ${source.ref}.` };
  if (source.treeSha) return { status: remoteTreeSha === source.treeSha ? 'up-to-date' : 'update-available' };
  if (source.commit === headCommit) return { status: 'up-to-date' };
  return { status: 'unknown', message: 'Installed without a tree SHA; review the update to compare files.' };
}

/**
 * Checks many skills with as few API calls as possible: one commit lookup and
 * one recursive tree per (repo, ref), shared by every skill from it. Pinned
 * skills cost nothing. A rate-limit error stops the run; the rest is reported.
 */
export async function checkUpdates(client: GitHubClient, items: TrackedItem[], now = () => new Date().toISOString()): Promise<Record<string, UpdateCheck>> {
  const results: Record<string, UpdateCheck> = {};
  const itemsByRepoAndRef = new Map<string, TrackedItem[]>();
  for (const item of items) {
    if (item.source.pinned) {
      results[item.key] = { status: 'pinned', checkedAt: now(), message: `Pinned to ${item.source.ref.slice(0, SHORT_SHA_LENGTH)}.` };
      continue;
    }
    const key = repoAndRefKey(item.source);
    itemsByRepoAndRef.set(key, [...(itemsByRepoAndRef.get(key) ?? []), item]);
  }

  let stopReason: string | undefined;
  const markAll = (group: TrackedItem[], check: Omit<UpdateCheck, 'checkedAt'>) => {
    for (const item of group) results[item.key] = { ...check, checkedAt: now() };
  };
  for (const group of itemsByRepoAndRef.values()) {
    const { owner, repo, ref } = group[0].source;
    if (stopReason) {
      markAll(group, { status: 'error', message: stopReason });
      continue;
    }
    try {
      const head = await client.commit(owner, repo, ref);
      if (!head) {
        markAll(group, { status: 'ref-missing', message: `"${ref}" no longer exists in ${owner}/${repo}.` });
        continue;
      }
      const findSubtreeSha = subtreeFinder(client, owner, repo, head.sha, head.treeSha);
      for (const item of group) {
        const remoteTreeSha = await findSubtreeSha(item.source.subpath);
        results[item.key] = {
          checkedAt: now(),
          basis: basisOf(item.source),
          remoteCommit: head.sha,
          remoteTreeSha,
          ...statusAgainst(item, head.sha, remoteTreeSha),
        };
      }
    } catch (error) {
      const message = (error as Error).message;
      if (stopsTheRun(error)) stopReason = message;
      markAll(group, { status: 'error', message });
    }
  }
  return results;
}

/** Finds the tree SHA of a sub-folder at a commit, reusing one recursive listing; walks level by level if GitHub truncated it. */
function subtreeFinder(client: GitHubClient, owner: string, repo: string, commit: string, rootTreeSha?: string) {
  let listing: Promise<{ treeShaByPath: Map<string, string>; truncated: boolean }> | undefined;

  const walkLevelByLevel = async (subpath: string, rootSha: string) => {
    let currentSha = rootSha;
    for (const segment of subpath.split('/')) {
      const { entries } = await client.tree(owner, repo, currentSha, false);
      const child = entries.find((entry) => entry.type === 'tree' && entry.path === segment);
      if (!child) return undefined;
      currentSha = child.sha;
    }
    return currentSha;
  };

  return async (subpath: string): Promise<string | undefined> => {
    if (!subpath) return rootTreeSha;
    listing ??= client.tree(owner, repo, commit).then(({ entries, truncated }) => ({
      treeShaByPath: new Map(entries.filter((entry) => entry.type === 'tree').map((entry) => [entry.path, entry.sha])),
      truncated,
    }));
    const { treeShaByPath, truncated } = await listing;
    const found = treeShaByPath.get(subpath);
    if (found || !truncated || !rootTreeSha) return found;
    return walkLevelByLevel(subpath, rootTreeSha);
  };
}

// ---------- diff ----------

export interface FileDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

export function isEmptyDiff(diff: FileDiff): boolean {
  return diff.added.length + diff.modified.length + diff.removed.length === 0;
}

export function diffFiles(before: Map<string, string>, after: Map<string, string>): FileDiff {
  const diff: FileDiff = { added: [], modified: [], removed: [] };
  for (const [filePath, sha] of after) {
    const previousSha = before.get(filePath);
    if (previousSha === undefined) diff.added.push(filePath);
    else if (previousSha !== sha) diff.modified.push(filePath);
  }
  for (const filePath of before.keys()) {
    if (!after.has(filePath)) diff.removed.push(filePath);
  }
  diff.added.sort();
  diff.modified.sort();
  diff.removed.sort();
  return diff;
}

/** Files (path → blob SHA) of a GitHub tree, filtered exactly like an install would. */
export async function remoteTreeFiles(client: GitHubClient, owner: string, repo: string, treeSha: string, limits: InstallLimits = DEFAULT_LIMITS): Promise<Map<string, string>> {
  const { entries } = await client.tree(owner, repo, treeSha);
  return new Map(selectFiles('', entries, limits).files.map((file) => [file.path, file.sha]));
}

// ---------- prepare ----------

export interface UpdatePreview {
  source: TrackedSource;
  inspection: RepoInspection;
  staged: StagedSkill;
  fromCommit?: string;
  toCommit: string;
  /** What changed upstream since the installed version (or vs. the local copy when that version is unknown). */
  upstream: FileDiff;
  upstreamBase: 'installed' | 'local';
  /** Local edits since install; undefined when the installed version can't be fetched. */
  local?: FileDiff;
  notes: string[];
}

/** `gh skill` rewrites SKILL.md to add its metadata, so that file always differs locally. */
function withoutGhManagedFile(files: Map<string, string>, source: TrackedSource): Map<string, string> {
  const copy = new Map(files);
  if (source.origin === 'gh-skill') copy.delete(SKILL_FILE_NAME);
  return copy;
}

/**
 * Downloads the latest version of a tracked skill into staging and computes
 * what an update would change. Writes nothing outside `stagingRoot`.
 */
export async function prepareUpdate(
  client: GitHubClient,
  options: { source: TrackedSource; skillDir: string; stagingRoot: string; limits?: InstallLimits },
): Promise<UpdatePreview> {
  const { source, skillDir, stagingRoot } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  if (source.pinned) throw new UserError(`This skill is pinned to ${source.ref.slice(0, SHORT_SHA_LENGTH)}; it is not updated automatically.`, 'pinned');
  const head = await client.commit(source.owner, source.repo, source.ref);
  if (!head) throw new UserError(`"${source.ref}" no longer exists in ${source.owner}/${source.repo}.`, 'ref-missing');
  const inspection = await inspectResolved(
    client,
    { owner: source.owner, repo: source.repo, ref: source.ref, commit: head.sha, rootTreeSha: head.treeSha, subpath: source.subpath },
    limits,
  );
  const upstreamCandidate = inspection.candidates.find((candidate) => candidate.repoDir === source.subpath);
  if (!upstreamCandidate) throw new UserError(`${source.subpath || 'The repository root'} is no longer a skill at ${source.ref}.`, 'path-missing');
  // Keep the local folder name even if upstream renamed the skill.
  const candidate = { ...upstreamCandidate, installName: path.basename(skillDir) };
  inspection.candidates = [candidate];
  const [staged] = await stageCandidates(client, inspection, [candidate.id], stagingRoot, limits);

  const notes: string[] = [];
  const latestFiles = await localFileShas(staged.stagingDir);
  const localFiles = await localFileShas(skillDir);
  let installedFiles: Map<string, string> | undefined;
  if (source.treeSha) {
    try {
      installedFiles = await remoteTreeFiles(client, source.owner, source.repo, source.treeSha, limits);
    } catch (error) {
      if (error instanceof UserError && error.code === 'rate-limit') throw error;
      notes.push('The installed version is no longer available on GitHub; changes are shown against your local copy.');
    }
  }
  const upstream = diffFiles(installedFiles ?? localFiles, latestFiles);
  const localEdits = installedFiles ? diffFiles(withoutGhManagedFile(installedFiles, source), withoutGhManagedFile(localFiles, source)) : undefined;
  if (source.origin === 'gh-skill') {
    notes.push('Installed with `gh skill`: SKILL.md is not checked for local edits (gh adds metadata to it). Updating here replaces it with the upstream file and this extension takes over tracking.');
  }
  return {
    source,
    inspection,
    staged,
    fromCommit: source.commit,
    toCommit: head.sha,
    upstream,
    upstreamBase: installedFiles ? 'installed' : 'local',
    local: localEdits,
    notes,
  };
}
