/**
 * Tier store — persist tiered summaries across restarts
 * (context engineering v2, v1.05 Team T4).
 *
 * The runtime keeps tiers in memory; a restart would lose them
 * and the next session would re-compact from scratch (or worse,
 * forget what was already summarised). `TierStore` persists one
 * JSON file per bot (`<dir>/<botId>.json`, atomic write, mode
 * 0600): the tier-1/2/3 summaries, the verified summaries from the
 * last round, the anchors, and the last compaction time. A corrupt
 * file loads as empty (fail-closed) so a bad write never blocks a
 * session. `list` reports every bot with stored tiers; `prune`
 * drops bots whose tiers are older than a cutoff (housekeeping
 * for the UI / a cron).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TierSummary } from './tieredCompaction';
import type { VerifiedSummary } from './verifiedSummary';
import type { Anchor } from './anchors';

/** Persisted tiers for one bot. */
export interface StoredTiers {
  botId: string;
  updatedAt: string;
  tier1: TierSummary[];
  tier2: TierSummary[];
  tier3: TierSummary[];
  /** Verified summaries from the last compaction round. */
  verified: VerifiedSummary[];
  /** Anchors carried by the last round. */
  anchors: Anchor[];
  /** ISO time of the last compaction round (null when never). */
  lastCompactedAt: string | null;
}

export function emptyStoredTiers(botId: string): StoredTiers {
  return {
    botId,
    updatedAt: new Date().toISOString(),
    tier1: [],
    tier2: [],
    tier3: [],
    verified: [],
    anchors: [],
    lastCompactedAt: null,
  };
}

function isTierSummary(value: unknown): value is TierSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TierSummary).id === 'string' &&
    [1, 2, 3].includes((value as TierSummary).tier) &&
    typeof (value as TierSummary).text === 'string' &&
    Array.isArray((value as TierSummary).sourceIds)
  );
}

export class TierStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private filePathFor(botId: string): string {
    const safe = botId.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  /** Load a bot's tiers (empty when never saved or corrupt). */
  load(botId: string): StoredTiers {
    try {
      const raw = fs.readFileSync(this.filePathFor(botId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return emptyStoredTiers(botId);
      const stored = parsed as Partial<StoredTiers>;
      if (stored.botId !== botId) return emptyStoredTiers(botId);
      const tiers = (list: unknown): TierSummary[] =>
        Array.isArray(list) ? list.filter(isTierSummary) : [];
      return {
        botId,
        updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : new Date().toISOString(),
        tier1: tiers(stored.tier1),
        tier2: tiers(stored.tier2),
        tier3: tiers(stored.tier3),
        verified: Array.isArray(stored.verified) ? stored.verified : [],
        anchors: Array.isArray(stored.anchors) ? stored.anchors : [],
        lastCompactedAt: typeof stored.lastCompactedAt === 'string' ? stored.lastCompactedAt : null,
      };
    } catch {
      return emptyStoredTiers(botId);
    }
  }

  /** Save a bot's tiers (atomic write). */
  save(stored: StoredTiers): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const record: StoredTiers = { ...stored, updatedAt: new Date().toISOString() };
      const tmp = `${this.filePathFor(stored.botId)}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePathFor(stored.botId));
    } catch {
      // Tier persistence is best-effort; a failed write must not break the run.
    }
  }

  /** Delete a bot's stored tiers (true when a file existed). */
  remove(botId: string): boolean {
    try {
      fs.unlinkSync(this.filePathFor(botId));
      return true;
    } catch {
      return false;
    }
  }

  /** Bot ids with stored tiers. */
  botIds(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Drop stored tiers older than `olderThanMs` (housekeeping).
   * Returns the dropped bot ids.
   */
  prune(olderThanMs: number): string[] {
    const cutoff = Date.now() - olderThanMs;
    const dropped: string[] = [];
    for (const botId of this.botIds()) {
      const stored = this.load(botId);
      if (Date.parse(stored.updatedAt) < cutoff) {
        this.remove(botId);
        dropped.push(botId);
      }
    }
    return dropped;
  }

  /** Total counts across all stored tiers (for admin views). */
  totals(): { bots: number; tier1: number; tier2: number; tier3: number; anchors: number } {
    let tier1 = 0;
    let tier2 = 0;
    let tier3 = 0;
    let anchors = 0;
    const bots = this.botIds();
    for (const botId of bots) {
      const stored = this.load(botId);
      tier1 += stored.tier1.length;
      tier2 += stored.tier2.length;
      tier3 += stored.tier3.length;
      anchors += stored.anchors.length;
    }
    return { bots: bots.length, tier1, tier2, tier3, anchors };
  }
}

/** One anchor hit from the search (with the bot it belongs to). */
export interface StoredAnchorHit {
  botId: string;
  anchor: Anchor;
}

/**
 * Search stored anchors across bots: by kind and/or by text
 * (case-insensitive substring). Powers the inspector's "find
 * where we decided X" query without loading every tier into
 * memory twice.
 */
export function searchStoredAnchors(
  store: TierStore,
  query: { kind?: Anchor['kind']; text?: string; botId?: string },
): StoredAnchorHit[] {
  const needle = query.text?.toLowerCase() ?? '';
  const bots = query.botId ? [query.botId] : store.botIds();
  const hits: StoredAnchorHit[] = [];
  for (const botId of bots) {
    const stored = store.load(botId);
    for (const anchor of stored.anchors) {
      if (query.kind && anchor.kind !== query.kind) continue;
      if (needle !== '' && !anchor.text.toLowerCase().includes(needle)) continue;
      hits.push({ botId, anchor });
    }
  }
  return hits;
}
