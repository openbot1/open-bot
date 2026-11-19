/**
 * CIDR sandbox rules v24 (v1.37, Đội T6).
 *
 * The local router decides which network destinations a sandboxed bot may
 * reach. Until now those rules lived in config files; v24 puts them in
 * the router UI: an operator adds an allow/deny rule for a CIDR range,
 * binds it to a route, and the change takes effect immediately and is
 * written to an audit trail.
 *
 * Concepts:
 * - CIDR parsing/validation is implemented here, from first principles,
 *   for both IPv4 (`203.0.113.0/24`) and IPv6 (`2001:db8::/32`). A bare
 *   IP without a prefix is treated as a single host (`/32` / `/128`).
 *   Validation returns a list of human-readable problems instead of
 *   throwing, so the UI can show them inline next to the form field.
 * - `FleetV24CidrRule` — one rule: id, CIDR (stored normalised, i.e.
 *   the network address with the prefix), action (`allow` or `deny`),
 *   optional route binding (null = applies to every route), priority
 *   (lower wins on equal prefix length), enabled flag, author, and
 *   timestamps. Rules are ordered by longest-prefix-match first, then
 *   priority, then deny-before-allow on a full tie — the most specific
 *   rule decides, and a deny at the same specificity beats an allow.
 * - `FleetV24CidrRuleSet` — the live rule set. It validates every
 *   mutation, detects overlapping rules (reported as warnings, not
 *   errors — an overlap is legal but usually a mistake), evaluates a
 *   (route, IP) pair to an allow/deny decision with the winning rule
 *   named, and records every change in an audit log.
 * - Route bindings are explicit: `routesForRule` / `rulesForRoute`
 *   answer "which rule applies to this route?" without guessing.
 *
 * Default decision when no rule matches is configurable per rule set
 * (`deny` by default — fail closed, like a sandbox should).
 */

/** A rule action: allow the destination, or deny it. */
export type FleetV24CidrAction = 'allow' | 'deny';

/** Default decision when no rule matches a (route, IP) pair. */
export type FleetV24CidrDefault = 'allow' | 'deny';

/** One parsed IP address (v4 or v6) as a bigint plus its bit width. */
export interface FleetV24ParsedIp {
  /** Numeric value of the address. */
  value: bigint;
  /** 32 for IPv4, 128 for IPv6. */
  bits: 32 | 128;
}

/** One parsed CIDR range: network address + prefix length. */
export interface FleetV24ParsedCidr {
  /** Network address (host bits cleared). */
  network: bigint;
  /** Prefix length. */
  prefix: number;
  /** 32 for IPv4, 128 for IPv6. */
  bits: 32 | 128;
  /** Normalised text form (`203.0.113.0/24`, `2001:db8::/32`). */
  text: string;
  /** True when the input had host bits set (e.g. `10.0.0.5/24`). */
  hadHostBits: boolean;
}

/** One CIDR sandbox rule. */
export interface FleetV24CidrRule {
  /** Rule id, unique inside the rule set. */
  id: string;
  /** CIDR range, stored normalised (network address + prefix). */
  cidr: string;
  /** What the rule does to matching traffic. */
  action: FleetV24CidrAction;
  /** Route this rule applies to (null = every route). */
  routeId: string | null;
  /** Lower number = higher priority on equal prefix length. */
  priority: number;
  /** Disabled rules are kept but never match. */
  enabled: boolean;
  /** Human description (why the rule exists). */
  description: string;
  /** Who created the rule. */
  createdBy: string;
  /** When the rule was created (epoch ms). */
  createdAtMs: number;
  /** When the rule last changed (epoch ms). */
  updatedAtMs: number;
}

/** Input for creating a CIDR rule. */
export interface FleetV24CreateCidrRuleInput {
  id: string;
  cidr: string;
  action: FleetV24CidrAction;
  routeId?: string | null;
  priority?: number;
  description?: string;
  createdBy?: string;
}

/** One audit entry for a CIDR rule change. */
export interface FleetV24CidrAuditEntry {
  /** Monotonic sequence inside the rule set. */
  seq: number;
  /** When the change happened (epoch ms). */
  atMs: number;
  /** Rule affected. */
  ruleId: string;
  /** What happened: create/update/enable/disable/remove. */
  action: string;
  /** Who made the change. */
  actor: string;
  /** Human-readable detail (old → new values). */
  detail: string;
}

/** Decision for one (route, IP) evaluation. */
export interface FleetV24CidrDecision {
  /** The final verdict. */
  action: FleetV24CidrAction;
  /** The rule that decided (null = default decision, no rule matched). */
  ruleId: string | null;
  /** Why this rule won (longest prefix / priority / default). */
  reason: string;
  /** The IP that was evaluated (normalised text). */
  ip: string;
  /** The route that was evaluated (null = all routes). */
  routeId: string | null;
  /** True when the decision came from the default (no rule matched). */
  fromDefault: boolean;
}

/** One overlap warning between two rules. */
export interface FleetV24CidrOverlap {
  ruleIdA: string;
  ruleIdB: string;
  /** The overlapping range (normalised CIDR text, or the smaller range). */
  overlapCidr: string;
  /** True when the two rules disagree (one allow, one deny). */
  conflicting: boolean;
  /** Human-readable explanation. */
  detail: string;
}

/** Maximum audit entries kept per rule set. */
export const FLEET_V24_CIDR_AUDIT_CAP = 500;

/** Maximum rule id length. */
export const FLEET_V24_CIDR_RULE_ID_MAX = 128;

// -- IP parsing (IPv4 + IPv6, from first principles) -------------------------

/** Parse an IPv4 address (`1.2.3.4`) into a 32-bit bigint, or null. */
export function parseFleetV24Ipv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

/** Render a 32-bit bigint as dotted-quad text. */
export function formatFleetV24Ipv4(value: bigint): string {
  const bytes: number[] = [];
  for (let shift = 24; shift >= 0; shift -= 8) {
    bytes.push(Number((value >> BigInt(shift)) & 0xffn));
  }
  return bytes.join('.');
}

/** Parse an IPv6 address (`2001:db8::1`) into a 128-bit bigint, or null. */
export function parseFleetV24Ipv6(text: string): bigint | null {
  if (text.length === 0 || text.includes(':::')) return null;
  // A zone id (`fe80::1%eth0`) is not an address we route on.
  if (text.includes('%')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseGroup = (group: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    return Number.parseInt(group, 16);
  };
  const expand = (side: string): number[] | null => {
    if (side === '') return [];
    const out: number[] = [];
    for (const piece of side.split(':')) {
      // An embedded IPv4 tail (`::ffff:1.2.3.4`) counts as two groups.
      if (piece.includes('.')) {
        const v4 = parseFleetV24Ipv4(piece);
        if (v4 === null) return null;
        out.push(Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn));
        continue;
      }
      const g = parseGroup(piece);
      if (g === null) return null;
      out.push(g);
    }
    return out;
  };
  let groups: number[];
  if (halves.length === 2) {
    const left = expand(halves[0]);
    const right = expand(halves[1]);
    if (left === null || right === null) return null;
    if (left.length + right.length > 7) return null;
    const missing = 8 - left.length - right.length;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    const expanded = expand(text);
    if (expanded === null || expanded.length !== 8) return null;
    groups = expanded;
  }
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  return value;
}

/** Render a 128-bit bigint as compressed IPv6 text (RFC 5952 style). */
export function formatFleetV24Ipv6(value: bigint): string {
  const groups: number[] = [];
  for (let shift = 112; shift >= 0; shift -= 16) {
    groups.push(Number((value >> BigInt(shift)) & 0xffffn));
  }
  // Find the longest run of zero groups (length >= 2) to compress.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= 8; i += 1) {
    if (i < 8 && groups[i] === 0) {
      if (curStart === -1) {
        curStart = i;
        curLen = 1;
      } else {
        curLen += 1;
      }
    } else {
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) {
    return groups.map((g) => g.toString(16)).join(':');
  }
  const left = groups.slice(0, bestStart).map((g) => g.toString(16)).join(':');
  const right = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(':');
  if (left === '' && right === '') return '::';
  if (left === '') return `::${right}`;
  if (right === '') return `${left}::`;
  return `${left}::${right}`;
}

/** Parse an IP (v4 or v6) into value + bit width, or null. */
export function parseFleetV24Ip(text: string): FleetV24ParsedIp | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(':')) {
    const value = parseFleetV24Ipv6(trimmed);
    return value === null ? null : { value, bits: 128 };
  }
  const value = parseFleetV24Ipv4(trimmed);
  return value === null ? null : { value, bits: 32 };
}

/** Render a parsed IP back to text. */
export function formatFleetV24Ip(parsed: FleetV24ParsedIp): string {
  return parsed.bits === 32 ? formatFleetV24Ipv4(parsed.value) : formatFleetV24Ipv6(parsed.value);
}

/** Mask with the top `prefix` bits set for a `bits`-wide address. */
function prefixMask(bits: number, prefix: number): bigint {
  if (prefix === 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

/**
 * Parse a CIDR string (`203.0.113.0/24`, `2001:db8::/32`) or a bare IP
 * (treated as a single host). Returns null when the input is not a valid
 * CIDR/IP at all.
 */
export function parseFleetV24Cidr(text: string): FleetV24ParsedCidr | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const slash = trimmed.indexOf('/');
  let ipText = trimmed;
  let prefixText: string | null = null;
  if (slash !== -1) {
    if (trimmed.indexOf('/', slash + 1) !== -1) return null;
    ipText = trimmed.slice(0, slash);
    prefixText = trimmed.slice(slash + 1);
  }
  const parsed = parseFleetV24Ip(ipText);
  if (parsed === null) return null;
  let prefix: number;
  if (prefixText === null) {
    prefix = parsed.bits;
  } else {
    if (!/^\d+$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) return null;
  }
  const mask = prefixMask(parsed.bits, prefix);
  const network = parsed.value & mask;
  const hadHostBits = network !== parsed.value;
  const networkText =
    parsed.bits === 32 ? formatFleetV24Ipv4(network) : formatFleetV24Ipv6(network);
  return {
    network,
    prefix,
    bits: parsed.bits,
    text: `${networkText}/${prefix}`,
    hadHostBits,
  };
}

/** True when an IP lies inside a parsed CIDR (same address family). */
export function ipInFleetV24Cidr(ip: FleetV24ParsedIp, cidr: FleetV24ParsedCidr): boolean {
  if (ip.bits !== cidr.bits) return false;
  return (ip.value & prefixMask(cidr.bits, cidr.prefix)) === cidr.network;
}

/** True when two parsed CIDRs overlap at all (same family). */
export function cidrFleetV24Overlaps(a: FleetV24ParsedCidr, b: FleetV24ParsedCidr): boolean {
  if (a.bits !== b.bits) return false;
  const shorter = a.prefix <= b.prefix ? a : b;
  const longer = a.prefix <= b.prefix ? b : a;
  return (longer.network & prefixMask(shorter.bits, shorter.prefix)) === shorter.network;
}

// -- validation ---------------------------------------------------------------

/**
 * Validate a CIDR input for the router UI. Returns a list of problems
 * (empty = valid). A CIDR with host bits set is valid but flagged with
 * a warning-style problem so the UI can offer to normalise it — adding
 * the rule stores the normalised network (see `createFleetV24CidrRule`).
 */
export function validateFleetV24CidrInput(cidrText: string): string[] {
  const problems: string[] = [];
  const trimmed = cidrText.trim();
  if (trimmed.length === 0) {
    problems.push('CIDR must not be empty.');
    return problems;
  }
  if (trimmed.includes(' ')) {
    problems.push('CIDR must not contain spaces.');
    return problems;
  }
  const parsed = parseFleetV24Cidr(trimmed);
  if (parsed === null) {
    problems.push(
      `"${trimmed}" is not a valid IP or CIDR range (expected e.g. 203.0.113.0/24 or 2001:db8::/32).`,
    );
    return problems;
  }
  if (parsed.hadHostBits) {
    problems.push(
      `Host bits are set: "${trimmed}" is the network ${parsed.text}. ` +
        `Use ${parsed.text} or a single host address.`,
    );
  }
  if (parsed.prefix === 0) {
    problems.push('A /0 range matches the whole internet; use a narrower range.');
  }
  return problems;
}

/** Hard errors only (no warnings): unparseable input, empty, /0. */
export function fleetV24CidrHardErrors(cidrText: string): string[] {
  return validateFleetV24CidrInput(cidrText).filter(
    (p) => !p.startsWith('Host bits are set:'),
  );
}

/** Validate a rule id: non-empty, no whitespace, no `/` or `\`. */
export function validateFleetV24CidrRuleId(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) return 'Rule id must not be empty.';
  if (/\s/.test(trimmed)) return 'Rule id must not contain whitespace.';
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return 'Rule id must not contain "/" or "\\".';
  }
  if (trimmed.length > FLEET_V24_CIDR_RULE_ID_MAX) {
    return 'Rule id must be at most 128 characters.';
  }
  return null;
}

/** Validate a create-rule input; returns the first problem, or null. */
export function validateFleetV24CreateCidrRuleInput(
  input: FleetV24CreateCidrRuleInput,
): string | null {
  const idError = validateFleetV24CidrRuleId(input.id);
  if (idError !== null) return idError;
  // Host-bits input is a warning for the UI, not an error: `add` stores
  // the normalised network. Only hard errors reject the rule here.
  const cidrProblems = fleetV24CidrHardErrors(input.cidr);
  if (cidrProblems.length > 0) return cidrProblems[0];
  if (input.action !== 'allow' && input.action !== 'deny') {
    return `Rule action must be "allow" or "deny", got "${input.action}".`;
  }
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0)) {
    return 'Priority must be a non-negative integer.';
  }
  if (input.routeId !== undefined && input.routeId !== null && input.routeId.trim().length === 0) {
    return 'Route id must not be empty when given (use null for all routes).';
  }
  if (input.description !== undefined && input.description !== null && input.description.length > 500) {
    return 'Description must be at most 500 characters.';
  }
  return null;
}

/** Build a rule from a validated input (CIDR stored normalised). */
export function createFleetV24CidrRule(
  input: FleetV24CreateCidrRuleInput,
  nowMs: number,
): FleetV24CidrRule {
  const error = validateFleetV24CreateCidrRuleInput(input);
  if (error !== null) throw new Error(`Invalid CIDR rule: ${error}`);
  const parsed = parseFleetV24Cidr(input.cidr.trim()) as FleetV24ParsedCidr;
  return {
    id: input.id.trim(),
    cidr: parsed.text,
    action: input.action,
    routeId: input.routeId?.trim() ? input.routeId.trim() : null,
    priority: input.priority ?? 100,
    enabled: true,
    description: input.description?.trim() ? input.description.trim() : '',
    createdBy: input.createdBy?.trim() ? input.createdBy.trim() : 'system',
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

// -- rule set -----------------------------------------------------------------

/**
 * Live CIDR rule set for the router.
 *
 * The host creates one rule set, wires it into the router, and every
 * change goes through here so it is validated, takes effect immediately
 * for the next evaluation, and is written to the audit log. Evaluation
 * is pure: it never mutates the set.
 */
export class FleetV24CidrRuleSet {
  private rules = new Map<string, FleetV24CidrRule>();
  private audit: FleetV24CidrAuditEntry[] = [];
  private seq = 0;

  /** Default decision when no rule matches. */
  defaultAction: FleetV24CidrDefault;

  constructor(defaultAction: FleetV24CidrDefault = 'deny') {
    this.defaultAction = defaultAction;
  }

  /** Number of rules in the set. */
  get size(): number {
    return this.rules.size;
  }

  /** All rules, sorted by (prefix length desc, priority asc, id). */
  list(): FleetV24CidrRule[] {
    return [...this.rules.values()].sort(compareFleetV24Rules);
  }

  /** Look one rule up by id. */
  get(id: string): FleetV24CidrRule | undefined {
    return this.rules.get(id.trim());
  }

  /** True when a rule with this id exists. */
  has(id: string): boolean {
    return this.rules.has(id.trim());
  }

  /** Add a rule. Throws on invalid input or duplicate id. */
  add(input: FleetV24CreateCidrRuleInput, nowMs: number, actor?: string): FleetV24CidrRule {
    const rule = createFleetV24CidrRule(input, nowMs);
    if (this.rules.has(rule.id)) {
      throw new Error(`CIDR rule "${rule.id}" already exists.`);
    }
    this.rules.set(rule.id, rule);
    this.recordAudit(
      nowMs,
      rule.id,
      'create',
      actor ?? rule.createdBy,
      `${rule.action} ${rule.cidr}${rule.routeId ? ` on route ${rule.routeId}` : ' on all routes'}`,
    );
    return rule;
  }

  /** Remove a rule. Returns false when the id was not present. */
  remove(id: string, nowMs: number, actor = 'system'): boolean {
    const trimmed = id.trim();
    const rule = this.rules.get(trimmed);
    if (!rule) return false;
    this.rules.delete(trimmed);
    this.recordAudit(nowMs, trimmed, 'remove', actor, `${rule.action} ${rule.cidr} removed`);
    return true;
  }

  /** Enable a rule. Returns false when the id is unknown. */
  enable(id: string, nowMs: number, actor = 'system'): boolean {
    const rule = this.rules.get(id.trim());
    if (!rule) return false;
    if (!rule.enabled) {
      rule.enabled = true;
      rule.updatedAtMs = nowMs;
      this.recordAudit(nowMs, rule.id, 'enable', actor, `${rule.cidr} enabled`);
    }
    return true;
  }

  /** Disable a rule. Returns false when the id is unknown. */
  disable(id: string, nowMs: number, actor = 'system'): boolean {
    const rule = this.rules.get(id.trim());
    if (!rule) return false;
    if (rule.enabled) {
      rule.enabled = false;
      rule.updatedAtMs = nowMs;
      this.recordAudit(nowMs, rule.id, 'disable', actor, `${rule.cidr} disabled`);
    }
    return true;
  }

  /**
   * Update a rule's action / route / priority / description. The CIDR
   * itself is immutable — changing the range means removing the rule
   * and adding a new one, so an audit reader never has to guess which
   * range a historical entry meant. Returns null when unknown.
   */
  update(
    id: string,
    patch: {
      action?: FleetV24CidrAction;
      routeId?: string | null;
      priority?: number;
      description?: string;
    },
    nowMs: number,
    actor = 'system',
  ): FleetV24CidrRule | null {
    const rule = this.rules.get(id.trim());
    if (!rule) return null;
    const changes: string[] = [];
    if (patch.action !== undefined && patch.action !== rule.action) {
      if (patch.action !== 'allow' && patch.action !== 'deny') {
        throw new Error(`Rule action must be "allow" or "deny", got "${patch.action}".`);
      }
      changes.push(`${rule.action} → ${patch.action}`);
      rule.action = patch.action;
    }
    if (patch.routeId !== undefined) {
      const next = patch.routeId?.trim() ? patch.routeId.trim() : null;
      if (next !== rule.routeId) {
        changes.push(`route ${rule.routeId ?? 'all'} → ${next ?? 'all'}`);
        rule.routeId = next;
      }
    }
    if (patch.priority !== undefined && patch.priority !== rule.priority) {
      if (!Number.isInteger(patch.priority) || patch.priority < 0) {
        throw new Error('Priority must be a non-negative integer.');
      }
      changes.push(`priority ${rule.priority} → ${patch.priority}`);
      rule.priority = patch.priority;
    }
    if (patch.description !== undefined && patch.description !== rule.description) {
      changes.push('description updated');
      rule.description = patch.description;
    }
    if (changes.length > 0) {
      rule.updatedAtMs = nowMs;
      this.recordAudit(nowMs, rule.id, 'update', actor, changes.join('; '));
    }
    return rule;
  }

  /** Rules bound to one route (plus global rules when `includeGlobal`). */
  rulesForRoute(routeId: string, includeGlobal = true): FleetV24CidrRule[] {
    const trimmed = routeId.trim();
    return this.list().filter(
      (r) => r.routeId === trimmed || (includeGlobal && r.routeId === null),
    );
  }

  /** Routes a rule applies to: its own route, or every known route. */
  routesForRule(ruleId: string, knownRouteIds: readonly string[]): string[] {
    const rule = this.rules.get(ruleId.trim());
    if (!rule) return [];
    if (rule.routeId !== null) return [rule.routeId];
    return [...knownRouteIds].sort();
  }

  /** Enabled rules only, in evaluation order. */
  enabledRules(): FleetV24CidrRule[] {
    return this.list().filter((r) => r.enabled);
  }

  /**
   * Evaluate one (route, IP) pair.
   *
   * Matching rules are those that are enabled, whose route matches
   * (rule route == route, or rule is global), and whose CIDR contains
   * the IP. The winner is the longest prefix, then the lowest priority,
   * then deny-before-allow on a full tie. No match → default action.
   */
  evaluate(routeId: string | null, ipText: string): FleetV24CidrDecision {
    const route = routeId?.trim() ? routeId.trim() : null;
    const parsedIp = parseFleetV24Ip(ipText);
    if (parsedIp === null) {
      return {
        action: 'deny',
        ruleId: null,
        reason: `"${ipText}" is not a valid IP address; denied by default.`,
        ip: ipText.trim(),
        routeId: route,
        fromDefault: true,
      };
    }
    const ip = formatFleetV24Ip(parsedIp);
    const candidates: { rule: FleetV24CidrRule; cidr: FleetV24ParsedCidr }[] = [];
    for (const rule of this.enabledRules()) {
      if (rule.routeId !== null && rule.routeId !== route) continue;
      const cidr = parseFleetV24Cidr(rule.cidr);
      if (cidr === null) continue;
      if (ipInFleetV24Cidr(parsedIp, cidr)) candidates.push({ rule, cidr });
    }
    if (candidates.length === 0) {
      return {
        action: this.defaultAction,
        ruleId: null,
        reason: `No rule matched ${ip}; default ${this.defaultAction}.`,
        ip,
        routeId: route,
        fromDefault: true,
      };
    }
    candidates.sort((a, b) => {
      if (b.cidr.prefix !== a.cidr.prefix) return b.cidr.prefix - a.cidr.prefix;
      if (a.rule.priority !== b.rule.priority) return a.rule.priority - b.rule.priority;
      if (a.rule.action !== b.rule.action) return a.rule.action === 'deny' ? -1 : 1;
      return a.rule.id < b.rule.id ? -1 : 1;
    });
    const winner = candidates[0];
    return {
      action: winner.rule.action,
      ruleId: winner.rule.id,
      reason:
        `Rule "${winner.rule.id}" (${winner.rule.action} ${winner.rule.cidr}) matched ` +
        `${ip} with the longest prefix /${winner.cidr.prefix}.`,
      ip,
      routeId: route,
      fromDefault: false,
    };
  }

  /** Convenience: true when `evaluate` would allow this (route, IP). */
  allows(routeId: string | null, ipText: string): boolean {
    return this.evaluate(routeId, ipText).action === 'allow';
  }

  /** Detect overlapping enabled rules (warnings for the UI). */
  overlaps(): FleetV24CidrOverlap[] {
    const rules = this.enabledRules();
    const out: FleetV24CidrOverlap[] = [];
    for (let i = 0; i < rules.length; i += 1) {
      for (let j = i + 1; j < rules.length; j += 1) {
        const a = rules[i];
        const b = rules[j];
        // Rules on different routes never conflict in practice.
        if (a.routeId !== null && b.routeId !== null && a.routeId !== b.routeId) continue;
        const cidrA = parseFleetV24Cidr(a.cidr);
        const cidrB = parseFleetV24Cidr(b.cidr);
        if (cidrA === null || cidrB === null) continue;
        if (!cidrFleetV24Overlaps(cidrA, cidrB)) continue;
        const smaller = cidrA.prefix >= cidrB.prefix ? cidrA : cidrB;
        out.push({
          ruleIdA: a.id,
          ruleIdB: b.id,
          overlapCidr: smaller.text,
          conflicting: a.action !== b.action,
          detail:
            `Rules "${a.id}" (${a.action} ${a.cidr}) and "${b.id}" (${b.action} ${b.cidr}) ` +
            `overlap on ${smaller.text}${a.action !== b.action ? '; they disagree, so the more specific rule wins' : ''}.`,
        });
      }
    }
    return out;
  }

  /** Change the default decision (audited as a rule-set change). */
  setDefault(action: FleetV24CidrDefault, nowMs: number, actor = 'system'): void {
    if (action !== this.defaultAction) {
      const previous = this.defaultAction;
      this.defaultAction = action;
      this.recordAudit(nowMs, '*', 'default', actor, `default ${previous} → ${action}`);
    }
  }

  // -- audit -----------------------------------------------------------------

  private recordAudit(
    atMs: number,
    ruleId: string,
    action: string,
    actor: string,
    detail: string,
  ): void {
    this.seq += 1;
    this.audit.push({ seq: this.seq, atMs, ruleId, action, actor, detail });
    if (this.audit.length > FLEET_V24_CIDR_AUDIT_CAP) {
      this.audit.splice(0, this.audit.length - FLEET_V24_CIDR_AUDIT_CAP);
    }
  }

  /** Audit trail, newest first. Pass a limit to trim (default 100). */
  auditTrail(limit = 100): FleetV24CidrAuditEntry[] {
    return [...this.audit].reverse().slice(0, Math.max(0, limit));
  }

  /** Audit entries for one rule, newest first. */
  auditFor(ruleId: string, limit = 50): FleetV24CidrAuditEntry[] {
    const trimmed = ruleId.trim();
    return [...this.audit]
      .reverse()
      .filter((e) => e.ruleId === trimmed)
      .slice(0, Math.max(0, limit));
  }
}

/**
 * Rule sort order for display/evaluation: longest prefix first, then
 * lowest priority, then deny before allow, then id.
 */
export function compareFleetV24Rules(a: FleetV24CidrRule, b: FleetV24CidrRule): number {
  const cidrA = parseFleetV24Cidr(a.cidr);
  const cidrB = parseFleetV24Cidr(b.cidr);
  const prefixA = cidrA?.prefix ?? 0;
  const prefixB = cidrB?.prefix ?? 0;
  if (prefixB !== prefixA) return prefixB - prefixA;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.action !== b.action) return a.action === 'deny' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Create an empty CIDR rule set. */
export function createFleetV24CidrRuleSet(
  defaultAction: FleetV24CidrDefault = 'deny',
): FleetV24CidrRuleSet {
  return new FleetV24CidrRuleSet(defaultAction);
}
