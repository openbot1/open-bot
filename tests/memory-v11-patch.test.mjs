/**
 * Tests for v1.11 (Doi T1) — memory v11 patch engine:
 * packages/core/src/memory/v11/patch.ts.
 *
 * Covers: line diff (LCS, hunks with context, added/removed counts),
 * unified diff formatting, patch parsing + applying (exact context
 * match, mismatch rejects without writing), insert at line
 * (before/after/end), line-range replace, error cases.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v11-patch.test.mjs
 *
 * No network. No model. Pure functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLineDiff,
  formatUnifiedDiff,
  parseUnifiedPatch,
  applyUnifiedPatch,
  insertAtLine,
  replaceLineRange,
  splitLines,
  joinLines,
  V11PatchError,
} from '../packages/core/dist/memory/v11/patch.js';

test('splitLines/joinLines round-trip', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.equal(joinLines(['a', 'b']), 'a\nb');
  assert.equal(joinLines(splitLines('x\ny\nz')), 'x\ny\nz');
});

test('computeLineDiff: identical texts -> no hunks', () => {
  const d = computeLineDiff('a\nb\nc', 'a\nb\nc');
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.deepEqual(d.hunks, []);
  assert.equal(d.oldLines, 3);
  assert.equal(d.newLines, 3);
});

test('computeLineDiff: counts added/removed + hunk content', () => {
  const d = computeLineDiff('a\nb\nc\nd\ne', 'a\nB\nc\nd\nf');
  assert.equal(d.added, 2);
  assert.equal(d.removed, 2);
  assert.ok(d.hunks.length >= 1);
  const kinds = d.hunks.flatMap((h) => h.lines.map((l) => l.kind));
  assert.ok(kinds.includes('+'));
  assert.ok(kinds.includes('-'));
  assert.ok(kinds.includes(' '));
});

test('formatUnifiedDiff: headers + @@ hunks, round-trips through apply', () => {
  const oldText = 'line1\nline2\nline3\nline4';
  const newText = 'line1\nLINE2\nline3\nline4\nline5';
  const unified = formatUnifiedDiff('task', oldText, newText);
  assert.ok(unified.startsWith('--- a/task\n+++ b/task'));
  assert.ok(unified.includes('@@'));
  assert.ok(unified.includes('-line2'));
  assert.ok(unified.includes('+LINE2'));
  assert.ok(unified.includes('+line5'));
  assert.equal(applyUnifiedPatch(oldText, unified), newText);
});

test('applyUnifiedPatch: hand-written patch applies exactly', () => {
  const content = 'alpha\nbeta\ngamma\ndelta';
  const patch = [
    '--- a/task',
    '+++ b/task',
    '@@ -1,4 +1,4 @@',
    ' alpha',
    '-beta',
    '+BETA',
    ' gamma',
    ' delta',
  ].join('\n');
  assert.equal(applyUnifiedPatch(content, patch), 'alpha\nBETA\ngamma\ndelta');
});

test('applyUnifiedPatch: context mismatch rejects, nothing applied', () => {
  const content = 'alpha\nbeta\ngamma';
  const patch = [
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-WRONG',
    '+right',
    ' gamma',
  ].join('\n');
  assert.throws(() => applyUnifiedPatch(content, patch), V11PatchError);
  // Removal line that does not exist also rejects.
  const patch2 = ['@@ -2,2 +2,2 @@', '-missing', '+x', ' gamma'].join('\n');
  assert.throws(() => applyUnifiedPatch(content, patch2), V11PatchError);
});

test('applyUnifiedPatch: hunk out of order / beyond end rejects', () => {
  const content = 'a\nb';
  assert.throws(
    () => applyUnifiedPatch(content, '@@ -5,1 +5,1 @@\n+x'),
    V11PatchError,
  );
  const twoHunks = [
    '@@ -2,1 +2,1 @@',
    '-b',
    '+B',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+A',
  ].join('\n');
  assert.throws(() => applyUnifiedPatch(content, twoHunks), V11PatchError);
});

test('parseUnifiedPatch: empty / no-hunk / bad line throws', () => {
  assert.throws(() => parseUnifiedPatch(''), V11PatchError);
  assert.throws(() => parseUnifiedPatch('just text\nno hunks'), V11PatchError);
  assert.throws(() => parseUnifiedPatch('@@ -1,1 +1,1 @@\n?bad'), V11PatchError);
  assert.throws(() => parseUnifiedPatch('@@ bad header @@\n+x'), V11PatchError);
  const parsed = parseUnifiedPatch('--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n+b\n c');
  assert.equal(parsed.oldLabel, 'x');
  assert.equal(parsed.newLabel, 'x');
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].lines.length, 3);
});

test('insertAtLine: before/after/end + out-of-range errors', () => {
  const content = 'one\ntwo\nthree';
  assert.equal(insertAtLine(content, 'NEW', 2, 'before'), 'one\nNEW\ntwo\nthree');
  assert.equal(insertAtLine(content, 'NEW', 2, 'after'), 'one\ntwo\nNEW\nthree');
  assert.equal(insertAtLine(content, 'NEW', undefined, 'end'), 'one\ntwo\nthree\nNEW');
  assert.equal(insertAtLine(content, 'A\nB', 1, 'before'), 'A\nB\none\ntwo\nthree');
  assert.equal(insertAtLine('', 'first', undefined, 'end'), 'first');
  assert.throws(() => insertAtLine(content, 'x', 0, 'after'), V11PatchError);
  assert.throws(() => insertAtLine(content, 'x', 4, 'after'), V11PatchError);
  assert.throws(() => insertAtLine(content, 'x', 2.5, 'after'), V11PatchError);
  assert.throws(() => insertAtLine(content, '', 1, 'after'), V11PatchError);
  assert.throws(() => insertAtLine(content, 'x', 1, 'sideways'), V11PatchError);
});

test('replaceLineRange: replaces inclusive range, validates bounds', () => {
  const content = 'a\nb\nc\nd\ne';
  assert.equal(replaceLineRange(content, 2, 3, 'X\nY'), 'a\nX\nY\nd\ne');
  assert.equal(replaceLineRange(content, 1, 5, 'only'), 'only');
  assert.equal(replaceLineRange(content, 5, 5, ''), 'a\nb\nc\nd');
  assert.throws(() => replaceLineRange(content, 0, 2, 'x'), V11PatchError);
  assert.throws(() => replaceLineRange(content, 3, 2, 'x'), V11PatchError);
  assert.throws(() => replaceLineRange(content, 2, 9, 'x'), V11PatchError);
});
