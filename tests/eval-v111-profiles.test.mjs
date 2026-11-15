/**
 * Tests for Agent Profiles (packages/core/src/eval/profiles.ts)
 * — v1.11, Đội T2.
 *
 * Covers: the 6 built-in profiles, validation, tool filtering,
 * system-prompt composition, model resolution (explicit model wins,
 * otherwise ModelRegistry default), profile-for-kind selection, and
 * the JSON store (enable/disable, set model, custom add/remove,
 * corrupt file falls back to built-ins).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-v111-profiles.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AGENT_PROFILES_FILE,
  AgentProfileError,
  AgentProfileStore,
  buildProfileSystemPrompt,
  builtinAgentProfiles,
  filterToolsForProfile,
  getBuiltinAgentProfile,
  profileForTaskKind,
  resolveProfileModel,
  validateAgentProfile,
} from '../packages/core/dist/eval/profiles.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-profiles-'));
}

function customProfile(id = 'my-coder') {
  return {
    id,
    label: 'My Coder',
    kind: 'coding',
    description: 'Custom coding profile.',
    provider: 'ollama',
    model: 'qwen3:8b',
    tools: ['read_file', 'write_file'],
    denyTools: [],
    systemPrompt: 'Be careful.',
    turnBudget: 10,
    maxTokensPerTurn: 0,
    enabled: true,
    builtin: false,
  };
}

test('builtinAgentProfiles: 6 profiles, all valid, unique ids, all enabled', () => {
  const profiles = builtinAgentProfiles();
  assert.equal(profiles.length, 6);
  assert.deepEqual(profiles.map((p) => p.id), ['coding', 'research', 'writing', 'review', 'general', 'data']);
  for (const profile of profiles) {
    assert.deepEqual(validateAgentProfile(profile), [], profile.id);
    assert.equal(profile.enabled, true);
    assert.equal(profile.builtin, true);
    assert.ok(profile.systemPrompt.length > 20);
    assert.ok(profile.turnBudget >= 1);
  }
  assert.equal(getBuiltinAgentProfile('coding')?.kind, 'coding');
  assert.equal(getBuiltinAgentProfile('nope'), undefined);
});

test('validateAgentProfile: reports every bad field', () => {
  const base = customProfile();
  assert.deepEqual(validateAgentProfile(base), []);
  const errors = validateAgentProfile({
    ...base, id: 'Bad!', kind: 'nope', tools: 'read_file', denyTools: ['read_file'],
    turnBudget: 0, maxTokensPerTurn: -1, enabled: 'yes', systemPrompt: '',
  });
  assert.ok(errors.length >= 6, errors.join(' | '));
  assert.deepEqual(validateAgentProfile(null), ['profile phải là một object.']);
  assert.deepEqual(validateAgentProfile([]), ['profile phải là một object.']);
});

test('filterToolsForProfile: allow-list + deny-list both enforced', () => {
  const coding = getBuiltinAgentProfile('coding');
  assert.ok(coding);
  const names = ['read_file', 'write_file', 'shell_exec', 'web_search', 'git_commit'];
  assert.deepEqual(filterToolsForProfile(coding, names), ['read_file', 'write_file', 'shell_exec']);
  const research = getBuiltinAgentProfile('research');
  assert.ok(research);
  assert.deepEqual(filterToolsForProfile(research, names), ['read_file', 'write_file', 'web_search']);
  const general = getBuiltinAgentProfile('general');
  assert.ok(general);
  // Empty allow-list = no filtering (except deny-list, which is empty here).
  assert.deepEqual(filterToolsForProfile(general, names), names);
});

test('buildProfileSystemPrompt: profile prompt first, bot prompt after; empty bot prompt ok', () => {
  const coding = getBuiltinAgentProfile('coding');
  assert.ok(coding);
  const joined = buildProfileSystemPrompt(coding, 'Bot context here.');
  assert.ok(joined.startsWith(coding.systemPrompt));
  assert.ok(joined.endsWith('Bot context here.'));
  assert.equal(buildProfileSystemPrompt(coding, ''), coding.systemPrompt);
  assert.equal(buildProfileSystemPrompt(coding, '   '), coding.systemPrompt);
});

test('resolveProfileModel: explicit model wins; empty model falls back to registry; no registry -> empty', () => {
  const withModel = customProfile();
  assert.deepEqual(resolveProfileModel(withModel), { provider: 'ollama', model: 'qwen3:8b' });
  const registryDefault = { getDefault: (provider) => (provider === 'ollama' ? 'llama3.1:8b' : '') };
  const noModel = { ...customProfile(), model: '' };
  assert.deepEqual(resolveProfileModel(noModel, registryDefault), { provider: 'ollama', model: 'llama3.1:8b' });
  assert.deepEqual(resolveProfileModel(noModel), { provider: 'ollama', model: '' });
  const throwing = { getDefault: () => { throw new Error('no provider'); } };
  assert.deepEqual(resolveProfileModel(noModel, throwing), { provider: 'ollama', model: '' });
});

test('profileForTaskKind: same-kind enabled profile wins; falls back to general; none when all disabled', () => {
  const profiles = builtinAgentProfiles();
  assert.equal(profileForTaskKind(profiles, 'coding')?.id, 'coding');
  assert.equal(profileForTaskKind(profiles, 'data')?.id, 'data');
  const withoutCoding = profiles.filter((p) => p.id !== 'coding');
  assert.equal(profileForTaskKind(withoutCoding, 'coding')?.id, 'general');
  const withoutGeneral = profiles.filter((p) => p.id !== 'general' && p.id !== 'coding');
  assert.equal(profileForTaskKind(withoutGeneral, 'coding')?.id, 'research');
  const allDisabled = profiles.map((p) => ({ ...p, enabled: false }));
  assert.equal(profileForTaskKind(allDisabled, 'coding'), undefined);
});

test('AgentProfileStore: list/get, enable/disable + setModel persist to disk', () => {
  const dir = tmpDir();
  const store = new AgentProfileStore(dir);
  assert.equal(store.list().length, 6);
  assert.equal(store.get('coding')?.enabled, true);
  const disabled = store.setEnabled('coding', false);
  assert.equal(disabled.enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, AGENT_PROFILES_FILE), 'utf-8')).overrides.coding.enabled, false);
  // A fresh store on the same dir sees the persisted change.
  const store2 = new AgentProfileStore(dir);
  assert.equal(store2.get('coding')?.enabled, false);
  assert.equal(store2.listEnabled().length, 5);
  const withModel = store2.setModel('research', 'gemini', 'gemini-2.5-flash');
  assert.equal(withModel.provider, 'gemini');
  assert.equal(withModel.model, 'gemini-2.5-flash');
  assert.throws(() => store2.setEnabled('nope', false), AgentProfileError);
  assert.throws(() => store2.setModel('nope', 'x', 'y'), AgentProfileError);
  assert.throws(() => store2.setModel('coding', '', 'y'), AgentProfileError);
});

test('AgentProfileStore: custom profiles add/remove; builtin cannot be removed', () => {
  const dir = tmpDir();
  const store = new AgentProfileStore(dir);
  const added = store.addCustom(customProfile());
  assert.equal(added.id, 'my-coder');
  assert.equal(store.list().length, 7);
  assert.throws(() => store.addCustom(customProfile()), AgentProfileError);
  assert.throws(() => store.addCustom({ ...customProfile('coding'), builtin: false }), AgentProfileError);
  assert.throws(() => store.addCustom({ ...customProfile('bad id!') }), AgentProfileError);
  assert.equal(store.removeCustom('my-coder'), true);
  assert.equal(store.list().length, 6);
  assert.equal(store.removeCustom('my-coder'), false);
  assert.throws(() => store.removeCustom('coding'), AgentProfileError);
});

test('AgentProfileStore: corrupt file falls back to built-ins; profileForKind uses the store', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, AGENT_PROFILES_FILE), '{broken json', 'utf-8');
  const store = new AgentProfileStore(dir);
  assert.equal(store.list().length, 6);
  assert.equal(store.profileForKind('writing')?.id, 'writing');
  store.setEnabled('writing', false);
  assert.equal(store.profileForKind('writing')?.id, 'general');
  // Unknown kind falls back to general.
  assert.equal(store.profileForKind('coding')?.id, 'coding');
});
