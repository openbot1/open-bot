/**
 * Coding agent v18 (v1.40, Đội T4) — public exports.
 *
 * Học ý tưởng survey v140 §6 (Large Codebase SDK + verification
 * stack 2026), code gốc của open-bot: critic chấm trajectory trước
 * khi push (5 trục, ngưỡng cấu hình được, chặn push, lịch sử chấm),
 * review skill tự động 16 rule trên mỗi PR/diff (finding có mức độ
 * + gợi ý sửa + gate merge), dependency map toàn repo (đồ thị phụ
 * thuộc, topo order theo tầng, vùng sở hữu, phát hiện xung đột trước
 * khi sửa), eval harness chạy 3 verifier trên cùng task để so sánh.
 *
 * Nối (không viết lại): coding agent v17 (trajectory log hash-chain,
 * repo map PageRank, eval gate oracle, Plan Mode, sandbox bwrap).
 */

export * from './types';
export {
  V18_CRITIC_DEFAULT_APPROVE_SCORE,
  V18_CRITIC_DEFAULT_BLOCK_SCORE,
  V18_CRITIC_HISTORY_MAX_ENTRIES,
  V18_CRITIC_PRESETS,
  renderV18CriticHistory,
  renderV18CriticTrend,
  renderV18CriticVerdict,
  v18AggregateScore,
  v18AppendCriticHistory,
  v18ContainsDestructiveCommand,
  v18ContainsSecret,
  v18CountRepeatedBash,
  v18CountRedundantWrites,
  v18CountUnresolvedErrors,
  v18CriticHistoryId,
  v18CriticHistoryStats,
  v18CriticPreset,
  v18CriticTrend,
  v18CriticVerdictFor,
  v18LoadCriticHistory,
  v18SaveCriticHistory,
  v18ScorePatch,
  v18ScoreTrajectory,
  v18ScoreTrajectoryDimensions,
  v18ValidateCriticConfig,
} from './critic';
export {
  V18_REVIEW_DEFAULT_MAX_WARNINGS,
  V18_REVIEW_MAX_FILE_CHARS,
  V18_REVIEW_MAX_FUNCTION_LINES,
  V18_REVIEW_MAX_PATCH_LINES,
  V18_REVIEW_RULES,
  renderV18AutoFixResult,
  renderV18ReviewReport,
  v18ApplyAutoFixes,
  v18CountDiffLines,
  v18ExtractImportsForReview,
  v18IsSourceFile,
  v18IsTestFile,
  v18LongestFunctionLines,
  v18ResolveRelativeImport,
  v18ReviewPatch,
  v18ReviewPr,
  v18ReviewRuleById,
} from './reviewSkill';
export {
  renderV18DepGraph,
  renderV18GraphStats,
  renderV18ImpactSet,
  renderV18TopoPlan,
  renderV18ZoneConflicts,
  renderV18Zones,
  v18BuildDepGraph,
  v18BuildZones,
  v18CheckZoneConflicts,
  v18DefaultZoneDefs,
  v18DepNodeKind,
  v18EntryPoints,
  v18ExtractImports,
  v18FindCycles,
  v18FindOrphans,
  v18GraphStats,
  v18ImpactSet,
  v18LeafModules,
  v18NormalizePath,
  v18ParallelWaves,
  v18ResolveAlias,
  v18ResolveRelative,
  v18SortByTopo,
  v18TopoOrder,
  v18ZoneOfFile,
} from './dependencyMap';
export type { V18ZoneDef } from './dependencyMap';
export {
  V18_VERIFIERS,
  renderV18EvalComparison,
  renderV18EvalSuiteReport,
  v18BuildDiffText,
  v18ComparisonsAgree,
  v18RunEvalComparison,
  v18RunEvalSuite,
  v18RunVerifier,
  v18RunVerifierCritic,
  v18RunVerifierDepMap,
  v18RunVerifierReview,
  v18VerifierPassRates,
} from './evalHarness';
export type { V18EvalInput } from './evalHarness';
export {
  renderV18AgentReport,
  runV18Agent,
  v18AgentStepsToTrajectory,
  v18ApplyAgentFileWrite,
  v18ValidateAgentStep,
} from './agent';
