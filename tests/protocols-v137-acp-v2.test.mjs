/**
 * Protocols v6 — ACP v2 sessions + structured file changes tests
 * (v1.37, Team T2).
 *
 * Covers packages/core/src/protocolsV6/acpV2SessionV6.ts and
 * acpV2FileChangesV6.ts: prompt returns a user message id,
 * replay from a message id, parallel-v1 linking, resume after
 * cancel, out-of-turn updates (send / ack / for-message /
 * by-kind / pending), subscribers; structured file changes
 * (propose / preview / apply-hunk / reject-hunk / apply-all /
 * conflicts / rollback / create-delete-rename / unsafe paths /
 * v1-diff conversion).
 *
 * No network, no disk: the file store is in-memory and the
 * agent runner is injected.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v137-acp-v2.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AcpV6FileChangeSet,
  AcpV6FileStore,
  AcpV6SessionEngine,
  isAcpV6SafePath,
  v1DiffToV6Change,
  validateAcpV6LineOp,
} from '../packages/core/dist/index.js';

const echoRunner = async (_sessionId, prompt) => ({ text: `Answer: ${prompt}`, toolCalls: ['fs:read'] });

function makeIds() {
  let n = 0;
  return (prefix) => `${prefix}-test-${++n}`;
}

test('prompt returns the user message id (the v2 draft change)', async () => {
  const engine = new AcpV6SessionEngine({ runner: echoRunner, generateId: makeIds() });
  const sessionId = engine.newSession('agent-1');
  const result = await engine.prompt(sessionId, 'hello');
  assert.match(result.messageId, /^acp6-msg-test-/);
  assert.match(result.answerMessageId, /^acp6-msg-test-/);
  assert.notEqual(result.messageId, result.answerMessageId);
  assert.equal(result.text, 'Answer: hello');
  assert.deepEqual(result.toolCalls, ['fs:read']);
  const session = engine.getSession(sessionId);
  assert.equal(session?.messages.length, 2);
  assert.equal(session?.messages[0]?.messageId, result.messageId);
  assert.equal(session?.messages[1]?.inReplyToMessageId, result.messageId);
  // The message is findable by id, across sessions.
  const found = engine.findMessage(result.messageId);
  assert.equal(found?.sessionId, sessionId);
  assert.equal(found?.message.role, 'user');
});

test('unadvertised methods are refused; unknown sessions and messages throw', async () => {
  const engine = new AcpV6SessionEngine({
    runner: echoRunner,
    advertisedMethods: ['session/new', 'session/prompt', 'session/cancel'],
    generateId: makeIds(),
  });
  const sessionId = engine.newSession('agent-1');
  assert.equal(engine.supportsMethod('session/update'), false);
  assert.throws(() => engine.sendUpdate(sessionId, 'progress', { pct: 1 }), /not advertised/);
  assert.throws(() => engine.requireSession('nope'), /Unknown ACP session/);
  assert.equal(engine.findMessage('nope'), undefined);
  assert.throws(() => engine.requireMessage('nope'), /Unknown ACP message/);
  assert.throws(() => engine.replayFrom(sessionId, 'nope'), /Unknown ACP message/);
});

test('parallel v1: link / list-parallel / unlink', async () => {
  const engine = new AcpV6SessionEngine({ runner: echoRunner, generateId: makeIds() });
  const a = engine.newSession('agent-1', { v1SessionId: 'v1-session-1' });
  const b = engine.newSession('agent-1');
  assert.equal(engine.getSession(a)?.runsParallelV1, true);
  assert.equal(engine.getSession(a)?.v1SessionId, 'v1-session-1');
  assert.equal(engine.listParallelSessions().length, 1);
  engine.linkParallelV1(b, 'v1-session-2');
  assert.equal(engine.listParallelSessions().length, 2);
  engine.unlinkParallelV1(a);
  assert.equal(engine.getSession(a)?.runsParallelV1, false);
  assert.equal(engine.listParallelSessions().length, 1);
});

test('cancel then resume; terminal sessions refuse prompts', async () => {
  const engine = new AcpV6SessionEngine({ runner: echoRunner, generateId: makeIds() });
  const sessionId = engine.newSession('agent-1');
  await engine.prompt(sessionId, 'one');
  assert.equal(engine.cancel(sessionId), true);
  assert.equal(engine.getSession(sessionId)?.status, 'cancelled');
  assert.equal(engine.cancel(sessionId), false); // already terminal
  engine.resume(sessionId);
  assert.equal(engine.getSession(sessionId)?.status, 'idle');
  const result = await engine.prompt(sessionId, 'two');
  assert.equal(result.text, 'Answer: two');
  engine.complete(sessionId);
  assert.equal(engine.getSession(sessionId)?.status, 'completed');
  await assert.rejects(() => engine.prompt(sessionId, 'three'), /is completed/);
  assert.throws(() => engine.resume(sessionId), /Only a cancelled session/);
});

test('replay from a message id returns that message onward', async () => {
  const engine = new AcpV6SessionEngine({ runner: echoRunner, generateId: makeIds() });
  const sessionId = engine.newSession('agent-1');
  const first = await engine.prompt(sessionId, 'first');
  await engine.prompt(sessionId, 'second');
  const replayed = engine.replayFrom(sessionId, first.answerMessageId);
  assert.equal(replayed.length, 3); // agent answer + second user message + second answer
  assert.equal(replayed[0]?.messageId, first.answerMessageId);
  const all = engine.replayFrom(sessionId, first.messageId);
  assert.equal(all.length, 4);
});

test('out-of-turn updates: send, subscribe, ack, for-message, by-kind', async () => {
  const engine = new AcpV6SessionEngine({ runner: echoRunner, generateId: makeIds() });
  const seen = [];
  const unsubscribe = engine.subscribe('ui', (update) => seen.push(update));
  assert.equal(engine.subscriberCount, 1);
  assert.throws(() => engine.subscribe('ui', () => {}), /already exists/);
  const sessionId = engine.newSession('agent-1');
  const prompted = await engine.prompt(sessionId, 'work');
  const update = engine.sendUpdate(sessionId, 'progress', { pct: 42 }, prompted.messageId);
  assert.equal(update.delivery, 'delivered');
  assert.equal(update.inReplyToMessageId, prompted.messageId);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.updateId, update.updateId);
  engine.sendUpdate(sessionId, 'message', { text: 'still working' });
  engine.sendUpdate(sessionId, 'progress', { pct: 90 }, prompted.messageId);
  assert.equal(engine.updatesForMessage(sessionId, prompted.messageId).length, 2);
  assert.equal(engine.updatesByKind(sessionId, 'progress').length, 2);
  assert.equal(engine.pendingUpdates(sessionId).length, 0); // delivered immediately
  assert.equal(engine.acknowledgeUpdate(sessionId, update.updateId), true);
  assert.equal(engine.acknowledgeUpdate(sessionId, update.updateId), false); // already acked
  assert.equal(engine.acknowledgeUpdate(sessionId, 'nope'), false);
  unsubscribe();
  assert.equal(engine.subscriberCount, 0);
  const summary = engine.summary();
  assert.equal(summary.sessions, 1);
  assert.equal(summary.messages, 2);
  assert.equal(summary.updates, 3);
});

test('out-of-turn update needs a live session and a known message id', async () => {
  const engine = new AcpV6SessionEngine({ runner: echoRunner, generateId: makeIds() });
  const sessionId = engine.newSession('agent-1');
  assert.throws(() => engine.sendUpdate(sessionId, 'progress', {}, 'nope'), /Unknown ACP message/);
  engine.complete(sessionId);
  assert.throws(() => engine.sendUpdate(sessionId, 'progress', {}), /is completed/);
});

test('safe paths: absolute and .. paths are refused', () => {
  assert.equal(isAcpV6SafePath('src/a.ts'), true);
  assert.equal(isAcpV6SafePath('a/b/c.txt'), true);
  assert.equal(isAcpV6SafePath('/etc/passwd'), false);
  assert.equal(isAcpV6SafePath('../escape.txt'), false);
  assert.equal(isAcpV6SafePath('a/../b.txt'), false);
  assert.equal(isAcpV6SafePath(''), false);
  assert.equal(isAcpV6SafePath('C:\\evil.txt'), false);
});

test('line op validation catches bad ranges', () => {
  assert.equal(validateAcpV6LineOp({ op: 'insert', afterLine: 0, lines: ['x'] }, 3), null);
  assert.match(validateAcpV6LineOp({ op: 'insert', afterLine: 4, lines: ['x'] }, 3) ?? '', /out of range/);
  assert.match(validateAcpV6LineOp({ op: 'delete', startLine: 2, endLine: 5, expectedBefore: ['a'] }, 3) ?? '', /out of range/);
  assert.match(
    validateAcpV6LineOp({ op: 'replace', startLine: 1, endLine: 2, lines: ['z'], expectedBefore: ['only-one'] }, 3) ?? '',
    /exactly 2 line/,
  );
});

function seededStore() {
  const store = new AcpV6FileStore();
  store.put('src/a.ts', 'line1\nline2\nline3');
  return store;
}

test('structured file changes: propose, preview, apply hunk by hunk', () => {
  const set = new AcpV6FileChangeSet(seededStore(), { generateId: makeIds() });
  const change = set.propose({
    sessionId: 's1',
    messageId: 'acp6-msg-test-1',
    path: 'src/a.ts',
    kind: 'update',
    hunks: [
      {
        summary: 'Replace line2',
        ops: [{ op: 'replace', startLine: 2, endLine: 2, lines: ['line2-new'], expectedBefore: ['line2'] }],
      },
      {
        summary: 'Append a line',
        ops: [{ op: 'insert', afterLine: 3, lines: ['line4'] }],
      },
    ],
  });
  assert.equal(change.status, 'proposed');
  assert.equal(change.messageId, 'acp6-msg-test-1');
  assert.equal(change.hunks.length, 2);
  const preview = set.previewHunk(change.changeId, change.hunks[0]?.hunkId ?? '');
  assert.equal(preview.resultingContent, 'line1\nline2-new\nline3');
  assert.deepEqual({ added: preview.added, removed: preview.removed }, { added: 1, removed: 1 });
  // Applying the second hunk first still works (it inserts after line 3).
  const applied = set.applyHunk(change.changeId, change.hunks[1]?.hunkId ?? '');
  assert.equal(applied.applied, true);
  assert.equal(set.getStore().get('src/a.ts'), 'line1\nline2\nline3\nline4');
  const rejected = set.get(change.changeId);
  assert.equal(rejected?.status, 'partially-applied');
  // Reject the remaining hunk: one applied + one rejected = partially applied.
  set.rejectHunk(change.changeId, change.hunks[0]?.hunkId ?? '', 'not wanted');
  assert.equal(set.get(change.changeId)?.status, 'partially-applied');
  assert.equal(set.getStore().get('src/a.ts'), 'line1\nline2\nline3\nline4');
  // Roll back the applied hunk.
  const rolledBack = set.rollbackChange(change.changeId);
  assert.equal(rolledBack, 1);
  assert.equal(set.getStore().get('src/a.ts'), 'line1\nline2\nline3');
});

test('conflicting hunk is marked conflicted and writes nothing', () => {
  const set = new AcpV6FileChangeSet(seededStore(), { generateId: makeIds() });
  const change = set.propose({
    sessionId: 's1',
    path: 'src/a.ts',
    kind: 'update',
    hunks: [
      {
        summary: 'Replace line2 with wrong expectation',
        ops: [{ op: 'replace', startLine: 2, endLine: 2, lines: ['x'], expectedBefore: ['not-line2'] }],
      },
    ],
  });
  const preview = set.previewHunk(change.changeId, change.hunks[0]?.hunkId ?? '');
  assert.equal(preview.status, 'conflicted');
  assert.equal(preview.resultingContent, undefined);
  assert.match(preview.reason ?? '', /expected/);
  const result = set.applyHunk(change.changeId, change.hunks[0]?.hunkId ?? '');
  assert.equal(result.applied, false);
  assert.equal(set.getStore().get('src/a.ts'), 'line1\nline2\nline3');
  assert.equal(set.get(change.changeId)?.status, 'conflicted');
  assert.throws(() => set.applyHunk(change.changeId, change.hunks[0]?.hunkId ?? ''), /not proposed/);
});

test('apply-all applies the good hunks and reports the conflicted ones', () => {
  const set = new AcpV6FileChangeSet(seededStore(), { generateId: makeIds() });
  const change = set.propose({
    sessionId: 's1',
    path: 'src/a.ts',
    kind: 'update',
    hunks: [
      { summary: 'good', ops: [{ op: 'insert', afterLine: 3, lines: ['line4'] }] },
      { summary: 'bad', ops: [{ op: 'delete', startLine: 1, endLine: 1, expectedBefore: ['wrong'] }] },
    ],
  });
  const result = set.applyAll(change.changeId);
  assert.equal(result.applied.length, 1);
  assert.equal(result.conflicted.length, 1);
  assert.equal(set.getStore().get('src/a.ts'), 'line1\nline2\nline3\nline4');
});

test('kind-level changes: create / delete / rename with rollback', () => {
  const set = new AcpV6FileChangeSet(seededStore(), { generateId: makeIds() });
  const created = set.propose({ sessionId: 's1', path: 'src/b.ts', kind: 'create', content: 'hello' });
  assert.equal(set.applyKind(created.changeId).applied, true);
  assert.equal(set.getStore().get('src/b.ts'), 'hello');
  assert.throws(
    () => set.propose({ sessionId: 's1', path: 'src/b.ts', kind: 'create', content: 'again' }),
    /already exists/,
  );
  const deleted = set.propose({ sessionId: 's1', path: 'src/b.ts', kind: 'delete' });
  assert.equal(set.applyKind(deleted.changeId).applied, true);
  assert.equal(set.getStore().has('src/b.ts'), false);
  const renamed = set.propose({ sessionId: 's1', path: 'src/a.ts', kind: 'rename', newPath: 'src/a2.ts' });
  assert.equal(set.applyKind(renamed.changeId).applied, true);
  assert.equal(set.getStore().has('src/a.ts'), false);
  assert.equal(set.getStore().get('src/a2.ts'), 'line1\nline2\nline3');
  // Roll back the rename: the file is back under its old path.
  assert.equal(set.rollbackChange(renamed.changeId), 1);
  assert.equal(set.getStore().get('src/a.ts'), 'line1\nline2\nline3');
  assert.equal(set.getStore().has('src/a2.ts'), false);
  // Roll back the delete: the file comes back.
  assert.equal(set.rollbackChange(deleted.changeId), 1);
  assert.equal(set.getStore().get('src/b.ts'), 'hello');
  // One journal entry remains (the create); rolling it back removes the file again.
  const last = set.rollbackLast();
  assert.notEqual(last, null);
  assert.equal(set.getStore().has('src/b.ts'), false);
  assert.equal(set.rollbackLast(), null); // journal drained
  const summary = set.summary();
  assert.equal(summary.changes, 3);
});

test('propose refuses missing files, bad kinds and unsafe paths', () => {
  const set = new AcpV6FileChangeSet(seededStore(), { generateId: makeIds() });
  assert.throws(() => set.propose({ sessionId: 's1', path: 'nope.ts', kind: 'update', hunks: [] }), /missing file/);
  assert.throws(() => set.propose({ sessionId: 's1', path: 'nope.ts', kind: 'delete' }), /missing file/);
  assert.throws(() => set.propose({ sessionId: 's1', path: '../x.ts', kind: 'update', hunks: [] }), /Unsafe file path/);
  assert.throws(
    () => set.propose({ sessionId: 's1', path: 'src/a.ts', kind: 'rename' }),
    /needs newPath/,
  );
  assert.throws(() => set.require('nope'), /Unknown file change/);
  assert.equal(set.get('nope'), undefined);
});

test('v1 diff conversion finds the match and reports a miss', () => {
  const ok = v1DiffToV6Change('s1', 'src/a.ts', 'line2', 'line2-new', 'line1\nline2\nline3');
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.hunks[0]?.ops[0]?.op, 'replace');
    const set = new AcpV6FileChangeSet(seededStore(), { generateId: makeIds() });
    const change = set.propose({ sessionId: 's1', path: 'src/a.ts', kind: 'update', hunks: ok.hunks });
    assert.equal(set.applyAll(change.changeId).applied.length, 1);
    assert.equal(set.getStore().get('src/a.ts'), 'line1\nline2-new\nline3');
  }
  const miss = v1DiffToV6Change('s1', 'src/a.ts', 'not-there', 'x', 'line1\nline2\nline3');
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.match(miss.reason, /not found/);
});
