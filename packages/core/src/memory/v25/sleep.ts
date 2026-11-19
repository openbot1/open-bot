/**
 * Memory v25 — sleep-time consolidation agent (v1.40, Doi T1).
 *
 * Y tuong hoc tu Letta sleep-time agent + paper "Sleep-time
 * Compute" (survey v140 muc 2, chi y tuong): sleep-time agent chay
 * nen khi agent ranh — to chuc lai memory, hoc tu tuong tac gan
 * day, cai thien phan hoi sau. Primary agent xu ly user + tool +
 * retrieval, KHONG tu sua core memory; sleep-time agent sua block
 * ngoai vong lap chinh, co the dung model khac, tan suat cau hinh
 * duoc (sau N buoc hoac khi context bi compact).
 *
 * Thiet ke v25 — ran ran ranh gioi:
 *  - V25Pipeline.addConversation CHI buffer turn vao sleep agent,
 *    KHONG ghi fact/block truc tiep. Primary agent khong co duong
 *    nao tu sua core memory trong luc chat.
 *  - Chi sleep pass (chay nen / chay tay khi idle) moi: trich fact
 *    tu turn -> judge ADD/UPDATE/DELETE/NOISE -> ap dung -> cap
 *    nhat block dich (blockTargets) — tat ca ghi ro actor
 *    'sleep-agent' + model vao lich su de audit.
 *  - Sleep pass tuan thu budget: maxTurnsPerPass, maxFactsPerPass,
 *    maxCharsPerPass; het budget thi dung, ghi budgetHit, turn thua
 *    o lai buffer cho pass sau.
 *  - Sleep agent ghi block qua V25SharedBlockStore.write nen tuan
 *    thu read-only: block read-only ma sleep-agent khong so huu
 *    thi bi bo qua (ghi action 'skip'), khong crash pass.
 *  - Judge mac dinh la rule judge (local-rule-v1); host co the cam
 *    LLM that qua judgeFn — model ghi vao pass de audit.
 *
 * Chay 100% local voi judge mac dinh, khong goi mang.
 */
import type { V25FactEdgeStore } from './factEdges';
import type { V25SharedBlockStore } from './sharedBlocks';
import {
  applyJudgeDecisionV25,
  createRuleJudgeV25,
  extractCandidateFactsV25,
  makeJudgeLogEntryV25,
} from './judge';
import {
  V25_DEFAULT_SLEEP_CONFIG,
  errV25,
  isoAtV25,
  makeV25Id,
  okV25,
  truncateV25,
  validateSleepConfigV25,
  type V25JudgeFn,
  type V25JudgeLogEntry,
  type V25Result,
  type V25SleepAction,
  type V25SleepConfig,
  type V25SleepPass,
  type V25SleepState,
  type V25Turn,
} from './types';

/** Actor ghi vao lich su khi sleep pass sua memory. */
export const V25_SLEEP_ACTOR = 'sleep-agent';

/** Ket qua ghi 1 muc judge log — store goi qua callback. */
export type V25JudgeLogSink = (entry: V25JudgeLogEntry) => void;

/** Tuy chon khi tao sleep agent. */
export interface V25SleepAgentOptions {
  /** Judge dung trong pass (mac dinh rule judge local). */
  judgeFn?: V25JudgeFn;
  /** Ham ghi judge log (mac dinh bo qua). */
  onJudgeLog?: V25JudgeLogSink;
  /** Cau hinh ban dau (mac dinh V25_DEFAULT_SLEEP_CONFIG). */
  config?: Partial<V25SleepConfig>;
  /** Trang thai khoi phuc tu disk (load store). */
  restoredState?: V25SleepState | null;
}

/** Sleep-time consolidation agent. */
export class V25SleepAgent {
  private readonly facts: V25FactEdgeStore;
  private readonly blocks: V25SharedBlockStore;
  private readonly judgeFn: V25JudgeFn;
  private readonly onJudgeLog: V25JudgeLogSink | undefined;
  private config: V25SleepConfig;
  private turnsSinceLastPass = 0;
  private pendingTurns: V25Turn[] = [];
  private totalPasses = 0;
  private lastPass: V25SleepPass | null = null;
  private readonly passes: V25SleepPass[] = [];
  private running = false;

  constructor(facts: V25FactEdgeStore, blocks: V25SharedBlockStore, opts: V25SleepAgentOptions = {}) {
    this.facts = facts;
    this.blocks = blocks;
    this.judgeFn = opts.judgeFn ?? createRuleJudgeV25();
    this.onJudgeLog = opts.onJudgeLog;
    this.config = {
      ...V25_DEFAULT_SLEEP_CONFIG,
      ...(opts.config ?? {}),
      budget: { ...V25_DEFAULT_SLEEP_CONFIG.budget, ...(opts.config?.budget ?? {}) },
      blockTargets: [...(opts.config?.blockTargets ?? V25_DEFAULT_SLEEP_CONFIG.blockTargets)],
    };
    if (opts.restoredState) this.restore(opts.restoredState);
  }

  /** Cau hinh hien tai (ban sao — sua qua updateConfig). */
  getConfig(): V25SleepConfig {
    return {
      ...this.config,
      budget: { ...this.config.budget },
      blockTargets: [...this.config.blockTargets],
    };
  }

  /** Cap nhat cau hinh — validate truoc, sai tra loi. */
  updateConfig(patch: Partial<V25SleepConfig>): V25Result<V25SleepConfig> {
    const merged: V25SleepConfig = {
      ...this.config,
      ...patch,
      budget: { ...this.config.budget, ...(patch.budget ?? {}) },
      blockTargets: patch.blockTargets !== undefined ? [...patch.blockTargets] : [...this.config.blockTargets],
    };
    const problem = validateSleepConfigV25(merged);
    if (problem) return errV25(problem);
    this.config = merged;
    return okV25(this.getConfig());
  }

  /** So turn tu pass gan nhat. */
  getTurnsSinceLastPass(): number {
    return this.turnsSinceLastPass;
  }

  /** So turn dang cho xu ly. */
  getPendingTurnCount(): number {
    return this.pendingTurns.length;
  }

  /** Tong so pass da chay. */
  getTotalPasses(): number {
    return this.totalPasses;
  }

  /** Pass gan nhat (neu co). */
  getLastPass(): V25SleepPass | null {
    return this.lastPass;
  }

  /** Tat ca pass da chay (moi nhat truoc). */
  listPasses(limit = 20): V25SleepPass[] {
    return [...this.passes].reverse().slice(0, Math.max(0, limit));
  }

  /** Co nen chay pass bay gio khong (du trigger + enabled + khong chay)? */
  shouldRun(): boolean {
    if (!this.config.enabled) return false;
    if (this.running) return false;
    if (this.pendingTurns.length === 0) return false;
    return this.turnsSinceLastPass >= this.config.triggerSteps;
  }

  /**
   * Ghi nhan 1 turn hoi thoai vao buffer. Day la DUONG DUY NHAT
   * primary agent dua thong tin vao memory v25 — chi buffer, khong
   * ghi fact/block. Tra true neu vua cham nguong trigger.
   */
  recordTurn(turn: V25Turn): boolean {
    const text = turn.text.trim();
    if (!text) return false;
    this.pendingTurns.push({
      role: turn.role,
      text,
      at: turn.at || isoAtV25(Date.now()),
    });
    this.turnsSinceLastPass += 1;
    return this.shouldRun();
  }

  /**
   * Chay 1 sleep pass: quet turn buffer -> trich fact -> judge ->
   * ap dung -> cap nhat block dich. Chi sleep pass moi sua core
   * memory. Pass chay tuan tu (running flag chong chay chong).
   */
  async runPass(opts: { force?: boolean; reason?: string; nowMs?: number } = {}): Promise<V25Result<V25SleepPass>> {
    if (this.running) return errV25('Sleep pass khac dang chay — thu lai sau.');
    const nowMs = opts.nowMs ?? Date.now();
    if (!this.config.enabled && !opts.force) {
      return errV25('Sleep agent dang tat (enabled=false) — bat len hoac dung force=true.');
    }
    if (this.pendingTurns.length === 0) {
      return errV25('Khong co turn nao cho xu ly — buffer dang rong.');
    }
    this.running = true;
    try {
      return await this.runPassInner(nowMs, opts.reason ?? (opts.force ? 'manual' : `trigger:${this.config.triggerSteps} turns`));
    } finally {
      this.running = false;
    }
  }

  private async runPassInner(nowMs: number, reason: string): Promise<V25Result<V25SleepPass>> {
    const startedMs = nowMs;
    const budget = this.config.budget;
    const actions: V25SleepAction[] = [];
    const passId = makeV25Id('pass');
    const turns = this.pendingTurns.slice(0, budget.maxTurnsPerPass);
    const leftover = this.pendingTurns.slice(budget.maxTurnsPerPass);
    let charsScanned = 0;
    let factsExtracted = 0;
    let judged = 0;
    let added = 0;
    let updated = 0;
    let closed = 0;
    let noise = 0;
    let blocksUpdated = 0;
    let budgetHit = false;
    const blockNotes: string[] = [];

    // 1. Trich fact ung vien tu turn (tuan thu budget ky tu).
    const candidates: ReturnType<typeof extractCandidateFactsV25> = [];
    for (const turn of turns) {
      if (charsScanned + turn.text.length > budget.maxCharsPerPass) {
        budgetHit = true;
        actions.push({ kind: 'budget', detail: `Het budget ${budget.maxCharsPerPass} ky tu — dung quet tai turn "${truncateV25(turn.text, 40)}".` });
        break;
      }
      charsScanned += turn.text.length;
      const found = extractCandidateFactsV25(turn.text, {
        episodeId: `${passId}:${turn.at}`,
      });
      for (const c of found) {
        if (candidates.length >= budget.maxFactsPerPass) {
          budgetHit = true;
          actions.push({ kind: 'budget', detail: `Het budget ${budget.maxFactsPerPass} fact/pass — ${found.length} ung vien thua de pass sau.` });
          break;
        }
        candidates.push(c);
      }
      if (budgetHit) break;
    }
    factsExtracted = candidates.length;

    // 2. Judge tung ung vien so voi fact hien co, ap dung quyet dinh.
    for (const candidate of candidates) {
      const existing = this.facts.activeFor(candidate.subject, candidate.predicate);
      let verdict;
      try {
        verdict = await this.judgeFn({
          candidate,
          existing,
          source: `${passId}:sleep`,
        });
      } catch (e) {
        actions.push({ kind: 'skip', detail: `Judge loi cho "${candidate.subject} ${candidate.predicate}": ${e instanceof Error ? e.message : String(e)} — bo qua.` });
        continue;
      }
      judged += 1;
      actions.push({ kind: 'judge', detail: `${verdict.decision} "${candidate.subject} ${candidate.predicate} ${candidate.object}" (${verdict.reason})` });
      const applied = applyJudgeDecisionV25(this.facts, candidate, verdict, { nowMs, by: V25_SLEEP_ACTOR });
      if (!applied.ok) {
        actions.push({ kind: 'skip', detail: `Ap dung ${verdict.decision} that bai: ${applied.error}` });
        this.onJudgeLog?.(makeJudgeLogEntryV25(candidate, verdict, false, applied.error, `${passId}:sleep`, nowMs));
        continue;
      }
      const res = applied.value;
      if (res.decision === 'ADD') added += 1;
      if (res.decision === 'UPDATE') {
        updated += 1;
        if (res.closedEdge) closed += 1;
      }
      if (res.decision === 'DELETE') closed += 1;
      if (res.decision === 'NOISE') noise += 1;
      actions.push({
        kind: res.decision === 'ADD' ? 'add' : res.decision === 'UPDATE' ? 'update' : res.decision === 'DELETE' ? 'close' : 'noise',
        detail: res.detail,
      });
      this.onJudgeLog?.(makeJudgeLogEntryV25(candidate, verdict, true, res.detail, `${passId}:sleep`, nowMs));
      if (res.newEdge) {
        blockNotes.push(`- ${res.newEdge.subject} ${res.newEdge.predicate} ${res.newEdge.object}`);
      }
    }

    // 3. Cap nhat block dich: tom tat fact moi vao block (ngoai vong
    // lap chinh). Tuan thu read-only qua block store.
    for (const label of this.config.blockTargets) {
      if (blockNotes.length === 0) break;
      const block = this.blocks.getByLabel(label, {
        userId: '',
        agentId: '',
        runId: '',
        appId: '',
      });
      if (!block) {
        actions.push({ kind: 'skip', detail: `Block dich "${label}" khong ton tai — bo qua.` });
        continue;
      }
      const summary = `\n\n[Sleep ${passId} · ${isoAtV25(nowMs)}]\n${blockNotes.join('\n')}`;
      const res = this.blocks.write(block.id, `${block.value}${summary}`, V25_SLEEP_ACTOR, {
        nowMs,
        reason: `sleep-pass:${passId}`,
      });
      if (!res.ok) {
        actions.push({ kind: 'skip', detail: `Khong cap nhat duoc block "${label}": ${res.error}` });
        continue;
      }
      blocksUpdated += 1;
      actions.push({ kind: 'block', detail: `Cap nhat block "${label}" len v${res.value.version} (${blockNotes.length} fact moi).` });
    }

    // 4. Don buffer: turn da quet xong thi xoa; turn thua (vuot
    // maxTurnsPerPass hoac het budget ky tu giua chung) o lai cho
    // pass sau.
    const scannedTurns = budgetHit ? this.countScannedTurns(turns, budget.maxCharsPerPass) : turns.length;
    this.pendingTurns = [...turns.slice(scannedTurns), ...leftover];
    this.turnsSinceLastPass = this.pendingTurns.length;

    const pass: V25SleepPass = {
      id: passId,
      startedAt: isoAtV25(startedMs),
      finishedAt: isoAtV25(Date.now()),
      model: this.config.model,
      turnsScanned: scannedTurns,
      charsScanned,
      factsExtracted,
      judged,
      added,
      updated,
      closed,
      noise,
      blocksUpdated,
      budgetHit,
      actions,
      reason,
    };
    this.totalPasses += 1;
    this.lastPass = pass;
    this.passes.push(pass);
    return okV25(pass);
  }

  /** Dem so turn da quet het truoc khi het budget ky tu. */
  private countScannedTurns(turns: V25Turn[], maxChars: number): number {
    let chars = 0;
    let count = 0;
    for (const turn of turns) {
      if (chars + turn.text.length > maxChars) break;
      chars += turn.text.length;
      count += 1;
    }
    return count;
  }

  /** Trang thai de luu xuong disk. */
  getState(): V25SleepState {
    return {
      config: this.getConfig(),
      turnsSinceLastPass: this.turnsSinceLastPass,
      pendingTurns: [...this.pendingTurns],
      totalPasses: this.totalPasses,
      lastPass: this.lastPass,
      passes: [...this.passes].slice(-50),
    };
  }

  /** Khoi phuc trang thai tu disk. */
  restore(state: V25SleepState): void {
    if (!state) return;
    if (state.config) {
      const problem = validateSleepConfigV25(state.config);
      if (!problem) {
        this.config = {
          ...V25_DEFAULT_SLEEP_CONFIG,
          ...state.config,
          budget: { ...V25_DEFAULT_SLEEP_CONFIG.budget, ...(state.config.budget ?? {}) },
          blockTargets: [...(state.config.blockTargets ?? [])],
        };
      }
    }
    this.turnsSinceLastPass = state.turnsSinceLastPass ?? 0;
    this.pendingTurns = Array.isArray(state.pendingTurns) ? state.pendingTurns : [];
    this.totalPasses = state.totalPasses ?? 0;
    this.lastPass = state.lastPass ?? null;
    this.passes.length = 0;
    if (Array.isArray(state.passes)) this.passes.push(...state.passes.slice(-50));
  }
}
