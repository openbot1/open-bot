/**
 * Session registry + aggregate report v28 (v1.41, Team T5).
 *
 * One realtime session is one conversation; the registry is
 * the view over *all* of them. It holds live session
 * references (never copies of their state) and builds, on
 * demand:
 *
 *   - a per-session rollup (state, turns, interruptions,
 *     chunks in/out/dropped, duration, style + voice in
 *     force, start/end times);
 *   - an aggregate report (totals, averages, per-bot and
 *     per-style breakdowns, the full rollup list);
 *   - a Markdown report (a human-readable note: header,
 *     totals table, per-bot table, per-session table).
 *
 * The registry never starts, stops or otherwise drives a
 * session — it only reads snapshots, stats and summaries,
 * so reporting can never change a live conversation. All
 * clocks virtual (`atMs` everywhere); everything is plain
 * data the host decides how to store or show.
 */

import type { RealtimeVoiceSessionV28 } from './sessionV28';
import type { VoiceV28SpeakingStyle } from './types';

/** One session, rolled up to a single line. */
export interface VoiceV28SessionRollup {
  sessionId: string;
  botId: string | null;
  state: string;
  floor: string;
  style: VoiceV28SpeakingStyle;
  voiceId: string | null;
  turns: number;
  interruptions: number;
  chunksIn: number;
  chunksOut: number;
  chunksDropped: number;
  /** Session length in ms (null = not started yet). */
  durationMs: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  stopReason: string | null;
  events: number;
}

/** Aggregate report over every registered session. */
export interface VoiceV28AggregateReport {
  generatedAtMs: number;
  sessions: number;
  openSessions: number;
  endedSessions: number;
  turns: number;
  interruptions: number;
  chunksIn: number;
  chunksOut: number;
  chunksDropped: number;
  /** Mean turns per session (0 when no sessions). */
  avgTurnsPerSession: number;
  /** Mean interruptions per session (0 when no sessions). */
  avgInterruptionsPerSession: number;
  /** Mean session duration in ms (null when no session started yet). */
  avgDurationMs: number | null;
  /** Per-bot totals (bot id 'unassigned' when the session has no bot). */
  byBot: Record<string, { sessions: number; turns: number; interruptions: number; chunksIn: number; chunksOut: number }>;
  /** Per-style session counts. */
  byStyle: Record<string, { sessions: number; turns: number }>;
  /** One rollup per session, in registration order. */
  rollups: VoiceV28SessionRollup[];
}

/** Round a number to 2 decimals (for averages). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createVoiceSessionRegistryV28(): VoiceSessionRegistryV28 {
  return new VoiceSessionRegistryV28();
}

/**
 * The registry: sessionId -> live session. Registering the
 * same session twice is a no-op (the first registration
 * wins); unregistering removes it. Snapshots are always
 * read fresh from the live session, so a rollup never goes
 * stale.
 */
export class VoiceSessionRegistryV28 {
  private readonly sessions = new Map<string, RealtimeVoiceSessionV28>();

  /** Number of registered sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Register a live session (no-op when already registered). */
  register(session: RealtimeVoiceSessionV28): void {
    if (!session || typeof session.sessionId !== 'string' || session.sessionId.trim() === '') {
      throw new Error('register needs a session with a non-empty sessionId');
    }
    if (!this.sessions.has(session.sessionId)) {
      this.sessions.set(session.sessionId, session);
    }
  }

  /** Remove a session from the registry (false when unknown). */
  unregister(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** The live session for an id (null when unknown). */
  get(sessionId: string): RealtimeVoiceSessionV28 | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** True when the session id is registered. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Registered session ids, in registration order. */
  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** All live sessions, in registration order. */
  all(): RealtimeVoiceSessionV28[] {
    return [...this.sessions.values()];
  }

  /** Forget every registered session. */
  clear(): void {
    this.sessions.clear();
  }

  /** Roll one session up to a single line (null when unknown). */
  rollup(sessionId: string, atMs: number): VoiceV28SessionRollup | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return rollupSessionV28(session, atMs);
  }

  /** Roll every registered session up, in registration order. */
  rollups(atMs: number): VoiceV28SessionRollup[] {
    return [...this.sessions.values()].map((s) => rollupSessionV28(s, atMs));
  }

  /** Aggregate report over every registered session. */
  aggregate(atMs: number): VoiceV28AggregateReport {
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('aggregate atMs must be >= 0');
    const rollups = this.rollups(atMs);
    const byBot: VoiceV28AggregateReport['byBot'] = {};
    const byStyle: VoiceV28AggregateReport['byStyle'] = {};
    let turns = 0;
    let interruptions = 0;
    let chunksIn = 0;
    let chunksOut = 0;
    let chunksDropped = 0;
    let openSessions = 0;
    let endedSessions = 0;
    let durationSum = 0;
    let durationCount = 0;
    for (const r of rollups) {
      turns += r.turns;
      interruptions += r.interruptions;
      chunksIn += r.chunksIn;
      chunksOut += r.chunksOut;
      chunksDropped += r.chunksDropped;
      if (r.state === 'ended') endedSessions += 1;
      else openSessions += 1;
      if (r.durationMs !== null) {
        durationSum += r.durationMs;
        durationCount += 1;
      }
      const botKey = r.botId ?? 'unassigned';
      const bot = byBot[botKey] ?? { sessions: 0, turns: 0, interruptions: 0, chunksIn: 0, chunksOut: 0 };
      bot.sessions += 1;
      bot.turns += r.turns;
      bot.interruptions += r.interruptions;
      bot.chunksIn += r.chunksIn;
      bot.chunksOut += r.chunksOut;
      byBot[botKey] = bot;
      const style = byStyle[r.style] ?? { sessions: 0, turns: 0 };
      style.sessions += 1;
      style.turns += r.turns;
      byStyle[r.style] = style;
    }
    const n = rollups.length;
    return {
      generatedAtMs: atMs,
      sessions: n,
      openSessions,
      endedSessions,
      turns,
      interruptions,
      chunksIn,
      chunksOut,
      chunksDropped,
      avgTurnsPerSession: n === 0 ? 0 : round2(turns / n),
      avgInterruptionsPerSession: n === 0 ? 0 : round2(interruptions / n),
      avgDurationMs: durationCount === 0 ? null : round2(durationSum / durationCount),
      byBot,
      byStyle,
      rollups,
    };
  }

  /** The aggregate report as a human-readable Markdown note. */
  toMarkdown(atMs: number): string {
    const report = this.aggregate(atMs);
    const lines: string[] = [
      '# Voice report v28',
      '',
      `- Sessions: ${report.sessions} (${report.openSessions} open, ${report.endedSessions} ended)`,
      `- Turns: ${report.turns} (avg ${report.avgTurnsPerSession} per session)`,
      `- Interruptions: ${report.interruptions} (avg ${report.avgInterruptionsPerSession} per session)`,
      `- Chunks: ${report.chunksIn} in / ${report.chunksOut} out, ${report.chunksDropped} dropped`,
      `- Avg duration: ${report.avgDurationMs === null ? '-' : `${report.avgDurationMs}ms`}`,
      '',
      '## By bot',
      '',
    ];
    const botIds = Object.keys(report.byBot).sort();
    if (botIds.length === 0) lines.push('_No sessions yet._', '');
    else {
      lines.push('| bot | sessions | turns | interruptions | chunks in | chunks out |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const botId of botIds) {
        const b = report.byBot[botId];
        lines.push(`| ${botId} | ${b.sessions} | ${b.turns} | ${b.interruptions} | ${b.chunksIn} | ${b.chunksOut} |`);
      }
      lines.push('');
    }
    lines.push('## By style', '');
    const styles = Object.keys(report.byStyle).sort();
    if (styles.length === 0) lines.push('_No sessions yet._', '');
    else {
      lines.push('| style | sessions | turns |');
      lines.push('| --- | --- | --- |');
      for (const style of styles) {
        const s = report.byStyle[style];
        lines.push(`| ${style} | ${s.sessions} | ${s.turns} |`);
      }
      lines.push('');
    }
    lines.push('## Sessions', '');
    if (report.rollups.length === 0) lines.push('_No sessions yet._');
    else {
      lines.push('| session | bot | state | style | voice | turns | interruptions | chunks | duration |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const r of report.rollups) {
        lines.push(
          `| ${r.sessionId} | ${r.botId ?? '-'} | ${r.state} | ${r.style} | ${r.voiceId ?? '-'} | ${r.turns} | ${r.interruptions} | ${r.chunksIn}/${r.chunksOut} | ${r.durationMs ?? '-'} |`,
        );
      }
    }
    return lines.join('\n');
  }
}

/** Roll one live session up to a single line. */
export function rollupSessionV28(
  session: RealtimeVoiceSessionV28,
  atMs: number,
): VoiceV28SessionRollup {
  const snap = session.snapshot();
  const durationMs =
    snap.startedAtMs === null
      ? null
      : Math.max(0, (snap.endedAtMs ?? atMs) - snap.startedAtMs);
  return {
    sessionId: snap.sessionId,
    botId: snap.botId,
    state: snap.state,
    floor: snap.floor,
    style: snap.style,
    voiceId: snap.voiceId,
    turns: snap.turns,
    interruptions: snap.interruptions,
    chunksIn: snap.chunksIn,
    chunksOut: snap.chunksOut,
    chunksDropped: snap.chunksDropped,
    durationMs,
    startedAtMs: snap.startedAtMs,
    endedAtMs: snap.endedAtMs,
    stopReason: snap.stopReason,
    events: snap.events,
  };
}
