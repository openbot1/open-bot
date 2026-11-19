/**
 * Barge-in engine v30 (v1.44, Team T4).
 *
 * What v29 got wrong and v30 fixes:
 *
 *   - One interruption kind. v30 distinguishes SOFT (pause the
 *     response, keep the remainder, resume after the user
 *     turn) from HARD (cancel for good). A short, confident
 *     "yeah, go on" pauses; a sustained "stop, that's wrong"
 *     cancels. The caller picks the level by confidence, and
 *     a user-button interrupt is always hard.
 *   - v29 resumed the remainder mid-word. v30 resumes from
 *     the next sentence boundary (configurable), so the agent
 *     never restarts in the middle of a word.
 *   - No cooldown: after one barge-in, the next cough could
 *     interrupt the resumed response immediately. v30
 *     enforces a cooldown window after every interruption.
 *   - Confidence was one number (sustained speech only). v30
 *     scores from sustained speech *plus* the energy slope
 *     (speech that is rising is a real interruption; flat or
 *     falling energy is more likely noise) and adapts the
 *     sensitivity after false positives: when the host marks
 *     an interruption as a false positive, the engine gets
 *     harder to trigger.
 *   - v29 kept no reason history beyond a verdict. v30 keeps
 *     a full event log with spoken/remaining chars at the
 *     interruption point, so the session can show exactly
 *     what was cut and what was kept.
 *
 * Responses are still server-driven: only the server creates
 * or cancels a response; the client can only *request* an
 * interruption and the engine decides.
 *
 * All clocks virtual (the caller passes `atMs`); no audio is
 * recorded; no provider is dialled.
 */

import {
  clampV30,
  cutAtSentenceBoundaryV30,
  defaultBargeInConfigV30,
  round4V30,
  validateBargeInConfigV30,
  type VoiceV30BargeInConfig,
  type VoiceV30BargeInEvent,
  type VoiceV30InterruptDecision,
  type VoiceV30InterruptLevel,
  type VoiceV30InterruptRequester,
  type VoiceV30InterruptVerdict,
  type VoiceV30ServerResponse,
} from './types';

export interface BargeInEngineV30Options {
  config?: Partial<VoiceV30BargeInConfig>;
  /** Max responses kept in history. */
  maxResponses?: number;
  /** Max interruption events kept. */
  maxEvents?: number;
  /** Called when a response is interrupted. */
  onInterrupt?: (event: VoiceV30BargeInEvent) => void;
}

export interface VoiceV30BargeInStats {
  responses: number;
  activeResponses: number;
  interruptions: number;
  softInterruptions: number;
  hardInterruptions: number;
  ignored: number;
  falsePositives: number;
  resumes: number;
  discards: number;
  sensitivity: number;
  lastCooldownEndsAtMs: number | null;
}

export function defaultBargeInEngineV30Options(): BargeInEngineV30Options {
  return { config: defaultBargeInConfigV30(), maxResponses: 500, maxEvents: 1000 };
}

export class BargeInEngineV30 {
  private config: VoiceV30BargeInConfig;
  private readonly maxResponses: number;
  private readonly maxEvents: number;
  private readonly onInterrupt?: (event: VoiceV30BargeInEvent) => void;

  private readonly responses = new Map<string, VoiceV30ServerResponse>();
  private readonly events: VoiceV30BargeInEvent[] = [];
  private responseCount = 0;
  private sensitivity: number;
  private falsePositives = 0;
  private resumes = 0;
  private discards = 0;
  private lastInterruptAtMs: number | null = null;
  /** Recent frame energies while an interruption is evaluated. */
  private readonly energyWindow: number[] = [];

  constructor(opts: BargeInEngineV30Options = {}) {
    const merged: VoiceV30BargeInConfig = {
      ...defaultBargeInConfigV30(),
      ...(opts.config ?? {}),
    };
    const errors = validateBargeInConfigV30(merged);
    if (errors.length > 0) throw new Error(`Invalid barge-in config: ${errors.join('; ')}`);
    this.config = merged;
    this.maxResponses = opts.maxResponses ?? 500;
    this.maxEvents = opts.maxEvents ?? 1000;
    this.onInterrupt = opts.onInterrupt;
    this.sensitivity = merged.sensitivity;
  }

  getConfig(): VoiceV30BargeInConfig {
    return { ...this.config, sensitivity: this.sensitivity };
  }

  /** Replace the config (validated); keeps history. */
  setConfig(patch: Partial<VoiceV30BargeInConfig>): VoiceV30BargeInConfig {
    const merged = { ...this.config, ...patch };
    const errors = validateBargeInConfigV30(merged);
    if (errors.length > 0) throw new Error(`Invalid barge-in config: ${errors.join('; ')}`);
    this.config = merged;
    if (patch.sensitivity !== undefined) this.sensitivity = patch.sensitivity;
    return this.getConfig();
  }

  /** Current (possibly adapted) sensitivity. */
  sensitivityNow(): number {
    return this.sensitivity;
  }

  /** The currently speaking response (a paused response is not interruptible). */
  activeResponse(): VoiceV30ServerResponse | null {
    for (const r of this.responses.values()) {
      if (r.state === 'active') return { ...r };
    }
    return null;
  }

  getResponse(id: string): VoiceV30ServerResponse | null {
    const r = this.responses.get(id);
    return r ? { ...r } : null;
  }

  listResponses(): VoiceV30ServerResponse[] {
    return [...this.responses.values()].map((r) => ({ ...r }));
  }

  eventsSoFar(): VoiceV30BargeInEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Server starts a response (only the server creates responses). */
  serverStartResponse(
    text: string,
    atMs: number,
    sessionId: string,
  ): VoiceV30ServerResponse {
    this.responseCount += 1;
    const response: VoiceV30ServerResponse = {
      id: `resp-${this.responseCount}`,
      sessionId,
      text,
      startedAtMs: atMs,
      state: 'active',
      spokenChars: 0,
      remainingChars: text.length,
      resumeAtChars: 0,
      interruptedAtMs: null,
      completedAtMs: null,
      cancelledAtMs: null,
      interruptCount: 0,
    };
    this.responses.set(response.id, response);
    if (this.responses.size > this.maxResponses) {
      const oldest = this.responses.keys().next().value;
      if (oldest) this.responses.delete(oldest);
    }
    return { ...response };
  }

  /** Server marks chars as spoken (playback progress). */
  serverMarkSpoken(responseId: string, spokenChars: number, atMs: number): VoiceV30ServerResponse | null {
    const r = this.responses.get(responseId);
    if (!r || r.state !== 'active') return null;
    void atMs;
    r.spokenChars = clampV30(spokenChars, 0, r.text.length);
    r.remainingChars = r.text.length - r.spokenChars;
    return { ...r };
  }

  /** Server completes a response. */
  serverCompleteResponse(responseId: string, atMs: number): VoiceV30ServerResponse | null {
    const r = this.responses.get(responseId);
    if (!r || (r.state !== 'active' && r.state !== 'paused')) return null;
    r.state = 'completed';
    r.spokenChars = r.text.length;
    r.remainingChars = 0;
    r.completedAtMs = atMs;
    return { ...r };
  }

  /** Server cancels a response. */
  serverCancelResponse(responseId: string, atMs: number, reason = 'server cancelled the response'): VoiceV30ServerResponse | null {
    const r = this.responses.get(responseId);
    if (!r || (r.state !== 'active' && r.state !== 'paused')) return null;
    void reason;
    r.state = 'cancelled';
    r.cancelledAtMs = atMs;
    return { ...r };
  }

  /**
   * Score an interruption request 0..1 from sustained speech
   * plus the energy slope. `speechMs` is how long the user
   * has been speaking; `energies` are the recent frame
   * energies (oldest first). Rising energy means a real
   * interruption; flat or falling energy is more likely
   * noise, so it lowers the score.
   */
  scoreInterruption(speechMs: number, energies: readonly number[], peakEnergy: number): number {
    const durationScore = clampV30(speechMs / Math.max(1, this.config.minSpeechMs * 2), 0, 1);
    const energyScore = clampV30(peakEnergy, 0, 1);
    let slopeScore = 0.5;
    if (energies.length >= 3) {
      const first = energies[0];
      const last = energies[energies.length - 1];
      const slope = (last - first) / Math.max(1, energies.length - 1);
      // Rising slope up to +0.1/frame maps to 1; falling maps to 0.
      slopeScore = clampV30(0.5 + slope * 5, 0, 1);
    }
    const raw = 0.5 * durationScore + 0.3 * energyScore + 0.2 * slopeScore;
    // Sensitivity shifts the score: a sensitive engine scores higher.
    return round4V30(clampV30(raw * (0.7 + 0.6 * this.sensitivity), 0, 1));
  }

  /**
   * Request an interruption. The engine decides: grace,
   * cooldown, duration, energy and confidence are all
   * checked, in that order. A button request skips the
   * speech checks and is always hard.
   */
  requestInterrupt(
    requester: VoiceV30InterruptRequester,
    atMs: number,
    speechMs = 0,
    peakEnergy = 0,
    energies: readonly number[] = [],
  ): VoiceV30InterruptDecision {
    const active = this.activeResponse();
    // activeResponse() returns a copy; decisions mutate the stored object.
    const stored = active ? this.responses.get(active.id) ?? null : null;
    const decide = (
      verdict: VoiceV30InterruptVerdict,
      level: VoiceV30InterruptLevel | null,
      confidence: number,
      reason: string,
    ): VoiceV30InterruptDecision => {
      const decision: VoiceV30InterruptDecision = {
        verdict,
        level,
        responseId: active?.id ?? null,
        confidence,
        reason,
        atMs,
      };
      this.recordEvent(requester, decision, active);
      return decision;
    };

    if (!active) {
      return decide('ignore-no-response', null, 0, 'No active response to interrupt');
    }
    if (this.config.graceMs > 0 && atMs - active.startedAtMs < this.config.graceMs) {
      return decide('ignore-grace', null, 0, `Response started ${atMs - active.startedAtMs}ms ago, inside the ${this.config.graceMs}ms grace window`);
    }
    if (this.lastInterruptAtMs !== null && atMs - this.lastInterruptAtMs < this.config.cooldownMs) {
      return decide('ignore-cooldown', null, 0, `Inside the ${this.config.cooldownMs}ms cooldown after the last barge-in`);
    }
    if (requester === 'user-button') {
      return this.applyInterrupt(stored ?? active, 'hard', 1, atMs, requester, 'User pressed interrupt');
    }
    if (speechMs < this.config.minSpeechMs) {
      return decide('ignore-too-short', null, 0, `User speech ${speechMs}ms is below the ${this.config.minSpeechMs}ms minimum`);
    }
    if (peakEnergy < this.config.minEnergy) {
      return decide('ignore-low-confidence', null, 0, `Peak energy ${peakEnergy} is below the ${this.config.minEnergy} minimum`);
    }
    const confidence = this.scoreInterruption(speechMs, energies, peakEnergy);
    if (confidence >= this.config.hardConfidence) {
      return this.applyInterrupt(stored ?? active, 'hard', confidence, atMs, requester, `Confidence ${confidence} reached the hard threshold ${this.config.hardConfidence}`);
    }
    if (confidence >= this.config.softConfidence) {
      return this.applyInterrupt(stored ?? active, 'soft', confidence, atMs, requester, `Confidence ${confidence} reached the soft threshold ${this.config.softConfidence}`);
    }
    return decide('ignore-low-confidence', null, confidence, `Confidence ${confidence} is below the soft threshold ${this.config.softConfidence}`);
  }

  /**
   * The host marks the most recent interruption as a false
   * positive (the user was not actually interrupting). The
   * engine gets harder to trigger from now on.
   */
  markFalsePositive(atMs: number): number {
    this.falsePositives += 1;
    this.sensitivity = clampV30(this.sensitivity - this.config.adaptDownStep, 0, 1);
    void atMs;
    return this.sensitivity;
  }

  /** Resume a paused response from its sentence boundary. */
  resumeRemainder(responseId: string, atMs: number, sessionId: string): VoiceV30ServerResponse | null {
    const r = this.responses.get(responseId);
    if (!r || r.state !== 'paused') return null;
    void atMs;
    void sessionId;
    this.responseCount += 1;
    const resumed: VoiceV30ServerResponse = {
      id: `resp-${this.responseCount}`,
      sessionId: r.sessionId,
      text: r.text.slice(r.resumeAtChars),
      startedAtMs: atMs,
      state: 'active',
      spokenChars: 0,
      remainingChars: r.text.length - r.resumeAtChars,
      resumeAtChars: 0,
      interruptedAtMs: null,
      completedAtMs: null,
      cancelledAtMs: null,
      interruptCount: 0,
    };
    this.responses.set(resumed.id, resumed);
    this.resumes += 1;
    return { ...resumed };
  }

  /** Discard the remainder of a paused response for good. */
  discardRemainder(responseId: string, atMs: number): boolean {
    const r = this.responses.get(responseId);
    if (!r || r.state !== 'paused') return false;
    void atMs;
    r.state = 'cancelled';
    r.cancelledAtMs = atMs;
    this.discards += 1;
    return true;
  }

  stats(): VoiceV30BargeInStats {
    const soft = this.events.filter((e) => e.verdict === 'interrupt-soft').length;
    const hard = this.events.filter((e) => e.verdict === 'interrupt-hard').length;
    const ignored = this.events.filter((e) => e.verdict.startsWith('ignore-')).length;
    return {
      responses: this.responses.size,
      activeResponses: [...this.responses.values()].filter((r) => r.state === 'active' || r.state === 'paused').length,
      interruptions: soft + hard,
      softInterruptions: soft,
      hardInterruptions: hard,
      ignored,
      falsePositives: this.falsePositives,
      resumes: this.resumes,
      discards: this.discards,
      sensitivity: round4V30(this.sensitivity),
      lastCooldownEndsAtMs:
        this.lastInterruptAtMs === null ? null : this.lastInterruptAtMs + this.config.cooldownMs,
    };
  }

  reset(): void {
    this.responses.clear();
    this.events.length = 0;
    this.responseCount = 0;
    this.sensitivity = this.config.sensitivity;
    this.falsePositives = 0;
    this.resumes = 0;
    this.discards = 0;
    this.lastInterruptAtMs = null;
    this.energyWindow.length = 0;
  }

  private applyInterrupt(
    active: VoiceV30ServerResponse,
    level: VoiceV30InterruptLevel,
    confidence: number,
    atMs: number,
    requester: VoiceV30InterruptRequester,
    reason: string,
  ): VoiceV30InterruptDecision {
    const verdict: VoiceV30InterruptVerdict = level === 'hard' ? 'interrupt-hard' : 'interrupt-soft';
    if (level === 'hard') {
      active.state = 'cancelled';
      active.cancelledAtMs = atMs;
      active.remainingChars = 0;
      active.resumeAtChars = active.text.length;
    } else {
      active.state = 'paused';
      active.resumeAtChars = this.config.resumeAtSentenceBoundary
        ? cutAtSentenceBoundaryV30(active.text, active.spokenChars)
        : active.spokenChars;
      active.remainingChars = active.text.length - active.resumeAtChars;
    }
    active.interruptedAtMs = atMs;
    active.interruptCount += 1;
    this.lastInterruptAtMs = atMs;
    // A confirmed interrupt makes the engine slightly more sensitive.
    this.sensitivity = clampV30(this.sensitivity + this.config.adaptStep, 0, 1);
    const decision: VoiceV30InterruptDecision = {
      verdict,
      level,
      responseId: active.id,
      confidence,
      reason,
      atMs,
    };
    this.events.push({
      atMs,
      requester,
      verdict,
      level,
      responseId: active.id,
      confidence,
      spokenCharsAtInterrupt: active.spokenChars,
      remainingChars: active.remainingChars,
    });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    this.onInterrupt?.({
      atMs,
      requester,
      verdict,
      level,
      responseId: active.id,
      confidence,
      spokenCharsAtInterrupt: active.spokenChars,
      remainingChars: active.remainingChars,
    });
    return decision;
  }

  private recordEvent(
    requester: VoiceV30InterruptRequester,
    decision: VoiceV30InterruptDecision,
    active: VoiceV30ServerResponse | null,
  ): void {
    // applyInterrupt records its own event via onInterrupt; the
    // plain verdicts are recorded here. Skip double-recording.
    if (decision.verdict === 'interrupt-soft' || decision.verdict === 'interrupt-hard') return;
    this.events.push({
      atMs: decision.atMs,
      requester,
      verdict: decision.verdict,
      level: decision.level,
      responseId: decision.responseId,
      confidence: decision.confidence,
      spokenCharsAtInterrupt: active?.spokenChars ?? 0,
      remainingChars: active?.remainingChars ?? 0,
    });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }
}

export function createBargeInEngineV30(opts: BargeInEngineV30Options = {}): BargeInEngineV30 {
  return new BargeInEngineV30(opts);
}
