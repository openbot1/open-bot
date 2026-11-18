/**
 * Composio v114 tests (v1.14, Doi T4 — node:test, no network, no key).
 *
 * Covers:
 * - Mock toolkits v114: 6 toolkits (webflow/pipedrive/chargebee/xero/
 *   eventbrite/surveymonkey), 10 candidate slugs each, none overlapping
 *   the 40 live toolkits or the v110/v111/v112 mock toolkits; every
 *   toolkit is mockOnly + not live-verified and carries authKind +
 *   authNote; mock executor deterministic, echo args, mock:true/live:false
 * - Poll scheduler v2: per-connection schedules (per-toolkit default
 *   intervals), backoff on error (exponential, capped), dedupe
 *   (window + cap), checkpoint serialize/parse/resume after restart,
 *   engine tick (due only, per-schedule errors isolated)
 * - Trigger templates v2: 35 templates (29 curated + 6 candidate),
 *   every curated slug in COMPOSIO_TRIGGER_DEFS, every required
 *   field present in the example payload, search/filter helpers
 * - Connection health: record success/error, error-rate + stale +
 *   slow + expiring/expired rules, store serialize round-trip,
 *   dashboard summary
 * - MCP bridge: 60 MCP Apps (ui://composio/...), static safe HTML,
 *   task create/run/cancel, task store round-trip
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v114.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_V114_MOCK_TOOLKITS,
  MockComposioV114Executor,
  createMockComposioV114AppDefinitions,
  executeMockComposioV114Tool,
  findMockComposioV114Toolkit,
  isMockComposioV114Slug,
  mockComposioV114AppId,
  mockComposioV114DeterministicId,
  mockComposioV114Slugs,
  mockComposioV114ToolNeedsApproval,
  summarizeMockComposioV114Catalogue,
} from '../packages/core/dist/composio/toolkitsV114.js';
import { COMPOSIO_TOOLKIT_SLUGS } from '../packages/core/dist/composio/toolkits.js';
import { COMPOSIO_V110_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV110.js';
import { COMPOSIO_V111_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV111.js';
import { COMPOSIO_V112_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV112.js';
import { COMPOSIO_TRIGGER_DEFS } from '../packages/core/dist/composio/triggers.js';
import {
  COMPOSIO_V114_DEFAULT_DEDUPE_WINDOW_MS,
  COMPOSIO_V114_DEFAULT_MAX_BACKOFF_MS,
  ComposioV114PollEngine,
  applyComposioV114Jitter,
  checkpointComposioV114Schedule,
  composioV114BackoffDelayMs,
  composioV114MsUntilNextPoll,
  createComposioV114Schedule,
  defaultComposioV114IntervalMs,
  filterComposioV114NewItems,
  isComposioV114Duplicate,
  isComposioV114ScheduleDue,
  missedComposioV114Polls,
  nextComposioV114PollAfterError,
  nextComposioV114PollAfterSuccess,
  parseComposioV114Checkpoint,
  pruneComposioV114SeenIds,
  recordComposioV114SeenIds,
  resumeComposioV114Schedule,
  serializeComposioV114Checkpoint,
  validateComposioV114Schedule,
} from '../packages/core/dist/composio/pollSchedulerV2.js';
import {
  COMPOSIO_V114_TRIGGER_TEMPLATES,
  COMPOSIO_V114_TRIGGER_TEMPLATE_COUNT,
  composioV114TemplateToMappingInput,
  composioV114TemplatesForCategory,
  composioV114TemplatesForToolkit,
  findComposioV114TriggerTemplate,
  renderComposioV114ExamplePayload,
  searchComposioV114TriggerTemplates,
  validateComposioV114TriggerTemplates,
} from '../packages/core/dist/composio/triggerTemplatesV114.js';
import {
  COMPOSIO_V114_MAX_LATENCY_SAMPLES,
  ComposioV114HealthStore,
  DEFAULT_COMPOSIO_V114_HEALTH_THRESHOLDS,
  averageComposioV114Latency,
  emptyComposioV114ConnectionHealth,
  evaluateComposioV114Health,
  percentileComposioV114Latency,
  recordComposioV114SyncError,
  recordComposioV114SyncSuccess,
  setComposioV114ConnectionExpiry,
  summarizeComposioV114HealthDashboard,
} from '../packages/core/dist/composio/connectionHealth.js';
import {
  COMPOSIO_V114_MCP_APP_COUNT,
  COMPOSIO_V114_MCP_APP_SERVER_ID,
  ComposioV114McpTaskStore,
  cancelComposioV114McpTask,
  composioV114McpAppId,
  composioV114McpAppUri,
  createComposioV114McpApp,
  createComposioV114McpTask,
  executeMockComposioV114ToolViaApp,
  findComposioV114McpApp,
  isComposioV114McpAppUri,
  listComposioV114McpApps,
  parseComposioV114McpAppUri,
  renderComposioV114McpAppHtml,
  runComposioV114McpTask,
  summarizeComposioV114McpTask,
  validateComposioV114McpAppHtml,
} from '../packages/core/dist/composio/mcpComposioBridge.js';

const EXPECTED_SLUGS = ['webflow', 'pipedrive', 'chargebee', 'xero', 'eventbrite', 'surveymonkey'];
const NO_JITTER = () => 0.5;

// ---------------------------------------------------------------------------
// Mock toolkits v114
// ---------------------------------------------------------------------------

test('composio v114: 6 mock toolkits, 10 candidate slugs each, no overlap', () => {
  assert.deepEqual(COMPOSIO_V114_MOCK_TOOLKITS.map((t) => t.slug), EXPECTED_SLUGS);
  const allSlugs = mockComposioV114Slugs();
  assert.equal(allSlugs.length, 60);
  assert.equal(new Set(allSlugs).size, 60);
  for (const toolkit of COMPOSIO_V114_MOCK_TOOLKITS) {
    assert.equal(toolkit.candidateToolSlugs.length, 10);
    assert.equal(toolkit.mockOnly, true);
    assert.equal(toolkit.liveVerified, false);
    assert.match(toolkit.description, /\[MOCK\]/);
    assert.match(toolkit.label, /mock — via Composio/);
    assert.ok(['oauth2', 'api-key', 'oauth2-or-api-key'].includes(toolkit.authKind), `${toolkit.slug} authKind`);
    assert.ok(toolkit.authNote.length > 20, `${toolkit.slug} needs a real auth note`);
    // No overlap with live / v110 / v111 / v112 toolkits.
    assert.ok(!COMPOSIO_TOOLKIT_SLUGS.includes(toolkit.slug), `${toolkit.slug} overlaps live`);
    assert.ok(!COMPOSIO_V110_MOCK_TOOLKITS.some((t) => t.slug === toolkit.slug), `${toolkit.slug} overlaps v110`);
    assert.ok(!COMPOSIO_V111_MOCK_TOOLKITS.some((t) => t.slug === toolkit.slug), `${toolkit.slug} overlaps v111`);
    assert.ok(!COMPOSIO_V112_MOCK_TOOLKITS.some((t) => t.slug === toolkit.slug), `${toolkit.slug} overlaps v112`);
    // Slugs are namespaced per toolkit and follow PREFIX_VERB_NOUN.
    const prefix = toolkit.slug.toUpperCase();
    for (const slug of toolkit.candidateToolSlugs) {
      assert.ok(slug.startsWith(`${prefix}_`), `${slug} should start with ${prefix}_`);
      assert.match(slug, /^[A-Z][A-Z0-9_]+$/);
    }
  }
});

test('composio v114: mock executor deterministic, echo args, unknown throws', () => {
  const executor = new MockComposioV114Executor();
  const a = executeMockComposioV114Tool('webflow', 'WEBFLOW_LIST_SITES', { limit: 5 });
  assert.equal(a.mock, true);
  assert.equal(a.live, false);
  assert.equal(a.toolkit, 'webflow');
  assert.equal(a.slug, 'WEBFLOW_LIST_SITES');
  assert.equal(a.data.echo.limit, 5);
  assert.match(a.note, /Mock response/);
  // Deterministic: same call twice -> same requestId + same data.
  const b = executor.execute('xero', 'XERO_LIST_INVOICES', {});
  const c = executor.execute('xero', 'XERO_LIST_INVOICES', {});
  assert.deepEqual(b, c);
  assert.equal(mockComposioV114DeterministicId('x:1'), mockComposioV114DeterministicId('x:1'));
  // Every slug has a sample: all 60 execute without throwing.
  for (const toolkit of COMPOSIO_V114_MOCK_TOOLKITS) {
    for (const slug of toolkit.candidateToolSlugs) {
      const r = executor.execute(toolkit.slug, slug, {});
      assert.equal(r.mock, true);
      assert.equal(typeof r.data, 'object');
    }
  }
  assert.throws(() => executeMockComposioV114Tool('gmail', 'GMAIL_SEND_EMAIL', {}), /Unknown mock Composio v114 toolkit/);
  assert.throws(() => executeMockComposioV114Tool('webflow', 'WEBFLOW_NOPE', {}), /Unknown mock Composio v114 tool slug/);
  assert.throws(() => executor.listSlugs('nope'), /Unknown mock Composio v114 toolkit/);
  assert.equal(isMockComposioV114Slug('PIPEDRIVE_LIST_DEALS'), true);
  assert.equal(isMockComposioV114Slug('GMAIL_SEND_EMAIL'), false);
  assert.equal(findMockComposioV114Toolkit('chargebee')?.authKind, 'api-key');
  assert.equal(findMockComposioV114Toolkit('nope'), undefined);
  assert.equal(mockComposioV114AppId('xero'), 'composio-xero');
  // Write tools need approval, read tools do not.
  assert.equal(mockComposioV114ToolNeedsApproval('WEBFLOW_CREATE_ITEM'), true);
  assert.equal(mockComposioV114ToolNeedsApproval('WEBFLOW_LIST_SITES'), false);
});

test('composio v114: app definitions + catalogue summary', () => {
  const defs = createMockComposioV114AppDefinitions();
  assert.equal(defs.length, 6);
  for (const def of defs) {
    assert.equal(def.authType, 'composio');
    assert.equal(def.source, 'composio');
    assert.equal(def.tools.length, 10);
    assert.match(def.description, /\[MOCK\]/);
    for (const tool of def.tools) {
      assert.equal(tool.needsApproval, mockComposioV114ToolNeedsApproval(tool.name));
    }
  }
  const summary = summarizeMockComposioV114Catalogue();
  assert.equal(summary.totalToolkits, 6);
  assert.equal(summary.totalSlugs, 60);
  assert.equal(summary.writeSlugs + summary.readSlugs, 60);
  assert.ok(summary.writeSlugs > 0, 'catalogue must contain write tools');
  assert.ok(summary.readSlugs > 0, 'catalogue must contain read tools');
  assert.equal(summary.byToolkit.length, 6);
  for (const row of summary.byToolkit) {
    assert.equal(row.total, 10);
    assert.equal(row.write + row.read, 10);
  }
});

// ---------------------------------------------------------------------------
// Poll scheduler v2
// ---------------------------------------------------------------------------

test('composio v114 polling: per-toolkit defaults + schedule validation', () => {
  assert.equal(defaultComposioV114IntervalMs('gmail'), 5 * 60 * 1000);
  assert.equal(defaultComposioV114IntervalMs('slack'), 2 * 60 * 1000);
  assert.equal(defaultComposioV114IntervalMs('xero'), 60 * 60 * 1000);
  assert.equal(defaultComposioV114IntervalMs('unknown-toolkit'), 10 * 60 * 1000);
  const s = createComposioV114Schedule({
    id: 'poll:gmail:ca_1',
    connectionId: 'ca_1',
    toolkit: 'gmail',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    startAtMs: 1000,
  });
  assert.equal(s.baseIntervalMs, 5 * 60 * 1000);
  assert.equal(s.currentIntervalMs, 5 * 60 * 1000);
  assert.equal(s.nextPollAtMs, 1000);
  assert.equal(s.consecutiveErrors, 0);
  assert.equal(s.enabled, true);
  assert.equal(isComposioV114ScheduleDue(s, 999), false);
  assert.equal(isComposioV114ScheduleDue(s, 1000), true);
  assert.equal(composioV114MsUntilNextPoll(s, 500), 500);
  assert.equal(composioV114MsUntilNextPoll({ ...s, enabled: false }, 500), -1);
  validateComposioV114Schedule(s);
  assert.throws(
    () => createComposioV114Schedule({ id: 'x', connectionId: 'c', toolkit: 'gmail', triggerSlug: 'lowercase_slug' }),
    /triggerSlug/,
  );
  assert.throws(
    () => validateComposioV114Schedule({ ...s, baseIntervalMs: 0 }),
    /baseIntervalMs/,
  );
  assert.throws(
    () => validateComposioV114Schedule({ ...s, jitterFraction: 2 }),
    /jitterFraction/,
  );
});

test('composio v114 polling: backoff grows exponentially and caps', () => {
  assert.equal(composioV114BackoffDelayMs(300_000, 0, 2, COMPOSIO_V114_DEFAULT_MAX_BACKOFF_MS), 300_000);
  assert.equal(composioV114BackoffDelayMs(300_000, 1, 2, COMPOSIO_V114_DEFAULT_MAX_BACKOFF_MS), 600_000);
  assert.equal(composioV114BackoffDelayMs(300_000, 2, 2, COMPOSIO_V114_DEFAULT_MAX_BACKOFF_MS), 1_200_000);
  assert.equal(
    composioV114BackoffDelayMs(300_000, 10, 2, COMPOSIO_V114_DEFAULT_MAX_BACKOFF_MS),
    COMPOSIO_V114_DEFAULT_MAX_BACKOFF_MS,
  );
  // Jitter: 0 fraction = exact; fraction bounds the result.
  assert.equal(applyComposioV114Jitter(100_000, 0, NO_JITTER), 100_000);
  const jittered = applyComposioV114Jitter(100_000, 0.1, () => 1);
  assert.ok(jittered >= 100_000 && jittered <= 110_000, `jittered=${jittered}`);
  const jitteredLow = applyComposioV114Jitter(100_000, 0.1, () => 0);
  assert.ok(jitteredLow >= 90_000 && jitteredLow <= 100_000, `jitteredLow=${jitteredLow}`);
});

test('composio v114 polling: success resets, error backs off', () => {
  const base = createComposioV114Schedule({
    id: 'poll:slack:ca_2',
    connectionId: 'ca_2',
    toolkit: 'slack',
    triggerSlug: 'SLACK_CHANNEL_MESSAGE_RECEIVED',
    startAtMs: 0,
    jitterFraction: 0,
  });
  const afterError = nextComposioV114PollAfterError(base, 1000, NO_JITTER);
  assert.equal(afterError.consecutiveErrors, 1);
  assert.equal(afterError.currentIntervalMs, base.baseIntervalMs * 2);
  assert.equal(afterError.nextPollAtMs, 1000 + base.baseIntervalMs * 2);
  assert.equal(afterError.lastPollAtMs, null, 'error keeps the old checkpoint');
  const afterError2 = nextComposioV114PollAfterError(afterError, 2000, NO_JITTER);
  assert.equal(afterError2.consecutiveErrors, 2);
  assert.equal(afterError2.currentIntervalMs, base.baseIntervalMs * 4);
  const afterSuccess = nextComposioV114PollAfterSuccess(
    afterError2,
    5000,
    { newItems: 3, duplicates: 1, cursor: 'cur_9' },
    NO_JITTER,
  );
  assert.equal(afterSuccess.consecutiveErrors, 0);
  assert.equal(afterSuccess.currentIntervalMs, base.baseIntervalMs);
  assert.equal(afterSuccess.lastPollAtMs, 5000);
  assert.equal(afterSuccess.lastCursor, 'cur_9');
  assert.equal(afterSuccess.lastNewItems, 3);
  assert.equal(afterSuccess.lastDuplicates, 1);
  assert.equal(afterSuccess.nextPollAtMs, 5000 + base.baseIntervalMs);
});

test('composio v114 polling: dedupe window + cap + filter', () => {
  const now = 10_000_000;
  const seen = recordComposioV114SeenIds([], ['a', 'b'], now);
  assert.equal(isComposioV114Duplicate(seen, 'a', now), true);
  assert.equal(isComposioV114Duplicate(seen, 'c', now), false);
  // Outside the window the id may be polled again.
  assert.equal(isComposioV114Duplicate(seen, 'a', now + COMPOSIO_V114_DEFAULT_DEDUPE_WINDOW_MS + 1), false);
  // Recording an existing id does not duplicate it; cap keeps newest.
  const again = recordComposioV114SeenIds(seen, ['a', 'c'], now + 1000, 3);
  assert.equal(again.length, 3);
  assert.deepEqual(again.map((e) => e.id), ['a', 'b', 'c']);
  const capped = recordComposioV114SeenIds(again, ['d'], now + 2000, 3);
  assert.deepEqual(capped.map((e) => e.id), ['b', 'c', 'd']);
  // Prune drops expired entries.
  assert.deepEqual(pruneComposioV114SeenIds(seen, now + COMPOSIO_V114_DEFAULT_DEDUPE_WINDOW_MS + 1), []);
  // Filter splits fresh vs duplicates.
  const { fresh, duplicates } = filterComposioV114NewItems(
    [{ id: 'a' }, { id: 'x' }, { id: 'b' }],
    seen,
    now,
  );
  assert.deepEqual(fresh.map((i) => i.id), ['x']);
  assert.deepEqual(duplicates.map((i) => i.id), ['a', 'b']);
});

test('composio v114 polling: checkpoint serialize/parse/resume + missed polls', () => {
  const schedule = createComposioV114Schedule({
    id: 'poll:gmail:ca_3',
    connectionId: 'ca_3',
    toolkit: 'gmail',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    startAtMs: 1000,
    jitterFraction: 0,
  });
  const done = nextComposioV114PollAfterSuccess(
    schedule,
    2000,
    { newItems: 2, duplicates: 0, cursor: 'cur_1' },
    NO_JITTER,
  );
  const cp = checkpointComposioV114Schedule(done, [{ id: 'm1', atMs: 2000 }], 2000);
  assert.equal(cp.version, 1);
  assert.equal(cp.lastCursor, 'cur_1');
  assert.equal(cp.seen.length, 1);
  const json = serializeComposioV114Checkpoint(cp);
  const parsed = parseComposioV114Checkpoint(json);
  assert.deepEqual(parsed, cp);
  assert.throws(() => parseComposioV114Checkpoint('not json'), /not valid JSON/);
  assert.throws(() => parseComposioV114Checkpoint(JSON.stringify({ ...cp, version: 99 })), /unsupported checkpoint version/);
  assert.throws(
    () => parseComposioV114Checkpoint(JSON.stringify({ ...cp, seen: [{ id: 'm1', atMs: 1 }, { id: 'm1', atMs: 2 }] })),
    /duplicate ids/,
  );
  // Resume: next poll in the future is kept; overdue polls run now.
  const resumed = resumeComposioV114Schedule(schedule, cp, 2500);
  assert.equal(resumed.lastPollAtMs, 2000);
  assert.equal(resumed.lastCursor, 'cur_1');
  assert.equal(resumed.nextPollAtMs, done.nextPollAtMs);
  const overdue = resumeComposioV114Schedule(schedule, cp, done.nextPollAtMs + 60_000);
  assert.equal(overdue.nextPollAtMs, done.nextPollAtMs + 60_000);
  assert.throws(() => resumeComposioV114Schedule(schedule, { ...cp, scheduleId: 'other' }, 2500), /does not match/);
  // Missed polls between checkpoint and now.
  assert.equal(missedComposioV114Polls(cp, cp.nextPollAtMs, 300_000), 0);
  assert.equal(missedComposioV114Polls(cp, cp.nextPollAtMs + 900_000, 300_000), 3);
});

// ---------------------------------------------------------------------------
// Poll engine
// ---------------------------------------------------------------------------

test('composio v114 polling: engine ticks due schedules, dedupes, isolates errors', async () => {
  const engine = new ComposioV114PollEngine({ random: NO_JITTER });
  const gmail = createComposioV114Schedule({
    id: 'poll:gmail:e1',
    connectionId: 'ca_g',
    toolkit: 'gmail',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    startAtMs: 1000,
    jitterFraction: 0,
  });
  const slack = createComposioV114Schedule({
    id: 'poll:slack:e1',
    connectionId: 'ca_s',
    toolkit: 'slack',
    triggerSlug: 'SLACK_CHANNEL_MESSAGE_RECEIVED',
    startAtMs: 1000,
    jitterFraction: 0,
  });
  engine.addSchedule(gmail);
  engine.addSchedule(slack);
  assert.throws(() => engine.addSchedule(gmail), /duplicate poll schedule/);
  assert.equal(engine.dueSchedules(999).length, 0);
  assert.equal(engine.dueSchedules(1000).length, 2);
  assert.equal(engine.summarize(1000).total, 2);
  assert.equal(engine.summarize(1000).due, 2);

  let calls = 0;
  const fetch = async (schedule) => {
    calls += 1;
    if (schedule.toolkit === 'slack') throw new Error('mock slack fetch failed');
    return { items: [{ id: 'm1' }, { id: 'm2' }], cursor: 'c1' };
  };
  const results = await engine.tick(1000, fetch);
  assert.equal(calls, 2);
  assert.equal(results.length, 2);
  const gmailResult = results.find((r) => r.toolkit === 'gmail');
  const slackResult = results.find((r) => r.toolkit === 'slack');
  assert.equal(gmailResult.ok, true);
  assert.equal(gmailResult.fresh, 2);
  assert.equal(slackResult.ok, false);
  assert.match(slackResult.error, /mock slack fetch failed/);
  // Error is isolated: gmail is fine, slack backed off.
  assert.equal(engine.getSchedule('poll:gmail:e1').consecutiveErrors, 0);
  assert.equal(engine.getSchedule('poll:slack:e1').consecutiveErrors, 1);
  assert.equal(engine.summarize(1001).erroring, 1);

  // Second tick at gmail's next poll: same ids are duplicates now.
  const gmailNext = engine.getSchedule('poll:gmail:e1').nextPollAtMs;
  const results2 = await engine.tick(gmailNext, async (schedule) => {
    if (schedule.toolkit === 'slack') throw new Error('still failing');
    return { items: [{ id: 'm1' }, { id: 'm3' }], cursor: 'c2' };
  });
  const gmail2 = results2.find((r) => r.toolkit === 'gmail');
  assert.equal(gmail2.fresh, 1);
  assert.equal(gmail2.duplicates, 1);

  // Disabled schedule never ticks.
  engine.setEnabled('poll:gmail:e1', false);
  assert.equal(engine.dueSchedules(gmailNext + 10_000_000).filter((s) => s.id === 'poll:gmail:e1').length, 0);
  engine.setEnabled('poll:gmail:e1', true);

  // Checkpoint + restore round-trip.
  const cps = engine.checkpoints(5000);
  assert.equal(cps.length, 2);
  const restored = engine.restore('poll:gmail:e1', cps.find((c) => c.scheduleId === 'poll:gmail:e1'), 5000);
  assert.equal(restored.lastCursor, 'c2');
  assert.throws(() => engine.checkpoint('nope', 5000), /unknown poll schedule/);
  assert.throws(() => engine.restore('nope', cps[0], 5000), /unknown poll schedule/);
  assert.equal(engine.removeSchedule('poll:slack:e1'), true);
  assert.equal(engine.removeSchedule('poll:slack:e1'), false);
  assert.equal(engine.listSchedules().length, 1);
});

// ---------------------------------------------------------------------------
// Trigger templates v2
// ---------------------------------------------------------------------------

test('composio v114 triggers: 35 templates, curated slugs verified, payloads complete', () => {
  assert.equal(COMPOSIO_V114_TRIGGER_TEMPLATE_COUNT, 35);
  assert.equal(COMPOSIO_V114_TRIGGER_TEMPLATES.length, 35);
  const curated = COMPOSIO_V114_TRIGGER_TEMPLATES.filter((t) => t.source === 'curated');
  const candidates = COMPOSIO_V114_TRIGGER_TEMPLATES.filter((t) => t.source === 'candidate');
  assert.equal(curated.length, 29);
  assert.equal(candidates.length, 6);
  assert.equal(new Set(COMPOSIO_V114_TRIGGER_TEMPLATES.map((t) => t.slug)).size, 35);
  // Whole-catalog validation passes (curated slugs exist, required fields in payload).
  validateComposioV114TriggerTemplates();
  const curatedSlugs = new Set(COMPOSIO_TRIGGER_DEFS.map((d) => d.slug));
  for (const t of curated) {
    assert.ok(curatedSlugs.has(t.slug), `curated template ${t.slug} must be in COMPOSIO_TRIGGER_DEFS`);
  }
  for (const t of candidates) {
    assert.ok(!curatedSlugs.has(t.slug), `candidate ${t.slug} must not collide with curated`);
    assert.match(t.description, /\[CANDIDATE\]/);
  }
  for (const t of COMPOSIO_V114_TRIGGER_TEMPLATES) {
    assert.ok(t.description.length > 20, `${t.slug} description`);
    assert.ok(t.fields.length >= 3, `${t.slug} needs >= 3 fields`);
    assert.equal(new Set(t.fields.map((f) => f.name)).size, t.fields.length, `${t.slug} duplicate field`);
    for (const field of t.fields) {
      if (field.required) assert.ok(field.name in t.examplePayload, `${t.slug}: ${field.name} missing from payload`);
    }
    const rendered = renderComposioV114ExamplePayload(t);
    assert.deepEqual(JSON.parse(rendered), t.examplePayload);
  }
  // Candidate templates cover the 6 mock v114 toolkits.
  assert.deepEqual(
    candidates.map((t) => t.toolkit).sort(),
    ['chargebee', 'eventbrite', 'pipedrive', 'surveymonkey', 'webflow', 'xero'],
  );
});

test('composio v114 triggers: find/search/filter + mapping input', () => {
  const gmail = findComposioV114TriggerTemplate('GMAIL_NEW_GMAIL_MESSAGE');
  assert.equal(gmail.toolkit, 'gmail');
  assert.equal(gmail.delivery, 'poll');
  assert.equal(findComposioV114TriggerTemplate('NOPE_TRIGGER'), undefined);
  assert.deepEqual(
    composioV114TemplatesForToolkit('slack').map((t) => t.slug).sort(),
    ['SLACK_CHANNEL_MESSAGE_RECEIVED', 'SLACK_DIRECT_MESSAGE_RECEIVED'],
  );
  assert.ok(composioV114TemplatesForCategory('billing').length >= 3);
  assert.ok(composioV114TemplatesForCategory('code').every((t) => t.toolkit === 'github'));
  const hits = searchComposioV114TriggerTemplates('github');
  assert.ok(hits.length >= 3, `expected >= 3 github hits, got ${hits.length}`);
  for (const slug of ['GITHUB_COMMIT_EVENT', 'GITHUB_ISSUE_CREATED_TRIGGER', 'GITHUB_PULL_REQUEST_EVENT']) {
    assert.ok(hits.some((t) => t.slug === slug), `search 'github' must include ${slug}`);
  }
  assert.equal(searchComposioV114TriggerTemplates('').length, 35);
  assert.equal(searchComposioV114TriggerTemplates('zzz-no-match').length, 0);
  const mapping = composioV114TemplateToMappingInput(gmail);
  assert.equal(mapping.triggerSlug, 'GMAIL_NEW_GMAIL_MESSAGE');
  assert.deepEqual(mapping.requiredFields, ['message_id', 'subject', 'sender']);
  assert.deepEqual(mapping.optionalFields, ['snippet', 'labels']);
  // Validation rejects a curated slug that was never verified live.
  assert.throws(
    () =>
      validateComposioV114TriggerTemplates([
        {
          toolkit: 'gmail',
          slug: 'GMAIL_MADE_UP_TRIGGER',
          name: 'Made up',
          delivery: 'poll',
          category: 'communication',
          description: 'Made-up template for the test.',
          fields: [{ name: 'id', type: 'string', required: true, description: 'Id.' }],
          examplePayload: { id: 'x' },
          source: 'curated',
        },
      ]),
    /not in COMPOSIO_TRIGGER_DEFS/,
  );
});

// ---------------------------------------------------------------------------
// Connection health
// ---------------------------------------------------------------------------

test('composio v114 health: percentiles + averages', () => {
  assert.equal(percentileComposioV114Latency([], 95), null);
  assert.equal(averageComposioV114Latency([]), null);
  assert.equal(percentileComposioV114Latency([100, 200, 300, 400], 50), 200);
  assert.equal(percentileComposioV114Latency([100, 200, 300, 400], 95), 400);
  assert.equal(averageComposioV114Latency([100, 200, 300]), 200);
  assert.throws(() => percentileComposioV114Latency([1], 101), /percentile p/);
});

test('composio v114 health: success streak stays healthy, errors degrade then fail', () => {
  const now = 20_000_000;
  let h = emptyComposioV114ConnectionHealth('ca_h1', 'gmail', now, 'mock@gmail.com');
  assert.equal(h.status, 'unknown');
  assert.equal(h.errorRate, 0);
  for (let i = 0; i < 12; i += 1) {
    h = recordComposioV114SyncSuccess(h, now + (i + 1) * 1000, 120 + i);
  }
  assert.equal(h.status, 'healthy');
  assert.equal(h.totalPolls, 12);
  assert.equal(h.errorRate, 0);
  assert.equal(h.avgLatencyMs, 126);
  assert.equal(h.p50LatencyMs, 125);
  assert.equal(h.consecutiveErrors, 0);
  // 3 errors out of 15 -> 20% -> degraded (warning, not critical).
  for (let i = 0; i < 3; i += 1) h = recordComposioV114SyncError(h, now + 20_000 + i * 1000);
  assert.equal(h.status, 'degraded');
  assert.equal(h.errorRate, 3 / 15);
  assert.ok(h.alerts.some((a) => a.kind === 'high-error-rate' && a.severity === 'warning'));
  // 5 more errors -> error rate 8/20 = 40% still degraded by rate, but
  // 5 consecutive errors -> unhealthy (critical).
  for (let i = 0; i < 5; i += 1) h = recordComposioV114SyncError(h, now + 30_000 + i * 1000);
  assert.equal(h.status, 'unhealthy');
  assert.ok(h.alerts.some((a) => a.kind === 'consecutive-errors' && a.severity === 'critical'));
  // One success resets the consecutive counter (rate stays 8/21 = 38%).
  h = recordComposioV114SyncSuccess(h, now + 40_000, 100);
  assert.equal(h.consecutiveErrors, 0);
  assert.equal(h.status, 'degraded');
});

test('composio v114 health: stale sync, slow p95, expiring + expired', () => {
  const now = 30_000_000;
  const thresholds = DEFAULT_COMPOSIO_V114_HEALTH_THRESHOLDS;
  // Stale: last sync 25h ago.
  let stale = emptyComposioV114ConnectionHealth('ca_s1', 'slack', now - 25 * 3_600_000);
  stale = recordComposioV114SyncSuccess(stale, now - 25 * 3_600_000, 100);
  const staleEval = evaluateComposioV114Health(stale, now, thresholds);
  assert.equal(staleEval.status, 'degraded');
  assert.ok(staleEval.alerts.some((a) => a.kind === 'stale-sync'));
  // Never synced at all.
  const fresh = emptyComposioV114ConnectionHealth('ca_n1', 'notion', now);
  const freshEval = evaluateComposioV114Health(fresh, now, thresholds);
  assert.equal(freshEval.status, 'unknown');
  assert.ok(freshEval.alerts.some((a) => a.kind === 'never-synced'));
  // Slow: every sample 6000ms -> p95 over the 5000ms threshold.
  let slow = emptyComposioV114ConnectionHealth('ca_slow', 'github', now);
  for (let i = 0; i < 5; i += 1) slow = recordComposioV114SyncSuccess(slow, now + i * 1000, 6000);
  assert.equal(slow.p95LatencyMs, 6000);
  assert.ok(slow.alerts.some((a) => a.kind === 'slow-response'));
  // Expiring soon (3 days) -> warning; expired -> expired + critical.
  let exp = emptyComposioV114ConnectionHealth('ca_e1', 'xero', now);
  exp = recordComposioV114SyncSuccess(exp, now, 100);
  exp = setComposioV114ConnectionExpiry(exp, now + 3 * 86_400_000, now);
  assert.ok(exp.alerts.some((a) => a.kind === 'expiring-soon'));
  assert.equal(exp.status, 'healthy');
  exp = setComposioV114ConnectionExpiry(exp, now - 1000, now);
  assert.equal(exp.status, 'expired');
  assert.ok(exp.alerts.some((a) => a.kind === 'expired' && a.severity === 'critical'));
  assert.throws(() => setComposioV114ConnectionExpiry(exp, -5, now), /expiresAtMs/);
});

test('composio v114 health: store + dashboard summary + serialize round-trip', () => {
  const now = 40_000_000;
  const store = new ComposioV114HealthStore();
  store.register('ca_a', 'gmail', now, 'a@example.com');
  store.register('ca_b', 'slack', now);
  assert.throws(() => store.register('ca_a', 'gmail', now), /duplicate health record/);
  for (let i = 0; i < 10; i += 1) store.recordSuccess('ca_a', now + i * 1000, 100);
  for (let i = 0; i < 10; i += 1) {
    if (i < 6) store.recordError('ca_b', now + i * 1000);
    else store.recordSuccess('ca_b', now + i * 1000, 200);
  }
  assert.equal(store.get('ca_a').status, 'healthy');
  assert.equal(store.get('ca_b').status, 'unhealthy');
  assert.equal(store.get('ca_nope'), undefined);
  assert.throws(() => store.recordSuccess('ca_nope', now), /unknown connection/);
  const dashboard = store.dashboard();
  assert.equal(dashboard.total, 2);
  assert.equal(dashboard.healthy, 1);
  assert.equal(dashboard.unhealthy, 1);
  assert.equal(dashboard.worst[0].connectionId, 'ca_b');
  assert.ok(dashboard.criticalAlerts.length >= 1);
  assert.equal(dashboard.overallErrorRate, 6 / 20);
  const json = store.serialize();
  const restored = ComposioV114HealthStore.deserialize(json);
  assert.equal(restored.list().length, 2);
  assert.equal(restored.get('ca_b').status, 'unhealthy');
  assert.throws(() => ComposioV114HealthStore.deserialize('nope'), /not valid JSON/);
  assert.throws(() => ComposioV114HealthStore.deserialize('{}'), /must be an array/);
  // Dashboard on an empty list.
  const empty = summarizeComposioV114HealthDashboard([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.overallErrorRate, 0);
});

// ---------------------------------------------------------------------------
// MCP Apps/Tasks bridge
// ---------------------------------------------------------------------------

test('composio v114 mcp: 60 apps, URI parse round-trip, unknown rejected', () => {
  assert.equal(COMPOSIO_V114_MCP_APP_COUNT, 60);
  const apps = listComposioV114McpApps();
  assert.equal(apps.length, 60);
  assert.equal(new Set(apps.map((a) => a.uri)).size, 60);
  assert.equal(new Set(apps.map((a) => a.appId)).size, 60);
  for (const app of apps) {
    assert.equal(app.serverId, COMPOSIO_V114_MCP_APP_SERVER_ID);
    assert.ok(app.uri.startsWith('ui://composio/'));
    assert.deepEqual(app.allowedTools, [app.toolSlug]);
    assert.equal(app.description.includes('[MOCK]'), true);
    assert.deepEqual(parseComposioV114McpAppUri(app.uri), { toolkit: app.toolkit, toolSlug: app.toolSlug });
    assert.equal(isComposioV114McpAppUri(app.uri), true);
    assert.equal(findComposioV114McpApp(app.uri)?.appId, app.appId);
  }
  const one = createComposioV114McpApp('webflow', 'WEBFLOW_LIST_SITES');
  assert.equal(one.uri, 'ui://composio/webflow/WEBFLOW_LIST_SITES');
  assert.equal(one.appId, 'composio-webflow-webflow-list-sites');
  assert.equal(one.needsApproval, false);
  assert.equal(createComposioV114McpApp('webflow', 'WEBFLOW_CREATE_ITEM').needsApproval, true);
  assert.equal(composioV114McpAppUri('xero', 'XERO_LIST_INVOICES'), 'ui://composio/xero/XERO_LIST_INVOICES');
  assert.equal(composioV114McpAppId('xero', 'XERO_LIST_INVOICES'), 'composio-xero-xero-list-invoices');
  assert.equal(parseComposioV114McpAppUri('https://example.com'), null);
  assert.equal(parseComposioV114McpAppUri('ui://composio/webflow'), null);
  assert.equal(parseComposioV114McpAppUri('ui://composio/webflow/lower_slug'), null);
  assert.equal(isComposioV114McpAppUri('ui://composio/webflow/WEBFLOW_NOPE'), false);
  assert.equal(isComposioV114McpAppUri('ui://other/x/Y'), false);
  assert.equal(findComposioV114McpApp('ui://composio/nope/NOPE_X'), undefined);
  assert.throws(() => createComposioV114McpApp('gmail', 'GMAIL_SEND_EMAIL'), /Unknown mock Composio v114 toolkit/);
  assert.throws(() => createComposioV114McpApp('webflow', 'WEBFLOW_NOPE'), /Unknown mock Composio v114 tool slug/);
});

test('composio v114 mcp: static HTML is safe, task runs mock, cancel + store', () => {
  const app = createComposioV114McpApp('pipedrive', 'PIPEDRIVE_LIST_DEALS');
  const html = renderComposioV114McpAppHtml(app, { limit: 3 });
  const check = validateComposioV114McpAppHtml(html);
  assert.equal(check.valid, true, check.reasons.join('; '));
  assert.ok(html.includes('ui://composio/pipedrive/PIPEDRIVE_LIST_DEALS'));
  assert.ok(html.includes('limit') && html.includes('3'), 'HTML must show the args');
  assert.equal(validateComposioV114McpAppHtml('<script>alert(1)</script>').valid, false);
  assert.equal(validateComposioV114McpAppHtml('<img src="https://evil.example/x.png">').valid, false);

  const now = 50_000_000;
  const task = createComposioV114McpTask(app, { limit: 3 }, now);
  assert.equal(task.status, 'working');
  assert.ok(task.taskId.startsWith('composio-task-'));
  const done = runComposioV114McpTask(task, now + 500);
  assert.equal(done.status, 'completed');
  assert.equal(done.result.mock, true);
  assert.equal(done.result.live, false);
  assert.equal(done.result.slug, 'PIPEDRIVE_LIST_DEALS');
  assert.equal(done.finishedAtMs, now + 500);
  const summary = summarizeComposioV114McpTask(done);
  assert.equal(summary.durationMs, 500);
  assert.equal(summary.mock, true);
  assert.throws(() => createComposioV114McpTask({ ...app, toolSlug: 'PIPEDRIVE_NOPE' }, {}, now), /Unknown mock/);

  // Cancel a working task; completed tasks cannot be cancelled.
  const pending = createComposioV114McpTask(app, {}, now);
  const cancelled = cancelComposioV114McpTask(pending, now + 100);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelComposioV114McpTask(done, now + 100).status, 'completed');
  // A cancelled task does not run.
  assert.equal(runComposioV114McpTask(cancelled, now + 200).status, 'cancelled');

  // Task store: add/run/pending/serialize round-trip.
  const store = new ComposioV114McpTaskStore();
  store.add(pending);
  assert.throws(() => store.add(pending), /duplicate composio MCP task/);
  assert.equal(store.pending().length, 1);
  const ran = store.run(pending.taskId, now + 1000);
  assert.equal(ran.status, 'completed');
  assert.equal(store.pending().length, 0);
  assert.equal(store.list().length, 1);
  assert.throws(() => store.run('nope', now), /unknown composio MCP task/);
  assert.throws(() => store.cancel('nope', now), /unknown composio MCP task/);
  const restored = ComposioV114McpTaskStore.deserialize(store.serialize());
  assert.equal(restored.list().length, 1);
  assert.equal(restored.get(pending.taskId).status, 'completed');
  assert.throws(
    () => ComposioV114McpTaskStore.deserialize('[{"taskId":"x","toolSlug":"NOPE"}]'),
    /unknown tool slug/,
  );

  // One-shot helper: URI -> completed task + HTML.
  const via = executeMockComposioV114ToolViaApp('ui://composio/surveymonkey/SURVEYMONKEY_LIST_SURVEYS', {}, now);
  assert.equal(via.task.status, 'completed');
  assert.equal(via.task.result.toolkit, 'surveymonkey');
  assert.ok(via.html.includes('ui://composio/surveymonkey/SURVEYMONKEY_LIST_SURVEYS'));
  assert.throws(
    () => executeMockComposioV114ToolViaApp('ui://composio/nope/NOPE_X', {}, now),
    /Unknown Composio v114 MCP app URI/,
  );
});
