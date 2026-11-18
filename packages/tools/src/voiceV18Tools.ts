/**
 * Voice v18 tools for @open-bot/tools (v1.19, Đội T5).
 *
 * The agent drives the voice v18 sessions by tool call:
 *  - voice_v18_session_create — create a v18 realtime session (bot +
 *    user + language + voice context + VAD v6 adaptive thresholds +
 *    noise chain + barge-in v6 early detection + TTS streaming v4
 *    + turn-taking + scripted mock reply), optionally connected at
 *    once (local action)
 *  - voice_v18_session_list   — sessions + connection + state +
 *    turns + barge-ins + checkpoints + reconnects (read)
 *  - voice_v18_session_stats  — full v18 stats (VAD v6, noise
 *    chain, barge-in v6, TTS streaming v4, turn-taking, profiles)
 *    (read)
 *  - voice_v18_session_stop   — disconnect (keeps the session for inspection) (local action)
 *  - voice_v18_session_delete — disconnect + drop the session (local action)
 *  - voice_v18_talk           — feed a final transcript to a session
 *    (drives a full turn: smart-turn end → scripted reply → TTS
 *    streaming v4) (local action)
 *  - voice_v18_barge_in       — interrupt the speaking agent now:
 *    cut receipt with spoken prefix + remaining text + resume plan
 *    + full turn context (local action)
 *  - voice_v18_vad            — VAD v6 for one session: current
 *    class, adaptive threshold, noise floor, false triggers,
 *    segments, stats; optionally feed synthetic frames (speech /
 *    silence / noise) through the session's mic path (local action
 *    when feeding)
 *  - voice_v18_noise          — noise chain for one session: noise
 *    floor, gate state, suppression in dB; optionally process a
 *    synthetic frame and report cleaned RMS (local action when
 *    processing)
 *  - voice_v18_tts            — TTS streaming v4 for one session:
 *    first-chunk latency, queue, long-sentence splits, aging
 *    promotions; optionally speak text (normal / urgent /
 *    background priority) (local action when speaking)
 *  - voice_v18_profiles       — multi-voice profiles v3: list /
 *    get / set / remove / set-default / resolve / presets /
 *    clone-for-user / switch / apply-deferred / usage /
 *    most-used / export / import over the manager's shared
 *    profile store (local action when writing)
 *  - voice_v18_eval           — run the voice eval v18 (default
 *    scripted scenarios: turn-taking latency, barge-in
 *    precision/recall/F1, mock TTS quality) and return the
 *    aggregate report (local action)
 *  - voice_v18_recover        — drop + reconnect a session, or
 *    restore it from a resume token (local action)
 *
 * SAFETY: everything here is local — the default manager runs mock
 * sessions only (scripted replies, mock TTS, synthetic PCM frames).
 * No provider here needs a key; a host that binds a live provider
 * must do so explicitly. These tools never dial a provider, never
 * read, log or store a key, and never touch a mic or sound card.
 *
 * Factory:
 *   createVoiceV18Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V18_TOOLS                       (unbound placeholder, own
 *   default manager — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  RealtimeSessionManagerV18,
  createVoiceEvalV18,
  defaultVoiceEvalV18Scenarios,
  presetVoiceProfilesV18,
  syntheticFrameV18,
  isVoiceProfileV17Context,
  validateVoiceProfileV18,
  type RealtimeSessionV18,
  type VoiceProfileV17Context,
  type VoiceProfileV18,
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

export interface VoiceV18ToolOptions {
  /** Manager accessor (the host binds its RealtimeSessionManagerV18). */
  getManager?: () => RealtimeSessionManagerV18 | null;
}

const VOICE_CONTEXTS = ['chat', 'announcement', 'alert', 'narration', 'whisper'] as const;
const VAD_PRESETS = ['quiet', 'office', 'noisy', 'street'] as const;
const TTS_PRIORITIES = ['urgent', 'normal', 'background'] as const;
const PROFILE_QUALITIES = ['high', 'fast', 'minimal'] as const;
const SWITCH_POLICIES = ['immediate', 'after-turn', 'after-utterance'] as const;
const FRAME_KINDS = ['speech', 'silence', 'noise'] as const;

export function createVoiceV18Tools(opts: VoiceV18ToolOptions = {}): Tool[] {
  const defaultManager = new RealtimeSessionManagerV18();
  const needManager = (): RealtimeSessionManagerV18 => opts.getManager?.() ?? defaultManager;

  const needSession = (manager: RealtimeSessionManagerV18, sessionId: string): RealtimeSessionV18 => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v18 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v18_session_create',
      'Create a voice v18 realtime session (local action): mock session on the given bot, user, language, voice context (chat, announcement, alert, narration, whisper), VAD v6 preset + adaptive threshold + false-trigger guard, noise chain level, barge-in v6 early detection, TTS streaming v4 chunk size + queue, turn-taking timeouts, scripted mock reply. Pass connect=true to start at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default-bot").' },
        userId: { type: 'string', description: 'User id the session belongs to (optional).' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "vi").' },
        voiceContext: { type: 'string', description: 'Voice context: chat, announcement, alert, narration or whisper (default chat).' },
        vadPreset: { type: 'string', description: 'VAD v6 preset: quiet, office, noisy or street (default office).' },
        vadAdaptiveThreshold: { type: 'boolean', description: 'VAD v6: adapt the start threshold to the room noise (default true).' },
        vadMinConfirmedSpeechMs: { type: 'number', description: 'VAD v6: speech run that must hold before a confirmed speech-start, ms (default 120).' },
        vadHangoverMs: { type: 'number', description: 'VAD v6: silence gap that still holds confirmed speech, ms (default 300).' },
        noiseLevel: { type: 'string', description: 'Noise chain level: off, light, moderate or aggressive (default moderate).' },
        bargeInEarlyDetectMs: { type: 'number', description: 'Barge-in v6: speech burst length that fires an early warning, ms (default 60).' },
        bargeInEchoWindowMs: { type: 'number', description: 'Barge-in v6: echo frames ignored this long after the agent starts speaking, ms (default 400).' },
        ttsMaxChunkChars: { type: 'number', description: 'TTS streaming v4 max chars per chunk (default 60).' },
        ttsAgeThresholdMs: { type: 'number', description: 'TTS streaming v4: ms a queued sentence waits before aging promotion (default 3000).' },
        thinkingTimeoutMs: { type: 'number', description: 'Turn-taking: thinking longer than this is stuck, ms.' },
        speakingMaxMs: { type: 'number', description: 'Turn-taking: speaking longer than this is stuck, ms.' },
        interruptedTimeoutMs: { type: 'number', description: 'Turn-taking: interrupted longer than this recovers to listening, ms.' },
        autoResume: { type: 'boolean', description: 'Apply the barge-in resume plan at once (default true).' },
        maxCheckpoints: { type: 'number', description: 'Realtime v3: max checkpoints kept per session (default 20).' },
        maxReconnectAttempts: { type: 'number', description: 'Realtime v3: max reconnect attempts after a drop (default 3).' },
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
        const userId = getOptionalStringArg(args, 'userId');
        const language = getOptionalStringArg(args, 'language');
        const voiceContext = getOptionalStringArg(args, 'voiceContext');
        if (voiceContext !== undefined && !isVoiceProfileV17Context(voiceContext)) {
          throw new Error(`Unknown voice context "${voiceContext}" (want one of ${VOICE_CONTEXTS.join(', ')}).`);
        }
        const vadPreset = getOptionalStringArg(args, 'vadPreset');
        if (vadPreset !== undefined && !(VAD_PRESETS as readonly string[]).includes(vadPreset)) {
          throw new Error(`Unknown VAD preset "${vadPreset}" (want one of ${VAD_PRESETS.join(', ')}).`);
        }
        const noiseLevel = getOptionalStringArg(args, 'noiseLevel');
        if (noiseLevel !== undefined && !['off', 'light', 'moderate', 'aggressive'].includes(noiseLevel)) {
          throw new Error(`Unknown noise level "${noiseLevel}" (want off, light, moderate or aggressive).`);
        }
        const session = manager.create(sessionId, {
          ...(botId !== undefined ? { botId } : {}),
          ...(userId !== undefined ? { userId } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(voiceContext !== undefined ? { voiceContext: voiceContext as VoiceProfileV17Context } : {}),
          ...(getOptionalBooleanArg(args, 'autoResume') !== undefined ? { autoResume: getOptionalBooleanArg(args, 'autoResume') as boolean } : {}),
          ...(getOptionalNumberArg(args, 'maxCheckpoints') !== undefined ? { maxCheckpoints: getOptionalNumberArg(args, 'maxCheckpoints') as number } : {}),
          ...(getOptionalNumberArg(args, 'maxReconnectAttempts') !== undefined ? { maxReconnectAttempts: getOptionalNumberArg(args, 'maxReconnectAttempts') as number } : {}),
          vad: {
            ...(vadPreset !== undefined ? { preset: vadPreset as 'quiet' | 'office' | 'noisy' | 'street' } : {}),
            ...(getOptionalBooleanArg(args, 'vadAdaptiveThreshold') !== undefined ? { adaptiveThreshold: getOptionalBooleanArg(args, 'vadAdaptiveThreshold') as boolean } : {}),
            ...(getOptionalNumberArg(args, 'vadMinConfirmedSpeechMs') !== undefined ? { minConfirmedSpeechMs: getOptionalNumberArg(args, 'vadMinConfirmedSpeechMs') as number } : {}),
            ...(getOptionalNumberArg(args, 'vadHangoverMs') !== undefined ? { hangoverMs: getOptionalNumberArg(args, 'vadHangoverMs') as number } : {}),
          },
          noise: {
            ...(noiseLevel !== undefined ? { suppressor: { level: noiseLevel as 'off' | 'light' | 'moderate' | 'aggressive' } } : {}),
          },
          bargeIn: {
            ...(getOptionalNumberArg(args, 'bargeInEarlyDetectMs') !== undefined ? { earlyDetectMs: getOptionalNumberArg(args, 'bargeInEarlyDetectMs') as number } : {}),
            ...(getOptionalNumberArg(args, 'bargeInEchoWindowMs') !== undefined ? { echoWindowMs: getOptionalNumberArg(args, 'bargeInEchoWindowMs') as number } : {}),
          },
          ttsStream: {
            ...(getOptionalNumberArg(args, 'ttsMaxChunkChars') !== undefined ? { maxChunkChars: getOptionalNumberArg(args, 'ttsMaxChunkChars') as number } : {}),
            ...(getOptionalNumberArg(args, 'ttsAgeThresholdMs') !== undefined ? { ageThresholdMs: getOptionalNumberArg(args, 'ttsAgeThresholdMs') as number } : {}),
          },
          turnTaking: {
            ...(getOptionalNumberArg(args, 'thinkingTimeoutMs') !== undefined ? { thinkingTimeoutMs: getOptionalNumberArg(args, 'thinkingTimeoutMs') as number } : {}),
            ...(getOptionalNumberArg(args, 'speakingMaxMs') !== undefined ? { speakingMaxMs: getOptionalNumberArg(args, 'speakingMaxMs') as number } : {}),
            ...(getOptionalNumberArg(args, 'interruptedTimeoutMs') !== undefined ? { interruptedTimeoutMs: getOptionalNumberArg(args, 'interruptedTimeoutMs') as number } : {}),
          },
          ...(getOptionalStringArg(args, 'mockReply') !== undefined
            ? { replyFor: () => getOptionalStringArg(args, 'mockReply') as string }
            : {}),
        });
        if (getOptionalBooleanArg(args, 'connect') ?? false) await session.connect();
        return JSON.stringify({ created: true, sessionId, connection: session.getConnection(), state: session.getState() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const list: Tool = {
    definition: toolDef(
      'voice_v18_session_list',
      'List voice v18 realtime sessions (read): id, bot, connection, turn state, turns, barge-ins, checkpoints, reconnects.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const manager = needManager();
        return JSON.stringify(
          {
            sessions: manager.list().map((s) => ({
              id: s.id,
              botId: s.botId,
              connection: s.getConnection(),
              state: s.getState(),
              turns: s.turnsList().length,
              bargeIns: s.stats().bargeIns,
              checkpoints: s.stats().checkpoints,
              lastCheckpointSeq: s.stats().lastCheckpointSeq,
              reconnects: s.stats().reconnects,
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

  const sessionStats: Tool = {
    definition: toolDef(
      'voice_v18_session_stats',
      'Full voice v18 stats for one session (read): VAD v6, noise chain, barge-in v6, TTS streaming v4, turn-taking, profiles, checkpoints, reconnects.',
      { sessionId: { type: 'string', description: 'Id of the session.' } },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        return JSON.stringify({ sessionId: session.id, summary: session.summary(), stats: session.stats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stop: Tool = {
    definition: toolDef(
      'voice_v18_session_stop',
      'Disconnect a voice v18 session (local action): keeps the session for inspection.',
      { sessionId: { type: 'string', description: 'Id of the session.' } },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        session.disconnect();
        return JSON.stringify({ stopped: true, sessionId: session.id, connection: session.getConnection() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const remove: Tool = {
    definition: toolDef(
      'voice_v18_session_delete',
      'Disconnect + drop a voice v18 session (local action).',
      { sessionId: { type: 'string', description: 'Id of the session.' } },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const deleted = manager.delete(getStringArg(args, 'sessionId'));
        return JSON.stringify({ deleted, sessionId: getStringArg(args, 'sessionId') }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const talk: Tool = {
    definition: toolDef(
      'voice_v18_talk',
      'Feed a final transcript to a voice v18 session (local action): drives a full turn (smart-turn end → scripted reply → TTS streaming v4). Pass tickMs to advance the virtual clock afterwards.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        text: { type: 'string', description: 'Final transcript text.' },
        tickMs: { type: 'number', description: 'Virtual ms to advance after feeding (default 0).' },
      },
      ['sessionId', 'text'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        session.feedTranscriptFinal(getStringArg(args, 'text'));
        const tickMs = getOptionalNumberArg(args, 'tickMs') ?? 0;
        if (tickMs > 0) session.tick(tickMs);
        await Promise.resolve();
        await Promise.resolve();
        return JSON.stringify(
          { talked: true, sessionId: session.id, state: session.getState(), turns: session.turnsList() },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bargeIn: Tool = {
    definition: toolDef(
      'voice_v18_barge_in',
      'Interrupt the speaking agent in a voice v18 session now (local action): cut receipt with spoken prefix + remaining text + resume plan + full turn context.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        interruptingText: { type: 'string', description: 'What the user said to interrupt (optional).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const record = session.interrupt(session.now(), getOptionalStringArg(args, 'interruptingText'));
        if (!record) return errorResult(`No active agent turn to interrupt in session "${session.id}".`);
        return JSON.stringify({ interrupted: true, cut: record }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const vad: Tool = {
    definition: toolDef(
      'voice_v18_vad',
      'VAD v6 for one voice v18 session (read, or local action when feeding): current class, adaptive threshold, noise floor, false triggers, segments, stats; optionally feed synthetic frames (speech / silence / noise) through the session mic path.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        feedKind: { type: 'string', description: 'Synthetic frames to feed: speech, silence or noise (optional).' },
        feedFrames: { type: 'number', description: 'How many 20 ms frames to feed (default 10).' },
        tickMs: { type: 'number', description: 'Virtual ms to advance per frame (default 20).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const feedKind = getOptionalStringArg(args, 'feedKind');
        if (feedKind !== undefined && !(FRAME_KINDS as readonly string[]).includes(feedKind)) {
          throw new Error(`Unknown frame kind "${feedKind}" (want one of ${FRAME_KINDS.join(', ')}).`);
        }
        if (feedKind !== undefined) {
          const frames = getOptionalNumberArg(args, 'feedFrames') ?? 10;
          const tickMs = getOptionalNumberArg(args, 'tickMs') ?? 20;
          const rms = feedKind === 'speech' ? 0.25 : feedKind === 'noise' ? 0.12 : 0.005;
          for (let i = 0; i < frames; i += 1) {
            session.tick(tickMs);
            session.feedAudioFrame(syntheticFrameV18(rms));
          }
        }
        const stats = session.vad.stats();
        return JSON.stringify(
          {
            sessionId: session.id,
            class: session.vad.getClass(),
            speaking: session.vad.isSpeaking(),
            probability: session.vad.getProbability(),
            startThreshold: stats.startThreshold,
            baseStartThreshold: stats.baseStartThreshold,
            noiseFloor: stats.noiseFloor,
            adaptations: stats.adaptations,
            falseTriggers: session.vad.falseTriggersList(),
            segments: session.vad.segmentsList(),
            stats,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const noise: Tool = {
    definition: toolDef(
      'voice_v18_noise',
      'Noise chain for one voice v18 session (read, or local action when processing): noise floor, gate state, suppression in dB; optionally process a synthetic frame (rms + isSpeech) and report cleaned RMS.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        rms: { type: 'number', description: 'RMS of the synthetic frame to process (optional).' },
        isSpeech: { type: 'boolean', description: 'Whether the frame is speech (default false = learn the noise).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        let processed;
        const rms = getOptionalNumberArg(args, 'rms');
        if (rms !== undefined) {
          const result = session.noise.process(syntheticFrameV18(rms), session.now(), getOptionalBooleanArg(args, 'isSpeech') ?? false);
          processed = { inputRms: result.inputRms, outputRms: result.outputRms, suppressionDb: result.suppressionDb, gateOpen: result.gateOpen, snrDb: result.snrDb };
        }
        return JSON.stringify(
          { sessionId: session.id, ...(processed !== undefined ? { processed } : {}), stats: session.noise.stats(session.now()), summary: session.noise.summary(session.now()) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tts: Tool = {
    definition: toolDef(
      'voice_v18_tts',
      'TTS streaming v4 for one voice v18 session (read, or local action when speaking): first-chunk latency, queue, long-sentence splits, aging promotions; optionally speak text (urgent, normal or background priority).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        text: { type: 'string', description: 'Text to speak (optional).' },
        priority: { type: 'string', description: 'Priority: urgent, normal or background (default normal).' },
        tickMs: { type: 'number', description: 'Virtual ms to advance after speaking (default 0).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const text = getOptionalStringArg(args, 'text');
        const priority = getOptionalStringArg(args, 'priority');
        if (priority !== undefined && !(TTS_PRIORITIES as readonly string[]).includes(priority)) {
          throw new Error(`Unknown priority "${priority}" (want one of ${TTS_PRIORITIES.join(', ')}).`);
        }
        if (text !== undefined) {
          const { profile } = session.resolveProfile();
          session.tts.speak(text, profile, (priority ?? 'normal') as 'urgent' | 'normal' | 'background', session.now());
          const tickMs = getOptionalNumberArg(args, 'tickMs') ?? 0;
          if (tickMs > 0) session.tick(tickMs);
        }
        return JSON.stringify(
          { sessionId: session.id, speaking: session.tts.isSpeaking(), queued: session.tts.queuedSentences(), stats: session.tts.stats(), summary: session.tts.summary() },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profiles: Tool = {
    definition: toolDef(
      'voice_v18_profiles',
      'Multi-voice profiles v3 (local action when writing): list / get / set / remove / set-default / get-default / resolve / presets / clone / switch / apply-deferred / usage / most-used / export / import over the manager shared profile store.',
      {
        action: { type: 'string', description: 'Action: list, get, set, remove, set-default, get-default, resolve, presets, clone, switch, apply-deferred, usage, most-used, export or import.' },
        profileId: { type: 'string', description: 'Profile id (get, set, remove, clone, switch, usage).' },
        botId: { type: 'string', description: 'Bot id (set, resolve, presets; default "default-bot").' },
        userId: { type: 'string', description: 'User id (set, set-default, get-default, resolve, clone, switch).' },
        provider: { type: 'string', description: 'Provider (set; default "mock").' },
        voiceId: { type: 'string', description: 'Voice id (set; default "default").' },
        language: { type: 'string', description: 'Language (set, resolve; default "vi").' },
        rate: { type: 'number', description: 'Playback rate 0.5..2 (set).' },
        pitch: { type: 'number', description: 'Pitch -12..12 semitones (set).' },
        quality: { type: 'string', description: 'Quality: high, fast or minimal (set; default "high").' },
        maxChunkChars: { type: 'number', description: 'Max chars per TTS chunk (set; default 120).' },
        displayName: { type: 'string', description: 'Display name (set).' },
        context: { type: 'string', description: 'Voice context: chat, announcement, alert, narration or whisper (set, resolve, switch).' },
        switchPolicy: { type: 'string', description: 'Switch policy: immediate, after-turn or after-utterance (set).' },
        switchCooldownMs: { type: 'number', description: 'Min ms between switches away from this profile (set).' },
        newId: { type: 'string', description: 'New id for a clone (clone; optional).' },
        chars: { type: 'number', description: 'Chars spoken (usage).' },
        atMs: { type: 'number', description: 'Virtual clock ms (switch, apply-deferred, usage; default 0).' },
        data: { type: 'string', description: 'JSON store to import (import).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const store = manager.profiles;
        const action = getStringArg(args, 'action');
        if (action === 'list') {
          return JSON.stringify({ profiles: store.list(), stats: store.stats() }, null, 2);
        }
        if (action === 'get') {
          const profile = store.get(getStringArg(args, 'profileId'));
          if (!profile) throw new Error(`Unknown voice profile v18 "${getStringArg(args, 'profileId')}".`);
          return JSON.stringify({ profile }, null, 2);
        }
        if (action === 'set') {
          const profileId = getStringArg(args, 'profileId');
          const botId = getOptionalStringArg(args, 'botId') ?? 'default-bot';
          const quality = getOptionalStringArg(args, 'quality');
          if (quality !== undefined && !(PROFILE_QUALITIES as readonly string[]).includes(quality)) {
            throw new Error(`Unknown quality "${quality}" (want one of ${PROFILE_QUALITIES.join(', ')}).`);
          }
          const context = getOptionalStringArg(args, 'context');
          if (context !== undefined && !isVoiceProfileV17Context(context)) {
            throw new Error(`Unknown voice context "${context}" (want one of ${VOICE_CONTEXTS.join(', ')}).`);
          }
          const switchPolicy = getOptionalStringArg(args, 'switchPolicy');
          if (switchPolicy !== undefined && !(SWITCH_POLICIES as readonly string[]).includes(switchPolicy)) {
            throw new Error(`Unknown switch policy "${switchPolicy}" (want one of ${SWITCH_POLICIES.join(', ')}).`);
          }
          const profile: VoiceProfileV18 = {
            id: profileId,
            botId,
            provider: getOptionalStringArg(args, 'provider') ?? 'mock',
            voiceId: getOptionalStringArg(args, 'voiceId') ?? 'default',
            language: getOptionalStringArg(args, 'language') ?? 'vi',
            rate: getOptionalNumberArg(args, 'rate') ?? 1,
            pitch: getOptionalNumberArg(args, 'pitch') ?? 0,
            quality: (quality ?? 'high') as 'high' | 'fast' | 'minimal',
            maxChunkChars: getOptionalNumberArg(args, 'maxChunkChars') ?? 120,
            displayName: getOptionalStringArg(args, 'displayName') ?? profileId,
            ...(getOptionalStringArg(args, 'userId') !== undefined ? { userId: getOptionalStringArg(args, 'userId') as string } : {}),
            ...(context !== undefined ? { context: context as VoiceProfileV17Context } : {}),
            ...(switchPolicy !== undefined ? { switchPolicy: switchPolicy as 'immediate' | 'after-turn' | 'after-utterance' } : {}),
            ...(getOptionalNumberArg(args, 'switchCooldownMs') !== undefined ? { switchCooldownMs: getOptionalNumberArg(args, 'switchCooldownMs') as number } : {}),
          };
          const errors = validateVoiceProfileV18(profile);
          if (errors.length > 0) throw new Error(`invalid voice profile v18: ${errors.join('; ')}`);
          store.set(profile);
          return JSON.stringify({ saved: true, profile: store.get(profileId) }, null, 2);
        }
        if (action === 'remove') {
          const profileId = getStringArg(args, 'profileId');
          return JSON.stringify({ removed: store.remove(profileId), profileId }, null, 2);
        }
        if (action === 'set-default') {
          const userId = getStringArg(args, 'userId');
          const profileId = getStringArg(args, 'profileId');
          store.setUserDefault(userId, profileId);
          return JSON.stringify({ setDefault: true, userId, profileId }, null, 2);
        }
        if (action === 'get-default') {
          const userId = getStringArg(args, 'userId');
          return JSON.stringify({ userId, profile: store.getUserDefault(userId) ?? null }, null, 2);
        }
        if (action === 'resolve') {
          const botId = getOptionalStringArg(args, 'botId') ?? 'default-bot';
          const result = store.resolve({
            ...(getOptionalStringArg(args, 'userId') !== undefined ? { userId: getOptionalStringArg(args, 'userId') as string } : {}),
            botId,
            ...(getOptionalStringArg(args, 'context') !== undefined ? { context: getOptionalStringArg(args, 'context') as VoiceProfileV17Context } : {}),
            ...(getOptionalStringArg(args, 'language') !== undefined ? { language: getOptionalStringArg(args, 'language') as string } : {}),
          });
          return JSON.stringify({ profile: result.profile, tunedProfile: result.tunedProfile, via: result.via, tuningApplied: result.tuningApplied ?? null }, null, 2);
        }
        if (action === 'presets') {
          const botId = getOptionalStringArg(args, 'botId') ?? 'default-bot';
          return JSON.stringify({ presets: presetVoiceProfilesV18(botId) }, null, 2);
        }
        if (action === 'clone') {
          const profileId = getStringArg(args, 'profileId');
          const userId = getStringArg(args, 'userId');
          const newId = getOptionalStringArg(args, 'newId');
          const clone = store.cloneForUser(profileId, userId, newId);
          return JSON.stringify({ cloned: true, profile: clone }, null, 2);
        }
        if (action === 'switch') {
          const profileId = getStringArg(args, 'profileId');
          const botId = getOptionalStringArg(args, 'botId') ?? 'default-bot';
          const context = (getOptionalStringArg(args, 'context') ?? 'chat') as VoiceProfileV17Context;
          if (!isVoiceProfileV17Context(context)) throw new Error(`Unknown voice context "${context}".`);
          const record = store.requestSwitch({
            profileId,
            botId,
            context,
            ...(getOptionalStringArg(args, 'userId') !== undefined ? { userId: getOptionalStringArg(args, 'userId') as string } : {}),
            atMs: getOptionalNumberArg(args, 'atMs') ?? 0,
          });
          return JSON.stringify({ switched: record.applied, record }, null, 2);
        }
        if (action === 'apply-deferred') {
          const applied = store.applyDeferredSwitches(getOptionalNumberArg(args, 'atMs') ?? 0);
          return JSON.stringify({ applied, stillDeferred: store.deferredSwitchesList() }, null, 2);
        }
        if (action === 'usage') {
          const profileId = getStringArg(args, 'profileId');
          store.noteUsage(profileId, getOptionalNumberArg(args, 'chars') ?? 0, getOptionalNumberArg(args, 'atMs') ?? 0);
          return JSON.stringify({ noted: true, profile: store.get(profileId) }, null, 2);
        }
        if (action === 'most-used') {
          return JSON.stringify({ profile: store.mostUsedProfile() ?? null }, null, 2);
        }
        if (action === 'export') {
          return JSON.stringify({ store: store.toJSON() }, null, 2);
        }
        if (action === 'import') {
          const raw = getStringArg(args, 'data');
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new Error('import needs valid JSON in "data".');
          }
          const result = store.fromJSON(parsed);
          return JSON.stringify({ imported: true, ...result, profiles: store.count() }, null, 2);
        }
        throw new Error(`Unknown action "${action}" (want list, get, set, remove, set-default, get-default, resolve, presets, clone, switch, apply-deferred, usage, most-used, export or import).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'voice_v18_eval',
      'Run the voice eval v18 (local action): scripted scenarios score turn-taking latency, barge-in precision/recall/F1 and mock TTS quality; returns the aggregate report (markdown + numbers).',
      {
        turnTakingBudgetMs: { type: 'number', description: 'Turn-taking budget ms (default 1200).' },
        firstChunkBudgetMs: { type: 'number', description: 'First-chunk latency budget ms (default 300).' },
        minBargeInF1: { type: 'number', description: 'Min acceptable barge-in F1 0..1 (default 0.8).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const evalRunner = createVoiceEvalV18({
          ...(getOptionalNumberArg(args, 'turnTakingBudgetMs') !== undefined ? { turnTakingBudgetMs: getOptionalNumberArg(args, 'turnTakingBudgetMs') as number } : {}),
          ...(getOptionalNumberArg(args, 'firstChunkBudgetMs') !== undefined ? { firstChunkBudgetMs: getOptionalNumberArg(args, 'firstChunkBudgetMs') as number } : {}),
          ...(getOptionalNumberArg(args, 'minBargeInF1') !== undefined ? { minBargeInF1: getOptionalNumberArg(args, 'minBargeInF1') as number } : {}),
        });
        const report = await evalRunner.runAll(defaultVoiceEvalV18Scenarios());
        return JSON.stringify({ passed: report.passed, markdown: evalRunner.markdown(report), report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const recover: Tool = {
    definition: toolDef(
      'voice_v18_recover',
      'Recover a voice v18 session (local action): drop + reconnect restores the last checkpoint and re-speaks the remaining reply; or restore from a resume token into a new session.',
      {
        action: { type: 'string', description: 'Action: drop-reconnect or restore-token.' },
        sessionId: { type: 'string', description: 'Id of the session (drop-reconnect).' },
        newSessionId: { type: 'string', description: 'Id of the new session (restore-token).' },
        token: { type: 'string', description: 'Resume token from voice_v18_session_stats or a previous session (restore-token).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const action = getStringArg(args, 'action');
        if (action === 'drop-reconnect') {
          const session = needSession(manager, getStringArg(args, 'sessionId'));
          session.simulateDrop();
          const reconnected = await session.reconnect();
          return JSON.stringify(
            { recovered: reconnected, sessionId: session.id, connection: session.getConnection(), checkpoints: session.checkpointsList(), stats: session.stats() },
            null,
            2,
          );
        }
        if (action === 'restore-token') {
          const token = getStringArg(args, 'token');
          const newSessionId = getStringArg(args, 'newSessionId');
          const session = manager.create(newSessionId, {});
          const restored = session.restoreFromToken(token);
          if (!restored) {
            manager.delete(newSessionId);
            return errorResult('Invalid resume token.');
          }
          return JSON.stringify({ restored: true, sessionId: newSessionId, checkpoints: session.checkpointsList() }, null, 2);
        }
        throw new Error(`Unknown action "${action}" (want drop-reconnect or restore-token).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, talk, bargeIn, vad, noise, tts, profiles, evalTool, recover];
}

/** Unbound placeholder (own default manager — mock sessions only). */
export const VOICE_V18_TOOLS: Tool[] = createVoiceV18Tools();

export const VOICE_V18_TOOL_NAMES = [
  'voice_v18_session_create',
  'voice_v18_session_list',
  'voice_v18_session_stats',
  'voice_v18_session_stop',
  'voice_v18_session_delete',
  'voice_v18_talk',
  'voice_v18_barge_in',
  'voice_v18_vad',
  'voice_v18_noise',
  'voice_v18_tts',
  'voice_v18_profiles',
  'voice_v18_eval',
  'voice_v18_recover',
] as const;

export function isVoiceV18ToolName(name: string): name is (typeof VOICE_V18_TOOL_NAMES)[number] {
  return (VOICE_V18_TOOL_NAMES as readonly string[]).includes(name);
}
