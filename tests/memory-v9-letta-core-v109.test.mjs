/**
 * Tests for v1.09 (Team T2) — memory v9 kiểu Letta core:
 * packages/core/src/memory/v9/{condense,coreMemory,recall,archival,
 * sleepProposals,entity,sleepConsolidation}.ts
 *
 * Covers:
 *  - condense: tách câu, chấm điểm, dedupe gần trùng (Jaccard),
 *    cô đọng về giới hạn (giữ câu gốc theo thứ tự, không bịa chữ),
 *    nội dung vừa giới hạn chỉ dedupe, rỗng/quá ngắn giữ nguyên.
 *  - coreMemory: giới hạn cứng persona 2KB / human 4KB / project 8KB,
 *    create ép giới hạn hệ thống, ensureCoreBlocks idempotent,
 *    append vừa giới hạn, append vượt giới hạn TỰ CÔ ĐỌNG (condensed=true),
 *    append quá dài dù đã cô đọng -> lỗi kèm số ký tự còn append được,
 *    replace vượt giới hạn -> lỗi, delete, read-only bị chặn,
 *    renderCorePrompt đúng thứ tự persona->human->project.
 *  - recall: recordSession (cắt episode, summary trích xuất),
 *    recall theo từ khoá + recency (query rỗng = mới nhất trước),
 *    lọc bot/since, deleteSession, prune (quá hạn/vượt 500).
 *  - archival: insert (dedupe text trùng, giới hạn 8000 ký tự),
 *    search từ khoá + phân trang + lọc tag/source, embedding cosine
 *    qua embedQuery (mock), delete, update tags/confidence, stats.
 *  - sleepProposals: classifyFactTarget (persona/project/human),
 *    generateForBot (dedupe với block đích + proposal pending trùng),
 *    decide approve (append vào block), reject, apply-edited,
 *    decide lại -> lỗi, log quyết định.
 *  - entity: snapshot (checksum khớp), restore replace/merge,
 *    checksum sai -> lỗi, restore sai bot -> lỗi, export/import file,
 *    stats, renderContext (core prompt + recall gần nhất).
 *  - sleepConsolidation: extractFactsFromSummary, runLettaSleepPass
 *    (prune + trích fact phiên cũ + dedupe archival + propose),
 *    dry-run không ghi gì, readLettaSleepLog.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v9-letta-core-v109.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ArchivalStore,
  CoreMemoryManager,
  PersistentAgentMemory,
  RecallStore,
  SleepProposalStore,
  classifyFactTarget,
  condenseText,
  condenseWords,
  dedupeSentences,
  extractFactsFromSummary,
  jaccardSimilarity,
  lettaLimitForLabel,
  lettaRecencyScore,
  readLettaSleepLog,
  runLettaSleepPass,
  safeCosineSimilarity,
  splitSentences,
  validateLettaSnapshot,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv9-letta-core-v109-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const BOT = 'bot-a';

function longLine(word, count) {
  return Array.from({ length: count }, (_, i) => `${word} ${i}`).join(' ');
}

/* ------------------------------------------------------------------ */
/* condense                                                            */
/* ------------------------------------------------------------------ */

test('condense: splitSentences tách theo dòng và dấu kết câu, giữ thứ tự', () => {
  const sentences = splitSentences('Câu một về Hà Nội.\nCâu hai về cà phê trứng! Câu ba kể về mèo mun Mít.');
  assert.equal(sentences.length, 3);
  assert.equal(sentences[0].text, 'Câu một về Hà Nội.');
  assert.ok(sentences[0].words.has('hà'));
  assert.ok(sentences[0].words.has('nội'));
});

test('condense: condenseWords bỏ từ dừng và từ 1 ký tự', () => {
  const words = condenseWords('Tôi là một người dùng của hệ thống');
  assert.ok(!words.has('tôi'));
  assert.ok(!words.has('là'));
  assert.ok(!words.has('một'));
  assert.ok(words.has('người'));
  assert.ok(words.has('dùng'));
});

test('condense: jaccardSimilarity đo trùng lặp câu', () => {
  const a = condenseWords('người dùng thích cà phê trứng buổi sáng');
  const b = condenseWords('người dùng thích cà phê trứng buổi sáng');
  const c = condenseWords('mèo mun ngủ trên ghế sofa dài');
  assert.equal(jaccardSimilarity(a, b), 1);
  assert.ok(jaccardSimilarity(a, c) < 0.2);
});

test('condense: dedupeSentences loại câu gần trùng, giữ câu đầu', () => {
  const sentences = splitSentences(
    'Người dùng thích cà phê trứng buổi sáng.\nNgười dùng thích cà phê trứng buổi sáng.\nNgười dùng sống tại Hà Nội.',
  );
  const { kept, removed } = dedupeSentences(sentences);
  assert.equal(removed, 1);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].text, 'Người dùng thích cà phê trứng buổi sáng.');
});

test('condense: condenseText vừa giới hạn chỉ dedupe, không cắt câu', () => {
  const content = 'Thích cà phê trứng.\nThích cà phê trứng.\nSống tại Hà Nội.';
  const result = condenseText(content, 1000);
  assert.equal(result.keptSentences, 2);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.condensed, true); // dedupe làm ngắn hơn gốc
  assert.ok(!result.text.includes('Thích cà phê trứng.\nThích cà phê trứng.'));
});

test('condense: condenseText vượt giới hạn chọn câu điểm cao, giữ thứ tự gốc, không bịa chữ', () => {
  const content = [
    'Người dùng thích cà phê trứng buổi sáng.',
    'Người dùng thích cà phê trứng buổi sáng.',
    'Người dùng sống tại Hà Nội từ năm 2020.',
    'Người dùng làm việc với dự án open-bot mỗi ngày.',
    'Người dùng thích cà phê trứng buổi sáng.',
    'Người dùng nuôi một con mèo mun tên Mít.',
  ].join('\n');
  const result = condenseText(content, 90);
  assert.ok(result.condensedChars <= 90);
  assert.ok(result.keptSentences >= 1);
  // Mọi câu trong bản cô đọng đều có sẵn trong gốc (không bịa).
  for (const line of result.text.split('\n')) {
    assert.ok(content.includes(line.replace('…', '')), `câu lạ trong bản cô đọng: ${line}`);
  }
  // Thứ tự gốc được giữ.
  const idx = result.text.split('\n').map((l) => content.indexOf(l.replace('…', '')));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1]);
});

test('condense: condenseText rỗng / target <= 0 trả rỗng, không vỡ', () => {
  assert.equal(condenseText('', 100).text, '');
  assert.equal(condenseText('   ', 100).text, '');
  assert.equal(condenseText('Có nội dung.', 0).text, '');
  assert.equal(condenseText('Một câu duy nhất.', 1000).keptSentences, 1);
});

/* ------------------------------------------------------------------ */
/* coreMemory                                                          */
/* ------------------------------------------------------------------ */

test('coreMemory: giới hạn cứng theo label (persona 2KB, human 4KB, project 8KB)', () => {
  assert.equal(lettaLimitForLabel('persona'), 2048);
  assert.equal(lettaLimitForLabel('human'), 4096);
  assert.equal(lettaLimitForLabel('project'), 8192);
  assert.equal(lettaLimitForLabel('so-thich'), 2000);
});

test('coreMemory: create ép giới hạn hệ thống, attach ngay vào bot', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  const block = core.create(BOT, { label: 'persona', description: 'tính cách', content: 'Ngắn gọn.', charLimit: 99999 });
  assert.equal(block.charLimit, 2048);
  assert.equal(core.listAttached(BOT).length, 1);
  assert.equal(core.listAttached(BOT)[0].label, 'persona');
});

test('coreMemory: create nội dung vượt giới hạn -> lỗi, không tạo block', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  assert.throws(
    () => core.create(BOT, { label: 'persona', content: 'x'.repeat(2049) }),
    /vượt giới hạn 2048/,
  );
  assert.equal(core.listAll().length, 0);
});

test('coreMemory: ensureCoreBlocks tạo đủ 3 block hệ thống, gọi lại không tạo trùng', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  const first = core.ensureCoreBlocks(BOT);
  assert.deepEqual(first.map((b) => b.label), ['persona', 'human', 'project']);
  assert.deepEqual(first.map((b) => b.charLimit), [2048, 4096, 8192]);
  const second = core.ensureCoreBlocks(BOT);
  assert.equal(second.length, 3);
  assert.equal(core.listAll().length, 3);
  assert.deepEqual(second.map((b) => b.id), first.map((b) => b.id));
});

test('coreMemory: append vừa giới hạn, không cô đọng', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  core.create(BOT, { label: 'human', content: 'Sống tại Hà Nội.' });
  const result = core.append('human', 'Thích cà phê trứng.', BOT);
  assert.equal(result.condensed, false);
  assert.equal(result.condense, null);
  assert.ok(result.block.content.includes('Thích cà phê trứng.'));
  assert.equal(result.block.version, 2);
});

test('coreMemory: append vượt giới hạn TỰ CÔ ĐỌNG rồi mới append (condensed=true)', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  // Block tự do giới hạn 2000: nhồi nội dung tới sát giới hạn (<=1990)
  // để lần append sau chắc chắn vượt ngưỡng và kích hoạt cô đọng.
  const fillerLine = (i) => `Người dùng thích cà phê trứng buổi sáng ngày ${i} tại quán quen gần nhà.`;
  let filler = '';
  let fi = 0;
  while (true) {
    const next = filler === '' ? fillerLine(fi) : `${filler}\n${fillerLine(fi)}`;
    if (next.length > 1990) break;
    filler = next;
    fi += 1;
  }
  const block = core.create(BOT, { label: 'ghi-chep', content: filler });
  assert.ok(block.content.length < 2000);
  assert.ok(block.content.length > 1900);
  const result = core.append('ghi-chep', 'Người dùng vừa mua thêm một máy pha cà phê mới để pha buổi sáng mỗi ngày trước khi bắt đầu làm việc.', BOT);
  assert.equal(result.condensed, true);
  assert.ok(result.condense !== null);
  assert.ok(result.condense.condensedChars < block.content.length);
  assert.ok(result.block.content.includes('máy pha cà phê mới'));
  assert.ok(result.block.content.length <= 2000);
  assert.ok(result.usage.fillRatio <= 1);
});

test('coreMemory: append quá dài dù đã cô đọng -> lỗi kèm số ký tự còn append được', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  const filler = Array.from({ length: 30 }, (_, i) => `Người dùng thích cà phê trứng buổi sáng ngày ${i}.`).join('\n');
  core.create(BOT, { label: 'ghi-chep', content: filler });
  assert.throws(
    () => core.append('ghi-chep', 'z'.repeat(2500), BOT),
    /chỉ còn append được tối đa/,
  );
});

test('coreMemory: replace vượt giới hạn -> lỗi, nội dung cũ không đổi', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  core.create(BOT, { label: 'persona', content: 'Ngắn gọn.' });
  assert.throws(() => core.replace('persona', 'y'.repeat(2049), BOT), /vượt giới hạn 2048/);
  assert.equal(core.read('persona').content, 'Ngắn gọn.');
});

test('coreMemory: delete xoá block + detach; block không có -> lỗi', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  core.create(BOT, { label: 'tam', content: 'x' });
  assert.equal(core.delete('tam', BOT), true);
  assert.equal(core.read('tam'), null);
  assert.equal(core.listAttached(BOT).length, 0);
  assert.throws(() => core.delete('khong-co', BOT), /Không tìm thấy block/);
});

test('coreMemory: read-only chặn append/replace/delete', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  const block = core.create(BOT, { label: 'human', content: 'Sự thật.' });
  core.blockStore.setReadOnly(block.id, true, 'user');
  assert.throws(() => core.append('human', 'Thêm.', BOT), /read-only/);
  assert.throws(() => core.replace('human', 'Khác.', BOT), /read-only/);
  assert.throws(() => core.delete('human', BOT), /read-only/);
});

test('coreMemory: renderCorePrompt đúng thứ tự persona -> human -> project', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  core.create(BOT, { label: 'project', content: 'Dự án open-bot.' });
  core.create(BOT, { label: 'human', content: 'Sống tại Hà Nội.' });
  core.create(BOT, { label: 'persona', content: 'Ngắn gọn.' });
  core.create(BOT, { label: 'zeta', content: 'Block tự do.' });
  const prompt = core.renderCorePrompt(BOT);
  const order = ['<persona>', '<human>', '<project>', '<zeta>'].map((tag) => prompt.indexOf(tag));
  assert.ok(order.every((i) => i >= 0));
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3]);
  assert.ok(prompt.includes('Sống tại Hà Nội.'));
  assert.equal(core.renderCorePrompt('bot-khac'), '');
});

test('coreMemory: condense() cô đọng block về 90% giới hạn', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  const filler = Array.from({ length: 35 }, (_, i) => `Người dùng thích cà phê trứng buổi sáng ngày ${i}.`).join('\n');
  const block = core.create(BOT, { label: 'ghi-chep', content: filler });
  const { condense } = core.condense('ghi-chep', BOT);
  assert.equal(condense.condensed, true);
  assert.ok(condense.condensedChars <= Math.floor(block.charLimit * 0.9) + 1);
});

/* ------------------------------------------------------------------ */
/* recall                                                              */
/* ------------------------------------------------------------------ */

function seedSession(recall, sessionId, endedAt, texts) {
  return recall.recordSession({
    sessionId,
    botId: BOT,
    startedAt: '2026-11-10T08:00:00.000Z',
    endedAt,
    episodes: texts.map((text, i) => ({ role: i % 2 === 0 ? 'user' : 'bot', text })),
  });
}

test('recall: recordSession cắt episode, tóm tắt trích xuất từ episode', () => {
  const dir = makeTempDir();
  const recall = new RecallStore(dir);
  const session = seedSession(recall, 's1', '2026-11-14T10:00:00.000Z', [
    'Người dùng hỏi về dự án open-bot và memory v9.',
    'Bot trả lời rằng memory v9 có sleep agent và versioning.',
    'Người dùng thích cà phê trứng buổi sáng.',
  ]);
  assert.equal(session.turns, 3);
  assert.equal(session.episodes.length, 3);
  assert.ok(session.summary.length > 0);
  assert.ok(session.summary.length <= 1500);
  assert.ok(session.summary.includes('open-bot') || session.summary.includes('cà phê'));
});

test('recall: recordSession giới hạn 50 episode và cắt episode dài', () => {
  const dir = makeTempDir();
  const recall = new RecallStore(dir);
  const session = recall.recordSession({
    sessionId: 's-big',
    botId: BOT,
    episodes: Array.from({ length: 60 }, (_, i) => ({ role: 'user', text: `turn ${i} ` + 'x'.repeat(3000) })),
  });
  assert.equal(session.episodes.length, 50);
  assert.ok(session.episodes.every((ep) => ep.text.length <= 2000));
});

test('recall: recall theo từ khoá xếp điểm cao trước; query rỗng = mới nhất trước', () => {
  const dir = makeTempDir();
  const recall = new RecallStore(dir);
  seedSession(recall, 's-old', '2026-11-10T10:00:00.000Z', ['Người dùng nói về thời tiết Hà Nội hôm nay.']);
  seedSession(recall, 's-new', '2026-11-14T10:00:00.000Z', ['Người dùng hỏi về dự án open-bot và memory v9 kiểu Letta.']);
  const hits = recall.recall({ botId: BOT, query: 'open-bot memory Letta' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session.sessionId, 's-new');
  assert.ok(hits[0].keywordScore > 0);
  const recent = recall.recall({ botId: BOT, limit: 2 });
  assert.equal(recent[0].session.sessionId, 's-new');
  assert.equal(recent[1].session.sessionId, 's-old');
});

test('recall: lettaRecencyScore giảm dần theo tuổi', () => {
  const now = new Date('2026-11-15T12:00:00.000Z');
  const fresh = lettaRecencyScore('2026-11-15T11:00:00.000Z', now);
  const old = lettaRecencyScore('2026-11-10T12:00:00.000Z', now);
  assert.ok(fresh > old);
  assert.ok(fresh > 0.9);
  assert.ok(old < 0.3);
});

test('recall: lọc since/until và bot khác', () => {
  const dir = makeTempDir();
  const recall = new RecallStore(dir);
  seedSession(recall, 's1', '2026-11-10T10:00:00.000Z', ['Chuyện cũ về thời tiết.']);
  seedSession(recall, 's2', '2026-11-14T10:00:00.000Z', ['Chuyện mới về open-bot.']);
  assert.equal(recall.recall({ botId: BOT, since: '2026-11-12T00:00:00.000Z' }).length, 1);
  assert.equal(recall.recall({ botId: BOT, until: '2026-11-12T00:00:00.000Z' }).length, 1);
  assert.equal(recall.recall({ botId: 'bot-khac' }).length, 0);
});

test('recall: deleteSession và prune cắt phiên quá 90 ngày', () => {
  const dir = makeTempDir();
  const recall = new RecallStore(dir);
  seedSession(recall, 's-new', '2026-11-14T10:00:00.000Z', ['Phiên mới về open-bot.']);
  assert.equal(recall.deleteSession('s-new'), true);
  assert.equal(recall.deleteSession('s-new'), false);
  // Ghi thẳng một phiên cũ (2026-08-01) vào file JSONL — recordSession
  // tự prune nên không dùng API để seed phiên quá hạn được.
  const recallFile = path.join(dir, '.open-bot', 'memory-v9-recall.jsonl');
  const oldSession = {
    id: 'old-id', sessionId: 's-old', botId: BOT,
    startedAt: '2026-08-01T08:00:00.000Z', endedAt: '2026-08-01T10:00:00.000Z',
    turns: 1, summary: 'Phiên rất cũ về thời tiết.',
    episodes: [{ id: 'ep-0', role: 'user', text: 'Phiên rất cũ về thời tiết.', at: '2026-08-01T10:00:00.000Z' }],
  };
  fs.appendFileSync(recallFile, JSON.stringify(oldSession) + '\n');
  assert.equal(recall.readAll().length, 1);
  const pruned = recall.prune(new Date('2026-11-15T00:00:00.000Z'));
  assert.equal(pruned, 1);
  assert.equal(recall.readAll().length, 0);
});

/* ------------------------------------------------------------------ */
/* archival                                                            */
/* ------------------------------------------------------------------ */

test('archival: insert + dedupe text trùng + giới hạn 8000 ký tự', () => {
  const dir = makeTempDir();
  const store = new ArchivalStore(dir);
  const first = store.insert({ text: 'Người dùng sống tại Hà Nội.', source: 'fact', tags: ['user'], confidence: 0.9 });
  const dup = store.insert({ text: 'Người dùng sống tại Hà Nội.', source: 'fact', tags: ['user'] });
  assert.equal(dup.id, first.id);
  assert.equal(store.readAll().length, 1);
  assert.throws(() => store.insert({ text: 'x'.repeat(8001) }), /vượt giới hạn 8000/);
  assert.throws(() => store.insert({ text: '   ' }), /không được rỗng/);
});

test('archival: search từ khoá xếp hạng, lọc tag/source, phân trang', async () => {
  const dir = makeTempDir();
  const store = new ArchivalStore(dir);
  store.insert({ text: 'Người dùng sống tại Hà Nội và thích cà phê trứng.', source: 'fact', tags: ['user', 'hanoi'] });
  store.insert({ text: 'Dự án open-bot chạy memory v9 kiểu Letta.', source: 'fact', tags: ['project'] });
  store.insert({ text: 'Người dùng nuôi mèo mun tên Mít.', source: 'session', tags: ['user'] });
  const result = await store.search({ query: 'Hà Nội cà phê' });
  assert.equal(result.total, 1);
  assert.ok(result.hits[0].item.text.includes('Hà Nội'));
  const tagged = await store.search({ query: 'người dùng', tags: ['user'] });
  assert.equal(tagged.total, 2);
  const bySource = await store.search({ query: 'người dùng', source: 'session' });
  assert.equal(bySource.total, 1);
  const page = await store.search({ query: 'người dùng', limit: 1, offset: 1 });
  assert.equal(page.hits.length, 1);
  assert.equal(page.total, 2);
});

test('archival: search có embedding cộng điểm cosine (mock embed)', async () => {
  const dir = makeTempDir();
  const store = new ArchivalStore(dir);
  // Vector mock: [1,0] = chủ đề Hà Nội, [0,1] = chủ đề mèo.
  store.insert({ text: 'Người dùng sống tại Hà Nội.', source: 'fact', embedding: [1, 0] });
  store.insert({ text: 'Người dùng nuôi mèo mun.', source: 'fact', embedding: [0, 1] });
  const embedQuery = async (text) => (text.includes('Hà Nội') ? [1, 0] : [0, 1]);
  const result = await store.search({ query: 'Hà Nội' }, embedQuery);
  assert.equal(result.hits[0].item.text, 'Người dùng sống tại Hà Nội.');
  assert.ok(result.hits[0].embeddingScore !== null && result.hits[0].embeddingScore > 0.9);
});

test('archival: safeCosineSimilarity trả 0 khi vector lỗi, không throw', () => {
  assert.equal(safeCosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(safeCosineSimilarity([1, 0], [1, 0]), 1);
  assert.ok(Math.abs(safeCosineSimilarity([1, 1], [1, 1]) - 1) < 1e-9);
  assert.equal(safeCosineSimilarity([], []), 0);
  assert.equal(safeCosineSimilarity([1, 0], [1]), 0);
  assert.equal(safeCosineSimilarity([Number.NaN, 0], [1, 0]), 0);
});

test('archival: search KHÔNG trả embedding ra ngoài; accessCount tăng sau search', async () => {
  const dir = makeTempDir();
  const store = new ArchivalStore(dir);
  const item = store.insert({ text: 'Người dùng sống tại Hà Nội.', source: 'fact', embedding: [1, 0] });
  const result = await store.search({ query: 'Hà Nội' });
  assert.equal('embedding' in result.hits[0].item, false);
  assert.equal(store.get(item.id).accessCount, 1);
});

test('archival: delete + update tags/confidence + stats', () => {
  const dir = makeTempDir();
  const store = new ArchivalStore(dir);
  const item = store.insert({ text: 'Người dùng sống tại Hà Nội.', source: 'fact', tags: ['user'] });
  const updated = store.update(item.id, { tags: ['User', 'HANOI', 'user'], confidence: 0.95 });
  assert.deepEqual(updated.tags, ['user', 'hanoi']);
  assert.equal(updated.confidence, 0.95);
  const stats = store.stats();
  assert.equal(stats.items, 1);
  assert.equal(stats.bySource.fact, 1);
  assert.equal(store.delete(item.id), true);
  assert.equal(store.delete(item.id), false);
  assert.equal(store.get(item.id), null);
});

/* ------------------------------------------------------------------ */
/* sleepProposals                                                      */
/* ------------------------------------------------------------------ */

test('sleepProposals: classifyFactTarget xếp persona/project/human', () => {
  assert.equal(classifyFactTarget('Bot hãy trả lời ngắn gọn, giọng thân mật.'), 'persona');
  assert.equal(classifyFactTarget('Dự án open-bot cần triển khai tính năng memory v9.'), 'project');
  assert.equal(classifyFactTarget('Người dùng sống tại Hà Nội.'), 'human');
});

test('sleepProposals: generateForBot dedupe với block đích và proposal pending trùng', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  core.create(BOT, { label: 'human', content: 'Người dùng sống tại Hà Nội.' });
  const proposals = new SleepProposalStore(dir);
  const first = proposals.generateForBot(BOT, [
    { text: 'Người dùng sống tại Hà Nội.', source: 'session:s1', confidence: 0.9 },
    { text: 'Người dùng thích cà phê trứng buổi sáng.', source: 'session:s1', confidence: 0.8 },
    { text: 'Người dùng thích cà phê trứng buổi sáng.', source: 'session:s2', confidence: 0.8 },
  ]);
  assert.equal(first.created.length, 1);
  assert.equal(first.skippedDuplicate, 2);
  assert.equal(first.created[0].targetLabel, 'human');
  assert.equal(first.created[0].status, 'pending');
  // Gọi lại cùng fact -> không tạo proposal mới.
  const second = proposals.generateForBot(BOT, [
    { text: 'Người dùng thích cà phê trứng buổi sáng.', source: 'session:s3', confidence: 0.8 },
  ]);
  assert.equal(second.created.length, 0);
  assert.equal(second.skippedDuplicate, 1);
});

test('sleepProposals: decide approve append vào block đích; decide lại -> lỗi', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  core.create(BOT, { label: 'human', content: '' });
  const proposals = new SleepProposalStore(dir);
  const { created } = proposals.generateForBot(BOT, [
    { text: 'Người dùng thích cà phê trứng buổi sáng.', source: 'session:s1', confidence: 0.8 },
  ]);
  const decided = proposals.decide(created[0].id, 'approve', { decidedBy: 'user' });
  assert.equal(decided.proposal.status, 'applied');
  assert.equal(decided.appendedLine, 'Người dùng thích cà phê trứng buổi sáng.');
  assert.ok(core.read('human').content.includes('cà phê trứng'));
  assert.throws(() => proposals.decide(created[0].id, 'approve', { decidedBy: 'user' }), /đã được quyết định/);
  const decisions = proposals.readDecisions(10);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, 'approve');
});

test('sleepProposals: decide reject không sửa block; apply-edited append dòng đã sửa', () => {
  const dir = makeTempDir();
  const core = new CoreMemoryManager(dir);
  core.create(BOT, { label: 'human', content: '' });
  const proposals = new SleepProposalStore(dir);
  const { created } = proposals.generateForBot(BOT, [
    { text: 'Người dùng thích cà phê trứng buổi sáng.', source: 'session:s1', confidence: 0.8 },
    { text: 'Người dùng nuôi mèo mun tên Mít.', source: 'session:s1', confidence: 0.7 },
  ]);
  const rejected = proposals.decide(created[0].id, 'reject', { decidedBy: 'user', note: 'Chưa chắc chắn.' });
  assert.equal(rejected.proposal.status, 'rejected');
  assert.equal(rejected.appendedLine, null);
  const edited = proposals.decide(created[1].id, 'apply-edited', {
    decidedBy: 'user',
    editedLine: 'Người dùng nuôi mèo mun tên Mít (từ 2024).',
  });
  assert.equal(edited.proposal.status, 'applied');
  assert.ok(core.read('human').content.includes('từ 2024'));
  assert.equal(core.read('human').content.includes('cà phê trứng'), false);
});

/* ------------------------------------------------------------------ */
/* entity                                                              */
/* ------------------------------------------------------------------ */

test('entity: snapshot có checksum khớp; validateLettaSnapshot bắt checksum sai', () => {
  const dir = makeTempDir();
  const entity = new PersistentAgentMemory(dir, BOT);
  entity.core.ensureCoreBlocks(BOT);
  entity.core.append('human', 'Người dùng sống tại Hà Nội.', BOT);
  const snapshot = entity.snapshot();
  assert.equal(snapshot.format, 'open-bot-letta-entity');
  assert.equal(snapshot.botId, BOT);
  assert.equal(snapshot.coreBlocks.length, 3);
  assert.doesNotThrow(() => validateLettaSnapshot(snapshot));
  const tampered = { ...snapshot, coreBlocks: [{ ...snapshot.coreBlocks[0], content: 'ĐÃ SỬA' }] };
  assert.throws(() => validateLettaSnapshot(tampered), /Checksum snapshot không khớp/);
});

test('entity: restore replace ghi đè memory cũ; restore merge giữ cũ + thêm mới', () => {
  const dir = makeTempDir();
  const entity = new PersistentAgentMemory(dir, BOT);
  entity.core.ensureCoreBlocks(BOT);
  entity.core.append('human', 'Người dùng sống tại Hà Nội.', BOT);
  entity.recall.recordSession({
    sessionId: 's1', botId: BOT, endedAt: '2026-11-14T10:00:00.000Z',
    episodes: [{ role: 'user', text: 'Người dùng hỏi về open-bot.' }],
  });
  const snapshot = entity.snapshot();
  // Đổi memory hiện tại rồi restore replace -> về đúng snapshot.
  entity.core.replace('human', 'Nội dung khác hẳn.', BOT);
  const replaceReport = entity.restore(snapshot, 'replace');
  assert.equal(replaceReport.mode, 'replace');
  assert.ok(replaceReport.blocksRestored >= 3);
  assert.equal(entity.core.read('human').content, 'Người dùng sống tại Hà Nội.');
  // Merge: snapshot lấy từ workspace KHÁC có block mới 'ghi-chep' thì
  // thêm, block đã có thì giữ nguyên nội dung cũ.
  const dir2 = makeTempDir();
  const other = new PersistentAgentMemory(dir2, BOT);
  other.core.ensureCoreBlocks(BOT);
  other.core.append('human', 'Nội dung khác từ workspace khác.', BOT);
  other.core.create(BOT, { label: 'ghi-chep', content: 'Ghi chép riêng.' });
  const snap2 = other.snapshot();
  const mergeReport = entity.restore(snap2, 'merge');
  assert.ok(mergeReport.blocksRestored >= 1);
  assert.equal(entity.core.read('human').content, 'Người dùng sống tại Hà Nội.');
  assert.equal(entity.core.read('ghi-chep').content, 'Ghi chép riêng.');
});

test('entity: restore sai bot -> lỗi; snapshot sai format -> lỗi', () => {
  const dir = makeTempDir();
  const entity = new PersistentAgentMemory(dir, BOT);
  const snapshot = entity.snapshot();
  const otherBot = new PersistentAgentMemory(dir, 'bot-khac');
  assert.throws(() => otherBot.restore(snapshot, 'replace'), /không restore vào bot "bot-khac"/);
  assert.throws(() => validateLettaSnapshot({ format: 'khac' }), /không phải snapshot/);
});

test('entity: export/import file round-trip (merge)', () => {
  const dir = makeTempDir();
  const entity = new PersistentAgentMemory(dir, BOT);
  entity.core.ensureCoreBlocks(BOT);
  entity.core.append('human', 'Người dùng sống tại Hà Nội.', BOT);
  entity.archival.insert({ text: 'Fact archival về Hà Nội.', source: 'fact' });
  const filePath = path.join(dir, 'exports', 'bot-a.json');
  const saved = entity.exportToFile(filePath);
  assert.equal(saved, filePath);
  assert.ok(fs.existsSync(filePath));
  // Xoá memory rồi import lại.
  const entity2 = new PersistentAgentMemory(dir, BOT);
  entity2.core.blockStore.delete(entity2.core.read('human').id, 'user');
  const report = entity2.importFromFile(filePath, 'merge');
  assert.ok(report.blocksRestored >= 1);
  assert.equal(entity2.core.read('human').content, 'Người dùng sống tại Hà Nội.');
  assert.equal(entity2.archival.stats().items, 1);
});

test('entity: stats + renderContext gồm core prompt và recall gần nhất', () => {
  const dir = makeTempDir();
  const entity = new PersistentAgentMemory(dir, BOT);
  entity.core.ensureCoreBlocks(BOT);
  entity.core.append('human', 'Người dùng sống tại Hà Nội.', BOT);
  entity.recall.recordSession({
    sessionId: 's1', botId: BOT, endedAt: '2026-11-14T10:00:00.000Z',
    episodes: [{ role: 'user', text: 'Người dùng hỏi về dự án open-bot.' }],
  });
  const stats = entity.stats();
  assert.equal(stats.botId, BOT);
  assert.equal(stats.coreBlocks.length, 3);
  assert.equal(stats.recallSessions, 1);
  const context = entity.renderContext();
  assert.ok(context.includes('<human>'));
  assert.ok(context.includes('sống tại Hà Nội.'));
  assert.ok(context.includes('Recent sessions'));
});

/* ------------------------------------------------------------------ */
/* sleepConsolidation                                                  */
/* ------------------------------------------------------------------ */

test('sleepConsolidation: extractFactsFromSummary tách câu đủ dài thành fact', () => {
  const facts = extractFactsFromSummary(
    'Người dùng hỏi về dự án open-bot và memory v9.\nBot trả lời về sleep agent.\nOk.',
    'session:s1',
  );
  assert.ok(facts.length >= 2);
  assert.ok(facts.every((f) => f.text.length >= 20));
  assert.equal(facts[0].source, 'session:s1');
});

test('sleepConsolidation: runLettaSleepPass trích fact phiên cũ + propose core update + ghi log', () => {
  const dir = makeTempDir();
  const recall = new RecallStore(dir);
  recall.recordSession({
    sessionId: 's-old', botId: BOT,
    startedAt: '2026-11-01T08:00:00.000Z', endedAt: '2026-11-01T10:00:00.000Z',
    episodes: [
      { role: 'user', text: 'Người dùng nói rằng mình sống tại Hà Nội và thích cà phê trứng buổi sáng.' },
      { role: 'bot', text: 'Bot ghi nhận người dùng sống tại Hà Nội và thích cà phê trứng.' },
    ],
  });
  const entity = new PersistentAgentMemory(dir, BOT);
  entity.core.ensureCoreBlocks(BOT);
  const report = runLettaSleepPass(dir, BOT);
  assert.equal(report.botId, BOT);
  assert.equal(report.dryRun, false);
  assert.ok(report.sessionsCondensed >= 1);
  assert.ok(report.factsExtracted >= 1);
  assert.ok(report.factsStored >= 1);
  assert.ok(report.proposalsCreated >= 1);
  assert.equal(report.errors.length, 0);
  assert.ok(report.steps.every((s) => s.ok));
  const logs = readLettaSleepLog(dir, 5);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, report.id);
});

test('sleepConsolidation: dry-run không ghi gì (không log, không archival, không proposal)', () => {
  const dir = makeTempDir();
  const recall = new RecallStore(dir);
  recall.recordSession({
    sessionId: 's-old', botId: BOT,
    startedAt: '2026-11-01T08:00:00.000Z', endedAt: '2026-11-01T10:00:00.000Z',
    episodes: [{ role: 'user', text: 'Người dùng nói rằng mình sống tại Hà Nội và thích cà phê trứng.' }],
  });
  const report = runLettaSleepPass(dir, BOT, { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(new ArchivalStore(dir).stats().items, 0);
  assert.equal(new SleepProposalStore(dir).list({ botId: BOT }).length, 0);
  assert.equal(readLettaSleepLog(dir, 5).length, 0);
});

test('sleepConsolidation: dedupe archival trùng lặp trong sleep pass', () => {
  const dir = makeTempDir();
  const archival = new ArchivalStore(dir);
  archival.insert({ text: 'Người dùng sống tại Hà Nội và thích cà phê trứng.', source: 'fact' });
  archival.insert({ text: 'Người dùng sống tại Hà Nội và thích cà phê trứng buổi sáng.', source: 'fact' });
  assert.equal(archival.stats().items, 2);
  const report = runLettaSleepPass(dir, BOT, { skipProposals: true });
  assert.ok(report.archivalDuplicatesRemoved >= 1);
  assert.equal(archival.stats().items, 1);
});

test('sleepConsolidation: phiên mới (dưới 7 ngày) không bị trích fact', () => {
  const dir = makeTempDir();
  const recall = new RecallStore(dir);
  recall.recordSession({
    sessionId: 's-fresh', botId: BOT,
    startedAt: '2026-11-14T08:00:00.000Z', endedAt: '2026-11-14T10:00:00.000Z',
    episodes: [{ role: 'user', text: 'Người dùng vừa nói về dự án open-bot hôm nay.' }],
  });
  const report = runLettaSleepPass(dir, BOT, { skipProposals: true });
  assert.equal(report.sessionsCondensed, 0);
  assert.equal(report.factsExtracted, 0);
});

test('condense: longLine helper không dùng — kiểm tra import phụ không vỡ', () => {
  assert.equal(typeof longLine, 'function');
  assert.ok(longLine('test', 3).includes('test 2'));
});
