import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FEATURED_SOURCES, listSource, searchGitHub, type CatalogSkill, type DescriptionCache } from '../core/catalog';
import { pathKey } from '../core/paths';
import type { ViewCatalogSkill } from '../shared/protocol';
import { makeGitHubClient } from './actions';
import { log } from './log';
import type { SkillsService } from './service';

const LIST_TTL_MS = 30 * 60 * 1000;

/**
 * Catalog state for the Install tab. Collections are listed on demand and kept
 * for 30 minutes; SKILL.md names/descriptions are cached on disk by blob SHA
 * (content-addressed, so they never go stale).
 */
export class CatalogStore {
  private descriptions: DescriptionCache | undefined;
  private readonly lists = new Map<string, { at: number; ref: string; skills: CatalogSkill[]; truncated: boolean }>();
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
      const data = Object.fromEntries([...(this.descriptions ?? new Map()).entries()].slice(-5000));
      void fs
        .mkdir(path.dirname(this.file), { recursive: true })
        .then(() => fs.writeFile(this.file, JSON.stringify(data)))
        .catch((e) => log().warn(`catalog: could not save cache: ${(e as Error).message}`));
    }, 1000);
  }

  async list(sourceId: string, force = false): Promise<{ skills: ViewCatalogSkill[]; truncated: boolean }> {
    const src = FEATURED_SOURCES.find((s) => s.id === sourceId);
    if (!src) throw new Error(`Unknown collection ${sourceId}`);
    let hit = this.lists.get(sourceId);
    if (!hit || force || Date.now() - hit.at > LIST_TTL_MS) {
      const r = await listSource(await makeGitHubClient(this.service), src, await this.cache());
      hit = { at: Date.now(), ref: r.ref, skills: r.skills, truncated: r.truncated };
      this.lists.set(sourceId, hit);
      this.scheduleSave();
      log().info(`catalog: listed ${sourceId} (${r.skills.length} skills)`);
    }
    return { skills: hit.skills.map((s) => this.view(s)), truncated: hit.truncated };
  }

  async search(query: string): Promise<ViewCatalogSkill[]> {
    const r = await searchGitHub(await makeGitHubClient(this.service), query, await this.cache());
    this.scheduleSave();
    log().info(`catalog: search "${query}" → ${r.length}`);
    return r.map((s) => this.view(s));
  }

  /** Marks what is already on this machine: same GitHub origin (lock or gh skill), else just the same name. */
  private view(s: CatalogSkill): ViewCatalogSkill {
    const skills = this.service.current?.skills ?? [];
    const same = skills.filter((k) => {
      const t = this.service.tracked(k);
      return t && t.owner.toLowerCase() === s.owner.toLowerCase() && t.repo.toLowerCase() === s.repo.toLowerCase() && t.subpath === s.dir;
    });
    const sameName = same.length ? [] : skills.filter((k) => k.name === s.name);
    return {
      sourceId: s.sourceId,
      owner: s.owner,
      repo: s.repo,
      dir: s.dir,
      name: s.name,
      description: s.description,
      url: s.url,
      installed: same.length ? 'same-source' : sameName.length ? 'same-name' : undefined,
      installedIn: [...new Set((same.length ? same : sameName).map((k) => this.service.location(k.locationId)?.label ?? pathKey(k.dir)))],
    };
  }
}
