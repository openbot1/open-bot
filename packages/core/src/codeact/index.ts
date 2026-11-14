/**
 * CodeAct v2 — public surface (v1.04, Đội T4).
 *
 * Bash + Python + editor thống nhất qua contract
 * Action → Execution → Observation, chạy trong BotBox sandbox local.
 */
export { CodeActExecutor, CodeActValidationError, CODEACT_BLOCKED_COMMAND_PATTERNS, isCodeActCommandBlocked } from './executor';
export type { CodeActExecutorOptions } from './executor';
export {
  codeActActionFromToolArgs,
  codeActResultToText,
  describeCodeActAction,
  runCodeActAction,
  summarizeCodeActResult,
} from './contract';
export { CODEACT_TMP_DIR, DEFAULT_CODEACT_LIMITS } from './types';
export type {
  CodeActAction,
  CodeActActionKind,
  CodeActBashAction,
  CodeActEditAction,
  CodeActExecution,
  CodeActLimits,
  CodeActObservation,
  CodeActPythonAction,
  CodeActResult,
} from './types';
