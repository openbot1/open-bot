/**
 * Voice v19 tools for @open-bot/tools (v1.27, Đội T5).
 *
 * The agent drives the voice v19 layers by tool call:
 *  - voice_v19_session_create   — create a v19 session (bot + user +
 *    language + voice context + scripted mock reply), optionally
 *    connected at once (local action)
 *  - voice_v19_session_list     — UI snapshots of every session the
 *    manager knows: state, connection, age, idle time, time to
 *    expiry, turns, barge-ins, checkpoints (read)
 *  - voice_v19_session_snapshot — one session: UI snapshot + full
 *    v18 stats + manager record (read)
 *  - voice_v19_session_close    — disconnect, keep the record for
 *    inspection (local action)
 *  - voice_v19_session_delete   — disconnect + drop session + record
 *    (local action)
 *  - voice_v19_session_sweep    — fast-forward the virtual clock,
 *    then expire sessions past the duration/idle limits (local action)
 *  - voice_v19_session_restore  — rebuild a session from an exported
 *    snapshot JSON (re-applies the v18 resume token) (local action)
 *  - voice_v19_prosody          — prosody control: get / set emotion
 *    / set context / set or clear override / plan an utterance /
 *    render SSML (local action when writing)
 *  - voice_v19_eval             — run the voice eval v19 (default
 *    scripted scenarios) or compare a run against a baseline
 *    report and flag regressions (local action)
 *  - voice_v19_turn_save        — append a partial transcript segment
 *    to an open turn, or set the turn's reply + spoken chars (local action)
 *  - voice_v19_turn_interrupt   — mark a turn interrupted (network-lost
 *    / crash / barge-in / timeout), snapshot the partial transcript
 *    (local action)
 *  - voice_v19_turn_resume      — request / confirm / decline /
 *    complete a resume: the user picks resume / restart / summarise
 *    / drop (local action)
 *  - voice_v19_turn_list        — open turns + store stats (read)
 *
 * SAFETY: everything here is local — the default manager runs mock
 * sessions only (scripted replies, mock TTS, synthetic PCM frames),
 * prosody is computed from text, eval scores are mock numbers, and
 * turn resume never continues a turn without the user's explicit
 * confirmation. No provider is dialled, no key is read or stored,
 * no mic or sound card is touched.
 *
 * Factory:
 *   createVoiceV19Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V19_TOOLS                       (unbound placeholder, own
 *   default manager — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  VoiceSessionManagerV19,
  ProsodyControllerV19,
  OpenTurnStoreV19,
  VoiceEvalV19,
  compareWithBaselineV19,
  voiceEvalV19Summary,
  isProsodyV19Emotion,
  isTurnResumeV19InterruptReason,
  isTurnResumeV19Action,
  isVoiceProfileV17Context,
  isVoiceSessionV19CloseReason,
  type ProsodyV19Emotion,
  type TurnResumeV19InterruptReason,
  type TurnResumeV19Action,
  type VoiceProfileV17Context,
  type VoiceSessionV19CloseReason,
  type VoiceSessionV19Options,
  type VoiceEvalV19Report,
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

export interface VoiceV19ToolOptions {
  /** Manager accessor (the host binds its VoiceSessionManagerV19). */
  getManager?: () => VoiceSessionManagerV19 | null;
  /** Prosody controller accessor (the host binds its ProsodyControllerV19). */
  getProsody?: () => ProsodyControllerV19 | null;
  /** Open-turn store accessor (the host binds its OpenTurnStoreV19). */
  getTurnStore?: () => OpenTurnStoreV19 | null;
  /** Options for the default manager (used when no getManager is bound). */
  sessionOptions?: VoiceSessionV19Options;
}

const VOICE_CONTEXTS = ['chat', 'announcement', 'alert', 'narration', 'whisper'] as const;
const EMOTIONS = ['neutral', 'happy', 'calm', 'urgent', 'empathetic', 'formal', 'excited', 'apologetic'] as const;
const CLOSE_REASONS = ['client-close', 'deleted', 'max-duration', 'idle-timeout', 'replaced', 'error'] as const;
const INTERRUPT_REASONS = ['network-lost', 'crash', 'barge-in', 'timeout'] as const;
const RESUME_ACTIONS = ['resume', 'restart', 'summarise', 'drop'] as const;
const PROSODY_ACTIONS = ['get', 'set-emotion', 'set-context', 'set-override', 'clear-override', 'plan', 'ssml'] as const;
const EVAL_ACTIONS = ['run', 'compare'] as const;
const TURN_RESUME_ACTIONS = ['request', 'confirm', 'decline', 'complete'] as const;

export function createVoiceV19Tools(opts: VoiceV19ToolOptions = {}): Tool[] {
  const defaultManager = new VoiceSessionManagerV19(opts.sessionOptions);
  const defaultProsody = new ProsodyControllerV19();
  const defaultTurnStore = new OpenTurnStoreV19();
  const needManager = (): VoiceSessionManagerV19 => opts.getManager?.() ?? defaultManager;
  const needProsody = (): ProsodyControllerV19 => opts.getProsody?.() ?? defaultProsody;
  const needTurnStore = (): OpenTurnStoreV19 => opts.getTurnStore?.() ?? defaultTurnStore;

  const needSession = (manager: VoiceSessionManagerV19, sessionId: string) => {
    const session = manager.get(sessionId);
    if (!session) throw new Error(`Unknown voice v19 session "${sessionId}".`);
    return session;
  };

  const create: Tool = {
    definition: toolDef(
      'voice_v19_session_create',
      'Create a voice v19 session (local action): mock realtime session on the given bot, user, language and voice context, with a scripted mock reply. The manager enforces duration limits (maxSessionMs / maxIdleMs) and reaps expired sessions on sweep. Pass connect=true to start at once; otherwise the session starts idle.',
      {
        sessionId: { type: 'string', description: 'Id of the session to create.' },
        botId: { type: 'string', description: 'Bot id the session belongs to (default "default-bot").' },
        userId: { type: 'string', description: 'User id the session belongs to (optional).' },
        language: { type: 'string', description: 'Language code, e.g. "vi" or "en" (default "vi").' },
        voiceContext: { type: 'string', description: 'Voice context: chat, announcement, alert, narration or whisper (default chat).' },
        mockReply: { type: 'string', description: 'Scripted mock reply for this session (optional).' },
        connect: { type: 'boolean', description: 'Connect (start) at once (default false).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const botId = getOptionalStringArg(args, 'botId');
        const userId = getOptionalStringArg(args, 'userId');
        const language = getOptionalStringArg(args, 'language');
        const voiceContext = getOptionalStringArg(args, 'voiceContext');
        if (voiceContext !== undefined && !isVoiceProfileV17Context(voiceContext)) {
          throw new Error(`Unknown voice context "${voiceContext}" (want one of ${VOICE_CONTEXTS.join(', ')}).`);
        }
        manager.create(sessionId, {
          ...(botId !== undefined ? { botId } : {}),
          ...(userId !== undefined ? { userId } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(voiceContext !== undefined ? { voiceContext: voiceContext as VoiceProfileV17Context } : {}),
          ...(getOptionalStringArg(args, 'mockReply') !== undefined
            ? { replyFor: () => getOptionalStringArg(args, 'mockReply') as string }
            : {}),
        });
        if (getOptionalBooleanArg(args, 'connect') ?? false) await manager.connect(sessionId);
        const snapshot = manager.uiSnapshot(sessionId);
        return JSON.stringify({ created: true, sessionId, snapshot }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const list: Tool = {
    definition: toolDef(
      'voice_v19_session_list',
      'List voice v19 sessions (read): UI snapshots — state, connection, age, idle time, time to expiry, turns, barge-ins, checkpoints — plus manager stats.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const manager = needManager();
        return JSON.stringify({ sessions: manager.uiSnapshots(), stats: manager.stats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const snapshot: Tool = {
    definition: toolDef(
      'voice_v19_session_snapshot',
      'One voice v19 session in full (read): UI snapshot, manager record and the underlying v18 session stats.',
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
        const snap = manager.uiSnapshot(sessionId);
        if (!snap) throw new Error(`Unknown voice v19 session "${sessionId}".`);
        return JSON.stringify(
          { snapshot: snap, record: manager.record(sessionId), stats: session.stats() },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const close: Tool = {
    definition: toolDef(
      'voice_v19_session_close',
      'Close a voice v19 session (local action): disconnect, keep the record for inspection. Reason: client-close, deleted, max-duration, idle-timeout, replaced or error (default client-close).',
      {
        sessionId: { type: 'string', description: 'Id of the session.' },
        reason: { type: 'string', description: 'Why the session closes (default client-close).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const sessionId = getStringArg(args, 'sessionId');
        const reason = getOptionalStringArg(args, 'reason');
        if (reason !== undefined && !isVoiceSessionV19CloseReason(reason)) {
          throw new Error(`Unknown close reason "${reason}" (want one of ${CLOSE_REASONS.join(', ')}).`);
        }
        const closed = manager.close(sessionId, (reason ?? 'client-close') as VoiceSessionV19CloseReason);
        return JSON.stringify({ closed, sessionId, snapshot: manager.uiSnapshot(sessionId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const remove: Tool = {
    definition: toolDef(
      'voice_v19_session_delete',
      'Delete a voice v19 session (local action): disconnect and drop the session and its record entirely.',
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
        return JSON.stringify({ deleted: manager.delete(sessionId), sessionId }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sweep: Tool = {
    definition: toolDef(
      'voice_v19_session_sweep',
      'Sweep voice v19 sessions (local action): optionally fast-forward the virtual clock by advanceMs, then expire every live session past the duration or idle limit. Returns what was reaped and why.',
      {
        advanceMs: { type: 'number', description: 'Virtual ms to advance the manager clock before sweeping (default 0).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const advanceMs = getOptionalNumberArg(args, 'advanceMs') ?? 0;
        if (advanceMs > 0) manager.tick(advanceMs);
        return JSON.stringify(manager.sweep(), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const restore: Tool = {
    definition: toolDef(
      'voice_v19_session_restore',
      'Restore a voice v19 session from an exported snapshot (local action): pass the JSON from a previous export (VoiceSessionV19Export). Re-applies the v18 resume token when present.',
      {
        exportedJson: { type: 'string', description: 'Exported session JSON (VoiceSessionV19Export).' },
      },
      ['exportedJson'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = needManager();
        const exportedJson = getStringArg(args, 'exportedJson');
        let parsed: unknown;
        try {
          parsed = JSON.parse(exportedJson);
        } catch {
          throw new Error('exportedJson is not valid JSON.');
        }
        const session = manager.restore(parsed as never);
        if (!session) return errorResult('Restore failed: invalid export or session id already exists.');
        return JSON.stringify(
          { restored: true, sessionId: session.id, snapshot: manager.uiSnapshot(session.id) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const prosody: Tool = {
    definition: toolDef(
      'voice_v19_prosody',
      'Prosody control v19 (local action when writing): get the current setting, set emotion (neutral, happy, calm, urgent, empathetic, formal, excited, apologetic), set voice context, set or clear a per-utterance override (rate, pitchSt, pauses, emphasis, volumeDb), plan an utterance (clauses + timing) or render it as SSML.',
      {
        action: { type: 'string', description: 'get, set-emotion, set-context, set-override, clear-override, plan or ssml.' },
        emotion: { type: 'string', description: 'Emotion for set-emotion.' },
        context: { type: 'string', description: 'Voice context for set-context: chat, announcement, alert, narration or whisper.' },
        text: { type: 'string', description: 'Utterance for plan / ssml.' },
        rate: { type: 'number', description: 'Override: speaking rate 0.5..2.0.' },
        pitchSt: { type: 'number', description: 'Override: pitch shift in semitones -12..+12.' },
        pauseBeforeMs: { type: 'number', description: 'Override: pause before the utterance, ms.' },
        pauseAfterMs: { type: 'number', description: 'Override: pause after the utterance, ms.' },
        clausePauseMs: { type: 'number', description: 'Override: pause between clauses, ms.' },
        emphasis: { type: 'string', description: 'Override: none, moderate or strong.' },
        volumeDb: { type: 'number', description: 'Override: volume trim in dB -12..+6.' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const controller = needProsody();
        const action = getStringArg(args, 'action');
        if (!(PROSODY_ACTIONS as readonly string[]).includes(action)) {
          throw new Error(`Unknown prosody action "${action}" (want one of ${PROSODY_ACTIONS.join(', ')}).`);
        }
        if (action === 'get') {
          return JSON.stringify(
            { emotion: controller.getEmotion(), context: controller.getContext(), settings: controller.resolve() },
            null,
            2,
          );
        }
        if (action === 'set-emotion') {
          const emotion = getStringArg(args, 'emotion');
          if (!isProsodyV19Emotion(emotion)) {
            throw new Error(`Unknown emotion "${emotion}" (want one of ${EMOTIONS.join(', ')}).`);
          }
          controller.setEmotion(emotion as ProsodyV19Emotion);
          return JSON.stringify({ emotion, settings: controller.resolve() }, null, 2);
        }
        if (action === 'set-context') {
          const context = getStringArg(args, 'context');
          if (!isVoiceProfileV17Context(context)) {
            throw new Error(`Unknown voice context "${context}" (want one of ${VOICE_CONTEXTS.join(', ')}).`);
          }
          controller.setContext(context as VoiceProfileV17Context);
          return JSON.stringify(
            { context, emotion: controller.getEmotion(), settings: controller.resolve() },
            null,
            2,
          );
        }
        if (action === 'set-override') {
          const emphasis = getOptionalStringArg(args, 'emphasis');
          if (emphasis !== undefined && !['none', 'moderate', 'strong'].includes(emphasis)) {
            throw new Error(`Unknown emphasis "${emphasis}" (want none, moderate or strong).`);
          }
          controller.setOverride({
            ...(getOptionalNumberArg(args, 'rate') !== undefined ? { rate: getOptionalNumberArg(args, 'rate') as number } : {}),
            ...(getOptionalNumberArg(args, 'pitchSt') !== undefined ? { pitchSt: getOptionalNumberArg(args, 'pitchSt') as number } : {}),
            ...(getOptionalNumberArg(args, 'pauseBeforeMs') !== undefined ? { pauseBeforeMs: getOptionalNumberArg(args, 'pauseBeforeMs') as number } : {}),
            ...(getOptionalNumberArg(args, 'pauseAfterMs') !== undefined ? { pauseAfterMs: getOptionalNumberArg(args, 'pauseAfterMs') as number } : {}),
            ...(getOptionalNumberArg(args, 'clausePauseMs') !== undefined ? { clausePauseMs: getOptionalNumberArg(args, 'clausePauseMs') as number } : {}),
            ...(emphasis !== undefined ? { emphasis: emphasis as 'none' | 'moderate' | 'strong' } : {}),
            ...(getOptionalNumberArg(args, 'volumeDb') !== undefined ? { volumeDb: getOptionalNumberArg(args, 'volumeDb') as number } : {}),
          });
          return JSON.stringify({ override: controller.getOverride(), settings: controller.resolve() }, null, 2);
        }
        if (action === 'clear-override') {
          controller.clearOverride();
          return JSON.stringify({ cleared: true, settings: controller.resolve() }, null, 2);
        }
        const text = getStringArg(args, 'text');
        if (action === 'plan') {
          return JSON.stringify(controller.plan(text), null, 2);
        }
        return JSON.stringify({ ssml: controller.ssml(text) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'voice_v19_eval',
      'Voice eval v19 (local action): run — run the default scripted eval (naturalness + clarity mock scores, turn-taking latency, barge-in F1, TTS first-chunk) and return the aggregate report; compare — diff a run report against a baseline report JSON and flag regressions beyond tolerance.',
      {
        action: { type: 'string', description: 'run or compare.' },
        currentJson: { type: 'string', description: 'Current report JSON for compare.' },
        baselineJson: { type: 'string', description: 'Baseline report JSON for compare.' },
        tolerance: { type: 'number', description: 'Regression tolerance 0..1 for compare (default 0.05).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!(EVAL_ACTIONS as readonly string[]).includes(action)) {
          throw new Error(`Unknown eval action "${action}" (want one of ${EVAL_ACTIONS.join(', ')}).`);
        }
        if (action === 'run') {
          const report = await new VoiceEvalV19().runAll();
          return JSON.stringify({ summary: voiceEvalV19Summary(report), report }, null, 2);
        }
        const parse = (raw: string, name: string): VoiceEvalV19Report => {
          try {
            return JSON.parse(raw) as VoiceEvalV19Report;
          } catch {
            throw new Error(`${name} is not valid JSON.`);
          }
        };
        const current = parse(getStringArg(args, 'currentJson'), 'currentJson');
        const baseline = parse(getStringArg(args, 'baselineJson'), 'baselineJson');
        const tolerance = getOptionalNumberArg(args, 'tolerance') ?? 0.05;
        const regressions = compareWithBaselineV19(current, baseline, tolerance);
        return JSON.stringify(
          { regressions, regressed: regressions.filter((r) => r.regressed) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const turnSave: Tool = {
    definition: toolDef(
      'voice_v19_turn_save',
      'Save to an open turn (local action): append a partial transcript segment (speaker user or agent, seq, text, start/end ms, final flag) with overlap-aware dedupe, or set the turn reply text + spoken chars.',
      {
        turnId: { type: 'string', description: 'Id of the turn.' },
        sessionId: { type: 'string', description: 'Session the turn belongs to (used when opening a new turn).' },
        speaker: { type: 'string', description: 'Segment speaker: user or agent.' },
        seq: { type: 'number', description: 'Segment sequence number (monotonic per turn).' },
        text: { type: 'string', description: 'Segment text (or reply text when setting the reply).' },
        startMs: { type: 'number', description: 'Segment start, virtual ms.' },
        endMs: { type: 'number', description: 'Segment end, virtual ms.' },
        final: { type: 'boolean', description: 'Whether the segment is final (default false).' },
        replyText: { type: 'string', description: 'When set (without speaker/seq), set the turn reply text instead of appending a segment.' },
        spokenChars: { type: 'number', description: 'Chars of the reply already spoken (with replyText).' },
      },
      ['turnId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const store = needTurnStore();
        const turnId = getStringArg(args, 'turnId');
        const sessionId = getOptionalStringArg(args, 'sessionId') ?? '';
        const replyText = getOptionalStringArg(args, 'replyText');
        if (replyText !== undefined) {
          store.openTurn(turnId, sessionId);
          const updated = store.setReply(turnId, replyText, getOptionalNumberArg(args, 'spokenChars') ?? 0);
          return JSON.stringify({ saved: true, turn: updated }, null, 2);
        }
        const speaker = getStringArg(args, 'speaker');
        if (speaker !== 'user' && speaker !== 'agent') {
          throw new Error(`Unknown speaker "${speaker}" (want user or agent).`);
        }
        const seq = getOptionalNumberArg(args, 'seq');
        if (seq === undefined) throw new Error('Missing required argument: "seq"');
        const text = getStringArg(args, 'text');
        store.openTurn(turnId, sessionId);
        const result = store.appendSegment({
          seq,
          turnId,
          speaker: speaker as 'user' | 'agent',
          text,
          startMs: getOptionalNumberArg(args, 'startMs') ?? 0,
          endMs: getOptionalNumberArg(args, 'endMs') ?? 0,
          final: getOptionalBooleanArg(args, 'final') ?? false,
        });
        return JSON.stringify({ saved: result.accepted, deduped: result.deduped, turn: store.getTurn(turnId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const turnInterrupt: Tool = {
    definition: toolDef(
      'voice_v19_turn_interrupt',
      'Interrupt an open turn (local action): mark it interrupted (network-lost, crash, barge-in or timeout) and snapshot the partial transcript + spoken prefix so the resume question can quote them.',
      {
        turnId: { type: 'string', description: 'Id of the turn.' },
        reason: { type: 'string', description: 'network-lost, crash, barge-in or timeout.' },
      },
      ['turnId', 'reason'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const store = needTurnStore();
        const turnId = getStringArg(args, 'turnId');
        const reason = getStringArg(args, 'reason');
        if (!isTurnResumeV19InterruptReason(reason)) {
          throw new Error(`Unknown interrupt reason "${reason}" (want one of ${INTERRUPT_REASONS.join(', ')}).`);
        }
        const turn = store.interruptTurn(turnId, reason as TurnResumeV19InterruptReason);
        if (!turn) return errorResult(`Unknown turn "${turnId}".`);
        return JSON.stringify({ interrupted: true, turn }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const turnResume: Tool = {
    definition: toolDef(
      'voice_v19_turn_resume',
      'Resume an interrupted turn (local action): request — ask the user (returns the confirmation question; the turn waits); confirm — continue with action resume / restart / summarise / drop; decline — drop the turn; complete — mark a resumed turn finished. A turn never resumes without confirm.',
      {
        turnId: { type: 'string', description: 'Id of the turn.' },
        action: { type: 'string', description: 'request, confirm, decline or complete.' },
        resumeAction: { type: 'string', description: 'For confirm: resume, restart, summarise or drop.' },
      },
      ['turnId', 'action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const store = needTurnStore();
        const turnId = getStringArg(args, 'turnId');
        const action = getStringArg(args, 'action');
        if (!(TURN_RESUME_ACTIONS as readonly string[]).includes(action)) {
          throw new Error(`Unknown turn resume action "${action}" (want one of ${TURN_RESUME_ACTIONS.join(', ')}).`);
        }
        if (action === 'request') {
          const confirmation = store.requestResume(turnId);
          if (!confirmation) return errorResult(`Turn "${turnId}" is not interrupted (nothing to resume).`);
          return JSON.stringify({ requested: true, confirmation }, null, 2);
        }
        if (action === 'confirm') {
          const resumeAction = getStringArg(args, 'resumeAction');
          if (!isTurnResumeV19Action(resumeAction)) {
            throw new Error(`Unknown resume action "${resumeAction}" (want one of ${RESUME_ACTIONS.join(', ')}).`);
          }
          const plan = store.confirmResume(turnId, resumeAction as TurnResumeV19Action);
          if (!plan) return errorResult(`Turn "${turnId}" is not awaiting confirmation.`);
          return JSON.stringify({ confirmed: true, plan, turn: store.getTurn(turnId) }, null, 2);
        }
        if (action === 'decline') {
          const turn = store.declineResume(turnId);
          if (!turn) return errorResult(`Turn "${turnId}" is not awaiting confirmation.`);
          return JSON.stringify({ declined: true, turn }, null, 2);
        }
        const turn = store.completeTurn(turnId);
        if (!turn) return errorResult(`Unknown turn "${turnId}".`);
        return JSON.stringify({ completed: true, turn }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const turnList: Tool = {
    definition: toolDef(
      'voice_v19_turn_list',
      'List open turns (read): every turn the store tracks (open, interrupted, awaiting confirmation, resumed, completed, dropped) plus store stats.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const store = needTurnStore();
        return JSON.stringify({ turns: store.listTurns(), stats: store.stats() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [create, list, snapshot, close, remove, sweep, restore, prosody, evalTool, turnSave, turnInterrupt, turnResume, turnList];
}

/** Unbound placeholder (own default manager — mock sessions only). */
export const VOICE_V19_TOOLS: Tool[] = createVoiceV19Tools();

export const VOICE_V19_TOOL_NAMES = [
  'voice_v19_session_create',
  'voice_v19_session_list',
  'voice_v19_session_snapshot',
  'voice_v19_session_close',
  'voice_v19_session_delete',
  'voice_v19_session_sweep',
  'voice_v19_session_restore',
  'voice_v19_prosody',
  'voice_v19_eval',
  'voice_v19_turn_save',
  'voice_v19_turn_interrupt',
  'voice_v19_turn_resume',
  'voice_v19_turn_list',
] as const;

export function isVoiceV19ToolName(name: string): name is (typeof VOICE_V19_TOOL_NAMES)[number] {
  return (VOICE_V19_TOOL_NAMES as readonly string[]).includes(name);
}
