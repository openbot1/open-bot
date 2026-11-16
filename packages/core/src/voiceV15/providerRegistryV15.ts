/**
 * Provider registry v2 (v1.16, Đội T5 — voice v15).
 *
 * v13/v14 shipped a fixed set of providers (Deepgram, Cartesia,
 * Whisper local, Pocket TTS, realtime-api, mock) with a pick-by-goal
 * scorer. v15 turns that into a *plugin interface*: a new STT, TTS
 * or S2S provider registers at runtime — from the app, from a
 * plugin, from a test — without touching this file, and the session
 * picks by goal (latency / quality / cost) across everything that
 * is registered and healthy.
 *
 * A plugin is a descriptor, not a class: the registry never calls a
 * provider itself (no network, no key). Each descriptor carries:
 *
 *   - `kind` (stt | tts | s2s), `id` (unique), `label`, languages,
 *     streaming support, sample rates;
 *   - measured / claimed latency (ms to first partial for STT,
 *     ms to first audio for TTS, ms end-to-end for S2S);
 *   - cost per minute (0 = local / free) and a quality score 0..1;
 *   - an optional `health` probe the host supplies (sync or async,
 *     e.g. "binary present" / "key in Vault") — unhealthy providers
 *     are excluded from picks but stay listed, with the reason;
 *   - `create` is intentionally absent: the host keeps the factory
 *     and binds it to a session; the registry only *selects*.
 *
 * Scoring is a weighted sum over normalised latency, quality and
 * cost, with the weights set by the goal. Ties break on lower
 * latency, then on id (deterministic). `pickPair` chooses the best
 * STT + TTS pair for one goal — the combination the pipeline
 * actually runs — and `estimateHourlyCost` prices it.
 */

export type VoiceProviderKindV15 = 'stt' | 'tts' | 's2s';
export const VOICE_PROVIDER_V15_KINDS: readonly VoiceProviderKindV15[] = ['stt', 'tts', 's2s'];

export type VoiceProviderGoalV15 = 'latency' | 'quality' | 'cost' | 'balanced';
export const VOICE_PROVIDER_V15_GOALS: readonly VoiceProviderGoalV15[] = ['latency', 'quality', 'cost', 'balanced'];

export function isVoiceProviderKindV15(value: unknown): value is VoiceProviderKindV15 {
  return typeof value === 'string' && (VOICE_PROVIDER_V15_KINDS as readonly string[]).includes(value);
}

export function isVoiceProviderGoalV15(value: unknown): value is VoiceProviderGoalV15 {
  return typeof value === 'string' && (VOICE_PROVIDER_V15_GOALS as readonly string[]).includes(value);
}

export interface VoiceProviderPluginV15 {
  kind: VoiceProviderKindV15;
  id: string;
  label: string;
  /** BCP-47 tags the provider can handle (e.g. ['vi', 'en']). */
  languages: string[];
  streaming: boolean;
  /** Sample rates the provider accepts (Hz). */
  sampleRatesHz: number[];
  /** ms to first partial (STT) / first audio (TTS) / end-to-end (S2S). */
  latencyMs: number;
  /** USD per minute of audio; 0 = local / free. */
  costPerMinuteUsd: number;
  /** 0..1 subjective quality. */
  quality: number;
  /** True when the provider needs a user key (Vault-gated). */
  requiresKey: boolean;
  /**
   * Optional health probe supplied by the host. Return `{ ok: true }`
   * when usable, `{ ok: false, reason }` when not (missing binary,
   * missing key, …). No probe = assumed healthy.
   */
  health?: () => { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
}

export function validateVoiceProviderPluginV15(plugin: VoiceProviderPluginV15): string[] {
  const errors: string[] = [];
  if (!isVoiceProviderKindV15(plugin.kind)) errors.push(`unknown kind: ${String(plugin.kind)}`);
  if (!plugin.id.trim()) errors.push('id must not be empty');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin.id)) errors.push('id must be lowercase kebab-case (letters, digits, dashes)');
  if (!plugin.label.trim()) errors.push('label must not be empty');
  if (plugin.languages.length === 0) errors.push('languages must not be empty');
  for (const lang of plugin.languages) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) errors.push(`language must look like a BCP-47 tag, got ${lang}`);
  }
  if (plugin.sampleRatesHz.length === 0) errors.push('sampleRatesHz must not be empty');
  if (plugin.latencyMs < 0 || !Number.isFinite(plugin.latencyMs)) errors.push('latencyMs must be >= 0');
  if (plugin.costPerMinuteUsd < 0 || !Number.isFinite(plugin.costPerMinuteUsd)) errors.push('costPerMinuteUsd must be >= 0');
  if (plugin.quality < 0 || plugin.quality > 1) errors.push('quality must be 0..1');
  return errors;
}

export interface VoiceProviderScoreV15 {
  plugin: VoiceProviderPluginV15;
  score: number;
  latencyScore: number;
  qualityScore: number;
  costScore: number;
  healthy: boolean;
  healthReason: string | undefined;
}

export interface VoiceProviderPickOptionsV15 {
  goal?: VoiceProviderGoalV15;
  language?: string;
  streamingOnly?: boolean;
  maxCostPerMinuteUsd?: number;
  /** Only providers whose id is in this list (allow-list). */
  allowIds?: string[];
}

export function goalWeightsV15(goal: VoiceProviderGoalV15): { latency: number; quality: number; cost: number } {
  switch (goal) {
    case 'latency': return { latency: 0.6, quality: 0.25, cost: 0.15 };
    case 'quality': return { latency: 0.2, quality: 0.6, cost: 0.2 };
    case 'cost': return { latency: 0.2, quality: 0.2, cost: 0.6 };
    case 'balanced': default: return { latency: 0.35, quality: 0.35, cost: 0.3 };
  }
}

export function scoreVoiceProviderV15(
  plugin: VoiceProviderPluginV15,
  goal: VoiceProviderGoalV15,
  healthy: boolean,
  healthReason?: string,
): VoiceProviderScoreV15 {
  const weights = goalWeightsV15(goal);
  // Normalise latency: 0 ms → 1, 2000+ ms → 0 (log-ish, clamped).
  const latencyScore = Math.max(0, 1 - plugin.latencyMs / 2000);
  const qualityScore = plugin.quality;
  // Cost: free → 1, $0.10+/min → 0.
  const costScore = Math.max(0, 1 - plugin.costPerMinuteUsd / 0.1);
  const score = healthy
    ? weights.latency * latencyScore + weights.quality * qualityScore + weights.cost * costScore
    : 0;
  return { plugin, score, latencyScore, qualityScore, costScore, healthy, healthReason };
}

export function mockSttPluginV15(): VoiceProviderPluginV15 {
  return {
    kind: 'stt',
    id: 'mock-stt',
    label: 'Mock STT',
    languages: ['vi', 'en'],
    streaming: true,
    sampleRatesHz: [16000, 24000],
    latencyMs: 50,
    costPerMinuteUsd: 0,
    quality: 0.5,
    requiresKey: false,
  };
}

export function mockTtsPluginV15(): VoiceProviderPluginV15 {
  return {
    kind: 'tts',
    id: 'mock-tts',
    label: 'Mock TTS',
    languages: ['vi', 'en'],
    streaming: true,
    sampleRatesHz: [24000],
    latencyMs: 60,
    costPerMinuteUsd: 0,
    quality: 0.5,
    requiresKey: false,
  };
}

export function mockS2SPluginV15(): VoiceProviderPluginV15 {
  return {
    kind: 's2s',
    id: 'mock-s2s',
    label: 'Mock speech-to-speech',
    languages: ['vi', 'en'],
    streaming: true,
    sampleRatesHz: [24000],
    latencyMs: 300,
    costPerMinuteUsd: 0,
    quality: 0.6,
    requiresKey: false,
  };
}

export interface VoiceProviderPairV15 {
  stt: VoiceProviderScoreV15 | undefined;
  tts: VoiceProviderScoreV15 | undefined;
  combinedLatencyMs: number;
  hourlyCostUsd: number;
}

export class VoiceProviderRegistryV15 {
  private readonly plugins = new Map<string, VoiceProviderPluginV15>();
  private readonly healthCache = new Map<string, { ok: boolean; reason?: string }>();

  constructor(seedMocks = true) {
    if (seedMocks) {
      this.register(mockSttPluginV15());
      this.register(mockTtsPluginV15());
      this.register(mockS2SPluginV15());
    }
  }

  register(plugin: VoiceProviderPluginV15): void {
    const errors = validateVoiceProviderPluginV15(plugin);
    if (errors.length > 0) throw new Error(`invalid voice provider plugin: ${errors.join('; ')}`);
    if (this.plugins.has(plugin.id)) throw new Error(`voice provider already registered: ${plugin.id}`);
    this.plugins.set(plugin.id, { ...plugin });
    this.healthCache.delete(plugin.id);
  }

  unregister(id: string): boolean {
    this.healthCache.delete(id);
    return this.plugins.delete(id);
  }

  get(id: string): VoiceProviderPluginV15 | undefined {
    return this.plugins.get(id);
  }

  list(kind?: VoiceProviderKindV15): VoiceProviderPluginV15[] {
    const all = [...this.plugins.values()];
    const filtered = kind ? all.filter((p) => p.kind === kind) : all;
    return filtered.sort((a, b) => a.id.localeCompare(b.id));
  }

  count(): number {
    return this.plugins.size;
  }

  /** Run health probes (async probes awaited); call before picking. */
  async refreshHealth(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (!plugin.health) {
        this.healthCache.set(plugin.id, { ok: true });
        continue;
      }
      try {
        const result = await plugin.health();
        this.healthCache.set(plugin.id, result);
      } catch (err) {
        this.healthCache.set(plugin.id, { ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  healthOf(id: string): { ok: boolean; reason?: string } {
    return this.healthCache.get(id) ?? { ok: true };
  }

  scoreAll(kind: VoiceProviderKindV15, options: VoiceProviderPickOptionsV15 = {}): VoiceProviderScoreV15[] {
    const goal = options.goal ?? 'balanced';
    const candidates = this.list(kind).filter((p) => {
      if (options.language && !p.languages.includes(options.language)) return false;
      if (options.streamingOnly && !p.streaming) return false;
      if (options.maxCostPerMinuteUsd !== undefined && p.costPerMinuteUsd > options.maxCostPerMinuteUsd) return false;
      if (options.allowIds && !options.allowIds.includes(p.id)) return false;
      return true;
    });
    const scored = candidates.map((p) => {
      const health = this.healthOf(p.id);
      return scoreVoiceProviderV15(p, goal, health.ok, health.reason);
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.plugin.latencyMs !== b.plugin.latencyMs) return a.plugin.latencyMs - b.plugin.latencyMs;
      return a.plugin.id.localeCompare(b.plugin.id);
    });
    return scored;
  }

  pick(kind: VoiceProviderKindV15, options: VoiceProviderPickOptionsV15 = {}): VoiceProviderScoreV15 | undefined {
    const scored = this.scoreAll(kind, options);
    return scored.find((s) => s.healthy);
  }

  pickPair(options: VoiceProviderPickOptionsV15 = {}): VoiceProviderPairV15 {
    const stt = this.pick('stt', options);
    const tts = this.pick('tts', options);
    const combinedLatencyMs = (stt?.plugin.latencyMs ?? 0) + (tts?.plugin.latencyMs ?? 0);
    const hourlyCostUsd = ((stt?.plugin.costPerMinuteUsd ?? 0) + (tts?.plugin.costPerMinuteUsd ?? 0)) * 60;
    return { stt, tts, combinedLatencyMs, hourlyCostUsd };
  }

  summary(): string {
    const kinds = VOICE_PROVIDER_V15_KINDS.map((k) => `${k}=${this.list(k).length}`).join(', ');
    return `provider registry v15: ${this.count()} providers (${kinds})`;
  }

  markdown(): string {
    const lines = ['## Voice provider registry v15', '', `- Providers: ${this.count()}`, '', '| ID | Kind | Languages | Streaming | Latency | Cost/min | Quality | Key? | Healthy |', '| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |'];
    for (const plugin of this.list()) {
      const health = this.healthOf(plugin.id);
      lines.push(
        `| ${plugin.id} | ${plugin.kind} | ${plugin.languages.join(', ')} | ${plugin.streaming ? 'yes' : 'no'} | ` +
        `${plugin.latencyMs} ms | $${plugin.costPerMinuteUsd.toFixed(4)} | ${plugin.quality.toFixed(2)} | ` +
        `${plugin.requiresKey ? 'yes' : 'no'} | ${health.ok ? 'yes' : `no (${health.reason ?? '?'})`} |`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }
}

export function createVoiceProviderRegistryV15(seedMocks = true): VoiceProviderRegistryV15 {
  return new VoiceProviderRegistryV15(seedMocks);
}

export function estimateVoiceProviderHourlyCostV15(pair: VoiceProviderPairV15): number {
  return pair.hourlyCostUsd;
}

export function voiceProviderRegistryV15Summary(registry: VoiceProviderRegistryV15): string {
  return registry.summary();
}

export function voiceProviderRegistryV15Markdown(registry: VoiceProviderRegistryV15): string {
  return registry.markdown();
}
