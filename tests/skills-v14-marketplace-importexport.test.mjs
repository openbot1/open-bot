/**
 * Tests cho v1.34 (Đội T1): Agent Skills v14 — local marketplace index,
 * portable import/export, agent tools.
 *
 * Mọi skill mẫu trong file này đều do đội T1 tự viết cho test (nội dung
 * gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/skills-v14-marketplace-importexport.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  browseLocalSkillIndexV14,
  disableSkillV14,
  enableSkillV14,
  formatMarketplaceEntriesV14,
  isSkillEnabledV14,
  readTierStateV14,
  searchInstalledSkillsV14,
  searchLocalSkillsV14,
  setSkillEnabledV14,
} from '../packages/core/dist/skills/v14/marketplace.js';
import {
  exportSkillV14,
  importSkillV14,
  isOverwriteNeededV14,
  readBundleManifestV14,
  sha256TextV14,
  validateBundleV14,
  verifyBundleChecksumsV14,
} from '../packages/core/dist/skills/v14/importExport.js';
import {
  createSkillsV14Tools,
  SKILLS_V14_TOOLS,
  SKILLS_V14_TOOL_NAMES,
} from '../packages/tools/dist/skillsV14Tools.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(dir, name, text, extra = {}) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), text, 'utf8');
  for (const [rel, content] of Object.entries(extra)) {
    const full = path.join(skillDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return skillDir;
}

const NOTE_SKILL = `---
name: note-taker
description: Use when the user asks to take notes from a call or a lecture.
license: MIT
allowed-tools: [read_file]
---
# Note taker

Take notes from the call, then summarise them.
`;

const REVIEW_SKILL = `---
name: review-helper
description: Use when the user asks to review notes or a draft before sharing.
license: MIT
---
# Review helper

Read the draft, list issues, then suggest fixes.
`;

const QUICK_SKILL = `---
name: quick-note
description: Use when the user wants a quick note taken right now.
---
# Quick note

Take the note fast.
`;

function setupProject() {
  const project = tmpDir('v14-mkt-proj-');
  const home = tmpDir('v14-mkt-home-');
  const agentsDir = path.join(project, '.agents', 'skills');
  writeSkill(agentsDir, 'note-taker', NOTE_SKILL);
  // review-helper ở root thứ hai (project .claude/skills) để browse thật
  // sự quét ≥ 2 root — để cả 3 skill trong .agents/skills thì chỉ có
  // 1 root tồn tại và assert scannedRoots >= 2 không bao giờ đạt.
  writeSkill(path.join(project, '.claude', 'skills'), 'review-helper', REVIEW_SKILL);
  writeSkill(agentsDir, 'quick-note', QUICK_SKILL);
  // An (empty) home skills dir: browse must report at least the project
  // root AND one global root as scanned. Without it the home roots do
  // not exist and are (correctly) reported as missing, not scanned.
  fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
  return { project, home, agentsDir };
}

// --- Local marketplace index -------------------------------------------------

test('v14 marketplace: browse lists installed skills with enabled state', () => {
  const { project, home } = setupProject();
  const { entries, errors, scannedRoots } = browseLocalSkillIndexV14({ projectRoot: project, homeDir: home });
  assert.equal(errors.length, 0);
  assert.equal(entries.length, 3);
  assert.ok(scannedRoots.length >= 2);
  const note = entries.find((e) => e.name === 'note-taker');
  assert.equal(note.enabled, true);
  assert.equal(note.source, 'project-agents');
  assert.deepEqual(note.allowedTools, ['read_file']);
  const text = formatMarketplaceEntriesV14(entries);
  assert.match(text, /note-taker/);
  assert.match(text, /review-helper/);
  assert.equal(formatMarketplaceEntriesV14([]), 'No v14 skills installed.');
});

test('v14 marketplace: keyword search ranks name hits above description hits', () => {
  const { project, home } = setupProject();
  const hits = searchInstalledSkillsV14('note', { projectRoot: project, homeDir: home });
  assert.ok(hits.length >= 2);
  // "note-taker" and "quick-note" match in the NAME (10 pts); "review-helper"
  // only matches "notes" in the description (4 pts) — name hits come first.
  assert.ok(hits[0].score >= hits[hits.length - 1].score);
  assert.ok(hits.slice(0, 2).every((h) => h.matchedIn === 'name' || h.matchedIn === 'both'));
  const reviewHits = searchLocalSkillsV14(
    browseLocalSkillIndexV14({ projectRoot: project, homeDir: home }).entries,
    'review draft',
  );
  assert.equal(reviewHits[0].entry.name, 'review-helper');
  assert.equal(reviewHits[0].matchedIn, 'both');
  assert.deepEqual(searchInstalledSkillsV14('   ', { projectRoot: project, homeDir: home }), []);
  assert.deepEqual(searchInstalledSkillsV14('zzz-no-match', { projectRoot: project, homeDir: home }), []);
});

test('v14 marketplace: disable/enable flips the tier without touching the skill dir', () => {
  const { project, home } = setupProject();
  const agentsDir = path.join(project, '.agents', 'skills');
  const before = fs.readFileSync(path.join(agentsDir, 'note-taker', 'SKILL.md'), 'utf8');
  const stateFile = path.join(project, '.openbot-skills-v14.json');

  assert.equal(isSkillEnabledV14('note-taker', { projectRoot: project, homeDir: home }), true);
  const disabled = setSkillEnabledV14('note-taker', false, { projectRoot: project, homeDir: home, stateFile });
  assert.equal(disabled, false);
  assert.equal(isSkillEnabledV14('note-taker', { projectRoot: project, homeDir: home, stateFile }), false);
  // The skill directory itself is untouched.
  assert.equal(fs.readFileSync(path.join(agentsDir, 'note-taker', 'SKILL.md'), 'utf8'), before);
  // State file only lists disabled names.
  assert.deepEqual(readTierStateV14(stateFile).disabled, ['note-taker']);
  // Browse reflects the tier.
  const { entries } = browseLocalSkillIndexV14({ projectRoot: project, homeDir: home, stateFile });
  assert.equal(entries.find((e) => e.name === 'note-taker').enabled, false);
  assert.equal(entries.find((e) => e.name === 'quick-note').enabled, true);
  // Re-enable.
  assert.equal(enableSkillV14('note-taker', { projectRoot: project, homeDir: home, stateFile }), true);
  assert.equal(isSkillEnabledV14('note-taker', { projectRoot: project, homeDir: home, stateFile }), true);
  assert.deepEqual(readTierStateV14(stateFile).disabled, []);
  // Disabling an unknown skill throws.
  assert.throws(() => disableSkillV14('nope', { projectRoot: project, homeDir: home, stateFile }), /not installed/);
});

test('v14 marketplace: corrupt tier state file means "everything enabled", never a crash', () => {
  const { project, home } = setupProject();
  const stateFile = path.join(project, '.openbot-skills-v14.json');
  fs.writeFileSync(stateFile, '{not json', 'utf8');
  assert.deepEqual(readTierStateV14(stateFile), { disabled: [], version: 1 });
  const { entries } = browseLocalSkillIndexV14({ projectRoot: project, homeDir: home, stateFile });
  assert.ok(entries.every((e) => e.enabled));
});

// --- Portable import / export -----------------------------------------------

test('v14 import/export: round-trip keeps the skill byte-identical', () => {
  const { agentsDir } = setupProject();
  const work = tmpDir('v14-bundle-');
  const skillDir = path.join(agentsDir, 'note-taker');
  const exported = exportSkillV14(skillDir, { outDir: path.join(work, 'bundle') });
  assert.equal(exported.manifest.name, 'note-taker');
  assert.equal(exported.manifest.format, 'openbot-skills-v14-bundle/1');
  assert.equal(exported.manifest.files.length, 1);
  assert.equal(exported.manifest.files[0].path, 'SKILL.md');
  assert.match(exported.manifest.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(exported.bundleDir, 'skill-bundle.json')), true);

  const targetDir = path.join(work, 'installed');
  const imported = importSkillV14(exported.bundleDir, { targetDir });
  assert.equal(isOverwriteNeededV14(imported), false);
  assert.equal(imported.name, 'note-taker');
  assert.equal(imported.overwritten, false);
  assert.equal(imported.validation.valid, true);
  assert.equal(
    fs.readFileSync(path.join(imported.dir, 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'),
  );
});

test('v14 import/export: bundle with scripts/ and references/ round-trips too', () => {
  const work = tmpDir('v14-bundle-full-');
  const src = writeSkill(path.join(work, 'src'), 'full-skill', NOTE_SKILL.replace('note-taker', 'full-skill'), {
    'scripts/run.sh': '#!/bin/sh\necho hi\n',
    'references/guide.md': '# Guide\n\nDetails here.\n',
  });
  const exported = exportSkillV14(src, { outDir: path.join(work, 'bundle') });
  assert.equal(exported.manifest.files.length, 3);
  const imported = importSkillV14(exported.bundleDir, { targetDir: path.join(work, 'installed') });
  assert.equal(isOverwriteNeededV14(imported), false);
  assert.equal(fs.readFileSync(path.join(imported.dir, 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
  assert.equal(fs.readFileSync(path.join(imported.dir, 'references', 'guide.md'), 'utf8'), '# Guide\n\nDetails here.\n');
});

test('v14 import/export: tampered bundle fails checksum verification and refuses import', () => {
  const { agentsDir } = setupProject();
  const work = tmpDir('v14-bundle-tamper-');
  const exported = exportSkillV14(path.join(agentsDir, 'note-taker'), { outDir: path.join(work, 'bundle') });
  // Tamper with the skill file after export.
  fs.writeFileSync(path.join(exported.bundleDir, 'SKILL.md'), NOTE_SKILL.replace('Take notes', 'Take evil notes'), 'utf8');
  const problems = verifyBundleChecksumsV14(exported.bundleDir, readBundleManifestV14(exported.bundleDir));
  assert.ok(problems.some((p) => p.includes('Checksum mismatch')), problems.join('; '));
  const { problems: validateProblems } = validateBundleV14(exported.bundleDir);
  assert.ok(validateProblems.length > 0);
  assert.throws(
    () => importSkillV14(exported.bundleDir, { targetDir: path.join(work, 'installed') }),
    /Checksum mismatch/,
  );
  // Nothing was written.
  assert.equal(fs.existsSync(path.join(work, 'installed', 'note-taker')), false);
});

test('v14 import/export: bundle without a manifest, or with a wrong format, is refused', () => {
  const work = tmpDir('v14-bundle-nomanifest-');
  const empty = path.join(work, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  assert.throws(() => readBundleManifestV14(empty), /holds no skill-bundle\.json/);
  assert.throws(() => importSkillV14(empty, { targetDir: path.join(work, 't') }), /holds no skill-bundle\.json/);
  const wrong = path.join(work, 'wrong');
  fs.mkdirSync(wrong, { recursive: true });
  fs.writeFileSync(path.join(wrong, 'skill-bundle.json'), JSON.stringify({ format: 'other/1', name: 'x', description: 'd', files: [] }), 'utf8');
  assert.throws(() => readBundleManifestV14(wrong), /is not "openbot-skills-v14-bundle\/1"/);
});

test('v14 import/export: importing over an existing skill needs overwrite confirmation', () => {
  const { agentsDir } = setupProject();
  const work = tmpDir('v14-bundle-overwrite-');
  const exported = exportSkillV14(path.join(agentsDir, 'note-taker'), { outDir: path.join(work, 'bundle') });
  const targetDir = path.join(work, 'installed');
  const first = importSkillV14(exported.bundleDir, { targetDir });
  assert.equal(isOverwriteNeededV14(first), false);
  // Second import without overwrite: confirmation shape, nothing written.
  const second = importSkillV14(exported.bundleDir, { targetDir });
  assert.equal(isOverwriteNeededV14(second), true);
  assert.equal(second.name, 'note-taker');
  assert.equal(second.existingDir, path.join(targetDir, 'note-taker'));
  // With overwrite: replaces, reports overwritten.
  const third = importSkillV14(exported.bundleDir, { targetDir, overwrite: true });
  assert.equal(isOverwriteNeededV14(third), false);
  assert.equal(third.overwritten, true);
});

test('v14 import/export: exporting an invalid skill throws and writes no bundle', () => {
  const work = tmpDir('v14-bundle-invalid-');
  const bad = writeSkill(
    path.join(work, 'src'),
    'bad-skill',
    `---\nname: wrong-name\ndescription: Use when testing.\n---\n# X\n\nBody.\n`,
  );
  const outDir = path.join(work, 'bundle');
  assert.throws(() => exportSkillV14(bad, { outDir }), /Cannot export invalid skill/);
  assert.equal(fs.existsSync(path.join(outDir, 'skill-bundle.json')), false);
});

test('v14 import/export: sha256 helper is stable', () => {
  assert.equal(sha256TextV14('hello'), sha256TextV14('hello'));
  assert.match(sha256TextV14('hello'), /^[0-9a-f]{64}$/);
  assert.notEqual(sha256TextV14('hello'), sha256TextV14('world'));
});

// --- Agent tools ---------------------------------------------------------------

test('v14 tools: 10 tools, names match, 6 read-only + 4 need approval', () => {
  assert.equal(SKILLS_V14_TOOL_NAMES.length, 10);
  assert.deepEqual([...SKILLS_V14_TOOL_NAMES], [
    'skills_v14_list',
    'skills_v14_activate',
    'skills_v14_resource',
    'skills_v14_validate',
    'skills_v14_discover',
    'skills_v14_search',
    'skills_v14_toggle',
    'skills_v14_import',
    'skills_v14_export',
    'skills_v14_create',
  ]);
  assert.equal(SKILLS_V14_TOOLS.length, 10);
  const byName = new Map(SKILLS_V14_TOOLS.map((t) => [t.definition.name, t]));
  for (const name of SKILLS_V14_TOOL_NAMES) assert.ok(byName.has(name), `missing tool ${name}`);
  for (const name of ['skills_v14_list', 'skills_v14_activate', 'skills_v14_resource', 'skills_v14_validate', 'skills_v14_discover', 'skills_v14_search']) {
    assert.equal(byName.get(name).needsApproval, false, name);
  }
  for (const name of ['skills_v14_toggle', 'skills_v14_import', 'skills_v14_export', 'skills_v14_create']) {
    assert.equal(byName.get(name).needsApproval, true, name);
  }
  // The factory builds the same set (unbound placeholder has no dirs configured).
  assert.equal(createSkillsV14Tools().length, 10);
});

test('v14 tools: list + activate + validate + search work end to end', async () => {
  const { project, home } = setupProject();
  const tools = createSkillsV14Tools({ getProjectRoot: () => project, getSkillsDir: () => path.join(project, '.agents', 'skills') });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));

  const list = await byName.get('skills_v14_list').execute({ projectRoot: project, projectOnly: true });
  assert.match(list, /note-taker/);
  assert.match(list, /quick-note/);
  assert.match(list, /token header/);

  const activated = await byName.get('skills_v14_activate').execute({ name: 'note-taker', projectRoot: project });
  assert.match(activated, /Take notes from the call/);

  const validated = await byName.get('skills_v14_validate').execute({ dir: path.join(project, '.agents', 'skills', 'note-taker') });
  assert.match(validated, /valid/);
  assert.match(validated, /100\/100/);

  const searched = await byName.get('skills_v14_search').execute({ query: 'review notes', projectRoot: project });
  assert.match(searched, /review-helper/);

  const discovered = await byName.get('skills_v14_discover').execute({ projectRoot: project, projectOnly: true });
  assert.match(discovered, /Found 3 skill/);

  const missing = await byName.get('skills_v14_activate').execute({ name: 'nope', projectRoot: project });
  assert.match(missing, /^Error:/);
});

test('v14 tools: toggle + import + export round-trip through the tools', async () => {
  const { project } = setupProject();
  const work = tmpDir('v14-tools-io-');
  const skillsDir = path.join(project, '.agents', 'skills');
  const tools = createSkillsV14Tools({ getProjectRoot: () => project, getSkillsDir: () => skillsDir });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));

  const exported = await byName.get('skills_v14_export').execute({
    skillDir: path.join(skillsDir, 'quick-note'),
    outDir: path.join(work, 'bundle'),
  });
  assert.match(exported, /Đã xuất skill "quick-note"/);
  assert.match(exported, /checksum SHA-256/);

  const targetDir = path.join(work, 'installed');
  const imported = await byName.get('skills_v14_import').execute({
    bundleDir: path.join(work, 'bundle'),
    targetDir,
  });
  assert.match(imported, /Đã nhập skill "quick-note"/);

  // Import again without overwrite: asks for confirmation, writes nothing.
  const again = await byName.get('skills_v14_import').execute({ bundleDir: path.join(work, 'bundle'), targetDir });
  assert.match(again, /đã tồn tại/);
  assert.match(again, /overwrite=true/);

  // Toggle off then on (state file lives next to the project root).
  const off = await byName.get('skills_v14_toggle').execute({ name: 'quick-note', enabled: false, projectRoot: project });
  assert.match(off, /Đã tắt skill "quick-note"/);
  const listAfter = await byName.get('skills_v14_list').execute({ projectRoot: project, projectOnly: true });
  assert.match(listAfter, /quick-note.*\[TẮT\]/);
  const on = await byName.get('skills_v14_toggle').execute({ name: 'quick-note', enabled: true, projectRoot: project });
  assert.match(on, /Đã bật skill "quick-note"/);

  // Resource tool: tier-3 file, and refusal outside the skill.
  const res = await byName.get('skills_v14_resource').execute({ name: 'note-taker', relPath: 'SKILL.md', projectRoot: project });
  assert.match(res, /^Error:/);
});
