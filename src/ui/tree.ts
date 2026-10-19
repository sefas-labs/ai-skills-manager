import * as vscode from 'vscode';
import type { Issue, ResolvedLocation, Scope, SkillRecord } from '../core/types';
import { fixesFor } from '../core/fixes';
import type { SkillsService } from './service';

type Node =
  | { kind: 'scope'; scope: Scope }
  | { kind: 'location'; location: ResolvedLocation }
  | { kind: 'skill'; skill: SkillRecord }
  | { kind: 'empty'; message: string };

const SCOPE_ORDER: Scope[] = ['workspace', 'global', 'admin'];
const SCOPE_LABEL: Record<Scope, string> = { workspace: 'Workspace', global: 'Global (user)', admin: 'Admin (system)' };
const SCOPE_ICON: Record<Scope, string> = { workspace: 'root-folder', global: 'home', admin: 'shield' };
const SEVERITY_ICON: Record<Issue['severity'], string> = { error: '$(error)', warning: '$(warning)', info: '$(info)' };
const MAX_TOOLTIP_DESCRIPTION = 400;
const MAX_TOOLTIP_ISSUES = 5;
const SHORT_COMMIT_LENGTH = 7;
const MARKDOWN_SPECIAL_CHARACTER = /[\\`*_{}[\]()#+\-.!|<>]/g;

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL_CHARACTER, '\\$&');
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count > 1 ? 's' : ''}`;
}

export class SkillsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly service: SkillsService) {
    service.onDidChange(() => this.emitter.fire(undefined));
  }

  private visibleLocations(): ResolvedLocation[] {
    const result = this.service.current;
    if (!result) return [];
    const showEmpty = vscode.workspace.getConfiguration('skillsManager').get<boolean>('showEmptyLocations', false);
    return result.locations.filter((location) => location.skillCount > 0 || (showEmpty && location.exists) || location.ignoredEntries.length > 0);
  }

  getChildren(node?: Node): Node[] {
    const result = this.service.current;
    if (!result) return [];
    if (!node) {
      const scopesWithLocations = new Set(this.visibleLocations().map((location) => location.scope));
      return SCOPE_ORDER.filter((scope) => scopesWithLocations.has(scope)).map((scope) => ({ kind: 'scope', scope }));
    }
    if (node.kind === 'scope') {
      return this.visibleLocations()
        .filter((location) => location.scope === node.scope)
        .map((location) => ({ kind: 'location', location }));
    }
    if (node.kind === 'location') {
      const skills = result.skills.filter((skill) => skill.locationId === node.location.id).sort((first, second) => first.name.localeCompare(second.name));
      if (skills.length === 0) return [{ kind: 'empty', message: 'No valid skills in this folder' }];
      return skills.map((skill) => ({ kind: 'skill', skill }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'scope': {
        const item = new vscode.TreeItem(SCOPE_LABEL[node.scope], vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(SCOPE_ICON[node.scope]);
        item.contextValue = 'scope';
        return item;
      }
      case 'location':
        return this.locationItem(node.location);
      case 'skill':
        return this.skillItem(node);
      case 'empty': {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('circle-slash');
        return item;
      }
    }
  }

  private locationItem(location: ResolvedLocation): vscode.TreeItem {
    const item = new vscode.TreeItem(location.label, vscode.TreeItemCollapsibleState.Expanded);
    let origin = '';
    if (location.origin === 'nested') origin = `nested · ${location.appliesTo}/ · `;
    else if (location.origin === 'parent') origin = 'parent folder · ';
    item.description = origin + this.service.agentNames(location.readers, '', ' · ');
    item.iconPath = new vscode.ThemeIcon(location.readOnly ? 'lock' : 'folder-library');

    const tooltip = new vscode.MarkdownString();
    tooltip.supportThemeIcons = true;
    tooltip.appendMarkdown(`**${escapeMarkdown(location.label)}**\n\n`);
    tooltip.appendMarkdown(`Loaded by: ${this.service.agentNames(location.readers, '')}\n\n`);
    tooltip.appendText(location.path);
    if (location.origin === 'nested') {
      const subfolder = escapeMarkdown(location.appliesTo ?? '');
      tooltip.appendMarkdown(`\n\n$(info) Nested: agents load these when they work on files under ${subfolder}/ (Claude Code namespaces them as /${subfolder}:name).`);
    }
    if (location.origin === 'parent') tooltip.appendMarkdown('\n\n$(info) Above the workspace folder, inside the same git repository.');
    if (location.skippedSynced) {
      tooltip.appendMarkdown(`\n\n$(info) ${location.skippedSynced} skill(s) synced for another claude.ai account are not listed: Claude Code only loads the signed-in account's skills.`);
    }
    if (location.readOnly) tooltip.appendMarkdown(`\n\n$(lock) Read-only: ${escapeMarkdown(location.readOnlyReason ?? '')}`);
    if (location.ignoredEntries.length) tooltip.appendMarkdown(`\n\n$(info) Ignored by agents (no SKILL.md): ${location.ignoredEntries.map(escapeMarkdown).join(', ')}`);
    item.tooltip = tooltip;
    item.contextValue = 'location';
    item.resourceUri = vscode.Uri.file(location.path);
    return item;
  }

  private skillIcon(skill: SkillRecord, errorCount: number, warningCount: number, hasUpdate: boolean): vscode.ThemeIcon {
    if (errorCount) return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    if (warningCount) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    if (hasUpdate) return new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('charts.blue'));
    return new vscode.ThemeIcon(skill.isSymlink ? 'file-symlink-directory' : 'book');
  }

  /** `skill` or `skill-readonly`, plus flags the menus in package.json match on (+update, +fix, +global, +dup). */
  private skillContextValue(skill: SkillRecord, hasUpdate: boolean): string {
    const canFix = fixesFor(skill, this.service.location(skill.locationId)).length > 0;
    const canUpdate = hasUpdate && !skill.readOnly && !skill.isSymlink;
    const isDuplicate = skill.issues.some((issue) => issue.code.startsWith('duplicate:'));
    let value = skill.readOnly ? 'skill-readonly' : 'skill';
    if (canUpdate) value += '+update';
    if (canFix) value += '+fix';
    if (skill.scope !== 'workspace') value += '+global';
    if (isDuplicate) value += '+dup';
    return value;
  }

  private skillItem(node: Extract<Node, { kind: 'skill' }>): vscode.TreeItem {
    const skill = node.skill;
    const item = new vscode.TreeItem(skill.name, vscode.TreeItemCollapsibleState.None);
    const errorCount = skill.issues.filter((issue) => issue.severity === 'error').length;
    const warningCount = skill.issues.filter((issue) => issue.severity === 'warning').length;
    const update = this.service.updateFor(skill);
    const hasUpdate = update?.status === 'update-available';

    const flags: string[] = [];
    if (hasUpdate) flags.push('update available');
    if (skill.isSymlink) flags.push('link');
    if (skill.readOnly) flags.push('read-only');
    if (errorCount) flags.push(countLabel(errorCount, 'error'));
    else if (warningCount) flags.push(countLabel(warningCount, 'warning'));
    item.description = flags.join(' · ');
    item.iconPath = this.skillIcon(skill, errorCount, warningCount, hasUpdate);

    const tooltip = new vscode.MarkdownString();
    tooltip.supportThemeIcons = true;
    tooltip.appendMarkdown(`**${escapeMarkdown(skill.name)}**\n\n`);
    if (skill.description) {
      const ellipsis = skill.description.length > MAX_TOOLTIP_DESCRIPTION ? '…' : '';
      tooltip.appendText(skill.description.slice(0, MAX_TOOLTIP_DESCRIPTION) + ellipsis + '\n\n');
    }
    tooltip.appendMarkdown(`Visible to: ${this.service.agentNames(skill.visibleTo, '—')}\n\n`);
    if (hasUpdate) {
      const commit = update?.remoteCommit ? ` (${update.remoteCommit.slice(0, SHORT_COMMIT_LENGTH)})` : '';
      tooltip.appendMarkdown(`$(arrow-circle-up) Update available${commit}\n\n`);
    }
    for (const issue of skill.issues.slice(0, MAX_TOOLTIP_ISSUES)) tooltip.appendMarkdown(`${SEVERITY_ICON[issue.severity]} ${escapeMarkdown(issue.message)}\n\n`);
    item.tooltip = tooltip;
    item.contextValue = this.skillContextValue(skill, hasUpdate);
    item.id = skill.id;
    item.command = { command: 'skillsManager.showInDashboard', title: 'Show details', arguments: [node] };
    return item;
  }
}

/** Extracts a skill id from a tree node or a raw id passed by the webview/command palette. */
export function skillIdFrom(argument: unknown): string | undefined {
  if (typeof argument === 'string') return argument;
  const isSkillNode = !!argument && typeof argument === 'object' && (argument as Node).kind === 'skill';
  return isSkillNode ? (argument as { skill: SkillRecord }).skill.id : undefined;
}
