/**
 * Panels v13 — view-model cho 4 panel riêng của platform/fleet v13
 * (v1.16, Đội T6): Memory v15, Router v2, Voice v15, Fleet v13.
 *
 * Các panel này là panel RIÊNG, không nhồi vào màn chat chính (theo
 * hướng UI: chat/bot list/tool browsing/settings quen Grok Bot, tính
 * năng nâng cao sau panel/menu — progressive disclosure). Module này
 * chỉ xây VIEW-MODEL thuần (dữ liệu đã lọc/sắp xếp + tóm tắt) từ dữ
 * liệu thật của các tầng dưới; component React ở
 * `apps/desktop/src/renderer/components/*V15Panel.tsx` /
 * `*V13Panel.tsx` render từ đó.
 *
 * - Memory v15 panel: consolidation kiểu Mem0 v3 (add-only: fact mới
 *   nằm cạnh fact cũ, retrieval mới quyết định cái nào còn đúng —
 *   supersede tại lúc đọc, không xóa lúc ghi), hybrid search v2
 *   (điểm = vector + BM25 + graph + recency, có giải thích từng
 *   thành phần), sleep-time reorganizer plan (block nào cần gom lúc
 *   idle).
 * - Router v2 panel: model picker v2 (chấm điểm task → model theo
 *   cost/latency/quality fit), LRU + TTL unload plan (model nào sẽ
 *   unload trước), swap-groups (model nào được chia GPU).
 * - Voice v15 panel: pipeline budget từng tầng (VAD/STT/LLM/TTS/
 *   orchestrator: đo thực tế vs ngân sách, alert khi vượt),
 *   barge-in events, semantic turn-taking decisions.
 * - Fleet v13 panel: bảng node (pin, RAM/VRAM, health), capacity,
 *   rebalance gợi ý, event log đã lọc — gom từ `fleetV13.ts` +
 *   `multiUserV13.ts`/`rolloutV13.ts` thành một view-model duy nhất
 *   cho panel.
 *
 * Tất cả hàm đều thuần, không đọc file, không chạm mạng. Dữ liệu
 * mock chỉ xuất hiện ở component demo — module này không chứa mock.
 */

import type { FleetV13CapacityReport, FleetV13Event, FleetV13NodePin, FleetV13PinSnapshot } from './fleetV13';
import { buildFleetV13CapacityReport, fleetV13PinsOfNode, suggestFleetV13Rebalance } from './fleetV13';
import type { TeamV13Rollout } from './rolloutV13';
import { teamV13StageLabel } from './rolloutV13';

// ---------------------------------------------------------------------------
// Memory v15 panel
// ---------------------------------------------------------------------------

/** Một fact memory (add-only, có thể bị supersede bởi fact khác). */
export interface FleetV13MemoryFact {
  id: string;
  text: string;
  confidence: number;
  source: string;
  createdBy: string;
  createdAt: number;
  /** Id fact mới hơn đã thay thế fact này ('' = còn hiệu lực). */
  supersededBy: string;
  quarantined: boolean;
  quarantineReason: string;
}

/** Một fact trong panel memory v15 (đã tính trạng thái hiệu lực). */
export interface FleetV13MemoryFactRow {
  id: string;
  text: string;
  confidence: number;
  source: string;
  createdBy: string;
  createdAt: number;
  /** true = fact còn hiệu lực (không bị supersede, không quarantine). */
  active: boolean;
  supersededBy: string;
  quarantined: boolean;
  quarantineReason: string;
}

/** Điểm hybrid search v2 của một fact (có giải thích từng thành phần). */
export interface FleetV13HybridScore {
  factId: string;
  /** Điểm tổng hợp 0..1 (trọng số: vector 0.4, BM25 0.25, graph 0.2, recency 0.15). */
  score: number;
  vectorScore: number;
  bm25Score: number;
  graphScore: number;
  recencyScore: number;
  explanation: string;
}

/** Kế hoạch reorganize lúc idle (Letta sleep-time compute). */
export interface FleetV13ReorganizePlan {
  blockId: string;
  action: 'merge' | 'split' | 'archive' | 'none';
  reason: string;
  factCount: number;
}

/** View-model panel Memory v15. */
export interface FleetV13MemoryPanel {
  facts: FleetV13MemoryFactRow[];
  totalFacts: number;
  activeCount: number;
  supersededCount: number;
  quarantinedCount: number;
  hybridTop: FleetV13HybridScore[];
  reorganizePlans: FleetV13ReorganizePlan[];
  summary: string;
}

/** Tối đa fact hiển thị trong panel. */
export const FLEET_V13_MAX_MEMORY_FACTS = 100;
/** Tối đa kết quả hybrid search hiển thị. */
export const FLEET_V13_MAX_HYBRID_RESULTS = 20;

/** Trọng số hybrid search v2 (vector + BM25 + graph + recency = 1.0). */
export const FLEET_V13_HYBRID_WEIGHTS = {
  vector: 0.4,
  bm25: 0.25,
  graph: 0.2,
  recency: 0.15,
} as const;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function toMemoryRow(f: FleetV13MemoryFact): FleetV13MemoryFactRow {
  return {
    id: f.id,
    text: f.text,
    confidence: f.confidence,
    source: f.source,
    createdBy: f.createdBy,
    createdAt: f.createdAt,
    active: !f.supersededBy && !f.quarantined,
    supersededBy: f.supersededBy,
    quarantined: f.quarantined,
    quarantineReason: f.quarantineReason,
  };
}

/**
 * Tính điểm hybrid search cho một fact từ 4 tín hiệu đã đo (do
 * caller đo: vector similarity, BM25, graph proximity, recency).
 * Fact bị supersede/quarantine bị phạt 50% điểm — retrieval-time
 * supersede (Mem0 v3): fact cũ vẫn nằm đó nhưng ít được chọn.
 */
export function scoreFleetV13Hybrid(
  fact: FleetV13MemoryFact,
  signals: { vector: number; bm25: number; graph: number; recency: number },
): FleetV13HybridScore {
  const vectorScore = clamp01(signals.vector);
  const bm25Score = clamp01(signals.bm25);
  const graphScore = clamp01(signals.graph);
  const recencyScore = clamp01(signals.recency);
  let score =
    FLEET_V13_HYBRID_WEIGHTS.vector * vectorScore +
    FLEET_V13_HYBRID_WEIGHTS.bm25 * bm25Score +
    FLEET_V13_HYBRID_WEIGHTS.graph * graphScore +
    FLEET_V13_HYBRID_WEIGHTS.recency * recencyScore;
  const penalized = !!fact.supersededBy || fact.quarantined;
  if (penalized) score *= 0.5;
  return {
    factId: fact.id,
    score: Math.round(score * 1000) / 1000,
    vectorScore,
    bm25Score,
    graphScore,
    recencyScore,
    explanation:
      `vector ${(vectorScore * 100).toFixed(0)}% + BM25 ${(bm25Score * 100).toFixed(0)}% + ` +
      `graph ${(graphScore * 100).toFixed(0)}% + recency ${(recencyScore * 100).toFixed(0)}%` +
      (penalized ? ' (phạt 50%: fact đã supersede/quarantine)' : ''),
  };
}

/**
 * Build panel Memory v15: lọc fact theo query/confidence/quarantine,
 * sắp xếp confidence giảm dần, tính hybrid top từ signals caller đưa,
 * và gợi ý reorganize block (block nhiều fact supersede → merge;
 * block quá lớn → split; block toàn fact cũ → archive).
 */
export function buildFleetV13MemoryPanel(
  facts: readonly FleetV13MemoryFact[],
  options: {
    query?: string;
    minConfidence?: number;
    includeQuarantined?: boolean;
    hybridSignals?: Record<string, { vector: number; bm25: number; graph: number; recency: number }>;
    blocks?: { blockId: string; factIds: string[]; lastTouchedAt: number }[];
    now?: number;
  } = {},
): FleetV13MemoryPanel {
  const query = (options.query ?? '').trim().toLowerCase();
  const minConfidence = options.minConfidence ?? 0;
  const includeQuarantined = options.includeQuarantined ?? true;
  const now = options.now ?? Date.now();
  const filtered = facts.filter((f) => {
    if (f.confidence < minConfidence) return false;
    if (!includeQuarantined && f.quarantined) return false;
    if (query && !f.text.toLowerCase().includes(query)) return false;
    return true;
  });
  const rows = filtered
    .map(toMemoryRow)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
    .slice(0, FLEET_V13_MAX_MEMORY_FACTS);
  const activeCount = rows.filter((r) => r.active).length;
  const supersededCount = rows.filter((r) => !!r.supersededBy).length;
  const quarantinedCount = rows.filter((r) => r.quarantined).length;

  const hybridTop: FleetV13HybridScore[] = [];
  if (options.hybridSignals) {
    for (const f of facts) {
      const signals = options.hybridSignals[f.id];
      if (!signals) continue;
      hybridTop.push(scoreFleetV13Hybrid(f, signals));
    }
    hybridTop.sort((a, b) => b.score - a.score);
  }

  const reorganizePlans: FleetV13ReorganizePlan[] = [];
  for (const block of options.blocks ?? []) {
    const blockFacts = facts.filter((f) => block.factIds.includes(f.id));
    if (blockFacts.length === 0) continue;
    const superseded = blockFacts.filter((f) => !!f.supersededBy).length;
    const idleDays = (now - block.lastTouchedAt) / (24 * 60 * 60 * 1000);
    if (blockFacts.length >= 20) {
      reorganizePlans.push({
        blockId: block.blockId,
        action: 'split',
        reason: `block có ${blockFacts.length} fact (quá lớn) — tách thành block nhỏ hơn lúc idle`,
        factCount: blockFacts.length,
      });
    } else if (superseded >= Math.ceil(blockFacts.length / 2) && blockFacts.length >= 4) {
      reorganizePlans.push({
        blockId: block.blockId,
        action: 'merge',
        reason: `block có ${superseded}/${blockFacts.length} fact đã supersede — gom fact còn hiệu lực lại`,
        factCount: blockFacts.length,
      });
    } else if (idleDays > 90 && blockFacts.length > 0) {
      reorganizePlans.push({
        blockId: block.blockId,
        action: 'archive',
        reason: `block không chạm tới ${Math.floor(idleDays)} ngày — archive lúc idle`,
        factCount: blockFacts.length,
      });
    } else {
      reorganizePlans.push({
        blockId: block.blockId,
        action: 'none',
        reason: 'block đang ổn, không cần reorganize',
        factCount: blockFacts.length,
      });
    }
  }

  return {
    facts: rows,
    totalFacts: facts.length,
    activeCount,
    supersededCount,
    quarantinedCount,
    hybridTop: hybridTop.slice(0, FLEET_V13_MAX_HYBRID_RESULTS),
    reorganizePlans,
    summary:
      facts.length === 0
        ? 'Chưa có fact memory nào.'
        : `${facts.length} fact: ${activeCount} còn hiệu lực, ${supersededCount} đã supersede, ` +
          `${quarantinedCount} đang quarantine; ${reorganizePlans.filter((p) => p.action !== 'none').length} block cần reorganize lúc idle.`,
  };
}

// ---------------------------------------------------------------------------
// Router v2 panel
// ---------------------------------------------------------------------------

/** Một model trong router (trạng thái load + chi phí, do T3 cung cấp). */
export interface FleetV13RouterModel {
  modelId: string;
  kind: 'local' | 'cloud';
  status: 'loaded' | 'loading' | 'unloaded' | 'error';
  ramMb: number;
  vramMb: number;
  /** Số request đã phục vụ từ lúc load. */
  requestsServed: number;
  /** Epoch ms load lần cuối (null = chưa load). */
  loadedAt: number | null;
  /** Epoch ms request cuối (null = chưa phục vụ). */
  lastUsedAt: number | null;
  /** Chi phí ước tính mỗi 1k token (USD, 0 = local miễn phí). */
  costPer1kUsd: number;
  /** Độ trễ trung bình (ms, null = chưa đo). */
  avgLatencyMs: number | null;
  /** Chất lượng (0..1, do eval/config — caller cung cấp). */
  qualityScore: number;
  /** Nhóm swap (model cùng nhóm được chia GPU, llama-swap). */
  swapGroup: string;
}

/** Điểm model picker v2 cho một task. */
export interface FleetV13ModelPickScore {
  modelId: string;
  score: number;
  costScore: number;
  latencyScore: number;
  qualityScore: number;
  fitScore: number;
  reason: string;
}

/** Kế hoạch unload LRU + TTL của một model. */
export interface FleetV13UnloadPlan {
  modelId: string;
  action: 'keep' | 'unload-lru' | 'unload-ttl' | 'unload-error';
  reason: string;
  idleMs: number | null;
}

/** View-model panel Router v2. */
export interface FleetV13RouterPanel {
  models: FleetV13RouterModel[];
  loadedCount: number;
  totalRamMb: number;
  totalVramMb: number;
  picks: FleetV13ModelPickScore[];
  unloadPlans: FleetV13UnloadPlan[];
  swapGroups: { group: string; modelIds: string[]; totalRamMb: number }[];
  summary: string;
}

/** TTL idle mặc định: model không dùng 30 phút thì unload. */
export const FLEET_V13_ROUTER_TTL_MS = 30 * 60 * 1000;
/** Tối đa model load cùng lúc (llama.cpp --models-max). */
export const FLEET_V13_ROUTER_MAX_LOADED = 4;

/**
 * Chấm điểm model cho một task: cost (rẻ hơn điểm cao hơn),
 * latency (nhanh hơn điểm cao hơn), quality (cao hơn điểm cao
 * hơn), fit (model đang loaded + đúng kind task cần được cộng
 * điểm). Trọng số mặc định cost 0.25 / latency 0.25 / quality
 * 0.3 / fit 0.2. Model lỗi/unloaded bị phạt nặng nhưng không loại
 * hẳn (để UI vẫn thấy lý do).
 */
export function scoreFleetV13ModelPick(
  model: FleetV13RouterModel,
  task: { kind: string; needsLocal: boolean; maxCostPer1kUsd: number; maxLatencyMs: number },
  cheapestCost: number,
  fastestLatency: number,
): FleetV13ModelPickScore {
  const costScore =
    task.maxCostPer1kUsd <= 0
      ? 1
      : clamp01(1 - Math.max(0, model.costPer1kUsd - cheapestCost) / Math.max(1, task.maxCostPer1kUsd));
  const latencyScore =
    model.avgLatencyMs === null
      ? 0.5
      : clamp01(1 - Math.max(0, model.avgLatencyMs - fastestLatency) / Math.max(1, task.maxLatencyMs));
  const qualityScore = clamp01(model.qualityScore);
  let fitScore = 0.5;
  if (task.needsLocal && model.kind === 'local') fitScore = 1;
  else if (!task.needsLocal && model.kind === 'cloud') fitScore = 0.8;
  else if (task.needsLocal && model.kind === 'cloud') fitScore = 0;
  if (model.status === 'loaded') fitScore = Math.min(1, fitScore + 0.2);
  let score = 0.25 * costScore + 0.25 * latencyScore + 0.3 * qualityScore + 0.2 * fitScore;
  if (model.status === 'error') score *= 0.3;
  else if (model.status === 'unloaded') score *= 0.85;
  return {
    modelId: model.modelId,
    score: Math.round(score * 1000) / 1000,
    costScore: Math.round(costScore * 1000) / 1000,
    latencyScore: Math.round(latencyScore * 1000) / 1000,
    qualityScore: Math.round(qualityScore * 1000) / 1000,
    fitScore: Math.round(fitScore * 1000) / 1000,
    reason:
      `cost ${(costScore * 100).toFixed(0)}%, latency ${(latencyScore * 100).toFixed(0)}%, ` +
      `quality ${(qualityScore * 100).toFixed(0)}%, fit ${(fitScore * 100).toFixed(0)}%` +
      (model.status !== 'loaded' ? ` (model ${model.status})` : ''),
  };
}

/**
 * Kế hoạch unload: model lỗi → unload-error ngay; model loaded quá
 * TTL không dùng → unload-ttl; khi vượt số model tối đa thì model
 * ít dùng nhất (LRU) → unload-lru; còn lại keep.
 */
export function planFleetV13Unload(
  models: readonly FleetV13RouterModel[],
  now = Date.now(),
  ttlMs: number = FLEET_V13_ROUTER_TTL_MS,
  maxLoaded: number = FLEET_V13_ROUTER_MAX_LOADED,
): FleetV13UnloadPlan[] {
  const loaded = models.filter((m) => m.status === 'loaded');
  const byLastUsed = [...loaded].sort(
    (a, b) => (a.lastUsedAt ?? a.loadedAt ?? 0) - (b.lastUsedAt ?? b.loadedAt ?? 0),
  );
  const lruToUnload = new Set<string>();
  if (loaded.length > maxLoaded) {
    for (let i = 0; i < loaded.length - maxLoaded; i++) {
      lruToUnload.add(byLastUsed[i].modelId);
    }
  }
  return models.map((m) => {
    const idleMs =
      m.status === 'loaded' && m.lastUsedAt !== null ? now - m.lastUsedAt : null;
    if (m.status === 'error') {
      return { modelId: m.modelId, action: 'unload-error' as const, reason: 'model đang lỗi — unload để load lại sạch', idleMs };
    }
    if (m.status === 'loaded' && idleMs !== null && idleMs >= ttlMs) {
      return {
        modelId: m.modelId,
        action: 'unload-ttl' as const,
        reason: `không dùng ${Math.round(idleMs / 60000)} phút (TTL ${Math.round(ttlMs / 60000)} phút) — unload để giải phóng RAM/VRAM`,
        idleMs,
      };
    }
    if (lruToUnload.has(m.modelId)) {
      return {
        modelId: m.modelId,
        action: 'unload-lru' as const,
        reason: `vượt ${maxLoaded} model load cùng lúc — model ít dùng nhất (LRU) được unload`,
        idleMs,
      };
    }
    return { modelId: m.modelId, action: 'keep' as const, reason: 'giữ loaded', idleMs };
  });
}

/** Build panel Router v2: picker scores + unload plan + swap groups. */
export function buildFleetV13RouterPanel(
  models: readonly FleetV13RouterModel[],
  task: { kind: string; needsLocal: boolean; maxCostPer1kUsd: number; maxLatencyMs: number },
  now = Date.now(),
): FleetV13RouterPanel {
  const loaded = models.filter((m) => m.status === 'loaded');
  const totalRamMb = loaded.reduce((n, m) => n + m.ramMb, 0);
  const totalVramMb = loaded.reduce((n, m) => n + m.vramMb, 0);
  const cheapestCost = Math.min(...models.map((m) => m.costPer1kUsd), 0);
  const latencies = models.map((m) => m.avgLatencyMs).filter((x): x is number => x !== null);
  const fastestLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
  const picks = models
    .map((m) => scoreFleetV13ModelPick(m, task, cheapestCost, fastestLatency))
    .sort((a, b) => b.score - a.score);
  const unloadPlans = planFleetV13Unload(models, now);
  const groupMap = new Map<string, FleetV13RouterModel[]>();
  for (const m of models) {
    const group = m.swapGroup.trim() || '(không nhóm)';
    const list = groupMap.get(group) ?? [];
    list.push(m);
    groupMap.set(group, list);
  }
  const swapGroups = [...groupMap.entries()]
    .map(([group, list]) => ({
      group,
      modelIds: list.map((m) => m.modelId).sort(),
      totalRamMb: list.reduce((n, m) => n + m.ramMb, 0),
    }))
    .sort((a, b) => a.group.localeCompare(b.group));
  return {
    models: [...models].sort((a, b) => a.modelId.localeCompare(b.modelId)),
    loadedCount: loaded.length,
    totalRamMb,
    totalVramMb,
    picks,
    unloadPlans,
    swapGroups,
    summary:
      models.length === 0
        ? 'Router chưa có model nào.'
        : `${loaded.length}/${models.length} model đang load (${totalRamMb} MB RAM, ${totalVramMb} MB VRAM); ` +
          `gợi ý tốt nhất cho task "${task.kind}": ${picks[0]?.modelId ?? '(không có)'}; ` +
          `${unloadPlans.filter((p) => p.action !== 'keep').length} model nên unload.`,
  };
}

// ---------------------------------------------------------------------------
// Voice v15 panel
// ---------------------------------------------------------------------------

/** Ngân sách từng tầng pipeline voice (ms) — ngưỡng hội thoại tự nhiên. */
export const FLEET_V13_VOICE_BUDGETS_MS: Readonly<Record<string, number>> = {
  vad: 150,
  stt: 300,
  llm: 800,
  tts: 200,
  orchestrator: 50,
};

/** Tầng pipeline voice v15. */
export type FleetV13VoiceStage = 'vad' | 'stt' | 'llm' | 'tts' | 'orchestrator';

export const FLEET_V13_VOICE_STAGES: readonly FleetV13VoiceStage[] = [
  'vad',
  'stt',
  'llm',
  'tts',
  'orchestrator',
];

/** Đo thực tế một tầng trong một turn hội thoại. */
export interface FleetV13VoiceStageMeasure {
  stage: FleetV13VoiceStage;
  /** Thời gian đo được (ms). */
  measuredMs: number;
  /** Ngân sách của tầng (ms). */
  budgetMs: number;
}

/** Một turn hội thoại (đo từng tầng). */
export interface FleetV13VoiceTurn {
  turnId: string;
  at: number;
  stages: FleetV13VoiceStageMeasure[];
  /** true = user ngắt lời (barge-in) trong turn này. */
  bargedIn: boolean;
  /** true = turn kết thúc đúng lúc (semantic turn-taking), false = VAD cắt sớm/muộn. */
  cleanTurnEnd: boolean;
}

/** Một dòng budget trong panel voice. */
export interface FleetV13VoiceBudgetRow {
  stage: FleetV13VoiceStage;
  budgetMs: number;
  avgMs: number | null;
  p95Ms: number | null;
  overBudgetTurns: number;
  totalTurns: number;
  alert: boolean;
  detail: string;
}

/** View-model panel Voice v15. */
export interface FleetV13VoicePanel {
  budgets: FleetV13VoiceBudgetRow[];
  turnCount: number;
  bargeInCount: number;
  cleanTurnRate: number | null;
  /** Tổng end-to-end trung bình (ms, cộng các tầng). */
  avgEndToEndMs: number | null;
  /** true = end-to-end trung bình vượt 600ms (ngưỡng speech-to-speech). */
  endToEndAlert: boolean;
  summary: string;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Build panel Voice v15: trung bình + p95 từng tầng, đếm turn vượt
 * ngân sách, tỉ lệ barge-in / clean turn-end, end-to-end trung bình
 * (cộng 5 tầng). Alert khi p95 vượt ngân sách hoặc end-to-end trung
 * bình vượt 600ms.
 */
export function buildFleetV13VoicePanel(turns: readonly FleetV13VoiceTurn[]): FleetV13VoicePanel {
  const budgets: FleetV13VoiceBudgetRow[] = FLEET_V13_VOICE_STAGES.map((stage) => {
    const budgetMs = FLEET_V13_VOICE_BUDGETS_MS[stage];
    const values: number[] = [];
    let overBudgetTurns = 0;
    let totalTurns = 0;
    for (const turn of turns) {
      const measure = turn.stages.find((s) => s.stage === stage);
      if (!measure) continue;
      totalTurns++;
      values.push(measure.measuredMs);
      if (measure.measuredMs > (measure.budgetMs || budgetMs)) overBudgetTurns++;
    }
    values.sort((a, b) => a - b);
    const avgMs = values.length > 0 ? Math.round(values.reduce((n, v) => n + v, 0) / values.length) : null;
    const p95Ms = percentile(values, 95);
    const alert = p95Ms !== null && p95Ms > budgetMs;
    return {
      stage,
      budgetMs,
      avgMs,
      p95Ms,
      overBudgetTurns,
      totalTurns,
      alert,
      detail:
        totalTurns === 0
          ? `chưa có đo cho tầng ${stage} (ngân sách ${budgetMs}ms)`
          : `trung bình ${avgMs}ms, p95 ${p95Ms}ms (ngân sách ${budgetMs}ms), ${overBudgetTurns}/${totalTurns} turn vượt`,
    };
  });
  const bargeInCount = turns.filter((t) => t.bargedIn).length;
  const cleanTurns = turns.filter((t) => t.cleanTurnEnd).length;
  const cleanTurnRate = turns.length > 0 ? Math.round((cleanTurns / turns.length) * 1000) / 1000 : null;
  const endToEnds = turns.map((t) => t.stages.reduce((n, s) => n + s.measuredMs, 0));
  const avgEndToEndMs =
    endToEnds.length > 0 ? Math.round(endToEnds.reduce((n, v) => n + v, 0) / endToEnds.length) : null;
  const endToEndAlert = avgEndToEndMs !== null && avgEndToEndMs > 600;
  return {
    budgets,
    turnCount: turns.length,
    bargeInCount,
    cleanTurnRate,
    avgEndToEndMs,
    endToEndAlert,
    summary:
      turns.length === 0
        ? 'Chưa có turn hội thoại nào để đo voice pipeline.'
        : `${turns.length} turn: end-to-end trung bình ${avgEndToEndMs}ms ` +
          `(ngưỡng speech-to-speech 600ms), ${bargeInCount} lần barge-in, ` +
          `turn kết thúc sạch ${cleanTurnRate !== null ? (cleanTurnRate * 100).toFixed(0) : '?'}%; ` +
          `${budgets.filter((b) => b.alert).length} tầng vượt ngân sách ở p95.`,
  };
}

// ---------------------------------------------------------------------------
// Fleet v13 panel (gom node + capacity + rebalance + event + rollout)
// ---------------------------------------------------------------------------

/** Một dòng node trong panel Fleet v13. */
export interface FleetV13PanelNodeRow {
  nodeId: string;
  pinnedModels: string[];
  modelCount: number;
  ramUsedFraction: number;
  vramUsedFraction: number;
  overloaded: boolean;
  headroomRamMb: number;
}

/** View-model panel Fleet v13. */
export interface FleetV13Panel {
  nodes: FleetV13PanelNodeRow[];
  capacity: FleetV13CapacityReport;
  rebalance: {
    fromNodeId: string;
    toNodeId: string;
    modelId: string;
    reason: string;
  }[];
  events: FleetV13Event[];
  rollouts: { id: string; feature: string; version: string; stage: string; stageLabel: string }[];
  summary: string;
}

/** Build panel Fleet v13 từ snapshot pin + event log + rollout đang chạy. */
export function buildFleetV13Panel(
  snapshot: FleetV13PinSnapshot,
  events: readonly FleetV13Event[],
  rollouts: readonly TeamV13Rollout[] = [],
  maxEvents = 50,
): FleetV13Panel {
  const capacity = buildFleetV13CapacityReport(snapshot);
  const nodes: FleetV13PanelNodeRow[] = capacity.nodes.map((n) => ({
    nodeId: n.nodeId,
    pinnedModels: fleetV13PinsOfNode(snapshot, n.nodeId).map((p) => p.modelId),
    modelCount: n.modelCount,
    ramUsedFraction: Math.round(n.ramUsedFraction * 1000) / 1000,
    vramUsedFraction: Math.round(n.vramUsedFraction * 1000) / 1000,
    overloaded: n.overloaded,
    headroomRamMb: n.headroomRamMb,
  }));
  const rebalance = suggestFleetV13Rebalance(snapshot, capacity).map((s) => ({
    fromNodeId: s.fromNodeId,
    toNodeId: s.toNodeId,
    modelId: s.modelId,
    reason: s.reason,
  }));
  const recentEvents = [...events]
    .sort((a, b) => b.at - a.at || b.seq - a.seq)
    .slice(0, Math.max(1, maxEvents));
  return {
    nodes,
    capacity,
    rebalance,
    events: recentEvents,
    rollouts: rollouts.map((r) => ({
      id: r.id,
      feature: r.feature,
      version: r.version,
      stage: r.stage,
      stageLabel: teamV13StageLabel(r.stage),
    })),
    summary:
      nodes.length === 0
        ? 'Fleet v13 chưa có node nào.'
        : `Fleet v13: ${nodes.length} node, ${snapshot.pins.length} pin model, ` +
          `${capacity.overloadedNodes.length} node quá tải, ${rebalance.length} gợi ý rebalance, ` +
          `${rollouts.length} rollout đang theo dõi.`,
  };
}

/** Validate một panel Fleet v13 có đủ dữ liệu hiển thị (cho test renderer). */
export function validateFleetV13Panel(panel: FleetV13Panel): string[] {
  const errors: string[] = [];
  if (!Array.isArray(panel.nodes)) errors.push('panel.nodes phải là mảng');
  if (!panel.capacity || typeof panel.capacity.nodeCount !== 'number') {
    errors.push('panel.capacity thiếu hoặc không hợp lệ');
  }
  if (!Array.isArray(panel.rebalance)) errors.push('panel.rebalance phải là mảng');
  if (!Array.isArray(panel.events)) errors.push('panel.events phải là mảng');
  if (!Array.isArray(panel.rollouts)) errors.push('panel.rollouts phải là mảng');
  return errors;
}
