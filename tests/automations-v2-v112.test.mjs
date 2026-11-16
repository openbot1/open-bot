/**
 * Automations v2 tests (v1.12, Doi T6 — node:test, no network).
 *
 * Covers:
 * - Triggers: cron/interval/once/file/webhook-local/manual validation
 *   + next-run math + trigger matching (glob, event-kind filter,
 *   webhook path)
 * - Condition tree: compare ops, and/or/not nesting, nested fields,
 *   invalid regex rejected
 * - Templates: {{var}} rendering, unknown var kept as-is
 * - Execution: full chain (set-variable -> run-agent -> run-tool ->
 *   notify -> create-task), per-step `when` skip, onError continue
 *   vs stop (partial vs failed), chat-active skip, cooldown skip,
 *   disabled skip, condition-mismatch skip, time-once clears nextRun
 * - Dry-run: would-run preview without executing
 * - Webhook HMAC: sign/verify round-trip, wrong secret fails
 * - Persistence: save/load round-trip, run log append/list/prune,
 *   summary counts, corrupt file loads empty
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/automations-v2-v112.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendAutomationV2Run,
  automationV2TriggerMatches,
  createAutomationV2,
  dryRunAutomationV2,
  evaluateAutomationV2Condition,
  executeAutomationV2,
  listAutomationV2Runs,
  loadAutomationsV2,
  nextRunForAutomationV2,
  removeAutomationV2,
  renderAutomationV2Template,
  saveAutomationsV2,
  setAutomationV2Enabled,
  signAutomationV2WebhookDelivery,
  summarizeAutomationV2Runs,
  validateAutomationV2Trigger,
  verifyAutomationV2WebhookDelivery,
} from '../packages/core/dist/automations/automationsV2.js';

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-v112-'));
}

function baseInput(overrides = {}) {
  return {
    botId: 'bot-1',
    name: 'morning brief',
    trigger: { kind: 'manual' },
    steps: [{ id: 's1', kind: 'notify', message: 'hello' }],
    ...overrides,
  };
}

const mockHandlers = (overrides = {}) => ({
  runAgent: async (_botId, prompt) => `agent:${prompt}`,
  runTool: async (tool, args) => ({ tool, args }),
  notify: async (_message) => undefined,
  createTask: async (_botId, title) => `task:${title}`,
  sleep: async (_ms) => undefined,
  ...overrides,
});

test('automations v2: trigger validation + next-run math', () => {
  const cron = createAutomationV2(baseInput({
    trigger: { kind: 'time-cron', expression: '0 9 * * *' },
  }), T0);
  // T0 is exactly 09:00, so the next 09:00 run is tomorrow.
  assert.equal(cron.nextRunAtMs, Date.UTC(2026, 10, 16, 9, 0, 0));
  assert.equal(nextRunForAutomationV2(cron, T0), Date.UTC(2026, 10, 16, 9, 0, 0));

  const interval = createAutomationV2(baseInput({
    trigger: { kind: 'time-interval', intervalMs: 30 * 60 * 1000 },
  }), T0);
  assert.equal(interval.nextRunAtMs, T0 + 30 * 60 * 1000);

  const once = createAutomationV2(baseInput({
    trigger: { kind: 'time-once', runAtMs: T0 + 5000 },
  }), T0);
  assert.equal(once.nextRunAtMs, T0 + 5000);
  assert.equal(nextRunForAutomationV2(once, T0 + 6000), null);

  const manual = createAutomationV2(baseInput({ trigger: { kind: 'manual' } }), T0);
  assert.equal(manual.nextRunAtMs, null);

  assert.throws(() => validateAutomationV2Trigger({ kind: 'time-cron', expression: 'bad' }), /invalid cron/);
  assert.throws(() => validateAutomationV2Trigger({ kind: 'time-interval', intervalMs: 0 }), /intervalMs/);
  assert.throws(() => validateAutomationV2Trigger({ kind: 'file' }), /pathPattern/);
  assert.throws(() => validateAutomationV2Trigger({ kind: 'file', pathPattern: 'x', events: ['renamed'] }), /event/);
  assert.throws(() => validateAutomationV2Trigger({ kind: 'webhook-local', path: 'hooks/x', keyId: 'k' }), /start with/);
  assert.throws(() => validateAutomationV2Trigger({ kind: 'webhook-local', path: '/hooks/x' }), /keyId/);
  assert.throws(() => validateAutomationV2Trigger({ kind: 'nope' }), /unknown trigger/);
});

test('automations v2: trigger matching — file glob + event kinds + webhook path', () => {
  const fileAuto = createAutomationV2(baseInput({
    trigger: { kind: 'file', pathPattern: 'notes/**.md', events: ['modified'] },
  }), T0);
  assert.ok(automationV2TriggerMatches(fileAuto, { type: 'file', path: 'notes/a/b.md', eventKind: 'modified', atMs: T0 }));
  assert.ok(!automationV2TriggerMatches(fileAuto, { type: 'file', path: 'notes/a/b.md', eventKind: 'created', atMs: T0 }));
  assert.ok(!automationV2TriggerMatches(fileAuto, { type: 'file', path: 'other/a.md', eventKind: 'modified', atMs: T0 }));
  assert.ok(!automationV2TriggerMatches(fileAuto, { type: 'manual', atMs: T0 }));

  const hookAuto = createAutomationV2(baseInput({
    trigger: { kind: 'webhook-local', path: '/hooks/deploy', keyId: 'k1' },
  }), T0);
  assert.ok(automationV2TriggerMatches(hookAuto, { type: 'webhook-local', path: '/hooks/deploy', body: {}, atMs: T0 }));
  assert.ok(!automationV2TriggerMatches(hookAuto, { type: 'webhook-local', path: '/hooks/other', body: {}, atMs: T0 }));
});

test('automations v2: condition tree — compare ops, nesting, nested fields', () => {
  const payload = { path: 'notes/todo.md', count: 5, done: true, meta: { owner: 'huy' } };
  assert.ok(evaluateAutomationV2Condition({ op: 'always' }, payload));
  assert.ok(evaluateAutomationV2Condition({ op: 'eq', field: 'count', value: 5 }, payload));
  assert.ok(evaluateAutomationV2Condition({ op: 'ne', field: 'count', value: 6 }, payload));
  assert.ok(evaluateAutomationV2Condition({ op: 'gt', field: 'count', value: 4 }, payload));
  assert.ok(!evaluateAutomationV2Condition({ op: 'gte', field: 'count', value: 6 }, payload));
  assert.ok(evaluateAutomationV2Condition({ op: 'contains', field: 'path', value: 'todo' }, payload));
  assert.ok(evaluateAutomationV2Condition({ op: 'startsWith', field: 'path', value: 'notes/' }, payload));
  assert.ok(evaluateAutomationV2Condition({ op: 'matches', field: 'path', value: '\\.md$' }, payload));
  assert.ok(evaluateAutomationV2Condition({ op: 'eq', field: 'meta.owner', value: 'huy' }, payload));
  assert.ok(!evaluateAutomationV2Condition({ op: 'eq', field: 'missing.deep', value: 1 }, payload));
  assert.ok(evaluateAutomationV2Condition({
    op: 'and',
    conditions: [
      { op: 'contains', field: 'path', value: '.md' },
      { op: 'or', conditions: [{ op: 'eq', field: 'count', value: 5 }, { op: 'eq', field: 'count', value: 9 }] },
      { op: 'not', condition: { op: 'eq', field: 'done', value: false } },
    ],
  }, payload));
  assert.ok(!evaluateAutomationV2Condition({
    op: 'and',
    conditions: [{ op: 'eq', field: 'count', value: 5 }, { op: 'eq', field: 'count', value: 6 }],
  }, payload));
  assert.equal(evaluateAutomationV2Condition(undefined, payload), true);
  assert.throws(() => evaluateAutomationV2Condition({ op: 'matches', field: 'path', value: '[' }, payload), /regex/);
  assert.throws(() => evaluateAutomationV2Condition({ op: 'bogus', field: 'x', value: 1 }, payload), /unknown condition/);
});

test('automations v2: templates render variables, unknown var kept', () => {
  assert.equal(renderAutomationV2Template('hi {{name}}!', { name: 'huy' }), 'hi huy!');
  assert.equal(renderAutomationV2Template('hi {{missing}}!', {}), 'hi {{missing}}!');
  assert.equal(renderAutomationV2Template('{{ a }} and {{b}}', { a: '1', b: '2' }), '1 and 2');
});

test('automations v2: full chain executes in order with variables', async () => {
  const seen = [];
  const auto = createAutomationV2(baseInput({
    trigger: { kind: 'manual' },
    cooldownMs: 0,
    steps: [
      { id: 's1', kind: 'set-variable', name: 'topic', value: 'fleet v9' },
      { id: 's2', kind: 'run-agent', botId: 'bot-1', prompt: 'brief on {{topic}}' },
      { id: 's3', kind: 'run-tool', tool: 'fleet_dashboard', args: { topic: '{{topic}}' } },
      { id: 's4', kind: 'notify', message: 'done {{topic}}' },
      { id: 's5', kind: 'create-task', botId: 'bot-1', title: 'follow up {{topic}}' },
      { id: 's6', kind: 'wait', waitMs: 10 },
    ],
  }), T0);
  const handlers = mockHandlers({
    runAgent: async (_b, prompt) => { seen.push(['agent', prompt]); return `agent:${prompt}`; },
    runTool: async (tool, args) => { seen.push(['tool', tool, args]); return { ok: true }; },
    notify: async (m) => { seen.push(['notify', m]); },
    createTask: async (_b, t) => { seen.push(['task', t]); return `task:${t}`; },
  });
  const { automation, run } = await executeAutomationV2(auto, { type: 'manual', atMs: T0 }, handlers, { nowMs: T0 });
  assert.equal(run.status, 'succeeded');
  assert.equal(run.steps.length, 6);
  assert.ok(run.steps.every((s) => s.status === 'succeeded'));
  assert.equal(seen[0][1], 'brief on fleet v9');
  assert.equal(seen[1][2].topic, 'fleet v9');
  assert.equal(seen[2][1], 'done fleet v9');
  assert.equal(seen[3][1], 'follow up fleet v9');
  assert.equal(automation.runCount, 1);
  assert.equal(automation.lastRunAtMs, T0);
});

test('automations v2: per-step when skip + onError continue vs stop', async () => {
  const failing = mockHandlers({
    runTool: async () => { throw new Error('tool exploded'); },
  });
  const autoContinue = createAutomationV2(baseInput({
    trigger: { kind: 'manual' },
    cooldownMs: 0,
    steps: [
      { id: 's1', kind: 'run-tool', tool: 'boom', onError: 'continue' },
      { id: 's2', kind: 'notify', message: 'still here' },
      { id: 's3', kind: 'run-tool', tool: 'boom', when: { op: 'eq', field: 'type', value: 'nope' } },
    ],
  }), T0);
  const resContinue = await executeAutomationV2(autoContinue, { type: 'manual', atMs: T0 }, failing, { nowMs: T0 });
  assert.equal(resContinue.run.status, 'partial');
  assert.deepEqual(resContinue.run.steps.map((s) => s.status), ['failed', 'succeeded', 'skipped']);
  assert.equal(resContinue.run.steps[0].error, 'tool exploded');

  const autoStop = createAutomationV2(baseInput({
    trigger: { kind: 'manual' },
    cooldownMs: 0,
    steps: [
      { id: 's1', kind: 'run-tool', tool: 'boom' },
      { id: 's2', kind: 'notify', message: 'never' },
    ],
  }), T0);
  const resStop = await executeAutomationV2(autoStop, { type: 'manual', atMs: T0 }, failing, { nowMs: T0 });
  assert.equal(resStop.run.status, 'failed');
  assert.equal(resStop.run.steps.length, 1);
  assert.equal(resStop.automation.failureCount, 1);
});

test('automations v2: skips — disabled, chatting, cooldown, condition mismatch', async () => {
  const handlers = mockHandlers();
  const disabled = createAutomationV2(baseInput({ trigger: { kind: 'manual' }, enabled: false, cooldownMs: 0 }), T0);
  assert.equal((await executeAutomationV2(disabled, { type: 'manual', atMs: T0 }, handlers, { nowMs: T0 })).run.status, 'skipped');

  const auto = createAutomationV2(baseInput({ trigger: { kind: 'manual' }, cooldownMs: 0 }), T0);
  const chatting = await executeAutomationV2(auto, { type: 'manual', atMs: T0 }, handlers, { nowMs: T0, isChatActive: () => true });
  assert.equal(chatting.run.status, 'skipped');
  assert.equal(chatting.run.skipReason, 'user is chatting');

  const gated = createAutomationV2(baseInput({
    trigger: { kind: 'manual' },
    cooldownMs: 0,
    condition: { op: 'eq', field: 'type', value: 'file' },
  }), T0);
  const mismatch = await executeAutomationV2(gated, { type: 'manual', atMs: T0 }, handlers, { nowMs: T0 });
  assert.equal(mismatch.run.status, 'skipped');
  assert.match(mismatch.run.skipReason, /condition did not match/);

  // Cooldown: run once, then again inside cooldown.
  const cool = createAutomationV2(baseInput({ trigger: { kind: 'manual' }, cooldownMs: 60_000 }), T0);
  const first = await executeAutomationV2(cool, { type: 'manual', atMs: T0 }, handlers, { nowMs: T0 });
  assert.equal(first.run.status, 'succeeded');
  const second = await executeAutomationV2(first.automation, { type: 'manual', atMs: T0 + 1000 }, handlers, { nowMs: T0 + 1000 });
  assert.equal(second.run.status, 'skipped');
  assert.match(second.run.skipReason, /cooldown/);
  const third = await executeAutomationV2(first.automation, { type: 'manual', atMs: T0 + 61_000 }, handlers, { nowMs: T0 + 61_000 });
  assert.equal(third.run.status, 'succeeded');
});

test('automations v2: dry-run previews without executing', () => {
  const auto = createAutomationV2(baseInput({
    trigger: { kind: 'file', pathPattern: 'notes/**.md', events: [] },
    steps: [
      { id: 's1', kind: 'notify', message: 'changed' },
      { id: 's2', kind: 'run-tool', tool: 'x', when: { op: 'eq', field: 'path', value: 'other.md' } },
    ],
  }), T0);
  const preview = dryRunAutomationV2(auto, { type: 'file', path: 'notes/a.md', eventKind: 'modified', atMs: T0 });
  assert.equal(preview.wouldRun, true);
  assert.deepEqual(preview.steps.map((s) => s.wouldRun), [true, false]);
  const noMatch = dryRunAutomationV2(auto, { type: 'file', path: 'code/a.ts', eventKind: 'modified', atMs: T0 });
  assert.equal(noMatch.wouldRun, false);
  assert.match(noMatch.skipReason, /does not match trigger/);
});

test('automations v2: webhook HMAC sign/verify round-trip', () => {
  const secret = 'test-secret-v112';
  const body = JSON.stringify({ event: 'deploy' });
  const sig = signAutomationV2WebhookDelivery(secret, body);
  assert.ok(sig.startsWith('sha256='));
  assert.ok(verifyAutomationV2WebhookDelivery(secret, body, sig));
  assert.ok(!verifyAutomationV2WebhookDelivery('wrong-secret', body, sig));
  assert.ok(!verifyAutomationV2WebhookDelivery(secret, JSON.stringify({ event: 'other' }), sig));
  assert.ok(!verifyAutomationV2WebhookDelivery(secret, body, 'sha256=deadbeef'));
});

test('automations v2: CRUD + persistence + run log', async () => {
  const dir = tmpDir();
  let list = [createAutomationV2(baseInput({ name: 'a' }), T0), createAutomationV2(baseInput({ name: 'b' }), T0)];
  saveAutomationsV2(dir, list);
  assert.equal(fs.statSync(path.join(dir, 'automations-v112.json')).mode & 0o777, 0o600);
  const loaded = loadAutomationsV2(dir);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].name, 'a');
  list = setAutomationV2Enabled(list, list[0].id, false, T0);
  assert.equal(list[0].enabled, false);
  list = removeAutomationV2(list, list[0].id);
  assert.equal(list.length, 1);
  assert.throws(() => removeAutomationV2(list, 'nope'), /not found/);
  assert.throws(() => createAutomationV2(baseInput({ steps: [] }), T0), /non-empty array/);
  assert.throws(() => createAutomationV2(baseInput({
    steps: [{ id: 's1', kind: 'set-variable', name: 'bad name', value: 'x' }],
  }), T0), /set-variable name/);
  assert.throws(() => createAutomationV2(baseInput({
    steps: [{ id: 's1', kind: 'wait', waitMs: 999_999 }],
  }), T0), /waitMs/);

  const auto = createAutomationV2(baseInput({ trigger: { kind: 'manual' }, cooldownMs: 0 }), T0);
  const { run } = await executeAutomationV2(auto, { type: 'manual', atMs: T0 }, mockHandlers(), { nowMs: T0 });
  appendAutomationV2Run(dir, run);
  appendAutomationV2Run(dir, { ...run, id: 'run-2', status: 'failed' });
  const runs = listAutomationV2Runs(dir);
  assert.equal(runs.length, 2);
  assert.deepEqual(summarizeAutomationV2Runs(runs), { total: 2, succeeded: 1, failed: 1, partial: 0, skipped: 0 });
  fs.writeFileSync(path.join(dir, 'automations-v112.json'), '{broken');
  assert.deepEqual(loadAutomationsV2(dir), []);
});
