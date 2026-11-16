/**
 * Coding agent v8 (v1.16, Đội T4) — public exports.
 *
 * Học ý tưởng OpenHands V1 SDK (survey v1.16 §5), nối coding agent
 * v7 (v1.15). Xem từng module để biết thiết kế đầy đủ.
 */

export * from './types';
export {
  v8LanguageForPath,
  v8ContentHash,
  v8MaskSource,
  v8ParseParams,
  v8ResolveImport,
  v8ParseTypeScript,
  v8ParsePython,
  v8ParseFile,
  V8_PARSER_TEXT_LIMIT,
  V8_PARSER_MAX_ERRORS,
} from './parser';
export {
  V8RepoMap,
  V8_PAGERANK_DAMPING,
  V8_PAGERANK_MAX_ITERATIONS,
  V8_PAGERANK_EPSILON,
  V8_MAX_SYMBOL_TARGETS,
  V8_MAX_EDGES,
  V8_CACHE_VERSION,
  V8_EDGE_WEIGHTS,
  V8_QUERY_DEFAULT_LIMIT,
  V8_REPO_MAP_EXTENSIONS,
  v8FileNodeId,
  v8SymbolNodeId,
  v8ParseSymbolNodeId,
  v8PageRank,
  buildV8Graph,
  rankV8Files,
  rankV8Symbols,
  callersOfV8,
  calleesOfV8,
  importersOfV8,
  queryV8Repo,
  scanV8RepoFiles,
} from './repoMap';
export type { V8PageRankOptions, V8GraphInput, V8QueryOptions, V8ScanOptions, V8RepoCacheFile, V8IncrementalResult } from './repoMap';
export {
  V8_DIFF_CONTEXT_LINES,
  V8_DIFF_PREVIEW_LIMIT,
  v8NewPlanId,
  v8CountLineChanges,
  v8IsOutsideWorkspace,
  v8NormalizeRelPath,
  createV8RefactorPlan,
  v8PlanWithStatus,
  v8DiffLines,
  v8GroupHunks,
  previewV8Diff,
  v8DefaultBackupDir,
  applyV8RefactorPlan,
  rollbackV8Refactor,
  summarizeV8Plan,
} from './refactor';
export type { V8PlanChangeInput, V8RefactorOptions } from './refactor';
export {
  V8_TESTGEN_OUTPUT_LIMIT,
  V8_TESTGEN_DEFAULT_TIMEOUT_MS,
  v8GenerateCasesForFunction,
  v8DefaultTestPath,
  generateV8TestsForFile,
  v8CountCoveredBefore,
  v8CoverageDeltaForFile,
  runV8GeneratedTests,
} from './testgen';
export type { V8TestGenOptions } from './testgen';
export {
  V8_SECRET_ENTROPY_THRESHOLD,
  V8_SECRET_MIN_LENGTH,
  V8_SECURITY_MAX_FINDINGS,
  V8_SECRET_PATTERNS,
  V8_CVE_PATTERNS,
  v8ShannonEntropy,
  v8RedactSecretValue,
  scanV8Secrets,
  analyzeV8Taint,
  v8CompareVersions,
  v8VersionInRange,
  v8ParseLockfile,
  auditV8Dependencies,
  aggregateV8Level,
  scanV8Security,
} from './securityV2';
export type { V8CvePattern } from './securityV2';
export {
  V8CodeActExecutor,
  V8_CODEACT_DEFAULT_TIMEOUT_MS,
  V8_CODEACT_MAX_TIMEOUT_MS,
  V8_CODEACT_OUTPUT_LIMIT,
  V8_CODEACT_MAX_SCRIPT_STEPS,
  V8_DEFAULT_ALLOWED_COMMANDS,
  V8_CODEACT_BLOCK_PATTERNS,
  defaultV8SandboxPolicy,
  redactV8Text,
  normalizeV8Output,
  v8FirstCommandToken,
  v8SplitCommandSegments,
  checkV8Policy,
  v8ActionSecurityLevel,
} from './codeactV4';
export type { V8PolicyMode, V8SandboxPolicy, V8CodeActExecutorOptions, V8ExecuteResult } from './codeactV4';
export {
  CodingAgentV8,
  V8_AGENT_DEFAULT_VERIFY_TIMEOUT_MS,
} from './agent';
export type { V8ChangeInput, V8ChangeProvider, V8VerifyProvider, CodingAgentV8Options, V8ApprovalResult } from './agent';
