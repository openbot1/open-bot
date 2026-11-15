/**
 * Tests for coding agent v4 — sub-agent visualizer, ACP-style model
 * switching, coding profiles (v1.11, Doi T4):
 * `packages/core/src/codingV4/subagentVisualizer.ts`,
 * `modelSwitch.ts`, `codingProfiles.ts`.
 *
 * Pure logic — no fs, no LLM. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v4-visualizer-switch-profiles.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodingV4CodingSession,
  CodingV4TaskTree,
  codingV4NodeProgress,
  codingV4ProfileForTaskType,
  getCodingV4Profile,
  listCodingV4Profiles,
  renderCodingV4ProfileSystemPrompt,
  resolveCodingV4Profile,
  validateCodingV4ModelId,
  CODING_V4_PROFILE_KINDS,
  CODING_V4_PROFILES,
} from '../packages/core/dist/codingV4/index.js';

// --- Sub-agent task visualizer -----------------------------------------------

test('task tree: add children, update status/progress/log, version bumps', () => {
  const tree = new CodingV4TaskTree('Implement auth', { sessionId: 's1' });
  assert.equal(tree.version, 0);
  tree.startRoot();
  assert.equal(tree.root.status, 'running');
  const v0 = tree.version;
  const child = tree.addTask('root', 'Write login handler', { model: 'ollama/qwen2.5-coder:7b' });
  assert.ok(tree.version > v0);
  assert.equal(child.parentId, 'root');
  assert.equal(child.status, 'pending');
  const grand = tree.addTask(child.id, 'Add unit test');
  assert.equal(tree.flatten().length, 3);
  assert.ok(tree.updateTask(child.id, { status: 'running', progress: 50, logLine: 'editing file' }));
  assert.equal(tree.find(child.id).progress, 50);
  assert.deepEqual(tree.find(child.id).log, ['editing file']);
  assert.equal(tree.updateTask('no-such-id', { progress: 10 }), false);
  assert.equal(tree.find(grand.id).title, 'Add unit test');
});

test('task tree: overall progress is the leaf average, parent rollup works', () => {
  const tree = new CodingV4TaskTree('Feature X');
  const a = tree.addTask('root', 'Step A');
  const b = tree.addTask('root', 'Step B');
  tree.updateTask(a.id, { progress: 100 });
  tree.updateTask(b.id, { progress: 0 });
  assert.equal(tree.overallProgress(), 50);
  assert.equal(codingV4NodeProgress(tree.root), 50);
  tree.completeTask(b.id, 'done ok');
  assert.equal(tree.overallProgress(), 100);
  assert.equal(tree.find(b.id).status, 'done');
  assert.equal(tree.find(b.id).progress, 100);
  assert.ok(tree.find(b.id).log.includes('done ok'));
});

test('task tree: fail/cancel record the error, counts by status', () => {
  const tree = new CodingV4TaskTree('Feature Y');
  const a = tree.addTask('root', 'Step A');
  const b = tree.addTask('root', 'Step B');
  tree.failTask(a.id, 'type error on line 12');
  assert.equal(tree.find(a.id).status, 'failed');
  assert.equal(tree.find(a.id).error, 'type error on line 12');
  tree.cancelTask(b.id, 'superseded');
  assert.equal(tree.find(b.id).status, 'cancelled');
  const counts = tree.countsByStatus();
  assert.equal(counts.failed, 1);
  assert.equal(counts.cancelled, 1);
  assert.equal(counts.pending, 1); // root still pending
  assert.equal(tree.flatten().length, 3);
});

test('task tree: log is capped and trimmed lines are counted', () => {
  const tree = new CodingV4TaskTree('Capped', { maxLogLines: 3 });
  const child = tree.addTask('root', 'Noisy');
  tree.updateTask(child.id, { logLines: ['1', '2', '3', '4', '5'] });
  assert.deepEqual(tree.find(child.id).log, ['3', '4', '5']);
  assert.equal(tree.find(child.id).logTruncated, 2);
});

test('task tree: diffSnapshots finds only the changed nodes', () => {
  const tree = new CodingV4TaskTree('Diff');
  const a = tree.addTask('root', 'A');
  const b = tree.addTask('root', 'B');
  const before = tree.snapshot();
  tree.updateTask(a.id, { progress: 40 });
  const after = tree.snapshot();
  // A changed AND root changed (its rollup progress moved 0 -> 20).
  assert.deepEqual(CodingV4TaskTree.diffSnapshots(before, after), ['root', a.id]);
  const c = tree.addTask('root', 'C');
  const after2 = tree.snapshot();
  // C is new AND root changed again (rollup 20 -> 13 with the new leaf).
  assert.deepEqual(CodingV4TaskTree.diffSnapshots(after, after2), ['root', c.id]);
  assert.deepEqual(CodingV4TaskTree.diffSnapshots(before, before), []);
  assert.equal(after2.totalNodes, 4);
  assert.equal(after2.version, tree.version);
});

test('task tree: renderText shows statuses and progress; serialize/parse round trip', () => {
  const tree = new CodingV4TaskTree('Render me');
  const child = tree.addTask('root', 'Child task', { model: 'm1' });
  tree.updateTask(child.id, { status: 'running', progress: 25, logLine: 'working' });
  const text = tree.renderText();
  assert.match(text, /Render me/);
  assert.match(text, /Child task/);
  assert.match(text, /25%/);
  assert.match(text, /working/);
  assert.match(text, /Tien do chung: \d+%/);
  const parsed = CodingV4TaskTree.parse(tree.serialize());
  assert.equal(parsed.root.title, 'Render me');
  assert.equal(parsed.flatten().length, 2);
  assert.equal(parsed.find(child.id).status, 'running');
  assert.equal(parsed.version, tree.version);
  assert.throws(() => CodingV4TaskTree.parse('nope'), /JSON hong/);
  assert.throws(() => new CodingV4TaskTree('  '), /khong rong/);
  assert.throws(() => tree.addTask('root', 'dup', { id: child.id }), /da ton tai/);
});

// --- ACP-style model switching -------------------------------------------------

test('model switch: transcript is preserved, switch is logged', () => {
  const session = new CodingV4CodingSession({ sessionId: 's1', modelId: 'ollama/qwen2.5-coder:7b' });
  session.addMessage('user', 'fix the login bug');
  session.addMessage('assistant', 'looking at it');
  assert.equal(session.messages.length, 2);
  const record = session.switchModel('gemini-2.5-flash', 'need a bigger model for this bug');
  assert.equal(record.fromModelId, 'ollama/qwen2.5-coder:7b');
  assert.equal(record.toModelId, 'gemini-2.5-flash');
  assert.equal(record.preservedMessages, 2);
  assert.equal(record.transcriptChars, 'fix the login bug'.length + 'looking at it'.length);
  assert.equal(session.modelId, 'gemini-2.5-flash');
  assert.equal(session.messages.length, 2); // nothing lost
  assert.equal(session.messages[1].modelId, 'ollama/qwen2.5-coder:7b'); // old answer keeps its model
  session.addMessage('assistant', 'fixed it');
  assert.equal(session.messages[2].modelId, 'gemini-2.5-flash');
  const summary = session.summary();
  assert.equal(summary.switches, 1);
  assert.deepEqual(summary.modelsUsed, ['ollama/qwen2.5-coder:7b', 'gemini-2.5-flash']);
  assert.match(session.renderSwitchHistory(), /gemini-2\.5-flash/);
  assert.match(session.renderSwitchHistory(), /need a bigger model/);
});

test('model switch: same model / empty reason / unknown catalog model rejected', () => {
  const session = new CodingV4CodingSession({
    sessionId: 's1',
    modelId: 'ollama/qwen2.5-coder:7b',
    catalog: ['ollama/qwen2.5-coder:7b', 'gemini-2.5-flash'],
  });
  assert.throws(() => session.switchModel('ollama/qwen2.5-coder:7b', 'no-op'), /dang la model hien tai/);
  assert.throws(() => session.switchModel('gemini-2.5-flash', '   '), /ly do/);
  assert.throws(() => session.switchModel('gpt-99', 'not allowed'), /khong co trong catalog/);
  assert.throws(() => session.switchModel('bad id!', 'bad'), /sai dinh dang/);
  assert.equal(validateCodingV4ModelId('', []).ok, false);
  assert.equal(validateCodingV4ModelId('gemini-2.5-flash').ok, true);
  assert.throws(() => new CodingV4CodingSession({ modelId: '' }), /khong duoc rong/);
});

test('model switch: rollback returns to the previous model and logs it', () => {
  const session = new CodingV4CodingSession({ sessionId: 's1', modelId: 'model-a' });
  assert.equal(session.rollbackLastSwitch(), false);
  session.switchModel('model-b', 'try b');
  assert.equal(session.modelId, 'model-b');
  assert.equal(session.rollbackLastSwitch(), true);
  assert.equal(session.modelId, 'model-a');
  assert.equal(session.switchCount, 2);
  assert.equal(session.switches[1].rolledBack, true);
  assert.equal(session.switches[1].toModelId, 'model-a');
});

test('model switch: serialize/parse round trip keeps transcript and history', () => {
  const session = new CodingV4CodingSession({ sessionId: 's9', modelId: 'model-a' });
  session.addMessage('user', 'hello');
  session.switchModel('model-b', 'faster');
  const parsed = CodingV4CodingSession.parse(session.serialize());
  assert.equal(parsed.sessionId, 's9');
  assert.equal(parsed.modelId, 'model-b');
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.switchCount, 1);
  assert.throws(() => CodingV4CodingSession.parse('{bad'), /JSON hong/);
});

// --- Coding profiles -----------------------------------------------------------

test('profiles: 6 built-in kinds, lookup by kind or id', () => {
  assert.deepEqual([...CODING_V4_PROFILE_KINDS], ['debug', 'refactor', 'feature', 'review', 'test', 'explore']);
  assert.equal(CODING_V4_PROFILES.length, 6);
  assert.equal(listCodingV4Profiles().length, 6);
  for (const p of CODING_V4_PROFILES) {
    assert.equal(p.id, `coding-${p.kind}`);
    assert.ok(p.modelId.length > 0);
    assert.ok(p.tools.length > 0);
    assert.ok(p.maxSteps > 0 && p.budgetTokens > 0);
    assert.ok(p.rules.do.length > 0 && p.rules.dont.length > 0);
    assert.ok(p.systemPrompt.length > 50);
  }
  assert.equal(getCodingV4Profile('debug').kind, 'debug');
  assert.equal(getCodingV4Profile('coding-review').kind, 'review');
  assert.equal(getCodingV4Profile('nope'), undefined);
  assert.equal(getCodingV4Profile('  '), undefined);
  // review/test/explore are read-only: no write_file, no shell_exec
  const review = getCodingV4Profile('review');
  assert.ok(!review.tools.includes('write_file'));
  assert.ok(!review.tools.includes('shell_exec'));
  assert.ok(getCodingV4Profile('feature').tools.includes('write_file'));
});

test('profiles: task-type mapping follows the router v3 types', () => {
  assert.equal(codingV4ProfileForTaskType('fix'), 'debug');
  assert.equal(codingV4ProfileForTaskType('codegen'), 'feature');
  assert.equal(codingV4ProfileForTaskType('plan'), 'explore');
  assert.equal(codingV4ProfileForTaskType('chat'), 'explore');
  assert.equal(codingV4ProfileForTaskType('refactor'), 'refactor');
  assert.equal(codingV4ProfileForTaskType('review'), 'review');
  assert.equal(codingV4ProfileForTaskType('test'), 'test');
  assert.equal(codingV4ProfileForTaskType('unknown-thing'), 'explore');
});

test('profiles: resolve applies overrides and drops unknown tools with a warning', () => {
  const { profile, warnings } = resolveCodingV4Profile('debug', {
    overrides: { modelId: 'my-model', maxSteps: 5 },
    knownTools: ['repomap_v4_rank', 'read_file'],
  });
  assert.equal(profile.modelId, 'my-model');
  assert.equal(profile.maxSteps, 5);
  assert.ok(profile.tools.length > 0);
  assert.ok(profile.tools.every((t) => ['repomap_v4_rank', 'read_file'].includes(t)));
  assert.ok(warnings.length > 0);
  assert.ok(warnings.some((w) => w.includes('shell_exec')));
  const bad = resolveCodingV4Profile('test', { overrides: { maxSteps: -3, budgetTokens: 0 } });
  assert.equal(bad.profile.maxSteps, getCodingV4Profile('test').maxSteps);
  assert.equal(bad.warnings.length, 2);
  assert.throws(() => resolveCodingV4Profile('nope'), /Khong co coding profile/);
  const prompt = renderCodingV4ProfileSystemPrompt(getCodingV4Profile('review'));
  assert.match(prompt, /coding-review/);
  assert.match(prompt, /Allowed tools/);
  assert.match(prompt, /Do:/);
  assert.match(prompt, /Don't:/);
});

test('task tree: onChange fires a fresh snapshot on every change, unsubscribe stops it', () => {
  const tree = new CodingV4TaskTree('Live');
  const seen = [];
  const off = tree.onChange((snap) => seen.push(snap.version));
  assert.equal(tree.listenerCount, 1);
  tree.startRoot();
  const child = tree.addTask('root', 'Child');
  tree.updateTask(child.id, { progress: 30 });
  assert.deepEqual(seen, [1, 2, 3]);
  // A throwing listener must not break the tree.
  tree.onChange(() => {
    throw new Error('listener boom');
  });
  tree.updateTask(child.id, { progress: 40 });
  assert.deepEqual(seen, [1, 2, 3, 4]);
  off();
  assert.equal(tree.listenerCount, 1); // the throwing one remains
  tree.updateTask(child.id, { progress: 50 });
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test('model switch: exportTranscript keeps messages and model tags in both formats', () => {
  const session = new CodingV4CodingSession({ sessionId: 's1', modelId: 'model-a' });
  session.addMessage('user', 'fix it');
  session.addMessage('assistant', 'on it');
  session.switchModel('model-b', 'bigger');
  session.addMessage('assistant', 'fixed');
  const md = session.exportTranscript('markdown');
  assert.match(md, /# Transcript — session s1/);
  assert.match(md, /fix it/);
  assert.match(md, /## assistant \(model model-a\)/);
  assert.match(md, /## assistant \(model model-b\)/);
  const jsonl = session.exportTranscript('jsonl');
  const lines = jsonl.split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.equal(obj.sessionId, 's1');
    assert.ok(typeof obj.content === 'string');
  }
  assert.equal(JSON.parse(lines[1]).modelId, 'model-a');
  assert.equal(JSON.parse(lines[2]).modelId, 'model-b');
});
