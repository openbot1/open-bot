/**
 * Delegation v2 — types (v1.04, Đội T4).
 *
 * Ủy quyền agent cha → agent con QUA TOOL CALL, có theo dõi tiến độ
 * và hợp nhất kết quả. Khác với `delegate_task` có sẵn (chạy con rồi
 * trả text, không theo dõi):
 *
 * - Mỗi lần ủy quyền là một `DelegationSession`: id, danh sách con,
 *   chiến lược hợp nhất, trạng thái suy ra từ trạng thái các con.
 * - Mỗi con (`DelegationChildRecord`) có lifecycle riêng (pending →
 *   running → done/error/timeout) + tiến độ (steps, tool calls — khi
 *   biết runId con, đọc từ event log của nó) + kết quả.
 * - Kết quả hợp nhất theo `DelegationMergeStrategy`: concat (nối),
 *   summarize (trích xuất gọn), verdict (đa số theo verdict có cấu
 *   trúc + liệt kê xung đột).
 *
 * Module này KHÔNG chạy agent con: runner do caller tiêm vào (tool
 * dùng `ctx.runSubagent` có sẵn — xem `tools/delegationTools.ts`).
 */

import type { RunLogStore } from '../event-log/store';

/** Trạng thái một lần ủy quyền con. */
export type DelegationChildStatus = 'pending' | 'running' | 'done' | 'error' | 'timeout';

/** Trạng thái tổng của một session (suy ra từ các con). */
export type DelegationSessionStatus = 'pending' | 'running' | 'done' | 'error' | 'timeout';

/** Chiến lược hợp nhất kết quả các con. */
export type DelegationMergeStrategy = 'concat' | 'summarize' | 'verdict';

/** Việc giao cho một agent con. */
export interface DelegationChildInput {
  /** Tên hiển thị của con (vd `researcher`, dùng làm tiêu đề khi gộp). */
  name: string;
  /** Việc cần giao (mô tả rõ ràng cho agent con). */
  task: string;
  /** Role subagent chuyên biệt (xem `list_subagent_roles`). */
  role?: string;
  /** Model riêng của con (trống = model của cha). */
  model?: string;
  /** Timeout riêng của con, ms (mặc định 120_000). */
  timeoutMs?: number;
}

/** Kết quả một agent con đã chạy xong. */
export interface DelegationChildResult {
  name: string;
  status: 'done' | 'error' | 'timeout';
  /** Kết quả text của con (đã bỏ prefix `[subagent …]` của runner). */
  output: string;
  /** Thời gian chạy, ms. */
  durationMs: number;
  /** Lỗi, chỉ có khi status = error/timeout. */
  error?: string;
  /** Kết luận có cấu trúc của con (nếu có) — dùng để phát hiện xung đột. */
  verdict?: string;
  /** RunId của con trong event log (khi biết — để refresh tiến độ). */
  childRunId?: string;
  /** Số step con đã chạy (khi đọc được từ log). */
  steps?: number;
  /** Số tool call con đã chạy (khi đọc được từ log). */
  toolCalls?: number;
}

/** Tiến độ đang chạy của một con (cập nhật trong lúc con chạy). */
export interface DelegationChildProgress {
  steps?: number;
  toolCalls?: number;
  /** Ghi chú tiến độ (vd tên tool con đang gọi). */
  note?: string;
  lastUpdateAt: string;
}

/** Một agent con trong session (input + lifecycle + kết quả). */
export interface DelegationChildRecord {
  input: DelegationChildInput;
  status: DelegationChildStatus;
  startedAt?: string;
  endedAt?: string;
  /** RunId của con trong event log (khi biết). */
  childRunId?: string;
  progress?: DelegationChildProgress;
  result?: DelegationChildResult;
}

/** Một lần ủy quyền (một hoặc nhiều con). */
export interface DelegationSession {
  id: string;
  /** RunId của agent cha (khi biết — để nối audit). */
  parentRunId?: string;
  children: DelegationChildRecord[];
  strategy: DelegationMergeStrategy;
  status: DelegationSessionStatus;
  startedAt: string;
  endedAt?: string;
  /** Kết quả đã hợp nhất (khi mọi con đã xong). */
  mergedOutput?: string;
  /** Báo cáo hợp nhất (khi mọi con đã xong). */
  mergeReport?: DelegationMergeReport;
}

/** Báo cáo hợp nhất kết quả các con. */
export interface DelegationMergeReport {
  strategy: DelegationMergeStrategy;
  /** Tổng số con. */
  children: number;
  /** Số con xong (done). */
  succeeded: number;
  /** Số con lỗi/timeout. */
  failed: number;
  /** Tên các con có verdict khác nhau (chỉ strategy verdict/summarize). */
  conflicts: string[];
  /** Verdict đa số (chỉ strategy verdict, khi có verdict). */
  majorityVerdict?: string;
  /** Ước lượng token của output đã hợp nhất. */
  mergedTokensEstimate: number;
}

/** Store dùng để refresh tiến độ từ event log (chỉ cần `readRun`/`fold`). */
export type DelegationLogStore = Pick<RunLogStore, 'readRun' | 'exists'>;
