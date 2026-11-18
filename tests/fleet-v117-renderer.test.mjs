/**
 * Renderer tests for v1.17 Team T6 panels (node:test, no network).
 *
 * Static checks (no build) + core view-builder checks (needs the
 * core build):
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v117-renderer.test.mjs
 *
 * - Every `t('fleetV14.…')` key the 5 new panels use exists in all
 *   6 locales (en/es/fr/ja/vi/zh), non-empty; every settings
 *   labelKey/hintKey from `defaultFleetV14Settings` exists too.
 * - The 5 new panel files exist and export a default component +
 *   a demo view-model builder (labelled demo, never real numbers).
 * - The panels only import `useT` + React (no shared component
 *   modified: no import from other panel components).
 * - Core view builders produce panels the components can render
 *   (fields line up: memory facts/runs, protocol agents/tasks/
 *   sessions/layers/manifests, router pairs/repo-map/sources,
 *   coding edits/runs/commits/eval, voice sessions, fleet nodes/
 *   users/rollouts/polls).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFleetV14CodingPanel,
  buildFleetV14MemoryPanel,
  buildFleetV14Panel,
  buildFleetV14ProtocolPanel,
  buildFleetV14RouterPanel,
  buildFleetV14VoicePanel,
  createComposioV14Trigger,
  createFleetV14Snapshot,
  createTeamV14QuotaState,
  createTeamV14Rollout,
  defaultFleetV14Settings,
  registerFleetV14Node,
} from '../packages/core/dist/fleetV14/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const PANELS = [
  'apps/desktop/src/renderer/components/MemoryV16Panel.tsx',
  'apps/desktop/src/renderer/components/ProtocolV2Panel.tsx',
  'apps/desktop/src/renderer/components/CodingV9Panel.tsx',
  'apps/desktop/src/renderer/components/VoiceV16Panel.tsx',
  'apps/desktop/src/renderer/components/FleetV14Panel.tsx',
];

const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];

test('renderer: every t() key used by the 5 v14 panels exists in all 6 locales', () => {
  const used = new Set();
  for (const panel of PANELS) {
    const src = read(panel);
    for (const m of src.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  }
  // Plus settings labelKey/hintKey from the core defaults.
  for (const row of defaultFleetV14Settings()) {
    used.add(row.labelKey);
    used.add(row.hintKey);
  }
  const keys = [...used].sort();
  assert.ok(keys.length >= 80, `expected >= 80 i18n keys used, got ${keys.length}: ${keys.join(', ')}`);
  assert.ok(keys.every((k) => k.startsWith('fleetV14.')), `all keys must be fleetV14.*: ${keys.join(', ')}`);
  for (const loc of LOCALES) {
    const data = JSON.parse(read(`apps/desktop/src/renderer/i18n/locales/${loc}.json`));
    for (const key of keys) {
      assert.ok(typeof data[key] === 'string' && data[key].length > 0, `missing ${key} in ${loc}`);
    }
  }
  // Key count pinned: 88 fleetV14.* keys per locale.
  const en = JSON.parse(read('apps/desktop/src/renderer/i18n/locales/en.json'));
  const v14Keys = Object.keys(en).filter((k) => k.startsWith('fleetV14.'));
  assert.equal(v14Keys.length, 88);
  // Keys sorted in every locale file.
  for (const loc of LOCALES) {
    const data = JSON.parse(read(`apps/desktop/src/renderer/i18n/locales/${loc}.json`));
    const ks = Object.keys(data);
    const sorted = [...ks].sort();
    assert.deepEqual(ks, sorted, `keys not sorted in ${loc}.json`);
  }
});

test('renderer: 5 new panels exist, export default component + demo builder, import only useT', () => {
  const demos = {
    'MemoryV16Panel.tsx': 'demoMemoryV16Panel',
    'ProtocolV2Panel.tsx': 'demoProtocolV2Panel',
    'CodingV9Panel.tsx': 'demoCodingV9Panel',
    'VoiceV16Panel.tsx': 'demoVoiceV16Panel',
    'FleetV14Panel.tsx': 'demoFleetV14Panel',
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
    assert.ok(!src.includes('fleetV13'), `${base} must not depend on v13 panels`);
    // Không hard-code tiếng Việt trong UI (bài học v1.16).
    assert.ok(!/[àáâãèéêìíòóôõùúýỳỹạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỵỷữ]/u.test(src), `${base} must not hard-code Vietnamese`);
  }
});

test('renderer: core view builders produce panels the components can render', () => {
  const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
  const memory = buildFleetV14MemoryPanel(
    [
      { id: 'f1', text: 'Huy likes black coffee.', confidence: 0.9, source: 'user', createdBy: 'u1', createdAt: T0, validUntil: 0, supersededBy: '', quarantined: false, quarantineReason: '', entities: ['person:Huy'] },
    ],
    [{ runId: 'r1', at: T0, added: 1, updated: 0, deleted: 0, dropped: 0, entitiesLinked: 1, quarantined: 0, durationMs: 100 }],
    T0,
  );
  assert.equal(memory.facts[0].status, 'active');
  assert.equal(typeof memory.summary, 'string');

  const protocol = buildFleetV14ProtocolPanel(
    [{ agentId: 'a1', name: 'planner', description: 'plans', endpoint: 'http://127.0.0.1:9001', skills: ['plan'], status: 'online', lastSeenAt: T0 }],
    [],
    [],
    [{ kind: 'ag-ui', name: 'AG-UI', enabled: true, eventCount: 1, lastEventAt: T0 }],
    [],
  );
  assert.equal(protocol.onlineAgents, 1);
  assert.equal(protocol.uiLayers.length, 1);

  const router = buildFleetV14RouterPanel(
    [{ pairId: 'p1', taskKind: 'coding', plannerModel: 'gpt-5', editorModel: 'qwen2.5-coder-7b', editorLocal: true, tasksRouted: 2, avgPlanMs: 100, avgEditMs: 50 }],
    null,
    [{ sourceId: 'ollama', kind: 'ollama', endpoint: 'http://127.0.0.1:11434', detected: true, modelCount: 2, lastScanAt: T0, error: '' }],
  );
  assert.equal(router.totalRouted, 2);
  assert.equal(router.totalLocalModels, 2);

  const coding = buildFleetV14CodingPanel([], [], [], []);
  assert.equal(coding.totalLinesChanged, 0);
  assert.equal(coding.latestEval, null);

  const voice = buildFleetV14VoicePanel([
    { sessionId: 'v1', startedAt: T0, endedAt: T0 + 1000, bargeIns: 1, turnTakes: 2, wakeWordHits: 0, ttsOnTimeFraction: 1, status: 'ended' },
  ]);
  assert.equal(voice.totalBargeIns, 1);

  let snap = createFleetV14Snapshot(T0);
  const reg = registerFleetV14Node(
    snap,
    { nodeId: 'node-a', hostname: 'a.local', fingerprint: 'fp-a', labels: {}, capacity: { cpuCores: 8, ramTotalMb: 16384, vramTotalMb: 8192, diskTotalMb: 500000, maxTasks: 4 } },
    'u_owner',
    T0,
  );
  snap = reg.snapshot;
  const fleet = buildFleetV14Panel(
    snap,
    createTeamV14QuotaState('Team', T0),
    [{ id: 'u_member', role: 'member' }],
    [{ ...createTeamV14Rollout({ id: 'roll-1', feature: 'voice-v16', version: 'v16', previousVersion: 'v15' }, 'u_owner', T0), stage: 'canary' }],
    [createComposioV14Trigger({ triggerId: 'trig-1', connectionId: 'c1', toolkit: 'gmail', triggerSlug: 'new-email' }, T0)],
    T0,
  );
  assert.equal(fleet.nodes.length, 1);
  assert.equal(typeof fleet.summary, 'string');
  assert.ok(Array.isArray(fleet.users) && Array.isArray(fleet.rollouts) && Array.isArray(fleet.polls));
});
