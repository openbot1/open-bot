/**
 * Voice session v17 (v1.18, Đội T5 — voice v17).
 *
 * The session is the conductor for one realtime voice
 * conversation, wiring the v17 pieces together in the order a real
 * turn flows:
 *
 *   connect → listening → (VAD speech) → thinking → speaking
 *             → (barge-in) → interrupted → resume / restart / …
 *
 *   feedAudioFrame() — 20 ms PCM16 frames go to the VAD v5
 *                      (speech / silence / noise, debounced) and,
 *                      while the agent speaks, to the barge-in v5
 *                      engine. A confirmed user burst cuts the TTS
 *                      stream *now*; the resume plan (resume /
 *                      restart / summarise / drop) is applied
 *                      automatically when `autoResume` is on, or
 *                      held for an explicit `resumeAfterCut()`.
 *   feedTranscript() — STT partials go to the semantic turn-taking
 *                      v4 detector (v16, reused — it already owns
 *                      completeness + silence gap + max-wait); when
 *                      it ends a turn the session asks the injected
 *                      reply function for a reply and speaks it
 *                      sentence by sentence through TTS streaming
 *                      v3 (first sentence plays while later ones
 *                      are still arriving; urgent sentences jump
 *                      the queue).
 *   turn-taking      — every state change runs through the v17
 *                      turn-taking machine (listening / thinking /
 *                      speaking / interrupted / idle / closed) with
 *                      its watchdog: a stuck thinking / speaking /
 *                      interrupted state recovers to listening
 *                      instead of holding the floor forever.
 *   voice profiles   — the voice for a turn resolves per user +
 *                      bot + context from the shared v17 profile
 *                      store, with the fallback chain and a
 *                      per-user default; the session never hard-codes
 *                      a voice.
 *
 * States come from the turn-taking machine; `closed` ends the
 * session. The reply function is injected (`replyFor`); the
 * default is a scripted echo. The LLM itself is never called here
 * and the STT is likewise injected as transcript text: the session
 * never touches a mic or a sound card.
 *
 * All clocks are virtual (`nowMs`, starts at 0); `tick(ms)`
 * advances the TTS stream, the turn-taking watchdog and the
 * barge-in capture window together.
 * `VoiceSessionManagerV17` keeps sessions by id for the tools
 * layer and owns one shared voice-profile store.
 */

import { VadV17, createVadV17, type VadV17Options } from './vadV17';
import { BargeInEngineV17, createBargeInEngineV17, type BargeInV17CutRecord, type BargeInV17Options } from './bargeInV17';
import { TtsStreamV17, createTtsStreamV17, splitSentencesV17, type TtsStreamV17Options, type TtsV17ChunkPriority } from './ttsStreamV17';
import { TurnTakingMachineV17, createTurnTakingMachineV17, type TurnTakingV17Options, type TurnTakingV17State } from './turnTakingV17';
import { VoiceProfileStoreV17, createVoiceProfileStoreV17, type VoiceProfileV17Context } from './voiceProfilesV17';
import { SmartTurnDetectorV16, createSmartTurnDetectorV16 } from '../voiceV16/smartTurnV16';
import type { SmartTurnV16Options } from '../voiceV16/smartTurnV16';
import { syntheticFrameV15 } from '../voiceV15/bargeInV15';
import type { VoiceProfileV15 } from '../voiceV15/ttsStreamV15';

export type VoiceSessionV17State = TurnTakingV17State;

export type VoiceSessionV17EventKind =
  | 'state'
  | 'connected'
  | 'turn-end'
  | 'reply'
  | 'barge-in'
  | 'resume-plan'
  | 'resumed'
  | 'prompt'
  | 'vad-noise'
  | 'vad-segment'
  | 'recovered'
  | 'error';

export interface VoiceSessionV17Event {
  kind: VoiceSessionV17EventKind;
  atMs: number;
  message?: string;
  text?: string;
  cut?: BargeInV17CutRecord;
  reason?: string;
  resumeTurnId?: string;
}

export type VoiceSessionV17Sink = (event: VoiceSessionV17Event) => void;

export interface VoiceSessionV17Options {
  botId?: string;
  userId?: string;
  language?: string;
  /** Voice context for this session (default 'chat'). */
  voiceContext?: VoiceProfileV17Context;
  /** Reply function (the "brain"); default echoes the user text. */
  replyFor?: (text: string) => string | Promise<string>;
  /** Apply the barge-in resume plan at once (default true). */
  autoResume?: boolean;
  /** Shared profile store (the manager's when omitted). */
  profiles?: VoiceProfileStoreV17;
  vad?: VadV17Options;
  bargeIn?: BargeInV17Options;
  ttsStream?: TtsStreamV17Options;
  turnTaking?: TurnTakingV17Options;
  smartTurn?: SmartTurnV16Options;
}

export function defaultVoiceSessionV17Options(): Required<Omit<VoiceSessionV17Options, 'replyFor' | 'profiles' | 'vad' | 'bargeIn' | 'ttsStream' | 'turnTaking' | 'smartTurn' | 'userId'>> {
  return {
    botId: 'default-bot',
    language: 'vi',
    voiceContext: 'chat',
    autoResume: true,
  };
}

export interface VoiceSessionV17Turn {
  id: string;
  userText: string;
  replyText: string;
  atMs: number;
  endToEndMs: number;
  bargeIn: boolean;
  /** What the agent had said before the cut ('' when uninterrupted). */
  spokenBeforeCut?: string;
  /** Resume action applied after the cut (when interrupted). */
  resumeAction?: string;
}

export interface VoiceSessionV17Stats {
  state: VoiceSessionV17State;
  turns: number;
  bargeIns: number;
  resumes: number;
  restarts: number;
  summarises: number;
  drops: number;
  vad: ReturnType<VadV17['stats']>;
  bargeIn: ReturnType<BargeInEngineV17['stats']>;
  smartTurn: ReturnType<SmartTurnDetectorV16['stats']>;
  tts: ReturnType<TtsStreamV17['stats']>;
  turnTaking: ReturnType<TurnTakingMachineV17['getStats']>;
}

export class VoiceSessionV17 {
  readonly id: string;
  readonly botId: string;
  readonly userId: string | undefined;
  readonly language: string;
  readonly voiceContext: VoiceProfileV17Context;
  readonly profiles: VoiceProfileStoreV17;
  readonly vad: VadV17;
  readonly bargeIn: BargeInEngineV17;
  readonly smartTurn: SmartTurnDetectorV16;
  readonly tts: TtsStreamV17;
  readonly turnTaking: TurnTakingMachineV17;
  private readonly sink: VoiceSessionV17Sink | undefined;
  private readonly replyFor: (text: string) => string | Promise<string>;
  private readonly autoResume: boolean;
  private nowMs = 0;
  private turnCounter = 0;
  private readonly turns: VoiceSessionV17Turn[] = [];
  private readonly events: VoiceSessionV17Event[] = [];
  private turnStartedAtMs = 0;
  private pendingUserText = '';
  private currentTurnId = '';
  private lastCut: BargeInV17CutRecord | undefined;
  private pendingPlan: BargeInV17CutRecord | undefined;

  constructor(id: string, options: VoiceSessionV17Options = {}, sink?: VoiceSessionV17Sink) {
    const defaults = defaultVoiceSessionV17Options();
    this.id = id;
    this.botId = options.botId ?? defaults.botId;
    this.userId = options.userId;
    this.language = options.language ?? defaults.language;
    this.voiceContext = options.voiceContext ?? defaults.voiceContext;
    this.autoResume = options.autoResume ?? defaults.autoResume;
    this.sink = sink;
    this.replyFor = options.replyFor ?? ((text: string) => `Bạn vừa nói: ${text}`);
    this.profiles = options.profiles ?? createVoiceProfileStoreV17(this.botId);
    this.turnTaking = createTurnTakingMachineV17(
      { initialState: 'idle', ...(options.turnTaking ?? {}) },
      (event) => {
        if (event.kind === 'turn-state') {
          this.emit({ kind: 'state', atMs: event.transition.atMs, message: `state=${event.transition.to}` });
        }
        if (event.kind === 'turn-prompt') {
          this.emit({ kind: 'prompt', atMs: event.atMs, text: 'Bạn còn đó không?', message: event.reason });
        }
        if (event.kind === 'turn-recovered') {
          this.emit({ kind: 'recovered', atMs: event.transition.atMs, reason: event.transition.reason, message: `Recovered stuck state → listening (${event.transition.reason}).` });
        }
      },
    );
    this.vad = createVadV17(
      { calibrationFrames: 0, ...(options.vad ?? {}) },
      (event) => {
        if (event.kind === 'speech-start') {
          this.turnTaking.handle({ kind: 'vad-speech-start', atMs: event.atMs });
        }
        if (event.kind === 'speech-end') {
          this.turnTaking.handle({ kind: 'vad-speech-end', atMs: event.atMs });
        }
        if (event.kind === 'noise-burst') {
          this.turnTaking.handle({ kind: 'vad-noise', atMs: event.atMs });
          this.emit({ kind: 'vad-noise', atMs: event.atMs, message: 'Sustained room noise — not user speech.' });
        }
        if (event.kind === 'segment' && event.segment?.class === 'speech') {
          this.emit({ kind: 'vad-segment', atMs: event.atMs, text: `${event.segment.class} ${event.segment.durationMs} ms`, message: `Speech segment: ${event.segment.durationMs} ms, ${event.segment.frames} frames.` });
        }
      },
    );
    this.bargeIn = createBargeInEngineV17(
      options.bargeIn ?? {},
      {
        stopTts: (atMs) => {
          const cancelled = this.tts.cancelUnplayed(atMs);
          return { spokenText: this.tts.spokenText(), remainingText: cancelled.cancelledText };
        },
        discardLlm: () => 0,
      },
      (event) => {
        if (event.kind === 'cut' && event.receipt && event.plan) {
          this.onCut({ receipt: event.receipt, plan: event.plan });
        }
      },
    );
    this.smartTurn = createSmartTurnDetectorV16(
      {
        language: this.language === 'vi' ? 'vi' : this.language === 'en' ? 'en' : 'auto',
        ...(options.smartTurn ?? {}),
      },
      (event) => {
        if (event.kind === 'end' || event.kind === 'timeout') void this.onTurnEnd(event.text, event.atMs);
        if (event.kind === 'prompt') this.emit({ kind: 'prompt', atMs: event.atMs, text: event.text, message: 'User seems to be still thinking; prompting.' });
      },
    );
    this.tts = createTtsStreamV17(undefined, options.ttsStream ?? {}, (event) => {
      if (event.kind === 'done') {
        this.turnTaking.handle({ kind: 'reply-done', atMs: event.atMs });
      }
      if (event.kind === 'sentence-queued' && this.turnTaking.getState() === 'speaking') {
        this.turnTaking.handle({ kind: 'sentence-end', atMs: event.atMs });
      }
    });
  }

  getState(): VoiceSessionV17State {
    return this.turnTaking.getState();
  }

  now(): number {
    return this.nowMs;
  }

  /** Voice profile resolved for this turn (user + bot + context). */
  resolveProfile(): { profile: VoiceProfileV15; via: string } {
    const resolved = this.profiles.resolve({
      ...(this.userId !== undefined ? { userId: this.userId } : {}),
      botId: this.botId,
      context: this.voiceContext,
      language: this.language,
    });
    return { profile: resolved.profile, via: resolved.via };
  }

  async connect(): Promise<void> {
    if (this.getState() !== 'idle' && this.getState() !== 'closed') return;
    if (this.getState() === 'closed') this.turnTaking.reset('reconnect');
    this.turnTaking.handle({ kind: 'connect', atMs: this.nowMs });
    this.emit({ kind: 'connected', atMs: this.nowMs, message: 'Voice session v17 connected (mock transport).' });
  }

  disconnect(reason = 'client-close'): void {
    if (this.getState() === 'closed') return;
    if (this.tts.isSpeaking()) this.tts.cancel(this.nowMs);
    this.turnTaking.handle({ kind: 'disconnect', atMs: this.nowMs, reason });
  }

  /** Advance the virtual clock for every sub-clock in the session. */
  tick(ms: number): void {
    this.nowMs += ms;
    this.tts.tick(ms);
    this.turnTaking.tick(this.nowMs);
    this.bargeIn.tick(this.nowMs);
    this.smartTurn.tick(this.nowMs);
  }

  /** Feed one 20 ms PCM16 mic frame (VAD + barge-in detection). */
  feedAudioFrame(frame: Int16Array, echo = false): void {
    const state = this.getState();
    if (state !== 'listening' && state !== 'speaking' && state !== 'interrupted') return;
    this.vad.feed(frame, this.nowMs, echo);
    if (state === 'speaking') {
      this.bargeIn.setTtsLevel(0.12);
      this.bargeIn.feed({ frame, atMs: this.nowMs, echo });
    }
  }

  /** Feed an STT partial transcript (smart turn + interruption capture). */
  feedTranscriptPartial(text: string): void {
    const state = this.getState();
    if (state !== 'listening' && state !== 'speaking' && state !== 'interrupted') return;
    this.pendingUserText = text;
    this.smartTurn.feedPartial(text, this.nowMs);
    this.bargeIn.feedInterruptingText(text, this.nowMs);
  }

  /** Feed silence (ms) — lets the smart-turn detector end the turn. */
  feedSilence(ms: number): void {
    const state = this.getState();
    if (state !== 'listening' && state !== 'speaking') return;
    this.smartTurn.feedSilence(ms, this.nowMs);
    this.tick(0);
  }

  /** Feed a final STT transcript (drives a full turn when it ends). */
  feedTranscriptFinal(text: string): void {
    const state = this.getState();
    if (state !== 'listening' && state !== 'speaking' && state !== 'interrupted') return;
    this.pendingUserText = text;
    const out = this.smartTurn.feedPartial(text, this.nowMs);
    if (out && out.decision === 'end') {
      this.smartTurn.feedSilence(out.requiredSilenceMs, this.nowMs);
    }
  }

  /** Speak a reply now, sentence by sentence (TTS streaming v3). */
  async speakReply(text: string, priority: TtsV17ChunkPriority = 'normal'): Promise<void> {
    const state = this.getState();
    if (state !== 'listening' && state !== 'thinking' && state !== 'speaking') return;
    const { profile } = this.resolveProfile();
    const lastTurn = this.turns[this.turns.length - 1];
    this.turnCounter += 1;
    this.currentTurnId = lastTurn?.id ?? `turn-${this.turnCounter}`;
    this.bargeIn.beginAgentTurn(this.currentTurnId, this.pendingUserText, text, this.nowMs);
    this.turnTaking.handle({ kind: 'reply-start', atMs: this.nowMs });
    if (this.tts.isSpeaking() || this.tts.isPaused()) this.tts.cancel(this.nowMs);
    this.tts.beginUtterance(profile, this.nowMs);
    const sentences = splitSentencesV17(text);
    const feed = sentences.length > 0 ? sentences : [text];
    for (const sentence of feed) {
      this.tts.feedSentence(sentence, priority, this.nowMs);
    }
    this.tts.endUtterance();
  }

  /** Interrupt the agent (barge-in): stop TTS now, keep the spoken prefix, plan the resume. */
  interrupt(atMs: number, interruptingText?: string): BargeInV17CutRecord | undefined {
    if (this.getState() !== 'speaking') return undefined;
    const record = this.bargeIn.interrupt(atMs, interruptingText);
    if (record) this.lastCut = record;
    return record;
  }

  lastCutReceipt(): BargeInV17CutRecord | undefined {
    return this.lastCut;
  }

  /** The resume plan waiting for an explicit resume (null when auto-resume is on). */
  pendingResumePlan(): BargeInV17CutRecord | undefined {
    return this.pendingPlan;
  }

  /**
   * Apply the waiting resume plan (only when autoResume is off):
   * resume → speak the remaining text; restart → fresh reply to
   * the interruption; summarise → recap + remainder; drop → back
   * to listening.
   */
  async resumeAfterCut(): Promise<void> {
    const record = this.pendingPlan;
    if (!record) return;
    this.pendingPlan = undefined;
    await this.applyPlan(record);
  }

  turnsList(): VoiceSessionV17Turn[] {
    return [...this.turns];
  }

  eventsList(): VoiceSessionV17Event[] {
    return [...this.events];
  }

  stats(): VoiceSessionV17Stats {
    const bargeInStats = this.bargeIn.stats();
    return {
      state: this.getState(),
      turns: this.turns.length,
      bargeIns: bargeInStats.cuts,
      resumes: bargeInStats.resumes,
      restarts: bargeInStats.restarts,
      summarises: bargeInStats.summarises,
      drops: bargeInStats.drops,
      vad: this.vad.stats(),
      bargeIn: bargeInStats,
      smartTurn: this.smartTurn.stats(),
      tts: this.tts.stats(),
      turnTaking: this.turnTaking.getStats(),
    };
  }

  summary(): string {
    const s = this.stats();
    return `voice session v17 ${this.id}: state=${s.state} turns=${s.turns} ` +
      `barge-ins=${s.bargeIns} (resume ${s.resumes}, restart ${s.restarts}, summarise ${s.summarises}, drop ${s.drops}) ` +
      `first-chunk=${s.tts.averageFirstChunkLatencyMs}ms p95=${s.tts.p95FirstChunkLatencyMs}ms`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      `## Voice session v17 — ${this.id}`,
      '',
      `- Bot: \`${this.botId}\`${this.userId !== undefined ? `; user: \`${this.userId}\`` : ''}; language: \`${this.language}\`; context: \`${this.voiceContext}\`; state: \`${s.state}\``,
      `- Turns: ${s.turns}; barge-ins: ${s.bargeIns} (resume ${s.resumes}, restart ${s.restarts}, summarise ${s.summarises}, drop ${s.drops})`,
      `- VAD v5: ${s.vad.frames} frames (${s.vad.speechFrames} speech, ${s.vad.noiseFrames} noise, ${s.vad.silenceFrames} silence), ${s.vad.segments} segments, ${s.vad.noiseBursts} noise bursts`,
      `- TTS v3: ${s.tts.chunksSpoken} chunks spoken, ${s.tts.chunksCancelled} cancelled, ${s.tts.chunksPreempted} preempted, avg first-chunk ${s.tts.averageFirstChunkLatencyMs} ms (p95 ${s.tts.p95FirstChunkLatencyMs} ms), underruns ${s.tts.underruns}`,
      `- Turn-taking v5: ${s.turnTaking.transitions} transitions, ${s.turnTaking.rejected} rejected, ${s.turnTaking.timeouts} timeouts, ${s.turnTaking.recoveries} recoveries, ${s.turnTaking.prompts} prompts`,
      '',
      '### Turns',
      '',
    ];
    for (const turn of this.turns) {
      lines.push(`- #${turn.id} @${turn.atMs} ms (${turn.endToEndMs} ms${turn.bargeIn ? ', interrupted' : ''}${turn.resumeAction ? `, ${turn.resumeAction}` : ''}): “${turn.userText}” → “${turn.replyText}”` +
        (turn.spokenBeforeCut ? ` (cut after “${turn.spokenBeforeCut}”)` : ''));
    }
    lines.push('');
    return lines.join('\n');
  }

  private emit(event: VoiceSessionV17Event): void {
    this.events.push(event);
    this.sink?.(event);
  }

  private onCut(record: BargeInV17CutRecord): void {
    this.lastCut = record;
    const turn = this.turns[this.turns.length - 1];
    if (turn && turn.id === record.receipt.context.turnId) {
      turn.bargeIn = true;
      turn.spokenBeforeCut = record.receipt.context.spokenText;
      turn.resumeAction = record.plan.action;
    }
    this.turnTaking.handle({ kind: 'barge-in', atMs: record.receipt.atMs });
    this.emit({ kind: 'barge-in', atMs: record.receipt.atMs, cut: record, message: `Interrupted after “${record.receipt.context.spokenText}” — plan: ${record.plan.action}.` });
    this.emit({ kind: 'resume-plan', atMs: record.receipt.atMs, cut: record, message: record.plan.reason });
    if (this.autoResume) {
      void this.applyPlan(record);
    } else {
      this.pendingPlan = record;
    }
  }

  private async applyPlan(record: BargeInV17CutRecord): Promise<void> {
    const plan = record.plan;
    this.turnTaking.handle({ kind: 'vad-speech-start', atMs: this.nowMs, reason: 'resume-after-cut' });
    switch (plan.action) {
      case 'resume':
        if (plan.resumeText) {
          await this.speakReply(plan.resumeText);
          this.emit({ kind: 'resumed', atMs: this.nowMs, text: plan.resumeText, resumeTurnId: record.receipt.context.turnId, message: 'Resumed the reply from the cut point.' });
        }
        // No resume text: the vad-speech-start above already put
        // the machine back in listening.
        break;
      case 'restart': {
        const reply = await this.replyFor(plan.restartPrompt || this.pendingUserText);
        await this.speakReply(reply, 'urgent');
        this.emit({ kind: 'resumed', atMs: this.nowMs, text: reply, resumeTurnId: record.receipt.context.turnId, message: 'Restarted with a fresh reply to the interruption.' });
        break;
      }
      case 'summarise':
        if (plan.resumeText) {
          await this.speakReply(plan.resumeText);
          this.emit({ kind: 'resumed', atMs: this.nowMs, text: plan.resumeText, resumeTurnId: record.receipt.context.turnId, message: 'Recapped the spoken prefix, then continued.' });
        }
        break;
      case 'drop':
        this.emit({ kind: 'resumed', atMs: this.nowMs, resumeTurnId: record.receipt.context.turnId, message: 'Dropped the remainder — back to listening.' });
        break;
      default:
        break;
    }
  }

  private async onTurnEnd(userText: string, atMs: number): Promise<void> {
    if (this.turnStartedAtMs === 0) this.turnStartedAtMs = atMs;
    const reply = await this.replyFor(userText);
    const endToEndMs = Math.max(0, atMs - this.turnStartedAtMs);
    const turnId = `turn-${this.turns.length + 1}`;
    this.turns.push({
      id: turnId,
      userText,
      replyText: reply,
      atMs,
      endToEndMs: endToEndMs + 120,
      bargeIn: false,
    });
    this.turnStartedAtMs = 0;
    this.pendingUserText = '';
    if (reply.trim().endsWith('?')) this.smartTurn.noteAgentQuestion();
    this.smartTurn.reset();
    this.emit({ kind: 'turn-end', atMs, text: userText });
    this.emit({ kind: 'reply', atMs, text: reply });
    this.turnTaking.handle({ kind: 'vad-speech-end', atMs, reason: 'turn-end' });
    await this.speakReply(reply);
  }
}

export function createVoiceSessionV17(
  id: string,
  options: VoiceSessionV17Options = {},
  sink?: VoiceSessionV17Sink,
): VoiceSessionV17 {
  return new VoiceSessionV17(id, options, sink);
}

export class VoiceSessionManagerV17 {
  private readonly sessions = new Map<string, VoiceSessionV17>();
  readonly profiles = new VoiceProfileStoreV17();

  constructor(seedPresetsForBot?: string) {
    if (seedPresetsForBot) {
      const seeded = createVoiceProfileStoreV17(seedPresetsForBot);
      for (const preset of seeded.list()) this.profiles.set(preset);
    }
  }

  create(id: string, options: VoiceSessionV17Options = {}, sink?: VoiceSessionV17Sink): VoiceSessionV17 {
    if (this.sessions.has(id)) throw new Error(`voice session already exists: ${id}`);
    const session = new VoiceSessionV17(id, { ...options, profiles: options.profiles ?? this.profiles }, sink);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): VoiceSessionV17 | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) session.disconnect();
    return this.sessions.delete(id);
  }

  list(): VoiceSessionV17[] {
    return [...this.sessions.values()];
  }

  count(): number {
    return this.sessions.size;
  }
}

export function createVoiceSessionManagerV17(seedPresetsForBot?: string): VoiceSessionManagerV17 {
  return new VoiceSessionManagerV17(seedPresetsForBot);
}

export function voiceSessionV17Summary(session: VoiceSessionV17): string {
  return session.summary();
}

export function voiceSessionV17Markdown(session: VoiceSessionV17): string {
  return session.markdown();
}

export { syntheticFrameV15 };
