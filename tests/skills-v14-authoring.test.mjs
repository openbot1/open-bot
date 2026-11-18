/**
 * Tests cho v1.34 (Đội T1): Agent Skills v14 — authoring helper
 * (scaffold + render SKILL.md) và tool skills_v14_create.
 *
 * Mọi skill mẫu trong file này đều do đội T1 tự viết cho test (nội dung
 * gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/skills-v14-authoring.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createSkillV14,
  renderSkillMarkdownV14,
  SKILL_V14_REFERENCE_STUB,
  SKILL_V14_SCRIPT_STUB,
  SKILL_V14_STARTER_BODY,
} from '../packages/core/dist/skills/v14/authoring.js';
import { validateSkillTextV14 } from '../packages/core/dist/skills/v14/validator.js';
import {
  createSkillsV14Tools,
  SKILLS_V14_TOOL_NAMES,
} from '../packages/tools/dist/skillsV14Tools.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- renderSkillMarkdownV14 -------------------------------------------------

test('v14 authoring: rendered SKILL.md passes strict validation for the same name', () => {
  const text = renderSkillMarkdownV14(
    {
      name: 'note-taker',
      description: 'Use when the user asks to take notes from a call or a lecture.',
      license: 'MIT',
      compatibility: 'Works with any text editor.',
      metadata: { author: 'test-team', tier: 1 },
      allowedTools: ['read_file', 'write_file'],
    },
    '# Note taker\n\nTake notes from the call, then summarise them.\n',
  );
  const result = validateSkillTextV14(text, 'note-taker');
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.qualityScore, 100);
  assert.match(text, /^---\nname: note-taker\n/);
  assert.match(text, /allowed-tools: \[read_file, write_file\]/);
  assert.match(text, /license: MIT/);
  assert.match(text, /author: test-team/);
});

test('v14 authoring: values needing YAML quotes are quoted (colon, hash, leading digit)', () => {
  const text = renderSkillMarkdownV14(
    {
      name: 'colon-skill',
      description: 'Use when the description has a colon: and a # hash in it.',
      compatibility: ['node >= 20', 'a: b'],
      metadata: { version: '1.2.0', count: 3, flag: true },
    },
    '# Body\n\nText.\n',
  );
  const result = validateSkillTextV14(text, 'colon-skill');
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.match(text, /description: 'Use when the description has a colon: and a # hash in it\.'/);
  assert.match(text, /count: 3/);
  assert.match(text, /flag: true/);
});

test('v14 authoring: minimal two-field render validates clean', () => {
  const text = renderSkillMarkdownV14(
    { name: 'quick-note', description: 'Use when the user wants a quick note taken right now.' },
    '# Quick note\n\nTake the note fast.\n',
  );
  assert.equal(validateSkillTextV14(text, 'quick-note').valid, true);
});

test('v14 authoring: rendered text for a mismatched directory fails name-match (as it should)', () => {
  const text = renderSkillMarkdownV14(
    { name: 'note-taker', description: 'Use when the user asks to take notes.' },
    '# Body\n\nText.\n',
  );
  const result = validateSkillTextV14(text, 'other-dir');
  assert.ok(result.errors.some((e) => e.code === 'V14-NAME-MISMATCH'));
});

// --- createSkillV14 ----------------------------------------------------------

test('v14 authoring: create writes a valid skill directory (default starter body)', () => {
  const parent = tmpDir('v14-create-');
  const result = createSkillV14(parent, {
    name: 'note-taker',
    description: 'Use when the user asks to take notes from a call or a lecture.',
    license: 'MIT',
  });
  assert.equal(result.name, 'note-taker');
  assert.equal(result.dir, path.join(parent, 'note-taker'));
  assert.deepEqual(result.files, ['SKILL.md']);
  assert.equal(result.validation.valid, true);
  const text = fs.readFileSync(path.join(result.dir, 'SKILL.md'), 'utf8');
  assert.match(text, /name: note-taker/);
  assert.match(text, /license: MIT/);
  assert.match(text, /# note-taker/);
  assert.equal(SKILL_V14_STARTER_BODY.includes('{{name}}'), true);
});

test('v14 authoring: create with stubs writes a safe script + reference file', () => {
  const parent = tmpDir('v14-create-stubs-');
  const result = createSkillV14(
    parent,
    {
      name: 'note-taker',
      description: 'Use when the user asks to take notes from a call or a lecture.',
      body: '# Note taker\n\nTake notes.\n',
      withStubs: true,
    },
  );
  assert.deepEqual(result.files, ['SKILL.md', 'scripts/run.sh', 'references/notes.md']);
  assert.equal(result.validation.valid, true);
  const script = fs.readFileSync(path.join(result.dir, 'scripts', 'run.sh'), 'utf8');
  assert.match(script, /Skill note-taker/);
  assert.doesNotMatch(script, /rm -rf/);
  assert.doesNotMatch(script, /curl.*\|.*sh/);
  // The stub must NOT contain the literal the safety scanner flags (the
  // written script is asserted safe above) — but it must still document the
  // rule in words.
  assert.equal(SKILL_V14_SCRIPT_STUB.includes('curl | sh'), false);
  assert.match(SKILL_V14_SCRIPT_STUB, /never pipe a/);
  assert.equal(SKILL_V14_REFERENCE_STUB.includes('{{name}}'), true);
  const ref = fs.readFileSync(path.join(result.dir, 'references', 'notes.md'), 'utf8');
  assert.match(ref, /# Notes for note-taker/);
});

test('v14 authoring: create refuses an invalid name and leaves nothing behind', () => {
  const parent = tmpDir('v14-create-badname-');
  assert.throws(
    () =>
      createSkillV14(parent, {
        name: 'Bad_Name',
        description: 'Use when testing a bad name.',
      }),
    /V14-NAME-SHAPE/,
  );
  assert.equal(fs.existsSync(path.join(parent, 'Bad_Name')), false);
});

test('v14 authoring: create refuses a description without a when-cue? No — warns only, so create succeeds', () => {
  const parent = tmpDir('v14-create-nowhen-');
  const result = createSkillV14(parent, {
    name: 'plain-skill',
    description: 'A plain statement about notes, nothing more.',
  });
  assert.equal(result.validation.valid, true);
  assert.ok(result.validation.warnings.some((w) => w.code === 'V14-DESCRIPTION-NO-WHEN'));
});

test('v14 authoring: create refuses an over-long description and leaves nothing behind', () => {
  const parent = tmpDir('v14-create-longdesc-');
  assert.throws(
    () =>
      createSkillV14(parent, {
        name: 'long-desc',
        description: `Use when testing. ${'x'.repeat(1100)}`,
      }),
    /V14-DESCRIPTION-TOO-LONG/,
  );
  assert.equal(fs.existsSync(path.join(parent, 'long-desc')), false);
});

test('v14 authoring: create refuses to overwrite without the flag, replaces with it', () => {
  const parent = tmpDir('v14-create-overwrite-');
  createSkillV14(parent, {
    name: 'note-taker',
    description: 'Use when the user asks to take notes.',
  });
  assert.throws(
    () =>
      createSkillV14(parent, {
        name: 'note-taker',
        description: 'Use when the user asks to take notes again.',
      }),
    /already exists/,
  );
  const replaced = createSkillV14(
    parent,
    {
      name: 'note-taker',
      description: 'Use when the user asks to take notes again.',
    },
    { overwrite: true },
  );
  assert.equal(replaced.validation.valid, true);
  assert.match(fs.readFileSync(path.join(replaced.dir, 'SKILL.md'), 'utf8'), /take notes again/);
});

// --- skills_v14_create tool ----------------------------------------------------

test('v14 tools: SKILLS_V14_TOOL_NAMES now lists 10 tools including create', () => {
  assert.equal(SKILLS_V14_TOOL_NAMES.length, 10);
  assert.ok(SKILLS_V14_TOOL_NAMES.includes('skills_v14_create'));
  const tools = createSkillsV14Tools();
  assert.equal(tools.length, 10);
  const create = tools.find((t) => t.definition.name === 'skills_v14_create');
  assert.equal(create.needsApproval, true);
});

test('v14 tools: skills_v14_create scaffolds a skill and refuses a bad name', async () => {
  const work = tmpDir('v14-tools-create-');
  const skillsDir = path.join(work, 'skills');
  const tools = createSkillsV14Tools({ getSkillsDir: () => skillsDir });
  const create = tools.find((t) => t.definition.name === 'skills_v14_create');

  const ok = await create.execute({
    name: 'note-taker',
    description: 'Use when the user asks to take notes from a call or a lecture.',
    body: '# Note taker\n\nTake notes.\n',
    license: 'MIT',
    allowedTools: 'read_file, write_file',
    withStubs: true,
    targetDir: skillsDir,
  });
  assert.match(ok, /Đã tạo skill "note-taker"/);
  assert.match(ok, /100\/100/);
  assert.equal(fs.existsSync(path.join(skillsDir, 'note-taker', 'scripts', 'run.sh')), true);

  const bad = await create.execute({
    name: 'Bad_Name',
    description: 'Use when testing.',
    targetDir: skillsDir,
  });
  assert.match(bad, /^Error:/);
  assert.match(bad, /V14-NAME-SHAPE/);

  const missing = await create.execute({ name: 'x' });
  assert.match(missing, /^Error:/);
});
