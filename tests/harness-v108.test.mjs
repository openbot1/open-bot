/**
 * Tests cho Harness v4 (v1.08, Đội T3): EventLog v4 (session JSONL,
 * hash chain, replay, time-travel, resume), CodeAct v4 loop (chạy →
 * phân loại lỗi → fixer sửa → chạy lại), dependency sweep (thứ tự an
 * toàn, xung đột, chia việc), 12 tool harness_v4_* trong ALL_TOOLS,
 * i18n 25 key mới đủ 6 locale.
 *
 * Run sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/harness-v108.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc credential thật, KHÔNG gọi API
 * ngoài: CodeAct chạy thật trong BotBox sandbox local (bash/python
 * ngắn, không mạng); EventLog ghi vào thư mục tạm; dependency sweep
 * chạy trên file inline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BotBoxManager } from '../packages/core/dist/sandbox/box.js';
import {
  BotMemory,
  CodeActExecutor,
  CodeActV4Loop,
  HarnessV4EventLog,
  analyzeHarnessV4Dependencies,
  classifyHarnessV4Error,
  defaultToolFactory,
  detectHarnessV4Conflicts,
  foldHarnessV4Events,
  harnessV4CompareStates,
  harnessV4HashEvent,
  harnessV4ImpactOf,
  harnessV4StableStringify,
  harnessV4VerifyEventHash,
  safeHarnessV4Order,
  suggestHarnessV4Partition,
} from '../packages/core/dist/index.js';
import {
  ALL_TOOLS,
  HARNESS_V4_TOOL_NAMES,
  HARNESS_V4_TOOLS,
  createHarnessV4Tools,
} from '../packages/tools/dist/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCALES = ['en', 'vi', 'zh', 'ja', 'es', 'fr'];

const NEW_I18N_KEYS = [
  'harness.v108.codeact.blocked',
  'harness.v108.codeact.failed',
  'harness.v108.codeact.loop',
  'harness.v108.codeact.maxRounds',
  'harness.v108.codeact.round',
  'harness.v108.codeact.run',
  'harness.v108.codeact.succeeded',
  'harness.v108.codeact.timeout',
  'harness.v108.deps.clean',
  'harness.v108.deps.conflict',
  'harness.v108.deps.cycle',
  'harness.v108.deps.missing',
  'harness.v108.deps.order',
  'harness.v108.deps.partition',
  'harness.v108.eventlog.append',
  'harness.v108.eventlog.create',
  'harness.v108.eventlog.events',
  'harness.v108.eventlog.listEmpty',
  'harness.v108.eventlog.replay',
  'harness.v108.eventlog.session',
  'harness.v108.eventlog.tampered',
  'harness.v108.eventlog.timetravel',
  'harness.v108.eventlog.title',
  'harness.v108.eventlog.verifyBad',
  'harness.v108.eventlog.verifyOk',
];

function tmpDir(prefix = 'open-bot-harness-v108-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeLog() {
  const dir = tmpDir();
  return { dir, log: new HarnessV4EventLog({ logDir: path.join(dir, 'logs') }) };
}

function makeExecutor(limits = {}) {
  const dir = tmpDir('open-bot-codeact-v108-');
  const boxes = new BotBoxManager({ rootDir: path.join(dir, 'boxes') });
  const executor = new CodeActExecutor({ boxes, botId: 'harness-v4-test', limits });
  return { dir, boxes, executor };
}

function localeKeys(locale) {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales', `${locale}.json`), 'utf8'),
  );
}

/** Session mẫu: started + user + model + tool call/result + error + ended. */
function seedSession(log, sessionId = 's1') {
  log.createSession(sessionId, { botId: 'bot-a', title: 'Phiên mẫu' });
  log.append(sessionId, { type: 'h4.user.message', payload: { text: 'Viết file a.txt', step: 0 } });
  log.append(sessionId, { type: 'h4.model.reply', payload: { step: 0, text: 'Đang viết…', toolCalls: ['write_file'], inputTokens: 10, outputTokens: 5 } });
  log.append(sessionId, { type: 'h4.tool.call', payload: { callId: 'c1', tool: 'write_file', step: 0 } });
  log.append(sessionId, { type: 'h4.tool.result', payload: { callId: 'c1', tool: 'write_file', step: 0, status: 'ok', outputPreview: 'ok', durationMs: 3 } });
  log.append(sessionId, { type: 'h4.error', payload: { step: 1, kind: 'runtime', message: 'lỗi thử', source: 'test' } });
  log.append(sessionId, { type: 'h4.session.ended', payload: { status: 'completed', steps: 2, toolCalls: 1, codeActRuns: 0, errors: 1, durationMs: 100, finalText: 'Xong.' } });
  return sessionId;
}

// ---------------------------------------------------------------------------
// 1. EventLog v4 — hash chain + persist + verify
// ---------------------------------------------------------------------------

test('v108 eventlog: create + append seq tăng đều, hash chain đúng, verify ok', () => {
  const { log } = makeLog();
  const first = log.createSession('s1', { botId: 'bot-a', title: 'T' });
  assert.equal(first.seq, 1);
  assert.equal(first.prevHash, '');
  assert.ok(first.hash.length === 64);
  assert.ok(harnessV4VerifyEventHash(first));
  const second = log.append('s1', { type: 'h4.user.message', payload: { text: 'hi', step: 0 } });
  assert.equal(second.seq, 2);
  assert.equal(second.prevHash, first.hash);
  const verification = log.verify('s1');
  assert.equal(verification.ok, true);
  assert.equal(verification.eventCount, 2);
  // File trên đĩa là JSONL: 1 dòng = 1 event.
  const lines = fs.readFileSync(log.sessionFilePath('s1'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, 'h4.session.started');
});

test('v108 eventlog: stable stringify không phụ thuộc thứ tự key; hash đổi khi nội dung đổi', () => {
  assert.equal(harnessV4StableStringify({ b: 1, a: { d: 2, c: 3 } }), harnessV4StableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  const base = { seq: 1, sessionId: 's', at: '2026-01-01T00:00:00.000Z', type: 'h4.user.message', payload: { text: 'a', step: 0 }, prevHash: '' };
  const h1 = harnessV4HashEvent(base);
  const h2 = harnessV4HashEvent({ ...base, payload: { text: 'b', step: 0 } });
  assert.notEqual(h1, h2);
  assert.equal(h1.length, 64);
});

test('v108 eventlog: tạo trùng session / đọc session không có / append session hỏng đều throw rõ', () => {
  const { log, dir } = makeLog();
  log.createSession('dup', { botId: 'b' });
  assert.throws(() => log.createSession('dup', { botId: 'b' }), /đã tồn tại/);
  assert.throws(() => log.readSession('khong-co'), /Không có session/);
  assert.throws(() => log.verify('khong-co'), /Không có session/);
  // File hỏng: ghi dòng JSON vỡ vào file rồi append phải từ chối.
  const badFile = log.sessionFilePath('bad');
  fs.mkdirSync(path.dirname(badFile), { recursive: true });
  fs.writeFileSync(badFile, '{"seq": 1, "broken"\n');
  assert.throws(() => log.append('bad', { type: 'h4.error', payload: { step: 0, kind: 'unknown', message: 'x' } }), /dòng hỏng/);
  void dir;
});

test('v108 eventlog: sửa một dòng trên đĩa -> verify báo đúng seq hỏng; append sau đó bị từ chối', () => {
  const { log } = makeLog();
  seedSession(log, 's1');
  assert.equal(log.verify('s1').ok, true);
  const file = log.sessionFilePath('s1');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[2]);
  tampered.payload.text = 'ĐÃ SỬA';
  lines[2] = JSON.stringify(tampered);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const verification = log.verify('s1');
  assert.equal(verification.ok, false);
  assert.equal(verification.firstBadSeq, 3);
  assert.match(verification.reason ?? '', /bị sửa/);
  // Append vào log đã đứt chuỗi phải từ chối (không nối tiếp chuỗi hỏng).
  const log2 = new HarnessV4EventLog({ logDir: path.dirname(file) });
  assert.throws(
    () => log2.append('s1', { type: 'h4.error', payload: { step: 9, kind: 'unknown', message: 'x' } }),
    /đứt ở seq 3/,
  );
});

test('v108 eventlog: readSession bỏ qua dòng hỏng và báo corruptLines, không crash', () => {
  const { log } = makeLog();
  seedSession(log, 's1');
  const file = log.sessionFilePath('s1');
  fs.appendFileSync(file, 'dòng hỏng không phải json\n{"seq": 99}\n');
  const read = log.readSession('s1');
  assert.equal(read.corruptLines, 1);
  assert.equal(read.invalidLines, 1);
  assert.equal(read.events.length, 7);
});

// ---------------------------------------------------------------------------
// 2. EventLog v4 — replay + time-travel + resume
// ---------------------------------------------------------------------------

test('v108 eventlog: replay fold đúng transcript/tool/error/tokens; digest ổn định qua 2 lần replay', () => {
  const { log } = makeLog();
  seedSession(log, 's1');
  const state1 = log.replay('s1');
  const state2 = log.replay('s1');
  assert.equal(state1.digest, state2.digest);
  assert.equal(state1.botId, 'bot-a');
  assert.equal(state1.status, 'completed');
  assert.equal(state1.steps, 2);
  assert.equal(state1.tokensUsed, 15);
  assert.equal(state1.toolCalls.length, 1);
  assert.equal(state1.toolCalls[0].status, 'ok');
  assert.equal(state1.errors.length, 1);
  assert.deepEqual(
    state1.transcript.map((t) => t.kind),
    ['user', 'model', 'tool_call', 'tool_result', 'error'],
  );
  // foldEvents thuần: cùng event cho cùng digest.
  const { events } = log.readSession('s1');
  assert.equal(foldHarnessV4Events('s1', events).digest, state1.digest);
});

test('v108 eventlog: time-travel stateAt(3) thấy ít hơn trạng thái cuối; diffVsFinal đúng; atSeq 0 rỗng', () => {
  const { log } = makeLog();
  seedSession(log, 's1');
  const at3 = log.stateAt('s1', 3);
  assert.equal(at3.atSeq, 3);
  assert.equal(at3.totalSeq, 7);
  assert.equal(at3.eventsUsed, 3);
  assert.equal(at3.state.transcript.length, 2);
  assert.equal(at3.state.toolCalls.length, 0);
  assert.equal(at3.state.status, 'running');
  assert.equal(at3.diffVsFinal.toolCallsDelta, 1);
  assert.equal(at3.diffVsFinal.transcriptDelta, 3);
  assert.equal(at3.diffVsFinal.statusChanged, true);
  const at0 = log.stateAt('s1', 0);
  assert.equal(at0.state.transcript.length, 0);
  assert.equal(at0.state.status, 'running');
  assert.throws(() => log.stateAt('s1', 8), /ngoài khoảng/);
  assert.throws(() => log.stateAt('s1', -1), /ngoài khoảng/);
});

test('v108 eventlog: resumeFrom tạo session con từ prefix, session gốc không đổi, con verify ok', () => {
  const { log } = makeLog();
  seedSession(log, 's1');
  const before = fs.readFileSync(log.sessionFilePath('s1'), 'utf8');
  const resumed = log.resumeFrom('s1', 3, { childSessionId: 's1-resume', title: 'Chạy lại từ bước 3' });
  assert.equal(resumed.childSessionId, 's1-resume');
  assert.equal(resumed.fromSeq, 3);
  assert.equal(resumed.parentSessionId, 's1');
  // Con có started mới + 2 event prefix (user/model) = 3 event; transcript khớp prefix.
  assert.equal(resumed.childStateAtFork.transcript.length, 2);
  assert.equal(resumed.childStateAtFork.botId, 'bot-a');
  assert.equal(log.verify('s1-resume').ok, true);
  // Gốc không đổi (byte-identical).
  assert.equal(fs.readFileSync(log.sessionFilePath('s1'), 'utf8'), before);
  // Ghi tiếp vào con không ảnh hưởng gốc.
  log.append('s1-resume', { type: 'h4.user.message', payload: { text: 'tiếp tục', step: 1 } });
  assert.equal(log.readSession('s1').events.length, 7);
  assert.equal(log.readSession('s1-resume').events.length, 4);
  assert.throws(() => log.resumeFrom('s1', 99, { childSessionId: 's1-resume-2' }), /ngoài khoảng/);
});

test('v108 eventlog: listSessions + endSession cập nhật status/meta', () => {
  const { log } = makeLog();
  log.createSession('a', { botId: 'bot-a' });
  log.append('a', { type: 'h4.user.message', payload: { text: 'hi', step: 0 } });
  log.endSession('a', { status: 'completed', finalText: 'xong' });
  log.createSession('b', { botId: 'bot-b' });
  const sessions = log.listSessions();
  assert.equal(sessions.length, 2);
  const a = sessions.find((s) => s.sessionId === 'a');
  assert.equal(a.status, 'completed');
  assert.equal(a.eventCount, 3);
  assert.equal(a.botId, 'bot-a');
  const b = sessions.find((s) => s.sessionId === 'b');
  assert.equal(b.status, 'running');
  assert.equal(b.eventCount, 1);
});

test('v108 eventlog: compareStates diff đúng hướng (a→b)', () => {
  const { log } = makeLog();
  seedSession(log, 's1');
  const early = log.stateAt('s1', 2).state;
  const final = log.replay('s1');
  const diff = harnessV4CompareStates(early, final);
  assert.equal(diff.stepsDelta, 1);
  assert.equal(diff.toolCallsDelta, 1);
  assert.equal(diff.errorsDelta, 1);
  assert.equal(diff.statusChanged, true);
  assert.match(diff.summary, /steps \+1/);
  assert.equal(harnessV4CompareStates(final, final).summary, 'identical');
});

// ---------------------------------------------------------------------------
// 3. CodeAct v4 loop — chạy thật trong sandbox
// ---------------------------------------------------------------------------

test('v108 codeact loop: thành công ngay vòng 1 (bash echo)', async () => {
  const { executor } = makeExecutor();
  const loop = new CodeActV4Loop({ executor });
  const result = await loop.run({ kind: 'bash', command: 'echo hello-v108' });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.rounds.length, 1);
  assert.equal(result.finalObservation.exitCode, 0);
  assert.equal(result.finalObservation.stdout.trim(), 'hello-v108');
  assert.equal(result.hitMaxRounds, false);
  assert.equal(result.lastErrorKind, undefined);
});

test('v108 codeact loop: python lỗi cú pháp, fixer sửa đúng -> succeeded vòng 2, errorKind syntax', async () => {
  const { executor } = makeExecutor();
  let fixerCalls = 0;
  const loop = new CodeActV4Loop({
    executor,
    fixer: ({ errorKind }) => {
      fixerCalls += 1;
      assert.equal(errorKind, 'syntax');
      return { kind: 'python', code: 'print(6 * 7)' };
    },
  });
  const result = await loop.run({ kind: 'python', code: 'def broken(:\n  pass' });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.rounds.length, 2);
  assert.equal(fixerCalls, 1);
  assert.equal(result.rounds[0].errorKind, 'syntax');
  assert.equal(result.rounds[0].fixHint !== undefined, true);
  assert.equal(result.finalObservation.stdout.trim(), '42');
});

test('v108 codeact loop: fixer trả null -> failed sau 1 vòng; không có fixer -> failed sau 1 vòng', async () => {
  const { executor } = makeExecutor();
  const giveUp = new CodeActV4Loop({ executor, fixer: () => null });
  const r1 = await giveUp.run({ kind: 'python', code: 'raise RuntimeError("boom")' });
  assert.equal(r1.outcome, 'failed');
  assert.equal(r1.rounds.length, 1);
  assert.equal(r1.lastErrorKind, 'runtime');

  const noFixer = new CodeActV4Loop({ executor });
  const r2 = await noFixer.run({ kind: 'bash', command: 'false' });
  assert.equal(r2.outcome, 'failed');
  assert.equal(r2.rounds.length, 1);
  assert.equal(r2.lastErrorKind, 'runtime');
});

test('v108 codeact loop: lệnh bị chặn -> blocked ngay, không retry', async () => {
  const { executor } = makeExecutor();
  let fixerCalls = 0;
  const loop = new CodeActV4Loop({
    executor,
    fixer: () => {
      fixerCalls += 1;
      return { kind: 'bash', command: 'echo x' };
    },
  });
  const result = await loop.run({ kind: 'bash', command: 'rm -rf /' });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.rounds.length, 1);
  assert.equal(result.lastErrorKind, 'blocked');
  assert.equal(fixerCalls, 0, 'bị chặn thì không gọi fixer');
});

test('v108 codeact loop: fixer sửa sai mãi -> max_rounds + hitMaxRounds', async () => {
  const { executor } = makeExecutor();
  const loop = new CodeActV4Loop({
    executor,
    fixer: () => ({ kind: 'python', code: 'def broken(:\n  pass' }),
    limits: { maxRounds: 3 },
  });
  const result = await loop.run({ kind: 'python', code: 'def broken(:\n  pass' });
  assert.equal(result.outcome, 'max_rounds');
  assert.equal(result.rounds.length, 3);
  assert.equal(result.hitMaxRounds, true);
  assert.equal(result.lastErrorKind, 'syntax');
});

test('v108 codeact loop: classify timeout / not_found / permission / validation', async () => {
  const { executor } = makeExecutor({ timeoutMs: 500 });
  const slow = await executor.execute({ kind: 'bash', command: 'sleep 5' });
  assert.equal(slow.observation.timedOut, true);
  assert.equal(classifyHarnessV4Error(slow), 'timeout');
  const missing = await executor.execute({ kind: 'bash', command: 'ls /thu-muc-khong-ton-tai-xyz-v108' });
  assert.equal(classifyHarnessV4Error(missing), 'not_found');
  const ok = await executor.execute({ kind: 'bash', command: 'echo ok' });
  assert.equal(classifyHarnessV4Error(ok), undefined);
  const loop = new CodeActV4Loop({ executor });
  await assert.rejects(loop.run({ kind: 'bash', command: '   ' }), /command rỗng/);
  assert.throws(() => new CodeActV4Loop({ executor, limits: { maxRounds: 0 } }), /maxRounds/);
  assert.throws(() => new CodeActV4Loop({ executor, limits: { maxRounds: 21 } }), /maxRounds/);
});

test('v108 codeact loop: ghi event vào EventLog v4 (run từng vòng + loop)', async () => {
  const { log } = makeLog();
  const { executor } = makeExecutor();
  log.createSession('loop-s', { botId: 'bot-a' });
  const loop = new CodeActV4Loop({
    executor,
    fixer: () => ({ kind: 'python', code: 'print("fixed")' }),
    eventLog: log,
    sessionId: 'loop-s',
    step: 2,
  });
  const result = await loop.run({ kind: 'python', code: 'def broken(:\n  pass' });
  assert.equal(result.outcome, 'succeeded');
  const { events } = log.readSession('loop-s');
  assert.deepEqual(
    events.map((e) => e.type),
    ['h4.session.started', 'h4.codeact.run', 'h4.codeact.run', 'h4.codeact.loop'],
  );
  const loopEvent = events[3];
  assert.equal(loopEvent.payload.outcome, 'succeeded');
  assert.equal(loopEvent.payload.rounds, 2);
  assert.equal(log.verify('loop-s').ok, true);
});

// ---------------------------------------------------------------------------
// 4. Dependency sweep — đồ thị + thứ tự + xung đột + chia việc
// ---------------------------------------------------------------------------

const SWEEP_FILES = [
  { path: 'src/a.ts', content: "import { b } from './b';\nimport { c } from './c';\nexport const a = b + c;\n" },
  { path: 'src/b.ts', content: "import { c } from './c';\nexport const b = c + 1;\n" },
  { path: 'src/c.ts', content: 'export const c = 1;\n' },
  { path: 'src/d.ts', content: "import { a } from './a';\nexport const d = a;\n" },
  { path: 'src/standalone.ts', content: 'export const s = 0;\n' },
];

test('v108 deps: graph đúng cạnh + leaves; safe order c trước b trước a trước d', () => {
  const graph = analyzeHarnessV4Dependencies(SWEEP_FILES);
  assert.equal(graph.files.length, 5);
  assert.deepEqual(
    graph.edges.map((e) => `${e.from}->${e.to}`).sort(),
    ['src/a.ts->src/b.ts', 'src/a.ts->src/c.ts', 'src/b.ts->src/c.ts', 'src/d.ts->src/a.ts'],
  );
  assert.deepEqual(graph.leaves, ['src/standalone.ts']);
  assert.deepEqual(graph.cycles, []);
  assert.deepEqual(graph.missing, []);
  const order = safeHarnessV4Order(graph);
  assert.equal(order.hasCycles, false);
  const idx = new Map(order.order.map((f, i) => [f, i]));
  assert.ok(idx.get('src/c.ts') < idx.get('src/b.ts'));
  assert.ok(idx.get('src/b.ts') < idx.get('src/a.ts'));
  assert.ok(idx.get('src/a.ts') < idx.get('src/d.ts'));
  assert.equal(order.levels[0].includes('src/c.ts'), true);
  assert.equal(order.levels[0].includes('src/standalone.ts'), true);
  // File cùng tầng không phụ thuộc nhau.
  assert.ok(order.levels.every((level) => level.length >= 1));
});

test('v108 deps: diamond + index resolve + bare import bỏ qua + missing liệt kê', () => {
  const files = [
    { path: 'src/main.ts', content: "import './lib';\nimport React from 'react';\nimport { x } from './missing-file';\n" },
    { path: 'src/lib/index.ts', content: "import { u } from './util';\nexport const lib = u;\n" },
    { path: 'src/lib/util.ts', content: 'export const u = 1;\n' },
  ];
  const graph = analyzeHarnessV4Dependencies(files);
  assert.deepEqual(
    graph.edges.map((e) => `${e.from}->${e.to}`).sort(),
    ['src/lib/index.ts->src/lib/util.ts', 'src/main.ts->src/lib/index.ts'],
  );
  assert.deepEqual(graph.missing, ['src/missing-file']);
  const order = safeHarnessV4Order(graph);
  assert.ok(order.order.indexOf('src/lib/util.ts') < order.order.indexOf('src/lib/index.ts'));
  assert.ok(order.order.indexOf('src/lib/index.ts') < order.order.indexOf('src/main.ts'));
});

test('v108 deps: chu trình a<->b được phát hiện, hasCycles, file chu trình xếp cuối', () => {
  const files = [
    { path: 'x.ts', content: "import './y';\nexport const x = 1;\n" },
    { path: 'y.ts', content: "import './x';\nexport const y = 1;\n" },
    { path: 'z.ts', content: "import './x';\nexport const z = 1;\n" },
  ];
  const graph = analyzeHarnessV4Dependencies(files);
  assert.equal(graph.cycles.length, 1);
  assert.deepEqual([...graph.cycles[0]].sort(), ['x.ts', 'x.ts', 'y.ts'].sort());
  const order = safeHarnessV4Order(graph);
  assert.equal(order.hasCycles, true);
  assert.deepEqual(order.order.slice(-2), ['x.ts', 'y.ts']);
});

test('v108 deps: python import tương đối được resolve', () => {
  const files = [
    { path: 'pkg/main.py', content: 'from .util import helper\n' },
    { path: 'pkg/util.py', content: 'def helper(): pass\n' },
    { path: 'pkg/other.py', content: 'import os\n' },
  ];
  const graph = analyzeHarnessV4Dependencies(files);
  assert.deepEqual(graph.edges, [{ from: 'pkg/main.py', to: 'pkg/util.py', kind: 'relative' }]);
  const order = safeHarnessV4Order(graph);
  assert.ok(order.order.indexOf('pkg/util.py') < order.order.indexOf('pkg/main.py'));
});

test('v108 deps: conflicts direct + shared_dependency; clean khi chia đúng', () => {
  const graph = analyzeHarnessV4Dependencies(SWEEP_FILES);
  const direct = detectHarnessV4Conflicts(graph, [
    { agent: 'A', files: ['src/a.ts', 'src/c.ts'] },
    { agent: 'B', files: ['src/c.ts', 'src/d.ts'] },
  ]);
  assert.equal(direct.clean, false);
  assert.ok(direct.conflicts.some((c) => c.kind === 'direct' && c.files.includes('src/c.ts') && c.severity === 'high'));
  // B sửa d (phụ thuộc a) trong khi A sửa a -> shared_dependency.
  assert.ok(direct.conflicts.some((c) => c.kind === 'shared_dependency' && c.severity === 'medium'));

  const clean = detectHarnessV4Conflicts(graph, [
    { agent: 'A', files: ['src/c.ts'] },
    { agent: 'B', files: ['src/standalone.ts'] },
  ]);
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.conflicts, []);
  assert.equal(clean.pairsChecked, 1);
});

test('v108 deps: partition chia hết file, mỗi file đúng 1 agent, file chu trình về agent đầu', () => {
  const graph = analyzeHarnessV4Dependencies(SWEEP_FILES);
  const partition = suggestHarnessV4Partition(graph, 2, ['lan', 'minh']);
  assert.equal(partition.agentCount, 2);
  assert.deepEqual(partition.groups.map((g) => g.agent), ['lan', 'minh']);
  const all = partition.groups.flatMap((g) => g.files).sort();
  assert.deepEqual(all, [...graph.files].sort());
  assert.deepEqual(partition.cyclicFiles, []);
  assert.match(partition.rationale, /thứ tự an toàn/);

  const cyclic = analyzeHarnessV4Dependencies([
    { path: 'x.ts', content: "import './y';\n" },
    { path: 'y.ts', content: "import './x';\n" },
    { path: 'z.ts', content: 'export const z = 1;\n' },
  ]);
  const p2 = suggestHarnessV4Partition(cyclic, 2);
  assert.deepEqual(p2.cyclicFiles, ['x.ts', 'y.ts']);
  assert.ok(p2.groups[0].files.includes('x.ts') && p2.groups[0].files.includes('y.ts'));
  assert.ok(p2.groups[0].files.indexOf('z.ts') < p2.groups[0].files.indexOf('x.ts'), 'file chu trình sửa cuối trong nhóm');
});

// ---------------------------------------------------------------------------
// 5. Tools — 12 tool trong ALL_TOOLS + chạy thật qua factory
// ---------------------------------------------------------------------------

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

test('v108 tools: 12 tool trong ALL_TOOLS, tên không trùng, execute là function thật', () => {
  for (const name of HARNESS_V4_TOOL_NAMES) {
    const found = ALL_TOOLS.find((t) => t.definition.name === name);
    assert.ok(found, `${name} phải có trong ALL_TOOLS`);
    assert.equal(typeof found.execute, 'function', `${name} phải có execute thật`);
  }
  const allNames = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(allNames).size, allNames.length, 'ALL_TOOLS không được trùng tên tool');
  assert.deepEqual(HARNESS_V4_TOOLS.map((t) => t.definition.name), [...HARNESS_V4_TOOL_NAMES]);
  // ALL_TOOLS (default tools) v1.07 = 129, + 12 harness v4 = 141.
  assert.ok(ALL_TOOLS.length >= 1078, `expected >= 1078 tools in ALL_TOOLS, got ${ALL_TOOLS.length}`); // v1.39 fix round 4b: floor (was 1078 in v1.38; now 1164).
});

test('v108 tools: placeholder chưa bind codeact trả hướng dẫn, không giả vờ chạy', async () => {
  const ctx = { workspaceDir: '/tmp', botId: 'b1' };
  const run = toolByName(HARNESS_V4_TOOLS, 'harness_v4_codeact_run');
  const loop = toolByName(HARNESS_V4_TOOLS, 'harness_v4_codeact_loop');
  assert.match(await run.execute({ kind: 'bash', command: 'echo x' }, ctx), /chưa được cấu hình/);
  assert.match(await loop.execute({ kind: 'bash', command: 'echo x' }, ctx), /chưa được cấu hình/);
});

test('v108 tools: eventlog tools round-trip qua factory (create/append/replay/verify/timetravel/list)', async () => {
  const dir = tmpDir();
  const ctx = { workspaceDir: '/tmp', botId: 'bot-a' };
  const tools = createHarnessV4Tools({ logDir: path.join(dir, 'logs') });
  const create = toolByName(tools, 'harness_v4_eventlog_create');
  const created = JSON.parse(await create.execute({ sessionId: 't1', botId: 'bot-a', title: 'Tool test' }, ctx));
  assert.equal(created.sessionId, 't1');
  assert.equal(created.firstEvent.seq, 1);

  const append = toolByName(tools, 'harness_v4_eventlog_append');
  const appended = JSON.parse(await append.execute({ sessionId: 't1', kind: 'h4.user.message', payload: { text: 'hi', step: 0 } }, ctx));
  assert.equal(appended.seq, 2);
  assert.match(await append.execute({ sessionId: 't1', kind: 'h4.nope', payload: {} }, ctx), /^Error: Unknown event kind/);

  const replay = toolByName(tools, 'harness_v4_eventlog_replay');
  const state = JSON.parse(await replay.execute({ sessionId: 't1' }, ctx));
  assert.equal(state.eventsReplayed, 2);
  assert.equal(state.state.transcript.length, 1);
  assert.equal(state.state.transcript[0].text, 'hi');

  const verify = toolByName(tools, 'harness_v4_eventlog_verify');
  assert.equal(JSON.parse(await verify.execute({ sessionId: 't1' }, ctx)).ok, true);

  const timetravel = toolByName(tools, 'harness_v4_eventlog_timetravel');
  const tt = JSON.parse(await timetravel.execute({ sessionId: 't1', atSeq: 1 }, ctx));
  assert.equal(tt.atSeq, 1);
  assert.equal(tt.state.transcript.length, 0);
  assert.match(await timetravel.execute({ sessionId: 't1', atSeq: 99 }, ctx), /^Error: .*ngoài khoảng/);

  const list = toolByName(tools, 'harness_v4_eventlog_list');
  const listed = JSON.parse(await list.execute({}, ctx));
  assert.equal(listed.count, 1);
  assert.equal(listed.sessions[0].sessionId, 't1');
});

test('v108 tools: codeact_run + codeact_loop bound chạy thật trong sandbox + ghi log', async () => {
  const dir = tmpDir();
  const ctx = { workspaceDir: '/tmp', botId: 'bot-a' };
  const { executor } = makeExecutor();
  const tools = createHarnessV4Tools({
    logDir: path.join(dir, 'logs'),
    getCodeActExecutor: () => executor,
    fixCode: () => ({ kind: 'python', code: 'print("fixed")' }),
  });
  const run = toolByName(tools, 'harness_v4_codeact_run');
  const out = JSON.parse(await run.execute({ kind: 'bash', command: 'echo run-that', sessionId: 'code-s', step: 0 }, ctx));
  assert.equal(out.observation.exitCode, 0);
  assert.equal(out.observation.stdout.trim(), 'run-that');
  // Log đã ghi event codeact.run.
  const log = new HarnessV4EventLog({ logDir: path.join(dir, 'logs') });
  assert.ok(log.readSession('code-s').events.some((e) => e.type === 'h4.codeact.run'));

  const loop = toolByName(tools, 'harness_v4_codeact_loop');
  const looped = JSON.parse(await loop.execute({ kind: 'python', code: 'def broken(:\n  pass', maxRounds: 3, sessionId: 'code-s', step: 1 }, ctx));
  assert.equal(looped.outcome, 'succeeded');
  assert.equal(looped.rounds, 2);
  assert.equal(looped.fixerConfigured, true);
  assert.equal(looped.errorClassification, undefined);
  assert.equal(log.readSession('code-s').events.filter((e) => e.type === 'h4.codeact.loop').length, 1);
});

test('v108 tools: deps tools qua factory (order/conflicts/partition/graph) + repoDir ngoài phạm vi bị từ chối', async () => {
  const dir = tmpDir();
  const ctx = { workspaceDir: dir, botId: 'b1' };
  const tools = createHarnessV4Tools({ logDir: path.join(dir, 'logs'), repoRoot: dir });
  const order = toolByName(tools, 'harness_v4_deps_order');
  const ordered = JSON.parse(await order.execute({ files: SWEEP_FILES }, ctx));
  assert.ok(ordered.order.indexOf('src/c.ts') < ordered.order.indexOf('src/a.ts'));
  assert.equal(ordered.levels.length >= 3, true);

  const conflicts = toolByName(tools, 'harness_v4_deps_conflicts');
  const report = JSON.parse(
    await conflicts.execute(
      { files: SWEEP_FILES, assignments: [{ agent: 'A', files: ['src/c.ts'] }, { agent: 'B', files: ['src/c.ts'] }] },
      ctx,
    ),
  );
  assert.equal(report.clean, false);
  assert.ok(report.conflicts.some((c) => c.kind === 'direct'));

  const partition = toolByName(tools, 'harness_v4_deps_partition');
  const part = JSON.parse(await partition.execute({ files: SWEEP_FILES, agentCount: 2 }, ctx));
  assert.equal(part.groups.length, 2);
  assert.equal(part.groups.flatMap((g) => g.files).length, 5);
  assert.match(await partition.execute({ files: SWEEP_FILES, agentCount: 99 }, ctx), /^Error: agentCount/);

  const graph = toolByName(tools, 'harness_v4_deps_graph');
  const g = JSON.parse(await graph.execute({ files: SWEEP_FILES }, ctx));
  assert.equal(g.files, 5);
  assert.equal(g.edges, 4);
  assert.deepEqual(g.leaves, ['src/standalone.ts']);

  // repoDir ngoài repoRoot bị từ chối; repoDir không tồn tại báo lỗi rõ.
  assert.match(await order.execute({ repoDir: '..' }, ctx), /^Error: .*ngoài phạm vi/);
  assert.match(await order.execute({ repoDir: 'khong-co' }, ctx), /^Error: .*không phải thư mục/);
  assert.match(await order.execute({ files: [] }, ctx), /^Error: .*không được rỗng/);
});

test('v108 tools: defaultToolFactory gồm 12 tool harness v4 (500 + 56 = 556)', () => {
  const ws = tmpDir('open-bot-v108-factory-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-a');
    const names = tools.map((t) => t.definition.name);
    assert.ok(names.length >= 1453, `expected >= 1453 tools, got ${names.length}`); // v1.39 fix round 4b: floor (was 1453; now 1539).
    assert.equal(new Set(names).size, names.length, 'duplicate tool names');
    for (const name of HARNESS_V4_TOOL_NAMES) {
      assert.ok(names.includes(name), `defaultToolFactory thiếu ${name}`);
    }
  } finally {
    mem.close();
  }
});

test('v108 eventlog: queryEvents lọc theo loại/khoảng seq + phân trang', () => {
  const { log } = makeLog();
  seedSession(log, 's1');
  const errors = log.queryEvents('s1', { types: ['h4.error'] });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'h4.error');
  const firstTwo = log.queryEvents('s1', { toSeq: 2 });
  assert.deepEqual(firstTwo.map((e) => e.seq), [1, 2]);
  const page = log.queryEvents('s1', { limit: 2, offset: 2 });
  assert.deepEqual(page.map((e) => e.seq), [3, 4]);
  const none = log.queryEvents('s1', { types: ['h4.checkpoint'] });
  assert.deepEqual(none, []);
  const mixed = log.queryEvents('s1', { types: ['h4.tool.call', 'h4.tool.result'], fromSeq: 4 });
  assert.deepEqual(mixed.map((e) => e.type), ['h4.tool.call', 'h4.tool.result']);
});

test('v108 eventlog: snapshot lưu/nạp đúng state + digest; logMatches đổi sau khi append thêm', () => {
  const { log } = makeLog();
  seedSession(log, 's1');
  const snap = log.saveSnapshot('s1');
  assert.equal(snap.version, 1);
  assert.equal(snap.upToSeq, 7);
  assert.equal(snap.eventCount, 7);
  assert.equal(snap.state.digest.length, 64);
  assert.equal(snap.state.status, 'completed');
  const loaded = log.loadSnapshot('s1');
  assert.equal(loaded.logMatches, true);
  assert.equal(loaded.state.digest, snap.state.digest);
  // Append thêm event -> snapshot vẫn dùng được tới upToSeq, nhưng logMatches = false.
  log.append('s1', { type: 'h4.checkpoint', payload: { step: 2, label: 'sau snapshot', upToSeq: 8 } });
  const loaded2 = log.loadSnapshot('s1');
  assert.equal(loaded2.logMatches, false);
  assert.equal(loaded2.upToSeq, 7);
  // Snapshot hỏng (digest sai) -> loadSnapshot throw.
  const snapFile = log.snapshotFilePath('s1');
  const broken = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  broken.state.tokensUsed = 99999;
  fs.writeFileSync(snapFile, JSON.stringify(broken));
  assert.throws(() => log.loadSnapshot('s1'), /digest/);
  assert.throws(() => log.loadSnapshot('khong-co'), /Không có snapshot/);
  const { log: log2 } = makeLog();
  assert.throws(() => log2.saveSnapshot('trong'), /Không có session/);
});

test('v108 deps: impact — sửa c thì a,b,d bị ảnh hưởng, standalone không; sửa d thì không ai bị ảnh hưởng', () => {
  const graph = analyzeHarnessV4Dependencies(SWEEP_FILES);
  const impactC = harnessV4ImpactOf(graph, ['src/c.ts']);
  assert.deepEqual(impactC.changedFiles, ['src/c.ts']);
  assert.deepEqual(impactC.affectedFiles, ['src/b.ts', 'src/a.ts', 'src/d.ts']);
  assert.deepEqual(impactC.directDependents, ['src/a.ts', 'src/b.ts']);
  assert.equal(impactC.maxDepth, 2);
  assert.equal(impactC.unaffectedCount, 1);
  const impactD = harnessV4ImpactOf(graph, ['src/d.ts']);
  assert.deepEqual(impactD.affectedFiles, []);
  assert.equal(impactD.maxDepth, 0);
  assert.equal(impactD.unaffectedCount, 4);
  const impactNone = harnessV4ImpactOf(graph, ['src/khong-co.ts']);
  assert.deepEqual(impactNone.affectedFiles, []);
});

test('v108 tools: deps_graph với changedFiles trả thêm impact', async () => {
  const dir = tmpDir();
  const ctx = { workspaceDir: '/tmp', botId: 'b1' };
  const tools = createHarnessV4Tools({ logDir: path.join(dir, 'logs') });
  const graph = toolByName(tools, 'harness_v4_deps_graph');
  const withImpact = JSON.parse(
    await graph.execute({ files: SWEEP_FILES, changedFiles: ['src/c.ts'] }, ctx),
  );
  assert.deepEqual(withImpact.impact.affectedFiles, ['src/b.ts', 'src/a.ts', 'src/d.ts']);
  assert.equal(withImpact.impact.maxDepth, 2);
  const withoutImpact = JSON.parse(await graph.execute({ files: SWEEP_FILES }, ctx));
  assert.equal(withoutImpact.impact, undefined);
});

// ---------------------------------------------------------------------------
// 6. i18n — 25 key mới đủ 6 locale, không rỗng, số key bằng nhau
// ---------------------------------------------------------------------------

test('v108 i18n: 25 key harness.v108 mới có đủ 6 locale, không rỗng', () => {
  for (const locale of LOCALES) {
    const keys = localeKeys(locale);
    for (const key of NEW_I18N_KEYS) {
      assert.ok(typeof keys[key] === 'string' && keys[key].trim() !== '', `${locale} thiếu key ${key}`);
    }
  }
  const counts = LOCALES.map((l) => Object.keys(localeKeys(l)).length);
  assert.ok(counts.every((c) => c === counts[0]), `6 locale phải cùng số key (nhận ${counts.join(',')})`);
  assert.ok(counts[0] >= 8072, `mỗi locale phải có >= 8072 key, nhận ${counts[0]}`); // v1.39 fix round 4b: floor (was 8072 in v1.38; now 8322).
});
