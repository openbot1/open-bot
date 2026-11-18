/**
 * Tests cho coding agent v14 — condenser tăng dần + reasoning blocks
 * (v1.29, Đội T3 lần 5).
 *
 * Chạy thật (không mock fs): RunLogStore thật, sidecar JSONL thật
 * trong thư mục tạm; reasoning redact/verify/prune trên file thật.
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v14-condenser-reasoning-v129.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import {
  V14ReasoningStore,
  v14ApplyCondensation,
  v14AppendReasoningDigest,
  v14BuildContext,
  v14CondenseIncremental,
  v14LastCompactedSeq,
  v14LoadCondensations,
  v14RedactText,
  v14ReplayState,
  v14ShouldCondense,
  v14VerifyDigests,
  v14EstimateTokens,
  renderV14CondensationSummary,
} from '../packages/core/dist/codingV14/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v14-cond-reason-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Không chặn test.
  }
}

/** Event giả có đủ field mà v14 đọc (hash không verify ở tầng này). */
let seqCounter = 0;
function fakeEvent(type, payload, runId = 'run-1') {
  seqCounter += 1;
  return {
    seq: seqCounter,
    runId,
    at: '2026-11-17T00:00:00.000Z',
    type,
    payload,
    prevHash: '',
    hash: `hash-${seqCounter}`,
  };
}

function resetSeq() {
  seqCounter = 0;
}

/** Log dài: prompt + 12 step, mỗi step 1 response + 1 tool call/result, xen kẽ lỗi + file change. */
function buildLongLog() {
  resetSeq();
  const events = [fakeEvent('run.started', { botId: 'coding-v14', maxSteps: 20 })];
  events.push(fakeEvent('run.prompt', { text: 'Fix the login bug and add tests for it' }));
  for (let step = 0; step < 12; step += 1) {
    events.push(
      fakeEvent('model.response', {
        step,
        text: `Working on step ${step} of the login fix, checking the auth module and its tests`,
        toolCalls: [{ callId: `c-${step}`, tool: 'read_file', argKeys: ['path'] }],
      }),
    );
    events.push(fakeEvent('tool.call', { callId: `c-${step}`, tool: 'read_file', argKeys: ['path'], step }));
    const isError = step % 3 === 2;
    events.push(
      fakeEvent('tool.result', {
        callId: `c-${step}`,
        tool: 'read_file',
        status: isError ? 'error' : 'ok',
        outputPreview: isError
          ? "TypeError: Cannot read properties of undefined (reading 'user')"
          : 'export function login(user) { return true; }'.repeat(3),
        durationMs: 5,
        step,
      }),
    );
    if (step % 4 === 1) {
      events.push(
        fakeEvent('file.change', { kind: 'edit', path: 'src/auth.ts', tool: 'edit_file', callId: `e-${step}`, step }),
      );
    }
    if (isError) {
      events.push(
        fakeEvent('compile.error', {
          command: 'tsc',
          tool: 'typecheck',
          callId: `ce-${step}`,
          firstError: "src/auth.ts(12,5): error TS2322: Type 'undefined' is not assignable",
        }),
      );
    }
  }
  return events;
}

/* ================================================================== */
/* Condenser v14 — incremental                                        */
/* ================================================================== */

test('v14ShouldCondense: log ngắn thì chưa cần, log dài thì cần nén', () => {
  resetSeq();
  const short = [fakeEvent('run.prompt', { text: 'hi' })];
  const shortCheck = v14ShouldCondense(short);
  assert.equal(shortCheck.needed, false);

  const long = buildLongLog();
  const check = v14ShouldCondense(long, { minEvents: 10, minTokens: 100 });
  assert.equal(check.needed, true);
  assert.equal(check.fromSeq, 0);
  assert.equal(check.uncondensedEvents, long.length);
});

test('v14CondenseIncremental: giữ nguyên văn lỗi + file change mới nhất, đo token thật', () => {
  const events = buildLongLog();
  const c = v14CondenseIncremental(events, 'run-1', { minEvents: 10, minTokens: 100 });
  assert.equal(c.fromSeq, 0);
  assert.equal(c.upToSeq, events[events.length - 1].seq);
  assert.equal(c.eventsCovered, events.length);
  assert.ok(c.eventsKept > 0, 'phải giữ lại event quan trọng');
  assert.ok(c.eventsSummarized > 0, 'phải có event chỉ còn trong tóm tắt');
  assert.ok(c.summary.length > 0);
  assert.ok(c.summary.includes('read_file'), 'tóm tắt phải nhắc tool đã chạy');
  // Error tool result phải giữ nguyên văn trong kept transcript.
  assert.ok(c.keptTranscript.includes('TypeError'), 'kept transcript phải giữ lỗi tool');
  // File change mới nhất của src/auth.ts phải giữ nguyên văn.
  assert.ok(c.keptTranscript.includes('src/auth.ts'), 'kept transcript phải giữ file change mới nhất');
  // Số đo token: before > 0, after = tokens(summary) + kept, saved = before - after.
  assert.ok(c.tokensBefore > 0);
  assert.ok(c.tokensAfter > 0);
  assert.equal(c.tokensSaved, c.tokensBefore - c.tokensAfter);
  assert.equal(c.savedRatioPct, Math.round((c.tokensSaved / c.tokensBefore) * 1000) / 10);
  assert.match(renderV14CondensationSummary(c), /incremental-summarize/);
});

test('v14CondenseIncremental: lần 2 chỉ nén phần mới sau marker (incremental thật)', () => {
  const events = buildLongLog();
  const first = v14CondenseIncremental(events, 'run-1', { minEvents: 10, minTokens: 100 });
  // Giả lập marker run.compacted đã ghi sau lần 1.
  const markerSeq = events[events.length - 1].seq + 1;
  const withMarker = [
    ...events,
    {
      seq: markerSeq,
      runId: 'run-1',
      at: '2026-11-17T00:00:00.000Z',
      type: 'run.compacted',
      payload: { upToSeq: first.upToSeq, summary: first.summary, eventsReplaced: first.eventsCovered },
      prevHash: '',
      hash: 'hash-marker',
    },
  ];
  assert.equal(v14LastCompactedSeq(withMarker), first.upToSeq);
  // Thêm 12 event mới.
  seqCounter = markerSeq;
  for (let step = 12; step < 16; step += 1) {
    withMarker.push(
      fakeEvent('model.response', { step, text: `Continuing step ${step} with more checks on the login flow`, toolCalls: [] }),
    );
    withMarker.push(
      fakeEvent('tool.result', { callId: `n-${step}`, tool: 'run_tests', status: 'ok', outputPreview: '12 passed', durationMs: 9, step }),
    );
    withMarker.push(
      fakeEvent('file.change', { kind: 'edit', path: 'src/auth.ts', tool: 'edit_file', callId: `ne-${step}`, step }),
    );
  }
  const check = v14ShouldCondense(withMarker, { minEvents: 5, minTokens: 50 });
  assert.equal(check.needed, true);
  assert.equal(check.fromSeq, first.upToSeq);
  assert.equal(check.uncondensedEvents, 12);
  const second = v14CondenseIncremental(withMarker, 'run-1', { minEvents: 5, minTokens: 50 });
  assert.equal(second.fromSeq, first.upToSeq);
  assert.equal(second.eventsCovered, 12);
  assert.ok(second.upToSeq > first.upToSeq);
});

test('v14CondenseIncremental: log đã compact hết thì ném lỗi rõ ràng', () => {
  resetSeq();
  const events = [fakeEvent('run.compacted', { upToSeq: 1, summary: 'x', eventsReplaced: 1 })];
  assert.throws(() => v14CondenseIncremental(events, 'run-1'), /no uncondensed events/);
  assert.throws(() => v14CondenseIncremental([], 'run-1'), /no uncondensed events/);
});

test('v14BuildContext: summary + kept + tail sau upToSeq, replayable', () => {
  const events = buildLongLog();
  const c = v14CondenseIncremental(events, 'run-1', { minEvents: 10, minTokens: 100 });
  // Thêm 2 event tail sau upToSeq.
  seqCounter = c.upToSeq;
  const tail1 = fakeEvent('model.response', { step: 99, text: 'Tail response after compaction', toolCalls: [] });
  const tail2 = fakeEvent('tool.result', { callId: 't-1', tool: 'run_tests', status: 'ok', outputPreview: 'ok', durationMs: 1, step: 99 });
  const ctx1 = v14BuildContext([...events, tail1, tail2], c);
  const ctx2 = v14BuildContext([...events, tail1, tail2], c);
  assert.equal(ctx1, ctx2, 'cùng log + cùng condensation phải cho cùng context');
  assert.ok(ctx1.includes('Condensed context'));
  assert.ok(ctx1.includes('Tail response after compaction'), 'tail phải có trong context');
  assert.ok(ctx1.includes('Kept verbatim'));
});

test('v14ApplyCondensation: ghi marker + sidecar thật vào RunLogStore', () => {
  const dir = tmpDir();
  try {
    const logDir = path.join(dir, 'run-logs');
    const store = new RunLogStore({ logDir });
    store.append('run-1', { type: 'run.started', payload: { botId: 'coding-v14' } });
    store.append('run-1', { type: 'run.prompt', payload: { text: 'Fix the login bug and add tests for it' } });
    for (let step = 0; step < 12; step += 1) {
      store.append('run-1', {
        type: 'model.response',
        payload: {
          step,
          text: `Working on step ${step} of the login fix, checking the auth module and its tests`,
          toolCalls: [{ callId: `c-${step}`, tool: 'read_file', argKeys: ['path'] }],
        },
      });
      store.append('run-1', { type: 'tool.call', payload: { callId: `c-${step}`, tool: 'read_file', argKeys: ['path'], step } });
      store.append('run-1', {
        type: 'tool.result',
        payload: {
          callId: `c-${step}`,
          tool: 'read_file',
          status: step % 3 === 2 ? 'error' : 'ok',
          outputPreview: step % 3 === 2 ? "TypeError: Cannot read properties of undefined" : 'ok content here',
          durationMs: 5,
          step,
        },
      });
    }
    const c = v14ApplyCondensation(store, logDir, 'run-1', { minEvents: 10, minTokens: 100 });
    assert.ok(c.markerSeq > 0);
    const { events } = store.readRun('run-1');
    const marker = events.find((e) => e.type === 'run.compacted');
    assert.ok(marker, 'marker run.compacted phải có trong log');
    assert.equal(marker.payload.upToSeq, c.upToSeq);
    // Replay cũ vẫn thấy marker (fold không vỡ).
    const replayed = v14ReplayState(events, 'run-1');
    assert.equal(replayed.compactions.length, 1);
    assert.equal(replayed.compactions[0].upToSeq, c.upToSeq);
    // Sidecar lưu đủ bản nén.
    const saved = v14LoadCondensations(logDir, 'run-1');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].upToSeq, c.upToSeq);
    assert.equal(saved[0].tokensBefore, c.tokensBefore);
  } finally {
    cleanup(dir);
  }
});

/* ================================================================== */
/* Reasoning blocks                                                    */
/* ================================================================== */

test('V14ReasoningStore: record + replay + resume, không mất khi load lại', () => {
  const dir = tmpDir();
  try {
    const store = new V14ReasoningStore({ dataDir: path.join(dir, 'reasoning') });
    const b1 = store.recordThinking('run-1', 0, 'First think about the login bug: check auth.ts', 'test-model');
    const b2 = store.recordReasoningContent('run-1', 0, 'Reasoning: the bug is likely a missing null check.');
    const b3 = store.record({ runId: 'run-1', step: 1, kind: 'plan', text: 'Plan: fix, test, verify.', pinned: true });
    assert.equal(b1.seq, 1);
    assert.equal(b2.seq, 2);
    assert.equal(b3.pinned, true);
    assert.equal(b1.sha256.length, 64);
    assert.ok(b1.hash.length === 64);
    assert.equal(store.blocks('run-1').length, 3);
    assert.equal(store.blocksForStep('run-1', 0).length, 2);
    assert.equal(store.totalTokens('run-1'), v14EstimateTokens(b1.text) + v14EstimateTokens(b2.text) + v14EstimateTokens(b3.text));

    // Load lại từ đĩa bằng store mới — replay đủ block, chain khớp.
    const reloaded = new V14ReasoningStore({ dataDir: path.join(dir, 'reasoning') });
    assert.equal(reloaded.blocks('run-1').length, 3);
    assert.deepEqual(reloaded.verify('run-1'), {
      runId: 'run-1',
      blocks: 3,
      ok: true,
      brokenAtSeq: 0,
      reason: '',
    });
    const resume = reloaded.resumeState('run-1');
    assert.equal(resume.lastStep, 1);
    assert.equal(resume.totalBlocks, 3);
    assert.equal(resume.pinnedBlocks.length, 1);
    assert.equal(resume.recentBlocks.length, 3);
  } finally {
    cleanup(dir);
  }
});

test('V14ReasoningStore: redact secret trước khi ghi + verify phát hiện file bị sửa', () => {
  const dir = tmpDir();
  try {
    const reasoningDir = path.join(dir, 'reasoning');
    const store = new V14ReasoningStore({ dataDir: reasoningDir });
    const block = store.record({
      runId: 'run-1',
      step: 0,
      kind: 'thinking',
      text: 'I will call the API with key sk-ant-abcdefgh12345678 and token ghp_abcdefgh12345678',
    });
    assert.equal(block.redacted, true);
    assert.ok(!block.text.includes('sk-ant-abcdefgh12345678'), 'secret phải bị che');
    assert.ok(block.text.includes('[REDACTED-KEY]'));
    // Redact trực tiếp (pure).
    assert.equal(v14RedactText('clean text').redacted, false);
    assert.equal(v14RedactText('Bearer abcdefgh12345678').text, 'Bearer [REDACTED]');

    // Sửa file sidecar (đổi text block 1) → verify báo chain broken.
    const file = path.join(reasoningDir, 'run-1.reasoning.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.text = 'tampered text';
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const reloaded = new V14ReasoningStore({ dataDir: reasoningDir });
    const report = reloaded.verify('run-1');
    assert.equal(report.ok, false);
    assert.equal(report.brokenAtSeq, 1);
  } finally {
    cleanup(dir);
  }
});

test('V14ReasoningStore: prune giữ block ghim + block gần nhất; record rỗng thì lỗi', () => {
  const dir = tmpDir();
  try {
    const store = new V14ReasoningStore({ dataDir: path.join(dir, 'reasoning') });
    store.record({ runId: 'run-1', step: 0, kind: 'thinking', text: 'old thought one', pinned: true });
    store.record({ runId: 'run-1', step: 1, kind: 'thinking', text: 'old thought two' });
    store.record({ runId: 'run-1', step: 2, kind: 'thinking', text: 'new thought three' });
    store.record({ runId: 'run-1', step: 3, kind: 'thinking', text: 'new thought four' });
    const kept = store.prune('run-1', 2);
    assert.equal(kept.length, 3, 'ghim 1 + gần nhất 2');
    assert.ok(kept.some((b) => b.pinned));
    assert.ok(kept.some((b) => b.text === 'new thought four'));
    assert.ok(!kept.some((b) => b.text === 'old thought two'));
    assert.throws(() => store.record({ runId: 'run-1', step: 0, kind: 'thinking', text: '   ' }), /non-empty/);
    assert.throws(() => store.record({ runId: '', step: 0, kind: 'thinking', text: 'x' }), /runId/);
  } finally {
    cleanup(dir);
  }
});

test('eventLogAdapter: digest event + đối chiếu sidecar (khớp / thiếu / lệch)', () => {
  const dir = tmpDir();
  try {
    const logDir = path.join(dir, 'run-logs');
    const store = new RunLogStore({ logDir });
    const reasoningStore = new V14ReasoningStore({ dataDir: path.join(dir, 'reasoning') });
    const b1 = reasoningStore.recordThinking('run-1', 0, 'Think about auth bug');
    const b2 = reasoningStore.recordReasoningContent('run-1', 1, 'Reasoning about the fix');
    v14AppendReasoningDigest(store, 'run-1', b1);
    v14AppendReasoningDigest(store, 'run-1', b2);
    const { events } = store.readRun('run-1');
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'reasoning.block');
    assert.equal(events[0].payload.blockId, b1.id);
    assert.equal(events[0].payload.sha256, b1.sha256);
    let v = v14VerifyDigests(events, reasoningStore, 'run-1');
    assert.equal(v.ok, true);
    assert.equal(v.matched, 2);

    // Block mới chỉ có ở sidecar (chưa ghi digest) → missingInLog.
    reasoningStore.recordThinking('run-1', 2, 'Late thought without digest yet');
    v = v14VerifyDigests(events, reasoningStore, 'run-1');
    assert.equal(v.ok, false);
    assert.equal(v.missingInLog.length, 1);
  } finally {
    cleanup(dir);
  }
});
