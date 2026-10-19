import * as vscode from 'vscode';
import { tildify } from '../core/paths';
import { setClaudeOverride, setCodexEnabled, setInvocationFlags, toggleFiles, type ClaudeOverride } from '../core/toggles';
import { UserError } from '../core/types';
import { log } from './log';
import type { SkillsService } from './service';

export type ToggleRequest =
  | { agent: 'claude'; value: ClaudeOverride }
  | { agent: 'codex'; enabled: boolean }
  | { agent: 'frontmatter'; mode: 'auto' | 'manual' | 'off' };

const CLAUDE_LABEL: Record<ClaudeOverride, string> = {
  on: 'on (name + description)',
  'name-only': 'name only',
  'user-invocable-only': 'only when you type /name',
  off: 'off (hidden)',
};

/** Changes how one agent treats a skill, in that agent's own config, after showing exactly what is written where. */
export async function setSkillToggle(service: SkillsService, skillId: string, req: ToggleRequest): Promise<boolean> {
  const s = service.skill(skillId);
  const r = service.current;
  if (!s || !r) return false;
  const home = r.context.homeDir;
  const files = toggleFiles(home, s.scope === 'workspace' ? service.location(s.locationId)?.workspaceFolder : r.context.workspaceFolders[0]);
  let title: string;
  let detail: string;
  let apply: () => Promise<string | undefined>;

  if (req.agent === 'claude') {
    // Like Claude Code's own /skills menu: project skills → .claude/settings.local.json, others → your user settings.
    const file = s.scope === 'workspace' && files.claudeLocal ? files.claudeLocal : files.claudeUser;
    title = `Claude Code: set "${s.name}" to ${CLAUDE_LABEL[req.value]}?`;
    detail = [
      `Writes skillOverrides["${s.name}"] = "${req.value}" in ${tildify(file, home)}${req.value === 'on' ? ' (removes the entry)' : ''}.`,
      '',
      'Claude Code matches skillOverrides by skill name, so this applies to every skill with this name in the scopes that read this file.',
      'The skill itself is not changed. A backup of the settings file is kept.',
    ].join('\n');
    apply = () => setClaudeOverride(file, s.name, req.value, service.backupDir);
  } else if (req.agent === 'codex') {
    title = `Codex: ${req.enabled ? 'enable' : 'disable'} "${s.name}"?`;
    detail = [
      `Writes a [[skills.config]] entry with path = ${s.skillFile} and enabled = ${req.enabled} in ${tildify(files.codexConfig, home)}.`,
      '',
      'Restart Codex for it to take effect. The rest of config.toml is kept as is; a backup is kept.',
    ].join('\n');
    apply = () => setCodexEnabled(files.codexConfig, s.skillFile, req.enabled, service.backupDir);
  } else {
    if (s.readOnly) {
      vscode.window.showWarningMessage(`"${s.name}" is read-only: ${s.readOnlyReason ?? 'managed elsewhere'}.`);
      return false;
    }
    const flags = { modelInvocation: req.mode === 'auto', userInvocable: req.mode !== 'off' };
    const what = { auto: 'agents load it automatically', manual: 'only when you type /' + s.name, off: 'disabled (not loaded, not in the / menu)' }[req.mode];
    title = `Cursor & Copilot: make "${s.name}" ${req.mode === 'auto' ? 'automatic' : req.mode === 'manual' ? 'manual-only' : 'disabled'}?`;
    detail = [
      `Edits the skill's SKILL.md: disable-model-invocation: ${!flags.modelInvocation}, user-invocable: ${flags.userInvocable} — ${what}.`,
      '',
      'Cursor and Copilot have no per-skill setting, so this is the only way. It changes the skill itself: every agent that honours these keys (Claude Code too) sees the change, and if the skill came from GitHub an update will treat it as a local edit.',
      s.isSymlink ? `\nThis is a link: the edit is made in ${tildify(s.realDir, home)}.` : '',
      'A backup of SKILL.md is kept.',
    ].join('\n');
    apply = () => setInvocationFlags(s, flags, service.backupDir);
  }

  const ok = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Apply');
  if (ok !== 'Apply') return false;
  try {
    const backup = await apply();
    log().info(`toggle: "${s.name}" ${JSON.stringify(req)}${backup ? ` (backup ${backup})` : ''}`);
    await service.refresh();
    vscode.window.showInformationMessage(req.agent === 'codex' ? 'Saved. Restart Codex for the change to take effect.' : 'Saved.');
    return true;
  } catch (e) {
    log().error(`toggle: "${s.name}" failed`, e as Error);
    vscode.window.showErrorMessage(e instanceof UserError ? e.message : `Could not change "${s.name}": ${(e as Error).message}`);
    return false;
  }
}

