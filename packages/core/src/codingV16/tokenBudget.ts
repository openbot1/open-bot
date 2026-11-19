/**
 * Coding agent v16 — TokenBudgetMeter: đo token tiêu thụ theo task,
 * cảnh báo khi vượt ngân sách đặt trước, dự báo hết ngân sách.
 *
 * Nối v14 (condenser đo token bằng estimator) nhưng tách riêng thành
 * meter có trạng thái: budget đặt trước → sample cộng dồn → trạng
 * thái ok/warn/blocked + dự báo số step còn lại. Không gọi model,
 * không gọi mạng; ước tính token bằng heuristic chars/4 khi không có
 * số đo thật (ghi rõ nguồn trong report).
 */

import { CodingV16Error, V16_DEFAULTS } from './types';
import type {
  V16BudgetStatus,
  V16TaskTokenTotal,
  V16TokenBudget,
  V16TokenSample,
} from './types';

/** Ước tính token từ text (heuristic chars/4, làm tròn lên). */
export function v16EstimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / V16_DEFAULTS.charsPerToken));
}

/** Cộng dồn các sample thành tổng task. */
export function v16SumSamples(samples: readonly V16TokenSample[]): V16TaskTokenTotal {
  let promptTokens = 0;
  let completionTokens = 0;
  let preambleTokens = 0;
  let firstAt = Number.POSITIVE_INFINITY;
  let lastAt = 0;
  const taskId = samples.length > 0 ? samples[0]!.taskId : '';
  for (const s of samples) {
    promptTokens += s.promptTokens;
    completionTokens += s.completionTokens;
    if (s.kind === 'preamble') preambleTokens += s.promptTokens + s.completionTokens;
    if (s.at < firstAt) firstAt = s.at;
    if (s.at > lastAt) lastAt = s.at;
  }
  return {
    taskId,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    samples: samples.length,
    preambleTokens,
    firstAt: samples.length > 0 ? firstAt : 0,
    lastAt,
  };
}

/** Validate một token sample (số âm / không nguyên = lỗi). */
export function v16ValidateSample(sample: V16TokenSample): void {
  if (typeof sample.taskId !== 'string' || sample.taskId.trim() === '') {
    throw new CodingV16Error('budget-invalid', 'Token sample taskId must be a non-empty string.');
  }
  if (!Number.isInteger(sample.step) || sample.step < 0) {
    throw new CodingV16Error('budget-invalid', 'Token sample step must be a non-negative integer.');
  }
  if (!Number.isInteger(sample.promptTokens) || sample.promptTokens < 0) {
    throw new CodingV16Error('budget-invalid', 'promptTokens must be a non-negative integer.');
  }
  if (!Number.isInteger(sample.completionTokens) || sample.completionTokens < 0) {
    throw new CodingV16Error('budget-invalid', 'completionTokens must be a non-negative integer.');
  }
  if (!Number.isFinite(sample.at) || sample.at < 0) {
    throw new CodingV16Error('budget-invalid', 'Token sample at must be a non-negative timestamp.');
  }
}

/** Validate một ngân sách (limit > 0, ngưỡng 0..100, warn <= block). */
export function v16ValidateBudget(budget: V16TokenBudget): void {
  if (typeof budget.id !== 'string' || budget.id.trim() === '') {
    throw new CodingV16Error('budget-invalid', 'Budget id must be a non-empty string.');
  }
  if (!Number.isInteger(budget.limitTokens) || budget.limitTokens <= 0) {
    throw new CodingV16Error('budget-invalid', 'Budget limitTokens must be a positive integer.');
  }
  const warn = budget.warnAtPercent ?? V16_DEFAULTS.warnAtPercent;
  const block = budget.blockAtPercent ?? V16_DEFAULTS.blockAtPercent;
  if (warn <= 0 || warn > 100 || block <= 0 || block > 100) {
    throw new CodingV16Error('budget-invalid', 'Budget warn/block percent must be within (0, 100].');
  }
  if (warn > block) {
    throw new CodingV16Error('budget-invalid', 'Budget warnAtPercent must not exceed blockAtPercent.');
  }
}

/** Tính trạng thái ngân sách từ tổng đã dùng. */
export function v16BudgetStatusFor(
  budget: V16TokenBudget,
  usedTokens: number,
  stepCount: number,
): V16BudgetStatus {
  v16ValidateBudget(budget);
  if (!Number.isInteger(usedTokens) || usedTokens < 0) {
    throw new CodingV16Error('budget-invalid', 'usedTokens must be a non-negative integer.');
  }
  const warn = budget.warnAtPercent ?? V16_DEFAULTS.warnAtPercent;
  const block = budget.blockAtPercent ?? V16_DEFAULTS.blockAtPercent;
  const usedPercent = (usedTokens / budget.limitTokens) * 100;
  const state: V16BudgetStatus['state'] =
    usedPercent >= block ? 'blocked' : usedPercent >= warn ? 'warn' : 'ok';
  const avgTokensPerStep = stepCount > 0 ? usedTokens / stepCount : null;
  let projectedStepsLeft: number | null = null;
  if (avgTokensPerStep !== null && avgTokensPerStep > 0) {
    projectedStepsLeft = Math.max(
      0,
      Math.floor((budget.limitTokens - usedTokens) / avgTokensPerStep),
    );
  }
  return {
    budgetId: budget.id,
    limitTokens: budget.limitTokens,
    usedTokens,
    remainingTokens: budget.limitTokens - usedTokens,
    usedPercent: Math.round(usedPercent * 100) / 100,
    state,
    projectedStepsLeft,
    avgTokensPerStep:
      avgTokensPerStep === null ? null : Math.round(avgTokensPerStep * 100) / 100,
    overLimit: usedTokens > budget.limitTokens,
  };
}

/** Render trạng thái ngân sách thành 1 dòng đọc được. */
export function renderV16BudgetStatus(status: V16BudgetStatus): string {
  const stateLabel =
    status.state === 'blocked' ? 'BLOCKED' : status.state === 'warn' ? 'WARN' : 'OK';
  const projection =
    status.projectedStepsLeft === null
      ? 'no steps yet'
      : `~${status.projectedStepsLeft} steps left`;
  return (
    `budget ${status.budgetId}: ${status.usedTokens}/${status.limitTokens} tokens ` +
    `(${status.usedPercent}%) [${stateLabel}] remaining ${status.remainingTokens}, ${projection}` +
    (status.overLimit ? ' — OVER LIMIT' : '')
  );
}

/** Gợi ý hành động khi ngân sách ở trạng thái warn/blocked. */
export function v16BudgetAdvice(status: V16BudgetStatus): string[] {
  if (status.state === 'ok') return [];
  const advice: string[] = [];
  if (status.state === 'warn') {
    advice.push(
      `Budget ${status.budgetId} at ${status.usedPercent}% — trim history or switch to minimal harness before it blocks.`,
    );
    if (status.projectedStepsLeft !== null && status.projectedStepsLeft <= 3) {
      advice.push(`Only ~${status.projectedStepsLeft} steps of budget left — finish or condense now.`);
    }
  } else {
    advice.push(
      `Budget ${status.budgetId} blocked at ${status.usedPercent}% — stop model calls, condense history, or raise the limit.`,
    );
  }
  return advice;
}

/** Tuỳ chọn cho TokenBudgetMeter. */
export interface V16TokenBudgetMeterOptions {
  /** Hàm lấy thời gian (mặc định Date.now) — để test determinism. */
  now?: () => number;
}

/**
 * TokenBudgetMeter — đo token/task, cảnh báo vượt ngân sách.
 *
 * Giữ toàn bộ sample trong bộ nhớ (theo taskId); persistence JSONL
 * do tool layer lo (ghi file), meter chỉ lo đo + trạng thái.
 */
export class TokenBudgetMeter {
  private readonly samplesByTask = new Map<string, V16TokenSample[]>();
  private readonly budgets = new Map<string, V16TokenBudget>();
  private readonly now: () => number;

  constructor(options: V16TokenBudgetMeterOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Đặt (hoặc thay) ngân sách cho một id. */
  setBudget(budget: V16TokenBudget): V16TokenBudget {
    v16ValidateBudget(budget);
    const stored: V16TokenBudget = {
      id: budget.id,
      limitTokens: budget.limitTokens,
      warnAtPercent: budget.warnAtPercent ?? V16_DEFAULTS.warnAtPercent,
      blockAtPercent: budget.blockAtPercent ?? V16_DEFAULTS.blockAtPercent,
      ...(budget.note !== undefined ? { note: budget.note } : {}),
    };
    this.budgets.set(stored.id, stored);
    return stored;
  }

  /** Lấy ngân sách theo id (undefined khi chưa đặt). */
  getBudget(id: string): V16TokenBudget | undefined {
    return this.budgets.get(id);
  }

  /** Liệt kê mọi ngân sách đã đặt. */
  listBudgets(): V16TokenBudget[] {
    return [...this.budgets.values()];
  }

  /** Ghi một sample tiêu thụ token (validate trước khi ghi). */
  record(sample: V16TokenSample): V16TokenSample {
    v16ValidateSample(sample);
    const stored: V16TokenSample = { ...sample, at: sample.at };
    const list = this.samplesByTask.get(sample.taskId) ?? [];
    list.push(stored);
    this.samplesByTask.set(sample.taskId, list);
    return stored;
  }

  /** Ghi nhanh một sample từ text (ước tính token bằng heuristic). */
  recordText(
    taskId: string,
    step: number,
    kind: V16TokenSample['kind'],
    promptText: string,
    completionText: string,
    extra: Partial<Pick<V16TokenSample, 'model' | 'harness'>> = {},
  ): V16TokenSample {
    return this.record({
      taskId,
      step,
      kind,
      promptTokens: v16EstimateTokens(promptText),
      completionTokens: v16EstimateTokens(completionText),
      at: this.now(),
      ...extra,
    });
  }

  /** Mọi sample của một task (bản sao). */
  samples(taskId: string): V16TokenSample[] {
    return [...(this.samplesByTask.get(taskId) ?? [])];
  }

  /** Tổng token của một task. */
  total(taskId: string): V16TaskTokenTotal {
    return v16SumSamples(this.samples(taskId));
  }

  /** Liệt kê mọi taskId đã có sample. */
  taskIds(): string[] {
    return [...this.samplesByTask.keys()];
  }

  /** Tổng token toàn bộ task đã đo (phiên làm việc). */
  sessionTotal(): V16TaskTokenTotal {
    const all: V16TokenSample[] = [];
    for (const list of this.samplesByTask.values()) all.push(...list);
    const total = v16SumSamples(all);
    return { ...total, taskId: 'session' };
  }

  /** Trạng thái ngân sách của một task (null khi chưa đặt budget). */
  status(budgetId: string, taskId?: string): V16BudgetStatus | null {
    const budget = this.budgets.get(budgetId);
    if (!budget) return null;
    const target = taskId ?? budgetId;
    const total = this.total(target);
    return v16BudgetStatusFor(budget, total.totalTokens, total.samples);
  }

  /** Trạng thái mọi ngân sách đã đặt (taskId mặc định = budgetId). */
  allStatuses(): V16BudgetStatus[] {
    const out: V16BudgetStatus[] = [];
    for (const budget of this.budgets.values()) {
      const total = this.total(budget.id);
      out.push(v16BudgetStatusFor(budget, total.totalTokens, total.samples));
    }
    return out;
  }

  /** true = ngân sách đã chặn (không nên gọi model thêm). */
  isBlocked(budgetId: string, taskId?: string): boolean {
    return this.status(budgetId, taskId)?.state === 'blocked';
  }

  /** Ghi sample rồi trả trạng thái ngân sách ngay (1 call cho agent loop). */
  recordAndCheck(sample: V16TokenSample, budgetId?: string): V16BudgetStatus | null {
    this.record(sample);
    if (!budgetId) return null;
    return this.status(budgetId, sample.taskId);
  }

  /** Xoá sample của một task (giữ budget). Trả số sample đã xoá. */
  clearTask(taskId: string): number {
    const count = this.samplesByTask.get(taskId)?.length ?? 0;
    this.samplesByTask.delete(taskId);
    return count;
  }

  /** Xoá toàn bộ sample + budget. */
  reset(): void {
    this.samplesByTask.clear();
    this.budgets.clear();
  }
}

/** Mặc định ngân sách cho một task coding thường (50k token). */
export const V16_DEFAULT_TASK_BUDGET: V16TokenBudget = {
  id: 'task',
  limitTokens: 50000,
  warnAtPercent: 80,
  blockAtPercent: 100,
  note: 'Default per-task token budget (v16).',
};

/** Tổng token theo harness (từ các sample đã đo). */
export interface V16HarnessTokenTotal {
  harness: string;
  tasks: number;
  samples: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  preambleTokens: number;
}

/** Cộng dồn sample theo harness. */
export function v16TokensByHarness(samples: readonly V16TokenSample[]): V16HarnessTokenTotal[] {
  const byHarness = new Map<string, { tasks: Set<string>; samples: number; prompt: number; completion: number; preamble: number }>();
  for (const s of samples) {
    const key = s.harness ?? 'unknown';
    const entry = byHarness.get(key) ?? { tasks: new Set<string>(), samples: 0, prompt: 0, completion: 0, preamble: 0 };
    entry.tasks.add(s.taskId);
    entry.samples += 1;
    entry.prompt += s.promptTokens;
    entry.completion += s.completionTokens;
    if (s.kind === 'preamble') entry.preamble += s.promptTokens + s.completionTokens;
    byHarness.set(key, entry);
  }
  return [...byHarness.entries()]
    .map(([harness, e]) => ({
      harness,
      tasks: e.tasks.size,
      samples: e.samples,
      promptTokens: e.prompt,
      completionTokens: e.completion,
      totalTokens: e.prompt + e.completion,
      preambleTokens: e.preamble,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Báo cáo phiên: tổng + theo task + theo harness + ngân sách. */
export interface V16SessionTokenReport {
  generatedAt: number;
  session: V16TaskTokenTotal;
  tasks: V16TaskTokenTotal[];
  byHarness: V16HarnessTokenTotal[];
  budgets: V16BudgetStatus[];
  /** Task tốn token nhất. */
  heaviestTask: string | null;
  /** Harness tốn token nhất. */
  heaviestHarness: string | null;
  /** Tỉ lệ token preamble trên tổng phiên (phần trăm). */
  preambleSharePercent: number;
}

/** Dựng báo cáo phiên từ một meter (không đổi trạng thái meter). */
export function v16SessionReport(meter: TokenBudgetMeter): V16SessionTokenReport {
  const session = meter.sessionTotal();
  const tasks = meter.taskIds().map((id) => meter.total(id));
  const all: V16TokenSample[] = [];
  for (const id of meter.taskIds()) all.push(...meter.samples(id));
  const byHarness = v16TokensByHarness(all);
  const budgets = meter.allStatuses();
  const heaviestTask = tasks.length > 0 ? [...tasks].sort((a, b) => b.totalTokens - a.totalTokens)[0]! : null;
  return {
    generatedAt: Date.now(),
    session,
    tasks: [...tasks].sort((a, b) => b.totalTokens - a.totalTokens),
    byHarness,
    budgets,
    heaviestTask: heaviestTask ? heaviestTask.taskId : null,
    heaviestHarness: byHarness.length > 0 ? byHarness[0]!.harness : null,
    preambleSharePercent:
      session.totalTokens > 0
        ? Math.round((session.preambleTokens / session.totalTokens) * 10000) / 100
        : 0,
  };
}

/** Render báo cáo phiên thành text. */
export function renderV16SessionReport(report: V16SessionTokenReport): string {
  const lines: string[] = [];
  lines.push(
    `Token session: ${report.session.totalTokens} tokens in ${report.session.samples} sample(s) ` +
      `across ${report.tasks.length} task(s) (preamble ${report.session.preambleTokens}, ${report.preambleSharePercent}% of session)`,
  );
  for (const t of report.tasks) {
    lines.push(`- task ${t.taskId}: ${t.totalTokens} tokens (${t.promptTokens} prompt + ${t.completionTokens} completion, ${t.samples} samples)`);
  }
  for (const h of report.byHarness) {
    lines.push(`- harness ${h.harness}: ${h.totalTokens} tokens in ${h.tasks} task(s), preamble ${h.preambleTokens}`);
  }
  for (const b of report.budgets) {
    lines.push(`- ${renderV16BudgetStatus(b)}`);
  }
  if (report.heaviestTask) lines.push(`Heaviest task: ${report.heaviestTask}`);
  if (report.heaviestHarness) lines.push(`Heaviest harness: ${report.heaviestHarness}`);
  return lines.join('\n');
}

/**
 * Ghi một sample thành 1 dòng JSONL (append-only, để tool layer
 * lưu bền meter mà không đọc/ghi cả file mỗi lần).
 */
export function v16SampleToJsonl(sample: V16TokenSample): string {
  return `${JSON.stringify(sample)}\n`;
}

/** Parse 1 dòng JSONL thành sample (null khi dòng trống/lỗi). */
export function v16SampleFromJsonl(line: string): V16TokenSample | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    if (
      typeof p['taskId'] !== 'string' ||
      typeof p['step'] !== 'number' ||
      typeof p['kind'] !== 'string' ||
      typeof p['promptTokens'] !== 'number' ||
      typeof p['completionTokens'] !== 'number' ||
      typeof p['at'] !== 'number'
    ) {
      return null;
    }
    const kind = p['kind'] as string;
    if (!['preamble', 'model', 'tool', 'condense', 'retry'].includes(kind)) return null;
    return {
      taskId: p['taskId'] as string,
      step: p['step'] as number,
      kind: kind as V16TokenSample['kind'],
      promptTokens: p['promptTokens'] as number,
      completionTokens: p['completionTokens'] as number,
      at: p['at'] as number,
      ...(typeof p['model'] === 'string' ? { model: p['model'] as string } : {}),
      ...(typeof p['harness'] === 'string' ? { harness: p['harness'] as string } : {}),
    };
  } catch {
    return null;
  }
}

/** Parse toàn bộ text JSONL thành mảng sample (bỏ dòng lỗi, đếm số dòng lỗi). */
export function v16SamplesFromJsonl(text: string): { samples: V16TokenSample[]; badLines: number } {
  const samples: V16TokenSample[] = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const sample = v16SampleFromJsonl(line);
    if (sample) samples.push(sample);
    else badLines += 1;
  }
  return { samples, badLines };
}

/** Dự báo hết ngân sách theo tốc độ đốt token hiện tại. */
export interface V16BudgetForecast {
  budgetId: string;
  usedTokens: number;
  remainingTokens: number;
  /** Token/step trung bình (null khi chưa có step). */
  avgTokensPerStep: number | null;
  /** Số step nữa thì hết ngân sách (null khi chưa đo được tốc độ). */
  stepsUntilExhausted: number | null;
  /** Token sẽ dùng ở step tiếp theo theo dự báo (bằng trung bình). */
  nextStepForecastTokens: number | null;
  /** true = dự báo hết ngân sách trong <= 3 step nữa. */
  urgent: boolean;
  /** Câu dự báo đọc được. */
  text: string;
}

/**
 * Dự báo ngân sách: lấy trung bình token/step từ sample đã đo, chia
 * phần còn lại cho trung bình đó. Khi chưa có step nào thì không dự
 * báo được (trả null cho các số, text nói rõ).
 */
export function v16BudgetForecast(
  budget: V16TokenBudget,
  usedTokens: number,
  stepCount: number,
): V16BudgetForecast {
  v16ValidateBudget(budget);
  if (!Number.isInteger(usedTokens) || usedTokens < 0) {
    throw new CodingV16Error('budget-invalid', 'usedTokens must be a non-negative integer.');
  }
  if (!Number.isInteger(stepCount) || stepCount < 0) {
    throw new CodingV16Error('budget-invalid', 'stepCount must be a non-negative integer.');
  }
  const remaining = budget.limitTokens - usedTokens;
  const avg = stepCount > 0 ? usedTokens / stepCount : null;
  const stepsUntilExhausted =
    avg !== null && avg > 0 ? Math.max(0, Math.floor(remaining / avg)) : null;
  const urgent = stepsUntilExhausted !== null && stepsUntilExhausted <= 3;
  const text =
    avg === null
      ? `Budget ${budget.id}: no steps measured yet — forecast unavailable.`
      : stepsUntilExhausted === 0
        ? `Budget ${budget.id}: exhausted at current burn rate (${Math.round(avg)} tokens/step).`
        : `Budget ${budget.id}: ~${stepsUntilExhausted} step(s) left at ~${Math.round(avg)} tokens/step (${remaining} tokens remaining).`;
  return {
    budgetId: budget.id,
    usedTokens,
    remainingTokens: remaining,
    avgTokensPerStep: avg === null ? null : Math.round(avg * 100) / 100,
    stepsUntilExhausted,
    nextStepForecastTokens: avg === null ? null : Math.round(avg),
    urgent,
    text,
  };
}
