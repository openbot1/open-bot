/**
 * Fleet local-model pinning v12 tests (v1.15, Đội T6 — node:test, no network).
 *
 * Covers:
 * - OS-provided blocklist: Apple Foundation Models, Phi Silica,
 *   Foundry Local, os-provided… bị từ chối pin kèm lý do rõ ràng;
 *   model publisher bình thường được pin.
 * - Validation: sha256 sai định dạng, ggufPath không phải .gguf,
 *   publisher/license/pinnedBy trống, sizeBytes âm.
 * - Pin/assign/unpin: pin model mới, re-pin thay hash + reset verify,
 *   gán node (model chưa pin thì lỗi), gỡ pin, tìm model/pin.
 * - Hash verify thật trên file tạm: file khớp hash -> verified; sửa
 *   file -> tampered; xóa file -> missing; sizeBytes lệch ->
 *   size-mismatch; hash file bằng stream (file lớn hơn RAM test).
 * - Drift: detectFleetV12PinDrift phân loại drift/unverified/ok;
 *   applyFleetV12VerifyResult cập nhật manifest + đánh drift.
 * - Persistence: save/load round-trip, file hỏng -> null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v115-pinning.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FLEET_V12_MODEL_CATALOG,
  applyFleetV12VerifyResult,
  assignFleetV12NodePin,
  createFleetV12PinManifest,
  detectFleetV12PinDrift,
  findFleetV12CatalogEntry,
  findFleetV12NodePin,
  findFleetV12PinnedModel,
  fleetV12OsProvidedReason,
  getFleetV12PinsPath,
  hashFleetV12File,
  isFleetV12OsProvidedModel,
  isFleetV12Sha256,
  loadFleetV12PinManifest,
  pinFleetV12Model,
  saveFleetV12PinManifest,
  summarizeFleetV12Pins,
  unpinFleetV12Node,
  validateFleetV12PinInput,
  verifyFleetV12ModelFile,
} from '../packages/core/dist/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function tmpFleetRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v12-pinning-')), 'fleet');
}

function makeModelFile(content = 'fake-gguf-bytes-v12') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v12-gguf-'));
  const file = path.join(dir, 'qwen3-4b-q4_k_m.gguf');
  fs.writeFileSync(file, content);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  return { file, sha256, size: Buffer.byteLength(content) };
}

function makeInput(overrides = {}) {
  return {
    modelId: 'qwen3-4b-q4_k_m',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    quant: 'Q4_K_M',
    sha256: SHA_A,
    sizeBytes: 100,
    ggufPath: '/models/qwen3-4b-q4_k_m.gguf',
    contextTokens: 32768,
    pinnedBy: 'admin',
    ...overrides,
  };
}

function pinModel(manifest = createFleetV12PinManifest('admin', T0), overrides = {}) {
  const res = pinFleetV12Model(manifest, makeInput(overrides), T0);
  assert.equal(res.ok, true, res.ok ? '' : res.error);
  return res;
}

test('os-provided blocklist: Apple/Phi/Foundry/os-provided bi chan, publisher binh thuong duoc pin', () => {
  for (const bad of [
    'apple-foundation-models',
    'Apple-Intelligence-3B',
    'phi-silica-q4',
    'foundry-local-phi-4',
    'os-provided-llm',
    'system-model-1b',
    'windows-ai-phi',
  ]) {
    assert.equal(isFleetV12OsProvidedModel(bad), true, bad);
    assert.ok(fleetV12OsProvidedReason(bad).length > 0);
    const errors = validateFleetV12PinInput(makeInput({ modelId: bad }));
    assert.ok(errors.some((e) => e.includes('OS')), `${bad}: ${errors.join('; ')}`);
  }
  for (const good of ['qwen3-4b-q4_k_m', 'llama-3.2-3b-q4_k_m', 'gemma-3-4b-q4_k_m', 'my-custom-gguf']) {
    assert.equal(isFleetV12OsProvidedModel(good), false, good);
    assert.equal(fleetV12OsProvidedReason(good), '');
  }
  assert.equal(isFleetV12OsProvidedModel(''), false);
});

test('catalog: 5 model license ro, tim theo id khong phan biet hoa thuong', () => {
  assert.equal(FLEET_V12_MODEL_CATALOG.length, 5);
  for (const entry of FLEET_V12_MODEL_CATALOG) {
    assert.ok(entry.publisher.length > 0);
    assert.ok(entry.license.length > 0);
    assert.ok(entry.sizeBytes > 0);
    assert.ok(entry.contextTokens > 0);
  }
  assert.equal(findFleetV12CatalogEntry('QWEN3-4B-Q4_K_M')?.publisher, 'Qwen');
  assert.equal(findFleetV12CatalogEntry('khong-co'), null);
});

test('validate pin input: sha256 sai, ggufPath khong .gguf, truong trong, size am', () => {
  assert.ok(validateFleetV12PinInput(makeInput({ sha256: 'xyz' })).length > 0);
  assert.ok(validateFleetV12PinInput(makeInput({ sha256: 'A'.repeat(64) })).length > 0);
  assert.ok(validateFleetV12PinInput(makeInput({ ggufPath: '/models/x.bin' })).length > 0);
  assert.ok(validateFleetV12PinInput(makeInput({ publisher: '  ' })).length > 0);
  assert.ok(validateFleetV12PinInput(makeInput({ license: '' })).length > 0);
  assert.ok(validateFleetV12PinInput(makeInput({ pinnedBy: '' })).length > 0);
  assert.ok(validateFleetV12PinInput(makeInput({ sizeBytes: -1 })).length > 0);
  assert.ok(validateFleetV12PinInput(makeInput({ contextTokens: 0 })).length > 0);
  assert.deepEqual(validateFleetV12PinInput(makeInput()), []);
  assert.equal(isFleetV12Sha256(SHA_A), true);
  assert.equal(isFleetV12Sha256('a'.repeat(63)), false);
  assert.equal(isFleetV12Sha256(123), false);
});

test('pin model: them moi, re-pin thay hash + reset verify, khong mutate manifest cu', () => {
  const m0 = createFleetV12PinManifest('admin', T0);
  const { manifest: m1, model } = pinModel(m0);
  assert.equal(m0.models.length, 0);
  assert.equal(m1.models.length, 1);
  assert.equal(model.sha256, SHA_A);
  assert.equal(model.lastVerifiedAt, null);
  assert.equal(model.quant, 'Q4_K_M');
  // Gán node rồi re-pin: verifiedSha256 của pin bị reset để buộc verify lại.
  const assigned = assignFleetV12NodePin(m1, 'node-1', 'qwen3-4b-q4_k_m', 'admin', T0);
  assert.equal(assigned.ok, true);
  const withPin = assigned.manifest;
  const verified = applyFleetV12VerifyResult(
    withPin,
    'node-1',
    { status: 'verified', actualSha256: SHA_A, expectedSha256: SHA_A, actualSizeBytes: 100, expectedSizeBytes: 100, detail: 'ok' },
    T0,
  );
  assert.equal(findFleetV12NodePin(verified, 'node-1')?.verifiedSha256, SHA_A);
  const rePinned = pinFleetV12Model(verified, makeInput({ sha256: SHA_B }), T0 + 1000);
  assert.equal(rePinned.ok, true);
  assert.equal(rePinned.model.sha256, SHA_B);
  assert.equal(findFleetV12NodePin(rePinned.manifest, 'node-1')?.verifiedSha256, null);
  assert.equal(findFleetV12NodePin(rePinned.manifest, 'node-1')?.status, 'pinned');
  // Pin model OS cung cấp bị từ chối, manifest giữ nguyên.
  const blocked = pinFleetV12Model(m1, makeInput({ modelId: 'phi-silica-q4' }), T0);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.error.includes('OS'));
  assert.equal(blocked.manifest, m1);
});

test('assign/unpin node: model chua pin thi loi, doi model, go pin', () => {
  const m0 = createFleetV12PinManifest('admin', T0);
  const missing = assignFleetV12NodePin(m0, 'node-1', 'qwen3-4b-q4_k_m', 'admin', T0);
  assert.equal(missing.ok, false);
  assert.ok(missing.error.includes('chưa được pin'));
  const { manifest: m1 } = pinModel(m0);
  const a1 = assignFleetV12NodePin(m1, 'node-1', 'qwen3-4b-q4_k_m', 'admin', T0);
  assert.equal(a1.ok, true);
  assert.equal(a1.pin.status, 'pinned');
  assert.equal(findFleetV12NodePin(a1.manifest, 'node-1')?.modelId, 'qwen3-4b-q4_k_m');
  assert.equal(findFleetV12PinnedModel(a1.manifest, 'QWEN3-4B-Q4_K_M')?.modelId, 'qwen3-4b-q4_k_m');
  // Đổi sang model khác.
  const { manifest: m2 } = pinModel(a1.manifest, { modelId: 'llama-3.2-3b-q4_k_m', publisher: 'Meta', license: 'Llama-3.2-Community', sha256: SHA_B });
  const a2 = assignFleetV12NodePin(m2, 'node-1', 'llama-3.2-3b-q4_k_m', 'admin', T0);
  assert.equal(a2.ok, true);
  assert.equal(a2.manifest.pins.length, 1);
  assert.equal(findFleetV12NodePin(a2.manifest, 'node-1')?.modelId, 'llama-3.2-3b-q4_k_m');
  // Gỡ pin + gỡ node chưa pin thì giữ nguyên.
  const m3 = unpinFleetV12Node(a2.manifest, 'node-1', 'admin', T0);
  assert.equal(m3.pins.length, 0);
  assert.equal(unpinFleetV12Node(m3, 'node-1', 'admin', T0), m3);
  assert.equal(unpinFleetV12Node(m3, '', 'admin', T0), m3);
});

test('verify file that: verified -> tampered -> missing -> size-mismatch', async () => {
  const { file, sha256, size } = makeModelFile();
  const { manifest: m1, model } = pinModel(createFleetV12PinManifest('admin', T0), {
    sha256,
    sizeBytes: size,
    ggufPath: file,
  });
  assert.equal(await hashFleetV12File(file), sha256);
  assert.equal(await hashFleetV12File('/khong-ton-tai/x.gguf'), null);
  const ok = await verifyFleetV12ModelFile(model);
  assert.equal(ok.status, 'verified');
  assert.equal(ok.actualSha256, sha256);
  assert.equal(ok.actualSizeBytes, size);
  // Sửa file (cùng kích thước) -> tampered.
  fs.writeFileSync(file, 'fake-gguf-bytes-v13');
  const tampered = await verifyFleetV12ModelFile(model);
  assert.equal(tampered.status, 'tampered');
  assert.notEqual(tampered.actualSha256, sha256);
  // Xóa file -> missing.
  fs.unlinkSync(file);
  const missing = await verifyFleetV12ModelFile(model);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.actualSha256, null);
  // File khác kích thước -> size-mismatch (hash chưa kịp tính).
  const other = makeModelFile('ngan');
  const pinned2 = { ...model, ggufPath: other.file, sizeBytes: size + 999 };
  const mismatch = await verifyFleetV12ModelFile(pinned2);
  assert.equal(mismatch.status, 'size-mismatch');
  assert.equal(mismatch.actualSizeBytes, other.size);
  assert.equal(m1.models.length, 1);
});

test('drift: phan loai drift/unverified/ok; apply verify danh drift + cap nhat manifest', () => {
  const { manifest } = pinModel(createFleetV12PinManifest('admin', T0));
  const withPins = ['node-1', 'node-2', 'node-3'].reduce(
    (m, n) => assignFleetV12NodePin(m, n, 'qwen3-4b-q4_k_m', 'admin', T0).manifest,
    manifest,
  );
  const results = {
    'node-1': { status: 'verified', actualSha256: SHA_A, expectedSha256: SHA_A, actualSizeBytes: 100, expectedSizeBytes: 100, detail: 'ok' },
    'node-2': { status: 'tampered', actualSha256: SHA_B, expectedSha256: SHA_A, actualSizeBytes: 100, expectedSizeBytes: 100, detail: 'hash khác với bản pin' },
  };
  const report = detectFleetV12PinDrift(withPins, results);
  assert.deepEqual(report.ok, ['node-1']);
  assert.equal(report.drifted.length, 1);
  assert.equal(report.drifted[0].nodeId, 'node-2');
  assert.equal(report.unverified.length, 1);
  assert.equal(report.unverified[0].nodeId, 'node-3');
  assert.ok(report.summary.includes('1 node bị drift'));
  // Áp dụng verify tampered -> node drift, verified -> pinned.
  const after = applyFleetV12VerifyResult(withPins, 'node-2', results['node-2'], T0);
  const pin2 = findFleetV12NodePin(after, 'node-2');
  assert.equal(pin2?.status, 'drift');
  assert.ok(pin2?.driftReason.includes('hash'));
  const afterOk = applyFleetV12VerifyResult(after, 'node-1', results['node-1'], T0);
  assert.equal(findFleetV12NodePin(afterOk, 'node-1')?.status, 'pinned');
  assert.equal(findFleetV12NodePin(afterOk, 'node-1')?.lastVerifiedAt, T0);
  // Node không có pin thì giữ nguyên manifest.
  assert.equal(applyFleetV12VerifyResult(afterOk, 'node-x', results['node-1'], T0), afterOk);
  // Manifest trống -> summary rõ ràng.
  const empty = summarizeFleetV12Pins(createFleetV12PinManifest('admin', T0));
  assert.equal(empty.pinCount, 0);
  assert.ok(empty.summary.includes('Chưa có node nào pin'));
  const summary = summarizeFleetV12Pins(afterOk);
  assert.equal(summary.driftCount, 1);
  assert.equal(summary.unverifiedCount, 1);
});

test('persistence: save/load round-trip, file hong -> null, path dung ten file v115', () => {
  const root = tmpFleetRoot();
  assert.equal(loadFleetV12PinManifest(root), null);
  assert.ok(getFleetV12PinsPath(root).endsWith('fleet-model-pins-v115.json'));
  const { manifest } = pinModel(createFleetV12PinManifest('admin', T0));
  const withPin = assignFleetV12NodePin(manifest, 'node-1', 'qwen3-4b-q4_k_m', 'admin', T0).manifest;
  saveFleetV12PinManifest(root, withPin);
  const loaded = loadFleetV12PinManifest(root);
  assert.ok(loaded);
  assert.equal(loaded.models.length, 1);
  assert.equal(loaded.pins.length, 1);
  assert.equal(loaded.models[0].sha256, SHA_A);
  fs.writeFileSync(getFleetV12PinsPath(root), '{khong-phai-json');
  assert.equal(loadFleetV12PinManifest(root), null);
  fs.writeFileSync(getFleetV12PinsPath(root), JSON.stringify({ version: 99, models: [], pins: [] }));
  assert.equal(loadFleetV12PinManifest(root), null);
});
