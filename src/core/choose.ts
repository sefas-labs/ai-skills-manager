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

export function planChoose(chosen: SkillRecord, skills: SkillRecord[], locations: ResolvedLocation[]): ChoosePlan {
  const locById = new Map(locations.map((l) => [l.id, l]));
  const chosenLocation = locById.get(chosen.locationId)!;
  const others: OtherCopy[] = [];
  for (const s of skills) {
    if (s.id === chosen.id || s.name !== chosen.name || pathKey(s.realDir) === pathKey(chosen.realDir)) continue;
    const location = locById.get(s.locationId);
    if (!location || s.issues.some((i) => i.code === 'broken-symlink')) continue;
    const readOnly = s.readOnly || location.readOnly || !!s.managed;
    const blocked = readOnly
      ? (s.readOnlyReason ?? location.readOnlyReason ?? 'read-only')
      : s.isSymlink
        ? 'it is a link to another folder'
        : s.dirName !== chosen.dirName
          ? `its folder is named "${s.dirName}"`
          : undefined;
    others.push({ skill: s, location, identical: !!s.contentId && s.contentId === chosen.contentId, writable: !readOnly, blocked });
  }
  const kept = new Set([...chosen.visibleTo, ...others.filter((o) => !o.writable).flatMap((o) => o.skill.visibleTo)]);
  const loseIfRemoved = [...new Set(others.filter((o) => o.writable).flatMap((o) => o.skill.visibleTo))].filter((p) => !kept.has(p)).sort();
  return { chosen, chosenLocation, others, loseIfRemoved };
}

export interface ChooseDeps {
  lock: LockStore;
  backupRoot: string;
  stagingRoot: string;
  skills: SkillRecord[];
}

/** Overwrite every differing, overwritable copy with the chosen version (each replaced copy goes to the backup folder). */
export async function syncToChosen(plan: ChoosePlan, deps: ChooseDeps): Promise<string[]> {
  const done: string[] = [];
  for (const o of plan.others) {
    if (o.identical || o.blocked) continue;
    const t = await planTransfer(plan.chosen, plan.chosenLocation, o.location, 'copy', deps.skills);
    await executeTransfer(t, true, deps);
    done.push(o.skill.dir);
  }
  return done;
}

/** Move every writable other copy to the backup folder, leaving the chosen one as the only editable copy. */
export async function removeOthers(plan: ChoosePlan, deps: ChooseDeps): Promise<string[]> {
  const done: string[] = [];
  for (const o of plan.others) {
    if (!o.writable) continue;
    await uninstallSkill(o.skill, o.location, { lock: deps.lock, trashRoot: deps.backupRoot });
    done.push(o.skill.dir);
  }
  return done;
}
