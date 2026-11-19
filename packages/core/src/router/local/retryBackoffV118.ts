/**
 * Retry / backoff theo provider (v1.41, Doi T3).
 *
 * Loi provider khong phai loi nao cung retry giong nhau:
 * - 429 / 5xx / timeout / network: retry duoc, backoff mu (exponential
 *   + jitter, co seed de test deterministic).
 * - 400 do tool_choice khong ho tro: KHONG retry y het — ha cap xuong
 *   `auto` roi thu lai toi da 1 lan (xem toolChoiceV118.ts).
 * - 400 do tham so sampling bi bo: loai tham so do roi thu lai 1 lan.
 * - 400/409 thread_fingerprint_mismatch: tao thread moi (doi tool
 *   set) roi thu lai 1 lan; khong retry tren thread cu.
 * - 401/403: khong retry (credential/quyen — retry chi dot quota).
 * - 400 khac / 404 / 422: khong retry.
 *
 * Moi provider co gioi han attempt + delay rieng (local engine retry
 * nhanh hon cloud). Co cooldown don gian kieu circuit-breaker: sau
 * N loi lien tiep, tam dung goi provider do mot khoang thoi gian.
 *
 * Thuan logic (khong goi API that, khong sleep that — chi tinh lich
 * retry; host tu await setTimeout theo lich tra ve).
 */

import { isSamplingParam400Error, isToolChoice400Error } from './toolChoiceV118';
import { isThreadFingerprintMismatchError } from './inlineToolsV118';

/** Loai loi da phan loai. */
export type RouterV118ErrorKind =
  | 'rate-limited'
  | 'server-error'
  | 'timeout'
  | 'network'
  | 'tool-choice-400'
  | 'sampling-param-400'
  | 'thread-fingerprint-mismatch'
  | 'auth'
  | 'not-found'
  | 'bad-request'
  | 'unknown';

/** Hanh dong retry ung voi mot loi. */
export type RetryAction =
  | 'retry-same'
  | 'retry-downgrade-tool-choice'
  | 'retry-drop-sampling-params'
  | 'retry-new-thread'
  | 'do-not-retry';

/** Mo ta loi dau vao (status HTTP + message + co phai timeout khong). */
export interface ProviderErrorInput {
  provider: string;
  status?: number;
  message?: string;
  /** Loi timeout (vd AbortError) — khong can status. */
  isTimeout?: boolean;
  /** Loi network (ECONNREFUSED / fetch failed) — khong can status. */
  isNetwork?: boolean;
}

/** Ket qua phan loai loi. */
export interface ClassifiedProviderError {
  kind: RouterV118ErrorKind;
  retryable: boolean;
  action: RetryAction;
  reason: string;
}

/** Cau hinh retry cua mot provider. */
export interface ProviderRetryConfig {
  provider: string;
  /** So attempt toi da (tinh ca attempt dau). */
  maxAttempts: number;
  /** Delay co so truoc retry dau (ms). */
  baseDelayMs: number;
  /** Delay toi da (ms) — tran cua exponential. */
  maxDelayMs: number;
  /** He so nhan moi lan retry (mac dinh 2). */
  multiplier: number;
  /** Do lech jitter toi da (0..1, mac dinh 0.25). */
  jitterFactor: number;
}

/** Cau hinh retry mac dinh theo provider. */
export function defaultRetryConfig(provider: string): ProviderRetryConfig {
  const local = provider === 'ollama' || provider === 'llamacpp';
  return {
    provider,
    maxAttempts: local ? 3 : 4,
    baseDelayMs: local ? 200 : 500,
    maxDelayMs: 30000,
    multiplier: 2,
    jitterFactor: 0.25,
  };
}

/**
 * Phan loai loi provider thanh kind + hanh dong retry.
 * Thu tu uu tien: timeout/network (khong can status) -> 429 -> 5xx ->
 * 400 dac biet (tool_choice / sampling / fingerprint) -> 401/403 ->
 * 404 -> 400 chung -> khac.
 */
export function classifyProviderErrorV118(input: ProviderErrorInput): ClassifiedProviderError {
  const message = input.message ?? '';
  const status = input.status;

  if (input.isTimeout === true) {
    return {
      kind: 'timeout',
      retryable: true,
      action: 'retry-same',
      reason: 'Request timeout — co the do provider cham, retry y het.',
    };
  }
  if (input.isNetwork === true) {
    return {
      kind: 'network',
      retryable: true,
      action: 'retry-same',
      reason: 'Loi network khi goi provider — retry y het.',
    };
  }
  if (status === 429) {
    return {
      kind: 'rate-limited',
      retryable: true,
      action: 'retry-same',
      reason: 'Rate limited (429) — retry sau backoff; neu co Retry-After thi dung gia tri do.',
    };
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return {
      kind: 'server-error',
      retryable: true,
      action: 'retry-same',
      reason: `Loi server ${status} — tam thoi, retry y het.`,
    };
  }
  if (status === 400) {
    if (isToolChoice400Error(status, message)) {
      return {
        kind: 'tool-choice-400',
        retryable: true,
        action: 'retry-downgrade-tool-choice',
        reason: '400 do tool_choice khong duoc ho tro — ha xuong auto roi thu lai 1 lan.',
      };
    }
    if (isSamplingParam400Error(status, message)) {
      return {
        kind: 'sampling-param-400',
        retryable: true,
        action: 'retry-drop-sampling-params',
        reason: '400 do tham so sampling bi bo — loai temperature/top_p/top_k roi thu lai 1 lan.',
      };
    }
    if (isThreadFingerprintMismatchError(status, message)) {
      return {
        kind: 'thread-fingerprint-mismatch',
        retryable: true,
        action: 'retry-new-thread',
        reason: 'thread_fingerprint_mismatch — tool set doi sau khi thread khoa, tao thread moi roi thu lai.',
      };
    }
    return {
      kind: 'bad-request',
      retryable: false,
      action: 'do-not-retry',
      reason: 'Bad request 400 khong thuoc nhom sua duoc — retry y het chi lap lai loi.',
    };
  }
  if (status === 409 && isThreadFingerprintMismatchError(status, message)) {
    return {
      kind: 'thread-fingerprint-mismatch',
      retryable: true,
      action: 'retry-new-thread',
      reason: 'thread_fingerprint_mismatch (409) — tao thread moi roi thu lai.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      retryable: false,
      action: 'do-not-retry',
      reason: `Loi xac thuc/quyen ${status} — retry khong sua duoc credential, can user kiem tra key.`,
    };
  }
  if (status === 404) {
    return {
      kind: 'not-found',
      retryable: false,
      action: 'do-not-retry',
      reason: '404 — model/endpoint khong ton tai, retry vo ich.',
    };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return {
      kind: 'bad-request',
      retryable: false,
      action: 'do-not-retry',
      reason: `Loi client ${status} — khong retry.`,
    };
  }
  return {
    kind: 'unknown',
    retryable: false,
    action: 'do-not-retry',
    reason: 'Khong du thong tin de phan loai — khong retry mac dinh (fail-closed).',
  };
}

/** PRNG nho co seed (mulberry32) — jitter deterministic cho test. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tinh delay truoc retry thu `attempt` (1 = retry dau tien sau loi dau).
 * Cong thuc: min(maxDelay, base * multiplier^(attempt-1)) + jitter
 * (jitter = random * factor * delay; random co seed khi test).
 */
export function computeRetryDelayMs(
  config: ProviderRetryConfig,
  attempt: number,
  random: () => number = Math.random,
): number {
  if (attempt < 1) return 0;
  const exp = config.baseDelayMs * Math.pow(config.multiplier, attempt - 1);
  const capped = Math.min(config.maxDelayMs, exp);
  const jitter = random() * config.jitterFactor * capped;
  return Math.round(capped + jitter);
}

/** Mot buoc trong lich retry. */
export interface RetryStep {
  attempt: number;
  delayMs: number;
  action: RetryAction;
}

/** Lich retry day du cho mot loi: cac buoc + co retry khong. */
export interface RetryPlan {
  provider: string;
  kind: RouterV118ErrorKind;
  retryable: boolean;
  action: RetryAction;
  reason: string;
  maxAttempts: number;
  steps: RetryStep[];
}

/**
 * Lap lich retry cho mot loi:
 * - Loi khong retryable -> steps rong.
 * - Loi retry-same (429/5xx/timeout/network): toi da maxAttempts-1 retry.
 * - Loi sua duoc (tool-choice/sampling/fingerprint): toi da 1 retry
 *   dac biet (ha cap/loai param/thread moi), khong retry lap lai neu
 *   van loi cung loai — tranh loop 400 vo han.
 */
export function planRetry(
  error: ProviderErrorInput,
  config: ProviderRetryConfig = defaultRetryConfig(error.provider),
  seed?: number,
): RetryPlan {
  const classified = classifyProviderErrorV118(error);
  const random = seed !== undefined ? seededRandom(seed) : Math.random;
  if (!classified.retryable) {
    return {
      provider: error.provider,
      kind: classified.kind,
      retryable: false,
      action: 'do-not-retry',
      reason: classified.reason,
      maxAttempts: 1,
      steps: [],
    };
  }
  const special = classified.action !== 'retry-same';
  const retryCount = special ? 1 : Math.max(0, config.maxAttempts - 1);
  const steps: RetryStep[] = [];
  for (let attempt = 1; attempt <= retryCount; attempt++) {
    steps.push({
      attempt,
      delayMs: special ? 0 : computeRetryDelayMs(config, attempt, random),
      action: classified.action,
    });
  }
  return {
    provider: error.provider,
    kind: classified.kind,
    retryable: true,
    action: classified.action,
    reason: classified.reason,
    maxAttempts: special ? 2 : config.maxAttempts,
    steps,
  };
}

/** Parse header Retry-After (giay hoac HTTP date) ra ms; null neu khong parse duoc. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (value === undefined || value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - now);
  }
  return null;
}

/**
 * Delay thuc te cho retry 429: uu tien Retry-After cua provider neu
 * co, khong thi dung backoff da tinh.
 */
export function effectiveRateLimitDelayMs(
  retryAfter: string | null | undefined,
  backoffMs: number,
  now = Date.now(),
): number {
  const parsed = parseRetryAfterMs(retryAfter, now);
  if (parsed === null) return backoffMs;
  return Math.max(backoffMs, parsed);
}

/** Cooldown kieu circuit-breaker cho mot provider. */
export interface ProviderCooldown {
  provider: string;
  /** So loi lien tiep hien tai. */
  consecutiveFailures: number;
  /** Thoi diem het cooldown (ms epoch); 0 = khong cooldown. */
  cooldownUntilMs: number;
  /** Tong so lan da bi cooldown. */
  trips: number;
}

export class ProviderCooldownTracker {
  private readonly states = new Map<string, ProviderCooldown>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(opts: { failureThreshold?: number; cooldownMs?: number } = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 60000;
  }

  recordSuccess(provider: string): void {
    const state = this.states.get(provider);
    if (state) {
      state.consecutiveFailures = 0;
      state.cooldownUntilMs = 0;
    }
  }

  /** Ghi mot loi; tra ve true neu vua kich hoat cooldown. */
  recordFailure(provider: string, now = Date.now()): boolean {
    const state = this.states.get(provider) ?? {
      provider,
      consecutiveFailures: 0,
      cooldownUntilMs: 0,
      trips: 0,
    };
    state.consecutiveFailures++;
    let tripped = false;
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.cooldownUntilMs = now + this.cooldownMs;
      state.trips++;
      state.consecutiveFailures = 0;
      tripped = true;
    }
    this.states.set(provider, state);
    return tripped;
  }

  isCoolingDown(provider: string, now = Date.now()): boolean {
    const state = this.states.get(provider);
    if (!state) return false;
    return state.cooldownUntilMs > now;
  }

  msUntilAvailable(provider: string, now = Date.now()): number {
    const state = this.states.get(provider);
    if (!state) return 0;
    return Math.max(0, state.cooldownUntilMs - now);
  }

  getState(provider: string): ProviderCooldown | null {
    const state = this.states.get(provider);
    return state ? { ...state } : null;
  }

  reset(provider?: string): void {
    if (provider) this.states.delete(provider);
    else this.states.clear();
  }
}
