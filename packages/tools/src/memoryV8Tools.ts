/**
 * Memory v8 tools for @open-bot/tools (v1.07, Team T1).
 *
 * The agent works with the v8 memory system by tool call:
 *  - memory_v8_sleep_status    — sleep policy + lần chạy gần nhất + preview (read)
 *  - memory_v8_sleep_config    — đổi policy sleep (bật/tắt, idleMs, giờ yên lặng, giới hạn ngày) (needsApproval: true)
 *  - memory_v8_sleep_run       — chạy consolidation sleep ngay (dry-run được) (needsApproval: true)
 *  - memory_v8_local_search    — fused retrieval 3 tín hiệu LOCAL (keyword + entity + recency, không embedding) (read)
 *  - memory_v8_provenance      — provenance của một bản ghi (nguồn gốc, trust, bằng chứng, flag) (read)
 *  - memory_v8_review_list     — hàng đợi duyệt chống poisoning (read)
 *  - memory_v8_review_decide   — user duyệt/từ chối một fact nghi ngờ (needsApproval: true)
 *  - memory_v8_poisoning_scan  — quét kho tìm dấu hiệu poisoning (mâu thuẫn/burst/nội dung nghi ngờ) (read)
 *  - memory_v8_fleet_export    — export gói đồng bộ shared block (read)
 *  - memory_v8_fleet_import    — merge gói fleet vào store local (needsApproval: true)
 *  - memory_v8_fleet_status    — trạng thái đồng bộ fleet (read)
 *  - memory_v8_erase_user      — export rồi xóa dữ liệu của một user (GDPR) (needsApproval: true)
 *
 * SAFETY: retrieval v8 không có embedder — không thể rò embedding;
 * sleep không bao giờ xóa không dấu vết (block gốc còn trong git
 * history); review quyết định chỉ user mới xóa fact; erasure export
 * trước khi xóa + verify sau xóa + audit log. Không tuyên bố điểm
 * benchmark nào (xem V8_NO_BENCHMARK_CLAIM trong core).
 *
 * Factory:
 *   createMemoryV8Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V8_TOOLS                       (unbound placeholder)
 */
import type {
  GitMemoryProjection,
  SharedBlockStore,
  Tool,
  V6RecordStore,
  V8ErasureScope,
} from '@open-bot/core';
import {
  buildV8Provenance,
  countV8SleepRunsToday,
  ErasureService,
  exportFleetSyncPacket,
  fleetSyncStatus,
  GitMemoryProjection as GitMemoryProjectionClass,
  importFleetSyncPacket,
  localFusedRetrieve,
  newV8ErasureRequest,
  parseFleetSyncPacket,
  PoisoningReviewQueue,
  readV8SleepLedger,
  scanStoreForPoisoning,
  flagScanResults,
  formatV8ErasureReport,
  serializeFleetSyncPacket,
  SharedBlockStore as SharedBlockStoreClass,
  SleepV8Scheduler,
  SourceTrustRegistry,
  V6RecordStore as V6RecordStoreClass,
  V8_NO_BENCHMARK_CLAIM,
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

function getBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
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

export interface MemoryV8ToolOptions {
  /** Workspace dir (required: policy/ledger/queue/audit + projection live here). */
  workspaceDir?: string;
  /** Pre-built v6 record store (defaults to a new one on workspaceDir). */
  v6Store?: V6RecordStore;
  /** Pre-built git-backed projection (defaults to a new one on workspaceDir). */
  projection?: GitMemoryProjection;
  /** Pre-built shared block store (defaults to a new one on workspaceDir). */
  sharedBlocks?: SharedBlockStore;
  /** Current userId (from profile.json); absent = no user filter. */
  getUserId?: () => string | undefined;
}

export function createMemoryV8Tools(opts: MemoryV8ToolOptions = {}): Tool[] {
  const needWorkspaceDir = (): string => {
    if (!opts.workspaceDir) {
      throw new Error('workspaceDir is required (host must pass it to createMemoryV8Tools).');
    }
    return opts.workspaceDir;
  };
  const storeOf = (): V6RecordStore => {
    if (opts.v6Store) return opts.v6Store;
    return V6RecordStoreClass.fromWorkspace(needWorkspaceDir());
  };
  const projectionOf = (): GitMemoryProjection => {
    if (opts.projection) return opts.projection;
    return new GitMemoryProjectionClass(needWorkspaceDir());
  };
  const sharedOf = (): SharedBlockStore => {
    if (opts.sharedBlocks) return opts.sharedBlocks;
    return SharedBlockStoreClass.fromWorkspace(needWorkspaceDir());
  };
  const queueOf = (): PoisoningReviewQueue =>
    PoisoningReviewQueue.fromWorkspace(needWorkspaceDir());
  const registryOf = (): SourceTrustRegistry =>
    SourceTrustRegistry.fromWorkspace(needWorkspaceDir());

  const sleepStatus: Tool = {
    definition: toolDef(
      'memory_v8_sleep_status',
      'Sleep-time compute status (v8, read): current sleep policy (enabled, idle threshold, quiet hours, daily run limit), runs today, last run report, and a dry-run preview (how many old blocks would be compressed, how many v6 records would be examined). Preview writes nothing.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const dir = needWorkspaceDir();
        const scheduler = new SleepV8Scheduler({
          store: storeOf(),
          workspaceDir: dir,
          projection: projectionOf(),
        });
        const policy = scheduler.getPolicy();
        const preview = scheduler.preview();
        const ledger = readV8SleepLedger(dir);
        const last = ledger.length > 0 ? ledger[ledger.length - 1] : null;
        return JSON.stringify(
          {
            policy,
            runsToday: countV8SleepRunsToday(dir),
            totalRunsInLedger: ledger.length,
            lastRun: last ?? null,
            preview: {
              v6RecordsToExamine: preview.v6DryRun.examined,
              blocksToCompress: preview.blockPlan ? preview.blockPlan.candidates.length : 0,
              compressionClusters: preview.blockPlan ? preview.blockPlan.clusters : 0,
              summaryLabels: preview.blockPlan ? preview.blockPlan.summaryLabels : [],
            },
            note: 'Preview v6 chỉ ước lượng số bản ghi sẽ xem xét; số dedupe/quarantine chính xác chỉ biết khi chạy thật.',
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepConfig: Tool = {
    definition: toolDef(
      'memory_v8_sleep_config',
      'Change the sleep-time compute policy (v8, needs user approval): enable/disable sleep, idle threshold in ms, quiet hours (local time, no run even when idle), max runs per day (0 = unlimited), how old a block must be to compress, min blocks per compression cluster. Policy is saved to disk immediately. Needs user approval first.',
      {
        enabled: { type: 'boolean', description: 'Enable/disable sleep-time compute.' },
        idleMs: { type: 'number', description: 'Idle threshold in ms (default 300000 = 5 minutes).' },
        quietStartHour: { type: 'number', description: 'Quiet hours start (0-23 local time).' },
        quietEndHour: { type: 'number', description: 'Quiet hours end (0-23 local time). start == end = no quiet hours.' },
        maxRunsPerDay: { type: 'number', description: 'Max sleep runs per day (0 = unlimited, default 24).' },
        compressBlocksOlderThanDays: { type: 'number', description: 'Only compress blocks older than this many days (default 30).' },
        minBlocksToCompress: { type: 'number', description: 'Min blocks per compression cluster (default 2).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const dir = needWorkspaceDir();
        const scheduler = new SleepV8Scheduler({
          store: storeOf(),
          workspaceDir: dir,
          projection: projectionOf(),
        });
        const patch: Record<string, unknown> = {};
        const enabled = getBooleanArg(args, 'enabled');
        if (enabled !== undefined) patch.enabled = enabled;
        const idleMs = getNumberArg(args, 'idleMs');
        if (idleMs !== undefined) patch.idleMs = idleMs;
        const maxRuns = getNumberArg(args, 'maxRunsPerDay');
        if (maxRuns !== undefined) patch.maxRunsPerDay = maxRuns;
        const olderThan = getNumberArg(args, 'compressBlocksOlderThanDays');
        if (olderThan !== undefined) patch.compressBlocksOlderThanDays = olderThan;
        const minBlocks = getNumberArg(args, 'minBlocksToCompress');
        if (minBlocks !== undefined) patch.minBlocksToCompress = minBlocks;
        const quietStart = getNumberArg(args, 'quietStartHour');
        const quietEnd = getNumberArg(args, 'quietEndHour');
        if (quietStart !== undefined && (!Number.isInteger(quietStart) || quietStart < 0 || quietStart > 23)) {
          throw new Error('quietStartHour phải là số nguyên 0..23.');
        }
        if (quietEnd !== undefined && (!Number.isInteger(quietEnd) || quietEnd < 0 || quietEnd > 23)) {
          throw new Error('quietEndHour phải là số nguyên 0..23.');
        }
        if (quietStart !== undefined || quietEnd !== undefined) {
          const current = scheduler.getPolicy().quietHours;
          patch.quietHours = {
            startHour: quietStart ?? current.startHour,
            endHour: quietEnd ?? current.endHour,
          };
        }
        const policy = scheduler.setPolicy(patch as Parameters<SleepV8Scheduler['setPolicy']>[0]);
        return JSON.stringify({ policy }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepRun: Tool = {
    definition: toolDef(
      'memory_v8_sleep_run',
      'Run sleep-time consolidation now (v8, needs user approval): dedupe + summarize + quarantine v6 records, then compress old v7 blocks into summary blocks (originals stay recoverable in git history). dryRun=true only previews, writes nothing. Needs user approval first.',
      {
        dryRun: { type: 'boolean', description: 'Only preview, do not write (default false).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const dir = needWorkspaceDir();
        const scheduler = new SleepV8Scheduler({
          store: storeOf(),
          workspaceDir: dir,
          projection: projectionOf(),
        });
        const report = await scheduler.runNow({
          ...(getBooleanArg(args, 'dryRun') === true ? { dryRun: true } : {}),
        });
        return JSON.stringify({ report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const localSearch: Tool = {
    definition: toolDef(
      'memory_v8_local_search',
      'Local-only fused memory search (v8, read): 3 signals computed locally from raw text — keyword BM25 + entity match + recency decay. NO embedding, NO network, NO model call. Each hit explains its score (keyword/entity/recency breakdown). No benchmark scores are claimed for this retrieval.',
      {
        query: { type: 'string', description: 'Search query (keywords, names, places).' },
        limit: { type: 'number', description: 'Max hits (default 10, max 50).' },
        keywordWeight: { type: 'number', description: 'Weight of the keyword signal (default 0.5).' },
        entityWeight: { type: 'number', description: 'Weight of the entity signal (default 0.3).' },
        recencyWeight: { type: 'number', description: 'Weight of the recency signal (default 0.2).' },
        recencyHalfLifeDays: { type: 'number', description: 'Recency half-life in days (default 30).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query');
        const weights: Record<string, number> = {};
        const kw = getNumberArg(args, 'keywordWeight');
        if (kw !== undefined) weights.keyword = kw;
        const ew = getNumberArg(args, 'entityWeight');
        if (ew !== undefined) weights.entity = ew;
        const rw = getNumberArg(args, 'recencyWeight');
        if (rw !== undefined) weights.recency = rw;
        const hits = localFusedRetrieve(storeOf(), query, {
          ...(opts.getUserId?.() ? { userId: opts.getUserId() as string } : {}),
          ...(Object.keys(weights).length > 0 ? { weights } : {}),
          ...(getNumberArg(args, 'limit') !== undefined ? { topK: getNumberArg(args, 'limit') as number } : {}),
          ...(getNumberArg(args, 'recencyHalfLifeDays') !== undefined
            ? { recencyHalfLifeDays: getNumberArg(args, 'recencyHalfLifeDays') as number }
            : {}),
        });
        return JSON.stringify(
          { hits, localOnly: true, noBenchmarkClaim: V8_NO_BENCHMARK_CLAIM },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const provenance: Tool = {
    definition: toolDef(
      'memory_v8_provenance',
      'Provenance of one memory record (v8, read): where the fact came from (source kind + origin), who wrote it, when, trust score (adjusted by the per-source trust registry), evidence chain, suspicion flags, and whether it is quarantined. Use it to answer "why does the bot believe this?".',
      {
        recordId: { type: 'string', description: 'Id of the v6 record.' },
      },
      ['recordId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const recordId = getStringArg(args, 'recordId');
        const record = storeOf().getById(recordId);
        if (!record) throw new Error(`Không tìm thấy bản ghi v6 "${recordId}".`);
        const prov = buildV8Provenance(record, { registry: registryOf() });
        return JSON.stringify({ provenance: prov }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const reviewList: Tool = {
    definition: toolDef(
      'memory_v8_review_list',
      'Anti-poisoning review queue (v8, read): facts flagged as suspicious (injection-like content, contradictions, burst writes from one source, low-trust source) waiting for the user to approve or reject. Returns pending counts by status and the pending items (newest first).',
      {
        status: { type: 'string', description: '"pending" (default) | "approved" | "rejected" | "expired" | "all".' },
        limit: { type: 'number', description: 'Max items (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const queue = queueOf();
        const status = getOptionalStringArg(args, 'status') ?? 'pending';
        const limit = getNumberArg(args, 'limit') ?? 20;
        const items =
          status === 'all'
            ? queue.list()
            : status === 'pending' || status === 'approved' || status === 'rejected' || status === 'expired'
              ? queue.list(status)
              : (() => {
                  throw new Error(`status phải là "pending", "approved", "rejected", "expired" hoặc "all", nhận được "${status}".`);
                })();
        return JSON.stringify(
          { counts: queue.counts(), items: items.slice(0, Math.max(1, Math.floor(limit))) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const reviewDecide: Tool = {
    definition: toolDef(
      'memory_v8_review_decide',
      'Decide one flagged fact (v8, needs user approval): "approved" trusts the fact again (restores it from quarantine when quarantined); "rejected" retires the fact (never trusted again). Only the user decides — the agent never auto-deletes a fact. Needs user approval first.',
      {
        itemId: { type: 'string', description: 'Id of the review queue item.' },
        decision: { type: 'string', description: '"approved" or "rejected".' },
        note: { type: 'string', description: 'Optional note from the reviewer.' },
      },
      ['itemId', 'decision'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const itemId = getStringArg(args, 'itemId');
        const decision = getStringArg(args, 'decision');
        if (decision !== 'approved' && decision !== 'rejected') {
          throw new Error(`decision phải là "approved" hoặc "rejected", nhận được "${decision}".`);
        }
        const item = queueOf().decide(itemId, decision, {
          by: `user:${ctx.botId}`,
          ...(getOptionalStringArg(args, 'note') ? { note: getOptionalStringArg(args, 'note') as string } : {}),
          store: storeOf(),
        });
        return JSON.stringify({ item }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const poisoningScan: Tool = {
    definition: toolDef(
      'memory_v8_poisoning_scan',
      'Scan the v6 store for poisoning signs (v8, read): injection-like content, contradiction clusters (same key, different values across scopes), and burst writes (one source writing many facts in minutes). The scan only reads. With flagIntoQueue=true the findings are added to the review queue for the user to decide.',
      {
        flagIntoQueue: { type: 'boolean', description: 'Add findings to the review queue (default false).' },
        burstThreshold: { type: 'number', description: 'Facts per burst window that count as a burst (default 10).' },
        burstWindowMinutes: { type: 'number', description: 'Burst window in minutes (default 5).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const store = storeOf();
        const report = scanStoreForPoisoning(store, {
          ...(getNumberArg(args, 'burstThreshold') !== undefined
            ? { burstThreshold: getNumberArg(args, 'burstThreshold') as number }
            : {}),
          ...(getNumberArg(args, 'burstWindowMinutes') !== undefined
            ? { burstWindowMinutes: getNumberArg(args, 'burstWindowMinutes') as number }
            : {}),
        });
        let flagged = 0;
        if (getBooleanArg(args, 'flagIntoQueue') === true) {
          flagged = flagScanResults(queueOf(), store, report);
        }
        return JSON.stringify({ report, flaggedIntoQueue: flagged }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fleetExport: Tool = {
    definition: toolDef(
      'memory_v8_fleet_export',
      'Export a fleet sync packet (v8, read): all local shared memory blocks with their version vectors, as JSON. The packet is plain data — carry it to another machine/bot (file, USB, tunnel) and merge it there with memory_v8_fleet_import. No network is used by this tool.',
      {
        fromBotId: { type: 'string', description: 'Bot id exporting the packet.' },
      },
      ['fromBotId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const fromBotId = getStringArg(args, 'fromBotId');
        const packet = exportFleetSyncPacket(sharedOf(), fromBotId);
        return JSON.stringify(
          { packetId: packet.packetId, fromBotId: packet.fromBotId, blockCount: packet.blocks.length, packet: serializeFleetSyncPacket(packet) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fleetImport: Tool = {
    definition: toolDef(
      'memory_v8_fleet_import',
      'Merge a fleet sync packet into the local shared-block store (v8, needs user approval): new blocks are imported, newer incoming blocks update local ones, local-newer blocks are skipped, and concurrent edits of the same block are CONFLICTS — local is kept and the conflict is logged for the user to decide (never auto-overwritten). Needs user approval first.',
      {
        packet: { type: 'string', description: 'Fleet sync packet JSON (from memory_v8_fleet_export).' },
      },
      ['packet'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const raw = getStringArg(args, 'packet');
        const packet = parseFleetSyncPacket(raw);
        const report = importFleetSyncPacket(sharedOf(), packet, { workspaceDir: needWorkspaceDir() });
        return JSON.stringify({ report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fleetStatus: Tool = {
    definition: toolDef(
      'memory_v8_fleet_status',
      'Fleet sync status (v8, read): local shared block count, bot ids present, newest block time, sync event count, and pending merge conflicts waiting for the user.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const status = fleetSyncStatus(sharedOf(), { workspaceDir: needWorkspaceDir() });
        return JSON.stringify({ status }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const eraseUser: Tool = {
    definition: toolDef(
      'memory_v8_erase_user',
      'Export then erase one user\'s data (v8, GDPR Article 17, needs user approval): first exports the user\'s v6 records (+ v7 blocks by label, shared blocks by bot id) as a portability package, then retires + scrubs the v6 records (content really gone, tombstone left for audit), deletes the listed v7 blocks and the listed bots\' shared blocks, scrubs the user id from the provenance log, verifies nothing is left, and appends an audit-log entry. Local erasure cannot erase copies already synced to another machine — the report says so. Needs user approval first.',
      {
        userId: { type: 'string', description: 'User id to erase.' },
        scope: { type: 'string', description: '"all" (default) | "records" | "blocks" | "shared-blocks".' },
        reason: { type: 'string', description: 'Reason for erasure (default: user request, GDPR Article 17).' },
        blockLabels: { type: 'array', description: 'v7 block labels to delete (v7 blocks carry no userId, so labels must be chosen from the export).', items: { type: 'string' } },
        botIds: { type: 'array', description: 'Bot ids of the user — shared blocks owned by these bots are deleted.', items: { type: 'string' } },
      },
      ['userId'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const userId = getStringArg(args, 'userId');
        const scopeRaw = getOptionalStringArg(args, 'scope') ?? 'all';
        if (scopeRaw !== 'all' && scopeRaw !== 'records' && scopeRaw !== 'blocks' && scopeRaw !== 'shared-blocks') {
          throw new Error(`scope phải là "all", "records", "blocks" hoặc "shared-blocks", nhận được "${scopeRaw}".`);
        }
        const scope = scopeRaw as V8ErasureScope;
        const blockLabels = getStringArrayArg(args, 'blockLabels') ?? [];
        const botIds = getStringArrayArg(args, 'botIds') ?? [];
        const service = new ErasureService({
          store: storeOf(),
          workspaceDir: needWorkspaceDir(),
          projection: projectionOf(),
          sharedBlocks: sharedOf(),
        });
        // Export trước khi xóa (quyền portability) — gói export chỉ
        // tóm tắt trong kết quả (không nhồi toàn bộ dữ liệu vào
        // context của agent); host lưu gói đầy đủ nếu cần.
        const exported = service.exportUserData(userId, { botIds });
        const request = newV8ErasureRequest({
          userId,
          scope,
          ...(getOptionalStringArg(args, 'reason') ? { reason: getOptionalStringArg(args, 'reason') as string } : {}),
          requestedBy: `user:${ctx.botId}`,
        });
        const report = service.eraseUser(request, { blockLabels, botIds });
        return JSON.stringify(
          {
            exportSummary: {
              userId: exported.userId,
              records: exported.records.length,
              blocks: exported.blocks.length,
              sharedBlocks: exported.sharedBlocks.length,
              exportedAt: exported.exportedAt,
            },
            report,
            reportText: formatV8ErasureReport(report),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    sleepStatus,
    sleepConfig,
    sleepRun,
    localSearch,
    provenance,
    reviewList,
    reviewDecide,
    poisoningScan,
    fleetExport,
    fleetImport,
    fleetStatus,
    eraseUser,
  ];
}

/** Unbound placeholder (same shape as MEMORY_V7_TOOLS). */
export const MEMORY_V8_TOOLS: Tool[] = createMemoryV8Tools();

/** Names of the memory v8 tools (for the coordinator/registry checks). */
export const MEMORY_V8_TOOL_NAMES = [
  'memory_v8_sleep_status',
  'memory_v8_sleep_config',
  'memory_v8_sleep_run',
  'memory_v8_local_search',
  'memory_v8_provenance',
  'memory_v8_review_list',
  'memory_v8_review_decide',
  'memory_v8_poisoning_scan',
  'memory_v8_fleet_export',
  'memory_v8_fleet_import',
  'memory_v8_fleet_status',
  'memory_v8_erase_user',
] as const;
