/**
 * team-yaml-v105.test.mjs — team YAML apply/export (v1.05, Đội T3).
 * Dùng dataDir tạm thật (fs) nhưng không gọi mạng, không dùng key thật.
 * Run: build core rồi `node --test tests/team-yaml-v105.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyTeamFile,
  applyTeamYaml,
  diffTeamYaml,
  exportTeamYaml,
  parseTeamYaml,
} from '../packages/core/dist/team/teamYaml.js';
import { loadTeamConfig } from '../packages/core/dist/team/team.js';
import { loadBotComputerQuotas } from '../packages/core/dist/compute/quota.js';

const SAMPLE_YAML = `version: 1
team:
  id: team-alpha
  name: Doi Alpha
  workspaceDir: /data/shared
members:
  - userId: local
    name: Huy
    role: admin
  - userId: u2
    name: Lan
    role: member
bots:
  - botId: assistant
    provider: gemini
    model: gemini-2.5-flash
    sharedBy: local
    computer:
      level: box
      cpuCores: 2
      memoryMb: 1024
      diskMb: 5120
  - botId: coder
    sharedBy: u2
`;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-team-yaml-v105-'));
}

test('team YAML: parse đúng schema (members, bots, computer)', () => {
  const doc = parseTeamYaml(SAMPLE_YAML);
  assert.equal(doc.version, 1);
  assert.equal(doc.team.id, 'team-alpha');
  assert.equal(doc.team.name, 'Doi Alpha');
  assert.equal(doc.members.length, 2);
  assert.equal(doc.members[0].role, 'admin');
  assert.equal(doc.bots.length, 2);
  assert.equal(doc.bots[0].model, 'gemini-2.5-flash');
  assert.equal(doc.bots[0].computer.cpuCores, 2);
  assert.equal(doc.bots[0].computer.memoryMb, 1024);
  assert.equal(doc.bots[1].computer, undefined);
});

test('team YAML: apply ghi team.json + team-computers.json', () => {
  const dir = tmpDir();
  const result = applyTeamYaml(SAMPLE_YAML, dir);
  assert.equal(result.dryRun, false);
  assert.equal(result.team.name, 'Doi Alpha');
  assert.equal(result.computerQuotas, 1);
  const saved = loadTeamConfig(dir);
  assert.equal(saved.id, 'team-alpha');
  assert.equal(saved.members.length, 2);
  assert.equal(saved.sharedBots.length, 2);
  assert.equal(saved.sharedBots[0].sharedBy, 'local');
  const quotas = loadBotComputerQuotas(dir);
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].botId, 'assistant');
  assert.equal(quotas[0].level, 'box');
  assert.equal(quotas[0].diskMb, 5120);
});

test('team YAML: dry-run chỉ validate, không ghi file', () => {
  const dir = tmpDir();
  const result = applyTeamYaml(SAMPLE_YAML, dir, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(fs.existsSync(path.join(dir, 'team.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'team-computers.json')), false);
});

test('team YAML: export round-trip — apply rồi export rồi parse lại giống', () => {
  const dir = tmpDir();
  applyTeamYaml(SAMPLE_YAML, dir);
  const yaml = exportTeamYaml(dir);
  const doc = parseTeamYaml(yaml);
  assert.equal(doc.team.id, 'team-alpha');
  assert.equal(doc.members.length, 2);
  assert.equal(doc.bots.length, 2);
  assert.equal(doc.bots[0].computer.cpuCores, 2);
  assert.equal(doc.bots[0].computer.diskMb, 5120);
});

test('team YAML: version sai -> lỗi rõ', () => {
  assert.throws(() => parseTeamYaml('version: 2\nteam:\n  id: x\n  name: y\n'), /version/);
});

test('team YAML: role lạ -> lỗi rõ', () => {
  assert.throws(
    () => parseTeamYaml('version: 1\nteam:\n  id: x\n  name: y\nmembers:\n  - userId: u\n    name: U\n    role: superadmin\n'),
    /role/,
  );
});

test('team YAML: trùng botId -> lỗi rõ', () => {
  assert.throws(
    () =>
      parseTeamYaml(
        'version: 1\nteam:\n  id: x\n  name: y\nbots:\n  - botId: a\n  - botId: a\n',
      ),
    /trùng botId/,
  );
});

test('team YAML: computer level lạ / số âm -> lỗi rõ', () => {
  assert.throws(
    () =>
      parseTeamYaml(
        'version: 1\nteam:\n  id: x\n  name: y\nbots:\n  - botId: a\n    computer:\n      level: baremetal\n',
      ),
    /level/,
  );
  assert.throws(
    () =>
      parseTeamYaml(
        'version: 1\nteam:\n  id: x\n  name: y\nbots:\n  - botId: a\n    computer:\n      memoryMb: -5\n',
      ),
    /memoryMb/,
  );
});

test('team YAML: cú pháp YAML sai -> lỗi rõ, không crash', () => {
  assert.throws(() => parseTeamYaml('version: 1\nteam: [unclosed'), /team YAML/);
});

test('team YAML: diffTeamYaml — thêm/bớt/đổi member, bot, quota', () => {
  const dir = tmpDir();
  applyTeamYaml(SAMPLE_YAML, dir);
  const changed = `version: 1
team:
  id: team-alpha
  name: Doi Alpha
members:
  - userId: local
    name: Huy
    role: admin
  - userId: u3
    name: Minh
    role: viewer
bots:
  - botId: assistant
    sharedBy: local
    computer:
      level: box
      cpuCores: 4
      memoryMb: 1024
      diskMb: 5120
  - botId: researcher
    sharedBy: local
`;
  const diff = diffTeamYaml(changed, dir);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.membersAdded.map((m) => m.userId), ['u3']);
  assert.deepEqual(diff.membersRemoved.map((m) => m.userId), ['u2']);
  assert.deepEqual(diff.botsAdded.map((b) => b.botId), ['researcher']);
  assert.deepEqual(diff.botsRemoved.map((b) => b.botId), ['coder']);
  assert.equal(diff.quotasChanged.length, 1);
  assert.equal(diff.quotasChanged[0].botId, 'assistant');
  assert.match(diff.quotasChanged[0].changes.join(' '), /cpuCores/);
  // Diff với chính nó -> không đổi.
  const same = diffTeamYaml(SAMPLE_YAML, dir);
  assert.equal(same.changed, false);
});

test('team YAML: applyTeamFile với .json ghi team.json', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'team.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ id: 't1', name: 'Team 1', members: [], sharedBots: [] }),
    'utf8',
  );
  const result = applyTeamFile(file, dir);
  assert.equal(result.team.id, 't1');
  assert.equal(result.computerQuotas, 0);
  assert.equal(loadTeamConfig(dir).name, 'Team 1');
});

test('team YAML: applyTeamFile với .yaml ghi qua cùng đường', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'team.yaml');
  fs.writeFileSync(file, SAMPLE_YAML, 'utf8');
  const result = applyTeamFile(file, dir);
  assert.equal(result.team.id, 'team-alpha');
  assert.equal(result.computerQuotas, 1);
});
