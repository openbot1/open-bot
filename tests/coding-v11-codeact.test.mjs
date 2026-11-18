/**
 * Tests cho coding agent v11 (v1.19, Đội T2-TEST vòng 6): CodeAct v9
 * (`packages/core/src/codingV11/codeactV9.ts`) — validate plan,
 * mức rủi ro + xác nhận, dry-run (mô phỏng, preview diff, chặn
 * path ngoài workspace / lệnh ngoài allowlist / deny-list), apply
 * tuần tự (ghi/đọc/append/xóa/di chuyển file, run-code, run-command,
 * git-commit), dừng ở lỗi đầu tiên, rollback theo patch stack.
 *
 * Chạy thật (không mock): file thật trong thư mục tạm, `node` thật,
 * git thật. Không chạy build/typecheck/full-suite (máy quá tải):
 * dist dùng cho test được bundle nhẹ bằng esbuild (gitignored):
 *   ./node_modules/.bin/esbuild packages/core/src/codingV11/index.ts \
 *     --bundle --platform=node --format=esm \
 *     --outfile=packages/core/dist/codingV11/index.js
 * (merge chính thức vẫn build bằng tsc như mọi wave trước.)
 *
 *   node --test tests/coding-v11-codeact.test.mjs
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
  V11_CODEACT_DEFAULT_COMMAND_TIMEOUT_MS,
  V11_CODEACT_MAX_ACTIONS_PER_PLAN,
  V11CodeActEngine,
  dryRunV11CodeActPlan,
  runV11CodeActPlan,
  v11ActionRisk,
  v11NeedsConfirmation,
  v11NewCodeActPlanId,
  validateV11CodeActPlan,
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

function plan(actions, id = 'p1') {
  return { id, title: 'test plan', actions };
}

function act(id, kind, extra = {}) {
  return { id, kind, ...extra };
}

test('v11NewCodeActPlanId: định dạng v11ca-<hex 12> và duy nhất', () => {
  const a = v11NewCodeActPlanId();
  const b = v11NewCodeActPlanId();
  assert.match(a, /^v11ca-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

test('validateV11CodeActPlan: ném CodingV11Error khi plan sai định dạng', () => {
  assert.throws(() => validateV11CodeActPlan({ actions: [act('a', 'read-file', { path: 'x' })] }), CodingV11Error);
  assert.throws(() => validateV11CodeActPlan({ id: '  ', actions: [act('a', 'read-file', { path: 'x' })] }), CodingV11Error);
  assert.throws(() => validateV11CodeActPlan({ id: 'p', actions: 'nope' }), CodingV11Error);
  assert.throws(() => validateV11CodeActPlan({ id: 'p', actions: [] }), CodingV11Error);
  assert.throws(
    () => validateV11CodeActPlan({ id: 'p', actions: [act('a', 'read-file', { path: 'x' }), act('a', 'write-file', { path: 'y', content: 'z' })] }),
    /trùng id action/,
  );
  assert.throws(
    () => validateV11CodeActPlan({ id: 'p', actions: [act('a', 'teleport', {})] }),
    /kind action không hợp lệ/,
  );
  const tooMany = Array.from({ length: V11_CODEACT_MAX_ACTIONS_PER_PLAN + 1 }, (_, i) => act(`a${i}`, 'read-file', { path: 'x' }));
  assert.throws(() => validateV11CodeActPlan({ id: 'p', actions: tooMany }), /vượt giới hạn/);
  // Plan hợp lệ thì không ném.
  validateV11CodeActPlan(plan([act('a', 'read-file', { path: 'x' })]));
});

test('v11ActionRisk + v11NeedsConfirmation: phân loại rủi ro từng kind', () => {
  assert.equal(v11ActionRisk(act('a', 'read-file', { path: 'a.ts' })), 'low');
  assert.equal(v11ActionRisk(act('a', 'delete-file', { path: 'a.ts' })), 'high');
  assert.equal(v11ActionRisk(act('a', 'move-file', { path: 'a.ts', targetPath: 'b.ts' })), 'high');
  assert.equal(v11ActionRisk(act('a', 'write-file', { path: 'src/a.ts', content: 'x' })), 'medium');
  assert.equal(v11ActionRisk(act('a', 'write-file', { path: 'package.json', content: 'x' })), 'high');
  assert.equal(v11ActionRisk(act('a', 'write-file', { path: '.env', content: 'x' })), 'high');
  assert.equal(v11ActionRisk(act('a', 'write-file', { path: '.github/workflows/ci.yml', content: 'x' })), 'high');
  assert.equal(v11ActionRisk(act('a', 'write-file', { path: 'src/sub/tsconfig.json', content: 'x' })), 'high');
  assert.equal(v11ActionRisk(act('a', 'append-file', { path: 'a.ts', content: 'x' })), 'medium');
  assert.equal(v11ActionRisk(act('a', 'run-command', { command: ['ls'] })), 'medium');
  assert.equal(v11ActionRisk(act('a', 'run-command', { command: ['rm', '-rf', '/'] })), 'high');
  assert.equal(v11ActionRisk(act('a', 'run-command', { command: ['git', 'push', '--force'] })), 'high');
  assert.equal(v11ActionRisk(act('a', 'run-code', { codeKind: 'node', code: '1' })), 'medium');
  assert.equal(v11ActionRisk(act('a', 'run-code', { codeKind: 'bash', code: 'echo hi' })), 'high');
  assert.equal(v11ActionRisk(act('a', 'git-commit', { message: 'x' })), 'medium');
  assert.equal(v11NeedsConfirmation(act('a', 'delete-file', { path: 'a.ts' })), true);
  assert.equal(v11NeedsConfirmation(act('a', 'read-file', { path: 'a.ts' })), false);
  assert.equal(v11NeedsConfirmation(act('a', 'write-file', { path: 'a.ts', content: 'x' })), false);
});

test('dryRun: write-file mới + ghi đè — effect, diffPreview, willModifyDisk', () => {
  const dir = tmpDir('v11-ca-dry-');
  writeFile(dir, 'src/a.ts', 'line1\nline2\n');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = engine.dryRun(
    plan([
      act('w1', 'write-file', { path: 'src/b.ts', content: 'hello\n' }),
      act('w2', 'write-file', { path: 'src/a.ts', content: 'line1\nlineX\nline3\n' }),
    ]),
  );
  assert.equal(r.canApply, true);
  assert.equal(r.validCount, 2);
  assert.equal(r.invalidCount, 0);
  assert.equal(r.willModifyDisk, true);
  assert.match(r.actions[0].effect, /tạo mới src\/b\.ts/);
  assert.match(r.actions[1].effect, /ghi đè src\/a\.ts/);
  assert.ok(r.actions[1].diffPreview.length > 0);
  assert.ok(r.actions[1].diffPreview.includes('lineX'));
  // Đĩa chưa bị chạm.
  assert.equal(fs.existsSync(path.join(dir, 'src/b.ts')), false);
  assert.equal(readFile(dir, 'src/a.ts'), 'line1\nline2\n');
});

test('dryRun: read/append/delete/move — file phải tồn tại, đích chưa tồn tại', () => {
  const dir = tmpDir('v11-ca-dry2-');
  writeFile(dir, 'a.txt', 'one\ntwo\n');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = engine.dryRun(
    plan([
      act('r1', 'read-file', { path: 'a.txt' }),
      act('r2', 'read-file', { path: 'missing.txt' }),
      act('a1', 'append-file', { path: 'a.txt', content: 'three\n' }),
      act('a2', 'append-file', { path: 'missing.txt', content: 'x' }),
      act('a3', 'append-file', { path: 'a.txt', content: '' }),
      act('d1', 'delete-file', { path: 'a.txt' }),
      act('d2', 'delete-file', { path: 'missing.txt' }),
      act('m1', 'move-file', { path: 'a.txt', targetPath: 'b.txt' }),
      act('m2', 'move-file', { path: 'a.txt', targetPath: 'a.txt' }),
      act('m3', 'move-file', { path: 'missing.txt', targetPath: 'c.txt' }),
    ]),
  );
  const byId = Object.fromEntries(r.actions.map((a) => [a.actionId, a]));
  assert.equal(byId.r1.valid, true);
  assert.match(byId.r1.effect, /đọc a\.txt \(8 ký tự\)/);
  assert.equal(byId.r2.valid, false);
  assert.match(byId.r2.error, /không tồn tại/);
  assert.equal(byId.a1.valid, true);
  assert.match(byId.a1.effect, /thêm 1 dòng vào cuối a\.txt/);
  assert.equal(byId.a2.valid, false);
  assert.equal(byId.a3.valid, false);
  assert.equal(byId.d1.valid, true);
  assert.match(byId.d1.effect, /xóa a\.txt/);
  assert.equal(byId.d2.valid, false);
  assert.equal(byId.m1.valid, true);
  assert.equal(byId.m2.valid, false);
  assert.match(byId.m2.error, /trùng nhau/);
  assert.equal(byId.m3.valid, false);
  assert.equal(r.canApply, false);
  assert.equal(r.invalidCount, 6);
  assert.equal(r.willModifyDisk, true);
});

test('dryRun: path thoát workspace bị chặn', () => {
  const dir = tmpDir('v11-ca-esc-');
  writeFile(dir, 'a.txt', 'x');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = engine.dryRun(
    plan([
      act('e1', 'read-file', { path: '../secret.txt' }),
      act('e2', 'write-file', { path: '/etc/passwd', content: 'x' }),
      act('e3', 'delete-file', { path: '../../x.txt' }),
    ]),
  );
  assert.equal(r.canApply, false);
  assert.equal(r.invalidCount, 3);
  for (const a of r.actions) assert.match(a.error, /thoát workspace/);
});

test('dryRun: run-command — allowlist + deny-list (shell meta, sudo, rm -rf)', () => {
  const dir = tmpDir('v11-ca-cmd-');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = engine.dryRun(
    plan([
      act('c1', 'run-command', { command: ['node', '--version'] }),
      act('c2', 'run-command', { command: ['curl', 'https://example.com'] }),
      act('c3', 'run-command', { command: ['node', '-e', '1;2'] }),
      act('c4', 'run-command', { command: ['node', '-e', '$(whoami)'] }),
      act('c5', 'run-command', { command: ['sudo', 'ls'] }),
      act('c6', 'run-command', { command: [] }),
    ]),
  );
  const byId = Object.fromEntries(r.actions.map((a) => [a.actionId, a]));
  assert.equal(byId.c1.valid, true);
  assert.equal(byId.c2.valid, false);
  assert.match(byId.c2.error, /không nằm trong allowlist/);
  assert.equal(byId.c3.valid, false);
  assert.match(byId.c3.error, /ký tự shell bị cấm/);
  assert.equal(byId.c4.valid, false);
  // Lưu ý: '$' nằm trong lớp ký tự meta nên "$(...)" bị chặn ở nhánh
  // meta trước, nhánh "$()" riêng trong v9CheckDenyList không tới được.
  assert.match(byId.c4.error, /ký tự shell bị cấm "\$"/);
  assert.equal(byId.c5.valid, false);
  assert.equal(byId.c6.valid, false);
  assert.equal(r.canApply, false);
});

test('dryRun: run-code + git-commit — thiếu code/kind/message thì invalid', () => {
  const dir = tmpDir('v11-ca-code-');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = engine.dryRun(
    plan([
      act('k1', 'run-code', { codeKind: 'node', code: "console.log('hi')" }),
      act('k2', 'run-code', { codeKind: 'ruby', code: 'puts 1' }),
      act('k3', 'run-code', { codeKind: 'node', code: '   ' }),
      act('g1', 'git-commit', { message: 'feat: x' }),
      act('g2', 'git-commit', { message: '   ' }),
    ]),
  );
  const byId = Object.fromEntries(r.actions.map((a) => [a.actionId, a]));
  assert.equal(byId.k1.valid, true);
  assert.equal(byId.k2.valid, false);
  assert.equal(byId.k3.valid, false);
  assert.equal(byId.g1.valid, true);
  assert.equal(byId.g2.valid, false);
  assert.equal(r.needsConfirmationCount, 0);
});

test('dryRun: plan chỉ đọc — willModifyDisk false, không cần xác nhận', () => {
  const dir = tmpDir('v11-ca-ro-');
  writeFile(dir, 'a.txt', 'hello');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = engine.dryRun(plan([act('r1', 'read-file', { path: 'a.txt' })]));
  assert.equal(r.canApply, true);
  assert.equal(r.willModifyDisk, false);
  assert.equal(r.needsConfirmationCount, 0);
});

test('run dryRun=true: chỉ mô phỏng, không chạm đĩa', async () => {
  const dir = tmpDir('v11-ca-run-dry-');
  writeFile(dir, 'a.txt', 'old\n');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = await engine.run(
    plan([
      act('w1', 'write-file', { path: 'b.txt', content: 'new\n' }),
      act('d1', 'delete-file', { path: 'a.txt' }),
    ]),
    { dryRun: true },
  );
  assert.equal(r.dryRun, true);
  assert.equal(r.ok, true);
  assert.equal(r.okCount, 2);
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);
  assert.equal(readFile(dir, 'a.txt'), 'old\n');
  assert.match(r.results[0].stdout, /tạo mới b\.txt/);
  assert.equal(engine.getLastPlanId(), null);
  assert.deepEqual(engine.getPatchStack(), []);
});

test('run apply: write + append + read, rồi rollback khôi phục', async () => {
  const dir = tmpDir('v11-ca-apply-');
  writeFile(dir, 'a.txt', 'line1\n');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const p = plan([
    act('w1', 'write-file', { path: 'b.txt', content: 'hello\n' }),
    act('a1', 'append-file', { path: 'a.txt', content: 'line2\n' }),
    act('r1', 'read-file', { path: 'a.txt' }),
  ]);
  const r = await engine.run(p);
  assert.equal(r.ok, true);
  assert.equal(r.okCount, 3);
  assert.equal(readFile(dir, 'b.txt'), 'hello\n');
  assert.equal(readFile(dir, 'a.txt'), 'line1\nline2\n');
  assert.equal(r.results[2].stdout, 'line1\nline2\n');
  assert.ok(r.results[0].diff.includes('hello'));
  assert.equal(engine.getLastPlanId(), 'p1');
  assert.equal(engine.getPatchStack().length, 2);

  const rb = engine.rollback('p1');
  assert.equal(rb.ok, true);
  assert.equal(rb.restored, 2);
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);
  assert.equal(readFile(dir, 'a.txt'), 'line1\n');
});

test('run apply: delete-file cần xác nhận — không xác nhận thì skip + dừng plan', async () => {
  const dir = tmpDir('v11-ca-del-');
  writeFile(dir, 'a.txt', 'keep me\n');
  writeFile(dir, 'b.txt', 'also here\n');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const p = plan([
    act('d1', 'delete-file', { path: 'a.txt' }),
    act('w1', 'write-file', { path: 'c.txt', content: 'after\n' }),
  ]);
  const r = await engine.run(p);
  assert.equal(r.ok, false);
  assert.equal(r.skippedCount, 1);
  assert.equal(r.results[0].status, 'skipped-needs-confirmation');
  assert.match(r.results[0].reason, /cần xác nhận/);
  assert.equal(r.results.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), true);
  assert.equal(fs.existsSync(path.join(dir, 'c.txt')), false);

  // Có xác nhận (dạng mảng) thì xóa thật, rồi rollback khôi phục.
  const r2 = await engine.run(p, { confirmations: ['d1'] });
  assert.equal(r2.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false);
  assert.equal(readFile(dir, 'c.txt'), 'after\n');
  const rb = engine.rollback('p1');
  assert.equal(rb.ok, true);
  assert.equal(readFile(dir, 'a.txt'), 'keep me\n');
  assert.equal(fs.existsSync(path.join(dir, 'c.txt')), false);
});

test('run apply: move-file cần xác nhận, rollback trả nguồn + xóa đích', async () => {
  const dir = tmpDir('v11-ca-move-');
  writeFile(dir, 'src/old.ts', 'export const x = 1;\n');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const p = plan([act('m1', 'move-file', { path: 'src/old.ts', targetPath: 'dst/new.ts' })]);
  const r = await engine.run(p, { confirmations: new Set(['m1']) });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'src/old.ts')), false);
  assert.equal(readFile(dir, 'dst/new.ts'), 'export const x = 1;\n');
  const rb = engine.rollback('p1');
  assert.equal(rb.ok, true);
  assert.equal(readFile(dir, 'src/old.ts'), 'export const x = 1;\n');
  assert.equal(fs.existsSync(path.join(dir, 'dst/new.ts')), false);
});

test('run apply: run-command thật (node --version, echo) + timeout/cap mặc định', async () => {
  const dir = tmpDir('v11-ca-spawn-');
  const engine = new V11CodeActEngine({ workingDir: dir });
  assert.equal(engine.commandTimeoutMs, V11_CODEACT_DEFAULT_COMMAND_TIMEOUT_MS);
  const r = await engine.run(
    plan([
      act('c1', 'run-command', { command: ['node', '--version'] }),
      act('c2', 'run-command', { command: ['echo', 'v11-hello'] }),
    ]),
  );
  assert.equal(r.ok, true);
  assert.match(r.results[0].stdout, /^v\d+\.\d+\.\d+/);
  assert.equal(r.results[0].exitCode, 0);
  assert.equal(r.results[1].stdout.trim(), 'v11-hello');
});

test('run apply: run-command lỗi exit code != 0 thành failed + dừng plan', async () => {
  const dir = tmpDir('v11-ca-fail-');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = await engine.run(
    plan([
      act('c1', 'run-command', { command: ['node', '-e', 'process.exit(3)'] }),
      act('w1', 'write-file', { path: 'after.txt', content: 'x' }),
    ]),
  );
  assert.equal(r.ok, false);
  assert.equal(r.failedCount, 1);
  assert.equal(r.results[0].status, 'failed');
  assert.equal(r.results[0].exitCode, 3);
  assert.equal(r.results.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'after.txt')), false);
});

test('run apply: run-code node thật qua executor v10', async () => {
  const dir = tmpDir('v11-ca-code-');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = await engine.run(
    plan([act('k1', 'run-code', { codeKind: 'node', code: "console.log('v11-code-hi');" })]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.results[0].status, 'ok');
  assert.match(r.results[0].stdout, /v11-code-hi/);
});

test('run apply: git-commit thật sau khi ghi file', async () => {
  const dir = tmpDir('v11-ca-git-');
  initGitRepo(dir);
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = await engine.run(
    plan([
      act('w1', 'write-file', { path: 'feat.txt', content: 'feature\n' }),
      act('g1', 'git-commit', { message: 'feat: v11 test commit' }),
    ]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.results[1].status, 'ok');
  assert.match(r.results[1].stdout, /commit [0-9a-f]+/);
  const log = execSync('git log --oneline -1', { cwd: dir, encoding: 'utf8' });
  assert.match(log, /feat: v11 test commit/);
});

test('run: stopOnFailure=false thì action sau lỗi vẫn chạy; action invalid thành failed', async () => {
  const dir = tmpDir('v11-ca-stop-');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const r = await engine.run(
    plan([
      act('r1', 'read-file', { path: 'missing.txt' }),
      act('w1', 'write-file', { path: 'after.txt', content: 'ran\n' }),
    ]),
    { stopOnFailure: false },
  );
  assert.equal(r.ok, false);
  assert.equal(r.failedCount, 1);
  assert.equal(r.okCount, 1);
  assert.equal(r.results[0].status, 'failed');
  assert.match(r.results[0].stderr, /không tồn tại/);
  assert.equal(readFile(dir, 'after.txt'), 'ran\n');
  assert.equal(r.results.length, 2);
});

test('rollback: planId lạ + không có stack thì restored 0, ok true', () => {
  const dir = tmpDir('v11-ca-rb-');
  const engine = new V11CodeActEngine({ workingDir: dir });
  const rb = engine.rollback('khong-co-plan');
  assert.deepEqual(rb, { planId: 'khong-co-plan', restored: 0, failed: 0, failures: [], ok: true });
});

test('helper runV11CodeActPlan / dryRunV11CodeActPlan chạy không cần giữ engine', async () => {
  const dir = tmpDir('v11-ca-helper-');
  writeFile(dir, 'a.txt', 'x\n');
  const dry = dryRunV11CodeActPlan(dir, plan([act('w1', 'write-file', { path: 'b.txt', content: 'y\n' })]));
  assert.equal(dry.canApply, true);
  const r = await runV11CodeActPlan(dir, plan([act('w1', 'write-file', { path: 'b.txt', content: 'y\n' })]));
  assert.equal(r.ok, true);
  assert.equal(readFile(dir, 'b.txt'), 'y\n');
});
