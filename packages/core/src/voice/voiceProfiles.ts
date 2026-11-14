/**
 * Voice profiles (v1.04, Team T5 — voice realtime v3).
 *
 * v1.03 gave the call a voice (system TTS engine, rate, voice id per
 * utterance) but no memory of *whose* voice that was: every call
 * started from the engine default, and a user who speaks Vietnamese
 * slowly had to re-pick the same settings each time. A profile binds
 * one user's voice preferences together — language, engine voice,
 * speaking rate, volume — so the loop, the TTS queue and the UI all
 * read from the same place.
 *
 *   - `VoiceProfile`: one named set of preferences for one user.
 *     `voice` is an engine voice id (e.g. `vi-vn-x-south` on eSpeak,
 *     a macOS voice name on `say`); it is stored, never probed here
 *     — the engine reports honestly when a voice does not exist.
 *   - `DEFAULT_VOICE_PROFILES`: six built-ins (Vietnamese north /
 *     south, English US / GB, slow-clear, fast). Built-ins are
 *     read-only templates: `createProfile` copies one, it never
 *     mutates the built-in.
 *   - `MemoryVoiceProfileStore`: per-user CRUD + one active profile
 *     per user, in memory. `FileVoiceProfileStore` persists the same
 *     records as one JSON file (atomic write via temp + rename; a
 *     corrupt file loads as empty and is reported, never thrown).
 *   - `resolveProfileTtsOptions(profile)`: the `TtsSpeakOptions`
 *     the TTS queue speaks with — voice wins over lang, exactly
 *     like `SystemTtsEngine` does, so a profile and a direct
 *     `speak()` call never disagree about precedence.
 *
 * Validation is fail-closed: a bad lang / rate / volume is rejected
 * by `validateVoiceProfile` instead of silently clamped, so a UI
 * typo cannot turn into a voice the user did not ask for. All
 * storage is local-first — no account, no cloud, no payment.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { TtsSpeakOptions } from './tts';

/** Speaking rate multiplier (1 = normal). Clamped to this range. */
export const VOICE_PROFILE_MIN_RATE = 0.5;
export const VOICE_PROFILE_MAX_RATE = 2.0;
/** Volume 0..1 (a hint for engines that support it; eSpeak ignores it). */
export const VOICE_PROFILE_MIN_VOLUME = 0;
export const VOICE_PROFILE_MAX_VOLUME = 1;
/** Pitch shift in semitones, -12..12 (a hint; most CLI engines ignore it). */
export const VOICE_PROFILE_MIN_PITCH = -12;
export const VOICE_PROFILE_MAX_PITCH = 12;
/** A profile id is a lowercase slug: letters, digits, dashes. */
export const VOICE_PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A language tag: `vi`, `en`, `en-US`, `zh-CN`. */
export const VOICE_PROFILE_LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
/** Max profiles one user may keep (custom + active built-in copies). */
export const VOICE_PROFILE_MAX_PER_USER = 20;

/** One user's voice preferences: language, engine voice, rate, volume. */
export interface VoiceProfile {
  /** Slug id, unique per user (e.g. `vi-nam`, `my-english`). */
  id: string;
  /** Owner (a local user id; `'local-user'` when unset). */
  userId: string;
  /** Display name shown in the picker. */
  name: string;
  /** STT + TTS language, e.g. `vi`, `en`. */
  lang: string;
  /** Engine voice id (e.g. `vi-vn-x-south`); null = engine default. */
  voice: string | null;
  /** Speaking rate multiplier (1 = normal). */
  rate: number;
  /** Pitch shift in semitones (hint; most CLI engines ignore it). */
  pitch: number;
  /** Volume 0..1 (hint; CLI engines mostly ignore it). */
  volume: number;
  /** When created (wall clock ms). */
  createdAt: number;
  /** When last edited (wall clock ms). */
  updatedAt: number;
}

export type VoiceProfileValidationResult =
  | { ok: true; profile: VoiceProfile }
  | { ok: false; error: string };

/** A profile with every field filled in (no nulls except voice). */
function normalizeProfile(input: Partial<VoiceProfile> & { id: string; userId: string }): VoiceProfile {
  const now = Date.now();
  return {
    id: input.id,
    userId: input.userId,
    name: input.name ?? input.id,
    lang: input.lang ?? 'en',
    voice: input.voice ?? null,
    rate: input.rate ?? 1,
    pitch: input.pitch ?? 0,
    volume: input.volume ?? 1,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

/**
 * Validate a profile (new or edited). Rejects — never silently
 * clamps — a bad id, lang, voice id, rate, pitch or volume, an empty
 * name, or a name over 80 chars.
 */
export function validateVoiceProfile(
  input: Partial<VoiceProfile> & { id: string; userId: string },
): VoiceProfileValidationResult {
  if (!VOICE_PROFILE_ID_RE.test(input.id)) {
    return { ok: false, error: `voice profile id "${input.id}" must be a lowercase slug (letters, digits, dashes).` };
  }
  if (!input.userId || typeof input.userId !== 'string') {
    return { ok: false, error: 'voice profile needs a userId.' };
  }
  const name = (input.name ?? input.id).trim();
  if (!name) return { ok: false, error: 'voice profile name must not be empty.' };
  if (name.length > 80) return { ok: false, error: 'voice profile name is over 80 chars.' };
  const lang = input.lang ?? 'en';
  if (!VOICE_PROFILE_LANG_RE.test(lang)) {
    return { ok: false, error: `voice profile lang "${lang}" must look like "vi" or "en-US".` };
  }
  if (input.voice !== undefined && input.voice !== null) {
    if (typeof input.voice !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(input.voice)) {
      return { ok: false, error: `voice profile voice "${input.voice}" must be a plain voice id.` };
    }
  }
  const rate = input.rate ?? 1;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < VOICE_PROFILE_MIN_RATE || rate > VOICE_PROFILE_MAX_RATE) {
    return { ok: false, error: `voice profile rate ${rate} must be ${VOICE_PROFILE_MIN_RATE}..${VOICE_PROFILE_MAX_RATE}.` };
  }
  const pitch = input.pitch ?? 0;
  if (typeof pitch !== 'number' || !Number.isFinite(pitch) || pitch < VOICE_PROFILE_MIN_PITCH || pitch > VOICE_PROFILE_MAX_PITCH) {
    return { ok: false, error: `voice profile pitch ${pitch} must be ${VOICE_PROFILE_MIN_PITCH}..${VOICE_PROFILE_MAX_PITCH} semitones.` };
  }
  const volume = input.volume ?? 1;
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < VOICE_PROFILE_MIN_VOLUME || volume > VOICE_PROFILE_MAX_VOLUME) {
    return { ok: false, error: `voice profile volume ${volume} must be 0..1.` };
  }
  return { ok: true, profile: normalizeProfile({ ...input, name, lang, rate, pitch, volume }) };
}

/** Built-in profiles (read-only templates — never mutated). */
export const DEFAULT_VOICE_PROFILES: readonly VoiceProfile[] = [
  {
    id: 'vi-nam', userId: 'builtin', name: 'Tiếng Việt — miền Nam',
    lang: 'vi', voice: 'vi-vn-x-south', rate: 1, pitch: 0, volume: 1,
    createdAt: 0, updatedAt: 0,
  },
  {
    id: 'vi-bac', userId: 'builtin', name: 'Tiếng Việt — miền Bắc',
    lang: 'vi', voice: 'vi', rate: 1, pitch: 0, volume: 1,
    createdAt: 0, updatedAt: 0,
  },
  {
    id: 'en-us', userId: 'builtin', name: 'English — US',
    lang: 'en', voice: 'en', rate: 1, pitch: 0, volume: 1,
    createdAt: 0, updatedAt: 0,
  },
  {
    id: 'en-gb', userId: 'builtin', name: 'English — UK',
    lang: 'en', voice: 'en-gb', rate: 1, pitch: 0, volume: 1,
    createdAt: 0, updatedAt: 0,
  },
  {
    id: 'slow-clear', userId: 'builtin', name: 'Chậm, rõ (slow & clear)',
    lang: 'vi', voice: null, rate: 0.8, pitch: 0, volume: 1,
    createdAt: 0, updatedAt: 0,
  },
  {
    id: 'fast', userId: 'builtin', name: 'Nhanh (fast)',
    lang: 'en', voice: null, rate: 1.25, pitch: 0, volume: 1,
    createdAt: 0, updatedAt: 0,
  },
];

/** A built-in template by id, or undefined. Never returns the live object. */
export function getBuiltinProfile(id: string): VoiceProfile | undefined {
  const found = DEFAULT_VOICE_PROFILES.find((p) => p.id === id);
  return found ? { ...found } : undefined;
}

/**
 * The TTS options a profile speaks with. Voice wins over lang,
 * exactly like `SystemTtsEngine` — one precedence rule everywhere.
 * Pitch/volume are engine hints and are NOT passed to `TtsSpeakOptions`
 * (no CLI engine in the harness honours them); they are kept on the
 * profile so a future engine can use them without a migration.
 */
export function resolveProfileTtsOptions(profile: VoiceProfile): TtsSpeakOptions {
  const opts: TtsSpeakOptions = { lang: profile.lang, rate: profile.rate };
  if (profile.voice) opts.voice = profile.voice;
  return opts;
}

/** STT language hint for a profile (its lang, lower-cased). */
export function resolveProfileSttLanguage(profile: VoiceProfile): string {
  return profile.lang.toLowerCase();
}

/**
 * Pick the best profile for a language from a list: exact lang
 * (`vi` → `vi`), then the base language (`en-US` → `en`), then the
 * first profile in the list, then undefined when the list is empty.
 */
export function pickProfileForLang(
  profiles: readonly VoiceProfile[],
  lang: string,
): VoiceProfile | undefined {
  const wanted = lang.toLowerCase();
  const base = wanted.split('-')[0];
  return (
    profiles.find((p) => p.lang.toLowerCase() === wanted) ??
    profiles.find((p) => p.lang.toLowerCase().split('-')[0] === base) ??
    profiles[0]
  );
}

export interface VoiceProfileStoreStats {
  users: number;
  profiles: number;
  activeProfiles: number;
}

/**
 * Per-user profile CRUD + one active profile per user, in memory.
 * `userId` scopes everything: two users may both own a profile
 * called `my-voice` without colliding. Built-ins are not stored
 * here — `getActive` falls back to `pickProfileForLang` over the
 * built-ins when the user has no active profile yet.
 */
export class MemoryVoiceProfileStore {
  private readonly profiles = new Map<string, Map<string, VoiceProfile>>();
  private readonly active = new Map<string, string>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Create a profile (validates first; duplicate id rejected). */
  create(input: Partial<VoiceProfile> & { id: string; userId: string }): VoiceProfileValidationResult {
    const validated = validateVoiceProfile(input);
    if (!validated.ok) return validated;
    const perUser = this.profiles.get(validated.profile.userId) ?? new Map();
    if (perUser.has(validated.profile.id)) {
      return { ok: false, error: `voice profile "${validated.profile.id}" already exists for user "${validated.profile.userId}".` };
    }
    if (perUser.size >= VOICE_PROFILE_MAX_PER_USER) {
      return { ok: false, error: `user "${validated.profile.userId}" already has ${VOICE_PROFILE_MAX_PER_USER} voice profiles.` };
    }
    const now = this.clock();
    const profile: VoiceProfile = { ...validated.profile, createdAt: now, updatedAt: now };
    perUser.set(profile.id, profile);
    this.profiles.set(profile.userId, perUser);
    return { ok: true, profile: { ...profile } };
  }

  /** Replace a profile wholesale (validates; id + userId must match). */
  update(profile: VoiceProfile): VoiceProfileValidationResult {
    const validated = validateVoiceProfile(profile);
    if (!validated.ok) return validated;
    const perUser = this.profiles.get(profile.userId);
    if (!perUser?.has(profile.id)) {
      return { ok: false, error: `voice profile "${profile.id}" does not exist for user "${profile.userId}".` };
    }
    const updated: VoiceProfile = {
      ...validated.profile,
      createdAt: perUser.get(profile.id)?.createdAt ?? this.clock(),
      updatedAt: this.clock(),
    };
    perUser.set(profile.id, updated);
    return { ok: true, profile: { ...updated } };
  }

  /** Delete a profile; clears the active pointer when it pointed here. */
  delete(userId: string, id: string): boolean {
    const perUser = this.profiles.get(userId);
    if (!perUser?.delete(id)) return false;
    if (this.active.get(userId) === id) this.active.delete(userId);
    return true;
  }

  /** One profile, or undefined. Returns a copy. */
  get(userId: string, id: string): VoiceProfile | undefined {
    const found = this.profiles.get(userId)?.get(id);
    return found ? { ...found } : undefined;
  }

  /** All of a user's profiles (copies, in creation order). */
  list(userId: string): VoiceProfile[] {
    return [...(this.profiles.get(userId)?.values() ?? [])].map((p) => ({ ...p }));
  }

  /** Mark a profile active for its user (must exist). */
  setActive(userId: string, id: string): boolean {
    if (!this.profiles.get(userId)?.has(id)) return false;
    this.active.set(userId, id);
    return true;
  }

  /** The active profile, or the best built-in for `langHint`. */
  getActive(userId: string, langHint = 'vi'): VoiceProfile {
    const activeId = this.active.get(userId);
    const owned = activeId ? this.get(userId, activeId) : undefined;
    if (owned) return owned;
    const builtin = pickProfileForLang(DEFAULT_VOICE_PROFILES, langHint);
    return { ...(builtin ?? DEFAULT_VOICE_PROFILES[0]), userId };
  }

  /** All profiles, flattened (copies) — for persistence. */
  all(): VoiceProfile[] {
    const out: VoiceProfile[] = [];
    for (const perUser of this.profiles.values()) {
      for (const p of perUser.values()) out.push({ ...p });
    }
    return out;
  }

  /** Active profile id per user — for persistence. */
  activeMap(): Record<string, string> {
    return Object.fromEntries(this.active);
  }

  /** Load records previously produced by `all()` + `activeMap()`. */
  load(profiles: readonly VoiceProfile[], active: Record<string, string>): { loaded: number; skipped: number } {
    let loaded = 0;
    let skipped = 0;
    for (const raw of profiles) {
      const validated = validateVoiceProfile(raw);
      if (!validated.ok) {
        skipped += 1;
        continue;
      }
      const perUser = this.profiles.get(validated.profile.userId) ?? new Map();
      perUser.set(validated.profile.id, validated.profile);
      this.profiles.set(validated.profile.userId, perUser);
      loaded += 1;
    }
    for (const [userId, id] of Object.entries(active)) {
      if (this.profiles.get(userId)?.has(id)) this.active.set(userId, id);
      else skipped += 1;
    }
    return { loaded, skipped };
  }

  getStats(): VoiceProfileStoreStats {
    let profiles = 0;
    for (const perUser of this.profiles.values()) profiles += perUser.size;
    return { users: this.profiles.size, profiles, activeProfiles: this.active.size };
  }
}

export interface FileVoiceProfileStoreOptions {
  /** JSON file holding `{ profiles, active }`. */
  filePath: string;
  /** Clock for timestamps. Default Date.now. */
  clock?: () => number;
}

/**
 * The same store, persisted as one JSON file. `load()` reads the
 * file (missing file = empty store; corrupt file = empty store +
 * `corrupt: true`, the bad file is moved aside to `<path>.corrupt`
 * so no profile is silently lost). `save()` writes atomically
 * (temp file + rename) so a crash cannot half-write the profiles.
 */
export class FileVoiceProfileStore extends MemoryVoiceProfileStore {
  private readonly filePath: string;

  constructor(options: FileVoiceProfileStoreOptions) {
    super(options.clock);
    this.filePath = options.filePath;
  }

  loadFromFile(): { loaded: number; skipped: number; corrupt: boolean } {
    if (!existsSync(this.filePath)) return { loaded: 0, skipped: 0, corrupt: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt`);
      } catch {
        // Best effort — the store still starts empty.
      }
      return { loaded: 0, skipped: 0, corrupt: true };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { loaded: 0, skipped: 0, corrupt: true };
    }
    const record = parsed as { profiles?: unknown; active?: unknown };
    const profiles = Array.isArray(record.profiles) ? (record.profiles as VoiceProfile[]) : [];
    const active =
      record.active && typeof record.active === 'object' && !Array.isArray(record.active)
        ? (record.active as Record<string, string>)
        : {};
    const result = this.load(profiles, active);
    return { ...result, corrupt: false };
  }

  saveToFile(): void {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(
      { version: 1, profiles: this.all(), active: this.activeMap() },
      null,
      2,
    );
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, this.filePath);
  }

  /** Remove the persisted file (test cleanup / reset). */
  deleteFile(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // Best effort.
    }
  }
}

/** Default on-disk location for a user's voice profiles. */
export function defaultVoiceProfilesPath(homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return path.join(home, '.open-bot', 'voice-profiles.json');
}
