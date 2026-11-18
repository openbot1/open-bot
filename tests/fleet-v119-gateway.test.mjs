/**
 * Gateway rate limiting v16 tests (v1.19, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Limit/config validation (maxRequests, windowMs, burst rules,
 *   route override keys).
 * - Default config values (user 60/min, tenant 600/min, route
 *   overrides incl. chat.completions 20/min, media.generate 5/min).
 * - Sliding window: allow up to maxRequests, then block with
 *   retryAfterMs > 0 and retryAfterSeconds >= 1; window slides
 *   (old hits expire).
 * - Scope order: global → tenant → user → route; blockedBy names
 *   the blocking scope; route override beats default.
 * - Burst allowance: extra calls allowed inside the burst window
 *   only, then blocked.
 * - check() does not record; consume() records; remaining(),
 *   reset(), prune(), bucketCount; 429 response shape.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v119-gateway.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GatewayV16RateLimiter,
  defaultGatewayV16Config,
  gatewayV16BucketKey,
  gatewayV16TooManyRequests,
  validateGatewayV16Config,
  validateGatewayV16Limit,
} from '../packages/core/dist/fleetV16/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const MIN = 60 * 1000;

function input(over = {}) {
  return { userId: 'u1', tenantId: 't1', route: 'chat.completions', ...over };
}

function smallConfig() {
  return {
    defaults: {
      user: { maxRequests: 3, windowMs: MIN },
      tenant: { maxRequests: 10, windowMs: MIN },
      route: { maxRequests: 5, windowMs: MIN },
      global: { maxRequests: 100, windowMs: MIN },
    },
    routeOverrides: {},
  };
}

test('gateway v16: limit + config validation', () => {
  assert.equal(validateGatewayV16Limit({ maxRequests: 10, windowMs: MIN }), '');
  assert.match(validateGatewayV16Limit({ maxRequests: 0, windowMs: MIN }), /maxRequests/);
  assert.match(validateGatewayV16Limit({ maxRequests: 1.5, windowMs: MIN }), /maxRequests/);
  assert.match(validateGatewayV16Limit({ maxRequests: 10, windowMs: 0 }), /windowMs/);
  assert.match(validateGatewayV16Limit({ maxRequests: 10, windowMs: MIN, burst: -1 }), /burst/);
  assert.match(
    validateGatewayV16Limit({ maxRequests: 10, windowMs: MIN, burst: 2, burstWindowMs: 2 * MIN }),
    /burstWindowMs phải <= windowMs/,
  );
  assert.equal(validateGatewayV16Limit({ maxRequests: 10, windowMs: MIN, burst: 2, burstWindowMs: 1000 }), '');
  assert.equal(validateGatewayV16Config(defaultGatewayV16Config()), '');
  assert.match(
    validateGatewayV16Config({ defaults: { user: { maxRequests: 0, windowMs: MIN } }, routeOverrides: {} }),
    /defaults\.user/,
  );
  assert.match(
    validateGatewayV16Config({ defaults: {}, routeOverrides: { '': { maxRequests: 1, windowMs: MIN } } }),
    /key rỗng/,
  );
  assert.throws(() => new GatewayV16RateLimiter({ defaults: { user: { maxRequests: 0, windowMs: MIN } }, routeOverrides: {} }), /không hợp lệ/);
});

test('gateway v16: default config values', () => {
  const cfg = defaultGatewayV16Config();
  assert.equal(cfg.defaults.user.maxRequests, 60);
  assert.equal(cfg.defaults.tenant.maxRequests, 600);
  assert.equal(cfg.defaults.global.maxRequests, 5000);
  assert.equal(cfg.routeOverrides['chat.completions'].maxRequests, 20);
  assert.equal(cfg.routeOverrides['media.generate'].maxRequests, 5);
  assert.equal(cfg.routeOverrides['tool.run'].maxRequests, 60);
  assert.equal(gatewayV16BucketKey('user', 'u1', 'chat.completions'), 'user:u1:chat.completions');
});

test('gateway v16: sliding window allow → block → slide', () => {
  const limiter = new GatewayV16RateLimiter(smallConfig());
  // 3 user calls allowed (user limit 3), 4th blocked by user scope.
  for (let i = 0; i < 3; i++) {
    const d = limiter.consume(input(), T0 + i * 1000);
    assert.equal(d.allowed, true, `call ${i + 1} should be allowed`);
    assert.equal(d.remaining, 2 - i);
    assert.equal(d.blockedBy, null);
  }
  const blocked = limiter.check(input(), T0 + 3000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedBy, 'user');
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= MIN);
  assert.ok(blocked.retryAfterSeconds >= 1);
  // check() does not record: still blocked, not worse.
  assert.equal(limiter.check(input(), T0 + 3000).allowed, false);
  // After the first hit slides out (T0 + 60s), one slot frees.
  const afterSlide = limiter.consume(input(), T0 + MIN + 1);
  assert.equal(afterSlide.allowed, true, 'window slid, first hit expired');
  // Different user is unaffected.
  assert.equal(limiter.check(input({ userId: 'u2' }), T0 + 3000).allowed, true);
  // 429 response shape.
  const r429 = gatewayV16TooManyRequests(blocked);
  assert.equal(r429.status, 429);
  assert.equal(r429.headers['retry-after'], String(blocked.retryAfterSeconds));
  assert.equal(r429.headers['x-ratelimit-remaining'], '0');
  assert.equal(r429.body.route, 'chat.completions');
  assert.equal(r429.body.blockedBy, 'user');
  assert.match(r429.body.error, /rate limit exceeded/);
});

test('gateway v16: scope order + route override', () => {
  // Global limit 1: second call from a different user/tenant still blocked by global.
  const limiter = new GatewayV16RateLimiter({
    defaults: {
      user: { maxRequests: 100, windowMs: MIN },
      tenant: { maxRequests: 100, windowMs: MIN },
      global: { maxRequests: 1, windowMs: MIN },
    },
    routeOverrides: {},
  });
  assert.equal(limiter.consume(input(), T0).allowed, true);
  const second = limiter.consume(input({ userId: 'u2', tenantId: 't2' }), T0 + 1000);
  assert.equal(second.allowed, false);
  assert.equal(second.blockedBy, 'global');
  // Route override beats the route default: override 1/min for this route.
  const over = new GatewayV16RateLimiter({
    defaults: { user: { maxRequests: 100, windowMs: MIN }, route: { maxRequests: 100, windowMs: MIN } },
    routeOverrides: { 'chat.completions': { maxRequests: 1, windowMs: MIN } },
  });
  assert.equal(over.limitFor('route', 'chat.completions').maxRequests, 1);
  assert.equal(over.limitFor('route', 'other.route').maxRequests, 100);
  assert.equal(over.consume(input(), T0).allowed, true);
  const blocked = over.consume(input(), T0 + 1000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedBy, 'route');
  assert.equal(over.limitFor('tenant', 'chat.completions'), null, 'no tenant default → null');
});

test('gateway v16: burst allowance', () => {
  const limiter = new GatewayV16RateLimiter({
    defaults: {
      user: { maxRequests: 2, windowMs: MIN, burst: 2, burstWindowMs: 5000 },
    },
    routeOverrides: {},
  });
  assert.equal(limiter.consume(input(), T0).allowed, true);
  assert.equal(limiter.consume(input(), T0 + 1000).allowed, true);
  // Over the base limit but inside the burst window → allowed.
  assert.equal(limiter.consume(input(), T0 + 2000).allowed, true);
  assert.equal(limiter.consume(input(), T0 + 3000).allowed, true);
  // Burst exhausted (4 in 5s burst window) → blocked.
  assert.equal(limiter.consume(input(), T0 + 4000).allowed, false);
});

test('gateway v16: remaining / reset / prune / bucketCount', () => {
  const limiter = new GatewayV16RateLimiter(smallConfig());
  assert.equal(limiter.bucketCount, 0);
  assert.equal(limiter.remaining('user', 'u1', 'chat.completions', T0), 3);
  limiter.consume(input(), T0);
  limiter.consume(input(), T0 + 1000);
  assert.equal(limiter.remaining('user', 'u1', 'chat.completions', T0 + 1000), 1);
  assert.ok(limiter.bucketCount > 0);
  limiter.reset('user', 'u1', 'chat.completions');
  assert.equal(limiter.remaining('user', 'u1', 'chat.completions', T0 + 1000), 3);
  // Reset without route clears all routes for that user.
  limiter.consume(input(), T0 + 2000);
  limiter.consume(input({ route: 'tool.run' }), T0 + 3000);
  limiter.reset('user', 'u1');
  assert.equal(limiter.remaining('user', 'u1', 'chat.completions', T0 + 3000), 3);
  assert.equal(limiter.remaining('user', 'u1', 'tool.run', T0 + 3000), 3);
  // Prune on a fresh limiter: live buckets kept, expired buckets removed.
  const p = new GatewayV16RateLimiter(smallConfig());
  p.consume(input(), T0);
  assert.ok(p.bucketCount > 0);
  assert.equal(p.prune(T0 + 1000), 0, 'buckets still live');
  assert.ok(p.bucketCount > 0);
  const removed = p.prune(T0 + 2 * MIN);
  assert.ok(removed > 0, 'expired buckets removed');
  assert.equal(p.bucketCount, 0);
});
