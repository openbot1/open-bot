/**
 * Missing-pattern supplements (v1.03, Team T3).
 *
 * The harness audit (`harnessAudit.ts`) finds four of the 29
 * Harness Engineering patterns only partially present in open-bot:
 * stuck detection, security review, sub-agent delegation and
 * context compaction. The *engines* that own those behaviours live
 * elsewhere (T1's harness engine v2 owns the loop, the condenser and
 * the stuck detector; the permission broker owns approvals) — so
 * this module does NOT re-implement them. Instead it defines the
 * narrow interfaces those engines can be driven through, plus small
 * reference implementations that are pure functions over turn
 * records (no I/O, no model calls, no shared state):
 *
 * - `StuckDetector` — "is this run stuck?" from the turn history.
 * - `SecurityReviewer` — "may this tool call run?" before execution.
 * - `SubAgentDelegator` — "run this subtask on a hosted ACP backend".
 * - `CompactionAdvisor` — "should the context be compacted now?"
 *
 * An agent loop can wire all four in a dozen lines: ask the
 * detector after every turn, ask the reviewer before every tool
 * call, delegate through the host, ask the advisor before growing
 * the context. The implementations here are deliberately
 * conservative (fail-closed, deterministic, threshold-based) so
 * they are safe defaults until the owning engines replace them.
 */

import type { AcpHost, AcpHostPromptResult } from './hosting';

// ---------------------------------------------------------------------------
// Shared turn record (the only input the detectors need)
// ---------------------------------------------------------------------------

export interface TurnRecord {
  /** Sequential turn number within the run. */
  turn: number;
  /** Tool calls made this turn: `{ tool, signature }` where the signature is a stable hash/summary of the call's arguments (never the raw values). */
  toolCalls: Array<{ tool: string; signature: string }>;
  /** Whether the turn changed any file / produced new output. */
  madeProgress: boolean;
  /** Tokens spent this turn (when known). */
  tokensUsed?: number;
  /** Text the agent produced this turn (truncated by the caller). */
  text?: string;
}

export interface StuckVerdict {
  stuck: boolean;
  /** Machine-readable reason (`repeated-tool-call`, `no-progress`, `token-burn`, `none`). */
  reason: string;
  /** Human-readable detail for the log / UI. */
  detail: string;
  /** What the loop should do next (`continue`, `nudge`, `stop`, `escalate`). */
  suggestedAction: 'continue' | 'nudge' | 'stop' | 'escalate';
}

/** Decides whether a run is stuck, from its turn history. */
export interface StuckDetector {
  /** Inspect the whole history; returns a verdict for the latest turn. */
  check(history: TurnRecord[]): StuckVerdict;
}

export interface SignatureStuckDetectorOptions {
  /** Same tool+signature this many turns in a row = stuck (default 3). */
  repeatThreshold?: number;
  /** Turns without progress in a row = stuck (default 4). */
  noProgressThreshold?: number;
  /** Tokens spent without progress = stuck (default 60_000). */
  tokenBurnThreshold?: number;
}

/**
 * Threshold-based stuck detector (pure function, no I/O).
 *
 * Three independent signals, checked in order — any one firing
 * means stuck:
 * 1. **Repeated tool call**: the same tool with the same argument
 *    signature N turns in a row (the loop is retrying the exact
 *    same failing call instead of trying something else).
 * 2. **No progress**: N turns in a row with `madeProgress: false`.
 * 3. **Token burn**: tokens spent since the last progressing turn
 *    exceed the budget (the run is thinking in circles).
 */
export class SignatureStuckDetector implements StuckDetector {
  private readonly repeatThreshold: number;
  private readonly noProgressThreshold: number;
  private readonly tokenBurnThreshold: number;

  constructor(options: SignatureStuckDetectorOptions = {}) {
    this.repeatThreshold = options.repeatThreshold ?? 3;
    this.noProgressThreshold = options.noProgressThreshold ?? 4;
    this.tokenBurnThreshold = options.tokenBurnThreshold ?? 60_000;
  }

  check(history: TurnRecord[]): StuckVerdict {
    const none: StuckVerdict = {
      stuck: false,
      reason: 'none',
      detail: 'no stuck signal in the turn history',
      suggestedAction: 'continue',
    };
    if (history.length === 0) return none;

    // 1. Repeated identical tool call.
    const last = history[history.length - 1];
    if (last.toolCalls.length > 0) {
      const sig = last.toolCalls.map((c) => `${c.tool}:${c.signature}`).join('|');
      let run = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        const turnSig = history[i].toolCalls.map((c) => `${c.tool}:${c.signature}`).join('|');
        if (turnSig === sig && turnSig.length > 0) run += 1;
        else break;
      }
      if (run >= this.repeatThreshold) {
        return {
          stuck: true,
          reason: 'repeated-tool-call',
          detail: `same tool call ${run} turns in a row (${sig.slice(0, 120)})`,
          suggestedAction: run >= this.repeatThreshold + 2 ? 'stop' : 'nudge',
        };
      }
    }

    // 2. No progress for N turns.
    let noProgressRun = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (!history[i].madeProgress) noProgressRun += 1;
      else break;
    }
    if (noProgressRun >= this.noProgressThreshold) {
      return {
        stuck: true,
        reason: 'no-progress',
        detail: `${noProgressRun} turns without progress`,
        suggestedAction: noProgressRun >= this.noProgressThreshold + 2 ? 'escalate' : 'nudge',
      };
    }

    // 3. Token burn since last progress.
    let tokensSinceProgress = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].madeProgress) break;
      tokensSinceProgress += history[i].tokensUsed ?? 0;
    }
    if (tokensSinceProgress >= this.tokenBurnThreshold) {
      return {
        stuck: true,
        reason: 'token-burn',
        detail: `${tokensSinceProgress} tokens spent since the last progressing turn`,
        suggestedAction: 'escalate',
      };
    }
    return none;
  }
}

// ---------------------------------------------------------------------------
// Security review (pre-tool-call hook)
// ---------------------------------------------------------------------------

export interface ToolCallToReview {
  tool: string;
  /** Argument names only (never values) — the reviewer must not need secrets to judge. */
  argNames: string[];
  /** The raw command / path / URL when the tool carries one (may be redacted by the caller). */
  rawInput?: string;
}

export interface SecurityVerdict {
  decision: 'allow' | 'deny' | 'review';
  reasons: string[];
}

/** Pre-execution security review for one tool call. */
export interface SecurityReviewer {
  review(call: ToolCallToReview): SecurityVerdict;
}

export interface DenyListSecurityReviewerOptions {
  /** Extra deny patterns (regex sources) on top of the built-ins. */
  extraDenyPatterns?: Array<{ pattern: string; reason: string }>;
  /** Tools that always need a human (`review`), even when clean. */
  reviewTools?: string[];
}

/** Default deny patterns (shell-dangerous shapes, not secrets). */
export const DEFAULT_DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: 'recursive force delete (rm -rf)' },
  { pattern: /\bmkfs\b|\bdd\s+.*\bof=\/dev\//i, reason: 'disk-destructive command (mkfs/dd to a device)' },
  { pattern: /\|\s*(sh|bash|zsh)\s*$/i, reason: 'piping downloaded content straight into a shell' },
  { pattern: /\bcurl\b.*\|\s*(sh|bash)/i, reason: 'curl piped into a shell' },
  { pattern: /\bwget\b.*\|\s*(sh|bash)/i, reason: 'wget piped into a shell' },
  { pattern: /\b(chmod|chown)\s+(-R\s+)?777\b/i, reason: 'world-writable permission change (777)' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: 'fork bomb' },
  { pattern: /\b(base64\s+-d|openssl\s+enc\s+-d)\b.*\|\s*(sh|bash)/i, reason: 'decoded payload piped into a shell' },
  { pattern: /\b(env|printenv)\b.*\b(grep|head)\b/i, reason: 'environment/secret dumping shape' },
  { pattern: /\/\.ssh\/|\/\.aws\/|\.pem\b/i, reason: 'credential-file path access' },
];

/**
 * Deny-list reviewer: denies on a built-in dangerous-command shape,
 * sends listed tools to human review, allows everything else. The
 * list is a backstop, not a sandbox — the permission broker stays
 * the authority for approvals, and this reviewer never approves a
 * call the broker would deny.
 */
export class DenyListSecurityReviewer implements SecurityReviewer {
  private readonly denyPatterns: Array<{ pattern: RegExp; reason: string }>;
  private readonly reviewTools: Set<string>;

  constructor(options: DenyListSecurityReviewerOptions = {}) {
    this.denyPatterns = [...DEFAULT_DENY_PATTERNS];
    for (const extra of options.extraDenyPatterns ?? []) {
      try {
        this.denyPatterns.push({ pattern: new RegExp(extra.pattern, 'i'), reason: extra.reason });
      } catch {
        // An invalid extra pattern is ignored (never breaks review).
      }
    }
    this.reviewTools = new Set((options.reviewTools ?? ['shell_exec', 'run_shell', 'execute_command']).map((t) => t.toLowerCase()));
  }

  review(call: ToolCallToReview): SecurityVerdict {
    const reasons: string[] = [];
    const input = call.rawInput ?? '';
    for (const { pattern, reason } of this.denyPatterns) {
      if (pattern.test(input)) reasons.push(reason);
    }
    if (reasons.length > 0) return { decision: 'deny', reasons };
    if (this.reviewTools.has(call.tool.toLowerCase())) {
      return { decision: 'review', reasons: [`tool "${call.tool}" always needs human review`] };
    }
    return { decision: 'allow', reasons: [] };
  }
}

// ---------------------------------------------------------------------------
// Sub-agent delegation (through the hosted ACP backend)
// ---------------------------------------------------------------------------

export interface DelegationRequest {
  /** Which hosted backend runs the subtask (see `backends.ts`). */
  backendId: string;
  /** Absolute working directory for the subtask's session. */
  cwd: string;
  /** The subtask, as one prompt. */
  task: string;
  /** Abort the delegation. */
  signal?: AbortSignal;
  /** Give up after this long (the backend process is left alone — only the wait ends). */
  timeoutMs?: number;
}

export interface DelegationResult {
  backendId: string;
  text: string;
  stopReason: AcpHostPromptResult['stopReason'];
  toolCalls: string[];
}

/** Runs a subtask on another agent and returns its result. */
export interface SubAgentDelegator {
  delegate(request: DelegationRequest): Promise<DelegationResult>;
}

/**
 * ACP-backed delegator: one subtask = one prompt turn on a hosted
 * ACP backend (`AcpHost`). The subtask runs in the backend's own
 * session (per cwd), so the parent loop's context never grows with
 * the subtask's working — only the result text comes back.
 */
export class AcpSubAgentDelegator implements SubAgentDelegator {
  constructor(private readonly host: AcpHost) {}

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const result = await this.host.prompt(request.backendId, request.cwd, request.task, {
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    });
    return {
      backendId: result.backendId,
      text: result.text,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
    };
  }
}

// ---------------------------------------------------------------------------
// Context compaction advisor (advisory only — T1's condenser compacts)
// ---------------------------------------------------------------------------

export interface ContextState {
  /** Tokens currently in the context window. */
  usedTokens: number;
  /** Total context window of the model. */
  contextLimitTokens: number;
  /** Turns since the last compaction (0 = never compacted). */
  turnsSinceCompaction: number;
}

export interface CompactionAdvice {
  /** True when the loop should compact before the next turn. */
  shouldCompact: boolean;
  /** Fraction of the window used (0..1+). */
  usageRatio: number;
  reason: string;
}

/** Decides *when* to compact; the condenser decides *how*. */
export interface CompactionAdvisor {
  advise(state: ContextState): CompactionAdvice;
}

export interface ThresholdCompactionAdvisorOptions {
  /** Compact at/above this usage ratio (default 0.8). */
  usageThreshold?: number;
  /** Compact at/above this many turns since the last compaction (default 25). */
  turnsThreshold?: number;
}

/**
 * Threshold advisor. Pure function, no I/O: the caller owns the
 * actual compaction (T1's condenser) and reports
 * `turnsSinceCompaction: 0` after compacting. No hysteresis is
 * needed: right after a compaction the caller reports low usage and
 * 0 turns since compaction, so neither trigger can re-fire
 * immediately.
 */
export class ThresholdCompactionAdvisor implements CompactionAdvisor {
  private readonly usageThreshold: number;
  private readonly turnsThreshold: number;

  constructor(options: ThresholdCompactionAdvisorOptions = {}) {
    this.usageThreshold = options.usageThreshold ?? 0.8;
    this.turnsThreshold = options.turnsThreshold ?? 25;
  }

  advise(state: ContextState): CompactionAdvice {
    const usageRatio = state.contextLimitTokens > 0 ? state.usedTokens / state.contextLimitTokens : 0;
    if (usageRatio >= this.usageThreshold) {
      return {
        shouldCompact: true,
        usageRatio,
        reason: `context ${(usageRatio * 100).toFixed(0)}% full (threshold ${(this.usageThreshold * 100).toFixed(0)}%)`,
      };
    }
    if (state.turnsSinceCompaction >= this.turnsThreshold) {
      return {
        shouldCompact: true,
        usageRatio,
        reason: `${state.turnsSinceCompaction} turns since the last compaction (threshold ${this.turnsThreshold})`,
      };
    }
    return { shouldCompact: false, usageRatio, reason: 'context usage and turn count are within budget' };
  }
}
