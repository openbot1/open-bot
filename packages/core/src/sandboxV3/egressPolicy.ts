/**
 * Sandbox v3 — egress policy gate (v1.35, Team T2).
 *
 * Every outbound network request from inside the sandbox passes
 * this gate BEFORE it leaves the machine. The gate answers one
 * question — "may this session reach this URL?" — from four rules,
 * checked in this order:
 *
 *  1. Network disabled → deny everything (`network-disabled`).
 *  2. URL must parse and use an allowed scheme (default https only).
 *  3. Host must be allowed and not blocked. Host matching is
 *     dot-boundary safe: `*.example.com` matches `api.example.com`
 *     but NOT `notexample.com` and NOT `xexample.com` (the
 *     suffix-attack shape the v2 tests caught on
 *     `xgithubusercontent.com`). Exact hosts match exactly; a
 *     leading `*.` matches one or more labels; a bare suffix entry
 *     such as `.example.com` is treated as "this domain and below".
 *     Private / loopback / link-local addresses are never allowed
 *     unless the policy explicitly opts in — this blocks the classic
 *     cloud-metadata grab (`169.254.169.254`) and localhost scans.
 *  4. Budgets: a per-session request count and byte cap. Exceeding
 *     either denies the request and the denial is recorded.
 *
 * The gate keeps no sockets and performs no I/O: it is the decision
 * layer. The runner (or the real network shim underneath) enforces
 * the decision and reports the bytes actually transferred back via
 * `recordBytes`, so the byte budget tracks reality, not estimates.
 */

import type {
  SandboxV3EgressCheck,
  SandboxV3EgressDenyReason,
  SandboxV3EgressRequest,
} from './types';

/** One egress policy document (plain JSON, safe to store). */
export interface SandboxV3EgressPolicy {
  /** When false, no egress at all. Default false (fail-closed). */
  enabled: boolean;
  /** Allowed URL schemes, lower-cased. Default `['https']`. */
  schemes: string[];
  /**
   * Allowed hosts. Each entry is an exact host (`api.example.com`),
   * a wildcard (`*.example.com`, dot-boundary safe) or a suffix
   * (`.example.com`, this domain and below). Empty = allow none.
   */
  allowedHosts: string[];
  /** Blocked hosts, same matching rules. Wins over `allowedHosts`. */
  blockedHosts: string[];
  /** Allowed destination ports. Empty = any port (still scheme-gated). */
  allowedPorts: number[];
  /** Max requests per session. 0 = unlimited. Default 100. */
  maxRequests: number;
  /** Max bytes per session (request + response). 0 = unlimited. */
  maxBytes: number;
  /**
   * When true, loopback / private / link-local targets are allowed
   * when they also match `allowedHosts`. Default false: they are
   * always denied, even when listed. Only enable for local dev.
   */
  allowPrivateTargets: boolean;
}

/** Defaults: network off. A policy must opt in explicitly. */
export const SANDBOX_V3_EGRESS_OFFLINE: SandboxV3EgressPolicy = {
  enabled: false,
  schemes: ['https'],
  allowedHosts: [],
  blockedHosts: [],
  allowedPorts: [],
  maxRequests: 0,
  maxBytes: 0,
  allowPrivateTargets: false,
};

/** Restricted egress: a small allowlist of package / API hosts. */
export const SANDBOX_V3_EGRESS_RESTRICTED: SandboxV3EgressPolicy = {
  enabled: true,
  schemes: ['https'],
  allowedHosts: [
    'registry.npmjs.org',
    '*.registry.npmjs.org',
    'pypi.org',
    '*.pypi.org',
    'files.pythonhosted.org',
    'github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'api.github.com',
  ],
  blockedHosts: ['*.internal.example.com'],
  allowedPorts: [443],
  maxRequests: 200,
  maxBytes: 100 * 1024 * 1024,
  allowPrivateTargets: false,
};

/** Open egress: any public host, still scheme + budget gated. */
export const SANDBOX_V3_EGRESS_OPEN: SandboxV3EgressPolicy = {
  enabled: true,
  schemes: ['https', 'http'],
  allowedHosts: ['*'],
  blockedHosts: [],
  allowedPorts: [],
  maxRequests: 1000,
  maxBytes: 500 * 1024 * 1024,
  allowPrivateTargets: false,
};

/** Well-known cloud metadata / internal endpoints, always blocked. */
export const SANDBOX_V3_EGRESS_ALWAYS_BLOCKED_HOSTS: readonly string[] = [
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
  'localhost',
  'localhost.localdomain',
];

/** Normalise a host for comparison: lower-case, strip trailing dot. */
export function normaliseEgressHost(host: string): string {
  let out = host.trim().toLowerCase();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  while (out.endsWith('.')) out = out.slice(0, -1);
  return out;
}

/**
 * Match one host against one pattern, dot-boundary safe.
 *
 *  - `*` matches any host.
 *  - `*.example.com` matches `api.example.com` and
 *    `a.b.example.com`, but not `example.com` and not
 *    `xexample.com` / `notexample.com`.
 *  - `.example.com` matches `example.com` and anything below it.
 *  - anything else matches exactly.
 */
export function matchEgressHost(host: string, pattern: string): boolean {
  const h = normaliseEgressHost(host);
  const p = normaliseEgressHost(pattern);
  if (h.length === 0 || p.length === 0) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  if (p.startsWith('.')) {
    return h === p.slice(1) || h.endsWith(p);
  }
  return h === p;
}

/** True when the host matches any pattern in the list. */
export function matchAnyEgressHost(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchEgressHost(host, pattern));
}

/** True when the string is an IPv4 literal. */
export function isIPv4Literal(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** True when the string is an IPv6 literal (contains `:`). */
export function isIPv6Literal(host: string): boolean {
  return host.includes(':');
}

/**
 * True when an IPv4 literal is loopback, private (RFC 1918),
 * link-local, multicast, unspecified or reserved. The ranges:
 * 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8, 224/4, 240/4.
 */
export function isPrivateIPv4(host: string): boolean {
  if (!isIPv4Literal(host)) return false;
  const [a, b] = host.split('.').map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0 || a >= 224) return true;
  return false;
}

/**
 * True when a host is a private / loopback / link-local target:
 * an IPv4 private literal, an IPv6 loopback / link-local / unique
 * local literal, or a well-known internal hostname.
 */
export function isPrivateEgressTarget(host: string): boolean {
  const h = normaliseEgressHost(host);
  if (isPrivateIPv4(h)) return true;
  if (isIPv6Literal(h)) {
    const lower = h.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  return SANDBOX_V3_EGRESS_ALWAYS_BLOCKED_HOSTS.includes(h);
}

/** Parse a URL into the pieces the gate checks. */
export function parseEgressUrl(
  rawUrl: string,
): { ok: true; scheme: string; host: string; port: number } | { ok: false; detail: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, detail: `URL "${rawUrl}" does not parse` };
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = normaliseEgressHost(parsed.hostname);
  if (host.length === 0) {
    return { ok: false, detail: `URL "${rawUrl}" has no host` };
  }
  let port = parsed.port === '' ? 0 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, detail: `URL "${rawUrl}" has an invalid port` };
  }
  if (port === 0) port = scheme === 'https' ? 443 : scheme === 'http' ? 80 : 0;
  return { ok: true, scheme, host, port };
}

/** Default port for a scheme (0 when the scheme has no default). */
export function defaultPortForScheme(scheme: string): number {
  if (scheme === 'https') return 443;
  if (scheme === 'http') return 80;
  if (scheme === 'ftp') return 21;
  if (scheme === 'ws') return 80;
  if (scheme === 'wss') return 443;
  return 0;
}

/** Validate a raw egress policy document (unknown JSON). */
export function validateSandboxV3EgressPolicy(input: unknown): {
  valid: boolean;
  problems: string[];
  warnings: string[];
  policy?: SandboxV3EgressPolicy;
} {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, problems: ['Egress policy must be a JSON object'], warnings };
  }
  const doc = input as Record<string, unknown>;
  if (typeof doc.enabled !== 'boolean') problems.push('enabled must be a boolean');
  const schemes = doc.schemes;
  if (!Array.isArray(schemes) || schemes.some((s) => typeof s !== 'string' || s === '')) {
    problems.push('schemes must be an array of non-empty strings');
  }
  for (const key of ['allowedHosts', 'blockedHosts'] as const) {
    const list = doc[key];
    if (!Array.isArray(list) || list.some((h) => typeof h !== 'string' || h === '')) {
      problems.push(`${key} must be an array of non-empty strings`);
    }
  }
  const ports = doc.allowedPorts;
  if (
    !Array.isArray(ports) ||
    ports.some((p) => typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535)
  ) {
    problems.push('allowedPorts must be an array of integers 1..65535');
  }
  for (const key of ['maxRequests', 'maxBytes'] as const) {
    const value = doc[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      problems.push(`${key} must be a non-negative integer`);
    }
  }
  if (typeof doc.allowPrivateTargets !== 'boolean') {
    problems.push('allowPrivateTargets must be a boolean');
  }
  if (problems.length > 0) return { valid: false, problems, warnings };
  const policy = doc as unknown as SandboxV3EgressPolicy;
  if (policy.enabled && policy.allowedHosts.length === 0) {
    warnings.push('egress is enabled but allowedHosts is empty — nothing will pass');
  }
  if (policy.allowPrivateTargets) {
    warnings.push('allowPrivateTargets is on — loopback / private targets are reachable');
  }
  if (policy.schemes.includes('http')) {
    warnings.push('plain http is allowed — credentials and tokens travel in cleartext');
  }
  if (matchAnyEgressHost('169.254.169.254', policy.allowedHosts)) {
    warnings.push('allowedHosts matches the cloud metadata address 169.254.169.254');
  }
  return { valid: true, problems, warnings, policy };
}

/** Parse an egress policy from a JSON string (throws on bad JSON). */
export function parseEgressPolicy(json: string): SandboxV3EgressPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    throw new Error(`Egress policy JSON is not valid JSON: ${(err as Error).message}`);
  }
  const result = validateSandboxV3EgressPolicy(parsed);
  if (!result.valid || !result.policy) {
    throw new Error(`Invalid egress policy: ${result.problems.join('; ')}`);
  }
  return result.policy;
}

export interface SandboxV3EgressGateOptions {
  policy: SandboxV3EgressPolicy;
  /** Optional sink for denied requests (seq assigned by caller). */
  onDenied?: (check: SandboxV3EgressCheck) => void;
}

/**
 * Per-session egress gate. Holds the budget counters; one gate per
 * session, never shared across sessions (budgets are per-session).
 */
export class SandboxV3EgressGate {
  private readonly policy: SandboxV3EgressPolicy;
  private readonly onDenied?: SandboxV3EgressGateOptions['onDenied'];
  private requestsUsed = 0;
  private bytesUsed = 0;
  private deniedCount = 0;
  private readonly deniedLog: SandboxV3EgressCheck[] = [];

  constructor(options: SandboxV3EgressGateOptions) {
    this.policy = { ...options.policy };
    this.onDenied = options.onDenied;
  }

  /** Requests used so far in this session. */
  getRequestsUsed(): number {
    return this.requestsUsed;
  }

  /** Bytes used so far in this session. */
  getBytesUsed(): number {
    return this.bytesUsed;
  }

  /** How many requests this gate denied. */
  getDeniedCount(): number {
    return this.deniedCount;
  }

  /** Denied checks, in order (for the session report). */
  deniedChecks(): SandboxV3EgressCheck[] {
    return [...this.deniedLog];
  }

  /** Remaining request budget (Infinity when unlimited). */
  requestsRemaining(): number {
    if (this.policy.maxRequests === 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.policy.maxRequests - this.requestsUsed);
  }

  /** Remaining byte budget (Infinity when unlimited). */
  bytesRemaining(): number {
    if (this.policy.maxBytes === 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.policy.maxBytes - this.bytesUsed);
  }

  /**
   * Check one egress request. A successful (allowed) check consumes
   * one request from the budget immediately, so a burst of parallel
   * checks cannot overspend the count; the byte cost is recorded
   * later via `recordBytes` with the real transferred size.
   */
  check(request: SandboxV3EgressRequest): SandboxV3EgressCheck {
    const fail = (
      reason: SandboxV3EgressDenyReason,
      detail: string,
      host = '',
      scheme = '',
      port = 0,
    ): SandboxV3EgressCheck => {
      const check: SandboxV3EgressCheck = {
        verdict: 'deny',
        reason,
        detail,
        host,
        scheme,
        port,
        requestsUsed: this.requestsUsed,
        bytesUsed: this.bytesUsed,
      };
      this.deniedCount += 1;
      this.deniedLog.push(check);
      this.onDenied?.(check);
      return check;
    };

    if (!this.policy.enabled) {
      return fail('network-disabled', 'Egress is disabled for this session');
    }
    const parsed = parseEgressUrl(request.url);
    if (!parsed.ok) {
      return fail('invalid-url', parsed.detail);
    }
    const { scheme, host, port } = parsed;
    if (!this.policy.schemes.map((s) => s.toLowerCase()).includes(scheme)) {
      return fail(
        'scheme-not-allowed',
        `Scheme "${scheme}" is not allowed (allowed: ${this.policy.schemes.join(', ') || 'none'})`,
        host,
        scheme,
        port,
      );
    }
    if (
      SANDBOX_V3_EGRESS_ALWAYS_BLOCKED_HOSTS.includes(host) ||
      matchAnyEgressHost(host, this.policy.blockedHosts)
    ) {
      return fail('host-blocked', `Host "${host}" is on the block list`, host, scheme, port);
    }
    if (isPrivateEgressTarget(host) && !this.policy.allowPrivateTargets) {
      return fail(
        'host-blocked',
        `Host "${host}" is a private / loopback / link-local target`,
        host,
        scheme,
        port,
      );
    }
    if (!matchAnyEgressHost(host, this.policy.allowedHosts)) {
      return fail(
        'host-not-allowed',
        `Host "${host}" is not on the egress allowlist`,
        host,
        scheme,
        port,
      );
    }
    if (
      this.policy.allowedPorts.length > 0 &&
      !this.policy.allowedPorts.includes(port)
    ) {
      return fail(
        'port-not-allowed',
        `Port ${port} is not allowed (allowed: ${this.policy.allowedPorts.join(', ')})`,
        host,
        scheme,
        port,
      );
    }
    if (this.policy.maxRequests > 0 && this.requestsUsed >= this.policy.maxRequests) {
      return fail(
        'request-budget-exceeded',
        `Request budget exceeded (${this.policy.maxRequests} requests per session)`,
        host,
        scheme,
        port,
      );
    }
    const expected = request.expectedBytes ?? 0;
    if (
      this.policy.maxBytes > 0 &&
      expected > 0 &&
      this.bytesUsed + expected > this.policy.maxBytes
    ) {
      return fail(
        'byte-budget-exceeded',
        `Byte budget would be exceeded (${this.bytesUsed + expected} > ${this.policy.maxBytes} bytes)`,
        host,
        scheme,
        port,
      );
    }
    this.requestsUsed += 1;
    if (expected > 0) this.bytesUsed += expected;
    return {
      verdict: 'allow',
      detail: `Allowed ${scheme}://${host}:${port}`,
      host,
      scheme,
      port,
      requestsUsed: this.requestsUsed,
      bytesUsed: this.bytesUsed,
    };
  }

  /**
   * Record bytes actually transferred for an allowed request (the
   * real response size, which may differ from `expectedBytes`).
   * The delta is added to the session byte counter; when the caller
   * already counted `expectedBytes` in `check`, pass the difference.
   */
  recordBytes(bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) this.bytesUsed += bytes;
  }

  /** Summarise the gate for a session report. */
  describe(): {
    enabled: boolean;
    schemes: string[];
    allowedHosts: string[];
    blockedHosts: string[];
    allowedPorts: number[];
    maxRequests: number;
    maxBytes: number;
    requestsUsed: number;
    bytesUsed: number;
    denied: number;
  } {
    return {
      enabled: this.policy.enabled,
      schemes: [...this.policy.schemes],
      allowedHosts: [...this.policy.allowedHosts],
      blockedHosts: [...this.policy.blockedHosts],
      allowedPorts: [...this.policy.allowedPorts],
      maxRequests: this.policy.maxRequests,
      maxBytes: this.policy.maxBytes,
      requestsUsed: this.requestsUsed,
      bytesUsed: this.bytesUsed,
      denied: this.deniedCount,
    };
  }
}
