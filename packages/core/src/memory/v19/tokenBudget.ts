/**
 * Memory v19 — Token-budget governor cho memory replay (v1.20, Doi T1).
 *
 * Y tuong hoc tu Tech Radar 11/2026 (four-tier memory + token-budget
 * governor) + Letta (context window quan ly theo tier) — tu thiet
 * ke lai hoan toan cho open-bot, KHONG copy code/text/tai san cua
 * bat ky repo nao.
 *
 * Van de: memory replay (dua fact cu vao prompt) khong gioi han se
 * an het context window, day instruction + hoi thoai hien tai ra
 * ngoai. Governor nay:
 *  1. Cap memory replay o 15–20% context (mac dinh 20%, cau hinh
 *     duoc; Tech Radar goi y khoang nay cho tier nho dai han).
 *  2. Chon fact theo diem uu tien (score cao truoc) cho toi khi
 *     vua budget — fact thua bi cat co ghi ly do, khong lang le
 *     bien mat.
 *  3. Theo doi usage theo tung lan replay (tokens da dung, ty le
 *     so voi cap) + lich su, canh bao khi vuot nguong canh bao
 *     (mac dinh 80% cap) hoac vuot cap.
 *  4. Uoc tinh token bang heuristic chars/4 (ghi ro la uoc tinh);
 *     host co the truyen ham dem chinh xac (vd tiktoken) qua
 *     `countTokens` de so that hon.
 *
 * Governor KHONG goi model, KHONG goi mang. No chi quyet dinh
 * "dua fact nao vao prompt" — viec dua vao prompt do caller lam.
 */

import type { GraphFact } from '../graph/types';

/** Loi token-budget governor — message tieng Viet. */
export class V19TokenBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V19TokenBudgetError';
  }
}

/** Ty le cap mac dinh: memory replay toi da 20% context. */
export const V19_DEFAULT_MEMORY_FRACTION_MAX = 0.2;
/** Ty le cap toi thieu: memory replay it nhat 15% context (khi host muon dam bao memory duoc thay). */
export const V19_DEFAULT_MEMORY_FRACTION_MIN = 0.15;
/** Nguong canh bao mac dinh: 80% cap. */
export const V19_DEFAULT_WARN_FRACTION = 0.8;
/** So token uoc tinh moi ky tu (heuristic chars/4). */
export const V19_CHARS_PER_TOKEN = 4;

/** Cau hinh governor. */
export interface V19TokenBudgetConfig {
  /** Tong context window (token). */
  contextTokens: number;
  /** Ty le toi da danh cho memory replay (0..1, mac dinh 0.20). */
  memoryFractionMax: number;
  /** Ty le toi thieu danh cho memory replay (0..1, mac dinh 0.15). */
  memoryFractionMin: number;
  /** Nguong canh bao: phan tram cap khi bat dau canh bao (mac dinh 0.8). */
  warnFraction: number;
  /**
   * Ham dem token chinh xac (tuy chon). Mac dinh: heuristic
   * chars/4. Host truyen ham nay khi co tiktoken / tokenizer that.
   */
  countTokens?: (text: string) => number;
}

/** Cau hinh mac dinh (context 128k, cap 20%). */
export const V19_DEFAULT_TOKEN_BUDGET_CONFIG: V19TokenBudgetConfig = {
  contextTokens: 128_000,
  memoryFractionMax: V19_DEFAULT_MEMORY_FRACTION_MAX,
  memoryFractionMin: V19_DEFAULT_MEMORY_FRACTION_MIN,
  warnFraction: V19_DEFAULT_WARN_FRACTION,
};

/** Kiem tra tinh hop le cua cau hinh (throw V19TokenBudgetError neu sai). */
export function validateTokenBudgetConfigV19(config: V19TokenBudgetConfig): void {
  if (!Number.isFinite(config.contextTokens) || config.contextTokens <= 0) {
    throw new V19TokenBudgetError('contextTokens phai la so duong.');
  }
  for (const [name, value] of [
    ['memoryFractionMax', config.memoryFractionMax],
    ['memoryFractionMin', config.memoryFractionMin],
    ['warnFraction', config.warnFraction],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new V19TokenBudgetError(`${name} phai trong [0,1].`);
    }
  }
  if (config.memoryFractionMin > config.memoryFractionMax) {
    throw new V19TokenBudgetError('memoryFractionMin khong duoc lon hon memoryFractionMax.');
  }
}

/** Uoc tinh token cua text bang heuristic chars/4 (ghi ro la uoc tinh). */
export function estimateTokensV19(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / V19_CHARS_PER_TOKEN));
}

/** Mot ung vien memory de dua vao replay (fact + diem uu tien + text hien thi). */
export interface V19ReplayCandidate {
  /** Id fact (de UI truy vet). */
  factId: string;
  /** Text se dua vao prompt (vd "An song o Ha Noi"). */
  text: string;
  /** Diem uu tien (cao = dua vao truoc). */
  score: number;
  /** Ly do diem (tuy chon, de UI giai thich). */
  scoreReason?: string;
}

/** Ket qua lap ke hoach replay (chua dua vao prompt — caller tu ghep). */
export interface V19ReplayPlan {
  at: string;
  /** Tong context window (token). */
  contextTokens: number;
  /** Cap memory replay (token) = context * memoryFractionMax. */
  budgetTokens: number;
  /** San toi thieu (token) = context * memoryFractionMin. */
  floorTokens: number;
  /** Cac fact duoc chon (theo thu tu uu tien). */
  selected: V19ReplayCandidate[];
  /** Cac fact bi cat vi het budget (kem ly do). */
  dropped: { candidate: V19ReplayCandidate; reason: string }[];
  /** Tong token cua fact duoc chon. */
  usedTokens: number;
  /** Ty le dung so voi cap (0..1, co the > 1 neu 1 fact vuot cap). */
  usedFraction: number;
  /** true = dung qua nguong canh bao (warnFraction * cap). */
  warn: boolean;
  /** true = vuot cap (chi xay ra khi 1 fact don le lon hon cap). */
  overBudget: boolean;
  /** true = duoi san toi thieu (memory duoc dua vao it hon muc toi thieu). */
  belowFloor: boolean;
  /** Ghi chu giai thich (de UI/log hien thi). */
  note: string;
}

/** Mot lan ghi usage (de bao cao lich su). */
export interface V19TokenUsageRecord {
  at: string;
  contextTokens: number;
  budgetTokens: number;
  usedTokens: number;
  usedFraction: number;
  selectedCount: number;
  droppedCount: number;
  warn: boolean;
  overBudget: boolean;
}

/** Bao cao usage tong hop. */
export interface V19TokenUsageReport {
  totalReplays: number;
  totalUsedTokens: number;
  avgUsedTokens: number;
  avgUsedFraction: number;
  maxUsedFraction: number;
  warnCount: number;
  overBudgetCount: number;
  belowFloorCount: number;
  history: V19TokenUsageRecord[];
}

/**
 * Token-budget governor: giu cap, chon fact, ghi usage, canh bao.
 * Su dung: tao 1 governor moi host (giu cau hinh + lich su), goi
 * `planReplay` moi lan can dua memory vao prompt, goi `record`
 * sau khi thuc su dung plan (de lich su phan anh that te).
 */
export class V19TokenBudgetGovernor {
  private readonly config: V19TokenBudgetConfig;
  private readonly history: V19TokenUsageRecord[] = [];

  constructor(config: Partial<V19TokenBudgetConfig> = {}) {
    const merged: V19TokenBudgetConfig = { ...V19_DEFAULT_TOKEN_BUDGET_CONFIG, ...config };
    validateTokenBudgetConfigV19(merged);
    this.config = merged;
  }

  /** Cau hinh dang dung (ban sao). */
  getConfig(): V19TokenBudgetConfig {
    return { ...this.config };
  }

  /** Cap memory replay (token). */
  budgetTokens(): number {
    return Math.floor(this.config.contextTokens * this.config.memoryFractionMax);
  }

  /** San toi thieu memory replay (token). */
  floorTokens(): number {
    return Math.floor(this.config.contextTokens * this.config.memoryFractionMin);
  }

  /** Dem token cua text (ham chinh xac neu host truyen, khong thi heuristic). */
  countTokens(text: string): number {
    if (this.config.countTokens) {
      const n = this.config.countTokens(text);
      if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    }
    return estimateTokensV19(text);
  }

  /**
   * Lap ke hoach replay: xep ung vien theo score giam dan, lay lan
   * luot cho toi khi vua cap. Ung vien vuot cap mot minh van duoc
   * lay neu chua co gi (de memory quan trong nhat khong bi mat
   * trang), nhung danh dau `overBudget` + ghi chu — caller nen cat
   * ngan text hoac tang cap thay vi dua ca fact khong lo vao prompt.
   */
  planReplay(candidates: V19ReplayCandidate[]): V19ReplayPlan {
    const budget = this.budgetTokens();
    const floor = this.floorTokens();
    const sorted = [...candidates]
      .map((c) => ({ candidate: c, tokens: this.countTokens(c.text) }))
      .sort((a, b) => {
        if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
        return a.tokens - b.tokens;
      });
    const selected: V19ReplayCandidate[] = [];
    const dropped: { candidate: V19ReplayCandidate; reason: string }[] = [];
    let used = 0;
    for (const { candidate, tokens } of sorted) {
      if (used + tokens > budget) {
        // Neu chua chon gi ca va day la ung vien diem cao nhat: lay
        // 1 fact vuot cap (danh dau) thay vi tra ve replay rong.
        if (selected.length === 0) {
          selected.push(candidate);
          used += tokens;
          continue;
        }
        dropped.push({ candidate, reason: `Vuot cap: can ${tokens} token, con lai ${budget - used} token.` });
        continue;
      }
      selected.push(candidate);
      used += tokens;
    }
    const usedFraction = budget === 0 ? 0 : used / budget;
    const warn = usedFraction >= this.config.warnFraction;
    const overBudget = used > budget;
    const belowFloor = used < floor && dropped.length === 0 && candidates.length > 0 ? false : used < floor;
    const note =
      selected.length === 0
        ? 'Khong co memory nao vua budget — replay rong.'
        : overBudget
          ? `CANH BAO: 1 fact (${selected[0]?.factId}) vuot cap mot minh (${used}/${budget} token). Cat ngan text hoac tang cap.`
          : warn
            ? `Gan het cap memory (${used}/${budget} token, ${(usedFraction * 100).toFixed(0)}%).`
            : `Memory replay ${used}/${budget} token (${(usedFraction * 100).toFixed(0)}% cap).`;
    return {
      at: new Date().toISOString(),
      contextTokens: this.config.contextTokens,
      budgetTokens: budget,
      floorTokens: floor,
      selected,
      dropped,
      usedTokens: used,
      usedFraction,
      warn,
      overBudget,
      belowFloor,
      note,
    };
  }

  /** Ghi 1 lan replay that da dung (tu plan) vao lich su. */
  record(plan: V19ReplayPlan): V19TokenUsageRecord {
    const record: V19TokenUsageRecord = {
      at: plan.at,
      contextTokens: plan.contextTokens,
      budgetTokens: plan.budgetTokens,
      usedTokens: plan.usedTokens,
      usedFraction: plan.usedFraction,
      selectedCount: plan.selected.length,
      droppedCount: plan.dropped.length,
      warn: plan.warn,
      overBudget: plan.overBudget,
    };
    this.history.push(record);
    return { ...record };
  }

  /** Lich su usage (ban sao). */
  getHistory(): V19TokenUsageRecord[] {
    return this.history.map((r) => ({ ...r }));
  }

  /** Bao cao usage tong hop (tong / TB / max / so lan canh bao). */
  usageReport(): V19TokenUsageReport {
    const total = this.history.length;
    const totalUsed = this.history.reduce((s, r) => s + r.usedTokens, 0);
    const avgUsed = total === 0 ? 0 : totalUsed / total;
    const avgFraction = total === 0 ? 0 : this.history.reduce((s, r) => s + r.usedFraction, 0) / total;
    const maxFraction = this.history.reduce((m, r) => Math.max(m, r.usedFraction), 0);
    return {
      totalReplays: total,
      totalUsedTokens: totalUsed,
      avgUsedTokens: avgUsed,
      avgUsedFraction: avgFraction,
      maxUsedFraction: maxFraction,
      warnCount: this.history.filter((r) => r.warn).length,
      overBudgetCount: this.history.filter((r) => r.overBudget).length,
      belowFloorCount: this.history.filter((r) => r.usedTokens < this.floorTokens()).length,
      history: this.getHistory(),
    };
  }

  /** Xoa lich su usage (giữ cau hinh). */
  clearHistory(): void {
    this.history.length = 0;
  }
}

/**
 * Tao ung vien replay tu fact (text hien thi + diem co ban =
 * confidence). Caller nen cong them diem feedback/recency bang
 * `feedback.ts` (`rankScoreV19`) truoc khi goi `planReplay`.
 */
export function replayCandidateFromFactV19(
  fact: GraphFact,
  subjectName: string,
  score?: number,
): V19ReplayCandidate {
  const object = fact.objectText ?? '';
  return {
    factId: fact.id,
    text: `${subjectName} ${fact.predicate.replace(/_/g, ' ')} ${object}`.trim(),
    score: score ?? fact.confidence,
    scoreReason: score === undefined ? `confidence ${fact.confidence.toFixed(2)}` : undefined,
  };
}

/** Format bao cao usage thanh text (de tool / log hien thi). */
export function formatV19TokenUsageReport(report: V19TokenUsageReport): string {
  const lines: string[] = [];
  lines.push(
    `Token budget governor: ${report.totalReplays} lan replay, TB ${report.avgUsedTokens.toFixed(0)} token/lan ` +
      `(${(report.avgUsedFraction * 100).toFixed(0)}% cap), max ${(report.maxUsedFraction * 100).toFixed(0)}% cap.`,
  );
  lines.push(
    `  Canh bao: ${report.warnCount} lan gan het cap, ${report.overBudgetCount} lan vuot cap, ` +
      `${report.belowFloorCount} lan duoi san toi thieu.`,
  );
  return lines.join('\n');
}
