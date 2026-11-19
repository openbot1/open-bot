/**
 * Tests cho v1.36 (Đội T2): Agent Skills v15 — budgeted progressive
 * disclosure + compatibility-aware registry.
 *
 * Mọi skill mẫu trong file này đều do đội T2 tự viết cho test (nội
 * dung gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-v15-disclosure-registry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DisclosureSessionV15,
  formatDisclosureUsageV15,
  resolveBudgetV15,
  trimHeadersToBudgetV15,
  v15HeadersForContext,
} from '../packages/core/dist/skills/v15/disclosure.js';
import {
  buildCompatibilityMatrixV15,
  defaultRegistryFileV15,
  filterRegistryEntriesV15,
  formatCompatibilityMatrixV15,
  formatRegistryEntriesV15,
  refreshRegistryV15,
  SkillV15Registry,
} from '../packages/core/dist/skills/v15/registry.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-v15-dr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(root, name, description, compat, body) {
  const skillDir = path.join(root, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    compat === undefined ? '' : `compatibility: ${compat}`,
    '---',
    '',
  ].filter((l) => l !== '').join('\n');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${fm}\n\n${body}\n`, 'utf8');
  return skillDir;
}

function seedProject(t) {
  const dir = tmpDir(t);
  const agents = path.join(dir, '.agents', 'skills');
  const claude = path.join(dir, '.claude', 'skills');
  writeSkill(
    agents,
    'review-pr',
    'Reviews a pull request for bugs and style. Use when a pull request needs review before merging.',
    'claude; opencode',
    '# Review PR\n\n' + 'Check the diff carefully. '.repeat(40),
  );
  writeSkill(
    agents,
    'plain-notes',
    'Takes plain notes. Use when the user asks to take a note.',
    undefined,
    '# Notes\n\nWrite it down.\n',
  );
  writeSkill(
    claude,
    'portable-helper',
    'Helps with small tasks. Use when a small helper task arrives.',
    'openbot; claude; github; codex; opencode',
    '# Helper\n\nHelp out.\n',
  );
  // Tier-3 resource for review-pr.
  const refDir = path.join(agents, 'review-pr', 'references');
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(path.join(refDir, 'cheat-sheet.md'), '# Cheat sheet\n\nBe kind in review.\n', 'utf8');
  // Fake empty home dir: the real home holds a global skill that must
  // not leak into counts (discovery also scans global roots).
  const home = path.join(dir, 'fake-home');
  fs.mkdirSync(home, { recursive: true });
  return { dir, agents, claude, home };
}

test('resolveBudgetV15: defaults filled, resource cap clamped to hard max', () => {
  const defaults = resolveBudgetV15();
  assert.equal(defaults.maxHeaders, 64);
  assert.equal(defaults.maxHeaderTokens, 6400);
  assert.equal(defaults.maxBodyTokens, 24000);
  assert.equal(defaults.maxResourceBytes, 1000000);
  const custom = resolveBudgetV15({ maxHeaders: 2, maxResourceBytes: 99999999 });
  assert.equal(custom.maxHeaders, 2);
  assert.equal(custom.maxResourceBytes, 2000000);
});

test('trimHeadersToBudgetV15: keeps priority order, drops the tail, counts tokens', () => {
  const headers = [
    { name: 'a', description: 'A', dir: '/a', source: 'project-agents', headerTokens: 10, enabled: true },
    { name: 'b', description: 'B', dir: '/b', source: 'project-agents', headerTokens: 10, enabled: true },
    { name: 'c', description: 'C', dir: '/c', source: 'global-claude', headerTokens: 10, enabled: true },
  ];
  const byCount = trimHeadersToBudgetV15(headers, resolveBudgetV15({ maxHeaders: 2 }));
  assert.deepEqual(byCount.kept.map((h) => h.name), ['a', 'b']);
  assert.deepEqual(byCount.dropped.map((h) => h.name), ['c']);
  const byTokens = trimHeadersToBudgetV15(headers, resolveBudgetV15({ maxHeaderTokens: 15 }));
  assert.deepEqual(byTokens.kept.map((h) => h.name), ['a']);
  assert.equal(byTokens.keptTokens, 10);
});

test('DisclosureSessionV15: list trims headers, usage reports drops', (t) => {
  const { dir, home } = seedProject(t);
  const session = new DisclosureSessionV15({ projectRoot: dir, homeDir: home, budget: { maxHeaders: 2 } });
  const opened = session.open();
  assert.equal(opened.headers.length, 2);
  assert.equal(opened.dropped.length, 1);
  assert.equal(session.size, 3);
  const usage = session.usageSnapshot();
  assert.equal(usage.headersLoaded, 2);
  assert.ok(usage.headerTokens > 0);
  assert.deepEqual(usage.evicted, []);
  const context = session.headersForContext();
  assert.match(context, /dropped by budget/);
  assert.match(context, /Available skills \(v15/);
});

test('DisclosureSessionV15: activate charges budget, LRU evicts oldest body', (t) => {
  const { dir, home } = seedProject(t);
  const probe = new DisclosureSessionV15({ projectRoot: dir, homeDir: home });
  probe.open();
  const first = probe.activate('review-pr');
  assert.ok(first !== null);
  assert.ok(first.bodyTokens > 100, `expected a large body, got ${first.bodyTokens}`);
  assert.equal(probe.isActivated('review-pr'), true);
  const again = probe.activate('review-pr');
  assert.ok(again !== null);
  assert.equal(probe.usageSnapshot().bodiesLoaded, 1, 're-activation must not double-charge');
  // A second session whose body budget fits exactly one review-pr body:
  // activating a second skill must evict the first (LRU).
  const tight = new DisclosureSessionV15({ projectRoot: dir, homeDir: home, budget: { maxBodyTokens: first.bodyTokens } });
  tight.open();
  const held = tight.activate('review-pr');
  assert.ok(held !== null);
  const second = tight.activate('plain-notes');
  assert.ok(second !== null);
  assert.deepEqual(second.evictedNames, ['review-pr']);
  assert.equal(tight.isActivated('review-pr'), false);
  assert.equal(tight.isActivated('plain-notes'), true);
  const usage = tight.usageSnapshot();
  assert.deepEqual(usage.evicted, ['review-pr']);
  assert.ok(usage.bodyTokens <= first.bodyTokens);
  assert.match(formatDisclosureUsageV15(usage, tight.budget), /Evicted \(LRU\): review-pr/);
});

test('DisclosureSessionV15: oversized body refused, not evicting everything', (t) => {
  const { dir, home } = seedProject(t);
  const session = new DisclosureSessionV15({ projectRoot: dir, homeDir: home, budget: { maxBodyTokens: 10 } });
  session.open();
  const refused = session.activate('review-pr');
  assert.equal(refused, null);
  const usage = session.usageSnapshot();
  assert.equal(usage.bodiesLoaded, 0);
  assert.equal(usage.rejected.length, 1);
  assert.match(usage.rejected[0], /over the 10-token body budget/);
});

test('DisclosureSessionV15: tier-3 resource cached, oversized refused', (t) => {
  const { dir, home } = seedProject(t);
  const session = new DisclosureSessionV15({ projectRoot: dir, homeDir: home });
  session.open();
  assert.deepEqual(session.listResources('review-pr'), ['references/cheat-sheet.md']);
  const res = session.loadResource('review-pr', 'references/cheat-sheet.md');
  assert.ok(res !== null);
  assert.match(res.content, /Be kind in review/);
  const cached = session.loadResource('review-pr', 'references/cheat-sheet.md');
  assert.equal(session.usageSnapshot().resourcesLoaded, 1, 'cached re-read must be free');
  assert.equal(cached.content, res.content);
  const tiny = new DisclosureSessionV15({ projectRoot: dir, homeDir: home, budget: { maxResourceBytes: 5 } });
  tiny.open();
  assert.equal(tiny.loadResource('review-pr', 'references/cheat-sheet.md'), null);
  assert.equal(tiny.usageSnapshot().rejected.length, 1);
  // An escaping path is refused with the escape message (the loader
  // resolves the path before the tier check, since fix round 5).
  assert.throws(() => session.loadResource('review-pr', '../SKILL.md'), /escapes the skill directory/);
  // Root file inside the skill dir but outside the tier-3 resource dirs.
  assert.throws(() => session.loadResource('review-pr', 'SKILL.md'), /must live under/);
  assert.throws(() => session.loadResource('no-such-skill', 'references/x.md'), /Unknown skill/);
});

test('DisclosureSessionV15: evict frees budget, unknown skill throws', (t) => {
  const { dir, home } = seedProject(t);
  const session = new DisclosureSessionV15({ projectRoot: dir, homeDir: home });
  session.open();
  session.activate('plain-notes');
  assert.equal(session.usageSnapshot().bodiesLoaded, 1);
  session.evict('plain-notes');
  assert.equal(session.usageSnapshot().bodiesLoaded, 0);
  assert.equal(session.isActivated('plain-notes'), false);
  assert.throws(() => session.activate('no-such-skill'), /Unknown skill/);
  assert.match(v15HeadersForContext({ projectRoot: dir, homeDir: home }), /review-pr/);
});

test('SkillV15Registry: refresh builds entries with structured compatibility', (t) => {
  const { dir, home } = seedProject(t);
  const registry = new SkillV15Registry({ projectRoot: dir, homeDir: home });
  const entries = registry.refresh();
  assert.equal(entries.length, 3);
  assert.equal(registry.size, 3);
  const review = registry.get('review-pr');
  assert.deepEqual(review.compatibility.supported, ['claude', 'opencode']);
  assert.equal(review.compatibility.unknown, false);
  const plain = registry.get('plain-notes');
  assert.equal(plain.compatibility.unknown, true);
  const portable = registry.get('portable-helper');
  assert.deepEqual(portable.compatibility.supported, ['openbot', 'claude', 'github', 'codex', 'opencode']);
  assert.equal(defaultRegistryFileV15(dir), path.join(dir, '.agents', 'skills-v15-registry.json'));
});

test('SkillV15Registry: filter by platform / portable / unknown / query', (t) => {
  const { dir, home } = seedProject(t);
  const registry = new SkillV15Registry({ projectRoot: dir, homeDir: home });
  registry.refresh();
  assert.deepEqual(registry.supportedOn('claude').map((e) => e.name), ['portable-helper', 'review-pr']);
  assert.deepEqual(registry.supportedOn('github').map((e) => e.name), ['portable-helper']);
  assert.deepEqual(registry.portable().map((e) => e.name), ['portable-helper']);
  assert.deepEqual(registry.unknownCompatibility().map((e) => e.name), ['plain-notes']);
  assert.deepEqual(registry.filter({ query: 'pull request' }).map((e) => e.name), ['review-pr']);
  assert.deepEqual(filterRegistryEntriesV15(registry.list(), { enabled: false }), []);
});

test('SkillV15Registry: compatibility matrix + formatting', (t) => {
  const { dir, home } = seedProject(t);
  const entries = refreshRegistryV15({ projectRoot: dir, homeDir: home });
  const rows = buildCompatibilityMatrixV15(entries);
  assert.equal(rows.length, 3);
  const portable = rows.find((r) => r.skill === 'portable-helper');
  assert.equal(portable.portable, true);
  assert.equal(portable.supportedCount, 5);
  const review = rows.find((r) => r.skill === 'review-pr');
  assert.equal(review.cells.claude, 'supported');
  assert.equal(review.cells.codex, 'unknown');
  assert.equal(review.portable, false);
  const text = formatCompatibilityMatrixV15(rows);
  assert.match(text, /portable-helper \| yes \| yes \| yes \| yes \| yes \| yes/);
  assert.match(formatRegistryEntriesV15(entries), /compatibility undeclared/);
  assert.equal(formatCompatibilityMatrixV15([]), 'No skills in the v15 registry.');
});

test('SkillV15Registry: save + load round-trip, corrupt index refused', (t) => {
  const { dir, home } = seedProject(t);
  const registry = new SkillV15Registry({ projectRoot: dir, homeDir: home });
  registry.refresh();
  const saved = registry.save();
  assert.equal(saved, path.join(dir, '.agents', 'skills-v15-registry.json'));
  assert.ok(fs.existsSync(saved));
  const loaded = new SkillV15Registry({ projectRoot: dir, homeDir: home });
  const entries = loaded.load();
  assert.equal(entries.length, 3);
  assert.equal(loaded.get('review-pr').compatibility.supported.length, 2);
  // Corrupt: wrong format.
  fs.writeFileSync(saved, JSON.stringify({ format: 'something-else/1', entries: [] }), 'utf8');
  assert.throws(() => new SkillV15Registry({ projectRoot: dir, homeDir: home }).load(), /is not "openbot-skills-v15-registry/);
  // Corrupt: entry without structured compatibility.
  fs.writeFileSync(
    saved,
    JSON.stringify({ format: 'openbot-skills-v15-registry/1', entries: [{ name: 'x', description: 'y', dir: '/z' }] }),
    'utf8',
  );
  assert.throws(() => new SkillV15Registry({ projectRoot: dir, homeDir: home }).load(), /structured compatibility/);
  // Missing file.
  const empty = new SkillV15Registry({ projectRoot: path.join(dir, 'nope') });
  assert.throws(() => empty.load(), /No v15 registry index/);
});
