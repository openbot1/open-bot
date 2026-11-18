/**
 * Eval harness v20 — chạy eval, tính % resolved + cost/task, so baseline
 * (v1.33, Đội T6).
 *
 * Tầng tổng hợp thuần cho panel Eval v20. Nối vào hệ eval hiện có trong
 * repo thay vì viết song song: `eval/runner.ts` đã có runner + so sánh
 * hồi quy cho memory eval, `eval/datasets.ts` + `eval/harborTask.ts`
 * đã có dataset/task chuẩn; module này không chạy model, không thay
 * thế runner — nó trả lời câu panel Eval cần mà runner chưa trả lời,
 * cho eval kiểu "task-based" chung (SWE-bench-style: mỗi task có test
 * pass/fail, cost, thời gian):
 *
 * - TASK NÀO ĐÃ RESOLVED: mỗi task có verdict riêng (resolved /
 *   failed / timeout / error) + bằng chứng (test đã chạy, output trích)
 *   — % resolved chỉ tính trên task đã chạy xong, task chưa chạy không
 *   tính vào mẫu số (tránh báo % đẹp nhờ task chưa chạy).
 * - TỐN BAO NHIÊU MỘT TASK: cost/task + thời gian/task trung bình,
 *   trung vị, max — panel thấy ngay task nào đắt nhất, task nào chậm nhất.
 * - CÓ HỒI QUY KHÔNG: so với baseline run (cùng suite, cùng version
 *   task) — resolved giảm quá ngưỡng hoặc cost tăng quá ngưỡng thì báo
 *   regression, kèm danh sách task đổi trạng thái (resolved → failed
 *   là hồi quy nặng nhất).
 * - CHẠY LẠI CÁI GÌ: run chưa xong (còn task pending) thì `pendingTasks`
 *   cho biết chạy tiếp task nào; run đã xong thì không chạy lại mù —
 *   panel chỉ đề xuất chạy lại task failed/timeout.
 *
 * Mọi hàm đều pure: host/runner thật ghi kết quả từng task bằng
 * `recordEvalV20TaskResult`, panel gọi `buildEvalV20Report` để render.
 * Không gọi model, không đọc file, không chạm mạng.
 */

export type EvalV20TaskVerdict = 'resolved' | 'failed' | 'timeout' | 'error' | 'pending';

/** Một task trong suite eval. */
export interface EvalV20Task {
  /** Id task, vd `swe-task-001`. */
  id: string;
  /** Mô tả ngắn task yêu cầu làm gì. */
  description: string;
  /** Nhóm, vd `coding`, `memory`, `tool-use` — để báo % theo nhóm. */
  category: string;
  /** Độ khó 1–5 (để báo % theo độ khó). */
  difficulty: number;
  /** Lệnh kiểm chứng (test) của task — runner chạy lệnh này để verdict. */
  verifyCommand: string;
}

/** Kết quả chạy một task. */
export interface EvalV20TaskResult {
  taskId: string;
  verdict: EvalV20TaskVerdict;
  /** Số test pass / tổng số test của task (nếu có). */
  testsPassed?: number;
  testsTotal?: number;
  /** Chi phí chạy task (USD, hoặc đơn vị cost nội bộ — phải nhất quán trong một run). */
  cost: number;
  /** Thời gian chạy (ms). */
  durationMs: number;
  /** Trích output kiểm chứng — bằng chứng, không phải lời khẳng định. */
  outputExcerpt?: string;
  /** Lỗi (khi verdict = error/timeout). */
  error?: string;
  at: number;
}

/** Một lần chạy eval (một suite, một model/config). */
export interface EvalV20Run {
  /** Id run ổn định, vd `eval-2026-11-17-001`. */
  id: string;
  /** Tên suite, vd `fleet-v20-smoke`. */
  suiteName: string;
  /** Model/config đã chạy, vd `gemini-2.5-flash` — để so sánh công bằng. */
  model: string;
  tasks: EvalV20Task[];
  /** Kết quả theo taskId (task chưa chạy thì không có entry = pending). */
  results: Record<string, EvalV20TaskResult>;
  startedAt: number;
  finishedAt?: number;
}

export function createEvalV20Run(
  id: string,
  suiteName: string,
  model: string,
  tasks: EvalV20Task[],
  startedAt: number = Date.now(),
): EvalV20Run {
  return { id, suiteName, model, tasks: tasks.map((t) => ({ ...t })), results: {}, startedAt };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EVAL_TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate một task eval: trả lỗi, rỗng = hợp lệ. */
export function validateEvalV20Task(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['Task eval v20 phải là một object.'];
  }
  const t = raw as Record<string, unknown>;
  if (typeof t['id'] !== 'string' || !EVAL_TASK_ID_RE.test(t['id'] as string)) {
    errors.push('Task eval cần "id" chữ thường/số/gạch ngang, bắt đầu bằng chữ/số.');
  }
  if (typeof t['description'] !== 'string' || (t['description'] as string).trim().length === 0) {
    errors.push('Task eval cần "description" không rỗng.');
  }
  if (typeof t['category'] !== 'string' || (t['category'] as string).trim().length === 0) {
    errors.push('Task eval cần "category" không rỗng (vd coding, memory, tool-use).');
  }
  if (typeof t['difficulty'] !== 'number' || !Number.isInteger(t['difficulty']) || (t['difficulty'] as number) < 1 || (t['difficulty'] as number) > 5) {
    errors.push('Task eval: "difficulty" phải là số nguyên 1–5.');
  }
  if (typeof t['verifyCommand'] !== 'string' || (t['verifyCommand'] as string).trim().length === 0) {
    errors.push('Task eval cần "verifyCommand" không rỗng — task không có lệnh kiểm chứng thì verdict không có bằng chứng.');
  }
  return errors;
}

/** Validate một kết quả task: trả lỗi, rỗng = hợp lệ. */
export function validateEvalV20TaskResult(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['Kết quả task eval v20 phải là một object.'];
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['taskId'] !== 'string' || (r['taskId'] as string).trim().length === 0) {
    errors.push('Kết quả task cần "taskId" không rỗng.');
  }
  if (!['resolved', 'failed', 'timeout', 'error', 'pending'].includes(String(r['verdict']))) {
    errors.push('Kết quả task: "verdict" phải là resolved/failed/timeout/error/pending.');
  }
  if (typeof r['cost'] !== 'number' || (r['cost'] as number) < 0) {
    errors.push('Kết quả task: "cost" phải là số >= 0.');
  }
  if (typeof r['durationMs'] !== 'number' || (r['durationMs'] as number) < 0) {
    errors.push('Kết quả task: "durationMs" phải là số >= 0.');
  }
  if (r['testsPassed'] !== undefined && r['testsTotal'] !== undefined) {
    const passed = r['testsPassed'] as number;
    const total = r['testsTotal'] as number;
    if (typeof passed !== 'number' || typeof total !== 'number' || passed < 0 || total <= 0 || passed > total) {
      errors.push('Kết quả task: "testsPassed" phải là số >= 0 và <= "testsTotal" (> 0).');
    }
  }
  if (r['verdict'] === 'resolved' && r['testsTotal'] !== undefined && r['testsPassed'] !== undefined && r['testsPassed'] !== r['testsTotal']) {
    errors.push('Kết quả task mâu thuẫn: verdict "resolved" nhưng testsPassed < testsTotal — resolved nghĩa là mọi test đều pass.');
  }
  return errors;
}

/** Validate cả run (task trùng id, kết quả trỏ tới task không có, run rỗng). */
export function validateEvalV20Run(run: EvalV20Run): string[] {
  const errors: string[] = [];
  if (run.tasks.length === 0) errors.push(`Run "${run.id}": suite trống — cần ít nhất 1 task.`);
  const seen = new Set<string>();
  for (const task of run.tasks) {
    const taskErrors = validateEvalV20Task(task);
    errors.push(...taskErrors.map((e) => `Task ${task.id ?? '?'}: ${e}`));
    if (seen.has(task.id)) errors.push(`Task id trùng: "${task.id}" — mỗi task cần id duy nhất trong run.`);
    seen.add(task.id);
  }
  for (const [taskId, result] of Object.entries(run.results)) {
    if (!seen.has(taskId)) {
      errors.push(`Kết quả cho task "${taskId}" không có trong suite — kết quả lạ, kiểm tra lại runner.`);
    }
    const resultErrors = validateEvalV20TaskResult(result);
    errors.push(...resultErrors.map((e) => `Kết quả ${taskId}: ${e}`));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Ghi kết quả + trạng thái run
// ---------------------------------------------------------------------------

/**
 * Ghi kết quả một task vào run (bản sao mới): task không có trong suite
 * → lỗi, không ghi; kết quả không hợp lệ → lỗi rõ, không ghi; ghi đè
 * kết quả cũ của cùng task thì được (chạy lại) nhưng phải ghi đè toàn
 * bộ, không merge nửa vời.
 */
export function recordEvalV20TaskResult(
  run: EvalV20Run,
  result: EvalV20TaskResult,
): { run: EvalV20Run; ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!run.tasks.some((t) => t.id === result.taskId)) {
    errors.push(`Task "${result.taskId}" không có trong suite "${run.suiteName}" — không ghi kết quả lạ.`);
  }
  errors.push(...validateEvalV20TaskResult(result));
  if (errors.length > 0) return { run, ok: false, errors };
  const next: EvalV20Run = {
    ...run,
    tasks: run.tasks.map((t) => ({ ...t })),
    results: { ...run.results, [result.taskId]: { ...result } },
  };
  return { run: next, ok: true, errors: [] };
}

/** Task chưa có kết quả (hoặc kết quả đang pending) — run chưa xong. */
export function pendingEvalV20Tasks(run: EvalV20Run): EvalV20Task[] {
  return run.tasks.filter((t) => {
    const r = run.results[t.id];
    return r === undefined || r.verdict === 'pending';
  });
}

/** true khi mọi task đã có kết quả cuối (không pending). */
export function isEvalV20RunComplete(run: EvalV20Run): boolean {
  return pendingEvalV20Tasks(run).length === 0;
}

/** Task nên chạy lại: failed/timeout/error (resolved thì không chạy lại mù). */
export function retryableEvalV20Tasks(run: EvalV20Run): EvalV20Task[] {
  return run.tasks.filter((t) => {
    const r = run.results[t.id];
    return r !== undefined && (r.verdict === 'failed' || r.verdict === 'timeout' || r.verdict === 'error');
  });
}

// ---------------------------------------------------------------------------
// Thống kê: % resolved, cost/task, thời gian
// ---------------------------------------------------------------------------

export interface EvalV20Stats {
  total: number;
  completed: number;
  pending: number;
  resolved: number;
  failed: number;
  timeout: number;
  error: number;
  /** % resolved trên task ĐÃ CHẠY XONG (null khi chưa chạy xong task nào). */
  resolvedPct: number | null;
  /** Tổng cost / tổng thời gian của task đã chạy xong. */
  totalCost: number;
  totalDurationMs: number;
  /** Trung bình / trung vị / max — chỉ trên task đã chạy xong. */
  avgCostPerTask: number | null;
  medianCostPerTask: number | null;
  maxCostPerTask: number | null;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
  maxDurationMs: number | null;
  /** Task đắt nhất / chậm nhất (để panel chỉ ra ngay). */
  mostExpensiveTaskId: string | null;
  slowestTaskId: string | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeEvalV20Stats(run: EvalV20Run): EvalV20Stats {
  const results = Object.values(run.results).filter((r) => r.verdict !== 'pending');
  const completed = results.length;
  const resolved = results.filter((r) => r.verdict === 'resolved').length;
  const failed = results.filter((r) => r.verdict === 'failed').length;
  const timeout = results.filter((r) => r.verdict === 'timeout').length;
  const error = results.filter((r) => r.verdict === 'error').length;
  const costs = results.map((r) => r.cost);
  const durations = results.map((r) => r.durationMs);
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const totalDurationMs = durations.reduce((a, b) => a + b, 0);
  let mostExpensiveTaskId: string | null = null;
  let slowestTaskId: string | null = null;
  if (results.length > 0) {
    mostExpensiveTaskId = results.reduce((a, b) => (b.cost > a.cost ? b : a)).taskId;
    slowestTaskId = results.reduce((a, b) => (b.durationMs > a.durationMs ? b : a)).taskId;
  }
  return {
    total: run.tasks.length,
    completed,
    pending: run.tasks.length - completed,
    resolved,
    failed,
    timeout,
    error,
    resolvedPct: completed > 0 ? (resolved / completed) * 100 : null,
    totalCost,
    totalDurationMs,
    avgCostPerTask: completed > 0 ? totalCost / completed : null,
    medianCostPerTask: median(costs),
    maxCostPerTask: costs.length > 0 ? Math.max(...costs) : null,
    avgDurationMs: completed > 0 ? totalDurationMs / completed : null,
    medianDurationMs: median(durations),
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : null,
    mostExpensiveTaskId,
    slowestTaskId,
  };
}

/** % resolved theo từng category và từng độ khó (chỉ task đã chạy xong). */
export function computeEvalV20Breakdown(run: EvalV20Run): {
  byCategory: Record<string, { total: number; completed: number; resolved: number; resolvedPct: number | null }>;
  byDifficulty: Record<number, { total: number; completed: number; resolved: number; resolvedPct: number | null }>;
} {
  const byCategory: Record<string, { total: number; completed: number; resolved: number; resolvedPct: number | null }> = {};
  const byDifficulty: Record<number, { total: number; completed: number; resolved: number; resolvedPct: number | null }> = {};
  for (const task of run.tasks) {
    const cat = byCategory[task.category] ?? { total: 0, completed: 0, resolved: 0, resolvedPct: null };
    const dif = byDifficulty[task.difficulty] ?? { total: 0, completed: 0, resolved: 0, resolvedPct: null };
    cat.total += 1;
    dif.total += 1;
    const r = run.results[task.id];
    if (r && r.verdict !== 'pending') {
      cat.completed += 1;
      dif.completed += 1;
      if (r.verdict === 'resolved') {
        cat.resolved += 1;
        dif.resolved += 1;
      }
    }
    byCategory[task.category] = cat;
    byDifficulty[task.difficulty] = dif;
  }
  for (const group of [...Object.values(byCategory), ...Object.values(byDifficulty)]) {
    group.resolvedPct = group.completed > 0 ? (group.resolved / group.completed) * 100 : null;
  }
  return { byCategory, byDifficulty };
}

// ---------------------------------------------------------------------------
// Báo cáo run + so sánh baseline (hồi quy)
// ---------------------------------------------------------------------------

export interface EvalV20Report {
  runId: string;
  suiteName: string;
  model: string;
  complete: boolean;
  stats: EvalV20Stats;
  breakdown: ReturnType<typeof computeEvalV20Breakdown>;
  pendingTaskIds: string[];
  retryableTaskIds: string[];
  summary: string;
}

/** Build báo cáo đầy đủ cho panel Eval từ một run. */
export function buildEvalV20Report(run: EvalV20Run): EvalV20Report {
  const stats = computeEvalV20Stats(run);
  const breakdown = computeEvalV20Breakdown(run);
  const pct = stats.resolvedPct === null ? 'chưa có task nào xong' : `${stats.resolvedPct.toFixed(1)}% resolved`;
  const cost = stats.avgCostPerTask === null ? '' : `, ${stats.avgCostPerTask.toFixed(4)} cost/task`;
  return {
    runId: run.id,
    suiteName: run.suiteName,
    model: run.model,
    complete: isEvalV20RunComplete(run),
    stats,
    breakdown,
    pendingTaskIds: pendingEvalV20Tasks(run).map((t) => t.id),
    retryableTaskIds: retryableEvalV20Tasks(run).map((t) => t.id),
    summary:
      `Eval ${run.suiteName} (${run.model}): ${stats.resolved}/${stats.completed} resolved (${pct})` +
      `, ${stats.failed} failed, ${stats.timeout} timeout, ${stats.error} error` +
      cost +
      (stats.pending > 0 ? `, còn ${stats.pending} task chưa chạy` : ''),
  };
}

export interface EvalV20Regression {
  /** true = có hồi quy (resolved giảm quá ngưỡng HOẶC cost tăng quá ngưỡng). */
  regressed: boolean;
  resolvedPctDelta: number | null;
  avgCostDeltaPct: number | null;
  /** Task đổi từ resolved → failed/timeout/error (hồi quy nặng nhất). */
  newlyFailedTaskIds: string[];
  /** Task đổi từ failed → resolved (cải thiện, để panel thấy cả mặt tốt). */
  newlyResolvedTaskIds: string[];
  /** Ngưỡng đã dùng. */
  thresholds: { maxResolvedDropPct: number; maxCostIncreasePct: number };
  summary: string;
}

export interface EvalV20RegressionThresholds {
  /** Resolved giảm quá số điểm % này → hồi quy (mặc định 5). */
  maxResolvedDropPct: number;
  /** Cost/task trung bình tăng quá số % này → hồi quy (mặc định 20). */
  maxCostIncreasePct: number;
}

/**
 * So sánh run hiện tại với baseline (cùng suite — task id phải khớp;
 * task chỉ có ở một bên thì không tính vào delta, nhưng được liệt kê
 * riêng trong summary để panel thấy suite đã đổi).
 * Lưu ý công bằng: chỉ so khi cùng model; khác model thì delta vẫn tính
 * nhưng summary ghi rõ "khác model" để người đọc không hiểu lầm là
 * hồi quy của code.
 */
export function compareEvalV20ToBaseline(
  current: EvalV20Run,
  baseline: EvalV20Run,
  thresholds: EvalV20RegressionThresholds = { maxResolvedDropPct: 5, maxCostIncreasePct: 20 },
): EvalV20Regression {
  const cur = computeEvalV20Stats(current);
  const base = computeEvalV20Stats(baseline);
  const resolvedPctDelta =
    cur.resolvedPct !== null && base.resolvedPct !== null ? cur.resolvedPct - base.resolvedPct : null;
  const avgCostDeltaPct =
    cur.avgCostPerTask !== null && base.avgCostPerTask !== null && base.avgCostPerTask > 0
      ? ((cur.avgCostPerTask - base.avgCostPerTask) / base.avgCostPerTask) * 100
      : null;
  const newlyFailedTaskIds: string[] = [];
  const newlyResolvedTaskIds: string[] = [];
  for (const task of current.tasks) {
    const c = current.results[task.id];
    const b = baseline.results[task.id];
    if (!c || !b || c.verdict === 'pending' || b.verdict === 'pending') continue;
    const cResolved = c.verdict === 'resolved';
    const bResolved = b.verdict === 'resolved';
    if (bResolved && !cResolved) newlyFailedTaskIds.push(task.id);
    if (!bResolved && cResolved) newlyResolvedTaskIds.push(task.id);
  }
  const resolvedRegressed = resolvedPctDelta !== null && resolvedPctDelta < -thresholds.maxResolvedDropPct;
  const costRegressed = avgCostDeltaPct !== null && avgCostDeltaPct > thresholds.maxCostIncreasePct;
  const regressed = resolvedRegressed || costRegressed;
  const sameModel = current.model === baseline.model;
  const parts: string[] = [];
  if (resolvedPctDelta !== null) parts.push(`resolved ${resolvedPctDelta >= 0 ? '+' : ''}${resolvedPctDelta.toFixed(1)} điểm %`);
  if (avgCostDeltaPct !== null) parts.push(`cost/task ${avgCostDeltaPct >= 0 ? '+' : ''}${avgCostDeltaPct.toFixed(1)}%`);
  if (newlyFailedTaskIds.length > 0) parts.push(`${newlyFailedTaskIds.length} task mới fail: ${newlyFailedTaskIds.join(', ')}`);
  if (newlyResolvedTaskIds.length > 0) parts.push(`${newlyResolvedTaskIds.length} task mới resolved: ${newlyResolvedTaskIds.join(', ')}`);
  return {
    regressed,
    resolvedPctDelta,
    avgCostDeltaPct,
    newlyFailedTaskIds,
    newlyResolvedTaskIds,
    thresholds: { ...thresholds },
    summary:
      `${regressed ? 'HỒI QUY' : 'Không hồi quy'} vs baseline ${baseline.id}` +
      (sameModel ? '' : ` (KHÁC MODEL: baseline ${baseline.model}, hiện tại ${current.model} — delta chưa chắc là hồi quy code)`) +
      (parts.length > 0 ? `: ${parts.join('; ')}` : ': chưa đủ dữ liệu so sánh'),
  };
}
