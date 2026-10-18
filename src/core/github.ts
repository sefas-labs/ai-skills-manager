import { UserError } from './types';

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  /** Segments after /tree/ or /blob/ — ref and path can't be split without asking GitHub (refs may contain "/"). */
  refAndPath?: string[];
  /** True when the URL pointed at a file (…/blob/…/SKILL.md). */
  pointsToFile: boolean;
  original: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Accepts:
 *   https://github.com/owner/repo(.git)(/)
 *   https://github.com/owner/repo/tree/<ref>/<path>
 *   https://github.com/owner/repo/blob/<ref>/<path>/SKILL.md
 *   git@github.com:owner/repo.git
 *   owner/repo
 */
export function parseGitHubUrl(input: string): ParsedGitHubUrl {
  const original = input;
  let s = input.trim();
  if (!s) throw new UserError('Paste a GitHub URL, for example https://github.com/owner/repo');

  const ssh = /^git@github\.com:([^/]+)\/(.+?)(\.git)?\/?$/.exec(s);
  if (ssh) return finish(ssh[1], ssh[2], undefined, false, original);

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
    const [o, r] = s.split('/');
    return finish(o, r.replace(/\.git$/, ''), undefined, false, original);
  }

  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new UserError(`Not a valid URL: ${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserError('Only https:// GitHub URLs are supported.');
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new UserError(`Only github.com URLs are supported in this version (got ${url.hostname}).`);
  }
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  if (parts.length < 2) throw new UserError('The URL must include an owner and a repository, e.g. github.com/owner/repo');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (parts.length === 2) return finish(owner, repo, undefined, false, original);
  const kind = parts[2];
  if (kind !== 'tree' && kind !== 'blob') {
    throw new UserError(`Unsupported GitHub URL. Use the repository URL or a folder URL (…/tree/<branch>/<path>).`);
  }
  const rest = parts.slice(3);
  if (rest.length === 0) throw new UserError('The URL is missing a branch or tag after /tree/.');
  let pointsToFile = false;
  if (kind === 'blob') {
    pointsToFile = true;
    const last = rest[rest.length - 1];
    if (last !== 'SKILL.md') throw new UserError('File URLs must point to a SKILL.md. Use the folder URL instead.');
    rest.pop();
    if (rest.length === 0) throw new UserError('The URL is missing a branch or tag.');
  }
  return finish(owner, repo, rest, pointsToFile, original);
}

function finish(owner: string, repo: string, refAndPath: string[] | undefined, pointsToFile: boolean, original: string): ParsedGitHubUrl {
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || owner.startsWith('.') || repo.startsWith('.')) {
    throw new UserError(`"${owner}/${repo}" is not a valid GitHub repository name.`);
  }
  return { owner, repo, refAndPath, pointsToFile, original };
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface GitHubClientOptions {
  fetch: FetchLike;
  /** OAuth token from the editor's GitHub sign-in. Never logged, only sent to GitHub hosts. */
  token?: string;
  apiBase?: string;
  rawBase?: string;
  signal?: AbortSignal;
}

interface CommitBody {
  sha: string;
  commit?: { tree?: { sha?: string } };
}

const TOKEN_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);

export class GitHubClient {
  private readonly api: string;
  private readonly raw: string;

  constructor(private readonly opts: GitHubClientOptions) {
    this.api = opts.apiBase ?? 'https://api.github.com';
    this.raw = opts.rawBase ?? 'https://raw.githubusercontent.com';
  }

  get authenticated(): boolean {
    return !!this.opts.token;
  }

  private headers(url: string, accept: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-skills-manager-vscode',
    };
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* ignore */
    }
    if (this.opts.token && TOKEN_HOSTS.has(host)) h['Authorization'] = `Bearer ${this.opts.token}`;
    return h;
  }

  private async getJson<T>(pathAndQuery: string): Promise<{ status: number; body?: T }> {
    const url = this.api + pathAndQuery;
    const res = await this.opts.fetch(url, { headers: this.headers(url, 'application/vnd.github+json'), signal: this.opts.signal });
    if (res.ok) return { status: res.status, body: (await res.json()) as T };
    if (res.status === 403 || res.status === 429) {
      if (res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429) {
        throw new UserError(
          this.authenticated
            ? 'GitHub API rate limit reached. Try again later.'
            : 'GitHub API rate limit reached (60 requests/hour without sign-in). Sign in to GitHub to raise the limit.',
          'rate-limit',
        );
      }
    }
    if (res.status === 401) throw new UserError('GitHub rejected the credentials. Sign in to GitHub again.', 'auth');
    return { status: res.status };
  }

  /** Resolves ref + subpath. With refs containing "/", tries the longest-prefix split GitHub accepts. */
  async resolve(parsed: ParsedGitHubUrl): Promise<{ ref: string; commit: string; rootTreeSha?: string; subpath: string; defaultBranch?: string }> {
    const { owner, repo } = parsed;
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    if (!parsed.refAndPath) {
      const r = await this.getJson<{ default_branch: string }>(base);
      if (!r.body) throw this.notFound(owner, repo, r.status);
      const ref = r.body.default_branch;
      const c = await this.getJson<CommitBody>(`${base}/commits/${encodeURIComponent(ref)}`);
      if (!c.body) throw new UserError(`Could not resolve branch "${ref}".`);
      return { ref, commit: c.body.sha, rootTreeSha: c.body.commit?.tree?.sha, subpath: '', defaultBranch: ref };
    }
    const segs = parsed.refAndPath;
    for (let i = 1; i <= segs.length; i++) {
      const ref = segs.slice(0, i).join('/');
      const c = await this.getJson<CommitBody>(`${base}/commits/${encodeURIComponent(ref)}`);
      if (c.body?.sha) return { ref, commit: c.body.sha, rootTreeSha: c.body.commit?.tree?.sha, subpath: segs.slice(i).join('/') };
      if (c.status !== 404 && c.status !== 422) throw this.notFound(owner, repo, c.status);
    }
    // Maybe the repo itself doesn't exist / is private.
    const r = await this.getJson(base);
    if (!r.body) throw this.notFound(owner, repo, r.status);
    throw new UserError(`Branch, tag or commit not found in ${owner}/${repo}: ${segs.join('/')}`);
  }

  private notFound(owner: string, repo: string, status: number): UserError {
    if (status === 404) {
      return new UserError(
        this.authenticated
          ? `Repository ${owner}/${repo} was not found or your GitHub account has no access to it.`
          : `Repository ${owner}/${repo} was not found. If it is private, sign in to GitHub first.`,
        'not-found',
      );
    }
    return new UserError(`GitHub returned HTTP ${status} for ${owner}/${repo}.`, 'http');
  }

  /** Current commit of a ref and its root tree SHA; undefined when the ref no longer exists. */
  async commit(owner: string, repo: string, ref: string): Promise<{ sha: string; treeSha?: string } | undefined> {
    const r = await this.getJson<CommitBody>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`);
    if (r.body?.sha) return { sha: r.body.sha, treeSha: r.body.commit?.tree?.sha };
    if (r.status === 404 || r.status === 422) return undefined;
    throw new UserError(`GitHub returned HTTP ${r.status} for ${owner}/${repo}@${ref}.`, 'http');
  }

  /**
   * `sha` may be a commit or a tree SHA. Note: when it is a commit, GitHub
   * answers with the commit SHA in `sha`, not the root tree's — use commit().
   */
  async tree(owner: string, repo: string, sha: string, recursive = true): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const r = await this.getJson<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`,
    );
    if (!r.body) throw new UserError(`Could not read the file tree of ${owner}/${repo} (HTTP ${r.status}).`);
    return { entries: r.body.tree ?? [], truncated: !!r.body.truncated };
  }

  /** Downloads one file at an exact commit. Enforces a byte limit. */
  async file(owner: string, repo: string, commit: string, filePath: string, maxBytes: number): Promise<Uint8Array> {
    const url = `${this.raw}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commit)}/${filePath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const res = await this.opts.fetch(url, { headers: this.headers(url, '*/*'), signal: this.opts.signal });
    if (!res.ok) throw new UserError(`Could not download ${filePath} (HTTP ${res.status}).`, 'download');
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > maxBytes) throw new UserError(`${filePath} is larger than the ${Math.round(maxBytes / 1024)} KB limit.`, 'too-large');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new UserError(`${filePath} is larger than the ${Math.round(maxBytes / 1024)} KB limit.`, 'too-large');
    return buf;
  }
}
