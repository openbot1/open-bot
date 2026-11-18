/**
 * Fleet v13 tests (v1.16, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Register node: validation (RAM/VRAM âm, free > total, cpu 0);
 *   cập nhật node đã có; tìm node.
 * - Fit check: vừa RAM+VRAM → fits; thiếu RAM/VRAM → lý do ghi rõ
 *   thiếu bao nhiêu MB; node không GPU + model cần VRAM → lỗi;
 *   đủ 4 model tối đa → lỗi; pin trùng model → lỗi.
 * - Pin/unpin: pin thành công ghi RAM/VRAM; pin vượt tài nguyên bị
 *   từ chối; unpin gỡ đúng pin, unpin không có thì snapshot cũ.
 * - Health check: heartbeat mất > 5 phút → down; CPU/RAM/VRAM
 *   >= 90% → unhealthy; >= 75% → degraded; khỏe → healthy; đĩa
 *   < 1 GB → fail.
 * - Capacity report: tổng RAM/VRAM, node quá tải >= 85%, headroom.
 * - Rebalance: node quá tải → gợi ý chuyển model nhẹ sang node
 *   trống nhất; không có node đích vừa → không gợi ý.
 * - Event log: seq nối tiếp, append/filter/verify (seq gap, kind
 *   lạ, seq đầu != 1); persistence snapshot + event JSONL.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v116-fleet.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendFleetV13Event,
  appendFleetV13EventToFile,
  buildFleetV13CapacityReport,
  canFleetV13NodeRunModel,
  checkFleetV13NodeHealth,
  createFleetV13Event,
  createFleetV13PinSnapshot,
  filterFleetV13Events,
  findFleetV13Node,
  fleetV13PinnedUsage,
  loadFleetV13PinSnapshot,
  pinFleetV13ModelToNode,
  readFleetV13EventsFromFile,
  registerFleetV13Node,
  saveFleetV13PinSnapshot,
  suggestFleetV13Rebalance,
  summarizeFleetV13,
  unpinFleetV13ModelFromNode,
  verifyFleetV13EventLog,
} from '../packages/core/dist/fleetV13/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function tmpRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v13-')), 'fleet');
}

function node(id, overrides = {}) {
  return {
    nodeId: id,
    ramTotalMb: 16384,
    ramFreeMb: 12288,
    vramTotalMb: 8192,
    vramFreeMb: 6144,
    cpuCores: 8,
    lastHeartbeatAt: T0,
    ...overrides,
  };
}

function model(id, overrides = {}) {
  return {
    modelId: id,
    displayName: id,
    ramMb: 3000,
    vramMb: 2500,
    contextTokens: 32768,
    quant: 'Q4_K_M',
    ...overrides,
  };
}

function makeSnapshot() {
  let snap = createFleetV13PinSnapshot('u_owner', T0);
  const a = registerFleetV13Node(snap, node('node-a'), 'u_owner', T0);
  assert.equal(a.ok, true, a.error ?? '');
  snap = a.snapshot;
  const b = registerFleetV13Node(snap, node('node-b'), 'u_owner', T0);
  assert.equal(b.ok, true);
  return b.snapshot;
}

test('register node: validation; update existing node; find node', () => {
  let snap = createFleetV13PinSnapshot('u_owner', T0);
  assert.equal(registerFleetV13Node(snap, node('n1', { ramTotalMb: 0 }), 'u', T0).ok, false);
  assert.equal(registerFleetV13Node(snap, node('n1', { ramFreeMb: 99999 }), 'u', T0).ok, false);
  assert.equal(registerFleetV13Node(snap, node('n1', { vramFreeMb: -1 }), 'u', T0).ok, false);
  assert.equal(registerFleetV13Node(snap, node('n1', { cpuCores: 0 }), 'u', T0).ok, false);
  assert.equal(registerFleetV13Node(snap, node(''), 'u', T0).ok, false);
  const ok = registerFleetV13Node(snap, node('n1'), 'u_owner', T0);
  assert.equal(ok.ok, true);
  assert.equal(ok.node.nodeId, 'n1');
  snap = ok.snapshot;
  // Cập nhật node đã có (RAM trống đổi) → ghi đè, không tăng số node.
  const upd = registerFleetV13Node(snap, node('n1', { ramFreeMb: 4096 }), 'u_owner', T0 + 1);
  assert.equal(upd.ok, true);
  assert.equal(upd.snapshot.nodes.length, 1);
  assert.equal(findFleetV13Node(upd.snapshot, 'n1').ramFreeMb, 4096);
  assert.equal(findFleetV13Node(upd.snapshot, 'nope'), null);
});

test('fit check: fits when resources suffice; precise shortfall reasons otherwise', () => {
  const snap = makeSnapshot();
  const n = findFleetV13Node(snap, 'node-a');
  const fit = canFleetV13NodeRunModel(n, model('qwen3-4b'), snap.pins);
  assert.equal(fit.fits, true);
  assert.deepEqual(fit.reasons, []);
  assert.ok(fit.ramHeadroomMb > 0);

  const big = canFleetV13NodeRunModel(n, model('huge', { ramMb: 20000, vramMb: 1000 }), snap.pins);
  assert.equal(big.fits, false);
  assert.match(big.reasons.join(' '), /thiếu RAM/);
  assert.match(big.reasons.join(' '), /thiếu \d+ MB/);

  const bigVram = canFleetV13NodeRunModel(n, model('huge-v', { ramMb: 1000, vramMb: 9000 }), snap.pins);
  assert.equal(bigVram.fits, false);
  assert.match(bigVram.reasons.join(' '), /thiếu VRAM/);

  // Node không GPU + model cần VRAM.
  const cpuNode = node('cpu-only', { vramTotalMb: 0, vramFreeMb: 0 });
  const noGpu = canFleetV13NodeRunModel(cpuNode, model('qwen3-4b'), []);
  assert.equal(noGpu.fits, false);
  assert.match(noGpu.reasons.join(' '), /không có GPU/);
  // Model CPU-only (vram 0) vẫn vừa node không GPU.
  assert.equal(canFleetV13NodeRunModel(cpuNode, model('cpu-model', { vramMb: 0 }), []).fits, true);
});

test('pin/unpin: resource-checked pin; max 4 models; duplicate pin rejected; unpin exact', () => {
  let snap = makeSnapshot();
  const pinned = pinFleetV13ModelToNode(snap, 'node-a', model('qwen3-4b'), 'u_owner', T0);
  assert.equal(pinned.ok, true);
  assert.equal(pinned.pin.ramMb, 3000);
  assert.equal(pinned.pin.vramMb, 2500);
  snap = pinned.snapshot;
  assert.equal(fleetV13PinnedUsage(snap, 'node-a').ramMb, 3000);
  assert.equal(fleetV13PinnedUsage(snap, 'node-a').modelCount, 1);

  // Pin trùng model → lỗi.
  assert.equal(pinFleetV13ModelToNode(snap, 'node-a', model('qwen3-4b'), 'u_owner', T0).ok, false);
  // Pin model quá lớn → lỗi kèm lý do.
  const tooBig = pinFleetV13ModelToNode(snap, 'node-a', model('huge', { ramMb: 20000 }), 'u_owner', T0);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /thiếu RAM/);
  // Pin lên node chưa đăng ký → lỗi.
  assert.equal(pinFleetV13ModelToNode(snap, 'node-zzz', model('m'), 'u_owner', T0).ok, false);

  // Pin thêm 3 model nữa → đủ 4; model thứ 5 bị từ chối.
  for (const id of ['m2', 'm3', 'm4']) {
    const r = pinFleetV13ModelToNode(snap, 'node-a', model(id, { ramMb: 500, vramMb: 100 }), 'u_owner', T0);
    assert.equal(r.ok, true, r.error ?? '');
    snap = r.snapshot;
  }
  assert.equal(fleetV13PinnedUsage(snap, 'node-a').modelCount, 4);
  const fifth = pinFleetV13ModelToNode(snap, 'node-a', model('m5', { ramMb: 100, vramMb: 0 }), 'u_owner', T0);
  assert.equal(fifth.ok, false);
  assert.match(fifth.error, /4 model tối đa/);

  // Unpin gỡ đúng pin; unpin không có → snapshot cũ (same reference).
  const unpinned = unpinFleetV13ModelFromNode(snap, 'node-a', 'm2', 'u_owner', T0 + 1);
  assert.equal(fleetV13PinnedUsage(unpinned, 'node-a').modelCount, 3);
  assert.equal(unpinFleetV13ModelFromNode(unpinned, 'node-a', 'nope', 'u_owner', T0 + 2), unpinned);
});

test('health check: down on stale heartbeat; unhealthy >=90%; degraded >=75%; healthy otherwise', () => {
  const base = { nodeId: 'node-a', at: T0, cpuFraction: 0.2, ramFraction: 0.3, vramFraction: 0.1, diskFreeMb: 50000, lastHeartbeatAt: T0 };
  const healthy = checkFleetV13NodeHealth(base, T0 + 1000);
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.checks.length, 5);
  assert.ok(healthy.checks.every((c) => c.passed));

  const stale = checkFleetV13NodeHealth({ ...base, lastHeartbeatAt: T0 - 10 * 60 * 1000 }, T0);
  assert.equal(stale.status, 'down');
  assert.equal(stale.checks.find((c) => c.name === 'heartbeat').passed, false);

  const hot = checkFleetV13NodeHealth({ ...base, cpuFraction: 0.95 }, T0 + 1000);
  assert.equal(hot.status, 'unhealthy');
  const warm = checkFleetV13NodeHealth({ ...base, ramFraction: 0.8 }, T0 + 1000);
  assert.equal(warm.status, 'degraded');
  const lowDisk = checkFleetV13NodeHealth({ ...base, diskFreeMb: 100 }, T0 + 1000);
  assert.equal(lowDisk.status, 'unhealthy');
  assert.equal(lowDisk.checks.find((c) => c.name === 'disk').passed, false);
  const never = checkFleetV13NodeHealth({ ...base, lastHeartbeatAt: null }, T0 + 1000);
  assert.equal(never.status, 'down');
});

test('capacity report: totals, overload at >=85%, headroom; rebalance suggests moving lightest model', () => {
  // Node-a hoàn toàn trống (16384 MB) để pin được model 14000 MB → quá tải 85.4%.
  let snap = createFleetV13PinSnapshot('u_owner', T0);
  const ra = registerFleetV13Node(snap, node('node-a', { ramFreeMb: 16384 }), 'u_owner', T0);
  assert.equal(ra.ok, true, ra.error ?? '');
  snap = ra.snapshot;
  const rb = registerFleetV13Node(snap, node('node-b', { ramFreeMb: 16384 }), 'u_owner', T0);
  assert.equal(rb.ok, true);
  snap = rb.snapshot;
  // node-a: pin model lớn → quá tải RAM (14000/16384 = 85.4%).
  const p1 = pinFleetV13ModelToNode(snap, 'node-a', model('big-a', { ramMb: 14000, vramMb: 100 }), 'u_owner', T0);
  assert.equal(p1.ok, true, p1.error ?? '');
  snap = p1.snapshot;
  const report = buildFleetV13CapacityReport(snap);
  assert.equal(report.nodeCount, 2);
  assert.equal(report.totalRamMb, 32768);
  assert.equal(report.totalPinnedRamMb, 14000);
  assert.deepEqual(report.overloadedNodes, ['node-a']);
  const nodeA = report.nodes.find((n) => n.nodeId === 'node-a');
  assert.ok(nodeA.ramUsedFraction >= 0.85);
  assert.equal(nodeA.overloaded, true);
  assert.ok(nodeA.headroomRamMb >= 0);

  // Rebalance: chuyển big-a sang node-b (node-b trống, vừa model).
  const suggestions = suggestFleetV13Rebalance(snap, report);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].fromNodeId, 'node-a');
  assert.equal(suggestions[0].toNodeId, 'node-b');
  assert.equal(suggestions[0].modelId, 'big-a');
  assert.ok(suggestions[0].sourceReliefPct > 0.8);
  assert.match(suggestions[0].reason, /quá tải/);

  // Không có node đích vừa → không gợi ý: làm node-b cũng quá tải.
  const p2 = pinFleetV13ModelToNode(snap, 'node-b', model('big-b', { ramMb: 14000, vramMb: 100 }), 'u_owner', T0);
  assert.equal(p2.ok, true);
  const noSuggestion = suggestFleetV13Rebalance(p2.snapshot);
  assert.equal(noSuggestion.length, 0);

  // Fleet trống → report rỗng, không gợi ý.
  const empty = buildFleetV13CapacityReport(createFleetV13PinSnapshot('u', T0));
  assert.equal(empty.nodeCount, 0);
  assert.equal(suggestFleetV13Rebalance(createFleetV13PinSnapshot('u', T0)).length, 0);
  assert.match(empty.summary, /chưa có node/);

  const summary = summarizeFleetV13(snap, []);
  assert.equal(summary.nodeCount, 2);
  assert.equal(summary.pinCount, 1);
  assert.equal(summary.overloadedCount, 1);
});

test('event log: sequential seq, filter, verify catches gap/bad kind/bad first seq', () => {
  let events = [];
  const e1 = createFleetV13Event(events, { kind: 'node-join', nodeId: 'node-a', actorUserId: 'u_owner', detail: 'node-a joined' }, T0);
  assert.equal(e1.seq, 1);
  events = appendFleetV13Event(events, { kind: 'node-join', nodeId: 'node-a', actorUserId: 'u_owner', detail: 'node-a joined' }, T0);
  events = appendFleetV13Event(events, { kind: 'pin', nodeId: 'node-a', actorUserId: 'u_owner', detail: 'pinned qwen3-4b' }, T0 + 1);
  events = appendFleetV13Event(events, { kind: 'health-change', nodeId: 'node-b', actorUserId: 'system', detail: 'node-b degraded' }, T0 + 2);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(verifyFleetV13EventLog(events).ok, true);

  // Kind lạ / actor rỗng → không append.
  assert.equal(appendFleetV13Event(events, { kind: 'nope', nodeId: '', actorUserId: 'u', detail: 'x' }, T0).length, 3);
  assert.equal(appendFleetV13Event(events, { kind: 'pin', nodeId: '', actorUserId: '', detail: 'x' }, T0).length, 3);

  assert.equal(filterFleetV13Events(events, { kind: 'pin' }).length, 1);
  assert.equal(filterFleetV13Events(events, { nodeId: 'node-b' }).length, 1);
  assert.equal(filterFleetV13Events(events, { fromAt: T0 + 2 }).length, 1);
  assert.equal(filterFleetV13Events(events, { toAt: T0 }).length, 1);

  // Xóa event giữa → seq gap.
  const gap = [events[0], events[2]];
  const badGap = verifyFleetV13EventLog(gap);
  assert.equal(badGap.ok, false);
  assert.equal(badGap.badSeq, 3);
  // Kind lạ → fail.
  assert.equal(verifyFleetV13EventLog([{ ...events[0], kind: 'nope' }]).ok, false);
  // Seq đầu != 1 → fail.
  assert.equal(verifyFleetV13EventLog([{ ...events[1] }]).ok, false);
  assert.equal(verifyFleetV13EventLog([]).ok, true);
});

test('persistence: snapshot save/load; event JSONL append/read with bad line skipped', () => {
  let snap = makeSnapshot();
  const pinned = pinFleetV13ModelToNode(snap, 'node-a', model('qwen3-4b'), 'u_owner', T0);
  snap = pinned.snapshot;
  const root = tmpRoot();
  saveFleetV13PinSnapshot(root, snap);
  const loaded = loadFleetV13PinSnapshot(root);
  assert.ok(loaded);
  assert.equal(loaded.nodes.length, 2);
  assert.equal(loaded.pins.length, 1);
  assert.equal(loaded.pins[0].modelId, 'qwen3-4b');
  fs.writeFileSync(path.join(root, 'fleet-pins-v116.json'), '{bad');
  assert.equal(loadFleetV13PinSnapshot(root), null);
  assert.equal(loadFleetV13PinSnapshot(path.join(root, 'missing')), null);

  const event = createFleetV13Event([], { kind: 'pin', nodeId: 'node-a', actorUserId: 'u_owner', detail: 'pinned' }, T0);
  appendFleetV13EventToFile(root, event);
  fs.appendFileSync(path.join(root, 'fleet-events-v116.jsonl'), 'garbage\n');
  const readBack = readFleetV13EventsFromFile(root);
  assert.equal(readBack.events.length, 1);
  assert.equal(readBack.skippedLines, 1);
  assert.equal(readBack.events[0].kind, 'pin');
  assert.deepEqual(readFleetV13EventsFromFile(path.join(root, 'missing')), { events: [], skippedLines: 0 });
});
