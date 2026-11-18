/**
 * Tests cho v1.12 (Đội T2): skills workspace `.openbot/skills/`
 * nạp theo yêu cầu.
 *
 * - index: quét loose *.md + <name>/SKILL.md, chỉ đọc frontmatter;
 *   tên skill phải khớp tên file (sai → errors, không chặn skill khác).
 * - load: đọc body đầy đủ, render để inject (cắt ở giới hạn), lỗi
 *   rõ khi không tìm thấy / tên sai định dạng.
 * - suggest: khớp trigger (3đ) + description/when-to-use (1đ),
 *   ngưỡng >= 2; skill userOnly không bao giờ được suggest.
 * - validate: file chứa secret / thiếu description / body rỗng →
 *   lỗi rõ; file tốt → không lỗi.
 * - Session: loadSkill ghi skill.loaded vào conversation log.
 *
 * Không Electron, không mạng, không key. Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-ondemand-v112.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ConversationLogStore,
  ConversationV112Session,
  WorkspaceSkillError,
  findWorkspaceSkill,
  indexWorkspaceSkills,
  loadWorkspaceSkill,
  suggestSkillsForText,
  validateWorkspaceSkillFile,
} from '../packages/core/dist/conversationV112/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-skills-v112-'));
}

function writeSkill(dir, relPath, content) {
  const file = path.join(dir, '.openbot', 'skills', relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const REVIEW_SKILL = `---
name: code-review
description: Review code changes for bugs and style before merging.
version: 1.2.0
when-to-use: When the user asks to review a pull request or diff.
metadata:
  triggers: [review, pull-request, diff]
---

# Code review

Check every changed file for bugs, then style.
`;

const NOTES_SKILL = `---
name: meeting-notes
description: Turn a meeting transcript into decisions and action items.
---

# Meeting notes

Summarize decisions first, then action items with owners.
`;

test('index: quét loose + dir, metadata-only, sắp xếp theo tên', () => {
  const dir = tmpDir();
  writeSkill(dir, 'code-review.md', REVIEW_SKILL);
  writeSkill(dir, 'meeting-notes/SKILL.md', NOTES_SKILL);
  fs.writeFileSync(path.join(dir, '.openbot', 'skills', 'notes.txt'), 'không phải skill');
  const index = indexWorkspaceSkills(dir);
  assert.equal(index.errors.length, 0);
  assert.deepEqual(index.entries.map((e) => e.name), ['code-review', 'meeting-notes']);
  assert.equal(index.entries[0].layout, 'file');
  assert.equal(index.entries[0].version, '1.2.0');
  assert.equal(index.entries[1].layout, 'dir');
  assert.deepEqual(index.entries[0].triggers, ['review', 'pull-request', 'diff']);
  assert.equal(index.entries[0].userOnly, false);
  assert.ok(findWorkspaceSkill(index, 'code-review'));
  assert.equal(findWorkspaceSkill(index, 'khong-co'), undefined);
});

test('index: thư mục không tồn tại → index rỗng, không lỗi', () => {
  const dir = tmpDir();
  const index = indexWorkspaceSkills(dir);
  assert.deepEqual(index.entries, []);
  assert.deepEqual(index.errors, []);
});

test('index: tên skill khác tên file → errors, skill lỗi bị bỏ, skill tốt vẫn index', () => {
  const dir = tmpDir();
  writeSkill(dir, 'wrong-name.md', REVIEW_SKILL); // frontmatter name code-review ≠ file wrong-name
  writeSkill(dir, 'meeting-notes.md', NOTES_SKILL);
  const index = indexWorkspaceSkills(dir);
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].name, 'meeting-notes');
  assert.equal(index.errors.length, 1);
  assert.match(index.errors[0].error, /không khớp tên file/);
});

test('index: file chứa secret ở frontmatter / thiếu description → errors, không chặn skill khác', () => {
  const dir = tmpDir();
  writeSkill(dir, 'bad-secret.md', `---
name: bad-secret
description: Skill with leaked key sk-abcdefghij1234567890 inside.
---

Body is clean.
`);
  writeSkill(dir, 'no-desc.md', `---
name: no-desc
---

Body without description.
`);
  writeSkill(dir, 'meeting-notes.md', NOTES_SKILL);
  const index = indexWorkspaceSkills(dir);
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].name, 'meeting-notes');
  assert.equal(index.errors.length, 2);
});

test('load: secret chỉ nằm trong body → index vẫn nhận (tier-1 chỉ quét frontmatter), load thì chặn', () => {
  const dir = tmpDir();
  writeSkill(dir, 'body-secret.md', `---
name: body-secret
description: Looks clean up here.
---

key is sk-abcdefghij1234567890 here.
`);
  const index = indexWorkspaceSkills(dir);
  assert.equal(index.entries.length, 1);
  assert.throws(() => loadWorkspaceSkill(dir, 'body-secret'), /secret/i);
});

test('load: đọc body đầy đủ + render inject; không tìm thấy → lỗi rõ', () => {
  const dir = tmpDir();
  writeSkill(dir, 'code-review.md', REVIEW_SKILL);
  const { skill, rendered } = loadWorkspaceSkill(dir, 'code-review');
  assert.equal(skill.name, 'code-review');
  assert.equal(skill.version, '1.2.0');
  assert.match(skill.body, /Check every changed file/);
  assert.match(rendered, /# Skill: code-review \(v1\.2\.0\)/);
  assert.match(rendered, /Review code changes/);
  assert.throws(() => loadWorkspaceSkill(dir, 'khong-co'), WorkspaceSkillError);
  assert.throws(() => loadWorkspaceSkill(dir, 'BAD NAME'), WorkspaceSkillError);
  assert.throws(() => loadWorkspaceSkill(dir, '../escape'), WorkspaceSkillError);
});

test('suggest: khớp trigger 3đ + description 1đ, ngưỡng >= 2; userOnly không suggest', () => {
  const dir = tmpDir();
  writeSkill(dir, 'code-review.md', REVIEW_SKILL);
  writeSkill(dir, 'meeting-notes.md', NOTES_SKILL);
  writeSkill(dir, 'secret-skill.md', `---
name: secret-skill
description: Review secrets in the codebase.
disable-model-invocation: true
---

Check secrets.
`);
  const index = indexWorkspaceSkills(dir);
  // "review" khớp trigger của code-review (3đ) → suggest.
  const s1 = suggestSkillsForText(index, 'please review this pull request diff');
  assert.equal(s1.length, 1);
  assert.equal(s1[0].name, 'code-review');
  assert.ok(s1[0].score >= 3);
  // "meeting transcript" khớp description meeting-notes (1+1=2đ) → suggest.
  const s2 = suggestSkillsForText(index, 'summarize this meeting transcript please');
  assert.ok(s2.some((s) => s.name === 'meeting-notes'));
  // secret-skill userOnly → không suggest dù khớp từ "review".
  assert.ok(!s1.some((s) => s.name === 'secret-skill'));
  // Text không liên quan → không suggest.
  assert.deepEqual(suggestSkillsForText(index, 'thời tiết hôm nay thế nào'), []);
  // Index ghi userOnly đúng.
  assert.equal(findWorkspaceSkill(index, 'secret-skill').userOnly, true);
});

test('validate: file tốt → không lỗi; file lỗi → liệt kê lỗi', () => {
  const dir = tmpDir();
  const good = writeSkill(dir, 'code-review.md', REVIEW_SKILL);
  assert.deepEqual(validateWorkspaceSkillFile(good), []);
  const bad = writeSkill(dir, 'bad.md', `---
name: bad
description: Has a key.
---

api_key = "abcdefghijklmnop1234"
`);
  const errors = validateWorkspaceSkillFile(bad);
  assert.ok(errors.length >= 1);
  assert.match(errors.join(' '), /secret/);
  assert.deepEqual(validateWorkspaceSkillFile(path.join(dir, 'khong-co.md')).length, 1);
});

test('session: loadSkill ghi skill.loaded vào log, trả rendered text', () => {
  const dir = tmpDir();
  writeSkill(dir, 'code-review.md', REVIEW_SKILL);
  const store = new ConversationLogStore({ dataDir: path.join(dir, 'logs') });
  const session = ConversationV112Session.open(store, {
    botId: 'bot-1',
    conversationId: 'conv-skill',
    workspaceDir: dir,
  });
  const rendered = session.loadSkill('code-review', 'user');
  assert.match(rendered, /# Skill: code-review/);
  const state = session.getState();
  assert.equal(state.loadedSkills.length, 1);
  assert.equal(state.loadedSkills[0].name, 'code-review');
  assert.equal(state.loadedSkills[0].version, '1.2.0');
  assert.ok(state.loadedSkills[0].injectedChars > 0);
  // Nạp lại cùng skill → không trùng tên, chỉ cập nhật.
  session.loadSkill('code-review', 'trigger');
  assert.equal(session.getState().loadedSkills.length, 1);
  assert.equal(store.verify('conv-skill').ok, true);
});

test('session: loadSkill khi chưa cấu hình workspaceDir → lỗi rõ', () => {
  const dir = tmpDir();
  const store = new ConversationLogStore({ dataDir: path.join(dir, 'logs') });
  const session = ConversationV112Session.open(store, { botId: 'bot-1', conversationId: 'conv-nows' });
  assert.throws(() => session.loadSkill('code-review'), /workspaceDir/);
});
