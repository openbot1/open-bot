/**
 * Tests for coding agent v5 — auto-commit message (v1.13, Doi T4):
 * `packages/core/src/codingV5/commitMessage.ts` (classify feat/fix/
 * refactor/test/docs, scope from paths, subject build, validate).
 *
 * Pure logic — no fs, no git. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v5-commit-message.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCodingV5Diff,
  buildCodingV5Subject,
  generateCodingV5CommitMessage,
  scopeFromCodingV5Path,
  scopeFromCodingV5Paths,
  summarizeCodingV5ChangesForCommit,
  validateCodingV5CommitMessage,
} from '../packages/core/dist/codingV5/commitMessage.js';
import { parseCodingV5Diff } from '../packages/core/dist/codingV5/patchPreview.js';

function patchOf(diffText) {
  return parseCodingV5Diff(diffText);
}

const DIFF_NEW_FUNCTION =
  'diff --git a/packages/core/src/codingV5/patchPreview.ts b/packages/core/src/codingV5/patchPreview.ts\n' +
  '--- a/packages/core/src/codingV5/patchPreview.ts\n' +
  '+++ b/packages/core/src/codingV5/patchPreview.ts\n' +
  '@@ -1,3 +1,6 @@\n' +
  ' import { x } from "./y";\n' +
  '+export function parseCodingV5Diff(text: string) {\n' +
  '+  return null;\n' +
  '+}\n' +
  ' \n' +
  ' const a = 1;\n';

const DIFF_FIX =
  'diff --git a/packages/core/src/codingV5/gitV5.ts b/packages/core/src/codingV5/gitV5.ts\n' +
  '--- a/packages/core/src/codingV5/gitV5.ts\n' +
  '+++ b/packages/core/src/codingV5/gitV5.ts\n' +
  '@@ -10,4 +10,4 @@ function run() {\n' +
  ' function run() {\n' +
  '-  // fix: crash when repo is empty\n' +
  '-  throw new Error("bug");\n' +
  '+  if (!repo) return null;\n' +
  ' }\n';

const DIFF_TEST_ONLY =
  'diff --git a/tests/coding-v5-patch-preview.test.mjs b/tests/coding-v5-patch-preview.test.mjs\n' +
  '--- a/tests/coding-v5-patch-preview.test.mjs\n' +
  '+++ b/tests/coding-v5-patch-preview.test.mjs\n' +
  '@@ -1,2 +1,5 @@\n' +
  ' import test from "node:test";\n' +
  '+test("new case", () => {});\n' +
  ' \n';

const DIFF_DOCS_ONLY =
  'diff --git a/docs/v113-coding.md b/docs/v113-coding.md\n' +
  '--- a/docs/v113-coding.md\n' +
  '+++ b/docs/v113-coding.md\n' +
  '@@ -1,2 +1,3 @@\n' +
  ' # Coding v5\n' +
  '+More docs here.\n' +
  ' \n';

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

// --- Scope ------------------------------------------------------------------------

test('scopeFromCodingV5Path maps repo paths to scopes', () => {
  assert.equal(scopeFromCodingV5Path('packages/core/src/codingV5/patchPreview.ts'), 'coding-v5');
  assert.equal(scopeFromCodingV5Path('packages/tools/src/codingV5Tools.ts'), 'tools-coding-v5-tools');
  assert.equal(scopeFromCodingV5Path('apps/desktop/src/renderer/i18n/locales/vi.json'), 'desktop-i18n');
  assert.equal(scopeFromCodingV5Path('apps/desktop/src/main.ts'), 'desktop');
  assert.equal(scopeFromCodingV5Path('tests/coding-v5-patch-preview.test.mjs'), 'test');
  assert.equal(scopeFromCodingV5Path('docs/v113-coding.md'), 'docs');
  assert.equal(scopeFromCodingV5Path('scripts/build.mjs'), 'scripts');
});

test('scopeFromCodingV5Paths picks the most common scope', () => {
  assert.equal(
    scopeFromCodingV5Paths([
      'packages/core/src/codingV5/a.ts',
      'packages/core/src/codingV5/b.ts',
      'docs/x.md',
    ]),
    'coding-v5',
  );
  assert.equal(scopeFromCodingV5Paths([]), 'repo');
});

// --- Classification -----------------------------------------------------------------

test('analyze: new exported function -> feat with symbol + scope', () => {
  const analysis = analyzeCodingV5Diff(patchOf(DIFF_NEW_FUNCTION));
  assert.equal(analysis.type, 'feat');
  assert.equal(analysis.scope, 'coding-v5');
  assert.equal(analysis.addedSymbols.length, 1);
  assert.equal(analysis.addedSymbols[0].name, 'parseCodingV5Diff');
  assert.equal(analysis.addedSymbols[0].kind, 'function');
  assert.equal(analysis.additions, 3);
});

test('analyze: fix keywords -> fix', () => {
  const analysis = analyzeCodingV5Diff(patchOf(DIFF_FIX));
  assert.equal(analysis.type, 'fix');
  assert.match(analysis.typeReason, /sua loi/);
});

test('analyze: test-only -> test, docs-only -> docs', () => {
  assert.equal(analyzeCodingV5Diff(patchOf(DIFF_TEST_ONLY)).type, 'test');
  assert.equal(analyzeCodingV5Diff(patchOf(DIFF_DOCS_ONLY)).type, 'docs');
});

test('analyze: rename -> refactor, empty patch -> chore', () => {
  const rename = analyzeCodingV5Diff(patchOf(DIFF_RENAME));
  assert.equal(rename.type, 'refactor');
  assert.equal(rename.renamedFiles.length, 1);
  assert.equal(rename.renamedFiles[0].from, 'src/old.ts');
  const empty = analyzeCodingV5Diff(patchOf(''));
  assert.equal(empty.type, 'chore');
  assert.equal(empty.filesChanged, 0);
});

// --- Subject + full message -----------------------------------------------------------

test('generate: subject follows type(scope): summary, body lists files', () => {
  const msg = generateCodingV5CommitMessage(patchOf(DIFF_NEW_FUNCTION));
  assert.equal(msg.subject, 'feat(coding-v5): add parseCodingV5Diff');
  assert.equal(msg.type, 'feat');
  assert.equal(msg.scope, 'coding-v5');
  assert.match(msg.body, /packages\/core\/src\/codingV5\/patchPreview\.ts \(\+3\/-0\)/);
  assert.match(msg.body, /Added: function parseCodingV5Diff/);
  assert.ok(msg.full.startsWith(msg.subject));
});

test('generate: overrides type/scope/issueRef, subject override wins', () => {
  const msg = generateCodingV5CommitMessage(patchOf(DIFF_FIX), {
    type: 'refactor',
    scope: 'git-v5',
    issueRef: 'refs v1.13',
  });
  assert.equal(msg.type, 'refactor');
  assert.equal(msg.scope, 'git-v5');
  assert.match(msg.subject, /^refactor\(git-v5\): /);
  assert.match(msg.full, /refs v1\.13$/);
  const custom = generateCodingV5CommitMessage(patchOf(DIFF_FIX), {
    subject: 'fix(git-v5): custom summary here',
  });
  assert.equal(custom.subject, 'fix(git-v5): custom summary here');
});

test('generate: long subject is truncated to 72 chars', () => {
  const manySymbols = Array.from({ length: 8 }, (_, i) => `export function someVeryLongFunctionName${i}() {}`).join('\n');
  const diff =
    'diff --git a/packages/core/src/codingV5/big.ts b/packages/core/src/codingV5/big.ts\n' +
    '--- a/packages/core/src/codingV5/big.ts\n' +
    '+++ b/packages/core/src/codingV5/big.ts\n' +
    '@@ -1,1 +1,9 @@\n' +
    ' const a = 1;\n' +
    manySymbols.split('\n').map((l) => `+${l}`).join('\n') +
    '\n';
  const msg = generateCodingV5CommitMessage(patchOf(diff));
  assert.ok(msg.subject.length <= 72, `subject too long: ${msg.subject.length}`);
  assert.equal(validateCodingV5CommitMessage(msg.full).length, 0);
});

test('summarizeCodingV5ChangesForCommit is one short line', () => {
  const text = summarizeCodingV5ChangesForCommit(patchOf(DIFF_NEW_FUNCTION));
  assert.match(text, /^feat\(coding-v5\): add parseCodingV5Diff/);
  assert.match(text, /1 file\(s\), \+3\/-0/);
});

// --- Validation -----------------------------------------------------------------------

test('validate: good message passes, bad ones report codes', () => {
  assert.deepEqual(validateCodingV5CommitMessage('feat(coding-v5): add parseCodingV5Diff'), []);
  assert.deepEqual(validateCodingV5CommitMessage('fix: crash on empty repo'), []);
  const badFormat = validateCodingV5CommitMessage('Add new feature');
  assert.ok(badFormat.some((i) => i.code === 'bad-format'));
  const badType = validateCodingV5CommitMessage('wip(coding-v5): something');
  assert.ok(badType.some((i) => i.code === 'bad-type'));
  const long = validateCodingV5CommitMessage(`feat(coding-v5): ${'x'.repeat(80)}`);
  assert.ok(long.some((i) => i.code === 'subject-too-long'));
  const dot = validateCodingV5CommitMessage('feat(coding-v5): add thing.');
  assert.ok(dot.some((i) => i.code === 'trailing-dot'));
  const capital = validateCodingV5CommitMessage('feat(coding-v5): Add thing');
  assert.ok(capital.some((i) => i.code === 'capital-summary'));
  const empty = validateCodingV5CommitMessage('');
  assert.ok(empty.some((i) => i.code === 'empty-subject'));
  const longBody = validateCodingV5CommitMessage(`feat(coding-v5): add thing\n\n${'y'.repeat(101)}`);
  assert.ok(longBody.some((i) => i.code === 'body-line-too-long'));
});

test('buildCodingV5Subject: single new file, removed files, no symbols', () => {
  const newFile = patchOf(
    'diff --git a/src/fresh.ts b/src/fresh.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/fresh.ts\n@@ -0,0 +1,1 @@\n+const x = 1;\n',
  );
  assert.equal(buildCodingV5Subject(analyzeCodingV5Diff(newFile)), 'chore(src): add src/fresh.ts');
});
