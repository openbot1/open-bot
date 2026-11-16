/**
 * Memory v12 — token budget cho memory block (v1.12, Doi T1).
 *
 * Y tuong hoc tu Letta: moi memory block co gioi han TOKEN rieng
 * (khong chi gioi han ky tu), va tong cac block bien dich vao system
 * prompt phai nam trong mot ngan sach token chung — vuot thi cat bot
 * theo muc uu tien thay vi de prompt phi to vo han. Viet lai cho
 * open-bot tren MemoryBlockStore + block kind v11.
 *
 * Uoc luong token: DUNG LAI `estimateTokens` san co cua
 * `agent/tokens.ts` (da hieu chuan bang tiktoken `cl100k_base` tren
 * corpus that: sai so trung binh 2.6% — xem header file do). Module
 * nay KHONG dinh nghia lai cach dem token, chi them LOP CHINH SACH
 * tren no: gioi han token theo kind + bao cao muc day.
 *
 * Gioi han token theo kind duoc SUY TU gioi han ky tu v11
 * (`v11LimitForKind(kind) / 4`, chinh sach ngan sach) — khong dinh
 * nghia lai hang so moi, mot kind khong bao gio co gioi han token
 * lech voi gioi han ky tu cua chinh no. So token THUC TE do bang
 * `estimateTokens` (hieu chuan) nen co the vuot gioi han chinh sach
 * nay voi text tieng Viet/CJK — do la tin hieu de cat bot, khong phai
 * loi dem.
 */

import type { MemoryBlock } from '../blocks';
import { DEFAULT_BLOCK_CHAR_LIMIT } from '../blocks';
import { estimateTokens } from '../../agent/tokens';
import { detectBlockKind, v11LimitForKind } from '../v11/blockKinds';
import type { V11BlockKind } from '../v11/blockKinds';

/** Dem token — dung lai ham da hieu chuan cua agent/tokens.ts. */
export { estimateTokens };

/** So ky tu Latin uoc tinh cho mot token trong CHINH SACH gioi han (quy tac BPE). */
export const V12_CHARS_PER_TOKEN = 4;
/** Ngan sach token mac dinh cho TOAN BO block bien dich vao mot prompt. */
export const V12_DEFAULT_TOTAL_TOKEN_BUDGET = 4000;
/** Ngan sach token nho nhat cho phep cau hinh (de luon chua duoc 1 block nho). */
export const V12_MIN_TOTAL_TOKEN_BUDGET = 64;
/** Ngan sach token lon nhat cho phep cau hinh. */
export const V12_MAX_TOTAL_TOKEN_BUDGET = 128000;

/** true khi ky tu thuoc khoi CJK (Han / Hiragana / Katakana / Hangul). */
export function isCjkChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK Radicals .. CJK Unified
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0x31f0 && code <= 0x31ff) || // Katakana Phonetic Extensions
    (code >= 0xac00 && code <= 0xd7a3) // Hangul Syllables
  );
}

/** Gioi han token ap cho mot kind (suy tu gioi han ky tu v11 / 4). */
export function v12TokenLimitForKind(kind: V11BlockKind): number {
  const chars = v11LimitForKind(kind);
  return Math.max(1, Math.floor(chars / V12_CHARS_PER_TOKEN));
}

/** Gioi han token ap cho mot label (suy kind tu label roi lay gioi han). */
export function v12TokenLimitForLabel(label: string): number {
  return v12TokenLimitForKind(detectBlockKind(label));
}

/** Gioi han token ap cho mot block cu the (uu tien charLimit rieng neu co). */
export function v12TokenLimitForBlock(block: Pick<MemoryBlock, 'label' | 'charLimit'>): number {
  const byChars =
    block.charLimit > 0
      ? Math.max(1, Math.floor(block.charLimit / V12_CHARS_PER_TOKEN))
      : v12TokenLimitForLabel(block.label);
  return byChars;
}

/** Muc day token cua mot block (de UI/tool canh bao truoc khi day). */
export interface V12BlockTokenUsage {
  label: string;
  kind: V11BlockKind;
  chars: number;
  charLimit: number;
  tokens: number;
  tokenLimit: number;
  /** Ty le day token 0..1 (co the > 1 neu block legacy vuot gioi han moi). */
  fillRatio: number;
  /** 'ok' < 70%, 'warm' 70-90%, 'full' > 90% (giong v11BlockUsage). */
  state: 'ok' | 'warm' | 'full';
  /** true khi block vuot gioi han token cua kind (can cat bot khi compile). */
  overTokenLimit: boolean;
}

export function v12BlockTokenUsage(block: MemoryBlock): V12BlockTokenUsage {
  const kind = detectBlockKind(block.label);
  const tokens = estimateTokens(block.content);
  const tokenLimit = v12TokenLimitForBlock(block);
  const fillRatio = tokenLimit > 0 ? tokens / tokenLimit : 0;
  return {
    label: block.label,
    kind,
    chars: block.content.length,
    charLimit: block.charLimit > 0 ? block.charLimit : DEFAULT_BLOCK_CHAR_LIMIT,
    tokens,
    tokenLimit,
    fillRatio,
    state: fillRatio >= 0.9 ? 'full' : fillRatio >= 0.7 ? 'warm' : 'ok',
    overTokenLimit: tokens > tokenLimit,
  };
}

/** Tong hop token cua nhieu block (de bao cao truoc khi compile). */
export interface V12BlocksTokenSummary {
  blocks: V12BlockTokenUsage[];
  totalTokens: number;
  totalChars: number;
  /** Ngan sach truyen vao (neu co) — tong co vuot khong. */
  budget?: number;
  overBudget: boolean;
  /** So block vuot gioi han token rieng. */
  overLimitCount: number;
}

export function summarizeBlocksTokens(
  blocks: MemoryBlock[],
  totalBudget?: number,
): V12BlocksTokenSummary {
  const usages = blocks.map((b) => v12BlockTokenUsage(b));
  const totalTokens = usages.reduce((sum, u) => sum + u.tokens, 0);
  const totalChars = usages.reduce((sum, u) => sum + u.chars, 0);
  const budget =
    totalBudget !== undefined
      ? Math.min(
          V12_MAX_TOTAL_TOKEN_BUDGET,
          Math.max(V12_MIN_TOTAL_TOKEN_BUDGET, Math.floor(totalBudget)),
        )
      : undefined;
  return {
    blocks: usages,
    totalTokens,
    totalChars,
    ...(budget !== undefined ? { budget } : {}),
    overBudget: budget !== undefined ? totalTokens > budget : false,
    overLimitCount: usages.filter((u) => u.overTokenLimit).length,
  };
}
