/**
 * Voice v10 tools for @open-bot/tools (v1.11, Đội T5).
 *
 * The agent drives the voice v10 sessions by tool call:
 *  - voice_v10_session_create  — create a v10 session (bot + language
 *    + voice + VAD v10 preset + noise level + barge-in policy +
 *    bot preset), optionally connected at once (local action)
 *  - voice_v10_session_list    — sessions + status + mode + turns (read)
 *  - voice_v10_session_stats   — full v10 stats (pipeline + VAD v10 +
 *    noise + barge-in + transcript + AG-UI voice events) (read)
 *  - voice_v10_session_stop    — disconnect (keeps the session for inspection) (local action)
 *  - voice_v10_session_delete  — disconnect + drop the session (local action)
 *  - voice_v10_simulate_turn   — drive one scripted mock turn
 *    (user line → agent words streaming in) (local action)
 *  - voice_v10_vad             — VAD v10 status, or live preset switch (local action when configuring, read otherwise)
 *  - voice_v10_noise           — noise suppression status, or live level switch (local action when configuring, read otherwise)
 *  - voice_v10_preset          — bot voice preset: set (create/update +
 *    activate) / get (one preset, active preset, or the provider
 *    voice catalog) (local action when setting, read otherwise)
 *  - voice_v10_realtime        — realtime status (mode, fallbacks,
 *    recoveries, latencies, live-key probe), force-batch, or retry
 *    realtime now (local action when forcing/retrying, read otherwise)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only. A host that binds a live-transport
 * factory to the manager must do so explicitly; these tools
 * never dial a provider themselves and never touch a key.
 *
 * Factory:
 *   createVoiceV10Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V10_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  isVadV10PresetName,
  isNoiseSuppressionLevel,
  isBargeInV9Policy,
  isVoiceV10ProviderId,
  validateBotVoicePreset,
  getVoiceV10ProviderCatalog,
  VOICE_V10_PROVIDER_CATALOG,
  type VadV10PresetName,
  type NoiseSuppressionLevel,
  type BargeInV9Policy,
  type BotVoicePreset,
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

function getOptionalBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
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

/** What the tools need from one v10 session (the v10 session fits). */
export interface VoiceV10SessionLike {
  getStatus(): string;
  getMode(): string;
  getSettings(): unknown;
  getStats(): unknown;
  getSummary(): string;
  transcriptMarkdown(): string;
  connect(): Promise<void>;
  disconnect(): void;
  simulateTurn(userText: string, modelReply?: string): Promise<boolean>;
  interrupt(reason?: string): unknown;
  duck(): boolean;
  resumePlayback(): boolean;
  setVadPreset(preset: VadV10PresetName): unknown;
  setNoiseLevel(level: NoiseSuppressionLevel): unknown;
  setBargeInPolicy(policy: BargeInV9Policy): unknown;
  applyPreset(preset: BotVoicePreset): unknown;
  forceBatch(reason: string): Promise<void>;
  tryRecover(): Promise<boolean>;
  getAgUiEvents(): unknown[];
  getAudioLevel(): unknown;
  liveProbe(hasKey: () => boolean): unknown;
}

/** What the tools need from the preset store. */
export interface VoiceV10PresetStoreLike {
  create(input: Partial<BotVoicePreset> & { id: string; botId: string }): { ok: boolean; preset?: BotVoicePreset; error?: string };
  get(botId: string, presetId: string): BotVoicePreset | undefined;
  list(botId: string): BotVoicePreset[];
  update(botId: string, presetId: string, patch: Partial<BotVoicePreset>): { ok: boolean; preset?: BotVoicePreset; error?: string };
  remove(botId: string, presetId: string): boolean;
  setActive(botId: string, presetId: string): boolean;
  getActive(botId: string, language?: string): BotVoicePreset | undefined;
}

/** What the tools need from the session manager. */
export interface VoiceV10ManagerLike {
  create(options: {
    sessionId: string;
    botId?: string;
    language?: string;
    voice?: string;
    botPreset?: BotVoicePreset | null;
    pipeline?: Record<string, unknown>;
    connectNow?: boolean;
  }): VoiceV10SessionLike;
  get(sessionId: string): VoiceV10SessionLike | undefined;
  remove(sessionId: string): boolean;
  list(): VoiceV10SessionLike[];
  ids(): string[];
  size(): number;
  getPresetStore(): VoiceV10PresetStoreLike;
}

export interface VoiceV10ToolOptions {
  /** Manager accessor (the host binds its VoiceV10Manager). */
  getManager?: () => VoiceV10ManagerLike | null;
  /**
   * Live-key check for voice_v10_realtime. The default reports
   * "no key" — the host passes a Vault-backed check when it wants
   * a real answer. The predicate returns a boolean only; the key
   * itself is never read or returned.
   */
  hasLiveKey?: () => boolean;
}

const VAD_V10_PRESET_NAMES: VadV10PresetName[] = ['quiet', 'office', 'noisy', 'street'];
const NOISE_LEVELS: NoiseSuppressionLevel[] = ['off', 'light', 'moderate', 'aggressive'];
const BARGE_IN_POLICIES: BargeInV9Policy[] = ['immediate', 'grace', 'confirm'];

export function createVoiceV10Tools(opts: VoiceV10ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV10ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v10 session manager is not available in this session (host must pass getManager to createVoiceV10Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV10ManagerLike, sessionId: string): VoiceV10SessionLike => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v10 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v10_session_create',
      'Create a voice v10 realtime session (local action): mock session on the given bot, language, voice, VAD v10 preset, noise suppression level, barge-in policy and bot voice preset. Pass connect=true to start listening at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default").' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "en").' },
        voice: { type: 'string', description: 'Voice id (default: the bot preset or provider default).' },
        presetId: { type: 'string', description: 'Bot voice preset id to speak with (optional; overrides language/voice).' },
        vadPreset: { type: 'string', description: 'VAD v10 preset: quiet, office, noisy or street (default office).' },
        noiseLevel: { type: 'string', description: 'Noise suppression level: off, light, moderate or aggressive (default moderate).' },
        bargeInPolicy: { type: 'string', description: 'Barge-in policy: immediate, grace or confirm (default grace).' },
        mockReply: { type: 'string', description: 'Scripted mock reply for this session (optional).' },
        connect: { type: 'boolean', description: 'Connect (start listening) at once (default false).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const botId = getOptionalStringArg(args, 'botId');
        const language = getOptionalStringArg(args, 'language');
        const voice = getOptionalStringArg(args, 'voice');
        const presetId = getOptionalStringArg(args, 'presetId');
        let botPreset: BotVoicePreset | undefined;
        if (presetId !== undefined) {
          botPreset = manager.getPresetStore().get(botId ?? 'default', presetId);
          if (!botPreset) throw new Error(`Unknown voice preset "${presetId}" for bot "${botId ?? 'default'}".`);
        }
        const vadPreset = getOptionalStringArg(args, 'vadPreset');
        if (vadPreset !== undefined && !isVadV10PresetName(vadPreset)) {
          throw new Error(`Unknown VAD v10 preset "${vadPreset}" (want one of ${VAD_V10_PRESET_NAMES.join(', ')}).`);
        }
        const noiseLevel = getOptionalStringArg(args, 'noiseLevel');
        if (noiseLevel !== undefined && !isNoiseSuppressionLevel(noiseLevel)) {
          throw new Error(`Unknown noise level "${noiseLevel}" (want one of ${NOISE_LEVELS.join(', ')}).`);
        }
        const bargeInPolicy = getOptionalStringArg(args, 'bargeInPolicy');
        if (bargeInPolicy !== undefined && !isBargeInV9Policy(bargeInPolicy)) {
          throw new Error(`Unknown barge-in policy "${bargeInPolicy}" (want one of ${BARGE_IN_POLICIES.join(', ')}).`);
        }
        const mockReply = getOptionalStringArg(args, 'mockReply');
        const connectNow = getOptionalBooleanArg(args, 'connect') ?? false;
        const session = manager.create({
          sessionId,
          ...(botId !== undefined ? { botId } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(voice !== undefined ? { voice } : {}),
          ...(botPreset !== undefined ? { botPreset } : {}),
          pipeline: {
            ...(vadPreset !== undefined ? { vad: { preset: vadPreset } } : {}),
            ...(noiseLevel !== undefined ? { noise: { level: noiseLevel } } : {}),
            ...(bargeInPolicy !== undefined ? { bargeIn: { policy: bargeInPolicy } } : {}),
            ...(mockReply !== undefined ? { mockReplies: [mockReply] } : {}),
          },
          connectNow,
        });
        return JSON.stringify({ created: true, sessionId, summary: session.getSummary() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const list: Tool = {
    definition: toolDef(
      'voice_v10_session_list',
      'List voice v10 sessions with status, mode, turns, fallbacks and interrupts (read).',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const manager = needManager();
        const sessions = manager.list().map((s) => {
          const stats = s.getStats() as Record<string, unknown>;
          return {
            sessionId: (s as unknown as { sessionId?: string }).sessionId ?? (s as unknown as { getSessionId?: () => string }).getSessionId?.() ?? '?',
            status: s.getStatus(),
            mode: s.getMode(),
            turns: stats['turns'],
            userTurns: stats['userTurns'],
            agentTurns: stats['agentTurns'],
            fallbacks: stats['fallbacks'],
            interrupts: stats['interrupts'],
          };
        });
        return JSON.stringify({ sessions, count: sessions.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionStats: Tool = {
    definition: toolDef(
      'voice_v10_session_stats',
      'Full v10 stats for one session: status, mode, VAD v10, noise suppression, barge-in, transcript, latencies, AG-UI voice events and the transcript as Markdown (read).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const session = needSession(manager, sessionId);
        return JSON.stringify({
          sessionId,
          status: session.getStatus(),
          mode: session.getMode(),
          settings: session.getSettings(),
          stats: session.getStats(),
          audioLevel: session.getAudioLevel(),
          aguiEvents: (session.getAgUiEvents() as unknown[]).length,
          transcript: session.transcriptMarkdown(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stop: Tool = {
    definition: toolDef(
      'voice_v10_session_stop',
      'Disconnect a voice v10 session (local action). The session is kept for inspection; use voice_v10_session_delete to drop it.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const session = needSession(manager, sessionId);
        session.disconnect();
        return JSON.stringify({ stopped: true, sessionId, status: session.getStatus() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const remove: Tool = {
    definition: toolDef(
      'voice_v10_session_delete',
      'Disconnect and drop a voice v10 session (local action).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const removed = manager.remove(sessionId);
        if (!removed) throw new Error(`Unknown voice v10 session "${sessionId}".`);
        return JSON.stringify({ deleted: true, sessionId, remaining: manager.size() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const simulateTurn: Tool = {
    definition: toolDef(
      'voice_v10_simulate_turn',
      'Drive one scripted mock turn on a voice v10 session (local action): commit the user line, then stream the mock agent reply word by word. The session must be listening.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        userText: { type: 'string', description: 'What the user said.' },
        modelReply: { type: 'string', description: 'Scripted agent reply (optional; defaults to the session mock reply).' },
      },
      ['sessionId', 'userText'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const userText = getStringArg(args, 'userText');
        const modelReply = getOptionalStringArg(args, 'modelReply');
        const session = needSession(manager, sessionId);
        const ran = await session.simulateTurn(userText, modelReply);
        if (!ran) throw new Error(`Voice v10 session "${sessionId}" is ${session.getStatus()} — simulate_turn needs a listening session.`);
        return JSON.stringify({ simulated: true, sessionId, status: session.getStatus(), transcript: session.transcriptMarkdown() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const vad: Tool = {
    definition: toolDef(
      'voice_v10_vad',
      'VAD v10 status for one session, or switch its preset live (local action when preset is given, read otherwise).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        preset: { type: 'string', description: 'VAD v10 preset to switch to: quiet, office, noisy or street (optional).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const preset = getOptionalStringArg(args, 'preset');
        const session = needSession(manager, sessionId);
        if (preset !== undefined) {
          if (!isVadV10PresetName(preset)) {
            throw new Error(`Unknown VAD v10 preset "${preset}" (want one of ${VAD_V10_PRESET_NAMES.join(', ')}).`);
          }
          const next = session.setVadPreset(preset);
          return JSON.stringify({ sessionId, preset, options: next }, null, 2);
        }
        const stats = session.getStats() as Record<string, unknown>;
        return JSON.stringify({ sessionId, vad: stats['vad'] }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const noise: Tool = {
    definition: toolDef(
      'voice_v10_noise',
      'Noise suppression status for one session, or switch its level live (local action when level is given, read otherwise).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        level: { type: 'string', description: 'Noise suppression level: off, light, moderate or aggressive (optional).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const level = getOptionalStringArg(args, 'level');
        const session = needSession(manager, sessionId);
        if (level !== undefined) {
          if (!isNoiseSuppressionLevel(level)) {
            throw new Error(`Unknown noise level "${level}" (want one of ${NOISE_LEVELS.join(', ')}).`);
          }
          const next = session.setNoiseLevel(level);
          return JSON.stringify({ sessionId, level, options: next }, null, 2);
        }
        const stats = session.getStats() as Record<string, unknown>;
        return JSON.stringify({ sessionId, noise: stats['noise'] }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const preset: Tool = {
    definition: toolDef(
      'voice_v10_preset',
      'Bot voice preset (local action when setting, read otherwise). action=set creates or updates a preset for a bot (provider + voice + language + rate + noise level + VAD preset) and activates it; action=get returns one preset, the bot active preset, or the provider voice catalog (provider=catalog).',
      {
        action: { type: 'string', description: 'set or get (default get).' },
        botId: { type: 'string', description: 'Bot id the preset belongs to (default "default").' },
        presetId: { type: 'string', description: 'Preset id (required for set; optional for get — omit to read the active preset).' },
        name: { type: 'string', description: 'Display name (set only).' },
        provider: { type: 'string', description: 'Provider: openai, gemini, system, elevenlabs or local (set only; "catalog" for get).' },
        voice: { type: 'string', description: 'Provider voice id, or null for the provider default (set only).' },
        language: { type: 'string', description: 'Language tag, e.g. "vi" or "en" (set only).' },
        rate: { type: 'number', description: 'Speaking rate 0.5..2 (set only).' },
        noiseLevel: { type: 'string', description: 'Noise suppression level (set only).' },
        vadPreset: { type: 'string', description: 'VAD v10 preset (set only).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const store = manager.getPresetStore();
        const action = getOptionalStringArg(args, 'action') ?? 'get';
        const botId = getOptionalStringArg(args, 'botId') ?? 'default';
        const presetId = getOptionalStringArg(args, 'presetId');
        if (action === 'catalog') {
          const provider = getOptionalStringArg(args, 'provider');
          if (provider !== undefined) {
            if (!isVoiceV10ProviderId(provider)) throw new Error(`Unknown voice provider "${provider}".`);
            return JSON.stringify({ provider, catalog: getVoiceV10ProviderCatalog(provider) }, null, 2);
          }
          return JSON.stringify({ catalog: VOICE_V10_PROVIDER_CATALOG }, null, 2);
        }
        if (action === 'set') {
          if (!presetId) throw new Error('voice_v10_preset set needs presetId.');
          const name = getOptionalStringArg(args, 'name');
          const provider = getOptionalStringArg(args, 'provider');
          const voice = getOptionalStringArg(args, 'voice');
          const language = getOptionalStringArg(args, 'language');
          const rate = getOptionalNumberArg(args, 'rate');
          const noiseLevel = getOptionalStringArg(args, 'noiseLevel');
          const vadPreset = getOptionalStringArg(args, 'vadPreset');
          const existing = store.get(botId, presetId);
          const input: Partial<BotVoicePreset> & { id: string; botId: string } = {
            id: presetId,
            botId,
            ...(existing ? { ...existing } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(provider !== undefined ? { provider: provider as BotVoicePreset['provider'] } : {}),
            ...(voice !== undefined ? { voice } : {}),
            ...(language !== undefined ? { language } : {}),
            ...(rate !== undefined ? { rate } : {}),
            ...(noiseLevel !== undefined ? { noiseSuppression: noiseLevel as NoiseSuppressionLevel } : {}),
            ...(vadPreset !== undefined ? { vadPreset: vadPreset as VadV10PresetName } : {}),
          };
          const validated = validateBotVoicePreset(input);
          if (!validated.ok) throw new Error(validated.error);
          const result = existing
            ? store.update(botId, presetId, validated.preset)
            : store.create(validated.preset);
          if (!result.ok || !result.preset) throw new Error(result.error ?? 'Could not save the voice preset.');
          store.setActive(botId, presetId);
          return JSON.stringify({ saved: true, active: true, preset: result.preset }, null, 2);
        }
        if (action === 'get') {
          if (presetId !== undefined) {
            const found = store.get(botId, presetId);
            if (!found) throw new Error(`Unknown voice preset "${presetId}" for bot "${botId}".`);
            return JSON.stringify({ preset: found }, null, 2);
          }
          const language = getOptionalStringArg(args, 'language');
          const active = store.getActive(botId, language);
          return JSON.stringify({ botId, active, presets: store.list(botId) }, null, 2);
        }
        throw new Error(`Unknown voice_v10_preset action "${action}" (want "set", "get" or "catalog").`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const realtime: Tool = {
    definition: toolDef(
      'voice_v10_realtime',
      'Realtime v2 status for one session (read): mode, fallbacks, recoveries, first-partial and turn latencies, live-key probe. action=force-batch switches to batch STT/TTS now; action=recover retries the realtime transport now (local action).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'status, force-batch or recover (default status).' },
        reason: { type: 'string', description: 'Reason for force-batch (optional).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const action = getOptionalStringArg(args, 'action') ?? 'status';
        const session = needSession(manager, sessionId);
        if (action === 'force-batch') {
          const reason = getOptionalStringArg(args, 'reason') ?? 'forced by agent';
          await session.forceBatch(reason);
          return JSON.stringify({ sessionId, mode: session.getMode(), forced: true }, null, 2);
        }
        if (action === 'recover') {
          const recovered = await session.tryRecover();
          return JSON.stringify({ sessionId, mode: session.getMode(), recovered }, null, 2);
        }
        if (action !== 'status') throw new Error(`Unknown voice_v10_realtime action "${action}" (want "status", "force-batch" or "recover").`);
        const stats = session.getStats() as Record<string, unknown>;
        const hasKey = opts.hasLiveKey ?? (() => false);
        const probe = session.liveProbe(hasKey) as { available: boolean; reason: string };
        return JSON.stringify({
          sessionId,
          status: session.getStatus(),
          mode: session.getMode(),
          fallbacks: stats['fallbacks'],
          recoveries: stats['recoveries'],
          recoverAttempts: stats['recoverAttempts'],
          firstPartialLatencyMs: stats['firstPartialLatencyMs'],
          turnLatencyMs: stats['turnLatencyMs'],
          meanTurnLatencyMs: stats['meanTurnLatencyMs'],
          liveAvailable: probe.available,
          liveReason: probe.reason,
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, simulateTurn, vad, noise, preset, realtime];
}

/** Unbound placeholder (the host binds a manager via createVoiceV10Tools). */
export const VOICE_V10_TOOLS: Tool[] = createVoiceV10Tools();

export const VOICE_V10_TOOL_NAMES = [
  'voice_v10_session_create',
  'voice_v10_session_list',
  'voice_v10_session_stats',
  'voice_v10_session_stop',
  'voice_v10_session_delete',
  'voice_v10_simulate_turn',
  'voice_v10_vad',
  'voice_v10_noise',
  'voice_v10_preset',
  'voice_v10_realtime',
] as const;

export function isVoiceV10ToolName(name: string): name is (typeof VOICE_V10_TOOL_NAMES)[number] {
  return (VOICE_V10_TOOL_NAMES as readonly string[]).includes(name);
}
