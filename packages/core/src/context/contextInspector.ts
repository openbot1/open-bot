/**
 * Context inspector v2 — see the whole window as a tree, and move
 * it around as a snapshot (context engineering v2, v1.05 Team T4).
 *
 * `inspectWindow` turns a `ContextWindowManager` into a tree:
 * segments grouped by kind, each with its tokens, tier, source ids
 * and spill state, plus totals per kind/tier and the threshold
 * state — everything the UI needs to draw the window without
 * touching the manager's internals.
 *
 * Snapshots are the portable form of a window: `exportSnapshot`
 * serialises the manager (segments with their text, limit, policy)
 * to JSON; `importSnapshot` rebuilds a manager from it (validated:
 * bad version, bad segment kinds or negative tokens are rejected
 * with a clear error, never half-imported). Snapshots let a user
 * save a session's context, hand it to another bot, or restore it
 * after a restart. `snapshotToMarkdown` renders a snapshot for
 * humans (logs, audits, the inspector panel).
 */

import {
  ContextWindowManager,
  type ContextSegment,
  type SegmentKind,
  type WindowStats,
} from './windowManager';
import type { CompactionPolicy } from './compactionPolicy';

/** One node of the inspector tree. */
export interface InspectorNode {
  id: string;
  kind: SegmentKind;
  tier?: 1 | 2 | 3;
  tokens: number;
  sourceIds: string[];
  spilled: boolean;
  /** First 120 chars of the text (spilled segments show a marker). */
  preview: string;
  at: string;
}

/** The whole window as a tree. */
export interface ContextTree {
  limit: number;
  usedTokens: number;
  usageRatio: number;
  /** 0..1 progress per threshold band (for meters). */
  bands: { warn50: number; warn80: number; warn95: number };
  stats: WindowStats;
  groups: Array<{
    kind: SegmentKind;
    count: number;
    tokens: number;
    nodes: InspectorNode[];
  }>;
}

/** Portable snapshot of a window (+ the policy that shaped it). */
export interface ContextSnapshot {
  version: 1;
  exportedAt: string;
  botId?: string;
  limit: number;
  reserveTokens: number;
  ramBudgetBytes: number;
  segments: Array<{
    id: string;
    kind: SegmentKind;
    tier?: 1 | 2 | 3;
    text: string;
    tokens: number;
    sourceIds: string[];
    spilled: boolean;
    at: string;
  }>;
  policy?: CompactionPolicy;
}

function previewOf(segment: ContextSegment): string {
  if (segment.spilled) return '[spilled to disk — restore to preview]';
  const text = segment.text.replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** Build the inspector tree for a window manager. */
export function inspectWindow(manager: ContextWindowManager): ContextTree {
  const stats = manager.stats();
  const groups = manager.tree().map(({ kind, segments }) => ({
    kind,
    count: segments.length,
    tokens: segments.reduce((sum, s) => sum + s.tokens, 0),
    nodes: segments.map((segment): InspectorNode => ({
      id: segment.id,
      kind: segment.kind,
      ...(segment.tier !== undefined ? { tier: segment.tier } : {}),
      tokens: segment.tokens,
      sourceIds: segment.sourceIds,
      spilled: segment.spilled,
      preview: previewOf(segment),
      at: segment.at,
    })),
  }));
  const ratio = stats.usageRatio;
  return {
    limit: stats.limit,
    usedTokens: stats.usedTokens,
    usageRatio: ratio,
    bands: {
      warn50: Math.min(1, ratio / 0.5),
      warn80: Math.min(1, ratio / 0.8),
      warn95: Math.min(1, ratio / 0.95),
    },
    stats,
    groups,
  };
}

/** Export a window (+ optional policy) as a portable snapshot. */
export function exportSnapshot(
  manager: ContextWindowManager,
  options: { botId?: string; policy?: CompactionPolicy } = {},
): ContextSnapshot {
  const stats = manager.stats();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    ...(options.botId ? { botId: options.botId } : {}),
    limit: stats.limit,
    reserveTokens: stats.reservedTokens,
    ramBudgetBytes: stats.ramBudgetBytes,
    segments: manager.list().map((segment) => ({
      id: segment.id,
      kind: segment.kind,
      ...(segment.tier !== undefined ? { tier: segment.tier } : {}),
      text: segment.spilled ? '' : segment.text,
      tokens: segment.tokens,
      sourceIds: segment.sourceIds,
      spilled: segment.spilled,
      at: segment.at,
    })),
    ...(options.policy ? { policy: options.policy } : {}),
  };
}

/** Validate a parsed snapshot object; returns errors (empty = valid). */
export function validateSnapshot(snapshot: unknown): string[] {
  const errors: string[] = [];
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return ['snapshot must be an object'];
  }
  const snap = snapshot as Partial<ContextSnapshot>;
  if (snap.version !== 1) errors.push(`unsupported snapshot version: ${String(snap.version)} (expected 1)`);
  if (typeof snap.limit !== 'number' || snap.limit <= 0) errors.push('limit must be a positive number');
  if (!Array.isArray(snap.segments)) {
    errors.push('segments must be an array');
    return errors;
  }
  const validKinds: SegmentKind[] = ['system', 'anchor', 'summary', 'turn', 'tool-result'];
  const ids = new Set<string>();
  for (const segment of snap.segments) {
    if (typeof segment !== 'object' || segment === null) {
      errors.push('each segment must be an object');
      continue;
    }
    if (typeof segment.id !== 'string' || segment.id === '') errors.push('segment id must be a non-empty string');
    else if (ids.has(segment.id)) errors.push(`duplicate segment id: ${segment.id}`);
    else ids.add(segment.id);
    if (!validKinds.includes(segment.kind)) errors.push(`invalid segment kind: ${String(segment.kind)}`);
    if (typeof segment.tokens !== 'number' || segment.tokens < 0) {
      errors.push(`segment ${segment.id}: tokens must be a non-negative number`);
    }
    if (typeof segment.text !== 'string') errors.push(`segment ${segment.id}: text must be a string`);
    if (segment.tier !== undefined && segment.tier !== 1 && segment.tier !== 2 && segment.tier !== 3) {
      errors.push(`segment ${segment.id}: tier must be 1, 2 or 3`);
    }
  }
  return errors;
}

/**
 * Import a snapshot into a fresh window manager (spill dir +
 * RAM budget come from `options`). Throws on invalid snapshots.
 * Spilled segments import as spilled (text empty) — the caller can
 * restore them from the original spill dir if it still exists.
 */
export function importSnapshot(
  snapshot: unknown,
  options: { spillDir?: string; ramBudgetBytes?: number } = {},
): ContextWindowManager {
  const errors = validateSnapshot(snapshot);
  if (errors.length > 0) throw new Error(`invalid context snapshot: ${errors.join('; ')}`);
  const snap = snapshot as ContextSnapshot;
  const manager = new ContextWindowManager({
    limitTokens: snap.limit,
    reserveTokens: snap.reserveTokens,
    ramBudgetBytes: snap.ramBudgetBytes,
    ...(options.spillDir ? { spillDir: options.spillDir } : {}),
    ...(options.ramBudgetBytes !== undefined ? { ramBudgetBytes: options.ramBudgetBytes } : {}),
  });
  for (const segment of snap.segments) {
    manager.addSegment({
      id: segment.id,
      kind: segment.kind,
      text: segment.text,
      ...(segment.tier !== undefined ? { tier: segment.tier } : {}),
      sourceIds: segment.sourceIds,
    });
    // Preserve the spilled flag: a spilled segment imported with
    // empty text stays marked spilled (its text lives on disk).
    if (segment.spilled) {
      const imported = manager.getSegment(segment.id);
      if (imported) imported.spilled = true;
    }
  }
  return manager;
}

/** Render a snapshot as markdown (logs, audits, inspector panel). */
export function snapshotToMarkdown(snapshot: ContextSnapshot): string {
  const lines = [
    `# Context snapshot (v${snapshot.version})`,
    `Exported: ${snapshot.exportedAt}${snapshot.botId ? ` · bot: ${snapshot.botId}` : ''}`,
    `Limit: ${snapshot.limit.toLocaleString()} tokens · segments: ${snapshot.segments.length}`,
    '',
  ];
  const byKind = new Map<SegmentKind, number>();
  for (const segment of snapshot.segments) {
    byKind.set(segment.kind, (byKind.get(segment.kind) ?? 0) + segment.tokens);
  }
  for (const [kind, tokens] of byKind) {
    lines.push(`- ${kind}: ${tokens.toLocaleString()} tokens`);
  }
  lines.push('');
  for (const segment of snapshot.segments) {
    const preview = segment.text.replace(/\s+/g, ' ').trim().slice(0, 100);
    lines.push(
      `- [${segment.kind}${segment.tier ? ` tier ${segment.tier}` : ''}] ${segment.id}: ` +
        `${segment.tokens} tokens${segment.spilled ? ' (spilled)' : ''} — ${preview}`,
    );
  }
  return lines.join('\n');
}

/**
 * Export the whole context as one audit bundle (markdown): the
 * window snapshot, the bot policy, the stored tiers (with their
 * anchors), and the verified summaries with their claim grades.
 * A bundle is what a human reads after a long session to answer
 * "what did the bot remember, and can I trust it?" — one file,
 * no tool calls needed.
 */
export function exportContextBundle(input: {
  snapshot: ContextSnapshot;
  tiers?: {
    tier1: TierSummaryLike[];
    tier2: TierSummaryLike[];
    tier3: TierSummaryLike[];
    anchors: AnchorLike[];
  };
  verified?: Array<{
    id: string;
    tier: number;
    topic: string;
    verifiedRatio: number;
    claims: Array<{ text: string; status: string }>;
  }>;
}): string {
  const { snapshot } = input;
  const lines = [snapshotToMarkdown(snapshot), '', '---', ''];
  if (snapshot.policy) {
    const policy = snapshot.policy;
    lines.push(
      '## Policy',
      `- Trigger: ${(policy.triggerRatio * 100).toFixed(0)}% · max tier ${policy.maxTier} · ` +
        `keep ${policy.keepRecentTurns} recent turns · ${policy.frequency}`,
      `- Anchors kept: ${policy.keepAnchorKinds.join(', ')}`,
      '',
    );
  }
  if (input.tiers) {
    const { tier1, tier2, tier3, anchors } = input.tiers;
    lines.push(
      '## Stored tiers',
      `- Tier 1: ${tier1.length} summar(ies) · Tier 2: ${tier2.length} · Tier 3: ${tier3.length}`,
      `- Anchors: ${anchors.length}`,
      '',
    );
    for (const tier of [tier1, tier2, tier3]) {
      for (const summary of tier) {
        const preview = summary.text.replace(/\s+/g, ' ').trim().slice(0, 160);
        lines.push(`- [tier ${summary.tier}${summary.topic ? ` ${summary.topic}` : ''}] ${preview}`);
      }
    }
    if (tier1.length + tier2.length + tier3.length > 0) lines.push('');
  }
  if (input.verified) {
    lines.push('## Verified summaries');
    for (const summary of input.verified) {
      const ok = summary.claims.filter((c) => c.status === 'verified').length;
      lines.push(
        `- ${summary.id} (tier ${summary.tier}${summary.topic ? `, ${summary.topic}` : ''}): ` +
          `${ok}/${summary.claims.length} claims verified (${Math.round(summary.verifiedRatio * 100)}%)`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Minimal shapes the bundle needs (avoids a core-internal import cycle). */
export interface TierSummaryLike {
  tier: 1 | 2 | 3;
  topic: string;
  text: string;
}

export interface AnchorLike {
  kind: string;
  text: string;
}
