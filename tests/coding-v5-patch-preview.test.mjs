/**
 * Tests for coding agent v5 — patch preview (v1.13, Doi T4):
 * `packages/core/src/codingV5/patchPreview.ts` (unified diff parse,
 * preview render, hunk approve/reject, filter + serialize round-trip,
 * apply approved hunks on a real temp git repo) + gitV5 path safety.
 *
 * Pure parse + real temp git repos — no network. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v5-patch-preview.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CodingV5PatchSession,
  filterCodingV5Patch,
  parseCodingV5Diff,
  renderCodingV5Preview,
  serializeCodingV5Patch,
  summarizeCodingV5Patch,
  loadCodingV5PatchReview,
  saveCodingV5PatchReview,
} from '../packages/core/dist/codingV5/patchPreview.js';
import { CodingV5GitSession, findCodingV5PatchPathViolations } from '../packages/core/dist/codingV5/gitV5.js';

const DIFF_TWO_FILES =
  'diff --git a/src/a.ts b/src/a.ts\n' +
  'index 1111111..2222222 100644\n' +
  '--- a/src/a.ts\n' +
  '+++ b/src/a.ts\n' +
  '@@ -1,3 +1,4 @@ export function alpha() {\n' +
  ' export function alpha() {\n' +
  '-  return 1;\n' +
  '+  return 2;\n' +
  '+  // new comment\n' +
  ' }\n' +
  '@@ -10,3 +11,3 @@ export function beta() {\n' +
  ' export function beta() {\n' +
  '-  return oldBeta();\n' +
  '+  return newBeta();\n' +
  ' }\n' +
  'diff --git a/src/new.ts b/src/new.ts\n' +
  'new file mode 100644\n' +
  'index 0000000..3333333\n' +
  '--- /dev/null\n' +
  '+++ b/src/new.ts\n' +
  '@@ -0,0 +1,3 @@\n' +
  '+export function fresh() {\n' +
  '+  return true;\n' +
  '+}\n';

const DIFF_RENAME =
  'diff --git a/src/old.ts b/src/renamed.ts\n' +
  'similarity index 90%\n' +
  'rename from src/old.ts\n' +
  'rename to src/renamed.ts\n' +
  '--- a/src/old.ts\n' +
  '+++ b/src/renamed.ts\n' +
  '@@ -1,2 +1,2 @@\n' +
  ' export const x = 1;\n' +
  '-export const y = 2;\n' +
  '+export const y = 3;\n';

const DIFF_NO_NEWLINE =
  'diff --git a/a.txt b/a.txt\n' +
  '--- a/a.txt\n' +
  '+++ b/a.txt\n' +
  '@@ -1 +1 @@\n' +
  '-hello\n' +
  '\\ No newline at end of file\n' +
  '+hello world\n' +
  '\\ No newline at end of file\n';

// --- Parse ---------------------------------------------------------------------

test('parse: two files, hunks, counts, new-file status', () => {
  const patch = parseCodingV5Diff(DIFF_TWO_FILES);
  assert.equal(patch.files.length, 2);
  assert.equal(patch.additions, 6);
  assert.equal(patch.deletions, 2);
  assert.equal(patch.isEmpty, false);
  const [a, fresh] = patch.files;
  assert.equal(a.oldPath, 'src/a.ts');
  assert.equal(a.newPath, 'src/a.ts');
  assert.equal(a.status, 'modified');
  assert.equal(a.hunks.length, 2);
  assert.equal(a.hunks[0].id, '0:0');
  assert.equal(a.hunks[1].id, '0:1');
  assert.equal(a.hunks[0].additions, 2);
  assert.equal(a.hunks[0].deletions, 1);
  assert.equal(a.hunks[0].sectionHeading, 'export function alpha() {');
  assert.equal(fresh.status, 'added');
  assert.equal(fresh.isNewFile, true);
  assert.equal(fresh.hunks[0].lines.length, 3);
});

test('parse: line numbers track old/new sides', () => {
  const patch = parseCodingV5Diff(DIFF_TWO_FILES);
  const hunk = patch.files[0].hunks[0];
  assert.deepEqual(
    hunk.lines.map((l) => [l.type, l.oldLineNo, l.newLineNo]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ],
  );
});

test('parse: rename keeps old/new paths and status', () => {
  const patch = parseCodingV5Diff(DIFF_RENAME);
  assert.equal(patch.files.length, 1);
  const file = patch.files[0];
  assert.equal(file.status, 'renamed');
  assert.equal(file.oldPath, 'src/old.ts');
  assert.equal(file.newPath, 'src/renamed.ts');
  assert.equal(patch.additions, 1);
  assert.equal(patch.deletions, 1);
});

test('parse: no-newline marker flags the previous line', () => {
  const patch = parseCodingV5Diff(DIFF_NO_NEWLINE);
  const hunk = patch.files[0].hunks[0];
  assert.equal(hunk.lines.length, 2);
  assert.equal(hunk.lines[0].noNewline, true);
  assert.equal(hunk.lines[1].noNewline, true);
});

test('parse: binary diff keeps file with binary status, empty patch parses', () => {
  const patch = parseCodingV5Diff(
    'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n',
  );
  assert.equal(patch.files.length, 1);
  assert.equal(patch.files[0].status, 'binary');
  assert.equal(parseCodingV5Diff('').isEmpty, true);
  assert.equal(parseCodingV5Diff('\n').isEmpty, true);
});

test('parse: malformed diff throws with line info', () => {
  assert.throws(() => parseCodingV5Diff('hello world\n'), /Dong 1/);
  assert.throws(
    () => parseCodingV5Diff('diff --git a/x b/x\n--- a/x\n+++ b/x\nnot a hunk\n'),
    /ngoai hunk/,
  );
});

// --- Summary / preview ---------------------------------------------------------

test('summarize + preview render file list, hunk ids and truncation', () => {
  const patch = parseCodingV5Diff(DIFF_TWO_FILES);
  const summary = summarizeCodingV5Patch(patch);
  assert.match(summary, /2 file\(s\), 3 hunk\(s\), \+6\/-2/);
  assert.match(summary, /added src\/new\.ts/);
  const preview = renderCodingV5Preview(patch);
  assert.match(preview, /\[0\] modified src\/a\.ts/);
  assert.match(preview, /hunk 0:1/);
  assert.match(preview, /\+  return 2;/);
  const short = renderCodingV5Preview(patch, { maxHunkLines: 1 });
  assert.match(short, /da cat/);
  // showContext=false: dong context bien mat — 'export function alpha'
  // chi con 1 lan (trong header hunk), thay vi 2 lan (header + dong context).
  const ctxOnly = renderCodingV5Preview(patch, { showContext: false });
  assert.equal((ctxOnly.match(/export function alpha/g) ?? []).length, 1);
  assert.equal((preview.match(/export function alpha/g) ?? []).length, 2);
});

// --- Filter + serialize round-trip ---------------------------------------------

test('filter + serialize keeps only approved hunks and re-applies', (t) => {
  const patch = parseCodingV5Diff(DIFF_TWO_FILES);
  const filtered = filterCodingV5Patch(patch, new Set(['0:0']));
  assert.equal(filtered.files.length, 1);
  assert.equal(filtered.files[0].hunks.length, 1);
  assert.equal(filtered.files[0].hunks[0].id, '0:0');
  assert.equal(filtered.additions, 2);
  assert.equal(filtered.deletions, 1);
  // Serialize -> re-parse must give the same approved patch.
  const text = serializeCodingV5Patch(filtered);
  const reparsed = parseCodingV5Diff(text);
  assert.equal(reparsed.files.length, 1);
  assert.equal(reparsed.files[0].hunks.length, 1);
  assert.equal(reparsed.additions, 2);
  assert.equal(reparsed.deletions, 1);
  // Empty approval set -> empty patch, empty text.
  const none = filterCodingV5Patch(patch, new Set());
  assert.equal(none.isEmpty, true);
  assert.equal(serializeCodingV5Patch(none), '');
  assert.equal(serializeCodingV5Patch(parseCodingV5Diff('')), '');
});

// --- Session decisions ----------------------------------------------------------

test('session: approve/reject per hunk, approveAll, decision summary', () => {
  const session = new CodingV5PatchSession(DIFF_TWO_FILES);
  assert.deepEqual(session.allHunkIds(), ['0:0', '0:1', '1:0']);
  assert.equal(session.allDecided, false);
  session.approveHunk('0:0');
  session.rejectHunk('0:1');
  assert.deepEqual(session.approvedHunkIds(), ['0:0']);
  assert.deepEqual(session.pendingHunkIds(), ['1:0']);
  assert.match(session.decisionSummary(), /1\/3 hunk\(s\) da duyet, 1 tu choi, 1 cho duyet/);
  assert.throws(() => session.approveHunk('9:9'), /Khong co hunk/);
  session.approveAll();
  assert.equal(session.allDecided, true);
  assert.equal(session.approvedPatch().additions, 6);
  session.resetDecisions();
  assert.equal(session.allDecided, false);
  assert.equal(session.approvedPatch().isEmpty, true);
});

// --- Session persistence ---------------------------------------------------------

test('session save/load: decisions survive a round-trip to disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-v5-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = new CodingV5PatchSession(DIFF_TWO_FILES);
  session.approveHunk('0:0');
  session.rejectHunk('0:1');
  const filePath = path.join(dir, 'review.json');
  const saved = saveCodingV5PatchReview(filePath, session);
  assert.equal(saved, filePath);
  assert.ok(fs.existsSync(filePath));
  const restored = loadCodingV5PatchReview(filePath);
  assert.deepEqual(restored.approvedHunkIds(), ['0:0']);
  assert.deepEqual(restored.rejectedHunkIds(), ['0:1']);
  assert.deepEqual(restored.pendingHunkIds(), ['1:0']);
  assert.equal(restored.approvedPatch().additions, 2);
  assert.throws(() => loadCodingV5PatchReview(path.join(dir, 'nope.json')), /Khong doc duoc/);
  fs.writeFileSync(filePath, '{broken');
  assert.throws(() => loadCodingV5PatchReview(filePath), /JSON loi/);
  fs.writeFileSync(filePath, JSON.stringify({ version: 99, diffText: DIFF_TWO_FILES }));
  assert.throws(() => loadCodingV5PatchReview(filePath), /version khong ho tro/);
});

// --- Path safety -----------------------------------------------------------------

test('path violations: absolute and .. paths are rejected', () => {
  assert.deepEqual(findCodingV5PatchPathViolations(DIFF_TWO_FILES), []);
  const evil =
    'diff --git a/../evil.ts b/../evil.ts\n--- a/../evil.ts\n+++ b/../evil.ts\n@@ -1 +1 @@\n-x\n+y\n';
  assert.ok(findCodingV5PatchPathViolations(evil).length > 0);
  const absolute =
    'diff --git a//etc/passwd b//etc/passwd\n--- a//etc/passwd\n+++ b//etc/passwd\n@@ -1 +1 @@\n-x\n+y\n';
  assert.ok(findCodingV5PatchPathViolations(absolute).length > 0);
});

// --- Real git apply ---------------------------------------------------------------

function tmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-v5-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  git(['init', '--quiet']);
  fs.writeFileSync(
    path.join(dir, 'a.ts'),
    'export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return oldBeta();\n}\n',
  );
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'base']);
  return { dir, git };
}

test('session.applyApproved applies only the approved hunk on a real repo', async (t) => {
  const { dir } = tmpRepo(t);
  const diff =
    'diff --git a/a.ts b/a.ts\n' +
    '--- a/a.ts\n' +
    '+++ b/a.ts\n' +
    '@@ -1,3 +1,3 @@ export function alpha() {\n' +
    ' export function alpha() {\n' +
    '-  return 1;\n' +
    '+  return 2;\n' +
    ' }\n' +
    '@@ -5,3 +5,3 @@ export function beta() {\n' +
    ' export function beta() {\n' +
    '-  return oldBeta();\n' +
    '+  return newBeta();\n' +
    ' }\n';
  const session = new CodingV5PatchSession(diff, { repoRoot: dir });
  session.approveHunk('0:0');
  session.rejectHunk('0:1');
  const result = await session.applyApproved();
  assert.equal(result.hunksApplied, 1);
  assert.equal(result.filesAffected, 1);
  const content = fs.readFileSync(path.join(dir, 'a.ts'), 'utf8');
  assert.match(content, /return 2;/);
  assert.match(content, /return oldBeta\(\);/); // rejected hunk NOT applied
});

test('git session: checkPatch rejects a patch that does not apply, diff reads worktree', async (t) => {
  const { dir } = tmpRepo(t);
  const session = new CodingV5GitSession(dir);
  assert.equal(await session.isRepo(), true);
  const status = await session.status();
  assert.equal(status.clean, true);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export function alpha() {\n  return 99;\n}\n');
  const diff = await session.diff();
  assert.match(diff, /return 99/);
  const bad = await session.checkPatch('diff --git a/nope.ts b/nope.ts\n--- a/nope.ts\n+++ b/nope.ts\n@@ -1 +1 @@\n-x\n+y\n');
  assert.equal(bad.ok, false);
  await assert.rejects(session.applyPatch('not a diff at all\n'), /Khong apply duoc patch/);
});
