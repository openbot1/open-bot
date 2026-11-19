/**
 * Router local v117 — mid-chat RouterLLM (v1.40, Doi T3, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - analyzeMidChatMessage: short chat cap 0.25; image +0.30; code block
 *   + lines + hard language; reasoning keywords; multi-step; length.
 * - MidChatRouter.route: image -> multimodal; kho -> strong; de ->
 *   light; giua nguong -> stay; cooldown chong flip-flop sau leo thang.
 * - Policy: set/get, validate nguong (de < leo, 0..1), candidates.
 * - Cay router long nhau: branch theo hasImage/minDifficulty, fallback,
 *   validate cay (thieu fallback, nguong lech, qua sau).
 * - Tools: 13 ten duy nhat, needsApproval=false; route/policy/tree
 *   qua tool; log quyet dinh ghi du ly do.
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/router-v117-midchat.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MidChatRouter,
  analyzeMidChatMessage,
  defaultMidChatPolicy,
  resolveRouterNode,
  validateRouterNode,
} from '../packages/core/dist/router/local/midChatRouterV117.js';
import {
  ROUTER_LOCAL_V117_TOOL_NAMES,
  createDefaultRouterLocalV117State,
  createRouterLocalV117Tools,
  isRouterLocalV117ToolName,
} from '../packages/tools/dist/routerLocalV117Tools.js';

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

test('analyze: short chat bi cap 0.25, khong signal', () => {
  const s = analyzeMidChatMessage('hi, how are you?');
  assert.equal(s.isShortChat, true);
  assert.equal(s.hasImage, false);
  assert.equal(s.hasCodeBlock, false);
  assert.ok(s.difficulty <= 0.25, `difficulty ${s.difficulty}`);
});

test('analyze: anh +0.30, code rust dai + keyword suy luan -> kho >= 0.65', () => {
  const img = analyzeMidChatMessage('What is in this picture?', { hasImage: true });
  assert.equal(img.hasImage, true);
  assert.ok(img.difficulty >= 0.4, `difficulty ${img.difficulty}`);

  const hard = analyzeMidChatMessage(HARD_CODE);
  assert.equal(hard.hasCodeBlock, true);
  assert.equal(hard.codeLanguage, 'rust');
  assert.ok(hard.codeLines >= 25, `codeLines ${hard.codeLines}`);
  assert.ok(hard.reasoningHits.includes('prove'));
  assert.equal(hard.multiStep, true);
  assert.ok(hard.difficulty >= 0.65, `difficulty ${hard.difficulty}`);
});

test('route: anh -> multimodal, kho -> strong, de -> light, giua -> stay', () => {
  const router = new MidChatRouter();
  const img = router.route('Describe this image', 'qwen3-4b', { hasImage: true });
  assert.equal(img.chosenModelId, 'gemma-3-12b');
  assert.equal(img.direction, 'escalate');
  assert.ok(img.reasons.some((r) => r.includes('multimodal') || r.includes('ảnh')));

  const hard = router.route(HARD_CODE, 'qwen3-4b');
  assert.equal(hard.chosenModelId, 'qwen3-32b');
  assert.equal(hard.direction, 'escalate');

  const easyRouter = new MidChatRouter();
  const easy = easyRouter.route('hi', 'qwen3-4b');
  assert.equal(easy.chosenModelId, 'qwen3-0.6b');
  assert.equal(easy.direction, 'deescalate');

  const mid = easyRouter.route('Can you compare these two approaches and evaluate the trade-off? Explain why one is better.', 'qwen3-4b');
  assert.ok(mid.difficulty > 0.3 && mid.difficulty < 0.65, `difficulty ${mid.difficulty}`);
  assert.equal(mid.chosenModelId, 'qwen3-4b');
  assert.equal(mid.direction, 'stay');
});

test('route: cooldown — moi leo thang thi khong ha cap ngay', () => {
  const router = new MidChatRouter();
  const up = router.route(HARD_CODE, 'qwen3-4b');
  assert.equal(up.chosenModelId, 'qwen3-32b');
  const stay1 = router.route('hi', 'qwen3-32b');
  assert.equal(stay1.chosenModelId, 'qwen3-32b');
  assert.ok(stay1.reasons.some((r) => r.includes('flip-flop')));
  const stay2 = router.route('ok thanks', 'qwen3-32b');
  assert.equal(stay2.chosenModelId, 'qwen3-32b');
  const down = router.route('bye', 'qwen3-32b');
  assert.equal(down.chosenModelId, 'qwen3-0.6b');
  assert.equal(down.direction, 'deescalate');
});

test('route: log ghi du ly do + id tang dan', () => {
  const router = new MidChatRouter();
  const d1 = router.route('hi', 'qwen3-4b');
  const d2 = router.route(HARD_CODE, 'qwen3-4b');
  assert.notEqual(d1.id, d2.id);
  assert.ok(d2.reasons.length >= 3);
  const store = router.getLogStore();
  assert.equal(store.size(), 2);
  assert.equal(store.get(d1.id).chosenModelId, 'qwen3-0.6b');
  assert.deepEqual(store.list().map((d) => d.id), [d2.id, d1.id]);
});

test('policy: set/get + validate nguong', () => {
  const router = new MidChatRouter();
  assert.equal(router.getPolicy().escalateThreshold, 0.65);
  const next = router.setPolicy({ escalateThreshold: 0.8, deescalateThreshold: 0.2 });
  assert.equal(next.escalateThreshold, 0.8);
  assert.equal(next.deescalateThreshold, 0.2);
  assert.throws(() => router.setPolicy({ deescalateThreshold: 0.9 }), /nho hon escalateThreshold/);
  assert.throws(() => router.setPolicy({ escalateThreshold: 1.5 }), /0\.\.1/);
  assert.throws(() => router.setPolicy({ minTurnsAfterEscalate: -1 }), /so nguyen >= 0/);
  assert.throws(() => router.setCandidates([]), /khong duoc rong/);
  const candidates = router.setCandidates([
    { modelId: 'a-light', tier: 'light', costPer1kTokensUsd: 0, quality: 0.4, multimodal: false, maxContextTokens: 8000 },
    { modelId: 'a-strong', tier: 'strong', costPer1kTokensUsd: 0, quality: 0.9, multimodal: false, maxContextTokens: 8000 },
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(router.tierOf('a-light'), 'light');
  assert.equal(router.tierOf('unknown-model'), 'standard');
  assert.equal(defaultMidChatPolicy().defaultModelId, 'qwen3-4b');
});

test('cay router: long nhau, branch theo predicate, fallback', () => {
  const tree = {
    kind: 'router',
    id: 'root',
    branches: [
      { predicate: { hasImage: true }, node: { kind: 'model', modelId: 'gemma-3-12b' } },
      {
        predicate: { minDifficulty: 0.8 },
        node: {
          kind: 'router',
          id: 'hard',
          branches: [
            { predicate: { hasCode: true }, node: { kind: 'model', modelId: 'qwen3-32b' } },
          ],
          fallback: { kind: 'model', modelId: 'qwen3-14b' },
        },
      },
    ],
    fallback: { kind: 'model', modelId: 'qwen3-0.6b' },
  };
  assert.deepEqual(validateRouterNode(tree), []);
  const signals = analyzeMidChatMessage(HARD_CODE);
  assert.ok(signals.difficulty >= 0.8, `difficulty ${signals.difficulty}`);
  const resolved = resolveRouterNode(tree, signals);
  assert.equal(resolved.modelId, 'qwen3-32b');
  assert.ok(resolved.path.includes('router:root'));
  assert.ok(resolved.path.includes('router:hard'));

  const router = new MidChatRouter();
  router.setTree(tree);
  const viaTree = router.route('What is in this image?', 'qwen3-4b', { hasImage: true });
  assert.equal(viaTree.chosenModelId, 'gemma-3-12b');
  assert.ok(viaTree.nodePath.length > 0);
  const easy = router.route('hi', 'qwen3-4b');
  assert.equal(easy.chosenModelId, 'qwen3-0.6b');
  assert.ok(easy.nodePath.includes('fallback'));
});

test('cay router: validate bat loi', () => {
  assert.ok(validateRouterNode({ kind: 'router', id: 'x', branches: [], fallback: { kind: 'model', modelId: 'm' } }).length > 0);
  assert.ok(validateRouterNode({ kind: 'router', id: 'x', branches: [{ predicate: {}, node: { kind: 'model', modelId: 'm' } }] }).length > 0);
  assert.ok(validateRouterNode({ kind: 'router', id: 'x', branches: [{ predicate: { minDifficulty: 0.9, maxDifficulty: 0.1 }, node: { kind: 'model', modelId: 'm' } }], fallback: { kind: 'model', modelId: 'm' } }).length > 0);
  assert.ok(validateRouterNode({ kind: 'model', modelId: '' }).length > 0);
  assert.ok(validateRouterNode({ kind: 'weird' }).length > 0);
  assert.ok(validateRouterNode(null).length > 0);
  const router = new MidChatRouter();
  assert.throws(() => router.setTree({ kind: 'model', modelId: '' }), /khong hop le/);
});

test('tools: 17 tool v117, ten duy nhat, needsApproval=false', () => {
  const tools = createRouterLocalV117Tools();
  assert.equal(tools.length, 17);
  assert.deepEqual(
    tools.map((t) => t.definition.name).sort(),
    [...ROUTER_LOCAL_V117_TOOL_NAMES].sort(),
  );
  assert.equal(new Set(tools.map((t) => t.definition.name)).size, 17);
  for (const t of tools) assert.equal(t.needsApproval, false, t.definition.name);
  assert.equal(isRouterLocalV117ToolName('router_local_midchat_route'), true);
  assert.equal(isRouterLocalV117ToolName('router_local_score_rank'), false);
  assert.equal(createDefaultRouterLocalV117State().router instanceof MidChatRouter, true);
});

test('tools: route + policy + tree qua tool', async () => {
  const tools = createRouterLocalV117Tools();
  const routed = await run(toolByName(tools, 'router_local_midchat_route'), { content: HARD_CODE, currentModelId: 'qwen3-4b' });
  assert.equal(routed.chosenModelId, 'qwen3-32b');
  assert.equal(routed.direction, 'escalate');
  assert.ok(routed.difficulty >= 0.65);

  const bad = await run(toolByName(tools, 'router_local_midchat_route'), { content: '   ' });
  assert.ok(bad.error.startsWith('Error:'));

  const policy = await run(toolByName(tools, 'router_local_midchat_policy_get'), {});
  assert.equal(policy.policy.escalateThreshold, 0.65);
  const set = await run(toolByName(tools, 'router_local_midchat_policy_set'), { escalateThreshold: 0.7 });
  assert.equal(set.policy.escalateThreshold, 0.7);
  const badPolicy = await run(toolByName(tools, 'router_local_midchat_policy_set'), { escalateThreshold: 2 });
  assert.ok(badPolicy.error.startsWith('Error:'));

  const tree = {
    kind: 'router', id: 'root',
    branches: [{ predicate: { hasImage: true }, node: { kind: 'model', modelId: 'gemma-3-12b' } }],
    fallback: { kind: 'model', modelId: 'qwen3-0.6b' },
  };
  const setTree = await run(toolByName(tools, 'router_local_midchat_tree_set'), { tree });
  assert.equal(setTree.tree.id, 'root');
  const routedTree = await run(toolByName(tools, 'router_local_midchat_route'), { content: 'look', currentModelId: 'qwen3-4b', hasImage: true });
  assert.equal(routedTree.chosenModelId, 'gemma-3-12b');
  assert.ok(routedTree.nodePath.length > 0);
  const getTree = await run(toolByName(tools, 'router_local_midchat_tree_get'), { limit: 2 });
  assert.equal(getTree.tree.id, 'root');
  assert.ok(getTree.decisions.length >= 1);
  const badTree = await run(toolByName(tools, 'router_local_midchat_tree_set'), { tree: { kind: 'router', id: 'x', branches: [] } });
  assert.ok(badTree.error.startsWith('Error:'));
  const cleared = await run(toolByName(tools, 'router_local_midchat_tree_set'), { tree: null });
  assert.equal(cleared.tree, null);
});
