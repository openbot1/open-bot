/**
 * Tests cho v1.36 (Đội T2): Agent Skills v15 — migration + 12 agent tools.
 *
 * Mọi skill mẫu trong file này đều do đội T2 tự viết cho test (nội
 * dung gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/skills-v15-migration-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  formatMigrationReportV15,
  isSpecDirNameV15,
  migrateSkillV15,
  normaliseSkillDirNameV15,
} from '../packages/core/dist/skills/v15/migration.js';
import {
  createSkillsV15Tools,
  SKILLS_V15_TOOL_NAMES,
  SKILLS_V15_TOOLS,
} from '../packages/tools/dist/skillsV15Tools.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-v15-mt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeLegacySkill(parent, dirName) {
  const skillDir = path.join(parent, dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: Review_PR',
      'description: Reviews a pull request for bugs and style. Use when a pull request needs review before merging.',
      'version: 1.0.0',
      'whenToUse: when a pull request needs review',
      'tools:',
      '  - read_file',
      '  - write_file',
      'context: fork',
      '---',
      '',
      '# Review PR',
      '',
      'Check the diff, then list findings.',
      '',
    ].join('\n'),
    'utf8',
  );
  return skillDir;
}

function writeCleanSkill(parent, name) {
  const skillDir = path.join(parent, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: Reviews a pull request for bugs and style. Use when a pull request needs review before merging.',
      'license: MIT',
      'compatibility: claude; opencode',
      '---',
      '',
      '# Review PR',
      '',
      'Check the diff, then list findings.',
      '',
    ].join('\n'),
    'utf8',
  );
  return skillDir;
}

test('normaliseSkillDirNameV15: underscore/space/case/punctuation', () => {
  assert.equal(normaliseSkillDirNameV15('Review_PR'), 'review-pr');
  assert.equal(normaliseSkillDirNameV15('my skill!'), 'my-skill');
  assert.equal(normaliseSkillDirNameV15('a--b'), 'a-b');
  assert.equal(normaliseSkillDirNameV15('UPPER'), 'upper');
  assert.equal(normaliseSkillDirNameV15('!!!'), 'skill');
  assert.equal(isSpecDirNameV15('review-pr'), true);
  assert.equal(isSpecDirNameV15('Review_PR'), false);
  assert.equal(isSpecDirNameV15('a'), true);
});

test('migrateSkillV15 dry run: reports every change, writes nothing', (t) => {
  const dir = tmpDir(t);
  const skillDir = writeLegacySkill(dir, 'Review_PR');
  const result = migrateSkillV15(skillDir, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.fromName, 'Review_PR');
  assert.equal(result.toName, 'review-pr');
  assert.equal(result.validationQuality, 0);
  const kinds = result.changes.map((c) => `${c.kind}:${c.field ?? ''}`);
  assert.ok(kinds.includes('rename-dir:'));
  assert.ok(kinds.includes('frontmatter-field:tools'));
  assert.ok(kinds.includes('add-compatibility:compatibility'));
  assert.ok(kinds.includes('frontmatter-field:whenToUse'));
  assert.ok(kinds.includes('frontmatter-field:version'));
  assert.ok(kinds.includes('frontmatter-field:context'));
  assert.ok(kinds.includes('frontmatter-value:name'));
  assert.match(formatMigrationReportV15(result), /dry run/);
  // Nothing was written: the original dir and name survive.
  assert.ok(fs.existsSync(path.join(dir, 'Review_PR', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(dir, 'review-pr')), false);
});

test('migrateSkillV15 real run: renamed, valid, whenToUse preserved in body', (t) => {
  const dir = tmpDir(t);
  const skillDir = writeLegacySkill(dir, 'Review_PR');
  const result = migrateSkillV15(skillDir);
  assert.equal(result.dryRun, false);
  assert.equal(result.dir, path.join(dir, 'review-pr'));
  assert.ok(result.validationQuality > 90, `expected a clean migration, got ${result.validationQuality}`);
  assert.equal(fs.existsSync(path.join(dir, 'Review_PR')), false);
  const text = fs.readFileSync(path.join(dir, 'review-pr', 'SKILL.md'), 'utf8');
  assert.match(text, /name: review-pr/);
  assert.match(text, /allowed-tools:/);
  assert.match(text, /- read_file/);
  assert.match(text, /compatibility: openbot/);
  assert.match(text, /## When to use/);
  assert.match(text, /when a pull request needs review/);
  assert.doesNotMatch(text, /version:/);
  assert.doesNotMatch(text, /context: fork/);
  assert.doesNotMatch(text, /whenToUse:/);
  assert.doesNotMatch(text, /^tools:/m);
});

test('migrateSkillV15: already-clean skill reports no changes, keeps quality', (t) => {
  const dir = tmpDir(t);
  const skillDir = writeCleanSkill(path.join(dir, 'skills'), 'review-pr');
  const result = migrateSkillV15(skillDir, { dryRun: true });
  assert.equal(result.changes.length, 0);
  assert.match(formatMigrationReportV15(result), /No changes needed/);
  const real = migrateSkillV15(skillDir);
  assert.equal(real.validationQuality, 100);
});

test('migrateSkillV15: refuses a skill with no description, refuses rename collision', (t) => {
  const dir = tmpDir(t);
  const bad = path.join(dir, 'Bad_Name');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: Bad_Name\n---\n\nbody\n', 'utf8');
  assert.throws(() => migrateSkillV15(bad), /no usable description/);
  const clash = path.join(dir, 'clash');
  fs.mkdirSync(clash, { recursive: true });
  writeLegacySkill(dir, 'Clash');
  assert.throws(() => migrateSkillV15(path.join(dir, 'Clash')), /already exists/);
  const ok = migrateSkillV15(path.join(dir, 'Clash'), { overwrite: true });
  assert.equal(ok.toName, 'clash');
});

// --- Tools ------------------------------------------------------------------

function toolsFor(projectRoot) {
  const tools = createSkillsV15Tools({ getProjectRoot: () => projectRoot });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return { tools, byName };
}

async function run(byName, name, args) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} must exist`);
  return tool.execute(args);
}

test('skills_v15 tools: 17 tools, names match [A-Za-z0-9_-], 10 read-only + 7 approval', () => {
  assert.equal(SKILLS_V15_TOOLS.length, 17);
  assert.equal(SKILLS_V15_TOOL_NAMES.length, 17);
  for (const name of SKILLS_V15_TOOL_NAMES) {
    assert.match(name, /^[A-Za-z0-9_-]+$/, `${name} must not contain a dot`);
    assert.ok(name.startsWith('skills_v15_'));
  }
  const readOnly = SKILLS_V15_TOOLS.filter((tool) => tool.needsApproval === false).map((tool) => tool.definition.name);
  const approval = SKILLS_V15_TOOLS.filter((tool) => tool.needsApproval === true).map((tool) => tool.definition.name);
  assert.deepEqual(
    [...readOnly].sort(),
    ['skills_v15_audit', 'skills_v15_compat', 'skills_v15_disclose', 'skills_v15_export_plan', 'skills_v15_pack_verify', 'skills_v15_platforms', 'skills_v15_registry', 'skills_v15_status', 'skills_v15_sync', 'skills_v15_validate_platform'].sort(),
  );
  assert.deepEqual(
    [...approval].sort(),
    ['skills_v15_export_multi', 'skills_v15_import_multi', 'skills_v15_migrate', 'skills_v15_pack_create', 'skills_v15_pack_install', 'skills_v15_remove_platform', 'skills_v15_sync_repair'].sort(),
  );
});

test('skills_v15 tools: platforms + status + validate + compat (read-only)', async (t) => {
  const dir = tmpDir(t);
  const src = writeCleanSkill(path.join(dir, 'src'), 'review-pr');
  const { byName } = toolsFor(dir);
  const platforms = await run(byName, 'skills_v15_platforms', {});
  assert.match(platforms, /openbot/);
  assert.match(platforms, /\.codex\/skills/);
  const before = await run(byName, 'skills_v15_status', { name: 'review-pr' });
  assert.match(before, /missing on: openbot, claude, github, codex, opencode/);
  const validated = await run(byName, 'skills_v15_validate_platform', { dir: src });
  assert.match(validated, /valid/i);
  assert.match(validated, /claude: supported/);
  const compat = await run(byName, 'skills_v15_compat', { dir: src, platforms: 'codex,claude' });
  assert.match(compat, /claude: supported/);
  assert.match(compat, /codex: unknown/);
  const badAction = await run(byName, 'skills_v15_disclose', { action: 'nope' });
  assert.match(badAction, /^Error:/);
});

test('skills_v15 tools: export-multi then status, disclose, registry, sync (end to end)', async (t) => {
  const dir = tmpDir(t);
  const src = writeCleanSkill(path.join(dir, 'src'), 'review-pr');
  const { byName } = toolsFor(dir);
  const exported = await run(byName, 'skills_v15_export_multi', { skillDir: src, mode: 'copy' });
  assert.match(exported, /Đã xuất skill "review-pr"/);
  assert.match(exported, /claude \[copy\]/);
  const status = await run(byName, 'skills_v15_status', { name: 'review-pr' });
  assert.match(status, /Installed on: openbot, claude, github, codex, opencode/);
  const listed = await run(byName, 'skills_v15_disclose', { action: 'list' });
  assert.match(listed, /review-pr/);
  const activated = await run(byName, 'skills_v15_disclose', { action: 'activate', name: 'review-pr' });
  assert.match(activated, /Check the diff/);
  const usage = await run(byName, 'skills_v15_disclose', { action: 'usage' });
  assert.match(usage, /Disclosure usage:/);
  const registry = await run(byName, 'skills_v15_registry', { action: 'matrix' });
  assert.match(registry, /review-pr \| \? \| yes \| \? \| \? \| yes \| no/);
  const supported = await run(byName, 'skills_v15_registry', { action: 'supported', platform: 'github' });
  assert.match(supported, /No skills in the v15 registry/);
  const synced = await run(byName, 'skills_v15_sync', {});
  assert.match(synced, /4 mirror\(s\) checked, 4 in sync/);
  const removed = await run(byName, 'skills_v15_remove_platform', { name: 'review-pr', platform: 'github' });
  assert.match(removed, /Đã gỡ skill "review-pr"/);
  const afterRemove = await run(byName, 'skills_v15_status', { name: 'review-pr' });
  assert.match(afterRemove, /github: missing/);
  const repaired = await run(byName, 'skills_v15_sync_repair', {});
  assert.match(repaired, /Repaired: review-pr@github/);
});

test('skills_v15 tools: import-multi overwrite confirm + migrate dry run', async (t) => {
  const dir = tmpDir(t);
  const claudeSrc = writeCleanSkill(path.join(dir, '.claude', 'skills'), 'review-pr');
  const { byName } = toolsFor(dir);
  const imported = await run(byName, 'skills_v15_import_multi', { sourceDir: claudeSrc });
  assert.match(imported, /Đã nhập skill "review-pr" từ claude/);
  const again = await run(byName, 'skills_v15_import_multi', { sourceDir: claudeSrc });
  assert.match(again, /Chưa ghi gì cả/);
  assert.match(again, /overwrite=true/);
  const confirmed = await run(byName, 'skills_v15_import_multi', { sourceDir: claudeSrc, overwrite: true });
  assert.match(confirmed, /đã ghi đè bản cũ/);
  const legacy = writeLegacySkill(dir, 'Old_Skill');
  const migrated = await run(byName, 'skills_v15_migrate', { dir: legacy, dryRun: true });
  assert.match(migrated, /dry run/);
  assert.match(migrated, /rename-dir/);
  const badMode = await run(byName, 'skills_v15_export_multi', { skillDir: claudeSrc, mode: 'carrier-pigeon' });
  assert.match(badMode, /^Error:/);
});
