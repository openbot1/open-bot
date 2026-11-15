/**
 * Voice session v5 (v1.06, Đội T4 — voice realtime v5).
 *
 * The piece that ties the v5 parts together for one call:
 *
 *   - `VoiceSessionV5` — owns one `AdaptiveVad`, one
 *     `DiarizationSession` and the route chosen for the call.
 *     PCM frames go in through `feedAudio()`; the VAD cuts them
 *     into turns; each finished turn is embedded and attributed
 *     to a speaker; STT text lands through `noteTranscript()`
 *     and is attached to the latest turn without text, so the
 *     transcript always says *who* said *what*. Events flow
 *     through a sink (`speech-start`, `speech-end`, `backchannel`,
 *     `speaker-change`, `turn`).
 *   - `VoiceV5Manager` — the in-memory registry the tools bind
 *     to: creates sessions (routing the models first, per bot),
 *     holds per-bot router configs, lists / removes sessions,
 *     renames speakers and reports stats. Everything is local:
 *     sessions run on mock transports unless the host wires a
 *     live one; no key is ever read here.
 *
 * Audio buffering: a finished VAD turn's PCM is kept in a small
 * ring (at most `maxSegmentMs` per turn, older audio dropped),
 * so the embedding always sees the turn that just ended and
 * memory stays bounded on long calls.
 */

import {
  AdaptiveVad,
  defaultVadV5Options,
  validateVadV5Options,
  type AdaptiveVadOptions,
  type VadV5Event,
  type VadV5Stats,
} from './vadV5';
import {
  DiarizationSession,
  diarizedTranscriptMarkdown,
  type DiarizedTurn,
  type SpeakerIdentification,
  type SpeakerProfile,
} from './diarization';
import {
  VoiceRouterV5,
  routeVoiceRequest,
  voiceRouteReportMarkdown,
  type VoiceModelAvailability,
  type VoiceRoute,
  type VoiceRouteRequest,
} from './voiceRouterV5';
import { isValidPcm16Frame, pcm16Rms } from './audio';
import { REALTIME_MIC_SAMPLE_RATE_HZ } from './types';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Max audio kept per turn for the embedding (ms). */
export const VOICE_V5_DEFAULT_MAX_SEGMENT_MS = 30_000;
/** Session id pattern (same shape as the v4 manager). */
export const VOICE_V5_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Events emitted by a v5 session. */
export type VoiceSessionV5Event =
  | { kind: 'speech-start'; atMs: number; startedAtMs: number }
  | { kind: 'speech-end'; atMs: number; turn: DiarizedTurn; identification: SpeakerIdentification }
  | { kind: 'backchannel'; atMs: number; durationMs: number }
  | { kind: 'speaker-change'; atMs: number; speakerId: string; isNew: boolean }
  | { kind: 'turn'; atMs: number; turn: DiarizedTurn };

/** Sink receiving v5 session events. */
export type VoiceSessionV5EventSink = (event: VoiceSessionV5Event) => void;

/** Options for creating a `VoiceSessionV5`. */
export interface VoiceSessionV5Options {
  sessionId: string;
  botId?: string;
  language?: string;
  route?: VoiceRoute;
  availability?: VoiceModelAvailability;
  vad?: AdaptiveVadOptions;
  diarization?: { matchThreshold?: number; maxSpeakers?: number; updateRate?: number };
  /** Pre-restored diarization state (from a snapshot). */
  initialDiarization?: DiarizationSession;
  sampleRateHz?: number;
  maxSegmentMs?: number;
  sink?: VoiceSessionV5EventSink;
}

/** Statistics for one v5 session. */
export interface VoiceSessionV5Stats {
  sessionId: string;
  botId?: string;
  language: string;
  turns: number;
  backchannels: number;
  speakers: number;
  totalSpeechMs: number;
  vad: VadV5Stats;
  route: VoiceRoute;
}

/**
 * One realtime voice call: adaptive VAD + diarization + diarized
 * transcript, on the route the router picked for it.
 */
export class VoiceSessionV5 {
  readonly sessionId: string;
  readonly botId?: string;
  readonly language: string;
  readonly route: VoiceRoute;
  private readonly vad: AdaptiveVad;
  private readonly diarization: DiarizationSession;
  private readonly sampleRateHz: number;
  private readonly maxSegmentSamples: number;
  private readonly sink?: VoiceSessionV5EventSink;
  private segmentAudio: Uint8Array[] = [];
  private segmentSamples = 0;
  private segmentPeakRms = 0;
  private lastSpeakerId: string | null = null;
  private readonly createdAtMs: number;
  private closed = false;

  constructor(options: VoiceSessionV5Options) {
    if (!VOICE_V5_SESSION_ID_RE.test(options.sessionId)) {
      throw new Error(
        `VoiceSessionV5: sessionId must match ${VOICE_V5_SESSION_ID_RE.source} (got "${options.sessionId}").`,
      );
    }
    this.sessionId = options.sessionId;
    this.botId = options.botId;
    this.language = options.language ?? 'en';
    this.sampleRateHz = options.sampleRateHz ?? REALTIME_MIC_SAMPLE_RATE_HZ;
    const maxSegmentMs = options.maxSegmentMs ?? VOICE_V5_DEFAULT_MAX_SEGMENT_MS;
    this.maxSegmentSamples = Math.max(1, Math.round((this.sampleRateHz * maxSegmentMs) / 1000));
    this.route =
      options.route ??
      routeVoiceRequest({ language: this.language }, options.availability);
    this.sink = options.sink;
    this.createdAtMs = Date.now();
    this.diarization =
      options.initialDiarization ??
      new DiarizationSession({
        sampleRateHz: this.sampleRateHz,
        ...options.diarization,
      });
    this.vad = new AdaptiveVad({
      ...defaultVadV5Options(),
      sampleRateHz: this.sampleRateHz,
      ...(options.vad ?? {}),
      sink: (event) => this.onVadEvent(event),
    });
  }

  /** Live VAD (read-only access for stats / tuning). */
  getVad(): AdaptiveVad {
    return this.vad;
  }

  getDiarization(): DiarizationSession {
    return this.diarization;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Feed mic PCM16 audio (any length). Throws on invalid frames. */
  feedAudio(frame: Uint8Array): void {
    if (this.closed) {
      throw new Error(`VoiceSessionV5 ${this.sessionId}: session is closed.`);
    }
    if (!isValidPcm16Frame(frame)) {
      throw new Error('VoiceSessionV5: frame must be a non-empty even-length PCM16 buffer.');
    }
    // Buffer only speech-energy frames for the embedding: the
    // hangover quiet at the end of a turn (~420 ms of silence)
    // would otherwise dominate the segment and make every voice
    // look the same. Frames below half the VAD threshold are
    // silence for this purpose, not voice.
    const rms = pcm16Rms(frame);
    if (rms >= this.vad.getThreshold() * 0.5) {
      this.segmentAudio.push(new Uint8Array(frame));
      this.segmentSamples += frame.length / 2;
      while (this.segmentSamples > this.maxSegmentSamples && this.segmentAudio.length > 0) {
        const dropped = this.segmentAudio.shift() as Uint8Array;
        this.segmentSamples -= dropped.length / 2;
      }
    }
    if (this.vad.isSpeaking() || this.vad.getState() === 'maybe-speech') {
      this.segmentPeakRms = Math.max(this.segmentPeakRms, rms);
    }
    this.vad.feed(frame);
  }

  /**
   * Attach STT text to the latest turn without text (or, when no
   * turn exists yet, keep it pending for the next turn). Returns
   * the turn updated, or null when there is nothing to attach to.
   */
  noteTranscript(text: string): DiarizedTurn | null {
    if (this.closed) return null;
    const trimmed = text.trim();
    if (trimmed === '') return null;
    return this.diarization.attachTextToLatest(trimmed);
  }

  /** Reconfigure the session VAD live (validated; throws on bad input). */
  configureVad(patch: Omit<AdaptiveVadOptions, 'sampleRateHz' | 'sink' | 'windowMs'>): AdaptiveVadOptions {
    return this.vad.updateOptions(patch);
  }

  /** Current VAD config + stats (for the vad_config tool). */
  getVadReport(): { options: AdaptiveVadOptions; stats: VadV5Stats } {
    return {
      options: this.vad.getOptions(),
      stats: this.vad.getStats(),
    };
  }

  listSpeakers(): SpeakerProfile[] {
    return this.diarization.listSpeakers();
  }

  renameSpeaker(speakerId: string, displayName: string): boolean {
    return this.diarization.renameSpeaker(speakerId, displayName);
  }

  getTranscript(): DiarizedTurn[] {
    return this.diarization.getTranscript();
  }

  getTranscriptMarkdown(): string {
    return diarizedTranscriptMarkdown(this.getTranscript());
  }

  getStats(): VoiceSessionV5Stats {
    const vadStats = this.vad.getStats();
    return {
      sessionId: this.sessionId,
      botId: this.botId,
      language: this.language,
      turns: this.diarization.getTranscript().length,
      backchannels: vadStats.backchannels,
      speakers: this.diarization.listSpeakers().length,
      totalSpeechMs: vadStats.totalSpeechMs,
      vad: vadStats,
      route: this.route,
    };
  }

  /** Markdown summary of the session (route + speakers + transcript). */
  toMarkdown(): string {
    const stats = this.getStats();
    const lines = [
      `## Voice session ${this.sessionId} (v5)`,
      '',
      `- Bot: ${this.botId ?? '(none)'} · language: ${this.language} · turns: ${stats.turns} · speakers: ${stats.speakers} · speech: ${(stats.totalSpeechMs / 1000).toFixed(1)}s`,
      `- VAD: ${stats.vad.state} · threshold ${stats.vad.threshold.toFixed(4)} (noise floor ${stats.vad.noiseFloor.toFixed(4)}) · backchannels: ${stats.vad.backchannels}`,
      '',
      voiceRouteReportMarkdown(this.route),
      '',
    ];
    for (const speaker of this.listSpeakers()) {
      lines.push(
        `- ${speaker.displayName ?? speaker.id}: ${speaker.turns} turns, ${(speaker.totalMs / 1000).toFixed(1)}s`,
      );
    }
    lines.push('', this.getTranscriptMarkdown());
    return lines.join('\n');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.vad.flush();
    this.segmentAudio = [];
    this.segmentSamples = 0;
  }

  /** Snapshot the session (route + speakers + turns) for the file store. */
  toSnapshot(): VoiceSessionV5Snapshot {
    return {
      version: 1,
      sessionId: this.sessionId,
      botId: this.botId,
      language: this.language,
      route: this.route,
      speakers: this.diarization.listSpeakers(),
      turns: this.diarization.getTranscript(),
      savedAtMs: Date.now(),
    };
  }

  /** Rebuild a session from a snapshot (fresh VAD, restored speakers + turns). */
  static fromSnapshot(
    data: unknown,
    options: { sink?: VoiceSessionV5EventSink } = {},
  ): VoiceSessionV5 | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Partial<VoiceSessionV5Snapshot>;
    if (d.version !== 1 || typeof d.sessionId !== 'string' || !d.route || typeof d.route !== 'object') {
      return null;
    }
    // Restore speakers + turns through the diarization session's
    // own serialisation (validated there; bad entries dropped).
    const restored = DiarizationSession.fromJSON({
      version: 1,
      speakers: Array.isArray(d.speakers) ? d.speakers : [],
      turns: Array.isArray(d.turns) ? d.turns : [],
      nextSpeaker: 1,
    });
    const session = new VoiceSessionV5({
      sessionId: d.sessionId,
      botId: typeof d.botId === 'string' ? d.botId : undefined,
      language: typeof d.language === 'string' ? d.language : 'en',
      route: d.route as VoiceRoute,
      sink: options.sink,
      initialDiarization: restored,
    });
    return session;
  }

  private onVadEvent(event: VadV5Event): void {
    if (event.kind === 'speech-start') {
      this.segmentAudio = [];
      this.segmentSamples = 0;
      this.segmentPeakRms = 0;
      this.sink?.({ kind: 'speech-start', atMs: event.atMs, startedAtMs: event.startedAtMs });
      return;
    }
    if (event.kind === 'backchannel') {
      this.segmentAudio = [];
      this.segmentSamples = 0;
      this.segmentPeakRms = 0;
      this.sink?.({
        kind: 'backchannel',
        atMs: event.atMs,
        durationMs: event.durationMs ?? 0,
      });
      return;
    }
    if (event.kind !== 'speech-end') return;
    const audio = concatPcm(this.segmentAudio);
    this.segmentAudio = [];
    this.segmentSamples = 0;
    const identification: SpeakerIdentification =
      audio.length > 0
        ? this.diarization.identify({
            audio,
            startedAtMs: event.startedAtMs,
            endedAtMs: event.endedAtMs ?? event.atMs,
            peakRms: event.peakRms,
          })
        : {
            speakerId: this.lastSpeakerId ?? 'speaker-1',
            isNew: this.lastSpeakerId === null,
            distance: 1,
            confidence: 0,
          };
    // No audio at all (empty turn): keep the previous speaker so
    // the transcript does not invent a speaker per glitch.
    if (audio.length === 0 && this.lastSpeakerId) {
      identification.speakerId = this.lastSpeakerId;
      identification.isNew = false;
    }
    const turn = this.diarization.noteTurn({
      speakerId: identification.speakerId,
      startedAtMs: event.startedAtMs,
      endedAtMs: event.endedAtMs ?? event.atMs,
      peakRms: event.peakRms,
      matchDistance: identification.distance,
      isNewSpeaker: identification.isNew,
    });
    const changed = this.lastSpeakerId !== identification.speakerId;
    this.lastSpeakerId = identification.speakerId;
    if (changed) {
      this.sink?.({
        kind: 'speaker-change',
        atMs: event.atMs,
        speakerId: identification.speakerId,
        isNew: identification.isNew,
      });
    }
    this.sink?.({ kind: 'speech-end', atMs: event.atMs, turn, identification });
    this.sink?.({ kind: 'turn', atMs: event.atMs, turn });
  }
}

function concatPcm(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Options for creating a session through the manager. */
export interface VoiceV5CreateSessionOptions {
  botId?: string;
  language?: string;
  latencyClass?: VoiceRouteRequest['latencyClass'];
  maxCostTier?: VoiceRouteRequest['maxCostTier'];
  preferLocal?: boolean;
  vad?: AdaptiveVadOptions;
  diarization?: { matchThreshold?: number; maxSpeakers?: number; updateRate?: number };
  availability?: VoiceModelAvailability;
  sink?: VoiceSessionV5EventSink;
}

/** Manager statistics. */
export interface VoiceV5ManagerStats {
  sessions: number;
  closedSessions: number;
  totalTurns: number;
  totalSpeakers: number;
  botsConfigured: number;
}

/** A saved v5 session: route + speakers + diarized turns (JSON). */
export interface VoiceSessionV5Snapshot {
  version: 1;
  sessionId: string;
  botId?: string;
  language: string;
  route: VoiceRoute;
  speakers: SpeakerProfile[];
  turns: DiarizedTurn[];
  savedAtMs: number;
}

/**
 * In-memory registry of v5 sessions + per-bot router configs.
 * The tools bind to one manager instance (created by the host);
 * the manager never touches the network or a key.
 */
export class VoiceV5Manager {
  private readonly router = new VoiceRouterV5();
  private readonly sessions = new Map<string, VoiceSessionV5>();
  private closedSessions = 0;

  getRouter(): VoiceRouterV5 {
    return this.router;
  }

  /** Route a request (optionally for a bot with a stored config). */
  route(req: VoiceRouteRequest = {}, botId?: string, availability?: VoiceModelAvailability): VoiceRoute {
    if (botId) return this.router.routeForBot(botId, req, availability);
    return this.router.route(req, availability);
  }

  /** Create a session (routes the models first). Throws on a bad id / duplicate. */
  createSession(sessionId: string, options: VoiceV5CreateSessionOptions = {}): VoiceSessionV5 {
    if (!VOICE_V5_SESSION_ID_RE.test(sessionId)) {
      throw new Error(
        `VoiceV5Manager: sessionId must match ${VOICE_V5_SESSION_ID_RE.source} (got "${sessionId}").`,
      );
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`VoiceV5Manager: session "${sessionId}" already exists.`);
    }
    const route = this.route(
      {
        language: options.language ?? 'en',
        latencyClass: options.latencyClass,
        maxCostTier: options.maxCostTier,
        preferLocal: options.preferLocal,
      },
      options.botId,
      options.availability,
    );
    const session = new VoiceSessionV5({
      sessionId,
      botId: options.botId,
      language: options.language ?? 'en',
      route,
      availability: options.availability,
      vad: options.vad,
      diarization: options.diarization,
      sink: options.sink,
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): VoiceSessionV5 | undefined {
    return this.sessions.get(sessionId);
  }

  /** Close + remove a session. Returns false when unknown. */
  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.close();
    this.sessions.delete(sessionId);
    this.closedSessions += 1;
    return true;
  }

  listSessionIds(): string[] {
    return [...this.sessions.keys()].sort();
  }

  getStats(): VoiceV5ManagerStats {
    let totalTurns = 0;
    let totalSpeakers = 0;
    for (const session of this.sessions.values()) {
      totalTurns += session.getTranscript().length;
      totalSpeakers += session.listSpeakers().length;
    }
    return {
      sessions: this.sessions.size,
      closedSessions: this.closedSessions,
      totalTurns,
      totalSpeakers,
      botsConfigured: this.router.listBotConfigs().length,
    };
  }
}

/** Validate a VAD options patch (re-exported for the tools layer). */
export function validateVoiceV5VadPatch(patch: Partial<AdaptiveVadOptions>): string[] {
  return validateVadV5Options(patch);
}

/** One entry in the session snapshot listing. */
export interface VoiceSessionV5SnapshotInfo {
  sessionId: string;
  savedAtMs: number;
  language: string;
  turns: number;
  speakers: number;
}

/**
 * File-backed store for v5 session snapshots (one JSON file per
 * session id): route + speakers + diarized transcript. Local
 * only — embeddings never leave the machine. A later call can
 * reload a snapshot so a returning speaker keeps their name and
 * the transcript survives a restart. Corrupt files read as
 * "no snapshot", never a crash.
 */
export class FileVoiceSessionV5Store {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'session';
    return path.join(this.dir, `${safe}.v5.json`);
  }

  save(session: VoiceSessionV5): VoiceSessionV5Snapshot {
    const snapshot = session.toSnapshot();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(session.sessionId), JSON.stringify(snapshot, null, 2), 'utf8');
    return snapshot;
  }

  load(sessionId: string): VoiceSessionV5 | null {
    try {
      const raw = fs.readFileSync(this.fileFor(sessionId), 'utf8');
      return VoiceSessionV5.fromSnapshot(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  loadSnapshot(sessionId: string): VoiceSessionV5Snapshot | null {
    try {
      const raw = fs.readFileSync(this.fileFor(sessionId), 'utf8');
      const data = JSON.parse(raw) as Partial<VoiceSessionV5Snapshot>;
      if (!data || data.version !== 1 || typeof data.sessionId !== 'string') return null;
      return data as VoiceSessionV5Snapshot;
    } catch {
      return null;
    }
  }

  list(): VoiceSessionV5SnapshotInfo[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.v5.json')).sort();
    } catch {
      return [];
    }
    const infos: VoiceSessionV5SnapshotInfo[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')) as Partial<VoiceSessionV5Snapshot>;
        if (!data || data.version !== 1 || typeof data.sessionId !== 'string') continue;
        infos.push({
          sessionId: data.sessionId,
          savedAtMs: typeof data.savedAtMs === 'number' ? data.savedAtMs : 0,
          language: typeof data.language === 'string' ? data.language : 'en',
          turns: Array.isArray(data.turns) ? data.turns.length : 0,
          speakers: Array.isArray(data.speakers) ? data.speakers.length : 0,
        });
      } catch {
        // Skip a corrupt snapshot; the rest still list.
      }
    }
    return infos.sort((a, b) => b.savedAtMs - a.savedAtMs);
  }

  delete(sessionId: string): boolean {
    try {
      fs.unlinkSync(this.fileFor(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete snapshots older than `maxAgeMs` (default 30 days).
   * Returns the number deleted.
   */
  prune(maxAgeMs = 30 * 24 * 60 * 60 * 1000, nowMs = Date.now()): number {
    let deleted = 0;
    for (const info of this.list()) {
      if (nowMs - info.savedAtMs > maxAgeMs && this.delete(info.sessionId)) deleted += 1;
    }
    return deleted;
  }
}
