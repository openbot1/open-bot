/**
 * Barge-in engine v29 (v1.42, Team T4).
 *
 * The user interrupting the agent mid-sentence. The core
 * rule, learned from GPT-Live full-duplex (survey §4), is
 * that responses are *server-driven*: only the server
 * creates or cancels a response. The client (mic, button)
 * can only *request* an interruption, and this engine
 * decides — sustained speech above a floor, past a grace
 * window after the agent started, with a confidence score
 * and an adaptive sensitivity that learns from the user's
 * interruption history (idea: LiveKit adaptive
 * interruption).
 *
 * When an interruption lands, the active response is
 * cancelled at a word boundary and the unspoken remainder
 * is kept, so the agent can resume it later instead of
 * losing the thought. A button press (explicit request)
 * always interrupts; a short burst inside the grace window
 * is ignored; a backchannel ("mm-hmm") never interrupts.
 *
 * All clocks virtual (the caller passes `atMs`); no audio
 * is played or recorded here.
 */

import {
  VOICE_V29_BARGE_IN_ADAPT_DOWN_STEP_DEFAULT,
  VOICE_V29_BARGE_IN_ADAPT_STEP_DEFAULT,
  VOICE_V29_BARGE_IN_GRACE_DEFAULT_MS,
  VOICE_V29_BARGE_IN_MIN_ENERGY_DEFAULT,
  VOICE_V29_BARGE_IN_MIN_SPEECH_DEFAULT_MS,
  VOICE_V29_BARGE_IN_SENSITIVITY_DEFAULT,
  clampV29,
  cutAtWordBoundaryV29,
  defaultBargeInConfigV29,
  round4V29,
  validateBargeInConfigV29,
  type VoiceV29BargeInConfig,
  type VoiceV29BargeInEvent,
  type VoiceV29InterruptDecision,
  type VoiceV29InterruptRequester,
  type VoiceV29InterruptVerdict,
  type VoiceV29ResponseEndReason,
  type VoiceV29ServerResponse,
} from './types';

export interface BargeInEngineV29Options {
  config?: Partial<VoiceV29BargeInConfig>;
  /** Max events kept in the audit log (oldest dropped first). */
  maxEvents?: number;
  /** Called when a response is actually interrupted. */
  onInterrupted?: (decision: VoiceV29InterruptDecision) => void;
  /** Called when an interruption request is ignored. */
  onIgnored?: (decision: VoiceV29InterruptDecision) => void;
}

export interface VoiceV29BargeInStats {
  requests: number;
  interruptions: number;
  ignored: number;
  ignoredGrace: number;
  ignoredTooShort: number;
  ignoredBackchannel: number;
  ignoredNoResponse: number;
  ignoredDisabled: number;
  resumes: number;
  discards: number;
  activeResponseId: string | null;
  sensitivity: number;
  /** Interruption rate: interruptions / requests (0 when none). */
  interruptionRate: number;
}

export function defaultBargeInEngineV29Options(): BargeInEngineV29Options {
  return { config: defaultBargeInConfigV29(), maxEvents: 500 };
}

let responseCounter = 0;

export class BargeInEngineV29 {
  private config: VoiceV29BargeInConfig;
  private readonly maxEvents: number;
  private readonly onInterrupted?: (decision: VoiceV29InterruptDecision) => void;
  private readonly onIgnored?: (decision: VoiceV29InterruptDecision) => void;

  private active: VoiceV29ServerResponse | null = null;
  private readonly responses = new Map<string, VoiceV29ServerResponse>();
  private readonly events: VoiceV29BargeInEvent[] = [];
  private requests = 0;
  private interruptions = 0;
  private ignoredGrace = 0;
  private ignoredTooShort = 0;
  private ignoredBackchannel = 0;
  private ignoredNoResponse = 0;
  private ignoredDisabled = 0;
  private resumes = 0;
  private discards = 0;

  constructor(opts: BargeInEngineV29Options = {}) {
    const merged: VoiceV29BargeInConfig = {
      ...defaultBargeInConfigV29(),
      ...(opts.config ?? {}),
    };
    const errors = validateBargeInConfigV29(merged);
    if (errors.length > 0) throw new Error(`Invalid barge-in config: ${errors.join('; ')}`);
    this.config = merged;
    this.maxEvents = opts.maxEvents ?? 500;
    this.onInterrupted = opts.onInterrupted;
    this.onIgnored = opts.onIgnored;
  }

  getConfig(): VoiceV29BargeInConfig {
    return { ...this.config };
  }

  /** Replace the config (validated). */
  setConfig(patch: Partial<VoiceV29BargeInConfig>): VoiceV29BargeInConfig {
    const merged = { ...this.config, ...patch };
    const errors = validateBargeInConfigV29(merged);
    if (errors.length > 0) throw new Error(`Invalid barge-in config: ${errors.join('; ')}`);
    this.config = merged;
    return this.getConfig();
  }

  /** Sensitivity in force right now (adapts over time). */
  sensitivity(): number {
    return this.config.sensitivity;
  }

  activeResponse(): VoiceV29ServerResponse | null {
    return this.active ? { ...this.active } : null;
  }

  getResponse(id: string): VoiceV29ServerResponse | null {
    const found = this.responses.get(id);
    return found ? { ...found } : null;
  }

  listResponses(): VoiceV29ServerResponse[] {
    return [...this.responses.values()].map((r) => ({ ...r }));
  }

  eventsSoFar(): VoiceV29BargeInEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /**
   * Server creates a response. Only the server calls this —
   * the client never creates a response directly (that is
   * the whole point of server-driven responses).
   */
  serverStartResponse(
    sessionId: string,
    text: string,
    atMs: number,
    turnIndex = 0,
  ): VoiceV29ServerResponse {
    if (!text.trim()) throw new Error('Response text must not be empty');
    // A new server response supersedes a still-active one:
    // the old one is cancelled by the server, not lost.
    if (this.active) this.cancelActive(atMs, 'cancelled-server', 'superseded by a new server response');
    responseCounter += 1;
    const response: VoiceV29ServerResponse = {
      id: `resp-${responseCounter}`,
      sessionId,
      createdAtMs: atMs,
      text,
      spokenText: '',
      remainingText: text,
      state: 'active',
      endedAtMs: null,
      endReason: null,
      turnIndex,
    };
    this.active = response;
    this.responses.set(response.id, response);
    return { ...response };
  }

  /**
   * Server marks part of the active response as spoken.
   * `spokenChars` is the total spoken so far; the remainder
   * is cut at a word boundary so a resume never starts
   * mid-word.
   */
  serverMarkSpoken(responseId: string, spokenChars: number, atMs: number): VoiceV29ServerResponse | null {
    const response = this.responses.get(responseId);
    if (!response || response.state !== 'active') return null;
    const safe = clampV29(Math.floor(spokenChars), 0, response.text.length);
    const spoken = cutAtWordBoundaryV29(response.text, safe);
    response.spokenText = spoken;
    response.remainingText = response.text.slice(spoken.length).trimStart();
    void atMs;
    return { ...response };
  }

  /** Server completes the active response (fully spoken). */
  serverCompleteResponse(responseId: string, atMs: number): VoiceV29ServerResponse | null {
    const response = this.responses.get(responseId);
    if (!response || response.state !== 'active') return null;
    response.state = 'completed';
    response.endedAtMs = atMs;
    response.endReason = 'completed';
    response.spokenText = response.text;
    response.remainingText = '';
    if (this.active?.id === responseId) this.active = null;
    return { ...response };
  }

  /** Server cancels the active response outright. */
  serverCancelResponse(responseId: string, atMs: number, reason = 'server cancelled the response'): VoiceV29ServerResponse | null {
    const response = this.responses.get(responseId);
    if (!response || response.state !== 'active') return null;
    return this.cancelActive(atMs, 'cancelled-server', reason, response);
  }

  /**
   * Request an interruption. This is the *only* entry point
   * the client side uses: it asks, the engine decides.
   * `speechMs` is how long the user has been speaking
   * continuously, `energy` the current frame energy, and
   * `backchannel` whether the detector classified the burst
   * as a backchannel.
   */
  requestInterrupt(
    atMs: number,
    requester: VoiceV29InterruptRequester,
    speechMs: number,
    energy: number,
    backchannel = false,
  ): VoiceV29InterruptDecision {
    this.requests += 1;
    const decision = this.decide(atMs, requester, speechMs, energy, backchannel);
    this.pushEvent({
      atMs,
      kind: decision.verdict === 'interrupt' ? 'interrupted' : 'requested',
      responseId: decision.responseId,
      verdict: decision.verdict,
      detail: decision.reason,
    });
    if (decision.verdict === 'interrupt') {
      this.interruptions += 1;
      if (this.config.adaptive) {
        this.config.sensitivity = round4V29(
          clampV29(this.config.sensitivity + this.config.adaptStep, 0, 1),
        );
      }
      this.onInterrupted?.(decision);
    } else {
      this.countIgnored(decision.verdict);
      if (this.config.adaptive && decision.verdict !== 'ignore-no-response' && decision.verdict !== 'ignore-disabled') {
        this.config.sensitivity = round4V29(
          clampV29(this.config.sensitivity - this.config.adaptDownStep, 0, 1),
        );
      }
      this.pushEvent({
        atMs,
        kind: 'ignored',
        responseId: decision.responseId,
        verdict: decision.verdict,
        detail: decision.reason,
      });
      this.onIgnored?.(decision);
    }
    return decision;
  }

  /**
   * Resume the unspoken remainder of an interrupted
   * response as a *new* server response (the server owns
   * the resume; the remainder is never edited in place).
   */
  resumeRemainder(responseId: string, atMs: number, sessionId: string): VoiceV29ServerResponse | null {
    const original = this.responses.get(responseId);
    if (!original || original.state !== 'cancelled' || !original.remainingText) return null;
    if (this.active) return null; // never two active responses
    this.resumes += 1;
    this.pushEvent({
      atMs,
      kind: 'resumed',
      responseId,
      verdict: null,
      detail: `Resumed ${original.remainingText.length} unspoken chars as a new server response`,
    });
    return this.serverStartResponse(sessionId, original.remainingText, atMs, original.turnIndex);
  }

  /** Discard the remainder of an interrupted response for good. */
  discardRemainder(responseId: string, atMs: number): boolean {
    const original = this.responses.get(responseId);
    if (!original || original.state !== 'cancelled') return false;
    if (!original.remainingText) return false;
    original.remainingText = '';
    this.discards += 1;
    this.pushEvent({
      atMs,
      kind: 'discarded',
      responseId,
      verdict: null,
      detail: 'Unspoken remainder discarded by the server',
    });
    return true;
  }

  stats(): VoiceV29BargeInStats {
    const ignored = this.ignoredGrace + this.ignoredTooShort + this.ignoredBackchannel + this.ignoredNoResponse + this.ignoredDisabled;
    return {
      requests: this.requests,
      interruptions: this.interruptions,
      ignored,
      ignoredGrace: this.ignoredGrace,
      ignoredTooShort: this.ignoredTooShort,
      ignoredBackchannel: this.ignoredBackchannel,
      ignoredNoResponse: this.ignoredNoResponse,
      ignoredDisabled: this.ignoredDisabled,
      resumes: this.resumes,
      discards: this.discards,
      activeResponseId: this.active?.id ?? null,
      sensitivity: this.config.sensitivity,
      interruptionRate: this.requests === 0 ? 0 : round4V29(this.interruptions / this.requests),
    };
  }

  /** Reset everything (responses, events, counters, sensitivity). */
  reset(): void {
    this.active = null;
    this.responses.clear();
    this.events.length = 0;
    this.requests = 0;
    this.interruptions = 0;
    this.ignoredGrace = 0;
    this.ignoredTooShort = 0;
    this.ignoredBackchannel = 0;
    this.ignoredNoResponse = 0;
    this.ignoredDisabled = 0;
    this.resumes = 0;
    this.discards = 0;
    this.config.sensitivity = VOICE_V29_BARGE_IN_SENSITIVITY_DEFAULT;
  }

  private decide(
    atMs: number,
    requester: VoiceV29InterruptRequester,
    speechMs: number,
    energy: number,
    backchannel: boolean,
  ): VoiceV29InterruptDecision {
    const base: Omit<VoiceV29InterruptDecision, 'verdict' | 'confidence' | 'reason'> = {
      atMs,
      requester,
      responseId: this.active?.id ?? null,
      remainingText: '',
      sensitivity: this.config.sensitivity,
    };
    if (!this.config.enabled) {
      return { ...base, verdict: 'ignore-disabled', confidence: 0, reason: 'Barge-in is disabled for this session' };
    }
    if (!this.active) {
      return { ...base, verdict: 'ignore-no-response', confidence: 0, reason: 'No active server response to interrupt' };
    }
    const explicit = requester === 'user-button' || requester === 'server';
    if (backchannel && !explicit) {
      return { ...base, verdict: 'ignore-backchannel', confidence: 0.1, reason: 'Burst classified as a backchannel, not an interruption' };
    }
    // Effective floor: higher sensitivity lowers the bar.
    const effectiveMinSpeech = Math.round(
      this.config.minSpeechMs * (1.5 - this.config.sensitivity),
    );
    const effectiveMinEnergy = round4V29(
      this.config.minEnergy * (1.5 - this.config.sensitivity),
    );
    if (!explicit && atMs - this.active.createdAtMs < this.config.graceMs) {
      return {
        ...base,
        verdict: 'ignore-grace',
        confidence: 0.2,
        reason: `Inside the ${this.config.graceMs}ms grace window after the response started`,
      };
    }
    if (!explicit && speechMs < effectiveMinSpeech) {
      return {
        ...base,
        verdict: 'ignore-too-short',
        confidence: 0.3,
        reason: `User speech ${speechMs}ms is below the ${effectiveMinSpeech}ms floor`,
      };
    }
    if (!explicit && energy < effectiveMinEnergy) {
      return {
        ...base,
        verdict: 'ignore-too-short',
        confidence: 0.35,
        reason: `User energy ${round4V29(energy)} is below the ${effectiveMinEnergy} floor`,
      };
    }
    // It is a real interruption: cancel the response server-side.
    const cancelled = this.cancelActive(
      atMs,
      requester === 'user-button' ? 'cancelled-user-request' : 'cancelled-barge-in',
      `Interrupted by ${requester} after ${speechMs}ms of user speech`,
    );
    const confidence = explicit
      ? 1
      : round4V29(clampV29(0.55 + (speechMs / 1000) * 0.2 + (energy - effectiveMinEnergy) * 0.5, 0, 1));
    return {
      ...base,
      responseId: cancelled?.id ?? base.responseId,
      remainingText: cancelled?.remainingText ?? '',
      verdict: 'interrupt',
      confidence,
      reason: explicit
        ? 'Explicit interruption request — always honoured'
        : `Sustained user speech (${speechMs}ms, energy ${round4V29(energy)}) interrupted the response`,
    };
  }

  private cancelActive(
    atMs: number,
    reason: VoiceV29ResponseEndReason,
    detail: string,
    response?: VoiceV29ServerResponse,
  ): VoiceV29ServerResponse | null {
    const target = response ?? this.active;
    if (!target || target.state !== 'active') return null;
    target.state = 'cancelled';
    target.endedAtMs = atMs;
    target.endReason = reason;
    if (this.active?.id === target.id) this.active = null;
    void detail;
    return { ...target };
  }

  private countIgnored(verdict: VoiceV29InterruptVerdict): void {
    switch (verdict) {
      case 'ignore-grace':
        this.ignoredGrace += 1;
        break;
      case 'ignore-too-short':
        this.ignoredTooShort += 1;
        break;
      case 'ignore-backchannel':
        this.ignoredBackchannel += 1;
        break;
      case 'ignore-no-response':
        this.ignoredNoResponse += 1;
        break;
      case 'ignore-disabled':
        this.ignoredDisabled += 1;
        break;
      default:
        break;
    }
  }

  private pushEvent(event: VoiceV29BargeInEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}

export function createBargeInEngineV29(opts: BargeInEngineV29Options = {}): BargeInEngineV29 {
  return new BargeInEngineV29(opts);
}
