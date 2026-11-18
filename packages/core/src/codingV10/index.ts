/**
 * Coding agent v10 (v1.18, Đội T2) — public exports.
 *
 * Học ý tưởng OpenHands V1 SDK (event-sourced ConversationState,
 * CodeAct agent, Repository Map, sandbox execution) + Aider
 * (git-first atomic commit, repo map, Architect–Editor) — chỉ học
 * ý tưởng, tự thiết kế và viết lại hoàn toàn, nối coding agent v9
 * (AST edit, sandbox loop, git atomic, eval harness), repo map v3
 * PageRank của v8, CodeAct executor + sandbox allowlist hiện có.
 */

export * from './types';
export {
  V10_GENESIS_PREV_HASH,
  V10_EVENT_MAX_PAYLOAD_CHARS,
  V10_EVENT_MAX_STRING_CHARS,
  v10SafeSessionFileName,
  v10TruncatePayloadValue,
  v10StableStringify,
  v10HashEvent,
  v10DigestState,
  v10FoldEvents,
  v10VerifyChain,
  CodingV10Session,
} from './eventSession';
export type { CodingV10SessionOptions } from './eventSession';
export {
  V10_CODEACT_DEFAULT_TIMEOUT_MS,
  V10_CODEACT_MAX_TIMEOUT_MS,
  V10_CODEACT_DEFAULT_OUTPUT_LIMIT,
  V10_CODEACT_MAX_CODE_CHARS,
  V10_CODEACT_TMP_DIR,
  V10_CODEACT_DEFAULT_ALLOWED_COMMANDS,
  v10FirstCommand,
  v10CheckCodeActDenied,
  v10TruncateCodeActOutput,
  V10CodeActExecutor,
  runV10CodeAct,
  validateV10CodeActRequest,
} from './codeactExec';
export type { V10CodeActExecutorOptions } from './codeactExec';
export {
  V10_TOKEN_CHARS_PER_TOKEN,
  V10_SUMMARY_CACHE_VERSION,
  V10_MAX_SIGNATURE_CHARS,
  V10_MAX_SYMBOLS_PER_FILE,
  V10_MAX_FILES_PER_MODULE,
  V10_REPOMAP_DEFAULT_BUDGET,
  v10EstimateTokens,
  v10ModuleDir,
  v10SummarizeSymbol,
  v10SummarizeFile,
  v10SummarizeModule,
  v10GraphScores,
  V10RepoMap,
  v10BuildGraphFromParsed,
  v8FileNodeId,
  v8SymbolNodeId,
} from './repoMapV10';
export type { V10RepoMapOptions, V10SummaryCacheFile } from './repoMapV10';
export {
  V10_STRATEGY_BASE_SCORES,
  V10_STRATEGY_LINE_PENALTY,
  V10_VERIFIABLE_EXTENSIONS,
  v10VerifyContent,
  v10PlanEditCandidates,
  applyV10Edit,
} from './editStrategies';
export type { V10EditRequest, V10EditStrategyOptions } from './editStrategies';
export {
  V10_EVAL_SUITE_NAME,
  V10_EVAL_DEFAULT_ATTEMPTS,
  V10_EVAL_DEFAULT_AGENT_VERSION,
  V10_EVAL_NEW_TASKS,
  V10_EVAL_SAMPLE_TASKS,
  V10_SAMPLE_PATCH_DEDUPE,
  V10_SAMPLE_PATCH_CAPITALIZE,
  V10_SAMPLE_PATCH_MAX,
  scriptedV10Agent,
  runV10EvalSuite,
  v10SafeVersionName,
  validateV10AgentVersion,
  saveV10EvalReport,
  listV10EvalVersions,
  loadV10EvalSummary,
  loadV10LatestDetailReport,
  v10EvalVersionTable,
  compareV10EvalVersions,
  renderV10EvalVersionTable,
} from './evalV10';
export type { V10EvalSuiteOptions } from './evalV10';
export { CodingAgentV10, v10AgentError } from './agent';
export type { V10PlanProvider, V10FixEditProvider, CodingAgentV10Options } from './agent';
export {
  v10FormatDuration,
  v10FormatPercent,
  renderV10SessionReport,
  renderV10RepoMapSummary,
  renderV10AgentReport,
  v10SummarizeEvalVersion,
} from './report';
