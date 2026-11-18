/**
 * Tests cho coding agent v6 (v1.14, Đội T3): event-sourced log
 * (replay/time-travel/fork), CodeAct-lite v2 (một format action),
 * security analyzer + approval gate, condenser v2 có cấu trúc,
 * stuck detection v6, delegation qua tool call, RouterLLM leo
 * thang, agent orchestrator, và 7 tool coding_v6_*.
 *
 * Chạy thật trong BotBox sandbox ở phần CodeAct/agent (không mock
 * executor). Build core + tools trước:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/coding-v6-v114.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BotBoxManager } from '../packages/core/dist/sandbox/box.js';
import { CodeActExecutor } from '../packages/core/dist/codeact/index.js';
import {
  CodingAgentV6,
  CodingV6Log,
  RouterLlm,
  V6ApprovalGate,
  V6DelegateTracker,
  V6SecurityAnalyzer,
  analyzeV6Stuck,
  assessV6Action,
  applyV6Condensation,
  condenseV6Log,
  condenseV6Messages,
  executeV6CodeAction,
  extractFailingTestName,
  mergeV6DelegateResults,
  normalizeDelegateAction,
  parseV6ActionFromObject,
  parseV6ActionsFromText,
  runV6DelegateChild,
  runV6Delegation,
  scoreRouterLlmContext,
  shouldCondenseV6Log,
  suggestV6CommitSubject,
  tierForRouterLlmScore,
  v6ActionSignature,
  validateV6Action,
  verifyV6Chain,
} from '../packages/core/dist/codingV6/index.js';
import {
  ALL_TOOLS,
  CODING_V6_TOOL_NAMES,
  createCodingV6Tools,
  createDefaultTools,
} from '../packages/tools/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-coding-v6-v114-'));
}

function makeExecutor(dir, limits = {}) {
  const boxes = new BotBoxManager({ rootDir: path.join(dir, 'boxes') });
  const executor = new CodeActExecutor({ boxes, botId: 'coding-v6-test', limits });
  return { boxes, executor };
}

function makeLogWithWork() {
  const log = new CodingV6Log('sess-work');
  log.append('v6.session.started', { title: 'Sửa lỗi đăng nhập' });
  log.append('v6.user.message', { text: 'Sửa lỗi đăng nhập bị sai mật khẩu. Có cách nào khác không?' });
  log.append('v6.model.message', { text: 'Tôi sẽ kiểm tra.', step: 1 });
  log.append('v6.action.parsed', { kind: 'think', text: 'Quyết định: kiểm tra hàm login trước.\nKế hoạch: đọc code rồi sửa.' });
  log.append('v6.action.parsed', { kind: 'edit', path: 'src/auth.ts', content: 'fixed', mode: 'write' });
  log.append('v6.action.executed', { kind: 'edit', path: 'src/auth.ts', exitCode: 0, durationMs: 5 });
  log.append('v6.file.changed', { path: 'src/auth.ts', bytes: 5 });
  log.append('v6.observation', { kind: 'edit', ok: true, stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, blocked: false });
  log.append('v6.observation', { kind: 'bash', ok: false, stdout: 'FAIL tests/auth.test.ts\nError: wrong password', stderr: 'Error: wrong password', exitCode: 1, timedOut: false, blocked: false });
  log.append('v6.error', { message: 'Error: wrong password', source: 'bash' });
  return log;
}

// ---------------------------------------------------------------------------
// 1. Event-sourced conversation log
// ---------------------------------------------------------------------------

test('log: append seq liên tục + hash chain verify ok, sửa event thì lộ', () => {
  const log = makeLogWithWork();
  assert.equal(log.length, 10);
  assert.deepEqual(log.all().map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(verifyV6Chain(log.all()), { ok: true, checked: 10 });
  assert.equal(log.verify().ok, true);
  const tampered = log.all();
  tampered[4] = { ...tampered[4], payload: { kind: 'edit', path: 'src/HACKED.ts', content: 'x', mode: 'write' } };
  assert.equal(verifyV6Chain(tampered).ok, false);
  assert.equal(verifyV6Chain(tampered).firstBadSeq, 5);
});

test('log: fold ra state — file đã đổi, quyết định, lỗi đã gặp', () => {
  const state = makeLogWithWork().state();
  assert.equal(state.status, 'running');
  assert.equal(state.title, 'Sửa lỗi đăng nhập');
  assert.equal(state.messages.length, 2);
  assert.deepEqual(state.filesChanged, [{ path: 'src/auth.ts', firstSeq: 6, lastSeq: 7, changes: 2 }]);
  assert.equal(state.decisions.length, 1);
  assert.match(state.decisions[0].text, /kiểm tra hàm login/);
  assert.equal(state.errors.length, 2);
  assert.equal(state.actionsExecuted, 1);
  assert.equal(state.failedObservations, 1);
});

test('log: stateAt time-travel — state tại seq giữa log', () => {
  const log = makeLogWithWork();
  const at5 = log.stateAt(5);
  assert.equal(at5.lastSeq, 5);
  assert.equal(at5.filesChanged.length, 0);
  assert.equal(at5.decisions.length, 1);
  const at10 = log.stateAt(10);
  assert.equal(at10.filesChanged.length, 1);
  assert.equal(at10.errors.length, 2);
  // Log gốc không đổi sau time-travel.
  assert.equal(log.length, 10);
});

test('log: replayFrom — state trước/sau khớp fold toàn bộ', () => {
  const log = makeLogWithWork();
  const { before, after, replayed } = log.replayFrom(6);
  assert.equal(before.lastSeq, 5);
  assert.equal(replayed, 5);
  assert.ok(CodingV6Log.statesEqual(after, log.state()));
  const replay2 = log.replayFrom(6);
  assert.ok(CodingV6Log.statesEqual(replay2.after, after));
});

test('log: forkAt — con sao chép prefix, chain con ok, cha ghi fork', () => {
  const log = makeLogWithWork();
  const child = log.forkAt(5, 'sess-fork');
  assert.equal(child.sessionId, 'sess-fork');
  assert.equal(child.verify().ok, true);
  assert.equal(child.length, 6); // 5 event prefix + session.started
  assert.equal(child.stateAt(5).decisions.length, 1);
  assert.equal(child.stateAt(5).filesChanged.length, 0);
  assert.equal(log.length, 11); // cha thêm event v6.forked
  assert.equal(log.all()[10].type, 'v6.forked');
  assert.throws(() => log.forkAt(99), /ngoài khoảng/);
});

test('log: JSONL roundtrip — nạp lại verify ok, state khớp', () => {
  const log = makeLogWithWork();
  const jsonl = log.toJsonl();
  const loaded = CodingV6Log.fromJsonl('sess-work', jsonl);
  assert.equal(loaded.verify().ok, true);
  assert.ok(CodingV6Log.statesEqual(loaded.state(), log.state()));
  const bad = `${jsonl.split('\n')[0].replace('Sửa lỗi', 'SỬA LỖI')}\n${jsonl.split('\n').slice(1).join('\n')}`;
  assert.throws(() => CodingV6Log.fromJsonl('sess-work', bad), /chain sai/);
});

// ---------------------------------------------------------------------------
// 2. CodeAct-lite v2 — parse thống nhất
// ---------------------------------------------------------------------------

test('codeact v2: parse JSON đơn + danh sách actions', () => {
  const single = parseV6ActionsFromText('{"kind":"bash","command":"ls -la"}');
  assert.equal(single.actions.length, 1);
  assert.equal(single.actions[0].kind, 'bash');
  const list = parseV6ActionsFromText('{"actions":[{"kind":"think","text":"suy nghĩ"},{"kind":"finish","summary":"xong"}]}');
  assert.deepEqual(list.actions.map((a) => a.kind), ['think', 'finish']);
  assert.throws(() => parseV6ActionsFromText('{"kind":"teleport","x":1}'), /kind không biết/);
});

test('codeact v2: parse fenced bash/python đúng thứ tự, bỏ js/rỗng', () => {
  const text = [
    'Kiểm tra:',
    '```bash', 'ls', '```',
    '```python', 'print(40 + 2)', '```',
    '```javascript', 'console.log("no")', '```',
    '```bash', '   ', '```',
  ].join('\n');
  const { actions, warnings } = parseV6ActionsFromText(text);
  assert.deepEqual(actions.map((a) => a.kind), ['bash', 'python']);
  assert.equal(actions[0].command, 'ls');
  assert.equal(actions[1].code, 'print(40 + 2)');
  assert.ok(warnings.length === 0);
  const plain = parseV6ActionsFromText('Tôi nghĩ nên đọc file trước đã.');
  assert.equal(plain.actions[0].kind, 'think');
  assert.equal(parseV6ActionsFromText('   ').actions.length, 0);
});

test('codeact v2: parse từ tool-call args + delegate + validate path', () => {
  const edit = parseV6ActionFromObject({ kind: 'edit', path: 'a/b.ts', content: 'x', mode: 'append' });
  assert.equal(edit.kind, 'edit');
  const delegate = parseV6ActionFromObject({ kind: 'delegate', task: 'Đọc file X', scope: 'src/', budget: { maxSteps: 5 } });
  assert.equal(delegate.task, 'Đọc file X');
  assert.equal(delegate.budget.maxSteps, 5);
  assert.throws(() => parseV6ActionFromObject({ kind: 'edit', path: '../secret.txt', content: 'x', mode: 'write' }), /không được chứa "\.\."/);
  assert.throws(() => parseV6ActionFromObject({ kind: 'edit', path: '/etc/passwd', content: 'x', mode: 'write' }), /tương đối/);
  assert.throws(() => parseV6ActionFromObject({ kind: 'bash', command: '   ' }), /rỗng/);
  assert.equal(v6ActionSignature({ kind: 'bash', command: 'echo hi' }), 'bash:echo hi');
  assert.doesNotThrow(() => validateV6Action({ kind: 'bash', command: 'echo hi' }));
  assert.throws(() => validateV6Action({ kind: 'bash', command: 'rm -rf /' }), /bị chặn/);
});

// ---------------------------------------------------------------------------
// 3. CodeAct-lite v2 — chạy thật trong BotBox
// ---------------------------------------------------------------------------

test('codeact v2: chạy bash + python thật, exit/stdout đúng', async () => {
  const dir = tmpDir();
  const { executor } = makeExecutor(dir);
  const bash = await executeV6CodeAction({ kind: 'bash', command: 'echo hello-v6' }, executor);
  assert.equal(bash.ok, true);
  assert.equal(bash.exitCode, 0);
  assert.match(bash.stdout, /hello-v6/);
  const python = await executeV6CodeAction({ kind: 'python', code: 'print(40 + 2)' }, executor);
  assert.equal(python.ok, true);
  assert.match(python.stdout, /42/);
});

test('codeact v2: edit ghi file thật trong box + lệnh xấu trả blocked', async () => {
  const dir = tmpDir();
  const { executor } = makeExecutor(dir);
  const edit = await executeV6CodeAction({ kind: 'edit', path: 'hello-v6.txt', content: 'hi v6', mode: 'write' }, executor);
  assert.equal(edit.ok, true);
  assert.equal(edit.fileWritten.path, 'hello-v6.txt');
  const content = fs.readFileSync(path.join(executor.workspaceDir(), 'hello-v6.txt'), 'utf8');
  assert.equal(content, 'hi v6');
  const blocked = await executeV6CodeAction({ kind: 'bash', command: 'rm -rf /' }, executor);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  const failing = await executeV6CodeAction({ kind: 'bash', command: 'exit 3' }, executor);
  assert.equal(failing.ok, false);
  assert.equal(failing.exitCode, 3);
});

test('codeact v2: timeout — sleep dài với timeout ngắn thì timedOut', async () => {
  const dir = tmpDir();
  const { executor } = makeExecutor(dir, { timeoutMs: 500 });
  const result = await executeV6CodeAction({ kind: 'bash', command: 'sleep 5', timeoutMs: 500 }, executor);
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// 4. Security analyzer + approval gate
// ---------------------------------------------------------------------------

test('security: think/finish LOW không cần duyệt; edit MEDIUM; shell HIGH phải duyệt', () => {
  const think = assessV6Action({ kind: 'think', text: 'suy nghĩ' });
  assert.equal(think.level, 'LOW');
  assert.equal(think.requiresConfirmation, false);
  const edit = assessV6Action({ kind: 'edit', path: 'a.ts', content: 'x', mode: 'write' });
  assert.equal(edit.level, 'MEDIUM');
  assert.equal(edit.requiresConfirmation, false);
  const push = assessV6Action({ kind: 'bash', command: 'git push origin main' });
  assert.equal(push.level, 'HIGH');
  assert.equal(push.requiresConfirmation, true);
  assert.equal(push.denied, false);
  const rm = assessV6Action({ kind: 'bash', command: 'rm -rf /tmp/xyz' });
  assert.equal(rm.level, 'HIGH');
  assert.ok(rm.score >= 90);
  assert.ok(rm.matchedRuleIds.includes('shell-rm-rf'));
});

test('security: tool lạ rỗng → UNKNOWN fail-closed; denylist chặn cứng', () => {
  const analyzer = new V6SecurityAnalyzer();
  const unknown = analyzer.assessToolCall('', {});
  assert.equal(unknown.level, 'UNKNOWN');
  assert.equal(unknown.score, -1);
  assert.equal(unknown.requiresConfirmation, true);
  const read = analyzer.assessToolCall('read_file', { path: 'a.ts' });
  assert.equal(read.level, 'LOW');
  const deny = new V6SecurityAnalyzer({ analyzerOptions: { denylist: ['shell_exec'] } });
  const denied = deny.assess({ kind: 'bash', command: 'echo hi' });
  assert.equal(denied.denied, true);
  assert.equal(denied.level, 'HIGH');
});

test('security: gate request → decide một lần, quyết lại thì throw', () => {
  const gate = new V6ApprovalGate();
  const verdict = assessV6Action({ kind: 'bash', command: 'git push origin main' });
  const approval = gate.request({ kind: 'bash', command: 'git push origin main' }, verdict);
  assert.equal(gate.pendingCount, 1);
  assert.match(approval.reason, /HIGH/);
  const decision = gate.decide(approval.id, true, 'ok');
  assert.equal(decision.approved, true);
  assert.equal(gate.pendingCount, 0);
  assert.equal(gate.getDecision(approval.id).approved, true);
  assert.throws(() => gate.decide(approval.id, true), /không có approval đang chờ/);
  assert.throws(() => gate.decide('nope', false), /không có approval đang chờ/);
});

// ---------------------------------------------------------------------------
// 5. Condenser v2 có cấu trúc
// ---------------------------------------------------------------------------

test('condenser v2: giữ quyết định + file đã đổi + lỗi, đo token thật', () => {
  const log = makeLogWithWork();
  const c = condenseV6Log(log.all());
  assert.equal(c.covered, 10);
  assert.equal(c.upToSeq, 10);
  assert.ok(c.decisions.some((d) => d.includes('kiểm tra hàm login')));
  assert.deepEqual(c.filesChanged, [{ path: 'src/auth.ts', changes: 2 }]);
  assert.ok(c.errorsEncountered.some((e) => e.includes('wrong password')));
  assert.ok(c.openQuestions.some((q) => q.includes('Có cách nào khác không?')));
  assert.equal(c.actionCounts.think, 1);
  assert.equal(c.actionCounts.edit, 1);
  assert.ok(c.tokensBefore > 0);
  assert.ok(c.tokensAfter > 0);
  assert.equal(c.tokensSaved, c.tokensBefore - c.tokensAfter);
  assert.match(c.summary, /Task: Sửa lỗi đăng nhập/);
});

test('condenser v2: shouldCondense theo ngưỡng event/token; log rỗng → rỗng', () => {
  const log = makeLogWithWork();
  assert.equal(shouldCondenseV6Log(log.all(), { minEvents: 100, minTokens: 100000 }).needed, false);
  assert.equal(shouldCondenseV6Log(log.all(), { minEvents: 5 }).needed, true);
  const empty = condenseV6Log([]);
  assert.equal(empty.covered, 0);
  assert.equal(empty.summary, '');
  assert.equal(empty.tokensBefore, 0);
  const prefix = condenseV6Log(log.all(), { upToSeq: 5 });
  assert.equal(prefix.upToSeq, 5);
  assert.equal(prefix.covered, 5);
  assert.equal(prefix.filesChanged.length, 0);
});

test('condenser v2: condense message + apply — giữ N message cuối, thay prefix bằng tóm tắt', () => {
  const messages = [
    { role: 'user', text: 'Sửa lỗi login.' },
    { role: 'model', text: 'Quyết định: kiểm tra hàm login.\nFile: src/auth.ts' },
    { role: 'model', text: 'Lỗi: wrong password' },
    { role: 'user', text: 'Tiếp tục đi.' },
    { role: 'model', text: 'Đã sửa xong.' },
  ];
  const c = condenseV6Messages(messages);
  assert.ok(c.decisions.some((d) => d.includes('kiểm tra hàm login')));
  assert.deepEqual(c.filesChanged, [{ path: 'src/auth.ts', changes: 1 }]);
  assert.ok(c.errorsEncountered.some((e) => e.includes('wrong password')));
  const applied = applyV6Condensation(messages, c, 2);
  assert.equal(applied.length, 3);
  assert.equal(applied[0].role, 'system');
  assert.match(applied[0].text, /Lịch sử đã nén/);
  assert.match(applied[0].text, /kiểm tra hàm login/);
  assert.equal(applied[2].text, 'Đã sửa xong.');
});

// ---------------------------------------------------------------------------
// 6. Stuck detection v6
// ---------------------------------------------------------------------------

function stuckLogWith(actions, observations = []) {
  const log = new CodingV6Log('sess-stuck');
  log.append('v6.session.started', { title: 'stuck test' });
  let step = 0;
  for (let i = 0; i < actions.length; i += 1) {
    step += 1;
    log.append('v6.model.message', { text: `step ${step}`, step });
    log.append('v6.action.parsed', { ...actions[i] });
    const obs = observations[i] ?? { kind: actions[i].kind, ok: true, stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, blocked: false };
    log.append('v6.observation', obs);
  }
  return log;
}

test('stuck v6: cùng action 3x → repeat_action + gợi ý đổi chiến lược', () => {
  const action = { kind: 'bash', command: 'echo hi' };
  const report = analyzeV6Stuck('sess-stuck', stuckLogWith([action, action, action]).all());
  assert.equal(report.stuck, true);
  assert.ok(report.signals.some((s) => s.kind === 'repeat_action' && s.count === 3));
  assert.equal(report.topSuggestion.kind, 'change_strategy');
  const clean = analyzeV6Stuck('sess-stuck', stuckLogWith([
    { kind: 'bash', command: 'echo 1' },
    { kind: 'bash', command: 'echo 2' },
  ]).all());
  assert.equal(clean.stuck, false);
  assert.equal(clean.suggestions.length, 0);
});

test('stuck v6: cùng lỗi 3x + cùng test fail 3x → repeat_error + test_fail_loop', () => {
  const action = { kind: 'bash', command: 'npm test' };
  const failObs = { kind: 'bash', ok: false, stdout: 'FAIL tests/auth.test.ts\nError: wrong password', stderr: 'Error: wrong password', exitCode: 1, timedOut: false, blocked: false };
  const report = analyzeV6Stuck('sess-stuck', stuckLogWith([action, action, action], [failObs, failObs, failObs]).all());
  assert.ok(report.signals.some((s) => s.kind === 'repeat_error'));
  const testSignal = report.signals.find((s) => s.kind === 'test_fail_loop');
  assert.ok(testSignal);
  assert.match(testSignal.detail, /tests\/auth\.test\.ts/);
  assert.equal(extractFailingTestName('FAIL tests/auth.test.ts\nboom'), 'tests/auth.test.ts');
});

test('stuck v6: sửa cùng file 3x → same_file_edit + gợi ý hỏi user/delegate', () => {
  const edit = { kind: 'edit', path: 'src/auth.ts', content: 'x', mode: 'write' };
  const edit2 = { kind: 'edit', path: 'src/auth.ts', content: 'y', mode: 'write' };
  const report = analyzeV6Stuck('sess-stuck', stuckLogWith([edit, edit2, edit]).all());
  assert.ok(report.signals.some((s) => s.kind === 'same_file_edit' && s.count === 3));
  assert.ok(report.suggestions.some((s) => s.kind === 'ask_user'));
  assert.ok(report.suggestions.some((s) => s.kind === 'delegate'));
});

test('stuck v6: 8 step không tiến triển → no_progress + gợi ý dừng', () => {
  const log = new CodingV6Log('sess-stuck');
  log.append('v6.session.started', { title: 'no progress' });
  for (let i = 1; i <= 8; i += 1) {
    log.append('v6.model.message', { text: `step ${i}`, step: i });
    log.append('v6.action.parsed', { kind: 'think', text: `đang nghĩ ${i}` });
    log.append('v6.observation', { kind: 'think', ok: true, stdout: `đang nghĩ ${i}`, stderr: '' });
  }
  const report = analyzeV6Stuck('sess-stuck', log.all());
  assert.ok(report.signals.some((s) => s.kind === 'no_progress'));
  assert.ok(report.suggestions.some((s) => s.kind === 'stop'));
});

// ---------------------------------------------------------------------------
// 7. Delegation qua tool call
// ---------------------------------------------------------------------------

test('delegate: normalize điền budget mặc định; depth vượt cap thì throw', () => {
  const input = normalizeDelegateAction({ kind: 'delegate', task: 'Đọc file X' });
  assert.equal(input.name, 'delegate-1');
  assert.equal(input.timeoutMs, 120000);
  assert.equal(input.maxSteps, 20);
  assert.equal(input.maxTokens, 32000);
  assert.throws(() => normalizeDelegateAction({ kind: 'delegate', task: 'x' }, { depth: 3 }), /depth 3/);
  assert.throws(() => normalizeDelegateAction({ kind: 'delegate', task: 'x', budget: { timeoutMs: 0 } }), /timeoutMs/);
});

test('delegate: chạy con qua runner stub — done/timeout/không runner/trùng task', async () => {
  const runner = async (input) => ({ name: input.name, status: 'done', output: `xong: ${input.task}`, durationMs: 1 });
  const ok = await runV6DelegateChild(normalizeDelegateAction({ kind: 'delegate', task: 'làm A' }), runner);
  assert.equal(ok.status, 'done');
  assert.match(ok.output, /làm A/);
  const noRunner = await runV6DelegateChild(normalizeDelegateAction({ kind: 'delegate', task: 'làm B' }), undefined);
  assert.equal(noRunner.status, 'error');
  assert.match(noRunner.error, /Chưa nối sub-agent runner/);
  const slow = async () => new Promise(() => {});
  const timedOut = await runV6DelegateChild(
    normalizeDelegateAction({ kind: 'delegate', task: 'chậm', budget: { timeoutMs: 50 } }),
    slow,
  );
  assert.equal(timedOut.status, 'timeout');
  const tracker = new V6DelegateTracker();
  assert.equal(tracker.start('làm C'), true);
  assert.equal(tracker.start('làm C'), false);
  assert.equal(tracker.runningCount, 1);
  tracker.finish('làm C');
  assert.equal(tracker.runningCount, 0);
});

test('delegate: merge concat/summarize/verdict — verdict đa số + xung đột', async () => {
  const runner = async (input) => ({
    name: input.name,
    status: 'done',
    output: input.task.includes('1') ? 'Verdict: nên sửa A\nChi tiết 1' : 'Verdict: nên sửa B\nChi tiết 2',
    durationMs: 1,
  });
  const children = [
    normalizeDelegateAction({ kind: 'delegate', task: 'ý 1' }, { index: 0 }),
    normalizeDelegateAction({ kind: 'delegate', task: 'ý 1b' }, { index: 1 }),
    normalizeDelegateAction({ kind: 'delegate', task: 'ý 2' }, { index: 2 }),
  ];
  const { results, merged } = await runV6Delegation(children, runner, { mergeStrategy: 'verdict' });
  assert.equal(results.length, 3);
  assert.match(merged, /Đa số: "nên sửa A"/);
  assert.match(merged, /Xung đột/);
  const concat = mergeV6DelegateResults(results, 'concat');
  assert.match(concat, /\[delegate-1 — done\]/);
  const summary = mergeV6DelegateResults(results, 'summarize');
  assert.match(summary, /Verdict: nên sửa A/);
  await assert.rejects(() => runV6Delegation([], runner), /không có con nào/);
  await assert.rejects(
    () => runV6Delegation(Array.from({ length: 6 }, (_, i) => normalizeDelegateAction({ kind: 'delegate', task: `t${i}` }, { index: i })), runner),
    /vượt giới hạn 5/,
  );
});

// ---------------------------------------------------------------------------
// 8. RouterLLM leo thang
// ---------------------------------------------------------------------------

test('router: task dễ → light, task khó + lỗi + ảnh → strong, điểm/ngưỡng cấu hình được', () => {
  assert.equal(tierForRouterLlmScore(-1), 'light');
  assert.equal(tierForRouterLlmScore(3), 'standard');
  assert.equal(tierForRouterLlmScore(6), 'strong');
  const easy = scoreRouterLlmContext({ prompt: 'Hàm này là gì? Giải thích giúp tôi.' });
  assert.equal(easy.score, -1);
  const hard = scoreRouterLlmContext({
    prompt: 'Tái cấu trúc kiến trúc module này, đang bị race condition.',
    fileCount: 12,
    errorCount: 2,
    hasImage: true,
  });
  assert.ok(hard.score >= 6);
  assert.ok(hard.signals.some((s) => s.includes('ảnh')));
  assert.ok(hard.signals.some((s) => s.includes('lỗi')));
});

test('router: leo thang một chiều trong session, log lý do, reset về standard', () => {
  const router = new RouterLlm({ models: { light: 'light-m', standard: 'std-m', strong: 'strong-m' } });
  const d1 = router.route({ prompt: 'Hàm này là gì?' });
  assert.equal(d1.tier, 'light');
  assert.equal(d1.model, 'light-m');
  const d2 = router.route({ prompt: 'Sửa kiến trúc, đang lỗi.', fileCount: 20, errorCount: 3, hasImage: true });
  assert.equal(d2.tier, 'strong');
  assert.equal(d2.escalated, true);
  assert.match(d2.reason, /strong/);
  const d3 = router.route({ prompt: 'Hàm này là gì?' });
  assert.equal(d3.tier, 'strong'); // không hạ tier giữa session
  assert.equal(d3.escalated, false);
  assert.equal(router.history().length, 3);
  router.reset();
  assert.equal(router.tier, 'standard');
});

// ---------------------------------------------------------------------------
// 9. Agent orchestrator end-to-end (stub model)
// ---------------------------------------------------------------------------

function queueGenerator(texts) {
  let i = 0;
  return async () => {
    const text = texts[Math.min(i, texts.length - 1)];
    i += 1;
    return text;
  };
}

test('agent: turn happy path — think → bash (HIGH: pause, duyệt, chạy tiếp) → edit → finish + commit subject v5', async () => {
  const dir = tmpDir();
  const { executor } = makeExecutor(dir);
  const agent = new CodingAgentV6({ executor });
  agent.setGenerator(queueGenerator([
    '{"kind":"think","text":"Quyết định: tạo file hello rồi kiểm tra."}',
    '```bash\necho hello-v6\n```',
    '{"kind":"edit","path":"hello-v6.txt","content":"hi v6","mode":"write"}',
    '{"kind":"finish","summary":"Đã tạo file hello-v6.txt.","suggestCommit":true}',
  ]));
  agent.startSession('Tạo file hello');
  // Bash là HIGH (shell_exec) nên turn pause chờ duyệt, không chạy lén.
  const paused = await agent.runTurn('Tạo file hello-v6.txt');
  assert.equal(paused.status, 'paused');
  assert.ok(paused.pendingApproval);
  assert.equal(agent.state().actionsExecuted, 0);
  const resumed = await agent.approve(paused.pendingApproval.id, true);
  assert.equal(resumed.status, 'resumed');
  const result = await agent.continueTurn();
  assert.equal(result.status, 'finished');
  assert.ok(result.commitSubject);
  assert.match(result.commitSubject, /^feat\(.*\): update 1 file/);
  const state = agent.state();
  assert.equal(state.filesChanged.length, 1);
  assert.equal(state.filesChanged[0].path, 'hello-v6.txt');
  assert.equal(state.decisions.length, 2); // think decision + finish
  assert.equal(state.actionsExecuted, 2); // bash + edit
  assert.equal(agent.log.verify().ok, true);
  assert.ok(fs.existsSync(path.join(executor.workspaceDir(), 'hello-v6.txt')));
});

test('agent: action HIGH thì pause — approve true chạy tiếp, approve false bỏ qua', async () => {
  const dir = tmpDir();
  const { executor } = makeExecutor(dir);
  const agent = new CodingAgentV6({ executor });
  agent.setGenerator(queueGenerator([
    '{"kind":"bash","command":"git push origin main"}',
    '{"kind":"finish","summary":"xong"}',
  ]));
  agent.startSession('Push thử');
  const paused = await agent.runTurn('Push code lên remote');
  assert.equal(paused.status, 'paused');
  assert.ok(paused.pendingApproval);
  assert.equal(agent.gate.pendingCount, 1);
  assert.equal(agent.state().actionsExecuted, 0); // chưa chạy lén
  const resumed = await agent.approve(paused.pendingApproval.id, true, 'cho phép push thử');
  assert.equal(resumed.status, 'resumed');
  assert.equal(agent.state().actionsExecuted, 1);
  const finished = await agent.continueTurn();
  assert.equal(finished.status, 'finished');

  const agent2 = new CodingAgentV6({ executor });
  agent2.setGenerator(queueGenerator([
    '{"kind":"bash","command":"git push origin main"}',
    '{"kind":"finish","summary":"xong"}',
  ]));
  agent2.startSession('Push thử 2');
  const paused2 = await agent2.runTurn('Push code lên remote');
  assert.equal(paused2.status, 'paused');
  const denied = await agent2.approve(paused2.pendingApproval.id, false, 'không push');
  assert.equal(denied.status, 'resumed');
  assert.equal(agent2.state().actionsExecuted, 0);
  const finished2 = await agent2.continueTurn();
  assert.equal(finished2.status, 'finished');
});

test('agent: cùng action lặp 3x → stuck, gợi ý thoát có sẵn', async () => {
  const dir = tmpDir();
  const { executor } = makeExecutor(dir);
  const agent = new CodingAgentV6({ executor, maxSteps: 10 });
  // Dùng edit lặp (MEDIUM, không pause): bash là HIGH nên sẽ pause
  // trước khi đủ 3 lần lặp.
  agent.setGenerator(queueGenerator(['{"kind":"edit","path":"loop-v6.txt","content":"x","mode":"write"}']));
  agent.startSession('Lặp thử');
  const result = await agent.runTurn('Lặp lại sửa file');
  assert.equal(result.status, 'stuck');
  assert.ok(result.stuckReport);
  assert.ok(result.stuckReport.signals.some((s) => s.kind === 'repeat_action'));
  assert.ok(result.stuckReport.topSuggestion);
  assert.equal(agent.state().stuckDetections, 1);
});

test('agent: delegate qua tool call — con chạy stub runner, kết quả vào log', async () => {
  const dir = tmpDir();
  const { executor } = makeExecutor(dir);
  const agent = new CodingAgentV6({
    executor,
    delegateRunner: async (input) => ({ name: input.name, status: 'done', output: `Con đã đọc: ${input.task}`, durationMs: 2 }),
  });
  agent.setGenerator(queueGenerator([
    '{"kind":"delegate","task":"Đọc file src/auth.ts và tóm tắt","scope":"src/"}',
    '{"kind":"finish","summary":"Đã delegate xong"}',
  ]));
  agent.startSession('Delegate thử');
  const result = await agent.runTurn('Nhờ con đọc file');
  assert.equal(result.status, 'finished');
  assert.equal(agent.state().delegations, 1);
});

test('agent: log dài thì condense trong turn; fork + stateAt qua agent', async () => {
  const dir = tmpDir();
  const { executor } = makeExecutor(dir);
  const agent = new CodingAgentV6({ executor, condenseOptions: { minEvents: 6, minTokens: 100000 } });
  agent.setGenerator(queueGenerator([
    '{"kind":"think","text":"Quyết định: làm từng bước."}',
    '{"kind":"edit","path":"condense-v6.txt","content":"x","mode":"write"}',
    '{"kind":"finish","summary":"xong"}',
  ]));
  agent.startSession('Condense thử');
  const result = await agent.runTurn('Làm việc dài');
  assert.equal(result.status, 'finished');
  assert.ok(result.condensation);
  assert.ok(result.condensation.tokensBefore > 0);
  assert.equal(agent.state().condensations, 1);
  const child = agent.forkAt(3);
  assert.equal(child.log.verify().ok, true);
  assert.equal(child.stateAt(3).lastSeq, 3);
  const replayed = agent.replayFrom(2);
  assert.ok(replayed.replayed >= 1);
  assert.ok(CodingV6Log.statesEqual(replayed.after, agent.state()));
  assert.equal(suggestV6CommitSubject(agent.state()).length > 0, true);
});

test('agent: runTurn chưa gắn generator thì throw rõ', async () => {
  const agent = new CodingAgentV6();
  await assert.rejects(() => agent.runTurn('hi'), /chưa gắn model generator/);
});

// ---------------------------------------------------------------------------
// 10. Tools coding_v6_*
// ---------------------------------------------------------------------------

test('tools: đủ 7 tool v6, không trùng tên, ALL_TOOLS 491, binding giữ nguyên số lượng', () => {
  assert.equal(CODING_V6_TOOL_NAMES.length, 7);
  assert.equal(new Set(CODING_V6_TOOL_NAMES).size, 7);
  for (const name of CODING_V6_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `ALL_TOOLS thiếu ${name}`);
  }
  assert.equal(ALL_TOOLS.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const dir = tmpDir();
  const bound = createDefaultTools({ getCodingV6BaseDir: () => dir });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of CODING_V6_TOOL_NAMES) {
    assert.equal(bound.filter((t) => t.definition.name === name).length, 1, `${name} bị trùng sau binding`);
  }
  const unbound = createCodingV6Tools();
  assert.equal(unbound.length, 7);
});

test('tools: unbound run_text báo chưa cấu hình; security tool thuần chấm HIGH', async () => {
  const unbound = createCodingV6Tools();
  const runText = unbound.find((t) => t.definition.name === 'coding_v6_run_text');
  const ctx = { botId: 't', workspaceDir: tmpDir() };
  assert.match(await runText.execute({ sessionId: 's', text: 'hi' }, ctx), /not configured/);
  const security = unbound.find((t) => t.definition.name === 'coding_v6_security');
  const verdict = JSON.parse(await security.execute({ toolName: 'shell_exec', argsJson: '{"command":"rm -rf /tmp/x"}' }, ctx));
  assert.equal(verdict.level, 'HIGH');
  assert.equal(verdict.requiresConfirmation, true);
  const unknown = JSON.parse(await security.execute({ toolName: '' }, ctx));
  assert.equal(unknown.level, 'UNKNOWN');
});

test('tools: bound end-to-end — start → run_text (bash+edit) → replay → condense → delegate → approve', async () => {
  const dir = tmpDir();
  const { executor } = makeExecutor(dir);
  const tools = createCodingV6Tools(() => dir, { getCodeActExecutor: () => executor });
  const ctx = {
    botId: 't',
    workspaceDir: dir,
    runSubagent: async (task) => `Con xong: ${task}`,
  };
  const byName = (name) => tools.find((t) => t.definition.name === name);
  const start = JSON.parse(await byName('coding_v6_start').execute({ title: 'tool e2e' }, ctx));
  const sessionId = start.sessionId;
  assert.ok(sessionId);

  const run1 = JSON.parse(await byName('coding_v6_run_text').execute({
    sessionId,
    // Chỉ dùng edit (MEDIUM) ở đây: bash là HIGH nên sẽ pause chờ
    // duyệt — đường đó đã có test riêng ở phần git push bên dưới.
    text: '{"kind":"edit","path":"tool-e2e.txt","content":"ok","mode":"write"}',
  }, ctx));
  assert.equal(run1.status, 'done');
  assert.equal(run1.observations.length, 1);
  assert.ok(run1.observations.every((o) => o.ok));
  assert.deepEqual(run1.filesChanged.map((f) => f.path), ['tool-e2e.txt']);

  const replay = JSON.parse(await byName('coding_v6_replay').execute({ sessionId, atSeq: 3 }, ctx));
  assert.equal(replay.chainOk, true);
  assert.equal(replay.stateAt.lastSeq, 3);

  const condense = JSON.parse(await byName('coding_v6_condense').execute({ sessionId }, ctx));
  assert.ok(condense.tokensBefore > 0);
  assert.ok(condense.summary.length > 0);

  const delegate = JSON.parse(await byName('coding_v6_delegate').execute({ sessionId, task: 'Tóm tắt file tool-e2e.txt', scope: '.' }, ctx));
  assert.equal(delegate.delegations, 1);
  assert.match(delegate.result.output, /Con xong/);

  // HIGH → pause → approve.
  const runHigh = JSON.parse(await byName('coding_v6_run_text').execute({
    sessionId,
    text: '{"kind":"bash","command":"git push origin main"}',
  }, ctx));
  assert.equal(runHigh.status, 'paused');
  assert.ok(runHigh.pendingApproval.id);
  const approved = JSON.parse(await byName('coding_v6_approve').execute({
    sessionId,
    approvalId: runHigh.pendingApproval.id,
    approved: true,
    note: 'test duyệt',
  }, ctx));
  assert.equal(approved.approved, true);
  assert.equal(approved.status, 'resumed');

  // Log đã persist xuống đĩa, nạp lại vẫn verify ok.
  const files = fs.readdirSync(path.join(dir, 'coding-v6'));
  assert.equal(files.length, 1);
  const reloaded = CodingV6Log.fromJsonl(sessionId, fs.readFileSync(path.join(dir, 'coding-v6', files[0]), 'utf8'));
  assert.equal(reloaded.verify().ok, true);
  assert.ok(reloaded.state().delegations >= 1);
});
