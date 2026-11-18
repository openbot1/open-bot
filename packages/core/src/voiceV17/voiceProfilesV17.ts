/**
 * Multi-voice profiles v2 (v1.18, Đội T5 — voice v17).
 *
 * v15 had one voice per bot: a `VoiceProfileV15` (provider, voice
 * id, rate, pitch, language, quality, max chunk chars) kept in a
 * per-bot store. That is right when a bot *is* a voice — but a
 * user talks to many bots, wants different voices for different
 * moments (a calm voice for chat, a brisk one for announcements,
 * a low one for alerts), and wants *their* voice to follow them
 * from bot to bot instead of being re-picked every time.
 *
 * v17 keeps the v15 profile shape and adds the missing layers:
 *
 *   1. Identity + context. A v17 profile has a `displayName`, an
 *      owning `userId` (absent = a shared / bot profile), and a
 *      `context` — `chat` | `announcement` | `alert` |
 *      `narration` | `whisper` — plus free-form `tags`. The same
 *      bot can speak differently when it chats, announces, or
 *      alerts, without a new bot id.
 *   2. Resolution with a fallback chain. `resolve({ userId, botId,
 *      context, language })` tries, in order: the user's profile
 *      for this bot + context → the user's profile for this bot
 *      (any context) → the user's default profile → the bot's
 *      profile for this context → the bot's profile (any context)
 *      → the built-in default for the bot. The result says *which*
 *      step matched (`via`), so the panel can show "using your
 *      voice" instead of silently falling back.
 *   3. Per-user persistence. The whole store serialises to JSON
 *      (`toJSON`) and loads back (`fromJSON`) with validation —
 *      invalid entries are dropped and counted, never fatal — so a
 *      host can persist per-user voices to disk (the app vault /
 *      a JSON file) and reload them at startup.
 *   4. Built-in presets. Four ready voices (two Vietnamese, two
 *      English) so a fresh user hears something sensible before
 *      picking their own; `cloneForUser()` copies a shared preset
 *      into a user's own profile, which they can then tune.
 *   5. Language-aware matching. When the caller asks for a
 *      language, a profile in another language only matches as a
 *      last resort — a Vietnamese user who picked a Vietnamese
 *      voice must not get an English one just because it matches
 *      the bot first.
 *
 * Profiles are data, not audio: no synth, no sound card, no key.
 * The TTS streams (v16/v17) consume the resolved profile's rate,
 * pitch and max chunk chars exactly as before.
 */

import {
  defaultVoiceProfileV15,
  validateVoiceProfileV15,
  type TtsQualityV15,
  type VoiceProfileV15,
} from '../voiceV15/ttsStreamV15';

/** When a voice is used: chat, announcement, alert, narration, whisper. */
export type VoiceProfileV17Context = 'chat' | 'announcement' | 'alert' | 'narration' | 'whisper';

export const VOICE_V17_CONTEXTS: readonly VoiceProfileV17Context[] = [
  'chat',
  'announcement',
  'alert',
  'narration',
  'whisper',
];

export function isVoiceProfileV17Context(value: unknown): value is VoiceProfileV17Context {
  return typeof value === 'string' && (VOICE_V17_CONTEXTS as readonly string[]).includes(value);
}

/** A v15 profile + identity, owner and context. */
export interface VoiceProfileV17 extends VoiceProfileV15 {
  /** Human-readable name shown in the picker. */
  displayName: string;
  /** Owning user (absent = a shared / bot profile). */
  userId?: string;
  /** When this voice is used (absent = any context). */
  context?: VoiceProfileV17Context;
  /** Free-form tags for the picker (e.g. 'calm', 'brisk'). */
  tags?: string[];
}

export function defaultVoiceProfileV17(botId: string, overrides: Partial<VoiceProfileV17> = {}): VoiceProfileV17 {
  const base = defaultVoiceProfileV15(botId);
  return {
    ...base,
    id: overrides.id ?? `profile-v17-${botId}`,
    displayName: overrides.displayName ?? `Giọng mặc định (${botId})`,
    ...(overrides.userId !== undefined ? { userId: overrides.userId } : {}),
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
    ...(overrides.tags !== undefined ? { tags: [...overrides.tags] } : {}),
    ...(overrides.provider !== undefined ? { provider: overrides.provider } : {}),
    ...(overrides.voiceId !== undefined ? { voiceId: overrides.voiceId } : {}),
    ...(overrides.language !== undefined ? { language: overrides.language } : {}),
    ...(overrides.rate !== undefined ? { rate: overrides.rate } : {}),
    ...(overrides.pitch !== undefined ? { pitch: overrides.pitch } : {}),
    ...(overrides.quality !== undefined ? { quality: overrides.quality } : {}),
    ...(overrides.maxChunkChars !== undefined ? { maxChunkChars: overrides.maxChunkChars } : {}),
  };
}

export function validateVoiceProfileV17(profile: VoiceProfileV17): string[] {
  const errors = validateVoiceProfileV15(profile);
  if (!profile.displayName || profile.displayName.trim().length === 0) {
    errors.push('displayName must not be empty');
  }
  if (profile.displayName && profile.displayName.length > 80) {
    errors.push('displayName must be at most 80 chars');
  }
  if (profile.userId !== undefined && profile.userId.trim().length === 0) {
    errors.push('userId must not be empty when set');
  }
  if (profile.context !== undefined && !isVoiceProfileV17Context(profile.context)) {
    errors.push(`unknown context: ${profile.context}`);
  }
  if (profile.tags !== undefined) {
    if (profile.tags.some((t) => typeof t !== 'string' || t.trim().length === 0)) {
      errors.push('tags must be non-empty strings');
    }
    if (profile.tags.length > 20) errors.push('at most 20 tags');
  }
  return errors;
}

/** Four ready voices so a fresh user hears something sensible. */
export function presetVoiceProfilesV17(botId: string): VoiceProfileV17[] {
  return [
    {
      ...defaultVoiceProfileV17(botId, { id: `preset-vi-nu-nhe`, displayName: 'Tiếng Việt — nữ, nhẹ', language: 'vi', rate: 1, pitch: 2, voiceId: 'vi-nu-nhe', tags: ['vi', 'nữ', 'nhẹ', 'calm'] }),
    },
    {
      ...defaultVoiceProfileV17(botId, { id: `preset-vi-nam-tram`, displayName: 'Tiếng Việt — nam, trầm', language: 'vi', rate: 0.95, pitch: -3, voiceId: 'vi-nam-tram', tags: ['vi', 'nam', 'trầm', 'calm'] }),
    },
    {
      ...defaultVoiceProfileV17(botId, { id: `preset-en-clear`, displayName: 'English — clear', language: 'en', rate: 1, pitch: 0, voiceId: 'en-clear', tags: ['en', 'clear'] }),
    },
    {
      ...defaultVoiceProfileV17(botId, { id: `preset-en-brisk`, displayName: 'English — brisk', language: 'en', rate: 1.15, pitch: 1, voiceId: 'en-brisk', tags: ['en', 'brisk'] }),
    },
  ];
}

export type VoiceProfileV17ResolveVia =
  | 'user-bot-context'
  | 'user-bot'
  | 'user-default'
  | 'user-context'
  | 'bot-context'
  | 'bot'
  | 'preset'
  | 'default';

export interface VoiceProfileV17ResolveInput {
  userId?: string;
  botId: string;
  context?: VoiceProfileV17Context;
  language?: string;
}

export interface VoiceProfileV17ResolveResult {
  profile: VoiceProfileV17;
  via: VoiceProfileV17ResolveVia;
}

export interface VoiceProfileV17Stats {
  profiles: number;
  users: number;
  bots: number;
  contexts: Partial<Record<VoiceProfileV17Context, number>>;
  userDefaults: number;
  presets: number;
}

/**
 * Store for v17 profiles: CRUD by id, per-user defaults, the
 * resolution fallback chain, and JSON persistence (per-user voices
 * survive a restart through the host's vault / file).
 */
export class VoiceProfileStoreV17 {
  private readonly profiles = new Map<string, VoiceProfileV17>();
  private readonly userDefaults = new Map<string, string>();
  private droppedOnLoad = 0;

  constructor(seedPresetsForBot?: string) {
    if (seedPresetsForBot) {
      for (const preset of presetVoiceProfilesV17(seedPresetsForBot)) {
        this.profiles.set(preset.id, { ...preset });
      }
    }
  }

  /** Store (or replace) a profile; throws when invalid. */
  set(profile: VoiceProfileV17): void {
    const errors = validateVoiceProfileV17(profile);
    if (errors.length > 0) throw new Error(`invalid voice profile v17: ${errors.join('; ')}`);
    this.profiles.set(profile.id, {
      ...profile,
      ...(profile.tags !== undefined ? { tags: [...profile.tags] } : {}),
    });
  }

  get(id: string): VoiceProfileV17 | undefined {
    const found = this.profiles.get(id);
    return found ? { ...found, ...(found.tags !== undefined ? { tags: [...found.tags] } : {}) } : undefined;
  }

  remove(id: string): boolean {
    for (const [userId, defaultId] of this.userDefaults) {
      if (defaultId === id) this.userDefaults.delete(userId);
    }
    return this.profiles.delete(id);
  }

  list(): VoiceProfileV17[] {
    return [...this.profiles.values()]
      .map((p) => ({ ...p, ...(p.tags !== undefined ? { tags: [...p.tags] } : {}) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  listForUser(userId: string): VoiceProfileV17[] {
    return this.list().filter((p) => p.userId === userId);
  }

  listForBot(botId: string): VoiceProfileV17[] {
    return this.list().filter((p) => p.botId === botId);
  }

  listForContext(context: VoiceProfileV17Context): VoiceProfileV17[] {
    return this.list().filter((p) => p.context === context);
  }

  count(): number {
    return this.profiles.size;
  }

  /** A user's default voice (used when no bot/context profile matches). */
  setUserDefault(userId: string, profileId: string): void {
    if (!this.profiles.has(profileId)) throw new Error(`unknown voice profile v17 "${profileId}"`);
    this.userDefaults.set(userId, profileId);
  }

  getUserDefault(userId: string): VoiceProfileV17 | undefined {
    const id = this.userDefaults.get(userId);
    return id ? this.get(id) : undefined;
  }

  clearUserDefault(userId: string): boolean {
    return this.userDefaults.delete(userId);
  }

  /** Copy a shared profile into a user's own profile (then tunable). */
  cloneForUser(profileId: string, userId: string, newId?: string): VoiceProfileV17 {
    const source = this.profiles.get(profileId);
    if (!source) throw new Error(`unknown voice profile v17 "${profileId}"`);
    const clone: VoiceProfileV17 = {
      ...source,
      id: newId ?? `${source.id}-user-${userId}`,
      userId,
      displayName: `${source.displayName} (của ${userId})`,
    };
    this.set(clone);
    return { ...clone };
  }

  /**
   * Resolve the voice for a turn. Fallback chain, in order:
   * user+bot+context → user+bot → user default → user+context →
   * bot+context → bot → preset (same language) → built-in default.
   * A language, when asked for, is honoured at every step except
   * the final built-in default.
   */
  resolve(input: VoiceProfileV17ResolveInput): VoiceProfileV17ResolveResult {
    const { userId, botId, context, language } = input;
    const all = this.list();
    const langOk = (p: VoiceProfileV17): boolean => language === undefined || p.language === language;

    if (userId !== undefined) {
      if (context !== undefined) {
        const hit = all.find((p) => p.userId === userId && p.botId === botId && p.context === context && langOk(p));
        if (hit) return { profile: hit, via: 'user-bot-context' };
      }
      const hit = all.find((p) => p.userId === userId && p.botId === botId && langOk(p));
      if (hit) return { profile: hit, via: 'user-bot' };
      const def = this.getUserDefault(userId);
      if (def && langOk(def)) return { profile: def, via: 'user-default' };
      if (context !== undefined) {
        const hitCtx = all.find((p) => p.userId === userId && p.context === context && langOk(p));
        if (hitCtx) return { profile: hitCtx, via: 'user-context' };
      }
    }
    if (context !== undefined) {
      const hit = all.find((p) => p.userId === undefined && p.botId === botId && p.context === context && langOk(p));
      if (hit) return { profile: hit, via: 'bot-context' };
    }
    const botHit = all.find((p) => p.userId === undefined && p.botId === botId && langOk(p));
    if (botHit) return { profile: botHit, via: 'bot' };
    if (language !== undefined) {
      const preset = all.find((p) => p.id.startsWith('preset-') && p.language === language);
      if (preset) return { profile: preset, via: 'preset' };
    }
    return { profile: defaultVoiceProfileV17(botId, language !== undefined ? { language } : {}), via: 'default' };
  }

  /** Serialise the store (profiles + user defaults) for persistence. */
  toJSON(): { version: 1; profiles: VoiceProfileV17[]; userDefaults: Record<string, string> } {
    return {
      version: 1,
      profiles: this.list(),
      userDefaults: Object.fromEntries(this.userDefaults),
    };
  }

  /**
   * Load a serialised store. Invalid entries are dropped and
   * counted (never fatal); unknown user defaults are dropped too.
   * Returns the number of profiles loaded.
   */
  fromJSON(data: unknown): { loaded: number; dropped: number } {
    const droppedBefore = this.droppedOnLoad;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('voice profile store v17 JSON must be an object');
    }
    const obj = data as { version?: unknown; profiles?: unknown; userDefaults?: unknown };
    if (obj.version !== 1) throw new Error(`unsupported voice profile store v17 version: ${String(obj.version)}`);
    if (!Array.isArray(obj.profiles)) throw new Error('voice profile store v17 JSON needs a "profiles" array');
    let loaded = 0;
    for (const raw of obj.profiles) {
      // Untrusted JSON: a malformed entry may crash the validator
      // (the v15 base validator assumes every string field exists),
      // so a throw counts as "invalid, drop it" — never fatal.
      let errors: string[];
      try {
        errors = validateVoiceProfileV17(raw as VoiceProfileV17);
      } catch {
        errors = ['malformed profile entry'];
      }
      if (errors.length > 0 || typeof (raw as VoiceProfileV17).id !== 'string') {
        this.droppedOnLoad += 1;
        continue;
      }
      this.profiles.set((raw as VoiceProfileV17).id, { ...(raw as VoiceProfileV17) });
      loaded += 1;
    }
    if (obj.userDefaults && typeof obj.userDefaults === 'object' && !Array.isArray(obj.userDefaults)) {
      for (const [userId, profileId] of Object.entries(obj.userDefaults as Record<string, unknown>)) {
        if (typeof profileId === 'string' && this.profiles.has(profileId)) {
          this.userDefaults.set(userId, profileId);
        } else {
          this.droppedOnLoad += 1;
        }
      }
    }
    return { loaded, dropped: this.droppedOnLoad - droppedBefore };
  }

  droppedCount(): number {
    return this.droppedOnLoad;
  }

  stats(): VoiceProfileV17Stats {
    const contexts: Partial<Record<VoiceProfileV17Context, number>> = {};
    for (const p of this.profiles.values()) {
      if (p.context !== undefined) contexts[p.context] = (contexts[p.context] ?? 0) + 1;
    }
    return {
      profiles: this.profiles.size,
      users: new Set([...this.profiles.values()].map((p) => p.userId).filter((u): u is string => u !== undefined)).size,
      bots: new Set([...this.profiles.values()].map((p) => p.botId)).size,
      contexts,
      userDefaults: this.userDefaults.size,
      presets: [...this.profiles.values()].filter((p) => p.id.startsWith('preset-')).length,
    };
  }

  summary(): string {
    const s = this.stats();
    return `voice profiles v17: ${s.profiles} profiles, ${s.users} users, ${s.bots} bots, ` +
      `${s.userDefaults} user defaults, ${s.presets} presets`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Voice profiles v17',
      '',
      `- Profiles: ${s.profiles}; users: ${s.users}; bots: ${s.bots}; user defaults: ${s.userDefaults}; presets: ${s.presets}`,
      `- By context: ${VOICE_V17_CONTEXTS.map((c) => `${c}:${s.contexts[c] ?? 0}`).join(' ')}`,
      '',
      '| Id | Name | Bot | User | Context | Lang | Rate | Pitch |',
      '| --- | --- | --- | --- | --- | --- | ---: | ---: |',
    ];
    for (const p of this.list()) {
      lines.push(`| ${p.id} | ${p.displayName} | ${p.botId} | ${p.userId ?? '—'} | ${p.context ?? '—'} | ${p.language} | ${p.rate} | ${p.pitch} |`);
    }
    lines.push('');
    return lines.join('\n');
  }
}

export function createVoiceProfileStoreV17(seedPresetsForBot?: string): VoiceProfileStoreV17 {
  return new VoiceProfileStoreV17(seedPresetsForBot);
}

export function voiceProfilesV17Summary(store: VoiceProfileStoreV17): string {
  return store.summary();
}

export function voiceProfilesV17Markdown(store: VoiceProfileStoreV17): string {
  return store.markdown();
}

export type { TtsQualityV15 };
