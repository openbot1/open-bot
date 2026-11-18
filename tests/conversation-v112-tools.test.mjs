/**
 * Tests cho v1.12 (Đội T2): conversation_v112 tools — placeholder +
 * bound tools end-to-end.
 *
 * - Placeholder (không bind baseDir): mọi tool trả "not configured".
 * - Bound: start → append → replay (chain ok + deterministic) →
 *   branch → snapshot → compact → export → timetravel → skill
 *   list/load → codeact run text (chạy thật trong box).
 * - ALL_TOOLS chứa đủ 10 tên mới, không trùng tên trong toàn bộ
 *   registry; createDefaultTools bind thay placeholder đúng vị trí
 *   (không nhân đôi).
 * - codeact_v112_run_text khi host chưa nối executor → trả hướng
 *   dẫn, không chạy code.
 *
 * Không Electron, không mạng, không key. Build core + tools trước:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/conversation-v112-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BotBoxManager } from '../packages/core/dist/sandbox/box.js';
import { CodeActExecutor } from '../packages/core/dist/codeact/index.js';
import {
  ALL_TOOLS,
  CONVERSATION_V112_TOOLS,
  CONVERSATION_V112_TOOL_NAMES,
  createConversationV112Tools,
  createDefaultTools,
} from '../packages/tools/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-conv-v112-tools-'));
}

function ctx(workspaceDir, botId = 'bot-1') {
  return { workspaceDir, botId };
}

function findTool(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `thiếu tool ${name}`);
  return tool;
}

async function run(tools, name, args, context) {
  const tool = findTool(tools, name);
  return tool.execute(args, context);
}

test('registry: 10 tool mới trong ALL_TOOLS, tên duy nhất toàn registry', () => {
  assert.equal(CONVERSATION_V112_TOOL_NAMES.length, 11);
  assert.equal(CONVERSATION_V112_TOOLS.length, 11);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of CONVERSATION_V112_TOOL_NAMES) {
    assert.ok(names.includes(name), `ALL_TOOLS thiếu ${name}`);
  }
  assert.equal(new Set(names).size, names.length, 'ALL_TOOLS có tên trùng');
  assert.equal(ALL_TOOLS.length, 899, 'v1.14 merge: 453 + 38 = 500; v1.13: 402 + 51 = 453'); // v1.36 re-pin: 825 + 74 = 899.
});

test('placeholder: chưa bind baseDir → trả "not configured"', async () => {
  const dir = tmpDir();
  const tools = createConversationV112Tools();
  const out = await run(tools, 'conversation_v112_start', {}, ctx(dir));
  assert.match(out, /not configured/);
  const out2 = await run(tools, 'skill_v112_list', {}, ctx(dir));
  // skill list không cần baseDir (dùng workspaceDir) → vẫn chạy, trả index rỗng.
  const parsed = JSON.parse(out2);
  assert.deepEqual(parsed.entries, []);
});

test('bound tools: start → append → replay → branch → snapshot → compact → export', async () => {
  const dir = tmpDir();
  const base = path.join(dir, 'userdata');
  const tools = createConversationV112Tools(() => base);
  const c = ctx(path.join(dir, 'ws'));

  const started = JSON.parse(await run(tools, 'conversation_v112_start', { title: 'e2e' }, c));
  const id = started.conversationId;
  assert.ok(id.startsWith('conv-'));

  const m1 = JSON.parse(await run(tools, 'conversation_v112_append_message', { conversationId: id, role: 'user', text: 'xin chào' }, c));
  assert.equal(m1.seq, 2);
  const m2 = JSON.parse(await run(tools, 'conversation_v112_append_message', { conversationId: id, role: 'agent', text: 'chào bạn' }, c));
  assert.equal(m2.seq, 3);

  const replay = JSON.parse(await run(tools, 'conversation_v112_replay', { conversationId: id }, c));
  assert.equal(replay.chainOk, true);
  assert.equal(replay.deterministic, true);
  assert.equal(replay.events, 3);
  assert.equal(replay.state.messages, 2);

  const branch = JSON.parse(await run(tools, 'conversation_v112_branch', { conversationId: id, fromSeq: 2, reason: 'thử' }, c));
  assert.ok(branch.childConversationId.startsWith('conv-'));
  assert.notEqual(branch.childConversationId, id);
  const childReplay = JSON.parse(await run(tools, 'conversation_v112_replay', { conversationId: branch.childConversationId }, c));
  assert.equal(childReplay.state.messages, 1);

  const snap = JSON.parse(await run(tools, 'conversation_v112_snapshot', { conversationId: id }, c));
  assert.equal(snap.throughSeq, 4); // 3 event + 1 branched event
  assert.equal(snap.sha256.length, 64);

  const compact = JSON.parse(await run(tools, 'conversation_v112_compact', { conversationId: id, throughSeq: 2 }, c));
  assert.equal(compact.throughSeq, 2);
  assert.ok(compact.removedEvents >= 1);
  const afterCompact = JSON.parse(await run(tools, 'conversation_v112_replay', { conversationId: id }, c));
  assert.equal(afterCompact.chainOk, true);
  assert.equal(afterCompact.state.messages, 2); // replay từ snapshot vẫn đủ

  const exported = JSON.parse(await run(tools, 'conversation_v112_export', { conversationId: id }, c));
  assert.equal(exported.eventCount, afterCompact.events);
  assert.ok(fs.existsSync(exported.file));

  const travel = JSON.parse(await run(tools, 'conversation_v112_timetravel', { conversationId: id, seq: 2 }, c));
  assert.equal(travel.atSeq, 2);
  assert.equal(travel.stateAtSeq.messages, 1);
  assert.equal(travel.diffToPresent.addedMessages.length, 1);
  assert.ok(travel.futureEvents >= 1);
});

test('bound tools: skill list/load qua workspace .openbot/skills', async () => {
  const dir = tmpDir();
  const base = path.join(dir, 'userdata');
  const ws = path.join(dir, 'ws');
  const skillsDir = path.join(ws, '.openbot', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'code-review.md'), `---
name: code-review
description: Review code changes for bugs and style.
---

# Code review

Check every changed file.
`);
  const tools = createConversationV112Tools(() => base);
  const c = ctx(ws);

  const list = JSON.parse(await run(tools, 'skill_v112_list', {}, c));
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0].name, 'code-review');

  const started = JSON.parse(await run(tools, 'conversation_v112_start', {}, c));
  const loaded = JSON.parse(await run(tools, 'skill_v112_load', { conversationId: started.conversationId, name: 'code-review' }, c));
  assert.match(loaded.rendered, /# Skill: code-review/);
  const replay = JSON.parse(await run(tools, 'conversation_v112_replay', { conversationId: started.conversationId }, c));
  assert.deepEqual(replay.state.loadedSkills, ['code-review']);

  const missing = await run(tools, 'skill_v112_load', { conversationId: started.conversationId, name: 'khong-co' }, c);
  assert.match(missing, /^Error: /);
});

test('bound tools: codeact run text chạy thật trong box + ghi event', async () => {
  const dir = tmpDir();
  const base = path.join(dir, 'userdata');
  const boxes = new BotBoxManager({ rootDir: path.join(dir, 'boxes') });
  const executor = new CodeActExecutor({ boxes, botId: 'bot-1' });
  const tools = createConversationV112Tools(() => base, {
    getCodeActExecutor: () => executor,
  });
  const c = ctx(path.join(dir, 'ws'));

  const started = JSON.parse(await run(tools, 'conversation_v112_start', {}, c));
  const id = started.conversationId;
  const result = JSON.parse(await run(tools, 'codeact_v112_run_text', {
    conversationId: id,
    text: 'Tính nhé:\n```python\nprint(6 * 7)\n```\n```bash\nsudo ls\n```',
  }, c));
  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[0].blocked, false);
  assert.equal(result.runs[0].stdout.trim(), '42');
  assert.equal(result.runs[1].blocked, true);
  const replay = JSON.parse(await run(tools, 'conversation_v112_replay', { conversationId: id }, c));
  assert.equal(replay.state.codeActRuns, 1);
  assert.equal(replay.state.codeActBlocked, 1);
});

test('bound tools: codeact chưa nối executor → hướng dẫn, không chạy', async () => {
  const dir = tmpDir();
  const base = path.join(dir, 'userdata');
  const tools = createConversationV112Tools(() => base);
  const c = ctx(path.join(dir, 'ws'));
  const started = JSON.parse(await run(tools, 'conversation_v112_start', {}, c));
  const out = await run(tools, 'codeact_v112_run_text', {
    conversationId: started.conversationId,
    text: '```bash\necho hi\n```',
  }, c);
  assert.match(out, /chưa được cấu hình/);
});

test('createDefaultTools: bind thay placeholder đúng vị trí, không nhân đôi', () => {
  const dir = tmpDir();
  const base = path.join(dir, 'userdata');
  const bound = createDefaultTools({ getConversationV112BaseDir: () => base });
  const names = bound.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of CONVERSATION_V112_TOOL_NAMES) {
    assert.ok(names.includes(name), `bound thiếu ${name}`);
  }
  assert.equal(bound.length, ALL_TOOLS.length);
});
