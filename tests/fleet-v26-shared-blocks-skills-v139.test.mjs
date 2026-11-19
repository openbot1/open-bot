/**
 * Tests for fleet v26 shared blocks + skill pack (v1.39, Team T6).
 *
 * Covers:
 * - Shared blocks: create (id rules, duplicates, size cap), attach/
 *   detach (bot must exist), versioned writes (stale writer refused,
 *   lease blocks other writers, history capped + ordered), leases
 *   (acquire/release/expiry), provider delegation for search (memory
 *   v24 adapter wins over the local substring fallback), read, remove,
 *   JSON round-trip.
 * - Skills: SKILL.md parsing (frontmatter + body, missing close,
 *   bad name, short body), install budgets (metadata > 200 tokens
 *   refused, body > 5k tokens refused), tier-1 metadata listing,
 *   tier-2 body loading (lazy — nothing loaded until asked), tier-3
 *   asset loading, keyword matching on metadata only, checksum,
 *   JSON round-trip.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v26-shared-blocks-skills-v139.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V26_BLOCK_MAX_CHARS,
  FleetV26BotRegistry,
  FleetV26SharedBlockRegistry,
  FleetV26SkillPack,
  checksumFleetV26Skill,
  estimateFleetV26Tokens,
  parseFleetV26SkillMd,
  summarizeFleetV26SharedBlocks,
  summarizeFleetV26SkillPack,
} from '../packages/core/dist/fleetV26/index.js';

const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);

function botsWith(...ids) {
  const reg = new FleetV26BotRegistry();
  for (const id of ids) reg.register({ id }, NOW);
  return reg;
}

// --- shared blocks ---------------------------------------------------------

test('blocks v26: create + attach + versioned write + history', () => {
  const reg = new FleetV26SharedBlockRegistry();
  const bots = botsWith('bot-a', 'bot-b');
  assert.equal(reg.create({ id: 'bad id' }).ok, false);
  const c = reg.create({ id: 'current_plan', title: 'Current plan', text: 'step 1', createdBy: 'bot-a', tags: ['plan'] }, NOW);
  assert.equal(c.ok, true);
  assert.equal(c.version, 1);
  assert.equal(reg.create({ id: 'current_plan' }).ok, false); // duplicate
  assert.equal(reg.create({ id: 'huge', text: 'x'.repeat(FLEET_V26_BLOCK_MAX_CHARS + 1) }).ok, false);

  // Attach requires a registered bot.
  assert.equal(reg.attach('current_plan', 'ghost', bots).ok, false);
  assert.equal(reg.attach('current_plan', 'bot-a', bots).ok, true);
  assert.equal(reg.attach('current_plan', 'bot-a', bots).ok, true); // idempotent
  assert.equal(reg.attach('current_plan', 'bot-b', bots).ok, true);
  assert.deepEqual(reg.get('current_plan')?.attachedBotIds, ['bot-a', 'bot-b']);

  // Write at the right version succeeds; a stale writer is refused.
  const w1 = reg.write('current_plan', { text: 'step 2', byBotId: 'bot-a', expectedVersion: 1, reason: 'step 1 done' }, NOW + 1000);
  assert.equal(w1.ok, true);
  assert.equal(w1.version, 2);
  const stale = reg.write('current_plan', { text: 'stale', byBotId: 'bot-b', expectedVersion: 1 }, NOW + 2000);
  assert.equal(stale.ok, false);
  assert.match(stale.message, /version 2, not 1/);
  assert.equal(reg.get('current_plan')?.text, 'step 2');

  // Unattached bots cannot write.
  const bots2 = botsWith('bot-a', 'bot-b', 'bot-c');
  assert.equal(reg.write('current_plan', { text: 'x', byBotId: 'bot-c', expectedVersion: 2 }, NOW + 3000).ok, false);

  // History: created + 1 write, oldest first.
  const hist = reg.history('current_plan');
  assert.equal(hist.length, 2);
  assert.equal(hist[0].version, 1);
  assert.equal(hist[1].reason, 'step 1 done');
  assert.equal(hist[1].updatedByBotId, 'bot-a');

  // Detach + remove.
  assert.equal(reg.detach('current_plan', 'bot-b').ok, true);
  assert.deepEqual(reg.get('current_plan')?.attachedBotIds, ['bot-a']);
  assert.equal(reg.listForBot('bot-a').length, 1);
  assert.equal(reg.listForBot('bot-b').length, 0);
  assert.equal(reg.remove('current_plan').ok, true);
  assert.equal(reg.get('current_plan'), undefined);
  assert.equal(reg.remove('current_plan').ok, false);
  void bots2;
});

test('blocks v26: leases gate writes', () => {
  const reg = new FleetV26SharedBlockRegistry();
  const bots = botsWith('bot-a', 'bot-b');
  reg.create({ id: 'plan', text: 'v1' }, NOW);
  reg.attach('plan', 'bot-a', bots);
  reg.attach('plan', 'bot-b', bots);
  assert.equal(reg.acquireLease('plan', 'bot-a', 60000, NOW).ok, true);
  // bot-b's write is refused while bot-a holds the lease...
  assert.equal(reg.write('plan', { text: 'b-edit', byBotId: 'bot-b', expectedVersion: 1 }, NOW + 1000).ok, false);
  // ...but the lease holder may write.
  assert.equal(reg.write('plan', { text: 'a-edit', byBotId: 'bot-a', expectedVersion: 1 }, NOW + 1000).ok, true);
  // Another bot cannot steal the lease; the holder releases it.
  assert.equal(reg.acquireLease('plan', 'bot-b', 60000, NOW + 2000).ok, false);
  assert.equal(reg.releaseLease('plan', 'bot-b').ok, false);
  assert.equal(reg.releaseLease('plan', 'bot-a').ok, true);
  // After expiry a new lease may be taken.
  assert.equal(reg.acquireLease('plan', 'bot-b', 60000, NOW + 61000).ok, true);
  assert.equal(reg.counts().leased, 1);
  assert.ok(summarizeFleetV26SharedBlocks(reg).includes('1 shared block'));
});

test('blocks v26: search — provider wins, fallback is substring only', () => {
  const reg = new FleetV26SharedBlockRegistry();
  const bots = botsWith('bot-a');
  reg.create({ id: 'org', title: 'Organization', text: 'The fleet ships open-bot every day.' }, NOW);
  reg.attach('org', 'bot-a', bots);

  const fallback = reg.searchBlocks('open-bot');
  assert.equal(fallback.via, 'local-fallback');
  assert.equal(fallback.results.length, 1);
  assert.equal(fallback.results[0].blockId, 'org');
  assert.equal(reg.searchBlocks('zzz-no-match').results.length, 0);
  assert.equal(reg.searchBlocks('').results.length, 0);

  // A memory provider (memory v24 adapter shape) takes over ranking.
  reg.setProvider({
    name: 'memory-v24',
    searchBlocks: (query, limit) => (query === 'plan' ? [{ blockId: 'org', score: 0.9, snippet: 'provider-ranked' }] : []).slice(0, limit),
  });
  assert.equal(reg.providerName(), 'memory-v24');
  const via = reg.searchBlocks('plan');
  assert.equal(via.via, 'memory-v24');
  assert.equal(via.results[0].snippet, 'provider-ranked');

  const restored = FleetV26SharedBlockRegistry.fromJSON(reg.toJSON());
  assert.equal(restored.get('org')?.title, 'Organization');
  assert.equal(restored.providerName(), null); // provider is host-wired, never persisted
});

// --- skills -----------------------------------------------------------------

const SKILL_MD = `---
name: code-review
description: Review a diff for bugs, security issues and style.
allowed-tools: [read-file, run-tests]
argument-hint: <diff> [--fix]
version: 1.2.0
triggers: [review, diff, pr]
author: fleet-team
---
# Code review

Read the diff, list issues by severity, then suggest fixes.
Never approve a diff with a high-severity issue.
`;

test('skills v26: SKILL.md parsing', () => {
  const parsed = parseFleetV26SkillMd(SKILL_MD, 'code-review');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.skill.name, 'code-review');
    assert.equal(parsed.skill.version, '1.2.0');
    assert.deepEqual(parsed.skill.allowedTools, ['read-file', 'run-tests']);
    assert.deepEqual(parsed.skill.triggers, ['review', 'diff', 'pr']);
    assert.equal(parsed.skill.argumentHint, '<diff> [--fix]');
    assert.ok(parsed.skill.body.startsWith('# Code review'));
  }
  assert.equal(parseFleetV26SkillMd('---\nname: x\n', 'x').ok, false); // unclosed frontmatter
  assert.equal(parseFleetV26SkillMd('---\nname: Bad_Name\ndescription: d\n---\n' + 'x'.repeat(50), 'x').ok, false);
  assert.equal(parseFleetV26SkillMd('---\nname: ok-name\n---\n' + 'x'.repeat(50), 'ok-name').ok, false); // no description
  assert.equal(parseFleetV26SkillMd('---\nname: ok-name\ndescription: d\n---\nshort', 'ok-name').ok, false); // body too short
  // No frontmatter at all: fallback name + body, but no description -> refused.
  assert.equal(parseFleetV26SkillMd('# Just a body\n' + 'x'.repeat(60), 'plain-skill').ok, false);
});

test('skills v26: budgets, tiers, matching', () => {
  const pack = new FleetV26SkillPack();
  assert.equal(estimateFleetV26Tokens('abcd'), 1);
  assert.equal(estimateFleetV26Tokens('a'.repeat(400)), 100);

  // Install from markdown.
  const installed = pack.installFromMd(SKILL_MD, 'code-review', [], {}, NOW);
  assert.equal(installed.ok, true);
  assert.ok((installed.metadataTokens ?? 999) <= 200);
  assert.ok((installed.bodyTokens ?? 999) < 5000);
  assert.equal(pack.installFromMd(SKILL_MD, 'code-review').ok, false); // duplicate without overwrite

  // Tier 1: metadata only — cheap, and the body is NOT loaded yet.
  const meta = pack.listMetadata();
  assert.equal(meta.length, 1);
  assert.equal(meta[0].name, 'code-review');
  assert.equal(meta[0].bodyWithinBudget, true);
  assert.deepEqual(pack.loadedBodyNames(), []);
  assert.equal(pack.totalMetadataTokens(), meta[0].metadataTokens);

  // Tier 2: body loads on demand.
  const body = pack.loadBody('code-review');
  assert.equal(body.ok, true);
  assert.ok((body.body ?? '').includes('Never approve'));
  assert.deepEqual(pack.loadedBodyNames(), ['code-review']);
  assert.equal(pack.loadBody('ghost').ok, false);

  // Tier 3: lazy files.
  pack.install(
    {
      name: 'with-script', description: 'Runs a helper script when asked.', body: 'Use scripts/run.sh to check the repo. ' + 'x'.repeat(30),
      triggers: ['check'], allowedTools: [], argumentHint: null, version: '1.0.0', author: 'local',
      files: [{ path: 'scripts/run.sh', content: 'echo hi' }],
    },
    {},
    NOW,
  );
  assert.deepEqual(pack.listFiles('with-script'), ['scripts/run.sh']);
  assert.equal(pack.loadAsset('with-script', 'scripts/run.sh').content, 'echo hi');
  assert.equal(pack.loadAsset('with-script', 'nope.sh').ok, false);

  // Matching reads metadata only: trigger hits score 3, name/desc hits 1.
  const matches = pack.match('please review this diff');
  assert.equal(matches[0].name, 'code-review');
  assert.ok(matches[0].score >= 4);
  assert.equal(pack.match('nothing relevant here at all zzz').length, 0);
  assert.equal(pack.match('').length, 0);

  // Budgets refuse bloated skills.
  const longDesc = pack.install({
    name: 'bloated', description: 'x'.repeat(900), body: 'Valid body content here. ' + 'y'.repeat(40),
    triggers: [], allowedTools: [], argumentHint: null, version: '1.0.0', author: 'local', files: [],
  });
  assert.equal(longDesc.ok, false);
  assert.match(longDesc.message, /metadata is/);
  const longBody = pack.install({
    name: 'huge-body', description: 'Short.', body: 'z'.repeat(21000),
    triggers: [], allowedTools: [], argumentHint: null, version: '1.0.0', author: 'local', files: [],
  });
  assert.equal(longBody.ok, false);
  assert.match(longBody.message, /body is/);

  // Checksum is stable + content-sensitive; JSON round-trips.
  const skill = pack.get('code-review');
  assert.ok(skill);
  const sum1 = checksumFleetV26Skill(skill);
  const sum2 = checksumFleetV26Skill({ ...skill, body: skill.body + '!' });
  assert.notEqual(sum1, sum2);
  assert.equal(checksumFleetV26Skill(skill), sum1);
  const restored = FleetV26SkillPack.fromJSON(pack.toJSON());
  assert.equal(restored.listMetadata().length, 2);
  assert.equal(restored.get('with-script')?.files.length, 1);
  assert.equal(pack.remove('with-script'), true);
  assert.equal(pack.get('with-script'), undefined);
  assert.ok(summarizeFleetV26SkillPack(pack).includes('1 skill(s)'));
});
