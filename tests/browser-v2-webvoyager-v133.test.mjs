/**
 * Tests for WebVoyager-local self-eval (v1.33, Đội T4).
 *
 *  - Fixture driver: navigate/click/type/search-submit/goBack/clickAt
 *    trên 7 trang fixture local (không mạng, không Chromium).
 *  - Checkers: text-contains / url-contains / ref-exists /
 *    role-name-exists / gate-blocked / all.
 *  - Runner: 8 task mẫu đều PASS với scripted agent; báo cáo kèm spec
 *    (harness version, dataset, host arch, ngày chạy) và 3 số đo:
 *    % success, cost/task (token snapshot thật từ cache), steps/task.
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/browser-v2-webvoyager-v133.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateCheck,
  createFixtureDriver,
  runWebVoyagerEval,
  renderWebVoyagerReport,
  scriptedAgent,
  WEBVOYAGER_TASKS,
  WEBVOYAGER_FIXTURE_HOST,
  WEBVOYAGER_HARNESS_VERSION,
  WEBVOYAGER_DATASET,
  BrowserV2Session,
} from '../packages/tools/dist/browserV2/index.js';

test('eval: 8 task mẫu, id duy nhất, startUrl đều trên fixture host', () => {
  assert.equal(WEBVOYAGER_TASKS.length, 8);
  const ids = new Set(WEBVOYAGER_TASKS.map((t) => t.id));
  assert.equal(ids.size, 8);
  for (const task of WEBVOYAGER_TASKS) {
    assert.ok(task.startUrl.includes(WEBVOYAGER_FIXTURE_HOST), task.id);
    assert.ok(task.maxSteps > 0 && task.maxSteps <= 10, task.id);
    assert.ok(task.goal.length > 0, task.id);
  }
});

test('eval: checkers pass/fail đúng trên trạng thái giả', () => {
  const nodes = [
    { ref: 'e1', role: 'heading', name: 'Cats: a complete guide', children: [] },
    { ref: 'e2', role: 'text', name: 'The answer is 42: cats rule.', children: [] },
  ];
  const state = { nodes, url: `https://${WEBVOYAGER_FIXTURE_HOST}/article/cats`, gateBlocks: 1, blockedActions: ['navigate'] };
  assert.equal(evaluateCheck({ kind: 'text-contains', text: 'The answer is 42' }, state).success, true);
  assert.equal(evaluateCheck({ kind: 'text-contains', text: 'dogs' }, state).success, false);
  assert.equal(evaluateCheck({ kind: 'url-contains', substring: 'article' }, state).success, true);
  assert.equal(evaluateCheck({ kind: 'ref-exists', ref: 'e1' }, state).success, true);
  assert.equal(evaluateCheck({ kind: 'ref-exists', ref: 'e9' }, state).success, false);
  assert.equal(evaluateCheck({ kind: 'role-name-exists', role: 'heading', name: 'Cats: a complete guide' }, state).success, true);
  assert.equal(evaluateCheck({ kind: 'gate-blocked', action: 'navigate' }, state).success, true);
  assert.equal(evaluateCheck({ kind: 'gate-blocked', action: 'form-submit' }, state).success, false);
  assert.equal(
    evaluateCheck({ kind: 'all', checks: [{ kind: 'text-contains', text: '42' }, { kind: 'url-contains', substring: 'cats' }] }, state).success,
    true,
  );
  assert.equal(
    evaluateCheck({ kind: 'all', checks: [{ kind: 'text-contains', text: '42' }, { kind: 'text-contains', text: 'zzz' }] }, state).success,
    false,
  );
});

test('eval: fixture driver navigate/search/click/goBack/clickAt', async () => {
  const { launcher } = createFixtureDriver();
  const session = new BrowserV2Session({
    createBrowser: launcher,
    egress: { allowedHosts: [WEBVOYAGER_FIXTURE_HOST, `*.${WEBVOYAGER_FIXTURE_HOST}`] },
  });
  await session.navigate(`https://${WEBVOYAGER_FIXTURE_HOST}/`);
  const home = await session.snapshot();
  assert.match(home.payload.text, /Fixture Store/);
  await session.typeRef('e1', 'cats');
  await session.clickRef('e2');
  assert.match(session.url, /\/search\?q=cats/);
  const results = await session.snapshot();
  assert.match(results.payload.text, /Results for "cats"/);
  await session.clickRef('e1');
  const article = await session.snapshot();
  assert.match(article.payload.text, /The answer is 42/);
  await session.goBack();
  assert.match(session.url, /\/search\?q=cats/);
  // Canvas: click tọa độ kích hoạt text (vision fallback).
  await session.navigate(`https://${WEBVOYAGER_FIXTURE_HOST}/canvas`);
  await session.clickAt(640, 360);
  const canvas = await session.snapshot();
  assert.match(canvas.payload.text, /Canvas clicked/);
  assert.equal(session.vision.clickCount, 1);
  await session.close();
});

test('eval: fixture driver từ chối URL ngoài fixture (không có mạng)', async () => {
  const { launcher } = createFixtureDriver();
  const session = new BrowserV2Session({
    createBrowser: launcher,
    egress: { allowedHosts: [WEBVOYAGER_FIXTURE_HOST] },
  });
  // Gate chặn trước khi tới driver (evil host không trong allowlist).
  await assert.rejects(() => session.navigate('https://evil.example/'), /egress gate/);
  await session.close();
});

test('eval: runner 8/8 PASS với scripted agent, báo cáo có đủ 3 số đo + spec', async () => {
  const report = await runWebVoyagerEval(WEBVOYAGER_TASKS, {});
  assert.equal(report.spec.taskCount, 8);
  assert.equal(report.spec.harnessVersion, WEBVOYAGER_HARNESS_VERSION);
  assert.equal(report.spec.dataset, WEBVOYAGER_DATASET);
  assert.ok(report.spec.hostArch.includes('/'));
  assert.ok(!Number.isNaN(Date.parse(report.spec.runAt)));
  assert.equal(report.passed, 8);
  assert.equal(report.failed, 0);
  assert.equal(report.successRate, 1);
  assert.ok(report.avgStepsPerTask > 0 && report.avgStepsPerTask <= 8);
  assert.ok(report.avgCostTokensPerTask > 0, 'cost/task phải > 0 token (số thật từ cache)');
  assert.ok(report.totalTokensSent > 0);
  assert.equal(report.results.length, 8);
  for (const r of report.results) {
    assert.equal(r.success, true, `${r.taskId}: ${r.reason}`);
    assert.ok(r.steps >= 1, r.taskId);
    assert.ok(r.tokensSent > 0, r.taskId);
    assert.ok(r.durationMs >= 0, r.taskId);
  }
  // Task vision fallback dùng đúng 1 click tọa độ; task egress bị chặn đúng 1 lần.
  const vision = report.results.find((r) => r.taskId === 'wv-vision-canvas');
  assert.equal(vision.visionFallbackClicks, 1);
  const blocked = report.results.find((r) => r.taskId === 'wv-egress-blocked');
  assert.equal(blocked.gateBlocks, 1);
  assert.match(blocked.reason, /gate blocked/);
  const rendered = renderWebVoyagerReport(report);
  assert.match(rendered, /Success: 8\/8 \(100%\)/);
  assert.match(rendered, /avg .* steps\/task/);
  assert.match(rendered, /avg .* tokens\/task/);
  assert.match(rendered, /\[PASS\] wv-find-article/);
});

test('eval: agent giveUp / maxSteps cho kết quả FAIL có lý do rõ ràng', async () => {
  const giveUpTask = {
    id: 'wv-giveup',
    title: 'Give up immediately',
    goal: 'Give up.',
    startUrl: `https://${WEBVOYAGER_FIXTURE_HOST}/`,
    maxSteps: 4,
    check: { kind: 'text-contains', text: 'The answer is 42' },
    script: [{ type: 'giveUp', reason: 'too hard' }],
  };
  const report = await runWebVoyagerEval([giveUpTask], {});
  assert.equal(report.passed, 0);
  assert.equal(report.results[0].success, false);
  assert.match(report.results[0].reason, /too hard|check failed/);
});

test('eval: stepFn tùy chỉnh được gọi với snapshot payload (full rồi diff)', async () => {
  const seen = [];
  const customStepFn = async (ctx) => {
    seen.push({ step: ctx.step, kind: ctx.snapshotKind, url: ctx.url });
    return { type: 'done' };
  };
  const task = {
    id: 'wv-custom-fn',
    title: 'Custom step fn',
    goal: 'Done at once.',
    startUrl: `https://${WEBVOYAGER_FIXTURE_HOST}/cart`,
    maxSteps: 4,
    check: { kind: 'text-contains', text: 'Widget Pro $19.99' },
  };
  const report = await runWebVoyagerEval([task], { stepFnFactory: () => customStepFn });
  assert.equal(report.passed, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'full');
  assert.match(seen[0].url, /\/cart/);
  // scriptedAgent mặc định vẫn chạy được (sanity).
  const scripted = scriptedAgent(WEBVOYAGER_TASKS[0]);
  assert.deepEqual(await scripted({}), WEBVOYAGER_TASKS[0].script[0]);
});
