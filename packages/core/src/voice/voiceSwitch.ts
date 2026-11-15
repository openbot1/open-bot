/**
 * Mid-call voice switching (v1.07, Team T5 — voice v4 + UI).
 *
 * v1.04 gave the call a voice profile (picked before dialling, in
 * the panel's picker) but no way to change it *during* the call:
 * the user had to hang up, pick another voice, and redial. The
 * profile store also never recorded *which* voice a call used at
 * which moment, so a transcript could not say "the model switched
 * to the slow voice here".
 *
 * This module is the switch itself, not the transport:
 *
 *   - `VoiceSwitchManager` holds the switchable voices (the six
 *     built-in profiles by default, plus any caller-supplied custom
 *     profiles) and the current one. `switchTo(id)` validates the
 *     id, refuses the voice already active, and records the switch
 *     (from / to / at / mid-call or not) in a bounded history.
 *   - `revert()` goes back to the voice before the last switch —
 *     the one-tap "that voice was worse" path. A revert is itself
 *     recorded, so the history stays a true timeline.
 *   - Switching is a *local* decision: the manager never dials,
 *     never touches a key, never talks to a provider. The v6
 *     session applies the new profile to the live call (rate /
 *     pitch / engine voice id travel with the profile); a host
 *     whose provider cannot switch mid-call applies it on the next
 *     turn instead and says so in the result (`applied: 'next-turn'`).
 *   - Every switch is validated against the profile rules
 *     (`validateVoiceProfile`): a custom profile with a bad rate
 *     or a bad language tag cannot become the live voice.
 *
 * The manager is deliberately separate from the session so the
 * panel, the tools, and the session all switch through the same
 * code path and the same history.
 */
import {
  DEFAULT_VOICE_PROFILES,
  validateVoiceProfile,
  type VoiceProfile,
} from './voiceProfiles';

export type VoiceSwitchApplyMode = 'immediate' | 'next-turn';

/** One recorded voice switch. */
export interface VoiceSwitchRecord {
  fromId: string | null;
  toId: string;
  /** Display name of the voice switched to. */
  toName: string;
  /** True when the call was live when the switch happened. */
  midCall: boolean;
  /** How the new voice takes effect on the live call. */
  applied: VoiceSwitchApplyMode;
  /** Why the switch happened (user pick, auto-switch, revert, ...). */
  reason: string;
  at: number;
}

export type VoiceSwitchResult =
  | {
      ok: true;
      record: VoiceSwitchRecord;
      /** The voice that was active before the switch (null on the first pick). */
      previous: VoiceProfile | null;
      current: VoiceProfile;
    }
  | { ok: false; reason: string };

export type VoiceSwitchEvent =
  | { kind: 'voice-switched'; record: VoiceSwitchRecord; at: number }
  | { kind: 'voice-switch-failed'; profileId: string; reason: string; at: number };

export type VoiceSwitchEventSink = (event: VoiceSwitchEvent) => void;

export interface VoiceSwitchManagerOptions {
  /** Switchable voices. Defaults to the six built-in profiles. */
  profiles?: readonly VoiceProfile[];
  /** Voice active at construction (must be in `profiles`). */
  initialId?: string;
  /** How a mid-call switch takes effect. Default 'immediate'. */
  applyMode?: VoiceSwitchApplyMode;
  /** Max history entries kept. Default 50. */
  maxHistoryEntries?: number;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink (switches + failures). */
  onEvent?: VoiceSwitchEventSink;
}

export interface VoiceSwitchStats {
  currentId: string | null;
  switches: number;
  reverts: number;
  failures: number;
  /** Switches that happened while a call was live. */
  midCallSwitches: number;
}

export class VoiceSwitchManager {
  private readonly profiles: VoiceProfile[];
  private current: VoiceProfile | null;
  private readonly applyMode: VoiceSwitchApplyMode;
  private readonly history: VoiceSwitchRecord[] = [];
  private readonly maxHistoryEntries: number;
  private readonly clock: () => number;
  private readonly onEvent: VoiceSwitchEventSink | undefined;
  private reverts = 0;
  private failures = 0;

  constructor(options: VoiceSwitchManagerOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.applyMode = options.applyMode ?? 'immediate';
    this.maxHistoryEntries = Math.max(1, options.maxHistoryEntries ?? 50);
    this.onEvent = options.onEvent;
    const supplied = options.profiles ?? DEFAULT_VOICE_PROFILES;
    // Copy + validate: a bad custom profile never enters the list.
    this.profiles = [];
    for (const profile of supplied) {
      const checked = validateVoiceProfile(profile);
      if (checked.ok) this.profiles.push({ ...checked.profile });
    }
    this.current = null;
    if (options.initialId) {
      const initial = this.find(options.initialId);
      if (initial) this.current = initial;
    }
    if (!this.current) this.current = this.profiles[0] ?? null;
  }

  /** Switchable voices (copies), current first. */
  listVoices(): VoiceProfile[] {
    const rest = this.profiles.filter((p) => p.id !== this.current?.id);
    return [...(this.current ? [this.current] : []), ...rest].map((p) => ({ ...p }));
  }

  /** All switchable voice ids. */
  listVoiceIds(): string[] {
    return this.profiles.map((p) => p.id);
  }

  getCurrent(): VoiceProfile | null {
    return this.current ? { ...this.current } : null;
  }

  getCurrentId(): string | null {
    return this.current?.id ?? null;
  }

  /** Switch history, oldest first (copies). */
  getHistory(): VoiceSwitchRecord[] {
    return this.history.map((h) => ({ ...h }));
  }

  /**
   * Switch to `profileId`. Fails (never throws) when the id is
   * unknown, already active, or the profile fails validation.
   * `midCall` records whether a call was live — it does not change
   * the decision, only the record.
   */
  switchTo(
    profileId: string,
    opts: { midCall?: boolean; reason?: string } = {},
  ): VoiceSwitchResult {
    const id = String(profileId ?? '').trim();
    if (!id) return this.fail(profileId, 'No voice id given.');
    const target = this.find(id);
    if (!target) return this.fail(id, `Unknown voice "${id}".`);
    const checked = validateVoiceProfile(target);
    if (!checked.ok) return this.fail(id, checked.error);
    if (this.current && this.current.id === checked.profile.id) {
      return this.fail(id, `Voice "${id}" is already active.`);
    }
    const previous = this.current ? { ...this.current } : null;
    this.current = { ...checked.profile };
    const record: VoiceSwitchRecord = {
      fromId: previous?.id ?? null,
      toId: this.current.id,
      toName: this.current.name,
      midCall: opts.midCall ?? false,
      applied: this.applyMode,
      reason: opts.reason ?? 'user pick',
      at: this.clock(),
    };
    this.pushHistory(record);
    this.emit({ kind: 'voice-switched', record: { ...record }, at: record.at });
    return { ok: true, record: { ...record }, previous, current: { ...this.current } };
  }

  /**
   * Go back to the voice before the last switch. Fails when there
   * is no previous voice (nothing switched yet) or the previous
   * voice is no longer in the list.
   */
  revert(opts: { midCall?: boolean } = {}): VoiceSwitchResult {
    const last = this.history.at(-1);
    if (!last || !last.fromId) {
      return this.fail('', 'No previous voice to revert to.');
    }
    const previous = this.find(last.fromId);
    if (!previous) {
      return this.fail(last.fromId, `Previous voice "${last.fromId}" is no longer available.`);
    }
    const result = this.switchTo(previous.id, {
      midCall: opts.midCall,
      reason: 'revert',
    });
    if (result.ok) this.reverts += 1;
    return result;
  }

  getStats(): VoiceSwitchStats {
    return {
      currentId: this.current?.id ?? null,
      switches: this.history.length,
      reverts: this.reverts,
      failures: this.failures,
      midCallSwitches: this.history.filter((h) => h.midCall).length,
    };
  }

  /** TTS options for the current voice (rate / engine voice id). */
  currentTtsOptions(): { voice: string | null; rate: number; pitch: number; volume: number } | null {
    if (!this.current) return null;
    return {
      voice: this.current.voice,
      rate: this.current.rate,
      pitch: this.current.pitch,
      volume: this.current.volume,
    };
  }

  private find(id: string): VoiceProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  private pushHistory(record: VoiceSwitchRecord): void {
    this.history.push(record);
    if (this.history.length > this.maxHistoryEntries) {
      this.history.splice(0, this.history.length - this.maxHistoryEntries);
    }
  }

  private fail(profileId: string, reason: string): VoiceSwitchResult {
    this.failures += 1;
    this.emit({ kind: 'voice-switch-failed', profileId, reason, at: this.clock() });
    return { ok: false, reason };
  }

  private emit(event: VoiceSwitchEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}

/**
 * One-line summary for the panel / logs: current voice + how many
 * switches happened this call.
 */
export function voiceSwitchSummary(manager: VoiceSwitchManager): string {
  const current = manager.getCurrent();
  const stats = manager.getStats();
  if (!current) return 'no voice selected';
  return `${current.name} (${current.lang}, ${current.rate}x) — ${stats.switches} switch(es), ${stats.reverts} revert(s)`;
}

/** Markdown report of the switch history (diagnostics / session log). */
export function voiceSwitchHistoryMarkdown(manager: VoiceSwitchManager): string {
  const history = manager.getHistory();
  const current = manager.getCurrent();
  const lines = [
    `# Voice switches (${history.length})`,
    '',
    `Current voice: ${current ? `${current.name} (\`${current.id}\`)` : '(none)'}`,
    '',
  ];
  if (history.length === 0) {
    lines.push('No switches yet.');
    return lines.join('\n');
  }
  lines.push('| When | From | To | Mid-call | Applied |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const record of history) {
    lines.push(
      `| ${new Date(record.at).toISOString()} | ${record.fromId ?? '(none)'} | ` +
        `${record.toName} (\`${record.toId}\`) | ${record.midCall ? 'yes' : 'no'} | ${record.applied} |`,
    );
  }
  return lines.join('\n');
}
