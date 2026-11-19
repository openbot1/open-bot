/**
 * Router local v118 — inline tools: versioning tool set + cache key
 * tach doi + thread fingerprint (v1.41, Doi T3, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - Hash on dinh: cung tool set (khac thu tu key) -> cung hash;
 *   canonical JSON sort key de quy.
 * - Versioning: create v1; update khong doi that -> version giu
 *   nguyen; add/remove/replace -> version +1, hash doi, history
 *   giu toi da 50; replace tool chua co -> throw.
 * - Cache key tach doi: doi tool chi doi toolKey, prefixKey giu
 *   nguyen (chung minh khong pha prompt cache phan con lai); doi
 *   system prompt / message -> prefixKey doi.
 * - Thread lock: lock roi doi tool -> check bao mismatch; khong
 *   doi -> ok; thread chua lock -> ok.
 * - diffToolSets: added/removed/changed/unchanged.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v118-inline-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyToolSetChange,
  canonicalJson,
  checkThreadToolSet,
  computeSplitCacheKey,
  createToolSet,
  diffToolSets,
  fnv1aHash,
  hashToolSet,
  isThreadFingerprintMismatchError,
  lockThreadToolSet,
  normalizeToolList,
  prefixCacheSurvivesToolChange,
} from '../packages/core/dist/router/local/inlineToolsV118.js';

const TOOLS_A = [
  { name: 'search', description: 'Search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
];

function cacheKeyFor(toolSet, systemPrompt = 'You are helpful.') {
  return computeSplitCacheKey({
    systemPrompt,
    messages: [{ role: 'user', content: 'Hello' }],
    modelId: 'claude-sonnet-5-5',
    apiVersion: '2026-10-21',
    toolSet,
  });
}

test('hash: on dinh, khong phu thuoc thu tu key/tool', () => {
  assert.equal(fnv1aHash('abc'), fnv1aHash('abc'));
  assert.notEqual(fnv1aHash('abc'), fnv1aHash('abd'));
  assert.equal(
    canonicalJson({ b: 1, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 1 }),
  );
  // Thu tu tool trong list khong doi hash set.
  assert.equal(hashToolSet(TOOLS_A), hashToolSet([...TOOLS_A].reverse()));
  assert.notEqual(hashToolSet(TOOLS_A), hashToolSet([{ name: 'other', description: '', parameters: {} }]));
});

test('normalize: sort theo ten, chan trung/rong/ky tu la', () => {
  const normalized = normalizeToolList([
    { name: 'zeta', description: 'z' },
    { name: 'alpha', description: 'a' },
  ]);
  assert.deepEqual(normalized.map((t) => t.name), ['alpha', 'zeta']);
  assert.throws(() => normalizeToolList([{ name: 'a' }, { name: 'a' }]), /trung lap/);
  assert.throws(() => normalizeToolList([{ name: '' }]), /rong/);
  assert.throws(() => normalizeToolList([{ name: 'a b' }]), /khong hop le/);
});

test('versioning: create v1, no-op giu version, doi that tang version', () => {
  const set = createToolSet(TOOLS_A);
  assert.equal(set.current.version, 1);
  assert.equal(set.current.reason, 'initial');
  assert.deepEqual(set.current.toolNames, ['read_file', 'search']);
  assert.equal(set.history.length, 1);

  // Add tool da co y het = no-op.
  const noop = applyToolSetChange(set, { add: [{ name: 'search', description: 'Search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] });
  assert.equal(noop.changed, false);
  assert.equal(noop.state.current.version, 1);

  // Remove tool khong co = no-op.
  const noop2 = applyToolSetChange(set, { remove: ['nope'] });
  assert.equal(noop2.changed, false);

  // Add that -> v2.
  const added = applyToolSetChange(set, { add: [{ name: 'write_file', description: 'Write' }] });
  assert.equal(added.changed, true);
  assert.equal(added.state.current.version, 2);
  assert.deepEqual(added.added, ['write_file']);
  assert.notEqual(added.state.current.hash, set.current.hash);
  assert.equal(added.state.history.length, 2);

  // Replace dinh nghia -> v3; replace tool chua co -> throw.
  const replaced = applyToolSetChange(added.state, {
    replace: [{ name: 'search', description: 'Search the web v2' }],
  });
  assert.equal(replaced.state.current.version, 3);
  assert.deepEqual(replaced.replaced, ['search']);
  assert.throws(
    () => applyToolSetChange(added.state, { replace: [{ name: 'ghost', description: 'x' }] }),
    /chua ton tai/,
  );

  // Remove -> v4, toolNames cap nhat.
  const removed = applyToolSetChange(replaced.state, { remove: ['read_file'] });
  assert.equal(removed.state.current.version, 4);
  assert.deepEqual(removed.removed, ['read_file']);
  assert.deepEqual(removed.state.current.toolNames, ['search', 'write_file']);
});

test('cache key: doi tool khong doi prefixKey; doi prompt thi doi', () => {
  const before = createToolSet(TOOLS_A);
  const keyBefore = cacheKeyFor(before);
  const after = applyToolSetChange(before, { add: [{ name: 'calc', description: 'Calc' }] }).state;
  const keyAfter = cacheKeyFor(after);

  assert.equal(keyBefore.prefixKey, keyAfter.prefixKey);
  assert.notEqual(keyBefore.toolKey, keyAfter.toolKey);
  assert.notEqual(keyBefore.fullKey, keyAfter.fullKey);
  assert.equal(keyAfter.toolSetVersion, 2);
  assert.equal(prefixCacheSurvivesToolChange(keyBefore, keyAfter), true);

  // Doi system prompt -> prefixKey doi.
  const keyPrompt = cacheKeyFor(after, 'You are a coder.');
  assert.notEqual(keyPrompt.prefixKey, keyAfter.prefixKey);

  // Doi message -> prefixKey doi.
  const keyMsg = computeSplitCacheKey({
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'Different question' }],
    modelId: 'claude-sonnet-5-5',
    apiVersion: '2026-10-21',
    toolSet: after,
  });
  assert.notEqual(keyMsg.prefixKey, keyAfter.prefixKey);

  // Cung input -> cung key (deterministic).
  assert.deepEqual(cacheKeyFor(before), keyBefore);
});

test('thread lock: doi tool sau khi khoa -> mismatch; khong doi -> ok', () => {
  const set = createToolSet(TOOLS_A);
  const lock = lockThreadToolSet('thread-1', set);
  assert.equal(lock.locked, true);
  assert.equal(lock.fingerprint, set.current.hash);

  assert.deepEqual(checkThreadToolSet(lock, set), {
    ok: true,
    wouldMismatch: false,
    reason: 'Tool set khop fingerprint cua thread.',
  });

  const changed = applyToolSetChange(set, { remove: ['search'] }).state;
  const check = checkThreadToolSet(lock, changed);
  assert.equal(check.ok, false);
  assert.equal(check.wouldMismatch, true);
  assert.ok(check.reason.includes('thread-1'));

  // Thread chua khoa -> ok.
  assert.equal(checkThreadToolSet(null, changed).ok, true);

  // Loi mismatch nhan dien dung status/message.
  assert.equal(isThreadFingerprintMismatchError(400, 'thread_fingerprint_mismatch'), true);
  assert.equal(isThreadFingerprintMismatchError(409, 'thread_fingerprint_mismatch'), true);
  assert.equal(isThreadFingerprintMismatchError(500, 'thread_fingerprint_mismatch'), false);
});

test('diff: added/removed/changed/unchanged', () => {
  const diff = diffToolSets(TOOLS_A, [
    { name: 'search', description: 'Search the web v2' },
    { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'calc', description: 'Calc' },
  ]);
  assert.deepEqual(diff.added, ['calc']);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, ['search']);
  assert.deepEqual(diff.unchanged, ['read_file']);

  const diff2 = diffToolSets(TOOLS_A, [{ name: 'search', description: 'Search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]);
  assert.deepEqual(diff2.removed, ['read_file']);
  assert.deepEqual(diff2.unchanged, ['search']);
});
