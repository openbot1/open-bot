/**
 * Coding agent v17 (v1.39, Đội T4) — public exports.
 *
 * Học ý tưởng OpenHands 1.x (survey v139 §4), code gốc của open-bot:
 * event-sourced trajectory log (replay/recovery), repo-map PageRank
 * v+1 (personalized + cập nhật tăng dần), eval harness mở rộng
 * (oracle + test xác định + gate trước khi trình), verification stack
 * nhiều tầng (critic trajectory/patch + review skill tự động + Plan
 * Mode bắt buộc với task đa file), sandbox bwrap DÙNG THẬT qua
 * BotBoxManager (bài học audit OB-005 — giới hạn CPU/RAM từng bot,
 * chạy non-root, fallback ghi rõ).
 *
 * Nối (không viết lại): coding agent v16 (token budget, harness cost,
 * minimal harness, file window, edit linter, history trimmer,
 * benchmark) và repo map v4.
 */

export * from './types';
export {
  TrajectoryLog,
  renderV17ReplayState,
  renderV17Trajectory,
  v17CanonicalJson,
  v17CompactTrajectory,
  v17EventFromJsonl,
  v17EventHash,
  v17EventToJsonl,
  v17EventsFromJsonl,
  v17RecoverEvents,
  v17ReplayEvents,
  v17SummarizeEvent,
  v17ValidateEvent,
  v17ValidateEventPayload,
  v17VerifyEvents,
} from './trajectory';
export {
  V17_DEFAULT_DAMPING,
  V17_DEFAULT_FRESHNESS_HALF_LIFE_MS,
  V17_DEFAULT_REPO_MAP_WEIGHTS,
  V17_EDGE_WEIGHT_IMPORT,
  V17_EDGE_WEIGHT_REFERENCE,
  V17_PAGERANK_EPSILON,
  V17_PAGERANK_MAX_ITERATIONS,
  renderV17RepoMap,
  v17BuildGraph,
  v17BuildRepoMap,
  v17CombineRanks,
  v17DetectChangedFiles,
  v17ExtractImports,
  v17ExtractSymbols,
  v17FileFingerprint,
  v17FreshnessScores,
  v17PageRank,
  v17QueryRepoMap,
  v17ReferenceScores,
  v17ResolveImport,
  v17UpdateRepoMap,
  v17ValidateRepoMapWeights,
} from './repoMap';
export {
  V17_DEFAULT_DETERMINISM_RUNS,
  V17_DEFAULT_EVAL_SETUP_TIMEOUT_MS,
  V17_DEFAULT_EVAL_TEST_TIMEOUT_MS,
  V17_EVAL_MAX_OUTPUT_CHARS,
  renderV17EvalReport,
  renderV17EvalSuiteReport,
  v17AssertSafeEvalPath,
  v17DefaultCommandExecutor,
  v17RunEvalSuite,
  v17RunEvalTask,
  v17RunsAgree,
  v17ScoreTestResult,
  v17ValidateEvalTask,
  v17ValidateEvalTest,
  v17WriteEvalFiles,
} from './evalHarness';
export type { V17CommandExecutor, V17CommandResult, V17EvalSuiteReport } from './evalHarness';
export {
  V17_CRITIC_APPROVE_SCORE,
  V17_CRITIC_BLOCK_SCORE,
  V17_REVIEW_MAX_FILE_CHARS,
  V17_REVIEW_MAX_PATCH_LINES,
  V17_REVIEW_RULES,
  renderV17PatchCriticScore,
  renderV17ReviewResult,
  renderV17TrajectoryCriticScore,
  v17ContainsDestructiveCommand,
  v17ContainsSecret,
  v17CountDiffLines,
  v17CountRedundantWrites,
  v17CountRepeatedBash,
  v17CountUnresolvedErrors,
  v17CriticVerdictFor,
  v17ReviewPatch,
  v17ScorePatch,
  v17ScoreTrajectory,
} from './critic';
export type { V17ReviewRule } from './critic';
export type { V17TrajectoryCompaction } from './trajectory';
export {
  V17_MULTI_FILE_THRESHOLD,
  V17_PLAN_MAX_STEPS,
  V17_PLAN_TRANSITIONS,
  renderV17Plan,
  v17CheckPlanDeviation,
  v17CompletePlanStep,
  v17CreatePlan,
  v17FinishPlan,
  v17NextStepId,
  v17PlanAllStepsDone,
  v17PlanProgress,
  v17RefinePlan,
  v17RejectPlan,
  v17RequirePlanForTask,
  v17TransitionPlan,
  v17ValidatePlan,
  v17ValidatePlanStep,
} from './planMode';
export {
  V17_DEFAULT_SANDBOX_MAX_OUTPUT_CHARS,
  V17_DEFAULT_SANDBOX_MAX_WRITE_BYTES,
  V17_DEFAULT_SANDBOX_TIMEOUT_MS,
  V17SandboxRunner,
  renderV17SandboxRun,
  v17CurrentUid,
  v17IsNonRoot,
  v17ProbeSandbox,
  v17RequireBwrap,
  v17SandboxCommandExecutor,
  v17ValidateSandboxBotId,
  v17ValidateSandboxLimits,
} from './sandboxExec';
export {
  renderV17SessionList,
  renderV17SessionSummary,
  v17ListOpenSessions,
  v17ListSessions,
  v17PruneSessions,
  v17SessionSummary,
  v17TrajectoriesDir,
} from './sessions';
export type { V17SessionListEntry, V17SessionPruneResult, V17SessionSummary } from './sessions';
export {
  CodingAgentV17,
  renderV17AgentReport,
  runV17Agent,
  runV17AgentResume,
  v17ApplyAgentFileWrite,
  v17BuildVerificationReport,
  v17TempDataDir,
  v17TrajectoryFile,
  v17ValidateAgentStep,
  v17ValidateRunAgentInput,
} from './agent';
export type { CodingAgentV17Options, V17AgentStep, V17ResumeAgentInput, V17RunAgentInput } from './agent';
