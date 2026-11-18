/**
 * Memory v17 — Archival passage promote/demote scoring (v1.18, Doi T1).
 *
 * Y tuong hoc tu Letta/MemGPT (archival memory: vector store chi
 * tim khi can; passage nao duoc dung nhieu thi xung dang len core)
 * + Mem0 2026 (retrieval xep hang theo relevance + importance +
 * recency) + Zep/Graphiti (validity window: fact co cua so hieu
 * luc, het han thi demote) — tu thiet ke lai hoan toan cho
 * open-bot, chay 100% local, KHONG copy code/text/tai san cua bat
 * ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `promoteFactsToCoreV16` / `V16V15BlockAdapter` /
 *    `V16_ARCHIVAL_BLOCK_LABEL` cua memory/v16/corePromotion:
 *    promotion that vao core block (qua gate poisoning); v17 chi
 *    QUYET DINH passage nao xung dang promote/demote, roi goi
 *    lai promotion v16 — khong viet lai duong vao core.
 *  - `V16SourceAllowlist` / `corePromotionGateForFactV16` cua
 *    v16/poisoningGuard: gate truoc khi promote (v17 khong bao
 *    gio bo qua gate).
 *  - `sweepExpiredFactsV16` cua v16/validityWindow: fact het han
 *    van duoc sweep o sleep; v17 demote them fact LOI THOI (het
 *    han gan / khong ai dung) ngay ca khi chua het han han.
 *
 * Moi trong v17:
 *  1. `V17PassageSignal` — 4 tin hieu moi passage: tan suat truy
 *     cap (`accessCount`, dem qua `recordAccessV17` + luu file),
 *     do tin cay (`confidence` cua fact), do moi (`recency` —
 *     phan ra theo half-life), do loi thoi (`staleness` — tuoi
 *     so voi TTL cua predicate).
 *  2. `scorePassageV17` — diem 0..1 = trung binh co trong so
 *     (trong so cau hinh duoc); `V17_ARCHIVAL_SCORING_DEFAULTS`
 *     co san. Diem cao -> promote; diem thap + loi thoi -> demote.
 *  3. `promotePassagesV17` / `demotePassagesV17` — quet fact
 *     active trong scope, tinh diem, promote fact vuot nguong
 *     len core (qua v16), demote fact duoi nguong xuong archival
 *     (xoa dong khoi core block, gom vao block archival v16, ghi
 *     vao registry demote luu file). Nguong cau hinh duoc.
 *  4. Registry truy cap + demote luu file JSON duoi `.open-bot/`
 *     de resume sau restart; `archivalScoringReportV17` tom tat
 *     so passage tung muc diem (de UI ve bieu do don gian).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GraphFact, MemoryScope } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { ttlDaysForPredicateV16 } from '../v16/validityWindow';
import { promoteFactsToCoreV16 } from '../v16/corePromotion';
import type { V16BlockAdapter, V16PromotionOptions } from '../v16/corePromotion';
import { V16_ARCHIVAL_BLOCK_LABEL } from '../v16/corePromotion';

/** Loi archival scoring v17 — message tieng Viet. */
export class V17ArchivalScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V17ArchivalScoringError';
  }
}

/** Trong so 4 tin hieu (tong khong nhat thiet = 1 — tu chuan hoa). */
export interface V17ScoringWeights {
  /** Tan suat truy cap. */
  access: number;
  /** Do tin cay cua fact. */
  confidence: number;
  /** Do moi (recency). */
  recency: number;
  /** Do tuoi moi (1 - staleness): fact cang tuoi cang cao. */
  freshness: number;
}

/** Nguong promote/demote (cau hinh duoc). */
export interface V17ArchivalThresholds {
  /** Diem >= nguong nay thi promote len core. */
  promoteAt: number;
  /** Diem <= nguong nay VA loi thoi thi demote xuong archival. */
  demoteAt: number;
  /** So ngay khong ai truy cap thi coi la loi thoi. */
  staleAfterDays: number;
  /** Half-life recency (ngay) — fact cu hon N half-life thi recency ~ 0. */
  recencyHalfLifeDays: number;
  /** So lan truy cap de access signal dat 1.0 (log-scale). */
  accessSaturation: number;
}

/** Cau hinh scoring day du. */
export interface V17ArchivalScoringConfig {
  weights: V17ScoringWeights;
  thresholds: V17ArchivalThresholds;
}

export const V17_ARCHIVAL_SCORING_DEFAULTS: V17ArchivalScoringConfig = {
  weights: { access: 0.35, confidence: 0.25, recency: 0.2, freshness: 0.2 },
  thresholds: {
    promoteAt: 0.65,
    demoteAt: 0.3,
    staleAfterDays: 90,
    recencyHalfLifeDays: 30,
    accessSaturation: 10,
  },
};

/** 4 tin hieu tho cua mot passage (moi tin hieu 0..1). */
export interface V17PassageSignals {
  /** Tan suat truy cap (log-scale, 0..1). */
  access: number;
  /** Do tin cay cua fact (0..1). */
  confidence: number;
  /** Do moi theo half-life (0..1). */
  recency: number;
  /** 1 - staleness: 1 = tuoi, 0 = het han. */
  freshness: number;
}

/** Ket qua cham diem mot passage. */
export interface V17PassageScore {
  factId: string;
  subjectName: string;
  predicate: string;
  objectText: string;
  signals: V17PassageSignals;
  /** Diem tong 0..1. */
  score: number;
  /** So lan truy cap ghi nhan. */
  accessCount: number;
  /** Ngay truy cap cuoi (ISO) hoac null = chua ai truy cap. */
  lastAccessedAt: string | null;
  /** true = passage loi thoi (qua staleAfterDays khong ai dung). */
  stale: boolean;
  /** Giai thich ngan (de UI hien thi). */
  explanation: string;
}

/** So lan truy cap + lan cuoi cua mot fact (luu file). */
export interface V17PassageAccessEntry {
  factId: string;
  accessCount: number;
  lastAccessedAt: string;
}

/** Registry truy cap (JSON luu file). */
export interface V17PassageAccessJson {
  version: 1;
  entries: V17PassageAccessEntry[];
  updatedAt: string;
}

/** Mot lan demote (luu file de audit + khoi phuc). */
export interface V17DemotedPassage {
  factId: string;
  blockLabel: string;
  score: number;
  reason: string;
  demotedAt: string;
  demotedBy: string;
}

/** Registry demote (JSON luu file). */
export interface V17DemotedJson {
  version: 1;
  entries: V17DemotedPassage[];
  updatedAt: string;
}

export const V17_PASSAGE_ACCESS_REL_PATH = path.join('.open-bot', 'memory-v17-passage-access.json');
export const V17_DEMOTED_REL_PATH = path.join('.open-bot', 'memory-v17-demoted.json');

function clamp01V17(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function nowIsoV17(date = new Date()): string {
  return date.toISOString();
}

/** Doc registry truy cap tu workspace (khong co file -> rong). */
export function loadPassageAccessV17(workspaceDir: string): Map<string, V17PassageAccessEntry> {
  const map = new Map<string, V17PassageAccessEntry>();
  try {
    const filePath = path.join(workspaceDir, V17_PASSAGE_ACCESS_REL_PATH);
    if (!fs.existsSync(filePath)) return map;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as V17PassageAccessJson;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return map;
    for (const e of parsed.entries) {
      if (!e || typeof e.factId !== 'string') continue;
      map.set(e.factId, {
        factId: e.factId,
        accessCount: Math.max(0, e.accessCount ?? 0),
        lastAccessedAt: typeof e.lastAccessedAt === 'string' ? e.lastAccessedAt : '',
      });
    }
  } catch {
    // Registry hong thi bat dau lai tu rong — chi mat dem truy cap.
  }
  return map;
}

/** Ghi registry truy cap xuong workspace (best-effort). */
export function savePassageAccessV17(workspaceDir: string, access: Map<string, V17PassageAccessEntry>): void {
  try {
    const filePath = path.join(workspaceDir, V17_PASSAGE_ACCESS_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const json: V17PassageAccessJson = {
      version: 1,
      entries: [...access.values()],
      updatedAt: nowIsoV17(),
    };
    fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort.
  }
}

/** Ghi nhan 1 lan truy cap passage (tang dem, cap nhat lan cuoi). */
export function recordAccessV17(
  workspaceDir: string,
  factId: string,
  at = new Date(),
): V17PassageAccessEntry {
  if ((factId ?? '').trim() === '') {
    throw new V17ArchivalScoringError('factId khong duoc rong khi ghi nhan truy cap.');
  }
  const access = loadPassageAccessV17(workspaceDir);
  const prev = access.get(factId);
  const entry: V17PassageAccessEntry = {
    factId,
    accessCount: (prev?.accessCount ?? 0) + 1,
    lastAccessedAt: nowIsoV17(at),
  };
  access.set(factId, entry);
  savePassageAccessV17(workspaceDir, access);
  return entry;
}

/** Doc registry demote tu workspace (khong co file -> rong). */
export function loadDemotedV17(workspaceDir: string): V17DemotedPassage[] {
  try {
    const filePath = path.join(workspaceDir, V17_DEMOTED_REL_PATH);
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as V17DemotedJson;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((e) => e && typeof e.factId === 'string');
  } catch {
    return [];
  }
}

/** Ghi them muc demote vao registry (best-effort). */
export function appendDemotedV17(workspaceDir: string, entry: V17DemotedPassage): void {
  try {
    const entries = loadDemotedV17(workspaceDir);
    entries.push(entry);
    const filePath = path.join(workspaceDir, V17_DEMOTED_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const json: V17DemotedJson = { version: 1, entries, updatedAt: nowIsoV17() };
    fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort.
  }
}

/**
 * Cham diem mot passage: 4 tin hieu (access log-scale, confidence
 * cua fact, recency half-life theo validFrom, freshness theo TTL
 * cua predicate + lan truy cap cuoi). Diem = trung binh co trong
 * so, chuan hoa theo tong trong so.
 */
export function scorePassageV17(
  fact: GraphFact,
  access: V17PassageAccessEntry | undefined,
  config: V17ArchivalScoringConfig = V17_ARCHIVAL_SCORING_DEFAULTS,
  now = new Date(),
): V17PassageScore {
  const w = config.weights;
  const t = config.thresholds;
  const totalWeight = Math.max(1e-9, w.access + w.confidence + w.recency + w.freshness);

  const accessCount = access?.accessCount ?? 0;
  const accessSignal = clamp01V17(
    Math.log1p(accessCount) / Math.log1p(Math.max(1, t.accessSaturation)),
  );
  const confidenceSignal = clamp01V17(fact.confidence);

  const validFromMs = Date.parse(fact.validFrom);
  const ageMs = Number.isNaN(validFromMs) ? 0 : Math.max(0, now.getTime() - validFromMs);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const recencySignal = clamp01V17(Math.pow(0.5, ageDays / Math.max(1, t.recencyHalfLifeDays)));

  const ttlDays = ttlDaysForPredicateV16(fact.predicate) ?? 180;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const lastAccessMs = access?.lastAccessedAt ? Date.parse(access.lastAccessedAt) : NaN;
  const idleDays = Number.isNaN(lastAccessMs)
    ? ageDays
    : Math.max(0, (now.getTime() - lastAccessMs) / (24 * 60 * 60 * 1000));
  const freshnessSignal = clamp01V17(1 - Math.min(1, idleDays / Math.max(1, ttlDays)) * 0.7 - Math.min(0.3, ageDays / Math.max(1, ttlDays * 2)));
  void ttlMs;

  const score = clamp01V17(
    (w.access * accessSignal +
      w.confidence * confidenceSignal +
      w.recency * recencySignal +
      w.freshness * freshnessSignal) /
      totalWeight,
  );
  const stale = idleDays >= t.staleAfterDays;
  const subjectName = fact.subjectId;
  const explanation = [
    `diem ${score.toFixed(2)}`,
    `truy cap ${accessCount} lan (tin hieu ${accessSignal.toFixed(2)})`,
    `confidence ${confidenceSignal.toFixed(2)}`,
    `moi ${recencySignal.toFixed(2)} (tuoi ${Math.round(ageDays)} ngay)`,
    `tuoi moi ${freshnessSignal.toFixed(2)}`,
    stale ? 'LOI THOI' : 'con dung',
  ].join('; ');
  return {
    factId: fact.id,
    subjectName,
    predicate: fact.predicate,
    objectText: fact.objectText ?? '',
    signals: {
      access: accessSignal,
      confidence: confidenceSignal,
      recency: recencySignal,
      freshness: freshnessSignal,
    },
    score,
    accessCount,
    lastAccessedAt: access?.lastAccessedAt ?? null,
    stale,
    explanation,
  };
}

/** Bao cao mot lan promote/demote. */
export interface V17ArchivalMoveReport {
  considered: number;
  promoted: V17PassageScore[];
  demoted: V17PassageScore[];
  skipped: Array<{ factId: string; reason: string }>;
  /** So fact bi gate poisoning chan khi promote. */
  gatedOut: number;
}

/** Tuy chon promote/demote. */
export interface V17ArchivalMoveOptions extends V16PromotionOptions {
  config?: V17ArchivalScoringConfig;
  /** Gioi han so fact xet moi lan (mac dinh 200). */
  limit?: number;
  /** Actor ghi demote (mac dinh 'system:v17-archival'). */
  actor?: string;
  /** Thoi diem danh gia (mac dinh: bay gio). */
  now?: Date;
}

/** Lay fact active trong scope + cham diem tat ca (sap xep diem giam dan). */
export function scoreAllPassagesV17(
  store: TemporalGraphStore,
  scope: MemoryScope,
  workspaceDir: string,
  opts: { config?: V17ArchivalScoringConfig; limit?: number; now?: Date } = {},
): V17PassageScore[] {
  const config = opts.config ?? V17_ARCHIVAL_SCORING_DEFAULTS;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 200;
  const access = loadPassageAccessV17(workspaceDir);
  const facts = store
    .listFacts({ ...scope, status: 'active', limit: 100000 })
    .sort((a, b) => b.confidence - a.confidence || b.validFrom.localeCompare(a.validFrom))
    .slice(0, Math.max(0, limit));
  const scored = facts.map((f) => scorePassageV17(f, access.get(f.id), config, now));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Promote passage du diem len core block (qua promotion v16 — co
 * gate poisoning). Chi fact active, chua nam trong core (dedup do
 * v16 lo), diem >= promoteAt moi duoc xet.
 */
export function promotePassagesV17(
  store: TemporalGraphStore,
  scope: MemoryScope,
  workspaceDir: string,
  adapter: V16BlockAdapter,
  sourceName: string,
  opts: V17ArchivalMoveOptions = {},
): V17ArchivalMoveReport {
  const config = opts.config ?? V17_ARCHIVAL_SCORING_DEFAULTS;
  const now = opts.now ?? new Date();
  const scored = scoreAllPassagesV17(store, scope, workspaceDir, {
    config,
    limit: opts.limit,
    now,
  });
  const report: V17ArchivalMoveReport = { considered: scored.length, promoted: [], demoted: [], skipped: [], gatedOut: 0 };
  const candidates = scored.filter((s) => s.score >= config.thresholds.promoteAt);
  if (candidates.length === 0) {
    for (const s of scored) {
      report.skipped.push({ factId: s.factId, reason: `Diem ${s.score.toFixed(2)} duoi nguong promote ${config.thresholds.promoteAt}.` });
    }
    return report;
  }
  const facts: GraphFact[] = [];
  for (const c of candidates) {
    const fact = store.getFact(c.factId);
    if (fact) facts.push(fact);
  }
  const promotion = promoteFactsToCoreV16(store, facts, scope, adapter, sourceName, opts);
  const promotedIds = new Set(promotion.promoted.map((p) => p.factId));
  report.gatedOut = promotion.gatedOut.length;
  for (const c of candidates) {
    if (promotedIds.has(c.factId)) {
      report.promoted.push(c);
    } else if (promotion.gatedOut.some((g) => g.factId === c.factId)) {
      report.skipped.push({ factId: c.factId, reason: 'Bi gate poisoning chan khi promote.' });
    } else {
      report.skipped.push({ factId: c.factId, reason: 'Da co trong core block (dedup) hoac vuot budget — xuong archival.' });
    }
  }
  return report;
}

/**
 * Demote passage diem thap + loi thoi xuong archival: xoa dong
 * cua fact khoi core block (neu co), gom dong vao block archival
 * v16, ghi registry demote. Fact KHONG bi xoa khoi graph — chi
 * roi khoi core (van tim duoc qua archival/search).
 */
export function demotePassagesV17(
  store: TemporalGraphStore,
  scope: MemoryScope,
  workspaceDir: string,
  adapter: V16BlockAdapter,
  opts: V17ArchivalMoveOptions = {},
): V17ArchivalMoveReport {
  const config = opts.config ?? V17_ARCHIVAL_SCORING_DEFAULTS;
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? 'system:v17-archival';
  const scored = scoreAllPassagesV17(store, scope, workspaceDir, {
    config,
    limit: opts.limit,
    now,
  });
  const report: V17ArchivalMoveReport = { considered: scored.length, promoted: [], demoted: [], skipped: [], gatedOut: 0 };
  const demotedIds = new Set(loadDemotedV17(workspaceDir).map((d) => d.factId));
  const archivalLines: string[] = [];

  for (const s of scored) {
    if (demotedIds.has(s.factId)) {
      report.skipped.push({ factId: s.factId, reason: 'Da demote truoc do.' });
      continue;
    }
    if (s.score > config.thresholds.demoteAt || !s.stale) {
      report.skipped.push({
        factId: s.factId,
        reason: s.stale
          ? `Diem ${s.score.toFixed(2)} tren nguong demote ${config.thresholds.demoteAt} — giu lai.`
          : `Chua loi thoi (diem ${s.score.toFixed(2)}) — giu lai.`,
      });
      continue;
    }
    // Xoa dong cua fact khoi moi core block (tim theo [fact:<id8>]).
    const shortId = s.factId.slice(0, 8);
    for (const kind of ['persona', 'human', 'task'] as const) {
      const label = kind === 'persona' ? 'v16-persona' : kind === 'human' ? 'v16-human' : 'v16-task';
      const block = adapter.getBlock(label);
      if (!block) continue;
      const lines = block.content.split('\n').filter((l) => l.trim() !== '');
      const kept = lines.filter((l) => !l.includes(`[fact:${shortId}`));
      if (kept.length !== lines.length) {
        adapter.replaceBlock(label, kept.join('\n'));
        void actor;
      }
    }
    const fact = store.getFact(s.factId);
    const subjectName = fact ? (store.getEntity(fact.subjectId)?.name ?? fact.subjectId) : s.subjectName;
    archivalLines.push(`- ${subjectName} ${s.predicate.replace(/_/g, ' ')} ${s.objectText} [fact:${shortId} demoted ${now.toISOString().slice(0, 10)}]`);
    appendDemotedV17(workspaceDir, {
      factId: s.factId,
      blockLabel: V16_ARCHIVAL_BLOCK_LABEL,
      score: s.score,
      reason: `Diem ${s.score.toFixed(2)} <= ${config.thresholds.demoteAt} va loi thoi (${s.accessCount} lan truy cap).`,
      demotedAt: now.toISOString(),
      demotedBy: actor,
    });
    report.demoted.push(s);
  }

  if (archivalLines.length > 0) {
    const archival = adapter.getBlock(V16_ARCHIVAL_BLOCK_LABEL);
    if (!archival) {
      adapter.createBlock(V16_ARCHIVAL_BLOCK_LABEL, 'custom', archivalLines.join('\n'));
    } else {
      adapter.appendToBlock(V16_ARCHIVAL_BLOCK_LABEL, archivalLines.join('\n'));
    }
  }
  return report;
}

/** Tom tat phan bo diem passage (de UI). */
export interface V17ArchivalScoringReport {
  at: string;
  considered: number;
  promoteReady: number;
  demoteReady: number;
  middle: number;
  staleCount: number;
  avgScore: number;
  top: V17PassageScore[];
}

/** Chay scoring toan bo passage, tra bao cao (khong doi gi). */
export function archivalScoringReportV17(
  store: TemporalGraphStore,
  scope: MemoryScope,
  workspaceDir: string,
  opts: { config?: V17ArchivalScoringConfig; limit?: number; now?: Date; topK?: number } = {},
): V17ArchivalScoringReport {
  const config = opts.config ?? V17_ARCHIVAL_SCORING_DEFAULTS;
  const now = opts.now ?? new Date();
  const scored = scoreAllPassagesV17(store, scope, workspaceDir, { config, limit: opts.limit, now });
  const topK = opts.topK ?? 5;
  return {
    at: now.toISOString(),
    considered: scored.length,
    promoteReady: scored.filter((s) => s.score >= config.thresholds.promoteAt).length,
    demoteReady: scored.filter((s) => s.score <= config.thresholds.demoteAt && s.stale).length,
    middle: scored.filter((s) => s.score > config.thresholds.demoteAt && s.score < config.thresholds.promoteAt).length,
    staleCount: scored.filter((s) => s.stale).length,
    avgScore: scored.length > 0 ? scored.reduce((sum, s) => sum + s.score, 0) / scored.length : 0,
    top: scored.slice(0, Math.max(0, topK)),
  };
}
