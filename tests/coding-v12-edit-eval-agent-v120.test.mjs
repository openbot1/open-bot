/**
 * Tests cho coding agent v12 (v1.20, Đội T3 lần 3): edit strategy
 * diff/patch kiểu Aider v2 (atomic commit từng edit, verify sau mỗi
 * edit, rollback bằng revert), eval v3 (4 chiều: đúng file, test
 * pass, không regression, diff gọn), pipeline agent nối depgraph +
 * visualizer v2 + budget meters + ACP switch + edit strategy +
 * eval v3, và smoke test các module v12 đã có (depgraph, visualizer,
 * budget, ACP).
 *
 * Chạy thật (không mock git/node): git thật, `node` thật, file thật
 * trong thư mục tạm; eval chạy harness v12 thật trên repo tạm.
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v12-edit-eval-agent-v120.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  CodingAgentV12,
  V12AcpSession,
  V12ConversationBudgetMeter,
  V12EditCoordinator,
  V12EditStrategy,
  V12TaskVisualizer,
  compareV12EvalReports,
  loadV12EvalReport,
  renderV12AgentReport,
  runV12Agent,
  runV12EvalSuite,
  saveV12EvalReport,
  scriptedV12Agent,
  v12ApplyPatchBlocksToContent,
  v12BuildDepGraph,
  v12CountDiffLines,
  v12NewEditId,
  v12PlanOrderedEdits,
  v12ScoreDiffEconomy,
  v12ScoreEval,
  v12ScoreFileAccuracy,
  validateV12Edit,
  V12_EVAL_SAMPLE_TASKS,
} from '../packages/core/dist/codingV12/index.js';

/** Tạo repo git tạm với các file cho trước, trả đường dẫn. */
function mkRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v12-test-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'v12-test']);
  git(['config', 'user.email', 'v12-test@open-bot.local']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'fixture']);
  return dir;
}

function gitLog(dir) {
  return execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Không chặn test.
  }
}

/* ================================================================== */
/* Edit strategy v12                                                   */
/* ================================================================== */

test('v12 edit: patch format áp đúng 1 lần + commit riêng từng edit', async () => {
  const dir = mkRepo({ 'src/a.ts': 'export const x = 1;\n' });
  try {
    const strategy = new V12EditStrategy(dir);
    const res = await strategy.applyEdit({
      id: v12NewEditId(),
      file: 'src/a.ts',
      format: 'patch',
      blocks: [{ oldText: 'export const x = 1;', newText: 'export const x = 2;' }],
      summary: 'Đổi x thành 2',
    });
    assert.equal(res.ok, true);
    assert.ok(res.commitSha && res.commitSha.length >= 7);
    assert.equal(res.linesAdded, 1);
    assert.equal(res.linesRemoved, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8'), 'export const x = 2;\n');
    assert.equal(strategy.getHistory().length, 1);
    assert.equal(gitLog(dir).length, 2);
    assert.match(gitLog(dir)[0], /v12: Đổi x thành 2/);
  } finally {
    cleanup(dir);
  }
});

test('v12 edit: patch mơ hồ (khớp 2 lần) và không tìm thấy đều từ chối, không commit', async () => {
  const dir = mkRepo({ 'src/a.ts': 'const v = 1;\nconst v = 1;\n' });
  try {
    const strategy = new V12EditStrategy(dir);
    const ambiguous = await strategy.applyEdit({
      id: v12NewEditId(),
      file: 'src/a.ts',
      format: 'patch',
      blocks: [{ oldText: 'const v = 1;', newText: 'const v = 2;' }],
      summary: 'Mơ hồ',
    });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error, /nhiều lần/);
    const missing = await strategy.applyEdit({
      id: v12NewEditId(),
      file: 'src/a.ts',
      format: 'patch',
      blocks: [{ oldText: 'const khongCo = 9;', newText: 'const khongCo = 10;' }],
      summary: 'Không tìm thấy',
    });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /không tìm thấy/);
    assert.equal(strategy.getHistory().length, 0);
    assert.equal(gitLog(dir).length, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8'), 'const v = 1;\nconst v = 1;\n');
  } finally {
    cleanup(dir);
  }
});

test('v12 edit: diff format qua git apply + rollback bằng revert khôi phục nội dung', async () => {
  const dir = mkRepo({ 'src/a.ts': 'export const x = 1;\n', 'src/b.ts': 'export const y = 1;\n' });
  try {
    const strategy = new V12EditStrategy(dir);
    const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 42;\n';
    const res = await strategy.applyEdit({
      id: v12NewEditId(),
      file: 'src/a.ts',
      format: 'diff',
      diff,
      summary: 'Đổi x thành 42',
    });
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8'), 'export const x = 42;\n');
    const resB = await strategy.applyEdit({
      id: v12NewEditId(),
      file: 'src/b.ts',
      format: 'patch',
      blocks: [{ oldText: 'export const y = 1;', newText: 'export const y = 2;' }],
      summary: 'Đổi y thành 2',
    });
    assert.equal(resB.ok, true);
    // Rollback edit đầu (file khác với edit sau) phải thành công.
    const entry = strategy.getHistory()[0];
    const rolled = await strategy.rollbackEdit(entry.editId);
    assert.ok(rolled.rollbackSha);
    assert.equal(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8'), 'export const x = 1;\n');
    assert.equal(fs.readFileSync(path.join(dir, 'src/b.ts'), 'utf8'), 'export const y = 2;\n');
    // Rollback lần 2 phải throw.
    await assert.rejects(() => strategy.rollbackEdit(entry.editId), /đã rollback/);
    // Rollback edit không có phải throw edit-not-found.
    await assert.rejects(() => strategy.rollbackEdit('v12e-khongco'), /không có edit/);
  } finally {
    cleanup(dir);
  }
});

test('v12 edit: verify fail thì khôi phục file, không commit', async () => {
  const dir = mkRepo({ 'src/a.ts': 'export const x = 1;\n' });
  try {
    const strategy = new V12EditStrategy(dir, { verifyCommand: ['node', '-e', 'process.exit(1)'] });
    const res = await strategy.applyEdit({
      id: v12NewEditId(),
      file: 'src/a.ts',
      format: 'patch',
      blocks: [{ oldText: 'export const x = 1;', newText: 'export const x = 2;' }],
      summary: 'Verify fail',
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /verify thất bại/);
    assert.ok(res.verify && res.verify.ok === false);
    assert.equal(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8'), 'export const x = 1;\n');
    assert.equal(strategy.getHistory().length, 0);
    assert.equal(gitLog(dir).length, 1);
  } finally {
    cleanup(dir);
  }
});

test('v12 edit: validate + đếm dòng diff + áp block pure', () => {
  assert.throws(() => validateV12Edit({ id: 'x', file: '../evil.ts', format: 'patch', blocks: [{ oldText: 'a', newText: 'b' }], summary: 's' }), /không hợp lệ/);
  assert.throws(
    () =>
      validateV12Edit({
        id: 'x',
        file: 'src/a.ts',
        format: 'diff',
        diff: '--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-a\n+b\n',
        summary: 's',
      }),
    /khai file/,
  );
  const counts = v12CountDiffLines('--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-x\n+y\n+z\n');
  assert.deepEqual(counts, { added: 2, removed: 1 });
  const out = v12ApplyPatchBlocksToContent('a = 1;\nb = 2;\n', [{ oldText: 'a = 1;', newText: 'a = 10;' }]);
  assert.equal(out.content, 'a = 10;\nb = 2;\n');
  assert.throws(() => v12ApplyPatchBlocksToContent('a = 1;\na = 1;\n', [{ oldText: 'a = 1;', newText: 'a = 2;' }]), /nhiều lần/);
});

/* ================================================================== */
/* Eval v3                                                             */
/* ================================================================== */

test('v12 eval: chấm 4 chiều pure (đúng file, diff gọn, tổng + grade)', () => {
  assert.equal(v12ScoreFileAccuracy(['src/a.ts'], ['src/a.ts']), 1);
  assert.equal(v12ScoreFileAccuracy(['src/b.ts'], ['src/a.ts']), 0);
  assert.equal(v12ScoreFileAccuracy(['src/a.ts', 'src/b.ts'], ['src/a.ts']), 0);
  assert.equal(v12ScoreFileAccuracy(['src/a.ts'], ['src/a.ts'], ['src/a.ts']), 0);
  assert.equal(v12ScoreFileAccuracy([], ['src/a.ts']), 0);
  assert.equal(v12ScoreFileAccuracy(['src/a.ts'], []), 1);
  assert.equal(v12ScoreDiffEconomy(10, true), 1);
  assert.equal(v12ScoreDiffEconomy(0, false), 0);
  assert.ok(v12ScoreDiffEconomy(10000, true) >= 0.3 && v12ScoreDiffEconomy(10000, true) <= 0.31);
  const perfect = v12ScoreEval({ fileAccuracy: 1, testScore: 1, noRegression: 1, diffEconomy: 1 });
  assert.deepEqual([perfect.total, perfect.grade], [100, 'excellent']);
  const bad = v12ScoreEval({ fileAccuracy: 0, testScore: 0, noRegression: 0, diffEconomy: 0 });
  assert.deepEqual([bad.total, bad.grade], [0, 'poor']);
});

test('v12 eval: suite mẫu với scripted agent — 2/3 pass, điểm 4 chiều đầy đủ', async () => {
  const report = await runV12EvalSuite(V12_EVAL_SAMPLE_TASKS, scriptedV12Agent, { attemptsPerTask: 1 });
  assert.equal(report.tasks.length, 3);
  assert.equal(report.tasks.filter((t) => t.passed).length, 2);
  assert.ok(Math.abs(report.passRate - 2 / 3) < 1e-9);
  assert.ok(report.meanScore > 50 && report.meanScore <= 100);
  assert.deepEqual(report.flakyTasks, []);
  for (const t of report.tasks) {
    assert.ok(t.scores.total >= 0 && t.scores.total <= 100);
    assert.ok(['excellent', 'good', 'fair', 'poor'].includes(t.scores.grade));
    assert.equal(t.filesChanged.length, 1);
  }
  const addTask = report.tasks.find((t) => t.taskId === 'v12-sample-add');
  assert.equal(addTask.passed, true);
  assert.equal(addTask.scores.fileAccuracy, 1);
  assert.equal(addTask.scores.testScore, 1);
  const maxTask = report.tasks.find((t) => t.taskId === 'v12-sample-max');
  assert.equal(maxTask.passed, false);
  assert.ok(maxTask.scores.testScore < 1);
});

test('v12 eval: patch sửa sai file thì fileAccuracy = 0; lưu/đọc/so sánh báo cáo', async () => {
  const wrongFileAgent = () => ({ patch: '--- a/src/other.mjs\n+++ b/src/other.mjs\n@@ -1,2 +1,2 @@\n-export const other = 1;\n+export const other = 2;\n' });
  const task = {
    id: 'v12-wrong-file',
    title: 'Sửa sai file',
    files: {
      'src/a.mjs': 'export const a = 1;\n',
      'src/other.mjs': 'export const other = 1;\n',
      'test/a.test.mjs':
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.mjs';\ntest('a', () => { assert.equal(a, 2); });\n",
    },
    tests: [{ name: 'a', command: ['node', '--test', 'test/a.test.mjs'], kind: 'fail-to-pass' }],
    expectedFiles: ['src/a.mjs'],
  };
  const report = await runV12EvalSuite([task], wrongFileAgent, { attemptsPerTask: 1 });
  assert.equal(report.tasks[0].scores.fileAccuracy, 0);
  assert.equal(report.tasks[0].passed, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v12-eval-'));
  try {
    const file = saveV12EvalReport(dir, report);
    assert.ok(fs.existsSync(file));
    const loaded = loadV12EvalReport(dir, report.agentVersion);
    assert.equal(loaded.runId, report.runId);
    assert.equal(loadV12EvalReport(dir, 'khong-co-version'), null);
    const good = await runV12EvalSuite(V12_EVAL_SAMPLE_TASKS, scriptedV12Agent, { attemptsPerTask: 1, agentVersion: 'coding-v12-new' });
    const cmp = compareV12EvalReports(report, good);
    assert.equal(cmp.baselineVersion, report.agentVersion);
    assert.equal(cmp.currentVersion, 'coding-v12-new');
    assert.ok(cmp.scoreDelta > 0);
  } finally {
    cleanup(dir);
  }
});

/* ================================================================== */
/* Smoke: depgraph + visualizer + budget + ACP (module đã có)          */
/* ================================================================== */

test('v12 smoke: depgraph topo lá-trước + chu trình + coordinator chặn dependency', () => {
  const graph = v12BuildDepGraph({
    'src/root.ts': "import { mid } from './mid';\nexport const r = mid;\n",
    'src/mid.ts': "import { leaf } from './leaf';\nexport const mid = leaf;\n",
    'src/leaf.ts': 'export const leaf = 1;\n',
  });
  assert.deepEqual(graph.order, ['src/leaf.ts', 'src/mid.ts', 'src/root.ts']);
  assert.equal(graph.stats.leaves, 1);
  const cyclic = v12BuildDepGraph({
    'src/a.ts': "import { b } from './b';\n",
    'src/b.ts': "import { a } from './a';\n",
  });
  assert.equal(cyclic.stats.cycles, 1);
  const plan = v12PlanOrderedEdits(graph, { 'src/root.ts': 'sửa root', 'src/mid.ts': 'sửa mid', 'src/leaf.ts': 'sửa leaf' });
  assert.deepEqual(plan.edits.map((e) => e.file), ['src/leaf.ts', 'src/mid.ts', 'src/root.ts']);
  const coord = new V12EditCoordinator(plan);
  const midEdit = plan.edits.find((e) => e.file === 'src/mid.ts');
  assert.equal(coord.canStart(midEdit.id).ok, false);
  coord.start(plan.edits[0].id);
  coord.finish(plan.edits[0].id, 'done');
  assert.equal(coord.canStart(midEdit.id).ok, true);
  assert.equal(coord.summary().done, 1);
});

test('v12 smoke: visualizer v2 event + snapshot, budget meter cảnh báo, ACP switch giữ transcript', () => {
  const viz = new V12TaskVisualizer('Task demo');
  let events = 0;
  const off = viz.subscribe(() => {
    events += 1;
  });
  const child = viz.addTask('root', 'Edit e1', { editingFile: 'src/a.ts', model: 'm1' });
  viz.updateTask(child.id, { status: 'running', tokensUsed: 100, costUsdDelta: 0.01 });
  viz.updateTask(child.id, { status: 'done', progress: 100, finishedFile: 'src/a.ts' });
  const snap = viz.snapshot();
  assert.equal(snap.totalNodes, 2);
  assert.equal(snap.totalTokens, 100);
  assert.ok(events >= 3);
  off();

  const meter = new V12ConversationBudgetMeter('conv-1', 'unknown-model-xyz', { maxTokens: 100, maxSteps: 10 });
  meter.recordTokens(60, 0);
  assert.equal(meter.state().meters.find((m) => m.kind === 'tokens').warning, 'warn50');
  meter.recordTokens(50, 0);
  assert.equal(meter.state().anyExceeded, true);

  const session = new V12AcpSession('model-a', [
    { id: 'model-a', capabilities: [{ name: 'code-edit', enabled: true }] },
    { id: 'model-b', capabilities: [{ name: 'code-edit', enabled: true }, { name: 'vision', enabled: true }] },
  ]);
  session.addMessage('user', 'sửa file a');
  session.recordAssistantMessage('đã sửa xong');
  const res = session.switchModel('model-b', 'cần vision');
  assert.equal(res.record.toModelId, 'model-b');
  assert.equal(res.record.preservedMessages, 2);
  assert.deepEqual(res.record.capabilitiesAdded, ['vision']);
  assert.equal(session.currentModelId(), 'model-b');
  assert.equal(session.getTranscript().length, 2);
});

/* ================================================================== */
/* Agent v12 pipeline end-to-end                                       */
/* ================================================================== */

test('v12 agent: pipeline end-to-end — edit lá-trước, commit riêng từng edit, báo cáo đầy đủ', async () => {
  const dir = mkRepo({
    'src/leaf.ts': 'export const leaf = 1;\n',
    'src/mid.ts': "import { leaf } from './leaf';\nexport const mid = leaf;\n",
    'src/root.ts': "import { mid } from './mid';\nexport const root = mid;\n",
  });
  try {
    const provider = (ordered) => ({
      id: v12NewEditId(),
      file: ordered.file,
      format: 'patch',
      blocks: [{ oldText: 'export const ', newText: 'export const edited_' }],
      summary: `Sửa ${ordered.file}`,
    });
    const report = await runV12Agent({
      workingDir: dir,
      title: 'Pipeline demo',
      tasks: { 'src/leaf.ts': 'sửa leaf', 'src/mid.ts': 'sửa mid', 'src/root.ts': 'sửa root' },
      editProvider: provider,
      verifyCommand: ['node', '-e', 'process.exit(0)'],
    });
    assert.equal(report.ok, true, renderV12AgentReport(report));
    assert.deepEqual(report.editOrder, ['src/leaf.ts', 'src/mid.ts', 'src/root.ts']);
    assert.equal(report.editCommits.length, 3);
    assert.equal(report.steps.find((s) => s.name === 'depgraph').status, 'ok');
    assert.equal(report.steps.find((s) => s.name === 'edits').status, 'ok');
    assert.ok(report.visualizer && report.visualizer.totalNodes >= 4);
    assert.ok(report.budget);
    assert.equal(gitLog(dir).length, 4);
    assert.match(fs.readFileSync(path.join(dir, 'src/leaf.ts'), 'utf8'), /edited_leaf/);
  } finally {
    cleanup(dir);
  }
});

test('v12 agent: edit fail thì edit phụ thuộc bị skip, báo cáo FAIL rõ ràng', async () => {
  const dir = mkRepo({
    'src/leaf.ts': 'export const leaf = 1;\n',
    'src/mid.ts': "import { leaf } from './leaf';\nexport const mid = leaf;\n",
    'src/root.ts': "import { mid } from './mid';\nexport const root = mid;\n",
  });
  try {
    const provider = (ordered) => {
      if (ordered.file === 'src/mid.ts') {
        // oldText không tồn tại → edit fail.
        return {
          id: v12NewEditId(),
          file: ordered.file,
          format: 'patch',
          blocks: [{ oldText: 'const khongCo = 1;', newText: 'const khongCo = 2;' }],
          summary: 'Sửa mid (sẽ fail)',
        };
      }
      return {
        id: v12NewEditId(),
        file: ordered.file,
        format: 'patch',
        blocks: [{ oldText: 'export const ', newText: 'export const edited_' }],
        summary: `Sửa ${ordered.file}`,
      };
    };
    const agent = new CodingAgentV12({
      workingDir: dir,
      title: 'Pipeline fail demo',
      tasks: { 'src/leaf.ts': 'sửa leaf', 'src/mid.ts': 'sửa mid', 'src/root.ts': 'sửa root' },
      editProvider: provider,
    });
    const report = await agent.run();
    assert.equal(report.ok, false);
    assert.equal(report.editCommits.length, 1);
    assert.equal(report.editCommits[0].file, 'src/leaf.ts');
    assert.match(report.steps.find((s) => s.name === 'edits').detail, /1\/3 edit done, 1 failed, 1 skipped/);
    assert.equal(fs.readFileSync(path.join(dir, 'src/root.ts'), 'utf8').includes('edited_'), false);
  } finally {
    cleanup(dir);
  }
});

test('v12 agent: ACP switch giữa chừng + eval v3 sau edit', async () => {
  const dir = mkRepo({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const session = new V12AcpSession('model-a', [
      { id: 'model-a', capabilities: [{ name: 'code-edit', enabled: true }] },
      { id: 'model-b', capabilities: [{ name: 'code-edit', enabled: true }] },
    ]);
    session.addMessage('user', 'sửa a');
    const report = await runV12Agent({
      workingDir: dir,
      title: 'Switch + eval demo',
      tasks: { 'src/a.ts': 'sửa a' },
      editProvider: (ordered) => ({
        id: v12NewEditId(),
        file: ordered.file,
        format: 'patch',
        blocks: [{ oldText: 'export const a = 1;', newText: 'export const a = 2;' }],
        summary: 'Sửa a',
      }),
      acpSession: session,
      switchModelTo: 'model-b',
      evalTasks: [V12_EVAL_SAMPLE_TASKS[0]],
      evalAgent: scriptedV12Agent,
    });
    assert.equal(report.ok, true, renderV12AgentReport(report));
    assert.equal(report.steps.find((s) => s.name === 'acp-switch').status, 'ok');
    assert.equal(session.currentModelId(), 'model-b');
    assert.equal(session.getTranscript().length, 1);
    assert.equal(report.steps.find((s) => s.name === 'eval').status, 'ok');
    assert.ok(report.evalScores && report.evalScores.total > 0);
  } finally {
    cleanup(dir);
  }
});
