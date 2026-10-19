/* Dashboard webview — agents. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { ProviderSummary } from '../core/types';
import type { ViewSkill } from '../shared/protocol';
import { persisted, ui } from './store';
import { h, icon } from './dom';

/** Agents shown in the dashboard: the detected ones, unless the user asked for all (or none was detected). */
export function shown(): ProviderSummary[] {
  if (!ui.state) return [];
  const detected = ui.state.providers.filter((p) => ui.state!.agents[p.id]?.installed);
  return persisted.showAllAgents || detected.length === 0 ? ui.state.providers : detected;
}

export const isHost = (id: string) => ui.state?.host.agentId === id;

/** One color per agent everywhere (VS Code chart palette, so every theme works). */
export const AGENT_COLOR: Record<string, string> = { 'claude-code': 'orange', cursor: 'blue', codex: 'green', copilot: 'purple' };

export const agentColor = (id: string, i = ui.state?.providers.findIndex((p) => p.id === id) ?? 0) => AGENT_COLOR[id] ?? ['yellow', 'red', 'blue', 'green'][Math.max(i, 0) % 4];

export const swatch = (id: string) => h('span', { class: `swatch c-${agentColor(id)}`, 'aria-hidden': 'true' });

/** Colored dots for the agents that load a skill, plus "n/m" against the agents shown. */
export function agentDots(visibleTo: string[]): Node {
  const agents = shown();
  const on = agents.filter((a) => visibleTo.includes(a.id));
  return h(
    'span',
    { class: 'agent-dots', title: on.length ? `Loaded by ${on.map((a) => a.displayName).join(', ')}` : 'No agent loads it', 'aria-label': `${on.length} of ${agents.length} agents` },
    on.map((a) => h('span', { class: `dot-a c-${agentColor(a.id)}` })),
    h('span', { class: `ratio ${on.length === agents.length ? 'full' : on.length ? '' : 'none'}` }, `${on.length}/${agents.length}`),
  );
}

/** Agent name with its color; struck through when it doesn't load the thing. */
export function agentPill(id: string, on: boolean, label = providerName(id)): Node {
  return h('span', { class: `apill ${on ? 'on' : 'off'} c-${agentColor(id)}`, title: `${providerName(id)}: ${on ? 'loads it' : 'does not load it'}` }, icon(on ? 'check' : 'close'), label);
}

export const providerName = (id: string) => ui.state?.providers.find((p) => p.id === id)?.displayName ?? (id === 'custom' ? 'Custom' : id);

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const problems = (s: ViewSkill) => s.issues.filter((i) => i.severity !== 'info');

export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown date');

export const shortId = (bucket: string) => bucket.slice(0, 8) + '…';

export function short(name: string): string {
  return ({ 'Claude Code': 'Claude', 'GitHub Copilot': 'Copilot' } as Record<string, string>)[name] ?? name;
}

