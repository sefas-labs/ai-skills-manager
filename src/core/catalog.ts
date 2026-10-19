import { mapWithConcurrency } from './concurrency';
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

/** Verified to exist and contain SKILL.md folders on 2026-10-19 (counts as of that day; NVIDIA/skills: Apache-2.0, 418 SKILL.md). */
export const FEATURED_SOURCES: CatalogSource[] = [
  { id: 'anthropics/skills', owner: 'anthropics', repo: 'skills', title: 'Anthropic', blurb: 'Anthropic’s public Agent Skills (documents, design, development) — ~20 skills.' },
  { id: 'openai/skills', owner: 'openai', repo: 'skills', title: 'OpenAI', blurb: 'Skills catalog for Codex — ~40 skills.' },
  { id: 'github/awesome-copilot', owner: 'github', repo: 'awesome-copilot', title: 'Awesome Copilot', blurb: 'Community skills, instructions and agents for GitHub Copilot — 400+ skills.' },
  { id: 'vercel-labs/agent-skills', owner: 'vercel-labs', repo: 'agent-skills', title: 'Vercel', blurb: 'Vercel’s collection of agent skills — ~10 skills.' },
  { id: 'microsoft/skills', owner: 'microsoft', repo: 'skills', title: 'Microsoft', blurb: 'Skills to ground coding agents in Microsoft SDKs — 200+ skills.' },
  { id: 'huggingface/skills', owner: 'huggingface', repo: 'skills', title: 'Hugging Face', blurb: 'Skills for the Hugging Face ecosystem — ~25 skills.' },
  { id: 'NVIDIA/skills', owner: 'NVIDIA', repo: 'skills', title: 'NVIDIA', blurb: 'NVIDIA’s skills for CUDA, RAG, robotics, simulation and Physical AI — 400+ skills.' },
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

interface SkillSummary {
  name?: string;
  description?: string;
}

/** name/description of a SKILL.md by blob SHA (content-addressed, so never stale). */
export type DescriptionCache = Map<string, SkillSummary>;

const SKILL_FILE_NAME = 'SKILL.md';
/** Same limit as install and discovery. */
const MAX_SKILL_MD_BYTES = 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 600;
const DEFAULT_MAX_SKILLS_PER_SOURCE = 600;
const DEFAULT_CONCURRENCY = 8;
const MIN_QUERY_LENGTH = 2;
/** raw.githubusercontent.com and the API both read HEAD as the default branch. */
const DEFAULT_BRANCH_REF = 'HEAD';
const DEPENDENCY_OR_VCS_PATH = /(^|\/)(node_modules|\.git)\//;
const NAME_MATCH_SCORE = 10;
const DESCRIPTION_MATCH_SCORE = 1;

function skillMdPath(dir: string): string {
  return dir ? `${dir}/${SKILL_FILE_NAME}` : SKILL_FILE_NAME;
}

function skillDirOf(filePath: string): string {
  return filePath === SKILL_FILE_NAME ? '' : filePath.slice(0, -`/${SKILL_FILE_NAME}`.length);
}

function folderUrl(owner: string, repo: string, ref: string, dir: string): string {
  const dirInUrl = dir ? '/' + dir : '';
  return `https://github.com/${owner}/${repo}/tree/${ref}${dirInUrl}`;
}

function fallbackName(dir: string, repo: string): string {
  return dir.split('/').pop() || repo;
}

async function describe(
  client: GitHubClient,
  cache: DescriptionCache,
  at: { owner: string; repo: string; ref: string },
  filePath: string,
  blobSha: string,
): Promise<SkillSummary> {
  const cached = cache.get(blobSha);
  if (cached) return cached;
  try {
    const bytes = await client.file(at.owner, at.repo, at.ref, filePath, MAX_SKILL_MD_BYTES);
    const frontmatter = parseFrontmatter(Buffer.from(bytes).toString('utf8')).data;
    const name = frontmatter['name'];
    const description = frontmatter['description'];
    const summary = {
      name: typeof name === 'string' ? name : undefined,
      description: typeof description === 'string' ? description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : undefined,
    };
    cache.set(blobSha, summary);
    return summary;
  } catch {
    return {};
  }
}

/** Skills of one collection: 3 API calls (repo, commit, tree) plus raw SKILL.md downloads not already cached. */
export async function listSource(
  client: GitHubClient,
  source: CatalogSource,
  cache: DescriptionCache,
  options: { concurrency?: number; limit?: number } = {},
): Promise<{ ref: string; commit: string; skills: CatalogSkill[]; truncated: boolean }> {
  const { owner, repo } = source;
  const { ref, commit } = await client.resolve(parseGitHubUrl(`${owner}/${repo}`));
  const { entries, truncated } = await client.tree(owner, repo, commit);
  const blobShaByPath = new Map(entries.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]));
  const skillDirs = findSkillDirs(entries).slice(0, options.limit ?? DEFAULT_MAX_SKILLS_PER_SOURCE);
  const skills = await mapWithConcurrency(skillDirs, options.concurrency ?? DEFAULT_CONCURRENCY, async (dir) => {
    const filePath = skillMdPath(dir);
    const blobSha = blobShaByPath.get(filePath)!;
    const summary = await describe(client, cache, { owner, repo, ref: commit }, filePath, blobSha);
    return {
      sourceId: source.id,
      owner,
      repo,
      dir,
      name: summary.name ?? fallbackName(dir, repo),
      description: summary.description,
      skillMdSha: blobSha,
      url: folderUrl(owner, repo, ref, dir),
    };
  });
  skills.sort((first, second) => first.name.localeCompare(second.name) || first.dir.localeCompare(second.dir));
  return { ref, commit, skills, truncated };
}

type SearchHit = { owner: string; repo: string; path: string; sha: string };

function uniqueHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.owner}/${hit.repo}/${hit.path}`.toLowerCase();
    if (seen.has(key) || DEPENDENCY_OR_VCS_PATH.test(hit.path)) return false;
    seen.add(key);
    return true;
  });
}

/** Drops SKILL.md files that sit inside another skill of the same repository. */
function outermostSkills(hits: SearchHit[]): SearchHit[] {
  const isInside = (inner: SearchHit, outer: SearchHit) => {
    if (inner === outer || inner.owner !== outer.owner || inner.repo !== outer.repo) return false;
    const outerDir = skillDirOf(outer.path);
    return outerDir === '' || skillDirOf(inner.path).startsWith(outerDir + '/');
  };
  return hits.filter((hit) => !hits.some((other) => isInside(hit, other)));
}

/** Search every public repo (needs a GitHub sign-in). One code-search call + raw SKILL.md downloads. */
export async function searchGitHub(client: GitHubClient, query: string, cache: DescriptionCache): Promise<CatalogSkill[]> {
  if (query.trim().length < MIN_QUERY_LENGTH) return [];
  const hits = outermostSkills(uniqueHits(await client.searchSkillFiles(query)));
  const found = await mapWithConcurrency(hits, DEFAULT_CONCURRENCY, async (hit) => {
    const dir = skillDirOf(hit.path);
    const summary = await describe(client, cache, { owner: hit.owner, repo: hit.repo, ref: DEFAULT_BRANCH_REF }, hit.path, hit.sha);
    return {
      sourceId: `${hit.owner}/${hit.repo}`,
      owner: hit.owner,
      repo: hit.repo,
      dir,
      name: summary.name ?? fallbackName(dir, hit.repo),
      description: summary.description,
      skillMdSha: hit.sha,
      url: folderUrl(hit.owner, hit.repo, DEFAULT_BRANCH_REF, dir),
    };
  });
  return rankByQuery(found, query);
}

/** Like `gh skill search`: name matches first, then description matches, then the rest (stable). */
export function rankByQuery<T extends { name: string; description?: string }>(items: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scoreOf = (item: T) => {
    const name = item.name.toLowerCase();
    const description = (item.description ?? '').toLowerCase();
    return words.reduce((score, word) => {
      const nameScore = name.includes(word) ? NAME_MATCH_SCORE : 0;
      const descriptionScore = description.includes(word) ? DESCRIPTION_MATCH_SCORE : 0;
      return score + nameScore + descriptionScore;
    }, 0);
  };
  return items
    .map((item, originalIndex) => ({ item, originalIndex, score: scoreOf(item) }))
    .sort((first, second) => second.score - first.score || first.originalIndex - second.originalIndex)
    .map((ranked) => ranked.item);
}
