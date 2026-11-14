/**
 * Test v1.05 T2: MCP Apps v2 — manifest, security review, sandbox v2,
 * migration alerts (node:test, không mạng).
 *
 * Covers:
 *  - packages/core/src/mcp/appsV2Manifest.ts
 *  - packages/core/src/mcp/appsSandboxV2.ts
 *  - packages/core/src/mcp/mcpMigrationAlerts.ts
 *
 * Build core trước:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v105-apps-v2.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AppCacheManifest,
  buildSecurityReview,
  checkAppRunPolicy,
  describeAppPermissions,
  validateAppTemplateDeclaration,
} from '../packages/core/dist/mcp/appsV2Manifest.js';
import {
  AppPrefetchCache,
  declareAppTemplate,
  reviewAppTemplate,
} from '../packages/core/dist/mcp/appsV2.js';
import {
  buildCspString,
  buildSandboxPolicyV2,
  describeSandboxPolicy,
  diffSandboxPolicies,
  isValidSandboxPolicy,
  normalizeAllowedHost,
  validateSandboxPolicy,
} from '../packages/core/dist/mcp/appsSandboxV2.js';
import {
  countMigrationAlertsBySeverity,
  formatMigrationAlerts,
  hasUrgentMigrationAlert,
  mergeMigrationAlerts,
  migrationAlertsForDiscovery,
  migrationAlertsForNegotiation,
  summarizeMigrationAlerts,
} from '../packages/core/dist/mcp/mcpMigrationAlerts.js';

function makeTemplate(overrides = {}) {
  return declareAppTemplate({
    id: 'acme-invoice',
    serverName: 'acme',
    title: 'Invoice card',
    prefetch: [{ uri: 'https://cdn.acme.example/invoice.css', purpose: 'style' }],
    cache: { maxAgeSec: 3600 },
    allowedActions: ['tool-call', 'link-open'],
    allowedHosts: ['cdn.acme.example'],
    ...overrides,
  });
}

test('manifest: record + version change invalidates cache', async () => {
  const cache = new AppPrefetchCache({ nowMs: () => 1000 });
  const manifest = new AppCacheManifest({ nowMs: () => 1000 });
  const template = makeTemplate();
  const first = manifest.invalidateOnVersionChange(template, '1.0.0', cache);
  assert.equal(first.invalidated, false);
  // Prefetch + record.
  const fetched = await cache.prefetch(template, async () => 'body-css');
  assert.deepEqual(fetched.fetched, ['https://cdn.acme.example/invoice.css']);
  manifest.recordPrefetch(template, '1.0.0', fetched.fetched);
  assert.equal(cache.get(template.id, 'https://cdn.acme.example/invoice.css')?.body, 'body-css');
  assert.equal(manifest.hasUri(template.id, '1.0.0', 'https://cdn.acme.example/invoice.css'), true);
  assert.equal(manifest.hasUri(template.id, '2.0.0', 'https://cdn.acme.example/invoice.css'), false);
  // Same version + same fingerprint: cache survives.
  const same = manifest.invalidateOnVersionChange(template, '1.0.0', cache);
  assert.equal(same.invalidated, false);
  assert.ok(cache.get(template.id, 'https://cdn.acme.example/invoice.css'));
  // Version bump: cache cleared.
  const bumped = manifest.invalidateOnVersionChange(template, '1.1.0', cache);
  assert.equal(bumped.invalidated, true);
  assert.match(bumped.reason, /1\.0\.0 → 1\.1\.0/);
  assert.equal(cache.get(template.id, 'https://cdn.acme.example/invoice.css'), undefined);
  // Fingerprint change (declaration edited, same version): also invalidates.
  const edited = makeTemplate({ title: 'Invoice card v2' });
  manifest.recordPrefetch(edited, '1.1.0', ['https://cdn.acme.example/invoice.css']);
  await cache.prefetch(edited, async () => 'body2');
  const editedAgain = makeTemplate({ title: 'Invoice card v3' });
  const fp = manifest.invalidateOnVersionChange(editedAgain, '1.1.0', cache);
  assert.equal(fp.invalidated, true);
  assert.match(fp.reason, /fingerprint/);
  assert.equal(cache.get(edited.id, 'https://cdn.acme.example/invoice.css'), undefined);
});

test('manifest: JSON round-trip + corrupt entries skipped', () => {
  const manifest = new AppCacheManifest({ nowMs: () => 1000 });
  const template = makeTemplate();
  manifest.recordPrefetch(template, '1.0.0', ['https://cdn.acme.example/a.css']);
  const json = manifest.toJSON();
  assert.equal(json.formatVersion, 1);
  assert.equal(json.entries.length, 1);
  const { manifest: restored, skipped } = AppCacheManifest.fromJSON({
    formatVersion: 1,
    savedAtMs: 1000,
    entries: [
      ...json.entries,
      { templateId: 'bad' },
      'not-an-object',
      { templateId: 'x', version: '1', fingerprint: 'f', uris: 'nope', recordedAt: 1 },
    ],
  });
  assert.equal(skipped, 3);
  assert.equal(restored.size, 1);
  assert.equal(restored.get('acme-invoice')?.version, '1.0.0');
  // Wrong format version: everything skipped.
  const wrong = AppCacheManifest.fromJSON({ formatVersion: 99, entries: json.entries });
  assert.equal(wrong.manifest.size, 0);
  assert.equal(wrong.skipped, 1);
  assert.throws(() => manifest.recordPrefetch(template, '  ', []), /version không rỗng/);
});

test('security review: permissions, risk levels, warnings', () => {
  const unreviewed = makeTemplate();
  const review = buildSecurityReview(unreviewed, { version: '1.0.0', toolNames: ['create-invoice'] });
  assert.equal(review.risk, 'high'); // unreviewed + tool-call
  assert.equal(review.requiresWarning, true);
  assert.equal(review.version, '1.0.0');
  assert.equal(review.fingerprintShort, unreviewed.fingerprint.slice(0, 12));
  const kinds = review.permissions.map((p) => p.kind);
  assert.ok(kinds.includes('tools'));
  assert.ok(kinds.includes('network'));
  assert.ok(kinds.includes('data'));
  const tools = review.permissions.find((p) => p.kind === 'tools');
  assert.equal(tools.detail, 'create-invoice');
  assert.ok(review.warnings.length >= 2);
  assert.match(review.summary, /rủi ro: high/);
  assert.match(describeAppPermissions(review), /Gọi tool/);

  const approved = reviewAppTemplate(makeTemplate(), 'approved', 'host');
  const approvedReview = buildSecurityReview(approved, { version: '1.0.0' });
  assert.equal(approvedReview.risk, 'medium'); // tool-call + network still risky
  assert.equal(approvedReview.requiresWarning, false);

  const renderOnly = makeTemplate({ allowedActions: [], prefetch: [], allowedHosts: [] });
  const reviewedRenderOnly = reviewAppTemplate(renderOnly, 'approved', 'host');
  const lowReview = buildSecurityReview(reviewedRenderOnly);
  assert.equal(lowReview.risk, 'low');
  assert.equal(lowReview.permissions.length, 0);
  assert.match(lowReview.summary, /không xin quyền gì/);

  const rejected = reviewAppTemplate(makeTemplate(), 'rejected', 'host');
  const rejectedReview = buildSecurityReview(rejected);
  assert.equal(rejectedReview.risk, 'high');
  assert.ok(rejectedReview.warnings.some((w) => /từ chối/.test(w)));
});

test('security review: roots permission when requested', () => {
  const review = buildSecurityReview(makeTemplate(), { requestsRoots: true });
  const roots = review.permissions.find((p) => p.kind === 'roots');
  assert.ok(roots);
  assert.equal(roots.risky, true);
  assert.equal(review.risk, 'high');
});

test('checkAppRunPolicy: rejected denied, unreviewed needs confirmation', () => {
  assert.deepEqual(checkAppRunPolicy(reviewAppTemplate(makeTemplate(), 'rejected', 'h')), {
    allowed: false,
    needsConfirmation: false,
    reason: 'App "acme-invoice" đã bị từ chối review — không chạy.',
  });
  const unreviewed = checkAppRunPolicy(makeTemplate());
  assert.equal(unreviewed.allowed, true);
  assert.equal(unreviewed.needsConfirmation, true);
  const approved = checkAppRunPolicy(reviewAppTemplate(makeTemplate(), 'approved', 'h'));
  assert.equal(approved.allowed, true);
  assert.equal(approved.needsConfirmation, false);
});

test('validateAppTemplateDeclaration rejects bad shapes', () => {
  assert.throws(() => validateAppTemplateDeclaration(null), /phải là một object/);
  assert.throws(() => validateAppTemplateDeclaration({ serverName: 'x', title: 't' }), /thiếu "id"/);
  assert.throws(
    () => validateAppTemplateDeclaration({ id: 'a', serverName: 'x', title: 't', allowedActions: ['eval'] }),
    /chỉ chứa tool-call/,
  );
  const ok = validateAppTemplateDeclaration({ id: 'a', serverName: 'x', title: 't' });
  assert.equal(ok.id, 'a');
});

test('sandbox v2: unreviewed = no scripts, no network without hosts', () => {
  const template = makeTemplate({ allowedActions: [], prefetch: [], allowedHosts: [] });
  const policy = buildSandboxPolicyV2(template);
  assert.equal(policy.allowScripts, false);
  assert.equal(policy.csp.scriptSrc, "'none'");
  assert.equal(policy.csp.connectSrc, "'none'");
  assert.equal(policy.csp.defaultSrc, "'none'");
  assert.equal(policy.csp.frameSrc, "'none'");
  assert.equal(policy.csp.objectSrc, "'none'");
  assert.ok(!policy.sandboxFlags.includes('allow-same-origin'));
  assert.ok(!policy.sandboxFlags.includes('allow-scripts'));
  assert.ok(!policy.sandboxFlags.includes('allow-top-navigation'));
  assert.equal(isValidSandboxPolicy(policy), true);
  assert.deepEqual(validateSandboxPolicy(policy), []);
  assert.match(describeSandboxPolicy(policy), /script: chặn/);
});

test('sandbox v2: approved + hosts = scripts + network only to declared hosts', () => {
  const template = reviewAppTemplate(makeTemplate(), 'approved', 'host');
  const policy = buildSandboxPolicyV2(template);
  assert.equal(policy.allowScripts, true);
  assert.equal(policy.allowToolCalls, true);
  assert.equal(policy.allowPopups, true);
  assert.deepEqual(policy.allowedHosts, ['cdn.acme.example']);
  assert.ok(policy.csp.connectSrc.includes('https://cdn.acme.example'));
  assert.ok(!policy.csp.scriptSrc.includes('unsafe-eval'));
  assert.ok(!policy.csp.scriptSrc.includes('unsafe-inline'));
  assert.ok(policy.sandboxFlags.includes('allow-scripts'));
  assert.ok(policy.sandboxFlags.includes('allow-popups'));
  assert.ok(!policy.sandboxFlags.includes('allow-same-origin'));
  assert.equal(isValidSandboxPolicy(policy), true);
  // CSP string is stable and parseable.
  const rebuilt = buildCspString(policy.csp);
  assert.equal(rebuilt, policy.cspString);
  assert.ok(policy.cspString.startsWith("default-src 'none'"));
});

test('sandbox v2: rejected locks everything even when approved before', () => {
  const template = reviewAppTemplate(makeTemplate(), 'rejected', 'host');
  const policy = buildSandboxPolicyV2(template);
  assert.equal(policy.allowScripts, false);
  assert.equal(policy.allowToolCalls, false);
  assert.equal(policy.allowForms, false);
  assert.ok(policy.notes.some((n) => /rejected/.test(n)));
});

test('sandbox v2: validate catches hand-written bad policies', () => {
  const template = reviewAppTemplate(makeTemplate(), 'approved', 'host');
  const good = buildSandboxPolicyV2(template);
  const badSameOrigin = { ...good, sandboxFlags: [...good.sandboxFlags, 'allow-same-origin'] };
  assert.ok(validateSandboxPolicy(badSameOrigin).some((e) => /allow-same-origin/.test(e)));
  const badEval = {
    ...good,
    csp: { ...good.csp, scriptSrc: "'self' 'unsafe-eval'" },
  };
  assert.ok(validateSandboxPolicy(badEval).some((e) => /unsafe-eval/.test(e)));
  const badHost = {
    ...good,
    csp: { ...good.csp, connectSrc: "'self' https://evil.example" },
  };
  assert.ok(validateSandboxPolicy(badHost).some((e) => /evil\.example/.test(e)));
  assert.equal(normalizeAllowedHost('HTTPS://CDN.Example.COM:443'), 'cdn.example.com');
  assert.throws(() => normalizeAllowedHost('host/path'), /không hợp lệ/);
});

test('sandbox v2: diff reports added/removed hosts and script flips', () => {
  const before = buildSandboxPolicyV2(makeTemplate());
  const after = buildSandboxPolicyV2(
    reviewAppTemplate(makeTemplate({ allowedHosts: ['cdn.acme.example', 'img.acme.example'] }), 'approved', 'h'),
  );
  const diffs = diffSandboxPolicies(before, after);
  assert.ok(diffs.some((d) => /script/.test(d)));
  assert.ok(diffs.some((d) => /thêm host "img\.acme\.example"/.test(d)));
  assert.deepEqual(diffSandboxPolicies(before, before), []);
});

test('migration alerts: deprecated capabilities + missing extensions + old protocol', () => {
  const alerts = migrationAlertsForDiscovery({
    protocolVersion: '2025-11-25',
    capabilities: {
      tools: {},
      sampling: {},
      roots: {},
      logging: {},
    },
    serverInfo: { name: 'old-server', version: '0.1.0' },
  });
  const subjects = alerts.map((a) => a.subject);
  assert.ok(subjects.includes('sampling/createMessage'));
  assert.ok(subjects.includes('roots/list'));
  assert.ok(subjects.includes('notifications/message'));
  assert.ok(subjects.includes('tasks'));
  assert.ok(subjects.includes('apps'));
  assert.ok(subjects.includes('protocolVersion'));
  const sampling = alerts.find((a) => a.subject === 'sampling/createMessage');
  assert.equal(sampling.severity, 'warning');
  assert.ok(sampling.replacement.includes('MRTR'));
  assert.ok(sampling.steps.length > 0);
  assert.equal(sampling.removeAfter, '2027-07-28');
  const counts = countMigrationAlertsBySeverity(alerts);
  assert.ok(counts.warning >= 4);
  assert.ok(formatMigrationAlerts(alerts).includes('Migration MCP 2.0'));
  assert.match(summarizeMigrationAlerts(alerts), /cảnh báo/);
});

test('migration alerts: up-to-date server has no alerts', () => {
  const alerts = migrationAlertsForDiscovery({
    protocolVersion: '2026-07-28',
    capabilities: {
      tools: {},
      tasks: {},
      apps: {},
    },
    serverInfo: { name: 'new-server', version: '2.0.0' },
  });
  assert.deepEqual(alerts, []);
  assert.equal(formatMigrationAlerts(alerts), 'Không có cảnh báo migration — server đã dùng MCP 2026-07-28 đầy đủ.');
  assert.match(summarizeMigrationAlerts(alerts), /up-to-date/);
});

test('migration alerts: handshake fallback is urgent; merge keeps highest severity', () => {
  const fallback = migrationAlertsForNegotiation(
    { mode: 'handshake', protocolVersion: '2025-11-25', discovered: null, fellBack: true, discoveredOlderVersion: false },
    'old-server',
  );
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].severity, 'urgent');
  assert.equal(hasUrgentMigrationAlert(fallback), true);
  assert.deepEqual(
    migrationAlertsForNegotiation(
      { mode: 'stateless', protocolVersion: '2026-07-28', discovered: null, fellBack: false, discoveredOlderVersion: false },
      'new-server',
    ),
    [],
  );
  const merged = mergeMigrationAlerts(
    [{ subject: 'x', severity: 'info', message: 'm', replacement: 'r' }],
    [{ subject: 'x', severity: 'urgent', message: 'm2', replacement: 'r2' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, 'urgent');
});
