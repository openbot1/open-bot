/**
 * Budget + spend tracking noi bo (v1.15, Doi T3).
 *
 * Y tuong (LiteLLM gateway pattern): virtual key per bot, budget
 * theo ngay/thang, ghi spend theo tung call (token x gia cau hinh),
 * canh bao khi vuot nguong, bao cao tong hop. Hoan toan local — khong
 * goi dich vu ngoai; gia cloud lay tu bang gia cau hinh (co the doi).
 * Tien local tinh theo gia dien/khau hao cau hinh (mac dinh gan nhu
 * mien phi nhung van ghi so de so sanh).
 */

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_POLICY_CONFIG,
  type BudgetLimit,
  type LocalBudgetStatus,
  type SpendRecord,
  type SpendReport,
  type VirtualKey,
} from './types';

/** Gia mac dinh de tinh spend (USD / 1k token) — host co the override. */
export const DEFAULT_PRICE_TABLE: Record<string, number> = {
  // Local (dien + khau hao).
  local: 0.0001,
  // Cloud — dong bo voi DEFAULT_CLOUD_PRICES trong policy.ts.
  'grok-4.7': 0.003,
  'claude-sonnet-4.5': 0.003,
  'gpt-5': 0.005,
  'gemini-2.5-flash': 0.0003,
  'gemini-2.5-pro': 0.00125,
};

/** Gia mac dinh khi model khong co trong bang. */
export const UNKNOWN_MODEL_PRICE_PER_1K_USD = 0.001;

/** Lay gia 1k token cho mot model (local dung gia 'local'). */
export function pricePer1kTokens(
  modelId: string,
  kind: 'local' | 'cloud',
  priceTable: Record<string, number> = DEFAULT_PRICE_TABLE,
): number {
  if (kind === 'local') return priceTable.local ?? DEFAULT_POLICY_CONFIG.localCostPer1kTokensUsd;
  return priceTable[modelId] ?? UNKNOWN_MODEL_PRICE_PER_1K_USD;
}

/** Tinh chi phi mot call (USD) tu token + gia. */
export function costOfCall(
  promptTokens: number,
  completionTokens: number,
  pricePer1kUsd: number,
): number {
  const total = Math.max(0, promptTokens) + Math.max(0, completionTokens);
  return (total / 1000) * pricePer1kUsd;
}

/** Dau + cuoi cua window daily/monthly chua timestamp `at`. */
export function budgetWindow(period: 'daily' | 'monthly', at = Date.now()): { start: number; end: number } {
  const d = new Date(at);
  if (period === 'daily') {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { start, end: start + 24 * 60 * 60 * 1000 };
  }
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return { start, end };
}

/** Ket qua kiem tra truoc khi cho phep call (gateway goi truoc moi request). */
export interface BudgetGate {
  allowed: boolean;
  reason: string;
  status: LocalBudgetStatus;
}

/**
 * LocalBudgetTracker — ghi spend, kiem tra ngan sach, bao cao.
 * Luu in-memory; `toJSON`/`fromJSON` de host persist xuong disk.
 */
export class LocalBudgetTracker {
  private records: SpendRecord[] = [];
  private readonly priceTable: Record<string, number>;
  /** Budget toan cuc (ap dung cho moi bot neu bot khong co budget rieng). */
  private globalBudget: BudgetLimit | null = null;
  /** Budget rieng theo bot. */
  private readonly botBudgets = new Map<string, BudgetLimit>();
  /** Virtual key theo id. */
  private readonly keys = new Map<string, VirtualKey>();
  /** So request trong phut hien tai (rate limit don gian, theo key). */
  private readonly rateCounts = new Map<string, { minute: number; count: number }>();

  constructor(opts?: { priceTable?: Record<string, number>; globalBudget?: BudgetLimit }) {
    this.priceTable = { ...DEFAULT_PRICE_TABLE, ...(opts?.priceTable ?? {}) };
    if (opts?.globalBudget) this.globalBudget = { ...opts.globalBudget };
  }

  getPriceTable(): Record<string, number> {
    return { ...this.priceTable };
  }

  setGlobalBudget(budget: BudgetLimit | null): void {
    this.globalBudget = budget ? { ...budget } : null;
  }

  getGlobalBudget(): BudgetLimit | null {
    return this.globalBudget ? { ...this.globalBudget } : null;
  }

  setBotBudget(botId: string, budget: BudgetLimit): void {
    this.botBudgets.set(botId, { ...budget });
  }

  getBotBudget(botId: string): BudgetLimit | null {
    return this.botBudgets.get(botId) ?? this.globalBudget;
  }

  removeBotBudget(botId: string): boolean {
    return this.botBudgets.delete(botId);
  }

  /** Tao virtual key cho mot bot (tra key day du 1 lan — host phai luu vao Vault). */
  createVirtualKey(botId: string, opts?: { budget?: BudgetLimit; expiresAt?: number }): { key: VirtualKey; secret: string } {
    const secret = `obk_${randomUUID().replace(/-/g, '')}`;
    const key: VirtualKey = {
      id: randomUUID(),
      botId,
      keyHint: `${secret.slice(0, 7)}...${secret.slice(-4)}`,
      budget: opts?.budget ?? this.getBotBudget(botId) ?? { period: 'monthly', limitUsd: 10, warnAt: 0.8, blockOnExceed: true },
      revoked: false,
      createdAt: Date.now(),
      expiresAt: opts?.expiresAt,
    };
    // Luu secret hash don gian (khong luu plaintext trong tracker):
    // host luu secret vao Vault; tracker chi giu hint + map secret->id
    // trong bo nho chay (mat khi restart — dung cho gateway session).
    this.keys.set(key.id, key);
    this.keySecrets.set(secret, key.id);
    return { key, secret };
  }

  private readonly keySecrets = new Map<string, string>();

  /** Tim key theo secret (gateway auth). undefined = khong hop le. */
  resolveKey(secret: string): VirtualKey | undefined {
    const id = this.keySecrets.get(secret);
    if (!id) return undefined;
    const key = this.keys.get(id);
    if (!key || key.revoked) return undefined;
    if (key.expiresAt && Date.now() > key.expiresAt) return undefined;
    return key;
  }

  revokeKey(keyId: string): boolean {
    const key = this.keys.get(keyId);
    if (!key) return false;
    key.revoked = true;
    return true;
  }

  listKeys(botId?: string): VirtualKey[] {
    return [...this.keys.values()].filter((k) => !botId || k.botId === botId);
  }

  /** Ghi mot dong spend (goi sau moi call). Tra record da ghi. */
  recordSpend(input: {
    botId: string;
    modelId: string;
    kind: 'local' | 'cloud';
    promptTokens: number;
    completionTokens: number;
    virtualKeyId?: string;
    at?: number;
  }): SpendRecord {
    const price = pricePer1kTokens(input.modelId, input.kind, this.priceTable);
    const record: SpendRecord = {
      id: randomUUID(),
      botId: input.botId,
      modelId: input.modelId,
      kind: input.kind,
      promptTokens: Math.max(0, input.promptTokens),
      completionTokens: Math.max(0, input.completionTokens),
      costUsd: costOfCall(input.promptTokens, input.completionTokens, price),
      virtualKeyId: input.virtualKeyId,
      at: input.at ?? Date.now(),
    };
    this.records.push(record);
    return record;
  }

  /** Tong spend trong window (loc theo bot neu co). */
  spentInWindow(period: 'daily' | 'monthly', at = Date.now(), botId?: string): number {
    const { start, end } = budgetWindow(period, at);
    let total = 0;
    for (const r of this.records) {
      if (r.at >= start && r.at < end && (!botId || r.botId === botId)) total += r.costUsd;
    }
    return total;
  }

  /** Trang thai ngan sach cua mot bot (hoac toan cuc). */
  status(botId?: string, at = Date.now()): LocalBudgetStatus {
    const budget = botId ? this.getBotBudget(botId) : this.globalBudget;
    // Ca bot + toan cuc deu khong co budget -> unlimited.
    const effective = budget ?? null;
    if (!effective || effective.limitUsd <= 0) {
      const period: 'daily' | 'monthly' = effective?.period ?? 'monthly';
      const { start, end } = budgetWindow(period, at);
      return {
        period,
        limitUsd: 0,
        spentUsd: this.spentInWindow(period, at, botId),
        remainingUsd: Number.POSITIVE_INFINITY,
        usageRatio: 0,
        state: 'unlimited',
        windowStart: start,
        windowEnd: end,
      };
    }
    const { start, end } = budgetWindow(effective.period, at);
    const spent = this.spentInWindow(effective.period, at, botId);
    const ratio = spent / effective.limitUsd;
    const state: LocalBudgetStatus['state'] =
      ratio >= 1 ? 'exceeded' : ratio >= effective.warnAt ? 'warning' : 'ok';
    return {
      period: effective.period,
      limitUsd: effective.limitUsd,
      spentUsd: spent,
      remainingUsd: Math.max(0, effective.limitUsd - spent),
      usageRatio: ratio,
      state,
      windowStart: start,
      windowEnd: end,
    };
  }

  /** Tong spend cua mot virtual key trong window cua budget key do. */
  spentForKey(key: VirtualKey, at = Date.now()): number {
    const { start, end } = budgetWindow(key.budget.period, at);
    let total = 0;
    for (const r of this.records) {
      if (r.virtualKeyId === key.id && r.at >= start && r.at < end) total += r.costUsd;
    }
    return total;
  }

  /** Trang thai budget cua mot virtual key (doc lap voi budget bot). */
  keyStatus(key: VirtualKey, at = Date.now()): LocalBudgetStatus {
    const { start, end } = budgetWindow(key.budget.period, at);
    const spent = this.spentForKey(key, at);
    const limit = key.budget.limitUsd;
    if (limit <= 0) {
      return { period: key.budget.period, limitUsd: 0, spentUsd: spent, remainingUsd: Number.POSITIVE_INFINITY, usageRatio: 0, state: 'unlimited', windowStart: start, windowEnd: end };
    }
    const ratio = spent / limit;
    return {
      period: key.budget.period,
      limitUsd: limit,
      spentUsd: spent,
      remainingUsd: Math.max(0, limit - spent),
      usageRatio: ratio,
      state: ratio >= 1 ? 'exceeded' : ratio >= key.budget.warnAt ? 'warning' : 'ok',
      windowStart: start,
      windowEnd: end,
    };
  }

  /** Gate truoc moi call: chan neu da vuot budget (va blockOnExceed). */
  gate(botId?: string, at = Date.now()): BudgetGate {
    const s = this.status(botId, at);
    if (s.state === 'exceeded') {
      const budget = botId ? this.getBotBudget(botId) : this.globalBudget;
      if (budget?.blockOnExceed) {
        return {
          allowed: false,
          reason: `Budget ${s.period} da vuot: da dung $${s.spentUsd.toFixed(4)} / $${s.limitUsd.toFixed(2)}.`,
          status: s,
        };
      }
      return { allowed: true, reason: `Budget ${s.period} da vuot nhung blockOnExceed=false — cho phep va ghi log.`, status: s };
    }
    if (s.state === 'warning') {
      return { allowed: true, reason: `Budget ${s.period} dat ${(s.usageRatio * 100).toFixed(0)}% ($${s.spentUsd.toFixed(4)} / $${s.limitUsd.toFixed(2)}).`, status: s };
    }
    return { allowed: true, reason: 'Trong ngan sach.', status: s };
  }

  /** Rate limit don gian theo key: toi da `limitPerMinute` request/phut. */
  checkRateLimit(keyId: string, limitPerMinute: number, at = Date.now()): boolean {
    if (limitPerMinute <= 0) return true;
    const minute = Math.floor(at / 60_000);
    const cur = this.rateCounts.get(keyId);
    if (!cur || cur.minute !== minute) {
      this.rateCounts.set(keyId, { minute, count: 1 });
      return true;
    }
    if (cur.count >= limitPerMinute) return false;
    cur.count += 1;
    return true;
  }

  /** Bao cao tong hop trong window. */
  report(period: 'daily' | 'monthly', at = Date.now(), botId?: string): SpendReport {
    const { start, end } = budgetWindow(period, at);
    const inWindow = this.records.filter(
      (r) => r.at >= start && r.at < end && (!botId || r.botId === botId),
    );
    const byModel = new Map<string, { calls: number; tokens: number; costUsd: number }>();
    const byBot = new Map<string, { calls: number; tokens: number; costUsd: number }>();
    let totalUsd = 0;
    let totalTokens = 0;
    let localUsd = 0;
    let cloudUsd = 0;
    for (const r of inWindow) {
      totalUsd += r.costUsd;
      totalTokens += r.promptTokens + r.completionTokens;
      if (r.kind === 'local') localUsd += r.costUsd;
      else cloudUsd += r.costUsd;
      const m = byModel.get(r.modelId) ?? { calls: 0, tokens: 0, costUsd: 0 };
      m.calls += 1;
      m.tokens += r.promptTokens + r.completionTokens;
      m.costUsd += r.costUsd;
      byModel.set(r.modelId, m);
      const b = byBot.get(r.botId) ?? { calls: 0, tokens: 0, costUsd: 0 };
      b.calls += 1;
      b.tokens += r.promptTokens + r.completionTokens;
      b.costUsd += r.costUsd;
      byBot.set(r.botId, b);
    }
    return {
      period,
      windowStart: start,
      windowEnd: end,
      totalUsd,
      totalCalls: inWindow.length,
      totalTokens,
      byModel: [...byModel.entries()]
        .map(([modelId, v]) => ({ modelId, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd),
      byBot: [...byBot.entries()]
        .map(([botId2, v]) => ({ botId: botId2, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd),
      localUsd,
      cloudUsd,
    };
  }

  recordCount(): number {
    return this.records.length;
  }

  listRecords(botId?: string): SpendRecord[] {
    return this.records.filter((r) => !botId || r.botId === botId);
  }

  /** Xoa record cu hon `olderThanMs` (don dep dinh ky). Tra so da xoa. */
  pruneOlderThan(olderThanMs: number, now = Date.now()): number {
    const before = this.records.length;
    this.records = this.records.filter((r) => now - r.at <= olderThanMs);
    return before - this.records.length;
  }

  toJSON(): { records: SpendRecord[]; globalBudget: BudgetLimit | null; botBudgets: Array<[string, BudgetLimit]>; keys: VirtualKey[] } {
    return {
      records: this.records,
      globalBudget: this.globalBudget,
      botBudgets: [...this.botBudgets.entries()],
      // Luu y: secret khong persist o day — host luu secret vao Vault.
      keys: [...this.keys.values()],
    };
  }

  static fromJSON(
    data: { records?: SpendRecord[]; globalBudget?: BudgetLimit | null; botBudgets?: Array<[string, BudgetLimit]>; keys?: VirtualKey[] },
    opts?: { priceTable?: Record<string, number> },
  ): LocalBudgetTracker {
    const tracker = new LocalBudgetTracker(opts);
    tracker.records = [...(data.records ?? [])];
    tracker.globalBudget = data.globalBudget ?? null;
    for (const [botId, budget] of data.botBudgets ?? []) tracker.botBudgets.set(botId, { ...budget });
    for (const key of data.keys ?? []) tracker.keys.set(key.id, { ...key });
    return tracker;
  }
}
