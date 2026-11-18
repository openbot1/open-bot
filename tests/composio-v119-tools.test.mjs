/**
 * Composio v119 tests — tools wiring (v1.19, Doi T4 — node:test,
 * no network, no real key, mock-only).
 *
 * Covers packages/tools/src/composioV119Tools.ts end to end through
 * the Tool interface (the same surface the agent loop calls):
 * - Registry: 8 v119 tools, unique names, all in ALL_TOOLS,
 *   ALL_TOOLS = 592 (556 v1.18 + 36 v119 across teams, incl. 8
 *   T4 composio), createDefaultTools() binds all 592
 * - Mock toolkit list/execute (samples, echo, error strings)
 * - Poll batch (multi-page batch + retry delay table + next poll)
 * - Trigger instances v2 (register → transition → start/finish
 *   run → summary, shared in-session store)
 * - OAuth refresh v2 (store mock token → refresh → status →
 *   fail → reset; mock Vault only, never a real token)
 * - Webhook v2 (accept → drain → summary, HMAC accept, bad body)
 * - Toolkit prefs per-user (set/get/bulk/list-enabled/reset)
 * - Usage metering (record → report → summary, quota override)
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * (esbuild transpile works too; see the v119-t4 notes. The tools
 * dist resolves '@open-bot/core' through the worktree-local
 * packages/node_modules shim — the root node_modules is symlinked
 * to the main repo, whose dist is stale v118.)
 * then: node --test tests/composio-v119-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_V119_TOOLS,
  COMPOSIO_V119_TOOL_NAMES,
  createComposioV119Tools,
  isComposioV119ToolName,
} from '../packages/tools/dist/composioV119Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { computeComposioWebhookSignature } from '../packages/core/dist/composio/triggers.js';

const NOW = 1780000000000; // 2026-05-28T20:26:40Z
const NOW_SEC = String(Math.floor(NOW / 1000));

/** Run one v119 tool by name on a fresh tool set; parse JSON results. */
async function runTool(tools, name, args) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  const raw = await tool.execute(args);
  assert.equal(typeof raw, 'string');
  return raw.startsWith('{') ? JSON.parse(raw) : raw;
}

/** Fresh tools (fresh in-session stores) per test. */
function freshTools() {
  return createComposioV119Tools();
}

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

test('v119 tools: 8 tools, unique names, in ALL_TOOLS (592)', () => {
  assert.deepEqual([...COMPOSIO_V119_TOOL_NAMES], [
    'composio_mock_toolkit_list_v119',
    'composio_mock_toolkit_execute_v119',
    'composio_poll_batch_v119',
    'composio_trigger_instances_v2',
    'composio_oauth_refresh_v2',
    'composio_webhook_queue_v2',
    'composio_toolkit_prefs_v119',
    'composio_usage_v119',
  ]);
  assert.equal(COMPOSIO_V119_TOOLS.length, 8);
  assert.equal(createComposioV119Tools().length, 8);
  assert.equal(new Set(COMPOSIO_V119_TOOLS.map((t) => t.definition.name)).size, 8);
  for (const name of COMPOSIO_V119_TOOL_NAMES) {
    assert.equal(isComposioV119ToolName(name), true);
  }
  assert.equal(isComposioV119ToolName('composio_mock_toolkit_execute_v118'), false);
  assert.equal(isComposioV119ToolName(''), false);
  // Registry pin — 592 is the true count in this worktree:
  // 556 (v1.18) + 36 v119 tools across all teams (incl. these 8).
  // NOTE for the merge coordinator: ~30 older tests still pin 556
  // and need the same re-pin at merge time if the count moves.
  assert.equal(ALL_TOOLS.length, 899, 'v1.19 merge: 584 + 20 = 653 (12 memory v18 + 8 composio v119)'); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  for (const name of COMPOSIO_V119_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `${name} must be in ALL_TOOLS`);
  }
  const bound = createDefaultTools();
  assert.equal(bound.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  for (const name of COMPOSIO_V119_TOOL_NAMES) {
    assert.ok(bound.some((t) => t.definition.name === name), `${name} must be in createDefaultTools()`);
  }
  for (const t of COMPOSIO_V119_TOOLS) assert.equal(t.needsApproval, false);
});

test('v119 tools: mock toolkit list + execute', async () => {
  const tools = freshTools();
  const list = await runTool(tools, 'composio_mock_toolkit_list_v119', {});
  assert.equal(list.mock, true);
  assert.equal(list.live, false);
  assert.equal(list.totalToolkits, 3);
  assert.equal(list.totalSlugs, 30);
  assert.equal(list.writeSlugs + list.readSlugs, 30);
  assert.deepEqual(list.toolkits.map((t) => t.slug), ['wrike', 'bamboohr', 'ringcentral']);
  for (const t of list.toolkits) {
    assert.equal(t.candidateToolSlugs.length, 10);
    assert.ok(['oauth2', 'api-key', 'oauth2-or-api-key'].includes(t.authKind));
    assert.ok(t.authNote.length > 20);
  }
  const exec = await runTool(tools, 'composio_mock_toolkit_execute_v119', {
    toolkit: 'wrike',
    slug: 'WRIKE_LIST_TASKS',
    args: { limit: 2 },
  });
  assert.equal(exec.mock, true);
  assert.equal(exec.live, false);
  assert.equal(exec.data.total, 1);
  assert.deepEqual(exec.data.echo, { limit: 2 });
  assert.equal(exec.needsApproval, false);
  const write = await runTool(tools, 'composio_mock_toolkit_execute_v119', {
    toolkit: 'ringcentral',
    slug: 'RINGCENTRAL_SEND_SMS',
    args: { to: '+1' },
  });
  assert.equal(write.needsApproval, true);
  assert.equal(write.data.sent, true);
  // Unknown slug/toolkit → "Error: ..." string, not a throw.
  const badSlug = await runTool(tools, 'composio_mock_toolkit_execute_v119', { toolkit: 'wrike', slug: 'WRIKE_NOPE' });
  assert.match(badSlug, /^Error: Unknown mock Composio v119 tool slug/);
  const badToolkit = await runTool(tools, 'composio_mock_toolkit_execute_v119', { toolkit: 'gmail', slug: 'GMAIL_SEND_MESSAGE' });
  assert.match(badToolkit, /^Error: Unknown mock Composio v119 toolkit/);
  const missing = await runTool(tools, 'composio_mock_toolkit_execute_v119', { toolkit: 'wrike' });
  assert.match(missing, /^Error: Missing required argument: "slug"/);
});

test('v119 tools: poll batch — multi-page batch + retry table + next poll', async () => {
  const tools = freshTools();
  const res = await runTool(tools, 'composio_poll_batch_v119', {
    connectionId: 'ca_1',
    toolkit: 'gmail',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    pages: [
      { items: [{ id: 'a' }], cursor: 'c1' },
      { items: [{ id: 'b' }], cursor: null },
    ],
    nowMs: NOW,
  });
  assert.equal(res.mock, true);
  assert.equal(res.live, false);
  assert.deepEqual(res.batch.fresh.map((i) => i.id), ['a', 'b']);
  assert.equal(res.batch.pages, 2);
  assert.equal(res.batch.rawItems, 2);
  assert.equal(res.batch.stoppedOnCursorRepeat, false);
  assert.equal(res.batch.lastCursor, null);
  assert.ok(res.nextPollAtMs > NOW);
  assert.ok(res.nextIntervalMs > 0);
  assert.equal(res.totalNewItems, 2);
  assert.deepEqual(res.seenCursors, ['c1']);
  assert.deepEqual(res.retryDelaysMs, [1000, 2000, 4000]);
  // Cursor repeat stops the batch (page 2's items are discarded).
  const looped = await runTool(tools, 'composio_poll_batch_v119', {
    connectionId: 'ca_1',
    toolkit: 'gmail',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    pages: [
      { items: [{ id: 'a' }], cursor: 'c1' },
      { items: [{ id: 'b' }], cursor: 'c1' },
    ],
    nowMs: NOW,
  });
  assert.equal(looped.batch.stoppedOnCursorRepeat, true);
  assert.deepEqual(looped.batch.fresh.map((i) => i.id), ['a']);
  const missing = await runTool(tools, 'composio_poll_batch_v119', { connectionId: 'ca_1' });
  assert.match(missing, /^Error: Missing required argument/);
});

test('v119 tools: trigger instances v2 — full lifecycle in one session', async () => {
  const tools = freshTools();
  const reg = await runTool(tools, 'composio_trigger_instances_v2', {
    action: 'register',
    triggerId: 'ti_x',
    triggerSlug: 'GITHUB_COMMIT_EVENT',
    toolkit: 'github',
    connectionId: 'ca_1',
    label: 'X trigger',
    nowMs: NOW,
  });
  assert.equal(reg.mock, true);
  assert.equal(reg.instance.lifecycle, 'draft');
  const listed = await runTool(tools, 'composio_trigger_instances_v2', { action: 'list', nowMs: NOW });
  assert.equal(listed.total, 1);
  // Starting a run while drafted fails (not runnable).
  const notRunnable = await runTool(tools, 'composio_trigger_instances_v2', {
    action: 'start-run', triggerId: 'ti_x', eventId: 'evt_1', nowMs: NOW,
  });
  assert.match(notRunnable, /^Error: Trigger instance ti_x is not runnable/);
  const active = await runTool(tools, 'composio_trigger_instances_v2', {
    action: 'transition', triggerId: 'ti_x', lifecycle: 'active', reason: 'go live', nowMs: NOW,
  });
  assert.equal(active.instance.lifecycle, 'active');
  const started = await runTool(tools, 'composio_trigger_instances_v2', {
    action: 'start-run', triggerId: 'ti_x', eventId: 'evt_1', nowMs: NOW,
  });
  assert.ok(started.run.runId.startsWith('run119-'));
  assert.equal(started.instance.base.totalFired, 1);
  const finished = await runTool(tools, 'composio_trigger_instances_v2', {
    action: 'finish-run', triggerId: 'ti_x', runId: started.run.runId, status: 'success', nowMs: NOW + 500,
  });
  assert.equal(finished.instance.runs[0].status, 'success');
  const runs = await runTool(tools, 'composio_trigger_instances_v2', { action: 'runs', triggerId: 'ti_x', nowMs: NOW + 500 });
  assert.equal(runs.summary.total, 1);
  assert.equal(runs.summary.success, 1);
  assert.equal(runs.summary.avgDurationMs, 500);
  assert.equal(runs.runnable, true);
  const summary = await runTool(tools, 'composio_trigger_instances_v2', { action: 'summary', nowMs: NOW + 500 });
  assert.equal(summary.summary.total, 1);
  assert.equal(summary.summary.runnable, 1);
  const unknown = await runTool(tools, 'composio_trigger_instances_v2', { action: 'transition', triggerId: 'nope', lifecycle: 'active', nowMs: NOW });
  assert.match(unknown, /^Error: unknown trigger instance id/);
  const badAction = await runTool(tools, 'composio_trigger_instances_v2', { action: 'explode', nowMs: NOW });
  assert.match(badAction, /^Error: Unknown action/);
});

test('v119 tools: oauth refresh v2 — store → refresh → status → fail → reset', async () => {
  const tools = freshTools();
  const stored = await runTool(tools, 'composio_oauth_refresh_v2', {
    action: 'store-mock-token', connectionId: 'ca_1', toolkit: 'gmail', mockToken: 'mock-fixture-token', nowMs: NOW,
  });
  assert.equal(stored.mock, true);
  assert.equal(stored.stored, true);
  assert.equal(stored.hasToken, true);
  const refreshed = await runTool(tools, 'composio_oauth_refresh_v2', {
    action: 'refresh', connectionId: 'ca_1', toolkit: 'gmail', mockOutcome: 'success', expiresAtMs: NOW + 60_000, nowMs: NOW,
  });
  assert.equal(refreshed.outcome, 'refreshed');
  assert.equal(refreshed.tokenRotated, true);
  assert.equal(refreshed.oauth.state, 'connected');
  assert.equal(refreshed.oauth.expiresAtMs, NOW + 3600_000);
  assert.equal(refreshed.refresh.totalRefreshed, 1);
  const status = await runTool(tools, 'composio_oauth_refresh_v2', { action: 'status', connectionId: 'ca_1', nowMs: NOW });
  assert.equal(status.hasToken, true);
  assert.equal(status.refresh.totalRefreshed, 1);
  // Fail cycle (fresh OAuth entry, mock function throws).
  const failed = await runTool(tools, 'composio_oauth_refresh_v2', {
    action: 'refresh', connectionId: 'ca_1', toolkit: 'gmail', mockOutcome: 'fail', expiresAtMs: NOW + 60_000, nowMs: NOW,
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.tokenRotated, false);
  assert.equal(failed.oauth.state, 'expired');
  // Revoked: token is deleted from the mock Vault.
  const revoked = await runTool(tools, 'composio_oauth_refresh_v2', {
    action: 'refresh', connectionId: 'ca_1', toolkit: 'gmail', mockOutcome: 'revoked', expiresAtMs: NOW + 60_000, nowMs: NOW,
  });
  assert.equal(revoked.outcome, 'revoked');
  assert.equal(revoked.oauth.state, 'revoked');
  const afterRevoke = await runTool(tools, 'composio_oauth_refresh_v2', { action: 'status', connectionId: 'ca_1', nowMs: NOW });
  assert.equal(afterRevoke.hasToken, false);
  // No token at all → no-token outcome.
  const noToken = await runTool(tools, 'composio_oauth_refresh_v2', {
    action: 'refresh', connectionId: 'ca_2', toolkit: 'slack', mockOutcome: 'success', expiresAtMs: NOW + 60_000, nowMs: NOW,
  });
  assert.equal(noToken.outcome, 'no-token');
  assert.equal(noToken.refresh.needsReconnect, true);
  // Reset clears the error state (and any token left).
  const reset = await runTool(tools, 'composio_oauth_refresh_v2', { action: 'reset', connectionId: 'ca_1', toolkit: 'gmail', nowMs: NOW });
  assert.equal(reset.refresh.needsReconnect, false);
  assert.equal(reset.hasToken, false);
  const badAction = await runTool(tools, 'composio_oauth_refresh_v2', { action: 'explode', connectionId: 'ca_1', nowMs: NOW });
  assert.match(badAction, /^Error: Unknown action/);
});

test('v119 tools: webhook v2 — accept → drain → summary (+ HMAC, bad body)', async () => {
  const tools = freshTools();
  const accepted = await runTool(tools, 'composio_webhook_queue_v2', {
    action: 'accept', rawBody: envelope(), nowMs: NOW,
  });
  assert.equal(accepted.mock, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.event.eventId, 'evt_1');
  assert.equal(accepted.event.triggerSlug, 'GITHUB_COMMIT_EVENT');
  // Same body again → duplicate.
  const dup = await runTool(tools, 'composio_webhook_queue_v2', {
    action: 'accept', rawBody: envelope(), nowMs: NOW,
  });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'duplicate-event');
  const drained = await runTool(tools, 'composio_webhook_queue_v2', {
    action: 'drain', mockHandler: 'succeed', nowMs: NOW,
  });
  assert.equal(drained.processed, 1);
  assert.equal(drained.summary.done, 1);
  const summary = await runTool(tools, 'composio_webhook_queue_v2', { action: 'summary', nowMs: NOW });
  assert.equal(summary.summary.totalSucceeded, 1);
  assert.equal(summary.summary.totalProcessed, 1);
  // HMAC-signed delivery is accepted (mock secret supplied by the caller).
  const body2 = envelope({ id: 'evt_2' });
  const sig = computeComposioWebhookSignature('mock-secret', 'dlv_2', NOW_SEC, body2);
  const signed = await runTool(tools, 'composio_webhook_queue_v2', {
    action: 'accept', rawBody: body2, mockSecret: 'mock-secret', signature: sig, timestamp: NOW_SEC, deliveryId: 'dlv_2', nowMs: NOW,
  });
  assert.equal(signed.accepted, true);
  // Failing handler → dead-letter after maxAttempts (3).
  const tools2 = freshTools();
  await runTool(tools2, 'composio_webhook_queue_v2', { action: 'accept', rawBody: envelope(), nowMs: NOW });
  await runTool(tools2, 'composio_webhook_queue_v2', { action: 'drain', mockHandler: 'fail', nowMs: NOW });
  await runTool(tools2, 'composio_webhook_queue_v2', { action: 'drain', mockHandler: 'fail', nowMs: NOW + 2000 });
  await runTool(tools2, 'composio_webhook_queue_v2', { action: 'drain', mockHandler: 'fail', nowMs: NOW + 6000 });
  const dead = await runTool(tools2, 'composio_webhook_queue_v2', { action: 'dead-letters', nowMs: NOW + 6000 });
  assert.equal(dead.deadLetters.length, 1);
  assert.equal(dead.deadLetters[0].attempts, 3);
  const requeued = await runTool(tools2, 'composio_webhook_queue_v2', {
    action: 'requeue', queueId: dead.deadLetters[0].queueId, nowMs: NOW + 6000,
  });
  assert.equal(requeued.requeued, true);
  const discarded = await runTool(tools2, 'composio_webhook_queue_v2', {
    action: 'discard', queueId: dead.deadLetters[0].queueId, nowMs: NOW + 6000,
  });
  assert.equal(discarded.discarded, false, 'already requeued — nothing to discard');
  // Bad body → rejected, not a throw.
  const bad = await runTool(tools, 'composio_webhook_queue_v2', { action: 'accept', rawBody: 'not json', nowMs: NOW });
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, 'bad-payload');
});

test('v119 tools: toolkit prefs per-user — set/get/bulk/list-enabled/reset', async () => {
  const tools = freshTools();
  const set = await runTool(tools, 'composio_toolkit_prefs_v119', {
    action: 'set', userId: 'u1', toolkit: 'gmail', enabled: false, reason: 'off', nowMs: NOW,
  });
  assert.equal(set.mock, true);
  assert.equal(set.prefs.toolkits.length, 1);
  assert.equal(set.prefs.toolkits[0].enabled, false);
  const got = await runTool(tools, 'composio_toolkit_prefs_v119', { action: 'get', userId: 'u1', nowMs: NOW });
  assert.equal(got.prefs.toolkits[0].toolkit, 'gmail');
  const enabled = await runTool(tools, 'composio_toolkit_prefs_v119', {
    action: 'list-enabled', userId: 'u1', catalog: ['gmail', 'slack', 'notion'], nowMs: NOW,
  });
  assert.deepEqual(enabled.enabled, ['slack', 'notion']);
  assert.equal(enabled.total, 3);
  const bulk = await runTool(tools, 'composio_toolkit_prefs_v119', {
    action: 'bulk', userId: 'u1', toolkits: ['gmail', 'slack'], enabled: true, nowMs: NOW,
  });
  assert.equal(bulk.changed, 1, 'only gmail flips (slack was already default-on)');
  const cleared = await runTool(tools, 'composio_toolkit_prefs_v119', {
    action: 'clear', userId: 'u1', toolkit: 'gmail', nowMs: NOW,
  });
  assert.equal(cleared.cleared, true);
  const reset = await runTool(tools, 'composio_toolkit_prefs_v119', { action: 'reset', userId: 'u1', nowMs: NOW });
  assert.equal(reset.reset, true);
  const afterReset = await runTool(tools, 'composio_toolkit_prefs_v119', { action: 'get', userId: 'u1', nowMs: NOW });
  assert.equal(afterReset.prefs, null);
});

test('v119 tools: usage metering — record → report → summary (+ quota override)', async () => {
  const tools = freshTools();
  const r1 = await runTool(tools, 'composio_usage_v119', {
    action: 'record', userId: 'u1', toolkit: 'gmail', succeeded: true, mock: true, nowMs: NOW,
  });
  assert.equal(r1.mock, true);
  assert.equal(r1.allowed, true);
  assert.equal(r1.counter.calls, 1);
  assert.equal(r1.counter.mockCalls, 1);
  const r2 = await runTool(tools, 'composio_usage_v119', {
    action: 'record', userId: 'u1', toolkit: 'gmail', succeeded: false, mock: false, nowMs: NOW,
  });
  assert.equal(r2.counter.calls, 2);
  assert.equal(r2.counter.failed, 1);
  assert.equal(r2.counter.liveCalls, 1);
  // Quota override: cap 1 per toolkit → the 3rd call is blocked.
  const blocked = await runTool(tools, 'composio_usage_v119', {
    action: 'record', userId: 'u1', toolkit: 'gmail', succeeded: true, mock: true, dailyCapPerToolkit: 1, nowMs: NOW,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedBy, 'toolkit');
  const report = await runTool(tools, 'composio_usage_v119', { action: 'report', day: '2026-05-28', nowMs: NOW });
  assert.equal(report.report.totalCalls, 2);
  assert.equal(report.report.totalFailed, 1);
  assert.equal(report.report.totalBlocked, 1);
  assert.equal(report.report.byToolkit[0].key, 'gmail');
  const summary = await runTool(tools, 'composio_usage_v119', { action: 'summary', nowMs: NOW });
  assert.match(summary.summary, /2026-05-28: 2 calls \(1 live, 1 mock\), 1 failed, 1 blocked, 1 over quota/);
  const badAction = await runTool(tools, 'composio_usage_v119', { action: 'explode', nowMs: NOW });
  assert.match(badAction, /^Error: Unknown action/);
});
