/**
 * Tests cho coding agent v15 — hooks dialog + verify scenarios + agent (v1.37, Đội T4).
 *
 * Chạy thật: dialog thật (memory + file JSON tạm), verify runner thật
 * với outcome mô phỏng, agent scripted thật (ghi file thật ra workspace
 * tạm). Không gọi model/mạng.
 *   npm run build --workspace=@open-bot/core (scoped, trong worktree)
 *   node --test tests/coding-v15-hooks-verify-v137.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CodingV15HooksDialog,
  renderV15HooksDialog,
  routeStopHookFeedback,
  runV15Agent,
  runV15AgentWithVerify,
  scriptedV15Agent,
  v15BuiltinScenarios,
  v15CheckStepOutcome,
  v15CorrectOutcomes,
  v15RunScenario,
  v15RunVerifyScenarios,
  v15ScriptedVerifyStepFn,
  v15WrongOutcomes,
} from '../packages/core/dist/index.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Không chặn test.
  }
}

test('hooks dialog: feedback ngoài chat — add/list/confirm/dismiss/snooze + persistence', () => {
  const dir = tmpDir('open-bot-v15-hooks-');
  try {
    const dialog = new CodingV15HooksDialog({ dataDir: dir });
    assert.equal(dialog.state().total, 0);
    assert.equal(dialog.state().open, false);
    // routeStopHookFeedback: feedback vào dialog, chat không bị chạm.
    const routed = routeStopHookFeedback(dialog, {
      runId: 'run-1',
      source: 'stop-hook',
      title: 'Stop hook: tests failed',
      body: '3 tests failed after the last edit.',
      severity: 'warning',
    });
    assert.equal(routed.chatUntouched, true);
    assert.equal(routed.feedback.status, 'pending');
    assert.equal(routed.feedback.hookKind, 'stop');
    assert.equal(routed.dialogState.open, true);
    assert.equal(routed.dialogState.pending, 1);
    // Thêm feedback nữa, pending theo thứ tự cũ nhất trước.
    dialog.addFeedback({ runId: 'run-1', source: 'stop-hook', title: 'Second', body: 'Second feedback.', severity: 'error' });
    assert.deepEqual(dialog.pending().map((f) => f.title), ['Stop hook: tests failed', 'Second']);
    assert.equal(dialog.pendingForRun('run-1').length, 2);
    assert.equal(dialog.pendingForRun('run-2').length, 0);
    // Confirm feedback đầu.
    const firstId = dialog.pending()[0].id;
    const confirmed = dialog.decide(firstId, 'confirm', 'Seen, will fix.');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.note, 'Seen, will fix.');
    assert.ok(confirmed.decidedAt);
    assert.equal(dialog.state().pending, 1);
    assert.equal(dialog.state().confirmed, 1);
    // Snooze tối đa 3 lần, lần 4 bị từ chối.
    const secondId = dialog.pending()[0].id;
    dialog.decide(secondId, 'snooze');
    assert.equal(dialog.state().snoozed, 1);
    assert.equal(dialog.unsnoozeAll(), 1);
    assert.equal(dialog.state().pending, 1);
    dialog.decide(secondId, 'snooze');
    dialog.unsnoozeAll();
    dialog.decide(secondId, 'snooze');
    dialog.unsnoozeAll();
    assert.throws(() => dialog.decide(secondId, 'snooze'), /đã snooze 3 lần/);
    // Dismiss + quyết định lại bị chặn + id không tồn tại.
    dialog.decide(secondId, 'dismiss');
    assert.equal(dialog.state().dismissed, 1);
    assert.throws(() => dialog.decide(secondId, 'confirm'), /đã ở trạng thái dismissed/);
    assert.throws(() => dialog.decide('vhf-nope-1', 'confirm'), /Không tìm thấy/);
    assert.throws(() => dialog.addFeedback({ runId: '', source: 's', title: 't', body: 'b' }), /runId/);
    // Render dialog chứa số liệu + feedback.
    const rendered = renderV15HooksDialog(dialog.state());
    assert.ok(rendered.includes('0 pending / 2 total'));
    // Persistence: dialog mới đọc lại file — quyết định còn nguyên.
    const dialog2 = new CodingV15HooksDialog({ dataDir: dir });
    assert.equal(dialog2.state().total, 2);
    assert.equal(dialog2.state().confirmed, 1);
    assert.equal(dialog2.state().dismissed, 1);
    assert.ok(fs.existsSync(path.join(dir, 'hooks-dialog.json')));
  } finally {
    cleanup(dir);
  }
});

test('verify: 9 scenario built-in, kỳ vọng rõ ràng; agent đúng pass 9/9, agent sai bị bắt', async () => {
  const scenarios = v15BuiltinScenarios();
  assert.equal(scenarios.length, 9);
  assert.deepEqual(
    scenarios.map((s) => s.kind),
    ['happy_path', 'tool_error', 'timeout', 'malformed_output', 'file_conflict', 'mid_run_test_failure', 'empty_response', 'permission_denied', 'large_diff'],
  );
  for (const s of scenarios) {
    assert.ok(s.expectation.length > 20, `${s.id} cần kỳ vọng rõ ràng`);
    assert.ok(s.timeoutMs > 0);
  }
  // Agent làm đúng → 9/9.
  const good = await v15RunVerifyScenarios(v15ScriptedVerifyStepFn(v15CorrectOutcomes()), { runId: 'verify-good', profileId: 'v15-general' });
  assert.equal(good.total, 9);
  assert.equal(good.passed, 9);
  assert.equal(good.failed, 0);
  assert.ok(good.summary.includes('9/9 scenarios passed'));
  // Agent làm sai → fail, và fail đúng scenario (tool_error retry 5 lần, permission retry 4 lần...).
  const bad = await v15RunVerifyScenarios(v15ScriptedVerifyStepFn(v15WrongOutcomes()), { runId: 'verify-bad' });
  assert.equal(bad.passed, 0);
  assert.equal(bad.failed, 9);
  const toolError = bad.results.find((r) => r.kind === 'tool_error');
  assert.equal(toolError.passed, false);
  assert.ok(toolError.checks.some((c) => c.name === 'retries-bounded' && !c.passed));
  const denied = bad.results.find((r) => r.kind === 'permission_denied');
  assert.ok(denied.checks.some((c) => c.name === 'no-retry-loop' && !c.passed));
  // failFast dừng ở scenario fail đầu tiên.
  const fast = await v15RunVerifyScenarios(v15ScriptedVerifyStepFn(v15WrongOutcomes()), { runId: 'verify-fast', failFast: true });
  assert.equal(fast.total, 1);
  // Chạy một scenario đơn lẻ + check malformed thật sự không parse được JSON.
  const single = await v15RunScenario(v15BuiltinScenarios().find((s) => s.kind === 'malformed_output'), v15ScriptedVerifyStepFn(v15CorrectOutcomes()));
  assert.equal(single.passed, true);
  assert.ok(single.checks.some((c) => c.name === 'output-indeed-malformed' && c.passed));
  // Check trực tiếp: timeout chỉ pass khi duration vượt timeoutMs.
  const timeoutChecks = v15CheckStepOutcome('timeout', { status: 'ok', durationMs: 100, agentStopped: false, agentReportedError: false }, v15BuiltinScenarios().find((s) => s.kind === 'timeout'));
  assert.ok(timeoutChecks.every((c) => !c.passed));
  // Validate: scenario không có expectation / timeoutMs sai → reject.
  await assert.rejects(
    () => v15RunScenario({ id: 'bad', kind: 'timeout', name: 'Bad', description: '', expectation: '', timeoutMs: 0, builtin: false }, () => ({ status: 'ok' })),
    /expectation/,
  );
  await assert.rejects(
    () => v15RunVerifyScenarios(() => ({ status: 'ok' }), { runId: '', scenarios: v15BuiltinScenarios() }),
    /runId/,
  );
  await assert.rejects(
    () => v15RunVerifyScenarios(() => ({ status: 'ok' }), { runId: 'x', scenarios: [] }),
    /ít nhất một scenario/,
  );
});

test('agent v15: profile + budget + hooks dialog + file thật, verify sau run', async () => {
  const dir = tmpDir('open-bot-v15-agent-');
  const ws = tmpDir('open-bot-v15-ws-');
  try {
    const steps = [
      {
        text: 'Fixing auth.ts now.',
        toolCalls: [{ tool: 'edit_file', args: { path: 'src/auth.ts' }, status: 'ok', outputPreview: 'edited', fileChange: { path: 'src/auth.ts', kind: 'edit', beforeContent: 'old', afterContent: 'new-login' } }],
        done: false,
        inputTokens: 100,
        outputTokens: 50,
      },
      {
        text: 'Tests failed once, stopping.',
        toolCalls: [{ tool: 'run_tests', args: {}, status: 'error', error: 'exit code 1' }],
        done: false,
        inputTokens: 80,
        outputTokens: 20,
        stopHookFeedback: { source: 'stop-hook', title: 'Stop requested', body: 'User asked to stop after test failure.', severity: 'warning' },
      },
      { text: 'Done.', toolCalls: [], done: true, inputTokens: 10, outputTokens: 5 },
    ];
    const result = runV15Agent(
      { runId: 'agent-1', prompt: 'Fix login', profileId: 'v15-fixer', botId: 'bot-9', budgetCap: { maxTokens: 100 } },
      scriptedV15Agent(steps),
      {
        dataDir: dir,
        fileApplier: (filePath, content) => {
          const abs = path.join(ws, filePath);
          if (content === null) fs.rmSync(abs, { force: true });
          else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content, 'utf8');
          }
        },
      },
    );
    assert.equal(result.profileId, 'v15-fixer');
    assert.equal(result.stepsExecuted, 3);
    assert.equal(result.done, true);
    assert.equal(result.stoppedByMaxSteps, false);
    // File ghi thật ra workspace.
    assert.equal(fs.readFileSync(path.join(ws, 'src/auth.ts'), 'utf8'), 'new-login');
    assert.deepEqual(result.filesWritten, ['src/auth.ts']);
    // Tool error ghi lại, không chặn run.
    assert.equal(result.toolErrors.length, 1);
    assert.ok(result.toolErrors[0].includes('run_tests'));
    // Budget: 190 in + 75 out = 265 token, cap 100 → overCap nhưng run vẫn xong (report-only).
    assert.equal(result.budget.state.totalTokens, 265);
    assert.equal(result.budget.state.overCap, true);
    assert.equal(result.done, true);
    // Hooks dialog: 1 feedback pending, chat không bị chèn (agent result không có chat field nào từ hook).
    assert.equal(result.hooksDialog.pending, 1);
    assert.equal(result.hooksDialog.total, 1);
    assert.equal(result.hooksDialog.pendingItems[0].title, 'Stop requested');
    // Max steps dừng đúng.
    const capped = runV15Agent(
      { runId: 'agent-2', prompt: 'Loop', profileId: 'v15-general', maxSteps: 2 },
      scriptedV15Agent([{ text: 'a', done: false }, { text: 'b', done: false }, { text: 'c', done: true }]),
      { dataDir: dir },
    );
    assert.equal(capped.stepsExecuted, 2);
    assert.equal(capped.done, false);
    assert.equal(capped.stoppedByMaxSteps, true);
    // runV15AgentWithVerify: verify 9/9 kèm theo.
    const withVerify = await runV15AgentWithVerify(
      { runId: 'agent-3', prompt: 'Hi', profileId: 'v15-general' },
      scriptedV15Agent([{ text: 'Hi.', done: true }]),
      { dataDir: dir },
    );
    assert.equal(withVerify.verify.total, 9);
    assert.equal(withVerify.verify.passed, 9);
    // Validate input.
    assert.throws(() => runV15Agent({ runId: '', prompt: 'x' }, scriptedV15Agent([])), /runId/);
    assert.throws(() => runV15Agent({ runId: 'r', prompt: '' }, scriptedV15Agent([])), /prompt/);
    assert.throws(() => runV15Agent({ runId: 'r', prompt: 'x', profileId: 'no-such-profile' }, scriptedV15Agent([])), /Không tìm thấy profile/);
  } finally {
    cleanup(dir);
    cleanup(ws);
  }
});
