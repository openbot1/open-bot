/**
 * Per-bot compaction policy (context engineering v2, v1.05 Team T4).
 *
 * Every bot compacts differently: a coding bot wants file-change
 * anchors kept and a low trigger (code blows up the window fast);
 * a chat bot wants a high trigger and only decisions kept at tier 3.
 * `CompactionPolicy` is that per-bot configuration:
 *
 *  - triggerRatio: usage ratio (used/limit) that starts compaction.
 *  - maxTier: deepest tier the bot may build (1 = turn summaries
 *    only, 3 = full session roll-up).
 *  - keepAnchorKinds: which anchor kinds survive to the top tier.
 *  - keepRecentTurns: turns never compacted, however tight the
 *    window gets.
 *  - frequency: when compaction runs — every turn, at most once an
 *    hour, or only when the user/agent asks (manual).
 *  - retention: the tier retention policy (see tieredCompaction).
 *
 * `CompactionPolicyStore` persists policies per bot as one JSON
 * file (atomic write, mode 0600, corrupt file loads as defaults —
 * same pattern as `CompactionHistory`). `estimateSavings` previews
 * a policy against a message list without changing anything, so the
 * UI can show "this policy would save ~N tokens" before the user
 * applies it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { estimateTokens } from './estimator';
import {
  DEFAULT_TIER_RETENTION,
  TieredCompactor,
  type CompactableTurn,
  type CompactionTier,
  type TierRetentionPolicy,
} from './tieredCompaction';
import type { AnchorKind } from './anchors';

/** When compaction runs for a bot. */
export type CompactionFrequency = 'per-turn' | 'hourly' | 'manual';

/** Per-bot compaction policy. */
export interface CompactionPolicy {
  botId: string;
  /** Usage ratio that triggers compaction (0.5..0.98, default 0.8). */
  triggerRatio: number;
  /** Deepest tier the bot may build (1..3, default 3). */
  maxTier: CompactionTier;
  /** Anchor kinds carried to the top tier. */
  keepAnchorKinds: AnchorKind[];
  /** Recent turns never compacted (default 4). */
  keepRecentTurns: number;
  /** When compaction runs. */
  frequency: CompactionFrequency;
  /** Tier retention (max summaries per tier, chars per summary). */
  retention: TierRetentionPolicy;
  updatedAt: string;
}

/** Sensible default: trigger at 80%, full 3 tiers, all anchors. */
export function defaultCompactionPolicy(botId: string): CompactionPolicy {
  return {
    botId,
    triggerRatio: 0.8,
    maxTier: 3,
    keepAnchorKinds: ['decision', 'metric', 'file-change', 'constraint', 'fact'],
    keepRecentTurns: 4,
    frequency: 'per-turn',
    retention: { ...DEFAULT_TIER_RETENTION, keepAnchorKinds: { ...DEFAULT_TIER_RETENTION.keepAnchorKinds } },
    updatedAt: new Date().toISOString(),
  };
}

/** Presets for common bot shapes (UI offers them as one tap). */
export const COMPACTION_POLICY_PRESETS: Record<string, Partial<CompactionPolicy>> = {
  chat: { triggerRatio: 0.85, maxTier: 2, keepRecentTurns: 6, frequency: 'per-turn' },
  coding: {
    triggerRatio: 0.7,
    maxTier: 3,
    keepAnchorKinds: ['decision', 'file-change', 'constraint'],
    keepRecentTurns: 4,
    frequency: 'per-turn',
  },
  'long-run': {
    triggerRatio: 0.75,
    maxTier: 3,
    keepAnchorKinds: ['decision', 'metric', 'file-change', 'constraint', 'fact'],
    keepRecentTurns: 2,
    frequency: 'hourly',
  },
  minimal: { triggerRatio: 0.9, maxTier: 1, keepAnchorKinds: ['decision', 'constraint'], keepRecentTurns: 8, frequency: 'manual' },
};

/** Apply a preset on top of the default policy for a bot. */
export function presetCompactionPolicy(botId: string, preset: string): CompactionPolicy {
  const base = defaultCompactionPolicy(botId);
  const patch = COMPACTION_POLICY_PRESETS[preset];
  if (!patch) throw new Error(`unknown compaction preset: ${preset}`);
  return { ...base, ...patch, botId, updatedAt: new Date().toISOString() };
}

/** Validate a policy patch; returns error messages (empty = valid). */
export function validatePolicy(patch: Partial<CompactionPolicy>): string[] {
  const errors: string[] = [];
  if (patch.triggerRatio !== undefined) {
    if (typeof patch.triggerRatio !== 'number' || patch.triggerRatio < 0.5 || patch.triggerRatio > 0.98) {
      errors.push('triggerRatio must be a number between 0.5 and 0.98');
    }
  }
  if (patch.maxTier !== undefined && patch.maxTier !== 1 && patch.maxTier !== 2 && patch.maxTier !== 3) {
    errors.push('maxTier must be 1, 2 or 3');
  }
  if (patch.keepRecentTurns !== undefined) {
    if (!Number.isInteger(patch.keepRecentTurns) || patch.keepRecentTurns < 0 || patch.keepRecentTurns > 50) {
      errors.push('keepRecentTurns must be an integer between 0 and 50');
    }
  }
  if (patch.frequency !== undefined && !['per-turn', 'hourly', 'manual'].includes(patch.frequency)) {
    errors.push('frequency must be "per-turn", "hourly" or "manual"');
  }
  if (patch.keepAnchorKinds !== undefined) {
    const valid: AnchorKind[] = ['decision', 'metric', 'file-change', 'constraint', 'fact'];
    if (!Array.isArray(patch.keepAnchorKinds) || patch.keepAnchorKinds.some((k) => !valid.includes(k))) {
      errors.push('keepAnchorKinds must be a subset of decision/metric/file-change/constraint/fact');
    }
  }
  if (patch.retention !== undefined) {
    const r = patch.retention;
    if (r.maxTier1Summaries < 1 || r.maxTier2Summaries < 1 || r.maxTier3Summaries < 1) {
      errors.push('retention caps must be at least 1');
    }
    if (r.maxSummaryChars < 200 || r.maxSummaryChars > 20000) {
      errors.push('retention.maxSummaryChars must be between 200 and 20000');
    }
  }
  return errors;
}

/** Preview of what a policy would do to a message list. */
export interface SavingsEstimate {
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  savedRatio: number;
  turnsCompacted: number;
  turnsKept: number;
  tier1Summaries: number;
  tier2Summaries: number;
  tier3Summary: boolean;
  anchorsKept: number;
  /** True when the policy would change nothing (already under trigger). */
  noOp: boolean;
}

/**
 * Preview a policy against messages (dry run — nothing is stored).
 * Turns older than `keepRecentTurns` are compacted; the rest are
 * kept verbatim. Tiers deeper than `maxTier` are not built.
 */
export function estimateSavings(
  messages: Array<{ role: string; content?: string; id?: string }>,
  policy: CompactionPolicy,
): SavingsEstimate {
  const tokensBefore = messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
  const keepRecent = Math.min(policy.keepRecentTurns, messages.length);
  const compactable = messages.slice(0, messages.length - keepRecent);
  const kept = messages.slice(messages.length - keepRecent);
  if (compactable.length === 0) {
    return {
      tokensBefore,
      tokensAfter: tokensBefore,
      tokensSaved: 0,
      savedRatio: 0,
      turnsCompacted: 0,
      turnsKept: messages.length,
      tier1Summaries: 0,
      tier2Summaries: 0,
      tier3Summary: false,
      anchorsKept: 0,
      noOp: true,
    };
  }
  const turns: CompactableTurn[] = compactable.map((message, index) => ({
    id: message.id ?? `msg-${index}`,
    turnIndex: index,
    role: message.role,
    content: message.content,
  }));
  const compactor = new TieredCompactor(policy.retention);
  const result = compactor.compact(turns);
  const tier1 = result.tier1;
  const tier2 = policy.maxTier >= 2 ? result.tier2 : [];
  const tier3 = policy.maxTier >= 3 ? result.tier3 : null;
  const keptSummaryTokens =
    [...tier1, ...tier2, ...(tier3 ? [tier3] : [])].reduce((sum, s) => sum + s.tokenEstimate, 0);
  const keptTurnTokens = kept.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
  const tokensAfter = keptSummaryTokens + keptTurnTokens;
  const anchorsKept = (tier3 ?? tier2[0] ?? tier1[0])?.anchors.length ?? result.anchors.length;
  return {
    tokensBefore,
    tokensAfter,
    tokensSaved: Math.max(0, tokensBefore - tokensAfter),
    savedRatio: tokensBefore > 0 ? Math.max(0, tokensBefore - tokensAfter) / tokensBefore : 0,
    turnsCompacted: compactable.length,
    turnsKept: kept.length,
    tier1Summaries: tier1.length,
    tier2Summaries: tier2.length,
    tier3Summary: tier3 !== null,
    anchorsKept,
    noOp: false,
  };
}

/** JSON file store of per-bot compaction policies. */
export class CompactionPolicyStore {
  private readonly filePath: string;
  private policies = new Map<string, CompactionPolicy>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** Policy for a bot (default when none was saved). */
  get(botId: string): CompactionPolicy {
    return this.policies.get(botId) ?? defaultCompactionPolicy(botId);
  }

  /** Save (or replace) a bot's policy; returns the stored policy. */
  set(botId: string, patch: Partial<CompactionPolicy>): CompactionPolicy {
    const errors = validatePolicy(patch);
    if (errors.length > 0) throw new Error(`invalid compaction policy: ${errors.join('; ')}`);
    const current = this.get(botId);
    const next: CompactionPolicy = {
      ...current,
      ...patch,
      botId,
      updatedAt: new Date().toISOString(),
    };
    this.policies.set(botId, next);
    this.persist();
    return next;
  }

  /** Delete a bot's saved policy (falls back to default). */
  remove(botId: string): boolean {
    const had = this.policies.delete(botId);
    if (had) this.persist();
    return had;
  }

  /** All bot ids with a saved policy. */
  botIds(): string[] {
    return [...this.policies.keys()].sort();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [botId, policy] of Object.entries(parsed as Record<string, unknown>)) {
          if (
            typeof policy === 'object' && policy !== null &&
            (policy as CompactionPolicy).botId === botId &&
            validatePolicy(policy as Partial<CompactionPolicy>).length === 0
          ) {
            this.policies.set(botId, policy as CompactionPolicy);
          }
        }
      }
    } catch {
      this.policies = new Map();
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.policies), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Policy persistence is best-effort; a failed write must not break the run.
    }
  }
}
