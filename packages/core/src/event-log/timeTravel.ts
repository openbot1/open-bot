/**
 * Time-travel cho run log (v1.03, Đội T1).
 *
 * Ý tưởng học từ survey v1.03 (OpenHands V1: conversation là stream
 * event bất biến, replayable — pause/resume/fork/time-travel đều
 * miễn phí nhờ đó): vì trạng thái của run là hàm thuần của dãy event,
 * "quay lại thời điểm cũ" chỉ là fold lại prefix của log tới seq đó,
 * và "fork từ một điểm cũ" chỉ là sao chép prefix đó sang run mới
 * (đã có `forkRun` trong `control.ts` — module này bọc nó bằng API
 * tường minh theo seq + thêm so sánh trạng thái và liệt kê nhánh).
 *
 * Không có gì ở đây sửa lịch sử: time-travel chỉ đọc prefix, fork
 * chỉ sao chép prefix sang log mới — run gốc không bao giờ bị đổi.
 */

import { forkRun } from './control';
import type { ForkRunResult } from './control';
import { foldEvents } from './replay';
import type { RunLogStore } from './store';
import type { AnyRunEvent, ReplayedRunState } from './types';

/** Kết quả time-travel: trạng thái run tại một seq + bối cảnh. */
export interface TimeTravelResult {
  runId: string;
  /** Seq đã quay tới (bao gồm). */
  atSeq: number;
  /** Tổng số seq hiện có trong log. */
  totalSeq: number;
  /** Số event đã fold (prefix tới atSeq). */
  eventsUsed: number;
  /** Trạng thái run tại điểm đó (fold của prefix). */
  state: ReplayedRunState;
}

/**
 * Quay lại một điểm trong run: fold prefix event seq 1..`atSeq`.
 * `atSeq` = 0 → trạng thái rỗng (chưa có event nào). Ném lỗi khi
 * run không có event nào hoặc `atSeq` ngoài khoảng.
 */
export function replayUpTo(store: RunLogStore, runId: string, atSeq: number): TimeTravelResult {
  const { events } = store.readRun(runId);
  if (events.length === 0) throw new Error(`Không time-travel được: run ${runId} chưa có event nào.`);
  const totalSeq = events[events.length - 1]!.seq;
  if (!Number.isInteger(atSeq) || atSeq < 0 || atSeq > totalSeq) {
    throw new Error(`atSeq ${atSeq} ngoài khoảng 0..${totalSeq} của run ${runId}.`);
  }
  const prefix = events.filter((e) => e.seq <= atSeq);
  return {
    runId,
    atSeq,
    totalSeq,
    eventsUsed: prefix.length,
    state: foldEvents(runId, prefix),
  };
}

/** Bí danh đọc xuôi hơn cho `replayUpTo`. */
export const timeTravelTo = replayUpTo;

/**
 * Fork một run tại một seq cụ thể (bọc `forkRun`): tạo run con từ
 * prefix tới `fromSeq`. Khác `forkRun` ở chỗ `fromSeq` là bắt buộc
 * (time-travel fork luôn nói rõ điểm fork), và kết quả kèm trạng
 * thái của run con tại điểm fork để caller kiểm tra ngay.
 */
export function forkRunAt(
  store: RunLogStore,
  parentRunId: string,
  fromSeq: number,
  options: {
    childRunId?: string;
    botId?: string;
    model?: string;
    providerId?: string;
  } = {},
): ForkRunResult & { childStateAtFork: ReplayedRunState } {
  const result = forkRun(store, parentRunId, { ...options, fromSeq });
  const childEvents = store.readRun(result.childRunId).events;
  return { ...result, childStateAtFork: foldEvents(result.childRunId, childEvents) };
}

/** So sánh hai trạng thái run (thường là cha vs con sau fork, hoặc hai thời điểm). */
export interface RunStateDiff {
  stepsDelta: number;
  tokensDelta: number;
  toolCallsDelta: number;
  fileChangesDelta: number;
  errorsDelta: number;
  transcriptDelta: number;
  statusChanged: boolean;
  /** Tóm tắt một dòng để hiển thị. */
  summary: string;
}

/** Diff số học giữa hai trạng thái đã fold. */
export function compareRunStates(a: ReplayedRunState, b: ReplayedRunState): RunStateDiff {
  const stepsDelta = b.steps - a.steps;
  const tokensDelta = b.tokensUsed - a.tokensUsed;
  const toolCallsDelta = b.toolCalls.length - a.toolCalls.length;
  const fileChangesDelta = b.fileChanges.length - a.fileChanges.length;
  const errorsDelta = b.errors.length - a.errors.length;
  const transcriptDelta = b.transcript.length - a.transcript.length;
  const statusChanged = a.status !== b.status;
  const parts: string[] = [];
  if (stepsDelta !== 0) parts.push(`steps ${stepsDelta > 0 ? '+' : ''}${stepsDelta}`);
  if (tokensDelta !== 0) parts.push(`tokens ${tokensDelta > 0 ? '+' : ''}${tokensDelta}`);
  if (toolCallsDelta !== 0) parts.push(`tool calls ${toolCallsDelta > 0 ? '+' : ''}${toolCallsDelta}`);
  if (fileChangesDelta !== 0) parts.push(`files ${fileChangesDelta > 0 ? '+' : ''}${fileChangesDelta}`);
  if (errorsDelta !== 0) parts.push(`errors ${errorsDelta > 0 ? '+' : ''}${errorsDelta}`);
  if (statusChanged) parts.push(`status ${a.status} → ${b.status}`);
  return {
    stepsDelta,
    tokensDelta,
    toolCallsDelta,
    fileChangesDelta,
    errorsDelta,
    transcriptDelta,
    statusChanged,
    summary: parts.length > 0 ? parts.join(', ') : 'identical',
  };
}

/** Một run con (nhánh) của một run cha. */
export interface RunBranch {
  runId: string;
  forkFromSeq: number;
  status: string;
}

/**
 * Liệt kê các run con được fork từ `runId` (đọc metadata
 * `parentRunId` của mọi run trong store). Trả về rỗng khi chưa fork.
 */
export function listChildRuns(store: RunLogStore, runId: string): RunBranch[] {
  const out: RunBranch[] = [];
  for (const meta of store.listRuns()) {
    if (meta.parentRunId === runId) {
      out.push({ runId: meta.runId, forkFromSeq: 0, status: meta.status });
    }
  }
  // forkFromSeq không nằm trong meta — đọc event `run.started` của con.
  for (const branch of out) {
    const { events } = store.readRun(branch.runId);
    const started = events.find((e) => e.type === 'run.started');
    const p = started?.payload as { forkFromSeq?: number } | undefined;
    if (typeof p?.forkFromSeq === 'number') branch.forkFromSeq = p.forkFromSeq;
  }
  return out;
}

/** Tiện ích: mọi event của run dưới dạng bản sao đã sắp theo seq. */
export function readRunEvents(store: RunLogStore, runId: string): AnyRunEvent[] {
  return [...store.readRun(runId).events].sort((a, b) => a.seq - b.seq);
}
