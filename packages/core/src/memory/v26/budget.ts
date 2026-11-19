/**
 * Memory v26 — block budget + curation (v1.41, Doi T1).
 *
 * Y tuong hoc tu Letta (survey v141 muc 2, chi y tuong): core
 * memory co gioi han token moi block — agent buoc phai curate
 * (tom tat, bo phan thua) thay vi tich tru vo han. Cai dat o
 * day chay 100% local, khong goi model:
 *  - Token estimate: ky tu / 4 (ghi ro la estimate).
 *  - `summarise()`: trich xuat (extractive) — tach value thanh
 *    cac y (dong/bullet/cau), cho diem moi y theo: tu khoa lap
 *    lai trong block, heading/bullet quan trong, vi tri dau/cuoi,
 *    do dai vua phai; giu y diem cao nhat trong ngan sach token
 *    dich, giu nguyen thu tu goc; heading luon duoc uu tien giu.
 *  - `curateBlock()`: khi block vuot budget thi summarise roi
 *    ghi lai (tao version moi + audit 'curate'); phan bi bo
 *    khong mat — pipeline dua vao archival dang 'curated-out'.
 *  - Prompt budget: chia ngan sach token tong cho nhieu block
 *    theo thu tu uu tien (human/persona truoc), cat ngan block
 *    thua thay vi bo ca block.
 *
 * Gioi han that: summarise trich xuat khong hieu ngu nghia sau
 * nhu LLM — no giu cau goc, khong viet lai; voi text lap lai
 * nhieu y tuong tu nhau, diem co the chon y thua. Test bao ve
 * cac tinh chat: khong vuot target, giu heading, giu tu khoa
 * quan trong, thu tu goc duoc bao toan.
 */
import {
  dayKeyV26,
  estimateTokensV26,
  normalizeTextV26,
  tokenizeV26,
  truncateV26,
  validateBudgetV26,
  type V26BlockBudget,
  type V26BudgetStatus,
  type V26CurateReport,
  type V26PromptBlock,
  type V26PromptSnapshot,
  type V26Result,
  type V26SummariseResult,
  type V26SummaryItem,
} from './types';
import { errV26, okV26 } from './types';

/** Tu dung (stopwords) tieng Viet + tieng Anh bo qua khi tinh tu khoa. */
const STOPWORDS_V26 = new Set([
  'va', 'cua', 'la', 'cac', 'mot', 'nhung', 'voi', 'cho', 'khi', 'neu', 'thi', 'de', 'da', 'se', 'co', 'khong',
  'duoc', 'này', 'nay', 'do', 'do', 'the', 'and', 'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'was', 'were',
  'for', 'with', 'on', 'at', 'by', 'it', 'this', 'that', 'from', 'as', 'be', 'have', 'has', 'not', 'but', 'or',
]);

/**
 * Tach text thanh cac y (unit) de summarise.
 *
 * Thu tu uu tien tach:
 *  1. Dong co dau bullet/number (`-`, `*`, `1.`) => 1 y moi dong.
 *  2. Dong heading (`# ...`) => 1 y (luon uu tien giu).
 *  3. Doan van dai: tach thanh cau theo dau `.`/`!`/`?` + khoang trang.
 *  4. Dong ngan con lai: 1 y moi dong.
 * Dong trong bi bo. Moi y giu lai chi so dong goc de sap lai
 * dung thu tu sau khi chon.
 */
export interface V26SplitUnit {
  text: string;
  /** Y nay co phai heading khong. */
  heading: boolean;
  /** Y nay co phai bullet/numbered khong. */
  bullet: boolean;
  /** Chi so thu tu goc. */
  index: number;
}

export function splitUnitsV26(text: string): V26SplitUnit[] {
  const units: V26SplitUnit[] = [];
  let index = 0;
  const push = (raw: string, heading: boolean, bullet: boolean): void => {
    const t = raw.trim();
    if (!t) return;
    units.push({ text: t, heading, bullet, index: index++ });
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) {
      push(line, true, false);
      continue;
    }
    if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      push(line, false, true);
      continue;
    }
    // Doan van dai: tach cau.
    if (line.length > 220) {
      const sentences = line.split(/(?<=[.!?])\s+/);
      if (sentences.length > 1) {
        for (const s of sentences) push(s, false, false);
        continue;
      }
    }
    push(line, false, false);
  }
  return units;
}

/** Dem tan suat tu khoa (bo stopwords, tu >= 3 ky tu). */
export function keywordFrequenciesV26(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokenizeV26(text)) {
    if (token.length < 3) continue;
    if (STOPWORDS_V26.has(token)) continue;
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return freq;
}

/**
 * Cho diem 1 y (0..1).
 *
 * Thanh phan diem:
 *  - heading: +0.35 (luon uu tien giu cau truc).
 *  - bullet: +0.10.
 *  - tu khoa: trung binh tan suat cac tu khoa trong y, chuan
 *    hoa theo tan suat lon nhat trong block (toi da +0.35).
 *  - vi tri: y o 10% dau hoac 10% cuoi block +0.10 (mo dau/
 *    ket luan thuong chua y chinh).
 *  - do dai: y 20..200 ky tu +0.10; y qua ngan (<10 ky tu,
 *    thuong la tu roi rac) hoac qua dai (>400 ky tu) bi tru.
 */
export function scoreUnitV26(
  unit: V26SplitUnit,
  freq: Map<string, number>,
  maxFreq: number,
  totalUnits: number,
): number {
  let score = 0;
  if (unit.heading) score += 0.35;
  if (unit.bullet) score += 0.1;
  const tokens = tokenizeV26(unit.text).filter((t) => t.length >= 3 && !STOPWORDS_V26.has(t));
  if (tokens.length > 0 && maxFreq > 0) {
    let sum = 0;
    for (const t of tokens) sum += freq.get(t) ?? 0;
    score += Math.min(0.35, (sum / tokens.length / maxFreq) * 0.35);
  }
  if (totalUnits > 1) {
    const pos = unit.index / (totalUnits - 1);
    if (pos <= 0.1 || pos >= 0.9) score += 0.1;
  }
  const len = unit.text.length;
  if (len >= 20 && len <= 200) score += 0.1;
  else if (len < 10) score -= 0.1;
  else if (len > 400) score -= 0.05;
  if (score < 0) score = 0;
  if (score > 1) score = 1;
  return score;
}

/**
 * Tom tat trich xuat (extractive): giu cac y quan trong nhat
 * trong ngan sach token dich.
 *
 * Dam bao:
 *  - summaryTokens <= targetTokens (tru khi 1 y don da vuot
 *    target — khi do giu y do 1 minh va cat ngan).
 *  - heading luon duoc giu neu con cho trong budget.
 *  - thu tu y trong summary = thu tu goc.
 *  - text rong => summary rong, 0 item.
 */
export function summariseV26(text: string, targetTokens: number): V26SummariseResult {
  const originalTokens = estimateTokensV26(text);
  const units = splitUnitsV26(text);
  if (units.length === 0 || targetTokens <= 0) {
    return {
      summary: '',
      originalTokens,
      summaryTokens: 0,
      itemsTotal: units.length,
      itemsKept: 0,
      items: [],
      keptHeadings: [],
    };
  }
  const freq = keywordFrequenciesV26(text);
  let maxFreq = 0;
  for (const v of freq.values()) if (v > maxFreq) maxFreq = v;
  const scored = units.map((unit) => ({
    unit,
    score: scoreUnitV26(unit, freq, maxFreq, units.length),
  }));
  // Sap theo diem giam dan (heading luon truoc nho diem +0.35),
  // dong diem thi y xuat hien truoc thang.
  const byScore = [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.unit.index - b.unit.index;
  });
  const kept = new Set<number>();
  let usedTokens = 0;
  for (const { unit, score } of byScore) {
    void score;
    const tokens = estimateTokensV26(unit.text);
    if (kept.size > 0 && usedTokens + tokens > targetTokens) continue;
    kept.add(unit.index);
    usedTokens += tokens;
    if (usedTokens >= targetTokens) break;
  }
  // Neu khong giu duoc y nao (y dau tien da vuot target) thi giu
  // y diem cao nhat roi cat ngan ve target.
  if (kept.size === 0 && byScore.length > 0) {
    kept.add(byScore[0].unit.index);
  }
  const keptUnits = units.filter((u) => kept.has(u.index));
  let summary = keptUnits.map((u) => u.text).join('\n');
  let summaryTokens = estimateTokensV26(summary);
  if (summaryTokens > targetTokens && keptUnits.length === 1) {
    const limit = Math.max(20, targetTokens * 4);
    summary = truncateV26(summary, limit);
    summaryTokens = estimateTokensV26(summary);
  }
  const items: V26SummaryItem[] = scored.map(({ unit, score }) => ({
    text: unit.text,
    score: Math.round(score * 1000) / 1000,
    kept: kept.has(unit.index),
    reason: kept.has(unit.index)
      ? unit.heading
        ? 'heading: giu cau truc'
        : unit.bullet
          ? 'bullet: y rieng le'
          : score >= 0.4
            ? 'diem cao: tu khoa lap lai'
            : 'giu trong budget'
      : 'diem thap hoac het budget',
  }));
  return {
    summary,
    originalTokens,
    summaryTokens,
    itemsTotal: units.length,
    itemsKept: keptUnits.length,
    items,
    keptHeadings: keptUnits.filter((u) => u.heading).map((u) => u.text),
  };
}

// ---------------------------------------------------------------------------
// Budget store
// ---------------------------------------------------------------------------

/** Quan ly budget token cho cac block. */
export class V26BudgetManager {
  private readonly budgets = new Map<string, V26BlockBudget>();

  /** Dat/cap nhat budget cho 1 block. */
  setBudget(input: V26BlockBudget): V26Result<V26BlockBudget> {
    const err = validateBudgetV26(input);
    if (err) return errV26(err);
    const budget: V26BlockBudget = {
      blockId: input.blockId,
      label: input.label,
      maxTokens: input.maxTokens,
      warnRatio: input.warnRatio,
      onExceed: input.onExceed,
      curateTargetTokens: input.curateTargetTokens,
    };
    this.budgets.set(input.blockId, budget);
    return okV26(budget);
  }

  /** Lay budget cua block (null neu chua dat). */
  getBudget(blockId: string): V26BlockBudget | undefined {
    return this.budgets.get(blockId);
  }

  /** Xoa budget cua block (ve khong gioi han). */
  clearBudget(blockId: string): boolean {
    return this.budgets.delete(blockId);
  }

  /** Tinh trang thai budget cua 1 block tai gia tri hien tai. */
  status(blockId: string, label: string, value: string): V26BudgetStatus {
    const tokens = estimateTokensV26(value);
    const budget = this.budgets.get(blockId);
    if (!budget || budget.maxTokens <= 0) {
      return {
        blockId, label, tokens, maxTokens: 0,
        usageRatio: 0, status: 'unlimited', needsCurate: false, overByTokens: 0,
      };
    }
    const usageRatio = tokens / budget.maxTokens;
    let status: V26BudgetStatus['status'];
    if (usageRatio >= 1) status = 'over';
    else if (usageRatio >= budget.warnRatio) status = 'warn';
    else status = 'ok';
    return {
      blockId,
      label,
      tokens,
      maxTokens: budget.maxTokens,
      usageRatio: Math.round(usageRatio * 1000) / 1000,
      status,
      needsCurate: status === 'over' && budget.onExceed === 'curate',
      overByTokens: Math.max(0, tokens - budget.maxTokens),
    };
  }

  /** Trang thai budget cua nhieu block (loc vuot/canh bao). */
  statuses(blocks: Array<{ id: string; label: string; value: string }>): V26BudgetStatus[] {
    return blocks.map((b) => this.status(b.id, b.label, b.value));
  }

  /** Budget mac dinh cho block moi theo kind (goi y). */
  suggestedBudgetForKind(kind: string): number {
    if (kind === 'human') return 2000;
    if (kind === 'persona') return 1500;
    if (kind === 'project') return 4000;
    if (kind === 'task') return 2000;
    return 0;
  }

  toJSON(): V26BlockBudget[] {
    return [...this.budgets.values()];
  }

  static fromJSON(data: unknown): V26BudgetManager {
    const manager = new V26BudgetManager();
    if (!Array.isArray(data)) return manager;
    for (const raw of data as V26BlockBudget[]) {
      if (!raw || typeof raw.blockId !== 'string') continue;
      manager.budgets.set(raw.blockId, { ...raw });
    }
    return manager;
  }
}

/**
 * Curate 1 block: neu vuot budget (onExceed='curate') thi
 * summarise ve curateTargetTokens va tra bao cao. Ham nay KHONG
 * tu ghi block — caller (pipeline/store) ghi + audit + dua
 * phan bi loai vao archival.
 */
export function planCurateV26(
  blockId: string,
  label: string,
  value: string,
  fromVersion: number,
  budget: V26BlockBudget,
  by: string,
  nowMs: number = Date.now(),
): { report: V26CurateReport; summary: V26SummariseResult; dropped: string[] } {
  const summary = summariseV26(value, budget.curateTargetTokens);
  const dropped = summary.items.filter((i) => !i.kept).map((i) => i.text);
  const applied = summary.summaryTokens < estimateTokensV26(value) && summary.summary.length > 0;
  const report: V26CurateReport = {
    blockId,
    label,
    at: new Date(nowMs).toISOString(),
    by,
    fromVersion,
    toVersion: applied ? fromVersion + 1 : fromVersion,
    originalTokens: summary.originalTokens,
    summaryTokens: summary.summaryTokens,
    tokensSaved: Math.max(0, summary.originalTokens - summary.summaryTokens),
    itemsTotal: summary.itemsTotal,
    itemsKept: summary.itemsKept,
    applied,
    reason: applied
      ? `vuot budget ${budget.maxTokens} token, tom tat ve ${budget.curateTargetTokens} token`
      : 'da gon, khong can curate',
  };
  return { report, summary, dropped };
}

/**
 * Render nhieu block vao prompt trong ngan sach token tong.
 *
 * Thu tu uu tien: human -> persona -> project -> task -> custom;
 * trong cung kind thi block moi cap nhat truoc. Block vuot
 * phan budget con lai thi cat ngan value ve phan con lai (ghi
 * ro truncated) thay vi bo han — bot van thay phan dau block.
 */
export function renderPromptWithBudgetV26(
  blocks: Array<{ label: string; kind: string; value: string; updatedAt: string }>,
  totalBudgetTokens: number,
): V26PromptSnapshot {
  const kindRank: Record<string, number> = { human: 0, persona: 1, project: 2, task: 3, custom: 4 };
  const sorted = [...blocks].sort((a, b) => {
    const ra = kindRank[a.kind] ?? 4;
    const rb = kindRank[b.kind] ?? 4;
    if (ra !== rb) return ra - rb;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });
  const rendered: V26PromptBlock[] = [];
  const truncated: string[] = [];
  let used = 0;
  let skipped = 0;
  for (const block of sorted) {
    const tokens = estimateTokensV26(block.value);
    const remaining = totalBudgetTokens - used;
    if (remaining <= 0) {
      skipped++;
      continue;
    }
    if (tokens <= remaining) {
      rendered.push({ label: block.label, kind: block.kind as V26PromptBlock['kind'], value: block.value, tokens, truncated: false });
      used += tokens;
    } else {
      // Cat ngan ve phan con lai (it nhat 20 token neu con cho).
      const allowTokens = Math.max(20, remaining);
      const allowChars = allowTokens * 4;
      const cut = truncateV26(block.value, allowChars);
      const cutTokens = estimateTokensV26(cut);
      rendered.push({ label: block.label, kind: block.kind as V26PromptBlock['kind'], value: cut, tokens: cutTokens, truncated: true });
      truncated.push(block.label);
      used += cutTokens;
    }
  }
  const parts = ['<memory_blocks>'];
  for (const b of rendered) {
    parts.push(`<block label="${escapeXmlV26(b.label)}" kind="${escapeXmlV26(b.kind)}"${b.truncated ? ' truncated="true"' : ''}>`);
    parts.push(`<value>${escapeXmlV26(b.value)}</value>`);
    parts.push('</block>');
  }
  parts.push('</memory_blocks>');
  const text = rendered.length > 0 ? parts.join('\n') : '';
  return {
    text,
    chars: text.length,
    tokens: used,
    budgetTokens: totalBudgetTokens,
    blocksRendered: rendered.length,
    blocksSkipped: skipped,
    blocksTruncated: truncated,
    blocks: rendered,
  };
}

function escapeXmlV26(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Kiem tra 1 ngay co phai hom nay khong (day key). */
export function isTodayV26(dayKey: string, nowMs: number = Date.now()): boolean {
  return dayKey === new Date(nowMs).toISOString().slice(0, 10);
}

/** Ghi chu: dayKey cua 1 muc archive (tien ich dung chung). */
export function archiveDayKeyV26(atIso: string): string | null {
  return dayKeyV26(atIso);
}
