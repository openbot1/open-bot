/**
 * Memory v25 — pipeline (v1.40, Doi T1).
 *
 * Dieu phoi 3 thanh phan v25 thanh 1 luong:
 *  - addConversation: primary agent CHI buffer turn vao sleep
 *    agent — KHONG ghi fact/block truc tiep trong luc chat. Chi
 *    sleep pass (nen / chay tay) moi sua core memory.
 *  - runSleepNow: chay sleep pass ngay (khi idle / user yeu cau).
 *  - judgeCandidate: judge 1 fact ung vien bang judge da cau hinh
 *    (mac dinh rule judge) + ap dung + ghi log.
 *  - search: keyword + time-aware (loc as-of neu co `at`).
 *  - snapshotForPrompt: render shared block + fact hien tai trong
 *    ngan sach ky tu de dua vao system prompt.
 *
 * Chay 100% local, khong goi model/mang (tru khi host cam LLM
 * judge qua V25JudgeFn).
 */
import {
  applyJudgeDecisionV25,
  createRuleJudgeV25,
  extractCandidateFactsV25,
  makeJudgeLogEntryV25,
  type V25ApplyDecisionResult,
} from './judge';
import { V25Store } from './store';
import {
  errV25,
  isoAtV25,
  jaccardV25,
  makeV25Id,
  okV25,
  scopeMatchesV25,
  tokenizeV25,
  truncateV25,
  type V25FactEdge,
  type V25FactEdgeInput,
  type V25JudgeFn,
  type V25JudgeVerdict,
  type V25Result,
  type V25Scope,
  type V25SearchHit,
  type V25SleepPass,
  type V25Turn,
} from './types';

/** Ket qua buffer conversation vao sleep agent. */
export interface V25AddConversationReport {
  buffered: number;
  turnsSinceLastPass: number;
  shouldRunSleep: boolean;
  skippedEmpty: number;
}

/** Ket qua snapshot de dua vao prompt. */
export interface V25PromptSnapshot {
  text: string;
  chars: number;
  budgetChars: number;
  facts: V25FactEdge[];
  blocksRendered: number;
  truncated: boolean;
}

/** Pipeline memory v25. */
export class V25Pipeline {
  readonly store: V25Store;
  private readonly judgeFn: V25JudgeFn | undefined;

  constructor(store: V25Store, opts: { judgeFn?: V25JudgeFn } = {}) {
    this.store = store;
    this.judgeFn = opts.judgeFn;
  }

  /**
   * Them hoi thoai vao memory: CHI buffer turn cho sleep pass.
   * Primary agent khong tu sua core memory trong luc chat — day
   * la cam ket kien truc cua v25, khong phai quy uoc mom.
   */
  addConversation(
    turns: V25Turn[],
    opts: { nowMs?: number } = {},
  ): V25Result<V25AddConversationReport> {
    if (!Array.isArray(turns) || turns.length === 0) {
      return errV25('Can it nhat 1 turn de buffer.');
    }
    const nowMs = opts.nowMs ?? Date.now();
    let buffered = 0;
    let skippedEmpty = 0;
    for (const turn of turns) {
      if (!turn || typeof turn.text !== 'string' || turn.text.trim().length === 0) {
        skippedEmpty += 1;
        continue;
      }
      if (turn.role !== 'user' && turn.role !== 'agent' && turn.role !== 'system') {
        return errV25(`role "${String(turn.role)}" khong hop le (user | agent | system).`);
      }
      this.store.sleep.recordTurn({
        role: turn.role,
        text: turn.text,
        at: turn.at || isoAtV25(nowMs),
      });
      buffered += 1;
    }
    return okV25({
      buffered,
      turnsSinceLastPass: this.store.sleep.getTurnsSinceLastPass(),
      shouldRunSleep: this.store.sleep.shouldRun(),
      skippedEmpty,
    });
  }

  /** Chay sleep pass ngay (force khi idle / user yeu cau). */
  async runSleepNow(opts: { reason?: string; nowMs?: number } = {}): Promise<V25Result<V25SleepPass>> {
    return this.store.sleep.runPass({ force: true, reason: opts.reason ?? 'manual', nowMs: opts.nowMs });
  }

  /**
   * Judge 1 fact ung vien so voi memory hien co + ap dung ngay.
   * Dung cho tool judge truc tiep (user duyet) — khong phai duong
   * primary agent tu ghi trong luc chat.
   */
  async judgeCandidate(
    candidate: V25FactEdgeInput,
    opts: { apply?: boolean; source?: string; nowMs?: number; by?: string } = {},
  ): Promise<V25Result<{ verdict: V25JudgeVerdict; applied: V25ApplyDecisionResult | null }>> {
    const subject = candidate.subject.trim();
    const predicate = candidate.predicate.trim();
    const object = candidate.object.trim();
    if (!subject || !predicate || !object) {
      return errV25('candidate can subject/predicate/object khong rong.');
    }
    const nowMs = opts.nowMs ?? Date.now();
    const source = opts.source ?? 'tool:memory_v25_judge';
    const existing = this.store.facts.activeFor(subject, predicate);
    const judge = this.judgeFn ?? this.defaultJudge();
    let verdict: V25JudgeVerdict;
    try {
      verdict = await judge({ candidate, existing, source });
    } catch (e) {
      return errV25(`Judge loi: ${e instanceof Error ? e.message : String(e)}`);
    }
    const apply = opts.apply !== false;
    if (!apply) {
      return okV25({ verdict, applied: null });
    }
    const applied = applyJudgeDecisionV25(this.store.facts, candidate, verdict, {
      nowMs,
      by: opts.by ?? 'judge',
    });
    if (!applied.ok) return applied as unknown as V25Result<{ verdict: V25JudgeVerdict; applied: V25ApplyDecisionResult | null }>;
    this.store.recordJudge(
      makeJudgeLogEntryV25(candidate, verdict, true, applied.value.detail, source, nowMs),
    );
    return okV25({ verdict, applied: applied.value });
  }

  /** Judge mac dinh (rule judge, chay local). */
  private defaultJudge(): V25JudgeFn {
    return createRuleJudgeV25();
  }

  /** Trich fact ung vien tu text (khong ghi — chi de xem truoc). */
  previewExtraction(
    text: string,
    opts: { maxCandidates?: number } = {},
  ): V25Result<ReturnType<typeof extractCandidateFactsV25>> {
    if (!text || text.trim().length === 0) return errV25('text khong duoc rong.');
    return okV25(extractCandidateFactsV25(text, { maxCandidates: opts.maxCandidates ?? 20 }));
  }

  /** Fact dung tai thoi diem X (bi-temporal query). */
  queryFactsAt(
    at: string,
    filter: { subject?: string; predicate?: string; scope?: V25Scope } = {},
  ): V25Result<V25FactEdge[]> {
    return this.store.facts.queryAt(at, filter);
  }

  /** Fact hien tai (cua so con mo). */
  queryCurrentFacts(
    filter: { subject?: string; predicate?: string; scope?: V25Scope } = {},
  ): V25FactEdge[] {
    return this.store.facts.queryCurrent(filter);
  }

  /**
   * Tim kiem keyword + time-aware:
   *  - query text so voi subject/predicate/object (Jaccard token)
   *    va sourceText (substring).
   *  - neu co `at`: chi lay fact dung tai thoi diem do.
   *  - neu khong co `at`: chi lay fact hien tai.
   *  - kem ca shared block co label/description/value chua query.
   */
  search(
    query: string,
    opts: { topK?: number; at?: string; scope?: V25Scope; includeBlocks?: boolean } = {},
  ): V25Result<V25SearchHit[]> {
    const q = query.trim();
    if (!q) return errV25('query khong duoc rong.');
    const topK = Math.min(50, Math.max(1, opts.topK ?? 10));
    const queryTokens = tokenizeV25(q);
    let edges: V25FactEdge[];
    if (opts.at) {
      const res = this.store.facts.queryAt(opts.at, { ...(opts.scope ? { scope: opts.scope } : {}) });
      if (!res.ok) return res as unknown as V25Result<V25SearchHit[]>;
      edges = res.value;
    } else {
      edges = this.store.facts.queryCurrent({ ...(opts.scope ? { scope: opts.scope } : {}) });
    }
    const hits: V25SearchHit[] = [];
    for (const edge of edges) {
      const text = `${edge.subject} ${edge.predicate} ${edge.object}`;
      const sim = jaccardV25(queryTokens, tokenizeV25(text));
      const sub = text.toLowerCase().includes(q.toLowerCase()) ? 0.35 : 0;
      const score = sim + sub;
      if (score <= 0) continue;
      const scopeBonus = opts.scope && scopeMatchesV25(edge.scope, opts.scope) ? 0.05 : 0;
      hits.push({
        kind: 'fact',
        id: edge.id,
        text,
        score: score + scopeBonus,
        explanation: `keyword ${sim.toFixed(2)}${sub > 0 ? ' + substring' : ''} · valid ${edge.validAt ?? '...'} → ${edge.invalidAt ?? '...'} · ${edge.episodeId || 'no-episode'}`,
        edge,
      });
    }
    if (opts.includeBlocks !== false) {
      for (const block of this.store.blocks.list({ ...(opts.scope ? { scope: opts.scope } : {}) })) {
        const hay = `${block.label} ${block.description} ${block.value}`;
        const sim = jaccardV25(queryTokens, tokenizeV25(hay));
        const sub = hay.toLowerCase().includes(q.toLowerCase()) ? 0.35 : 0;
        const score = sim + sub;
        if (score <= 0) continue;
        hits.push({
          kind: 'block',
          id: block.id,
          text: `[block ${block.label}] ${truncateV25(block.value, 200)}`,
          score,
          explanation: `block ${block.label} (v${block.version}${block.readOnly ? ', read-only' : ''})`,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return okV25(hits.slice(0, topK));
  }

  /**
   * Snapshot de dua vao system prompt: shared block (render
   * <memory_blocks>) + fact hien tai, cat theo ngan sach ky tu.
   * Block chi render khi bot duoc doc.
   */
  snapshotForPrompt(opts: {
    budgetChars?: number;
    scope?: V25Scope;
    botId?: string;
  } = {}): V25PromptSnapshot {
    const budgetChars = opts.budgetChars ?? 8000;
    const botId = opts.botId ?? '';
    const scope = opts.scope;
    const facts = this.store.facts.queryCurrent({ ...(scope ? { scope } : {}) });
    const blocks = this.store.blocks.list({ ...(scope ? { scope } : {}) });
    const renderedBlocks = this.store.blocks.renderForPrompt(blocks, botId);
    const parts: string[] = [];
    let chars = 0;
    let truncated = false;
    const push = (text: string): boolean => {
      if (chars + text.length + 1 > budgetChars) {
        truncated = true;
        return false;
      }
      parts.push(text);
      chars += text.length + 1;
      return true;
    };
    if (renderedBlocks) push(renderedBlocks);
    const factLines: string[] = [];
    for (const edge of facts) {
      const line = `- ${edge.subject} ${edge.predicate} ${edge.object} (since ${edge.validAt ?? edge.createdAt})`;
      if (!push(line)) break;
      factLines.push(line);
    }
    const text = parts.join('\n');
    return {
      text,
      chars: text.length,
      budgetChars,
      facts: facts.slice(0, factLines.length),
      blocksRendered: renderedBlocks ? blocks.filter((b) => b.ownerBotId === botId || b.attachedBotIds.includes(botId)).length : 0,
      truncated,
    };
  }

  /** Export snapshot JSON (backup / chuyen may). */
  exportSnapshot(): string {
    return JSON.stringify(this.store.toJSON(), null, 2);
  }

  /** Import snapshot JSON — tra store moi (khong ghi de store hien tai). */
  static importSnapshot(json: string): V25Result<V25Store> {
    try {
      const parsed: unknown = JSON.parse(json);
      return V25Store.fromJSON(parsed);
    } catch (e) {
      return errV25(`Import snapshot that bai: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Tao id sleep pass — dung chung cho log. */
export function makeSleepPassIdV25(): string {
  return makeV25Id('pass');
}
