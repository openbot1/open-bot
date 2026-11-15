/**
 * Memory v9 kiểu Letta — tầng archival (v1.09, Đội T2).
 *
 * Ý tưởng học từ Letta/MemGPT: archival memory là kho lưu trữ dài hạn
 * nằm NGOÀI context — agent chỉ lôi vào khi tìm kiếm trúng. Viết lại
 * hoàn toàn cho open-bot, chạy local, nối với long-term memory v0.95
 * về mặt khái niệm nhưng là store riêng (không phá API cũ):
 *
 *  - Mỗi mục archival: id, text, nguồn (session/recall/fact/import),
 *    tags, độ tin cậy, thời gian tạo/truy cập, số lần được recall,
 *    embedding (tuỳ chọn — vector KHÔNG BAO GIỜ xuất hiện trong tool
 *    output hay UI, chỉ dùng để chấm điểm cosine nội bộ).
 *  - Tìm kiếm: keyword (TF — đếm từ khoá truy vấn xuất hiện trong
 *    text/tags) + recency/access boost; nếu caller truyền hàm embed
 *    (vd Ollama nomic-embed-text qua embeddings.ts) thì cộng thêm
 *    điểm cosine (trọng số 0.5) — không có embed thì fallback thuần
 *    từ khoá, vẫn trả kết quả đúng.
 *  - Phân trang (offset/limit) để agent duyệt kho lớn từng đợt.
 *  - Promote: đẩy một mục archival lên core block (ghi thành một dòng
 *    fact vào block `human`/`project` qua CoreMemoryManager — có thể
 *    kích hoạt cô đọng khi block đầy); demote ngược lại: lấy một dòng
 *    khỏi core block xuống archival (không xoá khỏi block trừ khi
 *    caller yêu cầu).
 *  - Lưu trữ: một file JSON `.open-bot/memory-v9-archival.json`,
 *    ghi atomic (temp + rename, mode 0600), tối đa 10000 mục (vượt
 *    thì mục cũ nhất, ít truy cập nhất rớt trước).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { condenseWords } from './condense';

/** File archival (JSON). */
export const V9_ARCHIVAL_REL_PATH = path.join('.open-bot', 'memory-v9-archival.json');
/** Số mục tối đa trong kho archival. */
export const V9_ARCHIVAL_MAX_ITEMS = 10000;
/** Độ dài tối đa của một mục archival (ký tự). */
export const V9_ARCHIVAL_MAX_TEXT_CHARS = 8000;
/** Số tag tối đa của một mục. */
export const V9_ARCHIVAL_MAX_TAGS = 20;
/** Trọng số cosine khi có embedding (0.5 cosine + 0.5 keyword/boost). */
export const V9_ARCHIVAL_EMBEDDING_WEIGHT = 0.5;

/** Nguồn gốc của một mục archival. */
export type ArchivalSource = 'session' | 'recall' | 'fact' | 'core-demoted' | 'import' | 'manual';

/** Một mục trong kho archival. */
export interface ArchivalItem {
  id: string;
  text: string;
  source: ArchivalSource;
  /** Session/phiên gốc (nếu có). */
  sourceId?: string;
  tags: string[];
  /** Độ tin cậy 0..1 (fact đã xác minh cao hơn ghi chú thô). */
  confidence: number;
  /** Vector embedding (nếu có) — KHÔNG trả ra tool output/UI. */
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  /**
   * v1.11 (memory v11 — sleep-time consolidation): muc bi invalidate
   * boi sleep pass khi fact moi mau thuan no. Muc van nam trong file
   * (lich su con nguyen) nhung search() bo qua; xoa cung chi khi
   * user goi delete() ro rang. Vang = muc dang con hieu luc.
   */
  invalidatedAt?: string;
  /** Ly do invalidate (vd fact moi mau thuan). */
  invalidatedReason?: string;
}

/** File archival trên đĩa. */
export interface ArchivalFile {
  version: 1;
  items: ArchivalItem[];
}

/** Đầu vào khi thêm mục mới. */
export interface InsertArchivalInput {
  text: string;
  source?: ArchivalSource;
  sourceId?: string;
  tags?: string[];
  confidence?: number;
  embedding?: number[];
}

/** Kết quả tìm kiếm một mục (đã lược embedding). */
export interface ArchivalHit {
  item: Omit<ArchivalItem, 'embedding'>;
  /** Điểm keyword 0..1. */
  keywordScore: number;
  /** Điểm cosine 0..1 (null khi không có embedding để chấm). */
  embeddingScore: number | null;
  score: number;
}

/** Điều kiện tìm kiếm archival. */
export interface ArchivalSearchQuery {
  query: string;
  tags?: string[];
  source?: ArchivalSource;
  /** Chỉ lấy mục tạo sau mốc này (ISO). */
  since?: string;
  limit?: number;
  offset?: number;
}

/** Kết quả tìm kiếm có phân trang. */
export interface ArchivalSearchResult {
  hits: ArchivalHit[];
  total: number;
  limit: number;
  offset: number;
}

/** Lỗi archival — message tiếng Việt. */
export class ArchivalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivalError';
  }
}

/** Cosine giữa hai vector (0..1, trả 0 khi vector rỗng/khác độ dài/không hữu hạn — không throw, để search không vỡ khi embedding lỗi). */
export function safeCosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

/** Chuẩn hoá tags: chữ thường, bỏ trùng, bỏ rỗng, tối đa N tag. */
export function normalizeArchivalTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= V9_ARCHIVAL_MAX_TAGS) break;
  }
  return out;
}

/** Điểm keyword: tỷ lệ từ khoá truy vấn xuất hiện trong text/tags. */
export function archivalKeywordScore(query: string, item: ArchivalItem): number {
  const queryWords = condenseWords(query);
  if (queryWords.size === 0) return 0;
  const haystack = new Set<string>(condenseWords(item.text));
  for (const tag of item.tags) {
    for (const w of condenseWords(tag)) haystack.add(w);
  }
  let inter = 0;
  for (const w of queryWords) if (haystack.has(w)) inter += 1;
  return inter / queryWords.size;
}

/** Bản public của item (bỏ embedding — không bao giờ rò vector). */
export function publicArchivalItem(item: ArchivalItem): Omit<ArchivalItem, 'embedding'> {
  const { embedding: _embedding, ...rest } = item;
  return rest;
}

/**
 * Tầng archival: kho lưu trữ dài hạn, tìm kiếm từ khoá (+ embedding
 * nếu có), phân trang, promote/demote với core memory.
 */
export class ArchivalStore {
  private readonly filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, V9_ARCHIVAL_REL_PATH);
  }

  /** Đọc toàn bộ mục (file hỏng -> trả rỗng, không throw). */
  readAll(): ArchivalItem[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ArchivalFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return [];
      return parsed.items.filter((it) => it && typeof it.id === 'string' && typeof it.text === 'string');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // File hỏng (JSON vỡ): trả rỗng để caller vẫn chạy được; không
      // tự ghi đè file hỏng (để user còn cứu tay).
      if (err instanceof SyntaxError) return [];
      throw err;
    }
  }

  /** Ghi toàn bộ file (atomic: temp + rename, mode 0600). */
  private writeAll(items: ArchivalItem[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Thêm một mục mới (text rỗng/quá dài -> throw). */
  insert(input: InsertArchivalInput): Omit<ArchivalItem, 'embedding'> {
    const text = (input.text ?? '').trim();
    if (text === '') throw new ArchivalError('Nội dung archival không được rỗng.');
    if (text.length > V9_ARCHIVAL_MAX_TEXT_CHARS) {
      throw new ArchivalError(
        `Nội dung archival dài ${text.length} ký tự, vượt giới hạn ${V9_ARCHIVAL_MAX_TEXT_CHARS} ký tự. ` +
          `Hãy tách thành nhiều mục nhỏ hơn.`,
      );
    }
    const now = new Date().toISOString();
    const item: ArchivalItem = {
      id: randomUUID(),
      text,
      source: input.source ?? 'manual',
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
      tags: normalizeArchivalTags(input.tags),
      confidence:
        typeof input.confidence === 'number' && Number.isFinite(input.confidence)
          ? Math.max(0, Math.min(1, input.confidence))
          : 0.5,
      ...(Array.isArray(input.embedding) && input.embedding.length > 0 ? { embedding: input.embedding } : {}),
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      accessCount: 0,
    };
    const all = this.readAll();
    // Trùng y hệt text + source thì không thêm mới — trả lại mục cũ.
    const dup = all.find((it) => it.text === text && it.source === item.source);
    if (dup) return publicArchivalItem(dup);
    all.push(item);
    // Vượt dung lượng: rớt mục cũ nhất, ít truy cập nhất trước.
    if (all.length > V9_ARCHIVAL_MAX_ITEMS) {
      all.sort((a, b) => a.accessCount - b.accessCount || a.createdAt.localeCompare(b.createdAt));
      all.splice(0, all.length - V9_ARCHIVAL_MAX_ITEMS);
    }
    this.writeAll(all);
    return publicArchivalItem(item);
  }

  /** Đọc một mục theo id (null khi không có). Không tính access. */
  get(id: string): Omit<ArchivalItem, 'embedding'> | null {
    const found = this.readAll().find((it) => it.id === id);
    return found ? publicArchivalItem(found) : null;
  }

  /**
   * Tìm kiếm archival. `embedQuery` (tuỳ chọn) là hàm embed truy vấn
   * thành vector — có thì chấm thêm cosine, không có thì fallback
   * thuần từ khoá. Kết quả đã xếp hạng + phân trang; mỗi lần hit
   * được trả về sẽ tăng accessCount (ghi lại, tối đa 1 lần ghi cho
   * cả trang kết quả).
   */
  async search(
    query: ArchivalSearchQuery,
    embedQuery?: (text: string) => Promise<number[] | null>,
  ): Promise<ArchivalSearchResult> {
    const q = (query.query ?? '').trim();
    if (q === '') throw new ArchivalError('Truy vấn archival không được rỗng.');
    const limit = Math.max(1, Math.min(50, Math.floor(query.limit ?? 10)));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const sinceMs = query.since ? new Date(query.since).getTime() : Number.NEGATIVE_INFINITY;
    const wantedTags = normalizeArchivalTags(query.tags);
    let queryEmbedding: number[] | null = null;
    if (embedQuery) {
      try {
        queryEmbedding = await embedQuery(q);
      } catch {
        queryEmbedding = null;
      }
    }
    const all = this.readAll();
    const scored: ArchivalHit[] = [];
    for (const item of all) {
      // v1.11: muc da invalidate khong con hieu luc — search bo qua.
      if (item.invalidatedAt) continue;
      if (query.source && item.source !== query.source) continue;
      if (Number.isFinite(sinceMs) && new Date(item.createdAt).getTime() < sinceMs) continue;
      if (wantedTags.length > 0 && !wantedTags.every((t) => item.tags.includes(t))) continue;
      const keyword = archivalKeywordScore(q, item);
      let embeddingScore: number | null = null;
      if (queryEmbedding && item.embedding) {
        embeddingScore = safeCosineSimilarity(queryEmbedding, item.embedding);
      }
      // Không khớp từ khoá và không có điểm embedding -> loại.
      if (keyword === 0 && (embeddingScore === null || embeddingScore < 0.1)) continue;
      const accessBoost = Math.min(0.1, item.accessCount * 0.01);
      const base = embeddingScore === null ? keyword : (1 - V9_ARCHIVAL_EMBEDDING_WEIGHT) * keyword + V9_ARCHIVAL_EMBEDDING_WEIGHT * embeddingScore;
      const score = Math.min(1, base * (0.5 + item.confidence * 0.5) + accessBoost);
      scored.push({ item: publicArchivalItem(item), keywordScore: keyword, embeddingScore, score });
    }
    scored.sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt));
    const total = scored.length;
    const page = scored.slice(offset, offset + limit);
    // Ghi nhận access cho các mục trong trang trả về (1 lần ghi).
    if (page.length > 0) {
      const ids = new Set(page.map((h) => h.item.id));
      const now = new Date().toISOString();
      const updated = all.map((it) =>
        ids.has(it.id) ? { ...it, accessCount: it.accessCount + 1, lastAccessedAt: now } : it,
      );
      this.writeAll(updated);
    }
    return { hits: page, total, limit, offset };
  }

  /** Xoá một mục (true = đã xoá). */
  delete(id: string): boolean {
    const all = this.readAll();
    const kept = all.filter((it) => it.id !== id);
    if (kept.length === all.length) return false;
    this.writeAll(kept);
    return true;
  }

  /**
   * v1.11 (memory v11 — sleep-time consolidation): INVALIDATE mot muc
   * (danh dau khong con hieu luc, KHONG xoa cung). Muc da invalidate
   * thi search() bo qua. Tra false khi muc khong ton tai hoac da bi
   * invalidate tu truoc (idempotent — goi lai khong doi gi).
   */
  invalidate(id: string, reason: string): boolean {
    const all = this.readAll();
    const item = all.find((it) => it.id === id);
    if (!item || item.invalidatedAt) return false;
    item.invalidatedAt = new Date().toISOString();
    item.invalidatedReason = (reason ?? '').trim().slice(0, 500) || 'Invalidated by sleep pass.';
    item.updatedAt = item.invalidatedAt;
    this.writeAll(all);
    return true;
  }

  /** Khoi phuc mot muc da invalidate (xoa dau invalidated). Tra false khi muc khong ton tai hoac chua bi invalidate. */
  reinstate(id: string): boolean {
    const all = this.readAll();
    const item = all.find((it) => it.id === id);
    if (!item || !item.invalidatedAt) return false;
    delete item.invalidatedAt;
    delete item.invalidatedReason;
    item.updatedAt = new Date().toISOString();
    this.writeAll(all);
    return true;
  }

  /** Đổi tags/confidence của một mục. */
  update(id: string, patch: { tags?: string[]; confidence?: number }): Omit<ArchivalItem, 'embedding'> {
    const all = this.readAll();
    const item = all.find((it) => it.id === id);
    if (!item) throw new ArchivalError(`Không tìm thấy mục archival "${id}".`);
    if (patch.tags !== undefined) item.tags = normalizeArchivalTags(patch.tags);
    if (patch.confidence !== undefined && Number.isFinite(patch.confidence)) {
      item.confidence = Math.max(0, Math.min(1, patch.confidence));
    }
    item.updatedAt = new Date().toISOString();
    this.writeAll(all);
    return publicArchivalItem(item);
  }

  /** Thống kê nhanh cho UI/entity stats. */
  stats(): { items: number; embedded: number; bySource: Record<string, number>; oldestCreatedAt: string | null; newestCreatedAt: string | null } {
    const all = this.readAll();
    const bySource: Record<string, number> = {};
    let embedded = 0;
    let oldest: string | null = null;
    let newest: string | null = null;
    for (const it of all) {
      bySource[it.source] = (bySource[it.source] ?? 0) + 1;
      if (it.embedding) embedded += 1;
      if (oldest === null || it.createdAt < oldest) oldest = it.createdAt;
      if (newest === null || it.createdAt > newest) newest = it.createdAt;
    }
    return { items: all.length, embedded, bySource, oldestCreatedAt: oldest, newestCreatedAt: newest };
  }
}
