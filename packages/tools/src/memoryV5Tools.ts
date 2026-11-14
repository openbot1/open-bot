/**
 * Memory v5 tools for @open-bot/tools (v1.04, Team T1).
 *
 * The agent works with the v5 memory system by tool call:
 *  - memory_v5_addonly_append  — append a fact ADD-only (new fact
 *    sits next to the old one, never updates/deletes in place;
 *    exact duplicates dedupe) (needsApproval: true)
 *  - memory_v5_addonly_rank    — ranking of ADD-only groups: winner
 *    vs losers per (subject, predicate) + contradiction rate (read)
 *  - memory_v5_addonly_recall  — retrieval where ranking decides
 *    the winner (winnersOnly by default) (read)
 *  - memory_v5_bitemporal_query — "what was true at time T, as
 *    known at record time R" + edge validity intervals (read)
 *  - memory_v5_invalidate      — invalidate a fact (closes its
 *    validity window, keeps history + audit log) (needsApproval: true)
 *  - memory_v5_ingest          — Cognee-style ingestion of text /
 *    file / directory into the graph (needsApproval: true)
 *  - memory_v5_health          — memory health dashboard data:
 *    score, contradiction rate, staleness, coverage, quarantine
 *    backlog, contradiction groups, recent consolidation runs (read)
 *  - memory_v5_consolidate     — sleep-time consolidation v2:
 *    dedupe + ranking supersession + expired sweep + scored dream
 *    (needsApproval: true)
 *
 * SAFETY: reads never return vector embeddings; writes go through
 * the stores (validation + provenance); append never mutates an old
 * fact; ranking supersession only runs inside consolidation v2 with
 * an explicit actor and a confidence + score-gap bar; invalidation
 * needs a non-empty reason (audit); ingestion goes through
 * consolidateCandidates (suspicious content -> quarantine).
 *
 * Factory:
 *   createMemoryV5Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V5_TOOLS                       (unbound placeholder)
 */
import type {
  LongTermMemory,
  MemoryBlockStore,
  TemporalGraphStore,
  Tool,
} from '@open-bot/core';
import {
  appendFactAddOnly,
  computeMemoryHealth,
  contradictionGroupSummary,
  explainRanking,
  healthReportMarkdown,
  invalidateFact,
  ingestDocument,
  ingestFile,
  ingestDirectory,
  ingestTranscript,
  queryFactsAtBiTemporal,
  edgeValidityIntervals,
  findEdgeIntervalOverlaps,
  resolveAddOnlyGroups,
  addOnlyContradictionRate,
  retrieveAddOnly,
  runConsolidationV2,
  readConsolidationV2Log,
  consolidationV2ReportMarkdown,
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

function getBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
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

/** Strip embedding vectors before anything reaches the agent/model. */
function stripFact(fact: Record<string, unknown>): Record<string, unknown> {
  const { embedding, ...rest } = fact as { embedding?: unknown } & Record<string, unknown>;
  void embedding;
  return rest;
}

export interface MemoryV5ToolOptions {
  /** Temporal graph store of the workspace (required for most tools). */
  graphStore?: TemporalGraphStore;
  /** Workspace dir of the bot (invalidation + consolidation logs live here). */
  workspaceDir?: string;
  /** Memory block store (required for consolidation dream step). */
  blocksStore?: MemoryBlockStore;
  /** Long-term memory store (kept for symmetry with v4; unused by v5 tools). */
  longTerm?: LongTermMemory;
  /** Current userId (from profile.json); absent = no user filter. */
  getUserId?: () => string | undefined;
  /** App scope id for the workspace (absent = no app scope). */
  appId?: string;
}

export function createMemoryV5Tools(opts: MemoryV5ToolOptions = {}): Tool[] {
  const { graphStore, blocksStore, workspaceDir } = opts;
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
        'memory v5 graph store is not available in this session (host must pass graphStore to createMemoryV5Tools).',
      );
    }
    return graphStore;
  };
  const needWorkspaceDir = (): string => {
    if (!workspaceDir) {
      throw new Error('workspaceDir is required (host must pass it to createMemoryV5Tools).');
    }
    return workspaceDir;
  };
  const scopeOf = (ctx: { botId: string; runId?: string }) => ({
    userId: userIdOf() ?? '',
    botId: ctx.botId,
    runId: ctx.runId ?? '',
    ...(opts.appId ? { appId: opts.appId } : {}),
  });

  const addOnlyAppend: Tool = {
    definition: toolDef(
      'memory_v5_addonly_append',
      'Append a fact ADD-only (Mem0-v3 style): the new fact is stored NEXT TO the old one, never updating or deleting it in place. Retrieval ranking decides which fact wins. Exact duplicates (same subject + predicate + object) dedupe to the existing fact. Needs user approval first.',
      {
        subject: { type: 'string', description: 'Subject name (usually "user").' },
        predicate: { type: 'string', description: 'Normalized predicate, e.g. "likes", "lives_in", "works_at".' },
        object: { type: 'string', description: 'Object text, e.g. "phở", "Hà Nội".' },
        confidence: { type: 'number', description: 'Confidence 0..1 (default 0.8).' },
        validFrom: { type: 'string', description: 'ISO date the fact starts being true (default: now).' },
        sourceText: { type: 'string', description: 'Original sentence the fact came from (provenance).' },
      },
      ['subject', 'predicate', 'object'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const scope = scopeOf(ctx);
        const subject = getStringArg(args, 'subject');
        const predicate = getStringArg(args, 'predicate');
        const object = getStringArg(args, 'object');
        const confidence = getNumberArg(args, 'confidence');
        const sourceText = getOptionalStringArg(args, 'sourceText') ?? `${subject} ${predicate} ${object}.`;
        const episode = store.ingestEpisode({
          turnId: `tool-v5-addonly-${Date.now()}`,
          runId: scope.runId,
          botId: scope.botId,
          userId: scope.userId,
          role: 'system',
          text: sourceText,
        });
        const result = appendFactAddOnly(store, {
          subjectName: subject,
          predicate,
          objectText: object,
          ...(confidence !== undefined ? { confidence } : {}),
          scope,
          provenance: {
            episodeId: episode.id,
            turnId: `tool-v5-addonly-${Date.now()}`,
            runId: scope.runId,
            botId: scope.botId,
            userId: scope.userId,
            at: new Date().toISOString(),
            sourceText,
          },
          ...(getOptionalStringArg(args, 'validFrom') ? { validFrom: getOptionalStringArg(args, 'validFrom') } : {}),
        });
        return JSON.stringify(
          {
            duplicate: result.duplicate,
            fact: stripFact(result.fact as unknown as Record<string, unknown>),
            ...(result.groupAfter
              ? {
                  group: {
                    subjectName: result.groupAfter.subjectName,
                    predicate: result.groupAfter.predicate,
                    hasContradiction: result.groupAfter.hasContradiction,
                    winner: result.groupAfter.winner
                      ? {
                          objectText: result.groupAfter.winner.fact.objectText,
                          score: Math.round(result.groupAfter.winner.score.total * 10000) / 10000,
                        }
                      : null,
                    losers: result.groupAfter.losers.map((l) => ({
                      objectText: l.fact.objectText,
                      score: Math.round(l.score.total * 10000) / 10000,
                    })),
                  },
                }
              : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const addOnlyRank: Tool = {
    definition: toolDef(
      'memory_v5_addonly_rank',
      'Rank ADD-only fact groups (read): every (subject, predicate) group with its winner and losers by rank score, plus the contradiction rate (groups with 2+ different objects / all groups). Use to see which fact currently wins and which ones are demoted but kept.',
      {
        subject: { type: 'string', description: 'Only groups for this subject (optional).' },
        predicate: { type: 'string', description: 'Only groups with this predicate (optional).' },
        contradictionsOnly: { type: 'boolean', description: 'Only return contradictory groups (default false).' },
        limit: { type: 'number', description: 'Max groups (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const scope = scopeOf(ctx);
        const subject = getOptionalStringArg(args, 'subject');
        const predicate = getOptionalStringArg(args, 'predicate');
        const contradictionsOnly = getBooleanArg(args, 'contradictionsOnly') ?? false;
        const limit = getNumberArg(args, 'limit') ?? 20;
        const rate = addOnlyContradictionRate(store, scope);
        let groups = resolveAddOnlyGroups(store, scope);
        if (subject) groups = groups.filter((g) => g.subjectName === subject);
        if (predicate) groups = groups.filter((g) => g.predicate === predicate);
        if (contradictionsOnly) groups = groups.filter((g) => g.hasContradiction);
        return JSON.stringify(
          {
            contradictionRate: rate,
            groups: groups.slice(0, Math.max(1, Math.min(200, Math.floor(limit)))).map((g) => ({
              subjectName: g.subjectName,
              predicate: g.predicate,
              hasContradiction: g.hasContradiction,
              distinctObjects: g.distinctObjects,
              winner: g.winner
                ? {
                    factId: g.winner.fact.id,
                    objectText: g.winner.fact.objectText,
                    confidence: g.winner.fact.confidence,
                    score: Math.round(g.winner.score.total * 10000) / 10000,
                    explanation: explainRanking(g, g.winner.fact.id),
                  }
                : null,
              losers: g.losers.map((l) => ({
                factId: l.fact.id,
                objectText: l.fact.objectText,
                confidence: l.fact.confidence,
                score: Math.round(l.score.total * 10000) / 10000,
                explanation: explainRanking(g, l.fact.id),
              })),
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

  const addOnlyRecall: Tool = {
    definition: toolDef(
      'memory_v5_addonly_recall',
      'Retrieve facts with ADD-only ranking (read): score = keyword hits x rank score. With winnersOnly (default true) each (subject, predicate) group contributes only its winning fact — losers stay in the store and stay queryable via memory_v5_addonly_rank, they just do not reach the answer.',
      {
        query: { type: 'string', description: 'Keywords to search for (empty = most recent winners).' },
        winnersOnly: { type: 'boolean', description: 'Only winners per group (default true).' },
        limit: { type: 'number', description: 'Max hits (default 20).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const scope = scopeOf(ctx);
        const query = getStringArg(args, 'query', false);
        const winnersOnly = getBooleanArg(args, 'winnersOnly') ?? true;
        const limit = getNumberArg(args, 'limit') ?? 20;
        const hits = retrieveAddOnly(store, query, scope, { winnersOnly, limit });
        return JSON.stringify(
          {
            hits: hits.map((h) => ({
              fact: stripFact(h.fact as unknown as Record<string, unknown>),
              subjectName: h.subjectName,
              ...(h.objectName ? { objectName: h.objectName } : {}),
              rankScore: Math.round(h.rankScore * 10000) / 10000,
              isWinner: h.isWinner,
              contradictingCount: h.contradictingCount,
              score: Math.round(h.score * 10000) / 10000,
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

  const biTemporalQuery: Tool = {
    definition: toolDef(
      'memory_v5_bitemporal_query',
      'Bi-temporal query (read, Graphiti-style): "what was true at time T, as known at record time R?" — facts whose event-validity window covers T and that the system already knew at R. With subject + predicate it also returns the edge validity intervals (every version of that relation) and any overlapping intervals (unresolved contradictions).',
      {
        at: { type: 'string', description: 'Event time T (ISO date/datetime, required).' },
        recordedAt: { type: 'string', description: 'Record time R (ISO, default: now).' },
        subject: { type: 'string', description: 'Subject for edge intervals (optional).' },
        predicate: { type: 'string', description: 'Predicate for edge intervals (optional).' },
        limit: { type: 'number', description: 'Max facts (default 100).' },
      },
      ['at'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const scope = scopeOf(ctx);
        const at = getStringArg(args, 'at');
        const recordedAt = getOptionalStringArg(args, 'recordedAt');
        const limit = getNumberArg(args, 'limit') ?? 100;
        const rows = queryFactsAtBiTemporal(store, at, {
          scope,
          ...(recordedAt ? { recordedAt } : {}),
          limit,
        });
        const subject = getOptionalStringArg(args, 'subject');
        const predicate = getOptionalStringArg(args, 'predicate');
        let intervals: unknown = undefined;
        let overlaps: unknown = undefined;
        if (subject && predicate) {
          const list = edgeValidityIntervals(store, subject, predicate, scope);
          intervals = list;
          overlaps = findEdgeIntervalOverlaps(list);
        }
        return JSON.stringify(
          {
            at,
            ...(recordedAt ? { recordedAt } : {}),
            facts: rows.map((r) => ({
              fact: stripFact(r.fact as unknown as Record<string, unknown>),
              subjectName: r.subjectName,
              ...(r.objectName ? { objectName: r.objectName } : {}),
              currentAtRecordTime: r.currentAtRecordTime,
            })),
            ...(intervals !== undefined ? { intervals, overlaps } : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const invalidate: Tool = {
    definition: toolDef(
      'memory_v5_invalidate',
      'Invalidate a fact (Graphiti-style, needs user approval): close its validity window at invalidAt because it contradicts newer evidence. The fact is NOT deleted — it stays true before invalidAt and stays queryable in history. A non-empty reason is required for the audit log.',
      {
        factId: { type: 'string', description: 'Id of the fact to invalidate.' },
        invalidAt: { type: 'string', description: 'ISO time from which the fact stops being true.' },
        reason: { type: 'string', description: 'Why it is invalid (required, audit trail).' },
        conflictingFactId: { type: 'string', description: 'Id of the contradicting fact (optional).' },
      },
      ['factId', 'invalidAt', 'reason'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const workspaceDir = needWorkspaceDir();
        const result = invalidateFact(
          store,
          getStringArg(args, 'factId'),
          getStringArg(args, 'invalidAt'),
          getStringArg(args, 'reason'),
          `agent:${ctx.botId}`,
          {
            workspaceDir,
            ...(getOptionalStringArg(args, 'conflictingFactId')
              ? { conflictingFactId: getOptionalStringArg(args, 'conflictingFactId') }
              : {}),
          },
        );
        return JSON.stringify(
          {
            fact: stripFact(result.fact as unknown as Record<string, unknown>),
            record: result.record,
            logWritten: result.logWritten,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const ingest: Tool = {
    definition: toolDef(
      'memory_v5_ingest',
      'Ingest text / a file / a directory / a chat transcript into the temporal graph (Cognee-style, needs user approval): chunk by markdown headings, paragraphs and code fences (with overlap), extract entities/relations per chunk, dedupe by chunk hash + fact key, consolidate through the normal pipeline (suspicious content goes to quarantine). Provenance records the source file + chunk for every fact. dryRun extracts without writing.',
      {
        action: { type: 'string', description: '"text" | "file" | "directory" | "transcript".' },
        text: { type: 'string', description: 'Document text (action "text") or chat transcript with "User:" / "Assistant:" turns (action "transcript").' },
        sourceLabel: { type: 'string', description: 'Source label for the text (default "text").' },
        filePath: { type: 'string', description: 'File to ingest (action "file").' },
        dir: { type: 'string', description: 'Directory to ingest (action "directory").' },
        dryRun: { type: 'boolean', description: 'Extract + dedupe only, do not write (default false).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const scope = scopeOf(ctx);
        const action = getStringArg(args, 'action');
        const dryRun = getBooleanArg(args, 'dryRun') ?? false;
        if (action === 'text') {
          const text = getStringArg(args, 'text');
          const report = await ingestDocument(store, text, {
            scope,
            sourceLabel: getOptionalStringArg(args, 'sourceLabel') ?? 'text',
            dryRun,
            runId: scope.runId,
          });
          return JSON.stringify({ report }, null, 2);
        }
        if (action === 'file') {
          const report = await ingestFile(store, getStringArg(args, 'filePath'), {
            scope,
            dryRun,
            runId: scope.runId,
          });
          return JSON.stringify({ report }, null, 2);
        }
        if (action === 'directory') {
          const report = await ingestDirectory(store, getStringArg(args, 'dir'), {
            scope,
            dryRun,
            runId: scope.runId,
          });
          return JSON.stringify({ report }, null, 2);
        }
        if (action === 'transcript') {
          const report = await ingestTranscript(store, getStringArg(args, 'text'), {
            scope,
            sourceLabel: getOptionalStringArg(args, 'sourceLabel') ?? 'transcript',
            runId: scope.runId,
          });
          return JSON.stringify({ report }, null, 2);
        }
        throw new Error('action phải là "text", "file", "directory" hoặc "transcript".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const health: Tool = {
    definition: toolDef(
      'memory_v5_health',
      'Memory health dashboard data (read): overall score 0..100 + grade, fact counts, contradiction rate, staleness, orphan entities, quarantine backlog, top predicates, per-issue explanations, contradiction groups with winners/losers, and recent consolidation v2 runs.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const scope = scopeOf(ctx);
        const workspaceDir = needWorkspaceDir();
        const health = computeMemoryHealth(store, scope);
        const groups = contradictionGroupSummary(store, scope);
        const recentRuns = readConsolidationV2Log(workspaceDir, 5);
        return JSON.stringify(
          {
            health,
            markdown: healthReportMarkdown(health),
            contradictionGroups: groups,
            recentConsolidationRuns: recentRuns,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const consolidate: Tool = {
    definition: toolDef(
      'memory_v5_consolidate',
      'Run sleep-time consolidation v2 (needs user approval): merge exact-duplicate facts, supersede ranking losers (only when the winner is confident and far ahead), sweep expired facts, run the scored dream pass into the human block, then report health before/after. Nothing is hard-deleted — merged/superseded/swept facts stay queryable in history.',
      {
        dreamMinScore: { type: 'number', description: 'Min score for the dream pass to promote (default 0.5).' },
        dreamMaxPromote: { type: 'number', description: 'Max facts the dream pass promotes (default 10).' },
        skipDream: { type: 'boolean', description: 'Skip the dream step (default false).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = needStore();
        const scope = scopeOf(ctx);
        const workspaceDir = needWorkspaceDir();
        const report = await runConsolidationV2(store, {
          scope,
          workspaceDir,
          actor: `agent:${ctx.botId}`,
          ...(blocksStore ? { blocksStore } : {}),
          ...(getNumberArg(args, 'dreamMinScore') !== undefined
            ? { dreamMinScore: getNumberArg(args, 'dreamMinScore') }
            : {}),
          ...(getNumberArg(args, 'dreamMaxPromote') !== undefined
            ? { dreamMaxPromote: getNumberArg(args, 'dreamMaxPromote') }
            : {}),
          ...(getBooleanArg(args, 'skipDream') !== undefined
            ? { skipDream: getBooleanArg(args, 'skipDream') }
            : {}),
        });
        return JSON.stringify(
          {
            summary: {
              ranAt: report.ranAt,
              duplicatesMerged: report.duplicatesMerged,
              groupsResolved: report.groupsResolved,
              losersSuperseded: report.losersSuperseded,
              losersDeferred: report.losersDeferred,
              expiredSwept: report.expiredSwept,
              orphanEntitiesPruned: report.orphanEntitiesPruned,
              dreamPromoted: report.dreamPromoted,
              healthSummary: report.healthSummary,
              logWritten: report.logWritten,
            },
            markdown: consolidationV2ReportMarkdown(report),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [addOnlyAppend, addOnlyRank, addOnlyRecall, biTemporalQuery, invalidate, ingest, health, consolidate];
}

/** Unbound placeholder (same shape as MEMORY_V4_TOOLS). */
export const MEMORY_V5_TOOLS: Tool[] = createMemoryV5Tools();

/** Names of the memory v5 tools (for the coordinator/registry checks). */
export const MEMORY_V5_TOOL_NAMES = [
  'memory_v5_addonly_append',
  'memory_v5_addonly_rank',
  'memory_v5_addonly_recall',
  'memory_v5_bitemporal_query',
  'memory_v5_invalidate',
  'memory_v5_ingest',
  'memory_v5_health',
  'memory_v5_consolidate',
] as const;
