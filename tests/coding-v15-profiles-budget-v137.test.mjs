/**
 * Tests cho coding agent v15 — profiles + budget meter (v1.37, Đội T4).
 *
 * Chạy thật: store thật (memory + file JSON tạm), budget meter thật
 * (cost ước lượng qua bảng giá thật của core), không gọi model/mạng.
 *   npm run build --workspace=@open-bot/core (scoped, trong worktree)
 *   node --test tests/coding-v15-profiles-budget-v137.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CodingV15BudgetMeter,
  CodingV15ProfileStore,
  renderV15BudgetReport,
  renderV15BudgetSummary,
  renderV15ProfileSummary,
  v15AcpDisplayName,
  v15BuiltinProfiles,
  v15EffectiveTools,
  v15ProfileAllowsTool,
} from '../packages/core/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v15-profiles-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Không chặn test.
  }
}

test('profiles: 5 built-in, kind + tool set + model đúng, nhãn ACP', () => {
  const builtins = v15BuiltinProfiles('2026-11-18T00:00:00.000Z');
  assert.equal(builtins.length, 5);
  const ids = builtins.map((p) => p.id).sort();
  assert.deepEqual(ids, ['v15-explorer', 'v15-fixer', 'v15-general', 'v15-planner', 'v15-reviewer']);
  for (const p of builtins) {
    assert.equal(p.builtin, true);
    assert.ok(p.persona.length > 0);
    assert.ok(p.maxSteps >= 1);
  }
  const reviewer = builtins.find((p) => p.id === 'v15-reviewer');
  assert.equal(reviewer.kind, 'reviewer');
  assert.ok(reviewer.allowedTools.includes('read_file'));
  assert.ok(!v15ProfileAllowsTool(reviewer, 'edit_file'));
  assert.ok(v15ProfileAllowsTool(reviewer, 'read_file'));
  // Deny thắng allow: fixer deny delete_file.
  const fixer = builtins.find((p) => p.id === 'v15-fixer');
  assert.ok(!v15EffectiveTools(fixer).includes('delete_file'));
  // Nhãn ACP: general + reviewer + fixer expose, planner + explorer không.
  assert.equal(v15AcpDisplayName(builtins.find((p) => p.id === 'v15-general')), 'General [ACP]');
  assert.equal(v15AcpDisplayName(builtins.find((p) => p.id === 'v15-planner')), 'Planner');
  const store = new CodingV15ProfileStore();
  assert.equal(store.listAcpProfiles().length, 3);
  assert.ok(store.listAcpProfiles().every((x) => x.acpDisplayName.endsWith('[ACP]')));
});

test('profiles: CRUD đầy đủ + validate + built-in chỉ đọc + persistence file', () => {
  const dir = tmpDir();
  try {
    const store = new CodingV15ProfileStore({ dataDir: dir });
    assert.equal(store.size, 5);
    // Create.
    const created = store.create({
      name: 'My Fixer',
      kind: 'fixer',
      persona: 'Fix bugs fast.',
      model: 'gpt-5',
      allowedTools: ['edit_file', 'run_tests', 'edit_file'],
      deniedTools: ['delete_file'],
      exposeViaAcp: true,
    });
    assert.equal(created.id, 'my-fixer');
    assert.deepEqual(created.allowedTools, ['edit_file', 'run_tests']); // dedupe
    assert.equal(created.version, 1);
    assert.equal(store.size, 6);
    // Duplicate id.
    assert.throws(() => store.create({ name: 'My Fixer', persona: 'x' }), /đã tồn tại/);
    // Invalid: tên rỗng, id xấu, maxSteps sai, temperature sai.
    assert.throws(() => store.create({ name: '', persona: 'x' }), /không được rỗng/);
    assert.throws(() => store.create({ id: 'Bad ID!', name: 'B', persona: 'x' }), /không hợp lệ/);
    assert.throws(() => store.create({ name: 'B', persona: 'x', maxSteps: 0 }), /maxSteps/);
    assert.throws(() => store.create({ name: 'B', persona: 'x', temperature: 5 }), /temperature/);
    // Update + version tăng.
    const updated = store.update('my-fixer', { model: 'claude-opus-4-6', maxSteps: 30 });
    assert.equal(updated.model, 'claude-opus-4-6');
    assert.equal(updated.maxSteps, 30);
    assert.equal(updated.version, 2);
    // Built-in chỉ đọc.
    assert.throws(() => store.update('v15-general', { name: 'X' }), /chỉ đọc/);
    assert.throws(() => store.delete('v15-general'), /không được xóa/);
    // Clone built-in rồi sửa bản clone.
    const clone = store.clone('v15-reviewer', 'my-reviewer', 'My Reviewer');
    assert.equal(clone.builtin, false);
    assert.equal(clone.kind, 'reviewer');
    store.update('my-reviewer', { exposeViaAcp: false });
    assert.equal(store.get('my-reviewer').exposeViaAcp, false);
    // Apply: system prompt chứa persona + tool note + model.
    const applied = store.apply('my-fixer', 'fallback-model');
    assert.ok(applied.systemPrompt.includes('Fix bugs fast.'));
    assert.ok(applied.systemPrompt.includes('edit_file'));
    assert.equal(applied.model, 'claude-opus-4-6');
    assert.equal(applied.acpDisplayName, 'My Fixer [ACP]');
    assert.deepEqual(applied.effectiveTools, ['edit_file', 'run_tests']);
    // Fallback model khi profile không đặt model.
    const applied2 = store.apply('v15-general', 'fallback-model');
    assert.equal(applied2.model, 'fallback-model');
    // Persistence: store mới đọc lại file, custom còn, built-in đủ.
    const store2 = new CodingV15ProfileStore({ dataDir: dir });
    assert.equal(store2.size, 7);
    assert.equal(store2.get('my-fixer').model, 'claude-opus-4-6');
    assert.ok(fs.existsSync(path.join(dir, 'profiles.json')));
    // Delete.
    assert.equal(store.delete('my-fixer'), true);
    assert.throws(() => store.get('my-fixer'), /Không tìm thấy/);
    assert.equal(store.size, 6);
    assert.ok(renderV15ProfileSummary(store.get('v15-general')).includes('General [ACP]'));
  } finally {
    cleanup(dir);
  }
});

test('budget: meter chỉ-báo-cáo — vượt cap VẪN CHẠY, cảnh báo 80%/100% đúng một lần', () => {
  const meter = new CodingV15BudgetMeter('bot-1', { maxTokens: 1000, maxCostUsd: 1 });
  // Record 1: 400 token — chưa chạm ngưỡng.
  let r = meter.record({ runId: 'run-1', model: 'gpt-5', inputTokens: 300, outputTokens: 100 });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.newWarnings, []);
  assert.equal(r.state.totalTokens, 400);
  assert.equal(r.state.tokensPercent, 40);
  assert.equal(r.state.overCap, false);
  // Record 2: +400 = 800 token (80%) — phát đúng 1 cảnh báo warn80 tokens.
  r = meter.record({ runId: 'run-1', model: 'gpt-5', inputTokens: 300, outputTokens: 100 });
  assert.equal(r.allowed, true);
  assert.equal(r.newWarnings.length, 1);
  assert.equal(r.newWarnings[0].level, 'warn80');
  assert.equal(r.newWarnings[0].dimension, 'tokens');
  assert.equal(r.state.tokensPercent, 80);
  // Record 3: +100 = 900 — không phát lại warn80.
  r = meter.record({ runId: 'run-1', model: 'gpt-5', inputTokens: 100, outputTokens: 0 });
  assert.deepEqual(r.newWarnings, []);
  // Record 4: +200 = 1100 (110%) — phát over100, overCap=true, VẪN allowed.
  r = meter.record({ runId: 'run-1', model: 'gpt-5', inputTokens: 200, outputTokens: 0 });
  assert.equal(r.allowed, true);
  assert.equal(r.state.overCap, true);
  assert.equal(r.crossedCap, true);
  assert.ok(r.newWarnings.some((w) => w.level === 'over100' && w.dimension === 'tokens'));
  // Record 5: vượt thêm nữa — vẫn chạy, không phát lại over100.
  r = meter.record({ runId: 'run-1', model: 'gpt-5', inputTokens: 500, outputTokens: 0 });
  assert.equal(r.allowed, true);
  assert.equal(r.state.totalTokens, 1600);
  assert.deepEqual(r.newWarnings, []);
  assert.equal(r.state.warnings.length, 2); // warn80 + over100
  // Report chứa ghi chú report-only.
  const report = meter.report('run-1');
  assert.ok(report.reportOnlyNote.includes('never stops a run'));
  assert.ok(report.summary.includes('OVER CAP'));
  assert.ok(renderV15BudgetSummary(report.state).includes('1,600 tokens'));
  assert.ok(renderV15BudgetReport(report).includes('Warnings:'));
  // History + totals theo run/bot.
  meter.record({ runId: 'run-2', model: 'gpt-5', inputTokens: 10, outputTokens: 0 });
  const history = meter.history();
  assert.equal(history.length, 2);
  assert.equal(history.find((h) => h.runId === 'run-1').overCap, true);
  assert.equal(history.find((h) => h.runId === 'run-2').overCap, false);
  assert.equal(meter.historyForBot('bot-1').length, 2);
  assert.equal(meter.historyForBot('other-bot').length, 0);
  const totals = meter.totals();
  assert.equal(totals.runs, 2);
  assert.equal(totals.totalTokens, 1610);
  assert.equal(totals.overCapRuns, 1);
  // Cost: model không có giá → null (không báo $0); model local cost 0 rõ ràng → 0.
  const meter2 = new CodingV15BudgetMeter('bot-2', {});
  const r2 = meter2.record({ runId: 'run-x', model: 'unknown-model-zzz', inputTokens: 100, outputTokens: 50 });
  assert.equal(r2.state.costUsd, null);
  const r3 = meter2.record({ runId: 'run-x', model: 'unknown-model-zzz', inputTokens: 10, outputTokens: 0, costUsd: 0 });
  assert.equal(r3.state.costUsd, 0);
  // Validate: cap vô lý + record vô lý throw.
  assert.throws(() => new CodingV15BudgetMeter('b', { maxTokens: 0 }), /maxTokens/);
  assert.throws(() => new CodingV15BudgetMeter('b', { maxCostUsd: -1 }), /maxCostUsd/);
  assert.throws(() => meter.record({ runId: '', model: 'gpt-5', inputTokens: 1, outputTokens: 0 }), /runId/);
  assert.throws(() => meter.record({ runId: 'r', model: 'gpt-5', inputTokens: -1, outputTokens: 0 }), /inputTokens/);
  assert.throws(() => meter.report('no-such-run'), /Không có dữ liệu/);
});
