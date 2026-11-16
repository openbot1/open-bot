/**
 * Turn-taking manager v11 (v1.12, Đội T5 — voice realtime v11).
 *
 * v0.98's `TurnTakingMeter` timed barge-ins; it never *owned* the
 * floor. The v11 manager does: at any moment exactly one party
 * holds the floor (or nobody does), and every hand-off is an
 * explicit, logged event with a measured switch latency.
 *
 *   idle ──▶ user ──▶ thinking ──▶ agent ──▶ idle
 *             │  ▲                  │  ▲
 *             └──┴── overlap ──────┘  │
 *   (user starts while the agent speaks: `overlap` — the caller
 *   decides, via the barge-in controller, whether the agent yields
 *   or keeps the floor; the manager only records the overlap and
 *   who held the floor when it happened)
 *
 * Rules:
 * - A user turn starts on VAD speech-start and ends on VAD
 *   speech-end (or on a silence timeout). An agent turn starts
 *   when the first reply audio/text chunk is produced and ends
 *   when playback drains.
 * - Silence timeout: while the floor is `idle` (nobody speaking)
 *   and the user has not spoken for `silenceTimeoutMs`
 *   (default 8 s), the manager fires `silence-timeout` and, when
 *   `nudgeOnSilence` is set, a `nudge` event the panel renders as
 *   a gentle prompt ("Bạn còn đó không?"). The timeout re-arms
 *   after each nudge, up to `maxNudges` (default 2), then the
 *   manager fires `call-idle` and stops nudging — the call is
 *   left open but quiet, never auto-ended (ending a call is the
 *   user's decision).
 * - Max turn: a user turn longer than `maxUserTurnMs` (default
 *   30 s) or an agent turn longer than `maxAgentTurnMs` (default
 *   120 s) is force-ended with a `turn-timeout` event — a
 *   monologue cannot hold the floor forever.
 * - Yield detection: the caller feeds per-frame mic energy while
 *   the agent speaks (`noteEnergy`). When the agent's trailing
 *   energy falls for `yieldFrames` consecutive frames, the turn
 *   is marked `yieldLikely` — a falling tail is how a speaker
 *   signals "your turn". This is a hint for the panel, not a
 *   decision: the manager never ends an agent turn on energy
 *   alone.
 * - Switch latency: user-end → agent-start and agent-end →
 *   user-start are measured on the caller-owned virtual clock
 *   and aggregated (mean / p50 / p95 / max) in stats.
 *
 * The clock is injected (virtual ms in tests, wall ms live). No
 * audio device, no network, no model.
 */

/** Who holds the floor right now. */
export type TurnTakingV11Floor = 'idle' | 'user' | 'agent' | 'thinking' | 'overlap';

/** Options for `TurnTakingManagerV11`. */
export interface TurnTakingV11Options {
  /** Silence (ms) with the floor idle before a timeout fires. */
  silenceTimeoutMs?: number;
  /** Fire a nudge event on silence timeout (default true). */
  nudgeOnSilence?: boolean;
  /** Max nudges per idle stretch before `call-idle` (default 2). */
  maxNudges?: number;
  /** Longest a user turn may run (ms). */
  maxUserTurnMs?: number;
  /** Longest an agent turn may run (ms). */
  maxAgentTurnMs?: number;
  /** Consecutive falling-energy frames that mark a likely yield. */
  yieldFrames?: number;
  /** Max turns kept in history (default 100). */
  maxHistory?: number;
}

/** One completed turn. */
export interface TurnTakingV11Turn {
  id: number;
  speaker: 'user' | 'agent';
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  /** How the turn ended. */
  endedBy: 'speech-end' | 'barge-in' | 'timeout' | 'manual' | 'drained';
  /** True when the agent's trailing energy fell (yield hint). */
  yieldLikely: boolean;
  /** Overlaps that happened during this turn. */
  overlaps: number;
}

/** One overlap (user started while the agent held the floor). */
export interface TurnTakingV11Overlap {
  atMs: number;
  agentTurnId: number | null;
  /** Who kept the floor after the overlap was recorded. */
  floorAfter: TurnTakingV11Floor;
}

/** Events emitted by the manager. */
export type TurnTakingV11Event =
  | { kind: 'floor'; floor: TurnTakingV11Floor; atMs: number; turnId: number | null }
  | { kind: 'turn-started'; turn: TurnTakingV11Turn }
  | { kind: 'turn-ended'; turn: TurnTakingV11Turn }
  | { kind: 'overlap'; overlap: TurnTakingV11Overlap }
  | { kind: 'silence-timeout'; atMs: number; idleMs: number; nudge: number }
  | { kind: 'nudge'; atMs: number; nudge: number }
  | { kind: 'call-idle'; atMs: number; idleMs: number }
  | { kind: 'turn-timeout'; atMs: number; turnId: number; speaker: 'user' | 'agent'; durationMs: number };

export type TurnTakingV11EventSink = (event: TurnTakingV11Event) => void;

/** Aggregated turn-taking stats. */
export interface TurnTakingV11Stats {
  floor: TurnTakingV11Floor;
  turns: number;
  userTurns: number;
  agentTurns: number;
  overlaps: number;
  silenceTimeouts: number;
  nudges: number;
  turnTimeouts: number;
  /** Mean user-turn duration (ms, 0 when none). */
  meanUserTurnMs: number;
  /** Mean agent-turn duration (ms, 0 when none). */
  meanAgentTurnMs: number;
  /** Mean floor-switch latency (ms, 0 when none). */
  meanSwitchMs: number;
  /** Median floor-switch latency (ms, 0 when none). */
  p50SwitchMs: number;
  /** p95 floor-switch latency (ms, 0 when none). */
  p95SwitchMs: number;
  /** Slowest floor-switch latency (ms, 0 when none). */
  maxSwitchMs: number;
  /** Current idle stretch (ms, 0 while someone holds the floor). */
  idleMs: number;
  /** Current turn duration (ms, 0 when idle). */
  currentTurnMs: number;
  yieldLikely: boolean;
}

export function defaultTurnTakingV11Options(): Required<TurnTakingV11Options> {
  return {
    silenceTimeoutMs: 8000,
    nudgeOnSilence: true,
    maxNudges: 2,
    maxUserTurnMs: 30000,
    maxAgentTurnMs: 120000,
    yieldFrames: 5,
    maxHistory: 100,
  };
}

export function validateTurnTakingV11Options(options: TurnTakingV11Options): Required<TurnTakingV11Options> {
  const base = defaultTurnTakingV11Options();
  const num = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Turn-taking v11 ${name} must be a finite number in [${min}, ${max}].`);
    }
    return value;
  };
  return {
    silenceTimeoutMs: num(options.silenceTimeoutMs, base.silenceTimeoutMs, 'silenceTimeoutMs', 1000, 600000),
    nudgeOnSilence: options.nudgeOnSilence ?? base.nudgeOnSilence,
    maxNudges: Math.floor(num(options.maxNudges, base.maxNudges, 'maxNudges', 0, 20)),
    maxUserTurnMs: num(options.maxUserTurnMs, base.maxUserTurnMs, 'maxUserTurnMs', 1000, 600000),
    maxAgentTurnMs: num(options.maxAgentTurnMs, base.maxAgentTurnMs, 'maxAgentTurnMs', 1000, 600000),
    yieldFrames: Math.floor(num(options.yieldFrames, base.yieldFrames, 'yieldFrames', 1, 50)),
    maxHistory: Math.floor(num(options.maxHistory, base.maxHistory, 'maxHistory', 1, 1000)),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
}

/**
 * Turn-taking manager: owns the floor, times hand-offs, nudges
 * a quiet call, and caps monologues. The caller drives it with
 * explicit calls on the shared virtual clock.
 */
export class TurnTakingManagerV11 {
  private readonly options: Required<TurnTakingV11Options>;
  private readonly sink: TurnTakingV11EventSink | null;
  private floor: TurnTakingV11Floor = 'idle';
  private currentTurn: TurnTakingV11Turn | null = null;
  private nextTurnId = 1;
  private history: TurnTakingV11Turn[] = [];
  private overlaps: TurnTakingV11Overlap[] = [];
  private switchLatencies: number[] = [];
  private lastFloorChangeAtMs = 0;
  private lastActivityAtMs = 0;
  private started = false;
  private nudgesThisStretch = 0;
  private callIdleFired = false;
  private silenceTimeouts = 0;
  private nudges = 0;
  private turnTimeouts = 0;
  private lastEnergy: number | null = null;
  private fallingFrames = 0;
  private yieldLikely = false;

  constructor(options: TurnTakingV11Options = {}, sink: TurnTakingV11EventSink | null = null) {
    this.options = validateTurnTakingV11Options(options);
    this.sink = sink;
  }

  getOptions(): Required<TurnTakingV11Options> {
    return { ...this.options };
  }

  getFloor(): TurnTakingV11Floor {
    return this.floor;
  }

  getCurrentTurn(): TurnTakingV11Turn | null {
    return this.currentTurn ? { ...this.currentTurn } : null;
  }

  getHistory(): TurnTakingV11Turn[] {
    return this.history.map((t) => ({ ...t }));
  }

  getOverlaps(): TurnTakingV11Overlap[] {
    return this.overlaps.map((o) => ({ ...o }));
  }

  isYieldLikely(): boolean {
    return this.yieldLikely;
  }

  getStats(nowMs: number): TurnTakingV11Stats {
    const userTurns = this.history.filter((t) => t.speaker === 'user');
    const agentTurns = this.history.filter((t) => t.speaker === 'agent');
    const sorted = [...this.switchLatencies].sort((a, b) => a - b);
    return {
      floor: this.floor,
      turns: this.history.length,
      userTurns: userTurns.length,
      agentTurns: agentTurns.length,
      overlaps: this.overlaps.length,
      silenceTimeouts: this.silenceTimeouts,
      nudges: this.nudges,
      turnTimeouts: this.turnTimeouts,
      meanUserTurnMs: mean(userTurns.map((t) => t.durationMs)),
      meanAgentTurnMs: mean(agentTurns.map((t) => t.durationMs)),
      meanSwitchMs: mean(this.switchLatencies),
      p50SwitchMs: percentile(sorted, 50),
      p95SwitchMs: percentile(sorted, 95),
      maxSwitchMs: sorted.length > 0 ? (sorted[sorted.length - 1] as number) : 0,
      idleMs: this.floor === 'idle' && this.started ? Math.max(0, nowMs - this.lastActivityAtMs) : 0,
      currentTurnMs: this.currentTurn ? Math.max(0, nowMs - this.currentTurn.startedAtMs) : 0,
      yieldLikely: this.yieldLikely,
    };
  }

  /** Open the call (floor idle, silence clock starts). */
  start(nowMs: number): void {
    this.started = true;
    this.lastActivityAtMs = nowMs;
    this.lastFloorChangeAtMs = nowMs;
    this.setFloor('idle', nowMs, null);
  }

  /** The user starts speaking (VAD speech-start). */
  beginUserTurn(nowMs: number): TurnTakingV11Turn | null {
    if (this.floor === 'agent' || this.floor === 'thinking') {
      // Overlap: the user starts while the agent holds the floor.
      // Record it and hand the floor to `overlap` — the barge-in
      // controller decides who keeps it; this manager just notes
      // the collision and its timing.
      const overlap: TurnTakingV11Overlap = {
        atMs: nowMs,
        agentTurnId: this.currentTurn?.speaker === 'agent' ? this.currentTurn.id : null,
        floorAfter: 'overlap',
      };
      this.overlaps.push(overlap);
      if (this.currentTurn) this.currentTurn.overlaps += 1;
      this.setFloor('overlap', nowMs, this.currentTurn?.id ?? null);
      this.sink?.({ kind: 'overlap', overlap: { ...overlap } });
      return null;
    }
    if (this.floor === 'user' || this.floor === 'overlap') return this.currentTurn;
    return this.openTurn('user', nowMs);
  }

  /** The user stops speaking (VAD speech-end / backchannel / false-start). */
  endUserTurn(nowMs: number, endedBy: TurnTakingV11Turn['endedBy'] = 'speech-end'): TurnTakingV11Turn | null {
    if (this.floor === 'overlap') {
      // The overlap resolved in the user's favour: the agent's
      // turn is closed as barged-in and the user takes the floor.
      if (this.currentTurn?.speaker === 'agent') {
        this.closeTurn(nowMs, 'barge-in');
      }
      return this.openTurn('user', nowMs);
    }
    if (this.floor !== 'user') return null;
    return this.closeTurn(nowMs, endedBy);
  }

  /** The agent starts thinking (user turn ended, reply pending). */
  beginThinking(nowMs: number): boolean {
    if (this.floor !== 'idle' && this.floor !== 'user') return false;
    if (this.floor === 'user') this.closeTurn(nowMs, 'speech-end');
    this.setFloor('thinking', nowMs, null);
    return true;
  }

  /** Cancel a pending think (barge-in while thinking): floor back to idle. */
  cancelThinking(nowMs: number): boolean {
    if (this.floor !== 'thinking') return false;
    this.setFloor('idle', nowMs, null);
    return true;
  }

  /** The agent starts speaking (first reply chunk produced). */
  beginAgentTurn(nowMs: number): TurnTakingV11Turn | null {
    if (this.floor === 'agent') return this.currentTurn;
    if (this.floor === 'thinking' || this.floor === 'idle') {
      return this.openTurn('agent', nowMs);
    }
    return null;
  }

  /** The agent stops speaking (playback drained / interrupted). */
  endAgentTurn(nowMs: number, endedBy: TurnTakingV11Turn['endedBy'] = 'drained'): TurnTakingV11Turn | null {
    if (this.floor === 'overlap') {
      // The overlap resolved in the agent's favour: the user never
      // took the floor; the agent's turn simply continues.
      this.setFloor('agent', nowMs, this.currentTurn?.id ?? null);
      return this.currentTurn;
    }
    if (this.floor !== 'agent') return null;
    return this.closeTurn(nowMs, endedBy);
  }

  /**
   * Resolve an overlap explicitly: `user` hands the floor to the
   * user (agent turn closed as barged-in), `agent` hands it back
   * to the agent (the user's attempt is dropped).
   */
  resolveOverlap(winner: 'user' | 'agent', nowMs: number): TurnTakingV11Turn | null {
    if (this.floor !== 'overlap') return null;
    if (winner === 'user') return this.endUserTurn(nowMs, 'barge-in');
    return this.endAgentTurn(nowMs, 'drained');
  }

  /**
   * Feed one mic-energy sample (RMS 0..1) while the agent speaks.
   * Falling energy over `yieldFrames` frames marks the turn as
   * `yieldLikely` — a hint, never a decision.
   */
  noteEnergy(rms: number, _nowMs: number): void {
    if (this.floor !== 'agent' && this.floor !== 'overlap') {
      this.lastEnergy = null;
      this.fallingFrames = 0;
      return;
    }
    if (this.lastEnergy !== null) {
      if (rms < this.lastEnergy) {
        this.fallingFrames += 1;
      } else {
        this.fallingFrames = 0;
      }
      if (this.fallingFrames >= this.options.yieldFrames) {
        this.yieldLikely = true;
        if (this.currentTurn) this.currentTurn.yieldLikely = true;
      }
    }
    this.lastEnergy = rms;
  }

  /**
   * Advance timers: silence timeout / nudge / call-idle while the
   * floor is idle, and max-turn timeouts while a turn runs.
   * Call on every session tick with the virtual clock.
   */
  tick(nowMs: number): void {
    if (!this.started) return;
    if (this.floor === 'idle') {
      const idleMs = nowMs - this.lastActivityAtMs;
      if (idleMs >= this.options.silenceTimeoutMs) {
        if (this.nudgesThisStretch < this.options.maxNudges) {
          this.silenceTimeouts += 1;
          this.nudgesThisStretch += 1;
          this.nudges += 1;
          this.lastActivityAtMs = nowMs;
          this.sink?.({ kind: 'silence-timeout', atMs: nowMs, idleMs, nudge: this.nudgesThisStretch });
          if (this.options.nudgeOnSilence) {
            this.sink?.({ kind: 'nudge', atMs: nowMs, nudge: this.nudgesThisStretch });
          }
        } else if (!this.callIdleFired) {
          this.callIdleFired = true;
          this.sink?.({ kind: 'call-idle', atMs: nowMs, idleMs });
        }
      }
      return;
    }
    if (this.currentTurn) {
      const durationMs = nowMs - this.currentTurn.startedAtMs;
      const cap = this.currentTurn.speaker === 'user' ? this.options.maxUserTurnMs : this.options.maxAgentTurnMs;
      if (durationMs >= cap) {
        const turn = this.currentTurn;
        this.turnTimeouts += 1;
        this.closeTurn(nowMs, 'timeout');
        this.sink?.({ kind: 'turn-timeout', atMs: nowMs, turnId: turn.id, speaker: turn.speaker, durationMs });
      }
    }
  }

  /** Reset all state (new call). */
  reset(nowMs = 0): void {
    this.floor = 'idle';
    this.currentTurn = null;
    this.nextTurnId = 1;
    this.history = [];
    this.overlaps = [];
    this.switchLatencies = [];
    this.lastFloorChangeAtMs = nowMs;
    this.lastActivityAtMs = nowMs;
    this.started = false;
    this.nudgesThisStretch = 0;
    this.callIdleFired = false;
    this.silenceTimeouts = 0;
    this.nudges = 0;
    this.turnTimeouts = 0;
    this.lastEnergy = null;
    this.fallingFrames = 0;
    this.yieldLikely = false;
  }

  private openTurn(speaker: 'user' | 'agent', nowMs: number): TurnTakingV11Turn {
    const turn: TurnTakingV11Turn = {
      id: this.nextTurnId,
      speaker,
      startedAtMs: nowMs,
      endedAtMs: nowMs,
      durationMs: 0,
      endedBy: 'speech-end',
      yieldLikely: false,
      overlaps: 0,
    };
    this.nextTurnId += 1;
    this.currentTurn = turn;
    this.yieldLikely = false;
    this.fallingFrames = 0;
    this.lastEnergy = null;
    this.setFloor(speaker, nowMs, turn.id);
    this.sink?.({ kind: 'turn-started', turn: { ...turn } });
    return turn;
  }

  private closeTurn(nowMs: number, endedBy: TurnTakingV11Turn['endedBy']): TurnTakingV11Turn | null {
    const turn = this.currentTurn;
    if (!turn) return null;
    turn.endedAtMs = nowMs;
    turn.durationMs = Math.max(0, nowMs - turn.startedAtMs);
    turn.endedBy = endedBy;
    this.currentTurn = null;
    this.history.push({ ...turn });
    if (this.history.length > this.options.maxHistory) {
      this.history.splice(0, this.history.length - this.options.maxHistory);
    }
    this.setFloor('idle', nowMs, null);
    this.sink?.({ kind: 'turn-ended', turn: { ...turn } });
    return turn;
  }

  private setFloor(next: TurnTakingV11Floor, nowMs: number, turnId: number | null): void {
    if (next !== this.floor) {
      this.switchLatencies.push(Math.max(0, nowMs - this.lastFloorChangeAtMs));
      this.lastFloorChangeAtMs = nowMs;
    }
    this.floor = next;
    this.lastActivityAtMs = nowMs;
    if (next !== 'idle') {
      this.nudgesThisStretch = 0;
      this.callIdleFired = false;
    }
    this.sink?.({ kind: 'floor', floor: next, atMs: nowMs, turnId });
  }
}

/** One-line summary of turn-taking v11 stats. */
export function turnTakingV11Summary(stats: TurnTakingV11Stats): string {
  return (
    `Turn-taking v11: floor=${stats.floor}, ${stats.turns} turns ` +
    `(user ${stats.userTurns}, agent ${stats.agentTurns}), ${stats.overlaps} overlaps, ` +
    `${stats.silenceTimeouts} silence timeouts, ${stats.nudges} nudges, ${stats.turnTimeouts} timeouts, ` +
    `mean switch ${stats.meanSwitchMs} ms (p95 ${stats.p95SwitchMs} ms)`
  );
}

/** Turn-taking v11 stats as Markdown (for the diagnostics panel). */
export function turnTakingV11Markdown(stats: TurnTakingV11Stats): string {
  const lines = [
    '## Turn-taking v11',
    '',
    `- floor: ${stats.floor}`,
    `- turns: ${stats.turns} (user ${stats.userTurns}, agent ${stats.agentTurns})`,
    `- overlaps: ${stats.overlaps}, silence timeouts: ${stats.silenceTimeouts}, nudges: ${stats.nudges}, turn timeouts: ${stats.turnTimeouts}`,
    `- mean user turn: ${stats.meanUserTurnMs} ms, mean agent turn: ${stats.meanAgentTurnMs} ms`,
    `- switch latency: mean ${stats.meanSwitchMs} ms, p50 ${stats.p50SwitchMs} ms, p95 ${stats.p95SwitchMs} ms, max ${stats.maxSwitchMs} ms`,
    `- idle: ${stats.idleMs} ms, current turn: ${stats.currentTurnMs} ms, yield likely: ${stats.yieldLikely ? 'yes' : 'no'}`,
  ];
  return lines.join('\n');
}
