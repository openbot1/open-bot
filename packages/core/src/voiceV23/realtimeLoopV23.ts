/**
 * Realtime loop v23 for voice v23 (v1.36, Team T5).
 *
 * The other v23 modules are pieces — buffer, endpointing,
 * policy, manager, calibration. The loop is the wiring that
 * turns them into one realtime conversation:
 *
 *   - frames arrive -> adaptive buffer + endpointing energy;
 *   - the endpointing engine declares the utterance ended ->
 *     the loop drives the turn through the managed v22 session
 *     and measures the first-token latency;
 *   - a burst arrives while the agent speaks -> the v23 policy
 *     decides (grace window, backchannel rule); only a real
 *     interruption reaches the session's `feedBargeIn`, which
 *     cuts or ducks the live reply; the rollback + strategy
 *     come from the cut that actually happened;
 *   - calibration runs -> the fitted threshold is pushed into
 *     the endpointing engine and the gain into the device
 *     profile, so the next utterance benefits at once.
 *
 * The loop owns no audio and no clock: every `atMs` is
 * supplied by the caller, every frame is synthetic.
 */
import type { VoiceV22BargeInDecision, VoiceV22ReplyCut } from '../voiceV22/types';
import type { VoiceSessionV22, VoiceV22SessionOptions } from '../voiceV22/index';
import { AdaptiveJitterBufferV23, type AdaptiveBufferV23Options, type VoiceV23BufferStats } from './streamingV23';
import { EndpointingEngineV23, type EndpointingV23Options, type VoiceV23EndpointEvent } from './endpointingV23';
import {
  InterruptionPolicyV23,
  InterruptionLedgerV23,
  rollbackForCutV23,
  strategyForCutV23,
  type InterruptionV23Options,
  type VoiceV23InterruptionCandidate,
  type VoiceV23InterruptionDecision,
  type VoiceV23Rollback,
  type VoiceV23InterruptionRecord,
} from './interruptionV23';
import {
  RealtimeSessionManagerV23,
  type SessionManagerV23Options,
  type VoiceV23SessionManagerStats,
} from './sessionManagerV23';
import {
  CalibrationEngineV23,
  type CalibrationV23Options,
  type VoiceV23CalibrationInput,
  type VoiceV23CalibrationResult,
} from './calibrationV23';
import { DeviceProfileRegistryV23, type VoiceV23DeviceProfile } from './deviceProfilesV23';
import type { VoiceV23InterruptStrategy, VoiceV23LatencyAggregate, VoiceV23LatencySample, VoiceV23StreamFrame } from './types';
import { aggregateLatencyV23, round2V23 } from './types';

export interface RealtimeLoopV23Options {
  buffer?: Partial<AdaptiveBufferV23Options>;
  endpointing?: Partial<EndpointingV23Options>;
  policy?: Partial<InterruptionV23Options>;
  manager?: Partial<SessionManagerV23Options>;
  calibration?: Partial<CalibrationV23Options>;
}

export interface VoiceV23LoopTurn {
  sessionId: string;
  transcript: string;
  reply: string;
  /** ms from end of user speech to first agent audio. */
  firstTokenMs: number;
  /** ms from end of user speech to the reply being spoken. */
  totalMs: number;
  atMs: number;
}

export interface VoiceV23LoopInterruption {
  decision: VoiceV23InterruptionDecision;
  /** The decision the live session actually applied (v22 observe). */
  applied: VoiceV22BargeInDecision | null;
  cut: VoiceV22ReplyCut | null;
  rollback: VoiceV23Rollback | null;
  strategy: VoiceV23InterruptStrategy | null;
  record: VoiceV23InterruptionRecord;
}

export interface VoiceV23LoopStats {
  sessions: VoiceV23SessionManagerStats;
  turns: number;
  utterances: number;
  interruptions: number;
  meanFirstTokenMs: number;
  buffer: VoiceV23BufferStats;
  endpointState: string;
  calibrations: number;
}

export class RealtimeLoopV23 {
  readonly manager: RealtimeSessionManagerV23;
  readonly buffer: AdaptiveJitterBufferV23;
  readonly endpointing: EndpointingEngineV23;
  readonly policy: InterruptionPolicyV23;
  readonly ledger: InterruptionLedgerV23;
  readonly calibration: CalibrationEngineV23;
  readonly devices: DeviceProfileRegistryV23;
  private turns = 0;
  private utterances = 0;
  private readonly latencySamplesRecorded: VoiceV23LatencySample[] = [];
  private calibrations = 0;

  constructor(opts: RealtimeLoopV23Options = {}) {
    this.manager = new RealtimeSessionManagerV23(opts.manager);
    this.buffer = new AdaptiveJitterBufferV23(opts.buffer);
    this.endpointing = new EndpointingEngineV23(opts.endpointing);
    this.policy = new InterruptionPolicyV23(opts.policy);
    this.ledger = new InterruptionLedgerV23();
    this.calibration = new CalibrationEngineV23(opts.calibration);
    this.devices = new DeviceProfileRegistryV23();
  }

  openSession(sessionId: string, opts: VoiceV22SessionOptions = {}, atMs = 0): VoiceSessionV22 {
    return this.manager.open(sessionId, opts, atMs);
  }

  /** Push one frame: into the buffer and through endpointing energy. */
  feedFrame(frame: VoiceV23StreamFrame): { buffered: boolean; endpointEvents: VoiceV23EndpointEvent[] } {
    const buffered = this.buffer.push(frame);
    const endpointEvents = this.endpointing.feedEnergy(frame.energy ?? 0, frame.atMs);
    return { buffered, endpointEvents };
  }

  /** Feed one speech/silence flag straight to endpointing. */
  feedSpeech(isSpeech: boolean, atMs: number): VoiceV23EndpointEvent[] {
    return this.endpointing.feedSpeech(isSpeech, atMs);
  }

  /** Pull the next buffered frame for playout (null when starved). */
  pullFrame(atMs: number): VoiceV23StreamFrame | null {
    return this.buffer.pull(atMs);
  }

  /**
   * Drive one completed utterance through the managed session.
   * `speechEndAtMs` is when the user stopped speaking (from
   * endpointing); `replyAtMs` is when the first agent audio
   * would be heard; `replyEndAtMs` is when the reply finished.
   * The loop measures, it does not guess.
   */
  async completeUtterance(
    sessionId: string,
    transcript: string,
    speechEndAtMs: number,
    replyAtMs: number,
    replyEndAtMs: number,
  ): Promise<VoiceV23LoopTurn> {
    const session = this.manager.get(sessionId);
    if (session === null) throw new Error(`No session "${sessionId}"`);
    this.utterances += 1;
    const reply = await session.feedFinal(transcript, replyAtMs);
    this.turns += 1;
    const firstTokenMs = Math.max(0, replyAtMs - speechEndAtMs);
    const sample: VoiceV23LatencySample = {
      id: `v23-turn-${this.turns}`,
      firstTokenMs,
      totalMs: Math.max(firstTokenMs, replyEndAtMs - speechEndAtMs),
      jitterMs: this.buffer.jitterMs(),
    };
    this.latencySamplesRecorded.push(sample);
    return { sessionId, transcript, reply, firstTokenMs, totalMs: sample.totalMs, atMs: replyAtMs };
  }

  /**
   * Handle a burst while the agent speaks. The v23 policy is
   * the authority: an ignored burst never reaches the live
   * session. A real interruption is applied through the
   * session's `feedBargeIn`, and the rollback + strategy come
   * from the cut that actually happened.
   */
  async interrupt(
    sessionId: string,
    candidate: VoiceV23InterruptionCandidate,
    replyText: string,
    spokenChars: number,
    atMs: number,
  ): Promise<VoiceV23LoopInterruption> {
    const session = this.manager.get(sessionId);
    if (session === null) throw new Error(`No session "${sessionId}"`);
    const decision = this.policy.decide(candidate);
    if (decision.decision === 'ignore') {
      const record = this.ledger.record(decision, atMs, 0, null);
      return { decision, applied: null, cut: null, rollback: null, strategy: null, record };
    }
    const { decision: applied, cut } = await session.feedBargeIn(
      {
        atMs: candidate.atMs,
        energy: candidate.energy,
        sustainMs: candidate.sustainMs,
        words: candidate.words,
        echo: candidate.echo,
        confidence: candidate.confidence,
      },
      atMs,
    );
    // The session's own observe may still refuse (cooldown):
    // the ledger records what the session applied, not what
    // the policy wanted, so the numbers stay honest.
    const stopLatencyMs = applied === 'interrupt' ? Math.max(0, atMs - candidate.atMs) : 0;
    const rollback = cut === null ? null : rollbackForCutV23(replyText, spokenChars);
    const strategy = cut === null ? null : strategyForCutV23(cut, candidate.words, this.policy.options());
    const record = this.ledger.record(
      { ...decision, decision: applied },
      atMs,
      stopLatencyMs,
      strategy,
    );
    return { decision, applied, cut, rollback, strategy, record };
  }

  /**
   * Calibrate from samples and apply the result at once: the
   * fitted threshold goes to endpointing, the gain + threshold
   * go to the device profile.
   */
  calibrateDevice(
    deviceId: string,
    input: VoiceV23CalibrationInput,
  ): { result: VoiceV23CalibrationResult; profile: VoiceV23DeviceProfile | null; errors: string[] } {
    const result = this.calibration.calibrate(input);
    this.calibrations += 1;
    this.endpointing.setNoiseFloor(result.noiseFloor);
    const errors = this.devices.applyCalibration(deviceId, result);
    return { result, profile: this.devices.get(deviceId), errors };
  }

  latencyAggregate(firstTokenBudgetMs = 800): VoiceV23LatencyAggregate {
    return aggregateLatencyV23(this.latencySamplesRecorded, firstTokenBudgetMs);
  }

  latencySamples(): VoiceV23LatencySample[] {
    return [...this.latencySamplesRecorded];
  }

  stats(): VoiceV23LoopStats {
    return {
      sessions: this.manager.stats(),
      turns: this.turns,
      utterances: this.utterances,
      interruptions: this.ledger.stats().total,
      meanFirstTokenMs: round2V23(
        this.latencySamplesRecorded.length === 0
          ? 0
          : this.latencySamplesRecorded.reduce((a, s) => a + s.firstTokenMs, 0) / this.latencySamplesRecorded.length,
      ),
      buffer: this.buffer.stats(),
      endpointState: this.endpointing.currentState(),
      calibrations: this.calibrations,
    };
  }

  summary(): string {
    const s = this.stats();
    return `realtime loop v23: ${s.turns} turns, ${s.utterances} utterances, ${s.interruptions} interruptions, mean first-token ${s.meanFirstTokenMs}ms, endpointing ${s.endpointState}`;
  }
}

export function createRealtimeLoopV23(opts: RealtimeLoopV23Options = {}): RealtimeLoopV23 {
  return new RealtimeLoopV23(opts);
}
