/**
 * Voice v4 tools for @open-bot/tools (v1.05, Team T5).
 *
 * The agent drives the voice sessions by tool call:
 *  - voice_v4_start_session   — start a voice session (mock
 *    transport by default; no key, no network) (local action)
 *  - voice_v4_stop_session    — stop + remove a session
 *  - voice_v4_pause_session   — pause: disconnect the transport,
 *    keep the wrapper + checkpoint
 *  - voice_v4_resume_session  — resume a paused session
 *  - voice_v4_set_latency_mode — switch a session's latency
 *    mode mid-call (balanced / low-latency) (local action)
 *  - voice_v4_latency_report  — per-stage latency report
 *    (capture → VAD → STT → LLM → TTS → playback, p50/p95/p99)
 *    + jitter buffer + slowest stage (read)
 *  - voice_v4_barge_in_test   — drive the v4 detector with
 *    synthetic loud+VAD frames and measure the TTS stop against
 *    the 50 ms budget (mock only)
 *  - voice_v4_eval_run        — internal voice eval: WER on
 *    fixture cases (or caller-supplied cases) + barge-in latency
 *    scoring; no outside API call (read)
 *  - voice_v4_session_log     — session lifecycle log (read)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only. A host that binds a live-transport
 * factory to the manager must do so explicitly; these tools
 * never dial a provider themselves and never touch a key.
 *
 * Factory:
 *   createVoiceV4Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V4_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  runVoiceEval,
  voiceEvalReportMarkdown,
  voiceLatencyReportMarkdown,
  VOICE_EVAL_FIXTURE_CASES,
  type VoiceEvalCase,
  type VoiceLatencyReport,
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

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
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

/** What the tools need from a session (the v4 wrapper fits). */
export interface VoiceV4SessionLike {
  isConnected(): boolean;
  getLatencyReport(): unknown;
  getBargeInV4Stats(): unknown;
  getV4Stats(): unknown;
  noteModelSpeechStarted?(partialText?: string): void;
  noteAudioFrameV4(input: { rms: number; vadActive?: boolean }): Promise<{
    decision: { action: string; reason: string };
    result: { stopLatencyMs: number | null; withinBudget: boolean; partialText: string } | null;
  }>;
}

/** What the tools need from the session manager. */
export interface VoiceV4ManagerLike {
  startSession(
    id: string,
    config?: { instructions?: string; latencyMode?: string },
  ): Promise<{ ok: boolean; reason?: string }>;
  stopSession(id: string): boolean;
  pauseSession(id: string): boolean;
  resumeSession(id: string): Promise<boolean>;
  setSessionLatencyMode(id: string, mode: string): string | null;
  getSession(id: string): { id: string; status: string; session: unknown } | null;
  getSessionLog(sessionId?: string): Array<{
    seq: number;
    sessionId: string;
    kind: string;
    at: number;
    detail: string;
  }>;
  getStats(): unknown;
}

export interface VoiceV4ToolOptions {
  /** Manager accessor (the host binds its VoiceSessionManagerV2). */
  getManager?: () => VoiceV4ManagerLike | null;
}

function asV4Session(value: unknown): VoiceV4SessionLike | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (
    typeof s.isConnected !== 'function' ||
    typeof s.getLatencyReport !== 'function' ||
    typeof s.getBargeInV4Stats !== 'function' ||
    typeof s.noteAudioFrameV4 !== 'function'
  ) {
    return null;
  }
  return value as VoiceV4SessionLike;
}

export function createVoiceV4Tools(opts: VoiceV4ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV4ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v4 session manager is not available in this session (host must pass getManager to createVoiceV4Tools).',
      );
    }
    return manager;
  };

  const startSession: Tool = {
    definition: toolDef(
      'voice_v4_start_session',
      'Start a realtime voice session (mock transport by default — no key, no network). Returns the session id and status, or the reason it was refused (duplicate id, concurrency cap).',
      {
        sessionId: { type: 'string', description: 'Id for the new session, e.g. "call-1".' },
        instructions: { type: 'string', description: 'Base instructions for the voice assistant (optional).' },
        latencyMode: {
          type: 'string',
          description: 'Latency mode: "balanced" (default) or "low-latency".',
        },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const instructions = getOptionalStringArg(args, 'instructions');
        const latencyMode = getOptionalStringArg(args, 'latencyMode');
        if (latencyMode !== undefined && latencyMode !== 'balanced' && latencyMode !== 'low-latency') {
          throw new Error(`latencyMode must be "balanced" or "low-latency", got "${latencyMode}".`);
        }
        const result = await manager.startSession(sessionId, {
          ...(instructions !== undefined ? { instructions } : {}),
          ...(latencyMode !== undefined ? { latencyMode } : {}),
        });
        return JSON.stringify(
          result.ok
            ? { started: true, sessionId, latencyMode: latencyMode ?? 'balanced' }
            : { started: false, sessionId, reason: result.reason ?? 'Could not start the session.' },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stopSession: Tool = {
    definition: toolDef(
      'voice_v4_stop_session',
      'Stop a voice session: disconnect, dispose, remove it from the manager. Returns whether the session existed.',
      {
        sessionId: { type: 'string', description: 'Id of the session to stop.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const stopped = manager.stopSession(sessionId);
        return JSON.stringify({ stopped, sessionId }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pauseSession: Tool = {
    definition: toolDef(
      'voice_v4_pause_session',
      'Pause a voice session: disconnect the transport but keep the wrapper and its checkpoint (a paused session frees a concurrency slot). Resume with voice_v4_resume_session.',
      {
        sessionId: { type: 'string', description: 'Id of the session to pause.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const paused = manager.pauseSession(sessionId);
        return JSON.stringify(
          paused
            ? { paused: true, sessionId }
            : { paused: false, sessionId, reason: 'Session not found or not active.' },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const resumeSession: Tool = {
    definition: toolDef(
      'voice_v4_resume_session',
      'Resume a paused voice session: reconnect with the same config. Returns false when the session is not paused or the concurrency cap is hit.',
      {
        sessionId: { type: 'string', description: 'Id of the session to resume.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const resumed = await manager.resumeSession(sessionId);
        return JSON.stringify(
          resumed
            ? { resumed: true, sessionId }
            : { resumed: false, sessionId, reason: 'Session not found, not paused, or the concurrency cap is hit.' },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const setLatencyMode: Tool = {
    definition: toolDef(
      'voice_v4_set_latency_mode',
      'Switch a voice session latency mode mid-call: "balanced" (default) or "low-latency" (smaller chunks, shorter VAD hangover, smaller jitter buffer). Returns the mode now in effect.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        latencyMode: {
          type: 'string',
          description: 'Latency mode: "balanced" or "low-latency".',
        },
      },
      ['sessionId', 'latencyMode'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const latencyMode = getStringArg(args, 'latencyMode');
        if (latencyMode !== 'balanced' && latencyMode !== 'low-latency') {
          throw new Error(`latencyMode must be "balanced" or "low-latency", got "${latencyMode}".`);
        }
        const current = manager.setSessionLatencyMode(sessionId, latencyMode);
        return JSON.stringify(
          current
            ? { sessionId, latencyMode: current }
            : { sessionId, latencyMode: null, reason: 'Session not found or it has no latency mode switch.' },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const latencyReport: Tool = {
    definition: toolDef(
      'voice_v4_latency_report',
      'Latency report for a voice session (read): per-stage p50/p95/p99 (capture, VAD, STT, LLM, TTS, playback), end-to-end turn latency, slowest stage, jitter-buffer depth, latency mode. Stages nobody measured report null, never a guess.',
      {
        sessionId: { type: 'string', description: 'Id of the session to report on.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const record = manager.getSession(sessionId);
        if (!record) return errorResult(`No voice session "${sessionId}".`);
        const session = asV4Session(record.session);
        if (!session) return errorResult(`Session "${sessionId}" does not expose a v4 latency report.`);
        const report = session.getLatencyReport() as VoiceLatencyReport;
        return JSON.stringify(
          {
            sessionId,
            status: record.status,
            report,
            markdown: voiceLatencyReportMarkdown(report),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bargeInTest: Tool = {
    definition: toolDef(
      'voice_v4_barge_in_test',
      'Test the v4 barge-in path on a live session (mock only): feed synthetic loud+VAD frames through the energy gate + debounce, cancel the reply, and measure the TTS stop against the 50 ms budget. The session must be connected.',
      {
        sessionId: { type: 'string', description: 'Id of the session to test.' },
        rms: { type: 'number', description: 'RMS of the synthetic frames (default 0.5, above the 0.02 gate).' },
        frames: { type: 'number', description: 'Frames to feed (default 5; 3 satisfy the debounce).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const rms = getNumberArg(args, 'rms') ?? 0.5;
        const frames = Math.max(1, Math.min(20, Math.floor(getNumberArg(args, 'frames') ?? 5)));
        const record = manager.getSession(sessionId);
        if (!record) return errorResult(`No voice session "${sessionId}".`);
        const session = asV4Session(record.session);
        if (!session) return errorResult(`Session "${sessionId}" does not expose the v4 barge-in path.`);
        if (!session.isConnected()) {
          return errorResult(`Session "${sessionId}" is not connected (status ${record.status}).`);
        }
        // The test simulates the model speaking (a test reply the
        // user then talks over) so the detector has something to
        // interrupt; the frames below are the synthetic barge-in.
        session.noteModelSpeechStarted?.(
          'This is a test reply that will be interrupted mid-sentence.',
        );
        let interrupted = false;
        let result: { stopLatencyMs: number | null; withinBudget: boolean; partialText: string } | null = null;
        let decision: { action: string; reason: string } | null = null;
        for (let i = 0; i < frames && !interrupted; i += 1) {
          const out = await session.noteAudioFrameV4({ rms, vadActive: true });
          decision = out.decision;
          if (out.decision.action === 'interrupt') {
            interrupted = true;
            result = out.result;
          }
        }
        return JSON.stringify(
          {
            sessionId,
            interrupted,
            framesFed: frames,
            lastDecision: decision,
            stopLatencyMs: result?.stopLatencyMs ?? null,
            withinBudget: result?.withinBudget ?? null,
            partialText: result?.partialText ?? '',
            bargeInStats: session.getBargeInV4Stats(),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evalRun: Tool = {
    definition: toolDef(
      'voice_v4_eval_run',
      'Run the internal voice eval (read, no outside API call): WER on fixture cases (or caller-supplied cases) plus barge-in latency scoring against the 50 ms budget. Returns the report and its markdown rendering.',
      {
        sessionId: { type: 'string', description: 'Session to attach the run to (optional; adds its last stop latency as a sample).' },
        cases: {
          type: 'array',
          description: 'Cases to score instead of the fixtures: [{id, reference, hypothesis}] (optional).',
        },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        let cases: VoiceEvalCase[] = [...VOICE_EVAL_FIXTURE_CASES];
        const rawCases = args.cases;
        if (Array.isArray(rawCases) && rawCases.length > 0) {
          cases = rawCases.map((c, i) => {
            const item = c as Record<string, unknown>;
            if (typeof item.reference !== 'string' || typeof item.hypothesis !== 'string') {
              throw new Error(`cases[${i}] needs string "reference" and "hypothesis".`);
            }
            return {
              id: typeof item.id === 'string' ? item.id : `case-${i + 1}`,
              reference: item.reference,
              hypothesis: item.hypothesis,
              ...(typeof item.bargeInStopMs === 'number' ? { bargeInStopMs: item.bargeInStopMs } : {}),
              ...(typeof item.lang === 'string' ? { lang: item.lang } : {}),
            };
          });
        }
        const sessionId = getOptionalStringArg(args, 'sessionId');
        if (sessionId) {
          const manager = needManager();
          const record = manager.getSession(sessionId);
          if (!record) return errorResult(`No voice session "${sessionId}".`);
          const session = asV4Session(record.session);
          const stats = session?.getBargeInV4Stats() as
            | { stopLatency: { lastMs: number } | null }
            | null
            | undefined;
          const lastStop = stats?.stopLatency?.lastMs;
          if (typeof lastStop === 'number' && cases.length > 0) {
            cases = cases.map((c) => ({ ...c, bargeInStopMs: lastStop }));
          }
        }
        const report = runVoiceEval(cases, { sessionId: sessionId ?? '' });
        return JSON.stringify({ report, markdown: voiceEvalReportMarkdown(report) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionLog: Tool = {
    definition: toolDef(
      'voice_v4_session_log',
      'Voice session lifecycle log (read): start / pause / resume / stop / reconnect entries, optionally for one session only, newest last.',
      {
        sessionId: { type: 'string', description: 'Only entries for this session (optional).' },
        limit: { type: 'number', description: 'Max entries returned (default 50).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const limit = Math.max(1, Math.min(500, Math.floor(getNumberArg(args, 'limit') ?? 50)));
        const entries = manager.getSessionLog(sessionId);
        return JSON.stringify(
          {
            sessionId: sessionId ?? null,
            total: entries.length,
            entries: entries.slice(-limit),
            manager: manager.getStats(),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [startSession, stopSession, pauseSession, resumeSession, setLatencyMode, latencyReport, bargeInTest, evalRun, sessionLog];
}

/** Unbound placeholder (same shape as MEMORY_V5_TOOLS). */
export const VOICE_V4_TOOLS: Tool[] = createVoiceV4Tools();

/** Names of the voice v4 tools (for the coordinator/registry checks). */
export const VOICE_V4_TOOL_NAMES = [
  'voice_v4_start_session',
  'voice_v4_stop_session',
  'voice_v4_pause_session',
  'voice_v4_resume_session',
  'voice_v4_set_latency_mode',
  'voice_v4_latency_report',
  'voice_v4_barge_in_test',
  'voice_v4_eval_run',
  'voice_v4_session_log',
] as const;

/** True when the name is one of the voice v4 tools. */
export function isVoiceV4ToolName(name: string): name is (typeof VOICE_V4_TOOL_NAMES)[number] {
  return (VOICE_V4_TOOL_NAMES as readonly string[]).includes(name);
}
