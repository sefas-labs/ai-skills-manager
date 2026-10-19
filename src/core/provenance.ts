/**
 * Where a skill came from: our own lock (installed by this extension) or the
 * metadata `gh skill install` writes into SKILL.md.
 */
import { parseGitHubUrl } from './github';
import { validateRelativePath } from './paths';
import type { LockEntry, TrackedSource } from './types';

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const GITHUB_REPO_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+?(\.git)?\/?$/;
const BRANCH_OR_TAG_PREFIX = /^refs\/(heads|tags)\//;
/** Characters git forbids in ref names (see `git check-ref-format`). */
const INVALID_REF_CHARACTER = /[\s~^:?*[\\]/;
const LEADING_OR_TRAILING_SLASHES = /^\/+|\/+$/g;

export function trackedFromLock(entry: LockEntry): TrackedSource {
  const source = entry.source;
  return {
    origin: 'lock',
    owner: source.owner,
    repo: source.repo,
    ref: source.ref,
    subpath: source.subpath,
    treeSha: source.treeSha,
    commit: source.commit,
    pinned: COMMIT_SHA.test(source.ref),
  };
}

function isValidRef(ref: string): boolean {
  return !!ref && !ref.includes('..') && !INVALID_REF_CHARACTER.test(ref);
}

function isValidSubpath(subpath: string): boolean {
  if (!subpath) return true;
  try {
    validateRelativePath(subpath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Provenance written by `gh skill install` into `metadata` (verified with gh
 * 2.102.0 on 2026-10-18): `github-repo` (https URL), `github-path`,
 * `github-ref` (`refs/heads/<b>`, `refs/tags/<t>` or a SHA), `github-tree-sha`,
 * and `github-pinned` when installed with --pin. gh records no commit.
 * Frontmatter is untrusted: every value is validated, nothing is executed.
 */
export function trackedFromGhFrontmatter(frontmatter: Record<string, unknown>): TrackedSource | undefined {
  const metadata = frontmatter['metadata'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const fields = metadata as Record<string, unknown>;
  const readString = (key: string) => {
    const value = fields[key];
    return typeof value === 'string' ? value.trim() : undefined;
  };

  const repoUrl = readString('github-repo');
  if (!repoUrl || !GITHUB_REPO_URL.test(repoUrl)) return undefined;
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseGitHubUrl(repoUrl));
  } catch {
    return undefined;
  }

  const rawRef = readString('github-ref');
  if (!rawRef) return undefined;
  const ref = rawRef.replace(BRANCH_OR_TAG_PREFIX, '');
  if (!isValidRef(ref)) return undefined;

  const subpath = (readString('github-path') ?? '').replace(LEADING_OR_TRAILING_SLASHES, '');
  if (!isValidSubpath(subpath)) return undefined;

  const treeSha = readString('github-tree-sha');
  const hasValidTreeSha = !!treeSha && COMMIT_SHA.test(treeSha);
  return {
    origin: 'gh-skill',
    owner,
    repo,
    ref,
    subpath,
    treeSha: hasValidTreeSha ? treeSha.toLowerCase() : undefined,
    pinned: !!readString('github-pinned') || COMMIT_SHA.test(ref),
  };
}
