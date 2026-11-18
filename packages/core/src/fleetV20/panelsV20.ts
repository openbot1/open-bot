/**
 * Panels v20 — view-model cho desktop panels Plugin / Hook / Eval
 * (v1.33, Đội T6).
 *
 * Theo pattern panels v15/v16/v17/v19: module chỉ xây VIEW-MODEL thuần
 * từ dữ liệu thật của các tầng dưới; component React render từ đó.
 * Không đọc file, không chạm mạng, không chứa mock.
 *
 * Ba panel trả lời 3 câu riêng (progressive disclosure — tính năng nâng
 * cao nằm sau panel/menu, UI chính giữ sạch, quen Grok Bot):
 *
 * - PLUGIN PANEL: plugin nào đang bật/tắt/lỗi, plugin nào có quyền
 *   nguy hiểm chưa duyệt, plugin nào lỗi dependency — một màn hình để
 *   quản trị plugin mà không cần mở terminal.
 * - HOOK PANEL: hook nào đang bật, hook nào đang chặn action (log chặn
 *   mới nhất trước), hook nào lỗi/tự tắt — một màn hình để biết "ai đã
 *   chặn cái gì, vì sao".
 * - EVAL PANEL: run eval nào mới nhất, % resolved + cost/task, task
 *   nào fail/đắt/chậm nhất, có hồi quy so với baseline không — một màn
 *   hình để quyết định "có merge được không".
 *
 * Thêm một panel phụ SUBAGENT PANEL (trạng thái sóng subagent chuyên
 * biệt v20 — pool đang chạy bao nhiêu con, loại nào, có bị từ chối vì
 * pool đầy không) để panel Plugin/Hook/Eval không phải gánh thêm trách
 * nhiệm hiển thị sóng spawn.
 */

import type { EvalV20Report, EvalV20Regression } from './evalHarnessV20';
import { buildEvalV20Report, compareEvalV20ToBaseline } from './evalHarnessV20';
import type { EvalV20Run } from './evalHarnessV20';
import type { HookV20Store } from './hookManagerV20';
import { queryHookV20Logs, summarizeHookV20Store } from './hookManagerV20';
import type { PluginV20Entry, PluginV20Store } from './pluginManagerV20';
import {
  checkPluginV20Dependencies,
  pluginV20AllowedActions,
  pluginV20Risk,
  pluginV20UnapprovedDangerous,
  searchPluginV20,
  summarizePluginV20Store,
} from './pluginManagerV20';
import type { SubagentV20ContextPool } from './subagentContextV20';
import { summarizeSubagentV20Pool } from './subagentContextV20';

// ---------------------------------------------------------------------------
// Plugin panel
// ---------------------------------------------------------------------------

export interface PluginV20PanelRow {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  capabilities: string[];
  status: string;
  risk: string;
  unapprovedDangerous: string[];
  dependencyProblems: string[];
  /** Nút được phép bấm (panel chỉ hiện nút này). */
  allowedActions: string[];
  installedAt?: number;
  enabledAt?: number;
  errorReason?: string;
}

export interface PluginV20PanelView {
  summary: string;
  total: number;
  enabled: number;
  errored: number;
  highRisk: number;
  unapprovedDangerous: number;
  dependencyProblems: number;
  /** Hàng đã lọc/sắp theo id — panel render trực tiếp, không sắp lại. */
  rows: PluginV20PanelRow[];
  /** Plugin lỗi dependency (để panel hiện cảnh báo riêng). */
  dependencyErrorPluginIds: string[];
}

export function buildPluginV20Panel(
  store: PluginV20Store,
  filters: { query?: string; status?: PluginV20Entry['status']; unapprovedDangerousOnly?: boolean; dependencyProblemOnly?: boolean } = {},
): PluginV20PanelView {
  const summary = summarizePluginV20Store(store);
  const rows: PluginV20PanelRow[] = searchPluginV20(store, filters).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    version: p.version,
    author: p.author,
    capabilities: [...p.capabilities],
    status: p.status,
    risk: pluginV20Risk(p),
    unapprovedDangerous: pluginV20UnapprovedDangerous(p).map((perm) => perm.name),
    dependencyProblems: checkPluginV20Dependencies(p, store).map((d) =>
      d.kind === 'missing'
        ? `Thiếu ${d.dependencyId} (${d.requiredRange})`
        : d.kind === 'version'
          ? `${d.dependencyId} đang ${d.installedVersion ?? '?'} cần ${d.requiredRange}`
          : `${d.dependencyId} đang tắt/lỗi`,
    ),
    allowedActions: pluginV20AllowedActions(p),
    ...(p.installedAt !== undefined ? { installedAt: p.installedAt } : {}),
    ...(p.enabledAt !== undefined ? { enabledAt: p.enabledAt } : {}),
    ...(p.errorReason ? { errorReason: p.errorReason } : {}),
  }));
  return {
    summary: summary.summary,
    total: summary.total,
    enabled: summary.enabled,
    errored: summary.errored,
    highRisk: summary.highRisk,
    unapprovedDangerous: summary.unapprovedDangerous,
    dependencyProblems: summary.dependencyProblems,
    rows,
    dependencyErrorPluginIds: rows.filter((r) => r.dependencyProblems.length > 0).map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Hook panel
// ---------------------------------------------------------------------------

export interface HookV20PanelRow {
  id: string;
  name: string;
  description: string;
  eventPattern: string;
  blocking: boolean;
  priority: number;
  enabled: boolean;
  errored: boolean;
  lastError?: string;
  runCount: number;
  blockCount: number;
  consecutiveErrors: number;
}

export interface HookV20PanelBlockRow {
  id: string;
  hookId: string;
  event: string;
  reason: string;
  durationMs: number;
  at: number;
}

export interface HookV20PanelView {
  summary: string;
  total: number;
  enabled: number;
  blocking: number;
  errored: number;
  totalRuns: number;
  totalBlocks: number;
  rows: HookV20PanelRow[];
  /** Log chặn mới nhất trước (tối đa 20) — panel hiện "ai chặn cái gì". */
  recentBlocks: HookV20PanelBlockRow[];
  /** Hook lỗi (để panel hiện cảnh báo riêng + nút reset lỗi). */
  erroredHookIds: string[];
}

export function buildHookV20Panel(store: HookV20Store): HookV20PanelView {
  const summary = summarizeHookV20Store(store);
  const rows: HookV20PanelRow[] = [...store.hooks]
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.id.localeCompare(b.id)))
    .map((h) => ({
      id: h.id,
      name: h.name,
      description: h.description,
      eventPattern: h.eventPattern,
      blocking: h.blocking,
      priority: h.priority,
      enabled: h.enabled && !h.errored,
      errored: h.errored,
      ...(h.lastError ? { lastError: h.lastError } : {}),
      runCount: h.runCount,
      blockCount: h.blockCount,
      consecutiveErrors: h.consecutiveErrors,
    }));
  const recentBlocks: HookV20PanelBlockRow[] = queryHookV20Logs(store, { blockedOnly: true, limit: 20 }).map((l) => ({
    id: l.id,
    hookId: l.hookId,
    event: l.event,
    reason: l.reason ?? 'Hook đã chặn action (không ghi lý do).',
    durationMs: l.durationMs,
    at: l.at,
  }));
  return {
    summary: summary.summary,
    total: summary.total,
    enabled: summary.enabled,
    blocking: summary.blocking,
    errored: summary.errored,
    totalRuns: summary.totalRuns,
    totalBlocks: summary.totalBlocks,
    rows,
    recentBlocks,
    erroredHookIds: rows.filter((r) => r.errored).map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Eval panel
// ---------------------------------------------------------------------------

export interface EvalV20PanelTaskRow {
  taskId: string;
  description: string;
  category: string;
  difficulty: number;
  verdict: string;
  testsPassed?: number;
  testsTotal?: number;
  cost: number;
  durationMs: number;
  outputExcerpt?: string;
  error?: string;
}

export interface EvalV20PanelView {
  runId: string;
  suiteName: string;
  model: string;
  complete: boolean;
  summary: string;
  resolvedPct: number | null;
  resolved: number;
  completed: number;
  total: number;
  failed: number;
  timeout: number;
  error: number;
  avgCostPerTask: number | null;
  medianCostPerTask: number | null;
  maxCostPerTask: number | null;
  avgDurationMs: number | null;
  mostExpensiveTaskId: string | null;
  slowestTaskId: string | null;
  /** % resolved theo category (chỉ category đã có task chạy xong). */
  byCategory: Record<string, { completed: number; resolved: number; resolvedPct: number | null }>;
  /** Hàng task: fail/timeout/error trước, resolved sau, rồi pending. */
  rows: EvalV20PanelTaskRow[];
  pendingTaskIds: string[];
  retryableTaskIds: string[];
  /** So sánh baseline (nếu host truyền baseline vào) — null khi không có baseline. */
  regression: EvalV20Regression | null;
}

const EVAL_V20_VERDICT_ORDER: Record<string, number> = {
  error: 0,
  timeout: 1,
  failed: 2,
  pending: 3,
  resolved: 4,
};

export function buildEvalV20Panel(run: EvalV20Run, baseline?: EvalV20Run): EvalV20PanelView {
  const report: EvalV20Report = buildEvalV20Report(run);
  const stats = report.stats;
  const byCategory: Record<string, { completed: number; resolved: number; resolvedPct: number | null }> = {};
  for (const [category, group] of Object.entries(report.breakdown.byCategory)) {
    byCategory[category] = { completed: group.completed, resolved: group.resolved, resolvedPct: group.resolvedPct };
  }
  const rows: EvalV20PanelTaskRow[] = run.tasks
    .map((t) => {
      const r = run.results[t.id];
      return {
        taskId: t.id,
        description: t.description,
        category: t.category,
        difficulty: t.difficulty,
        verdict: r?.verdict ?? 'pending',
        ...(r?.testsPassed !== undefined ? { testsPassed: r.testsPassed } : {}),
        ...(r?.testsTotal !== undefined ? { testsTotal: r.testsTotal } : {}),
        cost: r?.cost ?? 0,
        durationMs: r?.durationMs ?? 0,
        ...(r?.outputExcerpt ? { outputExcerpt: r.outputExcerpt } : {}),
        ...(r?.error ? { error: r.error } : {}),
      };
    })
    .sort((a, b) => {
      const order = (EVAL_V20_VERDICT_ORDER[a.verdict] ?? 9) - (EVAL_V20_VERDICT_ORDER[b.verdict] ?? 9);
      if (order !== 0) return order;
      return a.taskId.localeCompare(b.taskId);
    });
  return {
    runId: run.id,
    suiteName: run.suiteName,
    model: run.model,
    complete: report.complete,
    summary: report.summary,
    resolvedPct: stats.resolvedPct,
    resolved: stats.resolved,
    completed: stats.completed,
    total: stats.total,
    failed: stats.failed,
    timeout: stats.timeout,
    error: stats.error,
    avgCostPerTask: stats.avgCostPerTask,
    medianCostPerTask: stats.medianCostPerTask,
    maxCostPerTask: stats.maxCostPerTask,
    avgDurationMs: stats.avgDurationMs,
    mostExpensiveTaskId: stats.mostExpensiveTaskId,
    slowestTaskId: stats.slowestTaskId,
    byCategory,
    rows,
    pendingTaskIds: report.pendingTaskIds,
    retryableTaskIds: report.retryableTaskIds,
    regression: baseline ? compareEvalV20ToBaseline(run, baseline) : null,
  };
}

// ---------------------------------------------------------------------------
// Subagent panel (trạng thái sóng subagent chuyên biệt v20)
// ---------------------------------------------------------------------------

export interface SubagentV20PanelView {
  summary: string;
  active: number;
  maxParallel: number;
  totalAllocated: number;
  rejectedFull: number;
  byKind: Record<string, number>;
  /** Context đang chạy: id + loại + task cha + tuổi (ms) — panel không hiện transcript. */
  activeContexts: { id: string; kind: string; parentTaskId: string; ageMs: number; sealed: boolean }[];
}

export function buildSubagentV20Panel(pool: SubagentV20ContextPool, now: number = Date.now()): SubagentV20PanelView {
  const summary = summarizeSubagentV20Pool(pool);
  return {
    summary: summary.summary,
    active: summary.active,
    maxParallel: summary.maxParallel,
    totalAllocated: summary.totalAllocated,
    rejectedFull: summary.rejectedFull,
    byKind: summary.byKind,
    activeContexts: pool.active.map((c) => ({
      id: c.id,
      kind: c.kind,
      parentTaskId: c.parentTaskId,
      ageMs: Math.max(0, now - c.createdAt),
      sealed: c.sealed,
    })),
  };
}

// ---------------------------------------------------------------------------
// Dashboard v20 — màn hình vào duy nhất (progressive disclosure)
// ---------------------------------------------------------------------------

/**
 * Một mục cần chú ý trên dashboard — panel nào, mức nào, mô tả ngắn.
 * Dashboard chỉ liệt kê, không sửa gì: bấm vào mục thì mở đúng panel
 * con (Plugin/Hook/Eval/Subagent) để xử lý.
 */
export interface FleetV20DashboardAttention {
  panel: 'plugin' | 'hook' | 'eval' | 'subagent';
  level: 'error' | 'warning' | 'info';
  message: string;
}

export interface FleetV20DashboardView {
  summary: string;
  pluginSummary: string;
  hookSummary: string;
  evalSummary: string;
  subagentSummary: string;
  /** Số mục cần chú ý (error + warning). */
  attentionCount: number;
  /** Mục cần chú ý: error trước, warning sau, info cuối. */
  attention: FleetV20DashboardAttention[];
  /** Đếm nhanh để menu hiện badge. */
  counts: {
    pluginsEnabled: number;
    pluginsErrored: number;
    hooksErrored: number;
    hooksBlockedTotal: number;
    evalResolvedPct: number | null;
    evalPending: number;
    subagentsActive: number;
  };
}

/**
 * Build dashboard v20 từ 4 store/run hiện có: mỗi panel đóng góp một
 * dòng tóm tắt + các mục cần chú ý của nó. Eval run là tùy chọn (chưa
 * chạy eval lần nào thì evalSummary nói rõ, không bịa số).
 */
export function buildFleetV20Dashboard(
  pluginStore: PluginV20Store,
  hookStore: HookV20Store,
  pool: SubagentV20ContextPool,
  evalRun?: EvalV20Run,
  evalBaseline?: EvalV20Run,
): FleetV20DashboardView {
  const plugin = buildPluginV20Panel(pluginStore);
  const hook = buildHookV20Panel(hookStore);
  const subagent = buildSubagentV20Panel(pool);
  const evalView = evalRun ? buildEvalV20Panel(evalRun, evalBaseline) : null;
  const attention: FleetV20DashboardAttention[] = [];
  for (const row of plugin.rows) {
    if (row.status === 'error') {
      attention.push({ panel: 'plugin', level: 'error', message: `Plugin "${row.id}" lỗi: ${row.errorReason ?? 'không rõ lý do'}.` });
    }
    if (row.unapprovedDangerous.length > 0) {
      attention.push({ panel: 'plugin', level: 'warning', message: `Plugin "${row.id}" có ${row.unapprovedDangerous.length} quyền nguy hiểm chưa duyệt: ${row.unapprovedDangerous.join(', ')}.` });
    }
    if (row.dependencyProblems.length > 0) {
      attention.push({ panel: 'plugin', level: 'warning', message: `Plugin "${row.id}" lỗi dependency: ${row.dependencyProblems.join('; ')}.` });
    }
  }
  for (const row of hook.rows) {
    if (row.errored) {
      attention.push({ panel: 'hook', level: 'error', message: `Hook "${row.id}" lỗi (${row.lastError ?? 'không rõ lý do'}) và đã tự tắt.` });
    }
  }
  if (evalView) {
    for (const row of evalView.rows) {
      if (row.verdict === 'failed' || row.verdict === 'timeout' || row.verdict === 'error') {
        attention.push({ panel: 'eval', level: 'warning', message: `Eval task "${row.taskId}" ${row.verdict}${row.error ? `: ${row.error}` : ''}.` });
      }
    }
    if (evalView.regression?.regressed) {
      attention.push({ panel: 'eval', level: 'error', message: `Eval hồi quy vs baseline: ${evalView.regression.summary}` });
    }
  }
  if (subagent.rejectedFull > 0) {
    attention.push({ panel: 'subagent', level: 'warning', message: `Pool subagent đã từ chối ${subagent.rejectedFull} lần vì đầy — sóng spawn đang nghẽn.` });
  }
  const levelRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  attention.sort((a, b) => levelRank[a.level] - levelRank[b.level]);
  const evalSummary = evalView
    ? evalView.summary
    : 'Chưa chạy eval lần nào — mở panel Eval để chạy suite đầu tiên.';
  return {
    summary:
      `${plugin.summary} · ${hook.summary}` +
      ` · Eval: ${evalView ? `${evalView.resolved}/${evalView.completed} resolved` : 'chưa chạy'}` +
      ` · ${subagent.summary}`,
    pluginSummary: plugin.summary,
    hookSummary: hook.summary,
    evalSummary,
    subagentSummary: subagent.summary,
    attentionCount: attention.filter((a) => a.level !== 'info').length,
    attention,
    counts: {
      pluginsEnabled: plugin.enabled,
      pluginsErrored: plugin.errored,
      hooksErrored: hook.errored,
      hooksBlockedTotal: hook.totalBlocks,
      evalResolvedPct: evalView ? evalView.resolvedPct : null,
      evalPending: evalView ? evalView.pendingTaskIds.length : 0,
      subagentsActive: subagent.active,
    },
  };
}
