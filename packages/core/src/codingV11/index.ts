/**
 * Coding agent v11 (v1.19, Đội T2) — public exports.
 *
 * Học ý tưởng OpenHands CodeAct + Aider repo map / Architect–Editor
 * + SWE-bench eval (chỉ học ý tưởng, tự thiết kế và viết lại hoàn
 * toàn), nối coding agent v10 (event-sourced session, CodeAct
 * executor, repo map hierarchical, edit strategies, eval theo
 * version) bằng 6 lớp mới:
 *
 *   1. CodeAct v9 (`codeactV9.ts`): engine hành động code — nhiều
 *      loại action, dry-run, xác nhận trước khi ghi file, rollback
 *      theo patch.
 *   2. Call graph + PageRank v2 (`callGraph.ts`): đồ thị lời gọi
 *      hàm resolve theo import, xếp hạng file/hàm, map theo truy
 *      vấn, impact set, phát hiện chu trình.
 *   3. Multi-file refactor (`refactorV11.ts`): đổi tên symbol, tách
 *      file, di chuyển hàm xuyên nhiều file, kiểm tra tham chiếu đầy
 *      đủ, preview diff trước khi áp.
 *   4. Eval harness v2 (`evalV11.ts`): task mẫu có trọng số (partial
 *      credit), phát hiện flaky, so sánh baseline (regression).
 *   5. Patch review (`patchReview.ts`): review patch tự động (rủi
 *      ro, secret, style, test thiếu, gợi ý sửa).
 *   6. Test generation v2 (`testgenV11.ts`): sinh test từ code thay
 *      đổi (mock-first), chạy thật, báo function-coverage delta.
 *   7. Agent v11 (`agent.ts`): pipeline nối 6 lớp trên + ghi event
 *      vào phiên v10.
 */

export * from './types';
export {
  V11_CODEACT_DEFAULT_COMMAND_TIMEOUT_MS,
  V11_CODEACT_MAX_COMMAND_TIMEOUT_MS,
  V11_CODEACT_DEFAULT_COMMAND_OUTPUT_LIMIT,
  V11_CODEACT_MAX_ACTIONS_PER_PLAN,
  V11_CODEACT_DRY_RUN_DIFF_LIMIT,
  V11_CODEACT_SENSITIVE_PATHS,
  V11_CODEACT_DESTRUCTIVE_TOKENS,
  v11NewCodeActPlanId,
  v11ActionRisk,
  v11NeedsConfirmation,
  validateV11CodeActPlan,
  V11CodeActEngine,
  runV11CodeActPlan,
  dryRunV11CodeActPlan,
} from './codeactV9';
export type { V11CodeActEngineOptions, V11CodeActRunOptions } from './codeactV9';
export {
  V11_PAGERANK_DAMPING,
  V11_PAGERANK_MAX_ITERATIONS,
  V11_PAGERANK_EPSILON,
  V11_IMPACT_MAX_DEPTH,
  V11_QUERY_MAP_DEFAULT_LIMIT,
  v11ShortName,
  v11PageRankV2,
  v11Hits,
  v11FindCycles,
  V11CallGraph,
  v11BuildCallGraphFromParsed,
} from './callGraph';
export type { V11CallGraphOptions } from './callGraph';
export {
  v11NewRefactorPlanId,
  V11_REFACTOR_MAX_REFERENCES_LISTED,
  v11IsValidIdentifier,
  v11RelativeImport,
  V11RefactorEngine,
  renameV11Symbol,
} from './refactorV11';
export type { V11RefactorEngineOptions } from './refactorV11';
export {
  V11_EVAL_DEFAULT_ATTEMPTS,
  V11_EVAL_MAX_ATTEMPTS,
  V11_EVAL_MAX_TASKS_PER_SUITE,
  V11_EVAL_FAILURE_EXCERPT_CHARS,
  V11_EVAL_DEFAULT_TEST_TIMEOUT_MS,
  V11_EVAL_TOKEN_CHARS_PER_TOKEN,
  V11_EVAL_SUITE_NAME,
  V11_EVAL_DETAIL_FILE,
  validateV11EvalTask,
  v11SafeVersionName,
  runV11EvalAttempt,
  runV11EvalSuite,
  V11_EVAL_SAMPLE_TASKS,
  V11_SAMPLE_PATCH_ADD,
  V11_SAMPLE_PATCH_CAPITALIZE,
  V11_SAMPLE_PATCH_MAX_WRONG,
  scriptedV11Agent,
  saveV11EvalReport,
  loadV11EvalReport,
  listV11EvalVersions,
  v11SummarizeEvalReport,
  compareV11EvalReports,
  renderV11EvalVersionTable,
  renderV11EvalComparison,
  v11NewEvalRunId,
} from './evalV11';
export type { V11EvalAgentFn, V11EvalSuiteOptions } from './evalV11';
export {
  V11_REVIEW_MAX_LINE_LENGTH,
  V11_REVIEW_RISK_MEDIUM,
  V11_REVIEW_RISK_HIGH,
  V11_REVIEW_LARGE_DIFF_LINES,
  V11_REVIEW_LARGE_DIFF_FILES,
  V11_REVIEW_MAX_DIFF_CHARS,
  V11_REVIEW_SENSITIVE_PATHS,
  V11_REVIEW_SECRET_PATTERNS,
  v11ParsePatch,
  v11IsTestFile,
  v11IsSourceFile,
  v11IsSensitivePath,
  reviewV11Patch,
  renderV11PatchReviewSummary,
} from './patchReview';
export type { V11ParsedDiffFile } from './patchReview';
export {
  V11_TESTGEN_OUTPUT_LIMIT,
  V11_TESTGEN_DEFAULT_TIMEOUT_MS,
  V11_TESTGEN_MAX_CASES_PER_FUNCTION,
  V11_TESTGEN_SIDE_EFFECTS,
  v11SampleValueForType,
  v11DetectSideEffects,
  v11TestPathForSource,
  generateV11Tests,
  v11CoverageDelta,
  runV11GeneratedTests,
} from './testgenV11';
export type { V11TestGenOptions } from './testgenV11';
export { CodingAgentV11, runV11AgentTask } from './agent';
export type { V11PlanProvider, V11RefactorRequest, CodingAgentV11Options } from './agent';
export {
  v11FormatDuration,
  renderV11CallGraphSummary,
  renderV11PatchReviewText,
  renderV11AgentReport,
} from './report';
