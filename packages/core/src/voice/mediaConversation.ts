/**
 * Media conversation (v1.03, Team T5 — realtime voice v3).
 *
 * v1.02 attached images/video to a voice call and described them.
 * v1.03 goes deeper — the media becomes part of the *conversation*,
 * not just a block in the instructions:
 *
 *   - Audio media: the user plays a recording ("listen to this")
 *     and the call transcribes it (local STT, or the mock
 *     transcriber in $0 mode) so the model can quote it back.
 *     Only PCM16 / WAV is accepted locally — mp3/aac need a
 *     decoder this machine does not have, and the attach refuses
 *     them with a clear error instead of pretending.
 *   - Video frames: a video gets a sequence of still frames with
 *     timestamps ("at 0:12 the chart changes"), each describable
 *     through the same `MediaDescriber` as images.
 *   - References in speech: "look at this photo", "the second
 *     image", "that video", "ảnh thứ hai" — `resolveReference()`
 *     maps the words to an attached item, so a user turn can be
 *     linked to the media it is about (`linkTurnToMedia()`).
 *   - Q&A history per item: follow-up questions see the earlier
 *     answers about the same item, so "and what about the text
 *     in it?" has something to follow up on.
 *   - Budgeted block: the conversation block is capped in chars;
 *     over budget, the oldest descriptions shrink to one-line
 *     labels instead of dropping the media entirely.
 *
 * Images/video still live in `VoiceMediaContext` (v1.02) — this
 * module composes it and adds the audio/frame/reference layers on
 * top. Media bytes are never logged; audio bytes are stripped from
 * snapshots (the transcript survives, the recording does not).
 */
import {
  VoiceMediaContext,
  MockMediaDescriber,
  type MediaAnswer,
  type MediaDescriber,
  type RestorableMediaItem,
  type VoiceMediaInput,
  type VoiceMediaItem,
  type VoiceMediaContextOptions,
} from './mediaContext';
import type { LocalSttEngine } from './localStt';
import { isValidPcm16Frame } from './audio';

/** MIME types accepted for attached audio (PCM16 only — see header). */
export const VOICE_AUDIO_MIME_TYPES: readonly string[] = [
  'audio/pcm',
  'audio/wav',
  'audio/x-wav',
];
/** Max decoded bytes of ONE attached audio item (10 MB). */
export const VOICE_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
/** Max frames held per video. */
export const VOICE_VIDEO_MAX_FRAMES = 8;
/** Default budget (chars) for the media conversation block. */
export const MEDIA_CONVERSATION_DEFAULT_BUDGET_CHARS = 4_000;
/** Max Q&A answers kept per media item. */
export const MEDIA_CONVERSATION_MAX_ANSWERS_PER_ITEM = 10;

/** One audio item attached to the call (a recording to listen to). */
export interface VoiceAudioMediaItem {
  /** Stable id (`audio-<n>`, assigned on attach). */
  id: string;
  mimeType: string;
  name?: string;
  caption?: string;
  /** Length in seconds (metadata, when known). */
  durationSec?: number;
  /** Base64 PCM16 bytes (stripped from snapshots). */
  base64?: string;
  /** Sample rate of the PCM16 (Hz). Default 16000. */
  sampleRateHz: number;
  /** Transcript from the transcriber ('' until transcribed). */
  transcript: string;
  /** When the transcript was written (ms since epoch, 0 = never). */
  transcribedAt: number;
  /** 'pending' | 'transcribed' | 'failed'. */
  status: 'pending' | 'transcribed' | 'failed';
  /** Failure reason when status is 'failed'. */
  error?: string;
  /** When the item was attached (ms since epoch). */
  addedAt: number;
}

/** Input for attaching audio (id/transcript/status are assigned). */
export interface VoiceAudioMediaInput {
  mimeType: string;
  name?: string;
  caption?: string;
  durationSec?: number;
  /** Base64 PCM16 (or WAV — the header is stripped on attach). */
  base64: string;
  sampleRateHz?: number;
}

/** One still frame of an attached video, with its timestamp. */
export interface VoiceVideoFrame {
  /** Seconds into the video. */
  atSec: number;
  /** Base64 JPEG/PNG still. Never logged. */
  base64: string;
  mimeType: string;
  caption?: string;
  /** Description from the describer ('' until described). */
  description: string;
  describedAt: number;
  status: 'pending' | 'described' | 'failed';
}

/** Something that can transcribe attached audio. */
export interface AudioTranscriber {
  /** Human-readable engine name (shown in the panel, never a key). */
  readonly name: string;
  transcribe(pcm16: Uint8Array, opts?: { sampleRateHz?: number; language?: string }): Promise<string>;
}

/**
 * Deterministic transcriber: returns the item's own caption (or a
 * note that there is nothing to transcribe from). It never claims
 * to have heard audio it did not — used for tests, $0 mode, and as
 * the fallback when local STT fails. The PCM16 is ignored on
 * purpose: the mock has no ears.
 */
export class MockAudioTranscriber implements AudioTranscriber {
  readonly name = 'mock';
  private readonly script: string[];

  constructor(script: string[] = []) {
    this.script = script;
  }

  async transcribe(_pcm16: Uint8Array, _opts?: { sampleRateHz?: number; language?: string }): Promise<string> {
    if (this.script.length > 0) return this.script[0];
    return '';
  }
}

/** Adapter: any `LocalSttEngine` (whisper-cli, mock, fallback
 *  chain) becomes an `AudioTranscriber`. */
export class LocalSttAudioTranscriber implements AudioTranscriber {
  readonly name: string;
  private readonly engine: LocalSttEngine;
  private readonly language: string;

  constructor(engine: LocalSttEngine, language = 'en') {
    this.engine = engine;
    this.language = language;
    this.name = `stt:${engine.id}`;
  }

  async transcribe(pcm16: Uint8Array, opts?: { sampleRateHz?: number; language?: string }): Promise<string> {
    if (!isValidPcm16Frame(pcm16)) {
      throw new Error('AudioTranscriber: audio must be a non-empty even-length PCM16 buffer.');
    }
    return this.engine.transcribe(pcm16, {
      sampleRateHz: opts?.sampleRateHz ?? 16_000,
      language: opts?.language ?? this.language,
    });
  }
}

export function createMockAudioTranscriber(script: string[] = []): MockAudioTranscriber {
  return new MockAudioTranscriber(script);
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte size of a base64 string (length math, no decode). */
export function audioMediaBytes(base64: string | undefined): number {
  if (!base64) return 0;
  const clean = base64.replace(/\s/g, '');
  return Math.floor((clean.length * 3) / 4);
}

/**
 * Strip a 44-byte RIFF/WAV header from PCM16 bytes (pure, no
 * decode). Returns the original bytes when there is no WAV header,
 * and null when the input is too short to be audio at all. Only
 * plain PCM WAV is understood — anything else is the caller's
 * problem, reported by `attachAudio`, not guessed here.
 */
export function stripWavHeader(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 2) return null;
  const isRiff =
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  if (!isRiff) return bytes;
  if (bytes.length < 44) return null;
  return bytes.slice(44);
}

/** Base64 → bytes (throws on invalid base64 — the caller reports it). */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s/g, '');
  if (!BASE64_RE.test(clean)) throw new Error('Media data is not valid base64.');
  const bin = Buffer.from(clean, 'base64');
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

/** How a reference in speech matched an item. */
export type MediaReferenceMatch = 'recent' | 'ordinal' | 'name' | 'keyword';

/** A media reference resolved from spoken words. */
export interface MediaReference {
  itemId: string;
  kind: 'image' | 'video' | 'audio';
  /** 'high' when the words name the item, 'medium' for ordinals,
   *  'low' for "this one" (most recent of the kind). */
  confidence: 'high' | 'medium' | 'low';
  match: MediaReferenceMatch;
}

/** Ordinal words understood in references (en + vi). */
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
  'thứ nhất': 1, 'thứ hai': 2, 'thứ 2': 2, 'thứ ba': 3, 'thứ 3': 3,
  'thứ tư': 4, 'thứ 4': 4, 'thứ năm': 5, 'thứ 5': 5,
  'đầu tiên': 1, 'thứ 1': 1,
};

const KIND_WORDS: Record<string, 'image' | 'video' | 'audio'> = {
  photo: 'image', image: 'image', picture: 'image', screenshot: 'image',
  'ảnh': 'image', 'bức ảnh': 'image', 'hình': 'image',
  video: 'video', clip: 'video', 'đoạn video': 'video',
  audio: 'audio', recording: 'audio',
  'bản ghi': 'audio', 'đoạn ghi âm': 'audio', 'ghi âm': 'audio',
};

export interface MediaConversationOptions {
  /** Image/video context (v1.02). Defaults to a fresh one. */
  mediaContext?: VoiceMediaContext;
  /** Options for a fresh media context (ignored when one is passed). */
  mediaContextOptions?: VoiceMediaContextOptions;
  /** Audio transcriber. Defaults to the mock (no ears, honest). */
  audioTranscriber?: AudioTranscriber;
  /** Describer for video frames. Defaults to the media context's
   *  describer when one is given in `mediaContextOptions`,
   *  otherwise the mock describer. (A prebuilt `mediaContext`
   *  keeps its describer private, so pass it here too when the
   *  frames should use the same vision model.) */
  frameDescriber?: MediaDescriber;
  /** Language hint for audio transcription. Default 'en'. */
  language?: string;
  /** Budget (chars) for the conversation block. Default 4000. */
  budgetChars?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

/** Audio attach result: the item, or a refusal reason. */
export type AttachAudioResult =
  | { ok: true; item: VoiceAudioMediaItem }
  | { ok: false; error: string };

/** JSON snapshot of a media conversation (bytes stripped). */
export interface MediaConversationSnapshot {
  /** Image/video items (metadata + descriptions, no bytes). */
  media: Array<Omit<VoiceMediaItem, 'base64' | 'posterBase64'> & { bytesOmitted: boolean }>;
  audio: Array<Omit<VoiceAudioMediaItem, 'base64'> & { bytesOmitted: boolean }>;
  frames: Record<string, Array<Omit<VoiceVideoFrame, 'base64'> & { bytesOmitted: boolean }>>;
  history: Record<string, MediaAnswer[]>;
}

/**
 * The conversation layer over attached media. Images/video delegate
 * to the v1.02 `VoiceMediaContext`; audio items and video frames
 * live here, next to the reference resolver and the per-item Q&A
 * history. All state is in-memory and JSON-snapshottable (bytes
 * stripped) so a checkpoint can carry it.
 */
export class MediaConversation {
  private readonly context: VoiceMediaContext;
  private readonly transcriber: AudioTranscriber;
  private readonly frameDescriber: MediaDescriber;
  private readonly language: string;
  private readonly budgetChars: number;
  private readonly clock: () => number;
  private audioItems: VoiceAudioMediaItem[] = [];
  private audioSeq = 0;
  private frames = new Map<string, VoiceVideoFrame[]>();
  /** Per-item Q&A history (item id → answers, oldest first). */
  private itemHistory = new Map<string, MediaAnswer[]>();
  /** Attach order across kinds (image/video/audio) — the most
   *  recent item overall, for no-id questions. `addedAt` ties
   *  within the same millisecond, so order is tracked, not
   *  inferred from timestamps. */
  private attachOrder: Array<{ id: string; kind: 'image' | 'video' | 'audio' }> = [];

  constructor(options: MediaConversationOptions = {}) {
    this.context =
      options.mediaContext ??
      new VoiceMediaContext({
        ...(options.mediaContextOptions ?? {}),
        describer:
          options.mediaContextOptions?.describer ?? new MockMediaDescriber(),
        clock: options.clock,
      });
    this.transcriber = options.audioTranscriber ?? new MockAudioTranscriber();
    this.frameDescriber =
      options.frameDescriber ??
      options.mediaContextOptions?.describer ??
      new MockMediaDescriber();
    this.language = options.language ?? 'en';
    this.budgetChars = Math.max(256, options.budgetChars ?? MEDIA_CONVERSATION_DEFAULT_BUDGET_CHARS);
    this.clock = options.clock ?? Date.now;
  }

  getDescriberName(): string {
    return this.context.getDescriberName();
  }

  getTranscriberName(): string {
    return this.transcriber.name;
  }

  // -- image / video (v1.02 context, delegated) ---------------------------

  attach(input: VoiceMediaInput): ReturnType<VoiceMediaContext['attach']> {
    const result = this.context.attach(input);
    if (result.ok) {
      this.attachOrder.push({ id: result.item.id, kind: result.item.kind });
    }
    return result;
  }

  removeMedia(id: string): boolean {
    this.frames.delete(id);
    this.itemHistory.delete(id);
    this.attachOrder = this.attachOrder.filter((e) => e.id !== id);
    return this.context.remove(id);
  }

  listMedia(): VoiceMediaItem[] {
    return this.context.list();
  }

  getMedia(id: string): VoiceMediaItem | null {
    return this.context.get(id);
  }

  /** Q&A answers about image/video media (audio answers live in
   *  the per-item history — see `getItemHistory`). */
  getAnswers(): MediaAnswer[] {
    return this.context.getAnswers();
  }

  async describeMedia(id?: string): Promise<void> {
    await this.context.describe(id);
  }

  // -- audio ---------------------------------------------------------------

  listAudio(): VoiceAudioMediaItem[] {
    return this.audioItems.map((i) => ({ ...i }));
  }

  getAudio(id: string): VoiceAudioMediaItem | null {
    const found = this.audioItems.find((i) => i.id === id);
    return found ? { ...found } : null;
  }

  /**
   * Attach a recording. Only PCM16 / WAV is accepted: mp3/aac
   * need a decoder this machine does not have, so they are refused
   * with a clear error instead of being transcribed wrong. WAV
   * input has its header stripped; the stored bytes are raw PCM16.
   */
  attachAudio(input: VoiceAudioMediaInput): AttachAudioResult {
    if (!VOICE_AUDIO_MIME_TYPES.includes(input.mimeType)) {
      return {
        ok: false,
        error:
          `Unsupported audio type: ${input.mimeType}. Only PCM16 / WAV recordings can be transcribed locally.`,
      };
    }
    let pcm: Uint8Array;
    try {
      pcm = base64ToBytes(input.base64);
    } catch {
      return { ok: false, error: 'Audio data is not valid base64.' };
    }
    if (input.mimeType !== 'audio/pcm') {
      const stripped = stripWavHeader(pcm);
      if (stripped === null) {
        return { ok: false, error: 'Audio file is too short to be a WAV recording.' };
      }
      pcm = stripped;
    }
    if (!isValidPcm16Frame(pcm)) {
      return { ok: false, error: 'Audio must be non-empty PCM16 data.' };
    }
    if (pcm.byteLength > VOICE_AUDIO_MAX_BYTES) {
      return {
        ok: false,
        error: `Audio is too large (${Math.round(pcm.byteLength / 1024 / 1024)} MB, max ${Math.round(VOICE_AUDIO_MAX_BYTES / 1024 / 1024)} MB).`,
      };
    }
    const item: VoiceAudioMediaItem = {
      id: `audio-${(this.audioSeq += 1)}`,
      mimeType: 'audio/pcm',
      ...(input.name ? { name: input.name } : {}),
      ...(input.caption ? { caption: input.caption } : {}),
      ...(typeof input.durationSec === 'number' ? { durationSec: input.durationSec } : {}),
      base64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
      sampleRateHz: input.sampleRateHz ?? 16_000,
      transcript: '',
      transcribedAt: 0,
      status: 'pending',
      addedAt: this.clock(),
    };
    this.audioItems.push(item);
    this.attachOrder.push({ id: item.id, kind: 'audio' });
    return { ok: true, item: { ...item } };
  }

  /** Transcribe one attached recording (or all pending ones). */
  async transcribeAudio(id?: string): Promise<VoiceAudioMediaItem | null> {
    const targets = id
      ? this.audioItems.filter((i) => i.id === id)
      : this.audioItems.filter((i) => i.status === 'pending');
    if (targets.length === 0) return null;
    let last: VoiceAudioMediaItem | null = null;
    for (const item of targets) {
      try {
        if (!item.base64) throw new Error('No audio bytes attached.');
        const pcm = base64ToBytes(item.base64);
        const text = await this.transcriber.transcribe(pcm, {
          sampleRateHz: item.sampleRateHz,
          language: this.language,
        });
        const clean = String(text ?? '').trim();
        if (!clean) throw new Error('Transcriber returned an empty transcript.');
        item.transcript = clean;
        item.transcribedAt = this.clock();
        item.status = 'transcribed';
        item.error = undefined;
        last = { ...item };
      } catch (err) {
        item.status = 'failed';
        item.error = err instanceof Error ? err.message : 'Transcription failed.';
        last = null;
      }
    }
    return last;
  }

  removeAudio(id: string): boolean {
    const idx = this.audioItems.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    this.audioItems.splice(idx, 1);
    this.itemHistory.delete(id);
    this.attachOrder = this.attachOrder.filter((e) => e.id !== id);
    return true;
  }

  // -- video frames ----------------------------------------------------------

  /** Frames of a video (oldest first — by timestamp). */
  listVideoFrames(videoId: string): VoiceVideoFrame[] {
    return (this.frames.get(videoId) ?? []).map((f) => ({ ...f }));
  }

  /**
   * Attach still frames to a video (timestamps in seconds). Each
   * frame is one image (same MIME allowlist as attached images —
   * the media context validates them through the vision channel's
   * rules when described). Frames beyond the cap are refused, not
   * silently dropped.
   */
  attachVideoFrames(
    videoId: string,
    frames: Array<{ atSec: number; base64: string; mimeType: string; caption?: string }>,
  ): { ok: true; count: number } | { ok: false; error: string } {
    const video = this.context.get(videoId);
    if (!video || video.kind !== 'video') {
      return { ok: false, error: `No attached video with id ${videoId}.` };
    }
    const existing = this.frames.get(videoId) ?? [];
    if (existing.length + frames.length > VOICE_VIDEO_MAX_FRAMES) {
      return {
        ok: false,
        error: `Too many frames for one video (max ${VOICE_VIDEO_MAX_FRAMES}).`,
      };
    }
    for (const frame of frames) {
      if (typeof frame.atSec !== 'number' || frame.atSec < 0) {
        return { ok: false, error: 'Video frame needs a non-negative timestamp (seconds).' };
      }
      try {
        base64ToBytes(frame.base64);
      } catch {
        return { ok: false, error: 'Video frame data is not valid base64.' };
      }
    }
    const mapped: VoiceVideoFrame[] = frames.map((f) => ({
      atSec: f.atSec,
      base64: f.base64,
      mimeType: f.mimeType,
      ...(f.caption ? { caption: f.caption } : {}),
      description: '',
      describedAt: 0,
      status: 'pending',
    }));
    const next = [...existing, ...mapped].sort((a, b) => a.atSec - b.atSec);
    this.frames.set(videoId, next);
    return { ok: true, count: next.length };
  }

  /** Describe all pending frames of a video via the image describer. */
  async describeVideoFrames(videoId: string): Promise<number> {
    const frames = this.frames.get(videoId) ?? [];
    let described = 0;
    for (const frame of frames) {
      if (frame.status === 'described') continue;
      try {
        const desc = await this.frameDescriber.describe({
          id: `${videoId}-frame-${frame.atSec}`,
          kind: 'video',
          mimeType: frame.mimeType,
          ...(frame.caption ? { caption: frame.caption } : {}),
          base64: frame.base64,
          durationSec: frame.atSec,
          description: '',
          describedAt: 0,
          status: 'pending',
          addedAt: this.clock(),
        });
        frame.description = desc.text;
        frame.describedAt = this.clock();
        frame.status = 'described';
        described += 1;
      } catch {
        frame.status = 'failed';
      }
    }
    return described;
  }

  // -- references in speech ---------------------------------------------------

  /** All attached items (image/video/audio) in attach order. */
  private allItems(): Array<{ id: string; kind: 'image' | 'video' | 'audio'; name?: string; caption?: string }> {
    const out: Array<{ id: string; kind: 'image' | 'video' | 'audio'; name?: string; caption?: string }> = [];
    for (const item of this.context.list()) {
      out.push({ id: item.id, kind: item.kind, ...(item.name ? { name: item.name } : {}), ...(item.caption ? { caption: item.caption } : {}) });
    }
    for (const item of this.audioItems) {
      out.push({ id: item.id, kind: 'audio', ...(item.name ? { name: item.name } : {}), ...(item.caption ? { caption: item.caption } : {}) });
    }
    return out;
  }

  /**
   * Map spoken words to an attached item. "this photo" / "ảnh này"
   * → the most recent image; "the second image" / "ảnh thứ hai" →
   * the 2nd image; a name in the words → that item; "the
   * screenshot" → the most recent image whose name/caption says
   * screenshot. Returns null when nothing matches — never guesses
   * an item the words do not point at.
   */
  resolveReference(text: string): MediaReference | null {
    const clean = String(text ?? '').trim().toLowerCase();
    if (!clean) return null;
    const items = this.allItems();
    if (items.length === 0) return null;

    // 1. Name match: the words contain an item's file name.
    for (const item of items) {
      const name = item.name?.toLowerCase();
      if (name && name.length >= 3 && clean.includes(name)) {
        return { itemId: item.id, kind: item.kind, confidence: 'high', match: 'name' };
      }
    }

    // 2. Ordinal + kind: "the second image", "ảnh thứ hai", "media 2".
    const ordinalMatch =
      clean.match(/(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(photo|image|picture|video|audio|recording|ảnh|video)/) ??
      clean.match(/(ảnh|video)\s+(thứ nhất|thứ hai|thứ 2|thứ ba|thứ 3|thứ tư|thứ 4|thứ năm|thứ 5|thứ 1|đầu tiên)/) ??
      clean.match(/media\s+(\d+)/);
    if (ordinalMatch) {
      const word = ordinalMatch[1];
      const n = /^\d+$/.test(word) ? Number(word) : ORDINAL_WORDS[word];
      if (n !== undefined) {
        const kindWord = ordinalMatch[2];
        const kind = kindWord ? KIND_WORDS[kindWord] : undefined;
        const pool = kind ? items.filter((i) => i.kind === kind) : items;
        const target = pool[n - 1];
        if (target) {
          return { itemId: target.id, kind: target.kind, confidence: 'medium', match: 'ordinal' };
        }
      }
    }

    // 3. Keyword + kind: "this photo", "that video", "ảnh này", "the screenshot".
    for (const [word, kind] of Object.entries(KIND_WORDS)) {
      if (!clean.includes(word)) continue;
      const pool = items.filter((i) => i.kind === kind);
      if (pool.length === 0) continue;
      // "screenshot" prefers an item actually called a screenshot.
      if (word === 'screenshot') {
        const named = [...pool]
          .reverse()
          .find((i) => /screenshot/i.test(`${i.name ?? ''} ${i.caption ?? ''}`));
        if (named) return { itemId: named.id, kind, confidence: 'high', match: 'keyword' };
      }
      const mostRecent = pool[pool.length - 1];
      const deictic = /(this|that|này|đó|kia)/.test(clean);
      return {
        itemId: mostRecent.id,
        kind,
        confidence: deictic ? 'low' : 'medium',
        match: 'keyword',
      };
    }
    return null;
  }

  /** Media ids a user turn refers to (for the long-session turn). */
  linkTurnToMedia(text: string): string[] {
    const ref = this.resolveReference(text);
    return ref ? [ref.itemId] : [];
  }

  // -- Q&A -------------------------------------------------------------------

  /** Q&A history for one item (oldest first). */
  getItemHistory(itemId: string): MediaAnswer[] {
    return (this.itemHistory.get(itemId) ?? []).map((a) => ({ ...a }));
  }

  /**
   * Ask about media, with follow-up context: the question is
   * answered from the item (image/video via the describer, audio
   * from its transcript), and the answer is recorded against the
   * item so the next question about it can follow up. With no
   * `itemId` the most recently attached item of any kind is used
   * (by attach time, not by kind). Returns null when there is no
   * media to ask about.
   */
  async askAboutMedia(question: string, itemId?: string): Promise<MediaAnswer | null> {
    const clean = String(question ?? '').trim();
    if (!clean) return null;
    let audio: VoiceAudioMediaItem | undefined;
    let imageVideo: VoiceMediaItem | null = null;
    if (itemId) {
      audio = this.audioItems.find((i) => i.id === itemId);
      if (!audio) imageVideo = this.context.get(itemId);
    } else {
      // Most recently attached item of any kind (attach order,
      // not timestamps — several attaches share one millisecond).
      const latest = this.attachOrder.at(-1);
      if (latest?.kind === 'audio') {
        audio = this.audioItems.find((i) => i.id === latest.id);
      } else if (latest) {
        imageVideo = this.context.get(latest.id);
      }
    }
    if (audio) {
      if (audio.status !== 'transcribed' || !audio.transcript) {
        const answer: MediaAnswer = {
          itemId: audio.id,
          question: clean,
          answer:
            audio.status === 'failed'
              ? `Could not transcribe that recording: ${audio.error ?? 'unknown error'}`
              : 'That recording has not been transcribed yet — transcribe it first.',
          confidence: 'low',
          at: this.clock(),
        };
        this.recordAnswer(answer);
        return { ...answer };
      }
      const prior = this.getItemHistory(audio.id);
      const answer: MediaAnswer = {
        itemId: audio.id,
        question: clean,
        answer:
          `From the recording transcript ("${audio.transcript}"): ${clean} — ` +
          `the transcript is the only source used here.` +
          (prior.length > 0 ? ` (Earlier questions about this recording: ${prior.length}.)` : ''),
        confidence: 'medium',
        at: this.clock(),
      };
      this.recordAnswer(answer);
      return { ...answer };
    }
    const answer = await this.context.askAboutMedia(clean, itemId);
    if (!answer) return null;
    this.recordAnswer(answer);
    return { ...answer };
  }

  private recordAnswer(answer: MediaAnswer): void {
    const hist = this.itemHistory.get(answer.itemId) ?? [];
    hist.push({ ...answer });
    while (hist.length > MEDIA_CONVERSATION_MAX_ANSWERS_PER_ITEM) hist.shift();
    this.itemHistory.set(answer.itemId, hist);
  }

  // -- context block -----------------------------------------------------------

  /**
   * The conversation block for the model: the v1.02 media block,
   * plus audio transcripts, plus video frames, plus recent Q&A —
   * capped at `budgetChars`. Over budget the oldest descriptions
   * shrink to one-line labels (the media stays referenced, the
   * words go). Never contains raw bytes.
   */
  buildConversationBlock(): string {
    const sections: string[] = [];
    const mediaBlock = this.context.buildMediaContextBlock();
    if (mediaBlock) sections.push(mediaBlock);
    if (this.audioItems.length > 0) {
      const lines = this.audioItems.map((item, idx) => {
        const label = item.caption?.trim() || item.name?.trim() || `recording ${idx + 1}`;
        const body =
          item.status === 'transcribed'
            ? `transcript: "${item.transcript}"`
            : item.status === 'failed'
              ? `transcription failed${item.error ? `: ${item.error}` : ''}`
              : 'not transcribed yet';
        return `[audio ${idx + 1}] "${label}"${item.durationSec ? `, ${Math.round(item.durationSec)}s` : ''}: ${body}`;
      });
      sections.push('Attached audio the user can talk about:\n' + lines.join('\n'));
    }
    const frameLines: string[] = [];
    for (const [videoId, frames] of this.frames) {
      for (const frame of frames) {
        if (!frame.description) continue;
        frameLines.push(
          `Video ${videoId} at ${frame.atSec}s: ${frame.description}`,
        );
      }
    }
    if (frameLines.length > 0) {
      sections.push('Video frames:\n' + frameLines.join('\n'));
    }
    let block = sections.join('\n\n');
    if (block.length <= this.budgetChars) return block;
    // Over budget: first shorten every long line (240 chars),
    // then to 120 when still over — so the newest sections
    // (audio, frames) keep their labels instead of being cut
    // whole. Only if that is still not enough are lines dropped
    // from the end, keeping at least the first line.
    const trimTo = (text: string, max: number): string[] =>
      text.split('\n').map((line) => (line.length > max ? `${line.slice(0, max)}…` : line));
    let lines = trimTo(block, 240);
    if (lines.join('\n').length > this.budgetChars) lines = trimTo(lines.join('\n'), 120);
    while (lines.join('\n').length > this.budgetChars && lines.length > 1) lines.pop();
    return lines.join('\n');
  }

  /** JSON snapshot (bytes stripped) for checkpoints. */
  snapshot(): MediaConversationSnapshot {
    return {
      media: this.context.snapshotItems().map((i) => {
        const { base64, posterBase64, ...rest } = i;
        return { ...rest, bytesOmitted: Boolean(base64 || posterBase64) };
      }),
      audio: this.audioItems.map((i) => {
        const { base64, ...rest } = i;
        return { ...rest, bytesOmitted: Boolean(base64) };
      }),
      frames: Object.fromEntries(
        [...this.frames.entries()].map(([id, list]) => [
          id,
          list.map((f) => {
            const { base64, ...rest } = f;
            return { ...rest, bytesOmitted: Boolean(base64) };
          }),
        ]),
      ),
      history: Object.fromEntries(
        [...this.itemHistory.entries()].map(([id, list]) => [id, list.map((a) => ({ ...a }))]),
      ),
    };
  }

  /** Restore from a snapshot (as produced by `snapshot()`). */
  restore(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.media)) {
      this.context.restoreItems(v.media as RestorableMediaItem[]);
    }
    if (!Array.isArray(v.audio) || typeof v.frames !== 'object' || typeof v.history !== 'object') {
      return false;
    }
    const audio = (v.audio as unknown[]).filter(
      (a): a is VoiceAudioMediaItem =>
        !!a && typeof a === 'object' && typeof (a as VoiceAudioMediaItem).id === 'string',
    );
    this.audioItems = audio.map((a) => ({ ...a, base64: undefined }));
    this.audioSeq = this.audioItems.reduce(
      (m, a) => Math.max(m, Number(a.id.replace('audio-', '')) || 0),
      0,
    );
    // Rebuild attach order from timestamps (best effort — the
    // snapshot does not store the order itself).
    const order: Array<{ id: string; kind: 'image' | 'video' | 'audio'; at: number }> = [
      ...this.context.list().map((i) => ({ id: i.id, kind: i.kind, at: i.addedAt })),
      ...this.audioItems.map((a) => ({ id: a.id, kind: 'audio' as const, at: a.addedAt })),
    ];
    order.sort((a, b) => a.at - b.at);
    this.attachOrder = order.map(({ id, kind }) => ({ id, kind }));
    this.frames = new Map(
      Object.entries(v.frames as Record<string, unknown[]>).map(([id, list]) => [
        id,
        (Array.isArray(list) ? list : [])
          .filter((f): f is VoiceVideoFrame => !!f && typeof f === 'object' && typeof (f as VoiceVideoFrame).atSec === 'number')
          .map((f) => ({ ...f, base64: '' })),
      ]),
    );
    this.itemHistory = new Map(
      Object.entries(v.history as Record<string, unknown[]>).map(([id, list]) => [
        id,
        (Array.isArray(list) ? list : []).filter(
          (a): a is MediaAnswer => !!a && typeof a === 'object' && typeof (a as MediaAnswer).question === 'string',
        ),
      ]),
    );
    return true;
  }
}
