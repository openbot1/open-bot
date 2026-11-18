/**
 * Coding agent v12 (v1.20, Đội T3) — public exports.
 *
 * Học ý tưởng OpenHands Large Codebase SDK + Aider v2 (git-first) +
 * ACP model switching + SWE-bench eval (chỉ học ý tưởng, tự thiết kế
 * và viết lại hoàn toàn), nối coding agent v11 (call graph, CodeAct
 * v9, refactor, eval v2, patch review, testgen) bằng 7 lớp mới:
 *
 *   1. Dependency graph (`dependencyGraph.ts`): parse import TS/JS →
 *      graph, topological lá-trước-gốc-sau, Tarjan cycles, chia task
 *      edit lớn thành edit nhỏ có thứ tự + coordinator nội bộ.
 *   2. Visualizer v2 (`visualizerV12.ts`): cây sub-agent realtime
 *      (event stream, blocked/waiting, file đang sửa, token/cost).
 *   3. Budget meters (`budgetMeters.ts`): meter token/cost/time/
 *      steps, cảnh báo 50/80/100%, auto-summarize (compaction).
 *   4. ACP model switching (`acpModelSwitch.ts`): đổi model giữa
 *      chừng, giữ transcript, re-announce capabilities, rollback.
 *   5. Edit strategy (`editStrategyV12.ts`): diff/patch kiểu Aider
 *      v2 — mỗi edit một commit riêng, verify sau mỗi edit, rollback
 *      từng edit bằng revert.
 *   6. Eval v3 (`evalV12.ts`): chấm chất lượng edit theo 4 chiều
 *      (đúng file, test pass, không regression, diff gọn), chạy
 *      local trên repo tạm git thật, báo cáo + so sánh baseline.
 *   7. Agent v12 (`agent.ts`): pipeline nối 6 lớp trên + agent v11.
 */

export * from './types';
export {
  V12_DEP_SOURCE_EXTENSIONS,
  V12_DEP_MAX_FILES,
  v12NewEditPlanId,
  v12IsExternalImport,
  v12StripComments,
  v12ExtractImportSpecifiers,
  v12ResolveImport,
  v12CollectSourceFiles,
  v12BuildDepGraph,
  v12TopologicalOrder,
  v12BuildDepGraphFromDir,
  v12ImpactSet,
  v12TopRootFiles,
  v12PlanOrderedEdits,
  V12EditCoordinator,
  renderV12DepGraphSummary,
  renderV12EditPlanSummary,
} from './dependencyGraph';
export {
  V12_TASK_STATUSES,
  V12_DEFAULT_MAX_LOG_LINES,
  V12_STATUS_ICONS,
  v12IsTerminalStatus,
  V12TaskVisualizer,
  v12VisualizerFromSnapshot,
  v12DiffSnapshots,
  renderV12TaskTreeText,
} from './visualizerV12';
export type { V12AddTaskOptions, V12UpdateTaskPatch } from './visualizerV12';
export {
  V12_BUDGET_TOKEN_CHARS_PER_TOKEN,
  V12_BUDGET_WARN_50,
  V12_BUDGET_WARN_80,
  V12_BUDGET_WARN_100,
  V12_BUDGET_DEFAULT_AUTO_SUMMARIZE_AT,
  V12_BUDGET_DEFAULT_KEEP_RECENT,
  V12_BUDGET_MAX_TOKENS,
  V12_BUDGET_MAX_TIME_MS,
  v12WarningLevel,
  v12EstimateTokens,
  validateV12ConversationBudget,
  V12ConversationBudgetMeter,
  defaultV12Summarizer,
  renderV12BudgetSummary,
} from './budgetMeters';
export type { V12SummarizerFn, V12BudgetWarningFn, V12BudgetMeterOptions } from './budgetMeters';
export {
  v12NewAcpSwitchId,
  v12NewAcpSessionId,
  validateV12AcpModelId,
  v12EnabledCapabilities,
  v12CapabilityDiff,
  v12MissingCapabilities,
  V12AcpSession,
  v12AcpSessionFromJson,
  renderV12AcpSessionSummary,
} from './acpModelSwitch';
export type { V12AcpSwitchOptions, V12AcpSwitchResult } from './acpModelSwitch';
export {
  V12_EDIT_DEFAULT_VERIFY_TIMEOUT_MS,
  V12_EDIT_MAX_VERIFY_TIMEOUT_MS,
  V12_EDIT_VERIFY_OUTPUT_LIMIT,
  V12_EDIT_MAX_DIFF_CHARS,
  V12_EDIT_MAX_PATCH_BLOCKS,
  V12_EDIT_AUTHOR_NAME,
  V12_EDIT_AUTHOR_EMAIL,
  v12NewEditId,
  validateV12Edit,
  v12ParseUnifiedDiffFiles,
  v12CountDiffLines,
  v12ApplyPatchBlocksToContent,
  stripTestRunnerEnv,
  runV12Command,
  runV12Verify,
  v12CommitMessageForEdit,
  V12EditStrategy,
  renderV12EditHistorySummary,
} from './editStrategyV12';
export type { V12EditStrategyOptions, V12ApplyEditOptions } from './editStrategyV12';
export {
  V12_EVAL_DEFAULT_ATTEMPTS,
  V12_EVAL_MAX_ATTEMPTS,
  V12_EVAL_MAX_TASKS_PER_SUITE,
  V12_EVAL_FAILURE_EXCERPT_CHARS,
  V12_EVAL_DEFAULT_TEST_TIMEOUT_MS,
  V12_EVAL_TOKEN_CHARS_PER_TOKEN,
  V12_EVAL_SUITE_NAME,
  V12_EVAL_DETAIL_FILE,
  V12_EVAL_DIMENSION_WEIGHTS,
  V12_EVAL_ECONOMY_FREE_LINES,
  V12_EVAL_ECONOMY_FLOOR_LINES,
  V12_EVAL_ECONOMY_FLOOR,
  V12_EVAL_CHANGED_TASK_DELTA,
  validateV12EvalTask,
  v12SafeVersionName,
  v12ScoreFileAccuracy,
  v12ScoreDiffEconomy,
  v12ScoreEval,
  runV12EvalAttempt,
  runV12EvalSuite,
  saveV12EvalReport,
  loadV12EvalReport,
  listV12EvalVersions,
  compareV12EvalReports,
  v12SummarizeEvalReport,
  renderV12EvalReport,
  V12_EVAL_SAMPLE_TASKS,
  V12_SAMPLE_PATCH_ADD,
  V12_SAMPLE_PATCH_CAPITALIZE,
  V12_SAMPLE_PATCH_MAX_WRONG,
  scriptedV12Agent,
} from './evalV12';
export type { V12EvalAgentFn, V12EvalSuiteOptions, V12EvalAttemptDetail } from './evalV12';
export {
  v12NewAgentTaskId,
  runV12Agent,
  CodingAgentV12,
  renderV12AgentReport,
} from './agent';
export type { V12AgentEditProvider, V12AgentOptions } from './agent';
