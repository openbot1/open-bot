/**
 * Coding agent v7 (v1.15, Đội T4) — public exports.
 *
 * Học ý tưởng OpenHands V1 SDK (survey v1.15 §3), nối coding agent
 * v6 (v1.14). Xem từng module để biết thiết kế đầy đủ.
 */

export * from './types';
export {
  CodingV7Log,
  V7_GENESIS_PREV_HASH,
  V7_LOG_TEXT_LIMIT,
  clipV7Text,
  emptyV7State,
  foldV7Event,
  foldV7Events,
  hashV7Event,
  verifyV7Chain,
} from './conversationLog';
export type { V7ChainVerification, V7Snapshot } from './conversationLog';
export {
  V7SecurityAnalyzer,
  V7_SECURITY_MATCH_LIMIT,
  V7_SECURITY_RULES,
  aggregateV7Level,
  assessV7Action,
  isOutsideWorkspacePath,
  redactV7Secrets,
  scanV7Text,
  v7ActionScannedText,
} from './security';
export type { V7SecurityRule } from './security';
export {
  V7CodeActExecutor,
  V7_CODEACT_DEFAULT_TIMEOUT_MS,
  V7_CODEACT_MAX_ACTIONS_PER_TEXT,
  V7_CODEACT_MAX_TIMEOUT_MS,
  V7_CODEACT_OUTPUT_LIMIT,
  parseV7ActionFromObject,
  parseV7ActionsFromText,
  runV7Shell,
  v7ActionSignature,
  validateV7Action,
} from './codeactV3';
export type { V7CodeActExecutorOptions, V7ExecuteResult, V7ParseResult } from './codeactV3';
export {
  applyV7Condensation,
  condenseV7Log,
  estimateV7LogTokens,
  estimateV7Tokens,
  renderV7Summary,
  restoreV7Context,
  shouldCondenseV7Log,
} from './condenserV3';
export type { V7CondenseCheck, V7CondenseOptions } from './condenserV3';
export {
  V7SkillRegistry,
  V7_BUILTIN_SKILLS,
  bestV7Skill,
  discoverV7Skills,
  matchV7Skills,
  parseV7SkillFile,
  renderV7SkillFile,
  writeV7BuiltinSkills,
} from './skills';
export type { V7SkillDiscovery } from './skills';
export {
  CodingAgentV7,
  V7_DEFAULT_MAX_STEPS,
  V7_DEFAULT_TOKEN_BUDGET,
  V7_SYSTEM_PROMPT,
  buildV7Prompt,
  decideV7NextAction,
  v7HistoryTokens,
} from './agent';
export type { CodingAgentV7Options } from './agent';
export {
  V7_EVAL_TASKS,
  V7_SCRIPT_FIX_GREET,
  V7_SCRIPT_FIX_OFF_BY_ONE,
  createV7SampleRepo,
  runV7Eval,
  runV7EvalTask,
  scriptedV7Generator,
  v7PythonCheckCommand,
} from './eval';
export type { V7EvalOptions } from './eval';
