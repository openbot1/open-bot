/**
 * Tests v1.07 (Đội T3): local agent registry kiểu AGNTCY + 4 tool
 * registry (a2a_registry_register/search/list/remove).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/a2a-v107-registry.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  A2aAgentRegistry,
  buildAgentCard,
  createA2aAgentRegistry,
  generateA2aSigningKey,
  startLoopbackA2aPair,
} from '../packages/core/dist/index.js';
import { signAgentCard } from '../packages/core/dist/a2a/signing.js';
import { createA2aTools } from '../packages/tools/dist/a2aTools.js';

const CTX = { workspaceDir: os.tmpdir(), botId: 'test-bot' };
const pairsToClose = [];
const tempDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-a2a-v107-reg-'));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const pair of pairsToClose.splice(0)) {
    try {
      await pair.close();
    } catch {}
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function cardFor(name, skills, extra = {}) {
  return buildAgentCard({
    name,
    description: `${name} — a test agent for search and summarization.`,
    url: `http://127.0.0.1:9${name.length}999`,
    skills,
    ...extra,
  });
}

function execTool(tool, args) {
  return tool.execute(args, CTX);
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `thiếu tool ${name}`);
  return tool;
}

// ---------------------------------------------------------------------------
// Register + search (pure, không mạng)
// ---------------------------------------------------------------------------

test('registry: register validates the card; re-register keeps registeredAt + trusted', () => {
  const registry = createA2aAgentRegistry();
  assert.throws(
    () => registry.register({ baseUrl: 'http://127.0.0.1:9001', card: { name: 'x' } }),
    /invalid Agent Card/,
  );
  const card = cardFor('echo-bot', [{ id: 'echo', name: 'Echo', description: 'Echoes text.', tags: ['text'] }]);
  const first = registry.register({ baseUrl: 'http://127.0.0.1:9001/', card, source: 'local' });
  assert.equal(first.baseUrl, 'http://127.0.0.1:9001');
  assert.equal(first.source, 'local');
  assert.equal(first.health, 'unknown');
  assert.equal(first.signatureOk, null); // card không ký
  assert.equal(registry.size, 1);
  registry.setTrusted('http://127.0.0.1:9001', true);
  const again = registry.register({ baseUrl: 'http://127.0.0.1:9001', card });
  assert.equal(again.registeredAt, first.registeredAt);
  assert.equal(again.trusted, true); // đăng ký lại không untrust
  assert.equal(registry.deregister('http://127.0.0.1:9001/'), true);
  assert.equal(registry.deregister('http://127.0.0.1:9001'), false);
  assert.equal(registry.size, 0);
});

test('registry: signed card records signatureOk + keyId', () => {
  const registry = createA2aAgentRegistry();
  const keyPair = generateA2aSigningKey();
  const signed = signAgentCard(cardFor('signed-bot', [{ id: 'chat', name: 'Chat', description: 'Chats.' }]), keyPair);
  const entry = registry.register({ baseUrl: 'http://127.0.0.1:9002', card: signed });
  assert.equal(entry.signatureOk, true);
  assert.equal(entry.keyId, keyPair.keyId);
});

test('registry: search scores name/skill above description; filters narrow results', () => {
  const registry = createA2aAgentRegistry();
  registry.register({
    baseUrl: 'http://127.0.0.1:9101',
    card: cardFor('summarizer', [{ id: 'summarize', name: 'Summarize', description: 'Summarizes documents.', tags: ['docs'] }]),
  });
  registry.register({
    baseUrl: 'http://127.0.0.1:9102',
    card: cardFor('chatter', [{ id: 'chat', name: 'Chat', description: 'Chats about summarization topics.' }], {
      streaming: true,
    }),
  });
  registry.register({
    baseUrl: 'http://127.0.0.1:9103',
    card: cardFor('summarize-pro', [{ id: 'summarize', name: 'Summarize Pro', description: 'Fast summaries.' }]),
  });
  // 'summarize' khớp tên summarizer/summarize-pro + skill id → lên đầu.
  // 'chatter' không khớp (mô tả của nó chỉ có 'summarization', khác token).
  const bySkill = registry.search('summarize');
  assert.equal(bySkill.length, 2);
  assert.equal(bySkill[0].entry.card.name, 'summarize-pro'); // khớp tên + skill id + skill name
  assert.ok(bySkill[0].score >= bySkill[1].score);
  assert.ok(bySkill[0].matchedOn.some((m) => m.startsWith('skill') || m === 'name'));
  // Chỉ skill id chat.
  assert.deepEqual(
    registry.search('', { skillId: 'chat' }).map((r) => r.entry.card.name),
    ['chatter'],
  );
  // Lọc streaming: chỉ chatter (card thứ 2 có streaming=true qua extra).
  const streaming = registry.search('', { streaming: true });
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0].entry.card.name, 'chatter');
  // Query không khớp gì → rỗng; query rỗng = liệt kê toàn bộ.
  assert.equal(registry.search('zzz-no-such-thing').length, 0);
  assert.equal(registry.search('').length, 3);
  // listSkillIds gom đủ skill.
  assert.deepEqual(registry.listSkillIds(), ['chat', 'summarize']);
  // Trusted filter.
  registry.setTrusted('http://127.0.0.1:9101', true);
  assert.equal(registry.search('', { trusted: true }).length, 1);
  assert.equal(registry.search('', { trusted: false }).length, 2);
  assert.throws(() => registry.setTrusted('http://127.0.0.1:9999', true), /not in the registry/);
});

test('registry: TTL prune removes expired entries only; file persistence round-trips', () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'a2a-registry.json');
  const fixedNow = new Date('2026-11-14T12:00:00.000Z');
  const registry = new A2aAgentRegistry({ filePath, now: () => fixedNow });
  registry.register({
    baseUrl: 'http://127.0.0.1:9201',
    card: cardFor('short-lived', [{ id: 'echo', name: 'Echo', description: 'Echo.' }]),
    ttlMs: 1000,
  });
  registry.register({
    baseUrl: 'http://127.0.0.1:9202',
    card: cardFor('forever', [{ id: 'echo', name: 'Echo', description: 'Echo.' }]),
  });
  assert.equal(fs.existsSync(filePath), true);
  // Chưa hết hạn.
  assert.equal(registry.pruneExpired(new Date('2026-11-14T12:00:00.500Z')), 0);
  // Hết hạn entry đầu.
  assert.equal(registry.pruneExpired(new Date('2026-11-14T12:00:02.000Z')), 1);
  assert.equal(registry.size, 1);
  // Mở registry mới cùng file → đọc lại được entry còn lại.
  const reopened = new A2aAgentRegistry({ filePath });
  assert.equal(reopened.size, 1);
  assert.equal(reopened.get('http://127.0.0.1:9202').card.name, 'forever');
  // File hỏng → throw rõ ràng.
  fs.writeFileSync(filePath, '{not json', 'utf-8');
  assert.throws(() => new A2aAgentRegistry({ filePath }), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// registerFromUrl + healthCheckAll qua loopback thật
// ---------------------------------------------------------------------------

test('registry: registerFromUrl + healthCheckAll against a real loopback server', async () => {
  const pair = await startLoopbackA2aPair({ name: 'loopback-echo' });
  pairsToClose.push(pair);
  const registry = createA2aAgentRegistry();
  const entry = await registry.registerFromUrl(pair.baseUrl, { source: 'local' });
  assert.equal(entry.card.name, 'loopback-echo');
  assert.equal(entry.health, 'unknown'); // chưa health check
  const health = await registry.healthCheckAll();
  assert.deepEqual(health, { ok: 1, total: 1 });
  assert.equal(registry.get(pair.baseUrl).health, 'ok');
  assert.ok(registry.get(pair.baseUrl).lastSeenAt);
  // Agent chết → unreachable (giữ card cũ).
  await pair.close();
  pairsToClose.splice(pairsToClose.indexOf(pair), 1);
  const health2 = await registry.healthCheckAll({ timeoutMs: 1000 });
  assert.deepEqual(health2, { ok: 0, total: 1 });
  assert.equal(registry.get(pair.baseUrl).health, 'unreachable');
  // URL chết → registerFromUrl throw.
  await assert.rejects(() => registry.registerFromUrl('http://127.0.0.1:1'), /Không đọc được Agent Card/);
});

// ---------------------------------------------------------------------------
// 4 tool registry (qua createA2aTools)
// ---------------------------------------------------------------------------

test('tools: a2a_registry_register/search/list/remove end-to-end over loopback', async () => {
  const pair = await startLoopbackA2aPair({ name: 'tool-echo' });
  pairsToClose.push(pair);
  const registry = createA2aAgentRegistry();
  const tools = createA2aTools({ registry });
  const register = toolByName(tools, 'a2a_registry_register');
  const search = toolByName(tools, 'a2a_registry_search');
  const list = toolByName(tools, 'a2a_registry_list');
  const remove = toolByName(tools, 'a2a_registry_remove');

  assert.match(await execTool(list, {}), /chưa có agent nào/);
  const registered = JSON.parse(await execTool(register, { url: pair.baseUrl }));
  assert.equal(registered.registered, true);
  assert.equal(registered.name, 'tool-echo');
  assert.deepEqual(registered.skills, ['echo']);
  const found = JSON.parse(await execTool(search, { query: 'echo' }));
  assert.equal(found.length, 1);
  assert.equal(found[0].score > 0, true);
  assert.ok(found[0].matchedOn.includes('skill:echo') || found[0].matchedOn.includes('name'));
  const listed = JSON.parse(await execTool(list, {}));
  assert.equal(listed.length, 1);
  // Đăng ký lại URL sai → lỗi rõ ràng, không crash.
  assert.match(await execTool(register, { url: 'http://127.0.0.1:1' }), /^Error: /);
  // Xoá rồi tìm lại → rỗng.
  assert.match(await execTool(remove, { url: pair.baseUrl }), /Đã xoá agent/);
  assert.match(await execTool(search, { query: 'echo' }), /Không tìm thấy agent nào/);
  assert.match(await execTool(remove, { url: pair.baseUrl }), /không có trong registry/);
});
