/**
 * Tests cho v1.36 (Đội T2): Agent Skills v15 — platform table +
 * compatibility parsing + platform-aware validator.
 *
 * Mọi skill mẫu trong file này đều do đội T2 tự viết cho test (nội
 * dung gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-v15-platforms-validator.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkAllPlatformsV15,
  checkCompatibilityV15,
  describePlatformV15,
  formatPlatformsV15,
  hostReadRootsV15,
  hostSeesSkillV15,
  isPlatformIdV15,
  isPortableV15,
  parseCompatibilityEntryV15,
  parseCompatibilityV15,
  parsePlatformIdV15,
  platformRootV15,
} from '../packages/core/dist/skills/v15/platforms.js';
import {
  formatPlatformValidationSummaryV15,
  validateSkillForPlatformsV15,
  validateSkillTextForPlatformsV15,
} from '../packages/core/dist/skills/v15/validator.js';
import { SKILL_V15_PLATFORMS } from '../packages/core/dist/skills/v15/types.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-v15-pv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(dir, name, frontmatter, body = '# Body\n\nDo the thing.\n') {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`, 'utf8');
  return skillDir;
}

const CLEAN_FM = [
  'name: review-pr',
  'description: Reviews a pull request for bugs and style. Use when a pull request needs review before merging.',
  'license: MIT',
  'compatibility: claude; opencode',
].join('\n');

test('platform table: 5 platforms, canonical first, distinct roots', () => {
  assert.deepEqual([...SKILL_V15_PLATFORMS], ['openbot', 'claude', 'github', 'codex', 'opencode']);
  const root = platformRootV15('github', { projectRoot: '/proj' });
  assert.equal(root, path.join('/proj', '.github', 'skills'));
  assert.equal(platformRootV15('openbot', { projectRoot: '/proj' }), path.join('/proj', '.agents', 'skills'));
  assert.equal(platformRootV15('codex', { homeDir: '/home/u', global: true }), path.join('/home/u', '.codex', 'skills'));
  assert.match(describePlatformV15('github'), /GitHub Copilot/);
  assert.match(formatPlatformsV15({ projectRoot: '/proj' }), /\.opencode\/skills/);
});

test('parsePlatformIdV15 accepts aliases, rejects unknown hosts', () => {
  assert.equal(parsePlatformIdV15('claude-code'), 'claude');
  assert.equal(parsePlatformIdV15('Copilot'), 'github');
  assert.equal(parsePlatformIdV15('OPENBOT'), 'openbot');
  assert.equal(parsePlatformIdV15('cursor'), null);
  assert.equal(parsePlatformIdV15('vscode'), null);
  assert.equal(isPlatformIdV15('codex'), true);
  assert.equal(isPlatformIdV15('cursor'), false);
});

test('host read-roots: opencode reads claude+agents, copilot reads only itself', () => {
  assert.deepEqual([...hostReadRootsV15('opencode')], ['opencode', 'claude', 'openbot']);
  assert.deepEqual([...hostReadRootsV15('github')], ['github']);
  assert.deepEqual([...hostReadRootsV15('codex')], ['codex', 'openbot']);
  assert.equal(hostSeesSkillV15('opencode', 'claude'), true);
  assert.equal(hostSeesSkillV15('github', 'openbot'), false);
  assert.equal(hostSeesSkillV15('claude', 'openbot'), true);
});

test('parseCompatibilityEntryV15: bare, supported/unsupported prefixes, colon form, requirements', () => {
  assert.deepEqual(parseCompatibilityEntryV15('claude'), { kind: 'platform', platform: 'claude', supported: true });
  assert.deepEqual(parseCompatibilityEntryV15('not supported on codex'), { kind: 'platform', platform: 'codex', supported: false });
  assert.deepEqual(parseCompatibilityEntryV15('unsupported in opencode'), { kind: 'platform', platform: 'opencode', supported: false });
  assert.deepEqual(parseCompatibilityEntryV15('works on github'), { kind: 'platform', platform: 'github', supported: true });
  assert.deepEqual(parseCompatibilityEntryV15('opencode: supported'), { kind: 'platform', platform: 'opencode', supported: true });
  assert.deepEqual(parseCompatibilityEntryV15('claude: not supported'), { kind: 'platform', platform: 'claude', supported: false });
  assert.deepEqual(parseCompatibilityEntryV15('Requires git + a code search tool'), {
    kind: 'requirement',
    text: 'Requires git + a code search tool',
  });
  assert.equal(parseCompatibilityEntryV15('   '), null);
  assert.equal(parseCompatibilityEntryV15(''), null);
});

test('parseCompatibilityV15: string split, list form, later entry wins, unknown when absent', () => {
  const parsed = parseCompatibilityV15('claude; not supported on codex; Requires git');
  assert.deepEqual(parsed.supported, ['claude']);
  assert.deepEqual(parsed.unsupported, ['codex']);
  assert.deepEqual(parsed.requirements, ['Requires git']);
  assert.equal(parsed.unknown, false);
  const list = parseCompatibilityV15(['openbot', 'github']);
  assert.deepEqual(list.supported, ['openbot', 'github']);
  const corrected = parseCompatibilityV15('claude; not supported on claude');
  assert.deepEqual(corrected.supported, []);
  assert.deepEqual(corrected.unsupported, ['claude']);
  const absent = parseCompatibilityV15(undefined);
  assert.equal(absent.unknown, true);
  assert.deepEqual(absent.supported, []);
});

test('checkCompatibilityV15: supported / unsupported / unknown / partial-list verdicts', () => {
  const compat = parseCompatibilityV15('claude; not supported on codex');
  assert.equal(checkCompatibilityV15('s', compat, 'claude').verdict, 'supported');
  assert.equal(checkCompatibilityV15('s', compat, 'codex').verdict, 'unsupported');
  // Declares other platforms but not opencode: unknown, not a refusal.
  assert.equal(checkCompatibilityV15('s', compat, 'opencode').verdict, 'unknown');
  const unknown = parseCompatibilityV15(undefined);
  assert.equal(checkCompatibilityV15('s', unknown, 'github').verdict, 'unknown');
  const all = checkAllPlatformsV15('s', compat);
  assert.equal(all.length, 5);
  assert.equal(isPortableV15(parseCompatibilityV15('openbot; claude; github; codex; opencode')), true);
  assert.equal(isPortableV15(compat), false);
});

test('validateSkillForPlatformsV15: clean skill passes, compat verdicts attached', (t) => {
  const dir = tmpDir(t);
  const skillDir = writeSkill(dir, 'review-pr', CLEAN_FM);
  const result = validateSkillForPlatformsV15(skillDir);
  assert.equal(result.valid, true);
  assert.equal(result.base.valid, true);
  assert.equal(result.qualityScore, 100);
  assert.deepEqual(result.compatibility.supported, ['claude', 'opencode']);
  const byPlatform = new Map(result.checks.map((c) => [c.platform, c.verdict]));
  assert.equal(byPlatform.get('claude'), 'supported');
  assert.equal(byPlatform.get('opencode'), 'supported');
  assert.equal(byPlatform.get('codex'), 'unknown');
  assert.match(formatPlatformValidationSummaryV15(result), /quality 100\/100/);
});

test('validateSkillForPlatformsV15: unsupported target is an error', (t) => {
  const dir = tmpDir(t);
  const fm = [
    'name: review-pr',
    'description: Reviews a pull request for bugs and style. Use when a pull request needs review before merging.',
    'compatibility: not supported on codex',
  ].join('\n');
  const skillDir = writeSkill(dir, 'review-pr', fm);
  const result = validateSkillForPlatformsV15(skillDir, ['codex']);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((f) => f.code === 'V15-PLATFORM-UNSUPPORTED' && f.platform === 'codex'));
  assert.ok(result.qualityScore < 100);
});

test('validateSkillForPlatformsV15: no compatibility warns, unmirrored host warns', (t) => {
  const dir = tmpDir(t);
  const fm = [
    'name: review-pr',
    'description: Reviews a pull request for bugs and style. Use when a pull request needs review before merging.',
    'compatibility: cursor; Requires git',
  ].join('\n');
  const skillDir = writeSkill(dir, 'review-pr', fm);
  const result = validateSkillForPlatformsV15(skillDir);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((f) => f.code === 'V15-COMPAT-UNMIRRORED-HOST'));
  assert.deepEqual(result.compatibility.requirements, ['cursor', 'Requires git']);

  const dir2 = tmpDir(t);
  const fm2 = [
    'name: plain-skill',
    'description: Does a plain thing. Use when a plain thing is needed.',
  ].join('\n');
  const skillDir2 = writeSkill(dir2, 'plain-skill', fm2);
  const result2 = validateSkillForPlatformsV15(skillDir2);
  assert.equal(result2.valid, true);
  assert.ok(result2.warnings.some((f) => f.code === 'V15-COMPAT-UNKNOWN'));
  assert.equal(result2.compatibility.unknown, true);
});

test('validateSkillForPlatformsV15: allowed-tools experimental + bad names + dangling script ref', (t) => {
  const dir = tmpDir(t);
  const fm = [
    'name: review-pr',
    'description: Reviews a pull request for bugs and style. Use when a pull request needs review before merging.',
    'allowed-tools:',
    '  - read_file',
    '  - Bad Tool!',
    '  - read_file',
  ].join('\n');
  const skillDir = writeSkill(
    dir,
    'review-pr',
    fm,
    '# Body\n\nRun scripts/check.sh and see references/guide.md for details.\n',
  );
  const result = validateSkillForPlatformsV15(skillDir, ['claude'], { knownTools: ['read_file'] });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((f) => f.code === 'V15-ALLOWED-TOOLS-EXPERIMENTAL'));
  assert.ok(result.findings.some((f) => f.code === 'V15-ALLOWED-TOOLS-BAD-NAME'));
  assert.ok(result.findings.some((f) => f.code === 'V15-ALLOWED-TOOLS-DUPLICATE'));
  assert.ok(result.findings.some((f) => f.code === 'V15-SCRIPT-REF-MISSING' && f.file === 'scripts/check.sh'));
  assert.ok(result.findings.some((f) => f.code === 'V15-SCRIPT-REF-MISSING' && f.file === 'references/guide.md'));
});

test('validateSkillForPlatformsV15: existing script ref passes', (t) => {
  const dir = tmpDir(t);
  const fm = [
    'name: review-pr',
    'description: Reviews a pull request for bugs and style. Use when a pull request needs review before merging.',
  ].join('\n');
  const skillDir = writeSkill(dir, 'review-pr', fm, '# Body\n\nRun scripts/check.sh first.\n');
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'scripts', 'check.sh'), '#!/bin/sh\necho ok\n', 'utf8');
  const result = validateSkillForPlatformsV15(skillDir);
  assert.equal(result.valid, true);
  assert.ok(!result.findings.some((f) => f.code === 'V15-SCRIPT-REF-MISSING'));
});

test('validateSkillTextForPlatformsV15: text input, dir-name mismatch still caught by v14 base', () => {
  const text = `---\n${CLEAN_FM}\n---\n\n# Body\n\nDo the thing.\n`;
  const result = validateSkillTextForPlatformsV15(text, 'other-name');
  assert.equal(result.base.valid, false);
  assert.equal(result.valid, false);
  assert.ok(result.base.errors.some((e) => e.code === 'V14-NAME-MISMATCH'));
  const ok = validateSkillTextForPlatformsV15(text, 'review-pr');
  assert.equal(ok.valid, true);
});
