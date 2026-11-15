/**
 * Memory v9 kiểu Letta — core memory tự sửa qua tool (v1.09, Đội T2).
 *
 * Ý tưởng học từ Letta/MemGPT (core memory là các block mà agent tự
 * đọc/sửa bằng tool, luôn nằm trong context, có giới hạn kích thước
 * cứng), viết lại hoàn toàn trên MemoryBlockStore có sẵn của open-bot
 * (v0.96) — KHÔNG viết lại store, chỉ thêm lớp quản lý kiểu Letta
 * lên trên:
 *
 *  - 3 block hệ thống luôn nằm trong context khi attach vào bot:
 *    `persona` (tính cách / cách hành xử, ≤ 2 KB),
 *    `human`   (sự thật về người dùng, ≤ 4 KB),
 *    `project` (bối cảnh dự án đang làm, ≤ 8 KB).
 *    Block tự do khác mặc định ≤ 2 KB (giới hạn mặc định của store).
 *  - append: khi append làm block vượt giới hạn, agent BẮT BUỘC cô
 *    đọng — CoreMemoryManager tự cô đọng nội dung cũ về 90% giới hạn
 *    (bằng condense.ts, không bịa chữ) rồi mới append, và báo rõ
 *    `condensed: true` để agent biết memory đã bị nén.
 *  - replace: nội dung mới vượt giới hạn -> throw, kèm gợi ý cô đọng
 *    (agent phải tự rút gọn rồi gọi lại — đúng hành vi Letta: không
 *    có đường tắt append vô hạn).
 *  - delete: xoá block (kèm detach khỏi mọi bot) — block read-only
 *    vẫn bị chặn như store gốc.
 *  - renderCorePrompt(botId): render các block đã attach vào bot
 *    thành một đoạn system prompt ("## Core memory ..."), theo thứ tự
 *    persona -> human -> project -> block tự do.
 *  - ensureCoreBlocks(botId): tạo + attach đủ 3 block hệ thống cho
 *    bot mới (idempotent — block đã có thì chỉ attach).
 *
 * Mọi thay đổi đều đi qua MemoryBlockStore nên audit + history +
 * versioning (blockHistory, v9 version store) vẫn chạy như cũ.
 * Actor ghi audit: `agent:<botId>` khi agent tự sửa, `user` khi user
 * sửa tay qua UI/tool.
 */
import { MemoryBlockStore, DEFAULT_BLOCK_CHAR_LIMIT } from '../blocks';
import type { MemoryBlock } from '../blocks';
import { condenseBlockToLimit, condenseText } from './condense';
import type { CondenseResult } from './condense';

/** Giới hạn ký tự cứng của từng block hệ thống (Letta-style). */
export const LETTA_CORE_LIMITS: Readonly<Record<string, number>> = {
  persona: 2048,
  human: 4096,
  project: 8192,
};
/** 3 label block hệ thống — luôn render trước, theo đúng thứ tự này. */
export const LETTA_CORE_LABELS = ['persona', 'human', 'project'] as const;
export type LettaCoreLabel = (typeof LETTA_CORE_LABELS)[number];

/** Giới hạn mặc định cho block tự do (bằng giới hạn mặc định store). */
export const LETTA_FREE_BLOCK_LIMIT = DEFAULT_BLOCK_CHAR_LIMIT;

/** Actor mặc định khi agent tự sửa core memory của chính nó. */
export function lettaAgentActor(botId: string): string {
  return `agent:${botId}`;
}

/** Giới hạn áp cho một label (hệ thống có giới hạn riêng, còn lại mặc định). */
export function lettaLimitForLabel(label: string): number {
  const normalized = (label ?? '').trim().toLowerCase();
  return LETTA_CORE_LIMITS[normalized] ?? LETTA_FREE_BLOCK_LIMIT;
}

/** true khi label là một trong 3 block hệ thống. */
export function isLettaCoreLabel(label: string): label is LettaCoreLabel {
  return (LETTA_CORE_LABELS as readonly string[]).includes((label ?? '').trim().toLowerCase());
}

/** Tóm tắt mức đầy của một block (để UI/tool cảnh báo trước khi đầy). */
export interface CoreBlockUsage {
  label: string;
  chars: number;
  limit: number;
  /** Tỷ lệ đầy 0..1 (có thể > 1 nếu block legacy vượt giới hạn mới). */
  fillRatio: number;
  /** 'ok' < 70%, 'warm' 70–90%, 'full' > 90%. */
  state: 'ok' | 'warm' | 'full';
}

export function coreBlockUsage(block: MemoryBlock): CoreBlockUsage {
  const limit = block.charLimit > 0 ? block.charLimit : lettaLimitForLabel(block.label);
  const fillRatio = limit > 0 ? block.content.length / limit : 0;
  return {
    label: block.label,
    chars: block.content.length,
    limit,
    fillRatio,
    state: fillRatio >= 0.9 ? 'full' : fillRatio >= 0.7 ? 'warm' : 'ok',
  };
}

/** Kết quả append kiểu Letta (có thể đã cô đọng nội dung cũ). */
export interface CoreMemoryAppendResult {
  block: MemoryBlock;
  usage: CoreBlockUsage;
  /** true = nội dung cũ đã bị cô đọng trước khi append (để vừa giới hạn). */
  condensed: boolean;
  /** Chi tiết lần cô đọng (null khi không cô đọng). */
  condense: CondenseResult | null;
  appendedChars: number;
}

/** Kết quả replace / create / delete. */
export interface CoreMemoryWriteResult {
  block: MemoryBlock | null;
  usage: CoreBlockUsage | null;
  detail: string;
}

/** Lỗi core memory — message tiếng Việt, tool trả thẳng cho agent. */
export class LettaCoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LettaCoreError';
  }
}

/**
 * Quản lý core memory kiểu Letta cho một workspace (một user).
 * Mỗi bot có tập block riêng qua attachment của MemoryBlockStore —
 * cùng một block attach ở nhiều bot thì mọi bot đều thấy nội dung
 * mới (share), đúng như store gốc.
 */
export class CoreMemoryManager {
  private readonly store: MemoryBlockStore;

  constructor(workspaceDir: string) {
    this.store = new MemoryBlockStore(workspaceDir);
  }

  /** Store gốc (để tool/UI dùng các API cũ khi cần). */
  get blockStore(): MemoryBlockStore {
    return this.store;
  }

  /** Đọc một block theo id hoặc label (null khi không có). */
  read(idOrLabel: string): MemoryBlock | null {
    return this.store.get(idOrLabel);
  }

  /** Liệt kê block đã attach vào bot (theo thứ tự attach của store). */
  listAttached(botId: string): MemoryBlock[] {
    return this.store.listAttached(botId);
  }

  /** Liệt kê mọi block trong workspace (kèm cả block chưa attach). */
  listAll(): MemoryBlock[] {
    return this.store.list();
  }

  /** Mức đầy của mọi block đã attach vào bot. */
  usageForBot(botId: string): CoreBlockUsage[] {
    return this.listAttached(botId).map(coreBlockUsage);
  }

  /**
   * Tạo block core (hoặc block tự do). Label hệ thống luôn lấy đúng
   * giới hạn cứng của nó — caller có truyền charLimit khác cũng bị
   * ép về giới hạn hệ thống (không cho nới lỏng block hệ thống).
   * Tạo xong thì attach ngay vào bot tạo ra nó.
   */
  create(
    botId: string,
    input: { label: string; description?: string; content?: string; charLimit?: number },
    actor?: string,
  ): MemoryBlock {
    const label = (input.label ?? '').trim().toLowerCase();
    if (label === '') throw new LettaCoreError('Label block không được rỗng.');
    const limit = isLettaCoreLabel(label)
      ? LETTA_CORE_LIMITS[label]
      : Math.max(100, Math.min(20000, input.charLimit ?? LETTA_FREE_BLOCK_LIMIT));
    const content = input.content ?? '';
    if (content.length > limit) {
      throw new LettaCoreError(
        `Nội dung dài ${content.length} ký tự, vượt giới hạn ${limit} ký tự của block "${label}". ` +
          `Hãy cô đọng nội dung trước khi tạo block.`,
      );
    }
    const who = actor ?? lettaAgentActor(botId);
    const block = this.store.create(
      {
        label,
        description: input.description ?? defaultCoreDescription(label),
        content,
        charLimit: limit,
        createdByBotId: botId,
      },
      who,
    );
    this.store.attach(botId, block.id, who);
    return block;
  }

  /** Tạo + attach đủ 3 block hệ thống cho bot (idempotent). */
  ensureCoreBlocks(botId: string, actor?: string): MemoryBlock[] {
    const who = actor ?? lettaAgentActor(botId);
    const out: MemoryBlock[] = [];
    for (const label of LETTA_CORE_LABELS) {
      const existing = this.store.get(label);
      if (existing) {
        if (!this.store.isAttached(botId, existing.id)) this.store.attach(botId, existing.id, who);
        out.push(existing);
        continue;
      }
      out.push(this.create(botId, { label, content: '' }, who));
    }
    return out;
  }

  /**
   * Append kiểu Letta: nối text vào cuối block.
   *
   *  - Vừa giới hạn: append thẳng như store.
   *  - Vượt giới hạn: BẮT BUỘC cô đọng — nội dung cũ được cô đọng về
   *    90% giới hạn (trích xuất, không bịa), rồi mới append; kết quả
   *    báo `condensed: true` + chi tiết cô đọng để agent/UI thấy rõ
   *    memory đã bị nén.
   *  - Cô đọng xong mà vẫn không vừa (text append quá dài): throw,
   *    kèm số ký tự tối đa còn append được.
   */
  append(idOrLabel: string, text: string, botId: string, actor?: string): CoreMemoryAppendResult {
    const addition = (text ?? '').trim();
    if (addition === '') throw new LettaCoreError('Không có nội dung để nối vào block.');
    const who = actor ?? lettaAgentActor(botId);
    const before = this.store.get(idOrLabel);
    if (!before) throw new LettaCoreError(`Không tìm thấy block "${idOrLabel}".`);
    if (before.readOnly) {
      throw new LettaCoreError(`Block "${before.label}" đang read-only, không sửa được.`);
    }
    const limit = before.charLimit > 0 ? before.charLimit : lettaLimitForLabel(before.label);
    const nextLen = before.content === '' ? addition.length : before.content.length + 1 + addition.length;
    if (nextLen <= limit) {
      const block = this.store.append(before.id, addition, who);
      return {
        block,
        usage: coreBlockUsage(block),
        condensed: false,
        condense: null,
        appendedChars: addition.length,
      };
    }
    // Vượt giới hạn -> cô đọng nội dung cũ trước.
    const condense = condenseBlockToLimit(before.content, limit);
    const condensedContent = condense.text;
    const afterCondenseLen =
      condensedContent === '' ? addition.length : condensedContent.length + 1 + addition.length;
    if (afterCondenseLen > limit) {
      const room = Math.max(0, limit - (condensedContent === '' ? 0 : condensedContent.length + 1));
      throw new LettaCoreError(
        `Block "${before.label}" đã đầy (giới hạn ${limit} ký tự). Đã cô đọng nội dung cũ từ ` +
          `${before.content.length} xuống ${condensedContent.length} ký tự nhưng vẫn không đủ chỗ: ` +
          `chỉ còn append được tối đa ${room} ký tự. Hãy rút ngắn nội dung cần thêm hoặc replace toàn bộ block.`,
      );
    }
    // Ghi đè bằng bản cô đọng (replace), rồi append — 2 lần ghi, mỗi
    // lần đều có audit + snapshot version như store gốc.
    this.store.replace(before.id, condensedContent, `system:condense:${botId}`);
    const block = this.store.append(before.id, addition, who);
    return {
      block,
      usage: coreBlockUsage(block),
      condensed: true,
      condense,
      appendedChars: addition.length,
    };
  }

  /**
   * Replace toàn bộ nội dung block. Vượt giới hạn -> throw kèm gợi ý
   * cô đọng (agent phải tự rút gọn rồi gọi lại — không có đường tắt).
   */
  replace(idOrLabel: string, content: string, botId: string, actor?: string): MemoryBlock {
    const who = actor ?? lettaAgentActor(botId);
    const before = this.store.get(idOrLabel);
    if (!before) throw new LettaCoreError(`Không tìm thấy block "${idOrLabel}".`);
    const limit = before.charLimit > 0 ? before.charLimit : lettaLimitForLabel(before.label);
    if ((content ?? '').length > limit) {
      throw new LettaCoreError(
        `Nội dung dài ${(content ?? '').length} ký tự, vượt giới hạn ${limit} ký tự của block "${before.label}". ` +
          `Hãy cô đọng nội dung xuống dưới ${limit} ký tự rồi gọi lại.`,
      );
    }
    return this.store.replace(before.id, content ?? '', who);
  }

  /** Cô đọng một block về 90% giới hạn của nó (ghi đè, có audit). */
  condense(idOrLabel: string, botId: string, actor?: string): { block: MemoryBlock; condense: CondenseResult } {
    const who = actor ?? lettaAgentActor(botId);
    const before = this.store.get(idOrLabel);
    if (!before) throw new LettaCoreError(`Không tìm thấy block "${idOrLabel}".`);
    if (before.readOnly) {
      throw new LettaCoreError(`Block "${before.label}" đang read-only, không sửa được.`);
    }
    const limit = before.charLimit > 0 ? before.charLimit : lettaLimitForLabel(before.label);
    const result = condenseBlockToLimit(before.content, limit);
    if (!result.condensed) return { block: before, condense: result };
    const block = this.store.replace(before.id, result.text, `system:condense:${botId}`);
    void who;
    return { block, condense: result };
  }

  /** Xoá block (kèm detach khỏi mọi bot). Block read-only bị chặn. */
  delete(idOrLabel: string, botId: string, actor?: string): boolean {
    const who = actor ?? lettaAgentActor(botId);
    const before = this.store.get(idOrLabel);
    if (!before) throw new LettaCoreError(`Không tìm thấy block "${idOrLabel}".`);
    return this.store.delete(before.id, who);
  }

  /**
   * Render core memory đã attach vào bot thành một đoạn system prompt.
   * Block hệ thống render trước (persona -> human -> project), rồi
   * tới block tự do theo thứ tự attach. Block rỗng vẫn render tiêu đề
   * (để model biết block tồn tại nhưng chưa có nội dung).
   */
  renderCorePrompt(botId: string): string {
    const blocks = this.listAttached(botId);
    if (blocks.length === 0) return '';
    const rank = (label: string): number => {
      const idx = (LETTA_CORE_LABELS as readonly string[]).indexOf(label);
      return idx === -1 ? LETTA_CORE_LABELS.length : idx;
    };
    const sorted = [...blocks].sort((a, b) => rank(a.label) - rank(b.label));
    const sections = sorted.map((b) => {
      const body = b.content === '' ? '(trống)' : b.content;
      return `<${b.label}>\n${body}\n</${b.label}>`;
    });
    return (
      `## Core memory (bộ nhớ bền vững của bạn — tự sửa bằng tool core_memory_*)\n` +
      sections.join('\n') +
      `\n## Hết core memory`
    );
  }
}

/** Mô tả mặc định cho từng block hệ thống (hiện trong UI + prompt). */
export function defaultCoreDescription(label: string): string {
  switch ((label ?? '').trim().toLowerCase()) {
    case 'persona':
      return 'Tính cách và cách hành xử của bot (tự sửa bằng tool core_memory_*).';
    case 'human':
      return 'Sự thật bền vững về người dùng (tự sửa bằng tool core_memory_*).';
    case 'project':
      return 'Bối cảnh dự án / công việc đang làm (tự sửa bằng tool core_memory_*).';
    default:
      return 'Block memory tự do (tự sửa bằng tool core_memory_*).';
  }
}
