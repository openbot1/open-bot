/**
 * Behavioral policy — types (v1.04, T3b — Harness Engineering).
 *
 * The problem this module solves: before v1.04, behavioral policy in
 * open-bot lived only as prompt prose (`AGENTS.md` workspace rules,
 * `packages/core/src/rules/`) or as hard-coded guardrails in code
 * (`packages/core/src/guardrails/`). Prompt prose is forgettable — the
 * model can ignore an instruction buried in its prompt — and code
 * guardrails cannot be changed by the user without a rebuild. The
 * Harness Engineering survey's safety subsystem says the same thing
 * every production harness learned: policy that must hold belongs in
 * a versioned config file the runtime enforces, not in prose the
 * model may or may not follow.
 *
 * A policy file is therefore:
 * - VERSIONED: `version: 1` today; a loader refuses unknown versions
 *   instead of silently misreading them.
 * - VALIDATED: `validate.ts` reports every problem with a path, so a
 *   typo never becomes a silent hole.
 * - ENFORCED: `compile.ts` turns the policy into a PreToolUse hook
 *   (`createPolicyHook`) that blocks denied tool calls before they
 *   run — plus a system-prompt section so the model also knows the
 *   rules and can explain them.
 * - AUDITED: `audit.ts` appends a JSONL record every time a policy is
 *   created, changed or rejected, with the sha256 of the file before
 *   and after — so "who loosened the policy?" is answerable.
 *
 * Scope: this is a LOCAL policy for one workspace/bot. It is not a
 * multi-user ACL system and not a sandbox: path rules are enforced on
 * the tool-call arguments open-bot can see, they do not (and cannot)
 * confine a process that escapes the tool layer. The limits are stated
 * in `compile.ts` and in the docs, not hidden.
 */

/** Current policy file format version. Loaders reject anything else. */
export const POLICY_FILE_VERSION = 1;

/** File names a policy is looked up under (YAML first, then JSON). */
export const POLICY_FILE_NAMES = ['.open-bot/policy.yaml', '.open-bot/policy.json'] as const;

/** What a policy may decide about a tool call. */
export type PolicyDecision = 'allow' | 'block' | 'needs-approval';

/**
 * Tool rules. Names are matched with the hook glob syntax (`*` / `?`,
 * see `hooks/matcher.ts`): `shell-*` covers every shell tool,
 * `delete_file` matches exactly one tool.
 */
export interface PolicyToolRules {
  /** Tools the agent may call. When non-empty AND `defaults.toolDecision` is 'deny', anything not listed is blocked. */
  allow?: string[];
  /** Tools the agent may never call (deny wins over allow). */
  deny?: string[];
  /** Tools that need human approval first. A match returns 'needs-approval'; the hook blocks with a clear reason until an approval flow consumes it. */
  requireApproval?: string[];
}

/**
 * Path rules. Globs are matched against the path as given in the tool
 * arguments AND, when a workspace dir is known, against the path
 * resolved inside it. `*` in a glob crosses `/` here (unlike the hook
 * matcher): `*.env` matches any `.env` file at any depth.
 */
export interface PolicyPathRules {
  /** Paths the agent may read. When non-empty AND `defaults.pathDecision` is 'deny', anything not listed is blocked. */
  readAllow?: string[];
  /** Paths the agent may never read (deny wins over allow). */
  readDeny?: string[];
  /** Paths the agent may write. Same default rule as `readAllow`. */
  writeAllow?: string[];
  /** Paths the agent may never write (deny wins over allow). */
  writeDeny?: string[];
  /**
   * Default true: writes outside the workspace directory are blocked
   * even when no write rule matches. Set false only for bots that
   * genuinely work across directories.
   */
  requireInsideWorkspace?: boolean;
}

/** Network rules: hosts extracted from `url` / `endpoint` arguments. */
export interface PolicyNetworkRules {
  /** Hosts the agent may fetch (exact host or `*.example.com` suffix glob). When non-empty AND `defaults.networkDecision` is 'deny', anything not listed is blocked. */
  allowHosts?: string[];
  /** Hosts the agent may never fetch (deny wins over allow). */
  denyHosts?: string[];
}

/** Model / loop limits the policy states (enforced by the host, not by the hook). */
export interface PolicyModelRules {
  /** Maximum agent steps per run. */
  maxSteps?: number;
  /** Models this bot may use (provider model ids). Empty / omitted = no restriction. */
  allowedModels?: string[];
}

/** All rule groups of a policy file. Every group is optional. */
export interface PolicyRules {
  tools?: PolicyToolRules;
  paths?: PolicyPathRules;
  network?: PolicyNetworkRules;
  model?: PolicyModelRules;
}

/** Defaults applied when no allow-list matches. Permissive by default: an allow-list documents intent until the owner opts into deny-by-default. */
export interface PolicyDefaults {
  /** Default when a tool is in no allow-list. Default `'allow'`. */
  toolDecision?: PolicyDefaultDecision;
  /** Default when a path is in no allow-list. Default `'allow'`. */
  pathDecision?: PolicyDefaultDecision;
  /** Default when a host is in no allow-list. Default `'allow'`. */
  networkDecision?: PolicyDefaultDecision;
}

/** What a default decision may be: allow everything not listed, or deny it. */
export type PolicyDefaultDecision = 'allow' | 'deny';

/**
 * One behavioral policy file (`.open-bot/policy.yaml` or `.json`).
 * Unknown top-level / nested keys are rejected by validation — a
 * policy file must mean exactly what it says.
 */
export interface BehavioralPolicy {
  /** Must be `POLICY_FILE_VERSION` (1). */
  version: number;
  /** Short name, e.g. `strict-workspace`. Shown in logs / UI. */
  name: string;
  /** Human-readable description of what this policy is for. */
  description?: string;
  /** The rules. At least one rule group must be present. */
  rules: PolicyRules;
  /** Defaults for allow-list misses. */
  defaults?: PolicyDefaults;
}

/** Result of evaluating one tool call against a policy. */
export interface PolicyEvaluation {
  decision: PolicyDecision;
  /** Human-readable reason (always present for block / needs-approval). */
  reason: string;
  /** Which rule fired, e.g. `tools.deny[0]` or `paths.writeDeny[1]`. */
  rule?: string;
}

/** A policy file that parsed but failed validation. */
export interface PolicyIssue {
  /** JSON-pointer-ish path, e.g. `rules.tools.deny[1]`. */
  field: string;
  message: string;
}

/** Outcome of parsing + validating one policy document. */
export interface PolicyParseResult {
  policy: BehavioralPolicy | null;
  issues: PolicyIssue[];
}
