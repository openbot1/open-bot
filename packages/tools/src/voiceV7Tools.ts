/**
 * Voice v7 tools for @open-bot/tools (v1.08, Đội T5).
 *
 * The agent drives the voice v7 sessions by tool call:
 *  - voice_v7_session_create  — create a mock v7 session (provider
 *    + voice + VAD preset), optionally connected at once (local action)
 *  - voice_v7_session_list    — sessions + state + duration + tokens (read)
 *  - voice_v7_session_stats   — full v7 stats (call state + phase +
 *    VAD + barge-in + transcript + v6) (read)
 *  - voice_v7_session_stop    — disconnect (keeps the session for inspection) (local action)
 *  - voice_v7_session_delete  — disconnect + drop the session (local action)
 *  - voice_v7_transcript      — streaming transcript lines (user /
 *    agent, interim + final, interrupted) + phase (read)
 *  - voice_v7_vad             — VAD status, or live config: preset
 *    or thresholds (local action when configuring, read otherwise)
 *  - voice_v7_barge_in        — barge-in status / force interrupt /
 *    duck / resume the cut reply (local action)
 *  - voice_v7_simulate_turn   — drive one scripted mock turn
 *    (user line → thinking → agent words streaming in) (local action)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only. A host that binds a live-transport
 * factory to the manager must do so explicitly; these tools
 * never dial a provider themselves and never touch a key.
 *
 * Factory:
 *   createVoiceV7Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V7_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import { isVadV7PresetName, type VadV7PresetName } from '@open-bot/core';

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

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a finite number, got ${typeof value}`);
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

/** What the tools need from one v7 session (the v7 wrapper fits). */
export interface VoiceV7SessionLike {
  getCallState(): string;
  getPhase(): string;
  isConnected(): boolean;
  getProvider(): string;
  getCurrentVoice(): { id: string; name: string; lang: string; rate: number } | null;
  listVoices(): Array<{ id: string; name: string; lang: string; rate: number }>;
  switchVoice(profileId: string, reason?: string): { ok: boolean; reason?: string; record?: unknown };
  revertVoice(): { ok: boolean; reason?: string; record?: unknown };
  connect(config: Record<string, unknown>): Promise<void>;
  disconnect(): void;
  getV7Stats(): unknown;
  getSummary(): unknown;
  getTranscriptStream(): {
    getLines(): unknown[];
    getStats(): unknown;
  };
  getVad(): {
    getStats(): unknown;
    getOptions(): unknown;
    setPreset(preset: string): unknown;
    updateOptions(patch: Record<string, unknown>): unknown;
  };
  getBargeIn(): {
    getStats(): unknown;
    getPartials(): unknown[];
    resumePartial(): { partial: unknown; resumePrompt: string } | null;
  };
  interrupt(): Promise<unknown>;
  duck(rms: number): unknown;
  simulateTurn(userText: string, modelReply?: string): Promise<boolean>;
}

/** What the tools need from the session manager. */
export interface VoiceV7ManagerLike {
  createSession(
    id: string,
    options?: { provider?: string; initialVoiceId?: string; vadPreset?: string },
  ): VoiceV7SessionLike;
  getSession(id: string): VoiceV7SessionLike | undefined;
  removeSession(id: string): boolean;
  listSessions(): unknown[];
  listVoices(): Array<{ id: string; name: string; lang: string; rate: number }>;
  getStats(): unknown;
}

export interface VoiceV7ToolOptions {
  /** Manager accessor (the host binds its VoiceV7Manager). */
  getManager?: () => VoiceV7ManagerLike | null;
}

const VAD_PRESET_NAMES: VadV7PresetName[] = ['quiet', 'office', 'noisy', 'very-noisy'];

export function createVoiceV7Tools(opts: VoiceV7ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV7ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v7 session manager is not available in this session (host must pass getManager to createVoiceV7Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV7ManagerLike, sessionId: string): VoiceV7SessionLike => {
    const session = manager.getSession(sessionId);
    if (!session) throw new Error(`Unknown voice v7 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v7_session_create',
      'Create a voice v7 session (local action): mock session on the given provider, voice and VAD preset. Pass connect=true to dial the mock transport at once; otherwise the session starts idle and voice_v7_session_stats shows it waiting.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        provider: { type: 'string', description: 'Provider: openai, gemini or openai-compatible (default openai).' },
        voiceId: { type: 'string', description: 'Starting voice id, e.g. "vi-nam" (optional).' },
        vadPreset: { type: 'string', description: 'VAD preset: quiet, office, noisy or very-noisy (default office).' },
        connect: { type: 'boolean', description: 'Connect the mock transport at once (default false).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const provider = getOptionalStringArg(args, 'provider');
        if (provider !== undefined && provider !== 'openai' && provider !== 'gemini' && provider !== 'openai-compatible') {
          throw new Error(`Unknown voice v7 provider "${provider}".`);
        }
        const voiceId = getOptionalStringArg(args, 'voiceId');
        const vadPreset = getOptionalStringArg(args, 'vadPreset');
        if (vadPreset !== undefined && !isVadV7PresetName(vadPreset)) {
          throw new Error(`Unknown VAD v7 preset "${vadPreset}" (want one of ${VAD_PRESET_NAMES.join(', ')}).`);
        }
        const session = manager.createSession(sessionId, {
          ...(provider !== undefined ? { provider } : {}),
          ...(voiceId !== undefined ? { initialVoiceId: voiceId } : {}),
          ...(vadPreset !== undefined ? { vadPreset } : {}),
        });
        const connectNow = getOptionalBooleanArg(args, 'connect') ?? false;
        if (connectNow) await session.connect({});
        return JSON.stringify({ created: true, sessionId, summary: session.getSummary() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const list: Tool = {
    definition: toolDef(
      'voice_v7_session_list',
      'List voice v7 sessions (read): id, call state, transcript phase, provider, voice, connected or not, duration, input/output token estimates, transcript lines, interrupts and ducks — plus manager totals.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const manager = needManager();
        return JSON.stringify({ sessions: manager.listSessions(), manager: manager.getStats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionStats: Tool = {
    definition: toolDef(
      'voice_v7_session_stats',
      'Full voice v7 stats for one session (read): call state, transcript phase, duration, VAD (preset, threshold, noise floor, false positives), barge-in (interrupts, ducks, stop latency, partials), transcript counts, v6 state/voice/network.',
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
        return JSON.stringify({ sessionId, stats: session.getV7Stats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stop: Tool = {
    definition: toolDef(
      'voice_v7_session_stop',
      'Disconnect a voice v7 session (local action): hangs up but keeps the session (and its transcript + stats) for inspection. Use voice_v7_session_delete to drop it entirely.',
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
        return JSON.stringify({ stopped: true, sessionId, summary: session.getSummary() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const remove: Tool = {
    definition: toolDef(
      'voice_v7_session_delete',
      'Delete a voice v7 session (local action): disconnects and drops it (transcript + stats go with it — snapshot first if the call matters). Returns false when there was no such session.',
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
        const deleted = manager.removeSession(sessionId);
        return JSON.stringify({ deleted, sessionId }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const transcript: Tool = {
    definition: toolDef(
      'voice_v7_transcript',
      'Streaming transcript of a voice v7 session (read): word-by-word lines with speaker (user/agent), interim vs final, interrupted flag, per-line confidence and token estimate, plus the current phase (listening/thinking/speaking/idle). Pass a speaker to filter, limit to cap the lines returned (newest last).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        speaker: { type: 'string', description: 'Filter: user or agent (optional).' },
        limit: { type: 'number', description: 'Max lines to return (default 50).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const speaker = getOptionalStringArg(args, 'speaker');
        if (speaker !== undefined && speaker !== 'user' && speaker !== 'agent') {
          throw new Error(`Unknown transcript speaker "${speaker}" (want user or agent).`);
        }
        const limit = getOptionalNumberArg(args, 'limit');
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
          throw new Error('limit must be an integer 1..500.');
        }
        const session = needSession(manager, sessionId);
        const stream = session.getTranscriptStream();
        let lines = stream.getLines() as Array<{ speaker: string }>;
        if (speaker !== undefined) lines = lines.filter((l) => l.speaker === speaker);
        const capped = lines.slice(-(limit ?? 50));
        return JSON.stringify(
          { sessionId, phase: session.getPhase(), stats: stream.getStats(), lines: capped },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const vad: Tool = {
    definition: toolDef(
      'voice_v7_vad',
      'Voice v7 VAD (read or local action): action=status returns the live state (preset, threshold, noise floor, level, ZCR, confidence, turns, backchannels, false positives by reason); action=config switches the preset and/or overrides thresholds live (baseThreshold, thresholdMultiplier, hangoverMs, maxGapMs, minTurnMs, backchannelMaxMs, debounceFrames, minConfidence, minZcr, maxZcr) and returns the effective config.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'status (default) or config.' },
        preset: { type: 'string', description: 'VAD preset for action=config: quiet, office, noisy or very-noisy.' },
        baseThreshold: { type: 'number', description: 'RMS base threshold (0.005..0.25).' },
        thresholdMultiplier: { type: 'number', description: 'Threshold = noiseFloor * this (1..20).' },
        hangoverMs: { type: 'number', description: 'Quiet ms before a turn ends (50..5000).' },
        maxGapMs: { type: 'number', description: 'Max quiet gap forgiven inside a turn (0..2000).' },
        minTurnMs: { type: 'number', description: 'Minimum turn length (0..2000).' },
        backchannelMaxMs: { type: 'number', description: 'Bursts shorter than this are backchannels (0..2000).' },
        debounceFrames: { type: 'number', description: 'Consecutive confident windows before a turn (1..10).' },
        minConfidence: { type: 'number', description: 'Minimum window confidence (0..1).' },
        minZcr: { type: 'number', description: 'ZCR band low end (0..0.9).' },
        maxZcr: { type: 'number', description: 'ZCR band high end (0.05..1).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const action = getOptionalStringArg(args, 'action') ?? 'status';
        if (action !== 'status' && action !== 'config') {
          throw new Error(`Unknown VAD action "${action}" (want status or config).`);
        }
        const session = needSession(manager, sessionId);
        const vad = session.getVad();
        if (action === 'status') {
          return JSON.stringify({ sessionId, action, stats: vad.getStats(), config: vad.getOptions() }, null, 2);
        }
        const preset = getOptionalStringArg(args, 'preset');
        if (preset !== undefined && !isVadV7PresetName(preset)) {
          throw new Error(`Unknown VAD v7 preset "${preset}" (want one of ${VAD_PRESET_NAMES.join(', ')}).`);
        }
        const patch: Record<string, unknown> = {};
        if (preset !== undefined) patch.preset = preset;
        for (const name of [
          'baseThreshold',
          'thresholdMultiplier',
          'hangoverMs',
          'maxGapMs',
          'minTurnMs',
          'backchannelMaxMs',
          'debounceFrames',
          'minConfidence',
          'minZcr',
          'maxZcr',
        ]) {
          const value = getOptionalNumberArg(args, name);
          if (value !== undefined) patch[name] = value;
        }
        if (Object.keys(patch).length === 0) {
          throw new Error('action=config needs a preset or at least one threshold to set.');
        }
        const config = vad.updateOptions(patch);
        return JSON.stringify({ sessionId, action, config, stats: vad.getStats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bargeIn: Tool = {
    definition: toolDef(
      'voice_v7_barge_in',
      'Voice v7 barge-in (read or local action): action=status returns the state (interrupts, ducks, ignored by reason, stop latency, partials, cooldown left); action=interrupt cancels the TTS now and keeps the cut reply (partial + cut word); action=duck quiets the TTS briefly instead of cutting it; action=resume continues the cut reply from its cut word (returns the resume prompt).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'status (default), interrupt, duck or resume.' },
        rms: { type: 'number', description: 'RMS that triggered the duck (action=duck, default 0.02).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const action = getOptionalStringArg(args, 'action') ?? 'status';
        if (action !== 'status' && action !== 'interrupt' && action !== 'duck' && action !== 'resume') {
          throw new Error(`Unknown barge-in action "${action}" (want status, interrupt, duck or resume).`);
        }
        const session = needSession(manager, sessionId);
        if (action === 'status') {
          return JSON.stringify(
            { sessionId, action, stats: session.getBargeIn().getStats(), partials: session.getBargeIn().getPartials() },
            null,
            2,
          );
        }
        if (action === 'duck') {
          const rms = getOptionalNumberArg(args, 'rms') ?? 0.02;
          const result = session.duck(rms);
          return JSON.stringify({ sessionId, action, result }, null, 2);
        }
        if (action === 'interrupt') {
          const result = await session.interrupt();
          return JSON.stringify({ sessionId, action, result }, null, 2);
        }
        const resumed = session.getBargeIn().resumePartial();
        if (!resumed) {
          return JSON.stringify({ sessionId, action, resumed: false, reason: 'Nothing was cut yet.' }, null, 2);
        }
        return JSON.stringify({ sessionId, action, resumed: true, partial: resumed.partial, resumePrompt: resumed.resumePrompt }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const simulateTurn: Tool = {
    definition: toolDef(
      'voice_v7_simulate_turn',
      'Drive one scripted mock turn through a voice v7 session (local action): the user line finalizes, the phase goes thinking, then the agent reply streams word by word into the transcript and finalizes. No provider, no network — the panel and the transcript read it live. Returns false when another turn is already simulating.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        userText: { type: 'string', description: 'What the user said.' },
        modelReply: { type: 'string', description: 'What the agent replies (optional, default mock reply).' },
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
        const started = await session.simulateTurn(userText, modelReply);
        return JSON.stringify(
          { sessionId, simulated: started, phase: session.getPhase(), stats: session.getTranscriptStream().getStats() },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, transcript, vad, bargeIn, simulateTurn];
}

/** Unbound placeholder (same shape as VOICE_V6_TOOLS). */
export const VOICE_V7_TOOLS: Tool[] = createVoiceV7Tools();

/** Names of the voice v7 tools (for the coordinator/registry checks). */
export const VOICE_V7_TOOL_NAMES = [
  'voice_v7_session_create',
  'voice_v7_session_list',
  'voice_v7_session_stats',
  'voice_v7_session_stop',
  'voice_v7_session_delete',
  'voice_v7_transcript',
  'voice_v7_vad',
  'voice_v7_barge_in',
  'voice_v7_simulate_turn',
] as const;

/** True when the name is one of the voice v7 tools. */
export function isVoiceV7ToolName(name: string): name is (typeof VOICE_V7_TOOL_NAMES)[number] {
  return (VOICE_V7_TOOL_NAMES as readonly string[]).includes(name);
}
