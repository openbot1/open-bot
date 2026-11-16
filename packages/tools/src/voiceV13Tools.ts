/**
 * Voice v13 tools for @open-bot/tools (v1.14, Đội T5).
 *
 * The agent drives the voice v13 sessions by tool call:
 *  - voice_v13_session_create  — create a v13 session (bot + language
 *    + voice + provider kind + wake-word gate + barge-in v13 policy
 *    + mock reply), optionally connected at once (local action)
 *  - voice_v13_session_list    — sessions + status + provider +
 *    wake-word state + clauses + smart turns (read)
 *  - voice_v13_session_stats   — full v13 stats (barge-in engine,
 *    clause TTS, Smart Turn, latency budget, wake word, provider) (read)
 *  - voice_v13_session_stop    — disconnect (keeps the session for inspection) (local action)
 *  - voice_v13_session_delete  — disconnect + drop the session (local action)
 *  - voice_v13_barge_in        — the last cut: played vs remaining text,
 *    scope cancelled, TTS flushed, resume strategy; optionally cut now
 *    (local action when cutting)
 *  - voice_v13_latency_budget  — latency budget dashboard (budget vs p50 /
 *    p95 / max per stage, overruns, worst stage); optionally set one
 *    stage's budget (local action when setting)
 *  - voice_v13_wake_word       — wake-word status + keywords + activations;
 *    optionally set keywords, wake now, or sleep (local action when acting)
 *
 * SAFETY: everything here is local — the default manager runs
 * mock sessions only (scripted replies, mock TTS, scripted
 * provider transcripts). Providers that need a key
 * (realtime-api) refuse until the user provides one; these
 * tools never read, log or store a key. A host that binds a
 * live provider to a session must do so explicitly; these tools
 * never dial a provider themselves.
 *
 * Factory:
 *   createVoiceV13Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V13_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  isVoiceProviderV13Kind,
  isBargeInV13Policy,
  type BargeInV13Policy,
  type VoiceProviderV13Kind,
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

/** What the tools need from one v13 session (the v13 session fits). */
export interface VoiceV13SessionLike {
  getStatus(): string;
  getSummary(): string;
  getStats(): unknown;
  connect(): Promise<void>;
  disconnect(): void;
  speakReply(text: string): boolean;
  interrupt(reason?: string): unknown;
  noteUserWord(word: string, atMs?: number, confidence?: number): void;
  resumeReply(strategy?: string): boolean;
  getLastInterrupt(): unknown;
  getClauses(): unknown;
  getLatencyReports(): unknown;
  getLastLatencyTurn(): unknown;
  getProvider(): { kind: string; name: string; isReady(): boolean; readinessReason(): string };
  setProvider(kind: string): { kind: string; name: string };
  getWakeWord(): {
    getState(): string;
    getKeywords(): string[];
    setKeywords(keywords: string[], atMs?: number): void;
    getStats(): unknown;
    getHistory(): unknown;
  };
  getBargeInEngine(): { getStats(): unknown };
  getSmartTurn(): { getStats(): unknown };
  setLatencyBudget(stage: string, ms: number): number;
  wakeNow(atMs?: number): unknown;
  sleepNow(atMs?: number): void;
  getPlayedTranscript(): string;
}

/** What the tools need from the session manager. */
export interface VoiceV13ManagerLike {
  create(options: {
    sessionId: string;
    botId?: string;
    language?: string;
    voice?: string;
    providerKind?: string;
    wakeWordEnabled?: boolean;
    wakeWordV13?: { keywords?: string[] };
    bargeInV13?: { policy?: string };
    mockReplies?: string[];
    connectNow?: boolean;
  }): VoiceV13SessionLike;
  get(sessionId: string): VoiceV13SessionLike | undefined;
  remove(sessionId: string): boolean;
  list(): VoiceV13SessionLike[];
  ids(): string[];
  size(): number;
}

export interface VoiceV13ToolOptions {
  /** Manager accessor (the host binds its VoiceV13Manager). */
  getManager?: () => VoiceV13ManagerLike | null;
}

const VOICE_PROVIDER_V13_KIND_NAMES: VoiceProviderV13Kind[] = ['mock', 'edge-tts', 'whisper-local', 'realtime-api'];
const BARGE_IN_V13_POLICIES: BargeInV13Policy[] = ['immediate', 'after-min-speech', 'confirm'];
const LATENCY_BUDGET_V13_STAGE_NAMES = ['capture', 'vad', 'stt', 'llm', 'tts', 'playback', 'e2e'] as const;

export function createVoiceV13Tools(opts: VoiceV13ToolOptions = {}): Tool[] {
  const needManager = (): VoiceV13ManagerLike => {
    const manager = opts.getManager?.() ?? null;
    if (!manager) {
      throw new Error(
        'voice v13 session manager is not available in this session (host must pass getManager to createVoiceV13Tools).',
      );
    }
    return manager;
  };

  const needSession = (manager: VoiceV13ManagerLike, sessionId: string): VoiceV13SessionLike => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v13 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v13_session_create',
      'Create a voice v13 realtime session (local action): mock session on the given bot, language, voice, provider kind (mock, edge-tts, whisper-local, realtime-api), wake-word gate and barge-in v13 policy. Pass connect=true to start listening at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default").' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "en").' },
        voice: { type: 'string', description: 'Voice id (default: the provider default).' },
        providerKind: { type: 'string', description: 'Provider kind: mock, edge-tts, whisper-local or realtime-api (default mock).' },
        wakeWordEnabled: { type: 'boolean', description: 'Enable the local wake-word gate (default false).' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Wake-word keywords (default ["hey bot"]).' },
        bargeInPolicy: { type: 'string', description: 'Barge-in v13 policy: immediate, after-min-speech or confirm (default immediate).' },
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
        if (providerKind !== undefined && !isVoiceProviderV13Kind(providerKind)) {
          throw new Error(`Unknown voice provider kind "${providerKind}" (want one of ${VOICE_PROVIDER_V13_KIND_NAMES.join(', ')}).`);
        }
        const wakeWordEnabled = getOptionalBooleanArg(args, 'wakeWordEnabled');
        const keywords = getStringListArg(args, 'keywords');
        const bargeInPolicy = getOptionalStringArg(args, 'bargeInPolicy');
        if (bargeInPolicy !== undefined && !isBargeInV13Policy(bargeInPolicy)) {
          throw new Error(`Unknown barge-in v13 policy "${bargeInPolicy}" (want one of ${BARGE_IN_V13_POLICIES.join(', ')}).`);
        }
        const mockReply = getOptionalStringArg(args, 'mockReply');
        const connectNow = getOptionalBooleanArg(args, 'connect') ?? false;
        const session = manager.create({
          sessionId,
          ...(botId !== undefined ? { botId } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(voice !== undefined ? { voice } : {}),
          ...(providerKind !== undefined ? { providerKind } : {}),
          ...(wakeWordEnabled !== undefined ? { wakeWordEnabled } : {}),
          ...(keywords !== undefined ? { wakeWordV13: { keywords } } : {}),
          ...(bargeInPolicy !== undefined ? { bargeInV13: { policy: bargeInPolicy } } : {}),
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
      'voice_v13_session_list',
      'List voice v13 sessions with status, provider, wake-word state, clause count and smart-turn counts (read).',
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
            providerKind: (stats['providerKind'] as string | undefined) ?? '',
            providerReady: stats['providerReady'],
            wakeWordState: ((stats['wakeWord'] as Record<string, unknown> | undefined)?.['state'] as string | undefined) ?? '',
            clauses: stats['clauses'],
            smartTurns: ((stats['smartTurn'] as Record<string, unknown> | undefined)?.['turns'] as number | undefined) ?? 0,
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
      'voice_v13_session_stats',
      'Full v13 stats for one session (read): barge-in engine, clause TTS, Smart Turn, latency budget, wake word, provider and the v12 layers underneath.',
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
          latencyReports: session.getLatencyReports(),
          lastLatencyTurn: session.getLastLatencyTurn(),
          playedTranscript: session.getPlayedTranscript(),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stop: Tool = {
    definition: toolDef(
      'voice_v13_session_stop',
      'Disconnect a voice v13 session (local action; the session is kept for inspection).',
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
      'voice_v13_session_delete',
      'Disconnect and drop a voice v13 session (local action).',
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
      'voice_v13_barge_in',
      'Barge-in v13 for one session (read, or local action when action=cut): the last cut (played vs remaining text, scope cancelled, TTS flushed, resume strategy) plus engine stats. action=cut interrupts the reply now.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Optional action: "cut" interrupts the reply now (default: read only).' },
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
          if (action !== 'cut') throw new Error(`Unknown barge-in v13 action "${action}" (want "cut").`);
          cut = session.interrupt('tool');
        }
        const stats = session.getStats() as Record<string, unknown>;
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          lastInterrupt: session.getLastInterrupt(),
          playedTranscript: session.getPlayedTranscript(),
          engine: session.getBargeInEngine().getStats(),
          bargeInV13: stats['bargeInV13'],
          ...(cut !== null ? { cut } : {}),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const latencyBudget: Tool = {
    definition: toolDef(
      'voice_v13_latency_budget',
      'Latency budget dashboard for one session (read, or local action when setting a budget): per-stage budget vs p50 / p95 / max, overruns and the worst stage. Pass stage + budgetMs to change one stage budget.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        stage: { type: 'string', description: 'Stage to re-budget: capture, vad, stt, llm, tts, playback or e2e (optional).' },
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
            throw new Error('Latency budget v13 needs both "stage" and "budgetMs" to change a budget.');
          }
          if (!(LATENCY_BUDGET_V13_STAGE_NAMES as readonly string[]).includes(stage)) {
            throw new Error(`Unknown latency stage "${stage}" (want one of ${LATENCY_BUDGET_V13_STAGE_NAMES.join(', ')}).`);
          }
          const newBudget = session.setLatencyBudget(stage, budgetMs);
          updated = { stage, budgetMs: newBudget };
        }
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          reports: session.getLatencyReports(),
          lastTurn: session.getLastLatencyTurn(),
          ...(updated !== null ? { updated } : {}),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const wakeWord: Tool = {
    definition: toolDef(
      'voice_v13_wake_word',
      'Wake word v13 for one session (read, or local action when acting): state, keywords and activations. action=set-keywords changes the keywords, action=wake wakes the session now, action=sleep puts it back to sleep.',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        action: { type: 'string', description: 'Optional action: "set-keywords", "wake" or "sleep" (default: read only).' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'New keywords for action=set-keywords.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const session = needSession(manager, getStringArg(args, 'sessionId'));
        const action = getOptionalStringArg(args, 'action');
        const detector = session.getWakeWord();
        let acted: unknown = null;
        if (action !== undefined) {
          if (action === 'set-keywords') {
            const keywords = getStringListArg(args, 'keywords');
            if (!keywords || keywords.length === 0) throw new Error('Wake word v13 set-keywords needs a non-empty "keywords" array.');
            detector.setKeywords(keywords);
            acted = { action, keywords };
          } else if (action === 'wake') {
            acted = { action, activation: session.wakeNow() };
          } else if (action === 'sleep') {
            session.sleepNow();
            acted = { action };
          } else {
            throw new Error(`Unknown wake word v13 action "${action}" (want "set-keywords", "wake" or "sleep").`);
          }
        }
        return JSON.stringify({
          sessionId: getStringArg(args, 'sessionId'),
          state: detector.getState(),
          keywords: detector.getKeywords(),
          stats: detector.getStats(),
          history: detector.getHistory(),
          ...(acted !== null ? { acted } : {}),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, sessionStats, stop, remove, bargeIn, latencyBudget, wakeWord];
}

/** Unbound placeholder (the host binds a manager via createVoiceV13Tools). */
export const VOICE_V13_TOOLS: Tool[] = createVoiceV13Tools();

export const VOICE_V13_TOOL_NAMES = [
  'voice_v13_session_create',
  'voice_v13_session_list',
  'voice_v13_session_stats',
  'voice_v13_session_stop',
  'voice_v13_session_delete',
  'voice_v13_barge_in',
  'voice_v13_latency_budget',
  'voice_v13_wake_word',
] as const;

export function isVoiceV13ToolName(name: string): name is (typeof VOICE_V13_TOOL_NAMES)[number] {
  return (VOICE_V13_TOOL_NAMES as readonly string[]).includes(name);
}
