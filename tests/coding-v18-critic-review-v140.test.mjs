/**
 * Tests cho coding agent v18 — critic chấm trajectory/patch + review
 * skill 16 rule + PR gate (v1.40, Đội T4).
 *
 * Chạy thật: critic scorer thật trên trajectory/patch mẫu, review
 * rules thật trên patch mẫu, lịch sử chấm thật (append/stats).
 * Không gọi model/mạng.
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v18-critic-review-v140.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  V18_DEFAULT_CRITIC_CONFIG,
  V18_REVIEW_RULES,
  renderV18AutoFixResult,
  renderV18CriticVerdict,
  renderV18CriticTrend,
  renderV18ReviewReport,
  v18AggregateScore,
  v18AppendCriticHistory,
  v18ApplyAutoFixes,
  v18ContainsDestructiveCommand,
  v18ContainsSecret,
  v18CountRepeatedBash,
  v18CountUnresolvedErrors,
  v18CriticHistoryStats,
  v18CriticPreset,
  v18CriticTrend,
  v18CriticVerdictFor,
  v18LongestFunctionLines,
  v18ReviewPatch,
  v18ReviewPr,
  v18ReviewRuleById,
  v18ScorePatch,
  v18ScoreTrajectory,
  v18ScoreTrajectoryDimensions,
  v18ValidateCriticConfig,
} from '../packages/core/dist/index.js';

function goodSteps() {
  return [
    { kind: 'prompt', text: 'Thêm tính năng X' },
    { kind: 'plan', text: 'Viết code + test', files: ['src/a.ts'] },
    { kind: 'file_write', text: 'export function a() {\n return 1;\n}\n', files: ['src/a.ts'] },
    { kind: 'file_write', text: 'test a\n', files: ['tests/a.test.mjs'] },
    { kind: 'test', text: 'chạy test', files: ['tests/a.test.mjs'] },
    { kind: 'test_result', text: 'pass', passed: true },
  ];
}

function blockSteps() {
  return [
    { kind: 'bash', text: 'echo hi' },
    { kind: 'bash', text: 'echo hi' },
    { kind: 'bash', text: 'echo hi' },
    { kind: 'file_write', text: 'export const a = 1;\n', files: ['src/a.ts'] },
    { kind: 'file_write', text: 'export const a = 1;\n', files: ['src/a.ts'] },
    { kind: 'file_write', text: 'export const a = 1;\n', files: ['src/a.ts'] },
    { kind: 'bash', text: 'rm -rf /', exitCode: 1 },
    { kind: 'file_write', text: 'const api_key = "abcdefghijklmnop123456";\n', files: ['src/b.ts'] },
    { kind: 'compiler_error', text: 'Type error 1 ở src/a.ts' },
    { kind: 'compiler_error', text: 'Type error 2 ở src/b.ts' },
  ];
}

test('critic: trajectory tốt chấm 100, approve, không chặn push', () => {
  const verdict = v18ScoreTrajectory('s-good', goodSteps(), {
    plannedFiles: ['src/a.ts', 'tests/a.test.mjs'],
    now: 1000,
  });
  assert.equal(verdict.target, 'trajectory');
  assert.equal(verdict.score, 100);
  assert.equal(verdict.verdict, 'approve');
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.threshold.approveScore, 70);
  assert.equal(verdict.threshold.blockScore, 40);
  assert.equal(verdict.dimensions.length, 5);
  assert.equal(verdict.scoredAt, 1000);
  const text = renderV18CriticVerdict(verdict);
  assert.match(text, /100\/100 — APPROVE/);
  assert.doesNotMatch(text, /CHẶN PUSH/);
});

test('critic: trajectory xấu (secret + rm -rf + lỗi chưa xử lý) bị block + chặn push', () => {
  const verdict = v18ScoreTrajectory('s-bad', blockSteps(), {
    plannedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
    now: 1001,
  });
  assert.equal(verdict.verdict, 'block');
  assert.equal(verdict.blocked, true);
  assert.ok(verdict.score < 40, `điểm ${verdict.score} phải < 40`);
  const safety = verdict.dimensions.find((d) => d.name === 'safety');
  assert.equal(safety.score, 0);
  const recovery = verdict.dimensions.find((d) => d.name === 'errorRecovery');
  assert.ok(recovery.score < 100);
  const text = renderV18CriticVerdict(verdict);
  assert.match(text, /BLOCK — CHẶN PUSH/);
});

test('critic: ngưỡng cấu hình được — approve 90 / block 50 thay đổi verdict', () => {
  const strict = { approveScore: 90, blockScore: 50 };
  const midSteps = [
    { kind: 'prompt', text: 'task' },
    { kind: 'file_write', text: 'export const a = 1;\n', files: ['src/a.ts'] },
    { kind: 'test_result', text: 'pass', passed: true },
  ];
  // Điểm 85: completeness 65 (thiếu 1/2 file trong plan), còn lại 100,
  // testCoverage 50 (có chạy test nhưng không chạm file test).
  const def = v18ScoreTrajectory('s-mid', midSteps, { plannedFiles: ['src/a.ts', 'src/b.ts'], now: 1002 });
  const strictVerdict = v18ScoreTrajectory('s-mid', midSteps, {
    plannedFiles: ['src/a.ts', 'src/b.ts'],
    config: strict,
    now: 1002,
  });
  // Cùng điểm số, ngưỡng khác => verdict khác (mặc định approve, strict request-changes).
  assert.equal(def.score, strictVerdict.score);
  assert.equal(def.verdict, 'approve');
  assert.equal(strictVerdict.verdict, 'request-changes');
  assert.equal(v18CriticVerdictFor(90, strict), 'approve');
  assert.equal(v18CriticVerdictFor(49, strict), 'block');
  assert.equal(v18CriticVerdictFor(50, strict), 'request-changes');
});

test('critic: config không hợp lệ bị từ chối', () => {
  assert.throws(() => v18ValidateCriticConfig({ approveScore: 50, blockScore: 50 }), /nhỏ hơn approveScore/);
  assert.throws(() => v18ValidateCriticConfig({ approveScore: 120, blockScore: 40 }), /0\.\.100/);
  assert.throws(() => v18ValidateCriticConfig({ approveScore: 70, blockScore: -1 }), /0\.\.100/);
  assert.deepEqual(
    v18ValidateCriticConfig(V18_DEFAULT_CRITIC_CONFIG).approveScore,
    70,
  );
});

test('critic: trục tắt không tính vào điểm tổng; trục testCoverage bắt thiếu test', () => {
  const steps = [
    { kind: 'prompt', text: 'task' },
    { kind: 'file_write', text: 'export const a = 1;\n', files: ['src/a.ts'] },
    { kind: 'test_result', text: 'pass', passed: true },
  ];
  const dims = v18ScoreTrajectoryDimensions({ steps, plannedFiles: ['src/a.ts'] });
  const coverage = dims.find((d) => d.name === 'testCoverage');
  assert.equal(coverage.score, 50, 'có chạy test (+50) nhưng không chạm file test');
  const noCoverage = v18AggregateScore(dims, {
    ...V18_DEFAULT_CRITIC_CONFIG,
    disabledDimensions: ['testCoverage'],
  });
  const withCoverage = v18AggregateScore(dims, V18_DEFAULT_CRITIC_CONFIG);
  assert.ok(noCoverage > withCoverage, 'tắt trục 0 điểm phải làm điểm tổng tăng');
});

test('critic: helper đếm lặp / lỗi chưa xử lý / secret / lệnh phá hoại', () => {
  assert.equal(v18CountRepeatedBash(['a', 'b', 'a', 'a', 'c']), 1);
  assert.equal(v18CountRepeatedBash(['a', 'b']), 0);
  assert.equal(v18CountUnresolvedErrors([
    { kind: 'compiler_error', text: 'e1' },
    { kind: 'bash', text: 'fix', exitCode: 0 },
    { kind: 'error', text: 'e2' },
  ]), 1);
  assert.equal(v18CountUnresolvedErrors([
    { kind: 'compiler_error', text: 'e1' },
    { kind: 'test_result', text: 'ok', passed: true },
  ]), 0);
  assert.equal(v18ContainsSecret('const api_key = "abcdefghijklmnop123456";'), true);
  assert.equal(v18ContainsSecret('const name = "hello";'), false);
  assert.equal(v18ContainsDestructiveCommand('rm -rf /'), 'rm -rf thư mục gốc/home');
  assert.equal(v18ContainsDestructiveCommand('ls -la'), undefined);
});

test('critic: chấm patch — patch sạch approve, patch lộ secret block', () => {
  const clean = v18ScorePatch(
    { 'src/a.ts': 'export function a() {\n return 1;\n}\n', 'tests/a.test.mjs': 'test\n' },
    '',
    { plannedFiles: ['src/a.ts', 'tests/a.test.mjs'], now: 1003 },
  );
  assert.equal(clean.target, 'patch');
  assert.equal(clean.verdict, 'approve');
  const dirty = v18ScorePatch(
    { 'src/b.ts': 'const api_key = "abcdefghijklmnop123456";\n' },
    '',
    {
      plannedFiles: ['src/b.ts', 'src/c.ts'],
      // Ngưỡng block 60: patch lộ secret chấm 54 < 60 => block.
      config: { approveScore: 70, blockScore: 60 },
      now: 1004,
    },
  );
  assert.equal(dirty.score, 54);
  assert.equal(dirty.verdict, 'block');
  assert.equal(dirty.blocked, true);
});

test('critic: lịch sử chấm append + stats', () => {
  const good = v18ScoreTrajectory('s1', goodSteps(), { plannedFiles: ['src/a.ts', 'tests/a.test.mjs'], now: 1000 });
  const bad = v18ScoreTrajectory('s2', blockSteps(), { plannedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'], now: 1001 });
  let history = v18AppendCriticHistory([], good, 'trajectory tốt', { now: 1000 });
  history = v18AppendCriticHistory(history, bad, 'trajectory xấu', { now: 1001 });
  assert.equal(history.length, 2);
  assert.equal(history[0].sessionId, 's1');
  assert.equal(history[1].blocked, true);
  const stats = v18CriticHistoryStats(history);
  assert.equal(stats.total, 2);
  assert.equal(stats.approved, 1);
  assert.equal(stats.blocked, 1);
  assert.equal(stats.averageScore, Math.round((good.score + bad.score) / 2));
  assert.equal(stats.lowestScore, bad.score);
  assert.equal(stats.highestScore, good.score);
  assert.deepEqual(v18CriticHistoryStats([]).total, 0);
  // Giới hạn entry: giữ tối đa maxEntries.
  let capped = [];
  for (let i = 0; i < 5; i += 1) {
    capped = v18AppendCriticHistory(capped, good, 'x', { maxEntries: 3, now: 2000 + i });
  }
  assert.equal(capped.length, 3);
});

test('review: patch sạch pass, không finding', () => {
  const report = v18ReviewPatch(
    {
      'src/a.ts': 'export function a() {\n return 1;\n}\n',
      'tests/a.test.mjs': 'test a\n',
    },
    '',
    { now: 1000 },
  );
  assert.equal(report.verdict, 'pass');
  assert.equal(report.errorCount, 0);
  assert.equal(report.findings.length, 0);
  assert.equal(report.filesReviewed, 2);
  assert.equal(report.rulesRun.length, V18_REVIEW_RULES.length);
  assert.match(renderV18ReviewReport(report), /PASS/);
  assert.match(renderV18ReviewReport(report), /patch sạch/);
});

test('review: lộ secret + lệnh phá hoại + file nhạy cảm là error, verdict fail', () => {
  const secret = v18ReviewPatch({ 'src/b.ts': 'const api_key = "abcdefghijklmnop123456";\n' }, '', { now: 1000 });
  assert.equal(secret.verdict, 'fail');
  assert.equal(secret.errorCount, 1);
  assert.equal(secret.findings[0].rule, 'secret-leak');
  assert.match(secret.findings[0].suggestion, /vault/);

  const destructive = v18ReviewPatch(
    { 'src/c.ts': 'export const c = 1;\n', 'tests/c.test.mjs': 't\n' },
    'rm -rf /',
    { now: 1000 },
  );
  assert.equal(destructive.verdict, 'fail');
  assert.ok(destructive.findings.some((f) => f.rule === 'destructive-command'));

  const sensitive = v18ReviewPatch({ '.env': 'KEY=x\n' }, '', { now: 1000 });
  assert.equal(sensitive.verdict, 'fail');
  assert.ok(sensitive.findings.some((f) => f.rule === 'sensitive-file'));
});

test('review: thiếu test, hàm quá dài, console.log, catch rỗng, any-cast là warning', () => {
  const missingTest = v18ReviewPatch({ 'src/d.ts': 'export const d = 1;\n' }, '', { now: 1000 });
  assert.equal(missingTest.verdict, 'pass', 'warning không làm fail');
  assert.ok(missingTest.findings.some((f) => f.rule === 'missing-test'));

  const longFn = `export function big() {\n${'  const x = 1;\n'.repeat(85)}}\n`;
  assert.ok((v18LongestFunctionLines(longFn)?.lines ?? 0) > 80);
  const longReport = v18ReviewPatch({ 'src/e.ts': longFn }, '', { now: 1000 });
  assert.ok(longReport.findings.some((f) => f.rule === 'long-function'));

  const logged = v18ReviewPatch(
    { 'src/f.ts': 'export function f() {\n console.log("hi");\n return 1;\n}\n', 'tests/f.test.mjs': 't\n' },
    '',
    { now: 1000 },
  );
  assert.ok(logged.findings.some((f) => f.rule === 'console-log-left'));

  const emptyCatch = v18ReviewPatch(
    { 'src/g.ts': 'try { doIt(); } catch (e) {}\n', 'tests/g.test.mjs': 't\n' },
    '',
    { now: 1000 },
  );
  assert.ok(emptyCatch.findings.some((f) => f.rule === 'empty-catch'));

  const anyCast = v18ReviewPatch(
    { 'src/h.ts': 'const x = y as any;\n', 'tests/h.test.mjs': 't\n' },
    '',
    { now: 1000 },
  );
  assert.ok(anyCast.findings.some((f) => f.rule === 'any-cast'));
});

test('review: import vòng trong patch + patch quá rộng + TODO không owner + thiếu newline', () => {
  const circular = v18ReviewPatch(
    {
      'src/i.ts': "import { j } from './j';\nexport const i = 1;\n",
      'src/j.ts': "import { i } from './i';\nexport const j = 1;\n",
    },
    '',
    { now: 1000 },
  );
  assert.ok(circular.findings.some((f) => f.rule === 'circular-import-in-patch'));

  const bigDiff = `${Array.from({ length: 1001 }, () => '+line').join('\n')}`;
  const oversized = v18ReviewPatch({ 'src/k.ts': 'export const k = 1;\n' }, bigDiff, { now: 1000 });
  assert.ok(oversized.findings.some((f) => f.rule === 'oversized-patch'));

  const todo = v18ReviewPatch(
    { 'src/l.ts': '// TODO: refactor this\n', 'tests/l.test.mjs': 't\n' },
    '',
    { now: 1000 },
  );
  assert.ok(todo.findings.some((f) => f.rule === 'todo-without-owner' && f.severity === 'info'));

  const noNewline = v18ReviewPatch(
    { 'src/m.ts': 'export const m = 1;', 'tests/m.test.mjs': 't\n' },
    '',
    { now: 1000 },
  );
  assert.ok(noNewline.findings.some((f) => f.rule === 'missing-eof-newline'));
});

test('review: rule không tồn tại bị từ chối; chỉ chạy rule được bật', () => {
  assert.throws(
    () => v18ReviewPatch({ 'src/a.ts': 'x\n' }, '', { enabledRules: ['no-such-rule'] }),
    /Không có review rule/,
  );
  const onlySecret = v18ReviewPatch(
    { 'src/d.ts': 'export const d = 1;\n' },
    '',
    { enabledRules: ['secret-leak'], now: 1000 },
  );
  assert.equal(onlySecret.findings.length, 0, 'chỉ chạy secret-leak thì missing-test không được báo');
  assert.deepEqual(onlySecret.rulesRun, ['secret-leak']);
  assert.equal(v18ReviewRuleById('secret-leak')?.severity, 'error');
  assert.equal(v18ReviewRuleById('nope'), undefined);
});

test('review PR: gate merge — patch sạch merge được, patch lỗi chặn merge, warning vượt giới hạn chặn merge', () => {
  const clean = v18ReviewPr(
    { 'src/a.ts': 'export function a() {\n return 1;\n}\n', 'tests/a.test.mjs': 't\n' },
    '',
    { now: 1000 },
  );
  assert.equal(clean.mergeable, true);
  assert.match(clean.summary, /Gate PR: PASS/);

  const dirty = v18ReviewPr({ 'src/b.ts': 'const api_key = "abcdefghijklmnop123456";\n' }, '', { now: 1000 });
  assert.equal(dirty.mergeable, false);
  assert.match(dirty.summary, /Gate PR: FAIL/);
  assert.equal(dirty.report.errorCount, 1);

  const warnOnly = v18ReviewPr({ 'src/d.ts': 'export const d = 1;\n' }, '', { maxWarnings: 0, now: 1000 });
  assert.equal(warnOnly.mergeable, false, '1 warning vượt maxWarnings=0');
  const warnOk = v18ReviewPr({ 'src/d.ts': 'export const d = 1;\n' }, '', { maxWarnings: 5, now: 1000 });
  assert.equal(warnOk.mergeable, true);
});

test('critic: trend lịch sử — tăng / giảm / ổn định', () => {
  const entry = (score, at) => ({
    id: `e-${at}`, sessionId: 's', target: 'trajectory', score,
    verdict: score >= 70 ? 'approve' : score >= 40 ? 'request-changes' : 'block',
    blocked: score < 40, reason: '', at,
  });
  const declining = v18CriticTrend([entry(100, 1), entry(90, 2), entry(40, 3), entry(30, 4)]);
  assert.equal(declining.entries, 4);
  assert.equal(declining.firstHalfAverage, 95);
  assert.equal(declining.lastHalfAverage, 35);
  assert.equal(declining.delta, -60);
  assert.equal(declining.direction, 'declining');
  assert.match(renderV18CriticTrend(declining), /ĐANG GIẢM/);
  const improving = v18CriticTrend([entry(30, 1), entry(40, 2), entry(90, 3), entry(100, 4)]);
  assert.equal(improving.delta, 60);
  assert.equal(improving.direction, 'improving');
  const single = v18CriticTrend([entry(80, 1)]);
  assert.equal(single.direction, 'stable');
  assert.equal(single.delta, 0);
  assert.equal(single.firstHalfAverage, 80);
  const empty = v18CriticTrend([]);
  assert.equal(empty.entries, 0);
  assert.equal(empty.direction, 'stable');
});

test('critic: preset strict / balanced / lenient', () => {
  const balanced = v18CriticPreset('balanced');
  assert.equal(balanced.approveScore, 70);
  assert.equal(balanced.blockScore, 40);
  assert.equal(v18CriticPreset('strict').approveScore, 90);
  assert.equal(v18CriticPreset('strict').blockScore, 60);
  assert.equal(v18CriticPreset('lenient').approveScore, 50);
  assert.equal(v18CriticPreset('lenient').blockScore, 20);
  assert.throws(() => v18CriticPreset('nope'), /Không có critic preset/);
});

test('review: auto-fix áp được newline + xoá console.log + gộp import trùng; lỗi khác bỏ qua', () => {
  const patch = {
    'src/a.ts': 'export const a = 1;',
    'src/b.ts': 'export function b() {\n console.log("hi");\n return 1;\n}\n',
    'src/c.ts': "import { x } from './x';\nimport { y } from './x';\nexport const c = 1;\n",
    'src/d.ts': 'const api_key = "abcdefghijklmnop123456";\n',
  };
  const report = v18ReviewPatch(patch, '', { now: 1000 });
  assert.ok(report.findings.some((f) => f.rule === 'missing-eof-newline'));
  assert.ok(report.findings.some((f) => f.rule === 'console-log-left'));
  assert.ok(report.findings.some((f) => f.rule === 'duplicate-import'));
  assert.ok(report.findings.some((f) => f.rule === 'secret-leak'));
  const fixed = v18ApplyAutoFixes(patch, report);
  assert.equal(fixed.patch['src/a.ts'], 'export const a = 1;\n');
  assert.doesNotMatch(fixed.patch['src/b.ts'], /console\.log/);
  assert.equal(fixed.patch['src/c.ts'].split('\n').filter((l) => l.includes("from './x'")).length, 1);
  assert.equal(fixed.patch['src/d.ts'], patch['src/d.ts'], 'secret không được auto-fix');
  assert.ok(fixed.applied.length >= 3);
  assert.ok(fixed.skipped.some((s) => s.findingId.includes('secret-leak')));
  // Patch gốc không bị sửa.
  assert.equal(patch['src/a.ts'], 'export const a = 1;');
  // Chạy review lại trên patch đã fix: các finding đã fix biến mất.
  const after = v18ReviewPatch(fixed.patch, '', { now: 1001 });
  assert.ok(!after.findings.some((f) => f.rule === 'missing-eof-newline' && f.file === 'src/a.ts'));
  assert.ok(!after.findings.some((f) => f.rule === 'console-log-left'));
  assert.ok(!after.findings.some((f) => f.rule === 'duplicate-import'));
  assert.match(renderV18AutoFixResult(fixed), /áp được/);
});
