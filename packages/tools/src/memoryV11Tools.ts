/**
 * Memory v11 tools for @open-bot/tools (v1.11, Doi T1).
 *
 * Agent lam viec voi memory v11 bang tool call:
 *  - memory_insert             — chen text vao mot dong cua block (before/after/end) (needsApproval: true)
 *  - memory_apply_patch        — sua block bang unified diff (context phai khop tuyet doi) (needsApproval: true)
 *  - memory_v11_block_history      — lich su block thong nhat moi backend: list versions / diff / stats (read)
 *  - memory_v11_block_rollback     — khoi phuc block ve version cu (viet version MOI, khong viet lai lich su) (needsApproval: true)
 *  - memory_blocks_render      — render block da attach vao bot thanh <memory_blocks> (read)
 *  - memory_shared_blocks      — liet ke block chia se + supervisor + muc day/canh bao; ensure preset current-plan/organization/learned-context (ensure needsApproval: true)
 *  - memory_shared_write       — supervisor-only write block chia se (replace/append) (needsApproval: true)
 *  - memory_sleep_record       — turn chinh ghi raw fact NHANH vao hop thu (needsApproval: false — chi append JSONL)
 *  - memory_sleep_pass         — chay sleep pass v11 giua cac turn (ghi learned_context + consolidate/invalidate archival) (needsApproval: true)
 *
 * SAFETY: khong goi model ngoai; patch context lech thi tu choi (khong doan mo);
 * block chia se chi supervisor/user moi write (thanh vien thuong bi chan ke ca role write);
 * rollback viet version MOI, khong viet lai lich su; archival invalidate chi danh dau, khong xoa cung.
 *
 * Factory:
 *   createMemoryV11Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V11_TOOLS                       (unbound placeholder)
 *   getV11SharedSupervisor(workspaceDir)   (supervisor singleton theo workspace)
 *   getV11SleepAgent(workspaceDir)         (sleep agent singleton theo workspace)
 */
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  MemoryBlockStore,
  SharedBlockGroupStore,
  normalizeBlockLabel,
  ensureTypedBlock,
  renderMemoryBlocksXml,
  insertAtLine,
  applyUnifiedPatch,
  listBlockHistory,
  diffBlockVersions,
  rollbackBlockToVersion,
  blockHistoryStats,
  SharedSupervisor,
  sharedBlockUsage,
  V11_SHARED_PRESET_LABELS,
  recordRawFact,
  readUnprocessedRawFacts,
  readV11SleepLog,
  V11SleepConsolidationAgent,
} from '@open-bot/core';
import type { V11SharedPresetLabel, V11HistoryBackend } from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
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

export interface MemoryV11ToolOptions {
  /** Thu muc workspace cua bot (bat buoc khi bound). */
  workspaceDir?: string;
  /** Store da tao san (test inject store RAM/dia tam, khong can workspace that). */
  blocksStore?: MemoryBlockStore;
  groupsStore?: SharedBlockGroupStore;
  supervisor?: SharedSupervisor;
  sleepAgent?: V11SleepConsolidationAgent;
  /** Bot id goi tool (dung lam actor `agent:<botId>` khi khong truyen actor). */
  botId?: string;
}

/** Supervisor singleton theo workspaceDir (de cac tool dung chung mot instance). */
const supervisorByWorkspace = new Map<string, SharedSupervisor>();
const sleepAgentByWorkspace = new Map<string, V11SleepConsolidationAgent>();

export function getV11SharedSupervisor(workspaceDir: string): SharedSupervisor {
  const existing = supervisorByWorkspace.get(workspaceDir);
  if (existing) return existing;
  const supervisor = new SharedSupervisor(workspaceDir);
  supervisorByWorkspace.set(workspaceDir, supervisor);
  return supervisor;
}

export function getV11SleepAgent(workspaceDir: string): V11SleepConsolidationAgent {
  const existing = sleepAgentByWorkspace.get(workspaceDir);
  if (existing) return existing;
  const agent = new V11SleepConsolidationAgent(workspaceDir);
  sleepAgentByWorkspace.set(workspaceDir, agent);
  return agent;
}

/** Xoa singleton (test dung de co lap workspace tam). */
export function resetMemoryV11SingletonsForTests(): void {
  supervisorByWorkspace.clear();
  sleepAgentByWorkspace.clear();
}

export function createMemoryV11Tools(opts: MemoryV11ToolOptions = {}): Tool[] {
  const needWorkspaceDir = (): string => {
    if (!opts.workspaceDir) {
      throw new Error('workspaceDir is required (host must pass it to createMemoryV11Tools).');
    }
    return opts.workspaceDir;
  };
  const blocksOf = (): MemoryBlockStore => {
    if (opts.blocksStore) return opts.blocksStore;
    return new MemoryBlockStore(needWorkspaceDir());
  };
  const supervisorOf = (): SharedSupervisor => {
    if (opts.supervisor) return opts.supervisor;
    return getV11SharedSupervisor(needWorkspaceDir());
  };
  const sleepAgentOf = (): V11SleepConsolidationAgent => {
    if (opts.sleepAgent) return opts.sleepAgent;
    return getV11SleepAgent(needWorkspaceDir());
  };
  /** Actor cua tool call: `agent:<botId>` khi co botId, khong thi `user`. */
  const actorOf = (): string => (opts.botId ? `agent:${opts.botId}` : 'user');

  const insert: Tool = {
    definition: toolDef(
      'memory_insert',
      'Memory v11 insert (write): insert text into a memory block at a line (1-based). position "before" inserts before the line, "after" after it, "end" appends to the end of the block (no line needed). Fails when the line is out of range or the text is empty.',
      {
        block: { type: 'string', description: 'Block id or label.' },
        text: { type: 'string', description: 'Text to insert (one or more lines).' },
        line: { type: 'number', description: '1-based line number (required unless position is "end").' },
        position: { type: 'string', description: '"before" | "after" | "end" (default "after").' },
      },
      ['block', 'text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const store = blocksOf();
        const blockIdOrLabel = getStringArg(args, 'block');
        const text = getStringArg(args, 'text');
        const line = getNumberArg(args, 'line');
        const positionRaw = getOptionalStringArg(args, 'position') ?? 'after';
        if (positionRaw !== 'before' && positionRaw !== 'after' && positionRaw !== 'end') {
          throw new Error(`Invalid position "${positionRaw}" (expected "before" | "after" | "end").`);
        }
        const block = store.get(blockIdOrLabel);
        if (!block) throw new Error(`Memory block "${blockIdOrLabel}" not found.`);
        const next = insertAtLine(block.content, text, line, positionRaw);
        const updated = store.update(block.id, { content: next }, actorOf());
        return JSON.stringify(
          { blockId: updated.id, label: updated.label, version: updated.version, chars: updated.content.length, limit: updated.charLimit },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const applyPatch: Tool = {
    definition: toolDef(
      'memory_apply_patch',
      'Memory v11 patch (write): edit a memory block with a unified diff patch ("--- a/<label>", "+++ b/<label>", "@@ -old,count +new,count @@", then lines starting with " " context, "+" add, "-" remove). Context must match exactly at the declared position — a mismatch rejects the patch without writing anything. Use for surgical edits without resending the whole block.',
      {
        block: { type: 'string', description: 'Block id or label.' },
        patch: { type: 'string', description: 'Unified diff patch text.' },
      },
      ['block', 'patch'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const store = blocksOf();
        const blockIdOrLabel = getStringArg(args, 'block');
        const patch = getStringArg(args, 'patch');
        const block = store.get(blockIdOrLabel);
        if (!block) throw new Error(`Memory block "${blockIdOrLabel}" not found.`);
        const next = applyUnifiedPatch(block.content, patch);
        const updated = store.update(block.id, { content: next }, actorOf());
        return JSON.stringify(
          { blockId: updated.id, label: updated.label, version: updated.version, chars: updated.content.length, limit: updated.charLimit },
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
      'memory_v11_block_history',
      'Memory v11 block history (read): the unified block_history table — every change from every backend (blocks, git-v7, core-v9, v10, shared-v11, sleep-v11). action "list" shows versions of a block (newest first); "diff" shows the unified diff between two versions; "stats" shows table totals. Rollback lives in the separate memory_v11_block_rollback tool.',
      {
        block: { type: 'string', description: 'Block id (required for list/diff).' },
        action: { type: 'string', description: '"list" | "diff" | "stats" (default "list").' },
        fromVersion: { type: 'number', description: 'Version to diff from (diff only).' },
        toVersion: { type: 'number', description: 'Version to diff to (diff only).' },
        limit: { type: 'number', description: 'Max entries for list (default 20, max 100).' },
        backend: { type: 'string', description: 'Filter list by backend (optional).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const workspaceDir = needWorkspaceDir();
        const action = getOptionalStringArg(args, 'action') ?? 'list';
        if (action === 'stats') {
          return JSON.stringify(blockHistoryStats(workspaceDir), null, 2);
        }
        const blockId = getStringArg(args, 'block');
        if (action === 'list') {
          const limit = getNumberArg(args, 'limit') ?? 20;
          const backend = getOptionalStringArg(args, 'backend') as V11HistoryBackend | undefined;
          const entries = listBlockHistory(workspaceDir, blockId, { limit, backend });
          return JSON.stringify(
            entries.map((e) => ({
              version: e.version,
              backend: e.backend,
              action: e.action,
              actor: e.actor,
              at: e.at,
              chars: e.content.length,
              note: e.note ?? null,
            })),
            null,
            2,
          );
        }
        if (action === 'diff') {
          const fromVersion = getNumberArg(args, 'fromVersion');
          const toVersion = getNumberArg(args, 'toVersion');
          if (fromVersion === undefined || toVersion === undefined) {
            throw new Error('diff requires fromVersion and toVersion.');
          }
          const result = diffBlockVersions(workspaceDir, blockId, fromVersion, toVersion);
          return JSON.stringify(
            { label: result.label, fromVersion, toVersion, added: result.diff.added, removed: result.diff.removed, unified: result.unified },
            null,
            2,
          );
        }
        throw new Error(`Invalid action "${action}" (expected "list" | "diff" | "stats").`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockRollback: Tool = {
    definition: toolDef(
      'memory_v11_block_rollback',
      'Memory v11 block rollback (write): restore a memory block to an old version from the unified block_history table. The old content is written back as a NEW version (never rewrites history), and the rollback itself is recorded in the table.',
      {
        block: { type: 'string', description: 'Block id.' },
        toVersion: { type: 'number', description: 'Version to roll back to.' },
      },
      ['block', 'toVersion'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const workspaceDir = needWorkspaceDir();
        const blockId = getStringArg(args, 'block');
        const toVersion = getNumberArg(args, 'toVersion');
        if (toVersion === undefined) throw new Error('rollback requires toVersion.');
        const result = rollbackBlockToVersion(workspaceDir, blockId, toVersion, actorOf(), blocksOf());
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blocksRender: Tool = {
    definition: toolDef(
      'memory_blocks_render',
      'Memory v11 render (read): compile the blocks attached to a bot into a <memory_blocks> document for the system prompt (system kinds first: human, persona, task, project, safety, then custom). Returns the XML plus the parsed block list. Empty when the bot has no blocks attached.',
      {
        botId: { type: 'string', description: 'Bot id whose attached blocks to render.' },
      },
      ['botId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const store = blocksOf();
        const botId = getStringArg(args, 'botId');
        const xml = renderMemoryBlocksXml(botId, store);
        const blocks = store.listAttached(botId).map((b) => ({
          label: b.label,
          version: b.version,
          chars: b.content.length,
          limit: b.charLimit,
        }));
        return JSON.stringify({ botId, blocks, xml }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sharedBlocks: Tool = {
    definition: toolDef(
      'memory_shared_blocks',
      'Memory v11 shared blocks (read): list shared memory blocks with their group, supervisor, members and fill level (shared blocks are capped small — warning at 80% full). action "ensure-preset" creates the shared preset block (current-plan, organization, learned-context) in a group when missing (needs approval).',
      {
        group: { type: 'string', description: 'Group id or name (optional — omit to list all groups).' },
        action: { type: 'string', description: '"list" (default) or "ensure-preset".' },
        preset: { type: 'string', description: 'Preset label for ensure-preset: current-plan | organization | learned-context.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const supervisor = supervisorOf();
        const action = getOptionalStringArg(args, 'action') ?? 'list';
        if (action === 'ensure-preset') {
          const group = getStringArg(args, 'group');
          // Preset label la slug cua store (vd `current_plan` -> `current-plan`).
          const preset = normalizeBlockLabel(getStringArg(args, 'preset')) as V11SharedPresetLabel;
          if (!(V11_SHARED_PRESET_LABELS as readonly string[]).includes(preset)) {
            throw new Error(`Invalid preset "${preset}" (expected one of ${V11_SHARED_PRESET_LABELS.join(', ')}).`);
          }
          const block = supervisor.ensureSharedPreset(group, preset, actorOf());
          return JSON.stringify(
            { preset, blockId: block.id, label: block.label, usage: sharedBlockUsage(block) },
            null,
            2,
          );
        }
        if (action !== 'list') {
          throw new Error(`Invalid action "${action}" (expected "list" | "ensure-preset").`);
        }
        const group = getOptionalStringArg(args, 'group');
        const views = supervisor.listSharedBlocks(group);
        return JSON.stringify(
          views.map((v) => ({
            label: v.block.label,
            blockId: v.block.id,
            group: v.groupName,
            groupId: v.groupId,
            supervisorBotId: v.supervisorBotId || null,
            memberBotIds: v.memberBotIds,
            version: v.block.version,
            usage: v.usage,
          })),
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sharedWrite: Tool = {
    definition: toolDef(
      'memory_shared_write',
      'Memory v11 shared write (write): write a shared memory block (replace whole content, or append). SUPERVISOR-ONLY: only the group supervisor bot (or the user) may write a shared block — other member bots are rejected even with a write role, so one bad write cannot spread to the whole group. Shared blocks are capped small (4000 chars); over the cap the write is rejected, condense first.',
      {
        group: { type: 'string', description: 'Group id or name.' },
        block: { type: 'string', description: 'Shared block id or label.' },
        content: { type: 'string', description: 'New full content (replace mode).' },
        append: { type: 'string', description: 'Text to append (append mode). Pass exactly one of content/append.' },
      },
      ['group', 'block'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const supervisor = supervisorOf();
        const group = getStringArg(args, 'group');
        const block = getStringArg(args, 'block');
        const content = getOptionalStringArg(args, 'content');
        const append = getOptionalStringArg(args, 'append');
        const result = supervisor.writeSharedBlock(
          group,
          block,
          { ...(content !== undefined ? { content } : {}), ...(append !== undefined ? { append } : {}) },
          actorOf(),
        );
        return JSON.stringify(
          { blockId: result.block.id, label: result.block.label, group: result.groupName, mode: result.mode, version: result.block.version, usage: result.usage },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepRecord: Tool = {
    definition: toolDef(
      'memory_sleep_record',
      'Memory v11 sleep record (write, fast): the main turn records a raw fact FAST into the sleep inbox (one JSONL append, no analysis). The sleep-time agent processes it later, between turns, outside the critical path — the turn never waits for consolidation.',
      {
        botId: { type: 'string', description: 'Bot id the fact belongs to.' },
        text: { type: 'string', description: 'Raw fact text (at least 12 chars).' },
        source: { type: 'string', description: 'Where the fact came from (e.g. "turn", "tool", "import").' },
        turnId: { type: 'string', description: 'Turn id (optional).' },
      },
      ['botId', 'text'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const workspaceDir = needWorkspaceDir();
        const botId = getStringArg(args, 'botId');
        const text = getStringArg(args, 'text');
        const source = getOptionalStringArg(args, 'source') ?? 'turn';
        const turnId = getOptionalStringArg(args, 'turnId');
        const fact = recordRawFact(workspaceDir, { botId, text, source, ...(turnId !== undefined ? { turnId } : {}) });
        return JSON.stringify({ id: fact.id, botId: fact.botId, at: fact.at, chars: fact.text.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepPass: Tool = {
    definition: toolDef(
      'memory_sleep_pass',
      'Memory v11 sleep pass (write): run the sleep-time consolidation agent between turns — read the raw-fact inbox, extract unique facts, write learned_context into the shared block (via the supervisor), consolidate strong facts into archival, and invalidate contradicted archival records (marked, not deleted). A pass skips itself when the previous pass ran less than 10 minutes ago (pass force=true to override). dryRun=true only computes, writes nothing.',
      {
        botId: { type: 'string', description: 'Bot id to consolidate for.' },
        group: { type: 'string', description: 'Shared group id/name for learned_context (optional — omit to write a per-bot block).' },
        supervisorBotId: { type: 'string', description: 'Supervisor bot id (required when group is given).' },
        dryRun: { type: 'boolean', description: 'Compute only, write nothing (default false).' },
        force: { type: 'boolean', description: 'Ignore the 10-minute minimum interval (default false).' },
      },
      ['botId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const agent = sleepAgentOf();
        const botId = getStringArg(args, 'botId');
        const group = getOptionalStringArg(args, 'group');
        const supervisorBotId = getOptionalStringArg(args, 'supervisorBotId');
        const dryRun = getBooleanArg(args, 'dryRun') ?? false;
        const force = getBooleanArg(args, 'force') ?? false;
        const report = agent.runSleepPass({
          botId,
          ...(group !== undefined ? { groupIdOrName: group } : {}),
          ...(supervisorBotId !== undefined ? { supervisorBotId } : {}),
          dryRun,
          force,
        });
        return JSON.stringify(
          {
            id: report.id,
            botId: report.botId,
            at: report.at,
            dryRun: report.dryRun,
            durationMs: report.durationMs,
            rawFactsRead: report.rawFactsRead,
            factsExtracted: report.factsExtracted,
            factsDeduped: report.factsDeduped,
            learnedContextLinesAdded: report.learnedContextLinesAdded,
            archivalConsolidated: report.archivalConsolidated,
            archivalInvalidated: report.archivalInvalidated,
            steps: report.steps,
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

  return [insert, applyPatch, blockHistory, blockRollback, blocksRender, sharedBlocks, sharedWrite, sleepRecord, sleepPass];
}

/** Ten tool memory v11 (thu tu nhu createMemoryV11Tools tra ve). */
export const MEMORY_V11_TOOL_NAMES = [
  'memory_insert',
  'memory_apply_patch',
  'memory_v11_block_history',
  'memory_v11_block_rollback',
  'memory_blocks_render',
  'memory_shared_blocks',
  'memory_shared_write',
  'memory_sleep_record',
  'memory_sleep_pass',
] as const;

/**
 * Placeholder (unbound) cua 9 tool memory v11 — nam trong ALL_TOOLS.
 * Giong v10: goi factory khong co workspaceDir; execute tra loi ro
 * rang thay vi crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V11_TOOLS: Tool[] = createMemoryV11Tools();

/** So raw fact chua xu ly cua mot bot (de UI/tool kiem tra inbox truoc khi chay pass). */
export function countUnprocessedRawFacts(workspaceDir: string, botId: string): number {
  return readUnprocessedRawFacts(workspaceDir, botId, 100000).length;
}

/** Log chay sleep pass v11 gan nhat (de UI hien thi). */
export function readV11SleepLogForTool(workspaceDir: string, limit = 10) {
  return readV11SleepLog(workspaceDir, limit);
}
