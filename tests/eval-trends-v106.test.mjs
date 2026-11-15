/**
 * Tests for eval trends (packages/core/src/eval/trends.ts).
 *
 * Covers trend computation from saved reports (pass rates, direction
 * improving/stable/worsening), flaky-case detection (sometimes pass,
 * sometimes fail), always-failing detection, history loading that
 * skips corrupt reports, and text formatting.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-trends-v106.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildEvalTrends,
  caseTrendFromResults,
  formatEvalTrendsText,
  loadEvalReportHistory,
} from '../packages/core/dist/eval/trends.js';
import { saveEvalReport } from '../packages/core/dist/eval/types.js';
import { runEval } from '../packages/core/dist/eval/index.js';

function fakeReport(id, createdAt, cases) {
  return {
    id,
    suites: ['memory'],
    results: [{
      suite: 'memory',
      startedAt: createdAt,
      finishedAt: createdAt + 10,
      durationMs: 10,
      cases: cases.map(([caseId, passed]) => ({
        id: caseId, name: caseId, passed, detail: passed ? 'ok' : 'bad', durationMs: 1,
      })),
      passed: cases.filter(([, p]) => p).length,
      failed: cases.filter(([, p]) => !p).length,
    }],
    passed: cases.filter(([, p]) => p).length,
    failed: cases.filter(([, p]) => !p).length,
    createdAt,
    durationMs: 10,
  };
}

test('caseTrendFromResults: flaky vs always-failing vs stable', () => {
  const flaky = caseTrendFromResults('c1', 'memory', [
    { passed: true, at: 3 }, { passed: false, at: 2 }, { passed: true, at: 1 },
  ]);
  assert.equal(flaky.flaky, true);
  assert.equal(flaky.alwaysFailing, false);
  assert.equal(flaky.passRate, 2 / 3);
  assert.equal(flaky.runs, 3);
  assert.equal(flaky.lastPassed, true);
  const broken = caseTrendFromResults('c2', 'memory', [
    { passed: false, at: 2 }, { passed: false, at: 1 },
  ]);
  assert.equal(broken.flaky, false);
  assert.equal(broken.alwaysFailing, true);
  assert.equal(broken.passRate, 0);
  const stable = caseTrendFromResults('c3', 'memory', [{ passed: true, at: 1 }]);
  assert.equal(stable.flaky, false);
  assert.equal(stable.alwaysFailing, false);
  assert.equal(stable.passRate, 1);
});

test('buildEvalTrends: direction, flaky and always-failing lists', () => {
  const T0 = 1_790_000_000_000;
  const reports = [
    fakeReport('eval-3', T0 + 3000, [['a', true], ['b', false], ['c', true]]),
    fakeReport('eval-2', T0 + 2000, [['a', true], ['b', false], ['c', false]]),
    fakeReport('eval-1', T0 + 1000, [['a', true], ['b', true], ['c', false]]),
  ];
  const trends = buildEvalTrends(reports, 20, T0 + 4000);
  assert.equal(trends.reports, 3);
  assert.deepEqual(trends.range, { from: T0 + 1000, to: T0 + 3000 });
  assert.equal(trends.suites.length, 1);
  const suite = trends.suites[0];
  assert.equal(suite.suite, 'memory');
  assert.equal(suite.reports, 3);
  // Newer half (2/3) vs older half (1/3): improving.
  assert.equal(suite.direction, 'improving');
  assert.ok(Math.abs(suite.avgPassRate - 5 / 9) < 1e-9, `avg pass rate should be ~5/9, got ${suite.avgPassRate}`);
  assert.equal(suite.latestPassRate, 2 / 3);
  assert.deepEqual(trends.flakyCases.map((c) => c.id).sort(), ['b', 'c']);
  assert.deepEqual(trends.alwaysFailingCases.map((c) => c.id), []);
  const text = formatEvalTrendsText(trends);
  assert.match(text, /Eval trends over 3 report\(s\)/);
  assert.match(text, /FLAKY  b/);
  assert.match(text, /improving/);
});

test('buildEvalTrends: worsening direction and always-failing case', () => {
  const T0 = 1_790_000_000_000;
  const reports = [
    fakeReport('eval-3', T0 + 3000, [['a', false], ['b', false]]),
    fakeReport('eval-2', T0 + 2000, [['a', false], ['b', true]]),
    fakeReport('eval-1', T0 + 1000, [['a', false], ['b', true]]),
  ];
  const trends = buildEvalTrends(reports);
  assert.equal(trends.suites[0].direction, 'worsening');
  assert.deepEqual(trends.alwaysFailingCases.map((c) => c.id), ['a']);
  assert.deepEqual(trends.flakyCases.map((c) => c.id), ['b']);
});

test('buildEvalTrends on no reports is empty and formats a clear message', () => {
  const trends = buildEvalTrends([]);
  assert.equal(trends.reports, 0);
  assert.equal(trends.range, null);
  assert.deepEqual(trends.suites, []);
  assert.equal(formatEvalTrendsText(trends), 'No eval reports yet — run an eval first.\n');
});

test('loadEvalReportHistory skips corrupt reports and reads real ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-trends-'));
  const { report } = await runEval(['memory']);
  saveEvalReport(dir, report);
  fs.writeFileSync(path.join(dir, 'eval-reports', 'eval-corrupt.json'), '{not json');
  const history = loadEvalReportHistory(dir);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, report.id);
  const trends = buildEvalTrends(history);
  assert.equal(trends.reports, 1);
  assert.equal(trends.suites[0].latestPassRate, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
