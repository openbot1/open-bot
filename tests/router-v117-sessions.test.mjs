/**
 * Router local v117 — session manager + cost report + context guard
 * (v1.40, Doi T3, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - estimateMidChatTokens: ~4 ky tu / token, toi thieu 1.
 * - Context guard: message vuot 80% context cua model hien tai thi leo
 *   len model context lon hon (ke ca khi do kho thap).
 * - MidChatSessionManager: moi session router rieng (leo/ha doc lap),
 *   tu tao session khi route, setPolicy lan xuong cac session,
 *   costReport (token theo model, lightShare, token chay bang model
 *   nhe thay vi model manh), list/delete session.
 * - Tools: route voi sessionId, cost_report qua tool.
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-v117-sessions.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MidChatRouter,
  MidChatSessionManager,
  estimateMidChatTokens,
} from '../packages/core/dist/router/local/midChatRouterV117.js';
import { createRouterLocalV117Tools } from '../packages/tools/dist/routerLocalV117Tools.js';

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tool, args) {
  const out = await tool.execute(args);
  if (typeof out === 'string' && out.startsWith('Error:')) return { error: out };
  return JSON.parse(out);
}

const HARD_CODE = [
  '```rust',
  ...Array.from({ length: 30 }, (_, i) => `fn step_${i}(x: u64) -> u64 { x.wrapping_mul(31) ^ (x >> ${i % 7 + 1}) }`),
  '```',
  'Can you prove this algorithm is correct and optimize it? Debug the',
  'deadlock and race condition step by step. First explain the root cause,',
  'then refactor the design. How does the complexity compare? Why does it',
  'fail on large inputs? What is the benchmark?',
  '1. Analyse the code. 2. Fix it. 3. Verify it.',
].join('\n');

const EASY = 'hello, can you help me with something simple today please?';

test('estimateMidChatTokens: 4 ky tu/token, toi thieu 1', () => {
  assert.equal(estimateMidChatTokens(''), 1);
  assert.equal(estimateMidChatTokens('x'), 1);
  assert.equal(estimateMidChatTokens('x'.repeat(400)), 100);
  assert.equal(estimateMidChatTokens('x'.repeat(401)), 101);
});

test('context guard: message dai vuot 80% context thi leo model', () => {
  const router = new MidChatRouter();
  router.setPolicy({
    candidates: [
      { modelId: 'tiny', tier: 'light', costPer1kTokensUsd: 0, quality: 0.4, multimodal: false, maxContextTokens: 100 },
      { modelId: 'big', tier: 'standard', costPer1kTokensUsd: 0, quality: 0.7, multimodal: false, maxContextTokens: 32768 },
    ],
    defaultModelId: 'big',
    lightModelId: 'tiny',
    strongModelId: 'big',
    multimodalModelId: 'big',
  });
  assert.equal(router.needsBiggerContext('x'.repeat(500), 'tiny'), true);
  assert.equal(router.needsBiggerContext('hi', 'tiny'), false);
  assert.equal(router.pickBiggerContextModel('x'.repeat(500), 'tiny', false), 'big');
  // Message dai nhung de (khong keyword kho) van leo vi context, khong phai vi do kho.
  const routed = router.route('x'.repeat(500), 'tiny');
  assert.equal(routed.chosenModelId, 'big');
  assert.ok(routed.reasons.some((r) => r.includes('context')));
  const short = router.route('hi', 'tiny');
  assert.equal(short.chosenModelId, 'tiny');
});

test('sessions: moi session leo/ha doc lap', () => {
  const manager = new MidChatSessionManager();
  const a = manager.createSession('conv-a');
  assert.equal(a.id, 'conv-a');
  assert.equal(a.currentModelId, 'qwen3-4b');
  assert.throws(() => manager.createSession('conv-a'), /da ton tai/);

  const hardA = manager.route('conv-a', HARD_CODE);
  assert.equal(hardA.chosenModelId, 'qwen3-32b');
  const easyB = manager.route('conv-b', EASY);
  assert.equal(easyB.chosenModelId, 'qwen3-0.6b');
  assert.deepEqual(manager.sessionIds(), ['conv-a', 'conv-b']);
  const summaries = manager.listSessions();
  assert.equal(summaries.find((s) => s.id === 'conv-a').currentModelId, 'qwen3-32b');
  assert.equal(summaries.find((s) => s.id === 'conv-b').currentModelId, 'qwen3-0.6b');
  assert.equal(manager.hasSession('conv-a'), true);
  assert.equal(manager.deleteSession('conv-a'), true);
  assert.equal(manager.hasSession('conv-a'), false);
  assert.throws(() => manager.costReport('conv-a'), /Khong co session/);
});

test('sessions: costReport — token nhe, lightShare, dem leo/ha', () => {
  const manager = new MidChatSessionManager();
  manager.route('s1', EASY);
  manager.route('s1', EASY);
  manager.route('s1', HARD_CODE);
  const report = manager.costReport('s1');
  assert.equal(report.decisions, 3);
  assert.equal(report.escalations, 1);
  // Message de thu 2 da o model nhe nen tinh la stay, khong phai deescalate.
  assert.equal(report.deescalations, 1);
  assert.equal(report.stays, 1);
  const lightTokens = report.tokensByModel['qwen3-0.6b'];
  assert.ok(lightTokens > 0, 'co token chay bang model nhe');
  assert.equal(report.tokensRoutedAwayFromStrong, lightTokens);
  assert.ok(report.lightShare > 0 && report.lightShare < 1, `lightShare ${report.lightShare}`);
  assert.equal(report.decisionsDetail.length, 3);
  const all = manager.costReport();
  assert.equal(all.id, 'all-sessions');
  assert.equal(all.decisions, 3);
});

test('sessions: setPolicy lan xuong cac session', () => {
  const manager = new MidChatSessionManager();
  manager.route('s1', EASY);
  manager.setPolicy({ escalateThreshold: 0.9 });
  assert.equal(manager.getPolicy().escalateThreshold, 0.9);
  assert.equal(manager.getSessionRouter('s1').getPolicy().escalateThreshold, 0.9);
  manager.clearAll();
  assert.deepEqual(manager.sessionIds(), []);
});

test('tools: route theo sessionId + cost_report', async () => {
  const tools = createRouterLocalV117Tools();
  const r1 = await run(toolByName(tools, 'router_local_midchat_route'), {
    content: EASY, sessionId: 'tool-session',
  });
  assert.equal(r1.sessionId, 'tool-session');
  assert.equal(r1.chosenModelId, 'qwen3-0.6b');
  const r2 = await run(toolByName(tools, 'router_local_midchat_route'), {
    content: HARD_CODE, sessionId: 'tool-session',
  });
  assert.equal(r2.chosenModelId, 'qwen3-32b');
  const report = await run(toolByName(tools, 'router_local_midchat_cost_report'), {
    sessionId: 'tool-session',
  });
  assert.equal(report.report.decisions, 2);
  assert.equal(report.report.escalations, 1);
  assert.ok(report.report.tokensByModel['qwen3-0.6b'] > 0);
  assert.equal(report.sessions.length, 1);
  const bad = await run(toolByName(tools, 'router_local_midchat_cost_report'), {
    sessionId: 'no-such-session',
  });
  assert.ok(bad.error.startsWith('Error:'));
  const all = await run(toolByName(tools, 'router_local_midchat_cost_report'), {});
  assert.equal(all.report.id, 'all-sessions');
});
