/**
 * Tests cho coding agent v15 — eval rubric + verify history + 2 tool mới (v1.37, Đội T4).
 *
 * Chạy thật: eval thật trên agent run thật, verify history thật
 * (JSONL tạm), tool clone/run_report thật. Không gọi model/mạng.
 *   npm run build --workspace=@open-bot/core (scoped, trong worktree)
 *   npm run build --workspace=@open-bot/tools (scoped, trong worktree)
 *   node --test tests/coding-v15-eval-history-v137.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

import {
  CODING_V15_TOOL_NAMES,
  createCodingV15Tools,
  isCodingV15ToolName,
} from '../packages/tools/dist/index.js';
import {
  CodingV15BudgetMeter,
  CodingV15VerifyHistory,
  renderV15BudgetForecast,
  renderV15EvalResult,
  renderV15VerifyComparison,
  renderV15VerifyFlaky,
  runV15Agent,
  scriptedV15Agent,
  v15CompareVerifyReports,
  v15CustomScenario,
  v15EvalRun,
  v15ForecastBudget,
  v15RunVerifyScenarios,
  v15ScriptedVerifyStepFn,
  v15CorrectOutcomes,
  v15WrongOutcomes,
  v15BuiltinScenarios,
  v15ScenarioOutcomeTemplate,
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

function getTool(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool not found: ${name}`);
  return tool;
}

async function runTool(tool, args, ctx) {
  const raw = await tool.execute(args, ctx);
  assert.equal(typeof raw, 'string');
  if (raw.startsWith('Error:')) throw new Error(`tool ${tool.definition.name} failed: ${raw}`);
  return JSON.parse(raw);
}

function makeResult(overrides = {}) {
  return {
    runId: 'eval-1',
    profileId: 'v15-general',
    botId: 'bot-1',
    prompt: 'Do it',
    stepsExecuted: 1,
    done: true,
    stoppedByMaxSteps: false,
    budget: {
      runId: 'eval-1',
      botId: 'bot-1',
      profileId: 'v15-general',
      model: 'gpt-5',
      state: {
        runId: 'eval-1', botId: 'bot-1', profileId: 'v15-general', model: 'gpt-5',
        cap: { maxTokens: 1000 }, inputTokens: 100, outputTokens: 50, totalTokens: 150,
        costUsd: 0.001, tokensEstimated: false, tokensPercent: 15, costPercent: null,
        overCap: false, warnings: [], records: 2,
      },
      reportOnlyNote: 'Report-only meter.',
      summary: 'Run eval-1: 150 tokens.',
    },
    hooksDialog: { open: false, total: 0, pending: 0, confirmed: 0, dismissed: 0, snoozed: 0, pendingItems: [], selectedId: null },
    filesWritten: ['a.txt'],
    toolErrors: [],
    createdAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  };
}

test('eval: run tốt đạt A, run tệ bị trừ từng chiều, vượt cap không auto-F', () => {
  const good = v15EvalRun(makeResult());
  assert.equal(good.total, 100);
  assert.equal(good.grade, 'A');
  assert.equal(good.dimensions.length, 5);
  assert.ok(good.dimensions.every((d) => d.score === 100));
  assert.ok(good.summary.includes('100/100 grade A'));
  assert.ok(renderV15EvalResult(good).includes('grade A'));
  // Run chưa done vì hết step + 2 lỗi tool + hook pending 2 → điểm thấp.
  const bad = v15EvalRun(makeResult({
    stepsExecuted: 20,
    done: false,
    stoppedByMaxSteps: true,
    toolErrors: ['run_tests: fail', 'edit_file: fail'],
    filesWritten: [],
    hooksDialog: { open: true, total: 2, pending: 2, confirmed: 0, dismissed: 0, snoozed: 0, pendingItems: [{ id: 'x', runId: 'eval-1', hookKind: 'stop', source: 's', title: 't', body: 'b', severity: 'warning', status: 'pending', createdAt: '2026-11-18T00:00:00.000Z', snoozeCount: 0 }], selectedId: null },
  }));
  assert.ok(bad.total < 60, `bad total ${bad.total} cần < 60`);
  assert.equal(bad.grade, 'F');
  const completion = bad.dimensions.find((d) => d.name === 'completion');
  assert.equal(completion.score, 30);
  const correctness = bad.dimensions.find((d) => d.name === 'correctness');
  assert.equal(correctness.score, 50); // 100 - 2*25
  // Vượt cap: budget trừ điểm nhưng không auto-F khi các chiều khác tốt.
  const overCap = v15EvalRun(makeResult({
    budget: {
      ...makeResult().budget,
      state: { ...makeResult().budget.state, totalTokens: 1500, tokensPercent: 150, overCap: true, warnings: [{ level: 'over100', dimension: 'tokens', percent: 150, message: 'over', at: '2026-11-18T00:00:00.000Z' }] },
    },
  }));
  const budgetDim = overCap.dimensions.find((d) => d.name === 'budget');
  assert.ok(budgetDim.score < 100 && budgetDim.score >= 20);
  assert.ok(overCap.total >= 80, `over-cap run vẫn khá vì các chiều khác tốt: ${overCap.total}`);
  // Trọng số cộng đúng 1.
  const weights = good.dimensions.reduce((s, d) => s + d.weight, 0);
  assert.ok(Math.abs(weights - 1) < 1e-9);
});

test('verify history: append/compare/flaky/trend + JSONL persistence, dòng hỏng bỏ qua', async () => {
  const dir = tmpDir('open-bot-v15-vhist-');
  try {
    const good = await v15RunVerifyScenarios(v15ScriptedVerifyStepFn(v15CorrectOutcomes()), { runId: 'vh-1', profileId: 'v15-general' });
    const bad = await v15RunVerifyScenarios(v15ScriptedVerifyStepFn(v15WrongOutcomes()), { runId: 'vh-2', profileId: 'v15-general' });
    const history = new CodingV15VerifyHistory({ dataDir: dir });
    assert.equal(history.size, 0);
    assert.equal(history.latest(), null);
    assert.equal(history.compareLatestWithPrevious(), null);
    history.append(good);
    history.append(bad);
    assert.equal(history.size, 2);
    assert.equal(history.latest().runId, 'vh-2');
    assert.equal(history.get('vh-1').passed, 9);
    assert.equal(history.get('nope'), null);
    // So sánh: good → bad = 9 regression, 0 fixed.
    const cmp = history.compareLatestWithPrevious();
    assert.equal(cmp.newlyFailed.length, 9);
    assert.equal(cmp.newlyPassed.length, 0);
    assert.equal(cmp.stillFailing.length, 0);
    assert.ok(cmp.summary.includes('REGRESSION'));
    assert.ok(renderV15VerifyComparison(cmp).includes('Newly failed (regression)'));
    // So sánh trực tiếp theo runId + lỗi khi thiếu report.
    const cmp2 = history.compare('vh-2', 'vh-1');
    assert.equal(cmp2.baselineRunId, 'vh-1');
    assert.throws(() => history.compare('vh-2', 'nope'), /Không tìm thấy verify baseline/);
    // Flaky: mọi scenario đều lúc pass lúc fail qua 2 lần chạy.
    const flaky = history.flaky();
    assert.equal(flaky.length, 9);
    assert.ok(flaky.every((f) => f.runs === 2 && f.passes === 1 && f.fails === 1 && f.passRate === 0.5));
    // Worst: scenario tệ nhất (pass rate thấp nhất) — ở đây mọi scenario đều 50%.
    const worst = history.worstScenarios(3);
    assert.equal(worst.length, 3);
    assert.ok(worst.every((w) => w.passRate === 0.5));
    assert.ok(renderV15VerifyFlaky(flaky).includes('50% pass over 2 run(s)'));
    assert.equal(renderV15VerifyFlaky([]), 'No flaky scenarios.');
    // Trend: 100% rồi 0%.
    const trend = history.trend();
    assert.deepEqual(trend.map((p) => p.passRate), [1, 0]);
    assert.ok(history.renderTrend().includes('vh-1: 9/9 (100%)'));
    // Persistence: history mới đọc lại file, đủ 2 report.
    const history2 = new CodingV15VerifyHistory({ dataDir: dir });
    assert.equal(history2.size, 2);
    assert.equal(history2.getSkippedLines(), 0);
    // Dòng hỏng trong file bị bỏ qua.
    fs.appendFileSync(path.join(dir, 'verify-history.jsonl'), 'not json\n{"runId": 1}\n', 'utf8');
    const history3 = new CodingV15VerifyHistory({ dataDir: dir });
    assert.equal(history3.size, 2);
    assert.equal(history3.getSkippedLines(), 2);
    // Append report hỏng → throw.
    assert.throws(() => history.append({ runId: 'bad' }), /không hợp lệ/);
    // Compare trực tiếp 2 report giống nhau: 0 regression.
    const same = v15CompareVerifyReports(good, good);
    assert.equal(same.newlyFailed.length, 0);
    assert.equal(same.stillPassing.length, 9);
  } finally {
    cleanup(dir);
  }
});

test('tools: 14 tools gồm profile_clone + run_report + verify_history + eval', async () => {
  assert.equal(CODING_V15_TOOL_NAMES.length, 14);
  assert.ok(isCodingV15ToolName('coding_v15_profile_clone'));
  assert.ok(isCodingV15ToolName('coding_v15_run_report'));
  assert.ok(isCodingV15ToolName('coding_v15_verify_history'));
  assert.ok(isCodingV15ToolName('coding_v15_eval'));
  const base = tmpDir('open-bot-v15-tools3-base-');
  const ws = tmpDir('open-bot-v15-tools3-ws-');
  try {
    const tools = createCodingV15Tools(() => base);
    const ctx = { workspaceDir: ws, botId: 'test-bot' };
    // Clone built-in reviewer → custom, sửa được.
    const cloned = await runTool(getTool(tools, 'coding_v15_profile_clone'), { profileId: 'v15-reviewer', newId: 'my-reviewer', newName: 'My Reviewer' }, ctx);
    assert.equal(cloned.profile.id, 'my-reviewer');
    assert.equal(cloned.profile.builtin, false);
    assert.equal(cloned.profile.kind, 'reviewer');
    const updated = await runTool(getTool(tools, 'coding_v15_profile_update'), { profileId: 'my-reviewer', patchJson: JSON.stringify({ model: 'gpt-5' }) }, ctx);
    assert.equal(updated.profile.model, 'gpt-5');
    const badClone = await getTool(tools, 'coding_v15_profile_clone').execute({ profileId: 'nope' }, ctx);
    assert.ok(badClone.startsWith('Error:'));
    // Run agent thật rồi run_report trên kết quả.
    const dir = tmpDir('open-bot-v15-tools3-agent-');
    const agentResult = runV15Agent(
      { runId: 'rr-1', prompt: 'Fix it', profileId: 'v15-general', botId: 'bot-1' },
      scriptedV15Agent([{ text: 'Done.', toolCalls: [], done: true, inputTokens: 20, outputTokens: 10 }]),
      { dataDir: dir },
    );
    const report = await runTool(getTool(tools, 'coding_v15_run_report'), { resultJson: JSON.stringify(agentResult) }, ctx);
    assert.ok(report.markdown.startsWith('# Coding agent v15 — run rr-1'));
    assert.ok(report.markdown.includes('## Budget (report-only)'));
    assert.equal(report.eval.grade, 'A');
    assert.ok(report.evalSummary.includes('100/100'));
    assert.equal(report.report.runId, 'rr-1');
    const badReport = await getTool(tools, 'coding_v15_run_report').execute({ resultJson: JSON.stringify({ runId: 'x' }) }, ctx);
    assert.ok(badReport.startsWith('Error:'));
    cleanup(dir);
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('forecast + custom scenario: dự báo vượt cap đúng, scenario custom ghi đè được', async () => {
  const meter = new CodingV15BudgetMeter('bot-f', { maxTokens: 1000 });
  // Chưa có record → không dự báo được.
  const empty = v15ForecastBudget(
    { runId: 'f-0', botId: 'bot-f', profileId: '', model: 'gpt-5', cap: { maxTokens: 1000 }, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null, tokensEstimated: false, tokensPercent: null, costPercent: null, overCap: false, warnings: [], records: 0 },
    5,
  );
  assert.equal(empty.avgTokensPerStep, 0);
  assert.ok(empty.recommendation.includes('Not enough data'));
  // 2 step x 300 token = 600; còn 5 step → dự báo 2100 > cap 1000.
  meter.record({ runId: 'f-1', model: 'gpt-5', inputTokens: 300, outputTokens: 0 });
  meter.record({ runId: 'f-1', model: 'gpt-5', inputTokens: 300, outputTokens: 0 });
  const state = meter.state('f-1');
  const forecast = v15ForecastBudget(state, 5);
  assert.equal(forecast.stepsSoFar, 2);
  assert.equal(forecast.avgTokensPerStep, 300);
  assert.equal(forecast.projectedTotalTokens, 2100);
  assert.equal(forecast.projectedOverTokenCap, true);
  assert.ok(forecast.recommendation.includes('Projected to exceed'));
  assert.ok(renderV15BudgetForecast(forecast).includes('Projected total: 2,100 tokens'));
  // Còn 1 step → 900, trong cap.
  const okForecast = v15ForecastBudget(state, 1);
  assert.equal(okForecast.projectedTotalTokens, 900);
  assert.equal(okForecast.projectedOverTokenCap, false);
  assert.ok(!okForecast.recommendation.includes('exceed'));
  assert.throws(() => v15ForecastBudget(state, -1), /stepsRemaining/);
  // Custom scenario: ghi đè expectation + timeout, builtin=false.
  const custom = v15CustomScenario({ kind: 'timeout', id: 'v15-custom-timeout-strict', expectation: 'Agent must stop within 5s and say timeout.', timeoutMs: 5000 });
  assert.equal(custom.id, 'v15-custom-timeout-strict');
  assert.equal(custom.kind, 'timeout');
  assert.equal(custom.expectation, 'Agent must stop within 5s and say timeout.');
  assert.equal(custom.timeoutMs, 5000);
  assert.equal(custom.builtin, false);
  assert.equal(custom.name, 'Step timeout');
  // Default id khi không đưa.
  assert.equal(v15CustomScenario({ kind: 'tool_error' }).id, 'v15-custom-tool-error');
  assert.throws(() => v15CustomScenario({ kind: 'nope' }), /không hợp lệ/);
  assert.throws(() => v15CustomScenario({ kind: 'timeout', timeoutMs: 0 }), /timeoutMs/);
  // Template outcome: correct pass, wrong fail cho cùng scenario.
  const goodOutcome = v15ScenarioOutcomeTemplate('tool_error', 'correct');
  const badOutcome = v15ScenarioOutcomeTemplate('tool_error', 'wrong');
  assert.equal(goodOutcome.agentRetries, 1);
  assert.equal(badOutcome.agentRetries, 5);
  const report = await v15RunVerifyScenarios(
    v15ScriptedVerifyStepFn({ tool_error: goodOutcome, timeout: v15CorrectOutcomes().timeout }),
    { runId: 'custom-verify', scenarios: [custom, v15CustomScenario({ kind: 'tool_error' })] },
  );
  assert.equal(report.total, 2);
  assert.equal(report.passed, 2);
});

test('tools: verify_history append/list/compare/flaky/trend + eval tool', async () => {
  const base = tmpDir('open-bot-v15-tools4-base-');
  const ws = tmpDir('open-bot-v15-tools4-ws-');
  try {
    const tools = createCodingV15Tools(() => base);
    const ctx = { workspaceDir: ws, botId: 'test-bot' };
    const good = await v15RunVerifyScenarios(v15ScriptedVerifyStepFn(v15CorrectOutcomes()), { runId: 'vh-t1', profileId: 'v15-general' });
    const bad = await v15RunVerifyScenarios(v15ScriptedVerifyStepFn(v15WrongOutcomes()), { runId: 'vh-t2', profileId: 'v15-general' });
    const appended1 = await runTool(getTool(tools, 'coding_v15_verify_history'), { action: 'append', reportJson: JSON.stringify(good) }, ctx);
    assert.equal(appended1.size, 1);
    const appended2 = await runTool(getTool(tools, 'coding_v15_verify_history'), { action: 'append', reportJson: JSON.stringify(bad) }, ctx);
    assert.equal(appended2.size, 2);
    const listed = await runTool(getTool(tools, 'coding_v15_verify_history'), { action: 'list' }, ctx);
    assert.equal(listed.reports.length, 2);
    assert.equal(listed.reports[0].passed, 9);
    const compared = await runTool(getTool(tools, 'coding_v15_verify_history'), { action: 'compare', runId: 'vh-t2', baselineRunId: 'vh-t1' }, ctx);
    assert.equal(compared.comparison.newlyFailed.length, 9);
    assert.ok(compared.summary.includes('REGRESSION'));
    const flaky = await runTool(getTool(tools, 'coding_v15_verify_history'), { action: 'flaky' }, ctx);
    assert.equal(flaky.flaky.length, 9);
    const trend = await runTool(getTool(tools, 'coding_v15_verify_history'), { action: 'trend' }, ctx);
    assert.ok(trend.summary.includes('vh-t1: 9/9 (100%)'));
    assert.ok(trend.summary.includes('vh-t2: 0/9 (0%)'));
    const badAction = await getTool(tools, 'coding_v15_verify_history').execute({ action: 'explode' }, ctx);
    assert.ok(badAction.startsWith('Error:'));
    // Eval tool trên run thật.
    const dir = tmpDir('open-bot-v15-tools4-agent-');
    const agentResult = runV15Agent(
      { runId: 'ev-t1', prompt: 'Do it', profileId: 'v15-general', botId: 'bot-1' },
      scriptedV15Agent([{ text: 'Done.', toolCalls: [], done: true, inputTokens: 20, outputTokens: 10 }]),
      { dataDir: dir },
    );
    const evalOut = await runTool(getTool(tools, 'coding_v15_eval'), { resultJson: JSON.stringify(agentResult) }, ctx);
    assert.equal(evalOut.eval.grade, 'A');
    assert.equal(evalOut.eval.total, 100);
    assert.ok(evalOut.summary.includes('grade A'));
    cleanup(dir);
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('panel views: CodingV15RunReportView.tsx dùng key i18n có trong en.json, không hard-code tiếng Việt', () => {
  const viewPath = join(here, '..', 'apps/desktop/src/renderer/components/CodingV15RunReportView.tsx');
  assert.ok(fs.existsSync(viewPath), 'thiếu CodingV15RunReportView.tsx');
  const src = readFileSync(viewPath, 'utf8');
  const en = JSON.parse(readFileSync(join(here, '..', 'apps/desktop/src/renderer/i18n/locales/en.json'), 'utf8'));
  const used = [...src.matchAll(/t\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length > 10, `view dùng quá ít key i18n: ${used.length}`);
  for (const key of new Set(used)) {
    if (key.startsWith('codingV15.')) {
      assert.ok(key in en, `view dùng key ${key} nhưng en.json không có`);
    }
  }
  const vietnamese = src.match(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/g);
  assert.equal(vietnamese, null, `view hard-code tiếng Việt: ${vietnamese?.slice(0, 5).join('')}`);
  assert.ok(src.includes('demoCodingV15RunReport'));
  assert.ok(src.includes('evalTotal'));
  assert.ok(src.includes('verifyPassed'));
});
