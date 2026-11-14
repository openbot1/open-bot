/**
 * Test v1.04 T2: MCP Apps v2 — declare before render (node:test).
 * Local only, no network: the fetcher is injected by the test.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v104-apps-v2.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AppPrefetchCache,
  AppTemplateError,
  appActionAllowed,
  declareAppTemplate,
  describeAppTemplate,
  recordAppAction,
  recordAppActionDenied,
  requiresReviewWarning,
  reviewAppTemplate,
} from '../packages/core/dist/mcp/appsV2.js';
import { McpAuditLog } from '../packages/core/dist/mcp/auditLog.js';

function template(overrides = {}) {
  return declareAppTemplate({
    id: 'acme-invoice-card',
    serverName: 'acme',
    toolName: 'invoice',
    title: 'Hoá đơn Acme',
    prefetch: [{ uri: 'https://cdn.acme.example/logo.svg', purpose: 'logo' }],
    cache: { maxAgeSec: 3600, revalidate: true },
    allowedActions: ['tool-call', 'link-open'],
    allowedHosts: ['cdn.acme.example'],
    ...overrides,
  });
}

test('declareAppTemplate: valid declaration is fingerprinted + starts unreviewed', () => {
  const t = template();
  assert.equal(t.review, 'unreviewed');
  assert.match(t.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(requiresReviewWarning(t), true);
  assert.equal(appActionAllowed(t, 'tool-call'), true);
  assert.equal(appActionAllowed(t, 'form-submit'), false);
  assert.match(describeAppTemplate(t), /unreviewed/);
  // Same declaration twice -> same fingerprint (deterministic).
  assert.equal(template().fingerprint, t.fingerprint);
  // A different title -> a different fingerprint (tamper-evident).
  assert.notEqual(template({ title: 'Hoá đơn khác' }).fingerprint, t.fingerprint);
});

test('declareAppTemplate: rejects bad id, title, prefetch, cache, actions', () => {
  assert.throws(() => template({ id: 'Bad ID!' }), AppTemplateError);
  assert.throws(() => template({ title: '' }), AppTemplateError);
  assert.throws(() => template({ title: 'x'.repeat(121) }), AppTemplateError);
  assert.throws(() => template({ prefetch: [{ uri: 'http://evil.example/x' }] }), AppTemplateError);
  assert.throws(() => template({ prefetch: [{ uri: 'javascript:alert(1)' }] }), AppTemplateError);
  assert.throws(
    () => template({ prefetch: [{ uri: 'https://user:pass@cdn.example/x' }] }),
    AppTemplateError,
  );
  assert.throws(() => template({ cache: { maxAgeSec: -1 } }), AppTemplateError);
  assert.throws(() => template({ cache: { maxAgeSec: 99999999 } }), AppTemplateError);
  assert.throws(() => template({ allowedActions: ['nuke'] }), AppTemplateError);
  assert.throws(
    () => template({ prefetch: Array.from({ length: 21 }, (_, i) => ({ uri: `https://a.example/${i}` })) }),
    AppTemplateError,
  );
  // ui:// app-local URIs are allowed.
  assert.equal(template({ prefetch: [{ uri: 'ui://acme/icon' }] }).prefetch[0].uri, 'ui://acme/icon');
});

test('reviewAppTemplate: review/approve/reject records reviewer + time, never mutates', () => {
  const t = template();
  const approved = reviewAppTemplate(t, 'approved', 'reviewer-1', {
    note: 'Đã kiểm tra CSP.',
    nowMs: 1000,
  });
  assert.equal(approved.review, 'approved');
  assert.equal(approved.reviewedBy, 'reviewer-1');
  assert.equal(approved.reviewedAt, 1000);
  assert.equal(approved.reviewNote, 'Đã kiểm tra CSP.');
  assert.equal(requiresReviewWarning(approved), false);
  assert.equal(t.review, 'unreviewed');
  assert.equal(requiresReviewWarning(reviewAppTemplate(t, 'rejected', 'r2')), true);
  assert.throws(() => reviewAppTemplate(t, 'approved', '  '), AppTemplateError);
});

test('AppPrefetchCache: prefetch skips fresh entries, expires by TTL, reports failures', async () => {
  let now = 1000;
  const cache = new AppPrefetchCache({ nowMs: () => now });
  const t = template();
  let fetches = 0;
  const fetcher = async (uri) => {
    fetches += 1;
    if (uri.includes('boom')) throw new Error('404');
    return `<svg>${uri}</svg>`;
  };

  const first = await cache.prefetch(t, fetcher);
  assert.deepEqual(first.fetched, ['https://cdn.acme.example/logo.svg']);
  assert.equal(fetches, 1);

  const second = await cache.prefetch(t, fetcher);
  assert.deepEqual(second.skipped, ['https://cdn.acme.example/logo.svg']);
  assert.equal(fetches, 1);

  // Past the 3600s TTL -> refetch.
  now += 3601 * 1000;
  const third = await cache.prefetch(t, fetcher);
  assert.deepEqual(third.fetched, ['https://cdn.acme.example/logo.svg']);
  assert.equal(fetches, 2);

  const failing = template({
    id: 'failing-app',
    prefetch: [{ uri: 'https://cdn.acme.example/boom' }],
  });
  const report = await cache.prefetch(failing, fetcher);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /404/);

  const stats = cache.stats();
  // Only the logo is stored (the failing fetch stored nothing);
  // hits: 1 (second prefetch), misses: 3, expired: 1.
  assert.equal(stats.entries, 1);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 3);
  assert.equal(stats.expired, 1);
  assert.ok(stats.bytes > 0);
});

test('AppPrefetchCache: total-bytes cap evicts oldest first', () => {
  // The constructor floors maxBytes at 1024, so use 600-byte bodies.
  const cache = new AppPrefetchCache({ maxBytes: 1024 });
  cache.put('a', 'ui://a/1', 'x'.repeat(600), 60);
  cache.put('a', 'ui://a/2', 'y'.repeat(600), 60);
  // 1200 bytes > 1024 cap -> oldest entry evicted, newest kept.
  assert.equal(cache.get('a', 'ui://a/1'), undefined);
  assert.notEqual(cache.get('a', 'ui://a/2'), undefined);
});

test('recordAppAction: UI-initiated tool call is audited with actor + template; denial too', () => {
  const log = new McpAuditLog();
  const entry = recordAppAction(log, {
    templateId: 'acme-invoice-card',
    serverName: 'acme',
    kind: 'tool-call',
    actor: 'huy',
    toolName: 'pay-invoice',
    args: { invoiceId: 'INV-1' },
    label: 'Thanh toán',
  });
  assert.equal(entry.method, 'tools/call');
  assert.equal(entry.tool, 'pay-invoice');
  assert.equal(entry.caller, 'mcp-app:acme-invoice-card:huy');
  assert.equal(entry.outcome, 'ok');
  assert.equal(log.size, 1);

  // Secrets in args are redacted by the audit log itself.
  const secret = recordAppAction(log, {
    templateId: 'acme-invoice-card',
    serverName: 'acme',
    kind: 'tool-call',
    actor: 'huy',
    toolName: 'pay-invoice',
    args: { apiKey: 'sk-secret-123' },
  });
  assert.ok(!JSON.stringify(secret.args).includes('sk-secret-123'));

  const denied = recordAppActionDenied(
    log,
    {
      templateId: 'acme-invoice-card',
      serverName: 'acme',
      kind: 'form-submit',
      actor: 'huy',
    },
    'form-submit không nằm trong allowedActions của template',
  );
  assert.equal(denied.outcome, 'error');
  assert.match(denied.errorMessage, /không nằm trong allowedActions/);
  assert.equal(log.size, 3);

  // No log configured -> null, the action still proceeds.
  assert.equal(recordAppAction(undefined, {
    templateId: 'x',
    serverName: 's',
    kind: 'link-open',
    actor: 'u',
  }), null);
});
