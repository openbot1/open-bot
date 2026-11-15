/**
 * Tests for coding agent v2 — architect mode (v1.08, Đội T2):
 * `packages/core/src/codingV2/architect.ts` (planner/editor split,
 * plan validation, step execution through the confined Workspace,
 * planner diff review, deviation -> blocked).
 *
 * No model, no network, no git. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v2-architect.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CodingV2ArchitectSession,
  codingV2ArchitectDefaultPersistDir,
  createCodingV2ArchitectPlan,
  codingV2ArchitectProgress,
  diffCodingV2LineCounts,
  isValidCodingV2PlanPath,
  nextCodingV2ArchitectStep,
  parseCodingV2ArchitectPlan,
  reviewCodingV2StepDiff,
  serializeCodingV2ArchitectPlan,
  validateCodingV2PlanInput,
} from '../packages/core/dist/codingV2/architect.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-v2-arch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const STEPS = [
  { kind: 'explore', description: 'Look at the code', files: [] },
  { kind: 'implement', description: 'Add the feature', files: ['src/feature.ts'] },
  { kind: 'verify', description: 'Run checks', files: [] },
  { kind: 'finish', description: 'Summarize', files: [] },
];

// --- Path + input validation -------------------------------------------------

test('plan paths: relative ok; absolute / .. / empty rejected', () => {
  assert.equal(isValidCodingV2PlanPath('src/a.ts'), true);
  assert.equal(isValidCodingV2PlanPath('a.ts'), true);
  assert.equal(isValidCodingV2PlanPath('/abs/a.ts'), false);
  assert.equal(isValidCodingV2PlanPath('../escape.ts'), false);
  assert.equal(isValidCodingV2PlanPath('src/../escape.ts'), false);
  assert.equal(isValidCodingV2PlanPath(''), false);
  assert.equal(isValidCodingV2PlanPath('src//a.ts'), false);
});

test('plan validation: empty task, no steps, bad kind, empty implement files', () => {
  assert.ok(validateCodingV2PlanInput('', STEPS).length > 0);
  assert.ok(validateCodingV2PlanInput('task', []).length > 0);
  assert.ok(
    validateCodingV2PlanInput('task', [{ kind: 'hack', description: 'x' }]).length > 0,
  );
  assert.ok(
    validateCodingV2PlanInput('task', [{ kind: 'implement', description: 'x', files: [] }]).length > 0,
  );
  assert.ok(
    validateCodingV2PlanInput('task', [
      { kind: 'implement', description: 'x', files: ['ok.ts', '../bad.ts'] },
    ]).length > 0,
  );
  assert.ok(
    validateCodingV2PlanInput('task', [
      { kind: 'implement', description: 'x', files: ['dup.ts', 'dup.ts'] },
    ]).length > 0,
  );
  assert.deepEqual(validateCodingV2PlanInput('task', STEPS), []);
});

test('create plan: deterministic shape, draft status, unique step ids', () => {
  const plan = createCodingV2ArchitectPlan('Build it', STEPS);
  assert.equal(plan.status, 'draft');
  assert.equal(plan.steps.length, 4);
  assert.equal(new Set(plan.steps.map((s) => s.id)).size, 4);
  assert.ok(plan.steps.every((s) => s.status === 'pending'));
  assert.throws(() => createCodingV2ArchitectPlan('', STEPS), /không được rỗng/);
});

// --- Line diff ----------------------------------------------------------------

test('line diff: multiset counts added/removed lines', () => {
  assert.deepEqual(diffCodingV2LineCounts('a\nb\nc', 'a\nb\nc\nd'), { linesAdded: 1, linesRemoved: 0 });
  assert.deepEqual(diffCodingV2LineCounts('a\nb\nc', 'a\nc'), { linesAdded: 0, linesRemoved: 1 });
  assert.deepEqual(diffCodingV2LineCounts(null, 'x\ny'), { linesAdded: 2, linesRemoved: 0 });
  assert.deepEqual(diffCodingV2LineCounts('x\ny', null), { linesAdded: 0, linesRemoved: 2 });
  assert.deepEqual(diffCodingV2LineCounts('same', 'same'), { linesAdded: 0, linesRemoved: 0 });
  // Duplicated lines: removing one of two identical lines counts 1.
  assert.deepEqual(diffCodingV2LineCounts('a\na\nb', 'a\nb'), { linesAdded: 0, linesRemoved: 1 });
});

// --- Diff review ---------------------------------------------------------------

test('review: approved when every changed file was declared', () => {
  const plan = createCodingV2ArchitectPlan('t', STEPS);
  const step = plan.steps[1];
  const review = reviewCodingV2StepDiff(plan.id, step, [
    { path: 'src/feature.ts', kind: 'created', linesAdded: 10, linesRemoved: 0 },
  ]);
  assert.equal(review.verdict, 'approved');
  assert.deepEqual(review.deviations, []);
});

test('review: deviation when a file outside the plan changed', () => {
  const plan = createCodingV2ArchitectPlan('t', STEPS);
  const step = plan.steps[1];
  const review = reviewCodingV2StepDiff(plan.id, step, [
    { path: 'src/feature.ts', kind: 'created', linesAdded: 10, linesRemoved: 0 },
    { path: 'src/secret.ts', kind: 'modified', linesAdded: 1, linesRemoved: 0 },
  ]);
  assert.equal(review.verdict, 'deviation');
  assert.ok(review.deviations.some((d) => d.includes('src/secret.ts')));
});

test('review: deviation when the step changes too many lines', () => {
  const plan = createCodingV2ArchitectPlan('t', STEPS);
  const step = plan.steps[1];
  const review = reviewCodingV2StepDiff(
    plan.id,
    step,
    [{ path: 'src/feature.ts', kind: 'created', linesAdded: 6000, linesRemoved: 0 }],
    { maxLineChanges: 5000 },
  );
  assert.equal(review.verdict, 'deviation');
  assert.ok(review.deviations.some((d) => d.includes('6000')));
});

// --- Session: happy path ---------------------------------------------------------

test('session: execute steps in order, plan completes', (t) => {
  const dir = tmpDir(t);
  const session = new CodingV2ArchitectSession(dir);
  const plan = session.createPlan('Add feature', [
    { kind: 'implement', description: 'Create the file', files: ['src/feature.ts'] },
    { kind: 'finish', description: 'Done', files: [] },
  ]);
  const step = plan.steps[0];
  const result = session.executeStep(plan.id, step.id, [
    { path: 'src/feature.ts', kind: 'create', content: 'export const x = 1;\n' },
  ]);
  assert.equal(result.review.verdict, 'approved');
  assert.equal(step.status, 'done');
  assert.equal(plan.status, 'active');
  assert.equal(fs.readFileSync(path.join(dir, 'src/feature.ts'), 'utf8'), 'export const x = 1;\n');
  assert.ok(result.summary.includes('xong'));
  assert.ok(codingV2ArchitectProgress(plan) > 0);

  const finish = session.executeStep(plan.id, plan.steps[1].id, [
    { path: 'src/feature.ts', kind: 'edit', oldText: 'export const x = 1;', newText: 'export const x = 2;' },
  ]);
  // The finish step declared no files, so editing one is a deviation.
  assert.equal(finish.review.verdict, 'deviation');
  assert.equal(plan.status, 'blocked');
});

test('session: plan completes when every step is done', (t) => {
  const dir = tmpDir(t);
  const session = new CodingV2ArchitectSession(dir);
  const plan = session.createPlan('One step', [
    { kind: 'implement', description: 'Write it', files: ['a.txt'] },
  ]);
  session.executeStep(plan.id, plan.steps[0].id, [
    { path: 'a.txt', kind: 'create', content: 'hi\n' },
  ]);
  assert.equal(plan.status, 'done');
  assert.equal(codingV2ArchitectProgress(plan), 1);
  assert.equal(nextCodingV2ArchitectStep(plan), null);
});

test('session: edit + delete edits apply and are reviewed', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'old.txt'), 'keep\nremove\n');
  const session = new CodingV2ArchitectSession(dir);
  const plan = session.createPlan('Rework', [
    { kind: 'implement', description: 'Edit then delete', files: ['old.txt', 'new.txt'] },
  ]);
  const result = session.executeStep(plan.id, plan.steps[0].id, [
    { path: 'old.txt', kind: 'edit', oldText: 'remove\n', newText: '' },
    { path: 'new.txt', kind: 'create', content: 'fresh\n' },
  ]);
  assert.equal(result.review.verdict, 'approved');
  assert.equal(fs.readFileSync(path.join(dir, 'old.txt'), 'utf8'), 'keep\n');
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), true);
  const del = session.createPlan('Cleanup', [
    { kind: 'implement', description: 'Delete it', files: ['new.txt'] },
  ]);
  const delResult = session.executeStep(del.id, del.steps[0].id, [
    { path: 'new.txt', kind: 'delete' },
  ]);
  assert.equal(delResult.review.verdict, 'approved');
  assert.equal(delResult.review.filesChanged[0].kind, 'deleted');
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);
});

// --- Session: deviation + errors -------------------------------------------------

test('session: editing an undeclared file blocks the plan', (t) => {
  const dir = tmpDir(t);
  const session = new CodingV2ArchitectSession(dir);
  const plan = session.createPlan('Scoped work', [
    { kind: 'implement', description: 'Only touch a.txt', files: ['a.txt'] },
    { kind: 'implement', description: 'Then b.txt', files: ['b.txt'] },
  ]);
  const result = session.executeStep(plan.id, plan.steps[0].id, [
    { path: 'a.txt', kind: 'create', content: 'a\n' },
    { path: 'sneaky.txt', kind: 'create', content: 'not in the plan\n' },
  ]);
  assert.equal(result.review.verdict, 'deviation');
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.steps[0].status, 'failed');
  // A blocked plan refuses further execution until replanned.
  assert.throws(
    () =>
      session.executeStep(plan.id, plan.steps[1].id, [
        { path: 'b.txt', kind: 'create', content: 'b\n' },
      ]),
    /blocked/,
  );
  // The file WAS created (the edit happened); the planner stopped the
  // run, it did not roll back — the user decides, via git revert.
  assert.equal(fs.existsSync(path.join(dir, 'sneaky.txt')), true);
  assert.equal(session.reviewsFor(plan.id).length, 1);
});

test('session: edit that fails to apply marks the step failed, plan stays active', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  const session = new CodingV2ArchitectSession(dir);
  const plan = session.createPlan('Fix', [
    { kind: 'implement', description: 'Replace text', files: ['a.txt'] },
  ]);
  const result = session.executeStep(plan.id, plan.steps[0].id, [
    { path: 'a.txt', kind: 'edit', oldText: 'does-not-exist', newText: 'x' },
  ]);
  assert.equal(result.review.verdict, 'deviation');
  assert.equal(plan.steps[0].status, 'failed');
  assert.equal(plan.status, 'active', 'apply error is not a plan deviation — planner may retry');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello\n');
});

test('session: unknown plan/step, empty edits, done step, path escape all throw', (t) => {
  const dir = tmpDir(t);
  const session = new CodingV2ArchitectSession(dir);
  const plan = session.createPlan('T', [
    { kind: 'implement', description: 'Do', files: ['a.txt'] },
    { kind: 'implement', description: 'Do more', files: ['b.txt'] },
  ]);
  assert.throws(() => session.executeStep('nope', plan.steps[0].id, []), /Không tìm thấy plan/);
  assert.throws(() => session.executeStep(plan.id, 'nope', []), /Không tìm thấy bước/);
  assert.throws(
    () => session.executeStep(plan.id, plan.steps[0].id, []),
    /ít nhất 1 edit/,
  );
  assert.throws(
    () =>
      session.executeStep(plan.id, plan.steps[0].id, [
        { path: '../escape.txt', kind: 'create', content: 'x' },
      ]),
    /không hợp lệ/,
  );
  session.executeStep(plan.id, plan.steps[0].id, [
    { path: 'a.txt', kind: 'create', content: 'a\n' },
  ]);
  assert.throws(
    () =>
      session.executeStep(plan.id, plan.steps[0].id, [
        { path: 'a.txt', kind: 'edit', oldText: 'a', newText: 'b' },
      ]),
    /đã xong/,
  );
});

test('session: skipStep marks skipped and can finish a plan', (t) => {
  const dir = tmpDir(t);
  const session = new CodingV2ArchitectSession(dir);
  const plan = session.createPlan('T', [
    { kind: 'explore', description: 'Look', files: [] },
    { kind: 'finish', description: 'End', files: [] },
  ]);
  session.skipStep(plan.id, plan.steps[0].id, 'not needed');
  assert.equal(plan.steps[0].status, 'skipped');
  assert.equal(session.listPlans().length, 1);
  assert.equal(session.getPlan(plan.id)?.id, plan.id);
  session.skipStep(plan.id, plan.steps[1].id);
  assert.equal(plan.status, 'done');
});

// --- Persistence ------------------------------------------------------------------

test('persist: serialize -> parse round-trip keeps plan + reviews', () => {
  const plan = createCodingV2ArchitectPlan('T', STEPS);
  const review = {
    planId: plan.id,
    stepId: plan.steps[0].id,
    verdict: 'approved',
    filesChanged: [{ path: 'a.ts', kind: 'created', linesAdded: 3, linesRemoved: 0 }],
    deviations: [],
    reviewedAt: new Date().toISOString(),
  };
  const text = serializeCodingV2ArchitectPlan({ plan, reviews: [review] });
  const parsed = parseCodingV2ArchitectPlan(text);
  assert.ok('record' in parsed);
  if ('record' in parsed) {
    assert.equal(parsed.record.plan.id, plan.id);
    assert.equal(parsed.record.plan.steps.length, 4);
    assert.equal(parsed.record.reviews.length, 1);
    assert.equal(parsed.record.reviews[0].verdict, 'approved');
  }
});

test('persist: broken JSON / wrong shape rejected, not thrown', () => {
  assert.ok('error' in parseCodingV2ArchitectPlan('{nope'));
  assert.ok('error' in parseCodingV2ArchitectPlan('[]'));
  assert.ok('error' in parseCodingV2ArchitectPlan(JSON.stringify({ plan: { id: 'x' } })));
  assert.ok('error' in parseCodingV2ArchitectPlan(JSON.stringify({
    plan: { id: 'x', task: 't', steps: [{ id: 's', kind: 'hack', description: 'd', files: [], status: 'pending' }], status: 'draft', createdAt: '', updatedAt: '' },
    reviews: [],
  })));
});

test('persist: plan survives a new session on the same workspace', (t) => {
  const dir = tmpDir(t);
  const first = new CodingV2ArchitectSession(dir);
  assert.equal(
    first.persistDir,
    codingV2ArchitectDefaultPersistDir(dir),
    'default persist dir is .open-bot/coding-v2/plans in the workspace',
  );
  const plan = first.createPlan('Keep me', [
    { kind: 'implement', description: 'Write it', files: ['a.txt'] },
  ]);
  first.executeStep(plan.id, plan.steps[0].id, [
    { path: 'a.txt', kind: 'create', content: 'hi\n' },
  ]);
  const planFile = path.join(dir, '.open-bot', 'coding-v2', 'plans', `${plan.id}.json`);
  assert.equal(fs.existsSync(planFile), true, 'plan file must exist on disk after execute');

  const second = new CodingV2ArchitectSession(dir);
  const loaded = second.getPlan(plan.id);
  assert.ok(loaded, 'plan must load from disk in a new session');
  assert.equal(loaded.status, 'done');
  assert.equal(loaded.steps[0].status, 'done');
  assert.equal(second.reviewsFor(plan.id).length, 1);
  assert.equal(second.reviewsFor(plan.id)[0].verdict, 'approved');
  assert.equal(second.lastPersistError, null);
});

test('persist: corrupt plan file is skipped, valid ones still load', (t) => {
  const dir = tmpDir(t);
  const first = new CodingV2ArchitectSession(dir);
  const plan = first.createPlan('Good', [
    { kind: 'implement', description: 'Write it', files: ['a.txt'] },
  ]);
  const plansDir = path.join(dir, '.open-bot', 'coding-v2', 'plans');
  fs.writeFileSync(path.join(plansDir, 'corrupt.json'), '{broken json');
  const second = new CodingV2ArchitectSession(dir);
  assert.ok(second.getPlan(plan.id), 'valid plan still loads');
  assert.equal(second.listPlans().length, 1, 'corrupt file is skipped, not counted');
});

test('persist: persistDir null disables disk writes', (t) => {
  const dir = tmpDir(t);
  const session = new CodingV2ArchitectSession(dir, { persistDir: null });
  assert.equal(session.persistDir, null);
  session.createPlan('Ephemeral', [
    { kind: 'implement', description: 'Write it', files: ['a.txt'] },
  ]);
  assert.equal(fs.existsSync(path.join(dir, '.open-bot')), false);
});
