/**
 * Tests cho v1.13 (Đội T1): Agent Skills loader v13 — strict validation
 * + internal registry.
 *
 * Mọi skill mẫu trong file này đều do đội T1 tự viết cho test (nội dung
 * gốc, không lấy từ skill thật của bất kỳ dự án nào).
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-v113-validation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compatibilityLength,
  descriptionHasTrigger,
  detectToolsFieldClash,
  formatValidationSummary,
  longestCodeFenceLines,
  validateFrontmatterObjectV13,
  validateSkillFileTextV13,
  validateSkillHeaderV13,
  validateSkillTextV13,
  validateSkillV13,
  KNOWN_SPDX_LICENSES,
  SKILL_V13_COMPATIBILITY_MAX_LENGTH,
} from '../packages/core/dist/skills/v13/validation.js';
import {
  getInternalSkill,
  internalSkillNames,
  internalSkillsByCategory,
  isInternalSkill,
  listInternalSkills,
  registerInternalSkill,
  clearInternalSkillOverlays,
  searchInternalSkills,
  skillsForContext,
  unregisterInternalSkill,
  INTERNAL_BUILTIN_SKILLS,
  INTERNAL_CAPABILITY_SKILLS,
} from '../packages/core/dist/skills/v13/internalRegistry.js';
import { parseSkillMarkdown } from '../packages/core/dist/skills/loader.js';

// --- Sample skills (written for these tests) ---------------------------

const GOOD_SKILL = `---
name: note-taker
description: Use when the user asks to take notes from a call or a lecture.
version: 1.2.0
when-to-use: When the user asks to take notes from a call or a lecture.
license: MIT
compatibility: Requires a text editor.
metadata:
  author: test-team
  audience: general
allowed-tools: [read_file, write_file]
---
# Note taker

Capture the key points first, then the details.
`;

const LONG_COMPAT = 'x'.repeat(SKILL_V13_COMPATIBILITY_MAX_LENGTH + 1);
const BAD_COMPAT_SKILL = `---
name: heavy-skill
description: Use when the user needs something heavy done.
compatibility: ${LONG_COMPAT}
---
# Heavy

Do the heavy thing.
`;

const NO_TRIGGER_SKILL = `---
name: plain-label
description: A very nice skill.
---
# Plain label

Do something nice.
`;

const CLASH_SKILL = `---
name: clash-skill
description: Use when testing a frontmatter clash.
tools: [read_file]
allowed-tools: [read_file, write_file]
---
# Clash

Both fields are present.
`;

const UNKNOWN_LICENSE_SKILL = `---
name: odd-license
description: Use when testing an unknown license value.
license: My-Custom-License-1.0
---
# Odd license

Do the thing.
`;

const LONG_BODY = `# Long body\n\n${'This is a long instruction line that keeps going. '.repeat(400)}`;

const LONG_BODY_SKILL = `---
name: long-body
description: Use when testing a body that is far too long.
---
${LONG_BODY}
`;

const CODE_FENCE_BODY = [
  '---',
  'name: fence-skill',
  'description: Use when testing a long fenced code block.',
  '---',
  '# Fence',
  '',
  '```sh',
  ...Array.from({ length: 60 }, (_, i) => `echo line ${i}`),
  '```',
  '',
  'Done.',
].join('\n');

// --- Validation ----------------------------------------------------------

test('validation: skill tốt → valid, quality 100, context tax > 0', () => {
  const result = validateSkillTextV13(GOOD_SKILL);
  assert.equal(result.valid, true);
  assert.equal(result.name, 'note-taker');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.qualityScore, 100);
  assert.ok(result.contextTax.headerTokens > 0);
  assert.ok(result.contextTax.bodyTokens > 0);
  assert.equal(
    result.contextTax.totalTokens,
    result.contextTax.headerTokens + result.contextTax.bodyTokens,
  );
});

test('validation: compatibility > 500 ký tự → lỗi compatibility-too-long', () => {
  const result = validateSkillTextV13(BAD_COMPAT_SKILL);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'compatibility-too-long'));
  assert.ok(result.errors[0].message.includes(String(SKILL_V13_COMPATIBILITY_MAX_LENGTH + 1)));
});

test('validation: compatibilityLength tính đúng cho string và list', () => {
  assert.equal(compatibilityLength(undefined), 0);
  assert.equal(compatibilityLength('abc'), 3);
  assert.equal(compatibilityLength(['ab', 'c']), 'ab, c'.length);
});

test('validation: description không nói khi nào dùng → lỗi description-no-trigger', () => {
  assert.equal(descriptionHasTrigger('A very nice skill.'), false);
  assert.equal(descriptionHasTrigger('Use when the user asks to take notes.'), true);
  assert.equal(descriptionHasTrigger('Khi người dùng cần ghi chú.'), true);
  const result = validateSkillTextV13(NO_TRIGGER_SKILL);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'description-no-trigger'));
});

test('validation: thiếu description → parse lỗi, quality 0', () => {
  const result = validateSkillTextV13('---\nname: no-desc\n---\n# Body\n\nText.\n');
  assert.equal(result.valid, false);
  assert.equal(result.qualityScore, 0);
  assert.ok(result.errors.length > 0);
});

test('validation: tools: + allowed-tools: cùng lúc → lỗi tools-field-clash', () => {
  const clash = detectToolsFieldClash('tools: [read_file]\nallowed-tools: [read_file]');
  assert.ok(clash);
  assert.equal(clash.code, 'tools-field-clash');
  assert.equal(detectToolsFieldClash('allowed-tools: [read_file]'), null);
  assert.equal(detectToolsFieldClash('tools: [read_file]'), null);
  const result = validateSkillFileTextV13(CLASH_SKILL);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'tools-field-clash'));
});

test('validation: license lạ → warning license-unknown-spdx, vẫn valid', () => {
  assert.ok(KNOWN_SPDX_LICENSES.includes('MIT'));
  const result = validateSkillTextV13(UNKNOWN_LICENSE_SKILL);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.code === 'license-unknown-spdx'));
  assert.ok(result.qualityScore < 100);
});

test('validation: body quá dài (> 20000 chars) → lỗi body-too-long', () => {
  const result = validateSkillTextV13(LONG_BODY_SKILL);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'body-too-long'));
});

test('validation: code fence > 50 dòng → warning body-long-code-fence', () => {
  assert.equal(longestCodeFenceLines('no fence here'), 0);
  assert.equal(longestCodeFenceLines(CODE_FENCE_BODY), 60);
  const result = validateSkillTextV13(CODE_FENCE_BODY);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.code === 'body-long-code-fence'));
});

test('validation: tên dùng "_" → warning name-underscore, vẫn valid', () => {
  const result = validateSkillTextV13(
    '---\nname: my_skill\ndescription: Use when testing underscore names.\n---\n# Body\n\nText.\n',
  );
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.code === 'name-underscore'));
});

test('validation: allowed-tools trùng + tên xấu → lỗi', () => {
  const skill = parseSkillMarkdown(
    '---\nname: dup-tools\ndescription: Use when testing duplicate tools.\nallowed-tools: [read_file, read_file]\n---\n# Body\n\nText.\n',
    'user',
  );
  const result = validateSkillV13(skill);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'allowed-tool-duplicate'));
});

test('validation: allowed-tools không nằm trong knownTools → warning, không lỗi', () => {
  const skill = parseSkillMarkdown(
    '---\nname: foreign-tools\ndescription: Use when testing foreign tools.\nallowed-tools: [some_other_host_tool]\n---\n# Body\n\nText.\n',
    'user',
  );
  const result = validateSkillV13(skill, { knownTools: ['read_file', 'write_file'] });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.code === 'allowed-tool-unknown'));
  const noKnown = validateSkillV13(skill);
  assert.ok(!noKnown.warnings.some((w) => w.code === 'allowed-tool-unknown'));
});

test('validation: disable-model-invocation + user-invocable false → warning skill-uninvocable', () => {
  const skill = parseSkillMarkdown(
    '---\nname: nobody-can-use\ndescription: Use when testing unreachable skills.\ndisable-model-invocation: true\nuser-invocable: false\n---\n# Body\n\nText.\n',
    'user',
  );
  const result = validateSkillV13(skill);
  assert.ok(result.warnings.some((w) => w.code === 'skill-uninvocable'));
});

test('validation: header-only — không đọc body, bodyTokens = 0', () => {
  const result = validateSkillHeaderV13(GOOD_SKILL);
  assert.equal(result.valid, true);
  assert.equal(result.contextTax.bodyTokens, 0);
  assert.ok(result.contextTax.headerTokens > 0);
});

test('validation: secret trong skill → parse lỗi', () => {
  const result = validateSkillTextV13(
    '---\nname: leaky\ndescription: Use when testing secrets.\n---\n# Body\n\napi_key: abcdefghijklmnop123456\n',
  );
  assert.equal(result.valid, false);
});

test('validation: validateFrontmatterObjectV13 chấp nhận object hợp lệ', () => {
  const result = validateFrontmatterObjectV13({
    name: 'obj-skill',
    description: 'Use when testing object frontmatter.',
  });
  assert.equal(result.valid, true);
  assert.equal(result.name, 'obj-skill');
  const bad = validateFrontmatterObjectV13({ description: 'Use when testing.' });
  assert.equal(bad.valid, false);
});

test('validation: formatValidationSummary in lỗi và cảnh báo', () => {
  const good = validateSkillTextV13(GOOD_SKILL);
  assert.match(formatValidationSummary(good), /valid, quality 100\/100/);
  const bad = validateSkillTextV13(BAD_COMPAT_SKILL);
  assert.match(formatValidationSummary(bad), /INVALID/);
  assert.match(formatValidationSummary(bad), /compatibility-too-long/);
});

// --- Internal registry -----------------------------------------------------

test('internal registry: 11 builtin + 4 capability = 15 entry', () => {
  assert.equal(INTERNAL_BUILTIN_SKILLS.length, 11);
  assert.equal(INTERNAL_CAPABILITY_SKILLS.length, 4);
  assert.equal(listInternalSkills().length, 15);
  assert.deepEqual(internalSkillNames(), [...internalSkillNames()].sort());
  assert.ok(isInternalSkill('code-review'));
  assert.ok(isInternalSkill('memory-recall'));
  assert.equal(isInternalSkill('no-such-skill'), false);
});

test('internal registry: getInternalSkill trả đúng entry builtin', () => {
  const entry = getInternalSkill('code-review');
  assert.ok(entry);
  assert.equal(entry.category, 'review');
  assert.deepEqual(entry.contexts, ['review', 'coding']);
  assert.ok(entry.triggers.includes('pull request'));
  assert.equal(getInternalSkill('nope'), undefined);
});

test('internal registry: search khớp trigger review/pull-request', () => {
  const hits = searchInternalSkills('please review this pull request for bugs');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].entry.name, 'code-review');
  assert.ok(hits[0].matchedTriggers.length > 0);
  assert.ok(hits[0].score >= 3);
});

test('internal registry: search tiếng Việt khớp writing-vi', () => {
  const hits = searchInternalSkills('viết lại đoạn văn bản tiếng Việt này');
  assert.ok(hits.some((h) => h.entry.name === 'writing-vi'));
});

test('internal registry: search rỗng / không khớp → []', () => {
  assert.deepEqual(searchInternalSkills(''), []);
  assert.deepEqual(searchInternalSkills('   '), []);
  assert.deepEqual(searchInternalSkills('zzzqqq www'), []);
});

test('internal registry: skillsForContext review gồm code-review, test-writing', () => {
  const names = skillsForContext('review').map((e) => e.name);
  assert.ok(names.includes('code-review'));
  assert.ok(names.includes('test-writing'));
  assert.ok(names.includes('git-workflow'));
  const voice = skillsForContext('voice').map((e) => e.name);
  assert.deepEqual(voice, ['voice-realtime']);
});

test('internal registry: byCategory coding gồm test-writing + coding-agent', () => {
  const names = internalSkillsByCategory('coding').map((e) => e.name);
  assert.deepEqual(names, ['coding-agent', 'test-writing']);
});

test('internal registry: register/unregister overlay, builtin không mất', () => {
  try {
    registerInternalSkill({
      name: 'my-custom',
      description: 'Use when testing custom overlay skills.',
      whenToUse: 'when testing',
      category: 'workflow',
      contexts: ['coding'],
      triggers: ['custom thing'],
      allowedTools: ['read_file'],
      builtin: false,
      version: '0.1.0',
      userOnly: false,
    });
    assert.ok(isInternalSkill('my-custom'));
    assert.ok(searchInternalSkills('do the custom thing now').some((h) => h.entry.name === 'my-custom'));
    assert.equal(unregisterInternalSkill('my-custom'), true);
    assert.equal(unregisterInternalSkill('my-custom'), false);
    assert.equal(isInternalSkill('my-custom'), false);
    // Overlay lên builtin rồi gỡ → builtin trở lại.
    const original = getInternalSkill('code-review');
    registerInternalSkill({ ...original, description: 'Use when testing overlay override.' });
    assert.equal(getInternalSkill('code-review').description, 'Use when testing overlay override.');
    unregisterInternalSkill('code-review');
    assert.equal(getInternalSkill('code-review').description, original.description);
  } finally {
    clearInternalSkillOverlays();
  }
});

test('internal registry: register tên xấu / không trigger → throw', () => {
  assert.throws(() =>
    registerInternalSkill({
      name: 'Bad Name',
      description: 'Use when testing.',
      whenToUse: '',
      category: 'coding',
      contexts: [],
      triggers: ['x'],
      allowedTools: [],
      builtin: false,
      version: '1.0.0',
      userOnly: false,
    }),
  );
  assert.throws(() =>
    registerInternalSkill({
      name: 'no-trigger',
      description: 'Use when testing.',
      whenToUse: '',
      category: 'coding',
      contexts: [],
      triggers: [],
      allowedTools: [],
      builtin: false,
      version: '1.0.0',
      userOnly: false,
    }),
  );
});
