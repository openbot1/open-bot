/**
 * Memory v12 — bien dich block vao system prompt (v1.12, Doi T1).
 *
 * Y tuong hoc tu Letta (`Memory.compile()`): core memory duoc BIEN
 * DICH thanh mot doan system prompt, khong phai tim-kiem-roi-chen moi
 * lan. V7 da co y nay cho block gitProjection; v12 lam lai cho
 * MemoryBlockStore (block that cua bot) + them 2 thu v7 chua co:
 *
 *  1. NGAN SACH TOKEN: tong prompt block khong vuot
 *     `totalTokenBudget` (mac dinh 4000 token uoc luong). Vuot thi
 *     cat bot theo muc uu tien (kind he thong truoc, custom sau),
 *     danh dau ro cho nao bi cat (`… [truncated: …]`),
 *     block nao bi bo han thi ghi vao `dropped` — model luon thay
 *     duoc tai sao prompt ngan lai.
 *  2. CACHE THEO HASH: `BlockPromptCompiler` giu section da bien
 *     dich cua tung block theo (id, version, hash noi dung). Block
 *     nao khong doi thi tai dung — lan goi sau khi agent sua 1 block
 *     chi recompile dung block do (`recompiledCount`/`reusedCount`
 *     noi ro). Hash dung SHA-256 cua promptRecompile v7.
 *
 * Dinh dang render giong het v11 (`<memory_blocks>` + `<block
 * label kind version description>`) de model va parser v11 quen —
 * chi khac o cho noi dung co the bi cat ngan theo ngan sach.
 *
 * Thu tu cat bot khi vuot ngan sach: block custom (uu tien thap
 * nhat) bi cat/truoc het, roi den `safety`, `project`, `task`,
 * `persona`, `human` cuoi cung. Trong cung mot block, cat tu CUOI
 * noi dung (giua lai dau — noi dung dau block thuong la dinh nghia
 * / fact co ban), cat theo ranh gioi dong khi co the.
 */

import { createHash } from 'node:crypto';
import { MemoryBlockStore, normalizeBlockLabel } from '../blocks';
import type { MemoryBlock } from '../blocks';
import {
  detectBlockKind,
  sortBlocksForRender,
  escapeMemoryBlockXml,
} from '../v11/blockKinds';
import { hashBlockContent } from '../promptRecompile';
import {
  estimateTokens,
  v12TokenLimitForBlock,
  V12_DEFAULT_TOTAL_TOKEN_BUDGET,
  V12_MIN_TOTAL_TOKEN_BUDGET,
  V12_MAX_TOTAL_TOKEN_BUDGET,
} from './tokens';

/** Ngan sach mac dinh — re-export de tool/test dung chung mot cho. */
export { V12_DEFAULT_TOTAL_TOKEN_BUDGET } from './tokens';

/** Danh dau chen vao cuoi noi dung bi cat (de model biet phan sau mat di). */
export const V12_TRUNCATION_MARKER = '… [truncated: …]';
/** So token toi thieu con lai moi dang de giu mot block (it hon thi bo han). */
export const V12_MIN_TOKENS_TO_KEEP_BLOCK = 8;
/**
 * So token du phong them moi block khi tinh ngan sach: tag mo/dong
 * `<block ...>` + xuong dong giua cac block ton token ngoai noi dung
 * (uoc luong token cua prompt noi khop co the lech vai token so voi
 * tong cong don) — tru truoc de tong thuc te khong vuot ngan sach.
 */
export const V12_PER_BLOCK_RESERVE_TOKENS = 4;

export interface V12CompiledBlockEntry {
  label: string;
  kind: string;
  version: number;
  description: string;
  /** Noi dung DA RENDER (co the da bi cat ngan). */
  content: string;
  /** Token uoc luong cua noi dung DA RENDER. */
  tokens: number;
  /** Token uoc luong cua noi dung GOC (truoc khi cat). */
  originalTokens: number;
  /** true khi noi dung bi cat bot de vua ngan sach. */
  truncated: boolean;
  /** true khi block vuot gioi han token rieng cua kind (du chua vuot ngan sach chung). */
  overKindLimit: boolean;
}

export interface V12CompiledBlocksPrompt {
  /** Doan `<memory_blocks>...</memory_blocks>` ('' khi khong co block nao). */
  prompt: string;
  /** SHA-256 cua `prompt` (doi khi bat ky block nao doi). */
  promptHash: string;
  /** Tong token uoc luong cua `prompt` (bao gom ca tag XML). */
  totalTokens: number;
  /** Ngan sach token da ap. */
  budget: number;
  /** true khi phai cat/bo bot de vua ngan sach. */
  overBudgetBefore: boolean;
  blocks: V12CompiledBlockEntry[];
  /** Label cac block bi cat bot noi dung. */
  truncated: string[];
  /** Label cac block bi bo han (khong du ngan sach de giu). */
  dropped: string[];
  /** So block phai recompile trong lan goi nay (doi hash). */
  recompiledCount: number;
  /** So block tai dung section da bien dich tu cache. */
  reusedCount: number;
}

export interface CompileBlocksOptions {
  /** Ngan sach token cho toan bo doan prompt block (mac dinh 4000). */
  totalTokenBudget?: number;
  /**
   * Gioi han token cung cho tung block (mac dinh = gioi han token cua
   * kind/block). Truyen Infinity de tat gioi han rieng.
   */
  perBlockTokenLimit?: number;
}

/** Clamp ngan sach ve khoang cho phep. */
export function clampTotalTokenBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return V12_DEFAULT_TOTAL_TOKEN_BUDGET;
  return Math.min(
    V12_MAX_TOTAL_TOKEN_BUDGET,
    Math.max(V12_MIN_TOTAL_TOKEN_BUDGET, Math.floor(value)),
  );
}

/**
 * Cat noi dung theo so token con lai. Dung binary search voi chinh
 * `estimateTokens` (da hieu chuan) de tim doan dau dai nhat vua
 * ngan sach — khong dung quy tac `chars/4` (sai lon voi tieng Viet
 * / CJK: ~2 ky tu/token thay vi 4). Cat theo ranh gioi dong gan
 * nhat phia truoc, them marker (marker cung tru vao ngan sach).
 * Tra '' khi khong du cho de giu doan co nghia.
 */
export function truncateContentToTokens(content: string, tokensLeft: number): string {
  const markerTokens = estimateTokens(`\n${V12_TRUNCATION_MARKER}`);
  const headBudget = tokensLeft - markerTokens;
  if (headBudget < V12_MIN_TOKENS_TO_KEEP_BLOCK) return '';
  if (estimateTokens(content) <= tokensLeft) return content;
  // Binary search: doan dau dai nhat co estimateTokens <= headBudget.
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(content.slice(0, mid)) <= headBudget) lo = mid;
    else hi = mid - 1;
  }
  if (lo <= 0) return '';
  const cut = content.lastIndexOf('\n', lo - 1);
  const head = (cut > 0 ? content.slice(0, cut) : content.slice(0, lo)).trimEnd();
  if (head === '') return '';
  return `${head}\n${V12_TRUNCATION_MARKER}`;
}

/** Render mot block (da co noi dung cuoi cung) thanh 3 dong XML. */
export function renderCompiledBlock(entry: V12CompiledBlockEntry): string {
  const label = escapeMemoryBlockXml(entry.label);
  const description = escapeMemoryBlockXml(entry.description ?? '');
  return [
    `<block label="${label}" kind="${entry.kind}" version="${entry.version}" description="${description}">`,
    escapeMemoryBlockXml(entry.content),
    '</block>',
  ].join('\n');
}

/**
 * Chi phi token cua tag mo/dong mot block (khong tinh noi dung):
 * render block voi noi dung rong roi dem token. Dung de tru vao
 * ngan sach truoc khi cap phan cho noi dung.
 */
export function blockOverheadTokens(block: Pick<MemoryBlock, 'label' | 'description' | 'version'>): number {
  const rendered = renderCompiledBlock({
    label: block.label,
    kind: 'custom',
    version: block.version,
    description: block.description ?? '',
    content: '',
    tokens: 0,
    originalTokens: 0,
    truncated: false,
    overKindLimit: false,
  });
  return estimateTokens(rendered);
}

/**
 * Bien dich cac block da attach vao bot thanh doan `<memory_blocks>`
 * de ghep vao system prompt (ham thuan — khong cache, goi moi lan
 * tinh lai tu dau; can cache thi dung BlockPromptCompiler).
 *
 * Block trong van render (de agent biet block ton tai). Block chua
 * attach khong bao gio lot vao. Thu tu render: human -> persona ->
 * task -> project -> safety -> custom (sortBlocksForRender cua v11).
 */
export function compileBlocksForPrompt(
  store: MemoryBlockStore,
  botId: string,
  opts: CompileBlocksOptions = {},
): V12CompiledBlocksPrompt {
  const budget = clampTotalTokenBudget(opts.totalTokenBudget);
  const attached = sortBlocksForRender(store.listAttached(botId));
  const empty: V12CompiledBlocksPrompt = {
    prompt: '',
    promptHash: createHash('sha256').update('', 'utf8').digest('hex'),
    totalTokens: 0,
    budget,
    overBudgetBefore: false,
    blocks: [],
    truncated: [],
    dropped: [],
    recompiledCount: 0,
    reusedCount: 0,
  };
  if (attached.length === 0) return empty;

  // Chi phi co dinh cua khung <memory_blocks>...</memory_blocks>.
  const frameTokens = estimateTokens('<memory_blocks>\n</memory_blocks>');
  let remaining = budget - frameTokens;
  const entries: V12CompiledBlockEntry[] = [];
  const truncated: string[] = [];
  const dropped: string[] = [];
  let overBudgetBefore = false;

  // Duyet theo thu tu uu tien CAO xuong THAP (attached da sort):
  // block uu tien cao duoc cap ngan sach truoc, giu nguyen; block
  // uu tien thap nhan phan con lai (bi cat, roi bo han khi het).
  // Moi block ton them chi phi tag mo/dong + du phong (xem
  // blockOverheadTokens) — tinh vao ngan sach de tong prompt thuc
  // te khong vuot budget.
  for (const block of attached) {
    const kind = detectBlockKind(block.label);
    const originalTokens = estimateTokens(block.content);
    const kindLimit =
      opts.perBlockTokenLimit !== undefined
        ? opts.perBlockTokenLimit
        : v12TokenLimitForBlock(block);
    const overKindLimit = originalTokens > kindLimit;
    const overhead =
      blockOverheadTokens(block) + V12_PER_BLOCK_RESERVE_TOKENS;
    // Cat theo gioi han rieng cua block truoc (neu vuot).
    let content = block.content;
    let tokens = originalTokens;
    let wasTruncated = false;
    if (tokens > kindLimit && Number.isFinite(kindLimit)) {
      const cut = truncateContentToTokens(content, kindLimit);
      if (cut === '') {
        dropped.push(block.label);
        continue;
      }
      content = cut;
      tokens = estimateTokens(content);
      wasTruncated = true;
    }
    const available = remaining - overhead;
    if (tokens > available) {
      overBudgetBefore = true;
      const cut = truncateContentToTokens(content, available);
      if (cut === '') {
        dropped.push(block.label);
        continue;
      }
      content = cut;
      tokens = estimateTokens(content);
      wasTruncated = true;
    }
    remaining -= overhead + tokens;
    entries.push({
      label: block.label,
      kind,
      version: block.version,
      description: block.description ?? '',
      content,
      tokens,
      originalTokens,
      truncated: wasTruncated,
      overKindLimit,
    });
    if (wasTruncated) truncated.push(block.label);
  }
  // `truncated`/`dropped` da theo thu tu render (duyet xuoi).
  if (entries.length === 0) {
    return {
      ...empty,
      overBudgetBefore,
      dropped,
      truncated,
    };
  }
  const lines: string[] = ['<memory_blocks>'];
  for (const entry of entries) lines.push(renderCompiledBlock(entry));
  lines.push('</memory_blocks>');
  const prompt = lines.join('\n');
  const totalTokens = estimateTokens(prompt);
  return {
    prompt,
    promptHash: hashBlockContent(prompt),
    totalTokens,
    budget,
    overBudgetBefore,
    blocks: entries,
    truncated,
    dropped,
    recompiledCount: entries.length,
    reusedCount: 0,
  };
}

/**
 * Ghep doan block da bien dich vao system prompt goc. Doan block
 * rong -> tra nguyen prompt goc. Doan block dat SAU prompt goc (de
 * huong dan co ban cua bot khong bi day xuong duoi).
 */
export function buildSystemPrompt(basePrompt: string, compiled: V12CompiledBlocksPrompt): string {
  const base = basePrompt ?? '';
  if (!compiled.prompt) return base;
  return base === '' ? compiled.prompt : `${base}\n\n${compiled.prompt}`;
}

/** true khi system prompt da chua doan `<memory_blocks>`. */
export function systemPromptHasMemoryBlocks(prompt: string): boolean {
  return (prompt ?? '').includes('<memory_blocks>');
}

/** Section da bien dich cua mot block trong cache cua compiler. */
interface CachedBlockSection {
  version: number;
  hash: string;
  entry: V12CompiledBlockEntry;
}

/**
 * Compiler co cache: giu section da bien dich theo (id, version,
 * hash noi dung). `compile()` chi recompile block nao doi hash (vi
 * du agent vua sua 1 block) — cac block con lai tai dung section cu,
 * ke ca khi ngan sach doi (ngan sach chi anh huong cat bot, tinh lai
 * tren section da cache). Cache song theo instance (theo bot session);
 * dung `clear()` khi doi workspace/bot.
 */
export class BlockPromptCompiler {
  private readonly cache = new Map<string, CachedBlockSection>();
  private lastPromptHash = '';
  private lastResult: V12CompiledBlocksPrompt | null = null;

  /** So block dang co trong cache. */
  get cachedBlockCount(): number {
    return this.cache.size;
  }

  /** Xoa toan bo cache (doi bot/workspace). */
  clear(): void {
    this.cache.clear();
    this.lastPromptHash = '';
    this.lastResult = null;
  }

  compile(
    store: MemoryBlockStore,
    botId: string,
    opts: CompileBlocksOptions = {},
  ): V12CompiledBlocksPrompt {
    const budget = clampTotalTokenBudget(opts.totalTokenBudget);
    const attached = sortBlocksForRender(store.listAttached(botId));
    if (attached.length === 0) {
      this.lastResult = {
        prompt: '',
        promptHash: createHash('sha256').update('', 'utf8').digest('hex'),
        totalTokens: 0,
        budget,
        overBudgetBefore: false,
        blocks: [],
        truncated: [],
        dropped: [],
        recompiledCount: 0,
        reusedCount: 0,
      };
      this.lastPromptHash = this.lastResult.promptHash;
      return this.lastResult;
    }

    // Buoc 1: recompile (hoac tai dung) section GOC cua tung block
    // (chua cat theo ngan sach — cat o buoc 2, tren section da cache).
    let recompiledCount = 0;
    let reusedCount = 0;
    const full: { block: MemoryBlock; hash: string; entry: V12CompiledBlockEntry }[] = [];
    const seen = new Set<string>();
    for (const block of attached) {
      seen.add(block.id);
      const hash = hashBlockContent(block.content);
      const cached = this.cache.get(block.id);
      if (cached && cached.version === block.version && cached.hash === hash) {
        reusedCount += 1;
        full.push({ block, hash, entry: cached.entry });
        continue;
      }
      recompiledCount += 1;
      const kind = detectBlockKind(block.label);
      const entry: V12CompiledBlockEntry = {
        label: block.label,
        kind,
        version: block.version,
        description: block.description ?? '',
        content: block.content,
        tokens: estimateTokens(block.content),
        originalTokens: estimateTokens(block.content),
        truncated: false,
        overKindLimit:
          estimateTokens(block.content) >
          (opts.perBlockTokenLimit !== undefined
            ? opts.perBlockTokenLimit
            : v12TokenLimitForBlock(block)),
      };
      this.cache.set(block.id, { version: block.version, hash, entry });
      full.push({ block, hash, entry });
    }
    // Don cache cua block khong con attach nua.
    for (const id of [...this.cache.keys()]) {
      if (!seen.has(id)) this.cache.delete(id);
    }

    // Buoc 2: ap ngan sach (giong compileBlocksForPrompt, nhung tren
    // section da cache). Duyet nguoc de cat block uu tien thap truoc.
    const frameTokens = estimateTokens('<memory_blocks>\n</memory_blocks>');
    let remaining = budget - frameTokens;
    const kept: (V12CompiledBlockEntry | null)[] = full.map(() => null);
    const truncated: string[] = [];
    const dropped: string[] = [];
    let overBudgetBefore = false;
    // Duyet xuoi theo uu tien (giong compileBlocksForPrompt): block
    // uu tien cao cap ngan sach truoc; block thap nhan phan con lai.
    const entries: V12CompiledBlockEntry[] = [];
    for (const { block, entry } of full) {
      const kindLimit =
        opts.perBlockTokenLimit !== undefined
          ? opts.perBlockTokenLimit
          : v12TokenLimitForBlock(block);
      const overhead =
        blockOverheadTokens(block) + V12_PER_BLOCK_RESERVE_TOKENS;
      let content = entry.content;
      let tokens = entry.tokens;
      let wasTruncated = false;
      if (tokens > kindLimit && Number.isFinite(kindLimit)) {
        const cut = truncateContentToTokens(content, kindLimit);
        if (cut === '') {
          dropped.push(entry.label);
          continue;
        }
        content = cut;
        tokens = estimateTokens(content);
        wasTruncated = true;
      }
      const available = remaining - overhead;
      if (tokens > available) {
        overBudgetBefore = true;
        const cut = truncateContentToTokens(content, available);
        if (cut === '') {
          dropped.push(entry.label);
          continue;
        }
        content = cut;
        tokens = estimateTokens(content);
        wasTruncated = true;
      }
      remaining -= overhead + tokens;
      entries.push({ ...entry, content, tokens, truncated: wasTruncated });
      if (wasTruncated) truncated.push(entry.label);
    }
    // `truncated`/`dropped` da theo thu tu render (duyet xuoi).

    if (entries.length === 0) {
      const result: V12CompiledBlocksPrompt = {
        prompt: '',
        promptHash: createHash('sha256').update('', 'utf8').digest('hex'),
        totalTokens: 0,
        budget,
        overBudgetBefore,
        blocks: [],
        truncated,
        dropped,
        recompiledCount,
        reusedCount,
      };
      this.lastResult = result;
      this.lastPromptHash = result.promptHash;
      return result;
    }
    const lines: string[] = ['<memory_blocks>'];
    for (const entry of entries) lines.push(renderCompiledBlock(entry));
    lines.push('</memory_blocks>');
    const prompt = lines.join('\n');
    const result: V12CompiledBlocksPrompt = {
      prompt,
      promptHash: hashBlockContent(prompt),
      totalTokens: estimateTokens(prompt),
      budget,
      overBudgetBefore,
      blocks: entries,
      truncated,
      dropped,
      recompiledCount,
      reusedCount,
    };
    this.lastResult = result;
    this.lastPromptHash = result.promptHash;
    return result;
  }

  /** Ket qua compile gan nhat (null khi chua compile lan nao). */
  get lastCompiled(): V12CompiledBlocksPrompt | null {
    return this.lastResult;
  }

  /** true khi prompt cua bot doi so voi lan compile truoc (de host biet can nap lai). */
  hasPromptChanged(store: MemoryBlockStore, botId: string): boolean {
    const previousHash = this.lastPromptHash;
    const current = this.compile(store, botId);
    return previousHash !== '' && current.promptHash !== previousHash;
  }
}

/** Slug hoa label (tien ich nho cho tool v12, dung chung ham cua store). */
export function normalizeV12Label(raw: string): string {
  return normalizeBlockLabel(raw);
}
