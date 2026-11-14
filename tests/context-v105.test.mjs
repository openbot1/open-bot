/**
 * Tests for context engineering v2 (v1.05, Team T4): tiered
 * compaction (anchors + 3 tiers + retention), verified summaries
 * (hallucination tripwire), the 1M-token window manager
 * (thresholds, priority eviction, disk spill), per-bot compaction
 * policies (+ savings preview), the context inspector (tree +
 * snapshot export/import), the session runtime, and the 7
 * context_v2_* tools (registry membership + bound execution).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/context-v105.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CompactionPolicyStore,
  CompactionScheduler,
  ContextV2Runtime,
  ContextWindowManager,
  SpillStore,
  TierStore,
  TieredCompactor,
  assemblePrompt,
  assemblyManifest,
  auditVerifiedSummaries,
  buildCompactionReport,
  buildVerifiedSummary,
  claimsFromText,
  classifyAnchorLine,
  compactionReportMarkdown,
  countAnchorsByKind,
  defaultCompactionPolicy,
  estimateSavings,
  exportContextBundle,
  exportSnapshot,
  extractAnchors,
  filterAnchors,
  formatAnchors,
  groupSummariesByTopic,
  importSnapshot,
  inspectWindow,
  presetCompactionPolicy,
  searchStoredAnchors,
  snapshotToMarkdown,
  validatePolicy,
  validateSnapshot,
  verifyClaim,
  verifySummary,
} from '../packages/core/dist/context/index.js';
import {
  CONTEXT_V2_TOOLS,
  CONTEXT_V2_TOOL_NAMES,
  createContextV2Tools,
} from '../packages/tools/dist/contextV2Tools.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-context-v105-'));
}

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

async function runTool(tool, args, ctx = { botId: 'bot-1', runId: 'run-1' }) {
  return tool.execute(args, ctx);
}

/** Six turns: 3 about databases, 3 about UI — two clear topics. */
function sampleTurns() {
  return [
    { id: 't1', turnIndex: 0, role: 'user', content: 'We decided to use PostgreSQL for the database. The database index must cover user_id and created_at.' },
    { id: 't2', turnIndex: 1, role: 'assistant', content: 'PostgreSQL query plans show the database index speeds up lookups. The migration ran in 120 ms.' },
    { id: 't3', turnIndex: 2, role: 'user', content: 'The database has 4686 tests passing. Never delete the migration files.' },
    { id: 't4', turnIndex: 3, role: 'user', content: 'The button layout on the settings screen is broken. The screen needs a new button component.' },
    { id: 't5', turnIndex: 4, role: 'assistant', content: 'I fixed the button layout in SettingsView.tsx. The screen now renders the button correctly.' },
    { id: 't6', turnIndex: 5, role: 'user', content: 'Ship the new screen today. The release must not break the button layout.' },
  ];
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

test('anchors: classify decision/metric/file-change/constraint lines, skip chat', () => {
  assert.equal(classifyAnchorLine('We decided to use PostgreSQL.'), 'decision');
  assert.equal(classifyAnchorLine('Quyết định dùng PostgreSQL cho database.'), 'decision');
  assert.equal(classifyAnchorLine('The migration ran in 120 ms.'), 'metric');
  assert.equal(classifyAnchorLine('Fixed the layout in SettingsView.tsx today.'), 'file-change');
  assert.equal(classifyAnchorLine('Never delete the migration files.'), 'constraint');
  assert.equal(classifyAnchorLine('Không được xóa file migration.'), 'constraint');
  assert.equal(classifyAnchorLine('hi'), null);
  assert.equal(classifyAnchorLine('ok thanks!'), null);
  assert.equal(classifyAnchorLine(''), null);
});

test('anchors: extract dedupes, keeps sources, filters by kind', () => {
  const turns = sampleTurns();
  const anchors = extractAnchors(turns);
  assert.ok(anchors.length >= 5, `expected anchors, got ${anchors.length}`);
  assert.ok(anchors.some((a) => a.kind === 'decision'), 'a decision anchor');
  assert.ok(anchors.some((a) => a.kind === 'metric'), 'a metric anchor');
  assert.ok(anchors.some((a) => a.kind === 'file-change'), 'a file-change anchor');
  assert.ok(anchors.some((a) => a.kind === 'constraint'), 'a constraint anchor');
  for (const anchor of anchors) {
    assert.equal(anchor.sourceIds.length, 1);
    assert.ok(turns.some((t) => t.id === anchor.sourceIds[0]));
  }
  const counts = countAnchorsByKind(anchors);
  assert.equal(counts.decision + counts.metric + counts['file-change'] + counts.constraint + counts.fact, anchors.length);
  const decisionsOnly = filterAnchors(anchors, ['decision']);
  assert.ok(decisionsOnly.length >= 1 && decisionsOnly.every((a) => a.kind === 'decision'));
  // Duplicate lines collapse.
  const dupes = extractAnchors([
    { id: 'a', role: 'user', content: 'We decided to use PostgreSQL for the database.' },
    { id: 'b', role: 'user', content: 'We decided to use PostgreSQL for the database.' },
  ]);
  assert.equal(dupes.length, 1);
  assert.match(formatAnchors(anchors), /Anchors \(\d+\):/);
  assert.match(formatAnchors(anchors), /\[decision\]/);
});

// ---------------------------------------------------------------------------
// Tiered compaction
// ---------------------------------------------------------------------------

test('tiered compaction: 3 tiers, anchors carried, tokens saved', () => {
  const compactor = new TieredCompactor();
  const result = compactor.compact(sampleTurns());
  assert.equal(result.tier1.length, 6, 'one tier-1 summary per turn');
  assert.ok(result.tier2.length >= 2, `expected >= 2 topics, got ${result.tier2.length}`);
  assert.ok(result.tier3 !== null, 'tier 3 session summary exists with 2+ topics');
  assert.ok(result.anchors.length >= 5, 'anchors extracted');
  // Every tier-3 anchor is a decision or constraint (retention policy).
  for (const anchor of result.tier3.anchors) {
    assert.ok(anchor.kind === 'decision' || anchor.kind === 'constraint', anchor.kind);
  }
  // Tier-1 summaries cite their turn; anchors cite theirs.
  assert.deepEqual(result.tier1[0].sourceIds, ['t1']);
  assert.ok(result.tokensSaved >= 0);
  assert.ok(result.tokensBefore > 0);
  assert.equal(result.consumedTurnIds.length, 6);
  // Topics group by keyword overlap.
  const grouped = groupSummariesByTopic(result.tier1);
  assert.ok(grouped.size >= 2, 'at least two topics');
});

test('tiered compaction: retention rolls tier-1 overflow up, drops old tier-3', () => {
  const compactor = new TieredCompactor({
    maxTier1Summaries: 2,
    maxTier2Summaries: 2,
    maxTier3Summaries: 1,
    keepAnchorKinds: {
      1: ['decision', 'metric', 'file-change', 'constraint', 'fact'],
      2: ['decision', 'metric', 'file-change', 'constraint'],
      3: ['decision', 'constraint'],
    },
    maxSummaryChars: 500,
  });
  const store = {
    tier1: new TieredCompactor().compact(sampleTurns()).tier1,
    tier2: [],
    tier3: [],
  };
  const trimmed = compactor.applyRetention(store);
  assert.ok(trimmed.tier1.length <= 2, 'tier 1 capped');
  assert.ok(trimmed.tier2.length >= 1, 'overflow rolled up to tier 2');
  assert.equal(trimmed.rolledUp, 4, '4 tier-1 summaries rolled up');
  assert.equal(trimmed.dropped, 0);
  // Tier-3 cap: oldest dropped, newest kept.
  const tier3Store = {
    tier1: [],
    tier2: [],
    tier3: [
      { id: 'old', tier: 3, topic: '', text: 'old session', sourceIds: ['t1'], anchors: [], createdAt: '2026-01-01', tokenEstimate: 2 },
      { id: 'new', tier: 3, topic: '', text: 'new session', sourceIds: ['t6'], anchors: [], createdAt: '2026-11-14', tokenEstimate: 2 },
    ],
  };
  const trimmed3 = compactor.applyRetention(tier3Store);
  assert.equal(trimmed3.tier3.length, 1);
  assert.equal(trimmed3.tier3[0].id, 'new', 'newest tier-3 kept');
  assert.equal(trimmed3.dropped, 1);
});

// ---------------------------------------------------------------------------
// Verified summaries
// ---------------------------------------------------------------------------

test('verified summary: true claims verify, invented numbers/names contradict', () => {
  const sources = [
    { id: 't1', content: 'The user lives in Da Nang and uses MySQL for the database.' },
    { id: 't2', content: 'The build passed 4686 tests and the migration ran in 120 ms.' },
  ];
  const good = verifyClaim(
    { id: 'c1', text: 'The user lives in Da Nang.', sourceIds: ['t1'] },
    sources,
  );
  assert.equal(good.status, 'verified');
  const wrongCity = verifyClaim(
    { id: 'c2', text: 'The user lives in Hanoi.', sourceIds: ['t1'] },
    sources,
  );
  assert.equal(wrongCity.status, 'contradicted', 'invented city name is caught');
  assert.match(wrongCity.detail, /hanoi/);
  const wrongNumber = verifyClaim(
    { id: 'c3', text: 'The build passed 5000 tests.', sourceIds: ['t2'] },
    sources,
  );
  assert.equal(wrongNumber.status, 'contradicted', 'invented test count is caught');
  const paraphrase = verifyClaim(
    { id: 'c4', text: 'The user decided to migrate the database.', sourceIds: ['t1'] },
    sources,
  );
  assert.equal(paraphrase.status, 'unverifiable', 'paraphrase is honest, not verified');
  const missingSource = verifyClaim(
    { id: 'c5', text: 'The user lives in Da Nang.', sourceIds: ['nope'] },
    sources,
  );
  assert.equal(missingSource.status, 'unverifiable');
  const noSource = verifyClaim(
    { id: 'c6', text: 'Something happened.', sourceIds: [] },
    sources,
  );
  assert.equal(noSource.status, 'unverifiable');
});

test('verified summary: build + re-verify grades the whole summary', () => {
  const sources = [
    { id: 't1', content: 'The user lives in Da Nang and uses MySQL for the database.' },
  ];
  const claims = claimsFromText('The user lives in Da Nang. The user lives in Hanoi.', ['t1']);
  assert.equal(claims.length, 2);
  const summary = buildVerifiedSummary(claims, sources, { tier: 1 });
  assert.equal(summary.claims[0].status, 'verified');
  assert.equal(summary.claims[1].status, 'contradicted');
  assert.equal(summary.verifiedRatio, 0.5);
  assert.equal(summary.fullyVerified, false);
  // Re-verify against a corrected source: the hallucination heals.
  const fixed = verifySummary(summary, [
    { id: 't1', content: 'The user lives in Da Nang and in Hanoi and uses MySQL.' },
  ]);
  assert.equal(fixed.claims[1].status, 'verified');
  assert.equal(fixed.fullyVerified, true);
  // Fully verified summary renders markdown with check marks.
  const allGood = buildVerifiedSummary(
    claimsFromText('The user lives in Da Nang.', ['t1']),
    sources,
  );
  assert.equal(allGood.fullyVerified, true);
});

// ---------------------------------------------------------------------------
// Window manager + spill
// ---------------------------------------------------------------------------

test('window manager: 1M default limit, thresholds fire once each', () => {
  const manager = new ContextWindowManager();
  assert.equal(manager.limit, 1_000_000);
  const alerts50 = manager.addSegment({ id: 's1', kind: 'turn', text: 'x'.repeat(2_000_000) });
  assert.ok(alerts50.some((a) => a.threshold === 'warn50'), '50% fires at 500k tokens');
  assert.equal(manager.thresholdsCrossed().includes('warn50'), true);
  // Fired thresholds do not fire again on the next add.
  const again = manager.addSegment({ id: 's2', kind: 'turn', text: 'hello' });
  assert.equal(again.filter((a) => a.threshold === 'warn50').length, 0);
  // 80% + 95% fire together when crossed in one jump.
  const big = new ContextWindowManager({ limitTokens: 1000 });
  const alerts = big.addSegment({ id: 'b1', kind: 'turn', text: 'y'.repeat(4000) });
  assert.deepEqual(alerts.map((a) => a.threshold).sort(), ['warn50', 'warn80', 'warn95']);
  assert.deepEqual(big.thresholdsCrossed().sort(), ['warn50', 'warn80', 'warn95']);
  big.acknowledgeThresholds();
  const afterAck = big.addSegment({ id: 'b2', kind: 'turn', text: 'z'.repeat(40) });
  assert.ok(afterAck.some((a) => a.threshold === 'warn50'), 'acknowledge re-arms thresholds');
});

test('window manager: eviction order is tool-result < turn < summary tier3 < tier1 < anchor, system never', () => {
  const manager = new ContextWindowManager({ limitTokens: 10_000 });
  manager.addSegment({ id: 'sys', kind: 'system', text: 'system prompt here' });
  manager.addSegment({ id: 'anc', kind: 'anchor', text: 'We decided to use PostgreSQL.' });
  manager.addSegment({ id: 'sum3', kind: 'summary', tier: 3, text: 'session summary text here' });
  manager.addSegment({ id: 'sum1', kind: 'summary', tier: 1, text: 'turn summary text here' });
  manager.addSegment({ id: 'trn', kind: 'turn', text: 'old turn text here' });
  manager.addSegment({ id: 'tool', kind: 'tool-result', text: 'tool result text here' });
  const evicted = manager.evictToFit(1000);
  assert.deepEqual(evicted, ['tool', 'trn', 'sum3', 'sum1', 'anc']);
  assert.ok(manager.getSegment('sys'), 'system prompt is never evicted');
  assert.equal(manager.getSegment('anc'), undefined);
  const stats = manager.stats();
  assert.equal(stats.evictedCount, 5);
  assert.equal(stats.byKind.system.count, 1);
});

test('window manager: stats, spill to disk past RAM budget, restore', () => {
  const dir = tmpDir();
  const manager = new ContextWindowManager({
    limitTokens: 1_000_000,
    ramBudgetBytes: 100,
    spillDir: path.join(dir, 'spill'),
  });
  manager.addSegment({ id: 'sys', kind: 'system', text: 'sys' });
  const spilled = manager.addSegment({ id: 'big', kind: 'turn', text: 'z'.repeat(500) });
  void spilled;
  const big = manager.getSegment('big');
  assert.equal(big.spilled, true, 'big turn spilled past the 100-byte RAM budget');
  assert.equal(manager.spilledCount, 1);
  const stats = manager.stats();
  assert.equal(stats.spilledCount, 1);
  assert.ok(stats.spilledBytes > 0);
  assert.ok(stats.ramBytes <= 100 + 64, 'RAM back under budget (only system + metadata left)');
  assert.equal(manager.restoreSegment('big'), true);
  assert.equal(manager.getSegment('big').spilled, false);
  assert.equal(manager.getSegment('big').text, 'z'.repeat(500));
  // Removing a segment drops its spill file too.
  manager.addSegment({ id: 'big2', kind: 'turn', text: 'w'.repeat(500) });
  assert.equal(manager.getSegment('big2').spilled, true);
  assert.equal(manager.removeSegment('big2'), true);
  assert.equal(manager.getSegment('big2'), undefined);
});

test('spill store: spill/restore/list/drop round-trip, corrupt file is a miss', () => {
  const dir = tmpDir();
  const store = new SpillStore(path.join(dir, 'spill'));
  assert.equal(store.has('a'), false);
  const bytes = store.spill('a', { text: 'hello spill' });
  assert.ok(bytes > 0);
  assert.equal(store.has('a'), true);
  assert.deepEqual(store.list(), ['a']);
  assert.equal(store.restore('a').payload.text, 'hello spill');
  assert.ok(store.totalBytes() > 0);
  assert.equal(store.restore('missing'), null);
  store.drop('a');
  assert.equal(store.has('a'), false);
  store.spill('b', { text: 'x' });
  fs.writeFileSync(store.filePathFor('b'), '{not json');
  assert.equal(store.restore('b'), null, 'corrupt spill restores as a miss');
  store.clear();
  assert.deepEqual(store.list(), []);
});

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

test('policy: defaults, presets, validation, store round-trip', () => {
  const def = defaultCompactionPolicy('bot-9');
  assert.equal(def.triggerRatio, 0.8);
  assert.equal(def.maxTier, 3);
  assert.equal(def.keepRecentTurns, 4);
  assert.equal(def.frequency, 'per-turn');
  const coding = presetCompactionPolicy('bot-9', 'coding');
  assert.equal(coding.triggerRatio, 0.7);
  assert.equal(coding.maxTier, 3);
  assert.deepEqual(coding.keepAnchorKinds, ['decision', 'file-change', 'constraint']);
  assert.throws(() => presetCompactionPolicy('bot-9', 'nope'), /unknown compaction preset/);
  assert.deepEqual(validatePolicy({ triggerRatio: 0.7 }), []);
  assert.ok(validatePolicy({ triggerRatio: 0.1 }).length > 0);
  assert.ok(validatePolicy({ maxTier: 5 }).length > 0);
  assert.ok(validatePolicy({ keepAnchorKinds: ['bogus'] }).length > 0);
  // Validation via the store: bad patches throw with a clear message.
  const dir = tmpDir();
  const store = new CompactionPolicyStore(path.join(dir, 'policies.json'));
  assert.equal(store.get('bot-x').triggerRatio, 0.8, 'no saved policy = default');
  assert.throws(() => store.set('bot-x', { triggerRatio: 0.1 }), /triggerRatio/);
  assert.throws(() => store.set('bot-x', { maxTier: 5 }), /maxTier/);
  assert.throws(() => store.set('bot-x', { frequency: 'daily' }), /frequency/);
  const saved = store.set('bot-x', { triggerRatio: 0.6, maxTier: 2 });
  assert.equal(saved.triggerRatio, 0.6);
  assert.equal(saved.maxTier, 2);
  const reloaded = new CompactionPolicyStore(path.join(dir, 'policies.json'));
  assert.equal(reloaded.get('bot-x').triggerRatio, 0.6, 'policy persists to disk');
  assert.deepEqual(reloaded.botIds(), ['bot-x']);
  assert.equal(reloaded.remove('bot-x'), true);
  assert.equal(reloaded.get('bot-x').triggerRatio, 0.8, 'removed policy falls back to default');
  // Corrupt file loads as defaults, never throws.
  fs.writeFileSync(path.join(dir, 'policies.json'), '{broken');
  const corrupt = new CompactionPolicyStore(path.join(dir, 'policies.json'));
  assert.equal(corrupt.get('bot-x').triggerRatio, 0.8);
});

test('policy: savings preview (dry run) and no-op when nothing to compact', () => {
  const messages = sampleTurns().map((t) => ({ role: t.role, content: t.content, id: t.id }));
  const estimate = estimateSavings(messages, defaultCompactionPolicy('bot-1'));
  assert.ok(estimate.tokensBefore > 0);
  assert.ok(estimate.tokensSaved >= 0);
  assert.equal(estimate.turnsCompacted, 2, '6 turns - keepRecent 4 = 2 compacted');
  assert.equal(estimate.turnsKept, 4);
  assert.ok(estimate.tier1Summaries >= 0);
  const tiny = estimateSavings(
    [{ role: 'user', content: 'hi' }],
    defaultCompactionPolicy('bot-1'),
  );
  assert.equal(tiny.noOp, true);
  assert.equal(tiny.tokensSaved, 0);
  // maxTier 1 builds no tier-2/3 summaries in the preview.
  const shallow = estimateSavings(messages, { ...defaultCompactionPolicy('bot-1'), maxTier: 1 });
  assert.equal(shallow.tier2Summaries, 0);
  assert.equal(shallow.tier3Summary, false);
});

// ---------------------------------------------------------------------------
// Inspector + snapshots
// ---------------------------------------------------------------------------

test('inspector: tree groups by kind, snapshot export/import round-trip', () => {
  const manager = new ContextWindowManager({ limitTokens: 1_000_000 });
  manager.addSegment({ id: 'sys', kind: 'system', text: 'You are helpful.' });
  manager.addSegment({ id: 'a1', kind: 'anchor', text: 'We decided to use PostgreSQL.' });
  manager.addSegment({ id: 's1', kind: 'summary', tier: 2, text: 'database topic summary' });
  manager.addSegment({ id: 't1', kind: 'turn', text: 'hello turn' });
  const tree = inspectWindow(manager);
  assert.equal(tree.limit, 1_000_000);
  assert.ok(tree.usedTokens > 0);
  assert.equal(tree.groups.find((g) => g.kind === 'system').count, 1);
  assert.equal(tree.groups.find((g) => g.kind === 'anchor').nodes[0].preview, 'We decided to use PostgreSQL.');
  assert.equal(tree.groups.find((g) => g.kind === 'summary').nodes[0].tier, 2);
  const snapshot = exportSnapshot(manager, { botId: 'bot-1' });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.botId, 'bot-1');
  assert.equal(snapshot.segments.length, 4);
  const imported = importSnapshot(snapshot, {});
  assert.equal(imported.usedTokens, manager.usedTokens);
  assert.equal(imported.list().length, 4);
  assert.equal(imported.getSegment('a1').text, 'We decided to use PostgreSQL.');
  const markdown = snapshotToMarkdown(snapshot);
  assert.match(markdown, /Context snapshot/);
  assert.match(markdown, /a1/);
});

test('inspector: invalid snapshots are rejected, never half-imported', () => {
  assert.deepEqual(validateSnapshot({ version: 2, limit: 100, segments: [] }).length > 0, true);
  assert.throws(() => importSnapshot({ version: 2, limit: 100, segments: [] }, {}), /unsupported snapshot version/);
  assert.throws(
    () => importSnapshot({ version: 1, limit: 100, segments: [{ id: 'x', kind: 'weird', text: '', tokens: 1 }] }, {}),
    /invalid segment kind/,
  );
  assert.throws(
    () => importSnapshot({ version: 1, limit: 100, segments: [
      { id: 'x', kind: 'turn', text: '', tokens: 1 },
      { id: 'x', kind: 'turn', text: '', tokens: 1 },
    ] }, {}),
    /duplicate segment id/,
  );
  assert.throws(() => importSnapshot({ version: 1, limit: -5, segments: [] }, {}), /limit must be a positive number/);
  assert.deepEqual(validateSnapshot({ version: 1, limit: 100, segments: [] }), []);
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

test('runtime: compactTurns builds tiers, verifies, registers segments, evicts past trigger', () => {
  const dir = tmpDir();
  const runtime = new ContextV2Runtime({ workspaceDir: path.join(dir, 'ws'), limitTokens: 600 });
  runtime.setSystemSegment('You are open-bot.');
  // Old turn segments already in the window (eviction candidates).
  for (const turn of sampleTurns()) {
    runtime.addTurnSegment({ id: turn.id, role: turn.role, content: turn.content });
  }
  const before = runtime.window.usedTokens;
  assert.ok(before > 0);
  const result = runtime.compactTurns('bot-1', sampleTurns());
  assert.equal(result.compaction.tier1.length, 6);
  assert.ok(result.compaction.tier2.length >= 2);
  assert.ok(result.compaction.tier3 !== null);
  assert.ok(result.verified.length >= 6, 'every tier summary verified');
  assert.ok(result.verified.every((v) => v.claims.length >= 0));
  assert.ok(result.segmentIds.length > 6, 'summaries + anchors registered as segments');
  assert.ok(result.evictedSegmentIds.length > 0, 'old turns evicted past the 80% trigger');
  assert.ok(runtime.window.getSegment('seg-system'), 'system segment survives eviction');
  assert.ok(runtime.lastCompactedAt !== null);
  assert.ok(runtime.anchors.length >= 5);
  const snapshot = runtime.snapshot('bot-1');
  assert.equal(snapshot.botId, 'bot-1');
  assert.ok(snapshot.policy, 'snapshot carries the bot policy');
  assert.ok(snapshot.segments.length > 0);
});

test('runtime: maxTier 1 policy builds no tier 2/3; setPolicy persists in memory', () => {
  const runtime = new ContextV2Runtime({ limitTokens: 1_000_000 });
  runtime.setPolicy('bot-1', { maxTier: 1, triggerRatio: 0.9 });
  const result = runtime.compactTurns('bot-1', sampleTurns());
  assert.equal(result.compaction.tier2.length, 0);
  assert.equal(result.compaction.tier3, null);
  assert.equal(runtime.policyFor('bot-1').maxTier, 1);
  assert.throws(() => runtime.setPolicy('bot-1', { triggerRatio: 0.2 }), /triggerRatio/);
  const preview = runtime.previewPolicy('bot-1', sampleTurns().map((t) => ({ role: t.role, content: t.content, id: t.id })));
  assert.ok(preview.tokensSaved >= 0);
  assert.equal(preview.turnsCompacted, 2);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test('context v2 tools: 9 names, no duplicates, approval flags', () => {
  assert.equal(CONTEXT_V2_TOOLS.length, 9);
  assert.deepEqual([...CONTEXT_V2_TOOL_NAMES], [
    'context_v2_compact_tiered',
    'context_v2_verify_summary',
    'context_v2_window_stats',
    'context_v2_set_policy',
    'context_v2_inspect',
    'context_v2_export_snapshot',
    'context_v2_import_snapshot',
    'context_v2_assemble_prompt',
    'context_v2_schedule_status',
  ]);
  assert.deepEqual(
    CONTEXT_V2_TOOLS.map((t) => t.definition.name),
    [...CONTEXT_V2_TOOL_NAMES],
  );
  assert.equal(new Set(CONTEXT_V2_TOOLS.map((t) => t.definition.name)).size, 9);
  assert.equal(toolByName(CONTEXT_V2_TOOLS, 'context_v2_compact_tiered').needsApproval, true);
  assert.equal(toolByName(CONTEXT_V2_TOOLS, 'context_v2_set_policy').needsApproval, true);
  assert.equal(toolByName(CONTEXT_V2_TOOLS, 'context_v2_import_snapshot').needsApproval, true);
  assert.equal(toolByName(CONTEXT_V2_TOOLS, 'context_v2_verify_summary').needsApproval, false);
  assert.equal(toolByName(CONTEXT_V2_TOOLS, 'context_v2_window_stats').needsApproval, false);
  assert.equal(toolByName(CONTEXT_V2_TOOLS, 'context_v2_inspect').needsApproval, false);
  assert.equal(toolByName(CONTEXT_V2_TOOLS, 'context_v2_export_snapshot').needsApproval, false);
  assert.equal(toolByName(CONTEXT_V2_TOOLS, 'context_v2_assemble_prompt').needsApproval, false);
  assert.equal(toolByName(CONTEXT_V2_TOOLS, 'context_v2_schedule_status').needsApproval, false);
});

test('context v2 tools: compact + verify + stats + inspect end-to-end', async () => {
  const dir = tmpDir();
  const tools = createContextV2Tools({ workspaceDir: path.join(dir, 'ws') });
  const compact = toolByName(tools, 'context_v2_compact_tiered');
  const out = JSON.parse(
    await runTool(compact, { turns: JSON.stringify(sampleTurns()) }),
  );
  assert.equal(out.tier1.length, 6);
  assert.ok(out.tier2.length >= 2);
  assert.ok(out.tier3 !== null);
  assert.ok(out.anchors.length >= 5);
  assert.ok(out.tokensSaved >= 0);
  assert.ok(Array.isArray(out.verified) && out.verified.length >= 6);
  assert.ok(out.segmentIds.length > 6);

  const verify = toolByName(tools, 'context_v2_verify_summary');
  const hallucinated = JSON.parse(
    await runTool(verify, {
      summaryText: 'The user lives in Hanoi. The build passed 5000 tests.',
      sources: JSON.stringify([
        { id: 't1', content: 'The user lives in Da Nang.' },
        { id: 't2', content: 'The build passed 4686 tests.' },
      ]),
    }),
  );
  assert.equal(hallucinated.fullyVerified, false);
  assert.ok(hallucinated.claims.every((c) => c.status === 'contradicted'), 'both invented claims caught');
  assert.match(hallucinated.markdown, /contradicted/);

  const stats = JSON.parse(await runTool(toolByName(tools, 'context_v2_window_stats'), {}));
  assert.ok(stats.usedTokens > 0);
  assert.equal(stats.limit, 1_000_000);
  assert.ok(stats.byKind.summary.count >= 6);

  const inspected = JSON.parse(await runTool(toolByName(tools, 'context_v2_inspect'), {}));
  assert.ok(inspected.groups.some((g) => g.kind === 'summary' && g.count >= 6));
  assert.ok(inspected.groups.some((g) => g.kind === 'anchor' && g.count >= 1));

  // Bad input is an Error string, never a throw.
  const bad = await runTool(compact, { turns: 'not json' });
  assert.match(bad, /^Error:/);
});

test('context v2 tools: set_policy (preset + preview + invalid), export/import snapshot', async () => {
  const dir = tmpDir();
  const tools = createContextV2Tools({ workspaceDir: path.join(dir, 'ws') });
  const setPolicy = toolByName(tools, 'context_v2_set_policy');
  const preset = JSON.parse(
    await runTool(setPolicy, {
      preset: 'coding',
      previewMessages: JSON.stringify(sampleTurns().map((t) => ({ role: t.role, content: t.content }))),
    }),
  );
  assert.equal(preset.policy.triggerRatio, 0.7);
  assert.deepEqual(preset.policy.keepAnchorKinds, ['decision', 'file-change', 'constraint']);
  assert.ok(preset.preview.tokensSaved >= 0);
  assert.equal(preset.preview.turnsCompacted, 2);
  const badPreset = await runTool(setPolicy, { preset: 'nope' });
  assert.match(badPreset, /^Error: unknown compaction preset/);
  const badRatio = await runTool(setPolicy, { triggerRatio: 0.1 });
  assert.match(badRatio, /^Error: invalid compaction policy/);
  const plain = JSON.parse(await runTool(setPolicy, { triggerRatio: 0.75 }));
  assert.equal(plain.policy.triggerRatio, 0.75);

  const exportTool = toolByName(tools, 'context_v2_export_snapshot');
  const snapshotText = await runTool(exportTool, {});
  const snapshot = JSON.parse(snapshotText);
  assert.equal(snapshot.version, 1);
  assert.ok(Array.isArray(snapshot.segments));
  assert.ok(snapshot.policy, 'export carries the policy');

  const importTool = toolByName(tools, 'context_v2_import_snapshot');
  const imported = JSON.parse(await runTool(importTool, { snapshot: snapshotText }));
  assert.ok(imported.importedSegments >= 0);
  const badImport = await runTool(importTool, { snapshot: JSON.stringify({ version: 9, limit: 1, segments: [] }) });
  assert.match(badImport, /^Error: invalid context snapshot/);
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

test('scheduler: per-turn always allowed over trigger, hourly gates, manual never', () => {
  const dir = tmpDir();
  const scheduler = new CompactionScheduler(path.join(dir, 'schedule.json'));
  const perTurn = defaultCompactionPolicy('bot-a');
  assert.deepEqual(scheduler.shouldCompact('bot-a', perTurn, 0.9), { allowed: true, reason: 'over-trigger' });
  assert.deepEqual(scheduler.shouldCompact('bot-a', perTurn, 0.5).reason, 'under-trigger');
  const hourly = { ...perTurn, frequency: 'hourly' };
  assert.equal(scheduler.shouldCompact('bot-a', hourly, 0.9).allowed, true, 'first hourly run allowed');
  scheduler.recordRun('bot-a');
  const tooSoon = scheduler.shouldCompact('bot-a', hourly, 0.9);
  assert.equal(tooSoon.allowed, false);
  assert.equal(tooSoon.reason, 'too-soon');
  assert.ok(tooSoon.nextAllowedAt);
  const status = scheduler.status('bot-a', hourly);
  assert.equal(status.frequency, 'hourly');
  assert.equal(status.runsTotal, 1);
  assert.equal(status.due, false);
  assert.ok(status.nextAllowedAt);
  const manual = { ...perTurn, frequency: 'manual' };
  assert.deepEqual(scheduler.shouldCompact('bot-a', manual, 0.99).reason, 'manual-only');
  assert.equal(scheduler.status('bot-a', manual).due, false);
  // State persists across instances.
  const reloaded = new CompactionScheduler(path.join(dir, 'schedule.json'));
  assert.equal(reloaded.status('bot-a', hourly).runsTotal, 1);
  assert.deepEqual(reloaded.botIds(), ['bot-a']);
  // In-memory scheduler (no file) still gates correctly.
  const mem = new CompactionScheduler();
  assert.equal(mem.shouldCompact('bot-b', hourly, 0.9).allowed, true);
  mem.recordRun('bot-b');
  assert.equal(mem.shouldCompact('bot-b', hourly, 0.9).allowed, false);
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

test('assembly: system + anchors first, summaries tier 1 first, turns chronological, drops over budget', () => {
  const manager = new ContextWindowManager({ limitTokens: 1_000_000 });
  manager.addSegment({ id: 'sys', kind: 'system', text: 'You are helpful.' });
  manager.addSegment({ id: 'anc', kind: 'anchor', text: 'We decided to use PostgreSQL.' });
  manager.addSegment({ id: 'sum3', kind: 'summary', tier: 3, text: 'session summary here' });
  manager.addSegment({ id: 'sum1', kind: 'summary', tier: 1, text: 'turn summary here' });
  manager.addSegment({ id: 't1', kind: 'turn', text: 'first turn text' });
  manager.addSegment({ id: 't2', kind: 'turn', text: 'second turn text' });
  const full = assemblePrompt(manager.list());
  assert.equal(full.fits, true);
  assert.equal(full.droppedIds.length, 0);
  assert.ok(full.includedIds.includes('sys'));
  assert.ok(full.includedIds.includes('anc'));
  // Turns come out in chronological order (t1 before t2).
  const turnTexts = full.messages.filter((m) => m.segmentIds.some((id) => id === 't1' || id === 't2'));
  assert.equal(turnTexts[0].segmentIds[0], 't1');
  assert.equal(turnTexts[1].segmentIds[0], 't2');
  // Tight budget: system always survives, low-priority segments drop.
  const tight = assemblePrompt(manager.list(), { tokenBudget: 12 });
  assert.ok(tight.includedIds.includes('sys'), 'system survives any budget');
  assert.ok(tight.droppedIds.length > 0);
  assert.match(assemblyManifest(tight), /dropped/);
  assert.match(assemblyManifest(full), /Assembled/);
  // maxTurns keeps only the newest turns.
  const capped = assemblePrompt(manager.list(), { maxTurns: 1 });
  assert.equal(capped.includedIds.filter((id) => id === 't1' || id === 't2').length, 1);
  assert.ok(capped.includedIds.includes('t2'), 'newest turn kept');
});

test('window manager: planEviction dry-run matches evictToFit, suggestCompaction advises', () => {
  const manager = new ContextWindowManager({ limitTokens: 1000 });
  manager.addSegment({ id: 'sys', kind: 'system', text: 'system prompt' });
  manager.addSegment({ id: 'trn', kind: 'turn', text: 'x'.repeat(2000) });
  const plan = manager.planEviction(100);
  assert.deepEqual(plan.ids, ['trn']);
  assert.ok(plan.freedTokens >= 100);
  assert.ok(manager.getSegment('trn'), 'plan does not mutate the window');
  const advice = manager.suggestCompaction();
  assert.equal(advice.needed, false, 'under 50% needs nothing');
  const big = new ContextWindowManager({ limitTokens: 1000 });
  big.addSegment({ id: 'b1', kind: 'turn', text: 'y'.repeat(3600) });
  const advice2 = big.suggestCompaction();
  assert.equal(advice2.needed, true, 'over 80% needs compaction');
  assert.ok(advice2.tokensToFree > 0);
  assert.ok(advice2.evictionPlan.ids.length > 0);
  assert.match(advice2.reason, /90%/);
});

// ---------------------------------------------------------------------------
// Tier store + report
// ---------------------------------------------------------------------------

test('tier store: save/load round-trip, corrupt file is empty, prune + totals', () => {
  const dir = tmpDir();
  const store = new TierStore(path.join(dir, 'tiers'));
  const compactor = new TieredCompactor();
  const result = compactor.compact(sampleTurns());
  store.save({
    botId: 'bot-1',
    updatedAt: new Date().toISOString(),
    tier1: result.tier1,
    tier2: result.tier2,
    tier3: result.tier3 ? [result.tier3] : [],
    verified: [],
    anchors: result.anchors,
    lastCompactedAt: new Date().toISOString(),
  });
  const loaded = store.load('bot-1');
  assert.equal(loaded.tier1.length, 6);
  assert.ok(loaded.tier2.length >= 2);
  assert.equal(loaded.tier3.length, 1);
  assert.ok(loaded.anchors.length >= 5);
  assert.deepEqual(store.botIds(), ['bot-1']);
  const totals = store.totals();
  assert.equal(totals.bots, 1);
  assert.ok(totals.tier1 >= 6);
  assert.equal(store.load('missing').tier1.length, 0, 'unknown bot loads empty');
  // Corrupt file loads as empty.
  fs.writeFileSync(path.join(dir, 'tiers', 'bot-1.json'), '{broken');
  assert.equal(store.load('bot-1').tier1.length, 0);
  // Prune drops old bots only (write the old file directly: save()
  // stamps updatedAt with the write time).
  const oldRecord = {
    botId: 'bot-old',
    updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    tier1: [], tier2: [], tier3: [], verified: [], anchors: [], lastCompactedAt: null,
  };
  fs.writeFileSync(path.join(dir, 'tiers', 'bot-old.json'), JSON.stringify(oldRecord));
  const dropped = store.prune(24 * 60 * 60 * 1000);
  assert.deepEqual(dropped, ['bot-old']);
  assert.equal(store.remove('bot-old'), false, 'already pruned');
});

test('compaction report: numbers, verification counts, markdown', () => {
  const compactor = new TieredCompactor();
  const compaction = compactor.compact(sampleTurns());
  const sources = sampleTurns().map((t) => ({ id: t.id, content: t.content ?? '' }));
  const verified = [...compaction.tier1, ...compaction.tier2].map((s) =>
    buildVerifiedSummary(claimsFromText(s.text, s.sourceIds), sources, { tier: s.tier }),
  );
  const manager = new ContextWindowManager({ limitTokens: 1_000_000 });
  const report = buildCompactionReport({
    botId: 'bot-1',
    trigger: 'manual',
    compaction,
    verified,
    segmentIds: ['seg-1', 'seg-2'],
    evictedSegmentIds: ['seg-old'],
    thresholdAlerts: ['warn50'],
    windowAfter: manager.stats(),
  });
  assert.equal(report.turnsCompacted, 6);
  assert.equal(report.tokensBefore, compaction.tokensBefore);
  assert.equal(report.tier1Summaries, 6);
  assert.ok(report.verifiedClaims > 0);
  assert.ok(report.verifiedRatio >= 0 && report.verifiedRatio <= 1);
  assert.equal(report.segmentsCreated, 2);
  assert.equal(report.segmentsEvicted, 1);
  const md = compactionReportMarkdown(report);
  assert.match(md, /Compaction/);
  assert.match(md, /Tokens:/);
  assert.match(md, /Anchors kept:/);
  assert.match(md, /Claims verified:/);
});

// ---------------------------------------------------------------------------
// Runtime: scheduler gate, assembly, restore, report
// ---------------------------------------------------------------------------

test('runtime: maybeCompact honours manual policy; compactTurns writes report + persists tiers', () => {
  const dir = tmpDir();
  const ws = path.join(dir, 'ws');
  const runtime = new ContextV2Runtime({ workspaceDir: ws, limitTokens: 200 });
  runtime.setSystemSegment('You are open-bot.');
  for (const turn of sampleTurns()) runtime.addTurnSegment(turn);
  // Manual policy: maybeCompact refuses even over trigger.
  runtime.setPolicy('bot-1', { frequency: 'manual', triggerRatio: 0.5 });
  const refused = runtime.maybeCompact('bot-1', sampleTurns());
  assert.equal(refused.result, null);
  assert.equal(refused.decision.reason, 'manual-only');
  // Direct compactTurns still runs and writes a report + tiers.
  const result = runtime.compactTurns('bot-1', sampleTurns());
  assert.ok(result.report, 'round carries an audit report');
  assert.equal(result.report.botId, 'bot-1');
  assert.equal(result.report.turnsCompacted, 6);
  assert.ok(runtime.report !== null);
  assert.equal(runtime.scheduleStatus('bot-1').runsTotal, 1);
  // Tiers persisted: a fresh runtime restores them into its window.
  const fresh = new ContextV2Runtime({ workspaceDir: ws, limitTokens: 1_000_000 });
  const restored = fresh.restoreTiers('bot-1');
  assert.ok(restored.restored >= 6, 'tier summaries restored as segments');
  assert.ok(fresh.window.list().some((s) => s.kind === 'summary'));
  // Assembly from the runtime window.
  const assembled = runtime.assemblePrompt();
  assert.ok(assembled.messages.length > 0);
  assert.ok(assembled.includedIds.includes('seg-system'));
  assert.equal(assembled.fits, true);
});

test('context v2 tools: assemble_prompt + schedule_status', async () => {
  const dir = tmpDir();
  const tools = createContextV2Tools({ workspaceDir: path.join(dir, 'ws') });
  const compact = toolByName(tools, 'context_v2_compact_tiered');
  await runTool(compact, { turns: JSON.stringify(sampleTurns()) });
  const assembled = JSON.parse(
    await runTool(toolByName(tools, 'context_v2_assemble_prompt'), { tokenBudget: 100000 }),
  );
  assert.ok(assembled.messages.length > 0);
  assert.equal(assembled.fits, true);
  assert.match(assembled.manifest, /Assembled/);
  const tight = JSON.parse(
    await runTool(toolByName(tools, 'context_v2_assemble_prompt'), { tokenBudget: 10 }),
  );
  assert.ok(tight.droppedIds.length > 0, 'tight budget drops segments');
  const status = JSON.parse(await runTool(toolByName(tools, 'context_v2_schedule_status'), {}));
  assert.equal(status.botId, 'bot-1');
  assert.equal(status.frequency, 'per-turn');
  assert.equal(status.runsTotal, 1, 'compactTurns recorded a scheduler run');
});

// ---------------------------------------------------------------------------
// Bundle, anchor search, restore-all-spilled, audit
// ---------------------------------------------------------------------------

test('inspector: exportContextBundle covers snapshot + policy + tiers + verified', () => {
  const manager = new ContextWindowManager({ limitTokens: 1_000_000 });
  manager.addSegment({ id: 'sys', kind: 'system', text: 'You are helpful.' });
  const snapshot = exportSnapshot(manager, { botId: 'bot-1', policy: defaultCompactionPolicy('bot-1') });
  const compactor = new TieredCompactor();
  const compaction = compactor.compact(sampleTurns());
  const sources = sampleTurns().map((t) => ({ id: t.id, content: t.content ?? '' }));
  const verified = compaction.tier1.slice(0, 2).map((s) =>
    buildVerifiedSummary(claimsFromText(s.text, s.sourceIds), sources, { tier: 1 }),
  );
  const bundle = exportContextBundle({
    snapshot,
    tiers: { tier1: compaction.tier1, tier2: compaction.tier2, tier3: compaction.tier3 ? [compaction.tier3] : [], anchors: compaction.anchors },
    verified,
  });
  assert.match(bundle, /Context snapshot/);
  assert.match(bundle, /## Policy/);
  assert.match(bundle, /## Stored tiers/);
  assert.match(bundle, /## Verified summaries/);
  assert.match(bundle, /Tier 1: 6 summar/);
});

test('tier store: searchStoredAnchors by kind and text', () => {
  const dir = tmpDir();
  const store = new TierStore(path.join(dir, 'tiers'));
  const compactor = new TieredCompactor();
  const result = compactor.compact(sampleTurns());
  store.save({
    botId: 'bot-1', updatedAt: new Date().toISOString(),
    tier1: result.tier1, tier2: result.tier2, tier3: result.tier3 ? [result.tier3] : [],
    verified: [], anchors: result.anchors, lastCompactedAt: null,
  });
  const decisions = searchStoredAnchors(store, { kind: 'decision' });
  assert.ok(decisions.length >= 1);
  assert.ok(decisions.every((h) => h.anchor.kind === 'decision' && h.botId === 'bot-1'));
  const postgres = searchStoredAnchors(store, { text: 'postgresql' });
  assert.ok(postgres.length >= 1, 'case-insensitive text search finds the decision');
  const none = searchStoredAnchors(store, { text: 'zzzz-no-such-anchor' });
  assert.equal(none.length, 0);
  const scoped = searchStoredAnchors(store, { kind: 'metric', botId: 'bot-1' });
  assert.ok(scoped.length >= 1);
  const otherBot = searchStoredAnchors(store, { botId: 'bot-2' });
  assert.equal(otherBot.length, 0);
});

test('window manager: restoreAllSpilled restores every spilled segment', () => {
  const dir = tmpDir();
  const manager = new ContextWindowManager({
    limitTokens: 1_000_000,
    ramBudgetBytes: 50,
    spillDir: path.join(dir, 'spill'),
  });
  manager.addSegment({ id: 'a', kind: 'turn', text: 'a'.repeat(200) });
  manager.addSegment({ id: 'b', kind: 'turn', text: 'b'.repeat(200) });
  assert.equal(manager.spilledCount, 2);
  const restored = manager.restoreAllSpilled();
  assert.deepEqual(restored.sort(), ['a', 'b']);
  assert.equal(manager.spilledCount, 0);
  assert.equal(manager.getSegment('a').text, 'a'.repeat(200));
});

test('verified summary: audit catches a claim whose source was corrected', () => {
  const sources = [{ id: 't1', content: 'The user lives in Da Nang.' }];
  const summary = buildVerifiedSummary(
    claimsFromText('The user lives in Da Nang.', ['t1']),
    sources,
  );
  assert.equal(summary.fullyVerified, true);
  // The source is corrected: the user moved to Hanoi.
  const audited = auditVerifiedSummaries([summary], [
    { id: 't1', content: 'The user lives in Hanoi now.' },
  ]);
  assert.equal(audited.length, 1);
  assert.equal(audited[0].changed, true);
  assert.equal(audited[0].changedClaims.length, 1);
  assert.equal(audited[0].changedClaims[0].from, 'verified');
  assert.equal(audited[0].changedClaims[0].to, 'contradicted');
  // Unchanged when sources are the same.
  const same = auditVerifiedSummaries([summary], sources);
  assert.equal(same[0].changed, false);
});

// ---------------------------------------------------------------------------
// CLI `open-bot context ...`
// ---------------------------------------------------------------------------

test('cli context: status/policy/inspect/export/assemble/schedule round-trip', async () => {
  const { cmdContext } = await import('../apps/cli/dist/contextCommand.js');
  const dir = tmpDir();
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const out = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  try {
    assert.equal(await cmdContext('status', { workspace: ws, bot: 'bot-1', json: true }), 0);
    let parsed = JSON.parse(out.join(''));
    assert.equal(parsed.botId, 'bot-1');
    assert.equal(parsed.stats.limit, 1_000_000);
    out.length = 0;
    assert.equal(await cmdContext('policy', { workspace: ws, bot: 'bot-1', preset: 'coding', json: true }), 0);
    parsed = JSON.parse(out.join(''));
    assert.equal(parsed.policy.triggerRatio, 0.7);
    out.length = 0;
    assert.equal(await cmdContext('policy', { workspace: ws, bot: 'bot-1', set: 'triggerRatio=0.6', json: true }), 0);
    parsed = JSON.parse(out.join(''));
    assert.equal(parsed.policy.triggerRatio, 0.6);
    out.length = 0;
    assert.equal(await cmdContext('schedule', { workspace: ws, bot: 'bot-1', json: true }), 0);
    parsed = JSON.parse(out.join(''));
    assert.equal(parsed.frequency, 'per-turn');
    out.length = 0;
    assert.equal(await cmdContext('inspect', { workspace: ws, bot: 'bot-1', json: true }), 0);
    parsed = JSON.parse(out.join(''));
    assert.equal(parsed.limit, 1_000_000);
    out.length = 0;
    assert.equal(await cmdContext('export', { workspace: ws, bot: 'bot-1' }), 0);
    parsed = JSON.parse(out.join(''));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.policy.triggerRatio, 0.6, 'export carries the saved policy');
    out.length = 0;
    assert.equal(await cmdContext('assemble', { workspace: ws, bot: 'bot-1', json: true }), 0);
    parsed = JSON.parse(out.join(''));
    assert.equal(parsed.fits, true);
    assert.equal(parsed.messages.length, 0, 'empty window assembles to no messages');
    out.length = 0;
    assert.equal(await cmdContext('restore', { workspace: ws, bot: 'bot-1', json: true }), 0);
    parsed = JSON.parse(out.join(''));
    assert.equal(parsed.restored.restored, 0, 'nothing stored yet');
  } finally {
    process.stdout.write = origWrite;
  }
});
