/**
 * tools-openmausbot-v105.test.mjs — 8 openmausbot_v105_* tools (v1.05, Đội T3).
 * Tool chạy thật với dataDir tạm; model fetch mock; không gọi API ngoài.
 * Run: build tools rồi `node --test tests/tools-openmausbot-v105.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALL_TOOLS,
  OPENMAUSBOT_V105_TOOLS,
  OPENMAUSBOT_V105_TOOL_NAMES,
  ToolRegistry,
  createDefaultTools,
  createOpenmausbotV105Tools,
} from '../packages/tools/dist/index.js';
import { startHeadlessServer } from '../packages/core/dist/headless/server.js';
import { ModelRefreshService } from '../packages/core/dist/models/refresh.js';

const TEAM_YAML = `version: 1
team:
  id: team-t
  name: Team T
members:
  - userId: local
    name: Huy
    role: admin
bots:
  - botId: bot-1
    sharedBy: local
    computer:
      level: box
      cpuCores: 2
      memoryMb: 512
`;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-tools-v105-'));
}

function ctx(workspaceDir) {
  return { workspaceDir, botId: 'bot-1' };
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `thiếu tool ${name}`);
  return tool;
}

test('tools v105: đủ 8 tool, tên đúng, không trùng trong ALL_TOOLS', () => {
  assert.equal(OPENMAUSBOT_V105_TOOLS.length, 8);
  assert.deepEqual(
    OPENMAUSBOT_V105_TOOLS.map((t) => t.definition.name).sort(),
    [...OPENMAUSBOT_V105_TOOL_NAMES].sort(),
  );
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'ALL_TOOLS có tên trùng');
  for (const name of OPENMAUSBOT_V105_TOOL_NAMES) {
    assert.ok(names.includes(name), `ALL_TOOLS thiếu ${name}`);
  }
  // Registry từ chối trùng tên.
  const registry = new ToolRegistry();
  assert.doesNotThrow(() => registry.registerMany(ALL_TOOLS));
});

test('tools v105: createDefaultTools bind thay thế tại chỗ, không trùng', () => {
  const bound = createDefaultTools({ getOpenmausbotV105BaseDir: () => tmpDir() });
  const names = bound.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of OPENMAUSBOT_V105_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} phải xuất hiện đúng 1 lần`);
  }
});

test('tools v105: doctor chạy thật (mock deps) -> báo cáo text + JSON', async () => {
  const tools = createOpenmausbotV105Tools({
    doctorDeps: {
      dataDir: tmpDir(),
      getEnv: () => undefined,
      fetchFn: async () => ({ ok: true, status: 200 }),
      exists: () => true,
      readDir: () => [],
      readFile: () => '[]',
      totalMem: () => 8 * 1024 ** 3,
      freeMem: () => 4 * 1024 ** 3,
      diskStats: () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }),
      isPortFree: async () => true,
      nodeVersion: 'v22.0.0',
      platform: 'linux',
    },
  });
  const doctor = toolByName(tools, 'openmausbot_v105_doctor');
  const text = await doctor.execute({}, ctx(tmpDir()));
  assert.match(text, /Node\.js/);
  assert.match(text, /OK/);
  const json = await doctor.execute({ format: 'json' }, ctx(tmpDir()));
  assert.equal(JSON.parse(json).ok, true);
  assert.doesNotMatch(await doctor.execute({ format: 'yaml' }, ctx(tmpDir())), /Node\.js/);
});

test('tools v105: team validate/apply/export round-trip', async () => {
  const dir = tmpDir();
  const tools = createOpenmausbotV105Tools({ getDataDir: () => dir });
  const validate = toolByName(tools, 'openmausbot_v105_team_validate');
  const validated = JSON.parse(await validate.execute({ yaml: TEAM_YAML }, ctx(dir)));
  assert.equal(validated.ok, true);
  assert.equal(validated.teamId, 'team-t');
  assert.equal(validated.computerQuotas, 1);
  const bad = await validate.execute({ yaml: 'version: 9\n' }, ctx(dir));
  assert.match(bad, /^Error:/);

  const apply = toolByName(tools, 'openmausbot_v105_team_apply');
  const dry = JSON.parse(await apply.execute({ yaml: TEAM_YAML, dryRun: true }, ctx(dir)));
  assert.equal(dry.dryRun, true);
  assert.equal(fs.existsSync(path.join(dir, 'team.json')), false);
  const applied = JSON.parse(await apply.execute({ yaml: TEAM_YAML }, ctx(dir)));
  assert.equal(applied.ok, true);
  assert.equal(applied.sharedBots, 1);
  assert.equal(fs.existsSync(path.join(dir, 'team.json')), true);

  const exp = toolByName(tools, 'openmausbot_v105_team_export');
  const yaml = await exp.execute({}, ctx(dir));
  assert.match(yaml, /team-t/);
  assert.match(yaml, /bot-1/);
});

test('tools v105: team apply/ export khi chưa bind dataDir -> lỗi rõ, không đoán', async () => {
  const tools = createOpenmausbotV105Tools();
  const apply = toolByName(tools, 'openmausbot_v105_team_apply');
  const res = await apply.execute({ yaml: TEAM_YAML }, ctx(tmpDir()));
  assert.match(res, /^Error:.*thư mục dữ liệu/);
});

test('tools v105: model refresh với fetcher mock -> danh sách + thời điểm', async () => {
  const service = new ModelRefreshService({
    fetchers: { ollama: async () => ['llama3.1:8b', 'qwen2.5:7b'] },
    source: 'ollama',
  });
  const tools = createOpenmausbotV105Tools({ refreshService: service });
  const refresh = toolByName(tools, 'openmausbot_v105_model_refresh');
  const out = JSON.parse(await refresh.execute({ provider: 'ollama' }, ctx(tmpDir())));
  assert.equal(out.ok, true);
  assert.deepEqual(out.models, ['llama3.1:8b', 'qwen2.5:7b']);
  assert.equal(out.modelCount, 2);
  assert.ok(out.updatedAt);
  const err = await refresh.execute({ provider: 'khong-co' }, ctx(tmpDir()));
  assert.match(err, /^Error:/);
});

test('tools v105: computer quota + status (đo đĩa thật)', async () => {
  const dir = tmpDir();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-ws-v105-'));
  fs.writeFileSync(path.join(ws, 'f.bin'), Buffer.alloc(2 * 1024 * 1024, 0x61));
  const tools = createOpenmausbotV105Tools({ getDataDir: () => dir });
  const quotaTool = toolByName(tools, 'openmausbot_v105_computer_quota');
  const set = JSON.parse(
    await quotaTool.execute({ botId: 'bot-1', level: 'box', diskMb: 100, memoryMb: 512 }, ctx(ws)),
  );
  assert.equal(set.ok, true);
  assert.equal(set.quota.diskMb, 100);
  assert.equal(set.quota.memoryMb, 512);

  const statusTool = toolByName(tools, 'openmausbot_v105_computer_status');
  const status = JSON.parse(await statusTool.execute({ botId: 'bot-1' }, ctx(ws)));
  assert.equal(status.botId, 'bot-1');
  assert.equal(status.level, 'box');
  assert.equal(status.usage.diskMb, 2); // file 2 MB đo được thật
  assert.equal(status.status, 'ok');
  // Hạ quota đĩa xuống 1 MB -> usage 2 MB vượt -> over.
  await quotaTool.execute({ botId: 'bot-1', diskMb: 1 }, ctx(ws));
  const over = JSON.parse(await statusTool.execute({ botId: 'bot-1' }, ctx(ws)));
  assert.equal(over.status, 'over');
  // Bot chưa đặt quota -> status ok, quota null.
  const fresh = JSON.parse(await statusTool.execute({ botId: 'bot-khac' }, ctx(ws)));
  assert.equal(fresh.quota, null);
  assert.equal(fresh.status, 'ok');
});

test('tools v105: headless status — server chạy và không chạy', async () => {
  const tools = createOpenmausbotV105Tools();
  const statusTool = toolByName(tools, 'openmausbot_v105_headless_status');
  const down = JSON.parse(await statusTool.execute({ port: 1 }, ctx(tmpDir())));
  assert.equal(down.running, false);
  const handle = await startHeadlessServer({ port: 0 });
  try {
    const up = JSON.parse(await statusTool.execute({ port: handle.port }, ctx(tmpDir())));
    assert.equal(up.running, true);
    assert.equal(up.status, 'ok');
  } finally {
    await handle.close();
  }
});
