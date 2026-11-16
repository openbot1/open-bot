/**
 * Voice session v11 store (v1.12, Đội T5 — voice realtime v11).
 *
 * Durable snapshot of one v11 call on disk: turn history (with
 * floor hand-offs, overlaps and yield hints), the barge-in cut
 * point *plus* the TTS-stream receipt (so a dropped call can
 * resume mid-sentence *and* know which audio chunks were already
 * spoken), VAD v11 / barge-in v11 / TTS stream config and session
 * metadata. Written atomically (temp file + rename) with a
 * SHA-256 checksum; a snapshot that fails validation is
 * quarantined (renamed to `.corrupt`) instead of crashing the
 * caller, and `list()`/`prune()` keep the directory bounded.
 *
 * Same shape-family as the v9 store, written fresh for v11 (v11
 * turns carry floor/overlap/yield data and the TTS receipt, which
 * v9 snapshots do not).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { TurnTakingV11Turn } from './turnTakingV11';
import type { BargeInV11InterruptResult } from './bargeInV11';
import type { TtsStreamCancelResult } from './ttsStreamV11';

/** Snapshot format version. */
export const VOICE_SESSION_V11_STORE_VERSION = 1;

/** Max turns kept in one snapshot (older turns are dropped). */
export const VOICE_SESSION_V11_MAX_TURNS = 200;

/** Max snapshots kept per directory by prune(). */
export const VOICE_SESSION_V11_MAX_FILES = 50;

/** The barge-in + TTS cut point a resume continues from. */
export interface VoiceSessionV11CutPoint {
  cutWord: string;
  cutWordIndex: number;
  playedMs: number;
  discardedMs: number;
  wordsPlayed: string[];
  wordsDiscarded: string[];
  atMs: number;
  /** Barge-in latency (VAD speech-start → interrupt), null when explicit. */
  latencyMs: number | null;
  /** TTS chunks cancelled by the cut. */
  ttsChunksCancelled: number;
  /** TTS chars discarded by the cut. */
  ttsCharsDiscarded: number;
  /** Text of the TTS chunk cut mid-way ('' when none was playing). */
  ttsCutChunkText: string;
}

/** One durable v11 snapshot. */
export interface VoiceSessionV11Snapshot {
  version: number;
  sessionId: string;
  botId: string;
  language: string;
  voice: string;
  status: string;
  savedAtMs: number;
  connectedMs: number;
  turns: TurnTakingV11Turn[];
  cutPoint: VoiceSessionV11CutPoint | null;
  stats: {
    userTurns: number;
    agentTurns: number;
    interrupts: number;
    ducks: number;
    replies: number;
    repliesCut: number;
    ttsChunks: number;
    ttsChunksDone: number;
    ttsChunksCancelled: number;
    overlaps: number;
    meanSwitchMs: number;
    meanBargeInLatencyMs: number | null;
  };
  vadPreset: string;
  bargeInPolicy: string;
  ttsMsPerChar: number;
  /** SHA-256 over the canonical JSON without this field. */
  checksum: string;
}

export interface VoiceSessionV11StoreResult {
  ok: boolean;
  path: string;
  error?: string;
}

function checksumOf(payload: Omit<VoiceSessionV11Snapshot, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function voiceSessionV11SnapshotPath(dir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(dir, `voice-v11-${safe}.json`);
}

export function createVoiceSessionV11Snapshot(input: {
  sessionId: string;
  botId: string;
  language: string;
  voice: string;
  status: string;
  savedAtMs: number;
  connectedMs: number;
  turns: TurnTakingV11Turn[];
  cutPoint: { bargeIn: BargeInV11InterruptResult; tts: TtsStreamCancelResult } | null;
  stats: VoiceSessionV11Snapshot['stats'];
  vadPreset: string;
  bargeInPolicy: string;
  ttsMsPerChar: number;
}): VoiceSessionV11Snapshot {
  const turns = input.turns.slice(-VOICE_SESSION_V11_MAX_TURNS).map((t) => ({ ...t }));
  const cutPoint: VoiceSessionV11CutPoint | null = input.cutPoint
    ? {
        cutWord: input.cutPoint.bargeIn.cutWord,
        cutWordIndex: input.cutPoint.bargeIn.cutWordIndex,
        playedMs: input.cutPoint.bargeIn.playedMs,
        discardedMs: input.cutPoint.bargeIn.discardedMs,
        wordsPlayed: [...input.cutPoint.bargeIn.wordsPlayed],
        wordsDiscarded: [...input.cutPoint.bargeIn.wordsDiscarded],
        atMs: input.cutPoint.bargeIn.atMs,
        latencyMs: input.cutPoint.bargeIn.latencyMs,
        ttsChunksCancelled: input.cutPoint.tts.chunksCancelled,
        ttsCharsDiscarded: input.cutPoint.tts.charsDiscarded,
        ttsCutChunkText: input.cutPoint.tts.cutChunkText,
      }
    : null;
  const payload: Omit<VoiceSessionV11Snapshot, 'checksum'> = {
    version: VOICE_SESSION_V11_STORE_VERSION,
    sessionId: input.sessionId,
    botId: input.botId,
    language: input.language,
    voice: input.voice,
    status: input.status,
    savedAtMs: input.savedAtMs,
    connectedMs: input.connectedMs,
    turns,
    cutPoint,
    stats: { ...input.stats },
    vadPreset: input.vadPreset,
    bargeInPolicy: input.bargeInPolicy,
    ttsMsPerChar: input.ttsMsPerChar,
  };
  return { ...payload, checksum: checksumOf(payload) };
}

export function validateVoiceSessionV11Snapshot(value: unknown): { ok: true; snapshot: VoiceSessionV11Snapshot } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Snapshot must be an object.' };
  }
  const s = value as Record<string, unknown>;
  if (s['version'] !== VOICE_SESSION_V11_STORE_VERSION) {
    return { ok: false, error: `Snapshot version must be ${VOICE_SESSION_V11_STORE_VERSION}.` };
  }
  if (typeof s['sessionId'] !== 'string' || s['sessionId'].length === 0) {
    return { ok: false, error: 'Snapshot sessionId must be a non-empty string.' };
  }
  if (typeof s['botId'] !== 'string' || typeof s['language'] !== 'string') {
    return { ok: false, error: 'Snapshot botId/language must be strings.' };
  }
  if (!Array.isArray(s['turns'])) {
    return { ok: false, error: 'Snapshot turns must be an array.' };
  }
  for (const turn of s['turns'] as unknown[]) {
    if (typeof turn !== 'object' || turn === null) {
      return { ok: false, error: 'Snapshot turn must be an object.' };
    }
    const t = turn as Record<string, unknown>;
    if (typeof t['id'] !== 'number' || (t['speaker'] !== 'user' && t['speaker'] !== 'agent')) {
      return { ok: false, error: 'Snapshot turn needs a numeric id and a user/agent speaker.' };
    }
    if (typeof t['startedAtMs'] !== 'number' || typeof t['endedAtMs'] !== 'number' || typeof t['durationMs'] !== 'number') {
      return { ok: false, error: 'Snapshot turn needs numeric startedAtMs/endedAtMs/durationMs.' };
    }
  }
  if (s['cutPoint'] !== null && typeof s['cutPoint'] !== 'object') {
    return { ok: false, error: 'Snapshot cutPoint must be an object or null.' };
  }
  if (typeof s['stats'] !== 'object' || s['stats'] === null) {
    return { ok: false, error: 'Snapshot stats must be an object.' };
  }
  const { checksum, ...rest } = s as VoiceSessionV11Snapshot & Record<string, unknown>;
  void checksum;
  const expect = checksumOf(rest as Omit<VoiceSessionV11Snapshot, 'checksum'>);
  if (s['checksum'] !== expect) {
    return { ok: false, error: 'Snapshot checksum mismatch (file changed or corrupt).' };
  }
  return { ok: true, snapshot: value as VoiceSessionV11Snapshot };
}

export class VoiceSessionV11Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  save(snapshot: VoiceSessionV11Snapshot): VoiceSessionV11StoreResult {
    try {
      this.ensureDir();
      const file = voiceSessionV11SnapshotPath(this.dir, snapshot.sessionId);
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, path: '', error: (err as Error).message };
    }
  }

  load(sessionId: string): { ok: true; snapshot: VoiceSessionV11Snapshot } | { ok: false; error: string } {
    const file = voiceSessionV11SnapshotPath(this.dir, sessionId);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const checked = validateVoiceSessionV11Snapshot(parsed);
      if (!checked.ok) {
        // Quarantine the corrupt file so it is never loaded again.
        try {
          fs.renameSync(file, `${file}.corrupt`);
        } catch {
          // Quarantine is best-effort; the load already failed.
        }
        return { ok: false, error: checked.error };
      }
      return { ok: true, snapshot: checked.snapshot };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  delete(sessionId: string): boolean {
    try {
      fs.unlinkSync(voiceSessionV11SnapshotPath(this.dir, sessionId));
      return true;
    } catch {
      return false;
    }
  }

  list(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => name.startsWith('voice-v11-') && name.endsWith('.json'))
        .map((name) => name.slice('voice-v11-'.length, -'.json'.length))
        .sort();
    } catch {
      return [];
    }
  }

  /** Keep at most `maxFiles` snapshots (oldest by mtime first). */
  prune(maxFiles: number = VOICE_SESSION_V11_MAX_FILES): { removed: number; kept: number } {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((name) => name.startsWith('voice-v11-') && name.endsWith('.json'))
        .map((name) => ({ name, mtime: fs.statSync(path.join(this.dir, name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      let removed = 0;
      while (files.length - removed > maxFiles) {
        const victim = files[removed]!;
        try {
          fs.unlinkSync(path.join(this.dir, victim.name));
          removed += 1;
        } catch {
          break;
        }
      }
      return { removed, kept: files.length - removed };
    } catch {
      return { removed: 0, kept: 0 };
    }
  }
}

/** Resume instructions the model gets when a v11 call is restored. */
export function buildVoiceSessionV11ResumeInstructions(snapshot: VoiceSessionV11Snapshot): string {
  const lines = [
    `Resuming voice session ${snapshot.sessionId} (${snapshot.botId}, ${snapshot.language}).`,
    `${snapshot.turns.length} turns saved; ${snapshot.stats.userTurns} user, ${snapshot.stats.agentTurns} agent, ` +
      `${snapshot.stats.interrupts} interrupts, ${snapshot.stats.overlaps} overlaps, ` +
      `${snapshot.stats.ttsChunksDone}/${snapshot.stats.ttsChunks} TTS chunks spoken.`,
  ];
  if (snapshot.cutPoint) {
    const c = snapshot.cutPoint;
    lines.push(
      `The last reply was cut at word "${c.cutWord}" (${c.playedMs} ms played, ${c.discardedMs} ms discarded, ` +
        `barge-in latency ${c.latencyMs === null ? '-' : `${c.latencyMs} ms`}; ` +
        `${c.ttsChunksCancelled} TTS chunks / ${c.ttsCharsDiscarded} chars discarded). ` +
        `Continue from "${c.wordsDiscarded.join(' ')}" — do not restart the sentence.`,
    );
  }
  const last = snapshot.turns[snapshot.turns.length - 1];
  if (last) {
    lines.push(`Last turn (${last.speaker}, ${last.durationMs} ms, ended by ${last.endedBy}): turn #${last.id}.`);
  }
  return lines.join('\n');
}

/** Snapshot as Markdown (for the session panel / logs). */
export function voiceSessionV11SnapshotMarkdown(snapshot: VoiceSessionV11Snapshot): string {
  const lines = [
    `## Voice v11 snapshot ${snapshot.sessionId}`,
    ``,
    `- Bot: ${snapshot.botId} · language: ${snapshot.language} · voice: ${snapshot.voice}`,
    `- Status: ${snapshot.status} · connected: ${snapshot.connectedMs} ms · saved: ${new Date(snapshot.savedAtMs).toISOString()}`,
    `- Turns: ${snapshot.turns.length} (${snapshot.stats.userTurns} user / ${snapshot.stats.agentTurns} agent) · interrupts: ${snapshot.stats.interrupts} · ducks: ${snapshot.stats.ducks} · overlaps: ${snapshot.stats.overlaps}`,
    `- Replies: ${snapshot.stats.replies} (${snapshot.stats.repliesCut} cut) · TTS chunks: ${snapshot.stats.ttsChunksDone}/${snapshot.stats.ttsChunks} done, ${snapshot.stats.ttsChunksCancelled} cancelled`,
    `- Mean switch: ${snapshot.stats.meanSwitchMs} ms · mean barge-in latency: ${snapshot.stats.meanBargeInLatencyMs === null ? '-' : `${snapshot.stats.meanBargeInLatencyMs} ms`}`,
    `- VAD preset: ${snapshot.vadPreset} · barge-in policy: ${snapshot.bargeInPolicy} · TTS ${snapshot.ttsMsPerChar} ms/char`,
  ];
  if (snapshot.cutPoint) {
    lines.push(`- Cut point: "${snapshot.cutPoint.cutWord}" — ${snapshot.cutPoint.playedMs} ms played, ${snapshot.cutPoint.discardedMs} ms discarded, ${snapshot.cutPoint.ttsChunksCancelled} TTS chunks cancelled`);
  }
  return lines.join('\n');
}
