/**
 * Voice v15 tools for @open-bot/tools (v1.16, Đội T5).
 *
 * The agent drives the voice v15 sessions by tool call:
 *  - voice_v15_session_create — create a v15 session (bot + language
 *    + mode s2s/pipeline + S2S provider + Smart Turn v3 sensitivity +
 *    wake-word v3 gate + scripted mock reply), optionally connected
 *    at once (local action)
 *  - voice_v15_session_list   — sessions + state + mode + turns +
 *    latency compliance (read)
 *  - voice_v15_session_stats  — full v15 stats (S2S adapter,
 *    latency pipeline v3, barge-in v3, Smart Turn v3, TTS v3,
 *    wake word v3) (read)
 *  - voice_v15_session_stop   — disconnect (keeps the session for inspection) (local action)
 *  - voice_v15_session_delete — disconnect + drop the session (local action)
 *  - voice_v15_talk           — feed a final transcript to a session
 *    (drives a full turn: smart-turn end → scripted reply → TTS)
 *    (local action)
 *  - voice_v15_barge_in       — interrupt the speaking agent now:
 *    cancel scope + cut receipt (local action)
 *  - voice_v15_latency        — latency pipeline v3 for one session
 *    (per-stage p50/p95/p99, e2e compliance, alerts, quality level)
 *    (read)
 *  - voice_v15_wake_word      — wake-word v3 status + per-word configs
 *    + activations + suppressions; optionally set words or evaluate
 *    a labelled test set (local action when acting)
 *  - voice_v15_provider       — provider registry v2 (plugin STT/TTS/
 *    S2S, pick by goal latency/quality/cost/balanced, pick a pair)
 *    (read)
 *
 * SAFETY: everything here is local — the default manager runs mock
 * sessions only (scripted replies, mock TTS, mock S2S transport).
 * No provider here needs a key; a host that binds a live provider
 * must do so explicitly. These tools never dial a provider, never
 * read, log or store a key, and never touch a mic or sound card.
 *
 * Factory:
 *   createVoiceV15Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V15_TOOLS                       (unbound placeholder, own
 *   default manager — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  VoiceSessionManagerV15,
  isS2SProviderKindV15,
  isVoiceProviderKindV15,
  isVoiceProviderGoalV15,
  createVoiceProviderRegistryV15,
  WakeWordDetectorV15,
  type VoiceSessionV15,
  type VoiceProviderGoalV15,
  type WakeWordV15Config,
  type WakeWordV15TestSample,
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

function getStringListArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
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

export interface VoiceV15ToolOptions {
  /** Manager accessor (the host binds its VoiceSessionManagerV15). */
  getManager?: () => VoiceSessionManagerV15 | null;
}

const S2S_PROVIDER_NAMES = ['openai-realtime', 'gemini-live', 'mock'] as const;
const SESSION_MODES = ['s2s', 'pipeline'] as const;
const SMART_TURN_SENSITIVITIES = ['low', 'balanced', 'high'] as const;
const PROVIDER_PICK_GOALS: VoiceProviderGoalV15[] = ['latency', 'quality', 'cost', 'balanced'];

export function createVoiceV15Tools(opts: VoiceV15ToolOptions = {}): Tool[] {
  const defaultManager = new VoiceSessionManagerV15();
  const needManager = (): VoiceSessionManagerV15 => opts.getManager?.() ?? defaultManager;

  const needSession = (manager: VoiceSessionManagerV15, sessionId: string): VoiceSessionV15 => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v15 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v15_session_create',
      'Create a voice v15 realtime session (local action): mock session on the given bot, language, mode (s2s or pipeline), S2S provider (mock, openai-realtime, gemini-live — mock transport, no key, no network), Smart Turn v3 sensitivity (low, balanced, high), wake-word v3 gate. Pass connect=true to start at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default-bot").' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "vi").' },
        mode: { type: 'string', description: 'Mode: s2s (speech-to-speech, mock transport) or pipeline (default s2s).' },
        s2sProvider: { type: 'string', description: 'S2S provider: mock, openai-realtime or gemini-live (default mock).' },
        sensitivity: { type: 'string', description: 'Smart Turn v3 sensitivity: low, balanced or high (default balanced).' },
        startAsleep: { type: 'boolean', description: 'Start asleep behind the wake-word v3 gate (default false).' },
        wakeWords: { type: 'array', items: { type: 'string' }, description: 'Wake words (default ["hey bot", "này bot", "open bot"]).' },
        mockReply: { type: 'string', description: 'Scripted mock reply for this session (optional).' },
        connect: { type: 'boolean', description: 'Connect (start) at once (default false).' },
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
        const mode = getOptionalStringArg(args, 'mode');
        if (mode !== undefined && !(SESSION_MODES as readonly string[]).includes(mode)) {
          throw new Error(`Unknown mode "${mode}" (want s2s or pipeline).`);
        }
        const s2sProvider = getOptionalStringArg(args, 's2sProvider');
        if (s2sProvider !== undefined && !isS2SProviderKindV15(s2sProvider)) {
          throw new Error(`Unknown S2S provider "${s2sProvider}" (want one of ${S2S_PROVIDER_NAMES.join(', ')}).`);
        }
        const sensitivity = getOptionalStringArg(args, 'sensitivity');
        if (sensitivity !== undefined && !(SMART_TURN_SENSITIVITIES as readonly string[]).includes(sensitivity)) {
          throw new Error(`Unknown Smart Turn v3 sensitivity "${sensitivity}" (want low, balanced or high).`);
        }
        const startAsleep = getOptionalBooleanArg(args, 'startAsleep');
        const wakeWords = getStringListArg(args, 'wakeWords');
        const mockReply = getOptionalStringArg(args, 'mockReply');
        const connectNow = getOptionalBooleanArg(args, 'connect') ?? false;
        const session = manager.create(sessionId, {
          ...(botId !== undefined ? { botId } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(mode !== undefined ? { mode: mode as 's2s' | 'pipeline' } : {}),
          ...(s2sProvider !== undefined ? { s2sProvider: s2sProvider as 'mock' | 'openai-realtime' | 'gemini-live' } : {}),
          ...(sensitivity !== undefined ? { smartTurn: { sensitivity: sensitivity as 'low' | 'balanced' | 'high' } } : {}),
          ...(startAsleep !== undefined ? { startAsleep } : {}),
          ...(wakeWords !== undefined
            ? { wakeWords: wakeWords.map((word) => ({ word, language: language ?? 'vi', sensitivity: 'balanced' as const, minEnergy: 0.01, cooldownMs: 3000, confirmMs: 5000, enabled: true })) }
            : {}),
          ...(mockReply !== undefined ? { replyFor: () => mockReply } : {}),
        });
        if (connectNow) await session.connect();
        return JSON.stringify({ created: true, sessionId, summary: session.summary() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const list: Tool = {
    definition: toolDef(
      'voice_v15_session_list',
      'List voice v15 sessions with state, mode, turns and latency compliance (read).',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const manager = needManager();
        const sessions = manager.list().map((s) => {
          const stats = s.stats();
          return {
            sessionId: s.id,
            botId: s.botId,
            state: stats.state,
            mode: stats.mode,
            turns: stats.turns,
            bargeIns: stats.bargeIns,
            fallbacks: stats.fallbacks,
            quality: stats.quality,
            endToEndP95Ms: stats.pipeline.endToEndP95Ms,
            compliance: Math.round(stats.pipeline.endToEndComplianceRate * 100),
          };
        });
        return JSON.stringify({ sessions }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionStats: Tool = {
    definition: toolDef(
      'voice_v15_session_stats',
      'Full voice v15 stats for one session: S2S adapter, latency pipeline v3, barge-in v3, Smart Turn v3, TTS v3, wake word v3 (read).',
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
        return JSON.stringify({ sessionId: session.id, stats: session.stats(), markdown: session.markdown() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stop: Tool = {
    definition: toolDef(
      'voice_v15_session_stop',
      'Disconnect a voice v15 session (local action; the session stays for inspection).',
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
        session.disconnect();
        return JSON.stringify({ stopped: true, sessionId: session.id, state: session.getState() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const remove: Tool = {
    definition: toolDef(
      'voice_v15_session_delete',
      'Disconnect and drop a voice v15 session (local action).',
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
        const deleted = manager.delete(sessionId);
        return JSON.stringify({ deleted, sessionId }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const talk: Tool = {
    definition: toolDef(
      'voice_v15_talk',
      'Feed a final transcript to a voice v15 session (local action): drives a full turn — Smart Turn v3 ends the turn, the scripted reply is spoken through TTS v3. The session must be active.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        text: { type: 'string', description: 'Final transcript text from the user.' },
        advanceMs: { type: 'number', description: 'Virtual ms to advance the session clock after feeding (default 2000).' },
      },
      ['sessionId', 'text'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const text = getStringArg(args, 'text');
        const advanceMs = getOptionalNumberArg(args, 'advanceMs') ?? 2000;
        session.feedTranscriptFinal(text);
        session.tick(advanceMs);
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.tick(0);
        const turns = session.turnsList();
        const last = turns[turns.length - 1];
        return JSON.stringify({
          sessionId: session.id,
          turns: turns.length,
          lastTurn: last ?? null,
          state: session.getState(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bargeIn: Tool = {
    definition: toolDef(
      'voice_v15_barge_in',
      'Interrupt the speaking agent in a voice v15 session now (local action): cancels TTS mid-stream and discards stale LLM work; returns the cut receipt.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        scope: { type: 'string', description: 'Cancel scope: all (default), tts-only or llm-only.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const scope = getOptionalStringArg(args, 'scope') ?? 'all';
        if (!['all', 'tts-only', 'llm-only'].includes(scope)) {
          throw new Error(`Unknown scope "${scope}" (want all, tts-only or llm-only).`);
        }
        const cut = session.interrupt(session.now());
        if (!cut) return JSON.stringify({ interrupted: false, sessionId: session.id, reason: 'agent is not speaking' }, null, 2);
        return JSON.stringify({ interrupted: true, sessionId: session.id, cut }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const latency: Tool = {
    definition: toolDef(
      'voice_v15_latency',
      'Latency pipeline v3 for one voice v15 session: per-stage p50/p95/p99, e2e compliance, alerts, quality level (read).',
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
        return JSON.stringify({
          sessionId: session.id,
          report: session.pipeline.sessionReport(),
          markdown: session.pipeline.markdown(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const wakeWord: Tool = {
    definition: toolDef(
      'voice_v15_wake_word',
      'Wake-word v3 for one voice v15 session: per-word configs, activations, suppressions. Optionally set words (action) or evaluate a labelled test set (action).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Action: status (default), set-words, evaluate.' },
        words: { type: 'array', items: { type: 'string' }, description: 'Wake words for set-words.' },
        sensitivity: { type: 'string', description: 'Sensitivity for set-words: low, balanced or high (default balanced).' },
        samples: { type: 'string', description: 'JSON array of {transcript, containsWakeWord} for evaluate.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const action = getOptionalStringArg(args, 'action') ?? 'status';
        if (action === 'set-words') {
          const words = getStringListArg(args, 'words');
          if (!words || words.length === 0) throw new Error('set-words needs a non-empty "words" array.');
          const sensitivity = getOptionalStringArg(args, 'sensitivity') ?? 'balanced';
          if (!(SMART_TURN_SENSITIVITIES as readonly string[]).includes(sensitivity)) {
            throw new Error(`Unknown sensitivity "${sensitivity}".`);
          }
          const configs: WakeWordV15Config[] = words.map((word) => ({
            word,
            language: session.language,
            sensitivity: sensitivity as 'low' | 'balanced' | 'high',
            minEnergy: 0.01,
            cooldownMs: 3000,
            confirmMs: 5000,
            enabled: true,
          }));
          session.wakeWord.setWords(configs);
          return JSON.stringify({ acted: 'set-words', sessionId: session.id, words: session.wakeWord.listWords() }, null, 2);
        }
        if (action === 'evaluate') {
          const raw = getStringArg(args, 'samples');
          let samples: WakeWordV15TestSample[];
          try {
            samples = JSON.parse(raw) as WakeWordV15TestSample[];
          } catch {
            throw new Error('samples must be a JSON array of {transcript, containsWakeWord}.');
          }
          if (!Array.isArray(samples)) throw new Error('samples must be a JSON array.');
          const detector = new WakeWordDetectorV15(session.wakeWord.listWords());
          const evaluation = detector.evaluate(samples);
          return JSON.stringify({ acted: 'evaluate', sessionId: session.id, evaluation }, null, 2);
        }
        if (action !== 'status') throw new Error(`Unknown action "${action}" (want status, set-words or evaluate).`);
        return JSON.stringify({
          sessionId: session.id,
          awake: session.wakeWord.isAwake(),
          words: session.wakeWord.listWords(),
          stats: session.wakeWord.stats(),
          markdown: session.wakeWord.markdown(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const provider: Tool = {
    definition: toolDef(
      'voice_v15_provider',
      'Voice provider registry v2: registered STT/TTS/S2S plugins, pick by goal (latency, quality, cost, balanced), pick an STT+TTS pair with hourly cost (read).',
      {
        kind: { type: 'string', description: 'Provider kind: stt, tts or s2s (default: all).' },
        goal: { type: 'string', description: 'Pick goal: latency, quality, cost or balanced (default balanced).' },
        language: { type: 'string', description: 'Language filter, e.g. "vi" (optional).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const kind = getOptionalStringArg(args, 'kind');
        if (kind !== undefined && !isVoiceProviderKindV15(kind)) {
          throw new Error(`Unknown provider kind "${kind}" (want stt, tts or s2s).`);
        }
        const goal = getOptionalStringArg(args, 'goal') ?? 'balanced';
        if (!isVoiceProviderGoalV15(goal)) {
          throw new Error(`Unknown goal "${goal}" (want one of ${PROVIDER_PICK_GOALS.join(', ')}).`);
        }
        const language = getOptionalStringArg(args, 'language');
        const registry = createVoiceProviderRegistryV15();
        await registry.refreshHealth();
        const options = { goal: goal as VoiceProviderGoalV15, ...(language ? { language } : {}) };
        const pair = registry.pickPair(options);
        return JSON.stringify({
          providers: registry.list(kind as 'stt' | 'tts' | 's2s' | undefined).map((p) => ({
            id: p.id,
            kind: p.kind,
            label: p.label,
            languages: p.languages,
            streaming: p.streaming,
            latencyMs: p.latencyMs,
            costPerMinuteUsd: p.costPerMinuteUsd,
            quality: p.quality,
            requiresKey: p.requiresKey,
          })),
          pick: {
            stt: pair.stt?.plugin.id ?? null,
            tts: pair.tts?.plugin.id ?? null,
            combinedLatencyMs: pair.combinedLatencyMs,
            hourlyCostUsd: pair.hourlyCostUsd,
          },
          markdown: registry.markdown(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, talk, bargeIn, latency, wakeWord, provider];
}

/** Unbound placeholder (own default manager — mock sessions only). */
export const VOICE_V15_TOOLS: Tool[] = createVoiceV15Tools();

export const VOICE_V15_TOOL_NAMES = [
  'voice_v15_session_create',
  'voice_v15_session_list',
  'voice_v15_session_stats',
  'voice_v15_session_stop',
  'voice_v15_session_delete',
  'voice_v15_talk',
  'voice_v15_barge_in',
  'voice_v15_latency',
  'voice_v15_wake_word',
  'voice_v15_provider',
] as const;

export function isVoiceV15ToolName(name: string): name is (typeof VOICE_V15_TOOL_NAMES)[number] {
  return (VOICE_V15_TOOL_NAMES as readonly string[]).includes(name);
}
