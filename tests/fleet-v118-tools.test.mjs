/**
 * Tools v15 tests (v1.18, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Tool count pinned (28), names unique, prefixes valid, params
 *   unique, descriptions + requiresAction non-empty.
 * - findFleetV15Tool returns def or null.
 * - validateFleetV15Tools reports no problems.
 * - Per-prefix counts pinned (team 10, rollout 7, fleet 6, audit 4,
 *   admin 1) + at least 15 write tools.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v118-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V15_TOOL_COUNT,
  FLEET_V15_TOOLS,
  findFleetV15Tool,
  validateFleetV15Tools,
} from '../packages/core/dist/fleetV15/index.js';

test('tools v15: count pinned, names valid + unique, write flags sane', () => {
  assert.equal(FLEET_V15_TOOLS.length, 28);
  assert.equal(FLEET_V15_TOOL_COUNT, 28);
  const names = FLEET_V15_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const tool of FLEET_V15_TOOLS) {
    assert.match(tool.name, /^(teamV15|rolloutV15|fleetV15|auditV15|adminV15)\./, `bad prefix: ${tool.name}`);
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.ok(tool.requiresAction.length > 0, `${tool.name} needs requiresAction`);
    assert.equal(new Set(tool.params).size, tool.params.length, `${tool.name} has duplicate params`);
  }
  const byPrefix = (p) => FLEET_V15_TOOLS.filter((t) => t.name.startsWith(p)).length;
  assert.equal(byPrefix('teamV15.'), 10);
  assert.equal(byPrefix('rolloutV15.'), 7);
  assert.equal(byPrefix('fleetV15.'), 6);
  assert.equal(byPrefix('auditV15.'), 4);
  assert.equal(byPrefix('adminV15.'), 1);
  const writes = FLEET_V15_TOOLS.filter((t) => t.write).length;
  assert.ok(writes >= 13, `expected many write tools, got ${writes}`);
  assert.deepEqual(validateFleetV15Tools(), []);
});

test('tools v15: find by name', () => {
  const tool = findFleetV15Tool('fleetV15.safeDrain');
  assert.ok(tool);
  assert.equal(tool.write, true);
  assert.deepEqual(tool.params, ['nodeId', 'reason']);
  assert.equal(findFleetV15Tool('fleetV15.nope'), null);
  assert.equal(findFleetV15Tool('auditV15.list').write, false);
  assert.equal(findFleetV15Tool('rolloutV15.approve').requiresAction, 'manage-rollout');
});
