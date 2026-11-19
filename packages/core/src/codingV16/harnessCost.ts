/**
 * Coding agent v16 — HarnessCostEstimator: đo chi phí/task theo từng
 * harness, báo cáo cost/accuracy trade-off (điểm số vs chi phí).
 *
 * Ý tưởng từ nghiên cứu (survey v138 §3): harness đổi điểm trong
 * nhiễu nhưng chi phí chênh tới 3x — nên báo cáo phải đặt chi phí
 * cạnh điểm số, không báo pass rate một mình. Estimator giữ bảng giá
 * model (USD/1M token, chỉnh được), ghi cost record từng task, so
 * sánh các harness trên cùng bộ task: pass rate, $/task, điểm/đô la,
 * token/pass, tỉ lệ chi phí lớn nhất, chênh điểm lớn nhất, và kết
 * luận "harness mua token, không mua điểm" khi chênh chi phí vượt
 * xa chênh điểm.
 */

import { CodingV16Error, V16_DEFAULT_HARNESS_PROFILES, V16_DEFAULT_MODEL_PRICES } from './types';
import type {
  V16CostAccuracyReport,
  V16CostRecord,
  V16HarnessComparison,
  V16HarnessProfile,
  V16ModelPrice,
} from './types';

/** Tính tiền USD cho một lần chạy từ token + bảng giá. */
export function v16PriceRun(
  promptTokens: number,
  completionTokens: number,
  price: V16ModelPrice,
): number {
  if (!Number.isInteger(promptTokens) || promptTokens < 0) {
    throw new CodingV16Error('cost-invalid', 'promptTokens must be a non-negative integer.');
  }
  if (!Number.isInteger(completionTokens) || completionTokens < 0) {
    throw new CodingV16Error('cost-invalid', 'completionTokens must be a non-negative integer.');
  }
  const cost =
    (promptTokens * price.inputPerMillion + completionTokens * price.outputPerMillion) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Tìm giá model theo tên (không phân biệt hoa thường). */
export function v16FindPrice(
  prices: readonly V16ModelPrice[],
  model: string,
): V16ModelPrice | undefined {
  const wanted = model.trim().toLowerCase();
  return prices.find((p) => p.model.toLowerCase() === wanted);
}

/** Làm tròn 4 chữ số thập phân (đủ cho $/task). */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Làm tròn 2 chữ số thập phân (đủ cho tỉ lệ/phần trăm). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * So sánh một harness trên các record của nó (cùng bộ task).
 * Trả null khi không có record nào.
 */
export function v16CompareHarness(
  harnessId: string,
  records: readonly V16CostRecord[],
): V16HarnessComparison | null {
  const mine = records.filter((r) => r.harnessId === harnessId);
  if (mine.length === 0) return null;
  const passes = mine.filter((r) => r.passed).length;
  const totalTokens = mine.reduce((a, r) => a + r.totalTokens, 0);
  const totalCost = mine.reduce((a, r) => a + r.costUsd, 0);
  const totalScore = mine.reduce((a, r) => a + r.score, 0);
  const totalSteps = mine.reduce((a, r) => a + r.steps, 0);
  const avgScore = totalScore / mine.length;
  const avgCost = totalCost / mine.length;
  const passTokens = mine.filter((r) => r.passed).reduce((a, r) => a + r.totalTokens, 0);
  return {
    harnessId,
    tasks: mine.length,
    passRate: round4(passes / mine.length),
    avgScore: round4(avgScore),
    avgTokensPerTask: Math.round(totalTokens / mine.length),
    avgCostPerTaskUsd: round4(avgCost),
    totalCostUsd: round4(totalCost),
    avgStepsPerTask: round2(totalSteps / mine.length),
    scorePerDollar: avgCost > 0 ? round2(avgScore / avgCost) : null,
    tokensPerPass: passes > 0 ? Math.round(passTokens / passes) : null,
  };
}

/**
 * Báo cáo trade-off đầy đủ cho N harness trên cùng bộ task.
 * `taskIds` là bộ task chung; record của harness nào thiếu task nào
 * thì vẫn so sánh trên phần giao nhau (ghi rõ trong verdict).
 */
export function v16BuildCostAccuracyReport(
  records: readonly V16CostRecord[],
  taskIds: readonly string[],
  harnessIds: readonly string[],
): V16CostAccuracyReport {
  if (taskIds.length === 0) {
    throw new CodingV16Error('cost-invalid', 'Cost/accuracy report needs at least one task id.');
  }
  if (harnessIds.length === 0) {
    throw new CodingV16Error('cost-invalid', 'Cost/accuracy report needs at least one harness id.');
  }
  const comparisons: V16HarnessComparison[] = [];
  for (const id of harnessIds) {
    const c = v16CompareHarness(id, records);
    if (c) comparisons.push(c);
  }
  if (comparisons.length === 0) {
    throw new CodingV16Error('cost-invalid', 'No cost records for the given harness ids.');
  }
  const cheapest = [...comparisons]
    .filter((c) => c.tokensPerPass !== null)
    .sort((a, b) => (a.tokensPerPass ?? 0) - (b.tokensPerPass ?? 0))[0];
  const highest = [...comparisons].sort((a, b) => b.avgScore - a.avgScore)[0]!;
  const efficient = [...comparisons]
    .filter((c) => c.scorePerDollar !== null)
    .sort((a, b) => (b.scorePerDollar ?? 0) - (a.scorePerDollar ?? 0))[0];
  const costs = comparisons.map((c) => c.avgCostPerTaskUsd).filter((c) => c > 0);
  const maxCostRatio =
    costs.length >= 2 ? round2(Math.max(...costs) / Math.min(...costs)) : null;
  const scores = comparisons.map((c) => c.avgScore);
  const maxScoreGap = scores.length >= 2 ? round4(Math.max(...scores) - Math.min(...scores)) : null;
  let verdict: string;
  if (maxCostRatio !== null && maxScoreGap !== null) {
    if (maxCostRatio >= 2 && maxScoreGap <= 0.05) {
      verdict =
        `Cost varies ${maxCostRatio}x across harnesses while scores differ by only ` +
        `${maxScoreGap} — the harness buys tokens, not accuracy. Prefer the cheapest harness at equal score.`;
    } else if (maxCostRatio !== null && maxCostRatio >= 2) {
      verdict =
        `Cost varies ${maxCostRatio}x and scores differ by ${maxScoreGap} — check whether the ` +
        `expensive harness earns its premium on the tasks that matter.`;
    } else {
      verdict =
        `Cost varies ${maxCostRatio}x and scores differ by ${maxScoreGap} — harnesses are close on both axes.`;
    }
  } else {
    verdict = 'Not enough harnesses with cost data to judge the trade-off.';
  }
  return {
    generatedAt: Date.now(),
    taskIds: [...taskIds],
    harnessIds: [...harnessIds],
    comparisons,
    cheapestPerPass: cheapest?.harnessId ?? null,
    highestScore: highest.harnessId,
    mostEfficient: efficient?.harnessId ?? null,
    maxCostRatio,
    maxScoreGap,
    verdict,
  };
}

/** Render báo cáo trade-off thành text đọc được (bảng + kết luận). */
export function renderV16CostAccuracyReport(report: V16CostAccuracyReport): string {
  const lines: string[] = [];
  lines.push(`Cost/accuracy trade-off — ${report.taskIds.length} task(s), ${report.comparisons.length} harness(es)`);
  lines.push('harness | tasks | pass | avg score | avg tokens/task | avg $/task | score/$');
  for (const c of report.comparisons) {
    lines.push(
      `${c.harnessId} | ${c.tasks} | ${(c.passRate * 100).toFixed(0)}% | ${c.avgScore} | ` +
        `${c.avgTokensPerTask} | $${c.avgCostPerTaskUsd} | ${c.scorePerDollar ?? 'n/a'}`,
    );
  }
  if (report.maxCostRatio !== null) lines.push(`Max cost ratio: ${report.maxCostRatio}x`);
  if (report.maxScoreGap !== null) lines.push(`Max score gap: ${report.maxScoreGap}`);
  if (report.cheapestPerPass) lines.push(`Cheapest per pass: ${report.cheapestPerPass}`);
  if (report.mostEfficient) lines.push(`Most efficient (score/$): ${report.mostEfficient}`);
  lines.push(`Verdict: ${report.verdict}`);
  return lines.join('\n');
}

/** Tuỳ chọn cho HarnessCostEstimator. */
export interface V16HarnessCostEstimatorOptions {
  /** Bảng giá khởi tạo (mặc định V16_DEFAULT_MODEL_PRICES). */
  prices?: V16ModelPrice[];
  /** Profile harness khởi tạo (mặc định V16_DEFAULT_HARNESS_PROFILES). */
  profiles?: V16HarnessProfile[];
  /** Hàm lấy thời gian (mặc định Date.now). */
  now?: () => number;
}

/**
 * HarnessCostEstimator — ghi cost record, tính tiền, so sánh harness.
 *
 * Mọi con số đều từ record thật (do agent/tool ghi vào); estimator
 * không tự bịa điểm hay token. Giá model chỉnh được (setPrice) vì
 * giá provider thay đổi theo thời gian.
 */
export class HarnessCostEstimator {
  private readonly prices = new Map<string, V16ModelPrice>();
  private readonly profiles = new Map<string, V16HarnessProfile>();
  private readonly records: V16CostRecord[] = [];
  private readonly now: () => number;

  constructor(options: V16HarnessCostEstimatorOptions = {}) {
    const prices = options.prices ?? V16_DEFAULT_MODEL_PRICES;
    for (const p of prices) this.prices.set(p.model.toLowerCase(), { ...p });
    const profiles = options.profiles ?? V16_DEFAULT_HARNESS_PROFILES;
    for (const p of profiles) this.profiles.set(p.id, { ...p });
    this.now = options.now ?? Date.now;
  }

  /** Đặt/thay giá một model. */
  setPrice(price: V16ModelPrice): void {
    if (typeof price.model !== 'string' || price.model.trim() === '') {
      throw new CodingV16Error('cost-invalid', 'Model price needs a non-empty model name.');
    }
    if (price.inputPerMillion < 0 || price.outputPerMillion < 0) {
      throw new CodingV16Error('cost-invalid', 'Model prices must be non-negative.');
    }
    this.prices.set(price.model.toLowerCase(), { ...price });
  }

  /** Giá một model (undefined khi chưa biết — record vẫn ghi, cost = 0 + ghi chú). */
  getPrice(model: string): V16ModelPrice | undefined {
    return this.prices.get(model.trim().toLowerCase());
  }

  /** Liệt kê bảng giá hiện tại. */
  listPrices(): V16ModelPrice[] {
    return [...this.prices.values()];
  }

  /** Đăng ký/thay profile một harness. */
  setProfile(profile: V16HarnessProfile): void {
    if (typeof profile.id !== 'string' || profile.id.trim() === '') {
      throw new CodingV16Error('cost-unknown-harness', 'Harness profile needs a non-empty id.');
    }
    if (!Number.isInteger(profile.preambleTokens) || profile.preambleTokens < 0) {
      throw new CodingV16Error('cost-invalid', 'Harness preambleTokens must be a non-negative integer.');
    }
    this.profiles.set(profile.id, { ...profile });
  }

  /** Profile một harness (undefined khi chưa đăng ký). */
  getProfile(harnessId: string): V16HarnessProfile | undefined {
    return this.profiles.get(harnessId);
  }

  /** Liệt kê mọi profile harness. */
  listProfiles(): V16HarnessProfile[] {
    return [...this.profiles.values()];
  }

  /**
   * Tính tiền cho một lần chạy (dùng giá model đã đăng ký; model lạ
   * thì cost = 0 và note ghi rõ 'unknown-model-price').
   */
  priceRun(promptTokens: number, completionTokens: number, model: string): number {
    const price = this.getPrice(model);
    if (!price) return 0;
    return v16PriceRun(promptTokens, completionTokens, price);
  }

  /**
   * Ghi một cost record. `costUsd` tính tự động từ bảng giá khi
   * không truyền vào; `passed` suy từ score >= passThreshold (1).
   */
  record(input: {
    taskId: string;
    harnessId: string;
    model: string;
    score: number;
    promptTokens: number;
    completionTokens: number;
    steps: number;
    passThreshold?: number;
    costUsd?: number;
    note?: string;
  }): V16CostRecord {
    if (typeof input.taskId !== 'string' || input.taskId.trim() === '') {
      throw new CodingV16Error('cost-invalid', 'Cost record taskId must be a non-empty string.');
    }
    if (typeof input.harnessId !== 'string' || input.harnessId.trim() === '') {
      throw new CodingV16Error('cost-unknown-harness', 'Cost record harnessId must be a non-empty string.');
    }
    if (typeof input.score !== 'number' || input.score < 0 || input.score > 1) {
      throw new CodingV16Error('cost-invalid', 'Cost record score must be within [0, 1].');
    }
    if (!Number.isInteger(input.promptTokens) || input.promptTokens < 0) {
      throw new CodingV16Error('cost-invalid', 'promptTokens must be a non-negative integer.');
    }
    if (!Number.isInteger(input.completionTokens) || input.completionTokens < 0) {
      throw new CodingV16Error('cost-invalid', 'completionTokens must be a non-negative integer.');
    }
    if (!Number.isInteger(input.steps) || input.steps < 0) {
      throw new CodingV16Error('cost-invalid', 'steps must be a non-negative integer.');
    }
    const passThreshold = input.passThreshold ?? 1;
    const price = this.getPrice(input.model);
    const costUsd = input.costUsd ?? (price ? v16PriceRun(input.promptTokens, input.completionTokens, price) : 0);
    const record: V16CostRecord = {
      taskId: input.taskId,
      harnessId: input.harnessId,
      model: input.model,
      score: input.score,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.promptTokens + input.completionTokens,
      costUsd,
      steps: input.steps,
      passed: input.score >= passThreshold,
      at: this.now(),
      ...(input.note !== undefined || !price
        ? { note: input.note ?? 'unknown-model-price' }
        : {}),
    };
    this.records.push(record);
    return record;
  }

  /** Mọi record đã ghi (bản sao). */
  allRecords(): V16CostRecord[] {
    return [...this.records];
  }

  /** Record của một harness. */
  recordsForHarness(harnessId: string): V16CostRecord[] {
    return this.records.filter((r) => r.harnessId === harnessId);
  }

  /** Record của một task. */
  recordsForTask(taskId: string): V16CostRecord[] {
    return this.records.filter((r) => r.taskId === taskId);
  }

  /** So sánh một harness (null khi chưa có record). */
  compare(harnessId: string): V16HarnessComparison | null {
    return v16CompareHarness(harnessId, this.records);
  }

  /** Báo cáo trade-off cho các harness đã có record. */
  report(harnessIds?: string[]): V16CostAccuracyReport {
    const ids = harnessIds ?? [...new Set(this.records.map((r) => r.harnessId))];
    const taskIds = [...new Set(this.records.map((r) => r.taskId))];
    return v16BuildCostAccuracyReport(this.records, taskIds, ids);
  }

  /** Chi phí preamble ước tính cho một harness (từ profile). */
  preambleCostUsd(harnessId: string, model: string): number | null {
    const profile = this.profiles.get(harnessId);
    const price = this.getPrice(model);
    if (!profile || !price) return null;
    return v16PriceRun(profile.preambleTokens, 0, price);
  }

  /** Xoá toàn bộ record (giữ giá + profile). */
  clearRecords(): void {
    this.records.length = 0;
  }
}

/** Độ nhiễu rerun của một task: cùng task chạy lại nhiều lần, điểm lật bao nhiêu lần. */
export interface V16TaskFlakiness {
  taskId: string;
  runs: number;
  /** Số lần pass trong các lần chạy. */
  passes: number;
  /** true = có lần pass, lần fail (điểm lật). */
  flipped: boolean;
  /** Điểm thấp nhất / cao nhất qua các lần chạy. */
  minScore: number;
  maxScore: number;
  /** Chênh lệch điểm lớn nhất giữa 2 lần chạy. */
  scoreSpread: number;
  /** Chi phí thấp nhất / cao nhất (USD). */
  minCostUsd: number;
  maxCostUsd: number;
}

/** Phân tích flakiness cho mọi task có >= 2 lần chạy. */
export function v16AnalyzeFlakiness(records: readonly V16CostRecord[]): V16TaskFlakiness[] {
  const byTask = new Map<string, V16CostRecord[]>();
  for (const r of records) {
    const list = byTask.get(r.taskId) ?? [];
    list.push(r);
    byTask.set(r.taskId, list);
  }
  const out: V16TaskFlakiness[] = [];
  for (const [taskId, runs] of byTask) {
    if (runs.length < 2) continue;
    const scores = runs.map((r) => r.score);
    const costs = runs.map((r) => r.costUsd);
    const passes = runs.filter((r) => r.passed).length;
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    out.push({
      taskId,
      runs: runs.length,
      passes,
      flipped: passes > 0 && passes < runs.length,
      minScore,
      maxScore,
      scoreSpread: round4(maxScore - minScore),
      minCostUsd: round4(Math.min(...costs)),
      maxCostUsd: round4(Math.max(...costs)),
    });
  }
  return out.sort((a, b) => b.scoreSpread - a.scoreSpread);
}

/** Tóm tắt flakiness toàn bộ benchmark. */
export interface V16FlakinessSummary {
  tasksRerun: number;
  tasksFlipped: number;
  /** Tỉ lệ task rerun bị lật điểm (0..1). */
  flipRate: number;
  /** Chênh điểm trung bình giữa các lần chạy của cùng task. */
  avgScoreSpread: number;
  /** Task nhiễu nhất (spread lớn nhất). */
  noisiestTask: string | null;
}

/** Tóm tắt flakiness từ danh sách phân tích theo task. */
export function v16SummarizeFlakiness(flakiness: readonly V16TaskFlakiness[]): V16FlakinessSummary {
  if (flakiness.length === 0) {
    return { tasksRerun: 0, tasksFlipped: 0, flipRate: 0, avgScoreSpread: 0, noisiestTask: null };
  }
  const flipped = flakiness.filter((f) => f.flipped).length;
  const avgSpread = flakiness.reduce((s, f) => s + f.scoreSpread, 0) / flakiness.length;
  return {
    tasksRerun: flakiness.length,
    tasksFlipped: flipped,
    flipRate: round4(flipped / flakiness.length),
    avgScoreSpread: round4(avgSpread),
    noisiestTask: flakiness[0]!.taskId,
  };
}

/** Chi phí theo model (tổng hợp từ record). */
export interface V16ModelCostTotal {
  model: string;
  tasks: number;
  totalTokens: number;
  totalCostUsd: number;
  avgCostPerTaskUsd: number;
  avgScore: number;
}

/** Cộng dồn chi phí theo model. */
export function v16CostsByModel(records: readonly V16CostRecord[]): V16ModelCostTotal[] {
  const byModel = new Map<string, { tasks: number; tokens: number; cost: number; score: number }>();
  for (const r of records) {
    const entry = byModel.get(r.model) ?? { tasks: 0, tokens: 0, cost: 0, score: 0 };
    entry.tasks += 1;
    entry.tokens += r.totalTokens;
    entry.cost += r.costUsd;
    entry.score += r.score;
    byModel.set(r.model, entry);
  }
  return [...byModel.entries()]
    .map(([model, e]) => ({
      model,
      tasks: e.tasks,
      totalTokens: e.tokens,
      totalCostUsd: round4(e.cost),
      avgCostPerTaskUsd: round4(e.cost / e.tasks),
      avgScore: round4(e.score / e.tasks),
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

/** Render tóm tắt flakiness thành text. */
export function renderV16FlakinessSummary(summary: V16FlakinessSummary): string {
  if (summary.tasksRerun === 0) return 'No task was rerun — flakiness unknown.';
  return (
    `Flakiness: ${summary.tasksFlipped}/${summary.tasksRerun} rerun tasks flipped score ` +
    `(flip rate ${(summary.flipRate * 100).toFixed(1)}%, avg spread ${summary.avgScoreSpread})` +
    (summary.noisiestTask ? ` — noisiest: ${summary.noisiestTask}.` : '.')
  );
}

/** Gợi ý chọn harness: rẻ nhất trong số harness đạt điểm tối thiểu. */
export interface V16HarnessRecommendation {
  /** Harness được gợi ý (null khi không harness nào đạt ngưỡng). */
  harnessId: string | null;
  /** Điểm tối thiểu yêu cầu. */
  minScore: number;
  /** Chi phí/task của harness được gợi ý (null khi không có). */
  costPerTaskUsd: number | null;
  /** Điểm trung bình của harness được gợi ý. */
  avgScore: number | null;
  /** Tiết kiệm so với harness đắt nhất đạt ngưỡng (USD/task). */
  savedVsMostExpensiveUsd: number | null;
  /** Giải thích 1-2 câu. */
  reason: string;
  /** Mọi harness đạt ngưỡng, xếp theo $/task tăng dần. */
  qualifying: { harnessId: string; avgScore: number; avgCostPerTaskUsd: number }[];
}

/**
 * Gợi ý harness từ báo cáo trade-off: trong số harness có avgScore
 * >= minScore, chọn harness có avgCostPerTaskUsd thấp nhất. Khi
 * không harness nào đạt ngưỡng, gợi ý harness điểm cao nhất và nói
 * rõ cần hạ ngưỡng hoặc đổi model.
 */
export function v16RecommendHarness(
  report: V16CostAccuracyReport,
  minScore: number,
): V16HarnessRecommendation {
  if (typeof minScore !== 'number' || minScore < 0 || minScore > 1) {
    throw new CodingV16Error('cost-invalid', 'minScore must be within [0, 1].');
  }
  const qualifying = report.comparisons
    .filter((c) => c.avgScore >= minScore)
    .map((c) => ({ harnessId: c.harnessId, avgScore: c.avgScore, avgCostPerTaskUsd: c.avgCostPerTaskUsd }))
    .sort((a, b) => a.avgCostPerTaskUsd - b.avgCostPerTaskUsd);
  if (qualifying.length === 0) {
    const best = [...report.comparisons].sort((a, b) => b.avgScore - a.avgScore)[0];
    return {
      harnessId: null,
      minScore,
      costPerTaskUsd: null,
      avgScore: null,
      savedVsMostExpensiveUsd: null,
      reason: best
        ? `No harness averages >= ${minScore} (best is ${best.harnessId} at ${best.avgScore}). Lower the threshold or switch model.`
        : 'No harness has cost data yet.',
      qualifying: [],
    };
  }
  const picked = qualifying[0]!;
  const mostExpensive = qualifying[qualifying.length - 1]!;
  const saved = round4(mostExpensive.avgCostPerTaskUsd - picked.avgCostPerTaskUsd);
  return {
    harnessId: picked.harnessId,
    minScore,
    costPerTaskUsd: picked.avgCostPerTaskUsd,
    avgScore: picked.avgScore,
    savedVsMostExpensiveUsd: saved,
    reason:
      `${picked.harnessId} averages ${picked.avgScore} at $${picked.avgCostPerTaskUsd}/task — ` +
      `cheapest among ${qualifying.length} harness(es) meeting score >= ${minScore}` +
      (saved > 0 ? `, saving $${saved}/task vs ${mostExpensive.harnessId}.` : '.'),
    qualifying,
  };
}
