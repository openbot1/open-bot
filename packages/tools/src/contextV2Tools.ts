/**
 * Context v2 tools for @open-bot/tools (v1.05, Team T4).
 *
 * The agent works with context engineering v2 by tool call:
 *  - context_v2_compact_tiered — compact turns into tier 1/2/3
 *    summaries (anchors kept verbatim, summaries verified against
 *    their sources, window segments registered + old turns evicted
 *    past the policy trigger) (needsApproval: true)
 *  - context_v2_verify_summary — grade a summary's claims against
 *    cited sources: verified / unverifiable / contradicted (read)
 *  - context_v2_window_stats — 1M-token window stats: usage,
 *    thresholds 50/80/95%, per-kind/per-tier totals, spill (read)
 *  - context_v2_set_policy — set a bot's compaction policy
 *    (trigger, max tier, anchors kept, recent turns, frequency)
 *    + preview the tokens it would save (needsApproval: true)
 *  - context_v2_inspect — the window as a tree (segment, tokens,
 *    tier, source, spill state) (read)
 *  - context_v2_export_snapshot — export the window (+ policy) as
 *    a portable JSON snapshot (read)
 *  - context_v2_import_snapshot — import a snapshot into the
 *    window (validated; bad snapshots rejected) (needsApproval: true)
 *  - context_v2_assemble_prompt — assemble the prompt the model
 *    sees from the window (system + anchors + summaries + recent
 *    turns, within a token budget, with a dropped-segment manifest)
 *    (read)
 *  - context_v2_schedule_status — scheduler status for a bot:
 *    frequency, last run, next allowed run, runs total (read)
 *
 * SAFETY: everything is deterministic and model-free (chars/4
 * estimation, extractive summaries, string-match verification);
 * no network, no model calls. Writes go through the runtime
 * (policy store + spill dir under the workspace); import validates
 * the snapshot before touching the window.
 *
 * Factory:
 *   createContextV2Tools(opts) -> Tool[]   (bound, usable)
 *   CONTEXT_V2_TOOLS                       (in-memory runtime)
 */
import type { Tool } from '@open-bot/core';
import {
  ContextV2Runtime,
  assemblyManifest,
  buildVerifiedSummary,
  claimsFromText,
  exportSnapshot,
  importSnapshot,
  inspectWindow,
  presetCompactionPolicy,
  validateCompactionPolicy,
  validateSnapshot,
  verifiedSummaryMarkdown,
  type CompactableTurn,
  type CompactionPolicy,
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

/** Parse a JSON-encoded array of turns from a tool argument. */
function parseTurns(raw: string): CompactableTurn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('turns must be a JSON array of {id, role, content} objects');
  }
  if (!Array.isArray(parsed)) throw new Error('turns must be a JSON array');
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`turn ${index} must be an object`);
    }
    const turn = entry as Record<string, unknown>;
    if (typeof turn.role !== 'string') throw new Error(`turn ${index} needs a string "role"`);
    return {
      id: typeof turn.id === 'string' && turn.id !== '' ? turn.id : `turn-${index}`,
      turnIndex: typeof turn.turnIndex === 'number' ? turn.turnIndex : index,
      role: turn.role,
      ...(typeof turn.content === 'string' ? { content: turn.content } : {}),
      ...(typeof turn.at === 'string' ? { at: turn.at } : {}),
    } as CompactableTurn;
  });
}

function parsePolicyPatch(args: Record<string, unknown>): Partial<CompactionPolicy> {
  const patch: Partial<CompactionPolicy> = {};
  const triggerRatio = getNumberArg(args, 'triggerRatio');
  if (triggerRatio !== undefined) patch.triggerRatio = triggerRatio;
  const maxTier = getNumberArg(args, 'maxTier');
  if (maxTier !== undefined) {
    if (maxTier !== 1 && maxTier !== 2 && maxTier !== 3) {
      throw new Error('maxTier must be 1, 2 or 3');
    }
    patch.maxTier = maxTier as 1 | 2 | 3;
  }
  const keepRecentTurns = getNumberArg(args, 'keepRecentTurns');
  if (keepRecentTurns !== undefined) patch.keepRecentTurns = keepRecentTurns;
  const frequency = getOptionalStringArg(args, 'frequency');
  if (frequency !== undefined) {
    if (frequency !== 'per-turn' && frequency !== 'hourly' && frequency !== 'manual') {
      throw new Error('frequency must be "per-turn", "hourly" or "manual"');
    }
    patch.frequency = frequency;
  }
  const keepAnchors = getOptionalStringArg(args, 'keepAnchorKinds');
  if (keepAnchors !== undefined) {
    const kinds = keepAnchors.split(',').map((k) => k.trim()).filter(Boolean);
    const valid = ['decision', 'metric', 'file-change', 'constraint', 'fact'];
    if (kinds.some((k) => !valid.includes(k))) {
      throw new Error('keepAnchorKinds must be a comma list of decision/metric/file-change/constraint/fact');
    }
    patch.keepAnchorKinds = kinds as CompactionPolicy['keepAnchorKinds'];
  }
  return patch;
}

export interface ContextV2ToolOptions {
  /** Workspace dir of the bot (policies + spill live here; absent = in-memory only). */
  workspaceDir?: string;
  /** Model name for the window limit (default gemini-2.5-flash = 1M tokens). */
  model?: string;
  /** Explicit window limit override (tokens). */
  limitTokens?: number;
  /** RAM budget for segment text (bytes). */
  ramBudgetBytes?: number;
  /** Pre-built runtime (tests / hosts that manage it themselves). */
  runtime?: ContextV2Runtime;
}

export function createContextV2Tools(opts: ContextV2ToolOptions = {}): Tool[] {
  const runtime =
    opts.runtime ??
    new ContextV2Runtime({
      ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.limitTokens !== undefined ? { limitTokens: opts.limitTokens } : {}),
      ...(opts.ramBudgetBytes !== undefined ? { ramBudgetBytes: opts.ramBudgetBytes } : {}),
    });

  const compactTiered: Tool = {
    definition: toolDef(
      'context_v2_compact_tiered',
      'Compact turns into tiered summaries (needs user approval): tier 1 = one summary per turn, tier 2 = one per topic, tier 3 = whole-session summary. Decisions, metrics, changed files and constraints are kept verbatim as anchors with source ids; every summary is verified against its source turns (hallucinated claims are flagged, never trusted). Summaries + anchors become window segments; old turn segments are evicted past the bot policy trigger.',
      {
        turns: { type: 'string', description: 'JSON array of turns: [{id, role, content, turnIndex?}].' },
      },
      ['turns'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const turns = parseTurns(getStringArg(args, 'turns'));
        const result = runtime.compactTurns(ctx.botId, turns);
        const { compaction } = result;
        return JSON.stringify(
          {
            tier1: compaction.tier1.map((s) => ({
              id: s.id,
              text: s.text,
              sourceIds: s.sourceIds,
              anchors: s.anchors,
              tokenEstimate: s.tokenEstimate,
            })),
            tier2: compaction.tier2.map((s) => ({
              id: s.id,
              topic: s.topic,
              text: s.text,
              sourceIds: s.sourceIds,
              anchors: s.anchors,
              tokenEstimate: s.tokenEstimate,
            })),
            tier3: compaction.tier3
              ? {
                  id: compaction.tier3.id,
                  text: compaction.tier3.text,
                  sourceIds: compaction.tier3.sourceIds,
                  anchors: compaction.tier3.anchors,
                  tokenEstimate: compaction.tier3.tokenEstimate,
                }
              : null,
            anchors: compaction.anchors,
            tokensBefore: compaction.tokensBefore,
            tokensAfter: compaction.tokensAfter,
            tokensSaved: compaction.tokensSaved,
            verified: result.verified.map((v) => ({
              id: v.id,
              tier: v.tier,
              topic: v.topic,
              verifiedRatio: v.verifiedRatio,
              fullyVerified: v.fullyVerified,
              claims: v.claims.map((c) => ({ text: c.text, status: c.status, detail: c.detail, sourceIds: c.sourceIds })),
            })),
            segmentIds: result.segmentIds,
            evictedSegmentIds: result.evictedSegmentIds,
            alerts: result.alerts,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const verifySummary: Tool = {
    definition: toolDef(
      'context_v2_verify_summary',
      'Verify a summary against its cited sources (read): split the summary into claims, check every claim\'s salient words, numbers and names against the cited source texts. Status per claim: verified (all tokens found), unverifiable (paraphrase or missing source), contradicted (states a number/name no source contains — hallucination). Returns the graded claims + overall ratio.',
      {
        summaryText: { type: 'string', description: 'Summary text (one claim per sentence/line).' },
        sources: { type: 'string', description: 'JSON array of sources: [{id, content}].' },
        tier: { type: 'number', description: 'Summary tier 1/2/3 (default 1).' },
        topic: { type: 'string', description: 'Topic label (tier 2, optional).' },
      },
      ['summaryText', 'sources'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(getStringArg(args, 'sources'));
        } catch {
          throw new Error('sources must be a JSON array of {id, content} objects');
        }
        if (!Array.isArray(parsed)) throw new Error('sources must be a JSON array');
        const sources = parsed.map((entry, index) => {
          if (typeof entry !== 'object' || entry === null || typeof (entry as { id?: unknown }).id !== 'string') {
            throw new Error(`source ${index} needs a string "id"`);
          }
          const s = entry as { id: string; content?: unknown };
          return { id: s.id, content: typeof s.content === 'string' ? s.content : '' };
        });
        const sourceIds = sources.map((s) => s.id);
        const claims = claimsFromText(getStringArg(args, 'summaryText'), sourceIds);
        const tier = getNumberArg(args, 'tier') ?? 1;
        if (tier !== 1 && tier !== 2 && tier !== 3) throw new Error('tier must be 1, 2 or 3');
        const verified = buildVerifiedSummary(claims, sources, {
          tier: tier as 1 | 2 | 3,
          topic: getOptionalStringArg(args, 'topic') ?? '',
        });
        return JSON.stringify(
          {
            verifiedRatio: verified.verifiedRatio,
            fullyVerified: verified.fullyVerified,
            claims: verified.claims.map((c) => ({ text: c.text, status: c.status, detail: c.detail, sourceIds: c.sourceIds })),
            markdown: verifiedSummaryMarkdown(verified),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const windowStats: Tool = {
    definition: toolDef(
      'context_v2_window_stats',
      'Window stats for the 1M-token context window (read): limit, used/remaining tokens, usage ratio, thresholds crossed (50%/80%/95%), per-kind and per-tier totals, segment + spilled counts, RAM bytes vs budget, evicted count.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        return JSON.stringify(runtime.window.stats(), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const setPolicy: Tool = {
    definition: toolDef(
      'context_v2_set_policy',
      'Set a bot\'s compaction policy (needs user approval): triggerRatio (0.5..0.98), maxTier (1..3), keepRecentTurns, frequency (per-turn/hourly/manual), keepAnchorKinds (comma list). With "preset" (chat/coding/long-run/minimal) the preset is applied instead of individual fields. With "previewMessages" (JSON array of messages) the reply also includes the estimated tokens the policy would save — dry run, nothing is compacted.',
      {
        preset: { type: 'string', description: 'Preset name: chat | coding | long-run | minimal (optional).' },
        triggerRatio: { type: 'number', description: 'Usage ratio that triggers compaction (0.5..0.98).' },
        maxTier: { type: 'number', description: 'Deepest tier to build (1, 2 or 3).' },
        keepRecentTurns: { type: 'number', description: 'Recent turns never compacted (0..50).' },
        frequency: { type: 'string', description: '"per-turn" | "hourly" | "manual".' },
        keepAnchorKinds: { type: 'string', description: 'Comma list: decision, metric, file-change, constraint, fact.' },
        previewMessages: { type: 'string', description: 'JSON array of messages [{role, content}] to preview savings on (optional).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const preset = getOptionalStringArg(args, 'preset');
        let policy: CompactionPolicy;
        if (preset) {
          policy = presetCompactionPolicy(ctx.botId, preset);
          // A preset + explicit overrides: apply the overrides on top.
          const patch = parsePolicyPatch(args);
          const errors = validateCompactionPolicy(patch);
          if (errors.length > 0) throw new Error(`invalid compaction policy: ${errors.join('; ')}`);
          policy = { ...policy, ...patch, botId: ctx.botId, updatedAt: new Date().toISOString() };
          runtime.setPolicy(ctx.botId, { ...policy });
        } else {
          const patch = parsePolicyPatch(args);
          const errors = validateCompactionPolicy(patch);
          if (errors.length > 0) throw new Error(`invalid compaction policy: ${errors.join('; ')}`);
          if (Object.keys(patch).length === 0) {
            policy = runtime.policyFor(ctx.botId);
          } else {
            policy = runtime.setPolicy(ctx.botId, patch);
          }
        }
        let preview: unknown = undefined;
        const previewRaw = getOptionalStringArg(args, 'previewMessages');
        if (previewRaw !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(previewRaw);
          } catch {
            throw new Error('previewMessages must be a JSON array of {role, content} objects');
          }
          if (!Array.isArray(parsed)) throw new Error('previewMessages must be a JSON array');
          const messages = parsed.map((entry, index) => {
            if (typeof entry !== 'object' || entry === null || typeof (entry as { role?: unknown }).role !== 'string') {
              throw new Error(`preview message ${index} needs a string "role"`);
            }
            const m = entry as { role: string; content?: unknown };
            return { role: m.role, ...(typeof m.content === 'string' ? { content: m.content } : {}) };
          });
          preview = runtime.previewPolicy(ctx.botId, messages);
        }
        return JSON.stringify({ policy, ...(preview !== undefined ? { preview } : {}) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const inspect: Tool = {
    definition: toolDef(
      'context_v2_inspect',
      'Inspect the context window as a tree (read): segments grouped by kind (system/anchor/summary/turn/tool-result), each with tokens, tier, source ids, spill state and a text preview; plus totals per kind/tier, usage ratio and threshold bands.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        return JSON.stringify(inspectWindow(runtime.window), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const exportSnapshotTool: Tool = {
    definition: toolDef(
      'context_v2_export_snapshot',
      'Export the context window as a portable JSON snapshot (read): all segments with text, the window limit, and the bot\'s compaction policy. The snapshot can be saved, handed to another bot, or restored after a restart via context_v2_import_snapshot.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const snapshot = exportSnapshot(runtime.window, { botId: ctx.botId, policy: runtime.policyFor(ctx.botId) });
        return JSON.stringify(snapshot, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const importSnapshotTool: Tool = {
    definition: toolDef(
      'context_v2_import_snapshot',
      'Import a context snapshot into the window (needs user approval): the snapshot is validated first (version, segment kinds, non-negative tokens, no duplicate ids) — an invalid snapshot is rejected without touching the window. Spilled segments import as spilled (their text stays on disk).',
      {
        snapshot: { type: 'string', description: 'JSON snapshot object from context_v2_export_snapshot.' },
      },
      ['snapshot'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(getStringArg(args, 'snapshot'));
        } catch {
          throw new Error('snapshot must be a JSON object');
        }
        const errors = validateSnapshot(parsed);
        if (errors.length > 0) throw new Error(`invalid context snapshot: ${errors.join('; ')}`);
        const imported = importSnapshot(parsed, {});
        let added = 0;
        for (const segment of imported.list()) {
          runtime.window.addSegment({
            id: segment.id,
            kind: segment.kind,
            text: segment.text,
            ...(segment.tier !== undefined ? { tier: segment.tier } : {}),
            sourceIds: segment.sourceIds,
          });
          added++;
        }
        return JSON.stringify(
          { importedSegments: added, usedTokens: runtime.window.usedTokens, limit: runtime.window.limit },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const assemblePromptTool: Tool = {
    definition: toolDef(
      'context_v2_assemble_prompt',
      'Assemble the prompt the model sees from the window (read): system segments first (verbatim, never dropped), then anchors, then summaries (tier 1 first), then recent turns — all within a token budget. Segments that do not fit are listed as dropped, never silently lost. Returns messages + included/dropped ids + token counts + a manifest.',
      {
        tokenBudget: { type: 'number', description: 'Token budget for the assembled prompt (default: whole window).' },
        maxTurns: { type: 'number', description: 'Max recent turns to include (default: all that fit).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const tokenBudget = getNumberArg(args, 'tokenBudget');
        const maxTurns = getNumberArg(args, 'maxTurns');
        const result = runtime.assemblePrompt({
          ...(tokenBudget !== undefined ? { tokenBudget } : {}),
          ...(maxTurns !== undefined ? { maxTurns } : {}),
        });
        return JSON.stringify({ ...result, manifest: assemblyManifest(result) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const scheduleStatusTool: Tool = {
    definition: toolDef(
      'context_v2_schedule_status',
      'Scheduler status for a bot (read): compaction frequency (per-turn/hourly/manual), last run time, next allowed run, total runs, and whether a round is due now. Use it to explain why a compaction did or did not run.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        return JSON.stringify(runtime.scheduleStatus(ctx.botId), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [compactTiered, verifySummary, windowStats, setPolicy, inspect, exportSnapshotTool, importSnapshotTool, assemblePromptTool, scheduleStatusTool];
}

/** In-memory runtime (same shape as the bound factory). */
export const CONTEXT_V2_TOOLS: Tool[] = createContextV2Tools();

/** Names of the context v2 tools (for the coordinator/registry checks). */
export const CONTEXT_V2_TOOL_NAMES = [
  'context_v2_compact_tiered',
  'context_v2_verify_summary',
  'context_v2_window_stats',
  'context_v2_set_policy',
  'context_v2_inspect',
  'context_v2_export_snapshot',
  'context_v2_import_snapshot',
  'context_v2_assemble_prompt',
  'context_v2_schedule_status',
] as const;
