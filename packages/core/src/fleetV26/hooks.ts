/**
 * Hooks v26 — deterministic lifecycle hooks for policy (v1.39, Team T6).
 *
 * Idea (from the v139 survey §2, Claude Code hooks): a hook is a
 * DETERMINISTIC side-effect at a lifecycle event — PreToolUse,
 * PostToolUse, Stop — used to enforce policy instead of hoping the
 * model behaves. A hook never asks the model anything; it matches and
 * decides.
 *
 * Events:
 * - `PreToolUse`: runs BEFORE a tool call. `deny` blocks the call
 *   (the model gets the hook's message as the reason); `ask` pauses
 *   for a human decision; `allow` lets it through.
 * - `PostToolUse`: runs AFTER a tool call. `deny` here means "flag
 *   the result + record a violation" (the call already happened — it
 *   cannot be un-run, so PostToolUse deny never pretends otherwise);
 *   `allow` just logs.
 * - `Stop`: runs when a bot tries to stop. `deny` keeps the bot
 *   working (e.g. "you have not written the summary yet"); `allow`
 *   lets it stop.
 *
 * Matching: a hook matches a tool by glob (`shell-*`, `*`, exact
 * name) and optionally by bot tag. Hooks are ordered by priority
 * (lower runs first); the FIRST deny wins and evaluation stops there
 * (deny is a wall, not a vote). Every evaluation writes one log entry
 * so policy decisions are auditable after the fact.
 */

export type FleetV26HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop';

/** What a hook decides. */
export type FleetV26HookAction = 'allow' | 'deny' | 'ask';

/** One hook definition. */
export interface FleetV26Hook {
  id: string;
  event: FleetV26HookEvent;
  /** Glob matched against the tool name (`*` = all tools). */
  toolPattern: string;
  /** Only bots carrying this tag (null = all bots). */
  botTag: string | null;
  action: FleetV26HookAction;
  /** Message returned to the bot / shown to the user. */
  message: string;
  /** Lower runs first; ties break by id. */
  priority: number;
  enabled: boolean;
  createdBy: string;
  createdAtMs: number;
}

/** The decision an evaluation produces. */
export interface FleetV26HookDecision {
  decision: FleetV26HookAction;
  /** Hooks that matched, in evaluation order. */
  matched: FleetV26Hook[];
  /** The hook that decided (first deny, else first ask, else none). */
  decidingHook: FleetV26Hook | null;
  message: string;
  evaluatedAtMs: number;
}

/** One audit entry for one evaluation. */
export interface FleetV26HookLogEntry {
  atMs: number;
  event: FleetV26HookEvent;
  toolName: string;
  botId: string;
  decision: FleetV26HookAction;
  decidingHookId: string | null;
  matchedHookIds: string[];
  message: string;
}

export const FLEET_V26_HOOK_EVENTS: readonly FleetV26HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop'];
export const FLEET_V26_HOOK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Log cap (oldest entries drop first). */
export const FLEET_V26_HOOK_LOG_MAX = 500;

/** Glob match: `*` matches any run of chars, `?` matches one char. */
export function fleetV26GlobMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(value);
}

function isHookEvent(e: unknown): e is FleetV26HookEvent {
  return e === 'PreToolUse' || e === 'PostToolUse' || e === 'Stop';
}

function isHookAction(a: unknown): a is FleetV26HookAction {
  return a === 'allow' || a === 'deny' || a === 'ask';
}

/** Registry of deterministic hooks + the evaluator. */
export class FleetV26HookRegistry {
  private hooks = new Map<string, FleetV26Hook>();
  private log: FleetV26HookLogEntry[] = [];

  /** Add a hook (validates id/event/action/pattern). */
  add(
    input: {
      id: string;
      event: FleetV26HookEvent;
      toolPattern?: string;
      botTag?: string | null;
      action: FleetV26HookAction;
      message?: string;
      priority?: number;
      createdBy?: string;
    },
    nowMs: number = Date.now(),
  ): { ok: boolean; message: string } {
    if (!FLEET_V26_HOOK_ID_RE.test(input.id)) {
      return { ok: false, message: `Hook id "${input.id}" is invalid.` };
    }
    if (this.hooks.has(input.id)) {
      return { ok: false, message: `Hook "${input.id}" already exists.` };
    }
    if (!isHookEvent(input.event)) return { ok: false, message: `Unknown hook event "${String(input.event)}".` };
    if (!isHookAction(input.action)) return { ok: false, message: `Unknown hook action "${String(input.action)}".` };
    const pattern = (input.toolPattern ?? '*').trim();
    if (!pattern) return { ok: false, message: 'Hook toolPattern must not be empty.' };
    const priority = input.priority === undefined ? 100 : Math.floor(input.priority);
    if (!Number.isFinite(priority)) return { ok: false, message: 'Hook priority must be a number.' };
    this.hooks.set(input.id, {
      id: input.id,
      event: input.event,
      toolPattern: pattern,
      botTag: input.botTag ?? null,
      action: input.action,
      message: (input.message ?? '').trim(),
      priority,
      enabled: true,
      createdBy: input.createdBy ?? 'operator',
      createdAtMs: nowMs,
    });
    return { ok: true, message: `Hook "${input.id}" added (${input.event} ${pattern} -> ${input.action}).` };
  }

  /** One hook or undefined. */
  get(id: string): FleetV26Hook | undefined {
    const h = this.hooks.get(id);
    return h ? { ...h } : undefined;
  }

  /** All hooks, priority then id. */
  list(): FleetV26Hook[] {
    return [...this.hooks.values()]
      .map((h) => ({ ...h }))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  /** Hooks for one event (enabled only, evaluation order). */
  listForEvent(event: FleetV26HookEvent): FleetV26Hook[] {
    return this.list().filter((h) => h.event === event && h.enabled);
  }

  /** Enable / disable a hook. */
  setEnabled(id: string, enabled: boolean): boolean {
    const h = this.hooks.get(id);
    if (!h) return false;
    h.enabled = enabled;
    return true;
  }

  /** Remove a hook. */
  remove(id: string): boolean {
    return this.hooks.delete(id);
  }

  /**
   * Evaluate an event: match enabled hooks (tool glob + bot tag),
   * first deny wins, else first ask wins, else allow. PostToolUse
   * `deny` is recorded as a flag (the call already ran — see the
   * module doc); the decision still says `deny` so the caller can
   * surface it, and the message says so explicitly.
   */
  evaluate(
    input: { event: FleetV26HookEvent; toolName: string; botId: string; botTags?: string[] },
    nowMs: number = Date.now(),
  ): FleetV26HookDecision {
    const matched = this.listForEvent(input.event).filter(
      (h) =>
        fleetV26GlobMatch(h.toolPattern, input.toolName) &&
        (h.botTag === null || (input.botTags ?? []).includes(h.botTag)),
    );
    const deny = matched.find((h) => h.action === 'deny') ?? null;
    const ask = matched.find((h) => h.action === 'ask') ?? null;
    let decision: FleetV26HookAction = 'allow';
    let decidingHook: FleetV26Hook | null = null;
    let message = 'No hook blocks this action.';
    if (deny) {
      decision = 'deny';
      decidingHook = deny;
      message =
        input.event === 'PostToolUse'
          ? `PostToolUse hook "${deny.id}" flagged the completed call: ${deny.message || 'policy violation recorded.'}`
          : deny.message || `Hook "${deny.id}" denies this action.`;
    } else if (ask) {
      decision = 'ask';
      decidingHook = ask;
      message = ask.message || `Hook "${ask.id}" requires a human decision.`;
    }
    const entry: FleetV26HookLogEntry = {
      atMs: nowMs,
      event: input.event,
      toolName: input.toolName,
      botId: input.botId,
      decision,
      decidingHookId: decidingHook ? decidingHook.id : null,
      matchedHookIds: matched.map((h) => h.id),
      message,
    };
    this.log.push(entry);
    if (this.log.length > FLEET_V26_HOOK_LOG_MAX) {
      this.log.splice(0, this.log.length - FLEET_V26_HOOK_LOG_MAX);
    }
    return { decision, matched, decidingHook, message, evaluatedAtMs: nowMs };
  }

  /** Evaluation log, newest first. */
  recentLog(limit = 50): FleetV26HookLogEntry[] {
    return [...this.log].reverse().slice(0, limit).map((e) => ({ ...e, matchedHookIds: [...e.matchedHookIds] }));
  }

  /** Log counts by decision. */
  logCounts(): { allow: number; deny: number; ask: number; total: number } {
    const out = { allow: 0, deny: 0, ask: 0, total: this.log.length };
    for (const e of this.log) out[e.decision] += 1;
    return out;
  }

  /** Counts for the panel. */
  counts(): { hooks: number; enabled: number; preToolUse: number; postToolUse: number; stop: number; logEntries: number } {
    const all = this.list();
    return {
      hooks: all.length,
      enabled: all.filter((h) => h.enabled).length,
      preToolUse: all.filter((h) => h.event === 'PreToolUse').length,
      postToolUse: all.filter((h) => h.event === 'PostToolUse').length,
      stop: all.filter((h) => h.event === 'Stop').length,
      logEntries: this.log.length,
    };
  }

  /** JSON round-trip (hooks + log). */
  toJSON(): { hooks: FleetV26Hook[]; log: FleetV26HookLogEntry[] } {
    return { hooks: this.list(), log: this.log.map((e) => ({ ...e, matchedHookIds: [...e.matchedHookIds] })) };
  }

  static fromJSON(data: { hooks?: FleetV26Hook[]; log?: FleetV26HookLogEntry[] }): FleetV26HookRegistry {
    const reg = new FleetV26HookRegistry();
    for (const h of data.hooks ?? []) {
      if (h && FLEET_V26_HOOK_ID_RE.test(h.id) && isHookEvent(h.event) && isHookAction(h.action)) {
        reg.hooks.set(h.id, { ...h });
      }
    }
    reg.log = (data.log ?? []).slice(-FLEET_V26_HOOK_LOG_MAX).map((e) => ({ ...e, matchedHookIds: [...(e.matchedHookIds ?? [])] }));
    return reg;
  }
}

/** One-line summary for the hooks panel. */
export function summarizeFleetV26Hooks(reg: FleetV26HookRegistry): string {
  const c = reg.counts();
  const log = reg.logCounts();
  return (
    `${c.hooks} hook(s) (${c.enabled} enabled: ${c.preToolUse} PreToolUse, ${c.postToolUse} PostToolUse, ${c.stop} Stop); ` +
    `${log.total} evaluation(s): ${log.deny} denied, ${log.ask} asked, ${log.allow} allowed`
  );
}
