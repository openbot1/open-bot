/**
 * Voice session v3 (v1.03, Team T5 — realtime voice v3).
 *
 * Composition, not a rewrite: one `VoiceSessionV2` (v1.02 — the
 * duplex call + long session + barge-in v2 + image/video media +
 * local stack) plus the four v1.03 pieces around it:
 *
 *   - `SessionCheckpointer` — the call snapshots itself every N
 *     turns / on summary / on media attach / on disconnect, so a
 *     dropped call resumes from the last checkpoint instead of
 *     starting cold. `resume()` restores the long session + the
 *     media conversation from the checkpoint and redials with
 *     resume instructions (summary + media + "continue, don't
 *     restart").
 *   - `ReconnectController` + `ResilientDialer` — the resume dial
 *     retries with backoff + jitter and reports honestly how many
 *     attempts it spent. (The inner session keeps its own redial
 *     while connected; the v3 dialer runs when the session has
 *     settled to disconnected/closed — see `resume()`.)
 *   - `MediaConversation` — audio recordings (transcribed), video
 *     frame sequences, references in speech ("this photo", "ảnh
 *     thứ hai"), per-item Q&A history. Media lives only here:
 *     `attachMedia` goes to the conversation, never to v2's own
 *     media context, so there is one store, not two.
 *   - `BargeInV3Controller` — backchannel ("uh-huh" lets the
 *     model keep talking), soft interrupt (duck first, confirm if
 *     the user keeps talking), adaptive grace. v3 owns *all*
 *     gating on the local/manual path: v2 is constructed with
 *     grace 0 / min-speech 0 so it never second-guesses a v3
 *     decision — it only executes the cancel. The session's own
 *     server-VAD path is untouched and flows through as before.
 *
 * Events: every `VoiceSessionV2` event is forwarded unchanged,
 * plus v3 kinds (`checkpoint`, `resumed`, `resume-failed`,
 * `backchannel`, `ducked`, `duck-cancelled`, `barge-in-v3`,
 * `reconnecting`). A duck is a signal as well as an act: the
 * local TTS queue is stopped here, and main ducks the provider
 * audio on the `ducked` event (this wrapper has no sink to turn
 * down). Barge-in counters restart at 0 after a resume — the
 * checkpoint's counters are reported in `getV3Stats()` under
 * `restored`, not added to the live ones.
 */
import type {
  RealtimeConfig,
  RealtimeSessionState,
} from './types';
import { VoiceSessionV2, type VoiceSessionV2Event, type VoiceSessionV2Options } from './voiceSessionV2';
import {
  SessionCheckpointer,
  type CheckpointSources,
  type VoiceCheckpointReason,
  type VoiceSessionCheckpoint,
} from './sessionCheckpoint';
import type { CheckpointStore } from './sessionCheckpoint';
import { MemoryCheckpointStore } from './sessionCheckpoint';
import {
  ReconnectController,
  ResilientDialer,
  buildResumeInstructions,
  type ReconnectControllerOptions,
} from './sessionResilience';
import {
  MediaConversation,
  type MediaConversationOptions,
  type MediaReference,
  type VoiceAudioMediaInput,
  type VoiceAudioMediaItem,
} from './mediaConversation';
import type { MediaAnswer, VoiceMediaInput, VoiceMediaItem } from './mediaContext';
import {
  BargeInV3Controller,
  buildResumePrompt,
  type BargeInV3Decision,
  type BargeInV3Options,
} from './bargeInV3';
import type { BargeInSource } from './turnTaking';
import type { LocalVoiceStack } from './localVoiceStack';
import type { VoiceTurn } from './longSession';
import type { VoiceCallToolHandlers } from './callTools';

/** Extra events the v3 wrapper emits (on top of the v2 events). */
export type VoiceSessionV3Event =
  | VoiceSessionV2Event
  | { kind: 'checkpoint'; checkpoint: VoiceSessionCheckpoint; at: number }
  | {
      kind: 'resumed';
      checkpoint: VoiceSessionCheckpoint;
      attempts: number;
      at: number;
    }
  | { kind: 'resume-failed'; error: string; attempts: number; at: number }
  | { kind: 'backchannel'; decision: BargeInV3Decision; at: number }
  | { kind: 'ducked'; decision: BargeInV3Decision; at: number }
  | { kind: 'duck-cancelled'; decision: BargeInV3Decision; at: number }
  | {
      kind: 'barge-in-v3';
      decision: BargeInV3Decision | null;
      /** Round-trip measurement when v3 decided the interrupt. */
      measurementMs: number | null;
      /** Text the model had spoken before being cut ('' when none). */
      partialText: string;
      at: number;
    }
  | { kind: 'reconnecting'; attempt: number; delayMs: number; error: string; at: number };

export type VoiceSessionV3EventSink = (event: VoiceSessionV3Event) => void;

/** Stats for the panel / diagnostics. */
export interface VoiceSessionV3Stats {
  checkpoints: ReturnType<SessionCheckpointer['getStats']>;
  reconnects: ReturnType<ReconnectController['getStats']>;
  bargeInV3: ReturnType<BargeInV3Controller['getStats']>;
  media: {
    images: number;
    videos: number;
    audio: number;
    frames: number;
    answers: number;
  };
  /** Counters restored from the last checkpoint (live counters
   *  restart at 0 after a resume — these are reported, not added). */
  restored: { turnCount: number; bargeInCount: number } | null;
  resumed: boolean;
}

export interface VoiceSessionV3Options {
  /** Options for the inner `VoiceSessionV2` (provider, turn mode,
   *  transport factory, audio source/sink, ...). The v3 wrapper
   *  forces `bargeInGraceMs: 0` / `bargeInMinSpeechMs: 0` on it —
   *  v3 owns all gating on the local/manual path. */
  v2: VoiceSessionV2Options;
  /** Checkpoint store. Defaults to a fresh in-memory store. */
  checkpointStore?: CheckpointStore;
  /** Checkpoint every N session turns. Default 10. */
  checkpointEveryTurns?: number;
  /** Checkpoint at most every N ms. Default 60_000. */
  checkpointEveryMs?: number;
  /** Reconnect policy for `resume()`. */
  resilience?: ReconnectControllerOptions;
  /** Media conversation options (describer, transcriber, ...). */
  mediaConversation?: MediaConversationOptions;
  /** Barge-in v3 options (soft interrupt, adaptive grace, ...). */
  bargeInV3?: BargeInV3Options;
  /** Local voice stack (same instance as `v2.localStack` when
   *  set) — ducking stops its TTS queue. */
  localStack?: LocalVoiceStack;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink (v2 events + v3 events). */
  onEvent?: VoiceSessionV3EventSink;
}

export class VoiceSessionV3 {
  private readonly v2: VoiceSessionV2;
  private readonly checkpointer: SessionCheckpointer;
  private readonly resilience: ReconnectController;
  private readonly dialer: ResilientDialer;
  private readonly conversation: MediaConversation;
  private readonly bargeInV3: BargeInV3Controller;
  private readonly localStack: LocalVoiceStack | undefined;
  private readonly onEvent: VoiceSessionV3EventSink | undefined;
  private readonly clock: () => number;
  private readonly provider: string;
  private baseInstructions = '';
  private lastConfig: RealtimeConfig | null = null;
  private lastSessionId = '';
  private restored: { turnCount: number; bargeInCount: number } | null = null;
  private resumed = false;
  /** The v3 decision behind the interrupt now in flight (the
   *  'interrupted' event carries no decision of its own). */
  private pendingV3Decision: BargeInV3Decision | null = null;

  constructor(options: VoiceSessionV3Options) {
    this.clock = options.clock ?? Date.now;
    this.provider = options.v2.session.provider;
    this.localStack = options.localStack ?? options.v2.localStack;
    this.conversation = new MediaConversation({
      ...(options.mediaConversation ?? {}),
      clock: this.clock,
    });
    this.checkpointer = new SessionCheckpointer({
      store: options.checkpointStore ?? new MemoryCheckpointStore(),
      everyTurns: options.checkpointEveryTurns,
      everyMs: options.checkpointEveryMs,
      clock: this.clock,
    });
    this.resilience = new ReconnectController({
      ...(options.resilience ?? {}),
      clock: this.clock,
      onEvent: (e) => {
        if (e.kind === 'reconnecting') {
          this.emit({ kind: 'reconnecting', attempt: e.attempt, delayMs: e.delayMs, error: e.error, at: e.at });
        }
      },
    });
    this.dialer = new ResilientDialer({ controller: this.resilience });
    this.bargeInV3 = new BargeInV3Controller({
      ...(options.bargeInV3 ?? {}),
      clock: this.clock,
    });
    this.onEvent = options.onEvent;
    this.v2 = new VoiceSessionV2({
      ...options.v2,
      // v3 owns gating: v2 must never second-guess a v3 decision.
      bargeInGraceMs: 0,
      bargeInMinSpeechMs: 0,
      onEvent: (e) => this.handleV2Event(e),
    });
  }

  // -- passthroughs -------------------------------------------------------

  getState(): RealtimeSessionState {
    return this.v2.getState();
  }

  isConnected(): boolean {
    return this.v2.isConnected();
  }

  getSessionId(): string {
    return this.v2.getSessionId();
  }

  getTurnCount(): number {
    return this.v2.getTurnCount();
  }

  getBargeInCount(): number {
    return this.v2.getBargeInCount();
  }

  sendAudio(frame: Uint8Array): void {
    this.v2.sendAudio(frame);
  }

  pushAudioFrame(frame: Uint8Array): void {
    this.v2.pushAudioFrame(frame);
  }

  commitAudio(): void {
    this.v2.commitAudio();
  }

  requestResponse(): void {
    this.v2.requestResponse();
  }

  sendToolResult(callId: string, output: string): void {
    this.v2.sendToolResult(callId, output);
  }

  startTalk(): boolean {
    return this.v2.startTalk();
  }

  endTalk(): boolean {
    return this.v2.endTalk();
  }

  setTurnMode(mode: Parameters<VoiceSessionV2['setTurnMode']>[0]): void {
    this.v2.setTurnMode(mode);
  }

  getLatencyStats(): ReturnType<VoiceSessionV2['getLatencyStats']> {
    return this.v2.getLatencyStats();
  }

  getHealth(): ReturnType<VoiceSessionV2['getHealth']> {
    return this.v2.getHealth();
  }

  getLongSessionTurns(): VoiceTurn[] {
    return this.v2.getLongSessionTurns();
  }

  getLongSessionStats(): ReturnType<VoiceSessionV2['getLongSessionStats']> {
    return this.v2.getLongSessionStats();
  }

  noteUserTurn(text: string, mediaIds?: string[]): VoiceTurn | null {
    const turn = this.v2.noteUserTurn(text, mediaIds);
    if (turn) this.maybeCheckpoint('turn');
    return turn;
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Open the call. Instructions are the caller's base plus the
   * media conversation block; v2 appends the long-session block.
   */
  async connect(config: RealtimeConfig): Promise<void> {
    this.baseInstructions = config.instructions ?? '';
    this.lastConfig = { ...config };
    this.lastSessionId = this.v2.getSessionId();
    await this.v2.connect({
      ...config,
      instructions: this.getSessionInstructions(),
    });
    this.lastSessionId = this.v2.getSessionId();
  }

  /** Hang up: checkpoint first, then the session dies. */
  disconnect(): void {
    this.checkpointNow('disconnect');
    try {
      void this.localStack?.stopSpeaking();
    } catch {
      // Best-effort — the session is ending either way.
    }
    this.bargeInV3.modelSpeechEnded();
    this.v2.disconnect();
  }

  dispose(): void {
    this.disconnect();
    this.v2.dispose();
  }

  // -- checkpoints + resume ---------------------------------------------------

  /** Checkpoint sources: everything the checkpointer snapshots. */
  private sources(): CheckpointSources {
    return {
      sessionId: () => this.lastSessionId || this.v2.getSessionId(),
      provider: () => this.provider,
      instructions: () => this.baseInstructions,
      turnCount: () => this.v2.getTurnCount(),
      bargeInCount: () => this.v2.getBargeInCount(),
      longSession: () => ({ snapshot: () => this.v2.snapshotLongSession() }),
      mediaItems: () => this.conversation.listMedia(),
      mediaAnswers: () => this.conversation.getAnswers(),
      bargeInInterrupts: () => this.bargeInV3.getStats().interrupts,
      bargeInIgnored: () => this.bargeInV3.getStats().ignored,
      bargeInPartials: () => this.bargeInV3.getPartialTurns(),
      conversationSnapshot: () => this.conversation.snapshot(),
    };
  }

  /** Checkpoint when due (turn / time budget). */
  maybeCheckpoint(reason: VoiceCheckpointReason): VoiceSessionCheckpoint | null {
    const cp = this.checkpointer.maybeCheckpoint(this.sources(), reason);
    if (cp) this.emit({ kind: 'checkpoint', checkpoint: cp, at: cp.createdAt });
    return cp;
  }

  /** Checkpoint now, whatever the budgets say. */
  checkpointNow(reason: VoiceCheckpointReason): VoiceSessionCheckpoint | null {
    const cp = this.checkpointer.checkpointNow(this.sources(), reason);
    if (cp) this.emit({ kind: 'checkpoint', checkpoint: cp, at: cp.createdAt });
    return cp;
  }

  /** Latest stored checkpoint for this call (null when none). */
  loadCheckpoint(): VoiceSessionCheckpoint | null {
    const id = this.lastSessionId || this.v2.getSessionId();
    return this.checkpointer.restore(id);
  }

  getCheckpointStats(): ReturnType<SessionCheckpointer['getStats']> {
    return this.checkpointer.getStats();
  }

  getReconnectStats(): ReturnType<ReconnectController['getStats']> {
    return this.resilience.getStats();
  }

  /**
   * Resume the call from a checkpoint (or the latest stored one):
   * restore the long session + the media conversation, then redial
   * with resume instructions. The session must be disconnected
   * first — resuming a live call is a no-op returning null. Pass
   * `config` when this wrapper never connected before (e.g. after
   * an app restart); otherwise the last connect config is reused.
   * The socket is always a fresh dial; only context is restored.
   * Returns the checkpoint resumed from, or null.
   */
  async resume(
    checkpoint?: VoiceSessionCheckpoint,
    config?: RealtimeConfig,
  ): Promise<VoiceSessionCheckpoint | null> {
    if (this.isConnected()) return null;
    const cp = checkpoint ?? this.loadCheckpoint();
    if (!cp) return null;
    const dialConfig = config ?? this.lastConfig;
    if (!dialConfig) return null;
    this.lastConfig = { ...dialConfig };
    if (config?.instructions !== undefined) {
      this.baseInstructions = config.instructions;
    } else if (!this.baseInstructions) {
      this.baseInstructions = cp.instructions;
    }
    this.v2.restoreLongSession(cp.longSession);
    if (cp.media.conversation) {
      this.conversation.restore(cp.media.conversation);
    } else if (cp.media.items.length > 0) {
      this.conversation.restore({ media: cp.media.items, audio: [], frames: {}, history: {} });
    }
    this.restored = { turnCount: cp.turnCount, bargeInCount: cp.bargeInCount };
    const instructions = buildResumeInstructions(this.baseInstructions, cp, {
      contextBlock: '',
      mediaBlock: this.conversation.buildConversationBlock(),
    });
    const result = await this.dialer.dialWithReconnect(() =>
      this.v2.connect({ ...this.lastConfig, instructions }),
    );
    if (!result.ok) {
      this.emit({
        kind: 'resume-failed',
        error: result.error ?? 'reconnect exhausted',
        attempts: result.attempts,
        at: this.clock(),
      });
      return null;
    }
    this.resumed = true;
    this.lastSessionId = this.v2.getSessionId();
    this.emit({ kind: 'resumed', checkpoint: cp, attempts: result.attempts, at: this.clock() });
    return cp;
  }

  // -- instructions -----------------------------------------------------------

  /** Full instructions for (re)connect: base + media conversation
   *  block (v2 appends the long-session block). */
  getSessionInstructions(): string {
    const block = this.conversation.buildConversationBlock();
    if (!block) return this.baseInstructions;
    return this.baseInstructions
      ? `${this.baseInstructions}\n\n${block}`
      : block;
  }

  getV3Stats(): VoiceSessionV3Stats {
    const media = this.conversation.listMedia();
    const audio = this.conversation.listAudio();
    const answers =
      this.conversation.getAnswers().length +
      media.reduce((n, m) => n + this.conversation.getItemHistory(m.id).length, 0) +
      audio.reduce((n, a) => n + this.conversation.getItemHistory(a.id).length, 0);
    return {
      checkpoints: this.checkpointer.getStats(),
      reconnects: this.resilience.getStats(),
      bargeInV3: this.bargeInV3.getStats(),
      media: {
        images: media.filter((m) => m.kind === 'image').length,
        videos: media.filter((m) => m.kind === 'video').length,
        audio: audio.length,
        frames: media
          .filter((m) => m.kind === 'video')
          .reduce((n, m) => n + this.conversation.listVideoFrames(m.id).length, 0),
        answers,
      },
      restored: this.restored ? { ...this.restored } : null,
      resumed: this.resumed,
    };
  }

  // -- barge-in v3 ------------------------------------------------------------

  /**
   * User speech was heard on the local / manual path. v3 decides:
   * backchannel (noted, model keeps talking), duck (playback
   * pauses — confirm with `confirmDuck`), interrupt (cancel now),
   * or ignore. Returns the decision.
   */
  noteUserSpeechV3(
    source: BargeInSource,
    opts: { speechMs?: number; transcript?: string } = {},
  ): BargeInV3Decision {
    const decision = this.bargeInV3.noteSpeech(source, opts);
    switch (decision.action) {
      case 'backchannel':
        this.emit({ kind: 'backchannel', decision, at: decision.at });
        return decision;
      case 'duck':
        try {
          void this.localStack?.stopSpeaking();
        } catch {
          // Local TTS stop is best-effort; main ducks provider audio.
        }
        this.emit({ kind: 'ducked', decision, at: decision.at });
        return decision;
      case 'interrupt':
        this.pendingV3Decision = decision;
        this.bargeInV3.cancelSent();
        this.v2.interrupt();
        return decision;
      default:
        return decision;
    }
  }

  /**
   * Resolve a pending duck: `continued: true` (the user kept
   * talking) confirms the interrupt; `false` resumes playback.
   * Returns the decision the caller should act on.
   */
  confirmDuck(continued: boolean, source: BargeInSource = 'local_vad'): BargeInV3Decision {
    const decision = this.bargeInV3.confirmDuck(continued, source);
    if (decision.action === 'interrupt') {
      this.pendingV3Decision = decision;
      this.bargeInV3.cancelSent();
      this.v2.interrupt();
      return decision;
    }
    this.emit({ kind: 'duck-cancelled', decision, at: decision.at });
    return decision;
  }

  /** UI interrupt button: same path as local speech, source manual. */
  interruptV3(): BargeInV3Decision {
    return this.noteUserSpeechV3('manual');
  }

  getBargeInV3Stats(): ReturnType<BargeInV3Controller['getStats']> {
    return this.bargeInV3.getStats();
  }

  getPartialTurns(): ReturnType<BargeInV3Controller['getPartialTurns']> {
    return this.bargeInV3.getPartialTurns();
  }

  /** "Continue from here" prompt for the turn after a cut reply. */
  buildResumePrompt(): string {
    const partial = this.bargeInV3.getPartialTurns().at(-1);
    return buildResumePrompt(partial?.text ?? '', this.bargeInV3.getV2().getResumePolicy());
  }

  /**
   * Handlers for the two v1.03 voice-call tools, bound to this
   * call: `save_checkpoint` writes a checkpoint now and reports
   * its sequence number; `recall_media` resolves the spoken
   * reference ("this photo", "the second image") and answers
   * from the attached media. Bind them into the call's toolset
   * with `createVoiceCallToolSet(handlers)` — a tool with no
   * handler bound is not runnable, so a call that never binds
   * these never offers them to the model.
   */
  createToolHandlers(): Pick<VoiceCallToolHandlers, 'save_checkpoint' | 'recall_media'> {
    return {
      save_checkpoint: () => {
        const cp = this.checkpointNow('manual');
        if (!cp) {
          return { saved: false, reason: 'No checkpoint could be written for this call.' };
        }
        return {
          saved: true,
          seq: cp.seq,
          turnCount: cp.turnCount,
          mediaItems: cp.media.items.length,
          at: cp.createdAt,
        };
      },
      recall_media: async (args) => {
        const reference = String(args.reference ?? '').trim();
        if (!reference) return { found: false, reason: 'No media reference given.' };
        const resolved = this.conversation.resolveReference(reference);
        if (!resolved) {
          return { found: false, reason: `No attached media matches "${reference}".` };
        }
        const question = String(args.question ?? '').trim() || 'Describe this.';
        const answer = await this.askAboutMedia(question, resolved.itemId);
        if (!answer) {
          return { found: false, reason: 'Could not answer about that media.' };
        }
        return {
          found: true,
          itemId: resolved.itemId,
          kind: resolved.kind,
          confidence: resolved.confidence,
          answer: answer.answer,
        };
      },
    };
  }

  // -- media conversation --------------------------------------------------------

  /** Attach image/video to the call (validated; see mediaContext). */
  attachMedia(input: VoiceMediaInput): ReturnType<MediaConversation['attach']> {
    const result = this.conversation.attach(input);
    if (result.ok) {
      this.emit({ kind: 'media-attached', item: { ...result.item }, at: this.clock() });
      this.maybeCheckpoint('media');
    }
    return result;
  }

  removeMedia(id: string): boolean {
    return this.conversation.removeMedia(id);
  }

  listMedia(): VoiceMediaItem[] {
    return this.conversation.listMedia();
  }

  getMediaContextBlock(): string {
    return this.conversation.buildConversationBlock();
  }

  getMediaDescriberName(): string {
    return this.conversation.getDescriberName();
  }

  async describeMedia(id?: string): Promise<void> {
    const before = new Map(this.conversation.listMedia().map((i) => [i.id, i.status]));
    await this.conversation.describeMedia(id);
    for (const item of this.conversation.listMedia()) {
      if (item.status === 'described' && before.get(item.id) !== 'described') {
        this.emit({ kind: 'media-described', item: { ...item }, at: this.clock() });
      }
    }
    this.maybeCheckpoint('media');
  }

  /** Attach a recording (PCM16/WAV) and transcribe it. */
  attachAudioMedia(input: VoiceAudioMediaInput): ReturnType<MediaConversation['attachAudio']> {
    const result = this.conversation.attachAudio(input);
    if (result.ok) this.maybeCheckpoint('media');
    return result;
  }

  listAudio(): VoiceAudioMediaItem[] {
    return this.conversation.listAudio();
  }

  async transcribeAudio(id?: string): Promise<VoiceAudioMediaItem | null> {
    const done = await this.conversation.transcribeAudio(id);
    if (done) this.maybeCheckpoint('media');
    return done;
  }

  /** Attach still frames to an attached video. */
  attachVideoFrames(
    videoId: string,
    frames: Array<{ atSec: number; base64: string; mimeType: string; caption?: string }>,
  ): ReturnType<MediaConversation['attachVideoFrames']> {
    const result = this.conversation.attachVideoFrames(videoId, frames);
    if (result.ok) this.maybeCheckpoint('media');
    return result;
  }

  listVideoFrames(videoId: string): ReturnType<MediaConversation['listVideoFrames']> {
    return this.conversation.listVideoFrames(videoId);
  }

  async describeVideoFrames(videoId: string): Promise<number> {
    const n = await this.conversation.describeVideoFrames(videoId);
    if (n > 0) this.maybeCheckpoint('media');
    return n;
  }

  /** Map spoken words to an attached item ("this photo", ...). */
  resolveMediaReference(text: string): MediaReference | null {
    return this.conversation.resolveReference(text);
  }

  /** Media ids a user turn refers to (for the long-session turn). */
  linkTurnToMedia(text: string): string[] {
    return this.conversation.linkTurnToMedia(text);
  }

  /**
   * Ask a question about attached media (image/video/audio). The
   * question + answer are recorded against the item, so follow-ups
   * have history to build on.
   */
  async askAboutMedia(question: string, itemId?: string): Promise<MediaAnswer | null> {
    const answer = await this.conversation.askAboutMedia(question, itemId);
    if (!answer) return null;
    this.noteUserTurn(question, [answer.itemId]);
    this.v2.noteModelTurn(answer.answer, [answer.itemId]);
    this.emit({ kind: 'media-answer', answer: { ...answer }, at: answer.at });
    return { ...answer };
  }

  // -- internals ------------------------------------------------------------

  private handleV2Event(event: VoiceSessionV2Event): void {
    switch (event.kind) {
      case 'audio': {
        if (!this.bargeInV3.isModelSpeaking()) this.bargeInV3.modelSpeechStarted();
        break;
      }
      case 'transcript': {
        this.bargeInV3.noteModelTranscript(event.text, event.isFinal);
        if (event.isFinal && event.text.trim()) this.maybeCheckpoint('turn');
        break;
      }
      case 'turn': {
        if (event.speaker === 'model') this.bargeInV3.modelSpeechEnded();
        // A finished turn advances the session turn count — the
        // checkpoint budget is counted in turns, so check here
        // (the final transcript arrives before the count moves).
        this.maybeCheckpoint('turn');
        break;
      }
      case 'summary': {
        this.checkpointNow('summary');
        break;
      }
      case 'media-attached':
      case 'media-described': {
        this.maybeCheckpoint('media');
        break;
      }
      case 'interrupted': {
        // The session cut the reply — either v3 decided it (finish
        // the v3 measurement + keep the partial) or the session's
        // own server-VAD path did (keep the partial, no v3
        // measurement). v2 already emitted its own 'barge-in-v2'
        // after this event; v3 emits its own right after.
        let partialText = '';
        let measurementMs: number | null = null;
        if (this.bargeInV3.isInterrupting()) {
          this.bargeInV3.playbackFlushed();
          const done = this.bargeInV3.backToListening();
          measurementMs = done.measurement ? done.measurement.totalMs : null;
          partialText = done.partial ? done.partial.text : '';
        } else {
          const partial = this.bargeInV3.takeExternalPartial(event.source);
          partialText = partial ? partial.text : '';
        }
        const decision = this.pendingV3Decision;
        this.pendingV3Decision = null;
        this.emit(event);
        this.emit({
          kind: 'barge-in-v3',
          decision,
          measurementMs,
          partialText,
          at: event.at,
        });
        return;
      }
      default:
        break;
    }
    this.emit(event);
  }

  private emit(event: VoiceSessionV3Event): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}
