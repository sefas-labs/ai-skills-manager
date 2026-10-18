/**
 * Where a skill came from: our own lock (installed by this extension) or the
 * metadata `gh skill install` writes into SKILL.md.
 */
import { parseGitHubUrl } from './github';
import { validateRelativePath } from './paths';
import type { LockEntry, TrackedSource } from './types';

const SHA_RE = /^[0-9a-f]{40}$/i;

export function trackedFromLock(e: LockEntry): TrackedSource {
  const s = e.source;
  return {
    origin: 'lock',
    owner: s.owner,
    repo: s.repo,
    ref: s.ref,
    subpath: s.subpath,
    treeSha: s.treeSha,
    commit: s.commit,
    pinned: SHA_RE.test(s.ref),
  };
}

/**
 * Provenance written by `gh skill install` into `metadata` (verified with gh
 * 2.102.0 on 2026-10-18): `github-repo` (https URL), `github-path`,
 * `github-ref` (`refs/heads/<b>`, `refs/tags/<t>` or a SHA), `github-tree-sha`,
 * and `github-pinned` when installed with --pin. gh records no commit.
 * Frontmatter is untrusted: every value is validated, nothing is executed.
 */
export function trackedFromGhFrontmatter(fm: Record<string, unknown>): TrackedSource | undefined {
  const meta = fm['metadata'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const m = meta as Record<string, unknown>;
  const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string).trim() : undefined);
  const repoUrl = str('github-repo');
  if (!repoUrl || !/^https:\/\/github\.com\/[^/]+\/[^/]+?(\.git)?\/?$/.test(repoUrl)) return undefined;
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseGitHubUrl(repoUrl));
  } catch {
    return undefined;
  }
  const rawRef = str('github-ref');
  if (!rawRef) return undefined;
  const ref = rawRef.replace(/^refs\/(heads|tags)\//, '');
  if (!ref || ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) return undefined;
  const subpath = (str('github-path') ?? '').replace(/^\/+|\/+$/g, '');
  if (subpath) {
    try {
      validateRelativePath(subpath);
    } catch {
      return undefined;
    }
  }
  const treeSha = str('github-tree-sha');
  return {
    origin: 'gh-skill',
    owner,
    repo,
    ref,
    subpath,
    treeSha: treeSha && SHA_RE.test(treeSha) ? treeSha.toLowerCase() : undefined,
    pinned: !!str('github-pinned') || SHA_RE.test(ref),
  };
}

