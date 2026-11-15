/**
 * Memory v7 tools for @open-bot/tools (v1.06, Team T1).
 *
 * The agent works with the v7 memory system by tool call:
 *  - memory_v7_block_create      — create a git-backed memory block
 *    (file + commit; system labels become scope system) (needsApproval: true)
 *  - memory_v7_block_update      — update / append a block; the
 *    git-backed projection enforces the guardrail (agent may NOT edit
 *    system-scope blocks, only the user may) (needsApproval: true)
 *  - memory_v7_block_list        — list blocks with tier/scope/version
 *    (read)
 *  - memory_v7_block_promote     — move a block one tier up
 *    (working -> session -> episodic -> semantic) (needsApproval: true)
 *  - memory_v7_block_demote      — move a block one tier down
 *    (needsApproval: true)
 *  - memory_v7_prompt_recompile  — recompile the system prompt from
 *    blocks; only changed blocks recompile (hash cache), the rest are
 *    reused (read)
 *  - memory_v7_block_history     — git log / blame / diff for a block
 *    (read; falls back to the JSONL history log when git is absent)
 *  - memory_v7_episodic_search   — keyword search over the episodic
 *    tier (read; expired items never hit)
 *  - memory_v7_tiers_status      — counts per tier + consolidation
 *    dry-run report (read)
 *  - memory_v7_consolidate       — run tier consolidation for real:
 *    working -> session, high-score session -> episodic, recalled
 *    episodic -> semantic, expired sweep (needsApproval: true)
 *
 * SAFETY: system-scope blocks are read-only for the agent (the
 * projection throws before any write); writes need user approval;
 * tool output never contains embeddings; history/diff output is
 * capped so a huge block cannot flood the context.
 *
 * Factory:
 *   createMemoryV7Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V7_TOOLS                       (unbound placeholder)
 */
import type {
  GitMemoryProjection,
  MemoryBlockStore,
  PromptRecompiler,
  TieredMemoryStore,
  Tool,
  V7MemoryBlock,
} from '@open-bot/core';
import {
  compileSystemPrompt,
  GitMemoryProjection as GitMemoryProjectionClass,
  hashBlockContent,
  isValidTier,
  PromptRecompiler as PromptRecompilerClass,
  TieredMemoryStore as TieredMemoryStoreClass,
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

function publicBlock(block: V7MemoryBlock): Record<string, unknown> {
  return {
    label: block.label,
    tier: block.tier,
    scope: block.scope,
    description: block.description,
    content: block.content,
    readOnly: block.readOnly,
    version: block.version,
    contentHash: hashBlockContent(block.content),
    ...(block.commit ? { commit: block.commit } : {}),
    updatedAt: block.updatedAt,
  };
}

export interface MemoryV7ToolOptions {
  /** Workspace dir (required: the git-backed projection lives here). */
  workspaceDir?: string;
  /** Pre-built git-backed projection (defaults to a new one on workspaceDir). */
  projection?: GitMemoryProjection;
  /** Pre-built tiered store (defaults to a new one on workspaceDir). */
  tiersStore?: TieredMemoryStore;
  /** Pre-built prompt recompiler (defaults to a fresh one). */
  recompiler?: PromptRecompiler;
  /** Memory block store (v0.96) for one-shot import into the projection. */
  blocksStore?: MemoryBlockStore;
  /** Current userId (from profile.json); absent = no user filter. */
  getUserId?: () => string | undefined;
}

export function createMemoryV7Tools(opts: MemoryV7ToolOptions = {}): Tool[] {
  const needWorkspaceDir = (): string => {
    if (!opts.workspaceDir) {
      throw new Error('workspaceDir is required (host must pass it to createMemoryV7Tools).');
    }
    return opts.workspaceDir;
  };
  const projectionOf = (): GitMemoryProjection => {
    if (opts.projection) return opts.projection;
    return new GitMemoryProjectionClass(needWorkspaceDir());
  };
  const tiersOf = (): TieredMemoryStore => {
    if (opts.tiersStore) return opts.tiersStore;
    return new TieredMemoryStoreClass(needWorkspaceDir());
  };
  // One recompiler per factory: the block-hash cache lives for the
  // whole session, so a second prompt_recompile reuses every
  // unchanged block instead of recompiling from scratch.
  const sharedRecompiler: PromptRecompiler = opts.recompiler ?? new PromptRecompilerClass();
  const recompilerOf = (): PromptRecompiler => sharedRecompiler;
  const actorOf = (ctx: { botId: string }): string => `agent:${ctx.botId}`;

  const blockCreate: Tool = {
    definition: toolDef(
      'memory_v7_block_create',
      'Create a git-backed memory block (v7): the block is stored as a Markdown file with frontmatter (label, tier, scope, version) under .open-bot/memory-v7/blocks/ and every change is a git commit, so history/blame/diff work with plain git. Labels "human"/"persona" become system-scope blocks that only the user may edit. Needs user approval first.',
      {
        label: { type: 'string', description: 'Block label (slug, e.g. "human", "likes-pho").' },
        content: { type: 'string', description: 'Block content (max 20000 chars by default).' },
        description: { type: 'string', description: 'Short description of what the block remembers.' },
        tier: { type: 'string', description: '"working" | "session" | "episodic" | "semantic" (default "semantic").' },
        scope: { type: 'string', description: '"user" (default, agent may edit with approval) or "system" (only the user may edit).' },
        readOnly: { type: 'boolean', description: 'Create the block read-only (default false).' },
      },
      ['label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const projection = projectionOf();
        const tier = getOptionalStringArg(args, 'tier');
        if (tier !== undefined && !isValidTier(tier)) {
          throw new Error(`tier phải là "working", "session", "episodic" hoặc "semantic", nhận được "${tier}".`);
        }
        const scope = getOptionalStringArg(args, 'scope');
        if (scope !== undefined && scope !== 'user' && scope !== 'system') {
          throw new Error(`scope phải là "user" hoặc "system", nhận được "${scope}".`);
        }
        const block = projection.create(
          {
            label: getStringArg(args, 'label'),
            content: getOptionalStringArg(args, 'content') ?? '',
            description: getOptionalStringArg(args, 'description') ?? '',
            ...(tier !== undefined ? { tier: tier as V7MemoryBlock['tier'] } : {}),
            ...(scope !== undefined ? { scope: scope as V7MemoryBlock['scope'] } : {}),
            ...(getBooleanArg(args, 'readOnly') !== undefined ? { readOnly: getBooleanArg(args, 'readOnly') } : {}),
          },
          actorOf(ctx),
        );
        return JSON.stringify({ block: publicBlock(block), gitAvailable: projection.gitAvailable() }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockUpdate: Tool = {
    definition: toolDef(
      'memory_v7_block_update',
      'Update a git-backed memory block (v7): replace the whole content, append a line, or change the description/tier. Each change writes a new version and a git commit. GUARDRAIL: system-scope blocks (human/persona) cannot be edited by the agent — only the user may edit them; the call is refused with a clear error. Needs user approval first.',
      {
        label: { type: 'string', description: 'Block label to update.' },
        action: { type: 'string', description: '"replace" (whole content) | "append" (add a line) | "describe" (description only) | "tier" (move tier, see memory_v7_block_promote/demote for one-step moves).' },
        content: { type: 'string', description: 'New content (replace) or line to add (append).' },
        description: { type: 'string', description: 'New description (describe).' },
        tier: { type: 'string', description: 'New tier (action "tier").' },
      },
      ['label', 'action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const projection = projectionOf();
        const label = getStringArg(args, 'label');
        const action = getStringArg(args, 'action');
        const actor = actorOf(ctx);
        if (action === 'replace') {
          const block = projection.update(label, { content: getStringArg(args, 'content') }, actor);
          return JSON.stringify({ block: publicBlock(block), gitAvailable: projection.gitAvailable() }, null, 2);
        }
        if (action === 'append') {
          const block = projection.append(label, getStringArg(args, 'content'), actor);
          return JSON.stringify({ block: publicBlock(block), gitAvailable: projection.gitAvailable() }, null, 2);
        }
        if (action === 'describe') {
          const block = projection.update(label, { description: getStringArg(args, 'description') }, actor);
          return JSON.stringify({ block: publicBlock(block), gitAvailable: projection.gitAvailable() }, null, 2);
        }
        if (action === 'tier') {
          const tier = getStringArg(args, 'tier');
          if (!isValidTier(tier)) {
            throw new Error(`tier phải là "working", "session", "episodic" hoặc "semantic", nhận được "${tier}".`);
          }
          const block = projection.setTier(label, tier as V7MemoryBlock['tier'], actor);
          return JSON.stringify({ block: publicBlock(block), gitAvailable: projection.gitAvailable() }, null, 2);
        }
        throw new Error('action phải là "replace", "append", "describe" hoặc "tier".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockList: Tool = {
    definition: toolDef(
      'memory_v7_block_list',
      'List git-backed memory blocks (v7, read): label, tier, scope, description, version, content hash and last commit. Filter by tier and/or scope.',
      {
        tier: { type: 'string', description: 'Only blocks in this tier (optional).' },
        scope: { type: 'string', description: 'Only blocks with this scope: "user" or "system" (optional).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const projection = projectionOf();
        const tier = getOptionalStringArg(args, 'tier');
        if (tier !== undefined && !isValidTier(tier)) {
          throw new Error(`tier phải là "working", "session", "episodic" hoặc "semantic", nhận được "${tier}".`);
        }
        const scope = getOptionalStringArg(args, 'scope');
        if (scope !== undefined && scope !== 'user' && scope !== 'system') {
          throw new Error(`scope phải là "user" hoặc "system", nhận được "${scope}".`);
        }
        const blocks = projection.list({
          ...(tier !== undefined ? { tier: tier as V7MemoryBlock['tier'] } : {}),
          ...(scope !== undefined ? { scope: scope as V7MemoryBlock['scope'] } : {}),
        });
        return JSON.stringify(
          { gitAvailable: projection.gitAvailable(), blocks: blocks.map(publicBlock) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockPromote: Tool = {
    definition: toolDef(
      'memory_v7_block_promote',
      'Promote a memory block one tier up (v7): working -> session -> episodic -> semantic. Only one step at a time; promoting to semantic removes the expiry (long-term knowledge never expires). Needs user approval first.',
      {
        label: { type: 'string', description: 'Block label to promote.' },
      },
      ['label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const projection = projectionOf();
        const label = getStringArg(args, 'label');
        const block = projection.get(label);
        if (!block) throw new Error(`Không tìm thấy memory block "${label}" trong projection.`);
        const order: V7MemoryBlock['tier'][] = ['working', 'session', 'episodic', 'semantic'];
        const idx = order.indexOf(block.tier);
        if (idx === order.length - 1) {
          throw new Error(`Block "${label}" đã ở tầng cao nhất (semantic) — không thăng thêm được.`);
        }
        const next = projection.setTier(label, order[idx + 1], actorOf(ctx));
        return JSON.stringify(
          { block: publicBlock(next), fromTier: block.tier, toTier: order[idx + 1] },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockDemote: Tool = {
    definition: toolDef(
      'memory_v7_block_demote',
      'Demote a memory block one tier down (v7): semantic -> episodic -> session -> working. Only one step at a time; demoting from semantic gives the block the target tier TTL again. Needs user approval first.',
      {
        label: { type: 'string', description: 'Block label to demote.' },
      },
      ['label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const projection = projectionOf();
        const label = getStringArg(args, 'label');
        const block = projection.get(label);
        if (!block) throw new Error(`Không tìm thấy memory block "${label}" trong projection.`);
        const order: V7MemoryBlock['tier'][] = ['working', 'session', 'episodic', 'semantic'];
        const idx = order.indexOf(block.tier);
        if (idx === 0) {
          throw new Error(`Block "${label}" đã ở tầng thấp nhất (working) — không giáng thêm được.`);
        }
        const next = projection.setTier(label, order[idx - 1], actorOf(ctx));
        return JSON.stringify(
          { block: publicBlock(next), fromTier: block.tier, toTier: order[idx - 1] },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const promptRecompile: Tool = {
    definition: toolDef(
      'memory_v7_prompt_recompile',
      'Recompile the system prompt from the git-backed memory blocks (v7, read): each block compiles to one <memory> section; only blocks whose content hash changed since the last compile are recompiled, the rest are reused from cache. Returns the prompt, its hash, and per-block recompiled/reused flags.',
      {
        header: { type: 'string', description: 'Optional header text placed before the memory sections.' },
        footer: { type: 'string', description: 'Optional footer text placed after the memory sections.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const projection = projectionOf();
        const recompiler = recompilerOf();
        const blocks = projection.list();
        const compiled = recompiler.recompile(blocks, {
          ...(getOptionalStringArg(args, 'header') ? { header: getOptionalStringArg(args, 'header') } : {}),
          ...(getOptionalStringArg(args, 'footer') ? { footer: getOptionalStringArg(args, 'footer') } : {}),
        });
        return JSON.stringify(
          {
            prompt: compiled.prompt,
            promptHash: compiled.promptHash,
            totalChars: compiled.totalChars,
            recompiledCount: compiled.recompiledCount,
            reusedCount: compiled.reusedCount,
            blocks: compiled.blocks.map((b) => ({
              label: b.label,
              tier: b.tier,
              scope: b.scope,
              hash: b.hash.slice(0, 12),
              chars: b.chars,
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

  const blockHistory: Tool = {
    definition: toolDef(
      'memory_v7_block_history',
      'Show the history of a git-backed memory block (v7, read): git log (one entry per version, with content at that version), git blame (which commit wrote which lines), and git diff between two revisions. When git is unavailable, history falls back to the JSONL log and blame/diff are empty.',
      {
        label: { type: 'string', description: 'Block label.' },
        limit: { type: 'number', description: 'Max history entries (default 20).' },
        includeBlame: { type: 'boolean', description: 'Include git blame summary (default false).' },
        includeDiff: { type: 'boolean', description: 'Include git diff HEAD vs previous commit (default false).' },
      },
      ['label'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const projection = projectionOf();
        const label = getStringArg(args, 'label');
        const limit = getNumberArg(args, 'limit') ?? 20;
        const history = projection.blockHistory(label, limit);
        const result: Record<string, unknown> = {
          label,
          gitAvailable: projection.gitAvailable(),
          history: history.map((h) => ({
            commit: h.commit,
            author: h.author,
            at: h.at,
            message: h.message,
            version: h.version,
            chars: h.chars,
            contentPreview: h.content.slice(0, 500),
          })),
        };
        if (getBooleanArg(args, 'includeBlame') === true) {
          result.blame = projection.blockBlame(label);
        }
        if (getBooleanArg(args, 'includeDiff') === true) {
          result.diff = projection.blockDiff(label);
        }
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const episodicSearch: Tool = {
    definition: toolDef(
      'memory_v7_episodic_search',
      'Search the episodic tier (v7, read): keyword search over episodic memory items (events that happened, with time). Expired items never hit. Hits are scored by keyword match x effective score; recording access raises the item score slightly, so often-recalled events drift toward semantic.',
      {
        query: { type: 'string', description: 'Keywords to search for (empty = most recent episodic items).' },
        limit: { type: 'number', description: 'Max hits (default 20).' },
        recordAccess: { type: 'boolean', description: 'Count this search as an access for the hits (default false).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const tiers = tiersOf();
        const query = getStringArg(args, 'query', false);
        const limit = getNumberArg(args, 'limit') ?? 20;
        const userId = opts.getUserId?.();
        const hits = tiers.search(query, {
          tiers: ['episodic'],
          limit,
          ...(getBooleanArg(args, 'recordAccess') === true ? { recordAccess: true } : {}),
        });
        void ctx;
        return JSON.stringify(
          {
            hits: hits.map((h) => ({
              label: h.item.label,
              content: h.item.content,
              score: h.score,
              matchedTerms: h.matchedTerms,
              accessCount: h.item.accessCount,
              createdAt: h.item.createdAt,
              ...(h.item.runId ? { runId: h.item.runId } : {}),
              ...(userId ? { userId } : {}),
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

  const tiersStatus: Tool = {
    definition: toolDef(
      'memory_v7_tiers_status',
      'Memory tiers status (v7, read): item counts, capacity and expired counts per tier (working/session/episodic/semantic), average score per tier, and a consolidation dry-run report (what would move up a tier and what would be swept, without writing anything).',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const tiers = tiersOf();
        const stats = tiers.stats();
        const dryRun = tiers.consolidate({ dryRun: true });
        return JSON.stringify({ tiers: stats, consolidationDryRun: dryRun }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const consolidate: Tool = {
    definition: toolDef(
      'memory_v7_consolidate',
      'Run tier consolidation for real (v7, needs user approval): move every live working item to session (end of turn), promote high-score session items to episodic, promote often-recalled episodic items to semantic, sweep expired items, and drop items over tier capacity (lowest score first). Nothing still valid is ever deleted and no item is ever demoted automatically. Returns the consolidation report.',
      {
        dryRun: { type: 'boolean', description: 'Only compute the report, do not write (default false).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const tiers = tiersOf();
        const report = tiers.consolidate({
          ...(getBooleanArg(args, 'dryRun') === true ? { dryRun: true } : {}),
        });
        return JSON.stringify({ report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    blockCreate,
    blockUpdate,
    blockList,
    blockPromote,
    blockDemote,
    promptRecompile,
    blockHistory,
    episodicSearch,
    tiersStatus,
    consolidate,
  ];
}

/** Unbound placeholder (same shape as MEMORY_V5_TOOLS). */
export const MEMORY_V7_TOOLS: Tool[] = createMemoryV7Tools();

/** Names of the memory v7 tools (for the coordinator/registry checks). */
export const MEMORY_V7_TOOL_NAMES = [
  'memory_v7_block_create',
  'memory_v7_block_update',
  'memory_v7_block_list',
  'memory_v7_block_promote',
  'memory_v7_block_demote',
  'memory_v7_prompt_recompile',
  'memory_v7_block_history',
  'memory_v7_episodic_search',
  'memory_v7_tiers_status',
  'memory_v7_consolidate',
] as const;

/**
 * One-shot import of the v0.96 JSON blocks into the v7 git-backed
 * projection. Blocks already present in the projection are skipped.
 * Returns the number of blocks imported.
 */
export function importV96BlocksIntoV7(
  projection: GitMemoryProjection,
  blocksStore: MemoryBlockStore,
  actor = 'user',
): number {
  const blocks = blocksStore.list().map((b) => ({
    label: b.label,
    description: b.description,
    content: b.content,
    readOnly: b.readOnly,
  }));
  return projection.importFromBlocks(blocks, actor);
}

// Re-export the compile helper so tool hosts can build a prompt
// without going through the tool loop (same compiled output).
export { compileSystemPrompt };
