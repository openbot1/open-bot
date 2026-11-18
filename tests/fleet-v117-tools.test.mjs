/**
 * Tools v14 tests (v1.17, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Tool count pinned (30), names unique, prefixes valid, params
 *   unique, descriptions + requiresAction non-empty.
 * - findFleetV14Tool returns def or null.
 * - validateFleetV14Tools reports no problems.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v117-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V14_TOOL_COUNT,
  FLEET_V14_TOOLS,
  findFleetV14Tool,
  validateFleetV14Tools,
} from '../packages/core/dist/fleetV14/index.js';

test('tools v14: count pinned, names valid + unique, write flags sane', () => {
  assert.equal(FLEET_V14_TOOLS.length, 30);
  assert.equal(FLEET_V14_TOOL_COUNT, 30);
  const names = FLEET_V14_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const tool of FLEET_V14_TOOLS) {
    assert.match(tool.name, /^(teamV14|rolloutV14|composioV14|fleetV14)\./, `bad prefix: ${tool.name}`);
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.ok(tool.requiresAction.length > 0, `${tool.name} needs requiresAction`);
    assert.equal(new Set(tool.params).size, tool.params.length, `${tool.name} has duplicate params`);
  }
  const byPrefix = (p) => FLEET_V14_TOOLS.filter((t) => t.name.startsWith(p)).length;
  assert.equal(byPrefix('teamV14.'), 8);
  assert.equal(byPrefix('rolloutV14.'), 7);
  assert.equal(byPrefix('composioV14.'), 4);
  assert.equal(byPrefix('fleetV14.'), 11);
  const writes = FLEET_V14_TOOLS.filter((t) => t.write).length;
  assert.ok(writes >= 15, `expected many write tools, got ${writes}`);
  assert.deepEqual(validateFleetV14Tools(), []);
});

test('tools v14: find by name', () => {
  const tool = findFleetV14Tool('fleetV14.drainNode');
  assert.ok(tool);
  assert.equal(tool.write, true);
  assert.deepEqual(tool.params, ['nodeId', 'reason']);
  assert.equal(findFleetV14Tool('fleetV14.nope'), null);
  assert.equal(findFleetV14Tool('teamV14.quotaSummary').write, false);
});
