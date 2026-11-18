/**
 * Composio v119 tests — polling v6 (v1.19, Doi T4 — node:test,
 * no network, no key).
 *
 * Covers pollingV119.ts:
 * - Batch config validation + defaults, retry delay (exponential,
 *   capped, jitter), day key, cursor seen-set (record/prune/dup),
 *   daily retry budget rollover + canRetry
 * - fetchComposioV119Batch: multi-page batch, dedupe by item id
 *   across pages, cursor-repeat stop, maxBatchItems stop, empty
 *   page stop, lastCursor tracking
 * - fetchComposioV119BatchWithRetry: success, retry-then-success
 *   (delays + counters), exhausted retries throw, daily budget
 *   caps retries
 * - ComposioV119PollEngine.tick: due-only, hit/miss outcomes,
 *   per-connection error isolation, batch state round-trip,
 *   summarize
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v119-polling.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_V119_DEFAULT_BATCH_SIZE,
  COMPOSIO_V119_DEFAULT_DAILY_RETRY_BUDGET,
  COMPOSIO_V119_DEFAULT_MAX_BATCH_ITEMS,
  COMPOSIO_V119_DEFAULT_MAX_RETRIES,
  COMPOSIO_V119_DEFAULT_RETRY_DELAY_MS,
  COMPOSIO_V119_POLL_STATE_VERSION,
  ComposioV119PollEngine,
  composioV119CanRetry,
  composioV119DayKey,
  composioV119RetriesLeftToday,
  composioV119RetryDelayMs,
  createComposioV119ConnState,
  createComposioV119PollConnBatchState,
  fetchComposioV119Batch,
  fetchComposioV119BatchWithRetry,
  isComposioV119CursorDuplicate,
  pruneComposioV119SeenCursors,
  recordComposioV119SeenCursor,
  rolloverComposioV119RetryBudget,
  validateComposioV119PollBatchConfig,
  validateComposioV119PollConnBatchState,
} from '../packages/core/dist/composio/pollingV119.js';
import { createComposioV118ConnState } from '../packages/core/dist/composio/pollingV118.js';

const NOW = 1780000000000; // fixed epoch ms (2026-05-28T20:26:40Z)
const DAY = '2026-05-28';

function makeConn(id = 'ca_1') {
  return createComposioV118ConnState({
    connectionId: id,
    toolkit: 'gmail',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    startAtMs: NOW,
  });
}

function makeBatchState(id = 'ca_1', config) {
  return createComposioV119PollConnBatchState(id, config, NOW);
}

test('v119 polling: defaults + version', () => {
  assert.equal(COMPOSIO_V119_POLL_STATE_VERSION, 1);
  assert.equal(COMPOSIO_V119_DEFAULT_BATCH_SIZE, 5);
  assert.equal(COMPOSIO_V119_DEFAULT_MAX_BATCH_ITEMS, 200);
  assert.equal(COMPOSIO_V119_DEFAULT_MAX_RETRIES, 3);
  assert.equal(COMPOSIO_V119_DEFAULT_RETRY_DELAY_MS, 1000);
  assert.equal(COMPOSIO_V119_DEFAULT_DAILY_RETRY_BUDGET, 20);
  const cfg = validateComposioV119PollBatchConfig(undefined);
  assert.equal(cfg.batchSize, 5);
  assert.equal(cfg.maxBatchItems, 200);
  assert.equal(cfg.maxSeenCursors, 200);
  assert.equal(cfg.maxRetries, 3);
  assert.equal(cfg.retryDelayMs, 1000);
  assert.equal(cfg.retryBackoffMultiplier, 2);
  assert.equal(cfg.maxRetryDelayMs, 30000);
  assert.equal(cfg.dailyRetryBudget, 20);
  assert.equal(cfg.retryJitterFraction, 0.1);
  // Partial override keeps the rest.
  const over = validateComposioV119PollBatchConfig({ batchSize: 2, maxRetries: 1, retryJitterFraction: 0 });
  assert.equal(over.batchSize, 2);
  assert.equal(over.maxRetries, 1);
  assert.equal(over.retryJitterFraction, 0);
  assert.equal(over.maxBatchItems, 200);
});

test('v119 polling: config validation rejects bad values', () => {
  assert.throws(() => validateComposioV119PollBatchConfig({ batchSize: 0 }), /batchSize must be at least 1/);
  assert.throws(() => validateComposioV119PollBatchConfig({ batchSize: 1.5 }), /non-negative integer/);
  assert.throws(() => validateComposioV119PollBatchConfig({ maxBatchItems: 0 }), /maxBatchItems must be at least 1/);
  assert.throws(() => validateComposioV119PollBatchConfig({ maxSeenCursors: 0 }), /maxSeenCursors must be at least 1/);
  assert.throws(() => validateComposioV119PollBatchConfig({ maxRetries: -1 }), /non-negative integer/);
  assert.throws(() => validateComposioV119PollBatchConfig({ retryBackoffMultiplier: 0.5 }), /retryBackoffMultiplier/);
  assert.throws(() => validateComposioV119PollBatchConfig({ retryJitterFraction: 0.6 }), /retryJitterFraction/);
  assert.throws(() => validateComposioV119PollBatchConfig({ retryJitterFraction: -0.1 }), /retryJitterFraction/);
  assert.throws(
    () => validateComposioV119PollBatchConfig({ retryDelayMs: 5000, maxRetryDelayMs: 1000 }),
    /retryDelayMs must not exceed maxRetryDelayMs/,
  );
});

test('v119 polling: retry delay is exponential, capped, jittered', () => {
  const cfg = validateComposioV119PollBatchConfig({ retryJitterFraction: 0 });
  assert.equal(composioV119RetryDelayMs(0, cfg, () => 0.5), 1000);
  assert.equal(composioV119RetryDelayMs(1, cfg, () => 0.5), 2000);
  assert.equal(composioV119RetryDelayMs(2, cfg, () => 0.5), 4000);
  assert.equal(composioV119RetryDelayMs(10, cfg, () => 0.5), 30000, 'capped at maxRetryDelayMs');
  assert.throws(() => composioV119RetryDelayMs(-1, cfg), /non-negative integer/);
  // Jitter: random 0.5 → no shift; random 0 → -10%; random 1 → +10%.
  const jittered = validateComposioV119PollBatchConfig({ retryJitterFraction: 0.1 });
  assert.equal(composioV119RetryDelayMs(0, jittered, () => 0.5), 1000);
  assert.equal(composioV119RetryDelayMs(0, jittered, () => 0), 900);
  assert.equal(composioV119RetryDelayMs(0, jittered, () => 1), 1100);
});

test('v119 polling: day key + batch state create/validate', () => {
  assert.equal(composioV119DayKey(NOW), DAY);
  assert.equal(composioV119DayKey(NOW + 86_400_000), '2026-05-29');
  const s = makeBatchState();
  assert.equal(s.connectionId, 'ca_1');
  assert.equal(s.retriesDay, DAY);
  assert.equal(s.retriesUsedToday, 0);
  assert.equal(s.totalRetries, 0);
  assert.equal(s.lastError, null);
  assert.equal(s.consecutiveErrors, 0);
  assert.deepEqual(s.seenCursors, []);
  validateComposioV119PollConnBatchState(s);
  assert.throws(() => createComposioV119PollConnBatchState('', undefined, NOW), /non-empty string/);
  assert.throws(() => createComposioV119PollConnBatchState('  ', undefined, NOW), /non-empty string/);
  assert.throws(
    () => validateComposioV119PollConnBatchState({ ...s, seenCursors: [{ cursor: 'c1', atMs: 1 }, { cursor: 'c1', atMs: 2 }] }),
    /must not contain duplicates/,
  );
  assert.throws(() => validateComposioV119PollConnBatchState({ ...s, retriesDay: '30-07-2026' }), /YYYY-MM-DD/);
  assert.throws(() => validateComposioV119PollConnBatchState({ ...s, totalPages: -1 }), /non-negative integer/);
});

test('v119 polling: cursor seen-set record/prune/dup', () => {
  let s = makeBatchState('ca_1', { maxSeenCursors: 2 });
  assert.equal(isComposioV119CursorDuplicate(s, 'c1'), false);
  assert.equal(isComposioV119CursorDuplicate(s, null), false);
  assert.equal(isComposioV119CursorDuplicate(s, ''), false);
  s = recordComposioV119SeenCursor(s, 'c1', NOW);
  s = recordComposioV119SeenCursor(s, 'c2', NOW + 1);
  assert.equal(isComposioV119CursorDuplicate(s, 'c1'), true);
  assert.equal(s.seenCursors.length, 2);
  // Third cursor evicts the oldest (cap 2).
  s = recordComposioV119SeenCursor(s, 'c3', NOW + 2);
  assert.equal(s.seenCursors.length, 2);
  assert.equal(isComposioV119CursorDuplicate(s, 'c1'), false);
  assert.equal(isComposioV119CursorDuplicate(s, 'c3'), true);
  // Re-recording moves it to the end (no duplicate entry).
  s = recordComposioV119SeenCursor(s, 'c2', NOW + 3);
  assert.equal(s.seenCursors.length, 2);
  assert.equal(s.seenCursors[1].cursor, 'c2');
  // Empty cursor is a no-op (returns the same state).
  assert.equal(recordComposioV119SeenCursor(s, '', NOW), s);
  // Prune honours the cap.
  const over = { ...s, seenCursors: [...s.seenCursors, { cursor: 'c9', atMs: NOW }] };
  assert.equal(pruneComposioV119SeenCursors(over).seenCursors.length, 2);
});

test('v119 polling: daily retry budget rollover + canRetry', () => {
  let s = makeBatchState();
  assert.equal(composioV119RetriesLeftToday(s, NOW), 20);
  assert.equal(composioV119CanRetry(s, 0, NOW), true);
  assert.equal(composioV119CanRetry(s, 3, NOW), false, 'attempt >= maxRetries');
  // Same day → no rollover (same object).
  assert.equal(rolloverComposioV119RetryBudget(s, NOW + 1000), s);
  // Next day → budget resets.
  const used = { ...s, retriesUsedToday: 20 };
  assert.equal(composioV119RetriesLeftToday(used, NOW), 0);
  assert.equal(composioV119CanRetry(used, 0, NOW), false);
  const rolled = rolloverComposioV119RetryBudget(used, NOW + 86_400_000);
  assert.equal(rolled.retriesUsedToday, 0);
  assert.equal(rolled.retriesDay, '2026-05-29');
  assert.equal(composioV119RetriesLeftToday(used, NOW + 86_400_000), 20);
  // Zero budget → never retry.
  const zero = makeBatchState('ca_1', { dailyRetryBudget: 0 });
  assert.equal(composioV119CanRetry(zero, 0, NOW), false);
});

test('v119 polling: batch fetch dedupes ids across pages + stops on empty page', async () => {
  const pollState = makeConn();
  const batchState = makeBatchState();
  const pages = [
    { items: [{ id: 'a' }, { id: 'b' }], cursor: 'c1' },
    { items: [{ id: 'b' }, { id: 'c' }], cursor: 'c2' },
    { items: [], cursor: null },
  ];
  let calls = 0;
  const { result, batchState: after } = await fetchComposioV119Batch(
    pollState,
    batchState,
    async () => pages[calls++] ?? { items: [], cursor: null },
    NOW,
  );
  assert.equal(calls, 3);
  assert.deepEqual(result.fresh.map((i) => i.id), ['a', 'b', 'c']);
  assert.equal(result.rawItems, 4);
  assert.equal(result.duplicateIds, 1, 'b repeated on page 2');
  assert.equal(result.cursorDuplicates, 0);
  assert.equal(result.pages, 3);
  assert.equal(result.stoppedOnCursorRepeat, false);
  assert.equal(result.stoppedOnMaxItems, false);
  assert.equal(result.lastCursor, null);
  assert.equal(after.totalPages, 3);
  assert.equal(after.totalRawItems, 4);
  assert.deepEqual(after.seenCursors.map((c) => c.cursor), ['c1', 'c2']);
});

test('v119 polling: batch fetch stops on repeated cursor', async () => {
  const pollState = makeConn();
  const batchState = makeBatchState();
  const pages = [
    { items: [{ id: 'a' }], cursor: 'c1' },
    { items: [{ id: 'b' }], cursor: 'c1' }, // server loops the cursor
    { items: [{ id: 'c' }], cursor: null },
  ];
  let calls = 0;
  const { result } = await fetchComposioV119Batch(
    pollState,
    batchState,
    async () => pages[calls++] ?? { items: [], cursor: null },
    NOW,
  );
  assert.equal(calls, 2, 'page 2 is fetched, its looping cursor is detected, page 3 never fetched');
  assert.deepEqual(result.fresh.map((i) => i.id), ['a'], 'page 2 items are discarded');
  assert.equal(result.rawItems, 2, 'raw counts both fetched pages');
  assert.equal(result.stoppedOnCursorRepeat, true);
  assert.equal(result.cursorDuplicates, 1);
  assert.equal(result.pages, 2);
  assert.equal(result.lastCursor, 'c1');
});

test('v119 polling: batch fetch stops on maxBatchItems + honours batchSize', async () => {
  const pollState = makeConn();
  const batchState = makeBatchState('ca_1', { maxBatchItems: 2, batchSize: 5 });
  const pages = [
    { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], cursor: 'c1' },
    { items: [{ id: 'd' }], cursor: null },
  ];
  let calls = 0;
  const { result } = await fetchComposioV119Batch(
    pollState,
    batchState,
    async () => pages[calls++] ?? { items: [], cursor: null },
    NOW,
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.fresh.map((i) => i.id), ['a', 'b']);
  assert.equal(result.stoppedOnMaxItems, true);
  assert.equal(result.rawItems, 3, 'raw counts the whole page');

  // batchSize caps the page count.
  const small = makeBatchState('ca_1', { batchSize: 1 });
  let calls2 = 0;
  const r2 = await fetchComposioV119Batch(
    pollState,
    small,
    async () => pages[calls2++] ?? { items: [], cursor: null },
    NOW,
  );
  assert.equal(calls2, 1);
  assert.equal(r2.result.pages, 1);
  assert.equal(r2.result.fresh.length, 3);
});

test('v119 polling: batch fetch dedupes against v118 seen ids', async () => {
  // pollState already saw 'a' in a previous tick (v118 dedupe window).
  const pollState = {
    ...makeConn(),
    policyState: {
      ...makeConn().policyState,
      seenIds: [{ id: 'a', atMs: NOW }],
    },
  };
  const { result } = await fetchComposioV119Batch(
    pollState,
    makeBatchState(),
    async () => ({ items: [{ id: 'a' }, { id: 'b' }], cursor: null }),
    NOW,
  );
  assert.deepEqual(result.fresh.map((i) => i.id), ['b']);
  assert.equal(result.duplicateIds, 1);
});

test('v119 polling: fetch with retry — success, retry-then-success, exhausted', async () => {
  const state = makeBatchState();
  // Success first try: no retry, no sleep.
  const sleeps = [];
  const ok = await fetchComposioV119BatchWithRetry(state, async () => 'done', {
    nowMs: NOW,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(ok.value, 'done');
  assert.equal(ok.retries, 0);
  assert.equal(ok.batchState.consecutiveErrors, 0);
  assert.equal(ok.batchState.lastError, null);
  assert.deepEqual(sleeps, []);

  // Fail twice, then succeed: 2 retries, delays 1000 then 2000 (jitter 0 at random 0.5).
  let attempts = 0;
  const sleeps2 = [];
  const recovered = await fetchComposioV119BatchWithRetry(state, async () => {
    attempts += 1;
    if (attempts < 3) throw new Error(`boom ${attempts}`);
    return 'recovered';
  }, { nowMs: NOW, sleep: async (ms) => { sleeps2.push(ms); }, random: () => 0.5 });
  assert.equal(recovered.value, 'recovered');
  assert.equal(recovered.retries, 2);
  assert.deepEqual(sleeps2, [1000, 2000]);
  assert.equal(recovered.batchState.retriesUsedToday, 2);
  assert.equal(recovered.batchState.totalRetries, 2);

  // Always failing: 3 attempts total (maxRetries), then throws the original error.
  const sleeps3 = [];
  await assert.rejects(
    () => fetchComposioV119BatchWithRetry(state, async () => { throw new Error('down'); }, {
      nowMs: NOW,
      sleep: async (ms) => { sleeps3.push(ms); },
      random: () => 0.5,
    }),
    /down/,
  );
  assert.deepEqual(sleeps3, [1000, 2000, 4000], '3 retries (maxRetries) → 4 fetch calls, 3 sleeps');
});

test('v119 polling: fetch with retry — daily budget caps retries', async () => {
  const state = makeBatchState('ca_1', { dailyRetryBudget: 1, maxRetries: 3 });
  let attempts = 0;
  const sleeps = [];
  const err = await fetchComposioV119BatchWithRetry(state, async () => {
    attempts += 1;
    throw new Error('down');
  }, { nowMs: NOW, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(attempts, 2, '1 initial + 1 retry (budget 1), then gives up');
  assert.deepEqual(sleeps, [1000]);
});

test('v119 polling: engine tick — hit, miss, due-only, error isolation', async () => {
  const engine = new ComposioV119PollEngine();
  engine.addConnection(makeConn('ca_1'));
  engine.addConnection(makeConn('ca_2'));
  // ca_2 is not due yet (move its next poll far into the future).
  const late = { ...engine.getConnection('ca_2'), nextPollAtMs: NOW + 3600_000 };
  engine.removeConnection('ca_2');
  engine.addConnection(late);

  const results = await engine.tick(NOW, async (state) => {
    if (state.connectionId === 'ca_1') return { items: [{ id: 'm1' }, { id: 'm2' }], cursor: null };
    throw new Error('should not be called for ca_2');
  });
  assert.equal(results.length, 1, 'only ca_1 was due');
  const r = results[0];
  assert.equal(r.connectionId, 'ca_1');
  assert.equal(r.ok, true);
  assert.equal(r.fresh, 2);
  assert.equal(r.pages, 1);
  assert.equal(r.rawItems, 2);
  assert.equal(r.duplicateIds, 0);
  assert.equal(r.retries, 0);
  assert.equal(r.stoppedOnCursorRepeat, false);
  assert.equal(r.lastCursor, null);
  assert.ok(r.nextPollAtMs > NOW);
  // Batch state was recorded.
  const bs = engine.getBatchState('ca_1');
  assert.equal(bs.totalPages, 1);
  assert.equal(bs.totalRawItems, 2);

  // Second tick at the same instant: nothing due (next poll is in the future).
  const none = await engine.tick(NOW, async () => ({ items: [], cursor: null }));
  assert.equal(none.length, 0);

  // Error isolation: ca_1 fails, ca_3 succeeds in the same tick.
  const engine2 = new ComposioV119PollEngine();
  engine2.addConnection(makeConn('ca_1'));
  engine2.addConnection(createComposioV119ConnState('ca_3', 'slack', 'SLACK_NEW_MESSAGE', NOW));
  const mixed = await engine2.tick(NOW, async (state) => {
    if (state.connectionId === 'ca_1') throw new Error('gmail down');
    return { items: [{ id: 's1' }], cursor: null };
  });
  assert.equal(mixed.length, 2);
  const failed = mixed.find((x) => x.connectionId === 'ca_1');
  const good = mixed.find((x) => x.connectionId === 'ca_3');
  assert.equal(failed.ok, false);
  assert.equal(failed.mode, 'error');
  assert.match(failed.error, /gmail down/);
  assert.equal(failed.fresh, 0);
  assert.equal(good.ok, true);
  assert.equal(good.fresh, 1);
  const failedBatch = engine2.getBatchState('ca_1');
  assert.equal(failedBatch.consecutiveErrors, 1);
  assert.equal(failedBatch.lastError, 'gmail down');
});

test('v119 polling: engine batch state round-trip + summarize + remove', async () => {
  const engine = new ComposioV119PollEngine();
  engine.addConnection(makeConn('ca_1'));
  const s = engine.getBatchState('ca_1');
  assert.ok(s);
  const edited = { ...s, totalPages: 42 };
  engine.setBatchState(edited);
  assert.equal(engine.getBatchState('ca_1').totalPages, 42);
  assert.throws(() => engine.setBatchState({ ...s, totalPages: -1 }), /non-negative integer/);
  assert.equal(engine.getBatchState('nope'), undefined);
  assert.equal(engine.listConnections().length, 1);
  assert.equal(engine.setEnabled('ca_1', false).enabled, false);

  const summary = engine.summarize(NOW);
  assert.equal(summary.total, 1);
  assert.equal(summary.enabled, 0);
  assert.equal(summary.totalPages, 42);
  assert.equal(summary.totalRetries, 0);
  assert.equal(summary.totalCursorDuplicates, 0);

  assert.equal(engine.removeConnection('ca_1'), true);
  assert.equal(engine.getBatchState('ca_1'), undefined);
  assert.equal(engine.removeConnection('ca_1'), false);
});
