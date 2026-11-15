/**
 * Tests for subagent worktree isolation (packages/core/src/subagents/worktreeIsolation.ts).
 *
 * Covers branch-name validation (git rules), worktree planning
 * (path outside repo root, sibling dir, traversal blocked),
 * git execution through an injected executor (add/remove/list,
 * failure surfaces stderr), porcelain parsing, tool-call
 * summarisation (the context firewall — counts only, no raw calls),
 * path-escape detection, and the return envelope (build/validate/
 * format — parent receives branch + compressed summary only).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/subagent-worktree-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  branchToDirSlug,
  buildReturnEnvelope,
  createWorktree,
  detectPathEscape,
  formatReturnEnvelope,
  listWorktrees,
  parseWorktreeListPorcelain,
  planWorktree,
  removeWorktree,
  summarizeToolCalls,
  validateBranchName,
  validateReturnEnvelope,
} from '../packages/core/dist/subagents/worktreeIsolation.js';

function makePlan(overrides = {}) {
  return planWorktree({
    repoRoot: '/home/hatch/workspace/open-bot',
    branch: 'v107-fleet',
    ...overrides,
  });
}

test('worktree: tên branch hợp lệ qua, tên sai luật git → throw', () => {
  assert.equal(validateBranchName('v107-fleet'), 'v107-fleet');
  assert.equal(validateBranchName('feature/memory-v8'), 'feature/memory-v8');
  assert.equal(validateBranchName('  spaced  '), 'spaced');
  for (const bad of ['', 'a..b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '-lead', '/lead', 'trail/', 'trail.', 'x.lock', 'a@{b', 'a//b']) {
    assert.throws(() => validateBranchName(bad), /tên branch/, `expected throw for ${JSON.stringify(bad)}`);
  }
  assert.throws(() => validateBranchName('x'.repeat(101)), /dài quá 100/);
});

test('worktree: branchToDirSlug biến / thành - để làm tên thư mục', () => {
  assert.equal(branchToDirSlug('feature/memory-v8'), 'feature-memory-v8');
  assert.equal(branchToDirSlug('v107-fleet'), 'v107-fleet');
});

test('worktree: plan tính worktree là thư mục anh em, ngoài repo root', () => {
  const plan = makePlan();
  assert.equal(plan.repoRoot, '/home/hatch/workspace/open-bot');
  assert.equal(plan.branch, 'v107-fleet');
  assert.equal(plan.baseBranch, 'HEAD');
  assert.equal(plan.worktreePath, '/home/hatch/workspace/open-bot-v107-fleet');
  assert.deepEqual(plan.gitArgs, ['worktree', 'add', '/home/hatch/workspace/open-bot-v107-fleet', '-b', 'v107-fleet', 'HEAD']);
});

test('worktree: plan với baseBranch + worktreeParent + tên thư mục riêng', () => {
  const plan = planWorktree({
    repoRoot: '/repo/open-bot',
    branch: 'feat/x',
    baseBranch: 'main',
    worktreeParent: '/tmp/wt',
    worktreeDirName: 'child-1',
  });
  assert.equal(plan.worktreePath, '/tmp/wt/child-1');
  assert.equal(plan.baseBranch, 'main');
  assert.deepEqual(plan.gitArgs, ['worktree', 'add', '/tmp/wt/child-1', '-b', 'feat/x', 'main']);
});

test('worktree: repoRoot tương đối, worktreeDirName chứa / , baseBranch sai → throw', () => {
  assert.throws(() => planWorktree({ repoRoot: 'relative/path', branch: 'x' }), /đường dẫn tuyệt đối/);
  assert.throws(
    () => planWorktree({ repoRoot: '/repo/a', branch: 'x', worktreeDirName: 'a/b' }),
    /không được chứa dấu phân cách/,
  );
  assert.throws(() => planWorktree({ repoRoot: '/repo/a', branch: 'x', baseBranch: 'bad..name' }), /tên branch/);
});

test('worktree: create/remove chạy đúng argv qua executor, lỗi git → throw kèm stderr', async () => {
  const seen = [];
  const okExecutor = async (args, opts) => {
    seen.push({ args, cwd: opts.cwd });
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const plan = makePlan();
  await createWorktree(okExecutor, plan);
  await removeWorktree(okExecutor, plan);
  assert.deepEqual(seen[0]?.args, plan.gitArgs);
  assert.equal(seen[0]?.cwd, '/home/hatch/workspace/open-bot');
  assert.deepEqual(seen[1]?.args, ['worktree', 'remove', '--force', plan.worktreePath]);

  const failExecutor = async () => ({ stdout: '', stderr: 'fatal: already exists', exitCode: 128 });
  await assert.rejects(() => createWorktree(failExecutor, plan), /git worktree add thất bại.*already exists/);
  await assert.rejects(() => removeWorktree(failExecutor, plan), /git worktree remove thất bại/);
});

test('worktree: parse porcelain — bare/detached/branch đều đọc đúng', () => {
  const out = [
    'worktree /repo/main',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/child',
    'HEAD def456',
    'branch refs/heads/v107-fleet',
    '',
    'worktree /repo/bare',
    'HEAD abc123',
    'bare',
    '',
    'worktree /repo/det',
    'HEAD 999999',
    'detached',
    '',
  ].join('\n');
  const list = parseWorktreeListPorcelain(out);
  assert.equal(list.length, 4);
  assert.equal(list[0]?.branch, 'main');
  assert.equal(list[1]?.branch, 'v107-fleet');
  assert.equal(list[2]?.bare, true);
  assert.equal(list[2]?.branch, null);
  assert.equal(list[3]?.detached, true);
  assert.deepEqual(parseWorktreeListPorcelain(''), []);
});

test('worktree: listWorktrees qua executor, repoRoot tương đối → throw', async () => {
  const executor = async (args) => {
    assert.deepEqual(args, ['worktree', 'list', '--porcelain']);
    return { stdout: 'worktree /repo/main\nHEAD aaa\nbranch refs/heads/main\n\n', stderr: '', exitCode: 0 };
  };
  const list = await listWorktrees(executor, '/repo/main');
  assert.equal(list.length, 1);
  assert.equal(list[0]?.branch, 'main');
  await assert.rejects(() => listWorktrees(executor, 'relative'), /đường dẫn tuyệt đối/);
});

test('worktree: summarizeToolCalls nén theo tool — chỉ đếm, không giữ chi tiết call', () => {
  const summary = summarizeToolCalls([
    { tool: 'read_file', durationMs: 10 },
    { tool: 'read_file', durationMs: 20 },
    { tool: 'shell_exec', durationMs: 100, failed: true },
    { tool: 'shell_exec', durationMs: 50 },
    { tool: '', durationMs: 1 },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.failed, 1);
  assert.equal(summary.totalMs, 180);
  assert.equal(summary.byTool[0]?.tool, 'read_file');
  assert.equal(summary.byTool[0]?.calls, 2);
  assert.equal(summary.byTool[1]?.tool, 'shell_exec');
  assert.equal(summary.byTool[1]?.failed, 1);
  assert.deepEqual(summarizeToolCalls([]), { total: 0, failed: 0, totalMs: 0, byTool: [] });
});

test('worktree: detectPathEscape bắt path ngoài worktree, bỏ qua path trong', () => {
  const escapes = detectPathEscape(
    [
      { tool: 'read_file', path: 'packages/core/src/a.ts' },
      { tool: 'read_file', path: '/home/hatch/workspace/open-bot-v107-fleet/packages/b.ts' },
      { tool: 'shell_exec', path: '/etc/passwd' },
      { tool: 'shell_exec', path: '/home/hatch/workspace/open-bot/README.md' },
      { tool: 'shell_exec', path: '../open-bot/README.md' },
    ],
    '/home/hatch/workspace/open-bot-v107-fleet',
  );
  assert.deepEqual(escapes, ['/etc/passwd', '/home/hatch/workspace/open-bot/README.md']);
  assert.deepEqual(detectPathEscape([{ tool: 'read_file', path: 'a.ts' }], '/wt'), []);
});

test('worktree: buildReturnEnvelope — parent chỉ nhận branch + tóm tắt nén', () => {
  const plan = makePlan();
  const envelope = buildReturnEnvelope({
    plan,
    status: 'done',
    summary: 'Đã cài memory v8: 3 file mới, test xanh.',
    artifacts: ['packages/core/src/memory/v8.ts'],
    toolCalls: [
      { tool: 'read_file', durationMs: 5 },
      { tool: 'edit_file', durationMs: 8 },
      { tool: 'edit_file', durationMs: 9 },
      { tool: 'shell_exec', durationMs: 120, path: '/etc/hostname' },
    ],
    durationMs: 1500,
  });
  assert.equal(envelope.branch, 'v107-fleet');
  assert.equal(envelope.status, 'done');
  assert.equal(envelope.toolCalls.total, 4);
  assert.equal(envelope.rawToolCallsHidden, 4);
  assert.equal(envelope.toolCalls.byTool[0]?.tool, 'edit_file');
  assert.deepEqual(envelope.pathEscapes, ['/etc/hostname']);
  assert.equal(envelope.artifacts[0], 'packages/core/src/memory/v8.ts');
  // Validate lại envelope đã build phải pass.
  assert.equal(validateReturnEnvelope(envelope).branch, 'v107-fleet');
  const text = formatReturnEnvelope(envelope);
  assert.match(text, /branch `v107-fleet`/);
  assert.match(text, /4 tool call/);
  assert.match(text, /edit_file×2/);
  assert.match(text, /NGOÀI worktree/);
  assert.doesNotMatch(text, /read_file.*durationMs/);
});

test('worktree: envelope summary rỗng / done quá ngắn → throw; validate sai shape → throw', () => {
  const plan = makePlan();
  assert.throws(() => buildReturnEnvelope({ plan, status: 'done', summary: '', durationMs: 0 }), /summary không rỗng/);
  assert.throws(() => buildReturnEnvelope({ plan, status: 'done', summary: 'ngắn', durationMs: 0 }), /ít nhất 10 ký tự/);
  assert.throws(() => validateReturnEnvelope({ branch: 'bad..x' }), /tên branch/);
  assert.throws(() => validateReturnEnvelope({ branch: 'ok', worktreePath: 'relative', status: 'done', summary: 's', toolCalls: {}, pathEscapes: [], rawToolCallsHidden: 0, durationMs: 0, artifacts: [] }), /worktreePath tuyệt đối/);
  // Failed vẫn được phép summary ngắn (chỉ cần có lý do).
  const failed = buildReturnEnvelope({ plan, status: 'failed', summary: 'Lỗi.', durationMs: 10, error: 'timeout' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'timeout');
});
