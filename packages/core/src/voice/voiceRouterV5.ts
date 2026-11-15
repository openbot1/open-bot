/**
 * Multi-model voice router (v1.06, Đội T4 — voice realtime v5).
 *
 * One voice call needs three different models — STT, TTS and the
 * realtime model itself — and the "best" one depends on the call:
 * the language being spoken, how much latency the user tolerates,
 * how much the run may cost, and whether a key / local binary is
 * even available on this machine. The router answers that question
 * deterministically (same request + same availability = same route)
 * and always returns an ordered fallback chain, so a failing primary
 * can be replaced without asking the user again.
 *
 * What lives here:
 *
 *   - `VOICE_V5_MODEL_CATALOG` — the known STT / TTS / realtime
 *     models: provider, languages, latency class + estimate,
 *     relative cost tier (0 = local/free, 3 = most expensive),
 *     whether a key is needed. Local models (whisper.cpp, Piper,
 *     system TTS, mock) cost 0 and need no key.
 *   - `routeVoiceRequest(req, availability)` — pure scoring:
 *     language match first, then latency budget, then cost cap,
 *     then availability; ties break by model id so the result is
 *     stable. Returns one route per lane (primary + fallbacks +
 *     a human-readable reason).
 *   - `VoiceModelHealth` — per-model failure tracking with
 *     exponential cooldown: a model that just failed is skipped
 *     until its cooldown expires; a success clears it.
 *   - `VoiceRouterV5` — the stateful router: per-bot config
 *     overrides (a bot may pin its STT/TTS/realtime model, its
 *     latency class, its cost cap or its local-first preference),
 *     routing with the bot's config applied, and
 *     `routeWithFallback` — try the candidates in order with a
 *     caller-supplied attempt function and report every attempt.
 *   - `estimateVoiceCost` — rough relative-cost estimate for a
 *     route (cost units per minute, not money — providers price
 *     differently; the number only compares routes).
 *   - `voiceRouteReportMarkdown` — a short report of a route for
 *     the agent / UI.
 *
 * No network, no key, no microphone. Availability is an input
 * (`VoiceModelAvailability`: which providers have a key, which
 * local binaries were detected); the caller (key gate, local
 * engine probe) supplies it. Tests use the mock catalog entries
 * and explicit availability maps.
 */

export type VoiceModelLane = 'stt' | 'tts' | 'realtime';
export type VoiceLatencyClass = 'low' | 'balanced' | 'quality';

/** Latency classes, cheapest-first for the scorer. */
export const VOICE_V5_LATENCY_CLASSES: readonly VoiceLatencyClass[] = [
  'low',
  'balanced',
  'quality',
];

/** One model the router may pick, for one lane. */
export interface VoiceModelDescriptor {
  /** Stable id, e.g. `whisper-local-base`. */
  id: string;
  lane: VoiceModelLane;
  /** Provider key, e.g. `local`, `openai`, `gemini`. */
  provider: string;
  /** BCP 47 languages the model handles (`*` = any language). */
  languages: readonly string[];
  latencyClass: VoiceLatencyClass;
  /** Rough end-to-end latency for this model (ms). */
  latencyMsEstimate: number;
  /** Relative cost tier: 0 = local/free, 3 = most expensive. */
  costTier: 0 | 1 | 2 | 3;
  /** True when calling it needs an API key. */
  requiresKey: boolean;
  /** Human note (shown in the route reason). */
  note: string;
}

/**
 * The known model catalog. Prices and model names drift over time;
 * the router only needs relative tiers, and the catalog is data —
 * add a model by appending one descriptor, no code change.
 */
export const VOICE_V5_MODEL_CATALOG: readonly VoiceModelDescriptor[] = [
  // --- STT ---
  {
    id: 'whisper-local-tiny',
    lane: 'stt',
    provider: 'local',
    languages: ['*'],
    latencyClass: 'low',
    latencyMsEstimate: 120,
    costTier: 0,
    requiresKey: false,
    note: 'Local whisper.cpp tiny — fastest local STT, lowest accuracy.',
  },
  {
    id: 'whisper-local-base',
    lane: 'stt',
    provider: 'local',
    languages: ['*'],
    latencyClass: 'balanced',
    latencyMsEstimate: 250,
    costTier: 0,
    requiresKey: false,
    note: 'Local whisper.cpp base — good balance for on-device STT.',
  },
  {
    id: 'whisper-local-large',
    lane: 'stt',
    provider: 'local',
    languages: ['*'],
    latencyClass: 'quality',
    latencyMsEstimate: 700,
    costTier: 0,
    requiresKey: false,
    note: 'Local whisper.cpp large — best local accuracy, slowest.',
  },
  {
    id: 'openai-whisper-1',
    lane: 'stt',
    provider: 'openai',
    languages: ['*'],
    latencyClass: 'balanced',
    latencyMsEstimate: 400,
    costTier: 1,
    requiresKey: true,
    note: 'OpenAI Whisper API — strong multilingual accuracy.',
  },
  {
    id: 'gemini-stt',
    lane: 'stt',
    provider: 'gemini',
    languages: ['*'],
    latencyClass: 'balanced',
    latencyMsEstimate: 450,
    costTier: 1,
    requiresKey: true,
    note: 'Gemini speech-to-text — strong multilingual accuracy.',
  },
  {
    id: 'deepgram-nova-2',
    lane: 'stt',
    provider: 'deepgram',
    languages: ['en', 'es', 'fr', 'de', 'ja', 'zh', 'pt', 'it', 'nl', 'sv'],
    latencyClass: 'low',
    latencyMsEstimate: 150,
    costTier: 2,
    requiresKey: true,
    note: 'Deepgram Nova-2 streaming — very low latency, limited languages.',
  },
  {
    id: 'mock-stt',
    lane: 'stt',
    provider: 'mock',
    languages: ['*'],
    latencyClass: 'low',
    latencyMsEstimate: 10,
    costTier: 0,
    requiresKey: false,
    note: 'Mock STT for tests — returns canned text, never the network.',
  },
  // --- TTS ---
  {
    id: 'piper-local',
    lane: 'tts',
    provider: 'local',
    languages: ['en', 'vi', 'es', 'fr', 'de', 'ja', 'zh'],
    latencyClass: 'low',
    latencyMsEstimate: 150,
    costTier: 0,
    requiresKey: false,
    note: 'Local Piper TTS — fast, offline, per-language voices.',
  },
  {
    id: 'system-tts',
    lane: 'tts',
    provider: 'local',
    languages: ['*'],
    latencyClass: 'low',
    latencyMsEstimate: 100,
    costTier: 0,
    requiresKey: false,
    note: 'OS speech engine (espeak-ng / say / PowerShell) — always present.',
  },
  {
    id: 'openai-tts-1',
    lane: 'tts',
    provider: 'openai',
    languages: ['*'],
    latencyClass: 'balanced',
    latencyMsEstimate: 500,
    costTier: 1,
    requiresKey: true,
    note: 'OpenAI TTS-1 — natural voices, many languages.',
  },
  {
    id: 'openai-tts-1-hd',
    lane: 'tts',
    provider: 'openai',
    languages: ['*'],
    latencyClass: 'quality',
    latencyMsEstimate: 900,
    costTier: 2,
    requiresKey: true,
    note: 'OpenAI TTS-1-HD — highest voice quality, slowest.',
  },
  {
    id: 'gemini-tts',
    lane: 'tts',
    provider: 'gemini',
    languages: ['*'],
    latencyClass: 'balanced',
    latencyMsEstimate: 550,
    costTier: 1,
    requiresKey: true,
    note: 'Gemini TTS — natural voices, many languages.',
  },
  {
    id: 'elevenlabs-v3',
    lane: 'tts',
    provider: 'elevenlabs',
    languages: ['en', 'es', 'fr', 'de', 'ja', 'zh', 'vi', 'pt', 'it'],
    latencyClass: 'quality',
    latencyMsEstimate: 800,
    costTier: 3,
    requiresKey: true,
    note: 'ElevenLabs v3 — most expressive voices, highest cost.',
  },
  {
    id: 'mock-tts',
    lane: 'tts',
    provider: 'mock',
    languages: ['*'],
    latencyClass: 'low',
    latencyMsEstimate: 10,
    costTier: 0,
    requiresKey: false,
    note: 'Mock TTS for tests — records text, plays nothing.',
  },
  // --- realtime (full duplex voice model) ---
  {
    id: 'openai-realtime-mini',
    lane: 'realtime',
    provider: 'openai',
    languages: ['*'],
    latencyClass: 'low',
    latencyMsEstimate: 350,
    costTier: 2,
    requiresKey: true,
    note: 'OpenAI realtime mini — lowest-latency realtime model.',
  },
  {
    id: 'openai-realtime',
    lane: 'realtime',
    provider: 'openai',
    languages: ['*'],
    latencyClass: 'balanced',
    latencyMsEstimate: 500,
    costTier: 3,
    requiresKey: true,
    note: 'OpenAI realtime — full-quality realtime voice.',
  },
  {
    id: 'gemini-live-flash',
    lane: 'realtime',
    provider: 'gemini',
    languages: ['*'],
    latencyClass: 'low',
    latencyMsEstimate: 400,
    costTier: 2,
    requiresKey: true,
    note: 'Gemini Live flash — low-latency live voice.',
  },
  {
    id: 'gemini-live-pro',
    lane: 'realtime',
    provider: 'gemini',
    languages: ['*'],
    latencyClass: 'quality',
    latencyMsEstimate: 700,
    costTier: 3,
    requiresKey: true,
    note: 'Gemini Live pro — best live quality, highest cost.',
  },
  {
    id: 'mock-realtime',
    lane: 'realtime',
    provider: 'mock',
    languages: ['*'],
    latencyClass: 'low',
    latencyMsEstimate: 10,
    costTier: 0,
    requiresKey: false,
    note: 'Mock realtime transport for tests — no key, no network.',
  },
];

/** Which models are usable right now (keys present, binaries found). */
export interface VoiceModelAvailability {
  /** Providers with a usable key (`openai`, `gemini`, ...). */
  providersWithKey?: readonly string[];
  /** Local model ids detected on this machine (whisper binary, Piper...). */
  localModelsAvailable?: readonly string[];
  /** Model ids the host forces unavailable (broken install, user-disabled). */
  disabledModelIds?: readonly string[];
}

/** One routing request: what the call needs. */
export interface VoiceRouteRequest {
  /** BCP 47 language of the call (`vi`, `en`, `vi-VN`...). Default: `en`. */
  language?: string;
  /** Latency class the user asked for. Default: `balanced`. */
  latencyClass?: VoiceLatencyClass;
  /** Hard latency ceiling (ms) — models slower than this are
   *  demoted hard (only used when nothing faster fits). */
  maxLatencyMs?: number;
  /** Hard cost ceiling (tier 0..3). Models above it are excluded
   *  unless nothing else fits at all. */
  maxCostTier?: 0 | 1 | 2 | 3;
  /** Prefer local/free models when they are close enough. */
  preferLocal?: boolean;
  /** Only consider these lanes (default: all three). */
  lanes?: readonly VoiceModelLane[];
}

/** One lane of a route: primary + ordered fallbacks + why. */
export interface VoiceLaneRoute {
  lane: VoiceModelLane;
  primary: VoiceModelDescriptor;
  /** Fallbacks in try order (primary excluded). */
  fallbacks: VoiceModelDescriptor[];
  /** Human-readable reason for the primary pick. */
  reason: string;
}

/** A full route: one lane route per requested lane. */
export interface VoiceRoute {
  language: string;
  latencyClass: VoiceLatencyClass;
  lanes: VoiceLaneRoute[];
  /** True when any lane had to fall back to a model outside the
   *  requested latency/cost budget (nothing inside it fit). */
  usedOutOfBudget: boolean;
}

/** Per-bot router overrides (stored by `VoiceRouterV5`). */
export interface VoiceBotRouterConfig {
  botId: string;
  sttModel?: string;
  ttsModel?: string;
  realtimeModel?: string;
  latencyClass?: VoiceLatencyClass;
  maxCostTier?: 0 | 1 | 2 | 3;
  preferLocal?: boolean;
}

/** Validation result for a bot router config. */
export interface VoiceBotRouterConfigValidation {
  ok: boolean;
  errors: string[];
}

/** One fallback attempt (see `routeWithFallback`). */
export interface VoiceFallbackAttempt {
  modelId: string;
  ok: boolean;
  error?: string;
}

const LATENCY_CLASS_RANK: Record<VoiceLatencyClass, number> = {
  low: 0,
  balanced: 1,
  quality: 2,
};

/** Base language of a BCP 47 tag (`vi-VN` -> `vi`). */
export function baseLanguage(tag: string): string {
  return tag.trim().toLowerCase().split('-')[0] ?? '';
}

/**
 * Language fit score 0..1: 1 = exact tag or base match, 0.7 =
 * model covers the language family, 0.5 = wildcard `*`,
 * 0 = unsupported.
 */
export function languageFit(model: VoiceModelDescriptor, language: string): number {
  const wanted = language.trim().toLowerCase();
  const base = baseLanguage(wanted);
  if (model.languages.includes(wanted)) return 1;
  if (base && model.languages.includes(base)) return 1;
  if (model.languages.includes('*')) return 0.5;
  return 0;
}

export function isVoiceLatencyClass(value: unknown): value is VoiceLatencyClass {
  return (
    typeof value === 'string' &&
    (VOICE_V5_LATENCY_CLASSES as readonly string[]).includes(value)
  );
}

export function findVoiceModel(id: string): VoiceModelDescriptor | undefined {
  return VOICE_V5_MODEL_CATALOG.find((m) => m.id === id);
}

function modelAvailable(
  model: VoiceModelDescriptor,
  availability: VoiceModelAvailability | undefined,
): boolean {
  if (availability?.disabledModelIds?.includes(model.id)) return false;
  if (model.provider === 'mock') return true;
  if (model.provider === 'local') {
    const local = availability?.localModelsAvailable;
    // No probe data = assume local models exist (whisper.cpp /
    // Piper / system TTS are the local-first defaults); a probe
    // that lists locals restricts to that list.
    if (!local) return true;
    return local.includes(model.id);
  }
  if (model.requiresKey) {
    return availability?.providersWithKey?.includes(model.provider) ?? false;
  }
  return true;
}

/**
 * Score one model for one request. Higher is better. The score is
 * a weighted sum, so the ranking stays stable and explainable:
 * language (x100) > latency class fit (x40) > latency estimate
 * (x20, relative) > cost (x15) > local preference (x10).
 * Models that violate a hard budget lose 1000 (they still rank,
 * so the router can report "nothing in budget fit" instead of
 * failing outright).
 */
export function scoreVoiceModel(
  model: VoiceModelDescriptor,
  req: VoiceRouteRequest,
  availability?: VoiceModelAvailability,
): number {
  const language = req.language ?? 'en';
  const wantedClass = req.latencyClass ?? 'balanced';
  const fit = languageFit(model, language);
  if (fit === 0) return -10000;
  let score = fit * 100;
  // Latency class: exact class wins; a faster model is fine for a
  // slower request, a slower model is penalised.
  const classDiff = LATENCY_CLASS_RANK[model.latencyClass] - LATENCY_CLASS_RANK[wantedClass];
  score += classDiff === 0 ? 40 : classDiff < 0 ? 25 : 40 - classDiff * 20;
  // Latency estimate: faster is better, normalised to 0..20.
  score += Math.max(0, 20 - model.latencyMsEstimate / 50);
  // Cost: cheaper is better (0..15).
  score += (3 - model.costTier) * 5;
  if (req.preferLocal && model.provider === 'local') score += 10;
  if (req.preferLocal && model.provider === 'mock') score += 5;
  // Hard budgets: heavy penalty, not exclusion — the route still
  // returns something and flags `usedOutOfBudget`.
  if (req.maxLatencyMs !== undefined && model.latencyMsEstimate > req.maxLatencyMs) {
    score -= 1000;
  }
  if (req.maxCostTier !== undefined && model.costTier > req.maxCostTier) {
    score -= 1000;
  }
  if (!modelAvailable(model, availability)) score -= 1000;
  return score;
}

/**
 * Route one request: one lane route per requested lane. Pure and
 * deterministic — same request + availability = same route.
 * Every lane always returns a primary (the best-scoring model,
 * even when it is out of budget / unavailable) plus the remaining
 * models in score order as fallbacks.
 */
export function routeVoiceRequest(
  req: VoiceRouteRequest = {},
  availability?: VoiceModelAvailability,
  catalog: readonly VoiceModelDescriptor[] = VOICE_V5_MODEL_CATALOG,
): VoiceRoute {
  const language = req.language ?? 'en';
  const latencyClass = req.latencyClass ?? 'balanced';
  const lanes = req.lanes ?? (['stt', 'tts', 'realtime'] as const);
  const laneRoutes: VoiceLaneRoute[] = [];
  let usedOutOfBudget = false;
  for (const lane of lanes) {
    const candidates = catalog
      .filter((m) => m.lane === lane)
      .map((m) => ({ model: m, score: scoreVoiceModel(m, req, availability) }))
      .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
    if (candidates.length === 0) continue;
    const primary = candidates[0] as { model: VoiceModelDescriptor; score: number };
    const inBudget =
      (req.maxLatencyMs === undefined ||
        primary.model.latencyMsEstimate <= req.maxLatencyMs) &&
      (req.maxCostTier === undefined || primary.model.costTier <= req.maxCostTier) &&
      modelAvailable(primary.model, availability);
    if (!inBudget) usedOutOfBudget = true;
    const reasons: string[] = [];
    if (languageFit(primary.model, language) === 1) {
      reasons.push(`supports ${language}`);
    } else {
      reasons.push(`covers any language (no ${language}-specific model)`);
    }
    reasons.push(`${primary.model.latencyClass} latency (~${primary.model.latencyMsEstimate}ms)`);
    reasons.push(primary.model.costTier === 0 ? 'free/local' : `cost tier ${primary.model.costTier}`);
    if (!modelAvailable(primary.model, availability)) {
      reasons.push('best available even though it is currently unavailable');
    }
    laneRoutes.push({
      lane,
      primary: primary.model,
      fallbacks: candidates.slice(1).map((c) => c.model),
      reason: reasons.join('; '),
    });
  }
  return { language, latencyClass, lanes: laneRoutes, usedOutOfBudget };
}

/** Validate a per-bot router config (unknown model ids rejected). */
export function validateVoiceBotRouterConfig(
  config: Partial<VoiceBotRouterConfig> & { botId: string },
): VoiceBotRouterConfigValidation {
  const errors: string[] = [];
  if (!config.botId || typeof config.botId !== 'string' || config.botId.trim() === '') {
    errors.push('botId must be a non-empty string.');
  }
  const checkModel = (id: string | undefined, lane: VoiceModelLane, field: string): void => {
    if (id === undefined) return;
    const found = findVoiceModel(id);
    if (!found) errors.push(`${field}: unknown voice model "${id}".`);
    else if (found.lane !== lane) {
      errors.push(`${field}: model "${id}" is a ${found.lane} model, not ${lane}.`);
    }
  };
  checkModel(config.sttModel, 'stt', 'sttModel');
  checkModel(config.ttsModel, 'tts', 'ttsModel');
  checkModel(config.realtimeModel, 'realtime', 'realtimeModel');
  if (config.latencyClass !== undefined && !isVoiceLatencyClass(config.latencyClass)) {
    errors.push(`latencyClass must be one of ${VOICE_V5_LATENCY_CLASSES.join(', ')}.`);
  }
  if (
    config.maxCostTier !== undefined &&
    (!Number.isInteger(config.maxCostTier) || config.maxCostTier < 0 || config.maxCostTier > 3)
  ) {
    errors.push('maxCostTier must be an integer 0..3.');
  }
  return { ok: errors.length === 0, errors };
}

/** Cooldown base (ms) after a model failure; doubles per failure. */
export const VOICE_V5_HEALTH_BASE_COOLDOWN_MS = 30_000;
/** Cooldown ceiling (ms). */
export const VOICE_V5_HEALTH_MAX_COOLDOWN_MS = 600_000;

/**
 * Per-model failure tracking. A model that fails gets a cooldown
 * (30s, doubling per consecutive failure, capped at 10 min);
 * routing skips models on cooldown. A success clears the record.
 */
export class VoiceModelHealth {
  private readonly failures = new Map<string, { count: number; cooldownUntil: number }>();

  recordFailure(modelId: string, nowMs = Date.now()): void {
    const prev = this.failures.get(modelId);
    const count = (prev?.count ?? 0) + 1;
    const cooldown =
      Math.min(
        VOICE_V5_HEALTH_BASE_COOLDOWN_MS * 2 ** (count - 1),
        VOICE_V5_HEALTH_MAX_COOLDOWN_MS,
      ) || VOICE_V5_HEALTH_BASE_COOLDOWN_MS;
    this.failures.set(modelId, { count, cooldownUntil: nowMs + cooldown });
  }

  recordSuccess(modelId: string): void {
    this.failures.delete(modelId);
  }

  isHealthy(modelId: string, nowMs = Date.now()): boolean {
    const rec = this.failures.get(modelId);
    if (!rec) return true;
    if (nowMs >= rec.cooldownUntil) {
      this.failures.delete(modelId);
      return true;
    }
    return false;
  }

  /** Consecutive failures for a model (0 when healthy/unknown). */
  failureCount(modelId: string): number {
    return this.failures.get(modelId)?.count ?? 0;
  }

  /** ms until a model is healthy again (0 when healthy). */
  cooldownRemainingMs(modelId: string, nowMs = Date.now()): number {
    const rec = this.failures.get(modelId);
    if (!rec) return 0;
    return Math.max(0, rec.cooldownUntil - nowMs);
  }

  reset(): void {
    this.failures.clear();
  }
}

/** Options for `VoiceRouterV5`. */
export interface VoiceRouterV5Options {
  catalog?: readonly VoiceModelDescriptor[];
  /** Clock override for tests (ms since epoch). */
  now?: () => number;
}

/**
 * Stateful voice router: per-bot config overrides + health-aware
 * routing + ordered fallback attempts.
 *
 * A bot config pins models per lane; a pinned model is used as the
 * primary even when it scores lower (the user asked for it), and
 * the rest of the lane still ranks behind it as fallbacks. Health
 * still applies: a pinned model on cooldown falls to the next
 * candidate, and the route says so.
 */
export class VoiceRouterV5 {
  private readonly catalog: readonly VoiceModelDescriptor[];
  private readonly health = new VoiceModelHealth();
  private readonly botConfigs = new Map<string, VoiceBotRouterConfig>();
  private readonly now: () => number;

  constructor(options: VoiceRouterV5Options = {}) {
    this.catalog = options.catalog ?? VOICE_V5_MODEL_CATALOG;
    this.now = options.now ?? Date.now;
  }

  getHealth(): VoiceModelHealth {
    return this.health;
  }

  /** Store a bot's router config (validated first; throws on error). */
  setBotConfig(config: VoiceBotRouterConfig): void {
    const check = validateVoiceBotRouterConfig(config);
    if (!check.ok) {
      throw new Error(`Invalid voice router config for bot "${config.botId}": ${check.errors.join(' ')}`);
    }
    this.botConfigs.set(config.botId, { ...config });
  }

  getBotConfig(botId: string): VoiceBotRouterConfig | undefined {
    const found = this.botConfigs.get(botId);
    return found ? { ...found } : undefined;
  }

  resetBotConfig(botId: string): boolean {
    return this.botConfigs.delete(botId);
  }

  listBotConfigs(): VoiceBotRouterConfig[] {
    return [...this.botConfigs.values()].map((c) => ({ ...c }));
  }

  recordFailure(modelId: string): void {
    this.health.recordFailure(modelId, this.now());
  }

  recordSuccess(modelId: string): void {
    this.health.recordSuccess(modelId);
  }

  /**
   * Route for a bot: the bot's config (latency class, cost cap,
   * local preference, pinned models) is merged over the request,
   * then scored. Pinned models lead their lane; models on
   * cooldown are demoted to the end of the fallback list.
   */
  routeForBot(botId: string, req: VoiceRouteRequest = {}, availability?: VoiceModelAvailability): VoiceRoute {
    const cfg = this.botConfigs.get(botId);
    const merged: VoiceRouteRequest = {
      ...req,
      latencyClass: req.latencyClass ?? cfg?.latencyClass ?? 'balanced',
      maxCostTier: req.maxCostTier ?? cfg?.maxCostTier,
      preferLocal: req.preferLocal ?? cfg?.preferLocal ?? false,
    };
    const route = routeVoiceRequest(merged, availability, this.catalog);
    if (!cfg) return this.applyHealth(route);
    const pinned: Partial<Record<VoiceModelLane, string>> = {
      stt: cfg.sttModel,
      tts: cfg.ttsModel,
      realtime: cfg.realtimeModel,
    };
    for (const laneRoute of route.lanes) {
      const pinId = pinned[laneRoute.lane];
      if (!pinId) continue;
      const pinnedModel = this.catalog.find((m) => m.id === pinId);
      if (!pinnedModel) continue;
      laneRoute.fallbacks = [
        laneRoute.primary,
        ...laneRoute.fallbacks.filter((m) => m.id !== pinId),
      ];
      laneRoute.primary = pinnedModel;
      laneRoute.reason = `pinned by bot config; ${laneRoute.reason}`;
    }
    return this.applyHealth(route);
  }

  /** Plain route without a bot (same scoring, health applied). */
  route(req: VoiceRouteRequest = {}, availability?: VoiceModelAvailability): VoiceRoute {
    return this.applyHealth(routeVoiceRequest(req, availability, this.catalog));
  }

  /**
   * Try candidates in order with `attempt` until one succeeds.
   * The first success is recorded healthy; every failure is
   * recorded (cooldown) and reported. Never throws — a total
   * failure returns `modelId: null` plus the attempt log.
   */
  async routeWithFallback<T>(
    candidates: readonly VoiceModelDescriptor[],
    attempt: (model: VoiceModelDescriptor) => Promise<T>,
  ): Promise<{ modelId: string | null; result: T | null; attempts: VoiceFallbackAttempt[] }> {
    const attempts: VoiceFallbackAttempt[] = [];
    for (const model of candidates) {
      try {
        const result = await attempt(model);
        this.health.recordSuccess(model.id);
        attempts.push({ modelId: model.id, ok: true });
        return { modelId: model.id, result, attempts };
      } catch (err) {
        this.health.recordFailure(model.id);
        attempts.push({
          modelId: model.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { modelId: null, result: null, attempts };
  }

  /** Demote on-cooldown models to the end of each lane's list. */
  private applyHealth(route: VoiceRoute): VoiceRoute {
    const now = this.now();
    for (const laneRoute of route.lanes) {
      const all = [laneRoute.primary, ...laneRoute.fallbacks];
      const healthy = all.filter((m) => this.health.isHealthy(m.id, now));
      const sick = all.filter((m) => !this.health.isHealthy(m.id, now));
      if (healthy.length === 0 || sick.length === 0) continue;
      const [primary, ...rest] = healthy;
      laneRoute.primary = primary as VoiceModelDescriptor;
      laneRoute.fallbacks = [...rest, ...sick];
      laneRoute.reason += '; previous primary on cooldown, promoted next healthy model';
    }
    return route;
  }
}

/**
 * Rough relative-cost estimate for a route: cost units per minute
 * of talking. Lane weights reflect how much of a call each lane
 * does (realtime dominates). Local/mock models cost 0. This is
 * for comparing routes, not for billing — providers price in
 * real money per token/minute.
 */
export function estimateVoiceCost(route: VoiceRoute, minutes: number): {
  totalUnits: number;
  perLane: Array<{ lane: VoiceModelLane; modelId: string; units: number }>;
} {
  const weights: Record<VoiceModelLane, number> = { stt: 1, tts: 1, realtime: 3 };
  const perLane = route.lanes.map((lane) => ({
    lane: lane.lane,
    modelId: lane.primary.id,
    units: lane.primary.costTier * weights[lane.lane] * minutes,
  }));
  return { totalUnits: perLane.reduce((sum, l) => sum + l.units, 0), perLane };
}

/** Short markdown report of a route (agent answer / UI panel). */
export function voiceRouteReportMarkdown(route: VoiceRoute, costMinutes = 1): string {
  const lines: string[] = [
    `## Voice route (${route.language}, ${route.latencyClass})`,
    '',
  ];
  for (const lane of route.lanes) {
    lines.push(
      `- **${lane.lane}**: \`${lane.primary.id}\` (${lane.primary.provider}) — ${lane.reason}.`,
    );
    if (lane.fallbacks.length > 0) {
      lines.push(`  Fallbacks: ${lane.fallbacks.map((m) => `\`${m.id}\``).join(' → ')}.`);
    }
  }
  if (route.usedOutOfBudget) {
    lines.push('', '> No model inside the requested latency/cost budget fit; the route above is the closest available.');
  }
  const cost = estimateVoiceCost(route, costMinutes);
  lines.push('', `Estimated relative cost: **${cost.totalUnits} units** per ${costMinutes} min (0 = local/free).`);
  return lines.join('\n');
}
