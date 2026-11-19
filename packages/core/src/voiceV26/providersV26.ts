/**
 * TTS/STT provider registry for voice v26 (v1.39, Team T5).
 *
 * v24 owns the dynamic provider/model catalogue (health,
 * mid-session model switching) and v25 measures real
 * per-provider latency. v26 owns the *voice* provider layer
 * on top: TTS and STT providers side by side, local and
 * API-key, with a capability matrix, selection by
 * latency/quality/cost weights, health, and a fallback chain.
 *
 * Configuration through Vault: an API-key provider stores
 * only its Vault key *name* (`vaultKeyRef`, e.g.
 * `voice-v26-api-tts-key`). This module never reads, stores,
 * logs or transmits a key value — the host resolves the
 * reference from the Vault when it actually dials the
 * provider, which this module never does.
 *
 * Every provider ships a deterministic mock: `synthesize`
 * returns a fake audio duration derived from the text
 * length, `transcribe` returns a deterministic transcript
 * derived from the fake audio payload. Tests therefore never
 * touch a network, a key, or a sound card, and two runs with
 * the same input produce byte-identical output.
 *
 * Selection: `select(kind, prefs)` scores enabled providers
 * of the kind by weighted latency / quality / cost class
 * (fast = 1, balanced = 2, quality = 3 — lower is faster /
 * cheaper, higher is better quality), health, language and
 * voice match, and the current degraded level (heavy
 * degraded mode forces the fastest class). The fallback
 * chain is the same ranking with the winner removed.
 */
import {
  VOICE_V26_MOCK_PROVIDERS,
  clampV26,
  round2V26,
  turnChecksumV26,
  type VoiceV26DegradedLevel,
  type VoiceV26MockAudioResult,
  type VoiceV26ProviderClass,
  type VoiceV26ProviderDef,
  type VoiceV26ProviderKind,
  type VoiceV26ProviderOrigin,
  type VoiceV26ProviderSelection,
} from './types';

export interface ProviderRegistryV26Options {
  /** Include the built-in mock providers (default true). */
  includeMocks: boolean;
  /** Default selection weights (must sum to ~1, normalised anyway). */
  weights: { latency: number; quality: number; cost: number };
  /** Health below this is excluded from selection (default 20). */
  minHealth: number;
}

export function defaultProviderRegistryV26Options(): ProviderRegistryV26Options {
  return {
    includeMocks: true,
    weights: { latency: 0.5, quality: 0.3, cost: 0.2 },
    minHealth: 20,
  };
}

export function validateProviderRegistryV26Options(o: Partial<ProviderRegistryV26Options>): string[] {
  const errors: string[] = [];
  if (o.weights !== undefined) {
    for (const [key, value] of Object.entries(o.weights)) {
      if (value !== undefined && !(value >= 0 && value <= 1)) {
        errors.push(`weights.${key} must be 0..1`);
      }
    }
    const sum = (o.weights.latency ?? 0) + (o.weights.quality ?? 0) + (o.weights.cost ?? 0);
    if (sum <= 0) errors.push('weights must sum to more than 0');
  }
  if (o.minHealth !== undefined && !(o.minHealth >= 0 && o.minHealth <= 100)) {
    errors.push('minHealth must be 0..100');
  }
  return errors;
}

/** Selection preferences for one turn. */
export interface VoiceV26SelectPrefs {
  kind: VoiceV26ProviderKind;
  language?: string | null;
  voice?: string | null;
  streaming?: boolean | null;
  /** Override the registry weights for this selection. */
  weights?: { latency: number; quality: number; cost: number } | null;
  degradedLevel?: VoiceV26DegradedLevel;
  /** Provider ids to skip (already failed this turn). */
  excludeIds?: string[];
}

/** One scored candidate (exposed for ranking inspection). */
export interface VoiceV26ProviderRank {
  providerId: string;
  providerName: string;
  score: number;
  latencyScore: number;
  qualityScore: number;
  costScore: number;
  health: number;
  reason: string;
}

const CLASS_VALUE: Record<VoiceV26ProviderClass, number> = {
  fast: 1,
  balanced: 2,
  quality: 3,
};

/** Deterministic fake transcripts for mock STT (by checksum). */
const MOCK_TRANSCRIPTS = [
  'hello, can you hear me',
  'please continue from where you stopped',
  'yes, that makes sense',
  'could you say that again more slowly',
  'thank you, that helps a lot',
  'let me think about that for a moment',
];

export function createProviderRegistryV26(
  opts: Partial<ProviderRegistryV26Options> = {},
): ProviderRegistryV26 {
  return new ProviderRegistryV26(opts);
}

export class ProviderRegistryV26 {
  private readonly opts: ProviderRegistryV26Options;
  private readonly providers = new Map<string, VoiceV26ProviderDef>();
  private readonly failures = new Map<string, number>();
  private readonly successes = new Map<string, number>();

  constructor(opts: Partial<ProviderRegistryV26Options> = {}) {
    const errors = validateProviderRegistryV26Options(opts);
    if (errors.length > 0) throw new Error(`Invalid ProviderRegistryV26Options: ${errors.join('; ')}`);
    this.opts = { ...defaultProviderRegistryV26Options(), ...opts };
    if (this.opts.includeMocks) {
      for (const def of VOICE_V26_MOCK_PROVIDERS) {
        this.providers.set(def.id, { ...def, health: 100 });
      }
    }
  }

  options(): ProviderRegistryV26Options {
    return { ...this.opts, weights: { ...this.opts.weights } };
  }

  /** Register (or replace) a provider definition. */
  register(def: Omit<VoiceV26ProviderDef, 'health'> & { health?: number }): VoiceV26ProviderDef {
    const errors = validateProviderDefV26(def);
    if (errors.length > 0) throw new Error(`Invalid VoiceV26ProviderDef: ${errors.join('; ')}`);
    const stored: VoiceV26ProviderDef = {
      ...def,
      languages: [...def.languages],
      voices: [...def.voices],
      health: def.health === undefined ? 100 : clampV26(def.health, 0, 100),
    };
    this.providers.set(stored.id, stored);
    return { ...stored, languages: [...stored.languages], voices: [...stored.voices] };
  }

  /** Remove a provider by id. */
  remove(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): VoiceV26ProviderDef | null {
    const found = this.providers.get(id);
    return found ? { ...found, languages: [...found.languages], voices: [...found.voices] } : null;
  }

  list(filter: {
    kind?: VoiceV26ProviderKind;
    origin?: VoiceV26ProviderOrigin;
    language?: string;
    enabled?: boolean;
    mock?: boolean;
  } = {}): VoiceV26ProviderDef[] {
    return [...this.providers.values()]
      .filter((p) => (filter.kind === undefined || p.kind === filter.kind))
      .filter((p) => (filter.origin === undefined || p.origin === filter.origin))
      .filter((p) => (filter.language === undefined || p.languages.includes(filter.language)))
      .filter((p) => (filter.enabled === undefined || p.enabled === filter.enabled))
      .filter((p) => (filter.mock === undefined || p.mock === filter.mock))
      .map((p) => ({ ...p, languages: [...p.languages], voices: [...p.voices] }));
  }

  count(): number {
    return this.providers.size;
  }

  /** Enable / disable a provider (disabled providers are never selected). */
  setEnabled(id: string, enabled: boolean): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;
    provider.enabled = enabled;
    return true;
  }

  /** Record a successful call (health recovers toward 100). */
  markSuccess(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;
    this.successes.set(id, (this.successes.get(id) ?? 0) + 1);
    provider.health = clampV26(provider.health + 5, 0, 100);
    return true;
  }

  /** Record a failed call (health drops; repeated failures exclude it). */
  markFailure(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;
    this.failures.set(id, (this.failures.get(id) ?? 0) + 1);
    provider.health = clampV26(provider.health - 20, 0, 100);
    return true;
  }

  healthOf(id: string): number | null {
    return this.providers.get(id)?.health ?? null;
  }

  /** Rank all eligible providers of a kind for the given prefs. */
  rank(prefs: VoiceV26SelectPrefs): VoiceV26ProviderRank[] {
    const weights = prefs.weights ?? this.opts.weights;
    const total = weights.latency + weights.quality + weights.cost;
    const w = {
      latency: total === 0 ? 0 : weights.latency / total,
      quality: total === 0 ? 0 : weights.quality / total,
      cost: total === 0 ? 0 : weights.cost / total,
    };
    const excluded = new Set(prefs.excludeIds ?? []);
    const ranked: VoiceV26ProviderRank[] = [];
    for (const p of this.providers.values()) {
      if (p.kind !== prefs.kind) continue;
      if (!p.enabled) continue;
      if (p.health < this.opts.minHealth) continue;
      if (excluded.has(p.id)) continue;
      if (prefs.language && !p.languages.includes(prefs.language)) continue;
      if (prefs.voice && p.kind === 'tts' && !p.voices.includes(prefs.voice)) continue;
      if (prefs.streaming === true && !p.streaming) continue;
      // Heavy degraded mode forces the fastest class.
      if (prefs.degradedLevel === 'heavy' && p.latencyClass !== 'fast') continue;
      const latencyScore = (4 - CLASS_VALUE[p.latencyClass]) / 3;
      const qualityScore = (CLASS_VALUE[p.qualityClass] - 1) / 2;
      const costScore = (4 - CLASS_VALUE[p.costClass]) / 3;
      const healthScore = p.health / 100;
      const score = round2V26(
        w.latency * latencyScore + w.quality * qualityScore + w.cost * costScore + 0.2 * healthScore,
      );
      const reasons: string[] = [];
      if (prefs.language) reasons.push(`language ${prefs.language}`);
      if (prefs.voice) reasons.push(`voice ${prefs.voice}`);
      if (prefs.streaming) reasons.push('streaming');
      reasons.push(`${p.latencyClass} latency`);
      ranked.push({
        providerId: p.id,
        providerName: p.name,
        score,
        latencyScore: round2V26(latencyScore),
        qualityScore: round2V26(qualityScore),
        costScore: round2V26(costScore),
        health: p.health,
        reason: reasons.join(', '),
      });
    }
    ranked.sort((a, b) => b.score - a.score || a.providerId.localeCompare(b.providerId));
    return ranked;
  }

  /** Select the best provider of a kind (null when none eligible). */
  select(prefs: VoiceV26SelectPrefs, atMs: number): VoiceV26ProviderSelection | null {
    const ranked = this.rank(prefs);
    if (ranked.length === 0) return null;
    const winner = ranked[0];
    const provider = this.providers.get(winner.providerId);
    if (!provider) return null;
    return {
      kind: prefs.kind,
      providerId: winner.providerId,
      providerName: winner.providerName,
      origin: provider.origin,
      model: provider.model,
      reason: `score ${winner.score} (${winner.reason})`,
      triedIds: [],
      degradedLevel: prefs.degradedLevel ?? 'off',
      atMs,
    };
  }

  /** Fallback chain: the ranking with the winner removed. */
  fallbackChain(prefs: VoiceV26SelectPrefs, atMs: number): VoiceV26ProviderSelection[] {
    void atMs;
    const ranked = this.rank(prefs);
    return ranked.slice(1).map((r) => {
      const provider = this.providers.get(r.providerId);
      return {
        kind: prefs.kind,
        providerId: r.providerId,
        providerName: r.providerName,
        origin: provider ? provider.origin : 'mock',
        model: provider ? provider.model : '',
        reason: `fallback score ${r.score} (${r.reason})`,
        triedIds: ranked.slice(0, 1).map((x) => x.providerId),
        degradedLevel: prefs.degradedLevel ?? 'off',
        atMs,
      };
    });
  }

  /**
   * Mock synthesis: deterministic fake TTS output. Duration is
   * derived from text length and the provider class (fast
   * providers speak faster); first-chunk latency likewise.
   * No network, no key, no sound card.
   */
  synthesize(input: {
    providerId: string;
    text: string;
    voice?: string | null;
    language?: string | null;
    atMs: number;
  }): VoiceV26MockAudioResult {
    const provider = this.providers.get(input.providerId);
    if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
    if (provider.kind !== 'tts') throw new Error(`Provider ${input.providerId} is not a TTS provider`);
    if (!provider.enabled) throw new Error(`Provider ${input.providerId} is disabled`);
    const text = input.text.slice(0, provider.maxInput);
    const charsPerSecond = provider.latencyClass === 'fast' ? 90 : provider.latencyClass === 'balanced' ? 75 : 60;
    const durationMs = Math.round((text.length / charsPerSecond) * 1000);
    const firstChunkMs = provider.streaming
      ? provider.latencyClass === 'fast' ? 80 : provider.latencyClass === 'balanced' ? 150 : 300
      : durationMs;
    const voice = input.voice ?? provider.voices[0] ?? null;
    this.markSuccess(input.providerId);
    return {
      providerId: provider.id,
      kind: 'tts',
      text,
      durationMs,
      firstChunkMs,
      chars: text.length,
      voice,
      language: input.language ?? provider.languages[0] ?? 'en',
    };
  }

  /**
   * Mock transcription: deterministic fake STT output. The
   * transcript is picked from a fixed corpus by checksum of
   * the (fake) audio payload, so the same input always gives
   * the same transcript. No network, no key, no sound card.
   */
  transcribe(input: {
    providerId: string;
    /** Fake audio payload (any string; only its checksum matters). */
    audioPayload: string;
    language?: string | null;
    atMs: number;
  }): VoiceV26MockAudioResult {
    const provider = this.providers.get(input.providerId);
    if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
    if (provider.kind !== 'stt') throw new Error(`Provider ${input.providerId} is not an STT provider`);
    if (!provider.enabled) throw new Error(`Provider ${input.providerId} is disabled`);
    const checksum = turnChecksumV26(input.audioPayload);
    const text = MOCK_TRANSCRIPTS[checksum % MOCK_TRANSCRIPTS.length];
    const durationMs = provider.latencyClass === 'fast' ? 120 : provider.latencyClass === 'balanced' ? 300 : 700;
    const firstChunkMs = provider.streaming ? Math.round(durationMs / 3) : durationMs;
    this.markSuccess(input.providerId);
    return {
      providerId: provider.id,
      kind: 'stt',
      text,
      durationMs,
      firstChunkMs,
      chars: text.length,
      voice: null,
      language: input.language ?? provider.languages[0] ?? 'en',
    };
  }

  /** Capability matrix: which providers serve which language/kind. */
  capabilityMatrix(): Array<{
    kind: VoiceV26ProviderKind;
    language: string;
    providers: string[];
  }> {
    const languages = new Set<string>();
    for (const p of this.providers.values()) {
      for (const lang of p.languages) languages.add(lang);
    }
    const rows: Array<{ kind: VoiceV26ProviderKind; language: string; providers: string[] }> = [];
    for (const kind of ['stt', 'tts'] as VoiceV26ProviderKind[]) {
      for (const language of [...languages].sort()) {
        const providers = this.list({ kind, language, enabled: true }).map((p) => p.id);
        if (providers.length > 0) rows.push({ kind, language, providers });
      }
    }
    return rows;
  }

  stats(): {
    total: number;
    stt: number;
    tts: number;
    local: number;
    apiKey: number;
    mock: number;
    enabled: number;
    failures: Record<string, number>;
    successes: Record<string, number>;
  } {
    const all = [...this.providers.values()];
    return {
      total: all.length,
      stt: all.filter((p) => p.kind === 'stt').length,
      tts: all.filter((p) => p.kind === 'tts').length,
      local: all.filter((p) => p.origin === 'local' || p.origin === 'system').length,
      apiKey: all.filter((p) => p.origin === 'api-key').length,
      mock: all.filter((p) => p.mock).length,
      enabled: all.filter((p) => p.enabled).length,
      failures: Object.fromEntries(this.failures),
      successes: Object.fromEntries(this.successes),
    };
  }

  summary(): string {
    const s = this.stats();
    return (
      `providers v26: ${s.total} providers (${s.stt} STT, ${s.tts} TTS; ` +
      `${s.local} local/system, ${s.apiKey} API-key, ${s.mock} mock), ${s.enabled} enabled`
    );
  }

  markdown(): string {
    const lines = [
      '# Providers v26',
      '',
      '| id | kind | origin | model | languages | voices | streaming | latency | quality | cost | health | enabled |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const p of this.list()) {
      lines.push(
        `| ${p.id} | ${p.kind} | ${p.origin} | ${p.model} | ${p.languages.join(',')} | ` +
        `${p.voices.join(',') || '-'} | ${p.streaming} | ${p.latencyClass} | ` +
        `${p.qualityClass} | ${p.costClass} | ${p.health} | ${p.enabled} |`,
      );
    }
    lines.push('', `Vault key refs (names only, never values): ${this.list({ origin: 'api-key' }).map((p) => `${p.id} -> ${p.vaultKeyRef}`).join('; ') || 'none'}`);
    return lines.join('\n');
  }
}

export function validateProviderDefV26(def: Omit<VoiceV26ProviderDef, 'health'> & { health?: number }): string[] {
  const errors: string[] = [];
  if (!def.id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(def.id)) {
    errors.push('id must be lowercase alphanumeric with dashes');
  }
  if (def.kind !== 'stt' && def.kind !== 'tts') errors.push('kind must be stt | tts');
  if (def.origin !== 'local' && def.origin !== 'system' && def.origin !== 'api-key' && def.origin !== 'mock') {
    errors.push('origin must be local | system | api-key | mock');
  }
  if (!def.name || def.name.length > 120) errors.push('name must be 1..120 chars');
  if (!def.model || def.model.length > 120) errors.push('model must be 1..120 chars');
  if (!Array.isArray(def.languages) || def.languages.length === 0) errors.push('languages must be a non-empty array');
  if (!Array.isArray(def.voices)) errors.push('voices must be an array');
  if (def.kind === 'stt' && def.voices.length > 0) errors.push('STT providers must not list voices');
  if (def.origin === 'api-key' && !def.vaultKeyRef) errors.push('api-key providers need a vaultKeyRef (name only)');
  if (def.origin !== 'api-key' && def.vaultKeyRef) errors.push('only api-key providers may carry a vaultKeyRef');
  if (!(def.maxInput > 0 && def.maxInput <= 1000000)) errors.push('maxInput must be 1..1000000');
  if (def.health !== undefined && !(def.health >= 0 && def.health <= 100)) errors.push('health must be 0..100');
  return errors;
}
