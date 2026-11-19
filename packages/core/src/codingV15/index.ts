/**
 * Coding agent v15 (v1.37, Đội T4) — public exports.
 *
 * Agent profiles (persona + tool set + model, nhãn ACP), budget
 * meter CHỈ-BÁO-CÁO (token + cost ước tính so với cap, ngưỡng
 * 80%/100%, vượt cap vẫn chạy), hooks dialog (stop-hook feedback
 * ngoài chat — xem/xác nhận/bỏ qua từ dialog), verify scenarios
 * vượt happy path (9 scenario, kỳ vọng rõ ràng, báo cáo pass/fail
 * từng scenario), agent pipeline nối 4 lớp trên.
 *
 * Nối (không viết lại): coding agent v14 (agent pipeline +
 * reasoning blocks + stuck recovery), budget meter v12 (ý tưởng
 * ngưỡng + cost ước lượng), ACP registry.
 */

export * from './types';
export {
  CodingV15ProfileStore,
  V15_PROFILE_BUILTIN_PREFIX,
  V15_PROFILE_DEFAULT_MAX_STEPS,
  V15_PROFILE_FILE_NAME,
  V15_PROFILE_MAX_PERSONA_CHARS,
  V15_PROFILE_MAX_SYSTEM_PROMPT_CHARS,
  V15_PROFILE_MAX_TOOLS,
  renderV15ProfileSummary,
  v15AcpDisplayName,
  v15ApplyProfile,
  v15BuildProfileSystemPrompt,
  v15BuiltinProfiles,
  v15EffectiveTools,
  v15NormalizeNewProfile,
  v15ProfileAllowsTool,
  v15SlugifyProfileId,
  v15ValidateProfileId,
} from './profiles';
export type { V15ProfileStoreOptions } from './profiles';
export {
  CodingV15BudgetMeter,
  V15_BUDGET_MAX_COST_USD,
  V15_BUDGET_MAX_TOKENS,
  V15_BUDGET_REPORT_ONLY_NOTE,
  V15_BUDGET_TOKEN_CHARS_PER_TOKEN,
  V15_BUDGET_WARN_100,
  V15_BUDGET_WARN_80,
  renderV15BudgetForecast,
  renderV15BudgetHistory,
  renderV15BudgetReport,
  renderV15BudgetSummary,
  v15BudgetPercent,
  v15EstimateTokensFromChars,
  v15ForecastBudget,
  v15FormatPercent,
  v15FormatUsd,
  v15ValidateBudgetCap,
} from './budget';
export type { V15BudgetForecast, V15BudgetRecordResult } from './budget';
export {
  CodingV15HooksDialog,
  V15_HOOKS_DIALOG_FILE_NAME,
  V15_HOOK_MAX_SNOOZE,
  renderV15HookFeedbackSummary,
  renderV15HooksDialog,
  routeStopHookFeedback,
  v15NewHookFeedbackId,
  v15ValidateNewHookFeedback,
} from './hooksDialog';
export type { V15HooksDialogOptions } from './hooksDialog';
export {
  V15_VERIFY_DEFAULT_TIMEOUT_MS,
  V15_VERIFY_DESCRIPTIONS,
  V15_VERIFY_EXPECTATIONS,
  V15_VERIFY_LARGE_DIFF_CHARS,
  V15_VERIFY_MAX_RETRIES,
  V15_VERIFY_NAMES,
  renderV15VerifyReport,
  v15BuiltinScenario,
  v15BuiltinScenarios,
  v15CheckStepOutcome,
  v15CorrectOutcomes,
  v15CustomScenario,
  v15FindScenario,
  v15RunScenario,
  v15RunVerifyScenarios,
  v15ScenarioOutcomeTemplate,
  v15ScriptedVerifyStepFn,
  v15ValidateScenario,
  v15WrongOutcomes,
} from './verifyScenarios';
export type { V15CustomScenarioInput, V15VerifyRunOptions, V15VerifyStepFn } from './verifyScenarios';
export {
  V15_AGENT_DEFAULT_MAX_STEPS,
  V15_RUN_LOG_SUBDIR,
  renderV15AgentReport,
  runV15Agent,
  runV15AgentWithVerify,
  scriptedV15Agent,
  v15BuildResumeState,
  v15ValidateRunInput,
} from './agent';
export type { V15AgentOptions, V15AgentState, V15FileApplier, V15ResumeState, V15StepFn } from './agent';
export {
  buildV15RunReport,
  renderV15RunReportMarkdown,
  v15ExportBudgetHistory,
  v15ImportBudgetHistory,
  v15IsValidUsageRecord,
} from './runReport';
export type { V15BudgetExportFile, V15BudgetImportResult, V15RunReport, V15RunReportInput } from './runReport';
export {
  CodingV15VerifyHistory,
  V15_VERIFY_HISTORY_FILE_NAME,
  V15_VERIFY_HISTORY_MAX_MEMORY,
  renderV15VerifyComparison,
  renderV15VerifyFlaky,
  v15CompareVerifyReports,
  v15IsValidVerifyReport,
} from './verifyHistory';
export type { V15VerifyComparison, V15VerifyFlaky, V15VerifyHistoryOptions, V15VerifyTrendPoint } from './verifyHistory';
export {
  V15_EVAL_GRADE_THRESHOLDS,
  V15_EVAL_WEIGHTS,
  renderV15EvalResult,
  v15EvalRun,
} from './evalV15';
export type { V15EvalDimension, V15EvalResult } from './evalV15';
