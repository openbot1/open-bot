/**
 * Tests for coding agent v5 — patch history + rollback (v1.13, Doi T4):
 * `packages/core/src/codingV5/patchHistory.ts` (JSON log, record/list/
 * find, revert rollback, destructive reset-hard guard).
 *
 * Real temp git repos — no network. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v5-rollback-history.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// Runner git v5 chay `git commit`/`git revert` ke thua process.env —
// can identity (giong user da cau hinh git tren may).
process.env.GIT_AUTHOR_NAME ??= 'test';
process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'test';
process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';

import {
  CODING_V5_PATCH_HISTORY_REL_PATH,
  CodingV5PatchHistory,
  renderCodingV5PatchHistory,
  rollbackCodingV5Patch,
} from '../packages/core/dist/codingV5/patchHistory.js';

function tmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-v5-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args) => execFileSync('git', args, { cwd: dir, env }).toString();
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'chore(repo): base']);
  const writeAndCommit = (content, message) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), content);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  return { dir, git, writeAndCommit };
}

// --- History CRUD -----------------------------------------------------------------

test('record/list/find: round-trip to disk, newest first, corrupt file warns', (t) => {
  const { dir } = tmpRepo(t);
  const history = new CodingV5PatchHistory(dir);
  assert.equal(history.size, 0);
  assert.equal(history.loadWarning, null);
  const rec = history.recordPatch({
    commitSha: 'a'.repeat(40),
    parentSha: 'b'.repeat(40),
    message: 'feat(coding-v5): add thing',
    type: 'feat',
    scope: 'coding-v5',
    files: ['src/a.ts'],
    additions: 10,
    deletions: 2,
    hunksApproved: 3,
    hunksRejected: 1,
  });
  assert.equal(rec.shortSha, 'aaaaaaa');
  assert.equal(rec.rolledBackAt, null);
  assert.ok(fs.existsSync(path.join(dir, CODING_V5_PATCH_HISTORY_REL_PATH)));
  // Reload from disk: record survives.
  const reloaded = new CodingV5PatchHistory(dir);
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.findByCommit('aaaaaaa').message, 'feat(coding-v5): add thing');
  assert.equal(reloaded.findByCommit('a'.repeat(40)).id, rec.id);
  assert.equal(reloaded.findByCommit('deadbee'), null);
  assert.equal(reloaded.findByCommit('not-a-sha'), null);
  assert.deepEqual(reloaded.listActive().map((r) => r.id), [rec.id]);
  assert.deepEqual(reloaded.listRolledBack(), []);
  assert.match(renderCodingV5PatchHistory(reloaded.list()), /aaaaaaa.*active.*feat\(coding-v5\): add thing/);
  // Corrupt file -> warning + empty history (no crash).
  fs.writeFileSync(path.join(dir, CODING_V5_PATCH_HISTORY_REL_PATH), '{broken json');
  const corrupt = new CodingV5PatchHistory(dir);
  assert.equal(corrupt.size, 0);
  assert.match(corrupt.loadWarning, /hong/);
  assert.match(renderCodingV5PatchHistory([]), /Chua co patch nao/);
});

test('recordPatch rejects a bad SHA', (t) => {
  const { dir } = tmpRepo(t);
  const history = new CodingV5PatchHistory(dir);
  assert.throws(
    () =>
      history.recordPatch({
        commitSha: 'xyz',
        message: 'x',
        type: 'feat',
        scope: 's',
        files: [],
        additions: 0,
        deletions: 0,
        hunksApproved: 0,
        hunksRejected: 0,
      }),
    /SHA commit khong hop le/,
  );
});

// --- Rollback -----------------------------------------------------------------------

test('rollback revert: restores file content, marks history, keeps git log', async (t) => {
  const { dir, git, writeAndCommit } = tmpRepo(t);
  const sha1 = writeAndCommit('v2\n', 'feat(repo): bump to v2');
  const sha2 = writeAndCommit('v3\n', 'feat(repo): bump to v3');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v3\n');
  const history = new CodingV5PatchHistory(dir);
  history.recordPatch({
    commitSha: sha2,
    message: 'feat(repo): bump to v3',
    type: 'feat',
    scope: 'repo',
    files: ['a.txt'],
    additions: 1,
    deletions: 1,
    hunksApproved: 1,
    hunksRejected: 0,
  });
  const result = await rollbackCodingV5Patch(dir, sha2, { history });
  assert.equal(result.mode, 'revert');
  assert.equal(result.shortSha, sha2.slice(0, 7));
  assert.equal(result.message, 'feat(repo): bump to v3');
  assert.notEqual(result.rollbackSha, sha2);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v2\n');
  // History marked rolled back; first commit still active.
  assert.equal(history.findByCommit(sha2).rolledBackAt !== null, true);
  assert.equal(history.findByCommit(sha2).rollbackMode, 'revert');
  assert.deepEqual(history.listActive(), []);
  assert.equal(history.listRolledBack().length, 1);
  // The earlier commit is untouched by the revert.
  const logText = git(['log', '--oneline']);
  assert.match(logText, /bump to v2/);
  assert.match(logText, /Revert "feat\(repo\): bump to v3"/);
  void sha1;
});

test('rollback: unknown SHA errors, bad SHA errors', async (t) => {
  const { dir } = tmpRepo(t);
  await assert.rejects(rollbackCodingV5Patch(dir, 'f'.repeat(40)), /Khong tim thay commit/);
  await assert.rejects(rollbackCodingV5Patch(dir, 'xyz'), /SHA commit khong hop le/);
});

test('rollback reset-hard: needs allowDestructive, then drops the commit', async (t) => {
  const { dir, writeAndCommit, git } = tmpRepo(t);
  const sha1 = writeAndCommit('v2\n', 'feat(repo): bump to v2');
  await assert.rejects(
    rollbackCodingV5Patch(dir, sha1, { mode: 'reset-hard' }),
    /allowDestructive/,
  );
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v2\n');
  const result = await rollbackCodingV5Patch(dir, sha1, { mode: 'reset-hard', allowDestructive: true });
  assert.equal(result.mode, 'reset-hard');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1\n');
  const logText = git(['log', '--oneline']);
  assert.doesNotMatch(logText, /bump to v2/);
  assert.match(logText, /base/);
});

test('rollback reset-hard on the root commit is refused', async (t) => {
  const { dir, git } = tmpRepo(t);
  const root = git(['rev-parse', 'HEAD']).trim();
  await assert.rejects(
    rollbackCodingV5Patch(dir, root, { mode: 'reset-hard', allowDestructive: true }),
    /root commit/,
  );
});

test('rollback without history still works (record null)', async (t) => {
  const { dir, writeAndCommit } = tmpRepo(t);
  const sha1 = writeAndCommit('v2\n', 'feat(repo): bump to v2');
  const result = await rollbackCodingV5Patch(dir, sha1);
  assert.equal(result.record, null);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1\n');
});
