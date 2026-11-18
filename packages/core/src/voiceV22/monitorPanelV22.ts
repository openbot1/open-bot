/**
 * Realtime monitor panel v22 (voice v22, v1.35 Team T5).
 *
 * The v21 panel showed the live conversation (turn, live
 * transcript, tool call, latency, TTS cache). The v22 panel
 * keeps that view and adds the durability view: the phase
 * (live / degraded / disconnected / reconnecting / resuming /
 * recovered), the floor, the current voice profile, the
 * journal position and durability score, the last resume
 * (clean or with gaps), the recovery loop (heartbeats, RTT,
 * reconnect attempts), the degradation steps in force, and
 * the queued cut replies waiting for the floor.
 *
 * The panel is a view-model only: the session (or the tools
 * layer) feeds it snapshots and it renders a snapshot object
 * plus markdown. It never touches audio, the network, or the
 * store — it only aggregates what it is told, so the renderer
 * can poll it as often as it likes.
 */
import {
  round2V22,
  round4V22,
  type VoiceV22BargeInDecision,
  type VoiceV22DurabilityPhase,
  type VoiceV22FloorHolder,
  type VoiceV22TurnState,
} from './types';
import type { VoiceV22ResumeReport } from './resumeV22';
import type { VoiceV22DegradationStep } from './recoveryV22';
import type { VoiceV22RealtimeSessionStats } from './sessionV22';

export interface VoiceV22PanelDurabilityView {
  phase: VoiceV22DurabilityPhase;
  journalSeq: number;
  lastCheckpointSeq: number | null;
  durabilityScore: number;
  disconnects: number;
  resumes: number;
  recoveries: number;
  lastResumeOutcome: string | null;
  lastResumeMissingSeqs: number;
  nextReconnectAtMs: number | null;
}

export interface VoiceV22PanelRecoveryView {
  heartbeats: number;
  lateBeats: number;
  missedBeats: number;
  meanRttMs: number;
  maxRttMs: number;
  reconnectAttempts: number;
  reconnectSuccesses: number;
  gaveUp: boolean;
  degradationSteps: VoiceV22DegradationStep[];
}

export interface VoiceV22PanelQueuedReplyView {
  id: string;
  turnId: string;
  remainingChars: number;
  disposition: string;
  queuedAtMs: number;
}

export interface VoiceV22MonitorSnapshot {
  sessionId: string;
  updatedAtMs: number;
  turnState: VoiceV22TurnState;
  msInState: number;
  floor: VoiceV22FloorHolder;
  profileId: string;
  livePartial: string;
  /** Last finalised transcript lines, newest last (max 10). */
  finalTranscript: string[];
  bargeIns: number;
  ducksSoft: number;
  ducksHard: number;
  lastBargeInDecision: string | null;
  durability: VoiceV22PanelDurabilityView;
  recovery: VoiceV22PanelRecoveryView;
  queuedReplies: VoiceV22PanelQueuedReplyView[];
  alerts: string[];
}

/** i18n keys the panel uses (renderer resolves them). */
export const VOICE_V22_PANEL_I18N_KEYS = [
  'voice.v22.panel.title',
  'voice.v22.panel.listening',
  'voice.v22.panel.speaking',
  'voice.v22.panel.waiting',
  'voice.v22.panel.confirming',
  'voice.v22.panel.yielded',
  'voice.v22.panel.paused',
  'voice.v22.panel.idle',
  'voice.v22.panel.liveTranscript',
  'voice.v22.panel.latency',
  'voice.v22.panel.bargeIns',
  'voice.v22.panel.durability',
  'voice.v22.panel.phase.live',
  'voice.v22.panel.phase.degraded',
  'voice.v22.panel.phase.disconnected',
  'voice.v22.panel.phase.reconnecting',
  'voice.v22.panel.phase.resuming',
  'voice.v22.panel.phase.recovered',
  'voice.v22.panel.phase.closed',
  'voice.v22.panel.profile',
  'voice.v22.panel.queuedReplies',
  'voice.v22.panel.alerts',
  'voice.v22.panel.noAlerts',
  'voice.v22.panel.resumeClean',
  'voice.v22.panel.resumeWithGaps',
] as const;

export interface VoiceV22MonitorPanelOptions {
  /** Max final transcript lines kept (default 10). */
  maxTranscriptLines: number;
  /** Durability score below this raises an alert (default 0.5). */
  lowDurabilityThreshold: number;
  /** RTT above this raises an alert (default 2000 ms). */
  highRttMs: number;
  /** Max queued replies shown (default 5). */
  maxQueuedReplies: number;
}

export function defaultMonitorPanelV22Options(): VoiceV22MonitorPanelOptions {
  return {
    maxTranscriptLines: 10,
    lowDurabilityThreshold: 0.5,
    highRttMs: 2000,
    maxQueuedReplies: 5,
  };
}

export function validateMonitorPanelV22Options(o: Partial<VoiceV22MonitorPanelOptions>): string[] {
  const e: string[] = [];
  if (o.maxTranscriptLines !== undefined && (!Number.isInteger(o.maxTranscriptLines) || o.maxTranscriptLines < 1)) {
    e.push('maxTranscriptLines must be a positive integer');
  }
  if (o.lowDurabilityThreshold !== undefined && (o.lowDurabilityThreshold < 0 || o.lowDurabilityThreshold > 1)) {
    e.push('lowDurabilityThreshold must be 0..1');
  }
  if (o.highRttMs !== undefined && o.highRttMs <= 0) e.push('highRttMs must be positive');
  if (o.maxQueuedReplies !== undefined && (!Number.isInteger(o.maxQueuedReplies) || o.maxQueuedReplies < 1)) {
    e.push('maxQueuedReplies must be a positive integer');
  }
  return e;
}

export class MonitorPanelV22 {
  private readonly opts: VoiceV22MonitorPanelOptions;
  private readonly sessionId: string;
  private turnState: VoiceV22TurnState = 'idle';
  private stateSinceMs = 0;
  private updatedAtMs = 0;
  private floor: VoiceV22FloorHolder = 'none';
  private profileId = 'voice-v22-default';
  private livePartial = '';
  private finalTranscript: string[] = [];
  private bargeIns = 0;
  private ducksSoft = 0;
  private ducksHard = 0;
  private lastBargeInDecision: string | null = null;
  private durability: VoiceV22PanelDurabilityView = {
    phase: 'live',
    journalSeq: 0,
    lastCheckpointSeq: null,
    durabilityScore: 1,
    disconnects: 0,
    resumes: 0,
    recoveries: 0,
    lastResumeOutcome: null,
    lastResumeMissingSeqs: 0,
    nextReconnectAtMs: null,
  };
  private recovery: VoiceV22PanelRecoveryView = {
    heartbeats: 0,
    lateBeats: 0,
    missedBeats: 0,
    meanRttMs: 0,
    maxRttMs: 0,
    reconnectAttempts: 0,
    reconnectSuccesses: 0,
    gaveUp: false,
    degradationSteps: [],
  };
  private queuedReplies: VoiceV22PanelQueuedReplyView[] = [];

  constructor(sessionId: string, opts: Partial<VoiceV22MonitorPanelOptions> = {}) {
    this.sessionId = sessionId;
    this.opts = { ...defaultMonitorPanelV22Options(), ...opts };
  }

  setTurnState(state: VoiceV22TurnState, atMs: number): void {
    if (state !== this.turnState) {
      this.turnState = state;
      this.stateSinceMs = atMs;
    }
    this.updatedAtMs = atMs;
  }

  setFloor(floor: VoiceV22FloorHolder, atMs: number): void {
    this.floor = floor;
    this.updatedAtMs = atMs;
  }

  setProfile(profileId: string, atMs: number): void {
    this.profileId = profileId;
    this.updatedAtMs = atMs;
  }

  setLivePartial(text: string, atMs: number): void {
    this.livePartial = text;
    this.updatedAtMs = atMs;
  }

  /** A transcript line finalised — moves from live to history. */
  addFinalTranscript(text: string, atMs: number): void {
    const line = text.trim();
    if (line !== '') {
      this.finalTranscript.push(line);
      while (this.finalTranscript.length > this.opts.maxTranscriptLines) this.finalTranscript.shift();
    }
    this.livePartial = '';
    this.updatedAtMs = atMs;
  }

  recordBargeIn(decision: VoiceV22BargeInDecision, atMs: number): void {
    if (decision === 'interrupt') this.bargeIns += 1;
    if (decision === 'duck-soft') this.ducksSoft += 1;
    if (decision === 'duck-hard') this.ducksHard += 1;
    this.lastBargeInDecision = decision;
    this.updatedAtMs = atMs;
  }

  setDurability(view: Partial<VoiceV22PanelDurabilityView>, atMs: number): void {
    this.durability = { ...this.durability, ...view };
    this.updatedAtMs = atMs;
  }

  setRecovery(view: Partial<VoiceV22PanelRecoveryView>, atMs: number): void {
    this.recovery = {
      ...this.recovery,
      ...view,
      degradationSteps: view.degradationSteps === undefined ? this.recovery.degradationSteps : [...view.degradationSteps],
    };
    this.updatedAtMs = atMs;
  }

  setLastResume(report: VoiceV22ResumeReport, atMs: number): void {
    this.durability = {
      ...this.durability,
      lastResumeOutcome: report.outcome,
      lastResumeMissingSeqs: report.missingSeqs.length,
      resumes: this.durability.resumes + (report.outcome === 'resumed' || report.outcome === 'resumed-with-gaps' ? 1 : 0),
    };
    this.updatedAtMs = atMs;
  }

  setQueuedReplies(queued: VoiceV22PanelQueuedReplyView[], atMs: number): void {
    this.queuedReplies = queued.slice(0, this.opts.maxQueuedReplies).map((q) => ({ ...q }));
    this.updatedAtMs = atMs;
  }

  /**
   * Mirror a live session's stats into the panel in one call
   * (the tools layer uses this; the session itself feeds the
   * panel event by event).
   */
  mirrorSession(stats: VoiceV22RealtimeSessionStats, atMs: number): void {
    this.setTurnState(stats.state, atMs);
    this.setFloor(stats.floor, atMs);
    this.setProfile(stats.profileId, atMs);
    this.setDurability({
      phase: stats.phase,
      durabilityScore: stats.durabilityScore,
      disconnects: stats.disconnects,
      resumes: stats.resumes,
      recoveries: stats.recoveries,
    }, atMs);
    this.bargeIns = stats.bargeIns;
    this.updatedAtMs = atMs;
  }

  private computeAlerts(atMs: number): string[] {
    const alerts: string[] = [];
    if (this.durability.phase === 'disconnected') {
      alerts.push('Session disconnected — reconnecting with backoff.');
    }
    if (this.durability.phase === 'degraded') {
      alerts.push('Session degraded — heartbeats late, load shedding active.');
    }
    if (this.durability.durabilityScore < this.opts.lowDurabilityThreshold) {
      alerts.push(`Durability low: ${(this.durability.durabilityScore * 100).toFixed(0)}% (checkpoint behind journal).`);
    }
    if (this.durability.lastResumeOutcome === 'resumed-with-gaps') {
      alerts.push(`Last resume had ${this.durability.lastResumeMissingSeqs} missing journal seq(s).`);
    }
    if (this.recovery.gaveUp) {
      alerts.push('Reconnect attempts exhausted — session gave up.');
    }
    if (this.recovery.meanRttMs > this.opts.highRttMs) {
      alerts.push(`Heartbeat RTT high: mean ${round2V22(this.recovery.meanRttMs)} ms.`);
    }
    if (this.recovery.degradationSteps.length > 0) {
      alerts.push(`Load shedding active: ${this.recovery.degradationSteps.join(', ')}.`);
    }
    void atMs;
    return alerts;
  }

  snapshot(atMs: number): VoiceV22MonitorSnapshot {
    return {
      sessionId: this.sessionId,
      updatedAtMs: this.updatedAtMs,
      turnState: this.turnState,
      msInState: Math.max(0, atMs - this.stateSinceMs),
      floor: this.floor,
      profileId: this.profileId,
      livePartial: this.livePartial,
      finalTranscript: [...this.finalTranscript],
      bargeIns: this.bargeIns,
      ducksSoft: this.ducksSoft,
      ducksHard: this.ducksHard,
      lastBargeInDecision: this.lastBargeInDecision,
      durability: { ...this.durability },
      recovery: { ...this.recovery, degradationSteps: [...this.recovery.degradationSteps] },
      queuedReplies: this.queuedReplies.map((q) => ({ ...q })),
      alerts: this.computeAlerts(atMs),
    };
  }

  /** Markdown rendering of the current snapshot, for logs. */
  markdown(atMs: number): string {
    const s = this.snapshot(atMs);
    const lines = [
      '# Voice monitor v22',
      '',
      `- Session: ${s.sessionId} — state: ${s.turnState} (${s.msInState} ms), floor: ${s.floor}, profile: ${s.profileId}`,
      `- Phase: ${s.durability.phase} — durability ${(s.durability.durabilityScore * 100).toFixed(0)}% (journal seq ${s.durability.journalSeq}, checkpoint @${s.durability.lastCheckpointSeq ?? 'none'})`,
      `- Live: ${s.livePartial === '' ? '(silence)' : s.livePartial}`,
      `- Recovery: ${s.recovery.heartbeats} heartbeats (mean RTT ${s.recovery.meanRttMs} ms, max ${s.recovery.maxRttMs} ms), ` +
        `${s.recovery.reconnectAttempts} reconnect attempts (${s.recovery.reconnectSuccesses} ok)`,
      `- Last resume: ${s.durability.lastResumeOutcome ?? 'none'}${s.durability.lastResumeMissingSeqs > 0 ? ` (${s.durability.lastResumeMissingSeqs} missing seqs)` : ''}`,
      `- Barge-ins: ${s.bargeIns} interrupts, ${s.ducksHard} hard ducks, ${s.ducksSoft} soft ducks (last: ${s.lastBargeInDecision ?? 'none'})`,
      `- Queued replies: ${s.queuedReplies.length}${s.queuedReplies.map((q) => ` [${q.id}: ${q.remainingChars} chars, ${q.disposition}]`).join('')}`,
      `- Degradation: ${s.recovery.degradationSteps.length === 0 ? 'none' : s.recovery.degradationSteps.join(', ')}`,
      '',
    ];
    if (s.finalTranscript.length > 0) {
      lines.push('## Transcript', '');
      for (const line of s.finalTranscript) lines.push(`- ${line}`);
      lines.push('');
    }
    lines.push('## Alerts', '');
    if (s.alerts.length === 0) lines.push('- None');
    else for (const a of s.alerts) lines.push(`- ${a}`);
    lines.push('');
    return lines.join('\n');
  }

  summary(atMs: number): string {
    const s = this.snapshot(atMs);
    return `monitor v22: ${s.turnState} (${s.msInState} ms), phase=${s.durability.phase}, ` +
      `durability=${(s.durability.durabilityScore * 100).toFixed(0)}%, profile=${s.profileId}, ` +
      `barge-ins=${s.bargeIns}, queued=${s.queuedReplies.length}, alerts=${s.alerts.length}`;
  }
}

export function createMonitorPanelV22(
  sessionId: string,
  opts: Partial<VoiceV22MonitorPanelOptions> = {},
): MonitorPanelV22 {
  return new MonitorPanelV22(sessionId, opts);
}

/** Durability score as a 0..1 number (1 when checkpointed at the tip). */
export function durabilityScoreV22(checkpointSeq: number | null, journalSeq: number): number {
  if (journalSeq === 0) return 1;
  if (checkpointSeq === null) return 0;
  return round4V22(Math.min(1, Math.max(0, checkpointSeq / journalSeq)));
}
