/**
 * Memory v4 tools for @open-bot/tools (v1.03, Team T2).
 *
 * The agent works with the v4 memory system by tool call:
 *  - memory_v4_shared_group   — shared-block groups cross-agent:
 *    create/list/add-member/remove-member/attach-block/detach-block/
 *    delete (needsApproval: true — writes + propagation)
 *  - memory_v4_shared_resolve — which blocks a bot sees via its
 *    groups, + sync report (read)
 *  - memory_v4_judge_message  — Mem0-style one-message pipeline:
 *    extract -> judge (ADD/UPDATE/DELETE/NOISE/QUARANTINE/SKIP) ->
 *    apply (needsApproval: true)
 *  - memory_v4_scored_dream   — sleep-time consolidation with
 *    scoring: extract from unprocessed episodes, score, promote
 *    top-N to the human block (needsApproval: true)
 *  - memory_v4_validity       — temporal validity windows:
 *    report / parse-hint / set-window / extend / close / sweep
 *    (needsApproval: true — writes; report + parse-hint are reads
 *    but share the tool, so approval covers the write actions)
 *  - memory_v4_scoped_recall  — per-scope retrieval fused across
 *    graph facts + long-term entries + memory blocks (read)
 *
 * SAFETY: reads never return vector embeddings; writes go through
 * the stores (validation + provenance); noise never enters the
 * graph; conflicts and suspicious content are never auto-applied —
 * the judge routes them to quarantine; validity sweep only
 * soft-deletes (history stays queryable via factHistory).
 *
 * Factory:
 *   createMemoryV4Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V4_TOOLS                       (unbound placeholder)
 */
import type {
  FactExtractor,
  LongTermMemory,
  MemoryBlockStore,
  SharedBlockGroupStore,
  TemporalGraphStore,
  Tool,
} from '@open-bot/core';
import {
  RuleBasedFactExtractor,
  SharedBlockGroupStore as SharedGroups,
  classifyNoise,
  judgeAndConsolidateMessage,
  parseValidityHint,
  runScoredDreamPass,
  retrieveScoped,
  setValidityWindow,
  extendValidity,
  closeValidity,
  sweepExpiredFacts,
  validityReport,
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

export interface MemoryV4ToolOptions {
  /** Temporal graph store of the workspace (required for most tools). */
  graphStore?: TemporalGraphStore;
  /** Workspace dir of the bot (shared groups + validity sweep log live here). */
  workspaceDir?: string;
  /** Memory block store (required for shared groups / scored dream). */
  blocksStore?: MemoryBlockStore;
  /** Shared-block group store (default: new store on workspaceDir). */
  sharedGroups?: SharedBlockGroupStore;
  /** Long-term memory store (for scoped recall). */
  longTerm?: LongTermMemory;
  /** Fact extractor for the judge pipeline (default: deterministic rules, no model). */
  extractor?: FactExtractor;
  /** Current userId (from profile.json); absent = no user filter. */
  getUserId?: () => string | undefined;
  /** App scope id for the workspace (absent = no app scope). */
  appId?: string;
}

export function createMemoryV4Tools(opts: MemoryV4ToolOptions = {}): Tool[] {
  const { graphStore, blocksStore, workspaceDir } = opts;
  const extractor: FactExtractor = opts.extractor ?? new RuleBasedFactExtractor();
  const userIdOf = (): string | undefined => {
    try {
      const id = opts.getUserId?.();
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const needStore = (): TemporalGraphStore => {
    if (!graphStore) {
      throw new Error(
        'memory v4 graph store is not available in this session (host must pass graphStore to createMemoryV4Tools).',
      );
    }
    return graphStore;
  };
  const needBlocks = (): MemoryBlockStore => {
    if (!blocksStore) {
      throw new Error(
        'memory block store is not available in this session (host must pass blocksStore to createMemoryV4Tools).',
      );
    }
    return blocksStore;
  };
  const needWorkspaceDir = (): string => {
    if (!workspaceDir) {
      throw new Error('workspaceDir is required (host must pass it to createMemoryV4Tools).');
    }
    return workspaceDir;
  };
  const needGroups = (): SharedBlockGroupStore => {
    if (opts.sharedGroups) return opts.sharedGroups;
    return new SharedGroups(needWorkspaceDir(), needBlocks());
  };
  const scopeOf = (ctx: { botId: string; runId?: string }) => ({
    userId: userIdOf() ?? '',
    botId: ctx.botId,
    runId: ctx.runId ?? '',
    ...(opts.appId ? { appId: opts.appId } : {}),
  });

  const sharedGroup: Tool = {
    definition: toolDef(
      'memory_v4_shared_group',
      'Manage shared memory-block groups (Letta-style shared blocks): one block attached to a group is visible to every bot in the group — update once, every member sees it. Actions: create, list, add-member (catches the new bot up on all group blocks), remove-member, attach-block, detach-block, delete. Needs user approval first.',
      {
        action: { type: 'string', description: '"create" | "list" | "add-member" | "remove-member" | "attach-block" | "detach-block" | "delete".' },
        group: { type: 'string', description: 'Group name or id (required except for "list").' },
        description: { type: 'string', description: 'Group description (create only).' },
        botId: { type: 'string', description: 'Bot id to add/remove (add-member / remove-member).' },
        role: { type: 'string', description: '"read" | "write" (add-member, default "read").' },
        block: { type: 'string', description: 'Block label or id (attach-block / detach-block).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const groups = needGroups();
        const action = getStringArg(args, 'action');
        const actor = `agent:${ctx.botId}`;
        switch (action) {
          case 'create': {
            const group = groups.createGroup(
              {
                name: getStringArg(args, 'group'),
                description: getOptionalStringArg(args, 'description'),
                createdByBotId: ctx.botId,
              },
              actor,
            );
            return JSON.stringify({ created: group }, null, 2);
          }
          case 'list': {
            return JSON.stringify({ groups: groups.listGroups() }, null, 2);
          }
          case 'add-member': {
            const group = groups.addMember(
              getStringArg(args, 'group'),
              getStringArg(args, 'botId'),
              (getOptionalStringArg(args, 'role') ?? 'read') as 'read' | 'write',
              actor,
            );
            return JSON.stringify({ updated: group }, null, 2);
          }
          case 'remove-member': {
            const group = groups.removeMember(
              getStringArg(args, 'group'),
              getStringArg(args, 'botId'),
              actor,
            );
            return JSON.stringify({ updated: group }, null, 2);
          }
          case 'attach-block': {
            const group = groups.attachBlockToGroup(
              getStringArg(args, 'group'),
              getStringArg(args, 'block'),
              actor,
            );
            return JSON.stringify({ updated: group }, null, 2);
          }
          case 'detach-block': {
            const group = groups.detachBlockFromGroup(
              getStringArg(args, 'group'),
              getStringArg(args, 'block'),
              actor,
            );
            return JSON.stringify({ updated: group }, null, 2);
          }
          case 'delete': {
            const deleted = groups.deleteGroup(getStringArg(args, 'group'), actor);
            return JSON.stringify({ deleted }, null, 2);
          }
          default:
            return errorResult(
              `Unknown action "${action}" (expected create/list/add-member/remove-member/attach-block/detach-block/delete).`,
            );
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sharedResolve: Tool = {
    definition: toolDef(
      'memory_v4_shared_resolve',
      'Read-only: which memory blocks a bot sees (direct attachments + shared groups, with the group each block came from), or the sync report of a group (which members are missing which blocks, orphaned blocks). Read-only.',
      {
        botId: { type: 'string', description: 'Bot id to resolve blocks for (resolve mode).' },
        group: { type: 'string', description: 'Group name or id for a sync report (sync-report mode).' },
        mode: { type: 'string', description: '"resolve" (default) or "sync-report".' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const groups = needGroups();
        const mode = getOptionalStringArg(args, 'mode') ?? 'resolve';
        if (mode === 'sync-report') {
          const report = groups.groupSyncReport(getStringArg(args, 'group'));
          return JSON.stringify(report, null, 2);
        }
        if (mode !== 'resolve') {
          return errorResult(`Unknown mode "${mode}" (expected resolve/sync-report).`);
        }
        const botId = getOptionalStringArg(args, 'botId') ?? ctx.botId;
        const resolved = groups.resolveBlocksForBot(botId);
        return JSON.stringify(
          {
            botId,
            blocks: resolved.map((r) => ({
              id: r.block.id,
              label: r.block.label,
              description: r.block.description,
              version: r.block.version,
              via: r.via,
              ...(r.viaGroupName ? { viaGroupName: r.viaGroupName } : {}),
              ...(r.roleInGroup ? { roleInGroup: r.roleInGroup } : {}),
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const judgeMessage: Tool = {
    definition: toolDef(
      'memory_v4_judge_message',
      'Mem0-style one-message pipeline: extract candidate facts from ONE message, judge each one (ADD / UPDATE / DELETE / NOISE / QUARANTINE / SKIP — noise like greetings never enters the graph), then apply the non-noise decisions to the temporal graph. Conflicts with high-confidence facts and suspicious content go to quarantine, never auto-applied. Needs user approval first.',
      {
        text: { type: 'string', description: 'Message text to remember (max 8000 chars).' },
        turnId: { type: 'string', description: 'Turn id (dedupes re-ingest; absent = generated from time).' },
        role: { type: 'string', description: '"user" | "assistant" (default "user").' },
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const text = getStringArg(args, 'text').slice(0, 8000);
        const scope = scopeOf(ctx);
        const noise = classifyNoise(text);
        if (noise !== null) {
          return JSON.stringify(
            { noise, extracted: 0, note: 'Message carries no durable fact — nothing stored.' },
            null,
            2,
          );
        }
        const turnId = getOptionalStringArg(args, 'turnId') ?? `judge-${Date.now()}`;
        const role = getOptionalStringArg(args, 'role') ?? 'user';
        const episode = store.ingestEpisode({
          turnId,
          runId: scope.runId,
          botId: scope.botId,
          userId: scope.userId,
          role,
          text,
        });
        const report = await judgeAndConsolidateMessage(store, extractor, text, scope, {
          turnId,
          runId: scope.runId,
          episodeId: episode.id,
          at: new Date().toISOString(),
        });
        return JSON.stringify(
          {
            episodeId: episode.id,
            duplicateEpisode: episode.duplicate,
            extracted: report.verdicts.length,
            noise: report.noise,
            added: report.added,
            updated: report.updated,
            deleted: report.deleted,
            quarantined: report.quarantined,
            skipped: report.skipped,
            verdicts: report.verdicts.map((v) => ({
              decision: v.decision,
              subject: v.candidate.subjectName,
              predicate: v.candidate.predicate,
              object: v.candidate.objectText,
              reason: v.reason,
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scoredDream: Tool = {
    definition: toolDef(
      'memory_v4_scored_dream',
      'Sleep-time consolidation with scoring: extract facts from unprocessed episodes, score each one (confidence + frequency + corroboration across episodes + recency − contradiction penalty), and promote only the top-N facts scoring high enough into the human block. Low-scoring facts stay in their episodes and gain frequency if repeated. Needs user approval first.',
      {
        minScore: { type: 'number', description: 'Minimum score to promote (default 0.5).' },
        maxPromote: { type: 'number', description: 'Max facts to promote (default 10).' },
        maxEpisodes: { type: 'number', description: 'Max unprocessed episodes to examine (default 50).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const blocks = needBlocks();
        const report = await runScoredDreamPass(store, blocks, {
          scope: scopeOf(ctx),
          minScore: getNumberArg(args, 'minScore'),
          maxPromote: getNumberArg(args, 'maxPromote'),
          maxEpisodes: getNumberArg(args, 'maxEpisodes'),
          extractor,
          actor: `dream:scored:${ctx.botId}`,
        });
        return JSON.stringify(
          {
            episodesSeen: report.episodesSeen,
            candidatesScored: report.candidatesScored,
            promoted: report.promoted,
            skippedLowScore: report.skippedLowScore,
            contradictions: report.contradictions,
            promotedFacts: report.promotedFacts.map((f) => ({
              subject: f.subjectName,
              predicate: f.predicate,
              object: f.objectText,
              score: Math.round(f.score.total * 10000) / 10000,
              mentions: f.mentionCount,
              episodes: f.episodeCount,
            })),
            details: report.details,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const validity: Tool = {
    definition: toolDef(
      'memory_v4_validity',
      'Temporal validity windows for graph facts (Zep-style bi-temporal validity): report facts that expired / expire soon / have open-ended or invalid windows; parse a validity hint from text ("từ 2020 đến 2024", "until 2026-12-31"); set / extend / close a fact\'s validity window; sweep expired facts (soft-delete only — history stays queryable). Needs user approval first.',
      {
        action: { type: 'string', description: '"report" | "parse-hint" | "set-window" | "extend" | "close" | "sweep".' },
        factId: { type: 'string', description: 'Fact id (set-window / extend / close).' },
        text: { type: 'string', description: 'Text to parse a validity hint from (parse-hint).' },
        validFrom: { type: 'string', description: 'ISO date/datetime (set-window / extend).' },
        validUntil: { type: 'string', description: 'ISO date/datetime, or empty to reopen the window (set-window / extend).' },
        expiringSoonDays: { type: 'number', description: 'Days ahead that count as "expiring soon" (report, default 30).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const dir = needWorkspaceDir();
        const scope = scopeOf(ctx);
        const action = getStringArg(args, 'action');
        switch (action) {
          case 'report': {
            const report = validityReport(store, scope, new Date(), getNumberArg(args, 'expiringSoonDays'));
            const summarize = (list: typeof report.expired) =>
              list.map((e) => ({
                factId: e.fact.id,
                subject: e.subjectName,
                predicate: e.fact.predicate,
                object: e.fact.objectText,
                validFrom: e.fact.validFrom,
                validUntil: e.fact.validUntil,
                daysUntilExpiry:
                  e.daysUntilExpiry === null ? null : Math.round(e.daysUntilExpiry * 100) / 100,
              }));
            return JSON.stringify(
              {
                checkedAt: report.checkedAt,
                totalActive: report.totalActive,
                expired: summarize(report.expired),
                expiringSoon: summarize(report.expiringSoon),
                openEndedCount: report.openEnded.length,
                invalidWindows: summarize(report.invalidWindows),
              },
              null,
              2,
            );
          }
          case 'parse-hint': {
            const hint = parseValidityHint(getStringArg(args, 'text'));
            return JSON.stringify({ hint }, null, 2);
          }
          case 'set-window': {
            const window: { validFrom?: string; validUntil?: string | null } = {};
            const fromArg = getOptionalStringArg(args, 'validFrom');
            if (fromArg !== undefined) window.validFrom = fromArg;
            const untilArg = getOptionalStringArg(args, 'validUntil');
            if (untilArg !== undefined) window.validUntil = untilArg === '' ? null : untilArg;
            const fact = setValidityWindow(store, getStringArg(args, 'factId'), window);
            return JSON.stringify({ updated: fact }, null, 2);
          }
          case 'extend': {
            const fact = extendValidity(store, getStringArg(args, 'factId'), {
              ...(getOptionalStringArg(args, 'validFrom')
                ? { validFrom: getStringArg(args, 'validFrom') }
                : {}),
              ...(getOptionalStringArg(args, 'validUntil') !== undefined
                ? { validUntil: getOptionalStringArg(args, 'validUntil') ?? null }
                : {}),
            });
            return JSON.stringify({ updated: fact }, null, 2);
          }
          case 'close': {
            const fact = closeValidity(store, getStringArg(args, 'factId'), new Date());
            return JSON.stringify({ updated: fact }, null, 2);
          }
          case 'sweep': {
            const result = sweepExpiredFacts(store, scope, dir, new Date(), `agent:${ctx.botId}`);
            return JSON.stringify(
              {
                swept: result.swept.map((f) => f.id),
                count: result.swept.length,
                logWritten: result.logWritten,
              },
              null,
              2,
            );
          }
          default:
            return errorResult(
              `Unknown action "${action}" (expected report/parse-hint/set-window/extend/close/sweep).`,
            );
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scopedRecall: Tool = {
    definition: toolDef(
      'memory_v4_scoped_recall',
      'Per-scope retrieval fused across all three memory stores: temporal-graph facts + long-term entries + memory blocks (direct + shared-group), filtered by the run/agent/user/app scope hierarchy (another user\'s facts never leak in), deduped by text and ranked by keyword hits × confidence × scope weight. Read-only.',
      {
        query: { type: 'string', description: 'Question / keywords to recall (empty = most recent in scope).' },
        limit: { type: 'number', description: 'Max results (default 20, max 100).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const hits = retrieveScoped({
          graphStore,
          longTerm: opts.longTerm,
          blocksStore,
          sharedGroups: opts.sharedGroups,
          scope: scopeOf(ctx),
          query: getOptionalStringArg(args, 'query'),
          limit: getNumberArg(args, 'limit'),
        });
        return JSON.stringify(
          {
            query: getOptionalStringArg(args, 'query') ?? '',
            hits: hits.map((h) => ({
              id: h.id,
              source: h.source,
              mergedSources: h.mergedSources,
              scopeLevel: h.scopeLevel,
              text: h.text,
              score: Math.round(h.score * 10000) / 10000,
              keywordHits: h.keywordHits,
              confidence: h.confidence,
              updatedAt: h.updatedAt,
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [sharedGroup, sharedResolve, judgeMessage, scoredDream, validity, scopedRecall];
}

/** Unbound placeholder (same shape as MEMORY_V3_TOOLS). */
export const MEMORY_V4_TOOLS: Tool[] = createMemoryV4Tools();

/** Names of the memory v4 tools (for the coordinator/registry checks). */
export const MEMORY_V4_TOOL_NAMES = [
  'memory_v4_shared_group',
  'memory_v4_shared_resolve',
  'memory_v4_judge_message',
  'memory_v4_scored_dream',
  'memory_v4_validity',
  'memory_v4_scoped_recall',
] as const;
