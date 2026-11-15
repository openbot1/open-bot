/**
 * Test v1.06 T2: legacy version matrix + fallback strategy (node:test).
 * Pure logic, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v106-legacy-versions.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseConnectionStrategy,
  commonFeatures,
  describeVersionGap,
  describeVersionSupport,
  detectServerAge,
  featuresForVersion,
  firstVersionWithFeature,
  isKnownProtocolVersionStrict,
  isLegacyProtocolVersion,
  normalizeProtocolVersion,
  supportsFeature,
  unsupportedFeatures,
  MCP_KNOWN_PROTOCOL_VERSIONS,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_OLDEST_SUPPORTED_VERSION,
  MCP_VERSION_FEATURES,
  MCP_VERSION_FEATURE_MATRIX,
} from '../packages/core/dist/mcp/legacyVersions.js';

test('legacy versions: known versions list, newest first', () => {
  assert.deepEqual([...MCP_KNOWN_PROTOCOL_VERSIONS], [
    '2026-07-28',
    '2025-11-25',
    '2025-06-18',
    '2024-11-05',
  ]);
  assert.equal(MCP_OLDEST_SUPPORTED_VERSION, '2024-11-05');
  assert.deepEqual([...MCP_LEGACY_PROTOCOL_VERSIONS], [
    '2025-11-25',
    '2025-06-18',
    '2024-11-05',
  ]);
  assert.equal(isKnownProtocolVersionStrict('2026-07-28'), true);
  assert.equal(isKnownProtocolVersionStrict('1999-01-01'), false);
  assert.equal(isLegacyProtocolVersion('2025-11-25'), true);
  assert.equal(isLegacyProtocolVersion('2026-07-28'), false);
  assert.equal(normalizeProtocolVersion('2025-06-18'), '2025-06-18');
  assert.equal(normalizeProtocolVersion('bogus'), '2024-11-05');
  assert.equal(normalizeProtocolVersion(undefined), '2024-11-05');
});

test('legacy versions: matrix covers every feature for every version', () => {
  for (const version of MCP_KNOWN_PROTOCOL_VERSIONS) {
    const row = MCP_VERSION_FEATURE_MATRIX[version];
    assert.ok(row, `missing matrix row for ${version}`);
    for (const feature of MCP_VERSION_FEATURES) {
      assert.equal(typeof row[feature], 'boolean', `${version}.${feature}`);
    }
  }
});

test('legacy versions: 2026 has stateless/MRTR/tasks-extension; 2025-11-25 has experimental tasks + elicitation', () => {
  const v2026 = featuresForVersion('2026-07-28');
  assert.equal(v2026.stateless, true);
  assert.equal(v2026.serverDiscover, true);
  assert.equal(v2026.mrtr, true);
  assert.equal(v2026.tasksExtension, true);
  assert.equal(v2026.tasksExperimental, false);
  assert.equal(v2026.elicitationForm, true);
  assert.equal(v2026.elicitationUrl, true);
  assert.equal(v2026.apps, true);

  const v2025 = featuresForVersion('2025-11-25');
  assert.equal(v2025.stateless, false);
  assert.equal(v2025.mrtr, false);
  assert.equal(v2025.tasksExtension, false);
  assert.equal(v2025.tasksExperimental, true);
  assert.equal(v2025.elicitationForm, true);
  assert.equal(v2025.elicitationUrl, true);
  assert.equal(v2025.apps, false);
});

test('legacy versions: 2025-06-18 has structured output but no elicitation/tasks; 2024-11-05 is minimal', () => {
  const v0618 = featuresForVersion('2025-06-18');
  assert.equal(v0618.structuredOutput, true);
  assert.equal(v0618.pagination, true);
  assert.equal(v0618.icons, true);
  assert.equal(v0618.elicitationForm, false);
  assert.equal(v0618.tasksExperimental, false);
  assert.equal(v0618.roots, true);
  assert.equal(v0618.sampling, true);

  const v2024 = featuresForVersion('2024-11-05');
  assert.equal(v2024.structuredOutput, false);
  assert.equal(v2024.pagination, false);
  assert.equal(v2024.icons, false);
  assert.equal(v2024.prompts, true);
  assert.equal(v2024.resources, true);
  assert.equal(v2024.completion, true);
  assert.equal(v2024.progressNotifications, true);
});

test('legacy versions: unknown version degrades to oldest (safe)', () => {
  assert.equal(supportsFeature('2099-01-01', 'stateless'), false);
  assert.equal(supportsFeature(undefined, 'elicitationForm'), false);
  assert.equal(supportsFeature(undefined, 'roots'), true);
  assert.deepEqual(unsupportedFeatures('2025-06-18', ['elicitationForm', 'roots', 'mrtr']), [
    'elicitationForm',
    'mrtr',
  ]);
  assert.deepEqual(unsupportedFeatures('2026-07-28', ['stateless', 'mrtr']), []);
});

test('legacy versions: commonFeatures is the intersection of both sides', () => {
  assert.ok(commonFeatures('2026-07-28', '2025-11-25').includes('elicitationForm'));
  assert.ok(!commonFeatures('2026-07-28', '2025-11-25').includes('stateless'));
  assert.ok(!commonFeatures('2026-07-28', '2025-11-25').includes('mrtr'));
  assert.ok(commonFeatures('2026-07-28', '2026-07-28').includes('tasksExtension'));
  assert.deepEqual(commonFeatures('2024-11-05', '2024-11-05').length > 0, true);
});

test('legacy versions: detectServerAge classifies modern / legacy-2025 / legacy-2024 / unknown', () => {
  assert.equal(detectServerAge('2026-07-28', { tools: {} }).age, 'modern');
  assert.equal(detectServerAge('2025-11-25', {}).age, 'legacy-2025');
  assert.equal(detectServerAge('2025-06-18', {}).age, 'legacy-2025');
  assert.equal(detectServerAge('2024-11-05', {}).age, 'legacy-2024');
  assert.equal(detectServerAge(undefined, {}).age, 'unknown');
  assert.equal(detectServerAge('2030-01-01', {}).age, 'unknown');
  const withTasks = detectServerAge('2026-07-28', {
    extensions: ['io.modelcontextprotocol/tasks'],
  });
  assert.equal(withTasks.declaresTasks, true);
  assert.equal(detectServerAge('2026-07-28', { elicitation: {} }).declaresElicitation, true);
});

test('legacy versions: chooseConnectionStrategy — modern auto => stateless', () => {
  const strategy = chooseConnectionStrategy(detectServerAge('2026-07-28', {}), 'auto');
  assert.equal(strategy.path, 'stateless');
  assert.equal(strategy.fellBack, false);
  assert.equal(strategy.protocolVersion, '2026-07-28');
  assert.equal(strategy.serverAge, 'modern');
});

test('legacy versions: chooseConnectionStrategy — legacy auto => handshake fallback + warnings', () => {
  const strategy = chooseConnectionStrategy(detectServerAge('2025-11-25', {}), 'auto');
  assert.equal(strategy.path, 'handshake');
  assert.equal(strategy.fellBack, true);
  assert.ok(strategy.warnings.some((w) => w.includes('stateless')));
  const old = chooseConnectionStrategy(detectServerAge('2024-11-05', {}), 'auto');
  assert.equal(old.path, 'handshake');
  assert.equal(old.fellBack, true);
  assert.ok(old.warnings.some((w) => w.includes('elicitation')));
});

test('legacy versions: chooseConnectionStrategy — stateless-only on legacy warns but stays stateless; false => handshake always', () => {
  const forced = chooseConnectionStrategy(detectServerAge('2025-11-25', {}), true);
  assert.equal(forced.path, 'stateless');
  assert.equal(forced.fellBack, false);
  assert.ok(forced.warnings.length > 0);
  const off = chooseConnectionStrategy(detectServerAge('2026-07-28', {}), false);
  assert.equal(off.path, 'handshake');
  assert.equal(off.fellBack, false);
  const unknown = chooseConnectionStrategy(detectServerAge(undefined, {}), 'auto');
  assert.equal(unknown.path, 'handshake');
  assert.equal(unknown.fellBack, true);
});

test('legacy versions: describeVersionGap + firstVersionWithFeature', () => {
  assert.equal(describeVersionGap('2026-07-28', 'stateless'), null);
  const gap = describeVersionGap('2025-11-25', 'stateless');
  assert.ok(gap && gap.includes('2025-11-25'));
  assert.ok(gap.includes('2026-07-28'));
  assert.equal(firstVersionWithFeature('stateless'), '2026-07-28');
  assert.equal(firstVersionWithFeature('tasksExperimental'), '2025-11-25');
  assert.equal(firstVersionWithFeature('elicitationForm'), '2025-11-25');
  assert.equal(firstVersionWithFeature('structuredOutput'), '2025-06-18');
  assert.equal(firstVersionWithFeature('roots'), '2024-11-05');
});

test('legacy versions: describeVersionSupport mentions present + missing', () => {
  const text = describeVersionSupport('2025-06-18');
  assert.match(text, /2025-06-18/);
  assert.match(text, /thiếu/);
  assert.match(describeVersionSupport(undefined), /không rõ version/);
});
