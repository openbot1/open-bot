/**
 * Benchmark harness — so sánh model/harness trên cùng task (v1.04, Team T6).
 *
 * Nguyên tắc vàng: **cùng task, cùng test, cùng budget** cho mọi
 * config; khác nhau chỉ ở model/harness. So sánh mà task khác nhau
 * thì vô nghĩa.
 *
 * - Một config = một model + một harness label (vd "gpt-x qua
 *   CodeAct", "model local qua CLI"). Runner là callback do caller
 *   cung cấp: `(config, task) => Promise<BenchmarkRunOutcome>` — harness
 *   không nhúng model cụ thể nào, không tự gọi LLM.
 * - Ba trục báo cáo cùng lúc (tối ưu một trục dễ làm hỏng hai trục
 *   còn lại): **accuracy** (% task pass), **latency** (mean/p95),
 *   **cost** (USD/task, USD/task-pass — qua `estimateCostDetailed`,
 *   model không có giá thì cost null, không bịa giá).
 * - Tránh cherry-pick: chạy toàn bộ task set cho mọi config; report
 *   ghi cả task fail chung (khó cho mọi config) lẫn task chỉ một
 *   config pass (phân biệt thật).
 * - Winner theo từng metric riêng (accuracy / latency / cost) — không
 *   tuyên bố một "winner chung" duy nhất, vì ba trục thường mâu
 *   thuẫn nhau.
 *
 * Harness này dùng task trừu tượng (id/title) + outcome do runner
 * trả — caller nối task thật (vd task SWE-bench từ sweBenchEval.ts)
 * bằng cách chạy solver trong runner callback. Tách bạch như vậy để
 * benchmark logic test được thuần túy mà không cần model thật.
 */

import { estimateCostDetailed } from './cost';

/** Một cấu hình được benchmark: model + harness nào chạy nó. */
export interface BenchmarkConfig {
  /** Id ổn định (vd 'cfg-gpt-codeact'). */
  id: string;
  /** Label hiển thị (vd 'GPT-X · CodeAct'). */
  label: string;
  /** Tên model (dùng để tính cost qua bảng giá; local model → $0). */
  model: string;
  /** Tên harness (vd 'codeact', 'cli-codex', 'scripted'). */
  harness: string;
}

/** Một task trong benchmark set (trừu tượng — caller nối task thật). */
export interface BenchmarkTask {
  id: string;
  title: string;
}

/** Kết quả một lần chạy (do runner callback trả về). */
export interface BenchmarkRunOutcome {
  /** Task có pass không (theo test của task, không phải tự đánh giá). */
  passed: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Runner: chạy một task bằng một config, trả outcome. */
export type BenchmarkRunner = (config: BenchmarkConfig, task: BenchmarkTask) => Promise<BenchmarkRunOutcome>;

/** Kết quả một task × một config. */
export interface BenchmarkCell {
  configId: string;
  taskId: string;
  passed: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, null khi model không có giá trong bảng. */
  costUsd: number | null;
}

/** Aggregate của một config trên toàn task set. */
export interface BenchmarkConfigSummary {
  configId: string;
  label: string;
  model: string;
  harness: string;
  tasksRun: number;
  tasksPassed: number;
  /** % pass (null khi không chạy task nào). */
  accuracy: number | null;
  meanLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Tổng USD của các run có giá (null khi không run nào có giá). */
  totalCostUsd: number | null;
  /** USD / task pass (null khi không có task pass nào hoặc không có giá). */
  costPerPassedTaskUsd: number | null;
  /** Model không có giá trong bảng → cost không đầy đủ, ghi rõ. */
  costIncomplete: boolean;
}

/** Báo cáo benchmark đầy đủ. */
export interface BenchmarkReport {
  generatedAt: string;
  tasks: BenchmarkTask[];
  configs: BenchmarkConfig[];
  cells: BenchmarkCell[];
  summaries: BenchmarkConfigSummary[];
  /** Task mọi config đều fail (khó chung — không phân biệt config). */
  failedByAll: string[];
  /** Task chỉ đúng một config pass (phân biệt thật). */
  uniquelyPassed: Array<{ taskId: string; configId: string }>;
  /** Config tốt nhất theo từng metric (id hoặc null khi không so được). */
  winners: {
    accuracy: string | null;
    latency: string | null;
    cost: string | null;
  };
  totalDurationMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate một config (throw khi sai). */
export function validateBenchmarkConfig(raw: unknown): BenchmarkConfig {
  if (!isRecord(raw)) throw new Error('benchmark config must be an object.');
  const { id, label, model, harness } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('benchmark config needs a non-empty id.');
  if (typeof label !== 'string' || label.trim().length === 0) throw new Error('benchmark config needs a non-empty label.');
  if (typeof model !== 'string' || model.trim().length === 0) throw new Error('benchmark config needs a non-empty model.');
  if (typeof harness !== 'string' || harness.trim().length === 0) throw new Error('benchmark config needs a non-empty harness.');
  return { id: id.trim(), label: label.trim(), model: model.trim(), harness: harness.trim() };
}

/** Validate một task benchmark (throw khi sai). */
export function validateBenchmarkTask(raw: unknown): BenchmarkTask {
  if (!isRecord(raw)) throw new Error('benchmark task must be an object.');
  const { id, title } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('benchmark task needs a non-empty id.');
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('benchmark task needs a non-empty title.');
  return { id: id.trim(), title: title.trim() };
}

/** Validate một outcome do runner trả (throw khi sai — runner không được trả số âm). */
export function validateBenchmarkOutcome(raw: unknown): BenchmarkRunOutcome {
  if (!isRecord(raw)) throw new Error('benchmark outcome must be an object.');
  const { passed, durationMs, inputTokens, outputTokens } = raw;
  if (typeof passed !== 'boolean') throw new Error('benchmark outcome passed must be a boolean.');
  for (const [name, value] of [['durationMs', durationMs], ['inputTokens', inputTokens], ['outputTokens', outputTokens]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (value as number) < 0) {
      throw new Error(`benchmark outcome ${name} must be a finite number >= 0.`);
    }
  }
  return { passed, durationMs: durationMs as number, inputTokens: inputTokens as number, outputTokens: outputTokens as number };
}

/** Percentile (p50/p95) trên mảng số đã sort — linear interpolation. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p < 0 || p > 100) throw new Error('percentile must be between 0 and 100.');
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/** Aggregate các cell của một config thành summary. */
export function summarizeBenchmarkConfig(config: BenchmarkConfig, cells: BenchmarkCell[]): BenchmarkConfigSummary {
  const mine = cells.filter((c) => c.configId === config.id);
  const passed = mine.filter((c) => c.passed).length;
  const latencies = mine.map((c) => c.durationMs).sort((a, b) => a - b);
  const meanLatency = mine.length === 0 ? null : mine.reduce((s, c) => s + c.durationMs, 0) / mine.length;
  const priced = mine.filter((c) => c.costUsd !== null);
  const totalCost = priced.length === 0 ? null : priced.reduce((s, c) => s + (c.costUsd as number), 0);
  return {
    configId: config.id,
    label: config.label,
    model: config.model,
    harness: config.harness,
    tasksRun: mine.length,
    tasksPassed: passed,
    accuracy: mine.length === 0 ? null : passed / mine.length,
    meanLatencyMs: meanLatency,
    p95LatencyMs: percentile(latencies, 95),
    totalInputTokens: mine.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: mine.reduce((s, c) => s + c.outputTokens, 0),
    totalCostUsd: totalCost,
    costPerPassedTaskUsd: totalCost === null || passed === 0 ? null : totalCost / passed,
    costIncomplete: priced.length < mine.length,
  };
}

/**
 * Chạy benchmark: mọi config × mọi task (config ngoài chạy trước,
 * task trong chạy sau — thứ tự ổn định để report so sánh được).
 * Runner lỗi ở một cell → cell đó ghi failed + duration 0 + token 0
 * (không làm sập cả benchmark), lỗi ghi vào cell note qua cost null?
 * Không — lỗi runner được ghi thành outcome failed với duration đo
 * được; caller muốn biết lỗi thì tự log trong runner của mình.
 */
export async function runBenchmark(
  rawConfigs: unknown[],
  rawTasks: unknown[],
  runner: BenchmarkRunner,
): Promise<BenchmarkReport> {
  const started = Date.now();
  if (!Array.isArray(rawConfigs) || rawConfigs.length === 0) throw new Error('benchmark needs at least one config.');
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) throw new Error('benchmark needs at least one task.');
  const configs = rawConfigs.map(validateBenchmarkConfig);
  const tasks = rawTasks.map(validateBenchmarkTask);
  const configIds = new Set(configs.map((c) => c.id));
  if (configIds.size !== configs.length) throw new Error('benchmark config ids must be unique.');
  const taskIds = new Set(tasks.map((t) => t.id));
  if (taskIds.size !== tasks.length) throw new Error('benchmark task ids must be unique.');

  const cells: BenchmarkCell[] = [];
  for (const config of configs) {
    for (const task of tasks) {
      const cellStarted = Date.now();
      let outcome: BenchmarkRunOutcome;
      try {
        outcome = validateBenchmarkOutcome(await runner(config, task));
      } catch {
        // Runner lỗi (throw hoặc trả outcome sai): cell fail, duration
        // đo được, token 0 — benchmark tiếp tục với cell sau.
        outcome = { passed: false, durationMs: Date.now() - cellStarted, inputTokens: 0, outputTokens: 0 };
      }
      const cost = estimateCostDetailed(config.model, outcome.inputTokens, outcome.outputTokens).costUsd;
      cells.push({
        configId: config.id,
        taskId: task.id,
        passed: outcome.passed,
        durationMs: outcome.durationMs,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        costUsd: cost,
      });
    }
  }

  const summaries = configs.map((config) => summarizeBenchmarkConfig(config, cells));
  const failedByAll = tasks
    .filter((task) => cells.filter((c) => c.taskId === task.id).every((c) => !c.passed))
    .map((t) => t.id);
  const uniquelyPassed: Array<{ taskId: string; configId: string }> = [];
  for (const task of tasks) {
    const passing = cells.filter((c) => c.taskId === task.id && c.passed);
    if (passing.length === 1) uniquelyPassed.push({ taskId: task.id, configId: passing[0].configId });
  }
  const bestBy = (
    key: (s: BenchmarkConfigSummary) => number | null,
    higherIsBetter: boolean,
  ): string | null => {
    let best: BenchmarkConfigSummary | null = null;
    for (const summary of summaries) {
      const value = key(summary);
      if (value === null) continue;
      if (best === null) {
        best = summary;
        continue;
      }
      const bestValue = key(best) as number;
      if (higherIsBetter ? value > bestValue : value < bestValue) best = summary;
    }
    return best?.configId ?? null;
  };
  return {
    generatedAt: new Date().toISOString(),
    tasks,
    configs,
    cells,
    summaries,
    failedByAll,
    uniquelyPassed,
    winners: {
      accuracy: bestBy((s) => s.accuracy, true),
      latency: bestBy((s) => s.meanLatencyMs, false),
      cost: bestBy((s) => s.totalCostUsd, false),
    },
    totalDurationMs: Date.now() - started,
  };
}

/** Render report thành bảng Markdown (accuracy / latency / cost cùng lúc). */
export function benchmarkReportToMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# Benchmark report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Configs: ${report.configs.length} × Tasks: ${report.tasks.length} (${report.cells.length} runs, ${(report.totalDurationMs / 1000).toFixed(1)}s)`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Config | Model | Harness | Accuracy | Mean latency | p95 latency | Total cost | Cost / passed task |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of report.summaries) {
    const accuracy = s.accuracy === null ? '—' : `${(s.accuracy * 100).toFixed(1)}% (${s.tasksPassed}/${s.tasksRun})`;
    const mean = s.meanLatencyMs === null ? '—' : `${(s.meanLatencyMs / 1000).toFixed(2)}s`;
    const p95 = s.p95LatencyMs === null ? '—' : `${(s.p95LatencyMs / 1000).toFixed(2)}s`;
    const cost = s.totalCostUsd === null ? 'unknown' : `$${s.totalCostUsd.toFixed(4)}${s.costIncomplete ? ' *' : ''}`;
    const perPassed = s.costPerPassedTaskUsd === null ? '—' : `$${s.costPerPassedTaskUsd.toFixed(4)}`;
    lines.push(`| ${s.label} | ${s.model} | ${s.harness} | ${accuracy} | ${mean} | ${p95} | ${cost} | ${perPassed} |`);
  }
  lines.push('');
  lines.push('* Total cost marked `unknown` or `*` when the model has no price in the built-in table — cost is incomplete, never invented.');
  lines.push('');
  const winnerLabel = (id: string | null): string => {
    if (id === null) return '—';
    return report.summaries.find((s) => s.configId === id)?.label ?? id;
  };
  lines.push(`Winners — accuracy: **${winnerLabel(report.winners.accuracy)}** · latency: **${winnerLabel(report.winners.latency)}** · cost: **${winnerLabel(report.winners.cost)}**`);
  lines.push('');
  lines.push('## Per-task results');
  lines.push('');
  lines.push(`| Task | ${report.configs.map((c) => c.label).join(' | ')} |`);
  lines.push(`| --- | ${report.configs.map(() => '---').join(' | ')} |`);
  for (const task of report.tasks) {
    const marks = report.configs.map((config) => {
      const cell = report.cells.find((c) => c.taskId === task.id && c.configId === config.id);
      if (!cell) return '—';
      return cell.passed ? `✅ ${(cell.durationMs / 1000).toFixed(1)}s` : '❌';
    });
    lines.push(`| ${task.id} | ${marks.join(' | ')} |`);
  }
  lines.push('');
  if (report.failedByAll.length > 0) {
    lines.push(`Tasks failed by all configs (${report.failedByAll.length}): ${report.failedByAll.join(', ')}`);
    lines.push('');
  }
  if (report.uniquelyPassed.length > 0) {
    lines.push('Uniquely passed tasks (only one config passed):');
    lines.push('');
    for (const u of report.uniquelyPassed) {
      lines.push(`- ${u.taskId}: ${winnerLabel(u.configId)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
