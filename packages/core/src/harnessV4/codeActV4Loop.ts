/**
 * CodeAct v4 loop — vòng lặp viết code → chạy → sửa theo lỗi (v1.08, Đội T3).
 *
 * Ý tưởng học từ survey v1.08 phần OpenHands CodeAct (chỉ học ý
 * tưởng, không copy code/text/tài sản của bất kỳ repo nào): agent
 * viết code thật và thực thi trực tiếp, quan sát output rồi lặp.
 *
 * Tầng này bọc `CodeActExecutor` v2 (đã có: bash/python/edit trong
 * BotBox sandbox, denylist, timeout, cap output/ghi, prlimit):
 * - Chạy action, phân loại lỗi của observation (syntax / runtime /
 *   timeout / blocked / validation / not_found / permission).
 * - Khi lỗi và còn vòng: gọi `fixer` (host nối model hoặc rule sửa
 *   code) để sinh action mới rồi chạy lại; fixer trả null = bỏ cuộc.
 * - Dừng ngay khi exit 0 (succeeded), khi bị chặn bởi denylist
 *   (blocked — không retry vì chạy lại cũng bị chặn), khi hết vòng
 *   (max_rounds), hoặc khi hết tổng thời gian (timed_out).
 * - Mọi vòng đều ghi vào EventLog v4 khi caller truyền `eventLog`
 *   + `sessionId` (event `h4.codeact.run` cho từng vòng +
 *   `h4.codeact.loop` khi loop kết thúc); không có log thì loop vẫn
 *   chạy bình thường (log là tuỳ chọn, không phải điều kiện).
 *
 * An toàn: loop không tự gọi mạng, không tự sửa code — code mới
 * luôn đến từ fixer của host; mọi giới hạn của executor v2 vẫn giữ
 * nguyên (timeout từng vòng, cap output, denylist).
 */

import { randomUUID } from 'node:crypto';

import type { CodeActExecutor } from '../codeact/executor';
import { CodeActValidationError, isCodeActCommandBlocked } from '../codeact/executor';
import type { CodeActAction, CodeActResult } from '../codeact/types';
import { HARNESS_V4_CODEACT_PREVIEW_CHARS } from './eventLogV4';
import type { HarnessV4EventLog } from './eventLogV4';
import type {
  HarnessV4ErrorKind,
  HarnessV4Fixer,
  HarnessV4LoopLimits,
  HarnessV4LoopResult,
  HarnessV4LoopRound,
} from './types';
import { DEFAULT_HARNESS_V4_LOOP_LIMITS } from './types';

/** Mẫu phân loại lỗi từ stderr/stdout (khớp không phân biệt hoa thường). */
export const HARNESS_V4_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: HarnessV4ErrorKind }> = [
  { pattern: /SyntaxError|IndentationError|invalid syntax|Unexpected token|Unexpected identifier/i, kind: 'syntax' },
  { pattern: /ModuleNotFoundError|No module named|Cannot find module|ENOENT|no such file or directory/i, kind: 'not_found' },
  { pattern: /Permission denied|EACCES|EPERM|Operation not permitted/i, kind: 'permission' },
  { pattern: /Traceback|Error:|Exception|TypeError|ReferenceError|NameError|ValueError|KeyError|AttributeError/i, kind: 'runtime' },
];

/**
 * Phân loại lỗi của một lần chạy CodeAct từ observation.
 * Thứ tự ưu tiên: timeout → blocked (stderr mang lý do chặn) →
 * mẫu stderr → runtime (exit khác 0 mà không khớp mẫu nào) →
 * undefined (thành công).
 */
export function classifyHarnessV4Error(result: CodeActResult): HarnessV4ErrorKind | undefined {
  const o = result.observation;
  if (o.timedOut) return 'timeout';
  if (o.exitCode === 0 && !o.writeCapExceeded) return undefined;
  const combined = `${o.stderr}\n${o.stdout}`;
  if (/lệnh bị chặn|blocked/i.test(combined)) return 'blocked';
  for (const { pattern, kind } of HARNESS_V4_ERROR_PATTERNS) {
    if (pattern.test(combined)) return kind;
  }
  if (o.writeCapExceeded) return 'runtime';
  if (o.exitCode !== 0 && o.exitCode !== null) return 'runtime';
  return 'unknown';
}

/** Gợi ý sửa mặc định theo loại lỗi (đưa cho fixer khi nó không tự suy ra). */
export function harnessV4FixHintFor(kind: HarnessV4ErrorKind): string {
  switch (kind) {
    case 'syntax':
      return 'Lỗi cú pháp: kiểm tra dấu ngoặc, dấu hai chấm, thụt lề (Python) hoặc dấu chấm phẩy (Bash).';
    case 'runtime':
      return 'Lỗi runtime: đọc traceback, sửa đúng dòng báo lỗi, kiểm tra biến chưa định nghĩa.';
    case 'timeout':
      return 'Quá thời gian: giảm khối lượng việc, chia nhỏ tác vụ, tránh vòng lặp vô hạn.';
    case 'not_found':
      return 'Không tìm thấy module/file: kiểm tra tên import, đường dẫn tương đối, file đã tồn tại chưa.';
    case 'permission':
      return 'Không có quyền: đừng ghi ra ngoài workspace, kiểm tra quyền file/thư mục.';
    case 'blocked':
      return 'Lệnh bị chặn bởi denylist: đổi cách làm khác, không thử lại lệnh đã bị chặn.';
    case 'validation':
      return 'Action không hợp lệ: kiểm tra lại kind, command/code/path, giới hạn độ dài.';
    default:
      return 'Lỗi chưa rõ nguyên nhân: in thêm thông tin chẩn đoán rồi sửa theo output.';
  }
}

export interface HarnessV4LoopOptions {
  /** Executor CodeAct v2 đã có (caller sở hữu vòng đời + box). */
  executor: CodeActExecutor;
  /** Hàm sửa code (host nối model; không truyền thì loop chỉ chạy 1 vòng). */
  fixer?: HarnessV4Fixer;
  /** Giới hạn vòng lặp (mặc định 5 vòng / 300s tổng). */
  limits?: Partial<HarnessV4LoopLimits>;
  /** EventLog v4 để ghi từng vòng (tuỳ chọn). */
  eventLog?: HarnessV4EventLog;
  /** Session v4 nhận event (bắt buộc khi có eventLog). */
  sessionId?: string;
  /** Step hiện tại trong session (ghi vào event, mặc định 0). */
  step?: number;
}

/** Vòng lặp CodeAct v4: chạy → phân loại lỗi → fixer sửa → chạy lại. */
export class CodeActV4Loop {
  readonly limits: HarnessV4LoopLimits;
  private readonly executor: CodeActExecutor;
  private readonly fixer?: HarnessV4Fixer;
  private readonly eventLog?: HarnessV4EventLog;
  private readonly sessionId?: string;
  private readonly step: number;

  constructor(options: HarnessV4LoopOptions) {
    if (options.eventLog !== undefined && options.sessionId === undefined) {
      throw new Error('CodeActV4Loop: có eventLog thì phải có sessionId.');
    }
    this.executor = options.executor;
    this.fixer = options.fixer;
    this.eventLog = options.eventLog;
    this.sessionId = options.sessionId;
    this.step = options.step ?? 0;
    const maxRounds = options.limits?.maxRounds ?? DEFAULT_HARNESS_V4_LOOP_LIMITS.maxRounds;
    const totalTimeoutMs = options.limits?.totalTimeoutMs ?? DEFAULT_HARNESS_V4_LOOP_LIMITS.totalTimeoutMs;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20) {
      throw new Error('CodeActV4Loop: maxRounds phải trong khoảng 1..20.');
    }
    if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) {
      throw new Error('CodeActV4Loop: totalTimeoutMs phải > 0.');
    }
    this.limits = { maxRounds, totalTimeoutMs };
  }

  /**
   * Chạy vòng lặp từ một action ban đầu. Trả kết quả đầy đủ (mọi vòng
   * + outcome). Không throw vì code lỗi — lỗi là observation bình
   * thường; chỉ throw khi action ban đầu không hợp lệ (lỗi của caller).
   */
  async run(initialAction: CodeActAction): Promise<HarnessV4LoopResult> {
    const loopId = randomUUID();
    const startedMs = Date.now();
    const rounds: HarnessV4LoopRound[] = [];
    let action = initialAction;
    let outcome: HarnessV4LoopResult['outcome'] = 'failed';
    let lastErrorKind: HarnessV4ErrorKind | undefined;
    let hitMaxRounds = false;
    await this.runOnce(action, 1, loopId, rounds);

    while (true) {
      const errorKind = classifyHarnessV4Error(rounds[rounds.length - 1]!.result);
      lastErrorKind = errorKind;
      if (errorKind === undefined) {
        outcome = 'succeeded';
        break;
      }
      if (errorKind === 'blocked') {
        outcome = 'blocked';
        break;
      }
      const elapsedMs = Date.now() - startedMs;
      if (elapsedMs >= this.limits.totalTimeoutMs) {
        outcome = 'timed_out';
        break;
      }
      if (rounds.length >= this.limits.maxRounds) {
        outcome = 'max_rounds';
        hitMaxRounds = true;
        break;
      }
      if (this.fixer === undefined) {
        outcome = 'failed';
        break;
      }
      const roundNo = rounds.length + 1;
      const last = rounds[rounds.length - 1]!;
      let fixed: CodeActAction | null;
      try {
        fixed = await this.fixer({
          round: roundNo,
          action,
          observation: last.result.observation,
          errorKind,
        });
      } catch (err) {
        // Fixer lỗi = bỏ cuộc, không làm hỏng loop (ghi rõ vào outcome).
        lastErrorKind = 'unknown';
        void err;
        outcome = 'failed';
        break;
      }
      if (fixed === null) {
        outcome = 'failed';
        break;
      }
      try {
        this.executor.validate(fixed);
      } catch (err) {
        if (err instanceof CodeActValidationError) {
          lastErrorKind = 'validation';
          outcome = 'failed';
          break;
        }
        throw err;
      }
      action = fixed;
      await this.runOnce(action, roundNo, loopId, rounds);
      if (Date.now() - startedMs >= this.limits.totalTimeoutMs) {
        const kindAfter = classifyHarnessV4Error(rounds[rounds.length - 1]!.result);
        lastErrorKind = kindAfter;
        outcome = kindAfter === undefined ? 'succeeded' : 'timed_out';
        break;
      }
    }

    const totalDurationMs = Date.now() - startedMs;
    const lastRound = rounds[rounds.length - 1]!;
    const result: HarnessV4LoopResult = {
      loopId,
      outcome,
      rounds,
      finalObservation: lastRound.result.observation,
      ...(lastErrorKind !== undefined && outcome !== 'succeeded' ? { lastErrorKind } : {}),
      totalDurationMs,
      hitMaxRounds,
    };
    this.logLoop(result);
    return result;
  }

  /** Chạy một vòng, ghi event `h4.codeact.run`, trả observation. */
  private async runOnce(
    action: CodeActAction,
    round: number,
    loopId: string,
    rounds: HarnessV4LoopRound[],
  ): Promise<CodeActResult['observation']> {
    const result = await this.executor.execute(action);
    const errorKind = classifyHarnessV4Error(result);
    const fixHint = errorKind !== undefined ? harnessV4FixHintFor(errorKind) : undefined;
    rounds.push({
      round,
      action,
      result,
      ...(errorKind !== undefined ? { errorKind } : {}),
      ...(fixHint !== undefined ? { fixHint } : {}),
    });
    if (this.eventLog !== undefined && this.sessionId !== undefined) {
      const o = result.observation;
      const previewSource = `${o.stdout}\n${o.stderr}`.trim();
      try {
        this.eventLog.append(this.sessionId, {
          type: 'h4.codeact.run',
          payload: {
            runId: result.execution.id,
            step: this.step,
            actionKind: result.action.kind,
            summary: `${result.action.kind} (vòng ${round}/${this.limits.maxRounds}, loop ${loopId.slice(0, 8)})`,
            exitCode: o.exitCode,
            timedOut: o.timedOut,
            durationMs: o.durationMs,
            outputPreview:
              previewSource.length > HARNESS_V4_CODEACT_PREVIEW_CHARS
                ? `${previewSource.slice(0, HARNESS_V4_CODEACT_PREVIEW_CHARS)}…`
                : previewSource,
          },
        });
      } catch {
        // Log hỏng không được làm hỏng vòng chạy — loop vẫn trả kết quả.
      }
    }
    return result.observation;
  }

  /** Ghi event `h4.codeact.loop` khi loop kết thúc (bỏ qua lỗi log). */
  private logLoop(result: HarnessV4LoopResult): void {
    if (this.eventLog === undefined || this.sessionId === undefined) return;
    try {
      this.eventLog.append(this.sessionId, {
        type: 'h4.codeact.loop',
        payload: {
          loopId: result.loopId,
          step: this.step,
          rounds: result.rounds.length,
          outcome: result.outcome,
          ...(result.lastErrorKind !== undefined ? { lastErrorKind: result.lastErrorKind } : {}),
          totalDurationMs: result.totalDurationMs,
        },
      });
    } catch {
      // Bỏ qua lỗi log.
    }
  }
}

/** Tiện ích: chạy một vòng lặp CodeAct v4 mà không cần new class. */
export async function runHarnessV4CodeActLoop(
  options: HarnessV4LoopOptions,
  initialAction: CodeActAction,
): Promise<HarnessV4LoopResult> {
  return new CodeActV4Loop(options).run(initialAction);
}
