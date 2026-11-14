/**
 * @open-bot/core policy — public surface for the policy module (v1.04).
 *
 * Behavioral policy as a versioned config file (not prompt prose):
 * parse + validate a `.open-bot/policy.yaml` / `.json` file, enforce
 * it with a PreToolUse hook, compile it into a system-prompt section,
 * and audit every change.
 */

export { POLICY_FILE_VERSION, POLICY_FILE_NAMES } from './types';
export type {
  BehavioralPolicy,
  PolicyDefaultDecision,
  PolicyDefaults,
  PolicyDecision,
  PolicyEvaluation,
  PolicyIssue,
  PolicyModelRules,
  PolicyNetworkRules,
  PolicyParseResult,
  PolicyPathRules,
  PolicyRules,
  PolicyToolRules,
} from './types';

export {
  emitYamlSubset,
  parseYamlSubset,
  PolicyYamlError,
} from './yaml';

export {
  defaultPolicy,
  parsePolicyDocument,
  stringifyPolicy,
  validatePolicy,
} from './validate';
export type { PolicyDocumentFormat } from './validate';

export { getPolicyPreset, listPolicyPresets, POLICY_PRESETS } from './presets';
export type { PolicyPresetId, PolicyPresetInfo } from './presets';

export {
  CONTENT_ARG_KEYS,
  createPolicyHook,
  compilePolicyToPrompt,
  evaluateToolCall,
  extractPathArgs,
  extractUrlHosts,
  matchHostGlob,
  matchPathGlob,
  PATH_ARG_KEYS,
  URL_ARG_KEYS,
  WRITE_TOOL_PATTERNS,
} from './compile';
export type { CreatePolicyHookOptions, EvaluateToolCallOptions } from './compile';

export {
  appendPolicyAudit,
  DEFAULT_POLICY_AUDIT_LIMIT,
  diffPolicies,
  flattenPolicy,
  POLICY_AUDIT_FILE,
  readPolicyAudit,
} from './audit';
export type {
  PolicyAuditAction,
  PolicyAuditEntry,
  PolicyAuditInput,
  PolicyDiffLine,
  ReadPolicyAuditResult,
} from './audit';

export {
  canonicalPolicyJson,
  findPolicyFile,
  hashPolicy,
  loadBehaviorPolicy,
  saveBehaviorPolicy,
} from './store';
export type { LoadedPolicy, SavePolicyOptions } from './store';
