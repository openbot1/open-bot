/**
 * Test v1.03 (Đội T1): 5 tool harness v2 — CodeAct + run fork/replay/
 * stuck-check/compact — và đăng ký registry.
 *
 * - codeact_execute: bash echo, python print, write/read/edit file
 *   trong workspace; observation JSON chuẩn (kind/status/exitCode/
 *   stdout/stderr/durationMs/changedFiles); lệnh lỗi → status error;
 *   path thoát workspace (../) bị từ chối; kind lạ → lỗi; timeout
 *   ngoài khoảng → lỗi.
 * - harness_run_fork/replay/stuck_check/compact: chạy thật trên
 *   RunLogStore (logDir truyền qua factory), kết quả JSON đúng.
 * - Registry: 5 tool đều có trong ALL_TOOLS đúng 1 lần, tên không
 *   trùng; codeact_execute cần approval, 4 tool run-log không.
 *
 * Chỉ test thuần (không mạng; python3 có sẵn trên máy). Build core +
 * tools trước:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/harness-v103-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, HARNESS_V103_TOOL_NAMES, createHarnessV103Tools } from '../packages/tools/dist/index.js';
import { RunLogStore } from '../packages/core/dist/event-log/store.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ctx(workspaceDir) {
  return { workspaceDir, botId: 'bot-1' };
}

function tool(tools, name) {
  const found = tools.find((t) => t.definition.name === name);
  assert.ok(found, `tool ${name} exists`);
  return found;
}

/** Seed một run có 1 step tool + lỗi để các tool run-log dùng. */
function seedLog(logDir) {
  const store = new RunLogStore({ logDir });
  const runId = 'run-1';
  store.append(runId, { type: 'run.started', payload: { botId: 'bot-1', maxSteps: 10 } });
  store.append(runId, { type: 'run.prompt', payload: { text: 'làm file a.txt' } });
  store.append(runId, {
    type: 'model.response',
    payload: { step: 0, text: 'ok', toolCalls: [{ callId: 'c1', tool: 'write_file', argKeys: ['path'] }], inputTokens: 20, outputTokens: 5 },
  });
  store.append(runId, { type: 'tool.call', payload: { callId: 'c1', tool: 'write_file', argKeys: ['path'], step: 0 } });
  store.append(runId, {
    type: 'tool.result',
    payload: { callId: 'c1', tool: 'write_file', status: 'ok', outputPreview: 'Wrote a.txt', durationMs: 4, step: 0 },
  });
  store.append(runId, { type: 'run.completed', payload: { finalText: 'Xong.', steps: 1, toolCalls: 1, tokensUsed: 25, durationMs: 10 } });
  return { store, runId };
}

test('registry: 5 tool v1.03 trong ALL_TOOLS đúng 1 lần, không trùng tên', () => {
  for (const name of HARNESS_V103_TOOL_NAMES) {
    assert.equal(
      ALL_TOOLS.filter((t) => t.definition.name === name).length,
      1,
      name,
    );
  }
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names');
  const tools = createHarnessV103Tools();
  assert.equal(tools.length, 5);
  assert.equal(tool(tools, 'codeact_execute').needsApproval, true);
  for (const name of ['harness_run_fork', 'harness_run_replay', 'harness_stuck_check', 'harness_run_compact']) {
    assert.equal(tool(tools, name).needsApproval, false, name);
  }
});

test('codeact: bash + python trả observation chuẩn', async () => {
  const ws = tmpDir('open-bot-codeact-ws-');
  const tools = createHarnessV103Tools();
  const run = tool(tools, 'codeact_execute');

  const bash = JSON.parse(await run.execute({ kind: 'bash', code: 'echo hello-codeact' }, ctx(ws)));
  assert.equal(bash.kind, 'bash');
  assert.equal(bash.status, 'ok');
  assert.equal(bash.exitCode, 0);
  assert.match(bash.stdout, /hello-codeact/);
  assert.equal(typeof bash.durationMs, 'number');
  assert.deepEqual(bash.changedFiles, []);

  const py = JSON.parse(await run.execute({ kind: 'python', code: 'print(40 + 2)' }, ctx(ws)));
  assert.equal(py.kind, 'python');
  assert.equal(py.status, 'ok');
  assert.match(py.stdout, /42/);

  const fail = JSON.parse(await run.execute({ kind: 'bash', code: 'exit 3' }, ctx(ws)));
  assert.equal(fail.status, 'error');
  assert.equal(fail.exitCode, 3);

  // Lỗi đầu vào trả chuỗi "Error: ..." chứ không throw.
  assert.match(await run.execute({ kind: 'ruby', code: 'puts 1' }, ctx(ws)), /^Error: Unknown CodeAct kind/);
  assert.match(await run.execute({ kind: 'bash', code: 'echo hi', timeoutMs: 0 }, ctx(ws)), /^Error: timeoutMs/);
  assert.match(await run.execute({ kind: 'bash', code: 'echo hi', timeoutMs: 999999 }, ctx(ws)), /^Error: timeoutMs/);
});

test('codeact: editor read/write/edit trong workspace; chặn path thoát ra ngoài', async () => {
  const ws = tmpDir('open-bot-codeact-ws-');
  const tools = createHarnessV103Tools();
  const run = tool(tools, 'codeact_execute');
  const c = ctx(ws);

  const written = JSON.parse(await run.execute({ kind: 'write', path: 'sub/note.txt', content: 'hello\nworld\n' }, c));
  assert.equal(written.status, 'ok');
  assert.deepEqual(written.changedFiles, ['sub/note.txt']);
  assert.equal(fs.readFileSync(path.join(ws, 'sub', 'note.txt'), 'utf8'), 'hello\nworld\n');

  const read = JSON.parse(await run.execute({ kind: 'read', path: 'sub/note.txt' }, c));
  assert.equal(read.status, 'ok');
  assert.match(read.stdout, /hello/);

  const edited = JSON.parse(
    await run.execute({ kind: 'edit', path: 'sub/note.txt', oldText: 'world', newText: 'open-bot' }, c),
  );
  assert.equal(edited.status, 'ok');
  assert.equal(fs.readFileSync(path.join(ws, 'sub', 'note.txt'), 'utf8'), 'hello\nopen-bot\n');

  const editMiss = JSON.parse(
    await run.execute({ kind: 'edit', path: 'sub/note.txt', oldText: 'khong-co', newText: 'x' }, c),
  );
  assert.equal(editMiss.status, 'error');
  assert.match(editMiss.stderr, /oldText not found/);

  // Path traversal bị chặn (resolveWithin).
  assert.match(await run.execute({ kind: 'read', path: '../secret.txt' }, c), /^Error:/);
  assert.match(await run.execute({ kind: 'write', path: '../evil.txt', content: 'x' }, c), /^Error:/);
  assert.match(await run.execute({ kind: 'read', path: 'khong-co.txt' }, c), /^Error:/);
});

test('harness_run_fork + harness_run_replay: fork và time-travel qua tool', async () => {
  const ws = tmpDir('open-bot-h103-ws-');
  const logDir = path.join(ws, '.open-bot', 'run-logs');
  seedLog(logDir);
  const tools = createHarnessV103Tools({ logDir });
  const c = ctx(ws);

  const forked = JSON.parse(
    await tool(tools, 'harness_run_fork').execute({ runId: 'run-1', fromSeq: 3, childRunId: 'run-1-b' }, c),
  );
  assert.equal(forked.childRunId, 'run-1-b');
  assert.equal(forked.forkFromSeq, 3);
  assert.ok(forked.copiedEvents >= 2);
  assert.equal(typeof forked.childStateAtFork.digest, 'string');
  assert.deepEqual(forked.branches, ['run-1-b']);

  const replayed = JSON.parse(
    await tool(tools, 'harness_run_replay').execute({ runId: 'run-1', toSeq: 3 }, c),
  );
  assert.equal(replayed.atSeq, 3);
  assert.equal(replayed.totalSeq, 7); // 6 event gốc + 1 run.forked do fork
  assert.equal(replayed.status, 'running');
  assert.equal(replayed.steps, 1);
  assert.equal(replayed.toolCalls.length, 1);

  const full = JSON.parse(await tool(tools, 'harness_run_replay').execute({ runId: 'run-1' }, c));
  assert.equal(full.status, 'completed');
  assert.equal(full.atSeq, 7);

  // Run không có → lỗi dạng "Error: ...".
  assert.match(
    await tool(tools, 'harness_run_replay').execute({ runId: 'run-khong-co' }, c),
    /^Error:/,
  );
});

test('harness_stuck_check + harness_run_compact: phân tích kẹt và nén qua tool', async () => {
  const ws = tmpDir('open-bot-h103-ws-');
  const logDir = path.join(ws, '.open-bot', 'run-logs');
  const store = new RunLogStore({ logDir });
  const runId = 'run-loop';
  store.append(runId, { type: 'run.started', payload: { botId: 'bot-1', maxSteps: 10 } });
  store.append(runId, { type: 'run.prompt', payload: { text: 'đọc file' } });
  for (let s = 0; s < 3; s++) {
    store.append(runId, {
      type: 'model.response',
      payload: { step: s, text: 'đang đọc', toolCalls: [{ callId: `c${s}`, tool: 'read_file', argKeys: ['path'] }] },
    });
    store.append(runId, {
      type: 'tool.result',
      payload: { callId: `c${s}`, tool: 'read_file', status: 'ok', outputPreview: 'same', durationMs: 2, step: s },
    });
  }
  const tools = createHarnessV103Tools({ logDir });
  const c = ctx(ws);

  const stuck = JSON.parse(
    await tool(tools, 'harness_stuck_check').execute({ runId, record: true }, c),
  );
  assert.equal(stuck.stuck, true);
  assert.equal(stuck.signals[0].kind, 'repeat_tool_call');
  assert.equal(stuck.suggestionKey, 'harness.v103.stuck.repeatTool');
  assert.ok(stuck.markerSeq > 0);

  const compacted = JSON.parse(
    await tool(tools, 'harness_run_compact').execute({ runId }, c),
  );
  assert.ok(compacted.eventsCovered > 0);
  assert.ok(compacted.tokensAfter < compacted.tokensBefore);
  assert.ok(compacted.summary.includes('read_file'));
  assert.ok(compacted.markerSeq > 0);
});
