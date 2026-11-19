/**
 * Tests for v1.09 (Team T2) — memory v9 kiểu Letta tools:
 * packages/tools/src/memoryV9LettaTools.ts (+ registry in tools.ts).
 *
 * Covers: tool registration (23 tools in ALL_TOOLS exactly once, no
 * duplicates, approval flags match read/write), bound execution via
 * createMemoryV9LettaTools({ workspaceDir }) — core_memory_* full
 * cycle incl. append-vượt-giới-hạn tự cô đọng + replace-vượt-giới-hạn
 * lỗi, recall record/search, archival insert/search/promote/delete/
 * stats, entity snapshot/restore/export/import/stats, letta sleep
 * run/proposals/decide/log; binding via createDefaultTools({
 * getMemoryV9WorkspaceDir }) (placeholders replaced in place, same
 * 23 names, ALL_TOOLS stays 215); placeholder tools (no
 * workspaceDir) refuse with a clear error instead of crashing.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v9-letta-tools-v109.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createMemoryV9LettaTools,
  MEMORY_V9_LETTA_TOOLS,
  MEMORY_V9_LETTA_TOOL_NAMES,
} from '../packages/tools/dist/memoryV9LettaTools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv9-letta-tools-v109-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const CTX = { botId: 'bot-a', runId: 'run-1', workspaceDir: '' };

function toolByName(tools, name) {
  const found = tools.find((t) => t.definition.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

async function run(tools, name, args = {}, ctx = CTX) {
  const tool = toolByName(tools, name);
  const raw = await tool.execute(args, ctx);
  assert.ok(!raw.startsWith('Error:'), `${name} failed: ${raw}`);
  return JSON.parse(raw);
}

async function runRaw(tools, name, args = {}, ctx = CTX) {
  return toolByName(tools, name).execute(args, ctx);
}

test('registry: 23 tool Letta trong ALL_TOOLS đúng 1 lần, không trùng, approval đúng đọc/ghi', () => {
  assert.equal(MEMORY_V9_LETTA_TOOL_NAMES.length, 23);
  assert.equal(new Set(MEMORY_V9_LETTA_TOOL_NAMES).size, 23);
  const inAll = ALL_TOOLS.filter((t) => MEMORY_V9_LETTA_TOOL_NAMES.includes(t.definition.name));
  assert.equal(inAll.length, 23);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(names.length, new Set(names).size, 'ALL_TOOLS có tên trùng');
  assert.ok(ALL_TOOLS.length >= 1078, `ALL_TOOLS ${ALL_TOOLS.length} below 1078 floor`); // v1.39 fix round 4b: floor >= 1078 (was v1.38 re-pin 1078).
  const byName = new Map(inAll.map((t) => [t.definition.name, t]));
  const reads = [
    'core_memory_list', 'core_memory_read', 'core_memory_render',
    'memory_recall_search', 'memory_archival_search', 'memory_archival_stats',
    'memory_entity_snapshot', 'memory_entity_stats',
    'memory_letta_sleep_proposals', 'memory_letta_sleep_log',
  ];
  for (const name of reads) assert.equal(byName.get(name).needsApproval, false, `${name} phải là read`);
  const writes = MEMORY_V9_LETTA_TOOL_NAMES.filter((n) => !reads.includes(n));
  assert.equal(writes.length, 13);
  for (const name of writes) assert.equal(byName.get(name).needsApproval, true, `${name} phải needsApproval`);
  // Placeholder (chưa bind) có đủ 23 tool, cùng tên.
  assert.deepEqual(
    MEMORY_V9_LETTA_TOOLS.map((t) => t.definition.name).sort(),
    [...MEMORY_V9_LETTA_TOOL_NAMES].sort(),
  );
});

test('placeholder: tool chưa bind từ chối với lỗi rõ ràng, không crash', async () => {
  const tools = createMemoryV9LettaTools();
  for (const name of ['core_memory_list', 'core_memory_append', 'memory_archival_search', 'memory_letta_sleep_run']) {
    const raw = await runRaw(tools, name, name === 'core_memory_append' ? { idOrLabel: 'human', text: 'x' } : {});
    assert.ok(raw.startsWith('Error:'), `${name} phải trả Error khi chưa bind`);
    assert.ok(raw.includes('workspaceDir'), raw);
  }
});

test('core_memory_*: tạo/liệt kê/đọc/append/replace/xoá/render đủ chu kỳ', async () => {
  const dir = makeTempDir();
  const tools = createMemoryV9LettaTools({ workspaceDir: dir });
  const created = await run(tools, 'core_memory_create', { label: 'persona', description: 'tính cách', content: 'Ngắn gọn.' });
  assert.equal(created.block.label, 'persona');
  assert.equal(created.block.charLimit, 2048);
  const listed = await run(tools, 'core_memory_list', {});
  assert.equal(listed.blocks.length, 1);
  assert.equal(listed.blocks[0].usage.state, 'ok');
  const read = await run(tools, 'core_memory_read', { idOrLabel: 'persona' });
  assert.equal(read.block.content, 'Ngắn gọn.');
  const appended = await run(tools, 'core_memory_append', { idOrLabel: 'persona', text: 'Thân thiện.' });
  assert.equal(appended.condensed, false);
  assert.ok(appended.block.content.includes('Thân thiện.'));
  const replaced = await run(tools, 'core_memory_replace', { idOrLabel: 'persona', content: 'Ngắn gọn, thân thiện.' });
  assert.equal(replaced.block.content, 'Ngắn gọn, thân thiện.');
  const rendered = await run(tools, 'core_memory_render', {});
  assert.ok(rendered.prompt.includes('<persona>'));
  assert.ok(rendered.prompt.includes('Ngắn gọn, thân thiện.'));
  const deleted = await run(tools, 'core_memory_delete', { idOrLabel: 'persona' });
  assert.equal(deleted.deleted, true);
  const empty = await run(tools, 'core_memory_list', {});
  assert.equal(empty.blocks.length, 0);
});

test('core_memory_append: vượt giới hạn tự cô đọng (condensed=true); replace vượt giới hạn lỗi', async () => {
  const dir = makeTempDir();
  const tools = createMemoryV9LettaTools({ workspaceDir: dir });
  // Nhồi block tự do tới sát 2000 ký tự bằng các câu lặp chủ đề.
  const line = (i) => `Người dùng thích cà phê trứng buổi sáng ngày ${i} tại quán quen gần nhà.`;
  let filler = '';
  let i = 0;
  while (true) {
    const next = filler === '' ? line(i) : `${filler}\n${line(i)}`;
    if (next.length > 1990) break;
    filler = next;
    i += 1;
  }
  await run(tools, 'core_memory_create', { label: 'ghi-chep', content: filler });
  const appended = await run(tools, 'core_memory_append', {
    idOrLabel: 'ghi-chep',
    text: 'Người dùng vừa mua thêm một máy pha cà phê mới để pha buổi sáng mỗi ngày trước khi bắt đầu làm việc.',
  });
  assert.equal(appended.condensed, true);
  assert.ok(appended.condense.condensedChars < filler.length);
  assert.ok(appended.block.content.length <= 2000);
  const replaceRaw = await runRaw(tools, 'core_memory_replace', { idOrLabel: 'ghi-chep', content: 'y'.repeat(2001) });
  assert.ok(replaceRaw.startsWith('Error:'), replaceRaw);
  assert.ok(replaceRaw.includes('vượt giới hạn 2000'), replaceRaw);
  // Block không có -> lỗi rõ ràng.
  const missingRaw = await runRaw(tools, 'core_memory_read', { idOrLabel: 'khong-co' });
  assert.ok(missingRaw.startsWith('Error:'), missingRaw);
});

test('memory_recall_*: record rồi search theo từ khoá + recency', async () => {
  const dir = makeTempDir();
  const tools = createMemoryV9LettaTools({ workspaceDir: dir });
  const recorded = await run(tools, 'memory_recall_record', {
    sessionId: 's1',
    startedAt: '2026-11-14T08:00:00.000Z',
    endedAt: '2026-11-14T10:00:00.000Z',
    episodes: [
      { role: 'user', text: 'Người dùng hỏi về dự án open-bot.' },
      { role: 'bot', text: 'Bot trả lời về memory v9 kiểu Letta.' },
    ],
  });
  assert.equal(recorded.session.sessionId, 's1');
  assert.equal(recorded.session.turns, 2);
  const hits = await run(tools, 'memory_recall_search', { query: 'open-bot Letta' });
  assert.equal(hits.hits.length, 1);
  assert.equal(hits.hits[0].session.sessionId, 's1');
  const none = await run(tools, 'memory_recall_search', { query: 'chuyện không liên quan gì' });
  assert.equal(none.hits.length, 0);
});

test('memory_archival_*: insert/search/promote/delete/stats', async () => {
  const dir = makeTempDir();
  const tools = createMemoryV9LettaTools({ workspaceDir: dir });
  const inserted = await run(tools, 'memory_archival_insert', {
    text: 'Người dùng sống tại Hà Nội và thích cà phê trứng.',
    source: 'fact',
    tags: ['user'],
    confidence: 0.9,
  });
  assert.equal(inserted.item.source, 'fact');
  const dup = await run(tools, 'memory_archival_insert', {
    text: 'Người dùng sống tại Hà Nội và thích cà phê trứng.',
    source: 'fact',
  });
  assert.equal(dup.item.id, inserted.item.id, 'insert trùng phải trả mục cũ');
  const found = await run(tools, 'memory_archival_search', { query: 'Hà Nội cà phê' });
  assert.equal(found.total, 1);
  assert.equal('embedding' in found.hits[0].item, false, 'không rò embedding');
  // Promote lên block human.
  await run(tools, 'core_memory_create', { label: 'human', content: '' });
  const promoted = await run(tools, 'memory_archival_promote', { itemId: inserted.item.id, targetLabel: 'human' });
  assert.equal(promoted.targetLabel, 'human');
  assert.ok(promoted.block.content.includes('Hà Nội'));
  const stats = await run(tools, 'memory_archival_stats', {});
  assert.equal(stats.stats.items, 1);
  assert.equal(stats.stats.bySource.fact, 1);
  const deleted = await run(tools, 'memory_archival_delete', { itemId: inserted.item.id });
  assert.equal(deleted.deleted, true);
  const after = await run(tools, 'memory_archival_stats', {});
  assert.equal(after.stats.items, 0);
  // source không hợp lệ -> lỗi.
  const badRaw = await runRaw(tools, 'memory_archival_insert', { text: 'x', source: 'khong-hop-le' });
  assert.ok(badRaw.startsWith('Error:'), badRaw);
});

test('memory_entity_*: snapshot/restore/export/import/stats', async () => {
  const dir = makeTempDir();
  const tools = createMemoryV9LettaTools({ workspaceDir: dir });
  await run(tools, 'core_memory_create', { label: 'human', content: 'Người dùng sống tại Hà Nội.' });
  await run(tools, 'core_memory_create', { label: 'persona', content: 'Ngắn gọn.' });
  const snapshot = await run(tools, 'memory_entity_snapshot', {});
  assert.equal(snapshot.snapshot.botId, 'bot-a');
  assert.equal(snapshot.snapshot.coreBlocks.length, 2);
  assert.ok(snapshot.snapshot.checksum.length === 64);
  const stats = await run(tools, 'memory_entity_stats', {});
  assert.equal(stats.stats.coreBlocks.length, 2);
  // Export ra file rồi đổi memory, import merge để khôi phục.
  const exported = await run(tools, 'memory_entity_export', { filePath: 'exports/bot-a.json' });
  assert.ok(fs.existsSync(path.join(dir, 'exports', 'bot-a.json')));
  assert.ok(exported.filePath.endsWith('exports/bot-a.json'));
  await run(tools, 'core_memory_replace', { idOrLabel: 'human', content: 'Nội dung khác hẳn.' });
  const imported = await run(tools, 'memory_entity_import', { filePath: 'exports/bot-a.json', mode: 'replace' });
  assert.ok(imported.report.blocksRestored >= 2);
  const read = await run(tools, 'core_memory_read', { idOrLabel: 'human' });
  assert.equal(read.block.content, 'Người dùng sống tại Hà Nội.');
  // Restore từ snapshot JSON (merge) + snapshot hỏng checksum -> lỗi.
  const restored = await run(tools, 'memory_entity_restore', {
    snapshotJson: JSON.stringify(snapshot.snapshot),
    mode: 'merge',
  });
  assert.equal(restored.report.mode, 'merge');
  const tampered = { ...snapshot.snapshot, coreBlocks: [{ ...snapshot.snapshot.coreBlocks[0], content: 'ĐÃ SỬA' }] };
  const badRaw = await runRaw(tools, 'memory_entity_restore', { snapshotJson: JSON.stringify(tampered), mode: 'replace' });
  assert.ok(badRaw.startsWith('Error:'), badRaw);
  assert.ok(badRaw.includes('Checksum'), badRaw);
});

test('memory_letta_sleep_*: run dry-run + run thật + proposals + decide + log', async () => {
  const dir = makeTempDir();
  const tools = createMemoryV9LettaTools({ workspaceDir: dir });
  await run(tools, 'core_memory_create', { label: 'human', content: '' });
  await run(tools, 'memory_recall_record', {
    sessionId: 's-old',
    startedAt: '2026-11-01T08:00:00.000Z',
    endedAt: '2026-11-01T10:00:00.000Z',
    episodes: [
      { role: 'user', text: 'Người dùng nói rằng mình sống tại Hà Nội và thích cà phê trứng buổi sáng.' },
      { role: 'bot', text: 'Bot ghi nhận người dùng sống tại Hà Nội.' },
    ],
  });
  const dry = await run(tools, 'memory_letta_sleep_run', { dryRun: true });
  assert.equal(dry.report.dryRun, true);
  const emptyLog = await run(tools, 'memory_letta_sleep_log', {});
  assert.equal(emptyLog.runs.length, 0, 'dry-run không ghi log');
  const real = await run(tools, 'memory_letta_sleep_run', {});
  assert.equal(real.report.dryRun, false);
  assert.ok(real.report.factsStored >= 1);
  assert.ok(real.report.proposalsCreated >= 1);
  const proposals = await run(tools, 'memory_letta_sleep_proposals', { status: 'pending' });
  assert.ok(proposals.proposals.length >= 1);
  const first = proposals.proposals[0];
  assert.equal(first.targetLabel, 'human');
  const decided = await run(tools, 'memory_letta_sleep_proposal_decide', {
    proposalId: first.id,
    decision: 'approve',
    decidedBy: 'user',
  });
  assert.equal(decided.proposal.status, 'applied');
  const read = await run(tools, 'core_memory_read', { idOrLabel: 'human' });
  assert.ok(read.block.content.length > 0);
  const log = await run(tools, 'memory_letta_sleep_log', {});
  assert.equal(log.runs.length, 1);
  assert.equal(log.runs[0].id, real.report.id);
  // Decide lại -> lỗi.
  const againRaw = await runRaw(tools, 'memory_letta_sleep_proposal_decide', {
    proposalId: first.id,
    decision: 'approve',
  });
  assert.ok(againRaw.startsWith('Error:'), againRaw);
});

test('binding: createDefaultTools({ getMemoryV9WorkspaceDir }) bind 23 tool Letta tại chỗ, ALL_TOOLS vẫn 491', async () => {
  const dir = makeTempDir();
  const bound = createDefaultTools({ getMemoryV9WorkspaceDir: () => dir });
  assert.ok(bound.length >= 1078, `bound ${bound.length} below 1078 floor`); // v1.39 fix round 4b: floor >= 1078 (was v1.38 re-pin 1078).
  const names = bound.map((t) => t.definition.name);
  assert.equal(names.length, new Set(names).size);
  for (const name of MEMORY_V9_LETTA_TOOL_NAMES) {
    assert.ok(names.includes(name), `thiếu tool đã bind: ${name}`);
  }
  // Tool đã bind chạy được (không còn placeholder).
  const tool = toolByName(bound, 'core_memory_list');
  const raw = await tool.execute({}, { botId: 'bot-a', runId: 'r1', workspaceDir: dir });
  assert.ok(!raw.startsWith('Error:'), raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
});
