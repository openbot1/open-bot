/**
 * Renderer tests for v1.16 Team T6 panels (node:test, no network).
 *
 * Static checks (no build) + core view-builder checks (needs the
 * core build):
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v116-renderer.test.mjs
 *
 * - Every `t('fleetV13.…')` key the 4 new panels use exists in all
 *   6 locales (en/es/fr/ja/vi/zh), non-empty.
 * - The 4 new panel files exist and export a default component +
 *   a demo view-model builder (labelled demo, never real numbers).
 * - The panels only import `useT` + React (no shared component
 *   modified: no import from other panel components).
 * - Core view builders produce panels the components can render
 *   (fields line up: memory facts/hybrid/reorganize, router
 *   models/picks/unload/swap-groups, voice budgets, fleet nodes/
 *   rebalance/events/rollouts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFleetV13MemoryPanel,
  buildFleetV13Panel,
  buildFleetV13RouterPanel,
  buildFleetV13VoicePanel,
  createFleetV13PinSnapshot,
  registerFleetV13Node,
} from '../packages/core/dist/fleetV13/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const PANELS = [
  'apps/desktop/src/renderer/components/MemoryV15Panel.tsx',
  'apps/desktop/src/renderer/components/RouterV2Panel.tsx',
  'apps/desktop/src/renderer/components/VoiceV15Panel.tsx',
  'apps/desktop/src/renderer/components/FleetV13Panel.tsx',
];

const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];

test('renderer: every t() key used by the 4 v13 panels exists in all 6 locales', () => {
  const used = new Set();
  for (const panel of PANELS) {
    const src = read(panel);
    for (const m of src.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  }
  const keys = [...used].sort();
  assert.ok(keys.length >= 30, `expected >= 30 i18n keys used, got ${keys.length}: ${keys.join(', ')}`);
  assert.ok(keys.every((k) => k.startsWith('fleetV13.')), `all keys must be fleetV13.*: ${keys.join(', ')}`);
  for (const loc of LOCALES) {
    const data = JSON.parse(read(`apps/desktop/src/renderer/i18n/locales/${loc}.json`));
    for (const key of keys) {
      assert.ok(typeof data[key] === 'string' && data[key].length > 0, `missing ${key} in ${loc}`);
    }
  }
  // Key count pinned: 36 fleetV13.* keys per locale.
  const en = JSON.parse(read('apps/desktop/src/renderer/i18n/locales/en.json'));
  const v13Keys = Object.keys(en).filter((k) => k.startsWith('fleetV13.'));
  assert.equal(v13Keys.length, 36);
  // Keys sorted in every locale file.
  for (const loc of LOCALES) {
    const data = JSON.parse(read(`apps/desktop/src/renderer/i18n/locales/${loc}.json`));
    const ks = Object.keys(data);
    const sorted = [...ks].sort();
    assert.deepEqual(ks, sorted, `keys not sorted in ${loc}.json`);
  }
});

test('renderer: 4 new panels exist, export default component + demo builder, import only useT', () => {
  const demos = {
    'MemoryV15Panel.tsx': 'demoMemoryV15Panel',
    'RouterV2Panel.tsx': 'demoRouterV2Panel',
    'VoiceV15Panel.tsx': 'demoVoiceV15Panel',
    'FleetV13Panel.tsx': 'demoFleetV13Panel',
  };
  for (const panel of PANELS) {
    const src = read(panel);
    const base = path.basename(panel);
    assert.ok(src.includes('export default function'), `${base} must export a default component`);
    assert.ok(src.includes(`export function ${demos[base]}`), `${base} must export ${demos[base]}`);
    assert.ok(src.includes('Demo:'), `${base} demo must be labelled Demo`);
    assert.ok(src.includes("from '../i18n/useT'"), `${base} must use useT`);
    assert.ok(src.includes("from 'react'"), `${base} must import react`);
    // Không import component dùng chung khác (chỉ tạo mới, không sửa).
    const componentImports = [...src.matchAll(/from '\.\/([A-Za-z0-9]+)'/g)].map((m) => m[1]);
    assert.deepEqual(componentImports, [], `${base} must not import other components: ${componentImports.join(', ')}`);
    assert.ok(!src.includes('fleetV12'), `${base} must not depend on v12 panels`);
  }
});

test('renderer: core view builders produce panels the components can render', () => {
  const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
  const memory = buildFleetV13MemoryPanel([
    { id: 'f1', text: 'Huy thích cà phê đen.', confidence: 0.9, source: 'user', createdBy: 'u1', createdAt: T0, supersededBy: '', quarantined: false, quarantineReason: '' },
  ]);
  assert.equal(memory.facts[0].active, true);
  assert.equal(typeof memory.summary, 'string');

  const router = buildFleetV13RouterPanel(
    [
      { modelId: 'qwen3-4b', kind: 'local', status: 'loaded', ramMb: 2600, vramMb: 2500, requestsServed: 1, loadedAt: T0, lastUsedAt: T0, costPer1kUsd: 0, avgLatencyMs: 100, qualityScore: 0.8, swapGroup: 'gpu-a' },
    ],
    { kind: 'chat', needsLocal: true, maxCostPer1kUsd: 0.01, maxLatencyMs: 1000 },
    T0,
  );
  assert.equal(router.models.length, 1);
  assert.equal(router.picks[0].modelId, 'qwen3-4b');
  assert.equal(router.swapGroups.length, 1);

  const voice = buildFleetV13VoicePanel([
    { turnId: 't1', at: T0, stages: [{ stage: 'vad', measuredMs: 100, budgetMs: 150 }], bargedIn: false, cleanTurnEnd: true },
  ]);
  assert.equal(voice.turnCount, 1);
  assert.equal(voice.budgets.length, 5);

  let snap = createFleetV13PinSnapshot('u_owner', T0);
  const reg = registerFleetV13Node(snap, { nodeId: 'node-a', ramTotalMb: 16384, ramFreeMb: 16384, vramTotalMb: 8192, vramFreeMb: 8192, cpuCores: 8, lastHeartbeatAt: T0 }, 'u_owner', T0);
  snap = reg.snapshot;
  const fleet = buildFleetV13Panel(snap, [], []);
  assert.equal(fleet.nodes.length, 1);
  assert.equal(typeof fleet.summary, 'string');
  assert.ok(Array.isArray(fleet.rebalance) && Array.isArray(fleet.events) && Array.isArray(fleet.rollouts));
});
