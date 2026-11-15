/**
 * Voice v8 tools for @open-bot/tools (v1.09, Đội T5).
 *
 * The agent drives the voice v8 sessions by tool call:
 *  - voice_v8_session_create  — create a mock v8 session (provider
 *    + voice + VAD preset/engine + input mode auto/push-to-talk),
 *    optionally connected at once (local action)
 *  - voice_v8_session_list    — sessions + UI status + mode + reconnects (read)
 *  - voice_v8_session_stats   — full v8 stats (status + VAD v8 +
 *    barge-in v8 + reconnect + turns + cut point) (read)
 *  - voice_v8_session_stop    — disconnect (keeps the session for inspection) (local action)
 *  - voice_v8_session_delete  — disconnect + drop the session (local action)
 *  - voice_v8_session_resume  — restore the durable snapshot from
 *    disk and reconnect with the mock dial (local action); returns
 *    the resume instructions the model would get
 *  - voice_v8_vad             — VAD v8 status, or live config: preset
 *    / engine / thresholds / calibration (local action when configuring, read otherwise)
 *  - voice_v8_barge_in        — barge-in v8 status / force interrupt /
 *    duck / resume the cut reply (local action)
 *  - voice_v8_ptt             — push-to-talk press / release / status,
 *    and switching the input mode auto <-> push-to-talk (local action)
 *  - voice_v8_simulate_turn   — drive one scripted mock turn
 *    (user line → thinking → agent words streaming in) (local action)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only. A host that binds a live-transport
 * factory to the manager must do so explicitly; these tools
 * never dial a provider themselves and never touch a key.
 *
 * Factory:
 *   createVoiceV8Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V8_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import { isVadV8PresetName, isVadV8Engine, type VadV8PresetName, type VadV8Engine } from '@open-bot/core';

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

/** What the tools need from one v8 session (the v8 wrapper fits). */
export interface VoiceV8SessionLike {
  getStatus(): string;
  getInputMode(): string;
  setInputMode(mode: 'auto' | 'push-to-talk'): string;
  pressPtt(): void;
  releasePtt(): void;
  isPttPressed(): boolean;
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
  getV8Stats(): unknown;
  getSummary(): unknown;
  getTurns(): unknown[];
  getLastCutPoint(): unknown;
  getVad(): {
    getStats(): unknown;
    getConfig(): unknown;
    setPreset(preset: string): unknown;
    updateOptions(patch: Record<string, unknown>): unknown;
    startCalibration(durationMs?: number): void;
  };
  getBargeIn(): {
    getStats(): unknown;
    duck(): unknown;
    resumeRemaining(): unknown;
  };
  interrupt(): Promise<unknown>;
  simulateTurn(userText: string, modelReply?: string): Promise<boolean>;
  restoreFromDisk(): unknown;
  reconnectNow(dial: () => Promise<boolean> | boolean): Promise<unknown>;
  noteDisconnected(error: string): unknown;
  saveSnapshot(cleanShutdown?: boolean): string | null;
  snapshotMarkdown(): string;
}

/** What the tools need from the session manager. */
export interface VoiceV8ManagerLike {
  createSession(
    id: string,
    options?: { provider?: string; initialVoiceId?: string; vadPreset?: string; inputMode?: string },
  ): VoiceV8SessionLike;
  restoreSession(
    id: string,
    options?: { provider?: string; initialVoiceId?: string; vadPreset?: string; inputMode?: string },
  ): { session: VoiceV8SessionLike; restored: unknown };
  getSession(id: string): VoiceV8SessionLike | undefined;
  removeSession(id: string): boolean;
  listSessions(): unknown[];
  listVoices(): Array<{ id: string; name: string; lang: string; rate: number }>;
  getStats(): unknown;
}

export interface VoiceV8ToolOptions {
  /** Manager accessor (the host binds its VoiceV8Manager). */
  getManager?: () => VoiceV8ManagerLike | null;
}

const VAD_PRESET_NAMES: VadV8PresetName[] = ['quiet', 'office', 'noisy', 'very-noisy'];
const VAD_ENGINE_NAMES: VadV8Engine[] = ['spectral', 'simple', 'auto'];

export function createVoiceV8Tools(opts: VoiceV8ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV8ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v8 session manager is not available in this session (host must pass getManager to createVoiceV8Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV8ManagerLike, sessionId: string): VoiceV8SessionLike => {
    const session = manager.getSession(sessionId);
    if (!session) throw new Error(`Unknown voice v8 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v8_session_create',
      'Create a voice v8 session (local action): mock session on the given provider, voice, VAD preset/engine and input mode (auto hands-free or push-to-talk). Pass connect=true to dial the mock transport at once; otherwise the session starts idle and voice_v8_session_stats shows it waiting.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        provider: { type: 'string', description: 'Provider: openai, gemini or openai-compatible (default openai).' },
        voiceId: { type: 'string', description: 'Starting voice id, e.g. "vi-nam" (optional).' },
        vadPreset: { type: 'string', description: 'VAD preset: quiet, office, noisy or very-noisy (default office).' },
        vadEngine: { type: 'string', description: 'VAD engine: spectral, simple (energy fallback) or auto (default auto).' },
        inputMode: { type: 'string', description: 'Input mode: auto (hands-free) or push-to-talk (default auto).' },
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
          throw new Error(`Unknown voice v8 provider "${provider}".`);
        }
        const voiceId = getOptionalStringArg(args, 'voiceId');
        const vadPreset = getOptionalStringArg(args, 'vadPreset');
        if (vadPreset !== undefined && !isVadV8PresetName(vadPreset)) {
          throw new Error(`Unknown VAD v8 preset "${vadPreset}" (want one of ${VAD_PRESET_NAMES.join(', ')}).`);
        }
        const vadEngine = getOptionalStringArg(args, 'vadEngine');
        if (vadEngine !== undefined && !isVadV8Engine(vadEngine)) {
          throw new Error(`Unknown VAD v8 engine "${vadEngine}" (want one of ${VAD_ENGINE_NAMES.join(', ')}).`);
        }
        const inputMode = getOptionalStringArg(args, 'inputMode');
        if (inputMode !== undefined && inputMode !== 'auto' && inputMode !== 'push-to-talk') {
          throw new Error(`Unknown input mode "${inputMode}" (want "auto" or "push-to-talk").`);
        }
        const session = manager.createSession(sessionId, {
          ...(provider !== undefined ? { provider } : {}),
          ...(voiceId !== undefined ? { initialVoiceId: voiceId } : {}),
          ...(vadPreset !== undefined ? { vadPreset } : {}),
          ...(inputMode !== undefined ? { inputMode } : {}),
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
      'voice_v8_session_list',
      'List voice v8 sessions (read): id, UI status (listening/speaking/reconnecting/disconnected), input mode, provider, voice, connected or not, duration, turns, reconnects, interrupts and ducks — plus manager totals.',
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
      'voice_v8_session_stats',
      'Full voice v8 stats for one session (read): UI status, input mode, PTT state, duration, VAD v8 (engine, preset, spectral flatness, noise kind, false positives by reason), barge-in v8 (interrupts, thinking interrupts, ducks, echo-only frames, audio/words discarded, stop latency), reconnect budget, turns, cut point, v7 state.',
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
          { sessionId, stats: session.getV8Stats(), turns: session.getTurns(), cutPoint: session.getLastCutPoint() },
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
      'voice_v8_session_stop',
      'Disconnect a voice v8 session (local action): saves the durable snapshot first, then hangs up. The session stays listed for inspection until voice_v8_session_delete.',
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
      'voice_v8_session_delete',
      'Delete a voice v8 session (local action): disconnects (saving the snapshot) and drops it from the manager. Returns whether a session was actually removed.',
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

  const resume: Tool = {
    definition: toolDef(
      'voice_v8_session_resume',
      'Resume a voice v8 session after a dropped call (local action): restores the durable snapshot from disk (turns, voice, VAD config, cut reply) and reconnects with the mock dial, then returns the resume instructions the model gets so it continues instead of starting over. Pass dropFirst=true to simulate the drop before reconnecting.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        dropFirst: { type: 'boolean', description: 'Simulate the drop (noteDisconnected) before reconnecting (default false).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const session = needSession(manager, sessionId);
        const dropFirst = getOptionalBooleanArg(args, 'dropFirst') ?? false;
        if (dropFirst) session.noteDisconnected('simulated drop (tool)');
        const restored = session.restoreFromDisk();
        const reconnected = await session.reconnectNow(async () => true);
        return JSON.stringify(
          { resumed: true, sessionId, restored, reconnected, snapshotMarkdown: session.snapshotMarkdown() },
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
      'voice_v8_vad',
      'VAD v8 status or live config (read, or local action when configuring): preset (quiet/office/noisy/very-noisy), engine (spectral/simple/auto), spectral flatness, noise kind (silence/hum/fan/click/white/speech), per-band noise floors, false positives by reason and by noise kind, mean end-of-speech latency. Pass preset/engine/threshold/minConfidence/maxFlatness to reconfigure live, or calibrate=true to learn the room noise floor fast.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        preset: { type: 'string', description: 'Switch the room preset (optional).' },
        engine: { type: 'string', description: 'Switch the engine: spectral, simple or auto (optional).' },
        threshold: { type: 'number', description: 'RMS energy threshold override 0.005..0.25 (optional).' },
        minConfidence: { type: 'number', description: 'Minimum speech confidence 0..1 (optional).' },
        maxFlatness: { type: 'number', description: 'Max spectral flatness that still counts as speech 0..1 (optional).' },
        calibrate: { type: 'boolean', description: 'Learn the room noise floor fast (default false).' },
        calibrateMs: { type: 'number', description: 'Calibration window in ms (default 1000).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const session = needSession(manager, sessionId);
        const vadApi = session.getVad();
        const patch: Record<string, unknown> = {};
        const preset = getOptionalStringArg(args, 'preset');
        if (preset !== undefined) {
          if (!isVadV8PresetName(preset)) throw new Error(`Unknown VAD v8 preset "${preset}".`);
          patch['preset'] = preset;
        }
        const engine = getOptionalStringArg(args, 'engine');
        if (engine !== undefined) {
          if (!isVadV8Engine(engine)) throw new Error(`Unknown VAD v8 engine "${engine}".`);
          patch['engine'] = engine;
        }
        const threshold = getOptionalNumberArg(args, 'threshold');
        if (threshold !== undefined) patch['threshold'] = threshold;
        const minConfidence = getOptionalNumberArg(args, 'minConfidence');
        if (minConfidence !== undefined) patch['minConfidence'] = minConfidence;
        const maxFlatness = getOptionalNumberArg(args, 'maxFlatness');
        if (maxFlatness !== undefined) patch['maxFlatness'] = maxFlatness;
        const calibrate = getOptionalBooleanArg(args, 'calibrate') ?? false;
        const calibrateMs = getOptionalNumberArg(args, 'calibrateMs');
        let config: unknown;
        if (Object.keys(patch).length > 0) {
          config = vadApi.updateOptions(patch);
        } else {
          config = vadApi.getConfig();
        }
        if (calibrate) vadApi.startCalibration(calibrateMs);
        return JSON.stringify({ sessionId, stats: vadApi.getStats(), config }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bargeIn: Tool = {
    definition: toolDef(
      'voice_v8_barge_in',
      'Barge-in v8 status or action (read, or local action): status shows interrupts (incl. while thinking), ducks, echo-only frames rejected by the AEC, audio/words discarded, echo gain and stop latency. action=interrupt forces a cut now (returns the exact receipt: words/audio played vs discarded, cut word + audio offset), action=duck quiets the reply briefly, action=resume re-queues the cut reply from the cut word.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Action: status, interrupt, duck or resume (default status).' },
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
        if (action === 'interrupt') {
          const result = await session.interrupt();
          return JSON.stringify({ sessionId, action, result }, null, 2);
        }
        if (action === 'duck') {
          const result = session.getBargeIn().duck();
          return JSON.stringify({ sessionId, action, result }, null, 2);
        }
        if (action === 'resume') {
          const result = session.getBargeIn().resumeRemaining();
          return JSON.stringify({ sessionId, action, result }, null, 2);
        }
        if (action !== 'status') throw new Error(`Unknown voice_v8_barge_in action "${action}".`);
        return JSON.stringify({ sessionId, action, stats: session.getBargeIn().getStats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const ptt: Tool = {
    definition: toolDef(
      'voice_v8_ptt',
      'Push-to-talk control (local action): press/release the hold-to-talk button (only in push-to-talk mode — in auto mode the mic is always open), or switch the input mode between auto (hands-free, VAD-gated) and push-to-talk. action=status reports the mode and whether PTT is held.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Action: press, release, status, or set-mode (default status).' },
        mode: { type: 'string', description: 'Input mode for set-mode: auto or push-to-talk.' },
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
        if (action === 'press') {
          session.pressPtt();
          return JSON.stringify({ sessionId, action, pressed: session.isPttPressed(), inputMode: session.getInputMode() }, null, 2);
        }
        if (action === 'release') {
          session.releasePtt();
          return JSON.stringify({ sessionId, action, pressed: session.isPttPressed(), inputMode: session.getInputMode() }, null, 2);
        }
        if (action === 'set-mode') {
          const mode = getStringArg(args, 'mode');
          if (mode !== 'auto' && mode !== 'push-to-talk') {
            throw new Error(`Unknown input mode "${mode}" (want "auto" or "push-to-talk").`);
          }
          const next = session.setInputMode(mode);
          return JSON.stringify({ sessionId, action, inputMode: next, pressed: session.isPttPressed() }, null, 2);
        }
        if (action !== 'status') throw new Error(`Unknown voice_v8_ptt action "${action}".`);
        return JSON.stringify(
          { sessionId, action, inputMode: session.getInputMode(), pressed: session.isPttPressed(), status: session.getStatus() },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const simulateTurn: Tool = {
    definition: toolDef(
      'voice_v8_simulate_turn',
      'Drive one scripted mock turn on a voice v8 session (local action): the user line finalizes, the model thinks, then the reply streams word by word (barge-in watches the whole time). No provider, no network — for demos and tests.',
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

  return [create, list, sessionStats, stop, remove, resume, vad, bargeIn, ptt, simulateTurn];
}

/** Unbound placeholder (the host binds a manager via createVoiceV8Tools). */
export const VOICE_V8_TOOLS: Tool[] = createVoiceV8Tools();

export const VOICE_V8_TOOL_NAMES = [
  'voice_v8_session_create',
  'voice_v8_session_list',
  'voice_v8_session_stats',
  'voice_v8_session_stop',
  'voice_v8_session_delete',
  'voice_v8_session_resume',
  'voice_v8_vad',
  'voice_v8_barge_in',
  'voice_v8_ptt',
  'voice_v8_simulate_turn',
] as const;

export function isVoiceV8ToolName(name: string): name is (typeof VOICE_V8_TOOL_NAMES)[number] {
  return (VOICE_V8_TOOL_NAMES as readonly string[]).includes(name);
}
