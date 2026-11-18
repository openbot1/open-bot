/**
 * Tests cho v1.36 (Đội T2): Agent Skills v15 — multi-platform
 * import/export + mirror sync.
 *
 * Mọi skill mẫu trong file này đều do đội T2 tự viết cho test (nội
 * dung gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-v15-multiplatform.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  detectSourcePlatformV15,
  diffSkillDirsV15,
  exportSkillMultiPlatformV15,
  formatMultiStatusV15,
  importSkillFromPlatformV15,
  isOverwriteNeededV15,
  listPlatformInstallsV15,
  multiPlatformStatusV15,
  removeSkillFromPlatformV15,
} from '../packages/core/dist/skills/v15/multiPlatform.js';
import {
  checkMirrorSyncV15,
  driftRepairPlanV15,
  formatSyncReportV15,
  repairMirrorSyncV15,
} from '../packages/core/dist/skills/v15/sync.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-v15-mp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(parent, name, extra = '') {
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
      extra,
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

test('exportSkillMultiPlatformV15: canonical + copy mirrors on all 4 hosts', (t) => {
  const dir = tmpDir(t);
  const src = writeSkill(path.join(dir, 'src'), 'review-pr');
  const result = exportSkillMultiPlatformV15(src, { projectRoot: dir });
  assert.equal(result.name, 'review-pr');
  assert.equal(result.canonicalDir, path.join(dir, '.agents', 'skills', 'review-pr'));
  assert.equal(result.mirrors.length, 4);
  assert.deepEqual(result.skipped, []);
  assert.ok(result.validationQuality > 0);
  for (const mirror of result.mirrors) {
    assert.equal(mirror.mode, 'copy');
    assert.ok(fs.existsSync(path.join(mirror.dir, 'SKILL.md')));
    assert.ok(mirror.fileCount >= 1);
  }
  const status = multiPlatformStatusV15('review-pr', { projectRoot: dir });
  assert.deepEqual(status.installedOn, ['openbot', 'claude', 'github', 'codex', 'opencode']);
  assert.deepEqual(status.missingOn, []);
  assert.deepEqual(status.staleOn, []);
  assert.match(formatMultiStatusV15(status), /Installed on: openbot, claude, github, codex, opencode/);
});

test('exportSkillMultiPlatformV15: symlink mirrors point at canonical, skip without overwrite', (t) => {
  const dir = tmpDir(t);
  const src = writeSkill(path.join(dir, 'src'), 'review-pr');
  const first = exportSkillMultiPlatformV15(src, { projectRoot: dir, mode: 'symlink' });
  assert.ok(first.mirrors.every((m) => m.mode === 'symlink' && m.fileCount === 0));
  const claudeDir = path.join(dir, '.claude', 'skills', 'review-pr');
  assert.equal(fs.lstatSync(claudeDir).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(claudeDir), path.join(dir, '.agents', 'skills', 'review-pr'));
  // Second export without overwrite: canonical exists -> throws before mirrors.
  assert.throws(() => exportSkillMultiPlatformV15(src, { projectRoot: dir, mode: 'symlink' }), /already exists/);
  // Overwrite replaces mirrors.
  const again = exportSkillMultiPlatformV15(src, { projectRoot: dir, mode: 'symlink', overwrite: true });
  assert.ok(again.mirrors.every((m) => m.replaced === true));
});

test('exportSkillMultiPlatformV15: partial platforms + existing mirror skipped', (t) => {
  const dir = tmpDir(t);
  const src = writeSkill(path.join(dir, 'src'), 'review-pr');
  const result = exportSkillMultiPlatformV15(src, { projectRoot: dir, platforms: ['claude'] });
  assert.equal(result.mirrors.length, 1);
  assert.equal(result.mirrors[0].platform, 'claude');
  assert.deepEqual(listPlatformInstallsV15('claude', { projectRoot: dir }), ['review-pr']);
  assert.deepEqual(listPlatformInstallsV15('github', { projectRoot: dir }), []);
  // Mirror to claude again from the canonical dir: skipped, not overwritten.
  const canonical = path.join(dir, '.agents', 'skills', 'review-pr');
  const second = exportSkillMultiPlatformV15(canonical, { projectRoot: dir, platforms: ['claude', 'github'] });
  assert.deepEqual(second.skipped, ['claude']);
  assert.equal(second.mirrors.length, 1);
  assert.equal(second.mirrors[0].platform, 'github');
});

test('exportSkillMultiPlatformV15: invalid skill is refused', (t) => {
  const dir = tmpDir(t);
  const bad = path.join(dir, 'src', 'bad-skill');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: wrong-name\ndescription: x\n---\n\nbody\n', 'utf8');
  assert.throws(() => exportSkillMultiPlatformV15(bad, { projectRoot: dir }), /Cannot export invalid skill/);
  assert.equal(fs.existsSync(path.join(dir, '.agents', 'skills', 'bad-skill')), false);
});

test('multiPlatformStatusV15: missing, stale-copy and broken-link states', (t) => {
  const dir = tmpDir(t);
  const src = writeSkill(path.join(dir, 'src'), 'review-pr');
  const empty = multiPlatformStatusV15('review-pr', { projectRoot: dir });
  assert.deepEqual(empty.installedOn, []);
  assert.equal(empty.missingOn.length, 5);
  // Symlink mirror for claude (breakable), copy mirror for github (driftable).
  exportSkillMultiPlatformV15(src, { projectRoot: dir, mode: 'symlink', platforms: ['claude'] });
  const canonical = path.join(dir, '.agents', 'skills', 'review-pr');
  exportSkillMultiPlatformV15(canonical, { projectRoot: dir, mode: 'copy', platforms: ['github'] });
  // Break the claude link by moving canonical away, then restore.
  fs.renameSync(canonical, path.join(dir, '.agents', 'skills', 'review-pr-moved'));
  const broken = multiPlatformStatusV15('review-pr', { projectRoot: dir });
  const claudeInstall = broken.installs.find((i) => i.platform === 'claude');
  assert.equal(claudeInstall.state, 'broken-link');
  fs.renameSync(path.join(dir, '.agents', 'skills', 'review-pr-moved'), canonical);
  // Edit the github COPY -> stale-copy (a symlink edit would follow the
  // link and change the canonical file instead, so this must be a copy).
  fs.appendFileSync(path.join(dir, '.github', 'skills', 'review-pr', 'SKILL.md'), '\nExtra line.\n');
  const stale = multiPlatformStatusV15('review-pr', { projectRoot: dir });
  assert.deepEqual(stale.staleOn, ['github']);
  assert.equal(stale.installs.find((i) => i.platform === 'github').state, 'stale-copy');
  // diffSkillDirsV15 spots the differing file.
  assert.deepEqual(diffSkillDirsV15(canonical, path.join(dir, '.github', 'skills', 'review-pr')), ['SKILL.md']);
});

test('importSkillFromPlatformV15: from claude root, overwrite confirm, mirror after import', (t) => {
  const dir = tmpDir(t);
  const claudeRoot = path.join(dir, '.claude', 'skills');
  const src = writeSkill(claudeRoot, 'review-pr');
  assert.equal(detectSourcePlatformV15(src, { projectRoot: dir }), 'claude');
  const result = importSkillFromPlatformV15(src, { projectRoot: dir, mirrorAfterImport: true });
  assert.equal(isOverwriteNeededV15(result), false);
  assert.equal(result.fromPlatform, 'claude');
  assert.equal(result.canonicalDir, path.join(dir, '.agents', 'skills', 'review-pr'));
  assert.equal(result.mirrors.length, 4);
  assert.equal(result.overwritten, false);
  // Second import without overwrite returns the confirmation shape and writes nothing.
  const again = importSkillFromPlatformV15(src, { projectRoot: dir });
  assert.equal(isOverwriteNeededV15(again), true);
  assert.equal(again.name, 'review-pr');
  // With overwrite it replaces.
  const third = importSkillFromPlatformV15(src, { projectRoot: dir, overwrite: true });
  assert.equal(isOverwriteNeededV15(third), false);
  assert.equal(third.overwritten, true);
});

test('importSkillFromPlatformV15: invalid source is refused', (t) => {
  const dir = tmpDir(t);
  const bad = path.join(dir, '.claude', 'skills', 'bad-skill');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'SKILL.md'), 'no frontmatter here\n', 'utf8');
  assert.throws(() => importSkillFromPlatformV15(bad, { projectRoot: dir }), /Cannot import invalid skill/);
});

test('removeSkillFromPlatformV15: mirror removed, symlink unlinked not followed', (t) => {
  const dir = tmpDir(t);
  const src = writeSkill(path.join(dir, 'src'), 'review-pr');
  exportSkillMultiPlatformV15(src, { projectRoot: dir, mode: 'symlink' });
  assert.equal(removeSkillFromPlatformV15('review-pr', 'claude', { projectRoot: dir }), true);
  assert.equal(removeSkillFromPlatformV15('review-pr', 'claude', { projectRoot: dir }), false);
  // Canonical still intact after unlinking the symlink mirror.
  assert.ok(fs.existsSync(path.join(dir, '.agents', 'skills', 'review-pr', 'SKILL.md')));
  assert.equal(removeSkillFromPlatformV15('review-pr', 'openbot', { projectRoot: dir }), true);
  assert.equal(fs.existsSync(path.join(dir, '.agents', 'skills', 'review-pr')), false);
});

test('checkMirrorSyncV15 + repair: drifted copy repaired, hand-installed dir never touched', (t) => {
  const dir = tmpDir(t);
  const src = writeSkill(path.join(dir, 'src'), 'review-pr');
  exportSkillMultiPlatformV15(src, { projectRoot: dir, platforms: ['claude', 'github', 'codex'] });
  // Drift the github copy.
  fs.appendFileSync(path.join(dir, '.github', 'skills', 'review-pr', 'SKILL.md'), '\nDrift.\n');
  // Hand-install a DIFFERENT skill of the same name on opencode.
  const handDir = path.join(dir, '.opencode', 'skills', 'review-pr');
  fs.mkdirSync(handDir, { recursive: true });
  fs.writeFileSync(
    path.join(handDir, 'SKILL.md'),
    '---\nname: review-pr\ndescription: A totally different skill. Use when doing something else entirely.\n---\n\nDifferent body.\n',
    'utf8',
  );
  const drifts = checkMirrorSyncV15({ projectRoot: dir });
  const byKey = new Map(drifts.map((d) => [`${d.skill}@${d.platform}`, d.state]));
  assert.equal(byKey.get('review-pr@github'), 'drifted');
  assert.equal(byKey.get('review-pr@opencode'), 'not-a-mirror');
  const plan = driftRepairPlanV15(drifts.find((d) => d.platform === 'github'), path.join(dir, '.agents', 'skills', 'review-pr'));
  assert.deepEqual(plan, ['SKILL.md']);
  // Check-only report counts the drift.
  const checkOnly = repairMirrorSyncV15({ projectRoot: dir, repair: false });
  assert.equal(checkOnly.drifted, 1);
  assert.equal(checkOnly.checked, 4);
  assert.deepEqual(checkOnly.repaired, []);
  // Repair fixes the drifted copy but leaves the hand-installed dir alone.
  const repaired = repairMirrorSyncV15({ projectRoot: dir, repair: true });
  assert.deepEqual(repaired.repaired, ['review-pr@github']);
  assert.equal(repaired.drifts.length, 1);
  assert.equal(repaired.drifts[0].state, 'not-a-mirror');
  const handContent = fs.readFileSync(path.join(handDir, 'SKILL.md'), 'utf8');
  assert.match(handContent, /totally different skill/);
  assert.match(formatSyncReportV15(repaired), /Not repaired \(not a mirror/);
});
