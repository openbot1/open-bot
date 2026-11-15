/**
 * Local hash embedding — embedding nội bộ, xác định, không cần model
 * (v1.10, Đội T1).
 *
 * Ý tưởng: retrieval v10 cần một tín hiệu vector, nhưng sóng này KHÔNG
 * được gọi API ngoài và không được giả định Ollama đang chạy. Module
 * này cho ra vector L2-chuẩn hoá bằng hàm băm xác định trên token:
 * cùng một text luôn cho cùng một vector, text giống nhau nhiều token
 * thì vector gần nhau (cosine cao). Đây là MOCK có chủ đích, đủ để
 * retrieval 3 tín hiệu chạy end-to-end offline và test được; khi
 * Ollama khả dụng, MemoryManagerV10 chấp nhận bất kỳ Embedder nào
 * (xem memory/embeddings.ts) thay cho embedder này mà không đổi API.
 *
 * Cách làm: token hoá như BM25 (chuẩn hoá, bỏ dấu), mỗi token băm
 * FNV-1a 32-bit rồi gieo một LCG để cộng/trừ vào 4 vị trí giả-ngẫu
 * nhiên trong vector — hai token khác nhau gần như không bao giờ
 * chạm cùng vị trí với cùng dấu, nên vector của câu là tổng có dấu
 * của các token, tương tự "hashing trick" trong ML cổ điển. Cuối
 * cùng chuẩn hoá L2 để cosine = tích vô hướng.
 */

import { normalizeV10Text } from './types';

export const LOCAL_EMBED_DIMS = 128;

/** FNV-1a 32-bit — băm nhanh, phân tán tốt cho token ngắn. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** LCG 32-bit: cho ra dãy giả-ngẫu nhiên xác định từ một seed. */
function lcgNext(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

/** Tách text thành token đã chuẩn hoá (cùng quy tắc BM25). */
export function localEmbedTokens(text: string): string[] {
  return normalizeV10Text(text)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Embedder hash-local: `embed` là hàm đồng bộ về bản chất nhưng giữ
 * chữ ký async để khớp interface Embedder của core (OllamaEmbeddings).
 */
export class LocalHashEmbedder {
  readonly name = 'local-hash-v10';
  readonly dims: number;

  constructor(dims: number = LOCAL_EMBED_DIMS) {
    if (!Number.isInteger(dims) || dims < 16 || dims > 1024) {
      throw new Error(`LocalHashEmbedder dims must be an integer in [16, 1024], got ${dims}`);
    }
    this.dims = dims;
  }

  /** Vector L2-chuẩn hoá của một text (rỗng → vector 0). */
  embedSync(text: string): number[] {
    const vec = new Array<number>(this.dims).fill(0);
    const tokens = localEmbedTokens(text);
    for (const token of tokens) {
      // Mỗi token đóng góp vào 4 vị trí: vị trí + dấu đều suy ra từ
      // băm của token nên xác định hoàn toàn, không cần bảng tra.
      let state = fnv1a32(token);
      for (let k = 0; k < 4; k++) {
        state = lcgNext(state);
        const idx = state % this.dims;
        state = lcgNext(state);
        const sign = state % 2 === 0 ? 1 : -1;
        state = lcgNext(state);
        const weight = 0.5 + (state % 1000) / 2000;
        vec[idx] += sign * weight;
      }
    }
    return l2Normalize(vec);
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedSync(t));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Chuẩn hoá L2 — vector 0 giữ nguyên 0 (tránh chia cho 0). */
export function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec.slice();
  return vec.map((v) => v / norm);
}

/** Cosine similarity giữa hai vector đã (hoặc chưa) chuẩn hoá.
 *  Trả 0 khi một trong hai là vector 0. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Embedder hash-local dùng chung (singleton cho test/tool). */
export const defaultLocalEmbedder = new LocalHashEmbedder();
