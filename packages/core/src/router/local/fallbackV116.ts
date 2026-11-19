/**
 * Fallback chain v116 (v1.39, Doi T3) — tiep noi fallback tinh cua
 * PolicyRouter V115 (danh sach fallback co thu tu, nhung khong co
 * co che thu that + khong nho loi truoc do).
 *
 * V116 them vong doi that cua fallback:
 *
 * 1) Circuit breaker moi model: `closed` (binh thuong) -> `open`
 *    (tam dung sau N loi lien tiep) -> `half-open` (cho thu lai 1
 *    lan sau thoi gian reset) -> `closed` (neu thu lai thanh cong)
 *    hoac `open` lai (neu thu lai that bai). Model dang `open` se bi
 *    bo qua trong chain — khong lang phi thoi gian goi model da biet
 *    hong, va khong spam log loi.
 * 2) Exponential backoff co jitter: thoi gian cho truoc khi thu lai
 *    tang theo so lan that bai lien tiep (`baseMs * 2^n`, chan tran
 *    `maxMs`, jitter +-20% de cac bot khong dong loat thu lai cung luc).
 * 3) `LocalFallbackChain.attempt()`: chay tuan tu cac ung vien theo thu tu,
 *    dung executor do host inject (host quyet dinh "goi model" nghia
 *    la gi — goi that qua gateway, probe health, hay chay thu). Moi
 *    lan thu duoc ghi lai (model, thanh cong/that bai, latency, loi),
 *    tra ve model thang + toan bo lich su thu — UI hien thi duoc
 *    "da thu A (loi), B (loi), C (ok)".
 * 4) Lich su breaker serialize duoc (host luu xuong disk, khoi dong
 *    lai van nho model nao dang hong).
 *
 * Khong goi model that o day — executor la cua host. Mac dinh khong
 * co executor (tool layer inject executor probe-health).
 */

import type { RouteCandidate } from './types';

/** Trang thai circuit breaker. */
export type LocalCircuitState = 'closed' | 'open' | 'half-open';

/** Cau hinh circuit breaker + backoff. */
export interface LocalCircuitBreakerConfig {
  /** So loi lien tiep thi mo breaker (mac dinh 3). */
  failureThreshold: number;
  /** Thoi gian breaker mo truoc khi cho thu lai (ms, mac dinh 30s). */
  resetTimeoutMs: number;
  /** So lan thu lai thanh cong lien tiep de dong breaker (mac dinh 1). */
  successThreshold: number;
  /** Backoff co so (ms, mac dinh 1000). */
  backoffBaseMs: number;
  /** Backoff toi da (ms, mac dinh 30s). */
  backoffMaxMs: number;
  /** Jitter +- ti le (0..1, mac dinh 0.2). */
  backoffJitter: number;
}

/** Cau hinh mac dinh circuit breaker. */
export const DEFAULT_LOCAL_CIRCUIT_BREAKER_CONFIG: LocalCircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  successThreshold: 1,
  backoffBaseMs: 1000,
  backoffMaxMs: 30_000,
  backoffJitter: 0.2,
};

/**
 * Backoff: `baseMs * 2^attempt`, chan tran maxMs, cong jitter
 * ngau nhien trong [-jitter, +jitter]. `random` inject duoc de test
 * xac dinh (mac dinh Math.random).
 */
export function backoffDelayMs(
  attempt: number,
  config: LocalCircuitBreakerConfig = DEFAULT_LOCAL_CIRCUIT_BREAKER_CONFIG,
  random: () => number = Math.random,
): number {
  const attemptIndex = Math.max(0, Math.floor(attempt));
  const exponential = config.backoffBaseMs * 2 ** attemptIndex;
  const capped = Math.min(exponential, config.backoffMaxMs);
  const jitterRange = capped * Math.max(0, Math.min(1, config.backoffJitter));
  const jitter = (random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + jitter));
}

/** Snapshot trang thai mot breaker (de serialize / hien thi UI). */
export interface LocalCircuitBreakerSnapshot {
  modelId: string;
  state: LocalCircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalAttempts: number;
  totalFailures: number;
  openedAt: number | null;
  /** Thoi diem som nhat duoc thu lai (ms epoch); null khi closed. */
  nextRetryAt: number | null;
  lastError: string | null;
  lastAttemptAt: number | null;
}

/**
 * Circuit breaker cho mot model. `now` inject duoc (mac dinh
 * Date.now) de test khong phu thuoc dong ho that.
 */
export class ModelCircuitBreaker {
  readonly modelId: string;
  private readonly config: LocalCircuitBreakerConfig;
  private readonly now: () => number;
  private state: LocalCircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private totalAttempts = 0;
  private totalFailures = 0;
  private openedAt: number | null = null;
  private lastError: string | null = null;
  private lastAttemptAt: number | null = null;

  constructor(modelId: string, config?: Partial<LocalCircuitBreakerConfig>, now?: () => number) {
    this.modelId = modelId;
    this.config = { ...DEFAULT_LOCAL_CIRCUIT_BREAKER_CONFIG, ...config };
    this.now = now ?? Date.now;
  }

  getState(): LocalCircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  getConfig(): LocalCircuitBreakerConfig {
    return { ...this.config };
  }

  /** Co duoc phep thu model nay ngay bay gio khong. */
  canAttempt(): boolean {
    return this.getState() !== 'open';
  }

  /** Thoi diem som nhat duoc thu lai (null khi dang closed). */
  nextRetryAt(): number | null {
    if (this.state === 'closed') return null;
    if (this.openedAt === null) return null;
    return this.openedAt + this.config.resetTimeoutMs;
  }

  /** Ghi mot lan thu thanh cong. */
  recordSuccess(latencyMs?: number): void {
    void latencyMs;
    this.totalAttempts += 1;
    this.lastAttemptAt = this.now();
    this.lastError = null;
    this.consecutiveFailures = 0;
    if (this.state === 'half-open') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.close();
      }
    } else {
      this.consecutiveSuccesses += 1;
      if (this.state === 'open') this.close();
    }
  }

  /** Ghi mot lan thu that bai (mo breaker khi du nguong). */
  recordFailure(error: string): void {
    this.totalAttempts += 1;
    this.totalFailures += 1;
    this.lastAttemptAt = this.now();
    this.lastError = error.slice(0, 500);
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    if (this.state === 'half-open') {
      this.open();
      return;
    }
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.open();
    }
  }

  /** Reset thu cong ve closed (vd user bam "thu lai ngay" tren UI). */
  reset(): void {
    this.close();
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastError = null;
  }

  snapshot(): LocalCircuitBreakerSnapshot {
    return {
      modelId: this.modelId,
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalAttempts: this.totalAttempts,
      totalFailures: this.totalFailures,
      openedAt: this.openedAt,
      nextRetryAt: this.nextRetryAt(),
      lastError: this.lastError,
      lastAttemptAt: this.lastAttemptAt,
    };
  }

  static fromSnapshot(
    snapshot: LocalCircuitBreakerSnapshot,
    config?: Partial<LocalCircuitBreakerConfig>,
    now?: () => number,
  ): ModelCircuitBreaker {
    const breaker = new ModelCircuitBreaker(snapshot.modelId, config, now);
    breaker.state = snapshot.state;
    breaker.consecutiveFailures = snapshot.consecutiveFailures;
    breaker.consecutiveSuccesses = snapshot.consecutiveSuccesses;
    breaker.totalAttempts = snapshot.totalAttempts;
    breaker.totalFailures = snapshot.totalFailures;
    breaker.openedAt = snapshot.openedAt;
    breaker.lastError = snapshot.lastError;
    breaker.lastAttemptAt = snapshot.lastAttemptAt;
    return breaker;
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.consecutiveSuccesses = 0;
  }

  private close(): void {
    this.state = 'closed';
    this.openedAt = null;
    this.consecutiveSuccesses = 0;
  }

  /** Het resetTimeout thi chuyen open -> half-open (cho thu lai 1 lan). */
  private maybeHalfOpen(): void {
    if (this.state !== 'open' || this.openedAt === null) return;
    if (this.now() >= this.openedAt + this.config.resetTimeoutMs) {
      this.state = 'half-open';
      this.consecutiveSuccesses = 0;
    }
  }
}

/** Ket qua mot lan thu trong chain. */
export interface LocalFallbackAttempt {
  modelId: string;
  kind: 'local' | 'cloud';
  /** 'success' | 'failed' | 'skipped-open' (breaker dang mo). */
  outcome: 'success' | 'failed' | 'skipped-open';
  latencyMs: number;
  error?: string;
  /** Thu tu trong chain (0 = model chinh). */
  index: number;
  at: number;
}

/** Ket qua chay het mot chain. */
export interface LocalFallbackChainResult {
  /** true = co model tra ket qua thanh cong. */
  succeeded: boolean;
  /** Model thang (null khi tat ca that bai/bi bo qua). */
  modelId: string | null;
  attempts: LocalFallbackAttempt[];
  /** Tong thoi gian chay chain (ms). */
  totalLatencyMs: number;
  /** Gia tri executor tra ve khi thanh cong (host tu dinh nghia). */
  value?: unknown;
}

/** Ham host inject de "thu" mot model: tra ve khi ok, throw khi loi. */
export type LocalFallbackExecutor<T = unknown> = (
  candidate: RouteCandidate,
  index: number,
) => Promise<T>;

/** Cau hinh fallback chain. */
export interface LocalFallbackChainConfig {
  /** So ung vien toi da trong chain (mac dinh 4: chinh + 3 fallback). */
  maxChainLength: number;
  /** Cau hinh breaker dung chung cho moi model trong chain. */
  breaker: Partial<LocalCircuitBreakerConfig>;
}

/** Cau hinh mac dinh fallback chain. */
export const DEFAULT_LOCAL_FALLBACK_CHAIN_CONFIG: LocalFallbackChainConfig = {
  maxChainLength: 4,
  breaker: {},
};

/**
 * LocalFallbackChain — chay tuan tu cac ung vien theo thu tu, bo qua model
 * co breaker dang mo, ghi breaker sau moi lan thu.
 *
 * Chu y: `attempt()` KHONG tu sleep/backoff giua cac lan thu — tra
 * ve ngay de caller quyet dinh (tool layer chi probe health, khong
 * doi that). `backoffDelayMs()` dung de UI hien thi "thu lai sau Xs"
 * hoac de host hen gio thu lai.
 */
export class LocalFallbackChain {
  private readonly config: LocalFallbackChainConfig;
  private readonly breakers = new Map<string, ModelCircuitBreaker>();
  private readonly now: () => number;

  constructor(config?: Partial<LocalFallbackChainConfig>, now?: () => number) {
    this.config = {
      ...DEFAULT_LOCAL_FALLBACK_CHAIN_CONFIG,
      ...config,
      breaker: { ...DEFAULT_LOCAL_FALLBACK_CHAIN_CONFIG.breaker, ...(config?.breaker ?? {}) },
    };
    this.now = now ?? Date.now;
  }

  getConfig(): LocalFallbackChainConfig {
    return {
      maxChainLength: this.config.maxChainLength,
      breaker: { ...this.config.breaker },
    };
  }

  /** Breaker cua mot model (tao moi khi chua co). */
  breakerFor(modelId: string): ModelCircuitBreaker {
    let breaker = this.breakers.get(modelId);
    if (!breaker) {
      breaker = new ModelCircuitBreaker(modelId, this.config.breaker, this.now);
      this.breakers.set(modelId, breaker);
    }
    return breaker;
  }

  /** Snapshot tat ca breaker (de UI hien thi / serialize). */
  breakerSnapshots(): LocalCircuitBreakerSnapshot[] {
    return [...this.breakers.values()].map((b) => b.snapshot());
  }

  /** Dat lai chain ve trang thai sach (xoa het breaker). */
  resetAll(): void {
    this.breakers.clear();
  }

  /** Goi lai delay backoff cho model (dua tren so loi lien tiep). */
  backoffFor(modelId: string, random?: () => number): number {
    const breaker = this.breakerFor(modelId);
    const failures = breaker.snapshot().consecutiveFailures;
    const full: LocalCircuitBreakerConfig = {
      ...DEFAULT_LOCAL_CIRCUIT_BREAKER_CONFIG,
      ...this.config.breaker,
    };
    return backoffDelayMs(Math.max(0, failures - 1), full, random);
  }

  /**
   * Chay chain: thu tung ung vien theo thu tu. Model co breaker mo
   * thi ghi `skipped-open` (khong goi executor). Dung o model dau
   * tien thanh cong; neu tat ca that bai thi tra succeeded=false.
   */
  async attempt<T = unknown>(
    candidates: RouteCandidate[],
    executor: LocalFallbackExecutor<T>,
  ): Promise<LocalFallbackChainResult> {
    const startedAt = this.now();
    const chain = candidates.slice(0, this.config.maxChainLength);
    const attempts: LocalFallbackAttempt[] = [];
    for (let index = 0; index < chain.length; index += 1) {
      const candidate = chain[index];
      const breaker = this.breakerFor(candidate.modelId);
      if (!breaker.canAttempt()) {
        attempts.push({
          modelId: candidate.modelId,
          kind: candidate.kind,
          outcome: 'skipped-open',
          latencyMs: 0,
          error: `Circuit breaker dang mo (thu lai sau ${Math.max(0, (breaker.nextRetryAt() ?? 0) - this.now())} ms)`,
          index,
          at: this.now(),
        });
        continue;
      }
      const attemptStarted = this.now();
      try {
        const value = await executor(candidate, index);
        breaker.recordSuccess(this.now() - attemptStarted);
        attempts.push({
          modelId: candidate.modelId,
          kind: candidate.kind,
          outcome: 'success',
          latencyMs: this.now() - attemptStarted,
          index,
          at: this.now(),
        });
        return {
          succeeded: true,
          modelId: candidate.modelId,
          attempts,
          totalLatencyMs: this.now() - startedAt,
          value,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        breaker.recordFailure(message);
        attempts.push({
          modelId: candidate.modelId,
          kind: candidate.kind,
          outcome: 'failed',
          latencyMs: this.now() - attemptStarted,
          error: message.slice(0, 500),
          index,
          at: this.now(),
        });
      }
    }
    return {
      succeeded: false,
      modelId: null,
      attempts,
      totalLatencyMs: this.now() - startedAt,
    };
  }

  /** Serialize toan bo breaker (de host luu xuong disk). */
  serialize(): LocalCircuitBreakerSnapshot[] {
    return this.breakerSnapshots();
  }

  /** Khoi phuc breaker tu snapshot da luu. */
  static deserialize(
    snapshots: LocalCircuitBreakerSnapshot[],
    config?: Partial<LocalFallbackChainConfig>,
    now?: () => number,
  ): LocalFallbackChain {
    const chain = new LocalFallbackChain(config, now);
    for (const snapshot of snapshots) {
      chain.breakers.set(
        snapshot.modelId,
        ModelCircuitBreaker.fromSnapshot(snapshot, config?.breaker, now),
      );
    }
    return chain;
  }
}
