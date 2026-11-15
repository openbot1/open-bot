/**
 * Tests v1.09 (Đội T4): Agent Card v1.1 + version negotiation v1.1 +
 * xác thực card trước khi kết nối.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/a2a-v109-card-v11.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_SUPPORTED_PROTOCOL_VERSIONS_V11,
  A2A_PROTOCOL_VERSION_V11,
  A2aTrustStore,
  buildAgentCard,
  buildAgentCardV11,
  checkAgentCardExpiry,
  checkAgentCardVersionV11,
  commonProtocolFeatures,
  downgradeAgentCardToV10,
  featuresForProtocolVersion,
  generateA2aSigningKey,
  isAgentCardExpired,
  isAgentCardV11,
  isValidAgentCardV11,
  keyRotationExplainsChange,
  negotiateProtocolVersionV11,
  normalizeTrustUrl,
  protocolVersionHasFeature,
  summarizeAgentCardV11,
  upgradeAgentCardToV11,
  validateAgentCardV11,
  verifyCardForConnect,
} from '../packages/core/dist/index.js';
import { signAgentCard, verifyAgentCardSignature } from '../packages/core/dist/a2a/signing.js';

// v1.11 merge fix: NOW cố định 2026-11-15T07:00Z làm FUTURE (= NOW + 1h)
// hết hạn theo giờ thật — summarizeAgentCardV11 kiểm tra hết hạn bằng
// Date.now() thật (không nhận nowMs), nên suite chạy sau 08:00Z cùng ngày
// sẽ thấy card "hết hạn" dù test vẫn đúng. NOW lấy theo giờ thật để
// FUTURE luôn ở tương lai; mọi assert khác đều dùng NOW tương đối nên
// không đổi ngữ nghĩa.
const NOW = Date.now();
const FUTURE = new Date(NOW + 60 * 60 * 1000).toISOString();
const PAST = new Date(NOW - 60 * 1000).toISOString();

function baseCardV11() {
  return buildAgentCardV11({
    name: 'open-bot',
    description: 'Local-first agent',
    url: 'http://127.0.0.1:8765/',
    skills: [
      { id: 'search', name: 'Search', description: 'Search the web' },
      { id: 'read', name: 'Read file', description: 'Read a file' },
    ],
    streaming: true,
    resumableStreams: true,
    multiTenancy: true,
    validUntil: FUTURE,
    issuedAt: new Date(NOW).toISOString(),
  });
}

test('cardV11: build mặc định protocol 1.1 + đủ capability v1.1', () => {
  const card = baseCardV11();
  assert.equal(card.protocolVersion, '1.1');
  assert.deepEqual(card.protocolVersions, ['1.1', '1.0.1', '1.0']);
  assert.equal(card.capabilities?.resumableStreams, true);
  assert.equal(card.capabilities?.multiTenancy, true);
  assert.equal(card.capabilities?.streaming, true);
  assert.equal(isAgentCardV11(card), true);
  assert.equal(validateAgentCardV11(card).length, 0);
  assert.equal(isValidAgentCardV11(card), true);
});

test('cardV11: protocolVersions phải chứa protocolVersion', () => {
  const card = baseCardV11();
  const bad = { ...card, protocolVersions: ['1.0'] };
  assert.ok(validateAgentCardV11(bad).some((p) => p.includes('protocolVersions')));
  const bad2 = { ...card, validUntil: 'not-a-date' };
  assert.ok(validateAgentCardV11(bad2).some((p) => p.includes('validUntil')));
  const bad3 = {
    ...card,
    tenants: [{ tenantId: 'a' }, { tenantId: 'a' }],
  };
  assert.ok(validateAgentCardV11(bad3).some((p) => p.includes('duplicate')));
  const bad4 = { ...card, keyRotation: { currentKeyId: '' } };
  assert.ok(validateAgentCardV11(bad4).some((p) => p.includes('currentKeyId')));
});

test('cardV11: upgrade 1.0 -> 1.1 giữ nguyên field, downgrade về 1.0 bỏ field v1.1', () => {
  const v10 = buildAgentCard({
    name: 'old-agent',
    description: 'Agent cũ',
    url: 'http://127.0.0.1:9000/',
    protocolVersion: '1.0',
    skills: [{ id: 's1', name: 'S1', description: 'd1' }],
  });
  assert.equal(isAgentCardV11(v10), false);
  const v11 = upgradeAgentCardToV11(v10);
  assert.equal(isAgentCardV11(v11), true);
  assert.deepEqual(v11.protocolVersions, ['1.0', '1.1', '1.0.1']);
  assert.equal(v11.name, 'old-agent');
  assert.equal(v11.capabilities?.resumableStreams, false);
  const back = downgradeAgentCardToV10(v11);
  assert.equal(back.protocolVersion, '1.0.1');
  assert.equal('protocolVersions' in back, false);
  assert.equal('validUntil' in back, false);
  assert.equal(back.capabilities?.resumableStreams, undefined);
  assert.equal(back.name, 'old-agent');
});

test('cardV11: expiry — chưa hết hạn / đã hết hạn / sai định dạng / không có hạn', () => {
  assert.equal(isAgentCardExpired({ validUntil: FUTURE }, NOW), false);
  assert.equal(isAgentCardExpired({ validUntil: PAST }, NOW), true);
  assert.equal(isAgentCardExpired({}, NOW), false);
  const bad = checkAgentCardExpiry({ validUntil: 'banana' }, NOW);
  assert.equal(bad.expired, true);
  assert.match(bad.reason ?? '', /không đọc được/);
  const ok = checkAgentCardExpiry({ validUntil: FUTURE }, NOW);
  assert.equal(ok.expired, false);
  assert.ok((ok.msRemaining ?? 0) > 0);
});

test('cardV11: summarize không lộ chữ ký/key', () => {
  const key = generateA2aSigningKey();
  const signed = signAgentCard(baseCardV11(), key);
  const summary = summarizeAgentCardV11(signed);
  assert.equal(summary.name, 'open-bot');
  assert.equal(summary.signed, true);
  assert.equal(summary.expired, false);
  assert.ok(summary.capabilities.includes('resumableStreams'));
  assert.equal(summary.skillCount, 2);
  assert.equal(JSON.stringify(summary).includes(key.keyId), false);
});

test('version11: đàm phán chọn bản chung cao nhất (1.1 vs 1.0 -> 1.0)', () => {
  const r = negotiateProtocolVersionV11(['1.1'], ['1.0']);
  assert.equal(r.ok, true);
  assert.equal(r.negotiated, '1.0');
  assert.ok(!r.features.includes('resumableStreams'));
  const r2 = negotiateProtocolVersionV11(['1.1'], ['1.1', '1.0.1']);
  assert.equal(r2.negotiated, '1.1');
  assert.ok(r2.features.includes('resumableStreams'));
  assert.ok(r2.features.includes('multiTenancy'));
  assert.ok(r2.features.includes('stateTransitionHistory'));
  const r3 = negotiateProtocolVersionV11(['2.0'], ['1.1']);
  assert.equal(r3.ok, false);
  assert.equal(r3.negotiated, null);
  const r4 = negotiateProtocolVersionV11(['1.1'], ['1.1'], ['resumableStreams', 'multiTenancy']);
  assert.deepEqual(r4.missingFeatures, []);
  const r5 = negotiateProtocolVersionV11(['1.0'], ['1.0'], ['resumableStreams']);
  assert.deepEqual(r5.missingFeatures, ['resumableStreams']);
});

test('version11: feature matrix cộng dồn theo bản', () => {
  assert.deepEqual(featuresForProtocolVersion('1.0'), ['basicTasks', 'streaming', 'pushNotifications']);
  assert.ok(featuresForProtocolVersion('1.0.1').includes('stateTransitionHistory'));
  assert.ok(!featuresForProtocolVersion('1.0.1').includes('resumableStreams'));
  assert.ok(protocolVersionHasFeature('1.1', 'cardExpiry'));
  assert.ok(!protocolVersionHasFeature('1.0', 'cardExpiry'));
  assert.deepEqual(featuresForProtocolVersion('banana'), []);
  assert.deepEqual(commonProtocolFeatures('1.1', '1.0'), featuresForProtocolVersion('1.0'));
});

test('version11: checkAgentCardVersionV11 — card 1.0 cũ vẫn qua + cảnh báo', () => {
  const old = buildAgentCard({
    name: 'old', description: 'd', url: 'http://127.0.0.1:9000/', protocolVersion: '1.0',
  });
  const check = checkAgentCardVersionV11(old);
  assert.equal(check.ok, true);
  assert.equal(check.negotiated, '1.0');
  assert.ok(check.warnings.length > 0);
  const noVersion = checkAgentCardVersionV11({ protocolVersion: undefined });
  assert.equal(noVersion.ok, true);
  assert.equal(noVersion.negotiated, '1.0');
  const bad = checkAgentCardVersionV11({ protocolVersion: '2.0' });
  assert.equal(bad.ok, false);
  const v11 = checkAgentCardVersionV11(baseCardV11());
  assert.equal(v11.ok, true);
  assert.equal(v11.negotiated, '1.1');
  assert.ok(v11.features.includes('multiTenancy'));
});

test('cardVerify: card ký đúng + version 1.1 + còn hạn -> allowed', () => {
  const key = generateA2aSigningKey();
  const signed = signAgentCard(baseCardV11(), key);
  const result = verifyCardForConnect(signed, { nowMs: NOW });
  assert.equal(result.allowed, true);
  assert.equal(result.negotiatedVersion, '1.1');
  assert.ok(result.features.includes('resumableStreams'));
  assert.equal(result.signature.ok, true);
  assert.equal(result.firstSeenKey, true);
  assert.equal(result.keyChanged, false);
});

test('cardVerify: card bị sửa sau khi ký -> chặn (signature)', () => {
  const key = generateA2aSigningKey();
  const signed = signAgentCard(baseCardV11(), key);
  const tampered = { ...signed, description: 'Agent giả mạo' };
  const result = verifyCardForConnect(tampered, { nowMs: NOW });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /Chữ ký/);
  assert.equal(result.signature.ok, false);
});

test('cardVerify: card hết hạn -> chặn (expiry)', () => {
  const key = generateA2aSigningKey();
  const card = buildAgentCardV11({
    name: 'x', description: 'd', url: 'http://127.0.0.1:8765/', validUntil: PAST,
  });
  const signed = signAgentCard(card, key);
  const result = verifyCardForConnect(signed, { nowMs: NOW });
  assert.equal(result.allowed, false);
  assert.ok(result.checks.some((c) => c.id === 'expiry' && !c.ok));
});

test('cardVerify: policy requireSigned chặn card không ký; minVersion chặn bản cũ', () => {
  const unsigned = baseCardV11();
  const r1 = verifyCardForConnect(unsigned, {
    policy: { requireSigned: true }, nowMs: NOW,
  });
  assert.equal(r1.allowed, false);
  assert.ok(r1.checks.some((c) => c.id === 'signature' && c.blocking));
  // Không requireSigned -> unsigned vẫn qua nhưng có cảnh báo.
  const r2 = verifyCardForConnect(unsigned, { nowMs: NOW });
  assert.equal(r2.allowed, true);
  assert.ok(r2.warnings.some((w) => w.includes('không có chữ ký')));
  const key = generateA2aSigningKey();
  const signed = signAgentCard(baseCardV11(), key);
  const r3 = verifyCardForConnect(signed, {
    policy: { minVersion: '1.1', requiredFeatures: ['resumableStreams'] }, nowMs: NOW,
  });
  assert.equal(r3.allowed, true);
  const old = buildAgentCard({
    name: 'old', description: 'd', url: 'http://127.0.0.1:9000/', protocolVersion: '1.0',
  });
  const r4 = verifyCardForConnect(old, { policy: { minVersion: '1.1' }, nowMs: NOW });
  assert.equal(r4.allowed, false);
});

test('cardVerify: trust store — key đổi bị chặn, keyRotation hợp lệ cho qua', () => {
  const store = new A2aTrustStore();
  const keyA = generateA2aSigningKey();
  const keyB = generateA2aSigningKey();
  const url = 'http://127.0.0.1:8765/';
  const cardA = signAgentCard(baseCardV11(), keyA);
  store.trust(url, keyA.keyId);
  const okA = verifyCardForConnect(cardA, { trustStore: store, nowMs: NOW });
  assert.equal(okA.allowed, true);
  assert.equal(okA.keyChanged, false);
  // Key B ký, không khai rotation -> chặn.
  const cardB = signAgentCard(baseCardV11(), keyB);
  const changed = verifyCardForConnect(cardB, { trustStore: store, nowMs: NOW });
  assert.equal(changed.allowed, false);
  assert.equal(changed.keyChanged, true);
  assert.match(changed.reason ?? '', /đã đổi/);
  // Key B ký + khai rotation từ key A -> cho qua.
  const rotated = buildAgentCardV11({
    name: 'open-bot', description: 'Local-first agent', url,
    keyRotation: {
      currentKeyId: keyB.keyId,
      previousKeyIds: [keyA.keyId],
      previousKeysValidUntil: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  const cardRotated = signAgentCard(rotated, keyB);
  assert.equal(keyRotationExplainsChange(cardRotated, keyA.keyId, keyB.keyId, NOW), true);
  assert.equal(keyRotationExplainsChange(cardRotated, 'deadbeef', keyB.keyId, NOW), false);
  const okRotated = verifyCardForConnect(cardRotated, { trustStore: store, nowMs: NOW });
  assert.equal(okRotated.allowed, true);
});

test('cardVerify: trust store JSON round-trip + normalize URL', () => {
  const store = new A2aTrustStore();
  store.trust('http://127.0.0.1:8765/', 'abc123');
  store.trust('http://127.0.0.1:8765', 'def456');
  assert.equal(store.urlCount, 1);
  assert.deepEqual(store.keyIdsFor('http://127.0.0.1:8765/').sort(), ['abc123', 'def456']);
  const json = store.toJSON();
  const restored = A2aTrustStore.fromJSON(json);
  assert.equal(restored.isTrusted('http://127.0.0.1:8765/', 'abc123'), true);
  assert.equal(normalizeTrustUrl('http://127.0.0.1:8765/'), normalizeTrustUrl('http://127.0.0.1:8765'));
  assert.equal(verifyAgentCardSignature(null).ok, false);
});
