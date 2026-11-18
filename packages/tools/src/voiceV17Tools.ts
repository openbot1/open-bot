/**
 * Voice v17 tools for @open-bot/tools (v1.18, Đội T5).
 *
 * The agent drives the voice v17 sessions by tool call:
 *  - voice_v17_session_create — create a v17 session (bot + user +
 *    language + voice context + VAD v5 thresholds + barge-in v5
 *    resume policy + TTS streaming v3 chunking + turn-taking v5
 *    timeouts + scripted mock reply), optionally connected at once
 *    (local action)
 *  - voice_v17_session_list   — sessions + state + turns +
 *    barge-ins + resumes + first-chunk latency (read)
 *  - voice_v17_session_stats  — full v17 stats (VAD v5, barge-in
 *    v5, Smart Turn v4, TTS streaming v3, turn-taking v5) (read)
 *  - voice_v17_session_stop   — disconnect (keeps the session for inspection) (local action)
 *  - voice_v17_session_delete — disconnect + drop the session (local action)
 *  - voice_v17_talk           — feed a final transcript to a session
 *    (drives a full turn: smart-turn v4 end → scripted reply →
 *    TTS streaming v3) (local action)
 *  - voice_v17_barge_in       — interrupt the speaking agent now:
 *    cut receipt with spoken prefix + remaining text + resume plan
 *    (resume / restart / summarise / drop) (local action)
 *  - voice_v17_vad            — VAD v5 for one session: current
 *    class, probability, floors, segments, stats; optionally feed
 *    synthetic frames (speech / silence) through the session's mic
 *    path (local action when feeding)
 *  - voice_v17_tts            — TTS streaming v3 for one session:
 *    first-chunk latency, queue, schedule; optionally speak text
 *    (normal or urgent priority) (local action when speaking)
 *  - voice_v17_profiles       — multi-voice profiles v2: list /
 *    get / set / remove / set-default / resolve / presets /
 *    clone-for-user / export / import over the manager's shared
 *    profile store (local action when writing)
 *
 * SAFETY: everything here is local — the default manager runs mock
 * sessions only (scripted replies, mock TTS, synthetic PCM frames).
 * No provider here needs a key; a host that binds a live provider
 * must do so explicitly. These tools never dial a provider, never
 * read, log or store a key, and never touch a mic or sound card.
 *
 * Factory:
 *   createVoiceV17Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V17_TOOLS                       (unbound placeholder, own
 *   default manager — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  VoiceSessionManagerV17,
  isVoiceProfileV17Context,
  presetVoiceProfilesV17,
  syntheticFrameV15,
  validateVoiceProfileV17,
  type VoiceProfileV17,
  type VoiceProfileV17Context,
  type VoiceSessionV17,
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

export interface VoiceV17ToolOptions {
  /** Manager accessor (the host binds its VoiceSessionManagerV17). */
  getManager?: () => VoiceSessionManagerV17 | null;
}

const VOICE_CONTEXTS = ['chat', 'announcement', 'alert', 'narration', 'whisper'] as const;
const VAD_PRESETS = ['quiet', 'office', 'noisy', 'street'] as const;
const TTS_PRIORITIES = ['urgent', 'normal', 'background'] as const;
const PROFILE_QUALITIES = ['high', 'fast', 'minimal'] as const;

export function createVoiceV17Tools(opts: VoiceV17ToolOptions = {}): Tool[] {
  const defaultManager = new VoiceSessionManagerV17();
  const needManager = (): VoiceSessionManagerV17 => opts.getManager?.() ?? defaultManager;

  const needSession = (manager: VoiceSessionManagerV17, sessionId: string): VoiceSessionV17 => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v17 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v17_session_create',
      'Create a voice v17 realtime session (local action): mock session on the given bot, user, language, voice context (chat, announcement, alert, narration, whisper), VAD v5 preset + thresholds, barge-in v5 resume policy, TTS streaming v3 chunk size, turn-taking v5 timeouts, scripted mock reply. Pass connect=true to start at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default-bot").' },
        userId: { type: 'string', description: 'User id the session belongs to (optional).' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "vi").' },
        voiceContext: { type: 'string', description: 'Voice context: chat, announcement, alert, narration or whisper (default chat).' },
        vadPreset: { type: 'string', description: 'VAD v5 preset: quiet, office, noisy or street (default office).' },
        vadStartThreshold: { type: 'number', description: 'VAD v5 speech-start probability threshold 0..1.' },
        vadNoiseMinMs: { type: 'number', description: 'VAD v5 sustained noise before a noise-burst fires, ms.' },
        vadDebounceMs: { type: 'number', description: 'VAD v5 debounce: raw class must hold this long, ms.' },
        bargeInMinRemainingChars: { type: 'number', description: 'Barge-in v5: remaining chars at/below this → drop the tail.' },
        bargeInEscalatedMaxReplyChars: { type: 'number', description: 'Barge-in v5: max reply chars once escalated to level 2.' },
        ttsMaxChunkChars: { type: 'number', description: 'TTS streaming v3 max chars per chunk (default 60).' },
        ttsMaxQueuedChunks: { type: 'number', description: 'TTS streaming v3 max chunks queued behind the playing one.' },
        thinkingTimeoutMs: { type: 'number', description: 'Turn-taking v5: thinking longer than this is stuck, ms.' },
        speakingMaxMs: { type: 'number', description: 'Turn-taking v5: speaking longer than this is stuck, ms.' },
        interruptedTimeoutMs: { type: 'number', description: 'Turn-taking v5: interrupted longer than this recovers to listening, ms.' },
        autoResume: { type: 'boolean', description: 'Apply the barge-in resume plan at once (default true).' },
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
        const vadStartThreshold = getOptionalNumberArg(args, 'vadStartThreshold');
        const vadNoiseMinMs = getOptionalNumberArg(args, 'vadNoiseMinMs');
        const vadDebounceMs = getOptionalNumberArg(args, 'vadDebounceMs');
        const bargeInMinRemainingChars = getOptionalNumberArg(args, 'bargeInMinRemainingChars');
        const bargeInEscalatedMaxReplyChars = getOptionalNumberArg(args, 'bargeInEscalatedMaxReplyChars');
        const ttsMaxChunkChars = getOptionalNumberArg(args, 'ttsMaxChunkChars');
        const ttsMaxQueuedChunks = getOptionalNumberArg(args, 'ttsMaxQueuedChunks');
        const thinkingTimeoutMs = getOptionalNumberArg(args, 'thinkingTimeoutMs');
        const speakingMaxMs = getOptionalNumberArg(args, 'speakingMaxMs');
        const interruptedTimeoutMs = getOptionalNumberArg(args, 'interruptedTimeoutMs');
        const autoResume = getOptionalBooleanArg(args, 'autoResume');
        const mockReply = getOptionalStringArg(args, 'mockReply');
        const connectNow = getOptionalBooleanArg(args, 'connect') ?? false;
        const session = manager.create(sessionId, {
          ...(botId !== undefined ? { botId } : {}),
          ...(userId !== undefined ? { userId } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(voiceContext !== undefined ? { voiceContext: voiceContext as VoiceProfileV17Context } : {}),
          ...(autoResume !== undefined ? { autoResume } : {}),
          ...(vadPreset !== undefined || vadStartThreshold !== undefined || vadNoiseMinMs !== undefined || vadDebounceMs !== undefined
            ? {
                vad: {
                  ...(vadPreset !== undefined ? { preset: vadPreset as 'quiet' | 'office' | 'noisy' | 'street' } : {}),
                  ...(vadStartThreshold !== undefined ? { startThreshold: vadStartThreshold } : {}),
                  ...(vadNoiseMinMs !== undefined ? { noiseMinMs: vadNoiseMinMs } : {}),
                  ...(vadDebounceMs !== undefined ? { debounceMs: vadDebounceMs } : {}),
                },
              }
            : {}),
          ...(bargeInMinRemainingChars !== undefined || bargeInEscalatedMaxReplyChars !== undefined
            ? {
                bargeIn: {
                  ...(bargeInMinRemainingChars !== undefined ? { minRemainingCharsToResume: bargeInMinRemainingChars } : {}),
                  ...(bargeInEscalatedMaxReplyChars !== undefined ? { escalatedMaxReplyChars: bargeInEscalatedMaxReplyChars } : {}),
                },
              }
            : {}),
          ...(ttsMaxChunkChars !== undefined || ttsMaxQueuedChunks !== undefined
            ? {
                ttsStream: {
                  ...(ttsMaxChunkChars !== undefined ? { maxChunkChars: ttsMaxChunkChars } : {}),
                  ...(ttsMaxQueuedChunks !== undefined ? { maxQueuedChunks: ttsMaxQueuedChunks } : {}),
                },
              }
            : {}),
          ...(thinkingTimeoutMs !== undefined || speakingMaxMs !== undefined || interruptedTimeoutMs !== undefined
            ? {
                turnTaking: {
                  ...(thinkingTimeoutMs !== undefined ? { thinkingTimeoutMs } : {}),
                  ...(speakingMaxMs !== undefined ? { speakingMaxMs } : {}),
                  ...(interruptedTimeoutMs !== undefined ? { interruptedTimeoutMs } : {}),
                },
              }
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
      'voice_v17_session_list',
      'List voice v17 sessions with state, turns, barge-ins, resumes and TTS first-chunk latency (read).',
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
            userId: s.userId ?? null,
            language: s.language,
            voiceContext: s.voiceContext,
            state: stats.state,
            turns: stats.turns,
            bargeIns: stats.bargeIns,
            resumes: stats.resumes,
            restarts: stats.restarts,
            summarises: stats.summarises,
            drops: stats.drops,
            firstChunkLatencyMs: stats.tts.averageFirstChunkLatencyMs,
            p95FirstChunkLatencyMs: stats.tts.p95FirstChunkLatencyMs,
            vadClass: s.vad.getClass(),
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
      'voice_v17_session_stats',
      'Full voice v17 stats for one session: VAD v5, barge-in v5, Smart Turn v4, TTS streaming v3, turn-taking v5 (read).',
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
      'voice_v17_session_stop',
      'Disconnect a voice v17 session (keeps the session for inspection) (local action).',
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
      'voice_v17_session_delete',
      'Disconnect and drop a voice v17 session (local action).',
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
      'voice_v17_talk',
      'Feed a final transcript to a voice v17 session: drives a full turn (Smart Turn v4 end → scripted reply → TTS streaming v3 sentence by sentence) (local action).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        text: { type: 'string', description: 'Final transcript text.' },
      },
      ['sessionId', 'text'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const text = getStringArg(args, 'text');
        session.feedTranscriptFinal(text);
        session.tick(600);
        session.feedSilence(600);
        await Promise.resolve();
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
      'voice_v17_barge_in',
      'Interrupt the speaking agent in a voice v17 session now: stops TTS at once and returns the cut receipt (spoken prefix + remaining text + turn context) with the resume plan (resume / restart / summarise / drop) (local action).',
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
        const interruptingText = getOptionalStringArg(args, 'interruptingText');
        const record = session.interrupt(session.now(), interruptingText);
        if (!record) return JSON.stringify({ cut: false, reason: 'agent is not speaking' }, null, 2);
        return JSON.stringify({ cut: true, record }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const vad: Tool = {
    definition: toolDef(
      'voice_v17_vad',
      'VAD v5 for one voice v17 session: current class (speech / silence / noise), probability, noise floors, segments, stats. Action feed sends synthetic frames (speech or silence) through the session mic path (local action when feeding).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Action: status or feed (default status).' },
        kind: { type: 'string', description: 'Frame kind for feed: speech or silence (default speech).' },
        frames: { type: 'number', description: 'How many 20 ms frames to feed (default 25).' },
        rms: { type: 'number', description: 'Frame energy 0..1 for feed (default 0.5 for speech, 0.001 for silence).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const action = getOptionalStringArg(args, 'action') ?? 'status';
        if (action === 'feed') {
          const kind = getOptionalStringArg(args, 'kind') ?? 'speech';
          if (kind !== 'speech' && kind !== 'silence') {
            throw new Error(`Unknown VAD feed kind "${kind}" (want speech or silence).`);
          }
          const frames = getOptionalNumberArg(args, 'frames') ?? 25;
          const rms = getOptionalNumberArg(args, 'rms') ?? (kind === 'speech' ? 0.5 : 0.001);
          for (let i = 0; i < frames; i += 1) {
            session.feedAudioFrame(syntheticFrameV15(rms, 320));
            session.tick(20);
          }
        } else if (action !== 'status') {
          throw new Error(`Unknown action "${action}" (want status or feed).`);
        }
        return JSON.stringify({
          sessionId: session.id,
          class: session.vad.getClass(),
          speaking: session.vad.isSpeaking(),
          probability: session.vad.getProbability(),
          lowFloor: session.vad.getLowFloor(),
          highFloor: session.vad.getHighFloor(),
          segments: session.vad.segmentsList(),
          stats: session.vad.stats(),
          markdown: session.vad.markdown(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tts: Tool = {
    definition: toolDef(
      'voice_v17_tts',
      'TTS streaming v3 for one voice v17 session: first-chunk latency (average + p95), queue, playout schedule. Action speak feeds text sentence by sentence (normal or urgent priority) (local action when speaking).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Action: status or speak (default status).' },
        text: { type: 'string', description: 'Text to speak (for speak).' },
        priority: { type: 'string', description: 'Chunk priority: urgent, normal or background (default normal).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const action = getOptionalStringArg(args, 'action') ?? 'status';
        if (action === 'speak') {
          const text = getStringArg(args, 'text');
          const priority = getOptionalStringArg(args, 'priority') ?? 'normal';
          if (!(TTS_PRIORITIES as readonly string[]).includes(priority)) {
            throw new Error(`Unknown TTS priority "${priority}" (want one of ${TTS_PRIORITIES.join(', ')}).`);
          }
          await session.speakReply(text, priority as 'urgent' | 'normal' | 'background');
          session.tick(1000);
        } else if (action !== 'status') {
          throw new Error(`Unknown action "${action}" (want status or speak).`);
        }
        return JSON.stringify({
          sessionId: session.id,
          state: session.getState(),
          tts: session.tts.stats(),
          schedule: session.tts.schedule(),
          markdown: session.tts.markdown(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profiles: Tool = {
    definition: toolDef(
      'voice_v17_profiles',
      'Multi-voice profiles v2 over the manager shared store: list, get, set, remove, set-default, get-default, resolve (user + bot + context fallback chain), presets, clone-for-user, export, import (local action when writing).',
      {
        action: { type: 'string', description: 'Action: list, get, set, remove, set-default, get-default, resolve, presets, clone, export or import (default list).' },
        profileId: { type: 'string', description: 'Profile id (for get, remove, set-default, get-default, clone).' },
        userId: { type: 'string', description: 'User id (for set, set-default, get-default, resolve, clone).' },
        botId: { type: 'string', description: 'Bot id (for set, resolve).' },
        context: { type: 'string', description: 'Voice context (for set, resolve).' },
        language: { type: 'string', description: 'Language code (for set, resolve, presets).' },
        displayName: { type: 'string', description: 'Display name (for set).' },
        provider: { type: 'string', description: 'TTS provider (for set, default mock).' },
        voiceId: { type: 'string', description: 'Voice id (for set, default default).' },
        rate: { type: 'number', description: 'Playback rate 0.5..2 (for set).' },
        pitch: { type: 'number', description: 'Pitch shift in semitones -12..12 (for set).' },
        quality: { type: 'string', description: 'Quality: high, fast or minimal (for set).' },
        maxChunkChars: { type: 'number', description: 'Max chars per streamed chunk (for set).' },
        newId: { type: 'string', description: 'New profile id (for clone).' },
        data: { type: 'string', description: 'Serialised store JSON string (for import).' },
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
          if (!profile) throw new Error(`Unknown voice profile v17 "${getStringArg(args, 'profileId')}".`);
          return JSON.stringify({ profile }, null, 2);
        }
        if (action === 'set') {
          const profileId = getStringArg(args, 'profileId');
          const botId = getOptionalStringArg(args, 'botId') ?? 'default-bot';
          const profile: VoiceProfileV17 = {
            id: profileId,
            botId,
            provider: getOptionalStringArg(args, 'provider') ?? 'mock',
            voiceId: getOptionalStringArg(args, 'voiceId') ?? 'default',
            language: getOptionalStringArg(args, 'language') ?? 'vi',
            rate: getOptionalNumberArg(args, 'rate') ?? 1,
            pitch: getOptionalNumberArg(args, 'pitch') ?? 0,
            quality: (getOptionalStringArg(args, 'quality') ?? 'high') as 'high' | 'fast' | 'minimal',
            maxChunkChars: getOptionalNumberArg(args, 'maxChunkChars') ?? 120,
            displayName: getOptionalStringArg(args, 'displayName') ?? profileId,
            ...(getOptionalStringArg(args, 'userId') !== undefined ? { userId: getOptionalStringArg(args, 'userId') as string } : {}),
            ...(getOptionalStringArg(args, 'context') !== undefined
              ? { context: getOptionalStringArg(args, 'context') as VoiceProfileV17Context }
              : {}),
          };
          const quality = getOptionalStringArg(args, 'quality');
          if (quality !== undefined && !(PROFILE_QUALITIES as readonly string[]).includes(quality)) {
            throw new Error(`Unknown quality "${quality}" (want one of ${PROFILE_QUALITIES.join(', ')}).`);
          }
          const context = getOptionalStringArg(args, 'context');
          if (context !== undefined && !isVoiceProfileV17Context(context)) {
            throw new Error(`Unknown voice context "${context}" (want one of ${VOICE_CONTEXTS.join(', ')}).`);
          }
          const errors = validateVoiceProfileV17(profile);
          if (errors.length > 0) throw new Error(`invalid voice profile v17: ${errors.join('; ')}`);
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
            ...(getOptionalStringArg(args, 'context') !== undefined
              ? { context: getOptionalStringArg(args, 'context') as VoiceProfileV17Context }
              : {}),
            ...(getOptionalStringArg(args, 'language') !== undefined ? { language: getOptionalStringArg(args, 'language') as string } : {}),
          });
          return JSON.stringify({ profile: result.profile, via: result.via }, null, 2);
        }
        if (action === 'presets') {
          const botId = getOptionalStringArg(args, 'botId') ?? 'default-bot';
          return JSON.stringify({ presets: presetVoiceProfilesV17(botId) }, null, 2);
        }
        if (action === 'clone') {
          const profileId = getStringArg(args, 'profileId');
          const userId = getStringArg(args, 'userId');
          const newId = getOptionalStringArg(args, 'newId');
          const clone = store.cloneForUser(profileId, userId, newId);
          return JSON.stringify({ cloned: true, profile: clone }, null, 2);
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
        throw new Error(`Unknown action "${action}" (want list, get, set, remove, set-default, get-default, resolve, presets, clone, export or import).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, talk, bargeIn, vad, tts, profiles];
}

/** Unbound placeholder (own default manager — mock sessions only). */
export const VOICE_V17_TOOLS: Tool[] = createVoiceV17Tools();

export const VOICE_V17_TOOL_NAMES = [
  'voice_v17_session_create',
  'voice_v17_session_list',
  'voice_v17_session_stats',
  'voice_v17_session_stop',
  'voice_v17_session_delete',
  'voice_v17_talk',
  'voice_v17_barge_in',
  'voice_v17_vad',
  'voice_v17_tts',
  'voice_v17_profiles',
] as const;

export function isVoiceV17ToolName(name: string): name is (typeof VOICE_V17_TOOL_NAMES)[number] {
  return (VOICE_V17_TOOL_NAMES as readonly string[]).includes(name);
}
