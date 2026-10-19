import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURED_SOURCES, listSource, rankByQuery, searchGitHub, type DescriptionCache } from '../../src/core/catalog';
import { GitHubClient, parseGitHubUrl } from '../../src/core/github';
import { inspectRepository } from '../../src/core/installer';
import { FakeGitHub, FakeRepo } from '../helpers/fakeGitHub';
import { skillMd } from '../helpers/fsFixture';

const C1 = 'c'.repeat(40);
function repos(): Record<string, FakeRepo> {
  return {
    'acme/skills': {
      defaultBranch: 'main',
      refs: { main: C1 },
      commits: {
        [C1]: {
          'skills/pdf/SKILL.md': skillMd('pdf', 'Read and write PDF files.'),
          'skills/pdf/nested/SKILL.md': skillMd('inner'),
          'skills/deploy/SKILL.md': skillMd('deploy', 'Ship the app to production.'),
          'node_modules/x/SKILL.md': skillMd('junk'),
          'README.md': '# hi',
        },
      },
    },
    'other/tools': { defaultBranch: 'trunk', refs: { trunk: C1 }, commits: { [C1]: { 'SKILL.md': skillMd('tools', 'PDF helpers at the repo root.') } } },
  };
}
const src = { id: 'acme/skills', owner: 'acme', repo: 'skills', title: 'Acme', blurb: '' };

test('listing a collection: outermost skills only, names/descriptions from frontmatter, 3 API calls, cached by blob SHA', async () => {
  const gh = new FakeGitHub(repos());
  const client = new GitHubClient({ fetch: gh.fetch });
  const cache: DescriptionCache = new Map();
  const r = await listSource(client, src, cache);
  assert.equal(r.ref, 'main');
  assert.deepEqual(r.skills.map((s) => [s.name, s.dir]), [['deploy', 'skills/deploy'], ['pdf', 'skills/pdf']]);
  assert.equal(r.skills.find((s) => s.name === 'pdf')!.description, 'Read and write PDF files.');
  assert.equal(r.skills[0].url, 'https://github.com/acme/skills/tree/main/skills/deploy');
  const api = gh.calls.filter((c) => new URL(c.url).hostname === 'api.github.com').length;
  assert.equal(api, 3);
  const raw = gh.calls.length - api;
  await listSource(client, src, cache);
  assert.equal(gh.calls.length - api * 2 - raw, 0, 'second listing downloads no SKILL.md again');
});

test('a catalog URL goes straight into the normal install inspection', async () => {
  const client = new GitHubClient({ fetch: new FakeGitHub(repos()).fetch });
  const { skills } = await listSource(client, src, new Map());
  const insp = await inspectRepository(client, parseGitHubUrl(skills[1].url));
  assert.deepEqual(insp.candidates.map((c) => c.installName), ['pdf']);
});

test('searching all of GitHub needs a sign-in and finds SKILL.md files by content', async () => {
  const gh = new FakeGitHub(repos(), 'tok');
  await assert.rejects(searchGitHub(new GitHubClient({ fetch: gh.fetch }), 'pdf', new Map()), /Sign in to GitHub/);
  const hits = await searchGitHub(new GitHubClient({ fetch: gh.fetch, token: 'tok' }), 'pdf', new Map());
  assert.deepEqual(hits.map((h) => `${h.owner}/${h.repo}:${h.name}`).sort(), ['acme/skills:pdf', 'other/tools:tools']);
  const root = hits.find((h) => h.repo === 'tools')!;
  assert.equal(root.url, 'https://github.com/other/tools/tree/HEAD');
  assert.equal(root.description, 'PDF helpers at the repo root.');
  assert.ok(!hits.some((h) => h.dir.includes('node_modules')));
});

test('featured sources are well-formed and unique', () => {
  const ids = FEATURED_SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of FEATURED_SOURCES) assert.equal(s.id, `${s.owner}/${s.repo}`);
});

test('search ranking: name matches first, then description', () => {
  const r = rankByQuery([{ name: 'misc', description: 'nothing' }, { name: 'tools', description: 'release helpers' }, { name: 'release-notes' }], 'release');
  assert.deepEqual(r.map((x) => x.name), ['release-notes', 'tools', 'misc']);
});
