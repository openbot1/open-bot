/**
 * Tests cho coding agent v11 (v1.19, Đội T2-TEST vòng 6): multi-file
 * refactor (`packages/core/src/codingV11/refactorV11.ts`) — đổi tên
 * symbol xuyên file, tách file, di chuyển hàm, kiểm tra tham chiếu
 * đầy đủ, preview diff, apply (backup + verify + rollback qua v8).
 *
 * Chạy thật (không mock): repo TS thật trong thư mục tạm, git thật
 * cho test commit. Không chạy build/typecheck/full-suite (máy quá
 * tải): dist bundle nhẹ bằng esbuild (gitignored, xem ghi chú ở
 * tests/coding-v11-codeact.test.mjs).
 *
 *   node --test tests/coding-v11-refactor.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Commit git của v9 kế thừa process.env — cần identity như test v5.
process.env.GIT_AUTHOR_NAME ??= 'test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

import {
  CodingV11Error,
  V11RefactorEngine,
  renameV11Symbol,
  v11IsValidIdentifier,
  v11NewRefactorPlanId,
  v11RelativeImport,
} from '../packages/core/dist/codingV11/index.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function readFile(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

function initGitRepo(dir) {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "v11-test@open-bot.local"', { cwd: dir });
  execSync('git config user.name "v11-test"', { cwd: dir });
}

const MATH_TS = `export function add(a: number, b: number): number {
  return a + b;
}

export function mul(a: number, b: number): number {
  return a * b;
}

// add helper — comment chứa tên add, không được đổi
export const label = 'add and mul';
`;

const USE_TS = `import { add, mul } from './math';

export function total(x: number): number {
  return add(x, 1) + mul(x, 2);
}
`;

const OPS_TS = `export function sub(a: number, b: number): number {
  return a - b;
}
`;

const EXTRA_TS = `export function add(a: number, b: number): number {
  return a + b + 100;
}
`;

/** Repo mẫu: math.ts (add/mul/label) + use.ts (import + gọi cả hai). */
function makeRepo({ extra = false, ops = false } = {}) {
  const dir = tmpDir('v11-ref-');
  writeFile(dir, 'src/math.ts', MATH_TS);
  writeFile(dir, 'src/use.ts', USE_TS);
  if (extra) writeFile(dir, 'src/extra.ts', EXTRA_TS);
  if (ops) writeFile(dir, 'src/ops.ts', OPS_TS);
  return dir;
}

test('v11NewRefactorPlanId: định dạng v11ref-<hex 12> và duy nhất', () => {
  const a = v11NewRefactorPlanId();
  assert.match(a, /^v11ref-[0-9a-f]{12}$/);
  assert.notEqual(a, v11NewRefactorPlanId());
});

test('v11IsValidIdentifier: chỉ chấp nhận identifier JS/TS hợp lệ', () => {
  assert.equal(v11IsValidIdentifier('sum'), true);
  assert.equal(v11IsValidIdentifier('_private'), true);
  assert.equal(v11IsValidIdentifier('$x'), true);
  assert.equal(v11IsValidIdentifier('a1'), true);
  assert.equal(v11IsValidIdentifier('1bad'), false);
  assert.equal(v11IsValidIdentifier('has space'), false);
  assert.equal(v11IsValidIdentifier('has-dash'), false);
  assert.equal(v11IsValidIdentifier(''), false);
});

test('v11RelativeImport: đường tương đối, bỏ đuôi file, thêm ./ khi cần', () => {
  assert.equal(v11RelativeImport('src/math.ts', 'src/ops.ts'), './ops');
  assert.equal(v11RelativeImport('src/math.ts', 'src/deep/util.ts'), './deep/util');
  assert.equal(v11RelativeImport('src/deep/a.ts', 'src/math.ts'), '../math');
  assert.equal(v11RelativeImport('src/a.ts', 'src/b.mjs'), './b');
  assert.equal(v11RelativeImport('a.ts', 'b.ts'), './b');
});

test('checkReferences: tìm định nghĩa + import + lời gọi, string/comment không tính', () => {
  const dir = makeRepo();
  const engine = new V11RefactorEngine({ workingDir: dir });
  const check = engine.checkReferences('add', 'src/math.ts');
  assert.equal(check.symbol, 'add');
  assert.equal(check.definitionFile, 'src/math.ts');
  assert.equal(check.filesAffected, 2);
  assert.equal(check.ambiguous, false);
  assert.deepEqual(check.unresolved, []);
  const roles = check.references.map((r) => r.role);
  assert.ok(roles.includes('definition'), 'phải có definition');
  assert.ok(roles.includes('import'), 'phải có import ở use.ts');
  assert.ok(roles.includes('call'), 'phải có call ở use.ts');
  const def = check.references.find((r) => r.role === 'definition');
  assert.equal(def.file, 'src/math.ts');
  assert.equal(def.line, 1);
  const call = check.references.find((r) => r.role === 'call');
  assert.equal(call.file, 'src/use.ts');
  // String 'add and mul' và comment '// add helper' đã bị mask — không thành tham chiếu.
  assert.equal(check.references.some((r) => r.lineText.includes('label')), false);
  assert.equal(check.references.some((r) => r.lineText.includes('// add helper')), false);
});

test('checkReferences: ném lỗi khi symbol không có / mơ hồ không rõ file', () => {
  const dir = makeRepo({ extra: true });
  const engine = new V11RefactorEngine({ workingDir: dir });
  assert.throws(() => engine.checkReferences('noSuchSymbol'), /không tìm thấy symbol/);
  assert.throws(() => engine.checkReferences('add'), /định nghĩa ở 2 file/);
  // Chỉ rõ definitionFile thì hết mơ hồ (không ném).
  const check = engine.checkReferences('add', 'src/extra.ts');
  assert.equal(check.definitionFile, 'src/extra.ts');
  assert.equal(check.symbol, 'add');
  // Lưu ý hành vi thật: hai file cùng định nghĩa tên trần "add" thì
  // qualifiedName giống nhau nên check.ambiguous vẫn false — phát
  // hiện mơ hồ chỉ bắt symbol có qualifiedName khác nhau.
  assert.equal(check.ambiguous, false);
});

test('planRenameSymbol: preview đổi add → sum ở định nghĩa + import + lời gọi', () => {
  const dir = makeRepo();
  const engine = new V11RefactorEngine({ workingDir: dir });
  const plan = engine.planRenameSymbol('add', 'sum', 'src/math.ts');
  assert.equal(plan.kind, 'rename-symbol');
  assert.match(plan.id, /^v11ref-[0-9a-f]{12}$/);
  assert.equal(plan.changes.length, 2);
  const math = plan.changes.find((c) => c.path === 'src/math.ts');
  const use = plan.changes.find((c) => c.path === 'src/use.ts');
  assert.ok(math && use);
  assert.match(math.newContent, /export function sum\(/);
  assert.match(math.newContent, /'add and mul'/);
  assert.match(math.newContent, /\/\/ add helper/);
  assert.doesNotMatch(math.newContent, /export function add\(/);
  assert.match(math.diff, /sum/);
  assert.match(use.newContent, /import \{ sum, mul \} from '\.\/math';/);
  assert.match(use.newContent, /return sum\(x, 1\) \+ mul\(x, 2\);/);
  assert.doesNotMatch(use.newContent, /\badd\b/);
  assert.ok(plan.totalAdded > 0 && plan.totalRemoved > 0);
  assert.ok(plan.referenceCheck);
  // Chưa áp: đĩa không đổi.
  assert.equal(readFile(dir, 'src/math.ts'), MATH_TS);
});

test('planRenameSymbol: tên mới sai / trùng tên cũ thì ném lỗi', () => {
  const dir = makeRepo();
  const engine = new V11RefactorEngine({ workingDir: dir });
  assert.throws(() => engine.planRenameSymbol('add', '1bad', 'src/math.ts'), /không phải identifier hợp lệ/);
  assert.throws(() => engine.planRenameSymbol('add', 'has space', 'src/math.ts'), /không phải identifier hợp lệ/);
  assert.throws(() => engine.planRenameSymbol('add', 'add', 'src/math.ts'), /trùng tên cũ/);
  assert.throws(() => engine.planRenameSymbol('ghost', 'sum', 'src/math.ts'), /không tìm thấy symbol/);
});

test('applyPlan rename: áp thật add → sum, backup tồn tại, nội dung trên đĩa đổi', async () => {
  const dir = makeRepo();
  const engine = new V11RefactorEngine({ workingDir: dir });
  const plan = engine.planRenameSymbol('add', 'sum', 'src/math.ts');
  const result = await engine.applyPlan(plan);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'rename-symbol');
  assert.equal(result.planId, plan.id);
  assert.deepEqual([...result.filesChanged].sort(), ['src/math.ts', 'src/use.ts']);
  assert.ok(fs.existsSync(result.backupDir), 'phải có thư mục backup');
  assert.match(readFile(dir, 'src/math.ts'), /export function sum\(/);
  assert.match(readFile(dir, 'src/use.ts'), /return sum\(x, 1\)/);
  assert.match(readFile(dir, 'src/math.ts'), /'add and mul'/);
});

test('planSplitFile + apply: tách mul sang src/ops.ts, giữ re-export, sửa import', async () => {
  const dir = makeRepo();
  const engine = new V11RefactorEngine({ workingDir: dir });
  const plan = engine.planSplitFile('src/math.ts', ['mul'], 'src/ops.ts');
  assert.equal(plan.kind, 'split-file');
  assert.equal(plan.changes.length, 3);
  const math = plan.changes.find((c) => c.path === 'src/math.ts');
  const ops = plan.changes.find((c) => c.path === 'src/ops.ts');
  const use = plan.changes.find((c) => c.path === 'src/use.ts');
  assert.ok(math && ops && use);
  assert.doesNotMatch(math.newContent, /function mul/);
  assert.match(math.newContent, /export function add\(/);
  assert.match(math.newContent, /export \{ mul \} from '\.\/ops';/);
  assert.match(ops.newContent, /export function mul\(/);
  assert.doesNotMatch(ops.newContent, /function add/);
  assert.equal(ops.oldContent, null);
  // use.ts import lẫn add (ở lại) + mul (đi): tách thành 2 dòng import.
  assert.match(use.newContent, /import \{ add \} from '\.\/math';/);
  assert.match(use.newContent, /import \{ mul \} from '\.\/ops';/);

  const result = await engine.applyPlan(plan);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'src/ops.ts')), true);
  assert.match(readFile(dir, 'src/math.ts'), /export \{ mul \} from '\.\/ops';/);
  assert.match(readFile(dir, 'src/ops.ts'), /export function mul\(/);
  assert.match(readFile(dir, 'src/use.ts'), /import \{ mul \} from '\.\/ops';/);
  assert.match(readFile(dir, 'src/use.ts'), /return add\(x, 1\) \+ mul\(x, 2\);/);
});

test('planSplitFile: lỗi khi đích đã tồn tại / symbol không có / rỗng / trùng file / thoát workspace', () => {
  const dir = makeRepo({ ops: true });
  const engine = new V11RefactorEngine({ workingDir: dir });
  assert.throws(() => engine.planSplitFile('src/math.ts', ['mul'], 'src/ops.ts'), /file đích đã tồn tại/);
  assert.throws(() => engine.planSplitFile('src/math.ts', ['ghost'], 'src/new.ts'), /không tìm thấy symbol/);
  assert.throws(() => engine.planSplitFile('src/math.ts', [], 'src/new.ts'), /chưa chọn symbol/);
  assert.throws(() => engine.planSplitFile('src/math.ts', ['mul'], 'src/math.ts'), /trùng file nguồn/);
  assert.throws(() => engine.planSplitFile('src/math.ts', ['mul'], '../outside.ts'), /thoát workspace/);
  assert.throws(() => engine.planSplitFile('src/ghost.ts', ['mul'], 'src/new.ts'), /không tìm thấy file nguồn/);
});

test('planMoveFunction + apply: chuyển mul sang src/ops.ts có sẵn, cập nhật import', async () => {
  const dir = makeRepo({ ops: true });
  const engine = new V11RefactorEngine({ workingDir: dir });
  const plan = engine.planMoveFunction('mul', 'src/math.ts', 'src/ops.ts');
  assert.equal(plan.kind, 'move-function');
  const math = plan.changes.find((c) => c.path === 'src/math.ts');
  const ops = plan.changes.find((c) => c.path === 'src/ops.ts');
  const use = plan.changes.find((c) => c.path === 'src/use.ts');
  assert.ok(math && ops && use);
  assert.doesNotMatch(math.newContent, /function mul/);
  assert.match(math.newContent, /export \{ mul \} from '\.\/ops';/);
  assert.match(ops.newContent, /export function sub\(/);
  assert.match(ops.newContent, /export function mul\(/);
  assert.match(use.newContent, /import \{ mul \} from '\.\/ops';/);

  const result = await engine.applyPlan(plan);
  assert.equal(result.ok, true);
  assert.doesNotMatch(readFile(dir, 'src/math.ts'), /function mul/);
  assert.match(readFile(dir, 'src/ops.ts'), /export function mul\(/);
  assert.match(readFile(dir, 'src/use.ts'), /import \{ add \} from '\.\/math';/);
  assert.match(readFile(dir, 'src/use.ts'), /import \{ mul \} from '\.\/ops';/);
});

test('planMoveFunction: lỗi khi đích không tồn tại / trùng file / symbol không có', () => {
  const dir = makeRepo();
  const engine = new V11RefactorEngine({ workingDir: dir });
  assert.throws(() => engine.planMoveFunction('mul', 'src/math.ts', 'src/nope.ts'), /không tìm thấy file đích/);
  assert.throws(() => engine.planMoveFunction('mul', 'src/math.ts', 'src/math.ts'), /trùng file nguồn/);
  assert.throws(() => engine.planMoveFunction('ghost', 'src/math.ts', 'src/use.ts'), /không tìm thấy symbol/);
});

test('renameV11Symbol helper: lập plan + apply trong một lần gọi', async () => {
  const dir = makeRepo();
  const { plan, result } = await renameV11Symbol(dir, 'mul', 'times', 'src/math.ts');
  assert.equal(plan.kind, 'rename-symbol');
  assert.equal(result.ok, true);
  assert.match(readFile(dir, 'src/math.ts'), /export function times\(/);
  assert.match(readFile(dir, 'src/use.ts'), /import \{ add, times \} from '\.\/math';/);
  assert.match(readFile(dir, 'src/use.ts'), /times\(x, 2\)/);
});

test('applyPlan verify fail: rollback tự động, file trên đĩa không đổi', async () => {
  const dir = makeRepo();
  const engine = new V11RefactorEngine({ workingDir: dir });
  const plan = engine.planRenameSymbol('add', 'sum', 'src/math.ts');
  const result = await engine.applyPlan(plan, {
    verify: () => ({ ok: false, output: 'v11 test: verify cố tình fail' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /verify fail/);
  assert.equal(readFile(dir, 'src/math.ts'), MATH_TS);
  assert.equal(readFile(dir, 'src/use.ts'), USE_TS);
});

test('applyPlan verify fail + concurrent edit: returns failure, preserves edit, and skips commit', async () => {
  const dir = makeRepo();
  initGitRepo(dir);
  execSync('git add -A && git commit -qm "init"', { cwd: dir });
  const engine = new V11RefactorEngine({ workingDir: dir });
  const plan = engine.planRenameSymbol('add', 'sum', 'src/math.ts');
  const concurrentUseEdit = '// concurrent edit during verification\\n';

  const result = await engine.applyPlan(plan, {
    commit: true,
    commitMessage: 'must not commit incomplete rollback',
    verify: () => {
      // Simulate another actor changing a file after V8 applied the plan,
      // but before automatic rollback processes the failed verification.
      writeFile(dir, 'src/use.ts', concurrentUseEdit);
      return { ok: false, output: 'verify failed after concurrent edit' };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /rollback incomplete/);
  assert.equal(readFile(dir, 'src/math.ts'), MATH_TS);
  assert.equal(readFile(dir, 'src/use.ts'), concurrentUseEdit);
  assert.equal(
    execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf8' }).trim(),
    'init',
    'an incomplete rollback must not proceed to commit',
  );
});

test('applyPlan commit: rename + commit atomic, git log có message', async () => {
  const dir = makeRepo();
  initGitRepo(dir);
  execSync('git add -A && git commit -qm "init"', { cwd: dir });
  const engine = new V11RefactorEngine({ workingDir: dir });
  const plan = engine.planRenameSymbol('add', 'sum', 'src/math.ts');
  const result = await engine.applyPlan(plan, { commit: true, commitMessage: 'refactor: rename add to sum' });
  assert.equal(result.ok, true);
  assert.match(result.commitSha, /^[0-9a-f]{40}$/);
  const log = execSync('git log --oneline -1', { cwd: dir, encoding: 'utf8' });
  assert.match(log, /refactor: rename add to sum/);
  assert.match(readFile(dir, 'src/math.ts'), /export function sum\(/);
});
