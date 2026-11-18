/**
 * Tests cho v1.13 (Đội T1): Agent Skills loader v13 — skill diff +
 * validate cả thư mục.
 *
 * Mọi skill mẫu trong file này đều do đội T1 tự viết cho test (nội dung
 * gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-v113-diff.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  bodyLineChanges,
  bodySimilarity,
  diffSkills,
  diffSkillTexts,
  formatSkillDiff,
} from '../packages/core/dist/skills/v13/skillDiff.js';
import {
  formatDirValidationSummary,
  validateSkillDirV13,
} from '../packages/core/dist/skills/v13/validation.js';
import { parseSkillMarkdown } from '../packages/core/dist/skills/loader.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const V1 = `---
name: note-taker
description: Use when the user asks to take notes from a call.
version: 1.0.0
license: MIT
allowed-tools: [read_file, write_file]
---
# Note taker

Capture the key points first.
Then write them down.
`;

const V1_IDENTICAL = V1;

const V1_PATCH = V1.replace(
  'Capture the key points first.',
  'Capture the key points first, in order.',
);

const V2_MINOR = `---
name: note-taker
description: Use when the user asks to take notes from a call.
version: 1.1.0
license: MIT
allowed-tools: [read_file, write_file, grep_search]
---
# Note taker

Capture the key points first.
Then write them down.
Also search old notes when relevant.
`;

const V2_MAJOR = `---
name: note-taker
description: Use when the user asks to take notes from a call.
version: 2.0.0
license: MIT
allowed-tools: [read_file]
---
# Note taker

Capture the key points first.
`;

const V2_REWRITTEN = `---
name: note-taker
description: Use when the user asks to take notes from a call.
version: 1.0.0
license: MIT
allowed-tools: [read_file, write_file]
---
# Note taker

Something completely different now.
Nothing from the old body remains.
`;

// --- body helpers --------------------------------------------------------------

test('diff: bodySimilarity 1 khi giống hệt, 0 khi không còn dòng chung', () => {
  const bodyOf = (text) => parseSkillMarkdown(text, 'user').body;
  assert.equal(bodySimilarity(bodyOf(V1), bodyOf(V1_IDENTICAL)), 1);
  assert.equal(bodySimilarity('', ''), 1);
  assert.equal(bodySimilarity('', 'some text'), 0);
  assert.ok(bodySimilarity(bodyOf(V1), bodyOf(V1_PATCH)) >= 0.5 && bodySimilarity(bodyOf(V1), bodyOf(V1_PATCH)) < 1);
  // Chỉ còn chung đúng dòng tiêu đề "# Note taker" → similarity thấp, không bằng 0.
  assert.ok(bodySimilarity(bodyOf(V1), bodyOf(V2_REWRITTEN)) < 0.5);
});

test('diff: bodyLineChanges đếm thêm/bớt đúng, kể cả dòng trùng', () => {
  assert.deepEqual(bodyLineChanges('a\nb\nc', 'a\nb\nd'), { added: 1, removed: 1 });
  assert.deepEqual(bodyLineChanges('x\nx', 'x'), { added: 0, removed: 1 });
  assert.deepEqual(bodyLineChanges('', ''), { added: 0, removed: 0 });
});

// --- diffSkills ------------------------------------------------------------------

test('diff: skill giống hệt → no changes, bump none, không breaking', () => {
  const diff = diffSkillTexts(V1, V1_IDENTICAL);
  assert.equal(diff.name, 'note-taker');
  assert.deepEqual(diff.changes, []);
  assert.equal(diff.breaking, false);
  assert.equal(diff.suggestedBump, 'none');
  assert.equal(diff.versionRegressed, false);
  assert.equal(diff.bodySimilarity, 1);
  assert.match(formatSkillDiff(diff), /no changes/);
});

test('diff: sửa wording body → patch, không breaking', () => {
  const diff = diffSkillTexts(V1, V1_PATCH);
  assert.equal(diff.suggestedBump, 'patch');
  assert.equal(diff.breaking, false);
  assert.ok(diff.changes.some((c) => c.field === 'body'));
  // Version không đổi mà có thay đổi → regressed (chưa bump version).
  assert.equal(diff.versionRegressed, true);
  assert.match(formatSkillDiff(diff), /suggested bump: patch/);
});

test('diff: thêm allowed-tool → minor, version mới hơn → không regressed', () => {
  const diff = diffSkillTexts(V1, V2_MINOR);
  assert.equal(diff.suggestedBump, 'minor');
  assert.equal(diff.breaking, false);
  const tools = diff.changes.find((c) => c.field === 'allowed-tools');
  assert.ok(tools);
  assert.match(tools.detail, /grep_search/);
  assert.equal(diff.versionRegressed, false);
});

test('diff: bớt allowed-tool → major + breaking', () => {
  const diff = diffSkillTexts(V1, V2_MAJOR);
  assert.equal(diff.suggestedBump, 'major');
  assert.equal(diff.breaking, true);
  const tools = diff.changes.find((c) => c.field === 'allowed-tools');
  assert.equal(tools.breaking, true);
  assert.match(tools.detail, /write_file/);
  assert.match(formatSkillDiff(diff), /BREAKING/);
});

test('diff: body viết lại gần hết → breaking, similarity thấp', () => {
  const diff = diffSkillTexts(V1, V2_REWRITTEN);
  assert.equal(diff.breaking, true);
  assert.equal(diff.suggestedBump, 'major');
  assert.ok(diff.bodySimilarity < 0.5);
  assert.ok(diff.bodyLinesRemoved > 0);
});

test('diff: đổi description/license/metadata → patch, không breaking', () => {
  const changed = V1.replace('take notes from a call', 'take notes from a call or lecture').replace(
    'license: MIT',
    'license: Apache-2.0',
  );
  const diff = diffSkillTexts(V1, changed);
  assert.equal(diff.suggestedBump, 'patch');
  assert.equal(diff.breaking, false);
  assert.ok(diff.changes.some((c) => c.field === 'description'));
  assert.ok(diff.changes.some((c) => c.field === 'license'));
});

test('diff: disable-model-invocation bật lên → breaking; user-invocable tắt → breaking', () => {
  const off = V1.replace('allowed-tools: [read_file, write_file]', 'allowed-tools: [read_file, write_file]\ndisable-model-invocation: true');
  const diff = diffSkillTexts(V1, off);
  assert.equal(diff.breaking, true);
  assert.ok(diff.changes.some((c) => c.field === 'disable-model-invocation' && c.breaking));
  const hidden = V1.replace('allowed-tools: [read_file, write_file]', 'allowed-tools: [read_file, write_file]\nuser-invocable: false');
  const diff2 = diffSkillTexts(V1, hidden);
  assert.equal(diff2.breaking, true);
});

test('diff: tên khác nhau → throw', () => {
  const a = parseSkillMarkdown(V1, 'user');
  const b = parseSkillMarkdown(V1.replace('name: note-taker', 'name: other-skill'), 'user');
  assert.throws(() => diffSkills(a, b), /different names/);
});

test('diff: formatSkillDiff báo version regressed khi version đi lùi', () => {
  const older = V1.replace('version: 1.0.0', 'version: 0.9.0');
  const diff = diffSkillTexts(V1, older);
  assert.equal(diff.versionRegressed, true);
  assert.match(formatSkillDiff(diff), /not newer than the old one/);
});

// --- validateSkillDirV13 ------------------------------------------------------------

test('validate dir: 1 tốt + 1 xấu → checked 2, valid 1, invalid 1', () => {
  const dir = tmpDir('open-bot-skills-v113-validatedir-');
  const goodDir = path.join(dir, 'note-taker');
  fs.mkdirSync(goodDir, { recursive: true });
  fs.writeFileSync(path.join(goodDir, 'SKILL.md'), V1, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'plain-label.md'),
    '---\nname: plain-label\ndescription: A very nice skill.\n---\n# Plain\n\nBody.\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a skill', 'utf8');
  const result = validateSkillDirV13(dir);
  assert.equal(result.checked, 2);
  assert.equal(result.valid, 1);
  assert.equal(result.invalid, 1);
  assert.deepEqual(result.results.map((r) => r.name), ['note-taker', 'plain-label']);
  assert.ok(result.totalContextTaxTokens > 0);
  assert.ok(result.meanQualityScore > 0 && result.meanQualityScore < 100);
  const summary = formatDirValidationSummary(result);
  assert.match(summary, /Skills checked: 2 — 1 valid, 1 invalid/);
  assert.match(summary, /INVALID "plain-label"/);
});

test('validate dir: thư mục rỗng / không tồn tại → checked 0', () => {
  const empty = validateSkillDirV13(tmpDir('open-bot-skills-v113-empty-'));
  assert.equal(empty.checked, 0);
  assert.equal(empty.meanQualityScore, 0);
  const missing = validateSkillDirV13(path.join(os.tmpdir(), 'open-bot-no-dir-v113-x'));
  assert.equal(missing.checked, 0);
  assert.deepEqual(missing.errors, []);
});
