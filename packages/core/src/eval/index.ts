/**
 * Eval v3 public surface — memory eval dataset + scoring + runner.
 * (Nối tiếp eval harness v2 ở `observability/evalHarness.ts`, vốn
 * chấm run đã ghi; module này đo memory retrieval bằng dataset
 * fixture offline.)
 */
export {
  BUILTIN_MEMORY_EVAL_DATASET,
  indexFactsById,
  validateMemoryEvalDataset,
} from './memoryDataset';
export type {
  MemoryEvalDataset,
  MemoryEvalQuestion,
  MemoryEvalQuestionCategory,
  MemoryFact,
} from './memoryDataset';
export {
  analyzeDatasetCoverage,
  renderCoverageMarkdown,
} from './coverage';
export type { DatasetCoverage, UncoveredFact } from './coverage';
export {
  runRetrieverBenchmark,
  renderBenchmarkMarkdown,
} from './benchmark';
export type {
  BenchmarkRetrieverEntry,
  BenchmarkRow,
  RetrieverBenchmark,
  RunRetrieverBenchmarkOptions,
} from './benchmark';
export {
  EVAL_MEMORY_SCHEDULE_FILE,
  dueEvalSchedules,
  getEvalSchedule,
  listEvalSchedules,
  markEvalScheduleRun,
  removeEvalSchedule,
  setEvalSchedule,
} from './scheduleStore';
export type { EvalScheduleEntry } from './scheduleStore';
export {
  BUILTIN_MEMORY_EVAL_DATASETS,
  HANDOVER_MEMORY_EVAL_DATASET,
  getBuiltinMemoryEvalDataset,
} from './datasets';
export {
  renderEvalComparisonMarkdown,
  renderMemoryEvalReportMarkdown,
  renderRegressionAlertsMarkdown,
  summarizeEvalHistory,
} from './report';
export type { EvalHistoryTrend } from './report';
export {
  InMemoryMockRetriever,
  KeywordMockRetriever,
  MOCK_EMBEDDING_DIM,
  cosineSimilarity,
  fnv1aHash32,
  mockEmbed,
  mockJudgeAnswer,
  runMemoryEval,
  scoreMemoryQuestion,
  tokenizeEvalText,
} from './memoryEval';
export type {
  MemoryCategoryScore,
  MemoryEvalReport,
  MemoryQuestionScore,
  MemoryRetrievalHit,
  MemoryRetriever,
  RunMemoryEvalOptions,
} from './memoryEval';
export {
  DEFAULT_EVAL_SCHEDULE,
  DEFAULT_REGRESSION_THRESHOLDS,
  EVAL_MEMORY_HISTORY_FILE,
  checkMemoryEvalRegression,
  compareMemoryEvalReports,
  isEvalRunDue,
  listMemoryEvalHistory,
  nextScheduledRunMs,
  pruneMemoryEvalHistory,
  runMemoryEvalSuite,
  validateEvalRunnerConfig,
  validateRegressionThresholds,
} from './runner';
export type {
  EvalComparison,
  EvalRunnerConfig,
  EvalScheduleConfig,
  RegressionAlert,
  RegressionThresholds,
  RunMemoryEvalSuiteResult,
} from './runner';

// --- v1.06 (Đội T6): eval benchmark v4 — memory eval (tiers) + MCP conformance ---
// T6's runMemoryEval (không đối số, trả EvalSuiteResult) khác runMemoryEval
// v1.05 (dataset + options) nên export với tên runMemoryEvalV106; bản gốc
// T6 nằm ở memoryEvalV106.ts.
/**
 * Eval runner — chạy một hoặc tất cả suite, gộp thành báo cáo
 * (v1.06, Đội T6). Xem `types.ts` (định nghĩa báo cáo) và các suite
 * `memoryEval.ts` / `mcpConformanceEval.ts`.
 */

import { runMemoryEval } from './memoryEvalV106';
import { runMcpConformanceEval } from './mcpConformanceEval';
import {
  buildEvalReport,
  formatEvalReportText,
  getEvalReportsDir,
  listEvalReports,
  loadEvalReport,
  saveEvalReport,
  type EvalReport,
  type EvalSuiteName,
  type EvalSuiteResult,
} from './types';

export { EVAL_SUITE_NAMES } from './types';
export type { EvalCaseResult, EvalReport, EvalSuiteName, EvalSuiteResult } from './types';
export {
  buildEvalReport,
  buildEvalSuiteResult,
  formatEvalReportText,
  getEvalReportsDir,
  listEvalReports,
  loadEvalReport,
  runEvalCase,
  saveEvalReport,
} from './types';
export {
  MEMORY_EVAL_DEFAULT_DISTRACTOR_TURNS,
  MEMORY_EVAL_HEAVY_DISTRACTOR_TURNS,
  MEMORY_TIERS,
  TIER_DURABLE_MIN_CONFIDENCE,
  TIER_PROMOTE_RECALLS,
  demoteTierOnContradiction,
  memoryTierFor,
  promoteTierOnRecall,
  runMemoryEval as runMemoryEvalV106,
} from './memoryEvalV106';
export type { MemoryTier } from './memoryEvalV106';
export { runMcpConformanceEval } from './mcpConformanceEval';

/** Chạy một suite theo tên. */
export async function runEvalBenchmarkSuite(suite: EvalSuiteName): Promise<EvalSuiteResult> {
  if (suite === 'memory') return runMemoryEval();
  return runMcpConformanceEval();
}

/**
 * Chạy eval: `suites` là danh sách suite (mặc định cả hai).
 * Khi `saveDir` được cho, báo cáo được lưu vào
 * `<saveDir>/eval-reports/<id>.json` và trả về kèm `reportPath`.
 */
export async function runEval(
  suites: readonly EvalSuiteName[] = ['memory', 'mcp-conformance'],
  options: { saveDir?: string } = {},
): Promise<{ report: EvalReport; reportPath: string | null }> {
  const results: EvalSuiteResult[] = [];
  for (const suite of suites) {
    results.push(await runEvalBenchmarkSuite(suite));
  }
  const report = buildEvalReport(results);
  const reportPath = options.saveDir !== undefined ? saveEvalReport(options.saveDir, report) : null;
  return { report, reportPath };
}
export {
  buildEvalTrends,
  caseTrendFromResults,
  formatEvalTrendsText,
  loadEvalReportHistory,
} from './trends';
export type { EvalCaseTrend, EvalSuiteTrend, EvalTrends } from './trends';
