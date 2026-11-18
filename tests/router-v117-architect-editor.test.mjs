/**
 * Architect–Editor routing tests (v1.17, Doi T3 — node:test).
 *
 * Covers:
 * - classifyArchitectDifficulty: trivial -> hard theo kind/prompt/
 *   tool-use/scope/qualityNeed.
 * - choosePlannerEditorPair: planner quality cao nhat, editor re
 *   nhat dat nguong (uu tien local), single-model khi task de,
 *   overBudget, khong co candidate -> throw.
 * - buildArchitectPlan: analyze -> edit theo thu muc -> test ->
 *   verify, dependsOn dung, file scope giu nguyen.
 * - runArchitectEditor (fake executors): happy path; editor fail
 *   1 lan roi retry thanh cong; editor fail het -> escalate len
 *   planner; escalate fail -> doi editor manh hon; het budget token
 *   thi dung; step phu thuoc step fail thi skipped; verify fail
 *   danh run failed.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v117-architect-editor.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHITECT_MIN_EDITOR_QUALITY,
  buildArchitectPlan,
  choosePlannerEditorPair,
  classifyArchitectDifficulty,
  estimateArchitectTokens,
  runArchitectEditor,
} from '../packages/core/dist/routerV2/index.js';

const localCheap = {
  modelId: 'qwen2.5-coder:7b', source: 'local', quality: 0.72,
  costPer1kTokensUsd: 0, estLatencyMs: 200, available: true, local: true,
};
const localStrong = {
  modelId: 'qwen2.5-coder:32b', source: 'local', quality: 0.88,
  costPer1kTokensUsd: 0, estLatencyMs: 800, available: true, local: true,
};
const cliStrong = {
  modelId: 'cli:claude:claude-sonnet-4.5', source: 'cli', quality: 0.92,
  costPer1kTokensUsd: 0, estLatencyMs: 900, available: true, local: false,
};
const cloudTop = {
  modelId: 'gpt-5', source: 'cloud', quality: 0.97,
  costPer1kTokensUsd: 0.005, estLatencyMs: 1200, available: true, local: false,
};
const cloudCheap = {
  modelId: 'gpt-5-mini', source: 'cloud', quality: 0.8,
  costPer1kTokensUsd: 0.0005, estLatencyMs: 600, available: true, local: false,
};
const unavailable = {
  modelId: 'dead-model', source: 'cloud', quality: 0.99,
  costPer1kTokensUsd: 0.001, estLatencyMs: 100, available: false, local: false,
};

const simpleTask = {
  kind: 'simple-chat', promptTokens: 200, needsToolUse: false,
  needsLongContext: false, qualityNeed: 0.2,
};
const hardTask = {
  kind: 'code', promptTokens: 9000, needsToolUse: true,
  needsLongContext: true, qualityNeed: 0.9,
};

test('classifyArchitectDifficulty: trivial -> hard', () => {
  assert.equal(classifyArchitectDifficulty(simpleTask).difficulty, 'trivial');
  assert.equal(classifyArchitectDifficulty(hardTask, 12).difficulty, 'hard');
  const medium = classifyArchitectDifficulty({
    kind: 'howto', promptTokens: 3000, needsToolUse: true,
    needsLongContext: false, qualityNeed: 0.5,
  }, 5);
  assert.equal(medium.difficulty, 'medium');
  assert.ok(medium.score > 0 && medium.score <= 1);
});

test('choosePlannerEditorPair: planner manh nhat, editor local re nhat', () => {
  const { pair, overBudget } = choosePlannerEditorPair(
    [localCheap, localStrong, cliStrong, cloudTop, cloudCheap, unavailable], hardTask, { fileScopeSize: 12 },
  );
  assert.equal(pair.difficulty, 'hard');
  assert.equal(pair.planner.modelId, 'gpt-5');
  assert.equal(pair.editor.modelId, 'qwen2.5-coder:32b');
  assert.equal(pair.singleModel, false);
  assert.equal(overBudget, false);
  assert.ok(pair.estimatedCostUsd > 0);
  assert.match(pair.rationale, /hard/);
});

test('choosePlannerEditorPair: task de dung single-model khi editor du manh', () => {
  const { pair } = choosePlannerEditorPair(
    [localStrong, cloudTop], simpleTask,
  );
  // localStrong quality 0.88 >= planner bar trivial 0.5, nhung planner
  // chon quality cao nhat (cloudTop) nen khong single-model.
  assert.equal(pair.planner.modelId, 'gpt-5');
  assert.equal(pair.singleModel, false);
  const solo = choosePlannerEditorPair([localStrong], simpleTask);
  assert.equal(solo.pair.singleModel, true);
  assert.equal(solo.pair.planner.modelId, solo.pair.editor.modelId);
});

test('choosePlannerEditorPair: overBudget + khong candidate -> throw', () => {
  const { pair, overBudget } = choosePlannerEditorPair(
    [cloudTop], hardTask, { budgetUsd: 0.000001 },
  );
  assert.equal(overBudget, true);
  assert.match(pair.rationale, /exceeds budget/);
  assert.throws(
    () => choosePlannerEditorPair([], hardTask),
    /No available model candidate/,
  );
  assert.throws(
    () => choosePlannerEditorPair([unavailable], hardTask),
    /No available model candidate/,
  );
});

test('choosePlannerEditorPair: editor ha cap khi khong ai dat nguong', () => {
  const weak = { ...localCheap, quality: 0.5 };
  const { pair } = choosePlannerEditorPair([weak, cloudCheap], hardTask);
  assert.equal(pair.editor.modelId, 'qwen2.5-coder:7b');
  assert.match(pair.rationale, /No editor meets/);
  assert.ok(ARCHITECT_MIN_EDITOR_QUALITY.hard > 0.5);
});

test('estimateArchitectTokens tang theo do kho', () => {
  assert.ok(estimateArchitectTokens('hard', 1000) > estimateArchitectTokens('trivial', 1000));
});

test('buildArchitectPlan: analyze -> edit theo thu muc -> test -> verify', () => {
  const plan = buildArchitectPlan(hardTask, ['src/a.ts', 'src/b.ts', 'lib/c.ts']);
  assert.equal(plan.difficulty, 'hard');
  assert.deepEqual(plan.fileScope, ['src/a.ts', 'src/b.ts', 'lib/c.ts']);
  assert.equal(plan.steps[0].kind, 'analyze');
  assert.equal(plan.steps.at(-1).kind, 'verify');
  const edits = plan.steps.filter((s) => s.kind === 'edit');
  assert.equal(edits.length, 2); // src + lib
  assert.ok(plan.steps.some((s) => s.kind === 'test'));
  // Moi step (tru analyze) deu phu thuoc step truoc no.
  for (const s of plan.steps.slice(1)) {
    assert.ok(s.dependsOn.length > 0, s.id);
    for (const d of s.dependsOn) {
      assert.ok(plan.steps.some((x) => x.id === d), d);
    }
  }
  assert.ok(plan.estimatedTokens > 0);
});

function okExecutors(changed = ['src/a.ts']) {
  return {
    plan: async () => { throw new Error('not used'); },
    edit: async () => ({ ok: true, summary: 'edited', changedFiles: changed, tokensUsed: 100 }),
    plannerFix: async () => ({ ok: true, summary: 'fixed by planner', changedFiles: changed, tokensUsed: 200 }),
  };
}

test('runArchitectEditor: happy path', async () => {
  const plan = buildArchitectPlan(
    { kind: 'code', promptTokens: 500, needsToolUse: true, needsLongContext: false, qualityNeed: 0.5 },
    ['src/a.ts'],
  );
  const { pair } = choosePlannerEditorPair([localCheap, cloudTop], hardTask);
  const report = await runArchitectEditor(plan, pair, okExecutors());
  assert.equal(report.ok, true);
  assert.ok(report.steps.every((s) => s.status === 'done'));
  assert.deepEqual(report.changedFiles, ['src/a.ts']);
  assert.ok(report.tokensUsed > 0);
  assert.equal(report.escalations, 0);
});

test('runArchitectEditor: editor fail 1 lan roi retry thanh cong', async () => {
  const plan = buildArchitectPlan(
    { kind: 'simple-chat', promptTokens: 100, needsToolUse: false, needsLongContext: false, qualityNeed: 0.2 },
    ['src/a.ts'],
  );
  const { pair } = choosePlannerEditorPair([localCheap, cloudTop], simpleTask);
  let calls = 0;
  const executors = {
    plan: async () => { throw new Error('not used'); },
    edit: async (step) => {
      calls += 1;
      if (step.kind === 'edit' && calls <= 2) {
        return { ok: false, summary: '', changedFiles: [], tokensUsed: 10, error: 'flaky edit' };
      }
      return { ok: true, summary: 'ok', changedFiles: ['src/a.ts'], tokensUsed: 10 };
    },
    plannerFix: async () => ({ ok: true, summary: 'fixed', changedFiles: [], tokensUsed: 5 }),
  };
  const report = await runArchitectEditor(plan, pair, executors, { editorRetries: 2 });
  assert.equal(report.ok, true);
  assert.equal(report.escalations, 0);
  const editStep = report.steps.find((s) => s.step.kind === 'edit');
  assert.ok(editStep && editStep.attempts >= 2);
});

test('runArchitectEditor: editor fail het -> escalate len planner', async () => {
  const plan = buildArchitectPlan(
    { kind: 'code', promptTokens: 500, needsToolUse: false, needsLongContext: false, qualityNeed: 0.5 },
    ['src/a.ts'],
  );
  const { pair } = choosePlannerEditorPair([localCheap, cloudTop], hardTask);
  const executors = {
    plan: async () => { throw new Error('not used'); },
    edit: async (step) => {
      if (step.kind === 'edit') {
        return { ok: false, summary: '', changedFiles: [], tokensUsed: 10, error: 'editor cannot do this' };
      }
      return { ok: true, summary: 'ok', changedFiles: [], tokensUsed: 10 };
    },
    plannerFix: async () => ({ ok: true, summary: 'planner fixed it', changedFiles: ['src/a.ts'], tokensUsed: 50 }),
  };
  const report = await runArchitectEditor(plan, pair, executors, { editorRetries: 0 });
  assert.equal(report.ok, true);
  assert.equal(report.escalations, 1);
  const editStep = report.steps.find((s) => s.step.kind === 'edit');
  assert.equal(editStep.status, 'done-by-planner');
  assert.equal(editStep.escalated, true);
});

test('runArchitectEditor: escalate fail -> doi editor manh hon', async () => {
  const plan = buildArchitectPlan(
    { kind: 'code', promptTokens: 500, needsToolUse: false, needsLongContext: false, qualityNeed: 0.5 },
    ['src/a.ts'],
  );
  const { pair } = choosePlannerEditorPair([localCheap, cloudTop], hardTask);
  let editCalls = 0;
  const executors = {
    plan: async () => { throw new Error('not used'); },
    edit: async (step) => {
      if (step.kind !== 'edit') return { ok: true, summary: 'ok', changedFiles: [], tokensUsed: 10 };
      editCalls += 1;
      // Lan dau (editor yeu) fail; lan sau (editor manh) thanh cong.
      if (editCalls <= 1) {
        return { ok: false, summary: '', changedFiles: [], tokensUsed: 10, error: 'too hard' };
      }
      return { ok: true, summary: 'ok', changedFiles: ['src/a.ts'], tokensUsed: 10 };
    },
    plannerFix: async () => ({ ok: false, summary: '', changedFiles: [], tokensUsed: 5, error: 'planner busy' }),
  };
  const report = await runArchitectEditor(plan, pair, executors, {
    editorRetries: 0, strongerEditor: localStrong,
  });
  assert.equal(report.ok, true);
  assert.equal(report.strongerEditorSteps, 1);
  const editStep = report.steps.find((s) => s.step.kind === 'edit');
  assert.equal(editStep.status, 'done-by-stronger-editor');
});

test('runArchitectEditor: moi escalation deu fail -> run failed, step sau skipped', async () => {
  const plan = buildArchitectPlan(
    { kind: 'code', promptTokens: 500, needsToolUse: true, needsLongContext: false, qualityNeed: 0.5 },
    ['src/a.ts'],
  );
  const { pair } = choosePlannerEditorPair([localCheap, cloudTop], hardTask);
  const executors = {
    plan: async () => { throw new Error('not used'); },
    edit: async (step) => {
      if (step.kind === 'edit') return { ok: false, summary: '', changedFiles: [], tokensUsed: 5, error: 'boom' };
      return { ok: true, summary: 'ok', changedFiles: [], tokensUsed: 5 };
    },
    plannerFix: async () => ({ ok: false, summary: '', changedFiles: [], tokensUsed: 5, error: 'also boom' }),
  };
  const report = await runArchitectEditor(plan, pair, executors, { editorRetries: 0, allowStrongerEditor: false });
  assert.equal(report.ok, false);
  assert.match(report.stoppedReason ?? '', /failed/);
  assert.ok(report.steps.some((s) => s.status === 'failed'));
  assert.ok(report.steps.some((s) => s.status === 'skipped'));
});

test('runArchitectEditor: het budget token thi dung', async () => {
  const plan = buildArchitectPlan(simpleTask, ['src/a.ts']);
  const { pair } = choosePlannerEditorPair([localCheap, cloudTop], simpleTask);
  const report = await runArchitectEditor(plan, pair, okExecutors(), { maxTokens: 50 });
  assert.equal(report.ok, false);
  assert.match(report.stoppedReason ?? '', /budget/);
});

test('runArchitectEditor: verify fail danh run failed', async () => {
  const plan = buildArchitectPlan(simpleTask, ['src/a.ts']);
  const { pair } = choosePlannerEditorPair([localCheap, cloudTop], simpleTask);
  const report = await runArchitectEditor(plan, pair, {
    ...okExecutors(),
    verify: async () => ({ ok: false, notes: 'tests still failing' }),
  });
  assert.equal(report.ok, false);
  assert.match(report.stoppedReason ?? '', /Verification failed/);
});
