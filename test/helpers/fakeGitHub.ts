import { createHash } from 'node:crypto';
import type { FetchLike } from '../../src/core/github';

type FileSpec = string | Uint8Array | { symlink: string } | { submodule: true } | { content: string; executable: true };

export interface FakeRepo {
  defaultBranch: string;
  /** ref name → commit sha */
  refs: Record<string, string>;
  /** commit sha → files */
  commits: Record<string, Record<string, FileSpec>>;
  private?: boolean;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex');
const blobSha = (b: Buffer) => createHash('sha1').update(`blob ${b.byteLength}\0`).update(b).digest('hex');

/** In-memory stand-in for api.github.com + raw.githubusercontent.com. */
export class FakeGitHub {
  readonly calls: Array<{ url: string; auth?: string }> = [];
  rateLimited = false;

  constructor(public repos: Record<string, FakeRepo>, private readonly token?: string) {}

  fetch: FetchLike = async (url, init) => {
    const auth = init?.headers?.['Authorization'];
    this.calls.push({ url, auth });
    const u = new URL(url);
    if (this.rateLimited && u.hostname === 'api.github.com') return this.res(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0' });

    if (u.hostname === 'api.github.com') {
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] === 'search' && parts[1] === 'code') {
        if (auth !== `Bearer ${this.token}` || !this.token) return this.res(401, { message: 'Requires authentication' });
        const terms = (u.searchParams.get('q') ?? '').split(/\s+/).filter((t) => t && !t.startsWith('filename:')).map((t) => t.toLowerCase());
        const items: unknown[] = [];
        for (const [full, repo] of Object.entries(this.repos)) {
          if (repo.private) continue;
          const files = repo.commits[repo.refs[repo.defaultBranch]];
          for (const [p, spec] of Object.entries(files ?? {})) {
            if (!/(^|\/)SKILL\.md$/.test(p) || typeof spec !== 'string') continue;
            if (terms.every((t) => spec.toLowerCase().includes(t) || p.toLowerCase().includes(t))) {
              items.push({ path: p, sha: blobSha(Buffer.from(spec)), repository: { full_name: full } });
            }
          }
        }
        return this.res(200, { total_count: items.length, items });
      }
      if (parts[0] !== 'repos') return this.res(404, {});
      const key = `${parts[1]}/${parts[2]}`;
      const repo = this.repos[key];
      if (!repo || (repo.private && auth !== `Bearer ${this.token}`)) return this.res(404, { message: 'Not Found' });
      if (parts.length === 3) return this.res(200, { default_branch: repo.defaultBranch });
      if (parts[3] === 'commits') {
        const ref = parts.slice(4).join('/');
        const commit = repo.refs[ref] ?? (repo.commits[ref] ? ref : undefined);
        if (!commit) return this.res(422, { message: 'No commit found' });
        return this.res(200, { sha: commit, commit: { tree: { sha: this.build(repo.commits[commit]).root } } });
      }
      if (parts[3] === 'git' && parts[4] === 'trees') {
        const id = parts[5];
        const recursive = u.searchParams.get('recursive') === '1';
        if (repo.commits[id]) {
          // Like GitHub: asked by commit, `sha` is the commit SHA.
          return this.res(200, { sha: id, truncated: false, tree: this.listing(this.build(repo.commits[id]), '', recursive) });
        }
        for (const files of Object.values(repo.commits)) {
          const built = this.build(files);
          const dir = built.dirBySha.get(id);
          if (dir !== undefined) return this.res(200, { sha: id, truncated: false, tree: this.listing(built, dir, recursive) });
        }
        return this.res(404, {});
      }
      return this.res(404, {});
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const repo = this.repos[`${parts[0]}/${parts[1]}`];
      const files = repo?.commits[parts[2] === 'HEAD' ? repo.refs[repo.defaultBranch] : (repo.refs[parts[2]] ?? parts[2])];
      const spec = files?.[parts.slice(3).join('/')];
      if (spec === undefined || (typeof spec === 'object' && !(spec instanceof Uint8Array) && !('content' in spec))) return this.res(404, 'not found');
      const body = typeof spec === 'string' ? Buffer.from(spec) : spec instanceof Uint8Array ? Buffer.from(spec) : Buffer.from(spec.content);
      return this.res(200, body);
    }
    return this.res(404, {});
  };

  /** Git-compatible object ids: blobs hash like `git hash-object`, trees hash their children. */
  private build(files: Record<string, FileSpec>) {
    const entries: Array<{ path: string; mode: string; type: string; sha: string; size?: number }> = [];
    for (const [p, spec] of Object.entries(files)) {
      if (typeof spec === 'string' || spec instanceof Uint8Array) {
        const buf = typeof spec === 'string' ? Buffer.from(spec) : Buffer.from(spec);
        entries.push({ path: p, mode: '100644', type: 'blob', sha: blobSha(buf), size: buf.byteLength });
      } else if ('symlink' in spec) entries.push({ path: p, mode: '120000', type: 'blob', sha: blobSha(Buffer.from(spec.symlink)), size: spec.symlink.length });
      else if ('submodule' in spec) entries.push({ path: p, mode: '160000', type: 'commit', sha: sha(p) });
      else entries.push({ path: p, mode: '100755', type: 'blob', sha: blobSha(Buffer.from(spec.content)), size: Buffer.byteLength(spec.content) });
    }
    const dirs = new Set<string>(['']);
    for (const e of entries) {
      const segs = e.path.split('/');
      for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    }
    const shaByDir = new Map<string, string>();
    const childrenOf = (d: string) =>
      [...entries.map((e) => e.path), ...[...dirs].filter((x) => x !== '')].filter((x) => {
        const parent = x.includes('/') ? x.slice(0, x.lastIndexOf('/')) : '';
        return parent === d && x !== d;
      });
    const treeSha = (d: string): string => {
      const cached = shaByDir.get(d);
      if (cached) return cached;
      const parts = childrenOf(d)
        .sort()
        .map((c) => `${c.split('/').pop()}:${dirs.has(c) ? treeSha(c) : entries.find((e) => e.path === c)!.sha}`);
      const v = sha('tree\0' + parts.join('\n'));
      shaByDir.set(d, v);
      return v;
    };
    for (const d of dirs) treeSha(d);
    const all = [...entries, ...[...dirs].filter((d) => d !== '').map((d) => ({ path: d, mode: '040000', type: 'tree', sha: shaByDir.get(d)! }))];
    return { all, root: shaByDir.get('')!, dirBySha: new Map([...shaByDir].map(([d, v]) => [v, d])) };
  }

  private listing(built: ReturnType<FakeGitHub['build']>, dir: string, recursive: boolean) {
    const prefix = dir ? dir + '/' : '';
    return built.all
      .filter((e) => (dir ? e.path.startsWith(prefix) : true))
      .map((e) => ({ ...e, path: e.path.slice(prefix.length) }))
      .filter((e) => recursive || !e.path.includes('/'))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private res(status: number, body: unknown, headers: Record<string, string> = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? (n.toLowerCase() === 'content-length' ? String(buf.byteLength) : null) },
      json: async () => JSON.parse(buf.toString('utf8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    };
  }
}
