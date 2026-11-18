/**
 * MCP Apps catalogue v2 tests (v1.12, Doi T6 — node:test, no network).
 *
 * Covers:
 * - Catalogue: 12 apps, unique ids, valid semver, valid categories/
 *   permissions, no duplicate permissions
 * - Semver compare: major/minor/patch ordering, invalid rejected
 * - Search: by name/description/tag, category filter, onlyCompatible
 * - Compatibility: host too old, host too new, missing permission,
 *   network blocked, sandbox not strict — each with a concrete reason
 * - Install lifecycle: install -> enabled -> disable -> uninstall;
 *   install twice throws; install incompatible throws; uninstall
 *   unknown throws; enable unknown throws
 * - Persistence round-trip to tmp userData dir (atomic, mode 0600),
 *   corrupt file loads empty; summary rows carry install + compat
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v112.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_MCP_APP_V112_HOST_CAPS,
  MCP_APPS_V112_CATALOGUE,
  checkMcpAppV112Compatibility,
  compareMcpAppV112Semver,
  findMcpAppV112,
  installMcpAppV112,
  isMcpAppV112Active,
  loadMcpAppV112Installs,
  parseMcpAppV112Semver,
  saveMcpAppV112Installs,
  searchMcpAppsV112,
  setMcpAppV112Enabled,
  summarizeMcpAppsV112,
  uninstallMcpAppV112,
  validateMcpAppV112Catalogue,
  validateMcpAppV112Entry,
  validateMcpAppV112HostCaps,
} from '../packages/core/dist/mcp/appsCatalogV112.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mcp-v112-'));
}

test('mcp apps v112: catalogue is valid — 12 apps, unique ids', () => {
  assert.equal(MCP_APPS_V112_CATALOGUE.length, 12);
  const validated = validateMcpAppV112Catalogue(MCP_APPS_V112_CATALOGUE);
  assert.equal(validated.length, 12);
  assert.equal(new Set(validated.map((a) => a.id)).size, 12);
  for (const app of validated) {
    assert.match(app.version, /^\d+\.\d+\.\d+$/);
    assert.ok(app.installSizeKb > 0);
    assert.ok(app.tags.length > 0);
  }
  assert.throws(() => validateMcpAppV112Catalogue([...MCP_APPS_V112_CATALOGUE, MCP_APPS_V112_CATALOGUE[0]]), /duplicate app id/);
  assert.throws(() => validateMcpAppV112Entry({ ...MCP_APPS_V112_CATALOGUE[0], version: 'bad' }), /invalid semver/);
  assert.throws(() => validateMcpAppV112Entry({ ...MCP_APPS_V112_CATALOGUE[0], permissions: ['fly'] }), /unknown permission/);
  assert.throws(() => validateMcpAppV112Entry({ ...MCP_APPS_V112_CATALOGUE[0], permissions: ['read-files', 'read-files'] }), /duplicates/);
  assert.throws(() => validateMcpAppV112Entry({ ...MCP_APPS_V112_CATALOGUE[0], minHostVersion: '9.9.9', maxHostVersion: '1.0.0' }), /maxHostVersion/);
});

test('mcp apps v112: semver compare orders major/minor/patch', () => {
  assert.deepEqual(parseMcpAppV112Semver('1.2.3'), [1, 2, 3]);
  assert.equal(compareMcpAppV112Semver('1.0.0', '2.0.0'), -1);
  assert.equal(compareMcpAppV112Semver('1.10.0', '1.9.0'), 1);
  assert.equal(compareMcpAppV112Semver('1.2.3', '1.2.3'), 0);
  assert.equal(compareMcpAppV112Semver('0.2.0', '0.2.1'), -1);
  assert.throws(() => parseMcpAppV112Semver('1.2'), /invalid semver/);
  assert.throws(() => parseMcpAppV112Semver('v1.2.3'), /invalid semver/);
});

test('mcp apps v112: search by text + category + compatibility', () => {
  assert.equal(searchMcpAppsV112('kanban').length, 1);
  assert.equal(searchMcpAppsV112('kanban')[0].id, 'kanban-board');
  assert.equal(searchMcpAppsV112('todo board').length, 1);
  assert.equal(searchMcpAppsV112('', { category: 'developer' }).length, 4);
  assert.equal(searchMcpAppsV112('', { category: 'productivity' }).length, 5);
  assert.equal(searchMcpAppsV112('').length, 12);
  assert.equal(searchMcpAppsV112('zzz-no-match').length, 0);
  // onlyCompatible with a host that grants nothing: apps needing
  // permissions drop out; permission-free apps stay.
  const bareHost = { ...DEFAULT_MCP_APP_V112_HOST_CAPS, grantedPermissions: [] };
  const compatible = searchMcpAppsV112('', { onlyCompatible: true, hostCaps: bareHost });
  assert.ok(compatible.some((a) => a.id === 'weather-widget'));
  assert.ok(!compatible.some((a) => a.id === 'kanban-board'));
  assert.ok(findMcpAppV112(MCP_APPS_V112_CATALOGUE, 'git-status')?.name === 'Git Status');
  assert.equal(findMcpAppV112(MCP_APPS_V112_CATALOGUE, 'nope'), undefined);
});

test('mcp apps v112: compatibility reports concrete reasons', () => {
  const chart = findMcpAppV112(MCP_APPS_V112_CATALOGUE, 'chart-dashboard');
  // Default host (0.2.0, read-files/clipboard/notifications) is fine.
  assert.deepEqual(checkMcpAppV112Compatibility(chart, DEFAULT_MCP_APP_V112_HOST_CAPS), { compatible: true, reasons: [] });

  const oldHost = { ...DEFAULT_MCP_APP_V112_HOST_CAPS, hostVersion: '0.1.0' };
  const oldCheck = checkMcpAppV112Compatibility(chart, oldHost);
  assert.equal(oldCheck.compatible, false);
  assert.match(oldCheck.reasons.join(' '), /needs host >= 0\.2\.0/);

  const noPermHost = { ...DEFAULT_MCP_APP_V112_HOST_CAPS, grantedPermissions: [] };
  const permCheck = checkMcpAppV112Compatibility(chart, noPermHost);
  assert.equal(permCheck.compatible, false);
  assert.match(permCheck.reasons.join(' '), /does not grant permission: read-files/);

  const networkApp = { ...chart, needsNetwork: true };
  const netCheck = checkMcpAppV112Compatibility(networkApp, DEFAULT_MCP_APP_V112_HOST_CAPS);
  assert.equal(netCheck.compatible, false);
  assert.match(netCheck.reasons.join(' '), /needs network/);

  const looseSandbox = { ...DEFAULT_MCP_APP_V112_HOST_CAPS, sandboxStrict: false };
  const sandboxCheck = checkMcpAppV112Compatibility(chart, looseSandbox);
  assert.equal(sandboxCheck.compatible, false);
  assert.match(sandboxCheck.reasons.join(' '), /sandbox is not strict/);

  const cappedApp = { ...chart, minHostVersion: '0.1.0', maxHostVersion: '0.1.9' };
  assert.match(checkMcpAppV112Compatibility(cappedApp, DEFAULT_MCP_APP_V112_HOST_CAPS).reasons.join(' '), /needs host <= 0\.1\.9/);

  assert.throws(() => validateMcpAppV112HostCaps({ ...DEFAULT_MCP_APP_V112_HOST_CAPS, hostVersion: 'bad' }), /invalid semver/);
  assert.throws(() => validateMcpAppV112HostCaps({ ...DEFAULT_MCP_APP_V112_HOST_CAPS, grantedPermissions: ['fly'] }), /unknown granted/);
});

test('mcp apps v112: install lifecycle — install/enable/disable/uninstall', () => {
  // Default host caps do NOT grant write-files, so install with a host
  // that grants every permission (kanban needs read + write).
  const fullCaps = {
    ...DEFAULT_MCP_APP_V112_HOST_CAPS,
    grantedPermissions: ['read-files', 'write-files', 'clipboard', 'notifications'],
  };
  let installs = [];
  const { installs: afterInstall, install } = installMcpAppV112(installs, MCP_APPS_V112_CATALOGUE, 'kanban-board', fullCaps);
  installs = afterInstall;
  assert.equal(install.appId, 'kanban-board');
  assert.equal(install.version, '1.2.0');
  assert.equal(install.enabled, true);
  assert.ok(isMcpAppV112Active(installs, 'kanban-board'));
  assert.throws(() => installMcpAppV112(installs, MCP_APPS_V112_CATALOGUE, 'kanban-board', fullCaps), /already installed/);
  assert.throws(() => installMcpAppV112(installs, MCP_APPS_V112_CATALOGUE, 'nope'), /not in catalogue/);

  installs = setMcpAppV112Enabled(installs, 'kanban-board', false);
  assert.equal(isMcpAppV112Active(installs, 'kanban-board'), false);
  installs = setMcpAppV112Enabled(installs, 'kanban-board', true);
  assert.equal(isMcpAppV112Active(installs, 'kanban-board'), true);
  assert.throws(() => setMcpAppV112Enabled(installs, 'nope', true), /not installed/);

  // Incompatible app cannot be installed (fail-closed).
  const oldHost = { ...DEFAULT_MCP_APP_V112_HOST_CAPS, hostVersion: '0.1.0' };
  assert.throws(() => installMcpAppV112([], MCP_APPS_V112_CATALOGUE, 'chart-dashboard', oldHost), /not compatible/);

  installs = uninstallMcpAppV112(installs, 'kanban-board');
  assert.equal(installs.length, 0);
  assert.throws(() => uninstallMcpAppV112(installs, 'kanban-board'), /not installed/);
});

test('mcp apps v112: persistence round-trip + summary', () => {
  const dir = tmpDir();
  const { installs } = installMcpAppV112([], MCP_APPS_V112_CATALOGUE, 'focus-timer');
  saveMcpAppV112Installs(dir, installs);
  assert.equal(fs.statSync(path.join(dir, 'mcp-apps-v112.json')).mode & 0o777, 0o600);
  const loaded = loadMcpAppV112Installs(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].appId, 'focus-timer');
  const summary = summarizeMcpAppsV112(MCP_APPS_V112_CATALOGUE, loaded, DEFAULT_MCP_APP_V112_HOST_CAPS);
  assert.equal(summary.length, 12);
  const focus = summary.find((s) => s.app.id === 'focus-timer');
  assert.equal(focus.installed, true);
  assert.equal(focus.enabled, true);
  assert.equal(focus.compatible, true);
  const kanban = summary.find((s) => s.app.id === 'kanban-board');
  assert.equal(kanban.installed, false);
  fs.writeFileSync(path.join(dir, 'mcp-apps-v112.json'), '{broken');
  assert.deepEqual(loadMcpAppV112Installs(dir), []);
  assert.deepEqual(loadMcpAppV112Installs(tmpDir()), []);
});
