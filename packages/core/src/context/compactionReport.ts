/**
 * Compaction report — one audit record per compaction round
 * (context engineering v2, v1.05 Team T4).
 *
 * A round is only trustworthy if it can be audited afterwards:
 * what went in (turns, tokens), what came out (tiers, anchors),
 * whether the summaries verified, what was evicted, and what the
 * window looked like after. `buildCompactionReport` assembles that
 * record from a `TieredCompactionResult` + the runtime state; the
 * caller appends it to `CompactionHistory` (as a `CompactionRecord`
 * with reason 'long-run') and/or renders it with
 * `compactionReportMarkdown` for the UI, logs, or the inspector.
 *
 * Reports are pure data — no I/O here, so the agent loop can build
 * one every round for free.
 */

import type { TieredCompactionResult } from './tieredCompaction';
import type { VerifiedSummary } from './verifiedSummary';
import type { WindowStats } from './windowManager';

/** One auditable compaction round. */
export interface CompactionReport {
  id: string;
  at: string;
  botId: string;
  runId?: string;
  trigger: 'manual' | 'scheduled' | 'over-trigger';
  turnsCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  savedRatio: number;
  tier1Summaries: number;
  tier2Summaries: number;
  tier3Summary: boolean;
  anchorsKept: number;
  anchorsByKind: Record<string, number>;
  /** Verified-summary stats across all tiers. */
  verifiedClaims: number;
  verifiedRatio: number;
  contradictedClaims: number;
  unverifiableClaims: number;
  segmentsCreated: number;
  segmentsEvicted: number;
  evictedSegmentIds: string[];
  thresholdAlerts: string[];
  windowAfter: { usedTokens: number; limit: number; usageRatio: number };
}

/** Build a report from a compaction round + runtime state. */
export function buildCompactionReport(input: {
  botId: string;
  runId?: string;
  trigger: CompactionReport['trigger'];
  compaction: TieredCompactionResult;
  verified: VerifiedSummary[];
  segmentIds: string[];
  evictedSegmentIds: string[];
  thresholdAlerts: string[];
  windowAfter: WindowStats;
}): CompactionReport {
  const { compaction, verified } = input;
  const anchorsByKind: Record<string, number> = {};
  for (const anchor of compaction.anchors) {
    anchorsByKind[anchor.kind] = (anchorsByKind[anchor.kind] ?? 0) + 1;
  }
  let verifiedClaims = 0;
  let verifiedOk = 0;
  let contradicted = 0;
  let unverifiable = 0;
  for (const summary of verified) {
    for (const claim of summary.claims) {
      verifiedClaims++;
      if (claim.status === 'verified') verifiedOk++;
      else if (claim.status === 'contradicted') contradicted++;
      else unverifiable++;
    }
  }
  return {
    id: `compact-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    at: new Date().toISOString(),
    botId: input.botId,
    ...(input.runId ? { runId: input.runId } : {}),
    trigger: input.trigger,
    turnsCompacted: compaction.consumedTurnIds.length,
    tokensBefore: compaction.tokensBefore,
    tokensAfter: compaction.tokensAfter,
    tokensSaved: compaction.tokensSaved,
    savedRatio: compaction.tokensBefore > 0 ? compaction.tokensSaved / compaction.tokensBefore : 0,
    tier1Summaries: compaction.tier1.length,
    tier2Summaries: compaction.tier2.length,
    tier3Summary: compaction.tier3 !== null,
    anchorsKept: compaction.anchors.length,
    anchorsByKind,
    verifiedClaims,
    verifiedRatio: verifiedClaims > 0 ? verifiedOk / verifiedClaims : 1,
    contradictedClaims: contradicted,
    unverifiableClaims: unverifiable,
    segmentsCreated: input.segmentIds.length,
    segmentsEvicted: input.evictedSegmentIds.length,
    evictedSegmentIds: input.evictedSegmentIds,
    thresholdAlerts: input.thresholdAlerts,
    windowAfter: {
      usedTokens: input.windowAfter.usedTokens,
      limit: input.windowAfter.limit,
      usageRatio: input.windowAfter.usageRatio,
    },
  };
}

/** Render a report as markdown (logs, UI, inspector). */
export function compactionReportMarkdown(report: CompactionReport): string {
  const lines = [
    `# Compaction ${report.id}`,
    `${report.at} · bot ${report.botId} · trigger: ${report.trigger}`,
    '',
    `- Turns compacted: ${report.turnsCompacted}`,
    `- Tokens: ${report.tokensBefore.toLocaleString()} → ${report.tokensAfter.toLocaleString()} ` +
      `(saved ${report.tokensSaved.toLocaleString()}, ${Math.round(report.savedRatio * 100)}%)`,
    `- Tiers: ${report.tier1Summaries} tier-1, ${report.tier2Summaries} tier-2, ` +
      `tier-3 ${report.tier3Summary ? 'yes' : 'no'}`,
    `- Anchors kept: ${report.anchorsKept} ` +
      `(${Object.entries(report.anchorsByKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
    `- Claims verified: ${report.verifiedClaims} ` +
      `(${Math.round(report.verifiedRatio * 100)}% verified, ` +
      `${report.contradictedClaims} contradicted, ${report.unverifiableClaims} unverifiable)`,
    `- Segments: ${report.segmentsCreated} created, ${report.segmentsEvicted} evicted`,
    `- Window after: ${report.windowAfter.usedTokens.toLocaleString()}/${report.windowAfter.limit.toLocaleString()} ` +
      `(${Math.round(report.windowAfter.usageRatio * 100)}%)`,
  ];
  if (report.thresholdAlerts.length > 0) {
    lines.push(`- Threshold alerts: ${report.thresholdAlerts.join(', ')}`);
  }
  if (report.evictedSegmentIds.length > 0) {
    lines.push(`- Evicted: ${report.evictedSegmentIds.join(', ')}`);
  }
  return lines.join('\n');
}
