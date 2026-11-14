/**
 * Tests for v1.05 (Team T1) — memory v6 history + export + CLI:
 * packages/core/src/memory/v3/{history,export}.ts and
 * apps/cli/src/cli.ts (`open-bot memory-v6 ...`).
 *
 * Covers: point-in-time status (statusAtTime / listActiveAt /
 * resolveKeyAt), record timeline, event counting, stats markdown,
 * export/import JSON round-trip (version chain preserved, second
 * import dedupes), markdown export, and the real built CLI
 * (append/search/recall/forget/stats/sleep/export/import/history).
 *
 * Run after building core + cli:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/cli
 *   node --test tests/memory-v6-history-export-v105.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  V6RecordStore,
  countEventsByType,
  exportV6Markdown,
  exportV6Store,
  importV6Store,
  listActiveAt,
  parseV6ExportFile,
  recordTimeline,
  resolveKeyAt,
  retireRecord,
  statusAtTime,
  statsMarkdown,
} from '../packages/core/dist/memory/v3/index.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'apps/cli/dist/cli.js');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv6hist-v105-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function daysAgoDate(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function rewriteStoreFile(dir, mutate) {
  const filePath = path.join(dir, '.open-bot', 'memory-v6.json');
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  mutate(file);
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2));
}

async function runCli(args, cwd) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd,
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

// -------------------------------------------------------------- history ---
test('v6 history: statusAtTime + listActiveAt theo record time', () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  const view = store.append({
    text: 'User sống ở Hà Nội.',
    kind: 'fact',
    key: 'home_city',
    scope: { userId: 'u1', agentId: '', runId: '', appId: '' },
    source: { type: 'tool', ref: 't' },
  });
  retireRecord(store, view.id, 'user', 'Chuyển nhà.');
  // Dời thời gian: tạo 10 ngày trước, retire 5 ngày trước.
  rewriteStoreFile(dir, (file) => {
    file.records[0].createdAt = daysAgo(10);
    file.records[0].updatedAt = daysAgo(10);
    file.events[0].at = daysAgo(5);
  });
  const fresh = V6RecordStore.fromWorkspace(dir);
  const snapshot = fresh.snapshot();
  const record = snapshot.records[0];
  assert.equal(statusAtTime(record, snapshot.events, daysAgoDate(7)).status, 'active');
  assert.equal(statusAtTime(record, snapshot.events, daysAgoDate(3)).status, 'retired');
  assert.equal(listActiveAt(fresh, daysAgoDate(7)).length, 1);
  assert.equal(listActiveAt(fresh, daysAgoDate(3)).length, 0);
  assert.equal(listActiveAt(fresh, daysAgoDate(11)).length, 0, 'chưa tạo thì chưa active');
});

test('v6 history: resolveKeyAt trả giá trị đúng lúc T', () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  const v1 = store.append({
    text: 'User sống ở Hà Nội.', kind: 'fact', key: 'home_city',
    scope: { userId: 'u1', agentId: '', runId: '', appId: '' },
    source: { type: 'tool', ref: 't' },
  });
  const v2 = store.append({
    text: 'User sống ở Đà Nẵng.', kind: 'fact', key: 'home_city',
    scope: { userId: 'u1', agentId: '', runId: '', appId: '' },
    source: { type: 'tool', ref: 't' },
    supersedes: v1.id,
  });
  rewriteStoreFile(dir, (file) => {
    file.records.find((r) => r.id === v1.id).createdAt = daysAgo(10);
    file.records.find((r) => r.id === v2.id).createdAt = daysAgo(2);
    for (const e of file.events) e.at = daysAgo(2);
  });
  const fresh = V6RecordStore.fromWorkspace(dir);
  const query = { userId: 'u1' };
  assert.equal(resolveKeyAt(fresh, query, 'home_city', daysAgoDate(5))?.text, 'User sống ở Hà Nội.');
  assert.equal(resolveKeyAt(fresh, query, 'home_city', daysAgoDate(1))?.text, 'User sống ở Đà Nẵng.');
  assert.equal(resolveKeyAt(fresh, query, 'missing', daysAgoDate(1)), undefined);
});

test('v6 history: recordTimeline + countEventsByType + statsMarkdown', () => {
  const dir = makeTempDir();
  const store = V6RecordStore.fromWorkspace(dir);
  const v1 = store.append({
    text: 'User thích trà.', kind: 'fact',
    scope: { userId: 'u1', agentId: '', runId: '', appId: '' },
    source: { type: 'tool', ref: 't' },
  });
  retireRecord(store, v1.id, 'user', 'Đổi sang cà phê.');
  const steps = recordTimeline(store, v1.id);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].kind, 'created');
  assert.equal(steps[1].kind, 'retired');
  assert.match(steps[1].label, /Đổi sang cà phê/);
  assert.deepEqual(recordTimeline(store, 'no-such-id'), []);
  const counts = countEventsByType(store.listEvents());
  assert.equal(counts.retire, 1);
  assert.equal(counts.supersede, 0);
  const md = statsMarkdown(store, store.stats());
  assert.match(md, /Tổng bản ghi: \*\*1\*\*/);
  assert.match(md, /retired 1/);
  assert.match(md, /Event gần nhất/);
});

// --------------------------------------------------------------- export ---
test('v6 export: round-trip JSON giữ chuỗi version, import lần 2 dedupe', () => {
  const dirA = makeTempDir();
  const storeA = V6RecordStore.fromWorkspace(dirA);
  const v1 = storeA.append({
    text: 'User sống ở Hà Nội.', kind: 'fact', key: 'home_city',
    scope: { userId: 'u1', agentId: '', runId: '', appId: '' },
    source: { type: 'tool', ref: 't' },
  });
  storeA.append({
    text: 'User sống ở Đà Nẵng.', kind: 'fact', key: 'home_city',
    scope: { userId: 'u1', agentId: '', runId: '', appId: '' },
    source: { type: 'tool', ref: 't' },
    supersedes: v1.id,
  });
  const exported = exportV6Store(storeA);
  assert.equal(exported.recordCount, 2);
  assert.equal(exported.eventCount, 1);

  const dirB = makeTempDir();
  const storeB = V6RecordStore.fromWorkspace(dirB);
  const first = importV6Store(storeB, exported);
  assert.equal(first.importedRecords, 2);
  assert.equal(first.skippedDuplicateRecords, 0);
  assert.equal(storeB.count(), 2);
  const oldView = storeB.listAll().find((r) => r.text === 'User sống ở Hà Nội.');
  const newView = storeB.listAll().find((r) => r.text === 'User sống ở Đà Nẵng.');
  assert.ok(oldView && newView);
  assert.equal(oldView.status, 'superseded', 'chuỗi version được giữ sau import');
  assert.equal(oldView.supersededBy, newView.id);
  assert.equal(newView.status, 'active');

  const second = importV6Store(storeB, exported);
  assert.equal(second.importedRecords, 0);
  assert.equal(second.skippedDuplicateRecords, 2);
  assert.equal(storeB.count(), 2);
});

test('v6 export: parse file hỏng thì throw; markdown export gom theo scope', () => {
  assert.throws(() => parseV6ExportFile('{not json'), /không parse được JSON/);
  assert.throws(() => parseV6ExportFile('{"a":1}'), /thiếu records\/events/);
  const parsed = parseV6ExportFile(JSON.stringify({ version: 1, records: [], events: [] }));
  assert.equal(parsed.recordCount, 0);

  const store = V6RecordStore.inMemory();
  store.append({
    text: 'User thích phở.', kind: 'fact',
    scope: { userId: 'u1', agentId: '', runId: '', appId: '' },
    source: { type: 'tool', ref: 't' },
  });
  const md = exportV6Markdown(store);
  assert.match(md, /## Scope user/);
  assert.match(md, /User thích phở/);
  assert.match(exportV6Markdown(V6RecordStore.inMemory()), /Kho trống/);
});

test('v6 export: import event mồ côi thì bỏ qua, không fail', () => {
  const store = V6RecordStore.inMemory();
  const report = importV6Store(store, {
    version: 1,
    records: [],
    events: [
      { seq: 1, type: 'retire', targetId: 'ghost', reason: 'x', actor: 'u', at: new Date().toISOString() },
      { seq: 2, type: 'bogus', targetId: 'ghost', reason: 'x', actor: 'u', at: new Date().toISOString() },
    ],
    exportedAt: new Date().toISOString(),
    recordCount: 0,
    eventCount: 2,
  });
  assert.equal(report.importedEvents, 0);
  assert.equal(report.skippedOrphanEvents, 2);
});

// ------------------------------------------------------------------- CLI ---
test('cli memory-v6: append/search/recall/forget/stats qua CLI thật', async () => {
  const dir = makeTempDir();
  const ws = ['--workspace', dir];
  const appended = await runCli(['memory-v6', 'append', 'User thích phở bò.', '--user', 'u1', '--json', ...ws], dir);
  assert.equal(appended.code, 0, `stderr: ${appended.stderr}`);
  const view = JSON.parse(appended.stdout);
  assert.equal(view.version, 1);
  assert.equal(view.status, 'active');

  const searched = await runCli(['memory-v6', 'search', 'phở', '--user', 'u1', '--json', ...ws], dir);
  assert.equal(searched.code, 0, `stderr: ${searched.stderr}`);
  const hits = JSON.parse(searched.stdout);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, view.id);
  assert.ok(hits[0].breakdown);

  const recalled = await runCli(['memory-v6', 'recall', 'food', '--user', 'u1', '--json', ...ws], dir);
  assert.equal(JSON.parse(recalled.stdout).found, false, 'chưa có key food');

  const forgotten = await runCli(['memory-v6', 'forget', view.id, '--reason', 'test', '--json', ...ws], dir);
  assert.equal(forgotten.code, 0, `stderr: ${forgotten.stderr}`);
  assert.equal(JSON.parse(forgotten.stdout).status, 'retired');

  const stats = await runCli(['memory-v6', 'stats', '--json', ...ws], dir);
  assert.equal(JSON.parse(stats.stdout).retiredRecords, 1);
});

test('cli memory-v6: sleep/export/import/history + lỗi dùng', async () => {
  const dir = makeTempDir();
  const ws = ['--workspace', dir];
  await runCli(['memory-v6', 'append', 'User thích trà.', '--user', 'u1', ...ws], dir);
  const sleep = await runCli(['memory-v6', 'sleep', '--json', ...ws], dir);
  assert.equal(sleep.code, 0, `stderr: ${sleep.stderr}`);
  assert.equal(JSON.parse(sleep.stdout).examined, 1);

  const outFile = path.join(dir, 'v6-export.json');
  const exported = await runCli(['memory-v6', 'export', '--out', outFile, ...ws], dir);
  assert.equal(exported.code, 0, `stderr: ${exported.stderr}`);
  assert.ok(fs.existsSync(outFile));

  const dir2 = makeTempDir();
  const imported = await runCli(['memory-v6', 'import', outFile, '--workspace', dir2, '--json'], dir2);
  assert.equal(imported.code, 0, `stderr: ${imported.stderr}`);
  assert.equal(JSON.parse(imported.stdout).importedRecords, 1);

  const listed = await runCli(['memory-v6', 'stats', '--workspace', dir2, '--json'], dir2);
  const stats = JSON.parse(listed.stdout);
  assert.equal(stats.totalRecords, 1);

  const id = JSON.parse((await runCli(['memory-v6', 'search', 'trà', '--user', 'u1', '--json', ...ws], dir)).stdout)[0].id;
  const history = await runCli(['memory-v6', 'history', id, '--json', ...ws], dir);
  assert.equal(history.code, 0, `stderr: ${history.stderr}`);
  assert.equal(JSON.parse(history.stdout).steps[0].kind, 'created');

  const noReason = await runCli(['memory-v6', 'forget', id, ...ws], dir);
  assert.equal(noReason.code, 1);
  assert.match(noReason.stderr, /cần --reason/);
  const noSub = await runCli(['memory-v6', ...ws], dir);
  assert.equal(noSub.code, 1);
  assert.match(noSub.stderr, /cần subcommand/);
});
