/**
 * Renderer tests for v1.18 Team T6 panels (node:test, no network).
 *
 * Static checks (no build) + core view-builder checks (needs the
 * core build):
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v118-renderer.test.mjs
 *
 * - Every `t('fleetV15.…')` / `t('adminV15.…')` key the 3 new panels
 *   use exists in all 6 locales (en/es/fr/ja/vi/zh), non-empty; every
 *   settings labelKey/hintKey from `defaultFleetV15AdminSettings`
 *   exists too.
 * - The 3 new panel files exist and export a default component +
 *   a demo view-model builder (labelled demo, never real numbers).
 * - The panels only import `useT` + React (no shared component
 *   modified: no import from other panel components).
 * - Core view builders produce panels the components can render
 *   (fields line up: fleet nodes/forecast/rebalance/users/rollouts,
 *   audit rows/pages, admin memory/router/composio/voice).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFleetV15AdminPanel,
  buildFleetV15AuditPanel,
  buildFleetV15ComposioPanel,
  buildFleetV15MemoryPanel,
  buildFleetV15Panel,
  buildFleetV15RouterPanel,
  buildFleetV15VoicePanel,
  createTeamV15Rollout,
  createTeamV15State,
  defaultFleetV15AdminSettings,
  forecastFleetV15Capacity,
  planFleetV15Rebalance,
  scoreFleetV15FleetHealth,
} from '../packages/core/dist/fleetV15/index.js';
import {
  appendTeamV14UserAuditEvent,
  createFleetV14Snapshot,
  createTeamV14QuotaState,
  heartbeatFleetV14Node,
  registerFleetV14Node,
} from '../packages/core/dist/fleetV14/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const PANELS = [
  'apps/desktop/src/renderer/components/FleetV15Panel.tsx',
  'apps/desktop/src/renderer/components/AuditLogV15Panel.tsx',
  'apps/desktop/src/renderer/components/AdminPanelsV15.tsx',
];

const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

test('renderer v15: every t() key used by the 3 v15 panels exists in all 6 locales', () => {
  const used = new Set();
  for (const panel of PANELS) {
    const src = read(panel);
    // Lookbehind avoids matching showExport('json') — only real t('...') calls.
    for (const m of src.matchAll(/(?<![A-Za-z0-9_])t\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    // Tab titles are referenced via labelKey: '...' (dynamic t() call).
    for (const m of src.matchAll(/labelKey: '([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  }
  // Plus settings labelKey/hintKey from the core defaults.
  for (const row of defaultFleetV15AdminSettings()) {
    used.add(row.labelKey);
    used.add(row.hintKey);
  }
  const keys = [...used].sort();
  assert.ok(keys.length >= 90, `expected >= 90 i18n keys used, got ${keys.length}: ${keys.join(', ')}`);
  assert.ok(
    keys.every((k) => k.startsWith('fleetV15.') || k.startsWith('adminV15.')),
    `all keys must be fleetV15.* or adminV15.*: ${keys.join(', ')}`,
  );
  for (const loc of LOCALES) {
    const data = JSON.parse(read(`apps/desktop/src/renderer/i18n/locales/${loc}.json`));
    for (const key of keys) {
      assert.ok(typeof data[key] === 'string' && data[key].length > 0, `missing ${key} in ${loc}`);
    }
  }
  // Key counts pinned: 46 fleetV15.* + 57 adminV15.* keys per locale.
  const en = JSON.parse(read('apps/desktop/src/renderer/i18n/locales/en.json'));
  assert.equal(Object.keys(en).filter((k) => k.startsWith('fleetV15.')).length, 46);
  assert.equal(Object.keys(en).filter((k) => k.startsWith('adminV15.')).length, 57);
});

test('renderer v15: panel files exist, export default component + demo builder, import only useT + React', () => {
  for (const panel of PANELS) {
    assert.ok(fs.existsSync(path.join(root, panel)), `missing ${panel}`);
    const src = read(panel);
    assert.match(src, /export default function/, `${panel} must export a default component`);
    assert.match(src, /export function demo/, `${panel} must export a demo view-model builder`);
    assert.ok(!/from '\.\/[^']*Panel/.test(src), `${panel} must not import another panel component`);
    assert.ok(src.includes("from '../i18n/useT'"), `${panel} must use useT`);
  }
});

test('renderer v15: core view builders line up with component fields', () => {
  // Fleet v15 panel.
  let snap = createFleetV14Snapshot(T0);
  const reg = registerFleetV14Node(
    snap,
    { nodeId: 'node-a', hostname: 'node-a.local', fingerprint: 'fp-a', labels: {}, capacity: { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 16384, diskTotalMb: 500_000, maxTasks: 4 } },
    'admin',
    T0,
  );
  snap = heartbeatFleetV14Node(reg.snapshot, 'node-a', T0);
  const sample = { at: T0, cpuFraction: 0.1, ramFraction: 0.1, vramFraction: 0.1, diskFreeMb: 100_000, heartbeatAt: T0, recentTaskErrors: 0 };
  const scores = scoreFleetV15FleetHealth(snap, { 'node-a': sample });
  const forecast = forecastFleetV15Capacity(snap, { cpuCoresPerDay: 0, ramMbPerDay: 0, vramMbPerDay: 0, diskMbPerDay: 0, tasksPerDay: 0 }, T0);
  const rebalance = planFleetV15Rebalance(snap);
  const rollout = createTeamV15Rollout({ id: 'roll-1', feature: 'voice-v17', version: 'v17', previousVersion: 'v16' }, 'admin', T0);
  const fleetPanel = buildFleetV15Panel(snap, scores, forecast, rebalance, createTeamV15State('t', T0), [], [rollout], T0);
  assert.equal(fleetPanel.nodes.length, 1);
  assert.equal(typeof fleetPanel.nodes[0].healthScore, 'number');
  assert.equal(typeof fleetPanel.nodes[0].healthGrade, 'string');
  assert.equal(typeof fleetPanel.forecastSummary, 'string');
  assert.ok(Array.isArray(fleetPanel.rebalanceMoves));
  assert.equal(fleetPanel.rollouts[0].approvalsNeed, 1);

  // Audit panel.
  let v14 = createTeamV14QuotaState('t', T0);
  v14 = appendTeamV14UserAuditEvent(v14, { userId: 'u1', actorUserId: 'admin', actorRole: 'admin', action: 'user.switch', target: 'user:u1', detail: 'x' }, T0);
  const auditPanel = buildFleetV15AuditPanel({ userEvents: v14.auditEvents, userVerified: true });
  assert.equal(auditPanel.page.rows.length, 1);
  assert.equal(auditPanel.page.rows[0].action, 'user.switch');
  assert.equal(auditPanel.userChainOk, true);

  // Admin panel.
  const adminPanel = buildFleetV15AdminPanel(
    buildFleetV15MemoryPanel([], [], [], true, T0),
    buildFleetV15RouterPanel([], [], 0, 0, 0, 0, true),
    buildFleetV15ComposioPanel(false, false, [], [], T0),
    buildFleetV15VoicePanel([], false, true),
  );
  assert.equal(adminPanel.systemStatuses.length, 4);
  assert.equal(adminPanel.settings.length, 17);
  assert.ok(adminPanel.memory && adminPanel.router && adminPanel.composio && adminPanel.voice);
});
