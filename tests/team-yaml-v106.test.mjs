/**
 * team-yaml-v106.test.mjs — Team YAML v1.06 (Đội T3).
 *
 * Parser YAML subset (round-trip), validate kèm số dòng, apply →
 * bots.json (tạo mới + cập nhật, giữ bot không nhắc tới), export →
 * YAML đọc lại được. Run: build core rồi
 * `node --test tests/team-yaml-v106.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyTeamYaml,
  exportTeamYaml,
  parseTeamYaml,
  serializeTeamYaml,
  TeamYamlError,
} from '../packages/core/dist/team/yaml.js';

const GOOD_YAML = `team:
  name: "Đội hỗ trợ"
  description: "Bot chăm sóc khách hàng"
  bots:
    - id: helper
      name: "Trợ lý"
      model: "claude-sonnet-4-5"
      provider: claude-code
      computer: local
      tools: [read_file, shell_exec]
    - id: writer
      name: "Người viết"
      model: "gemini-2.5-flash"
      provider: gemini
      computer: local
`;

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'open-bot-teamyaml-'));
}

test('team yaml: parse file hợp lệ + serialize round-trip', () => {
  const doc = parseTeamYaml(GOOD_YAML);
  assert.equal(doc.name, 'Đội hỗ trợ');
  assert.equal(doc.description, 'Bot chăm sóc khách hàng');
  assert.equal(doc.bots.length, 2);
  assert.equal(doc.bots[0].id, 'helper');
  assert.deepEqual(doc.bots[0].tools, ['read_file', 'shell_exec']);
  assert.equal(doc.bots[1].provider, 'gemini');
  // Serialize rồi parse lại phải ra đúng doc cũ.
  const reparsed = parseTeamYaml(serializeTeamYaml(doc));
  assert.deepEqual(reparsed, doc);
});

test('team yaml: thiếu team.name → lỗi kèm số dòng', () => {
  const bad = 'team:\n  bots: []\n';
  assert.throws(() => parseTeamYaml(bad), (err) => err instanceof TeamYamlError && /Dòng 1/.test(err.message));
});

test('team yaml: trùng bot id → lỗi đúng dòng của bot trùng', () => {
  const bad = `team:
  name: "X"
  bots:
    - id: a
      name: "A"
      model: "m1"
      provider: mock
    - id: a
      name: "B"
      model: "m2"
      provider: mock
`;
  assert.throws(
    () => parseTeamYaml(bad),
    (err) => err instanceof TeamYamlError && /Dòng 8/.test(err.message) && /trùng/.test(err.message),
  );
});

test('team yaml: provider lạ → lỗi liệt kê provider hợp lệ', () => {
  const bad = GOOD_YAML.replace('provider: gemini', 'provider: super-ai-9000');
  assert.throws(() => parseTeamYaml(bad), (err) => err instanceof TeamYamlError && /super-ai-9000/.test(err.message) && /mock/.test(err.message));
});

test('team yaml: computer lạ + tool sai mẫu + thiếu model đều báo dòng', () => {
  const badComputer = GOOD_YAML.replace('computer: local', 'computer: mars', 1);
  assert.throws(() => parseTeamYaml(badComputer), (err) => err instanceof TeamYamlError && /mars/.test(err.message));
  const badTool = GOOD_YAML.replace('[read_file, shell_exec]', '[Read-File]');
  assert.throws(() => parseTeamYaml(badTool), (err) => err instanceof TeamYamlError && /Read-File/.test(err.message));
  const noModel = GOOD_YAML.replace('      model: "gemini-2.5-flash"\n', '');
  assert.throws(() => parseTeamYaml(noModel), (err) => err instanceof TeamYamlError && /model/.test(err.message));
});

test('team yaml: tab thụt dòng + anchor → lỗi rõ (không parse sai lặng lẽ)', () => {
  assert.throws(() => parseTeamYaml('team:\n\tname: "X"\n'), (err) => err instanceof TeamYamlError && /tab/.test(err.message));
  assert.throws(() => parseTeamYaml('team: &anchor\n  name: "X"\n'), (err) => err instanceof TeamYamlError);
});

test('team yaml: apply tạo bots.json mới + ghi snapshot YAML', () => {
  const dir = tmpDir();
  const result = applyTeamYaml(dir, GOOD_YAML);
  assert.equal(result.teamName, 'Đội hỗ trợ');
  assert.equal(result.created, 2);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.botIds, ['helper', 'writer']);
  const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf8'));
  assert.equal(bots.length, 2);
  assert.equal(bots[0].bot.id, 'helper');
  assert.equal(bots[0].bot.providerId, 'claude-code');
  assert.equal(bots[0].provider.id, 'claude-code');
  assert.equal(bots[0].provider.defaultModel, 'claude-sonnet-4-5');
  // Snapshot YAML đọc lại được.
  assert.equal(parseTeamYaml(readFileSync(join(dir, 'team-bots.yaml'), 'utf8')).name, 'Đội hỗ trợ');
});

test('team yaml: apply lần 2 cập nhật bot cũ, giữ bot không nhắc tới', () => {
  const dir = tmpDir();
  applyTeamYaml(dir, GOOD_YAML);
  const second = `team:
  name: "Đội hỗ trợ"
  bots:
    - id: helper
      name: "Trợ lý v2"
      model: "claude-opus-4-1"
      provider: claude-code
      computer: local
    - id: newcomer
      name: "Mới"
      model: "mock"
      provider: mock
      computer: vm
`;
  const result = applyTeamYaml(dir, second);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  const bots = JSON.parse(readFileSync(join(dir, 'bots.json'), 'utf8'));
  assert.equal(bots.length, 3, 'writer (không nhắc tới) phải được giữ nguyên');
  const helper = bots.find((b) => b.bot.id === 'helper');
  assert.equal(helper.bot.name, 'Trợ lý v2');
  assert.equal(helper.bot.model, 'claude-opus-4-1');
});

test('team yaml: export từ bots.json ra YAML parse lại được', () => {
  const dir = tmpDir();
  applyTeamYaml(dir, GOOD_YAML);
  const yaml = exportTeamYaml(dir);
  const doc = parseTeamYaml(yaml);
  assert.equal(doc.name, 'Đội hỗ trợ');
  assert.equal(doc.bots.length, 2);
  assert.equal(doc.bots[0].id, 'helper');
  assert.deepEqual(doc.bots[0].tools, ['read_file', 'shell_exec']);
  assert.equal(doc.bots[0].computer, 'local');
});

test('team yaml: export khi chưa có bot nào → team rỗng', () => {
  const dir = tmpDir();
  const doc = parseTeamYaml(exportTeamYaml(dir, 'Team trống'));
  assert.equal(doc.name, 'Team trống');
  assert.deepEqual(doc.bots, []);
});

test('team yaml: bots.json hỏng → apply lỗi rõ (không ghi đè bừa)', () => {
  const dir = tmpDir();
  writeFileSync(join(dir, 'bots.json'), '{ hỏng', 'utf8');
  assert.throws(() => applyTeamYaml(dir, GOOD_YAML), /bots\.json/);
});
