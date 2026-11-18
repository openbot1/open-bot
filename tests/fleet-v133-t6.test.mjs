/**
 * Platform/fleet v20 tests (v1.33, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Specialized subagents v20: 3 specs (explore read-only/cheap,
 *   plan read-only, verify shell/no-edit), resolve spawn giao tool
 *   với cha, spawn plan waves (topological), output validators
 *   (explore/plan/verify) + buildVerifyV20Verdict tính từ check.
 * - Subagent context v20: tạo context (system prompt loại + task +
 *   shared facts có nguồn), append vượt budget (drop message cũ,
 *   không drop system), seal/TTL, isolation check, pool cấp phát
 *   có giới hạn + từ chối khi đầy, handoff validate.
 * - Plugin manager v20: install/enable/disable/uninstall state
 *   machine, enable chặn khi quyền nguy hiểm chưa duyệt, dependency
 *   (missing/version/disabled), host compat, search, summary.
 * - Hook manager v20: match pattern (exact / prefix-star / wildcard) +
 *   thứ tự priority, register/enable/disable, record run → tự lỗi
 *   sau N lỗi liên tiếp + reset, block decision, prune log giữ
 *   log blocked, query log.
 * - Eval harness v20: record result, stats (% resolved chỉ trên
 *   task đã chạy xong), breakdown theo category, report, so
 *   baseline (hồi quy khi resolved giảm / cost tăng).
 * - Delegation v20: spawn qua SubagentTree (luật chặn của cây + leaf-only),
 *   wave run state machine (pending/running/done/invalid-output/failed/
 *   blocked), retry output lỗi tối đa 2 rồi escalate, merge findings/
 *   plan, rollup verify, tóm tắt sóng cho cha.
 * - Panels v20: plugin/hook/eval/subagent view-model.
 * - Tools v20: 25 defs, unique names, write tools = 11, groups
 *   6/7/8/4.
 * - i18n: all 6 locales have 6948 keys, identical key sets, no empty
 *   values; fleetV20.* = 25, pluginV20.* = 17, hookV20.* = 15,
 *   evalV20.* = 28 per locale; spot-checks differ per locale.
 *
 * Imports the BUILT core — build first:
 *   ./node_modules/.bin/tsc -p packages/core/tsconfig.json
 * then: node --test tests/fleet-v133-t6.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SPECIALIZED_V20_KINDS,
  SPECIALIZED_V20_SPECS,
  buildVerifyV20Verdict,
  createSpecializedV20Registry,
  getSpecializedV20Spec,
  isSpecializedV20ToolAllowed,
  planSpecializedV20Spawns,
  resolveSpecializedV20Spawn,
  specializedV20Roles,
  validateExploreV20Output,
  validatePlanV20Output,
  validateSpecializedV20SpawnPlan,
  validateVerifyV20Verdict,
} from '../packages/core/dist/fleetV20/specializedSubagentsV20.js';
import {
  allocateSubagentV20Context,
  appendSubagentV20Message,
  buildChildPrompt,
  buildSubagentV20Handoff,
  checkSubagentV20ContextIsolation,
  createSubagentV20Context,
  createSubagentV20ContextPool,
  releaseSubagentV20Context,
  subagentV20ContextExpired,
  validateSubagentV20Handoff,
} from '../packages/core/dist/fleetV20/subagentContextV20.js';
import {
  approvePluginV20Permission,
  checkPluginV20Dependencies,
  checkPluginV20HostCompat,
  createPluginV20Store,
  disablePluginV20,
  enablePluginV20,
  installPluginV20,
  pluginV20Risk,
  pluginV20VersionSatisfies,
  searchPluginV20,
  summarizePluginV20Store,
  uninstallPluginV20,
  validatePluginV20Entry,
} from '../packages/core/dist/fleetV20/pluginManagerV20.js';
import {
  createHookV20Store,
  decideHookV20Block,
  disableHookV20,
  enableHookV20,
  hookV20EventMatches,
  matchBlockingHooksV20,
  matchHooksV20,
  pruneHookV20Logs,
  queryHookV20Logs,
  recordHookV20Run,
  registerHookV20,
  resetHookV20Error,
  summarizeHookV20Store,
} from '../packages/core/dist/fleetV20/hookManagerV20.js';
import {
  buildEvalV20Report,
  compareEvalV20ToBaseline,
  computeEvalV20Breakdown,
  computeEvalV20Stats,
  createEvalV20Run,
  isEvalV20RunComplete,
  pendingEvalV20Tasks,
  recordEvalV20TaskResult,
  retryableEvalV20Tasks,
  validateEvalV20Run,
  validateEvalV20TaskResult,
} from '../packages/core/dist/fleetV20/evalHarnessV20.js';
import {
  buildEvalV20Panel,
  buildFleetV20Dashboard,
  buildHookV20Panel,
  buildPluginV20Panel,
  buildSubagentV20Panel,
} from '../packages/core/dist/fleetV20/panelsV20.js';
import {
  attachSpecializedV20Handoff,
  blockSpecializedV20Requests,
  createSpecializedV20WaveRun,
  escalatedSpecializedV20Requests,
  failSpecializedV20Request,
  isSpecializedV20WaveRunComplete,
  mergeExploreV20Findings,
  mergePlanV20Outputs,
  nextSpecializedV20Wave,
  requestSpecializedV20Spawn,
  retrySpecializedV20Request,
  rollupVerifyV20Verdicts,
  startSpecializedV20Request,
  summarizeSpecializedV20WaveRun,
} from '../packages/core/dist/fleetV20/subagentDelegationV20.js';
import { SubagentTree } from '../packages/core/dist/subagents/nested.js';
import {
  FLEET_V20_TOOLS,
  findFleetV20Tool,
  fleetV20ToolNamesUnique,
  fleetV20ToolsByGroup,
  fleetV20WriteTools,
} from '../packages/core/dist/fleetV20/toolsV20.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers: fixtures
// ---------------------------------------------------------------------------

function pluginStoreFixture() {
  return createPluginV20Store('1.33.0', [
    {
      id: 'core-utils', name: 'Core Utils', description: 'Tiện ích lõi.',
      version: '2.0.0', minHostVersion: '1.30.0', author: 'open-bot',
      capabilities: ['tools'], permissions: [], dependencies: {}, status: 'enabled',
    },
    {
      id: 'weather-tools', name: 'Weather Tools', description: 'Tool thời tiết.',
      version: '1.2.0', minHostVersion: '1.30.0', author: 'open-bot',
      capabilities: ['tools'],
      permissions: [
        { name: 'network.fetch', description: 'Gọi API thời tiết.', dangerous: false, approved: true },
        { name: 'shell.exec', description: 'Chạy shell.', dangerous: true, approved: false },
      ],
      dependencies: {}, status: 'available',
    },
    {
      id: 'report-pack', name: 'Report Pack', description: 'Xuất báo cáo.',
      version: '2.0.0', minHostVersion: '1.30.0', author: 'open-bot',
      capabilities: ['commands'], permissions: [],
      dependencies: { 'core-utils': '^2.0.0' }, status: 'available',
    },
    {
      id: 'old-host-plugin', name: 'Old Host Plugin', description: 'Cần host mới.',
      version: '1.0.0', minHostVersion: '9.9.9', author: 'open-bot',
      capabilities: ['tools'], permissions: [], dependencies: {}, status: 'available',
    },
  ]);
}

function hookStoreFixture() {
  const store = createHookV20Store([
    {
      id: 'guard-no-shell', name: 'Guard No Shell', description: 'Chặn shell ngoài allowlist.',
      eventPattern: 'tool.before', blocking: true, priority: 10, timeoutMs: 5000,
      enabled: true, consecutiveErrors: 0, maxConsecutiveErrors: 3, errored: false,
      runCount: 0, blockCount: 0, createdAt: 1000,
    },
    {
      id: 'log-file-write', name: 'Log File Write', description: 'Ghi log khi ghi file.',
      eventPattern: 'file.*', blocking: false, priority: 50, timeoutMs: 5000,
      enabled: true, consecutiveErrors: 0, maxConsecutiveErrors: 3, errored: false,
      runCount: 0, blockCount: 0, createdAt: 1000,
    },
    {
      id: 'catch-all', name: 'Catch All', description: 'Quan sát mọi event.',
      eventPattern: '*', blocking: false, priority: 90, timeoutMs: 5000,
      enabled: true, consecutiveErrors: 0, maxConsecutiveErrors: 3, errored: false,
      runCount: 0, blockCount: 0, createdAt: 1000,
    },
  ]);
  return store;
}

function evalRunFixture() {
  return createEvalV20Run('eval-001', 'fleet-v20-smoke', 'gemini-2.5-flash', [
    { id: 'swe-task-001', description: 'Thêm test cho plugin manager.', category: 'coding', difficulty: 1, verifyCommand: 'node --test tests/fleet-v133-t6.test.mjs' },
    { id: 'swe-task-002', description: 'Sửa lỗi null check.', category: 'coding', difficulty: 2, verifyCommand: 'node --test tests/fleet-v133-t6.test.mjs' },
    { id: 'swe-task-003', description: 'Gọi đúng tool theo plan.', category: 'tool-use', difficulty: 3, verifyCommand: 'node --test tests/fleet-v133-t6.test.mjs' },
    { id: 'swe-task-004', description: 'Nhớ context dài.', category: 'memory', difficulty: 4, verifyCommand: 'node --test tests/fleet-v133-t6.test.mjs' },
  ], 1000);
}

function recordEvalFixtureResults(run) {
  let r = recordEvalV20TaskResult(run, {
    taskId: 'swe-task-001', verdict: 'resolved', testsPassed: 2, testsTotal: 2,
    cost: 0.01, durationMs: 1000, outputExcerpt: '2 passed', at: 1100,
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  r = recordEvalV20TaskResult(r.run, {
    taskId: 'swe-task-002', verdict: 'failed', testsPassed: 1, testsTotal: 3,
    cost: 0.006, durationMs: 800, outputExcerpt: '1 failed', error: 'Assertion failed', at: 1200,
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  r = recordEvalV20TaskResult(r.run, {
    taskId: 'swe-task-003', verdict: 'resolved', testsPassed: 1, testsTotal: 1,
    cost: 0.02, durationMs: 1800, outputExcerpt: '1 passed', at: 1300,
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.run;
}

// ---------------------------------------------------------------------------
// 1. Specialized subagents v20
// ---------------------------------------------------------------------------

test('specialized v20: 3 kinds, explore read-only + cheap, verify shell + no-edit-by-contract', () => {
  assert.deepEqual([...SPECIALIZED_V20_KINDS], ['explore', 'plan', 'verify']);
  const explore = getSpecializedV20Spec('explore');
  assert.equal(explore.readOnly, true);
  assert.equal(explore.allowShell, false);
  assert.equal(explore.modelTier, 'cheap');
  assert.equal(explore.leafOnly, true);
  assert.equal(isSpecializedV20ToolAllowed('explore', 'shell_exec'), false);
  assert.equal(isSpecializedV20ToolAllowed('explore', 'read_file'), true);
  assert.equal(isSpecializedV20ToolAllowed('explore', 'web_search'), true);
  const plan = getSpecializedV20Spec('plan');
  assert.equal(plan.readOnly, true);
  assert.equal(isSpecializedV20ToolAllowed('plan', 'web_search'), false);
  assert.equal(isSpecializedV20ToolAllowed('plan', 'plan_create'), true);
  const verify = getSpecializedV20Spec('verify');
  assert.equal(verify.allowShell, true);
  assert.equal(verify.readOnly, false);
  assert.equal(isSpecializedV20ToolAllowed('verify', 'shell_exec'), true);
  assert.equal(isSpecializedV20ToolAllowed('verify', 'web_search'), false);
  assert.throws(() => getSpecializedV20Spec('coder'), /không tồn tại/);
  assert.equal(specializedV20Roles().length, 3);
  const registry = createSpecializedV20Registry();
  assert.equal(registry.has('explore'), true);
  assert.equal(registry.has('planner'), true); // built-in planner vẫn còn, không bị shadow
});

test('specialized v20: resolve spawn giao tool với cha + tier + schema', () => {
  const parent = [...SPECIALIZED_V20_SPECS.explore.tools, 'shell_exec'];
  const resolved = resolveSpecializedV20Spawn('explore', parent);
  assert.equal(resolved.kind, 'explore');
  assert.equal(resolved.modelTier, 'cheap');
  assert.equal(resolved.leafOnly, true);
  assert.ok(resolved.outputSchema.includes('findings'));
  assert.equal(resolved.tools?.includes('shell_exec'), false);
  assert.equal(resolved.tools?.includes('read_file'), true);
  // Override tier: verify xin strong.
  const verifyParent = [...SPECIALIZED_V20_SPECS.verify.tools];
  const v = resolveSpecializedV20Spawn('verify', verifyParent, { modelTier: 'strong' });
  assert.equal(v.modelTier, 'strong');
  assert.equal(v.tools?.includes('shell_exec'), true);
  // Cha không cấp tool nào của role → lỗi rõ, không spawn tay trắng.
  assert.throws(() => resolveSpecializedV20Spawn('explore', ['shell_exec']), /EmptyRoleTools|không/i);
});

test('specialized v20: spawn plan waves theo dependency + validate', () => {
  const requests = [
    { id: 'exp-a', kind: 'explore', task: 'Tìm hiểu plugin manager.' },
    { id: 'plan-b', kind: 'plan', task: 'Lập plan sửa plugin manager.', dependsOn: ['exp-a'] },
    { id: 'ver-c', kind: 'verify', task: 'Kiểm chứng sửa plugin manager.', dependsOn: ['plan-b'] },
  ];
  assert.deepEqual(validateSpecializedV20SpawnPlan(requests), []);
  const plan = planSpecializedV20Spawns(requests, 2);
  assert.equal(plan.totalRequests, 3);
  assert.equal(plan.waves.length, 3);
  assert.deepEqual(plan.waves[0].requestIds, ['exp-a']);
  assert.deepEqual(plan.waves[1].requestIds, ['plan-b']);
  assert.deepEqual(plan.waves[2].requestIds, ['ver-c']);
  // Lỗi: trùng id, dep không tồn tại, chu trình, vượt 12.
  assert.ok(validateSpecializedV20SpawnPlan([
    { id: 'a', kind: 'explore', task: 'x' },
    { id: 'a', kind: 'plan', task: 'y' },
  ]).some((e) => e.includes('trùng')));
  assert.ok(validateSpecializedV20SpawnPlan([
    { id: 'a', kind: 'explore', task: 'x', dependsOn: ['ghost'] },
  ]).some((e) => e.includes('không có trong kế hoạch')));
  assert.ok(validateSpecializedV20SpawnPlan([
    { id: 'a', kind: 'explore', task: 'x', dependsOn: ['b'] },
    { id: 'b', kind: 'plan', task: 'y', dependsOn: ['a'] },
  ]).some((e) => e.includes('chu trình')));
  assert.ok(validateSpecializedV20SpawnPlan(
    Array.from({ length: 13 }, (_, i) => ({ id: `r-${i}`, kind: 'explore', task: 'x' })),
  ).some((e) => e.includes('vượt tối đa')));
  assert.throws(() => planSpecializedV20Spawns([]), /trống/);
});

test('specialized v20: output validators explore/plan/verify', () => {
  assert.deepEqual(validateExploreV20Output({
    findings: [{ claim: 'Repo dùng pnpm.', sources: ['package.json:1'], confidence: 'high' }],
    notFound: [],
  }), []);
  assert.ok(validateExploreV20Output({ findings: [{ claim: 'x', sources: [], confidence: 'high' }], notFound: [] })
    .some((e) => e.includes('source')));
  assert.ok(validateExploreV20Output({ findings: [{ claim: 'x', sources: ['a'], confidence: 'sure' }], notFound: [] })
    .some((e) => e.includes('confidence')));
  assert.deepEqual(validatePlanV20Output({
    goal: 'Sửa plugin manager.',
    steps: [{ title: 'Thêm test', files: ['tests/x.test.mjs'], verifyCommand: 'node --test tests/x.test.mjs', doneCriteria: 'test xanh' }],
    openQuestions: [], risks: [],
  }), []);
  assert.ok(validatePlanV20Output({ goal: 'g', steps: [], openQuestions: [], risks: [] })
    .some((e) => e.includes('ít nhất 1 step')));
  assert.ok(validatePlanV20Output({
    goal: 'g',
    steps: [{ title: 't', files: [], verifyCommand: '', doneCriteria: '' }],
    openQuestions: [], risks: [],
  }).length >= 2);
  assert.deepEqual(validateVerifyV20Verdict({
    verdict: 'pass',
    checks: [{ check: 'unit', command: 'node --test x', passed: true, outputExcerpt: 'ok', durationMs: 10 }],
    summary: 'Pass.',
  }), []);
  // Mâu thuẫn verdict pass nhưng có check fail.
  assert.ok(validateVerifyV20Verdict({
    verdict: 'pass',
    checks: [{ check: 'unit', command: 'node --test x', passed: false, outputExcerpt: 'fail', durationMs: 10 }],
    summary: 'Pass?',
  }).some((e) => e.includes('mâu thuẫn')));
  // Check không có lệnh/bằng chứng.
  assert.ok(validateVerifyV20Verdict({
    verdict: 'fail',
    checks: [{ check: 'unit', command: '', passed: false, outputExcerpt: '', durationMs: -1 }],
    summary: 'Fail.',
  }).length >= 2);
});

test('specialized v20: buildVerifyV20Verdict tính từ check, không tin lời model', () => {
  const pass = buildVerifyV20Verdict(
    [{ check: 'unit', command: 'node --test x', passed: true, outputExcerpt: 'ok', durationMs: 10 }],
    'Mọi check pass.',
  );
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.passed, true);
  assert.deepEqual(pass.failedChecks, []);
  const fail = buildVerifyV20Verdict(
    [
      { check: 'unit', command: 'node --test x', passed: true, outputExcerpt: 'ok', durationMs: 10 },
      { check: 'typecheck', command: 'tsc', passed: false, outputExcerpt: 'error TS1', durationMs: 20 },
    ],
    'Typecheck fail.',
  );
  assert.equal(fail.verdict, 'fail');
  assert.equal(fail.passed, false);
  assert.deepEqual(fail.failedChecks, ['typecheck']);
  const empty = buildVerifyV20Verdict([], 'Không chạy được check nào.');
  assert.equal(empty.verdict, 'inconclusive');
  assert.equal(empty.passed, false);
});

// ---------------------------------------------------------------------------
// 2. Subagent context v20
// ---------------------------------------------------------------------------

test('context v20: tạo context — system prompt loại + task + shared facts có nguồn', () => {
  const ctx = createSubagentV20Context('explore', 'task-1', 'Tìm hiểu plugin manager.', {
    id: 'explore-test-1',
    sharedFacts: [{ fact: 'Repo dùng pnpm.', source: 'package.json:1' }],
    now: 1000,
  });
  assert.equal(ctx.id, 'explore-test-1');
  assert.equal(ctx.kind, 'explore');
  assert.equal(ctx.modelTier, 'cheap');
  assert.equal(ctx.messages[0]?.role, 'system');
  assert.ok(ctx.messages[0]?.content.includes('CHỈ ĐỌC'));
  assert.equal(ctx.messages[1]?.content, 'Tìm hiểu plugin manager.');
  assert.equal(ctx.messages.length, 3);
  assert.equal(ctx.sealed, false);
  assert.equal(subagentV20ContextExpired(ctx, 2000), false);
  assert.equal(subagentV20ContextExpired(ctx, 1000 + 120_001), true);
  assert.deepEqual(checkSubagentV20ContextIsolation(ctx, 'Tìm hiểu plugin manager.'), []);
  const prompt = buildChildPrompt(ctx);
  assert.ok(prompt.includes('Tìm hiểu plugin manager.'));
  assert.ok(prompt.includes('Repo dùng pnpm.'));
  assert.ok(prompt.includes('findings'));
  // Shared fact không nguồn → lỗi, không lặng lẽ đưa vào.
  assert.throws(
    () => createSubagentV20Context('explore', 'task-1', 'x', { sharedFacts: [{ fact: 'f', source: '' }] }),
    /source/,
  );
  assert.throws(() => createSubagentV20Context('explore', 'task-1', '  '), /task không rỗng/);
  assert.throws(() => createSubagentV20Context('explore', 'task-1', 'x', { id: 'BAD ID' }), /không hợp lệ/);
});

test('context v20: append vượt budget drop message cũ, không drop system; seal/TTL từ chối', () => {
  const ctx = createSubagentV20Context('explore', 'task-1', 'Task.', {
    id: 'explore-budget-1', now: 1000,
    budgetOverrides: { maxMessages: 4, maxChars: 10000, maxCharsPerMessage: 100 },
  });
  let cur = ctx;
  let r = appendSubagentV20Message(cur, 'assistant', 'Trả lời 1.', 1100);
  cur = r.context;
  assert.equal(r.appended, true);
  r = appendSubagentV20Message(cur, 'user', 'Hỏi tiếp.', 1200);
  cur = r.context;
  assert.equal(r.appended, true);
  assert.equal(cur.messages.length, 4);
  r = appendSubagentV20Message(cur, 'assistant', 'Trả lời 2.', 1300);
  cur = r.context;
  assert.equal(r.appended, true);
  assert.equal(r.droppedThisAppend, 1);
  assert.equal(cur.messages.length, 4);
  assert.equal(cur.messages[0]?.role, 'system');
  assert.equal(cur.droppedMessages, 1);
  // Message dài vượt maxCharsPerMessage → cắt + đánh dấu.
  r = appendSubagentV20Message(cur, 'user', 'x'.repeat(200), 1400);
  assert.equal(r.appended, true);
  assert.equal(r.context.messages.at(-1)?.truncated, true);
  assert.ok(r.context.truncatedChars > 0);
  // TTL hết → từ chối + seal.
  const old = createSubagentV20Context('explore', 'task-1', 'Task.', { id: 'explore-ttl-1', now: 1000 });
  const expired = appendSubagentV20Message(old, 'user', 'Muộn rồi.', 1000 + 120_001);
  assert.equal(expired.appended, false);
  assert.ok(expired.reason?.includes('TTL'));
  assert.equal(expired.context.sealed, true);
});

test('context v20: pool giới hạn song song, từ chối khi đầy, release rồi cấp lại được', () => {
  let pool = createSubagentV20ContextPool(2);
  let a = allocateSubagentV20Context(pool, 'explore', 'task-1', 'Tìm A.', { id: 'pool-a' });
  pool = a.pool;
  assert.ok(a.context);
  let b = allocateSubagentV20Context(pool, 'plan', 'task-1', 'Lập plan B.', { id: 'pool-b' });
  pool = b.pool;
  assert.ok(b.context);
  const full = allocateSubagentV20Context(pool, 'verify', 'task-1', 'Kiểm C.', { id: 'pool-c' });
  assert.equal(full.context, null);
  assert.ok(full.reason?.includes('đầy'));
  assert.equal(full.pool.rejectedFull, 1);
  pool = releaseSubagentV20Context(full.pool, 'pool-a');
  assert.equal(pool.active.length, 1);
  const c = allocateSubagentV20Context(pool, 'verify', 'task-1', 'Kiểm C.', { id: 'pool-c' });
  assert.ok(c.context);
  assert.throws(() => createSubagentV20ContextPool(0), /maxParallel/);
});

test('context v20: handoff chỉ nhận output đã validate, không nhận transcript thô', () => {
  const ctx = createSubagentV20Context('verify', 'task-9', 'Kiểm tra.', { id: 'verify-handoff-1', now: 1000 });
  const output = {
    verdict: 'pass',
    checks: [{ check: 'unit', command: 'node --test x', passed: true, outputExcerpt: 'ok', durationMs: 10 }],
    summary: 'Pass.',
  };
  const handoff = buildSubagentV20Handoff(ctx, output, [], 5000);
  assert.equal(handoff.outputValid, true);
  assert.equal(handoff.contextId, 'verify-handoff-1');
  assert.equal(handoff.usage.durationMs, 5000);
  assert.deepEqual(validateSubagentV20Handoff(handoff), []);
  const bad = buildSubagentV20Handoff(ctx, output, ['verdict mâu thuẫn'], 5000);
  assert.equal(bad.outputValid, false);
  assert.deepEqual(validateSubagentV20Handoff(bad), []);
  assert.ok(validateSubagentV20Handoff({ contextId: '', kind: 'nope', outputValid: 'yes' }).length >= 2);
  assert.ok(validateSubagentV20Handoff({ contextId: 'x', kind: 'explore', parentTaskId: 't', output: null, outputValid: false, validationErrors: [], usage: {} }).some((e) => e.includes('mâu thuẫn')));
});

// ---------------------------------------------------------------------------
// 3. Plugin manager v20
// ---------------------------------------------------------------------------

test('plugin v20: validate entry + version satisfies', () => {
  assert.deepEqual(validatePluginV20Entry({
    id: 'weather-tools', name: 'Weather', description: 'Tool thời tiết.',
    version: '1.2.0', minHostVersion: '1.30.0', capabilities: ['tools'],
    permissions: [], dependencies: {}, status: 'available',
  }), []);
  assert.ok(validatePluginV20Entry({ id: 'BAD', name: '', version: 'x', status: 'nope' }).length >= 3);
  assert.equal(pluginV20VersionSatisfies('2.1.0', '^2.0.0'), true);
  assert.equal(pluginV20VersionSatisfies('3.0.0', '^2.0.0'), false);
  assert.equal(pluginV20VersionSatisfies('1.9.9', '^2.0.0'), false);
  assert.equal(pluginV20VersionSatisfies('2.0.0', '>=1.5.0'), true);
  assert.equal(pluginV20VersionSatisfies('2.0.0', '2.0.0'), true);
  assert.equal(pluginV20VersionSatisfies('2.0.0', 'bogus'), false);
});

test('plugin v20: install → approve → enable; host không tương thích và dependency chặn install', () => {
  let store = pluginStoreFixture();
  // Host quá cũ → không cài.
  const oldHost = installPluginV20(store, 'old-host-plugin');
  assert.equal(oldHost.ok, false);
  assert.ok(oldHost.errors[0]?.includes('cần host'));
  assert.deepEqual(checkPluginV20HostCompat(store.plugins.find((p) => p.id === 'old-host-plugin'), '1.33.0'), oldHost.errors);
  // Install report-pack: dependency core-utils ^2.0.0 đang enabled 2.0.0 → ok.
  const installed = installPluginV20(store, 'report-pack');
  assert.equal(installed.ok, true, JSON.stringify(installed.errors));
  store = installed.store;
  assert.equal(store.plugins.find((p) => p.id === 'report-pack')?.status, 'installed');
  // Install weather-tools rồi enable khi quyền nguy hiểm chưa duyệt → chặn.
  store = installPluginV20(store, 'weather-tools').store;
  const blocked = enablePluginV20(store, 'weather-tools');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors[0]?.includes('shell.exec'));
  assert.equal(pluginV20Risk(store.plugins.find((p) => p.id === 'weather-tools')), 'medium');
  // Duyệt quyền rồi enable → ok.
  const approved = approvePluginV20Permission(store, 'weather-tools', 'shell.exec');
  assert.equal(approved.ok, true);
  store = approved.store;
  const enabled = enablePluginV20(store, 'weather-tools');
  assert.equal(enabled.ok, true, JSON.stringify(enabled.errors));
  store = enabled.store;
  assert.equal(store.plugins.find((p) => p.id === 'weather-tools')?.status, 'enabled');
  // Dependency thiếu: gỡ core-utils khỏi store logic bằng plugin phụ thuộc version sai.
  const depProblems = checkPluginV20Dependencies(
    { ...store.plugins.find((p) => p.id === 'report-pack'), dependencies: { 'core-utils': '^3.0.0' } },
    store,
  );
  assert.equal(depProblems.length, 1);
  assert.equal(depProblems[0]?.kind, 'version');
});

test('plugin v20: disable/uninstall chặn khi plugin khác đang enabled còn phụ thuộc', () => {
  let store = pluginStoreFixture();
  store = installPluginV20(store, 'report-pack').store;
  store = enablePluginV20(store, 'report-pack').store;
  // core-utils đang enabled và report-pack đang enabled phụ thuộc vào nó.
  assert.equal(disablePluginV20(store, 'core-utils').ok, false);
  assert.equal(uninstallPluginV20(store, 'core-utils').ok, false);
  // Gỡ plugin đang enabled → chặn, phải disable trước.
  assert.equal(uninstallPluginV20(store, 'report-pack').ok, false);
  store = disablePluginV20(store, 'report-pack').store;
  assert.equal(store.plugins.find((p) => p.id === 'report-pack')?.status, 'disabled');
  const uninstalled = uninstallPluginV20(store, 'report-pack');
  assert.equal(uninstalled.ok, true);
  assert.equal(uninstalled.store.plugins.find((p) => p.id === 'report-pack')?.status, 'uninstalled');
  // Giờ tắt core-utils được.
  assert.equal(disablePluginV20(uninstalled.store, 'core-utils').ok, true);
  // Search + summary.
  const found = searchPluginV20(store, { query: 'weather' });
  assert.deepEqual(found.map((p) => p.id), ['weather-tools']);
  const summary = summarizePluginV20Store(store);
  assert.equal(summary.total, 4);
  // Lúc này report-pack đã disable (chỉ còn core-utils enabled) — enabled = 1.
  assert.equal(summary.enabled, 1);
  assert.ok(summary.summary.includes('đang bật'));
});

// ---------------------------------------------------------------------------
// 4. Hook manager v20
// ---------------------------------------------------------------------------

test('hook v20: match pattern exact/prefix/wildcard + thứ tự priority', () => {
  assert.equal(hookV20EventMatches('tool.before', 'tool.before'), true);
  assert.equal(hookV20EventMatches('tool.before', 'tool.after'), false);
  assert.equal(hookV20EventMatches('file.*', 'file.write'), true);
  assert.equal(hookV20EventMatches('file.*', 'tool.before'), false);
  assert.equal(hookV20EventMatches('*', 'anything.at.all'), true);
  assert.equal(hookV20EventMatches('', 'tool.before'), false);
  const store = hookStoreFixture();
  assert.deepEqual(matchHooksV20(store, 'tool.before').map((h) => h.id), ['guard-no-shell', 'catch-all']);
  assert.deepEqual(matchHooksV20(store, 'file.write').map((h) => h.id), ['log-file-write', 'catch-all']);
  assert.deepEqual(matchBlockingHooksV20(store, 'tool.before').map((h) => h.id), ['guard-no-shell']);
  // Tắt guard → match không còn guard.
  const disabled = disableHookV20(store, 'guard-no-shell').store;
  assert.deepEqual(matchHooksV20(disabled, 'tool.before').map((h) => h.id), ['catch-all']);
  // Đăng ký trùng id → lỗi; đăng ký entry sai → lỗi.
  assert.equal(registerHookV20(store, store.hooks[0]).ok, false);
  assert.equal(registerHookV20(store, { ...store.hooks[0], id: 'new-hook', eventPattern: '' }).ok, false);
  const registered = registerHookV20(store, {
    id: 'new-hook', name: 'New', description: 'Hook mới.', eventPattern: 'eval.run',
    blocking: false, priority: 5, timeoutMs: 1000, enabled: true,
    consecutiveErrors: 0, maxConsecutiveErrors: 3, errored: false, runCount: 0, blockCount: 0, createdAt: 1000,
  });
  assert.equal(registered.ok, true);
  assert.deepEqual(matchHooksV20(registered.store, 'eval.run').map((h) => h.id), ['new-hook', 'catch-all']);
});

test('hook v20: record run → lỗi liên tiếp tự tắt hook, reset lỗi bật lại; block decision', () => {
  let store = hookStoreFixture();
  store = recordHookV20Run(store, { hookId: 'guard-no-shell', event: 'tool.before', outcome: 'blocked', reason: 'Lệnh cấm.', durationMs: 3, at: 2000 });
  assert.equal(store.hooks.find((h) => h.id === 'guard-no-shell')?.blockCount, 1);
  // 3 lỗi liên tiếp → errored + tự tắt.
  for (let i = 0; i < 3; i++) {
    store = recordHookV20Run(store, { hookId: 'log-file-write', event: 'file.write', outcome: 'error', reason: 'Script crash.', durationMs: 5, at: 3000 + i });
  }
  const broken = store.hooks.find((h) => h.id === 'log-file-write');
  assert.equal(broken?.errored, true);
  assert.equal(broken?.enabled, false);
  assert.equal(matchHooksV20(store, 'file.write').some((h) => h.id === 'log-file-write'), false);
  // Bật hook đang lỗi → chặn; reset lỗi rồi bật được.
  assert.equal(enableHookV20(store, 'log-file-write').ok, false);
  store = resetHookV20Error(store, 'log-file-write').store;
  assert.equal(store.hooks.find((h) => h.id === 'log-file-write')?.errored, false);
  assert.equal(store.hooks.find((h) => h.id === 'log-file-write')?.enabled, true);
  // Block decision: một hook chặn là đủ chặn.
  const decision = decideHookV20Block([
    { hookId: 'guard-no-shell', outcome: 'blocked', reason: 'Lệnh cấm.' },
    { hookId: 'catch-all', outcome: 'allowed' },
  ]);
  assert.equal(decision.blocked, true);
  assert.deepEqual(decision.blockingHooks, ['guard-no-shell']);
  assert.equal(decideHookV20Block([{ hookId: 'catch-all', outcome: 'allowed' }]).blocked, false);
  // Log query + summary.
  const blocks = queryHookV20Logs(store, { blockedOnly: true });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.hookId, 'guard-no-shell');
  const summary = summarizeHookV20Store(store);
  assert.equal(summary.total, 3);
  assert.equal(summary.totalBlocks, 1);
  assert.ok(summary.summary.includes('đang bật'));
});

test('hook v20: prune log giữ log blocked, drop log allowed cũ nhất trước', () => {
  const logs = [
    { id: 'a-1', hookId: 'h1', event: 'tool.before', outcome: 'allowed', durationMs: 1, at: 1000 },
    { id: 'a-2', hookId: 'h1', event: 'tool.before', outcome: 'allowed', durationMs: 1, at: 2000 },
    { id: 'a-3', hookId: 'h1', event: 'tool.before', outcome: 'allowed', durationMs: 1, at: 3000 },
    { id: 'a-4', hookId: 'h1', event: 'tool.before', outcome: 'allowed', durationMs: 1, at: 4000 },
    { id: 'b-1', hookId: 'h2', event: 'tool.before', outcome: 'blocked', reason: 'Cấm.', durationMs: 1, at: 1500 },
    { id: 'b-2', hookId: 'h2', event: 'tool.before', outcome: 'blocked', reason: 'Cấm.', durationMs: 1, at: 2500 },
  ];
  const pruned = pruneHookV20Logs(logs, 5);
  assert.equal(pruned.length, 5);
  assert.equal(pruned.filter((l) => l.outcome === 'blocked').length, 2);
  assert.equal(pruned.some((l) => l.id === 'a-1'), false); // allowed cũ nhất bị drop
  assert.equal(pruned.some((l) => l.id === 'b-1'), true); // blocked cũ vẫn giữ
});

// ---------------------------------------------------------------------------
// 5. Eval harness v20
// ---------------------------------------------------------------------------

test('eval v20: record result + stats % resolved chỉ trên task đã chạy xong', () => {
  let run = evalRunFixture();
  assert.deepEqual(validateEvalV20Run(run), []);
  assert.equal(isEvalV20RunComplete(run), false);
  assert.deepEqual(pendingEvalV20Tasks(run).map((t) => t.id), ['swe-task-001', 'swe-task-002', 'swe-task-003', 'swe-task-004']);
  run = recordEvalFixtureResults(run);
  const stats = computeEvalV20Stats(run);
  assert.equal(stats.total, 4);
  assert.equal(stats.completed, 3);
  assert.equal(stats.pending, 1);
  assert.equal(stats.resolved, 2);
  assert.equal(stats.failed, 1);
  assert.ok(Math.abs((stats.resolvedPct ?? 0) - (2 / 3) * 100) < 0.001);
  assert.ok(Math.abs((stats.avgCostPerTask ?? 0) - 0.012) < 0.0001);
  assert.equal(stats.medianCostPerTask, 0.01);
  assert.equal(stats.maxCostPerTask, 0.02);
  assert.equal(stats.mostExpensiveTaskId, 'swe-task-003');
  assert.equal(stats.slowestTaskId, 'swe-task-003');
  // Breakdown theo category.
  const breakdown = computeEvalV20Breakdown(run);
  assert.equal(breakdown.byCategory.coding?.resolvedPct, 50);
  assert.equal(breakdown.byCategory['tool-use']?.resolvedPct, 100);
  assert.equal(breakdown.byCategory.memory?.resolvedPct, null); // chưa chạy task nào
  // Task lạ → không ghi; resolved nhưng test chưa pass hết → lỗi.
  assert.equal(recordEvalV20TaskResult(run, {
    taskId: 'ghost', verdict: 'resolved', cost: 0, durationMs: 0, at: 1,
  }).ok, false);
  assert.ok(validateEvalV20TaskResult({
    taskId: 'swe-task-001', verdict: 'resolved', testsPassed: 1, testsTotal: 2, cost: 0, durationMs: 0,
  }).some((e) => e.includes('mâu thuẫn')));
  // Report + retryable.
  const report = buildEvalV20Report(run);
  assert.equal(report.complete, false);
  assert.deepEqual(report.retryableTaskIds, ['swe-task-002']);
  assert.deepEqual(report.pendingTaskIds, ['swe-task-004']);
  assert.ok(report.summary.includes('2/3 resolved'));
  assert.deepEqual(retryableEvalV20Tasks(run).map((t) => t.id), ['swe-task-002']);
});

test('eval v20: so baseline — cải thiện không hồi quy, xấu đi thì hồi quy', () => {
  const baseline = recordEvalFixtureResults(evalRunFixture());
  // Current tốt hơn baseline: thêm task 4 resolved, task 2 cũng resolved.
  let better = recordEvalFixtureResults(evalRunFixture());
  better = recordEvalV20TaskResult(better, {
    taskId: 'swe-task-002', verdict: 'resolved', testsPassed: 3, testsTotal: 3,
    cost: 0.006, durationMs: 800, outputExcerpt: '3 passed', at: 1400,
  }).run;
  better = recordEvalV20TaskResult(better, {
    taskId: 'swe-task-004', verdict: 'resolved', testsPassed: 1, testsTotal: 1,
    cost: 0.01, durationMs: 900, outputExcerpt: '1 passed', at: 1500,
  }).run;
  const improved = compareEvalV20ToBaseline(better, baseline);
  assert.equal(improved.regressed, false);
  assert.ok((improved.resolvedPctDelta ?? 0) > 0);
  // Chỉ task có kết quả ở CẢ hai bên mới tính vào newlyResolved (task 004
  // chưa từng chạy ở baseline nên không tính — xem compareEvalV20ToBaseline).
  assert.deepEqual(improved.newlyResolvedTaskIds, ['swe-task-002']);
  // Current xấu hơn: mọi task đã resolved đều fail.
  let worse = createEvalV20Run('eval-worse', 'fleet-v20-smoke', 'gemini-2.5-flash', evalRunFixture().tasks, 1000);
  for (const taskId of ['swe-task-001', 'swe-task-002', 'swe-task-003']) {
    worse = recordEvalV20TaskResult(worse, {
      taskId, verdict: 'failed', testsPassed: 0, testsTotal: 1, cost: 0.01, durationMs: 500, outputExcerpt: 'fail', at: 1100,
    }).run;
  }
  const regressed = compareEvalV20ToBaseline(worse, baseline);
  assert.equal(regressed.regressed, true);
  assert.ok((regressed.resolvedPctDelta ?? 0) < -5);
  assert.deepEqual(regressed.newlyFailedTaskIds, ['swe-task-001', 'swe-task-003']);
  assert.ok(regressed.summary.includes('HỒI QUY'));
});

// ---------------------------------------------------------------------------
// 6b. Delegation v20 (spawn qua cây + wave run + gộp kết quả)
// ---------------------------------------------------------------------------

function delegationPlanFixture() {
  const requests = [
    { id: 'exp-a', kind: 'explore', task: 'Tìm hiểu plugin manager.' },
    { id: 'plan-b', kind: 'plan', task: 'Lập plan sửa plugin manager.', dependsOn: ['exp-a'] },
    { id: 'ver-c', kind: 'verify', task: 'Kiểm chứng sửa plugin manager.', dependsOn: ['plan-b'] },
  ];
  const plan = planSpecializedV20Spawns(requests, 2);
  return { requests, plan };
}

test('delegation v20: spawn qua cây — ok, leaf-only chặn con của chuyên biệt, cây đầy chặn spawn', () => {
  const tree = new SubagentTree({}, 'root');
  const parentTools = [...SPECIALIZED_V20_SPECS.explore.tools];
  const spawned = requestSpecializedV20Spawn(tree, 'explore', 'Tìm hiểu plugin manager.', parentTools);
  assert.equal(spawned.ok, true);
  assert.ok(spawned.node);
  assert.equal(spawned.node?.name, 'explore');
  assert.equal(spawned.node?.depth, 1);
  assert.equal(spawned.modelTier, 'cheap');
  assert.equal(spawned.tools?.includes('read_file'), true);
  assert.equal(spawned.tools?.includes('shell_exec'), false);
  // Con của explore (lá) → leaf-only, không chạm luật cây chung.
  const child = requestSpecializedV20Spawn(tree, 'plan', 'Lập plan.', parentTools, { parentId: spawned.node.id });
  assert.equal(child.ok, false);
  assert.equal(child.denial, 'leaf-only');
  assert.ok(child.message?.includes('lá của cây'));
  // Cây chỉ cho 1 node (root đã chiếm) → max-spawns-root.
  const tinyTree = new SubagentTree({ maxSpawnsPerRoot: 1 }, 'root');
  const denied = requestSpecializedV20Spawn(tinyTree, 'explore', 'Tìm hiểu.', parentTools);
  assert.equal(denied.ok, false);
  assert.equal(denied.denial, 'max-spawns-root');
  // Loại không tồn tại → resolve-failed, không tạo node.
  const bad = requestSpecializedV20Spawn(tree, 'coder', 'Code đi.', parentTools);
  assert.equal(bad.ok, false);
  assert.equal(bad.denial, 'resolve-failed');
});

test('delegation v20: wave run — sóng chạy theo dep, output lỗi retry 2 rồi escalate, dep fail thì blocked', () => {
  const { requests, plan } = delegationPlanFixture();
  let run = createSpecializedV20WaveRun({ id: 'wave-1', parentTaskId: 'task-1', waves: plan.waves, requests });
  assert.equal(run.totalWaves, 3);
  assert.equal(nextSpecializedV20Wave(run), 1);
  // Sóng 1: explore done với handoff hợp lệ.
  run = startSpecializedV20Request(run, 'exp-a', 'node-exp-a');
  const expCtx = createSubagentV20Context('explore', 'task-1', 'Tìm hiểu plugin manager.', { id: 'ctx-exp-a', now: 1000 });
  const expHandoff = buildSubagentV20Handoff(expCtx, {
    findings: [{ claim: 'Repo dùng pnpm.', sources: ['package.json:1'], confidence: 'high' }],
    notFound: [],
  }, [], 1000);
  let attached = attachSpecializedV20Handoff(run, 'exp-a', expHandoff);
  assert.equal(attached.accepted, true);
  run = attached.run;
  assert.equal(run.requests.find((r) => r.id === 'exp-a')?.status, 'done');
  assert.equal(nextSpecializedV20Wave(run), 2);
  // Sóng 2: plan trả output lỗi 3 lần — 2 retry rồi escalate thành failed.
  const badPlanOutput = { goal: 'Sửa.', steps: [], openQuestions: [], risks: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    run = startSpecializedV20Request(run, 'plan-b', `node-plan-b-${attempt}`);
    const planCtx = createSubagentV20Context('plan', 'task-1', 'Lập plan.', { id: `ctx-plan-b-${attempt}`, now: 1000 });
    const handoff = buildSubagentV20Handoff(planCtx, badPlanOutput, validatePlanV20Output(badPlanOutput), 1000);
    attached = attachSpecializedV20Handoff(run, 'plan-b', handoff);
    run = attached.run;
    if (attempt < 2) {
      assert.equal(attached.accepted, false);
      assert.equal(attached.escalated, false);
      assert.equal(run.requests.find((r) => r.id === 'plan-b')?.status, 'invalid-output');
      run = retrySpecializedV20Request(run, 'plan-b');
      assert.equal(run.requests.find((r) => r.id === 'plan-b')?.status, 'pending');
    } else {
      assert.equal(attached.escalated, true);
      assert.equal(run.requests.find((r) => r.id === 'plan-b')?.status, 'failed');
    }
  }
  assert.deepEqual(escalatedSpecializedV20Requests(run).map((r) => r.id), ['plan-b']);
  // Sóng 3 kẹt vì dep fail → blocked, run complete (không treo ở pending).
  assert.equal(nextSpecializedV20Wave(run), null);
  run = blockSpecializedV20Requests(run);
  assert.equal(run.requests.find((r) => r.id === 'ver-c')?.status, 'blocked');
  assert.equal(isSpecializedV20WaveRunComplete(run), true);
  // Handoff cho request không running → từ chối.
  const again = attachSpecializedV20Handoff(run, 'exp-a', expHandoff);
  assert.equal(again.accepted, false);
  assert.ok(again.errors[0]?.includes('done'));
});

test('delegation v20: merge findings/plan + rollup verify + tóm tắt sóng cho cha', () => {
  const mkHandoff = (kind, output, id) => {
    const ctx = createSubagentV20Context(kind, 'task-1', 'Task.', { id, now: 1000 });
    return buildSubagentV20Handoff(ctx, output, [], 1000);
  };
  const merged = mergeExploreV20Findings([
    mkHandoff('explore', { findings: [
      { claim: 'Repo dùng pnpm.', sources: ['package.json:1'], confidence: 'medium' },
      { claim: 'Repo có 900 tool.', sources: ['docs/a.md:2'], confidence: 'low' },
    ], notFound: [] }, 'ctx-m1'),
    mkHandoff('explore', { findings: [
      { claim: 'repo dùng  pnpm.', sources: ['README.md:5'], confidence: 'high' },
    ], notFound: [] }, 'ctx-m2'),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.claim, 'Repo dùng pnpm.');
  assert.equal(merged[0]?.confidence, 'high'); // giữ confidence cao nhất
  assert.equal(merged[0]?.supportCount, 2);
  assert.deepEqual([...merged[0]?.sources ?? []].sort(), ['README.md:5', 'package.json:1']);
  const { plan, mergedSteps } = mergePlanV20Outputs([
    mkHandoff('plan', {
      goal: 'Sửa A.', steps: [{ title: 'Thêm test', files: ['a.test.mjs'], verifyCommand: 'node --test a', doneCriteria: 'xanh' }],
      openQuestions: ['Q1'], risks: ['R1'],
    }, 'ctx-p1'),
    mkHandoff('plan', {
      goal: 'Sửa B.', steps: [{ title: 'Thêm test', files: ['b.test.mjs'], verifyCommand: 'node --test b', doneCriteria: 'xanh' }],
      openQuestions: ['Q1', 'Q2'], risks: [],
    }, 'ctx-p2'),
  ]);
  assert.equal(plan.steps.length, 1);
  assert.equal(mergedSteps, 1);
  assert.deepEqual(plan.steps[0]?.files.sort(), ['a.test.mjs', 'b.test.mjs']);
  assert.deepEqual(plan.openQuestions, ['Q1', 'Q2']);
  // Rollup verify: pass khi mọi verify done + mọi check pass; fail khi có check fail.
  const { requests, plan: spawnPlan } = delegationPlanFixture();
  let run = createSpecializedV20WaveRun({ id: 'wave-2', parentTaskId: 'task-1', waves: spawnPlan.waves, requests });
  assert.equal(rollupVerifyV20Verdicts(run).verdict, 'inconclusive');
  run = startSpecializedV20Request(run, 'exp-a', 'n1');
  run = attachSpecializedV20Handoff(run, 'exp-a', mkHandoff('explore', { findings: [], notFound: [] }, 'ctx-r1')).run;
  run = startSpecializedV20Request(run, 'plan-b', 'n2');
  run = attachSpecializedV20Handoff(run, 'plan-b', mkHandoff('plan', {
    goal: 'g', steps: [{ title: 't', files: ['f'], verifyCommand: 'c', doneCriteria: 'd' }], openQuestions: [], risks: [],
  }, 'ctx-r2')).run;
  run = startSpecializedV20Request(run, 'ver-c', 'n3');
  run = attachSpecializedV20Handoff(run, 'ver-c', mkHandoff('verify', {
    verdict: 'pass',
    checks: [{ check: 'unit', command: 'node --test x', passed: true, outputExcerpt: 'ok', durationMs: 5 }],
    summary: 'Pass.',
  }, 'ctx-r3')).run;
  const rollup = rollupVerifyV20Verdicts(run);
  assert.equal(rollup.verdict, 'pass');
  assert.equal(rollup.passed, true);
  assert.equal(rollup.doneVerify, 1);
  // Tóm tắt sóng: cần tree thật để summarizeChildForParent có node.
  const tree = new SubagentTree({}, 'root');
  const spawned = requestSpecializedV20Spawn(tree, 'explore', 'Tìm hiểu.', [...SPECIALIZED_V20_SPECS.explore.tools]);
  assert.equal(spawned.ok, true);
  let run2 = createSpecializedV20WaveRun({ id: 'wave-3', parentTaskId: 'task-1', waves: spawnPlan.waves, requests });
  run2 = startSpecializedV20Request(run2, 'exp-a', spawned.node.id);
  run2 = attachSpecializedV20Handoff(run2, 'exp-a', mkHandoff('explore', {
    findings: [{ claim: 'Repo dùng pnpm.', sources: ['package.json:1'], confidence: 'high' }], notFound: [],
  }, 'ctx-s1')).run;
  const summary = summarizeSpecializedV20WaveRun(run2, tree);
  assert.equal(summary.done, 1);
  assert.equal(summary.complete, false);
  assert.equal(summary.childSummaries.length, 1);
  assert.ok(summary.childSummaries[0]?.includes('explore'));
  assert.equal(summary.topFindings.length, 1);
  assert.ok(summary.estimatedTokens > 0);
  assert.ok(summary.summary.includes('1/3 done'));
  // failSpecializedV20Request: đánh dấu fail trực tiếp.
  const failed = failSpecializedV20Request(run2, 'plan-b', 'Timeout khi spawn.');
  assert.equal(failed.requests.find((r) => r.id === 'plan-b')?.status, 'failed');
});

// ---------------------------------------------------------------------------
// 6. Panels v20
// ---------------------------------------------------------------------------

test('panels v20: plugin panel rows theo id, chỉ hiện nút được phép', () => {
  const store = pluginStoreFixture();
  const view = buildPluginV20Panel(store);
  assert.equal(view.total, 4);
  assert.deepEqual(view.rows.map((r) => r.id), ['core-utils', 'old-host-plugin', 'report-pack', 'weather-tools']);
  const weather = view.rows.find((r) => r.id === 'weather-tools');
  assert.deepEqual(weather?.allowedActions, ['install']);
  assert.deepEqual(weather?.unapprovedDangerous, ['shell.exec']);
  const core = view.rows.find((r) => r.id === 'core-utils');
  assert.deepEqual(core?.allowedActions, ['disable', 'uninstall']);
  assert.ok(view.summary.includes('đang bật'));
  // Lọc chỉ plugin có quyền chưa duyệt.
  const filtered = buildPluginV20Panel(store, { unapprovedDangerousOnly: true });
  assert.deepEqual(filtered.rows.map((r) => r.id), ['weather-tools']);
});

test('panels v20: hook panel log chặn mới nhất trước + eval panel fail trước', () => {
  let hookStore = hookStoreFixture();
  hookStore = recordHookV20Run(hookStore, { hookId: 'guard-no-shell', event: 'tool.before', outcome: 'blocked', reason: 'Lệnh cấm 1.', durationMs: 3, at: 2000 });
  hookStore = recordHookV20Run(hookStore, { hookId: 'guard-no-shell', event: 'tool.before', outcome: 'blocked', reason: 'Lệnh cấm 2.', durationMs: 2, at: 3000 });
  const hookView = buildHookV20Panel(hookStore);
  assert.equal(hookView.totalBlocks, 2);
  assert.equal(hookView.recentBlocks[0]?.reason, 'Lệnh cấm 2.');
  assert.equal(hookView.rows[0]?.id, 'guard-no-shell'); // priority nhỏ trước
  const run = recordEvalFixtureResults(evalRunFixture());
  const evalView = buildEvalV20Panel(run);
  assert.equal(evalView.resolved, 2);
  assert.equal(evalView.rows[0]?.verdict, 'failed'); // fail trước
  assert.equal(evalView.rows[1]?.verdict, 'pending'); // pending giữa (chưa chạy)
  assert.equal(evalView.rows.at(-1)?.verdict, 'resolved'); // resolved cuối
  assert.ok(Math.abs((evalView.resolvedPct ?? 0) - (2 / 3) * 100) < 0.001);
  assert.equal(evalView.regression, null);
  const withBaseline = buildEvalV20Panel(run, recordEvalFixtureResults(evalRunFixture()));
  assert.ok(withBaseline.regression);
  assert.equal(withBaseline.regression?.regressed, false);
  // Subagent panel.
  let pool = createSubagentV20ContextPool(4);
  const alloc = allocateSubagentV20Context(pool, 'explore', 'task-1', 'Tìm A.', { id: 'panel-ctx-1' });
  pool = alloc.pool;
  const subView = buildSubagentV20Panel(pool, 5000);
  assert.equal(subView.active, 1);
  assert.equal(subView.byKind.explore, 1);
  assert.equal(subView.activeContexts[0]?.id, 'panel-ctx-1');
  assert.ok(subView.summary.includes('1/4'));
});

test('panels v20: dashboard gộp 4 panel + attention error trước warning sau', () => {
  const pluginStore = pluginStoreFixture();
  const hookStore = hookStoreFixture();
  let pool = createSubagentV20ContextPool(1);
  const first = allocateSubagentV20Context(pool, 'explore', 'task-1', 'Tìm A.', { id: 'dash-ctx-1' });
  pool = first.pool;
  const rejected = allocateSubagentV20Context(pool, 'verify', 'task-1', 'Kiểm B.', { id: 'dash-ctx-2' });
  pool = rejected.pool;
  assert.equal(pool.rejectedFull, 1);
  const run = recordEvalFixtureResults(evalRunFixture());
  const dash = buildFleetV20Dashboard(pluginStore, hookStore, pool, run);
  assert.equal(dash.counts.pluginsEnabled, 1);
  assert.equal(dash.counts.hooksBlockedTotal, 0);
  assert.ok(Math.abs((dash.counts.evalResolvedPct ?? 0) - (2 / 3) * 100) < 0.001);
  assert.equal(dash.counts.evalPending, 1);
  assert.equal(dash.counts.subagentsActive, 1);
  assert.ok(dash.attentionCount >= 3);
  // Attention có cảnh báo quyền chưa duyệt (plugin), task eval fail, pool đầy (subagent).
  assert.ok(dash.attention.some((a) => a.panel === 'plugin' && a.message.includes('shell.exec')));
  assert.ok(dash.attention.some((a) => a.panel === 'eval' && a.message.includes('swe-task-002')));
  assert.ok(dash.attention.some((a) => a.panel === 'subagent' && a.message.includes('từ chối')));
  assert.ok(dash.summary.includes('Plugin:'));
  // Chưa chạy eval: evalSummary nói rõ, không bịa số.
  const noEval = buildFleetV20Dashboard(pluginStore, hookStore, pool);
  assert.equal(noEval.counts.evalResolvedPct, null);
  assert.ok(noEval.evalSummary.includes('Chưa chạy eval'));
});

// ---------------------------------------------------------------------------
// 7. Tools v20 + i18n
// ---------------------------------------------------------------------------

test('tools v20: 25 defs, unique, write = 11, groups 6/7/8/4', () => {
  assert.equal(FLEET_V20_TOOLS.length, 25);
  assert.equal(fleetV20ToolNamesUnique(), true);
  for (const tool of FLEET_V20_TOOLS) {
    assert.ok(tool.description.length > 0, tool.name);
    assert.ok(tool.requiresAction.length > 0, tool.name);
    assert.ok(Array.isArray(tool.params), tool.name);
  }
  assert.equal(fleetV20ToolsByGroup('subagentV20').length, 6);
  assert.equal(fleetV20ToolsByGroup('pluginV20').length, 7);
  assert.equal(fleetV20ToolsByGroup('hookV20').length, 8);
  assert.equal(fleetV20ToolsByGroup('evalV20').length, 4);
  assert.equal(fleetV20WriteTools().length, 11);
  assert.equal(findFleetV20Tool('pluginV20.enable')?.write, true);
  assert.equal(findFleetV20Tool('evalV20.report')?.write, false);
  assert.equal(findFleetV20Tool('nope'), undefined);
});

test('i18n v20: 6 locales 7540 keys, key sets giống nhau, v20 đủ 85 keys/locale', () => { // v1.36 re-pin: 7540.
  const locales = ['vi', 'en', 'zh', 'ja', 'fr', 'es'];
  const loaded = locales.map((loc) => {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${loc}.json`), 'utf-8'));
    return { loc, data };
  });
  for (const { loc, data } of loaded) {
    assert.equal(Object.keys(data).length, 7540, loc); // v1.36 re-pin: 7540.
    for (const [key, value] of Object.entries(data)) {
      assert.equal(typeof value, 'string', `${loc}:${key}`);
      assert.ok(value.length > 0, `${loc}:${key} trống`);
    }
    const countPrefix = (prefix) => Object.keys(data).filter((k) => k.startsWith(`${prefix}.`)).length;
    assert.equal(countPrefix('fleetV20'), 25, loc);
    assert.equal(countPrefix('pluginV20'), 17, loc);
    assert.equal(countPrefix('hookV20'), 15, loc);
    assert.equal(countPrefix('evalV20'), 28, loc);
  }
  const baseKeys = Object.keys(loaded[0].data).sort();
  for (const { loc, data } of loaded.slice(1)) {
    assert.deepEqual(Object.keys(data).sort(), baseKeys, `key set lệch ở ${loc}`);
  }
  // Spot-check: bản dịch khác nhau giữa các locale.
  assert.notEqual(loaded[0].data['pluginV20.title'], loaded[1].data['pluginV20.title']);
  assert.notEqual(loaded[0].data['hookV20.title'], loaded[2].data['hookV20.title']);
  assert.equal(loaded[0].data['pluginV20.install'], 'Cài');
  assert.equal(loaded[1].data['evalV20.regression'], 'Regression');
});
