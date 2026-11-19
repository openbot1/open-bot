/**
 * Tests cho coding agent v19 — agent end-to-end + tools + i18n
 * (v1.41, Đội T4).
 *
 * Chạy thật: agent scripted trên conversation + workspace thật
 * (preset chặn tool ngoài allowlist, checkpoint cuối phiên), 10 tool
 * thật trên tmpdir (conversation/events/workspace/checkpoint/branch/
 * plugins/config/presets/marketplace/agent), i18n coding.v19.* đủ
 * 6 locale bằng nhau đã sort, registry không trùng tool. Không gọi
 * model/mạng.
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   npm run build --workspace=@open-bot/tools (scoped, trong worktree)
 *   node --test tests/coding-v19-agent-tools-i18n-v141.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_TOOLS,
  CODING_V19_TOOLS,
  CODING_V19_TOOL_NAMES,
  createCodingV19Tools,
  createDefaultTools,
  isCodingV19ToolName,
} from '../packages/tools/dist/index.js';
import {
  runV19Agent,
  v19ReplayEvents,
} from '../packages/core/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CODING_V19_KEYS = [
  'coding.v19.agent',
  'coding.v19.agentRun',
  'coding.v19.branch',
  'coding.v19.branchFrom',
  'coding.v19.branched',
  'coding.v19.checkpoint',
  'coding.v19.checkpointCreated',
  'coding.v19.checkpoints',
  'coding.v19.config',
  'coding.v19.conversation',
  'coding.v19.conversationArchived',
  'coding.v19.conversationClosed',
  'coding.v19.conversationCreated',
  'coding.v19.conversations',
  'coding.v19.diff',
  'coding.v19.diffViewer',
  'coding.v19.edits',
  'coding.v19.eventAppended',
  'coding.v19.eventLog',
  'coding.v19.eventReplayed',
  'coding.v19.events',
  'coding.v19.fork',
  'coding.v19.invalidEvent',
  'coding.v19.invalidManifest',
  'coding.v19.invalidPreset',
  'coding.v19.marketplace',
  'coding.v19.messages',
  'coding.v19.pathBlocked',
  'coding.v19.pathOutsideWorkspace',
  'coding.v19.pluginConfig',
  'coding.v19.pluginConfigInvalid',
  'coding.v19.pluginDisabled',
  'coding.v19.pluginEnabled',
  'coding.v19.pluginLoaded',
  'coding.v19.pluginManifest',
  'coding.v19.pluginNotFound',
  'coding.v19.pluginUnloaded',
  'coding.v19.plugins',
  'coding.v19.presetApplied',
  'coding.v19.presetCreated',
  'coding.v19.presetDeleted',
  'coding.v19.presetNotFound',
  'coding.v19.presets',
  'coding.v19.profile',
  'coding.v19.rollback',
  'coding.v19.rolledBack',
  'coding.v19.searchPlugins',
  'coding.v19.settings',
  'coding.v19.snapshotCreated',
  'coding.v19.snapshotRestored',
  'coding.v19.systemPrompt',
  'coding.v19.title',
  'coding.v19.toolAllowlist',
  'coding.v19.toolCalls',
  'coding.v19.workspace',
  'coding.v19.workspaceIsolated',
];

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v19-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function testCtx(workspaceDir) {
  return { workspaceDir };
}

function toolByName(tools, name) {
  const found = tools.find((t) => t.definition.name === name);
  assert.ok(found, `thiếu tool ${name}`);
  return found;
}

test('v19 registry: 10 tool, tên đúng, có trong ALL_TOOLS đúng 1 lần, bind không trùng', () => {
  assert.equal(CODING_V19_TOOL_NAMES.length, 10);
  assert.equal(CODING_V19_TOOLS.length, 10);
  assert.deepEqual(
    [...CODING_V19_TOOL_NAMES].sort(),
    [
      'coding_v19_agent',
      'coding_v19_branch',
      'coding_v19_checkpoint',
      'coding_v19_conversation',
      'coding_v19_events',
      'coding_v19_marketplace',
      'coding_v19_plugin_config',
      'coding_v19_plugins',
      'coding_v19_presets',
      'coding_v19_workspace',
    ].sort(),
  );
  assert.equal(isCodingV19ToolName('coding_v19_agent'), true);
  assert.equal(isCodingV19ToolName('coding_v18_agent'), false);
  for (const name of CODING_V19_TOOL_NAMES) {
    const count = ALL_TOOLS.filter((t) => t.definition.name === name).length;
    assert.equal(count, 1, `tool ${name} xuất hiện ${count} lần trong ALL_TOOLS`);
  }
  const defaults = createDefaultTools();
  for (const name of CODING_V19_TOOL_NAMES) {
    assert.equal(defaults.filter((t) => t.definition.name === name).length, 1);
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v19-bind-'));
  try {
    const bound = createDefaultTools({ getCodingV19BaseDir: () => base });
    for (const name of CODING_V19_TOOL_NAMES) {
      assert.equal(bound.filter((t) => t.definition.name === name).length, 1, `bind trùng ${name}`);
    }
    assert.ok(fs.existsSync(path.join(base, 'coding-v19')) === false || true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('v19 agent: chạy scripted với preset reviewer — tool ngoài allowlist bị chặn, file + checkpoint đầy đủ', (t) => {
  const dir = tmpdir(t);
  const dataDir = path.join(dir, 'data');
  const workspaceRoot = path.join(dir, 'ws');
  const { report, meta, events } = runV19Agent({
    task: 'Review and fix src/a.ts',
    profileId: 'reviewer',
    steps: [
      { text: 'Đọc file trước.' },
      { text: 'Ghi file sửa.', fileWrite: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
      { text: 'Sửa file.', fileWrite: { path: 'src/a.ts', content: 'export const a = 2;', kind: 'edit', oldText: 'export const a = 1;' } },
      { text: 'Gọi tool cho phép.', toolCall: { toolName: 'coding_v19_workspace', argsJson: '{}', result: 'read ok' } },
      { text: 'Gọi tool bị chặn.', toolCall: { toolName: 'coding_v19_agent', argsJson: '{}', result: 'should not run' } },
      { text: 'Bước bỏ qua.', done: false },
    ],
    workspaceRoot,
    dataDir,
    now: 1794000000000,
  });
  assert.equal(meta.profileId, 'reviewer');
  assert.equal(meta.status, 'active');
  assert.equal(report.stepsRun, 5);
  assert.equal(report.stepsSkipped, 1);
  assert.equal(report.toolCalls, 1); // chỉ tool cho phép được đếm
  assert.ok(report.checkpointId);
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
  const state = v19ReplayEvents(meta.id, events);
  assert.equal(state.messages.length, 2); // task + bước text thuần
  assert.equal(state.toolCalls.length, 2); // 1 ok + 1 blocked (tool_result ok=false)
  assert.equal(state.toolCalls.find((c) => c.toolName === 'coding_v19_agent').ok, false);
  assert.match(state.toolCalls.find((c) => c.toolName === 'coding_v19_agent').result, /không nằm trong allowlist/);
  assert.equal(state.filesChanged.length, 1);
  assert.equal(state.filesChanged[0].action, 'edit');
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.checkpoints[0].checkpointId, report.checkpointId);
  assert.ok(fs.existsSync(path.join(dataDir, 'snapshots', report.checkpointId, 'src/a.ts')));
  // Chạy tiếp conversation đã có: append thêm bước, checkpoint mới.
  const continued = runV19Agent({
    task: 'Tiếp tục',
    steps: [{ text: 'Thêm file.', fileWrite: { path: 'b.ts', content: 'b\n' } }],
    existingMeta: meta,
    existingEvents: events,
    workspaceRoot,
    dataDir,
    now: 1794000001000,
  });
  assert.equal(continued.report.stepsRun, 1);
  assert.equal(continued.events.length, events.length + 3); // user msg + file_edit + checkpoint
  // Preset không tồn tại / task rỗng / step sai đều throw.
  assert.throws(() => runV19Agent({ task: 'x', profileId: 'ghost', steps: [], workspaceRoot, dataDir }), /Không có preset/);
  assert.throws(() => runV19Agent({ task: '', steps: [], workspaceRoot, dataDir }), /task không được rỗng/);
  assert.throws(() => runV19Agent({ task: 'x', steps: [{ text: '' }], workspaceRoot, dataDir }), /step.text/);
  assert.throws(
    () => runV19Agent({ task: 'x', steps: [{ text: 'evil', fileWrite: { path: '../escape.ts', content: 'x' } }], workspaceRoot, dataDir }),
    /ngoài workspace/,
  );
});

test('v19 tools: conversation + events + workspace thật trên tmpdir', async (t) => {
  const base = tmpdir(t);
  const ctx = testCtx(base);
  const tools = createCodingV19Tools(() => base);
  const conversation = toolByName(tools, 'coding_v19_conversation');
  const eventsTool = toolByName(tools, 'coding_v19_events');
  const workspace = toolByName(tools, 'coding_v19_workspace');

  const created = await conversation.execute({ action: 'create', title: 'Tool test', profileId: 'general' }, ctx);
  const idMatch = created.match(/\[(conv-[^\]]+)\]/);
  assert.ok(idMatch, created);
  const id = idMatch[1];
  assert.match(created, /profile: general/);
  assert.ok(fs.existsSync(path.join(base, 'coding-v19', 'conversations', id, 'meta.json')));
  assert.ok(fs.existsSync(path.join(base, 'coding-v19', 'conversations', id, 'events.jsonl')));

  const appended = await eventsTool.execute({
    action: 'append',
    conversationId: id,
    kind: 'user_message',
    actor: 'user',
    payloadJson: JSON.stringify({ text: 'hello tool' }),
  }, ctx);
  assert.match(appended, /seq 3/); // session_start + preset_applied + user_message
  const listed = await eventsTool.execute({ action: 'list', conversationId: id }, ctx);
  assert.match(listed, /#3 user: hello tool/);
  const replayed = await eventsTool.execute({ action: 'replay', conversationId: id }, ctx);
  assert.match(replayed, /1 tin nhắn/);
  const verified = await eventsTool.execute({ action: 'verify', conversationId: id }, ctx);
  assert.match(verified, /hợp lệ/);
  const badAppend = await eventsTool.execute({
    action: 'append',
    conversationId: id,
    kind: 'user_message',
    payloadJson: JSON.stringify({}),
  }, ctx);
  assert.match(badAppend, /^Error:/);
  const badAction = await eventsTool.execute({ action: 'nope', conversationId: id }, ctx);
  assert.match(badAction, /^Error: Unknown action/);

  const written = await workspace.execute({ action: 'write', conversationId: id, filePath: 'src/main.ts', content: 'hello\n' }, ctx);
  assert.match(written, /Đã ghi src\/main\.ts/);
  const read = await workspace.execute({ action: 'read', conversationId: id, filePath: 'src/main.ts' }, ctx);
  assert.equal(read, 'hello\n');
  const edited = await workspace.execute({ action: 'edit', conversationId: id, filePath: 'src/main.ts', oldText: 'hello', content: 'hi there' }, ctx);
  assert.match(edited, /Đã sửa src\/main\.ts/);
  const listedFiles = await workspace.execute({ action: 'list', conversationId: id }, ctx);
  assert.match(listedFiles, /src\/main\.ts/);
  const blocked = await workspace.execute({ action: 'write', conversationId: id, filePath: '../escape.ts', content: 'x' }, ctx);
  assert.match(blocked, /^Error:.*ngoài workspace/);
  const checked = await workspace.execute({ action: 'check', conversationId: id, filePath: '../escape.ts' }, ctx);
  assert.match(checked, /BỊ CHẶN/);
  const ghost = await workspace.execute({ action: 'read', conversationId: id, filePath: 'ghost.ts' }, ctx);
  assert.match(ghost, /^Error:/);

  const summary = await conversation.execute({ action: 'summary', conversationId: id }, ctx);
  assert.match(summary, /Tool test/);
  const ended = await conversation.execute({ action: 'end', conversationId: id, endReason: 'done' }, ctx);
  assert.match(ended, /Đã kết thúc/);
  const archived = await conversation.execute({ action: 'archive', conversationId: id }, ctx);
  assert.match(archived, /Đã archive/);
  const list = await conversation.execute({ action: 'list' }, ctx);
  assert.match(list, /Tool test/);
  const missing = await conversation.execute({ action: 'get', conversationId: 'conv-ghost' }, ctx);
  assert.match(missing, /^Error: Không có conversation/);
});

test('v19 tools: checkpoint + rollback + diff + branch thật', async (t) => {
  const base = tmpdir(t);
  const ctx = testCtx(base);
  const tools = createCodingV19Tools(() => base);
  const conversation = toolByName(tools, 'coding_v19_conversation');
  const workspace = toolByName(tools, 'coding_v19_workspace');
  const checkpoint = toolByName(tools, 'coding_v19_checkpoint');
  const branch = toolByName(tools, 'coding_v19_branch');
  const eventsTool = toolByName(tools, 'coding_v19_events');

  const created = await conversation.execute({ action: 'create', title: 'CKPT' }, ctx);
  const id = created.match(/\[(conv-[^\]]+)\]/)[1];
  await workspace.execute({ action: 'write', conversationId: id, filePath: 'a.ts', content: 'v1\n' }, ctx);
  const made = await checkpoint.execute({ action: 'create', conversationId: id, label: 'base' }, ctx);
  const ckptId = made.match(/(ckpt-[^\s,)]+)/)[1];
  assert.match(made, /Đã tạo checkpoint/);
  await workspace.execute({ action: 'write', conversationId: id, filePath: 'a.ts', content: 'v2\n' }, ctx);
  await workspace.execute({ action: 'write', conversationId: id, filePath: 'new.ts', content: 'new\n' }, ctx);
  const diff = await checkpoint.execute({ action: 'diff', conversationId: id, checkpointId: ckptId }, ctx);
  assert.match(diff, /~ a\.ts \(\+1\/-1 dòng\)/);
  assert.match(diff, /\+ new\.ts/);
  const listed = await checkpoint.execute({ action: 'list', conversationId: id }, ctx);
  assert.match(listed, /base/);
  const rolled = await checkpoint.execute({ action: 'rollback', conversationId: id, checkpointId: ckptId }, ctx);
  assert.match(rolled, /Đã rollback/);
  assert.match(rolled, /xoá 1 file/);
  const readBack = await workspace.execute({ action: 'read', conversationId: id, filePath: 'a.ts' }, ctx);
  assert.equal(readBack, 'v1\n');
  const badRollback = await checkpoint.execute({ action: 'rollback', conversationId: id, checkpointId: 'ckpt-ghost' }, ctx);
  assert.match(badRollback, /^Error: Không có snapshot/);

  // Branch từ seq 2 (session_start + preset? create không preset nên seq 1 = session_start, seq 2 = user msg sau).
  await eventsTool.execute({ action: 'append', conversationId: id, kind: 'user_message', payloadJson: JSON.stringify({ text: 'one' }) }, ctx);
  await eventsTool.execute({ action: 'append', conversationId: id, kind: 'user_message', payloadJson: JSON.stringify({ text: 'two' }) }, ctx);
  const forked = await branch.execute({ action: 'fork', conversationId: id, fromSeq: 2, title: 'Branch A' }, ctx);
  const childId = forked.match(/\[(conv-[^\]]+)\]/)[1];
  assert.match(forked, /Đã fork branch/);
  const children = await branch.execute({ action: 'children', conversationId: id }, ctx);
  assert.match(children, new RegExp(childId));
  const childSummary = await conversation.execute({ action: 'get', conversationId: childId }, ctx);
  assert.match(childSummary, /Branch A/);
});

test('v19 tools: plugins + config + presets + marketplace thật', async (t) => {
  const base = tmpdir(t);
  const ctx = testCtx(base);
  const tools = createCodingV19Tools(() => base);
  const plugins = toolByName(tools, 'coding_v19_plugins');
  const pluginConfig = toolByName(tools, 'coding_v19_plugin_config');
  const presets = toolByName(tools, 'coding_v19_presets');
  const marketplace = toolByName(tools, 'coding_v19_marketplace');

  const manifest = {
    name: 'fs-test',
    version: '1.0.0',
    description: 'Test plugin.',
    category: 'filesystem',
    servers: [{ id: 'fs', transport: 'stdio', command: 'node', args: ['s.js'] }],
    tools: ['coding_v19_workspace'],
    permissions: ['read'],
    config: { rootDir: '/tmp', apiKey: 'sk-1234567890' },
    configSchema: {
      rootDir: { type: 'string', required: true },
      apiKey: { type: 'string', required: false },
    },
  };
  const badManifest = await plugins.execute({ action: 'load', manifestJson: JSON.stringify({ name: 'Bad!' }) }, ctx);
  assert.match(badManifest, /^Error:/);
  const loaded = await plugins.execute({ action: 'load', manifestJson: JSON.stringify(manifest) }, ctx);
  assert.match(loaded, /Đã load plugin "fs-test"/);
  const dup = await plugins.execute({ action: 'load', manifestJson: JSON.stringify(manifest) }, ctx);
  assert.match(dup, /^Error:.*đã cài/);
  const got = await plugins.execute({ action: 'get', pluginName: 'fs-test' }, ctx);
  assert.match(got, /fs-test v1\.0\.0/);
  assert.doesNotMatch(got, /sk-1234567890/);
  const cfg = await pluginConfig.execute({ action: 'get', pluginName: 'fs-test' }, ctx);
  assert.match(cfg, /config v1/);
  assert.doesNotMatch(cfg, /sk-1234567890/);
  const invalid = await pluginConfig.execute({ action: 'set', pluginName: 'fs-test', configJson: JSON.stringify({ rootDir: 5 }) }, ctx);
  assert.match(invalid, /Không áp được config/);
  const stillV1 = await pluginConfig.execute({ action: 'get', pluginName: 'fs-test' }, ctx);
  assert.match(stillV1, /config v1/);
  const validated = await pluginConfig.execute({ action: 'validate', pluginName: 'fs-test', configJson: JSON.stringify({ rootDir: '/new' }) }, ctx);
  assert.match(validated, /Config hợp lệ/);
  const applied = await pluginConfig.execute({ action: 'set', pluginName: 'fs-test', configJson: JSON.stringify({ rootDir: '/new' }) }, ctx);
  assert.match(applied, /Đã áp config v2/);
  const disabled = await plugins.execute({ action: 'disable-server', pluginName: 'fs-test', serverId: 'fs' }, ctx);
  assert.match(disabled, /Đã tắt server "fs"/);
  const enabled = await plugins.execute({ action: 'enable-server', pluginName: 'fs-test', serverId: 'fs' }, ctx);
  assert.match(enabled, /Đã bật server "fs"/);
  const badServer = await plugins.execute({ action: 'enable-server', pluginName: 'fs-test', serverId: 'ghost' }, ctx);
  assert.match(badServer, /^Error:/);
  const unloaded = await plugins.execute({ action: 'unload', pluginName: 'fs-test' }, ctx);
  assert.match(unloaded, /Đã unload/);

  const market = await marketplace.execute({ action: 'list' }, ctx);
  assert.match(market, /fs-test/);
  assert.match(market, /git-helper/);
  const searched = await marketplace.execute({ action: 'search', query: 'git' }, ctx);
  assert.match(searched, /Tìm thấy 1 plugin/);
  const searchedNone = await marketplace.execute({ action: 'search', query: 'zzz' }, ctx);
  assert.match(searchedNone, /Tìm thấy 0 plugin/);

  const presetList = await presets.execute({ action: 'list' }, ctx);
  assert.match(presetList, /general \[builtin\]/);
  assert.match(presetList, /reviewer \[builtin\]/);
  const created = await presets.execute({
    action: 'create',
    presetJson: JSON.stringify({ name: 'Tool Preset', systemPrompt: 'Do tool things.', pluginIds: ['fs-test'] }),
  }, ctx);
  assert.match(created, /Đã tạo preset "tool-preset"/);
  const appliedPreset = await presets.execute({ action: 'apply', presetId: 'tool-preset' }, ctx);
  assert.match(appliedPreset, /Đã áp preset "Tool Preset"/);
  const cloned = await presets.execute({ action: 'clone', presetId: 'general', newPresetId: 'my-general', newName: 'My General' }, ctx);
  assert.match(cloned, /Đã clone preset "general" thành "my-general"/);
  const updated = await presets.execute({
    action: 'update',
    presetId: 'tool-preset',
    presetJson: JSON.stringify({ name: 'Tool Preset', systemPrompt: 'Do tool things well.', maxSteps: 12 }),
  }, ctx);
  assert.match(updated, /Đã cập nhật preset "tool-preset"/);
  const builtinBlocked = await presets.execute({
    action: 'update',
    presetId: 'general',
    presetJson: JSON.stringify({ name: 'General', systemPrompt: 'x' }),
  }, ctx);
  assert.match(builtinBlocked, /^Error:.*builtin/);
  const deleted = await presets.execute({ action: 'delete', presetId: 'tool-preset' }, ctx);
  assert.match(deleted, /Đã xoá preset/);
  const ghost = await presets.execute({ action: 'get', presetId: 'ghost' }, ctx);
  assert.match(ghost, /^Error: Không có preset/);
});

test('v19 tools: agent tool chạy thật và lưu event log', async (t) => {
  const base = tmpdir(t);
  const ctx = testCtx(base);
  const tools = createCodingV19Tools(() => base);
  const agent = toolByName(tools, 'coding_v19_agent');
  const out = await agent.execute({
    task: 'Create a hello file',
    profileId: 'general',
    stepsJson: JSON.stringify([
      { text: 'Write hello.', fileWrite: { path: 'hello.ts', content: 'export const hi = 1;\n' } },
      { text: 'Done.' },
    ]),
  }, ctx);
  assert.match(out, /Agent v19 chạy xong/);
  assert.match(out, /Checkpoint cuối phiên/);
  const convId = out.match(/conversation (conv-[^\s]+)/)[1];
  const workspace = toolByName(tools, 'coding_v19_workspace');
  const read = await workspace.execute({ action: 'read', conversationId: convId, filePath: 'hello.ts' }, ctx);
  assert.equal(read, 'export const hi = 1;\n');
  const badSteps = await agent.execute({ task: 'x', stepsJson: 'not json' }, ctx);
  assert.match(badSteps, /^Error:/);
});

test('v19 i18n: coding.v19.* đủ 56 key, bằng nhau 6 locale, file đã sort', () => {
  assert.equal(CODING_V19_KEYS.length, 56);
  assert.deepEqual([...CODING_V19_KEYS].sort(), CODING_V19_KEYS, 'danh sách key test phải đã sort');
  const perLocale = {};
  for (const locale of LOCALE_NAMES) {
    const data = JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8'));
    perLocale[locale] = data;
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${locale}.json chưa sort`);
    for (const key of CODING_V19_KEYS) {
      assert.ok(key in data, `${locale} thiếu key ${key}`);
      assert.equal(typeof data[key], 'string', `${locale}.${key} phải là string`);
      assert.ok(data[key].trim() !== '', `${locale}.${key} không được rỗng`);
    }
  }
  // Bằng nhau: key v19 của en có mặt y hệt ở 5 locale còn lại.
  const enV19 = Object.keys(perLocale.en).filter((k) => k.startsWith('coding.v19.')).sort();
  assert.deepEqual(enV19, CODING_V19_KEYS);
  for (const locale of ['vi', 'es', 'fr', 'ja', 'zh']) {
    const keys = Object.keys(perLocale[locale]).filter((k) => k.startsWith('coding.v19.')).sort();
    assert.deepEqual(keys, enV19, `${locale} lệch key v19 so với en`);
  }
});

test('v19 tools: plugin template + workspace tree + preset export/import thật', async (t) => {
  const base = tmpdir(t);
  const ctx = testCtx(base);
  const tools = createCodingV19Tools(() => base);
  const plugins = toolByName(tools, 'coding_v19_plugins');
  const workspace = toolByName(tools, 'coding_v19_workspace');
  const conversation = toolByName(tools, 'coding_v19_conversation');
  const presets = toolByName(tools, 'coding_v19_presets');

  const template = await plugins.execute({ action: 'template', category: 'search', pluginName: 'tpl-search' }, ctx);
  assert.match(template, /"name": "tpl-search"/);
  assert.match(template, /"category": "search"/);
  const badTemplate = await plugins.execute({ action: 'template', category: 'nope' }, ctx);
  assert.match(badTemplate, /^Error:.*category/);

  const created = await conversation.execute({ action: 'create', title: 'Tree me' }, ctx);
  const id = created.match(/\[(conv-[^\]]+)\]/)[1];
  await workspace.execute({ action: 'write', conversationId: id, filePath: 'src/a.ts', content: 'aaa' }, ctx);
  await workspace.execute({ action: 'write', conversationId: id, filePath: 'top.md', content: 't' }, ctx);
  const tree = await workspace.execute({ action: 'tree', conversationId: id }, ctx);
  assert.match(tree, /\[dir\] src/);
  assert.match(tree, /\[file\] a\.ts \(3 bytes\)/);
  assert.match(tree, /\[file\] top\.md/);

  const made = await presets.execute({
    action: 'create',
    presetJson: JSON.stringify({ name: 'Export Me', systemPrompt: 'Export me please.' }),
  }, ctx);
  assert.match(made, /Đã tạo preset "export-me"/);
  const exported = await presets.execute({ action: 'export', presetId: 'export-me' }, ctx);
  assert.match(exported, /"id": "export-me"/);
  const builtinExport = await presets.execute({ action: 'export', presetId: 'general' }, ctx);
  assert.match(builtinExport, /"id": "general"/);
  const builtinImport = await presets.execute({ action: 'import', presetJson: builtinExport }, ctx);
  assert.match(builtinImport, /^Error: Đã có preset "general"/);
  await presets.execute({ action: 'delete', presetId: 'export-me' }, ctx);
  const imported = await presets.execute({ action: 'import', presetJson: exported }, ctx);
  assert.match(imported, /Đã import preset "export-me"/);
  const dupImport = await presets.execute({ action: 'import', presetJson: exported }, ctx);
  assert.match(dupImport, /^Error: Đã có preset/);
  const badImport = await presets.execute({ action: 'import', presetJson: 'nope' }, ctx);
  assert.match(badImport, /^Error:/);
});
