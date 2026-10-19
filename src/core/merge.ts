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
  /** Agents that would still see two copies after the recommendation. */
  stillTwiceBy: ProviderId[];
  verdict: MergeVerdict;
}

const SUGGESTION_ID_LENGTH = 12;
const VERDICT_ORDER: Record<MergeVerdict, number> = { 'remove-redundant': 0, 'unify-versions': 1, expected: 2 };

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Duplicates are only merged within one scope (and one workspace folder): never personal vs. project. */
function groupKey(skill: SkillRecord, location: ResolvedLocation): string {
  const scopeKey = skill.scope === 'workspace' ? `ws:${location.workspaceFolder ?? ''}` : 'global';
  return `${scopeKey}|${skill.name}`;
}

function canBeMerged(skill: SkillRecord, location: ResolvedLocation | undefined): location is ResolvedLocation {
  if (!location || location.origin === 'nested' || location.namespace) return false;
  return !skill.issues.some((issue) => issue.code === 'broken-symlink');
}

/** Links to the same real folder count as one copy. */
function oneCopyPerRealFolder(skills: SkillRecord[]): SkillRecord[] {
  const byRealFolder = new Map<string, SkillRecord>();
  for (const skill of skills) {
    const key = pathKey(skill.realDir);
    if (!byRealFolder.has(key)) byRealFolder.set(key, skill);
  }
  return [...byRealFolder.values()];
}

/** Every non-empty subset of `items`. Fine for the handful of copies a skill has. */
function* nonEmptySubsets<T>(items: T[]): Generator<T[]> {
  const subsetCount = 2 ** items.length;
  for (let bits = 1; bits < subsetCount; bits++) {
    yield items.filter((_, index) => (bits >> index) & 1);
  }
}

async function describeCopies(members: SkillRecord[], locationById: Map<string, ResolvedLocation>): Promise<{ copies: MergeCopy[]; versionCount: number }> {
  const fileShas = await Promise.all(members.map((skill) => localFileShas(skill.realDir).catch(() => new Map<string, string>())));
  const fingerprints = fileShas.map((shas) => sha1(JSON.stringify([...shas].sort())));
  const distinctVersions = [...new Set(fingerprints)];
  const copies = await Promise.all(
    members.map(async (skill, index) => {
      const location = locationById.get(skill.locationId)!;
      const skillFileStat = await fs.stat(path.join(skill.realDir, 'SKILL.md')).catch(() => null);
      const sameAsFirst = index === 0 || fingerprints[index] === fingerprints[0];
      return {
        skillId: skill.id,
        dir: skill.dir,
        locationId: location.id,
        locationLabel: location.label,
        readers: [...location.readers],
        writable: !skill.readOnly && !location.readOnly && !skill.managed,
        version: distinctVersions.indexOf(fingerprints[index]),
        modifiedAt: skillFileStat?.mtime.toISOString(),
        diff: sameAsFirst ? undefined : diffFiles(fileShas[0], fileShas[index]),
      };
    }),
  );
  return { copies, versionCount: distinctVersions.length };
}

/**
 * Smallest set of copies that keeps every read-only copy and still reaches the
 * same agents; on a tie, the one where fewest agents see two copies.
 */
function bestCopiesToKeep(copies: MergeCopy[], relevantAgents: Set<ProviderId>): MergeCopy[] {
  const agentsReached = (selection: MergeCopy[]) =>
    new Set(selection.flatMap((copy) => copy.readers.filter((reader) => relevantAgents.has(reader))));
  const agentsSeeingTwice = (selection: MergeCopy[]) => seenTwice(selection, relevantAgents).length;
  const agentsNeeded = agentsReached(copies).size;

  let best = copies;
  for (const selection of nonEmptySubsets(copies)) {
    const dropsReadOnlyCopy = copies.some((copy) => !copy.writable && !selection.includes(copy));
    if (dropsReadOnlyCopy) continue;
    if (agentsReached(selection).size < agentsNeeded) continue;
    const isSmaller = selection.length < best.length;
    const isEquallySmallButCleaner = selection.length === best.length && agentsSeeingTwice(selection) < agentsSeeingTwice(best);
    if (isSmaller || isEquallySmallButCleaner) best = selection;
  }
  return best;
}

function seenTwice(selection: MergeCopy[], relevantAgents: Set<ProviderId>): ProviderId[] {
  return [...relevantAgents].filter((agent) => selection.filter((copy) => copy.readers.includes(agent)).length > 1).sort();
}

function verdictFor(removeCount: number, identical: boolean): MergeVerdict {
  if (removeCount > 0) return 'remove-redundant';
  return identical ? 'expected' : 'unify-versions';
}

export async function mergeSuggestions(
  skills: SkillRecord[],
  locations: ResolvedLocation[],
  options: { relevantAgents?: ProviderId[] } = {},
): Promise<MergeSuggestion[]> {
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const skillsByGroup = new Map<string, SkillRecord[]>();
  for (const skill of skills) {
    const location = locationById.get(skill.locationId);
    if (!canBeMerged(skill, location)) continue;
    const key = groupKey(skill, location);
    skillsByGroup.set(key, [...(skillsByGroup.get(key) ?? []), skill]);
  }

  const suggestions: MergeSuggestion[] = [];
  for (const [key, sameNameSkills] of skillsByGroup) {
    const members = oneCopyPerRealFolder(sameNameSkills);
    if (members.length < 2) continue;

    const { copies, versionCount } = await describeCopies(members, locationById);
    const relevantAgents = new Set(options.relevantAgents?.length ? options.relevantAgents : copies.flatMap((copy) => copy.readers));
    const keep = bestCopiesToKeep(copies, relevantAgents);
    const remove = copies.filter((copy) => !keep.includes(copy));
    const identical = versionCount === 1;
    const verdict = verdictFor(remove.length, identical);
    const seenTwiceBy = seenTwice(copies, relevantAgents);
    const nothingToSuggest = verdict === 'expected' && seenTwiceBy.length === 0;
    if (nothingToSuggest) continue;

    suggestions.push({
      id: sha1(key).slice(0, SUGGESTION_ID_LENGTH),
      name: members[0].name,
      scope: members[0].scope,
      copies,
      identical,
      seenTwiceBy,
      keep: keep.map((copy) => copy.skillId),
      remove: remove.map((copy) => copy.skillId),
      stillTwiceBy: seenTwice(keep, relevantAgents),
      verdict,
    });
  }
  return suggestions.sort((first, second) => VERDICT_ORDER[first.verdict] - VERDICT_ORDER[second.verdict] || first.name.localeCompare(second.name));
}
