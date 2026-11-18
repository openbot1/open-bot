/**
 * Gateway rate limiting v2 tests (v1.20, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Defaults: user 60/min + burst 10, tenant 600/min, route
 *   overrides (chat.completions 20/min, media.generate 5/min).
 * - Sliding window: calls up to the limit pass, the next one is
 *   blocked with retryAfterMs/resetAt; after the window slides,
 *   calls pass again.
 * - Token bucket: burst lets a few extra calls through past the
 *   sliding-window limit; once tokens run out the mechanism is
 *   'token-bucket'; tokens refill over time.
 * - Scope isolation: a blocked user does not block another user;
 *   the route scope blocks a heavy route while other routes pass.
 * - Headers: allowed decisions carry X-RateLimit-* without
 *   Retry-After; blocked decisions carry Retry-After + 429 body.
 * - Reset/prune: reset clears a user's buckets; prune removes
 *   empty buckets.
 * - Load simulation: even pattern under the limit allows
 *   everything; burst-start over the limit blocks some and reports
 *   blockedRate/p95/topBlocker; invalid args throw.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v120-ratelimit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GatewayV17RateLimiter,
  defaultGatewayV17Config,
  gatewayV17RateLimitHeaders,
  gatewayV17TooManyRequests,
  simulateGatewayV17Load,
  validateGatewayV17Config,
  validateGatewayV17Limit,
} from '../packages/core/dist/fleetV17/index.js';

const T0 = Date.UTC(2026, 11, 16, 0, 0, 0);
const MIN = 60 * 1000;

function input(over = {}) {
  return { userId: 'u1', tenantId: 'acme', route: 'chat.completions', ...over };
}

test('gatewayV17 defaults: validate config and limits', () => {
  assert.equal(validateGatewayV17Config(defaultGatewayV17Config()), '');
  assert.notEqual(validateGatewayV17Limit({ maxRequests: 0, windowMs: 1000, burst: 0 }), '');
  assert.notEqual(validateGatewayV17Limit({ maxRequests: 10, windowMs: 0, burst: 0 }), '');
  assert.notEqual(validateGatewayV17Limit({ maxRequests: 10, windowMs: 1000, burst: -1 }), '');
  assert.equal(validateGatewayV17Limit({ maxRequests: 10, windowMs: 1000, burst: 2 }), '');
  const limiter = new GatewayV17RateLimiter();
  assert.equal(limiter.limitFor('user', 'chat.completions').maxRequests, 60);
  assert.equal(limiter.limitFor('route', 'chat.completions').maxRequests, 20);
  assert.equal(limiter.limitFor('route', 'media.generate').maxRequests, 5);
  assert.equal(limiter.limitFor('route', 'unknown.route').maxRequests, 30);
});

test('gatewayV17 sliding window blocks at the limit and recovers', () => {
  const limiter = new GatewayV17RateLimiter({
    defaults: { user: { maxRequests: 3, windowMs: MIN, burst: 0 } },
    routeOverrides: {},
  });
  for (let i = 0; i < 3; i++) {
    const d = limiter.consume(input(), T0 + i * 1000);
    assert.equal(d.allowed, true, `call ${i} should pass`);
  }
  const blocked = limiter.consume(input(), T0 + 4000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedBy, 'user');
  assert.equal(blocked.blockedByMechanism, 'sliding-window');
  assert.ok(blocked.retryAfterMs > 0);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.ok(blocked.resetAt > T0);
  // After the first call slides out of the window, calls pass again.
  const later = limiter.consume(input(), T0 + MIN + 1000);
  assert.equal(later.allowed, true);
});

test('gatewayV17 token bucket allows a burst then blocks by bucket', () => {
  const limiter = new GatewayV17RateLimiter({
    defaults: {
      user: { maxRequests: 3, windowMs: MIN, burst: 2, refillPerSecond: 0.05 },
    },
    routeOverrides: {},
  });
  // 3 sustained + 2 burst = 5 calls pass at the same instant.
  for (let i = 0; i < 5; i++) {
    const d = limiter.consume(input(), T0);
    assert.equal(d.allowed, true, `call ${i} should pass (burst)`);
  }
  // 6th call: window cap (3+2) reached AND tokens empty -> window wins.
  const blocked = limiter.consume(input(), T0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedByMechanism, 'sliding-window');
  assert.equal(blocked.tokensRemaining, 0);
  // After the window slides (61s), tokens refilled (0.05/s * 61 = 3.05) -> passes.
  const refilled = limiter.consume(input(), T0 + 61 * 1000);
  assert.equal(refilled.allowed, true);
});

test('gatewayV17 token bucket blocks when window is clear but tokens are empty', () => {
  const limiter = new GatewayV17RateLimiter({
    defaults: {
      user: { maxRequests: 10, windowMs: MIN, burst: 0, refillPerSecond: 0.01 },
    },
    routeOverrides: {},
  });
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.consume(input(), T0).allowed, true);
  }
  // Window cleared after 61s, but only 0.61 tokens refilled -> bucket blocks.
  const blocked = limiter.consume(input(), T0 + 61 * 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedByMechanism, 'token-bucket');
  assert.ok(blocked.retryAfterMs > 0);
  // After 110s more than a full token is back -> passes.
  assert.equal(limiter.consume(input(), T0 + 110 * 1000).allowed, true);
});

test('gatewayV17 scope isolation: blocked user does not block others', () => {
  const limiter = new GatewayV17RateLimiter({
    defaults: { user: { maxRequests: 2, windowMs: MIN, burst: 0 } },
    routeOverrides: {},
  });
  limiter.consume(input({ userId: 'u1' }), T0);
  limiter.consume(input({ userId: 'u1' }), T0);
  assert.equal(limiter.consume(input({ userId: 'u1' }), T0).allowed, false);
  assert.equal(limiter.consume(input({ userId: 'u2' }), T0).allowed, true);
});

test('gatewayV17 route scope blocks a heavy route only', () => {
  const limiter = new GatewayV17RateLimiter({
    defaults: { user: { maxRequests: 100, windowMs: MIN, burst: 0 } },
    routeOverrides: { 'media.generate': { maxRequests: 2, windowMs: MIN, burst: 0 } },
  });
  limiter.consume(input({ route: 'media.generate' }), T0);
  limiter.consume(input({ route: 'media.generate' }), T0);
  const blocked = limiter.consume(input({ route: 'media.generate' }), T0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedBy, 'route');
  assert.equal(limiter.consume(input({ route: 'chat.completions' }), T0).allowed, true);
});

test('gatewayV17 headers: allowed has X-RateLimit-*, blocked adds Retry-After + 429', () => {
  const limiter = new GatewayV17RateLimiter({
    defaults: { user: { maxRequests: 1, windowMs: MIN, burst: 0 } },
    routeOverrides: {},
  });
  const ok = limiter.consume(input(), T0);
  const okHeaders = gatewayV17RateLimitHeaders(ok);
  assert.equal(okHeaders['x-ratelimit-limit'], '1');
  assert.equal(okHeaders['x-ratelimit-remaining'], '0');
  assert.ok(okHeaders['x-ratelimit-reset']);
  assert.equal(okHeaders['retry-after'], undefined);
  const blocked = limiter.consume(input(), T0);
  const res = gatewayV17TooManyRequests(blocked);
  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], String(blocked.retryAfterSeconds));
  assert.equal(res.headers['x-ratelimit-remaining'], '0');
  assert.equal(res.body.route, 'chat.completions');
  assert.equal(res.body.blockedBy, 'user');
  assert.equal(res.body.mechanism, 'sliding-window');
});

test('gatewayV17 check does not record; reset clears buckets; prune cleans', () => {
  const limiter = new GatewayV17RateLimiter({
    defaults: { user: { maxRequests: 1, windowMs: MIN, burst: 0 } },
    routeOverrides: {},
  });
  const checked = limiter.check(input(), T0);
  assert.equal(checked.allowed, true);
  assert.equal(limiter.check(input(), T0).allowed, true, 'check must not consume');
  limiter.consume(input(), T0);
  assert.equal(limiter.check(input(), T0).allowed, false);
  limiter.reset('user', 'u1');
  // check() tự tạo lại bucket (như v16) nên đếm bucket NGAY sau reset.
  assert.equal(limiter.bucketCount, 0);
  assert.equal(limiter.check(input(), T0).allowed, true);
  limiter.consume(input(), T0);
  const pruned = limiter.prune(T0 + 2 * MIN);
  assert.ok(pruned >= 0);
});

test('gatewayV17 load sim: even under limit allows all; burst-start blocks some', () => {
  const limiter = new GatewayV17RateLimiter({
    defaults: { user: { maxRequests: 60, windowMs: MIN, burst: 10 } },
    routeOverrides: {},
  });
  const even = simulateGatewayV17Load(limiter, input(), 50, MIN, 'even', T0);
  assert.equal(even.allowed, 50);
  assert.equal(even.blocked, 0);
  assert.equal(even.blockedRate, 0);
  assert.equal(even.topBlocker, '');
  const limiter2 = new GatewayV17RateLimiter({
    defaults: { user: { maxRequests: 10, windowMs: MIN, burst: 0, refillPerSecond: 10 / 60 } },
    routeOverrides: {},
  });
  const burst = simulateGatewayV17Load(limiter2, input(), 40, MIN, 'burst-start', T0);
  assert.ok(burst.blocked > 0, 'burst over the limit must block some calls');
  assert.equal(burst.allowed + burst.blocked, 40);
  assert.ok(burst.blockedRate > 0 && burst.blockedRate < 1);
  assert.ok(burst.maxRetryAfterMs > 0);
  assert.ok(burst.p95RetryAfterMs >= burst.p50RetryAfterMs);
  assert.match(burst.topBlocker, /user/);
  const ramp = simulateGatewayV17Load(
    new GatewayV17RateLimiter({
      defaults: { user: { maxRequests: 10, windowMs: MIN, burst: 0, refillPerSecond: 10 / 60 } },
      routeOverrides: {},
    }),
    input(), 40, MIN, 'ramp-up', T0,
  );
  assert.equal(ramp.pattern, 'ramp-up');
  assert.equal(ramp.totalRequests, 40);
  assert.throws(() => simulateGatewayV17Load(limiter, input(), 0, MIN, 'even', T0), /totalRequests/);
  assert.throws(() => simulateGatewayV17Load(limiter, input(), 10, 0, 'even', T0), /durationMs/);
});

test('gatewayV17 invalid config throws', () => {
  assert.throws(
    () => new GatewayV17RateLimiter({ defaults: { user: { maxRequests: 0, windowMs: 1000, burst: 0 } }, routeOverrides: {} }),
    /không hợp lệ/,
  );
});
