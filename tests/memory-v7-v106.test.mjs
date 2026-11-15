/**
 * Tests for v1.06 (Team T1) — Memory v7 (core):
 * packages/core/src/memory/{tiers,gitProjection,promptRecompile}.ts
 *
 * Covers: 4-tier store (add/list/get, one-step promote/demote only,
 * TTL + expiry sweep, capacity drop, consolidation working ->
 * session -> episodic -> semantic, keyword search over episodic with
 * access scoring), git-backed projection (block file + commit per
 * change, system-scope guardrail blocks agent edits, history/blame/
 * diff via git, JSONL fallback when git is absent, import from v0.96
 * blocks), block-level prompt recompilation (hash cache reuses
 * unchanged sections, only changed blocks recompile, system blocks
 * render first).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v7-v106.test.mjs
 *
 * No network. No model. Needs git CLI for the git-backed tests
 * (skipped gracefully when git is missing).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TieredMemoryStore,
  tierRank,
  tierDefaultTtlMs,
  tierCapacity,
  isValidTier,
  effectiveScore,
  isItemExpired,
  GitMemoryProjection,
  PromptRecompiler,
  compileSystemPrompt,
  hashBlockContent,
  sortBlocksForPrompt,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv7-v106-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- tiers: constants -------------------------------------------------------

test('tiers: ranks, TTLs and capacities are ordered working < session < episodic < semantic', () => {
  assert.ok(tierRank('working') < tierRank('session'));
  assert.ok(tierRank('session') < tierRank('episodic'));
  assert.ok(tierRank('episodic') < tierRank('semantic'));
  assert.equal(tierDefaultTtlMs('working'), 60 * 60 * 1000);
  assert.equal(tierDefaultTtlMs('session'), 24 * 60 * 60 * 1000);
  assert.equal(tierDefaultTtlMs('episodic'), 90 * 24 * 60 * 60 * 1000);
  assert.equal(tierDefaultTtlMs('semantic'), null);
  assert.ok(tierCapacity('working') < tierCapacity('session'));
  assert.ok(tierCapacity('session') < tierCapacity('episodic'));
  assert.ok(tierCapacity('episodic') < tierCapacity('semantic'));
  assert.equal(isValidTier('semantic'), true);
  assert.equal(isValidTier('forever'), false);
});

test('tiers: add/get/list, duplicate label in same tier throws, same label in another tier is fine', () => {
  const dir = makeTempDir();
  const store = new TieredMemoryStore(dir);
  const item = store.add('working', { label: 'Thích Phở', content: 'User thích phở bò.', score: 0.8 });
  assert.equal(item.label, 'thich-pho');
  assert.equal(item.tier, 'working');
  assert.equal(item.score, 0.8);
  assert.ok(item.expiresAt !== null);
  assert.equal(store.get('thich-pho', 'working')?.id, item.id);
  assert.throws(() => store.add('working', { label: 'thich-pho', content: 'khác' }), /Đã có item/);
  const other = store.add('session', { label: 'thich-pho', content: 'Cùng label, tầng khác.' });
  assert.equal(other.tier, 'session');
  assert.equal(store.list({ tier: 'working' }).length, 1);
  assert.equal(store.list().length, 2);
  assert.throws(() => store.add('working', { label: '', content: 'x' }), /label/);
  assert.throws(() => store.add('working', { label: 'x', content: '' }), /nội dung/);
  assert.throws(
    () => store.add('working', { label: 'x', content: 'y'.repeat(4001) }),
    /vượt giới hạn/,
  );
});

test('tiers: promote moves one step up only, demote one step down only, semantic never expires', () => {
  const dir = makeTempDir();
  const store = new TieredMemoryStore(dir);
  const item = store.add('working', { label: 'fact-a', content: 'A.' });
  assert.throws(() => store.promote(item.id, 'episodic'), /một bậc/);
  assert.throws(() => store.demote(item.id, 'working'), /đi xuống/);
  const s1 = store.promote(item.id, 'session');
  assert.equal(s1.tier, 'session');
  const s2 = store.promote(item.id, 'episodic');
  assert.equal(s2.tier, 'episodic');
  const s3 = store.promote(item.id, 'semantic');
  assert.equal(s3.tier, 'semantic');
  assert.equal(s3.expiresAt, null);
  assert.throws(() => store.promote(item.id, 'semantic'), /cao nhất|đi lên/);
  const d1 = store.demote(item.id, 'episodic');
  assert.equal(d1.tier, 'episodic');
  assert.ok(d1.expiresAt !== null);
  assert.throws(() => store.demote(item.id, 'working'), /một bậc/);
});

test('tiers: touch raises effective score, expired items sweep and never promote', () => {
  const dir = makeTempDir();
  const store = new TieredMemoryStore(dir);
  const item = store.add('working', { label: 'short-lived', content: 'Sắp hết hạn.', score: 0.5, ttlMs: 1000 });
  assert.equal(effectiveScore(item), 0.5);
  store.touch(item.id);
  store.touch(item.id);
  const after = store.get(item.id);
  assert.equal(after?.accessCount, 2);
  assert.ok((effectiveScore(after) - 0.54) < 0.0001);
  assert.equal(isItemExpired(item, new Date(Date.now() + 2000)), true);
  assert.equal(store.sweepExpired(new Date(Date.now() + 2000)), 1);
  assert.equal(store.get(item.id), null);
  const dead = store.add('working', { label: 'dead', content: 'Hết hạn rồi.', ttlMs: 0 });
  assert.throws(() => store.promote(dead.id, 'session', undefined), /hết hạn/);
});

test('tiers: consolidate moves working->session, high-score session->episodic, recalled episodic->semantic', () => {
  const dir = makeTempDir();
  const store = new TieredMemoryStore(dir);
  store.add('working', { label: 'w1', content: 'Working note.', score: 0.4 });
  const strong = store.add('session', { label: 's1', content: 'Strong session fact.', score: 0.9 });
  store.add('session', { label: 's2', content: 'Weak session fact.', score: 0.3 });
  const epi = store.add('episodic', { label: 'e1', content: 'Recalled event.', score: 0.9 });
  store.touch(epi.id);
  store.touch(epi.id);
  store.touch(epi.id);
  store.add('episodic', { label: 'e2', content: 'Unrecalled event.', score: 0.95 });
  const report = store.consolidate();
  assert.equal(report.workingToSession, 1);
  assert.equal(report.sessionToEpisodic, 1);
  assert.equal(report.episodicToSemantic, 1);
  assert.equal(report.expiredSwept, 0);
  assert.equal(store.get('w1')?.tier, 'session');
  assert.equal(store.get('s1')?.tier, 'episodic');
  assert.equal(store.get('s2')?.tier, 'session');
  assert.equal(store.get('e1')?.tier, 'semantic');
  assert.equal(store.get('e2')?.tier, 'episodic');
  // Dry-run changes nothing.
  const before = store.list().map((i) => `${i.label}:${i.tier}`).join(',');
  const dry = store.consolidate({ dryRun: true });
  assert.equal(dry.workingToSession, 0);
  assert.equal(store.list().map((i) => `${i.label}:${i.tier}`).join(','), before);
  void strong;
});

test('tiers: episodic search scores keyword hits, expired items never hit', () => {
  const dir = makeTempDir();
  const store = new TieredMemoryStore(dir);
  store.add('episodic', { label: 'pho-hn', content: 'User ăn phở ở Hà Nội hôm qua.', score: 0.9 });
  store.add('episodic', { label: 'bun-hue', content: 'User ăn bún bò Huế.', score: 0.9 });
  store.add('episodic', { label: 'gone', content: 'Ăn phở rồi nhưng đã hết hạn.', score: 0.9, ttlMs: 1 });
  store.sweepExpired(new Date(Date.now() + 5000));
  const hits = store.search('phở Hà Nội', { tiers: ['episodic'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].item.label, 'pho-hn');
  assert.deepEqual(hits[0].matchedTerms, ['phở', 'hà', 'nội']);
  const all = store.search('', { tiers: ['episodic'] });
  assert.equal(all.length, 2);
});

// --- git-backed projection --------------------------------------------------

test('git projection: create writes a markdown file with frontmatter; system labels are scope system', () => {
  const dir = makeTempDir();
  const proj = new GitMemoryProjection(dir);
  const human = proj.create({ label: 'human', content: 'Tên Huy.', description: 'Về user.' }, 'user');
  assert.equal(human.scope, 'system');
  assert.equal(human.tier, 'semantic');
  assert.equal(human.version, 1);
  const custom = proj.create({ label: 'likes-pho', content: 'Thích phở.', tier: 'episodic' }, 'user');
  assert.equal(custom.scope, 'user');
  assert.equal(custom.tier, 'episodic');
  const file = fs.readFileSync(path.join(dir, '.open-bot', 'memory-v7', 'blocks', 'human.md'), 'utf8');
  assert.ok(file.startsWith('---\nlabel: human\n'));
  assert.ok(file.includes('scope: system'));
  assert.ok(file.endsWith('Tên Huy.'));
  assert.throws(() => proj.create({ label: 'human', content: 'trùng' }, 'user'), /Đã có memory block/);
  assert.equal(proj.list().length, 2);
  assert.equal(proj.list()[0].label, 'human');
});

test('git projection: guardrail — agent cannot edit system blocks, user can; read-only blocks block everyone', () => {
  const dir = makeTempDir();
  const proj = new GitMemoryProjection(dir);
  proj.create({ label: 'human', content: 'Tên Huy.' }, 'user');
  proj.create({ label: 'notes', content: 'Ghi chú.' }, 'user');
  assert.throws(() => proj.update('human', { content: 'Đổi.' }, 'agent:bot-a'), /hệ thống/);
  assert.throws(() => proj.append('human', 'Thêm.', 'agent:bot-a'), /hệ thống/);
  assert.throws(() => proj.setTier('human', 'episodic', 'agent:bot-a'), /hệ thống/);
  const ok = proj.update('human', { content: 'Tên Huy, ở Việt Nam.' }, 'user');
  assert.equal(ok.version, 2);
  const agentOk = proj.append('notes', 'Thêm dòng.', 'agent:bot-a');
  assert.equal(agentOk.version, 2);
  assert.ok(agentOk.content.includes('Thêm dòng.'));
  proj.setReadOnly('notes', true, 'user');
  assert.throws(() => proj.update('notes', { content: 'x' }, 'user'), /read-only/);
  assert.throws(() => proj.delete('notes', 'user'), /read-only/);
});

test('git projection: update/append/setTier bump version; delete removes the file', () => {
  const dir = makeTempDir();
  const proj = new GitMemoryProjection(dir);
  proj.create({ label: 'a', content: 'Một.', tier: 'working' }, 'user');
  const u = proj.update('a', { description: 'Mô tả mới' }, 'user');
  assert.equal(u.version, 2);
  assert.equal(u.description, 'Mô tả mới');
  const t = proj.setTier('a', 'session', 'user');
  assert.equal(t.version, 3);
  assert.equal(t.tier, 'session');
  const same = proj.setTier('a', 'session', 'user');
  assert.equal(same.version, 3);
  assert.equal(proj.delete('a', 'user'), true);
  assert.equal(proj.get('a'), null);
  assert.equal(proj.delete('a', 'user'), false);
});

test('git projection: history/blame/diff come from git when available', () => {
  const dir = makeTempDir();
  const proj = new GitMemoryProjection(dir);
  if (!proj.gitAvailable()) {
    // Fallback path: history still works from the JSONL log.
    proj.create({ label: 'fb', content: 'v1' }, 'user');
    proj.update('fb', { content: 'v2' }, 'user');
    const hist = proj.blockHistory('fb');
    assert.ok(hist.length >= 2);
    assert.equal(hist[0].version, 2);
    return;
  }
  proj.ensureRepo();
  proj.create({ label: 'fb', content: 'Dòng một.' }, 'user');
  proj.update('fb', { content: 'Dòng một.\nDòng hai.' }, 'user');
  proj.append('fb', 'Dòng ba.', 'user');
  const history = proj.blockHistory('fb');
  assert.ok(history.length >= 3, `expected >=3 history entries, got ${history.length}`);
  assert.equal(history[0].version, 3);
  assert.ok(history[0].content.includes('Dòng ba.'));
  assert.ok(history[history.length - 1].content.includes('Dòng một.'));
  const blame = proj.blockBlame('fb');
  assert.ok(blame.length >= 1);
  assert.ok(blame[0].lines >= 1);
  const diff = proj.blockDiff('fb');
  assert.ok(diff.includes('Dòng ba.'));
});

test('git projection: importFromBlocks skips blocks already present', () => {
  const dir = makeTempDir();
  const proj = new GitMemoryProjection(dir);
  proj.create({ label: 'human', content: 'Tên Huy.' }, 'user');
  const n = proj.importFromBlocks([
    { label: 'human', content: 'Trùng — phải bỏ qua.' },
    { label: 'imported-one', content: 'Nhập từ JSON cũ.', description: 'Từ v0.96' },
  ]);
  assert.equal(n, 1);
  assert.equal(proj.get('human')?.content, 'Tên Huy.');
  assert.equal(proj.get('imported-one')?.content, 'Nhập từ JSON cũ.');
});

// --- prompt recompilation ---------------------------------------------------

test('prompt recompile: system blocks first, hash cache reuses unchanged sections', () => {
  const dir = makeTempDir();
  const proj = new GitMemoryProjection(dir);
  proj.create({ label: 'human', content: 'Tên Huy.', tier: 'semantic' }, 'user');
  proj.create({ label: 'persona', content: 'Trợ lý thân thiện.', tier: 'semantic' }, 'user');
  proj.create({ label: 'notes', content: 'Ghi chú vặt.', tier: 'working' }, 'user');
  const blocks = proj.list();
  const ordered = sortBlocksForPrompt(blocks);
  assert.deepEqual(ordered.map((b) => b.label), ['human', 'persona', 'notes']);

  const recompiler = new PromptRecompiler();
  const first = recompiler.recompile(blocks);
  assert.equal(first.recompiledCount, 3);
  assert.equal(first.reusedCount, 0);
  assert.ok(first.prompt.includes('<memory label="human"'));
  assert.ok(first.prompt.includes('Tên Huy.'));
  const hash1 = first.promptHash;

  const second = recompiler.recompile(proj.list());
  assert.equal(second.recompiledCount, 0);
  assert.equal(second.reusedCount, 3);
  assert.equal(second.promptHash, hash1);
  assert.equal(second.prompt, first.prompt);

  // Only the changed block recompiles.
  proj.update('notes', { content: 'Ghi chú vặt — đã sửa.' }, 'user');
  const third = recompiler.recompile(proj.list());
  assert.equal(third.recompiledCount, 1);
  assert.equal(third.reusedCount, 2);
  assert.notEqual(third.promptHash, hash1);
  assert.ok(third.prompt.includes('đã sửa.'));

  // Pure compile matches the cached one; hash is stable.
  const pure = compileSystemPrompt(proj.list());
  assert.equal(pure.prompt, third.prompt);
  assert.equal(pure.promptHash, third.promptHash);
  assert.equal(hashBlockContent('abc').length, 64);
});

test('prompt recompile: invalidate forces one block to recompile; clear drops the cache', () => {
  const recompiler = new PromptRecompiler();
  const blocks = [
    { label: 'human', tier: 'semantic', scope: 'system', description: '', content: 'A', readOnly: false, version: 1, createdAt: '', updatedAt: '' },
    { label: 'x', tier: 'working', scope: 'user', description: '', content: 'B', readOnly: false, version: 1, createdAt: '', updatedAt: '' },
  ];
  const first = recompiler.recompile(blocks);
  assert.equal(first.recompiledCount, 2);
  recompiler.invalidate('x');
  const second = recompiler.recompile(blocks);
  assert.equal(second.recompiledCount, 1);
  assert.equal(second.reusedCount, 1);
  recompiler.clear();
  assert.equal(recompiler.cachedSections, 0);
  const third = recompiler.recompile(blocks);
  assert.equal(third.recompiledCount, 2);
});
