/**
 * Admission v26 — admission policy + settings (v1.39, Team T6).
 *
 * Admission answers ONE question before anything new enters the
 * fleet's long-term memory or an MCP App renders: "may this come in,
 * automatically, after asking, or never?" The policy is data, not
 * code — the operator edits it in Settings, and every decision
 * carries its reasons so a denial is explainable.
 *
 * Sources (who offers the content):
 * - `memory-v24`: facts a bot wants to commit to long-term memory
 *   (memory v24 owns extraction/storage; this module owns only the
 *   GATE — auto-admit, ask, or deny — plus the evidence rule).
 * - `mcp-app`: an MCP App resource asking to render (defers to the
 *   Apps settings in `mcpApps.ts` for the server decision; this
 *   policy adds the content rules: size + blocked patterns).
 * - `skill-pack`: a skill asking to join the fleet pack.
 * - `plugin`: a plugin bundle asking to install.
 * - `operator`: the human, always allowed (recorded, not gated).
 *
 * Rules, in order:
 * 1. `blockedPatterns` (regexes) hit anywhere in the text -> deny.
 * 2. Oversize text (> `maxChars`) -> deny (never truncate silently).
 * 3. Evidence required and none supplied -> ask (memory only).
 * 4. Per-source rule (auto / ask / deny) decides.
 * 5. Default rule decides when no per-source rule exists.
 *
 * Settings are one JSON-able object with a round-trip, so the UI
 * settings panel and the tools share exactly the same shape.
 */

export type FleetV26AdmissionSource = 'memory-v24' | 'mcp-app' | 'skill-pack' | 'plugin' | 'operator';
export type FleetV26AdmissionAction = 'auto' | 'ask' | 'deny';
export type FleetV26AdmissionDecision = 'admitted' | 'ask-user' | 'denied';

/** One admission rule (per source). */
export interface FleetV26AdmissionRule {
  source: FleetV26AdmissionSource;
  action: FleetV26AdmissionAction;
  /** Human note explaining why (shown in Settings). */
  note: string;
}

/** The whole admission policy (the Settings object). */
export interface FleetV26AdmissionPolicy {
  /** Fallback when no per-source rule matches. */
  defaultAction: FleetV26AdmissionAction;
  rules: FleetV26AdmissionRule[];
  /** Memory facts need evidence attached (a source quote / link). */
  requireEvidenceForMemory: boolean;
  /** Max chars for admitted content. */
  maxChars: number;
  /** Regex sources (as strings) that always deny when they match. */
  blockedPatterns: string[];
  /** Max asks per source per day before auto-deny (spam guard). */
  maxAsksPerDay: number;
}

/** Input to one admission evaluation. */
export interface FleetV26AdmissionInput {
  source: FleetV26AdmissionSource;
  /** The content offered (fact text, skill body, bundle description...). */
  text: string;
  /** Evidence attached (memory facts), if any. */
  evidence: string | null;
  /** Who offers it (bot id or "operator"). */
  offeredBy: string;
}

/** One admission evaluation result. */
export interface FleetV26AdmissionResult {
  decision: FleetV26AdmissionDecision;
  /** The rule that decided (null = default action). */
  rule: FleetV26AdmissionRule | null;
  reasons: string[];
  evaluatedAtMs: number;
}

export const FLEET_V26_ADMISSION_SOURCES: readonly FleetV26AdmissionSource[] = [
  'memory-v24',
  'mcp-app',
  'skill-pack',
  'plugin',
  'operator',
];
export const FLEET_V26_ADMISSION_DEFAULT_MAX_CHARS = 50_000;
export const FLEET_V26_ADMISSION_DEFAULT_MAX_ASKS_PER_DAY = 20;

/** Default policy: memory asks, apps ask, skills ask, plugins ask, operator auto. */
export function defaultFleetV26AdmissionPolicy(): FleetV26AdmissionPolicy {
  return {
    defaultAction: 'ask',
    rules: [
      { source: 'memory-v24', action: 'ask', note: 'Memory facts need a human look before they become long-term.' },
      { source: 'mcp-app', action: 'ask', note: 'Apps render only after the user allows the server (see MCP Apps settings).' },
      { source: 'skill-pack', action: 'ask', note: 'New skills join the fleet pack after review.' },
      { source: 'plugin', action: 'ask', note: 'Plugin bundles install after review (checksum is checked first).' },
      { source: 'operator', action: 'auto', note: 'The operator is always admitted.' },
    ],
    requireEvidenceForMemory: true,
    maxChars: FLEET_V26_ADMISSION_DEFAULT_MAX_CHARS,
    blockedPatterns: [],
    maxAsksPerDay: FLEET_V26_ADMISSION_DEFAULT_MAX_ASKS_PER_DAY,
  };
}

/** Compile the blocked patterns (invalid ones are reported, not thrown). */
export function compileFleetV26BlockedPatterns(
  policy: FleetV26AdmissionPolicy,
): { regexes: RegExp[]; invalid: string[] } {
  const regexes: RegExp[] = [];
  const invalid: string[] = [];
  for (const p of policy.blockedPatterns) {
    try {
      regexes.push(new RegExp(p, 'i'));
    } catch {
      invalid.push(p);
    }
  }
  return { regexes, invalid };
}

/** Evaluate one admission (pure — no state, except the policy itself). */
export function evaluateFleetV26Admission(
  policy: FleetV26AdmissionPolicy,
  input: FleetV26AdmissionInput,
  nowMs: number = Date.now(),
): FleetV26AdmissionResult {
  const reasons: string[] = [];
  // 1. Blocked patterns always win.
  const { regexes } = compileFleetV26BlockedPatterns(policy);
  for (const re of regexes) {
    if (re.test(input.text)) {
      return {
        decision: 'denied',
        rule: null,
        reasons: [`Blocked pattern matched: ${re.source}.`],
        evaluatedAtMs: nowMs,
      };
    }
  }
  // 2. Oversize is denied, never truncated.
  if (input.text.length > policy.maxChars) {
    return {
      decision: 'denied',
      rule: null,
      reasons: [`Content is ${input.text.length} chars (max ${policy.maxChars}).`],
      evaluatedAtMs: nowMs,
    };
  }
  // 3. Memory facts need evidence when the policy says so.
  if (input.source === 'memory-v24' && policy.requireEvidenceForMemory && !input.evidence?.trim()) {
    reasons.push('Memory fact has no evidence attached.');
    return { decision: 'ask-user', rule: null, reasons, evaluatedAtMs: nowMs };
  }
  // 4. Per-source rule, else the default.
  const rule = policy.rules.find((r) => r.source === input.source) ?? null;
  const action = rule ? rule.action : policy.defaultAction;
  if (rule) reasons.push(`Rule for ${input.source}: ${rule.action}.`);
  else reasons.push(`No rule for ${input.source}; default: ${policy.defaultAction}.`);
  if (action === 'auto') return { decision: 'admitted', rule, reasons, evaluatedAtMs: nowMs };
  if (action === 'deny') return { decision: 'denied', rule, reasons, evaluatedAtMs: nowMs };
  return { decision: 'ask-user', rule, reasons, evaluatedAtMs: nowMs };
}

/** Store: the policy + the ask ledger (spam guard) + history. */
export class FleetV26AdmissionStore {
  private policy: FleetV26AdmissionPolicy = defaultFleetV26AdmissionPolicy();
  /** Asks per source per UTC day (for the spam guard). */
  private asks = new Map<string, number>();
  private history: FleetV26AdmissionResult[] = [];

  /** Current policy (copy). */
  getPolicy(): FleetV26AdmissionPolicy {
    return {
      ...this.policy,
      rules: this.policy.rules.map((r) => ({ ...r })),
      blockedPatterns: [...this.policy.blockedPatterns],
    };
  }

  /** Replace the policy (validates actions + patterns). */
  setPolicy(next: Partial<FleetV26AdmissionPolicy>): { ok: boolean; message: string } {
    if (next.defaultAction !== undefined && !['auto', 'ask', 'deny'].includes(next.defaultAction)) {
      return { ok: false, message: `Unknown default action "${String(next.defaultAction)}".` };
    }
    for (const r of next.rules ?? []) {
      if (!FLEET_V26_ADMISSION_SOURCES.includes(r.source)) return { ok: false, message: `Unknown source "${String(r.source)}".` };
      if (!['auto', 'ask', 'deny'].includes(r.action)) return { ok: false, message: `Unknown action "${String(r.action)}" for source "${r.source}".` };
    }
    if (next.maxChars !== undefined && (!Number.isFinite(next.maxChars) || next.maxChars <= 0)) {
      return { ok: false, message: 'maxChars must be a number > 0.' };
    }
    if (next.maxAsksPerDay !== undefined && (!Number.isFinite(next.maxAsksPerDay) || next.maxAsksPerDay < 0)) {
      return { ok: false, message: 'maxAsksPerDay must be a number >= 0.' };
    }
    const { invalid } = compileFleetV26BlockedPatterns({
      ...(next as FleetV26AdmissionPolicy),
      blockedPatterns: next.blockedPatterns ?? this.policy.blockedPatterns,
    });
    if (invalid.length > 0) {
      return { ok: false, message: `Invalid blocked pattern(s): ${invalid.join(', ')}.` };
    }
    this.policy = {
      ...this.policy,
      ...next,
      rules: next.rules ? next.rules.map((r) => ({ ...r })) : this.policy.rules,
      blockedPatterns: next.blockedPatterns ? [...next.blockedPatterns] : this.policy.blockedPatterns,
    };
    return { ok: true, message: 'Admission policy saved.' };
  }

  /** Set one per-source rule (replaces any existing rule for the source). */
  setRule(source: FleetV26AdmissionSource, action: FleetV26AdmissionAction, note = ''): { ok: boolean; message: string } {
    if (!FLEET_V26_ADMISSION_SOURCES.includes(source)) return { ok: false, message: `Unknown source "${String(source)}".` };
    if (!['auto', 'ask', 'deny'].includes(action)) return { ok: false, message: `Unknown action "${String(action)}".` };
    this.policy.rules = this.policy.rules.filter((r) => r.source !== source);
    this.policy.rules.push({ source, action, note });
    return { ok: true, message: `Rule for ${source} set to ${action}.` };
  }

  /** Evaluate + record (the spam guard turns excess asks into denies). */
  evaluate(input: FleetV26AdmissionInput, nowMs: number = Date.now()): FleetV26AdmissionResult {
    let result = evaluateFleetV26Admission(this.policy, input, nowMs);
    if (result.decision === 'ask-user') {
      const day = new Date(nowMs).toISOString().slice(0, 10);
      const key = `${day}:${input.source}`;
      const count = (this.asks.get(key) ?? 0) + 1;
      this.asks.set(key, count);
      if (count > this.policy.maxAsksPerDay) {
        result = {
          decision: 'denied',
          rule: result.rule,
          reasons: [...result.reasons, `Ask cap hit (${this.policy.maxAsksPerDay}/day for ${input.source}) — auto-denied.`],
          evaluatedAtMs: nowMs,
        };
      }
    }
    this.history.push(result);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    return result;
  }

  /** Recent evaluations, newest first. */
  recentHistory(limit = 50): FleetV26AdmissionResult[] {
    return [...this.history].reverse().slice(0, limit).map((r) => ({ ...r, reasons: [...r.reasons] }));
  }

  /** Counts by decision. */
  counts(): { admitted: number; askUser: number; denied: number; total: number } {
    const out = { admitted: 0, askUser: 0, denied: 0, total: this.history.length };
    for (const r of this.history) {
      if (r.decision === 'admitted') out.admitted += 1;
      else if (r.decision === 'ask-user') out.askUser += 1;
      else out.denied += 1;
    }
    return out;
  }

  /** JSON round-trip. */
  toJSON(): { policy: FleetV26AdmissionPolicy; history: FleetV26AdmissionResult[] } {
    return { policy: this.getPolicy(), history: this.history.map((r) => ({ ...r, reasons: [...r.reasons] })) };
  }

  static fromJSON(data: { policy?: FleetV26AdmissionPolicy; history?: FleetV26AdmissionResult[] }): FleetV26AdmissionStore {
    const store = new FleetV26AdmissionStore();
    if (data.policy) {
      const res = store.setPolicy(data.policy);
      if (!res.ok) store.policy = defaultFleetV26AdmissionPolicy();
    }
    store.history = (data.history ?? []).slice(-500).map((r) => ({ ...r, reasons: [...(r.reasons ?? [])] }));
    return store;
  }
}

/** One-line summary for the settings panel. */
export function summarizeFleetV26Admission(store: FleetV26AdmissionStore): string {
  const p = store.getPolicy();
  const c = store.counts();
  const rules = p.rules.map((r) => `${r.source}:${r.action}`).join(', ');
  return (
    `Admission (default ${p.defaultAction}; ${rules}; evidence for memory ${p.requireEvidenceForMemory ? 'required' : 'optional'}): ` +
    `${c.total} decision(s) — ${c.admitted} admitted, ${c.askUser} asked, ${c.denied} denied`
  );
}
