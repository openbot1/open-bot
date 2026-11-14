/**
 * Test v1.04 (Đội T4): CodeAct v2 — bash + python + editor thật trong box.
 *
 * - bash echo/false: exit code + stdout thật (chạy trong BotBoxManager).
 * - python: tính toán thật + sys.argv thật.
 * - edit: ghi/append file thật trong workspace của box, đọc lại bằng fs.
 * - edit escape `../` → CodeActValidationError.
 * - Lệnh phá hoại (`rm -rf /`) → Observation lỗi, không chạy, không throw.
 * - Timeout: sleep 5 với timeout 500ms → timedOut true.
 * - Cap output: stdout dài bị cắt ở maxOutputChars, truncated true.
 * - Validate: command/code rỗng, code quá dài → throw.
 * - Contract: parse args tool call + render text cho model.
 *
 * Chạy thật (không mock executor). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/codeact-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BotBoxManager } from '../packages/core/dist/sandbox/box.js';
import {
  CodeActExecutor,
  CodeActValidationError,
  codeActActionFromToolArgs,
  codeActResultToText,
  isCodeActCommandBlocked,
  runCodeActAction,
  summarizeCodeActResult,
} from '../packages/core/dist/codeact/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-codeact-v104-'));
}

function makeExecutor(limits = {}) {
  const dir = tmpDir();
  const boxes = new BotBoxManager({ rootDir: path.join(dir, 'boxes') });
  const executor = new CodeActExecutor({ boxes, botId: 'codeact-test', limits });
  return { dir, boxes, executor };
}

test('bash: echo thật, exit 0', async () => {
  const { executor } = makeExecutor();
  const result = await runCodeActAction(executor, { kind: 'bash', command: 'echo xin-chao-codeact' });
  assert.equal(result.observation.exitCode, 0);
  assert.equal(result.observation.stdout.trim(), 'xin-chao-codeact');
  assert.equal(result.observation.timedOut, false);
  assert.equal(result.execution.actionKind, 'bash');
  assert.ok(result.execution.durationMs >= 0);
  assert.match(summarizeCodeActResult(result), /ok/);
});

test('bash: lệnh lỗi trả exit code thật', async () => {
  const { executor } = makeExecutor();
  const result = await executor.execute({ kind: 'bash', command: 'false' });
  assert.equal(result.observation.exitCode, 1);
  const missing = await executor.execute({ kind: 'bash', command: 'ls /thu-muc-khong-ton-tai-xyz' });
  assert.notEqual(missing.observation.exitCode, 0);
  assert.match(missing.observation.stderr, /No such file|cannot access/i);
});

test('python: tính toán + sys.argv thật', async () => {
  const { executor } = makeExecutor();
  const result = await executor.execute({ kind: 'python', code: 'print(6 * 7)' });
  assert.equal(result.observation.exitCode, 0);
  assert.equal(result.observation.stdout.trim(), '42');
  const withArgs = await executor.execute({
    kind: 'python',
    code: 'import sys; print("+".join(sys.argv[1:]))',
    args: ['mot', 'hai'],
  });
  assert.equal(withArgs.observation.stdout.trim(), 'mot+hai');
  // File tạm đã xoá sau khi chạy.
  assert.equal(fs.existsSync(withArgs.execution.tempFile), false);
});

test('python: lỗi cú pháp trả exit code + stderr thật', async () => {
  const { executor } = makeExecutor();
  const result = await executor.execute({ kind: 'python', code: 'def broken(:\n  pass' });
  assert.notEqual(result.observation.exitCode, 0);
  assert.match(result.observation.stderr, /SyntaxError/);
});

test('edit: ghi + append file thật trong workspace của box', async () => {
  const { executor } = makeExecutor();
  const ws = executor.workspaceDir();
  const write = await executor.execute({
    kind: 'edit',
    path: 'notes/hello.txt',
    content: 'dong 1\n',
    mode: 'write',
  });
  assert.equal(write.observation.exitCode, 0);
  assert.equal(write.observation.fileWritten?.path, 'notes/hello.txt');
  assert.equal(fs.readFileSync(path.join(ws, 'notes/hello.txt'), 'utf8'), 'dong 1\n');
  const append = await executor.execute({
    kind: 'edit',
    path: 'notes/hello.txt',
    content: 'dong 2\n',
    mode: 'append',
  });
  assert.equal(append.observation.fileWritten?.bytes, 7);
  assert.equal(fs.readFileSync(path.join(ws, 'notes/hello.txt'), 'utf8'), 'dong 1\ndong 2\n');
});

test('edit: path escape khỏi workspace thì throw', async () => {
  const { executor } = makeExecutor();
  await assert.rejects(
    executor.execute({ kind: 'edit', path: '../evil.txt', content: 'x', mode: 'write' }),
    CodeActValidationError,
  );
  await assert.rejects(
    executor.execute({ kind: 'edit', path: '/etc/evil.txt', content: 'x', mode: 'write' }),
    CodeActValidationError,
  );
});

test('denylist: rm -rf / bị chặn, trả Observation lỗi (không chạy)', async () => {
  assert.equal(isCodeActCommandBlocked('rm -rf /').blocked, true);
  assert.equal(isCodeActCommandBlocked('rm -rf /tmp/x').blocked, false);
  assert.equal(isCodeActCommandBlocked('echo hello').blocked, false);
  assert.equal(isCodeActCommandBlocked('shutdown -h now').blocked, true);
  const { executor } = makeExecutor();
  const result = await executor.execute({ kind: 'bash', command: 'rm -rf /' });
  assert.equal(result.observation.exitCode, null);
  assert.match(result.observation.stderr, /bị chặn/);
  assert.equal(result.observation.timedOut, false);
});

test('timeout: sleep 5 với timeout 500ms → timedOut', async () => {
  const { executor } = makeExecutor();
  const result = await executor.execute({ kind: 'bash', command: 'sleep 5', timeoutMs: 500 });
  assert.equal(result.observation.timedOut, true);
});

test('cap output: stdout dài bị cắt, truncated true', async () => {
  const { executor } = makeExecutor({ maxOutputChars: 100 });
  const result = await executor.execute({ kind: 'bash', command: 'seq 1 5000' });
  assert.equal(result.observation.truncated, true);
  assert.ok(result.observation.stdout.length <= 100);
  assert.equal(result.observation.exitCode, 0);
});

test('validate: command/code rỗng và code quá dài → throw', async () => {
  const { executor } = makeExecutor({ maxCodeChars: 10 });
  await assert.rejects(executor.execute({ kind: 'bash', command: '   ' }), CodeActValidationError);
  await assert.rejects(executor.execute({ kind: 'python', code: '' }), CodeActValidationError);
  await assert.rejects(
    executor.execute({ kind: 'python', code: 'print(123456789012345)' }),
    /vượt giới hạn/,
  );
  await assert.rejects(
    executor.execute({ kind: 'edit', path: '', content: 'x', mode: 'write' }),
    CodeActValidationError,
  );
});

test('contract: parse args tool call + render text cho model', async () => {
  const bash = codeActActionFromToolArgs({ kind: 'bash', command: 'echo hi', timeoutMs: 1000 });
  assert.deepEqual(bash, { kind: 'bash', command: 'echo hi', timeoutMs: 1000 });
  const edit = codeActActionFromToolArgs({ kind: 'edit', path: 'a.txt', content: 'x', mode: 'append' });
  assert.equal(edit.kind, 'edit');
  assert.throws(() => codeActActionFromToolArgs({ kind: 'browser', url: 'x' }), /kind không biết/);
  assert.throws(() => codeActActionFromToolArgs({ kind: 'bash' }), /thiếu command/);
  assert.throws(() => codeActActionFromToolArgs(null), /phải là object/);

  const { executor } = makeExecutor();
  const result = await runCodeActAction(executor, { kind: 'bash', command: 'echo render-me' });
  const text = codeActResultToText(result);
  assert.match(text, /bash: echo render-me/);
  assert.match(text, /exit 0/);
  assert.match(text, /render-me/);
});
