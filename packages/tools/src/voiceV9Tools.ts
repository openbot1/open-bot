/**
 * Voice v9 tools for @open-bot/tools (v1.10, Đội T5).
 *
 * The agent drives the voice v9 sessions by tool call:
 *  - voice_v9_session_create  — create a mock v9 session (bot +
 *    language + voice + VAD preset + barge-in policy + input mode
 *    auto/push-to-talk), optionally connected at once (local action)
 *  - voice_v9_session_list    — sessions + status + mode + turns (read)
 *  - voice_v9_session_stats   — full v9 stats (status + VAD v9 +
 *    barge-in v9 + transcript + cut point) (read)
 *  - voice_v9_session_stop    — disconnect (keeps the session for inspection) (local action)
 *  - voice_v9_session_delete  — disconnect + drop the session (local action)
 *  - voice_v9_simulate_turn   — drive one scripted mock turn
 *    (user line → processing → agent words streaming in, with
 *    scripted tool calls mid-speech) (local action)
 *  - voice_v9_vad             — VAD v9 status, or live preset switch (local action when configuring, read otherwise)
 *  - voice_v9_barge_in        — barge-in v9 status / force interrupt /
 *    duck / resume playback (local action)
 *  - voice_v9_ptt             — push-to-talk press / release / status,
 *    and switching the input mode auto <-> push-to-talk (local action)
 *  - voice_v9_live_probe      — is a live provider key already in the
 *    Vault? Gate only: reports availability, never reads a key and
 *    never dials (read)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only. A host that binds a live-transport
 * factory to the manager must do so explicitly; these tools
 * never dial a provider themselves and never touch a key.
 *
 * Factory:
 *   createVoiceV9Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V9_TOOLS                       (unbound placeholder)
 *
 * NOTE (v1.10 merge): these tools are exported from the tools
 * package but NOT yet wired into defaultToolFactory — the
 * coordinator wires createVoiceV9Tools into the coordinator and
 * recounts the 556 tool pin (see the wave report).
 */
import type { Tool } from '@open-bot/core';
import { isVadV9PresetName, isBargeInV9Policy, type VadV9PresetName, type BargeInV9Policy } from '@open-bot/core';

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

/** What the tools need from one v9 session (the v9 session fits). */
export interface VoiceV9SessionLike {
  getStatus(): string;
  getInputMode(): string;
  setInputMode(mode: 'auto' | 'push-to-talk'): string;
  ptt(pressed: boolean): Promise<boolean>;
  isPttPressed(): boolean;
  connect(): void;
  disconnect(): void;
  getStats(): unknown;
  getSummary(): unknown;
  getTurns(): unknown[];
  transcriptMarkdown(): string;
  getVadOptions(): unknown;
  setVadPreset(preset: VadV9PresetName): unknown;
  getBargeInOptions(): unknown;
  setBargeInPolicy(policy: BargeInV9Policy): unknown;
  getLastInterrupt(): unknown;
  duck(): boolean;
  resumePlayback(): boolean;
  interrupt(reason?: string): unknown;
  simulateTurn(userText: string, modelReply?: string): Promise<boolean>;
  liveProbe(hasKey: () => boolean): unknown;
}

/** What the tools need from the session manager. */
export interface VoiceV9ManagerLike {
  create(options: {
    sessionId: string;
    botId?: string;
    language?: string;
    voice?: string;
    inputMode?: 'auto' | 'push-to-talk';
    vad?: { preset?: string };
    bargeIn?: { policy?: string };
    mockReplies?: string[];
    connectNow?: boolean;
  }): VoiceV9SessionLike;
  get(sessionId: string): VoiceV9SessionLike | undefined;
  remove(sessionId: string): boolean;
  list(): VoiceV9SessionLike[];
  ids(): string[];
  size(): number;
}

export interface VoiceV9ToolOptions {
  /** Manager accessor (the host binds its VoiceV9Manager). */
  getManager?: () => VoiceV9ManagerLike | null;
  /**
   * Live-key check for voice_v9_live_probe. The default reports
   * "no key" — the host passes a Vault-backed check when it wants
   * a real answer. The predicate returns a boolean only; the key
   * itself is never read or returned.
   */
  hasLiveKey?: () => boolean;
}

const VAD_PRESET_NAMES: VadV9PresetName[] = ['quiet', 'office', 'noisy'];
const BARGE_IN_POLICIES: BargeInV9Policy[] = ['immediate', 'grace', 'confirm'];

export function createVoiceV9Tools(opts: VoiceV9ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV9ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v9 session manager is not available in this session (host must pass getManager to createVoiceV9Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV9ManagerLike, sessionId: string): VoiceV9SessionLike => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v9 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v9_session_create',
      'Create a voice v9 realtime session (local action): mock session on the given bot, language, voice, VAD preset, barge-in policy and input mode (auto hands-free or push-to-talk). Pass connect=true to start listening at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default").' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "en").' },
        voice: { type: 'string', description: 'Voice id (default "default").' },
        vadPreset: { type: 'string', description: 'VAD preset: quiet, office or noisy (default office).' },
        bargeInPolicy: { type: 'string', description: 'Barge-in policy: immediate, grace or confirm (default grace).' },
        inputMode: { type: 'string', description: 'Input mode: auto (hands-free) or push-to-talk (default auto).' },
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
        if (vadPreset !== undefined && !isVadV9PresetName(vadPreset)) {
          throw new Error(`Unknown VAD v9 preset "${vadPreset}" (want one of ${VAD_PRESET_NAMES.join(', ')}).`);
        }
        const bargeInPolicy = getOptionalStringArg(args, 'bargeInPolicy');
        if (bargeInPolicy !== undefined && !isBargeInV9Policy(bargeInPolicy)) {
          throw new Error(`Unknown barge-in v9 policy "${bargeInPolicy}" (want one of ${BARGE_IN_POLICIES.join(', ')}).`);
        }
        const inputMode = getOptionalStringArg(args, 'inputMode');
        if (inputMode !== undefined && inputMode !== 'auto' && inputMode !== 'push-to-talk') {
          throw new Error(`Unknown input mode "${inputMode}" (want "auto" or "push-to-talk").`);
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
          ...(inputMode !== undefined ? { inputMode } : {}),
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
      'voice_v9_session_list',
      'List voice v9 sessions with status, input mode, turns, tool calls and interrupts (read).',
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
            sessionId: (s as unknown as { sessionId: string }).sessionId,
            status: s.getStatus(),
            inputMode: s.getInputMode(),
            turns: stats['turns'],
            userTurns: stats['userTurns'],
            agentTurns: stats['agentTurns'],
            toolCalls: stats['toolCalls'],
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
      'voice_v9_session_stats',
      'Full v9 stats for one session: status, VAD v9, barge-in v9, transcript, cut point and the transcript as Markdown (read).',
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
        return JSON.stringify(
          {
            sessionId,
            stats: session.getStats(),
            lastInterrupt: session.getLastInterrupt(),
            transcriptMarkdown: session.transcriptMarkdown(),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stop: Tool = {
    definition: toolDef(
      'voice_v9_session_stop',
      'Disconnect a voice v9 session (local action). The session is kept for inspection; use voice_v9_session_delete to drop it.',
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
        return JSON.stringify({ sessionId, stopped: true, status: session.getStatus(), summary: session.getSummary() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const remove: Tool = {
    definition: toolDef(
      'voice_v9_session_delete',
      'Disconnect and drop a voice v9 session (local action).',
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
        return JSON.stringify({ sessionId, deleted: removed, remaining: manager.size() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const simulateTurn: Tool = {
    definition: toolDef(
      'voice_v9_simulate_turn',
      'Drive one scripted mock turn on a voice v9 session (local action): the user line finalizes, the model processes, then the reply streams word by word (barge-in watches the whole time). No provider, no network — for demos and tests.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        userText: { type: 'string', description: 'What the user says.' },
        modelReply: { type: 'string', description: 'What the model replies (optional, default mock reply).' },
      },
      ['sessionId', 'userText'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const session = needSession(manager, sessionId);
        const userText = getStringArg(args, 'userText');
        const modelReply = getOptionalStringArg(args, 'modelReply');
        const ok = await session.simulateTurn(userText, modelReply);
        return JSON.stringify({ sessionId, simulated: ok, summary: session.getSummary(), turns: session.getTurns() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const vad: Tool = {
    definition: toolDef(
      'voice_v9_vad',
      'VAD v9 status, or live preset switch (local action when configuring, read otherwise).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        preset: { type: 'string', description: 'VAD preset to switch to: quiet, office or noisy (optional; omit for status).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const session = needSession(manager, sessionId);
        const preset = getOptionalStringArg(args, 'preset');
        if (preset !== undefined) {
          if (!isVadV9PresetName(preset)) {
            throw new Error(`Unknown VAD v9 preset "${preset}" (want one of ${VAD_PRESET_NAMES.join(', ')}).`);
          }
          const options = session.setVadPreset(preset);
          return JSON.stringify({ sessionId, action: 'preset', preset, options }, null, 2);
        }
        return JSON.stringify({ sessionId, action: 'status', options: session.getVadOptions(), stats: (session.getStats() as Record<string, unknown>)['vad'] }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bargeIn: Tool = {
    definition: toolDef(
      'voice_v9_barge_in',
      'Barge-in v9 status, or force interrupt / duck / resume playback, or switch the interruption policy (local action).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Action: status, interrupt, duck, resume (default status).' },
        policy: { type: 'string', description: 'Barge-in policy to switch to: immediate, grace or confirm (optional; implies action=policy).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const session = needSession(manager, sessionId);
        const policy = getOptionalStringArg(args, 'policy');
        if (policy !== undefined) {
          if (!isBargeInV9Policy(policy)) {
            throw new Error(`Unknown barge-in v9 policy "${policy}" (want one of ${BARGE_IN_POLICIES.join(', ')}).`);
          }
          const options = session.setBargeInPolicy(policy);
          return JSON.stringify({ sessionId, action: 'policy', policy, options }, null, 2);
        }
        const action = getOptionalStringArg(args, 'action') ?? 'status';
        if (action === 'interrupt') {
          const result = session.interrupt('explicit');
          return JSON.stringify({ sessionId, action, result, status: session.getStatus() }, null, 2);
        }
        if (action === 'duck') {
          return JSON.stringify({ sessionId, action, ducked: session.duck() }, null, 2);
        }
        if (action === 'resume') {
          return JSON.stringify({ sessionId, action, resumed: session.resumePlayback() }, null, 2);
        }
        if (action !== 'status') throw new Error(`Unknown barge-in v9 action "${action}" (want status, interrupt, duck or resume).`);
        return JSON.stringify(
          { sessionId, action: 'status', options: session.getBargeInOptions(), stats: (session.getStats() as Record<string, unknown>)['bargeIn'], lastInterrupt: session.getLastInterrupt() },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const ptt: Tool = {
    definition: toolDef(
      'voice_v9_ptt',
      'Push-to-talk press / release / status, and switching the input mode auto <-> push-to-talk (local action).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Action: press, release, status, or set-mode (default status).' },
        inputMode: { type: 'string', description: 'Input mode for set-mode: auto or push-to-talk.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const session = needSession(manager, sessionId);
        const action = getOptionalStringArg(args, 'action') ?? 'status';
        if (action === 'set-mode') {
          const inputMode = getOptionalStringArg(args, 'inputMode');
          if (inputMode !== 'auto' && inputMode !== 'push-to-talk') {
            throw new Error(`Unknown input mode "${inputMode}" (want "auto" or "push-to-talk").`);
          }
          const mode = session.setInputMode(inputMode);
          return JSON.stringify({ sessionId, action, inputMode: mode, pressed: session.isPttPressed(), status: session.getStatus() }, null, 2);
        }
        if (action === 'press' || action === 'release') {
          const pressed = await session.ptt(action === 'press');
          return JSON.stringify({ sessionId, action, inputMode: session.getInputMode(), pressed, status: session.getStatus() }, null, 2);
        }
        if (action !== 'status') throw new Error(`Unknown PTT v9 action "${action}" (want press, release, status or set-mode).`);
        return JSON.stringify({ sessionId, action, inputMode: session.getInputMode(), pressed: session.isPttPressed(), status: session.getStatus() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const liveProbe: Tool = {
    definition: toolDef(
      'voice_v9_live_probe',
      'Check whether a live voice provider key is already available (read). Gate only: reports availability, never reads a key and never dials. Mock mode stays the default when no key is present.',
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
        const hasKey = opts.hasLiveKey ?? (() => false);
        const probe = session.liveProbe(hasKey) as { liveAvailable: boolean; reason: string; checkedAtMs: number };
        return JSON.stringify({ sessionId, liveAvailable: probe.liveAvailable, reason: probe.reason, checkedAtMs: probe.checkedAtMs }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, simulateTurn, vad, bargeIn, ptt, liveProbe];
}

/** Unbound placeholder (the host binds a manager via createVoiceV9Tools). */
export const VOICE_V9_TOOLS: Tool[] = createVoiceV9Tools();

export const VOICE_V9_TOOL_NAMES = [
  'voice_v9_session_create',
  'voice_v9_session_list',
  'voice_v9_session_stats',
  'voice_v9_session_stop',
  'voice_v9_session_delete',
  'voice_v9_simulate_turn',
  'voice_v9_vad',
  'voice_v9_barge_in',
  'voice_v9_ptt',
  'voice_v9_live_probe',
] as const;

export function isVoiceV9ToolName(name: string): name is (typeof VOICE_V9_TOOL_NAMES)[number] {
  return (VOICE_V9_TOOL_NAMES as readonly string[]).includes(name);
}
