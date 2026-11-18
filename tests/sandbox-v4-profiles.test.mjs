/**
 * Tests cho Sandbox v4 — agent profiles + skill catalog (v1.36, Đội T4).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v4-profiles.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SANDBOX_V4_BUILTIN_SKILLS,
  SandboxV4ProfileStore,
  builtinSandboxV4AgentProfiles,
  getBuiltinSandboxV4Skill,
  skillsNeedHostFs,
  skillsNeedNetwork,
  toolNamesForSandboxV4Skills,
  validateSandboxV4AgentProfile,
  validateSandboxV4LlmProfile,
  validateSandboxV4SkillIds,
} from '../packages/core/dist/sandboxV4/index.js';

const GOOD_LLM = { model: 'gpt-4o', temperature: 0.2, maxTokens: 4096, topP: 1, timeoutMs: 120000 };

function goodProfile(id = 'my-coder') {
  return {
    id,
    name: 'My Coder',
    persona: 'You are a careful coder.',
    instructions: 'Read before editing. Test after changing.',
    skillIds: ['code-read', 'code-edit'],
    llm: { ...GOOD_LLM },
  };
}

test('catalog: 12 builtin skills, known ids resolve, tool names deduped', () => {
  assert.equal(SANDBOX_V4_BUILTIN_SKILLS.length, 12);
  assert.equal(new Set(SANDBOX_V4_BUILTIN_SKILLS.map((s) => s.id)).size, 12);
  assert.equal(getBuiltinSandboxV4Skill('code-read')?.name, 'Read code');
  assert.equal(getBuiltinSandboxV4Skill('nope'), undefined);
  assert.deepEqual(toolNamesForSandboxV4Skills(['code-read', 'code-review']), [
    'file_list',
    'file_read',
    'file_search',
    'git_diff',
    'git_status',
  ]);
  assert.equal(skillsNeedNetwork(['code-read']), false);
  assert.equal(skillsNeedNetwork(['web-search']), true);
  assert.equal(skillsNeedHostFs(['code-read']), false);
  assert.deepEqual(validateSandboxV4SkillIds(['code-read', 'code-edit']), []);
  assert.ok(validateSandboxV4SkillIds(['nope']).join(' ').includes('Unknown skill'));
  assert.ok(validateSandboxV4SkillIds(['code-read', 'code-read']).join(' ').includes('Duplicate'));
  assert.ok(validateSandboxV4SkillIds(['Bad ID']).join(' ').length > 0);
  assert.ok(validateSandboxV4SkillIds(['']).join(' ').length > 0);
});

test('llm profile validation: ranges enforced', () => {
  assert.deepEqual(validateSandboxV4LlmProfile({ ...GOOD_LLM }), []);
  assert.ok(validateSandboxV4LlmProfile({ ...GOOD_LLM, temperature: 2.5 }).join(' ').includes('temperature'));
  assert.ok(validateSandboxV4LlmProfile({ ...GOOD_LLM, temperature: -0.1 }).length > 0);
  assert.ok(validateSandboxV4LlmProfile({ ...GOOD_LLM, maxTokens: 1.5 }).join(' ').includes('maxTokens'));
  assert.ok(validateSandboxV4LlmProfile({ ...GOOD_LLM, maxTokens: 200000 }).length > 0);
  assert.ok(validateSandboxV4LlmProfile({ ...GOOD_LLM, topP: 1.5 }).join(' ').includes('topP'));
  assert.ok(validateSandboxV4LlmProfile({ ...GOOD_LLM, timeoutMs: -1 }).join(' ').includes('timeoutMs'));
  assert.ok(validateSandboxV4LlmProfile({ ...GOOD_LLM, model: '' }).join(' ').includes('model'));
  assert.ok(validateSandboxV4LlmProfile('nope').length > 0);
  assert.ok(validateSandboxV4LlmProfile(null).length > 0);
});

test('profile validation: every bad field is reported', () => {
  assert.deepEqual(validateSandboxV4AgentProfile(goodProfile()), []);
  const badId = validateSandboxV4AgentProfile({ ...goodProfile(), id: 'Bad ID!' });
  assert.ok(badId.join(' ').includes('id'));
  assert.ok(validateSandboxV4AgentProfile({ ...goodProfile(), name: '' }).length > 0);
  assert.ok(validateSandboxV4AgentProfile({ ...goodProfile(), persona: '   ' }).length > 0);
  assert.ok(validateSandboxV4AgentProfile({ ...goodProfile(), instructions: '' }).length > 0);
  assert.ok(validateSandboxV4AgentProfile({ ...goodProfile(), skillIds: [] }).join(' ').includes('at least one'));
  assert.ok(validateSandboxV4AgentProfile({ ...goodProfile(), skillIds: ['nope'] }).join(' ').includes('Unknown skill'));
  assert.ok(validateSandboxV4AgentProfile({ ...goodProfile(), llm: { ...GOOD_LLM, temperature: 9 } }).length > 0);
  assert.ok(validateSandboxV4AgentProfile(null).length > 0);
  assert.ok(validateSandboxV4AgentProfile('x').length > 0);
});

test('builtins: 5 profiles, valid, deterministic system prompts', () => {
  const now = 1700000000000;
  const builtins = builtinSandboxV4AgentProfiles(now);
  assert.equal(builtins.length, 5);
  assert.deepEqual(builtins.map((p) => p.id), ['generalist', 'coder', 'researcher', 'planner', 'reviewer']);
  for (const profile of builtins) {
    assert.deepEqual(validateSandboxV4AgentProfile(profile), [], profile.id);
    assert.equal(profile.builtin, true);
    assert.equal(profile.version, 1);
    assert.equal(profile.createdAtMs, now);
  }
  const store = new SandboxV4ProfileStore(() => now);
  assert.equal(store.size(), 5);
  const coderPrompt = store.systemPromptForId('coder');
  assert.match(coderPrompt, /expert software engineer/);
  assert.match(coderPrompt, /Read the code before editing/);
  assert.match(coderPrompt, /code-read/);
  assert.match(coderPrompt, /gpt-4o/);
  assert.match(coderPrompt, /temperature 0.2/);
  // Deterministic: same profile, same prompt.
  assert.equal(store.systemPromptForId('coder'), coderPrompt);
  // Researcher may use the network; planner may not.
  assert.equal(skillsNeedNetwork(store.get('researcher').skillIds), true);
  assert.equal(skillsNeedNetwork(store.get('planner').skillIds), false);
  assert.throws(() => store.systemPromptForId('nope'), /Unknown agent profile/);
});

test('store: create / update / delete customs; builtins are immutable', () => {
  let now = 1700000000000;
  const store = new SandboxV4ProfileStore(() => now);
  const created = store.create(goodProfile());
  assert.equal(created.ok, true);
  assert.equal(created.profile?.builtin, false);
  assert.equal(created.profile?.version, 1);
  assert.equal(store.size(), 6);

  assert.equal(store.create(goodProfile()).ok, false, 'duplicate id');
  assert.equal(store.create({ ...goodProfile(), id: 'coder' }).ok, false, 'builtin id');
  assert.equal(store.create({ ...goodProfile(), id: 'bad2', skillIds: ['nope'] }).ok, false);

  now += 1000;
  const updated = store.update('my-coder', { name: 'My Coder v2', llm: { ...GOOD_LLM, model: 'claude-sonnet-4' } });
  assert.equal(updated.ok, true);
  assert.equal(updated.profile?.name, 'My Coder v2');
  assert.equal(updated.profile?.llm.model, 'claude-sonnet-4');
  assert.equal(updated.profile?.version, 2);
  assert.equal(updated.profile?.updatedAtMs, now);
  assert.equal(updated.profile?.createdAtMs, 1700000000000);

  assert.equal(store.update('my-coder', { skillIds: ['nope'] }).ok, false, 'bad update rejected');
  assert.equal(store.get('my-coder')?.version, 2, 'failed update keeps version');
  assert.equal(store.update('coder', { name: 'X' }).ok, false, 'builtin cannot be edited');
  assert.equal(store.update('nope', { name: 'X' }).ok, false);
  assert.equal(store.delete('coder').ok, false, 'builtin cannot be deleted');
  assert.equal(store.delete('nope').ok, false);
  const deleted = store.delete('my-coder');
  assert.equal(deleted.ok, true);
  assert.equal(store.size(), 5);
  assert.equal(store.get('my-coder'), undefined);
});

test('store: summarize + export/import round-trip (newer wins)', () => {
  const store = new SandboxV4ProfileStore(() => 1700000000000);
  const summary = store.summarize();
  assert.equal(summary.length, 5);
  const coder = summary.find((s) => s.id === 'coder');
  assert.equal(coder?.builtin, true);
  assert.equal(coder?.model, 'gpt-4o');
  assert.ok(coder.skillCount > 0);
  assert.ok(coder.toolCount > 0);

  store.create(goodProfile());
  const exported = store.exportJson();
  const parsed = JSON.parse(exported);
  assert.equal(parsed.profiles.length, 1, 'builtins are not exported');
  assert.equal(parsed.profiles[0].id, 'my-coder');

  const other = new SandboxV4ProfileStore(() => 1700000001000);
  const imported = other.importJson(exported);
  assert.deepEqual({ imported: imported.imported, skipped: imported.skipped }, { imported: 1, skipped: 0 });
  assert.equal(other.size(), 6);
  // Re-importing the same (older-or-equal) document is skipped.
  const again = other.importJson(exported);
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 1);
  // Invalid entries are skipped and reported, valid ones still import.
  const mixed = JSON.stringify({
    version: 1,
    profiles: [
      { ...goodProfile('good-two'), name: 'Good Two' },
      { ...goodProfile('bad-three'), skillIds: ['nope'] },
      { ...goodProfile('coder'), name: 'Fake builtin' },
    ],
  });
  const mixedResult = other.importJson(mixed);
  assert.equal(mixedResult.imported, 1);
  assert.equal(mixedResult.skipped, 2);
  assert.equal(mixedResult.problems.length, 2);
  assert.equal(other.get('good-two')?.name, 'Good Two');
  assert.deepEqual(other.importJson('not json').imported, 0);
  assert.deepEqual(other.importJson('[]').imported, 0);
});

test('store: list order — builtins first, then customs, sorted by id', () => {
  const store = new SandboxV4ProfileStore(() => 1700000000000);
  store.create(goodProfile('zeta'));
  store.create(goodProfile('alpha'));
  assert.deepEqual(
    store.list().map((p) => p.id),
    ['coder', 'generalist', 'planner', 'researcher', 'reviewer', 'alpha', 'zeta'],
  );
});
