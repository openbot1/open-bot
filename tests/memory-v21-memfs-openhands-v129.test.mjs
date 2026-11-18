/**
 * Tests for memory v21 — MemFS store + OpenHands 2-tier (v1.29, Doi T1).
 * packages/core/src/memory/v21/{memfsFormat,openhandsFormat}.ts
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v21-memfs-openhands-v129.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  V21MemfsStore,
  appendOpenHandsDailyV21,
  memfsBlockToTextV21,
  parseMemfsFileV21,
  parseOpenHandsBundleV21,
  parseOpenHandsCuratedV21,
  parseOpenHandsDailyV21,
  promoteDailyToCuratedV21,
  recordToMemfsBlockV21,
  recordsToOpenHandsCuratedV21,
  recordsToOpenHandsDailyV21,
  rollupDailyLogsV21,
} from '../packages/core/dist/memory/v21/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v21-memfs-'));
}

function sampleRecord(id = 'user-thich-ca-phe') {
  return {
    id,
    type: 'fact',
    title: 'User thich ca phe',
    body: 'User uong ca phe den moi sang, khong duong.',
    tags: ['ca-phe'],
    sources: ['chat:session-1'],
    codeRefs: [],
    version: 1,
    createdAt: 1794000000000,
    updatedAt: 1794000000000,
  };
}

test('v21 memfs: write/read/list + version bump + hash in header', (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new V21MemfsStore(dir);
  store.init();
  const w1 = store.writeBlock(sampleRecord(), 'tester');
  assert.equal(w1.ok, true);
  assert.equal(w1.data.version, 1);
  assert.equal(w1.data.hash.length, 64);
  assert.match(readFileSync(join(dir, 'blocks', 'user-thich-ca-phe.md'), 'utf8'), /^<!-- memfs:id=user-thich-ca-phe version=1 hash=[0-9a-f]{64} /);
  const w2 = store.writeBlock({ ...sampleRecord(), body: 'User uong ca phe den, it duong.', version: 1 }, 'tester');
  assert.equal(w2.data.version, 2);
  const read = store.readBlock('user-thich-ca-phe');
  assert.equal(read.ok, true);
  assert.equal(read.data.body, 'User uong ca phe den, it duong.');
  assert.equal(read.data.version, 2);
  assert.equal(store.listBlocks().length, 1);
  assert.equal(store.readHistory().length, 2);
  assert.equal(store.readHistory()[0].action, 'create');
  assert.equal(store.readHistory()[1].action, 'update');
});

test('v21 memfs: verifyIntegrity catches tampering + orphan files', (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new V21MemfsStore(dir);
  store.writeBlock(sampleRecord(), 'tester');
  assert.deepEqual(store.verifyIntegrity(), []);
  // Sua file truc tiep ngoai store -> hash khong khop.
  const path = join(dir, 'blocks', 'user-thich-ca-phe.md');
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, `${text}\nDong chen leo.\n`, 'utf8');
  const issues = store.verifyIntegrity();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'hash_mismatch');
  // File thua khong co trong manifest.
  writeFileSync(join(dir, 'blocks', 'orphan.md'), '<!-- memfs:id=orphan version=1 hash=' + '0'.repeat(64) + ' updatedAt=1 -->\n\nBody.\n', 'utf8');
  const issues2 = store.verifyIntegrity();
  assert.ok(issues2.some((i) => i.kind === 'orphan_file' && i.id === 'orphan'));
});

test('v21 memfs: delete writes tombstone, restore brings the block back', (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new V21MemfsStore(dir);
  store.writeBlock(sampleRecord(), 'tester');
  const shortReason = store.deleteBlock('user-thich-ca-phe', 'tester', 'x');
  assert.equal(shortReason.ok, false);
  const deleted = store.deleteBlock('user-thich-ca-phe', 'tester', 'user doi y');
  assert.equal(deleted.ok, true);
  assert.equal(deleted.data.recordId, 'user-thich-ca-phe');
  assert.equal(deleted.data.previousVersion, 1);
  assert.equal(deleted.data.snapshot.body, 'User uong ca phe den moi sang, khong duong.');
  assert.equal(store.listBlocks().length, 0);
  assert.equal(store.listTombstones().length, 1);
  assert.equal(store.readBlock('user-thich-ca-phe').ok, false);
  const restored = store.restoreBlock('user-thich-ca-phe', 'tester');
  assert.equal(restored.ok, true);
  assert.equal(store.listBlocks().length, 1);
  assert.equal(store.readBlock('user-thich-ca-phe').data.body, 'User uong ca phe den moi sang, khong duong.');
  // Tamper + changedPathsSince: manifest truoc vs sau.
  const before = store.readManifest();
  store.writeBlock({ ...sampleRecord(), body: 'Body moi.', version: 1 }, 'tester');
  const changed = store.changedPathsSince(before);
  assert.deepEqual(changed, ['blocks/user-thich-ca-phe.md']);
});

test('v21 memfs: parseMemfsFileV21 rejects hash mismatch; block text round-trip', () => {
  const block = recordToMemfsBlockV21(sampleRecord());
  const text = memfsBlockToTextV21(block);
  const parsed = parseMemfsFileV21(text, 'blocks/user-thich-ca-phe.md');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.id, 'user-thich-ca-phe');
  assert.equal(parsed.data.originFormat, 'memfs');
  const tampered = parseMemfsFileV21(`${text}\nThem dong.\n`, 'blocks/user-thich-ca-phe.md');
  assert.equal(tampered.ok, false);
  assert.equal(tampered.errorCode, 'hash_mismatch');
  const noHeader = parseMemfsFileV21('Khong co header.\n', 'blocks/x.md');
  assert.equal(noHeader.ok, false);
});

test('v21 openhands: parse curated + daily, meta type/tags preserved', () => {
  const curated = `# Memory

## User thich ca phe
<!-- type: fact | tags: ca-phe, so-thich -->

User uong ca phe den moi sang.

## Quyet dinh dung Ollama local
<!-- type: decision -->

Chay model local de tiet kiem chi phi.
`;
  const parsed = parseOpenHandsCuratedV21(curated);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.length, 2);
  assert.equal(parsed.data[0].tier, 'curated');
  assert.equal(parsed.data[0].heading, 'User thich ca phe');
  const daily = `# 2026-11-17

### 09:30 — Hop voi team

Thong nhat dung Ollama local.

### Ghi chu nhanh

Can test them ve dem.
`;
  const dailyParsed = parseOpenHandsDailyV21(daily, '2026-11-17');
  assert.equal(dailyParsed.ok, true);
  assert.equal(dailyParsed.data.length, 2);
  assert.equal(dailyParsed.data[0].time, '09:30');
  assert.equal(dailyParsed.data[0].date, '2026-11-17');
  assert.equal(parseOpenHandsDailyV21(daily, '17/11/2026').ok, false);
  const bundle = parseOpenHandsBundleV21(curated, [{ date: '2026-11-17', content: daily }]);
  assert.equal(bundle.ok, true);
  assert.equal(bundle.data.records.length, 4);
  const fact = bundle.data.records.find((r) => r.id === 'user-thich-ca-phe');
  assert.equal(fact.type, 'fact');
  assert.deepEqual(fact.tags, ['ca-phe', 'so-thich']);
  const decision = bundle.data.records.find((r) => r.id === 'quyet-dinh-dung-ollama-local');
  assert.equal(decision.type, 'decision');
});

test('v21 openhands: serialize curated round-trip + append daily + rollup', () => {
  const records = [sampleRecord(), { ...sampleRecord('quyet-dinh-ollama'), type: 'decision', title: 'Quyet dinh dung Ollama', body: 'Chay local.' }];
  const curated = recordsToOpenHandsCuratedV21(records);
  assert.match(curated, /^# Memory\n/);
  assert.match(curated, /## User thich ca phe\n<!-- type: fact \| tags: ca-phe -->/);
  const reparsed = parseOpenHandsCuratedV21(curated);
  assert.equal(reparsed.data.length, 2);
  const daily = recordsToOpenHandsDailyV21('2026-11-17', [{ time: '09:30', title: 'Hop', body: 'Noi dung hop.' }]);
  assert.match(daily, /^# 2026-11-17\n\n### 09:30 — Hop\n/);
  const appended = appendOpenHandsDailyV21(daily, '2026-11-17', { time: '10:00', title: 'Viet code', body: 'Xong v21.' });
  assert.equal(appended.ok, true);
  assert.match(appended.data, /### 09:30 — Hop/);
  assert.match(appended.data, /### 10:00 — Viet code/);
  assert.equal(appendOpenHandsDailyV21('', '17/11/2026', { title: 'X', body: 'Y' }).ok, false);
  const rollup = rollupDailyLogsV21([
    { date: '2026-11-16', content: daily },
    { date: '2026-11-17', content: appended.data },
  ]);
  assert.match(rollup.body, /2026-11-16: 1 entry/);
  assert.match(rollup.body, /2026-11-17: 2 entry/);
  assert.deepEqual(rollup.sources, ['daily:2026-11-16', 'daily:2026-11-17']);
});

test('v21 openhands: promoteDailyToCuratedV21 dedupes + skips empty', () => {
  const curated = [{ ...sampleRecord(), body: 'User uong ca phe den moi sang, khong duong.' }];
  const daily = [
    { ...sampleRecord('daily-1'), body: 'User uong ca phe den moi sang khong duong.', tags: ['daily-log'] },
    { ...sampleRecord('daily-2'), body: 'User thich tra dao vao buoi chieu.', tags: ['daily-log'] },
    { ...sampleRecord('daily-3'), body: '   ', tags: ['daily-log'] },
  ];
  const result = promoteDailyToCuratedV21(daily, curated);
  assert.equal(result.promoted.length, 1);
  assert.equal(result.promoted[0].id, 'daily-2');
  assert.deepEqual(result.promoted[0].tags, []);
  assert.equal(result.skippedDuplicate.length, 1);
  assert.equal(result.skippedDuplicate[0].similarTo, 'user-thich-ca-phe');
  assert.ok(result.skippedDuplicate[0].similarity >= 0.6);
  assert.equal(result.skippedEmpty.length, 1);
});
