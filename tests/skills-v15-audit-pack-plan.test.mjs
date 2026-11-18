/**
 * Tests cho v1.36 (Đội T2): Agent Skills v15 — project audit + skill
 * packs + dry-run export planner (+ các tool mới).
 *
 * Mọi skill mẫu trong file này đều do đội T2 tự viết cho test (nội
 * dung gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/skills-v15-audit-pack-plan.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  auditProjectSkillsV15,
  exportReadinessV15,
  formatAuditReportV15,
  isAuditCleanV15,
  saveAuditReportV15,
} from '../packages/core/dist/skills/v15/audit.js';
import {
  applyExportPlanV15,
  formatExportPlanV15,
  isPlanApplicableV15,
  planMultiPlatformExportV15,
} from '../packages/core/dist/skills/v15/exportPlan.js';
import {
  createSkillPackV15,
  formatPackInstallResultV15,
  installSkillPackV15,
  isPackNameV15,
  listPackSkillsV15,
  readPackManifestV15,
  verifySkillPackV15,
} from '../packages/core/dist/skills/v15/pack.js';
import { parseCompatibilityV15 } from '../packages/core/dist/skills/v15/platforms.js';
import { createSkillsV15Tools } from '../packages/tools/dist/skillsV15Tools.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-v15-ap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(parent, name, compat, extraBody = 'Do the thing.\n') {
  const skillDir = path.join(parent, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const fm = [
    '---',
    `name: ${name}`,
    `description: Reviews a pull request for bugs and style. Use when a pull request needs review before merging.`,
    'license: MIT',
    compat === undefined ? '' : `compatibility: ${compat}`,
    '---',
    '',
  ].filter((l) => l !== '').join('\n');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${fm}\n\n# Skill\n\n${extraBody}`, 'utf8');
  return skillDir;
}

function seedProject(t) {
  const dir = tmpDir(t);
  const home = path.join(dir, 'fake-home');
  fs.mkdirSync(home, { recursive: true });
  const agents = path.join(dir, '.agents', 'skills');
  writeSkill(agents, 'review-pr', 'claude; opencode');
  writeSkill(agents, 'plain-notes', undefined);
  return { dir, home, agents };
}

// --- Audit ------------------------------------------------------------------

test('exportReadinessV15: ready / blocked / unverified', () => {
  const compat = parseCompatibilityV15('claude; not supported on codex');
  assert.equal(exportReadinessV15(true, compat, 'claude'), 'ready');
  assert.equal(exportReadinessV15(true, compat, 'codex'), 'blocked');
  assert.equal(exportReadinessV15(true, compat, 'github'), 'unverified');
  assert.equal(exportReadinessV15(false, compat, 'claude'), 'blocked');
  assert.equal(exportReadinessV15(true, parseCompatibilityV15(undefined), 'github'), 'unverified');
});

test('auditProjectSkillsV15: totals, readiness, findings rollup', (t) => {
  const { dir, home } = seedProject(t);
  const report = auditProjectSkillsV15({ projectRoot: dir, homeDir: home });
  assert.equal(report.total, 2);
  assert.equal(report.valid, 2);
  assert.equal(report.invalid, 0);
  assert.equal(report.averageQuality, 98.5);
  assert.equal(report.portable, 0);
  assert.equal(report.unknownCompatibility, 1);
  assert.ok(report.totalHeaderTokens > 0);
  assert.equal(report.skills[0].name, 'plain-notes');
  assert.equal(report.skills[1].name, 'review-pr');
  const review = report.skills[1];
  assert.equal(review.readiness.claude, 'ready');
  assert.equal(review.readiness.github, 'unverified');
  assert.deepEqual(review.installedOn, ['openbot']);
  assert.deepEqual(review.missingOn, ['claude', 'github', 'codex', 'opencode']);
  const claude = report.platforms.find((p) => p.platform === 'claude');
  assert.equal(claude.ready, 1);
  assert.equal(claude.unverified, 1);
  assert.equal(claude.installed, 0);
  assert.equal(claude.missing, 2);
  assert.ok(report.topFindings.some((f) => f.code === 'V15-COMPAT-UNKNOWN'));
  assert.equal(isAuditCleanV15(report), true);
  assert.match(formatAuditReportV15(report), /2 skill\(s\): 2 valid, 0 invalid/);
  assert.match(formatAuditReportV15(report), /average quality 98.5\/100/);
  const saved = saveAuditReportV15(report);
  assert.equal(saved, path.join(dir, '.agents', 'skills-v15-audit.json'));
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).total, 2);
});

test('auditProjectSkillsV15: empty project + invalid skill reported, not hidden', (t) => {
  const dir = tmpDir(t);
  const home = path.join(dir, 'fake-home');
  fs.mkdirSync(home, { recursive: true });
  const empty = auditProjectSkillsV15({ projectRoot: dir, homeDir: home });
  assert.equal(empty.total, 0);
  assert.equal(empty.averageQuality, 0);
  assert.equal(isAuditCleanV15(empty), true);
  assert.match(formatAuditReportV15(empty), /No skills installed/);

  // Invalid skill: header loads fine (name matches, description has a
  // when-cue) but the body references a script that does not exist —
  // the v15 layer catches what the tier-1 header load cannot see.
  const bad = path.join(dir, '.agents', 'skills', 'bad-skill');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(
    path.join(bad, 'SKILL.md'),
    '---\nname: bad-skill\ndescription: Does a thing. Use when a thing is needed.\n---\n\nRun scripts/check.sh first.\n',
    'utf8',
  );
  const report = auditProjectSkillsV15({ projectRoot: dir, homeDir: home });
  assert.equal(report.total, 1);
  assert.equal(report.invalid, 1);
  assert.equal(report.skills[0].valid, false);
  assert.match(report.skills[0].firstError, /V15-SCRIPT-REF-MISSING/);
  assert.equal(report.skills[0].readiness.claude, 'blocked');
  assert.equal(isAuditCleanV15(report), false);
});

// --- Pack -------------------------------------------------------------------

test('isPackNameV15 + createSkillPackV15: manifest, checksums, sorted skills', (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src');
  const a = writeSkill(src, 'review-pr', 'claude; opencode');
  const b = writeSkill(src, 'plain-notes', undefined);
  assert.equal(isPackNameV15('team-starter'), true);
  assert.equal(isPackNameV15('Team_Starter'), false);
  const packDir = path.join(dir, 'pack');
  const result = createSkillPackV15([b, a], 'team-starter', { description: 'Starter kit for the team.', outDir: packDir });
  assert.equal(result.packDir, packDir);
  assert.equal(result.manifest.format, 'openbot-skills-v15-pack/1');
  assert.equal(result.manifest.skills.length, 2);
  assert.deepEqual(result.manifest.skills.map((s) => s.name), ['plain-notes', 'review-pr']);
  assert.equal(result.manifest.skills[1].compatibility, 'claude; opencode');
  assert.equal(result.manifest.skills[0].compatibility, undefined);
  assert.ok(fs.existsSync(path.join(packDir, 'skills-pack.json')));
  assert.ok(fs.existsSync(path.join(packDir, 'review-pr', 'SKILL.md')));
  assert.deepEqual(listPackSkillsV15(packDir), ['plain-notes', 'review-pr']);
  const { problems } = verifySkillPackV15(packDir);
  assert.deepEqual(problems, []);
});

test('createSkillPackV15: refuses invalid skill, duplicate names, empty pack, bad name', (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src');
  const good = writeSkill(src, 'review-pr', 'claude');
  const bad = path.join(src, 'bad-skill');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: wrong\ndescription: x\n---\n\nb\n', 'utf8');
  assert.throws(() => createSkillPackV15([good, bad], 'team-starter', { description: 'x' }), /Cannot pack invalid skill/);
  assert.throws(() => createSkillPackV15([good, good], 'team-starter', { description: 'x' }), /two skills named/);
  assert.throws(() => createSkillPackV15([], 'team-starter', { description: 'x' }), /empty pack/);
  assert.throws(() => createSkillPackV15([good], 'Team_Starter', { description: 'x' }), /not valid/);
  assert.throws(() => createSkillPackV15([good], 'team-starter', { description: '  ' }), /must not be empty/);
  assert.throws(() => readPackManifestV15(path.join(dir, 'nope')), /not a v15 skill pack/);
});

test('verifySkillPackV15: tampered SKILL.md + unlisted dir reported', (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src');
  writeSkill(src, 'review-pr', 'claude');
  const packDir = path.join(dir, 'pack');
  createSkillPackV15([path.join(src, 'review-pr')], 'team-starter', { description: 'x', outDir: packDir });
  fs.appendFileSync(path.join(packDir, 'review-pr', 'SKILL.md'), '\nTampered.\n');
  const extra = path.join(packDir, 'sneaky-skill');
  fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, 'SKILL.md'), '---\nname: sneaky-skill\ndescription: Sneaky. Use when sneaking.\n---\n\nx\n', 'utf8');
  const { problems } = verifySkillPackV15(packDir);
  assert.ok(problems.some((p) => p.includes('Checksum mismatch: review-pr/SKILL.md')));
  assert.ok(problems.some((p) => p.includes('Unlisted skill directory in pack: sneaky-skill/')));
});

test('installSkillPackV15: installs all, skips existing, mirrors on request', (t) => {
  const dir = tmpDir(t);
  const home = path.join(dir, 'fake-home');
  fs.mkdirSync(home, { recursive: true });
  const src = path.join(dir, 'src');
  writeSkill(src, 'review-pr', 'claude; opencode');
  writeSkill(src, 'plain-notes', undefined);
  const packDir = path.join(dir, 'pack');
  createSkillPackV15([path.join(src, 'review-pr'), path.join(src, 'plain-notes')], 'team-starter', {
    description: 'Starter kit.',
    outDir: packDir,
  });
  const result = installSkillPackV15(packDir, { projectRoot: dir, homeDir: home, mirrorAfterInstall: true });
  assert.equal(result.packName, 'team-starter');
  assert.equal(result.installed, 2);
  assert.equal(result.skipped, 0);
  assert.ok(result.skills.every((s) => s.installed && s.mirrors.length === 4));
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'review-pr', 'SKILL.md')));
  assert.match(formatPackInstallResultV15(result), /2 skill\(s\) installed, 0 skipped/);
  // Second install without overwrite skips both.
  const again = installSkillPackV15(packDir, { projectRoot: dir, homeDir: home });
  assert.equal(again.installed, 0);
  assert.equal(again.skipped, 2);
  // With overwrite it replaces.
  const third = installSkillPackV15(packDir, { projectRoot: dir, homeDir: home, overwrite: true });
  assert.equal(third.installed, 2);
  assert.ok(third.skills.every((s) => s.overwritten));
});

test('installSkillPackV15: dirty pack installs nothing', (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src');
  writeSkill(src, 'review-pr', 'claude');
  const packDir = path.join(dir, 'pack');
  createSkillPackV15([path.join(src, 'review-pr')], 'team-starter', { description: 'x', outDir: packDir });
  fs.appendFileSync(path.join(packDir, 'review-pr', 'SKILL.md'), '\nTampered.\n');
  assert.throws(() => installSkillPackV15(packDir, { projectRoot: dir }), /Checksum mismatch/);
  assert.equal(fs.existsSync(path.join(dir, '.agents', 'skills', 'review-pr')), false);
});

// --- Export plan ------------------------------------------------------------

test('planMultiPlatformExportV15: fresh skill plans creates, then skips', (t) => {
  const dir = tmpDir(t);
  const src = writeSkill(path.join(dir, 'src'), 'review-pr', 'claude; opencode');
  const plan = planMultiPlatformExportV15(src, { projectRoot: dir });
  assert.equal(plan.skill, 'review-pr');
  assert.equal(plan.applicable, true);
  assert.equal(plan.blockedByValidation, false);
  assert.equal(plan.validationQuality, 100);
  assert.deepEqual(plan.steps.map((s) => s.action), ['create', 'create', 'create', 'create', 'create']);
  assert.equal(plan.totalFiles, 5);
  assert.match(formatExportPlanV15(plan), /Plan is applicable/);
  const applied = applyExportPlanV15(plan);
  assert.equal(applied.mirrors.length, 4);
  const again = planMultiPlatformExportV15(src, { projectRoot: dir });
  assert.deepEqual(again.steps.map((s) => s.action), ['blocked', 'skip', 'skip', 'skip', 'skip']);
  // Canonical already exists and overwrite is off: the canonical step blocks.
  assert.equal(again.applicable, false);
  assert.equal(isPlanApplicableV15(again), false);
  assert.throws(() => applyExportPlanV15(again), /Cannot apply export plan/);
});

test('planMultiPlatformExportV15: unsupported platform blocked, drifted copy warns', (t) => {
  const dir = tmpDir(t);
  const src = writeSkill(path.join(dir, 'src'), 'review-pr', 'not supported on codex');
  const plan = planMultiPlatformExportV15(src, { projectRoot: dir });
  const codex = plan.steps.find((s) => s.platform === 'codex');
  assert.equal(codex.action, 'blocked');
  assert.match(codex.reason, /not supported/);
  assert.equal(plan.applicable, false);
  // Drifted copy: plan with overwrite=false blocks, with overwrite=true replaces (with warning).
  const dir2 = tmpDir(t);
  const src2 = writeSkill(path.join(dir2, 'src'), 'review-pr', 'claude');
  const first = planMultiPlatformExportV15(src2, { projectRoot: dir2, platforms: ['claude'] });
  applyExportPlanV15(first);
  fs.appendFileSync(path.join(dir2, '.claude', 'skills', 'review-pr', 'SKILL.md'), '\nDrift.\n');
  const blocked = planMultiPlatformExportV15(path.join(dir2, '.agents', 'skills', 'review-pr'), {
    projectRoot: dir2,
    platforms: ['claude'],
  });
  const step = blocked.steps.find((s) => s.platform === 'claude');
  assert.equal(step.action, 'blocked');
  const replacing = planMultiPlatformExportV15(path.join(dir2, '.agents', 'skills', 'review-pr'), {
    projectRoot: dir2,
    platforms: ['claude'],
    overwrite: true,
  });
  const step2 = replacing.steps.find((s) => s.platform === 'claude');
  assert.equal(step2.action, 'replace');
  assert.ok(step2.warnings.some((w) => w.includes('throws away its edits')));
});

test('planMultiPlatformExportV15: invalid skill blocks everything', (t) => {
  const dir = tmpDir(t);
  const bad = path.join(dir, 'src', 'bad-skill');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: wrong\ndescription: x\n---\n\nb\n', 'utf8');
  const plan = planMultiPlatformExportV15(bad, { projectRoot: dir });
  assert.equal(plan.blockedByValidation, true);
  assert.equal(plan.applicable, false);
  assert.equal(plan.steps[0].action, 'blocked');
  assert.throws(() => planMultiPlatformExportV15(path.join(dir, 'nope'), { projectRoot: dir }), /not a directory/);
});

// --- Tools (audit / pack / plan) -------------------------------------------

function toolsFor(projectRoot, home) {
  const tools = createSkillsV15Tools({ getProjectRoot: () => projectRoot, getHomeDir: () => home });
  return new Map(tools.map((tool) => [tool.definition.name, tool]));
}

test('skills_v15 tools: audit + pack + export-plan end to end', async (t) => {
  const dir = tmpDir(t);
  const home = path.join(dir, 'fake-home');
  fs.mkdirSync(home, { recursive: true });
  const src = path.join(dir, 'src');
  const a = writeSkill(src, 'review-pr', 'claude; opencode');
  writeSkill(src, 'plain-notes', undefined);
  const byName = toolsFor(dir, home);
  const plan = await byName.get('skills_v15_export_plan').execute({ skillDir: a });
  assert.match(plan, /Export plan for "review-pr"/);
  assert.match(plan, /Plan is applicable/);
  const auditBefore = await byName.get('skills_v15_audit').execute({});
  assert.match(auditBefore, /0 skill\(s\): 0 valid/);
  const packDir = path.join(dir, 'team.skills-pack');
  const created = await byName.get('skills_v15_pack_create').execute({
    skillDirs: `${a},${path.join(src, 'plain-notes')}`,
    name: 'team-starter',
    description: 'Starter kit.',
    outDir: packDir,
  });
  assert.match(created, /Đã tạo pack "team-starter"/);
  const verified = await byName.get('skills_v15_pack_verify').execute({ packDir });
  assert.match(verified, /sạch: 2 skill/);
  const installed = await byName.get('skills_v15_pack_install').execute({ packDir, mirrorAfterInstall: true });
  assert.match(installed, /2 skill\(s\) installed, 0 skipped/);
  const auditAfter = await byName.get('skills_v15_audit').execute({});
  assert.match(auditAfter, /2 skill\(s\): 2 valid, 0 invalid/);
  assert.match(auditAfter, /average quality 98.5\/100/);
  const installedAgain = await byName.get('skills_v15_pack_install').execute({ packDir });
  assert.match(installedAgain, /0 skill\(s\) installed, 2 skipped/);
});
