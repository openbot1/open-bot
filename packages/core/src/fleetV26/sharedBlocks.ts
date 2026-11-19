/**
 * Shared blocks v26 — memory blocks shared across fleet bots (v1.39, Team T6).
 *
 * Idea (from the v139 survey §3, Letta shared memory blocks): ONE block
 * (e.g. `current_plan`, `organization`) is attached to MANY bots; one
 * bot updates it and every other attached bot sees the change at once
 * — no agent-to-agent messaging needed.
 *
 * Coordination with memory v24 (Team T1, building in parallel): this
 * module owns ONLY the sharing mechanics — attach/detach, versioned
 * writes with optimistic concurrency, leases, history. It does NOT
 * own retrieval, ranking, embedding, or consolidation — that is
 * memory's job. A memory provider plugs in through
 * `FleetV26MemoryBlockProvider`: when T1's memoryV24 lands, the host
 * passes an adapter and `searchBlocks()` delegates to it; until then
 * the built-in fallback is a plain substring scan, clearly labelled
 * as such (never presented as semantic retrieval).
 *
 * Safety rules:
 * - Writes need the current version (`expectedVersion`): a stale
 *   writer is refused instead of silently overwriting a newer edit.
 * - A block may be leased (one bot holds the write lease for a bounded
 *   time); a leased block refuses writes from other bots.
 * - History is append-only and capped (`FLEET_V26_BLOCK_HISTORY_MAX`);
 *   every version records who wrote it and when.
 * - Blocks have a size cap (`FLEET_V26_BLOCK_MAX_CHARS`); oversize
 *   writes are refused, not truncated silently.
 * - Deleting a block detaches every bot first (no dangling refs).
 */

import type { FleetV26BotRegistry } from './bots';

/** A memory provider the host can plug in (memory v24 adapter). */
export interface FleetV26MemoryBlockProvider {
  /** Provider name, e.g. `memory-v24`. */
  name: string;
  /** Ranked search over block text (the provider owns ranking). */
  searchBlocks(query: string, limit: number): Array<{ blockId: string; score: number; snippet: string }>;
  /** Read one block's text through the provider (null = not stored there). */
  readBlockText?(blockId: string): string | null;
}

/** One version in a block's history. */
export interface FleetV26BlockVersion {
  version: number;
  text: string;
  updatedByBotId: string;
  updatedAtMs: number;
  /** Why the write happened (free text, e.g. "plan step 3 done"). */
  reason: string | null;
}

/** A shared memory block. */
export interface FleetV26SharedBlock {
  id: string;
  name: string;
  /** Short label for the UI (e.g. "Current plan"). */
  title: string;
  /** Current text. */
  text: string;
  /** Monotonic version (starts at 1). */
  version: number;
  /** Bots currently attached (read + write). */
  attachedBotIds: string[];
  /** Who created it (bot id or "operator"). */
  createdBy: string;
  createdAtMs: number;
  updatedByBotId: string;
  updatedAtMs: number;
  /** Write lease holder (null = free). */
  leaseHolderBotId: string | null;
  /** Lease expiry (null = no lease). */
  leaseExpiresAtMs: number | null;
  /** Append-only history (oldest first, capped). */
  history: FleetV26BlockVersion[];
  /** Free-form tags (e.g. "plan", "org"). */
  tags: string[];
}

/** Result of a block operation. */
export interface FleetV26BlockOp {
  ok: boolean;
  blockId: string;
  message: string;
  /** New version after a successful write (null otherwise). */
  version: number | null;
}

export const FLEET_V26_BLOCK_MAX_CHARS = 200_000;
export const FLEET_V26_BLOCK_HISTORY_MAX = 50;
export const FLEET_V26_BLOCK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Default lease length, ms (5 minutes). */
export const FLEET_V26_BLOCK_LEASE_MS = 5 * 60 * 1000;

function isBlockId(s: unknown): s is string {
  return typeof s === 'string' && FLEET_V26_BLOCK_NAME_RE.test(s);
}

/** Registry of shared blocks + the sharing mechanics. */
export class FleetV26SharedBlockRegistry {
  private blocks = new Map<string, FleetV26SharedBlock>();
  private provider: FleetV26MemoryBlockProvider | null = null;

  /** Plug a memory provider in (memory v24 adapter); null detaches it. */
  setProvider(provider: FleetV26MemoryBlockProvider | null): void {
    this.provider = provider;
  }

  /** Current provider name (null = local fallback only). */
  providerName(): string | null {
    return this.provider ? this.provider.name : null;
  }

  /** Create a block (starts at version 1, empty history entry). */
  create(
    input: { id: string; name?: string; title?: string; text?: string; createdBy?: string; tags?: string[] },
    nowMs: number = Date.now(),
  ): FleetV26BlockOp {
    if (!isBlockId(input.id)) {
      return { ok: false, blockId: String(input.id ?? ''), message: `Block id "${String(input.id ?? '')}" is invalid (letters, digits, "-", "_" only).`, version: null };
    }
    if (this.blocks.has(input.id)) {
      return { ok: false, blockId: input.id, message: `Block "${input.id}" already exists.`, version: null };
    }
    const text = input.text ?? '';
    if (text.length > FLEET_V26_BLOCK_MAX_CHARS) {
      return { ok: false, blockId: input.id, message: `Block text exceeds ${FLEET_V26_BLOCK_MAX_CHARS} chars.`, version: null };
    }
    const createdBy = input.createdBy ?? 'operator';
    const block: FleetV26SharedBlock = {
      id: input.id,
      name: input.name ?? input.id,
      title: input.title ?? input.name ?? input.id,
      text,
      version: 1,
      attachedBotIds: [],
      createdBy,
      createdAtMs: nowMs,
      updatedByBotId: createdBy,
      updatedAtMs: nowMs,
      leaseHolderBotId: null,
      leaseExpiresAtMs: null,
      history: [{ version: 1, text, updatedByBotId: createdBy, updatedAtMs: nowMs, reason: 'created' }],
      tags: [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))].sort(),
    };
    this.blocks.set(input.id, block);
    return { ok: true, blockId: input.id, message: `Block "${input.id}" created at version 1.`, version: 1 };
  }

  /** One block (copy) or undefined. */
  get(blockId: string): FleetV26SharedBlock | undefined {
    const b = this.blocks.get(blockId);
    if (!b) return undefined;
    return {
      ...b,
      attachedBotIds: [...b.attachedBotIds],
      tags: [...b.tags],
      history: b.history.map((h) => ({ ...h })),
    };
  }

  /** All blocks, sorted by id. */
  list(): FleetV26SharedBlock[] {
    return [...this.blocks.keys()].sort().map((id) => this.get(id) as FleetV26SharedBlock);
  }

  /** Blocks attached to one bot. */
  listForBot(botId: string): FleetV26SharedBlock[] {
    return this.list().filter((b) => b.attachedBotIds.includes(botId));
  }

  /** Blocks carrying a tag. */
  listByTag(tag: string): FleetV26SharedBlock[] {
    return this.list().filter((b) => b.tags.includes(tag));
  }

  /** Attach a bot to a block (idempotent; bot must exist in the registry). */
  attach(blockId: string, botId: string, bots: FleetV26BotRegistry): FleetV26BlockOp {
    const b = this.blocks.get(blockId);
    if (!b) return { ok: false, blockId, message: `Block "${blockId}" does not exist.`, version: null };
    if (!bots.get(botId)) {
      return { ok: false, blockId, message: `Bot "${botId}" is not registered.`, version: null };
    }
    if (!b.attachedBotIds.includes(botId)) b.attachedBotIds.push(botId);
    b.attachedBotIds.sort();
    return { ok: true, blockId, message: `Bot "${botId}" attached to block "${blockId}".`, version: b.version };
  }

  /** Detach a bot from a block (also releases its lease, if any). */
  detach(blockId: string, botId: string): FleetV26BlockOp {
    const b = this.blocks.get(blockId);
    if (!b) return { ok: false, blockId, message: `Block "${blockId}" does not exist.`, version: null };
    b.attachedBotIds = b.attachedBotIds.filter((id) => id !== botId);
    if (b.leaseHolderBotId === botId) {
      b.leaseHolderBotId = null;
      b.leaseExpiresAtMs = null;
    }
    return { ok: true, blockId, message: `Bot "${botId}" detached from block "${blockId}".`, version: b.version };
  }

  /** Take the write lease (refused when another live lease holds it). */
  acquireLease(
    blockId: string,
    botId: string,
    leaseMs: number = FLEET_V26_BLOCK_LEASE_MS,
    nowMs: number = Date.now(),
  ): FleetV26BlockOp {
    const b = this.blocks.get(blockId);
    if (!b) return { ok: false, blockId, message: `Block "${blockId}" does not exist.`, version: null };
    if (!b.attachedBotIds.includes(botId)) {
      return { ok: false, blockId, message: `Bot "${botId}" is not attached to block "${blockId}".`, version: null };
    }
    if (b.leaseHolderBotId && b.leaseHolderBotId !== botId && b.leaseExpiresAtMs !== null && nowMs < b.leaseExpiresAtMs) {
      return {
        ok: false,
        blockId,
        message: `Block "${blockId}" is leased to bot "${b.leaseHolderBotId}" until ${new Date(b.leaseExpiresAtMs).toISOString()}.`,
        version: b.version,
      };
    }
    b.leaseHolderBotId = botId;
    b.leaseExpiresAtMs = nowMs + Math.max(1000, leaseMs);
    return { ok: true, blockId, message: `Bot "${botId}" holds the lease on block "${blockId}".`, version: b.version };
  }

  /** Release the write lease (holder only; others get a refusal). */
  releaseLease(blockId: string, botId: string): FleetV26BlockOp {
    const b = this.blocks.get(blockId);
    if (!b) return { ok: false, blockId, message: `Block "${blockId}" does not exist.`, version: null };
    if (b.leaseHolderBotId !== botId) {
      return { ok: false, blockId, message: `Bot "${botId}" does not hold the lease on block "${blockId}".`, version: b.version };
    }
    b.leaseHolderBotId = null;
    b.leaseExpiresAtMs = null;
    return { ok: true, blockId, message: `Bot "${botId}" released the lease on block "${blockId}".`, version: b.version };
  }

  /**
   * Write a block (optimistic concurrency: `expectedVersion` must
   * match the current version, or the write is refused). The writer
   * must be attached; a live lease held by another bot also refuses.
   */
  write(
    blockId: string,
    input: { text: string; byBotId: string; expectedVersion: number; reason?: string | null },
    nowMs: number = Date.now(),
  ): FleetV26BlockOp {
    const b = this.blocks.get(blockId);
    if (!b) return { ok: false, blockId, message: `Block "${blockId}" does not exist.`, version: null };
    if (!b.attachedBotIds.includes(input.byBotId)) {
      return { ok: false, blockId, message: `Bot "${input.byBotId}" is not attached to block "${blockId}".`, version: b.version };
    }
    if (
      b.leaseHolderBotId && b.leaseHolderBotId !== input.byBotId &&
      b.leaseExpiresAtMs !== null && nowMs < b.leaseExpiresAtMs
    ) {
      return {
        ok: false,
        blockId,
        message: `Block "${blockId}" is leased to bot "${b.leaseHolderBotId}" — write refused.`,
        version: b.version,
      };
    }
    if (input.expectedVersion !== b.version) {
      return {
        ok: false,
        blockId,
        message:
          `Block "${blockId}" is at version ${b.version}, not ${input.expectedVersion} — ` +
          `re-read it and retry (another bot wrote first).`,
        version: b.version,
      };
    }
    if (input.text.length > FLEET_V26_BLOCK_MAX_CHARS) {
      return { ok: false, blockId, message: `Block text exceeds ${FLEET_V26_BLOCK_MAX_CHARS} chars.`, version: b.version };
    }
    b.version += 1;
    b.text = input.text;
    b.updatedByBotId = input.byBotId;
    b.updatedAtMs = nowMs;
    b.history.push({
      version: b.version,
      text: input.text,
      updatedByBotId: input.byBotId,
      updatedAtMs: nowMs,
      reason: input.reason ?? null,
    });
    if (b.history.length > FLEET_V26_BLOCK_HISTORY_MAX) {
      b.history.splice(0, b.history.length - FLEET_V26_BLOCK_HISTORY_MAX);
    }
    return { ok: true, blockId, message: `Block "${blockId}" written at version ${b.version}.`, version: b.version };
  }

  /** Read a block's current text (through the provider when it stores it). */
  read(blockId: string): { ok: boolean; block: FleetV26SharedBlock | null; message: string } {
    const b = this.get(blockId);
    if (!b) return { ok: false, block: null, message: `Block "${blockId}" does not exist.` };
    if (this.provider?.readBlockText) {
      const providerText = this.provider.readBlockText(blockId);
      if (providerText !== null) return { ok: true, block: { ...b, text: providerText }, message: `Block "${blockId}" read via ${this.provider.name}.` };
    }
    return { ok: true, block: b, message: `Block "${blockId}" read (local store).` };
  }

  /** History of a block (oldest first, capped). */
  history(blockId: string): FleetV26BlockVersion[] {
    const b = this.blocks.get(blockId);
    return b ? b.history.map((h) => ({ ...h })) : [];
  }

  /**
   * Search blocks. With a provider, ranking is the provider's job
   * (memory v24: fused retrieval). Without one, a plain substring
   * scan — labelled as fallback, never as semantic search.
   */
  searchBlocks(
    query: string,
    limit = 10,
  ): { via: string; results: Array<{ blockId: string; score: number; snippet: string }> } {
    const q = query.trim();
    if (!q) return { via: this.provider ? this.provider.name : 'local-fallback', results: [] };
    if (this.provider) {
      return { via: this.provider.name, results: this.provider.searchBlocks(q, limit).slice(0, limit) };
    }
    const needle = q.toLowerCase();
    const results: Array<{ blockId: string; score: number; snippet: string }> = [];
    for (const b of this.list()) {
      const hay = `${b.id} ${b.name} ${b.title} ${b.text}`.toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 40);
      results.push({
        blockId: b.id,
        score: 1,
        snippet: (start > 0 ? '…' : '') + b.text.slice(start, start + 120) + (start + 120 < b.text.length ? '…' : ''),
      });
      if (results.length >= limit) break;
    }
    return { via: 'local-fallback', results };
  }

  /** Delete a block (detaches every bot first). */
  remove(blockId: string): FleetV26BlockOp {
    const b = this.blocks.get(blockId);
    if (!b) return { ok: false, blockId, message: `Block "${blockId}" does not exist.`, version: null };
    this.blocks.delete(blockId);
    return { ok: true, blockId, message: `Block "${blockId}" removed (${b.attachedBotIds.length} bot(s) detached).`, version: null };
  }

  /** Counts for the panel. */
  counts(): { blocks: number; attachedBots: number; leased: number; versions: number } {
    let attached = 0;
    let leased = 0;
    let versions = 0;
    for (const b of this.blocks.values()) {
      attached += b.attachedBotIds.length;
      if (b.leaseHolderBotId) leased += 1;
      versions += b.history.length;
    }
    return { blocks: this.blocks.size, attachedBots: attached, leased, versions };
  }

  /** JSON round-trip. */
  toJSON(): { blocks: FleetV26SharedBlock[]; providerName: string | null } {
    return { blocks: this.list(), providerName: this.providerName() };
  }

  static fromJSON(data: { blocks?: FleetV26SharedBlock[] }): FleetV26SharedBlockRegistry {
    const reg = new FleetV26SharedBlockRegistry();
    for (const b of data.blocks ?? []) {
      if (b && isBlockId(b.id)) {
        reg.blocks.set(b.id, {
          ...b,
          attachedBotIds: [...(b.attachedBotIds ?? [])],
          tags: [...(b.tags ?? [])],
          history: (b.history ?? []).map((h) => ({ ...h })),
        });
      }
    }
    return reg;
  }
}

/** One-line summary for the shared-blocks panel. */
export function summarizeFleetV26SharedBlocks(reg: FleetV26SharedBlockRegistry): string {
  const c = reg.counts();
  const via = reg.providerName() ?? 'local-fallback';
  return (
    `${c.blocks} shared block(s), ${c.attachedBots} attachment(s), ${c.leased} leased, ` +
    `${c.versions} version(s) in history (search via ${via})`
  );
}
