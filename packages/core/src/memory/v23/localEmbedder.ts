/**
 * Memory v23 — local embedder (v1.38, Doi T1).
 *
 * Embedder chay local cho pipeline extract/consolidate/retrieve:
 *  - Uu tien Ollama local (`nomic-embed-text`, xem ../embeddings —
 *    OllamaEmbeddings co san, khong goi mang ngoai, khong can key).
 *  - Khi Ollama khong kha dung, dung hash-embedder xac dinh noi bo
 *    (FNV-1a tren char 3-gram + token hash, 128 chieu, chuan hoa
 *    L2). Hash-embedder chi bat chuoi ky tu giong nhau — du tot de
 *    dedupe / gop trung lap offline, NHUNG khong phai embedding
 *    ngu nghia that. Moi vector hash deu ghi provenance `hash` de
 *    khong ai nham no voi embedding that; fusion ha trong so
 *    semantic khi toan bo corpus la hash (xem fusion.ts).
 *
 * Khong bao gio throw khi embed loi: tra ve ket qua co cau truc
 * (`ok: false` + ly do), de caller quyet dinh fallback.
 */

import { OllamaEmbeddings, cosineSimilarity } from '../embeddings';
import type { Embedder } from '../embeddings';
import { clampMemoryV23, tokenizeV23 } from './types';
import type { V23EmbeddingKind } from './types';

/** So chieu cua hash-embedder noi bo. */
export const V23_HASH_EMBED_DIM = 128;
/** So chieu toi da chap nhan tu embedder ngoai (de tranh vector lac). */
export const V23_MAX_EMBED_DIM = 4096;

/** Ket qua mot lan embed (co cau truc, khong throw). */
export interface V23EmbedResult {
  ok: boolean;
  /** Vector L2-normalised (chi khi ok). */
  vector?: number[];
  /** Loai embedding da dung. */
  kind: V23EmbeddingKind;
  /** Ly do loi (chi khi !ok). */
  error?: string;
}

/** FNV-1a 32-bit (xac dinh, khong phu thuoc platform). */
export function fnv1aV23(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Hash-embedding xac dinh: moi token + char 3-gram dong gop vao
 * mot bucket (hash % dim) voi dau +/-, cong don roi chuan hoa L2.
 * Cung mot text luon cho cung mot vector; text giong nhau (nhieu
 * token chung) cho cosine cao.
 */
export function hashEmbedV23(text: string, dim = V23_HASH_EMBED_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenizeV23(text);
  const features: string[] = [...tokens];
  const lowered = text.toLowerCase();
  for (let i = 0; i + 3 <= lowered.length; i += 1) {
    features.push(`#${lowered.slice(i, i + 3)}`);
  }
  if (features.length === 0) {
    vec[0] = 1;
    return vec;
  }
  for (const feature of features) {
    const h = fnv1aV23(feature);
    const bucket = h % dim;
    const sign = (h & 0x100) === 0 ? 1 : -1;
    vec[bucket] += sign;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    vec[0] = 1;
    return vec;
  }
  for (let i = 0; i < dim; i += 1) vec[i] /= norm;
  return vec;
}

/** Chuan hoa L2 mot vector (tra ban sao, khong sua input). */
export function l2NormalizeV23(vector: number[]): number[] {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0 || !Number.isFinite(norm)) return [...vector];
  return vector.map((v) => v / norm);
}

/** Cosine similarity, dung ham co san cua ../embeddings. */
export function cosineV23(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  return clampMemoryV23(cosineSimilarity(a, b), -1, 1);
}

/** Tuy chon cua V23LocalEmbedder. */
export interface V23LocalEmbedderOptions {
  /** Embedder ben ngoai (mac dinh Ollama local). Truyen embedder gia trong test. */
  embedder?: Embedder;
  /** Base URL Ollama khi tu tao embedder (mac dinh 127.0.0.1:11434). */
  ollamaBaseUrl?: string;
  /** Model embedding Ollama (mac dinh nomic-embed-text). */
  ollamaModel?: string;
  /** So chieu hash-embedder (mac dinh 128). */
  hashDim?: number;
  /** Cache toi da bao nhieu text (mac dinh 2000). */
  maxCacheEntries?: number;
  /** Fetch inject duoc (truyen xuong OllamaEmbeddings). */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Embedder local cho v23: thu Ollama truoc, fallback hash-embedder
 * co ghi nhan. Cache theo text (LRU don gian: xoa nua cu nhat khi
 * day) de khong embed lai cung mot text nhieu lan trong mot pass.
 */
export class V23LocalEmbedder {
  readonly hashDim: number;
  private readonly embedder: Embedder;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, { vector: number[]; kind: V23EmbeddingKind }>();
  /** Loai embedding cua lan embed thanh cong gan nhat. */
  lastKind: V23EmbeddingKind = 'none';
  /** Ollama co san o lan kiem tra gan nhat khong. */
  lastOllamaAvailable: boolean | null = null;

  constructor(opts: V23LocalEmbedderOptions = {}) {
    this.hashDim = opts.hashDim ?? V23_HASH_EMBED_DIM;
    this.maxCacheEntries = opts.maxCacheEntries ?? 2000;
    this.embedder =
      opts.embedder ??
      new OllamaEmbeddings({
        ...(opts.ollamaBaseUrl ? { baseUrl: opts.ollamaBaseUrl } : {}),
        ...(opts.ollamaModel ? { model: opts.ollamaModel } : {}),
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      });
  }

  /** Kiem tra Ollama co chay khong (khong throw). */
  async isOllamaAvailable(): Promise<boolean> {
    try {
      const available = (await this.embedder.isAvailable?.()) ?? false;
      this.lastOllamaAvailable = available;
      return available;
    } catch {
      this.lastOllamaAvailable = false;
      return false;
    }
  }

  /** So entry trong cache (cho test + giam sat). */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Xoa cache (vd khi doi model). */
  clearCache(): void {
    this.cache.clear();
  }

  private cachePut(text: string, vector: number[], kind: V23EmbeddingKind): void {
    if (this.cache.size >= this.maxCacheEntries) {
      // Xoa nua cu nhat (Map giu thu tu chen).
      const keys = [...this.cache.keys()];
      const drop = Math.max(1, Math.floor(keys.length / 2));
      for (let i = 0; i < drop; i += 1) this.cache.delete(keys[i]);
    }
    this.cache.set(text, { vector, kind });
  }

  /**
   * Embed mot text. Thu Ollama truoc; neu loi / khong kha dung thi
   * dung hash-embedder va ghi ro kind = 'hash'. Chi tra ok=false
   * khi ca hai deu that bai (gan nhu khong xay ra voi hash).
   */
  async embed(text: string): Promise<V23EmbedResult> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, kind: 'none', error: 'Text rong, khong embed duoc.' };
    const cached = this.cache.get(trimmed);
    if (cached) {
      this.lastKind = cached.kind;
      return { ok: true, vector: [...cached.vector], kind: cached.kind };
    }
    try {
      const raw = await this.embedder.embed(trimmed);
      if (Array.isArray(raw) && raw.length > 0 && raw.length <= V23_MAX_EMBED_DIM) {
        const vector = l2NormalizeV23(raw);
        this.cachePut(trimmed, vector, 'ollama');
        this.lastKind = 'ollama';
        return { ok: true, vector, kind: 'ollama' };
      }
    } catch (e) {
      // Roi xuong hash-embedder ben duoi, giu loi de ghi log.
      void e;
    }
    const vector = hashEmbedV23(trimmed, this.hashDim);
    this.cachePut(trimmed, vector, 'hash');
    this.lastKind = 'hash';
    return { ok: true, vector, kind: 'hash' };
  }

  /** Embed hang loat (ghi nhan tung cai, khong dung ca batch khi 1 loi). */
  async embedBatch(texts: string[]): Promise<V23EmbedResult[]> {
    const out: V23EmbedResult[] = [];
    for (const text of texts) out.push(await this.embed(text));
    return out;
  }

  /**
   * Embed truc tiep bang hash (khong cham Ollama) — dung khi caller
   * biet chac muon offline / test xac dinh.
   */
  embedHashOnly(text: string): V23EmbedResult {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, kind: 'none', error: 'Text rong, khong embed duoc.' };
    const cached = this.cache.get(trimmed);
    if (cached && cached.kind === 'hash') {
      return { ok: true, vector: [...cached.vector], kind: 'hash' };
    }
    const vector = hashEmbedV23(trimmed, this.hashDim);
    this.cachePut(trimmed, vector, 'hash');
    this.lastKind = 'hash';
    return { ok: true, vector, kind: 'hash' };
  }
}
