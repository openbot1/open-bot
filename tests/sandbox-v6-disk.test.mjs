/**
 * Tests cho Sandbox v6 — disk quota + reclaim (v1.38, Đội T3).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v6-disk.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkDiskQuota,
  collectSandboxV6ReclaimCandidates,
  enforceDiskQuotaBeforeExec,
  largestWorkspaceFiles,
  measureWorkspace,
  measureAndCheckDiskQuota,
  reclaimSandboxV6Disk,
  sandboxV6PathInside,
} from '../packages/core/dist/sandboxV6/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v6-disk-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

test.afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test('measureWorkspace sums files, counts symlinks without following them', () => {
  const dir = makeTempDir();
  writeFile(dir, 'a.txt', 'hello'); // 5
  writeFile(dir, 'sub/b.txt', '0123456789'); // 10
  const outside = writeFile(makeTempDir(), 'outside.txt', 'x'.repeat(1000));
  fs.symlinkSync(outside, path.join(dir, 'link.txt'));
  fs.symlinkSync(path.join(dir, 'nope'), path.join(dir, 'broken.txt'));
  const m = measureWorkspace(dir);
  assert.equal(m.bytes, 15);
  assert.equal(m.files, 2);
  assert.equal(m.symlinks, 2);
  assert.equal(m.truncated, false);
  assert.ok(m.dirs >= 2);
});

test('measureWorkspace on a missing dir measures zero, never throws', () => {
  const m = measureWorkspace(path.join(makeTempDir(), 'gone'));
  assert.deepEqual(m, { bytes: 0, files: 0, dirs: 0, symlinks: 0, truncated: false });
});

test('measureWorkspace respects maxFiles (truncated = lower bound)', () => {
  const dir = makeTempDir();
  for (let i = 0; i < 10; i += 1) writeFile(dir, `f${i}.txt`, 'x');
  const m = measureWorkspace(dir, { maxFiles: 3 });
  assert.equal(m.truncated, true);
  assert.equal(m.files, 3);
});

test('checkDiskQuota: over / near / ok + ratio', () => {
  assert.deepEqual(checkDiskQuota({ bytes: 100, files: 1, dirs: 1, symlinks: 0, truncated: false }, 100), {
    usedBytes: 100, quotaBytes: 100, files: 1, overQuota: true, nearQuota: false, ratio: 1,
  });
  const near = checkDiskQuota({ bytes: 95, files: 1, dirs: 1, symlinks: 0, truncated: false }, 100);
  assert.equal(near.overQuota, false);
  assert.equal(near.nearQuota, true);
  assert.equal(near.ratio, 0.95);
  const ok = checkDiskQuota({ bytes: 50, files: 1, dirs: 1, symlinks: 0, truncated: false }, 100);
  assert.equal(ok.overQuota, false);
  assert.equal(ok.nearQuota, false);
  const unlimited = checkDiskQuota({ bytes: 10 ** 9, files: 1, dirs: 1, symlinks: 0, truncated: false }, 0);
  assert.equal(unlimited.overQuota, false);
  assert.equal(unlimited.ratio, 0);
});

test('enforceDiskQuotaBeforeExec refuses over-quota workspaces', () => {
  const dir = makeTempDir();
  writeFile(dir, 'big.bin', 'x'.repeat(1000));
  const refused = enforceDiskQuotaBeforeExec(dir, 100);
  assert.equal(refused.allowed, false);
  assert.match(refused.reason ?? '', /Disk quota exceeded/);
  assert.equal(refused.check.usedBytes, 1000);
  const allowed = enforceDiskQuotaBeforeExec(dir, 2000);
  assert.equal(allowed.allowed, true);
});

test('measureAndCheckDiskQuota combines measure + check', () => {
  const dir = makeTempDir();
  writeFile(dir, 'a.txt', 'x'.repeat(10));
  const r = measureAndCheckDiskQuota(dir, 100);
  assert.equal(r.usedBytes, 10);
  assert.equal(r.overQuota, false);
  assert.equal(r.truncated, false);
});

test('largestWorkspaceFiles returns largest first, skips symlinks', () => {
  const dir = makeTempDir();
  writeFile(dir, 'small.txt', 'x');
  writeFile(dir, 'big.txt', 'x'.repeat(100));
  writeFile(dir, 'mid.txt', 'x'.repeat(50));
  const outside = writeFile(makeTempDir(), 'huge.txt', 'x'.repeat(5000));
  fs.symlinkSync(outside, path.join(dir, 'link.txt'));
  const top = largestWorkspaceFiles(dir, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].bytes, 100);
  assert.equal(top[1].bytes, 50);
});

test('sandboxV6PathInside blocks .. escapes', () => {
  const root = path.join(os.tmpdir(), 'v6-root-test');
  assert.equal(sandboxV6PathInside(path.join(root, 'a', 'b.txt'), root), true);
  assert.equal(sandboxV6PathInside(path.join(root, '..', 'evil.txt'), root), false);
  assert.equal(sandboxV6PathInside('/etc/passwd', root), false);
  assert.equal(sandboxV6PathInside(root, root), true);
});

test('reclaim dry-run plans deletions oldest-tmp-first without deleting', () => {
  const dir = makeTempDir();
  const oldLog = writeFile(dir, 'app.log', 'x'.repeat(100));
  fs.utimesSync(oldLog, new Date(1000), new Date(1000));
  const newTmp = writeFile(dir, 'tmp/scratch.bin', 'x'.repeat(100));
  fs.utimesSync(newTmp, new Date(2000), new Date(2000));
  writeFile(dir, 'keep.txt', 'x'.repeat(100));
  const result = reclaimSandboxV6Disk(dir, { quotaBytes: 150 });
  assert.equal(result.dryRun, true);
  assert.equal(result.beforeBytes, 300);
  assert.equal(result.fitsQuota, true);
  assert.equal(result.deleted.length, 2); // tmp first, then oldest log
  assert.equal(result.deleted[0].file, newTmp);
  assert.equal(result.deleted[0].reason, 'tmp');
  assert.equal(result.deleted[1].reason, 'log');
  assert.ok(fs.existsSync(newTmp)); // dry-run deletes nothing
  assert.equal(result.errors.length, 0);
});

test('reclaim apply deletes only what is needed and never protected files', () => {
  const dir = makeTempDir();
  writeFile(dir, 'tmp/a.bin', 'x'.repeat(100));
  writeFile(dir, 'tmp/b.bin', 'x'.repeat(100));
  writeFile(dir, 'box.json', 'x'.repeat(100));
  writeFile(dir, 'work.txt', 'x'.repeat(100));
  const result = reclaimSandboxV6Disk(dir, { quotaBytes: 250, apply: true });
  assert.equal(result.dryRun, false);
  assert.equal(result.fitsQuota, true);
  assert.equal(result.freedBytes, 200); // both tmp files (need 150, tmp class first)
  assert.equal(result.deleted.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'tmp', 'a.bin')));
  assert.ok(fs.existsSync(path.join(dir, 'box.json'))); // protected by default
  assert.ok(fs.existsSync(path.join(dir, 'work.txt')));
});

test('reclaim with no quota or already-fitting workspace deletes nothing', () => {
  const dir = makeTempDir();
  writeFile(dir, 'a.txt', 'x'.repeat(10));
  const noQuota = reclaimSandboxV6Disk(dir, { quotaBytes: 0, apply: true });
  assert.equal(noQuota.deleted.length, 0);
  assert.equal(noQuota.fitsQuota, true);
  const fits = reclaimSandboxV6Disk(dir, { quotaBytes: 1000, apply: true });
  assert.equal(fits.deleted.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
});

test('reclaim candidates never include symlinks', () => {
  const dir = makeTempDir();
  const outside = writeFile(makeTempDir(), 'huge.txt', 'x'.repeat(5000));
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'tmp', 'link.bin'));
  writeFile(dir, 'tmp/real.bin', 'x'.repeat(10));
  const candidates = collectSandboxV6ReclaimCandidates(dir);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].file, path.join(dir, 'tmp', 'real.bin'));
});
