/**
 * Tests cho coding agent v15 tools + i18n (v1.37, Đội T4).
 *
 * Chạy thật: tool execute thật trên thư mục tạm (profile JSON +
 * hooks dialog JSON + workspace file thật), không gọi model/mạng;
 * i18n là JSON thuần (không cần build tools cho phần i18n).
 *   npm run build --workspace=@open-bot/core (scoped, trong worktree)
 *   npm run build --workspace=@open-bot/tools (scoped, trong worktree)
 *   node --test tests/coding-v15-tools-i18n-v137.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_TOOLS,
  CODING_V15_TOOLS,
  CODING_V15_TOOL_NAMES,
  createCodingV15Tools,
  createDefaultTools,
  isCodingV15ToolName,
} from '../packages/tools/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CODING_V15_KEYS = [
  'codingV15.agent',
  'codingV15.filesWritten',
  'codingV15.flaky',
  'codingV15.forecast',
  'codingV15.grade',
  'codingV15.prompt',
  'codingV15.toolErrors',
  'codingV15.verifyHistory',
  'codingV15.verifyTrend',
  'codingV15.eval',
  'codingV15.allTools',
  'codingV15.demo',
  'codingV15.noBudgetHistory',
  'codingV15.noPendingFeedback',
  'codingV15.noProfiles',
  'codingV15.panelTabBudget',
  'codingV15.panelTabHooks',
  'codingV15.panelTabProfiles',
  'codingV15.panelTabVerify',
  'codingV15.profileModel',
  'codingV15.runReport',
  'codingV15.selectProfile',
  'codingV15.applyProfile',
  'codingV15.budget',
  'codingV15.budgetCost',
  'codingV15.budgetHistory',
  'codingV15.budgetOverCap',
  'codingV15.budgetReport',
  'codingV15.budgetReportOnly',
  'codingV15.budgetTokens',
  'codingV15.budgetWarning100',
  'codingV15.budgetWarning80',
  'codingV15.createProfile',
  'codingV15.deleteProfile',
  'codingV15.editProfile',
  'codingV15.explorer',
  'codingV15.fixer',
  'codingV15.general',
  'codingV15.hooksDialog',
  'codingV15.hooksDialogConfirm',
  'codingV15.hooksDialogDismiss',
  'codingV15.hooksDialogEmpty',
  'codingV15.hooksDialogSnooze',
  'codingV15.hooksDialogTitle',
  'codingV15.listProfiles',
  'codingV15.planner',
  'codingV15.profile',
  'codingV15.profileClone',
  'codingV15.profileAcp',
  'codingV15.profileApply',
  'codingV15.profileCreate',
  'codingV15.profileDelete',
  'codingV15.profileUpdate',
  'codingV15.reviewer',
  'codingV15.summary',
  'codingV15.title',
  'codingV15.verify',
  'codingV15.verifyEmptyResponse',
  'codingV15.verifyFileConflict',
  'codingV15.verifyLargeDiff',
  'codingV15.verifyMalformedOutput',
  'codingV15.verifyMidRunTestFailure',
  'codingV15.verifyPermissionDenied',
  'codingV15.verifyTimeout',
  'codingV15.verifyToolError',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

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

function ctxFor(baseDir, workspaceDir) {
  return { workspaceDir, botId: 'test-bot' };
}

test('tools: 14 coding_v15 tools trong ALL_TOOLS, không trùng tên, bind thay thế đúng chỗ', () => {
  assert.equal(CODING_V15_TOOLS.length, 14);
  assert.deepEqual([...CODING_V15_TOOL_NAMES], CODING_V15_TOOLS.map((t) => t.definition.name));
  for (const name of CODING_V15_TOOL_NAMES) {
    assert.ok(isCodingV15ToolName(name));
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `missing in ALL_TOOLS: ${name}`);
  }
  assert.ok(!isCodingV15ToolName('coding_v14_agent'));
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'ALL_TOOLS có tên trùng');
  // Bind qua createDefaultTools: đúng 14 tên, không nhân đôi.
  const base = tmpDir('open-bot-v15-bind-');
  try {
    const bound = createDefaultTools({ getCodingV15BaseDir: () => base });
    const v15 = bound.filter((t) => isCodingV15ToolName(t.definition.name));
    assert.equal(v15.length, 14);
    assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length);
  } finally {
    cleanup(base);
  }
});

test('tools: profile CRUD + apply qua tool (persist qua data dir)', async () => {
  const base = tmpDir('open-bot-v15-tools-base-');
  const ws = tmpDir('open-bot-v15-tools-ws-');
  try {
    const tools = createCodingV15Tools(() => base);
    const ctx = ctxFor(base, ws);
    // Create custom profile.
    const created = await runTool(getTool(tools, 'coding_v15_profile_create'), {
      profileJson: JSON.stringify({ name: 'Tool Fixer', kind: 'fixer', persona: 'Fix it.', model: 'gpt-5', allowedTools: ['edit_file'], exposeViaAcp: true }),
    }, ctx);
    assert.equal(created.profile.id, 'tool-fixer');
    assert.equal(created.profile.model, 'gpt-5');
    // List: built-in 5 + custom 1 = 6; acpOnly lọc đúng.
    const listed = await runTool(getTool(tools, 'coding_v15_profile_list'), {}, ctx);
    assert.equal(listed.count, 6);
    const acpOnly = await runTool(getTool(tools, 'coding_v15_profile_list'), { acpOnly: true }, ctx);
    assert.equal(acpOnly.count, 4); // general + reviewer + fixer built-in + tool-fixer
    assert.ok(acpOnly.profiles.every((p) => p.acpDisplayName.endsWith('[ACP]')));
    const reviewers = await runTool(getTool(tools, 'coding_v15_profile_list'), { kind: 'reviewer' }, ctx);
    assert.equal(reviewers.count, 1);
    assert.equal(reviewers.profiles[0].id, 'v15-reviewer');
    // Apply.
    const applied = await runTool(getTool(tools, 'coding_v15_profile_apply'), { profileId: 'tool-fixer', fallbackModel: 'fallback' }, ctx);
    assert.equal(applied.model, 'gpt-5');
    assert.deepEqual(applied.effectiveTools, ['edit_file']);
    assert.equal(applied.acpDisplayName, 'Tool Fixer [ACP]');
    assert.ok(applied.systemPrompt.includes('Fix it.'));
    // Update rồi delete.
    const updated = await runTool(getTool(tools, 'coding_v15_profile_update'), {
      profileId: 'tool-fixer',
      patchJson: JSON.stringify({ model: 'claude-opus-4-6' }),
    }, ctx);
    assert.equal(updated.profile.model, 'claude-opus-4-6');
    assert.equal(updated.profile.version, 2);
    const deleted = await runTool(getTool(tools, 'coding_v15_profile_delete'), { profileId: 'tool-fixer' }, ctx);
    assert.equal(deleted.deleted, 'tool-fixer');
    const afterDelete = await runTool(getTool(tools, 'coding_v15_profile_list'), {}, ctx);
    assert.equal(afterDelete.count, 5);
    // Lỗi: tạo trùng, xóa built-in, apply profile không có → Error:.
    const dup = await getTool(tools, 'coding_v15_profile_create').execute({ profileJson: JSON.stringify({ name: 'Dup', persona: 'x' }) }, ctx);
    assert.ok(!dup.startsWith('Error:'));
    const dup2 = await getTool(tools, 'coding_v15_profile_create').execute({ profileJson: JSON.stringify({ name: 'Dup', persona: 'x' }) }, ctx);
    assert.ok(dup2.startsWith('Error:'));
    const delBuiltin = await getTool(tools, 'coding_v15_profile_delete').execute({ profileId: 'v15-general' }, ctx);
    assert.ok(delBuiltin.startsWith('Error:'));
    const badApply = await getTool(tools, 'coding_v15_profile_apply').execute({ profileId: 'nope' }, ctx);
    assert.ok(badApply.startsWith('Error:'));
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('tools: budget report/history report-only + hooks dialog + verify + agent', async () => {
  const base = tmpDir('open-bot-v15-tools2-base-');
  const ws = tmpDir('open-bot-v15-tools2-ws-');
  try {
    const tools = createCodingV15Tools(() => base);
    const ctx = ctxFor(base, ws);
    // Budget report: cap 100 token, dùng 150 → overCap nhưng report vẫn trả về (không Error).
    const budget = await runTool(getTool(tools, 'coding_v15_budget_report'), {
      runId: 'run-b1',
      botId: 'bot-1',
      maxTokens: 100,
      usageJson: JSON.stringify([
        { model: 'gpt-5', inputTokens: 100, outputTokens: 0, profileId: 'v15-general' },
        { model: 'gpt-5', inputTokens: 50, outputTokens: 0, profileId: 'v15-general' },
      ]),
    }, ctx);
    assert.equal(budget.report.state.totalTokens, 150);
    assert.equal(budget.report.state.overCap, true);
    assert.ok(budget.report.reportOnlyNote.includes('never stops a run'));
    assert.equal(budget.report.state.warnings.length, 2); // warn80 + over100
    // Forecast: 2 records x 75 token avg = 150; còn 5 step → dự báo 525 token.
    const forecastBudget = await runTool(getTool(tools, 'coding_v15_budget_report'), {
      runId: 'run-b1',
      botId: 'bot-1',
      maxTokens: 1000,
      usageJson: JSON.stringify([
        { model: 'gpt-5', inputTokens: 100, outputTokens: 0, profileId: 'v15-general' },
        { model: 'gpt-5', inputTokens: 50, outputTokens: 0, profileId: 'v15-general' },
      ]),
      stepsRemaining: 5,
    }, ctx);
    assert.equal(forecastBudget.forecast.projectedTotalTokens, 525);
    assert.equal(forecastBudget.forecast.projectedOverTokenCap, false);
    assert.ok(forecastBudget.summary.includes('Budget forecast'));
    // Budget history: 2 run.
    const history = await runTool(getTool(tools, 'coding_v15_budget_history'), {
      botId: 'bot-1',
      recordsJson: JSON.stringify([
        { runId: 'run-b1', model: 'gpt-5', inputTokens: 150, outputTokens: 0 },
        { runId: 'run-b2', model: 'gpt-5', inputTokens: 10, outputTokens: 5 },
      ]),
    }, ctx);
    assert.equal(history.totals.runs, 2);
    assert.equal(history.totals.totalTokens, 165);
    assert.equal(history.history.length, 2);
    // Hooks dialog: add → list → confirm; feedback không vào chat (tool chỉ trả dialogState).
    const added = await runTool(getTool(tools, 'coding_v15_hooks_dialog'), {
      action: 'add',
      feedbackJson: JSON.stringify({ runId: 'run-h1', source: 'stop-hook', title: 'Stop now', body: 'User stopped the run.', severity: 'warning' }),
    }, ctx);
    assert.equal(added.feedback.status, 'pending');
    assert.equal(added.dialogState.pending, 1);
    const listed = await runTool(getTool(tools, 'coding_v15_hooks_dialog'), { action: 'list' }, ctx);
    assert.equal(listed.dialogState.pending, 1);
    assert.ok(listed.summary.includes('Hooks dialog'));
    const confirmed = await runTool(getTool(tools, 'coding_v15_hooks_dialog'), {
      action: 'confirm', feedbackId: added.feedback.id, note: 'Seen.',
    }, ctx);
    assert.equal(confirmed.feedback.status, 'confirmed');
    assert.equal(confirmed.dialogState.pending, 0);
    const badAction = await getTool(tools, 'coding_v15_hooks_dialog').execute({ action: 'explode' }, ctx);
    assert.ok(badAction.startsWith('Error:'));
    // Verify: correct → 9/9; wrong → 0/9.
    const verifyGood = await runTool(getTool(tools, 'coding_v15_verify'), { runId: 'v-good' }, ctx);
    assert.equal(verifyGood.report.passed, 9);
    assert.equal(verifyGood.report.total, 9);
    const verifyBad = await runTool(getTool(tools, 'coding_v15_verify'), { runId: 'v-bad', useWrongOutcomes: true }, ctx);
    assert.equal(verifyBad.report.passed, 0);
    const verifyOne = await runTool(getTool(tools, 'coding_v15_verify'), { runId: 'v-one', scenarioIds: 'v15-tool-error' }, ctx);
    assert.equal(verifyOne.report.total, 1);
    assert.equal(verifyOne.report.passed, 1);
    // Agent: scripted run với profile reviewer + file thật + stop-hook feedback vào dialog.
    const agent = await runTool(getTool(tools, 'coding_v15_agent'), {
      runId: 'agent-t1',
      prompt: 'Review the change',
      profileId: 'v15-fixer',
      stepsJson: JSON.stringify([
        { text: 'Editing.', toolCalls: [{ tool: 'edit_file', args: { path: 'a.txt' }, status: 'ok', fileChange: { path: 'a.txt', kind: 'create', afterContent: 'hello' } }], done: false, inputTokens: 40, outputTokens: 10 },
        { text: 'Done.', toolCalls: [], done: true, inputTokens: 5, outputTokens: 5, stopHookFeedback: { source: 'stop-hook', title: 'Stopped', body: 'Done.', severity: 'info' } },
      ]),
      capJson: JSON.stringify({ maxTokens: 1000 }),
    }, ctx);
    assert.equal(agent.result.stepsExecuted, 2);
    assert.equal(agent.result.done, true);
    assert.equal(agent.result.profileId, 'v15-fixer');
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'hello');
    assert.equal(agent.result.hooksDialog.pending, 1);
    assert.equal(agent.result.budget.state.totalTokens, 60);
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('i18n: 65 key codingV15.* có đủ 6 locale, giá trị không rỗng, key set khớp nhau', () => {
  assert.equal(CODING_V15_KEYS.length, 65);
  const perLocale = {};
  for (const loc of LOCALE_NAMES) {
    const data = loadLocale(loc);
    perLocale[loc] = new Set(Object.keys(data).filter((k) => k.startsWith('codingV15.')));
    assert.equal(perLocale[loc].size, 65, `${loc}: thiếu/thừa key codingV15.*`);
    for (const key of CODING_V15_KEYS) {
      assert.ok(key in data, `${loc} thiếu key ${key}`);
      assert.equal(typeof data[key], 'string');
      assert.ok(data[key].trim().length > 0, `${loc}.${key} rỗng`);
    }
  }
  for (const loc of LOCALE_NAMES.slice(1)) {
    assert.deepEqual([...perLocale[loc]].sort(), [...perLocale.en].sort(), `key set ${loc} khác en`);
  }
  // Không hard-code tiếng Việt trong renderer cho v15: mọi key đều qua locale.
  assert.ok(loadLocale('vi')['codingV15.title'].includes('v15'));
  assert.ok(loadLocale('en')['codingV15.budgetReportOnly'].includes('never stops a run'));
});
