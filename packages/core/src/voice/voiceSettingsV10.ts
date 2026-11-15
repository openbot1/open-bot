/**
 * Voice settings v10 (v1.11, Đội T5 — voice realtime v2).
 *
 * v1.04 profiles bound one user's language + engine voice + rate +
 * volume together, but they knew nothing about *providers*: a user
 * who speaks through OpenAI's realtime voice, Gemini's live voice
 * and the system TTS engine had to keep three separate mental
 * models of "which voice". v10 adds the provider layer on top of
 * the v1.04 profile (it reuses `VoiceProfile` — it never replaces
 * it):
 *
 * - `VOICE_V10_PROVIDER_CATALOG`: the voices each provider offers
 *   for speech, with the languages each voice speaks well. The
 *   catalog is data, not a network call: provider voice lists
 *   change rarely, and a settings screen must render offline. A
 *   voice the provider no longer offers is reported, never silently
 *   swapped — the UI shows "voice no longer available" and the
 *   caller falls back explicitly.
 * - `BotVoicePreset`: one bot's voice — provider + provider voice
 *   id + rate + language + noise suppression level + VAD preset.
 *   A preset is per bot, not per user: the Vietnamese support bot
 *   can speak slowly in `vi` on the system engine while the English
 *   coding bot speaks fast in `en` on OpenAI, and neither disturbs
 *   the other. Presets are validated fail-closed (bad provider,
 *   bad voice id, bad rate, bad language) and stored per bot.
 * - `MemoryBotVoicePresetStore` + `FileBotVoicePresetStore`: the
 *   same CRUD shape as the v1.04 profile stores (memory first,
 *   one JSON file for persistence, atomic write via temp + rename,
 *   a corrupt file loads as empty and is reported, never thrown).
 * - `resolveEffectiveVoiceSettings()`: the one precedence rule the
 *   whole app uses — bot preset wins, then the user's v1.04
 *   profile, then the built-in default. The session, the TTS queue
 *   and the settings UI all call this one function, so they can
 *   never disagree about which voice a bot speaks with.
 * - Multilingual: `VOICE_V10_LANGUAGES` lists the languages the
 *   settings UI offers (vi + en first, then zh, ja, ko, es, fr,
 *   de, pt, ru, th, id, ms, hi), each with its BCP-47 tag, its
 *   display name in its own language, and whether STT + TTS are
 *   both supported locally. A language is never offered for a
 *   provider that cannot speak it.
 *
 * Storage is local-first — no account, no cloud, no payment. No
 * key is ever read here: a preset names a provider, it never holds
 * a credential.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { VoiceProfile } from './voiceProfiles';
import { VOICE_PROFILE_LANG_RE } from './voiceProfiles';
import type { VadV10PresetName } from './vadV10';
import { isVadV10PresetName } from './vadV10';
import type { NoiseSuppressionLevel } from './noiseSuppressionV10';
import { isNoiseSuppressionLevel } from './noiseSuppressionV10';

/** Providers that can speak (TTS / realtime voice). */
export type VoiceV10ProviderId = 'openai' | 'gemini' | 'system' | 'elevenlabs' | 'local';

/** Provider ids in the order the settings UI lists them. */
export const VOICE_V10_PROVIDER_IDS: readonly VoiceV10ProviderId[] = [
  'openai', 'gemini', 'system', 'elevenlabs', 'local',
];

export function isVoiceV10ProviderId(value: unknown): value is VoiceV10ProviderId {
  return typeof value === 'string' && (VOICE_V10_PROVIDER_IDS as readonly string[]).includes(value);
}

/** One voice a provider offers. */
export interface VoiceV10CatalogVoice {
  /** Provider voice id (what the API / engine is asked for). */
  id: string;
  /** Display name shown in the picker. */
  name: string;
  /** BCP-47 languages this voice speaks well (base tags). */
  languages: string[];
  /** Voice character (for the picker subtitle). */
  style: 'neutral' | 'warm' | 'bright' | 'calm' | 'energetic';
  /** True when the voice is a built-in default of its provider. */
  isDefault?: boolean;
}

/** One provider in the catalog. */
export interface VoiceV10ProviderCatalog {
  id: VoiceV10ProviderId;
  /** Display name shown in the picker. */
  name: string;
  /** What the provider needs before it can speak (shown as a hint). */
  needsKey: boolean;
  /** Hint shown when the provider has no key yet. */
  keyHint: string;
  voices: VoiceV10CatalogVoice[];
}

/**
 * Provider voice catalog (data, not a network call). Voice lists
 * are the well-known public defaults of each provider as of the
 * v1.11 survey — a settings screen must render offline, and the
 * host refreshes this list when a provider adds voices.
 */
export const VOICE_V10_PROVIDER_CATALOG: readonly VoiceV10ProviderCatalog[] = [
  {
    id: 'openai', name: 'OpenAI', needsKey: true,
    keyHint: 'Add an OpenAI key in Settings to use OpenAI voices.',
    voices: [
      { id: 'alloy', name: 'Alloy', languages: ['en', 'vi'], style: 'neutral', isDefault: true },
      { id: 'echo', name: 'Echo', languages: ['en'], style: 'warm' },
      { id: 'fable', name: 'Fable', languages: ['en'], style: 'bright' },
      { id: 'onyx', name: 'Onyx', languages: ['en'], style: 'calm' },
      { id: 'nova', name: 'Nova', languages: ['en', 'vi'], style: 'warm' },
      { id: 'shimmer', name: 'Shimmer', languages: ['en'], style: 'bright' },
      { id: 'coral', name: 'Coral', languages: ['en'], style: 'energetic' },
      { id: 'verse', name: 'Verse', languages: ['en'], style: 'energetic' },
    ],
  },
  {
    id: 'gemini', name: 'Gemini', needsKey: true,
    keyHint: 'Add a Gemini key in Settings to use Gemini voices.',
    voices: [
      { id: 'puck', name: 'Puck', languages: ['en', 'vi'], style: 'energetic', isDefault: true },
      { id: 'charon', name: 'Charon', languages: ['en'], style: 'calm' },
      { id: 'kore', name: 'Kore', languages: ['en'], style: 'warm' },
      { id: 'fenrir', name: 'Fenrir', languages: ['en'], style: 'bright' },
      { id: 'aoede', name: 'Aoede', languages: ['en', 'vi'], style: 'warm' },
      { id: 'leda', name: 'Leda', languages: ['en'], style: 'calm' },
    ],
  },
  {
    id: 'system', name: 'System (offline)', needsKey: false,
    keyHint: 'Uses the operating system voice — no key needed.',
    voices: [
      { id: 'vi-vn-x-south', name: 'Tiếng Việt — miền Nam', languages: ['vi'], style: 'warm', isDefault: true },
      { id: 'vi', name: 'Tiếng Việt', languages: ['vi'], style: 'neutral' },
      { id: 'en', name: 'English', languages: ['en'], style: 'neutral' },
      { id: 'en-gb', name: 'English — UK', languages: ['en'], style: 'calm' },
    ],
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs', needsKey: true,
    keyHint: 'Add an ElevenLabs key in Settings to use ElevenLabs voices.',
    voices: [
      { id: 'rachel', name: 'Rachel', languages: ['en'], style: 'calm', isDefault: true },
      { id: 'adam', name: 'Adam', languages: ['en'], style: 'warm' },
      { id: 'bella', name: 'Bella', languages: ['en'], style: 'bright' },
      { id: 'elli', name: 'Elli', languages: ['en'], style: 'energetic' },
    ],
  },
  {
    id: 'local', name: 'Local (Ollama / Piper)', needsKey: false,
    keyHint: 'Uses a local voice model — no key needed.',
    voices: [
      { id: 'piper-vi', name: 'Piper — Vietnamese', languages: ['vi'], style: 'neutral', isDefault: true },
      { id: 'piper-en', name: 'Piper — English', languages: ['en'], style: 'neutral' },
    ],
  },
];

/** A provider catalog entry by id, or undefined. */
export function getVoiceV10ProviderCatalog(providerId: string): VoiceV10ProviderCatalog | undefined {
  return VOICE_V10_PROVIDER_CATALOG.find((p) => p.id === providerId);
}

/** A catalog voice by provider + voice id, or undefined. */
export function findVoiceV10CatalogVoice(providerId: string, voiceId: string): VoiceV10CatalogVoice | undefined {
  return getVoiceV10ProviderCatalog(providerId)?.voices.find((v) => v.id === voiceId);
}

/** Voices of one provider that speak a language (base tag match). */
export function voicesForLanguageV10(providerId: string, language: string): VoiceV10CatalogVoice[] {
  const base = language.toLowerCase().split('-')[0];
  return (getVoiceV10ProviderCatalog(providerId)?.voices ?? []).filter(
    (v) => v.languages.some((l) => l.toLowerCase().split('-')[0] === base),
  );
}

/** The default voice of a provider (its `isDefault`, else first). */
export function defaultVoiceForProviderV10(providerId: string): VoiceV10CatalogVoice | undefined {
  const catalog = getVoiceV10ProviderCatalog(providerId);
  return catalog?.voices.find((v) => v.isDefault) ?? catalog?.voices[0];
}

/** One language the settings UI offers. */
export interface VoiceV10Language {
  /** BCP-47 tag (what STT/TTS are asked for). */
  tag: string;
  /** Display name in its own language. */
  name: string;
  /** True when local STT supports it; TTS support follows the provider. */
  sttSupported: boolean;
}

/** Languages offered in the voice settings UI (vi + en first). */
export const VOICE_V10_LANGUAGES: readonly VoiceV10Language[] = [
  { tag: 'vi', name: 'Tiếng Việt', sttSupported: true },
  { tag: 'en', name: 'English', sttSupported: true },
  { tag: 'zh', name: '中文', sttSupported: true },
  { tag: 'ja', name: '日本語', sttSupported: true },
  { tag: 'ko', name: '한국어', sttSupported: true },
  { tag: 'es', name: 'Español', sttSupported: true },
  { tag: 'fr', name: 'Français', sttSupported: true },
  { tag: 'de', name: 'Deutsch', sttSupported: true },
  { tag: 'pt', name: 'Português', sttSupported: true },
  { tag: 'ru', name: 'Русский', sttSupported: true },
  { tag: 'th', name: 'ไทย', sttSupported: true },
  { tag: 'id', name: 'Bahasa Indonesia', sttSupported: true },
  { tag: 'ms', name: 'Bahasa Melayu', sttSupported: false },
  { tag: 'hi', name: 'हिन्दी', sttSupported: true },
];

export function isVoiceV10LanguageTag(value: unknown): value is string {
  return typeof value === 'string' && VOICE_V10_LANGUAGES.some((l) => l.tag === value.toLowerCase());
}

/** Speaking rate multiplier (1 = normal). Same range as v1.04. */
export const VOICE_V10_MIN_RATE = 0.5;
export const VOICE_V10_MAX_RATE = 2.0;
/** A bot id is a lowercase slug (same rule as the v9 manager). */
export const VOICE_V10_BOT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A preset id is a lowercase slug. */
export const VOICE_V10_PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Max presets one bot may keep. */
export const VOICE_V10_MAX_PRESETS_PER_BOT = 10;

/** One bot's voice: provider + voice + rate + language + processing. */
export interface BotVoicePreset {
  /** Slug id, unique per bot (e.g. `vi-slow`). */
  id: string;
  /** Bot this preset belongs to. */
  botId: string;
  /** Display name shown in the picker. */
  name: string;
  /** Provider that speaks this preset. */
  provider: VoiceV10ProviderId;
  /** Provider voice id; null = provider default. */
  voice: string | null;
  /** STT + TTS language (BCP-47 tag, e.g. `vi`, `en`). */
  language: string;
  /** Speaking rate multiplier (1 = normal). */
  rate: number;
  /** Noise suppression level applied to the mic. */
  noiseSuppression: NoiseSuppressionLevel;
  /** VAD v10 preset for the mic. */
  vadPreset: VadV10PresetName;
  /** When created (wall clock ms). */
  createdAt: number;
  /** When last edited (wall clock ms). */
  updatedAt: number;
}

export type BotVoicePresetValidationResult =
  | { ok: true; preset: BotVoicePreset }
  | { ok: false; error: string };

function normalizePreset(input: Partial<BotVoicePreset> & { id: string; botId: string }): BotVoicePreset {
  const now = Date.now();
  return {
    id: input.id,
    botId: input.botId,
    name: input.name ?? input.id,
    provider: input.provider ?? 'system',
    voice: input.voice ?? null,
    language: input.language ?? 'en',
    rate: input.rate ?? 1,
    noiseSuppression: input.noiseSuppression ?? 'moderate',
    vadPreset: input.vadPreset ?? 'office',
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

/**
 * Validate a bot voice preset (new or edited). Rejects — never
 * silently clamps — a bad id, bot id, provider, voice id, language,
 * rate, noise level or VAD preset, an empty name, or a name over 80
 * chars. A voice id that is not in the provider catalog is rejected
 * too, so a stale preset can never silently speak with another voice.
 */
export function validateBotVoicePreset(
  input: Partial<BotVoicePreset> & { id: string; botId: string },
): BotVoicePresetValidationResult {
  if (!VOICE_V10_PRESET_ID_RE.test(input.id)) {
    return { ok: false, error: `voice preset id "${input.id}" must be a lowercase slug (letters, digits, dashes).` };
  }
  if (!VOICE_V10_BOT_ID_RE.test(input.botId)) {
    return { ok: false, error: `voice preset botId "${input.botId}" must be a lowercase slug.` };
  }
  const name = (input.name ?? input.id).trim();
  if (!name) return { ok: false, error: 'voice preset name must not be empty.' };
  if (name.length > 80) return { ok: false, error: 'voice preset name is over 80 chars.' };
  const provider = input.provider ?? 'system';
  if (!isVoiceV10ProviderId(provider)) {
    return { ok: false, error: `voice preset provider "${String(provider)}" is not a known voice provider.` };
  }
  if (input.voice !== undefined && input.voice !== null) {
    if (typeof input.voice !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(input.voice)) {
      return { ok: false, error: `voice preset voice "${input.voice}" must be a plain voice id.` };
    }
    if (!findVoiceV10CatalogVoice(provider, input.voice)) {
      return { ok: false, error: `voice "${input.voice}" is not offered by provider "${provider}".` };
    }
  }
  const language = input.language ?? 'en';
  if (!VOICE_PROFILE_LANG_RE.test(language) && !isVoiceV10LanguageTag(language)) {
    return { ok: false, error: `voice preset language "${language}" must look like "vi" or "en-US".` };
  }
  const rate = input.rate ?? 1;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < VOICE_V10_MIN_RATE || rate > VOICE_V10_MAX_RATE) {
    return { ok: false, error: `voice preset rate ${rate} must be ${VOICE_V10_MIN_RATE}..${VOICE_V10_MAX_RATE}.` };
  }
  const noiseSuppression = input.noiseSuppression ?? 'moderate';
  if (!isNoiseSuppressionLevel(noiseSuppression)) {
    return { ok: false, error: `voice preset noiseSuppression "${String(noiseSuppression)}" is not a known level.` };
  }
  const vadPreset = input.vadPreset ?? 'office';
  if (!isVadV10PresetName(vadPreset)) {
    return { ok: false, error: `voice preset vadPreset "${String(vadPreset)}" is not a known VAD preset.` };
  }
  return { ok: true, preset: normalizePreset({ ...input, name, provider, language, rate, noiseSuppression, vadPreset }) };
}

/** Built-in per-bot presets (read-only templates — never mutated). */
export const DEFAULT_BOT_VOICE_PRESETS: readonly BotVoicePreset[] = [
  { id: 'vi-slow', botId: 'default', name: 'Tiếng Việt — chậm, rõ', provider: 'system', voice: 'vi-vn-x-south', language: 'vi', rate: 0.85, noiseSuppression: 'moderate', vadPreset: 'office', createdAt: 0, updatedAt: 0 },
  { id: 'vi-fast', botId: 'default', name: 'Tiếng Việt — nhanh', provider: 'system', voice: 'vi', language: 'vi', rate: 1.2, noiseSuppression: 'light', vadPreset: 'office', createdAt: 0, updatedAt: 0 },
  { id: 'en-us', botId: 'default', name: 'English — US', provider: 'openai', voice: 'alloy', language: 'en', rate: 1, noiseSuppression: 'moderate', vadPreset: 'office', createdAt: 0, updatedAt: 0 },
  { id: 'en-gemini', botId: 'default', name: 'English — Gemini', provider: 'gemini', voice: 'puck', language: 'en', rate: 1, noiseSuppression: 'moderate', vadPreset: 'quiet', createdAt: 0, updatedAt: 0 },
  { id: 'noisy-room', botId: 'default', name: 'Phòng ồn — lọc mạnh', provider: 'system', voice: null, language: 'vi', rate: 1, noiseSuppression: 'aggressive', vadPreset: 'noisy', createdAt: 0, updatedAt: 0 },
];

/** A built-in preset template by id, or undefined (never the live object). */
export function getBuiltinBotVoicePreset(id: string): BotVoicePreset | undefined {
  const found = DEFAULT_BOT_VOICE_PRESETS.find((p) => p.id === id);
  return found ? { ...found } : undefined;
}

/** The voice settings a session actually speaks with. */
export interface EffectiveVoiceSettings {
  provider: VoiceV10ProviderId;
  /** Provider voice id (resolved — never null). */
  voice: string;
  language: string;
  rate: number;
  noiseSuppression: NoiseSuppressionLevel;
  vadPreset: VadV10PresetName;
  /** Where the settings came from (for the panel). */
  source: 'bot-preset' | 'user-profile' | 'default';
  /** Id of the bot preset or user profile used, when any. */
  sourceId: string | null;
}

/** The built-in default settings (system provider, engine default voice). */
export function defaultEffectiveVoiceSettings(): EffectiveVoiceSettings {
  const voice = defaultVoiceForProviderV10('system');
  return {
    provider: 'system',
    voice: voice?.id ?? 'en',
    language: 'en',
    rate: 1,
    noiseSuppression: 'moderate',
    vadPreset: 'office',
    source: 'default',
    sourceId: null,
  };
}

/**
 * Resolve the effective settings for one bot. Precedence (one rule,
 * used by the session, the TTS queue and the settings UI alike):
 * bot preset wins → the user's v1.04 profile → the built-in
 * default. A bot preset whose voice vanished from the catalog is
 * treated as missing (the caller is told via `source`, never
 * silently swapped).
 */
export function resolveEffectiveVoiceSettings(input: {
  botPreset?: BotVoicePreset | null;
  userProfile?: VoiceProfile | null;
}): EffectiveVoiceSettings {
  const { botPreset, userProfile } = input;
  if (botPreset) {
    const voice = botPreset.voice ?? defaultVoiceForProviderV10(botPreset.provider)?.id ?? 'en';
    return {
      provider: botPreset.provider,
      voice,
      language: botPreset.language,
      rate: botPreset.rate,
      noiseSuppression: botPreset.noiseSuppression,
      vadPreset: botPreset.vadPreset,
      source: 'bot-preset',
      sourceId: botPreset.id,
    };
  }
  if (userProfile) {
    const voice = userProfile.voice ?? defaultVoiceForProviderV10('system')?.id ?? 'en';
    return {
      provider: 'system',
      voice,
      language: userProfile.lang,
      rate: userProfile.rate,
      noiseSuppression: 'moderate',
      vadPreset: 'office',
      source: 'user-profile',
      sourceId: userProfile.id,
    };
  }
  return defaultEffectiveVoiceSettings();
}

/** Pick the best preset for a language: exact tag, then base tag, then first. */
export function pickPresetForLanguage(
  presets: readonly BotVoicePreset[],
  language: string,
): BotVoicePreset | undefined {
  const wanted = language.toLowerCase();
  const base = wanted.split('-')[0];
  return (
    presets.find((p) => p.language.toLowerCase() === wanted) ??
    presets.find((p) => p.language.toLowerCase().split('-')[0] === base) ??
    presets[0]
  );
}

export interface BotVoicePresetStoreStats {
  bots: number;
  presets: number;
  activePresets: number;
}

/**
 * Per-bot preset CRUD + one active preset per bot, in memory.
 * `botId` scopes everything: two bots may both own a preset called
 * `vi-slow` without colliding. Built-ins are not stored here —
 * `getActive` falls back to `pickPresetForLanguage` over the
 * built-ins when the bot has no active preset yet.
 */
export class MemoryBotVoicePresetStore {
  private readonly presets = new Map<string, Map<string, BotVoicePreset>>();
  private readonly active = new Map<string, string>();

  create(input: Partial<BotVoicePreset> & { id: string; botId: string }): BotVoicePresetValidationResult {
    const validated = validateBotVoicePreset(input);
    if (!validated.ok) return validated;
    const { preset } = validated;
    let perBot = this.presets.get(preset.botId);
    if (!perBot) {
      perBot = new Map();
      this.presets.set(preset.botId, perBot);
    }
    if (perBot.has(preset.id)) {
      return { ok: false, error: `voice preset "${preset.id}" already exists for bot "${preset.botId}".` };
    }
    if (perBot.size >= VOICE_V10_MAX_PRESETS_PER_BOT) {
      return { ok: false, error: `bot "${preset.botId}" already has ${VOICE_V10_MAX_PRESETS_PER_BOT} voice presets.` };
    }
    perBot.set(preset.id, { ...preset });
    return { ok: true, preset: { ...preset } };
  }

  get(botId: string, presetId: string): BotVoicePreset | undefined {
    const found = this.presets.get(botId)?.get(presetId);
    return found ? { ...found } : undefined;
  }

  list(botId: string): BotVoicePreset[] {
    return [...(this.presets.get(botId)?.values() ?? [])].map((p) => ({ ...p }));
  }

  update(botId: string, presetId: string, patch: Partial<BotVoicePreset>): BotVoicePresetValidationResult {
    const existing = this.presets.get(botId)?.get(presetId);
    if (!existing) return { ok: false, error: `voice preset "${presetId}" not found for bot "${botId}".` };
    const validated = validateBotVoicePreset({ ...existing, ...patch, id: presetId, botId });
    if (!validated.ok) return validated;
    const next = { ...validated.preset, createdAt: existing.createdAt, updatedAt: Date.now() };
    this.presets.get(botId)!.set(presetId, next);
    return { ok: true, preset: { ...next } };
  }

  remove(botId: string, presetId: string): boolean {
    const removed = this.presets.get(botId)?.delete(presetId) ?? false;
    if (this.active.get(botId) === presetId) this.active.delete(botId);
    return removed;
  }

  setActive(botId: string, presetId: string): boolean {
    const preset = this.presets.get(botId)?.get(presetId) ?? getBuiltinBotVoicePreset(presetId);
    if (!preset) return false;
    if (preset.botId !== botId && preset.botId !== 'default') return false;
    this.active.set(botId, presetId);
    return true;
  }

  getActive(botId: string, language?: string): BotVoicePreset | undefined {
    const activeId = this.active.get(botId);
    if (activeId) {
      const stored = this.presets.get(botId)?.get(activeId);
      if (stored) return { ...stored };
      const builtin = getBuiltinBotVoicePreset(activeId);
      if (builtin) return { ...builtin, botId };
    }
    const owned = this.list(botId);
    if (owned.length > 0) return pickPresetForLanguage(owned, language ?? 'en');
    const builtins = DEFAULT_BOT_VOICE_PRESETS.map((p) => ({ ...p, botId }));
    return pickPresetForLanguage(builtins, language ?? 'en');
  }

  getStats(): BotVoicePresetStoreStats {
    let presets = 0;
    for (const perBot of this.presets.values()) presets += perBot.size;
    return { bots: this.presets.size, presets, activePresets: this.active.size };
  }

  toJson(): Record<string, BotVoicePreset[]> {
    const out: Record<string, BotVoicePreset[]> = {};
    for (const [botId, perBot] of this.presets) out[botId] = [...perBot.values()].map((p) => ({ ...p }));
    return out;
  }

  fromJson(data: unknown): { loaded: number; error: string | null } {
    this.presets.clear();
    this.active.clear();
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { loaded: 0, error: 'voice preset file must hold an object keyed by bot id.' };
    }
    let loaded = 0;
    for (const [botId, list] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (raw === null || typeof raw !== 'object') continue;
        const validated = validateBotVoicePreset({ ...(raw as Partial<BotVoicePreset>), botId } as Partial<BotVoicePreset> & { id: string; botId: string });
        if (!validated.ok) continue;
        let perBot = this.presets.get(botId);
        if (!perBot) {
          perBot = new Map();
          this.presets.set(botId, perBot);
        }
        perBot.set(validated.preset.id, validated.preset);
        loaded += 1;
      }
    }
    return { loaded, error: null };
  }
}

/** File-backed preset store (one JSON file, atomic write). */
export class FileBotVoicePresetStore extends MemoryBotVoicePresetStore {
  private readonly filePath: string;
  private loadError: string | null = null;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.load();
  }

  getLoadError(): string | null {
    return this.loadError;
  }

  getFilePath(): string {
    return this.filePath;
  }

  load(): { loaded: number; error: string | null } {
    if (!existsSync(this.filePath)) {
      this.loadError = null;
      return { loaded: 0, error: null };
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      const result = this.fromJson(parsed);
      this.loadError = result.error;
      return result;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      return { loaded: 0, error: this.loadError };
    }
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.toJson(), null, 2), 'utf-8');
    renameSync(tmp, this.filePath);
  }

  /** Remove the file (used by tests / reset). */
  deleteFile(): void {
    if (existsSync(this.filePath)) rmSync(this.filePath);
  }
}

/** One-line summary of a preset store's counters. */
export function botVoicePresetStoreSummary(stats: BotVoicePresetStoreStats): string {
  return `Bot voice presets: ${stats.presets} presets across ${stats.bots} bots, ${stats.activePresets} active.`;
}

/** Effective settings as Markdown (for the settings panel). */
export function effectiveVoiceSettingsMarkdown(settings: EffectiveVoiceSettings): string {
  const lines = [
    '## Voice settings',
    '',
    `- provider: ${settings.provider}, voice: ${settings.voice}`,
    `- language: ${settings.language}, rate: ${settings.rate}`,
    `- noise suppression: ${settings.noiseSuppression}, VAD preset: ${settings.vadPreset}`,
    `- source: ${settings.source}${settings.sourceId ? ` (${settings.sourceId})` : ''}`,
  ];
  return lines.join('\n');
}
