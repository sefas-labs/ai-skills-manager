import { parseFrontmatter } from './frontmatter';
import { GitHubClient, parseGitHubUrl } from './github';
import { findSkillDirs } from './installer';

/**
 * Skills catalog for the Install tab: a few well-known public collections,
 * plus GitHub code search (what `gh skill search` uses). Listing only reads
 * each SKILL.md's frontmatter; installing always goes through the normal
 * inspect → stage → review → confirm flow. Being listed is not a review.
 */
export interface CatalogSource {
  id: string;
  owner: string;
  repo: string;
  title: string;
  blurb: string;
}

/** Verified to exist and contain SKILL.md folders on 2026-10-19 (counts as of that day). */
export const FEATURED_SOURCES: CatalogSource[] = [
  { id: 'anthropics/skills', owner: 'anthropics', repo: 'skills', title: 'Anthropic', blurb: 'Anthropic’s public Agent Skills (documents, design, development) — ~20 skills.' },
  { id: 'openai/skills', owner: 'openai', repo: 'skills', title: 'OpenAI', blurb: 'Skills catalog for Codex — ~40 skills.' },
  { id: 'github/awesome-copilot', owner: 'github', repo: 'awesome-copilot', title: 'Awesome Copilot', blurb: 'Community skills, instructions and agents for GitHub Copilot — 400+ skills.' },
  { id: 'vercel-labs/agent-skills', owner: 'vercel-labs', repo: 'agent-skills', title: 'Vercel', blurb: 'Vercel’s collection of agent skills — ~10 skills.' },
  { id: 'microsoft/skills', owner: 'microsoft', repo: 'skills', title: 'Microsoft', blurb: 'Skills to ground coding agents in Microsoft SDKs — 200+ skills.' },
  { id: 'huggingface/skills', owner: 'huggingface', repo: 'skills', title: 'Hugging Face', blurb: 'Skills for the Hugging Face ecosystem — ~25 skills.' },
  { id: 'obra/superpowers', owner: 'obra', repo: 'superpowers', title: 'Superpowers', blurb: 'An agentic development methodology packaged as skills — ~15 skills.' },
];

export interface CatalogSkill {
  sourceId: string;
  owner: string;
  repo: string;
  /** Repo-relative skill folder. */
  dir: string;
  name: string;
  description?: string;
  /** Blob SHA of SKILL.md: cache key for name/description. */
  skillMdSha: string;
  /** Folder URL the normal install flow accepts. */
  url: string;
}

/** name/description of a SKILL.md by blob SHA (content-addressed, so never stale). */
export type DescriptionCache = Map<string, { name?: string; description?: string }>;

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function describe(
  client: GitHubClient,
  cache: DescriptionCache,
  at: { owner: string; repo: string; ref: string },
  path: string,
  sha: string,
): Promise<{ name?: string; description?: string }> {
  const hit = cache.get(sha);
  if (hit) return hit;
  try {
    const buf = await client.file(at.owner, at.repo, at.ref, path, 256 * 1024);
    const fm = parseFrontmatter(Buffer.from(buf).toString('utf8')).data;
    const v = {
      name: typeof fm['name'] === 'string' ? (fm['name'] as string) : undefined,
      description: typeof fm['description'] === 'string' ? (fm['description'] as string).trim().slice(0, 600) : undefined,
    };
    cache.set(sha, v);
    return v;
  } catch {
    return {};
  }
}

/** Skills of one collection: 3 API calls (repo, commit, tree) plus raw SKILL.md downloads not already cached. */
export async function listSource(
  client: GitHubClient,
  src: CatalogSource,
  cache: DescriptionCache,
  opts: { concurrency?: number; limit?: number } = {},
): Promise<{ ref: string; commit: string; skills: CatalogSkill[]; truncated: boolean }> {
  const { ref, commit } = await client.resolve(parseGitHubUrl(`${src.owner}/${src.repo}`));
  const { entries, truncated } = await client.tree(src.owner, src.repo, commit);
  const shaByPath = new Map(entries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  const dirs = findSkillDirs(entries).slice(0, opts.limit ?? 600);
  const skills = await pool(dirs, opts.concurrency ?? 8, async (dir) => {
    const path = dir ? `${dir}/SKILL.md` : 'SKILL.md';
    const sha = shaByPath.get(path)!;
    const d = await describe(client, cache, { owner: src.owner, repo: src.repo, ref: commit }, path, sha);
    return {
      sourceId: src.id,
      owner: src.owner,
      repo: src.repo,
      dir,
      name: d.name ?? (dir.split('/').pop() || src.repo),
      description: d.description,
      skillMdSha: sha,
      url: `https://github.com/${src.owner}/${src.repo}/tree/${ref}${dir ? '/' + dir : ''}`,
    };
  });
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
  return { ref, commit, skills, truncated };
}

/** Search every public repo (needs a GitHub sign-in). One code-search call + raw SKILL.md downloads. */
export async function searchGitHub(client: GitHubClient, query: string, cache: DescriptionCache): Promise<CatalogSkill[]> {
  if (query.trim().length < 2) return [];
  const hits = await client.searchSkillFiles(query);
  // Same skill folder can't appear twice; nested SKILL.md files (inside another skill) are skipped.
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    const k = `${h.owner}/${h.repo}/${h.path}`.toLowerCase();
    if (seen.has(k) || /(^|\/)(node_modules|\.git)\//.test(h.path)) return false;
    seen.add(k);
    return true;
  });
  const dirOf = (path: string) => (path === 'SKILL.md' ? '' : path.slice(0, -'/SKILL.md'.length));
  const outer = unique.filter(
    (h) => !unique.some((o) => o !== h && o.owner === h.owner && o.repo === h.repo && (dirOf(o.path) === '' || dirOf(h.path).startsWith(dirOf(o.path) + '/'))),
  );
  const found = await pool(outer, 8, async (h) => {
    const dir = dirOf(h.path);
    // HEAD = the default branch; raw.githubusercontent.com and the API both accept it.
    const d = await describe(client, cache, { owner: h.owner, repo: h.repo, ref: 'HEAD' }, h.path, h.sha);
    return {
      sourceId: `${h.owner}/${h.repo}`,
      owner: h.owner,
      repo: h.repo,
      dir,
      name: d.name ?? (dir.split('/').pop() || h.repo),
      description: d.description,
      skillMdSha: h.sha,
      url: `https://github.com/${h.owner}/${h.repo}/tree/HEAD${dir ? '/' + dir : ''}`,
    };
  });
  return rankByQuery(found, query);
}

/** Like `gh skill search`: name matches first, then description matches, then the rest (stable). */
export function rankByQuery<T extends { name: string; description?: string }>(items: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (s: T) => {
    const name = s.name.toLowerCase();
    const desc = (s.description ?? '').toLowerCase();
    return words.reduce((n, w) => n + (name.includes(w) ? 10 : 0) + (desc.includes(w) ? 1 : 0), 0);
  };
  return items.map((s, i) => ({ s, i, k: score(s) })).sort((a, b) => b.k - a.k || a.i - b.i).map((x) => x.s);
}
