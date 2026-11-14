/**
 * Memory health — Memory v5 (v1.04, Đội T1).
 *
 * Sức khoẻ của kho memory, tính thuần từ store (không gọi model,
 * không ghi): fact count, contradiction rate, staleness, coverage,
 * quarantine backlog, độ tin cậy trung bình. Dùng cho health
 * dashboard ở UI (MemoryV5View) và cho consolidation v2 so sánh
 * trước/sau một lần chạy.
 *
 * Cách chấm điểm tổng (0..100, grade excellent ≥ 85, good ≥ 70,
 * fair ≥ 50, còn lại poor):
 *   bắt đầu 100, trừ:
 *   - contradiction rate × 40 (mâu thuẫn chưa xử lý là vấn đề lớn nhất),
 *   - stale rate × 25 (fact già không được nhắc lại),
 *   - quarantine backlog: min(pending / 20, 1) × 15,
 *   - orphan entity rate × 10 (entity không còn fact active nào),
 *   - low-confidence rate (fact active confidence < 0.5) × 10.
 * Mọi thành phần đều có trong report để UI giải thích được vì sao
 * điểm thấp — không có điểm "bí ẩn".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphFact, MemoryScope } from './graph/types';
import type { TemporalGraphStore } from './graph/store';
import { resolveAddOnlyGroups } from './graph/addOnly';

/** Fact không được nhắc lại sau từng này ngày thì coi là "già". */
export const HEALTH_STALE_DAYS = 90;
/** Confidence dưới từng này thì coi là "yếu". */
export const HEALTH_LOW_CONFIDENCE = 0.5;

export type MemoryHealthGrade = 'excellent' | 'good' | 'fair' | 'poor';

export interface MemoryHealthPredicateStat {
  predicate: string;
  count: number;
}

export interface MemoryHealth {
  generatedAt: string;
  scope: MemoryScope;
  /** Tổng số fact (mọi status). */
  factCount: number;
  activeFacts: number;
  supersededFacts: number;
  deletedFacts: number;
  quarantinedPending: number;
  entityCount: number;
  /** Entity không còn fact active nào trỏ tới. */
  orphanEntities: number;
  /** Nhóm ADD-only có ≥ 2 object khác nhau. */
  contradictionGroups: number;
  /** Tổng số nhóm ADD-only. */
  totalGroups: number;
  /** contradictionGroups / totalGroups (0 khi chưa có nhóm). */
  contradictionRate: number;
  /** Fact active già hơn HEALTH_STALE_DAYS (theo updatedAt). */
  staleFacts: number;
  /** staleFacts / activeFacts. */
  staleRate: number;
  /** Fact active confidence < HEALTH_LOW_CONFIDENCE. */
  lowConfidenceFacts: number;
  /** lowConfidenceFacts / activeFacts. */
  lowConfidenceRate: number;
  /** Confidence trung bình của fact active (0 khi chưa có fact). */
  avgConfidence: number;
  /** Tuổi trung bình của fact active (ngày). */
  avgFactAgeDays: number;
  /** Phân bố predicate của fact active (cao → thấp, tối đa 10). */
  topPredicates: MemoryHealthPredicateStat[];
  /** Điểm tổng 0..100. */
  score: number;
  grade: MemoryHealthGrade;
  /** Lý do trừ điểm, đọc được — UI hiển thị trực tiếp. */
  issues: string[];
}

/** Chấm grade từ điểm tổng. */
export function healthGrade(score: number): MemoryHealthGrade {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / 86_400_000);
}

/**
 * Tính sức khoẻ memory từ store. Thuần đọc — không ghi, không đổi
 * bất kỳ fact nào. `scope` mặc định rỗng = toàn bộ store.
 */
export function computeMemoryHealth(
  store: TemporalGraphStore,
  scope: MemoryScope = { userId: '', botId: '', runId: '' },
  now: Date = new Date(),
): MemoryHealth {
  const nowMs = now.getTime();
  const facts = store.listFacts({ ...scope, limit: 20000 });
  const active = facts.filter((f) => f.status === 'active');
  const superseded = facts.filter((f) => f.status === 'superseded');
  const deleted = facts.filter((f) => f.status === 'deleted');
  const pendingQuarantine = store.listQuarantine({ ...scope, status: 'pending' }).length;
  const entities = store.listEntities();
  const activeEntityIds = new Set<string>();
  for (const fact of active) {
    activeEntityIds.add(fact.subjectId);
    if (fact.objectId) activeEntityIds.add(fact.objectId);
  }
  const orphanEntities = entities.filter((e) => !activeEntityIds.has(e.id)).length;

  const groups = resolveAddOnlyGroups(store, scope, now);
  const contradictionGroups = groups.filter((g) => g.hasContradiction).length;
  const contradictionRate = groups.length === 0 ? 0 : contradictionGroups / groups.length;

  let staleFacts = 0;
  let lowConfidenceFacts = 0;
  let confidenceSum = 0;
  let ageSumDays = 0;
  const predicateCounts = new Map<string, number>();
  for (const fact of active) {
    const updatedMs = Date.parse(fact.updatedAt);
    if (!Number.isNaN(updatedMs) && daysBetween(updatedMs, nowMs) > HEALTH_STALE_DAYS) staleFacts += 1;
    if (fact.confidence < HEALTH_LOW_CONFIDENCE) lowConfidenceFacts += 1;
    confidenceSum += fact.confidence;
    const createdMs = Date.parse(fact.createdAt);
    if (!Number.isNaN(createdMs)) ageSumDays += daysBetween(createdMs, nowMs);
    predicateCounts.set(fact.predicate, (predicateCounts.get(fact.predicate) ?? 0) + 1);
  }
  const staleRate = active.length === 0 ? 0 : staleFacts / active.length;
  const lowConfidenceRate = active.length === 0 ? 0 : lowConfidenceFacts / active.length;
  const avgConfidence = active.length === 0 ? 0 : confidenceSum / active.length;
  const avgFactAgeDays = active.length === 0 ? 0 : ageSumDays / active.length;
  const topPredicates: MemoryHealthPredicateStat[] = [...predicateCounts.entries()]
    .map(([predicate, count]) => ({ predicate, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const issues: string[] = [];
  let score = 100;
  if (contradictionRate > 0) {
    const deduction = contradictionRate * 40;
    score -= deduction;
    issues.push(
      `${contradictionGroups}/${groups.length} nhóm fact mâu thuẫn (${(contradictionRate * 100).toFixed(0)}%) — trừ ${deduction.toFixed(0)} điểm. Chạy consolidation v2 để ranking supersede fact thua.`,
    );
  }
  if (staleRate > 0) {
    const deduction = staleRate * 25;
    score -= deduction;
    issues.push(
      `${staleFacts}/${active.length} fact active già hơn ${HEALTH_STALE_DAYS} ngày (${(staleRate * 100).toFixed(0)}%) — trừ ${deduction.toFixed(0)} điểm. Fact già chưa chắc sai, nhưng nên kiểm chứng lại.`,
    );
  }
  if (pendingQuarantine > 0) {
    const deduction = Math.min(pendingQuarantine / 20, 1) * 15;
    score -= deduction;
    issues.push(
      `${pendingQuarantine} mục quarantine đang chờ duyệt — trừ ${deduction.toFixed(0)} điểm. Duyệt hoặc reject để dọn backlog.`,
    );
  }
  const orphanRate = entities.length === 0 ? 0 : orphanEntities / entities.length;
  if (orphanRate > 0) {
    const deduction = orphanRate * 10;
    score -= deduction;
    issues.push(
      `${orphanEntities}/${entities.length} entity không còn fact active nào (${(orphanRate * 100).toFixed(0)}%) — trừ ${deduction.toFixed(0)} điểm.`,
    );
  }
  if (lowConfidenceRate > 0) {
    const deduction = lowConfidenceRate * 10;
    score -= deduction;
    issues.push(
      `${lowConfidenceFacts}/${active.length} fact active confidence thấp (< ${HEALTH_LOW_CONFIDENCE}) (${(lowConfidenceRate * 100).toFixed(0)}%) — trừ ${deduction.toFixed(0)} điểm.`,
    );
  }
  if (facts.length === 0) {
    issues.push('Kho memory đang trống — chưa có fact nào để đánh giá.');
  }
  score = Math.min(100, Math.max(0, Math.round(score * 10) / 10));

  return {
    generatedAt: now.toISOString(),
    scope: { ...scope },
    factCount: facts.length,
    activeFacts: active.length,
    supersededFacts: superseded.length,
    deletedFacts: deleted.length,
    quarantinedPending: pendingQuarantine,
    entityCount: entities.length,
    orphanEntities,
    contradictionGroups,
    totalGroups: groups.length,
    contradictionRate,
    staleFacts,
    staleRate,
    lowConfidenceFacts,
    lowConfidenceRate,
    avgConfidence,
    avgFactAgeDays,
    topPredicates,
    score,
    grade: healthGrade(score),
    issues,
  };
}

/** So sánh sức khoẻ trước/sau một lần consolidation (delta điểm). */
export function healthDelta(before: MemoryHealth, after: MemoryHealth): {
  scoreDelta: number;
  contradictionRateDelta: number;
  staleRateDelta: number;
  activeDelta: number;
  summary: string;
} {
  const scoreDelta = Math.round((after.score - before.score) * 10) / 10;
  const contradictionRateDelta = after.contradictionRate - before.contradictionRate;
  const staleRateDelta = after.staleRate - before.staleRate;
  const activeDelta = after.activeFacts - before.activeFacts;
  const parts: string[] = [];
  parts.push(`điểm ${before.score} → ${after.score} (${scoreDelta >= 0 ? '+' : ''}${scoreDelta})`);
  if (contradictionRateDelta !== 0) {
    parts.push(
      `mâu thuẫn ${(before.contradictionRate * 100).toFixed(0)}% → ${(after.contradictionRate * 100).toFixed(0)}%`,
    );
  }
  if (activeDelta !== 0) parts.push(`fact active ${before.activeFacts} → ${after.activeFacts}`);
  return {
    scoreDelta,
    contradictionRateDelta,
    staleRateDelta,
    activeDelta,
    summary: parts.join('; '),
  };
}

/** Render health thành markdown — dùng cho report + tool output. */
export function healthReportMarkdown(health: MemoryHealth): string {
  const lines: string[] = [];
  const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
  lines.push(`# Memory health — ${health.score}/100 (${health.grade})`);
  lines.push('');
  lines.push(`- Fact: ${health.factCount} tổng, ${health.activeFacts} active, ${health.supersededFacts} superseded, ${health.deletedFacts} deleted.`);
  lines.push(`- Entity: ${health.entityCount} (orphan: ${health.orphanEntities}).`);
  lines.push(`- Mâu thuẫn: ${health.contradictionGroups}/${health.totalGroups} nhóm (${pct(health.contradictionRate)}).`);
  lines.push(`- Fact già (>${HEALTH_STALE_DAYS} ngày): ${health.staleFacts} (${pct(health.staleRate)}).`);
  lines.push(`- Quarantine chờ duyệt: ${health.quarantinedPending}.`);
  lines.push(`- Confidence trung bình: ${health.avgConfidence.toFixed(2)}; tuổi trung bình: ${health.avgFactAgeDays.toFixed(1)} ngày.`);
  if (health.topPredicates.length > 0) {
    lines.push(
      `- Predicate nhiều nhất: ${health.topPredicates.map((p) => `${p.predicate} (${p.count})`).join(', ')}.`,
    );
  }
  if (health.issues.length > 0) {
    lines.push('');
    lines.push('## Vấn đề');
    for (const issue of health.issues) lines.push(`- ${issue}`);
  }
  return lines.join('\n');
}

/** Fact active già nhất / yếu nhất — để UI gợi ý kiểm chứng. */
export function healthAttentionFacts(
  store: TemporalGraphStore,
  scope: MemoryScope,
  opts: { limit?: number; now?: Date } = {},
): { stale: GraphFact[]; lowConfidence: GraphFact[] } {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 10), 1), 100);
  const active = store.listFacts({ ...scope, status: 'active', limit: 5000 });
  const stale = active
    .filter((f) => {
      const updatedMs = Date.parse(f.updatedAt);
      return !Number.isNaN(updatedMs) && daysBetween(updatedMs, now.getTime()) > HEALTH_STALE_DAYS;
    })
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, limit);
  const lowConfidence = active
    .filter((f) => f.confidence < HEALTH_LOW_CONFIDENCE)
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, limit);
  return { stale, lowConfidence };
}

/** Tóm tắt một nhóm mâu thuẫn để UI hiển thị (không trả embedding). */
export function contradictionGroupSummary(
  store: TemporalGraphStore,
  scope: MemoryScope,
  now: Date = new Date(),
): Array<{
  subjectName: string;
  predicate: string;
  winnerObject: string;
  winnerScore: number;
  losers: Array<{ objectText: string; score: number; factId: string }>;
}> {
  const groups = resolveAddOnlyGroups(store, scope, now).filter((g) => g.hasContradiction);
  return groups.map((g) => ({
    subjectName: g.subjectName,
    predicate: g.predicate,
    winnerObject: g.winner?.fact.objectText ?? '',
    winnerScore: g.winner?.score.total ?? 0,
    losers: g.losers.map((l) => ({
      objectText: l.fact.objectText ?? '',
      score: l.score.total,
      factId: l.fact.id,
    })),
  }));
}

export interface HealthTrendPoint {
  at: string;
  scoreBefore: number;
  scoreAfter: number;
  duplicatesMerged: number;
  losersSuperseded: number;
  expiredSwept: number;
  dreamPromoted: number;
}

/** File log JSONL của consolidation v2 (cùng file consolidationV2 ghi). */
export const MEMORY_CONSOLIDATION_V2_LOG_REL_PATH = path.join(
  '.open-bot',
  'memory-consolidation-v2.jsonl',
);

/** Đọc các lần consolidation v2 từ log JSONL (bỏ dòng hỏng, không throw). */
export function readHealthTrendLog(workspaceDir: string, limit = 20): HealthTrendPoint[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceDir, MEMORY_CONSOLIDATION_V2_LOG_REL_PATH), 'utf8');
  } catch {
    return [];
  }
  const out: HealthTrendPoint[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as HealthTrendPoint;
      if (typeof parsed.at === 'string' && typeof parsed.scoreAfter === 'number') out.push(parsed);
    } catch {
      // Dòng hỏng — bỏ qua.
    }
  }
  const n = Math.min(Math.max(Math.floor(limit), 1), 200);
  return out.slice(-n);
}

export interface HealthTrend {
  points: HealthTrendPoint[];
  /** Điểm hiện tại (từ health mới nhất, hoặc null khi chưa có dữ liệu). */
  currentScore: number | null;
  /** Điểm đầu tiên được ghi nhận (null khi chưa có dữ liệu). */
  firstScore: number | null;
  /** Chênh lệch điểm từ lần chạy đầu tới hiện tại. */
  totalDelta: number | null;
  /** Xu hướng: improving | declining | flat | unknown. */
  direction: 'improving' | 'declining' | 'flat' | 'unknown';
  /** Lần chạy gần nhất cải thiện điểm nhiều nhất (null khi chưa có). */
  bestRun: HealthTrendPoint | null;
}

/**
 * Xu hướng sức khoẻ theo thời gian, đọc từ log consolidation v2
 * (mỗi lần chạy ghi scoreBefore/scoreAfter) + health hiện tại.
 * Thuần đọc — không ghi.
 */
export function healthTrend(
  store: TemporalGraphStore,
  scope: MemoryScope,
  workspaceDir: string,
  opts: { now?: Date; limit?: number } = {},
): HealthTrend {
  const now = opts.now ?? new Date();
  const points = readHealthTrendLog(workspaceDir, opts.limit ?? 20).sort((a, b) =>
    a.at.localeCompare(b.at),
  );
  const current = computeMemoryHealth(store, scope, now);
  if (points.length === 0) {
    return {
      points,
      currentScore: current.score,
      firstScore: null,
      totalDelta: null,
      direction: 'unknown',
      bestRun: null,
    };
  }
  const first = points[0];
  const totalDelta = Math.round((current.score - (first?.scoreBefore ?? current.score)) * 10) / 10;
  const direction = totalDelta > 1 ? 'improving' : totalDelta < -1 ? 'declining' : 'flat';
  let bestRun: HealthTrendPoint | null = null;
  for (const point of points) {
    const gain = point.scoreAfter - point.scoreBefore;
    if (!bestRun || gain > bestRun.scoreAfter - bestRun.scoreBefore) bestRun = point;
  }
  return {
    points,
    currentScore: current.score,
    firstScore: first?.scoreBefore ?? null,
    totalDelta,
    direction,
    bestRun,
  };
}
