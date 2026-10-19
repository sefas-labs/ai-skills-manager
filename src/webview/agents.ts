/* Dashboard webview — agents. Vanilla TypeScript + DOM, no framework: every value from
 * the host is inserted with textContent, never innerHTML. */
import type { ProviderSummary } from '../core/types';
import type { ViewSkill } from '../shared/protocol';
import { persisted, ui } from './store';
import { h, icon } from './dom';

/** Agents shown in the dashboard: the detected ones, unless the user asked for all (or none was detected). */
export function shown(): ProviderSummary[] {
  if (!ui.state) return [];
  const detected = ui.state.providers.filter((provider) => ui.state!.agents[provider.id]?.installed);
  return persisted.showAllAgents || detected.length === 0 ? ui.state.providers : detected;
}

export const isHost = (id: string) => ui.state?.host.agentId === id;

/** One color per agent everywhere (VS Code chart palette, so every theme works). */
export const AGENT_COLOR: Record<string, string> = { 'claude-code': 'orange', cursor: 'blue', codex: 'green', copilot: 'purple' };

/** Colors for agents added later (custom readers, new providers), assigned by position. */
const EXTRA_AGENT_COLORS = ['yellow', 'red', 'blue', 'green'];

/** `position` defaults to the agent's place in the provider list. */
export function agentColor(id: string, position = ui.state?.providers.findIndex((provider) => provider.id === id) ?? 0): string {
  if (AGENT_COLOR[id]) return AGENT_COLOR[id];
  return EXTRA_AGENT_COLORS[Math.max(position, 0) % EXTRA_AGENT_COLORS.length];
}

export const swatch = (id: string) => h('span', { class: `swatch c-${agentColor(id)}`, 'aria-hidden': 'true' });

/** Colored dots for the agents that load a skill, plus "n/m" against the agents shown. */
export function agentDots(visibleTo: string[]): Node {
  const agents = shown();
  const loading = agents.filter((agent) => visibleTo.includes(agent.id));
  let coverage = '';
  if (loading.length === agents.length) coverage = 'full';
  else if (loading.length === 0) coverage = 'none';
  return h(
    'span',
    {
      class: 'agent-dots',
      title: loading.length ? `Loaded by ${loading.map((agent) => agent.displayName).join(', ')}` : 'No agent loads it',
      'aria-label': `${loading.length} of ${agents.length} agents`,
    },
    loading.map((agent) => h('span', { class: `dot-a c-${agentColor(agent.id)}` })),
    h('span', { class: `ratio ${coverage}` }, `${loading.length}/${agents.length}`),
  );
}

/** Agent name with its color; struck through when it doesn't load the thing. */
export function agentPill(id: string, loadsIt: boolean, label = providerName(id)): Node {
  const title = `${providerName(id)}: ${loadsIt ? 'loads it' : 'does not load it'}`;
  return h('span', { class: `apill ${loadsIt ? 'on' : 'off'} c-${agentColor(id)}`, title }, icon(loadsIt ? 'check' : 'close'), label);
}

export function providerName(id: string): string {
  const provider = ui.state?.providers.find((candidate) => candidate.id === id);
  if (provider) return provider.displayName;
  return id === 'custom' ? 'Custom' : id;
}

/** How the skill is invoked: plugin skills are `<plugin>:<name>`. Same qualified name = same skill identity. */
export const qname = (skill: { name: string; namespace?: string }) => (skill.namespace ? `${skill.namespace}:${skill.name}` : skill.name);

const KILOBYTE = 1024;
const MEGABYTE = 1024 * KILOBYTE;

export function fmtBytes(bytes: number): string {
  if (bytes < KILOBYTE) return `${bytes} B`;
  if (bytes < MEGABYTE) return `${(bytes / KILOBYTE).toFixed(1)} KB`;
  return `${(bytes / MEGABYTE).toFixed(1)} MB`;
}

export const problems = (skill: ViewSkill) => skill.issues.filter((issue) => issue.severity !== 'info');

export function fmtDate(isoDate?: string): string {
  if (!isoDate) return 'unknown date';
  return new Date(isoDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const SHORT_ID_LENGTH = 8;
export const shortId = (bucket: string) => bucket.slice(0, SHORT_ID_LENGTH) + '…';

const SHORT_AGENT_NAME: Record<string, string> = { 'Claude Code': 'Claude', 'GitHub Copilot': 'Copilot' };

export function short(displayName: string): string {
  return SHORT_AGENT_NAME[displayName] ?? displayName;
}

