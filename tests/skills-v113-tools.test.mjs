/**
 * Tests cho v1.13 (Đội T1): Agent Skills loader v13 — 8 agent tool.
 *
 * Mọi skill mẫu trong file này đều do đội T1 tự viết cho test (nội dung
 * gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/skills-v113-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createSkillsV13Tools,
  SKILLS_V13_TOOLS,
  SKILLS_V13_TOOL_NAMES,
} from '../packages/tools/dist/skillsV13Tools.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const REVIEW_SKILL = `---
name: note-review
description: Use when the user asks to review notes before sharing them.
version: 1.1.0
license: MIT
allowed-tools: [read_file, grep_search]
---
# Note review

Read the notes, list issues, then suggest fixes.
`;

const GOOD_SKILL = `---
name: quick-note
description: Use when the user wants a quick note taken right now.
version: 1.2.0
when-to-use: When the user wants a quick note taken right now.
license: MIT
---
# Quick note

Take the note fast.
`;

function writeSkillDir(root, name, content) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test('tools: factory trả đủ 8 tool, đúng tên, đúng needsApproval', () => {
  assert.deepEqual([...SKILLS_V13_TOOL_NAMES], [
    'skills_v13_list',
    'skills_v13_search',
    'skills_v13_validate',
    'skills_v13_audit',
    'skills_v13_import',
    'skills_v13_export',
    'skills_v13_install_local',
    'skills_v13_uninstall',
  ]);
  const tools = createSkillsV13Tools();
  assert.equal(tools.length, 8);
  assert.deepEqual(tools.map((t) => t.definition.name), [...SKILLS_V13_TOOL_NAMES]);
  // 4 tool chỉ đọc không cần duyệt, 4 tool ghi cần duyệt.
  const readOnly = ['skills_v13_list', 'skills_v13_search', 'skills_v13_validate', 'skills_v13_audit'];
  for (const tool of tools) {
    assert.equal(tool.needsApproval, !readOnly.includes(tool.definition.name), tool.definition.name);
    assert.ok(tool.definition.description.length > 20);
    assert.equal(tool.definition.parameters.type, 'object');
  }
  // Placeholder chưa bound cũng đủ 8 tool.
  assert.equal(SKILLS_V13_TOOLS.length, 8);
});

test('tools: skills_v13_list liệt kê tier-1 + token header', async () => {
  const root = tmpDir('open-bot-skills-v113-tool-list-');
  writeSkillDir(root, 'note-review', REVIEW_SKILL);
  writeSkillDir(root, 'quick-note', GOOD_SKILL);
  const tools = createSkillsV13Tools();
  const out = await toolByName(tools, 'skills_v13_list').execute({ dir: root });
  assert.match(out, /2 skill/);
  assert.match(out, /note-review \(v1\.1\.0\)/);
  assert.match(out, /quick-note \(v1\.2\.0\)/);
  assert.match(out, /token header/);
  const bad = await toolByName(tools, 'skills_v13_list').execute({ dir: '' });
  assert.match(bad, /^Error:/);
  const missing = await toolByName(tools, 'skills_v13_list').execute({ dir: path.join(os.tmpdir(), 'open-bot-no-dir-v113') });
  assert.match(missing, /0 skill/);
});

test('tools: skills_v13_search theo query và theo context', async () => {
  const tools = createSkillsV13Tools();
  const byQuery = await toolByName(tools, 'skills_v13_search').execute({ query: 'review this pull request' });
  assert.match(byQuery, /code-review/);
  const byContext = await toolByName(tools, 'skills_v13_search').execute({ context: 'review' });
  assert.match(byContext, /code-review/);
  assert.match(byContext, /test-writing/);
  const badContext = await toolByName(tools, 'skills_v13_search').execute({ context: 'nope' });
  assert.match(badContext, /^Error:/);
  const neither = await toolByName(tools, 'skills_v13_search').execute({});
  assert.match(neither, /^Error:/);
  const none = await toolByName(tools, 'skills_v13_search').execute({ query: 'zzzqqq www' });
  assert.match(none, /Không tìm thấy/);
});

test('tools: skills_v13_validate trả điểm 100 cho skill tốt, lỗi cho skill xấu', async () => {
  const root = tmpDir('open-bot-skills-v113-tool-validate-');
  const goodFile = path.join(writeSkillDir(root, 'quick-note', GOOD_SKILL), 'SKILL.md');
  const badDir = writeSkillDir(
    root,
    'plain-label',
    '---\nname: plain-label\ndescription: A very nice skill.\n---\n# Plain\n\nBody.\n',
  );
  const tools = createSkillsV13Tools();
  const good = await toolByName(tools, 'skills_v13_validate').execute({ file: goodFile });
  assert.match(good, /valid, quality 100\/100/);
  const bad = await toolByName(tools, 'skills_v13_validate').execute({ file: path.join(badDir, 'SKILL.md') });
  assert.match(bad, /INVALID/);
  assert.match(bad, /description-no-trigger/);
  const missing = await toolByName(tools, 'skills_v13_validate').execute({ file: path.join(root, 'nope', 'SKILL.md') });
  assert.match(missing, /^Error:/);
});

test('tools: skills_v13_audit trả báo cáo Markdown có cả 2 audit', async () => {
  const root = tmpDir('open-bot-skills-v113-tool-audit-');
  writeSkillDir(root, 'note-review', REVIEW_SKILL);
  writeSkillDir(root, 'quick-note', GOOD_SKILL);
  const tools = createSkillsV13Tools();
  const usageJson = JSON.stringify([
    { skillName: 'note-review', toolName: 'read_file' },
    { skillName: 'note-review', toolName: 'read_file' },
    { skillName: 'note-review', toolName: 'grep_search' },
  ]);
  const out = await toolByName(tools, 'skills_v13_audit').execute({
    skillsDir: root,
    usageJson,
    activationsJson: JSON.stringify({ 'note-review': 1 }),
  });
  assert.match(out, /# Skill waste report/);
  assert.match(out, /## Tool usage per skill/);
  assert.match(out, /## Context tax per skill/);
  assert.match(out, /note-review/);
  assert.match(out, /quick-note/); // chưa kích hoạt → nằm trong waste
  // usageJson sai định dạng → Error rõ ràng.
  const bad = await toolByName(tools, 'skills_v13_audit').execute({ skillsDir: root, usageJson: 'not json' });
  assert.match(bad, /^Error:/);
  const badAct = await toolByName(tools, 'skills_v13_audit').execute({
    skillsDir: root,
    activationsJson: JSON.stringify({ 'note-review': -1 }),
  });
  assert.match(badAct, /^Error:/);
});

test('tools: skills_v13_import + install_local + uninstall đi hết vòng', async () => {
  const skillsDir = tmpDir('open-bot-skills-v113-tool-flow-');
  const tools = createSkillsV13Tools({ getSkillsDir: () => skillsDir });
  // Import từ thư mục Claude Code giả lập.
  const claudeRoot = tmpDir('open-bot-skills-v113-tool-claude-');
  const srcDir = writeSkillDir(path.join(claudeRoot, '.claude', 'skills'), 'note-review', REVIEW_SKILL);
  const imported = await toolByName(tools, 'skills_v13_import').execute({ sourceDir: srcDir });
  assert.match(imported, /Đã nhập skill "note-review"/);
  assert.match(imported, /claude-code/);
  assert.ok(fs.existsSync(path.join(skillsDir, 'note-review', 'SKILL.md')));
  // Import lại không overwrite → Error.
  const dup = await toolByName(tools, 'skills_v13_import').execute({ sourceDir: srcDir });
  assert.match(dup, /^Error:/);
  // Uninstall rồi cài lại từ marketplace local.
  const uninstalled = await toolByName(tools, 'skills_v13_uninstall').execute({ name: 'note-review' });
  assert.match(uninstalled, /Đã gỡ skill "note-review"/);
  assert.equal(fs.existsSync(path.join(skillsDir, 'note-review')), false);
  const market = tmpDir('open-bot-skills-v113-tool-market-');
  const marketDir = writeSkillDir(market, 'quick-note', GOOD_SKILL);
  const installed = await toolByName(tools, 'skills_v13_install_local').execute({ sourceDir: marketDir });
  assert.match(installed, /Đã cài skill "quick-note" v1\.2\.0/);
  assert.ok(fs.existsSync(path.join(skillsDir, 'quick-note', 'SKILL.md')));
});

test('tools: skills_v13_export sang gemini-cli (rootDir truyền rõ)', async () => {
  const skillsDir = tmpDir('open-bot-skills-v113-tool-export-');
  writeSkillDir(skillsDir, 'quick-note', GOOD_SKILL);
  const geminiRoot = path.join(tmpDir('open-bot-skills-v113-tool-gemini-'), '.gemini', 'skills');
  const tools = createSkillsV13Tools({ getSkillsDir: () => skillsDir });
  const out = await toolByName(tools, 'skills_v13_export').execute({
    name: 'quick-note',
    format: 'gemini-cli',
    rootDir: geminiRoot,
  });
  assert.match(out, /Đã xuất skill "quick-note" sang gemini-cli/);
  assert.ok(fs.existsSync(path.join(geminiRoot, 'quick-note', 'SKILL.md')));
  // Format lạ → Error.
  const bad = await toolByName(tools, 'skills_v13_export').execute({ name: 'quick-note', format: 'vscode' });
  assert.match(bad, /^Error:/);
  // Skill không có → Error.
  const missing = await toolByName(tools, 'skills_v13_export').execute({
    name: 'no-such-skill',
    format: 'gemini-cli',
    rootDir: geminiRoot,
  });
  assert.match(missing, /^Error:/);
});

test('tools: tool ghi không có getSkillsDir → Error rõ ràng, không ghi lung tung', async () => {
  const tools = createSkillsV13Tools(); // unbound
  const src = tmpDir('open-bot-skills-v113-tool-unbound-');
  const srcDir = writeSkillDir(src, 'quick-note', GOOD_SKILL);
  const out = await toolByName(tools, 'skills_v13_import').execute({ sourceDir: srcDir });
  assert.match(out, /^Error:/);
  assert.match(out, /Chưa cấu hình thư mục skills/);
  const un = await toolByName(tools, 'skills_v13_uninstall').execute({ name: 'quick-note' });
  assert.match(un, /^Error:/);
});
