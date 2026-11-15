/**
 * Sub-agent delegation kiểu TaskToolSet (v1.07, Đội T2).
 *
 * Ý tưởng học từ survey v1.07 phần 1 (OpenHands TaskToolSet — chỉ học
 * ý tưởng, không copy code/text/tài sản của repo nào): giao task
 * chuyên biệt cho sub-agent, sub-agent làm trong context riêng rồi
 * trả kết quả NÉN về parent — parent không bao giờ thấy hàng trăm
 * tool call của con, chỉ thấy một bản tóm tắt có giới hạn.
 *
 * Nối tiếp code hiện có (không viết lại):
 * - `subagents/nested.ts` (SubagentTree) đã có policy chống vòng lặp
 *   spawn (depth cap + spawn budget + chặn task trùng đang chạy).
 * - `delegation/tracker.ts` đã có DelegationTracker cho parent.
 * Module này là tầng THỰC THI + NÉN kết quả cho một lần delegate:
 * gọi runner, chờ với timeout, nén output về giới hạn, trả record
 * chuẩn để Conversation ghi vào EventLog (`delegation.completed`).
 * Host tự cung cấp `runner` (vd nối vào `AgentRunner.runSubagent`
 * hoặc một sub-agent V3Conversation khác); module này không gọi LLM.
 *
 * Nén kết quả (context firewall): output thô của sub-agent có thể dài
 * hàng chục nghìn ký tự; parent chỉ nhận tối đa `maxChars` (mặc định
 * 4.000) gồm đầu + cuối + số dòng/ký tự đã cắt — đủ để biết kết quả
 * và file đã đổi, không đủ để làm bẩn context parent. Kết quả nén
 * luôn nói rõ nó đã bị cắt (`truncated: true`) để parent không tưởng
 * đó là toàn bộ output.
 */

import { estimateTokens } from '../../agent/tokens';

/** Ký tự tối đa của kết quả nén trả về parent (mặc định). */
export const DEFAULT_DELEGATED_RESULT_MAX_CHARS = 4_000;
/** Timeout mặc định cho một lần delegate (ms). */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 120_000;
/** Số dòng tối đa giữ lại ở đầu + cuối khi nén (mỗi phía). */
export const DEFAULT_DELEGATED_RESULT_MAX_LINES_PER_SIDE = 40;

/** Kết quả thô mà sub-agent runner trả về. */
export interface SubagentRawResult {
  /** Output text đầy đủ của sub-agent. */
  text: string;
  /** Token input sub-agent đã dùng (khi runner báo được). */
  inputTokens?: number;
  /** Token output sub-agent đã dùng (khi runner báo được). */
  outputTokens?: number;
  /** File sub-agent đã đổi (khi runner biết). */
  changedFiles?: string[];
  /** Model sub-agent chạy (khi runner biết). */
  model?: string;
}

/** Hàm chạy một sub-agent: nhận task, trả kết quả thô. */
export type SubagentRunner = (
  task: string,
  options: { role?: string; signal?: AbortSignal },
) => Promise<SubagentRawResult | string>;

/** Trạng thái kết thúc của một lần delegate. */
export type DelegationStatus = 'done' | 'error' | 'timeout';

/** Record chuẩn của một lần delegate (ghi vào EventLog + trả về parent). */
export interface DelegationRecord {
  delegationId: string;
  task: string;
  role?: string;
  status: DelegationStatus;
  /** Kết quả ĐÃ NÉN — đây là thứ duy nhất parent thấy. */
  result: string;
  /** True khi kết quả đã bị cắt bớt so với output thô. */
  truncated: boolean;
  /** Số ký tự output thô (để parent biết mức nén). */
  rawChars: number;
  /** Số dòng output thô. */
  rawLines: number;
  /** Token ước lượng của kết quả nén (parent cộng vào budget của nó). */
  resultTokens: number;
  /** Token sub-agent đã dùng (khi runner báo; undefined khi không biết). */
  inputTokens?: number;
  outputTokens?: number;
  changedFiles: string[];
  /** Model sub-agent chạy (khi runner biết). */
  model?: string;
  /** Thời gian delegate chạy (ms). */
  durationMs: number;
  /** Lỗi (khi status = 'error' | 'timeout'). */
  error?: string;
}

export interface TaskToolSetOptions {
  /** Ký tự tối đa của kết quả nén. Mặc định 4.000. */
  maxChars?: number;
  /** Số dòng giữ ở mỗi phía khi nén. Mặc định 40. */
  maxLinesPerSide?: number;
  /** Timeout một lần delegate (ms). Mặc định 120.000. */
  timeoutMs?: number;
  /** Hàm sinh id (mặc định `dlg-<random>`). */
  idFactory?: () => string;
}

export interface ResolvedTaskToolSetOptions {
  maxChars: number;
  maxLinesPerSide: number;
  timeoutMs: number;
  idFactory: () => string;
}

export function resolveTaskToolSetOptions(options: TaskToolSetOptions = {}): ResolvedTaskToolSetOptions {
  const num = (value: number | undefined, fallback: number, name: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`TaskToolSetOptions.${name} phải > 0 (nhận ${String(value)}).`);
    }
    return Math.floor(value);
  };
  return {
    maxChars: num(options.maxChars, DEFAULT_DELEGATED_RESULT_MAX_CHARS, 'maxChars'),
    maxLinesPerSide: num(
      options.maxLinesPerSide,
      DEFAULT_DELEGATED_RESULT_MAX_LINES_PER_SIDE,
      'maxLinesPerSide',
    ),
    timeoutMs: num(options.timeoutMs, DEFAULT_DELEGATION_TIMEOUT_MS, 'timeoutMs'),
    idFactory:
      options.idFactory ??
      (() => `dlg-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`),
  };
}

/**
 * Nén output thô của sub-agent về giới hạn cho parent.
 * - Ngắn hơn giới hạn: trả nguyên, `truncated: false`.
 * - Dài hơn: giữ đầu + cuối (theo dòng, mỗi phía tối đa
 *   `maxLinesPerSide` dòng và tổng không quá `maxChars` ký tự), chèn
 *   một dòng marker nói rõ đã cắt bao nhiêu dòng/ký tự ở giữa.
 * Không bao giờ trả output thô dài hơn giới hạn về parent.
 */
export function compressDelegatedResult(
  rawText: string,
  options: TaskToolSetOptions = {},
): { result: string; truncated: boolean; rawChars: number; rawLines: number; resultTokens: number } {
  const resolved = resolveTaskToolSetOptions(options);
  const rawChars = rawText.length;
  const rawLines = rawText === '' ? 0 : rawText.split('\n').length;
  if (rawChars <= resolved.maxChars) {
    return {
      result: rawText,
      truncated: false,
      rawChars,
      rawLines,
      resultTokens: estimateTokens(rawText),
    };
  }
  const lines = rawText.split('\n');
  const headLines = lines.slice(0, resolved.maxLinesPerSide);
  const tailLines = lines.slice(-resolved.maxLinesPerSide);
  // Cắt theo ký tự nữa: mỗi phía tối đa một nửa giới hạn.
  const half = Math.floor(resolved.maxChars / 2);
  const head = headLines.join('\n').slice(0, half);
  const tail = tailLines.join('\n').slice(-half);
  const omittedLines = Math.max(0, rawLines - headLines.length - tailLines.length);
  const omittedChars = Math.max(0, rawChars - head.length - tail.length);
  const marker =
    `\n… [đã nén: bỏ ${omittedLines.toLocaleString('en-US')} dòng / ` +
    `${omittedChars.toLocaleString('en-US')} ký tự ở giữa — hỏi lại sub-agent nếu cần chi tiết] …\n`;
  const result = `${head}${marker}${tail}`;
  return {
    result,
    truncated: true,
    rawChars,
    rawLines,
    resultTokens: estimateTokens(result),
  };
}

/**
 * TaskToolSet — giao task chuyên biệt cho sub-agent, nhận kết quả nén.
 *
 * Một instance dùng chung cho một conversation (giữ số lần delegate
 * + danh sách record, để UI/conversation tra lại). Không giữ
 * credential, không gọi LLM — `runner` do host cung cấp.
 */
export class TaskToolSet {
  private readonly options: ResolvedTaskToolSetOptions;
  private readonly records: DelegationRecord[] = [];

  constructor(options: TaskToolSetOptions = {}) {
    this.options = resolveTaskToolSetOptions(options);
  }

  /** Mọi record delegate đã xong (mới nhất cuối). */
  list(): DelegationRecord[] {
    return [...this.records];
  }

  /** Số lần đã delegate. */
  get count(): number {
    return this.records.length;
  }

  /**
   * Giao một task cho sub-agent qua `runner`, chờ tối đa `timeoutMs`,
   * nén kết quả rồi trả record. Không throw vì sub-agent lỗi/timeout —
   * lỗi được ghi vào record (`status` + `error`) để parent tự quyết
   * (thử lại, đổi hướng, báo user). Chỉ throw khi `task` rỗng hoặc
   * `runner` không phải function (lỗi lập trình của host).
   */
  async delegate(
    task: string,
    runner: SubagentRunner,
    options: { role?: string; timeoutMs?: number } = {},
  ): Promise<DelegationRecord> {
    if (typeof task !== 'string' || task.trim() === '') {
      throw new Error('TaskToolSet.delegate cần task không rỗng.');
    }
    if (typeof runner !== 'function') {
      throw new Error('TaskToolSet.delegate cần runner là function.');
    }
    const timeoutMs =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : this.options.timeoutMs;
    const delegationId = this.options.idFactory();
    const startedAt = Date.now();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error(`Sub-agent quá hạn ${timeoutMs}ms.`));
        }, timeoutMs);
      });
      const raw = await Promise.race([
        runner(task, {
          ...(options.role !== undefined ? { role: options.role } : {}),
          signal: abort.signal,
        }),
        timeoutPromise,
      ]);
      const rawResult: SubagentRawResult =
        typeof raw === 'string' ? { text: raw } : raw;
      const text = typeof rawResult.text === 'string' ? rawResult.text : '';
      const compressed = compressDelegatedResult(text, this.options);
      const record: DelegationRecord = {
        delegationId,
        task,
        ...(options.role !== undefined ? { role: options.role } : {}),
        status: 'done',
        result: compressed.result,
        truncated: compressed.truncated,
        rawChars: compressed.rawChars,
        rawLines: compressed.rawLines,
        resultTokens: compressed.resultTokens,
        ...(typeof rawResult.inputTokens === 'number'
          ? { inputTokens: Math.max(0, Math.floor(rawResult.inputTokens)) }
          : {}),
        ...(typeof rawResult.outputTokens === 'number'
          ? { outputTokens: Math.max(0, Math.floor(rawResult.outputTokens)) }
          : {}),
        changedFiles: Array.isArray(rawResult.changedFiles)
          ? rawResult.changedFiles.filter((f): f is string => typeof f === 'string')
          : [],
        ...(typeof rawResult.model === 'string' && rawResult.model !== ''
          ? { model: rawResult.model }
          : {}),
        durationMs: Date.now() - startedAt,
      };
      this.records.push(record);
      return record;
    } catch (err) {
      const message = (err as Error).message;
      const isTimeout = message.includes('quá hạn');
      const record: DelegationRecord = {
        delegationId,
        task,
        ...(options.role !== undefined ? { role: options.role } : {}),
        status: isTimeout ? 'timeout' : 'error',
        result: isTimeout
          ? `Sub-agent quá hạn ${timeoutMs}ms — không có kết quả. Thử task nhỏ hơn hoặc tăng timeout.`
          : `Sub-agent lỗi: ${message}`,
        truncated: false,
        rawChars: 0,
        rawLines: 0,
        resultTokens: 0,
        changedFiles: [],
        durationMs: Date.now() - startedAt,
        error: message,
      };
      this.records.push(record);
      return record;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
