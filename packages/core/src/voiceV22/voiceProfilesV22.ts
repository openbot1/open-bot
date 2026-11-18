/**
 * Voice profiles v22 (voice v22, v1.35 Team T5).
 *
 * A voice profile is everything the TTS needs to sound like
 * one voice: an id, a display name, a locale, a speaking rate,
 * a pitch offset, a volume, and the engine that renders it.
 * Profiles are local data — no provider is dialled, no key is
 * read — and the mock engine renders every profile as
 * deterministic synthetic PCM, so switching profiles is fully
 * testable offline.
 *
 * What the registry adds over a bare list:
 *
 *   - Built-ins. Four profiles ship with the subsystem (a
 *     neutral default, a calm Vietnamese voice, a brisk English
 *     voice, and a warm storyteller), so a fresh session always
 *     has something to speak with.
 *   - Fallback chain. A profile names the profile to fall back
 *     to when its engine is unavailable; the chain is walked
 *     until a renderable profile is found, and a cycle is
 *     detected instead of looping forever.
 *   - Per-user defaults. Each user id maps to a preferred
 *     profile; the session asks the registry, not the caller,
 *     which voice to use — and the choice is recorded in the
 *     journal so a resume restores it.
 *   - Switching rules. A switch mid-sentence is parked until
 *     the current reply finishes (or is cut); a switch while
 *     idle or listening applies at once. The registry reports
 *     the pending switch so the session can apply it at the
 *     right moment instead of cutting the user off.
 *   - Validation. Rate, pitch and volume are clamped to sane
 *     ranges; a profile with an empty id, an unknown locale, or
 *     a fallback cycle is refused with a reason.
 */
import {
  clampV22,
  round2V22,
  type VoiceV22EventSink,
} from './types';

/** Prosody knobs for one voice (multipliers / offsets). */
export interface VoiceV22Prosody {
  /** Speaking rate multiplier (0.5 slow .. 2.0 fast). */
  rate: number;
  /** Pitch offset in semitones (-6 .. +6). */
  pitch: number;
  /** Volume multiplier (0.0 .. 1.5). */
  volume: number;
}

export interface VoiceV22Profile {
  id: string;
  name: string;
  /** BCP-47 locale, e.g. 'vi-VN', 'en-US'. */
  locale: string;
  /** Engine that renders this voice ('mock' in v22). */
  engine: string;
  prosody: VoiceV22Prosody;
  /** Profile to fall back to when this one cannot render. */
  fallbackId?: string;
  /** Free-form description for the panel. */
  description?: string;
  /** Built-in profiles cannot be deleted. */
  builtin?: boolean;
}

export interface VoiceV22ProfileOptions {
  /** Max custom profiles (built-ins excluded, default 32). */
  maxProfiles: number;
}

export function defaultVoiceProfilesV22Options(): VoiceV22ProfileOptions {
  return { maxProfiles: 32 };
}

export function validateVoiceProfilesV22Options(o: Partial<VoiceV22ProfileOptions>): string[] {
  const e: string[] = [];
  if (o.maxProfiles !== undefined && (!Number.isInteger(o.maxProfiles) || o.maxProfiles < 1)) {
    e.push('maxProfiles must be a positive integer');
  }
  return e;
}

/** Sane ranges for prosody knobs. */
export const VOICE_V22_PROSODY_LIMITS = {
  rate: { min: 0.5, max: 2.0 },
  pitch: { min: -6, max: 6 },
  volume: { min: 0, max: 1.5 },
} as const;

/** Clamp a prosody object into the sane ranges. */
export function clampProsodyV22(p: Partial<VoiceV22Prosody>): VoiceV22Prosody {
  return {
    rate: clampV22(p.rate ?? 1, VOICE_V22_PROSODY_LIMITS.rate.min, VOICE_V22_PROSODY_LIMITS.rate.max),
    pitch: clampV22(p.pitch ?? 0, VOICE_V22_PROSODY_LIMITS.pitch.min, VOICE_V22_PROSODY_LIMITS.pitch.max),
    volume: clampV22(p.volume ?? 1, VOICE_V22_PROSODY_LIMITS.volume.min, VOICE_V22_PROSODY_LIMITS.volume.max),
  };
}

/** Validate a profile shape; returns error strings (empty = valid). */
export function validateProfileV22(profile: Partial<VoiceV22Profile>): string[] {
  const e: string[] = [];
  if (typeof profile.id !== 'string' || profile.id.trim() === '') e.push('profile id must be a non-empty string');
  else if (!/^[a-z0-9][a-z0-9_-]*$/i.test(profile.id)) e.push('profile id must be alphanumeric with - or _');
  if (typeof profile.name !== 'string' || profile.name.trim() === '') e.push('profile name must be a non-empty string');
  if (typeof profile.locale !== 'string' || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(profile.locale)) {
    e.push('profile locale must look like "vi", "vi-VN" or "en-US"');
  }
  if (typeof profile.engine !== 'string' || profile.engine.trim() === '') e.push('profile engine must be a non-empty string');
  if (profile.prosody !== undefined) {
    const p = profile.prosody;
    if (typeof p.rate !== 'number' || p.rate < VOICE_V22_PROSODY_LIMITS.rate.min || p.rate > VOICE_V22_PROSODY_LIMITS.rate.max) {
      e.push(`prosody rate must be ${VOICE_V22_PROSODY_LIMITS.rate.min}..${VOICE_V22_PROSODY_LIMITS.rate.max}`);
    }
    if (typeof p.pitch !== 'number' || p.pitch < VOICE_V22_PROSODY_LIMITS.pitch.min || p.pitch > VOICE_V22_PROSODY_LIMITS.pitch.max) {
      e.push(`prosody pitch must be ${VOICE_V22_PROSODY_LIMITS.pitch.min}..${VOICE_V22_PROSODY_LIMITS.pitch.max}`);
    }
    if (typeof p.volume !== 'number' || p.volume < VOICE_V22_PROSODY_LIMITS.volume.min || p.volume > VOICE_V22_PROSODY_LIMITS.volume.max) {
      e.push(`prosody volume must be ${VOICE_V22_PROSODY_LIMITS.volume.min}..${VOICE_V22_PROSODY_LIMITS.volume.max}`);
    }
  }
  if (profile.fallbackId !== undefined && profile.fallbackId === profile.id) e.push('profile cannot fall back to itself');
  return e;
}

/** The four built-in profiles shipped with v22. */
export function builtinProfilesV22(): VoiceV22Profile[] {
  return [
    {
      id: 'voice-v22-default', name: 'Default', locale: 'en-US', engine: 'mock',
      prosody: { rate: 1, pitch: 0, volume: 1 },
      description: 'Neutral default voice.',
      builtin: true,
    },
    {
      id: 'voice-v22-vi-calm', name: 'An Nhiên', locale: 'vi-VN', engine: 'mock',
      prosody: { rate: 0.9, pitch: -1, volume: 1 },
      fallbackId: 'voice-v22-default',
      description: 'Calm Vietnamese voice, slightly slower.',
      builtin: true,
    },
    {
      id: 'voice-v22-en-brisk', name: 'Brisk', locale: 'en-US', engine: 'mock',
      prosody: { rate: 1.15, pitch: 1, volume: 1 },
      fallbackId: 'voice-v22-default',
      description: 'Brisk English voice for quick answers.',
      builtin: true,
    },
    {
      id: 'voice-v22-storyteller', name: 'Storyteller', locale: 'en-US', engine: 'mock',
      prosody: { rate: 0.85, pitch: -2, volume: 1.1 },
      fallbackId: 'voice-v22-en-brisk',
      description: 'Warm, slow voice for long reads.',
      builtin: true,
    },
  ];
}

export type VoiceV22SwitchTiming = 'now' | 'after-reply';

export interface VoiceV22PendingSwitch {
  profileId: string;
  requestedAtMs: number;
  timing: VoiceV22SwitchTiming;
  reason?: string;
}

export interface VoiceV22ProfileStats {
  profiles: number;
  builtins: number;
  customs: number;
  switches: number;
  pendingSwitches: number;
  fallbacksUsed: number;
  perUserDefaults: number;
}

export class VoiceProfileRegistryV22 {
  private readonly opts: VoiceV22ProfileOptions;
  private readonly sink?: VoiceV22EventSink;
  private readonly sessionId: string;
  private readonly profiles = new Map<string, VoiceV22Profile>();
  private readonly perUserDefault = new Map<string, string>();
  private currentId: string;
  private pending: VoiceV22PendingSwitch | null = null;
  private switches = 0;
  private fallbacksUsed = 0;

  constructor(sessionId: string, opts: Partial<VoiceV22ProfileOptions> = {}, sink?: VoiceV22EventSink) {
    this.sessionId = sessionId;
    this.opts = { ...defaultVoiceProfilesV22Options(), ...opts };
    this.sink = sink;
    for (const p of builtinProfilesV22()) this.profiles.set(p.id, { ...p, prosody: { ...p.prosody } });
    this.currentId = 'voice-v22-default';
  }

  /** Current profile id. */
  current(): string {
    return this.currentId;
  }

  currentProfile(): VoiceV22Profile {
    return { ...this.profiles.get(this.currentId)!, prosody: { ...this.profiles.get(this.currentId)!.prosody } };
  }

  get(id: string): VoiceV22Profile | null {
    const p = this.profiles.get(id);
    return p === undefined ? null : { ...p, prosody: { ...p.prosody } };
  }

  list(): VoiceV22Profile[] {
    return [...this.profiles.values()].map((p) => ({ ...p, prosody: { ...p.prosody } }));
  }

  listByLocale(locale: string): VoiceV22Profile[] {
    return this.list().filter((p) => p.locale === locale);
  }

  /** Add a custom profile. Returns error strings (empty = added). */
  add(profile: VoiceV22Profile): string[] {
    const errors = validateProfileV22(profile);
    if (errors.length > 0) return errors;
    if (this.profiles.has(profile.id)) return [`profile "${profile.id}" already exists`];
    const customs = [...this.profiles.values()].filter((p) => !p.builtin).length;
    if (customs >= this.opts.maxProfiles) return [`custom profile limit reached (${this.opts.maxProfiles})`];
    if (profile.fallbackId !== undefined && !this.profiles.has(profile.fallbackId)) {
      return [`fallback profile "${profile.fallbackId}" does not exist`];
    }
    this.profiles.set(profile.id, { ...profile, prosody: clampProsodyV22(profile.prosody ?? {}) });
    return [];
  }

  /** Update prosody / description of an existing profile. */
  update(id: string, patch: Partial<Omit<VoiceV22Profile, 'id' | 'builtin'>>): string[] {
    const existing = this.profiles.get(id);
    if (existing === undefined) return [`profile "${id}" does not exist`];
    const next: VoiceV22Profile = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
      ...(patch.engine !== undefined ? { engine: patch.engine } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.fallbackId !== undefined ? { fallbackId: patch.fallbackId } : {}),
      ...(patch.prosody !== undefined ? { prosody: clampProsodyV22({ ...existing.prosody, ...patch.prosody }) } : {}),
    };
    const errors = validateProfileV22(next);
    if (errors.length > 0) return errors;
    if (this.wouldCycle(next)) return [`fallback chain for "${id}" would cycle`];
    this.profiles.set(id, next);
    return [];
  }

  /** Remove a custom profile (built-ins are protected). */
  remove(id: string): string[] {
    const existing = this.profiles.get(id);
    if (existing === undefined) return [`profile "${id}" does not exist`];
    if (existing.builtin === true) return [`builtin profile "${id}" cannot be removed`];
    if (this.currentId === id) return [`profile "${id}" is current; switch away first`];
    const dependents = [...this.profiles.values()].filter((p) => p.fallbackId === id);
    if (dependents.length > 0) return [`profile "${id}" is a fallback for ${dependents.map((p) => p.id).join(', ')}`];
    this.profiles.delete(id);
    return [];
  }

  /** True when following the fallback chain from `profile` loops. */
  wouldCycle(profile: VoiceV22Profile): boolean {
    const seen = new Set<string>([profile.id]);
    let next = profile.fallbackId;
    while (next !== undefined) {
      if (seen.has(next)) return true;
      seen.add(next);
      next = this.profiles.get(next)?.fallbackId;
    }
    return false;
  }

  /**
   * Resolve a profile id to a renderable profile by walking the
   * fallback chain. Returns the profile plus the chain walked;
   * when the id is unknown the default is used and the chain
   * records the miss. A cycle stops the walk at the first repeat.
   */
  resolve(id: string): { profile: VoiceV22Profile; chain: string[]; fellBack: boolean } {
    const chain: string[] = [];
    let current = this.profiles.get(id);
    if (current === undefined) {
      const fallback = this.profiles.get('voice-v22-default')!;
      this.fallbacksUsed += 1;
      return { profile: { ...fallback, prosody: { ...fallback.prosody } }, chain: [id, 'voice-v22-default'], fellBack: true };
    }
    const seen = new Set<string>();
    while (current !== undefined) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      chain.push(current.id);
      if (current.engine === 'mock') {
        return { profile: { ...current, prosody: { ...current.prosody } }, chain, fellBack: chain.length > 1 };
      }
      // Non-mock engines are not renderable offline: fall back.
      this.fallbacksUsed += 1;
      current = current.fallbackId === undefined ? undefined : this.profiles.get(current.fallbackId);
    }
    const fallback = this.profiles.get('voice-v22-default')!;
    return { profile: { ...fallback, prosody: { ...fallback.prosody } }, chain: [...chain, 'voice-v22-default'], fellBack: true };
  }

  /**
   * Request a profile switch. `timing` is 'now' when the agent
   * is not speaking (applies at once) and 'after-reply' when it
   * is (parked until the reply ends). Returns error strings
   * (empty = switched or parked).
   */
  switchTo(profileId: string, atMs: number, agentSpeaking: boolean, reason?: string): string[] {
    if (!this.profiles.has(profileId)) return [`profile "${profileId}" does not exist`];
    if (profileId === this.currentId && this.pending === null) return [];
    if (agentSpeaking) {
      this.pending = { profileId, requestedAtMs: atMs, timing: 'after-reply', ...(reason !== undefined ? { reason } : {}) };
      return [];
    }
    return this.applySwitch(profileId, atMs, reason);
  }

  /** Apply a parked switch (called when the reply ends). */
  applyPending(atMs: number): VoiceV22Profile | null {
    if (this.pending === null) return null;
    const target = this.pending.profileId;
    this.pending = null;
    const errors = this.applySwitch(target, atMs);
    return errors.length === 0 ? this.currentProfile() : null;
  }

  pendingSwitch(): VoiceV22PendingSwitch | null {
    return this.pending === null ? null : { ...this.pending };
  }

  cancelPending(): boolean {
    if (this.pending === null) return false;
    this.pending = null;
    return true;
  }

  private applySwitch(profileId: string, atMs: number, reason?: string): string[] {
    if (!this.profiles.has(profileId)) return [`profile "${profileId}" does not exist`];
    const from = this.currentId;
    this.currentId = profileId;
    this.switches += 1;
    this.sink?.({
      kind: 'profile-switch',
      atMs,
      sessionId: this.sessionId,
      detail: { from, to: profileId, ...(reason !== undefined ? { reason } : {}) },
    });
    return [];
  }

  /** Set / clear a per-user default profile. */
  setUserDefault(userId: string, profileId: string): string[] {
    if (userId.trim() === '') return ['userId must be a non-empty string'];
    if (!this.profiles.has(profileId)) return [`profile "${profileId}" does not exist`];
    this.perUserDefault.set(userId, profileId);
    return [];
  }

  clearUserDefault(userId: string): boolean {
    return this.perUserDefault.delete(userId);
  }

  userDefault(userId: string): string | null {
    return this.perUserDefault.get(userId) ?? null;
  }

  /** Profile for a user: their default, else the current one. */
  profileForUser(userId: string): VoiceV22Profile {
    const id = this.perUserDefault.get(userId) ?? this.currentId;
    return this.resolve(id).profile;
  }

  /** Restore the current profile after a resume. */
  restoreCurrent(profileId: string, atMs: number): string[] {
    if (!this.profiles.has(profileId)) {
      this.currentId = 'voice-v22-default';
      return [`restored profile "${profileId}" missing; fell back to default`];
    }
    this.currentId = profileId;
    this.pending = null;
    this.switches += 1;
    this.sink?.({ kind: 'profile-switch', atMs, sessionId: this.sessionId, detail: { from: 'restored', to: profileId } });
    return [];
  }

  stats(): VoiceV22ProfileStats {
    const all = [...this.profiles.values()];
    return {
      profiles: all.length,
      builtins: all.filter((p) => p.builtin === true).length,
      customs: all.filter((p) => p.builtin !== true).length,
      switches: this.switches,
      pendingSwitches: this.pending === null ? 0 : 1,
      fallbacksUsed: this.fallbacksUsed,
      perUserDefaults: this.perUserDefault.size,
    };
  }

  summary(): string {
    const s = this.stats();
    return `profiles v22: ${s.profiles} profiles (${s.builtins} built-in, ${s.customs} custom), ` +
      `current=${this.currentId}, switches=${s.switches}, fallbacks=${s.fallbacksUsed}`;
  }
}

export function createVoiceProfileRegistryV22(
  sessionId: string,
  opts: Partial<VoiceV22ProfileOptions> = {},
  sink?: VoiceV22EventSink,
): VoiceProfileRegistryV22 {
  return new VoiceProfileRegistryV22(sessionId, opts, sink);
}

/** Effective speaking rate for a profile (chars per second, mock TTS). */
export function profileCharsPerSecondV22(profile: VoiceV22Profile): number {
  return round2V22(14 * profile.prosody.rate);
}
