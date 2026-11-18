/**
 * Monitor panel for voice v23 (v1.36, Team T5).
 *
 * v22's panel showed one session's durability; v23's panel
 * shows what v23 measures: the eval report (WER / latency /
 * MOS-proxy), the streaming state (adaptive buffer target,
 * jitter, underruns), the interruption ledger, the session
 * manager's fleet view, and the calibration result for the
 * current device. Alerts fire when a budget is breached —
 * WER over budget, p95 latency over budget, MOS-proxy below
 * floor, buffer underruns, or a failed managed session —
 * so the panel answers "is voice healthy?" in one glance.
 *
 * The panel is a plain data holder + markdown renderer: it
 * never opens audio, never dials a network. All text goes
 * through the `voice.v23.panel.*` i18n keys listed below.
 */
import type { EvalHarnessV23Report } from './evalHarnessV23';
import type { VoiceV23BufferStats } from './streamingV23';
import type { VoiceV23InterruptionStats } from './interruptionV23';
import type { VoiceV23SessionManagerStats } from './sessionManagerV23';
import type { VoiceV23CalibrationResult } from './calibrationV23';

export const VOICE_V23_PANEL_I18N_KEYS = [
  'voice.v23.panel.title',
  'voice.v23.panel.eval',
  'voice.v23.panel.wer',
  'voice.v23.panel.latency',
  'voice.v23.panel.mos',
  'voice.v23.panel.streaming',
  'voice.v23.panel.buffer',
  'voice.v23.panel.jitter',
  'voice.v23.panel.underruns',
  'voice.v23.panel.interruptions',
  'voice.v23.panel.sessions',
  'voice.v23.panel.calibration',
  'voice.v23.panel.environment',
  'voice.v23.panel.gain',
  'voice.v23.panel.threshold',
  'voice.v23.panel.noAlerts',
  'voice.v23.panel.alerts',
  'voice.v23.panel.pass',
  'voice.v23.panel.fail',
] as const;

export interface VoiceV23MonitorPanelOptions {
  /** WER above this raises an alert (default 0.15). */
  werAlert: number;
  /** p95 first-token latency above this raises an alert, ms (default 800). */
  latencyAlertMs: number;
  /** MOS-proxy below this raises an alert (default 3.0). */
  mosAlert: number;
  /** Buffer underruns above this raise an alert (default 3). */
  underrunAlert: number;
}

export function defaultMonitorPanelV23Options(): VoiceV23MonitorPanelOptions {
  return { werAlert: 0.15, latencyAlertMs: 800, mosAlert: 3.0, underrunAlert: 3 };
}

export function validateMonitorPanelV23Options(o: Partial<VoiceV23MonitorPanelOptions>): string[] {
  const errors: string[] = [];
  if (o.werAlert !== undefined && !(o.werAlert >= 0 && o.werAlert <= 1)) errors.push('werAlert must be 0..1');
  if (o.latencyAlertMs !== undefined && !(o.latencyAlertMs >= 0 && o.latencyAlertMs <= 10000)) errors.push('latencyAlertMs must be 0..10000');
  if (o.mosAlert !== undefined && !(o.mosAlert >= 1 && o.mosAlert <= 5)) errors.push('mosAlert must be 1..5');
  if (o.underrunAlert !== undefined && !(o.underrunAlert >= 0 && o.underrunAlert <= 1000)) errors.push('underrunAlert must be 0..1000');
  return errors;
}

export interface VoiceV23MonitorSnapshot {
  atMs: number;
  eval: {
    meanWer: number;
    p95FirstTokenMs: number;
    meanMos: number;
    passes: boolean;
  } | null;
  streaming: VoiceV23BufferStats | null;
  interruptions: VoiceV23InterruptionStats | null;
  sessions: VoiceV23SessionManagerStats | null;
  calibration: {
    environment: string;
    noiseFloor: number;
    speechThreshold: number;
    gain: number;
    snrDb: number;
    confidence: number;
  } | null;
  alerts: string[];
}

export class MonitorPanelV23 {
  private readonly opts: VoiceV23MonitorPanelOptions;
  private evalReport: EvalHarnessV23Report | null = null;
  private bufferStats: VoiceV23BufferStats | null = null;
  private interruptionStats: VoiceV23InterruptionStats | null = null;
  private sessionStats: VoiceV23SessionManagerStats | null = null;
  private calibration: VoiceV23CalibrationResult | null = null;
  private updatedAtMs = 0;

  constructor(opts: Partial<VoiceV23MonitorPanelOptions> = {}) {
    const errors = validateMonitorPanelV23Options(opts);
    if (errors.length > 0) throw new Error(`Invalid MonitorPanelV23 options: ${errors.join('; ')}`);
    this.opts = { ...defaultMonitorPanelV23Options(), ...opts };
  }

  options(): VoiceV23MonitorPanelOptions {
    return { ...this.opts };
  }

  setEval(report: EvalHarnessV23Report, atMs: number): void {
    this.evalReport = report;
    this.updatedAtMs = atMs;
  }

  setStreaming(stats: VoiceV23BufferStats, atMs: number): void {
    this.bufferStats = { ...stats };
    this.updatedAtMs = atMs;
  }

  setInterruptions(stats: VoiceV23InterruptionStats, atMs: number): void {
    this.interruptionStats = { ...stats };
    this.updatedAtMs = atMs;
  }

  setSessions(stats: VoiceV23SessionManagerStats, atMs: number): void {
    this.sessionStats = { ...stats };
    this.updatedAtMs = atMs;
  }

  setCalibration(result: VoiceV23CalibrationResult, atMs: number): void {
    this.calibration = { ...result };
    this.updatedAtMs = atMs;
  }

  alerts(): string[] {
    const alerts: string[] = [];
    if (this.evalReport !== null) {
      if (this.evalReport.transcript.meanWer > this.opts.werAlert) {
        alerts.push(`WER ${this.evalReport.transcript.meanWer} over ${this.opts.werAlert}`);
      }
      if (this.evalReport.latency.p95FirstTokenMs > this.opts.latencyAlertMs) {
        alerts.push(`p95 first-token ${this.evalReport.latency.p95FirstTokenMs}ms over ${this.opts.latencyAlertMs}ms`);
      }
      if (this.evalReport.mos.meanMos < this.opts.mosAlert) {
        alerts.push(`MOS-proxy ${this.evalReport.mos.meanMos} below ${this.opts.mosAlert}`);
      }
      if (!this.evalReport.passes) alerts.push(`eval FAIL: ${this.evalReport.failures.join('; ')}`);
    }
    if (this.bufferStats !== null && this.bufferStats.underruns > this.opts.underrunAlert) {
      alerts.push(`buffer underruns ${this.bufferStats.underruns} over ${this.opts.underrunAlert}`);
    }
    if (this.sessionStats !== null && this.sessionStats.failed > 0) {
      alerts.push(`${this.sessionStats.failed} managed session(s) failed`);
    }
    if (this.interruptionStats !== null && this.interruptionStats.falsePositives > 0) {
      alerts.push(`${this.interruptionStats.falsePositives} false-positive interruption(s)`);
    }
    return alerts;
  }

  snapshot(atMs: number): VoiceV23MonitorSnapshot {
    return {
      atMs,
      eval:
        this.evalReport === null
          ? null
          : {
              meanWer: this.evalReport.transcript.meanWer,
              p95FirstTokenMs: this.evalReport.latency.p95FirstTokenMs,
              meanMos: this.evalReport.mos.meanMos,
              passes: this.evalReport.passes,
            },
      streaming: this.bufferStats === null ? null : { ...this.bufferStats },
      interruptions: this.interruptionStats === null ? null : { ...this.interruptionStats },
      sessions: this.sessionStats === null ? null : { ...this.sessionStats },
      calibration:
        this.calibration === null
          ? null
          : {
              environment: this.calibration.environment,
              noiseFloor: this.calibration.noiseFloor,
              speechThreshold: this.calibration.speechThreshold,
              gain: this.calibration.gain,
              snrDb: this.calibration.snrDb,
              confidence: this.calibration.confidence,
            },
      alerts: this.alerts(),
    };
  }

  markdown(atMs: number): string {
    const snap = this.snapshot(atMs);
    const lines = ['# Voice v23 monitor', ''];
    if (snap.eval !== null) {
      lines.push(`- Eval: WER ${snap.eval.meanWer} · p95 first-token ${snap.eval.p95FirstTokenMs}ms · MOS-proxy ${snap.eval.meanMos} · ${snap.eval.passes ? 'PASS' : 'FAIL'}`);
    } else {
      lines.push('- Eval: not run yet');
    }
    if (snap.streaming !== null) {
      lines.push(`- Streaming: buffer target ${snap.streaming.targetMs}ms · buffered ${snap.streaming.bufferedMs}ms · jitter ${snap.streaming.jitterMs}ms (p95 ${snap.streaming.jitterP95Ms}ms) · underruns ${snap.streaming.underruns}`);
    }
    if (snap.interruptions !== null) {
      lines.push(`- Interruptions: ${snap.interruptions.total} decided (${snap.interruptions.interrupts} interrupt, ${snap.interruptions.ignored} ignored, ${snap.interruptions.falsePositives} false positives)`);
    }
    if (snap.sessions !== null) {
      lines.push(`- Sessions: ${snap.sessions.sessions} managed (${snap.sessions.live} live, ${snap.sessions.reconnecting} reconnecting, ${snap.sessions.failed} failed)`);
    }
    if (snap.calibration !== null) {
      lines.push(`- Calibration: ${snap.calibration.environment} room · floor ${snap.calibration.noiseFloor} · threshold ${snap.calibration.speechThreshold} · gain ${snap.calibration.gain}x · SNR ${snap.calibration.snrDb}dB · confidence ${snap.calibration.confidence}`);
    }
    if (snap.alerts.length === 0) lines.push('- Alerts: none');
    else for (const a of snap.alerts) lines.push(`- Alert: ${a}`);
    lines.push('');
    return lines.join('\n');
  }

  updatedAt(): number {
    return this.updatedAtMs;
  }

  summary(): string {
    const alerts = this.alerts();
    return `voice v23 panel: eval ${this.evalReport === null ? 'not run' : this.evalReport.passes ? 'PASS' : 'FAIL'}, ${alerts.length} alert(s)`;
  }
}

export function createMonitorPanelV23(opts: Partial<VoiceV23MonitorPanelOptions> = {}): MonitorPanelV23 {
  return new MonitorPanelV23(opts);
}
