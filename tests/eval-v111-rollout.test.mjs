/**
 * Tests for rollout JSONL export + validation (packages/core/src/eval/rollout.ts)
 * — v1.11, Đội T2.
 *
 * Covers: record validation (schema, reward/passed consistency, token
 * sums, turn indexes), JSONL validate/write/read round-trip, secret
 * redaction, content truncation, SFT export shape, and summary stats.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-v111-rollout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ROLLOUT_SCHEMA,
  readRolloutJsonl,
  redactRolloutSecrets,
  rolloutToSftJsonl,
  sanitizeRolloutForExport,
  sumRolloutUsage,
  summarizeRollouts,
  truncateRolloutContent,
  validateRolloutJsonl,
  validateRolloutRecord,
  writeRolloutJsonl,
} from '../packages/core/dist/eval/rollout.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-rollout-'));
}

function validRecord(overrides = {}) {
  return {
    schema: ROLLOUT_SCHEMA,
    rolloutId: 'roll-1',
    taskId: 'sum-csv',
    taskVersion: 1,
    profileId: 'coding',
    model: { provider: 'ollama', model: 'qwen3:8b' },
    startedAt: 1000,
    finishedAt: 2000,
    durationMs: 1000,
    instruction: 'Add the numbers.',
    systemPrompt: 'You are a coding agent.',
    turns: [
      { index: 0, role: 'assistant', content: 'Writing result.txt.', toolCalls: [{ name: 'write_file', arguments: { path: 'result.txt' } }], toolResults: [], promptTokens: 100, completionTokens: 50 },
      { index: 1, role: 'tool', content: 'ok', toolCalls: [], toolResults: [{ name: 'write_file', content: 'ok', isError: false }], promptTokens: 0, completionTokens: 0 },
    ],
    reward: 1,
    passed: true,
    testResults: [{ name: 'correct-sum', weight: 2, passed: true }],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    isolation: 'bwrap',
    error: null,
    ...overrides,
  };
}

test('validateRolloutRecord: a valid record has no issues', () => {
  assert.deepEqual(validateRolloutRecord(validRecord()), []);
});

test('validateRolloutRecord: schema, reward range, passed/reward consistency, token sums', () => {
  assert.ok(validateRolloutRecord({ ...validRecord(), schema: 'other/v9' }).some((i) => i.field === 'schema'));
  assert.ok(validateRolloutRecord({ ...validRecord(), reward: 1.5 }).some((i) => i.field === 'reward'));
  assert.ok(validateRolloutRecord({ ...validRecord(), reward: -0.1 }).some((i) => i.field === 'reward'));
  // reward 1 but passed false — inconsistent.
  assert.ok(validateRolloutRecord({ ...validRecord(), passed: false }).length > 0);
  // reward 0 but passed true — inconsistent.
  assert.ok(validateRolloutRecord({ ...validRecord(), reward: 0, passed: true }).length > 0);
  // partial reward must have passed=false.
  assert.deepEqual(validateRolloutRecord({ ...validRecord(), reward: 0.5, passed: false }), []);
  assert.ok(validateRolloutRecord({ ...validRecord(), reward: 0.5, passed: true }).length > 0);
  // token sum must add up.
  assert.ok(validateRolloutRecord({ ...validRecord(), usage: { promptTokens: 100, completionTokens: 50, totalTokens: 999 } }).some((i) => i.field === 'usage.totalTokens'));
  // turn index must match position.
  const badTurns = validRecord({ turns: [{ ...validRecord().turns[0], index: 7 }] });
  assert.ok(validateRolloutRecord(badTurns).some((i) => i.field.includes('turns[0].index')));
  // finishedAt before startedAt.
  assert.ok(validateRolloutRecord({ ...validRecord(), finishedAt: 500 }).length > 0);
  // not an object at all.
  assert.ok(validateRolloutRecord('nope').length > 0);
  assert.ok(validateRolloutRecord(null).length > 0);
});

test('validateRolloutJsonl: good file valid, bad JSON line + bad record reported with line numbers', () => {
  const good = `${JSON.stringify(validRecord())}\n${JSON.stringify(validRecord({ rolloutId: 'roll-2', reward: 0, passed: false }))}\n`;
  const result = validateRolloutJsonl(good);
  assert.equal(result.valid, true);
  assert.equal(result.validRollouts, 2);
  const mixed = `${JSON.stringify(validRecord())}\n{broken json\n${JSON.stringify(validRecord({ reward: 2 }))}\n`;
  const bad = validateRolloutJsonl(mixed);
  assert.equal(bad.valid, false);
  assert.equal(bad.validRollouts, 1);
  assert.ok(bad.issues.some((i) => i.line === 2 && i.field === '(parse)'));
  assert.ok(bad.issues.some((i) => i.line === 3 && i.field === 'reward'));
  assert.deepEqual(validateRolloutJsonl(''), { valid: true, issues: [], validRollouts: 0 });
});

test('write/read JSONL round-trip: append then overwrite, sanitize on write', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'rollouts.jsonl');
  const rec = validRecord({ turns: [{ index: 0, role: 'assistant', content: 'api_key: "sk-secret-value-123"', toolCalls: [], toolResults: [], promptTokens: 1, completionTokens: 1 }] });
  writeRolloutJsonl(file, [rec], 'overwrite');
  writeRolloutJsonl(file, [validRecord({ rolloutId: 'roll-2', reward: 0, passed: false })], 'append');
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2);
  // Secret must not survive on disk in clear text.
  assert.ok(!fs.readFileSync(file, 'utf-8').includes('sk-secret-value-123'));
  const records = readRolloutJsonl(file);
  assert.equal(records.length, 2);
  assert.equal(records[0].rolloutId, 'roll-1');
  assert.equal(records[1].rolloutId, 'roll-2');
  assert.equal(readRolloutJsonl(path.join(dir, 'missing.jsonl')).length, 0);
});

test('redactRolloutSecrets: api keys and long mixed-case tokens are redacted, normal text kept', () => {
  assert.ok(redactRolloutSecrets('api_key: "sk-abc123"').includes('[REDACTED]'));
  assert.ok(!redactRolloutSecrets('api_key: "sk-abc123"').includes('sk-abc123'));
  assert.ok(redactRolloutSecrets('password=hunter2').includes('[REDACTED]'));
  assert.equal(redactRolloutSecrets('Hello, open-bot!'), 'Hello, open-bot!');
  assert.ok(redactRolloutSecrets('token AbCdEfGh1234567890AbCdEfGh1234567890').includes('[REDACTED]'));
});

test('truncateRolloutContent: short content untouched, long content cut with a marker', () => {
  assert.equal(truncateRolloutContent('abc', 10), 'abc');
  const long = 'x'.repeat(100);
  const cut = truncateRolloutContent(long, 10);
  assert.ok(cut.startsWith('xxxxxxxxxx'));
  assert.ok(cut.includes('[truncated 90 chars]'));
});

test('sanitizeRolloutForExport: does not mutate the input record', () => {
  const rec = validRecord();
  const clean = sanitizeRolloutForExport(rec);
  assert.notEqual(clean, rec);
  assert.equal(rec.turns[0].content, 'Writing result.txt.');
  assert.equal(clean.turns[0].content, 'Writing result.txt.');
});

test('sumRolloutUsage + summarizeRollouts: totals and per-task stats', () => {
  assert.deepEqual(sumRolloutUsage(validRecord().turns), { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  const stats = summarizeRollouts([
    validRecord(),
    validRecord({ rolloutId: 'roll-2', taskId: 'sum-csv', reward: 0.5, passed: false, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, durationMs: 500 }),
    validRecord({ rolloutId: 'roll-3', taskId: 'hello-file', reward: 0, passed: false }),
  ]);
  assert.equal(stats.rollouts, 3);
  assert.equal(stats.passed, 1);
  assert.equal(stats.passRate, 1 / 3);
  assert.equal(stats.meanReward, 0.5);
  assert.equal(stats.totalTokens, 150 + 15 + 150);
  assert.equal(stats.byTask['sum-csv'].rollouts, 2);
  assert.equal(stats.byTask['sum-csv'].meanReward, 0.75);
  assert.equal(stats.byTask['hello-file'].passed, 0);
  assert.deepEqual(summarizeRollouts([]), {
    rollouts: 0, passed: 0, passRate: 0, meanReward: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0,
    totalDurationMs: 0, byTask: {},
  });
});

test('rolloutToSftJsonl: one line per assistant turn with history + reward', () => {
  const lines = rolloutToSftJsonl(validRecord());
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.reward, 1);
  assert.equal(parsed.taskId, 'sum-csv');
  assert.equal(parsed.messages.at(-1).role, 'assistant');
  assert.equal(parsed.messages[0].role, 'system');
  assert.equal(parsed.messages[1].role, 'user');
  // No assistant turn -> no SFT lines.
  assert.deepEqual(rolloutToSftJsonl(validRecord({ turns: [] })), []);
});
