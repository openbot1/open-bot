/**
 * Multi-voice profiles v3 (v1.19, Đội T5 — voice v18).
 *
 * v17 resolved one voice per user + bot + context with a fallback
 * chain and JSON persistence — but switching voices mid-call was
 * free and untracked: a context change (chat → alert) swapped the
 * voice mid-sentence, a profile could be picked ten times in a
 * turn without the panel ever knowing, and there was no way to
 * say "this voice is slower for narration, faster for alerts"
 * without cloning the whole profile. v18 wraps the v17 store and
 * adds the layer a real voice picker needs:
 *
 *   1. Per-context tuning. A v18 profile keeps its v17 base
 *      (provider, voice id, rate, pitch, language, quality) and
 *      adds `contextTuning`: per-context overrides for rate,
 *      pitch and max chunk chars. `resolve()` applies the tuning
 *      for the requested context on top of the base profile, so
 *      one voice can be calm for narration and brisk for alerts
 *      without a second profile.
 *   2. Switching rules. A switch is a decision, not a side
 *      effect: `switchPolicy` (`immediate` | `after-turn` |
 *      `after-utterance`) says *when* a requested switch takes
 *      effect, and `switchCooldownMs` says how soon the next
 *      switch may happen. A switch requested too soon is
 *      *deferred* (recorded, applied when the cooldown ends or
 *      the turn ends — never silently dropped, never applied
 *      mid-sentence unless the policy says so).
 *   3. Per-profile usage. Every resolved profile is tracked:
 *      times used, last used, total characters spoken through it.
 *      `noteUsage()` is called by the session after a turn; the
 *      panel can show "most used voice" and the eval can check
 *      that a switch actually changed what was spoken.
 *   4. Switch history. Every switch (applied or deferred) is
 *      recorded with from/to, context, reason and time — the
 *      audit trail for "why did the voice change mid-call".
 *   5. The v17 guarantees carry over unchanged: the same
 *      fallback chain (user+bot+context → user+bot → user
 *      default → bot+context → bot → built-in default), the same
 *      JSON persistence (v18 extras serialise alongside), the
 *      same built-in presets (plus two v18 presets with tuning).
 *
 * Profiles are data, not audio: no synth, no sound card, no key.
 */

import {
  VoiceProfileStoreV17,
  createVoiceProfileStoreV17,
  defaultVoiceProfileV17,
  validateVoiceProfileV17,
  presetVoiceProfilesV17,
  isVoiceProfileV17Context,
  type VoiceProfileV17,
  type VoiceProfileV17Context,
  type VoiceProfileV17ResolveInput,
  type VoiceProfileV17ResolveResult,
  type VoiceProfileV17Stats,
} from '../voiceV17/voiceProfilesV17';

/** When a requested voice switch takes effect. */
export type VoiceSwitchPolicyV18 = 'immediate' | 'after-turn' | 'after-utterance';

export const VOICE_SWITCH_POLICIES_V18 = ['immediate', 'after-turn', 'after-utterance'] as const;

export function isVoiceSwitchPolicyV18(value: unknown): value is VoiceSwitchPolicyV18 {
  return typeof value === 'string' && (VOICE_SWITCH_POLICIES_V18 as readonly string[]).includes(value);
}

/** Per-context tuning applied on top of a profile's base rate/pitch/chunk size. */
export interface VoiceContextTuningV18 {
  rate?: number;
  pitch?: number;
  maxChunkChars?: number;
}

/** A v17 profile + v18 tuning, usage tracking and switch policy. */
export interface VoiceProfileV18 extends VoiceProfileV17 {
  /** Per-context rate/pitch/chunk overrides (absent = use the base values). */
  contextTuning?: Partial<Record<VoiceProfileV17Context, VoiceContextTuningV18>>;
  /** When a switch *to* this profile takes effect (default 'after-turn'). */
  switchPolicy?: VoiceSwitchPolicyV18;
  /** Minimum ms between switches away from this profile (default 0 = no cooldown). */
  switchCooldownMs?: number;
  /** Usage counters (maintained by the store, not by the caller). */
  timesUsed?: number;
  lastUsedAtMs?: number;
  totalCharsSpoken?: number;
}

/** One recorded voice switch (applied or deferred). */
export interface VoiceSwitchRecordV18 {
  id: string;
  atMs: number;
  userId?: string;
  botId: string;
  fromProfileId: string | undefined;
  toProfileId: string;
  context: VoiceProfileV17Context;
  /** Whether the switch took effect at once or was deferred. */
  applied: boolean;
  /** Why it was deferred (when deferred). */
  deferredReason?: string;
  policy: VoiceSwitchPolicyV18;
}

export interface VoiceProfileV18ResolveResult extends VoiceProfileV17ResolveResult {
  /** The profile with the requested context's tuning applied. */
  tunedProfile: VoiceProfileV18;
  /** Tuning that was applied (undefined = none for this context). */
  tuningApplied?: VoiceContextTuningV18;
}

export interface VoiceProfileV18Options {
  /** Default switch policy for profiles without one (default 'after-turn'). */
  defaultSwitchPolicy?: VoiceSwitchPolicyV18;
  /** Default cooldown between switches (ms, default 0). */
  defaultSwitchCooldownMs?: number;
}

export function defaultVoiceProfileV18Options(): Required<VoiceProfileV18Options> {
  return { defaultSwitchPolicy: 'after-turn', defaultSwitchCooldownMs: 0 };
}

export function validateVoiceProfileV18(profile: VoiceProfileV18): string[] {
  const errors = validateVoiceProfileV17(profile);
  if (profile.switchPolicy !== undefined && !isVoiceSwitchPolicyV18(profile.switchPolicy)) {
    errors.push(`unknown switch policy: ${profile.switchPolicy}`);
  }
  if (profile.switchCooldownMs !== undefined && (!Number.isFinite(profile.switchCooldownMs) || profile.switchCooldownMs < 0 || profile.switchCooldownMs > 600000)) {
    errors.push('switchCooldownMs must be 0..600000');
  }
  if (profile.contextTuning !== undefined) {
    for (const [context, tuning] of Object.entries(profile.contextTuning)) {
      if (!isVoiceProfileV17Context(context)) errors.push(`unknown tuning context: ${context}`);
      if (tuning === undefined) continue;
      if (tuning.rate !== undefined && (tuning.rate < 0.5 || tuning.rate > 2)) errors.push(`contextTuning.${context}.rate must be 0.5..2`);
      if (tuning.pitch !== undefined && (tuning.pitch < -12 || tuning.pitch > 12)) errors.push(`contextTuning.${context}.pitch must be -12..12`);
      if (tuning.maxChunkChars !== undefined && (tuning.maxChunkChars < 10 || tuning.maxChunkChars > 500)) {
        errors.push(`contextTuning.${context}.maxChunkChars must be 10..500`);
      }
    }
  }
  for (const field of ['timesUsed', 'totalCharsSpoken'] as const) {
    const value = profile[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) errors.push(`${field} must be a non-negative integer`);
  }
  return errors;
}

/** Apply a context's tuning on top of a base profile (pure, returns a new object). */
export function applyContextTuningV18(profile: VoiceProfileV18, context: VoiceProfileV17Context): VoiceProfileV18 {
  const tuning = profile.contextTuning?.[context];
  if (tuning === undefined) return { ...profile };
  return {
    ...profile,
    ...(tuning.rate !== undefined ? { rate: tuning.rate } : {}),
    ...(tuning.pitch !== undefined ? { pitch: tuning.pitch } : {}),
    ...(tuning.maxChunkChars !== undefined ? { maxChunkChars: tuning.maxChunkChars } : {}),
  };
}

export function defaultVoiceProfileV18(botId: string, overrides: Partial<VoiceProfileV18> = {}): VoiceProfileV18 {
  const base = defaultVoiceProfileV17(botId, overrides);
  return {
    ...base,
    ...(overrides.contextTuning !== undefined ? { contextTuning: overrides.contextTuning } : {}),
    switchPolicy: overrides.switchPolicy ?? 'after-turn',
    switchCooldownMs: overrides.switchCooldownMs ?? 0,
    timesUsed: overrides.timesUsed ?? 0,
    totalCharsSpoken: overrides.totalCharsSpoken ?? 0,
    ...(overrides.lastUsedAtMs !== undefined ? { lastUsedAtMs: overrides.lastUsedAtMs } : {}),
  };
}

/** Two extra v18 presets with per-context tuning (calm narration, brisk alerts). */
export function presetVoiceProfilesV18(botId: string): VoiceProfileV18[] {
  const v17 = presetVoiceProfilesV17(botId);
  const calm = defaultVoiceProfileV18(botId, {
    id: `preset-v18-calm-${botId}`,
    displayName: 'Giọng trầm (kể chuyện)',
    language: 'vi',
    rate: 0.9,
    pitch: -2,
    contextTuning: {
      narration: { rate: 0.8, pitch: -3, maxChunkChars: 140 },
      alert: { rate: 1.1, pitch: 0, maxChunkChars: 80 },
      whisper: { rate: 0.85, pitch: -4, maxChunkChars: 100 },
    },
    tags: ['calm', 'narration'],
  });
  const brisk = defaultVoiceProfileV18(botId, {
    id: `preset-v18-brisk-${botId}`,
    displayName: 'Giọng nhanh (thông báo)',
    language: 'vi',
    rate: 1.15,
    pitch: 1,
    contextTuning: {
      announcement: { rate: 1.25, pitch: 2, maxChunkChars: 90 },
      chat: { rate: 1.05, pitch: 0, maxChunkChars: 120 },
      alert: { rate: 1.3, pitch: 2, maxChunkChars: 70 },
    },
    tags: ['brisk', 'announcement'],
  });
  return [...v17.map((p) => defaultVoiceProfileV18(botId, p)), calm, brisk];
}

/**
 * Multi-voice profiles v3: a v17 store plus context tuning, switch
 * rules with cooldown + deferral, usage tracking and switch history.
 */
export class VoiceProfileStoreV18 {
  /** The wrapped v17 store (resolution + fallback chain live here). */
  readonly store: VoiceProfileStoreV17;
  private readonly options: Required<VoiceProfileV18Options>;
  private readonly extras = new Map<string, VoiceProfileV18>();
  private switchHistory: VoiceSwitchRecordV18[] = [];
  private deferredSwitches: VoiceSwitchRecordV18[] = [];
  private lastSwitchAtMs = -1;
  private activeProfileId: string | undefined;
  private switchSeq = 0;

  constructor(seedPresetsForBot?: string, options: VoiceProfileV18Options = {}) {
    this.store = createVoiceProfileStoreV17(seedPresetsForBot);
    this.options = { ...defaultVoiceProfileV18Options(), ...options };
  }

  private withExtras(profile: VoiceProfileV17): VoiceProfileV18 {
    const extra = this.extras.get(profile.id);
    const merged: VoiceProfileV18 = { ...profile, ...(extra ?? {}) };
    if (merged.switchPolicy === undefined) merged.switchPolicy = this.options.defaultSwitchPolicy;
    if (merged.switchCooldownMs === undefined) merged.switchCooldownMs = this.options.defaultSwitchCooldownMs;
    if (merged.timesUsed === undefined) merged.timesUsed = 0;
    if (merged.totalCharsSpoken === undefined) merged.totalCharsSpoken = 0;
    return merged;
  }

  set(profile: VoiceProfileV18): void {
    const errors = validateVoiceProfileV18(profile);
    if (errors.length > 0) throw new Error(`invalid voice profile v18: ${errors.join('; ')}`);
    this.extras.set(profile.id, { ...profile });
    this.store.set(profile);
  }

  get(id: string): VoiceProfileV18 | undefined {
    const found = this.store.get(id);
    return found === undefined ? undefined : this.withExtras(found);
  }

  remove(id: string): boolean {
    this.extras.delete(id);
    if (this.activeProfileId === id) this.activeProfileId = undefined;
    return this.store.remove(id);
  }

  list(): VoiceProfileV18[] {
    return this.store.list().map((p) => this.withExtras(p));
  }

  listForUser(userId: string): VoiceProfileV18[] {
    return this.store.listForUser(userId).map((p) => this.withExtras(p));
  }

  listForBot(botId: string): VoiceProfileV18[] {
    return this.store.listForBot(botId).map((p) => this.withExtras(p));
  }

  listForContext(context: VoiceProfileV17Context): VoiceProfileV18[] {
    return this.store.listForContext(context).map((p) => this.withExtras(p));
  }

  count(): number {
    return this.store.count();
  }

  setUserDefault(userId: string, profileId: string): void {
    this.store.setUserDefault(userId, profileId);
  }

  getUserDefault(userId: string): VoiceProfileV18 | undefined {
    const found = this.store.getUserDefault(userId);
    return found === undefined ? undefined : this.withExtras(found);
  }

  clearUserDefault(userId: string): boolean {
    return this.store.clearUserDefault(userId);
  }

  cloneForUser(profileId: string, userId: string, newId?: string): VoiceProfileV18 {
    const clone = this.store.cloneForUser(profileId, userId, newId);
    return this.withExtras(clone);
  }

  /** Resolve + apply the requested context's tuning. Does not switch the active profile. */
  resolve(input: VoiceProfileV17ResolveInput): VoiceProfileV18ResolveResult {
    const result = this.store.resolve(input);
    // Materialize the fallback default: the v17 resolve synthesizes
    // the built-in default without storing it, so a later
    // noteUsage() would not find it. Store it on first resolve.
    if (this.store.get(result.profile.id) === undefined) {
      this.store.set(result.profile);
    }
    const profile = this.withExtras(result.profile);
    const context = input.context ?? 'chat';
    const tunedProfile = applyContextTuningV18(profile, context);
    return { ...result, tunedProfile, tuningApplied: profile.contextTuning?.[context] };
  }

  /** The profile currently active for speech (undefined = nothing spoken yet). */
  getActiveProfile(): VoiceProfileV18 | undefined {
    return this.activeProfileId === undefined ? undefined : this.get(this.activeProfileId);
  }

  /**
   * Request a switch to a profile for a context. Immediate policy +
   * cooldown expired → applied at once. Otherwise the switch is
   * recorded as deferred and applied by `applyDeferredSwitches()`
   * when the turn/utterance ends or the cooldown expires.
   */
  requestSwitch(input: {
    profileId: string;
    botId: string;
    context: VoiceProfileV17Context;
    userId?: string;
    atMs: number;
    reason?: string;
  }): VoiceSwitchRecordV18 {
    const target = this.get(input.profileId);
    if (!target) throw new Error(`Unknown voice profile v18 "${input.profileId}".`);
    this.switchSeq += 1;
    const policy = target.switchPolicy ?? this.options.defaultSwitchPolicy;
    const cooldown = target.switchCooldownMs ?? this.options.defaultSwitchCooldownMs;
    const inCooldown = this.lastSwitchAtMs >= 0 && input.atMs - this.lastSwitchAtMs < cooldown;
    const sameProfile = this.activeProfileId === input.profileId;
    const applied = !sameProfile && policy === 'immediate' && !inCooldown;
    const record: VoiceSwitchRecordV18 = {
      id: `switch-v18-${this.switchSeq}`,
      atMs: input.atMs,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      botId: input.botId,
      fromProfileId: this.activeProfileId,
      toProfileId: input.profileId,
      context: input.context,
      applied,
      ...(applied
        ? {}
        : {
            deferredReason: sameProfile
              ? 'already active'
              : inCooldown
                ? `cooldown: ${cooldown - (input.atMs - this.lastSwitchAtMs)} ms remaining`
                : `policy ${policy}: waits for turn/utterance end`,
          }),
      policy,
    };
    this.switchHistory.push(record);
    if (applied) {
      this.activeProfileId = input.profileId;
      this.lastSwitchAtMs = input.atMs;
    } else if (!sameProfile) {
      this.deferredSwitches.push(record);
    }
    return record;
  }

  /** Apply deferred switches whose cooldown has expired (call at turn/utterance end). */
  applyDeferredSwitches(atMs: number): VoiceSwitchRecordV18[] {
    const applied: VoiceSwitchRecordV18[] = [];
    const stillDeferred: VoiceSwitchRecordV18[] = [];
    for (const record of this.deferredSwitches) {
      const target = this.get(record.toProfileId);
      const cooldown = target?.switchCooldownMs ?? this.options.defaultSwitchCooldownMs;
      const inCooldown = this.lastSwitchAtMs >= 0 && atMs - this.lastSwitchAtMs < cooldown;
      if (inCooldown) {
        stillDeferred.push(record);
        continue;
      }
      const appliedRecord: VoiceSwitchRecordV18 = { ...record, applied: true, atMs, deferredReason: undefined };
      this.switchHistory.push(appliedRecord);
      applied.push(appliedRecord);
      this.activeProfileId = record.toProfileId;
      this.lastSwitchAtMs = atMs;
    }
    this.deferredSwitches = stillDeferred;
    return applied;
  }

  deferredSwitchesList(): VoiceSwitchRecordV18[] {
    return [...this.deferredSwitches];
  }

  switchHistoryList(): VoiceSwitchRecordV18[] {
    return [...this.switchHistory];
  }

  /** Record that a profile was used to speak `chars` characters. */
  noteUsage(profileId: string, chars: number, atMs: number): void {
    const profile = this.get(profileId);
    if (!profile) throw new Error(`Unknown voice profile v18 "${profileId}".`);
    const updated: VoiceProfileV18 = {
      ...profile,
      timesUsed: (profile.timesUsed ?? 0) + 1,
      totalCharsSpoken: (profile.totalCharsSpoken ?? 0) + Math.max(0, chars),
      lastUsedAtMs: atMs,
    };
    this.extras.set(profileId, updated);
    this.store.set(updated);
  }

  /** Most-used profile (by times used, then chars spoken). */
  mostUsedProfile(): VoiceProfileV18 | undefined {
    const profiles = this.list();
    if (profiles.length === 0) return undefined;
    return profiles.reduce((best, p) =>
      (p.timesUsed ?? 0) > (best.timesUsed ?? 0) ||
      ((p.timesUsed ?? 0) === (best.timesUsed ?? 0) && (p.totalCharsSpoken ?? 0) > (best.totalCharsSpoken ?? 0))
        ? p
        : best,
    );
  }

  toJSON(): { version: 2; profiles: VoiceProfileV18[]; userDefaults: Record<string, string>; switchHistory: VoiceSwitchRecordV18[]; activeProfileId?: string } {
    const base = this.store.toJSON();
    return {
      version: 2,
      profiles: this.list(),
      userDefaults: base.userDefaults,
      switchHistory: this.switchHistory,
      ...(this.activeProfileId !== undefined ? { activeProfileId: this.activeProfileId } : {}),
    };
  }

  fromJSON(data: unknown): { loaded: number; dropped: number } {
    if (typeof data !== 'object' || data === null) throw new Error('voice profiles v18 import needs an object.');
    const obj = data as { profiles?: unknown; userDefaults?: unknown; switchHistory?: unknown; activeProfileId?: unknown };
    const userDefaults = typeof obj.userDefaults === 'object' && obj.userDefaults !== null ? obj.userDefaults : {};
    const result = this.store.fromJSON({ version: 1, profiles: obj.profiles ?? [], userDefaults });
    if (Array.isArray(obj.profiles)) {
      for (const raw of obj.profiles) {
        if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string') {
          const profile = raw as VoiceProfileV18;
          if (validateVoiceProfileV18(profile).length === 0) this.extras.set(profile.id, { ...profile });
        }
      }
    }
    if (Array.isArray(obj.switchHistory)) {
      this.switchHistory = obj.switchHistory.filter(
        (r): r is VoiceSwitchRecordV18 => typeof r === 'object' && r !== null && typeof (r as { id?: unknown }).id === 'string',
      );
    }
    if (typeof obj.activeProfileId === 'string') this.activeProfileId = obj.activeProfileId;
    return result;
  }

  droppedCount(): number {
    return this.store.droppedCount();
  }

  stats(): VoiceProfileV17Stats & { switches: number; deferredSwitches: number; activeProfileId: string | undefined } {
    const inner = this.store.stats();
    return {
      ...inner,
      switches: this.switchHistory.filter((s) => s.applied).length,
      deferredSwitches: this.deferredSwitches.length,
      activeProfileId: this.activeProfileId,
    };
  }

  summary(): string {
    const s = this.stats();
    return (
      `Voice profiles v18: ${s.profiles} profiles, ${s.switches} switches applied, ` +
      `${s.deferredSwitches} deferred, active ${s.activeProfileId ?? 'none'}`
    );
  }

  markdown(): string {
    const s = this.stats();
    const rows: string[] = [
      '# Voice profiles v18',
      '',
      `- Profiles: ${s.profiles}`,
      `- Switches applied: ${s.switches}, deferred: ${s.deferredSwitches}`,
      `- Active profile: ${s.activeProfileId ?? 'none'}`,
      '',
    ];
    const mostUsed = this.mostUsedProfile();
    if (mostUsed) {
      rows.push(`- Most used: ${mostUsed.displayName} (${mostUsed.timesUsed ?? 0} uses, ${mostUsed.totalCharsSpoken ?? 0} chars)`);
      rows.push('');
    }
    if (this.switchHistory.length > 0) {
      rows.push('## Switch history');
      rows.push('');
      for (const sw of this.switchHistory.slice(-10)) {
        rows.push(
          `- ${sw.id} at ${sw.atMs} ms: ${sw.fromProfileId ?? 'none'} → ${sw.toProfileId} (${sw.context}, ${sw.policy}${sw.applied ? '' : `, deferred: ${sw.deferredReason ?? ''}`})`,
        );
      }
      rows.push('');
    }
    return rows.join('\n');
  }
}

export function createVoiceProfileStoreV18(seedPresetsForBot?: string, options: VoiceProfileV18Options = {}): VoiceProfileStoreV18 {
  return new VoiceProfileStoreV18(seedPresetsForBot, options);
}

/** One-line summary of a voice profile store v18. */
export function voiceProfilesV18Summary(store: VoiceProfileStoreV18): string {
  return store.summary();
}

/** Markdown report of a voice profile store v18. */
export function voiceProfilesV18Markdown(store: VoiceProfileStoreV18): string {
  return store.markdown();
}
