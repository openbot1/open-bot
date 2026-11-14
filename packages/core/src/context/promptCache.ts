/**
 * Prompt-cache theo hash cho memory blocks đã biên dịch (v1.07, Đội T6).
 *
 * Ý tưởng học từ OpenHands v1.38 / LiteLLM prompt caching (survey
 * v1.07 §1): cache system prompt + memory blocks đã biên dịch theo
 * hash, chỉ gửi lại phần đổi — giảm 30–80% chi phí gửi lặp. Module
 * này nối tiếp `memory/promptRecompile.ts` (v1.06, Đội T1 — cache
 * theo block trong bộ nhớ của một session) thêm 3 thứ còn thiếu:
 *
 * 1. CACHE CẤP PROMPT: toàn bộ prompt đã biên dịch cũng có hash riêng
 *    — prompt không đổi thì lần sau là HIT toàn phần, không cần gửi
 *    lại cả prompt cho provider (khi provider hỗ trợ prefix caching,
 *    xem `context/cacheHints.ts`).
 * 2. SEND PLAN (delta): mỗi lần biên dịch trả về kế hoạch gửi — lần
 *    đầu gửi đủ, lần sau chỉ gửi section của block ĐÃ ĐỔI + hash của
 *    phần ổn định, kèm ước tính token tiết kiệm được.
 * 3. PERSISTENCE: cache sống qua restart — lưu file JSON
 *    (`compiled-prompt-cache-v107.json`) trong fleet/userData dir,
 *    ghi atomic, load có validate; file hỏng → throw rõ ràng (không
 *    âm thầm dùng cache rỗng rồi gửi sai prompt).
 *
 * Ước tính token = ký tự / 4 (cùng quy tắc mọi nơi trong repo) — là
 * ƯỚC TÍNH để đo tiết kiệm, không phải số token thật provider tính.
 * Cache KHÔNG lưu secret: section chỉ chứa nội dung memory block mà
 * user đã có trong prompt; file cache nằm trong userData dir của app
 * (cùng mức bảo vệ như các file state khác).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  PromptRecompiler,
  hashBlockContent,
  renderBlockSection,
  type CompiledBlockSection,
  type CompiledPrompt,
} from '../memory/promptRecompile';
import type { V7MemoryBlock } from '../memory/gitProjection';

/** Tên file cache prompt đã biên dịch (trong fleet/userData dir). */
export const PROMPT_CACHE_FILE = 'compiled-prompt-cache-v107.json';

/** Số prompt tối đa giữ trong cache bộ nhớ (LRU — prompt cũ nhất rơi trước). */
export const DEFAULT_PROMPT_CACHE_MAX_ENTRIES = 64;

/** Số section tối đa giữ cho một prompt (chặn prompt khổng lồ chiếm cache). */
export const DEFAULT_PROMPT_CACHE_MAX_SECTIONS = 512;

/** Hash SHA-256 hex của một chuỗi (dùng cho prompt + section key). */
export function hashPromptContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Ước tính token từ số ký tự (4 ký tự ≈ 1 token). */
export function estimateTokensForChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** Một mục prompt đã biên dịch trong cache. */
export interface CachedCompiledPrompt {
  /** Hash toàn bộ prompt — key tra cứu. */
  promptHash: string;
  /** Toàn bộ prompt text đã biên dịch. */
  prompt: string;
  /** Section từng block (để diff lần sau). */
  sections: CompiledBlockSection[];
  /** Epoch ms lúc lưu. */
  savedAt: number;
  /** Số lần mục này được tái dùng (HIT toàn phần). */
  hits: number;
}

/** Thống kê cache — để UI/tool báo cáo tiết kiệm. */
export interface PromptCacheStats {
  /** Số lần biên dịch đã chạy qua cache này. */
  compilations: number;
  /** Số lần prompt không đổi (HIT toàn phần — không cần gửi lại). */
  fullHits: number;
  /** Số section tái dùng từ cache block (không recompile). */
  blockHits: number;
  /** Số section phải recompile (block đổi hoặc mới). */
  blockMisses: number;
  /** Token ước tính TIẾT KIỆM được nhờ tái dùng (block hit + full hit). */
  estTokensSaved: number;
  /** Token ước tính đã gửi (phần phải biên dịch/gửi lại). */
  estTokensSent: number;
  /** Số mục prompt đang giữ. */
  entries: number;
  /** Số section block đang giữ. */
  cachedSections: number;
}

/** Kế hoạch gửi prompt cho provider sau một lần biên dịch. */
export interface PromptSendPlan {
  /** true = gửi toàn bộ prompt (lần đầu hoặc prompt đổi quá nhiều). */
  sendFull: boolean;
  /** Hash prompt hiện tại (provider dùng làm cache-breakpoint). */
  promptHash: string;
  /** Hash prompt lần trước ('' khi chưa có lần trước). */
  previousPromptHash: string;
  /** Section của block ĐÃ ĐỔI / MỚI — chỉ gửi phần này khi không sendFull. */
  changedSections: CompiledBlockSection[];
  /** Label block KHÔNG ĐỔI — provider tái dùng từ prefix cache. */
  unchangedLabels: string[];
  /** Token ước tính tiết kiệm so với gửi toàn bộ prompt. */
  estTokensSaved: number;
  /** Token ước tính phải gửi lần này. */
  estTokensToSend: number;
  /** Chiến lược cache mà provider nên dùng (dựa trên cacheHints). */
  cacheHint: 'prefix-cache' | 'resend-changed-only' | 'no-cache-support';
}

/**
 * Cache prompt đã biên dịch theo hash: bọc PromptRecompiler (cache
 * block trong bộ nhớ) + thêm cache cấp prompt (LRU) + send plan +
 * thống kê + persistence file. Một instance = một bot session (cùng
 * vòng đời PromptRecompiler); nhiều bot dùng nhiều instance riêng.
 */
export class CompiledPromptCache {
  private readonly recompiler = new PromptRecompiler();
  private readonly prompts = new Map<string, CachedCompiledPrompt>();
  private readonly maxEntries: number;
  private readonly maxSections: number;
  private lastPromptHash = '';
  private stats: Omit<PromptCacheStats, 'entries' | 'cachedSections'> = {
    compilations: 0,
    fullHits: 0,
    blockHits: 0,
    blockMisses: 0,
    estTokensSaved: 0,
    estTokensSent: 0,
  };

  constructor(opts: { maxEntries?: number; maxSections?: number } = {}) {
    const maxEntries = Math.floor(opts.maxEntries ?? DEFAULT_PROMPT_CACHE_MAX_ENTRIES);
    this.maxEntries = maxEntries > 0 ? maxEntries : DEFAULT_PROMPT_CACHE_MAX_ENTRIES;
    const maxSections = Math.floor(opts.maxSections ?? DEFAULT_PROMPT_CACHE_MAX_SECTIONS);
    this.maxSections = maxSections > 0 ? maxSections : DEFAULT_PROMPT_CACHE_MAX_SECTIONS;
  }

  /** Hash prompt biên dịch gần nhất ('' khi chưa biên dịch lần nào). */
  get promptHash(): string {
    return this.lastPromptHash;
  }

  /** Số mục prompt đang giữ trong cache. */
  get size(): number {
    return this.prompts.size;
  }

  /** Thống kê hiện tại (bản sao — caller không sửa được stats gốc). */
  getStats(): PromptCacheStats {
    return {
      ...this.stats,
      entries: this.prompts.size,
      cachedSections: this.recompiler.cachedSections,
    };
  }

  /**
   * Biên dịch prompt từ block hiện tại + cập nhật cache + trả send
   * plan. Prompt không đổi so với lần trước → full HIT: không gửi
   * lại gì ngoài hash. Block nào đổi hash mới recompile; còn lại tái
   * dùng section cũ (kế thừa PromptRecompiler).
   */
  compile(
    blocks: V7MemoryBlock[],
    opts: { header?: string; footer?: string; providerId?: string } = {},
  ): { compiled: CompiledPrompt; plan: PromptSendPlan; fullHit: boolean } {
    const previousHash = this.lastPromptHash;
    const compiled = this.recompiler.recompile(blocks, opts);
    this.stats.compilations += 1;
    this.stats.blockHits += compiled.reusedCount;
    this.stats.blockMisses += compiled.recompiledCount;
    // Token tiết kiệm nhờ tái dùng section: ước tính theo ký tự section tái dùng.
    const reusedChars = compiled.blocks
      .filter((s) => {
        // Section tái dùng = section có trong lần biên dịch trước với cùng hash.
        const prev = this.prompts.get(previousHash);
        return prev?.sections.some((p) => p.label === s.label && p.hash === s.hash);
      })
      .reduce((sum, s) => sum + s.chars, 0);
    // Lần đầu (chưa có prompt trước) thì reusedChars = 0 — đúng: chưa tiết kiệm gì.
    const fullHit = previousHash !== '' && previousHash === compiled.promptHash;
    if (fullHit) {
      this.stats.fullHits += 1;
      const hit = this.prompts.get(compiled.promptHash);
      if (hit) hit.hits += 1;
      this.stats.estTokensSaved += estimateTokensForChars(compiled.totalChars);
      this.stats.estTokensSent += 0;
    } else {
      this.stats.estTokensSaved += estimateTokensForChars(reusedChars);
      this.stats.estTokensSent += estimateTokensForChars(compiled.totalChars - reusedChars);
      this.storePrompt(compiled);
    }
    this.lastPromptHash = compiled.promptHash;
    const plan = this.buildSendPlan(compiled, previousHash, opts.providerId);
    return { compiled, plan, fullHit };
  }

  /**
   * Xây send plan cho một prompt đã biên dịch: so với prompt lần
   * trước, liệt kê section đổi + label không đổi. Hàm public để
   * caller tự build plan khi đã có compiled prompt sẵn (vd sau khi
   * load từ file).
   */
  buildSendPlan(
    compiled: CompiledPrompt,
    previousPromptHash: string,
    providerId?: string,
  ): PromptSendPlan {
    const previous = previousPromptHash ? this.prompts.get(previousPromptHash) : undefined;
    const prevByLabel = new Map((previous?.sections ?? []).map((s) => [s.label, s]));
    const changed: CompiledBlockSection[] = [];
    const unchanged: string[] = [];
    for (const section of compiled.blocks) {
      const prev = prevByLabel.get(section.label);
      if (prev && prev.hash === section.hash && prev.tier === section.tier && prev.scope === section.scope) {
        unchanged.push(section.label);
      } else {
        changed.push(section);
      }
    }
    // Ngưỡng gửi đủ: lần đầu, hoặc đổi QUÁ nửa số section (gửi delta
    // lúc đó không còn rẻ hơn gửi đủ), hoặc prompt lần trước đã mất.
    const sendFull =
      !previous ||
      compiled.blocks.length === 0 ||
      changed.length * 2 > compiled.blocks.length;
    const changedChars = changed.reduce((sum, s) => sum + s.chars, 0);
    const estTokensToSend = sendFull ? estimateTokensForChars(compiled.totalChars) : estimateTokensForChars(changedChars);
    const estTokensSaved = estimateTokensForChars(compiled.totalChars) - estTokensToSend;
    return {
      sendFull,
      promptHash: compiled.promptHash,
      previousPromptHash,
      changedSections: sendFull ? [...compiled.blocks] : changed,
      unchangedLabels: sendFull ? [] : unchanged,
      estTokensSaved: Math.max(0, estTokensSaved),
      estTokensToSend,
      cacheHint: cacheHintForProvider(providerId),
    };
  }

  /** Lưu một prompt đã biên dịch vào cache LRU (prompt cũ nhất rơi khi đầy). */
  private storePrompt(compiled: CompiledPrompt): void {
    const existing = this.prompts.get(compiled.promptHash);
    if (existing) {
      existing.hits += 1;
      existing.savedAt = Date.now();
      return;
    }
    const sections = compiled.blocks.slice(0, this.maxSections);
    this.prompts.set(compiled.promptHash, {
      promptHash: compiled.promptHash,
      prompt: compiled.prompt,
      sections,
      savedAt: Date.now(),
      hits: 0,
    });
    // LRU: Map giữ thứ tự chèn — xoá mục cũ nhất khi vượt giới hạn.
    while (this.prompts.size > this.maxEntries) {
      const oldest = this.prompts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.prompts.delete(oldest);
    }
  }

  /** Lấy prompt đã biên dịch theo hash (undefined khi chưa cache). */
  getPrompt(promptHash: string): CachedCompiledPrompt | undefined {
    return this.prompts.get(promptHash);
  }

  /** Xoá section của một block khỏi cache (ép recompile lần sau). */
  invalidate(label: string): void {
    this.recompiler.invalidate(label);
    // Prompt chứa section cũ không còn đúng nữa — xoá các mục prompt
    // chứa label đó để lần sau không HIT nhầm prompt cũ.
    for (const [hash, entry] of [...this.prompts.entries()]) {
      if (entry.sections.some((s) => s.label === label)) this.prompts.delete(hash);
    }
    if (this.lastPromptHash && !this.prompts.has(this.lastPromptHash)) {
      this.lastPromptHash = '';
    }
  }

  /** Xoá toàn bộ cache (cả block lẫn prompt) + reset hash lần trước. */
  clear(): void {
    this.recompiler.clear();
    this.prompts.clear();
    this.lastPromptHash = '';
  }

  /** Reset thống kê (giữ nguyên cache). */
  resetStats(): void {
    this.stats = {
      compilations: 0,
      fullHits: 0,
      blockHits: 0,
      blockMisses: 0,
      estTokensSaved: 0,
      estTokensSent: 0,
    };
  }

  /** Serialize cache để lưu file (chỉ prompt + stats, không lưu PromptRecompiler). */
  toJSON(): { version: 1; savedAt: number; prompts: CachedCompiledPrompt[]; stats: PromptCacheStats } {
    return {
      version: 1,
      savedAt: Date.now(),
      prompts: [...this.prompts.values()],
      stats: this.getStats(),
    };
  }

  /** Nạp cache từ dữ liệu đã parse — sai shape → throw. */
  static fromJSON(raw: unknown): CompiledPromptCache {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('prompt cache phải là object JSON.');
    }
    const data = raw as Record<string, unknown>;
    if (data.version !== 1) throw new Error('prompt cache không đúng version (cần version 1).');
    if (!Array.isArray(data.prompts)) throw new Error('prompt cache prompts phải là mảng.');
    const cache = new CompiledPromptCache();
    for (const entry of data.prompts as unknown[]) {
      if (typeof entry !== 'object' || entry === null) throw new Error('prompt cache entry sai shape.');
      const e = entry as Record<string, unknown>;
      if (typeof e.promptHash !== 'string' || e.promptHash.length !== 64) {
        throw new Error('prompt cache entry cần promptHash SHA-256.');
      }
      if (typeof e.prompt !== 'string') throw new Error('prompt cache entry cần prompt là chuỗi.');
      if (!Array.isArray(e.sections)) throw new Error('prompt cache entry sections phải là mảng.');
      for (const s of e.sections as unknown[]) {
        if (typeof s !== 'object' || s === null) throw new Error('prompt cache section sai shape.');
        const sec = s as Record<string, unknown>;
        if (
          typeof sec.label !== 'string' ||
          typeof sec.tier !== 'string' ||
          typeof sec.scope !== 'string' ||
          typeof sec.hash !== 'string' ||
          typeof sec.text !== 'string' ||
          typeof sec.chars !== 'number'
        ) {
          throw new Error('prompt cache section thiếu field (label/tier/scope/hash/text/chars).');
        }
      }
      cache.prompts.set(e.promptHash as string, {
        promptHash: e.promptHash as string,
        prompt: e.prompt as string,
        sections: e.sections as CompiledBlockSection[],
        savedAt: typeof e.savedAt === 'number' ? (e.savedAt as number) : Date.now(),
        hits: typeof e.hits === 'number' ? (e.hits as number) : 0,
      });
    }
    // Khôi phục hash prompt gần nhất (mục savedAt lớn nhất) để lần
    // compile sau restart vẫn nhận ra prompt không đổi → full HIT.
    let latest: CachedCompiledPrompt | undefined;
    for (const entry of cache.prompts.values()) {
      if (!latest || entry.savedAt >= latest.savedAt) latest = entry;
    }
    if (latest) cache.lastPromptHash = latest.promptHash;
    if (typeof data.stats === 'object' && data.stats !== null) {
      const s = data.stats as Record<string, unknown>;
      const num = (key: string): number =>
        typeof s[key] === 'number' && Number.isFinite(s[key] as number) ? (s[key] as number) : 0;
      cache.stats = {
        compilations: num('compilations'),
        fullHits: num('fullHits'),
        blockHits: num('blockHits'),
        blockMisses: num('blockMisses'),
        estTokensSaved: num('estTokensSaved'),
        estTokensSent: num('estTokensSent'),
      };
    }
    return cache;
  }
}

/** Chiến lược cache provider nên dùng — dựa trên bảng hỗ trợ của cacheHints. */
export function cacheHintForProvider(
  providerId?: string,
): PromptSendPlan['cacheHint'] {
  if (!providerId) return 'resend-changed-only';
  // Provider hỗ trợ prefix caching (Anthropic/OpenAI/Gemini/xAI):
  // gửi hash + delta là đủ, provider tự tái dùng prefix.
  const prefixCapable = new Set(['anthropic', 'openai', 'openai-compatible', 'gemini', 'xai']);
  if (prefixCapable.has(providerId.toLowerCase())) return 'prefix-cache';
  // Provider local (Ollama/mock/CLI): không có prefix cache phía
  // server — gửi lại phần đổi, giữ phần ổn định ở client.
  return 'resend-changed-only';
}

/** Đường dẫn file cache trong một base dir (fleet/userData). */
export function getPromptCachePath(baseDir: string): string {
  if (typeof baseDir !== 'string' || baseDir.trim().length === 0) {
    throw new Error('getPromptCachePath cần baseDir không rỗng.');
  }
  return path.join(baseDir, PROMPT_CACHE_FILE);
}

/** Lưu cache ra file (atomic: file tạm + đổi tên). */
export function savePromptCache(baseDir: string, cache: CompiledPromptCache): void {
  const filePath = getPromptCachePath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache.toJSON(), null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Đọc cache từ file. File chưa có → cache rỗng mới. JSON hỏng / shape
 * sai → throw (không dùng cache rỗng âm thầm — prompt sai còn tệ hơn
 * prompt chậm).
 */
export function loadPromptCache(baseDir: string): CompiledPromptCache {
  const filePath = getPromptCachePath(baseDir);
  if (!fs.existsSync(filePath)) return new CompiledPromptCache();
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Không đọc được ${PROMPT_CACHE_FILE}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${PROMPT_CACHE_FILE} hỏng (không phải JSON hợp lệ): ${(err as Error).message}`);
  }
  return CompiledPromptCache.fromJSON(parsed);
}

/**
 * Diff hai prompt đã biên dịch: block nào đổi hash, block nào thêm,
 * block nào xoá — hàm thuần cho caller muốn tự tính delta mà không
 * cần giữ instance cache.
 */
export function diffCompiledPrompts(
  previous: CompiledPrompt | null,
  current: CompiledPrompt,
): {
  changed: CompiledBlockSection[];
  added: CompiledBlockSection[];
  removed: string[];
  unchanged: string[];
  promptChanged: boolean;
} {
  const prevByLabel = new Map((previous?.blocks ?? []).map((s) => [s.label, s]));
  const curByLabel = new Map(current.blocks.map((s) => [s.label, s]));
  const changed: CompiledBlockSection[] = [];
  const added: CompiledBlockSection[] = [];
  const unchanged: string[] = [];
  for (const section of current.blocks) {
    const prev = prevByLabel.get(section.label);
    if (!prev) {
      added.push(section);
    } else if (prev.hash !== section.hash || prev.tier !== section.tier || prev.scope !== section.scope) {
      changed.push(section);
    } else {
      unchanged.push(section.label);
    }
  }
  const removed: string[] = [];
  for (const label of prevByLabel.keys()) {
    if (!curByLabel.has(label)) removed.push(label);
  }
  return {
    changed,
    added,
    removed,
    unchanged,
    promptChanged: (previous?.promptHash ?? '') !== current.promptHash,
  };
}

/** Re-export tiện ích từ promptRecompile để caller chỉ import một chỗ. */
export { hashBlockContent, renderBlockSection };
export type { CompiledBlockSection, CompiledPrompt };
