import { uninstallSkill } from './installer';
import type { LockStore } from './lockfile';
import { pathKey } from './paths';
import { executeTransfer, planTransfer } from './transfer';
import type { ProviderId, ResolvedLocation, SkillRecord } from './types';

/**
 * "Use this copy": when several folders hold a skill with the same name, agents
 * that read more than one folder pick one by their own rules (undocumented for
 * Cursor and Copilot). Since no agent lets you hide a single folder, the user's
 * choice is enforced by either making every other copy identical to the chosen
 * one (nobody loses the skill) or removing the others (some agents may lose it).
 */
export interface OtherCopy {
  skill: SkillRecord;
  location: ResolvedLocation;
  identical: boolean;
  /** Can be overwritten with the chosen version / removed. */
  writable: boolean;
  /** Why it can't be overwritten (read-only, a link, different folder name). */
  blocked?: string;
}

export interface ChoosePlan {
  chosen: SkillRecord;
  chosenLocation: ResolvedLocation;
  others: OtherCopy[];
  /** Agents that would no longer see the skill at all if the writable others were removed. */
  loseIfRemoved: ProviderId[];
}

export interface ChooseDeps {
  lock: LockStore;
  backupRoot: string;
  stagingRoot: string;
  skills: SkillRecord[];
}

/** Plugin skills are namespaced, so the same name in another namespace is a different skill. */
function isAnotherCopyOf(candidate: SkillRecord, chosen: SkillRecord): boolean {
  if (candidate.id === chosen.id) return false;
  if (candidate.name !== chosen.name || candidate.namespace !== chosen.namespace) return false;
  return pathKey(candidate.realDir) !== pathKey(chosen.realDir);
}

function whyBlocked(copy: SkillRecord, location: ResolvedLocation, chosen: SkillRecord, readOnly: boolean): string | undefined {
  if (readOnly) return copy.readOnlyReason ?? location.readOnlyReason ?? 'read-only';
  if (copy.isSymlink) return 'it is a link to another folder';
  if (copy.dirName !== chosen.dirName) return `its folder is named "${copy.dirName}"`;
  return undefined;
}

export function planChoose(chosen: SkillRecord, skills: SkillRecord[], locations: ResolvedLocation[]): ChoosePlan {
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const chosenLocation = locationById.get(chosen.locationId)!;
  const others: OtherCopy[] = [];
  for (const candidate of skills) {
    if (!isAnotherCopyOf(candidate, chosen)) continue;
    const location = locationById.get(candidate.locationId);
    const isBrokenLink = candidate.issues.some((issue) => issue.code === 'broken-symlink');
    if (!location || isBrokenLink) continue;
    const readOnly = candidate.readOnly || location.readOnly || !!candidate.managed;
    others.push({
      skill: candidate,
      location,
      identical: !!candidate.contentId && candidate.contentId === chosen.contentId,
      writable: !readOnly,
      blocked: whyBlocked(candidate, location, chosen, readOnly),
    });
  }

  const readOnlyOthers = others.filter((other) => !other.writable);
  const writableOthers = others.filter((other) => other.writable);
  const agentsStillServed = new Set([...chosen.visibleTo, ...readOnlyOthers.flatMap((other) => other.skill.visibleTo)]);
  const agentsOfWritable = new Set(writableOthers.flatMap((other) => other.skill.visibleTo));
  const loseIfRemoved = [...agentsOfWritable].filter((agent) => !agentsStillServed.has(agent)).sort();
  return { chosen, chosenLocation, others, loseIfRemoved };
}

/** Overwrite every differing, overwritable copy with the chosen version (each replaced copy goes to the backup folder). */
export async function syncToChosen(plan: ChoosePlan, deps: ChooseDeps): Promise<string[]> {
  const replacedDirs: string[] = [];
  for (const other of plan.others) {
    if (other.identical || other.blocked) continue;
    const transfer = await planTransfer(plan.chosen, plan.chosenLocation, other.location, 'copy', deps.skills);
    await executeTransfer(transfer, true, deps);
    replacedDirs.push(other.skill.dir);
  }
  return replacedDirs;
}

/** Move every writable other copy to the backup folder, leaving the chosen one as the only editable copy. */
export async function removeOthers(plan: ChoosePlan, deps: ChooseDeps): Promise<string[]> {
  const removedDirs: string[] = [];
  for (const other of plan.others) {
    if (!other.writable) continue;
    await uninstallSkill(other.skill, other.location, { lock: deps.lock, trashRoot: deps.backupRoot });
    removedDirs.push(other.skill.dir);
  }
  return removedDirs;
}
