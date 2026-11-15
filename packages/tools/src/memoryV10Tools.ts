/**
 * Memory v10 tools for @open-bot/tools (v1.10, Team T1).
 *
 * The agent works with the v10 memory system by tool call:
 *  - memory_v10_add        — ingest một turn vào pipeline Mem0
 *    (extract → consolidate → CoALA stores), trả báo cáo từng đường
 *    ADD/UPDATE/DELETE/QUARANTINE/SKIP/NOISE (needsApproval: true)
 *  - memory_v10_query      — recall hợp nhất 3 tín hiệu (vector +
 *    BM25 + entity) kèm bảng điểm giải thích được; asOf để hỏi
 *    "đúng vào thời điểm X" (read)
 *  - memory_v10_timeline   — timeline bi-temporal của một subject:
 *    fact nào đúng khi nào, bị thay bởi fact nào (read)
 *  - memory_v10_stats      — thống kê 4 loại CoALA + blocks +
 *    quarantine pending (read)
 *  - memory_v10_blocks     — liệt kê block version được + nội dung
 *    hiện tại + lịch sử phiên bản (read)
 *  - memory_v10_block_commit — commit nội dung mới cho block (tạo
 *    block mới khi truyền label thay cho blockId) (needsApproval: true)
 *  - memory_v10_branch     — tạo nhánh mới / checkout nhánh (needsApproval: true)
 *  - memory_v10_rollback   — rollback block về phiên bản cũ (ghi
 *    phiên bản MỚI, không viết lại lịch sử) (needsApproval: true)
 *  - memory_v10_quarantine — liệt kê quarantine pending; duyệt
 *    approve/reject một item (approve = consolidate lại với
 *    forceUpdate; reject = không ghi gì) (needsApproval: true khi duyệt)
 *
 * SAFETY: không gọi model ngoài, embedding hash-local; quarantine
 * giữ lại fact mâu thuẫn mạnh / mẫu nghi ngờ để user duyệt thay vì
 * áp dụng tự động; rollback không viết lại lịch sử.
 *
 * Factory:
 *   createMemoryV10Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V10_TOOLS                       (unbound placeholder)
 *   getMemoryV10Manager(workspaceDir)      (manager singleton theo workspace)
 */
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import { MemoryManagerV10 } from '@open-bot/core';

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

export interface MemoryV10ToolOptions {
  /** Thư mục workspace của bot (bắt buộc khi bound). */
  workspaceDir?: string;
  /** Manager đã tạo sẵn (test inject manager RAM, không cần đĩa). */
  manager?: MemoryManagerV10;
}

/** Thư mục lưu memory v10 trong workspace. */
export function memoryV10Dir(workspaceDir: string): string {
  return path.join(workspaceDir, '.open-bot', 'memory-v10');
}

/** Manager singleton theo workspaceDir (để các tool dùng chung một instance). */
const managerByWorkspace = new Map<string, MemoryManagerV10>();

export function getMemoryV10Manager(workspaceDir: string): MemoryManagerV10 {
  const existing = managerByWorkspace.get(workspaceDir);
  if (existing) return existing;
  const manager = new MemoryManagerV10({
    scope: { userId: '', botId: '', runId: '' },
    dir: memoryV10Dir(workspaceDir),
  });
  managerByWorkspace.set(workspaceDir, manager);
  return manager;
}

/** Xoá singleton (test dùng để cô lập workspace tạm). */
export function resetMemoryV10ManagersForTests(): void {
  managerByWorkspace.clear();
}

export function createMemoryV10Tools(opts: MemoryV10ToolOptions = {}): Tool[] {
  const needWorkspaceDir = (): string => {
    if (!opts.workspaceDir) {
      throw new Error('workspaceDir is required (host must pass it to createMemoryV10Tools).');
    }
    return opts.workspaceDir;
  };
  const managerOf = (): MemoryManagerV10 => {
    if (opts.manager) return opts.manager;
    return getMemoryV10Manager(needWorkspaceDir());
  };

  const add: Tool = {
    definition: toolDef(
      'memory_v10_add',
      'Memory v10 ingest (write): run one conversation turn through the Mem0-style pipeline — extraction (facts + procedures + salience + noise filter), consolidation (ADD / UPDATE / DELETE / QUARANTINE / SKIP / NOISE), then into the four CoALA stores (working / episodic / semantic / procedural). Returns the per-decision report.',
      {
        text: { type: 'string', description: 'Turn text (user or assistant message).' },
        role: { type: 'string', description: 'Turn role: user | assistant | system (default user).' },
        turnId: { type: 'string', description: 'Turn id (default: auto).' },
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const manager = managerOf();
        const text = getStringArg(args, 'text');
        const role = getOptionalStringArg(args, 'role') ?? 'user';
        const turnId = getOptionalStringArg(args, 'turnId') ?? `t-${Date.now()}`;
        const result = await manager.ingestTurn({ role, text, turnId });
        manager.save();
        return JSON.stringify(
          {
            episodeId: result.episodeId,
            extraction: {
              candidates: result.extraction.candidates.length,
              procedures: result.extraction.procedures.length,
              noiseDropped: result.extraction.noiseDropped,
            },
            consolidation: {
              added: result.consolidation.added,
              updated: result.consolidation.updated,
              deleted: result.consolidation.deleted,
              quarantined: result.consolidation.quarantined,
              skipped: result.consolidation.skipped,
              noiseDropped: result.consolidation.noiseDropped,
            },
            decisions: result.consolidation.actions.map((a) => ({
              decision: a.decision,
              fact: `${a.candidate.subject} —${a.candidate.predicate}→ ${a.candidate.object}`,
              reason: a.reason,
            })),
            proceduresAdded: result.proceduresAdded,
            quarantinePending: result.quarantinePending,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const query: Tool = {
    definition: toolDef(
      'memory_v10_query',
      'Memory v10 recall (read): fused retrieval over vector (local hash embedding) + BM25 keyword + entity-match, with an explainable score table per hit (vector / bm25 / entity scores, weights, total, reasons). Pass asOf (ISO date) to ask what was true at that time ("where in March") instead of now.',
      {
        query: { type: 'string', description: 'Recall query text.' },
        topK: { type: 'number', description: 'Max results (default 10, max 50).' },
        asOf: { type: 'string', description: 'ISO date for a point-in-time query (optional).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = managerOf();
        const q = getStringArg(args, 'query');
        const topK = getNumberArg(args, 'topK');
        const asOfRaw = getOptionalStringArg(args, 'asOf');
        const asOf = asOfRaw ? new Date(asOfRaw) : undefined;
        if (asOf && Number.isNaN(asOf.getTime())) throw new Error(`Invalid asOf date: "${asOfRaw}"`);
        const result = await manager.recall(q, { topK, asOf });
        return JSON.stringify(
          {
            query: result.query,
            asOf: result.asOf,
            candidatesScored: result.candidatesScored,
            hits: result.hits.map((h) => ({
              id: h.id,
              kind: h.kind,
              text: h.text,
              scores: h.scores,
              reasons: h.reasons,
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

  const timeline: Tool = {
    definition: toolDef(
      'memory_v10_timeline',
      'Memory v10 bi-temporal timeline (read): every fact about a subject in validity order, with when each fact was true and which fact replaced it.',
      {
        subject: { type: 'string', description: 'Subject name (e.g. "user").' },
      },
      ['subject'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const manager = managerOf();
        const subject = getStringArg(args, 'subject');
        const entries = manager.timeline(subject);
        return JSON.stringify(
          entries.map((e) => ({
            fact: `${e.fact.subject} —${e.fact.predicate}→ ${e.fact.object}`,
            status: e.fact.status,
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            learnedAt: e.fact.learnedAt,
            replacedBy: e.replacedBy
              ? `${e.replacedBy.subject} —${e.replacedBy.predicate}→ ${e.replacedBy.object}`
              : null,
          })),
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
      'memory_v10_stats',
      'Memory v10 stats (read): counts for the four CoALA stores (working items, episodes, active/superseded/deleted facts, procedures), versioned blocks, and pending quarantine items.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        return JSON.stringify(managerOf().stats(), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blocks: Tool = {
    definition: toolDef(
      'memory_v10_blocks',
      'Memory v10 versioned blocks (read): list all blocks with current branch/version/content and version history (commit messages, authors, timestamps).',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const manager = managerOf();
        return JSON.stringify(
          manager.blocks.listBlocks().map((b) => ({
            id: b.id,
            label: b.label,
            kind: b.kind,
            currentBranch: b.currentBranch,
            currentVersion: b.currentVersion,
            currentContent: manager.blocks.readCurrent(b.id)?.content ?? '',
            versions: b.versions.map((v) => ({
              version: v.version,
              branch: v.branch,
              message: v.message,
              author: v.author,
              createdAt: v.createdAt,
            })),
          })),
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockCommit: Tool = {
    definition: toolDef(
      'memory_v10_block_commit',
      'Memory v10 block commit (write): commit new content to a versioned block. Pass blockId to update an existing block, or label (+kind) to create a new block with that first version.',
      {
        blockId: { type: 'string', description: 'Block id (omit when creating via label).' },
        label: { type: 'string', description: 'Label for a new block (e.g. persona).' },
        kind: { type: 'string', description: 'CoALA kind for a new block: working | episodic | semantic | procedural (default semantic).' },
        content: { type: 'string', description: 'New block content.' },
        message: { type: 'string', description: 'Commit message.' },
      },
      ['content'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const manager = managerOf();
        const content = getStringArg(args, 'content');
        const message = getOptionalStringArg(args, 'message') ?? 'Update block';
        const blockId = getOptionalStringArg(args, 'blockId');
        if (blockId) {
          const version = manager.blocks.commit(blockId, content, message, 'agent');
          manager.save();
          return JSON.stringify({ blockId, version: version.version, branch: version.branch, message: version.message }, null, 2);
        }
        const label = getStringArg(args, 'label');
        const kind = (getOptionalStringArg(args, 'kind') ?? 'semantic') as 'working' | 'episodic' | 'semantic' | 'procedural';
        if (!['working', 'episodic', 'semantic', 'procedural'].includes(kind)) {
          throw new Error(`Invalid kind: "${kind}"`);
        }
        const block = manager.blocks.createBlock(label, kind, content, 'agent');
        manager.save();
        return JSON.stringify({ blockId: block.id, label: block.label, version: 1, branch: 'main', message: 'Initial version' }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const branch: Tool = {
    definition: toolDef(
      'memory_v10_branch',
      'Memory v10 block branch (write): create a new branch from the current version (action=create, branch required) or switch the block to an existing branch (action=checkout, branch required).',
      {
        blockId: { type: 'string', description: 'Block id.' },
        action: { type: 'string', description: 'create | checkout.' },
        branch: { type: 'string', description: 'Branch name.' },
      },
      ['blockId', 'action', 'branch'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const manager = managerOf();
        const blockId = getStringArg(args, 'blockId');
        const action = getStringArg(args, 'action');
        const branchName = getStringArg(args, 'branch');
        if (action === 'create') {
          const version = manager.blocks.branch(blockId, branchName);
          manager.save();
          return JSON.stringify({ blockId, action, branch: branchName, version: version.version }, null, 2);
        }
        if (action === 'checkout') {
          const current = manager.blocks.checkout(blockId, branchName);
          manager.save();
          return JSON.stringify({ blockId, action, branch: current.branch, version: current.version, content: current.content }, null, 2);
        }
        throw new Error(`Invalid action: "${action}" (expected create | checkout)`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const rollback: Tool = {
    definition: toolDef(
      'memory_v10_rollback',
      'Memory v10 block rollback (write): roll a block back to an older version. History is never rewritten — the rollback is recorded as a NEW version carrying the old content.',
      {
        blockId: { type: 'string', description: 'Block id.' },
        toVersion: { type: 'number', description: 'Version number to roll back to.' },
        message: { type: 'string', description: 'Rollback message (optional).' },
      },
      ['blockId', 'toVersion'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const manager = managerOf();
        const blockId = getStringArg(args, 'blockId');
        const toVersion = getNumberArg(args, 'toVersion');
        if (toVersion === undefined) throw new Error('Missing required argument: "toVersion"');
        const message = getOptionalStringArg(args, 'message');
        const report = manager.blocks.rollback(blockId, toVersion, message, 'agent');
        manager.save();
        return JSON.stringify(report, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const quarantine: Tool = {
    definition: toolDef(
      'memory_v10_quarantine',
      'Memory v10 quarantine (read + review): list pending quarantine items (action=list), or review one item (action=approve | action=reject). Approving re-consolidates the candidate with forceUpdate; rejecting records the rejection and writes nothing.',
      {
        action: { type: 'string', description: 'list | approve | reject (default list).' },
        id: { type: 'string', description: 'Quarantine item id (required for approve/reject).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const manager = managerOf();
        const action = getOptionalStringArg(args, 'action') ?? 'list';
        if (action === 'list') {
          return JSON.stringify(
            manager.listQuarantine(true).map((q) => ({
              id: q.id,
              candidate: `${q.candidate.subject} —${q.candidate.predicate}→ ${q.candidate.object}`,
              detail: q.detail,
              conflictingFactId: q.conflictingFactId ?? null,
              createdAt: q.createdAt,
            })),
            null,
            2,
          );
        }
        if (action === 'approve' || action === 'reject') {
          const id = getStringArg(args, 'id');
          const { item, consolidation } = await manager.reviewQuarantine(id, action === 'approve');
          manager.save();
          return JSON.stringify(
            {
              id: item.id,
              status: item.status,
              consolidation: consolidation
                ? { added: consolidation.added, updated: consolidation.updated, deleted: consolidation.deleted }
                : null,
            },
            null,
            2,
          );
        }
        throw new Error(`Invalid action: "${action}" (expected list | approve | reject)`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [add, query, timeline, stats, blocks, blockCommit, branch, rollback, quarantine];
}

/** Unbound placeholders (host must bind with workspaceDir to use). */
export const MEMORY_V10_TOOLS: Tool[] = createMemoryV10Tools();

/** Names of the memory v10 tools (for the coordinator/registry checks). */
export const MEMORY_V10_TOOL_NAMES = [
  'memory_v10_add',
  'memory_v10_query',
  'memory_v10_timeline',
  'memory_v10_stats',
  'memory_v10_blocks',
  'memory_v10_block_commit',
  'memory_v10_branch',
  'memory_v10_rollback',
  'memory_v10_quarantine',
] as const;
