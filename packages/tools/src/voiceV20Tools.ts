/**
 * Voice v20 tools for @open-bot/tools (v1.29, Đội T5).
 *
 * The agent drives the voice v20 extensions by tool call:
 *  - voice_v20_persist_save    — save a durable checkpoint for a
 *    session (pipeline snapshot JSON + transcript segments +
 *    cut-reply prosody carry-over), checksummed + atomic (local action)
 *  - voice_v20_persist_load    — load the latest (or numbered)
 *    checkpoint for a session, checksum-verified (read)
 *  - voice_v20_persist_list    — sessions + checkpoints + stats (read)
 *  - voice_v20_persist_delete  — delete one checkpoint or a whole
 *    session (local action)
 *  - voice_v20_resume          — resume lifecycle: interrupt / plan /
 *    confirm / decline / status — resume, restart, summarise or drop
 *    a cut reply, with prosody carry-over (local action)
 *  - voice_v20_open_turn       — open-turn v8: classify-silence /
 *    score-barge-in / interrupt-sentence / overlap (local action)
 *  - voice_v20_transcript_accuracy — WER/CER for one reference /
 *    hypothesis pair, or the whole offline corpus (local action)
 *  - voice_v20_eval_extended   — run the extended eval harness
 *    (transcript + prosody + turn-taking + barge-in + pipeline
 *    dialogues) and optionally compare against a baseline report
 *    (local action)
 *
 * SAFETY: everything here is local — the default store is
 * memory-only unless the host binds a base directory (then
 * checkpoints are JSON files under that directory only;
 * session ids are validated so they can never escape it),
 * replies are mock/scripted, eval scores are computed from the
 * offline corpus, and resume never continues a turn without an
 * explicit plan/confirm. No provider is dialled, no key is read
 * or stored, no mic or sound card is touched.
 *
 * Factory:
 *   createVoiceV20Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V20_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  SessionPersistenceStoreV20,
  createSessionPersistenceStoreV20,
  ResumeOrchestratorV20,
  createResumeOrchestratorV20,
  OpenTurnEngineV20,
  createOpenTurnEngineV20,
  EvalHarnessV20,
  createEvalHarnessV20,
  ProsodyTtsV20,
  compareWithBaselineV20,
  evalHarnessV20Markdown,
  scoreTranscriptV20,
  aggregateTranscriptAccuracyV20,
  transcriptAccuracyV20Summary,
  classifySilenceV20,
  scoreOpenTurnBargeInV20,
  interruptSentenceV20,
  arbitrateOverlapV20,
  isSafeSessionIdV20,
  EVAL_CORPUS_V20_TRANSCRIPTS,
  validateEvalCorpusV20,
  isTurnResumeV19InterruptReason,
  isTurnResumeV19Action,
  type EvalHarnessV20Report,
  type PersistedSessionV20Checkpoint,
  type PipelineV20Snapshot,
  type ResumeV20Options,
  type SessionPersistenceV20Options,
  type TurnResumeV19Action,
  type TurnResumeV19InterruptReason,
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

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
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

export interface VoiceV20ToolOptions {
  /** Persistence store accessor (the host binds its store). */
  getPersistenceStore?: () => SessionPersistenceStoreV20 | null;
  /** Resume orchestrator accessor. */
  getResumeOrchestrator?: () => ResumeOrchestratorV20 | null;
  /** Open-turn engine accessor. */
  getOpenTurnEngine?: () => OpenTurnEngineV20 | null;
  /** Eval harness accessor. */
  getEvalHarness?: () => EvalHarnessV20 | null;
  /** Base directory for the default store (memory-only when omitted). */
  persistenceBaseDir?: string;
  /** Options for the default persistence store. */
  persistenceOptions?: Partial<SessionPersistenceV20Options>;
  /** Options for the default resume orchestrator. */
  resumeOptions?: Partial<ResumeV20Options>;
}

const RESUME_TOOL_ACTIONS = ['interrupt', 'plan', 'confirm', 'decline', 'status'] as const;
const OPEN_TURN_ACTIONS = ['classify-silence', 'score-barge-in', 'interrupt-sentence', 'overlap'] as const;
const EVAL_ACTIONS = ['run', 'compare'] as const;

function parseJsonArg(value: string | undefined, name: string): unknown {
  if (value === undefined || value === '') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Argument "${name}" is not valid JSON`);
  }
}

function isPipelineSnapshotV20(value: unknown): value is PipelineV20Snapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o.phase === 'string'
    && typeof o.turnCounter === 'number'
    && Array.isArray(o.turns)
    && typeof o.committedTranscript === 'string'
    && typeof o.stats === 'object' && o.stats !== null;
}

export function createVoiceV20Tools(opts: VoiceV20ToolOptions = {}): Tool[] {
  const defaultStore = new SessionPersistenceStoreV20({
    ...(opts.persistenceBaseDir ? { baseDir: opts.persistenceBaseDir } : {}),
    ...opts.persistenceOptions,
  });
  const defaultResume = new ResumeOrchestratorV20(opts.resumeOptions);
  const defaultOpenTurn = new OpenTurnEngineV20();
  const defaultHarness = new EvalHarnessV20();
  const defaultTts = new ProsodyTtsV20();
  const needStore = (): SessionPersistenceStoreV20 => opts.getPersistenceStore?.() ?? defaultStore;
  const needResume = (): ResumeOrchestratorV20 => opts.getResumeOrchestrator?.() ?? defaultResume;
  const needOpenTurn = (): OpenTurnEngineV20 => opts.getOpenTurnEngine?.() ?? defaultOpenTurn;
  const needHarness = (): EvalHarnessV20 => opts.getEvalHarness?.() ?? defaultHarness;

  const persistSave: Tool = {
    definition: toolDef(
      'voice_v20_persist_save',
      'Save a durable voice v20 checkpoint (local action): seals a pipeline snapshot JSON with a checksum and writes it atomically under the store (memory-only by default, or the host-bound base directory). Returns the sealed envelope summary.',
      {
        sessionId: { type: 'string', description: 'Session id (letters, digits, ., _, - only).' },
        number: { type: 'number', description: 'Monotonic checkpoint number for this session.' },
        atMs: { type: 'number', description: 'Virtual clock at checkpoint time (ms).' },
        snapshotJson: { type: 'string', description: 'PipelineV20Snapshot as JSON (phase, turnCounter, turns, committedTranscript, stats).' },
        transcriptSegmentsJson: { type: 'string', description: 'Transcript segments as JSON array (optional).' },
        spokenPrefix: { type: 'string', description: 'Spoken prefix of a cut reply (optional).' },
        remainingText: { type: 'string', description: 'Remaining reply text after the cut (optional).' },
        resumeAction: { type: 'string', description: 'Resume action picked for the cut reply: resume, restart, summarise or drop (optional).' },
      },
      ['sessionId', 'number', 'atMs', 'snapshotJson'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const number = getOptionalNumberArg(args, 'number') ?? 0;
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const snapshotJson = getStringArg(args, 'snapshotJson');
        const snapshot = parseJsonArg(snapshotJson, 'snapshotJson');
        if (!isPipelineSnapshotV20(snapshot)) return errorResult('snapshotJson is not a PipelineV20Snapshot');
        const segmentsRaw = parseJsonArg(getOptionalStringArg(args, 'transcriptSegmentsJson'), 'transcriptSegmentsJson');
        const segments = Array.isArray(segmentsRaw) ? segmentsRaw : [];
        const resumeActionRaw = getOptionalStringArg(args, 'resumeAction');
        if (resumeActionRaw !== undefined && !isTurnResumeV19Action(resumeActionRaw)) {
          return errorResult(`Unknown resumeAction "${resumeActionRaw}" (resume, restart, summarise, drop)`);
        }
        const store = needStore();
        const saved = store.save(
          {
            sessionId,
            number,
            atMs,
            snapshot,
            transcriptSegments: segments as PersistedSessionV20Checkpoint['transcriptSegments'],
            ...(getOptionalStringArg(args, 'spokenPrefix') !== undefined
              ? { spokenPrefix: getOptionalStringArg(args, 'spokenPrefix') as string } : {}),
            ...(getOptionalStringArg(args, 'remainingText') !== undefined
              ? { remainingText: getOptionalStringArg(args, 'remainingText') as string } : {}),
            ...(resumeActionRaw !== undefined ? { resumeAction: resumeActionRaw as TurnResumeV19Action } : {}),
          },
          atMs,
        );
        if (!saved.ok) return errorResult(saved.error ?? 'save failed');
        return JSON.stringify({
          ok: true,
          sessionId,
          number,
          atMs,
          checksum: saved.checkpoint?.checksum,
          bytes: saved.bytes,
          checkpoints: store.list(sessionId).length,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const persistLoad: Tool = {
    definition: toolDef(
      'voice_v20_persist_load',
      'Load a voice v20 checkpoint (read): the latest checkpoint for a session, or a numbered one. The envelope checksum is verified — a corrupt checkpoint is reported, never applied.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
        number: { type: 'number', description: 'Checkpoint number to load (omit for the latest).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const number = getOptionalNumberArg(args, 'number');
        const store = needStore();
        const loaded = number === undefined ? store.loadLatest(sessionId) : store.load(sessionId, number);
        if (!loaded.ok || !loaded.checkpoint) return errorResult(loaded.errors.join('; '));
        const c = loaded.checkpoint;
        return JSON.stringify({
          ok: true,
          sessionId: c.sessionId,
          number: c.number,
          atMs: c.atMs,
          savedAtMs: c.savedAtMs,
          checksum: c.checksum,
          phase: c.snapshot.phase,
          turns: c.snapshot.turns.length,
          committedTranscript: c.snapshot.committedTranscript,
          transcriptSegments: c.transcriptSegments.length,
          spokenPrefix: c.spokenPrefix ?? '',
          remainingText: c.remainingText ?? '',
          resumeAction: c.resumeAction ?? '',
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const persistList: Tool = {
    definition: toolDef(
      'voice_v20_persist_list',
      'List voice v20 persistence (read): every session the store knows, its checkpoints, and store stats.',
      {
        sessionId: { type: 'string', description: 'Only list this session (omit for all sessions).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const store = needStore();
        const sessions = sessionId !== undefined ? [sessionId] : store.listSessions();
        return JSON.stringify({
          ok: true,
          stats: store.getStats(),
          sessions: sessions.map((id) => ({ sessionId: id, checkpoints: store.list(id) })),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const persistDelete: Tool = {
    definition: toolDef(
      'voice_v20_persist_delete',
      'Delete voice v20 checkpoints (local action): one numbered checkpoint, or a whole session when number is omitted.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
        number: { type: 'number', description: 'Checkpoint number to delete (omit to delete the whole session).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const sessionId = getStringArg(args, 'sessionId');
        const number = getOptionalNumberArg(args, 'number');
        if (!isSafeSessionIdV20(sessionId)) return errorResult(`unsafe sessionId "${sessionId}"`);
        const store = needStore();
        if (number === undefined) {
          const removed = store.deleteSession(sessionId);
          return JSON.stringify({ ok: true, sessionId, removed });
        }
        const removed = store.delete(sessionId, number);
        return JSON.stringify({ ok: true, sessionId, number, removed });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const resumeTool: Tool = {
    definition: toolDef(
      'voice_v20_resume',
      'Voice v20 resume lifecycle (local action): interrupt a turn (cut / network-lost / crash / timeout), plan the continuation (auto resume / restart / summarise / drop, or the user-picked action), confirm it, decline it, or read the session resume status. Resume never continues a turn without an explicit plan/confirm.',
      {
        action: { type: 'string', description: 'interrupt, plan, confirm, decline or status.' },
        sessionId: { type: 'string', description: 'Session id.' },
        turnId: { type: 'string', description: 'Turn id (interrupt only).' },
        replyText: { type: 'string', description: 'Full agent reply text being spoken (interrupt only).' },
        spokenChars: { type: 'number', description: 'Chars already spoken at the cut (interrupt only).' },
        reason: { type: 'string', description: 'Interrupt reason: network-lost, crash, barge-in or timeout (interrupt only).' },
        userAction: { type: 'string', description: 'User-picked continuation: resume, restart, summarise or drop (plan only).' },
        atMs: { type: 'number', description: 'Virtual clock (ms).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (!(RESUME_TOOL_ACTIONS as readonly string[]).includes(action)) {
          return errorResult(`Unknown action "${action}" (interrupt, plan, confirm, decline, status)`);
        }
        const orch = needResume();
        if (action === 'status') {
          const state = orch.getSessionState(sessionId);
          return JSON.stringify({ ok: true, sessionId, canResume: orch.canResume(sessionId), state: state ?? null });
        }
        if (action === 'interrupt') {
          const turnId = getStringArg(args, 'turnId');
          const replyText = getStringArg(args, 'replyText');
          const spokenChars = getOptionalNumberArg(args, 'spokenChars') ?? 0;
          const reasonRaw = getStringArg(args, 'reason');
          if (!isTurnResumeV19InterruptReason(reasonRaw)) {
            return errorResult(`Unknown reason "${reasonRaw}" (network-lost, crash, barge-in, timeout)`);
          }
          const state = orch.interrupt({
            sessionId, turnId, replyText, spokenChars,
            reason: reasonRaw as TurnResumeV19InterruptReason, atMs,
          });
          return JSON.stringify({ ok: true, sessionId, interrupts: state.interrupts, lastInterruptAtMs: state.lastInterruptAtMs });
        }
        if (action === 'plan') {
          const userActionRaw = getOptionalStringArg(args, 'userAction');
          if (userActionRaw !== undefined && !isTurnResumeV19Action(userActionRaw)) {
            return errorResult(`Unknown userAction "${userActionRaw}" (resume, restart, summarise, drop)`);
          }
          const plan = orch.plan(sessionId, userActionRaw as TurnResumeV19Action | undefined, atMs);
          if (!plan) {
            return errorResult(`No resumable interrupt for session "${sessionId}" (${orch.canResume(sessionId).reason})`);
          }
          return JSON.stringify({
            ok: true, sessionId, action: plan.action, speakText: plan.speakText,
            summary: plan.summary, droppedChars: plan.droppedChars,
            remainingChars: plan.remainingChars, attempt: plan.attempt, reason: plan.reason,
            speakChunks: plan.speakChunks.length,
          });
        }
        if (action === 'confirm') {
          const plan = orch.confirm(sessionId, atMs);
          if (!plan) return errorResult(`Nothing to confirm for session "${sessionId}"`);
          return JSON.stringify({ ok: true, sessionId, action: plan.action, speakText: plan.speakText, attempt: plan.attempt });
        }
        const declined = orch.decline(sessionId, atMs);
        if (!declined) return errorResult(`Nothing to decline for session "${sessionId}"`);
        return JSON.stringify({ ok: true, sessionId, action: declined.action, reason: 'declined — remainder dropped' });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const openTurnTool: Tool = {
    definition: toolDef(
      'voice_v20_open_turn',
      'Open-turn v8 checks (local action): classify-silence (thinking vs trailing vs listening pause for a partial transcript + gap), score-barge-in (cut / warn / backchannel / ignore for a candidate burst), interrupt-sentence (split a planned reply at a spoken-char offset), overlap (who keeps the floor when both speak).',
      {
        action: { type: 'string', description: 'classify-silence, score-barge-in, interrupt-sentence or overlap.' },
        text: { type: 'string', description: 'Partial transcript so far (classify-silence) or full reply text (interrupt-sentence).' },
        gapMs: { type: 'number', description: 'Silence gap in ms (classify-silence).' },
        energy: { type: 'number', description: 'Burst energy 0..1 (score-barge-in).' },
        sustainMs: { type: 'number', description: 'Burst sustain in ms (score-barge-in).' },
        transcriptWordsJson: { type: 'string', description: 'Recognised words in this burst as a JSON array (score-barge-in).' },
        echo: { type: 'boolean', description: 'Burst flagged as agent echo (score-barge-in).' },
        speakerChange: { type: 'boolean', description: 'A new voice started mid-reply (score-barge-in).' },
        msSinceChunkStart: { type: 'number', description: 'ms since the current TTS chunk started (score-barge-in).' },
        spokenChars: { type: 'number', description: 'Chars already spoken (interrupt-sentence).' },
        userConfidence: { type: 'number', description: 'User turn confidence 0..1 (overlap).' },
        agentAskingQuestion: { type: 'boolean', description: 'Agent is mid-question (overlap).' },
        agentChunkLowPriority: { type: 'boolean', description: 'Agent chunk is low priority (overlap).' },
        userIsBackchannel: { type: 'boolean', description: 'User burst is a backchannel (overlap).' },
        overlapMs: { type: 'number', description: 'ms the overlap has lasted (overlap).' },
        atMs: { type: 'number', description: 'Virtual clock (ms).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!(OPEN_TURN_ACTIONS as readonly string[]).includes(action)) {
          return errorResult(`Unknown action "${action}" (classify-silence, score-barge-in, interrupt-sentence, overlap)`);
        }
        const engine = needOpenTurn();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'classify-silence') {
          const text = getStringArg(args, 'text');
          const gapMs = getOptionalNumberArg(args, 'gapMs') ?? 0;
          const d = engine.onSilence(text, gapMs, atMs);
          return JSON.stringify({ ok: true, kind: d.kind, endTurn: d.endTurn, nudge: d.nudge, confidence: d.confidence, reason: d.reason });
        }
        if (action === 'score-barge-in') {
          const wordsRaw = parseJsonArg(getOptionalStringArg(args, 'transcriptWordsJson'), 'transcriptWordsJson');
          const words = Array.isArray(wordsRaw) ? (wordsRaw as unknown[]).filter((w): w is string => typeof w === 'string') : [];
          const s = engine.onBargeInCandidate(
            {
              energy: getOptionalNumberArg(args, 'energy') ?? 0,
              sustainMs: getOptionalNumberArg(args, 'sustainMs') ?? 0,
              transcriptWords: words,
              echo: getOptionalBooleanArg(args, 'echo') ?? false,
              speakerChange: getOptionalBooleanArg(args, 'speakerChange') ?? false,
              msSinceChunkStart: getOptionalNumberArg(args, 'msSinceChunkStart') ?? 1000,
            },
            atMs,
          );
          return JSON.stringify({
            ok: true, verdict: s.verdict, score: s.score, rawScore: s.rawScore,
            echoDiscounted: s.echoDiscounted, isBackchannel: s.isBackchannel, reason: s.reason,
          });
        }
        if (action === 'interrupt-sentence') {
          const text = getStringArg(args, 'text');
          const spokenChars = getOptionalNumberArg(args, 'spokenChars') ?? 0;
          const chunks = defaultTts.plan(text);
          const cut = engine.onSentenceCut(chunks, spokenChars, atMs);
          return JSON.stringify({
            ok: true, spokenPrefix: cut.spokenPrefix, remainingText: cut.remainingText,
            droppedChars: cut.droppedChars, chunkIndex: cut.chunkIndex, spokenInChunk: cut.spokenInChunk,
          });
        }
        const d = engine.onOverlap(
          {
            userConfidence: getOptionalNumberArg(args, 'userConfidence') ?? 0,
            agentAskingQuestion: getOptionalBooleanArg(args, 'agentAskingQuestion') ?? false,
            agentChunkLowPriority: getOptionalBooleanArg(args, 'agentChunkLowPriority') ?? false,
            userIsBackchannel: getOptionalBooleanArg(args, 'userIsBackchannel') ?? false,
            overlapMs: getOptionalNumberArg(args, 'overlapMs') ?? 0,
          },
          atMs,
        );
        return JSON.stringify({ ok: true, decision: d.decision, reason: d.reason });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const transcriptAccuracyTool: Tool = {
    definition: toolDef(
      'voice_v20_transcript_accuracy',
      'Score transcript accuracy offline (local action): one reference/hypothesis pair (WER/CER + alignment), or the whole offline corpus with aggregate mean/p95 WER and CER, pass rate and top confusions.',
      {
        action: { type: 'string', description: '"pair" scores one pair; "corpus" scores the whole offline corpus.' },
        reference: { type: 'string', description: 'Reference text — what was really said (pair).' },
        hypothesis: { type: 'string', description: 'Hypothesis text — what the STT produced (pair).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'pair') {
          const reference = getStringArg(args, 'reference');
          const hypothesis = getStringArg(args, 'hypothesis');
          const scored = scoreTranscriptV20(reference, hypothesis);
          return JSON.stringify({ ok: true, ...scored, summary: transcriptAccuracyV20Summary(scored) });
        }
        if (action === 'corpus') {
          const errors = validateEvalCorpusV20();
          if (errors.length > 0) return errorResult(`Corpus invalid: ${errors.join('; ')}`);
          const scored = EVAL_CORPUS_V20_TRANSCRIPTS.map((p) => scoreTranscriptV20(p.reference, p.hypothesis));
          const agg = aggregateTranscriptAccuracyV20(scored);
          return JSON.stringify({ ok: true, aggregate: agg });
        }
        return errorResult(`Unknown action "${action}" (pair, corpus)`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const evalExtendedTool: Tool = {
    definition: toolDef(
      'voice_v20_eval_extended',
      'Run the extended voice eval harness (local action): transcript accuracy, prosody, turn-taking, barge-in P/R/F1 and pipeline dialogues over the offline corpus. "compare" checks a run against a baseline report JSON and flags regressions.',
      {
        action: { type: 'string', description: '"run" runs the harness; "compare" compares a run against a baseline.' },
        baselineJson: { type: 'string', description: 'Baseline EvalHarnessV20Report as JSON (compare only).' },
        markdown: { type: 'boolean', description: 'Return the markdown report instead of JSON (run only).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!(EVAL_ACTIONS as readonly string[]).includes(action)) {
          return errorResult(`Unknown action "${action}" (run, compare)`);
        }
        const harness = needHarness();
        const report = harness.runAll(0);
        if (action === 'run') {
          if (getOptionalBooleanArg(args, 'markdown')) return evalHarnessV20Markdown(report);
          return JSON.stringify({ ok: true, pass: report.pass, summary: harness.summary(report), report });
        }
        const baselineJson = getStringArg(args, 'baselineJson');
        const baseline = parseJsonArg(baselineJson, 'baselineJson') as EvalHarnessV20Report | undefined;
        if (!baseline || typeof baseline !== 'object' || !baseline.transcript || !baseline.bargeIn) {
          return errorResult('baselineJson is not an EvalHarnessV20Report');
        }
        const regressions = compareWithBaselineV20(report, baseline);
        return JSON.stringify({
          ok: true,
          pass: report.pass,
          summary: harness.summary(report),
          regressions,
          regressed: regressions.filter((r) => r.regressed).map((r) => r.dimension),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [persistSave, persistLoad, persistList, persistDelete, resumeTool, openTurnTool, transcriptAccuracyTool, evalExtendedTool];
}

/** Unbound placeholder (own default instances — mock sessions only). */
export const VOICE_V20_TOOLS: Tool[] = createVoiceV20Tools();

export const VOICE_V20_TOOL_NAMES = [
  'voice_v20_persist_save',
  'voice_v20_persist_load',
  'voice_v20_persist_list',
  'voice_v20_persist_delete',
  'voice_v20_resume',
  'voice_v20_open_turn',
  'voice_v20_transcript_accuracy',
  'voice_v20_eval_extended',
] as const;

export function isVoiceV20ToolName(name: string): name is (typeof VOICE_V20_TOOL_NAMES)[number] {
  return (VOICE_V20_TOOL_NAMES as readonly string[]).includes(name);
}
