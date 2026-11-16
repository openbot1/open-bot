/**
 * Voice v12 tools for @open-bot/tools (v1.13, Đội T5).
 *
 * The agent drives the voice v12 sessions by tool call:
 *  - voice_v12_session_create  — create a v12 session (bot + language
 *    + voice + VAD v11 preset + barge-in policy + overlap policy +
 *    mock reply), optionally connected at once (local action)
 *  - voice_v12_session_list    — sessions + status + turn-machine
 *    state + overlaps + interrupts (read)
 *  - voice_v12_session_stats   — full v12 stats (turn machine,
 *    end-of-turn, overlap, interrupt context, planned TTS) (read)
 *  - voice_v12_session_stop    — disconnect (keeps the session for inspection) (local action)
 *  - voice_v12_session_delete  — disconnect + drop the session (local action)
 *  - voice_v12_interrupt_context — the last interrupted utterance:
 *    cut word, played vs remaining text, user interruption words,
 *    resume strategy + prompt; optionally set the strategy and
 *    resume the reply (local action when resuming)
 *  - voice_v12_overlap_report  — overlap segments (who won, agent
 *    words lost, user words), ducking volume, backchannels (read)
 *  - voice_v12_turn_status     — turn-machine state + end-of-turn
 *    detector + planned TTS chunks with word timings (read)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only (scripted replies, mock sine TTS). A host
 * that binds a live synth to a session must do so explicitly;
 * these tools never dial a provider themselves and never touch
 * a key.
 *
 * Factory:
 *   createVoiceV12Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V12_TOOLS                       (unbound placeholder)
 *
 * NOTE: these tools are NOT wired into the central ALL_TOOLS
 * registry here — the release coordinator connects them after
 * the v1.13 merge (same as every other team's module).
 */
import type { Tool } from '@open-bot/core';
import {
  isVadV11PresetName,
  isBargeInV11Policy,
  isOverlapV12Policy,
  isBargeInV12ResumeStrategy,
  type VadV11PresetName,
  type BargeInV11Policy,
  type OverlapV12Policy,
  type BargeInV12ResumeStrategy,
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

/** What the tools need from one v12 session (the v12 session fits). */
export interface VoiceV12SessionLike {
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
  noteUserWord(word: string, atMs?: number, confidence?: number): void;
  resumeReply(strategy?: BargeInV12ResumeStrategy): boolean;
  getLastInterrupt(): unknown;
  getLastPlan(): unknown;
  getVolume(): number;
}

/** What the tools need from the session manager. */
export interface VoiceV12ManagerLike {
  create(options: {
    sessionId: string;
    botId?: string;
    language?: string;
    voice?: string;
    vad?: Record<string, unknown>;
    bargeIn?: Record<string, unknown>;
    overlap?: Record<string, unknown>;
    mockReplies?: string[];
    connectNow?: boolean;
  }): VoiceV12SessionLike;
  get(sessionId: string): VoiceV12SessionLike | undefined;
  remove(sessionId: string): boolean;
  list(): VoiceV12SessionLike[];
  ids(): string[];
  size(): number;
}

export interface VoiceV12ToolOptions {
  /** Manager accessor (the host binds its VoiceV12Manager). */
  getManager?: () => VoiceV12ManagerLike | null;
}

const VAD_V11_PRESET_NAMES: VadV11PresetName[] = ['quiet', 'office', 'noisy', 'street'];
const BARGE_IN_V11_POLICIES: BargeInV11Policy[] = ['immediate', 'grace', 'confirm', 'smart'];
const OVERLAP_V12_POLICIES: OverlapV12Policy[] = ['user-wins', 'agent-keeps', 'confirm'];
const BARGE_IN_V12_STRATEGIES: BargeInV12ResumeStrategy[] = ['continue', 'restart', 'summarize', 'drop'];

export function createVoiceV12Tools(opts: VoiceV12ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV12ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v12 session manager is not available in this session (host must pass getManager to createVoiceV12Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV12ManagerLike, sessionId: string): VoiceV12SessionLike => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v12 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v12_session_create',
      'Create a voice v12 realtime session (local action): mock session on the given bot, language, voice, VAD v11 preset, barge-in policy and overlap policy (default user-wins). Pass connect=true to start listening at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default").' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "en").' },
        voice: { type: 'string', description: 'Voice id (default: the provider default).' },
        vadPreset: { type: 'string', description: 'VAD v11 preset: quiet, office, noisy or street (default office).' },
        bargeInPolicy: { type: 'string', description: 'Barge-in policy: immediate, grace, confirm or smart (default smart).' },
        overlapPolicy: { type: 'string', description: 'Overlap policy: user-wins, agent-keeps or confirm (default user-wins).' },
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
        const overlapPolicy = getOptionalStringArg(args, 'overlapPolicy');
        if (overlapPolicy !== undefined && !isOverlapV12Policy(overlapPolicy)) {
          throw new Error(`Unknown overlap v12 policy "${overlapPolicy}" (want one of ${OVERLAP_V12_POLICIES.join(', ')}).`);
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
          ...(overlapPolicy !== undefined ? { overlap: { policy: overlapPolicy } } : {}),
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
      'voice_v12_session_list',
      'List voice v12 sessions with status, turn-machine state, overlaps, interrupts and resume counts (read).',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const manager = needManager();
        const sessions = manager.list().map((session) => {
          const stats = session.getStats() as Record<string, unknown>;
          const turnMachine = (stats['turnMachine'] ?? {}) as Record<string, unknown>;
          const overlap = (stats['overlap'] ?? {}) as Record<string, unknown>;
          const bargeInV12 = (stats['bargeInV12'] ?? {}) as Record<string, unknown>;
          return {
            sessionId: stats['sessionId'],
            status: session.getStatus(),
            turnMachineState: turnMachine['state'],
            turns: stats['turns'],
            userTurns: stats['userTurns'],
            agentTurns: stats['agentTurns'],
            interrupts: stats['interrupts'],
            overlaps: overlap['overlaps'],
            userWins: overlap['userWins'],
            agentKeeps: overlap['agentKeeps'],
            resumes: stats['resumes'],
            drops: stats['drops'],
            resumeByStrategy: bargeInV12['byStrategy'],
            volume: session.getVolume(),
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
      'voice_v12_session_stats',
      'Full v12 stats for one session: turn machine (state, timeouts), end-of-turn detector, overlap tracker (segments, duck volume), interrupt context (resume strategies) and planned TTS chunks (read).',
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
      'voice_v12_session_stop',
      'Disconnect a voice v12 session (local action). The session stays registered for inspection until deleted.',
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
      'voice_v12_session_delete',
      'Disconnect and drop a voice v12 session (local action).',
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

  const interruptContext: Tool = {
    definition: toolDef(
      'voice_v12_interrupt_context',
      'The last interrupted utterance (read): cut word, played vs remaining text, the user words that interrupted, resume strategy + resume prompt. Pass resume=true to speak the resume text under the recorded strategy (local action), or strategy=continue|restart|summarize|drop to override it first. Pass userWord to feed one partial-STT word the user spoke while interrupting.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        resume: { type: 'boolean', description: 'Resume the interrupted reply (default false).' },
        strategy: { type: 'string', description: 'Override the resume strategy: continue, restart, summarize or drop (optional).' },
        userWord: { type: 'string', description: 'One partial-STT word the user spoke while interrupting (optional).' },
        confidence: { type: 'number', description: 'Confidence of userWord, 0..1 (default 1).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const userWord = getOptionalStringArg(args, 'userWord');
        if (userWord !== undefined) {
          const confidence = getOptionalNumberArg(args, 'confidence') ?? 1;
          session.noteUserWord(userWord, undefined, confidence);
          return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), notedWord: userWord }, null, 2);
        }
        const strategy = getOptionalStringArg(args, 'strategy');
        if (strategy !== undefined && !isBargeInV12ResumeStrategy(strategy)) {
          throw new Error(`Unknown resume strategy "${strategy}" (want one of ${BARGE_IN_V12_STRATEGIES.join(', ')}).`);
        }
        const resume = getOptionalBooleanArg(args, 'resume') ?? false;
        if (resume) {
          const resumed = session.resumeReply(strategy as BargeInV12ResumeStrategy | undefined);
          return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), resumed, summary: session.getSummary() }, null, 2);
        }
        const last = session.getLastInterrupt() as Record<string, unknown> | null;
        if (!last) {
          return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), interrupted: false, reason: 'no interrupt recorded yet' }, null, 2);
        }
        if (strategy !== undefined) {
          // Strategy override without resuming: report what the
          // resume would be (the session applies the override on
          // the next resumeReply call).
          return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), interrupt: last, requestedStrategy: strategy }, null, 2);
        }
        return JSON.stringify({ sessionId: getStringArg(args, 'sessionId'), interrupt: last }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const overlapReport: Tool = {
    definition: toolDef(
      'voice_v12_overlap_report',
      'Overlap report for one session (read): segments (who won, agent words lost, user words, duration), ducking volume now, backchannels, total overlapped ms.',
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
        const stats = session.getStats() as Record<string, unknown>;
        const overlap = (stats['overlap'] ?? {}) as Record<string, unknown>;
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          volume: session.getVolume(),
          overlap,
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const turnStatus: Tool = {
    definition: toolDef(
      'voice_v12_turn_status',
      'Turn status for one session (read): turn-machine state + history counts, end-of-turn detector (turns, backchannels, false starts, merged pauses), and the planned TTS chunks of the last reply with per-word timings and prosody pauses.',
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
        const stats = session.getStats() as Record<string, unknown>;
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          status: session.getStatus(),
          turnMachine: stats['turnMachine'],
          endOfTurn: stats['endOfTurn'],
          plannedChunks: session.getLastPlan(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, interruptContext, overlapReport, turnStatus];
}

/** Unbound placeholder (the host binds a manager via createVoiceV12Tools). */
export const VOICE_V12_TOOLS: Tool[] = createVoiceV12Tools();

export const VOICE_V12_TOOL_NAMES = [
  'voice_v12_session_create',
  'voice_v12_session_list',
  'voice_v12_session_stats',
  'voice_v12_session_stop',
  'voice_v12_session_delete',
  'voice_v12_interrupt_context',
  'voice_v12_overlap_report',
  'voice_v12_turn_status',
] as const;

export function isVoiceV12ToolName(name: string): name is (typeof VOICE_V12_TOOL_NAMES)[number] {
  return (VOICE_V12_TOOL_NAMES as readonly string[]).includes(name);
}
