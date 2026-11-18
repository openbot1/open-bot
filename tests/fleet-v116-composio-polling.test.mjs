/**
 * Composio polling v3 tests (v1.16, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Add trigger: validation (interval < 1000ms lỗi, trùng id lỗi),
 *   trigger mới poll ngay (nextPollAt = now).
 * - Dedupe 2 lớp: trùng id → duplicate; event cũ hơn cửa sổ →
 *   stale; event mới → fresh; seen ring buffer cắt ở maxSeenIds.
 * - Backoff: lỗi nhân interval (có trần); đủ 10 lỗi liên tiếp →
 *   paused; poll thành công reset lỗi + interval về base.
 * - Catch-up có giới hạn: batch 250 event chỉ lấy 100 mới nhất.
 * - Due triggers: chỉ idle/backing-off tới hạn; paused/disabled
 *   không bao giờ due.
 * - Resume sau restart: trigger đang polling → idle + poll ngay;
 *   trigger quá hạn → poll ngay từ cursor cũ (cursor + seen giữ
 *   nguyên); paused/disabled giữ nguyên.
 * - Jitter xác định: cùng trigger id → cùng jitter.
 * - Persistence: save/load round-trip, file hỏng → null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v116-composio-polling.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  COMPOSIO_V13_DEFAULT_MAX_BACKOFF_MS,
  addComposioV13Trigger,
  applyComposioV13PollOutcome,
  composioV13BackoffIntervalMs,
  composioV13JitterMs,
  createComposioV13PollState,
  dedupeComposioV13Events,
  dueComposioV13Triggers,
  findComposioV13Trigger,
  loadComposioV13PollState,
  resumeComposioV13PollState,
  resumeComposioV13Trigger,
  saveComposioV13PollState,
  setComposioV13TriggerEnabled,
  summarizeComposioV13Poll,
} from '../packages/core/dist/fleetV13/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function tmpRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-poll-v13-')), 'team');
}

function makeState() {
  let state = createComposioV13PollState(T0);
  const added = addComposioV13Trigger(
    state,
    { triggerId: 'poll:gmail:ca_1', connectionId: 'ca_1', toolkit: 'gmail', triggerSlug: 'GMAIL_NEW_MESSAGE', baseIntervalMs: 300000 },
    T0,
  );
  assert.equal(added.ok, true, added.error ?? '');
  return added;
}

function ev(id, occurredAt) {
  return { id, occurredAt, payload: { id } };
}

test('add trigger: validation, duplicate rejected, new trigger polls immediately', () => {
  let state = createComposioV13PollState(T0);
  assert.equal(addComposioV13Trigger(state, { triggerId: '', connectionId: 'c', toolkit: 'gmail', triggerSlug: 'X', baseIntervalMs: 60000 }, T0).ok, false);
  assert.equal(addComposioV13Trigger(state, { triggerId: 't1', connectionId: 'c', toolkit: 'gmail', triggerSlug: 'X', baseIntervalMs: 500 }, T0).ok, false);
  const added = addComposioV13Trigger(state, { triggerId: 't1', connectionId: 'c', toolkit: 'gmail', triggerSlug: 'X', baseIntervalMs: 60000 }, T0);
  assert.equal(added.ok, true);
  assert.equal(added.trigger.status, 'idle');
  assert.equal(added.trigger.nextPollAt, T0);
  assert.equal(added.trigger.cursor, '');
  assert.equal(added.trigger.consecutiveErrors, 0);
  state = added.state;
  assert.equal(addComposioV13Trigger(state, { triggerId: 't1', connectionId: 'c', toolkit: 'gmail', triggerSlug: 'X', baseIntervalMs: 60000 }, T0).ok, false);
  assert.equal(findComposioV13Trigger(state, 't1')?.toolkit, 'gmail');
  assert.equal(findComposioV13Trigger(state, 'nope'), null);
});

test('dedupe: duplicates, stale (outside 24h window), fresh; seen ring buffer caps', () => {
  const seen = ['seen-1', 'seen-2'];
  const batch = [
    ev('seen-1', T0), // duplicate
    ev('old-1', T0 - 25 * 60 * 60 * 1000), // stale (> 24h)
    ev('fresh-1', T0),
    ev('fresh-2', T0 - 1000),
    { id: '', occurredAt: T0, payload: {} }, // no id → stale
  ];
  const res = dedupeComposioV13Events(batch, seen, T0);
  assert.deepEqual(res.fresh.map((e) => e.id), ['fresh-1', 'fresh-2']);
  assert.deepEqual(res.duplicates.map((e) => e.id), ['seen-1']);
  assert.equal(res.stale.length, 2);
  assert.deepEqual(res.seenIds, ['seen-1', 'seen-2', 'fresh-1', 'fresh-2']);

  // Ring buffer cắt ở maxSeenIds (giữ mới nhất).
  const capped = dedupeComposioV13Events([ev('n1', T0)], ['a', 'b', 'c'], T0, { maxSeenIds: 3 });
  assert.deepEqual(capped.seenIds, ['b', 'c', 'n1']);
});

test('backoff: errors double interval with cap; 10 consecutive errors pauses; success resets', () => {
  const { state, trigger } = makeState();
  assert.equal(composioV13BackoffIntervalMs(300000), 600000);
  assert.equal(composioV13BackoffIntervalMs(COMPOSIO_V13_DEFAULT_MAX_BACKOFF_MS), COMPOSIO_V13_DEFAULT_MAX_BACKOFF_MS);
  assert.equal(composioV13BackoffIntervalMs(1000, 2, 1500), 1500);

  let current = trigger;
  for (let i = 1; i <= 9; i++) {
    const res = applyComposioV13PollOutcome(current, { ok: false, events: [], cursor: '', error: `network fail ${i}` }, T0 + i * 1000);
    assert.equal(res.ok, false);
    current = res.trigger;
    assert.equal(current.status, 'backing-off');
    assert.equal(current.consecutiveErrors, i);
    assert.equal(current.pollCount, i);
  }
  // Lỗi thứ 10 → paused.
  const tenth = applyComposioV13PollOutcome(current, { ok: false, events: [], cursor: '', error: 'network fail 10' }, T0 + 10000);
  assert.equal(tenth.ok, false);
  assert.equal(tenth.trigger.status, 'paused');
  assert.equal(tenth.trigger.consecutiveErrors, 10);
  assert.match(tenth.error, /pause sau 10 lỗi/);

  // Resume → idle, poll ngay, lỗi reset.
  const resumed = resumeComposioV13Trigger(tenth.trigger, T0 + 11000);
  assert.equal(resumed.status, 'idle');
  assert.equal(resumed.consecutiveErrors, 0);
  assert.equal(resumed.nextPollAt, T0 + 11000);

  // Poll thành công sau vài lỗi → reset interval về base.
  let t2 = trigger;
  const err = applyComposioV13PollOutcome(t2, { ok: false, events: [], cursor: '', error: 'boom' }, T0);
  t2 = err.trigger;
  assert.equal(t2.currentIntervalMs, 600000);
  const ok = applyComposioV13PollOutcome(t2, { ok: true, events: [ev('e1', T0)], cursor: 'cur-1', error: '' }, T0 + 1000);
  assert.equal(ok.ok, true);
  assert.equal(ok.trigger.status, 'idle');
  assert.equal(ok.trigger.currentIntervalMs, 300000);
  assert.equal(ok.trigger.consecutiveErrors, 0);
  assert.equal(ok.trigger.cursor, 'cur-1');
  assert.equal(ok.trigger.lastPollAt, T0 + 1000);
  assert.equal(ok.fresh.length, 1);
  assert.equal(ok.trigger.deliveredCount, 1);
});

test('poll success: dedupe counts, catch-up caps batch at 100 newest, cursor advances', () => {
  const { trigger } = makeState();
  // Batch 250 event: 100 mới nhất được lấy, phần còn lại chờ poll sau.
  const big = Array.from({ length: 250 }, (_, i) => ev(`ev-${i}`, T0 - i * 1000));
  const res = applyComposioV13PollOutcome(
    trigger,
    { ok: true, events: big, cursor: 'cur-big', error: '' },
    T0,
    { maxCatchUpEvents: 100 },
  );
  assert.equal(res.ok, true);
  assert.equal(res.fresh.length, 100);
  assert.equal(res.fresh[0].id, 'ev-0'); // mới nhất trước
  assert.equal(res.trigger.cursor, 'cur-big');

  // Poll lại cùng batch (đã dedupe) → 0 fresh, toàn duplicate.
  const again = applyComposioV13PollOutcome(
    res.trigger,
    { ok: true, events: big.slice(0, 100), cursor: 'cur-big', error: '' },
    T0 + 1000,
  );
  assert.equal(again.ok, true);
  assert.equal(again.fresh.length, 0);
  assert.equal(again.deduped, 100);
  assert.equal(again.trigger.dedupedCount, 100);
});

test('due triggers: only idle/backing-off past nextPollAt; paused/disabled never due', () => {
  let state = createComposioV13PollState(T0);
  const a = addComposioV13Trigger(state, { triggerId: 'due-1', connectionId: 'c1', toolkit: 'gmail', triggerSlug: 'X', baseIntervalMs: 60000 }, T0);
  state = a.state;
  const b = addComposioV13Trigger(state, { triggerId: 'future-1', connectionId: 'c1', toolkit: 'slack', triggerSlug: 'Y', baseIntervalMs: 3600000 }, T0);
  state = b.state;
  // Đẩy future-1 ra xa tương lai bằng một poll thành công (nextPollAt = now + base).
  const future = findComposioV13Trigger(state, 'future-1');
  const polled = applyComposioV13PollOutcome(future, { ok: true, events: [], cursor: '', error: '' }, T0);
  state = { ...state, triggers: state.triggers.map((t) => (t.triggerId === 'future-1' ? polled.trigger : t)) };
  // Disable due-1 → không due nữa; bật lại → due.
  const disabled = setComposioV13TriggerEnabled(findComposioV13Trigger(state, 'due-1'), false, T0);
  assert.equal(disabled.status, 'disabled');
  state = { ...state, triggers: state.triggers.map((t) => (t.triggerId === 'due-1' ? disabled : t)) };
  assert.deepEqual(dueComposioV13Triggers(state, T0).map((t) => t.triggerId), []);
  const enabled = setComposioV13TriggerEnabled(findComposioV13Trigger(state, 'due-1'), true, T0);
  assert.equal(enabled.status, 'idle');
  state = { ...state, triggers: state.triggers.map((t) => (t.triggerId === 'due-1' ? enabled : t)) };
  assert.deepEqual(dueComposioV13Triggers(state, T0).map((t) => t.triggerId), ['due-1']);
  // future-1 chưa tới hạn.
  assert.equal(dueComposioV13Triggers(state, T0 + 60000).length, 1);
});

test('resume after restart: polling→idle+immediate, overdue→immediate from saved cursor, paused kept', () => {
  let state = createComposioV13PollState(T0);
  const a = addComposioV13Trigger(state, { triggerId: 'hung-1', connectionId: 'c1', toolkit: 'gmail', triggerSlug: 'X', baseIntervalMs: 60000 }, T0);
  state = a.state;
  const b = addComposioV13Trigger(state, { triggerId: 'paused-1', connectionId: 'c1', toolkit: 'slack', triggerSlug: 'Y', baseIntervalMs: 60000 }, T0);
  state = b.state;
  // hung-1 đang polling lúc app tắt (treo); paused-1 đã pause với cursor + seen.
  const hung = { ...findComposioV13Trigger(state, 'hung-1'), status: 'polling', cursor: 'cur-hung', seenIds: ['s1'] };
  let paused = findComposioV13Trigger(state, 'paused-1');
  for (let i = 0; i < 10; i++) {
    paused = applyComposioV13PollOutcome(paused, { ok: false, events: [], cursor: '', error: 'down' }, T0 + i).trigger;
  }
  assert.equal(paused.status, 'paused');
  state = {
    ...state,
    triggers: state.triggers.map((t) =>
      t.triggerId === 'hung-1' ? hung : t.triggerId === 'paused-1' ? paused : t,
    ),
  };
  const resumed = resumeComposioV13PollState(state, T0 + 3600000);
  assert.deepEqual(resumed.overdue, ['hung-1']);
  assert.deepEqual(resumed.stillWaiting, ['paused-1']);
  const hungAfter = findComposioV13Trigger(resumed.state, 'hung-1');
  assert.equal(hungAfter.status, 'idle');
  assert.equal(hungAfter.nextPollAt, T0 + 3600000);
  assert.equal(hungAfter.cursor, 'cur-hung'); // cursor giữ nguyên — không quét lại từ đầu
  assert.deepEqual(hungAfter.seenIds, ['s1']);
  assert.equal(findComposioV13Trigger(resumed.state, 'paused-1').status, 'paused');
  assert.match(resumed.summary, /1 trigger quá hạn/);

  const summary = summarizeComposioV13Poll(resumed.state);
  assert.equal(summary.triggerCount, 2);
  assert.equal(summary.pausedCount, 1);
  assert.match(summary.summary, /2 trigger/);
});

test('jitter deterministic; persistence round-trip', () => {
  assert.equal(composioV13JitterMs('poll:gmail:ca_1', 300000), composioV13JitterMs('poll:gmail:ca_1', 300000));
  assert.ok(Math.abs(composioV13JitterMs('poll:gmail:ca_1', 300000)) <= 30000);
  assert.ok(Math.abs(composioV13JitterMs('other', 300000)) <= 30000);

  const { state } = makeState();
  const root = tmpRoot();
  saveComposioV13PollState(root, state);
  const loaded = loadComposioV13PollState(root);
  assert.ok(loaded);
  assert.equal(loaded.triggers.length, 1);
  assert.equal(loaded.triggers[0].triggerId, 'poll:gmail:ca_1');
  assert.equal(loaded.triggers[0].baseIntervalMs, 300000);
  fs.writeFileSync(path.join(root, 'composio-poll-v116.json'), 'nope');
  assert.equal(loadComposioV13PollState(root), null);
  assert.equal(loadComposioV13PollState(path.join(root, 'missing')), null);
});
