/**
 * Tests for v1.12 Team T4: ACP Control Center renderer wiring.
 *
 * Static checks (no build) + core view-builder checks (needs the
 * core build):
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/acp-control-v112-renderer.test.mjs
 *
 * - Every `t('acpControl.…')` / `t('sidebar.acpControl')` key the
 *   view uses exists in en.json (and in all 6 locales).
 * - App.tsx renders the 'acp-control' view; Sidebar lists it.
 * - preload.ts exposes all 8 `acp-control:*` channels (+ camelCase).
 * - main.ts registers all 8 handlers.
 * - Renderer mirror types (types.ts `AcpControl*View`) carry the
 *   same fields as the core IPC snapshots (views.ts).
 * - Core view builders produce plain-JSON snapshots with no secrets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AcpControlCenter,
  buildAcpControlSnapshot,
  toAcpControlDiscoveredView,
} from '../packages/core/dist/acp/control/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const CHANNELS = [
  'acp-control:list',
  'acp-control:discover',
  'acp-control:register',
  'acp-control:start',
  'acp-control:stop',
  'acp-control:set-enabled',
  'acp-control:set-budget',
  'acp-control:usage',
  'acp-control:report',
];

test('renderer: every t() key used by AcpControlCenterView exists in all 6 locales', () => {
  const view = read('apps/desktop/src/renderer/components/AcpControlCenterView.tsx');
  const used = [...new Set([...view.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]))];
  assert.ok(used.length >= 30, `expected >= 30 i18n keys used, got ${used.length}: ${used.join(', ')}`);
  assert.ok(used.every((k) => k.startsWith('acpControl.')), `all keys must be acpControl.*: ${used.join(', ')}`);
  for (const loc of ['en', 'vi', 'es', 'fr', 'ja', 'zh']) {
    const data = JSON.parse(read(`apps/desktop/src/renderer/i18n/locales/${loc}.json`));
    for (const key of used) {
      assert.ok(typeof data[key] === 'string' && data[key].length > 0, `missing ${key} in ${loc}`);
    }
    assert.ok(typeof data['sidebar.acpControl'] === 'string' && data['sidebar.acpControl'].length > 0);
  }
});

test('renderer: App + Sidebar wire the acp-control view', () => {
  const app = read('apps/desktop/src/renderer/App.tsx');
  assert.ok(app.includes("import AcpControlCenterView from './components/AcpControlCenterView';"));
  assert.ok(app.includes("'acp-control'>('chat')") || app.includes("| 'acp-control'"));
  assert.ok(app.includes("onOpenAcpControl={() => setView('acp-control')}"));
  assert.ok(app.includes("view === 'acp-control'"));
  assert.ok(app.includes('<AcpControlCenterView onBack={() => setView(\'chat\')} />'));
  const sidebar = read('apps/desktop/src/renderer/components/Sidebar.tsx');
  assert.ok(sidebar.includes('onOpenAcpControl: () => void;'));
  assert.ok(sidebar.includes("key: 'acp-control'"));
  assert.ok(sidebar.includes("t('sidebar.acpControl')"));
});

test('renderer: preload exposes all 9 acp-control channels + camelCase aliases', () => {
  const preload = read('apps/desktop/src/main/preload.ts');
  for (const channel of CHANNELS) {
    assert.ok(preload.includes(`'${channel}'`), `preload missing channel ${channel}`);
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload missing invoke for ${channel}`);
  }
  for (const alias of [
    'getAcpControlSnapshot',
    'discoverAcpControlAgents',
    'registerAcpControlAgent',
    'startAcpControlAgent',
    'stopAcpControlAgent',
    'setAcpControlEnabled',
    'setAcpControlBudget',
    'getAcpControlUsage',
    'getAcpControlReport',
  ]) {
    assert.ok(preload.includes(alias), `preload missing alias ${alias}`);
  }
});

test('renderer: main registers all 9 acp-control handlers', () => {
  const main = read('apps/desktop/src/main/main.ts');
  for (const channel of CHANNELS) {
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `main missing handler ${channel}`);
  }
  assert.ok(main.includes('new AcpControlCenter({ stateDir: path.join(app.getPath(\'userData\'), \'acp-control\') })'));
  assert.ok(main.includes('buildAcpControlSnapshot'));
});

test('renderer: mirror types carry the same fields as core snapshots', () => {
  const coreViews = read('packages/core/src/acp/control/views.ts');
  const rendererTypes = read('apps/desktop/src/renderer/types.ts');
  const fieldsOf = (src, iface) => {
    const m = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(src);
    assert.ok(m, `interface ${iface} not found`);
    return new Set([...m[1].matchAll(/^\s*([A-Za-z0-9_]+)\??:/gm)].map((x) => x[1]));
  };
  const pairs = [
    ['AcpControlAgentSnapshot', 'AcpControlAgentView'],
    ['AcpControlTurnSnapshot', 'AcpControlTurnView'],
    ['AcpControlDiscoveredSnapshot', 'AcpControlDiscoveredView'],
    ['AcpControlSnapshot', 'AcpControlSnapshot'],
    ['AcpControlReportSnapshot', 'AcpControlReportView'],
  ];
  for (const [coreIface, rendererIface] of pairs) {
    const coreFields = fieldsOf(coreViews, coreIface);
    const rendererFields = fieldsOf(rendererTypes, rendererIface);
    for (const field of coreFields) {
      assert.ok(rendererFields.has(field), `${rendererIface} missing field ${field} (core ${coreIface})`);
    }
  }
});

test('renderer: view builders produce plain JSON with usage + budget, no secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-control-views-v112-'));
  const center = new AcpControlCenter({ stateDir: dir });
  const record = center.register({ backendId: 'claude', name: 'Claude Code', command: 'claude', budget: { maxTokensPerDay: 100 } });
  center.usageStore.recordTurn({ agentId: record.id, sessionId: 's', inputTokens: 80, outputTokens: 10, costUsd: 0.01, durationMs: 500, stopReason: 'end_turn' });
  const snapshot = buildAcpControlSnapshot(center);
  assert.equal(snapshot.agents.length, 1);
  const agent = snapshot.agents[0];
  assert.equal(agent.id, 'cc-claude');
  assert.equal(agent.today.totalTokens, 90);
  assert.equal(agent.dimensions.find((d) => d.dimension === 'tokens').fractionUsed, 0.9);
  assert.equal(agent.warned, true);
  assert.equal(agent.blocked, false);
  // Plain JSON round-trip: no functions, no class instances, and the
  // values that survive JSON (everything except `undefined` fields)
  // are identical.
  const roundTripped = JSON.parse(JSON.stringify(snapshot));
  assert.equal(roundTripped.agents[0].id, 'cc-claude');
  assert.equal(roundTripped.agents[0].today.totalTokens, 90);
  assert.equal(roundTripped.agents[0].blocked, false);
  assert.equal(typeof roundTripped.agents[0].budget.maxTokensPerDay, 'number');
  // No secret-looking field names/values: the word "token" only ever
  // appears in the known counter field names (stripped here).
  const flat = JSON.stringify(snapshot);
  const stripped = flat.replace(/maxTokensPerDay|inputTokens|outputTokens|totalTokens/g, '');
  assert.ok(!/secret|password|api[_-]?key|credential|bearer/i.test(stripped));
  const discovered = toAcpControlDiscoveredView({
    backendId: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'],
    installed: true, speaksAcp: true, loggedIn: true, verifiedInRepo: true, alreadyRegistered: false,
  });
  assert.equal(discovered.backendId, 'gemini');
  assert.equal(discovered.speaksAcp, true);
  center.dispose();
});
