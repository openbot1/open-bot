/**
 * Stuck detection cho run log (v1.03, Đội T1).
 *
 * Ý tưởng học từ survey v1.03 (harness engineering: "stuck detection"
 * là một trong 29 pattern còn thiếu của open-bot): agent kẹt thường
 * để lại dấu vết rất rõ trong event stream — cùng một tool call lặp
 * lại, cùng một lỗi lặp lại, model trả text rỗng kèm cùng tool call,
 * hoặc nhiều step trôi qua mà không có tiến triển nào (không file
 * change, không tool ok). Module này là hàm thuần trên event đã ghi:
 * không gọi model, không đoán ý định — chỉ đếm mẫu lặp và báo cáo.
 *
 * `detectStuck` không dừng run: nó trả `StuckReport` để loop/UI quyết
 * định can thiệp (dừng, đổi hướng, hỏi user). Muốn lưu phát hiện vào
 * log để audit thì gọi `recordStuckDetection` — nó append event
 * `stuck.detected` (append-only, không sửa lịch sử).
 */

import type { RunLogStore } from './store';
import type { AnyRunEvent } from './types';

/** Các loại tín hiệu kẹt mà detector nhận ra. */
export type StuckSignalKind =
  | 'repeat_tool_call'
  | 'repeat_tool_error'
  | 'repeat_compile_error'
  | 'empty_response_loop'
  | 'no_progress'
  | 'step_budget';

/** Một tín hiệu kẹt cụ thể, kèm bằng chứng (seq + số lần). */
export interface StuckSignal {
  kind: StuckSignalKind;
  /** Số lần mẫu lặp lại (hoặc số step không tiến triển). */
  count: number;
  /** Mô tả ngắn bằng tiếng Anh (đã sanitize — chỉ tên tool / lỗi cắt ngắn). */
  detail: string;
  /** Seq đầu tiên của mẫu lặp. */
  firstSeq: number;
  /** Seq cuối cùng của mẫu lặp. */
  lastSeq: number;
}

/** Kết quả phân tích một run: kẹt hay không + tín hiệu + gợi ý. */
export interface StuckReport {
  runId: string;
  /** true khi có ít nhất một tín hiệu vượt ngưỡng. */
  stuck: boolean;
  /** Step hiện tại (step lớn nhất trong log, 0 khi chưa có response). */
  step: number;
  /** Mọi tín hiệu vượt ngưỡng (rỗng khi không kẹt). */
  signals: StuckSignal[];
  /**
   * Key i18n của gợi ý can thiệp mạnh nhất (vd
   * `harness.v103.stuck.repeatTool`) — UI dịch key này, không dịch
   * `detail` (detail là dữ liệu, không phải chuỗi UI).
   */
  suggestionKey?: string;
}

/** Ngưỡng mặc định — caller có thể nới/chặt qua `StuckOptions`. */
export interface StuckOptions {
  /** Cùng tool call (tool + argKeys) lặp bao nhiêu lần thì kẹt. Mặc định 3. */
  repeatToolThreshold?: number;
  /** Cùng tool lỗi bao nhiêu lần thì kẹt. Mặc định 3. */
  repeatErrorThreshold?: number;
  /** Cùng compile error bao nhiêu lần thì kẹt. Mặc định 3. */
  repeatCompileThreshold?: number;
  /** Model response rỗng kèm tool call bao nhiêu lần liên tiếp thì kẹt. Mặc định 3. */
  emptyResponseThreshold?: number;
  /** Bao nhiêu step không file change / không tool ok thì kẹt. Mặc định 8. */
  noProgressStepThreshold?: number;
  /**
   * Tỉ lệ step đã dùng / maxSteps mà từ đó cảnh báo sắp hết budget.
   * Mặc định 0.8. Không set maxSteps (run.started thiếu) thì bỏ qua.
   */
  stepBudgetRatio?: number;
}

/** Map từ loại tín hiệu sang key i18n gợi ý (ưu tiên theo thứ tự này). */
export const STUCK_SUGGESTION_KEYS: Record<StuckSignalKind, string> = {
  repeat_tool_call: 'harness.v103.stuck.repeatTool',
  repeat_tool_error: 'harness.v103.stuck.repeatError',
  repeat_compile_error: 'harness.v103.stuck.repeatCompile',
  empty_response_loop: 'harness.v103.stuck.emptyResponse',
  no_progress: 'harness.v103.stuck.noProgress',
  step_budget: 'harness.v103.stuck.stepBudget',
};

const DEFAULTS: Required<StuckOptions> = {
  repeatToolThreshold: 3,
  repeatErrorThreshold: 3,
  repeatCompileThreshold: 3,
  emptyResponseThreshold: 3,
  noProgressStepThreshold: 8,
  stepBudgetRatio: 0.8,
};

/** Chữ ký của một tool call: tool + argKeys đã sắp xếp — so sánh lặp. */
function toolCallSignature(tool: string, argKeys: readonly string[]): string {
  return `${tool}(${[...argKeys].sort().join(',')})`;
}

/**
 * Phân tích dãy event (theo seq tăng dần) và báo kẹt hay không.
 * Event lạ bị bỏ qua. Log rỗng → không kẹt (chưa có gì để kẹt).
 */
export function detectStuck(
  runId: string,
  events: readonly AnyRunEvent[],
  options: StuckOptions = {},
): StuckReport {
  const o = { ...DEFAULTS, ...options };
  const signals: StuckSignal[] = [];
  let step = 0;
  let maxSteps: number | undefined;

  // --- Quét một lượt, gom các chuỗi lặp liên tiếp. ---
  // Tool call liên tiếp giống nhau (theo model.response + tool.call).
  // Một lần gọi xuất hiện ở CẢ hai loại event (response báo trước,
  // tool.call ghi độc lập) nên dedup theo callId — không thì cùng
  // một lần gọi bị đếm hai lần và báo kẹt giả.
  const seenCallIds = new Set<string>();
  let runSig = '';
  let runCount = 0;
  let runFirstSeq = 0;
  let runLastSeq = 0;
  const flushRepeatTool = () => {
    if (runCount >= o.repeatToolThreshold && runSig !== '') {
      signals.push({
        kind: 'repeat_tool_call',
        count: runCount,
        detail: `same tool call ${runCount}x: ${runSig}`,
        firstSeq: runFirstSeq,
        lastSeq: runLastSeq,
      });
    }
    runCount = 0;
    runSig = '';
  };
  const countToolCall = (callId: string, tool: string, argKeys: readonly string[], seq: number) => {
    if (callId !== '' && seenCallIds.has(callId)) return;
    if (callId !== '') seenCallIds.add(callId);
    const sig = toolCallSignature(tool, argKeys);
    if (sig === runSig) {
      runCount += 1;
      runLastSeq = seq;
    } else {
      flushRepeatTool();
      runSig = sig;
      runCount = 1;
      runFirstSeq = seq;
      runLastSeq = seq;
    }
  };
  // Tool error liên tiếp (cùng tool + cùng status error).
  let errTool = '';
  let errCount = 0;
  let errFirstSeq = 0;
  let errLastSeq = 0;
  const flushRepeatError = () => {
    if (errCount >= o.repeatErrorThreshold && errTool !== '') {
      signals.push({
        kind: 'repeat_tool_error',
        count: errCount,
        detail: `tool ${errTool} failed ${errCount}x in a row`,
        firstSeq: errFirstSeq,
        lastSeq: errLastSeq,
      });
    }
    errCount = 0;
    errTool = '';
  };
  // Compile error liên tiếp (cùng firstError).
  let cmpErr = '';
  let cmpCount = 0;
  let cmpFirstSeq = 0;
  let cmpLastSeq = 0;
  const flushRepeatCompile = () => {
    if (cmpCount >= o.repeatCompileThreshold && cmpErr !== '') {
      signals.push({
        kind: 'repeat_compile_error',
        count: cmpCount,
        detail: `same compile error ${cmpCount}x: ${cmpErr.slice(0, 120)}`,
        firstSeq: cmpFirstSeq,
        lastSeq: cmpLastSeq,
      });
    }
    cmpCount = 0;
    cmpErr = '';
  };
  // Model response rỗng liên tiếp (text rỗng + có tool call).
  let emptyCount = 0;
  let emptyFirstSeq = 0;
  let emptyLastSeq = 0;
  const flushEmpty = () => {
    if (emptyCount >= o.emptyResponseThreshold) {
      signals.push({
        kind: 'empty_response_loop',
        count: emptyCount,
        detail: `${emptyCount} empty model responses with tool calls in a row`,
        firstSeq: emptyFirstSeq,
        lastSeq: emptyLastSeq,
      });
    }
    emptyCount = 0;
  };
  // Tiến triển: step của lần file.change / tool ok gần nhất.
  let lastProgressStep = -1;
  let lastProgressSeq = 0;

  for (const event of events) {
    switch (event.type) {
      case 'run.started': {
        const p = event.payload as { maxSteps?: number };
        if (typeof p.maxSteps === 'number') maxSteps = p.maxSteps;
        break;
      }
      case 'model.response': {
        const p = event.payload as {
          step?: number;
          text?: string;
          toolCalls?: Array<{ callId: string; tool: string; argKeys: string[] }>;
        };
        if (typeof p.step === 'number') step = Math.max(step, p.step + 1);
        const text = typeof p.text === 'string' ? p.text : '';
        const calls = p.toolCalls ?? [];
        if (text.trim() === '' && calls.length > 0) {
          if (emptyCount === 0) emptyFirstSeq = event.seq;
          emptyCount += 1;
          emptyLastSeq = event.seq;
        } else {
          flushEmpty();
        }
        for (const call of calls) {
          countToolCall(call.callId, call.tool, call.argKeys ?? [], event.seq);
        }
        break;
      }
      case 'tool.call': {
        const p = event.payload as { callId?: string; tool?: string; argKeys?: string[] };
        countToolCall(
          typeof p.callId === 'string' ? p.callId : '',
          typeof p.tool === 'string' ? p.tool : '',
          p.argKeys ?? [],
          event.seq,
        );
        break;
      }
      case 'tool.result': {
        const p = event.payload as { tool?: string; status?: string; step?: number };
        const tool = typeof p.tool === 'string' ? p.tool : '';
        if (p.status === 'error') {
          if (tool === errTool) {
            errCount += 1;
            errLastSeq = event.seq;
          } else {
            flushRepeatError();
            errTool = tool;
            errCount = 1;
            errFirstSeq = event.seq;
            errLastSeq = event.seq;
          }
        } else {
          flushRepeatError();
          if (p.status === 'ok' && typeof p.step === 'number') {
            lastProgressStep = Math.max(lastProgressStep, p.step);
            lastProgressSeq = event.seq;
          }
        }
        // Tool call không phải error thì chuỗi repeat-tool đã đứt ở
        // model.response/tool.call rồi — không flush ở đây để tránh
        // đếm trùng khi response và call xen kẽ cùng một lần gọi.
        break;
      }
      case 'file.change': {
        const p = event.payload as { callId?: string };
        // File change là tiến triển — step lấy từ tool call gây ra nó
        // nếu tìm được, nếu không thì dùng step hiện tại.
        lastProgressStep = Math.max(lastProgressStep, step > 0 ? step - 1 : 0);
        lastProgressSeq = event.seq;
        void p;
        break;
      }
      case 'compile.error': {
        const p = event.payload as { firstError?: string };
        const first = typeof p.firstError === 'string' ? p.firstError : '';
        if (first === cmpErr && first !== '') {
          cmpCount += 1;
          cmpLastSeq = event.seq;
        } else {
          flushRepeatCompile();
          cmpErr = first;
          cmpCount = first === '' ? 0 : 1;
          cmpFirstSeq = event.seq;
          cmpLastSeq = event.seq;
        }
        break;
      }
      default:
        break;
    }
  }
  flushRepeatTool();
  flushRepeatError();
  flushRepeatCompile();
  flushEmpty();

  // Không tiến triển: nhiều step kể từ lần tiến triển cuối (hoặc từ
  // đầu run khi chưa từng có tiến triển) mà run vẫn chưa kết thúc.
  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  const ended =
    lastEvent !== undefined &&
    (lastEvent.type === 'run.completed' || lastEvent.type === 'run.failed' || lastEvent.type === 'run.aborted');
  if (!ended && step > 0) {
    const sinceProgress = lastProgressStep < 0 ? step : step - 1 - lastProgressStep;
    if (sinceProgress >= o.noProgressStepThreshold) {
      signals.push({
        kind: 'no_progress',
        count: sinceProgress,
        detail: `${sinceProgress} steps without a file change or successful tool`,
        firstSeq: lastProgressSeq,
        lastSeq: lastEvent?.seq ?? 0,
      });
    }
  }
  // Sắp hết step budget.
  if (maxSteps !== undefined && maxSteps > 0 && step >= Math.ceil(maxSteps * o.stepBudgetRatio)) {
    signals.push({
      kind: 'step_budget',
      count: step,
      detail: `used ${step}/${maxSteps} steps`,
      firstSeq: events.length > 0 ? events[0]!.seq : 0,
      lastSeq: lastEvent?.seq ?? 0,
    });
  }

  // Sắp xếp tín hiệu theo seq xuất hiện để báo cáo ổn định.
  signals.sort((a, b) => a.firstSeq - b.firstSeq);
  const stuck = signals.length > 0;
  return {
    runId,
    stuck,
    step,
    signals,
    ...(stuck ? { suggestionKey: STUCK_SUGGESTION_KEYS[signals[0]!.kind] } : {}),
  };
}

/**
 * Đọc log của một run từ store rồi phân tích kẹt. Ném lỗi khi run
 * không tồn tại (không có event nào).
 */
export function detectStuckForRun(
  store: RunLogStore,
  runId: string,
  options: StuckOptions = {},
): StuckReport {
  const { events } = store.readRun(runId);
  if (events.length === 0) throw new Error(`Không phân tích được: run ${runId} chưa có event nào.`);
  return detectStuck(runId, events, options);
}

/**
 * Ghi phát hiện kẹt vào log (một event `stuck.detected` cho tín hiệu
 * đầu tiên — tín hiệu mạnh nhất theo thứ tự xuất hiện). Trả về seq
 * của event đã ghi, hoặc 0 khi báo cáo nói run không kẹt.
 */
export function recordStuckDetection(store: RunLogStore, runId: string, report: StuckReport): number {
  if (!report.stuck || report.signals.length === 0) return 0;
  const first = report.signals[0]!;
  const event = store.append(runId, {
    type: 'stuck.detected',
    payload: {
      step: report.step,
      kind: first.kind,
      detail: first.detail,
      ...(report.suggestionKey !== undefined ? { suggestionKey: report.suggestionKey } : {}),
    },
  });
  return event.seq;
}
