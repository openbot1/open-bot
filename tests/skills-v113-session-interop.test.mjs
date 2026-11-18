/**
 * Tests cho v1.13 (Đội T1): Agent Skills loader v13 — session index
 * (progressive disclosure 3 tầng) + import/export cross-CLI.
 *
 * Mọi skill mẫu trong file này đều do đội T1 tự viết cho test (nội dung
 * gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-v113-session-interop.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SkillSessionIndex, openSkillSessionIndex } from '../packages/core/dist/skills/v13/sessionIndex.js';
import {
  defaultHostRoots,
  detectSkillFormat,
  exportSkillToHost,
  hostRootFor,
  importAllFromHost,
  importSkillFromHost,
  listHostSkills,
  renderSkillMarkdown,
} from '../packages/core/dist/skills/v13/interop.js';
import { parseSkillMarkdown } from '../packages/core/dist/skills/loader.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(root, name, content, extraFiles = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  for (const [rel, text] of Object.entries(extraFiles)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
  return dir;
}

const REVIEW_SKILL = `---
name: note-review
description: Use when the user asks to review notes before sharing them.
version: 1.1.0
when-to-use: When the user asks to review notes.
license: MIT
allowed-tools: [read_file, grep_search]
---
# Note review

Read the notes, list issues, then suggest fixes.
`;

const FORK_SKILL = `---
name: deep-dive
description: Use when the user asks for a deep investigation in a separate context.
context: fork
---
# Deep dive

Investigate thoroughly, then report back.
`;

const USER_ONLY_SKILL = `---
name: secret-sauce
description: Use when the user explicitly asks for the secret sauce.
disable-model-invocation: true
---
# Secret sauce

Only the user may ask for this.
`;

const BROKEN_SKILL = `---
name: broken-skill
---
# Broken

No description here.
`;

const LONG_BODY_SKILL = `---
name: long-body-skill
description: Use when testing a long body that gets truncated on load.
---
# Long body

${'Instruction line that repeats to make the body long. '.repeat(200)}
`;

// --- Session index ---------------------------------------------------------

test('session index: open chỉ đọc header, body chưa load, token header > 0', () => {
  const root = tmpDir('open-bot-skills-v113-index-');
  writeSkill(root, 'note-review', REVIEW_SKILL);
  const index = SkillSessionIndex.open([root]);
  assert.equal(index.size, 1);
  assert.deepEqual(index.names, ['note-review']);
  const entry = index.get('note-review');
  assert.equal(entry.bodyLoaded, false);
  assert.equal(entry.bodyTokens, 0);
  assert.ok(entry.headerTokens > 0);
  assert.equal(index.totalHeaderTokens(), entry.headerTokens);
  assert.deepEqual(index.errors, []);
  assert.equal(index.stats().skills, 1);
  assert.equal(index.stats().fork, 0);
});

test('session index: loose .md + dir skill cùng mở, sắp xếp theo tên', () => {
  const root = tmpDir('open-bot-skills-v113-mixed-');
  writeSkill(root, 'note-review', REVIEW_SKILL);
  fs.writeFileSync(
    path.join(root, 'quick-note.md'),
    '---\nname: quick-note\ndescription: Use when the user wants a quick note taken.\n---\n# Quick note\n\nTake it fast.\n',
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not a skill', 'utf8');
  const index = SkillSessionIndex.open([root]);
  assert.deepEqual(index.names, ['note-review', 'quick-note']);
  assert.equal(index.get('quick-note').looseFile, true);
  assert.equal(index.get('note-review').looseFile, false);
});

test('session index: skill hỏng không chặn skill khác, ghi vào errors', () => {
  const root = tmpDir('open-bot-skills-v113-broken-');
  writeSkill(root, 'note-review', REVIEW_SKILL);
  writeSkill(root, 'broken-skill', BROKEN_SKILL);
  const index = SkillSessionIndex.open([root]);
  assert.equal(index.size, 1);
  assert.equal(index.errors.length, 1);
  assert.match(index.errors[0].file, /broken-skill/);
});

test('session index: root không tồn tại → index rỗng, không lỗi', () => {
  const index = SkillSessionIndex.open([path.join(os.tmpdir(), 'open-bot-no-such-root-v113')]);
  assert.equal(index.size, 0);
  assert.deepEqual(index.errors, []);
});

test('session index: root sau override root trước khi trùng tên', () => {
  const low = tmpDir('open-bot-skills-v113-low-');
  const high = tmpDir('open-bot-skills-v113-high-');
  writeSkill(low, 'note-review', REVIEW_SKILL);
  writeSkill(
    high,
    'note-review',
    REVIEW_SKILL.replace('1.1.0', '2.0.0').replace(
      'review notes before sharing them',
      'review notes before sharing them, v2',
    ),
  );
  const overridden = SkillSessionIndex.open([low, high]);
  assert.equal(overridden.get('note-review').version, '2.0.0');
  const kept = SkillSessionIndex.open([low, high], { laterRootsOverride: false });
  assert.equal(kept.get('note-review').version, '1.1.0');
});

test('session index: ensureBody load-on-demand, cache hit lần 2', () => {
  const root = tmpDir('open-bot-skills-v113-body-');
  writeSkill(root, 'note-review', REVIEW_SKILL);
  const index = SkillSessionIndex.open([root]);
  const first = index.ensureBody('note-review');
  assert.equal(first.fromCache, false);
  assert.match(first.body, /Read the notes/);
  assert.ok(first.bodyTokens > 0);
  assert.equal(index.get('note-review').bodyLoaded, true);
  const second = index.ensureBody('note-review');
  assert.equal(second.fromCache, true);
  assert.equal(second.body, first.body);
  assert.deepEqual(index.cachedBodyNames(), ['note-review']);
});

test('session index: ensureBody skill lạ → throw; dropBody + clearBodies', () => {
  const root = tmpDir('open-bot-skills-v113-drop-');
  writeSkill(root, 'note-review', REVIEW_SKILL);
  const index = SkillSessionIndex.open([root]);
  assert.throws(() => index.ensureBody('no-such-skill'), /No skill named/);
  index.ensureBody('note-review');
  assert.equal(index.dropBody('note-review'), true);
  assert.equal(index.dropBody('note-review'), false);
  assert.equal(index.get('note-review').bodyLoaded, false);
  index.ensureBody('note-review');
  index.clearBodies();
  assert.deepEqual(index.cachedBodyNames(), []);
});

test('session index: LRU evict body cũ khi vượt maxCachedBodies', () => {
  const root = tmpDir('open-bot-skills-v113-lru-');
  for (const name of ['aaa-one', 'bbb-two', 'ccc-three']) {
    writeSkill(
      root,
      name,
      `---\nname: ${name}\ndescription: Use when testing LRU eviction for ${name}.\n---\n# ${name}\n\nBody of ${name}.\n`,
    );
  }
  const index = SkillSessionIndex.open([root], { maxCachedBodies: 2 });
  index.ensureBody('aaa-one');
  index.ensureBody('bbb-two');
  index.ensureBody('ccc-three');
  assert.deepEqual(index.cachedBodyNames(), ['bbb-two', 'ccc-three']);
  assert.equal(index.get('aaa-one').bodyLoaded, false);
  // Truy cập lại bbb-two → nó thành mới nhất.
  index.ensureBody('bbb-two');
  index.ensureBody('aaa-one');
  assert.deepEqual(index.cachedBodyNames(), ['bbb-two', 'aaa-one']);
});

test('session index: body dài bị cắt ở MAX_SKILL_BODY_CHARS, báo truncated', () => {
  const root = tmpDir('open-bot-skills-v113-trunc-');
  writeSkill(root, 'long-body-skill', LONG_BODY_SKILL);
  const index = SkillSessionIndex.open([root]);
  const loaded = index.ensureBody('long-body-skill');
  assert.equal(loaded.truncated, true);
  assert.ok(loaded.body.length <= 4000);
});

test('session index: formatIndex tách skill user-only, ẩn skill userInvocable=false', () => {
  const root = tmpDir('open-bot-skills-v113-format-');
  writeSkill(root, 'note-review', REVIEW_SKILL);
  writeSkill(root, 'deep-dive', FORK_SKILL);
  writeSkill(root, 'secret-sauce', USER_ONLY_SKILL);
  const index = SkillSessionIndex.open([root]);
  const text = index.formatIndex();
  assert.match(text, /note-review: Use when the user asks to review notes/);
  assert.match(text, /deep-dive.*runs in a subagent/);
  assert.match(text, /User-invoked only/);
  assert.match(text, /secret-sauce/);
  assert.equal(index.stats().userOnly, 1);
  assert.equal(index.stats().fork, 1);
  // toIndexEntries chỉ có name/description/context/allowedTools.
  const entries = index.toIndexEntries();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.find((e) => e.name === 'deep-dive').context, 'fork');
});

test('session index: tier 3 — readResource + resourcePath, chặn traversal', () => {
  const root = tmpDir('open-bot-skills-v113-res-');
  writeSkill(root, 'note-review', REVIEW_SKILL, {
    'references/guide.md': '# Guide\n\nExtra details here.\n',
    'scripts/check.sh': '#!/bin/sh\necho ok\n',
  });
  const index = SkillSessionIndex.open([root]);
  assert.deepEqual(index.get('note-review').resources.references, ['references/guide.md']);
  assert.deepEqual(index.get('note-review').resources.scripts, ['scripts/check.sh']);
  assert.match(index.readResource('note-review', 'references/guide.md'), /Extra details/);
  assert.ok(index.resourcePath('note-review', 'scripts/check.sh').endsWith('scripts/check.sh'));
  assert.throws(() => index.readResource('note-review', '../SKILL.md'));
  assert.throws(() => index.readResource('note-review', 'SKILL.md'));
  assert.equal(index.resourcePath('note-review', '../SKILL.md'), undefined);
  assert.throws(() => index.readResource('no-such', 'references/guide.md'));
});

test('session index: openSkillSessionIndex trả {index, errors}', () => {
  const root = tmpDir('open-bot-skills-v113-open-');
  writeSkill(root, 'note-review', REVIEW_SKILL);
  const { index, errors } = openSkillSessionIndex([root]);
  assert.equal(index.size, 1);
  assert.deepEqual(errors, []);
});

// --- Interop -----------------------------------------------------------------

test('interop: detectSkillFormat nhận đúng 4 layout, unknown còn lại', () => {
  assert.equal(detectSkillFormat('/home/u/.claude/skills'), 'claude-code');
  assert.equal(detectSkillFormat('/proj/.claude/skills/code-review'), 'claude-code');
  assert.equal(detectSkillFormat('/home/u/.agents/skills'), 'codex-cli');
  assert.equal(detectSkillFormat('/home/u/.gemini/skills'), 'gemini-cli');
  assert.equal(detectSkillFormat('/proj/.codex/skills'), 'codex-cli');
  assert.equal(detectSkillFormat('/proj/.gemini/skills/x'), 'gemini-cli');
  assert.equal(detectSkillFormat('/some/other/dir'), 'unknown');
});

test('interop: hostRootFor + defaultHostRoots trả đủ 3 host', () => {
  assert.equal(hostRootFor('claude-code', { homeDir: '/home/u' }), path.join('/home/u', '.claude', 'skills'));
  assert.equal(hostRootFor('codex-cli', { homeDir: '/home/u' }), path.join('/home/u', '.agents', 'skills'));
  assert.equal(hostRootFor('gemini-cli', { homeDir: '/home/u' }), path.join('/home/u', '.gemini', 'skills'));
  assert.equal(
    hostRootFor('claude-code', { projectDir: '/proj', scope: 'project' }),
    path.join('/proj', '.claude', 'skills'),
  );
  const roots = defaultHostRoots('/proj', '/home/u');
  assert.equal(roots.length, 6);
  assert.ok(roots.some((r) => r.format === 'codex-cli' && r.label === 'Codex CLI'));
});

test('interop: renderSkillMarkdown round-trip qua parseSkillMarkdown', () => {
  const skill = parseSkillMarkdown(REVIEW_SKILL, 'user');
  const rendered = renderSkillMarkdown(skill);
  const reparsed = parseSkillMarkdown(rendered, 'user');
  assert.equal(reparsed.name, 'note-review');
  assert.equal(reparsed.description, skill.description);
  assert.equal(reparsed.version, '1.1.0');
  assert.deepEqual(reparsed.allowedTools, ['read_file', 'grep_search']);
  assert.equal(reparsed.license, 'MIT');
  assert.match(reparsed.body, /Read the notes/);
});

test('interop: export sang claude-code rồi import lại, đủ file scripts/references', () => {
  const src = tmpDir('open-bot-skills-v113-src-');
  const skillDir = writeSkill(src, 'note-review', REVIEW_SKILL, {
    'references/guide.md': '# Guide\n\nDetails.\n',
    'scripts/check.sh': 'echo ok\n',
  });
  const dest = tmpDir('open-bot-skills-v113-dest-');
  const claudeRoot = path.join(dest, '.claude', 'skills');
  const exported = exportSkillToHost(skillDir, 'claude-code', claudeRoot);
  assert.equal(exported.name, 'note-review');
  assert.equal(exported.format, 'claude-code');
  assert.equal(exported.destDir, path.join(claudeRoot, 'note-review'));
  assert.ok(fs.existsSync(path.join(exported.destDir, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(exported.destDir, 'references', 'guide.md')));
  assert.ok(fs.existsSync(path.join(exported.destDir, 'scripts', 'check.sh')));
  assert.equal(exported.validation.valid, true);

  // Import lại vào thư mục open-bot.
  const installed = tmpDir('open-bot-skills-v113-installed-');
  const imported = importSkillFromHost(exported.destDir, installed);
  assert.equal(imported.name, 'note-review');
  assert.equal(imported.sourceFormat, 'claude-code');
  assert.ok(fs.existsSync(path.join(imported.installedDir, 'references', 'guide.md')));
  // Import lần 2 không overwrite → lỗi.
  assert.throws(() => importSkillFromHost(exported.destDir, installed), /already exists/);
  const again = importSkillFromHost(exported.destDir, installed, { overwrite: true });
  assert.equal(again.name, 'note-review');
});

test('interop: export skill lỗi v13 → throw, không ghi file', () => {
  const src = tmpDir('open-bot-skills-v113-badexport-');
  const badDir = writeSkill(src, 'heavy-skill', `---
name: heavy-skill
description: Use when testing a bad export.
compatibility: ${'y'.repeat(600)}
---
# Heavy

Body.
`);
  const dest = tmpDir('open-bot-skills-v113-badexport-dest-');
  assert.throws(() => exportSkillToHost(badDir, 'gemini-cli', path.join(dest, '.gemini', 'skills')), /fails v13 validation/);
  assert.equal(fs.existsSync(path.join(dest, '.gemini', 'skills', 'heavy-skill')), false);
});

test('interop: export trùng tên không overwrite → lỗi; overwrite thì ghi đè', () => {
  const src = tmpDir('open-bot-skills-v113-dup-');
  const skillDir = writeSkill(src, 'note-review', REVIEW_SKILL);
  const root = path.join(tmpDir('open-bot-skills-v113-dup2-'), '.agents', 'skills');
  exportSkillToHost(skillDir, 'codex-cli', root);
  assert.throws(() => exportSkillToHost(skillDir, 'codex-cli', root), /already exists/);
  const again = exportSkillToHost(skillDir, 'codex-cli', root, { overwrite: true });
  assert.equal(again.name, 'note-review');
});

test('interop: listHostSkills liệt kê tier-1, skill hỏng vào errors', () => {
  const root = tmpDir('open-bot-skills-v113-hostlist-');
  writeSkill(root, 'note-review', REVIEW_SKILL);
  writeSkill(root, 'broken-skill', BROKEN_SKILL);
  const { skills, errors } = listHostSkills(root);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'note-review');
  assert.equal(errors.length, 1);
});

test('interop: importAllFromHost nhập hết skill tốt, bỏ qua skill hỏng', () => {
  const src = tmpDir('open-bot-skills-v113-all-');
  writeSkill(src, 'note-review', REVIEW_SKILL);
  writeSkill(src, 'deep-dive', FORK_SKILL);
  writeSkill(src, 'broken-skill', BROKEN_SKILL);
  const dest = tmpDir('open-bot-skills-v113-all-dest-');
  const { imported, errors } = importAllFromHost(src, dest);
  assert.deepEqual(imported.map((r) => r.name).sort(), ['deep-dive', 'note-review']);
  assert.equal(errors.length, 1);
  assert.ok(fs.existsSync(path.join(dest, 'note-review', 'SKILL.md')));
  // Root không tồn tại → không nhập gì, không lỗi.
  const empty = importAllFromHost(path.join(os.tmpdir(), 'open-bot-no-root-v113'), dest);
  assert.deepEqual(empty.imported, []);
  assert.deepEqual(empty.errors, []);
});
