/**
 * Per-model cost ledger v29 (v1.42, Doi T5).
 *
 * Ghi so chi phi theo tung model: token (input/output) + phut voice
 * (model live tinh theo phut, vd GPT-Live $0.05/phut) — tong hop theo
 * model / ngay / phien / provider, canh bao ngan sach ngay + phien.
 *
 * Khac CostLedger v118 (chi phi tung turn + tiet kiem vs model manh
 * nhat): ledger nay la so cai tong hop dai han theo model, co prune
 * theo ngay va serialize de luu tru. Thuan logic, khong goi API live.
 */

/** Mot dong ghi so dung model. */
export interface ModelUsageRecordV29 {
  id: string;
  modelId: string;
  provider: string;
  sessionId: string;
  /** Ngay YYYY-MM-DD (UTC) — de tong hop theo ngay. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  /** Phut voice (0 neu la text). */
  minutes: number;
  costUsd: number;
  createdAt: number;
  label?: string;
}

/** Dau vao ghi mot luot dung (gia lay tu catalog hoac host truyen). */
export interface RecordUsageInputV29 {
  modelId: string;
  provider: string;
  sessionId: string;
  inputTokens?: number;
  outputTokens?: number;
  minutes?: number;
  /** USD / 1k token input (lay tu catalog neu khong truyen). */
  inputPricePer1kUsd?: number;
  /** USD / 1k token output. */
  outputPricePer1kUsd?: number;
  /** USD / phut (model live). */
  perMinuteUsd?: number;
  /** Ghi de chi phi tinh san (neu host da tinh). */
  costUsdOverride?: number;
  /** Ngay YYYY-MM-DD (mac dinh tu createdAt). */
  day?: string;
  createdAt?: number;
  label?: string;
}

/** Tong hop theo mot khoa (model / ngay / phien / provider). */
export interface CostBucketV29 {
  key: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  minutes: number;
  calls: number;
}

/** Bao cao tong hop cua ledger. */
export interface CostLedgerSummaryV29 {
  totalUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalMinutes: number;
  byModel: CostBucketV29[];
  byDay: CostBucketV29[];
  bySession: CostBucketV29[];
  byProvider: CostBucketV29[];
  topModelId: string | null;
  topDay: string | null;
}

/** Ket qua kiem tra ngan sach. */
export interface BudgetCheckV29 {
  dailyBudgetUsd: number | null;
  dailyUsedUsd: number;
  dailyRemainingUsd: number | null;
  overDaily: boolean;
  sessionsOverBudget: { sessionId: string; usedUsd: number; budgetUsd: number }[];
  /** Canh bao khi dung >= 80% ngan sach ngay. */
  dailyNearLimit: boolean;
}

/** Ngay UTC YYYY-MM-DD tu timestamp. */
export function dayOfTimestampV29(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Kiem tra ngay co dang YYYY-MM-DD hop le khong. */
export function isValidDayV29(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

function bucketize(records: ModelUsageRecordV29[], pick: (r: ModelUsageRecordV29) => string): CostBucketV29[] {
  const map = new Map<string, CostBucketV29>();
  for (const r of records) {
    const key = pick(r);
    const b = map.get(key) ?? { key, costUsd: 0, inputTokens: 0, outputTokens: 0, minutes: 0, calls: 0 };
    b.costUsd += r.costUsd;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.minutes += r.minutes;
    b.calls += 1;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
}

/**
 * So cai chi phi theo model.
 *
 * - recordUsage: tinh chi phi tu gia truyen vao (token + phut), luu ban ghi.
 * - summary: tong hop theo model/ngay/phien/provider.
 * - Budget: ngan sach ngay chung + ngan sach rieng tung phien.
 * - pruneBefore: xoa ban ghi cu hon mot ngay (tra so dong da xoa).
 * - toJSON/fromJSON: luu/tai lai (khong tu doc file).
 */
export class ModelCostLedgerV29 {
  private records: ModelUsageRecordV29[] = [];
  private dailyBudgetUsd: number | null = null;
  private sessionBudgets = new Map<string, number>();
  private counter = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** So ban ghi da luu. */
  get size(): number {
    return this.records.length;
  }

  /** Ghi mot luot dung; tra ban ghi (id duy nhat trong ledger). */
  recordUsage(input: RecordUsageInputV29): ModelUsageRecordV29 {
    if (!input.modelId || input.modelId.trim() === '') {
      throw new Error('modelId khong duoc rong.');
    }
    if (!input.provider || input.provider.trim() === '') {
      throw new Error('provider khong duoc rong.');
    }
    if (!input.sessionId || input.sessionId.trim() === '') {
      throw new Error('sessionId khong duoc rong.');
    }
    const inputTokens = Math.max(0, Math.floor(input.inputTokens ?? 0));
    const outputTokens = Math.max(0, Math.floor(input.outputTokens ?? 0));
    const minutes = Math.max(0, input.minutes ?? 0);
    const inputPrice = input.inputPricePer1kUsd ?? 0;
    const outputPrice = input.outputPricePer1kUsd ?? 0;
    const perMinute = input.perMinuteUsd ?? 0;
    if (inputPrice < 0 || outputPrice < 0 || perMinute < 0) {
      throw new Error('Gia (input/output/phut) phai >= 0.');
    }
    if (input.costUsdOverride !== undefined && (input.costUsdOverride < 0 || !Number.isFinite(input.costUsdOverride))) {
      throw new Error('costUsdOverride phai >= 0.');
    }
    const createdAt = input.createdAt ?? this.now();
    const day = input.day ?? dayOfTimestampV29(createdAt);
    if (!isValidDayV29(day)) throw new Error(`day khong hop le: "${day}" (can YYYY-MM-DD).`);
    const costUsd = input.costUsdOverride !== undefined
      ? input.costUsdOverride
      : (inputTokens / 1000) * inputPrice + (outputTokens / 1000) * outputPrice + minutes * perMinute;
    this.counter += 1;
    const record: ModelUsageRecordV29 = {
      id: `v29-${createdAt}-${this.counter}`,
      modelId: input.modelId,
      provider: input.provider,
      sessionId: input.sessionId,
      day,
      inputTokens,
      outputTokens,
      minutes,
      costUsd,
      createdAt,
      ...(input.label !== undefined ? { label: input.label } : {}),
    };
    this.records.push(record);
    return record;
  }

  /** Tong chi phi tat ca ban ghi (USD). */
  totalCost(): number {
    return this.records.reduce((sum, r) => sum + r.costUsd, 0);
  }

  /** Chi phi cua mot model (USD). */
  costByModel(modelId: string): number {
    return this.records.filter((r) => r.modelId === modelId).reduce((s, r) => s + r.costUsd, 0);
  }

  /** Chi phi mot ngay YYYY-MM-DD (USD). */
  costByDay(day: string): number {
    return this.records.filter((r) => r.day === day).reduce((s, r) => s + r.costUsd, 0);
  }

  /** Chi phi mot phien (USD). */
  costBySession(sessionId: string): number {
    return this.records.filter((r) => r.sessionId === sessionId).reduce((s, r) => s + r.costUsd, 0);
  }

  /** Chi phi mot provider (USD). */
  costByProvider(provider: string): number {
    return this.records.filter((r) => r.provider === provider).reduce((s, r) => s + r.costUsd, 0);
  }

  /** Bao cao tong hop day du (sap xep giam dan theo chi phi). */
  summary(): CostLedgerSummaryV29 {
    const byModel = bucketize(this.records, (r) => r.modelId);
    const byDay = bucketize(this.records, (r) => r.day);
    const bySession = bucketize(this.records, (r) => r.sessionId);
    const byProvider = bucketize(this.records, (r) => r.provider);
    return {
      totalUsd: this.totalCost(),
      totalCalls: this.records.length,
      totalInputTokens: this.records.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: this.records.reduce((s, r) => s + r.outputTokens, 0),
      totalMinutes: this.records.reduce((s, r) => s + r.minutes, 0),
      byModel,
      byDay,
      bySession,
      byProvider,
      topModelId: byModel.length > 0 ? byModel[0].key : null,
      topDay: byDay.length > 0 ? byDay[0].key : null,
    };
  }

  /** Dat ngan sach ngay (USD); null = bo gioi han. */
  setDailyBudget(usd: number | null): void {
    if (usd !== null && (!Number.isFinite(usd) || usd < 0)) {
      throw new Error('Ngan sach ngay phai >= 0 hoac null.');
    }
    this.dailyBudgetUsd = usd;
  }

  getDailyBudget(): number | null {
    return this.dailyBudgetUsd;
  }

  /** Dat ngan sach rieng cho mot phien (USD). */
  setSessionBudget(sessionId: string, usd: number): void {
    if (!sessionId) throw new Error('sessionId khong duoc rong.');
    if (!Number.isFinite(usd) || usd < 0) throw new Error('Ngan sach phien phai >= 0.');
    this.sessionBudgets.set(sessionId, usd);
  }

  getSessionBudget(sessionId: string): number | undefined {
    return this.sessionBudgets.get(sessionId);
  }

  /**
   * Kiem tra ngan sach: ngay `day` (mac dinh hom nay) + cac phien
   * da dat ngan sach. `dailyNearLimit` bat khi dung >= 80%.
   */
  checkBudget(day?: string): BudgetCheckV29 {
    const targetDay = day ?? dayOfTimestampV29(this.now());
    const dailyUsedUsd = this.costByDay(targetDay);
    const sessionsOverBudget: BudgetCheckV29['sessionsOverBudget'] = [];
    for (const [sessionId, budget] of this.sessionBudgets) {
      const used = this.costBySession(sessionId);
      if (used > budget) sessionsOverBudget.push({ sessionId, usedUsd: used, budgetUsd: budget });
    }
    sessionsOverBudget.sort((a, b) => b.usedUsd - a.usedUsd);
    const overDaily = this.dailyBudgetUsd !== null && dailyUsedUsd > this.dailyBudgetUsd;
    const dailyNearLimit =
      this.dailyBudgetUsd !== null &&
      this.dailyBudgetUsd > 0 &&
      dailyUsedUsd >= this.dailyBudgetUsd * 0.8;
    return {
      dailyBudgetUsd: this.dailyBudgetUsd,
      dailyUsedUsd,
      dailyRemainingUsd: this.dailyBudgetUsd !== null ? this.dailyBudgetUsd - dailyUsedUsd : null,
      overDaily,
      sessionsOverBudget,
      dailyNearLimit,
    };
  }

  /** Xoa ban ghi co ngay < `day` (YYYY-MM-DD); tra so dong da xoa. */
  pruneBefore(day: string): number {
    if (!isValidDayV29(day)) throw new Error(`day khong hop le: "${day}".`);
    const before = this.records.length;
    this.records = this.records.filter((r) => r.day >= day);
    return before - this.records.length;
  }

  /** Ban ghi theo ngay (sap xep theo thoi gian). */
  recordsOnDay(day: string): ModelUsageRecordV29[] {
    return this.records.filter((r) => r.day === day).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Tat ca ban ghi (ban sao, khong doi duoc ledger qua mang tra ve). */
  allRecords(): ModelUsageRecordV29[] {
    return [...this.records];
  }

  /** Xoa toan bo ban ghi + ngan sach phien (giu ngan sach ngay). */
  clear(): void {
    this.records = [];
  }

  /** Serialize de luu tru (JSON-safe). */
  toJSON(): {
    records: ModelUsageRecordV29[];
    dailyBudgetUsd: number | null;
    sessionBudgets: [string, number][];
    counter: number;
  } {
    return {
      records: this.allRecords(),
      dailyBudgetUsd: this.dailyBudgetUsd,
      sessionBudgets: [...this.sessionBudgets.entries()],
      counter: this.counter,
    };
  }

  /** Tai lai tu toJSON (bo qua ban ghi sai dinh dang, dem so bo qua). */
  static fromJSON(data: unknown): { ledger: ModelCostLedgerV29; skipped: number } {
    const ledger = new ModelCostLedgerV29();
    let skipped = 0;
    if (!data || typeof data !== 'object') return { ledger, skipped: 1 };
    const obj = data as {
      records?: unknown;
      dailyBudgetUsd?: unknown;
      sessionBudgets?: unknown;
      counter?: unknown;
    };
    if (typeof obj.dailyBudgetUsd === 'number' && obj.dailyBudgetUsd >= 0) {
      ledger.dailyBudgetUsd = obj.dailyBudgetUsd;
    }
    if (Array.isArray(obj.sessionBudgets)) {
      for (const entry of obj.sessionBudgets) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number' && entry[1] >= 0) {
          ledger.sessionBudgets.set(entry[0], entry[1]);
        } else skipped += 1;
      }
    }
    if (Array.isArray(obj.records)) {
      for (const raw of obj.records) {
        if (
          raw && typeof raw === 'object' &&
          typeof (raw as ModelUsageRecordV29).modelId === 'string' &&
          typeof (raw as ModelUsageRecordV29).provider === 'string' &&
          typeof (raw as ModelUsageRecordV29).sessionId === 'string' &&
          typeof (raw as ModelUsageRecordV29).day === 'string' &&
          isValidDayV29((raw as ModelUsageRecordV29).day) &&
          typeof (raw as ModelUsageRecordV29).costUsd === 'number'
        ) {
          ledger.records.push(raw as ModelUsageRecordV29);
        } else skipped += 1;
      }
    }
    if (typeof obj.counter === 'number' && obj.counter >= 0) ledger.counter = Math.floor(obj.counter);
    return { ledger, skipped };
  }
}
