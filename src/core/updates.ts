import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { GitHubClient } from './github';
import { DEFAULT_LIMITS, InstallLimits, inspectResolved, RepoInspection, selectFiles, stageCandidates, StagedSkill } from './installer';
import { TrackedSource, UserError } from './types';

export { trackedFromGhFrontmatter, trackedFromLock } from './provenance';

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

/** Identifies an installed version, so cached results go stale when it changes. */
export function basisOf(src: TrackedSource): string {
  return `${src.owner}/${src.repo}@${src.ref}:${src.subpath}#${src.treeSha ?? src.commit ?? ''}`.toLowerCase();
}

/**
 * Checks many skills with as few API calls as possible: one commit lookup and
 * one recursive tree per (repo, ref), shared by every skill from it. Pinned
 * skills cost nothing. A rate-limit error stops the run; the rest is reported.
 */
export async function checkUpdates(
  client: GitHubClient,
  items: Array<{ key: string; source: TrackedSource }>,
  now = () => new Date().toISOString(),
): Promise<Record<string, UpdateCheck>> {
  const out: Record<string, UpdateCheck> = {};
  const groups = new Map<string, Array<{ key: string; source: TrackedSource }>>();
  for (const it of items) {
    if (it.source.pinned) {
      out[it.key] = { status: 'pinned', checkedAt: now(), message: `Pinned to ${it.source.ref.slice(0, 12)}.` };
      continue;
    }
    const g = `${it.source.owner}/${it.source.repo}@${it.source.ref}`.toLowerCase();
    groups.set(g, [...(groups.get(g) ?? []), it]);
  }
  let stop: string | undefined;
  for (const list of groups.values()) {
    const { owner, repo, ref } = list[0].source;
    if (stop) {
      for (const it of list) out[it.key] = { status: 'error', checkedAt: now(), message: stop };
      continue;
    }
    try {
      const head = await client.commit(owner, repo, ref);
      if (!head) {
        for (const it of list) out[it.key] = { status: 'ref-missing', checkedAt: now(), message: `"${ref}" no longer exists in ${owner}/${repo}.` };
        continue;
      }
      const finder = subtreeFinder(client, owner, repo, head.sha, head.treeSha);
      for (const it of list) {
        const remoteTreeSha = await finder(it.source.subpath);
        const base = { checkedAt: now(), basis: basisOf(it.source), remoteCommit: head.sha, remoteTreeSha };
        if (!remoteTreeSha) out[it.key] = { ...base, status: 'path-missing', message: `${it.source.subpath || '/'} no longer exists at ${ref}.` };
        else if (it.source.treeSha) out[it.key] = { ...base, status: remoteTreeSha === it.source.treeSha ? 'up-to-date' : 'update-available' };
        else if (it.source.commit === head.sha) out[it.key] = { ...base, status: 'up-to-date' };
        else out[it.key] = { ...base, status: 'unknown', message: 'Installed without a tree SHA; review the update to compare files.' };
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (e instanceof UserError && (e.code === 'rate-limit' || e.code === 'auth')) stop = msg;
      for (const it of list) out[it.key] = { status: 'error', checkedAt: now(), message: msg };
    }
  }
  return out;
}

/** Finds the tree SHA of a sub-folder at a commit, reusing one recursive listing; walks level by level if GitHub truncated it. */
function subtreeFinder(client: GitHubClient, owner: string, repo: string, commit: string, rootTreeSha?: string) {
  let listing: Promise<{ bySha: Map<string, string>; truncated: boolean }> | undefined;
  return async (subpath: string): Promise<string | undefined> => {
    if (!subpath) return rootTreeSha;
    listing ??= client.tree(owner, repo, commit).then(({ entries, truncated }) => ({
      bySha: new Map(entries.filter((e) => e.type === 'tree').map((e) => [e.path, e.sha])),
      truncated,
    }));
    const { bySha, truncated } = await listing;
    const hit = bySha.get(subpath);
    if (hit || !truncated || !rootTreeSha) return hit;
    let cur = rootTreeSha;
    for (const seg of subpath.split('/')) {
      const { entries } = await client.tree(owner, repo, cur, false);
      const next = entries.find((e) => e.type === 'tree' && e.path === seg);
      if (!next) return undefined;
      cur = next.sha;
    }
    return cur;
  };
}

// ---------- diff ----------

export interface FileDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

export function isEmptyDiff(d: FileDiff): boolean {
  return d.added.length + d.modified.length + d.removed.length === 0;
}

/** Git blob id of some bytes (what `git hash-object` prints). */
export function gitBlobSha(buf: Uint8Array): string {
  return createHash('sha1').update(`blob ${buf.byteLength}\0`).update(buf).digest('hex');
}

export function diffFiles(from: Map<string, string>, to: Map<string, string>): FileDiff {
  const d: FileDiff = { added: [], modified: [], removed: [] };
  for (const [p, sha] of to) {
    const old = from.get(p);
    if (old === undefined) d.added.push(p);
    else if (old !== sha) d.modified.push(p);
  }
  for (const p of from.keys()) if (!to.has(p)) d.removed.push(p);
  for (const k of ['added', 'modified', 'removed'] as const) d[k].sort();
  return d;
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

/** Files (path → blob SHA) of a GitHub tree, filtered exactly like an install would. */
export async function remoteTreeFiles(
  client: GitHubClient,
  owner: string,
  repo: string,
  treeSha: string,
  limits: InstallLimits = DEFAULT_LIMITS,
): Promise<Map<string, string>> {
  const { entries } = await client.tree(owner, repo, treeSha);
  return new Map(selectFiles('', entries, limits).files.map((f) => [f.path, f.sha]));
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

/**
 * Downloads the latest version of a tracked skill into staging and computes
 * what an update would change. Writes nothing outside `stagingRoot`.
 */
export async function prepareUpdate(
  client: GitHubClient,
  opts: { source: TrackedSource; skillDir: string; stagingRoot: string; limits?: InstallLimits },
): Promise<UpdatePreview> {
  const { source, skillDir, stagingRoot } = opts;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  if (source.pinned) throw new UserError(`This skill is pinned to ${source.ref.slice(0, 12)}; it is not updated automatically.`, 'pinned');
  const head = await client.commit(source.owner, source.repo, source.ref);
  if (!head) throw new UserError(`"${source.ref}" no longer exists in ${source.owner}/${source.repo}.`, 'ref-missing');
  const inspection = await inspectResolved(
    client,
    { owner: source.owner, repo: source.repo, ref: source.ref, commit: head.sha, rootTreeSha: head.treeSha, subpath: source.subpath },
    limits,
  );
  const found = inspection.candidates.find((c) => c.repoDir === source.subpath);
  if (!found) throw new UserError(`${source.subpath || 'The repository root'} is no longer a skill at ${source.ref}.`, 'path-missing');
  // Keep the local folder name even if upstream renamed the skill.
  const candidate = { ...found, installName: path.basename(skillDir) };
  inspection.candidates = [candidate];
  const [staged] = await stageCandidates(client, inspection, [candidate.id], stagingRoot, limits);

  const notes: string[] = [];
  const remote = await localFileShas(staged.stagingDir);
  const localAll = await localFileShas(skillDir);
  let installed: Map<string, string> | undefined;
  if (source.treeSha) {
    try {
      installed = await remoteTreeFiles(client, source.owner, source.repo, source.treeSha, limits);
    } catch (e) {
      if (e instanceof UserError && e.code === 'rate-limit') throw e;
      notes.push('The installed version is no longer available on GitHub; changes are shown against your local copy.');
    }
  }
  const upstream = installed ? diffFiles(installed, remote) : diffFiles(localAll, remote);
  let localDiff: FileDiff | undefined;
  if (installed) {
    // gh rewrites SKILL.md to add its metadata, so that file always differs locally.
    const strip = (m: Map<string, string>) => {
      const c = new Map(m);
      if (source.origin === 'gh-skill') c.delete('SKILL.md');
      return c;
    };
    localDiff = diffFiles(strip(installed), strip(localAll));
  }
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
    upstreamBase: installed ? 'installed' : 'local',
    local: localDiff,
    notes,
  };
}
