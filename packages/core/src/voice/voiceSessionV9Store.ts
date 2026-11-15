/**
 * Voice session v9 store (v1.10, Đội T5 — voice realtime v5).
 *
 * Durable snapshot of one v9 call on disk: turns + transcript stats,
 * the barge-in cut point (so a dropped call can resume mid-sentence),
 * VAD/barge-in config and session metadata. Written atomically
 * (temp file + rename) with a SHA-256 checksum; a snapshot that fails
 * validation is quarantined (renamed to `.corrupt`) instead of
 * crashing the caller, and `list()`/`prune()` keep the directory
 * bounded.
 *
 * Same shape-family as the v8 store, written fresh for v9 (v9 turns
 * carry tool calls and partial histories, which v8 snapshots do not).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { TranscriptV9Turn } from './transcriptStreamV9';
import type { BargeInV9InterruptResult } from './bargeInV9';

/** Snapshot format version. */
export const VOICE_SESSION_V9_STORE_VERSION = 1;

/** Max turns kept in one snapshot (older turns are dropped). */
export const VOICE_SESSION_V9_MAX_TURNS = 200;

/** Max snapshots kept per directory by prune(). */
export const VOICE_SESSION_V9_MAX_FILES = 50;

/** The barge-in cut point a resume continues from. */
export interface VoiceSessionV9CutPoint {
  cutWord: string;
  cutWordIndex: number;
  playedMs: number;
  discardedMs: number;
  wordsPlayed: string[];
  wordsDiscarded: string[];
  atMs: number;
}

/** One durable v9 snapshot. */
export interface VoiceSessionV9Snapshot {
  version: number;
  sessionId: string;
  botId: string;
  language: string;
  voice: string;
  status: string;
  savedAtMs: number;
  connectedMs: number;
  turns: TranscriptV9Turn[];
  cutPoint: VoiceSessionV9CutPoint | null;
  stats: {
    userTurns: number;
    agentTurns: number;
    partials: number;
    toolCalls: number;
    interrupts: number;
  };
  vadPreset: string;
  bargeInPolicy: string;
  /** SHA-256 over the canonical JSON without this field. */
  checksum: string;
}

export interface VoiceSessionV9StoreResult {
  ok: boolean;
  path: string;
  error?: string;
}

function checksumOf(payload: Omit<VoiceSessionV9Snapshot, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function voiceSessionV9SnapshotPath(dir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(dir, `voice-v9-${safe}.json`);
}

export function createVoiceSessionV9Snapshot(input: {
  sessionId: string;
  botId: string;
  language: string;
  voice: string;
  status: string;
  savedAtMs: number;
  connectedMs: number;
  turns: TranscriptV9Turn[];
  cutPoint: BargeInV9InterruptResult | null;
  stats: VoiceSessionV9Snapshot['stats'];
  vadPreset: string;
  bargeInPolicy: string;
}): VoiceSessionV9Snapshot {
  const turns = input.turns.slice(-VOICE_SESSION_V9_MAX_TURNS).map((t) => ({
    ...t,
    partials: [...t.partials],
    toolCalls: t.toolCalls.map((c) => ({ ...c, args: { ...c.args } })),
  }));
  const cutPoint: VoiceSessionV9CutPoint | null = input.cutPoint
    ? {
        cutWord: input.cutPoint.cutWord,
        cutWordIndex: input.cutPoint.cutWordIndex,
        playedMs: input.cutPoint.playedMs,
        discardedMs: input.cutPoint.discardedMs,
        wordsPlayed: [...input.cutPoint.wordsPlayed],
        wordsDiscarded: [...input.cutPoint.wordsDiscarded],
        atMs: input.cutPoint.atMs,
      }
    : null;
  const payload: Omit<VoiceSessionV9Snapshot, 'checksum'> = {
    version: VOICE_SESSION_V9_STORE_VERSION,
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
  };
  return { ...payload, checksum: checksumOf(payload) };
}

export function validateVoiceSessionV9Snapshot(value: unknown): { ok: true; snapshot: VoiceSessionV9Snapshot } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Snapshot must be an object.' };
  }
  const s = value as Record<string, unknown>;
  if (s['version'] !== VOICE_SESSION_V9_STORE_VERSION) {
    return { ok: false, error: `Snapshot version must be ${VOICE_SESSION_V9_STORE_VERSION}.` };
  }
  if (typeof s['sessionId'] !== 'string' || s['sessionId'].length === 0) {
    return { ok: false, error: 'Snapshot sessionId must be a non-empty string.' };
  }
  if (!Array.isArray(s['turns'])) return { ok: false, error: 'Snapshot turns must be an array.' };
  if (typeof s['checksum'] !== 'string') return { ok: false, error: 'Snapshot checksum must be a string.' };
  const { checksum, ...rest } = s as unknown as VoiceSessionV9Snapshot & { checksum: string };
  const expect = checksumOf(rest);
  if (checksum !== expect) return { ok: false, error: 'Snapshot checksum mismatch (file changed or corrupt).' };
  return { ok: true, snapshot: value as VoiceSessionV9Snapshot };
}

/**
 * Disk store for v9 snapshots. One directory, one file per session.
 * All methods are synchronous (the files are small) and never throw
 * for a corrupt file — they report `ok: false` instead.
 */
export class VoiceSessionV9Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  save(snapshot: VoiceSessionV9Snapshot): VoiceSessionV9StoreResult {
    try {
      this.ensureDir();
      const file = voiceSessionV9SnapshotPath(this.dir, snapshot.sessionId);
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, path: '', error: (err as Error).message };
    }
  }

  load(sessionId: string): { ok: true; snapshot: VoiceSessionV9Snapshot } | { ok: false; error: string } {
    const file = voiceSessionV9SnapshotPath(this.dir, sessionId);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const checked = validateVoiceSessionV9Snapshot(parsed);
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
      fs.unlinkSync(voiceSessionV9SnapshotPath(this.dir, sessionId));
      return true;
    } catch {
      return false;
    }
  }

  list(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => name.startsWith('voice-v9-') && name.endsWith('.json'))
        .map((name) => name.slice('voice-v9-'.length, -'.json'.length))
        .sort();
    } catch {
      return [];
    }
  }

  /** Keep at most `maxFiles` snapshots (oldest by mtime first). */
  prune(maxFiles: number = VOICE_SESSION_V9_MAX_FILES): { removed: number; kept: number } {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((name) => name.startsWith('voice-v9-') && name.endsWith('.json'))
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

/** Resume instructions the model gets when a v9 call is restored. */
export function buildVoiceSessionV9ResumeInstructions(snapshot: VoiceSessionV9Snapshot): string {
  const lines = [
    `Resuming voice session ${snapshot.sessionId} (${snapshot.botId}, ${snapshot.language}).`,
    `${snapshot.turns.length} turns saved; ${snapshot.stats.userTurns} user, ${snapshot.stats.agentTurns} agent, ${snapshot.stats.toolCalls} tool calls, ${snapshot.stats.interrupts} interrupts.`,
  ];
  if (snapshot.cutPoint) {
    const c = snapshot.cutPoint;
    lines.push(
      `The last reply was cut at word "${c.cutWord}" (${c.playedMs} ms played, ${c.discardedMs} ms discarded). ` +
        `Continue from "${c.wordsDiscarded.join(' ')}" — do not restart the sentence.`,
    );
  }
  const last = snapshot.turns[snapshot.turns.length - 1];
  if (last) lines.push(`Last turn (${last.speakerId}): ${last.text}`);
  return lines.join('\n');
}

/** Snapshot as Markdown (for the session panel / logs). */
export function voiceSessionV9SnapshotMarkdown(snapshot: VoiceSessionV9Snapshot): string {
  const lines = [
    `## Voice v9 snapshot ${snapshot.sessionId}`,
    ``,
    `- Bot: ${snapshot.botId} · language: ${snapshot.language} · voice: ${snapshot.voice}`,
    `- Status: ${snapshot.status} · connected: ${snapshot.connectedMs} ms · saved: ${new Date(snapshot.savedAtMs).toISOString()}`,
    `- Turns: ${snapshot.turns.length} (${snapshot.stats.userTurns} user / ${snapshot.stats.agentTurns} agent) · tool calls: ${snapshot.stats.toolCalls} · interrupts: ${snapshot.stats.interrupts}`,
    `- VAD preset: ${snapshot.vadPreset} · barge-in policy: ${snapshot.bargeInPolicy}`,
  ];
  if (snapshot.cutPoint) {
    lines.push(`- Cut point: "${snapshot.cutPoint.cutWord}" — ${snapshot.cutPoint.playedMs} ms played, ${snapshot.cutPoint.discardedMs} ms discarded`);
  }
  return lines.join('\n');
}
