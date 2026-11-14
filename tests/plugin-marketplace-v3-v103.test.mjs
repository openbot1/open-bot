/**
 * Tests for the plugin marketplace v3 (packages/core/src/plugins/marketplaceV3.ts).
 *
 * Covers version comparison, update detection (installed vs template),
 * dependency checks, the install queue lifecycle, and rollback records.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/plugin-marketplace-v3-v103.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  cancelPluginInstall,
  checkPluginDependencies,
  checkPluginUpdates,
  comparePluginVersions,
  enqueuePluginInstall,
  failPluginInstall,
  finishPluginInstall,
  listPluginInstallQueue,
  listPluginRollbacks,
  listPluginRollbacksFor,
  listPluginsWithUpdates,
  readInstalledPluginDependencies,
  recordPluginRollback,
  startPluginInstall,
} from '../packages/core/dist/plugins/marketplaceV3.js';
import {
  scanInstalledPlugins,
  scanPluginTemplatesAsCatalog,
} from '../packages/core/dist/plugins/catalog.js';
import { createPluginTemplate, savePluginTemplate } from '../packages/core/dist/plugins/templates.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugin-v3-'));
}

function writePlugin(pluginsDir, id, manifest) {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), '// entry\n', 'utf8');
  return dir;
}

function makeTemplate(templatesDir, id, version) {
  const template = createPluginTemplate({
    id,
    name: `Template ${id}`,
    description: `Template ${id}.`,
    manifest: { id, name: `Template ${id}`, version, description: `Template ${id}.`, author: 'tester', permissions: ['fs'], main: 'index.js' },
    config: { entrySource: '// entry\n' },
  });
  savePluginTemplate(templatesDir, template);
  return template;
}

function catalogFor(pluginsDir, templatesDir) {
  // checkPluginUpdates needs BOTH rows for the same id (installed +
  // template); mergePluginCatalog drops the template row when the
  // plugin is installed, so pass the unmerged union here.
  return [...scanInstalledPlugins(pluginsDir), ...scanPluginTemplatesAsCatalog(templatesDir)];
}

// --- version compare -------------------------------------------------------

test('plugin marketplace v3: comparePluginVersions is numeric per segment', () => {
  assert.equal(comparePluginVersions('1.0.0', '1.0.0'), 0);
  assert.ok(comparePluginVersions('1.10.0', '1.9.0') > 0);
  assert.ok(comparePluginVersions('2.0.0', '10.0.0') < 0);
  assert.ok(comparePluginVersions('1.2', '1.2.0') < 0, 'shorter prefix is older');
  // A hyphen suffix is just another segment here, so 1.0.0-beta sorts
  // AFTER 1.0.0 (longer version wins when the prefix is equal).
  assert.ok(comparePluginVersions('1.0.0-beta', '1.0.0') > 0);
  assert.ok(comparePluginVersions('1.0.1', '1.0.0') > 0);
});

// --- updates + dependencies ----------------------------------------------

test('plugin marketplace v3: updates detected only when the template is newer', () => {
  const root = tmpDir();
  const pluginsDir = path.join(root, 'plugins');
  const templatesDir = path.join(root, 'plugin-templates');
  writePlugin(pluginsDir, 'notes', { id: 'notes', name: 'Notes', version: '1.0.0', description: 'Notes.', permissions: ['fs'], main: 'index.js' });
  writePlugin(pluginsDir, 'solo', { id: 'solo', name: 'Solo', version: '2.0.0', description: 'Solo.', permissions: [], main: 'index.js' });
  makeTemplate(templatesDir, 'notes', '1.2.0');
  makeTemplate(templatesDir, 'other', '0.1.0');

  const catalog = catalogFor(pluginsDir, templatesDir);
  const updates = checkPluginUpdates(catalog);
  const notes = updates.find((u) => u.entryId === 'notes');
  assert.equal(notes.updateAvailable, true);
  assert.equal(notes.installedVersion, '1.0.0');
  assert.equal(notes.latestVersion, '1.2.0');
  const solo = updates.find((u) => u.entryId === 'solo');
  assert.equal(solo.updateAvailable, false, 'no template for solo -> nothing newer known');
  assert.equal(listPluginsWithUpdates(catalog).length, 1);
  assert.equal(listPluginsWithUpdates(catalog)[0].entryId, 'notes');
});

test('plugin marketplace v3: dependency checks report only missing ids', () => {
  const root = tmpDir();
  const pluginsDir = path.join(root, 'plugins');
  const templatesDir = path.join(root, 'plugin-templates');
  writePlugin(pluginsDir, 'notes', {
    id: 'notes', name: 'Notes', version: '1.0.0', description: 'Notes.', permissions: ['fs'], main: 'index.js',
    dependencies: ['helper', 'missing-dep'],
  });
  writePlugin(pluginsDir, 'helper', { id: 'helper', name: 'Helper', version: '1.0.0', description: 'Helper.', permissions: [], main: 'index.js' });
  const catalog = catalogFor(pluginsDir, templatesDir);
  const deps = readInstalledPluginDependencies(pluginsDir);
  assert.deepEqual(deps, { notes: ['helper', 'missing-dep'] });
  const check = checkPluginDependencies('notes', deps, catalog);
  assert.deepEqual(check.dependencies, ['helper', 'missing-dep']);
  assert.deepEqual(check.missing, ['missing-dep']);
  assert.equal(check.satisfied, false);
  const clean = checkPluginDependencies('helper', deps, catalog);
  assert.equal(clean.satisfied, true);
  assert.deepEqual(clean.dependencies, []);
});

test('plugin marketplace v3: manifests without dependencies contribute nothing', () => {
  const root = tmpDir();
  const pluginsDir = path.join(root, 'plugins');
  writePlugin(pluginsDir, 'plain', { id: 'plain', name: 'Plain', version: '1.0.0', description: '', permissions: [], main: 'index.js' });
  assert.deepEqual(readInstalledPluginDependencies(pluginsDir), {});
  // A corrupt manifest never breaks the read.
  fs.mkdirSync(path.join(pluginsDir, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'broken', 'manifest.json'), '{oops', 'utf8');
  assert.deepEqual(readInstalledPluginDependencies(pluginsDir), {});
});

// --- install queue ---------------------------------------------------------

test('plugin marketplace v3: install queue lifecycle + duplicate guard', () => {
  const root = tmpDir();
  const pluginsDir = path.join(root, 'plugins');
  assert.deepEqual(listPluginInstallQueue(pluginsDir), []);
  assert.throws(() => enqueuePluginInstall(pluginsDir, '  ', 'alice'), /pluginId/);
  const entry = enqueuePluginInstall(pluginsDir, 'notes', 'alice');
  assert.equal(entry.status, 'queued');
  assert.equal(entry.source, 'template');
  assert.throws(() => enqueuePluginInstall(pluginsDir, 'notes', 'bob'), /already has a pending install/);
  assert.throws(() => finishPluginInstall(pluginsDir, entry.id), /not installing/);
  const started = startPluginInstall(pluginsDir, entry.id);
  assert.equal(started.status, 'installing');
  assert.throws(() => startPluginInstall(pluginsDir, entry.id), /not queued/);
  const done = finishPluginInstall(pluginsDir, entry.id);
  assert.equal(done.status, 'done');
  assert.ok(done.finishedAt);
  // A second install of the same plugin is fine once the first finished.
  const second = enqueuePluginInstall(pluginsDir, 'notes', 'alice');
  const failed = failPluginInstall(pluginsDir, second.id, 'network down');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'network down');
  const third = enqueuePluginInstall(pluginsDir, 'notes', 'alice');
  assert.equal(cancelPluginInstall(pluginsDir, third.id).status, 'cancelled');
  assert.equal(cancelPluginInstall(pluginsDir, third.id).status, 'cancelled', 'cancel is idempotent for finished states');
  assert.equal(listPluginInstallQueue(pluginsDir).length, 3);
  assert.throws(() => startPluginInstall(pluginsDir, 'piq-nope'), /no queued plugin install/);
});

// --- rollback records ------------------------------------------------------

test('plugin marketplace v3: rollback records newest first, filterable by plugin', () => {
  const root = tmpDir();
  const pluginsDir = path.join(root, 'plugins');
  assert.deepEqual(listPluginRollbacks(pluginsDir), []);
  const r1 = recordPluginRollback(pluginsDir, { pluginId: 'notes', fromVersion: '1.0.0', toVersion: '1.2.0', snapshotPath: '/tmp/snap-notes', recordedBy: 'alice' });
  assert.equal(r1.pluginId, 'notes');
  assert.equal(r1.snapshotPath, '/tmp/snap-notes');
  const r2 = recordPluginRollback(pluginsDir, { pluginId: 'notes', fromVersion: '1.2.0', toVersion: '1.3.0', recordedBy: 'alice' });
  assert.equal(r2.snapshotPath, '', 'no snapshot kept -> empty path, not a guess');
  assert.equal(listPluginRollbacks(pluginsDir)[0].id, r2.id);
  assert.equal(listPluginRollbacksFor(pluginsDir, 'notes').length, 2);
  assert.equal(listPluginRollbacksFor(pluginsDir, 'other').length, 0);
  assert.throws(() => recordPluginRollback(pluginsDir, { pluginId: 'notes', fromVersion: '', toVersion: '1.0.0', recordedBy: 'alice' }), /fromVersion/);
});
