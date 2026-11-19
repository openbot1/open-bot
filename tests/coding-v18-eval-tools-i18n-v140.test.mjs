/**
 * Tests cho coding agent v18 — eval harness 3 verifier + tools +
 * i18n + agent end-to-end (v1.40, Đội T4).
 *
 * Chạy thật: 3 verifier trên cùng task, so sánh + determinism, tools
 * thật trên tmpdir, i18n 6 locale, agent scripted thật. Không gọi
 * model/mạng, không cần bwrap.
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   npm run build --workspace=@open-bot/tools (scoped, trong worktree)
 *   node --test tests/coding-v18-eval-tools-i18n-v140.test.mjs
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
  CODING_V18_TOOLS,
  CODING_V18_TOOL_NAMES,
  createCodingV18Tools,
  createDefaultTools,
  isCodingV18ToolName,
} from '../packages/tools/dist/index.js';
import {
  V18_VERIFIERS,
  renderV18EvalComparison,
  renderV18EvalSuiteReport,
  runV18Agent,
  v18BuildDiffText,
  v18ComparisonsAgree,
  v18RunEvalComparison,
  v18RunEvalSuite,
  v18RunVerifier,
  v18RunVerifierCritic,
  v18RunVerifierDepMap,
  v18RunVerifierReview,
  v18VerifierPassRates,
} from '../packages/core/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CODING_V18_KEYS = [
  'codingV18.agent',
  'codingV18.blocked',
  'codingV18.config',
  'codingV18.critic',
  'codingV18.criticApproved',
  'codingV18.criticBlocked',
  'codingV18.criticHistory',
  'codingV18.criticScore',
  'codingV18.depmap',
  'codingV18.depmapCycles',
  'codingV18.depmapTopo',
  'codingV18.eval',
  'codingV18.evalCompare',
  'codingV18.evalFailed',
  'codingV18.evalPassed',
  'codingV18.history',
  'codingV18.ownership',
  'codingV18.prReview',
  'codingV18.pushBlocked',
  'codingV18.review',
  'codingV18.reviewFailed',
  'codingV18.reviewPassed',
  'codingV18.settings',
  'codingV18.threshold',
  'codingV18.title',
  'codingV18.trajectory',
  'codingV18.verify',
  'codingV18.zoneConflict',
  'codingV18.zones',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function tmpDir(prefix = 'open-bot-v18-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Bỏ qua lỗi dọn dẹp.
  }
}

function getTool(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} phải tồn tại`);
  return tool;
}

function testCtx(workspaceDir) {
  return { workspaceDir };
}

function goodSteps() {
  return [
    { kind: 'prompt', text: 'Thêm tính năng X' },
    { kind: 'plan', text: 'Viết code + test', files: ['packages/core/src/a.ts'] },
    { kind: 'file_write', text: 'export function a() {\n return 1;\n}\n', files: ['packages/core/src/a.ts'] },
    { kind: 'file_write', text: 'test a\n', files: ['tests/a.test.mjs'] },
    { kind: 'test', text: 'chạy test', files: ['tests/a.test.mjs'] },
    { kind: 'test_result', text: 'pass', passed: true },
  ];
}

function goodPatch() {
  return {
    'packages/core/src/a.ts': 'export function a() {\n return 1;\n}\n',
    'tests/a.test.mjs': 'test a\n',
  };
}

function goodRepo() {
  return new Map([
    ['packages/core/src/a.ts', "import { b } from './b';\nexport const a = 1;\n"],
    ['packages/core/src/b.ts', 'export const b = 1;\n'],
    ['packages/core/src/c.ts', "import { a } from './a';\nexport const c = 1;\n"],
  ]);
}

test('eval: 3 verifier trên task tốt — cả 3 PASS', () => {
  const comparison = v18RunEvalComparison({
    taskId: 'task-good',
    steps: goodSteps(),
    patch: goodPatch(),
    repoFiles: goodRepo(),
    plannedFiles: ['packages/core/src/a.ts', 'tests/a.test.mjs'],
    now: 1000,
  });
  assert.equal(comparison.taskId, 'task-good');
  assert.equal(comparison.allPassed, true);
  assert.equal(comparison.passedCount, 3);
  assert.deepEqual(comparison.failedVerifiers, []);
  assert.deepEqual(comparison.results.map((r) => r.verifier), ['critic', 'review-skill', 'dependency-map']);
  assert.ok(comparison.results.every((r) => r.passed));
  assert.equal(comparison.results.find((r) => r.verifier === 'critic')?.score, 100);
  assert.match(comparison.summary, /3\/3 verifier pass/);
  const text = renderV18EvalComparison(comparison);
  assert.match(text, /\[critic\] PASS/);
  assert.match(text, /\[review-skill\] PASS/);
  assert.match(text, /\[dependency-map\] PASS/);
});

test('eval: task xấu — critic + review FAIL, dependency-map vẫn PASS, so sánh chỉ rõ từng verifier', () => {
  const badSteps = [
    { kind: 'prompt', text: 'task' },
    { kind: 'file_write', text: 'const api_key = "abcdefghijklmnop123456";\n', files: ['packages/core/src/a.ts'] },
    { kind: 'compiler_error', text: 'Type error' },
  ];
  const comparison = v18RunEvalComparison({
    taskId: 'task-bad',
    steps: badSteps,
    patch: { 'packages/core/src/a.ts': 'const api_key = "abcdefghijklmnop123456";\n' },
    repoFiles: goodRepo(),
    plannedFiles: ['packages/core/src/a.ts', 'packages/core/src/b.ts'],
    now: 1000,
  });
  assert.equal(comparison.allPassed, false);
  assert.deepEqual(comparison.failedVerifiers, ['critic', 'review-skill']);
  assert.equal(comparison.results.find((r) => r.verifier === 'dependency-map')?.passed, true);
  assert.match(comparison.summary, /1\/3 verifier pass/);
});

test('eval: dependency-map checker bắt cycle mới do patch tạo ra', () => {
  const cyclicPatch = {
    'packages/core/src/a.ts': "import { c } from './c';\nexport const a = 1;\n",
  };
  const comparison = v18RunEvalComparison({
    taskId: 'task-cycle',
    patch: cyclicPatch,
    repoFiles: goodRepo(),
    plannedFiles: ['packages/core/src/a.ts'],
    now: 1000,
  });
  const depmap = comparison.results.find((r) => r.verifier === 'dependency-map');
  assert.equal(depmap.passed, false, 'patch tạo cycle a->c->a phải fail');
  assert.ok(depmap.findings.some((f) => f.includes('cycle mới')));
});

test('eval: không có repo files thì dependency-map checker bỏ qua (pass)', () => {
  const result = v18RunVerifierDepMap({ taskId: 't', patch: goodPatch(), now: 1000 });
  assert.equal(result.passed, true);
  assert.match(result.details, /bỏ qua/);
});

test('eval: chạy 2 lần đồng nhất (determinism) + verifier chạy lẻ', () => {
  const input = {
    taskId: 'task-det',
    steps: goodSteps(),
    patch: goodPatch(),
    repoFiles: goodRepo(),
    plannedFiles: ['packages/core/src/a.ts', 'tests/a.test.mjs'],
    now: 1000,
  };
  const first = v18RunEvalComparison(input);
  const second = v18RunEvalComparison(input);
  assert.equal(v18ComparisonsAgree(first, second), true);
  const changed = { ...second, results: second.results.map((r) => (r.verifier === 'critic' ? { ...r, passed: false } : r)) };
  assert.equal(v18ComparisonsAgree(first, changed), false);
  assert.deepEqual(V18_VERIFIERS, ['critic', 'review-skill', 'dependency-map']);
  assert.equal(v18RunVerifier('critic', input).verifier, 'critic');
  assert.equal(v18RunVerifierCritic(input).passed, true);
  assert.equal(v18RunVerifierReview(input).passed, true);
  assert.equal(v18RunVerifierDepMap(input).passed, true);
  assert.ok(v18BuildDiffText({ 'a.ts': 'x\ny' }).includes('--- a/a.ts'));
});

test('agent: phiên tốt presentable; phiên xấu bị chặn push', () => {
  const good = runV18Agent({
    sessionId: 'agent-good',
    task: 'Thêm tính năng X',
    botId: 'bot-1',
    steps: [
      { text: 'Viết code', fileWrite: { path: 'packages/core/src/a.ts', content: 'export function a() {\n return 1;\n}\n', kind: 'create' } },
      { text: 'Viết test', fileWrite: { path: 'tests/a.test.mjs', content: 'test a\n', kind: 'create' }, isTest: true },
    ],
    repoFiles: goodRepo(),
    now: 1000,
  });
  assert.equal(good.presentable, true);
  assert.equal(good.verification.allPassed, true);
  assert.equal(good.critic.verdict, 'approve');
  assert.equal(good.review.verdict, 'pass');
  assert.deepEqual(good.depConflicts, []);

  const bad = runV18Agent({
    sessionId: 'agent-bad',
    task: 'Task xấu',
    botId: 'bot-1',
    steps: [
      { text: 'Viết code lộ secret', fileWrite: { path: 'packages/core/src/a.ts', content: 'const api_key = "abcdefghijklmnop123456";\n', kind: 'create' } },
    ],
    repoFiles: goodRepo(),
    now: 1001,
  });
  assert.equal(bad.presentable, false);
  assert.equal(bad.verification.blockedPush, true);
  assert.ok(bad.verification.failingLayers.includes('review-skill'));
});

test('agent: step không hợp lệ bị từ chối', () => {
  assert.throws(
    () => runV18Agent({ sessionId: 'x', task: 't', botId: 'b', steps: [{ text: '' }] }),
    /step\.text không được rỗng/,
  );
  assert.throws(
    () => runV18Agent({ sessionId: '', task: 't', botId: 'b', steps: [] }),
    /sessionId không được rỗng/,
  );
});

test('tools: 8 tool v18 trong ALL_TOOLS, không trùng tên, bind thay thế đúng chỗ', () => {
  assert.equal(CODING_V18_TOOL_NAMES.length, 8);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'ALL_TOOLS không được trùng tên');
  for (const name of CODING_V18_TOOL_NAMES) {
    assert.ok(names.includes(name), `ALL_TOOLS thiếu ${name}`);
    assert.equal(isCodingV18ToolName(name), true);
  }
  assert.equal(isCodingV18ToolName('coding_v17_critic'), false);
  const base = tmpDir('open-bot-v18-tools-');
  try {
    const bound = createDefaultTools({ getCodingV18BaseDir: () => base });
    const boundNames = bound.map((t) => t.definition.name);
    assert.equal(new Set(boundNames).size, boundNames.length, 'bound tools không trùng tên');
    const idxAll = ALL_TOOLS.findIndex((t) => t.definition.name === 'coding_v18_critic');
    const idxBound = bound.findIndex((t) => t.definition.name === 'coding_v18_critic');
    assert.equal(idxBound, idxAll, 'bind thay thế đúng chỗ, không đổi thứ tự');
  } finally {
    cleanup(base);
  }
});

test('tools: critic + review + config chạy thật trên tmpdir', async () => {
  const base = tmpDir('open-bot-v18-tools-');
  const ctx = testCtx(base);
  try {
    const tools = createCodingV18Tools(() => base);
    const critic = getTool(tools, 'coding_v18_critic');
    const scored = await critic.execute({
      action: 'score-trajectory',
      sessionId: 's1',
      stepsJson: JSON.stringify(goodSteps()),
      plannedFilesJson: JSON.stringify(['packages/core/src/a.ts', 'tests/a.test.mjs']),
    }, ctx);
    assert.match(scored, /100\/100 — APPROVE/);
    const history = await critic.execute({ action: 'history' }, ctx);
    assert.match(history, /1 lần chấm/);
    const stats = await critic.execute({ action: 'stats' }, ctx);
    assert.match(stats, /điểm trung bình 100/);
    const badAction = await critic.execute({ action: 'nope' }, ctx);
    assert.match(badAction, /Error: Unknown action/);

    const review = getTool(tools, 'coding_v18_review');
    const clean = await review.execute({
      action: 'review',
      patchJson: JSON.stringify(goodPatch()),
    }, ctx);
    assert.match(clean, /PASS/);
    const prFail = await review.execute({
      action: 'pr',
      patchJson: JSON.stringify({ 'packages/core/src/a.ts': 'const api_key = "abcdefghijklmnop123456";\n' }),
    }, ctx);
    assert.match(prFail, /Gate PR: FAIL/);

    const config = getTool(tools, 'coding_v18_config');
    const before = await config.execute({ action: 'get' }, ctx);
    assert.match(before, /approve >= 70, block < 40/);
    const set = await config.execute({
      action: 'set',
      criticConfigJson: JSON.stringify({ approveScore: 80, blockScore: 50 }),
      disabledReviewRulesJson: JSON.stringify(['todo-without-owner']),
    }, ctx);
    assert.match(set, /approve >= 80, block < 50/);
    const after = await config.execute({ action: 'get' }, ctx);
    assert.match(after, /todo-without-owner/);
    const badConfig = await config.execute({
      action: 'set',
      criticConfigJson: JSON.stringify({ approveScore: 50, blockScore: 50 }),
    }, ctx);
    assert.match(badConfig, /Error:/);
  } finally {
    cleanup(base);
  }
});

test('tools: depmap + zones + eval + verify + agent chạy thật trên tmpdir', async () => {
  const base = tmpDir('open-bot-v18-tools-');
  const ctx = testCtx(base);
  try {
    const tools = createCodingV18Tools(() => base);
    const repoObj = Object.fromEntries(goodRepo());
    const depmap = getTool(tools, 'coding_v18_depmap');
    const built = await depmap.execute({ root: 'repo', action: 'build', filesJson: JSON.stringify(repoObj) }, ctx);
    assert.match(built, /3 files, 2 edges, 0 cycles/);
    const queried = await depmap.execute({ root: 'repo', action: 'query', query: 'packages/core/src/a.ts' }, ctx);
    assert.match(queried, /import: packages\/core\/src\/b\.ts/);
    assert.match(queried, /được import bởi: packages\/core\/src\/c\.ts/);
    const topo = await depmap.execute({ root: 'repo', action: 'topo' }, ctx);
    assert.match(topo, /Topo order: 3 files, 3 tầng/);
    const cycles = await depmap.execute({ root: 'repo', action: 'cycles' }, ctx);
    assert.match(cycles, /không có cycle/);
    const missing = await depmap.execute({ root: 'ghost', action: 'topo' }, ctx);
    assert.match(missing, /Error: Chưa có dependency map/);

    const zones = getTool(tools, 'coding_v18_zones');
    const listed = await zones.execute({ root: 'repo', action: 'list' }, ctx);
    assert.match(listed, /Ownership zones: 6 vùng/);
    const conflict = await zones.execute({
      root: 'repo',
      action: 'check',
      filesJson: JSON.stringify(['packages/core/src/a.ts']),
      agentZone: 'tools',
    }, ctx);
    assert.match(conflict, /1 xung đột/);
    assert.match(conflict, /cross-zone/);

    const evalTool = getTool(tools, 'coding_v18_eval');
    const compared = await evalTool.execute({
      taskId: 'task-good',
      patchJson: JSON.stringify(goodPatch()),
      stepsJson: JSON.stringify(goodSteps()),
      repoFilesJson: JSON.stringify(repoObj),
      plannedFilesJson: JSON.stringify(['packages/core/src/a.ts', 'tests/a.test.mjs']),
    }, ctx);
    assert.match(compared, /3\/3 verifier pass/);

    const verify = getTool(tools, 'coding_v18_verify');
    const verified = await verify.execute({
      sessionId: 's-verify',
      patchJson: JSON.stringify(goodPatch()),
      stepsJson: JSON.stringify(goodSteps()),
      repoFilesJson: JSON.stringify(repoObj),
      plannedFilesJson: JSON.stringify(['packages/core/src/a.ts', 'tests/a.test.mjs']),
    }, ctx);
    assert.match(verified, /ALL PASSED — presentable/);

    const agent = getTool(tools, 'coding_v18_agent');
    const ran = await agent.execute({
      sessionId: 'agent-tool',
      task: 'Thêm tính năng X',
      botId: 'bot-1',
      stepsJson: JSON.stringify([
        { text: 'Viết code', fileWrite: { path: 'packages/core/src/a.ts', content: 'export function a() {\n return 1;\n}\n', kind: 'create' } },
        { text: 'Viết test', fileWrite: { path: 'tests/a.test.mjs', content: 'test a\n', kind: 'create' }, isTest: true },
      ]),
      repoFilesJson: JSON.stringify(repoObj),
    }, ctx);
    assert.match(ran, /PRESENTABLE/);
    const historyAfter = await getTool(tools, 'coding_v18_critic').execute({ action: 'history' }, ctx);
    assert.match(historyAfter, /agent-tool/);
  } finally {
    cleanup(base);
  }
});

test('i18n: đủ 29 key codingV18, bằng nhau 6 locale, sort giữ nguyên, >= baseline', () => {
  const locales = LOCALE_NAMES.map((name) => loadLocale(name));
  const baseline = 8322 + CODING_V18_KEYS.length;
  for (const [idx, name] of LOCALE_NAMES.entries()) {
    const locale = locales[idx];
    assert.ok(Object.keys(locale).length >= baseline, `${name} phải có >= ${baseline} keys (đã gộp: ${Object.keys(locale).length})`);
    for (const key of CODING_V18_KEYS) {
      assert.equal(typeof locale[key], 'string', `${name} thiếu ${key}`);
      assert.ok(locale[key].length > 0, `${name}.${key} không được rỗng`);
    }
    const keys = Object.keys(locale);
    assert.deepEqual(keys, [...keys].sort(), `${name} keys phải sort`);
  }
  // Bằng nhau 6 locale: cùng tập key.
  const keySets = locales.map((l) => Object.keys(l).join('\n'));
  for (const other of keySets.slice(1)) assert.equal(other, keySets[0]);
  assert.ok(CODING_V18_KEYS.includes('codingV18.criticHistory'));
  assert.ok(CODING_V18_KEYS.includes('codingV18.zoneConflict'));
  assert.ok(CODING_V18_KEYS.includes('codingV18.evalCompare'));
});

test('eval suite: nhiều task — tổng hợp tỉ lệ pass từng verifier + task tệ nhất', () => {
  const badSteps = [
    { kind: 'prompt', text: 'task' },
    { kind: 'file_write', text: 'const api_key = "abcdefghijklmnop123456";\n', files: ['packages/core/src/a.ts'] },
    { kind: 'compiler_error', text: 'Type error' },
  ];
  const suite = v18RunEvalSuite([
    {
      taskId: 'task-good',
      steps: goodSteps(),
      patch: goodPatch(),
      repoFiles: goodRepo(),
      plannedFiles: ['packages/core/src/a.ts', 'tests/a.test.mjs'],
      now: 1000,
    },
    {
      taskId: 'task-bad',
      steps: badSteps,
      patch: { 'packages/core/src/a.ts': 'const api_key = "abcdefghijklmnop123456";\n' },
      repoFiles: goodRepo(),
      plannedFiles: ['packages/core/src/a.ts', 'packages/core/src/b.ts'],
      now: 1000,
    },
  ], { now: 1000 });
  assert.equal(suite.totalTasks, 2);
  assert.equal(suite.passedTasks, 1);
  assert.equal(suite.allPassed, false);
  assert.equal(suite.worstTaskId, 'task-bad');
  assert.deepEqual(suite.verifierPassRates, { critic: 0.5, 'review-skill': 0.5, 'dependency-map': 1 });
  assert.match(suite.summary, /1\/2 task pass/);
  assert.match(suite.summary, /Verifier yếu nhất: critic/);
  const text = renderV18EvalSuiteReport(suite);
  assert.match(text, /task-good: 3\/3 verifier pass/);
  assert.match(text, /task-bad: 1\/3 verifier pass/);
  assert.deepEqual(v18VerifierPassRates([]), { critic: 0, 'review-skill': 0, 'dependency-map': 0 });
  assert.throws(() => v18RunEvalSuite([]), /ít nhất 1 task/);
  assert.throws(
    () => v18RunEvalSuite([
      { taskId: 'dup', patch: goodPatch(), now: 1000 },
      { taskId: 'dup', patch: goodPatch(), now: 1000 },
    ]),
    /taskId trùng/,
  );
});

test('tools: eval suite + critic trend + depmap impact chạy thật trên tmpdir', async () => {
  const base = tmpDir('open-bot-v18-tools-');
  const ctx = testCtx(base);
  try {
    const tools = createCodingV18Tools(() => base);
    const repoObj = Object.fromEntries(goodRepo());
    const evalTool = getTool(tools, 'coding_v18_eval');
    const suite = await evalTool.execute({
      action: 'suite',
      tasksJson: JSON.stringify([
        {
          taskId: 'task-good',
          patchJson: JSON.stringify(goodPatch()),
          stepsJson: JSON.stringify(goodSteps()),
          repoFilesJson: JSON.stringify(repoObj),
          plannedFilesJson: JSON.stringify(['packages/core/src/a.ts', 'tests/a.test.mjs']),
        },
        {
          taskId: 'task-bad',
          patchJson: JSON.stringify({ 'packages/core/src/a.ts': 'const api_key = "abcdefghijklmnop123456";\n' }),
          repoFilesJson: JSON.stringify(repoObj),
        },
      ]),
    }, ctx);
    assert.match(suite, /Eval suite v18: 1\/2 task pass/);
    assert.match(suite, /task-bad/);
    const badSuite = await evalTool.execute({ action: 'suite', tasksJson: '[]' }, ctx);
    assert.match(badSuite, /Error:/);
    const badAction = await evalTool.execute({ action: 'nope', taskId: 'x', patchJson: '{}' }, ctx);
    assert.match(badAction, /Error: Unknown action/);

    const critic = getTool(tools, 'coding_v18_critic');
    await critic.execute({
      action: 'score-trajectory',
      sessionId: 's-trend',
      stepsJson: JSON.stringify(goodSteps()),
      plannedFilesJson: JSON.stringify(['packages/core/src/a.ts', 'tests/a.test.mjs']),
    }, ctx);
    const trend = await critic.execute({ action: 'trend' }, ctx);
    assert.match(trend, /Trend critic v18 \(1 lần chấm\)/);
    assert.match(trend, /ỔN ĐỊNH/);

    const depmap = getTool(tools, 'coding_v18_depmap');
    await depmap.execute({ root: 'repo', action: 'build', filesJson: JSON.stringify(repoObj) }, ctx);
    const impact = await depmap.execute({
      root: 'repo',
      action: 'impact',
      filesJson: JSON.stringify(['packages/core/src/b.ts']),
    }, ctx);
    assert.match(impact, /ảnh hưởng tới 3 files/);
    assert.match(impact, /packages\/core\/src\/c\.ts/);
  } finally {
    cleanup(base);
  }
});

test('tools: review autofix + depmap orphans/stats + config preset chạy thật trên tmpdir', async () => {
  const base = tmpDir('open-bot-v18-tools-');
  const ctx = testCtx(base);
  try {
    const tools = createCodingV18Tools(() => base);
    const review = getTool(tools, 'coding_v18_review');
    const fixed = await review.execute({
      action: 'autofix',
      patchJson: JSON.stringify({
        'src/a.ts': 'export const a = 1;',
        'src/b.ts': 'export function b() {\n console.log("hi");\n return 1;\n}\n',
      }),
    }, ctx);
    assert.match(fixed, /áp được 2 fix/);
    assert.match(fixed, /export const a = 1;\\n/);
    assert.doesNotMatch(fixed, /console\.log\("hi"\)/);

    const repoObj = Object.fromEntries(goodRepo());
    const depmap = getTool(tools, 'coding_v18_depmap');
    await depmap.execute({ root: 'repo', action: 'build', filesJson: JSON.stringify(repoObj) }, ctx);
    const orphans = await depmap.execute({ root: 'repo', action: 'orphans' }, ctx);
    assert.match(orphans, /1 orphan/);
    assert.match(orphans, /packages\/core\/src\/c\.ts/);
    const stats = await depmap.execute({ root: 'repo', action: 'stats' }, ctx);
    assert.match(stats, /3 files, 2 edges, 0 cycles/);

    const config = getTool(tools, 'coding_v18_config');
    const setPreset = await config.execute({ action: 'set', preset: 'strict' }, ctx);
    assert.match(setPreset, /approve >= 90, block < 60/);
    const badPreset = await config.execute({ action: 'set', preset: 'nope' }, ctx);
    assert.match(badPreset, /Error: Không có critic preset/);
  } finally {
    cleanup(base);
  }
});
