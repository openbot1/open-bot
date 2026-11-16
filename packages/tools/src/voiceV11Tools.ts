/**
 * Voice v11 tools for @open-bot/tools (v1.12, Đội T5).
 *
 * The agent drives the voice v11 sessions by tool call:
 *  - voice_v11_session_create  — create a v11 session (bot + language
 *    + voice + VAD v11 preset + barge-in policy + mock reply),
 *    optionally connected at once (local action)
 *  - voice_v11_session_list    — sessions + status + floor + turns (read)
 *  - voice_v11_session_stats   — full v11 stats (VAD v11 + barge-in
 *    v11 + turn-taking v11 + TTS stream v11) (read)
 *  - voice_v11_session_stop    — disconnect (keeps the session for inspection) (local action)
 *  - voice_v11_session_delete  — disconnect + drop the session (local action)
 *  - voice_v11_feed_text       — stream reply text into the TTS queue
 *    (delta + final flush) or start a full mock reply (local action)
 *  - voice_v11_interrupt       — cut the agent reply now (barge-in
 *    receipt + TTS cancel receipt) (local action)
 *  - voice_v11_vad             — VAD v11 status (probability, floors,
 *    calibration, turns), or live preset switch (local action when
 *    configuring, read otherwise)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only (scripted replies, mock sine TTS). A host
 * that binds a live synth to a session must do so explicitly;
 * these tools never dial a provider themselves and never touch
 * a key.
 *
 * Factory:
 *   createVoiceV11Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V11_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  isVadV11PresetName,
  isBargeInV11Policy,
  type VadV11PresetName,
  type BargeInV11Policy,
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

/** What the tools need from one v11 session (the v11 session fits). */
export interface VoiceV11SessionLike {
  getStatus(): string;
  getSummary(): string;
  getStats(): unknown;
  connect(): Promise<void>;
  disconnect(): void;
  tick(ms: number): void;
  speakReply(text: string): boolean;
  simulateTurn(userText: string, modelReply?: string): Promise<boolean>;
  interrupt(reason?: string): unknown;
  duck(): boolean;
  resumePlayback(): boolean;
  feedTextDelta(delta: string, input?: { final?: boolean }): { chunksReady: number; bufferedChars: number; queuedChunks: number; droppedChars: number };
  setVadPreset(preset: VadV11PresetName): unknown;
}

/** What the tools need from the session manager. */
export interface VoiceV11ManagerLike {
  create(options: {
    sessionId: string;
    botId?: string;
    language?: string;
    voice?: string;
    vad?: Record<string, unknown>;
    bargeIn?: Record<string, unknown>;
    mockReplies?: string[];
    connectNow?: boolean;
  }): VoiceV11SessionLike;
  get(sessionId: string): VoiceV11SessionLike | undefined;
  remove(sessionId: string): boolean;
  list(): VoiceV11SessionLike[];
  ids(): string[];
  size(): number;
}

export interface VoiceV11ToolOptions {
  /** Manager accessor (the host binds its VoiceV11Manager). */
  getManager?: () => VoiceV11ManagerLike | null;
}

const VAD_V11_PRESET_NAMES: VadV11PresetName[] = ['quiet', 'office', 'noisy', 'street'];
const BARGE_IN_V11_POLICIES: BargeInV11Policy[] = ['immediate', 'grace', 'confirm', 'smart'];

export function createVoiceV11Tools(opts: VoiceV11ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV11ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v11 session manager is not available in this session (host must pass getManager to createVoiceV11Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV11ManagerLike, sessionId: string): VoiceV11SessionLike => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v11 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v11_session_create',
      'Create a voice v11 realtime session (local action): mock session on the given bot, language, voice, VAD v11 preset and barge-in policy (default smart). Pass connect=true to start listening at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default").' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "en").' },
        voice: { type: 'string', description: 'Voice id (default: the provider default).' },
        vadPreset: { type: 'string', description: 'VAD v11 preset: quiet, office, noisy or street (default office).' },
        bargeInPolicy: { type: 'string', description: 'Barge-in policy: immediate, grace, confirm or smart (default smart).' },
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
        const vadPreset = getOptionalStringArg(args, 'vadPreset');
        if (vadPreset !== undefined && !isVadV11PresetName(vadPreset)) {
          throw new Error(`Unknown VAD v11 preset "${vadPreset}" (want one of ${VAD_V11_PRESET_NAMES.join(', ')}).`);
        }
        const bargeInPolicy = getOptionalStringArg(args, 'bargeInPolicy');
        if (bargeInPolicy !== undefined && !isBargeInV11Policy(bargeInPolicy)) {
          throw new Error(`Unknown barge-in v11 policy "${bargeInPolicy}" (want one of ${BARGE_IN_V11_POLICIES.join(', ')}).`);
        }
        const mockReply = getOptionalStringArg(args, 'mockReply');
        const connectNow = getOptionalBooleanArg(args, 'connect') ?? false;
        const session = manager.create({
          sessionId,
          ...(botId !== undefined ? { botId } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(voice !== undefined ? { voice } : {}),
          ...(vadPreset !== undefined ? { vad: { preset: vadPreset } } : {}),
          ...(bargeInPolicy !== undefined ? { bargeIn: { policy: bargeInPolicy } } : {}),
          ...(mockReply !== undefined ? { mockReplies: [mockReply] } : {}),
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
      'voice_v11_session_list',
      'List voice v11 sessions with status, floor, turns, interrupts and TTS chunks (read).',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const manager = needManager();
        const sessions = manager.list().map((session) => {
          const stats = session.getStats() as Record<string, unknown>;
          const turnTaking = (stats['turnTaking'] ?? {}) as Record<string, unknown>;
          const tts = (stats['tts'] ?? {}) as Record<string, unknown>;
          return {
            sessionId: stats['sessionId'],
            status: session.getStatus(),
            floor: turnTaking['floor'],
            turns: stats['turns'],
            userTurns: stats['userTurns'],
            agentTurns: stats['agentTurns'],
            interrupts: stats['interrupts'],
            ducks: stats['ducks'],
            replies: stats['replies'],
            ttsChunks: tts['chunks'],
            ttsChunksDone: tts['chunksDone'],
          };
        });
        return JSON.stringify({ count: sessions.length, sessions }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionStats: Tool = {
    definition: toolDef(
      'voice_v11_session_stats',
      'Full v11 stats for one session: VAD v11 (probability, floors, calibration), barge-in v11 (state, latency), turn-taking v11 (floor, switch latency) and TTS stream v11 (chunks, played ms) (read).',
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
        return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), summary: session.getSummary(), stats: session.getStats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stop: Tool = {
    definition: toolDef(
      'voice_v11_session_stop',
      'Disconnect a voice v11 session (local action). The session stays registered for inspection until deleted.',
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
        return JSON.stringify({ stopped: true, sessionId: getStringArg(args, 'sessionId'), status: session.getStatus() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const remove: Tool = {
    definition: toolDef(
      'voice_v11_session_delete',
      'Disconnect and drop a voice v11 session (local action).',
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
        const deleted = manager.remove(sessionId);
        return JSON.stringify({ deleted, sessionId, remaining: manager.size() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const feedText: Tool = {
    definition: toolDef(
      'voice_v11_feed_text',
      'Stream reply text into a v11 session (local action): either feed one text delta into the TTS stream (chunks form at sentence boundaries; pass final=true to flush the tail) or start a full mock reply with replyText (the agent speaks it chunk by chunk).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        delta: { type: 'string', description: 'Text delta to stream into the TTS queue (optional when replyText is given).' },
        final: { type: 'boolean', description: 'Flush the buffered tail as a last chunk (default false).' },
        replyText: { type: 'string', description: 'Full reply text to speak (starts an agent turn; optional).' },
        tickMs: { type: 'number', description: 'Virtual ms to advance playback after feeding (default 0).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const replyText = getOptionalStringArg(args, 'replyText');
        if (replyText !== undefined) {
          const started = session.speakReply(replyText);
          return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), replyStarted: started, summary: session.getSummary() }, null, 2);
        }
        const delta = getStringArg(args, 'delta', false);
        const final = getOptionalBooleanArg(args, 'final') ?? false;
        const fed = session.feedTextDelta(delta, { final });
        const tickMs = args['tickMs'];
        if (typeof tickMs === 'number' && tickMs > 0) session.tick(tickMs);
        return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), ...fed, status: session.getStatus() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const interruptTool: Tool = {
    definition: toolDef(
      'voice_v11_interrupt',
      'Cut the agent reply now (local action): returns the barge-in receipt (cut word, played vs discarded ms, latency) and the TTS cancel receipt (chunks/chars discarded).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        reason: { type: 'string', description: 'Why the reply is cut (default "user").' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const reason = getOptionalStringArg(args, 'reason') ?? 'user';
        const result = session.interrupt(reason);
        if (!result) {
          return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), interrupted: false, reason: 'not speaking or thinking' }, null, 2);
        }
        return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), ...result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const vad: Tool = {
    definition: toolDef(
      'voice_v11_vad',
      'VAD v11 status (read) or live preset switch (local action when configuring): probability, noise floors, calibration state, turns, merged pauses, hum/hiss rejections.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        preset: { type: 'string', description: 'VAD v11 preset to switch to: quiet, office, noisy or street (optional; when omitted, returns the current status).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const preset = getOptionalStringArg(args, 'preset');
        if (preset !== undefined) {
          if (!isVadV11PresetName(preset)) {
            throw new Error(`Unknown VAD v11 preset "${preset}" (want one of ${VAD_V11_PRESET_NAMES.join(', ')}).`);
          }
          const next = session.setVadPreset(preset);
          return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), preset, options: next }, null, 2);
        }
        const stats = session.getStats() as Record<string, unknown>;
        return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), vad: stats['vad'] }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, feedText, interruptTool, vad];
}

/** Unbound placeholder (the host binds a manager via createVoiceV11Tools). */
export const VOICE_V11_TOOLS: Tool[] = createVoiceV11Tools();

export const VOICE_V11_TOOL_NAMES = [
  'voice_v11_session_create',
  'voice_v11_session_list',
  'voice_v11_session_stats',
  'voice_v11_session_stop',
  'voice_v11_session_delete',
  'voice_v11_feed_text',
  'voice_v11_interrupt',
  'voice_v11_vad',
] as const;

export function isVoiceV11ToolName(name: string): name is (typeof VOICE_V11_TOOL_NAMES)[number] {
  return (VOICE_V11_TOOL_NAMES as readonly string[]).includes(name);
}
