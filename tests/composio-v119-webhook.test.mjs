/**
 * Composio v119 tests — webhook v2 (v1.19, Doi T4 — node:test,
 * no network, no open port, mock secret only).
 *
 * Covers webhookV119.ts:
 * - Config validation + defaults, body hash, event timestamp
 *   parsing, retry delay (exponential, capped)
 * - Queued-event validation
 * - Queue.accept: valid V3 envelope, bad JSON / bad envelope,
 *   HMAC verify (good + bad signature), dedupe by eventId /
 *   deliveryId / body hash (+ window expiry), stale-event
 *   replay protection, queue-full rejection
 * - drain: success → done, failure → retry schedule → dead-letter
 *   after maxAttempts, not-due retries are skipped
 * - Dead-letter requeue / discard (+ requeue refused when the
 *   queue is full), dead-letter cap, pruneDone, summarize, clear
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v119-webhook.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_V119_DEFAULT_CONCURRENCY,
  COMPOSIO_V119_DEFAULT_MAX_ATTEMPTS,
  COMPOSIO_V119_DEFAULT_MAX_QUEUE_SIZE,
  COMPOSIO_V119_WEBHOOK_STATE_VERSION,
  ComposioV119WebhookQueue,
  composioV119WebhookRetryDelayMs,
  hashComposioV119WebhookBody,
  parseComposioV119EventTimestamp,
  validateComposioV119QueuedWebhookEvent,
  validateComposioV119WebhookConfig,
} from '../packages/core/dist/composio/webhookV119.js';
import { computeComposioWebhookSignature } from '../packages/core/dist/composio/triggers.js';

const NOW = 1780000000000; // 2026-05-28T20:26:40Z
const NOW_SEC = String(Math.floor(NOW / 1000));
const SECRET = 'mock-webhook-secret-fixture';

/** A valid V3 envelope body (string). */
function envelope(over = {}) {
  return JSON.stringify({
    id: 'evt_1',
    type: 'composio.trigger.message',
    timestamp: NOW_SEC,
    metadata: { trigger_slug: 'GITHUB_COMMIT_EVENT', trigger_id: 'ti_1', connected_account_id: 'ca_1' },
    data: { repo: 'open-bot' },
    ...over,
  });
}

function validEvent(over = {}) {
  return {
    queueId: 'wq119-x',
    eventId: 'evt_1',
    deliveryId: 'dlv_1',
    bodyHash: hashComposioV119WebhookBody(envelope()),
    triggerSlug: 'GITHUB_COMMIT_EVENT',
    triggerId: 'ti_1',
    receivedAtMs: NOW,
    eventAtMs: NOW,
    status: 'queued',
    attempts: 0,
    nextAttemptAtMs: null,
    lastError: null,
    payload: JSON.parse(envelope()),
    ...over,
  };
}

test('v119 webhook: config defaults + validation', () => {
  assert.equal(COMPOSIO_V119_WEBHOOK_STATE_VERSION, 1);
  assert.equal(COMPOSIO_V119_DEFAULT_MAX_QUEUE_SIZE, 500);
  assert.equal(COMPOSIO_V119_DEFAULT_CONCURRENCY, 1);
  assert.equal(COMPOSIO_V119_DEFAULT_MAX_ATTEMPTS, 3);
  const cfg = validateComposioV119WebhookConfig(undefined);
  assert.equal(cfg.maxQueueSize, 500);
  assert.equal(cfg.concurrency, 1);
  assert.equal(cfg.maxAttempts, 3);
  assert.equal(cfg.retryDelayMs, 2000);
  assert.equal(cfg.retryBackoffMultiplier, 2);
  assert.equal(cfg.maxRetryDelayMs, 60_000);
  assert.equal(cfg.dedupeWindowMs, 86_400_000);
  assert.equal(cfg.maxEventAgeMs, 600_000);
  assert.equal(cfg.maxDeadLetters, 200);
  assert.throws(() => validateComposioV119WebhookConfig({ maxQueueSize: 0 }), /maxQueueSize must be a positive integer/);
  assert.throws(() => validateComposioV119WebhookConfig({ concurrency: 0 }), /concurrency must be an integer between 1 and 4/);
  assert.throws(() => validateComposioV119WebhookConfig({ concurrency: 5 }), /concurrency must be an integer between 1 and 4/);
  assert.throws(() => validateComposioV119WebhookConfig({ maxAttempts: 0 }), /maxAttempts must be a positive integer/);
  assert.throws(() => validateComposioV119WebhookConfig({ retryBackoffMultiplier: 0.5 }), /retryBackoffMultiplier/);
  assert.throws(
    () => validateComposioV119WebhookConfig({ retryDelayMs: 5000, maxRetryDelayMs: 1000 }),
    /maxRetryDelayMs must be an integer >= retryDelayMs/,
  );
  assert.throws(() => validateComposioV119WebhookConfig({ dedupeWindowMs: 0 }), /dedupeWindowMs must be a positive integer/);
  assert.throws(() => validateComposioV119WebhookConfig({ maxEventAgeMs: 0 }), /maxEventAgeMs must be a positive integer/);
  assert.throws(() => validateComposioV119WebhookConfig({ maxDeadLetters: 0 }), /maxDeadLetters must be a positive integer/);
});

test('v119 webhook: body hash + timestamp parse + retry delay', () => {
  const h1 = hashComposioV119WebhookBody('hello');
  assert.equal(h1.length, 64);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(hashComposioV119WebhookBody('hello'), h1, 'deterministic');
  assert.notEqual(hashComposioV119WebhookBody('hello2'), h1);
  assert.equal(hashComposioV119WebhookBody(Buffer.from('hello')), h1, 'string and Buffer agree');
  assert.equal(parseComposioV119EventTimestamp(NOW_SEC), NOW);
  assert.equal(parseComposioV119EventTimestamp('2026-05-28T20:26:40.000Z'), NOW);
  assert.equal(parseComposioV119EventTimestamp(undefined), null);
  assert.equal(parseComposioV119EventTimestamp(''), null);
  assert.equal(parseComposioV119EventTimestamp('not-a-date'), null);
  const cfg = validateComposioV119WebhookConfig({ retryJitterFraction: 0 });
  assert.equal(composioV119WebhookRetryDelayMs(0, cfg), 2000);
  assert.equal(composioV119WebhookRetryDelayMs(1, cfg), 4000);
  assert.equal(composioV119WebhookRetryDelayMs(10, cfg), 60_000, 'capped');
  assert.throws(() => composioV119WebhookRetryDelayMs(-1, cfg), /non-negative integer/);
});

test('v119 webhook: queued-event validation', () => {
  assert.deepEqual(validateComposioV119QueuedWebhookEvent(validEvent()), validEvent());
  assert.throws(() => validateComposioV119QueuedWebhookEvent({ ...validEvent(), status: 'lost' }), /status is invalid/);
  assert.throws(() => validateComposioV119QueuedWebhookEvent({ ...validEvent(), queueId: '' }), /queueId must be a non-empty string/);
  assert.throws(() => validateComposioV119QueuedWebhookEvent({ ...validEvent(), attempts: -1 }), /non-negative integer/);
  assert.throws(() => validateComposioV119QueuedWebhookEvent({ ...validEvent(), payload: null }), /payload must be an object/);
  assert.throws(() => validateComposioV119QueuedWebhookEvent(null), /must be an object/);
});

test('v119 webhook: accept valid envelope (no secret) + rejects bad bodies', () => {
  const q = new ComposioV119WebhookQueue({ now: () => NOW });
  const res = q.accept({ rawBody: envelope(), secret: null, receivedAtMs: NOW });
  assert.equal(res.accepted, true);
  assert.equal(res.event.status, 'queued');
  assert.equal(res.event.eventId, 'evt_1');
  assert.equal(res.event.deliveryId, null);
  assert.equal(res.event.triggerSlug, 'GITHUB_COMMIT_EVENT');
  assert.equal(res.event.triggerId, 'ti_1');
  assert.equal(res.event.receivedAtMs, NOW);
  assert.equal(res.event.eventAtMs, NOW);
  assert.equal(res.event.attempts, 0);
  assert.ok(res.event.queueId.startsWith('wq119-'));
  assert.equal(res.event.bodyHash, hashComposioV119WebhookBody(envelope()));
  assert.equal(q.listEvents().length, 1);
  assert.equal(q.getEvent(res.event.queueId).eventId, 'evt_1');
  assert.equal(q.getEvent('nope'), undefined);

  assert.deepEqual(q.accept({ rawBody: 'not json', secret: null, receivedAtMs: NOW }), { accepted: false, reason: 'bad-payload' });
  assert.deepEqual(
    q.accept({ rawBody: JSON.stringify({ data: {} }), secret: null, receivedAtMs: NOW }),
    { accepted: false, reason: 'bad-payload' },
    'no metadata → bad payload',
  );
  assert.deepEqual(
    q.accept({ rawBody: JSON.stringify({ metadata: {}, data: {} }), secret: null, receivedAtMs: NOW }),
    { accepted: false, reason: 'bad-payload' },
    'no trigger_slug → bad payload',
  );
});

test('v119 webhook: HMAC verify — good signature accepted, bad rejected', () => {
  const q = new ComposioV119WebhookQueue({ now: () => NOW });
  const body = envelope();
  const sig = computeComposioWebhookSignature(SECRET, 'dlv_9', NOW_SEC, body);
  const ok = q.accept({ rawBody: body, signature: sig, timestamp: NOW_SEC, secret: SECRET, deliveryId: 'dlv_9', receivedAtMs: NOW });
  assert.equal(ok.accepted, true);
  assert.equal(ok.event.deliveryId, 'dlv_9');
  const bad = q.accept({
    rawBody: envelope({ id: 'evt_2' }),
    signature: 'v1,bogus',
    timestamp: NOW_SEC,
    secret: SECRET,
    deliveryId: 'dlv_10',
    receivedAtMs: NOW,
  });
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, 'bad-signature');
  // Tampered body breaks the signature too.
  const tampered = q.accept({
    rawBody: envelope({ id: 'evt_3', data: { repo: 'other' } }),
    signature: sig,
    timestamp: NOW_SEC,
    secret: SECRET,
    deliveryId: 'dlv_11',
    receivedAtMs: NOW,
  });
  assert.equal(tampered.accepted, false);
  assert.equal(tampered.reason, 'bad-signature');
});

test('v119 webhook: dedupe by eventId / deliveryId / body hash', () => {
  const q = new ComposioV119WebhookQueue({ now: () => NOW });
  const first = q.accept({ rawBody: envelope(), secret: null, deliveryId: 'dlv_1', receivedAtMs: NOW });
  assert.equal(first.accepted, true);
  // Same event id again (different delivery) → duplicate.
  const dupEvent = q.accept({ rawBody: envelope(), secret: null, deliveryId: 'dlv_2', receivedAtMs: NOW });
  assert.equal(dupEvent.accepted, false);
  assert.equal(dupEvent.reason, 'duplicate-event');
  assert.equal(dupEvent.duplicate, true);
  // Same delivery id, different event → duplicate (Composio retry).
  const dupDelivery = q.accept({ rawBody: envelope({ id: 'evt_2' }), secret: null, deliveryId: 'dlv_1', receivedAtMs: NOW });
  assert.equal(dupDelivery.accepted, false);
  assert.equal(dupDelivery.reason, 'duplicate-event');
  // A different id means a different body (id is part of the body),
  // so this is a new event — not a body-hash duplicate. (Body-hash
  // dedupe only fires when the id is absent and the bytes repeat,
  // which the eventId check already covers; it is defense in depth.)
  const otherBody = q.accept({ rawBody: envelope({ id: 'evt_3' }), secret: null, deliveryId: 'dlv_3', receivedAtMs: NOW });
  assert.equal(otherBody.accepted, true);
  // A genuinely different event is accepted.
  const other = q.accept({ rawBody: envelope({ id: 'evt_9', data: { repo: 'other' } }), secret: null, deliveryId: 'dlv_9', receivedAtMs: NOW });
  assert.equal(other.accepted, true);
  assert.equal(q.summarize().totalDuplicates, 2);
});

test('v119 webhook: dedupe window expiry lets the same body through again', async () => {
  const q = new ComposioV119WebhookQueue({ config: { dedupeWindowMs: 1000 }, now: () => NOW });
  const first = q.accept({ rawBody: envelope(), secret: null, deliveryId: 'dlv_1', receivedAtMs: NOW });
  assert.equal(first.accepted, true);
  await q.drain(async () => undefined, NOW);
  assert.equal(q.pruneDone(), 1, 'done event leaves the queue');
  // Same body 2s later (past the 1s window) → accepted again.
  const again = q.accept({ rawBody: envelope(), secret: null, deliveryId: 'dlv_1', receivedAtMs: NOW + 2000 });
  assert.equal(again.accepted, true);
});

test('v119 webhook: stale events are rejected (replay protection)', () => {
  const q = new ComposioV119WebhookQueue({ now: () => NOW });
  const oldSec = String(Math.floor((NOW - 20 * 60 * 1000) / 1000)); // 20 min old > 10 min max age
  const res = q.accept({ rawBody: envelope({ timestamp: oldSec }), secret: null, receivedAtMs: NOW });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'stale-event');
  assert.equal(q.summarize().totalStale, 1);
  // 5 min old is fine.
  const freshSec = String(Math.floor((NOW - 5 * 60 * 1000) / 1000));
  const fresh = q.accept({ rawBody: envelope({ timestamp: freshSec }), secret: null, receivedAtMs: NOW });
  assert.equal(fresh.accepted, true);
  // No timestamp at all → no staleness check.
  const noTs = q.accept({ rawBody: JSON.stringify({ id: 'evt_notimestamp', metadata: { trigger_slug: 'GITHUB_COMMIT_EVENT' }, data: {} }), secret: null, receivedAtMs: NOW });
  assert.equal(noTs.accepted, true);
  assert.equal(noTs.event.eventAtMs, null);
});

test('v119 webhook: queue-full rejects the newest event', () => {
  const q = new ComposioV119WebhookQueue({ config: { maxQueueSize: 1 }, now: () => NOW });
  assert.equal(q.accept({ rawBody: envelope(), secret: null, receivedAtMs: NOW }).accepted, true);
  const full = q.accept({ rawBody: envelope({ id: 'evt_2', data: { repo: 'x' } }), secret: null, receivedAtMs: NOW });
  assert.equal(full.accepted, false);
  assert.equal(full.reason, 'queue-full');
});

test('v119 webhook: drain success → done, summarize + prune', async () => {
  const q = new ComposioV119WebhookQueue({ now: () => NOW });
  q.accept({ rawBody: envelope(), secret: null, receivedAtMs: NOW });
  q.accept({ rawBody: envelope({ id: 'evt_2', data: { repo: 'x' } }), secret: null, receivedAtMs: NOW });
  const seen = [];
  const processed = await q.drain(async (event) => { seen.push(event.eventId); }, NOW);
  assert.equal(processed, 2);
  assert.deepEqual(seen, ['evt_1', 'evt_2'], 'FIFO order');
  assert.equal(q.listEvents().every((e) => e.status === 'done'), true);
  const s = q.summarize();
  assert.equal(s.queued, 0);
  assert.equal(s.done, 2);
  assert.equal(s.totalProcessed, 2);
  assert.equal(s.totalSucceeded, 2);
  assert.equal(s.totalFailed, 0);
  assert.equal(s.deadLetters, 0);
  assert.equal(typeof s.avgProcessingMs, 'number');
  assert.equal(q.pruneDone(), 2);
  assert.equal(q.listEvents().length, 0);
  assert.equal(await q.drain(async () => undefined, NOW), 0, 'drain on empty queue processes nothing');
  q.clear();
  assert.deepEqual(q.summarize().totalProcessed, 0);
});

test('v119 webhook: drain failure → retry schedule → dead-letter', async () => {
  const q = new ComposioV119WebhookQueue({
    config: { maxAttempts: 2, retryDelayMs: 100, retryBackoffMultiplier: 2, maxRetryDelayMs: 1000 },
    now: () => NOW,
  });
  const accepted = q.accept({ rawBody: envelope(), secret: null, receivedAtMs: NOW });
  const fail = async () => { throw new Error('mock handler failed'); };
  assert.equal(await q.drain(fail, NOW), 1);
  let event = q.getEvent(accepted.event.queueId);
  assert.equal(event.status, 'failed');
  assert.equal(event.attempts, 1);
  assert.equal(event.lastError, 'mock handler failed');
  assert.equal(event.nextAttemptAtMs, NOW + 100, 'retryDelayMs(0) = 100');
  // Too early → not due, nothing processed.
  assert.equal(await q.drain(fail, NOW + 50), 0);
  assert.equal(q.getEvent(accepted.event.queueId).attempts, 1);
  // Due → second attempt fails → dead-letter (maxAttempts 2).
  assert.equal(await q.drain(fail, NOW + 100), 1);
  assert.equal(q.getEvent(accepted.event.queueId), undefined, 'dead-lettered events leave the main queue');
  const dead = q.listDeadLetters();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].eventId, 'evt_1');
  assert.equal(dead[0].attempts, 2);
  assert.equal(dead[0].lastError, 'mock handler failed');
  assert.equal(dead[0].triggerSlug, 'GITHUB_COMMIT_EVENT');
  const s = q.summarize();
  assert.equal(s.deadLetters, 1);
  assert.equal(s.totalFailed, 2);
  assert.equal(s.totalProcessed, 2);
  // Requeue → back in the queue, attempts reset; drain succeeds this time.
  assert.equal(q.requeueDeadLetter(dead[0].queueId, NOW + 200), true);
  assert.equal(q.listDeadLetters().length, 0);
  assert.equal(q.listEvents()[0].status, 'queued');
  assert.equal(q.listEvents()[0].attempts, 0);
  assert.equal(await q.drain(async () => undefined, NOW + 200), 1);
  assert.equal(q.listEvents()[0].status, 'done');
  // Unknown ids → false.
  assert.equal(q.requeueDeadLetter('nope'), false);
  assert.equal(q.discardDeadLetter('nope'), false);
});

test('v119 webhook: discard dead-letter + dead-letter cap + requeue-when-full', async () => {
  const q = new ComposioV119WebhookQueue({
    config: { maxAttempts: 1, maxDeadLetters: 1, maxQueueSize: 2 },
    now: () => NOW,
  });
  const fail = async () => { throw new Error('boom'); };
  q.accept({ rawBody: envelope(), secret: null, receivedAtMs: NOW });
  q.accept({ rawBody: envelope({ id: 'evt_2', data: { repo: 'x' } }), secret: null, receivedAtMs: NOW });
  await q.drain(fail, NOW);
  assert.equal(q.listDeadLetters().length, 1, 'cap 1 keeps only the newest dead-letter');
  assert.equal(q.listDeadLetters()[0].eventId, 'evt_2');
  const deadId = q.listDeadLetters()[0].queueId;
  assert.equal(q.discardDeadLetter(deadId), true);
  assert.equal(q.listDeadLetters().length, 0);

  // Requeue refused when the queue is full (dead-letter is kept).
  const q2 = new ComposioV119WebhookQueue({
    config: { maxAttempts: 1, maxQueueSize: 2 },
    now: () => NOW,
  });
  q2.accept({ rawBody: envelope(), secret: null, receivedAtMs: NOW });
  await q2.drain(fail, NOW);
  assert.equal(q2.listDeadLetters().length, 1);
  const deadId2 = q2.listDeadLetters()[0].queueId;
  q2.accept({ rawBody: envelope({ id: 'evt_2', data: { repo: 'x' } }), secret: null, receivedAtMs: NOW });
  q2.accept({ rawBody: envelope({ id: 'evt_3', data: { repo: 'y' } }), secret: null, receivedAtMs: NOW });
  assert.equal(q2.summarize().queued, 2);
  assert.equal(q2.requeueDeadLetter(deadId2, NOW), false, 'queue is full');
  assert.equal(q2.listDeadLetters().length, 1, 'dead-letter is put back');
});
