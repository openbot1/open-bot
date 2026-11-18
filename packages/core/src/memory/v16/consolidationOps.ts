/**
 * Memory v16 — Mem0-style consolidation 4 thao tac (v1.17, Doi T1).
 *
 * Y tuong hoc tu Mem0 v3 (04/2026: pipeline 2 buoc extraction roi
 * consolidation; consolidation quyet dinh theo TUNG fact: add /
 * update / delete / drop) — tu thiet ke lai hoan toan cho open-bot,
 * chay 100% local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Khac biet co y thuc so voi v15: v15 chi ADD o write-time va giai
 * quyet mau thuan o retrieval-time; v16 quyet dinh NGAY o write-time
 * nhung van giu lich su day du nho co che supersede/delete-mem cua
 * TemporalGraphStore (ban cu thanh `superseded`/`deleted`, khong
 * mat). Bon thao tac:
 *
 *  - ADD: fact moi, chua co fact nao cung (subject, predicate) —
 *    hoac predicate da tri va object moi khong mau thuan — ghi moi.
 *  - UPDATE: predicate don tri (vd lives_in, works_at) da co fact
 *    active voi object khac -> `supersedeFact` (ban cu dong cua so
 *    hieu luc, noi `supersededBy` sang ban moi, lich su van truy van
 *    duoc "truoc day o dau").
 *  - DELETE: y dinh retract (nguoi dung noi "quen X di" / "X khong
 *    con dung nua") hoac fact ung vien noi fact cu da sai -> xoa mem
 *    fact cu (`deleteFact`), khong tao fact moi.
 *  - DROP: trung lap chinh xac (cung subject+predicate+object dang
 *    active), noise (text qua ngan / khong co nghia), hoac confidence
 *    hieu dung duoi nguong — khong ghi gi, chi ghi audit.
 *
 * Quyet dinh duoc ghi audit JSONL (ai/quyet dinh gi/vi sao) de UI
 * va sleep agent xem lai; `applyConsolidationV16` ho tro dry-run
 * (tinh quyet dinh ma khong ghi) va batch (nhieu ung vien mot lan).
 * Entity linking duoc cam thang: moi ung vien di qua
 * `V16EntityLinker.resolve` truoc khi so sanh voi fact cu, de
 * "Ha Noi" va "Ha Noi" khong bi tinh la hai subject khac nhau.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FactProvenance, GraphFact, MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { isSingleValuedPredicateV14 } from '../v14/extraction';
import type { V15ExtractedFact } from '../../memoryV15/consolidation';
import { V16EntityLinker } from './entityLinking';

/** Ung vien fact v16: ung vien v15 + context episode (de ghi provenance). */
export interface V16CandidateFact extends V15ExtractedFact {
  episodeId?: string;
  turnId?: string;
  runId?: string;
  botId?: string;
  userId?: string;
  /** Thoi diem turn (ISO). */
  at?: string;
  /** Ten nguon (vd 'user-chat', 'web-scrape'). */
  sourceName?: string;
}

/** Loi consolidation v16 — message tieng Viet. */
export class V16ConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V16ConsolidationError';
  }
}

/** Bon thao tac consolidation kieu Mem0 (them QUARANTINE/REJECT cua gate). */
export type V16ConsolidationOp = 'add' | 'update' | 'delete' | 'drop';

/** Ket qua quyet dinh cho mot ung vien (chua ap dung). */
export interface V16OpDecision {
  op: V16ConsolidationOp;
  candidate: V16CandidateFact;
  /** Fact cu bi anh huong (khi update/delete). */
  affectedFact?: GraphFact;
  /** Fact trung lap chinh xac (khi drop vi trung). */
  duplicateOf?: GraphFact;
  /** Ly do bang tieng Viet (de UI/audit hien thi). */
  reason: string;
  /** Diem tin cay hieu dung da dung de quyet dinh. */
  effectiveConfidence: number;
}

/** Ket qua ap dung mot quyet dinh (da ghi vao store). */
export interface V16AppliedOp extends V16OpDecision {
  /** Id fact moi tao (add/update) hoac fact da xoa (delete). */
  factId: string | null;
  /** Id fact cu bi supersede (update) hoac bi xoa (delete). */
  affectedFactId: string | null;
}

/** Tuy chon consolidation. */
export interface V16ConsolidateOptions {
  /** Confidence hieu dung toi thieu de ghi (mac dinh 0.3). */
  minConfidence?: number;
  /** Do dai object toi thieu (mac dinh 2 ky tu) — ngan hon la noise. */
  minObjectChars?: number;
  /** Actor ghi audit (mac dinh 'system'). */
  actor?: string;
  /** Thoi diem ap dung (mac dinh: bay gio). */
  now?: Date;
  /** Linker rieng (mac dinh: tao moi tren store). */
  linker?: V16EntityLinker;
  /** Chi tinh quyet dinh, khong ghi vao store. */
  dryRun?: boolean;
  /** Callback sau moi op da ap dung (de sleep agent dem). */
  onApplied?: (applied: V16AppliedOp) => void;
}

/** Bao cao mot lan chay batch consolidation. */
export interface V16ConsolidationReport {
  total: number;
  added: number;
  updated: number;
  deleted: number;
  dropped: number;
  /** Id cac fact moi tao. */
  addedFactIds: string[];
  /** Id cac fact cu bi supersede. */
  supersededFactIds: string[];
  /** Id cac fact bi xoa mem. */
  deletedFactIds: string[];
  /** Ly do drop pho bien (de UI tom tat). */
  dropReasons: Record<string, number>;
  startedAt: string;
  finishedAt: string;
  /** Thoi gian chay (ms). */
  durationMs: number;
}

/** Duong dan file audit consolidation v16 (tuong doi workspace). */
export const V16_CONSOLIDATION_AUDIT_REL_PATH = path.join(
  '.open-bot',
  'memory-v16-consolidation-audit.jsonl',
);
/** So dong audit toi da giu khi doc. */
export const V16_MAX_AUDIT_LINES = 1000;

/** Mot dong audit consolidation. */
export interface V16ConsolidationAuditEntry {
  at: string;
  actor: string;
  op: V16ConsolidationOp;
  subject: string;
  predicate: string;
  objectText: string;
  confidence: number;
  factId: string | null;
  affectedFactId: string | null;
  reason: string;
  dryRun: boolean;
}

export const V16_DEFAULT_MIN_CONFIDENCE = 0.3;
export const V16_DEFAULT_MIN_OBJECT_CHARS = 2;

/** Clamp 0..1 (giong cac module memory truoc, tu dinh nghia de doc lap). */
export function clamp01V16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Quyet dinh thao tac cho mot ung vien, KHONG ghi vao store.
 * Thu tu uu tien: retract -> delete; noise/thieu tin cay -> drop;
 * trung lap chinh xac -> drop; predicate don tri + object khac ->
 * update; con lai -> add.
 */
export function decideOpV16(
  store: TemporalGraphStore,
  candidate: V16CandidateFact,
  scope: MemoryScope,
  opts: { minConfidence?: number; minObjectChars?: number; linker?: V16EntityLinker } = {},
): V16OpDecision {
  const minConfidence = opts.minConfidence ?? V16_DEFAULT_MIN_CONFIDENCE;
  const minObjectChars = opts.minObjectChars ?? V16_DEFAULT_MIN_OBJECT_CHARS;
  const effective = clamp01V16(candidate.effectiveConfidence);
  const subject = (candidate.subject ?? '').trim();
  const predicate = normalizeGraphText(candidate.predicate ?? '').replace(/\s+/g, '_');
  const objectText = (candidate.objectText ?? '').trim();

  const drop = (reason: string): V16OpDecision => ({
    op: 'drop',
    candidate,
    reason,
    effectiveConfidence: effective,
  });

  if (subject === '' || predicate === '' || objectText === '') {
    return drop('Ung vien thieu subject, predicate hoac object — khong the ghi fact.');
  }
  if (candidate.intent === 'retract') {
    const existing = store.findActiveFacts(subject, predicate, scope);
    // Chi retract khi khop CHINH XAC object — khong duoc xoa fact
    // khac object cung (subject, predicate) (loi tung co: fallback
    // ve existing[0] lam mat fact khong lien quan).
    const target = existing.find(
      (f) => normalizeGraphText(f.objectText ?? '') === normalizeGraphText(objectText),
    );
    if (!target) {
      return drop(`Khong tim thay fact "${subject} ${predicate} ${objectText}" de retract.`);
    }
    return {
      op: 'delete',
      candidate,
      affectedFact: target,
      reason: `Nguoi dung retract fact "${subject} ${predicate} ${objectText}".`,
      effectiveConfidence: effective,
    };
  }
  if (objectText.length < minObjectChars) {
    return drop(`Object qua ngan (${objectText.length} ky tu) — coi la noise.`);
  }
  if (effective < minConfidence) {
    return drop(
      `Confidence hieu dung ${effective.toFixed(2)} duoi nguong ${minConfidence.toFixed(2)}.`,
    );
  }

  const linker = opts.linker;
  const resolvedSubject = linker ? linker.resolve(subject).entity.name : subject;
  const existing = store.findActiveFacts(resolvedSubject, predicate, scope);
  const normObject = normalizeGraphText(objectText);
  const duplicate = existing.find(
    (f) => normalizeGraphText(f.objectText ?? '') === normObject,
  );
  if (duplicate) {
    return {
      op: 'drop',
      candidate,
      duplicateOf: duplicate,
      reason: `Fact da ton tai (trung lap chinh xac voi fact ${duplicate.id.slice(0, 8)}).`,
      effectiveConfidence: effective,
    };
  }
  if (isSingleValuedPredicateV14(predicate)) {
    const conflicting = existing[0];
    if (conflicting) {
      return {
        op: 'update',
        candidate,
        affectedFact: conflicting,
        reason:
          `Predicate don tri "${predicate}": gia tri cu "${conflicting.objectText}" ` +
          `duoc thay bang "${objectText}" (ban cu thanh superseded).`,
        effectiveConfidence: effective,
      };
    }
  }
  return {
    op: 'add',
    candidate,
    reason: `Fact moi "${resolvedSubject} ${predicate} ${objectText}".`,
    effectiveConfidence: effective,
  };
}

/** Quyet dinh thao tac cho nhieu ung vien (giu nguyen thu tu). */
export function decideOpsV16(
  store: TemporalGraphStore,
  candidates: V16CandidateFact[],
  scope: MemoryScope,
  opts: { minConfidence?: number; minObjectChars?: number; linker?: V16EntityLinker } = {},
): V16OpDecision[] {
  const linker = opts.linker ?? new V16EntityLinker(store);
  return candidates.map((c) => decideOpV16(store, c, scope, { ...opts, linker }));
}

/** Ghi mot dong audit (append-only, tao thu muc neu chua co). */
export function appendV16ConsolidationAudit(
  workspaceDir: string,
  entry: V16ConsolidationAuditEntry,
): void {
  try {
    const filePath = path.join(workspaceDir, V16_CONSOLIDATION_AUDIT_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Audit la best-effort: khong bao gio lam hong consolidation.
  }
}

/** Doc audit consolidation (moi nhat cuoi, gioi han so dong). */
export function readV16ConsolidationAudit(
  workspaceDir: string,
  limit = 50,
): V16ConsolidationAuditEntry[] {
  try {
    const filePath = path.join(workspaceDir, V16_CONSOLIDATION_AUDIT_REL_PATH);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const parsed: V16ConsolidationAuditEntry[] = [];
    for (const line of lines.slice(-Math.max(0, limit))) {
      try {
        parsed.push(JSON.parse(line) as V16ConsolidationAuditEntry);
      } catch {
        // Bo dong hong, giu cac dong tot.
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

function buildProvenanceV16(
  candidate: V16CandidateFact,
  scope: MemoryScope,
  nowIso: string,
): FactProvenance {
  return {
    episodeId: candidate.episodeId ?? '',
    turnId: candidate.turnId ?? '',
    runId: candidate.runId ?? scope.runId,
    botId: candidate.botId ?? scope.botId,
    userId: candidate.userId ?? scope.userId,
    at: candidate.at ?? nowIso,
    sourceText: candidate.sourceText ?? '',
  };
}

/**
 * Ap dung mot quyet dinh da tinh (ghi vao store, tru khi dry-run).
 * ADD/UPDATE dung `validFrom`/`validUntil` tu ung vien (goi y thoi
 * gian cua v14/v15) neu co; UPDATE giu nguyen `validFrom` moi cua
 * ung vien lam moc supersede (xem store.supersedeFact).
 */
export function applyOpV16(
  store: TemporalGraphStore,
  decision: V16OpDecision,
  scope: MemoryScope,
  opts: { actor?: string; now?: Date; dryRun?: boolean; linker?: V16EntityLinker } = {},
): V16AppliedOp {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = opts.actor ?? 'system';
  const dryRun = opts.dryRun === true;
  const base: V16AppliedOp = {
    ...decision,
    factId: null,
    affectedFactId: decision.affectedFact?.id ?? null,
  };
  if (dryRun) return base;

  const candidate = decision.candidate;
  const linker = opts.linker;
  const subjectName = linker
    ? linker.resolve(candidate.subject).entity.name
    : candidate.subject;

  if (decision.op === 'drop') return base;

  if (decision.op === 'delete') {
    const target = decision.affectedFact;
    if (!target) return base;
    const deleted = store.deleteFact(target.id, actor);
    return { ...base, factId: deleted.id, affectedFactId: deleted.id };
  }

  const provenance = buildProvenanceV16(candidate, scope, nowIso);
  const input = {
    subjectName,
    predicate: candidate.predicate,
    objectText: candidate.objectText,
    objectIsEntity: false,
    confidence: decision.effectiveConfidence,
    scope: { ...scope },
    provenance,
    ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
    ...(candidate.validUntil !== undefined ? { validUntil: candidate.validUntil } : {}),
  };

  if (decision.op === 'update') {
    const oldFact = decision.affectedFact;
    if (!oldFact) return base;
    const created = store.supersedeFact(oldFact.id, {
      ...input,
      validFrom: candidate.validFrom ?? nowIso,
    });
    return { ...base, factId: created.id, affectedFactId: oldFact.id };
  }

  const created = store.addFact(input);
  return { ...base, factId: created.id };
}

/**
 * Consolidation batch: quyet dinh + ap dung cho nhieu ung vien.
 * Moi ung vien duoc quyet dinh tren store SAU KHI cac ung vien truoc
 * da ap dung (nen hai ung vien trung nhau trong cung batch: cai sau
 * thay cai truoc thanh drop-trung-lap hoac update — khong ghi doi).
 * Tra ve bao cao tong hop; khong throw khi mot ung vien loi — ghi
 * vao dropReasons va tiep tuc (fail-open theo kieu sleep agent).
 */
export function applyConsolidationV16(
  store: TemporalGraphStore,
  candidates: V16CandidateFact[],
  scope: MemoryScope,
  opts: V16ConsolidateOptions = {},
): V16ConsolidationReport {
  const started = opts.now ?? new Date();
  const startedAt = started.toISOString();
  const linker = opts.linker ?? new V16EntityLinker(store);
  const report: V16ConsolidationReport = {
    total: candidates.length,
    added: 0,
    updated: 0,
    deleted: 0,
    dropped: 0,
    addedFactIds: [],
    supersededFactIds: [],
    deletedFactIds: [],
    dropReasons: {},
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
  };
  const actor = opts.actor ?? 'system';
  const dryRun = opts.dryRun === true;

  for (const candidate of candidates) {
    let decision: V16OpDecision;
    try {
      decision = decideOpV16(store, candidate, scope, {
        minConfidence: opts.minConfidence,
        minObjectChars: opts.minObjectChars,
        linker,
      });
    } catch (err) {
      report.dropped += 1;
      const reason = `Loi khi quyet dinh: ${err instanceof Error ? err.message : String(err)}`;
      report.dropReasons[reason] = (report.dropReasons[reason] ?? 0) + 1;
      continue;
    }
    let applied: V16AppliedOp;
    try {
      applied = applyOpV16(store, decision, scope, { actor, now: started, dryRun, linker });
    } catch (err) {
      report.dropped += 1;
      const reason = `Loi khi ap dung ${decision.op}: ${err instanceof Error ? err.message : String(err)}`;
      report.dropReasons[reason] = (report.dropReasons[reason] ?? 0) + 1;
      continue;
    }
    if (applied.op === 'add') {
      report.added += 1;
      if (applied.factId) report.addedFactIds.push(applied.factId);
    } else if (applied.op === 'update') {
      report.updated += 1;
      if (applied.factId) report.addedFactIds.push(applied.factId);
      if (applied.affectedFactId) report.supersededFactIds.push(applied.affectedFactId);
    } else if (applied.op === 'delete') {
      report.deleted += 1;
      if (applied.factId) report.deletedFactIds.push(applied.factId);
    } else {
      report.dropped += 1;
      const key = applied.reason.length > 120 ? `${applied.reason.slice(0, 120)}…` : applied.reason;
      report.dropReasons[key] = (report.dropReasons[key] ?? 0) + 1;
    }
    opts.onApplied?.(applied);
  }

  const finished = new Date();
  report.finishedAt = finished.toISOString();
  report.durationMs = Math.max(0, finished.getTime() - started.getTime());
  return report;
}
