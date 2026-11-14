/**
 * Tests for v1.05 (Team T1) — memory v6 tools:
 * packages/tools/src/memoryV6Tools.ts
 * (createMemoryV6Tools / MEMORY_V6_TOOLS / MEMORY_V6_TOOL_NAMES).
 *
 * Covers: the 8 memory_v6_* tools end to end on a temp workspace
 * (append -> recall -> fused search -> forget -> stats, share block
 * create/share/get/list, sleep consolidate, migrate long-term),
 * unbound placeholder shape, and no duplicate tool names.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v6-tools-v105.test.mjs
 *
 * No network. No model (semantic source is TF-IDF).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  V6RecordStore,
  SharedBlockStore,
  LongTermMemory,
  TemporalGraphStore,
} from '../packages/core/dist/index.js';
import {
  createMemoryV6Tools,
  MEMORY_V6_TOOLS,
  MEMORY_V6_TOOL_NAMES,
} from '../packages/tools/dist/memoryV6Tools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv6tools-v105-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ctx = { workspaceDir: '', botId: 'bot-main' };

function makeTools(dir) {
  return createMemoryV6Tools({
    v6Store: V6RecordStore.fromWorkspace(dir),
    workspaceDir: dir,
    blocksStore: SharedBlockStore.fromWorkspace(dir),
    longTerm: new LongTermMemory(dir),
    graphStore: TemporalGraphStore.fromWorkspace(dir),
    getUserId: () => 'user-1',
    appId: 'open-bot',
  });
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  return tool;
}

test('v6 tools: 8 tools, tên khớp MEMORY_V6_TOOL_NAMES, không trùng', () => {
  const tools = makeTools(makeTempDir());
  assert.equal(tools.length, 8);
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    [...MEMORY_V6_TOOL_NAMES],
  );
  assert.equal(new Set(tools.map((t) => t.definition.name)).size, 8);
  assert.equal(MEMORY_V6_TOOLS.length, 8, 'unbound placeholder cũng có 8 tool');
  assert.deepEqual(
    MEMORY_V6_TOOLS.map((t) => t.definition.name),
    [...MEMORY_V6_TOOL_NAMES],
  );
  const approvals = Object.fromEntries(
    tools.map((t) => [t.definition.name, t.needsApproval]),
  );
  assert.equal(approvals.memory_v6_append, true);
  assert.equal(approvals.memory_v6_recall, false);
  assert.equal(approvals.memory_v6_forget, true);
  assert.equal(approvals.memory_v6_fused_search, false);
  assert.equal(approvals.memory_v6_share_block, true);
  assert.equal(approvals.memory_v6_sleep_consolidate, true);
  assert.equal(approvals.memory_v6_stats, false);
  assert.equal(approvals.memory_v6_migrate, true);
});

test('v6 tools: append -> recall -> fused_search -> forget -> stats', async () => {
  const dir = makeTempDir();
  const tools = makeTools(dir);
  const appendOut = await toolByName(tools, 'memory_v6_append').execute(
    { text: 'User thích phở bò Hà Nội.', kind: 'fact', key: 'food', entities: ['phở', 'hà nội'] },
    ctx,
  );
  const appended = JSON.parse(appendOut);
  assert.equal(appended.version, 1);
  assert.equal(appended.scopeLevel, 'agent');
  assert.equal(appended.status, 'active');

  const recallOut = await toolByName(tools, 'memory_v6_recall').execute({ key: 'food' }, ctx);
  const recalled = JSON.parse(recallOut);
  assert.equal(recalled.found, true);
  assert.equal(recalled.text, 'User thích phở bò Hà Nội.');

  const searchOut = await toolByName(tools, 'memory_v6_fused_search').execute(
    { query: 'phở Hà Nội' },
    ctx,
  );
  const hits = JSON.parse(searchOut);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, appended.id);
  assert.ok(hits[0].breakdown);
  assert.equal(hits[0].breakdown.semanticSource, 'tfidf');
  assert.match(hits[0].explanation, /final/);

  const missingRecall = JSON.parse(
    await toolByName(tools, 'memory_v6_recall').execute({ key: 'nope' }, ctx),
  );
  assert.equal(missingRecall.found, false);

  const forgetOut = await toolByName(tools, 'memory_v6_forget').execute(
    { id: appended.id, reason: 'User đổi ý.' },
    ctx,
  );
  assert.equal(JSON.parse(forgetOut).status, 'retired');
  const afterForget = JSON.parse(
    await toolByName(tools, 'memory_v6_recall').execute({ key: 'food' }, ctx),
  );
  assert.equal(afterForget.found, false, 'retired record must not resolve');

  const statsOut = await toolByName(tools, 'memory_v6_stats').execute({}, ctx);
  const stats = JSON.parse(statsOut);
  assert.equal(stats.totalRecords, 1);
  assert.equal(stats.retiredRecords, 1);
  assert.deepEqual(stats.versionChainProblems, []);
});

test('v6 tools: append thiếu text / forget thiếu reason thì lỗi rõ', async () => {
  const tools = makeTools(makeTempDir());
  assert.match(await toolByName(tools, 'memory_v6_append').execute({}, ctx), /^Error: Missing required argument/);
  assert.match(
    await toolByName(tools, 'memory_v6_forget').execute({ id: 'x' }, ctx),
    /^Error: Missing required argument/,
  );
  assert.match(
    await toolByName(tools, 'memory_v6_fused_search').execute({ query: 'phở', weightSemantic: 2 }, ctx),
    /^\[/,
    'trọng số lệch vẫn chuẩn hoá được, không lỗi',
  );
});

test('v6 tools: share_block create/share/get/list/unshare', async () => {
  const dir = makeTempDir();
  const tools = makeTools(dir);
  const share = toolByName(tools, 'memory_v6_share_block');
  const created = JSON.parse(
    await share.execute({ action: 'create', name: 'team-notes', content: 'Họp thứ 2.' }, ctx),
  );
  assert.equal(created.version, 1);
  assert.match(
    await share.execute({ action: 'create', name: 'team-notes', content: 'trùng' }, ctx),
    /^Error: Đã có block/,
  );
  const shared = JSON.parse(
    await share.execute(
      { action: 'share', blockId: created.id, targetBotId: 'bot-other', permission: 'read' },
      ctx,
    ),
  );
  assert.equal(shared.sharedWith, 'bot-other');
  const got = JSON.parse(await share.execute({ action: 'get', blockId: created.id }, ctx));
  assert.equal(got.content, 'Họp thứ 2.');
  assert.equal(got.historyVersions, 1);
  const listed = JSON.parse(await share.execute({ action: 'list' }, ctx));
  assert.equal(listed.blocks.length, 1);
  assert.equal(listed.blocks[0].permission, 'write', 'owner luôn có write');
  const updated = JSON.parse(
    await share.execute({ action: 'update', blockId: created.id, content: 'Họp thứ 3.' }, ctx),
  );
  assert.equal(updated.version, 2);
  const unshared = JSON.parse(
    await share.execute({ action: 'unshare', blockId: created.id, targetBotId: 'bot-other' }, ctx),
  );
  assert.equal(unshared.unshared, 'bot-other');
  assert.match(await share.execute({ action: 'bogus' }, ctx), /^Error: Unknown action/);
});

test('v6 tools: sleep_consolidate dedupe + ghi log; migrate longterm idempotent', async () => {
  const dir = makeTempDir();
  const longTerm = new LongTermMemory(dir);
  longTerm.remember({ key: 'city', value: 'Hà Nội', botId: 'bot-main', userId: 'user-1' });
  const tools = makeTools(dir);
  const migrateOut = await toolByName(tools, 'memory_v6_migrate').execute({ source: 'longterm' }, ctx);
  assert.match(migrateOut, /longterm.*migrate 1/);
  const migrateAgain = await toolByName(tools, 'memory_v6_migrate').execute({ source: 'longterm' }, ctx);
  assert.match(migrateAgain, /trùng 1/);

  await toolByName(tools, 'memory_v6_append').execute({ text: 'User thích phở.' }, ctx);
  await toolByName(tools, 'memory_v6_append').execute({ text: 'User thích phở.' }, ctx);
  const sleepOut = await toolByName(tools, 'memory_v6_sleep_consolidate').execute({}, ctx);
  const report = JSON.parse(sleepOut);
  assert.equal(report.examined, 2, 'append trùng đã dedupe lúc ghi nên chỉ còn 2 bản');
  assert.equal(report.dedupedExact, 0);
  assert.equal(report.stoppedByBudget, false);
  const logPath = path.join(dir, '.open-bot', 'sleep-v6-log.json');
  assert.ok(fs.existsSync(logPath), 'tool sleep phải ghi log');
  const stats = JSON.parse(await toolByName(tools, 'memory_v6_stats').execute({}, ctx));
  assert.equal(stats.totalRecords, 2);
});

test('v6 tools: không có store thì lỗi rõ, không crash', async () => {
  const tools = createMemoryV6Tools();
  assert.match(
    await toolByName(tools, 'memory_v6_append').execute({ text: 'x' }, ctx),
    /^Error: memory v6 store is not available/,
  );
  assert.match(
    await toolByName(tools, 'memory_v6_stats').execute({}, ctx),
    /^Error: memory v6 store is not available/,
  );
  assert.match(
    await toolByName(tools, 'memory_v6_share_block').execute({ action: 'list' }, ctx),
    /^Error: shared block store is not available/,
  );
});
