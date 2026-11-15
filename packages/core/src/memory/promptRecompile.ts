/**
 * Memory v7 — block-level prompt recompilation (v1.06, Đội T1).
 *
 * Ý tưởng học từ Letta (`Memory.compile()` + rebuild system prompt):
 * core memory không phải là thứ "tìm rồi chèn" mỗi lần — nó được BIÊN
 * DỊCH thành system prompt. Khi agent sửa một block, hệ thống không
 * biên dịch lại toàn bộ prompt: mỗi block có hash nội dung riêng, chỉ
 * block nào đổi hash mới recompile, các block còn lại tái dùng section
 * đã biên dịch từ cache.
 *
 * Cách render một block (giữ đúng format của memory blocks v0.96 để
 * model quen):
 *   <memory label="human" tier="semantic" scope="system">
 *   ...nội dung...
 *   </memory>
 *
 * Thứ tự trong prompt: block system (`human`, `persona`) trước, rồi
 * theo tầng bền -> kém bền (semantic, episodic, session, working),
 * rồi theo label. Block rỗng nội dung vẫn render (để model thấy block
 * tồn tại) nhưng được đánh dấu `(empty)`.
 *
 * Cache sống trong một instance PromptRecompiler (giữ theo bot
 * session); `compile()` là hàm thuần cho trường hợp không cần cache.
 */

import { createHash } from 'node:crypto';
import type { V7MemoryBlock } from './gitProjection';
import type { MemoryTier } from './tiers';

/** Hash SHA-256 của nội dung block (hex, 64 ký tự). */
export function hashBlockContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Một section đã biên dịch của một block. */
export interface CompiledBlockSection {
  label: string;
  tier: MemoryTier;
  scope: string;
  /** Hash nội dung lúc biên dịch — đổi hash = phải recompile. */
  hash: string;
  text: string;
  chars: number;
}

export interface CompiledPrompt {
  prompt: string;
  /** Hash của toàn bộ prompt (đổi khi bất kỳ block nào đổi). */
  promptHash: string;
  blocks: CompiledBlockSection[];
  totalChars: number;
  /** Số block đã recompile trong lần gọi này (0 = toàn bộ tái dùng cache). */
  recompiledCount: number;
  /** Số block tái dùng section đã biên dịch từ cache. */
  reusedCount: number;
}

/** Thứ tự tier khi render: bền trước, kém bền sau. */
export function tierPromptOrder(tier: MemoryTier): number {
  switch (tier) {
    case 'semantic':
      return 0;
    case 'episodic':
      return 1;
    case 'session':
      return 2;
    case 'working':
      return 3;
  }
}

/** Xếp block theo thứ tự render vào prompt. */
export function sortBlocksForPrompt(blocks: V7MemoryBlock[]): V7MemoryBlock[] {
  return [...blocks].sort(
    (a, b) =>
      (a.scope === 'system' ? 0 : 1) - (b.scope === 'system' ? 0 : 1) ||
      tierPromptOrder(a.tier) - tierPromptOrder(b.tier) ||
      a.label.localeCompare(b.label),
  );
}

/** Biên dịch một block thành một section text. */
export function renderBlockSection(block: V7MemoryBlock): CompiledBlockSection {
  const body = block.content === '' ? '(empty)' : block.content;
  const text = `<memory label="${block.label}" tier="${block.tier}" scope="${block.scope}">\n${body}\n</memory>`;
  return {
    label: block.label,
    tier: block.tier,
    scope: block.scope,
    hash: hashBlockContent(block.content),
    text,
    chars: text.length,
  };
}

/** Biên dịch toàn bộ block thành prompt (không cache — hàm thuần). */
export function compileSystemPrompt(
  blocks: V7MemoryBlock[],
  opts: { header?: string; footer?: string } = {},
): CompiledPrompt {
  const ordered = sortBlocksForPrompt(blocks);
  const sections = ordered.map(renderBlockSection);
  const parts: string[] = [];
  if (opts.header) parts.push(opts.header);
  if (sections.length > 0) {
    parts.push('[Memory — the following blocks are your long-term memory. Edit them with the memory_v7_* tools when facts change.]\n');
    parts.push(sections.map((s) => s.text).join('\n\n'));
  }
  if (opts.footer) parts.push(opts.footer);
  const prompt = parts.join('\n\n');
  return {
    prompt,
    promptHash: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    blocks: sections,
    totalChars: prompt.length,
    recompiledCount: sections.length,
    reusedCount: 0,
  };
}

export class PromptRecompiler {
  private readonly cache = new Map<string, CompiledBlockSection>();
  private lastPromptHash = '';

  /** Hash của prompt biên dịch gần nhất ('' khi chưa biên dịch lần nào). */
  get promptHash(): string {
    return this.lastPromptHash;
  }

  /** Số section đang giữ trong cache. */
  get cachedSections(): number {
    return this.cache.size;
  }

  /**
   * Biên dịch lại prompt từ danh sách block hiện tại. Chỉ block nào
   * đổi hash (so với cache) mới recompile; block còn lại tái dùng
   * section cũ. Block đã xoá thì rơi khỏi cache.
   */
  recompile(blocks: V7MemoryBlock[], opts: { header?: string; footer?: string } = {}): CompiledPrompt {
    const ordered = sortBlocksForPrompt(blocks);
    const sections: CompiledBlockSection[] = [];
    let recompiled = 0;
    let reused = 0;
    const seen = new Set<string>();
    for (const block of ordered) {
      seen.add(block.label);
      const hash = hashBlockContent(block.content);
      const cached = this.cache.get(block.label);
      if (cached && cached.hash === hash && cached.tier === block.tier && cached.scope === block.scope) {
        sections.push(cached);
        reused += 1;
      } else {
        const section = renderBlockSection(block);
        this.cache.set(block.label, section);
        sections.push(section);
        recompiled += 1;
      }
    }
    // Dọn cache: block đã xoá khỏi projection thì không giữ nữa.
    for (const label of [...this.cache.keys()]) {
      if (!seen.has(label)) this.cache.delete(label);
    }
    const parts: string[] = [];
    if (opts.header) parts.push(opts.header);
    if (sections.length > 0) {
      parts.push('[Memory — the following blocks are your long-term memory. Edit them with the memory_v7_* tools when facts change.]\n');
      parts.push(sections.map((s) => s.text).join('\n\n'));
    }
    if (opts.footer) parts.push(opts.footer);
    const prompt = parts.join('\n\n');
    this.lastPromptHash = createHash('sha256').update(prompt, 'utf8').digest('hex');
    return {
      prompt,
      promptHash: this.lastPromptHash,
      blocks: sections,
      totalChars: prompt.length,
      recompiledCount: recompiled,
      reusedCount: reused,
    };
  }

  /** Xoá section của một block khỏi cache (ép recompile lần sau). */
  invalidate(label: string): void {
    this.cache.delete(label);
  }

  /** Xoá toàn bộ cache. */
  clear(): void {
    this.cache.clear();
    this.lastPromptHash = '';
  }
}
