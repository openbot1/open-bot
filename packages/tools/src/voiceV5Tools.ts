/**
 * Voice v5 tools for @open-bot/tools (v1.06, Team T4).
 *
 * The agent drives the voice v5 system by tool call:
 *  - voice_v5_route          — dry-run the multi-model router:
 *    pick STT / TTS / realtime models for a language + latency
 *    class + cost cap (+ per-bot config when botId is given),
 *    with the ordered fallback chain and a cost estimate (read)
 *  - voice_v5_router_config  — get / set / reset a bot's router
 *    config (pinned models, latency class, cost cap, local-first)
 *    (set/reset need approval)
 *  - voice_v5_start_session  — create a v5 session: routes the
 *    models, starts the adaptive VAD + diarization (local action)
 *  - voice_v5_stop_session   — close + remove a session, report
 *    its turns / speakers / speech time (local action)
 *  - voice_v5_vad_config     — get / set a session's adaptive VAD
 *    (threshold, adaptive on/off, hangover, gaps, backchannel
 *    ceiling) + live noise floor / stats (local action)
 *  - voice_v5_list_speakers  — speakers in a session: id, label,
 *    display name, turns, total speech time (read)
 *  - voice_v5_name_speaker   — give a speaker a display name
 *    ("Huy", "Khách") in a session (local action)
 *  - voice_v5_note_turn      — attach STT text to the latest
 *    turn without text (the voice loop calls this when the
 *    transcriber returns; mock-friendly) (local action)
 *  - voice_v5_transcript     — diarized transcript of a session:
 *    every turn with its speaker label + timestamps (read)
 *
 * SAFETY: everything here is local — sessions run on mock
 * transports by default, no key is read, no network is touched.
 * Embeddings stay in memory (and, when the host opts in, in a
 * local JSON file); they are never sent anywhere. Renaming a
 * speaker only changes a local label.
 *
 * Factory:
 *   createVoiceV5Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V5_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  estimateVoiceCost,
  isVoiceLatencyClass,
  validateVadV5Options,
  validateVoiceBotRouterConfig,
  voiceRouteReportMarkdown,
  type DiarizedTurn,
  type SpeakerProfile,
  type VoiceLatencyClass,
  type VoiceRoute,
  type VoiceRouteRequest,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function routeToJson(route: VoiceRoute, costMinutes: number): Record<string, unknown> {
  const cost = estimateVoiceCost(route, costMinutes);
  return {
    language: route.language,
    latencyClass: route.latencyClass,
    usedOutOfBudget: route.usedOutOfBudget,
    lanes: route.lanes.map((lane) => ({
      lane: lane.lane,
      primary: lane.primary.id,
      primaryProvider: lane.primary.provider,
      primaryLatencyMsEstimate: lane.primary.latencyMsEstimate,
      primaryCostTier: lane.primary.costTier,
      fallbacks: lane.fallbacks.map((m) => m.id),
      reason: lane.reason,
    })),
    estimatedCostUnitsPerMinute: cost.totalUnits / Math.max(1, costMinutes),
  };
}

/** What the tools need from a v5 session. */
export interface VoiceV5SessionLike {
  sessionId: string;
  getStats(): {
    sessionId: string;
    turns: number;
    backchannels: number;
    speakers: number;
    totalSpeechMs: number;
    vad: { state: string; threshold: number; noiseFloor: number; level: number };
    route: VoiceRoute;
  };
  getVadReport(): { options: Record<string, unknown>; stats: Record<string, unknown> };
  configureVad(patch: Record<string, unknown>): Record<string, unknown>;
  listSpeakers(): SpeakerProfile[];
  renameSpeaker(speakerId: string, displayName: string): boolean;
  noteTranscript(text: string): DiarizedTurn | null;
  getTranscript(): DiarizedTurn[];
  getTranscriptMarkdown(): string;
  isClosed(): boolean;
}

/** What the tools need from the v5 manager. */
export interface VoiceV5ManagerLike {
  route(req?: VoiceRouteRequest, botId?: string): VoiceRoute;
  createSession(
    sessionId: string,
    options?: Record<string, unknown>,
  ): VoiceV5SessionLike;
  getSession(sessionId: string): VoiceV5SessionLike | undefined;
  stopSession(sessionId: string): boolean;
  listSessionIds(): string[];
  getStats(): unknown;
  getRouter(): {
    setBotConfig(config: Record<string, unknown>): void;
    getBotConfig(botId: string): Record<string, unknown> | undefined;
    resetBotConfig(botId: string): boolean;
    listBotConfigs(): Array<Record<string, unknown>>;
  };
}

export interface VoiceV5ToolOptions {
  /** Manager accessor (the host binds its VoiceV5Manager). */
  getManager?: () => VoiceV5ManagerLike | null;
}

function asV5Session(value: unknown): VoiceV5SessionLike | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (
    typeof s.getStats !== 'function' ||
    typeof s.getVadReport !== 'function' ||
    typeof s.configureVad !== 'function' ||
    typeof s.listSpeakers !== 'function' ||
    typeof s.getTranscript !== 'function'
  ) {
    return null;
  }
  return value as VoiceV5SessionLike;
}

function parseLatencyClass(args: Record<string, unknown>): VoiceLatencyClass | undefined {
  const raw = getOptionalStringArg(args, 'latencyClass');
  if (raw === undefined) return undefined;
  if (!isVoiceLatencyClass(raw)) {
    throw new Error(`latencyClass must be one of low, balanced, quality (got "${raw}").`);
  }
  return raw;
}

function parseCostTier(args: Record<string, unknown>): 0 | 1 | 2 | 3 | undefined {
  const raw = getNumberArg(args, 'maxCostTier');
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < 0 || raw > 3) {
    throw new Error(`maxCostTier must be an integer 0..3 (got ${raw}).`);
  }
  return raw as 0 | 1 | 2 | 3;
}

export function createVoiceV5Tools(opts: VoiceV5ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV5ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v5 manager is not available in this session (host must pass getManager to createVoiceV5Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV5ManagerLike, sessionId: string): VoiceV5SessionLike => {
    const session = asV5Session(manager.getSession(sessionId));
    if (!session) {
      const known = manager.listSessionIds();
      throw new Error(
        `Unknown voice v5 session "${sessionId}".` +
          (known.length > 0 ? ` Known sessions: ${known.join(', ')}.` : ' No v5 sessions exist yet — start one with voice_v5_start_session.'),
      );
    }
    return session;
  };

  const routeTool: Tool = {
    definition: toolDef(
      'voice_v5_route',
      'Pick STT / TTS / realtime voice models for a call (language, latency class, cost cap, local-first). Returns the primary model + ordered fallback chain per lane and a relative cost estimate. Read-only; no session needed.',
      {
        language: { type: 'string', description: 'BCP 47 language of the call, e.g. "vi", "en". Default "en".' },
        latencyClass: { type: 'string', enum: ['low', 'balanced', 'quality'], description: 'Latency class wanted. Default "balanced".' },
        maxLatencyMs: { type: 'number', description: 'Hard latency ceiling in ms (optional).' },
        maxCostTier: { type: 'number', description: 'Hard cost ceiling 0..3 (0 = local/free only). Optional.' },
        preferLocal: { type: 'boolean', description: 'Prefer local/free models when close enough. Default false.' },
        botId: { type: 'string', description: 'Bot id — applies its stored router config when given (optional).' },
        costMinutes: { type: 'number', description: 'Minutes to estimate cost for. Default 1.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const botId = getOptionalStringArg(args, 'botId');
        const req: VoiceRouteRequest = {
          language: getOptionalStringArg(args, 'language'),
          latencyClass: parseLatencyClass(args),
          maxLatencyMs: getNumberArg(args, 'maxLatencyMs'),
          maxCostTier: parseCostTier(args),
          preferLocal: getBooleanArg(args, 'preferLocal'),
        };
        const route = manager.route(req, botId);
        const costMinutes = getNumberArg(args, 'costMinutes') ?? 1;
        return JSON.stringify(
          { ...routeToJson(route, costMinutes), report: voiceRouteReportMarkdown(route, costMinutes) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const routerConfigTool: Tool = {
    definition: toolDef(
      'voice_v5_router_config',
      'Get / set / reset a bot\'s voice router config: pinned STT / TTS / realtime models, latency class, cost cap, local-first preference. Set/reset change routing for that bot\'s future calls.',
      {
        botId: { type: 'string', description: 'Bot id the config belongs to.' },
        action: { type: 'string', enum: ['get', 'set', 'reset'], description: '"get" (default), "set" or "reset".' },
        sttModel: { type: 'string', description: 'Pinned STT model id (set only), e.g. "whisper-local-base".' },
        ttsModel: { type: 'string', description: 'Pinned TTS model id (set only), e.g. "piper-local".' },
        realtimeModel: { type: 'string', description: 'Pinned realtime model id (set only), e.g. "gemini-live-flash".' },
        latencyClass: { type: 'string', enum: ['low', 'balanced', 'quality'], description: 'Latency class (set only).' },
        maxCostTier: { type: 'number', description: 'Cost cap 0..3 (set only).' },
        preferLocal: { type: 'boolean', description: 'Prefer local/free models (set only).' },
      },
      ['botId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const manager = needManager();
        const botId = getStringArg(args, 'botId');
        const action = getOptionalStringArg(args, 'action') ?? 'get';
        if (action !== 'get' && action !== 'set' && action !== 'reset') {
          throw new Error(`action must be "get", "set" or "reset" (got "${action}").`);
        }
        const router = manager.getRouter();
        if (action === 'reset') {
          const removed = router.resetBotConfig(botId);
          return removed
            ? `Router config for bot "${botId}" reset to defaults.`
            : `Bot "${botId}" had no stored router config.`;
        }
        if (action === 'get') {
          const config = router.getBotConfig(botId);
          return config
            ? JSON.stringify(config, null, 2)
            : `Bot "${botId}" has no stored router config (defaults apply).`;
        }
        // set
        const patch: Record<string, unknown> = { botId };
        const sttModel = getOptionalStringArg(args, 'sttModel');
        const ttsModel = getOptionalStringArg(args, 'ttsModel');
        const realtimeModel = getOptionalStringArg(args, 'realtimeModel');
        const latencyClass = parseLatencyClass(args);
        const maxCostTier = parseCostTier(args);
        const preferLocal = getBooleanArg(args, 'preferLocal');
        if (sttModel !== undefined) patch.sttModel = sttModel;
        if (ttsModel !== undefined) patch.ttsModel = ttsModel;
        if (realtimeModel !== undefined) patch.realtimeModel = realtimeModel;
        if (latencyClass !== undefined) patch.latencyClass = latencyClass;
        if (maxCostTier !== undefined) patch.maxCostTier = maxCostTier;
        if (preferLocal !== undefined) patch.preferLocal = preferLocal;
        const existing = router.getBotConfig(botId) ?? {};
        const merged = { ...existing, ...patch };
        const check = validateVoiceBotRouterConfig(
          merged as { botId: string; sttModel?: string; ttsModel?: string; realtimeModel?: string },
        );
        if (!check.ok) throw new Error(check.errors.join(' '));
        router.setBotConfig(merged);
        return JSON.stringify(router.getBotConfig(botId), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const startSessionTool: Tool = {
    definition: toolDef(
      'voice_v5_start_session',
      'Start a realtime voice session (v5): routes STT / TTS / realtime models for the call, starts the adaptive VAD and speaker diarization. Local only — mock transport by default, no key, no network.',
      {
        sessionId: { type: 'string', description: 'Id for the new session, e.g. "call-1".' },
        botId: { type: 'string', description: 'Bot id (applies its router config when set). Optional.' },
        language: { type: 'string', description: 'BCP 47 language of the call. Default "en".' },
        latencyClass: { type: 'string', enum: ['low', 'balanced', 'quality'], description: 'Latency class wanted.' },
        maxCostTier: { type: 'number', description: 'Cost cap 0..3 (optional).' },
        preferLocal: { type: 'boolean', description: 'Prefer local/free models.' },
        vadThreshold: { type: 'number', description: 'VAD base threshold RMS 0.005..0.25 (optional).' },
        vadAdaptive: { type: 'boolean', description: 'VAD adaptive threshold on/off (optional).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const vadThreshold = getNumberArg(args, 'vadThreshold');
        const vadAdaptive = getBooleanArg(args, 'vadAdaptive');
        const vadPatch: Record<string, unknown> = {};
        if (vadThreshold !== undefined) vadPatch.baseThreshold = vadThreshold;
        if (vadAdaptive !== undefined) vadPatch.adaptive = vadAdaptive;
        const vadErrors = validateVadV5Options(vadPatch as { baseThreshold?: number; adaptive?: boolean });
        if (vadErrors.length > 0) throw new Error(vadErrors.join(' '));
        const session = manager.createSession(sessionId, {
          botId: getOptionalStringArg(args, 'botId'),
          language: getOptionalStringArg(args, 'language'),
          latencyClass: parseLatencyClass(args),
          maxCostTier: parseCostTier(args),
          preferLocal: getBooleanArg(args, 'preferLocal'),
          vad: vadPatch,
        });
        const stats = session.getStats();
        return JSON.stringify(
          {
            sessionId: stats.sessionId,
            status: 'started',
            language: session.getStats().route.language,
            route: routeToJson(stats.route, 1),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stopSessionTool: Tool = {
    definition: toolDef(
      'voice_v5_stop_session',
      'Stop a realtime voice session (v5): closes it, removes it from the manager, and reports its turns, speakers and total speech time.',
      {
        sessionId: { type: 'string', description: 'Id of the session to stop.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const session = asV5Session(manager.getSession(sessionId));
        const stats = session?.getStats();
        const stopped = manager.stopSession(sessionId);
        if (!stopped) throw new Error(`Unknown voice v5 session "${sessionId}".`);
        return JSON.stringify(
          {
            sessionId,
            status: 'stopped',
            turns: stats?.turns ?? 0,
            speakers: stats?.speakers ?? 0,
            backchannels: stats?.backchannels ?? 0,
            totalSpeechMs: stats?.totalSpeechMs ?? 0,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const vadConfigTool: Tool = {
    definition: toolDef(
      'voice_v5_vad_config',
      'Get or set a voice session\'s adaptive VAD: base threshold, adaptive on/off, threshold multiplier, hangover, max gap inside a turn, minimum turn length, backchannel ceiling. Get also reports the live noise floor and stats.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', enum: ['get', 'set'], description: '"get" (default) or "set".' },
        baseThreshold: { type: 'number', description: 'VAD base threshold RMS 0.005..0.25 (set only).' },
        adaptive: { type: 'boolean', description: 'Follow the noise floor (set only).' },
        thresholdMultiplier: { type: 'number', description: 'Threshold = noise floor x this, 1..20 (set only).' },
        hangoverMs: { type: 'number', description: 'Quiet ms before a turn ends, 50..5000 (set only).' },
        maxGapMs: { type: 'number', description: 'Quiet gap forgiven inside a turn, 0..2000 (set only).' },
        minTurnMs: { type: 'number', description: 'Minimum turn length, 0..2000 (set only).' },
        backchannelMaxMs: { type: 'number', description: 'Bursts shorter than this are backchannels, 0..2000 (set only).' },
        noiseLearnMs: { type: 'number', description: 'Noise-floor learning time constant, 100..30000 (set only).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const action = getOptionalStringArg(args, 'action') ?? 'get';
        if (action !== 'get' && action !== 'set') {
          throw new Error(`action must be "get" or "set" (got "${action}").`);
        }
        if (action === 'get') {
          return JSON.stringify(session.getVadReport(), null, 2);
        }
        const patch: Record<string, unknown> = {};
        const put = (key: string, value: number | boolean | undefined): void => {
          if (value !== undefined) patch[key] = value;
        };
        put('baseThreshold', getNumberArg(args, 'baseThreshold'));
        put('adaptive', getBooleanArg(args, 'adaptive'));
        put('thresholdMultiplier', getNumberArg(args, 'thresholdMultiplier'));
        put('hangoverMs', getNumberArg(args, 'hangoverMs'));
        put('maxGapMs', getNumberArg(args, 'maxGapMs'));
        put('minTurnMs', getNumberArg(args, 'minTurnMs'));
        put('backchannelMaxMs', getNumberArg(args, 'backchannelMaxMs'));
        put('noiseLearnMs', getNumberArg(args, 'noiseLearnMs'));
        const errors = validateVadV5Options(
          patch as { baseThreshold?: number; adaptive?: boolean; thresholdMultiplier?: number; hangoverMs?: number; maxGapMs?: number; minTurnMs?: number; backchannelMaxMs?: number; noiseLearnMs?: number },
        );
        if (errors.length > 0) throw new Error(errors.join(' '));
        if (Object.keys(patch).length === 0) {
          throw new Error('voice_v5_vad_config set needs at least one VAD option.');
        }
        const updated = session.configureVad(patch);
        return JSON.stringify({ updated, stats: session.getVadReport().stats }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listSpeakersTool: Tool = {
    definition: toolDef(
      'voice_v5_list_speakers',
      'List the speakers detected in a voice session: id, label, display name, turns and total speech time. Read-only.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const speakers = session.listSpeakers();
        return JSON.stringify(
          {
            sessionId: session.sessionId,
            total: speakers.length,
            speakers: speakers.map((s: SpeakerProfile) => ({
              id: s.id,
              label: s.displayName ?? s.label,
              displayName: s.displayName ?? null,
              turns: s.turns,
              totalMs: s.totalMs,
              firstSeenAtMs: s.firstSeenAtMs,
              lastSeenAtMs: s.lastSeenAtMs,
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const nameSpeakerTool: Tool = {
    definition: toolDef(
      'voice_v5_name_speaker',
      'Give a speaker in a voice session a display name (e.g. "Huy" for speaker-1). The name shows in the diarized transcript. Local only.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        speakerId: { type: 'string', description: 'Speaker id, e.g. "speaker-1".' },
        displayName: { type: 'string', description: 'Display name to assign.' },
      },
      ['sessionId', 'speakerId', 'displayName'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const speakerId = getStringArg(args, 'speakerId');
        const displayName = getStringArg(args, 'displayName');
        const ok = session.renameSpeaker(speakerId, displayName);
        if (!ok) {
          const known = session.listSpeakers().map((s) => s.id);
          throw new Error(
            `Cannot rename "${speakerId}" in session "${session.sessionId}".` +
              (known.length > 0 ? ` Known speakers: ${known.join(', ')}.` : ' No speakers detected yet.'),
          );
        }
        return `Speaker "${speakerId}" in session "${session.sessionId}" is now "${displayName.trim()}".`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const noteTurnTool: Tool = {
    definition: toolDef(
      'voice_v5_note_turn',
      'Attach STT text to the latest voice turn that has no text yet (the voice loop calls this when the transcriber returns a final segment). Mock-friendly: the agent can log turns without a microphone.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        text: { type: 'string', description: 'Final transcript text for the turn.' },
      },
      ['sessionId', 'text'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const text = getStringArg(args, 'text');
        const turn = session.noteTranscript(text);
        if (!turn) {
          throw new Error(
            `Session "${session.sessionId}" has no turn waiting for text (speak first, then note the turn).`,
          );
        }
        return JSON.stringify(turn, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const transcriptTool: Tool = {
    definition: toolDef(
      'voice_v5_transcript',
      'Diarized transcript of a voice session: every turn with its speaker label and start/end timestamps. Read-only.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        format: { type: 'string', enum: ['json', 'markdown'], description: '"json" (default) or "markdown".' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const format = getOptionalStringArg(args, 'format') ?? 'json';
        if (format !== 'json' && format !== 'markdown') {
          throw new Error(`format must be "json" or "markdown" (got "${format}").`);
        }
        if (format === 'markdown') return session.getTranscriptMarkdown();
        return JSON.stringify(
          {
            sessionId: session.sessionId,
            total: session.getTranscript().length,
            turns: session.getTranscript(),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    routeTool,
    routerConfigTool,
    startSessionTool,
    stopSessionTool,
    vadConfigTool,
    listSpeakersTool,
    nameSpeakerTool,
    noteTurnTool,
    transcriptTool,
  ];
}

/** Unbound placeholder (same shape as VOICE_V4_TOOLS). */
export const VOICE_V5_TOOLS: Tool[] = createVoiceV5Tools();

/** Names of the voice v5 tools (for the coordinator/registry checks). */
export const VOICE_V5_TOOL_NAMES = [
  'voice_v5_route',
  'voice_v5_router_config',
  'voice_v5_start_session',
  'voice_v5_stop_session',
  'voice_v5_vad_config',
  'voice_v5_list_speakers',
  'voice_v5_name_speaker',
  'voice_v5_note_turn',
  'voice_v5_transcript',
] as const;

/** True when the name is one of the voice v5 tools. */
export function isVoiceV5ToolName(name: string): name is (typeof VOICE_V5_TOOL_NAMES)[number] {
  return (VOICE_V5_TOOL_NAMES as readonly string[]).includes(name);
}
