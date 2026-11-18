/**
 * Resume orchestrator v20 (voice v20, v1.29 Team T5).
 *
 * The v20 pipeline could already resume a cut reply — but only
 * one way (`resumeAfterCut`: resume / restart / drop), only
 * once, and only inside the live process. A real call drops
 * more than once, and the *choice* of how to continue matters
 * as much as the mechanics: restarting a sentence the user
 * already half-heard is annoying, resuming a 500-char remainder
 * after a long silence is confusing, and dropping without
 * telling the user loses information. This module decides and
 * tracks the whole resume lifecycle:
 *
 *   1. Decision. `decideResumeV20` picks an action from the cut
 *      shape alone: nothing heard yet → restart; a short tail
 *      remains → resume; a long remainder remains → summarise
 *      (speak a compressed version, not the whole tail); the
 *      user already confirmed an action → honour it. Thresholds
 *      are options, not magic numbers, and every decision
 *      carries a human-readable reason.
 *   2. Prosody carry-over. A resumed reply does not restart
 *      flat: the last prosody plan at the cut is carried across
 *      (`carryProsodyV20`) and the continuation chunks are
 *      re-planned from the remaining text, so pitch and rate
 *      continue where they were cut.
 *   3. Multi-drop resilience. Each session tracks consecutive
 *      drops and resume attempts; after `maxAttempts` failed
 *      resumes (or `maxConsecutiveDrops` drops in a row) the
 *      orchestrator stops offering resume and says so plainly
 *      — endless re-tries are worse than a clean restart. The
 *      backoff between attempts reuses the reconnect manager's
 *      `backoffDelayMsV20` so resume pacing matches the
 *      network recovery pacing.
 *   4. Audit. Every interrupt, plan, confirmation and applied
 *      resume is an event in the session log, with stats and a
 *      markdown rendering for the panel.
 *
 * Pure decision + state, virtual clock, mock audio only. The
 * orchestrator never speaks by itself — it hands the caller the
 * exact text (and planned chunks) to speak next.
 */
import { ProsodyTtsV20, type TtsV20Chunk } from './ttsProsodyV20';
import { carryProsodyV20, interruptSentenceV20 } from './openTurnV20';
import { backoffDelayMsV20, defaultReconnectV20Options, type ReconnectV20Options } from './reconnectV20';
import type { TurnResumeV19Action, TurnResumeV19InterruptReason } from '../voiceV19/turnResumeV19';
import type { TtsV20ProsodyPlan } from './ttsProsodyV20';

export type ResumeV20Action = TurnResumeV19Action;

export interface ResumeV20Interrupt {
  sessionId: string;
  turnId: string;
  /** Full agent reply text that was being spoken. */
  replyText: string;
  /** Chars already spoken when the cut landed. */
  spokenChars: number;
  reason: TurnResumeV19InterruptReason;
  /** Prosody plan of the last spoken chunk (carry-over). */
  lastProsodyPlan?: TtsV20ProsodyPlan;
  /** Planned chunks of the reply (for word-boundary splitting). */
  chunks?: TtsV20Chunk[];
  atMs: number;
}

export interface ResumeV20Plan {
  sessionId: string;
  turnId: string;
  action: ResumeV20Action;
  /** Text to speak next ('' for drop). */
  speakText: string;
  /** Compressed version of the remainder (only for summarise). */
  summary: string;
  /** Chars of the reply that will never be spoken. */
  droppedChars: number;
  /** Chars that remain unspoken after this plan. */
  remainingChars: number;
  /** Prosody plan carried across the cut. */
  carriedProsody?: TtsV20ProsodyPlan;
  /** Planned TTS chunks for speakText ('' when nothing to speak). */
  speakChunks: TtsV20Chunk[];
  reason: string;
  /** Which attempt this plan is for (1-based). */
  attempt: number;
}

export interface ResumeV20Options {
  /** Tail at or below this many chars → just resume it. */
  resumeMaxTailChars: number;
  /** Remainder at or above this many chars → summarise it. */
  summariseMinChars: number;
  /** Max resume attempts per interrupt. */
  maxAttempts: number;
  /** Max consecutive drops before resume is refused. */
  maxConsecutiveDrops: number;
  /** Reconnect options reused for the attempt backoff. */
  reconnect: Partial<ReconnectV20Options>;
}

export function defaultResumeV20Options(): ResumeV20Options {
  return {
    resumeMaxTailChars: 20,
    // A remainder past ~100 chars is worth summarising instead of
    // resuming verbatim (400 made summarise unreachable for normal
    // voice replies, which are rarely that long).
    summariseMinChars: 100,
    maxAttempts: 3,
    maxConsecutiveDrops: 3,
    reconnect: {},
  };
}

export function validateResumeV20Options(o: Partial<ResumeV20Options>): string[] {
  const e: string[] = [];
  if (o.resumeMaxTailChars !== undefined && o.resumeMaxTailChars < 0) e.push('resumeMaxTailChars must be >= 0');
  if (o.summariseMinChars !== undefined && o.summariseMinChars < 1) e.push('summariseMinChars must be >= 1');
  if (o.maxAttempts !== undefined && o.maxAttempts < 1) e.push('maxAttempts must be >= 1');
  if (o.maxConsecutiveDrops !== undefined && o.maxConsecutiveDrops < 1) e.push('maxConsecutiveDrops must be >= 1');
  if (o.resumeMaxTailChars !== undefined && o.summariseMinChars !== undefined && o.summariseMinChars <= o.resumeMaxTailChars) {
    e.push('summariseMinChars must be > resumeMaxTailChars');
  }
  return e;
}

/** Compress a long remainder: first sentence + last sentence, capped. */
export function summariseRemainingV20(remainingText: string, maxChars = 200): string {
  const text = remainingText.trim();
  if (text === '') return '';
  if (text.length <= maxChars) return text;
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const clean = sentences.map((s) => s.trim()).filter((s) => s !== '');
  if (clean.length <= 1) {
    const cut = text.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()}…`;
  }
  const first = clean[0] ?? '';
  const last = clean[clean.length - 1] ?? '';
  const joined = first === last ? first : `${first} … ${last}`;
  if (joined.length <= maxChars) return joined;
  const cut = joined.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export interface ResumeV20DecisionInput {
  replyText: string;
  spokenChars: number;
  /** Explicit user choice overrides the automatic decision. */
  userAction?: ResumeV20Action;
  /** Remaining text after a word-boundary cut (computed when omitted). */
  remainingText?: string;
  lastProsodyPlan?: TtsV20ProsodyPlan;
}

/** Decide how a cut reply continues (pure function). */
export function decideResumeV20(
  input: ResumeV20DecisionInput,
  opts: Partial<ResumeV20Options> = {},
): { action: ResumeV20Action; speakText: string; summary: string; droppedChars: number; remainingChars: number; reason: string } {
  const o = { ...defaultResumeV20Options(), ...opts };
  const full = input.replyText;
  const spoken = Math.max(0, Math.min(full.length, input.spokenChars));
  const remaining = input.remainingText ?? full.slice(spoken).trimStart();
  const remainingChars = remaining.length;
  const droppedChars = full.length - spoken;
  if (input.userAction) {
    if (input.userAction === 'drop') {
      return { action: 'drop', speakText: '', summary: '', droppedChars, remainingChars, reason: 'user chose to drop the remainder' };
    }
    if (input.userAction === 'restart') {
      return { action: 'restart', speakText: full, summary: '', droppedChars: 0, remainingChars: full.length, reason: 'user chose to restart the reply' };
    }
    if (input.userAction === 'summarise') {
      const summary = summariseRemainingV20(remaining);
      return { action: 'summarise', speakText: summary, summary, droppedChars, remainingChars, reason: 'user chose a summary of the remainder' };
    }
    return { action: 'resume', speakText: remaining, summary: '', droppedChars, remainingChars, reason: 'user chose to resume the remainder' };
  }
  if (spoken === 0) {
    return { action: 'restart', speakText: full, summary: '', droppedChars: 0, remainingChars: full.length, reason: 'nothing was heard yet — restart from the beginning' };
  }
  if (remainingChars === 0) {
    return { action: 'drop', speakText: '', summary: '', droppedChars: 0, remainingChars: 0, reason: 'reply was fully spoken — nothing to resume' };
  }
  if (remainingChars <= o.resumeMaxTailChars) {
    return { action: 'resume', speakText: remaining, summary: '', droppedChars, remainingChars, reason: `short tail (${remainingChars} chars) — resume it` };
  }
  if (remainingChars >= o.summariseMinChars) {
    const summary = summariseRemainingV20(remaining);
    return { action: 'summarise', speakText: summary, summary, droppedChars, remainingChars, reason: `long remainder (${remainingChars} chars) — summarise instead of resuming it all` };
  }
  return { action: 'resume', speakText: remaining, summary: '', droppedChars, remainingChars, reason: `remainder (${remainingChars} chars) — resume from the cut point` };
}

export interface ResumeV20SessionState {
  sessionId: string;
  interrupts: number;
  attempts: number;
  consecutiveDrops: number;
  resumes: number;
  restarts: number;
  summaries: number;
  drops: number;
  lastInterruptAtMs: number | null;
  lastPlan: ResumeV20Plan | null;
}

export interface ResumeV20Event {
  kind: 'interrupt' | 'plan' | 'confirm' | 'applied' | 'refused';
  atMs: number;
  sessionId: string;
  detail: Record<string, unknown>;
}

export type ResumeV20EventSink = (event: ResumeV20Event) => void;

export interface ResumeV20Stats {
  sessions: number;
  interrupts: number;
  plans: number;
  applied: number;
  refused: number;
  resumes: number;
  restarts: number;
  summaries: number;
  drops: number;
}

/** Stateful resume orchestrator: one per app (many sessions). */
export class ResumeOrchestratorV20 {
  private opts: ResumeV20Options;
  private reconnectOpts: ReconnectV20Options;
  private tts: ProsodyTtsV20;
  private sink?: ResumeV20EventSink;
  private sessions = new Map<string, ResumeV20SessionState>();
  private pending = new Map<string, ResumeV20Interrupt>();
  private events: ResumeV20Event[] = [];
  private stats: ResumeV20Stats = {
    sessions: 0, interrupts: 0, plans: 0, applied: 0, refused: 0,
    resumes: 0, restarts: 0, summaries: 0, drops: 0,
  };

  constructor(opts: Partial<ResumeV20Options> = {}, sink?: ResumeV20EventSink) {
    this.opts = { ...defaultResumeV20Options(), ...opts };
    this.reconnectOpts = { ...defaultReconnectV20Options(), ...this.opts.reconnect };
    this.tts = new ProsodyTtsV20();
    this.sink = sink;
  }

  private emit(e: ResumeV20Event): void {
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    this.sink?.(e);
  }

  private stateFor(sessionId: string): ResumeV20SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId, interrupts: 0, attempts: 0, consecutiveDrops: 0,
        resumes: 0, restarts: 0, summaries: 0, drops: 0,
        lastInterruptAtMs: null, lastPlan: null,
      };
      this.sessions.set(sessionId, s);
      this.stats.sessions = this.sessions.size;
    }
    return s;
  }

  getEvents(): ResumeV20Event[] { return [...this.events]; }
  getStats(): ResumeV20Stats { return { ...this.stats }; }
  getSessionState(sessionId: string): ResumeV20SessionState | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { ...s, lastPlan: s.lastPlan ? { ...s.lastPlan } : null } : undefined;
  }

  /** Backoff before the next resume attempt (ms, virtual). */
  nextBackoffMs(sessionId: string): number {
    const s = this.stateFor(sessionId);
    return backoffDelayMsV20(this.reconnectOpts, Math.max(0, s.attempts - 1));
  }

  /** Can this session be offered another resume? */
  canResume(sessionId: string): { ok: boolean; reason: string } {
    const s = this.stateFor(sessionId);
    if (s.attempts >= this.opts.maxAttempts) {
      return { ok: false, reason: `attempt budget exhausted (${s.attempts}/${this.opts.maxAttempts})` };
    }
    if (s.consecutiveDrops >= this.opts.maxConsecutiveDrops) {
      return { ok: false, reason: `too many consecutive drops (${s.consecutiveDrops}/${this.opts.maxConsecutiveDrops})` };
    }
    return { ok: true, reason: 'resume available' };
  }

  /** Record an interruption (cut / network-lost / crash / timeout). */
  interrupt(input: ResumeV20Interrupt): ResumeV20SessionState {
    const s = this.stateFor(input.sessionId);
    s.interrupts += 1;
    s.lastInterruptAtMs = input.atMs;
    this.stats.interrupts += 1;
    this.pending.set(input.sessionId, input);
    this.emit({
      kind: 'interrupt', atMs: input.atMs, sessionId: input.sessionId,
      detail: { turnId: input.turnId, reason: input.reason, spokenChars: input.spokenChars },
    });
    return this.getSessionState(input.sessionId) as ResumeV20SessionState;
  }

  /** Plan the continuation for a pending interrupt (auto or user-picked). */
  plan(sessionId: string, userAction?: ResumeV20Action, atMs = 0): ResumeV20Plan | null {
    const pending = this.pending.get(sessionId);
    if (!pending) return null;
    const gate = this.canResume(sessionId);
    const s = this.stateFor(sessionId);
    if (!gate.ok && !userAction) {
      this.stats.refused += 1;
      this.emit({ kind: 'refused', atMs, sessionId, detail: { reason: gate.reason } });
      return null;
    }
    // Split at a word boundary when chunks are available.
    let remainingText: string | undefined;
    if (pending.chunks) {
      const cut = interruptSentenceV20(pending.chunks, pending.spokenChars);
      remainingText = cut.remainingText;
    }
    const decision = decideResumeV20(
      {
        replyText: pending.replyText,
        spokenChars: pending.spokenChars,
        userAction,
        remainingText,
        lastProsodyPlan: pending.lastProsodyPlan,
      },
      this.opts,
    );
    const carried = pending.lastProsodyPlan
      ? carryProsodyV20(pending.lastProsodyPlan, decision.speakText)
      : undefined;
    const speakChunks = decision.speakText === '' ? [] : this.tts.plan(decision.speakText);
    // Re-apply the carried plan to the first chunk so the resumed
    // reply continues the cut pitch instead of restarting flat.
    if (carried && speakChunks.length > 0 && speakChunks[0]!.kind === 'speech') {
      speakChunks[0] = { ...speakChunks[0]!, prosody: { ...speakChunks[0]!.prosody, rate: carried.rate, pitchSt: carried.pitchSt } };
    }
    s.attempts += 1;
    const plan: ResumeV20Plan = {
      sessionId,
      turnId: pending.turnId,
      action: decision.action,
      speakText: decision.speakText,
      summary: decision.summary,
      droppedChars: decision.droppedChars,
      remainingChars: decision.remainingChars,
      ...(carried ? { carriedProsody: carried } : {}),
      speakChunks,
      reason: decision.reason,
      attempt: s.attempts,
    };
    s.lastPlan = plan;
    this.stats.plans += 1;
    this.emit({ kind: 'plan', atMs, sessionId, detail: { action: plan.action, attempt: plan.attempt, reason: plan.reason } });
    return plan;
  }

  /** Confirm (apply) the last plan: counts the outcome, clears pending. */
  confirm(sessionId: string, atMs = 0): ResumeV20Plan | null {
    const s = this.stateFor(sessionId);
    const plan = s.lastPlan;
    if (!plan) return null;
    this.stats.applied += 1;
    if (plan.action === 'resume') {
      s.resumes += 1;
      this.stats.resumes += 1;
      s.consecutiveDrops = 0;
    } else if (plan.action === 'restart') {
      s.restarts += 1;
      this.stats.restarts += 1;
      s.consecutiveDrops = 0;
    } else if (plan.action === 'summarise') {
      s.summaries += 1;
      this.stats.summaries += 1;
      s.consecutiveDrops = 0;
    } else {
      s.drops += 1;
      this.stats.drops += 1;
      s.consecutiveDrops += 1;
    }
    this.pending.delete(sessionId);
    s.lastPlan = null;
    this.emit({ kind: 'applied', atMs, sessionId, detail: { action: plan.action, speakChars: plan.speakText.length } });
    return plan;
  }

  /** Decline the pending interrupt (same as confirming a drop). */
  decline(sessionId: string, atMs = 0): ResumeV20Plan | null {
    const planned = this.plan(sessionId, 'drop', atMs);
    if (!planned) return null;
    return this.confirm(sessionId, atMs);
  }

  /** Forget a session's resume state (session ended). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.pending.delete(sessionId);
    this.stats.sessions = this.sessions.size;
  }

  summary(): string {
    const s = this.stats;
    return `Resume v20: ${s.interrupts} interrupts, ${s.plans} plans, ${s.applied} applied ` +
      `(${s.resumes} resumes, ${s.restarts} restarts, ${s.summaries} summaries, ${s.drops} drops), ${s.refused} refused`;
  }
}

export function createResumeOrchestratorV20(
  opts: Partial<ResumeV20Options> = {},
  sink?: ResumeV20EventSink,
): ResumeOrchestratorV20 {
  return new ResumeOrchestratorV20(opts, sink);
}

export function resumeV20Markdown(o: ResumeOrchestratorV20): string {
  const s = o.getStats();
  return `# Resume v20\n\n- Sessions: ${s.sessions}\n- Interrupts: ${s.interrupts}\n- Plans: ${s.plans}\n` +
    `- Applied: ${s.applied} (resumes ${s.resumes}, restarts ${s.restarts}, summaries ${s.summaries}, drops ${s.drops})\n` +
    `- Refused: ${s.refused}\n`;
}
