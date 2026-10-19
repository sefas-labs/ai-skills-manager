import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathKey } from './paths';
import { diffFiles, localFileShas, type FileDiff } from './updates';
import type { ProviderId, ResolvedLocation, Scope, SkillRecord } from './types';

/**
 * Merge suggestions for duplicates: the same skill name in several folders of
 * the same scope. We look for the smallest set of copies that still reaches
 * every (installed) agent that sees the skill today; the rest are redundant.
 * When all copies are needed (no folder reaches every agent), differing
 * contents can still be unified. Cross-scope duplicates (personal vs. project)
 * are left alone: removing the project copy would affect the whole team.
 */
export interface MergeCopy {
  skillId: string;
  dir: string;
  locationId: string;
  locationLabel: string;
  readers: ProviderId[];
  /** False for read-only copies (synced, admin, untrusted workspace): never removed or overwritten. */
  writable: boolean;
  /** Copies with the same number have identical files. */
  version: number;
  modifiedAt?: string;
  /** Files that differ from copy #0. */
  diff?: FileDiff;
}

export type MergeVerdict = 'remove-redundant' | 'unify-versions' | 'expected';

export interface MergeSuggestion {
  id: string;
  name: string;
  scope: Scope;
  copies: MergeCopy[];
  identical: boolean;
  /** Agents that see more than one copy today. */
  seenTwiceBy: ProviderId[];
  /** Recommended copies to keep / remove. */
  keep: string[];
  remove: string[];
  /** After the recommendation: agents that still see two copies, and agents that would lose the skill (always empty unless forced). */
  stillTwiceBy: ProviderId[];
  verdict: MergeVerdict;
}

export async function mergeSuggestions(
  skills: SkillRecord[],
  locations: ResolvedLocation[],
  opts: { relevantAgents?: ProviderId[] } = {},
): Promise<MergeSuggestion[]> {
  const locById = new Map(locations.map((l) => [l.id, l]));
  const groups = new Map<string, SkillRecord[]>();
  for (const s of skills) {
    const loc = locById.get(s.locationId);
    if (!loc || loc.origin === 'nested' || loc.namespace || s.issues.some((i) => i.code === 'broken-symlink')) continue;
    const key = `${s.scope === 'workspace' ? `ws:${loc.workspaceFolder ?? ''}` : 'global'}|${s.name}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  const out: MergeSuggestion[] = [];
  for (const [key, list] of groups) {
    // Links to the same real folder are one copy.
    const byReal = new Map<string, SkillRecord>();
    for (const s of list) if (!byReal.has(pathKey(s.realDir))) byReal.set(pathKey(s.realDir), s);
    const members = [...byReal.values()];
    if (members.length < 2) continue;

    const shas = await Promise.all(members.map((s) => localFileShas(s.realDir).catch(() => new Map<string, string>())));
    const fingerprint = shas.map((m) => createHash('sha1').update(JSON.stringify([...m].sort())).digest('hex'));
    const versions = [...new Set(fingerprint)];
    const copies: MergeCopy[] = await Promise.all(
      members.map(async (s, i) => {
        const loc = locById.get(s.locationId)!;
        const st = await fs.stat(path.join(s.realDir, 'SKILL.md')).catch(() => null);
        return {
          skillId: s.id,
          dir: s.dir,
          locationId: loc.id,
          locationLabel: loc.label,
          readers: [...loc.readers],
          writable: !s.readOnly && !loc.readOnly && !s.managed,
          version: versions.indexOf(fingerprint[i]),
          modifiedAt: st?.mtime.toISOString(),
          diff: i === 0 || fingerprint[i] === fingerprint[0] ? undefined : diffFiles(shas[0], shas[i]),
        };
      }),
    );

    const relevant = new Set(opts.relevantAgents?.length ? opts.relevantAgents : copies.flatMap((c) => c.readers));
    const reach = (set: MergeCopy[]) => new Set(set.flatMap((c) => c.readers.filter((r) => relevant.has(r))));
    const twice = (set: MergeCopy[]) => [...relevant].filter((a) => set.filter((c) => c.readers.includes(a)).length > 1).sort();
    const needed = reach(copies);

    // Smallest subset that keeps every read-only copy and reaches the same agents; fewest double views on ties.
    let best: MergeCopy[] = copies;
    for (let mask = 1; mask < 1 << copies.length; mask++) {
      const set = copies.filter((_, i) => mask & (1 << i));
      if (copies.some((c) => !c.writable && !set.includes(c))) continue;
      if (reach(set).size < needed.size) continue;
      if (set.length < best.length || (set.length === best.length && twice(set).length < twice(best).length)) best = set;
    }
    const remove = copies.filter((c) => !best.includes(c));
    const identical = versions.length === 1;
    const verdict: MergeVerdict = remove.length ? 'remove-redundant' : identical ? 'expected' : 'unify-versions';
    const seenTwiceBy = twice(copies);
    if (verdict === 'expected' && seenTwiceBy.length === 0) continue;
    out.push({
      id: createHash('sha1').update(key).digest('hex').slice(0, 12),
      name: members[0].name,
      scope: members[0].scope,
      copies,
      identical,
      seenTwiceBy,
      keep: best.map((c) => c.skillId),
      remove: remove.map((c) => c.skillId),
      stillTwiceBy: twice(best),
      verdict,
    });
  }
  const rank: Record<MergeVerdict, number> = { 'remove-redundant': 0, 'unify-versions': 1, expected: 2 };
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.name.localeCompare(b.name));
}
