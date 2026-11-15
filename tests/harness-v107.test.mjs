/**
 * Tests cho Harness v3 (v1.07, Đội T2): vòng lặp Agent/Conversation/
 * EventLog gọn, sub-agent delegation (TaskToolSet), critic inline,
 * budget meter token/cost/thời gian, LLM profiles + lệnh /model,
 * 3 tool harness_v3_* trong ALL_TOOLS, UI static checks.
 *
 * Run sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/harness-v107.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc credential thật, KHÔNG gọi API
 * ngoài: agent/workspace/sub-agent đều là fake trong test; profile
 * lưu vào thư mục tạm; cost tính từ bảng giá có sẵn (grok-4.1-fast).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CRITIC_CHECK_NON_EMPTY,
  DEFAULT_CRITIC_CHECKS,
  LlmProfileStore,
  SlashCommandRegistry,
  TaskToolSet,
  V3BudgetMeter,
  V3Conversation,
  compressDelegatedResult,
  formatBudgetMeterLine,
  formatDuration,
  handleModelCommand,
  parseModelCommand,
  registerModelSlashCommand,
  renderCriticInline,
  runCritic,
} from '../packages/core/dist/index.js';
import {
  ALL_TOOLS,
  HARNESS_V107_TOOL_NAMES,
  HARNESS_V107_TOOLS,
  createHarnessV107Tools,
} from '../packages/tools/dist/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCALES = ['en', 'vi', 'zh', 'ja', 'es', 'fr'];

const NEW_I18N_KEYS = [
  'harness.v107.budget.time',
  'harness.v107.budget.timeWithLimit',
  'harness.v107.conversation.stopped',
  'harness.v107.critic.fail',
  'harness.v107.critic.partial',
  'harness.v107.critic.pass',
  'harness.v107.critic.score',
  'harness.v107.delegate.done',
  'harness.v107.delegate.timeout',
  'harness.v107.model.current',
  'harness.v107.model.empty',
  'harness.v107.model.listTitle',
  'harness.v107.model.switched',
  'harness.v107.model.title',
];

function localeKeys(locale) {
  return JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales', `${locale}.json`),
      'utf8',
    ),
  );
}

/** Agent giả: chạy theo kịch bản Action cho sẵn (hết kịch bản thì finish). */
function scriptedAgent(actions) {
  let i = 0;
  return {
    name: 'scripted',
    decide: async () => {
      const action = actions[Math.min(i, actions.length - 1)];
      i += 1;
      return action;
    },
  };
}

const fakeWorkspace = {
  execute: async (action) => ({
    status: 'ok',
    output: `ran ${action.tool ?? action.kind}`,
    durationMs: 5,
    ...(action.tool === 'write_file' ? { changedFiles: ['a.txt'] } : {}),
  }),
};

// ---------------------------------------------------------------------------
// 1. V3Conversation — vòng lặp + EventLog append-only
// ---------------------------------------------------------------------------

test('v107 conversation: message -> tool_call -> finish, event seq tăng đều, critic inline có mặt', async () => {
  const conv = new V3Conversation('conv-1');
  const agent = scriptedAgent([
    { kind: 'message', text: 'Đang làm…' },
    { kind: 'tool_call', tool: 'write_file', args: { path: 'a.txt' } },
    { kind: 'finish', text: 'Xong việc.' },
  ]);
  const result = await conv.runTurn('Viết file a.txt', agent, fakeWorkspace);
  assert.equal(result.finishReason, 'agent_finished');
  assert.equal(result.finalText, 'Xong việc.');
  assert.equal(result.steps, 3);
  assert.ok(result.critic, 'critic phải chạy khi agent finish');
  assert.equal(result.critic.verdict, 'pass');
  assert.match(result.criticInline ?? '', /Kiểm chứng: đạt/);
  assert.match(result.criticInline ?? '', /Output không rỗng/);

  const events = conv.listEvents();
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_e, i) => i + 1),
    'seq tăng đều từ 1, không lỗ hổng',
  );
  assert.deepEqual(
    events.map((e) => e.type),
    [
      'turn.started',
      'user.message',
      'agent.action',
      'agent.message',
      'agent.action',
      'workspace.observation',
      'agent.action',
      'critic.report',
      'turn.completed',
    ],
  );
  const state = conv.state();
  assert.equal(state.status, 'completed');
  assert.equal(state.finishReason, 'agent_finished');
  assert.equal(state.eventCount, events.length);
});

test('v107 conversation: hết maxSteps thì dừng với max_steps, không chạy thêm step', async () => {
  const conv = new V3Conversation('conv-2', { maxSteps: 2, criticEnabled: false });
  const agent = scriptedAgent([{ kind: 'message', text: 'vẫn làm…' }]);
  const result = await conv.runTurn('Làm mãi đi', agent, fakeWorkspace);
  assert.equal(result.finishReason, 'max_steps');
  assert.equal(result.steps, 2);
  assert.equal(result.critic, undefined);
});

test('v107 conversation: agent throw -> turn.failed + finishReason agent_failed', async () => {
  const conv = new V3Conversation('conv-3');
  const agent = { name: 'broken', decide: async () => { throw new Error('boom'); } };
  const result = await conv.runTurn('Hỏi gì đó', agent, fakeWorkspace);
  assert.equal(result.finishReason, 'agent_failed');
  assert.equal(conv.state().status, 'failed');
  assert.ok(conv.listEvents().some((e) => e.type === 'turn.failed'));
});

test('v107 conversation: workspace throw -> turn.failed workspace_failed', async () => {
  const conv = new V3Conversation('conv-4');
  const agent = scriptedAgent([{ kind: 'tool_call', tool: 'boom_tool' }]);
  const workspace = { execute: async () => { throw new Error('workspace hỏng'); } };
  const result = await conv.runTurn('Chạy tool', agent, workspace);
  assert.equal(result.finishReason, 'workspace_failed');
});

test('v107 conversation: tool bị denied -> turn dừng, không retry mù', async () => {
  const conv = new V3Conversation('conv-5');
  const agent = scriptedAgent([
    { kind: 'tool_call', tool: 'danger' },
    { kind: 'finish', text: 'không tới được' },
  ]);
  const workspace = { execute: async () => ({ status: 'denied', output: 'bị chặn', durationMs: 1 }) };
  const result = await conv.runTurn('Chạy tool nguy hiểm', agent, workspace);
  assert.equal(result.finishReason, 'stopped');
  assert.equal(conv.state().status, 'stopped');
  assert.ok(conv.listEvents().some((e) => e.type === 'turn.stopped'));
});

test('v107 conversation: snapshot/restore giữ nguyên event + state', async () => {
  const conv = new V3Conversation('conv-6');
  await conv.runTurn('Hi', scriptedAgent([{ kind: 'finish', text: 'Chào!' }]), fakeWorkspace);
  const snap = conv.snapshot();
  assert.equal(snap.version, 1);
  const restored = V3Conversation.restore(snap);
  assert.equal(restored.id, 'conv-6');
  assert.equal(restored.listEvents().length, conv.listEvents().length);
  assert.equal(restored.state().status, 'completed');
  assert.equal(restored.state().finishReason, 'agent_finished');
});

test('v107 conversation: onEvent forward được mọi event (nối LocalHarness)', async () => {
  const seen = [];
  const conv = new V3Conversation('conv-7', { onEvent: (e) => seen.push(e.type) });
  await conv.runTurn('Hi', scriptedAgent([{ kind: 'finish', text: 'ok' }]), fakeWorkspace);
  assert.ok(seen.includes('turn.started'));
  assert.ok(seen.includes('turn.completed'));
  assert.equal(seen.length, conv.listEvents().length);
});

test('v107 conversation: runTurn rỗng / chạy chồng thì throw', async () => {
  const conv = new V3Conversation('conv-8');
  await assert.rejects(
    conv.runTurn('   ', scriptedAgent([{ kind: 'finish' }]), fakeWorkspace),
    /userPrompt không rỗng/,
  );
  // Chồng thật: agent đầu treo, turn thứ hai phải throw.
  const hanging = new V3Conversation('conv-8b');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const hangingAgent = { name: 'hang', decide: () => gate.then(() => ({ kind: 'finish', text: 'x' })) };
  const p1 = hanging.runTurn('treo', hangingAgent, fakeWorkspace);
  await assert.rejects(hanging.runTurn('chen', scriptedAgent([{ kind: 'finish' }]), fakeWorkspace), /đang chạy/);
  release();
  await p1;
});

// ---------------------------------------------------------------------------
// 2. Delegation (TaskToolSet) — nén kết quả + timeout + lỗi
// ---------------------------------------------------------------------------

test('v107 delegation: output ngắn trả nguyên, output dài nén có marker + truncated', () => {
  const short = compressDelegatedResult('kết quả ngắn');
  assert.equal(short.truncated, false);
  assert.equal(short.result, 'kết quả ngắn');

  const longText = Array.from({ length: 200 }, (_v, i) => `dòng ${i} ${'x'.repeat(50)}`).join('\n');
  const compressed = compressDelegatedResult(longText, { maxChars: 1000, maxLinesPerSide: 5 });
  assert.equal(compressed.truncated, true);
  assert.ok(compressed.result.length <= 1000 + 200, 'kết quả nén phải quanh giới hạn');
  assert.match(compressed.result, /đã nén: bỏ .* dòng/);
  assert.equal(compressed.rawLines, 200);
  assert.ok(compressed.resultTokens > 0 && compressed.resultTokens < compressed.rawChars);
});

test('v107 delegation: delegate thành công trả record nén, đổi file được giữ', async () => {
  const toolset = new TaskToolSet();
  const record = await toolset.delegate(
    'Nghiên cứu X',
    async () => ({ text: 'Kết luận: X tốt.', changedFiles: ['notes.md'], model: 'grok-4.1-fast' }),
    { role: 'researcher' },
  );
  assert.equal(record.status, 'done');
  assert.equal(record.result, 'Kết luận: X tốt.');
  assert.equal(record.truncated, false);
  assert.deepEqual(record.changedFiles, ['notes.md']);
  assert.equal(record.model, 'grok-4.1-fast');
  assert.equal(toolset.count, 1);
  assert.equal(toolset.list()[0].delegationId, record.delegationId);
});

test('v107 delegation: runner lỗi / timeout ghi vào record, không throw', async () => {
  const toolset = new TaskToolSet();
  const errRecord = await toolset.delegate('task lỗi', async () => { throw new Error('sập'); });
  assert.equal(errRecord.status, 'error');
  assert.match(errRecord.result, /Sub-agent lỗi: sập/);

  const slow = new TaskToolSet();
  const timeoutRecord = await slow.delegate(
    'task chậm',
    () => new Promise((resolve) => setTimeout(() => resolve('muộn'), 500)),
    { timeoutMs: 20 },
  );
  assert.equal(timeoutRecord.status, 'timeout');
  assert.match(timeoutRecord.result, /quá hạn 20ms/);
});

test('v107 delegation: action delegate trong conversation ghi đủ 2 event', async () => {
  const conv = new V3Conversation('conv-deleg', {
    delegateRunner: async (task) => `Kết quả cho: ${task}`,
  });
  const agent = scriptedAgent([
    { kind: 'delegate', task: 'Tìm hiểu Y', role: 'researcher' },
    { kind: 'finish', text: 'Đã có kết quả Y.' },
  ]);
  const result = await conv.runTurn('Tìm hiểu Y giúp', agent, fakeWorkspace);
  assert.equal(result.finishReason, 'agent_finished');
  const types = conv.listEvents().map((e) => e.type);
  assert.ok(types.includes('delegation.started'));
  assert.ok(types.includes('delegation.completed'));
  const completed = conv.listEvents().find((e) => e.type === 'delegation.completed');
  assert.equal(completed.payload.record.status, 'done');
  assert.match(completed.payload.record.result, /Kết quả cho: Tìm hiểu Y/);
});

test('v107 delegation: không có runner thì delegate báo lỗi rõ ràng, turn vẫn chạy tiếp', async () => {
  const conv = new V3Conversation('conv-deleg2');
  const agent = scriptedAgent([
    { kind: 'delegate', task: 'Tìm hiểu Z' },
    { kind: 'finish', text: 'Bỏ qua delegate.' },
  ]);
  const result = await conv.runTurn('Tìm hiểu Z giúp', agent, fakeWorkspace);
  assert.equal(result.finishReason, 'agent_finished');
  const completed = conv.listEvents().find((e) => e.type === 'delegation.completed');
  assert.equal(completed.payload.record.status, 'error');
  assert.match(completed.payload.record.result, /chưa cấu hình/);
});

// ---------------------------------------------------------------------------
// 3. Critic — check + render inline
// ---------------------------------------------------------------------------

test('v107 critic: bộ check mặc định pass khi output tốt, fail khi output rỗng + marker lỗi', async () => {
  const good = await runCritic(DEFAULT_CRITIC_CHECKS, {
    finalText: 'Đã xong, file đã ghi.',
    changedFiles: ['a.txt'],
    steps: 2,
    maxSteps: 25,
  });
  assert.equal(good.verdict, 'pass');
  assert.equal(good.passedCount, good.totalCount);
  assert.match(renderCriticInline(good), /✅/);

  const bad = await runCritic(DEFAULT_CRITIC_CHECKS, {
    finalText: '   ',
    lastObservation: { status: 'error', output: 'Traceback: boom', durationMs: 3 },
    changedFiles: [],
    steps: 1,
    maxSteps: 25,
    error: 'turn lỗi',
  });
  // non-empty vẫn đạt (observation lỗi vẫn có text) nên verdict là
  // partial: 1/4 đạt, 3 check kia fail.
  assert.equal(bad.verdict, 'partial');
  assert.equal(bad.passedCount, 1);
  assert.match(renderCriticInline(bad), /⚠️/);
  assert.match(renderCriticInline(bad), /✗ Không có marker lỗi trong output/);
  assert.match(renderCriticInline(bad), /✗ Turn không lỗi/);
  assert.match(renderCriticInline(bad), /✗ Observation cuối thành công/);

  // Fail toàn bộ (0/4): không finalText, không observation, có error,
  // và một check custom luôn fail để phủ hết — dùng check rỗng + custom.
  const allFail = await runCritic(
    [{ id: 'always-fail', label: 'Luôn fail', run: () => false, failHint: 'cố tình fail' }],
    { changedFiles: [], steps: 1, maxSteps: 25 },
  );
  assert.equal(allFail.verdict, 'fail');
  assert.match(renderCriticInline(allFail), /❌/);
});

test('v107 critic: check throw thì tính fail, không hỏng check khác; không có check thì pass rỗng', async () => {
  const report = await runCritic(
    [
      { id: 'boom', label: 'Check hỏng', run: () => { throw new Error('nổ'); } },
      CRITIC_CHECK_NON_EMPTY,
    ],
    { finalText: 'có nội dung', changedFiles: [], steps: 1, maxSteps: 5 },
  );
  assert.equal(report.verdict, 'partial');
  assert.equal(report.passedCount, 1);
  assert.match(report.checks[0].note ?? '', /Check lỗi: nổ/);

  const empty = await runCritic([], { changedFiles: [], steps: 0, maxSteps: 5 });
  assert.equal(empty.verdict, 'pass');
  assert.match(empty.summary, /không có check nào/);
});

// ---------------------------------------------------------------------------
// 4. Budget meter — token/cost/thời gian + cảnh báo 70/90%
// ---------------------------------------------------------------------------

test('v107 budget: đếm token + cost, warning 70%, critical 90%, exceeded khi chạm cap', () => {
  const alerts = [];
  const meter = new V3BudgetMeter('conv-b1', {
    tokenLimit: 1000,
    timeLimitMs: 60_000,
    onAlert: (snap) => alerts.push(snap.status),
    now: () => 0,
  });
  let snap = meter.record('grok-4.1-fast', 400, 200);
  assert.equal(snap.tokens.totalTokens, 600);
  assert.equal(snap.status, 'ok');
  assert.ok(typeof snap.tokens.costUsd === 'number' && snap.tokens.costUsd > 0);

  snap = meter.record('grok-4.1-fast', 100, 0);
  assert.equal(snap.status, 'warning', '700/1000 token = 70% -> warning');
  assert.ok(snap.warnings.some((w) => w.includes('Token')));

  snap = meter.record('grok-4.1-fast', 200, 0);
  assert.equal(snap.status, 'critical', '900/1000 token = 90% -> critical');

  snap = meter.record('grok-4.1-fast', 100, 0);
  assert.equal(snap.status, 'exceeded', '1000/1000 token -> exceeded');
  assert.deepEqual(alerts, ['warning', 'critical', 'exceeded'], 'mỗi mức alert đúng một lần');
});

test('v107 budget: hết thời gian cũng exceeded; format dòng meter cho chat', () => {
  let nowMs = 0;
  const meter = new V3BudgetMeter('conv-b2', { timeLimitMs: 1000, now: () => nowMs });
  meter.start();
  nowMs = 600;
  assert.equal(meter.snapshot().status, 'ok', '600/1000ms = 60% -> ok');
  nowMs = 950;
  assert.equal(meter.snapshot().status, 'critical', '950/1000ms = 95% -> critical');
  nowMs = 1000;
  const snap = meter.snapshot();
  assert.equal(snap.status, 'exceeded');
  assert.equal(snap.timePercentUsed, 100);
  const line = formatBudgetMeterLine(snap);
  assert.match(line, /Ngân sách: 100%/);
  assert.match(line, /đã vượt ngân sách/);
});

test('v107 budget: model chưa có giá -> cost null, không báo $0 giả', () => {
  const meter = new V3BudgetMeter('conv-b3', { tokenLimit: 100 });
  const snap = meter.record('model-khong-co-gia-xyz', 10, 5);
  assert.equal(snap.tokens.costUsd, null);
  assert.equal(snap.tokens.hasUnknownCost, true);
  assert.match(formatBudgetMeterLine(snap), /chi phí \?/);
});

test('v107 budget: formatDuration 800ms / 45s / 1m 30s', () => {
  assert.equal(formatDuration(800), '800ms');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(90_000), '1m 30s');
});

test('v107 budget: conversation dừng khi meter exceeded (budget_exceeded)', async () => {
  const meter = new V3BudgetMeter('conv-b4', { tokenLimit: 10 });
  meter.record('grok-4.1-fast', 10, 0);
  const conv = new V3Conversation('conv-b4', { budget: meter });
  const result = await conv.runTurn(
    'Làm gì đó',
    scriptedAgent([{ kind: 'finish', text: 'không tới được' }]),
    fakeWorkspace,
  );
  assert.equal(result.finishReason, 'budget_exceeded');
  assert.equal(result.steps, 0);
  assert.ok(result.budgetLine?.includes('đã vượt ngân sách'));
});

// ---------------------------------------------------------------------------
// 5. LLM profiles + lệnh /model
// ---------------------------------------------------------------------------

function makeStore() {
  const store = new LlmProfileStore();
  store.create({ id: 'grok-nhanh', name: 'Grok nhanh', providerId: 'xai', model: 'grok-4.1-fast' });
  store.create({ id: 'local', name: 'Local', providerId: 'ollama', model: 'llama3.1', temperature: 0.2 });
  return store;
}

test('v107 profiles: CRUD + validate + setActive + xoá active thì về null', () => {
  const store = makeStore();
  assert.equal(store.count, 2);
  assert.throws(() => store.create({ id: 'grok-nhanh', name: 'Trùng', providerId: 'xai', model: 'grok-4.7' }), /Đã có profile/);
  assert.throws(() => store.create({ name: 'Xấu', providerId: 'xai', model: 'm', temperature: 5 }), /temperature phải/);
  assert.throws(() => store.create({ id: 'BAD ID!', name: 'Xấu', providerId: 'xai', model: 'm' }), /không hợp lệ/);

  const updated = store.update('local', { maxTokens: 4096, notes: 'chạy local' });
  assert.equal(updated.maxTokens, 4096);
  assert.equal(updated.notes, 'chạy local');

  const active = store.setActive('grok-nhanh');
  assert.equal(active.id, 'grok-nhanh');
  assert.equal(store.activeProfileId, 'grok-nhanh');
  assert.throws(() => store.setActive('khong-co'), /Không có profile/);

  assert.equal(store.remove('grok-nhanh'), true);
  assert.equal(store.activeProfileId, null);
  assert.equal(store.remove('grok-nhanh'), false);
});

test('v107 profiles: save/load JSON giữ nguyên profile + active; file hỏng không crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v107-profiles-'));
  try {
    const file = path.join(dir, 'llm-profiles.json');
    const store = makeStore();
    store.setActive('local');
    assert.equal(store.save(), null, 'không có filePath thì save trả null');
    const diskStore = new LlmProfileStore({ filePath: file });
    diskStore.create({ id: 'grok-nhanh', name: 'Grok nhanh', providerId: 'xai', model: 'grok-4.1-fast' });
    diskStore.setActive('grok-nhanh');
    assert.equal(diskStore.save(), file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const loaded = new LlmProfileStore({ filePath: file });
    const res = loaded.load();
    assert.equal(res.loaded, 1);
    assert.equal(loaded.activeProfileId, 'grok-nhanh');
    assert.equal(loaded.get('grok-nhanh').model, 'grok-4.1-fast');

    fs.writeFileSync(file, '{ hỏng');
    const broken = new LlmProfileStore({ filePath: file });
    const brokenRes = broken.load();
    assert.equal(brokenRes.loaded, 0);
    assert.match(brokenRes.warning ?? '', /hỏng/);
    assert.equal(broken.count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v107 profiles: seedFromPresets tạo profile mẫu, gọi lại không nhân đôi', () => {
  const store = new LlmProfileStore();
  const created = store.seedFromPresets();
  assert.ok(created >= 10, `seed phải tạo >= 10 profile (nhận ${created})`);
  assert.ok(store.get('grok-nhanh'));
  assert.ok(store.get('deepseek'));
  assert.equal(store.get('deepseek').providerId, 'openai-compatible');
  assert.equal(store.seedFromPresets(), 0);
});

test('v107 model command: parse /model, /model list, /model <id>, /model help, /modelx không phải lệnh', () => {
  assert.deepEqual(parseModelCommand('/model'), { kind: 'current' });
  assert.deepEqual(parseModelCommand('/model list'), { kind: 'list' });
  assert.deepEqual(parseModelCommand('/model GROK-NHANH'), { kind: 'switch', profileId: 'grok-nhanh' });
  assert.deepEqual(parseModelCommand('/model help'), { kind: 'help' });
  assert.equal(parseModelCommand('/modelx'), null);
  assert.equal(parseModelCommand('hello'), null);
  assert.equal(parseModelCommand(''), null);
});

test('v107 model command: handle đổi profile, liệt kê, lỗi khi id không có', () => {
  const store = makeStore();
  const notModel = handleModelCommand('chào bot', store);
  assert.equal(notModel.handled, false);

  const switched = handleModelCommand('/model local', store);
  assert.equal(switched.handled, true);
  assert.equal(switched.switched, true);
  assert.equal(switched.profile.id, 'local');
  assert.match(switched.reply, /Đã đổi sang profile `local`/);
  assert.equal(store.activeProfileId, 'local');

  const listed = handleModelCommand('/model', store);
  assert.equal(listed.handled, true);
  assert.match(listed.reply, /Đang dùng profile `local`/);
  assert.match(listed.reply, /grok-nhanh/);

  const missing = handleModelCommand('/model khong-co', store);
  assert.equal(missing.handled, true);
  assert.equal(missing.switched, false);
  assert.match(missing.reply, /Không đổi được profile/);
  assert.match(missing.reply, /grok-nhanh/);

  const empty = handleModelCommand('/model', new LlmProfileStore());
  assert.match(empty.reply, /Chưa có profile LLM nào/);
});

test('v107 model command: đăng ký /model vào SlashCommandRegistry', () => {
  const store = makeStore();
  const registry = new SlashCommandRegistry();
  registerModelSlashCommand(registry, store);
  assert.equal(registry.has('model'), true);
  const parsed = registry.parse('/model local');
  assert.deepEqual(parsed, { name: 'model', args: 'local' });
  const def = registry.find('model');
  const reply = def.run('local', { args: 'local', rawInput: '/model local' });
  assert.match(String(reply), /Đã đổi sang profile `local`/);
});

// ---------------------------------------------------------------------------
// 6. Tools — 3 tool v1.07 trong ALL_TOOLS, không placeholder rỗng
// ---------------------------------------------------------------------------

test('v107 tools: 3 tool trong ALL_TOOLS, tên không trùng, execute là function thật', () => {
  for (const name of HARNESS_V107_TOOL_NAMES) {
    const found = ALL_TOOLS.find((t) => t.definition.name === name);
    assert.ok(found, `${name} phải có trong ALL_TOOLS`);
    assert.equal(typeof found.execute, 'function', `${name} phải có execute thật (bài học v1.00)`);
  }
  const allNames = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(allNames).size, allNames.length, 'ALL_TOOLS không được trùng tên tool');
  assert.deepEqual(HARNESS_V107_TOOLS.map((t) => t.definition.name), [...HARNESS_V107_TOOL_NAMES]);
});

test('v107 tools: placeholder chưa bind trả hướng dẫn, không giả vờ chạy', async () => {
  const ctx = { workspaceDir: '/tmp', botId: 'b1' };
  const [delegate, budget, model] = HARNESS_V107_TOOLS;
  assert.match(await delegate.execute({ task: 'làm X' }, ctx), /chưa được cấu hình/);
  assert.match(await budget.execute({}, ctx), /chưa được cấu hình/);
  assert.match(await model.execute({ action: 'list' }, ctx), /chưa được cấu hình/);
});

test('v107 tools: bound delegate/budget/model chạy thật qua factory', async () => {
  const ctx = { workspaceDir: '/tmp', botId: 'b1' };
  const store = makeStore();
  const tools = createHarnessV107Tools({
    runSubagent: async (task) => `xong: ${task}`,
    getBudgetSnapshot: () => {
      const meter = new V3BudgetMeter('ctx-conv', { tokenLimit: 1000 });
      meter.record('grok-4.1-fast', 100, 50);
      return meter.snapshot();
    },
    getProfileStore: () => store,
  });
  assert.equal(tools.length, 3);

  const delegateOut = JSON.parse(await tools[0].execute({ task: 'nghiên cứu A' }, ctx));
  assert.equal(delegateOut.status, 'done');
  assert.match(delegateOut.result, /xong: nghiên cứu A/);

  const budgetOut = JSON.parse(await tools[1].execute({}, ctx));
  assert.equal(budgetOut.status, 'ok');
  assert.equal(budgetOut.totalTokens, 150);
  assert.match(budgetOut.meterLine, /Ngân sách:/);

  const listOut = JSON.parse(await tools[2].execute({ action: 'list' }, ctx));
  assert.equal(listOut.profiles.length, 2);
  const switchOut = await tools[2].execute({ action: 'switch', profileId: 'grok-nhanh' }, ctx);
  assert.match(switchOut, /Đã đổi sang profile "grok-nhanh"/);
  assert.equal(store.activeProfileId, 'grok-nhanh');
  const badSwitch = await tools[2].execute({ action: 'switch', profileId: 'khong-co' }, ctx);
  assert.match(badSwitch, /^Error: /);
});

// ---------------------------------------------------------------------------
// 7. UI static checks — component + i18n đủ 6 locale
// ---------------------------------------------------------------------------

test('v107 ui: CriticInlineCard tồn tại, dùng đủ key critic; BudgetMeter có dòng thời gian', () => {
  const card = fs.readFileSync(
    path.join(ROOT, 'apps/desktop/src/renderer/components/CriticInlineCard.tsx'),
    'utf8',
  );
  assert.ok(card.includes('data-testid="critic-inline-card"'));
  for (const key of ['harness.v107.critic.pass', 'harness.v107.critic.partial', 'harness.v107.critic.fail', 'harness.v107.critic.score']) {
    assert.ok(card.includes(key), `CriticInlineCard phải dùng key ${key}`);
  }
  const meter = fs.readFileSync(
    path.join(ROOT, 'apps/desktop/src/renderer/components/BudgetMeter.tsx'),
    'utf8',
  );
  assert.ok(meter.includes('elapsedMs'), 'BudgetMeter phải nhận prop elapsedMs (v1.07)');
  assert.ok(meter.includes('harness.v107.budget.time'), 'BudgetMeter phải dùng key time');
});

test('v107 ui: 14 key harness.v107 mới có đủ 6 locale, không rỗng', () => {
  for (const locale of LOCALES) {
    const keys = localeKeys(locale);
    for (const key of NEW_I18N_KEYS) {
      assert.ok(
        typeof keys[key] === 'string' && keys[key].trim() !== '',
        `${locale} thiếu key ${key}`,
      );
    }
  }
  const counts = LOCALES.map((l) => Object.keys(localeKeys(l)).length);
  assert.ok(counts.every((c) => c === counts[0]), `6 locale phải cùng số key (nhận ${counts.join(',')})`);
});
