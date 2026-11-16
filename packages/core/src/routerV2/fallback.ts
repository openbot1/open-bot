/**
 * Fallback chain + circuit breaker + health check (v1.16, Doi T3).
 *
 * Thu tu mac dinh: cloud provider -> CLI agent -> local model -> loi
 * co huong dan. Moi nguon co circuit breaker rieng:
 * - closed: dung binh thuong; du so loi lien tiep (>= threshold) thi mo.
 * - open: bo qua luon (khong goi nguon dang hong, tranh cho lau);
 *   sau resetTimeout thi chuyen half-open.
 * - half-open: cho thu 1 request; thanh cong -> closed (reset dem),
 *   loi -> open lai.
 * Health check dinh ky cap nhat lastHealthyAt/lastCheckedAt.
 *
 * Spend tracking noi tiep budget v1.15 (LocalBudgetTracker): moi call
 * thanh cong ghi spend theo token x gia cau hinh; budget gate chan
 * truoc khi goi nguon cloud dat tien (local/CLI re thi van ghi so de
 * so sanh, khong chan).
 */

import { LocalBudgetTracker, costOfCall } from '../router/local/budget';
import type { FallbackAttempt, FallbackResult, FallbackSourceKind, SourceHealth } from './types';

/** Thu tu fallback mac dinh. */
export const DEFAULT_FALLBACK_ORDER: FallbackSourceKind[] = ['cloud', 'cli', 'local'];

/** Nguong loi mac dinh de mo circuit. */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/** Thoi gian circuit mo truoc khi thu lai (ms). */
export const DEFAULT_RESET_TIMEOUT_MS = 60_000;

/** Ket qua thu mot nguon (do executor tra ve). */
export interface SourceCallResult {
  ok: boolean;
  /** Thong diep loi (neu fail) — da cat ngan, khong secret. */
  error?: string;
  /** Token da dung (de ghi spend). */
  promptTokens?: number;
  completionTokens?: number;
  /** Gia uoc tinh (USD / 1k token) cho nguon nay. */
  pricePer1kTokensUsd?: number;
}

/** Ham thu chay mot request qua mot nguon (injectable de test). */
export type SourceExecutor = (
  source: FallbackSourceKind,
  sourceId: string,
) => Promise<SourceCallResult>;

/** Ham health check mot nguon (injectable). */
export type SourceHealthChecker = (source: FallbackSourceKind, sourceId: string) => Promise<boolean>;

/**
 * CircuitBreaker cho mot nguon. Thuan ve logic (khong phu thuoc
 * thoi gian that — `now` injectable de test).
 */
export class CircuitBreaker {
  readonly source: FallbackSourceKind;
  readonly sourceId: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private failures = 0;
  private openedAt: number | null = null;
  private halfOpenTrialInFlight = false;
  private lastError?: string;

  constructor(source: FallbackSourceKind, sourceId: string, opts?: { failureThreshold?: number; resetTimeoutMs?: number }) {
    this.source = source;
    this.sourceId = sourceId;
    this.failureThreshold = opts?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = opts?.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
  }

  /** Trang thai hien tai tai thoi diem `now`. */
  state(now: number = Date.now()): 'closed' | 'open' | 'half-open' {
    if (this.openedAt === null) return 'closed';
    if (now - this.openedAt >= this.resetTimeoutMs) return 'half-open';
    return 'open';
  }

  /** Co duoc phep thu request luc `now` khong. */
  allowRequest(now: number = Date.now()): boolean {
    const s = this.state(now);
    if (s === 'closed') return true;
    if (s === 'open') return false;
    // half-open: chi 1 trial tai mot thoi diem.
    if (this.halfOpenTrialInFlight) return false;
    this.halfOpenTrialInFlight = true;
    return true;
  }

  /** Ghi thanh cong: dong circuit, reset dem. */
  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.halfOpenTrialInFlight = false;
    this.lastError = undefined;
  }

  /** Ghi that bai: tang dem; du nguong thi mo circuit. */
  recordFailure(error: string, now: number = Date.now()): void {
    this.failures += 1;
    this.lastError = error.slice(0, 300);
    this.halfOpenTrialInFlight = false;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = now;
    }
  }

  getConsecutiveFailures(): number {
    return this.failures;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  getOpenedAt(): number | null {
    return this.openedAt;
  }

  /** Mo circuit ngay (vd health check bao hong). */
  forceOpen(now: number = Date.now()): void {
    this.openedAt = now;
    this.halfOpenTrialInFlight = false;
  }

  /** Dong circuit bang tay (vd user bat lai nguon). */
  reset(): void {
    this.failures = 0;
    this.openedAt = null;
    this.halfOpenTrialInFlight = false;
    this.lastError = undefined;
  }

  toHealth(now: number = Date.now()): SourceHealth {
    return {
      source: this.source,
      sourceId: this.sourceId,
      circuit: this.state(now),
      consecutiveFailures: this.failures,
      failureThreshold: this.failureThreshold,
      openedAt: this.openedAt ?? undefined,
      resetTimeoutMs: this.resetTimeoutMs,
      lastError: this.lastError,
    };
  }
}

/** Nguon trong chain: dinh danh + co duoc user bat khong. */
export interface FallbackSourceDef {
  source: FallbackSourceKind;
  sourceId: string;
  /** false = user tat nguon nay (khong bao gio thu). */
  enabled: boolean;
}

/**
 * FallbackChain — chay request qua cac nguon theo thu tu, ghi spend
 * vao budget tracker, tra ket qua + huong dan khi tat ca deu loi.
 */
export class FallbackChain {
  private readonly sources: FallbackSourceDef[];
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly executor: SourceExecutor;
  private readonly budget: LocalBudgetTracker | null;
  private readonly healthState = new Map<string, { lastHealthyAt?: number; lastCheckedAt?: number }>();

  constructor(opts: {
    sources: FallbackSourceDef[];
    executor: SourceExecutor;
    budget?: LocalBudgetTracker;
    failureThreshold?: number;
    resetTimeoutMs?: number;
  }) {
    this.sources = opts.sources.map((s) => ({ ...s }));
    this.executor = opts.executor;
    this.budget = opts.budget ?? null;
    for (const s of this.sources) {
      this.breakers.set(
        s.sourceId,
        new CircuitBreaker(s.source, s.sourceId, {
          failureThreshold: opts.failureThreshold,
          resetTimeoutMs: opts.resetTimeoutMs,
        }),
      );
    }
  }

  listSources(): FallbackSourceDef[] {
    return this.sources.map((s) => ({ ...s }));
  }

  setSourceEnabled(sourceId: string, enabled: boolean): boolean {
    const def = this.sources.find((s) => s.sourceId === sourceId);
    if (!def) return false;
    def.enabled = enabled;
    return true;
  }

  getBreaker(sourceId: string): CircuitBreaker | undefined {
    return this.breakers.get(sourceId);
  }

  /** Health cua tat ca nguon (de UI ve). */
  healthSnapshot(now: number = Date.now()): SourceHealth[] {
    return this.sources.map((s) => {
      const breaker = this.breakers.get(s.sourceId);
      const base = breaker
        ? breaker.toHealth(now)
        : {
            source: s.source,
            sourceId: s.sourceId,
            circuit: 'closed' as const,
            consecutiveFailures: 0,
            failureThreshold: DEFAULT_FAILURE_THRESHOLD,
            resetTimeoutMs: DEFAULT_RESET_TIMEOUT_MS,
          };
      const extra = this.healthState.get(s.sourceId);
      return { ...base, lastHealthyAt: extra?.lastHealthyAt, lastCheckedAt: extra?.lastCheckedAt };
    });
  }

  /**
   * Health check tat ca nguon: thanh cong -> recordSuccess (dong
   * circuit neu dang mo qua timeout); that bai -> recordFailure.
   */
  async healthCheckAll(
    checker: SourceHealthChecker,
    now: number = Date.now(),
  ): Promise<{ sourceId: string; healthy: boolean }[]> {
    const results: { sourceId: string; healthy: boolean }[] = [];
    for (const s of this.sources) {
      const breaker = this.breakers.get(s.sourceId);
      let healthy = false;
      try {
        healthy = await checker(s.source, s.sourceId);
      } catch {
        healthy = false;
      }
      const state = this.healthState.get(s.sourceId) ?? {};
      state.lastCheckedAt = now;
      if (healthy) {
        state.lastHealthyAt = now;
        breaker?.recordSuccess();
      } else {
        breaker?.recordFailure('health check failed', now);
      }
      this.healthState.set(s.sourceId, state);
      results.push({ sourceId: s.sourceId, healthy });
    }
    return results;
  }

  /**
   * Chay request qua chain. Dung khi budget gate chan cloud: bo qua
   * cloud (skipped-budget) nhung van thu CLI/local. `botId` de ghi
   * spend dung bot.
   */
  async run(opts?: {
    order?: FallbackSourceKind[];
    botId?: string;
    budgetGate?: (source: FallbackSourceKind, sourceId: string) => boolean;
    now?: () => number;
  }): Promise<FallbackResult> {
    const nowFn = opts?.now ?? Date.now;
    const order = opts?.order ?? DEFAULT_FALLBACK_ORDER;
    const startedAt = nowFn();
    const attempts: FallbackAttempt[] = [];
    // Thu theo thu tu `order`, trong moi loai lay cac nguon theo thu
    // tu khai bao (vd 2 cloud provider thi thu ca hai truoc khi xuong CLI).
    const orderedSources = [...this.sources].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
    for (const def of orderedSources) {
      const attemptStarted = nowFn();
      const breaker = this.breakers.get(def.sourceId);
      if (!def.enabled) {
        attempts.push({ source: def.source, sourceId: def.sourceId, outcome: 'skipped-disabled', latencyMs: 0, attemptedAt: attemptStarted });
        continue;
      }
      if (opts?.budgetGate && !opts.budgetGate(def.source, def.sourceId)) {
        attempts.push({ source: def.source, sourceId: def.sourceId, outcome: 'skipped-budget', latencyMs: 0, attemptedAt: attemptStarted });
        continue;
      }
      if (breaker && !breaker.allowRequest(nowFn())) {
        attempts.push({ source: def.source, sourceId: def.sourceId, outcome: 'skipped-circuit-open', latencyMs: 0, attemptedAt: attemptStarted });
        continue;
      }
      let result: SourceCallResult;
      try {
        result = await this.executor(def.source, def.sourceId);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const latencyMs = nowFn() - attemptStarted;
      if (result.ok) {
        breaker?.recordSuccess();
        const costUsd =
          result.pricePer1kTokensUsd !== undefined
            ? costOfCall(result.promptTokens ?? 0, result.completionTokens ?? 0, result.pricePer1kTokensUsd)
            : undefined;
        if (this.budget && costUsd !== undefined) {
          // SpendRecord chi co kind 'local' | 'cloud': CLI chay tren
          // may user nen tinh nhu local (gia cau hinh cua tracker).
          this.budget.recordSpend({
            botId: opts?.botId ?? 'default-bot',
            modelId: def.sourceId,
            kind: def.source === 'cloud' ? 'cloud' : 'local',
            promptTokens: result.promptTokens ?? 0,
            completionTokens: result.completionTokens ?? 0,
          });
        }
        attempts.push({ source: def.source, sourceId: def.sourceId, outcome: 'success', latencyMs, attemptedAt: attemptStarted });
        return {
          ok: true,
          servedBy: def.source,
          servedById: def.sourceId,
          attempts,
          costUsd,
          totalLatencyMs: nowFn() - startedAt,
        };
      }
      const errorText = (result.error ?? 'Loi khong ro').slice(0, 300);
      breaker?.recordFailure(errorText, nowFn());
      attempts.push({ source: def.source, sourceId: def.sourceId, outcome: 'failed', error: errorText, latencyMs, attemptedAt: attemptStarted });
    }
    return {
      ok: false,
      attempts,
      guidance: buildFailureGuidance(attempts),
      totalLatencyMs: nowFn() - startedAt,
    };
  }
}

/**
 * Huong dan khi tat ca nguon deu loi — dua tren ly do tung buoc de
 * user biet sua cai gi (bat nguon nao, nap budget, cai model...).
 */
export function buildFailureGuidance(attempts: FallbackAttempt[]): string {
  if (attempts.length === 0) return 'Chua co nguon nao duoc cau hinh — them provider cloud, bat CLI agent, hoac tai model local.';
  const failed = attempts.filter((a) => a.outcome === 'failed');
  const skippedBudget = attempts.filter((a) => a.outcome === 'skipped-budget');
  const skippedCircuit = attempts.filter((a) => a.outcome === 'skipped-circuit-open');
  const disabled = attempts.filter((a) => a.outcome === 'skipped-disabled');
  const parts: string[] = ['Tat ca nguon deu khong tra loi duoc.'];
  if (skippedBudget.length > 0) {
    parts.push(`Nguon ${skippedBudget.map((a) => a.sourceId).join(', ')} bi chan boi budget — tang budget hoac doi chu ky moi.`);
  }
  if (skippedCircuit.length > 0) {
    parts.push(`Nguon ${skippedCircuit.map((a) => a.sourceId).join(', ')} dang bi circuit breaker mo sau nhieu loi lien tiep — cho 1 phut roi thu lai, hoac kiem tra provider.`);
  }
  if (disabled.length === attempts.length) {
    parts.push('Tat ca nguon dang bi tat — bat it nhat mot nguon trong Settings → Router.');
  }
  if (failed.length > 0) {
    parts.push(
      `Loi tung nguon: ${failed.map((a) => `${a.sourceId} (${a.error ?? 'khong ro'})`).join('; ')}. Kiem tra mang, key provider, CLI agent co dang chay khong, model local co duoc load khong.`,
    );
  }
  parts.push('Neu van loi, thu model local nho (qwen3-4b) de chay offline hoan toan.');
  return parts.join(' ');
}
