/**
 * Voice v16 tools for @open-bot/tools (v1.17, Đội T5).
 *
 * The agent drives the voice v16 sessions by tool call:
 *  - voice_v16_session_create — create a v16 session (bot + language
 *    + mode s2s/pipeline + S2S provider + Smart Turn v4 + wake-word
 *    v4 gate + TTS streaming v2 options + scripted mock reply),
 *    optionally connected at once (local action)
 *  - voice_v16_session_list   — sessions + state + mode + turns +
 *    barge-ins + resumes + first-audio (read)
 *  - voice_v16_session_stats  — full v16 stats (S2S pipeline v4,
 *    barge-in v4, Smart Turn v4, TTS v2, wake word v4) (read)
 *  - voice_v16_session_stop   — disconnect (keeps the session for inspection) (local action)
 *  - voice_v16_session_delete — disconnect + drop the session (local action)
 *  - voice_v16_talk           — feed a final transcript to a session
 *    (drives a full turn: smart-turn v4 end → scripted reply →
 *    TTS v2) (local action)
 *  - voice_v16_barge_in       — interrupt the speaking agent now:
 *    cut receipt with spoken prefix + remaining text + turn
 *    context (local action)
 *  - voice_v16_s2s            — S2S pipeline v4 for one session
 *    (backpressure queues, drops, reconnects, turn resumes,
 *    resume token) (read)
 *  - voice_v16_wake_word      — wake-word v4 status + per-word
 *    configs + activations + sleeps + wake-commands; optionally
 *    set words or evaluate a labelled test set (local action when
 *    acting)
 *  - voice_v16_tts            — TTS streaming v2 for one session
 *    (first audio, join gaps, underruns, schedule) (read)
 *
 * SAFETY: everything here is local — the default manager runs mock
 * sessions only (scripted replies, mock TTS, mock S2S transport).
 * No provider here needs a key; a host that binds a live provider
 * must do so explicitly. These tools never dial a provider, never
 * read, log or store a key, and never touch a mic or sound card.
 *
 * Factory:
 *   createVoiceV16Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V16_TOOLS                       (unbound placeholder, own
 *   default manager — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  VoiceSessionManagerV16,
  WakeWordDetectorV16,
  isS2SProviderKindV15,
  type VoiceSessionV16,
  type WakeWordV16Config,
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

export interface VoiceV16ToolOptions {
  /** Manager accessor (the host binds its VoiceSessionManagerV16). */
  getManager?: () => VoiceSessionManagerV16 | null;
}

const S2S_PROVIDER_NAMES = ['openai-realtime', 'gemini-live', 'mock'] as const;
const SESSION_MODES = ['s2s', 'pipeline'] as const;
const SMART_TURN_SENSITIVITIES = ['low', 'balanced', 'high'] as const;

export function createVoiceV16Tools(opts: VoiceV16ToolOptions = {}): Tool[] {
  const defaultManager = new VoiceSessionManagerV16();
  const needManager = (): VoiceSessionManagerV16 => opts.getManager?.() ?? defaultManager;

  const needSession = (manager: VoiceSessionManagerV16, sessionId: string): VoiceSessionV16 => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v16 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v16_session_create',
      'Create a voice v16 realtime session (local action): mock session on the given bot, language, mode (s2s or pipeline), S2S provider (mock, openai-realtime, gemini-live — mock transport, no key, no network), Smart Turn v4 sensitivity (low, balanced, high) + max wait, wake-word v4 gate with auto-sleep, TTS streaming v2 chunk size. Pass connect=true to start at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default-bot").' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "vi").' },
        mode: { type: 'string', description: 'Mode: s2s (speech-to-speech, mock transport) or pipeline (default s2s).' },
        s2sProvider: { type: 'string', description: 'S2S provider: mock, openai-realtime or gemini-live (default mock).' },
        sensitivity: { type: 'string', description: 'Smart Turn v4 sensitivity: low, balanced or high (default balanced).' },
        maxWaitMs: { type: 'number', description: 'Smart Turn v4 max wait before forcing a decision, ms (default 8000).' },
        startAsleep: { type: 'boolean', description: 'Start asleep behind the wake-word v4 gate (default false).' },
        wakeWords: { type: 'array', items: { type: 'string' }, description: 'Wake words (default ["hey bot", "này bot", "open bot"]).' },
        sleepAfterSilenceMs: { type: 'number', description: 'Wake-word v4 auto-sleep after this many ms of silence while awake (default 60000).' },
        ttsMaxChunkChars: { type: 'number', description: 'TTS streaming v2 max chars per chunk (default 60).' },
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
          throw new Error(`Unknown Smart Turn v4 sensitivity "${sensitivity}" (want low, balanced or high).`);
        }
        const maxWaitMs = getOptionalNumberArg(args, 'maxWaitMs');
        const startAsleep = getOptionalBooleanArg(args, 'startAsleep');
        const wakeWords = getStringListArg(args, 'wakeWords');
        const sleepAfterSilenceMs = getOptionalNumberArg(args, 'sleepAfterSilenceMs');
        const ttsMaxChunkChars = getOptionalNumberArg(args, 'ttsMaxChunkChars');
        const mockReply = getOptionalStringArg(args, 'mockReply');
        const connectNow = getOptionalBooleanArg(args, 'connect') ?? false;
        const session = manager.create(sessionId, {
          ...(botId !== undefined ? { botId } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(mode !== undefined ? { mode: mode as 's2s' | 'pipeline' } : {}),
          ...(sensitivity !== undefined || maxWaitMs !== undefined
            ? {
                smartTurn: {
                  ...(sensitivity !== undefined ? { sensitivity: sensitivity as 'low' | 'balanced' | 'high' } : {}),
                  ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
                },
              }
            : {}),
          ...(startAsleep !== undefined ? { startAsleep } : {}),
          ...(wakeWords !== undefined
            ? { wakeWords: wakeWords.map((word) => ({ word, language: language ?? 'vi', sensitivity: 'balanced' as const, minEnergy: 0.01, cooldownMs: 3000, confirmMs: 5000, enabled: true })) }
            : {}),
          ...(sleepAfterSilenceMs !== undefined ? { wakeWordOptions: { sleepAfterSilenceMs } } : {}),
          ...(ttsMaxChunkChars !== undefined ? { ttsStream: { maxChunkChars: ttsMaxChunkChars } } : {}),
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
      'voice_v16_session_list',
      'List voice v16 sessions with state, mode, turns, barge-ins, resumes and TTS first-audio (read).',
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
            wakeUps: stats.wakeUps,
            sleeps: stats.sleeps,
            resumes: stats.resumes,
            firstAudioMs: stats.tts.averageFirstAudioMs,
            maxJoinGapMs: stats.tts.maxGapMs ?? null,
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
      'voice_v16_session_stats',
      'Full voice v16 stats for one session: S2S pipeline v4, barge-in v4, Smart Turn v4, TTS streaming v2, wake word v4 (read).',
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
      'voice_v16_session_stop',
      'Disconnect a voice v16 session (keeps the session for inspection) (local action).',
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
      'voice_v16_session_delete',
      'Disconnect and drop a voice v16 session (local action).',
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
      'voice_v16_talk',
      'Feed a final transcript to a voice v16 session: drives a full turn (Smart Turn v4 end → scripted reply → TTS streaming v2) (local action).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        text: { type: 'string', description: 'Final transcript text.' },
        energy: { type: 'number', description: 'Frame energy for the wake-word gate (default 1).' },
      },
      ['sessionId', 'text'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const text = getStringArg(args, 'text');
        const energy = getOptionalNumberArg(args, 'energy') ?? 1;
        session.feedTranscriptFinal(text, energy);
        session.tick(600);
        session.feedSilence(600);
        await Promise.resolve();
        await Promise.resolve();
        session.tick(5000);
        return JSON.stringify({
          sessionId: session.id,
          state: session.getState(),
          turns: session.turnsList(),
          summary: session.summary(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bargeIn: Tool = {
    definition: toolDef(
      'voice_v16_barge_in',
      'Interrupt the speaking agent in a voice v16 session now: stops TTS at once and returns the cut receipt (spoken prefix + remaining text + turn context) (local action).',
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
        const receipt = session.interrupt(session.now());
        if (!receipt) return JSON.stringify({ cut: false, reason: 'agent is not speaking' }, null, 2);
        return JSON.stringify({ cut: true, receipt }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const s2s: Tool = {
    definition: toolDef(
      'voice_v16_s2s',
      'S2S pipeline v4 for one voice v16 session: backpressure queues, dropped frames, reconnects, turn resumes and the resume token (read).',
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
        const stats = session.pipeline.stats();
        return JSON.stringify({
          sessionId: session.id,
          pipeline: stats,
          resumeToken: session.pipeline.resumeToken() ?? null,
          markdown: session.pipeline.markdown(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const wakeWord: Tool = {
    definition: toolDef(
      'voice_v16_wake_word',
      'Wake-word v4 status for one voice v16 session: per-word configs, activations, sleeps, wake-commands; actions: status, set-words, evaluate a labelled test set (local action when acting).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Action: status, set-words or evaluate (default status).' },
        words: { type: 'array', items: { type: 'string' }, description: 'Wake words for set-words.' },
        samples: { type: 'array', items: { type: 'object' }, description: 'Labelled samples for evaluate: [{transcript, containsWakeWord}].' },
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
          if (!words || words.length === 0) throw new Error('set-words needs a non-empty "words" list.');
          const configs: WakeWordV16Config[] = words.map((word) => ({
            word,
            language: session.language,
            sensitivity: 'balanced',
            minEnergy: 0.01,
            cooldownMs: 3000,
            confirmMs: 5000,
            enabled: true,
          }));
          for (const config of configs) session.wakeWord.setWord(config);
        } else if (action === 'evaluate') {
          const raw = args.samples;
          if (!Array.isArray(raw)) throw new Error('evaluate needs a "samples" array.');
          const samples = raw.map((s) => {
            const item = s as Record<string, unknown>;
            if (typeof item.transcript !== 'string' || typeof item.containsWakeWord !== 'boolean') {
              throw new Error('each sample needs {transcript: string, containsWakeWord: boolean}.');
            }
            return { transcript: item.transcript, containsWakeWord: item.containsWakeWord };
          });
          const evaluation = session.wakeWord.evaluate(samples);
          return JSON.stringify({ sessionId: session.id, evaluation }, null, 2);
        } else if (action !== 'status') {
          throw new Error(`Unknown action "${action}" (want status, set-words or evaluate).`);
        }
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

  const tts: Tool = {
    definition: toolDef(
      'voice_v16_tts',
      'TTS streaming v2 for one voice v16 session: first audio, join gaps between chunks, underruns, playout schedule (read).',
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
          tts: session.tts.stats(),
          schedule: session.tts.schedule(),
          markdown: session.tts.markdown(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, talk, bargeIn, s2s, wakeWord, tts];
}

/** Unbound placeholder (own default manager — mock sessions only). */
export const VOICE_V16_TOOLS: Tool[] = createVoiceV16Tools();

export const VOICE_V16_TOOL_NAMES = [
  'voice_v16_session_create',
  'voice_v16_session_list',
  'voice_v16_session_stats',
  'voice_v16_session_stop',
  'voice_v16_session_delete',
  'voice_v16_talk',
  'voice_v16_barge_in',
  'voice_v16_s2s',
  'voice_v16_wake_word',
  'voice_v16_tts',
] as const;

export function isVoiceV16ToolName(name: string): name is (typeof VOICE_V16_TOOL_NAMES)[number] {
  return (VOICE_V16_TOOL_NAMES as readonly string[]).includes(name);
}
