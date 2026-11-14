/**
 * Replay engine cho run log (v1.01, Đội T1).
 *
 * Hai việc:
 * 1. **Fold** — tái tạo trạng thái của run từ dãy event (`foldEvents`):
 *    prompt, transcript, tool call + kết quả, file change, lỗi biên
 *    dịch, số step/token, trạng thái cuối. Trạng thái này là hàm thuần
 *    của dãy event: cùng log → cùng trạng thái, luôn luôn như vậy.
 * 2. **Deterministic replay** — chạy lại run từ log mà KHÔNG gọi lại
 *    provider/tool thật (`replayDeterministically`): driver nhận một
 *    handler cho mỗi event và "phát lại" đúng dữ liệu đã ghi (model
 *    response đã ghi, tool result đã ghi). Vì mọi đầu vào không xác
 *    định đều đã nằm trong log, replay cho cùng kết quả với lần chạy
 *    gốc — kiểm chứng bằng digest của trạng thái cuối.
 *
 * Giới hạn nói rõ trong survey: replay cho cùng kết quả *theo log*.
 * Nếu tool đã đọc một file mà file đó đổi sau run, chạy lại thật sẽ
 * khác; phát lại bản ghi thì không. Replay ở đây là phát lại bản ghi,
 * không phải chạy lại môi trường.
 */

import { digestReplayState } from './canonical';
import type {
  AnyRunEvent,
  CompileErrorPayload,
  DeterministicReplayResult,
  FileChangePayload,
  ReplayedRunState,
  ReplayedToolCall,
  ReplayedTranscriptEntry,
  RunCompactionInfo,
  RunStatus,
  StuckDetectionInfo,
} from './types';

/** Chuỗi thay thế nội dung đã che (xem `event.redacted` trong types.ts). */
export const REDACTED_TEXT = '[redacted]';

/**
 * Fold một dãy event (đã theo seq tăng dần) thành trạng thái run.
 * Event lạ (type không biết) bị bỏ qua — log của phiên bản mới hơn
 * vẫn fold được bằng code cũ, chỉ thiếu phần mới.
 */
export function foldEvents(runId: string, events: readonly AnyRunEvent[]): ReplayedRunState {
  const transcript: ReplayedTranscriptEntry[] = [];
  const toolCalls: ReplayedToolCall[] = [];
  const toolById = new Map<string, ReplayedToolCall>();
  const fileChanges: FileChangePayload[] = [];
  const compileErrors: CompileErrorPayload[] = [];
  const errors: string[] = [];
  let prompt = '';
  let botId = '';
  let status: RunStatus = 'running';
  let steps = 0;
  let tokensUsed = 0;
  let startedAt = '';
  let endedAt: string | undefined;
  // v1.03: marker mới — redaction, compaction, stuck detection.
  const redactedSeqs: number[] = [];
  const compactions: RunCompactionInfo[] = [];
  const stuckDetections: StuckDetectionInfo[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'run.started': {
        const p = event.payload as { botId?: string };
        botId = typeof p.botId === 'string' ? p.botId : botId;
        startedAt = event.at;
        break;
      }
      case 'run.prompt': {
        const p = event.payload as { text?: string };
        if (typeof p.text === 'string') prompt = p.text;
        break;
      }
      case 'model.response': {
        const p = event.payload as {
          step?: number;
          text?: string;
          toolCalls?: Array<{ callId: string; tool: string; argKeys: string[] }>;
          inputTokens?: number;
          outputTokens?: number;
        };
        const step = typeof p.step === 'number' ? p.step : 0;
        steps = Math.max(steps, step + 1);
        if (typeof p.inputTokens === 'number') tokensUsed += p.inputTokens;
        if (typeof p.outputTokens === 'number') tokensUsed += p.outputTokens;
        if (typeof p.text === 'string' && p.text.length > 0) {
          transcript.push({ kind: 'text', step, text: p.text });
        }
        for (const call of p.toolCalls ?? []) {
          const recorded: ReplayedToolCall = {
            callId: call.callId,
            tool: call.tool,
            argKeys: [...call.argKeys],
            step,
          };
          toolCalls.push(recorded);
          toolById.set(call.callId, recorded);
          transcript.push({ kind: 'tool_call', step, call: { ...call, argKeys: [...call.argKeys] } });
        }
        break;
      }
      case 'tool.call': {
        // `tool.call` là bản ghi độc lập của cùng một lần gọi mà
        // `model.response` đã báo trước — chỉ bổ sung khi model
        // response chưa từng nhắc tới callId này (vd run resume).
        const p = event.payload as { callId?: string; tool?: string; argKeys?: string[]; step?: number };
        if (typeof p.callId === 'string' && !toolById.has(p.callId)) {
          const recorded: ReplayedToolCall = {
            callId: p.callId,
            tool: typeof p.tool === 'string' ? p.tool : '',
            argKeys: [...(p.argKeys ?? [])],
            step: typeof p.step === 'number' ? p.step : 0,
          };
          toolCalls.push(recorded);
          toolById.set(p.callId, recorded);
        }
        break;
      }
      case 'tool.result': {
        const p = event.payload as {
          callId?: string;
          tool?: string;
          status?: 'ok' | 'error' | 'denied';
          outputPreview?: string;
          durationMs?: number;
          step?: number;
        };
        const step = typeof p.step === 'number' ? p.step : 0;
        const existing = typeof p.callId === 'string' ? toolById.get(p.callId) : undefined;
        if (existing) {
          existing.status = p.status;
          if (typeof p.outputPreview === 'string') existing.outputPreview = p.outputPreview;
          if (typeof p.durationMs === 'number') existing.durationMs = p.durationMs;
        }
        transcript.push({
          kind: 'tool_result',
          step,
          callId: typeof p.callId === 'string' ? p.callId : '',
          tool: typeof p.tool === 'string' ? p.tool : '',
          status: typeof p.status === 'string' ? p.status : '',
          outputPreview: typeof p.outputPreview === 'string' ? p.outputPreview : '',
        });
        if (p.status === 'error' && typeof p.outputPreview === 'string' && p.outputPreview.length > 0) {
          errors.push(`${p.tool ?? 'tool'}: ${p.outputPreview}`);
        }
        break;
      }
      case 'file.change': {
        const change = event.payload as FileChangePayload;
        fileChanges.push(change);
        const step = toolById.get((change as unknown as { callId?: string }).callId ?? '')?.step ?? 0;
        transcript.push({ kind: 'file_change', step, change });
        break;
      }
      case 'compile.error': {
        const p = event.payload as CompileErrorPayload;
        compileErrors.push(p);
        if (typeof p.firstError === 'string' && p.firstError.length > 0) {
          errors.push(`compile: ${p.firstError}`);
        }
        break;
      }
      case 'run.paused': {
        status = 'paused';
        break;
      }
      case 'run.resumed': {
        status = 'running';
        break;
      }
      case 'run.forked': {
        // Fork không đổi trạng thái run — run cha vẫn chạy tiếp.
        break;
      }
      case 'run.completed': {
        const p = event.payload as { steps?: number; tokensUsed?: number };
        status = 'completed';
        endedAt = event.at;
        if (typeof p.steps === 'number') steps = Math.max(steps, p.steps);
        if (typeof p.tokensUsed === 'number') tokensUsed = Math.max(tokensUsed, p.tokensUsed);
        break;
      }
      case 'run.failed': {
        const p = event.payload as { message?: string; steps?: number; tokensUsed?: number };
        status = 'failed';
        endedAt = event.at;
        if (typeof p.message === 'string' && p.message.length > 0) errors.push(p.message);
        if (typeof p.steps === 'number') steps = Math.max(steps, p.steps);
        if (typeof p.tokensUsed === 'number') tokensUsed = Math.max(tokensUsed, p.tokensUsed);
        break;
      }
      case 'run.aborted': {
        const p = event.payload as { message?: string; steps?: number };
        status = 'aborted';
        endedAt = event.at;
        if (typeof p.message === 'string' && p.message.length > 0) errors.push(p.message);
        if (typeof p.steps === 'number') steps = Math.max(steps, p.steps);
        break;
      }
      case 'approval.request':
      case 'approval.decision':
      case 'checkpoint.saved':
        // Không đổi trạng thái fold — UI đọc trực tiếp từ event khi cần.
        break;
      case 'event.redacted': {
        // Chỉ ghi nhận seq — nội dung được che ở pass sau vòng lặp
        // (cần trạng thái đã fold xong mới che ngược được).
        const p = event.payload as { seq?: number };
        if (typeof p.seq === 'number') redactedSeqs.push(p.seq);
        break;
      }
      case 'run.compacted': {
        const p = event.payload as {
          upToSeq?: number;
          summary?: string;
          eventsReplaced?: number;
          tokensBefore?: number;
          tokensAfter?: number;
        };
        compactions.push({
          upToSeq: typeof p.upToSeq === 'number' ? p.upToSeq : 0,
          summary: typeof p.summary === 'string' ? p.summary : '',
          eventsReplaced: typeof p.eventsReplaced === 'number' ? p.eventsReplaced : 0,
          ...(typeof p.tokensBefore === 'number' ? { tokensBefore: p.tokensBefore } : {}),
          ...(typeof p.tokensAfter === 'number' ? { tokensAfter: p.tokensAfter } : {}),
        });
        break;
      }
      case 'stuck.detected': {
        const p = event.payload as {
          step?: number;
          kind?: string;
          detail?: string;
          suggestionKey?: string;
        };
        stuckDetections.push({
          step: typeof p.step === 'number' ? p.step : 0,
          kind: typeof p.kind === 'string' ? p.kind : '',
          detail: typeof p.detail === 'string' ? p.detail : '',
          ...(typeof p.suggestionKey === 'string' ? { suggestionKey: p.suggestionKey } : {}),
        });
        break;
      }
      default:
        // Type lạ (log phiên bản mới hơn) — bỏ qua, fold vẫn chạy.
        break;
    }
  }

  // v1.03 — pass che ngược: mỗi marker `event.redacted` che nội dung
  // của đúng event mà nó trỏ tới. Log gốc trên đĩa không đổi (chỉ
  // trạng thái fold bị che); `file.change` không che path vì path đã
  // qua sanitize và cần cho audit — chỉ che text/output/error.
  for (const seq of redactedSeqs) {
    const target = events.find((e) => e.seq === seq);
    if (!target) continue;
    if (target.type === 'run.prompt') {
      prompt = REDACTED_TEXT;
      continue;
    }
    if (target.type === 'model.response') {
      const p = target.payload as {
        step?: number;
        toolCalls?: Array<{ callId: string; tool: string }>;
      };
      const step = typeof p.step === 'number' ? p.step : -1;
      const callIds = new Set((p.toolCalls ?? []).map((c) => c.callId));
      for (const entry of transcript) {
        if (entry.kind === 'text' && entry.step === step) entry.text = REDACTED_TEXT;
        if (entry.kind === 'tool_result' && callIds.has(entry.callId)) {
          entry.outputPreview = REDACTED_TEXT;
        }
      }
      for (const call of toolCalls) {
        if (callIds.has(call.callId) && call.outputPreview !== undefined) {
          call.outputPreview = REDACTED_TEXT;
        }
      }
      // Gỡ cả chuỗi lỗi suy ra từ tool result của các call này.
      for (const e of events) {
        if (e.type !== 'tool.result') continue;
        const rp = e.payload as { callId?: string; tool?: string; status?: string; outputPreview?: string };
        if (rp.status === 'error' && typeof rp.callId === 'string' && callIds.has(rp.callId)) {
          const errStr = `${rp.tool ?? 'tool'}: ${rp.outputPreview ?? ''}`;
          const idx = errors.indexOf(errStr);
          if (idx !== -1) errors.splice(idx, 1);
        }
      }
      continue;
    }
    if (target.type === 'tool.result') {
      const p = target.payload as { callId?: string; tool?: string; status?: string; outputPreview?: string };
      if (typeof p.callId === 'string') {
        for (const entry of transcript) {
          if (entry.kind === 'tool_result' && entry.callId === p.callId) {
            entry.outputPreview = REDACTED_TEXT;
          }
        }
        const call = toolById.get(p.callId);
        if (call && call.outputPreview !== undefined) call.outputPreview = REDACTED_TEXT;
        if (p.status === 'error') {
          const errStr = `${p.tool ?? 'tool'}: ${p.outputPreview ?? ''}`;
          const idx = errors.indexOf(errStr);
          if (idx !== -1) errors.splice(idx, 1);
        }
      }
      continue;
    }
    if (target.type === 'compile.error') {
      const p = target.payload as { callId?: string; firstError?: string };
      for (const ce of compileErrors) {
        if (typeof p.callId === 'string' && ce.callId === p.callId) ce.firstError = REDACTED_TEXT;
      }
      if (typeof p.firstError === 'string') {
        const errStr = `compile: ${p.firstError}`;
        const idx = errors.indexOf(errStr);
        if (idx !== -1) errors.splice(idx, 1);
      }
      continue;
    }
    // Các loại còn lại (file.change, run.*): không có nội dung text
    // để che — marker vẫn được ghi nhận trong `redactedSeqs`.
  }

  const state: Omit<ReplayedRunState, 'digest'> = {
    runId,
    botId,
    status,
    prompt,
    transcript,
    toolCalls,
    fileChanges,
    compileErrors,
    errors,
    steps,
    tokensUsed,
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    redactedSeqs,
    compactions,
    stuckDetections,
  };
  return { ...state, digest: digestReplayState(state) };
}

/** Handler mà deterministic replay gọi cho từng event, theo thứ tự. */
export interface ReplayDriverHandlers {
  /** Model response đã ghi — driver "trả" đúng response này thay vì gọi provider. */
  onModelResponse?: (event: AnyRunEvent) => void;
  /** Tool result đã ghi — driver "trả" đúng kết quả này thay vì chạy tool. */
  onToolResult?: (event: AnyRunEvent) => void;
  /** Mọi event khác (prompt, file change, …). */
  onEvent?: (event: AnyRunEvent) => void;
}

/**
 * Phát lại một run từ log: đi qua từng event theo seq, gọi handler
 * tương ứng, rồi fold lại thành trạng thái và so digest với digest
 * gốc (nếu caller đưa vào). Không gọi provider, không chạy tool thật,
 * không chạm đĩa ngoài việc đọc log — nên replay là thuần xác định.
 *
 * Trả về digest của trạng thái replay: hai lần replay cùng log cho
 * cùng digest; digest này bằng digest của `foldEvents` trên cùng
 * log (vì cùng một phép fold).
 */
export function replayDeterministically(
  runId: string,
  events: readonly AnyRunEvent[],
  handlers: ReplayDriverHandlers = {},
  expectedDigest?: string,
): DeterministicReplayResult {
  try {
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    for (const event of sorted) {
      if (event.type === 'model.response') {
        handlers.onModelResponse?.(event);
      } else if (event.type === 'tool.result') {
        handlers.onToolResult?.(event);
      } else {
        handlers.onEvent?.(event);
      }
    }
    const state = foldEvents(runId, sorted);
    if (expectedDigest !== undefined && state.digest !== expectedDigest) {
      return {
        runId,
        ok: false,
        digest: state.digest,
        eventsReplayed: sorted.length,
        error: `digest khác: replay=${state.digest.slice(0, 12)}… mong đợi=${expectedDigest.slice(0, 12)}…`,
      };
    }
    return { runId, ok: true, digest: state.digest, eventsReplayed: sorted.length };
  } catch (err) {
    return {
      runId,
      ok: false,
      digest: '',
      eventsReplayed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * So sánh hai lần replay (hoặc replay với trạng thái gốc): true khi
 * digest bằng nhau — tức cùng log cho cùng kết quả.
 */
export function replayMatches(a: DeterministicReplayResult, b: DeterministicReplayResult): boolean {
  return a.ok && b.ok && a.digest !== '' && a.digest === b.digest;
}
