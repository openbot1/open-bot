/**
 * Stuck detection v2 + recovery (v1.29, Đội T3 — coding agent v14).
 *
 * Nối detector cơ sở của event-log (`detectStuck` — đếm tool call /
 * lỗi lặp theo tên tool): v2 thêm CHỮ KÝ VÒNG LẶP (loop signature) —
 * cùng tool + cùng args chuẩn hoá + cùng kết quả chuẩn hoá lặp lại —
 * và phát hiện DAO ĐỘNG (A→B→A→B: agent đổi qua đổi lại giữa hai
 * action mà không tiến triển). Chuẩn hoá kết quả trước khi so sánh:
 * số, đường dẫn tạm, timestamp, hash dài bị thay bằng placeholder để
 * cùng một lỗi với số dòng khác nhau vẫn nhận ra là cùng một lỗi.
 *
 * Recovery không dừng run một cách mù: detector chỉ báo cáo; planner
 * xếp thang leo thang (redirect → thu hẹp scope → hỏi user → rollback
 * lần edit cuối → escalate) theo loại tín hiệu + bối cảnh (có edit để
 * rollback không, có được hỏi user không). Executor chạy từng bước qua
 * handler do caller inject — rollback ghi lại vào nhật ký edit
 * (`V14EditJournal`) để có thể undo, và mọi lần recovery đều ghi
 * event `stuck.recovered` vào run log (xem `eventLogAdapter.ts`).
 *
 * Mọi hàm phân tích đều thuần trên event đã ghi: không gọi model,
 * không đoán ý định — chỉ đếm mẫu lặp và báo cáo.
 */

import { CodingV14Error, V14_STUCK_DEFAULT_STRATEGY, V14_STUCK_SUGGESTION_KEYS } from './types';
import type {
  V14EditJournalEntry,
  V14RecoveryPlan,
  V14RecoveryResult,
  V14RecoveryStep,
  V14RecoveryStrategy,
  V14StuckKind,
  V14StuckOptions,
  V14StuckReport,
  V14StuckSignal,
} from './types';
import type { AnyRunEvent } from '../event-log/types';

/** Ngưỡng mặc định của detector v2. */
export const V14_STUCK_DEFAULTS: Required<V14StuckOptions> = {
  repeatActionThreshold: 3,
  repeatErrorThreshold: 3,
  oscillationThreshold: 2,
  emptyResponseThreshold: 3,
  noProgressStepThreshold: 8,
  windowSteps: 30,
};

/** Chuẩn hoá một chuỗi kết quả/lỗi để so sánh: bỏ số, path tạm, hash, timestamp. */
export function v14NormalizeResultText(text: string): string {
  let out = text.trim().toLowerCase();
  out = out.replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(\.\d+)?(z|[+-]\d{2}:?\d{2})?\b/g, '<time>');
  out = out.replace(/\b[0-9a-f]{16,}\b/g, '<hash>');
  out = out.replace(/(?:\/tmp\/|\/var\/folders\/|c:\\users\\[^\\]+\\appdata\\local\\temp\\)[^\s'"]*/g, '<tmp>');
  out = out.replace(/:\d+(?::\d+)?\b/g, ':<n>');
  out = out.replace(/\b\d+\b/g, '<n>');
  out = out.replace(/\s+/g, ' ');
  return out.slice(0, 300);
}

/** Chuẩn hoá args của một tool call thành chuỗi ổn định (key sắp xếp, value chuẩn hoá). */
export function v14NormalizeArgs(args: Record<string, unknown> | undefined | null): string {
  if (!args || typeof args !== 'object') return '{}';
  const keys = Object.keys(args).sort();
  const parts = keys.map((k) => {
    const v = args[k];
    if (typeof v === 'string') return `${k}=${v14NormalizeResultText(v).slice(0, 120)}`;
    if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${String(v)}`;
    if (Array.isArray(v)) return `${k}=[${v.length}]`;
    if (v && typeof v === 'object') return `${k}={${Object.keys(v as Record<string, unknown>).sort().join(',')}}`;
    return `${k}=${String(v)}`;
  });
  return `{${parts.join(',')}}`;
}

/** Chữ ký của một action: tool + args chuẩn hoá. */
export function v14ActionSignature(tool: string, args?: Record<string, unknown> | null): string {
  return `${tool} ${v14NormalizeArgs(args)}`;
}

/** Chữ ký của một kết quả: tool + status + output chuẩn hoá (dòng đầu). */
export function v14ResultSignature(tool: string, status: string, outputPreview: string): string {
  const firstLine = outputPreview.split('\n')[0] ?? '';
  return `${tool}:${status}:${v14NormalizeResultText(firstLine)}`;
}

/** Một step đã rút gọn từ event log (để detector làm việc). */
interface V14StepTrace {
  step: number;
  /** Text của model.response ('' khi rỗng). */
  responseText: string;
  /** Các tool call của step (tool + argKeys — log không giữ value). */
  toolCalls: Array<{ tool: string; argKeys: string[]; callId: string }>;
  /** Kết quả theo callId. */
  results: Map<string, { tool: string; status: string; outputPreview: string }>;
  /** Có file.change trong step không. */
  hasFileChange: boolean;
  /** Có tool result ok trong step không. */
  hasToolOk: boolean;
  /** Seq nhỏ nhất / lớn nhất của step. */
  firstSeq: number;
  lastSeq: number;
}

function buildStepTraces(events: readonly AnyRunEvent[]): V14StepTrace[] {
  const byStep = new Map<number, V14StepTrace>();
  const ensure = (step: number, seq: number): V14StepTrace => {
    let t = byStep.get(step);
    if (!t) {
      t = {
        step,
        responseText: '',
        toolCalls: [],
        results: new Map(),
        hasFileChange: false,
        hasToolOk: false,
        firstSeq: seq,
        lastSeq: seq,
      };
      byStep.set(step, t);
    }
    t.firstSeq = Math.min(t.firstSeq, seq);
    t.lastSeq = Math.max(t.lastSeq, seq);
    return t;
  };
  for (const e of events) {
    const p = e.payload as unknown as Record<string, unknown>;
    const step = typeof p['step'] === 'number' ? (p['step'] as number) : 0;
    switch (e.type) {
      case 'model.response': {
        const t = ensure(step, e.seq);
        if (typeof p['text'] === 'string') t.responseText = p['text'] as string;
        const calls = p['toolCalls'];
        if (Array.isArray(calls)) {
          for (const c of calls) {
            const cc = c as { tool?: unknown; callId?: unknown; argKeys?: unknown };
            if (typeof cc.tool !== 'string') continue;
            t.toolCalls.push({
              tool: cc.tool,
              argKeys: Array.isArray(cc.argKeys) ? (cc.argKeys as string[]) : [],
              callId: typeof cc.callId === 'string' ? cc.callId : '',
            });
          }
        }
        break;
      }
      case 'tool.result': {
        const t = ensure(step, e.seq);
        const callId = typeof p['callId'] === 'string' ? (p['callId'] as string) : '';
        const tool = typeof p['tool'] === 'string' ? (p['tool'] as string) : '';
        const status = typeof p['status'] === 'string' ? (p['status'] as string) : '';
        t.results.set(callId, {
          tool,
          status,
          outputPreview: typeof p['outputPreview'] === 'string' ? (p['outputPreview'] as string) : '',
        });
        if (status === 'ok') t.hasToolOk = true;
        break;
      }
      case 'file.change': {
        const t = ensure(step, e.seq);
        t.hasFileChange = true;
        break;
      }
      default:
        break;
    }
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step);
}

/** Thứ tự ưu tiên tín hiệu (để chọn suggestion/strategy mạnh nhất). */
const V14_SIGNAL_PRIORITY: V14StuckKind[] = [
  'repeat_error',
  'repeat_action',
  'oscillation',
  'empty_response',
  'no_progress',
];

/**
 * Phát hiện kẹt v2 trên event log (pure). Trả báo cáo + gợi ý recovery.
 * Log rỗng → không kẹt (step 0, signals rỗng).
 */
export function v14DetectStuck(
  events: readonly AnyRunEvent[],
  runId: string,
  options: V14StuckOptions = {},
): V14StuckReport {
  if (!runId || runId.trim() === '') {
    throw new CodingV14Error('stuck-invalid', 'runId must be a non-empty string.');
  }
  const o = { ...V14_STUCK_DEFAULTS, ...options };
  const traces = buildStepTraces(events);
  const step = traces.length === 0 ? 0 : traces[traces.length - 1]!.step;
  const windowed = traces.slice(-Math.max(1, o.windowSteps));
  const signals: V14StuckSignal[] = [];

  // 1. repeat_action: cùng chữ ký action (tool + argKeys) lặp lại.
  //    Log chỉ giữ argKeys (không giữ value) nên signature ở đây là
  //    tool + argKeys đã sắp xếp — đủ để bắt loop gọi cùng tool cùng
  //    dạng args; so sánh value đầy đủ do caller (agent) làm thêm.
  const actionCounts = new Map<string, { count: number; firstSeq: number; lastSeq: number }>();
  for (const t of windowed) {
    for (const c of t.toolCalls) {
      const sig = `${c.tool}(${[...c.argKeys].sort().join(',')})`;
      const entry = actionCounts.get(sig) ?? { count: 0, firstSeq: t.firstSeq, lastSeq: t.lastSeq };
      entry.count += 1;
      entry.lastSeq = t.lastSeq;
      actionCounts.set(sig, entry);
    }
  }
  for (const [sig, entry] of [...actionCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    if (entry.count >= o.repeatActionThreshold) {
      signals.push({
        kind: 'repeat_action',
        count: entry.count,
        detail: `same tool call repeated ${entry.count}x: ${sig}`,
        signature: sig,
        firstSeq: entry.firstSeq,
        lastSeq: entry.lastSeq,
      });
      break; // Chỉ báo tín hiệu mạnh nhất mỗi loại.
    }
  }

  // 2. repeat_error: cùng lỗi chuẩn hoá lặp lại.
  const errorCounts = new Map<string, { count: number; firstSeq: number; lastSeq: number }>();
  for (const t of windowed) {
    for (const r of t.results.values()) {
      if (r.status !== 'error') continue;
      const sig = v14ResultSignature(r.tool, r.status, r.outputPreview);
      const entry = errorCounts.get(sig) ?? { count: 0, firstSeq: t.firstSeq, lastSeq: t.lastSeq };
      entry.count += 1;
      entry.lastSeq = t.lastSeq;
      errorCounts.set(sig, entry);
    }
  }
  for (const [sig, entry] of [...errorCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    if (entry.count >= o.repeatErrorThreshold) {
      signals.push({
        kind: 'repeat_error',
        count: entry.count,
        detail: `same error repeated ${entry.count}x: ${sig.slice(0, 200)}`,
        signature: sig,
        firstSeq: entry.firstSeq,
        lastSeq: entry.lastSeq,
      });
      break;
    }
  }

  // 3. oscillation: chu kỳ A→B→A→B (2 action luân phiên nhau).
  const actionSeq: string[] = [];
  for (const t of windowed) {
    for (const c of t.toolCalls) actionSeq.push(`${c.tool}(${[...c.argKeys].sort().join(',')})`);
  }
  const osc = detectOscillation(actionSeq, o.oscillationThreshold);
  if (osc) {
    const firstIdx = actionSeq.indexOf(osc.a);
    signals.push({
      kind: 'oscillation',
      count: osc.cycles,
      detail: `oscillating between ${osc.a} and ${osc.b} (${osc.cycles} cycles)`,
      signature: `${osc.a} <-> ${osc.b}`,
      firstSeq: windowed[0]?.firstSeq ?? 0,
      lastSeq: windowed[windowed.length - 1]?.lastSeq ?? 0,
    });
    void firstIdx;
  }

  // 4. empty_response: response rỗng kèm tool call liên tiếp.
  let emptyRun = 0;
  let emptyFirstSeq = 0;
  let emptyLastSeq = 0;
  for (const t of windowed) {
    if (t.responseText.trim() === '' && t.toolCalls.length > 0) {
      if (emptyRun === 0) emptyFirstSeq = t.firstSeq;
      emptyRun += 1;
      emptyLastSeq = t.lastSeq;
    } else {
      emptyRun = 0;
    }
  }
  if (emptyRun >= o.emptyResponseThreshold) {
    signals.push({
      kind: 'empty_response',
      count: emptyRun,
      detail: `empty model response with tool calls ${emptyRun}x in a row`,
      signature: '',
      firstSeq: emptyFirstSeq,
      lastSeq: emptyLastSeq,
    });
  }

  // 5. no_progress: N step cuối không file change và không tool ok.
  let noProgress = 0;
  let npFirstSeq = 0;
  let npLastSeq = 0;
  for (let i = windowed.length - 1; i >= 0; i -= 1) {
    const t = windowed[i]!;
    if (!t.hasFileChange && !t.hasToolOk) {
      if (noProgress === 0) {
        npLastSeq = t.lastSeq;
        npFirstSeq = t.firstSeq;
      } else {
        npFirstSeq = t.firstSeq;
      }
      noProgress += 1;
    } else {
      break;
    }
  }
  if (noProgress >= o.noProgressStepThreshold) {
    signals.push({
      kind: 'no_progress',
      count: noProgress,
      detail: `${noProgress} steps without file change or successful tool call`,
      signature: '',
      firstSeq: npFirstSeq,
      lastSeq: npLastSeq,
    });
  }

  signals.sort((a, b) => V14_SIGNAL_PRIORITY.indexOf(a.kind) - V14_SIGNAL_PRIORITY.indexOf(b.kind));
  const stuck = signals.length > 0;
  const top = signals[0];
  return {
    runId,
    stuck,
    step,
    signals,
    ...(top ? { suggestedStrategy: V14_STUCK_DEFAULT_STRATEGY[top.kind] } : {}),
    ...(top ? { suggestionKey: V14_STUCK_SUGGESTION_KEYS[top.kind] } : {}),
  };
}

/** Phát hiện dao động A→B→A→B trong dãy action (trả số chu kỳ khi đủ ngưỡng). */
export function detectOscillation(
  actions: readonly string[],
  threshold: number,
): { a: string; b: string; cycles: number } | null {
  if (actions.length < 4 || threshold < 1) return null;
  for (let i = 0; i + 3 < actions.length; i += 1) {
    const a = actions[i]!;
    const b = actions[i + 1]!;
    if (a === b) continue;
    let cycles = 0;
    let j = i;
    while (j + 1 < actions.length && actions[j] === a && actions[j + 1] === b) {
      cycles += 1;
      j += 2;
    }
    if (cycles >= threshold) return { a, b, cycles };
  }
  return null;
}

/* ================================================================== */
/* Edit journal — rollback lần sửa cuối                                 */
/* ================================================================== */

/** Hàm áp dụng nội dung file khi rollback (null = xoá file). */
export type V14FileApplier = (path: string, content: string | null) => void;

/**
 * Nhật ký edit trong memory: mỗi lần agent sửa file thì `record`,
 * rollback lần sửa cuối qua `rollbackLast`. Không giữ file thật —
 * caller giữ nội dung (before/after) khi record.
 */
export class V14EditJournal {
  private readonly entries: V14EditJournalEntry[] = [];

  /** Ghi một lần sửa file vào journal (trả entry đã tạo). */
  record(
    runId: string,
    path: string,
    beforeContent: string | null,
    afterContent: string | null,
    step: number,
    seq = 0,
    createdAt?: string,
  ): V14EditJournalEntry {
    if (!path || path.trim() === '') {
      throw new CodingV14Error('journal-edit-not-found', 'edit path must be a non-empty string.');
    }
    const entry: V14EditJournalEntry = {
      id: `ej-${runId}-${this.entries.length + 1}`,
      runId,
      path,
      beforeContent,
      afterContent,
      step,
      seq,
      undone: false,
      createdAt: createdAt ?? new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  /** Mọi entry (theo thứ tự ghi). */
  all(): V14EditJournalEntry[] {
    return [...this.entries];
  }

  /** Entry sửa cuối cùng chưa rollback (undefined khi không có). */
  lastEdit(): V14EditJournalEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (!this.entries[i]!.undone) return this.entries[i];
    }
    return undefined;
  }

  /** Tìm entry theo id. */
  find(id: string): V14EditJournalEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Rollback một entry: áp lại `beforeContent` (null = xoá file),
   * đánh dấu undone. Ném lỗi khi entry không tồn tại hoặc đã undone.
   */
  rollback(entryId: string, applier: V14FileApplier): V14EditJournalEntry {
    const entry = this.find(entryId);
    if (!entry) throw new CodingV14Error('journal-edit-not-found', `edit journal entry not found: ${entryId}`);
    if (entry.undone) throw new CodingV14Error('recovery-rollback-failed', `edit already rolled back: ${entryId}`);
    try {
      applier(entry.path, entry.beforeContent);
    } catch (err) {
      throw new CodingV14Error(
        'recovery-rollback-failed',
        `rollback failed for ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    entry.undone = true;
    return entry;
  }

  /** Rollback lần sửa cuối chưa undone. */
  rollbackLast(applier: V14FileApplier): V14EditJournalEntry {
    const last = this.lastEdit();
    if (!last) throw new CodingV14Error('recovery-edit-not-found', 'no edit to roll back (journal is empty or all undone).');
    return this.rollback(last.id, applier);
  }

  /** Số entry chưa rollback. */
  pendingCount(): number {
    return this.entries.filter((e) => !e.undone).length;
  }
}

/* ================================================================== */
/* Recovery planner + executor                                         */
/* ================================================================== */

/** Bối cảnh để planner chọn bước recovery. */
export interface V14RecoveryContext {
  /** Có edit nào để rollback không. */
  hasLastEdit: boolean;
  /** Có được hỏi user không (khi false, bỏ qua ask_user). */
  allowAskUser: boolean;
  /** Task hiện tại (để sinh câu redirect / thu hẹp scope). */
  taskSummary: string;
  /** Số lần đã recovery trong run này (để leo thang). */
  priorRecoveries: number;
}

/**
 * Lập kế hoạch recovery cho một tín hiệu kẹt: thang leo thang theo
 * loại tín hiệu + bối cảnh. Bước đầu là bước nên thử trước; các bước
 * sau là phương án dự phòng khi bước trước không hiệu quả.
 */
export function v14PlanRecovery(
  runId: string,
  signal: V14StuckSignal,
  context: V14RecoveryContext,
): V14RecoveryPlan {
  const steps: V14RecoveryStep[] = [];
  const task = context.taskSummary.trim() === '' ? 'the current task' : context.taskSummary;
  const baseStrategy = V14_STUCK_DEFAULT_STRATEGY[signal.kind];
  const push = (strategy: V14RecoveryStrategy, rationale: string, instruction: string): void => {
    if (!steps.some((s) => s.strategy === strategy)) steps.push({ strategy, rationale, instruction });
  };

  if (baseStrategy === 'redirect') {
    push(
      'redirect',
      `signal ${signal.kind} repeated ${signal.count}x — try a different approach instead of repeating the same action`,
      `Stop repeating the same action (${signal.signature}). Try a different approach for ${task}: break it into a smaller sub-step, use a different tool, or inspect the current state first before acting again.`,
    );
  }
  if (baseStrategy === 'narrow_scope' || signal.kind === 'repeat_error') {
    push(
      'narrow_scope',
      `signal ${signal.kind} repeated ${signal.count}x — shrink the scope to the smallest failing piece`,
      `Narrow the scope of ${task} to the smallest piece that still fails, reproduce it in isolation, and fix that piece before returning to the full task.`,
    );
  }
  if (signal.kind === 'empty_response') {
    push(
      'ask_user',
      'model keeps returning empty responses with tool calls — user guidance is needed',
      `The model keeps returning empty responses. Ask the user: "${task}" — what should I try next, or should I stop and summarize what has been tried so far?`,
    );
  }
  if (context.hasLastEdit) {
    push(
      'rollback_last_edit',
      'a recent edit may have caused the loop — undo it to a known-good state',
      'Roll back the most recent file edit to its previous content, then re-check whether the loop persists before editing again.',
    );
  }
  if (context.allowAskUser && baseStrategy !== 'ask_user' && signal.kind !== 'empty_response') {
    push(
      'ask_user',
      'automated strategies may not be enough — ask the user for direction',
      `I am stuck on ${task} (${signal.detail}). Ask the user which direction to take, or whether to stop and report progress so far.`,
    );
  }
  // Leo thang: đã recovery nhiều lần mà vẫn kẹt → escalate.
  if (context.priorRecoveries >= 2) {
    steps.unshift({
      strategy: 'escalate',
      rationale: `${context.priorRecoveries} prior recoveries did not resolve the loop — escalate instead of looping recovery`,
      instruction: `Stop automatic recovery for ${task}: ${context.priorRecoveries} recoveries already failed. Report the stuck signal (${signal.detail}) to the user and wait for direction.`,
    });
  }
  if (steps.length === 0) {
    steps.push({
      strategy: 'escalate',
      rationale: 'no automated recovery applies in this context',
      instruction: `No automated recovery applies for ${task}. Report the stuck signal (${signal.detail}) to the user and wait for direction.`,
    });
  }
  return { runId, signal, steps, hasRollback: context.hasLastEdit };
}

/** Handler thực thi một chiến lược recovery (caller inject). */
export interface V14RecoveryExecutors {
  /** Áp dụng redirect: trả instruction đã gửi cho model (để log). */
  redirect?: (instruction: string) => string;
  /** Áp dụng narrow_scope: trả scope mới. */
  narrowScope?: (instruction: string) => string;
  /** Hỏi user: trả câu hỏi đã gửi. */
  askUser?: (instruction: string) => string;
  /** Rollback lần edit cuối (dùng journal + applier của caller). */
  rollbackLastEdit?: () => V14EditJournalEntry;
  /** Escalate: trả thông báo đã gửi cho user. */
  escalate?: (instruction: string) => string;
}

/**
 * Thực thi bước đầu tiên của kế hoạch (hoặc một strategy chỉ định).
 * Trả kết quả (applied=false khi không có handler cho strategy đó —
 * caller vẫn ghi nhận để không thử lại mù).
 */
export function v14ExecuteRecovery(
  plan: V14RecoveryPlan,
  executors: V14RecoveryExecutors,
  strategy?: V14RecoveryStrategy,
): V14RecoveryResult {
  const step: V14RecoveryStep | undefined =
    strategy === undefined ? plan.steps[0] : plan.steps.find((s) => s.strategy === strategy);
  if (!step) {
    throw new CodingV14Error(
      'recovery-no-strategy',
      `no recovery step found for strategy ${strategy ?? '(first)'} in run ${plan.runId}.`,
    );
  }
  switch (step.strategy) {
    case 'redirect': {
      const out = executors.redirect ? executors.redirect(step.instruction) : step.instruction;
      return { runId: plan.runId, strategy: 'redirect', applied: executors.redirect !== undefined, detail: out.slice(0, 500), markerSeq: 0 };
    }
    case 'narrow_scope': {
      const out = executors.narrowScope ? executors.narrowScope(step.instruction) : step.instruction;
      return { runId: plan.runId, strategy: 'narrow_scope', applied: executors.narrowScope !== undefined, detail: out.slice(0, 500), markerSeq: 0 };
    }
    case 'ask_user': {
      const out = executors.askUser ? executors.askUser(step.instruction) : step.instruction;
      return { runId: plan.runId, strategy: 'ask_user', applied: executors.askUser !== undefined, detail: out.slice(0, 500), markerSeq: 0 };
    }
    case 'rollback_last_edit': {
      if (!executors.rollbackLastEdit) {
        return { runId: plan.runId, strategy: 'rollback_last_edit', applied: false, detail: 'no rollback executor provided', markerSeq: 0 };
      }
      const entry = executors.rollbackLastEdit();
      return {
        runId: plan.runId,
        strategy: 'rollback_last_edit',
        applied: true,
        detail: `rolled back ${entry.path} (edit ${entry.id}, step ${entry.step})`,
        markerSeq: 0,
      };
    }
    case 'escalate': {
      const out = executors.escalate ? executors.escalate(step.instruction) : step.instruction;
      return { runId: plan.runId, strategy: 'escalate', applied: executors.escalate !== undefined, detail: out.slice(0, 500), markerSeq: 0 };
    }
    default: {
      const _exhaustive: never = step.strategy;
      throw new CodingV14Error('recovery-no-strategy', `unknown recovery strategy: ${String(_exhaustive)}`);
    }
  }
}

/** Render ngắn một báo cáo kẹt để hiển thị/log. */
export function renderV14StuckReport(report: V14StuckReport): string {
  if (!report.stuck) return `[v14 stuck run=${report.runId} step=${report.step}: not stuck]`;
  const sigs = report.signals.map((s) => `${s.kind}x${s.count} (${s.detail.slice(0, 120)})`).join('; ');
  return `[v14 stuck run=${report.runId} step=${report.step}: ${sigs} → ${report.suggestedStrategy ?? 'escalate'}]`;
}
