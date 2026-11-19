/**
 * Voice v30 tools for @open-bot/tools (v1.44, Team T4).
 *
 * The agent drives the voice v30 full-duplex loop by tool call:
 *  - voice_v30_session — a full-duplex session v2: start / pause /
 *    resume / stop, feed user audio frames (energy, echo-flagged
 *    while the agent speaks) and agent audio frames, end the user
 *    turn, server-driven agent responses (respond / spoken /
 *    done), barge-in (soft pause + resume from a sentence
 *    boundary, hard cancel, false-positive feedback), schedule /
 *    tick proactive audio (task-complete / alert / reminder),
 *    meter cost (minutes + tokens), forecast, degrade / recover
 *    the duplex engine, snapshot / stats / session log
 *  - voice_v30_turns — the audio turn detector v2 standalone:
 *    feed frames, stats, turn history, presets, config, reset
 *  - voice_v30_duplex — the full-duplex engine v2 standalone:
 *    push/drain inbound + outbound lanes, measure turns against
 *    latency SLOs, degrade / recover, report, Markdown
 *  - voice_v30_bargein — the barge-in engine v2 standalone:
 *    server responses, soft/hard interrupts, resume/discard,
 *    false-positive feedback, stats, events
 *  - voice_v30_proactive — proactive audio v2 standalone:
 *    schedule (priority, TTL, dedupe key, payload), tick, list,
 *    cancel, quiet hours / DND / presence, stats, text fallbacks
 *  - voice_v30_cost — cost ledger v2: rate table, estimate,
 *    start/stop a session meter, tick (minutes + tokens),
 *    report, forecast, itemised statement (Markdown / CSV /
 *    JSON), alerts, host rate overrides
 *
 * SAFETY: everything here is local — clocks are virtual, audio is
 * mock/synthetic frame energy, no provider is dialled, no key is
 * read or stored, no live API is called.
 *
 * Factory:
 *   createVoiceV30Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V30_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  AudioTurnDetectorV30,
  BargeInEngineV30,
  CostLedgerV30,
  FullDuplexEngineV30,
  FullDuplexSessionV30,
  ProactiveAudioV30,
  VOICE_V30_I18N_KEYS,
  VOICE_V30_MODEL_CATALOG,
  VOICE_V30_PROACTIVE_KIND_PRIORITY,
  VOICE_V30_TURN_PRESETS,
  createAudioTurnDetectorV30,
  createBargeInEngineV30,
  createCostLedgerV30,
  createFullDuplexEngineV30,
  createFullDuplexSessionV30,
  createProactiveAudioV30,
  isKnownModelV30,
  type VoiceV30InterruptRequester,
  type VoiceV30ModelId,
  type VoiceV30ProactiveKind,
  type VoiceV30ProactivePriority,
  type VoiceV30TurnPresetName,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function okResult(value: unknown): string {
  return JSON.stringify(value);
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a finite number, got ${String(value)}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: number | string, fallback: number): number {
  const value = getOptionalNumberArg(args, name as string);
  return value === undefined ? fallback : value;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  throw new Error(`Argument "${name}" must be a boolean, got ${String(value)}`);
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

function parseJsonArg(value: string | undefined, name: string): unknown {
  if (value === undefined || value === '') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Argument "${name}" is not valid JSON`);
  }
}

function parseStringRecord(value: string | undefined, name: string): Record<string, string> {
  const raw = parseJsonArg(value, name);
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${name} must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  return out;
}

function isAction(list: readonly string[], v: string): boolean {
  return (list as readonly string[]).includes(v);
}

function assertModelId(value: string): VoiceV30ModelId {
  if (!isKnownModelV30(value)) throw new Error(`Unknown voice model: ${value}`);
  return value as VoiceV30ModelId;
}

function assertRequester(value: string): VoiceV30InterruptRequester {
  const allowed = ['user-speech', 'user-button', 'server', 'system'];
  if (!allowed.includes(value)) throw new Error(`Unknown interrupt requester: ${value}`);
  return value as VoiceV30InterruptRequester;
}

function assertProactiveKind(value: string): VoiceV30ProactiveKind {
  const allowed = ['greeting', 'idle-nudge', 'scheduled-reminder', 'event-announcement', 'follow-up', 'task-complete', 'alert', 'digest'];
  if (!allowed.includes(value)) throw new Error(`Unknown proactive kind: ${value}`);
  return value as VoiceV30ProactiveKind;
}

function assertProactivePriority(value: string): VoiceV30ProactivePriority {
  const allowed = ['critical', 'high', 'normal', 'low'];
  if (!allowed.includes(value)) throw new Error(`Unknown proactive priority: ${value}`);
  return value as VoiceV30ProactivePriority;
}

function assertTurnPreset(value: string): VoiceV30TurnPresetName {
  const allowed = ['sensitive', 'balanced', 'relaxed', 'push-to-talk', 'noisy-room'];
  if (!allowed.includes(value)) throw new Error(`Unknown turn preset: ${value}`);
  return value as VoiceV30TurnPresetName;
}

export interface VoiceV30ToolOptions {
  /** Shared full-duplex session accessor (per session id). */
  getSession?: (sessionId: string) => FullDuplexSessionV30 | null;
  /** Default model id for new sessions (default 'mock-cascaded'). */
  defaultModelId?: VoiceV30ModelId;
}

export function createVoiceV30Tools(opts: VoiceV30ToolOptions = {}): Tool[] {
  const sessions = new Map<string, FullDuplexSessionV30>();
  const openedSessions = new Set<string>();
  const standaloneDetectors = new Map<string, AudioTurnDetectorV30>();
  const standaloneDuplex = new Map<string, FullDuplexEngineV30>();
  const standaloneBargeIn = new Map<string, BargeInEngineV30>();
  const standaloneProactive = new Map<string, ProactiveAudioV30>();
  const sharedLedger = new CostLedgerV30();

  const needSession = (sessionId: string, modelId?: string): FullDuplexSessionV30 => {
    const shared = opts.getSession?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = sessions.get(sessionId);
    if (found === undefined) {
      found = createFullDuplexSessionV30({
        sessionId,
        modelId: modelId ? assertModelId(modelId) : (opts.defaultModelId ?? 'mock-cascaded'),
      });
      sessions.set(sessionId, found);
    }
    return found;
  };

  const needDetector = (sessionId: string): AudioTurnDetectorV30 => {
    let found = standaloneDetectors.get(sessionId);
    if (found === undefined) {
      found = createAudioTurnDetectorV30();
      standaloneDetectors.set(sessionId, found);
    }
    return found;
  };

  const needDuplex = (sessionId: string): FullDuplexEngineV30 => {
    let found = standaloneDuplex.get(sessionId);
    if (found === undefined) {
      found = createFullDuplexEngineV30();
      standaloneDuplex.set(sessionId, found);
    }
    return found;
  };

  const needBargeIn = (sessionId: string): BargeInEngineV30 => {
    let found = standaloneBargeIn.get(sessionId);
    if (found === undefined) {
      found = createBargeInEngineV30();
      standaloneBargeIn.set(sessionId, found);
    }
    return found;
  };

  const needProactive = (sessionId: string): ProactiveAudioV30 => {
    let found = standaloneProactive.get(sessionId);
    if (found === undefined) {
      found = createProactiveAudioV30();
      standaloneProactive.set(sessionId, found);
    }
    return found;
  };

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v30_session',
      'Full-duplex voice session v30 (local, mock audio): start / pause / resume / stop a session, feed user audio frames (energy, echo-flagged while the agent speaks) and agent audio frames, end the user turn, drive server-driven agent responses (respond / spoken / done), barge in soft (pause + resume from a sentence boundary) or hard (cancel), mark a barge-in as a false positive, schedule / tick proactive audio (task-complete / alert / reminder), meter cost (audio minutes + text tokens), forecast the run-rate, degrade / recover the duplex engine, snapshot / stats / session log. No mic, sound card, network or key is touched.',
      {
        action: { type: 'string', description: 'start, pause, resume, stop, status, snapshot, stats, log, feed-frame, feed-agent-frame, end-turn, respond, response-spoken, response-done, barge-in, resume-remainder, discard-remainder, mark-false-positive, schedule-proactive, proactive-tick, tick-cost, forecast, degrade-duplex, recover-duplex, models or i18n-keys.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        modelId: { type: 'string', description: 'Model id: gpt-realtime-2.1, gpt-realtime-2.1-mini, gpt-live, gemini-3.8-live, livekit-agents-1.0 or mock-cascaded (start, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (feed-frame, feed-agent-frame).' },
        isSpeech: { type: 'string', description: '"true" when the caller already knows the frame is speech (feed-frame, optional).' },
        agentSpeaking: { type: 'string', description: '"true" when the frame overlaps agent audio (feed-frame, optional).' },
        text: { type: 'string', description: 'Response text (respond), proactive text (schedule-proactive), or frame transcript fragment (feed-frame, optional).' },
        responseId: { type: 'string', description: 'Server response id (response-spoken, response-done, resume-remainder, discard-remainder).' },
        spokenChars: { type: 'number', description: 'Characters spoken so far (response-spoken).' },
        requester: { type: 'string', description: 'Who asks to interrupt: user-speech, user-button, server or system (barge-in).' },
        kind: { type: 'string', description: 'Proactive kind: greeting, idle-nudge, scheduled-reminder, event-announcement, follow-up, task-complete, alert or digest (schedule-proactive).' },
        priority: { type: 'string', description: 'Proactive priority: critical, high, normal or low (schedule-proactive, optional).' },
        delayMs: { type: 'number', description: 'Delay ms before the proactive trigger is due (schedule-proactive, optional).' },
        ttlMs: { type: 'number', description: 'TTL ms after which an undelivered trigger expires (schedule-proactive, optional).' },
        dedupeKey: { type: 'string', description: 'Dedupe key: a second trigger with the same key inside the window is dropped (schedule-proactive, optional).' },
        payloadJson: { type: 'string', description: 'Trigger payload as a JSON object of strings (schedule-proactive, optional).' },
        reason: { type: 'string', description: 'Degradation reason: queue-full, latency-slo-breach, crosstalk-storm or manual (degrade-duplex).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(
          ['start', 'pause', 'resume', 'stop', 'status', 'snapshot', 'stats', 'log', 'feed-frame', 'feed-agent-frame', 'end-turn', 'respond', 'response-spoken', 'response-done', 'barge-in', 'resume-remainder', 'discard-remainder', 'mark-false-positive', 'schedule-proactive', 'proactive-tick', 'tick-cost', 'forecast', 'degrade-duplex', 'recover-duplex', 'models', 'i18n-keys'],
          action,
        )) {
          return errorResult(`Unknown action: ${action}`);
        }
        if (action === 'models') return okResult(VOICE_V30_MODEL_CATALOG);
        if (action === 'i18n-keys') return okResult([...VOICE_V30_I18N_KEYS]);
        if (action === 'start') {
          if (openedSessions.has(sessionId)) return errorResult(`Session already started: ${sessionId}`);
          const modelId = getOptionalStringArg(args, 'modelId');
          const session = needSession(sessionId, modelId);
          openedSessions.add(sessionId);
          return okResult(session.start(atMs));
        }
        const session = needSession(sessionId);
        switch (action) {
          case 'pause': return okResult(session.pause(atMs));
          case 'resume': return okResult(session.resume(atMs));
          case 'stop': return okResult(session.stop(atMs));
          case 'status':
          case 'snapshot': return okResult(session.snapshot());
          case 'stats': return okResult(session.stats());
          case 'log': return okResult(session.logEventsSoFar());
          case 'feed-frame': {
            const energy = getNumberArg(args, 'energy', 0);
            const isSpeechRaw = getOptionalStringArg(args, 'isSpeech');
            const agentSpeakingRaw = getOptionalStringArg(args, 'agentSpeaking');
            const text = getOptionalStringArg(args, 'text') ?? null;
            return okResult(session.feedUserFrame({
              atMs,
              energy,
              isSpeech: isSpeechRaw === undefined ? undefined : isSpeechRaw === 'true',
              agentSpeaking: agentSpeakingRaw === undefined ? undefined : agentSpeakingRaw === 'true',
              text,
            }));
          }
          case 'feed-agent-frame': {
            const energy = getNumberArg(args, 'energy', 0);
            const text = getOptionalStringArg(args, 'text') ?? null;
            session.feedAgentFrame(atMs, energy, text);
            return okResult({ fed: true, atMs, energy });
          }
          case 'end-turn': return okResult(session.endUserTurnNow(atMs));
          case 'respond': {
            const text = getStringArg(args, 'text');
            return okResult(session.serverRespond(text, atMs));
          }
          case 'response-spoken': {
            const responseId = getStringArg(args, 'responseId');
            const spokenChars = getNumberArg(args, 'spokenChars', 0);
            return okResult(session.markResponseSpoken(responseId, spokenChars, atMs));
          }
          case 'response-done': {
            const responseId = getStringArg(args, 'responseId');
            return okResult(session.completeResponse(responseId, atMs));
          }
          case 'barge-in': {
            const requester = assertRequester(getOptionalStringArg(args, 'requester') ?? 'user-speech');
            return okResult(session.requestBargeIn(requester, atMs));
          }
          case 'resume-remainder': {
            const responseId = getStringArg(args, 'responseId');
            return okResult(session.resumeRemainder(responseId, atMs));
          }
          case 'discard-remainder': {
            const responseId = getStringArg(args, 'responseId');
            return okResult({ discarded: session.discardRemainder(responseId, atMs) });
          }
          case 'mark-false-positive': return okResult({ sensitivity: session.markBargeInFalsePositive(atMs) });
          case 'schedule-proactive': {
            const kind = assertProactiveKind(getStringArg(args, 'kind'));
            const text = getStringArg(args, 'text');
            const priorityRaw = getOptionalStringArg(args, 'priority');
            const payload = parseStringRecord(getOptionalStringArg(args, 'payloadJson'), 'payloadJson');
            return okResult(session.scheduleProactive(kind, text, atMs, {
              priority: priorityRaw === undefined ? undefined : assertProactivePriority(priorityRaw),
              delayMs: getOptionalNumberArg(args, 'delayMs'),
              ttlMs: getOptionalNumberArg(args, 'ttlMs'),
              dedupeKey: getOptionalStringArg(args, 'dedupeKey') ?? null,
              payload,
            }));
          }
          case 'proactive-tick': return okResult(session.proactiveTick(atMs));
          case 'tick-cost': return okResult(session.tickCost(atMs));
          case 'forecast': return okResult(session.forecastCost(atMs));
          case 'degrade-duplex': {
            const reason = getOptionalStringArg(args, 'reason') ?? 'manual';
            if (!['queue-full', 'latency-slo-breach', 'crosstalk-storm', 'manual'].includes(reason)) {
              return errorResult(`Unknown degradation reason: ${reason}`);
            }
            session.degradeDuplex(reason as 'queue-full' | 'latency-slo-breach' | 'crosstalk-storm' | 'manual', atMs);
            return okResult(session.snapshot());
          }
          case 'recover-duplex': return okResult({ recovered: session.recoverDuplex(atMs), snapshot: session.snapshot() });
          default: return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const turnsTool: Tool = {
    definition: toolDef(
      'voice_v30_turns',
      'Audio turn detector v30 standalone (local, mock audio): feed frames (dual-threshold hysteresis, confirmation buffer, spike rejection, echo guard), stats (confidence, adaptive silence timeout, spikes), turn history, presets (sensitive, balanced, relaxed, push-to-talk, noisy-room), config, reset. No mic or network is touched.',
      {
        action: { type: 'string', description: 'feed, stats, turns, last-turn, preset, config, reset or presets.' },
        sessionId: { type: 'string', description: 'Detector id (any string; one detector per id).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (feed).' },
        isSpeech: { type: 'string', description: '"true" when the caller already knows the frame is speech (feed, optional).' },
        agentSpeaking: { type: 'string', description: '"true" when the frame overlaps agent audio (feed, optional).' },
        text: { type: 'string', description: 'Transcript fragment (feed, optional).' },
        preset: { type: 'string', description: 'Preset name: sensitive, balanced, relaxed, push-to-talk or noisy-room (preset).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['feed', 'stats', 'turns', 'last-turn', 'preset', 'config', 'reset', 'presets'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        if (action === 'presets') return okResult(Object.keys(VOICE_V30_TURN_PRESETS));
        const detector = needDetector(sessionId);
        switch (action) {
          case 'feed': {
            const energy = getNumberArg(args, 'energy', 0);
            const isSpeechRaw = getOptionalStringArg(args, 'isSpeech');
            const agentSpeakingRaw = getOptionalStringArg(args, 'agentSpeaking');
            return okResult(detector.feed({
              atMs,
              energy,
              isSpeech: isSpeechRaw === undefined ? undefined : isSpeechRaw === 'true',
              agentSpeaking: agentSpeakingRaw === undefined ? undefined : agentSpeakingRaw === 'true',
              text: getOptionalStringArg(args, 'text') ?? null,
            }));
          }
          case 'stats': return okResult(detector.stats());
          case 'turns': return okResult(detector.turnsSoFar());
          case 'last-turn': return okResult(detector.lastTurn());
          case 'preset': return okResult(detector.applyPreset(assertTurnPreset(getStringArg(args, 'preset'))));
          case 'config': return okResult(detector.getConfig());
          case 'reset': detector.reset(); return okResult({ reset: true });
          default: return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const duplexTool: Tool = {
    definition: toolDef(
      'voice_v30_duplex',
      'Full-duplex engine v30 standalone (local, mock audio): push/drain inbound (user) and outbound (agent) lanes through a jitter buffer, measure turns against first-byte/total latency SLOs, detect crosstalk, degrade to half-duplex under overload and recover, report, Markdown. No mic or network is touched.',
      {
        action: { type: 'string', description: 'push-inbound, push-outbound, drain-inbound, drain-outbound, start-turn, first-byte, end-turn, cancel-turn, stats, turns, report, markdown, degrade, recover or reset.' },
        sessionId: { type: 'string', description: 'Engine id (any string; one engine per id).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (push-inbound, push-outbound).' },
        text: { type: 'string', description: 'Chunk text (push-inbound, push-outbound, optional).' },
        maxFrames: { type: 'number', description: 'Max frames to drain (drain-inbound, drain-outbound, default 10).' },
        mode: { type: 'string', description: 'Pipeline mode: cascaded or speech-to-speech (start-turn, optional).' },
        reason: { type: 'string', description: 'Degradation reason: queue-full, latency-slo-breach, crosstalk-storm or manual (degrade).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['push-inbound', 'push-outbound', 'drain-inbound', 'drain-outbound', 'start-turn', 'first-byte', 'end-turn', 'cancel-turn', 'stats', 'turns', 'report', 'markdown', 'degrade', 'recover', 'reset'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const engine = needDuplex(sessionId);
        switch (action) {
          case 'push-inbound': {
            const energy = getNumberArg(args, 'energy', 0);
            return okResult(engine.pushInbound(atMs, energy, getOptionalStringArg(args, 'text') ?? null));
          }
          case 'push-outbound': {
            const energy = getNumberArg(args, 'energy', 0);
            return okResult(engine.pushOutbound(atMs, energy, getOptionalStringArg(args, 'text') ?? null));
          }
          case 'drain-inbound': return okResult(engine.drainInbound(getNumberArg(args, 'maxFrames', 10)));
          case 'drain-outbound': return okResult(engine.drainOutbound(getNumberArg(args, 'maxFrames', 10)));
          case 'start-turn': {
            const mode = getOptionalStringArg(args, 'mode') ?? 'speech-to-speech';
            if (mode !== 'cascaded' && mode !== 'speech-to-speech') return errorResult(`Unknown mode: ${mode}`);
            return okResult({ turnId: engine.startTurn(mode, atMs) });
          }
          case 'first-byte': engine.markFirstByte(atMs); return okResult({ marked: true, atMs });
          case 'end-turn': return okResult(engine.endTurn(atMs));
          case 'cancel-turn': return okResult({ cancelled: engine.cancelTurn() });
          case 'stats': return okResult(engine.stats());
          case 'turns': return okResult(engine.turnsSoFar());
          case 'report': return okResult(engine.report());
          case 'markdown': return engine.toMarkdown();
          case 'degrade': {
            const reason = getOptionalStringArg(args, 'reason') ?? 'manual';
            if (!['queue-full', 'latency-slo-breach', 'crosstalk-storm', 'manual'].includes(reason)) {
              return errorResult(`Unknown degradation reason: ${reason}`);
            }
            engine.degrade(reason as 'queue-full' | 'latency-slo-breach' | 'crosstalk-storm' | 'manual', atMs);
            return okResult(engine.stats());
          }
          case 'recover': return okResult({ recovered: engine.recover(atMs) });
          case 'reset': engine.reset(); return okResult({ reset: true });
          default: return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const bargeInTool: Tool = {
    definition: toolDef(
      'voice_v30_bargein',
      'Barge-in engine v30 standalone (local, mock audio): server-driven responses, soft interrupts (pause + resume from a sentence boundary) vs hard interrupts (cancel), confidence from sustained speech plus energy slope, cooldown after each barge-in, false-positive feedback that lowers sensitivity, stats, event history. No mic or network is touched.',
      {
        action: { type: 'string', description: 'start-response, mark-spoken, complete-response, cancel-response, request-interrupt, resume-remainder, discard-remainder, mark-false-positive, stats, events, responses or score.' },
        sessionId: { type: 'string', description: 'Engine id (any string; one engine per id).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        text: { type: 'string', description: 'Response text (start-response).' },
        responseId: { type: 'string', description: 'Server response id.' },
        spokenChars: { type: 'number', description: 'Characters spoken so far (mark-spoken).' },
        requester: { type: 'string', description: 'Who asks to interrupt: user-speech, user-button, server or system (request-interrupt).' },
        speechMs: { type: 'number', description: 'Caller-measured user speech duration ms (request-interrupt, score).' },
        peakEnergy: { type: 'number', description: 'Peak frame energy 0..1 (request-interrupt, score).' },
        energiesJson: { type: 'string', description: 'Recent frame energies as a JSON number array, oldest first (request-interrupt, score, optional).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['start-response', 'mark-spoken', 'complete-response', 'cancel-response', 'request-interrupt', 'resume-remainder', 'discard-remainder', 'mark-false-positive', 'stats', 'events', 'responses', 'score'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const engine = needBargeIn(sessionId);
        const energies = (): number[] => {
          const raw = parseJsonArg(getOptionalStringArg(args, 'energiesJson'), 'energiesJson');
          if (raw === undefined) return [];
          if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'number')) {
            throw new Error('energiesJson must be a JSON array of numbers');
          }
          return raw as number[];
        };
        switch (action) {
          case 'start-response': {
            const text = getStringArg(args, 'text');
            return okResult(engine.serverStartResponse(text, atMs, sessionId));
          }
          case 'mark-spoken': {
            const responseId = getStringArg(args, 'responseId');
            return okResult(engine.serverMarkSpoken(responseId, getNumberArg(args, 'spokenChars', 0), atMs));
          }
          case 'complete-response': {
            const responseId = getStringArg(args, 'responseId');
            return okResult(engine.serverCompleteResponse(responseId, atMs));
          }
          case 'cancel-response': {
            const responseId = getStringArg(args, 'responseId');
            return okResult(engine.serverCancelResponse(responseId, atMs));
          }
          case 'request-interrupt': {
            const requester = assertRequester(getOptionalStringArg(args, 'requester') ?? 'user-speech');
            return okResult(engine.requestInterrupt(
              requester,
              atMs,
              getNumberArg(args, 'speechMs', 0),
              getNumberArg(args, 'peakEnergy', 0),
              energies(),
            ));
          }
          case 'score': {
            return okResult({
              confidence: engine.scoreInterruption(
                getNumberArg(args, 'speechMs', 0),
                energies(),
                getNumberArg(args, 'peakEnergy', 0),
              ),
            });
          }
          case 'resume-remainder': {
            const responseId = getStringArg(args, 'responseId');
            return okResult(engine.resumeRemainder(responseId, atMs, sessionId));
          }
          case 'discard-remainder': {
            const responseId = getStringArg(args, 'responseId');
            return okResult({ discarded: engine.discardRemainder(responseId, atMs) });
          }
          case 'mark-false-positive': return okResult({ sensitivity: engine.markFalsePositive(atMs) });
          case 'stats': return okResult(engine.stats());
          case 'events': return okResult(engine.eventsSoFar());
          case 'responses': return okResult(engine.listResponses());
          default: return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const proactiveTool: Tool = {
    definition: toolDef(
      'voice_v30_proactive',
      'Proactive audio v30 standalone (local, mock audio): schedule triggers (task-complete, alert, reminder, greeting, idle-nudge, ...) with priority, TTL and dedupe keys, tick the priority queue under quiet-hours / do-not-disturb / presence / rate-limit gates, text fallback when audio is suppressed, stats, event history. No mic, speaker or network is touched.',
      {
        action: { type: 'string', description: 'schedule, tick, list, due, cancel, get, stats, events, text-fallbacks, enable, quiet-hours, dnd, presence or priorities.' },
        sessionId: { type: 'string', description: 'Proactive id (any string; one queue per id).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        kind: { type: 'string', description: 'Proactive kind: greeting, idle-nudge, scheduled-reminder, event-announcement, follow-up, task-complete, alert or digest (schedule).' },
        priority: { type: 'string', description: 'Priority: critical, high, normal or low (schedule, optional).' },
        text: { type: 'string', description: 'Trigger text (schedule).' },
        delayMs: { type: 'number', description: 'Delay ms before the trigger is due (schedule, optional).' },
        ttlMs: { type: 'number', description: 'TTL ms after which an undelivered trigger expires (schedule, optional).' },
        dedupeKey: { type: 'string', description: 'Dedupe key (schedule, optional).' },
        payloadJson: { type: 'string', description: 'Trigger payload as a JSON object of strings (schedule, optional).' },
        triggerId: { type: 'string', description: 'Trigger id (cancel, get).' },
        userSpeaking: { type: 'string', description: '"true" when the user is speaking (tick, optional).' },
        enabled: { type: 'string', description: '"true"/"false" master switch (enable).' },
        quietStart: { type: 'number', description: 'Quiet-hours start hour 0-23 UTC (quiet-hours, -1 clears).' },
        quietEnd: { type: 'number', description: 'Quiet-hours end hour 0-23 UTC (quiet-hours, -1 clears).' },
        dnd: { type: 'string', description: '"true"/"false" do-not-disturb (dnd).' },
        present: { type: 'string', description: '"true"/"false" user is present (presence).' },
        inCall: { type: 'string', description: '"true"/"false" user is in another call (presence).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['schedule', 'tick', 'list', 'due', 'cancel', 'get', 'stats', 'events', 'text-fallbacks', 'enable', 'quiet-hours', 'dnd', 'presence', 'priorities'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        if (action === 'priorities') return okResult({ ...VOICE_V30_PROACTIVE_KIND_PRIORITY });
        const queue = needProactive(sessionId);
        switch (action) {
          case 'schedule': {
            const kind = assertProactiveKind(getStringArg(args, 'kind'));
            const text = getStringArg(args, 'text');
            const priorityRaw = getOptionalStringArg(args, 'priority');
            const payload = parseStringRecord(getOptionalStringArg(args, 'payloadJson'), 'payloadJson');
            return okResult(queue.schedule(kind, text, atMs, {
              priority: priorityRaw === undefined ? undefined : assertProactivePriority(priorityRaw),
              delayMs: getOptionalNumberArg(args, 'delayMs'),
              ttlMs: getOptionalNumberArg(args, 'ttlMs'),
              dedupeKey: getOptionalStringArg(args, 'dedupeKey') ?? null,
              payload,
            }));
          }
          case 'tick': return okResult(queue.tick(atMs, getBoolArg(args, 'userSpeaking', false)));
          case 'list': return okResult(queue.list());
          case 'due': return okResult(queue.due(atMs));
          case 'cancel': return okResult({ cancelled: queue.cancel(getStringArg(args, 'triggerId'), atMs) });
          case 'get': return okResult(queue.get(getStringArg(args, 'triggerId')));
          case 'stats': return okResult(queue.stats());
          case 'events': return okResult(queue.eventsSoFar());
          case 'text-fallbacks': return okResult(queue.textFallbacksSoFar());
          case 'enable': {
            const enabled = getBoolArg(args, 'enabled', true);
            queue.setEnabled(enabled);
            return okResult({ enabled: queue.isEnabled() });
          }
          case 'quiet-hours': {
            const start = getOptionalNumberArg(args, 'quietStart');
            const end = getOptionalNumberArg(args, 'quietEnd');
            queue.setQuietHours(start === undefined || start < 0 ? null : start, end === undefined || end < 0 ? null : end);
            return okResult(queue.getQuietHours());
          }
          case 'dnd': {
            const dnd = getBoolArg(args, 'dnd', false);
            queue.setDoNotDisturb(dnd);
            return okResult({ doNotDisturb: dnd });
          }
          case 'presence': {
            const present = getBoolArg(args, 'present', true);
            const inCall = getBoolArg(args, 'inCall', false);
            queue.setPresence(present, inCall);
            return okResult({ present, inCall });
          }
          default: return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const costTool: Tool = {
    definition: toolDef(
      'voice_v30_cost',
      'Cost ledger v30 (local, planning rates only): rate table, cost estimate (audio minutes + text tokens), start/stop a session meter, tick slices (input/output/proactive minutes + tokens), report (per-kind, per-model, per-session, per-day/week/month), run-rate forecast, itemised session statement (Markdown / CSV / JSON), alerts, host rate overrides. No provider is dialled and no key is read.',
      {
        action: { type: 'string', description: 'rates, estimate, start, stop, tick, meter, meters, report, forecast, statement-md, statement-csv, json, alerts, override-rate, override-token-rate or markdown.' },
        sessionId: { type: 'string', description: 'Voice session id (start, stop, tick, meter, statement-*).' },
        modelId: { type: 'string', description: 'Model id (estimate, start, override-rate, override-token-rate).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        minutes: { type: 'number', description: 'Minutes to price (estimate).' },
        tokens: { type: 'number', description: 'Text tokens (estimate, tick).' },
        inputMs: { type: 'number', description: 'User audio ms since the last tick (tick).' },
        outputMs: { type: 'number', description: 'Agent audio ms since the last tick (tick).' },
        proactiveMs: { type: 'number', description: 'Proactive audio ms since the last tick (tick).' },
        usdPerMinute: { type: 'number', description: 'Host minute rate USD/min (override-rate).' },
        usdPerKiloToken: { type: 'number', description: 'Host token rate USD per 1k tokens (override-token-rate).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['rates', 'estimate', 'start', 'stop', 'tick', 'meter', 'meters', 'report', 'forecast', 'statement-md', 'statement-csv', 'json', 'alerts', 'override-rate', 'override-token-rate', 'markdown'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        switch (action) {
          case 'rates': return okResult(sharedLedger.getRates());
          case 'report': return okResult(sharedLedger.report());
          case 'forecast': return okResult(sharedLedger.forecast(atMs));
          case 'json': return sharedLedger.toJson();
          case 'markdown': return sharedLedger.toMarkdown();
          case 'alerts': return okResult(sharedLedger.alertsSoFar());
          case 'meters': return okResult(sharedLedger.listMeters());
          case 'estimate': {
            const modelId = assertModelId(getStringArg(args, 'modelId'));
            return okResult(sharedLedger.estimate(modelId, getNumberArg(args, 'minutes', 0), getNumberArg(args, 'tokens', 0), atMs));
          }
          case 'start': {
            const sessionId = getStringArg(args, 'sessionId');
            const modelId = assertModelId(getStringArg(args, 'modelId'));
            return okResult(sharedLedger.startSession(sessionId, modelId, atMs));
          }
          case 'stop': {
            const sessionId = getStringArg(args, 'sessionId');
            return okResult(sharedLedger.stopSession(sessionId, atMs));
          }
          case 'tick': {
            const sessionId = getStringArg(args, 'sessionId');
            return okResult(sharedLedger.tick(sessionId, {
              inputMs: getOptionalNumberArg(args, 'inputMs'),
              outputMs: getOptionalNumberArg(args, 'outputMs'),
              proactiveMs: getOptionalNumberArg(args, 'proactiveMs'),
              tokens: getOptionalNumberArg(args, 'tokens'),
            }, atMs));
          }
          case 'meter': {
            const sessionId = getStringArg(args, 'sessionId');
            return okResult(sharedLedger.getMeter(sessionId));
          }
          case 'statement-md': {
            const sessionId = getStringArg(args, 'sessionId');
            return sharedLedger.statementMarkdown(sessionId);
          }
          case 'statement-csv': {
            const sessionId = getStringArg(args, 'sessionId');
            return sharedLedger.statementCsv(sessionId);
          }
          case 'override-rate': {
            const modelId = assertModelId(getStringArg(args, 'modelId'));
            return okResult(sharedLedger.overrideRate(modelId, getNumberArg(args, 'usdPerMinute', 0)));
          }
          case 'override-token-rate': {
            const modelId = assertModelId(getStringArg(args, 'modelId'));
            return okResult(sharedLedger.overrideTokenRate(modelId, getNumberArg(args, 'usdPerKiloToken', 0)));
          }
          default: return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  return [sessionTool, turnsTool, duplexTool, bargeInTool, proactiveTool, costTool];
}

export const VOICE_V30_TOOLS: Tool[] = createVoiceV30Tools();

export const VOICE_V30_TOOL_NAMES = [
  'voice_v30_session',
  'voice_v30_turns',
  'voice_v30_duplex',
  'voice_v30_bargein',
  'voice_v30_proactive',
  'voice_v30_cost',
] as const;

export function isVoiceV30ToolName(name: string): name is (typeof VOICE_V30_TOOL_NAMES)[number] {
  return (VOICE_V30_TOOL_NAMES as readonly string[]).includes(name);
}
