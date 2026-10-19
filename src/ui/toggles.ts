import * as vscode from 'vscode';
import { tildify } from '../core/paths';
import { setClaudeOverride, setCodexEnabled, setInvocationFlags, toggleFiles, type ClaudeOverride, type ToggleFiles } from '../core/toggles';
import { SkillRecord, UserError } from '../core/types';
import { log } from './log';
import type { SkillsService } from './service';

type InvocationMode = 'auto' | 'manual' | 'off';

export type ToggleRequest =
  | { agent: 'claude'; value: ClaudeOverride }
  | { agent: 'codex'; enabled: boolean }
  | { agent: 'frontmatter'; mode: InvocationMode };

/** What a toggle will write, shown in the modal before `apply` runs. */
interface PlannedToggle {
  title: string;
  detail: string;
  apply: () => Promise<string | undefined>;
}

const CLAUDE_LABEL: Record<ClaudeOverride, string> = {
  on: 'on (name + description)',
  'name-only': 'name only',
  'user-invocable-only': 'only when you type /name',
  off: 'off (hidden)',
};

const MODE_ADJECTIVE: Record<InvocationMode, string> = { auto: 'automatic', manual: 'manual-only', off: 'disabled' };
const APPLY = 'Apply';

function planClaudeToggle(service: SkillsService, skill: SkillRecord, files: ToggleFiles, home: string, value: ClaudeOverride): PlannedToggle {
  // Like Claude Code's own /skills menu: project skills → .claude/settings.local.json, others → your user settings.
  const settingsFile = skill.scope === 'workspace' && files.claudeLocal ? files.claudeLocal : files.claudeUser;
  const removesEntry = value === 'on' ? ' (removes the entry)' : '';
  return {
    title: `Claude Code: set "${skill.name}" to ${CLAUDE_LABEL[value]}?`,
    detail: [
      `Writes skillOverrides["${skill.name}"] = "${value}" in ${tildify(settingsFile, home)}${removesEntry}.`,
      '',
      'Claude Code matches skillOverrides by skill name, so this applies to every skill with this name in the scopes that read this file.',
      'The skill itself is not changed. A backup of the settings file is kept.',
    ].join('\n'),
    apply: () => setClaudeOverride(settingsFile, skill.name, value, service.backupDir),
  };
}

function planCodexToggle(service: SkillsService, skill: SkillRecord, files: ToggleFiles, home: string, enabled: boolean): PlannedToggle {
  return {
    title: `Codex: ${enabled ? 'enable' : 'disable'} "${skill.name}"?`,
    detail: [
      `Writes a [[skills.config]] entry with path = ${skill.skillFile} and enabled = ${enabled} in ${tildify(files.codexConfig, home)}.`,
      '',
      'Restart Codex for it to take effect. The rest of config.toml is kept as is; a backup is kept.',
    ].join('\n'),
    apply: () => setCodexEnabled(files.codexConfig, skill.skillFile, enabled, service.backupDir),
  };
}

function planFrontmatterToggle(service: SkillsService, skill: SkillRecord, home: string, mode: InvocationMode): PlannedToggle {
  const flags = { modelInvocation: mode === 'auto', userInvocable: mode !== 'off' };
  const effect: Record<InvocationMode, string> = {
    auto: 'agents load it automatically',
    manual: 'only when you type /' + skill.name,
    off: 'disabled (not loaded, not in the / menu)',
  };
  return {
    title: `Cursor & Copilot: make "${skill.name}" ${MODE_ADJECTIVE[mode]}?`,
    detail: [
      `Edits the skill's SKILL.md: disable-model-invocation: ${!flags.modelInvocation}, user-invocable: ${flags.userInvocable} — ${effect[mode]}.`,
      '',
      'Cursor and Copilot have no per-skill setting, so this is the only way. It changes the skill itself: every agent that honours these keys (Claude Code too) sees the change, and if the skill came from GitHub an update will treat it as a local edit.',
      skill.isSymlink ? `\nThis is a link: the edit is made in ${tildify(skill.realDir, home)}.` : '',
      'A backup of SKILL.md is kept.',
    ].join('\n'),
    apply: () => setInvocationFlags(skill, flags, service.backupDir),
  };
}

/** Changes how one agent treats a skill, in that agent's own config, after showing exactly what is written where. */
export async function setSkillToggle(service: SkillsService, skillId: string, request: ToggleRequest): Promise<boolean> {
  const skill = service.skill(skillId);
  const result = service.current;
  if (!skill || !result) return false;
  const home = result.context.homeDir;
  const workspaceFolder = skill.scope === 'workspace' ? service.location(skill.locationId)?.workspaceFolder : result.context.workspaceFolders[0];
  const files = toggleFiles(home, workspaceFolder);

  if (request.agent === 'frontmatter' && skill.readOnly) {
    vscode.window.showWarningMessage(`"${skill.name}" is read-only: ${skill.readOnlyReason ?? 'managed elsewhere'}.`);
    return false;
  }
  let planned: PlannedToggle;
  if (request.agent === 'claude') planned = planClaudeToggle(service, skill, files, home, request.value);
  else if (request.agent === 'codex') planned = planCodexToggle(service, skill, files, home, request.enabled);
  else planned = planFrontmatterToggle(service, skill, home, request.mode);

  const answer = await vscode.window.showWarningMessage(planned.title, { modal: true, detail: planned.detail }, APPLY);
  if (answer !== APPLY) return false;
  try {
    const backup = await planned.apply();
    log().info(`toggle: "${skill.name}" ${JSON.stringify(request)}${backup ? ` (backup ${backup})` : ''}`);
    await service.refresh();
    vscode.window.showInformationMessage(request.agent === 'codex' ? 'Saved. Restart Codex for the change to take effect.' : 'Saved.');
    return true;
  } catch (error) {
    log().error(`toggle: "${skill.name}" failed`, error as Error);
    vscode.window.showErrorMessage(error instanceof UserError ? error.message : `Could not change "${skill.name}": ${(error as Error).message}`);
    return false;
  }
}
