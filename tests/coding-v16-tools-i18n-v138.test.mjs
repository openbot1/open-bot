/**
 * Tests cho coding agent v16 tools + i18n (v1.38, Đội T4).
 *
 * Chạy thật: tool execute thật trên thư mục tạm (budgets.json /
 * costs.json + workspace file thật), không gọi model/mạng; i18n là
 * JSON thuần (không cần build).
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   npm run build --workspace=@open-bot/tools (scoped, trong worktree)
 *   node --test tests/coding-v16-tools-i18n-v138.test.mjs
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
  CODING_V16_TOOLS,
  CODING_V16_TOOL_NAMES,
  createCodingV16Tools,
  createDefaultTools,
  isCodingV16ToolName,
} from '../packages/tools/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CODING_V16_KEYS = [
  'codingV16.accuracy',
  'codingV16.agent',
  'codingV16.benchmark',
  'codingV16.benchmarkRun',
  'codingV16.budget',
  'codingV16.budgetExceeded',
  'codingV16.budgetRemaining',
  'codingV16.budgetWarning',
  'codingV16.cost',
  'codingV16.costAccuracy',
  'codingV16.costPerTask',
  'codingV16.efficiency',
  'codingV16.fileWindow',
  'codingV16.fileWindowPage',
  'codingV16.harness',
  'codingV16.harnessCompare',
  'codingV16.lintBlocked',
  'codingV16.lintGate',
  'codingV16.lintPassed',
  'codingV16.minimal',
  'codingV16.minimalMode',
  'codingV16.preamble',
  'codingV16.report',
  'codingV16.score',
  'codingV16.settings',
  'codingV16.title',
  'codingV16.tokensSaved',
  'codingV16.tokensUsed',
  'codingV16.trim',
  'codingV16.trimHistory',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v16-tools-'));
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

test('i18n: 30 key codingV16.* có đủ 6 locale, giá trị không rỗng, tổng 8072', () => {
  assert.equal(CODING_V16_KEYS.length, 30);
  for (const locale of LOCALE_NAMES) {
    const data = loadLocale(locale);
    assert.ok(Object.keys(data).length >= 8072, `${locale} total keys`);
    for (const key of CODING_V16_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} missing`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} empty`);
    }
  }
  // Key sets giống hệt nhau giữa các locale.
  const sets = LOCALE_NAMES.map((loc) => Object.keys(loadLocale(loc)).sort().join('\n'));
  for (const s of sets.slice(1)) assert.equal(s, sets[0]);
});

test('tools registry: 7 coding v16 tools in ALL_TOOLS, no duplicates, bound replace works', () => {
  assert.equal(CODING_V16_TOOLS.length, 7);
  assert.deepEqual([...CODING_V16_TOOL_NAMES], [
    'coding_v16_budget',
    'coding_v16_cost',
    'coding_v16_minimal',
    'coding_v16_file_window',
    'coding_v16_lint_edit',
    'coding_v16_trim',
    'coding_v16_benchmark',
  ]);
  assert.equal(isCodingV16ToolName('coding_v16_budget'), true);
  assert.equal(isCodingV16ToolName('coding_v14_budget'), false);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'ALL_TOOLS has duplicate names');
  for (const name of CODING_V16_TOOL_NAMES) {
    assert.ok(names.includes(name), `ALL_TOOLS missing ${name}`);
  }
  // createDefaultTools không bind: vẫn 7 placeholder, không trùng.
  const defaults = createDefaultTools();
  const defaultNames = defaults.map((t) => t.definition.name);
  assert.equal(new Set(defaultNames).size, defaultNames.length);
  for (const name of CODING_V16_TOOL_NAMES) {
    assert.equal(defaultNames.filter((n) => n === name).length, 1, `${name} must appear exactly once`);
  }
  // Bound tools replace-in-place: vẫn đúng 7 tên, không trùng.
  const base = tmpDir();
  try {
    const bound = createDefaultTools({ getCodingV16BaseDir: () => base });
    const boundNames = bound.map((t) => t.definition.name);
    assert.equal(new Set(boundNames).size, boundNames.length);
    for (const name of CODING_V16_TOOL_NAMES) {
      assert.equal(boundNames.filter((n) => n === name).length, 1, `${name} must appear exactly once after bind`);
    }
  } finally {
    cleanup(base);
  }
});

test('tool budget: set + record + status + list, persists to budgets.json', async () => {
  const base = tmpDir();
  const ws = tmpDir();
  try {
    const tools = createCodingV16Tools(() => base);
    const ctx = { workspaceDir: ws };
    const budget = getTool(tools, 'coding_v16_budget');
    const set = await runTool(budget, { action: 'set', budgetId: 't1', limitTokens: 1000 }, ctx);
    assert.equal(set.budget.id, 't1');
    assert.equal(set.budget.limitTokens, 1000);
    const rec = await runTool(budget, { action: 'record', taskId: 't1', step: 1, kind: 'preamble', promptTokens: 829, completionTokens: 0, harness: 'minimal' }, ctx);
    assert.equal(rec.total.totalTokens, 829);
    assert.equal(rec.status.state, 'warn');
    assert.equal(rec.status.usedPercent, 82.9);
    const status = await runTool(budget, { action: 'status', budgetId: 't1', taskId: 't1' }, ctx);
    assert.equal(status.total.totalTokens, 829);
    assert.match(status.statusText, /WARN/);
    const list = await runTool(budget, { action: 'list' }, ctx);
    assert.equal(list.budgets.length, 1);
    assert.equal(list.sessionTotal.totalTokens, 829);
    // Persistence: mở lại meter khác vẫn thấy.
    const tools2 = createCodingV16Tools(() => base);
    const status2 = await runTool(getTool(tools2, 'coding_v16_budget'), { action: 'status', budgetId: 't1', taskId: 't1' }, ctx);
    assert.equal(status2.total.totalTokens, 829);
    assert.ok(fs.existsSync(path.join(base, 'coding-v16', 'budgets.json')));
    // Lỗi: action lạ, budget chưa đặt.
    const badAction = await budget.execute({ action: 'nope' }, ctx);
    assert.ok(badAction.startsWith('Error:'));
    const missing = await budget.execute({ action: 'status', budgetId: 'ghost' }, ctx);
    assert.ok(missing.startsWith('Error:'));
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('tool cost: record + compare + report, persists to costs.json', async () => {
  const base = tmpDir();
  const ws = tmpDir();
  try {
    const tools = createCodingV16Tools(() => base);
    const ctx = { workspaceDir: ws };
    const cost = getTool(tools, 'coding_v16_cost');
    await runTool(cost, { action: 'record', taskId: 't1', harnessId: 'minimal', model: 'claude-sonnet-4', score: 1, promptTokens: 1000, completionTokens: 500, steps: 5 }, ctx);
    await runTool(cost, { action: 'record', taskId: 't1', harnessId: 'claude-code', model: 'claude-sonnet-4', score: 1, promptTokens: 8000, completionTokens: 500, steps: 8 }, ctx);
    const cmp = await runTool(cost, { action: 'compare', harnessId: 'minimal' }, ctx);
    assert.equal(cmp.comparison.tasks, 1);
    assert.equal(cmp.comparison.passRate, 1);
    const report = await runTool(cost, { action: 'report' }, ctx);
    assert.equal(report.report.maxCostRatio, 3);
    assert.equal(report.report.cheapestPerPass, 'minimal');
    assert.match(report.summary, /buys tokens, not accuracy/);
    assert.ok(fs.existsSync(path.join(base, 'coding-v16', 'costs.json')));
    const bad = await cost.execute({ action: 'record', taskId: 't2', harnessId: 'minimal', model: 'm', score: 2, promptTokens: 0, completionTokens: 0, steps: 0 }, ctx);
    assert.ok(bad.startsWith('Error:'));
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('tool minimal: runs scripted steps, writes files, lint-blocks bad file', async () => {
  const base = tmpDir();
  const ws = tmpDir();
  try {
    const tools = createCodingV16Tools(() => base);
    const ctx = { workspaceDir: ws };
    const minimal = getTool(tools, 'coding_v16_minimal');
    const steps = [
      { text: 'Check.', bashCommand: 'npm test', bashOutput: 'pass', done: false },
      { text: 'Write.', done: false, fileWrite: { path: 'src/a.ts', kind: 'create', content: 'export const a = 1;\n' } },
      { text: 'Bad.', done: false, fileWrite: { path: 'src/b.ts', kind: 'create', content: 'const x = {;\n' } },
      { text: 'Done.', done: true },
    ];
    const out = await runTool(minimal, { runId: 'run-1', prompt: 'Fix it.', stepsJson: JSON.stringify(steps) }, ctx);
    assert.equal(out.report.done, true);
    assert.equal(out.report.lintBlocks, 1);
    assert.deepEqual(out.report.filesWritten, ['src/a.ts']);
    assert.equal(fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(fs.existsSync(path.join(ws, 'src', 'b.ts')), false);
    assert.ok(out.cost.costUsd > 0);
    assert.ok(fs.existsSync(path.join(base, 'coding-v16', 'budgets.json')));
    assert.ok(fs.existsSync(path.join(base, 'coding-v16', 'costs.json')));
    const bad = await minimal.execute({ runId: 'r', prompt: 'x', stepsJson: 'not json' }, ctx);
    assert.ok(bad.startsWith('Error:'));
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('tool file window: page/around/search on a real workspace file', async () => {
  const base = tmpDir();
  const ws = tmpDir();
  try {
    const content = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(ws, 'big.txt'), `${content}\n`, 'utf8');
    const tools = createCodingV16Tools(() => base);
    const ctx = { workspaceDir: ws };
    const fw = getTool(tools, 'coding_v16_file_window');
    const page2 = await runTool(fw, { filePath: 'big.txt', action: 'page', page: 2 }, ctx);
    assert.equal(page2.window.startLine, 101);
    assert.equal(page2.window.endLine, 200);
    const around = await runTool(fw, { filePath: 'big.txt', action: 'around', line: 150 }, ctx);
    assert.equal(around.window.page, 2);
    const search = await runTool(fw, { filePath: 'big.txt', action: 'search', query: 'line 15' }, ctx);
    assert.ok(search.hits.length >= 10);
    assert.equal(search.hits[0].line, 15);
    const missing = await fw.execute({ filePath: 'nope.txt' }, ctx);
    assert.ok(missing.startsWith('Error:'));
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('tool lint edit: blocks bad syntax, writes good content, dry run writes nothing', async () => {
  const base = tmpDir();
  const ws = tmpDir();
  try {
    const tools = createCodingV16Tools(() => base);
    const ctx = { workspaceDir: ws };
    const lintEdit = getTool(tools, 'coding_v16_lint_edit');
    const blocked = await runTool(lintEdit, { filePath: 'src/a.ts', content: 'const x = {;\n' }, ctx);
    assert.equal(blocked.written, false);
    assert.equal(blocked.lint.blocked, true);
    assert.equal(fs.existsSync(path.join(ws, 'src', 'a.ts')), false);
    const dry = await runTool(lintEdit, { filePath: 'src/a.ts', content: 'export const a = 1;\n', dryRun: true }, ctx);
    assert.equal(dry.written, false);
    assert.equal(dry.lint.blocked, false);
    assert.equal(fs.existsSync(path.join(ws, 'src', 'a.ts')), false);
    const ok = await runTool(lintEdit, { filePath: 'src/a.ts', content: 'export const a = 1;\n' }, ctx);
    assert.equal(ok.written, true);
    assert.equal(fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
    const badJson = await runTool(lintEdit, { filePath: 'cfg.json', content: '{"a": 1, "a": 2}' }, ctx);
    assert.equal(badJson.written, false);
    assert.ok(badJson.lint.issues.some((i) => i.code === 'json-duplicate-key'));
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('tool trim: trims history JSON, keeps pinned + recent tool outputs', async () => {
  const base = tmpDir();
  const ws = tmpDir();
  try {
    const tools = createCodingV16Tools(() => base);
    const ctx = { workspaceDir: ws };
    const trim = getTool(tools, 'coding_v16_trim');
    const entries = [
      { id: 'e0', role: 'system', text: 'You are an agent.', tokens: 5, seq: 0, at: 1000, pinned: true },
      { id: 'e1', role: 'user', text: 'Fix bug.', tokens: 3, seq: 1, at: 1001 },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `t${i}`, role: 'tool', text: `tool output ${i} `.repeat(20), tokens: 70, seq: 2 + i, at: 1002 + i, toolName: 'bash',
      })),
      { id: 'e10', role: 'model', text: 'Working on it.', tokens: 4, seq: 10, at: 1010 },
      { id: 'e11', role: 'user', text: 'Continue.', tokens: 3, seq: 11, at: 1011 },
    ];
    const out = await runTool(trim, { historyJson: JSON.stringify(entries), maxTokens: 100 }, ctx);
    assert.ok(out.result.trimmedEntries > 0);
    assert.ok(out.kept.some((e) => e.pinned));
    assert.ok(out.kept.filter((e) => e.role === 'tool').length <= 5);
    assert.ok(out.kept.some((e) => e.role === 'summary'));
    assert.ok(out.kept.some((e) => e.text === 'Continue.'));
    const bad = await trim.execute({ historyJson: 'not json' }, ctx);
    assert.ok(bad.startsWith('Error:'));
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});

test('tool benchmark: scripted tasks across harnesses, trade-off report', async () => {
  const base = tmpDir();
  const ws = tmpDir();
  try {
    const tools = createCodingV16Tools(() => base);
    const ctx = { workspaceDir: ws };
    const bench = getTool(tools, 'coding_v16_benchmark');
    const tasks = [
      {
        id: 'fix-auth',
        prompt: 'Fix auth bug.',
        expectedScore: 1,
        scripts: {
          minimal: [{ text: 'check', bashCommand: 'npm test', bashOutput: 'pass', done: false }, { text: 'done', done: true }],
          'claude-code': [
            { text: 'check', bashCommand: 'npm test', bashOutput: 'pass', done: false },
            { text: 'check again', bashCommand: 'npm test', bashOutput: 'pass', done: false },
            { text: 'done', done: true },
          ],
        },
      },
    ];
    const out = await runTool(bench, { tasksJson: JSON.stringify(tasks) }, ctx);
    assert.equal(out.report.taskIds.length, 1);
    assert.ok((out.report.costAccuracy.maxCostRatio ?? 0) > 2);
    assert.match(out.summary, /buys tokens, not accuracy/);
    assert.ok(fs.existsSync(path.join(base, 'coding-v16', 'costs.json')));
  } finally {
    cleanup(base);
    cleanup(ws);
  }
});
