/**
 * Contamination-free eval runner (v1.04, Team T6).
 *
 * Vấn đề: nếu task/test lọt vào context của agent (qua file setup,
 * prompt, memory, hay training data của model), điểm eval đo trí nhớ
 * chứ không đo năng lực. Audit của OpenAI (2/2026) cho thấy ngay cả
 * SWE-bench Verified cũng có bằng chứng training exposure — nên mọi
 * eval nghiêm túc đều cần lớp phòng thủ contamination.
 *
 * Ba lớp phòng thủ của module này (xem docs/repo-survey-v104.md):
 *
 * 1. **Tách vật lý (hash registry)**: `EvalHashRegistry` chỉ lưu
 *    SHA-256 của từng eval item (n-gram hash), không lưu nội dung
 *    eval. `checkLeak` hash n-gram của context rồi so với registry —
 *    phát hiện rò rỉ mà không cần giữ bản eval gốc trong bộ nhớ chạy.
 * 2. **Phát hiện rò rỉ bằng n-gram overlap**: `scanContamination`
 *    so n-gram từ giữa eval material và context/training excerpts;
 *    overlap trên ngưỡng → `suspect`/`contaminated`, task bị loại
 *    khỏi aggregate (caller quyết định theo verdict).
 * 3. **Redaction trước khi chạy**: `stripEvalMaterial` quét context,
 *    thay các dòng trùng eval material bằng placeholder trước khi đưa
 *    cho agent.
 *
 * Giới hạn trung thực (ghi rõ, không giấu):
 * - N-gram overlap bắt được copy gần-nguyên văn, KHÔNG bắt được
 *   paraphrase hay kiến thức đã "học thuộc" theo nghĩa khác.
 * - Hash chỉ phát hiện rò rỉ khi có bản eval gốc để hash.
 * - Không có phương pháp nào chứng minh được "100%
 *   contamination-free" — report luôn ghi phương pháp + ngưỡng để
 *   người đọc tự đánh giá.
 */

import * as crypto from 'node:crypto';

/** Ngưỡng mặc định: n-gram từ, độ dài n-gram, tỉ lệ overlap. */
export const DEFAULT_CONTAMINATION_NGRAM_SIZE = 8;
export const DEFAULT_CONTAMINATION_SUSPECT_THRESHOLD = 0.05;
export const DEFAULT_CONTAMINATION_CONTAMINATED_THRESHOLD = 0.2;
/** Số n-gram trùng tối đa liệt kê trong report (để report không phình). */
export const CONTAMINATION_MAX_MATCHES_LISTED = 20;

/** Verdict của một lần scan. */
export type ContaminationVerdict = 'clean' | 'suspect' | 'contaminated';

export interface ContaminationScanOptions {
  /** Độ dài n-gram từ (mặc định 8). */
  ngramSize?: number;
  /** Tỉ lệ overlap >= ngưỡng này → suspect (mặc định 0.05). */
  suspectThreshold?: number;
  /** Tỉ lệ overlap >= ngưỡng này → contaminated (mặc định 0.2). */
  contaminatedThreshold?: number;
}

/** Kết quả scan một cặp (eval material, context). */
export interface ContaminationScanResult {
  verdict: ContaminationVerdict;
  /** Tỉ lệ n-gram của eval material xuất hiện trong context (0..1). */
  overlapRatio: number;
  /** Số n-gram riêng biệt của eval material. */
  evalNgramCount: number;
  /** Số n-gram của eval material tìm thấy trong context. */
  matchedNgramCount: number;
  /** Một số n-gram trùng (để con người kiểm chứng bằng mắt). */
  matchedNgrams: string[];
  ngramSize: number;
  suspectThreshold: number;
  contaminatedThreshold: number;
}

/** Chuẩn hóa text trước khi tách n-gram: lowercase, gộp whitespace, bỏ dấu câu. */
export function normalizeTextForContamination(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`~!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tách text thành danh sách từ (sau chuẩn hóa). */
export function tokenizeForContamination(text: string): string[] {
  const normalized = normalizeTextForContamination(text);
  if (normalized.length === 0) return [];
  return normalized.split(' ');
}

/** Tạo set n-gram (chuỗi các từ nối bằng space) từ text. */
export function ngramsOf(text: string, n: number): Set<string> {
  if (!Number.isInteger(n) || n < 1) throw new Error('ngram size must be a positive integer.');
  const tokens = tokenizeForContamination(text);
  const out = new Set<string>();
  if (tokens.length < n) return out;
  for (let i = 0; i + n <= tokens.length; i++) {
    out.add(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

/** Hash SHA-256 hex của một chuỗi. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Scan contamination: so n-gram của eval material với context.
 * overlapRatio = matched / evalNgrams (tỉ lệ eval material đã "lộ").
 * Eval material rỗng hoặc ngắn hơn n-gram → không đủ dữ kiện, verdict
 * clean với overlap 0 (ghi rõ trong matchedNgramCount = 0).
 */
export function scanContamination(
  evalMaterial: string,
  contextText: string,
  options: ContaminationScanOptions = {},
): ContaminationScanResult {
  const n = options.ngramSize ?? DEFAULT_CONTAMINATION_NGRAM_SIZE;
  const suspectAt = options.suspectThreshold ?? DEFAULT_CONTAMINATION_SUSPECT_THRESHOLD;
  const contaminatedAt = options.contaminatedThreshold ?? DEFAULT_CONTAMINATION_CONTAMINATED_THRESHOLD;
  if (!Number.isInteger(n) || n < 1) throw new Error('ngram size must be a positive integer.');
  if (!(suspectAt >= 0 && suspectAt <= 1)) throw new Error('suspectThreshold must be between 0 and 1.');
  if (!(contaminatedAt >= 0 && contaminatedAt <= 1)) throw new Error('contaminatedThreshold must be between 0 and 1.');
  if (contaminatedAt < suspectAt) throw new Error('contaminatedThreshold must be >= suspectThreshold.');
  const evalNgrams = ngramsOf(evalMaterial, n);
  const contextNgrams = ngramsOf(contextText, n);
  const matched: string[] = [];
  for (const gram of evalNgrams) {
    if (contextNgrams.has(gram)) matched.push(gram);
  }
  const overlapRatio = evalNgrams.size === 0 ? 0 : matched.length / evalNgrams.size;
  const verdict: ContaminationVerdict =
    overlapRatio >= contaminatedAt ? 'contaminated' : overlapRatio >= suspectAt ? 'suspect' : 'clean';
  return {
    verdict,
    overlapRatio,
    evalNgramCount: evalNgrams.size,
    matchedNgramCount: matched.length,
    matchedNgrams: matched.slice(0, CONTAMINATION_MAX_MATCHES_LISTED),
    ngramSize: n,
    suspectThreshold: suspectAt,
    contaminatedThreshold: contaminatedAt,
  };
}

/**
 * Scan nhiều context cùng lúc (vd nhiều file training excerpt):
 * trả về verdict xấu nhất + chi tiết từng context.
 */
export function scanContaminationMany(
  evalMaterial: string,
  contexts: Array<{ id: string; text: string }>,
  options: ContaminationScanOptions = {},
): { worst: ContaminationVerdict; worstOverlapRatio: number; perContext: Array<{ id: string; result: ContaminationScanResult }> } {
  const perContext = contexts.map((ctx) => ({ id: ctx.id, result: scanContamination(evalMaterial, ctx.text, options) }));
  const rank: Record<ContaminationVerdict, number> = { clean: 0, suspect: 1, contaminated: 2 };
  let worst: ContaminationVerdict = 'clean';
  let worstOverlapRatio = 0;
  for (const { result } of perContext) {
    if (rank[result.verdict] > rank[worst]) worst = result.verdict;
    worstOverlapRatio = Math.max(worstOverlapRatio, result.overlapRatio);
  }
  return { worst, worstOverlapRatio, perContext };
}

/**
 * Hash registry: chỉ lưu hash của eval item, không lưu nội dung.
 * Dùng khi eval data phải tách khỏi nơi chạy (vd log/report công khai):
 * hash n-gram của eval material lúc đăng ký, rồi `checkLeak` hash
 * n-gram của context để so — phát hiện rò rỉ mà không cần giữ bản gốc.
 */
export class EvalHashRegistry {
  private readonly hashes = new Set<string>();
  private readonly n: number;

  constructor(ngramSize: number = DEFAULT_CONTAMINATION_NGRAM_SIZE) {
    if (!Number.isInteger(ngramSize) || ngramSize < 1) throw new Error('ngram size must be a positive integer.');
    this.n = ngramSize;
  }

  get ngramSize(): number {
    return this.n;
  }

  /** Số hash đã đăng ký. */
  get size(): number {
    return this.hashes.size;
  }

  /** Đăng ký một eval item: hash toàn bộ n-gram của nó. Trả về số n-gram mới. */
  register(evalMaterial: string): number {
    let added = 0;
    for (const gram of ngramsOf(evalMaterial, this.n)) {
      const hash = sha256Hex(gram);
      if (!this.hashes.has(hash)) {
        this.hashes.add(hash);
        added += 1;
      }
    }
    return added;
  }

  /** Đăng ký nhiều eval item cùng lúc. */
  registerMany(materials: string[]): number {
    return materials.reduce((sum, m) => sum + this.register(m), 0);
  }

  /** True khi một n-gram cụ thể nằm trong registry (đã đăng ký). */
  hasNgram(gram: string): boolean {
    return this.hashes.has(sha256Hex(normalizeTextForContamination(gram)));
  }

  /**
   * Kiểm tra rò rỉ: hash n-gram của context, đếm bao nhiêu trùng
   * registry. Trả về tỉ lệ trùng trên tổng n-gram của context
   * (context càng dài, tỉ lệ càng nhỏ — đọc cùng matchedNgramCount).
   */
  checkLeak(contextText: string): { matchedNgramCount: number; contextNgramCount: number; leakRatio: number; leaked: boolean } {
    const grams = ngramsOf(contextText, this.n);
    let matched = 0;
    for (const gram of grams) {
      if (this.hashes.has(sha256Hex(gram))) matched += 1;
    }
    return {
      matchedNgramCount: matched,
      contextNgramCount: grams.size,
      leakRatio: grams.size === 0 ? 0 : matched / grams.size,
      leaked: matched > 0,
    };
  }

  /** Xuất registry thành JSON (chỉ hash, không có nội dung eval). */
  toJSON(): { ngramSize: number; hashes: string[] } {
    return { ngramSize: this.n, hashes: [...this.hashes].sort() };
  }

  /** Nạp registry từ JSON đã xuất (chỉ nhận hash hex 64 ký tự). */
  static fromJSON(raw: unknown): EvalHashRegistry {
    if (!isRecord(raw)) throw new Error('eval hash registry JSON must be an object.');
    const { ngramSize, hashes } = raw;
    if (!Number.isInteger(ngramSize) || (ngramSize as number) < 1) throw new Error('eval hash registry needs a positive integer ngramSize.');
    if (!Array.isArray(hashes) || hashes.some((h) => typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h))) {
      throw new Error('eval hash registry hashes must be an array of SHA-256 hex strings.');
    }
    const registry = new EvalHashRegistry(ngramSize as number);
    for (const hash of hashes as string[]) registry.hashes.add(hash);
    return registry;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Redaction: quét context theo từng dòng, thay dòng nào chứa một
 * n-gram trùng eval material bằng placeholder. Dòng không trùng giữ
 * nguyên. Trả về text đã redacted + số dòng đã thay + số n-gram trùng
 * tìm thấy (để report).
 *
 * Lưu ý: redaction theo dòng là heuristic — n-gram trùng có thể nằm
 * vắt qua hai dòng (không bắt được) hoặc trùng tình cờ (redact thừa).
 * Report luôn ghi số dòng đã thay để người đọc tự đánh giá.
 */
export function stripEvalMaterial(
  contextText: string,
  evalMaterials: string[],
  options: ContaminationScanOptions & { placeholder?: string } = {},
): { redacted: string; redactedLines: number; matchedNgramCount: number } {
  const n = options.ngramSize ?? DEFAULT_CONTAMINATION_NGRAM_SIZE;
  const placeholder = options.placeholder ?? '[EVAL MATERIAL REDACTED]';
  const evalNgrams = new Set<string>();
  for (const material of evalMaterials) {
    for (const gram of ngramsOf(material, n)) evalNgrams.add(gram);
  }
  if (evalNgrams.size === 0) {
    return { redacted: contextText, redactedLines: 0, matchedNgramCount: 0 };
  }
  let redactedLines = 0;
  let matchedNgramCount = 0;
  const lines = contextText.split('\n').map((line) => {
    const grams = ngramsOf(line, n);
    let hit = false;
    for (const gram of grams) {
      if (evalNgrams.has(gram)) {
        hit = true;
        matchedNgramCount += 1;
      }
    }
    if (hit) {
      redactedLines += 1;
      return placeholder;
    }
    return line;
  });
  return { redacted: lines.join('\n'), redactedLines, matchedNgramCount };
}

/** Báo cáo contamination cho một task eval (dùng trong suite report). */
export interface ContaminationTaskReport {
  taskId: string;
  verdict: ContaminationVerdict;
  overlapRatio: number;
  matchedNgramCount: number;
  /** Ghi rõ phương pháp để người đọc tự đánh giá. */
  method: string;
}

/** Tạo report task từ kết quả scan. */
export function contaminationTaskReport(taskId: string, scan: ContaminationScanResult): ContaminationTaskReport {
  return {
    taskId,
    verdict: scan.verdict,
    overlapRatio: scan.overlapRatio,
    matchedNgramCount: scan.matchedNgramCount,
    method: `word ${scan.ngramSize}-gram overlap vs context (suspect >= ${scan.suspectThreshold}, contaminated >= ${scan.contaminatedThreshold}); catches near-verbatim copies only, not paraphrase.`,
  };
}
