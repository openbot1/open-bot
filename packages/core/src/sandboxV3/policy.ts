/**
 * Sandbox v3 — combined policy, policy-as-code (v1.35, Team T2).
 *
 * One document governs a whole session. It composes the five v3
 * subsystems into a single versioned policy:
 *
 *  - `syscallMode` + `syscalls` → the per-tier allowlist engine
 *    (`syscallAllowlist.ts`). The mode picks the base set; `allow`
 *    adds, `deny` removes. Dangerous syscalls are refused by the
 *    engine even when listed in `allow`, and the validator flags
 *    that contradiction here so it is caught at policy time.
 *  - `egress` → the egress gate (`egressPolicy.ts`). Off by
 *    default; a policy must opt in with explicit hosts.
 *  - `lifetime` → the lifetime cap (`lifetime.ts`): max lifetime,
 *    grace window, idle timeout, max pause.
 *  - `hooks` → the hook registry (`hooks.ts`): pre/post hook
 *    specs that ship with the policy (a session may add more at
 *    runtime, but it may never remove a policy hook).
 *  - `files` / `commands` / `shellEnabled` → the same file and
 *    command rules v2 enforces, so a v3 session is never looser
 *    than the v2 policy it was derived from.
 *
 * Policies are versioned: `version` increments on every change and
 * `previousVersion` points at the policy this one supersedes, so a
 * session report can always say exactly which policy version it
 * ran under. `deriveSandboxV3Policy` builds a tighter (or equal)
 * policy from a base — it can never loosen a limit, which is what
 * lets a host hand a derived policy to an untrusted guest safely.
 */

import type { SandboxV2Tier, SandboxV2TierLevel, SandboxV2TrustLevel } from '../sandboxV2/types';
import { SANDBOX_V2_DENIED_PATH_SEGMENTS, SANDBOX_V2_DENIED_PATH_SUFFIXES } from '../sandboxV2/policy';
import type { SandboxV3EgressPolicy } from './egressPolicy';
import {
  SANDBOX_V3_EGRESS_OFFLINE,
  SANDBOX_V3_EGRESS_RESTRICTED,
  validateSandboxV3EgressPolicy,
} from './egressPolicy';
import type { SandboxV3SyscallMode } from './types';
import {
  SANDBOX_V3_DANGEROUS_SYSCALLS,
  defaultSyscallModeForTrust,
} from './syscallAllowlist';
import type { RegisterHookSpec } from './hooks';
import { validateHookMatcher } from './hooks';
import {
  SANDBOX_V3_DEFAULT_GRACE_MS,
  SANDBOX_V3_DEFAULT_IDLE_TIMEOUT_MS,
  SANDBOX_V3_DEFAULT_LIFETIME_MS,
  SANDBOX_V3_MAX_LIFETIME_MS,
} from './lifetime';
import { SANDBOX_V3_DEFAULT_MAX_PAUSE_MS } from './lifecycle';

/** Schema version of the v3 policy document. Bump on shape change. */
export const SANDBOX_V3_POLICY_SCHEMA_VERSION = 1;

/** Max lifetime a v3 policy may allow (4 hours — the lifetime cap). */
export const SANDBOX_V3_MAX_POLICY_LIFETIME_MS = SANDBOX_V3_MAX_LIFETIME_MS;

/** Max steps a v3 policy may allow in one session. */
export const SANDBOX_V3_MAX_STEPS = 10_000;

/** Max snapshots a v3 policy may allow per session. */
export const SANDBOX_V3_MAX_SNAPSHOTS = 50;

/** Re-exported so v3 callers share the v2 denied-path constants. */
export { SANDBOX_V2_DENIED_PATH_SEGMENTS, SANDBOX_V2_DENIED_PATH_SUFFIXES };

/** Syscall allow/deny overrides on top of the mode base set. */
export interface SandboxV3SyscallRules {
  /** Extra syscalls to allow (dangerous ones are refused). */
  allow: string[];
  /** Extra syscalls to deny (wins over the mode allow set). */
  deny: string[];
  /** When true, denied syscalls are only logged, not blocked. */
  logOnlyDeny: boolean;
}

/** File access rules, same shape as v2 (never looser than v2). */
export interface SandboxV3FileRules {
  /** Path prefixes the session may read. */
  readPrefixes: string[];
  /** Path prefixes the session may write. */
  writePrefixes: string[];
  /** Extra denied prefixes (on top of the built-in denied segments). */
  denyPrefixes: string[];
}

/** Lifetime rules: cap, grace, idle timeout, max pause. */
export interface SandboxV3LifetimeRules {
  /** Max session lifetime, ms. */
  maxLifetimeMs: number;
  /** Grace window after the deadline for an in-flight step, ms. */
  graceMs: number;
  /** Idle timeout, ms. 0 disables idle auto-stop. */
  idleTimeoutMs: number;
  /** Max time a session may stay paused, ms. */
  maxPauseMs: number;
}

/** Resource caps carried by the policy. */
export interface SandboxV3PolicyCaps {
  /** Max tool steps per session. */
  maxSteps: number;
  /** Max snapshots per session. */
  maxSnapshots: number;
  /** Max bytes the session may write. */
  maxWriteBytes: number;
  /** Max output chars retained per step. */
  maxOutputChars: number;
}

/** A versioned sandbox v3 policy (policy-as-code). */
export interface SandboxV3Policy {
  /** Stable id (e.g. 'strict', 'standard', 'custom-ci'). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Description shown in the UI. */
  description: string;
  /** Schema version of this document. */
  schemaVersion: number;
  /** Policy version — increments on every change. */
  version: number;
  /** Previous policy version this one supersedes (undefined for v1). */
  previousVersion?: number;
  /** Trust level this policy is written for. */
  trust: SandboxV2TrustLevel;
  /** Minimum tier that must enforce this policy. */
  minTier: SandboxV2Tier;
  /** Minimum tier level (1–3), kept in sync with `minTier`. */
  minTierLevel: SandboxV2TierLevel;
  /** Syscall allowlist mode (strict | standard | permissive). */
  syscallMode: SandboxV3SyscallMode;
  /** Syscall allow/deny overrides on top of the mode. */
  syscalls: SandboxV3SyscallRules;
  /** File rules (all tiers enforce). */
  files: SandboxV3FileRules;
  /** Egress rules (the egress gate enforces; off by default). */
  egress: SandboxV3EgressPolicy;
  /** Lifetime rules (the lifetime cap enforces). */
  lifetime: SandboxV3LifetimeRules;
  /** Resource caps. */
  caps: SandboxV3PolicyCaps;
  /** Hook specs that ship with the policy (cannot be removed at runtime). */
  hooks: RegisterHookSpec[];
  /** Command names allowed (empty = any command the tier allows). */
  commands: string[];
  /** Shell access at all (false = file tools only, no shell). */
  shellEnabled: boolean;
  /** ISO timestamp of the last change. */
  updatedAt: string;
}

/** Result of validating a v3 policy document. */
export interface SandboxV3PolicyValidation {
  valid: boolean;
  problems: string[];
  warnings: string[];
  /** Normalised copy of the policy (defaults filled) when valid. */
  policy?: SandboxV3Policy;
}

/** Tier name → level (same mapping as v2). */
export const SANDBOX_V3_TIER_LEVELS: Record<SandboxV2Tier, SandboxV2TierLevel> = {
  bwrap: 1,
  'syscall-policy': 2,
  microvm: 3,
};

/** Level → tier name. */
export const SANDBOX_V3_LEVEL_TIERS: Record<SandboxV2TierLevel, SandboxV2Tier> = {
  1: 'bwrap',
  2: 'syscall-policy',
  3: 'microvm',
};

function isoNow(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Default lifetime rules for a trust level. */
export function defaultLifetimeForTrust(trust: SandboxV2TrustLevel): SandboxV3LifetimeRules {
  switch (trust) {
    case 'trusted':
      return {
        maxLifetimeMs: 2 * 60 * 60 * 1000,
        graceMs: SANDBOX_V3_DEFAULT_GRACE_MS,
        idleTimeoutMs: SANDBOX_V3_DEFAULT_IDLE_TIMEOUT_MS,
        maxPauseMs: SANDBOX_V3_DEFAULT_MAX_PAUSE_MS,
      };
    case 'standard':
      return {
        maxLifetimeMs: SANDBOX_V3_DEFAULT_LIFETIME_MS,
        graceMs: SANDBOX_V3_DEFAULT_GRACE_MS,
        idleTimeoutMs: SANDBOX_V3_DEFAULT_IDLE_TIMEOUT_MS,
        maxPauseMs: SANDBOX_V3_DEFAULT_MAX_PAUSE_MS,
      };
    case 'untrusted':
      return {
        maxLifetimeMs: 15 * 60 * 1000,
        graceMs: 5_000,
        idleTimeoutMs: 5 * 60 * 1000,
        maxPauseMs: 5 * 60 * 1000,
      };
    case 'hostile':
      return {
        maxLifetimeMs: 5 * 60 * 1000,
        graceMs: 0,
        idleTimeoutMs: 60 * 1000,
        maxPauseMs: 60 * 1000,
      };
    default:
      return {
        maxLifetimeMs: SANDBOX_V3_DEFAULT_LIFETIME_MS,
        graceMs: SANDBOX_V3_DEFAULT_GRACE_MS,
        idleTimeoutMs: SANDBOX_V3_DEFAULT_IDLE_TIMEOUT_MS,
        maxPauseMs: SANDBOX_V3_DEFAULT_MAX_PAUSE_MS,
      };
  }
}

/** Default caps for a trust level. Tighter trust = tighter caps. */
export function defaultCapsV3ForTrust(trust: SandboxV2TrustLevel): SandboxV3PolicyCaps {
  switch (trust) {
    case 'trusted':
      return { maxSteps: 2000, maxSnapshots: 20, maxWriteBytes: 512 * 1024 * 1024, maxOutputChars: 200_000 };
    case 'standard':
      return { maxSteps: 500, maxSnapshots: 10, maxWriteBytes: 100 * 1024 * 1024, maxOutputChars: 100_000 };
    case 'untrusted':
      return { maxSteps: 100, maxSnapshots: 3, maxWriteBytes: 10 * 1024 * 1024, maxOutputChars: 20_000 };
    case 'hostile':
      return { maxSteps: 20, maxSnapshots: 1, maxWriteBytes: 1 * 1024 * 1024, maxOutputChars: 5_000 };
    default:
      return { maxSteps: 500, maxSnapshots: 10, maxWriteBytes: 100 * 1024 * 1024, maxOutputChars: 100_000 };
  }
}

/** Minimum tier for a trust level (same rule as v2). */
export function minTierV3ForTrust(trust: SandboxV2TrustLevel): SandboxV2Tier {
  switch (trust) {
    case 'trusted':
      return 'bwrap';
    case 'standard':
      return 'bwrap';
    case 'untrusted':
      return 'syscall-policy';
    case 'hostile':
      return 'microvm';
    default:
      return 'bwrap';
  }
}

/** Default egress for a trust level (off except for trusted). */
export function defaultEgressForTrust(trust: SandboxV2TrustLevel): SandboxV3EgressPolicy {
  if (trust === 'trusted') return clone(SANDBOX_V3_EGRESS_RESTRICTED);
  return clone(SANDBOX_V3_EGRESS_OFFLINE);
}

export interface CreateSandboxV3PolicySpec {
  id: string;
  name: string;
  description: string;
  trust: SandboxV2TrustLevel;
  minTier?: SandboxV2Tier;
  syscallMode?: SandboxV3SyscallMode;
  syscalls?: Partial<SandboxV3SyscallRules>;
  files?: Partial<SandboxV3FileRules>;
  egress?: Partial<SandboxV3EgressPolicy>;
  lifetime?: Partial<SandboxV3LifetimeRules>;
  caps?: Partial<SandboxV3PolicyCaps>;
  hooks?: RegisterHookSpec[];
  commands?: string[];
  shellEnabled?: boolean;
  version?: number;
  previousVersion?: number;
}

/** Build a full v3 policy from a partial spec (defaults filled). */
export function createSandboxV3Policy(spec: CreateSandboxV3PolicySpec): SandboxV3Policy {
  const minTier = spec.minTier ?? minTierV3ForTrust(spec.trust);
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    schemaVersion: SANDBOX_V3_POLICY_SCHEMA_VERSION,
    version: spec.version ?? 1,
    ...(spec.previousVersion !== undefined ? { previousVersion: spec.previousVersion } : {}),
    trust: spec.trust,
    minTier,
    minTierLevel: SANDBOX_V3_TIER_LEVELS[minTier],
    syscallMode: spec.syscallMode ?? defaultSyscallModeForTrust(spec.trust),
    syscalls: {
      allow: spec.syscalls?.allow ?? [],
      deny: spec.syscalls?.deny ?? [],
      logOnlyDeny: spec.syscalls?.logOnlyDeny ?? false,
    },
    files: {
      readPrefixes: spec.files?.readPrefixes ?? [],
      writePrefixes: spec.files?.writePrefixes ?? [],
      denyPrefixes: spec.files?.denyPrefixes ?? [],
    },
    egress: { ...defaultEgressForTrust(spec.trust), ...(spec.egress ?? {}) },
    lifetime: { ...defaultLifetimeForTrust(spec.trust), ...(spec.lifetime ?? {}) },
    caps: { ...defaultCapsV3ForTrust(spec.trust), ...(spec.caps ?? {}) },
    hooks: (spec.hooks ?? []).map((hook) => clone(hook)),
    commands: spec.commands ?? [],
    shellEnabled: spec.shellEnabled ?? spec.trust !== 'hostile',
    updatedAt: isoNow(),
  };
}

/** Strict: hostile / untrusted code. No shell, no egress, tight caps. */
export const SANDBOX_V3_POLICY_STRICT: SandboxV3Policy = createSandboxV3Policy({
  id: 'strict',
  name: 'Strict',
  description: 'Untrusted or hostile code: strict syscalls, no shell, no egress, 15-minute lifetime.',
  trust: 'untrusted',
  syscallMode: 'strict',
  shellEnabled: false,
  hooks: [
    {
      name: 'block-shell-tools',
      timing: 'pre',
      matcher: { toolPattern: 'shell_*' },
      decision: 'deny',
      message: 'Shell tools are blocked by the strict policy.',
      priority: 10,
    },
  ],
});

/** Standard: normal agent-generated code. */
export const SANDBOX_V3_POLICY_STANDARD: SandboxV3Policy = createSandboxV3Policy({
  id: 'standard',
  name: 'Standard',
  description: 'Normal agent code: standard syscalls, shell allowed, egress off, 30-minute lifetime.',
  trust: 'standard',
  syscallMode: 'standard',
});

/** Trusted: first-party, reviewed code. */
export const SANDBOX_V3_POLICY_TRUSTED: SandboxV3Policy = createSandboxV3Policy({
  id: 'trusted',
  name: 'Trusted',
  description: 'Reviewed first-party code: permissive syscalls, restricted egress, 2-hour lifetime.',
  trust: 'trusted',
  syscallMode: 'permissive',
});

/** Untrusted: code from the network / user paste. */
export const SANDBOX_V3_POLICY_UNTRUSTED: SandboxV3Policy = createSandboxV3Policy({
  id: 'untrusted',
  name: 'Untrusted',
  description: 'Network code: strict syscalls, no shell, no egress, 15-minute lifetime.',
  trust: 'untrusted',
  syscallMode: 'strict',
  shellEnabled: false,
});

/** Hostile: known-malicious sample / red-team fixture. */
export const SANDBOX_V3_POLICY_HOSTILE: SandboxV3Policy = createSandboxV3Policy({
  id: 'hostile',
  name: 'Hostile',
  description: 'Known-malicious code: strict syscalls, microVM tier, no shell, no egress, 5-minute lifetime.',
  trust: 'hostile',
  minTier: 'microvm',
  syscallMode: 'strict',
  shellEnabled: false,
  hooks: [
    {
      name: 'block-shell-tools',
      timing: 'pre',
      matcher: { toolPattern: 'shell_*' },
      decision: 'deny',
      message: 'Shell tools are blocked by the hostile policy.',
      priority: 10,
    },
    {
      name: 'block-network-tools',
      timing: 'pre',
      matcher: { toolPattern: '*network*' },
      decision: 'deny',
      message: 'Network tools are blocked by the hostile policy.',
      priority: 10,
    },
  ],
});

/** All built-in v3 policies, by id. */
export const BUILTIN_SANDBOX_V3_POLICIES: Record<string, SandboxV3Policy> = {
  strict: SANDBOX_V3_POLICY_STRICT,
  standard: SANDBOX_V3_POLICY_STANDARD,
  trusted: SANDBOX_V3_POLICY_TRUSTED,
  untrusted: SANDBOX_V3_POLICY_UNTRUSTED,
  hostile: SANDBOX_V3_POLICY_HOSTILE,
};

/** Look up a built-in policy by id (a copy — callers cannot mutate the builtin). */
export function getBuiltinSandboxV3Policy(id: string): SandboxV3Policy | undefined {
  const found = BUILTIN_SANDBOX_V3_POLICIES[id];
  return found ? clone(found) : undefined;
}

/** Built-in policy for a trust level (strict → strict, trusted → trusted, ...). */
export function builtinPolicyV3ForTrust(trust: SandboxV2TrustLevel): SandboxV3Policy {
  switch (trust) {
    case 'trusted':
      return clone(SANDBOX_V3_POLICY_TRUSTED);
    case 'untrusted':
      return clone(SANDBOX_V3_POLICY_UNTRUSTED);
    case 'hostile':
      return clone(SANDBOX_V3_POLICY_HOSTILE);
    case 'standard':
    default:
      return clone(SANDBOX_V3_POLICY_STANDARD);
  }
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate a raw policy document. Returns the problems (fatal) and
 * warnings (suspicious but usable), plus a normalised policy when
 * valid. Never throws on bad input — bad input returns valid:false.
 */
export function validateSandboxV3Policy(input: unknown): SandboxV3PolicyValidation {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, problems: ['Sandbox v3 policy must be a JSON object'], warnings };
  }
  const doc = input as Record<string, unknown>;
  if (typeof doc.id !== 'string' || doc.id.trim() === '') problems.push('id must be a non-empty string');
  if (typeof doc.name !== 'string' || doc.name.trim() === '') problems.push('name must be a non-empty string');
  if (typeof doc.description !== 'string') problems.push('description must be a string');
  if (doc.schemaVersion !== SANDBOX_V3_POLICY_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${SANDBOX_V3_POLICY_SCHEMA_VERSION}`);
  }
  if (!isNonNegativeInt(doc.version) || (doc.version as number) < 1) {
    problems.push('version must be a positive integer');
  }
  const trust = doc.trust as SandboxV2TrustLevel;
  if (!['trusted', 'standard', 'untrusted', 'hostile'].includes(trust)) {
    problems.push('trust must be trusted | standard | untrusted | hostile');
  }
  const minTier = doc.minTier as SandboxV2Tier;
  if (!['bwrap', 'syscall-policy', 'microvm'].includes(minTier)) {
    problems.push('minTier must be bwrap | syscall-policy | microvm');
  }
  if (doc.minTierLevel !== undefined && doc.minTierLevel !== SANDBOX_V3_TIER_LEVELS[minTier]) {
    problems.push('minTierLevel does not match minTier');
  }
  const syscallMode = doc.syscallMode as SandboxV3SyscallMode;
  if (!['strict', 'standard', 'permissive'].includes(syscallMode)) {
    problems.push('syscallMode must be strict | standard | permissive');
  }
  const syscalls = doc.syscalls as Record<string, unknown> | undefined;
  if (typeof syscalls !== 'object' || syscalls === null) {
    problems.push('syscalls must be an object');
  } else {
    if (!isNonEmptyStringArray(syscalls.allow) && !Array.isArray(syscalls.allow)) {
      problems.push('syscalls.allow must be an array of strings');
    }
    if (!Array.isArray(syscalls.deny) || syscalls.deny.some((s) => typeof s !== 'string')) {
      problems.push('syscalls.deny must be an array of strings');
    }
    if (typeof syscalls.logOnlyDeny !== 'boolean') problems.push('syscalls.logOnlyDeny must be a boolean');
    const allow = (syscalls.allow as string[] | undefined) ?? [];
    const dangerousListed = allow.filter((name) =>
      SANDBOX_V3_DANGEROUS_SYSCALLS.includes(name.trim().toLowerCase()),
    );
    if (dangerousListed.length > 0) {
      problems.push(
        `syscalls.allow lists dangerous syscalls that can never be allowed: ${dangerousListed.join(', ')}`,
      );
    }
  }
  const files = doc.files as Record<string, unknown> | undefined;
  if (typeof files !== 'object' || files === null) {
    problems.push('files must be an object');
  } else {
    for (const key of ['readPrefixes', 'writePrefixes', 'denyPrefixes'] as const) {
      if (!Array.isArray(files[key]) || files[key].some((p) => typeof p !== 'string')) {
        problems.push(`files.${key} must be an array of strings`);
      }
    }
    const denied = checkDeniedPaths([
      ...((files.readPrefixes as string[] | undefined) ?? []),
      ...((files.writePrefixes as string[] | undefined) ?? []),
    ]);
    if (denied.length > 0) {
      problems.push(`files prefixes touch always-denied paths: ${denied.join(', ')}`);
    }
  }
  const egressResult = validateSandboxV3EgressPolicy(doc.egress);
  if (!egressResult.valid) {
    for (const problem of egressResult.problems) problems.push(`egress: ${problem}`);
  }
  const lifetime = doc.lifetime as Record<string, unknown> | undefined;
  if (typeof lifetime !== 'object' || lifetime === null) {
    problems.push('lifetime must be an object');
  } else {
    if (!isNonNegativeInt(lifetime.maxLifetimeMs) || (lifetime.maxLifetimeMs as number) < 60_000) {
      problems.push('lifetime.maxLifetimeMs must be an integer >= 60000');
    }
    if ((lifetime.maxLifetimeMs as number) > SANDBOX_V3_MAX_POLICY_LIFETIME_MS) {
      problems.push(`lifetime.maxLifetimeMs must not exceed ${SANDBOX_V3_MAX_POLICY_LIFETIME_MS}`);
    }
    if (!isNonNegativeInt(lifetime.graceMs)) problems.push('lifetime.graceMs must be a non-negative integer');
    if (!isNonNegativeInt(lifetime.idleTimeoutMs)) problems.push('lifetime.idleTimeoutMs must be a non-negative integer');
    if (!isNonNegativeInt(lifetime.maxPauseMs) || (lifetime.maxPauseMs as number) < 1000) {
      problems.push('lifetime.maxPauseMs must be an integer >= 1000');
    }
  }
  const caps = doc.caps as Record<string, unknown> | undefined;
  if (typeof caps !== 'object' || caps === null) {
    problems.push('caps must be an object');
  } else {
    if (!isNonNegativeInt(caps.maxSteps) || (caps.maxSteps as number) > SANDBOX_V3_MAX_STEPS) {
      problems.push(`caps.maxSteps must be an integer 0..${SANDBOX_V3_MAX_STEPS}`);
    }
    if (!isNonNegativeInt(caps.maxSnapshots) || (caps.maxSnapshots as number) > SANDBOX_V3_MAX_SNAPSHOTS) {
      problems.push(`caps.maxSnapshots must be an integer 0..${SANDBOX_V3_MAX_SNAPSHOTS}`);
    }
    if (!isNonNegativeInt(caps.maxWriteBytes)) problems.push('caps.maxWriteBytes must be a non-negative integer');
    if (!isNonNegativeInt(caps.maxOutputChars)) problems.push('caps.maxOutputChars must be a non-negative integer');
  }
  const hooks = doc.hooks as unknown;
  if (!Array.isArray(hooks)) {
    problems.push('hooks must be an array');
  } else {
    hooks.forEach((hook, index) => {
      if (typeof hook !== 'object' || hook === null) {
        problems.push(`hooks[${index}] must be an object`);
        return;
      }
      const spec = hook as Record<string, unknown>;
      if (typeof spec.name !== 'string' || spec.name === '') problems.push(`hooks[${index}].name must be a non-empty string`);
      if (spec.timing !== 'pre' && spec.timing !== 'post') problems.push(`hooks[${index}].timing must be pre | post`);
      if (spec.decision !== 'allow' && spec.decision !== 'deny' && spec.decision !== 'modify') {
        problems.push(`hooks[${index}].decision must be allow | deny | modify`);
      }
      for (const problem of validateHookMatcher(spec.matcher)) {
        problems.push(`hooks[${index}]: ${problem}`);
      }
      if (spec.decision === 'modify' && spec.modifyArgs === undefined) {
        problems.push(`hooks[${index}] is a modify hook without modifyArgs`);
      }
    });
  }
  if (!Array.isArray(doc.commands) || doc.commands.some((c) => typeof c !== 'string')) {
    problems.push('commands must be an array of strings');
  }
  if (typeof doc.shellEnabled !== 'boolean') problems.push('shellEnabled must be a boolean');
  if (doc.shellEnabled === true && trust === 'hostile') {
    problems.push('hostile policy must not enable the shell');
  }
  if (doc.shellEnabled === true && syscallMode === 'strict') {
    warnings.push('shell is enabled but syscall mode is strict — shell tools are still hook-gated');
  }
  if (problems.length > 0) return { valid: false, problems, warnings };
  const policy = clone(doc) as unknown as SandboxV3Policy;
  policy.minTierLevel = SANDBOX_V3_TIER_LEVELS[policy.minTier];
  if (typeof policy.updatedAt !== 'string' || policy.updatedAt === '') {
    policy.updatedAt = isoNow();
  }
  for (const warning of egressResult.warnings) warnings.push(`egress: ${warning}`);
  if (policy.egress.enabled && policy.trust === 'hostile') {
    warnings.push('hostile policy enables egress — the gate still applies, review the host list');
  }
  return { valid: true, problems, warnings, policy };
}

/** Validate or throw (for callers that want an exception, not a report). */
export function assertValidSandboxV3Policy(input: unknown): SandboxV3Policy {
  const result = validateSandboxV3Policy(input);
  if (!result.valid || !result.policy) {
    throw new Error(`Invalid sandbox v3 policy: ${result.problems.join('; ')}`);
  }
  return result.policy;
}

/** Parse a policy from a JSON string (throws on bad JSON or invalid policy). */
export function parseSandboxV3Policy(json: string): SandboxV3Policy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    throw new Error(`Sandbox v3 policy JSON is not valid JSON: ${(err as Error).message}`);
  }
  return assertValidSandboxV3Policy(parsed);
}

/** Serialise a policy to canonical JSON (stable key order via construction order). */
export function serializeSandboxV3Policy(policy: SandboxV3Policy): string {
  return JSON.stringify(policy, null, 2);
}

/**
 * Derive a tighter (or equal) policy from a base policy. Every
 * numeric limit can only shrink, every list can only shrink or
 * stay, egress can only turn off or narrow, and hooks can only be
 * ADDED — never removed. Returns a new policy with version + 1
 * and previousVersion set to the base version.
 */
export function deriveSandboxV3Policy(
  base: SandboxV3Policy,
  patch: {
    id?: string;
    name?: string;
    description?: string;
    syscallMode?: SandboxV3SyscallMode;
    extraDenySyscalls?: string[];
    egressAllowedHosts?: string[];
    egressEnabled?: boolean;
    maxLifetimeMs?: number;
    maxSteps?: number;
    maxSnapshots?: number;
    maxWriteBytes?: number;
    extraHooks?: RegisterHookSpec[];
    shellEnabled?: boolean;
  },
): SandboxV3Policy {
  const derived = clone(base);
  derived.version = base.version + 1;
  derived.previousVersion = base.version;
  derived.updatedAt = isoNow();
  if (patch.id !== undefined) derived.id = patch.id;
  if (patch.name !== undefined) derived.name = patch.name;
  if (patch.description !== undefined) derived.description = patch.description;
  if (patch.syscallMode !== undefined) {
    // Only tighten the mode: strict < standard < permissive.
    const order: SandboxV3SyscallMode[] = ['strict', 'standard', 'permissive'];
    if (order.indexOf(patch.syscallMode) <= order.indexOf(base.syscallMode)) {
      derived.syscallMode = patch.syscallMode;
    }
  }
  if (patch.extraDenySyscalls !== undefined) {
    derived.syscalls.deny = [...new Set([...derived.syscalls.deny, ...patch.extraDenySyscalls])];
  }
  if (patch.egressEnabled === false) derived.egress.enabled = false;
  if (patch.egressAllowedHosts !== undefined) {
    const kept = derived.egress.allowedHosts.filter((host) =>
      patch.egressAllowedHosts?.includes(host),
    );
    derived.egress.allowedHosts = kept;
  }
  if (patch.maxLifetimeMs !== undefined) {
    derived.lifetime.maxLifetimeMs = Math.min(derived.lifetime.maxLifetimeMs, patch.maxLifetimeMs);
  }
  if (patch.maxSteps !== undefined) {
    derived.caps.maxSteps = Math.min(derived.caps.maxSteps, patch.maxSteps);
  }
  if (patch.maxSnapshots !== undefined) {
    derived.caps.maxSnapshots = Math.min(derived.caps.maxSnapshots, patch.maxSnapshots);
  }
  if (patch.maxWriteBytes !== undefined) {
    derived.caps.maxWriteBytes = Math.min(derived.caps.maxWriteBytes, patch.maxWriteBytes);
  }
  if (patch.extraHooks !== undefined) {
    derived.hooks = [...derived.hooks, ...patch.extraHooks.map((hook) => clone(hook))];
  }
  if (patch.shellEnabled === false) derived.shellEnabled = false;
  return derived;
}

/** Check path prefixes against the always-denied segments / suffixes. */
export function checkDeniedPaths(prefixes: string[]): string[] {
  const bad: string[] = [];
  for (const prefix of prefixes) {
    const segments = prefix.split('/').filter((part) => part !== '');
    for (const segment of segments) {
      if ((SANDBOX_V2_DENIED_PATH_SEGMENTS as readonly string[]).includes(segment)) {
        bad.push(prefix);
        break;
      }
    }
    if (bad.includes(prefix)) continue;
    const lower = prefix.toLowerCase();
    for (const suffix of SANDBOX_V2_DENIED_PATH_SUFFIXES) {
      if (lower.endsWith(suffix)) {
        bad.push(prefix);
        break;
      }
    }
  }
  return bad;
}

/** True when a path is denied by the policy file rules (or the built-ins). */
export function isDeniedSandboxV3Path(targetPath: string, policy?: SandboxV3Policy): boolean {
  const segments = targetPath.split('/').filter((part) => part !== '');
  for (const segment of segments) {
    if ((SANDBOX_V2_DENIED_PATH_SEGMENTS as readonly string[]).includes(segment)) return true;
  }
  const lower = targetPath.toLowerCase();
  for (const suffix of SANDBOX_V2_DENIED_PATH_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  if (policy) {
    for (const denied of policy.files.denyPrefixes) {
      if (targetPath.startsWith(denied)) return true;
    }
    if (policy.files.readPrefixes.length > 0) {
      const readable = policy.files.readPrefixes.some((prefix) => targetPath.startsWith(prefix));
      const writable = policy.files.writePrefixes.some((prefix) => targetPath.startsWith(prefix));
      if (!readable && !writable) return true;
    }
  }
  return false;
}

/** True when `path` is under one of the given prefixes. */
export function isPathUnderPrefixesV3(targetPath: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => targetPath.startsWith(prefix));
}
