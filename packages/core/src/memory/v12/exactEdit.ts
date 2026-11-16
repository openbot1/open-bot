/**
 * Memory v12 — exact-string edit cho memory block (v1.12, Doi T1).
 *
 * Y tuong hoc tu Letta (`core_memory_replace` voi `old_str` /
 * `new_str`): agent tu sua block bang cach chi ra CHINH XAC doan
 * text can thay — khong can viet lai toan bo block, khong can nho
 * so dong. Viet lai hoan toan cho open-bot tren MemoryBlockStore —
 * KHONG goi model, KHONG doan mo.
 *
 * Quy tac cung (de agent khong sua nham cho khac):
 *  - `oldText` rong -> throw (khong co nghia).
 *  - Khong tim thay `oldText` -> throw (agent phai doc lai block truoc).
 *  - Tim thay NHIEU HON 1 cho ma khong chi ro `occurrence` (chi so
 *    0-based) -> throw, kem so lan xuat hien + vi tri cac lan dau
 *    (agent chon lai cho chinh xac hoac lam cho doan cu duy nhat).
 *  - Chi ro `occurrence` ngoai pham vi -> throw.
 *  - Thay the luon chi dung 1 lan xuat hien (khong replace-all len) —
 *    muon sua nhieu cho thi goi nhieu lan, moi lan deu ghi lich su.
 *
 * Ghi lich su: moi lan sua thanh cong di qua `store.replace()` nen
 * tu dong tang version + ghi audit (`replace`, actor truyen vao) +
 * snapshot version nhu moi thao tac sua khac. Block read-only hoac
 * block he thong (systemOwned, agent goi) bi chan ngay tai store
 * (xem `assertWritable` trong blocks.ts).
 */

import { MemoryBlockStore } from '../blocks';
import type { MemoryBlock } from '../blocks';
import { estimateTokens, v12TokenLimitForBlock } from './tokens';

/** Loi exact-string edit — message tieng Viet, tool tra thang cho agent. */
export class V12ExactEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V12ExactEditError';
  }
}

/** So vi tri toi da liet ke trong loi mo ho (de message khong phi dai). */
export const V12_EDIT_MAX_LISTED_OCCURRENCES = 10;

/** Tim moi vi tri xuat hien cua `oldText` trong `content` (khong chong lap). */
export function findExactOccurrences(content: string, oldText: string): number[] {
  if (oldText === '') {
    throw new V12ExactEditError('Đoạn text cần thay ("oldText") không được để trống.');
  }
  const haystack = content ?? '';
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(oldText, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + oldText.length;
    if (oldText.length === 0) break;
  }
  return out;
}

export interface ReplaceExactOptions {
  /**
   * Chi so 0-based cua lan xuat hien can thay. Bo qua -> yeu cau
   * `oldText` chi xuat hien dung 1 lan (nhieu hon thi throw mo ho).
   */
  occurrence?: number;
}

/**
 * Thay the MOT lan xuat hien cua `oldText` bang `newText` trong
 * `content` (thuan, khong ghi store). Tra noi dung moi + vi tri da thay.
 */
export function replaceExactString(
  content: string,
  oldText: string,
  newText: string,
  opts: ReplaceExactOptions = {},
): { content: string; replacedIndex: number; occurrences: number } {
  const occurrences = findExactOccurrences(content ?? '', oldText);
  if (occurrences.length === 0) {
    throw new V12ExactEditError(
      `Không tìm thấy đoạn text cần thay trong block (dài ${oldText.length} ký tự, bắt đầu bằng ${JSON.stringify(oldText.slice(0, 40))}). Đọc lại nội dung block rồi thử lại với đoạn text chính xác.`,
    );
  }
  let chosen: number;
  if (opts.occurrence !== undefined) {
    if (!Number.isInteger(opts.occurrence) || opts.occurrence < 0 || opts.occurrence >= occurrences.length) {
      throw new V12ExactEditError(
        `occurrence=${opts.occurrence} ngoài phạm vi: đoạn text xuất hiện ${occurrences.length} lần (occurrence hợp lệ 0..${occurrences.length - 1}).`,
      );
    }
    chosen = opts.occurrence;
  } else if (occurrences.length > 1) {
    const listed = occurrences
      .slice(0, V12_EDIT_MAX_LISTED_OCCURRENCES)
      .map((pos, i) => `#${i} tại ký tự ${pos}`)
      .join(', ');
    const more =
      occurrences.length > V12_EDIT_MAX_LISTED_OCCURRENCES
        ? ` (và ${occurrences.length - V12_EDIT_MAX_LISTED_OCCURRENCES} vị trí khác)`
        : '';
    throw new V12ExactEditError(
      `Đoạn text xuất hiện ${occurrences.length} lần, không rõ cần thay lần nào (${listed}${more}). Truyền "occurrence" (0-based) để chọn, hoặc làm cho đoạn text duy nhất bằng cách thêm ngữ cảnh xung quanh.`,
    );
  } else {
    chosen = 0;
  }
  const at = occurrences[chosen];
  const next =
    (content ?? '').slice(0, at) + (newText ?? '') + (content ?? '').slice(at + oldText.length);
  return { content: next, replacedIndex: at, occurrences: occurrences.length };
}

/**
 * Xem truoc mot lan sua (khong ghi store): tra noi dung sau khi sua
 * + so lan xuat hien + vi tri se thay. Dung cho UI/tool kiem tra
 * truoc khi goi sua that.
 */
export function previewExactEdit(
  content: string,
  oldText: string,
  newText: string,
  opts: ReplaceExactOptions = {},
): { content: string; replacedIndex: number; occurrences: number } {
  return replaceExactString(content, oldText, newText, opts);
}

export interface ApplyExactEditOptions extends ReplaceExactOptions {
  /** Gioi han token cung them (mac dinh = gioi han token cua kind/block). */
  maxTokens?: number;
}

export interface ApplyExactEditResult {
  block: MemoryBlock;
  replacedIndex: number;
  occurrences: number;
  tokensBefore: number;
  tokensAfter: number;
  tokenLimit: number;
}

/**
 * Sua mot block bang exact-string edit (ghi that vao store).
 *
 * Thu tu kiem tra: ton tai block -> read-only / block he thong (store
 * chan, actor `agent:*` khong sua duoc block he thong) -> tim doan
 * cu -> gioi han ky tu (store.replace chan) -> gioi han token cua
 * block -> ghi (version +1, audit `replace`, snapshot lich su).
 */
export function applyExactEditToBlock(
  store: MemoryBlockStore,
  idOrLabel: string,
  oldText: string,
  newText: string,
  actor = 'user',
  opts: ApplyExactEditOptions = {},
): ApplyExactEditResult {
  const before = store.get(idOrLabel);
  if (!before) {
    throw new V12ExactEditError(`Không tìm thấy memory block "${idOrLabel}".`);
  }
  if (typeof newText !== 'string') {
    throw new V12ExactEditError('Đoạn text mới ("newText") phải là chuỗi.');
  }
  const tokensBefore = estimateTokens(before.content);
  const tokenLimit =
    opts.maxTokens !== undefined && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
      ? Math.floor(opts.maxTokens)
      : v12TokenLimitForBlock(before);
  const { content: next, replacedIndex, occurrences } = replaceExactString(
    before.content,
    oldText,
    newText,
    { occurrence: opts.occurrence },
  );
  if (next === before.content) {
    return {
      block: { ...before },
      replacedIndex,
      occurrences,
      tokensBefore,
      tokensAfter: tokensBefore,
      tokenLimit,
    };
  }
  const tokensAfter = estimateTokens(next);
  if (tokensAfter > tokenLimit) {
    throw new V12ExactEditError(
      `Sau khi sửa, block "${before.label}" sẽ dài ~${tokensAfter} token, vượt giới hạn ${tokenLimit} token của block. Rút ngắn đoạn mới hoặc tách nội dung sang block khác.`,
    );
  }
  // store.replace() tu chan read-only / block he thong + vuot charLimit,
  // dong thoi tang version, ghi audit va snapshot lich su.
  const block = store.replace(idOrLabel, next, actor);
  return { block, replacedIndex, occurrences, tokensBefore, tokensAfter, tokenLimit };
}
