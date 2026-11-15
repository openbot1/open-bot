/**
 * Voice session v6 snapshots (v1.07, Team T5 — voice v4 + UI).
 *
 * A v6 call accumulates state worth keeping across an app restart:
 * which voice it ended on (and every switch before it), what the
 * network guard decided, and the state-machine timeline. v3 already
 * snapshots the *call* (checkpoints + resume); this module snapshots
 * the *v6 layer* around it, in the same spirit and the same shape
 * as the v5 snapshot store:
 *
 *   - `snapshotVoiceSessionV6()` — a plain-JSON snapshot (version 1)
 *     of one session: provider, voice, call state, switch history,
 *     network decisions, state history, full v6 stats.
 *   - `FileVoiceSessionV6Store` — one `<sessionId>.v6.json` file per
 *     session under a directory: save / load / list / delete /
 *     prune (30 days). A corrupt file loads as null and is skipped
 *     by list — it never breaks the other sessions.
 *   - `restoreVoiceSessionV6()` — a fresh mock session on the same
 *     provider with the snapshot's voice pre-selected. The histories
 *     are *reported*, not replayed: like v3's `restored` counters,
 *     the new session's live counters start at 0 and the snapshot
 *     is attached via `attachRestoredSnapshot()` so the panel can
 *     say "restored from a call that switched voices twice and
 *     degraded once" instead of pretending the history happened
 *     in this session.
 *
 * Snapshots hold no audio, no transcript text beyond the switch
 * history, no key, and no provider credentials — they are safe to
 * keep on disk next to the v5 snapshots.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VoiceSessionV6, VoiceSessionV6Stats } from './voiceSessionV6';
import { VoiceV6Manager, VOICE_V6_SESSION_ID_RE } from './voiceSessionV6';
import type { VoiceCallState, VoiceStateTransition } from './voiceStateMachine';
import type { VoiceSwitchRecord } from './voiceSwitch';
import type { VoiceNetworkDecision } from './voiceNetworkGuard';

/** One saved v6 session (version 1). */
export interface VoiceSessionV6Snapshot {
  version: 1;
  sessionId: string;
  provider: string;
  voiceId: string | null;
  voiceName: string | null;
  callState: VoiceCallState;
  switchHistory: VoiceSwitchRecord[];
  networkDecisions: VoiceNetworkDecision[];
  stateHistory: VoiceStateTransition[];
  stats: VoiceSessionV6Stats;
  savedAtMs: number;
}

/** List entry for one saved snapshot. */
export interface VoiceSessionV6SnapshotInfo {
  sessionId: string;
  savedAtMs: number;
  provider: string;
  voiceId: string | null;
  callState: VoiceCallState;
  switches: number;
  networkFailures: number;
  degraded: boolean;
}

/** Default snapshot retention (30 days, like the v5 store). */
export const VOICE_V6_SNAPSHOT_DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Snapshot one session. `sessionId` is the manager id the caller
 * uses (the live session itself has no id — the manager owns it).
 */
export function snapshotVoiceSessionV6(
  sessionId: string,
  session: VoiceSessionV6,
  nowMs = Date.now(),
): VoiceSessionV6Snapshot {
  const stats = session.getV6Stats();
  const current = session.getCurrentVoice();
  return {
    version: 1,
    sessionId,
    provider: session.getProvider(),
    voiceId: stats.voice.currentId,
    voiceName: current?.name ?? stats.voice.currentName,
    callState: stats.callState,
    switchHistory: session.getVoiceSwitchHistory(),
    networkDecisions: session.getNetworkDecisions(),
    stateHistory: session.getStateMachine().getHistory(),
    stats,
    savedAtMs: nowMs,
  };
}

/** Validate unknown JSON as a v6 snapshot (null when it is not one). */
export function validateVoiceSessionV6Snapshot(data: unknown): VoiceSessionV6Snapshot | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<VoiceSessionV6Snapshot>;
  if (d.version !== 1) return null;
  if (typeof d.sessionId !== 'string' || !VOICE_V6_SESSION_ID_RE.test(d.sessionId)) return null;
  if (typeof d.provider !== 'string' || !d.provider) return null;
  if (!Array.isArray(d.switchHistory) || !Array.isArray(d.networkDecisions) || !Array.isArray(d.stateHistory)) {
    return null;
  }
  if (typeof d.savedAtMs !== 'number' || !Number.isFinite(d.savedAtMs)) return null;
  if (!d.stats || typeof d.stats !== 'object') return null;
  return {
    version: 1,
    sessionId: d.sessionId,
    provider: d.provider,
    voiceId: typeof d.voiceId === 'string' ? d.voiceId : null,
    voiceName: typeof d.voiceName === 'string' ? d.voiceName : null,
    callState: typeof d.callState === 'string' ? (d.callState as VoiceCallState) : 'idle',
    switchHistory: d.switchHistory as VoiceSwitchRecord[],
    networkDecisions: d.networkDecisions as VoiceNetworkDecision[],
    stateHistory: d.stateHistory as VoiceStateTransition[],
    stats: d.stats as VoiceSessionV6Stats,
    savedAtMs: d.savedAtMs,
  };
}

/**
 * Restore a snapshot into a manager: a fresh mock session on the
 * same provider with the snapshot's voice pre-selected, the
 * snapshot attached as `restoredFrom`. Returns null when the
 * snapshot's session id already exists (refusing to overwrite a
 * live session) or the id is invalid.
 */
export function restoreVoiceSessionV6(
  manager: VoiceV6Manager,
  snapshot: VoiceSessionV6Snapshot,
): { session: VoiceSessionV6; restored: VoiceSessionV6Snapshot } | null {
  if (!VOICE_V6_SESSION_ID_RE.test(snapshot.sessionId)) return null;
  if (manager.hasSession(snapshot.sessionId)) return null;
  const session = manager.createSession(snapshot.sessionId, {
    provider: snapshot.provider as 'openai' | 'gemini' | 'openai-compatible',
    initialVoiceId: snapshot.voiceId ?? undefined,
  });
  session.attachRestoredSnapshot(snapshot);
  return { session, restored: snapshot };
}

/** One-line summary of a snapshot (logs / session list). */
export function voiceSessionV6SnapshotSummary(snapshot: VoiceSessionV6Snapshot): string {
  const stats = snapshot.stats;
  return (
    `${snapshot.sessionId} (${snapshot.provider}, voice ${snapshot.voiceName ?? snapshot.voiceId ?? 'none'}, ` +
    `state ${snapshot.callState}) — ${snapshot.switchHistory.length} switch(es), ` +
    `${stats.network.totalFailures} network failure(s), degraded=${stats.network.degraded ? 'yes' : 'no'}`
  );
}

/** Markdown report of a snapshot (diagnostics / session log). */
export function voiceSessionV6SnapshotMarkdown(snapshot: VoiceSessionV6Snapshot): string {
  const lines = [
    `# Voice v6 session — ${snapshot.sessionId}`,
    '',
    `- Provider: ${snapshot.provider}`,
    `- Voice: ${snapshot.voiceName ?? '(none)'}${snapshot.voiceId ? ` (\`${snapshot.voiceId}\`)` : ''}`,
    `- Call state when saved: ${snapshot.callState}`,
    `- Saved: ${new Date(snapshot.savedAtMs).toISOString()}`,
    `- Voice switches: ${snapshot.switchHistory.length} (reverts: ${snapshot.stats.voice.reverts})`,
    `- Network failures: ${snapshot.stats.network.totalFailures} (recoveries: ${snapshot.stats.network.totalRecoveries}, degraded: ${snapshot.stats.network.degraded ? 'yes' : 'no'})`,
    `- State transitions: ${snapshot.stateHistory.length} (rejected: ${snapshot.stats.stateRejected}, forced: ${snapshot.stats.stateForced})`,
    '',
  ];
  if (snapshot.switchHistory.length > 0) {
    lines.push('## Voice switches');
    lines.push('');
    for (const record of snapshot.switchHistory) {
      lines.push(
        `- ${new Date(record.at).toISOString()}: ${record.fromId ?? '(none)'} → ${record.toName} ` +
          `(${record.midCall ? 'mid-call' : 'pre-call'}, ${record.applied})`,
      );
    }
    lines.push('');
  }
  if (snapshot.networkDecisions.length > 0) {
    lines.push('## Network decisions');
    lines.push('');
    for (const decision of snapshot.networkDecisions) {
      lines.push(
        `- ${new Date(decision.at).toISOString()}: ${decision.action} ` +
          `(attempt ${decision.attempt}, ${decision.kind}) — ${decision.reason}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export class FileVoiceSessionV6Store {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'session';
    return path.join(this.dir, `${safe}.v6.json`);
  }

  save(sessionId: string, session: VoiceSessionV6): VoiceSessionV6Snapshot {
    const snapshot = snapshotVoiceSessionV6(sessionId, session);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(sessionId), JSON.stringify(snapshot, null, 2), 'utf8');
    return snapshot;
  }

  saveSnapshot(snapshot: VoiceSessionV6Snapshot): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(snapshot.sessionId), JSON.stringify(snapshot, null, 2), 'utf8');
  }

  load(sessionId: string): VoiceSessionV6Snapshot | null {
    try {
      const raw = fs.readFileSync(this.fileFor(sessionId), 'utf8');
      return validateVoiceSessionV6Snapshot(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  list(): VoiceSessionV6SnapshotInfo[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.v6.json')).sort();
    } catch {
      return [];
    }
    const infos: VoiceSessionV6SnapshotInfo[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')) as unknown;
        const snapshot = validateVoiceSessionV6Snapshot(data);
        if (!snapshot) continue;
        infos.push({
          sessionId: snapshot.sessionId,
          savedAtMs: snapshot.savedAtMs,
          provider: snapshot.provider,
          voiceId: snapshot.voiceId,
          callState: snapshot.callState,
          switches: snapshot.switchHistory.length,
          networkFailures: snapshot.stats.network.totalFailures,
          degraded: snapshot.stats.network.degraded,
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
  prune(maxAgeMs = VOICE_V6_SNAPSHOT_DEFAULT_MAX_AGE_MS, nowMs = Date.now()): number {
    let deleted = 0;
    for (const info of this.list()) {
      if (nowMs - info.savedAtMs > maxAgeMs) {
        if (this.delete(info.sessionId)) deleted += 1;
      }
    }
    return deleted;
  }
}
