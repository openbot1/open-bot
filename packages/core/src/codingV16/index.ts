/**
 * Coding agent v16 (v1.38, Đội T4) — public exports.
 *
 * Harness mua token, không mua điểm (nghiên cứu trong survey v138
 * §3): token-budget meter + harness-cost estimator (đo chi phí/task
 * theo từng harness, báo cáo cost/accuracy trade-off), minimal
 * harness (vòng lặp bash-only, preamble gọn), file-window viewer
 * (cửa sổ 100 dòng), edit linter gate (chặn thay đổi sai cú pháp
 * trước khi ghi), history trimmer tự động (giữ 5 tool-output gần
 * nhất), benchmark nội bộ đo cost/accuracy.
 *
 * Nối (không viết lại): coding agent v14 (condenser, stuck, reasoning).
 */

export * from './types';
export {
  TokenBudgetMeter,
  V16_DEFAULT_TASK_BUDGET,
  renderV16BudgetStatus,
  renderV16SessionReport,
  v16BudgetAdvice,
  v16BudgetForecast,
  v16BudgetStatusFor,
  v16EstimateTokens,
  v16SampleFromJsonl,
  v16SamplesFromJsonl,
  v16SampleToJsonl,
  v16SessionReport,
  v16SumSamples,
  v16TokensByHarness,
  v16ValidateBudget,
  v16ValidateSample,
} from './tokenBudget';
export type { V16BudgetForecast, V16HarnessTokenTotal, V16SessionTokenReport, V16TokenBudgetMeterOptions } from './tokenBudget';
export {
  HarnessCostEstimator,
  renderV16CostAccuracyReport,
  renderV16FlakinessSummary,
  v16AnalyzeFlakiness,
  v16BuildCostAccuracyReport,
  v16CompareHarness,
  v16CostsByModel,
  v16FindPrice,
  v16PriceRun,
  v16RecommendHarness,
  v16SummarizeFlakiness,
} from './harnessCost';
export type { V16FlakinessSummary, V16HarnessCostEstimatorOptions, V16HarnessRecommendation, V16ModelCostTotal, V16TaskFlakiness } from './harnessCost';
export {
  V16_MINIMAL_PREAMBLE,
  V16_MINIMAL_PREAMBLE_SECTIONS,
  renderV16MinimalReport,
  runV16Minimal,
  v16ApplyFileWrite,
  v16BuildDefaultPreamble,
  v16BuildPreamble,
  v16MinimalPreambleTokens,
  v16PreambleSavedVsFull,
  v16ValidateMinimalStep,
} from './minimalHarness';
export type { V16BuiltPreamble, V16PreambleSection, V16RunMinimalInput } from './minimalHarness';
export {
  renderV16FileOutline,
  renderV16FileWindow,
  v16FileOutline,
  v16GetWindow,
  v16NumberLines,
  v16PageForLine,
  v16SearchInFile,
  v16SplitLines,
  v16TotalPages,
  v16WindowAroundLine,
  v16WindowCenteredOnLine,
} from './fileWindow';
export type { V16FileOutlineEntry, V16FileSearchHit } from './fileWindow';
export {
  V16_LINT_LANGUAGE_BY_EXTENSION,
  renderV16LintResult,
  v16CheckDelimiters,
  v16CheckGeneric,
  v16CheckHtmlTags,
  v16CheckJson,
  v16CheckJsonDuplicateKeys,
  v16CheckPython,
  v16CheckYaml,
  v16LanguageForPath,
  v16LintAllowsWrite,
  v16LintContent,
} from './editLinter';
export type { V16LintLanguage } from './editLinter';
export {
  renderV16TrimResult,
  renderV16TrimRoundsResult,
  v16EntryTokens,
  v16HistoryTokens,
  v16NewHistoryEntry,
  v16ShouldTrim,
  v16SummarizeEntry,
  v16SummarizeTrimmed,
  v16TrimHistory,
  v16TrimUntilFit,
} from './historyTrimmer';
export type { V16TrimRoundsResult } from './historyTrimmer';
export {
  renderV16BenchmarkReport,
  renderV16BenchmarkRerunReport,
  runV16Benchmark,
  runV16BenchmarkRerun,
  v16ValidateBenchmarkTask,
} from './benchmark';
export type { V16BenchmarkRerunReport, V16RunBenchmarkInput } from './benchmark';
export {
  CodingAgentV16,
  renderV16AgentReport,
  runV16Agent,
  runV16AgentResume,
  v16AgentStateFromReport,
  v16BashStep,
  v16DoneStep,
} from './agent';
export type { CodingAgentV16Options, V16ResumeAgentInput, V16RunAgentInput } from './agent';
