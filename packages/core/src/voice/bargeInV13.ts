/**
 * Barge-in engine v13 (v1.14, Đội T5 — voice realtime v13).
 *
 * v12 records *what* was cut (the sentence, the cut word, the
 * resume strategy). What it does not own is the *cut itself*:
 * deciding, from a live VAD speech-start, whether to cut now;
 * cancelling the stale work the cut makes obsolete; and flushing
 * the TTS queue so no leftover audio leaks out after the user
 * has spoken. v13 owns the cut end to end:
 *
 *   VAD speech-start ──▶ BargeInEngineV13.onVadSpeechStart
 *                          ├─ policy gate (min speech ms,
 *                          │   confidence, cooldown, echo-only)
 *                          ├─ CancelScopeV13.cancelAll
 *                          │   (discard stale LLM work: the
 *                          │   reply being generated, the resume
 *                          │   that is no longer wanted)
 *                          ├─ TTS queue flush (cancelPending)
 *                          ├─ v11 controller interrupt (receipt)
 *                          └─ InterruptContextV12.recordInterrupt
 *                              (played text kept in the transcript,
 *                               remainder + user words + strategy)
 *
 * The played part of a reply is never thrown away: the engine
 * keeps `playedTranscript` (what the user actually heard) so the
 * session transcript stays truthful after a cut, and the
 * remainder lives in the v12 interrupt record for resume.
 *
 * No audio device, no network, no model: the engine only tracks
 * words, receipts and decisions on the caller-owned virtual
 * clock. The TTS queue and the LLM work are caller-owned
 * callbacks — the engine never synthesises audio or calls a
 * model itself.
 */

import {
  BargeInV11Controller,
  splitWordsV11,
  type BargeInV11InterruptResult,
  type BargeInV11Word,
} from './bargeInV11';
import {
  InterruptContextV12,
  type BargeInV12Options,
  type BargeInV12Event,
  type BargeInV12ResumeStrategy,
  type BargeInV12Stats,
  type InterruptedUtteranceV12,
} from './bargeInV12';
import type { TtsStreamCancelResult } from './ttsStreamV11';

/** When the engine is allowed to cut. */
export type BargeInV13Policy = 'immediate' | 'after-min-speech' | 'confirm';

/** Options for `BargeInEngineV13`. */
export interface BargeInV13Options {
  /** Cut policy (default 'immediate'). */
  policy?: BargeInV13Policy;
  /** Speech (ms) the VAD must have heard before a cut under 'after-min-speech' (default 150). */
  minSpeechMs?: number;
  /** Minimum VAD confidence (0..1) for a cut (default 0.5). */
  minConfidence?: number;
  /** Cooldown (ms) after a cut before the next cut is allowed (default 500). */
  cooldownMs?: number;
  /** Ignore speech-starts flagged echo-only (default true). */
  ignoreEchoOnly?: boolean;
  /** Max interrupted utterances kept (passed to the v12 context, default 50). */
  maxHistory?: number;
  bargeInV12?: BargeInV12Options;
}

/** One cancellable unit of stale work (an LLM generation, a queued resume). */
export interface CancelScopeV13Work {
  id: string;
  /** Human-readable label (what the work was doing). */
  label: string;
  /** Called when the scope cancels the work; returns true when the work was actually stopped. */
  cancel: () => boolean;
}

/** Receipt for one cancelled unit of work. */
export interface CancelScopeV13Receipt {
  id: string;
  label: string;
  cancelled: boolean;
  atMs: number;
}

/** Result of cancelling a whole scope. */
export interface CancelScopeV13Result {
  atMs: number;
  reason: string;
  receipts: CancelScopeV13Receipt[];
  /** Units actually stopped. */
  cancelled: number;
  /** Units that were already done / could not be stopped. */
  alreadyDone: number;
}

/** Counters for one cancel scope. */
export interface CancelScopeV13Stats {
  registered: number;
  cancelled: number;
  alreadyDone: number;
  /** Units still registered (not yet cancelled or completed). */
  pending: number;
  cancels: number;
}

/** Events emitted by a cancel scope. */
export type CancelScopeV13Event =
  | { kind: 'work-registered'; id: string; label: string; atMs: number }
  | { kind: 'work-completed'; id: string; atMs: number }
  | { kind: 'scope-cancelled'; result: CancelScopeV13Result };

export type CancelScopeV13EventSink = (event: CancelScopeV13Event) => void;

export const BARGE_IN_V13_POLICIES = ['immediate', 'after-min-speech', 'confirm'] as const;

export function isBargeInV13Policy(value: unknown): value is BargeInV13Policy {
  return typeof value === 'string' && (BARGE_IN_V13_POLICIES as readonly string[]).includes(value);
}

export function defaultBargeInV13Options(): Required<Omit<BargeInV13Options, 'bargeInV12'>> & { bargeInV12: BargeInV12Options } {
  return {
    policy: 'immediate',
    minSpeechMs: 150,
    minConfidence: 0.5,
    cooldownMs: 500,
    ignoreEchoOnly: true,
    maxHistory: 50,
    bargeInV12: {},
  };
}

export function validateBargeInV13Options(options: BargeInV13Options): Required<Omit<BargeInV13Options, 'bargeInV12'>> & { bargeInV12: BargeInV12Options } {
  const base = defaultBargeInV13Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Barge-in v13 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  if (options.policy !== undefined && !isBargeInV13Policy(options.policy)) {
    throw new Error('Barge-in v13 policy must be "immediate", "after-min-speech" or "confirm".');
  }
  if (options.bargeInV12 !== undefined && (typeof options.bargeInV12 !== 'object' || options.bargeInV12 === null)) {
    throw new Error('Barge-in v13 bargeInV12 must be an options object.');
  }
  return {
    policy: options.policy ?? base.policy,
    minSpeechMs: Math.floor(num(options.minSpeechMs, base.minSpeechMs, 'minSpeechMs', 0, 10000)),
    minConfidence: num(options.minConfidence, base.minConfidence, 'minConfidence', 0, 1),
    cooldownMs: Math.floor(num(options.cooldownMs, base.cooldownMs, 'cooldownMs', 0, 60000)),
    ignoreEchoOnly: options.ignoreEchoOnly ?? base.ignoreEchoOnly,
    maxHistory: Math.floor(num(options.maxHistory, base.maxHistory, 'maxHistory', 1, 1000)),
    bargeInV12: options.bargeInV12 ?? {},
  };
}

/**
 * Cancel scope: a registry of cancellable work that dies
 * together when the user barges in. Register an LLM generation
 * (or a queued resume) when it starts, complete it when it
 * finishes normally; `cancelAll` stops everything still pending
 * and reports, per unit, whether it was actually stopped.
 * Cancelling an empty scope is a no-op with zero receipts.
 */
export class CancelScopeV13 {
  private readonly sink: CancelScopeV13EventSink | null;
  private readonly pending = new Map<string, CancelScopeV13Work>();
  private registered = 0;
  private cancelled = 0;
  private alreadyDone = 0;
  private cancels = 0;

  constructor(sink: CancelScopeV13EventSink | null = null) {
    this.sink = sink;
  }

  /** Register cancellable work. Throws on a duplicate id. */
  register(work: CancelScopeV13Work, atMs = 0): void {
    if (!work.id.trim()) throw new Error('Cancel scope v13 work id must be a non-empty string.');
    if (this.pending.has(work.id)) {
      throw new Error(`Cancel scope v13 work "${work.id}" is already registered.`);
    }
    if (typeof work.cancel !== 'function') {
      throw new Error('Cancel scope v13 work cancel must be a function.');
    }
    this.pending.set(work.id, work);
    this.registered += 1;
    this.sink?.({ kind: 'work-registered', id: work.id, label: work.label, atMs });
  }

  /** Mark work finished normally (no longer cancellable). Returns false when unknown. */
  complete(id: string, atMs = 0): boolean {
    if (!this.pending.delete(id)) return false;
    this.sink?.({ kind: 'work-completed', id, atMs });
    return true;
  }

  /** Cancel one unit by id. Returns its receipt, or null when unknown. */
  cancelOne(id: string, atMs: number, reason = 'barge-in'): CancelScopeV13Receipt | null {
    const work = this.pending.get(id);
    if (!work) return null;
    this.pending.delete(id);
    const stopped = work.cancel();
    if (stopped) this.cancelled += 1; else this.alreadyDone += 1;
    return { id: work.id, label: work.label, cancelled: stopped, atMs };
  }

  /** Cancel everything still pending. Units are cancelled in registration order. */
  cancelAll(atMs: number, reason = 'barge-in'): CancelScopeV13Result {
    const receipts: CancelScopeV13Receipt[] = [];
    for (const work of [...this.pending.values()]) {
      this.pending.delete(work.id);
      const stopped = work.cancel();
      if (stopped) this.cancelled += 1; else this.alreadyDone += 1;
      receipts.push({ id: work.id, label: work.label, cancelled: stopped, atMs });
    }
    this.cancels += 1;
    const result: CancelScopeV13Result = {
      atMs,
      reason,
      receipts,
      cancelled: receipts.filter((r) => r.cancelled).length,
      alreadyDone: receipts.filter((r) => !r.cancelled).length,
    };
    this.sink?.({ kind: 'scope-cancelled', result });
    return result;
  }

  /** Pending work ids, in registration order. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  getStats(): CancelScopeV13Stats {
    return {
      registered: this.registered,
      cancelled: this.cancelled,
      alreadyDone: this.alreadyDone,
      pending: this.pending.size,
      cancels: this.cancels,
    };
  }

  reset(): void {
    this.pending.clear();
    this.registered = 0;
    this.cancelled = 0;
    this.alreadyDone = 0;
    this.cancels = 0;
  }
}

/** Create a cancel scope (factory). */
export function createCancelScopeV13(sink: CancelScopeV13EventSink | null = null): CancelScopeV13 {
  return new CancelScopeV13(sink);
}

/** What the engine did with one VAD speech-start. */
export type BargeInV13CutDecision =
  | { cut: true; reason: string }
  | { cut: false; reason: string };

/** Full result of one engine cut. */
export interface BargeInV13CutResult {
  atMs: number;
  /** The v11 interrupt receipt (the exact cut point). */
  receipt: BargeInV11InterruptResult;
  /** The v12 interrupt record (played text kept, remainder, strategy). */
  record: InterruptedUtteranceV12 | null;
  /** What the cancel scope stopped. */
  scope: CancelScopeV13Result;
  /** What the TTS queue flush discarded (null when no queue was wired). */
  ttsFlush: TtsStreamCancelResult | null;
  /** Text the user actually heard before the cut. */
  playedText: string;
  /** True when the cut happened while the agent was still thinking. */
  wasThinking: boolean;
}

/** Counters for one engine. */
export interface BargeInV13Stats {
  speechStarts: number;
  cuts: number;
  ignored: number;
  /** Cuts refused by the policy gate (low confidence / too short / cooldown). */
  gated: number;
  /** Cuts refused because the engine was not speaking / thinking. */
  notSpeaking: number;
  /** Cuts refused because the speech was echo-only. */
  echoIgnored: number;
  lastCutAtMs: number | null;
  /** Played chars kept in the transcript across all cuts. */
  playedCharsKept: number;
  /** TTS chars discarded across all cuts. */
  ttsCharsDiscarded: number;
  /** Stale work units cancelled across all cuts. */
  staleWorkCancelled: number;
  scope: CancelScopeV13Stats;
  context: BargeInV12Stats;
}

/** Events emitted by the engine. */
export type BargeInV13Event =
  | { kind: 'speech-start'; atMs: number; speechMs: number; confidence: number }
  | { kind: 'cut-gated'; atMs: number; reason: string }
  | { kind: 'cut'; result: BargeInV13CutResult }
  | { kind: 'scope'; event: CancelScopeV13Event }
  | { kind: 'context'; event: BargeInV12Event };

export type BargeInV13EventSink = (event: BargeInV13Event) => void;

/** A TTS queue the engine can flush (shape of TtsStreamV11/V12 cancel). */
export interface BargeInV13TtsQueueLike {
  cancelPending(): TtsStreamCancelResult;
}

/**
 * Barge-in engine: VAD speech-start → policy gate → cancel
 * scope → TTS flush → v11 interrupt → v12 record. The caller
 * arms a reply with `beginSpeaking` (words + ms per char, like
 * the v11 controller) and feeds VAD speech-starts; the engine
 * decides and cuts. `cutNow` is the explicit path (the user
 * pressed stop, or a tool asked for a cut) — it skips the gate
 * but still flushes and records.
 */
export class BargeInEngineV13 {
  private readonly options: Required<Omit<BargeInV13Options, 'bargeInV12'>> & { bargeInV12: BargeInV12Options };
  private readonly sink: BargeInV13EventSink | null;
  private readonly controller: BargeInV11Controller;
  private readonly context: InterruptContextV12;
  private readonly scope: CancelScopeV13;
  private ttsQueue: BargeInV13TtsQueueLike | null = null;
  private speaking = false;
  private thinking = false;
  private lastCutAtMs: number | null = null;
  private playedTranscript: string[] = [];
  private lastCut: BargeInV13CutResult | null = null;
  private speechStarts = 0;
  private cuts = 0;
  private ignored = 0;
  private gated = 0;
  private notSpeaking = 0;
  private echoIgnored = 0;
  private playedCharsKept = 0;
  private ttsCharsDiscarded = 0;
  private staleWorkCancelled = 0;

  constructor(options: BargeInV13Options = {}, sink: BargeInV13EventSink | null = null) {
    this.options = validateBargeInV13Options(options);
    this.sink = sink;
    this.controller = new BargeInV11Controller({ policy: 'immediate' });
    this.context = new InterruptContextV12(
      { ...this.options.bargeInV12, maxHistory: this.options.maxHistory },
      (event) => this.sink?.({ kind: 'context', event }),
    );
    this.scope = new CancelScopeV13((event) => this.sink?.({ kind: 'scope', event }));
  }

  getOptions(): Required<Omit<BargeInV13Options, 'bargeInV12'>> & { bargeInV12: BargeInV12Options } {
    return { ...this.options, bargeInV12: { ...this.options.bargeInV12 } };
  }

  getController(): BargeInV11Controller {
    return this.controller;
  }

  getContext(): InterruptContextV12 {
    return this.context;
  }

  getScope(): CancelScopeV13 {
    return this.scope;
  }

  /** Wire (or unwire) the TTS queue flushed on every cut. */
  setTtsQueue(queue: BargeInV13TtsQueueLike | null): void {
    this.ttsQueue = queue;
  }

  /** Feed one partial-STT word the user spoke while interrupting (goes to the v12 record). */
  noteUserWord(word: string, atMs: number, confidence = 1): void {
    this.context.noteUserWord(word, atMs, confidence);
  }

  /** The agent starts thinking (a reply is being generated — cancellable work may be registered). */
  beginThinking(atMs: number): void {
    this.thinking = true;
    // Settle any previous interrupt first: tick settles
    // interrupted → cooldown → listening on the virtual clock.
    const state = this.controller.getState();
    if (state === 'interrupted' || state === 'cooldown') this.controller.tick(atMs + 60000);
    this.controller.startListening(atMs);
    this.controller.beginThinking(atMs);
  }

  /**
   * Arm a reply for barge-in: the full text plus how long each
   * char takes to speak. The controller tracks which word is
   * playing; `advancePlayed(ms)` moves the playhead.
   */
  beginSpeaking(replyText: string, atMs: number, msPerChar = 55): void {
    const words: BargeInV11Word[] = splitWordsV11(replyText, replyText.length * msPerChar);
    const state = this.controller.getState();
    if (state === 'interrupted' || state === 'cooldown') this.controller.tick(atMs + 60000);
    const settled = this.controller.getState();
    if (settled === 'idle') {
      this.controller.startListening(atMs);
      this.controller.beginThinking(atMs);
    } else if (settled === 'listening') {
      this.controller.beginThinking(atMs);
    }
    this.controller.beginSpeaking(words, atMs);
    this.speaking = true;
    this.thinking = false;
  }

  /** Move the playhead forward (ms of audio actually played). */
  advancePlayed(ms: number): void {
    this.controller.advancePlayed(ms);
  }

  /** The reply finished on its own: disarm (played text stays in the transcript via the record). */
  finishSpeaking(atMs: number): void {
    this.controller.finishSpeaking(atMs);
    this.speaking = false;
    this.thinking = false;
  }

  /** Text the user has actually heard (played parts of cut replies, joined). */
  getPlayedTranscript(): string {
    return this.playedTranscript.join(' ');
  }

  /** Last interrupted utterance, or null when none. */
  getLastInterrupt(): InterruptedUtteranceV12 | null {
    return this.context.getLast();
  }

  /** Last cut result (from `cutNow` or `recordObservedCut`), or null when none. */
  getLastCut(): BargeInV13CutResult | null {
    return this.lastCut;
  }

  /**
   * Decide whether a VAD speech-start cuts the reply.
   * Pure with respect to the gate (the counters are updated by
   * the caller path, `onVadSpeechStart`).
   */
  decideCut(input: { speechMs: number; confidence?: number; echoOnly?: boolean; atMs: number }): BargeInV13CutDecision {
    if (input.echoOnly && this.options.ignoreEchoOnly) {
      return { cut: false, reason: 'echo-only speech — ignored' };
    }
    if (!this.speaking && !this.thinking) {
      return { cut: false, reason: 'agent is not speaking or thinking — nothing to cut' };
    }
    const confidence = input.confidence ?? 1;
    if (confidence < this.options.minConfidence) {
      return { cut: false, reason: `confidence ${confidence} below minimum ${this.options.minConfidence}` };
    }
    if (this.options.policy === 'after-min-speech' && input.speechMs < this.options.minSpeechMs) {
      return { cut: false, reason: `only ${input.speechMs} ms of speech, need ${this.options.minSpeechMs} ms` };
    }
    if (this.options.policy === 'confirm') {
      return { cut: false, reason: 'policy is confirm — the host must call cutNow()' };
    }
    if (this.lastCutAtMs !== null && input.atMs - this.lastCutAtMs < this.options.cooldownMs) {
      return { cut: false, reason: `in cooldown (${input.atMs - this.lastCutAtMs} ms since the last cut)` };
    }
    return { cut: true, reason: 'VAD speech-start while the agent is speaking' };
  }

  /**
   * Feed a VAD speech-start. Returns the cut result when the
   * gate allowed a cut, or null when it did not.
   */
  onVadSpeechStart(input: { atMs: number; speechMs: number; confidence?: number; echoOnly?: boolean }): BargeInV13CutResult | null {
    this.speechStarts += 1;
    this.sink?.({ kind: 'speech-start', atMs: input.atMs, speechMs: input.speechMs, confidence: input.confidence ?? 1 });
    const decision = this.decideCut(input);
    if (!decision.cut) {
      this.ignored += 1;
      if (decision.reason.startsWith('echo-only')) this.echoIgnored += 1;
      else if (decision.reason.startsWith('agent is not speaking')) this.notSpeaking += 1;
      else this.gated += 1;
      this.sink?.({ kind: 'cut-gated', atMs: input.atMs, reason: decision.reason });
      return null;
    }
    return this.cutNow(input.atMs, 'vad-speech-start');
  }

  /**
   * Cut now, unconditionally (explicit path). Flushes the TTS
   * queue, cancels the scope, interrupts the controller and
   * records the v12 context. Returns null when there is nothing
   * to cut.
   */
  cutNow(atMs: number, reason = 'explicit'): BargeInV13CutResult | null {
    if (!this.speaking && !this.thinking) return null;
    const wasThinking = this.thinking;
    const scopeResult = this.scope.cancelAll(atMs, reason);
    const ttsFlush = this.ttsQueue ? this.ttsQueue.cancelPending() : null;
    const receipt = this.controller.interrupt(atMs);
    return this.recordCut({ receipt, scope: scopeResult, ttsFlush, wasThinking, atMs });
  }

  /**
   * Record a cut the *inner* session already made (its own
   * VAD policy cut the reply): cancel the stale scope, flush
   * the TTS queue and record the v12 context from the inner
   * receipt, without re-interrupting this engine's controller.
   * Returns null when the receipt says nothing was cut.
   */
  recordObservedCut(input: {
    receipt: BargeInV11InterruptResult;
    tts: TtsStreamCancelResult;
    replyText: string;
    atMs: number;
    reason?: string;
  }): BargeInV13CutResult | null {
    if (!input.receipt.interrupted) return null;
    const wasThinking = this.thinking;
    const scopeResult = this.scope.cancelAll(input.atMs, input.reason ?? 'inner-barge-in');
    const ttsFlush = this.ttsQueue ? this.ttsQueue.cancelPending() : input.tts;
    // The inner session already owns this cut: reset this
    // engine's controller to idle (no second interrupt) so the
    // next beginSpeaking arms cleanly.
    this.controller.endCall(input.atMs);
    return this.recordCut({
      receipt: input.receipt,
      scope: scopeResult,
      ttsFlush,
      wasThinking,
      atMs: input.atMs,
      replyText: input.replyText,
    });
  }

  private recordCut(input: {
    receipt: BargeInV11InterruptResult;
    scope: CancelScopeV13Result;
    ttsFlush: TtsStreamCancelResult | null;
    wasThinking: boolean;
    atMs: number;
    replyText?: string;
  }): BargeInV13CutResult {
    const { receipt, scope: scopeResult, ttsFlush } = input;
    let record: InterruptedUtteranceV12 | null = null;
    if (receipt.interrupted) {
      const replyText = (input.replyText ?? [...receipt.wordsPlayed, ...receipt.wordsDiscarded].join(' ')).trim();
      record = this.context.recordInterrupt({
        receipt,
        tts: ttsFlush ?? { cancelled: false, chunksCancelled: 0, charsDiscarded: 0, cutPlaying: false, cutChunkText: '', playedMs: receipt.playedMs, discardedMs: receipt.discardedMs, atMs: input.atMs },
        replyText,
      });
      if (receipt.wordsPlayed.length > 0) {
        this.playedTranscript.push(receipt.wordsPlayed.join(' '));
        this.playedCharsKept += receipt.wordsPlayed.join(' ').length;
      }
    }
    this.ttsCharsDiscarded += ttsFlush?.charsDiscarded ?? 0;
    this.staleWorkCancelled += scopeResult.cancelled;
    this.cuts += 1;
    this.lastCutAtMs = input.atMs;
    this.speaking = false;
    this.thinking = false;
    const result: BargeInV13CutResult = {
      atMs: input.atMs,
      receipt,
      record,
      scope: scopeResult,
      ttsFlush,
      playedText: receipt.wordsPlayed.join(' '),
      wasThinking: input.wasThinking,
    };
    this.lastCut = result;
    this.sink?.({ kind: 'cut', result });
    return result;
  }

  getStats(): BargeInV13Stats {
    return {
      speechStarts: this.speechStarts,
      cuts: this.cuts,
      ignored: this.ignored,
      gated: this.gated,
      notSpeaking: this.notSpeaking,
      echoIgnored: this.echoIgnored,
      lastCutAtMs: this.lastCutAtMs,
      playedCharsKept: this.playedCharsKept,
      ttsCharsDiscarded: this.ttsCharsDiscarded,
      staleWorkCancelled: this.staleWorkCancelled,
      scope: this.scope.getStats(),
      context: this.context.getStats(),
    };
  }

  reset(): void {
    this.controller.endCall(0);
    this.context.reset();
    this.scope.reset();
    this.ttsQueue = null;
    this.speaking = false;
    this.thinking = false;
    this.lastCutAtMs = null;
    this.playedTranscript = [];
    this.lastCut = null;
    this.speechStarts = 0;
    this.cuts = 0;
    this.ignored = 0;
    this.gated = 0;
    this.notSpeaking = 0;
    this.echoIgnored = 0;
    this.playedCharsKept = 0;
    this.ttsCharsDiscarded = 0;
    this.staleWorkCancelled = 0;
  }
}

/** Create a barge-in engine (factory). */
export function createBargeInEngineV13(options: BargeInV13Options = {}, sink: BargeInV13EventSink | null = null): BargeInEngineV13 {
  return new BargeInEngineV13(options, sink);
}

/** One-line summary of barge-in engine stats. */
export function bargeInV13Summary(stats: BargeInV13Stats): string {
  return (
    `Barge-in v13: ${stats.cuts} cuts / ${stats.speechStarts} speech-starts ` +
    `(${stats.ignored} ignored: ${stats.gated} gated, ${stats.notSpeaking} not speaking, ${stats.echoIgnored} echo), ` +
    `played kept ${stats.playedCharsKept} chars, TTS discarded ${stats.ttsCharsDiscarded} chars, ` +
    `stale work cancelled ${stats.staleWorkCancelled}`
  );
}

/** Barge-in engine stats as Markdown (for the diagnostics panel). */
export function bargeInV13Markdown(stats: BargeInV13Stats): string {
  const lines = [
    '## Barge-in v13 (engine)',
    '',
    `- speech-starts: ${stats.speechStarts}, cuts: ${stats.cuts}, ignored: ${stats.ignored}`,
    `- gated: ${stats.gated}, not speaking: ${stats.notSpeaking}, echo ignored: ${stats.echoIgnored}`,
    `- last cut: ${stats.lastCutAtMs === null ? '-' : `${stats.lastCutAtMs} ms`}`,
    `- played kept: ${stats.playedCharsKept} chars, TTS discarded: ${stats.ttsCharsDiscarded} chars`,
    `- stale work cancelled: ${stats.staleWorkCancelled}, scope pending: ${stats.scope.pending}`,
    `- interrupt context: ${stats.context.interrupts} interrupts ` +
      `(continue ${stats.context.byStrategy.continue}, restart ${stats.context.byStrategy.restart}, ` +
      `summarize ${stats.context.byStrategy.summarize}, drop ${stats.context.byStrategy.drop})`,
  ];
  return lines.join('\n');
}

/** Re-export the resume strategy type for callers that only import this module. */
export type { BargeInV12ResumeStrategy };
