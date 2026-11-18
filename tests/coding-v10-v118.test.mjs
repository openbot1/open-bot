/**
 * Tests cho coding agent v10 (v1.18, Đội T2): event-sourced session
 * (Action/Observation, hash chain, snapshot + replay, fork, pause/
 * resume persist), CodeAct execution (node/python/bash, allowlist +
 * denylist, timeout, cap output), repo map v10 (hierarchical
 * summaries, nén token, incremental, query symbol), edit strategies
 * (AST / search-replace / whole-file + scoring + commit atomic),
 * eval harness theo phiên bản agent (6 task mẫu, pass@k, bảng +
 * so sánh version), và agent v10 pipeline nối các lớp.
 *
 * Chạy thật (không mock git/node): git thật, `node`/`python3` thật,
 * file thật trong thư mục tạm; eval mẫu chạy harness v5/v9 thật.
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v10-v118.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CodingAgentV10,
  CodingV10Session,
  V10CodeActExecutor,
  V10RepoMap,
  applyV10Edit,
  compareV10EvalVersions,
  listV10EvalVersions,
  loadV10EvalSummary,
  renderV10AgentReport,
  renderV10RepoMapSummary,
  renderV10SessionReport,
  runV10EvalSuite,
  saveV10EvalReport,
  scriptedV10Agent,
  v10EvalVersionTable,
  v10FoldEvents,
  v10HashEvent,
  v10PlanEditCandidates,
  v10VerifyChain,
  V10_EVAL_SAMPLE_TASKS,
} from '../packages/core/dist/codingV10/index.js';
import {
  runV9EvalSuite,
  scriptedV9Agent,
} from '../packages/core/dist/codingV9/index.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function initGitRepo(dir) {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "v10-test@open-bot.local"', { cwd: dir });
  execSync('git config user.name "v10-test"', { cwd: dir });
}

const GREET_TS = `export function greet(name: string): string {
  return 'hello';
}

export function shout(word: string): string {
  return word.toUpperCase();
}
`;

const GREET_TS_FIXED = `export function greet(name: string): string {
  return 'hello ' + name;
}

export function shout(word: string): string {
  return word.toUpperCase();
}
`;

/* ==================== 1. event-sourced session ==================== */

test('v10 session: start/record/fold state + snapshot + replay digest match', () => {
  const sessionsDir = tmpDir('v10-session-');
  const session = new CodingV10Session({ sessionsDir, workingDir: '/tmp', title: 'test session' });
  session.start();
  session.recordAction('plan', { task: 'fix greet', editCount: 1 });
  session.recordObservation('edit-result', { path: 'src/util.ts', strategy: 'ast', linesAdded: 1, linesRemoved: 1 });
  session.recordObservation('codeact-result', { status: 'ok' });
  session.recordObservation('commit-result', { shortSha: 'abc1234', files: ['src/util.ts'] });
  const snap = session.snapshot();
  const state = session.state();
  assert.equal(state.status, 'running');
  assert.equal(state.actionCount, 2); // session.started + plan
  assert.equal(state.observationCount, 3);
  assert.deepEqual(state.filesChanged, ['src/util.ts']);
  assert.deepEqual(state.commits, ['abc1234']);
  assert.equal(state.codeActRuns, 1);
  assert.equal(state.codeActPassed, 1);
  assert.equal(snap.atSeq, state.lastSeq);
  const replayed = session.replay();
  assert.equal(replayed.verification.ok, true);
  assert.equal(replayed.verification.checked, state.eventCount);
  assert.deepEqual(replayed.state, state);
  assert.equal(replayed.snapshotMatches, true);
});

test('v10 session: hash chain breaks when a log line is tampered', () => {
  const sessionsDir = tmpDir('v10-session-tamper-');
  const session = new CodingV10Session({ sessionsDir, workingDir: '/tmp' });
  session.start();
  session.recordAction('plan', { task: 'x', editCount: 0 });
  const logPath = session.logPath();
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.payload.task = 'tampered!';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
  const reopened = CodingV10Session.open(sessionsDir, session.sessionId, '/tmp');
  assert.throws(() => reopened.replay(), /Hash chain đứt|event-chain-broken/);
  const events = reopened.readEvents().events;
  assert.equal(v10VerifyChain(events).ok, false);
});

test('v10 session: pause/resume persist + resume continues at same seq', () => {
  const sessionsDir = tmpDir('v10-session-pause-');
  const session = new CodingV10Session({ sessionsDir, workingDir: '/tmp' });
  session.start();
  session.recordAction('plan', { task: 'x', editCount: 1 });
  session.pause('waiting for user');
  assert.equal(session.isPaused(), true);
  assert.equal(session.state().status, 'paused');
  assert.equal(session.state().pauseCount, 1);
  assert.throws(() => session.pause(), /đã paused/);
  // Reopen from disk: paused state survives (persisted).
  const reopened = CodingV10Session.open(sessionsDir, session.sessionId, '/tmp');
  assert.equal(reopened.isPaused(), true);
  reopened.resume('user approved');
  assert.equal(reopened.isPaused(), false);
  assert.equal(reopened.state().resumeCount, 1);
  assert.throws(() => reopened.resume(), /không ở trạng thái paused/);
});

test('v10 session: fork at seq copies prefix, child replay verifies', () => {
  const sessionsDir = tmpDir('v10-session-fork-');
  const session = new CodingV10Session({ sessionsDir, workingDir: '/tmp' });
  session.start();
  session.recordAction('plan', { task: 'x', editCount: 1 });
  session.recordObservation('edit-result', { path: 'a.ts', strategy: 'ast' });
  session.recordAction('codeact-run', { kind: 'node', codePreview: 'console.log(1)' });
  const forked = session.fork(3);
  assert.equal(forked.fromSeq, 3);
  assert.equal(forked.copiedEvents, 3);
  const child = CodingV10Session.open(sessionsDir, forked.sessionId, '/tmp');
  const replayed = child.replay();
  assert.equal(replayed.verification.ok, true);
  // Child has prefix (3) + fork event = 4 events; parent keeps 4 + fork-created = 5.
  assert.equal(child.state().eventCount, 4);
  assert.equal(child.state().parentSessionId, session.sessionId);
  assert.equal(child.state().forkFromSeq, 3);
  assert.throws(() => session.fork(99), /không hợp lệ/);
  assert.throws(() => session.fork(0), /không hợp lệ/);
});

test('v10 session: complete + listSessions + open unknown throws', () => {
  const sessionsDir = tmpDir('v10-session-list-');
  const a = new CodingV10Session({ sessionsDir, workingDir: '/tmp', sessionId: 'sess-a' });
  a.start();
  a.complete('done');
  assert.equal(a.state().status, 'completed');
  assert.deepEqual(CodingV10Session.listSessions(sessionsDir), ['sess-a']);
  assert.throws(() => CodingV10Session.open(sessionsDir, 'nope', '/tmp'), /Không tìm thấy session/);
});

test('v10 fold/hash helpers: deterministic hash + fold of empty log', () => {
  const event = {
    seq: 1,
    sessionId: 's',
    at: '2026-11-16T00:00:00.000Z',
    kind: 'action',
    type: 'session.started',
    payload: { title: 't' },
    prevHash: '',
  };
  assert.equal(v10HashEvent(event), v10HashEvent(event));
  const state = v10FoldEvents('s', '/tmp', 't', []);
  assert.equal(state.eventCount, 0);
  assert.equal(state.status, 'running');
});

/* ==================== 2. CodeAct execution ==================== */

test('v10 codeact: node ok captures stdout + exit 0', async () => {
  const dir = tmpDir('v10-codeact-node-');
  const executor = new V10CodeActExecutor({ workingDir: dir });
  const result = await executor.run({ kind: 'node', code: 'console.log("hello v10"); console.log(40 + 2);' });
  assert.equal(result.status, 'ok');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello v10/);
  assert.match(result.stdout, /42/);
  assert.equal(result.timedOut, false);
});

test('v10 codeact: python ok + bash echo ok', async () => {
  const dir = tmpDir('v10-codeact-py-');
  const executor = new V10CodeActExecutor({ workingDir: dir });
  const py = await executor.run({ kind: 'python', code: 'print(6 * 7)' });
  assert.equal(py.status, 'ok');
  assert.match(py.stdout, /42/);
  const sh = await executor.run({ kind: 'bash', code: 'echo hello-bash' });
  assert.equal(sh.status, 'ok');
  assert.match(sh.stdout, /hello-bash/);
});

test('v10 codeact: failing code returns failed with stderr, not throw', async () => {
  const dir = tmpDir('v10-codeact-fail-');
  const executor = new V10CodeActExecutor({ workingDir: dir });
  const result = await executor.run({ kind: 'node', code: 'throw new Error("boom-v10");' });
  assert.equal(result.status, 'failed');
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /boom-v10/);
});

test('v10 codeact: denylist blocks rm -rf / and unknown commands', async () => {
  const dir = tmpDir('v10-codeact-deny-');
  const executor = new V10CodeActExecutor({ workingDir: dir });
  const rm = await executor.run({ kind: 'bash', code: 'rm -rf /' });
  assert.equal(rm.status, 'denied');
  assert.equal(rm.exitCode, null);
  const unknown = await executor.run({ kind: 'bash', code: 'curl https://example.com' });
  assert.equal(unknown.status, 'denied');
  assert.match(unknown.reason ?? '', /not in the CodeAct allowlist/);
});

test('v10 codeact: timeout kills long-running code', async () => {
  const dir = tmpDir('v10-codeact-timeout-');
  const executor = new V10CodeActExecutor({ workingDir: dir });
  const result = await executor.run({
    kind: 'node',
    code: 'setTimeout(() => console.log("too late"), 10000);',
    timeoutMs: 500,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});

test('v10 codeact: output is truncated to the limit', async () => {
  const dir = tmpDir('v10-codeact-trunc-');
  const executor = new V10CodeActExecutor({ workingDir: dir, outputLimit: 100 });
  const result = await executor.run({ kind: 'node', code: 'console.log("x".repeat(5000));' });
  assert.equal(result.status, 'ok');
  assert.ok(result.stdout.length < 5000);
  assert.match(result.stdout, /truncated/);
});

/* ==================== 3. repo map v10 ==================== */

function makeRepo() {
  const dir = tmpDir('v10-repomap-');
  writeFile(dir, 'src/util.ts', `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function greet(name: string): string {\n  return 'hello ' + name;\n}\n`);
  writeFile(dir, 'src/main.ts', `import { add, greet } from './util';\n\nexport function main(): void {\n  console.log(add(1, 2), greet('An'));\n}\n`);
  writeFile(dir, 'lib/helper.py', `def shout(word):\n    return word.upper()\n`);
  return dir;
}

test('v10 repomap: hierarchical summaries module -> file -> symbol', () => {
  const dir = makeRepo();
  const map = new V10RepoMap(dir);
  const built = map.scanAndBuild();
  assert.equal(built.fileCount, 3);
  assert.ok(built.symbolCount >= 4);
  assert.ok(built.moduleCount >= 2);
  const src = built.modules.find((m) => m.dir === 'src');
  assert.ok(src);
  assert.equal(src.files.length, 2);
  const util = src.files.find((f) => f.path === 'src/util.ts');
  assert.ok(util);
  assert.ok(util.symbols.some((s) => s.qualifiedName === 'add'));
  assert.ok(util.symbols.some((s) => s.qualifiedName === 'greet'));
  assert.ok(util.summary.includes('src/util.ts'));
  assert.ok(built.totalTokenEstimate > 0);
});

test('v10 repomap: render under budget compresses low-rank symbols first', () => {
  const dir = makeRepo();
  const map = new V10RepoMap(dir);
  map.scanAndBuild();
  const full = map.render(100000);
  assert.equal(full.compressed, false);
  assert.equal(full.symbolsKept, full.symbolsTotal);
  const tiny = map.render(20);
  assert.equal(tiny.compressed, true);
  assert.ok(tiny.tokenEstimate <= 60);
  assert.ok(tiny.symbolsKept < tiny.symbolsTotal);
  assert.match(renderV10RepoMapSummary(full), /repo map:/);
});

test('v10 repomap: querySymbol exact beats prefix beats substring', () => {
  const dir = makeRepo();
  const map = new V10RepoMap(dir);
  map.scanAndBuild();
  const exact = map.querySymbol('greet');
  assert.equal(exact.hits[0].qualifiedName, 'greet');
  assert.equal(exact.hits[0].file, 'src/util.ts');
  assert.ok(exact.hits[0].reasons.includes('exact match'));
  const prefix = map.querySymbol('gre');
  assert.ok(prefix.hits.some((h) => h.qualifiedName === 'greet'));
  const none = map.querySymbol('zzz-no-such-symbol');
  assert.equal(none.hits.length, 0);
  assert.throws(() => map.querySymbol(''), /rỗng/);
});

test('v10 repomap: incremental update reparses only changed files', () => {
  const dir = makeRepo();
  const map = new V10RepoMap(dir);
  map.scanAndBuild();
  writeFile(dir, 'src/util.ts', `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function greet(name: string): string {\n  return 'hello ' + name;\n}\n\nexport function extra(): number {\n  return 1;\n}\n`);
  const updated = map.updateFiles(['src/util.ts', 'src/main.ts', 'lib/helper.py']);
  const last = map.lastUpdate();
  assert.ok(last);
  assert.deepEqual(last.reparsed, ['src/util.ts']);
  assert.deepEqual(last.reused.sort(), ['lib/helper.py', 'src/main.ts']);
  assert.equal(last.summariesRebuilt, 1);
  assert.equal(last.summariesReused, 2);
  const hit = map.querySymbol('extra');
  assert.equal(hit.hits[0].qualifiedName, 'extra');
  assert.equal(updated.fileCount, 3);
});

test('v10 repomap: summary cache persists to disk and reloads', () => {
  const dir = makeRepo();
  const map = new V10RepoMap(dir);
  map.scanAndBuild();
  const cachePath = path.join(tmpDir('v10-repomap-cache-'), 'summaries.json');
  map.saveSummaries(cachePath);
  assert.ok(fs.existsSync(cachePath));
  const map2 = new V10RepoMap(dir);
  assert.equal(map2.loadSummaries(cachePath), 3);
  assert.equal(map2.loadSummaries(path.join(dir, 'nope.json')), 0);
  // Wrong rootDir: cache is rejected.
  const other = new V10RepoMap(tmpDir('v10-repomap-other-'));
  assert.equal(other.loadSummaries(cachePath), 0);
  // Reloaded summaries are reused on update (no rebuild) — needs the
  // v8 parse cache too, otherwise v8 re-parses and summaries rebuild.
  const parseCachePath = path.join(tmpDir('v10-repomap-cache-'), 'parse.json');
  map.saveCache(parseCachePath);
  assert.equal(map2.loadCache(parseCachePath), 3);
  map2.updateFiles(['src/util.ts', 'src/main.ts', 'lib/helper.py']);
  const last = map2.lastUpdate();
  assert.ok(last);
  assert.equal(last.summariesRebuilt, 0);
  assert.equal(last.summariesReused, 3);
});

test('v10 helpers: codeact validation + first-command parsing', async () => {
  const { validateV10CodeActRequest, v10FirstCommand } = await import(
    '../packages/core/dist/codingV10/index.js'
  );
  assert.equal(v10FirstCommand('/usr/bin/git status'), 'git');
  assert.equal(v10FirstCommand('  python3 -u script.py'), 'python3');
  assert.throws(() => validateV10CodeActRequest({ kind: 'node', code: '  ' }), /rỗng/);
  assert.throws(
    () => validateV10CodeActRequest({ kind: 'node', code: 'x'.repeat(100001) }),
    /vượt giới hạn/,
  );
  validateV10CodeActRequest({ kind: 'bash', code: 'echo hi' });
});

test('v10 repomap: queryText returns PageRank file hits with summaries', () => {
  const dir = makeRepo();
  const map = new V10RepoMap(dir);
  map.scanAndBuild();
  const hits = map.queryText('greet');
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].path.includes('util.ts') || hits[0].path.includes('main.ts'));
  assert.ok(typeof hits[0].summary === 'string');
  const fresh = new V10RepoMap(dir);
  assert.throws(() => fresh.render(), /chưa build/);
  assert.throws(() => fresh.querySymbol('add'), /chưa build/);
});

/* ==================== 4. edit strategies ==================== */

test('v10 edit: AST strategy wins for symbol replace (highest score)', async () => {
  const dir = tmpDir('v10-edit-ast-');
  writeFile(dir, 'src/util.ts', GREET_TS);
  const result = await applyV10Edit(
    {
      operation: {
        kind: 'replace-symbol',
        path: 'src/util.ts',
        symbolName: 'greet',
        newText: `export function greet(name: string): string {\n  return 'hello ' + name;\n}`,
      },
    },
    { workingDir: dir },
  );
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'ast');
  assert.equal(result.usedFallback, false);
  assert.ok(result.score >= 90);
  assert.ok(result.candidates.some((c) => c.strategy === 'ast' && c.applicable));
  const content = fs.readFileSync(path.join(dir, 'src/util.ts'), 'utf8');
  assert.match(content, /hello ' \+ name/);
});

test('v10 edit: search-replace applies when AST cannot find the symbol', async () => {
  const dir = tmpDir('v10-edit-sr-');
  writeFile(dir, 'note.txt', 'alpha\nbeta\ngamma\n');
  // kind replace-symbol on a missing symbol: AST candidate is not
  // applicable, so the selector falls to search-replace (oldBlock).
  const result = await applyV10Edit(
    {
      operation: {
        kind: 'replace-symbol',
        path: 'note.txt',
        symbolName: 'missing-symbol',
        oldBlock: 'beta',
        newBlock: 'BETA-2',
      },
    },
    { workingDir: dir },
  );
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'search-replace');
  assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'alpha\nBETA-2\ngamma\n');
});

test('v10 edit: whole-file fallback rewrites file when forced', async () => {
  const dir = tmpDir('v10-edit-wf-');
  writeFile(dir, 'src/util.ts', GREET_TS);
  const result = await applyV10Edit(
    {
      operation: { kind: 'replace-symbol', path: 'src/util.ts', symbolName: 'nope-missing' },
      newContent: GREET_TS_FIXED,
      forceStrategy: 'whole-file',
    },
    { workingDir: dir },
  );
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'whole-file');
  assert.equal(fs.readFileSync(path.join(dir, 'src/util.ts'), 'utf8'), GREET_TS_FIXED);
});

test('v10 edit: forced AST that fails falls back + whole-file verify failure restores file', async () => {
  const dir = tmpDir('v10-edit-fb-');
  writeFile(dir, 'src/util.ts', GREET_TS);
  // Force AST on a missing symbol: AST inapplicable -> fallback to whole-file.
  const result = await applyV10Edit(
    {
      operation: { kind: 'replace-symbol', path: 'src/util.ts', symbolName: 'nope-missing' },
      newContent: GREET_TS_FIXED,
      forceStrategy: 'ast',
    },
    { workingDir: dir },
  );
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'whole-file');
  assert.equal(result.usedFallback, true);
  // Whole-file with broken syntax: verify fails, file restored.
  await assert.rejects(
    applyV10Edit(
      {
        operation: { kind: 'replace-symbol', path: 'src/util.ts', symbolName: 'greet' },
        newContent: 'export function broken( {',
        forceStrategy: 'whole-file',
      },
      { workingDir: dir },
    ),
    /verify fail/,
  );
  assert.equal(fs.readFileSync(path.join(dir, 'src/util.ts'), 'utf8'), GREET_TS_FIXED);
});

test('v10 edit: no applicable strategy throws edit-no-strategy', async () => {
  const dir = tmpDir('v10-edit-none-');
  writeFile(dir, 'src/util.ts', GREET_TS);
  await assert.rejects(
    applyV10Edit(
      { operation: { kind: 'replace-symbol', path: 'src/util.ts', symbolName: 'nope-missing' } },
      { workingDir: dir },
    ),
    /Không có chiến lược/,
  );
  const candidates = v10PlanEditCandidates(
    { operation: { kind: 'replace-symbol', path: 'src/util.ts', symbolName: 'greet', newText: 'export function greet(): string {\n  return "x";\n}' } },
    { workingDir: dir },
  );
  assert.equal(candidates.length, 3);
  assert.ok(candidates.some((c) => c.strategy === 'ast' && c.applicable));
});

test('v10 edit: commit atomic + onEvent callback records edit-result', async () => {
  const dir = tmpDir('v10-edit-commit-');
  initGitRepo(dir);
  writeFile(dir, 'src/util.ts', GREET_TS);
  execSync('git add -A && git commit -qm "init"', { cwd: dir });
  const events = [];
  const result = await applyV10Edit(
    {
      operation: {
        kind: 'replace-symbol',
        path: 'src/util.ts',
        symbolName: 'greet',
        newText: `export function greet(name: string): string {\n  return 'hello ' + name;\n}`,
      },
      commit: true,
      commitSummary: 'v10 test edit',
    },
    { workingDir: dir, onEvent: (e) => events.push(e) },
  );
  assert.equal(result.ok, true);
  assert.ok(result.commitSha);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'edit-result');
  const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf8' });
  assert.match(log, /v10 test edit/);
});

/* ==================== 5. eval harness theo version ==================== */

test('v10 eval: 6 sample tasks, scripted agent passes 5/6 (pass@k 5/6)', async () => {
  assert.equal(V10_EVAL_SAMPLE_TASKS.length, 6);
  const { report } = await runV10EvalSuite(scriptedV10Agent, { agentVersion: 'v10', attemptsPerTask: 1 });
  assert.equal(report.taskCount, 6);
  assert.equal(report.tasksPassed, 5);
  assert.equal(report.passAtK, 5 / 6);
  const sort = report.tasks.find((t) => t.taskId === 'v9-eval-sort');
  assert.equal(sort.anyPass, false);
}, { timeout: 120000 });

test('v10 eval: versioned store + table + compare across versions', async () => {
  const evalDir = tmpDir('v10-eval-versions-');
  const { report: reportV10 } = await runV10EvalSuite(scriptedV10Agent, { agentVersion: 'v10', attemptsPerTask: 1 });
  const savedV10 = saveV10EvalReport(reportV10, 'v10', evalDir);
  assert.ok(fs.existsSync(savedV10.detailFile));
  assert.ok(fs.existsSync(savedV10.summaryFile));
  assert.equal(savedV10.summary.passAtK, 5 / 6);
  // v9 scripted agent on the same 6 tasks: only add + greet pass (2/6).
  const legacy = await runV9EvalSuite(V10_EVAL_SAMPLE_TASKS, scriptedV9Agent, { attemptsPerTask: 1, suiteName: 'coding-v10-sample' });
  const savedV9 = saveV10EvalReport(legacy, 'v9', evalDir);
  assert.equal(savedV9.summary.tasksPassed, 2);
  assert.deepEqual(listV10EvalVersions(evalDir), ['v10', 'v9']); // sorted() lexicographic: 'v10' < 'v9'
  const loaded = loadV10EvalSummary(evalDir, 'v10');
  assert.equal(loaded.agentVersion, 'v10');
  const rows = v10EvalVersionTable(evalDir);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.agentVersion === 'v10').best, true);
  assert.equal(rows.find((r) => r.agentVersion === 'v9').best, false);
  const cmp = compareV10EvalVersions(evalDir, 'v9', 'v10');
  assert.ok(cmp.passAtKDelta > 0);
  assert.ok(cmp.changedTasks.some((c) => c.taskId === 'v10-eval-dedupe' && c.newerAnyPass));
  assert.throws(() => compareV10EvalVersions(evalDir, 'v9', 'nope'), /Không có báo cáo/);
}, { timeout: 180000 });

/* ==================== 6. agent v10 pipeline ==================== */

test('v10 agent: plan -> edit -> verify -> commit -> snapshot, all events logged', async () => {
  const dir = tmpDir('v10-agent-');
  const sessionsDir = tmpDir('v10-agent-sessions-');
  initGitRepo(dir);
  writeFile(dir, 'util.mjs', `export function greet(name) {\n  return 'hello';\n}\n`);
  writeFile(dir, 'test.mjs', `import { greet } from './util.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(greet('An'), 'hello An');\n`);
  execSync('git add -A && git commit -qm "init"', { cwd: dir });
  const agent = new CodingAgentV10({
    workingDir: dir,
    sessionsDir,
    planProvider: () => [
      {
        operation: {
          kind: 'replace-symbol',
          path: 'util.mjs',
          symbolName: 'greet',
          newText: `export function greet(name) {\n  return 'hello ' + name;\n}`,
        },
      },
    ],
    verifyCommands: [['node', 'test.mjs']],
    summary: 'fix greet',
  });
  const report = await agent.runTask('fix greet', 'greet should include the name');
  assert.equal(report.ok, true);
  assert.equal(report.edits.length, 1);
  assert.equal(report.edits[0].strategy, 'ast');
  assert.ok(report.commit);
  assert.ok(report.snapshot);
  assert.equal(fs.readFileSync(path.join(dir, 'util.mjs'), 'utf8').includes("hello ' + name"), true);
  const session = CodingV10Session.open(sessionsDir, report.sessionId, dir);
  const state = session.state();
  assert.equal(state.status, 'completed');
  assert.ok(state.eventCount >= 6);
  assert.deepEqual(state.filesChanged, ['util.mjs']);
  assert.equal(state.commits.length, 1);
  const replayed = session.replay();
  assert.equal(replayed.verification.ok, true);
  assert.match(renderV10AgentReport(report), /coding agent v10/);
  assert.match(renderV10SessionReport(state), /session /);
}, { timeout: 120000 });

test('v10 agent: codeact step runs before verify; paused agent stops before edit', async () => {
  const dir = tmpDir('v10-agent-pause-');
  const sessionsDir = tmpDir('v10-agent-pause-sessions-');
  initGitRepo(dir);
  writeFile(dir, 'util.mjs', `export function greet(name) {\n  return 'hello';\n}\n`);
  execSync('git add -A && git commit -qm "init"', { cwd: dir });
  const agent = new CodingAgentV10({
    workingDir: dir,
    sessionsDir,
    planProvider: () => [
      {
        operation: {
          kind: 'replace-symbol',
          path: 'util.mjs',
          symbolName: 'greet',
          newText: `export function greet(name) {\n  return 'hello ' + name;\n}`,
        },
      },
    ],
    codeActRequests: [{ kind: 'node', code: 'console.log("codeact-ok");' }],
    verifyCommands: [['node', '--check', 'util.mjs']],
    autoCommit: false,
  });
  const report = await agent.runTask('codeact task', 'run codeact then verify');
  assert.equal(report.ok, true);
  assert.equal(report.codeActResults.length, 1);
  assert.equal(report.codeActResults[0].status, 'ok');
  assert.match(report.codeActResults[0].stdout, /codeact-ok/);

  // Paused agent: plan runs, then stops before edit (file unchanged).
  // NOTE: fresh repo — the first agent above already fixed util.mjs
  // in `dir`, so a shared dir cannot prove "unchanged".
  const dir2 = tmpDir('v10-agent-pause-2-');
  const sessionsDir2 = tmpDir('v10-agent-pause-sessions-2-');
  initGitRepo(dir2);
  writeFile(dir2, 'util.mjs', `export function greet(name) {\n  return 'hello';\n}\n`);
  execSync('git add -A && git commit -qm "init"', { cwd: dir2 });
  const agent2 = new CodingAgentV10({
    workingDir: dir2,
    sessionsDir: sessionsDir2,
    planProvider: () => [
      {
        operation: {
          kind: 'replace-symbol',
          path: 'util.mjs',
          symbolName: 'greet',
          newText: `export function greet(name) {\n  return 'hello ' + name;\n}`,
        },
      },
    ],
    autoCommit: false,
  });
  agent2.pause('test pause');
  const report2 = await agent2.runTask('paused task', 'should stop before edit');
  assert.equal(report2.ok, false);
  assert.equal(report2.edits.length, 0);
  assert.equal(fs.readFileSync(path.join(dir2, 'util.mjs'), 'utf8').includes("hello ' + name"), false);
  agent2.resume('test resume');
  assert.equal(agent2.session.isPaused(), false);
}, { timeout: 120000 });
