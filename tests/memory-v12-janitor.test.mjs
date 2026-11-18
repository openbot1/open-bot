/**
 * Tests for v1.12 (Doi T1) — memory v12 sleep-time janitor:
 * packages/core/src/memory/v12/sleepJanitor.ts.
 *
 * Covers: normalizeJanitorLine / isBulletLine / dedupeBlockLines,
 * runBlockJanitorPass (in-block dedupe, cross-block bullet merge
 * into the highest-priority block, trim over charLimit oldest-first,
 * promote learned_context -> human, skip read-only/system-owned,
 * dry-run writes nothing, idempotent second run, janitor log),
 * runJanitorIfIdle (disabled / not-idle / too-soon / forced).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v12-janitor.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryBlockStore } from '../packages/core/dist/memory/blocks.js';
import {
  normalizeJanitorLine,
  isBulletLine,
  dedupeBlockLines,
  runBlockJanitorPass,
  readV12JanitorLog,
  runJanitorIfIdle,
  V12_JANITOR_ACTOR,
} from '../packages/core/dist/memory/v12/sleepJanitor.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv12-janitor-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seed(dir, botId, label, content, extra = {}) {
  const store = new MemoryBlockStore(dir);
  const created = store.create(
    { label, description: '', content, charLimit: extra.charLimit ?? 4096, ...extra },
    'user',
  );
  store.attach(botId, created.id, 'user');
  return store;
}

test('janitor: line helpers', () => {
  assert.equal(normalizeJanitorLine('  Thích   Cà Phê  '), 'thích cà phê');
  assert.equal(isBulletLine('- fact'), true);
  assert.equal(isBulletLine('* fact'), true);
  assert.equal(isBulletLine('• fact'), true);
  assert.equal(isBulletLine('-'), false);
  assert.equal(isBulletLine('plain line'), false);
  assert.equal(isBulletLine(''), false);
});

test('janitor: dedupeBlockLines keeps the first copy, collapses blank runs', () => {
  const out = dedupeBlockLines([
    '- thich tra',
    '',
    '',
    '- THICH  tra',
    'ghi chu',
    'ghi chu',
    '',
    '- khac',
  ]);
  assert.deepEqual(out.lines, ['- thich tra', '', 'ghi chu', '', '- khac']);
  assert.equal(out.removed, 3);
});

test('janitor: dedupes lines inside a block and bumps version once', () => {
  const dir = makeTempDir();
  const store = seed(
    dir,
    'bot-1',
    'human',
    '- thich tra\n- thich tra\n- THICH  tra\n- thich ca phe',
  );
  const report = runBlockJanitorPass(store, { botId: 'bot-1' });
  assert.equal(report.linesDeduped, 2);
  assert.equal(report.blocksChanged, 1);
  assert.equal(report.changes[0].label, 'human');
  assert.equal(report.changes[0].beforeVersion, 1);
  assert.equal(report.changes[0].afterVersion, 2);
  assert.equal(store.get('human').content, '- thich tra\n- thich ca phe');
  assert.equal(report.dryRun, false);
  // Audit: janitor writes as system:sleep-v12.
  assert.ok(
    store.readAudit(10).some((e) => e.actor === V12_JANITOR_ACTOR && e.action === 'replace'),
  );
});

test('janitor: identical bullets merge into the highest-priority block', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const human = store.create(
    { label: 'human', description: '', content: '- thich tra', charLimit: 4096 },
    'user',
  );
  const task = store.create(
    { label: 'task', description: '', content: '- thich tra\n- lam A', charLimit: 4096 },
    'user',
  );
  store.attach('bot-1', human.id, 'user');
  store.attach('bot-1', task.id, 'user');
  const report = runBlockJanitorPass(store, { botId: 'bot-1' });
  assert.equal(report.linesMerged, 1);
  assert.equal(store.get('human').content, '- thich tra');
  assert.equal(store.get('task').content, '- lam A');
});

test('janitor: trims a block over its char limit, oldest lines first', () => {
  const dir = makeTempDir();
  // Store khong cho tao block vuot limit, nen gia lap du lieu legacy:
  // tao block vua limit 2000 roi ha limit xuong 100 bang cach sua
  // truc tiep file JSON (mo phong limit bi ha sau khi block da co).
  const lines = Array.from({ length: 10 }, (_, i) => `dong-${String(i + 1).padStart(2, '0')}-xxxxxx`);
  const store = seed(dir, 'bot-1', 'task', lines.join('\n'), { charLimit: 2000 });
  const filePath = path.join(dir, '.open-bot', 'memory-blocks.json');
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  file.blocks.find((b) => b.label === 'task').charLimit = 100;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2));
  const report = runBlockJanitorPass(store, { botId: 'bot-1' });
  assert.ok(report.linesTrimmed > 0, `trimmed=${report.linesTrimmed}`);
  const content = store.get('task').content;
  assert.ok(content.length <= 100, `len=${content.length}`);
  assert.ok(!content.includes('dong-01-'), 'oldest line dropped first');
  assert.ok(content.includes('dong-10-'), 'newest line kept');
});

test('janitor: promotes learned_context bullets into human and removes them from source', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const human = store.create(
    { label: 'human', description: '', content: '- ten: Huy', charLimit: 4096 },
    'user',
  );
  const learned = store.create(
    {
      label: 'learned_context',
      description: '',
      content: '- thich tra da\n- ten: Huy\n- lam du an open-bot',
      charLimit: 4096,
    },
    'user',
  );
  store.attach('bot-1', human.id, 'user');
  store.attach('bot-1', learned.id, 'user');
  const report = runBlockJanitorPass(store, { botId: 'bot-1' });
  assert.equal(report.linesPromoted, 2);
  assert.equal(
    store.get('human').content,
    '- ten: Huy\n- thich tra da\n- lam du an open-bot',
  );
  // '- ten: Huy' was already in human: merged away, not promoted twice.
  assert.equal(store.get('learned_context').content, '');
});

test('janitor: creates human block when promoting and none exists', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const learned = store.create(
    { label: 'learned_context', description: '', content: '- thich tra da', charLimit: 4096 },
    'user',
  );
  store.attach('bot-1', learned.id, 'user');
  const report = runBlockJanitorPass(store, { botId: 'bot-1' });
  assert.equal(report.linesPromoted, 1);
  const human = store.get('human');
  assert.ok(human);
  assert.equal(human.content, '- thich tra da');
  assert.ok(store.isAttached('bot-1', human.id));
});

test('janitor: read-only and system-owned blocks are skipped, never written', () => {
  const dir = makeTempDir();
  const store = new MemoryBlockStore(dir);
  const ro = store.create(
    {
      label: 'persona',
      description: '',
      content: '- a\n- a\n- a',
      charLimit: 4096,
      readOnly: true,
    },
    'user',
  );
  const sys = store.create(
    {
      label: 'safety',
      description: '',
      content: '- x\n- x',
      charLimit: 2048,
      readOnly: true,
      systemOwned: true,
    },
    'user',
  );
  store.attach('bot-1', ro.id, 'user');
  store.attach('bot-1', sys.id, 'user');
  const report = runBlockJanitorPass(store, { botId: 'bot-1' });
  assert.equal(report.linesDeduped, 0);
  assert.deepEqual(
    report.skipped.map((s) => `${s.label}:${s.reason}`).sort(),
    ['persona:read-only', 'safety:system-owned'],
  );
  assert.equal(store.get('persona').content, '- a\n- a\n- a');
  assert.equal(store.get('persona').version, 1);
});

test('janitor: dry-run computes but writes nothing and logs nothing', () => {
  const dir = makeTempDir();
  const store = seed(dir, 'bot-1', 'human', '- a\n- a\n- b');
  const report = runBlockJanitorPass(store, { botId: 'bot-1', dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.linesDeduped, 1);
  assert.equal(store.get('human').content, '- a\n- a\n- b');
  assert.equal(store.get('human').version, 1);
  assert.deepEqual(readV12JanitorLog(dir), []);
});

test('janitor: second run right after is a no-op (idempotent) and the log records both', () => {
  const dir = makeTempDir();
  const store = seed(dir, 'bot-1', 'human', '- a\n- a\n- b');
  const first = runBlockJanitorPass(store, { botId: 'bot-1' });
  assert.equal(first.blocksChanged, 1);
  const second = runBlockJanitorPass(store, { botId: 'bot-1' });
  assert.equal(second.blocksChanged, 0);
  assert.equal(second.linesDeduped, 0);
  const log = readV12JanitorLog(dir);
  assert.equal(log.length, 2);
  assert.equal(log[0].passId, second.passId);
});

test('janitor: runJanitorIfIdle respects the consolidation config', () => {
  const dir = makeTempDir();
  const store = seed(dir, 'bot-1', 'human', '- a\n- a');
  // Default config is disabled.
  const disabled = runJanitorIfIdle(store, { botId: 'bot-1' });
  assert.equal(disabled.ran, false);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(store.get('human').content, '- a\n- a');

  // Enabled but bot was active 1 minute ago, idleMinutes=30 -> not idle.
  const now = Date.now();
  store.setConsolidationConfig(
    { enabled: true, idleMinutes: 30, lastActivityAt: new Date(now - 60000).toISOString() },
    'user',
  );
  const notIdle = runJanitorIfIdle(store, { botId: 'bot-1', now });
  assert.equal(notIdle.ran, false);
  assert.equal(notIdle.reason, 'not-idle');
  assert.equal(notIdle.idleMinutes, 1);

  // Forced runs even when not idle.
  const forced = runJanitorIfIdle(store, { botId: 'bot-1', now, force: true });
  assert.equal(forced.ran, true);
  assert.equal(forced.reason, 'forced');
  assert.equal(forced.report.linesDeduped, 1);

  // Right after a run, a normal call is too soon (30 min interval) —
  // move last activity far back first so the idle gate passes.
  store.setConsolidationConfig(
    { lastActivityAt: new Date(now - 61 * 60000).toISOString() },
    'user',
  );
  const tooSoon = runJanitorIfIdle(store, { botId: 'bot-1', now: now + 60000 });
  assert.equal(tooSoon.ran, false);
  assert.equal(tooSoon.reason, 'too-soon');
});
