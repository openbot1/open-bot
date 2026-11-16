/**
 * Tests for coding agent v5 — file selection (v1.13, Doi T4):
 * `packages/core/src/codingV5/fileSelection.ts` (/add, /drop,
 * /ls-files, token budget, command parsing, repo-map suggestions).
 *
 * Real temp-dir files + a hand-built v2 graph for the ranking path
 * — no network. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v5-file-selection.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODING_V5_DEFAULT_TOKEN_BUDGET,
  CodingV5FileSet,
  normalizeCodingV5RelPath,
  parseCodingV5FileCommand,
  renderCodingV5Suggestions,
  suggestCodingV5Files,
  suggestCodingV5FilesByName,
  validateCodingV5AddPath,
} from '../packages/core/dist/codingV5/fileSelection.js';
import { buildCodingV2Graph } from '../packages/core/dist/codingV2/repoMapGraph.js';

function tmpRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-v5-fileset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const REPO_FILES = {
  'src/auth.ts': 'export function login() {\n  return true;\n}\n\nexport function logout() {\n  return false;\n}\n',
  'src/user.ts': "import { login } from './auth';\n\nexport function currentUser() {\n  return login() ? 'me' : null;\n}\n",
  'src/other.ts': 'export function unrelated() {\n  return 42;\n}\n',
};

// --- FileSet ------------------------------------------------------------------------

test('FileSet: add/drop/list/stats with token estimates', (t) => {
  const dir = tmpRepo(t, REPO_FILES);
  const set = new CodingV5FileSet(dir);
  const entry = set.add('src/auth.ts');
  assert.equal(entry.relPath, 'src/auth.ts');
  assert.ok(entry.tokens > 0);
  assert.equal(entry.size, Buffer.byteLength(REPO_FILES['src/auth.ts']));
  assert.equal(set.size, 1);
  // Add twice returns the same entry, no duplicate.
  assert.equal(set.add('src/auth.ts'), entry);
  assert.equal(set.size, 1);
  set.add('src/user.ts');
  const stats = set.stats();
  assert.equal(stats.files, 2);
  assert.equal(stats.totalTokens, set.list().reduce((s, e) => s + e.tokens, 0));
  assert.equal(stats.budgetTokens, CODING_V5_DEFAULT_TOKEN_BUDGET);
  assert.equal(stats.overBudget, false);
  assert.match(set.render(), /Tap file: 2 file\(s\)/);
  const dropped = set.drop('src/auth.ts');
  assert.equal(dropped.relPath, 'src/auth.ts');
  assert.equal(set.size, 1);
  assert.throws(() => set.drop('src/auth.ts'), /khong co trong tap/);
});

test('FileSet: over-budget warning when budget is tiny', (t) => {
  const dir = tmpRepo(t, REPO_FILES);
  const set = new CodingV5FileSet(dir, 1);
  set.add('src/auth.ts');
  const stats = set.stats();
  assert.equal(stats.overBudget, true);
  assert.ok(stats.overByTokens > 0);
  assert.match(set.render(), /VUOT/);
});

test('FileSet: addMany reports skipped files, dropMany reports missing', (t) => {
  const dir = tmpRepo(t, REPO_FILES);
  const set = new CodingV5FileSet(dir);
  const { added, skipped } = set.addMany(['src/auth.ts', 'src/missing.ts', '../escape.ts']);
  assert.equal(added.length, 1);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /khong ton tai|thoat khoi repo/);
  const { dropped, missing } = set.dropMany(['src/auth.ts', 'src/other.ts']);
  assert.equal(dropped.length, 1);
  assert.deepEqual(missing, ['src/other.ts']);
});

test('FileSet: serialize/deserialize round-trip, missing files dropped', (t) => {
  const dir = tmpRepo(t, REPO_FILES);
  const set = new CodingV5FileSet(dir, 5000);
  set.add('src/auth.ts');
  set.add('src/user.ts');
  const json = set.serialize();
  fs.rmSync(path.join(dir, 'src/user.ts'));
  const restored = CodingV5FileSet.deserialize(json);
  assert.equal(restored.repoRoot, dir);
  assert.equal(restored.budgetTokens, 5000);
  assert.deepEqual(restored.list().map((e) => e.relPath), ['src/auth.ts']);
  assert.throws(() => CodingV5FileSet.deserialize('not json'), /khong doc duoc/);
  assert.throws(() => CodingV5FileSet.deserialize('{"x": 1}'), /thieu repoRoot/);
});

test('validateCodingV5AddPath rejects absolute, .., system dirs, dirs', (t) => {
  const dir = tmpRepo(t, REPO_FILES);
  assert.equal(validateCodingV5AddPath(dir, 'src/auth.ts'), null);
  assert.match(validateCodingV5AddPath(dir, '/etc/passwd'), /tuyet doi/);
  assert.match(validateCodingV5AddPath(dir, '../escape.ts'), /thoat khoi repo/);
  assert.match(validateCodingV5AddPath(dir, 'node_modules/x.js'), /he thong\/build/);
  assert.match(validateCodingV5AddPath(dir, '.git/config'), /he thong\/build/);
  assert.match(validateCodingV5AddPath(dir, 'src/nope.ts'), /khong ton tai/);
  assert.match(validateCodingV5AddPath(dir, 'src'), /khong phai file/);
  assert.match(validateCodingV5AddPath(dir, ''), /rong/);
});

test('normalizeCodingV5RelPath handles backslashes and ./', () => {
  assert.equal(normalizeCodingV5RelPath('src\\auth.ts'), 'src/auth.ts');
  assert.equal(normalizeCodingV5RelPath('./src/./auth.ts'), 'src/auth.ts');
});

// --- Command parsing ------------------------------------------------------------------

test('parseCodingV5FileCommand: /add, /drop, /ls-files, /clear, /add --suggest', () => {
  assert.deepEqual(parseCodingV5FileCommand('/add src/a.ts src/b.ts'), {
    kind: 'add',
    paths: ['src/a.ts', 'src/b.ts'],
  });
  assert.deepEqual(parseCodingV5FileCommand('/add "src/my file.ts"'), {
    kind: 'add',
    paths: ['src/my file.ts'],
  });
  assert.deepEqual(parseCodingV5FileCommand('/drop src/a.ts'), { kind: 'drop', paths: ['src/a.ts'] });
  assert.deepEqual(parseCodingV5FileCommand('/ls-files'), { kind: 'ls-files', paths: [] });
  assert.deepEqual(parseCodingV5FileCommand('/clear'), { kind: 'clear', paths: [] });
  assert.deepEqual(parseCodingV5FileCommand('/add --suggest auth login --limit 5'), {
    kind: 'suggest',
    paths: [],
    query: 'auth login',
    limit: 5,
  });
  assert.throws(() => parseCodingV5FileCommand('add src/a.ts'), /bat dau bang "\/"/);
  assert.throws(() => parseCodingV5FileCommand('/add'), /it nhat 1 duong dan/);
  assert.throws(() => parseCodingV5FileCommand('/drop'), /it nhat 1 duong dan/);
  assert.throws(() => parseCodingV5FileCommand('/add --suggest'), /can mot truy van/);
  assert.throws(() => parseCodingV5FileCommand('/add --suggest x --limit 0'), /--limit/);
  assert.throws(() => parseCodingV5FileCommand('/unknown'), /khong ho tro/);
  assert.throws(() => parseCodingV5FileCommand('/ls-files extra'), /khong nhan tham so/);
});

// --- Suggestions -------------------------------------------------------------------------

function fileEntry(relPath, symbols, imports = [], mtimeMs = Date.now()) {
  return { relPath, language: 'ts', mtimeMs, size: 100, symbols, imports, hasError: false };
}

function symbol(name, line = 1) {
  return { kind: 'function', name, qualifiedName: name, line, column: 1, endLine: line + 2 };
}

test('suggestCodingV5Files: query seeds rank first, reasons explain', () => {
  const files = [
    fileEntry('src/auth.ts', [symbol('login'), symbol('logout')]),
    fileEntry('src/user.ts', [symbol('currentUser')], ['src/auth.ts']),
    fileEntry('src/other.ts', [symbol('unrelated')]),
  ];
  const idents = new Map([
    ['src/auth.ts', new Map()],
    ['src/user.ts', new Map([['login', 2]])],
    ['src/other.ts', new Map()],
  ]);
  const graph = buildCodingV2Graph({ files, idents });
  const { suggestions, fellBackToGlobal, seedFiles } = suggestCodingV5Files(graph, files, 'login auth', {
    limit: 3,
  });
  assert.equal(fellBackToGlobal, false);
  assert.ok(seedFiles.includes('src/auth.ts'));
  assert.equal(suggestions[0].relPath, 'src/auth.ts');
  assert.equal(suggestions[0].isSeed, true);
  assert.match(suggestions[0].reason, /Khop truy van/);
  assert.ok(suggestions.every((s) => s.score >= 0));
  const rendered = renderCodingV5Suggestions(suggestions, 'login auth', fellBackToGlobal);
  assert.match(rendered, /Goi y 3 file cho "login auth"/);
});

test('suggestCodingV5Files: unknown query falls back to global ranking', () => {
  const files = [
    fileEntry('src/auth.ts', [symbol('login')]),
    fileEntry('src/other.ts', [symbol('unrelated')]),
  ];
  const idents = new Map([
    ['src/auth.ts', new Map()],
    ['src/other.ts', new Map()],
  ]);
  const graph = buildCodingV2Graph({ files, idents });
  const { suggestions, fellBackToGlobal } = suggestCodingV5Files(graph, files, 'zzzqqq', { limit: 2 });
  assert.equal(fellBackToGlobal, true);
  assert.equal(suggestions.length, 2);
});

test('suggestCodingV5FilesByName: substring match fallback, excludes selected', () => {
  const files = [
    fileEntry('src/auth.ts', []),
    fileEntry('src/user.ts', []),
    fileEntry('src/other.ts', []),
  ];
  const { suggestions, fellBackToNameMatch } = suggestCodingV5FilesByName(files, 'auth', {
    excludeSelected: new Set(['src/auth.ts']),
  });
  assert.equal(fellBackToNameMatch, true);
  assert.deepEqual(suggestions.map((s) => s.relPath), []);
  const again = suggestCodingV5FilesByName(files, 'auth', {});
  assert.equal(again.suggestions[0].relPath, 'src/auth.ts');
  assert.match(again.suggestions[0].reason, /fallback/);
  const none = suggestCodingV5FilesByName(files, 'zzzqqq', {});
  assert.equal(none.suggestions.length, 0);
  assert.match(renderCodingV5Suggestions([], 'zzzqqq', true), /Khong goi y duoc/);
});
