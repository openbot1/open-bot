/**
 * Tests cho coding agent v17 — sandbox bwrap thật + tools + i18n +
 * agent end-to-end (v1.39, Đội T4).
 *
 * Chạy thật: probe sandbox + chạy lệnh thật trong box bwrap qua
 * BotBoxManager (bwrap có trên máy này; nếu môi trường thiếu bwrap thì
 * test assert fallback ghi rõ thay vì giả vờ cách ly), agent scripted
 * thật (plan + repo map + sandbox + verification), tools thật trên
 * tmpdir. Không gọi model/mạng.
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   npm run build --workspace=@open-bot/tools (scoped, trong worktree)
 *   node --test tests/coding-v17-sandbox-tools-i18n-v139.test.mjs
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
  CODING_V17_TOOLS,
  CODING_V17_TOOL_NAMES,
  createCodingV17Tools,
  createDefaultTools,
  isCodingV17ToolName,
} from '../packages/tools/dist/index.js';
import {
  CodingAgentV17,
  V17SandboxRunner,
  runV17Agent,
  v17CurrentUid,
  v17ProbeSandbox,
} from '../packages/core/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
const LOCALE_NAMES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

const CODING_V17_KEYS = [
  'codingV17.agent',
  'codingV17.critic',
  'codingV17.eval',
  'codingV17.evalGate',
  'codingV17.evalPassed',
  'codingV17.evalFailed',
  'codingV17.plan',
  'codingV17.planApproved',
  'codingV17.planMode',
  'codingV17.planRequired',
  'codingV17.repomap',
  'codingV17.repomapRank',
  'codingV17.review',
  'codingV17.reviewPassed',
  'codingV17.reviewFailed',
  'codingV17.sandbox',
  'codingV17.sandboxBwrap',
  'codingV17.sandboxFallback',
  'codingV17.settings',
  'codingV17.title',
  'codingV17.trajectory',
  'codingV17.trajectoryReplay',
  'codingV17.verification',
  'codingV17.verify',
];

function loadLocale(name) {
  return JSON.parse(readFileSync(join(localesDir, `${name}.json`), 'utf8'));
}

function tmpDir(prefix = 'open-bot-v17-sandbox-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Không chặn test.
  }
}

function getTool(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} phải tồn tại`);
  return tool;
}

async function runTool(tool, args, ctx) {
  return tool.execute(args, ctx);
}

function testCtx(workspaceDir) {
  return { workspaceDir };
}

test('sandbox probe: báo đúng isolation + bwrap + uid trên máy này', () => {
  const probe = v17ProbeSandbox();
  assert.equal(probe.platform, 'linux');
  // Máy này có bwrap 0.9.0 (đã xác minh khi làm task).
  assert.equal(probe.bwrapAvailable, true);
  assert.equal(probe.isolation, 'bwrap');
  // Máy này chạy dưới root (uid 0) — probe phải cảnh báo rõ điều đó
  // thay vì báo non-root; máy non-root thì khuyến nghị chạy bwrap non-root.
  if (probe.uid === 0) {
    assert.match(probe.recommendation, /root/);
  } else {
    assert.match(probe.recommendation, /non-root/);
  }
});

test('sandbox: mặc định TỪ CHỐI chạy khi host đang root (guard non-root)', async () => {
  const root = tmpDir();
  try {
    const runner = new V17SandboxRunner(root);
    if (v17CurrentUid() === 0) {
      await assert.rejects(() => runner.runShell('bot-guard', 'echo hi'), /uid 0/);
    } else {
      const run = await runner.runShell('bot-guard', 'echo hi', { timeoutMs: 30_000 });
      assert.equal(run.exitCode, 0);
      assert.equal(run.nonRoot, true);
    }
  } finally {
    cleanup(root);
  }
});

test('sandbox: chạy lệnh thật trong box bwrap (allowRoot tường minh trên máy root)', async () => {
  const root = tmpDir();
  try {
    // Máy này chạy dưới root nên test dùng allowRoot tường minh —
    // kết quả vẫn phải ghi rõ uid/nonRoot (không giấu việc chạy root).
    const runner = new V17SandboxRunner(root, { allowRoot: true });
    const run = await runner.runShell('bot-test', 'echo hello-v17; pwd', {
      timeoutMs: 30_000,
      cpuSeconds: 30,
      maxMemoryBytes: 512 * 1024 * 1024,
    });
    // Hợp đồng: hoặc cách ly thật bằng bwrap, hoặc fallback ghi rõ lý do.
    if (run.isolated) {
      assert.equal(run.isolation, 'bwrap');
      assert.equal(run.exitCode, 0);
      assert.match(run.stdout, /hello-v17/);
    } else {
      assert.equal(run.isolation, 'none');
      assert.ok(run.fallbackReason.length > 0, 'fallback phải ghi rõ lý do');
    }
    assert.equal(run.uid, v17CurrentUid());
    assert.equal(run.nonRoot, v17CurrentUid() !== 0);
    assert.equal(run.botId, 'bot-test');
  } finally {
    cleanup(root);
  }
});

test('sandbox: python thật trong box; giới hạn timeout kill lệnh treo', async () => {
  const root = tmpDir();
  try {
    const runner = new V17SandboxRunner(root, { allowRoot: true });
    const py = await runner.runPython('bot-py', 'print(40 + 2)');
    if (py.isolated) {
      assert.equal(py.exitCode, 0);
      assert.match(py.stdout, /42/);
    } else {
      assert.ok(py.fallbackReason.length > 0);
    }
    const slow = await runner.runShell('bot-py', 'sleep 30', { timeoutMs: 2000 });
    assert.equal(slow.timedOut, true);
    // botId sai định dạng -> throw rõ ràng.
    await assert.rejects(() => runner.run('../evil', 'echo hi'), /botId/);
    assert.throws(() => new V17SandboxRunner(''), /rootDir/);
  } finally {
    cleanup(root);
  }
});

test('sandbox: file ghi trong box workspace tồn tại sau khi chạy', async () => {
  const root = tmpDir();
  try {
    const runner = new V17SandboxRunner(root, { allowRoot: true });
    const workspaceDir = runner.ensureBox('bot-file', {});
    const run = await runner.runShell('bot-file', 'echo boxed > note.txt; cat note.txt', { timeoutMs: 30_000 });
    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /boxed/);
    assert.equal(fs.readFileSync(path.join(workspaceDir, 'note.txt'), 'utf8').trim(), 'boxed');
  } finally {
    cleanup(root);
  }
});

test('agent: phiên scripted đơn file chạy thật trong bwrap + verification presentable', async () => {
  const base = tmpDir('open-bot-v17-agent-');
  try {
    const agent = new CodingAgentV17({
      dataDir: path.join(base, 'data'),
      sandboxRootDir: path.join(base, 'boxes'),
      allowRoot: true,
    });
    const report = await agent.run({
      sessionId: 'agent-1',
      task: 'Tạo file hello.txt chứa hello',
      botId: 'bot-agent-1',
      steps: [
        { text: 'Ghi file hello', fileWrite: { path: 'hello.txt', content: 'hello\n', kind: 'create' } },
        { text: 'Kiểm tra file', bashCommand: 'grep -q hello hello.txt && echo CHECK-OK', isTest: true, done: true },
      ],
      repoFiles: new Map([
        ['src/index.ts', "import { helper } from './util';\n"],
        ['src/util.ts', 'export function helper() { return 1; }\n'],
      ]),
    });
    assert.equal(report.sessionId, 'agent-1');
    assert.deepEqual(report.filesChanged, ['hello.txt']);
    assert.ok(report.events >= 8);
    assert.ok(report.contextFiles.length > 0);
    assert.equal(report.trajectoryScore.verdict, 'approve');
    assert.equal(report.presentable, true);
    assert.equal(report.verification.allPassed, true);
    // Trajectory log đã ghi ra đĩa + replay được.
    const log = agent.loadTrajectory('agent-1');
    assert.equal(log.verify().ok, true);
    assert.equal(log.replay().files['hello.txt'], 'hello\n');
  } finally {
    cleanup(base);
  }
});

test('agent: task đa file bắt buộc Plan Mode — plan approved rồi mới build, eval gate chấm patch', async () => {
  const base = tmpDir('open-bot-v17-agent-');
  try {
    const report = await runV17Agent({
      sessionId: 'agent-2',
      task: 'Thêm 2 file',
      botId: 'bot-agent-2',
      steps: [
        { text: 'Ghi a', fileWrite: { path: 'a.txt', content: 'hello a\n', kind: 'create' } },
        { text: 'Ghi b', fileWrite: { path: 'b.txt', content: 'hello b\n', kind: 'create' }, done: true },
      ],
      dataDir: path.join(base, 'data'),
      sandboxRootDir: path.join(base, 'boxes'),
      evalTask: {
        id: 'task-ab',
        title: 'Cả 2 file chứa hello',
        startFiles: {},
        tests: [{ id: 'a-ok', command: 'grep -q hello a.txt && grep -q hello b.txt' }],
        determinismRuns: 1,
      },
    });
    assert.ok(report.plan, 'task đa file phải có plan');
    assert.equal(report.plan.status, 'done');
    assert.equal(report.plan.multiFile, true);
    assert.ok(report.eval, 'phải có eval report');
    assert.equal(report.eval.gatePassed, true);
    assert.equal(report.presentable, true);
    // Input sai -> throw rõ ràng, không chạy nửa vời.
    await assert.rejects(() => runV17Agent({
      sessionId: 'bad',
      task: '',
      botId: 'b',
      steps: [{ text: 'x' }],
      dataDir: path.join(base, 'data'),
      sandboxRootDir: path.join(base, 'boxes'),
    }), /task không được rỗng/);
  } finally {
    cleanup(base);
  }
});

test('tools: 9 coding_v17 tools trong ALL_TOOLS, không trùng tên, bind thay thế đúng chỗ', () => {
  assert.equal(CODING_V17_TOOLS.length, 9);
  assert.deepEqual([...CODING_V17_TOOL_NAMES], [
    'coding_v17_trajectory',
    'coding_v17_repomap',
    'coding_v17_eval',
    'coding_v17_critic',
    'coding_v17_review',
    'coding_v17_plan',
    'coding_v17_sandbox',
    'coding_v17_agent',
    'coding_v17_verify',
  ]);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'ALL_TOOLS không được trùng tên');
  for (const name of CODING_V17_TOOL_NAMES) {
    assert.ok(names.includes(name), `ALL_TOOLS thiếu ${name}`);
    assert.equal(isCodingV17ToolName(name), true);
  }
  assert.equal(isCodingV17ToolName('coding_v16_budget'), false);
  const base = tmpDir('open-bot-v17-tools-');
  try {
    const bound = createDefaultTools({ getCodingV17BaseDir: () => base });
    const boundNames = bound.map((t) => t.definition.name);
    assert.equal(new Set(boundNames).size, boundNames.length, 'bound tools không trùng tên');
    const idxAll = ALL_TOOLS.findIndex((t) => t.definition.name === 'coding_v17_trajectory');
    const idxBound = bound.findIndex((t) => t.definition.name === 'coding_v17_trajectory');
    assert.equal(idxBound, idxAll, 'bind thay thế đúng chỗ, không đổi thứ tự');
  } finally {
    cleanup(base);
  }
});

test('tools: trajectory + repomap + plan + review chạy thật trên tmpdir', async () => {
  const base = tmpDir('open-bot-v17-tools-');
  const ctx = testCtx(base);
  try {
    const tools = createCodingV17Tools(() => base);
    const traj = getTool(tools, 'coding_v17_trajectory');
    const appended = await runTool(traj, { sessionId: 't1', action: 'append', kind: 'prompt', payloadJson: '{"text":"hi"}' }, ctx);
    assert.match(appended, /Appended event #0/);
    const listed = await runTool(traj, { sessionId: 't1', action: 'list' }, ctx);
    assert.match(listed, /prompt: hi/);
    const verified = await runTool(traj, { sessionId: 't1', action: 'verify' }, ctx);
    assert.match(verified, /OK: 1 events/);
    const replayed = await runTool(traj, { sessionId: 't1', action: 'replay' }, ctx);
    assert.match(replayed, /1 events replayed/);
    const badAction = await runTool(traj, { sessionId: 't1', action: 'nope' }, ctx);
    assert.match(badAction, /Error: Unknown action/);

    const repomap = getTool(tools, 'coding_v17_repomap');
    const built = await runTool(repomap, {
      root: 'repo',
      action: 'build',
      filesJson: JSON.stringify({
        'src/index.ts': "import { helper } from './util';\n",
        'src/util.ts': 'export function helper() { return 1; }\n',
      }),
    }, ctx);
    assert.match(built, /Repo map v17/);
    assert.match(built, /src\/util\.ts/);
    const queried = await runTool(repomap, { root: 'repo', action: 'query', query: 'util', topK: 1 }, ctx);
    assert.match(queried, /src\/util\.ts/);

    const plan = getTool(tools, 'coding_v17_plan');
    const created = await runTool(plan, {
      action: 'create',
      taskId: 'task-9',
      task: 'Làm X',
      stepsJson: JSON.stringify([
        { title: 'Code', files: ['src/a.ts'] },
        { title: 'Test', files: ['tests/a.test.mjs'] },
      ]),
    }, ctx);
    assert.match(created, /Plan plan-task-9 tạo xong/);
    const gateFail = await runTool(plan, {
      action: 'check',
      filesJson: JSON.stringify(['src/a.ts', 'src/b.ts']),
    }, ctx);
    assert.match(gateFail, /Error: .*bắt buộc phải có plan/);
    const approved = await runTool(plan, { action: 'approve', planId: 'plan-task-9' }, ctx);
    assert.match(approved, /ĐÃ DUYỆT/);
    const gateOk = await runTool(plan, {
      action: 'check',
      planId: 'plan-task-9',
      filesJson: JSON.stringify(['src/a.ts', 'src/b.ts']),
    }, ctx);
    assert.match(gateOk, /Plan gate PASS/);

    const review = getTool(tools, 'coding_v17_review');
    const reviewed = await runTool(review, {
      patchJson: JSON.stringify({ 'src/a.ts': 'export const a = 1;\n' }),
    }, ctx);
    assert.match(reviewed, /Review skill: PASS/);
    const badReview = await runTool(review, {
      patchJson: JSON.stringify({ 'src/a.ts': 'const k = "sk-abcdefghijklmnop123456";\n' }),
    }, ctx);
    assert.match(badReview, /Review skill: FAIL/);
  } finally {
    cleanup(base);
  }
});

test('tools: sandbox probe + eval + verify chạy thật trên tmpdir', async () => {
  const base = tmpDir('open-bot-v17-tools-');
  const ctx = testCtx(base);
  try {
    const tools = createCodingV17Tools(() => base);
    const sandbox = getTool(tools, 'coding_v17_sandbox');
    const probed = await runTool(sandbox, { action: 'probe' }, ctx);
    assert.match(probed, /isolation=bwrap/);
    // Máy này chạy dưới root: tool từ chối mặc định, chỉ chạy khi
    // allowRoot tường minh — và kết quả phải ghi rõ ROOT.
    const refused = await runTool(sandbox, {
      action: 'run-shell',
      botId: 'bot-tool',
      command: 'echo no-run',
    }, ctx);
    if (v17CurrentUid() === 0) {
      assert.match(refused, /Error: .*uid 0/);
    }
    const ran = await runTool(sandbox, {
      action: 'run-shell',
      botId: 'bot-tool',
      command: 'echo tool-sandbox-ok',
      allowRoot: true,
    }, ctx);
    assert.match(ran, /tool-sandbox-ok/);
    assert.match(ran, /Isolation: (bwrap|none)/);
    if (v17CurrentUid() === 0) {
      assert.match(ran, /ROOT — cảnh báo/);
    }

    const evalTool = getTool(tools, 'coding_v17_eval');
    const evaled = await runTool(evalTool, {
      evalTaskJson: JSON.stringify({
        id: 'task-tool',
        title: 'Tool eval',
        startFiles: { 'hello.txt': 'hi\n' },
        tests: [{ id: 'has-hello', command: 'grep -q hello hello.txt' }],
        determinismRuns: 1,
      }),
      patchJson: JSON.stringify({ 'hello.txt': 'hello\n' }),
    }, ctx);
    assert.match(evaled, /gate PASS/);

    // Verify: trajectory rỗng -> lỗi rõ ràng (chưa có phiên).
    const verify = getTool(tools, 'coding_v17_verify');
    const empty = await runTool(verify, {
      sessionId: 'no-such-session',
      patchJson: JSON.stringify({ 'src/a.ts': 'export const a = 1;\n' }),
    }, ctx);
    assert.match(empty, /Error: Trajectory no-such-session rỗng/);
  } finally {
    cleanup(base);
  }
});

test('i18n: 24 keys codingV17.* có đủ ở cả 6 locale, số key bằng nhau', () => {
  const counts = {};
  for (const name of LOCALE_NAMES) {
    const locale = loadLocale(name);
    counts[name] = Object.keys(locale).length;
    for (const key of CODING_V17_KEYS) {
      assert.ok(
        typeof locale[key] === 'string' && locale[key].length > 0,
        `${name} thiếu key ${key}`,
      );
    }
  }
  const unique = new Set(Object.values(counts));
  assert.equal(unique.size, 1, `số key phải bằng nhau 6 locale: ${JSON.stringify(counts)}`);
  // Không hardcode tổng: các đội v139 khác thêm key của họ lên trên
  // (v139 fix round 2 — tổng [8096] cũ vỡ ngay khi gộp chung với T2/T5/T6).
  assert.ok(counts.en >= 8096, 'tổng phải phủ base 8072 + 24 key codingV17');
});
