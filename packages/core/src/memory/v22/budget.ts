/**
 * Memory v22 — Always-loaded budget (v1.37, Doi T1).
 *
 * Y tuong (Anthropic Dreams "giu lop always-loaded nho" +
 * Tech Radar token-budget governor, da co o v19): moi prompt
 * deu nap mot lop memory co dinh — lop nay phai VUA ngan sach
 * ky tu. Dream do lop truoc/sau, cat bot fact thua khi vuot
 * ngan sach — co ly do tung fact bi cat, khong lang le bien mat.
 *
 * Diem uu tien cua mot fact (cao = nap truoc):
 *   score = confidence
 *         * (1 + 0.1 * min(so session, 5))       // lap lai nhieu session thi quan trong
 *         * 0.5 ^ (tuoi / halfLifeDays)           // decay mu theo thoi gian
 *         * (kind pattern ? 1.25 : 1)            // pattern tong hop duoc uu tien
 *         * (con han ? 1 : 0)                    // fact het han / chua toi han thi 0 diem
 * Fact duoi `promoteThreshold` thi khong xet. Chon tham lam
 * theo diem cho toi khi vua ngan sach — fact vuot ngan sach
 * thi cat co ghi ly do (`excludedReasons`).
 *
 * Uoc tinh token bang heuristic chars/4 (ghi ro la uoc tinh);
 * host co the truyen ham dem chinh xac qua `countTokens`.
 */
import type { V22AlwaysLoadedMeasurement, V22AlwaysLoadedPlan, V22DreamFact } from './types';
import { V22_CHARS_PER_TOKEN, V22_DREAM_DEFAULT_CONFIG } from './types';

/** Tuy chon lap ke hoach always-loaded. */
export interface V22BudgetOptions {
  /** Ngan sach ky tu toi da. Mac dinh 4000. */
  budgetChars?: number;
  /** Confidence toi thieu de xet. Mac dinh 0.5. */
  promoteThreshold?: number;
  /** Half-life (ngay) cho decay diem uu tien. Mac dinh 30. */
  priorityHalfLifeDays?: number;
  /** Ham dem token chinh xac (tuy chon). Mac dinh chars/4. */
  countTokens?: (text: string) => number;
  /** Epoch ms moc tinh tuoi (mac dinh Date.now()). */
  now?: number;
}

/** Uoc tinh token cua text bang heuristic chars/4. */
export function estimateTokensV22(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / V22_CHARS_PER_TOKEN));
}

/** Ky tu cua mot fact khi dua vao prompt (mot dong `- text`). */
export function factPromptCharsV22(fact: V22DreamFact): number {
  return `- ${fact.text}\n`.length;
}

/** Diem uu tien cua mot fact tai `now` (0 = khong xet vao lop). */
export function scoreDreamFactV22(
  fact: V22DreamFact,
  options: { now?: number; priorityHalfLifeDays?: number } = {},
): number {
  const now = options.now ?? Date.now();
  if (fact.status !== 'active') return 0;
  if (fact.validUntil !== undefined && fact.validUntil <= now) return 0;
  if (fact.validFrom !== undefined && fact.validFrom > now) return 0;
  const halfLifeDays = options.priorityHalfLifeDays ?? V22_DREAM_DEFAULT_CONFIG.priorityHalfLifeDays;
  const ageMs = Math.max(0, now - fact.observedAt);
  const ageDays = ageMs / 86_400_000;
  const recency = halfLifeDays > 0 ? Math.pow(0.5, ageDays / halfLifeDays) : 1;
  const repeat = 1 + 0.1 * Math.min(fact.sessionIds.length, 5);
  const patternBoost = fact.kind === 'pattern' ? 1.25 : 1;
  return fact.confidence * repeat * recency * patternBoost;
}

/** Sap xep fact theo diem uu tien giam dan (kem diem de UI giai thich). */
export function rankFactsForAlwaysLoadedV22(
  facts: V22DreamFact[],
  options: V22BudgetOptions = {},
): { fact: V22DreamFact; score: number }[] {
  const now = options.now ?? Date.now();
  const threshold = options.promoteThreshold ?? V22_DREAM_DEFAULT_CONFIG.promoteThreshold;
  return facts
    .filter((f) => f.status === 'active' && f.confidence >= threshold)
    .map((fact) => ({ fact, score: scoreDreamFactV22(fact, { now, priorityHalfLifeDays: options.priorityHalfLifeDays }) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.confidence - a.fact.confidence);
}

/** Do luong lop always-loaded hien tai (khong cat — chi do). */
export function measureAlwaysLoadedV22(
  facts: V22DreamFact[],
  options: V22BudgetOptions = {},
): V22AlwaysLoadedMeasurement {
  const budgetChars = options.budgetChars ?? V22_DREAM_DEFAULT_CONFIG.maxCharsAlwaysLoaded;
  const countTokens = options.countTokens ?? estimateTokensV22;
  const now = options.now ?? Date.now();
  const ranked = rankFactsForAlwaysLoadedV22(facts, options);
  let chars = 0;
  const includedIds: string[] = [];
  const excludedIds: string[] = [];
  for (const { fact } of ranked) {
    const cost = factPromptCharsV22(fact);
    if (chars + cost <= budgetChars) {
      chars += cost;
      includedIds.push(fact.id);
    } else {
      excludedIds.push(fact.id);
    }
  }
  const rendered = includedIds
    .map((id) => ranked.find((r) => r.fact.id === id)?.fact)
    .filter((f): f is V22DreamFact => f !== undefined)
    .map((f) => `- ${f.text}`)
    .join('\n');
  return {
    chars,
    estimatedTokens: countTokens(rendered),
    factCount: includedIds.length,
    budgetChars,
    withinBudget: chars <= budgetChars,
    overByChars: Math.max(0, chars - budgetChars),
    includedIds,
    excludedIds,
  };
}

/**
 * Lap ke hoach always-loaded day du: do luong + ly do cat tung
 * fact + diem tung fact + text ghep san de dua vao prompt.
 */
export function planAlwaysLoadedV22(
  facts: V22DreamFact[],
  options: V22BudgetOptions = {},
): V22AlwaysLoadedPlan {
  const now = options.now ?? Date.now();
  const budgetChars = options.budgetChars ?? V22_DREAM_DEFAULT_CONFIG.maxCharsAlwaysLoaded;
  const ranked = rankFactsForAlwaysLoadedV22(facts, { ...options, now });
  const measurement = measureAlwaysLoadedV22(facts, { ...options, now });
  const excludedReasons: Record<string, string> = {};
  const scores: Record<string, number> = {};
  for (const { fact, score } of ranked) {
    scores[fact.id] = Number(score.toFixed(4));
    if (measurement.excludedIds.includes(fact.id)) {
      excludedReasons[fact.id] = `het ngan sach ${budgetChars} ky tu (diem uu tien ${score.toFixed(2)} thap hon cac fact duoc chon)`;
    }
  }
  // Fact bi loai vi duoi nguong / het han / chua toi han (khong co trong ranked).
  for (const fact of facts) {
    if (fact.status !== 'active') continue;
    if (measurement.includedIds.includes(fact.id) || measurement.excludedIds.includes(fact.id)) continue;
    if (fact.confidence < (options.promoteThreshold ?? V22_DREAM_DEFAULT_CONFIG.promoteThreshold)) {
      excludedReasons[fact.id] = `confidence ${fact.confidence.toFixed(2)} duoi nguong ${(options.promoteThreshold ?? V22_DREAM_DEFAULT_CONFIG.promoteThreshold).toFixed(2)}`;
    } else if (fact.validUntil !== undefined && fact.validUntil <= now) {
      excludedReasons[fact.id] = 'fact da het han (validUntil)';
    } else if (fact.validFrom !== undefined && fact.validFrom > now) {
      excludedReasons[fact.id] = 'fact chua toi han hieu luc (validFrom)';
    }
  }
  const includedFacts = measurement.includedIds
    .map((id) => ranked.find((r) => r.fact.id === id)?.fact)
    .filter((f): f is V22DreamFact => f !== undefined);
  return {
    at: now,
    budgetChars,
    measurement,
    excludedReasons,
    scores,
    renderedText: includedFacts.map((f) => `- ${f.text}`).join('\n'),
  };
}

/** So sanh hai do luong (truoc/sau dream) thanh dong tom tat. */
export function summarizeBudgetChangeV22(
  before: V22AlwaysLoadedMeasurement,
  after: V22AlwaysLoadedMeasurement,
): string {
  const charDelta = after.chars - before.chars;
  const sign = charDelta >= 0 ? '+' : '';
  return `always-loaded: ${before.chars} -> ${after.chars} ky tu (${sign}${charDelta}), ${before.factCount} -> ${after.factCount} fact, ${after.withinBudget ? 'vua ngan sach' : `vuot ngan sach ${after.overByChars} ky tu`}.`;
}
