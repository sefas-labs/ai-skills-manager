import * as vscode from 'vscode';
import type { ResolvedLocation, Scope, SkillRecord } from '../core/types';
import type { SkillsService } from './service';

type Node =
  | { kind: 'scope'; scope: Scope }
  | { kind: 'location'; location: ResolvedLocation }
  | { kind: 'skill'; skill: SkillRecord }
  | { kind: 'empty'; message: string };

const SCOPE_LABEL: Record<Scope, string> = { workspace: 'Workspace', global: 'Global (user)', admin: 'Admin (system)' };

export class SkillsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly service: SkillsService) {
    service.onDidChange(() => this.emitter.fire(undefined));
  }

  private visibleLocations(): ResolvedLocation[] {
    const r = this.service.current;
    if (!r) return [];
    const showEmpty = vscode.workspace.getConfiguration('skillsManager').get<boolean>('showEmptyLocations', false);
    return r.locations.filter((l) => l.skillCount > 0 || (showEmpty && l.exists) || l.ignoredEntries.length > 0);
  }

  getChildren(node?: Node): Node[] {
    const r = this.service.current;
    if (!r) return [];
    if (!node) {
      const scopes = new Set(this.visibleLocations().map((l) => l.scope));
      return (['workspace', 'global', 'admin'] as Scope[]).filter((s) => scopes.has(s)).map((scope) => ({ kind: 'scope', scope }));
    }
    if (node.kind === 'scope') {
      return this.visibleLocations()
        .filter((l) => l.scope === node.scope)
        .map((location) => ({ kind: 'location', location }));
    }
    if (node.kind === 'location') {
      const skills = r.skills.filter((s) => s.locationId === node.location.id).sort((a, b) => a.name.localeCompare(b.name));
      if (skills.length === 0) return [{ kind: 'empty', message: 'No valid skills in this folder' }];
      return skills.map((skill) => ({ kind: 'skill', skill }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'scope': {
        const item = new vscode.TreeItem(SCOPE_LABEL[node.scope], vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(node.scope === 'workspace' ? 'root-folder' : node.scope === 'global' ? 'home' : 'shield');
        item.contextValue = 'scope';
        return item;
      }
      case 'location': {
        const l = node.location;
        const item = new vscode.TreeItem(l.label, vscode.TreeItemCollapsibleState.Expanded);
        const where = l.origin === 'nested' ? `nested · ${l.appliesTo}/ · ` : l.origin === 'parent' ? 'parent folder · ' : '';
        item.description = where + l.readers.map((r) => this.service.providerName(r)).join(' · ');
        item.iconPath = new vscode.ThemeIcon(l.readOnly ? 'lock' : 'folder-library');
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${escapeMd(l.label)}**\n\n`);
        md.appendMarkdown(`Loaded by: ${l.readers.map((r) => this.service.providerName(r)).join(', ')}\n\n`);
        md.appendText(l.path);
        if (l.origin === 'nested') md.appendMarkdown(`\n\n$(info) Nested: agents load these when they work on files under ${escapeMd(l.appliesTo ?? '')}/ (Claude Code namespaces them as /${escapeMd(l.appliesTo ?? '')}:name).`);
        if (l.origin === 'parent') md.appendMarkdown('\n\n$(info) Above the workspace folder, inside the same git repository.');
        if (l.readOnly) md.appendMarkdown(`\n\n$(lock) Read-only: ${escapeMd(l.readOnlyReason ?? '')}`);
        if (l.ignoredEntries.length) md.appendMarkdown(`\n\n$(info) Ignored by agents (no SKILL.md): ${l.ignoredEntries.map(escapeMd).join(', ')}`);
        md.supportThemeIcons = true;
        item.tooltip = md;
        item.contextValue = 'location';
        item.resourceUri = vscode.Uri.file(l.path);
        return item;
      }
      case 'skill': {
        const s = node.skill;
        const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
        const errors = s.issues.filter((i) => i.severity === 'error').length;
        const warnings = s.issues.filter((i) => i.severity === 'warning').length;
        const flags: string[] = [];
        const update = this.service.updateFor(s);
        const hasUpdate = update?.status === 'update-available';
        if (hasUpdate) flags.push('update available');
        if (s.isSymlink) flags.push('link');
        if (s.readOnly) flags.push('read-only');
        if (errors) flags.push(`${errors} error${errors > 1 ? 's' : ''}`);
        else if (warnings) flags.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
        item.description = flags.join(' · ');
        item.iconPath = errors
          ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
          : warnings
            ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
            : hasUpdate
              ? new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('charts.blue'))
              : new vscode.ThemeIcon(s.isSymlink ? 'file-symlink-directory' : 'book');
        const md = new vscode.MarkdownString();
        md.supportThemeIcons = true;
        md.appendMarkdown(`**${escapeMd(s.name)}**\n\n`);
        if (s.description) md.appendText(s.description.slice(0, 400) + (s.description.length > 400 ? '…' : '') + '\n\n');
        md.appendMarkdown(`Visible to: ${s.visibleTo.map((p) => this.service.providerName(p)).join(', ') || '—'}\n\n`);
        if (hasUpdate) md.appendMarkdown(`$(arrow-circle-up) Update available${update?.remoteCommit ? ` (${update.remoteCommit.slice(0, 7)})` : ''}\n\n`);
        for (const i of s.issues.slice(0, 5)) md.appendMarkdown(`${i.severity === 'error' ? '$(error)' : i.severity === 'warning' ? '$(warning)' : '$(info)'} ${escapeMd(i.message)}\n\n`);
        item.tooltip = md;
        // skill | skill-readonly, plus "+update" when an update can be applied.
        item.contextValue = (s.readOnly ? 'skill-readonly' : 'skill') + (hasUpdate && !s.readOnly && !s.isSymlink ? '+update' : '');
        item.id = s.id;
        item.command = { command: 'skillsManager.showInDashboard', title: 'Show details', arguments: [node] };
        return item;
      }
      case 'empty': {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('circle-slash');
        return item;
      }
    }
  }
}

/** Extracts a skill id from a tree node or a raw id passed by the webview/command palette. */
export function skillIdFrom(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && (arg as Node).kind === 'skill') return (arg as { skill: SkillRecord }).skill.id;
  return undefined;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
