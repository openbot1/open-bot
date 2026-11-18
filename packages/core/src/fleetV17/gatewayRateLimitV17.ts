/**
 * Gateway rate limiting v2 — giới hạn theo user/tenant/route bằng
 * token bucket KẾT HỢP sliding window, header Retry-After chuẩn,
 * burst allowance, test tải nhẹ (v1.20, Đội T6).
 *
 * Tầng trên của gateway rate limit v16 (`fleetV16/
 * gatewayRateLimitV16.ts` — sliding window theo timestamp, burst
 * trong cửa sổ ngắn, 429 + retry-after). V16 trả lời "lần gọi này
 * có vượt sliding window không"; v17 trả lời 4 câu gateway thật
 * còn thiếu:
 *
 * - TOKEN BUCKET + SLIDING WINDOW: mỗi scope giữ CẢ hai cơ chế —
 *   token bucket (nạp lại đều theo tốc độ `refillPerSecond`, cho
 *   phép burst ngắn tới `capacity` token) VÀ sliding window (giới
 *   hạn bền vững `maxRequests/windowMs`). Một lần gọi phải qua cả
 *   hai: burst chớp nhoáng được token bucket cho qua nhưng không
 *   được phá giới hạn bền vững của sliding window.
 * - BURST ALLOWANCE TƯỜNG MINH: `burst` là số token thêm trên
 *   mức bền vững (capacity = maxRequests + burst trong cửa sổ
 *   bucket) — admin nhìn một con số là biết "cho phép vượt bao
 *   nhiêu trong chớp mắt", thay vì burst window ẩn của v16.
 * - HEADER CHUẨN ĐẦY ĐỦ: quyết định trả về `Retry-After`,
 *   `X-RateLimit-Limit/Remaining/Reset` cho CẢ scope chặn lẫn
 *   scope cho phép (v16 chỉ build header khi bị chặn) + helper
 *   `gatewayV17RateLimitHeaders` dùng cho response 200 và 429.
 * - TEST TẢI NHẸ (LOAD SIMULATION): `simulateGatewayV17Load`
 *   chạy N lần gọi giả lập theo pattern (đều / burst đầu kỳ /
 *   tăng dần) trên limiter thật và báo allowed/blocked, p50/p95
 *   thời gian chờ, scope chặn nhiều nhất — để admin kiểm chứng
 *   config trước khi áp lên gateway thật, không cần tool ngoài.
 *
 * Module này KHÔNG chạm mạng, KHÔNG tự chặn request thật: nó
 * quyết định "lần gọi này được phép không, nếu không thì chờ bao
 * lâu" — gateway host gọi `consume` trước mỗi lần gọi rồi trả 429
 * theo `gatewayV17TooManyRequests` khi cần. State trong bộ nhớ.
 */

import {
  defaultGatewayV16Config,
  gatewayV16BucketKey,
} from '../fleetV16/gatewayRateLimitV16';
import type { GatewayV16Config, GatewayV16Scope } from '../fleetV16/gatewayRateLimitV16';

/** Một giới hạn v17: sliding window + token bucket. */
export interface GatewayV17Limit {
  /** Tối đa lần gọi bền vững trong `windowMs` (sliding window). */
  maxRequests: number;
  /** Độ dài cửa sổ trượt (ms). */
  windowMs: number;
  /** Số token thêm cho burst (0 = không burst). */
  burst: number;
  /** Tốc độ nạp token (token/giây) — mặc định = maxRequests / (windowMs/1000). */
  refillPerSecond?: number;
}

/** Lỗi validate limit, '' = hợp lệ. */
export function validateGatewayV17Limit(limit: GatewayV17Limit): string {
  if (!Number.isInteger(limit.maxRequests) || limit.maxRequests <= 0) {
    return 'maxRequests phải là số nguyên > 0';
  }
  if (!Number.isFinite(limit.windowMs) || limit.windowMs <= 0) return 'windowMs phải > 0';
  if (!Number.isInteger(limit.burst) || limit.burst < 0) return 'burst phải là số nguyên >= 0';
  if (limit.refillPerSecond !== undefined) {
    if (!Number.isFinite(limit.refillPerSecond) || limit.refillPerSecond <= 0) {
      return 'refillPerSecond phải > 0';
    }
  }
  return '';
}

/** Cấu hình rate limit v17: mặc định theo scope + override theo route. */
export interface GatewayV17Config {
  defaults: Partial<Record<GatewayV16Scope, GatewayV17Limit>>;
  routeOverrides: Record<string, GatewayV17Limit>;
}

export function defaultGatewayV17Config(): GatewayV17Config {
  const v16 = defaultGatewayV16Config();
  const toV17 = (maxRequests: number, windowMs: number, burst: number): GatewayV17Limit => ({
    maxRequests,
    windowMs,
    burst,
    refillPerSecond: maxRequests / (windowMs / 1000),
  });
  return {
    defaults: {
      user: toV17(60, 60 * 1000, 10),
      tenant: toV17(600, 60 * 1000, 60),
      route: toV17(30, 60 * 1000, 5),
      global: toV17(5000, 60 * 1000, 500),
    },
    routeOverrides: {
      'chat.completions': toV17(20, 60 * 1000, 5),
      'tool.run': toV17(60, 60 * 1000, 10),
      'media.generate': toV17(5, 60 * 1000, 2),
    },
  };
}

/** Lỗi validate config, '' = hợp lệ. */
export function validateGatewayV17Config(config: GatewayV17Config): string {
  for (const [scope, limit] of Object.entries(config.defaults)) {
    if (limit === undefined) continue;
    const err = validateGatewayV17Limit(limit);
    if (err) return `defaults.${scope}: ${err}`;
  }
  for (const [route, limit] of Object.entries(config.routeOverrides)) {
    if (route.trim() === '') return 'route override không được có key rỗng';
    const err = validateGatewayV17Limit(limit);
    if (err) return `routeOverrides.${route}: ${err}`;
  }
  return '';
}

/** Quyết định rate limit v17 cho một lần gọi. */
export interface GatewayV17Decision {
  allowed: boolean;
  remaining: number;
  /** Giới hạn bền vững (sliding window) của scope chặn/chặt nhất. */
  limit: number;
  resetAt: number;
  retryAfterMs: number;
  retryAfterSeconds: number;
  blockedBy: GatewayV16Scope | null;
  /** Cơ chế đã chặn: `sliding-window` | `token-bucket` | null. */
  blockedByMechanism: 'sliding-window' | 'token-bucket' | null;
  /** Số token còn trong bucket của scope chặn/chặt nhất. */
  tokensRemaining: number;
  route: string;
}

/** Input một lần gọi qua gateway. */
export interface GatewayV17CheckInput {
  userId: string;
  tenantId: string;
  route: string;
}

/** Trạng thái một bucket (token + sliding window). */
interface GatewayV17BucketState {
  /** Timestamp các lần gọi trong sliding window. */
  hits: number[];
  /** Số token hiện có (có thể lẻ). */
  tokens: number;
  /** Epoch ms lần nạp token gần nhất. */
  lastRefillAt: number;
}

/**
 * Rate limiter v17 (trong bộ nhớ): mỗi bucket giữ sliding window
 * (danh sách timestamp) + token bucket (token nạp đều theo thời
 * gian). Token khởi đầu đầy (`maxRequests + burst`).
 */
export class GatewayV17RateLimiter {
  private readonly config: GatewayV17Config;
  private readonly buckets = new Map<string, GatewayV17BucketState>();

  constructor(config: GatewayV17Config = defaultGatewayV17Config()) {
    const invalid = validateGatewayV17Config(config);
    if (invalid) throw new Error(`GatewayV17Config không hợp lệ: ${invalid}`);
    this.config = {
      defaults: { ...config.defaults },
      routeOverrides: { ...config.routeOverrides },
    };
  }

  /** Giới hạn áp dụng cho một scope + route (override thắng default). */
  limitFor(scope: GatewayV16Scope, route: string): GatewayV17Limit | null {
    if (scope === 'route') {
      return this.config.routeOverrides[route] ?? this.config.defaults.route ?? null;
    }
    return this.config.defaults[scope] ?? null;
  }

  private capacityOf(limit: GatewayV17Limit): number {
    return limit.maxRequests + limit.burst;
  }

  private refillPerSecondOf(limit: GatewayV17Limit): number {
    return limit.refillPerSecond ?? limit.maxRequests / (limit.windowMs / 1000);
  }

  private bucketFor(key: string, limit: GatewayV17Limit, now: number): GatewayV17BucketState {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [], tokens: this.capacityOf(limit), lastRefillAt: now };
      this.buckets.set(key, bucket);
    }
    // Nạp token theo thời gian đã trôi (không vượt capacity).
    const elapsedSec = Math.max(0, (now - bucket.lastRefillAt) / 1000);
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(
        this.capacityOf(limit),
        bucket.tokens + elapsedSec * this.refillPerSecondOf(limit),
      );
      bucket.lastRefillAt = now;
    }
    // Prune sliding window.
    const windowStart = now - limit.windowMs;
    bucket.hits = bucket.hits.filter((t) => t > windowStart);
    return bucket;
  }

  private scopesOf(input: GatewayV17CheckInput): { scope: GatewayV16Scope; scopeId: string }[] {
    return [
      { scope: 'global', scopeId: 'global' },
      { scope: 'tenant', scopeId: input.tenantId },
      { scope: 'user', scopeId: input.userId },
      { scope: 'route', scopeId: input.route },
    ];
  }

  /**
   * Kiểm tra (KHÔNG ghi) một lần gọi: phải qua CẢ sliding window
   * (chưa đủ `maxRequests + burst` lần trong cửa sổ — burst là số
   * lần thêm cho phép trong cửa sổ) VÀ token bucket (còn >= 1
   * token — token nạp lại đều nên sau một burst cạn token, lần
   * gọi tiếp phải chờ nạp dù cửa sổ đã trống); scope nào chặn
   * trước (global → tenant → user → route) thì quyết định theo
   * scope đó; khi cả hai cơ chế cùng cạn thì báo sliding-window
   * (giới hạn bền vững).
   */
  check(input: GatewayV17CheckInput, now = Date.now()): GatewayV17Decision {
    let tightestRemaining = Number.POSITIVE_INFINITY;
    let tightestLimit = 0;
    let tightestResetAt = now;
    let tightestTokens = Number.POSITIVE_INFINITY;
    for (const { scope, scopeId } of this.scopesOf(input)) {
      const limit = this.limitFor(scope, input.route);
      if (!limit) continue;
      const key = gatewayV16BucketKey(scope, scopeId, input.route);
      const bucket = this.bucketFor(key, limit, now);
      const windowCap = limit.maxRequests + limit.burst;
      const resetAt = bucket.hits.length > 0 ? bucket.hits[0] + limit.windowMs : now + limit.windowMs;
      tightestResetAt = Math.max(tightestResetAt, resetAt);
      tightestLimit = Math.max(tightestLimit, limit.maxRequests);
      tightestTokens = Math.min(tightestTokens, Math.floor(bucket.tokens));
      if (bucket.hits.length >= windowCap) {
        const retryAfterMs = Math.max(0, bucket.hits[0] + limit.windowMs - now);
        return {
          allowed: false,
          remaining: 0,
          limit: limit.maxRequests,
          resetAt,
          retryAfterMs,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
          blockedBy: scope,
          blockedByMechanism: 'sliding-window',
          tokensRemaining: Math.floor(bucket.tokens),
          route: input.route,
        };
      }
      if (bucket.tokens < 1) {
        const refill = this.refillPerSecondOf(limit);
        const retryAfterMs = Math.ceil(((1 - bucket.tokens) / refill) * 1000);
        return {
          allowed: false,
          remaining: 0,
          limit: limit.maxRequests,
          resetAt,
          retryAfterMs,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
          blockedBy: scope,
          blockedByMechanism: 'token-bucket',
          tokensRemaining: Math.floor(bucket.tokens),
          route: input.route,
        };
      }
      tightestRemaining = Math.min(
        tightestRemaining,
        windowCap - bucket.hits.length - 1,
        Math.floor(bucket.tokens) - 1,
      );
    }
    return {
      allowed: true,
      remaining: tightestRemaining === Number.POSITIVE_INFINITY ? 0 : tightestRemaining,
      limit: tightestLimit,
      resetAt: tightestResetAt,
      retryAfterMs: 0,
      retryAfterSeconds: 0,
      blockedBy: null,
      blockedByMechanism: null,
      tokensRemaining: tightestTokens === Number.POSITIVE_INFINITY ? 0 : tightestTokens,
      route: input.route,
    };
  }

  /**
   * Ghi một lần gọi (chỉ gọi sau khi `check` trả allowed): trừ 1
   * token + thêm timestamp vào mọi bucket của 4 scope.
   */
  consume(input: GatewayV17CheckInput, now = Date.now()): GatewayV17Decision {
    const decision = this.check(input, now);
    if (!decision.allowed) return decision;
    for (const { scope, scopeId } of this.scopesOf(input)) {
      const limit = this.limitFor(scope, input.route);
      if (!limit) continue;
      const key = gatewayV16BucketKey(scope, scopeId, input.route);
      const bucket = this.bucketFor(key, limit, now);
      bucket.tokens = Math.max(0, bucket.tokens - 1);
      bucket.hits.push(now);
    }
    return decision;
  }

  /** Số token còn trong bucket của một scope + route (không ghi). */
  tokensRemaining(scope: GatewayV16Scope, scopeId: string, route: string, now = Date.now()): number {
    const limit = this.limitFor(scope, route);
    if (!limit) return Number.POSITIVE_INFINITY;
    const bucket = this.bucketFor(gatewayV16BucketKey(scope, scopeId, route), limit, now);
    return Math.floor(bucket.tokens);
  }

  /** Xóa bucket của một scope (vd admin reset quota cho user). */
  reset(scope: GatewayV16Scope, scopeId: string, route?: string): void {
    for (const key of [...this.buckets.keys()]) {
      if (route === undefined) {
        if (key.startsWith(`${scope}:${scopeId}:`)) this.buckets.delete(key);
      } else if (key === gatewayV16BucketKey(scope, scopeId, route)) {
        this.buckets.delete(key);
      }
    }
  }

  /** Dọn bucket rỗng / hết hạn. */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [key, bucket] of [...this.buckets.entries()]) {
      const scope = key.split(':')[0] as GatewayV16Scope;
      const route = key.split(':').slice(2).join(':');
      const limit = this.limitFor(scope, route);
      const windowMs = limit?.windowMs ?? 60 * 1000;
      bucket.hits = bucket.hits.filter((t) => t > now - windowMs);
      if (bucket.hits.length === 0 && bucket.tokens >= (limit ? this.capacityOf(limit) : 0)) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Số bucket đang giữ. */
  get bucketCount(): number {
    return this.buckets.size;
  }
}

/**
 * Header rate limit chuẩn cho MỌI response (200 lẫn 429):
 * `Retry-After` chỉ có khi bị chặn; còn lại luôn có
 * `X-RateLimit-Limit/Remaining/Reset`.
 */
export function gatewayV17RateLimitHeaders(decision: GatewayV17Decision): Record<string, string> {
  const headers: Record<string, string> = {
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-remaining': String(Math.max(0, decision.remaining)),
    'x-ratelimit-reset': String(Math.ceil(decision.resetAt / 1000)),
  };
  if (!decision.allowed) {
    headers['retry-after'] = String(decision.retryAfterSeconds);
  }
  return headers;
}

/** Response HTTP 429 chuẩn từ một quyết định bị chặn. */
export interface GatewayV17TooManyRequests {
  status: 429;
  headers: Record<string, string>;
  body: {
    error: string;
    retryAfterSeconds: number;
    route: string;
    blockedBy: string;
    mechanism: string;
  };
}

export function gatewayV17TooManyRequests(decision: GatewayV17Decision): GatewayV17TooManyRequests {
  return {
    status: 429,
    headers: gatewayV17RateLimitHeaders(decision),
    body: {
      error: `rate limit exceeded for route ${decision.route} (blocked by ${decision.blockedBy ?? 'unknown'} via ${decision.blockedByMechanism ?? 'unknown'})`,
      retryAfterSeconds: decision.retryAfterSeconds,
      route: decision.route,
      blockedBy: decision.blockedBy ?? 'unknown',
      mechanism: decision.blockedByMechanism ?? 'unknown',
    },
  };
}

// ---------------------------------------------------------------------------
// Test tải nhẹ (load simulation)
// ---------------------------------------------------------------------------

/** Pattern phân phối các lần gọi giả lập. */
export type GatewayV17LoadPattern = 'even' | 'burst-start' | 'ramp-up';

export const GATEWAY_V17_LOAD_PATTERNS: readonly GatewayV17LoadPattern[] = [
  'even',
  'burst-start',
  'ramp-up',
];

/** Kết quả test tải nhẹ. */
export interface GatewayV17LoadResult {
  pattern: GatewayV17LoadPattern;
  totalRequests: number;
  allowed: number;
  blocked: number;
  /** % lần gọi bị chặn. */
  blockedRate: number;
  /** Thời gian chờ (ms) lớn nhất mà một lần gọi bị chặn phải chờ. */
  maxRetryAfterMs: number;
  /** p50/p95 thời gian chờ (ms) của các lần gọi bị chặn (0 khi không có). */
  p50RetryAfterMs: number;
  p95RetryAfterMs: number;
  /** Scope chặn nhiều nhất (`scope:count`). */
  topBlocker: string;
  /** Số bucket limiter đang giữ sau test. */
  bucketCount: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Chạy N lần gọi giả lập trên limiter THẬT theo pattern, trong
 * khoảng `durationMs` (mốc thời gian giả lập, không chờ thật):
 * - `even`: các lần gọi cách đều nhau.
 * - `burst-start`: 50% số lần gọi dồn vào 10% thời gian đầu.
 * - `ramp-up`: mật độ tăng dần (khoảng cách giảm dần theo thời gian).
 * Trả về thống kê allowed/blocked + phân vị thời gian chờ — dùng
 * để kiểm chứng config trước khi áp lên gateway thật.
 */
export function simulateGatewayV17Load(
  limiter: GatewayV17RateLimiter,
  input: GatewayV17CheckInput,
  totalRequests: number,
  durationMs: number,
  pattern: GatewayV17LoadPattern = 'even',
  startAt = Date.now(),
): GatewayV17LoadResult {
  if (!Number.isInteger(totalRequests) || totalRequests <= 0) {
    throw new Error('totalRequests phải là số nguyên > 0');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('durationMs phải > 0');
  }
  const timestamps: number[] = [];
  if (pattern === 'even') {
    for (let i = 0; i < totalRequests; i++) {
      timestamps.push(startAt + Math.floor((i * durationMs) / totalRequests));
    }
  } else if (pattern === 'burst-start') {
    const burstCount = Math.ceil(totalRequests / 2);
    const burstWindow = Math.max(1, Math.floor(durationMs / 10));
    for (let i = 0; i < burstCount; i++) {
      timestamps.push(startAt + Math.floor((i * burstWindow) / burstCount));
    }
    for (let i = burstCount; i < totalRequests; i++) {
      timestamps.push(startAt + burstWindow + Math.floor(((i - burstCount) * (durationMs - burstWindow)) / Math.max(1, totalRequests - burstCount)));
    }
  } else {
    // ramp-up: khoảng cách giữa các lần gọi giảm dần (mật độ tăng).
    let t = startAt;
    const gaps: number[] = [];
    for (let i = 0; i < totalRequests; i++) gaps.push(1 - i / totalRequests);
    const totalGap = gaps.reduce((a, b) => a + b, 0);
    for (let i = 0; i < totalRequests; i++) {
      timestamps.push(Math.floor(t));
      t += (gaps[i] / totalGap) * durationMs;
    }
  }
  let allowed = 0;
  let blocked = 0;
  const waits: number[] = [];
  const blockerCounts = new Map<string, number>();
  for (const at of timestamps) {
    const decision = limiter.consume(input, at);
    if (decision.allowed) {
      allowed += 1;
    } else {
      blocked += 1;
      waits.push(decision.retryAfterMs);
      const key = `${decision.blockedBy ?? 'unknown'}:${decision.blockedByMechanism ?? 'unknown'}`;
      blockerCounts.set(key, (blockerCounts.get(key) ?? 0) + 1);
    }
  }
  waits.sort((a, b) => a - b);
  let topBlocker = '';
  let topCount = 0;
  for (const [key, count] of blockerCounts) {
    if (count > topCount) {
      topCount = count;
      topBlocker = `${key} (${count})`;
    }
  }
  return {
    pattern,
    totalRequests,
    allowed,
    blocked,
    blockedRate: Math.round((blocked / totalRequests) * 1000) / 1000,
    maxRetryAfterMs: waits.length > 0 ? waits[waits.length - 1] : 0,
    p50RetryAfterMs: percentile(waits, 50),
    p95RetryAfterMs: percentile(waits, 95),
    topBlocker,
    bucketCount: limiter.bucketCount,
  };
}
