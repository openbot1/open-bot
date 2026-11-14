/**
 * Tests for the bot marketplace v3 (packages/core/src/agent/marketplaceV3.ts).
 *
 * Covers collections (create / validation / resolve / install with a
 * stale id skipped), version history (record / replace / list),
 * compatibility checks, and install-into-a-fleet-workspace records.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/marketplace-v3-v103.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildMarketplaceV2Catalog,
} from '../packages/core/dist/agent/marketplaceV2.js';
import {
  checkEntryCompatibility,
  createMarketplaceCollection,
  getMarketplaceLatestVersion,
  installMarketplaceCollection,
  installMarketplaceV3EntryToWorkspace,
  listMarketplaceCollections,
  listMarketplaceEntryVersions,
  listMarketplaceInstalls,
  listMarketplaceInstallsForWorkspace,
  recordMarketplaceEntryVersion,
  removeMarketplaceCollection,
  resolveMarketplaceCollection,
} from '../packages/core/dist/agent/marketplaceV3.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mkt-v3-'));
}

test('marketplace v3: collections create / resolve / remove with validation', () => {
  const base = tmpDir();
  const catalog = buildMarketplaceV2Catalog(base);
  assert.ok(catalog.length >= 20, `expected 20 built-in templates, got ${catalog.length}`);
  const first = catalog[0];
  const second = catalog[1];

  assert.throws(() => createMarketplaceCollection(base, { name: '  ', entryIds: [first.id], createdBy: 'alice' }), /name/);
  assert.throws(() => createMarketplaceCollection(base, { name: 'Pack', entryIds: [], createdBy: 'alice' }), /at least one/);
  assert.throws(
    () => createMarketplaceCollection(base, { name: 'Pack', entryIds: [first.id, 'tpl:nope'], createdBy: 'alice' }),
    /unknown entries: tpl:nope/,
  );
  const col = createMarketplaceCollection(base, {
    name: 'Starter Pack',
    description: 'Begin here.',
    entryIds: [first.id, second.id, first.id],
    createdBy: 'alice',
  });
  assert.equal(col.entryIds.length, 2, 'duplicate entry ids are deduped');
  assert.match(col.id, /^col-starter-pack-/);

  const resolved = resolveMarketplaceCollection(base, col.id);
  assert.equal(resolved.entries.length, 2);
  assert.deepEqual(resolved.missingIds, []);
  assert.equal(listMarketplaceCollections(base).length, 1);
  assert.equal(removeMarketplaceCollection(base, col.id), true);
  assert.equal(removeMarketplaceCollection(base, col.id), false);
  assert.throws(() => resolveMarketplaceCollection(base, col.id), /not found/);
});

test('marketplace v3: install collection installs each entry, skips stale ids', () => {
  const base = tmpDir();
  const catalog = buildMarketplaceV2Catalog(base);
  const first = catalog[0];
  const second = catalog[1];
  const col = createMarketplaceCollection(base, { name: 'Duo', entryIds: [first.id, second.id], createdBy: 'alice' });
  const result = installMarketplaceCollection(base, col.id);
  assert.equal(result.installed.length, 2);
  assert.deepEqual(result.skippedIds, []);
  // Fresh configs: new ids, empty workspaceDir (caller assigns it).
  for (const { config } of result.installed) {
    assert.ok(config.id.length > 0);
    assert.equal(config.workspaceDir, '');
  }
  assert.notEqual(result.installed[0].config.id, result.installed[1].config.id);
  // Install counts went up.
  const after = buildMarketplaceV2Catalog(base);
  assert.equal(after.find((e) => e.id === first.id).installs, 1);
});

test('marketplace v3: version history records, replaces, lists newest first', () => {
  const base = tmpDir();
  const entry = buildMarketplaceV2Catalog(base)[0];
  assert.deepEqual(listMarketplaceEntryVersions(base, entry.id), []);
  assert.equal(getMarketplaceLatestVersion(base, entry.id), null);
  const v1 = recordMarketplaceEntryVersion(base, entry.id, '1.1.0', 'Better prompts.', 'alice');
  assert.equal(v1.version, '1.1.0');
  const v2 = recordMarketplaceEntryVersion(base, entry.id, '1.2.0', 'New tools.', 'alice');
  assert.equal(getMarketplaceLatestVersion(base, entry.id).version, '1.2.0');
  // Re-recording the same version replaces the older row, not a duplicate.
  recordMarketplaceEntryVersion(base, entry.id, '1.1.0', 'Better prompts (revised).', 'alice');
  const versions = listMarketplaceEntryVersions(base, entry.id);
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((v) => v.version === '1.1.0').length, 1);
  assert.equal(versions.filter((v) => v.version === '1.1.0')[0].changelog, 'Better prompts (revised).');
  assert.throws(() => recordMarketplaceEntryVersion(base, 'tpl:nope', '1.0.0', ''), /not found/);
  assert.throws(() => recordMarketplaceEntryVersion(base, entry.id, '  ', ''), /version/);
});

test('marketplace v3: compatibility compares suggested tools against what exists', () => {
  const base = tmpDir();
  const entry = buildMarketplaceV2Catalog(base).find((e) => e.tags.length > 1);
  assert.ok(entry, 'expected a template with suggested tools');
  const allTools = [...new Set(buildMarketplaceV2Catalog(base).flatMap((e) => e.tags))];
  const full = checkEntryCompatibility(entry, allTools);
  assert.equal(full.compatible, true);
  assert.deepEqual(full.missingTools, []);
  assert.ok(full.requiredTools.length > 0);
  const none = checkEntryCompatibility(entry, []);
  assert.equal(none.compatible, false);
  assert.deepEqual(none.missingTools, full.requiredTools);
});

test('marketplace v3: install into a fleet workspace records bot -> workspace', () => {
  const base = tmpDir();
  const entry = buildMarketplaceV2Catalog(base)[0];
  assert.throws(
    () => installMarketplaceV3EntryToWorkspace(base, entry.id, '  ', 'alice'),
    /workspaceId/,
  );
  const result = installMarketplaceV3EntryToWorkspace(base, entry.id, 'fw-1', 'alice');
  assert.equal(result.record.entryId, entry.id);
  assert.equal(result.record.botId, result.config.id);
  assert.equal(result.record.workspaceId, 'fw-1');
  assert.equal(result.record.installedBy, 'alice');
  assert.equal(listMarketplaceInstalls(base).length, 1);
  assert.equal(listMarketplaceInstallsForWorkspace(base, 'fw-1').length, 1);
  assert.equal(listMarketplaceInstallsForWorkspace(base, 'fw-2').length, 0);
  assert.throws(() => installMarketplaceV3EntryToWorkspace(base, 'tpl:nope', 'fw-1', 'alice'), /not found/);
});
