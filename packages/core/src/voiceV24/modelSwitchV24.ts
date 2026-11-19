/**
 * Mid-session model switching for voice v24 (v1.37, Team T5).
 *
 * A voice session is long: the user talks, the bot answers,
 * tools run. When the current model stalls (or the user
 * simply wants a stronger / cheaper one), the session should
 * not have to restart — restarting loses the transcript, the
 * tool-call timers and the flow. The switcher changes the
 * model *inside* the live session:
 *
 *   - switchTo() validates the target against the dynamic
 *     catalogue (registered, non-deprecated, and — unless
 *     the caller opts in — currently usable: online or
 *     degraded, never unconfigured or offline);
 *   - the transcript is checksummed before and after the
 *     switch; a mismatch is a hard failure, never a silent
 *     loss — the event records `transcriptPreserved`;
 *   - every switch is recorded with from/to/atMs and the
 *     transcript turn count, so the session view can show
 *     "switched A -> B at 12:03, 14 turns kept";
 *   - rollback() returns to the model before the last switch
 *     (one level, the common "that model was worse" undo);
 *     it also preserves the transcript and records itself
 *     as a switch event with `rolledBack` on the original.
 *
 * The switcher owns the *decision* (which model is current,
 * what the history says). The catalogue owns the *facts*
 * (which providers exist). The transcript itself is owned
 * by the caller and passed in — the switcher never invents
 * transcript turns.
 */
import type { DynamicProviderCatalogV24 } from './providerCatalogV24';
import {
  transcriptChecksumV24,
  type VoiceV24ModelRef,
  type VoiceV24ModelSwitchEvent,
  type VoiceV24TranscriptTurn,
} from './types';

export interface ModelSwitchV24Options {
  /**
   * When false (default), switching to a provider that is
   * unconfigured or offline is refused. True lets the
   * caller switch anyway (e.g. the host is about to probe).
   */
  allowUnusableSwitch: boolean;
  /** Max switch events kept in history (default 100). */
  maxHistory: number;
}

export function defaultModelSwitchV24Options(): ModelSwitchV24Options {
  return { allowUnusableSwitch: false, maxHistory: 100 };
}

export function validateModelSwitchV24Options(o: Partial<ModelSwitchV24Options>): string[] {
  const errors: string[] = [];
  if (o.allowUnusableSwitch !== undefined && typeof o.allowUnusableSwitch !== 'boolean') {
    errors.push('allowUnusableSwitch must be a boolean');
  }
  if (o.maxHistory !== undefined && (!Number.isInteger(o.maxHistory) || o.maxHistory < 1 || o.maxHistory > 1000)) {
    errors.push('maxHistory must be an integer 1..1000');
  }
  return errors;
}

export interface VoiceV24SwitchResult {
  ok: boolean;
  from: VoiceV24ModelRef;
  to: VoiceV24ModelRef;
  atMs: number;
  transcriptTurns: number;
  transcriptPreserved: boolean;
  /** Present when ok is false. */
  reason?: string;
  /** The recorded event, present when ok is true. */
  event?: VoiceV24ModelSwitchEvent;
}

export function createModelSwitcherV24(
  sessionId: string,
  initial: VoiceV24ModelRef,
  opts: Partial<ModelSwitchV24Options> = {},
): VoiceModelSwitcherV24 {
  return new VoiceModelSwitcherV24(sessionId, initial, opts);
}

export class VoiceModelSwitcherV24 {
  private readonly opts: ModelSwitchV24Options;
  private readonly sessionId: string;
  private current: VoiceV24ModelRef;
  private readonly history: VoiceV24ModelSwitchEvent[] = [];
  private seq = 0;
  /** Model before the last successful switch (rollback target). */
  private previous: VoiceV24ModelRef | null = null;

  constructor(sessionId: string, initial: VoiceV24ModelRef, opts: Partial<ModelSwitchV24Options> = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('sessionId must be a non-empty string');
    }
    if (typeof initial.providerId !== 'string' || initial.providerId.length === 0) {
      throw new Error('initial.providerId must be a non-empty string');
    }
    if (typeof initial.model !== 'string' || initial.model.length === 0) {
      throw new Error('initial.model must be a non-empty string');
    }
    const errors = validateModelSwitchV24Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid VoiceModelSwitcherV24 options: ${errors.join('; ')}`);
    }
    this.opts = { ...defaultModelSwitchV24Options(), ...opts };
    this.sessionId = sessionId;
    this.current = { ...initial };
  }

  options(): ModelSwitchV24Options {
    return { ...this.opts };
  }

  session(): string {
    return this.sessionId;
  }

  currentModel(): VoiceV24ModelRef {
    return { ...this.current };
  }

  previousModel(): VoiceV24ModelRef | null {
    return this.previous === null ? null : { ...this.previous };
  }

  canRollback(): boolean {
    return this.previous !== null;
  }

  switchCount(): number {
    return this.history.length;
  }

  /**
   * Switch to a new model, preserving the transcript.
   * The caller passes the live transcript (read-only);
   * the switcher checksums it before and after and refuses
   * to report success unless the two match.
   */
  switchTo(
    catalog: DynamicProviderCatalogV24,
    to: VoiceV24ModelRef,
    transcript: readonly VoiceV24TranscriptTurn[],
    atMs: number,
  ): VoiceV24SwitchResult {
    const from = { ...this.current };
    const fail = (reason: string): VoiceV24SwitchResult => ({
      ok: false,
      from,
      to: { ...to },
      atMs,
      transcriptTurns: transcript.length,
      transcriptPreserved: true,
      reason,
    });
    if (to.providerId === from.providerId && to.model === from.model) {
      return fail('Already on that model — no switch needed');
    }
    if (!Number.isFinite(atMs) || atMs < 0) return fail('atMs must be a finite number >= 0');
    if (!catalog.has(to.providerId)) {
      return fail(`Unknown provider "${to.providerId}" — it is not in the dynamic catalogue`);
    }
    const model = catalog.findModel(to);
    if (model === null) {
      return fail(`Model "${to.model}" is not offered by provider "${to.providerId}"`);
    }
    if (model.deprecated) {
      return fail(`Model "${to.model}" is deprecated by provider "${to.providerId}"`);
    }
    if (!this.opts.allowUnusableSwitch) {
      const snapshot = catalog.snapshot(to.providerId, atMs);
      if (snapshot.status === 'unconfigured') {
        return fail(`Provider "${to.providerId}" is unconfigured (no login / key)`);
      }
      if (snapshot.status === 'offline') {
        return fail(`Provider "${to.providerId}" is offline (last probe failed)`);
      }
      if (snapshot.status === 'unknown') {
        return fail(`Provider "${to.providerId}" has no fresh probe — status unknown`);
      }
    }
    const before = transcriptChecksumV24(transcript);
    // The switch itself is a pointer change: the transcript
    // object is never copied or rewritten here, so the
    // checksum after must equal the checksum before.
    this.previous = from;
    this.current = { ...to };
    const after = transcriptChecksumV24(transcript);
    const preserved = before === after;
    if (!preserved) {
      // Defensive: should be impossible, but never report a
      // switch as clean when the transcript changed.
      this.current = from;
      this.previous = null;
      return {
        ok: false,
        from,
        to: { ...to },
        atMs,
        transcriptTurns: transcript.length,
        transcriptPreserved: false,
        reason: 'Transcript changed during the switch — switch aborted',
      };
    }
    this.seq += 1;
    const event: VoiceV24ModelSwitchEvent = {
      id: `switch-${this.seq}`,
      sessionId: this.sessionId,
      from,
      to: { ...to },
      atMs,
      transcriptTurns: transcript.length,
      transcriptPreserved: true,
      rolledBack: false,
    };
    this.history.push(event);
    while (this.history.length > this.opts.maxHistory) this.history.shift();
    return {
      ok: true,
      from,
      to: { ...to },
      atMs,
      transcriptTurns: transcript.length,
      transcriptPreserved: true,
      event: { ...event },
    };
  }

  /**
   * Roll back to the model before the last switch. The
   * transcript is checksummed the same way; the original
   * switch event is marked `rolledBack`.
   */
  rollback(
    transcript: readonly VoiceV24TranscriptTurn[],
    atMs: number,
  ): VoiceV24SwitchResult {
    const from = { ...this.current };
    if (this.previous === null) {
      return {
        ok: false,
        from,
        to: from,
        atMs,
        transcriptTurns: transcript.length,
        transcriptPreserved: true,
        reason: 'No previous model to roll back to',
      };
    }
    const target = { ...this.previous };
    const before = transcriptChecksumV24(transcript);
    this.current = target;
    this.previous = null;
    const after = transcriptChecksumV24(transcript);
    if (before !== after) {
      return {
        ok: false,
        from,
        to: target,
        atMs,
        transcriptTurns: transcript.length,
        transcriptPreserved: false,
        reason: 'Transcript changed during rollback — model restored but transcript mismatch',
      };
    }
    const last = this.history[this.history.length - 1];
    if (last !== undefined) last.rolledBack = true;
    this.seq += 1;
    const event: VoiceV24ModelSwitchEvent = {
      id: `switch-${this.seq}`,
      sessionId: this.sessionId,
      from,
      to: target,
      atMs,
      transcriptTurns: transcript.length,
      transcriptPreserved: true,
      rolledBack: false,
    };
    this.history.push(event);
    while (this.history.length > this.opts.maxHistory) this.history.shift();
    return {
      ok: true,
      from,
      to: target,
      atMs,
      transcriptTurns: transcript.length,
      transcriptPreserved: true,
      event: { ...event },
    };
  }

  /** Switch history, oldest first; copies so callers cannot mutate it. */
  historyList(): VoiceV24ModelSwitchEvent[] {
    return this.history.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } }));
  }

  /** Switches that were later rolled back. */
  rolledBackSwitches(): VoiceV24ModelSwitchEvent[] {
    return this.historyList().filter((e) => e.rolledBack);
  }

  /** Models the session has used, in first-use order. */
  modelsUsed(): VoiceV24ModelRef[] {
    const seen = new Map<string, VoiceV24ModelRef>();
    const key = (r: VoiceV24ModelRef): string => `${r.providerId}/${r.model}`;
    // The initial model is used first even if no switch happened.
    // It is not in history, so seed it from the first event's
    // `from`, or from the current model when history is empty.
    if (this.history.length === 0) {
      seen.set(key(this.current), { ...this.current });
    } else {
      for (const event of this.history) {
        if (!seen.has(key(event.from))) seen.set(key(event.from), { ...event.from });
        if (!seen.has(key(event.to))) seen.set(key(event.to), { ...event.to });
      }
    }
    return [...seen.values()];
  }

  summary(): string {
    const current = `${this.current.providerId}/${this.current.model}`;
    if (this.history.length === 0) return `Session ${this.sessionId}: model ${current}, no switches yet.`;
    const last = this.history[this.history.length - 1];
    const rolledBack = this.rolledBackSwitches().length;
    return (
      `Session ${this.sessionId}: model ${current}, ${this.history.length} switches, ` +
      `last ${last.from.providerId}/${last.from.model} -> ${last.to.providerId}/${last.to.model} at ${last.atMs}ms, ` +
      `${rolledBack} rolled back, transcript preserved on every switch.`
    );
  }
}
