/**
 * Observability — public surface of `packages/core/src/observability/`.
 *
 * Local-only, OpenTelemetry-flavoured: cost estimates on top of the
 * built-in price table, OTel JSON export to a local file (never sent
 * anywhere), and read-only queries over the trace store.
 */
export { estimateCostDetailed, formatUsd, isKnownModel, isLocalModel, sumCosts } from './cost';
export type { CostDetail } from './cost';
export {
  OtelExporter,
  estimateSpanCost,
  estimateTraceCost,
  readOtelTraces,
  recordApprovalEvent,
  recordCancelEvent,
  recordRetryEvent,
  recordSpanEvent,
  spanToOtel,
  traceToOtel,
} from './otel';
export type { OtelResourceSpan, OtelSpan } from './otel';
export { TraceQuery } from './query';
export type { DayBucket, ModelCost, SpanTimelineEntry, TraceAggregate, TraceQueryFilter } from './query';
// v1.03 (Team T6): event-stream viewer + eval harness (read-only over
// the event-sourced run log; see event-log/ for the log itself).
export {
  bucketEventStream,
  filterRunEvents,
  listEventTypesPresent,
  summarizeEventStream,
  tailEvents,
} from './eventStream';
export type {
  EventStreamBucket,
  EventStreamFilter,
  EventStreamRunMeta,
  EventStreamSummary,
} from './eventStream';
export {
  EVAL_SUITES_FILE,
  addEvalCase,
  createEvalSuite,
  listEvalSuites,
  removeEvalCase,
  removeEvalSuite,
  runEvalSuite,
  scoreEvalCase,
} from './evalHarness';
export type {
  AddEvalCaseInput,
  EvalCase,
  EvalCaseResult,
  EvalCheck,
  EvalCheckResult,
  EvalSuite,
  EvalSuiteReport,
} from './evalHarness';
// v1.04 (Team T6): SWE-bench-style local eval + contamination-free runner
// + benchmark harness + run metrics + OTLP export.
export {
  DEFAULT_SWE_SOLVER_TIMEOUT_MS,
  DEFAULT_SWE_TEST_TIMEOUT_MS,
  SWE_OUTPUT_LIMIT,
  runSweBenchSuite,
  runSweBenchTask,
  runTestCommand,
  runTestGroup,
  saveSweBenchReport,
  sweBenchReportToMarkdown,
  validateSweBenchTask,
  validateSweTestCommand,
} from './sweBenchEval';
export type {
  SweBenchReport,
  SweBenchTask,
  SweRunnerOptions,
  SweSolver,
  SweTaskResult,
  SweTaskStatus,
  SweTestCommand,
  SweTestResult,
} from './sweBenchEval';
export {
  CONTAMINATION_MAX_MATCHES_LISTED,
  DEFAULT_CONTAMINATION_CONTAMINATED_THRESHOLD,
  DEFAULT_CONTAMINATION_NGRAM_SIZE,
  DEFAULT_CONTAMINATION_SUSPECT_THRESHOLD,
  EvalHashRegistry,
  contaminationTaskReport,
  ngramsOf,
  normalizeTextForContamination,
  scanContamination,
  scanContaminationMany,
  sha256Hex,
  stripEvalMaterial,
  tokenizeForContamination,
} from './contamination';
export type {
  ContaminationScanOptions,
  ContaminationScanResult,
  ContaminationTaskReport,
  ContaminationVerdict,
} from './contamination';
export {
  benchmarkReportToMarkdown,
  percentile,
  runBenchmark,
  summarizeBenchmarkConfig,
  validateBenchmarkConfig,
  validateBenchmarkOutcome,
  validateBenchmarkTask,
} from './benchmark';
export type {
  BenchmarkCell,
  BenchmarkConfig,
  BenchmarkConfigSummary,
  BenchmarkReport,
  BenchmarkRunner,
  BenchmarkRunOutcome,
  BenchmarkTask,
} from './benchmark';
export {
  RUN_METRICS_FILE,
  RUN_METRIC_KINDS,
  RUN_METRIC_STATUSES,
  aggregateRunMetrics,
  costOfRunMetric,
  getRunMetricsPath,
  parseRunMetricLine,
  readRunMetrics,
  recordRunMetric,
  summarizeRunMetricsFile,
  validateRunMetricInput,
} from './runMetrics';
export type {
  RecordRunMetricInput,
  RunMetric,
  RunMetricGroupSummary,
  RunMetricKind,
  RunMetricStatus,
  RunMetricsAggregate,
} from './runMetrics';
export {
  DEFAULT_OTLP_ENDPOINT,
  DEFAULT_OTLP_TIMEOUT_MS,
  buildOtlpMetricsPayload,
  buildOtlpTracesPayload,
  exportMetricsOtlp,
  exportTracesOtlp,
  isOtlpAllowedHost,
  isOtlpLoopbackHost,
  otlpMetricsUrl,
  otlpTracesUrl,
  validateOtlpConfig,
} from './otlp';
export type { OtlpConfig, OtlpExportResult, OtlpMetric } from './otlp';
// v1.04 (Team T6): durable store for SWE-bench task definitions.
export {
  SWE_TASKS_FILE,
  createSweTask,
  getSweTask,
  getSweTasksPath,
  listSweTasks,
  loadSweTasks,
  removeSweTask,
  saveSweTasks,
  updateSweTask,
  validateCreateSweTaskInput,
} from './sweBenchStore';
export type { CreateSweTaskInput, StoredSweTask } from './sweBenchStore';
