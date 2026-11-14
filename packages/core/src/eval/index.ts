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
