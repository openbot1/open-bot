/**
 * Sleep-time consolidation có scoring (v1.03, Đội T2 — Memory v4).
 *
 * Ý tưởng học từ Letta "sleep-time agents" (background agent gom
 * memory giữa session, sau N step hoặc khi compact context) nhưng tự
 * thiết kế lại hoàn toàn cho open-bot, chạy 100% local, KHÔNG gọi
 * model: mọi điểm số đều là luật xác định trên episode/fact, tái lập
 * được và không bao giờ "sáng tác" fact mới.
 *
 * Vấn đề của dream pass cũ (dream.ts): mọi fact rút được đều được
 * promote như nhau nếu confidence >= ngưỡng — fact nhắc một lần
 * trong một câu đùa được đối xử ngang fact user nhắc 5 lần trong 3
 * episode khác nhau. Module này thêm LỚP CHẤM ĐIỂM trước khi promote:
 *
 *   score = 0.35·confidence
 *         + 0.25·frequency      (số lần nhắc, bão hoà ở 5)
 *         + 0.20·corroboration  (số episode khác nhau, bão hoà ở 3)
 *         + 0.20·recency        (mới = cao, decay tuyến tính 30 ngày)
 *         − 0.30·contradiction  (mâu thuẫn fact active đang có)
 *   (kẹp 0..1)
 *
 * `runScoredDreamPass` chạy trên các episode CHƯA xử lý của temporal
 * graph: extract (RuleBasedFactExtractor mặc định) → gom nhóm theo
 * fact chuẩn hoá → chấm điểm → chỉ promote top-N fact đủ điểm vào
 * block `human` (qua MemoryBlockStore, như dream.ts) → đánh dấu
 * episode đã xử lý. Fact điểm thấp không bị xoá — nó ở lại episode,
 * lần dream sau vẫn thấy nếu user nhắc lại (frequency tăng dần).
 *
 * Fact mâu thuẫn fact active đang có KHÔNG được promote tự động:
 * nó vào danh sách `contradictions` trong report để host/user xử lý
 * (quarantine đã có ở consolidateGraph — module này chỉ báo, không
 * tự ghi quarantine để tránh trùng lặp hai lần).
 */

import { RuleBasedFactExtractor } from './graph/extract';
import type { FactExtractor } from './graph/extract';
import type { MemoryScope } from './graph/types';
import { normalizeGraphText } from './graph/types';
import type { TemporalGraphStore } from './graph/store';
import { MemoryBlockStore } from './blocks';

/** Trọng số chấm điểm (tổng phần cộng = 1.0). */
export const DREAM_SCORE_WEIGHT_CONFIDENCE = 0.35;
export const DREAM_SCORE_WEIGHT_FREQUENCY = 0.25;
export const DREAM_SCORE_WEIGHT_CORROBORATION = 0.2;
export const DREAM_SCORE_WEIGHT_RECENCY = 0.2;
/** Điểm trừ khi fact mâu thuẫn fact active đang có. */
export const DREAM_SCORE_CONTRADICTION_PENALTY = 0.3;
/** Số lần nhắc để frequency bão hoà. */
export const DREAM_SCORE_FREQUENCY_CAP = 5;
/** Số episode khác nhau để corroboration bão hoà. */
export const DREAM_SCORE_CORROBORATION_CAP = 3;
/** Số ngày để recency decay về 0. */
export const DREAM_SCORE_RECENCY_DAYS = 30;
/** Điểm tối thiểu mặc định để promote một fact vào block human. */
export const DEFAULT_DREAM_MIN_SCORE = 0.5;
/** Số fact tối đa promote trong một lần dream có scoring. */
export const DEFAULT_DREAM_SCORED_MAX_PROMOTE = 10;
/** Số episode chưa xử lý tối đa xét trong một lần chạy. */
export const DEFAULT_DREAM_SCORED_MAX_EPISODES = 50;

/** Đầu vào chấm điểm cho một fact ứng viên. */
export interface DreamScoreInput {
  /** Confidence của extractor (0..1). */
  confidence: number;
  /** Số lần fact được nhắc (mọi episode gộp lại). */
  mentionCount: number;
  /** Số episode khác nhau nhắc tới fact. */
  episodeCount: number;
  /** Lần đầu fact xuất hiện (ISO). */
  firstSeenAt: string;
  /** Lần cuối fact xuất hiện (ISO). */
  lastSeenAt: string;
  /** true = mâu thuẫn fact active đang có trong đồ thị. */
  hasContradiction: boolean;
}

/** Chi tiết từng thành phần điểm. */
export interface DreamScoreBreakdown {
  confidence: number;
  frequency: number;
  corroboration: number;
  recency: number;
  contradictionPenalty: number;
  total: number;
}

/** Chấm điểm một fact ứng viên — thuần hàm, không chạm store. */
export function scoreFactCandidate(input: DreamScoreInput, now: Date = new Date()): DreamScoreBreakdown {
  const confidence = Math.min(Math.max(input.confidence, 0), 1) * DREAM_SCORE_WEIGHT_CONFIDENCE;
  const frequency =
    (Math.min(Math.max(input.mentionCount, 0), DREAM_SCORE_FREQUENCY_CAP) /
      DREAM_SCORE_FREQUENCY_CAP) *
    DREAM_SCORE_WEIGHT_FREQUENCY;
  const corroboration =
    (Math.min(Math.max(input.episodeCount, 0), DREAM_SCORE_CORROBORATION_CAP) /
      DREAM_SCORE_CORROBORATION_CAP) *
    DREAM_SCORE_WEIGHT_CORROBORATION;
  const ageMs = now.getTime() - Date.parse(input.lastSeenAt);
  const ageDays = Number.isFinite(ageMs) ? Math.max(ageMs, 0) / 86_400_000 : DREAM_SCORE_RECENCY_DAYS;
  const recency =
    Math.max(0, 1 - ageDays / DREAM_SCORE_RECENCY_DAYS) * DREAM_SCORE_WEIGHT_RECENCY;
  const contradictionPenalty = input.hasContradiction ? DREAM_SCORE_CONTRADICTION_PENALTY : 0;
  const total = Math.min(
    1,
    Math.max(0, confidence + frequency + corroboration + recency - contradictionPenalty),
  );
  return { confidence, frequency, corroboration, recency, contradictionPenalty, total };
}

/** Một fact ứng viên đã gom nhóm + chấm điểm, sẵn sàng promote. */
export interface ScoredDreamFact {
  /** Text fact chuẩn hoá (key gom nhóm). */
  key: string;
  subjectName: string;
  predicate: string;
  objectText: string;
  /** Confidence cao nhất trong các lần nhắc. */
  confidence: number;
  score: DreamScoreBreakdown;
  mentionCount: number;
  episodeCount: number;
  episodeIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  hasContradiction: boolean;
}

export interface ScoredDreamPassOptions {
  scope: MemoryScope;
  /** Thời điểm chạy (mặc định: bây giờ). */
  now?: Date;
  /** Điểm tối thiểu để promote (mặc định 0.5). */
  minScore?: number;
  /** Số fact tối đa promote (mặc định 10). */
  maxPromote?: number;
  /** Số episode chưa xử lý tối đa xét (mặc định 50). */
  maxEpisodes?: number;
  /** Extractor (mặc định RuleBasedFactExtractor). */
  extractor?: FactExtractor;
  /** Label block nhận fact (mặc định 'human'). */
  humanBlockLabel?: string;
  /** Actor ghi audit block (mặc định 'dream:scored'). */
  actor?: string;
}

/** Báo cáo một lần dream có scoring. */
export interface ScoredDreamReport {
  ranAt: string;
  episodesSeen: number;
  candidatesScored: number;
  promoted: number;
  skippedLowScore: number;
  contradictions: number;
  /** Fact đã promote (điểm cao -> thấp). */
  promotedFacts: ScoredDreamFact[];
  /** Mọi fact đã chấm điểm (điểm cao -> thấp, kể cả chưa promote). */
  scoredFacts: ScoredDreamFact[];
  details: string[];
}

/**
 * Gom nhóm các ứng viên thô theo fact chuẩn hoá, đếm mention/episode,
 * chấm điểm từng nhóm. Thuần hàm trên dữ liệu đã extract — tách riêng
 * để test được mà không cần store.
 */
export function groupAndScoreCandidates(
  candidates: Array<{
    subjectName: string;
    predicate: string;
    objectText: string;
    confidence: number;
    episodeId: string;
    at: string;
  }>,
  hasContradiction: (subjectName: string, predicate: string, objectText: string) => boolean,
  now: Date = new Date(),
): ScoredDreamFact[] {
  const groups = new Map<
    string,
    {
      subjectName: string;
      predicate: string;
      objectText: string;
      confidence: number;
      mentionCount: number;
      episodeIds: Set<string>;
      firstSeenAt: string;
      lastSeenAt: string;
    }
  >();
  for (const c of candidates) {
    const key = normalizeGraphText(`${c.subjectName} ${c.predicate} ${c.objectText}`);
    if (key === '') continue;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        subjectName: c.subjectName,
        predicate: c.predicate,
        objectText: c.objectText,
        confidence: c.confidence,
        mentionCount: 1,
        episodeIds: new Set([c.episodeId]),
        firstSeenAt: c.at,
        lastSeenAt: c.at,
      });
      continue;
    }
    existing.confidence = Math.max(existing.confidence, c.confidence);
    existing.mentionCount += 1;
    existing.episodeIds.add(c.episodeId);
    if (c.at < existing.firstSeenAt) existing.firstSeenAt = c.at;
    if (c.at > existing.lastSeenAt) existing.lastSeenAt = c.at;
  }
  const out: ScoredDreamFact[] = [];
  for (const [key, g] of groups) {
    const contradiction = hasContradiction(g.subjectName, g.predicate, g.objectText);
    const score = scoreFactCandidate(
      {
        confidence: g.confidence,
        mentionCount: g.mentionCount,
        episodeCount: g.episodeIds.size,
        firstSeenAt: g.firstSeenAt,
        lastSeenAt: g.lastSeenAt,
        hasContradiction: contradiction,
      },
      now,
    );
    out.push({
      key,
      subjectName: g.subjectName,
      predicate: g.predicate,
      objectText: g.objectText,
      confidence: g.confidence,
      score,
      mentionCount: g.mentionCount,
      episodeCount: g.episodeIds.size,
      episodeIds: [...g.episodeIds],
      firstSeenAt: g.firstSeenAt,
      lastSeenAt: g.lastSeenAt,
      hasContradiction: contradiction,
    });
  }
  out.sort((a, b) => b.score.total - a.score.total || b.mentionCount - a.mentionCount);
  return out;
}

/**
 * Một lần dream có scoring trên temporal graph: extract từ episode
 * chưa xử lý → gom nhóm + chấm điểm → promote top-N đủ điểm vào
 * block human → đánh dấu episode đã xử lý.
 */
export async function runScoredDreamPass(
  graphStore: TemporalGraphStore,
  blocksStore: MemoryBlockStore,
  opts: ScoredDreamPassOptions,
): Promise<ScoredDreamReport> {
  const now = opts.now ?? new Date();
  const minScore = opts.minScore ?? DEFAULT_DREAM_MIN_SCORE;
  const maxPromote = opts.maxPromote ?? DEFAULT_DREAM_SCORED_MAX_PROMOTE;
  const maxEpisodes = opts.maxEpisodes ?? DEFAULT_DREAM_SCORED_MAX_EPISODES;
  const extractor = opts.extractor ?? new RuleBasedFactExtractor();
  const humanLabel = opts.humanBlockLabel ?? 'human';
  const actor = opts.actor ?? 'dream:scored';

  const episodes = graphStore.listUnprocessedEpisodes(opts.scope, maxEpisodes);
  const raw: Array<{
    subjectName: string;
    predicate: string;
    objectText: string;
    confidence: number;
    episodeId: string;
    at: string;
  }> = [];
  for (const ep of episodes) {
    const candidates = await extractor.extract(ep.text, opts.scope, ep.text.slice(0, 500));
    for (const c of candidates) {
      raw.push({
        subjectName: c.subjectName,
        predicate: c.predicate,
        objectText: c.objectText,
        confidence: c.confidence,
        episodeId: ep.id,
        at: ep.createdAt,
      });
    }
  }

  const scored = groupAndScoreCandidates(raw, (subject, predicate, objectText) => {
    const existing = graphStore.findActiveFacts(subject, predicate, opts.scope);
    return existing.some(
      (f) => normalizeGraphText(f.objectText ?? '') !== normalizeGraphText(objectText),
    );
  }, now);

  const details: string[] = [];
  const promotedFacts: ScoredDreamFact[] = [];
  let skippedLowScore = 0;
  let contradictions = 0;
  for (const fact of scored) {
    if (fact.hasContradiction) {
      contradictions += 1;
      details.push(
        `Mâu thuẫn — không promote: ${fact.subjectName} ${fact.predicate} ${fact.objectText} (điểm ${fact.score.total.toFixed(2)})`,
      );
      continue;
    }
    if (fact.score.total < minScore || promotedFacts.length >= maxPromote) {
      skippedLowScore += 1;
      continue;
    }
    try {
      const block = blocksStore.ensureBlock(
        humanLabel,
        { description: 'Stable facts about the user.' },
        actor,
      );
      const line = `- ${fact.subjectName} ${fact.predicate.replace(/_/g, ' ')} ${fact.objectText}`;
      if (!block.content.includes(fact.objectText)) {
        blocksStore.append(humanLabel, line, actor);
        promotedFacts.push(fact);
        details.push(`Promote (${fact.score.total.toFixed(2)}): ${line}`);
      } else {
        skippedLowScore += 1;
      }
    } catch {
      // Block đầy hoặc read-only — không fail cả lần dream.
      skippedLowScore += 1;
    }
  }

  // Đánh dấu mọi episode đã xét là processed (kể cả khi fact của nó
  // chưa đủ điểm — lần sau nhắc lại sẽ tăng frequency, không xét lại
  // cùng episode hai lần).
  for (const ep of episodes) {
    graphStore.markEpisodeProcessed(ep.id, []);
  }

  return {
    ranAt: now.toISOString(),
    episodesSeen: episodes.length,
    candidatesScored: scored.length,
    promoted: promotedFacts.length,
    skippedLowScore,
    contradictions,
    promotedFacts,
    scoredFacts: scored,
    details,
  };
}
