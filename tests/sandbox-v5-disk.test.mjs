/**
 * Tests cho Sandbox v5 — disk budget, cache reclaim, gitignored shed
 * (v1.37, Đội T3).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v5-disk.test.mjs
 *
 * Reclaim thật trên thư mục tạm — không chạm dữ liệu thật.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SandboxV5DiskBudgetManager,
  loadSandboxV5GitignoreRules,
  parseSandboxV5Gitignore,
  readSandboxV5ReclaimLog,
  sandboxV5DiskDirSizeBytes,
  sandboxV5GitignoreRuleMatches,
  sandboxV5PathIgnored,
} from '../packages/core/dist/index.js';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(root, rel, size, mtimeMs) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x'.repeat(size), 'utf8');
  const date = new Date(mtimeMs);
  fs.utimesSync(full, date, date);
  return full;
}

test('gitignore: parse rules (negation, dir-only, anchored, comments)', () => {
  const rules = parseSandboxV5Gitignore('# comment\n\nnode_modules/\n/dist\n!important.txt\n**/*.log\n');
  assert.equal(rules.length, 4);
  assert.deepEqual(rules[0], { pattern: 'node_modules', negated: false, dirOnly: true, anchored: false });
  assert.deepEqual(rules[1], { pattern: 'dist', negated: false, dirOnly: false, anchored: true });
  assert.deepEqual(rules[2], { pattern: 'important.txt', negated: true, dirOnly: false, anchored: false });
  assert.deepEqual(rules[3], { pattern: '**/*.log', negated: false, dirOnly: false, anchored: true });
});

test('gitignore: matching (unanchored at any depth, dir-only, negation wins last)', () => {
  const rules = parseSandboxV5Gitignore('node_modules/\n*.log\n!important.log\n');
  assert.equal(sandboxV5GitignoreRuleMatches(rules[0], 'a/b/node_modules', true), true);
  assert.equal(sandboxV5GitignoreRuleMatches(rules[0], 'a/b/node_modules', false), false);
  assert.equal(sandboxV5PathIgnored(rules, 'a/b/node_modules', true), true);
  assert.equal(sandboxV5PathIgnored(rules, 'debug.log', false), true);
  assert.equal(sandboxV5PathIgnored(rules, 'important.log', false), false);
  assert.equal(sandboxV5PathIgnored(rules, 'src/index.ts', false), false);
  const anchored = parseSandboxV5Gitignore('/dist\n');
  assert.equal(sandboxV5PathIgnored(anchored, 'dist', true), true);
  assert.equal(sandboxV5PathIgnored(anchored, 'a/dist', true), false);
});

test('disk: status reports usage vs usable budget with headroom', (t) => {
  const base = tmpDir(t, 'sbv5-disk-');
  const cache = path.join(base, 'cache');
  writeFile(cache, 'entry-a/blob.bin', 1000, Date.now());
  writeFile(cache, 'entry-b/blob.bin', 2000, Date.now());
  const manager = new SandboxV5DiskBudgetManager({
    baseDir: base,
    budget: {
      totalBudgetBytes: 10_000,
      headroomBytes: 2000,
      cacheRoots: [{ path: cache, kind: 'test-cache', policy: 'oldest-first' }],
      workspaceRoots: [],
    },
  });
  const status = manager.status();
  assert.equal(status.cacheBytes, 3000);
  assert.equal(status.overBudget, false);
  assert.equal(status.remainingBytes, 8000 - status.usedBytes);
  assert.equal(manager.usableBudgetBytes(), 8000);
});

test('disk: constructor refuses roots outside the base dir and bad budgets', (t) => {
  const base = tmpDir(t, 'sbv5-disk-bad-');
  assert.throws(
    () =>
      new SandboxV5DiskBudgetManager({
        baseDir: base,
        budget: { cacheRoots: [{ path: '/etc', kind: 'x', policy: 'oldest-first' }] },
      }),
    /outside the sandbox base dir/,
  );
  assert.throws(
    () =>
      new SandboxV5DiskBudgetManager({
        baseDir: base,
        budget: { totalBudgetBytes: 1000, headroomBytes: 1000 },
      }),
    /headroom/,
  );
});

test('disk: plan is empty under budget; reclaims oldest cache first when over', (t) => {
  const base = tmpDir(t, 'sbv5-disk-plan-');
  const cache = path.join(base, 'cache');
  const now = Date.now();
  writeFile(cache, 'old/blob.bin', 4000, now - 300_000);
  writeFile(cache, 'mid/blob.bin', 4000, now - 200_000);
  writeFile(cache, 'new/blob.bin', 4000, now - 100_000);
  const manager = new SandboxV5DiskBudgetManager({
    baseDir: base,
    budget: {
      totalBudgetBytes: 10_000,
      headroomBytes: 1000,
      cacheRoots: [{ path: cache, kind: 'test-cache', policy: 'oldest-first' }],
      workspaceRoots: [],
    },
  });
  // Used = 12000 > usable 9000 → need 3000.
  const plan = manager.planReclaim();
  assert.equal(plan.needBytes, 3000);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0]?.path, path.join(cache, 'old'));
  assert.equal(plan.items[0]?.kind, 'cache');
  assert.equal(plan.wouldFreeBytes, 4000);
  assert.equal(plan.enough, true);
  // Dry-run deletes nothing.
  assert.equal(fs.existsSync(path.join(cache, 'old')), true);
  const result = manager.executeReclaim(plan);
  assert.equal(result.removed.length, 1);
  assert.equal(result.freedBytes, 4000);
  assert.equal(result.backUnderBudget, true);
  assert.equal(fs.existsSync(path.join(cache, 'old')), false);
  assert.equal(fs.existsSync(path.join(cache, 'new')), true);
  const log = readSandboxV5ReclaimLog(base);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.event, 'removed');
  assert.equal(log[0]?.freedBytes, 4000);
});

test('disk: least-used-first picks by atime; largest-first picks by size', (t) => {
  const base = tmpDir(t, 'sbv5-disk-policy-');
  const cache = path.join(base, 'cache');
  const now = Date.now();
  const a = writeFile(cache, 'a/blob.bin', 1000, now - 1000);
  const b = writeFile(cache, 'b/blob.bin', 5000, now - 2000);
  // Make `a` recently used (atime now) and `b` untouched (atime old).
  fs.utimesSync(a, new Date(now), new Date(now));
  fs.utimesSync(b, new Date(now - 500_000), new Date(now - 500_000));
  const manager = new SandboxV5DiskBudgetManager({
    baseDir: base,
    budget: {
      totalBudgetBytes: 100,
      headroomBytes: 10,
      cacheRoots: [{ path: cache, kind: 'k', policy: 'oldest-first' }],
      workspaceRoots: [],
    },
  });
  const entries = manager.scanCaches(now);
  assert.equal(entries.length, 2);
  assert.equal(manager.sortForReclaim(entries, 'least-used-first')[0]?.path, path.join(cache, 'b'));
  assert.equal(manager.sortForReclaim(entries, 'largest-first')[0]?.path, path.join(cache, 'b'));
  assert.equal(manager.sortForReclaim(entries, 'oldest-first')[0]?.path, path.join(cache, 'b'));
});

test('disk: gitignored dirs are shed only when still over after caches', (t) => {
  const base = tmpDir(t, 'sbv5-disk-shed-');
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
  writeFile(workspace, 'node_modules/pkg/index.js', 3000, Date.now() - 500_000);
  writeFile(workspace, 'dist/app.js', 3000, Date.now() - 400_000);
  writeFile(workspace, 'src/index.ts', 3000, Date.now());
  const manager = new SandboxV5DiskBudgetManager({
    baseDir: base,
    budget: {
      totalBudgetBytes: 5000,
      headroomBytes: 1000,
      cacheRoots: [],
      workspaceRoots: [workspace],
    },
  });
  const found = manager.findGitignoredDirs();
  assert.deepEqual(
    found.map((item) => path.basename(item.path)).sort(),
    ['dist', 'node_modules'],
  );
  // Used ≈ 9022 > usable 4000 → plan sheds both (oldest first).
  const plan = manager.planReclaim();
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items.every((item) => item.kind === 'gitignored-dir'), true);
  assert.equal(plan.items[0]?.path, path.join(workspace, 'node_modules'));
  const result = manager.executeReclaim(plan);
  assert.equal(result.removed.length, 2);
  assert.equal(fs.existsSync(path.join(workspace, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'dist')), false);
  // User files are never shed.
  assert.equal(fs.existsSync(path.join(workspace, 'src/index.ts')), true);
  assert.equal(fs.existsSync(path.join(workspace, '.gitignore')), true);
});

test('disk: plan that cannot free enough says so instead of deleting everything', (t) => {
  const base = tmpDir(t, 'sbv5-disk-notenough-');
  const cache = path.join(base, 'cache');
  writeFile(cache, 'tiny/blob.bin', 100, Date.now());
  // Fill the base with a big non-cache, non-gitignored file.
  writeFile(base, 'user-data.bin', 9000, Date.now());
  const manager = new SandboxV5DiskBudgetManager({
    baseDir: base,
    budget: {
      totalBudgetBytes: 5000,
      headroomBytes: 1000,
      cacheRoots: [{ path: cache, kind: 'k', policy: 'oldest-first' }],
      workspaceRoots: [],
    },
  });
  const plan = manager.planReclaim();
  assert.equal(plan.enough, false);
  assert.equal(plan.stillOverBytes > 0, true);
  assert.equal(plan.items.length, 1);
  // Executing frees only the cache — the user file stays.
  const result = manager.executeReclaim(plan);
  assert.equal(result.backUnderBudget, false);
  assert.equal(fs.existsSync(path.join(base, 'user-data.bin')), true);
});

test('disk: well-known dirs shed only with includeWellKnown', (t) => {
  const base = tmpDir(t, 'sbv5-disk-wk-');
  const workspace = path.join(base, 'ws');
  writeFile(workspace, 'node_modules/pkg/index.js', 1000, Date.now());
  writeFile(workspace, 'src/index.ts', 100, Date.now());
  const manager = new SandboxV5DiskBudgetManager({
    baseDir: base,
    budget: { cacheRoots: [], workspaceRoots: [workspace] },
  });
  assert.equal(manager.findGitignoredDirs().length, 0);
  assert.equal(loadSandboxV5GitignoreRules(workspace).length, 0);
  const found = manager.findGitignoredDirs({ includeWellKnown: true });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.path, path.join(workspace, 'node_modules'));
  assert.equal(sandboxV5DiskDirSizeBytes(workspace) >= 1100, true);
});
