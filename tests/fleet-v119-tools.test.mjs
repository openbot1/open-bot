/**
 * Tools v16 tests (v1.19, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Tool count pinned (31), names unique, prefixes valid, params
 *   unique, descriptions + requiresAction non-empty.
 * - findFleetV16Tool returns def or null.
 * - validateFleetV16Tools reports no problems.
 * - Per-prefix counts pinned (team 9, rollout 6, fleet 5, audit 3,
 *   gateway 2, tenant 3, admin 3) + 19 write tools.
 * - Spot checks: a read tool is not write, a write tool needs its
 *   action, known params.
 *
 * NOTE on registry: like v15 (fleetV15/toolsV15.ts), the v16 defs
 * live in the T6 core-local registry (packages/core/src/fleetV16/
 * toolsV16.ts) and are NOT registered in packages/tools/src — the
 * central registry stops at fleetV12Tools; the merge coordinator
 * decides on central registration. The pin here is the source of
 * truth for the v16 count (31).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v119-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V16_TOOLS,
  FLEET_V16_TOOL_COUNT,
  findFleetV16Tool,
  validateFleetV16Tools,
} from '../packages/core/dist/fleetV16/index.js';

test('tools v16: count pinned, names valid + unique, write flags sane', () => {
  assert.equal(FLEET_V16_TOOLS.length, 31);
  assert.equal(FLEET_V16_TOOL_COUNT, 31);
  const names = FLEET_V16_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const tool of FLEET_V16_TOOLS) {
    assert.match(tool.name, /^(teamV16|rolloutV16|fleetV16|auditV16|gatewayV16|tenantV16|adminV16)\./, `bad prefix: ${tool.name}`);
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.ok(tool.requiresAction.length > 0, `${tool.name} needs requiresAction`);
    assert.equal(new Set(tool.params).size, tool.params.length, `${tool.name} has duplicate params`);
  }
  const byPrefix = (p) => FLEET_V16_TOOLS.filter((t) => t.name.startsWith(p)).length;
  assert.equal(byPrefix('teamV16.'), 9);
  assert.equal(byPrefix('rolloutV16.'), 6);
  assert.equal(byPrefix('fleetV16.'), 5);
  assert.equal(byPrefix('auditV16.'), 3);
  assert.equal(byPrefix('gatewayV16.'), 2);
  assert.equal(byPrefix('tenantV16.'), 3);
  assert.equal(byPrefix('adminV16.'), 3);
  const writes = FLEET_V16_TOOLS.filter((t) => t.write).length;
  assert.equal(writes, 19);
  assert.deepEqual(validateFleetV16Tools(), []);
});

test('tools v16: find by name + spot checks', () => {
  const tool = findFleetV16Tool('fleetV16.registerNode');
  assert.ok(tool);
  assert.equal(tool.write, true);
  assert.deepEqual(tool.params, ['nodeId', 'hostname', 'registrationToken']);
  assert.equal(findFleetV16Tool('fleetV16.nope'), null);
  assert.equal(findFleetV16Tool('auditV16.search').write, false);
  assert.equal(findFleetV16Tool('gatewayV16.checkRateLimit').write, false);
  assert.equal(findFleetV16Tool('gatewayV16.resetRateLimit').write, true);
  assert.equal(findFleetV16Tool('tenantV16.consumeQuota').requiresAction, 'manage-team-settings');
  assert.equal(findFleetV16Tool('adminV16.setConfig').requiresAction, 'manage-team-settings');
  assert.equal(findFleetV16Tool('rolloutV16.killFlag').write, true);
  assert.equal(findFleetV16Tool('teamV16.canUseFeature').write, false);
});
