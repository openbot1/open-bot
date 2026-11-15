/**
 * Voice v6 tools for @open-bot/tools (v1.07, Team T5).
 *
 * The agent drives the voice v6 sessions by tool call:
 *  - voice_v6_state           — explicit call state (listening /
 *    speaking / interrupted / reconnecting / degraded / ...) +
 *    current voice + network summary (read)
 *  - voice_v6_list_voices     — switchable voices (read)
 *  - voice_v6_switch_voice    — switch voice, live or pre-call
 *    (local action)
 *  - voice_v6_revert_voice    — back to the voice before the last
 *    switch (local action)
 *  - voice_v6_network_status  — network guard stats + recent
 *    decisions, one session or the whole manager (read)
 *  - voice_v6_reconnect       — reconnect a dropped call with the
 *    last config, through the network guard (local action)
 *  - voice_v6_session_stats   — full v6 stats (state + voice +
 *    network + v4 latency/turns) (read)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only. A host that binds a live-transport
 * factory to the manager must do so explicitly; these tools
 * never dial a provider themselves and never touch a key.
 *
 * Factory:
 *   createVoiceV6Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V6_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';

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

/** What the tools need from one v6 session (the v6 wrapper fits). */
export interface VoiceV6SessionLike {
  getCallState(): string;
  isConnected(): boolean;
  getCurrentVoice(): { id: string; name: string; lang: string; rate: number } | null;
  listVoices(): Array<{ id: string; name: string; lang: string; rate: number }>;
  switchVoice(profileId: string, reason?: string): { ok: boolean; reason?: string; record?: unknown };
  revertVoice(): { ok: boolean; reason?: string; record?: unknown };
  getV6Stats(): unknown;
  getNetworkStats(): unknown;
  getNetworkDecisions(): unknown;
  reconnect(): Promise<{ ok: boolean; attempts: number; error?: string }>;
}

/** What the tools need from the session manager. */
export interface VoiceV6ManagerLike {
  createSession(
    id: string,
    options?: { provider?: string; initialVoiceId?: string },
  ): VoiceV6SessionLike;
  getSession(id: string): VoiceV6SessionLike | undefined;
  removeSession(id: string): boolean;
  listSessions(): Array<{ id: string; callState: string; voiceId: string | null; connected: boolean }>;
  listVoices(): Array<{ id: string; name: string; lang: string; rate: number }>;
  getStats(): unknown;
}

export interface VoiceV6ToolOptions {
  /** Manager accessor (the host binds its VoiceV6Manager). */
  getManager?: () => VoiceV6ManagerLike | null;
}

export function createVoiceV6Tools(opts: VoiceV6ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV6ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v6 session manager is not available in this session (host must pass getManager to createVoiceV6Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV6ManagerLike, sessionId: string): VoiceV6SessionLike => {
    const session = manager.getSession(sessionId);
    if (!session) throw new Error(`Unknown voice v6 session "${sessionId}".`);
    return session;
  };

  const state: Tool = {
    definition: toolDef(
      'voice_v6_state',
      'Voice v6 call state (read): explicit state (idle / connecting / listening / speaking / interrupted / reconnecting / degraded / ended), current voice, connected or not, network summary.',
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
        const stats = session.getV6Stats() as {
          callState: string;
          msInState: number;
          voice: { currentId: string | null; currentName: string | null; switches: number };
          network: { degraded: boolean; consecutiveFailures: number; gaveUp: boolean; lastKind: string | null };
        };
        return JSON.stringify(
          {
            sessionId,
            callState: stats.callState,
            msInState: stats.msInState,
            connected: session.isConnected(),
            voiceId: stats.voice.currentId,
            voiceName: stats.voice.currentName,
            voiceSwitches: stats.voice.switches,
            networkDegraded: stats.network.degraded,
            networkFailures: stats.network.consecutiveFailures,
            networkGaveUp: stats.network.gaveUp,
            networkLastKind: stats.network.lastKind,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listVoices: Tool = {
    definition: toolDef(
      'voice_v6_list_voices',
      'List the voices a v6 call can switch to (read): id, display name, language, speaking rate. Pass a sessionId to see the session\'s current voice first.',
      {
        sessionId: { type: 'string', description: 'Id of the session (optional).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const voices = sessionId
          ? needSession(manager, sessionId).listVoices()
          : manager.listVoices();
        const currentId = sessionId ? needSession(manager, sessionId).getCurrentVoice()?.id ?? null : null;
        return JSON.stringify({ sessionId: sessionId ?? null, currentId, voices }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const switchVoice: Tool = {
    definition: toolDef(
      'voice_v6_switch_voice',
      'Switch the voice of a v6 call (local action): works before the call (picks the voice it will use) and mid-call (switches live). Returns the switch record, or the reason it was refused (unknown voice, already active).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        profileId: { type: 'string', description: 'Voice id, e.g. "vi-nam", "en-us", "slow-clear".' },
        reason: { type: 'string', description: 'Why the switch happened (optional, recorded in history).' },
      },
      ['sessionId', 'profileId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const profileId = getStringArg(args, 'profileId');
        const reason = getOptionalStringArg(args, 'reason');
        const session = needSession(manager, sessionId);
        const result = session.switchVoice(profileId, reason ?? 'tool call');
        if (!result.ok) {
          return JSON.stringify({ switched: false, sessionId, profileId, reason: result.reason }, null, 2);
        }
        return JSON.stringify(
          { switched: true, sessionId, record: result.record },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const revertVoice: Tool = {
    definition: toolDef(
      'voice_v6_revert_voice',
      'Revert a v6 call to the voice before the last switch (local action). Fails when nothing was switched yet.',
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
        const result = session.revertVoice();
        if (!result.ok) {
          return JSON.stringify({ reverted: false, sessionId, reason: result.reason }, null, 2);
        }
        return JSON.stringify(
          { reverted: true, sessionId, record: result.record },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const networkStatus: Tool = {
    definition: toolDef(
      'voice_v6_network_status',
      'Voice v6 network guard status (read): consecutive failures, degraded or not, gave up or not, last failure kind, recent decisions. Pass a sessionId for one call, or none for the whole manager.',
      {
        sessionId: { type: 'string', description: 'Id of the session (optional).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getOptionalStringArg(args, 'sessionId');
        if (!sessionId) {
          return JSON.stringify({ sessionId: null, manager: manager.getStats() }, null, 2);
        }
        const session = needSession(manager, sessionId);
        const decisions = session.getNetworkDecisions() as unknown[];
        return JSON.stringify(
          {
            sessionId,
            network: session.getNetworkStats(),
            recentDecisions: decisions.slice(-10),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const reconnect: Tool = {
    definition: toolDef(
      'voice_v6_reconnect',
      'Reconnect a dropped v6 call with its last config, through the network guard (local action). A live call is a no-op. Returns whether the call is live again and how many guard attempts it spent.',
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
        const result = await session.reconnect();
        return JSON.stringify({ sessionId, ...result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionStats: Tool = {
    definition: toolDef(
      'voice_v6_session_stats',
      'Full voice v6 stats for one session (read): call state, voice switches, network guard, v4 latency / turns / checkpoints.',
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
        return JSON.stringify({ sessionId, stats: session.getV6Stats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [state, listVoices, switchVoice, revertVoice, networkStatus, reconnect, sessionStats];
}

/** Unbound placeholder (same shape as VOICE_V4_TOOLS). */
export const VOICE_V6_TOOLS: Tool[] = createVoiceV6Tools();

/** Names of the voice v6 tools (for the coordinator/registry checks). */
export const VOICE_V6_TOOL_NAMES = [
  'voice_v6_state',
  'voice_v6_list_voices',
  'voice_v6_switch_voice',
  'voice_v6_revert_voice',
  'voice_v6_network_status',
  'voice_v6_reconnect',
  'voice_v6_session_stats',
] as const;

/** True when the name is one of the voice v6 tools. */
export function isVoiceV6ToolName(name: string): name is (typeof VOICE_V6_TOOL_NAMES)[number] {
  return (VOICE_V6_TOOL_NAMES as readonly string[]).includes(name);
}
