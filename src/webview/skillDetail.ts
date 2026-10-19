/* Dashboard webview — the detail pane of one skill: where it lives, which agents
 * load it, per-agent switches, checks with fixes, copies, updates and files. */
import type { Issue } from '../core/types';
import type { ViewSkill } from '../shared/protocol';
import { busy, send, ui } from './store';
import { type Child, button, chip, h, icon, sevIcon, skeleton } from './dom';
import { agentPill, fmtDate, providerName, qname, short, shortId, shown, swatch } from './agents';
import { scrollToMerges } from './overview';
import { selectSkill } from './skills';

type ClaudeOverride = 'on' | 'name-only' | 'user-invocable-only' | 'off';
type InvocationMode = 'auto' | 'manual' | 'off';
/** [value, label, tooltip] of one segment in a segmented control. */
type Segment<T extends string> = [T, string, string];

const SHORT_COMMIT_LENGTH = 7;

export const UPDATE_TEXT: Record<string, string> = {
  'up-to-date': 'Up to date',
  'update-available': 'Update available',
  pinned: 'Pinned to a commit — not updated',
  'ref-missing': 'Branch or tag no longer exists',
  'path-missing': 'Folder no longer exists upstream',
  unknown: 'Unknown — review to compare',
  error: 'Check failed',
};

const CLAUDE_SEGMENTS = (skillName: string): Array<Segment<ClaudeOverride>> => [
  ['on', 'On', 'Listed to Claude with its description'],
  ['name-only', 'Name only', 'Listed to Claude by name only'],
  ['user-invocable-only', 'Only /name', 'Hidden from Claude; you can still run /' + skillName],
  ['off', 'Off', 'Hidden everywhere'],
];

const CODEX_SEGMENTS: Array<Segment<'on' | 'off'>> = [
  ['on', 'On', 'Enabled'],
  ['off', 'Off', 'Disabled in ~/.codex/config.toml (restart Codex)'],
];

const INVOCATION_SEGMENTS: Array<Segment<InvocationMode>> = [
  ['auto', 'Auto', 'Agents load it when relevant'],
  ['manual', 'Only /name', 'disable-model-invocation: true'],
  ['off', 'Off', 'disable-model-invocation: true + user-invocable: false'],
];

// ---------- checks ----------

/** Issues of an installed skill, each with its fix button (or a pointer to edit by hand). */
export function checksList(skill: ViewSkill): Node {
  if (!skill.issues.length) return h('p', { class: 'muted' }, 'No problems found.');
  // Each fix, "choose copy" and "merge" button is shown once, on the first issue it applies to.
  const offered = new Set<string>();
  const offerOnce = (key: string, applies: boolean) => {
    if (!applies || offered.has(key)) return false;
    offered.add(key);
    return true;
  };
  return h(
    'ul',
    { class: 'issues' },
    skill.issues.map((issue) => {
      const fixes = skill.fixes.filter((fix) => fix.codes.includes(issue.code) && offerOnce(fix.id, true));
      const isDuplicate = issue.code.startsWith('duplicate:');
      const hasAnyFix = skill.fixes.some((fix) => fix.codes.includes(issue.code));
      const needsManualEdit = !hasAnyFix && issue.severity !== 'info' && !skill.readOnly && !isDuplicate;
      const isInMergeSuggestion = ui.state!.merges.some((merge) => merge.copies.some((copy) => copy.skillId === skill.id));
      const showMerge = offerOnce('merge', isDuplicate && isInMergeSuggestion);
      const showChoose = offerOnce('choose', isDuplicate && !skill.readOnly);
      return h(
        'li',
        null,
        sevIcon(issue.severity),
        h(
          'span',
          null,
          issue.message,
          fixes.length || needsManualEdit
            ? h(
                'span',
                { class: 'fix-actions' },
                fixes.map((fix) => button(fix.label, () => send({ type: 'fix', skillId: skill.id, fixId: fix.id }), { kind: 'secondary', disabled: busy.has('fix'), title: fix.detail })),
                needsManualEdit ? button('Edit SKILL.md', () => send({ type: 'openSkillFile', skillId: skill.id }), { kind: 'link', title: 'No safe automatic fix; edit it by hand' }) : null,
              )
            : null,
          showChoose || showMerge
            ? h(
                'span',
                { class: 'fix-actions' },
                showChoose
                  ? button('Use this copy…', () => send({ type: 'chooseCopy', skillId: skill.id }), {
                      kind: 'secondary',
                      disabled: busy.has('chooseCopy'),
                      title: 'Make every agent use this copy (sync or remove the others)',
                    })
                  : null,
                showMerge ? button('See merge suggestion', scrollToMerges, { kind: 'link' }) : null,
              )
            : null,
          issue.code === 'synced-copies' ? h('span', { class: 'small muted' }, ' Managed by claude.ai — nothing to fix here.') : null,
        ),
      );
    }),
  );
}

export function issueList(issues: Issue[]) {
  if (!issues.length) return h('p', { class: 'muted' }, 'No problems found.');
  return h('ul', { class: 'issues' }, issues.map((issue) => h('li', null, sevIcon(issue.severity), h('span', null, issue.message))));
}

// ---------- per-agent switches ----------

function segmentedControl<T extends string>(segments: Array<Segment<T>>, current: T, onPick: (value: T) => void, disabled = false): Node {
  const working = busy.has('toggle');
  return h(
    'div',
    { class: 'segmented small-seg', role: 'group' },
    segments.map(([value, label, title]) => {
      const isCurrent = value === current;
      return h(
        'button',
        { class: `seg ${isCurrent ? 'active' : ''}`, type: 'button', title, 'aria-pressed': isCurrent ? 'true' : 'false', disabled: disabled || working || isCurrent, onClick: () => onPick(value) },
        label,
      );
    }),
  );
}

function invocationModeOf(toggles: NonNullable<ViewSkill['toggles']>): InvocationMode {
  if (!toggles.modelInvocation && !toggles.userInvocable) return 'off';
  if (!toggles.modelInvocation) return 'manual';
  return 'auto';
}

function claudeSwitch(skill: ViewSkill, toggles: NonNullable<ViewSkill['toggles']>): Node {
  const claude = toggles.claude;
  const control: Child =
    skill.namespace || !claude
      ? h('span', { class: 'small muted' }, 'Plugin skill — enable or disable the plugin with /plugin in Claude Code.')
      : [
          segmentedControl(CLAUDE_SEGMENTS(skill.name), claude.value, (value) => send({ type: 'setToggle', skillId: skill.id, agent: 'claude', value })),
          claude.from ? h('span', { class: 'small muted' }, `from ${claude.from} settings`) : null,
        ];
  return h('div', { class: 'switch-row' }, h('span', { class: 'switch-agent' }, swatch('claude-code'), 'Claude Code'), control);
}

function codexSwitch(skill: ViewSkill, codex: { enabled: boolean }): Node {
  return h(
    'div',
    { class: 'switch-row' },
    h('span', { class: 'switch-agent' }, swatch('codex'), 'Codex'),
    segmentedControl(CODEX_SEGMENTS, codex.enabled ? 'on' : 'off', (value) => send({ type: 'setToggle', skillId: skill.id, agent: 'codex', enabled: value === 'on' })),
  );
}

/** Cursor and Copilot share one switch: they only honour frontmatter flags in the skill itself. */
function frontmatterSwitch(skill: ViewSkill, toggles: NonNullable<ViewSkill['toggles']>, agents: Array<{ id: string; displayName: string }>): Node {
  return h(
    'div',
    { class: 'switch-row' },
    h(
      'span',
      { class: 'switch-agent' },
      agents.map((agent) => swatch(agent.id)),
      agents.map((agent) => short(agent.displayName)).join(' & '),
    ),
    segmentedControl(INVOCATION_SEGMENTS, invocationModeOf(toggles), (mode) => send({ type: 'setToggle', skillId: skill.id, agent: 'frontmatter', mode }), skill.readOnly),
    h('span', { class: 'small muted', title: 'Cursor and Copilot have no per-skill setting: this edits SKILL.md and also affects Claude Code' }, skill.readOnly ? 'read-only skill' : 'edits SKILL.md'),
  );
}

/** Per-agent on/off, each with the agent's own mechanism. */
function switchesSection(skill: ViewSkill): Node | null {
  const toggles = skill.toggles;
  if (!toggles) return null;
  const agents = shown().filter((provider) => skill.visibleTo.includes(provider.id));
  if (!agents.length) return null;
  const isShown = (agentId: string) => agents.some((agent) => agent.id === agentId);
  const frontmatterAgents = agents.filter((agent) => agent.id === 'cursor' || agent.id === 'copilot');
  const rows: Node[] = [];
  if (isShown('claude-code')) rows.push(claudeSwitch(skill, toggles));
  if (isShown('codex') && toggles.codex) rows.push(codexSwitch(skill, toggles.codex));
  if (frontmatterAgents.length) rows.push(frontmatterSwitch(skill, toggles, frontmatterAgents));
  return h('div', { class: 'switches' }, h('h3', null, 'On / off per agent'), rows);
}

// ---------- notices and copies ----------

/** Explains why skills synced for another claude.ai account are not listed (they used to look like duplicates). */
export function syncedNotice(): Node | null {
  const location = ui.state!.locations.find((candidate) => candidate.skippedSyncedBuckets?.length);
  if (!location) return null;
  const count = location.skippedSynced ?? 0;
  const summary = `${count} synced skill${count === 1 ? '' : 's'} from another claude.ai account ${count === 1 ? 'is' : 'are'} not listed`;
  const active = location.activeSyncBucket;
  return h(
    'details',
    { class: 'banner info synced-notice' },
    h('summary', null, h('strong', null, summary), ' — why?'),
    h(
      'p',
      null,
      'Claude Code downloads the skills enabled for the claude.ai account you are signed in with into ',
      h('span', { class: 'mono' }, '~/.claude/skills/synced/<organization>_<account>/'),
      '. Each account gets its own folder, so after signing in with a different account (or organization) the old folder stays on disk. It is no longer updated and Claude Code does not load it.',
    ),
    active ? h('p', null, 'Your current account ', h('span', { class: 'mono' }, shortId(active.bucket)), ` — synced ${fmtDate(active.lastSynced)}. These are the skills listed.`) : null,
    location.skippedSyncedBuckets!.map((skipped) =>
      h(
        'p',
        null,
        'Other account ',
        h('span', { class: 'mono' }, shortId(skipped.bucket)),
        ` — last synced ${fmtDate(skipped.lastSynced)}, not loaded: `,
        h('span', { class: 'mono' }, skipped.skills.join(', ')),
        ' ',
        button('Move to backup…', () => send({ type: 'archiveSynced', bucket: skipped.bucket }), {
          kind: 'link',
          title: 'Clean up this leftover folder (recoverable from the backup folder)',
        }),
      ),
    ),
    h(
      'p',
      { class: 'muted small' },
      'Same names in both folders (docs, pdf…) are the same claude.ai skills downloaded once per account — that is why they looked duplicated. Nothing to fix: Claude Code manages this folder and uses the old one again if you sign in with that account.',
    ),
  );
}

function copyRow(copy: ViewSkill, viewed: ViewSkill, allSame: boolean): Node {
  const isViewed = copy.id === viewed.id;
  const working = busy.has('chooseCopy');
  const agents = copy.visibleTo.map((agentId) => short(providerName(agentId))).join(' · ') || 'no agent';
  const sameAsViewed = !!copy.contentId && copy.contentId === viewed.contentId;
  const chooseButton = allSame
    ? button('Keep only this one…', () => send({ type: 'chooseCopy', skillId: copy.id }), {
        kind: 'link',
        disabled: working,
        title: 'Remove the other copies (to the backup folder); shows which agents would lose it first',
      })
    : button('Use this one…', () => send({ type: 'chooseCopy', skillId: copy.id }), { kind: isViewed ? 'primary' : 'secondary', disabled: working, title: 'Make every agent use this copy' });
  return h(
    'li',
    { class: isViewed ? 'current' : '' },
    chip(copy.scope === 'workspace' ? 'project' : copy.scope, `scope-${copy.scope}`),
    h('button', { class: 'linkish mono', type: 'button', onClick: () => selectSkill(copy.id), title: copy.displayDir }, copy.locationLabel),
    h('span', { class: 'small muted' }, agents),
    !allSame && !isViewed ? h('span', { class: 'small' }, sameAsViewed ? chip('same as this', 'subtle') : chip('different', 'warn')) : null,
    isViewed ? chip('viewing', 'subtle') : null,
    chooseButton,
  );
}

/** Every folder that has a skill with this name, and a way to make one of them the version agents use. */
export function copiesSection(skill: ViewSkill): Node | null {
  const copies = ui.state!.skills.filter((candidate) => qname(candidate) === qname(skill));
  if (copies.length < 2) return null;
  const allSame = copies.every((copy) => copy.contentId && copy.contentId === copies[0].contentId);
  const explanation = allSame
    ? 'All copies have the same content, so it does not matter which one an agent picks.'
    : 'Agents that read several of these folders pick one copy on their own (Cursor and Copilot don’t document which). Choose the one to use: the others are made identical to it, or removed.';
  return h(
    'section',
    { class: 'copies' },
    h('h3', null, `Copies (${copies.length})`),
    h('p', { class: 'small muted' }, explanation),
    h('ul', { class: 'copy-list' }, copies.map((copy) => copyRow(copy, skill, allSame))),
  );
}

export function otherAccountNote(skill: ViewSkill): Node | null {
  if (skill.managed !== 'synced') return null;
  const otherBucket = ui.state!.locations.flatMap((location) => location.skippedSyncedBuckets ?? []).find((bucket) => bucket.skills.includes(skill.name));
  if (!otherBucket) return null;
  return h(
    'p',
    { class: 'small muted' },
    icon('info'),
    ' Another copy of this skill is synced for a different claude.ai account (',
    h('span', { class: 'mono' }, shortId(otherBucket.bucket)),
    `, last synced ${fmtDate(otherBucket.lastSynced)}). Claude Code only loads the signed-in account's copy, so the other one is not listed.`,
  );
}

// ---------- detail pane ----------

function detailActions(skill: ViewSkill): Node {
  const isGlobal = skill.scope !== 'workspace';
  return h(
    'div',
    { class: 'actions' },
    button('Open SKILL.md', () => send({ type: 'openSkillFile', skillId: skill.id }), { kind: 'primary' }),
    button('Reveal', () => send({ type: 'reveal', skillId: skill.id })),
    button('Copy path', () => send({ type: 'copyPath', skillId: skill.id })),
    isGlobal
      ? button('Add to project…', () => send({ type: 'addToProject', skillId: skill.id }), {
          kind: 'primary',
          disabled: busy.has('addToProject'),
          title: 'Copy this skill into a skills folder of the open project',
        })
      : null,
    button('Copy / Move…', () => send({ type: 'copyMove', skillId: skill.id }), { title: 'Copy or move to another skills folder; shows which agents gain or lose it first' }),
    button('Remove…', () => send({ type: 'uninstall', skillId: skill.id }), {
      kind: 'danger',
      disabled: skill.readOnly,
      title: skill.readOnly ? skill.readOnlyReason : 'Remove this skill (asks for confirmation)',
    }),
  );
}

function readOnlyNote(skill: ViewSkill): string {
  if (!skill.readOnly) return '';
  const reason = skill.readOnlyReason || (skill.managed === 'synced' ? 'synced from claude.ai' : 'managed elsewhere');
  return ` · read-only — ${reason}`;
}

function sourceDescription(skill: ViewSkill): Child {
  if (skill.source) {
    const installedOn = new Date(skill.source.installedAt).toLocaleDateString();
    return h('span', { class: 'mono' }, `${skill.source.url} @ ${skill.source.commit.slice(0, SHORT_COMMIT_LENGTH)} (installed ${installedOn})`);
  }
  if (skill.sourceHint) return `From frontmatter — ${skill.sourceHint}`;
  return h('span', { class: 'muted' }, 'Unknown — added manually or by another tool');
}

function facts(skill: ViewSkill): Node {
  return h(
    'dl',
    { class: 'kv' },
    h('dt', null, 'Location'),
    h('dd', { class: 'mono' }, skill.displayDir),
    skill.isSymlink ? [h('dt', null, 'Link target'), h('dd', { class: 'mono' }, skill.realDir || '(broken)')] : null,
    h('dt', null, 'Scope'),
    h('dd', null, skill.scope, readOnlyNote(skill)),
    h('dt', null, 'Source'),
    h('dd', null, sourceDescription(skill)),
    skill.tracked ? [h('dt', null, 'Updates'), h('dd', null, updateLine(skill))] : null,
  );
}

function checksHeader(skill: ViewSkill): Node {
  const fixableProblemCount = new Set(skill.fixes.flatMap((fix) => fix.codes)).size;
  const fixAll =
    skill.fixes.length > 1
      ? button(busy.has('fix') ? 'Fixing…' : `Fix all (${fixableProblemCount})`, () => send({ type: 'fix', skillId: skill.id }), {
          kind: 'primary',
          disabled: busy.has('fix'),
          title: 'Shows every change before applying it; keeps a backup',
        })
      : null;
  return h('div', { class: 'checks-head' }, h('h3', null, 'Checks'), fixAll);
}

function filesList(skill: ViewSkill, detail: NonNullable<typeof ui.detail>): Node {
  return h(
    'ul',
    { class: 'files' },
    detail.files.map((file) => h('li', null, h('button', { class: 'linkish mono', type: 'button', onClick: () => send({ type: 'openSkillFile', skillId: skill.id, rel: file }) }, file))),
    detail.truncated ? h('li', { class: 'muted' }, '…more files not shown') : null,
  );
}

export function skillDetail(skill: ViewSkill): Node {
  const detail = ui.detail && ui.detail.id === skill.id ? ui.detail : null;
  const frontmatter = skill.frontmatter.length
    ? [h('h3', null, 'Frontmatter'), h('dl', { class: 'kv' }, skill.frontmatter.map(([key, value]) => [h('dt', { class: 'mono' }, key), h('dd', null, value)]))]
    : null;
  return h(
    'div',
    null,
    h('div', { class: 'detail-head' }, h('h2', null, skill.namespace ? h('span', { class: 'ns' }, `${skill.namespace}:`) : null, skill.name), detailActions(skill)),
    skill.description ? h('p', null, skill.description) : null,
    h('h3', null, 'Available to'),
    h('div', { class: 'vis big' }, shown().map((provider) => agentPill(provider.id, skill.visibleTo.includes(provider.id)))),
    switchesSection(skill),
    facts(skill),
    checksHeader(skill),
    checksList(skill),
    otherAccountNote(skill),
    copiesSection(skill),
    frontmatter,
    h('h3', null, 'Files'),
    detail ? filesList(skill, detail) : skeleton(3),
    h('h3', null, 'Instructions (SKILL.md body)'),
    detail ? h('pre', { class: 'body' }, detail.body || '(empty)') : skeleton(3),
  );
}

export function updateLine(skill: ViewSkill): Node {
  const update = skill.update;
  const working = busy.has('update') || busy.has('checkUpdates');
  const canUpdate = !skill.readOnly && !skill.isSymlink && update?.status !== 'pinned';
  const hasUpdate = update?.status === 'update-available';
  let statusClass = '';
  if (hasUpdate) statusClass = 'update-text';
  else if (update?.status === 'error') statusClass = 'err-text';
  const statusText = update ? (UPDATE_TEXT[update.status] ?? update.status) : 'Not checked yet';
  return h(
    'span',
    { class: 'inline' },
    h('span', { class: statusClass }, statusText),
    hasUpdate && update?.remoteCommit ? h('span', { class: 'mono small muted' }, `→ ${update.remoteCommit.slice(0, SHORT_COMMIT_LENGTH)}`) : null,
    update?.message ? h('span', { class: 'small muted' }, update.message) : null,
    update ? h('span', { class: 'small muted' }, `checked ${new Date(update.checkedAt).toLocaleString()}`) : null,
    canUpdate
      ? button(hasUpdate ? 'Review update…' : 'Check & review…', () => send({ type: 'update', skillId: skill.id }), { kind: hasUpdate ? 'primary' : 'secondary', disabled: working })
      : null,
    button(busy.has('checkUpdates') ? 'Checking…' : 'Check all', () => send({ type: 'checkUpdates' }), { kind: 'link', disabled: working }),
    skill.tracked === 'gh-skill' ? h('span', { class: 'small muted' }, 'Installed with gh skill') : null,
  );
}
