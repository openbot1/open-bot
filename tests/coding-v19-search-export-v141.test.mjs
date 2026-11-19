/**
 * Tests cho coding agent v19 — search / export / health / usage
 * (v1.41, Đội T4, mở rộng scope).
 *
 * Chạy thật: search event log + grep workspace (kèm context, bỏ qua
 * binary), export/import conversation (verify hash-chain khi import,
 * chặn bundle path độc), diff hai checkpoint, health plugin, preset
 * usage — cả core lẫn tool thật trên tmpdir. Không gọi model/mạng.
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   npm run build --workspace=@open-bot/tools (scoped, trong worktree)
 *   node --test tests/coding-v19-search-export-v141.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createCodingV19Tools,
} from '../packages/tools/dist/index.js';
import {
  formatV19Bytes,
  formatV19Duration,
  renderV19ConversationStats,
  renderV19EventTimeline,
  renderV19PluginHealth,
  renderV19PresetUsage,
  renderV19WorkspaceSearch,
  renderV19WorkspaceStats,
  v19AppendEvent,
  v19ConversationBundleToJson,
  v19ConversationDigest,
  v19ConversationStats,
  v19CreateConversationMeta,
  v19CreateSnapshot,
  v19DiffSnapshots,
  v19EstimateTokens,
  v19EventTimeline,
  v19ExportConversation,
  v19ImportConversationBundle,
  v19ListSnapshots,
  v19LoadPlugin,
  v19OpenConversationEvents,
  v19PluginHealth,
  v19PresetUsage,
  v19PruneSnapshots,
  v19RenameConversation,
  v19ReplayEvents,
  v19SearchEvents,
  v19SearchWorkspace,
  v19WorkspaceList,
  v19WorkspaceStats,
  v19WorkspaceWrite,
} from '../packages/core/dist/index.js';

const NOW = 1794000000000;

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v19-se-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sampleLog() {
  const convId = 'conv-search-1';
  let events = [];
  events = v19AppendEvent(events, convId, { kind: 'session_start', actor: 'system', at: NOW, payload: { text: 'start' } });
  events = v19AppendEvent(events, convId, { kind: 'user_message', actor: 'user', at: NOW + 1, payload: { text: 'Fix login bug' } });
  events = v19AppendEvent(events, convId, { kind: 'tool_call', actor: 'agent', at: NOW + 2, payload: { toolName: 'coding_v19_workspace', toolArgsJson: '{}' } });
  events = v19AppendEvent(events, convId, { kind: 'file_edit', actor: 'agent', at: NOW + 3, payload: { filePath: 'src/login.ts', fileAction: 'edit', fileContent: 'fix\n' } });
  events = v19AppendEvent(events, convId, { kind: 'assistant_message', actor: 'agent', at: NOW + 4, payload: { text: 'Login bug fixed' } });
  return { convId, events };
}

test('v19 search events: lọc theo kind/text/tool/file/seq (AND)', () => {
  const { events } = sampleLog();
  assert.equal(v19SearchEvents(events, { text: 'login' }).length, 3); // user msg + assistant msg + file_edit (khớp qua filePath src/login.ts)
  assert.equal(v19SearchEvents(events, { text: 'LOGIN' }).length, 3); // không phân biệt hoa thường
  assert.equal(v19SearchEvents(events, { kind: 'user_message', text: 'login' }).length, 1);
  assert.equal(v19SearchEvents(events, { kind: 'file_edit' }).length, 1);
  assert.equal(v19SearchEvents(events, { toolName: 'coding_v19_workspace' }).length, 1);
  assert.equal(v19SearchEvents(events, { filePath: 'src/login.ts' }).length, 1);
  assert.equal(v19SearchEvents(events, { filePath: 'src/other.ts' }).length, 0);
  assert.equal(v19SearchEvents(events, { fromSeq: 3, toSeq: 4 }).length, 2);
  assert.equal(v19SearchEvents(events, { kind: 'user_message', text: 'bug' }).length, 1);
  assert.equal(v19SearchEvents(events, { kind: 'user_message', text: 'fixed' }).length, 0);
  assert.equal(v19SearchEvents(events, {}).length, 5);
  assert.equal(v19SearchEvents(events, { text: 'zzz' }).length, 0);
});

test('v19 search workspace: grep theo dòng + context, bỏ qua binary, cắt ở giới hạn', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  v19WorkspaceWrite(root, 'a.ts', 'first\nTODO: fix login\nlast\n');
  v19WorkspaceWrite(root, 'b.ts', 'nothing here\nTODO: second\n');
  v19WorkspaceWrite(root, 'c.md', 'no match\n');
  // File binary: chứa byte NUL -> bị bỏ qua.
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x54, 0x4f, 0x44, 0x4f]));
  const result = v19SearchWorkspace(root, 'TODO');
  assert.equal(result.filesSearched, 4);
  assert.equal(result.filesMatched, 2);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].relPath, 'a.ts');
  assert.equal(result.matches[0].lineNo, 2);
  assert.equal(result.matches[0].contextBefore, 'first');
  assert.equal(result.matches[0].contextAfter, 'last');
  assert.equal(result.truncated, false);
  // Case-sensitive: 'todo' thường không khớp 'TODO'.
  assert.equal(v19SearchWorkspace(root, 'todo', { caseSensitive: true }).matches.length, 0);
  assert.equal(v19SearchWorkspace(root, 'todo').matches.length, 2);
  // Giới hạn: maxResults=1 -> truncated.
  const limited = v19SearchWorkspace(root, 'TODO', { maxResults: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  assert.match(renderV19WorkspaceSearch(result), /Tìm "TODO": 2 match trong 2\/4 file/);
  assert.match(renderV19WorkspaceSearch(v19SearchWorkspace(root, 'zzz')), /không có kết quả/);
  assert.throws(() => v19SearchWorkspace(root, '  '), /không được rỗng/);
  assert.throws(() => v19SearchWorkspace(root, 'x', { maxResults: 0 }), /maxResults/);
});

test('v19 export/import: bundle round-trip, verify chain, chặn bundle độc', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  v19WorkspaceWrite(root, 'a.ts', 'hello\n');
  v19WorkspaceWrite(root, 'sub/b.ts', 'world\n');
  const meta = v19CreateConversationMeta({ title: 'Export me', profileId: 'general', now: NOW });
  let events = v19OpenConversationEvents(meta, NOW);
  events = v19AppendEvent(events, meta.id, { kind: 'user_message', actor: 'user', at: NOW + 1, payload: { text: 'hi' } });
  const bundle = v19ExportConversation(meta, events, root, NOW + 5);
  assert.equal(bundle.version, 1);
  assert.equal(bundle.workspaceFiles.length, 2);
  assert.equal(bundle.eventsJsonl.split('\n').filter(Boolean).length, 3);
  const json = v19ConversationBundleToJson(bundle);
  const imported = v19ImportConversationBundle(json);
  assert.equal(imported.meta.id, meta.id);
  assert.equal(imported.meta.title, 'Export me');
  assert.deepEqual(imported.events, events);
  assert.deepEqual(imported.workspaceFiles.map((f) => f.relPath).sort(), ['a.ts', 'sub/b.ts']);
  // Bundle giả: version sai, JSON hỏng, event bị sửa, path độc.
  assert.throws(() => v19ImportConversationBundle('nope'), /không phải JSON/);
  assert.throws(() => v19ImportConversationBundle(JSON.stringify({ ...bundle, version: 2 })), /version = 1/);
  const tampered = { ...bundle, eventsJsonl: bundle.eventsJsonl.replace('hi', 'HACKED') };
  assert.throws(() => v19ImportConversationBundle(JSON.stringify(tampered)), /hash|log vỡ|Dòng JSONL/);
  const evilPath = { ...bundle, workspaceFiles: [{ relPath: '../evil.ts', content: 'x' }] };
  assert.throws(() => v19ImportConversationBundle(JSON.stringify(evilPath)), /không an toàn/);
  const wrongConv = { ...bundle, eventsJsonl: bundle.eventsJsonl.replaceAll(meta.id, 'conv-other') };
  assert.throws(() => v19ImportConversationBundle(JSON.stringify(wrongConv)), /không thuộc conversation|không khớp|vỡ hash-chain|log vỡ/);
});

test('v19 diff snapshots: diff A -> B cùng conversation, chặn khác conversation', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  const snapDir = path.join(dir, 'snaps');
  v19WorkspaceWrite(root, 'a.ts', '1\n2\n3\n');
  const snapA = v19CreateSnapshot(root, snapDir, 'conv-d', 'A', 1, NOW);
  v19WorkspaceWrite(root, 'a.ts', '1\n2-changed\n3\n');
  v19WorkspaceWrite(root, 'b.ts', 'new\n');
  const snapB = v19CreateSnapshot(root, snapDir, 'conv-d', 'B', 2, NOW + 1);
  const entries = v19DiffSnapshots(snapDir, snapA.id, snapB.id);
  const byPath = new Map(entries.map((e) => [e.relPath, e]));
  assert.equal(byPath.get('a.ts').status, 'modified');
  assert.equal(byPath.get('a.ts').addedLines, 1);
  assert.equal(byPath.get('b.ts').status, 'added');
  assert.equal(v19DiffSnapshots(snapDir, snapB.id, snapA.id).find((e) => e.relPath === 'b.ts').status, 'deleted');
  v19WorkspaceWrite(root, 'x.ts', 'x\n');
  const other = v19CreateSnapshot(root, snapDir, 'conv-other', 'C', 1, NOW + 2);
  assert.throws(() => v19DiffSnapshots(snapDir, snapA.id, other.id), /hai conversation khác nhau/);
  assert.throws(() => v19DiffSnapshots(snapDir, snapA.id, 'ckpt-ghost'), /Không có snapshot/);
});

test('v19 plugin health + preset usage: báo lỗi manifest/config, đếm conversation theo preset', () => {
  const good = v19LoadPlugin({
    name: 'good-one',
    version: '1.0.0',
    description: 'Good.',
    category: 'search',
    servers: [{ id: 's', transport: 'stdio', command: 'node' }],
    config: { level: 3 },
    configSchema: { level: { type: 'number', required: true } },
  }, NOW);
  const badState = {
    manifest: {
      name: 'bad-one',
      version: '1.0.0',
      category: 'other',
      servers: [{ id: 's', transport: 'http', url: 'https://ok.example/mcp' }],
      config: { level: 'high' },
      configSchema: { level: { type: 'number', required: true } },
    },
    loaded: true,
    enabledServers: ['s'],
    appliedConfig: { level: 'high' },
    configVersion: 1,
  };
  const health = v19PluginHealth([good, badState]);
  assert.equal(health.length, 2);
  assert.equal(health[0].name, 'bad-one'); // sort theo tên
  // bad-one: config {level:'high'} không khớp schema number — manifest
  // validate có kèm check config nên cả manifestOk lẫn configOk đều false.
  assert.equal(health[0].manifestOk, false);
  assert.match(health[0].manifestErrors.join(' '), /level.*phải là number/);
  assert.equal(health[0].configOk, false);
  assert.match(health[0].configErrors.join(' '), /level.*phải là number/);
  assert.equal(health[1].name, 'good-one');
  assert.equal(health[1].manifestOk, true);
  assert.equal(health[1].configOk, true);
  assert.match(renderV19PluginHealth(health), /bad-one: LỖI/);
  assert.match(renderV19PluginHealth(health), /good-one: OK/);
  assert.equal(renderV19PluginHealth([]), '(chưa cài plugin nào)');

  const metas = [
    v19CreateConversationMeta({ title: 'A', profileId: 'general', now: NOW }),
    v19CreateConversationMeta({ title: 'B', profileId: 'general', now: NOW + 1 }),
    v19CreateConversationMeta({ title: 'C', profileId: 'reviewer', now: NOW + 2 }),
    v19CreateConversationMeta({ title: 'D', now: NOW + 3 }),
  ];
  const usage = v19PresetUsage(metas);
  assert.equal(usage[0].presetId, 'general');
  assert.equal(usage[0].conversations, 2);
  assert.equal(usage.find((u) => u.presetId === '(không có preset)').conversations, 1);
  assert.match(renderV19PresetUsage(usage), /general: 2 conversation/);
  assert.equal(renderV19PresetUsage([]), '(chưa có conversation nào)');
});

test('v19 tools: search/export/import + diff-snapshots + health + usage thật', async (t) => {
  const base = tmpdir(t);
  const ctx = { workspaceDir: base };
  const tools = createCodingV19Tools(() => base);
  const byName = (name) => tools.find((x) => x.definition.name === name);
  const conversation = byName('coding_v19_conversation');
  const eventsTool = byName('coding_v19_events');
  const workspace = byName('coding_v19_workspace');
  const checkpoint = byName('coding_v19_checkpoint');
  const plugins = byName('coding_v19_plugins');
  const presets = byName('coding_v19_presets');

  const created = await conversation.execute({ action: 'create', title: 'Search me', profileId: 'general' }, ctx);
  const id = created.match(/\[(conv-[^\]]+)\]/)[1];
  await workspace.execute({ action: 'write', conversationId: id, filePath: 'app.ts', content: 'const x = 1;\n// TODO: login\n' }, ctx);
  await eventsTool.execute({ action: 'append', conversationId: id, kind: 'user_message', payloadJson: JSON.stringify({ text: 'fix login now' }) }, ctx);
  const found = await eventsTool.execute({ action: 'search', conversationId: id, query: 'login' }, ctx);
  assert.match(found, /fix login now/);
  const none = await eventsTool.execute({ action: 'search', conversationId: id, query: 'zzz' }, ctx);
  assert.match(none, /không có event nào khớp/);
  const grep = await workspace.execute({ action: 'search', conversationId: id, query: 'TODO' }, ctx);
  assert.match(grep, /app\.ts:2: \/\/ TODO: login/);
  const exported = await eventsTool.execute({ action: 'export', conversationId: id }, ctx);
  assert.match(exported, /"version": 1/);
  assert.match(exported, /Search me/);
  // Import sang base khác (id mới chưa tồn tại ở base2).
  const base2 = tmpdir(t);
  const ctx2 = { workspaceDir: base2 };
  const tools2 = createCodingV19Tools(() => base2);
  const events2 = tools2.find((x) => x.definition.name === 'coding_v19_events');
  const imported = await events2.execute({ action: 'import', bundleJson: exported }, ctx2);
  assert.match(imported, /Đã import conversation/);
  const dupImport = await events2.execute({ action: 'import', bundleJson: exported }, ctx2);
  assert.match(dupImport, /^Error: Đã có conversation/);
  const importedWs = tools2.find((x) => x.definition.name === 'coding_v19_workspace');
  assert.equal(await importedWs.execute({ action: 'read', conversationId: id, filePath: 'app.ts' }, ctx2), 'const x = 1;\n// TODO: login\n');

  // Diff hai checkpoint.
  const ck1 = await checkpoint.execute({ action: 'create', conversationId: id, label: 'one' }, ctx);
  const ck1Id = ck1.match(/(ckpt-[^\s,)]+)/)[1];
  await workspace.execute({ action: 'write', conversationId: id, filePath: 'app.ts', content: 'const x = 2;\n// TODO: login\n' }, ctx);
  const ck2 = await checkpoint.execute({ action: 'create', conversationId: id, label: 'two' }, ctx);
  const ck2Id = ck2.match(/(ckpt-[^\s,)]+)/)[1];
  const snapDiff = await checkpoint.execute({ action: 'diff-snapshots', conversationId: id, checkpointId: ck1Id, otherCheckpointId: ck2Id }, ctx);
  assert.match(snapDiff, /~ app\.ts \(\+1\/-1 dòng\)/);

  // Health + usage.
  await plugins.execute({
    action: 'load',
    manifestJson: JSON.stringify({
      name: 'health-one', version: '1.0.0', description: 'H.', category: 'search',
      servers: [{ id: 's', transport: 'stdio', command: 'node' }],
    }),
  }, ctx);
  const health = await plugins.execute({ action: 'health' }, ctx);
  assert.match(health, /health-one: OK/);
  const usage = await presets.execute({ action: 'usage' }, ctx);
  assert.match(usage, /general: 1 conversation/);
});

test('v19 stats: conversation/workspace/timeline/digest từ log thật', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  v19WorkspaceWrite(root, 'a.ts', 'line1\nline2\nline3\n');
  v19WorkspaceWrite(root, 'b.md', '# doc\ntext\n');
  const meta = v19CreateConversationMeta({ title: 'Stats me', profileId: 'general', now: NOW });
  let events = v19OpenConversationEvents(meta, NOW);
  events = v19AppendEvent(events, meta.id, { kind: 'user_message', actor: 'user', at: NOW + 1000, payload: { text: 'hello world' } });
  events = v19AppendEvent(events, meta.id, { kind: 'tool_call', actor: 'agent', at: NOW + 2000, payload: { toolName: 'coding_v19_workspace', toolArgsJson: '{}' } });
  events = v19AppendEvent(events, meta.id, { kind: 'tool_result', actor: 'tool:coding_v19_workspace', at: NOW + 3000, payload: { toolName: 'coding_v19_workspace', result: 'ok', ok: true } });
  events = v19AppendEvent(events, meta.id, { kind: 'tool_call', actor: 'agent', at: NOW + 4000, payload: { toolName: 'coding_v19_agent', toolArgsJson: '{}' } });
  events = v19AppendEvent(events, meta.id, { kind: 'tool_result', actor: 'tool:coding_v19_agent', at: NOW + 5000, payload: { toolName: 'coding_v19_agent', result: 'blocked', ok: false } });
  events = v19AppendEvent(events, meta.id, { kind: 'file_edit', actor: 'agent', at: NOW + 6000, payload: { filePath: 'a.ts', fileAction: 'edit', fileContent: 'x\n' } });
  const state = v19ReplayEvents(meta.id, events);
  const stats = v19ConversationStats(state, events);
  assert.equal(stats.events, 8);
  assert.equal(stats.messages, 1);
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.toolCalls, 2);
  assert.equal(stats.toolCallsOk, 1);
  assert.equal(stats.toolCallsFailed, 1);
  assert.equal(stats.toolSuccessRate, 50);
  assert.equal(stats.filesChanged, 1);
  assert.equal(stats.durationMs, 6000);
  assert.equal(stats.estimatedTokens, v19EstimateTokens('hello world') + v19EstimateTokens('{}') + v19EstimateTokens('ok') + v19EstimateTokens('{}') + v19EstimateTokens('blocked'));
  assert.equal(stats.perTool.length, 2);
  assert.equal(stats.perTool[0].toolName, 'coding_v19_agent'); // sort theo tên khi cùng số lần gọi
  assert.equal(stats.eventsByKind.user_message, 1);
  const wsStats = v19WorkspaceStats(v19WorkspaceList(root));
  assert.equal(wsStats.files, 2);
  assert.equal(wsStats.totalLines, 5);
  assert.equal(wsStats.byExtension['.ts'], 1);
  assert.equal(wsStats.byExtension['.md'], 1);
  assert.equal(wsStats.largestFiles[0].relPath, 'a.ts');
  const buckets = v19EventTimeline(events, 60 * 1000);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].count, 8);
  assert.throws(() => v19EventTimeline(events, 10), /bucketMs/);
  const digest = v19ConversationDigest(meta.title, meta.profileId, stats, wsStats, state);
  assert.match(digest, /# Stats me/);
  assert.match(digest, /Tool call: 2 \(thành công 1, thất bại 1, tỉ lệ 50%\)/);
  assert.match(digest, /a\.ts \(edit, seq 8\)/);
  assert.match(digest, /\[user\] hello world/);
  assert.equal(v19EstimateTokens(''), 0);
  assert.equal(v19EstimateTokens('abcd'), 1);
  assert.equal(v19EstimateTokens('abcde'), 2);
  assert.equal(formatV19Duration(450), '450ms');
  assert.equal(formatV19Duration(65000), '1m 5s');
  assert.equal(formatV19Duration(3600000), '1h');
  assert.equal(formatV19Bytes(500), '500 B');
  assert.equal(formatV19Bytes(2048), '2.0 KiB');
  assert.match(renderV19ConversationStats(stats), /2 tool call/);
  assert.match(renderV19WorkspaceStats(wsStats), /2 file/);
  assert.match(renderV19EventTimeline(buckets), /8 event/);
  assert.equal(renderV19EventTimeline([]), '(chưa có event nào)');
});

test('v19 rename + prune snapshot: đổi tên, chỉ giữ N snapshot mới nhất', (t) => {
  const dir = tmpdir(t);
  const root = path.join(dir, 'ws');
  const snapDir = path.join(dir, 'snaps');
  const meta = v19CreateConversationMeta({ title: 'Old name', now: NOW });
  const renamed = v19RenameConversation(meta, '  New name  ', NOW + 1);
  assert.equal(renamed.title, 'New name');
  assert.equal(renamed.id, meta.id);
  assert.equal(renamed.updatedAt, NOW + 1);
  assert.throws(() => v19RenameConversation(meta, '   '), /không được rỗng/);
  assert.throws(() => v19RenameConversation(meta, 'x'.repeat(201)), /tối đa 200 ký tự/);
  v19WorkspaceWrite(root, 'a.ts', 'v1\n');
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    v19WorkspaceWrite(root, 'a.ts', `v${i}\n`);
    ids.push(v19CreateSnapshot(root, snapDir, meta.id, `s${i}`, i + 1, NOW + i).id);
  }
  assert.equal(v19ListSnapshots(snapDir, meta.id).length, 4);
  const deleted = v19PruneSnapshots(snapDir, meta.id, 2);
  assert.equal(deleted.length, 2);
  assert.equal(v19ListSnapshots(snapDir, meta.id).length, 2);
  assert.equal(v19PruneSnapshots(snapDir, meta.id, 2).length, 0);
  assert.throws(() => v19PruneSnapshots(snapDir, meta.id, 0), /keep phải là số nguyên/);
});

test('v19 tools: conversation stats/digest/rename + checkpoint prune thật', async (t) => {
  const base = tmpdir(t);
  const ctx = { workspaceDir: base };
  const tools = createCodingV19Tools(() => base);
  const byName = (name) => tools.find((x) => x.definition.name === name);
  const conversation = byName('coding_v19_conversation');
  const workspace = byName('coding_v19_workspace');
  const checkpoint = byName('coding_v19_checkpoint');
  const created = await conversation.execute({ action: 'create', title: 'Stats tool', profileId: 'general' }, ctx);
  const id = created.match(/\[(conv-[^\]]+)\]/)[1];
  await workspace.execute({ action: 'write', conversationId: id, filePath: 'x.ts', content: 'a\nb\n' }, ctx);
  const stats = await conversation.execute({ action: 'stats', conversationId: id }, ctx);
  assert.match(stats, /1 file/);
  assert.match(stats, /Workspace: 1 file/);
  assert.match(stats, /Timeline:/);
  const digest = await conversation.execute({ action: 'digest', conversationId: id }, ctx);
  assert.match(digest, /# Stats tool/);
  assert.match(digest, /x\.ts/);
  const renamed = await conversation.execute({ action: 'rename', conversationId: id, title: 'Renamed tool' }, ctx);
  assert.match(renamed, /Đã đổi tên conversation/);
  const after = await conversation.execute({ action: 'get', conversationId: id }, ctx);
  assert.match(after, /Renamed tool/);
  const badRename = await conversation.execute({ action: 'rename', conversationId: id, title: '   ' }, ctx);
  assert.match(badRename, /^Error:/);
  await checkpoint.execute({ action: 'create', conversationId: id, label: 'one' }, ctx);
  await checkpoint.execute({ action: 'create', conversationId: id, label: 'two' }, ctx);
  await checkpoint.execute({ action: 'create', conversationId: id, label: 'three' }, ctx);
  const pruned = await checkpoint.execute({ action: 'prune', conversationId: id, keep: 1 }, ctx);
  assert.match(pruned, /Đã prune 2 snapshot cũ/);
  const listed = await checkpoint.execute({ action: 'list', conversationId: id }, ctx);
  assert.match(listed, /three/);
  assert.doesNotMatch(listed, /one/);
});
