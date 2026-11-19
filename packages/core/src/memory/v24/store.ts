/**
 * Memory v24 — store (v1.39, Doi T1).
 *
 * Store trung tam cua memory v24: facts (ADD-only) + lessons
 * (evidence bat buoc) + MemFS tree + shared blocks + admission
 * log + conflict/resolution log. Chay local, persist ra disk
 * dang JSON + thu muc MemFS.
 *
 * Nguyen tac:
 *  - ADD-only: putFact CHI them fact moi; khong bao gio sua
 *    fact cu truc tiep. Moi thay doi di qua resolver
 *    (applyResolution) — fact cu chi doi status (superseded /
 *    merged / invalidated / archived), khong bao gio xoa.
 *  - Scope: moi fact/lesson/block mang scope; query loc dung
 *    scope (khop chinh xac hoac scope cha — run < agent <
 *    user < app).
 *  - Persistence: save(dir) ghi memory-v24.json (facts,
 *    lessons, conflicts, resolutions, admission log, blocks)
 *    + memfs/ (cay Markdown). load(dir) doc lai day du.
 *  - Health: bao van de (lesson thieu evidence, conflict mo,
 *    MemFS link do, admission deny nhieu, coverage thap).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { V24AdmissionPolicy } from './admission';
import {
  createLessonV24,
  lessonHasValidEvidenceV24,
  type V24NewLessonInput,
} from './evidence';
import { V24MemFS } from './memfs';
import { loadMemfsFromDirV24, saveMemfsToDirV24 } from './memfsGraph';
import { V24SharedBlockStore } from './sharedBlocks';
import {
  clamp01V24,
  isoAtV24,
  makeV24Id,
  parseIsoV24,
  scopeLevelV24,
  type V24Conflict,
  type V24ExtractedFact,
  type V24Fact,
  type V24FactStatus,
  type V24HealthIssue,
  type V24Lesson,
  type V24Provenance,
  type V24RecordKind,
  type V24Resolution,
  type V24ResolutionStrategy,
  type V24Scope,
  type V24Stats,
  V24_MAX_FACTS_PER_SCOPE,
  V24_MAX_LESSONS_PER_SCOPE,
} from './types';
import { decideResolutionV24, detectConflictsV24 } from './conflicts';

/** Ket qua thao tac store (khong throw). */
export interface V24StoreResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function ok<T>(value: T): V24StoreResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): V24StoreResult<T> {
  return { ok: false, error };
}

/** Ten file store tren disk. */
export const V24_STORE_FILE = 'memory-v24.json';
export const V24_MEMFS_DIRNAME = 'memfs';

/** Scope cua record co thay trong scope query khong (khop chinh xac hoac scope cha). */
export function scopeVisibleV24(recordScope: V24Scope, queryScope: V24Scope): boolean {
  // Record app-wide (tat ca rong) thay o moi noi.
  if (!recordScope.userId && !recordScope.agentId && !recordScope.runId && !recordScope.appId) return true;
  // Query rong -> thay tat ca (dung cho admin/stats).
  if (!queryScope.userId && !queryScope.agentId && !queryScope.runId && !queryScope.appId) return true;
  if (recordScope.appId && queryScope.appId && recordScope.appId !== queryScope.appId) return false;
  if (recordScope.userId && queryScope.userId && recordScope.userId !== queryScope.userId) return false;
  if (recordScope.agentId && queryScope.agentId && recordScope.agentId !== queryScope.agentId) return false;
  if (recordScope.runId && queryScope.runId && recordScope.runId !== queryScope.runId) return false;
  return true;
}

export class V24Store {
  readonly memfs: V24MemFS;
  readonly blocks: V24SharedBlockStore;
  readonly admission: V24AdmissionPolicy;
  private facts = new Map<string, V24Fact>();
  private lessons = new Map<string, V24Lesson>();
  private conflicts: V24Conflict[] = [];
  private resolutions: V24Resolution[] = [];
  private readonly now: () => number;

  constructor(opts: { now?: () => number; memfs?: V24MemFS; blocks?: V24SharedBlockStore } = {}) {
    this.now = opts.now ?? Date.now;
    this.memfs = opts.memfs ?? new V24MemFS({ now: this.now });
    this.blocks = opts.blocks ?? new V24SharedBlockStore({ now: this.now });
    this.admission = new V24AdmissionPolicy({}, { now: this.now });
  }

  /** File mac dinh cua store trong workspace dir. */
  static defaultFilePath(workspaceDir: string): string {
    return path.join(workspaceDir, V24_STORE_FILE);
  }

  // --- Facts (ADD-only) ---

  getFact(id: string): V24Fact | null {
    const f = this.facts.get(id);
    return f ? { ...f, mergedFromIds: [...f.mergedFromIds], evidenceIds: [...f.evidenceIds] } : null;
  }

  listFacts(opts: {
    scope?: V24Scope;
    status?: V24FactStatus;
    kind?: V24RecordKind;
    limit?: number;
  } = {}): V24Fact[] {
    const out: V24Fact[] = [];
    for (const f of this.facts.values()) {
      if (opts.scope && !scopeVisibleV24(f.scope, opts.scope)) continue;
      if (opts.status && f.status !== opts.status) continue;
      if (opts.kind && f.kind !== opts.kind) continue;
      out.push({ ...f, mergedFromIds: [...f.mergedFromIds], evidenceIds: [...f.evidenceIds] });
    }
    out.sort((a, b) => b.learnedAt.localeCompare(a.learnedAt));
    return opts.limit !== undefined ? out.slice(0, Math.max(0, opts.limit)) : out;
  }

  activeFacts(scope?: V24Scope): V24Fact[] {
    return this.listFacts({ ...(scope ? { scope } : {}), status: 'active' });
  }

  /** Them fact moi (ADD-only). Khong kiem tra conflict o day — pipeline lam. */
  putFact(
    candidate: V24ExtractedFact,
    opts: {
      scope: V24Scope;
      provenance: Omit<V24Provenance, 'at'>;
      expiresAt?: string | null;
      importance?: number;
      evidenceIds?: string[];
    },
  ): V24StoreResult<V24Fact> {
    const scopeCount = [...this.facts.values()].filter(
      (f) => f.scope.userId === opts.scope.userId && f.scope.agentId === opts.scope.agentId,
    ).length;
    if (scopeCount >= V24_MAX_FACTS_PER_SCOPE) {
      return fail(`Scope da dat gioi han ${V24_MAX_FACTS_PER_SCOPE} fact.`);
    }
    const nowIso = isoAtV24(this.now());
    const fact: V24Fact = {
      id: makeV24Id('f24'),
      subject: candidate.subject,
      edge: candidate.edge,
      object: candidate.object,
      kind: candidate.kind,
      validFrom: candidate.validFrom,
      validTo: candidate.validTo,
      learnedAt: nowIso,
      invalidatedAt: null,
      invalidReason: null,
      supersedesId: null,
      supersededById: null,
      mergedFromIds: [],
      confidence: clamp01V24(candidate.confidence),
      importance: clamp01V24(opts.importance ?? 0.5),
      lastAccessedAt: null,
      accessCount: 0,
      expiresAt: opts.expiresAt ?? null,
      status: 'active',
      scope: { ...opts.scope },
      provenance: { ...opts.provenance, at: nowIso, embeddingKind: 'hash' },
      evidenceIds: [...(opts.evidenceIds ?? [])],
      note: candidate.reason,
    };
    this.facts.set(fact.id, fact);
    return ok({ ...fact });
  }

  /** Phat hien conflict cua candidate voi fact active trong scope. */
  detectConflicts(candidate: V24ExtractedFact, scope: V24Scope): V24Conflict[] {
    const found = detectConflictsV24(candidate, this.activeFacts(scope), scope, { nowMs: this.now() });
    this.conflicts.push(...found);
    return found;
  }

  /** Ap dung resolution: tao fact moi / doi status fact cu theo strategy. */
  applyResolution(
    conflict: V24Conflict,
    strategy: V24ResolutionStrategy,
    opts: {
      scope: V24Scope;
      provenance: Omit<V24Provenance, 'at'>;
      decidedBy?: string;
      reason?: string;
    },
  ): V24StoreResult<{ resolution: V24Resolution; resultingFactId: string | null }> {
    const existing = this.facts.get(conflict.existingFactId);
    if (!existing) return fail(`Khong co fact cu ${conflict.existingFactId} de resolve.`);
    const nowIso = isoAtV24(this.now());
    const decided = opts.reason ?? decideResolutionV24(conflict, existing).reason;
    let resultingFactId: string | null = null;

    if (strategy === 'reject_incoming') {
      const resolution: V24Resolution = {
        conflictId: conflict.id,
        strategy,
        decidedBy: opts.decidedBy ?? 'auto',
        reason: decided,
        decidedAt: nowIso,
        resultingFactId: null,
        affectedFactId: existing.id,
        resultingValidFrom: conflict.incoming.validFrom,
        resultingValidTo: conflict.incoming.validTo,
        evidenceIds: [],
      };
      this.resolutions.push(resolution);
      return ok({ resolution, resultingFactId });
    }

    if (strategy === 'keep_both') {
      const put = this.putFact(conflict.incoming, {
        scope: opts.scope,
        provenance: opts.provenance,
        expiresAt: null,
      });
      if (!put.ok || !put.value) return fail(put.error ?? 'keep_both: put fact that bai.');
      resultingFactId = put.value.id;
      const resolution: V24Resolution = {
        conflictId: conflict.id,
        strategy,
        decidedBy: opts.decidedBy ?? 'auto',
        reason: decided,
        decidedAt: nowIso,
        resultingFactId,
        affectedFactId: existing.id,
        resultingValidFrom: conflict.incoming.validFrom,
        resultingValidTo: conflict.incoming.validTo,
        evidenceIds: [],
      };
      this.resolutions.push(resolution);
      return ok({ resolution, resultingFactId });
    }

    if (strategy === 'supersede') {
      const put = this.putFact(conflict.incoming, {
        scope: opts.scope,
        provenance: opts.provenance,
        expiresAt: null,
      });
      if (!put.ok || !put.value) return fail(put.error ?? 'supersede: put fact that bai.');
      resultingFactId = put.value.id;
      const newFact = this.facts.get(resultingFactId)!;
      newFact.supersedesId = existing.id;
      existing.status = 'superseded';
      existing.supersededById = resultingFactId;
      existing.invalidatedAt = nowIso;
      existing.invalidReason = `Superseded by ${resultingFactId}: ${decided}`;
      if (conflict.incoming.validFrom) {
        existing.validTo = conflict.incoming.validFrom;
      }
      const resolution: V24Resolution = {
        conflictId: conflict.id,
        strategy,
        decidedBy: opts.decidedBy ?? 'auto',
        reason: decided,
        decidedAt: nowIso,
        resultingFactId,
        affectedFactId: existing.id,
        resultingValidFrom: conflict.incoming.validFrom,
        resultingValidTo: conflict.incoming.validTo,
        evidenceIds: [],
      };
      this.resolutions.push(resolution);
      return ok({ resolution, resultingFactId });
    }

    if (strategy === 'merge') {
      const mergedObject = existing.object === conflict.incoming.object
        ? existing.object
        : `${existing.object} / ${conflict.incoming.object}`;
      const merged: V24ExtractedFact = {
        ...conflict.incoming,
        object: mergedObject,
        confidence: clamp01V24(Math.max(existing.confidence, conflict.incoming.confidence)),
        reason: `${conflict.incoming.reason} + merged with ${existing.id}`,
      };
      const put = this.putFact(merged, {
        scope: opts.scope,
        provenance: { ...opts.provenance, method: 'merge' },
        expiresAt: null,
      });
      if (!put.ok || !put.value) return fail(put.error ?? 'merge: put fact that bai.');
      resultingFactId = put.value.id;
      const newFact = this.facts.get(resultingFactId)!;
      newFact.mergedFromIds = [existing.id];
      existing.status = 'merged';
      existing.invalidatedAt = nowIso;
      existing.invalidReason = `Merged into ${resultingFactId}.`;
      const resolution: V24Resolution = {
        conflictId: conflict.id,
        strategy,
        decidedBy: opts.decidedBy ?? 'auto',
        reason: decided,
        decidedAt: nowIso,
        resultingFactId,
        affectedFactId: existing.id,
        resultingValidFrom: conflict.incoming.validFrom,
        resultingValidTo: conflict.incoming.validTo,
        evidenceIds: [],
      };
      this.resolutions.push(resolution);
      return ok({ resolution, resultingFactId });
    }

    // quarantine_both
    existing.status = 'quarantined';
    existing.invalidReason = `Quarantined with incoming (conflict ${conflict.id}): ${decided}`;
    const resolution: V24Resolution = {
      conflictId: conflict.id,
      strategy,
      decidedBy: opts.decidedBy ?? 'auto',
      reason: decided,
      decidedAt: nowIso,
      resultingFactId: null,
      affectedFactId: existing.id,
      resultingValidFrom: conflict.incoming.validFrom,
      resultingValidTo: conflict.incoming.validTo,
      evidenceIds: [],
    };
    this.resolutions.push(resolution);
    return ok({ resolution, resultingFactId });
  }

  /** Danh sach conflict (moi nhat truoc). */
  listConflicts(opts: { openOnly?: boolean; limit?: number } = {}): V24Conflict[] {
    const resolved = new Set(this.resolutions.map((r) => r.conflictId));
    let out = [...this.conflicts].reverse();
    if (opts.openOnly) out = out.filter((c) => !resolved.has(c.id));
    return opts.limit !== undefined ? out.slice(0, Math.max(0, opts.limit)) : out;
  }

  listResolutions(opts: { limit?: number } = {}): V24Resolution[] {
    const out = [...this.resolutions].reverse();
    return opts.limit !== undefined ? out.slice(0, Math.max(0, opts.limit)) : out;
  }
}
