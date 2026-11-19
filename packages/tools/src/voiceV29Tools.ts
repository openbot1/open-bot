/**
 * Voice v29 tools for @open-bot/tools (v1.42, Team T4 — completed by coordinator
 * after three T4 agents were killed by daemon restarts; core written by T4 #2).
 *
 * The agent drives the voice v29 full-duplex loop by tool call:
 *  - voice_v29_session — a full-duplex session: start / pause /
 *    resume / stop, feed user audio frames (energy), end the user
 *    turn, server-driven agent responses (respond / spoken /
 *    done), barge-in (interrupt + resume remainder), run a
 *    cascaded or speech-to-speech pipeline turn, delegate a tool
 *    call to the text model, pump delegated results, schedule /
 *    tick proactive audio, meter cost, snapshot / stats / log
 *  - voice_v29_turns — the audio turn detector standalone: feed
 *    frames, stats, turn history, reset
 *  - voice_v29_context — the append-only conversation context
 *    standalone: append turns/tool calls, list/live/as-of/search,
 *    compact (adds a summary, never edits), stats, Markdown
 *  - voice_v29_delegate — the delegated async tool runner
 *    standalone: register a mock tool, delegate, pump, list
 *    calls, stats
 *  - voice_v29_proactive — proactive audio standalone: schedule
 *    greeting / idle nudge / reminder, tick, list, cancel, stats
 *  - voice_v29_pipeline — the cascaded STT -> LLM -> TTS pipeline
 *    standalone: run cascaded / speech-to-speech turns, record a
 *    turn with measured stages, budgets, stats, report
 *  - voice_v29_cost — per-minute cost accounting: rate table,
 *    estimate, start/stop a session meter, tick, report, alerts,
 *    Markdown, host rate override
 *
 * SAFETY: everything here is local — clocks are virtual, audio is
 * mock/synthetic frame energy, no provider is dialled, no key is
 * read or stored, no live API is called. Delegated tools are mock
 * executors registered by the host (an `echo` tool is registered
 * by default so delegation works out of the box).
 *
 * Factory:
 *   createVoiceV29Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V29_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  AppendOnlyContextV29,
  AudioTurnDetectorV29,
  CascadedPipelineV29,
  CostLedgerV29,
  DelegatedToolRunnerV29,
  FullDuplexSessionV29,
  ProactiveAudioV29,
  VOICE_V29_CASCADED_BUDGET_TOTAL_MS,
  VOICE_V29_I18N_KEYS,
  VOICE_V29_MODEL_CATALOG,
  VOICE_V29_S2S_BUDGET_TOTAL_MS,
  VOICE_V29_TURN_PRESETS,
  costForMinutesV29,
  createAppendOnlyContextV29,
  createAudioTurnDetectorV29,
  createCascadedPipelineV29,
  createCostLedgerV29,
  createDelegatedToolRunnerV29,
  createFullDuplexSessionV29,
  createProactiveAudioV29,
  isKnownModelV29,
  modelInfoV29,
  rateForModelV29,
  type VoiceV29ContextItemKind,
  type VoiceV29DelegatedToolDef,
  type VoiceV29InterruptRequester,
  type VoiceV29ModelId,
  type VoiceV29PipelineMode,
  type VoiceV29ProactiveKind,
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

function parseStringRecord(value: string | undefined, name: string): Record<string, unknown> {
  const raw = parseJsonArg(value, name);
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function isAction(list: readonly string[], v: string): boolean {
  return (list as readonly string[]).includes(v);
}

function assertModelId(value: string): VoiceV29ModelId {
  if (!isKnownModelV29(value)) throw new Error(`Unknown voice model: ${value}`);
  return value as VoiceV29ModelId;
}

function assertRequester(value: string): VoiceV29InterruptRequester {
  const allowed = ['user-speech', 'user-button', 'server', 'system'];
  if (!allowed.includes(value)) throw new Error(`Unknown interrupt requester: ${value}`);
  return value as VoiceV29InterruptRequester;
}

function assertProactiveKind(value: string): VoiceV29ProactiveKind {
  const allowed = ['greeting', 'idle-nudge', 'reminder', 'check-in', 'follow-up'];
  if (!allowed.includes(value)) throw new Error(`Unknown proactive kind: ${value}`);
  return value as VoiceV29ProactiveKind;
}

function assertContextKind(value: string): VoiceV29ContextItemKind {
  const allowed = [
    'user-turn',
    'agent-turn',
    'tool-call',
    'tool-result',
    'system-note',
    'summary',
    'proactive',
    'supersede-marker',
  ];
  if (!allowed.includes(value)) throw new Error(`Unknown context item kind: ${value}`);
  return value as VoiceV29ContextItemKind;
}

function assertSpeaker(value: string): 'user' | 'agent' | 'system' | 'tool' {
  if (value !== 'user' && value !== 'agent' && value !== 'system' && value !== 'tool') {
    throw new Error(`Unknown speaker: ${value}`);
  }
  return value;
}

export interface VoiceV29ToolOptions {
  /** Shared full-duplex session accessor (per session id). */
  getSession?: (sessionId: string) => FullDuplexSessionV29 | null;
  /** Default bot id used when an action omits botId. */
  defaultBotId?: string | null;
  /** Default model id for new sessions (default 'mock-cascaded'). */
  defaultModelId?: VoiceV29ModelId;
}

const ECHO_TOOL_DEF: VoiceV29DelegatedToolDef = {
  name: 'echo',
  description: 'Mock delegated tool: echoes its args back as JSON.',
  sensitive: false,
  execute: (args) => JSON.stringify({ echoed: args }),
};

export function createVoiceV29Tools(opts: VoiceV29ToolOptions = {}): Tool[] {
  const sessions = new Map<string, FullDuplexSessionV29>();
  const openedSessions = new Set<string>();
  const standaloneDetectors = new Map<string, AudioTurnDetectorV29>();
  const standaloneContexts = new Map<string, AppendOnlyContextV29>();
  const standaloneRunners = new Map<string, DelegatedToolRunnerV29>();
  const standaloneProactive = new Map<string, ProactiveAudioV29>();
  const standalonePipelines = new Map<string, CascadedPipelineV29>();
  const sharedLedger = new CostLedgerV29();

  const needSession = (sessionId: string, botId: string | null, modelId?: string): FullDuplexSessionV29 => {
    const shared = opts.getSession?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = sessions.get(sessionId);
    if (found === undefined) {
      found = createFullDuplexSessionV29({
        sessionId,
        botId,
        modelId: modelId ? assertModelId(modelId) : (opts.defaultModelId ?? 'mock-cascaded'),
      });
      found.delegate.registerTool(ECHO_TOOL_DEF);
      sessions.set(sessionId, found);
    }
    return found;
  };

  const needDetector = (sessionId: string): AudioTurnDetectorV29 => {
    let found = standaloneDetectors.get(sessionId);
    if (found === undefined) {
      found = createAudioTurnDetectorV29();
      standaloneDetectors.set(sessionId, found);
    }
    return found;
  };

  const needContext = (sessionId: string): AppendOnlyContextV29 => {
    const session = sessions.get(sessionId) ?? opts.getSession?.(sessionId) ?? null;
    if (session) return session.context;
    let found = standaloneContexts.get(sessionId);
    if (found === undefined) {
      found = createAppendOnlyContextV29({ sessionId });
      standaloneContexts.set(sessionId, found);
    }
    return found;
  };

  const needRunner = (sessionId: string): DelegatedToolRunnerV29 => {
    const session = sessions.get(sessionId) ?? opts.getSession?.(sessionId) ?? null;
    if (session) return session.delegate;
    let found = standaloneRunners.get(sessionId);
    if (found === undefined) {
      found = createDelegatedToolRunnerV29();
      found.registerTool(ECHO_TOOL_DEF);
      standaloneRunners.set(sessionId, found);
    }
    return found;
  };

  const needProactive = (sessionId: string): ProactiveAudioV29 => {
    const session = sessions.get(sessionId) ?? opts.getSession?.(sessionId) ?? null;
    if (session) return session.proactive;
    let found = standaloneProactive.get(sessionId);
    if (found === undefined) {
      found = createProactiveAudioV29();
      standaloneProactive.set(sessionId, found);
    }
    return found;
  };

  const needPipeline = (sessionId: string): CascadedPipelineV29 => {
    const session = sessions.get(sessionId) ?? opts.getSession?.(sessionId) ?? null;
    if (session) return session.pipeline;
    let found = standalonePipelines.get(sessionId);
    if (found === undefined) {
      found = createCascadedPipelineV29();
      standalonePipelines.set(sessionId, found);
    }
    return found;
  };

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v29_session',
      'Full-duplex voice session v29 (local, mock audio): start / pause / resume / stop a session, feed user audio frames (energy), end the user turn, drive server-driven agent responses (respond / spoken / done), barge in (interrupt + resume remainder), run a cascaded or speech-to-speech pipeline turn, delegate a tool call to the text model, pump delegated results, schedule / tick proactive audio, meter cost, snapshot / stats / session log. No mic, sound card, network or key is touched.',
      {
        action: { type: 'string', description: 'start, pause, resume, stop, status, snapshot, stats, log, feed-frame, end-turn, respond, response-spoken, response-done, barge-in, resume-remainder, pipeline-turn, delegate-tool, pump-delegated, schedule-proactive, proactive-tick, tick-cost, models or i18n-keys.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        botId: { type: 'string', description: 'Bot id (start, optional).' },
        modelId: { type: 'string', description: 'Model id: gpt-realtime-2.1, gpt-realtime-2.1-mini, gpt-live, gemini-3.8-live, livekit-agents-1.0 or mock-cascaded (start, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (feed-frame).' },
        isSpeech: { type: 'string', description: '"true" when the caller already knows the frame is speech (feed-frame, optional).' },
        text: { type: 'string', description: 'Response text (respond) or proactive text (schedule-proactive) or frame transcript fragment (feed-frame, optional).' },
        responseId: { type: 'string', description: 'Server response id (response-spoken, response-done, resume-remainder).' },
        spokenChars: { type: 'number', description: 'Characters spoken so far (response-spoken).' },
        requester: { type: 'string', description: 'Who asks to interrupt: user-speech, user-button, server or system (barge-in).' },
        speechMs: { type: 'number', description: 'Caller-measured user speech duration ms (barge-in).' },
        mode: { type: 'string', description: 'Pipeline mode: cascaded or speech-to-speech (pipeline-turn, optional).' },
        toolName: { type: 'string', description: 'Delegated tool name (delegate-tool; "echo" is registered by default).' },
        argsJson: { type: 'string', description: 'Delegated tool args as a JSON object (delegate-tool, optional).' },
        kind: { type: 'string', description: 'Proactive kind: greeting, idle-nudge, reminder, check-in or follow-up (schedule-proactive).' },
        dueAtMs: { type: 'number', description: 'Virtual ms when the proactive trigger is due (schedule-proactive).' },
        sttMs: { type: 'number', description: 'Mock STT stage duration ms (pipeline-turn, optional).' },
        llmMs: { type: 'number', description: 'Mock LLM stage duration ms (pipeline-turn, optional).' },
        ttsMs: { type: 'number', description: 'Mock TTS stage duration ms (pipeline-turn, optional).' },
        s2sMs: { type: 'number', description: 'Mock speech-to-speech stage duration ms (pipeline-turn, optional).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        const botId = getOptionalStringArg(args, 'botId') ?? opts.defaultBotId ?? null;
        if (!isAction(
          ['start', 'pause', 'resume', 'stop', 'status', 'snapshot', 'stats', 'log', 'feed-frame', 'end-turn', 'respond', 'response-spoken', 'response-done', 'barge-in', 'resume-remainder', 'pipeline-turn', 'delegate-tool', 'pump-delegated', 'schedule-proactive', 'proactive-tick', 'tick-cost', 'models', 'i18n-keys'],
          action,
        )) {
          return errorResult(`Unknown action: ${action}`);
        }
        if (action === 'models') return okResult(VOICE_V29_MODEL_CATALOG);
        if (action === 'i18n-keys') return okResult([...VOICE_V29_I18N_KEYS]);
        if (action === 'start') {
          if (openedSessions.has(sessionId)) return errorResult(`Session already started: ${sessionId}`);
          const modelId = getOptionalStringArg(args, 'modelId');
          const session = needSession(sessionId, botId, modelId);
          openedSessions.add(sessionId);
          return okResult(session.start(atMs));
        }
        const session = sessions.get(sessionId) ?? opts.getSession?.(sessionId) ?? null;
        if (session === null) return errorResult(`Unknown session: ${sessionId} (start it first)`);
        switch (action) {
          case 'pause':
            return okResult(session.pause(atMs));
          case 'resume':
            return okResult(session.resume(atMs));
          case 'stop':
            return okResult(session.stop(atMs));
          case 'status':
          case 'snapshot':
            return okResult(session.snapshot());
          case 'stats':
            return okResult(session.stats());
          case 'log':
            return okResult(session.logEventsSoFar());
          case 'feed-frame': {
            const energy = getNumberArg(args, 'energy', 0);
            const frame = {
              atMs,
              energy,
              isSpeech: getOptionalStringArg(args, 'isSpeech') === 'true' ? true : undefined,
              text: getOptionalStringArg(args, 'text') ?? null,
            };
            return okResult(session.feedUserFrame(frame));
          }
          case 'end-turn': {
            const turn = session.endUserTurnNow(atMs);
            return okResult(turn ?? { ended: false, reason: 'no active turn' });
          }
          case 'respond': {
            const text = getStringArg(args, 'text');
            return okResult(session.serverRespond(text, atMs));
          }
          case 'response-spoken': {
            const responseId = getStringArg(args, 'responseId');
            const spokenChars = getNumberArg(args, 'spokenChars', 0);
            const response = session.markResponseSpoken(responseId, spokenChars, atMs);
            return okResult(response ?? { marked: false, reason: 'unknown response' });
          }
          case 'response-done': {
            const responseId = getStringArg(args, 'responseId');
            const response = session.completeResponse(responseId, atMs);
            return okResult(response ?? { completed: false, reason: 'unknown response' });
          }
          case 'barge-in': {
            const requester = assertRequester(getOptionalStringArg(args, 'requester') ?? 'user-speech');
            const speechMs = getNumberArg(args, 'speechMs', 0);
            const energy = getNumberArg(args, 'energy', 0);
            return okResult(session.requestBargeIn(atMs, requester, speechMs, energy));
          }
          case 'resume-remainder': {
            const responseId = getStringArg(args, 'responseId');
            const resumed = session.resumeRemainder(responseId, atMs);
            return okResult(resumed ?? { resumed: false, reason: 'no remainder kept' });
          }
          case 'pipeline-turn': {
            const input = getStringArg(args, 'text');
            const modeRaw = getOptionalStringArg(args, 'mode') ?? 'cascaded';
            if (modeRaw !== 'cascaded' && modeRaw !== 'speech-to-speech') {
              return errorResult(`Unknown pipeline mode: ${modeRaw}`);
            }
            const stageDurations: Record<string, number> = {};
            const stt = getOptionalNumberArg(args, 'sttMs');
            const llm = getOptionalNumberArg(args, 'llmMs');
            const tts = getOptionalNumberArg(args, 'ttsMs');
            const s2s = getOptionalNumberArg(args, 's2sMs');
            if (stt !== undefined) stageDurations.stt = stt;
            if (llm !== undefined) stageDurations.llm = llm;
            if (tts !== undefined) stageDurations.tts = tts;
            if (s2s !== undefined) stageDurations['s2s-direct'] = s2s;
            return okResult(await session.runPipelineTurn(input, atMs, modeRaw as VoiceV29PipelineMode, stageDurations));
          }
          case 'delegate-tool': {
            const toolName = getStringArg(args, 'toolName');
            const toolArgs = parseStringRecord(getOptionalStringArg(args, 'argsJson'), 'argsJson');
            return okResult(session.delegateTool(toolName, toolArgs, atMs));
          }
          case 'pump-delegated':
            return okResult(await session.pumpDelegated(atMs));
          case 'schedule-proactive': {
            const kind = assertProactiveKind(getStringArg(args, 'kind'));
            const text = getStringArg(args, 'text');
            const dueAtMs = getNumberArg(args, 'dueAtMs', atMs);
            return okResult(session.scheduleProactive(kind, text, dueAtMs));
          }
          case 'proactive-tick': {
            const fired = session.proactiveTick(atMs);
            return okResult(fired ?? { fired: false });
          }
          case 'tick-cost': {
            const entry = session.tickCost(atMs);
            return okResult(entry ?? { billed: false, reason: 'no cost tick due' });
          }
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const turnsTool: Tool = {
    definition: toolDef(
      'voice_v29_turns',
      'Audio turn detector v29 (local): feed energy frames and watch user turns start/end, with backchannel filtering, noise-floor learning, silence timeout and max-duration cap. Read turn history and detector stats, or reset. All offline, virtual clock.',
      {
        action: { type: 'string', description: 'feed, stats, turns, last-turn, reset or presets.' },
        sessionId: { type: 'string', description: 'Voice session id (detector namespace).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (feed).' },
        isSpeech: { type: 'string', description: '"true" when the caller already knows the frame is speech (feed, optional).' },
        text: { type: 'string', description: 'Transcript fragment for keyword end detection (feed, optional).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['feed', 'stats', 'turns', 'last-turn', 'reset', 'presets'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        if (action === 'presets') return okResult(VOICE_V29_TURN_PRESETS);
        const detector = needDetector(sessionId);
        switch (action) {
          case 'feed': {
            const energy = getNumberArg(args, 'energy', 0);
            return okResult(detector.feed({
              atMs,
              energy,
              isSpeech: getOptionalStringArg(args, 'isSpeech') === 'true' ? true : undefined,
              text: getOptionalStringArg(args, 'text') ?? null,
            }));
          }
          case 'stats':
            return okResult(detector.stats());
          case 'turns':
            return okResult(detector.turnsSoFar());
          case 'last-turn': {
            const turn = detector.lastTurn();
            return okResult(turn ?? { turn: null });
          }
          case 'reset':
            detector.reset();
            return okResult({ reset: true });
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const contextTool: Tool = {
    definition: toolDef(
      'voice_v29_context',
      'Append-only conversation context v29 (local): append user/agent turns and tool calls, list all or live items, query "as of" a virtual time (time-travel), search, compact (appends a summary and marks old items superseded — nothing is ever edited or deleted), read stats, or export Markdown. Context is append-only by construction.',
      {
        action: { type: 'string', description: 'append, user-turn, agent-turn, tool-call, all, live, as-of, by-kind, by-turn, search, get, compact, needs-compaction, stats, markdown or snapshot.' },
        sessionId: { type: 'string', description: 'Voice session id (context namespace).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        kind: { type: 'string', description: 'Item kind (append): user-turn, agent-turn, tool-call, tool-result, system-note, summary, proactive or supersede-marker.' },
        speaker: { type: 'string', description: 'Item speaker (append): user, agent, system or tool.' },
        text: { type: 'string', description: 'Item text (append, user-turn, agent-turn, tool-call).' },
        toolName: { type: 'string', description: 'Tool name (tool-call).' },
        argsJson: { type: 'string', description: 'Tool call args as JSON (tool-call, optional).' },
        result: { type: 'string', description: 'Tool result (tool-call, optional).' },
        query: { type: 'string', description: 'Search text (search).' },
        seq: { type: 'number', description: 'Sequence number (get).' },
        turnIndex: { type: 'number', description: 'Turn index (by-turn, append, optional).' },
        summary: { type: 'string', description: 'Summary text for compaction (compact, optional).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['append', 'user-turn', 'agent-turn', 'tool-call', 'all', 'live', 'as-of', 'by-kind', 'by-turn', 'search', 'get', 'compact', 'needs-compaction', 'stats', 'markdown', 'snapshot'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const context = needContext(sessionId);
        switch (action) {
          case 'append': {
            const kind = assertContextKind(getStringArg(args, 'kind'));
            const speaker = assertSpeaker(getStringArg(args, 'speaker'));
            const text = getStringArg(args, 'text');
            const turnIndex = getOptionalNumberArg(args, 'turnIndex');
            return okResult(context.append(kind, speaker, text, atMs, turnIndex === undefined ? {} : { turnIndex }));
          }
          case 'user-turn':
            return okResult(context.appendUserTurn(getStringArg(args, 'text'), atMs));
          case 'agent-turn':
            return okResult(context.appendAgentTurn(getStringArg(args, 'text'), atMs));
          case 'tool-call': {
            const toolName = getStringArg(args, 'toolName');
            const toolArgs = getOptionalStringArg(args, 'argsJson') ?? '{}';
            const result = getOptionalStringArg(args, 'result') ?? '';
            return okResult(context.appendToolCall(toolName, toolArgs, result, atMs));
          }
          case 'all':
            return okResult(context.all());
          case 'live':
            return okResult(context.live());
          case 'as-of':
            return okResult(context.asOf(atMs));
          case 'by-kind':
            return okResult(context.byKind(assertContextKind(getStringArg(args, 'kind'))));
          case 'by-turn': {
            const turnIndex = getNumberArg(args, 'turnIndex', 0);
            return okResult(context.byTurn(turnIndex));
          }
          case 'search':
            return okResult(context.search(getStringArg(args, 'query')));
          case 'get': {
            const seq = getNumberArg(args, 'seq', 0);
            const item = context.get(seq);
            return okResult(item ?? { item: null });
          }
          case 'compact': {
            const summary = getOptionalStringArg(args, 'summary');
            const result = context.compact(atMs, undefined, summary);
            return okResult(result ?? { compacted: false, reason: 'nothing to compact' });
          }
          case 'needs-compaction':
            return okResult({ needsCompaction: context.needsCompaction() });
          case 'stats':
            return okResult(context.stats());
          case 'markdown':
            return okResult({ markdown: context.toMarkdown() });
          case 'snapshot':
            return okResult(context.snapshot());
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const delegateTool: Tool = {
    definition: toolDef(
      'voice_v29_delegate',
      'Delegated async tool calling v29 (local): a separate text model runs the tools while the voice model keeps talking. Register a mock tool (echo is registered by default), delegate a call (async by default, sync when asked), pump the queue at virtual time, list calls, cancel, or read stats. Sensitive tools wait for approval before running.',
      {
        action: { type: 'string', description: 'register, unregister, list-tools, delegate, pump, calls, pending, get, cancel, stats or get-tool.' },
        sessionId: { type: 'string', description: 'Voice session id (runner namespace).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        toolName: { type: 'string', description: 'Tool name (register, delegate, unregister, get-tool).' },
        description: { type: 'string', description: 'Tool description (register, optional).' },
        sensitive: { type: 'string', description: '"true" when the tool needs human approval (register, optional).' },
        argsJson: { type: 'string', description: 'Tool args as a JSON object (delegate, optional).' },
        mode: { type: 'string', description: 'Call mode: async or sync (delegate, optional).' },
        callId: { type: 'string', description: 'Delegated call id (get, cancel).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['register', 'unregister', 'list-tools', 'delegate', 'pump', 'calls', 'pending', 'get', 'cancel', 'stats', 'get-tool'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const runner = needRunner(sessionId);
        switch (action) {
          case 'register': {
            const toolName = getStringArg(args, 'toolName');
            const description = getOptionalStringArg(args, 'description') ?? `Mock delegated tool ${toolName}.`;
            const sensitive = getOptionalStringArg(args, 'sensitive') === 'true';
            runner.registerTool({
              name: toolName,
              description,
              sensitive,
              execute: (toolArgs) => JSON.stringify({ tool: toolName, args: toolArgs }),
            });
            return okResult({ registered: true, toolName });
          }
          case 'unregister': {
            const toolName = getStringArg(args, 'toolName');
            return okResult({ removed: runner.unregisterTool(toolName) });
          }
          case 'list-tools':
            return okResult(runner.listTools());
          case 'get-tool': {
            const toolName = getStringArg(args, 'toolName');
            const def = runner.getTool(toolName);
            return okResult(def ? { name: def.name, description: def.description, sensitive: def.sensitive } : { tool: null });
          }
          case 'delegate': {
            const toolName = getStringArg(args, 'toolName');
            const toolArgs = parseStringRecord(getOptionalStringArg(args, 'argsJson'), 'argsJson');
            const modeRaw = getOptionalStringArg(args, 'mode') ?? 'async';
            if (modeRaw !== 'async' && modeRaw !== 'sync') return errorResult(`Unknown mode: ${modeRaw}`);
            return okResult(runner.delegate(sessionId, toolName, toolArgs, atMs, { mode: modeRaw }));
          }
          case 'pump':
            return okResult(await runner.pump(atMs));
          case 'calls':
            return okResult(runner.list(sessionId));
          case 'pending':
            return okResult(runner.pending(sessionId));
          case 'get': {
            const callId = getStringArg(args, 'callId');
            const call = runner.list(sessionId).find((c) => c.id === callId) ?? null;
            return okResult(call ?? { call: null });
          }
          case 'cancel': {
            const callId = getStringArg(args, 'callId');
            return okResult({ cancelled: runner.cancel(callId, atMs) });
          }
          case 'stats':
            return okResult(runner.stats());
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const proactiveTool: Tool = {
    definition: toolDef(
      'voice_v29_proactive',
      'Proactive audio v29 (local): schedule a greeting, idle nudge, reminder, check-in or follow-up to be spoken when due — gated by opt-in consent, cooldowns and quiet hours, suppressed while the user or agent is speaking. Tick at virtual time, list triggers, cancel, or read stats. Nothing is ever played; this decides what to say and when.',
      {
        action: { type: 'string', description: 'schedule, tick, list, due, cancel, stats, enable, disable or events.' },
        sessionId: { type: 'string', description: 'Voice session id (proactive namespace).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        kind: { type: 'string', description: 'Trigger kind: greeting, idle-nudge, reminder, check-in or follow-up (schedule).' },
        text: { type: 'string', description: 'Text to speak (schedule).' },
        dueAtMs: { type: 'number', description: 'Virtual ms when the trigger is due (schedule).' },
        priority: { type: 'number', description: 'Trigger priority (schedule, optional).' },
        cooldownMs: { type: 'number', description: 'Cooldown after firing, ms (schedule, optional).' },
        repeat: { type: 'string', description: '"true" to repeat the trigger (schedule, optional).' },
        repeatMs: { type: 'number', description: 'Repeat interval ms (schedule, optional).' },
        triggerId: { type: 'string', description: 'Trigger id (cancel).' },
        userSpeaking: { type: 'string', description: '"true" when the user is speaking right now (tick, optional).' },
        agentSpeaking: { type: 'string', description: '"true" when the agent is speaking right now (tick, optional).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['schedule', 'tick', 'list', 'due', 'cancel', 'stats', 'enable', 'disable', 'events'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const proactive = needProactive(sessionId);
        switch (action) {
          case 'schedule': {
            const kind = assertProactiveKind(getStringArg(args, 'kind'));
            const text = getStringArg(args, 'text');
            const dueAtMs = getNumberArg(args, 'dueAtMs', atMs);
            const priority = getOptionalNumberArg(args, 'priority');
            const cooldownMs = getOptionalNumberArg(args, 'cooldownMs');
            const repeatMs = getOptionalNumberArg(args, 'repeatMs');
            return okResult(proactive.schedule(kind, text, dueAtMs, {
              ...(priority === undefined ? {} : { priority }),
              ...(cooldownMs === undefined ? {} : { cooldownMs }),
              repeat: getOptionalStringArg(args, 'repeat') === 'true',
              ...(repeatMs === undefined ? {} : { repeatMs }),
              createdAtMs: atMs,
            }));
          }
          case 'tick': {
            const result = proactive.tick(atMs, {
              userSpeaking: getOptionalStringArg(args, 'userSpeaking') === 'true',
              agentSpeaking: getOptionalStringArg(args, 'agentSpeaking') === 'true',
            });
            return okResult(result);
          }
          case 'list':
            return okResult(proactive.list());
          case 'due':
            return okResult(proactive.due(atMs));
          case 'cancel': {
            const triggerId = getStringArg(args, 'triggerId');
            return okResult({ cancelled: proactive.cancel(triggerId, atMs) });
          }
          case 'stats':
            return okResult(proactive.stats());
          case 'enable':
            proactive.setEnabled(true);
            return okResult({ enabled: true });
          case 'disable':
            proactive.setEnabled(false);
            return okResult({ enabled: false });
          case 'events':
            return okResult(proactive.eventsSoFar());
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const pipelineTool: Tool = {
    definition: toolDef(
      'voice_v29_pipeline',
      'Cascaded STT -> LLM -> TTS pipeline v29 (local, mock stages): run a cascaded turn or a direct speech-to-speech turn with a measured latency budget (cascaded target under 800ms, speech-to-speech around 300ms), record a turn with caller-measured stages, read budgets, recent turns, stats and the pipeline report. Stages are mock functions; the budget judgement is real.',
      {
        action: { type: 'string', description: 'run-cascaded, run-s2s, record-turn, budgets, set-budget, recent, stats, report, degraded or reset.' },
        sessionId: { type: 'string', description: 'Voice session id (pipeline namespace).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        input: { type: 'string', description: 'Input text (run-cascaded, run-s2s, record-turn).' },
        output: { type: 'string', description: 'Output text (record-turn).' },
        sttMs: { type: 'number', description: 'Mock STT stage duration ms (run-cascaded, record-turn, optional).' },
        llmMs: { type: 'number', description: 'Mock LLM stage duration ms (run-cascaded, record-turn, optional).' },
        ttsMs: { type: 'number', description: 'Mock TTS stage duration ms (run-cascaded, record-turn, optional).' },
        s2sMs: { type: 'number', description: 'Mock speech-to-speech stage duration ms (run-s2s, record-turn, optional).' },
        startedAtMs: { type: 'number', description: 'Turn start, virtual ms (record-turn).' },
        endedAtMs: { type: 'number', description: 'Turn end, virtual ms (record-turn).' },
        stage: { type: 'string', description: 'Stage to re-budget: stt, llm, tts or s2s-direct (set-budget).' },
        budgetMs: { type: 'number', description: 'New budget ms (set-budget).' },
        limit: { type: 'number', description: 'How many recent turns (recent, optional).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['run-cascaded', 'run-s2s', 'record-turn', 'budgets', 'set-budget', 'recent', 'stats', 'report', 'degraded', 'reset'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        if (action === 'budgets') {
          return okResult({
            cascadedTotalMs: VOICE_V29_CASCADED_BUDGET_TOTAL_MS,
            s2sTotalMs: VOICE_V29_S2S_BUDGET_TOTAL_MS,
            budgets: needPipeline(sessionId).getBudgets(),
          });
        }
        const pipeline = needPipeline(sessionId);
        switch (action) {
          case 'run-cascaded': {
            const input = getStringArg(args, 'input');
            const stages: Record<string, number> = {};
            const stt = getOptionalNumberArg(args, 'sttMs');
            const llm = getOptionalNumberArg(args, 'llmMs');
            const tts = getOptionalNumberArg(args, 'ttsMs');
            if (stt !== undefined) stages.stt = stt;
            if (llm !== undefined) stages.llm = llm;
            if (tts !== undefined) stages.tts = tts;
            return okResult(await pipeline.runCascaded(input, atMs, stages));
          }
          case 'run-s2s': {
            const input = getStringArg(args, 'input');
            const s2s = getOptionalNumberArg(args, 's2sMs') ?? 180;
            return okResult(await pipeline.runSpeechToSpeech(input, atMs, s2s));
          }
          case 'record-turn': {
            const input = getStringArg(args, 'input');
            const output = getStringArg(args, 'output');
            const startedAtMs = getNumberArg(args, 'startedAtMs', atMs);
            const endedAtMs = getNumberArg(args, 'endedAtMs', atMs);
            const stages: Record<string, number> = {};
            const stt = getOptionalNumberArg(args, 'sttMs');
            const llm = getOptionalNumberArg(args, 'llmMs');
            const tts = getOptionalNumberArg(args, 'ttsMs');
            const s2s = getOptionalNumberArg(args, 's2sMs');
            if (stt !== undefined) stages.stt = stt;
            if (llm !== undefined) stages.llm = llm;
            if (tts !== undefined) stages.tts = tts;
            if (s2s !== undefined) stages['s2s-direct'] = s2s;
            const mode: VoiceV29PipelineMode = s2s !== undefined ? 'speech-to-speech' : 'cascaded';
            return okResult(pipeline.recordTurn(mode, stages, startedAtMs, endedAtMs, input, output));
          }
          case 'set-budget': {
            const stage = getStringArg(args, 'stage');
            const allowed = ['stt', 'llm', 'tts', 's2s-direct'];
            if (!allowed.includes(stage)) return errorResult(`Unknown stage: ${stage}`);
            const budgetMs = getNumberArg(args, 'budgetMs', 0);
            pipeline.setBudget(stage as never, budgetMs);
            return okResult({ stage, budgetMs });
          }
          case 'recent': {
            const limit = getNumberArg(args, 'limit', 20);
            return okResult(pipeline.recentTurns(limit));
          }
          case 'stats':
            return okResult(pipeline.stats());
          case 'report':
            return okResult(pipeline.report());
          case 'degraded':
            return okResult({ degraded: pipeline.isDegraded() });
          case 'reset':
            pipeline.reset();
            return okResult({ reset: true });
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const costTool: Tool = {
    definition: toolDef(
      'voice_v29_cost',
      'Per-minute cost accounting v29 (local): rate table for the realtime models (gpt-realtime-2.1, gpt-live $0.05/min, gemini-3.8-live, livekit-agents-1.0, mock-cascaded), cost estimates, per-session meters, daily totals, cap/warning alerts, host rate overrides, or the whole report as Markdown. Rates are planning metadata only; no provider is billed.',
      {
        action: { type: 'string', description: 'rates, catalog, rate-for, estimate, cost-for-minutes, start, stop, tick, meter, meters, report, markdown, alerts or override-rate.' },
        sessionId: { type: 'string', description: 'Voice session id (meter namespace; shared ledger when omitted for rates/estimate/report).' },
        modelId: { type: 'string', description: 'Model id (rate-for, estimate, start, override-rate).' },
        minutes: { type: 'number', description: 'Minutes to price (estimate, cost-for-minutes).' },
        usdPerMinute: { type: 'number', description: 'Rate $/min (cost-for-minutes, override-rate).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        inputMs: { type: 'number', description: 'Input audio ms since last tick (tick).' },
        outputMs: { type: 'number', description: 'Output audio ms since last tick (tick).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['rates', 'catalog', 'rate-for', 'estimate', 'cost-for-minutes', 'start', 'stop', 'tick', 'meter', 'meters', 'report', 'markdown', 'alerts', 'override-rate'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        switch (action) {
          case 'rates':
            return okResult(sharedLedger.getRates());
          case 'catalog':
            return okResult(VOICE_V29_MODEL_CATALOG);
          case 'rate-for': {
            const modelId = getStringArg(args, 'modelId');
            const entry = rateForModelV29(sharedLedger.getRates(), modelId as VoiceV29ModelId);
            return okResult(entry ?? { rate: null, modelId });
          }
          case 'estimate': {
            const modelId = assertModelId(getStringArg(args, 'modelId'));
            const minutes = getNumberArg(args, 'minutes', 0);
            return okResult(sharedLedger.estimate(modelId, minutes, atMs));
          }
          case 'cost-for-minutes': {
            const minutes = getNumberArg(args, 'minutes', 0);
            const usdPerMinute = getNumberArg(args, 'usdPerMinute', 0);
            return okResult({ minutes, usdPerMinute, usd: costForMinutesV29(minutes, usdPerMinute) });
          }
          case 'override-rate': {
            const modelId = assertModelId(getStringArg(args, 'modelId'));
            const usdPerMinute = getNumberArg(args, 'usdPerMinute', 0);
            return okResult(sharedLedger.overrideRate(modelId, usdPerMinute));
          }
          case 'start': {
            const sessionId = getStringArg(args, 'sessionId');
            const modelId = assertModelId(getStringArg(args, 'modelId'));
            return okResult(sharedLedger.startSession(sessionId, modelId, atMs));
          }
          case 'stop': {
            const sessionId = getStringArg(args, 'sessionId');
            const meter = sharedLedger.stopSession(sessionId, atMs);
            return okResult(meter ?? { stopped: false, reason: 'unknown session' });
          }
          case 'tick': {
            const sessionId = getStringArg(args, 'sessionId');
            const inputMs = getNumberArg(args, 'inputMs', 0);
            const outputMs = getNumberArg(args, 'outputMs', 0);
            const entry = sharedLedger.tick(sessionId, inputMs, outputMs, atMs);
            return okResult(entry ?? { billed: false, reason: 'no meter for session' });
          }
          case 'meter': {
            const sessionId = getStringArg(args, 'sessionId');
            const meter = sharedLedger.getMeter(sessionId);
            return okResult(meter ?? { meter: null });
          }
          case 'meters':
            return okResult(sharedLedger.listMeters());
          case 'report':
            return okResult(sharedLedger.report());
          case 'markdown':
            return okResult({ markdown: sharedLedger.toMarkdown() });
          case 'alerts':
            return okResult(sharedLedger.alertsSoFar());
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [sessionTool, turnsTool, contextTool, delegateTool, proactiveTool, pipelineTool, costTool];
}

export const VOICE_V29_TOOLS: Tool[] = createVoiceV29Tools();

export const VOICE_V29_TOOL_NAMES = [
  'voice_v29_session',
  'voice_v29_turns',
  'voice_v29_context',
  'voice_v29_delegate',
  'voice_v29_proactive',
  'voice_v29_pipeline',
  'voice_v29_cost',
] as const;

export function isVoiceV29ToolName(name: string): name is (typeof VOICE_V29_TOOL_NAMES)[number] {
  return (VOICE_V29_TOOL_NAMES as readonly string[]).includes(name);
}

/** Model metadata for the v29 catalog (planning data only, no live calls). */
export function voiceV29ModelInfo(modelId: string) {
  return modelInfoV29(modelId);
}
