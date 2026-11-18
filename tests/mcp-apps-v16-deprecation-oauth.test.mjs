/**
 * Test v1.36 T3: MCP Apps v16 — deprecation policy + OAuth Client ID Metadata (node:test).
 * Local only, no network (fake fetcher).
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v16-deprecation-oauth.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeprecationPolicyEngineV16,
  buildDeprecationPoliciesV16,
  daysUntilDate,
  getMigrationPathV16,
} from '../packages/core/dist/mcp/deprecationPolicyV16.js';
import {
  ClientMetadataRegistryV16,
  canonicalizeJson,
  compareDcrWithMetadata,
  fingerprintClientMetadata,
  parseClientMetadataDocument,
  validateRedirectUri,
} from '../packages/core/dist/mcp/oauthClientIdV16.js';

test('deprecation policy: 3 capability Roots/Sampling/Logging, removal 2027-07-28, migration đủ bước', () => {
  const policies = buildDeprecationPoliciesV16();
  assert.deepEqual(
    policies.map((p) => p.capability),
    ['logging', 'roots', 'sampling'],
  );
  for (const policy of policies) {
    assert.equal(policy.removeAfter, '2027-07-28');
    assert.equal(policy.deprecatedIn, '2026-07-28');
    assert.ok(policy.methods.length > 0);
    assert.ok(policy.migration.steps.length >= 3);
    assert.ok(policy.migration.replacement.length > 0);
    assert.deepEqual(
      policy.migration.steps.map((s) => s.order),
      policy.migration.steps.map((_, i) => i + 1),
      'bước migration phải đánh số liên tục từ 1',
    );
  }
  const roots = policies.find((p) => p.capability === 'roots');
  assert.deepEqual(roots.methods, ['roots/list', 'roots/subscribe']);
  const sampling = getMigrationPathV16('sampling');
  assert.equal(sampling.effort, 'high');
  assert.match(sampling.replacement, /LLM API trực tiếp/);
  assert.equal(getMigrationPathV16('no-such-capability'), undefined);
});

test('deprecation daysUntilDate: tính đúng số ngày (UTC)', () => {
  // 2026-11-18 → 2027-07-28 = 252 ngày.
  const from = Date.parse('2026-11-18T00:00:00.000Z');
  assert.equal(daysUntilDate('2027-07-28', from), 252);
  assert.equal(daysUntilDate('2026-11-18', from), 0);
  assert.equal(daysUntilDate('2026-11-17', from), -1);
  assert.ok(Number.isNaN(daysUntilDate('not-a-date', from)));
});

test('deprecation engine: recordUsage đếm + throttle cảnh báo; status đổi theo ngày', () => {
  let nowMs = Date.parse('2026-11-18T00:00:00.000Z');
  const warnings = [];
  const engine = new DeprecationPolicyEngineV16({
    now: () => nowMs,
    onWarning: (message, capability) => warnings.push({ message, capability }),
  });
  assert.equal(engine.statusOf('sampling'), 'deprecated');
  assert.equal(engine.daysUntilRemoval('sampling'), 252);
  assert.equal(engine.statusOf('no-such'), null);
  assert.equal(engine.daysUntilRemoval('no-such'), null);

  const policy = engine.recordUsage('sampling/createMessage');
  assert.equal(policy.capability, 'sampling');
  assert.equal(engine.recordUsage('roots/list').capability, 'roots');
  assert.equal(engine.recordUsage('sampling/createMessage').capability, 'sampling');
  // Method không deprecated thì không ghi nhận.
  assert.equal(engine.recordUsage('tools/call'), null);
  const usage = engine.usageOf('sampling');
  assert.equal(usage.totalCalls, 2);
  assert.equal(usage.methods['sampling/createMessage'], 2);
  assert.equal(usage.firstSeenAtMs, nowMs);
  assert.equal(usage.lastSeenAtMs, nowMs);
  // Cảnh báo throttle 1 ngày: 3 lần gọi cùng ngày chỉ 2 cảnh báo (sampling + roots).
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].message, /2027-07-28/);
  assert.match(warnings[0].message, /còn 252 ngày/);
  // Sang ngày sau thì cảnh báo lại.
  nowMs += 25 * 60 * 60 * 1000;
  engine.recordUsage('sampling/createMessage');
  assert.equal(warnings.length, 3);
  assert.equal(engine.usageOf('sampling').totalCalls, 3);
});

test('deprecation engine: assertNotRemoved chặn sau ngày removal; markRemoved chặn ngay', () => {
  let nowMs = Date.parse('2026-11-18T00:00:00.000Z');
  const engine = new DeprecationPolicyEngineV16({ now: () => nowMs });
  assert.doesNotThrow(() => engine.assertNotRemoved('sampling/createMessage'));
  assert.doesNotThrow(() => engine.assertNotRemoved('tools/call'));
  // Tới ngày removal thì chặn.
  nowMs = Date.parse('2027-07-28T00:00:00.000Z');
  assert.equal(engine.statusOf('sampling'), 'removal-due');
  assert.throws(
    () => engine.assertNotRemoved('sampling/createMessage'),
    /đã tới hạn gỡ.*2027-07-28.*LLM API trực tiếp/,
  );
  // Trước hạn nhưng đã markRemoved thì chặn.
  const engine2 = new DeprecationPolicyEngineV16({
    now: () => Date.parse('2026-11-18T00:00:00.000Z'),
  });
  assert.equal(engine2.markRemoved('roots'), true);
  assert.equal(engine2.markRemoved('no-such'), false);
  assert.equal(engine2.statusOf('roots'), 'removed');
  assert.equal(engine2.isRemoved('roots'), true);
  assert.throws(() => engine2.assertNotRemoved('roots/list'), /đã tới hạn gỡ/);
});

test('deprecation engine: report tổng hợp + describe một dòng', () => {
  const engine = new DeprecationPolicyEngineV16({
    now: () => Date.parse('2026-11-18T00:00:00.000Z'),
  });
  engine.recordUsage('logging/setLevel');
  engine.recordUsage('logging/setLevel');
  engine.recordUsage('roots/list');
  const rows = engine.report();
  assert.equal(rows.length, 3);
  const logging = rows.find((r) => r.capability === 'logging');
  assert.equal(logging.totalCalls, 2);
  assert.equal(logging.status, 'deprecated');
  assert.equal(logging.daysUntilRemoval, 252);
  assert.equal(logging.migrationEffort, 'low');
  const sampling = rows.find((r) => r.capability === 'sampling');
  assert.equal(sampling.totalCalls, 0);
  assert.equal(sampling.lastSeenAtMs, null);
  assert.match(engine.describe(), /logging: deprecated, còn 252 ngày/);
  assert.match(engine.describe(), /roots: deprecated/);
  assert.match(engine.describe(), /sampling: deprecated/);
});

test('oauth redirect uri: https qua, http loopback qua, http ngoài / fragment / wildcard / userinfo bị cấm', () => {
  assert.doesNotThrow(() => validateRedirectUri('https://app.example.com/callback'));
  assert.doesNotThrow(() => validateRedirectUri('http://127.0.0.1:8080/callback'));
  assert.doesNotThrow(() => validateRedirectUri('http://localhost:3000/callback'));
  assert.throws(() => validateRedirectUri('http://app.example.com/callback'), /bắt buộc https/);
  assert.throws(() => validateRedirectUri('https://app.example.com/cb#frag'), /fragment/);
  assert.throws(() => validateRedirectUri('https://*.example.com/cb'), /wildcard/);
  assert.throws(() => validateRedirectUri('https://user:pass@app.example.com/cb'), /credential/);
  assert.throws(() => validateRedirectUri('custom://app/cb'), /chỉ https/);
  assert.throws(() => validateRedirectUri('not-a-url'), /không hợp lệ/);
});

test('oauth metadata parse: document hợp lệ qua; thiếu client_id / redirect_uris / auth method lạ thì ném đủ lỗi', () => {
  const doc = parseClientMetadataDocument({
    client_id: 'open-bot',
    client_name: 'Open Bot',
    redirect_uris: ['https://app.example.com/callback'],
    grant_types: ['authorization_code'],
    token_endpoint_auth_method: 'client_secret_basic',
    issuer: 'https://accounts.google.com',
  });
  assert.equal(doc.client_id, 'open-bot');
  assert.deepEqual(doc.redirect_uris, ['https://app.example.com/callback']);
  assert.equal(doc.issuer, 'https://accounts.google.com');

  assert.throws(
    () => parseClientMetadataDocument({ redirect_uris: ['https://app.example.com/cb'] }),
    /thiếu client_id/,
  );
  assert.throws(
    () => parseClientMetadataDocument({ client_id: 'x', redirect_uris: [] }),
    /thiếu redirect_uris/,
  );
  assert.throws(
    () =>
      parseClientMetadataDocument({
        client_id: 'x',
        redirect_uris: ['https://app.example.com/cb'],
        token_endpoint_auth_method: 'magic',
      }),
    /không hợp lệ/,
  );
  assert.throws(
    () =>
      parseClientMetadataDocument({
        client_id: 'x',
        redirect_uris: ['http://app.example.com/cb'],
        jwks_uri: 'http://app.example.com/jwks',
      }),
    /bắt buộc https/,
  );
});

test('oauth fingerprint: cùng document thì cùng hash; khác một trường thì khác hash; canonicalize sort key', () => {
  const a = { client_id: 'x', redirect_uris: ['https://a.example/cb'] };
  const b = { redirect_uris: ['https://a.example/cb'], client_id: 'x' };
  assert.equal(fingerprintClientMetadata(a), fingerprintClientMetadata(b));
  assert.equal(canonicalizeJson({ b: 1, a: 2 }), canonicalizeJson({ a: 2, b: 1 }));
  assert.notEqual(
    fingerprintClientMetadata(a),
    fingerprintClientMetadata({ client_id: 'x', redirect_uris: ['https://b.example/cb'] }),
  );
  assert.equal(fingerprintClientMetadata(a).length, 64);
});

test('oauth reuse detection: DCR cũ khác redirect/jwks thì alert; khớp thì null', () => {
  const metadata = {
    client_id: 'open-bot',
    redirect_uris: ['https://app.example.com/callback'],
    jwks_uri: 'https://app.example.com/jwks.json',
    token_endpoint_auth_method: 'private_key_jwt',
  };
  assert.equal(
    compareDcrWithMetadata(
      {
        client_id: 'open-bot',
        redirect_uris: ['https://app.example.com/callback'],
        jwks_uri: 'https://app.example.com/jwks.json',
        token_endpoint_auth_method: 'private_key_jwt',
      },
      metadata,
    ),
    null,
  );
  const alert = compareDcrWithMetadata(
    {
      client_id: 'open-bot',
      redirect_uris: ['https://evil.example.com/callback'],
      jwks_uri: 'https://evil.example.com/jwks.json',
      token_endpoint_auth_method: 'client_secret_basic',
    },
    metadata,
  );
  assert.equal(alert.clientId, 'open-bot');
  assert.deepEqual(alert.differingFields, [
    'redirect_uris',
    'jwks_uri',
    'token_endpoint_auth_method',
  ]);
  // Thứ tự redirect_uris khác nhau không tính là khác.
  assert.equal(
    compareDcrWithMetadata(
      {
        client_id: 'open-bot',
        redirect_uris: ['https://b.example/cb', 'https://a.example/cb'],
        jwks_uri: 'https://app.example.com/jwks.json',
        token_endpoint_auth_method: 'private_key_jwt',
      },
      { ...metadata, redirect_uris: ['https://a.example/cb', 'https://b.example/cb'] },
    ),
    null,
  );
});

test('oauth registry: register + lookup + revoke; reuse với DCR cũ thì fetchAndRegister từ chối', async () => {
  const registry = new ClientMetadataRegistryV16();
  const doc = {
    client_id: 'open-bot',
    redirect_uris: ['https://app.example.com/callback'],
    issuer: 'https://accounts.google.com',
  };
  const { registered, reuseAlert } = registry.register(doc);
  assert.equal(reuseAlert, null);
  assert.equal(registered.document.client_id, 'open-bot');
  assert.equal(registered.fingerprint.length, 64);
  assert.equal(registered.hadPriorDcrRegistration, false);
  assert.equal(registry.lookup('open-bot').document.client_id, 'open-bot');
  assert.equal(registry.size(), 1);
  assert.equal(registry.revoke('open-bot'), true);
  assert.equal(registry.lookup('open-bot'), undefined);
  assert.equal(registry.revoke('open-bot'), false);

  // DCR cũ khác redirect → fetchAndRegister fail closed.
  const fetcher = async (url) => {
    assert.equal(url, 'https://app.example.com/.well-known/oauth-client');
    return {
      client_id: 'open-bot',
      redirect_uris: ['https://app.example.com/callback'],
      issuer: 'https://accounts.google.com',
    };
  };
  const registry2 = new ClientMetadataRegistryV16(fetcher);
  registry2.notePriorDcrRegistration('open-bot', {
    redirect_uris: ['https://evil.example.com/callback'],
  });
  await assert.rejects(
    () => registry2.fetchAndRegister('https://app.example.com/.well-known/oauth-client'),
    /reuse credential.*redirect_uris/,
  );
  assert.equal(registry2.size(), 0, 'fail closed: không đăng ký bản reuse');

  // Không có fetcher thì ném; URL không https thì ném.
  const noFetcher = new ClientMetadataRegistryV16();
  await assert.rejects(
    () => noFetcher.fetchAndRegister('https://app.example.com/.well-known/oauth-client'),
    /Chưa cấu hình fetcher/,
  );
  const withFetcher = new ClientMetadataRegistryV16(fetcher);
  await assert.rejects(
    () => withFetcher.fetchAndRegister('http://app.example.com/doc'),
    /phải là https/,
  );
  // Fetch lần 2 dùng cache (fetcher chỉ gọi 1 lần).
  let fetchCount = 0;
  const counting = new ClientMetadataRegistryV16(async () => {
    fetchCount += 1;
    return { client_id: 'cached', redirect_uris: ['https://app.example.com/cb'] };
  });
  await counting.fetchAndRegister('https://app.example.com/.well-known/oauth-client');
  await counting.fetchAndRegister('https://app.example.com/.well-known/oauth-client');
  assert.equal(fetchCount, 1);
});

test('oauth registry: validateTokenForClient bắt buộc iss khớp metadata; thiếu issuer thì fail closed', () => {
  const registry = new ClientMetadataRegistryV16();
  assert.throws(
    () => registry.validateTokenForClient('ghost', 'token'),
    /chưa đăng ký metadata/,
  );
  registry.register({
    client_id: 'no-issuer',
    redirect_uris: ['https://app.example.com/cb'],
  });
  assert.throws(
    () => registry.validateTokenForClient('no-issuer', 'token'),
    /không khai issuer/,
  );

  // JWT tự tạo (header.payload.signature — chữ ký không kiểm tra ở đây,
  // validateTokenIssuer chỉ kiểm tra iss/exp/aud).
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const makeJwt = (payload) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
  registry.register({
    client_id: 'open-bot',
    redirect_uris: ['https://app.example.com/cb'],
    issuer: 'https://accounts.google.com',
  });
  const good = makeJwt({
    iss: 'https://accounts.google.com',
    aud: 'open-bot',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const result = registry.validateTokenForClient('open-bot', good);
  assert.equal(result.valid, true);
  const wrongIss = makeJwt({
    iss: 'https://evil.example.com',
    aud: 'open-bot',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.throws(
    () => registry.validateTokenForClient('open-bot', wrongIss),
    /iss|issuer/i,
  );
});
