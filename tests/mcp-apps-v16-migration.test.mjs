/**
 * Test v1.36 T3: MCP Apps v16 — migration v15 → v16 (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v16-migration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReadinessReport,
  checkLegacyConfig,
  migrateStatelessConfig,
  migrationChecklistFor,
} from '../packages/core/dist/mcp/mcpV16Migration.js';

const CLEAN_CLIENT = {
  usesInitialize: false,
  usesSessionIdHeader: false,
  hasServerDiscover: true,
  protocolVersion: '2026-07-28',
  deprecatedCapabilities: [],
  usesServerInitiatedRequests: false,
  formElicitsSecrets: false,
  usesDynamicClientRegistration: false,
  declaredExtensions: ['io.modelcontextprotocol/ui'],
  endpointUrls: ['https://a.example/rpc'],
  name: 'open-bot',
  version: '1.36.0',
};

const LEGACY_CLIENT = {
  usesInitialize: true,
  usesSessionIdHeader: true,
  hasServerDiscover: false,
  protocolVersion: '2025-11-25',
  deprecatedCapabilities: ['sampling', 'roots'],
  usesServerInitiatedRequests: true,
  formElicitsSecrets: true,
  usesDynamicClientRegistration: true,
  declaredExtensions: [],
  endpointUrls: ['https://old.example/rpc'],
};

test('migration: config sạch thì không có blocking, điểm 100, ready=true', () => {
  const issues = checkLegacyConfig(CLEAN_CLIENT, 'client');
  assert.deepEqual(issues, []);
  const report = buildReadinessReport(CLEAN_CLIENT, { role: 'client' });
  assert.equal(report.ready, true);
  assert.equal(report.score, 100);
  assert.equal(report.blocking.length, 0);
  assert.equal(report.warnings.length, 0);
  assert.match(report.summary, /Sẵn sàng/);
  assert.equal(report.checksRun, 10);
});

test('migration: config cũ liệt kê đủ blocking (initialize, session id, discover, server-initiated, form secret, DCR)', () => {
  const issues = checkLegacyConfig(LEGACY_CLIENT, 'client');
  const codes = issues.map((i) => i.code);
  for (const expected of [
    'uses-initialize',
    'uses-session-id-header',
    'no-server-discover',
    'uses-server-initiated-requests',
    'form-elicits-secrets',
    'uses-dynamic-client-registration',
  ]) {
    assert.ok(codes.includes(expected), `thiếu blocking ${expected}`);
  }
  const blocking = issues.filter((i) => i.severity === 'blocking');
  assert.equal(blocking.length, 6);
  assert.ok(issues.some((i) => i.code === 'old-protocol-version' && i.severity === 'warning'));
  assert.ok(issues.some((i) => i.code === 'uses-deprecated-sampling' && i.severity === 'warning'));
  assert.ok(issues.some((i) => i.code === 'uses-deprecated-roots' && i.severity === 'warning'));
  assert.ok(issues.some((i) => i.code === 'no-extensions-declared' && i.severity === 'info'));
  const sampling = issues.find((i) => i.code === 'uses-deprecated-sampling');
  assert.match(sampling.detail, /2027-07-28/);
  assert.match(sampling.migration, /LLM API trực tiếp/);
});

test('migration: report điểm = 100 - 25*blocking - 10*warning; chưa ready khi còn blocking', () => {
  const report = buildReadinessReport(LEGACY_CLIENT, { role: 'client' });
  assert.equal(report.ready, false);
  // 6 blocking (-150) + 3 warning (-30) → clamp về 0.
  assert.equal(report.score, 0);
  assert.equal(report.blocking.length, 6);
  assert.equal(report.warnings.length, 3);
  assert.match(report.summary, /Chưa sẵn sàng/);
  assert.match(report.summary, /6 blocking, 3 warning/);

  const oneWarning = buildReadinessReport(
    { ...CLEAN_CLIENT, protocolVersion: '2025-11-25' },
    { role: 'client' },
  );
  assert.equal(oneWarning.ready, true, 'warning không chặn ready');
  assert.equal(oneWarning.score, 90);
  assert.equal(oneWarning.warnings.length, 1);
});

test('migration: app-host check — chưa declare template là warning; server check đủ vai', () => {
  const hostIssues = checkLegacyConfig(
    { declaresAppTemplates: false, hasServerDiscover: true },
    'app-host',
  );
  assert.ok(hostIssues.some((i) => i.code === 'app-templates-not-declared'));
  assert.equal(hostIssues.some((i) => i.code === 'no-server-discover'), false, 'app-host không bị check discover');
  const hostOk = checkLegacyConfig({ declaresAppTemplates: true }, 'app-host');
  assert.deepEqual(hostOk, []);

  const serverIssues = checkLegacyConfig(
    { ...LEGACY_CLIENT, endpointUrls: [] },
    'server',
  );
  assert.ok(serverIssues.some((i) => i.code === 'no-endpoints' && i.severity === 'warning'));
});

test('migration: migrateStatelessConfig bỏ initialize/session-id, giữ endpoint + capabilities theo extension', () => {
  const migrated = migrateStatelessConfig(LEGACY_CLIENT);
  assert.equal(migrated.protocolVersion, '2026-07-28');
  assert.deepEqual(migrated.endpoints, [{ url: 'https://old.example/rpc' }]);
  assert.equal(migrated.capabilities.multiRoundTrip, true);
  assert.equal(migrated.capabilities.apps, false);
  assert.equal(migrated.capabilities.tasks, false);
  assert.equal(migrated.capabilities.deprecatedCallbacks, true);
  assert.equal(migrated.dropped.length, 3, 'initialize + session id + server-initiated');
  assert.ok(migrated.dropped.some((d) => d.includes('initialize')));
  assert.ok(migrated.dropped.some((d) => d.includes('Mcp-Session-Id')));
  assert.ok(migrated.warnings.some((w) => w.includes('MRTR')));
  assert.ok(migrated.warnings.some((w) => w.includes('2027-07-28')));

  const clean = migrateStatelessConfig(CLEAN_CLIENT);
  assert.deepEqual(clean.dropped, []);
  assert.equal(clean.capabilities.apps, true);
  assert.deepEqual(clean.clientInfo, { name: 'open-bot', version: '1.36.0' });
  assert.equal(clean.warnings.length, 0);

  const noEndpoint = migrateStatelessConfig({ usesInitialize: false });
  assert.deepEqual(noEndpoint.endpoints, []);
  assert.ok(noEndpoint.warnings.some((w) => w.includes('endpoint')));
});

test('migration: checklist theo vai — client/server/app-host khác nhau, đều có điểm chung', () => {
  const client = migrationChecklistFor('client');
  const server = migrationChecklistFor('server');
  const host = migrationChecklistFor('app-host');
  for (const item of [
    'Gọi server/discover trước mọi method khác (thay initialize).',
    'Không gửi header Mcp-Session-Id.',
  ]) {
    assert.ok(client.includes(item));
    assert.ok(server.includes(item));
  }
  assert.ok(client.some((s) => s.includes('input_required')));
  assert.ok(client.some((s) => s.includes('RFC 9207')));
  assert.ok(server.some((s) => s.includes('idempotent')));
  assert.ok(server.some((s) => s.includes('2027-07-28')));
  assert.ok(host.some((s) => s.includes('declare → prefetch → review → open')));
  assert.ok(host.some((s) => s.includes('privileged')));
  assert.equal(host.some((s) => s.includes('server/discover')), false);
});
