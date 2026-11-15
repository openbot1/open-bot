/**
 * Voice → budget link (v1.07, Team T5 — voice v4 + UI).
 *
 * The conversation budget meter (`risk/budget.ts`) counts text
 * model calls; voice calls spend tokens too (transcripts in,
 * replies out) but never reached the meter — a long voice call
 * looked free. This module is the link between the two halves of
 * the v1.07 work: it records a finished voice call's usage into
 * the harness meter so the BudgetMeter UI shows the *whole*
 * conversation, voice included.
 *
 * Honesty rules (the estimate is labelled, never hidden):
 *
 *   - Voice minutes are an *estimate*: `estimateVoiceTokens()`
 *     (~800 tokens/minute of conversation, see
 *     `conversation/budgetMeterView.ts`). The link records it
 *     under the model key `voice` (`VOICE_BUDGET_MODEL_KEY`), so
 *     the meter's per-model breakdown always shows the voice
 *     share apart from every text model — a voice estimate never
 *     inflates a text model's numbers.
 *   - The estimate is split 50/50 into input/output tokens (half
 *     the conversation is the user talking, half is the model
 *     replying). A provider that later reports real voice usage
 *     should replace this estimate, not add to it — `recordCall`
 *     returns the snapshot, and the caller can see the voice share
 *     in `snapshot.byModel['voice']`.
 *   - Recording is idempotent per call only when the caller says
 *     so: `recordCall` takes the call minutes (the host measures
 *     them from the session's state history / clock); recording
 *     the same call twice double-counts, and the link says so in
 *     its docs rather than pretending to dedupe without an id.
 *
 * The link never dials, never reads audio, never touches a key —
 * it only moves numbers the session already measured into the
 * meter the UI already renders.
 */
import { ConversationBudgetMeter } from '../risk/budget';
import type { BudgetSnapshot } from '../risk/types';
import {
  estimateVoiceTokens,
  VOICE_BUDGET_MODEL_KEY,
} from '../conversation/budgetMeterView';
import type { VoiceSessionV6 } from './voiceSessionV6';

/** What one recorded voice call contributed to the meter. */
export interface VoiceBudgetRecord {
  sessionId: string;
  minutes: number;
  estimatedTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Meter snapshot after recording. */
  snapshot: BudgetSnapshot;
}

export interface VoiceBudgetLinkOptions {
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

export class VoiceBudgetLink {
  private readonly meter: ConversationBudgetMeter;
  private readonly clock: () => number;
  private recordedCalls = 0;
  private recordedMinutes = 0;
  private recordedTokens = 0;

  constructor(meter: ConversationBudgetMeter, options: VoiceBudgetLinkOptions = {}) {
    this.meter = meter;
    this.clock = options.clock ?? Date.now;
  }

  get id(): string {
    return this.meter.id;
  }

  /**
   * Record one finished voice call (by minutes) into the meter.
   * Returns the record (estimate + snapshot). Minutes <= 0
   * record nothing and return the current snapshot.
   */
  recordCall(sessionId: string, minutes: number): VoiceBudgetRecord {
    const cleanMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
    const estimated = estimateVoiceTokens(cleanMinutes);
    // 50/50 split: half the conversation is the user talking
    // (input), half is the model replying (output). Documented
    // estimate — see the module header.
    const inputTokens = Math.floor(estimated / 2);
    const outputTokens = estimated - inputTokens;
    const snapshot =
      estimated > 0
        ? this.meter.record(VOICE_BUDGET_MODEL_KEY, inputTokens, outputTokens)
        : this.meter.snapshot();
    if (estimated > 0) {
      this.recordedCalls += 1;
      this.recordedMinutes += cleanMinutes;
      this.recordedTokens += estimated;
    }
    void this.clock;
    return { sessionId, minutes: cleanMinutes, estimatedTokens: estimated, inputTokens, outputTokens, snapshot };
  }

  /**
   * Record a live session's call from its recorded turns: one turn
   * is roughly 30 seconds of conversation (user + model). Same
   * estimate rules as `recordCall`; the caller passes the session
   * so the turn count is measured, not guessed. (Long-session
   * turns, not the transport turn counter — the transport only
   * counts turns the provider finished, while local notes count
   * here too.)
   */
  recordSession(session: VoiceSessionV6, sessionId: string): VoiceBudgetRecord {
    const turns = Math.max(0, session.getLongSessionTurns().length);
    return this.recordCall(sessionId, turns * 0.5);
  }

  /** Voice share of the meter so far (tokens + share of the total). */
  getVoiceShare(): { tokens: number; share: number; calls: number; minutes: number } {
    const snapshot = this.meter.snapshot();
    const voice = snapshot.byModel[VOICE_BUDGET_MODEL_KEY];
    const tokens = voice ? voice.inputTokens + voice.outputTokens : 0;
    return {
      tokens,
      share: snapshot.totalTokens > 0 ? tokens / snapshot.totalTokens : 0,
      calls: this.recordedCalls,
      minutes: this.recordedMinutes,
    };
  }

  getStats(): { calls: number; minutes: number; tokens: number } {
    return { calls: this.recordedCalls, minutes: this.recordedMinutes, tokens: this.recordedTokens };
  }

  /** Current meter snapshot (what the BudgetMeter UI renders). */
  snapshot(): BudgetSnapshot {
    return this.meter.snapshot();
  }
}

/** One-line summary for logs ("voice: 2 call(s), 5.0 min, ~4,000 tokens"). */
export function voiceBudgetSummary(link: VoiceBudgetLink): string {
  const stats = link.getStats();
  const share = link.getVoiceShare();
  return (
    `voice: ${stats.calls} call(s), ${stats.minutes.toFixed(1)} min, ` +
    `~${stats.tokens.toLocaleString('en-US')} estimated tokens ` +
    `(${(share.share * 100).toFixed(1)}% of the conversation)`
  );
}
