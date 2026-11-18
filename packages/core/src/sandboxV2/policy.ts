/**
 * Sandbox v2 — policy-as-code (v1.34, Đội T2).
 *
 * A policy is DATA with a version: allow-list syscalls, allow-list
 * file paths, allow-list network hosts, resource caps, token TTL cap
 * and the minimum tier. Policies are validated BEFORE they are
 * applied — an invalid policy denies the run, it never silently
 * degrades to "allow everything".
 *
 * Versioning: `version` increments on every change; `id` + `version`
 * are recorded on every run report so an audit can replay exactly
 * which rules were in force. `previousVersion` links the chain.
 *
 * Network is OFF by default: `network.enabled === false` means no
 * egress at all, even to allow-listed hosts. Setting
 * `network.enabled: true` without hosts still denies everything.
 *
 * Path rules are prefix-based and lexical (no `..` escape, no
 * absolute path outside the workspace root unless the rule says so
 * explicitly). Denied paths (credential dirs, ssh keys, the vault)
 * always win over allow-listed prefixes — see `DENIED_PATH_PATTERNS`.
 */

import type { SandboxV2Tier, SandboxV2TierLevel, SandboxV2TrustLevel } from './types';
import { SandboxV2PolicyError } from './types';

/** Current policy schema version. Bump when the shape changes. */
export const SANDBOX_V2_POLICY_SCHEMA_VERSION = 1;

/** Max token TTL a policy may allow (1 hour — broker enforces the min). */
export const SANDBOX_V2_MAX_TOKEN_TTL_MS = 3_600_000;

/** Max lifetime cap a policy may allow (1 hour). */
export const SANDBOX_V2_MAX_LIFETIME_MS = 3_600_000;

/**
 * Paths that are ALWAYS denied, whatever the allow-list says:
 * credentials, ssh keys, the app vault, host secrets. Patterns are
 * matched as path segments (a segment equal to the pattern, or a
 * path ending in it) so `~/.ssh` cannot be smuggled in as a prefix.
 */
export const SANDBOX_V2_DENIED_PATH_SEGMENTS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.config',
  'credentials',
  '.netrc',
  'id_rsa',
  'id_ed25519',
  '.open-bot-vault',
  'vault',
] as const;

/** File extensions that are always denied (private keys, env secrets). */
export const SANDBOX_V2_DENIED_PATH_SUFFIXES = ['.pem', '.key', '.env'] as const;

/** Syscall allow-list: names, or `name:arg-pattern` entries. */
export interface SandboxV2SyscallRules {
  /** Syscalls that are allowed (empty = none allowed beyond the base set). */
  allow: string[];
  /** Syscalls that are always denied, even if listed in `allow`. */
  deny: string[];
  /** When true, denied syscalls are only logged, not blocked (audit mode). */
  logOnlyDeny: boolean;
}

/** File access allow-list. */
export interface SandboxV2FileRules {
  /** Path prefixes the run may read (relative to the workspace root, or absolute). */
  readPrefixes: string[];
  /** Path prefixes the run may write. */
  writePrefixes: string[];
  /** Extra denied prefixes (on top of the built-in denied segments). */
  denyPrefixes: string[];
}

/** Network allow-list. Off by default. */
export interface SandboxV2NetworkRules {
  /** Master switch. False = no egress at all. */
  enabled: boolean;
  /** Exact hosts allowed (e.g. 'registry.npmjs.org'). */
  hosts: string[];
  /** Suffix hosts allowed (e.g. '.githubusercontent.com'). */
  hostSuffixes: string[];
  /** TCP ports allowed (empty = 443 only when enabled). */
  ports: number[];
}

/** Resource caps carried by the policy (run caps may tighten, never loosen). */
export interface SandboxV2PolicyCaps {
  /** Max run lifetime, ms. */
  maxLifetimeMs: number;
  /** Max bytes the run may write. */
  maxWriteBytes: number;
  /** Max output chars retained. */
  maxOutputChars: number;
  /** Max CPU seconds (undefined = no extra cap). */
  maxCpuSeconds?: number;
  /** Max token TTL the broker may issue under this policy, ms. */
  maxTokenTtlMs: number;
}

/** A versioned sandbox v2 policy (policy-as-code). */
export interface SandboxV2Policy {
  /** Stable id (e.g. 'strict', 'standard', 'custom-ci'). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Description shown in the UI. */
  description: string;
  /** Schema version of this document (see SANDBOX_V2_POLICY_SCHEMA_VERSION). */
  schemaVersion: number;
  /** Policy version — increments on every change. */
  version: number;
  /** Previous policy version this one supersedes (undefined for v1). */
  previousVersion?: number;
  /** Trust level this policy is written for. */
  trust: SandboxV2TrustLevel;
  /** Minimum tier that must enforce this policy (run upgrades, never downgrades). */
  minTier: SandboxV2Tier;
  /** Minimum tier level (1–3), kept in sync with `minTier`. */
  minTierLevel: SandboxV2TierLevel;
  /** Syscall rules (tier 2+ enforces; tier 1 logs only). */
  syscalls: SandboxV2SyscallRules;
  /** File rules (all tiers enforce). */
  files: SandboxV2FileRules;
  /** Network rules (all tiers enforce; off by default). */
  network: SandboxV2NetworkRules;
  /** Resource caps. */
  caps: SandboxV2PolicyCaps;
  /** Command names allowed (empty = any command the tier allows). */
  commands: string[];
  /** Shell access at all (false = file tools only, no shell). */
  shellEnabled: boolean;
  /** ISO timestamp of the last change. */
  updatedAt: string;
}

/** Result of validating a policy document. */
export interface SandboxV2PolicyValidation {
  valid: boolean;
  problems: string[];
  warnings: string[];
  /** Normalised copy of the policy (defaults filled) when valid. */
  policy?: SandboxV2Policy;
}

/** Tier name → level. */
export const SANDBOX_V2_TIER_LEVELS: Record<SandboxV2Tier, SandboxV2TierLevel> = {
  bwrap: 1,
  'syscall-policy': 2,
  microvm: 3,
};

/** Level → tier name. */
export const SANDBOX_V2_LEVEL_TIERS: Record<SandboxV2TierLevel, SandboxV2Tier> = {
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

/** Default caps for a trust level. Tighter trust = tighter caps. */
export function defaultCapsForTrust(trust: SandboxV2TrustLevel): SandboxV2PolicyCaps {
  switch (trust) {
    case 'trusted':
      return {
        maxLifetimeMs: 600_000,
        maxWriteBytes: 500 * 1024 * 1024,
        maxOutputChars: 500_000,
        maxCpuSeconds: 600,
        maxTokenTtlMs: 3_600_000,
      };
    case 'standard':
      return {
        maxLifetimeMs: 120_000,
        maxWriteBytes: 100 * 1024 * 1024,
        maxOutputChars: 200_000,
        maxCpuSeconds: 120,
        maxTokenTtlMs: 900_000,
      };
    case 'untrusted':
      return {
        maxLifetimeMs: 60_000,
        maxWriteBytes: 10 * 1024 * 1024,
        maxOutputChars: 50_000,
        maxCpuSeconds: 60,
        maxTokenTtlMs: 300_000,
      };
    case 'hostile':
      return {
        maxLifetimeMs: 30_000,
        maxWriteBytes: 1 * 1024 * 1024,
        maxOutputChars: 10_000,
        maxCpuSeconds: 30,
        maxTokenTtlMs: 60_000,
      };
  }
}

/** Minimum tier for a trust level. */
export function minTierForTrust(trust: SandboxV2TrustLevel): SandboxV2Tier {
  switch (trust) {
    case 'trusted':
      return 'bwrap';
    case 'standard':
      return 'syscall-policy';
    case 'untrusted':
      return 'syscall-policy';
    case 'hostile':
      return 'microvm';
  }
}

/** Build a full policy from a partial spec (fills defaults per trust). */
export function createSandboxV2Policy(spec: {
  id: string;
  name?: string;
  description?: string;
  trust: SandboxV2TrustLevel;
  minTier?: SandboxV2Tier;
  syscalls?: Partial<SandboxV2SyscallRules>;
  files?: Partial<SandboxV2FileRules>;
  network?: Partial<SandboxV2NetworkRules>;
  caps?: Partial<SandboxV2PolicyCaps>;
  commands?: string[];
  shellEnabled?: boolean;
  version?: number;
  previousVersion?: number;
}): SandboxV2Policy {
  const minTier = spec.minTier ?? minTierForTrust(spec.trust);
  const caps = { ...defaultCapsForTrust(spec.trust), ...(spec.caps ?? {}) };
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    description: spec.description ?? '',
    schemaVersion: SANDBOX_V2_POLICY_SCHEMA_VERSION,
    version: spec.version ?? 1,
    ...(spec.previousVersion !== undefined ? { previousVersion: spec.previousVersion } : {}),
    trust: spec.trust,
    minTier,
    minTierLevel: SANDBOX_V2_TIER_LEVELS[minTier],
    syscalls: {
      allow: spec.syscalls?.allow ?? [],
      deny: spec.syscalls?.deny ?? [],
      logOnlyDeny: spec.syscalls?.logOnlyDeny ?? false,
    },
    files: {
      readPrefixes: spec.files?.readPrefixes ?? ['.'],
      writePrefixes: spec.files?.writePrefixes ?? ['.'],
      denyPrefixes: spec.files?.denyPrefixes ?? [],
    },
    network: {
      enabled: spec.network?.enabled ?? false,
      hosts: spec.network?.hosts ?? [],
      hostSuffixes: spec.network?.hostSuffixes ?? [],
      ports: spec.network?.ports ?? [],
    },
    caps,
    commands: spec.commands ?? [],
    shellEnabled: spec.shellEnabled ?? true,
    updatedAt: isoNow(),
  };
}

/** Built-in strict policy: file tools only, no shell, no network. */
export const SANDBOX_V2_POLICY_STRICT: SandboxV2Policy = createSandboxV2Policy({
  id: 'strict',
  name: 'Strict',
  description: 'File tools only, no shell, no network, tiny limits. For hostile code.',
  trust: 'hostile',
  minTier: 'microvm',
  files: { readPrefixes: ['.'], writePrefixes: ['.'], denyPrefixes: [] },
  network: { enabled: false, hosts: [], hostSuffixes: [], ports: [] },
  shellEnabled: false,
  commands: [],
});

/** Built-in standard policy: shell + allow-listed network, moderate limits. */
export const SANDBOX_V2_POLICY_STANDARD: SandboxV2Policy = createSandboxV2Policy({
  id: 'standard',
  name: 'Standard',
  description: 'Shell + network to allow-listed hosts, moderate limits. Default for agent code.',
  trust: 'standard',
  minTier: 'syscall-policy',
  network: {
    enabled: true,
    hosts: ['api.github.com', 'registry.npmjs.org'],
    hostSuffixes: ['.githubusercontent.com'],
    ports: [443],
  },
  commands: ['node', 'npm', 'npx', 'git', 'python3', 'ls', 'cat'],
});

/** Built-in trusted policy: first-party code, generous limits, still no open network. */
export const SANDBOX_V2_POLICY_TRUSTED: SandboxV2Policy = createSandboxV2Policy({
  id: 'trusted',
  name: 'Trusted',
  description: 'First-party reviewed code. Generous limits, network still allow-listed.',
  trust: 'trusted',
  minTier: 'bwrap',
  network: {
    enabled: true,
    hosts: ['api.github.com', 'registry.npmjs.org'],
    hostSuffixes: ['.githubusercontent.com'],
    ports: [443, 80],
  },
  commands: ['node', 'npm', 'npx', 'git', 'python3', 'pip', 'ls', 'cat', 'curl'],
});

/** Built-in untrusted policy: network code, tight limits, syscall tier. */
export const SANDBOX_V2_POLICY_UNTRUSTED: SandboxV2Policy = createSandboxV2Policy({
  id: 'untrusted',
  name: 'Untrusted',
  description: 'Code from the network or pasted by a user. No network, tight limits.',
  trust: 'untrusted',
  minTier: 'syscall-policy',
  network: { enabled: false, hosts: [], hostSuffixes: [], ports: [] },
  commands: ['node', 'python3', 'ls', 'cat'],
});

/** All built-in policies, keyed by id. */
export const BUILTIN_SANDBOX_V2_POLICIES: Record<string, SandboxV2Policy> = {
  strict: SANDBOX_V2_POLICY_STRICT,
  standard: SANDBOX_V2_POLICY_STANDARD,
  trusted: SANDBOX_V2_POLICY_TRUSTED,
  untrusted: SANDBOX_V2_POLICY_UNTRUSTED,
};

/** Look up a built-in policy by id (case-insensitive, undefined when unknown). */
export function getBuiltinSandboxV2Policy(id: string): SandboxV2Policy | undefined {
  const found = BUILTIN_SANDBOX_V2_POLICIES[id.toLowerCase()];
  return found ? clone(found) : undefined;
}

/** Built-in policy for a trust level. */
export function builtinPolicyForTrust(trust: SandboxV2TrustLevel): SandboxV2Policy {
  switch (trust) {
    case 'trusted':
      return clone(SANDBOX_V2_POLICY_TRUSTED);
    case 'standard':
      return clone(SANDBOX_V2_POLICY_STANDARD);
    case 'untrusted':
      return clone(SANDBOX_V2_POLICY_UNTRUSTED);
    case 'hostile':
      return clone(SANDBOX_V2_POLICY_STRICT);
  }
}

/**
 * Validate a policy document. Returns every problem found (fail-closed:
 * any problem means the policy must NOT be applied). Also fills
 * defaults and returns a normalised copy when valid.
 */
export function validateSandboxV2Policy(input: unknown): SandboxV2PolicyValidation {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, problems: ['policy must be an object'], warnings };
  }
  const p = input as Partial<SandboxV2Policy>;

  if (typeof p.id !== 'string' || p.id.trim() === '') problems.push('policy id must be a non-empty string');
  if (typeof p.name !== 'string' || p.name.trim() === '') problems.push('policy name must be a non-empty string');
  if (p.schemaVersion !== SANDBOX_V2_POLICY_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${SANDBOX_V2_POLICY_SCHEMA_VERSION}, got ${String(p.schemaVersion)}`);
  }
  if (typeof p.version !== 'number' || !Number.isInteger(p.version) || p.version < 1) {
    problems.push('version must be a positive integer');
  }
  if (p.previousVersion !== undefined && (!Number.isInteger(p.previousVersion) || p.previousVersion < 1)) {
    problems.push('previousVersion must be a positive integer when set');
  }
  if (
    p.previousVersion !== undefined &&
    typeof p.version === 'number' &&
    p.previousVersion >= p.version
  ) {
    problems.push('previousVersion must be smaller than version');
  }
  const trusts: SandboxV2TrustLevel[] = ['trusted', 'standard', 'untrusted', 'hostile'];
  if (!trusts.includes(p.trust as SandboxV2TrustLevel)) {
    problems.push(`trust must be one of ${trusts.join(', ')}`);
  }
  const tiers: SandboxV2Tier[] = ['bwrap', 'syscall-policy', 'microvm'];
  if (!tiers.includes(p.minTier as SandboxV2Tier)) {
    problems.push(`minTier must be one of ${tiers.join(', ')}`);
  }
  if (
    p.minTier !== undefined &&
    p.minTierLevel !== undefined &&
    SANDBOX_V2_TIER_LEVELS[p.minTier as SandboxV2Tier] !== p.minTierLevel
  ) {
    problems.push(`minTierLevel ${String(p.minTierLevel)} does not match minTier ${String(p.minTier)}`);
  }
  if (
    p.trust !== undefined &&
    p.minTier !== undefined &&
    trusts.includes(p.trust as SandboxV2TrustLevel) &&
    tiers.includes(p.minTier as SandboxV2Tier)
  ) {
    const floor = SANDBOX_V2_TIER_LEVELS[minTierForTrust(p.trust as SandboxV2TrustLevel)];
    const got = SANDBOX_V2_TIER_LEVELS[p.minTier as SandboxV2Tier];
    if (got < floor) {
      problems.push(
        `minTier ${String(p.minTier)} is below the floor ${minTierForTrust(p.trust as SandboxV2TrustLevel)} for trust ${String(p.trust)}`,
      );
    }
  }

  // Syscalls.
  if (!p.syscalls || typeof p.syscalls !== 'object') {
    problems.push('syscalls must be an object');
  } else {
    if (!Array.isArray(p.syscalls.allow)) problems.push('syscalls.allow must be an array');
    if (!Array.isArray(p.syscalls.deny)) problems.push('syscalls.deny must be an array');
    const allow = Array.isArray(p.syscalls.allow) ? p.syscalls.allow : [];
    const deny = Array.isArray(p.syscalls.deny) ? p.syscalls.deny : [];
    for (const s of [...allow, ...deny]) {
      if (typeof s !== 'string' || s.trim() === '') problems.push(`syscall entries must be non-empty strings, got ${JSON.stringify(s)}`);
    }
    const overlap = allow.filter((s) => deny.includes(s));
    if (overlap.length > 0) problems.push(`syscalls listed in both allow and deny: ${overlap.join(', ')}`);
    if (typeof p.syscalls.logOnlyDeny !== 'boolean') problems.push('syscalls.logOnlyDeny must be a boolean');
  }

  // Files.
  if (!p.files || typeof p.files !== 'object') {
    problems.push('files must be an object');
  } else {
    for (const key of ['readPrefixes', 'writePrefixes', 'denyPrefixes'] as const) {
      const list = p.files[key];
      if (!Array.isArray(list)) {
        problems.push(`files.${key} must be an array`);
      } else {
        for (const prefix of list) {
          if (typeof prefix !== 'string' || prefix.trim() === '') {
            problems.push(`files.${key} entries must be non-empty strings`);
          } else if (prefix.includes('..')) {
            problems.push(`files.${key} entry "${prefix}" must not contain ".."`);
          }
        }
      }
    }
    const read = Array.isArray(p.files.readPrefixes) ? p.files.readPrefixes : [];
    const write = Array.isArray(p.files.writePrefixes) ? p.files.writePrefixes : [];
    for (const w of write) {
      if (typeof w === 'string' && !read.includes(w) && !read.includes('.') && w !== '.') {
        warnings.push(`write prefix "${w}" is not covered by any read prefix`);
      }
    }
  }

  // Network.
  if (!p.network || typeof p.network !== 'object') {
    problems.push('network must be an object');
  } else {
    if (typeof p.network.enabled !== 'boolean') problems.push('network.enabled must be a boolean');
    if (!Array.isArray(p.network.hosts)) problems.push('network.hosts must be an array');
    if (!Array.isArray(p.network.hostSuffixes)) problems.push('network.hostSuffixes must be an array');
    if (!Array.isArray(p.network.ports)) problems.push('network.ports must be an array');
    const ports = Array.isArray(p.network.ports) ? p.network.ports : [];
    for (const port of ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        problems.push(`network.ports entries must be integers 1–65535, got ${String(port)}`);
      }
    }
    const hosts = Array.isArray(p.network.hosts) ? p.network.hosts : [];
    for (const host of hosts) {
      if (typeof host !== 'string' || host.trim() === '' || host.includes('/') || host.includes(' ')) {
        problems.push(`network.hosts entries must be plain hostnames, got ${JSON.stringify(host)}`);
      }
    }
    if (p.network.enabled && hosts.length === 0 && (p.network.hostSuffixes ?? []).length === 0) {
      warnings.push('network.enabled is true but no hosts are allow-listed — nothing will be reachable');
    }
    if (!p.network.enabled && hosts.length > 0) {
      warnings.push('network.hosts are listed but network.enabled is false — hosts will stay unreachable');
    }
  }

  // Caps.
  if (!p.caps || typeof p.caps !== 'object') {
    problems.push('caps must be an object');
  } else {
    if (typeof p.caps.maxLifetimeMs !== 'number' || p.caps.maxLifetimeMs <= 0) {
      problems.push('caps.maxLifetimeMs must be a positive number');
    } else if (p.caps.maxLifetimeMs > SANDBOX_V2_MAX_LIFETIME_MS) {
      problems.push(`caps.maxLifetimeMs must not exceed ${SANDBOX_V2_MAX_LIFETIME_MS}`);
    }
    if (typeof p.caps.maxWriteBytes !== 'number' || p.caps.maxWriteBytes < 0) {
      problems.push('caps.maxWriteBytes must be a non-negative number');
    }
    if (typeof p.caps.maxOutputChars !== 'number' || p.caps.maxOutputChars < 0) {
      problems.push('caps.maxOutputChars must be a non-negative number');
    }
    if (p.caps.maxCpuSeconds !== undefined && (typeof p.caps.maxCpuSeconds !== 'number' || p.caps.maxCpuSeconds <= 0)) {
      problems.push('caps.maxCpuSeconds must be a positive number when set');
    }
    if (typeof p.caps.maxTokenTtlMs !== 'number' || p.caps.maxTokenTtlMs <= 0) {
      problems.push('caps.maxTokenTtlMs must be a positive number');
    } else if (p.caps.maxTokenTtlMs > SANDBOX_V2_MAX_TOKEN_TTL_MS) {
      problems.push(`caps.maxTokenTtlMs must not exceed ${SANDBOX_V2_MAX_TOKEN_TTL_MS}`);
    }
  }

  if (!Array.isArray(p.commands)) {
    problems.push('commands must be an array');
  } else {
    for (const c of p.commands) {
      if (typeof c !== 'string' || c.trim() === '' || c.includes('/') || c.includes(' ')) {
        problems.push(`commands entries must be bare command names, got ${JSON.stringify(c)}`);
      }
    }
  }
  if (typeof p.shellEnabled !== 'boolean') problems.push('shellEnabled must be a boolean');
  if (p.shellEnabled === false && Array.isArray(p.commands) && p.commands.length > 0) {
    problems.push('shellEnabled is false but commands are listed — a shell-less policy cannot run commands');
  }

  if (problems.length > 0) return { valid: false, problems, warnings };
  const policy = clone(p as SandboxV2Policy);
  policy.minTierLevel = SANDBOX_V2_TIER_LEVELS[policy.minTier];
  return { valid: true, problems: [], warnings, policy };
}

/** Validate or throw a SandboxV2PolicyError with every problem listed. */
export function assertValidSandboxV2Policy(input: unknown): SandboxV2Policy {
  const result = validateSandboxV2Policy(input);
  if (!result.valid || !result.policy) {
    throw new SandboxV2PolicyError(`Invalid sandbox v2 policy: ${result.problems.join('; ')}`, result.problems);
  }
  return result.policy;
}

/** Parse a policy from a JSON string (throws SandboxV2PolicyError on bad JSON or bad policy). */
export function parseSandboxV2Policy(json: string): SandboxV2Policy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    throw new SandboxV2PolicyError(`Policy JSON is not valid JSON: ${(err as Error).message}`, ['invalid JSON']);
  }
  return assertValidSandboxV2Policy(parsed);
}

/** Serialise a policy to stable JSON (sorted keys at the top level for diffing). */
export function serializeSandboxV2Policy(policy: SandboxV2Policy): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(policy).sort()) {
    ordered[key] = (policy as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered, null, 2);
}

/**
 * Derive a new policy version from an existing one. `version` is
 * bumped by 1, `previousVersion` is set to the old version, and the
 * supplied patch is applied. The result is validated before return.
 */
export function deriveSandboxV2Policy(
  base: SandboxV2Policy,
  patch: Partial<Omit<SandboxV2Policy, 'id' | 'schemaVersion' | 'version' | 'previousVersion' | 'updatedAt'>>,
): SandboxV2Policy {
  const next: SandboxV2Policy = {
    ...clone(base),
    ...clone(patch as Record<string, unknown>),
    version: base.version + 1,
    previousVersion: base.version,
    updatedAt: isoNow(),
  } as SandboxV2Policy;
  return assertValidSandboxV2Policy(next);
}

/** True when a path hits a built-in denied segment or suffix (checked before any allow-list). */
export function isDeniedSandboxV2Path(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  for (const segment of segments) {
    if ((SANDBOX_V2_DENIED_PATH_SEGMENTS as readonly string[]).includes(segment)) return true;
  }
  const lower = normalized.toLowerCase();
  for (const suffix of SANDBOX_V2_DENIED_PATH_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

/** True when `targetPath` is under one of the `prefixes` (lexical, prefix match on segments). */
export function isPathUnderPrefixes(targetPath: string, prefixes: string[]): boolean {
  const normalized = targetPath.replace(/\\/g, '/').replace(/\/+$/, '') || '.';
  for (const rawPrefix of prefixes) {
    const prefix = rawPrefix.replace(/\\/g, '/').replace(/\/+$/, '') || '.';
    if (prefix === '.') return true;
    if (normalized === prefix) return true;
    if (normalized.startsWith(`${prefix}/`)) return true;
  }
  return false;
}
