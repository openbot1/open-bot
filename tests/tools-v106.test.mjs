/**
 * tools-v106.test.mjs — 14 tool mới v1.06 (Đội T3) qua @open-bot/tools.
 *
 * doctor_run/doctor_check, team_yaml_apply/export, driver_* (6),
 * engine_* (4) chạy qua factory với dataDir tạm; ALL_TOOLS chứa đủ
 * 14 tên mới (307 tool). Run: build core + tools rồi
 * `node --test tests/tools-v106.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALL_TOOLS } from '../packages/tools/dist/tools.js';
import { createDoctorTools } from '../packages/tools/dist/doctorTools.js';
import { createTeamYamlTools } from '../packages/tools/dist/teamYamlTools.js';
import { createDriverTools } from '../packages/tools/dist/driverTools.js';
import { createEnginePickerTools } from '../packages/tools/dist/enginePickerTools.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'open-bot-tools-v106-'));
}

const CTX = { workspaceDir: tmpDir(), botId: 'test' };

async function exec(tool, args) {
  return tool.execute(args, CTX);
}

test('tools: ALL_TOOLS có đủ 14 tool mới + 5 fleet v4 teams + 10 coding v2 (ALL_TOOLS 491)', () => {
  const names = new Set(ALL_TOOLS.map((t) => t.definition.name));
  for (const name of [
    'doctor_run', 'doctor_check',
    'team_yaml_apply', 'team_yaml_export',
    'driver_register', 'driver_list', 'driver_test', 'driver_enable', 'driver_disable', 'driver_remove',
    'engine_list', 'engine_pick', 'engine_current', 'engine_unpick',
  ]) {
    assert.ok(names.has(name), `thiếu tool ${name}`);
  }
  assert.equal(ALL_TOOLS.length, 899); // v1.14 merge: 453 + 38 = 500; v1.13: 402 + 51 = 453; v1.10 merge: 236 + 53 = 289; v1.11 merge: 289 + 70 = 359 // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, 899, 'không trùng tên tool'); // v1.36 re-pin: 825 + 74 = 899.
});

test('tools: doctor_run trả JSON report, doctor_check chạy 1 check', async () => {
  const dir = tmpDir();
  const [run, check] = createDoctorTools({ getDataDir: () => dir });
  assert.equal(run.needsApproval, false);
  const out = JSON.parse(await exec(run, { only: ['node-version', 'os'] }));
  assert.equal(out.summary.total, 2);
  assert.equal(out.checks[0].id, 'node-version');
  assert.equal(out.checks[0].status, 'pass');
  const single = JSON.parse(await exec(check, { check: 'disk' }));
  assert.equal(single.id, 'disk');
  // /tmp trên máy này là tmpfs nhỏ (~512 MB) nên disk check đo thật và
  // có thể fail — chỉ khẳng định nó đo được số thật, không bịa.
  assert.match(single.detail, /đĩa trống/);
  assert.ok(['pass', 'warn', 'fail'].includes(single.status));
  assert.match(await exec(check, { check: 'nope' }), /Unknown doctor check/);
});

test('tools: doctor_run format text in checklist', async () => {
  const dir = tmpDir();
  const [run] = createDoctorTools({ getDataDir: () => dir });
  const text = await exec(run, { only: ['os'], format: 'text' });
  assert.match(text, /open-bot doctor/);
  assert.match(text, /Hệ điều hành/);
});

test('tools: team_yaml_apply + export qua tool', async () => {
  const dir = tmpDir();
  const [apply, exp] = createTeamYamlTools({ getDataDir: () => dir });
  assert.equal(apply.needsApproval, true);
  assert.equal(exp.needsApproval, false);
  const yaml = `team:
  name: "Đội tool"
  bots:
    - id: t1
      name: "Bot tool"
      model: "mock"
      provider: mock
      computer: local
`;
  const applied = JSON.parse(await exec(apply, { yaml }));
  assert.equal(applied.ok, true);
  assert.equal(applied.created, 1);
  const exported = await exec(exp, {});
  assert.match(exported, /Đội tool/);
  assert.match(exported, /id: t1/);
  const bad = await exec(apply, { yaml: 'team:\n  bots: []\n' });
  assert.match(bad, /^Error: Dòng 1/);
});

test('tools: driver_register/list/test/enable/disable/remove qua tool', async () => {
  const dir = tmpDir();
  const [register, list, testTool, enable, disable, remove] = createDriverTools({ getDataDir: () => dir });
  const registered = JSON.parse(await exec(register, {
    id: 'echo-cli',
    name: 'Echo CLI',
    providerId: 'echo',
    binaryPath: process.execPath,
    argv: [],
    streamFormat: 'json',
    versionArgs: ['--version'],
  }));
  assert.equal(registered.ok, true);
  assert.equal(registered.driver.id, 'echo-cli');
  const listed = JSON.parse(await exec(list, {}));
  assert.equal(listed.drivers.length, 1);
  const tested = JSON.parse(await exec(testTool, { id: 'echo-cli' }));
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.match(tested.version ?? '', /^\d+\.\d+/);
  assert.equal(JSON.parse(await exec(disable, { id: 'echo-cli' })).driver.enabled, false);
  assert.equal(JSON.parse(await exec(enable, { id: 'echo-cli' })).driver.enabled, true);
  assert.equal(JSON.parse(await exec(remove, { id: 'echo-cli' })).ok, true);
  assert.match(await exec(testTool, { id: 'echo-cli' }), /không tồn tại/);
  // Đăng ký với cờ key → tool trả Error, không ghi.
  const bad = await exec(register, {
    id: 'bad-cli', name: 'Bad', providerId: 'bad', binaryPath: process.execPath, streamFormat: 'json', argv: ['--api-key', 'x'],
  });
  assert.match(bad, /^Error:/);
  assert.equal(JSON.parse(await exec(list, {})).drivers.length, 0);
});

test('tools: engine_pick/current/unpick qua tool (cần bot trong bots.json)', async () => {
  const dir = tmpDir();
  writeFileSync(
    join(dir, 'bots.json'),
    JSON.stringify([{ bot: { id: 'b1', name: 'B1', providerId: 'mock', model: 'mock', systemPrompt: '', workspaceDir: join(dir, 'w'), autoApprove: false }, provider: { id: 'mock', label: 'mock', defaultModel: 'mock' } }]),
    'utf8',
  );
  const [list, pick, current, unpick] = createEnginePickerTools({ getDataDir: () => dir });
  const listed = JSON.parse(await exec(list, {}));
  assert.ok(listed.engines.some((e) => e.id === 'api:mock'));
  assert.ok(listed.engines.some((e) => e.id === 'api:gemini'));
  const picked = JSON.parse(await exec(pick, { botId: 'b1', engineId: 'api:gemini', model: 'gemini-2.5-flash' }));
  assert.equal(picked.ok, true);
  assert.equal(picked.pick.model, 'gemini-2.5-flash');
  const cur = JSON.parse(await exec(current, { botId: 'b1' }));
  assert.equal(cur.fromPick, true);
  assert.equal(cur.engineId, 'api:gemini');
  assert.equal(JSON.parse(await exec(unpick, { botId: 'b1' })).ok, true);
  const cur2 = JSON.parse(await exec(current, { botId: 'b1' }));
  assert.equal(cur2.fromPick, false);
  assert.equal(cur2.engineId, 'api:mock');
  assert.match(await exec(current, { botId: 'ghost' }), /Không thấy bot/);
  // Engine không có trong catalog → lỗi "không tìm thấy".
  assert.match(await exec(pick, { botId: 'b1', engineId: 'cli:no-such-cli', model: 'm' }), /^Error: Engine picker: không tìm thấy engine/);
});
