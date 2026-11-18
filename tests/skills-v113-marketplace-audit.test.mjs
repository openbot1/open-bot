/**
 * Tests cho v1.13 (Đội T1): Agent Skills loader v13 — local marketplace
 * + audits (tool-budget, context-tax, waste report).
 *
 * Mọi skill mẫu trong file này đều do đội T1 tự viết cho test (nội dung
 * gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-v113-marketplace-audit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  browseLocalMarketplace,
  checkLocalUpgrades,
  compareSemver,
  installLocalSkill,
  installedSkillVersion,
  parseSkillManifest,
  searchLocalMarketplace,
  uninstallLocalSkill,
} from '../packages/core/dist/skills/v13/localMarketplace.js';
import {
  auditContextTax,
  auditToolBudget,
  buildWasteReport,
  estimateTokensV13,
  formatWasteReport,
} from '../packages/core/dist/skills/v13/audit.js';
import { SkillSessionIndex } from '../packages/core/dist/skills/v13/sessionIndex.js';
import { parseSkillMarkdown } from '../packages/core/dist/skills/loader.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMarketSkill(market, name, { version = '1.0.0', manifest = true, body = 'Do the thing well.\n' } = {}) {
  const dir = path.join(market, name);
  fs.mkdirSync(dir, { recursive: true });
  const skillMd = `---\nname: ${name}\ndescription: Use when the user asks to ${name.replace(/-/g, ' ')} something.\nversion: ${version}\nlicense: MIT\n---\n# ${name}\n\n${body}`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf8');
  if (manifest) {
    fs.writeFileSync(
      path.join(dir, 'skill.json'),
      JSON.stringify(
        { name, version, description: `Use when the user asks to ${name.replace(/-/g, ' ')} something.`, author: 'test-team', license: 'MIT', tags: ['test', name] },
        null,
        2,
      ),
      'utf8',
    );
  }
  return dir;
}

// --- compareSemver ----------------------------------------------------------

test('marketplace: compareSemver đúng thứ tự, pre-release < release', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
  assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareSemver('not-semver', '1.0.0'), -1);
  assert.equal(compareSemver('not-semver', 'also-bad'), 0);
});

// --- Manifest ---------------------------------------------------------------

test('marketplace: parseSkillManifest hợp lệ; sai tên/version → errors', () => {
  const market = tmpDir('open-bot-skills-v113-manifest-');
  const dir = writeMarketSkill(market, 'note-taker');
  const skill = parseSkillMarkdown(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), 'user');
  const good = parseSkillManifest(path.join(dir, 'skill.json'), skill);
  assert.deepEqual(good.errors, []);
  assert.equal(good.manifest.version, '1.0.0');
  assert.deepEqual(good.manifest.tags, ['test', 'note-taker']);

  // Manifest sai tên.
  const badName = path.join(market, 'bad-name.json');
  fs.writeFileSync(badName, JSON.stringify({ name: 'other-name', version: '1.0.0', description: 'x' }), 'utf8');
  const bad = parseSkillManifest(badName, skill);
  assert.ok(bad.errors.some((e) => e.includes('does not match SKILL.md')));

  // Manifest không phải JSON.
  const badJson = path.join(market, 'bad.json');
  fs.writeFileSync(badJson, '{not json', 'utf8');
  const bad2 = parseSkillManifest(badJson, skill);
  assert.equal(bad2.manifest, null);
  assert.ok(bad2.errors.length > 0);

  // Manifest version lệch SKILL.md → warning, không lỗi.
  const skew = path.join(market, 'skew.json');
  fs.writeFileSync(
    skew,
    JSON.stringify({ name: 'note-taker', version: '2.0.0', description: skill.description }),
    'utf8',
  );
  const skewed = parseSkillManifest(skew, skill);
  assert.deepEqual(skewed.errors, []);
  assert.ok(skewed.warnings.length > 0);

  // Tag viết hoa → lỗi.
  const badTag = path.join(market, 'bad-tag.json');
  fs.writeFileSync(
    badTag,
    JSON.stringify({ name: 'note-taker', version: '1.0.0', description: skill.description, tags: ['BadTag'] }),
    'utf8',
  );
  const bad3 = parseSkillManifest(badTag, skill);
  assert.ok(bad3.errors.some((e) => e.includes('lowercase')));
});

// --- Browse / search ---------------------------------------------------------

test('marketplace: browse liệt kê đủ entry, installable, sắp xếp theo tên', () => {
  const market = tmpDir('open-bot-skills-v113-browse-');
  writeMarketSkill(market, 'note-taker');
  writeMarketSkill(market, 'quick-note', { version: '1.2.0' });
  fs.mkdirSync(path.join(market, 'empty-dir'), { recursive: true });
  const { entries, errors } = browseLocalMarketplace(market);
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => e.name), ['note-taker', 'quick-note']);
  assert.ok(entries.every((e) => e.installable));
  assert.ok(entries.every((e) => e.hasManifest));
  assert.equal(entries[1].version, '1.2.0');
  assert.deepEqual(searchLocalMarketplace(entries, 'quick'), [entries[1]]);
  assert.equal(searchLocalMarketplace(entries, 'NOTE').length, 2); // khớp tên + mô tả, không phân biệt hoa thường
});

test('marketplace: browse skill không manifest vẫn installable; minOpenBotVersion mới hơn → incompatible', () => {
  const market = tmpDir('open-bot-skills-v113-nomanifest-');
  writeMarketSkill(market, 'plain-skill', { manifest: false });
  const dir = writeMarketSkill(market, 'future-skill', { manifest: false });
  fs.writeFileSync(
    path.join(dir, 'skill.json'),
    JSON.stringify({
      name: 'future-skill',
      version: '1.0.0',
      description: 'Use when the user asks to future skill something.',
      minOpenBotVersion: '99.0.0',
    }),
    'utf8',
  );
  const { entries } = browseLocalMarketplace(market);
  const plain = entries.find((e) => e.name === 'plain-skill');
  assert.equal(plain.hasManifest, false);
  assert.equal(plain.installable, true);
  const future = entries.find((e) => e.name === 'future-skill');
  assert.equal(future.incompatible, true);
  assert.equal(future.installable, false);
});

test('marketplace: browse thư mục không tồn tại → rỗng', () => {
  const { entries, errors } = browseLocalMarketplace(path.join(os.tmpdir(), 'open-bot-no-market-v113'));
  assert.deepEqual(entries, []);
  assert.deepEqual(errors, []);
});

// --- Install / uninstall / upgrade --------------------------------------------

test('marketplace: install → installedSkillVersion đọc lại đúng; cài lại không overwrite → lỗi', () => {
  const market = tmpDir('open-bot-skills-v113-install-');
  const dir = writeMarketSkill(market, 'note-taker', { version: '1.1.0' });
  const skillsDir = tmpDir('open-bot-skills-v113-installed2-');
  const result = installLocalSkill(dir, skillsDir);
  assert.equal(result.name, 'note-taker');
  assert.equal(result.version, '1.1.0');
  assert.equal(result.filesCopied, 2); // SKILL.md + skill.json
  assert.equal(installedSkillVersion(skillsDir, 'note-taker'), '1.1.0');
  assert.throws(() => installLocalSkill(dir, skillsDir), /already installed/);
  const again = installLocalSkill(dir, skillsDir, { overwrite: true });
  assert.equal(again.replacedVersion, '1.1.0');
});

test('marketplace: upgrade chỉ khi marketplace mới hơn; checkLocalUpgrades tìm đúng', () => {
  const market = tmpDir('open-bot-skills-v113-upgrade-');
  const skillsDir = tmpDir('open-bot-skills-v113-upgrade-inst-');
  const v1 = writeMarketSkill(market, 'note-taker', { version: '1.0.0' });
  installLocalSkill(v1, skillsDir);
  // Marketplace vẫn 1.0.0 → upgrade từ chối.
  assert.throws(() => installLocalSkill(v1, skillsDir, { upgrade: true }), /nothing to upgrade/);
  // Marketplace lên 1.1.0 → upgrade được, checkLocalUpgrades thấy trước đó.
  const market2 = tmpDir('open-bot-skills-v113-upgrade2-');
  const v2 = writeMarketSkill(market2, 'note-taker', { version: '1.1.0' });
  const upgrades = checkLocalUpgrades(market2, skillsDir);
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].availableVersion, '1.1.0');
  assert.equal(upgrades[0].installedVersion, '1.0.0');
  const upgraded = installLocalSkill(v2, skillsDir, { upgrade: true });
  assert.equal(upgraded.version, '1.1.0');
  assert.equal(upgraded.replacedVersion, '1.0.0');
  assert.deepEqual(checkLocalUpgrades(market2, skillsDir), []);
});

test('marketplace: uninstall xóa đúng skill; gỡ skill chưa cài → lỗi; không xóa thư mục lạ', () => {
  const market = tmpDir('open-bot-skills-v113-uninstall-');
  const dir = writeMarketSkill(market, 'note-taker');
  const skillsDir = tmpDir('open-bot-skills-v113-uninstall-inst-');
  installLocalSkill(dir, skillsDir);
  const removed = uninstallLocalSkill(skillsDir, 'note-taker');
  assert.equal(removed, path.join(skillsDir, 'note-taker'));
  assert.equal(fs.existsSync(removed), false);
  assert.equal(installedSkillVersion(skillsDir, 'note-taker'), null);
  assert.throws(() => uninstallLocalSkill(skillsDir, 'note-taker'), /not installed/);
  assert.throws(() => uninstallLocalSkill(skillsDir, 'Bad Name'), /Invalid skill name/);
  // Thư mục không có SKILL.md → không xóa.
  fs.mkdirSync(path.join(skillsDir, 'random-folder'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'random-folder', 'x.txt'), 'x', 'utf8');
  assert.throws(() => uninstallLocalSkill(skillsDir, 'random-folder'), /not installed/);
  assert.equal(fs.existsSync(path.join(skillsDir, 'random-folder', 'x.txt')), true);
});

test('marketplace: install skill lỗi v13 → throw, không copy gì', () => {
  const market = tmpDir('open-bot-skills-v113-badinstall-');
  const dir = path.join(market, 'bad-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: bad-skill\ndescription: A plain label.\n---\n# Bad\n\nBody.\n',
    'utf8',
  );
  const skillsDir = tmpDir('open-bot-skills-v113-badinstall-inst-');
  assert.throws(() => installLocalSkill(dir, skillsDir), /fails v13 validation/);
  assert.equal(fs.existsSync(path.join(skillsDir, 'bad-skill')), false);
});

// --- Tool-budget audit ----------------------------------------------------------

const RECORDS = [
  { skillName: 'note-review', toolName: 'read_file' },
  { skillName: 'note-review', toolName: 'read_file' },
  { skillName: 'note-review', toolName: 'grep_search' },
  { skillName: 'note-review', toolName: 'read_file', error: true },
  { skillName: 'quick-note', toolName: 'write_file' },
  { skillName: '(none)', toolName: 'shell_exec' },
];

test('audit: auditToolBudget đếm đúng theo skill/tool, lỗi tính riêng', () => {
  const audit = auditToolBudget(RECORDS, { maxCallsPerSkill: 3 });
  assert.equal(audit.totalCalls, 6);
  assert.equal(audit.totalErrors, 1);
  assert.equal(audit.unskilledCalls, 1);
  const review = audit.skills.find((s) => s.skillName === 'note-review');
  assert.equal(review.totalCalls, 4);
  assert.equal(review.errorCalls, 1);
  assert.equal(review.byTool[0].toolName, 'read_file');
  assert.equal(review.byTool[0].calls, 3);
  assert.equal(review.topTool.toolName, 'read_file');
  assert.equal(review.topTool.share, 0.75);
  assert.equal(review.overBudget, true); // 4 > 3
  assert.equal(review.hasDominantTool, false); // share 0.75 < 0.8
  assert.equal(review.errorProne, false); // 1/4 = 0.25, không vượt 0.25
  assert.deepEqual(audit.overBudget, ['note-review']);
  assert.deepEqual(audit.skills.map((s) => s.skillName), ['note-review', 'quick-note']);
});

test('audit: dominant tool + error-prone được flag đúng ngưỡng', () => {
  const records = [];
  for (let i = 0; i < 45; i++) records.push({ skillName: 'one-tool', toolName: 'shell_exec' });
  for (let i = 0; i < 5; i++) records.push({ skillName: 'one-tool', toolName: 'read_file' });
  for (let i = 0; i < 4; i++) records.push({ skillName: 'flaky', toolName: 'web_fetch', error: i < 2 });
  const audit = auditToolBudget(records);
  const one = audit.skills.find((s) => s.skillName === 'one-tool');
  assert.equal(one.hasDominantTool, true); // 45/50 = 0.9, >= 40 calls
  assert.deepEqual(audit.dominantToolSkills, ['one-tool']);
  const flaky = audit.skills.find((s) => s.skillName === 'flaky');
  assert.equal(flaky.errorProne, true); // 2/4 = 0.5 > 0.25
  assert.deepEqual(audit.errorProneSkills, ['flaky']);
});

test('audit: log rỗng → audit rỗng, không crash', () => {
  const audit = auditToolBudget([]);
  assert.equal(audit.totalCalls, 0);
  assert.deepEqual(audit.skills, []);
  assert.deepEqual(audit.overBudget, []);
});

// --- Context-tax audit -----------------------------------------------------------

function sessionEntries() {
  const root = tmpDir('open-bot-skills-v113-tax-');
  for (const [name, desc] of [
    ['note-review', 'Use when the user asks to review notes before sharing them.'],
    ['quick-note', 'Use when the user wants a quick note taken right now.'],
  ]) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n\nDo the thing.\n`,
      'utf8',
    );
  }
  const index = SkillSessionIndex.open([root]);
  index.ensureBody('note-review');
  return index.entries;
}

test('audit: auditContextTax — skill kích hoạt không lãng phí, skill chưa kích hoạt lãng phí header', () => {
  const entries = sessionEntries();
  const audit = auditContextTax(entries, { 'note-review': 2 }, { 'note-review': 40 });
  assert.equal(audit.skills.length, 2);
  const review = audit.skills.find((s) => s.name === 'note-review');
  assert.equal(review.activated, true);
  assert.equal(review.activations, 2);
  assert.equal(review.bodyTokens, 40);
  assert.equal(review.wastedHeaderTokens, 0);
  const quick = audit.skills.find((s) => s.name === 'quick-note');
  assert.equal(quick.activated, false);
  assert.equal(quick.bodyTokens, 0);
  assert.equal(quick.wastedHeaderTokens, quick.headerTokens);
  assert.deepEqual(audit.neverActivated, ['quick-note']);
  assert.equal(audit.wastedHeaderTokens, quick.headerTokens);
  assert.ok(audit.totalTokens > audit.totalHeaderTokens);
});

test('audit: body quá lớn được flag bodyTooBig', () => {
  const entries = sessionEntries();
  const audit = auditContextTax(entries, { 'note-review': 1 }, { 'note-review': 5000 }, { maxBodyTokens: 100 });
  assert.deepEqual(audit.bodyTooBig, ['note-review']);
});

test('audit: estimateTokensV13 ≈ chars/4', () => {
  assert.equal(estimateTokensV13('a'.repeat(40)), 10);
  assert.equal(estimateTokensV13(''), 0);
});

// --- Waste report -----------------------------------------------------------------

test('audit: buildWasteReport xếp hạng lãng phí + khuyến nghị cụ thể', () => {
  const entries = sessionEntries();
  const records = [
    { skillName: 'note-review', toolName: 'read_file' },
    { skillName: 'note-review', toolName: 'read_file' },
    { skillName: 'note-review', toolName: 'read_file' },
    { skillName: 'note-review', toolName: 'read_file' },
  ];
  const report = buildWasteReport('test-session', records, entries, { 'note-review': 1 }, {}, { maxCallsPerSkill: 3 });
  assert.equal(report.sessionLabel, 'test-session');
  assert.ok(report.rankedWaste.some((w) => w.skillName === 'quick-note' && w.kind === 'never-activated'));
  assert.ok(report.rankedWaste.some((w) => w.skillName === 'note-review' && w.kind === 'over-tool-budget'));
  assert.ok(report.recommendations.some((r) => r.includes('quick-note')));
  assert.ok(report.recommendations.some((r) => r.includes('note-review')));
  const md = formatWasteReport(report);
  assert.match(md, /# Skill waste report — test-session/);
  assert.match(md, /## Tool usage per skill/);
  assert.match(md, /## Context tax per skill/);
  assert.match(md, /## Waste, ranked/);
  assert.match(md, /## Recommendations/);
  assert.match(md, /never-activated/);
});

test('audit: buildWasteReport sạch → khuyến nghị "No waste found"', () => {
  const entries = sessionEntries();
  const report = buildWasteReport('clean-session', [], entries, { 'note-review': 1, 'quick-note': 1 }, {});
  assert.deepEqual(report.rankedWaste, []);
  assert.deepEqual(report.recommendations, ['No waste found — tool budgets and context tax are within limits.']);
});

test('audit: skill trong log nhưng không có trong index → ghi vào waste', () => {
  const entries = sessionEntries();
  const report = buildWasteReport(
    'ghost-session',
    [{ skillName: 'ghost-skill', toolName: 'read_file' }],
    entries,
    {},
  );
  assert.ok(
    report.rankedWaste.some((w) => w.skillName === 'ghost-skill' && w.detail.includes('not in the session index')),
  );
});
