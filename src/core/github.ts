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

export interface ResolvedRef {
  ref: string;
  commit: string;
  rootTreeSha?: string;
  subpath: string;
  defaultBranch?: string;
}

interface CommitBody {
  sha: string;
  commit?: { tree?: { sha?: string } };
}

const OWNER_OR_REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SSH_REMOTE = /^git@github\.com:([^/]+)\/(.+?)(\.git)?\/?$/;
const OWNER_SLASH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HAS_SCHEME = /^[a-z]+:\/\//i;
const GIT_SUFFIX = /\.git$/;
const SKILL_FILE_PATH = /(^|\/)SKILL\.md$/;
/** Keeps letters, digits, spaces and `_.-`: GitHub search qualifiers can't be injected. */
const NOT_A_SEARCH_WORD_CHARACTER = /[^\p{L}\p{N} _.-]/gu;

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
/** The only hosts the token is ever sent to. */
const TOKEN_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);
const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'ai-skills-manager-vscode';
const JSON_ACCEPT = 'application/vnd.github+json';
const ANY_ACCEPT = '*/*';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
const DEFAULT_SEARCH_RESULTS = 30;

function validRepository(owner: string, repo: string, refAndPath: string[] | undefined, pointsToFile: boolean, original: string): ParsedGitHubUrl {
  const isValidName = (name: string) => OWNER_OR_REPO_NAME.test(name) && !name.startsWith('.');
  if (!isValidName(owner) || !isValidName(repo)) {
    throw new UserError(`"${owner}/${repo}" is not a valid GitHub repository name.`);
  }
  return { owner, repo, refAndPath, pointsToFile, original };
}

/**
 * Accepts:
 *   https://github.com/owner/repo(.git)(/)
 *   https://github.com/owner/repo/tree/<ref>/<path>
 *   https://github.com/owner/repo/blob/<ref>/<path>/SKILL.md
 *   git@github.com:owner/repo.git
 *   owner/repo
 */
export function parseGitHubUrl(input: string): ParsedGitHubUrl {
  const trimmed = input.trim();
  if (!trimmed) throw new UserError('Paste a GitHub URL, for example https://github.com/owner/repo');

  const sshRemote = SSH_REMOTE.exec(trimmed);
  if (sshRemote) return validRepository(sshRemote[1], sshRemote[2], undefined, false, input);

  if (OWNER_SLASH_REPO.test(trimmed)) {
    const [owner, repo] = trimmed.split('/');
    return validRepository(owner, repo.replace(GIT_SUFFIX, ''), undefined, false, input);
  }

  const withScheme = HAS_SCHEME.test(trimmed) ? trimmed : 'https://' + trimmed;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UserError(`Not a valid URL: ${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserError('Only https:// GitHub URLs are supported.');
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
    throw new UserError(`Only github.com URLs are supported in this version (got ${url.hostname}).`);
  }

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments.length < 2) throw new UserError('The URL must include an owner and a repository, e.g. github.com/owner/repo');
  const [owner, repoSegment, view, ...refAndPath] = segments;
  const repo = repoSegment.replace(GIT_SUFFIX, '');
  if (!view) return validRepository(owner, repo, undefined, false, input);

  if (view !== 'tree' && view !== 'blob') {
    throw new UserError(`Unsupported GitHub URL. Use the repository URL or a folder URL (…/tree/<branch>/<path>).`);
  }
  if (refAndPath.length === 0) throw new UserError('The URL is missing a branch or tag after /tree/.');
  const pointsToFile = view === 'blob';
  if (pointsToFile) {
    const fileName = refAndPath.pop();
    if (fileName !== 'SKILL.md') throw new UserError('File URLs must point to a SKILL.md. Use the folder URL instead.');
    if (refAndPath.length === 0) throw new UserError('The URL is missing a branch or tag.');
  }
  return validRepository(owner, repo, refAndPath, pointsToFile, input);
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function kilobytes(bytes: number): number {
  return Math.round(bytes / 1024);
}

export class GitHubClient {
  private readonly apiBase: string;
  private readonly rawBase: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    this.rawBase = options.rawBase ?? DEFAULT_RAW_BASE;
  }

  get authenticated(): boolean {
    return !!this.options.token;
  }

  private headers(url: string, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    };
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    if (this.options.token && TOKEN_HOSTS.has(host)) headers['Authorization'] = `Bearer ${this.options.token}`;
    return headers;
  }

  private async getJson<T>(pathAndQuery: string): Promise<{ status: number; body?: T }> {
    const url = this.apiBase + pathAndQuery;
    const response = await this.options.fetch(url, { headers: this.headers(url, JSON_ACCEPT), signal: this.options.signal });
    if (response.ok) return { status: response.status, body: (await response.json()) as T };
    const rateLimited =
      response.status === HTTP_TOO_MANY_REQUESTS || (response.status === HTTP_FORBIDDEN && response.headers.get('x-ratelimit-remaining') === '0');
    if (rateLimited) {
      const message = this.authenticated
        ? 'GitHub API rate limit reached. Try again later.'
        : 'GitHub API rate limit reached (60 requests/hour without sign-in). Sign in to GitHub to raise the limit.';
      throw new UserError(message, 'rate-limit');
    }
    if (response.status === HTTP_UNAUTHORIZED) throw new UserError('GitHub rejected the credentials. Sign in to GitHub again.', 'auth');
    return { status: response.status };
  }

  private getCommit(owner: string, repo: string, ref: string) {
    return this.getJson<CommitBody>(`${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}`);
  }

  /** Resolves ref + subpath. With refs containing "/", tries the shortest ref first until GitHub accepts one. */
  async resolve(parsed: ParsedGitHubUrl): Promise<ResolvedRef> {
    const { owner, repo } = parsed;
    if (!parsed.refAndPath) {
      const repository = await this.getJson<{ default_branch: string }>(repoPath(owner, repo));
      if (!repository.body) throw this.notFound(owner, repo, repository.status);
      const defaultBranch = repository.body.default_branch;
      const commit = await this.getCommit(owner, repo, defaultBranch);
      if (!commit.body) throw new UserError(`Could not resolve branch "${defaultBranch}".`);
      return { ref: defaultBranch, commit: commit.body.sha, rootTreeSha: commit.body.commit?.tree?.sha, subpath: '', defaultBranch };
    }

    const segments = parsed.refAndPath;
    for (let refLength = 1; refLength <= segments.length; refLength++) {
      const ref = segments.slice(0, refLength).join('/');
      const commit = await this.getCommit(owner, repo, ref);
      if (commit.body?.sha) {
        return { ref, commit: commit.body.sha, rootTreeSha: commit.body.commit?.tree?.sha, subpath: segments.slice(refLength).join('/') };
      }
      const refNotFound = commit.status === HTTP_NOT_FOUND || commit.status === HTTP_UNPROCESSABLE;
      if (!refNotFound) throw this.notFound(owner, repo, commit.status);
    }
    const repository = await this.getJson(repoPath(owner, repo));
    if (!repository.body) throw this.notFound(owner, repo, repository.status);
    throw new UserError(`Branch, tag or commit not found in ${owner}/${repo}: ${segments.join('/')}`);
  }

  private notFound(owner: string, repo: string, status: number): UserError {
    if (status !== HTTP_NOT_FOUND) return new UserError(`GitHub returned HTTP ${status} for ${owner}/${repo}.`, 'http');
    const message = this.authenticated
      ? `Repository ${owner}/${repo} was not found or your GitHub account has no access to it.`
      : `Repository ${owner}/${repo} was not found. If it is private, sign in to GitHub first.`;
    return new UserError(message, 'not-found');
  }

  /** Current commit of a ref and its root tree SHA; undefined when the ref no longer exists. */
  async commit(owner: string, repo: string, ref: string): Promise<{ sha: string; treeSha?: string } | undefined> {
    const commit = await this.getCommit(owner, repo, ref);
    if (commit.body?.sha) return { sha: commit.body.sha, treeSha: commit.body.commit?.tree?.sha };
    if (commit.status === HTTP_NOT_FOUND || commit.status === HTTP_UNPROCESSABLE) return undefined;
    throw new UserError(`GitHub returned HTTP ${commit.status} for ${owner}/${repo}@${ref}.`, 'http');
  }

  /**
   * `sha` may be a commit or a tree SHA. Note: when it is a commit, GitHub
   * answers with the commit SHA in `sha`, not the root tree's — use commit().
   */
  async tree(owner: string, repo: string, sha: string, recursive = true): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const query = recursive ? '?recursive=1' : '';
    const response = await this.getJson<{ tree: TreeEntry[]; truncated: boolean }>(`${repoPath(owner, repo)}/git/trees/${encodeURIComponent(sha)}${query}`);
    if (!response.body) throw new UserError(`Could not read the file tree of ${owner}/${repo} (HTTP ${response.status}).`);
    return { entries: response.body.tree ?? [], truncated: !!response.body.truncated };
  }

  /**
   * GitHub code search for SKILL.md files (what `gh skill search` uses).
   * GitHub only allows code search with a signed-in user.
   */
  async searchSkillFiles(query: string, perPage = DEFAULT_SEARCH_RESULTS): Promise<Array<{ owner: string; repo: string; path: string; sha: string }>> {
    if (!this.authenticated) throw new UserError('Sign in to GitHub to search all of GitHub (GitHub requires it for code search).', 'auth-required');
    const searchWords = query.replace(NOT_A_SEARCH_WORD_CHARACTER, ' ').trim();
    const searchQuery = `${searchWords} filename:SKILL.md`;
    const response = await this.getJson<{ items: Array<{ path: string; sha: string; repository: { full_name: string } }> }>(
      `/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${perPage}`,
    );
    if (!response.body) throw new UserError(`GitHub search failed (HTTP ${response.status}).`, 'http');
    return response.body.items
      .filter((item) => SKILL_FILE_PATH.test(item.path))
      .map((item) => {
        const [owner, repo] = item.repository.full_name.split('/');
        return { owner, repo, path: item.path, sha: item.sha };
      });
  }

  /** Downloads one file at an exact commit. Enforces a byte limit. */
  async file(owner: string, repo: string, commit: string, filePath: string, maxBytes: number): Promise<Uint8Array> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const url = `${this.rawBase}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commit)}/${encodedPath}`;
    const response = await this.options.fetch(url, { headers: this.headers(url, ANY_ACCEPT), signal: this.options.signal });
    if (!response.ok) throw new UserError(`Could not download ${filePath} (HTTP ${response.status}).`, 'download');
    const tooLarge = () => new UserError(`${filePath} is larger than the ${kilobytes(maxBytes)} KB limit.`, 'too-large');
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > maxBytes) throw tooLarge();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge();
    return bytes;
  }
}
