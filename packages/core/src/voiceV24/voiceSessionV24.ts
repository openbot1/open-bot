/**
 * Voice session v24 (v1.37, Team T5).
 *
 * One live voice session that ties the v24 pieces together:
 * the transcript, the per-tool-call timers, the model
 * switcher and the dynamic provider catalogue. The session
 * is the unit the UI renders: one row per session with its
 * current model, its transcript length, its running tool
 * calls (live timers) and its finished-call aggregates.
 *
 * Rules the session enforces:
 *   - the transcript is append-only: turns are added, never
 *     edited or removed, so a model switch can prove the
 *     transcript survived (checksum before/after);
 *   - tool calls belong to turns: a call started in turn N
 *     is recorded against turn N, so the panel can show
 *     "turn 3 called search (1.2s) then calendar (0.4s)";
 *   - closing a session cancels its running calls (they
 *     are recorded as `cancelled`, not left running forever)
 *     and freezes the transcript;
 *   - the session never dials a provider: switching only
 *     changes the pointer the host will use for the next
 *     turn; the host performs the actual model call.
 *
 * All clocks virtual; all audio mock/synthetic.
 */
import { DynamicProviderCatalogV24 } from './providerCatalogV24';
import { ModelFallbackChainV24 } from './modelFallbackV24';
import { VoiceModelSwitcherV24, type VoiceV24SwitchResult } from './modelSwitchV24';
import {
  ToolCallTimerRegistryV24,
  type ToolCallTimerV24Options,
  type VoiceV24RunningCall,
  type VoiceV24SessionTimerStats,
} from './toolCallTimersV24';
import {
  formatDurationV24,
  transcriptChecksumV24,
  type VoiceV24ModelRef,
  type VoiceV24ToolCallRecord,
  type VoiceV24TranscriptTurn,
} from './types';

export type VoiceV24SessionPhase = 'open' | 'closed';

export interface VoiceSessionV24Options {
  timerOptions?: Partial<ToolCallTimerV24Options>;
  allowUnusableSwitch?: boolean;
}

export interface VoiceV24SessionSnapshot {
  sessionId: string;
  phase: VoiceV24SessionPhase;
  openedAtMs: number;
  closedAtMs: number | null;
  currentModel: VoiceV24ModelRef;
  previousModel: VoiceV24ModelRef | null;
  transcriptTurns: number;
  transcriptChecksum: string;
  switches: number;
  rolledBackSwitches: number;
  timers: VoiceV24SessionTimerStats;
  runningCalls: VoiceV24RunningCall[];
}

export function createVoiceSessionV24(
  sessionId: string,
  initialModel: VoiceV24ModelRef,
  catalog: DynamicProviderCatalogV24,
  opts: VoiceSessionV24Options = {},
): VoiceSessionV24 {
  return new VoiceSessionV24(sessionId, initialModel, catalog, opts);
}

export class VoiceSessionV24 {
  readonly sessionId: string;
  private readonly catalog: DynamicProviderCatalogV24;
  private readonly timers: ToolCallTimerRegistryV24;
  private readonly switcher: VoiceModelSwitcherV24;
  private readonly transcript: VoiceV24TranscriptTurn[] = [];
  private phase: VoiceV24SessionPhase = 'open';
  private closedAtMs: number | null = null;
  private turnIndex = 0;

  constructor(
    sessionId: string,
    initialModel: VoiceV24ModelRef,
    catalog: DynamicProviderCatalogV24,
    opts: VoiceSessionV24Options = {},
  ) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('sessionId must be a non-empty string');
    }
    this.sessionId = sessionId;
    this.catalog = catalog;
    this.timers = new ToolCallTimerRegistryV24(opts.timerOptions ?? {});
    this.switcher = new VoiceModelSwitcherV24(sessionId, initialModel, {
      allowUnusableSwitch: opts.allowUnusableSwitch ?? false,
    });
  }

  /** Open the session at a virtual time (also records the open time). */
  static open(
    sessionId: string,
    initialModel: VoiceV24ModelRef,
    catalog: DynamicProviderCatalogV24,
    atMs: number,
    opts: VoiceSessionV24Options = {},
  ): VoiceSessionV24 {
    const session = new VoiceSessionV24(sessionId, initialModel, catalog, opts);
    session.openedAt = atMs;
    return session;
  }

  private openedAt = 0;

  phaseOf(): VoiceV24SessionPhase {
    return this.phase;
  }

  isOpen(): boolean {
    return this.phase === 'open';
  }

  timerRegistry(): ToolCallTimerRegistryV24 {
    return this.timers;
  }

  modelSwitcher(): VoiceModelSwitcherV24 {
    return this.switcher;
  }

  currentModel(): VoiceV24ModelRef {
    return this.switcher.currentModel();
  }

  /** Append one transcript turn; returns the new turn count. */
  addTurn(role: VoiceV24TranscriptTurn['role'], text: string, atMs: number): number {
    this.assertOpen();
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('transcript text must be a non-empty string');
    }
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('atMs must be a finite number >= 0');
    this.transcript.push({ role, text, atMs });
    if (role === 'user') this.turnIndex += 1;
    return this.transcript.length;
  }

  /** Current turn index (counts user turns, 0-based for the next call). */
  currentTurnIndex(): number {
    return this.turnIndex;
  }

  transcriptTurns(): VoiceV24TranscriptTurn[] {
    return this.transcript.map((t) => ({ ...t }));
  }

  transcriptCount(): number {
    return this.transcript.length;
  }

  transcriptChecksum(): string {
    return transcriptChecksumV24(this.transcript);
  }

  /** Start a tool-call timer in the current turn. */
  startToolCall(toolName: string, atMs: number): string {
    this.assertOpen();
    return this.timers.start(this.sessionId, toolName, atMs, this.turnIndex);
  }

  endToolCall(callId: string, atMs: number): VoiceV24ToolCallRecord {
    return this.timers.end(callId, atMs);
  }

  failToolCall(callId: string, atMs: number, error: string): VoiceV24ToolCallRecord {
    return this.timers.fail(callId, atMs, error);
  }

  cancelToolCall(callId: string, atMs: number): VoiceV24ToolCallRecord {
    return this.timers.cancel(callId, atMs);
  }

  /** Live running calls with elapsed time, for the UI timer rows. */
  runningCalls(atMs: number): VoiceV24RunningCall[] {
    return this.timers.running(this.sessionId, atMs);
  }

  /** Check running calls against thresholds; returns newly raised alerts. */
  checkRunning(atMs: number): ReturnType<ToolCallTimerRegistryV24['checkRunning']> {
    return this.timers.checkRunning(atMs);
  }

  /** Switch the session model mid-conversation; transcript is preserved. */
  switchModel(to: VoiceV24ModelRef, atMs: number): VoiceV24SwitchResult {
    this.assertOpen();
    return this.switcher.switchTo(this.catalog, to, this.transcript, atMs);
  }

  /** Roll back to the model before the last switch. */
  rollbackModel(atMs: number): VoiceV24SwitchResult {
    this.assertOpen();
    return this.switcher.rollback(this.transcript, atMs);
  }

  /**
   * Fall back to the next usable model in `chain` when the
   * current model is no longer usable (offline provider,
   * deprecated model, ...). The switch goes through the
   * normal switch path, so the transcript is checksummed;
   * the decision is recorded on the chain. Returns null
   * (no switch) when the chain is exhausted.
   */
  autoFallback(
    chain: ModelFallbackChainV24,
    reason: string,
    atMs: number,
  ): { switched: boolean; result: VoiceV24SwitchResult | null; to: VoiceV24ModelRef | null } {
    this.assertOpen();
    const current = this.switcher.currentModel();
    const picked = chain.pickFallback(this.catalog, current, atMs);
    chain.recordDecision(this.sessionId, current, picked.to, reason, picked.skipped, atMs);
    if (picked.to === null) {
      return { switched: false, result: null, to: null };
    }
    const result = this.switcher.switchTo(this.catalog, picked.to, this.transcript, atMs);
    return { switched: result.ok, result, to: picked.to };
  }

  timerStats(): VoiceV24SessionTimerStats {
    return this.timers.sessionStats(this.sessionId);
  }

  snapshot(atMs: number): VoiceV24SessionSnapshot {
    return {
      sessionId: this.sessionId,
      phase: this.phase,
      openedAtMs: this.openedAt,
      closedAtMs: this.closedAtMs,
      currentModel: this.switcher.currentModel(),
      previousModel: this.switcher.previousModel(),
      transcriptTurns: this.transcript.length,
      transcriptChecksum: this.transcriptChecksum(),
      switches: this.switcher.switchCount(),
      rolledBackSwitches: this.switcher.rolledBackSwitches().length,
      timers: this.timers.sessionStats(this.sessionId),
      runningCalls: this.timers.running(this.sessionId, atMs),
    };
  }

  /** Close the session: running calls are cancelled, transcript frozen. */
  close(atMs: number): { cancelledCalls: number; transcriptTurns: number } {
    if (this.phase === 'closed') {
      return { cancelledCalls: 0, transcriptTurns: this.transcript.length };
    }
    const cancelledCalls = this.timers.cancelSession(this.sessionId, atMs);
    this.phase = 'closed';
    this.closedAtMs = atMs;
    return { cancelledCalls, transcriptTurns: this.transcript.length };
  }

  summary(atMs: number): string {
    const snapshot = this.snapshot(atMs);
    const model = `${snapshot.currentModel.providerId}/${snapshot.currentModel.model}`;
    return (
      `Session ${this.sessionId} (${snapshot.phase}): model ${model}, ` +
      `${snapshot.transcriptTurns} transcript turns, ` +
      `${snapshot.timers.calls} tool calls (${formatDurationV24(snapshot.timers.totalMs)} total), ` +
      `${snapshot.timers.slowCalls} slow, ${snapshot.switches} model switches.`
    );
  }

  markdown(atMs: number): string {
    const snapshot = this.snapshot(atMs);
    const lines: string[] = [
      `# Voice v24 session ${this.sessionId}`,
      '',
      `Phase: ${snapshot.phase}; model: ${snapshot.currentModel.providerId}/${snapshot.currentModel.model}; transcript: ${snapshot.transcriptTurns} turns (checksum ${snapshot.transcriptChecksum}).`,
      `Switches: ${snapshot.switches} (${snapshot.rolledBackSwitches} rolled back).`,
      '',
      this.timers.markdown(this.sessionId),
    ];
    return lines.join('\n');
  }

  private assertOpen(): void {
    if (this.phase !== 'open') {
      throw new Error(`Voice session "${this.sessionId}" is closed`);
    }
  }
}
