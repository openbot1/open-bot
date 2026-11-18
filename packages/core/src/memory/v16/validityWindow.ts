/**
 * Memory v16 — Validity window v2 (v1.17, Doi T1).
 *
 * Y tuong hoc tu Zep/Graphiti (temporal knowledge graph: fact co
 * validity window, supersession link, theo doi fact thay doi theo
 * thoi gian) — tu thiet ke lai hoan toan cho open-bot, chay 100%
 * local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `isFactValidAt` cua graph/types.ts: predicate goc kiem tra mot
 *    fact co hieu luc tai T khong; v16 goi lai nguyen ven.
 *  - `parseValidityHint` / `validityReport` / `sweepExpiredFacts`
 *    cua graph/validity.ts: goi y cua so tu text, bao cao het han,
 *    quet fact het han; v16 KHONG lap lai ma xay lop truy van va
 *    lich trinh tren chung.
 *  - `factHistory` cua TemporalGraphStore: di chuoi supersession;
 *    v16 goi lai de tra timeline.
 *  - `factsValidAtV15` / `factTimelineV15` cua memoryV15: v16 mo
 *    rong them loc theo predicate/entity, cua so chong nhau va TTL.
 *
 * Moi trong v16:
 *  - `queryFactsValidAtV16` — truy van "fact nao dung tai T" voi
 *    loc scope + predicate + entity + chi fact tuong lai (validFrom
 *    > T) hay khong; tra ve ca fact da het han neu caller muon xem
 *    lich su (includeExpired).
 *  - `supersessionChainV16` — chuoi thay the day du cua mot fact
 *    (ban goc -> ... -> ban moi nhat) kem moc thoi gian tung ban.
 *  - `entityTimelineV16` — timeline cua mot entity: moi fact cua
 *    entity xep theo validFrom, kem khoang hieu luc va trang thai.
 *  - `findOverlappingWindowsV16` — phat hien hai fact active cung
 *    (subject, predicate) don tri co cua so hieu luc chong nhau
 *    (dau hieu du lieu loi hoac supersede sot).
 *  - `V16_TTL_PRESETS` — TTL mac dinh theo predicate (vd `plans`
 *    30 ngay, `temporary` 7 ngay, `likes` vo han) + `applyTtlV16`
 *    dat validUntil tu TTL khi tao fact.
 *  - `scheduleValidityV16` — dat lich hieu luc tuong lai cho fact
 *    ("lam o X tu 2027-01-01"): fact van active trong store nhung
 *    query tai T < validFrom se khong thay no.
 *  - `sweepExpiredFactsV16` — quet fact het han theo lo, ghi audit
 *    JSONL rieng, tra ve bao cao (khac sweep v1.03: chay theo batch
 *    co gioi han, co dry-run, khong xoa cung ma danh dau `deleted`
 *    mem de lich su van truy van duoc).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GraphFact, MemoryScope } from '../graph/types';
import { isFactValidAt } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { parseValidityHint } from '../graph/validity';
import { isSingleValuedPredicateV14 } from '../v14/extraction';

/** Loi validity window v16 — message tieng Viet. */
export class V16ValidityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V16ValidityError';
  }
}

/** TTL mac dinh theo predicate (so ngay; null = vo han). */
export const V16_TTL_PRESETS: Readonly<Record<string, number | null>> = {
  likes: null,
  dislikes: null,
  prefers: null,
  speaks: null,
  lives_in: null,
  works_at: null,
  lives_with: null,
  daily_routine: 180,
  goal: 90,
  constraint: 180,
  plans: 30,
  temporary: 7,
  reads: 60,
  watches: 60,
  commutes_by: 180,
};

/** TTL mac dinh cho predicate khong co trong bang (null = vo han). */
export const V16_DEFAULT_TTL_DAYS: number | null = null;

/** Lay TTL (ngay) cho mot predicate. */
export function ttlDaysForPredicateV16(predicate: string): number | null {
  const key = (predicate ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (key in V16_TTL_PRESETS) return V16_TTL_PRESETS[key];
  return V16_DEFAULT_TTL_DAYS;
}

/** Tinh validUntil tu validFrom + TTL (ngay); null = vo han. */
export function applyTtlV16(validFrom: Date, ttlDays: number | null): string | null {
  if (ttlDays === null || ttlDays === undefined) return null;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return null;
  return new Date(validFrom.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Tuy chon truy van fact hieu luc tai mot thoi diem. */
export interface V16ValidAtOptions {
  /** Thoi diem hoi (mac dinh: bay gio). */
  at?: Date;
  /** Loc theo predicate (vd 'lives_in'). */
  predicate?: string;
  /** Loc theo ten entity chu ngu (resolve qua store). */
  subjectName?: string;
  /** true = tra ca fact da het han (de xem lich su). */
  includeExpired?: boolean;
  /** true = tra ca fact chua toi validFrom (hieu luc tuong lai). */
  includeFuture?: boolean;
  /** Gioi han so fact tra ve (mac dinh 100). */
  limit?: number;
}

/** Ket qua truy van fact hieu luc tai T. */
export interface V16ValidAtResult {
  at: string;
  total: number;
  facts: GraphFact[];
  /** So fact bi loai vi het han (khi includeExpired=false). */
  expiredExcluded: number;
  /** So fact bi loai vi chua toi validFrom (khi includeFuture=false). */
  futureExcluded: number;
}

/**
 * Truy van fact dung tai T. Mac dinh chi tra fact active va dang
 * trong cua so [validFrom, validUntil); fact het han / chua toi han
 * chi duoc dem, khong tra ve (tru khi caller bat co tuong ung).
 */
export function queryFactsValidAtV16(
  store: TemporalGraphStore,
  scope: MemoryScope,
  opts: V16ValidAtOptions = {},
): V16ValidAtResult {
  const at = opts.at ?? new Date();
  const atMs = at.getTime();
  if (Number.isNaN(atMs)) {
    throw new V16ValidityError('Thoi diem truy van khong hop le.');
  }
  const limit = opts.limit ?? 100;
  const predicate = opts.predicate
    ? opts.predicate.trim().toLowerCase().replace(/\s+/g, '_')
    : undefined;
  let subjectId: string | undefined;
  if (opts.subjectName) {
    const entity = store.findEntityByName(opts.subjectName);
    if (!entity) {
      return { at: at.toISOString(), total: 0, facts: [], expiredExcluded: 0, futureExcluded: 0 };
    }
    subjectId = entity.id;
  }

  const facts: GraphFact[] = [];
  let expiredExcluded = 0;
  let futureExcluded = 0;
  for (const fact of store.listFacts({ ...scope, limit: 100000 })) {
    if (predicate && fact.predicate !== predicate) continue;
    if (subjectId && fact.subjectId !== subjectId) continue;
    if (fact.status !== 'active') continue;
    const fromMs = Date.parse(fact.validFrom);
    const untilMs = fact.validUntil === null ? Infinity : Date.parse(fact.validUntil);
    if (!Number.isNaN(fromMs) && fromMs > atMs) {
      if (opts.includeFuture === true) facts.push(fact);
      else futureExcluded += 1;
      continue;
    }
    if (untilMs <= atMs) {
      if (opts.includeExpired === true) facts.push(fact);
      else expiredExcluded += 1;
      continue;
    }
    if (isFactValidAt(fact, at)) facts.push(fact);
  }
  facts.sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  const total = facts.length;
  return {
    at: at.toISOString(),
    total,
    facts: facts.slice(0, Math.max(0, limit)),
    expiredExcluded,
    futureExcluded,
  };
}

/** Mot moc trong chuoi thay the cua fact. */
export interface V16SupersessionStep {
  factId: string;
  objectText: string;
  validFrom: string;
  validUntil: string | null;
  status: GraphFact['status'];
  confidence: number;
  createdAt: string;
}

/** Chuoi thay the day du cua mot fact (ban goc -> ban moi nhat). */
export interface V16SupersessionChain {
  /** Id fact bat dau truy van. */
  queriedFactId: string;
  /** Id ban goc (dau chuoi). */
  rootFactId: string;
  /** Id ban moi nhat (cuoi chuoi). */
  latestFactId: string;
  steps: V16SupersessionStep[];
}

/** Di chuoi supersession cua mot fact (qua store.factHistory). */
export function supersessionChainV16(
  store: TemporalGraphStore,
  factId: string,
): V16SupersessionChain | null {
  const history = store.factHistory(factId);
  if (history.length === 0) return null;
  const steps: V16SupersessionStep[] = history.map((f) => ({
    factId: f.id,
    objectText: f.objectText ?? '',
    validFrom: f.validFrom,
    validUntil: f.validUntil,
    status: f.status,
    confidence: f.confidence,
    createdAt: f.createdAt,
  }));
  return {
    queriedFactId: factId,
    rootFactId: steps[0].factId,
    latestFactId: steps[steps.length - 1].factId,
    steps,
  };
}

/** Mot moc trong timeline cua mot entity. */
export interface V16EntityTimelineStep {
  factId: string;
  predicate: string;
  objectText: string;
  validFrom: string;
  validUntil: string | null;
  status: GraphFact['status'];
  /** true = fact dang hieu luc tai thoi diem hoi. */
  validNow: boolean;
}

/**
 * Timeline cua mot entity: moi fact cua entity (ke ca superseded /
 * deleted) xep theo validFrom tang dan, kem trang thai hieu luc tai
 * thoi diem hoi (mac dinh: bay gio).
 */
export function entityTimelineV16(
  store: TemporalGraphStore,
  entityId: string,
  scope: MemoryScope,
  opts: { at?: Date; limit?: number } = {},
): V16EntityTimelineStep[] {
  const at = opts.at ?? new Date();
  const entity = store.getEntity(entityId);
  if (!entity) {
    throw new V16ValidityError(`Khong tim thay entity: "${entityId}".`);
  }
  void scope;
  const steps = store
    .listFacts({ includeOtherScopes: true, limit: 100000 })
    .filter((f) => f.subjectId === entityId || f.objectId === entityId)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.createdAt.localeCompare(b.createdAt))
    .map((f) => ({
      factId: f.id,
      predicate: f.predicate,
      objectText: f.objectText ?? '',
      validFrom: f.validFrom,
      validUntil: f.validUntil,
      status: f.status,
      validNow: isFactValidAt(f, at),
    }));
  return opts.limit !== undefined ? steps.slice(0, opts.limit) : steps;
}

/** Cap fact co cua so hieu luc chong nhau (dau hieu loi du lieu). */
export interface V16OverlappingWindow {
  subjectName: string;
  predicate: string;
  factA: GraphFact;
  factB: GraphFact;
  /** Giao nhau cua hai cua so. */
  overlapFrom: string;
  overlapUntil: string | null;
}

/**
 * Phat hien fact active cung (subject, predicate) don tri co cua so
 * hieu luc chong nhau. Binh thuong, sau moi UPDATE thi cua so cu
 * phai dong ngay tai moc supersede, nen hai fact active cung cap
 * don tri khong duoc chong nhau — neu co la do supersede sot hoac
 * file bi sua tay. Chi xet predicate don tri.
 */
export function findOverlappingWindowsV16(
  store: TemporalGraphStore,
  scope: MemoryScope,
): V16OverlappingWindow[] {
  const found: V16OverlappingWindow[] = [];
  const active = store
    .listFacts({ ...scope, limit: 100000 })
    .filter((f) => f.status === 'active' && isSingleValuedPredicateV14(f.predicate));
  const byKey = new Map<string, GraphFact[]>();
  for (const fact of active) {
    const key = `${fact.subjectId}|${fact.predicate}`;
    const list = byKey.get(key) ?? [];
    list.push(fact);
    byKey.set(key, list);
  }
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const [subjectId] = key.split('|');
    const subjectName = store.getEntity(subjectId)?.name ?? subjectId;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        const aFrom = Date.parse(a.validFrom);
        const aUntil = a.validUntil === null ? Infinity : Date.parse(a.validUntil);
        const bFrom = Date.parse(b.validFrom);
        const bUntil = b.validUntil === null ? Infinity : Date.parse(b.validUntil);
        const overlapFrom = Math.max(aFrom, bFrom);
        const overlapUntil = Math.min(aUntil, bUntil);
        if (overlapFrom < overlapUntil) {
          found.push({
            subjectName,
            predicate: a.predicate,
            factA: a,
            factB: b,
            overlapFrom: new Date(overlapFrom).toISOString(),
            overlapUntil: overlapUntil === Infinity ? null : new Date(overlapUntil).toISOString(),
          });
        }
      }
    }
  }
  return found;
}

/**
 * Dat lich hieu luc tuong lai cho mot fact: doi validFrom (va tuy
 * chon validUntil) qua `setFactValidity`. Fact van active trong
 * store nhung query tai T < validFrom se khong thay no (xem
 * `queryFactsValidAtV16`). Dung khi user noi "tu thang sau toi se
 * lam o X" — fact dung trong tuong lai, khong phai hien tai.
 */
export function scheduleValidityV16(
  store: TemporalGraphStore,
  factId: string,
  validFrom: string,
  validUntil: string | null = null,
): GraphFact {
  const fromMs = Date.parse(validFrom);
  if (Number.isNaN(fromMs)) {
    throw new V16ValidityError(`validFrom khong hop le: "${validFrom}".`);
  }
  if (validUntil !== null && !Number.isNaN(Date.parse(validUntil))) {
    if (Date.parse(validUntil) <= fromMs) {
      throw new V16ValidityError('validUntil phai sau validFrom.');
    }
  }
  return store.setFactValidity(factId, { validFrom, validUntil });
}

/** Rut goi y cua so hieu luc tu text (goi lai parseValidityHint v1.03). */
export function parseValidityHintV16(text: string): ReturnType<typeof parseValidityHint> {
  return parseValidityHint(text);
}

/** Duong dan file audit sweep het han v16 (tuong doi workspace). */
export const V16_EXPIRY_SWEEP_AUDIT_REL_PATH = path.join(
  '.open-bot',
  'memory-v16-expiry-sweeps.jsonl',
);

/** Bao cao mot lan quet fact het han. */
export interface V16ExpirySweepReport {
  sweptAt: string;
  checked: number;
  expired: number;
  /** Id fact da dong mem (chi khi khong dry-run). */
  closedFactIds: string[];
  dryRun: boolean;
  durationMs: number;
}

/**
 * Quet fact active da het han (validUntil <= now): dong mem bang
 * `deleteFact` (status `deleted`, lich su van truy van duoc), ghi
 * audit JSONL. Chay theo lo co gioi han (`batchSize`) de khong
 * chan sleep agent; dry-run chi dem, khong dong.
 */
export function sweepExpiredFactsV16(
  store: TemporalGraphStore,
  scope: MemoryScope,
  opts: {
    now?: Date;
    batchSize?: number;
    dryRun?: boolean;
    actor?: string;
    workspaceDir?: string;
  } = {},
): V16ExpirySweepReport {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? 100;
  const dryRun = opts.dryRun === true;
  const actor = opts.actor ?? 'system';
  const started = Date.now();
  const candidates = store
    .listFacts({ ...scope, limit: 100000 })
    .filter((f) => f.status === 'active' && f.validUntil !== null && Date.parse(f.validUntil) <= now.getTime());
  const batch = candidates.slice(0, Math.max(0, batchSize));
  const closedFactIds: string[] = [];
  if (!dryRun) {
    for (const fact of batch) {
      store.deleteFact(fact.id, actor);
      closedFactIds.push(fact.id);
    }
  }
  const report: V16ExpirySweepReport = {
    sweptAt: now.toISOString(),
    checked: candidates.length,
    expired: batch.length,
    closedFactIds,
    dryRun,
    durationMs: Math.max(0, Date.now() - started),
  };
  if (opts.workspaceDir) {
    try {
      const filePath = path.join(opts.workspaceDir, V16_EXPIRY_SWEEP_AUDIT_REL_PATH);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(report)}\n`, 'utf8');
    } catch {
      // Audit best-effort.
    }
  }
  return report;
}
