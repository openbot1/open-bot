/**
 * Gateway rate limiting v16 — giới hạn tốc độ gọi qua gateway theo
 * user/tenant/route, sliding window, trả 429 kèm retry-after (v1.19,
 * Đội T6).
 *
 * Tầng trên của gateway rate limit v1.02 (`gateway/rateLimit.ts` —
 * token bucket theo sender cho kênh chat, 30 msg/phút, chỉ trả
 * true/false). V1.02 trả lời "sender này có được gửi tiếp không";
 * v16 trả lời 4 câu gateway thật cần:
 *
 * - NHIỀU PHẠM VI: giới hạn riêng theo user, theo tenant, và theo
 *   route (vd `chat.completions`, `tool.run`) — một user gọi quá
 *   tay không làm tenant khác bị chặn; route nặng có giới hạn
 *   riêng thấp hơn route nhẹ. Key bucket là
 *   `<scope>:<scopeId>:<route>`.
 * - SLIDING WINDOW THẬT: cửa sổ trượt theo timestamp từng lần gọi
 *   (không phải fixed window — tránh burst gấp đôi ở biên cửa sổ);
 *   burst cho phép vượt nhẹ trong chớp mắt (`burst` lần gọi thêm
 *   trên mức `maxRequests` nhưng vẫn trong cửa sổ ngắn hơn).
 * - TRẢ 429 CÓ RETRY-AFTER: khi bị chặn, quyết định trả về
 *   `retryAfterMs` (tính từ lần gọi cũ nhất sẽ rơi khỏi cửa sổ),
 *   `resetAt`, `remaining`, và helper build response HTTP
 *   429 với header `Retry-After` + `X-RateLimit-*` chuẩn.
 * - CẤU HÌNH KIỂM ĐỊNH: giới hạn mặc định theo scope + override
 *   theo route; config sai (window <= 0, max <= 0, burst âm) bị
 *   từ chối kèm lý do thay vì âm thầm chạy sai.
 *
 * Module này KHÔNG chạm mạng, KHÔNG tự chặn request thật: nó
 * quyết định "lần gọi này được phép không, nếu không thì chờ bao
 * lâu" — gateway host gọi `checkGatewayV16RateLimit` trước mỗi
 * lần gọi rồi trả 429 theo `gatewayV16TooManyRequests` khi cần.
 * State hoàn toàn trong bộ nhớ (restart gateway = reset quota —
 * đúng với bản chất rate limit ngắn hạn, local-first).
 */

export type GatewayV16Scope = 'user' | 'tenant' | 'route' | 'global';

export const GATEWAY_V16_SCOPES: readonly GatewayV16Scope[] = ['user', 'tenant', 'route', 'global'];

/** Một giới hạn: tối đa `maxRequests` lần trong `windowMs`. */
export interface GatewayV16Limit {
  /** Tối đa lần gọi trong cửa sổ (phải > 0). */
  maxRequests: number;
  /** Độ dài cửa sổ trượt (ms, phải > 0). */
  windowMs: number;
  /** Số lần gọi thêm cho phép trong `burstWindowMs` (0 = không burst). */
  burst?: number;
  /** Cửa sổ burst (ms) — mặc định = windowMs / 10, tối thiểu 1s. */
  burstWindowMs?: number;
}

/** Lỗi validate limit, '' = hợp lệ. */
export function validateGatewayV16Limit(limit: GatewayV16Limit): string {
  if (!Number.isInteger(limit.maxRequests) || limit.maxRequests <= 0) {
    return 'maxRequests phải là số nguyên > 0';
  }
  if (!Number.isFinite(limit.windowMs) || limit.windowMs <= 0) {
    return 'windowMs phải > 0';
  }
  const burst = limit.burst ?? 0;
  if (!Number.isInteger(burst) || burst < 0) return 'burst phải là số nguyên >= 0';
  if (burst > 0 && limit.burstWindowMs !== undefined) {
    if (!Number.isFinite(limit.burstWindowMs) || limit.burstWindowMs <= 0) {
      return 'burstWindowMs phải > 0 khi có burst';
    }
    if (limit.burstWindowMs > limit.windowMs) return 'burstWindowMs phải <= windowMs';
  }
  return '';
}

/** Cấu hình rate limit của gateway: mặc định theo scope + override theo route. */
export interface GatewayV16Config {
  /** Giới hạn mặc định cho từng scope (thiếu scope = không giới hạn scope đó). */
  defaults: Partial<Record<GatewayV16Scope, GatewayV16Limit>>;
  /** Override theo route: `route` → giới hạn (thắng defaults). */
  routeOverrides: Record<string, GatewayV16Limit>;
}

export function defaultGatewayV16Config(): GatewayV16Config {
  return {
    defaults: {
      user: { maxRequests: 60, windowMs: 60 * 1000 },
      tenant: { maxRequests: 600, windowMs: 60 * 1000 },
      route: { maxRequests: 30, windowMs: 60 * 1000 },
      global: { maxRequests: 5000, windowMs: 60 * 1000 },
    },
    routeOverrides: {
      'chat.completions': { maxRequests: 20, windowMs: 60 * 1000 },
      'tool.run': { maxRequests: 60, windowMs: 60 * 1000 },
      'media.generate': { maxRequests: 5, windowMs: 60 * 1000 },
    },
  };
}

/** Lỗi validate config, '' = hợp lệ. */
export function validateGatewayV16Config(config: GatewayV16Config): string {
  for (const [scope, limit] of Object.entries(config.defaults)) {
    if (limit === undefined) continue;
    const err = validateGatewayV16Limit(limit);
    if (err) return `defaults.${scope}: ${err}`;
  }
  for (const [route, limit] of Object.entries(config.routeOverrides)) {
    if (route.trim() === '') return 'route override không được có key rỗng';
    const err = validateGatewayV16Limit(limit);
    if (err) return `routeOverrides.${route}: ${err}`;
  }
  return '';
}

/** Key bucket cho một lần gọi. */
export function gatewayV16BucketKey(
  scope: GatewayV16Scope,
  scopeId: string,
  route: string,
): string {
  return `${scope}:${scopeId}:${route}`;
}

/** Quyết định rate limit cho một lần gọi. */
export interface GatewayV16Decision {
  allowed: boolean;
  /** Số lần gọi còn lại trong cửa sổ (0 khi bị chặn). */
  remaining: number;
  /** Giới hạn áp dụng. */
  limit: number;
  /** Epoch ms cửa sổ reset. */
  resetAt: number;
  /** Ms phải chờ trước khi thử lại (0 khi được phép). */
  retryAfterMs: number;
  /** Giây phải chờ (làm tròn lên — dùng cho header Retry-After). */
  retryAfterSeconds: number;
  /** Scope đã chặn lần gọi (null khi được phép). */
  blockedBy: GatewayV16Scope | null;
  /** Route của lần gọi. */
  route: string;
}

/** Input một lần gọi qua gateway. */
export interface GatewayV16CheckInput {
  userId: string;
  tenantId: string;
  route: string;
}

/**
 * Rate limiter v16 (trong bộ nhớ): mỗi bucket giữ danh sách
 * timestamp các lần gọi trong cửa sổ; prune lười (chỉ khi check)
 * + `prune` dọn toàn bộ.
 */
export class GatewayV16RateLimiter {
  private readonly config: GatewayV16Config;
  private readonly hits = new Map<string, number[]>();

  constructor(config: GatewayV16Config = defaultGatewayV16Config()) {
    const invalid = validateGatewayV16Config(config);
    if (invalid) throw new Error(`GatewayV16Config không hợp lệ: ${invalid}`);
    this.config = {
      defaults: { ...config.defaults },
      routeOverrides: { ...config.routeOverrides },
    };
  }

  /** Giới hạn áp dụng cho một scope + route (override thắng default). */
  limitFor(scope: GatewayV16Scope, route: string): GatewayV16Limit | null {
    if (scope === 'route') {
      return this.config.routeOverrides[route] ?? this.config.defaults.route ?? null;
    }
    return this.config.defaults[scope] ?? null;
  }

  private timestampsFor(key: string, windowMs: number, now: number): number[] {
    const windowStart = now - windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    this.hits.set(key, kept);
    return kept;
  }

  private checkBucket(
    key: string,
    limit: GatewayV16Limit,
    now: number,
  ): { allowed: boolean; remaining: number; resetAt: number; retryAfterMs: number } {
    const timestamps = this.timestampsFor(key, limit.windowMs, now);
    const burst = limit.burst ?? 0;
    const burstWindowMs = limit.burstWindowMs ?? Math.max(1000, Math.floor(limit.windowMs / 10));
    if (timestamps.length < limit.maxRequests) {
      return {
        allowed: true,
        remaining: limit.maxRequests - timestamps.length - 1,
        resetAt: timestamps.length > 0 ? timestamps[0] + limit.windowMs : now + limit.windowMs,
        retryAfterMs: 0,
      };
    }
    // Hết quota thường: kiểm tra burst — số lần gọi trong cửa sổ
    // burst ngắn còn dưới max + burst thì cho qua.
    if (burst > 0) {
      const burstStart = now - burstWindowMs;
      const inBurst = timestamps.filter((t) => t > burstStart).length;
      if (inBurst < limit.maxRequests + burst) {
        return {
          allowed: true,
          remaining: 0,
          resetAt: timestamps[0] + limit.windowMs,
          retryAfterMs: 0,
        };
      }
    }
    // Bị chặn: chờ tới khi lần gọi cũ nhất rơi khỏi cửa sổ.
    const retryAfterMs = Math.max(0, timestamps[0] + limit.windowMs - now);
    return {
      allowed: false,
      remaining: 0,
      resetAt: timestamps[0] + limit.windowMs,
      retryAfterMs,
    };
  }

  /**
   * Kiểm tra (KHÔNG ghi) một lần gọi: đánh giá đủ 4 scope theo
   * thứ tự global → tenant → user → route; scope nào chặn trước
   * thì quyết định theo scope đó.
   */
  check(input: GatewayV16CheckInput, now = Date.now()): GatewayV16Decision {
    const scopes: { scope: GatewayV16Scope; scopeId: string }[] = [
      { scope: 'global', scopeId: 'global' },
      { scope: 'tenant', scopeId: input.tenantId },
      { scope: 'user', scopeId: input.userId },
      { scope: 'route', scopeId: input.route },
    ];
    let tightestResetAt = now;
    let tightestLimit = 0;
    for (const { scope, scopeId } of scopes) {
      const limit = this.limitFor(scope, input.route);
      if (!limit) continue;
      const key = gatewayV16BucketKey(scope, scopeId, input.route);
      const verdict = this.checkBucket(key, limit, now);
      tightestResetAt = Math.max(tightestResetAt, verdict.resetAt);
      tightestLimit = Math.max(tightestLimit, limit.maxRequests);
      if (!verdict.allowed) {
        return {
          allowed: false,
          remaining: 0,
          limit: limit.maxRequests,
          resetAt: verdict.resetAt,
          retryAfterMs: verdict.retryAfterMs,
          retryAfterSeconds: Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)),
          blockedBy: scope,
          route: input.route,
        };
      }
    }
    // Được phép: remaining = min còn lại của các scope (tính lại
    // bằng check không-ghi — remaining của scope chặt nhất).
    let remaining = Number.POSITIVE_INFINITY;
    for (const { scope, scopeId } of scopes) {
      const limit = this.limitFor(scope, input.route);
      if (!limit) continue;
      const key = gatewayV16BucketKey(scope, scopeId, input.route);
      const verdict = this.checkBucket(key, limit, now);
      remaining = Math.min(remaining, verdict.remaining);
    }
    return {
      allowed: true,
      remaining: remaining === Number.POSITIVE_INFINITY ? 0 : remaining,
      limit: tightestLimit,
      resetAt: tightestResetAt,
      retryAfterMs: 0,
      retryAfterSeconds: 0,
      blockedBy: null,
      route: input.route,
    };
  }

  /**
   * Ghi một lần gọi (chỉ gọi sau khi `check` trả allowed — nếu
   * gọi khi đã bị chặn thì lần gọi vẫn được ghi, tức là caller
   * phải tự tôn trọng quyết định).
   */
  consume(input: GatewayV16CheckInput, now = Date.now()): GatewayV16Decision {
    const decision = this.check(input, now);
    if (!decision.allowed) return decision;
    const scopes: { scope: GatewayV16Scope; scopeId: string }[] = [
      { scope: 'global', scopeId: 'global' },
      { scope: 'tenant', scopeId: input.tenantId },
      { scope: 'user', scopeId: input.userId },
      { scope: 'route', scopeId: input.route },
    ];
    for (const { scope, scopeId } of scopes) {
      const limit = this.limitFor(scope, input.route);
      if (!limit) continue;
      const key = gatewayV16BucketKey(scope, scopeId, input.route);
      const timestamps = this.timestampsFor(key, limit.windowMs, now);
      timestamps.push(now);
      this.hits.set(key, timestamps);
    }
    return decision;
  }

  /** Số lần gọi còn lại của một scope + route (không ghi). */
  remaining(scope: GatewayV16Scope, scopeId: string, route: string, now = Date.now()): number {
    const limit = this.limitFor(scope, route);
    if (!limit) return Number.POSITIVE_INFINITY;
    const key = gatewayV16BucketKey(scope, scopeId, route);
    const timestamps = this.timestampsFor(key, limit.windowMs, now);
    return Math.max(0, limit.maxRequests - timestamps.length);
  }

  /** Xóa bucket của một scope (vd admin reset quota cho user). */
  reset(scope: GatewayV16Scope, scopeId: string, route?: string): void {
    for (const key of [...this.hits.keys()]) {
      if (route === undefined) {
        if (key.startsWith(`${scope}:${scopeId}:`)) this.hits.delete(key);
      } else if (key === gatewayV16BucketKey(scope, scopeId, route)) {
        this.hits.delete(key);
      }
    }
  }

  /** Dọn bucket rỗng / hết hạn (giữ bộ nhớ gọn khi chạy lâu). */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [key, timestamps] of [...this.hits.entries()]) {
      const scope = key.split(':')[0] as GatewayV16Scope;
      const route = key.split(':').slice(2).join(':');
      const limit = this.limitFor(scope, route);
      const windowMs = limit?.windowMs ?? 60 * 1000;
      const kept = timestamps.filter((t) => t > now - windowMs);
      if (kept.length === 0) {
        this.hits.delete(key);
        removed += 1;
      } else {
        this.hits.set(key, kept);
      }
    }
    return removed;
  }

  /** Số bucket đang giữ (để panel/monitor theo dõi). */
  get bucketCount(): number {
    return this.hits.size;
  }
}

/** Response HTTP 429 chuẩn từ một quyết định bị chặn. */
export interface GatewayV16TooManyRequests {
  status: 429;
  headers: Record<string, string>;
  body: { error: string; retryAfterSeconds: number; route: string; blockedBy: string };
}

export function gatewayV16TooManyRequests(decision: GatewayV16Decision): GatewayV16TooManyRequests {
  return {
    status: 429,
    headers: {
      'retry-after': String(decision.retryAfterSeconds),
      'x-ratelimit-limit': String(decision.limit),
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.ceil(decision.resetAt / 1000)),
    },
    body: {
      error: `rate limit exceeded for route ${decision.route} (blocked by ${decision.blockedBy ?? 'unknown'})`,
      retryAfterSeconds: decision.retryAfterSeconds,
      route: decision.route,
      blockedBy: decision.blockedBy ?? 'unknown',
    },
  };
}
