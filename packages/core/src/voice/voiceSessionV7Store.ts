/**
 * Voice session v7 snapshots (v1.08, Đội T5 — voice realtime v7).
 *
 * A v7 call accumulates state worth keeping across an app restart:
 * the streaming transcript (what was actually said, who said it,
 * which lines were cut), the VAD config that heard it (preset +
 * thresholds + false positives), the barge-in history (interrupts,
 * ducks, partials with cut words) and the duration / token totals
 * the panel shows. v6 snapshots the *call* layer (voices, network,
 * state machine); this module snapshots the *v7 layer* around it,
 * in the same shape as the v6 snapshot store:
 *
 *   - `snapshotVoiceSessionV7()` — a plain-JSON snapshot (version 1)
 *     of one session: provider, voice, call state, phase, VAD
 *     config + stats, barge-in stats + partials, transcript lines,
 *     duration + token totals.
 *   - `FileVoiceSessionV7Store` — one `<sessionId>.v7.json` file per
 *     session under a directory: save / load / list / delete /
 *     prune (30 days). A corrupt file loads as null and is skipped
 *     by list — it never breaks the other sessions.
 *   - `restoreVoiceSessionV7()` — a fresh mock session on the same
 *     provider with the snapshot's voice + VAD preset pre-selected.
 *     The histories are *reported*, not replayed: like v6's restore,
 *     the new session's live counters start at 0 and the snapshot
 *     is attached via `attachRestoredSnapshot()` so the panel can
 *     say "restored from a call with 3 interrupts and 42 lines"
 *     instead of pretending the history happened in this session.
 *
 * Snapshots hold transcript text (what the user and the model said
 * in this mock call) but no audio, no key, and no provider
 * credentials. They are local files, same as the v6 snapshots.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VoiceSessionV7, VoiceSessionV7Stats } from './voiceSessionV7';
import { VoiceV7Manager, VOICE_V7_SESSION_ID_RE } from './voiceSessionV7';
import type { VoiceCallState } from './voiceStateMachine';
import type { BargeInV7PartialUtterance } from './bargeInV7';
import type { TranscriptV7Line, TranscriptV7Phase } from './transcriptStreamV7';
import type { VadV7Config } from './vadV7';

/** One saved v7 session (version 1). */
export interface VoiceSessionV7Snapshot {
  version: 1;
  sessionId: string;
  provider: string;
  voiceId: string | null;
  voiceName: string | null;
  callState: VoiceCallState;
  phase: TranscriptV7Phase;
  vadPreset: string;
  vadConfig: VadV7Config;
  vadFalsePositives: number;
  bargeInInterrupts: number;
  bargeInDucks: number;
  bargeInPartials: BargeInV7PartialUtterance[];
  transcript: TranscriptV7Line[];
  startedAtMs: number | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  stats: VoiceSessionV7Stats;
  savedAtMs: number;
}

/** List entry for one saved snapshot. */
export interface VoiceSessionV7SnapshotInfo {
  sessionId: string;
  savedAtMs: number;
  provider: string;
  voiceId: string | null;
  callState: VoiceCallState;
  phase: TranscriptV7Phase;
  lines: number;
  interrupts: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Default snapshot retention (30 days, like the v6 store). */
export const VOICE_V7_SNAPSHOT_DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Snapshot one session. `sessionId` is the manager id the caller
 * uses (the live session itself has no id — the manager owns it).
 */
export function snapshotVoiceSessionV7(
  sessionId: string,
  session: VoiceSessionV7,
  nowMs = Date.now(),
): VoiceSessionV7Snapshot {
  const stats = session.getV7Stats();
  const current = session.getCurrentVoice();
  return {
    version: 1,
    sessionId,
    provider: session.getProvider(),
    voiceId: stats.v6.voice.currentId,
    voiceName: current?.name ?? stats.v6.voice.currentName,
    callState: stats.callState,
    phase: stats.phase,
    vadPreset: session.getVad().getPreset(),
    vadConfig: session.getVad().getOptions(),
    vadFalsePositives: stats.vad.falsePositives,
    bargeInInterrupts: stats.bargeIn.interrupts,
    bargeInDucks: stats.bargeIn.ducks,
    bargeInPartials: session.getBargeIn().getPartials(),
    transcript: session.getTranscriptStream().getLines(),
    startedAtMs: stats.startedAtMs,
    durationMs: stats.durationMs,
    inputTokens: stats.transcript.inputTokens,
    outputTokens: stats.transcript.outputTokens,
    stats,
    savedAtMs: nowMs,
  };
}

/** Validate unknown JSON as a v7 snapshot (null when it is not one). */
export function validateVoiceSessionV7Snapshot(data: unknown): VoiceSessionV7Snapshot | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<VoiceSessionV7Snapshot>;
  if (d.version !== 1) return null;
  if (typeof d.sessionId !== 'string' || !VOICE_V7_SESSION_ID_RE.test(d.sessionId)) return null;
  if (typeof d.provider !== 'string' || !d.provider) return null;
  if (!Array.isArray(d.transcript) || !Array.isArray(d.bargeInPartials)) return null;
  if (typeof d.savedAtMs !== 'number' || !Number.isFinite(d.savedAtMs)) return null;
  if (!d.stats || typeof d.stats !== 'object') return null;
  if (!d.vadConfig || typeof d.vadConfig !== 'object') return null;
  return {
    version: 1,
    sessionId: d.sessionId,
    provider: d.provider,
    voiceId: typeof d.voiceId === 'string' ? d.voiceId : null,
    voiceName: typeof d.voiceName === 'string' ? d.voiceName : null,
    callState: typeof d.callState === 'string' ? (d.callState as VoiceCallState) : 'idle',
    phase: typeof d.phase === 'string' ? (d.phase as TranscriptV7Phase) : 'idle',
    vadPreset: typeof d.vadPreset === 'string' ? d.vadPreset : 'office',
    vadConfig: d.vadConfig as VadV7Config,
    vadFalsePositives: typeof d.vadFalsePositives === 'number' ? d.vadFalsePositives : 0,
    bargeInInterrupts: typeof d.bargeInInterrupts === 'number' ? d.bargeInInterrupts : 0,
    bargeInDucks: typeof d.bargeInDucks === 'number' ? d.bargeInDucks : 0,
    bargeInPartials: d.bargeInPartials as BargeInV7PartialUtterance[],
    transcript: d.transcript as TranscriptV7Line[],
    startedAtMs: typeof d.startedAtMs === 'number' ? d.startedAtMs : null,
    durationMs: typeof d.durationMs === 'number' ? d.durationMs : 0,
    inputTokens: typeof d.inputTokens === 'number' ? d.inputTokens : 0,
    outputTokens: typeof d.outputTokens === 'number' ? d.outputTokens : 0,
    stats: d.stats as VoiceSessionV7Stats,
    savedAtMs: d.savedAtMs,
  };
}

/**
 * Restore a snapshot into a manager: a fresh mock session on the
 * same provider with the snapshot's voice + VAD preset
 * pre-selected, the snapshot attached as `restoredFrom`. Returns
 * null when the snapshot's session id already exists (refusing to
 * overwrite a live session) or the id is invalid.
 */
export function restoreVoiceSessionV7(
  manager: VoiceV7Manager,
  snapshot: VoiceSessionV7Snapshot,
): { session: VoiceSessionV7; restored: VoiceSessionV7Snapshot } | null {
  if (!VOICE_V7_SESSION_ID_RE.test(snapshot.sessionId)) return null;
  if (manager.hasSession(snapshot.sessionId)) return null;
  const session = manager.createSession(snapshot.sessionId, {
    provider: snapshot.provider as 'openai' | 'gemini' | 'openai-compatible',
    initialVoiceId: snapshot.voiceId ?? undefined,
    vadPreset: (snapshot.vadPreset as never) ?? undefined,
  });
  session.attachRestoredSnapshot(snapshot);
  return { session, restored: snapshot };
}

/** One-line summary of a snapshot (logs / session list). */
export function voiceSessionV7SnapshotSummary(snapshot: VoiceSessionV7Snapshot): string {
  return (
    `${snapshot.sessionId} (${snapshot.provider}, voice ${snapshot.voiceName ?? snapshot.voiceId ?? 'none'}, ` +
    `state ${snapshot.callState}, phase ${snapshot.phase}) — ${snapshot.transcript.length} transcript line(s), ` +
    `${snapshot.bargeInInterrupts} interrupt(s) / ${snapshot.bargeInDucks} duck(s), ` +
    `${snapshot.durationMs}ms, ${snapshot.inputTokens}+${snapshot.outputTokens} tokens`
  );
}

/** Markdown report of a snapshot (diagnostics / session log). */
export function voiceSessionV7SnapshotMarkdown(snapshot: VoiceSessionV7Snapshot): string {
  const lines = [
    `# Voice v7 session — ${snapshot.sessionId}`,
    '',
    `- Provider: ${snapshot.provider}`,
    `- Voice: ${snapshot.voiceName ?? '(none)'}${snapshot.voiceId ? ` (\`${snapshot.voiceId}\`)` : ''}`,
    `- Call state when saved: ${snapshot.callState} (phase ${snapshot.phase})`,
    `- Saved: ${new Date(snapshot.savedAtMs).toISOString()}`,
    `- Duration: ${snapshot.durationMs}ms`,
    `- Tokens: ${snapshot.inputTokens} in / ${snapshot.outputTokens} out`,
    `- VAD preset: ${snapshot.vadPreset} (false positives: ${snapshot.vadFalsePositives})`,
    `- Barge-in: ${snapshot.bargeInInterrupts} interrupt(s), ${snapshot.bargeInDucks} duck(s)`,
    '',
  ];
  if (snapshot.bargeInPartials.length > 0) {
    lines.push('## Cut replies (partials)');
    lines.push('');
    for (const partial of snapshot.bargeInPartials) {
      lines.push(
        `- ${new Date(partial.at).toISOString()}: cut after word ${partial.cutWordIndex} — "${partial.text}"` +
          (partial.remainingText ? ` (remaining: "${partial.remainingText}")` : ''),
      );
    }
    lines.push('');
  }
  if (snapshot.transcript.length > 0) {
    lines.push('## Transcript');
    lines.push('');
    for (const line of snapshot.transcript) {
      const who = line.speaker === 'user' ? 'User' : 'Agent';
      lines.push(`- **${who}**: ${line.text}${line.interrupted ? ' *(interrupted)*' : ''}${line.isFinal ? '' : ' *(interim)*'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export class FileVoiceSessionV7Store {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'session';
    return path.join(this.dir, `${safe}.v7.json`);
  }

  save(sessionId: string, session: VoiceSessionV7): VoiceSessionV7Snapshot {
    const snapshot = snapshotVoiceSessionV7(sessionId, session);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(sessionId), JSON.stringify(snapshot, null, 2), 'utf8');
    return snapshot;
  }

  saveSnapshot(snapshot: VoiceSessionV7Snapshot): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(snapshot.sessionId), JSON.stringify(snapshot, null, 2), 'utf8');
  }

  load(sessionId: string): VoiceSessionV7Snapshot | null {
    try {
      const raw = fs.readFileSync(this.fileFor(sessionId), 'utf8');
      return validateVoiceSessionV7Snapshot(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  list(): VoiceSessionV7SnapshotInfo[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.v7.json')).sort();
    } catch {
      return [];
    }
    const infos: VoiceSessionV7SnapshotInfo[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')) as unknown;
        const snapshot = validateVoiceSessionV7Snapshot(data);
        if (!snapshot) continue;
        infos.push({
          sessionId: snapshot.sessionId,
          savedAtMs: snapshot.savedAtMs,
          provider: snapshot.provider,
          voiceId: snapshot.voiceId,
          callState: snapshot.callState,
          phase: snapshot.phase,
          lines: snapshot.transcript.length,
          interrupts: snapshot.bargeInInterrupts,
          durationMs: snapshot.durationMs,
          inputTokens: snapshot.inputTokens,
          outputTokens: snapshot.outputTokens,
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
  prune(maxAgeMs = VOICE_V7_SNAPSHOT_DEFAULT_MAX_AGE_MS, nowMs = Date.now()): number {
    let deleted = 0;
    for (const info of this.list()) {
      if (nowMs - info.savedAtMs > maxAgeMs) {
        if (this.delete(info.sessionId)) deleted += 1;
      }
    }
    return deleted;
  }
}
