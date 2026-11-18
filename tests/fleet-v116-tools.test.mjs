/**
 * Tools v13 tests (v1.16, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Pinned counts: 21 tools v13, 11 write tools.
 * - Validation clean: tên duy nhất, prefix v13 hợp lệ, đủ
 *   description + requiresAction.
 * - Find tool theo tên; tên lạ → null.
 * - Phân nhóm: team 7, rollout 5, composio 3, fleet 6.
 * - Mọi tool ghi đều có requiresAction thuộc TEAM_V13_ACTIONS.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v116-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V13_TOOLS,
  FLEET_V13_TOOL_COUNT,
  FLEET_V13_WRITE_TOOL_COUNT,
  TEAM_V13_ACTIONS,
  findFleetV13Tool,
  validateFleetV13Tools,
} from '../packages/core/dist/fleetV13/index.js';

test('tools v13: pinned counts (21 tools, 10 write), validation clean', () => {
  assert.equal(FLEET_V13_TOOLS.length, 21);
  assert.equal(FLEET_V13_TOOL_COUNT, 21);
  assert.equal(FLEET_V13_WRITE_TOOL_COUNT, 10);
  assert.deepEqual(validateFleetV13Tools(), []);
  const names = FLEET_V13_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const toolDef of FLEET_V13_TOOLS) {
    assert.ok(toolDef.description.length > 10, toolDef.name);
    assert.ok(toolDef.params.length >= 0);
    assert.ok(TEAM_V13_ACTIONS.includes(toolDef.requiresAction), `${toolDef.name} requires ${toolDef.requiresAction}`);
  }
});

test('tools v13: find by name; groups team/rollout/composio/fleet', () => {
  const pin = findFleetV13Tool('fleetV13.pinModel');
  assert.ok(pin);
  assert.equal(pin.write, true);
  assert.equal(pin.requiresAction, 'manage-fleet');
  assert.deepEqual(pin.params, ['nodeId', 'modelId', 'ramMb', 'vramMb']);
  assert.equal(findFleetV13Tool('fleetV13.nope'), null);
  assert.equal(findFleetV13Tool(''), null);

  const groups = {
    teamV13: FLEET_V13_TOOLS.filter((t) => t.name.startsWith('teamV13.')),
    rolloutV13: FLEET_V13_TOOLS.filter((t) => t.name.startsWith('rolloutV13.')),
    composioV13: FLEET_V13_TOOLS.filter((t) => t.name.startsWith('composioV13.')),
    fleetV13: FLEET_V13_TOOLS.filter((t) => t.name.startsWith('fleetV13.')),
  };
  assert.equal(groups.teamV13.length, 7);
  assert.equal(groups.rolloutV13.length, 5);
  assert.equal(groups.composioV13.length, 3);
  assert.equal(groups.fleetV13.length, 6);
  // Mọi tool ghi đều là hành động nhạy cảm: invite/deactivate/role/rollout/pin...
  const writeNames = FLEET_V13_TOOLS.filter((t) => t.write).map((t) => t.name);
  assert.ok(writeNames.includes('teamV13.inviteMember'));
  assert.ok(writeNames.includes('rolloutV13.rollback'));
  assert.ok(writeNames.includes('fleetV13.pinModel'));
  assert.ok(!writeNames.includes('fleetV13.capacityReport'));
  assert.ok(!writeNames.includes('teamV13.listMembers'));
});
