/**
 * Harbor eval runner (v1.11, Đội T2).
 *
 * Chạy một Harbor task (xem harborTask.ts) trong sandbox box
 * (BotBoxManager — loopback-only, bwrap/unshare khi có, chạy
 * thường + báo rõ khi không có cách ly; KHÔNG bao giờ giả vờ đã
 * cách ly):
 *
 *   1. tạo box riêng cho task (`eval-<taskId>`, workspace reset);
 *   2. copy environment/ của task vào workspace của box;
 *   3. gọi agent executor (do host cung cấp — runner KHÔNG gọi
 *      model trực tiếp, nên chạy được với mọi model: executor tự
 *      quyết định model/profile nào chạy, runner chỉ ghi lại);
 *   4. chạy tests/test.sh trong box, parse PASS/FAIL, tính reward
 *      theo trọng số (điểm test = reward);
 *   5. ghi rollout (prompt, tool call, kết quả, reward) ra JSONL
 *      để user fine-tune local (xem rollout.ts).
 *
 * Executor là một hàm host cung cấp — mặc định KHÔNG có executor
 * (runner báo lỗi rõ thay vì giả vờ agent đã chạy). Tool/UI phải
 * bind executor thật (vd executor chạy script của agent, hoặc
 * executor "no-op" chỉ để kiểm tra test.sh). Executor nhận
 * instruction + workspace của box và trả về transcript các turn +
 * token dùng; runner không diễn giải nội dung turn ngoài việc ghi
 * lại — executor chịu trách nhiệm gọi model/tool thật.
 *
 * Suite = chạy tuần tự nhiều task (1 task một lúc — máy 1,5 CPU
 * không gánh được chạy song song sandbox nặng), gom báo cáo tổng
 * hợp (pass rate, reward trung bình, thời gian, token).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { BotBoxManager } from '../sandbox/box';
import type { BoxRunResult } from '../sandbox/types';
import {
  parseHarborTestOutput,
  scoreHarborTests,
  validateHarborTask,
  type HarborTask,
} from './harborTask';
import {
  ROLLOUT_SCHEMA,
  sumRolloutUsage,
  type RolloutRecord,
  type RolloutTestResult,
  type RolloutTurn,
} from './rollout';

/** Kết quả chạy test.sh của một task (đã parse). */
export interface HarborTestRun {
  /** Exit code của test.sh (0 = mọi test pass theo script). */
  exitCode: number | null;
  /** Reward = trọng số pass / tổng trọng số. */
  reward: number;
  /** Số test pass / tổng số test. */
  passedCount: number;
  totalCount: number;
  /** Chi tiết từng test. */
  perTest: RolloutTestResult[];
  /** Log thô của test.sh (đã cắt ngắn) để debug. */
  output: string;
  /** true khi test.sh timeout. */
  timedOut: boolean;
}

/** Kết quả chạy một Harbor task (một rollout). */
export interface HarborRunResult {
  rolloutId: string;
  taskId: string;
  taskVersion: number;
  profileId: string;
  model: { provider: string; model: string };
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** true khi reward == 1 (mọi test pass). */
  passed: boolean;
  reward: number;
  testRun: HarborTestRun;
  /** Transcript đầy đủ của agent (để ghi rollout JSONL). */
  turns: RolloutTurn[];
  /** Token dùng (cộng từ turns). */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Mức cách ly thật của box khi chạy. */
  isolation: string;
  /** Lỗi chạy (setup box, executor throw...) — null khi chạy bình thường. */
  error: string | null;
  /** Rollout record tương ứng (sẵn sàng ghi JSONL). */
  rollout: RolloutRecord;
}

/** Ngữ cảnh executor nhận được khi chạy một task. */
export interface HarborAgentContext {
  task: HarborTask;
  /** Thư mục workspace trong box (agent làm việc tại đây). */
  workspaceDir: string;
  /** System prompt đã ghép profile (executor dùng làm system). */
  systemPrompt: string;
  /** Id profile đang dùng ('' khi không dùng profile). */
  profileId: string;
  /** Model executor nên dùng ('' = executor tự chọn). */
  model: { provider: string; model: string };
  /** Hạn chót (ms epoch) — executor nên dừng trước thời điểm này. */
  deadlineMs: number;
}

/**
 * Agent executor: chạy agent trên một task, trả về transcript.
 * Executor TỰ gọi model/tool (qua agent loop của host) và TỰ ghi
 * turn vào mảng trả về; runner chỉ ghi lại, không gọi model.
 * Executor ném lỗi khi agent lỗi — runner bắt thành run lỗi.
 */
export type HarborAgentExecutor = (ctx: HarborAgentContext) => Promise<{
  turns: RolloutTurn[];
}>;

export interface HarborRunnerOptions {
  /** Thư mục gốc chứa boxes (mặc định `<baseDir>/boxes` qua BotBoxManager). */
  baseDir: string;
  /** Executor chạy agent (bắt buộc để chạy task thật). */
  executor?: HarborAgentExecutor;
  /** Timeout chạy test.sh (mặc định 60_000 ms). */
  testTimeoutMs?: number;
  /** Giữ lại workspace box sau khi chạy (mặc định false = dọn box). */
  keepBox?: boolean;
}

export const HARBOR_RUN_REPORTS_DIR = 'eval-harbor-reports';
export const HARBOR_DEFAULT_TEST_TIMEOUT_MS = 60_000;

/** BotId dùng cho box của một task (chỉ ký tự an toàn cho tên thư mục). */
export function harborBoxBotId(taskId: string): string {
  return `eval-${taskId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

/** Một executor "no-op": không làm gì cả — dùng để kiểm tra test.sh và đo baseline. */
export async function noopHarborExecutor(): Promise<{ turns: RolloutTurn[] }> {
  return { turns: [] };
}

/** Một executor ghi file: mô phỏng agent bằng cách ghi các file cho trước vào workspace. */
export function scriptedHarborExecutor(
  files: Record<string, string>,
): HarborAgentExecutor {
  return async (ctx) => {
    const turns: RolloutTurn[] = [];
    for (const [relativePath, content] of Object.entries(files)) {
      const dest = path.join(ctx.workspaceDir, relativePath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf-8');
      turns.push({
        index: turns.length,
        role: 'assistant',
        content: `Wrote ${relativePath}.`,
        toolCalls: [{ name: 'write_file', arguments: { path: relativePath, content } }],
        toolResults: [],
        promptTokens: 0,
        completionTokens: 0,
      });
    }
    return { turns };
  };
}

/** Ghi environment/ của task vào workspace của box (ghi đè file cùng tên). */
export function stageHarborEnvironment(task: HarborTask, workspaceDir: string): void {
  for (const file of task.environment) {
    const dest = path.join(workspaceDir, file.relativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.content, 'utf-8');
  }
}

/** Cắt output dài để lưu báo cáo (giữ đầu + cuối, bỏ giữa). */
export function truncateHarborOutput(output: string, maxChars = 8_000): string {
  if (output.length <= maxChars) return output;
  const head = Math.floor(maxChars / 2);
  const tail = maxChars - head;
  return `${output.slice(0, head)}\n...[truncated ${output.length - maxChars} chars]...\n${output.slice(-tail)}`;
}

/** Thư mục lưu báo cáo Harbor run trong một thư mục dữ liệu. */
export function getHarborReportsDir(baseDir: string): string {
  return path.join(baseDir, HARBOR_RUN_REPORTS_DIR);
}

/** Chạy test.sh trong box và parse kết quả thành HarborTestRun. */
export async function runHarborTestsInBox(
  boxManager: BotBoxManager,
  botId: string,
  task: HarborTask,
  timeoutMs: number,
): Promise<{ testRun: HarborTestRun; boxResult: BoxRunResult }> {
  const box = boxManager.getBox(botId);
  // Copy test.sh vào workspace (nằm ngoài environment/ để agent
  // không sửa được test — test.sh sống trong tests/ của task, runner
  // copy vào box ngay trước khi chấm).
  const testScriptPath = path.join(box.workspaceDir, '.open-bot-test.sh');
  fs.writeFileSync(testScriptPath, task.testScript, 'utf-8');
  const boxResult = await boxManager.runInBox(botId, '/bin/sh', ['.open-bot-test.sh'], {
    timeoutMs,
  });
  const combined = `${boxResult.stdout}\n${boxResult.stderr}`;
  const parsed = parseHarborTestOutput(combined);
  const scored = scoreHarborTests(task.meta.testWeights, parsed);
  const testRun: HarborTestRun = {
    exitCode: boxResult.exitCode,
    reward: boxResult.timedOut ? 0 : scored.reward,
    passedCount: scored.perTest.filter((t) => t.passed).length,
    totalCount: scored.perTest.length,
    perTest: scored.perTest,
    output: truncateHarborOutput(combined),
    timedOut: boxResult.timedOut,
  };
  // Dọn test.sh khỏi workspace để lần chạy sau không nhầm file.
  try {
    fs.unlinkSync(testScriptPath);
  } catch {
    // Không dọn được cũng không sao — file ẩn, lần sau ghi đè.
  }
  return { testRun, boxResult };
}

/** Runner chính: chạy Harbor task trong sandbox box. */
export class HarborRunner {
  private readonly baseDir: string;
  private readonly boxManager: BotBoxManager;
  private readonly executor?: HarborAgentExecutor;
  private readonly testTimeoutMs: number;
  private readonly keepBox: boolean;

  constructor(options: HarborRunnerOptions) {
    this.baseDir = options.baseDir;
    this.boxManager = new BotBoxManager({ rootDir: options.baseDir });
    this.executor = options.executor;
    this.testTimeoutMs = options.testTimeoutMs ?? HARBOR_DEFAULT_TEST_TIMEOUT_MS;
    this.keepBox = options.keepBox ?? false;
  }

  /** BoxManager dùng chung (test có thể inject box giả qua baseDir). */
  get boxes(): BotBoxManager {
    return this.boxManager;
  }

  /**
   * Chạy một task: validate → tạo box → stage environment → chạy
   * executor → chạy test.sh → tính reward → dọn box (trừ khi
   * keepBox). Không bao giờ throw vì task fail — chỉ throw khi
   * setup/validate lỗi (caller phân biệt bằng HarborTaskError).
   * Kết quả fail (reward < 1) vẫn là một HarborRunResult hợp lệ.
   */
  async runTask(
    task: HarborTask,
    options: { profileId?: string; systemPrompt?: string; model?: { provider: string; model: string } } = {},
  ): Promise<HarborRunResult> {
    const validation = validateHarborTask(task);
    if (!validation.valid) {
      const detail = validation.issues.map((i) => `${i.field}: ${i.message}`).join(' | ');
      throw new Error(`Harbor task "${task.meta.id}" không hợp lệ: ${detail}`);
    }
    if (!this.executor) {
      throw new Error(
        'HarborRunner chưa có agent executor — host phải bind executor (vd executor chạy agent loop thật) trước khi chạy task.',
      );
    }
    const startedAt = Date.now();
    const rolloutId = `roll-${randomUUID()}`;
    const profileId = options.profileId ?? '';
    const model = options.model ?? { provider: '', model: '' };
    const systemPrompt = options.systemPrompt ?? '';
    const botId = harborBoxBotId(task.meta.id);
    const deadlineMs = startedAt + task.meta.timeoutMs;
    let turns: RolloutTurn[] = [];
    let error: string | null = null;
    let isolation = 'none';
    let testRun: HarborTestRun = {
      exitCode: null,
      reward: 0,
      passedCount: 0,
      totalCount: Object.keys(task.meta.testWeights).length,
      perTest: Object.entries(task.meta.testWeights).map(([name, weight]) => ({ name, weight, passed: false })),
      output: '',
      timedOut: false,
    };
    try {
      const box = this.boxManager.createBox(botId, { resetPerTurn: true });
      isolation = box.isolation;
      // Reset workspace (box mới hoặc box cũ còn sót file lần trước).
      this.boxManager.resetBox(botId);
      stageHarborEnvironment(task, box.workspaceDir);
      const execResult = await this.executor({
        task,
        workspaceDir: box.workspaceDir,
        systemPrompt,
        profileId,
        model,
        deadlineMs,
      });
      turns = (execResult.turns ?? []).map((turn, i) => ({ ...turn, index: i }));
      const tested = await runHarborTestsInBox(this.boxManager, botId, task, this.testTimeoutMs);
      testRun = tested.testRun;
      isolation = tested.boxResult.isolation.isolated
        ? tested.boxResult.isolation.kind
        : isolation;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      if (!this.keepBox) {
        try {
          // Xoá box khỏi disk (dọn workspace sau khi chấm xong).
          const dir = path.join(this.baseDir, 'boxes', botId);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Dọn không được thì thôi — box cũ sẽ bị reset ở lần chạy sau.
        }
      }
    }
    const finishedAt = Date.now();
    const usage = sumRolloutUsage(turns);
    const passed = error === null && testRun.reward === 1;
    const rollout: RolloutRecord = {
      schema: ROLLOUT_SCHEMA,
      rolloutId,
      taskId: task.meta.id,
      taskVersion: task.meta.version,
      profileId,
      model,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      instruction: task.instruction,
      systemPrompt,
      turns,
      reward: error === null ? testRun.reward : 0,
      passed,
      testResults: testRun.perTest,
      usage,
      isolation,
      error,
    };
    return {
      rolloutId,
      taskId: task.meta.id,
      taskVersion: task.meta.version,
      profileId,
      model,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      passed,
      reward: rollout.reward,
      testRun,
      turns,
      usage,
      isolation,
      error,
      rollout,
    };
  }

  /**
   * Chạy một suite (tuần tự, 1 task một lúc). Task lỗi setup (validate
   * fail, thiếu executor) dừng cả suite và throw — task fail test thì
   * vẫn tiếp tục task sau. Trả về kết quả từng task + tổng hợp.
   */
  async runSuite(
    tasks: readonly HarborTask[],
    options: { profileId?: string; systemPrompt?: string; model?: { provider: string; model: string } } = {},
  ): Promise<HarborSuiteResult> {
    const startedAt = Date.now();
    const results: HarborRunResult[] = [];
    for (const task of tasks) {
      results.push(await this.runTask(task, options));
    }
    const finishedAt = Date.now();
    const passed = results.filter((r) => r.passed).length;
    const totalReward = results.reduce((sum, r) => sum + r.reward, 0);
    return {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      results,
      passed,
      failed: results.length - passed,
      passRate: results.length > 0 ? passed / results.length : 0,
      meanReward: results.length > 0 ? totalReward / results.length : 0,
      totalPromptTokens: results.reduce((sum, r) => sum + r.usage.promptTokens, 0),
      totalCompletionTokens: results.reduce((sum, r) => sum + r.usage.completionTokens, 0),
    };
  }
}

/** Kết quả tổng hợp của một suite Harbor. */
export interface HarborSuiteResult {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  results: HarborRunResult[];
  passed: number;
  failed: number;
  passRate: number;
  meanReward: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

/** Lưu kết quả một lần chạy task ra file JSON (để UI/tool đọc lại). */
export function saveHarborRunResult(baseDir: string, result: HarborRunResult): string {
  const dir = getHarborReportsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${result.rolloutId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  return filePath;
}

/** Lưu kết quả suite ra file JSON. */
export function saveHarborSuiteResult(baseDir: string, suite: HarborSuiteResult): string {
  const dir = getHarborReportsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `suite-${new Date(suite.startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(suite, null, 2)}\n`, 'utf-8');
  return filePath;
}

/** Liệt kê các file báo cáo Harbor run đã lưu (mới nhất trước). */
export function listHarborRunReports(baseDir: string): string[] {
  const dir = getHarborReportsDir(baseDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .sort()
    .reverse();
}
