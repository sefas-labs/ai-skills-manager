import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FEATURED_SOURCES, listSource, searchGitHub, type CatalogSkill, type DescriptionCache } from '../core/catalog';
import { pathKey } from '../core/paths';
import type { ViewCatalogSkill } from '../shared/protocol';
import { makeGitHubClient } from './actions';
import { log } from './log';
import type { SkillsService } from './service';

const MINUTES_TO_MS = 60 * 1000;
const LIST_TTL_MS = 30 * MINUTES_TO_MS;
const SAVE_DELAY_MS = 1000;
/** Keep the newest entries only, so the cache file stays small. */
const MAX_CACHED_DESCRIPTIONS = 5000;

interface CachedListing {
  listedAt: number;
  ref: string;
  skills: CatalogSkill[];
  truncated: boolean;
}

/**
 * Catalog state for the Install tab. Collections are listed on demand and kept
 * for 30 minutes; SKILL.md names/descriptions are cached on disk by blob SHA
 * (content-addressed, so they never go stale).
 */
export class CatalogStore {
  private descriptions: DescriptionCache | undefined;
  private readonly listings = new Map<string, CachedListing>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly service: SkillsService) {}

  private get file(): string {
    return path.join(this.service.storageDir, 'catalog-descriptions.json');
  }

  private async cache(): Promise<DescriptionCache> {
    if (this.descriptions) return this.descriptions;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, { name?: string; description?: string }>;
      this.descriptions = new Map(Object.entries(raw));
    } catch {
      this.descriptions = new Map();
    }
    return this.descriptions;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const newestEntries = [...(this.descriptions ?? new Map()).entries()].slice(-MAX_CACHED_DESCRIPTIONS);
      void fs
        .mkdir(path.dirname(this.file), { recursive: true })
        .then(() => fs.writeFile(this.file, JSON.stringify(Object.fromEntries(newestEntries))))
        .catch((error) => log().warn(`catalog: could not save cache: ${(error as Error).message}`));
    }, SAVE_DELAY_MS);
  }

  async list(sourceId: string, force = false): Promise<{ skills: ViewCatalogSkill[]; truncated: boolean }> {
    const source = FEATURED_SOURCES.find((candidate) => candidate.id === sourceId);
    if (!source) throw new Error(`Unknown collection ${sourceId}`);
    let listing = this.listings.get(sourceId);
    const isStale = !listing || Date.now() - listing.listedAt > LIST_TTL_MS;
    if (!listing || force || isStale) {
      const fresh = await listSource(await makeGitHubClient(this.service), source, await this.cache());
      listing = { listedAt: Date.now(), ref: fresh.ref, skills: fresh.skills, truncated: fresh.truncated };
      this.listings.set(sourceId, listing);
      this.scheduleSave();
      log().info(`catalog: listed ${sourceId} (${fresh.skills.length} skills)`);
    }
    return { skills: listing.skills.map((skill) => this.view(skill)), truncated: listing.truncated };
  }

  async search(query: string): Promise<ViewCatalogSkill[]> {
    const found = await searchGitHub(await makeGitHubClient(this.service), query, await this.cache());
    this.scheduleSave();
    log().info(`catalog: search "${query}" → ${found.length}`);
    return found.map((skill) => this.view(skill));
  }

  /** Marks what is already on this machine: same GitHub origin (lock or gh skill), else just the same name. */
  private view(catalogSkill: CatalogSkill): ViewCatalogSkill {
    const localSkills = this.service.current?.skills ?? [];
    const fromSameSource = localSkills.filter((local) => {
      const tracked = this.service.tracked(local);
      if (!tracked) return false;
      const sameRepo = tracked.owner.toLowerCase() === catalogSkill.owner.toLowerCase() && tracked.repo.toLowerCase() === catalogSkill.repo.toLowerCase();
      return sameRepo && tracked.subpath === catalogSkill.dir;
    });
    const withSameName = fromSameSource.length ? [] : localSkills.filter((local) => local.name === catalogSkill.name);
    const matches = fromSameSource.length ? fromSameSource : withSameName;
    let installed: ViewCatalogSkill['installed'];
    if (fromSameSource.length) installed = 'same-source';
    else if (withSameName.length) installed = 'same-name';
    return {
      sourceId: catalogSkill.sourceId,
      owner: catalogSkill.owner,
      repo: catalogSkill.repo,
      dir: catalogSkill.dir,
      name: catalogSkill.name,
      description: catalogSkill.description,
      url: catalogSkill.url,
      installed,
      installedIn: [...new Set(matches.map((local) => this.service.location(local.locationId)?.label ?? pathKey(local.dir)))],
    };
  }
}
