/**
 * Voice v14 tools for @open-bot/tools (v1.15, Đội T5).
 *
 * The agent drives the voice v14 sessions by tool call:
 *  - voice_v14_session_create  — create a v14 session (bot + language
 *    + voice + v14 provider kind + latency profile + Smart Turn v2
 *    sensitivity + wake-word v2 gate + barge-in v2 policy + mock
 *    reply), optionally connected at once (local action)
 *  - voice_v14_session_list    — sessions + status + v14 provider +
 *    wake-word v2 state + pipeline + latency compliance (read)
 *  - voice_v14_session_stats   — full v14 stats (barge-in v2 engine
 *    + pipeline, Smart Turn v2, latency budget v2, wake word v2,
 *    provider v2) (read)
 *  - voice_v14_session_stop    — disconnect (keeps the session for inspection) (local action)
 *  - voice_v14_session_delete  — disconnect + drop the session (local action)
 *  - voice_v14_barge_in        — the last v14 cut: pipeline discards,
 *    cut latency, mid-sentence split; optionally cut now or cut
 *    mid-sentence at a played char count (local action when cutting)
 *  - voice_v14_latency_budget  — latency budget v2 for one session
 *    (per-stage p50 / p95 / p99, network stage, compliance rate,
 *    warn/critical alerts); optionally set one stage's budget
 *    (local action when setting)
 *  - voice_v14_wake_word       — wake-word v2 status + per-word configs
 *    + activations + suppressed false positives; optionally set
 *    words, wake now, sleep, or evaluate a labelled test set
 *    (local action when acting)
 *  - voice_v14_provider        — provider v2 registry (Deepgram /
 *    Cartesia / Whisper local / Pocket TTS / mock / realtime-api)
 *    with pick-by-goal scores; optionally pick + switch the
 *    session's provider (local action when switching)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only (scripted replies, mock TTS, scripted
 * provider transcripts). Providers that need a key (Deepgram,
 * Cartesia, realtime-api) refuse until the user provides one;
 * these tools never read, log or store a key. A host that binds
 * a live provider to a session must do so explicitly; these
 * tools never dial a provider themselves.
 *
 * Factory:
 *   createVoiceV14Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V14_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  isVoiceProviderV14Kind,
  isBargeInV13Policy,
  isSmartTurnV14Sensitivity,
  isLatencyBudgetV14Profile,
  evaluateWakeWordV14,
  type BargeInV13Policy,
  type VoiceProviderV14Kind,
  type SmartTurnV14Sensitivity,
  type LatencyBudgetV14Profile,
  type WakeWordV14TestSample,
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

function getStringListArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
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

/** What the tools need from one v14 session (the v14 session fits). */
export interface VoiceV14SessionLike {
  getStatus(): string;
  getSummary(): string;
  getStats(): unknown;
  connect(): Promise<void>;
  disconnect(): void;
  speakReply(text: string): boolean;
  interrupt(reason?: string): unknown;
  cutMidSentence(playedChars: number, atMs?: number): unknown;
  noteUserWord(word: string, atMs?: number, confidence?: number): void;
  resumeReply(strategy?: string): boolean;
  getLastInterrupt(): unknown;
  getLastCutV14(): unknown;
  getClauses(): unknown;
  getLatencyReportsV14(): unknown;
  getSessionLatencyReport(): unknown;
  getLatencyAlertsV14(): unknown;
  getLatencyProfile(): string;
  setLatencyBudgetV14(stage: string, ms: number): number;
  setProviderV14(kind: string): { kind: string; name: string };
  pickProviderV14(goal?: string, capability?: string): { kind: string; name: string } | null;
  pickProviderPairV14(goal?: string): { stt: { kind: string; name: string } | null; tts: { kind: string; name: string } | null };
  getProviderRegistryV14(): { list(): { kind: string; name: string; capabilities: unknown; profile: unknown; isReady(): boolean; readinessReason(): string }[] };
  getWakeWordV14(): {
    getState(): string;
    getKeywords(): string[];
    getWords(): { keyword: string; minConfidence: number; cooldownMs: number; requireVadConfirm: boolean; confirmWindowMs: number }[];
    setWords(words: { keyword: string }[], atMs?: number): void;
    getStats(): unknown;
    getHistory(): unknown;
    getSuppressed(): unknown;
  };
  getSmartTurnV14(): { getStats(): unknown };
  getBargeInEngineV14(): { getStats(): unknown };
  wakeNowV14(atMs?: number): unknown;
  sleepNowV14(atMs?: number): void;
  getPlayedTranscript(): string;
}

/** What the tools need from the session manager. */
export interface VoiceV14ManagerLike {
  create(options: {
    sessionId: string;
    botId?: string;
    language?: string;
    voice?: string;
    providerKindV14?: string;
    wakeWordV14Enabled?: boolean;
    wakeWordV14?: { words?: { keyword: string }[] };
    latencyBudgetV14?: { profile?: string };
    smartTurnV14?: { sensitivity?: string };
    bargeInV14?: { policy?: string };
    mockReplies?: string[];
    connectNow?: boolean;
  }): VoiceV14SessionLike;
  get(sessionId: string): VoiceV14SessionLike | undefined;
  remove(sessionId: string): boolean;
  list(): VoiceV14SessionLike[];
  ids(): string[];
  size(): number;
}

export interface VoiceV14ToolOptions {
  /** Manager accessor (the host binds its VoiceV14Manager). */
  getManager?: () => VoiceV14ManagerLike | null;
}

const VOICE_PROVIDER_V14_KIND_NAMES: VoiceProviderV14Kind[] = ['mock', 'deepgram', 'cartesia', 'whisper-local-v14', 'pocket-tts', 'realtime-api'];
const BARGE_IN_V14_POLICIES: BargeInV13Policy[] = ['immediate', 'after-min-speech', 'confirm'];
const LATENCY_BUDGET_V14_STAGE_NAMES = ['capture', 'vad', 'stt', 'llm', 'tts', 'playback', 'network', 'e2e'] as const;
const LATENCY_BUDGET_V14_PROFILE_NAMES: LatencyBudgetV14Profile[] = ['local', 'cloud', 'realtime', 'custom'];
const SMART_TURN_V14_SENSITIVITIES: SmartTurnV14Sensitivity[] = ['low', 'balanced', 'high'];
const PROVIDER_PICK_GOALS = ['latency', 'quality', 'cost', 'balanced'] as const;

export function createVoiceV14Tools(opts: VoiceV14ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV14ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v14 session manager is not available in this session (host must pass getManager to createVoiceV14Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV14ManagerLike, sessionId: string): VoiceV14SessionLike => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v14 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v14_session_create',
      'Create a voice v14 realtime session (local action): mock session on the given bot, language, voice, v14 provider kind (mock, deepgram, cartesia, whisper-local-v14, pocket-tts, realtime-api), latency profile (local, cloud, realtime, custom), Smart Turn v2 sensitivity (low, balanced, high), wake-word v2 gate and barge-in v2 policy. Pass connect=true to start listening at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default").' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "en").' },
        voice: { type: 'string', description: 'Voice id (default: the provider default).' },
        providerKind: { type: 'string', description: 'Provider kind: mock, deepgram, cartesia, whisper-local-v14, pocket-tts or realtime-api (default mock).' },
        latencyProfile: { type: 'string', description: 'Latency budget profile: local, cloud, realtime or custom (default cloud).' },
        sensitivity: { type: 'string', description: 'Smart Turn v2 sensitivity: low, balanced or high (default balanced).' },
        wakeWordEnabled: { type: 'boolean', description: 'Enable the local wake-word v2 gate (default false).' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Wake-word keywords (default ["hey bot"]).' },
        bargeInPolicy: { type: 'string', description: 'Barge-in v2 policy: immediate, after-min-speech or confirm (default immediate).' },
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
        const providerKind = getOptionalStringArg(args, 'providerKind');
        if (providerKind !== undefined && !isVoiceProviderV14Kind(providerKind)) {
          throw new Error(`Unknown voice provider kind "${providerKind}" (want one of ${VOICE_PROVIDER_V14_KIND_NAMES.join(', ')}).`);
        }
        const latencyProfile = getOptionalStringArg(args, 'latencyProfile');
        if (latencyProfile !== undefined && !isLatencyBudgetV14Profile(latencyProfile)) {
          throw new Error(`Unknown latency profile "${latencyProfile}" (want one of ${LATENCY_BUDGET_V14_PROFILE_NAMES.join(', ')}).`);
        }
        const sensitivity = getOptionalStringArg(args, 'sensitivity');
        if (sensitivity !== undefined && !isSmartTurnV14Sensitivity(sensitivity)) {
          throw new Error(`Unknown Smart Turn v2 sensitivity "${sensitivity}" (want one of ${SMART_TURN_V14_SENSITIVITIES.join(', ')}).`);
        }
        const wakeWordEnabled = getOptionalBooleanArg(args, 'wakeWordEnabled');
        const keywords = getStringListArg(args, 'keywords');
        const bargeInPolicy = getOptionalStringArg(args, 'bargeInPolicy');
        if (bargeInPolicy !== undefined && !isBargeInV13Policy(bargeInPolicy)) {
          throw new Error(`Unknown barge-in v2 policy "${bargeInPolicy}" (want one of ${BARGE_IN_V14_POLICIES.join(', ')}).`);
        }
        const mockReply = getOptionalStringArg(args, 'mockReply');
        const connectNow = getOptionalBooleanArg(args, 'connect') ?? false;
        const session = manager.create({
          sessionId,
          ...(botId !== undefined ? { botId } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(voice !== undefined ? { voice } : {}),
          ...(providerKind !== undefined ? { providerKindV14: providerKind } : {}),
          ...(latencyProfile !== undefined ? { latencyBudgetV14: { profile: latencyProfile } } : {}),
          ...(sensitivity !== undefined ? { smartTurnV14: { sensitivity } } : {}),
          ...(wakeWordEnabled !== undefined ? { wakeWordV14Enabled: wakeWordEnabled } : {}),
          ...(keywords !== undefined ? { wakeWordV14: { words: keywords.map((keyword) => ({ keyword })) } } : {}),
          ...(bargeInPolicy !== undefined ? { bargeInV14: { policy: bargeInPolicy } } : {}),
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
      'voice_v14_session_list',
      'List voice v14 sessions with status, v14 provider, wake-word v2 state, pipeline discards, cut latency and latency compliance (read).',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const manager = needManager();
        const rows = manager.list().map((session) => {
          const stats = session.getStats() as Record<string, unknown>;
          return {
            sessionId: (stats['sessionId'] as string | undefined) ?? '',
            status: session.getStatus(),
            summary: session.getSummary(),
            providerKind: stats['providerKindV14'],
            providerReady: stats['providerReadyV14'],
            wakeWordState: ((stats['wakeWordV14'] as Record<string, unknown> | undefined)?.['state'] as string | undefined) ?? '',
            wakeSuppressed: ((stats['wakeWordV14'] as Record<string, unknown> | undefined)?.['suppressed'] as number | undefined) ?? 0,
            pipelineDiscarded: ((stats['bargeInV14'] as Record<string, unknown> | undefined)?.['pipeline'] as Record<string, unknown> | undefined)?.['cutDiscarded'],
            meanCutLatencyMs: ((stats['bargeInV14'] as Record<string, unknown> | undefined)?.['pipeline'] as Record<string, unknown> | undefined)?.['meanCutLatencyMs'],
            smartTurnsV14: ((stats['smartTurnV14'] as Record<string, unknown> | undefined)?.['turns'] as number | undefined) ?? 0,
            latencyAlerts: ((stats['latencyBudgetV14'] as Record<string, unknown> | undefined)?.['alerts'] as number | undefined) ?? 0,
          };
        });
        return JSON.stringify({ sessions: rows, count: rows.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sessionStats: Tool = {
    definition: toolDef(
      'voice_v14_session_stats',
      'Full v14 stats for one session (read): barge-in v2 engine + pipeline, Smart Turn v2, latency budget v2, wake word v2, provider v2 and the v13 layers underneath.',
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
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          status: session.getStatus(),
          summary: session.getSummary(),
          stats: session.getStats(),
          clauses: session.getClauses(),
          latencyReportsV14: session.getLatencyReportsV14(),
          sessionLatencyReport: session.getSessionLatencyReport(),
          latencyAlertsV14: session.getLatencyAlertsV14(),
          playedTranscript: session.getPlayedTranscript(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stop: Tool = {
    definition: toolDef(
      'voice_v14_session_stop',
      'Disconnect a voice v14 session (local action; the session is kept for inspection).',
      {
        sessionId: { type: 'string', description: 'Id of the session to stop.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        session.disconnect();
        return JSON.stringify({ stopped: true, sessionId: getStringArg(args, 'sessionId') }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const remove: Tool = {
    definition: toolDef(
      'voice_v14_session_delete',
      'Disconnect and drop a voice v14 session (local action).',
      {
        sessionId: { type: 'string', description: 'Id of the session to delete.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const deleted = manager.remove(sessionId);
        return JSON.stringify({ deleted, sessionId }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const bargeIn: Tool = {
    definition: toolDef(
      'voice_v14_barge_in',
      'Barge-in v2 for one session (read, or local action when action=cut or action=cut-mid-sentence): the last cut (pipeline discards, cut latency, mid-sentence split, played vs remaining text) plus engine + pipeline stats. action=cut interrupts the reply now; action=cut-mid-sentence needs playedChars.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Optional action: "cut" or "cut-mid-sentence" (default: read only).' },
        playedChars: { type: 'number', description: 'Chars played for action=cut-mid-sentence.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const action = getOptionalStringArg(args, 'action');
        let cut: unknown = null;
        if (action !== undefined) {
          if (action === 'cut') {
            cut = session.interrupt('tool');
          } else if (action === 'cut-mid-sentence') {
            const playedChars = getOptionalNumberArg(args, 'playedChars');
            if (playedChars === undefined) throw new Error('Barge-in v14 cut-mid-sentence needs "playedChars".');
            cut = session.cutMidSentence(playedChars);
          } else {
            throw new Error(`Unknown barge-in v14 action "${action}" (want "cut" or "cut-mid-sentence").`);
          }
        }
        const stats = session.getStats() as Record<string, unknown>;
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          lastInterrupt: session.getLastInterrupt(),
          lastCutV14: session.getLastCutV14(),
          playedTranscript: session.getPlayedTranscript(),
          engine: session.getBargeInEngineV14().getStats(),
          bargeInV14: stats['bargeInV14'],
          ...(cut !== null ? { cut } : {}),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const latencyBudget: Tool = {
    definition: toolDef(
      'voice_v14_latency_budget',
      'Latency budget v2 for one session (read, or local action when setting a budget): per-stage budget vs p50 / p95 / p99, network stage, compliance rate, warn/critical alerts and the worst stage. Pass stage + budgetMs to change one stage budget.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        stage: { type: 'string', description: 'Stage to re-budget: capture, vad, stt, llm, tts, playback, network or e2e (optional).' },
        budgetMs: { type: 'number', description: 'New budget for the stage, in ms (optional, needs stage).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const stage = getOptionalStringArg(args, 'stage');
        const budgetMs = getOptionalNumberArg(args, 'budgetMs');
        let updated: unknown = null;
        if (stage !== undefined || budgetMs !== undefined) {
          if (stage === undefined || budgetMs === undefined) {
            throw new Error('Latency budget v14 needs both "stage" and "budgetMs" to change a budget.');
          }
          if (!(LATENCY_BUDGET_V14_STAGE_NAMES as readonly string[]).includes(stage)) {
            throw new Error(`Unknown latency stage "${stage}" (want one of ${LATENCY_BUDGET_V14_STAGE_NAMES.join(', ')}).`);
          }
          const newBudget = session.setLatencyBudgetV14(stage, budgetMs);
          updated = { stage, budgetMs: newBudget };
        }
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          profile: session.getLatencyProfile(),
          reports: session.getLatencyReportsV14(),
          sessionReport: session.getSessionLatencyReport(),
          alerts: session.getLatencyAlertsV14(),
          ...(updated !== null ? { updated } : {}),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const wakeWord: Tool = {
    definition: toolDef(
      'voice_v14_wake_word',
      'Wake word v2 for one session (read, or local action when acting): state, per-word configs, activations and suppressed false positives. action=set-words changes the words, action=wake wakes the session now, action=sleep puts it back to sleep, action=evaluate runs a labelled test set (pass samples: [{transcript, expectedKeyword|null, vadSpeechMs?, atMs}]) and reports TP/FP/FN/TN + false-accept/false-reject rates.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Optional action: "set-words", "wake", "sleep" or "evaluate" (default: read only).' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'New keywords for action=set-words.' },
        samples: { type: 'array', items: { type: 'object' }, description: 'Labelled test samples for action=evaluate.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const action = getOptionalStringArg(args, 'action');
        const detector = session.getWakeWordV14();
        let acted: unknown = null;
        if (action !== undefined) {
          if (action === 'set-words') {
            const keywords = getStringListArg(args, 'keywords');
            if (!keywords || keywords.length === 0) throw new Error('Wake word v14 set-words needs a non-empty "keywords" array.');
            detector.setWords(keywords.map((keyword) => ({ keyword })));
            acted = { action, keywords };
          } else if (action === 'wake') {
            acted = { action, activation: session.wakeNowV14() };
          } else if (action === 'sleep') {
            session.sleepNowV14();
            acted = { action };
          } else if (action === 'evaluate') {
            const raw = args['samples'];
            if (!Array.isArray(raw) || raw.length === 0) {
              throw new Error('Wake word v14 evaluate needs a non-empty "samples" array.');
            }
            const samples: WakeWordV14TestSample[] = raw.map((s, i) => {
              if (typeof s !== 'object' || s === null) throw new Error(`Wake word v14 sample ${i} must be an object.`);
              const rec = s as Record<string, unknown>;
              if (typeof rec['transcript'] !== 'string') throw new Error(`Wake word v14 sample ${i} needs a string "transcript".`);
              if (!(rec['expectedKeyword'] === null || typeof rec['expectedKeyword'] === 'string')) {
                throw new Error(`Wake word v14 sample ${i} needs "expectedKeyword" as a string or null.`);
              }
              return {
                transcript: rec['transcript'] as string,
                expectedKeyword: rec['expectedKeyword'] as string | null,
                ...(typeof rec['vadSpeechMs'] === 'number' ? { vadSpeechMs: rec['vadSpeechMs'] } : {}),
                atMs: typeof rec['atMs'] === 'number' ? rec['atMs'] : i * 1000,
              };
            });
            const words = detector.getWords().map((w) => ({ keyword: w.keyword }));
            acted = { action, evaluation: evaluateWakeWordV14({ words }, samples) };
          } else {
            throw new Error(`Unknown wake word v14 action "${action}" (want "set-words", "wake", "sleep" or "evaluate").`);
          }
        }
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          state: detector.getState(),
          keywords: detector.getKeywords(),
          words: detector.getWords(),
          stats: detector.getStats(),
          history: detector.getHistory(),
          suppressed: detector.getSuppressed(),
          ...(acted !== null ? { acted } : {}),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const provider: Tool = {
    definition: toolDef(
      'voice_v14_provider',
      'Voice provider v2 registry (read, or local action when action=pick or action=set): Deepgram / Cartesia / Whisper local / Pocket TTS / mock / realtime-api with STT/TTS capabilities, first-audio timing and pick-by-goal scores. action=pick returns the best ready provider for a goal (latency, quality, cost, balanced) + capability; action=set switches the session to a provider kind.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Optional action: "pick" or "set" (default: read only).' },
        goal: { type: 'string', description: 'Pick goal for action=pick: latency, quality, cost or balanced (default balanced).' },
        capability: { type: 'string', description: 'Capability filter for action=pick: stt, tts or realtime (optional).' },
        kind: { type: 'string', description: 'Provider kind for action=set.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const action = getOptionalStringArg(args, 'action');
        let acted: unknown = null;
        if (action !== undefined) {
          if (action === 'pick') {
            const goal = getOptionalStringArg(args, 'goal') ?? 'balanced';
            if (!(PROVIDER_PICK_GOALS as readonly string[]).includes(goal)) {
              throw new Error(`Unknown provider pick goal "${goal}" (want one of ${PROVIDER_PICK_GOALS.join(', ')}).`);
            }
            const capability = getOptionalStringArg(args, 'capability');
            if (capability !== undefined && !['stt', 'tts', 'realtime'].includes(capability)) {
              throw new Error(`Unknown provider capability "${capability}" (want stt, tts or realtime).`);
            }
            const picked = session.pickProviderV14(goal as 'latency' | 'quality' | 'cost' | 'balanced', capability as 'stt' | 'tts' | 'realtime' | undefined);
            const pair = session.pickProviderPairV14(goal as 'latency' | 'quality' | 'cost' | 'balanced');
            acted = { action, goal, capability: capability ?? null, picked: picked ? { kind: picked.kind, name: picked.name } : null, pair: { stt: pair.stt?.kind ?? null, tts: pair.tts?.kind ?? null } };
          } else if (action === 'set') {
            const kind = getStringArg(args, 'kind');
            if (!isVoiceProviderV14Kind(kind)) {
              throw new Error(`Unknown voice provider kind "${kind}" (want one of ${VOICE_PROVIDER_V14_KIND_NAMES.join(', ')}).`);
            }
            const provider = session.setProviderV14(kind);
            acted = { action, kind: provider.kind, name: provider.name };
          } else {
            throw new Error(`Unknown provider v14 action "${action}" (want "pick" or "set").`);
          }
        }
        const registry = session.getProviderRegistryV14();
        const providers = registry.list().map((p) => ({
          kind: p.kind,
          name: p.name,
          capabilities: p.capabilities,
          profile: p.profile,
          ready: p.isReady(),
          reason: p.readinessReason(),
        }));
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          providers,
          ...(acted !== null ? { acted } : {}),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, bargeIn, latencyBudget, wakeWord, provider];
}

/** Unbound placeholder (the host binds a manager via createVoiceV14Tools). */
export const VOICE_V14_TOOLS: Tool[] = createVoiceV14Tools();

export const VOICE_V14_TOOL_NAMES = [
  'voice_v14_session_create',
  'voice_v14_session_list',
  'voice_v14_session_stats',
  'voice_v14_session_stop',
  'voice_v14_session_delete',
  'voice_v14_barge_in',
  'voice_v14_latency_budget',
  'voice_v14_wake_word',
  'voice_v14_provider',
] as const;

export function isVoiceV14ToolName(name: string): name is (typeof VOICE_V14_TOOL_NAMES)[number] {
  return (VOICE_V14_TOOL_NAMES as readonly string[]).includes(name);
}
