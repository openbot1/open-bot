/**
 * Tests for coding agent v2 — git-first (v1.08, Đội T2):
 * `packages/core/src/codingV2/gitFirst.ts` (commit-per-step, diff
 * view, revert one commit, squash a range, status/log parsing,
 * allowlist guards).
 *
 * Real git in a temp dir (git init + local identity) — no network,
 * no remote, no push. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v2-git-first.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CodingV2GitSession,
  isValidCodingV2GitPath,
  parseCodingV2GitLog,
  parseCodingV2GitStatusPorcelain,
  runCodingV2Git,
} from '../packages/core/dist/codingV2/gitFirst.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-v2-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

function initRepo(t) {
  const dir = tmpDir(t);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  return dir;
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// --- Pure parsers -------------------------------------------------------------

test('parse status porcelain: staged / unstaged / untracked / clean', () => {
  const parsed = parseCodingV2GitStatusPorcelain('## main\nM  a.txt\n M b.txt\n?? c.txt\n');
  assert.deepEqual(parsed.staged, ['a.txt']);
  assert.deepEqual(parsed.unstaged, ['b.txt']);
  assert.deepEqual(parsed.untracked, ['c.txt']);
  assert.equal(parsed.clean, false);
  assert.equal(parseCodingV2GitStatusPorcelain('## main\n').clean, true);
});

test('parse log: sha / message / author / date split on NUL', () => {
  const out = 'abc1234def5678\x00first commit\x00Alice\x002026-01-01T00:00:00+07:00\n';
  const commits = parseCodingV2GitLog(out);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, 'abc1234def5678');
  assert.equal(commits[0].shortSha, 'abc1234');
  assert.equal(commits[0].message, 'first commit');
  assert.equal(parseCodingV2GitLog('not-a-sha\x00x\x00y\x00z\n').length, 0);
});

test('git paths: relative ok; absolute / .. rejected', () => {
  assert.equal(isValidCodingV2GitPath('src/a.ts'), true);
  assert.equal(isValidCodingV2GitPath('/abs/a.ts'), false);
  assert.equal(isValidCodingV2GitPath('../escape.ts'), false);
  assert.equal(isValidCodingV2GitPath(''), false);
});

// --- Guards -------------------------------------------------------------------

test('runCodingV2Git: disallowed subcommand and smuggled flags rejected', async () => {
  await assert.rejects(runCodingV2Git('/tmp', ['push', 'origin', 'main']), /không được phép/);
  await assert.rejects(runCodingV2Git('/tmp', ['fetch']), /không được phép/);
  await assert.rejects(runCodingV2Git('/tmp', ['log', '--upload-pack=touch']), /không được phép/);
  await assert.rejects(runCodingV2Git('/tmp', ['status', '--porcelain', '--all']), /không được phép/);
});

test('session: non-repo directory reports isRepo false, methods fail clearly', async (t) => {
  const dir = tmpDir(t);
  const session = new CodingV2GitSession(dir);
  assert.equal(await session.isRepo(), false);
  await assert.rejects(session.status(), /không phải git repo/);
  await assert.rejects(session.log(), /không phải git repo/);
});

// --- Status / commit / diff / log ----------------------------------------------

test('session: status, commitStep, log, diff work end to end', async (t) => {
  const dir = initRepo(t);
  const session = new CodingV2GitSession(dir);
  assert.equal(await session.isRepo(), true);
  assert.equal((await session.status()).clean, true);

  write(dir, 'a.txt', 'hello\n');
  const before = await session.status();
  assert.deepEqual(before.untracked, ['a.txt']);

  const committed = await session.commitStep({
    files: ['a.txt'],
    message: 'add a',
    planId: 'plan-1',
    stepId: 'step-1',
  });
  assert.match(committed.sha, /^[0-9a-f]{40}$/);
  assert.ok(committed.message.includes('[coding-v2] plan plan-1 step step-1: add a'));
  assert.equal((await session.status()).clean, true);

  const log = await session.log(10);
  assert.equal(log.length, 1);
  assert.equal(log[0].message, committed.message);

  write(dir, 'a.txt', 'hello world\n');
  const diff = await session.diff();
  assert.equal(diff.kind, 'worktree');
  assert.ok(diff.text.includes('hello world'));
  const commitDiff = await session.diff({ commit: committed.sha });
  assert.equal(commitDiff.kind, `commit ${committed.shortSha}`);
  assert.ok(commitDiff.text.includes('hello'));
});

test('session: commitStep with no changes fails; empty message fails', async (t) => {
  const dir = initRepo(t);
  const session = new CodingV2GitSession(dir);
  write(dir, 'a.txt', 'x\n');
  await session.commitStep({ files: ['a.txt'], message: 'first' });
  await assert.rejects(
    session.commitStep({ files: ['a.txt'], message: 'nothing new' }),
    /Không có thay đổi nào/,
  );
  write(dir, 'b.txt', 'y\n');
  await assert.rejects(session.commitStep({ files: ['b.txt'], message: '   ' }), /message không rỗng/);
  await assert.rejects(session.commitStep({ files: [], message: 'x' }), /ít nhất 1 file/);
  await assert.rejects(
    session.commitStep({ files: ['../escape.txt'], message: 'x' }),
    /không hợp lệ/,
  );
});

test('session: diff by range shows only that range', async (t) => {
  const dir = initRepo(t);
  const session = new CodingV2GitSession(dir);
  write(dir, 'a.txt', 'one\n');
  const c1 = await session.commitStep({ files: ['a.txt'], message: 'one' });
  write(dir, 'a.txt', 'one\ntwo\n');
  const c2 = await session.commitStep({ files: ['a.txt'], message: 'two' });
  const range = await session.diff({ from: c1.sha, to: c2.sha });
  assert.ok(range.text.includes('+two'), 'range diff must show the second commit change');
  assert.ok(!range.text.includes('+one'), 'range diff must not show the first commit as added');
  const badSha = session.diff({ commit: 'xyz' });
  await assert.rejects(badSha, /SHA commit không hợp lệ/);
});

// --- Revert ---------------------------------------------------------------------

test('session: revert one commit creates a revert commit and restores content', async (t) => {
  const dir = initRepo(t);
  const session = new CodingV2GitSession(dir);
  write(dir, 'a.txt', 'v1\n');
  await session.commitStep({ files: ['a.txt'], message: 'v1' });
  write(dir, 'a.txt', 'v2\n');
  const c2 = await session.commitStep({ files: ['a.txt'], message: 'v2' });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v2\n');

  const reverted = await session.revert(c2.sha);
  assert.match(reverted.sha, /^[0-9a-f]{40}$/);
  assert.equal(reverted.reverted, c2.sha);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1\n');
  const log = await session.log(10);
  assert.equal(log.length, 3);
  assert.match(log[0].message, /Revert/);
});

test('session: revert refuses a dirty worktree and a bad sha', async (t) => {
  const dir = initRepo(t);
  const session = new CodingV2GitSession(dir);
  write(dir, 'a.txt', 'v1\n');
  const c1 = await session.commitStep({ files: ['a.txt'], message: 'v1' });
  write(dir, 'a.txt', 'dirty\n');
  await assert.rejects(session.revert(c1.sha), /đang bẩn/);
  git(dir, 'checkout', '-q', '--', 'a.txt');
  await assert.rejects(session.revert('xyz'), /SHA commit không hợp lệ/);
});

// --- Squash ----------------------------------------------------------------------

test('session: squash merges the range into one commit', async (t) => {
  const dir = initRepo(t);
  const session = new CodingV2GitSession(dir);
  write(dir, 'a.txt', '1\n');
  const base = await session.commitStep({ files: ['a.txt'], message: 'base' });
  write(dir, 'a.txt', '1\n2\n');
  await session.commitStep({ files: ['a.txt'], message: 'step two' });
  write(dir, 'b.txt', 'b\n');
  await session.commitStep({ files: ['b.txt'], message: 'step three' });
  assert.equal((await session.log(10)).length, 3);

  const squashed = await session.squash({ base: base.sha, message: 'feature done' });
  assert.match(squashed.sha, /^[0-9a-f]{40}$/);
  assert.equal(squashed.squashed.length, 2);
  assert.ok(squashed.message.includes('[coding-v2] squash: feature done'));
  const log = await session.log(10);
  assert.equal(log.length, 2);
  assert.equal(log[0].sha, squashed.sha);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), '1\n2\n');
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), true);
});

test('session: squash refuses dirty worktree, non-ancestor base, <2 commits', async (t) => {
  const dir = initRepo(t);
  const session = new CodingV2GitSession(dir);
  write(dir, 'a.txt', '1\n');
  const c1 = await session.commitStep({ files: ['a.txt'], message: 'one' });
  write(dir, 'a.txt', '1\n2\n');
  await session.commitStep({ files: ['a.txt'], message: 'two' });
  write(dir, 'a.txt', 'dirty\n');
  await assert.rejects(session.squash({ base: c1.sha, message: 'x' }), /đang bẩn/);
  git(dir, 'checkout', '-q', '--', 'a.txt');
  // Only 1 commit after c1 -> squash needs >= 2.
  await assert.rejects(session.squash({ base: c1.sha, message: 'x' }), /ít nhất 2 commit/);
  await assert.rejects(session.squash({ base: '0123456789abcdef', message: 'x' }), /không nằm trong 50 commit|không phải ancestor/);
});
