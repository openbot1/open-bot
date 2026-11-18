/**
 * Coding agent v9 (v1.17, Đội T4) — public exports.
 *
 * Học ý tưởng Aider (git-first atomic commit + search-replace edit),
 * OpenHands (sandbox execution loop), Claude Code (apply-diff
 * review), SWE-bench (eval harness đo pass@k) — chỉ học ý tưởng,
 * tự thiết kế và viết lại hoàn toàn, nối coding agent v8 (parser v8,
 * policy sandbox v8, harness v5).
 */

export * from './types';
export {
  V9_DIFF_CONTEXT_LINES,
  V9_DIFF_LCS_LINE_LIMIT,
  V9_DIFF_MAX_HUNKS,
  v9DiffLineOps,
  v9GroupHunks,
  v9RenderHunk,
  v9UnifiedDiff,
  v9SplitLines,
  v9JoinLines,
  v9CountLineChanges,
  v9CheckMinimalDiff,
  v9SummarizeDiff,
} from './diffUtil';
export type { DiffOp } from './diffUtil';
export {
  V9_AST_DEFAULT_MAX_CHANGED_LINES,
  V9_AST_MAX_NEW_TEXT_CHARS,
  v9ReadEditFile,
  v9FindSymbol,
  v9FindScopeEndLine,
  v9ResolveSymbolRange,
  v9LocateSymbol,
  v9SpliceLines,
  v9FindBlock,
  v9RenameInContent,
  applyV9AstEdit,
  applyV9AstEdits,
  previewV9AstEdit,
} from './astEdit';
export type { V9AstEditOptions, V9LocatedSymbol } from './astEdit';
export {
  V9_LOOP_DEFAULT_COMMAND_TIMEOUT_MS,
  V9_LOOP_MAX_COMMAND_TIMEOUT_MS,
  V9_LOOP_DEFAULT_MAX_ROUNDS,
  V9_LOOP_MAX_ROUNDS,
  V9_LOOP_OUTPUT_LIMIT,
  V9_LOOP_FAILURE_EXCERPT_LINES,
  V9_LOOP_DEFAULT_ALLOWED_COMMANDS,
  V9_LOOP_DENY_PATTERNS,
  v9CheckDenyList,
  v9CheckAllowList,
  v9TruncateOutput,
  v9FailureExcerpt,
  runV9Command,
  runV9SandboxLoop,
} from './sandboxLoop';
export type {
  V9RunCommandOptions,
  V9LoopEditProvider,
  V9LoopFixProvider,
  V9SandboxLoopOptions,
} from './sandboxLoop';
export {
  V9_GIT_DEFAULT_TIMEOUT_MS,
  V9_GIT_AUTHOR_NAME,
  V9_GIT_AUTHOR_EMAIL,
  V9_GIT_MAX_PR_COMMITS,
  V9_GIT_MAX_MESSAGE_FILES,
  runV9Git,
  runV9GitOrThrow,
  v9IsGitRepo,
  v9EnsureGitRepo,
  parseV9GitStatusPorcelain,
  v9GitStatus,
  parseV9Numstat,
  v9DiffNumstat,
  v9ShortPath,
  generateV9CommitMessage,
  commitV9Atomic,
  v9RollbackFiles,
  v9CommitLogSince,
  generateV9DraftPrDescription,
  applyV9EditAndCommit,
} from './gitAtomic';
export type { V9GitOptions, V9GitCommandResult } from './gitAtomic';
export {
  V9_EVAL_DEFAULT_ATTEMPTS,
  V9_EVAL_MAX_ATTEMPTS,
  V9_EVAL_MAX_TASKS_PER_SUITE,
  V9_EVAL_PATCH_PREVIEW_CHARS,
  V9_EVAL_TOKEN_CHARS_PER_TOKEN,
  v9EstimateTokens,
  validateV9EvalTask,
  runV9EvalTask,
  runV9EvalSuite,
  saveV9EvalReport,
  loadV9EvalReport,
  listV9EvalReports,
  compareV9EvalReports,
  renderV9EvalComparison,
  renderV9EvalReport,
  V9_SAMPLE_PATCH_ADD,
  V9_SAMPLE_PATCH_GREET,
  V9_SAMPLE_PATCH_SORT_WRONG,
  V9_EVAL_SAMPLE_TASKS,
  scriptedV9Agent,
} from './evalHarness';
export type { V9EvalAgentAttempt, V9EvalAgentFn, V9EvalRunOptions } from './evalHarness';
export { CodingAgentV9, v9AgentError } from './agent';
export type { V9PlanProvider, V9FixEditProvider, CodingAgentV9Options } from './agent';
export {
  v9FormatDuration,
  v9FormatPercent,
  v9SummarizeEdit,
  renderV9LoopReport,
  renderV9CommitLine,
  renderV9DraftPr,
  renderV9AgentReport,
  v9SummarizeEvalReport,
} from './report';
