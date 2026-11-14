/**
 * Test v1.04 (Đội T4): delegation v2 — tracker + merge + tools.
 *
 * Tracker:
 * - Lifecycle pending → running → done/error/timeout; trạng thái session
 *   suy ra từ các con; complete/fail/timeout sai trạng thái thì throw.
 * - summarize: đếm con, % hoàn thành, elapsed.
 * - refreshChildFromLog: fold log con thật → steps/toolCalls.
 * - pruneFinished + giới hạn session.
 *
 * Merge:
 * - concat: nối đủ, có tiêu đề từng con.
 * - summarize: trích gọn, cắt output dài.
 * - verdict: verdict đa số + liệt kê xung đột; không verdict → nói rõ.
 *
 * Tools (mock CHỈ ở đây — fake ctx.runSubagent, ghi rõ mock-only):
 * - delegate_to_agent: done/timeout/error phân loại đúng từ chuỗi
 *   `[subagent …]`; verdict trích từ dòng `Verdict:`.
 * - delegate_parallel: chạy song song, merge verdict, conflicts đúng.
 * - delegation_status: đọc tiến độ từ tracker.
 * - Không có ctx.runSubagent → lỗi rõ, không crash.
 *
 * Build core + tools trước:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/delegation-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import {
  DelegationTracker,
  deriveSessionStatus,
  detectVerdictConflicts,
  majorityVerdict,
  mergeDelegationResults,
} from '../packages/core/dist/delegation/index.js';
import {
  classifySubagentOutput,
  createDelegationTools,
  extractVerdictFromOutput,
} from '../packages/tools/dist/delegationTools.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-delegation-v104-'));
}

function fakeCtx(runSubagent) {
  return { workspaceDir: tmpDir(), botId: 'bot-test', runSubagent };
}

test('tracker: lifecycle + trạng thái session suy ra từ con', () => {
  const tracker = new DelegationTracker();
  const session = tracker.createSession([
    { name: 'researcher', task: 'tìm hiểu X' },
    { name: 'coder', task: 'viết code Y' },
  ]);
  assert.equal(session.status, 'pending');
  assert.equal(session.children.length, 2);

  tracker.startChild(session.id, 'researcher');
  assert.equal(tracker.getSession(session.id).status, 'running');
  tracker.updateChildProgress(session.id, 'researcher', { steps: 2, toolCalls: 3, note: 'đang đọc file' });
  const summary = tracker.summarize(session.id);
  assert.equal(summary.childrenRunning, 1);
  assert.equal(summary.progressPct, 0);

  tracker.completeChild(session.id, 'researcher', {
    name: 'researcher',
    status: 'done',
    output: 'kết quả nghiên cứu',
    durationMs: 100,
  });
  assert.equal(tracker.getSession(session.id).status, 'running');
  assert.equal(tracker.summarize(session.id).progressPct, 50);

  tracker.startChild(session.id, 'coder');
  tracker.failChild(session.id, 'coder', {
    name: 'coder',
    status: 'error',
    output: '',
    durationMs: 50,
    error: 'lỗi biên dịch',
  });
  const done = tracker.getSession(session.id);
  assert.equal(done.status, 'error');
  assert.ok(done.endedAt !== undefined);
  assert.equal(tracker.summarize(session.id).progressPct, 100);
});

test('tracker: chuyển trạng thái sai thì throw; tên con trùng thì throw', () => {
  const tracker = new DelegationTracker();
  assert.throws(() => tracker.createSession([]), /ít nhất một agent con/);
  assert.throws(
    () =>
      tracker.createSession([
        { name: 'a', task: 'x' },
        { name: 'a', task: 'y' },
      ]),
    /bị trùng/,
  );
  const session = tracker.createSession([{ name: 'a', task: 'x' }]);
  assert.throws(() => tracker.completeChild(session.id, 'a', { name: 'a', status: 'done', output: 'ok', durationMs: 1 }), /không complete được/);
  assert.throws(() => tracker.startChild(session.id, 'khong-co'), /không có con/);
  assert.throws(() => tracker.summarize('khong-co'), /Không tìm thấy delegation/);
  assert.equal(deriveSessionStatus([]), 'pending');
});

test('tracker: refreshChildFromLog đọc steps/toolCalls thật từ log con', () => {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const childRunId = 'run-con-1';
  store.append(childRunId, { type: 'run.started', payload: { botId: 'bot-con' } });
  store.append(childRunId, { type: 'run.prompt', payload: { text: 'việc con' } });
  store.append(childRunId, {
    type: 'model.response',
    payload: { step: 0, text: 'ok', toolCalls: [{ callId: 'c0', tool: 'read_file', argKeys: ['path'] }] },
  });
  store.append(childRunId, { type: 'tool.call', payload: { callId: 'c0', tool: 'read_file', argKeys: ['path'], step: 0 } });
  store.append(childRunId, {
    type: 'tool.result',
    payload: { callId: 'c0', tool: 'read_file', status: 'ok', outputPreview: 'nội dung', durationMs: 5, step: 0 },
  });

  const tracker = new DelegationTracker();
  const session = tracker.createSession([{ name: 'con', task: 'việc con' }]);
  tracker.startChild(session.id, 'con', { childRunId });
  const refreshed = tracker.refreshChildFromLog(session.id, 'con', store);
  const child = refreshed.children[0];
  assert.equal(child.progress?.steps, 1);
  assert.equal(child.progress?.toolCalls, 1);
  assert.throws(() => tracker.refreshChildFromLog(session.id, 'con', { exists: () => false, readRun: () => ({ events: [] }) }), /không tồn tại/);
});

test('merge: concat nối đủ; summarize trích gọn; verdict đa số + xung đột', () => {
  const results = [
    { name: 'a', status: 'done', output: 'Kết luận A.\nChi tiết dài dòng của A.'.repeat(30), durationMs: 100, verdict: 'đồng ý' },
    { name: 'b', status: 'done', output: 'Kết luận B.', durationMs: 80, verdict: 'đồng ý' },
    { name: 'c', status: 'error', output: '', durationMs: 50, error: 'con C lỗi', verdict: 'từ chối' },
  ];
  const concat = mergeDelegationResults(results, 'concat');
  assert.match(concat.merged, /### a \(done\)/);
  assert.match(concat.merged, /### c \(error/);
  assert.match(concat.merged, /con C lỗi/);
  assert.equal(concat.report.succeeded, 2);
  assert.equal(concat.report.failed, 1);

  const summarized = mergeDelegationResults(results, 'summarize');
  assert.match(summarized.merged, /Verdict: đồng ý/);
  assert.match(summarized.merged, /rút gọn/);
  assert.ok(summarized.merged.length < concat.merged.length);

  const verdict = mergeDelegationResults(results, 'verdict');
  assert.equal(verdict.report.majorityVerdict, 'đồng ý');
  assert.deepEqual(verdict.report.conflicts, ['c']);
  assert.match(verdict.merged, /Verdict đa số: đồng ý \(2\/3 con đồng ý\)/);
  assert.match(verdict.merged, /Xung đột verdict: c/);

  assert.deepEqual(detectVerdictConflicts(results), ['c']);
  assert.equal(majorityVerdict(results), 'đồng ý');
  const noVerdict = mergeDelegationResults(
    [{ name: 'x', status: 'done', output: 'không kết luận', durationMs: 10 }],
    'verdict',
  );
  assert.equal(noVerdict.report.majorityVerdict, undefined);
  assert.match(noVerdict.merged, /Không có con nào đưa verdict/);
});

test('classifySubagentOutput + extractVerdictFromOutput', () => {
  assert.deepEqual(classifySubagentOutput('[subagent abc-1] done: xin chào'), {
    status: 'done',
    output: 'xin chào',
  });
  const timeout = classifySubagentOutput('[subagent abc-1] timeout sau 120000ms — đã dừng agent con');
  assert.equal(timeout.status, 'timeout');
  const error = classifySubagentOutput('[subagent abc-1] lỗi: không spawn được subagent con');
  assert.equal(error.status, 'error');
  assert.equal(error.error, 'không spawn được subagent con');
  assert.deepEqual(classifySubagentOutput('text trần không wrapper'), { status: 'done', output: 'text trần không wrapper' });
  assert.equal(extractVerdictFromOutput('Kết luận.\nVerdict: đồng ý\nChi tiết.'), 'đồng ý');
  assert.equal(extractVerdictFromOutput('không có verdict'), undefined);
});

test('tools: delegate_to_agent phân loại done/timeout/error + verdict', async () => {
  const tracker = new DelegationTracker();
  const tools = createDelegationTools({ tracker });
  const delegate = tools.find((t) => t.definition.name === 'delegate_to_agent');
  assert.ok(delegate);
  assert.equal(delegate.needsApproval, true);

  const doneCtx = fakeCtx(async () => '[subagent id-1] done: Kết quả xong.\nVerdict: đồng ý');
  const doneOut = JSON.parse(await delegate.execute({ task: 'làm X' }, doneCtx));
  assert.equal(doneOut.status, 'done');
  assert.equal(doneOut.output, 'Kết quả xong.\nVerdict: đồng ý');
  assert.equal(doneOut.verdict, 'đồng ý');
  assert.ok(doneOut.delegationId);
  assert.equal(tracker.getSession(doneOut.delegationId).status, 'done');

  const timeoutCtx = fakeCtx(async () => '[subagent id-2] timeout sau 120000ms — đã dừng agent con');
  const timeoutOut = JSON.parse(await delegate.execute({ task: 'làm Y' }, timeoutCtx));
  assert.equal(timeoutOut.status, 'timeout');
  assert.equal(tracker.getSession(timeoutOut.delegationId).status, 'timeout');

  const errorCtx = fakeCtx(async () => {
    throw new Error('runner nổ');
  });
  const errorOut = JSON.parse(await delegate.execute({ task: 'làm Z' }, errorCtx));
  assert.equal(errorOut.status, 'error');
  assert.match(errorOut.error, /runner nổ/);

  // Không có ctx.runSubagent → lỗi rõ.
  const noRunnerOut = await delegate.execute({ task: 'làm W' }, { workspaceDir: tmpDir(), botId: 'b' });
  assert.match(noRunnerOut, /chưa được hỗ trợ/);
});

test('tools: delegate_parallel merge verdict + delegation_status đọc tiến độ', async () => {
  const tracker = new DelegationTracker();
  const tools = createDelegationTools({ tracker });
  const parallel = tools.find((t) => t.definition.name === 'delegate_parallel');
  const statusTool = tools.find((t) => t.definition.name === 'delegation_status');
  assert.ok(parallel && statusTool);

  const ctx = fakeCtx(async (task) => {
    if (task.includes('A')) return '[subagent 1] done: A xong.\nVerdict: đồng ý';
    if (task.includes('B')) return '[subagent 2] done: B xong.\nVerdict: đồng ý';
    return '[subagent 3] done: C xong.\nVerdict: từ chối';
  });
  const out = JSON.parse(
    await parallel.execute(
      {
        tasks: [
          { name: 'a', task: 'việc A' },
          { name: 'b', task: 'việc B' },
          { name: 'c', task: 'việc C' },
        ],
        mergeStrategy: 'verdict',
      },
      ctx,
    ),
  );
  assert.equal(out.strategy, 'verdict');
  assert.equal(out.report.majorityVerdict, 'đồng ý');
  assert.deepEqual(out.report.conflicts, ['c']);
  assert.match(out.merged, /Verdict đa số/);

  const statusOut = JSON.parse(await statusTool.execute({ delegationId: out.delegationId }, ctx));
  assert.equal(statusOut.status, 'done');
  assert.equal(statusOut.childrenTotal, 3);
  assert.equal(statusOut.childrenDone, 3);
  assert.equal(statusOut.progressPct, 100);

  const unknown = await statusTool.execute({ delegationId: 'khong-co' }, ctx);
  assert.match(unknown, /Không tìm thấy delegation/);
  const badTasks = await parallel.execute({ tasks: [] }, ctx);
  assert.match(badTasks, /không rỗng/);
});
