/**
 * Memory v6 tools for @open-bot/tools (v1.05, Team T1).
 *
 * The agent works with the v6 memory system by tool call:
 *  - memory_v6_append             — append a record ADD-only at a
 *    chosen scope (run/agent/user/app); exact duplicates dedupe
 *    (needsApproval: true)
 *  - memory_v6_recall             — resolve one key across the scope
 *    hierarchy (narrowest scope wins) (read)
 *  - memory_v6_forget             — "delete" a record by scope: append
 *    a retire event (add-only, history kept, needs a reason)
 *    (needsApproval: true)
 *  - memory_v6_fused_search       — fused retrieval (semantic via
 *    embedding or TF-IDF fallback + BM25 + entity match) with a score
 *    breakdown per hit (read)
 *  - memory_v6_share_block        — shared memory blocks between bots
 *    in the fleet: create/update/share/unshare/get/list (write actions
 *    need approval; get/list are reads)
 *  - memory_v6_sleep_consolidate  — run one sleep-time consolidation
 *    pass now (dedupe + summarize old clusters + quarantine
 *    contradictions) (needsApproval: true)
 *  - memory_v6_stats              — store stats: counts by kind /
 *    bucket / scope level / status + version-chain health (read)
 *  - memory_v6_migrate            — migrate memory v5 (long-term
 *    entries and/or graph facts) into the v6 store, idempotent
 *    (needsApproval: true)
 *
 * SAFETY: reads never return embeddings (v6 does not persist vectors
 * at all); writes go through the add-only store (validation +
 * provenance); retire/quarantine never delete bytes; share/unshare
 * only by the block owner; migration never touches the old stores.
 *
 * Factory:
 *   createMemoryV6Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V6_TOOLS                       (unbound placeholder)
 */
import type {
  LongTermMemory,
  OllamaEmbeddings,
  SharedBlockStore,
  TemporalGraphStore,
  Tool,
  V6RecordKind,
  V6RecordStore,
  V6ScopeLevel,
} from '@open-bot/core';
import {
  agentScope,
  appendSleepV6Log,
  emptyV6Scope,
  explainFusedHit,
  fusedRetrieveV6,
  getScopedMemory,
  migrateGraphFacts,
  migrateLongTermMemory,
  migrationReportMarkdown,
  normalizeFusedWeights,
  retireRecord,
  runConsolidationV6,
  runScope,
  scopeLevelOf,
  userScope,
  validateVersionChain,
  V6BlockError,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

const SCOPE_LEVELS: V6ScopeLevel[] = ['run', 'agent', 'user', 'app'];
const RECORD_KINDS: V6RecordKind[] = ['fact', 'preference', 'summary', 'episode', 'note'];

export interface MemoryV6ToolOptions {
  /** v6 record store of the workspace (required for most tools). */
  v6Store?: V6RecordStore;
  /** Workspace dir of the bot (sleep log + migration sources live here). */
  workspaceDir?: string;
  /** Shared block store (required for memory_v6_share_block). */
  blocksStore?: SharedBlockStore;
  /** Long-term memory store (required for memory_v6_migrate, source longterm). */
  longTerm?: LongTermMemory;
  /** Temporal graph store (required for memory_v6_migrate, source graph). */
  graphStore?: TemporalGraphStore;
  /** Embedder for the semantic source (absent = TF-IDF fallback, no network). */
  embedder?: OllamaEmbeddings;
  /** Current userId (from profile.json); absent = no user filter. */
  getUserId?: () => string | undefined;
  /** App scope id for the workspace (absent = no app scope). */
  appId?: string;
}

export function createMemoryV6Tools(opts: MemoryV6ToolOptions = {}): Tool[] {
  const { v6Store, blocksStore, longTerm, graphStore } = opts;
  const userIdOf = (): string => {
    try {
      const id = opts.getUserId?.();
      return typeof id === 'string' ? id.trim() : '';
    } catch {
      return '';
    }
  };
  const needStore = (): V6RecordStore => {
    if (!v6Store) {
      throw new Error(
        'memory v6 store is not available in this session (host must pass v6Store to createMemoryV6Tools).',
      );
    }
    return v6Store;
  };
  const needBlocksStore = (): SharedBlockStore => {
    if (!blocksStore) {
      throw new Error(
        'shared block store is not available in this session (host must pass blocksStore to createMemoryV6Tools).',
      );
    }
    return blocksStore;
  };
  /**
   * Scope ghi/đọc theo mức yêu cầu + ctx của bot đang chạy.
   * runId không nằm trong ToolContext nên agent truyền qua arg `runId`
   * khi muốn ghi ở mức run; thiếu runId thì hạ xuống mức agent và ghi
   * chú thích vào kết quả (fail-soft, không throw).
   */
  const scopeOf = (ctx: { botId: string }, level: V6ScopeLevel, runId?: string) => {
    const userId = userIdOf();
    const appId = opts.appId ?? '';
    if (level === 'run') {
      if (runId && runId.trim() !== '') return runScope(userId, ctx.botId, runId.trim(), appId);
      return agentScope(userId, ctx.botId, appId);
    }
    if (level === 'agent') return agentScope(userId, ctx.botId, appId);
    if (level === 'user') return userScope(userId, appId);
    return { ...emptyV6Scope(), appId };
  };
  const parseScopeLevel = (args: Record<string, unknown>): V6ScopeLevel => {
    const raw = getOptionalStringArg(args, 'scopeLevel');
    if (raw === undefined) return 'agent';
    if ((SCOPE_LEVELS as string[]).includes(raw)) return raw as V6ScopeLevel;
    throw new Error(`scopeLevel must be one of ${SCOPE_LEVELS.join(', ')}, got "${raw}".`);
  };
  const parseKind = (args: Record<string, unknown>): V6RecordKind => {
    const raw = getOptionalStringArg(args, 'kind');
    if (raw === undefined) return 'fact';
    if ((RECORD_KINDS as string[]).includes(raw)) return raw as V6RecordKind;
    throw new Error(`kind must be one of ${RECORD_KINDS.join(', ')}, got "${raw}".`);
  };

  const append: Tool = {
    definition: toolDef(
      'memory_v6_append',
      'Append a memory record ADD-only (Mem0-v3 style) at a chosen scope (run/agent/user/app): the new record is stored NEXT TO any old one, never updating or deleting in place. Exact duplicates (same text + scope + kind, still active) dedupe to the existing record. Needs user approval first.',
      {
        text: { type: 'string', description: 'Memory text (max 8000 chars), e.g. "User likes phở for breakfast".' },
        kind: { type: 'string', enum: RECORD_KINDS, description: 'Record kind (default "fact").' },
        key: { type: 'string', description: 'Optional key for key/value facts (e.g. "home_city") — used to detect contradictions.' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Entities mentioned (e.g. ["hà nội", "phở"]).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags.' },
        confidence: { type: 'number', description: 'Confidence 0..1 (default 0.8).' },
        scopeLevel: { type: 'string', enum: SCOPE_LEVELS, description: 'Scope level to write at (default "agent").' },
        runId: { type: 'string', description: 'Run id when scopeLevel is "run" (falls back to agent scope without it).' },
        sourceText: { type: 'string', description: 'Original sentence the memory came from (provenance).' },
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const text = getStringArg(args, 'text');
        const kind = parseKind(args);
        const level = parseScopeLevel(args);
        const runId = getOptionalStringArg(args, 'runId');
        const scope = scopeOf(ctx, level, runId);
        const effectiveLevel = scopeLevelOf(scope);
        const view = store.append({
          kind,
          key: getOptionalStringArg(args, 'key'),
          text,
          entities: getStringArrayArg(args, 'entities'),
          tags: getStringArrayArg(args, 'tags'),
          confidence: getNumberArg(args, 'confidence'),
          scope,
          source: {
            type: 'tool',
            ref: 'memory_v6_append',
            botId: ctx.botId,
            sourceText: getOptionalStringArg(args, 'sourceText') ?? text,
          },
        });
        const note =
          level === 'run' && effectiveLevel !== 'run'
            ? ' (note: no runId was given, so the record was written at agent scope instead of run scope)'
            : '';
        return JSON.stringify(
          { id: view.id, version: view.version, kind: view.kind, scopeLevel: effectiveLevel, status: view.status, note },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const recall: Tool = {
    definition: toolDef(
      'memory_v6_recall',
      'Resolve one memory key across the scope hierarchy (run > agent > user > app): the narrowest scope that has the key wins. Returns the winning record plus how many candidates were visible. Read-only.',
      {
        key: { type: 'string', description: 'Memory key to resolve, e.g. "home_city".' },
        runId: { type: 'string', description: 'Run id of the current run (to see run-scoped memories).' },
      },
      ['key'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const key = getStringArg(args, 'key');
        const runId = getOptionalStringArg(args, 'runId');
        const query = {
          userId: userIdOf(),
          agentId: ctx.botId,
          ...(runId ? { runId } : {}),
          ...(opts.appId ? { appId: opts.appId } : {}),
        };
        const winner = getScopedMemory(store, query, key);
        if (!winner) return JSON.stringify({ key, found: false }, null, 2);
        return JSON.stringify(
          {
            key,
            found: true,
            text: winner.text,
            scopeLevel: scopeLevelOf(winner.scope),
            version: winner.version,
            confidence: winner.confidence,
            createdAt: winner.createdAt,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const forget: Tool = {
    definition: toolDef(
      'memory_v6_forget',
      '"Delete" a memory v6 record by id: appends a retire event (add-only — the record stays in the file and its history stays queryable; it just stops being active). A non-empty reason is required for audit. Needs user approval first.',
      {
        id: { type: 'string', description: 'Id of the v6 record to retire.' },
        reason: { type: 'string', description: 'Why this memory is retired (required, kept in the audit log).' },
      },
      ['id', 'reason'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const store = needStore();
        const id = getStringArg(args, 'id');
        const reason = getStringArg(args, 'reason');
        const event = retireRecord(store, id, 'tool:memory_v6_forget', reason);
        return JSON.stringify({ id, status: 'retired', eventSeq: event.seq, at: event.at }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fusedSearch: Tool = {
    definition: toolDef(
      'memory_v6_fused_search',
      'Fused retrieval over v6 memories: semantic (Ollama embedding when available, otherwise local TF-IDF fallback) + BM25 keyword + entity match, merged with configurable weights, boosted by scope narrowness and recency decay. Every hit includes a score breakdown explaining why it was chosen. Read-only.',
      {
        query: { type: 'string', description: 'Search query, e.g. "what does the user like to eat".' },
        topK: { type: 'number', description: 'Max hits (default 10, max 50).' },
        weightSemantic: { type: 'number', description: 'Semantic weight 0..1 (default 0.45).' },
        weightBm25: { type: 'number', description: 'BM25 weight 0..1 (default 0.35).' },
        weightEntity: { type: 'number', description: 'Entity weight 0..1 (default 0.2).' },
        runId: { type: 'string', description: 'Run id of the current run (to see run-scoped memories).' },
        kind: { type: 'string', enum: RECORD_KINDS, description: 'Only return records of this kind.' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const query = getStringArg(args, 'query');
        const runId = getOptionalStringArg(args, 'runId');
        const weights = normalizeFusedWeights({
          ...(getNumberArg(args, 'weightSemantic') !== undefined
            ? { semantic: getNumberArg(args, 'weightSemantic') as number }
            : {}),
          ...(getNumberArg(args, 'weightBm25') !== undefined
            ? { bm25: getNumberArg(args, 'weightBm25') as number }
            : {}),
          ...(getNumberArg(args, 'weightEntity') !== undefined
            ? { entity: getNumberArg(args, 'weightEntity') as number }
            : {}),
        });
        const kindRaw = getOptionalStringArg(args, 'kind');
        const hits = await fusedRetrieveV6(store, query, {
          scope: {
            userId: userIdOf(),
            agentId: ctx.botId,
            ...(runId ? { runId } : {}),
            ...(opts.appId ? { appId: opts.appId } : {}),
          },
          weights,
          topK: getNumberArg(args, 'topK'),
          embedder: opts.embedder,
          kinds: kindRaw ? [kindRaw as V6RecordKind] : undefined,
        });
        return JSON.stringify(
          hits.map((hit) => ({
            id: hit.record.id,
            text: hit.record.text,
            kind: hit.record.kind,
            scopeLevel: hit.scopeLevel,
            bucket: hit.temporal.bucket,
            score: Number(hit.breakdown.final.toFixed(4)),
            breakdown: {
              semantic: Number(hit.breakdown.semantic.toFixed(4)),
              semanticSource: hit.breakdown.semanticSource,
              bm25: Number(hit.breakdown.bm25.toFixed(4)),
              entity: Number(hit.breakdown.entity.toFixed(4)),
              scopeBoost: Number(hit.breakdown.scopeBoost.toFixed(2)),
              recencyDecay: Number(hit.breakdown.recencyDecay.toFixed(4)),
            },
            explanation: explainFusedHit(hit, weights),
          })),
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const shareBlock: Tool = {
    definition: toolDef(
      'memory_v6_share_block',
      'Shared memory blocks between bots in the fleet (Letta style): create a block, update its content (new version, history kept), share it with another bot (read/write), unshare it, or read/list blocks this bot can see. Only the block owner can share, unshare or delete. Write actions need user approval; get/list are reads.',
      {
        action: { type: 'string', enum: ['create', 'update', 'share', 'unshare', 'get', 'list'], description: 'What to do with the block.' },
        name: { type: 'string', description: 'Block name (required for create; used to find a block for get).' },
        blockId: { type: 'string', description: 'Block id (required for update/share/unshare; alternative to name for get).' },
        content: { type: 'string', description: 'Block content (required for create/update).' },
        targetBotId: { type: 'string', description: 'Bot to share with / unshare (required for share/unshare).' },
        permission: { type: 'string', enum: ['read', 'write'], description: 'Permission to grant (required for share).' },
        reason: { type: 'string', description: 'Reason for an update (kept in the version history).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = needBlocksStore();
        const action = getStringArg(args, 'action');
        const ownerBotId = ctx.botId;
        if (action === 'list') {
          const blocks = store.listBlocksFor(ownerBotId).map((b) => ({
            id: b.id,
            name: b.name,
            ownerBotId: b.ownerBotId,
            version: b.version,
            permission: store.permissionFor(b, ownerBotId),
            updatedAt: b.updatedAt,
          }));
          return JSON.stringify({ action, blocks }, null, 2);
        }
        if (action === 'create') {
          const block = store.createBlock(ownerBotId, getStringArg(args, 'name'), getStringArg(args, 'content'));
          return JSON.stringify({ action, id: block.id, name: block.name, version: block.version }, null, 2);
        }
        if (action === 'get') {
          const blockId = getOptionalStringArg(args, 'blockId');
          const name = getOptionalStringArg(args, 'name');
          const block = blockId
            ? store.getBlock(blockId)
            : name
              ? store.getBlockByName(name)
              : undefined;
          if (!block) return errorResult('Block not found (pass blockId or name).');
          if (store.permissionFor(block, ownerBotId) === undefined) {
            return errorResult(`Bot "${ownerBotId}" has no access to block "${block.name}".`);
          }
          return JSON.stringify(
            {
              action,
              id: block.id,
              name: block.name,
              content: block.content,
              ownerBotId: block.ownerBotId,
              version: block.version,
              historyVersions: block.history.length,
              updatedAt: block.updatedAt,
            },
            null,
            2,
          );
        }
        if (action === 'update') {
          const block = store.updateBlock(
            ownerBotId,
            getStringArg(args, 'blockId'),
            getStringArg(args, 'content'),
            getOptionalStringArg(args, 'reason'),
          );
          return JSON.stringify({ action, id: block.id, name: block.name, version: block.version }, null, 2);
        }
        if (action === 'share') {
          const block = store.shareBlock(
            ownerBotId,
            getStringArg(args, 'blockId'),
            getStringArg(args, 'targetBotId'),
            (getStringArg(args, 'permission') === 'write' ? 'write' : 'read') as 'read' | 'write',
          );
          return JSON.stringify(
            { action, id: block.id, name: block.name, sharedWith: getStringArg(args, 'targetBotId') },
            null,
            2,
          );
        }
        if (action === 'unshare') {
          const block = store.unshareBlock(
            ownerBotId,
            getStringArg(args, 'blockId'),
            getStringArg(args, 'targetBotId'),
          );
          return JSON.stringify(
            { action, id: block.id, name: block.name, unshared: getStringArg(args, 'targetBotId') },
            null,
            2,
          );
        }
        return errorResult(`Unknown action "${action}" (expected create/update/share/unshare/get/list).`);
      } catch (err) {
        if (err instanceof V6BlockError) return errorResult(err.message);
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepConsolidate: Tool = {
    definition: toolDef(
      'memory_v6_sleep_consolidate',
      'Run one sleep-time consolidation pass over v6 memories now (Letta style): exact dedupe, near-dup dedupe, summarize old clusters into summary records, and quarantine contradictory records for later review. Everything is add-only — nothing is ever deleted. Needs user approval first.',
      {
        maxRecords: { type: 'number', description: 'Max records to examine this run (default 500).' },
        maxMs: { type: 'number', description: 'Time budget for this run in ms (default 30000).' },
        summarizeOlderThanDays: { type: 'number', description: 'Only summarize clusters older than this many days (default 30).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const store = needStore();
        const report = runConsolidationV6(store, {
          config: {
            ...(getNumberArg(args, 'maxRecords') !== undefined
              ? { maxRecordsPerRun: getNumberArg(args, 'maxRecords') as number }
              : {}),
            ...(getNumberArg(args, 'maxMs') !== undefined
              ? { maxMsPerRun: getNumberArg(args, 'maxMs') as number }
              : {}),
            ...(getNumberArg(args, 'summarizeOlderThanDays') !== undefined
              ? { summarizeOlderThanDays: getNumberArg(args, 'summarizeOlderThanDays') as number }
              : {}),
          },
          actor: 'tool:memory_v6_sleep_consolidate',
        });
        if (opts.workspaceDir) {
          try {
            appendSleepV6Log(opts.workspaceDir, report);
          } catch {
            // Ghi log lỗi thì bỏ qua — không fail lần chạy.
          }
        }
        return JSON.stringify(
          {
            runId: report.runId,
            durationMs: report.durationMs,
            examined: report.examined,
            dedupedExact: report.dedupedExact,
            dedupedNear: report.dedupedNear,
            summarizedClusters: report.summarizedClusters,
            summaryRecords: report.summaryRecords,
            quarantined: report.quarantined,
            superseded: report.superseded,
            stoppedByBudget: report.stoppedByBudget,
            errors: report.errors,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stats: Tool = {
    definition: toolDef(
      'memory_v6_stats',
      'Memory v6 store statistics: total/active/superseded/retired/quarantined counts, breakdown by kind, temporal bucket and scope level, plus version-chain health (any broken supersedes links). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const store = needStore();
        const chainProblems = validateVersionChain(store);
        return JSON.stringify(
          { ...store.stats(), versionChainProblems: chainProblems },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const migrate: Tool = {
    definition: toolDef(
      'memory_v6_migrate',
      'Migrate memory v5 into the v6 store: long-term key/value entries and/or temporal-graph facts become v6 records (add-only, source "migration", graph supersession chains preserved). Idempotent — running it twice does not duplicate records. The old stores are never modified. Needs user approval first.',
      {
        source: { type: 'string', enum: ['longterm', 'graph', 'all'], description: 'Which v5 source to migrate (default "all").' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const store = needStore();
        const source = getOptionalStringArg(args, 'source') ?? 'all';
        if (!['longterm', 'graph', 'all'].includes(source)) {
          return errorResult(`source must be one of longterm/graph/all, got "${source}".`);
        }
        const reports: string[] = [];
        if ((source === 'longterm' || source === 'all') && longTerm) {
          reports.push(
            migrationReportMarkdown([
              migrateLongTermMemory(longTerm, store, { appId: opts.appId ?? '' }),
            ]),
          );
        } else if (source === 'longterm' || source === 'all') {
          return errorResult('Long-term memory store is not available (host must pass longTerm to createMemoryV6Tools).');
        }
        if ((source === 'graph' || source === 'all') && graphStore) {
          reports.push(
            migrationReportMarkdown([
              migrateGraphFacts(graphStore.listFacts(), store, {
                appId: opts.appId ?? '',
                resolveName: (id: string) => graphStore.getEntity(id)?.name,
              }),
            ]),
          );
        } else if (source === 'graph' || source === 'all') {
          return errorResult('Graph store is not available (host must pass graphStore to createMemoryV6Tools).');
        }
        return reports.join('\n\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [append, recall, forget, fusedSearch, shareBlock, sleepConsolidate, stats, migrate];
}

/** Unbound placeholder (same shape as MEMORY_V5_TOOLS). */
export const MEMORY_V6_TOOLS: Tool[] = createMemoryV6Tools();

/** Names of the memory v6 tools (for the coordinator/registry checks). */
export const MEMORY_V6_TOOL_NAMES = [
  'memory_v6_append',
  'memory_v6_recall',
  'memory_v6_forget',
  'memory_v6_fused_search',
  'memory_v6_share_block',
  'memory_v6_sleep_consolidate',
  'memory_v6_stats',
  'memory_v6_migrate',
] as const;
