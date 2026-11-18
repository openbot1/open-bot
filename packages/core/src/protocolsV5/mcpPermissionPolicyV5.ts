/**
 * Per-tool permission_policy for MCP servers (v1.29, Team T2).
 *
 * Idea only, learned from the public description of Claude Agent
 * SDK 0.3.301 (see docs/repo-survey-v129.md): an MCP server can
 * carry a per-tool `permission_policy` — each tool is `allow`,
 * `deny` or `ask`, evaluated before the tool is called. This
 * module is the open-bot implementation of that behaviour, built
 * from scratch:
 *   - `McpPermissionPolicy` maps tools to decisions, with
 *     wildcard patterns (`server:*`, `*:read`, `*`) and a server
 *     default for tools with no explicit rule.
 *   - `evaluate()` runs BEFORE any transport is touched and
 *     returns a decision + a human-readable reason; `deny` and
 *     `ask` (while unanswered) never reach the server.
 *   - `ask` opens a pending decision in an `AskQueue`: the agent
 *     turn / UI resolves it (`allow-once`, `allow-always`,
 *     `deny-once`, `deny-always`); `allow-always` / `deny-always`
 *     write the rule back into the policy so the next call does
 *     not ask again.
 *   - Every evaluation is written to an audit log (who asked,
 *     what was decided, why) so a denied call is explainable
 *     after the fact.
 *   - Policies serialise to plain JSON (export / import) so a
 *     user can share or back up the rules for one server.
 *
 * Safety: a policy never grants a tool the host has not listed —
 * an unknown tool with no rule falls back to the server default,
 * and the default for a policy created with no default is `ask`,
 * never `allow`. Nothing here copies code, text or assets from
 * any other repo.
 */

/** One tool's permission decision. */
export type McpToolPermissionDecision = 'allow' | 'deny' | 'ask';
export const MCP_PERMISSION_DECISIONS: readonly McpToolPermissionDecision[] = [
  'allow',
  'deny',
  'ask',
];

/** Where a rule came from (for the audit log + UI). */
export type McpPermissionRuleSource =
  | 'explicit'
  | 'wildcard'
  | 'server-default'
  | 'ask-resolution';

/** One rule: a tool pattern -> decision. */
export interface McpPermissionRule {
  /** Tool name, or a pattern: `*`, `server:*`, `*:read`, `tool-prefix*`. */
  pattern: string;
  decision: McpToolPermissionDecision;
  /** Optional note shown in the UI (why this rule exists). */
  note?: string;
  /** Epoch ms the rule was added (0 when unknown). */
  addedAt?: number;
}

/** Result of evaluating one tool call against a policy. */
export interface McpPermissionEvaluation {
  serverName: string;
  toolName: string;
  decision: McpToolPermissionDecision;
  /** Which rule decided this (its pattern), or the server default. */
  matchedPattern: string | null;
  source: McpPermissionRuleSource;
  /** Human-readable reason, safe to show the user. */
  reason: string;
  /** When `ask`: the pending decision id the turn must resolve. */
  askId?: string;
}

/** One audit entry: every evaluation, in order. */
export interface McpPermissionAuditEntry {
  sequence: number;
  at: number;
  serverName: string;
  toolName: string;
  decision: McpToolPermissionDecision;
  source: McpPermissionRuleSource;
  matchedPattern: string | null;
  reason: string;
}

/** A pending `ask` decision waiting for the user / turn. */
export interface McpAskDecision {
  askId: string;
  serverName: string;
  toolName: string;
  createdAt: number;
  /** True once resolved (then `resolution` is set). */
  resolved: boolean;
  resolution?: 'allow-once' | 'allow-always' | 'deny-once' | 'deny-always';
  resolvedAt?: number;
}

/** Resolution the user / turn gives for a pending `ask`. */
export type McpAskResolution = 'allow-once' | 'allow-always' | 'deny-once' | 'deny-always';

/** Error raised by policy operations. */
export class McpPermissionPolicyError extends Error {
  readonly code: 'invalid-pattern' | 'invalid-decision' | 'unknown-ask' | 'already-resolved';
  constructor(message: string, code: McpPermissionPolicyError['code']) {
    super(message);
    this.name = 'McpPermissionPolicyError';
    this.code = code;
  }
}

/**
 * Match a tool name against a rule pattern. Supported patterns:
 * `*` (everything), `prefix*` (prefix match), `*suffix`
 * (suffix match), `a*b` (one interior wildcard), exact name.
 * Anything else (two wildcards, empty) is not a pattern.
 */
export function matchPermissionPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  const starCount = (pattern.match(/\*/g) ?? []).length;
  if (starCount === 0) return false;
  if (starCount > 1) return false;
  if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith('*')) return toolName.endsWith(pattern.slice(1));
  const [head, tail] = pattern.split('*');
  return toolName.startsWith(head) && toolName.endsWith(tail) && toolName.length >= head.length + tail.length;
}

/** Validate a rule pattern; throws `invalid-pattern` when unusable. */
export function validatePermissionPattern(pattern: string): void {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new McpPermissionPolicyError('Permission pattern must be a non-empty string.', 'invalid-pattern');
  }
  const stars = (pattern.match(/\*/g) ?? []).length;
  if (stars > 1) {
    throw new McpPermissionPolicyError(
      `Permission pattern "${pattern}" has more than one "*". Use at most one wildcard.`,
      'invalid-pattern',
    );
  }
  if (pattern.trim() !== pattern) {
    throw new McpPermissionPolicyError(
      `Permission pattern "${pattern}" must not have leading or trailing spaces.`,
      'invalid-pattern',
    );
  }
}

export function isMcpToolPermissionDecision(value: unknown): value is McpToolPermissionDecision {
  return value === 'allow' || value === 'deny' || value === 'ask';
}

/**
 * Specificity of a pattern, for "most specific rule wins":
 * exact names beat prefix/suffix patterns, which beat `*`.
 * Longer non-wildcard parts win ties.
 */
function patternSpecificity(pattern: string): number {
  if (pattern === '*') return 0;
  if (!pattern.includes('*')) return 1000 + pattern.length;
  return pattern.replace(/\*/g, '').length;
}

export interface McpPermissionPolicyOptions {
  serverName: string;
  /** Decision for tools with no matching rule (default `ask` — safe). */
  defaultDecision?: McpToolPermissionDecision;
  /** Initial rules. */
  rules?: McpPermissionRule[];
  /** Clock override (tests). */
  now?: () => number;
}

/**
 * One MCP server's per-tool permission policy. A policy instance
 * is cheap and serialisable; the host keeps one per server.
 */
export class McpPermissionPolicy {
  readonly serverName: string;
  private defaultDecision: McpToolPermissionDecision;
  private readonly rules: McpPermissionRule[] = [];
  private readonly audit: McpPermissionAuditEntry[] = [];
  private readonly asks = new Map<string, McpAskDecision>();
  private askCounter = 0;
  private auditCounter = 0;
  private readonly now: () => number;

  constructor(options: McpPermissionPolicyOptions) {
    this.serverName = options.serverName;
    this.defaultDecision = options.defaultDecision ?? 'ask';
    this.now = options.now ?? Date.now;
    for (const rule of options.rules ?? []) this.setRule(rule.pattern, rule.decision, rule.note);
  }

  /** The server default decision for unlisted tools. */
  getDefault(): McpToolPermissionDecision {
    return this.defaultDecision;
  }

  setDefault(decision: McpToolPermissionDecision): void {
    if (!isMcpToolPermissionDecision(decision)) {
      throw new McpPermissionPolicyError(`Unknown permission decision "${String(decision)}".`, 'invalid-decision');
    }
    this.defaultDecision = decision;
  }

  /** Add or replace one rule. Returns the stored rule. */
  setRule(pattern: string, decision: McpToolPermissionDecision, note?: string): McpPermissionRule {
    validatePermissionPattern(pattern);
    if (!isMcpToolPermissionDecision(decision)) {
      throw new McpPermissionPolicyError(`Unknown permission decision "${String(decision)}".`, 'invalid-decision');
    }
    const existing = this.rules.findIndex((r) => r.pattern === pattern);
    const rule: McpPermissionRule = { pattern, decision, addedAt: this.now() };
    if (note !== undefined) rule.note = note;
    if (existing >= 0) this.rules[existing] = rule;
    else this.rules.push(rule);
    return { ...rule };
  }

  /** Remove one rule by exact pattern. Returns true when removed. */
  removeRule(pattern: string): boolean {
    const index = this.rules.findIndex((r) => r.pattern === pattern);
    if (index < 0) return false;
    this.rules.splice(index, 1);
    return true;
  }

  /** All rules, most specific first. */
  listRules(): McpPermissionRule[] {
    return [...this.rules]
      .sort((a, b) => patternSpecificity(b.pattern) - patternSpecificity(a.pattern))
      .map((r) => ({ ...r }));
  }

  /** Find the rule that decides a tool (most specific match), or null. */
  findRule(toolName: string): McpPermissionRule | null {
    let best: McpPermissionRule | null = null;
    for (const rule of this.rules) {
      if (!matchPermissionPattern(rule.pattern, toolName)) continue;
      if (!best || patternSpecificity(rule.pattern) > patternSpecificity(best.pattern)) best = rule;
    }
    return best ? { ...best } : null;
  }

  private recordAudit(toolName: string, evaluation: Omit<McpPermissionEvaluation, 'serverName' | 'toolName'>): void {
    this.auditCounter += 1;
    this.audit.push({
      sequence: this.auditCounter,
      at: this.now(),
      serverName: this.serverName,
      toolName,
      decision: evaluation.decision,
      source: evaluation.source,
      matchedPattern: evaluation.matchedPattern,
      reason: evaluation.reason,
    });
  }

  /**
   * Evaluate one tool call — call this BEFORE any transport.
   * `allow` / `deny` are final; `ask` creates a pending decision
   * (or reuses the existing one for the same tool) and the caller
   * must resolve it before calling the server.
   */
  evaluate(toolName: string): McpPermissionEvaluation {
    const rule = this.findRule(toolName);
    if (rule) {
      const source: McpPermissionRuleSource = rule.pattern.includes('*') ? 'wildcard' : 'explicit';
      const evaluation: McpPermissionEvaluation = {
        serverName: this.serverName,
        toolName,
        decision: rule.decision,
        matchedPattern: rule.pattern,
        source,
        reason:
          rule.decision === 'allow'
            ? `Allowed by rule "${rule.pattern}"${rule.note ? `: ${rule.note}` : '.'}`
            : rule.decision === 'deny'
              ? `Denied by rule "${rule.pattern}"${rule.note ? `: ${rule.note}` : '.'}`
              : `Needs approval (rule "${rule.pattern}").`,
      };
      if (rule.decision === 'ask') {
        evaluation.askId = this.openAsk(toolName);
      }
      this.recordAudit(toolName, evaluation);
      return evaluation;
    }
    const evaluation: McpPermissionEvaluation = {
      serverName: this.serverName,
      toolName,
      decision: this.defaultDecision,
      matchedPattern: null,
      source: 'server-default',
      reason:
        this.defaultDecision === 'allow'
          ? `Allowed by the server default (no rule lists "${toolName}").`
          : this.defaultDecision === 'deny'
            ? `Denied by the server default (no rule lists "${toolName}").`
            : `Needs approval (no rule lists "${toolName}"; server default is ask).`,
    };
    if (this.defaultDecision === 'ask') evaluation.askId = this.openAsk(toolName);
    this.recordAudit(toolName, evaluation);
    return evaluation;
  }

  /** Convenience: true only when `evaluate()` would say `allow`. */
  allows(toolName: string): boolean {
    return this.evaluate(toolName).decision === 'allow';
  }

  private openAsk(toolName: string): string {
    for (const ask of this.asks.values()) {
      if (ask.toolName === toolName && !ask.resolved) return ask.askId;
    }
    this.askCounter += 1;
    const askId = `ask-${this.serverName}-${this.askCounter}`;
    this.asks.set(askId, {
      askId,
      serverName: this.serverName,
      toolName,
      createdAt: this.now(),
      resolved: false,
    });
    return askId;
  }

  /** One pending decision, or undefined. */
  getAsk(askId: string): McpAskDecision | undefined {
    const ask = this.asks.get(askId);
    return ask ? { ...ask } : undefined;
  }

  /** All pending (unresolved) `ask` decisions, oldest first. */
  listPendingAsks(): McpAskDecision[] {
    return [...this.asks.values()]
      .filter((a) => !a.resolved)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => ({ ...a }));
  }

  /**
   * Resolve a pending `ask`. `allow-always` / `deny-always` write
   * the rule back into the policy (exact tool name) so the next
   * call does not ask again; `allow-once` / `deny-once` answer
   * just this call. Returns the resolved decision.
   */
  resolveAsk(askId: string, resolution: McpAskResolution): McpAskDecision {
    const ask = this.asks.get(askId);
    if (!ask) {
      throw new McpPermissionPolicyError(`Unknown permission request "${askId}".`, 'unknown-ask');
    }
    if (ask.resolved) {
      throw new McpPermissionPolicyError(`Permission request "${askId}" is already resolved.`, 'already-resolved');
    }
    ask.resolved = true;
    ask.resolution = resolution;
    ask.resolvedAt = this.now();
    if (resolution === 'allow-always') this.setRule(ask.toolName, 'allow', `Allowed always (resolved ${askId}).`);
    if (resolution === 'deny-always') this.setRule(ask.toolName, 'deny', `Denied always (resolved ${askId}).`);
    this.recordAudit(ask.toolName, {
      decision: resolution.startsWith('allow') ? 'allow' : 'deny',
      matchedPattern: resolution.endsWith('always') ? ask.toolName : null,
      source: 'ask-resolution',
      reason: `User resolved ${askId} as ${resolution}.`,
    });
    return { ...ask };
  }

  /** Audit log, oldest first (a copy). */
  auditLog(): McpPermissionAuditEntry[] {
    return this.audit.map((e) => ({ ...e }));
  }

  /** Audit entries for one tool only. */
  auditForTool(toolName: string): McpPermissionAuditEntry[] {
    return this.audit.filter((e) => e.toolName === toolName).map((e) => ({ ...e }));
  }

  /** Serialise the policy (rules + default) to plain JSON. */
  toJSON(): { serverName: string; defaultDecision: McpToolPermissionDecision; rules: McpPermissionRule[] } {
    return {
      serverName: this.serverName,
      defaultDecision: this.defaultDecision,
      rules: this.listRules(),
    };
  }

  /** Rebuild a policy from `toJSON()` output. Unknown fields are ignored. */
  static fromJSON(data: unknown): McpPermissionPolicy {
    if (!data || typeof data !== 'object') {
      throw new McpPermissionPolicyError('Permission policy JSON must be an object.', 'invalid-decision');
    }
    const d = data as { serverName?: unknown; defaultDecision?: unknown; rules?: unknown };
    if (typeof d.serverName !== 'string' || d.serverName.length === 0) {
      throw new McpPermissionPolicyError('Permission policy JSON needs a non-empty serverName.', 'invalid-decision');
    }
    const policy = new McpPermissionPolicy({
      serverName: d.serverName,
      defaultDecision: isMcpToolPermissionDecision(d.defaultDecision) ? d.defaultDecision : 'ask',
    });
    if (Array.isArray(d.rules)) {
      for (const raw of d.rules) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as { pattern?: unknown; decision?: unknown; note?: unknown };
        if (typeof r.pattern !== 'string' || !isMcpToolPermissionDecision(r.decision)) continue;
        policy.setRule(r.pattern, r.decision, typeof r.note === 'string' ? r.note : undefined);
      }
    }
    return policy;
  }
}

/** A registry of one policy per MCP server. */
export class McpPermissionPolicyRegistry {
  private readonly policies = new Map<string, McpPermissionPolicy>();

  /** Get or create the policy for a server (default `ask`). */
  policyFor(serverName: string, defaultDecision?: McpToolPermissionDecision): McpPermissionPolicy {
    let policy = this.policies.get(serverName);
    if (!policy) {
      policy = new McpPermissionPolicy({ serverName, defaultDecision });
      this.policies.set(serverName, policy);
    }
    return policy;
  }

  has(serverName: string): boolean {
    return this.policies.has(serverName);
  }

  serverNames(): string[] {
    return [...this.policies.keys()].sort();
  }

  /** Evaluate a call against its server's policy (creating it when needed). */
  evaluate(serverName: string, toolName: string): McpPermissionEvaluation {
    return this.policyFor(serverName).evaluate(toolName);
  }

  /** All pending asks across all servers, oldest first. */
  listAllPendingAsks(): McpAskDecision[] {
    return [...this.policies.values()]
      .flatMap((p) => p.listPendingAsks())
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}
