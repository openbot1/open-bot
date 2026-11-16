/**
 * Memory v12 tools for @open-bot/tools (v1.12, Doi T1).
 *
 * Agent lam viec voi memory v12 bang tool call:
 *  - memory_block_edit     — sua block bang exact-string edit (oldText -> newText) (needsApproval: true)
 *  - memory_block_search   — tim text trong cac block (read)
 *  - memory_block_tokens   — muc day token tung block + tong so voi ngan sach (read)
 *  - memory_blocks_compile — bien dich block da attach thanh <memory_blocks> cho system prompt (read)
 *  - memory_system_block   — liet ke block he thong; ensure/protect/unprotect (needsApproval: true)
 *  - memory_block_audit    — lich su sua block (audit trail, loc theo block/actor/action) (read)
 *  - memory_sleep_janitor  — chay sleep-time janitor don block luc ranh (dry-run hoac that) (needsApproval: true)
 *  - memory_blocks_export  — export toan bo block thanh JSON backup (read)
 *  - memory_blocks_import  — import block tu JSON backup (needsApproval: true)
 *
 * SAFETY: tool chay voi actor `agent:<botId>` — block he thong
 * (systemOwned) BI CHAN moi thao tac ghi ngay tai store, ke ca
 * `memory_block_edit` (test chung minh); muon sua block he thong thi
 * agent phai hoi user (user code goi thang core voi actor 'user').
 * Exact-string edit mo ho (>1 lan xuat hien, khong chi occurrence)
 * thi tu choi — khong doan mo. Janitor bo qua block read-only /
 * system-owned, dry-run khong ghi gi. Khong goi model, khong goi API.
 *
 * Factory:
 *   createMemoryV12Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V12_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  MemoryBlockStore,
  exportBlocksJson,
  importBlocksJson,
  applyExactEditToBlock,
  previewExactEdit,
  compileBlocksForPrompt,
  summarizeBlocksTokens,
  v12BlockTokenUsage,
  BlockPromptCompiler,
  listSystemBlocks,
  ensureSystemBlock,
  protectSystemBlock,
  unprotectSystemBlock,
  runBlockJanitorPass,
  runJanitorIfIdle,
  readV12JanitorLog,
  V12_DEFAULT_TOTAL_TOKEN_BUDGET,
} from '@open-bot/core';

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

function getBoolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

export interface MemoryV12ToolOptions {
  /** Thu muc workspace cua bot (bat buoc khi bound). */
  workspaceDir?: string;
  /** Store da tao san (test inject store RAM/dia tam, khong can workspace that). */
  blocksStore?: MemoryBlockStore;
  /** Bot id goi tool (dung lam actor `agent:<botId>` khi khong truyen actor). */
  botId?: string;
}

/** Compiler co cache theo workspace (de cac tool dung chung mot instance). */
const compilerByWorkspace = new Map<string, BlockPromptCompiler>();

function getCompiler(workspaceDir: string | undefined): BlockPromptCompiler {
  const key = workspaceDir ?? '';
  let compiler = compilerByWorkspace.get(key);
  if (!compiler) {
    compiler = new BlockPromptCompiler();
    compilerByWorkspace.set(key, compiler);
  }
  return compiler;
}

export function createMemoryV12Tools(opts: MemoryV12ToolOptions = {}): Tool[] {
  const store = opts.blocksStore ?? (opts.workspaceDir ? new MemoryBlockStore(opts.workspaceDir) : undefined);
  const compiler = getCompiler(opts.workspaceDir);
  const defaultBotId = opts.botId;

  const needStore = (): MemoryBlockStore => {
    if (!store) {
      throw new Error(
        'memory v12 chưa được hỗ trợ trong phiên này (host phải truyền blocksStore hoặc workspaceDir vào createMemoryV12Tools).',
      );
    }
    return store;
  };
  /**
   * Actor cua tool call: `agent:<botId>` khi co botId (giong v11),
   * khong thi `user` — execute() co the duoc goi khong kem ctx
   * (nhu test v11), nen khong duoc phu thuoc vao ctx.botId.
   */
  const actorOf = (ctx?: { botId?: string }): string => {
    const botId = ctx?.botId ?? defaultBotId;
    return botId ? `agent:${botId}` : 'user';
  };
  const botIdOf = (args: Record<string, unknown>, ctx?: { botId?: string }): string => {
    const arg = getOptionalStringArg(args, 'botId');
    return arg ?? ctx?.botId ?? defaultBotId ?? '';
  };

  const blockEdit: Tool = {
    definition: toolDef(
      'memory_block_edit',
      'Edit ONE memory block by exact-string replacement: give the exact "oldText" currently in the block and the "newText" to put in its place. Only ONE occurrence is replaced; if "oldText" appears more than once, pass "occurrence" (0-based) to pick which one, otherwise the edit is refused as ambiguous. Use "dryRun"=true to preview without writing. Block read-only or system-owned blocks are refused (system blocks can only be changed by the user, ask the user). Needs approval.',
      {
        block: { type: 'string', description: 'Block id hoặc label (vd "human", "persona", "project-x").' },
        oldText: { type: 'string', description: 'Đoạn text HIỆN CÓ trong block, phải khớp chính xác từng ký tự.' },
        newText: { type: 'string', description: 'Đoạn text mới thay vào chỗ đoạn cũ.' },
        occurrence: { type: 'number', description: 'Chỉ số 0-based của lần xuất hiện cần thay (khi đoạn cũ xuất hiện nhiều lần).' },
        dryRun: { type: 'boolean', description: 'true = chỉ xem trước kết quả, không ghi.' },
      },
      ['block', 'oldText', 'newText'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const block = getStringArg(args, 'block');
        const oldText = getStringArg(args, 'oldText');
        const newText = getStringArg(args, 'newText');
        const occurrence = getNumberArg(args, 'occurrence');
        const dryRun = getBoolArg(args, 'dryRun', false);
        if (dryRun) {
          const current = s.get(block);
          if (!current) return errorResult(`Không tìm thấy memory block "${block}".`);
          const preview = previewExactEdit(
            current.content,
            oldText,
            newText,
            occurrence !== undefined ? { occurrence } : {},
          );
          return JSON.stringify(
            {
              dryRun: true,
              label: current.label,
              version: current.version,
              replacedIndex: preview.replacedIndex,
              occurrences: preview.occurrences,
              tokensBefore: v12BlockTokenUsage(current).tokens,
              contentAfter: preview.content,
            },
            null,
            2,
          );
        }
        const result = applyExactEditToBlock(
          s,
          block,
          oldText,
          newText,
          actorOf(ctx),
          occurrence !== undefined ? { occurrence } : {},
        );
        return JSON.stringify(
          {
            edited: true,
            block: {
              label: result.block.label,
              version: result.block.version,
              readOnly: result.block.readOnly,
              systemOwned: result.block.systemOwned ?? false,
            },
            replacedIndex: result.replacedIndex,
            occurrences: result.occurrences,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            tokenLimit: result.tokenLimit,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockSearch: Tool = {
    definition: toolDef(
      'memory_block_search',
      'Search text across memory blocks (case-insensitive substring). By default only blocks attached to the calling bot; pass includeDetached=true to search every block in this workspace. Read-only, never writes. Use it to find where a fact lives before editing that block.',
      {
        query: { type: 'string', description: 'Text cần tìm (khớp chuỗi con, không phân biệt hoa/thường).' },
        includeDetached: { type: 'boolean', description: 'true = tìm cả block chưa attach vào bot này. Mặc định false.' },
        maxResults: { type: 'number', description: 'Số kết quả tối đa (mặc định 20).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const query = getStringArg(args, 'query');
        if (query.trim() === '') return errorResult('Query tìm kiếm không được để trống.');
        const includeDetached = getBoolArg(args, 'includeDetached', false);
        const maxResults = getNumberArg(args, 'maxResults') ?? 20;
        const botId = botIdOf(args, ctx);
        const blocks = includeDetached ? s.list() : s.listAttached(botId);
        const needle = query.toLowerCase();
        const matches: Array<{
          label: string;
          kind: string;
          version: number;
          line: number;
          snippet: string;
        }> = [];
        for (const block of blocks) {
          const lines = block.content.split('\n');
          for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
            const line = lines[i];
            if (line.toLowerCase().includes(needle)) {
              const idx = line.toLowerCase().indexOf(needle);
              const start = Math.max(0, idx - 40);
              const end = Math.min(line.length, idx + needle.length + 40);
              matches.push({
                label: block.label,
                kind: block.readOnly ? 'read-only' : 'writable',
                version: block.version,
                line: i + 1,
                snippet: `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`,
              });
            }
          }
          if (matches.length >= maxResults) break;
        }
        return JSON.stringify({ query, count: matches.length, matches }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockTokens: Tool = {
    definition: toolDef(
      'memory_block_tokens',
      'Report token usage of memory blocks: estimated tokens per block (calibrated estimator), each block token limit, fill state (ok/warm/full), and the total vs the prompt budget. Read-only, never writes.',
      {
        botId: { type: 'string', description: 'Bot id cần báo cáo (mặc định bot đang gọi).' },
        includeDetached: { type: 'boolean', description: 'true = báo cáo cả block chưa attach vào bot này. Mặc định false.' },
        totalTokenBudget: { type: 'number', description: 'Ngân sách token chung để so sánh (mặc định 4000).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const includeDetached = getBoolArg(args, 'includeDetached', false);
        const budget = getNumberArg(args, 'totalTokenBudget') ?? V12_DEFAULT_TOTAL_TOKEN_BUDGET;
        const botId = botIdOf(args, ctx);
        const blocks = includeDetached ? s.list() : s.listAttached(botId);
        const summary = summarizeBlocksTokens(blocks, budget);
        return JSON.stringify(
          {
            botId,
            totalTokens: summary.totalTokens,
            totalChars: summary.totalChars,
            budget: summary.budget,
            overBudget: summary.overBudget,
            overLimitCount: summary.overLimitCount,
            note: 'Token counts are estimates from the calibrated estimator, not exact model tokens.',
            blocks: summary.blocks,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blocksCompile: Tool = {
    definition: toolDef(
      'memory_blocks_compile',
      'Compile the calling bot memory blocks into the <memory_blocks> section that goes into its next system prompt, within a total token budget (default 4000). Lower-priority blocks are truncated or dropped first; truncated/dropped blocks are listed so you know what the model will NOT see. Read-only, never writes. Use it to check what the model actually sees before/after editing a block.',
      {
        botId: { type: 'string', description: 'Bot id cần biên dịch (mặc định bot đang gọi).' },
        totalTokenBudget: { type: 'number', description: 'Ngân sách token cho toàn bộ đoạn prompt block (mặc định 4000).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const budget = getNumberArg(args, 'totalTokenBudget');
        const botId = botIdOf(args, ctx);
        const compiled = compiler.compile(
          s,
          botId,
          budget !== undefined ? { totalTokenBudget: budget } : {},
        );
        return JSON.stringify(
          {
            botId,
            prompt: compiled.prompt,
            promptHash: compiled.promptHash,
            totalTokens: compiled.totalTokens,
            budget: compiled.budget,
            overBudgetBefore: compiled.overBudgetBefore,
            truncated: compiled.truncated,
            dropped: compiled.dropped,
            recompiledCount: compiled.recompiledCount,
            reusedCount: compiled.reusedCount,
            blocks: compiled.blocks.map((b) => ({
              label: b.label,
              kind: b.kind,
              version: b.version,
              tokens: b.tokens,
              originalTokens: b.originalTokens,
              truncated: b.truncated,
              overKindLimit: b.overKindLimit,
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

  const systemBlock: Tool = {
    definition: toolDef(
      'memory_system_block',
      'Work with system-owned memory blocks (e.g. "safety"): blocks the agent may READ but never write. Actions: "list" (show system blocks), "ensure" (create the preset system block if missing), "protect" (turn a normal block into a system block), "unprotect" (remove system protection). Write actions run as the agent and are REFUSED by design — only the user can change system blocks; the tool returns the refusal so the agent knows to ask the user. Needs approval for write actions.',
      {
        action: { type: 'string', description: '"list" | "ensure" | "protect" | "unprotect".' },
        label: { type: 'string', description: 'Label block (vd "safety"). Bắt buộc cho ensure/protect/unprotect.' },
        botId: { type: 'string', description: 'Bot id để attach block hệ thống (mặc định bot đang gọi).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getStringArg(args, 'action');
        const botId = botIdOf(args, ctx);
        if (action === 'list') {
          const blocks = listSystemBlocks(s);
          return JSON.stringify(
            {
              systemBlocks: blocks.map((b) => ({
                label: b.label,
                description: b.description,
                version: b.version,
                readOnly: b.readOnly,
                systemOwned: b.systemOwned ?? false,
                attachedBots: s.attachedBotIds(b.id),
              })),
            },
            null,
            2,
          );
        }
        const label = getStringArg(args, 'label');
        const actor = actorOf(ctx);
        if (action === 'ensure') {
          const block = ensureSystemBlock(s, botId, label, actor);
          return JSON.stringify({ ensured: true, label: block.label, version: block.version }, null, 2);
        }
        if (action === 'protect') {
          const block = protectSystemBlock(s, label, actor);
          return JSON.stringify({ protected: true, label: block.label, version: block.version }, null, 2);
        }
        if (action === 'unprotect') {
          const block = unprotectSystemBlock(s, label, actor);
          return JSON.stringify({ unprotected: true, label: block.label, version: block.version }, null, 2);
        }
        return errorResult(`Unknown action "${action}" (expected list | ensure | protect | unprotect).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockAudit: Tool = {
    definition: toolDef(
      'memory_block_audit',
      'Read the append-only audit trail of memory block edits: who changed what and when (actor "user" or "agent:<botId>" or "system:*", action create/append/replace/update/delete/attach/set-read-only/consolidate...). Filter by block label, actor, or action. Read-only, never writes.',
      {
        block: { type: 'string', description: 'Label hoặc id block cần xem (bỏ qua = mọi block).' },
        actor: { type: 'string', description: 'Lọc theo actor (vd "user", "agent:bot-1", "system:sleep-v12").' },
        action: { type: 'string', description: 'Lọc theo action (vd "replace", "append", "create").' },
        limit: { type: 'number', description: 'Số dòng tối đa (mặc định 50, tối đa 1000).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const limit = getNumberArg(args, 'limit') ?? 50;
        const blockArg = getOptionalStringArg(args, 'block');
        const actorFilter = getOptionalStringArg(args, 'actor');
        const actionFilter = getOptionalStringArg(args, 'action');
        const entries = s.readAudit(1000);
        let blockId: string | undefined;
        if (blockArg !== undefined) {
          const found = s.get(blockArg);
          blockId = found ? found.id : blockArg;
        }
        const filtered = entries
          .filter((e) => (blockId === undefined ? true : e.blockId === blockId))
          .filter((e) => (actorFilter === undefined ? true : e.actor === actorFilter))
          .filter((e) => (actionFilter === undefined ? true : e.action === actionFilter))
          .slice(0, Math.min(Math.max(Math.floor(limit), 1), 1000));
        return JSON.stringify({ count: filtered.length, entries: filtered }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepJanitor: Tool = {
    definition: toolDef(
      'memory_sleep_janitor',
      'Run the sleep-time block janitor: dedupes lines inside each block, merges identical bullets across blocks (kept in the highest-priority block), trims blocks over their char limit (oldest lines first), and promotes learned facts from "learned-context" into "human". Read-only and system-owned blocks are skipped. Use "dryRun"=true to preview without writing, or "checkIdle"=true to run only if the bot has been idle long enough (uses the workspace consolidation config). Needs approval.',
      {
        botId: { type: 'string', description: 'Bot id cần dọn (mặc định bot đang gọi; bỏ qua = dọn mọi block).' },
        dryRun: { type: 'boolean', description: 'true = chỉ tính toán, không ghi.' },
        checkIdle: { type: 'boolean', description: 'true = chỉ chạy khi bot đã idle đủ lâu theo cấu hình consolidation (mặc định tắt).' },
        force: { type: 'boolean', description: 'true = chạy bất chấp idle/interval (dùng với checkIdle).' },
        maxLinesPerBlock: { type: 'number', description: 'Số dòng tối đa giữ mỗi block (mặc định 200).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const botId = botIdOf(args, ctx);
        const dryRun = getBoolArg(args, 'dryRun', false);
        const checkIdle = getBoolArg(args, 'checkIdle', false);
        const force = getBoolArg(args, 'force', false);
        const maxLines = getNumberArg(args, 'maxLinesPerBlock');
        if (checkIdle) {
          const idle = runJanitorIfIdle(s, {
            botId,
            dryRun,
            force,
            ...(maxLines !== undefined ? { maxLinesPerBlock: maxLines } : {}),
          });
          return JSON.stringify(idle, null, 2);
        }
        const report = runBlockJanitorPass(s, {
          botId,
          dryRun,
          ...(maxLines !== undefined ? { maxLinesPerBlock: maxLines } : {}),
        });
        return JSON.stringify(report, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blocksExport: Tool = {
    definition: toolDef(
      'memory_blocks_export',
      'Export memory blocks as a JSON backup (label-based, with attachments). By default exports every block in this workspace; pass "botId" to export only blocks attached to that bot. Read-only, never writes. Give the JSON to the user for safekeeping, or feed it back into memory_blocks_import to restore.',
      {
        botId: { type: 'string', description: 'Bot id cần export (bỏ qua = export mọi block).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const botId = getOptionalStringArg(args, 'botId');
        return exportBlocksJson(s, botId);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blocksImport: Tool = {
    definition: toolDef(
      'memory_blocks_import',
      'Import memory blocks from a JSON backup produced by memory_blocks_export. Existing labels are skipped unless "overwrite" is true (only the user can overwrite; read-only or system-owned targets are refused and reported). Invalid blocks are reported, the rest still import. Needs approval.',
      {
        json: { type: 'string', description: 'Chuỗi JSON backup (định dạng open-bot-memory-blocks version 1).' },
        overwrite: { type: 'boolean', description: 'true = ghi đè block đã tồn tại (mặc định false = bỏ qua).' },
        onlyLabels: { type: 'string', description: 'Danh sách label cần import, cách nhau bằng dấu phẩy (bỏ qua = import tất cả).' },
      },
      ['json'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const json = getStringArg(args, 'json');
        const overwrite = getBoolArg(args, 'overwrite', false);
        const onlyLabelsRaw = getOptionalStringArg(args, 'onlyLabels');
        const onlyLabels =
          onlyLabelsRaw !== undefined
            ? onlyLabelsRaw.split(',').map((l) => l.trim()).filter(Boolean)
            : undefined;
        const report = importBlocksJson(
          s,
          json,
          actorOf(ctx),
          {
            overwrite,
            ...(onlyLabels !== undefined ? { onlyLabels } : {}),
          },
        );
        return JSON.stringify(report, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [blockEdit, blockSearch, blockTokens, blocksCompile, systemBlock, blockAudit, sleepJanitor, blocksExport, blocksImport];
}

/** Ten tool memory v12 (thu tu nhu createMemoryV12Tools tra ve). */
export const MEMORY_V12_TOOL_NAMES = [
  'memory_block_edit',
  'memory_block_search',
  'memory_block_tokens',
  'memory_blocks_compile',
  'memory_system_block',
  'memory_block_audit',
  'memory_sleep_janitor',
  'memory_blocks_export',
  'memory_blocks_import',
] as const;

/**
 * Placeholder (unbound) cua 9 tool memory v12 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V12_TOOLS: Tool[] = createMemoryV12Tools();

/** Log chay janitor v12 gan nhat (de UI hien thi). */
export function readV12JanitorLogForTool(workspaceDir: string, limit = 10) {
  return readV12JanitorLog(workspaceDir, limit);
}
