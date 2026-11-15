/**
 * Memory v9 kiểu Letta — cô đọng trích xuất (v1.09, Đội T2).
 *
 * Ý tưởng học từ Letta/MemGPT: khi core memory đầy, agent KHÔNG được
 * append vô hạn mà phải tự cô đọng (summarize + ghi đè). Module này là
 * bộ cô đọng chạy 100% local, không gọi model, không mạng:
 *
 *  - Tách nội dung thành câu (tách theo dấu kết câu + dòng mới).
 *  - Chấm điểm câu theo tần suất từ khoá nội dung, vị trí, độ dài.
 *  - Loại câu gần trùng nhau (Jaccard trên tập từ, ngưỡng 0.7) để
 *    dọn trùng lặp trước khi cô đọng — cùng một bước với sleep-time
 *    consolidation.
 *  - Ghép các câu điểm cao nhất cho tới khi vừa giới hạn ký tự đích,
 *    giữ đúng thứ tự xuất hiện ban đầu (đọc vẫn xuôi).
 *
 * Cô đọng trích xuất KHÔNG bịa thêm chữ nào: mọi câu trong bản cô đọng
 * đều có sẵn trong nội dung gốc. Khi nội dung gốc quá ngắn hoặc chỉ
 * có một câu thì trả nguyên văn (không làm mất thông tin).
 *
 * Không I/O, không phụ thuộc ngoài — dùng được cả trong core, trong
 * sleep pass và trong tool.
 */

/** Từ dừng tiếng Việt + tiếng Anh (bỏ qua khi chấm điểm từ khoá). */
const STOPWORDS = new Set([
  // tiếng Việt
  'là', 'của', 'và', 'với', 'cho', 'đã', 'đang', 'sẽ', 'có', 'không',
  'một', 'các', 'những', 'này', 'đó', 'kia', 'thì', 'mà', 'nhưng',
  'nên', 'để', 'khi', 'nếu', 'rất', 'cũng', 'được', 'bị', 'về', 'từ',
  'trong', 'ngoài', 'trên', 'dưới', 'tôi', 'bạn', 'anh', 'chị', 'em',
  'họ', 'chúng', 'ta', 'mình', 'nó', 'ai', 'gì', 'nào', 'sao', 'như',
  'lại', 'vẫn', 'chỉ', 'mới', 'đều', 'cả', 'mỗi', 'từng', 'hay',
  'hoặc', 'vì', 'do', 'tại', 'theo', 'sau', 'trước', 'giữa', 'cùng',
  'hơn', 'nhất', 'quá', 'lắm', 'thật', 'ngay', 'luôn', 'hãy', 'đừng',
  // tiếng Anh
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we',
  'they', 'my', 'your', 'his', 'her', 'our', 'their', 'as', 'by',
  'from', 'not', 'no', 'so', 'if', 'when', 'then', 'than', 'too',
  'very', 'can', 'could', 'will', 'would', 'should', 'have', 'has',
  'had', 'do', 'does', 'did', 'am', 'an',
]);

/** Ngưỡng Jaccard: hai câu giống nhau trên mức này thì coi là trùng. */
export const CONDENSE_DUPLICATE_JACCARD = 0.7;
/** Câu ngắn hơn mức này (ký tự) gần như không mang thông tin riêng. */
export const CONDENSE_MIN_SENTENCE_CHARS = 8;
/** Câu dài hơn mức này bị trừ điểm (thường là liệt kê dài / log). */
export const CONDENSE_LONG_SENTENCE_CHARS = 400;

/** Một câu đã tách + tập từ nội dung của nó (để chấm điểm + so trùng). */
export interface CondensableSentence {
  text: string;
  words: Set<string>;
  index: number;
}

/**
 * Tách từ: chữ thường, bỏ dấu câu, bỏ từ dừng, bỏ từ 1 ký tự.
 * Giữ nguyên tiếng Việt có dấu (không strip dấu) để khỏi lẫn nghĩa.
 */
export function condenseWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z0-9à-ỹđ]+/u)) {
    const w = raw.trim();
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

/**
 * Tách nội dung thành câu. Tách theo dòng mới trước (mỗi dòng là một
 * "câu" ứng viên — phù hợp block memory vốn viết theo dòng fact), rồi
 * tách tiếp theo dấu kết câu (. ! ? …) khi một dòng chứa nhiều câu.
 * Câu quá ngắn bị gộp vào câu trước để khỏi vỡ vụn.
 */
export function splitSentences(content: string): CondensableSentence[] {
  const rawLines = (content ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const sentences: CondensableSentence[] = [];
  let index = 0;
  const push = (text: string) => {
    const t = text.trim();
    if (t === '') return;
    sentences.push({ text: t, words: condenseWords(t), index: index++ });
  };
  for (const line of rawLines) {
    // Dòng dạng "- fact" / "* fact" / "1. fact": giữ nguyên cả dòng.
    const parts = line.split(/(?<=[.!?…])\s+(?=[A-ZÀ-ỸĐ0-9"-])/u);
    if (parts.length === 1) {
      push(line);
      continue;
    }
    for (const part of parts) push(part);
  }
  // Gộp câu quá ngắn vào câu trước (trừ câu đầu tiên).
  const merged: CondensableSentence[] = [];
  for (const s of sentences) {
    if (s.text.length < CONDENSE_MIN_SENTENCE_CHARS && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.text = `${prev.text} ${s.text}`;
      prev.words = condenseWords(prev.text);
    } else {
      merged.push({ ...s, words: new Set(s.words) });
    }
  }
  return merged.map((s, i) => ({ ...s, index: i }));
}

/** Jaccard giữa hai tập từ (0..1) — dùng lại hàm của v3/tfidf (cùng ngữ nghĩa). */
import { jaccardSimilarity } from '../v3/tfidf';
export { jaccardSimilarity };

/**
 * Loại câu gần trùng: duyệt theo thứ tự xuất hiện, câu nào giống một
 * câu đã giữ (Jaccard >= ngưỡng) thì bỏ. Trả về danh sách đã lọc +
 * số câu đã bỏ (để sleep log / báo cáo).
 */
export function dedupeSentences(
  sentences: CondensableSentence[],
  threshold = CONDENSE_DUPLICATE_JACCARD,
): { kept: CondensableSentence[]; removed: number } {
  const kept: CondensableSentence[] = [];
  let removed = 0;
  for (const s of sentences) {
    const dup = kept.some((k) => jaccardSimilarity(s.words, k.words) >= threshold);
    if (dup) removed += 1;
    else kept.push(s);
  }
  return { kept, removed };
}

/** Tần suất từ trong toàn bộ nội dung (đếm trên câu, không đếm lặp trong câu). */
function wordDocumentFrequency(sentences: CondensableSentence[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const s of sentences) {
    for (const w of s.words) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return freq;
}

/**
 * Chấm điểm một câu:
 *  - tổng tần suất từ nội dung của nó (từ xuất hiện nhiều = chủ đề chính),
 *  - cộng điểm vị trí: câu đầu/cuối đoạn được ưu tiên nhẹ,
 *  - trừ điểm câu quá dài (thường là liệt kê) và câu ít từ nội dung.
 */
export function scoreSentence(
  sentence: CondensableSentence,
  freq: Map<string, number>,
  total: number,
): number {
  let score = 0;
  for (const w of sentence.words) score += freq.get(w) ?? 0;
  // Chuẩn hoá theo số từ để câu dài không thắng chỉ vì nhiều từ.
  const denom = Math.max(1, sentence.words.size);
  score = score / denom;
  // Ưu tiên nhẹ câu mở đầu và câu kết.
  if (sentence.index === 0) score += 0.5;
  if (sentence.index === total - 1) score += 0.3;
  // Câu quá dài: trừ dần.
  if (sentence.text.length > CONDENSE_LONG_SENTENCE_CHARS) score -= 0.5;
  // Câu gần như không có từ nội dung: về 0.
  if (sentence.words.size === 0) score = 0;
  return score;
}

/** Kết quả một lần cô đọng. */
export interface CondenseResult {
  /** Nội dung đã cô đọng (các câu gốc, giữ thứ tự ban đầu). */
  text: string;
  /** Số ký tự gốc / sau cô đọng. */
  originalChars: number;
  condensedChars: number;
  /** Số câu gốc / số câu giữ lại. */
  originalSentences: number;
  keptSentences: number;
  /** Số câu trùng đã loại trong bước dedupe. */
  duplicatesRemoved: number;
  /** true = đã phải cắt bớt (bản cô đọng ngắn hơn gốc). */
  condensed: boolean;
}

/**
 * Cô đọng nội dung về tối đa `targetChars` ký tự.
 *
 *  - Nếu nội dung đã vừa giới hạn: chỉ dedupe (loại câu trùng), giữ
 *    nguyên thứ tự, không cắt câu nào.
 *  - Nếu vượt giới hạn: dedupe rồi chọn câu điểm cao nhất cho tới khi
 *    vừa giới hạn (luôn giữ ít nhất một câu), ghép theo thứ tự gốc.
 *  - `targetChars <= 0` -> trả chuỗi rỗng.
 */
export function condenseText(content: string, targetChars: number): CondenseResult {
  const originalChars = (content ?? '').length;
  const empty: CondenseResult = {
    text: '',
    originalChars,
    condensedChars: 0,
    originalSentences: 0,
    keptSentences: 0,
    duplicatesRemoved: 0,
    condensed: originalChars > 0,
  };
  if (targetChars <= 0) return empty;
  const sentences = splitSentences(content ?? '');
  if (sentences.length === 0) return { ...empty, condensed: false };
  const { kept, removed } = dedupeSentences(sentences);
  const dedupedText = kept.map((s) => s.text).join('\n');
  const base: CondenseResult = {
    text: dedupedText,
    originalChars,
    condensedChars: dedupedText.length,
    originalSentences: sentences.length,
    keptSentences: kept.length,
    duplicatesRemoved: removed,
    condensed: dedupedText.length < originalChars,
  };
  if (dedupedText.length <= targetChars) return base;
  // Cần cắt: chấm điểm, lấy câu tốt nhất cho tới khi vừa giới hạn.
  const freq = wordDocumentFrequency(kept);
  const scored = kept
    .map((s) => ({ s, score: scoreSentence(s, freq, kept.length) }))
    .sort((a, b) => b.score - a.score || a.s.index - b.s.index);
  const chosen = new Set<number>();
  let chars = 0;
  for (const { s } of scored) {
    const add = (chosen.size === 0 ? 0 : 1) + s.text.length;
    if (chosen.size > 0 && chars + add > targetChars) continue;
    chosen.add(s.index);
    chars += add;
    if (chars >= targetChars) break;
  }
  // Luôn giữ ít nhất câu điểm cao nhất (dù nó dài hơn target thì cắt
  // cứng ở target, không trả rỗng).
  if (chosen.size === 0 && scored.length > 0) {
    chosen.add(scored[0].s.index);
  }
  const finalSentences = kept.filter((s) => chosen.has(s.index));
  let text = finalSentences.map((s) => s.text).join('\n');
  if (text.length > targetChars) {
    text = text.slice(0, Math.max(0, targetChars - 1)).trimEnd() + '…';
  }
  return {
    text,
    originalChars,
    condensedChars: text.length,
    originalSentences: sentences.length,
    keptSentences: finalSentences.length,
    duplicatesRemoved: removed,
    condensed: true,
  };
}

/**
 * Cô đọng một block về đúng giới hạn của nó (mặc định chừa 10% trống
 * để lần append sau còn chỗ). Trả về CondenseResult để caller ghi đè.
 */
export function condenseBlockToLimit(content: string, charLimit: number): CondenseResult {
  const target = Math.max(0, Math.floor(charLimit * 0.9));
  return condenseText(content, target);
}
