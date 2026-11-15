/**
 * Memory v9 kiểu Letta — tools cho @open-bot/tools (v1.09, Đội T2).
 *
 * Agent tự quản lý memory của chính nó bằng tool call (ý tưởng học từ
 * Letta/MemGPT, viết lại hoàn toàn trên core v9-Letta của open-bot):
 *
 * CORE MEMORY (luôn nằm trong context, giới hạn cứng, đầy thì cô đọng):
 *  - core_memory_create   — tạo block (persona ≤2KB, human ≤4KB, project ≤8KB; block tự do ≤2KB) (needsApproval: true)
 *  - core_memory_list     — liệt kê block đã attach vào bot + mức đầy (read)
 *  - core_memory_read     — đọc một block theo id/label (read)
 *  - core_memory_append   — nối text vào block; vượt giới hạn thì TỰ CÔ ĐỌNG nội dung cũ rồi mới append (needsApproval: true)
 *  - core_memory_replace  — thay toàn bộ nội dung block (vượt giới hạn -> lỗi, phải cô đọng rồi gọi lại) (needsApproval: true)
 *  - core_memory_delete   — xoá block (needsApproval: true)
 *  - core_memory_render   — render core memory thành đoạn system prompt (read)
 * RECALL (tóm tắt phiên gần đây):
 *  - memory_recall_record — ghi tóm tắt một phiên đã kết thúc (needsApproval: true)
 *  - memory_recall_search — truy hồi phiên theo từ khoá / thời gian (read)
 * ARCHIVAL (kho dài hạn ngoài context):
 *  - memory_archival_insert  — thêm mục vào kho (needsApproval: true)
 *  - memory_archival_search  — tìm kiếm từ khoá (+ embedding nếu có sẵn — tool dùng fallback từ khoá) (read)
 *  - memory_archival_promote — đẩy một mục archival lên core block (needsApproval: true)
 *  - memory_archival_delete  — xoá một mục (needsApproval: true)
 *  - memory_archival_stats   — thống kê kho (read)
 * ENTITY (agent là thực thể bền vững):
 *  - memory_entity_snapshot — chụp toàn bộ memory của bot (kèm checksum) (read)
 *  - memory_entity_restore  — khôi phục từ snapshot JSON (replace/merge) (needsApproval: true)
 *  - memory_entity_export   — xuất snapshot ra file JSON (needsApproval: true)
 *  - memory_entity_import   — nhập snapshot từ file (replace/merge) (needsApproval: true)
 *  - memory_entity_stats    — thống kê 3 tầng + proposals của bot (read)
 * SLEEP (consolidation lúc rảnh / giữa các phiên):
 *  - memory_letta_sleep_run             — chạy một sleep pass Letta (prune recall, trích fact, dedupe archival, đề xuất core update) (needsApproval: true)
 *  - memory_letta_sleep_proposals       — liệt kê proposal cập nhật core block (read)
 *  - memory_letta_sleep_proposal_decide — approve / reject / apply-edited một proposal (needsApproval: true)
 *  - memory_letta_sleep_log             — log các sleep pass Letta gần nhất (read)
 *
 * SAFETY: core memory không bao giờ append vô hạn (đầy -> cô đọng
 * trích xuất, không bịa chữ); replace vượt giới hạn bị chặn; proposal
 * sleep KHÔNG tự ghi đè core block (chờ quyết định tường minh);
 * restore kiểm tra checksum snapshot; embedding KHÔNG BAO GIỜ xuất
 * hiện trong tool output.
 *
 * Factory:
 *   createMemoryV9LettaTools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V9_LETTA_TOOLS                      (unbound placeholder)
 */
import * as path from 'node:path';
import type {
  ArchivalSource,
  CoreMemoryManager,
  LettaRestoreMode,
  PersistentAgentMemory,
  RecallStore,
  ArchivalStore,
  SleepProposalDecision,
  SleepProposalStore,
  Tool,
} from '@open-bot/core';
import {
  ArchivalStore as ArchivalStoreClass,
  CoreMemoryManager as CoreMemoryManagerClass,
  PersistentAgentMemory as PersistentAgentMemoryClass,
  RecallStore as RecallStoreClass,
  SleepProposalStore as SleepProposalStoreClass,
  coreBlockUsage,
  runLettaSleepPass,
  readLettaSleepLog,
  validateLettaSnapshot,
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

function getEpisodesArg(
  args: Record<string, unknown>,
  name: string,
): Array<{ role: 'user' | 'bot'; text: string; at?: string }> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an array of {role, text}.`);
  }
  const out: Array<{ role: 'user' | 'bot'; text: string; at?: string }> = [];
  for (const item of value.slice(0, 50)) {
    if (!item || typeof item !== 'object') throw new Error(`Argument "${name}" must be an array of {role, text}.`);
    const role = (item as Record<string, unknown>).role;
    const text = (item as Record<string, unknown>).text;
    if (role !== 'user' && role !== 'bot') throw new Error(`Episode role phải là "user" hoặc "bot".`);
    if (typeof text !== 'string') throw new Error(`Episode text phải là string.`);
    const at = (item as Record<string, unknown>).at;
    out.push({ role, text, ...(typeof at === 'string' ? { at } : {}) });
  }
  return out;
}

function getFactsArg(
  args: Record<string, unknown>,
  name: string,
): Array<{ text: string; source: string; confidence?: number }> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an array of {text, source}.`);
  }
  const out: Array<{ text: string; source: string; confidence?: number }> = [];
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== 'object') throw new Error(`Argument "${name}" must be an array of {text, source}.`);
    const rec = item as Record<string, unknown>;
    if (typeof rec.text !== 'string' || typeof rec.source !== 'string') {
      throw new Error(`Mỗi fact trong "${name}" phải có text và source là string.`);
    }
    out.push({
      text: rec.text,
      source: rec.source,
      ...(typeof rec.confidence === 'number' ? { confidence: rec.confidence } : {}),
    });
  }
  return out;
}

/** botId: ưu tiên arg botId, sau đó ctx.botId, mặc định 'default-bot'. */
function botIdOf(args: Record<string, unknown>, ctx: { botId?: string }): string {
  const fromArg = getOptionalStringArg(args, 'botId');
  if (fromArg && fromArg.trim() !== '') return fromArg.trim();
  if (ctx.botId && ctx.botId.trim() !== '') return ctx.botId.trim();
  return 'default-bot';
}

/** Đường dẫn file: tương đối -> resolve trong workspaceDir. */
function resolveFilePath(workspaceDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
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

export interface MemoryV9LettaToolOptions {
  /** Workspace dir (required: core blocks / recall / archival / entity live here). */
  workspaceDir?: string;
  /** Pre-built core manager (defaults to a new one on workspaceDir). */
  core?: CoreMemoryManager;
  /** Pre-built recall store (defaults to a new one on workspaceDir). */
  recall?: RecallStore;
  /** Pre-built archival store (defaults to a new one on workspaceDir). */
  archival?: ArchivalStore;
  /** Pre-built proposal store (defaults to a new one on workspaceDir). */
  proposals?: SleepProposalStore;
}

export function createMemoryV9LettaTools(opts: MemoryV9LettaToolOptions = {}): Tool[] {
  const needWorkspaceDir = (): string => {
    if (!opts.workspaceDir) {
      throw new Error('workspaceDir is required (host must pass it to createMemoryV9LettaTools).');
    }
    return opts.workspaceDir;
  };
  const coreOf = (): CoreMemoryManager => {
    if (opts.core) return opts.core;
    return new CoreMemoryManagerClass(needWorkspaceDir());
  };
  const recallOf = (): RecallStore => {
    if (opts.recall) return opts.recall;
    return new RecallStoreClass(needWorkspaceDir());
  };
  const archivalOf = (): ArchivalStore => {
    if (opts.archival) return opts.archival;
    return new ArchivalStoreClass(needWorkspaceDir());
  };
  const proposalsOf = (): SleepProposalStore => {
    if (opts.proposals) return opts.proposals;
    return new SleepProposalStoreClass(needWorkspaceDir());
  };
  const entityOf = (botId: string): PersistentAgentMemory => {
    return new PersistentAgentMemoryClass(needWorkspaceDir(), botId);
  };

  const coreCreate: Tool = {
    definition: toolDef(
      'core_memory_create',
      'Tạo một core memory block cho bot (persona ≤2048 ký tự, human ≤4096, project ≤8192, block tự do ≤2000). Tạo xong thì attach ngay vào bot. Nội dung vượt giới hạn sẽ bị từ chối.',
      {
        botId: { type: 'string', description: 'Bot sở hữu block (mặc định bot hiện tại).' },
        label: { type: 'string', description: 'Label block: persona, human, project, hoặc label tự do.' },
        description: { type: 'string', description: 'Mô tả ngắn: block này nhớ cái gì.' },
        content: { type: 'string', description: 'Nội dung ban đầu (phải vừa giới hạn của block).' },
        charLimit: { type: 'number', description: 'Giới hạn ký tự cho block tự do (100..20000, mặc định 2000). Block hệ thống luôn dùng giới hạn cứng của nó.' },
      },
      ['label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const block = coreOf().create(
          botId,
          {
            label: getStringArg(args, 'label'),
            description: getOptionalStringArg(args, 'description'),
            content: getOptionalStringArg(args, 'content'),
            charLimit: getNumberArg(args, 'charLimit'),
          },
          `agent:${botId}`,
        );
        return JSON.stringify({ ok: true, block });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const coreList: Tool = {
    definition: toolDef(
      'core_memory_list',
      'Liệt kê core memory block đã attach vào bot, kèm mức đầy (chars/limit/fillRatio/state ok|warm|full).',
      {
        botId: { type: 'string', description: 'Bot cần xem (mặc định bot hiện tại).' },
        includeDetached: { type: 'boolean', description: 'true = liệt kê cả block chưa attach vào bot nào (mặc định false).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const core = coreOf();
        const blocks = getBooleanArg(args, 'includeDetached') === true ? core.listAll() : core.listAttached(botId);
        return JSON.stringify({
          ok: true,
          botId,
          blocks: blocks.map((b) => ({ ...b, usage: coreBlockUsage(b) })),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const coreRead: Tool = {
    definition: toolDef(
      'core_memory_read',
      'Đọc một core memory block theo id hoặc label, kèm mức đầy.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        idOrLabel: { type: 'string', description: 'Id hoặc label của block.' },
      },
      ['idOrLabel'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const block = coreOf().read(getStringArg(args, 'idOrLabel'));
        if (!block) return errorResult(`Không tìm thấy block "${getStringArg(args, 'idOrLabel')}".`);
        return JSON.stringify({ ok: true, block: { ...block, usage: coreBlockUsage(block) } });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const coreAppend: Tool = {
    definition: toolDef(
      'core_memory_append',
      'Nối text vào cuối một core memory block. Nếu append làm block vượt giới hạn, nội dung cũ sẽ TỰ CÔ ĐỌNG (trích xuất, không bịa chữ) về 90% giới hạn rồi mới append — kết quả báo condensed=true. Nếu cô đọng xong vẫn không đủ chỗ thì lỗi và báo số ký tự tối đa còn append được.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        idOrLabel: { type: 'string', description: 'Id hoặc label của block.' },
        text: { type: 'string', description: 'Text cần nối thêm.' },
      },
      ['idOrLabel', 'text'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const result = coreOf().append(getStringArg(args, 'idOrLabel'), getStringArg(args, 'text'), botId);
        return JSON.stringify({
          ok: true,
          block: result.block,
          usage: result.usage,
          condensed: result.condensed,
          condense: result.condense,
          appendedChars: result.appendedChars,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const coreReplace: Tool = {
    definition: toolDef(
      'core_memory_replace',
      'Thay toàn bộ nội dung một core memory block. Nội dung mới vượt giới hạn của block sẽ bị từ chối — hãy cô đọng nội dung rồi gọi lại (không có đường tắt append vô hạn).',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        idOrLabel: { type: 'string', description: 'Id hoặc label của block.' },
        content: { type: 'string', description: 'Nội dung mới (phải vừa giới hạn của block).' },
      },
      ['idOrLabel', 'content'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const block = coreOf().replace(getStringArg(args, 'idOrLabel'), getStringArg(args, 'content'), botId);
        return JSON.stringify({ ok: true, block, usage: coreBlockUsage(block) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const coreDelete: Tool = {
    definition: toolDef(
      'core_memory_delete',
      'Xoá một core memory block (kèm detach khỏi mọi bot). Block read-only bị chặn xoá.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        idOrLabel: { type: 'string', description: 'Id hoặc label của block.' },
      },
      ['idOrLabel'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const deleted = coreOf().delete(getStringArg(args, 'idOrLabel'), botId);
        return JSON.stringify({ ok: true, deleted });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const coreRender: Tool = {
    definition: toolDef(
      'core_memory_render',
      'Render core memory đã attach vào bot thành đoạn system prompt (persona -> human -> project -> block tự do). Dùng khi mở phiên mới hoặc kiểm tra context.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const prompt = coreOf().renderCorePrompt(botId);
        return JSON.stringify({ ok: true, botId, prompt });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const recallRecord: Tool = {
    definition: toolDef(
      'memory_recall_record',
      'Ghi tóm tắt một phiên đã kết thúc vào tầng recall (tối đa 50 episode, mỗi episode tối đa 2000 ký tự; summary được cô đọng trích xuất, tối đa 1500 ký tự).',
      {
        botId: { type: 'string', description: 'Bot của phiên (mặc định bot hiện tại).' },
        sessionId: { type: 'string', description: 'Id phiên.' },
        startedAt: { type: 'string', description: 'Thời gian bắt đầu phiên (ISO, mặc định bây giờ).' },
        endedAt: { type: 'string', description: 'Thời gian kết thúc phiên (ISO, mặc định bây giờ).' },
        episodes: {
          type: 'array',
          description: 'Danh sách turn {role: user|bot, text, at?} (tối đa 50).',
          items: { type: 'object' },
        },
      },
      ['sessionId', 'episodes'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const session = recallOf().recordSession({
          sessionId: getStringArg(args, 'sessionId'),
          botId,
          startedAt: getOptionalStringArg(args, 'startedAt'),
          endedAt: getOptionalStringArg(args, 'endedAt'),
          episodes: getEpisodesArg(args, 'episodes') ?? [],
        });
        return JSON.stringify({ ok: true, session });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const recallSearch: Tool = {
    definition: toolDef(
      'memory_recall_search',
      'Truy hồi phiên gần đây theo từ khoá và/hoặc khoảng thời gian. Query rỗng = chỉ xếp theo độ mới (recency). Kết quả kèm điểm keyword/recency.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        query: { type: 'string', description: 'Từ khoá cần nhớ lại (rỗng = phiên gần nhất).' },
        since: { type: 'string', description: 'Chỉ lấy phiên kết thúc sau mốc này (ISO).' },
        until: { type: 'string', description: 'Chỉ lấy phiên kết thúc trước mốc này (ISO).' },
        limit: { type: 'number', description: 'Số kết quả tối đa (1..50, mặc định 10).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const hits = recallOf().recall({
          query: getOptionalStringArg(args, 'query'),
          botId,
          since: getOptionalStringArg(args, 'since'),
          until: getOptionalStringArg(args, 'until'),
          limit: getNumberArg(args, 'limit'),
        });
        return JSON.stringify({ ok: true, botId, hits });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archivalInsert: Tool = {
    definition: toolDef(
      'memory_archival_insert',
      'Thêm một mục vào kho archival (lưu trữ dài hạn ngoài context). Text trùng y hệt + cùng nguồn sẽ không thêm mới (trả lại mục cũ). Tối đa 8000 ký tự/mục.',
      {
        text: { type: 'string', description: 'Nội dung mục archival.' },
        source: { type: 'string', description: 'Nguồn: session | recall | fact | core-demoted | import | manual (mặc định manual).' },
        sourceId: { type: 'string', description: 'Id nguồn (vd sessionId).' },
        tags: { type: 'array', description: 'Tags (tối đa 20).', items: { type: 'string' } },
        confidence: { type: 'number', description: 'Độ tin cậy 0..1 (mặc định 0.5).' },
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const source = getOptionalStringArg(args, 'source');
        const validSources: ArchivalSource[] = ['session', 'recall', 'fact', 'core-demoted', 'import', 'manual'];
        if (source !== undefined && !(validSources as string[]).includes(source)) {
          throw new Error(`source phải là một trong: ${validSources.join(', ')}.`);
        }
        const item = archivalOf().insert({
          text: getStringArg(args, 'text'),
          ...(source !== undefined ? { source: source as ArchivalSource } : {}),
          sourceId: getOptionalStringArg(args, 'sourceId'),
          tags: getStringArrayArg(args, 'tags'),
          confidence: getNumberArg(args, 'confidence'),
        });
        return JSON.stringify({ ok: true, item });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archivalSearch: Tool = {
    definition: toolDef(
      'memory_archival_search',
      'Tìm kiếm kho archival theo từ khoá (có phân trang). Tool dùng fallback tìm kiếm từ khoá — nếu host có embedding thì điểm cosine được cộng thêm khi search qua API core.',
      {
        query: { type: 'string', description: 'Từ khoá tìm kiếm.' },
        tags: { type: 'array', description: 'Chỉ lấy mục có đủ các tag này.', items: { type: 'string' } },
        source: { type: 'string', description: 'Lọc theo nguồn.' },
        since: { type: 'string', description: 'Chỉ lấy mục tạo sau mốc này (ISO).' },
        limit: { type: 'number', description: 'Số kết quả mỗi trang (1..50, mặc định 10).' },
        offset: { type: 'number', description: 'Bỏ qua N kết quả đầu (phân trang, mặc định 0).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const result = await archivalOf().search({
          query: getStringArg(args, 'query'),
          tags: getStringArrayArg(args, 'tags'),
          source: getOptionalStringArg(args, 'source') as ArchivalSource | undefined,
          since: getOptionalStringArg(args, 'since'),
          limit: getNumberArg(args, 'limit'),
          offset: getNumberArg(args, 'offset'),
        });
        return JSON.stringify({ ok: true, ...result });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archivalPromote: Tool = {
    definition: toolDef(
      'memory_archival_promote',
      'Đẩy một mục archival lên core block (ghi thành một dòng fact vào block human/persona/project). Block đích đầy thì tự cô đọng như core_memory_append.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        itemId: { type: 'string', description: 'Id mục archival.' },
        targetLabel: { type: 'string', description: 'Block đích: human, persona, hoặc project (mặc định human).' },
        line: { type: 'string', description: 'Dòng fact ghi vào block (mặc định dùng text của mục archival).' },
      },
      ['itemId'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const item = archivalOf().get(getStringArg(args, 'itemId'));
        if (!item) return errorResult(`Không tìm thấy mục archival "${getStringArg(args, 'itemId')}".`);
        const targetLabel = getOptionalStringArg(args, 'targetLabel') ?? 'human';
        const line = getOptionalStringArg(args, 'line') ?? item.text;
        const result = coreOf().append(targetLabel, line, botId);
        return JSON.stringify({
          ok: true,
          itemId: item.id,
          targetLabel,
          block: result.block,
          condensed: result.condensed,
          appendedChars: result.appendedChars,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archivalDelete: Tool = {
    definition: toolDef(
      'memory_archival_delete',
      'Xoá một mục khỏi kho archival.',
      {
        itemId: { type: 'string', description: 'Id mục archival.' },
      },
      ['itemId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const deleted = archivalOf().delete(getStringArg(args, 'itemId'));
        return JSON.stringify({ ok: true, deleted });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const archivalStats: Tool = {
    definition: toolDef(
      'memory_archival_stats',
      'Thống kê kho archival: tổng mục, số mục có embedding, đếm theo nguồn, thời gian mục cũ/mới nhất.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        return JSON.stringify({ ok: true, stats: archivalOf().stats() });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const entitySnapshot: Tool = {
    definition: toolDef(
      'memory_entity_snapshot',
      'Chụp toàn bộ memory của bot thành snapshot (core blocks + recall + archival + proposals, kèm checksum SHA-256). Snapshot chỉ chứa text memory, không chứa secret/key.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const snapshot = entityOf(botId).snapshot();
        return JSON.stringify({ ok: true, snapshot });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const entityRestore: Tool = {
    definition: toolDef(
      'memory_entity_restore',
      'Khôi phục memory của bot từ snapshot JSON (kiểm tra checksum trước khi ghi). replace = xoá memory cũ của bot rồi ghi snapshot; merge = chỉ thêm mục mới, giữ nguyên cũ. Archival là kho chung nên không bao giờ bị xoá.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        snapshotJson: { type: 'string', description: 'Snapshot JSON (chuỗi).' },
        mode: { type: 'string', description: 'replace hoặc merge (mặc định replace).' },
      },
      ['snapshotJson'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const mode = (getOptionalStringArg(args, 'mode') ?? 'replace') as LettaRestoreMode;
        if (mode !== 'replace' && mode !== 'merge') {
          throw new Error('mode phải là "replace" hoặc "merge".');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(getStringArg(args, 'snapshotJson'));
        } catch {
          throw new Error('snapshotJson không phải JSON hợp lệ.');
        }
        const report = entityOf(botId).restore(validateLettaSnapshot(parsed), mode);
        return JSON.stringify({ ok: true, report });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const entityExport: Tool = {
    definition: toolDef(
      'memory_entity_export',
      'Xuất snapshot memory của bot ra file JSON (đường dẫn tương đối tính từ workspace, tuyệt đối dùng nguyên). Ghi atomic, mode 0600.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        filePath: { type: 'string', description: 'Đường dẫn file đích (vd "memory-exports/bot-a.json").' },
      },
      ['filePath'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const filePath = resolveFilePath(needWorkspaceDir(), getStringArg(args, 'filePath'));
        const saved = entityOf(botId).exportToFile(filePath);
        return JSON.stringify({ ok: true, botId, filePath: saved });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const entityImport: Tool = {
    definition: toolDef(
      'memory_entity_import',
      'Nhập snapshot memory từ file JSON (kiểm tra checksum, rồi restore theo chế độ replace/merge).',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        filePath: { type: 'string', description: 'Đường dẫn file snapshot.' },
        mode: { type: 'string', description: 'replace hoặc merge (mặc định merge).' },
      },
      ['filePath'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const mode = (getOptionalStringArg(args, 'mode') ?? 'merge') as LettaRestoreMode;
        if (mode !== 'replace' && mode !== 'merge') {
          throw new Error('mode phải là "replace" hoặc "merge".');
        }
        const filePath = resolveFilePath(needWorkspaceDir(), getStringArg(args, 'filePath'));
        const report = entityOf(botId).importFromFile(filePath, mode);
        return JSON.stringify({ ok: true, report });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const entityStats: Tool = {
    definition: toolDef(
      'memory_entity_stats',
      'Thống kê 3 tầng memory + proposals của bot: core blocks (chars/limit/version), số phiên/episode recall, số mục archival, proposal pending/applied.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        return JSON.stringify({ ok: true, stats: entityOf(botId).stats() });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepRun: Tool = {
    definition: toolDef(
      'memory_letta_sleep_run',
      'Chạy một sleep pass Letta cho bot: cắt recall cũ, trích fact từ phiên cũ vào archival, xoá mục archival trùng lặp, đề xuất cập nhật core block (chỉ đề xuất, không tự ghi đè). dryRun=true chỉ tính toán, không ghi gì.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        dryRun: { type: 'boolean', description: 'true = chỉ tính toán, không ghi (mặc định false).' },
        skipProposals: { type: 'boolean', description: 'true = bỏ qua bước đề xuất core update (mặc định false).' },
        extraFacts: {
          type: 'array',
          description: 'Fact bổ sung do caller đưa (vd fact trích bởi sleep agent khác): [{text, source, confidence?}].',
          items: { type: 'object' },
        },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const report = runLettaSleepPass(needWorkspaceDir(), botId, {
          dryRun: getBooleanArg(args, 'dryRun'),
          skipProposals: getBooleanArg(args, 'skipProposals'),
          extraFacts: getFactsArg(args, 'extraFacts'),
        });
        return JSON.stringify({ ok: true, report });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepProposals: Tool = {
    definition: toolDef(
      'memory_letta_sleep_proposals',
      'Liệt kê proposal cập nhật core block do sleep pass tạo (mới nhất trước). Proposal pending chờ user/agent quyết định — không tự áp dụng.',
      {
        botId: { type: 'string', description: 'Bot (mặc định bot hiện tại).' },
        status: { type: 'string', description: 'Lọc theo trạng thái: pending | applied | rejected | approved (mặc định tất cả).' },
        limit: { type: 'number', description: 'Số proposal tối đa (1..200, mặc định 50).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const botId = botIdOf(args, ctx);
        const status = getOptionalStringArg(args, 'status');
        const valid = ['pending', 'applied', 'rejected', 'approved'];
        if (status !== undefined && !valid.includes(status)) {
          throw new Error(`status phải là một trong: ${valid.join(', ')}.`);
        }
        const list = proposalsOf().list({
          botId,
          ...(status !== undefined ? { status: status as 'pending' | 'applied' | 'rejected' | 'approved' } : {}),
          limit: getNumberArg(args, 'limit'),
        });
        return JSON.stringify({ ok: true, botId, proposals: list });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepProposalDecide: Tool = {
    definition: toolDef(
      'memory_letta_sleep_proposal_decide',
      'Quyết định một proposal: approve (append dòng fact vào block đích), apply-edited (append dòng đã sửa), reject (bỏ, không sửa block). Quyết định được ghi log audit.',
      {
        proposalId: { type: 'string', description: 'Id proposal.' },
        decision: { type: 'string', description: 'approve | reject | apply-edited.' },
        decidedBy: { type: 'string', description: 'Ai quyết định (vd user hoặc agent:bot-a).' },
        note: { type: 'string', description: 'Ghi chú quyết định (vd lý do reject).' },
        editedLine: { type: 'string', description: 'Dòng fact đã sửa (bắt buộc khi decision=apply-edited).' },
      },
      ['proposalId', 'decision'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const decision = getStringArg(args, 'decision') as SleepProposalDecision;
        if (decision !== 'approve' && decision !== 'reject' && decision !== 'apply-edited') {
          throw new Error('decision phải là "approve", "reject" hoặc "apply-edited".');
        }
        const result = proposalsOf().decide(getStringArg(args, 'proposalId'), decision, {
          decidedBy: getOptionalStringArg(args, 'decidedBy') ?? 'user',
          note: getOptionalStringArg(args, 'note'),
          editedLine: getOptionalStringArg(args, 'editedLine'),
        });
        return JSON.stringify({ ok: true, ...result });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepLog: Tool = {
    definition: toolDef(
      'memory_letta_sleep_log',
      'Log các sleep pass Letta gần nhất (mới nhất trước): số phiên đã cắt, fact đã trích/lưu, mục archival trùng đã xoá, proposal đã tạo.',
      {
        limit: { type: 'number', description: 'Số lần chạy tối đa (mặc định 20).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const runs = readLettaSleepLog(needWorkspaceDir(), getNumberArg(args, 'limit') ?? 20);
        return JSON.stringify({ ok: true, runs });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    coreCreate,
    coreList,
    coreRead,
    coreAppend,
    coreReplace,
    coreDelete,
    coreRender,
    recallRecord,
    recallSearch,
    archivalInsert,
    archivalSearch,
    archivalPromote,
    archivalDelete,
    archivalStats,
    entitySnapshot,
    entityRestore,
    entityExport,
    entityImport,
    entityStats,
    sleepRun,
    sleepProposals,
    sleepProposalDecide,
    sleepLog,
  ];
}

/** Unbound placeholder (same shape as MEMORY_V9_TOOLS). */
export const MEMORY_V9_LETTA_TOOLS: Tool[] = createMemoryV9LettaTools();

/** Names of the memory v9 Letta tools (for the coordinator/registry checks). */
export const MEMORY_V9_LETTA_TOOL_NAMES = [
  'core_memory_create',
  'core_memory_list',
  'core_memory_read',
  'core_memory_append',
  'core_memory_replace',
  'core_memory_delete',
  'core_memory_render',
  'memory_recall_record',
  'memory_recall_search',
  'memory_archival_insert',
  'memory_archival_search',
  'memory_archival_promote',
  'memory_archival_delete',
  'memory_archival_stats',
  'memory_entity_snapshot',
  'memory_entity_restore',
  'memory_entity_export',
  'memory_entity_import',
  'memory_entity_stats',
  'memory_letta_sleep_run',
  'memory_letta_sleep_proposals',
  'memory_letta_sleep_proposal_decide',
  'memory_letta_sleep_log',
] as const;

