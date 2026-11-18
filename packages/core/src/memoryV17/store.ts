/**
 * Memory v17 — Store tong hop (v1.36, Doi T1).
 *
 * M17Store noi cac lop v17 lai thanh 1 pipeline duy nhat:
 *
 *   turn -> extractTurnsSinglePassM17 (ADD-only, 0..1 LLM call)
 *        -> detectConflictsM17 (so voi fact active cung scope)
 *        -> auto-resolve neu an toan, con lai vao M17ConflictQueue
 *        -> M17BiTemporalStore.addFact (fact moi, khong sua fact cu)
 *        -> M17EntityStore.linkFact (entity + typed edge)
 *        -> M17ScopeGuard guard moi lan doc (chan doc cheo scope)
 *
 * Nguyen tac bat bien:
 *  - Khong co duong nao sua/xoa fact cu ngoai resolver co provenance
 *    (invalidate / supersede / merge — deu giu lai dong cu).
 *  - Moi lan doc deu qua scope guard; doc cheo bi chan + ghi violation.
 *  - Moi fact deu co provenance (episode/turn/run) — khong fact mo coi.
 */

import {
  M17Error,
  M17Conflict,
  M17ExtractedFact,
  M17Fact,
  M17FusionHit,
  M17Resolution,
  M17ResolutionStrategy,
  M17Scope,
  M17_DEFAULT_SCOPE,
  validateScopeM17,
} from './types';
import {
  M17ExtractOptions,
  M17TurnInput,
  extractTurnsSinglePassM17,
} from './extraction';
import { M17EntityStore } from './entities';
import {
  M17ConflictDetectorOptions,
  M17ConflictQueue,
  autoResolveStrategyM17,
  detectConflictsM17,
  resolutionEffectM17,
} from './conflicts';
import {
  M17BiTemporalStore,
  M17FactTimelineStep,
  M17StateAtResult,
} from './biTemporal';
import { M17FusionSearchOptions, M17FusionSearchResult, fusionSearchM17 } from './fusion';
import { M17ScopeGuard, scanForScopeLeaksM17, M17LeakReport } from './scope';

/** Loi store v17. */
export class M17StoreError extends M17Error {
  constructor(message: string) {
    super(message);
    this.name = 'M17StoreError';
  }
}

/** Tuy chon store. */
export interface M17StoreOptions {
  /** Ten collection fact (de suy ra ten collection entity). */
  factCollection?: string;
  /** Tu dong resolve conflict an toan (mac dinh true). */
  autoResolve?: boolean;
  /** Tuy chon detector. */
  conflictOptions?: M17ConflictDetectorOptions;
  /** Gioi han fact / scope. */
  maxFactsPerScope?: number;
}

/** Ket qua ingest 1 batch turn. */
export interface M17IngestResult {
  /** So turn da xu ly. */
  turnsProcessed: number;
  /** So candidate trich duoc. */
  candidates: number;
  /** So fact moi da them. */
  factsAdded: number;
  /** So conflict phat hien. */
  conflictsFound: number;
  /** So conflict tu dong resolve. */
  autoResolved: number;
  /** So conflict dua vao hang doi. */
  queued: number;
  /** So duplicate (chi tang confidence). */
  duplicates: number;
  /** So entity moi tao. */
  entitiesCreated: number;
  /** So edge moi tao. */
  edgesCreated: number;
  /** So LLM call da dung. */
  llmCalls: number;
  /** Thoi gian ingest (ms). */
  elapsedMs: number;
}

/** Thong ke store. */
export interface M17StoreStats {
  facts: ReturnType<M17BiTemporalStore['stats']>;
  entities: number;
  edges: number;
  pendingConflicts: number;
  resolvedConflicts: number;
  scopeViolations: number;
  grants: number;
}

/** Store tong hop v17 (in-memory — host luu JSON bang serialize()). */
export class M17Store {
  readonly factCollection: string;
  readonly graph: M17BiTemporalStore;
  readonly entities: M17EntityStore;
  readonly conflicts: M17ConflictQueue;
  readonly guard: M17ScopeGuard;
  private readonly autoResolve: boolean;
  private readonly conflictOptions: M17ConflictDetectorOptions;

  constructor(options: M17StoreOptions = {}) {
    this.factCollection = options.factCollection ?? 'memory_v17';
    this.graph = new M17BiTemporalStore({ maxFactsPerScope: options.maxFactsPerScope });
    this.entities = new M17EntityStore({ factCollection: this.factCollection });
    this.conflicts = new M17ConflictQueue();
    this.guard = new M17ScopeGuard();
    this.autoResolve = options.autoResolve ?? true;
    this.conflictOptions = options.conflictOptions ?? {};
  }

  /**
   * Ingest 1 batch turn: extract single-pass -> detect conflict ->
   * auto-resolve / queue -> add fact -> link entity. Tra bao cao day du.
   */
  async ingestTurns(
    turns: M17TurnInput[],
    scope: M17Scope,
    options: M17ExtractOptions = {},
  ): Promise<M17IngestResult> {
    const started = Date.now();
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17StoreError(scopeError);
    if (!Array.isArray(turns) || turns.length === 0) {
      throw new M17StoreError('Ingest can it nhat 1 turn.');
    }
    const extraction = await extractTurnsSinglePassM17(turns, options);
    const nowIso = new Date().toISOString();
    let factsAdded = 0;
    let conflictsFound = 0;
    let autoResolved = 0;
    let queued = 0;
    let duplicates = 0;
    let entitiesCreated = 0;
    let edgesCreated = 0;
    const active = this.graph.listActive(scope, { limit: 500 }).facts;
    for (const candidate of extraction.candidates) {
      const found = detectConflictsM17(candidate, active, scope, nowIso);
      conflictsFound += found.length;
      const duplicate = found.find((c) => c.kind === 'duplicate');
      if (duplicate) {
        // Trung lap: tang confidence fact cu, khong tao fact moi.
        this.graph.bumpConfidence(duplicate.existingFactId, scope, 0.05);
        duplicates += 1;
        continue;
      }
      const realConflicts = found.filter((c) => c.kind !== 'duplicate');
      let blocked = false;
      for (const conflict of realConflicts) {
        const existing = this.graph.getFact(conflict.existingFactId);
        const strategy = this.autoResolve
          ? autoResolveStrategyM17(
              conflict,
              existing?.confidence ?? 0.5,
              candidate.confidence,
              this.conflictOptions,
            )
          : 'pending';
        if (strategy === 'pending') {
          if (this.conflicts.enqueue(conflict)) queued += 1;
          blocked = true;
        } else {
          await this.applyAutoResolution(conflict, strategy, candidate, scope, nowIso);
          autoResolved += 1;
          // Overwrite/merge da xu ly fact moi (tao fact moi hoac gop);
          // keep_both thi van them fact moi binh thuong o duoi.
          if (strategy === 'reject_incoming') blocked = true;
          if (strategy === 'merge') blocked = true;
          if (strategy === 'overwrite') {
            // Overwrite: supersede fact cu roi them fact moi o duoi.
            blocked = false;
          }
        }
      }
      if (blocked) continue;
      const fact = this.addFactDirect(candidate, scope, turns[0], nowIso);
      factsAdded += 1;
      // Overwrite: sau khi them fact moi, supersede fact cu.
      for (const conflict of realConflicts) {
        const resolution = this.conflicts.listResolutions().find(
          (r) => r.conflictId === conflict.id && r.strategy === 'overwrite',
        );
        if (resolution) {
          this.graph.supersedeFact(
            conflict.existingFactId,
            fact.id,
            scope,
            'Fact moi thay the fact cu (auto overwrite).',
            nowIso,
          );
        }
      }
      const link = this.entities.linkFact(fact, scope, nowIso, fact.id);
      if (link.createdSubject) entitiesCreated += 1;
      if (link.createdObject) entitiesCreated += 1;
      if (link.createdEdge) edgesCreated += 1;
    }
    return {
      turnsProcessed: turns.length,
      candidates: extraction.candidates.length,
      factsAdded,
      conflictsFound,
      autoResolved,
      queued,
      duplicates,
      entitiesCreated,
      edgesCreated,
      llmCalls: extraction.llmCalls,
      elapsedMs: Date.now() - started,
    };
  }

  /** Ap dung auto-resolution cho 1 conflict (chi overwrite/merge/keep_both/reject). */
  private async applyAutoResolution(
    conflict: M17Conflict,
    strategy: M17ResolutionStrategy,
    candidate: M17ExtractedFact,
    scope: M17Scope,
    nowIso: string,
  ): Promise<void> {
    const existing = this.graph.getFact(conflict.existingFactId);
    if (!existing) return;
    const effect = resolutionEffectM17(strategy, conflict, existing.object);
    if (strategy === 'merge' && effect.createMergedFact) {
      const mergedFact = this.addFactDirect(effect.createMergedFact, scope, null, nowIso);
      mergedFact.mergedFromIds = [existing.id];
      this.graph.markMerged(
        existing.id,
        mergedFact.id,
        scope,
        'Merge fact cu + fact moi (auto).',
        nowIso,
      );
      this.entities.linkFact(mergedFact, scope, nowIso, mergedFact.id);
      this.conflicts.recordAuto(
        conflict,
        strategy,
        'Auto merge: 2 gia tri gop thanh 1 fact.',
        nowIso,
      );
      return;
    }
    if (strategy === 'overwrite') {
      // Ghi resolution truoc; supersede thuc thi sau khi fact moi duoc tao
      // (can newFactId) — xem ingestTurns. O day chi ghi audit.
      this.conflicts.recordAuto(
        conflict,
        strategy,
        'Auto overwrite: fact cu confidence thap, fact moi manh hon.',
        nowIso,
      );
      return;
    }
    this.conflicts.recordAuto(conflict, strategy, `Auto ${strategy}.`, nowIso);
  }

  /** Them fact truc tiep (khong qua conflict detection — dung cho resolver / import). */
  addFactDirect(
    candidate: M17ExtractedFact,
    scope: M17Scope,
    turn: M17TurnInput | null,
    nowIso: string,
  ): M17Fact {
    return this.graph.addFact(candidate, scope, {
      provenance: {
        episodeId: turn?.episodeId ?? 'manual',
        turnId: turn?.turnId ?? 'manual',
        runId: 'm17',
        botId: scope.botId,
        userId: scope.userId,
        sourceText: candidate.sourceText,
        method: 'rule',
        extractor: 'm17-rule-v1',
      },
      learnedAt: nowIso,
    });
  }

  /**
   * Giai quyet 1 conflict dang cho (user duyet): ap dung strategy roi
   * them/loai fact moi tuong ung. Tra resolution + fact ket qua (neu co).
   */
  resolvePendingConflict(
    conflictId: string,
    strategy: M17ResolutionStrategy,
    decidedBy: string,
    reason: string,
    scope: M17Scope,
  ): { resolution: M17Resolution; resultingFact: M17Fact | null } {
    const nowIso = new Date().toISOString();
    const conflict = this.conflicts.getPending(conflictId);
    if (!conflict) throw new M17StoreError(`Khong tim thay conflict dang cho: ${conflictId}.`);
    const existing = this.graph.getFact(conflict.existingFactId);
    if (!existing) throw new M17StoreError(`Fact cu ${conflict.existingFactId} khong con ton tai.`);
    const effect = resolutionEffectM17(strategy, conflict, existing.object);
    let resultingFact: M17Fact | null = null;
    if (strategy === 'merge' && effect.createMergedFact) {
      resultingFact = this.addFactDirect(effect.createMergedFact, scope, null, nowIso);
      resultingFact.mergedFromIds = [existing.id];
      this.graph.markMerged(existing.id, resultingFact.id, scope, reason, nowIso);
      this.entities.linkFact(resultingFact, scope, nowIso, resultingFact.id);
    } else if (strategy === 'overwrite') {
      resultingFact = this.addFactDirect(conflict.incoming, scope, null, nowIso);
      this.graph.supersedeFact(existing.id, resultingFact.id, scope, reason, nowIso);
      this.entities.linkFact(resultingFact, scope, nowIso, resultingFact.id);
    } else if (strategy === 'reject_incoming') {
      // Tang confidence fact cu (user xac nhan fact cu dung).
      this.graph.bumpConfidence(existing.id, scope, 0.05);
    }
    // keep_both: them fact moi nhu fact doc lap.
    if (strategy === 'keep_both') {
      resultingFact = this.addFactDirect(conflict.incoming, scope, null, nowIso);
      this.entities.linkFact(resultingFact, scope, nowIso, resultingFact.id);
    }
    const resolution = this.conflicts.resolve(
      conflictId,
      strategy,
      decidedBy,
      reason,
      nowIso,
      resultingFact?.id ?? null,
      existing.id,
    );
    return { resolution, resultingFact };
  }

  /** Fusion search — chi tren fact doc duoc trong scope (qua guard). */
  search(
    query: string,
    scope: M17Scope,
    options: M17FusionSearchOptions = {},
  ): M17FusionSearchResult {
    const scopeError = validateScopeM17(scope);
    if (scopeError) throw new M17StoreError(scopeError);
    const nowIso = new Date().toISOString();
    const allFacts = this.graph.listActive(scope, { limit: 10000 }).facts;
    // Guard: loc lai lan nua (phong khi listActive doi behavior sau nay).
    const readable = allFacts.filter(
      (f) => this.guard.guardRead(f.scope, scope, 'search', nowIso).allowed,
    );
    return fusionSearchM17(query, readable, scope, options);
  }

  /** Fact dung tai thoi diem T (valid time). */
  stateAt(scope: M17Scope, atIso: string): M17StateAtResult {
    return this.graph.factsValidAt(scope, atIso);
  }

  /** He thong biet gi tai thoi diem T (transaction time). */
  asKnownAt(scope: M17Scope, atIso: string): M17StateAtResult {
    return this.graph.factsAsKnownAt(scope, atIso);
  }

  /** Timeline cua 1 fact. */
  factTimeline(id: string, scope: M17Scope): M17FactTimelineStep[] {
    this.graph.getFactInScope(id, scope);
    return this.graph.factTimeline(id, scope);
  }

  /** Invalidate fact (user bao fact sai) — giu dong, chi doi status. */
  invalidateFact(id: string, scope: M17Scope, reason: string): M17Fact {
    return this.graph.invalidateFact(id, scope, reason, new Date().toISOString()).fact;
  }

  /** Quet leak scope toan store. */
  scanLeaks(): M17LeakReport {
    const { facts } = this.graph.serialize();
    const { entities, edges } = this.entities.serialize();
    return scanForScopeLeaksM17(facts, entities, edges, this.guard);
  }

  /** Thong ke store. */
  stats(scope: M17Scope): M17StoreStats {
    return {
      facts: this.graph.stats(scope),
      entities: this.entities.listEntities(scope, { limit: 1 }).total,
      edges: this.entities
        .serialize()
        .edges.filter((e) => e.scope.tenantId === scope.tenantId && e.scope.userId === scope.userId && e.scope.botId === scope.botId && e.scope.conversationId === scope.conversationId).length,
      pendingConflicts: this.conflicts.pendingCount,
      resolvedConflicts: this.conflicts.resolvedCount,
      scopeViolations: this.guard.violationCount,
      grants: this.guard.grantCount,
    };
  }

  /** Serialize toan bo store (de host luu file). */
  serialize(): {
    factCollection: string;
    graph: ReturnType<M17BiTemporalStore['serialize']>;
    entities: ReturnType<M17EntityStore['serialize']>;
    conflicts: ReturnType<M17ConflictQueue['serialize']>;
    guard: ReturnType<M17ScopeGuard['serialize']>;
  } {
    return {
      factCollection: this.factCollection,
      graph: this.graph.serialize(),
      entities: this.entities.serialize(),
      conflicts: this.conflicts.serialize(),
      guard: this.guard.serialize(),
    };
  }

  /** Khoi phuc tu JSON. */
  deserialize(data: {
    factCollection?: string;
    graph?: Parameters<M17BiTemporalStore['deserialize']>[0];
    entities?: Parameters<M17EntityStore['deserialize']>[0];
    conflicts?: Parameters<M17ConflictQueue['deserialize']>[0];
    guard?: Parameters<M17ScopeGuard['deserialize']>[0];
  }): void {
    if (data.graph) this.graph.deserialize(data.graph);
    if (data.entities) this.entities.deserialize(data.entities);
    if (data.conflicts) this.conflicts.deserialize(data.conflicts);
    if (data.guard) this.guard.deserialize(data.guard);
  }
}

/** Scope mac dinh cho single-user local (tien ich cho tool / test). */
export const M17_LOCAL_SCOPE: M17Scope = { ...M17_DEFAULT_SCOPE };

/** Tao store moi voi scope mac dinh (tien ich). */
export function createM17Store(options: M17StoreOptions = {}): M17Store {
  return new M17Store(options);
}
