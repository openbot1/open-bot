/**
 * Tiered compaction — billion-context style layered summaries
 * (context engineering v2, v1.05 Team T4).
 *
 * One flat summary loses the session. Three tiers keep it:
 *
 *   Tier 1 — per-turn summaries: the most recent turns, one short
 *     summary each (still close to the source, still citable).
 *   Tier 2 — topic/chunk summaries: tier-1 summaries grouped by
 *     topic (keyword overlap) and rolled up into one summary per
 *     topic, covering a chunk of the session.
 *   Tier 3 — session summary: tier-2 summaries rolled up into a
 *     single whole-session summary.
 *
 * Every tier keeps its anchors verbatim (see `anchors.ts`): a
 * decision, a metric, a changed file or a user constraint is never
 * compressed away — it is carried forward with its source ids.
 * Roll-up is deterministic and extractive (first lines + topic
 * lines, via the v1.02 `buildExtractiveSummary`), never model-based,
 * so the same input always compacts to the same tiers.
 *
 * `TierRetentionPolicy` decides what survives: how many tier-1
 * summaries to keep, how many topics per tier-2, which anchor kinds
 * each tier keeps, and the maximum tier a bot may build. The policy
 * is per bot (see `compactionPolicy.ts`).
 */

import { randomUUID } from 'node:crypto';

import {
  extractAnchors,
  filterAnchors,
  type Anchor,
  type AnchorKind,
  type AnchorSourceMessage,
} from './anchors';
import { buildExtractiveSummary, type PrunableMessage } from './pruning';
import { estimateTokens } from './estimator';

/** A turn that can be compacted (id-stable so summaries can cite it). */
export interface CompactableTurn extends PrunableMessage {
  /** Stable turn id (used as the citation source id). */
  id: string;
  /** Turn index in the session (0-based). */
  turnIndex: number;
  at?: string;
}

/** Compaction tier: 1 = per-turn, 2 = per-topic, 3 = whole session. */
export type CompactionTier = 1 | 2 | 3;

/** One summary at one tier, with citations and its anchors. */
export interface TierSummary {
  id: string;
  tier: CompactionTier;
  /** Short topic label for tier 2 (e.g. "database, index"); '' otherwise. */
  topic: string;
  text: string;
  /** Ids of the source turns / summaries this was rolled up from. */
  sourceIds: string[];
  /** Anchors carried verbatim through this tier. */
  anchors: Anchor[];
  createdAt: string;
  tokenEstimate: number;
}

/** What a tier keeps, and what it drops. */
export interface TierRetentionPolicy {
  /** Max tier-1 summaries kept (oldest roll up to tier 2 first). */
  maxTier1Summaries: number;
  /** Max tier-2 topic summaries kept (oldest roll up to tier 3 first). */
  maxTier2Summaries: number;
  /** Max tier-3 summaries kept (oldest dropped; tier 3 is the last stop). */
  maxTier3Summaries: number;
  /** Anchor kinds each tier keeps (tier 1 keeps all by default). */
  keepAnchorKinds: Record<CompactionTier, AnchorKind[]>;
  /** Max chars of extractive text per summary (before anchors). */
  maxSummaryChars: number;
}

/** Default retention: generous at tier 1, tight at tier 3. */
export const DEFAULT_TIER_RETENTION: TierRetentionPolicy = {
  maxTier1Summaries: 12,
  maxTier2Summaries: 8,
  maxTier3Summaries: 2,
  keepAnchorKinds: {
    1: ['decision', 'metric', 'file-change', 'constraint', 'fact'],
    2: ['decision', 'metric', 'file-change', 'constraint'],
    3: ['decision', 'constraint'],
  },
  maxSummaryChars: 2000,
};

/** Result of compacting one batch of turns. */
export interface TieredCompactionResult {
  /** Tier-1 summaries built from the input turns. */
  tier1: TierSummary[];
  /** Tier-2 summaries built by rolling up tier 1 (empty when too few). */
  tier2: TierSummary[];
  /** Tier-3 summary built by rolling up tier 2 (empty when too few). */
  tier3: TierSummary | null;
  /** Anchors found in the input turns. */
  anchors: Anchor[];
  /** Turns the compaction consumed (caller may drop them). */
  consumedTurnIds: string[];
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
}

function summaryFromText(
  tier: CompactionTier,
  topic: string,
  text: string,
  sourceIds: string[],
  anchors: Anchor[],
): TierSummary {
  return {
    id: `tier${tier}-${randomUUID()}`,
    tier,
    topic,
    text,
    sourceIds,
    anchors,
    createdAt: new Date().toISOString(),
    tokenEstimate: estimateTokens(text) + anchors.reduce((sum, a) => sum + estimateTokens(a.text), 0),
  };
}

/** Stop words for topic keywords (English + Vietnamese). */
const TOPIC_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'what', 'how', 'why', 'when',
  'là', 'của', 'và', 'có', 'không', 'cho', 'với', 'trong', 'này', 'đó', 'làm', 'để', 'tôi', 'bạn',
]);

function topicKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3 && !TOPIC_STOP_WORDS.has(word)),
  );
}

/** The 2 most frequent keywords of a text, as its topic label. */
export function topicLabelFor(text: string): string {
  const counts = new Map<string, number>();
  for (const word of topicKeywords(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([word]) => word)
    .join(', ');
}

/**
 * Group tier-1 summaries into topics: a summary joins the topic it
 * shares the most keywords with (min 1 shared keyword), otherwise
 * it starts a new topic. Topics are labelled by their top keywords.
 */
export function groupSummariesByTopic(summaries: TierSummary[]): Map<string, TierSummary[]> {
  const topics = new Map<string, { keywords: Set<string>; items: TierSummary[] }>();
  for (const summary of summaries) {
    const keywords = topicKeywords(summary.text);
    let bestTopic: string | null = null;
    let bestOverlap = 0;
    for (const [label, topic] of topics) {
      let overlap = 0;
      for (const word of keywords) if (topic.keywords.has(word)) overlap++;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestTopic = label;
      }
    }
    if (bestTopic === null || bestOverlap === 0) {
      const label = topicLabelFor(summary.text) || `topic-${topics.size + 1}`;
      topics.set(label, { keywords, items: [summary] });
    } else {
      const topic = topics.get(bestTopic)!;
      for (const word of keywords) topic.keywords.add(word);
      topic.items.push(summary);
    }
  }
  const grouped = new Map<string, TierSummary[]>();
  for (const [label, topic] of topics) grouped.set(label, topic.items);
  return grouped;
}

/** The tiered compactor: builds tiers from turns and rolls tiers up. */
export class TieredCompactor {
  private readonly retention: TierRetentionPolicy;

  constructor(retention: TierRetentionPolicy = DEFAULT_TIER_RETENTION) {
    this.retention = retention;
  }

  /**
   * Compact a batch of turns into tiers. Tier 1: one summary per
   * turn (extractive). Tier 2: one summary per topic, once there
   * are at least 3 tier-1 summaries. Tier 3: one session summary,
   * once there are at least 2 tier-2 summaries. Anchors are
   * extracted once and carried through every tier that keeps their
   * kind.
   */
  compact(turns: CompactableTurn[]): TieredCompactionResult {
    const tokensBefore = turns.reduce(
      (sum, turn) => sum + estimateTokens(turn.content ?? ''),
      0,
    );
    const anchors = extractAnchors(
      turns.map((turn): AnchorSourceMessage => ({
        id: turn.id,
        role: turn.role,
        content: turn.content,
        turnIndex: turn.turnIndex,
        ...(turn.at ? { at: turn.at } : {}),
      })),
    );
    const tier1 = this.buildTier1(turns, anchors);
    const tier2 = this.buildTier2(tier1, anchors);
    const tier3 = this.buildTier3(tier2, anchors);
    const keptText = [...tier1, ...tier2, ...(tier3 ? [tier3] : [])]
      .map((s) => s.text)
      .join('\n');
    const tokensAfter =
      estimateTokens(keptText) +
      anchors.reduce((sum, a) => sum + estimateTokens(a.text), 0);
    return {
      tier1,
      tier2,
      tier3,
      anchors,
      consumedTurnIds: turns.map((turn) => turn.id),
      tokensBefore,
      tokensAfter,
      tokensSaved: Math.max(0, tokensBefore - tokensAfter),
    };
  }

  /** One extractive summary per turn (tier 1). */
  buildTier1(turns: CompactableTurn[], anchors: Anchor[]): TierSummary[] {
    return turns.map((turn) => {
      const text = buildExtractiveSummary(
        [turn],
        '',
        this.retention.maxSummaryChars,
      );
      const turnAnchors = filterAnchors(
        anchors.filter((a) => a.sourceIds.includes(turn.id)),
        this.retention.keepAnchorKinds[1],
      );
      return summaryFromText(1, '', text || turn.content?.slice(0, 200) || '', [turn.id], turnAnchors);
    });
  }

  /** Roll tier-1 summaries up into one summary per topic (tier 2). */
  buildTier2(tier1: TierSummary[], anchors: Anchor[]): TierSummary[] {
    if (tier1.length < 3) return [];
    const grouped = groupSummariesByTopic(tier1);
    const summaries: TierSummary[] = [];
    for (const [topic, items] of grouped) {
      const text = buildExtractiveSummary(
        items.map((item) => ({ role: 'assistant', content: item.text })),
        topic,
        this.retention.maxSummaryChars,
      );
      const sourceIds = items.flatMap((item) => item.sourceIds);
      const topicAnchors = filterAnchors(
        anchors.filter((a) => a.sourceIds.some((id) => sourceIds.includes(id))),
        this.retention.keepAnchorKinds[2],
      );
      summaries.push(summaryFromText(2, topic, text, sourceIds, topicAnchors));
    }
    return summaries;
  }

  /** Roll tier-2 summaries up into one session summary (tier 3). */
  buildTier3(tier2: TierSummary[], anchors: Anchor[]): TierSummary | null {
    if (tier2.length < 2) return null;
    const text = buildExtractiveSummary(
      tier2.map((item) => ({ role: 'assistant', content: `[${item.topic}] ${item.text}` })),
      '',
      this.retention.maxSummaryChars,
    );
    const sourceIds = tier2.flatMap((item) => item.sourceIds);
    const sessionAnchors = filterAnchors(
      anchors.filter((a) => a.sourceIds.some((id) => sourceIds.includes(id))),
      this.retention.keepAnchorKinds[3],
    );
    return summaryFromText(3, '', text, sourceIds, sessionAnchors);
  }

  /**
   * Apply retention to an existing tier store: oldest tier-1
   * summaries beyond the cap roll up to tier 2, oldest tier-2
   * beyond the cap roll up to tier 3, oldest tier-3 beyond the cap
   * is dropped (its anchors were already carried into the kept
   * tier-3 summaries). Returns the trimmed store.
   */
  applyRetention(store: {
    tier1: TierSummary[];
    tier2: TierSummary[];
    tier3: TierSummary[];
  }): { tier1: TierSummary[]; tier2: TierSummary[]; tier3: TierSummary[]; rolledUp: number; dropped: number } {
    let rolledUp = 0;
    let dropped = 0;
    let tier1 = [...store.tier1];
    let tier2 = [...store.tier2];
    let tier3 = [...store.tier3];
    if (tier1.length > this.retention.maxTier1Summaries) {
      const overflow = tier1.slice(0, tier1.length - this.retention.maxTier1Summaries);
      tier1 = tier1.slice(tier1.length - this.retention.maxTier1Summaries);
      const overflowAnchors = overflow.flatMap((s) => s.anchors);
      const rolled = this.buildTier2(overflow, overflowAnchors);
      tier2 = [...rolled, ...tier2];
      rolledUp += overflow.length;
    }
    if (tier2.length > this.retention.maxTier2Summaries) {
      const overflow = tier2.slice(0, tier2.length - this.retention.maxTier2Summaries);
      tier2 = tier2.slice(tier2.length - this.retention.maxTier2Summaries);
      const overflowAnchors = overflow.flatMap((s) => s.anchors);
      const rolled = this.buildTier3(overflow, overflowAnchors);
      if (rolled) tier3 = [...tier3, rolled];
      rolledUp += overflow.length;
    }
    if (tier3.length > this.retention.maxTier3Summaries) {
      dropped = tier3.length - this.retention.maxTier3Summaries;
      // Tier-3 is chronological (oldest first): keep the newest.
      tier3 = tier3.slice(tier3.length - this.retention.maxTier3Summaries);
    }
    return { tier1, tier2, tier3, rolledUp, dropped };
  }
}
