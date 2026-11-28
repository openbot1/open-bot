import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const guide = fs.readFileSync(
  path.join(process.cwd(), 'docs', 'CRASH-CONSISTENCY-FAULT-INJECTION.md'),
  'utf8',
);

test('limits destructive fault injection to disposable state', () => {
  assert.match(guide, /disposable temporary profiles/i);
  assert.match(guide, /Never point fault injection at a user's live/i);
});

test('covers the actual persistence boundaries', () => {
  for (const term of ['.open-bot/memory.db', 'bounded backup rotation', 'Vault key rotation', 'run journal', 'checkpoint recovery']) {
    assert.ok(guide.includes(term), `missing persistence boundary: ${term}`);
  }
});

test('documents SQLite attachment write ordering and transaction behavior', () => {
  assert.match(guide, /writes attachment bytes first/i);
  assert.match(guide, /inside one SQLite transaction/i);
  assert.match(guide, /best-effort removes the files/i);
});

test('documents startup orphan attachment reconciliation', () => {
  assert.match(guide, /prunes attachment directories/i);
  assert.match(guide, /orphan files are either removed by cleanup/i);
});

test('documents bounded durable-file write ordering and backup recovery', () => {
  assert.match(guide, /same-directory temporary file/i);
  assert.match(guide, /fsyncs that file/i);
  assert.match(guide, /three previous copies/i);
  assert.match(guide, /live path can be absent/i);
  assert.match(guide, /reads the live file first and then the bounded copies/i);
});

test('does not overstate filesystem or power-loss guarantees', () => {
  assert.match(guide, /directory fsync is best-effort/i);
  assert.match(guide, /process-kill test is not equivalent to sudden power loss/i);
  assert.match(guide, /not interpret atomic rename as a guarantee against every hardware or power-loss failure/i);
});

test('documents Vault key rotation staging and full-store repair checks', () => {
  for (const term of ['.bak', '.new', 'repairKeyAfterCrash', 'decrypt the entire store']) {
    assert.ok(guide.includes(term), `missing Vault recovery detail: ${term}`);
  }
});

test('identifies existing deterministic Vault fault simulations without claiming execution', () => {
  assert.match(guide, /tests\/vault\.test\.mjs/);
  assert.match(guide, /deterministic fault simulations/i);
  assert.match(guide, /not real machine power-loss tests/i);
});

test('documents run journal and checkpoint replay invariants', () => {
  assert.match(guide, /appends JSONL events/i);
  assert.match(guide, /unfinished runs/i);
  assert.match(guide, /completed steps and tool calls must not be executed a second time/i);
  assert.match(guide, /not the same durability contract/i);
});

test('covers each named crash boundary in the fault-injection matrix', () => {
  for (const boundary of ['SQLite message transaction', 'SQLite multi-row delete', 'Durable file write', 'Vault key rotation', 'Journal/checkpoint', 'Restart/reopen']) {
    assert.ok(guide.includes(boundary), `missing fault-injection boundary: ${boundary}`);
  }
});

test('requires restart verification of both positive and negative invariants', () => {
  assert.match(guide, /reopen the same disposable state/i);
  assert.match(guide, /positive invariants/i);
  assert.match(guide, /negative invariants/i);
  assert.match(guide, /no unintended re-execution/i);
});

test('requires controlled injection, clean patch restoration and reproducible fixtures', () => {
  assert.match(guide, /one failure scenario at a time/i);
  assert.match(guide, /in a `finally` block/i);
  assert.match(guide, /fresh copy/i);
});

test('defines PASS and HOLD evidence and privacy requirements', () => {
  assert.match(guide, /overall crash-consistency gate is \*\*PASS\*\*/i);
  assert.match(guide, /is \*\*HOLD\*\*/i);
  assert.match(guide, /without secret values/i);
});
