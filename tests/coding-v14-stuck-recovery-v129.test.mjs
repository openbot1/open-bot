/**
 * Tests cho coding agent v14 — stuck detection v2 + recovery + agent
 * pipeline (v1.29, Đội T3 lần 5).
 *
 * Chạy thật (agent scripted + file thật trong thư mục tạm, không gọi
 * model/mạng):
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v14-stuck-recovery-v129.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CodingAgentV14,
  V14EditJournal,
  detectOscillation,
  loopingV14Script,
  renderV14AgentReport,
  renderV14StuckReport,
  runV14Agent,
  scriptedV14Agent,
  v14ActionSignature,
  v14DetectStuck,
  v14ExecuteRecovery,
  v14NormalizeArgs,
  v14NormalizeResultText,
  v14PlanRecovery,
} from '../packages/core/dist/codingV14/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v14-stuck-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Không chặn test.
  }
}

let seqCounter = 0;
function fakeEvent(type, payload) {
  seqCounter += 1;
  return {
    seq: seqCounter,
    runId: 'run-1',
    at: '2026-11-17T00:00:00.000Z',
    type,
    payload,
    prevHash: '',
    hash: `hash-${seqCounter}`,
  };
}

/** Một step: response + 1 tool call + result (ok/error). */
function stepEvents(step, tool, status, output, text = 'doing work') {
  return [
    fakeEvent('model.response', {
      step,
      text,
      toolCalls: [{ callId: `c-${step}`, tool, argKeys: ['path'] }],
    }),
    fakeEvent('tool.call', { callId: `c-${step}`, tool, argKeys: ['path'], step }),
    fakeEvent('tool.result', {
      callId: `c-${step}`,
      tool,
      status,
      outputPreview: output,
      durationMs: 5,
      step,
    }),
  ];
}

/* ================================================================== */
/* Normalize + signature                                               */
/* ================================================================== */

test('v14NormalizeResultText: cùng lỗi khác số dòng/path vẫn là một chữ ký', () => {
  const a = v14NormalizeResultText("src/auth.ts(12,5): error TS2322 at /tmp/open-bot-abc123/x.js");
  const b = v14NormalizeResultText("src/auth.ts(99,2): error TS2322 at /tmp/open-bot-xyz999/x.js");
  assert.equal(a, b);
  assert.ok(!a.includes('12'), 'số phải bị chuẩn hoá');
  const sigA = v14ActionSignature('edit_file', { path: 'src/auth.ts', extra: 1 });
  const sigB = v14ActionSignature('edit_file', { extra: 1, path: 'src/auth.ts' });
  assert.equal(sigA, sigB, 'thứ tự key args không đổi chữ ký');
  assert.notEqual(v14NormalizeArgs({ path: 'a.ts' }), v14NormalizeArgs({ path: 'b.ts' }));
});

test('detectOscillation: A-B-A-B đủ chu kỳ thì nhận ra, A-A-B thì không', () => {
  assert.deepEqual(detectOscillation(['a', 'b', 'a', 'b', 'a', 'b'], 2), { a: 'a', b: 'b', cycles: 3 });
  assert.equal(detectOscillation(['a', 'a', 'b', 'b'], 2), null);
  assert.equal(detectOscillation(['a', 'b', 'a'], 2), null);
  assert.equal(detectOscillation([], 2), null);
});

/* ================================================================== */
/* Stuck detection v2                                                  */
/* ================================================================== */

test('v14DetectStuck: lặp cùng action 3 lần → repeat_action', () => {
  seqCounter = 0;
  const events = [
    fakeEvent('run.prompt', { text: 'fix it' }),
    ...stepEvents(0, 'read_file', 'ok', 'content'),
    ...stepEvents(1, 'read_file', 'ok', 'content'),
    ...stepEvents(2, 'read_file', 'ok', 'content'),
  ];
  const report = v14DetectStuck(events, 'run-1');
  assert.equal(report.stuck, true);
  assert.equal(report.signals[0].kind, 'repeat_action');
  assert.equal(report.signals[0].count, 3);
  assert.equal(report.suggestedStrategy, 'redirect');
  assert.equal(report.suggestionKey, 'codingV14.stuckRepeatAction');
  assert.match(renderV14StuckReport(report), /repeat_action/);
});

test('v14DetectStuck: cùng lỗi chuẩn hoá 3 lần → repeat_error (ưu tiên hơn repeat_action)', () => {
  seqCounter = 0;
  const err = "TypeError: Cannot read properties of undefined (reading 'user')";
  const events = [
    fakeEvent('run.prompt', { text: 'fix it' }),
    ...stepEvents(0, 'run_tests', 'error', err),
    ...stepEvents(1, 'run_tests', 'error', err),
    ...stepEvents(2, 'run_tests', 'error', err),
  ];
  const report = v14DetectStuck(events, 'run-1');
  assert.equal(report.stuck, true);
  assert.equal(report.signals[0].kind, 'repeat_error');
  assert.equal(report.suggestedStrategy, 'narrow_scope');
});

test('v14DetectStuck: dao động A-B-A-B → oscillation', () => {
  seqCounter = 0;
  const events = [fakeEvent('run.prompt', { text: 'fix it' })];
  // Luân phiên read_file / edit_file, mỗi step 1 call, kết quả ok để
  // không trigger repeat_error trước.
  const tools = ['read_file', 'edit_file', 'read_file', 'edit_file'];
  tools.forEach((tool, step) => {
    events.push(...stepEvents(step, tool, 'ok', `output ${step}`));
  });
  const report = v14DetectStuck(events, 'run-1', { repeatActionThreshold: 10 });
  const osc = report.signals.find((s) => s.kind === 'oscillation');
  assert.ok(osc, `expected oscillation signal, got: ${JSON.stringify(report.signals)}`);
  assert.equal(osc.count, 2);
});

test('v14DetectStuck: response rỗng kèm tool call 3 lần → empty_response', () => {
  seqCounter = 0;
  const events = [fakeEvent('run.prompt', { text: 'fix it' })];
  for (let step = 0; step < 3; step += 1) {
    events.push(...stepEvents(step, 'read_file', 'ok', 'content', ''));
  }
  const report = v14DetectStuck(events, 'run-1', { repeatActionThreshold: 10 });
  assert.ok(report.signals.some((s) => s.kind === 'empty_response'));
});

test('v14DetectStuck: 8 step không tiến triển → no_progress; log bình thường thì không kẹt', () => {
  seqCounter = 0;
  const events = [fakeEvent('run.prompt', { text: 'fix it' })];
  for (let step = 0; step < 8; step += 1) {
    // Tool fail nhưng output khác nhau mỗi lần để không trigger repeat_error;
    // không file change, không tool ok → no_progress.
    events.push(...stepEvents(step, 'run_tests', 'error', `unique failure number ${step} in module ${step}`));
  }
  const report = v14DetectStuck(events, 'run-1', { repeatErrorThreshold: 99, repeatActionThreshold: 99 });
  assert.ok(report.signals.some((s) => s.kind === 'no_progress'));

  seqCounter = 0;
  const healthy = [fakeEvent('run.prompt', { text: 'fix it' })];
  healthy.push(...stepEvents(0, 'read_file', 'ok', 'content'));
  healthy.push(fakeEvent('file.change', { kind: 'edit', path: 'src/a.ts', tool: 'edit_file', callId: 'e-0', step: 0 }));
  healthy.push(...stepEvents(1, 'run_tests', 'ok', 'all passed'));
  const okReport = v14DetectStuck(healthy, 'run-1');
  assert.equal(okReport.stuck, false);
  assert.deepEqual(okReport.signals, []);
  assert.match(renderV14StuckReport(okReport), /not stuck/);
  assert.throws(() => v14DetectStuck(healthy, ''), /runId/);
});

/* ================================================================== */
/* Edit journal + recovery                                             */
/* ================================================================== */

test('V14EditJournal: record + rollbackLast khôi phục nội dung cũ', () => {
  const files = new Map([['src/a.ts', 'new content']]);
  const applier = (p, content) => files.set(p, content);
  const journal = new V14EditJournal();
  journal.record('run-1', 'src/a.ts', 'old content', 'new content', 0);
  journal.record('run-1', 'src/b.ts', null, 'created file', 1);
  assert.equal(journal.pendingCount(), 2);
  const rolled = journal.rollbackLast(applier);
  assert.equal(rolled.path, 'src/b.ts');
  assert.equal(files.get('src/b.ts'), null, 'file mới tạo phải bị xoá khi rollback');
  assert.equal(journal.pendingCount(), 1);
  const rolled2 = journal.rollbackLast(applier);
  assert.equal(rolled2.path, 'src/a.ts');
  assert.equal(files.get('src/a.ts'), 'old content');
  assert.throws(() => journal.rollbackLast(applier), /no edit to roll back/);
  assert.throws(() => journal.rollback('ej-run-1-999', applier), /not found/);
  assert.throws(() => journal.rollback('ej-run-1-1', applier), /already rolled back/);
});

test('v14PlanRecovery: thang leo thang theo tín hiệu + bối cảnh', () => {
  const signal = { kind: 'repeat_error', count: 3, detail: 'same error 3x', signature: 'x', firstSeq: 1, lastSeq: 9 };
  // Có edit + không hỏi user → narrow_scope trước, rollback sau, không ask_user.
  let plan = v14PlanRecovery('run-1', signal, { hasLastEdit: true, allowAskUser: false, taskSummary: 'fix login', priorRecoveries: 0 });
  assert.equal(plan.steps[0].strategy, 'narrow_scope');
  assert.equal(plan.hasRollback, true);
  assert.ok(plan.steps.some((s) => s.strategy === 'rollback_last_edit'));
  assert.ok(!plan.steps.some((s) => s.strategy === 'ask_user'));
  // Hỏi user được phép → có ask_user.
  plan = v14PlanRecovery('run-1', signal, { hasLastEdit: false, allowAskUser: true, taskSummary: 'fix login', priorRecoveries: 0 });
  assert.ok(plan.steps.some((s) => s.strategy === 'ask_user'));
  // Đã recovery 2 lần mà vẫn kẹt → escalate lên đầu.
  plan = v14PlanRecovery('run-1', signal, { hasLastEdit: true, allowAskUser: false, taskSummary: 'fix login', priorRecoveries: 2 });
  assert.equal(plan.steps[0].strategy, 'escalate');
  // Empty response → ask_user là bước đầu khi được phép.
  const emptySignal = { kind: 'empty_response', count: 3, detail: 'empty 3x', signature: '', firstSeq: 1, lastSeq: 9 };
  plan = v14PlanRecovery('run-1', emptySignal, { hasLastEdit: false, allowAskUser: true, taskSummary: 'fix login', priorRecoveries: 0 });
  assert.equal(plan.steps[0].strategy, 'ask_user');
});

test('v14ExecuteRecovery: rollback qua journal + redirect/escalate qua handler', () => {
  const files = new Map([['src/a.ts', 'after']]);
  const journal = new V14EditJournal();
  journal.record('run-1', 'src/a.ts', 'before', 'after', 0);
  const signal = { kind: 'repeat_action', count: 3, detail: 'repeat 3x', signature: 'read_file(path)', firstSeq: 1, lastSeq: 9 };
  const plan = v14PlanRecovery('run-1', signal, { hasLastEdit: true, allowAskUser: false, taskSummary: 't', priorRecoveries: 0 });
  const rolled = v14ExecuteRecovery(plan, { rollbackLastEdit: () => journal.rollbackLast((p, c) => files.set(p, c)) }, 'rollback_last_edit');
  assert.equal(rolled.applied, true);
  assert.equal(rolled.strategy, 'rollback_last_edit');
  assert.equal(files.get('src/a.ts'), 'before');
  const redirected = v14ExecuteRecovery(plan, { redirect: (i) => `sent: ${i}` }, 'redirect');
  assert.equal(redirected.applied, true);
  assert.match(redirected.detail, /^sent: /);
  const noHandler = v14ExecuteRecovery(plan, {}, 'redirect');
  assert.equal(noHandler.applied, false);
  assert.throws(
    () => v14ExecuteRecovery(plan, {}, 'escalate'),
    /no recovery step found/,
  );
});

/* ================================================================== */
/* Agent pipeline                                                      */
/* ================================================================== */

test('runV14Agent: task thành công — reasoning, file change, done', () => {
  const report = runV14Agent({
    runId: 'run-ok',
    prompt: 'Add a null check in auth.ts',
    maxSteps: 10,
    stepFn: scriptedV14Agent([
      {
        text: 'I will add the null check.',
        reasoning: { kind: 'thinking', text: 'The bug is a missing null check in login().' },
        toolCalls: [
          {
            tool: 'edit_file',
            args: { path: 'src/auth.ts' },
            status: 'ok',
            outputPreview: 'edited',
            fileChange: { path: 'src/auth.ts', kind: 'edit', beforeContent: 'old', afterContent: 'new' },
          },
        ],
        done: false,
      },
      { text: 'Done — null check added and verified.', toolCalls: [], done: true },
    ]),
  });
  assert.equal(report.outcome, 'completed');
  assert.equal(report.stepsRun, 2);
  assert.equal(report.toolCalls, 1);
  assert.equal(report.reasoningBlocks, 1);
  assert.deepEqual(report.filesChanged, ['src/auth.ts']);
  assert.equal(report.condensations.length, 0);
  assert.equal(report.stuckReports.length, 0);
  assert.match(renderV14AgentReport(report), /outcome=completed/);
});

test('runV14Agent: loop cùng lỗi → stuck + recovery narrow_scope, script hết thì done', () => {
  const report = runV14Agent({
    runId: 'run-loop',
    prompt: 'Fix the flaky test',
    maxSteps: 20,
    stepFn: scriptedV14Agent([
      ...loopingV14Script('run_tests', 4),
      { text: 'Tried a different approach and it passed.', toolCalls: [], done: true },
    ]),
  });
  assert.equal(report.outcome, 'completed');
  assert.ok(report.stuckReports.length >= 1, 'phải phát hiện kẹt');
  assert.ok(report.recoveries.length >= 1, 'phải recovery ít nhất một lần');
  // Lỗi giống nhau lặp lại → repeat_error ưu tiên hơn repeat_action → narrow_scope trước.
  assert.equal(report.recoveries[0].strategy, 'narrow_scope');
  assert.ok(report.toolErrors >= 3);
});

test('runV14Agent: escalate khi recovery đã 2 lần mà vẫn kẹt → stuck_unresolved', () => {
  const report = runV14Agent({
    runId: 'run-escalate',
    prompt: 'Fix the impossible bug',
    maxSteps: 20,
    stepFn: scriptedV14Agent([
      ...loopingV14Script('run_tests', 12),
      { text: 'never reached', toolCalls: [], done: true },
    ]),
  });
  assert.equal(report.outcome, 'stuck_unresolved');
  assert.ok(report.recoveries.length >= 2);
  assert.equal(report.recoveries[report.recoveries.length - 1].strategy, 'escalate');
});

test('runV14Agent: auto-condense khi log vượt ngưỡng + resume giữ reasoning', () => {
  const dir = tmpDir();
  try {
    const dataDir = path.join(dir, 'v14data');
    const steps = [];
    for (let i = 0; i < 6; i += 1) {
      steps.push({
        text: `Step ${i}: working on the long task with lots of context to force condensation`,
        reasoning: { kind: 'thinking', text: `Thinking hard about step ${i} of the long task.` },
        toolCalls: [
          {
            tool: 'read_file',
            args: { path: `src/module${i}.ts` },
            status: 'ok',
            outputPreview: `content of module ${i} `.repeat(20),
          },
        ],
        done: false,
      });
    }
    steps.push({ text: 'Finished the long task.', toolCalls: [], done: true });
    const first = runV14Agent({
      runId: 'run-long',
      prompt: 'Long task that needs condensation',
      maxSteps: 4,
      stepFn: scriptedV14Agent(steps),
      dataDir,
      condenseOptions: { minEvents: 8, minTokens: 200 },
    });
    assert.equal(first.resumeState.nextStep, 4);
    assert.ok(first.condensations.length >= 1, 'phải condense ít nhất một lần');
    assert.ok(first.condensations[0].tokensSaved >= 0 || first.condensations[0].tokensBefore > 0);
    assert.ok(first.reasoningBlocks >= 3);
    // Log + sidecar thật trên đĩa.
    assert.ok(fs.existsSync(path.join(dataDir, 'run-logs', 'run-long.jsonl')));
    assert.ok(fs.existsSync(path.join(dataDir, 'reasoning', 'run-long.reasoning.jsonl')));

    // Resume từ resumeState: reasoning cũ còn, step tiếp tục (full
    // script — scripted agent index theo step tuyệt đối).
    const resumed = runV14Agent({
      runId: 'run-long',
      prompt: 'Long task that needs condensation',
      maxSteps: 20,
      stepFn: scriptedV14Agent(steps),
      dataDir,
      condenseOptions: { minEvents: 8, minTokens: 200 },
      resumeFrom: first.resumeState,
    });
    assert.equal(resumed.outcome, 'completed');
    assert.ok(resumed.reasoningBlocks >= first.reasoningBlocks, 'reasoning cũ phải còn sau resume');
    assert.equal(resumed.resumeState.nextStep, first.resumeState.nextStep + 3);
  } finally {
    cleanup(dir);
  }
});

test('CodingAgentV14: stepFn ném lỗi → failed; plan invalid thì throw sớm', () => {
  const failed = runV14Agent({
    runId: 'run-fail',
    prompt: 'Boom task',
    stepFn: () => {
      throw new Error('model exploded');
    },
  });
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.finalText, /model exploded/);

  assert.throws(() => new CodingAgentV14({ runId: '', prompt: 'x', stepFn: scriptedV14Agent([]) }), /runId/);
  assert.throws(() => new CodingAgentV14({ runId: 'r', prompt: '', stepFn: scriptedV14Agent([]) }), /prompt/);
  assert.throws(
    () => runV14Agent({ runId: 'r', prompt: 'x', stepFn: () => ({ text: 'bad' }) }),
    /invalid V14StepResult/,
  );
});
