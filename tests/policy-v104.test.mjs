/**
 * Tests for v1.04 policy-as-config (packages/core/src/policy/):
 * YAML-subset parse/emit, JSON/YAML policy validation, tool/path/
 * network evaluation, prompt compilation, the PreToolUse enforcement
 * hook, the file store, and the audit log.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/policy-v104.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendPolicyAudit,
  compilePolicyToPrompt,
  createPolicyHook,
  defaultPolicy,
  diffPolicies,
  emitYamlSubset,
  evaluateToolCall,
  getPolicyPreset,
  hashPolicy,
  listPolicyPresets,
  loadBehaviorPolicy,
  matchHostGlob,
  matchPathGlob,
  parsePolicyDocument,
  parseYamlSubset,
  PolicyYamlError,
  readPolicyAudit,
  saveBehaviorPolicy,
  stringifyPolicy,
  validatePolicy,
} from '../packages/core/dist/policy/index.js';
import { HookRegistry, HookRunner } from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-policy-v104-'));
  tempDirs.push(dir);
  return dir;
}

const STRICT = {
  version: 1,
  name: 'strict',
  rules: {
    tools: { allow: ['read', 'glob_*'], deny: ['delete_file', 'shell-*'], requireApproval: ['apply_diff'] },
    paths: { writeDeny: ['**/.env*', '**/*.pem'], readDeny: ['**/.env*'] },
    network: { allowHosts: ['trusted.example.com'], denyHosts: ['evil.example.com', '*.tracker.example'] },
    model: { maxSteps: 25 },
  },
  defaults: { toolDecision: 'deny', pathDecision: 'deny', networkDecision: 'deny' },
};

test('yaml subset: maps, lists, nesting, quotes, flow, comments', () => {
  const doc = `
# comment
version: 1
name: 'my policy' # trailing comment
enabled: true
ratio: 1.5
nothing: null
nothing2: ~
tools:
  deny:
    - delete_file
    - shell-*
  allow: [read, glob_*]
nested:
  - key: value
    count: 3
  - plain
empty-list: []
empty-map: {}
`;
  const parsed = parseYamlSubset(doc);
  assert.deepEqual(parsed, {
    version: 1,
    name: 'my policy',
    enabled: true,
    ratio: 1.5,
    nothing: null,
    nothing2: null,
    tools: { deny: ['delete_file', 'shell-*'], allow: ['read', 'glob_*'] },
    nested: [{ key: 'value', count: 3 }, 'plain'],
    'empty-list': [],
    'empty-map': {},
  });
  // Round-trip through the emitter.
  const emitted = emitYamlSubset(parsed);
  assert.deepEqual(parseYamlSubset(emitted), parsed);
});

test('yaml subset: rejects tabs, anchors, block scalars, duplicate keys', () => {
  assert.throws(() => parseYamlSubset('a:\n\tb: 1\n'), PolicyYamlError);
  assert.throws(() => parseYamlSubset('a: &x 1\n'), PolicyYamlError);
  assert.throws(() => parseYamlSubset('a: |\n  multi\n  line\n'), PolicyYamlError);
  assert.throws(() => parseYamlSubset('a: 1\na: 2\n'), PolicyYamlError);
  assert.throws(() => parseYamlSubset('a: *x\n'), PolicyYamlError);
  assert.throws(() => parseYamlSubset('just a string without colon\n'), PolicyYamlError);
  assert.equal(parseYamlSubset(''), null);
  assert.equal(parseYamlSubset('# only a comment\n'), null);
});

test('yaml subset: single-quote escaping and double-quote escapes', () => {
  assert.deepEqual(parseYamlSubset(`a: 'it''s'`), { a: "it's" });
  assert.deepEqual(parseYamlSubset('a: "line\\nbreak"'), { a: 'line\nbreak' });
  assert.deepEqual(parseYamlSubset('a: "say \\"hi\\""'), { a: 'say "hi"' });
  assert.throws(() => parseYamlSubset(`a: 'unterminated`), PolicyYamlError);
});

test('validatePolicy: accepts a good policy (JSON + YAML)', () => {
  const json = parsePolicyDocument(JSON.stringify(STRICT), 'json');
  assert.equal(json.issues.length, 0, JSON.stringify(json.issues));
  assert.equal(json.policy.name, 'strict');
  const yaml = parsePolicyDocument(stringifyPolicy(STRICT, 'yaml'), 'yaml');
  assert.equal(yaml.issues.length, 0, JSON.stringify(yaml.issues));
  assert.deepEqual(yaml.policy, STRICT);
});

test('validatePolicy: rejects bad version, unknown keys, empty rules, bad values', () => {
  const cases = [
    [{ version: 2, name: 'x', rules: { tools: {} } }, 'version'],
    [{ version: 1, name: '', rules: { tools: {} } }, 'name'],
    [{ version: 1, name: 'x', rules: {} }, 'rules'],
    [{ version: 1, name: 'x', rules: { toolz: {} } }, 'rules.toolz'],
    [{ version: 1, name: 'x', rules: { tools: { deny: 'delete_file' } } }, 'rules.tools.deny'],
    [{ version: 1, name: 'x', rules: { tools: { deny: [''] } } }, 'rules.tools.deny[0]'],
    [{ version: 1, name: 'x', rules: { model: { maxSteps: 0 } } }, 'rules.model.maxSteps'],
    [{ version: 1, name: 'x', rules: { tools: {} }, defaults: { toolDecision: 'maybe' } }, 'defaults.toolDecision'],
    [{ version: 1, name: 'x', rules: { tools: {} }, extra: 1 }, 'extra'],
  ];
  for (const [value, field] of cases) {
    const result = validatePolicy(value);
    assert.equal(result.policy, null, `expected rejection for ${field}`);
    assert.ok(
      result.issues.some((i) => i.field === field),
      `expected an issue at ${field}, got ${JSON.stringify(result.issues)}`,
    );
  }
  assert.equal(validatePolicy('not an object').policy, null);
  assert.equal(parsePolicyDocument('{invalid json', 'json').policy, null);
});

test('defaultPolicy: denies the destructive tools', () => {
  const p = defaultPolicy();
  assert.equal(p.version, 1);
  assert.ok(p.rules.tools.deny.includes('delete_file'));
  assert.equal(validatePolicy(p).policy !== null, true);
});

test('matchPathGlob: * crosses directories; ? does not', () => {
  assert.equal(matchPathGlob('**/.env*', '.env'), true);
  assert.equal(matchPathGlob('**/.env*', 'a/b/.env.local'), true);
  assert.equal(matchPathGlob('*.pem', 'a/b/key.pem'), true);
  assert.equal(matchPathGlob('src/*.ts', 'src/a.ts'), true);
  assert.equal(matchPathGlob('src/?.ts', 'src/a.ts'), true);
  assert.equal(matchPathGlob('src/?.ts', 'src/ab.ts'), false);
  assert.equal(matchPathGlob('*.env', 'x.env'), true);
});

test('matchHostGlob: exact and wildcard subdomains', () => {
  assert.equal(matchHostGlob('api.example.com', 'api.example.com'), true);
  assert.equal(matchHostGlob('api.example.com', 'other.example.com'), false);
  assert.equal(matchHostGlob('*.example.com', 'a.example.com'), true);
  assert.equal(matchHostGlob('*.example.com', 'example.com'), false);
  assert.equal(matchHostGlob('*', 'anything.example'), true);
});

test('evaluateToolCall: deny beats everything; approval is separate', () => {
  assert.equal(evaluateToolCall(STRICT, 'delete_file', {}).decision, 'block');
  assert.equal(evaluateToolCall(STRICT, 'shell-exec', {}).decision, 'block');
  assert.equal(evaluateToolCall(STRICT, 'shell-anything', {}).decision, 'block');
  const approval = evaluateToolCall(STRICT, 'apply_diff', {});
  assert.equal(approval.decision, 'needs-approval');
  assert.equal(approval.rule, 'tools.requireApproval');
  // In the allow-list: allowed even under deny-by-default.
  assert.equal(evaluateToolCall(STRICT, 'read', {}).decision, 'allow');
  assert.equal(evaluateToolCall(STRICT, 'glob_files', {}).decision, 'allow');
  // Not in the allow-list, deny-by-default: blocked.
  assert.equal(evaluateToolCall(STRICT, 'browser_navigate', {}).decision, 'block');
  // ...but with permissive defaults it is allowed.
  const permissive = { ...STRICT, defaults: undefined };
  assert.equal(evaluateToolCall(permissive, 'browser_navigate', {}).decision, 'allow');
  assert.equal(evaluateToolCall(permissive, 'delete_file', {}).decision, 'block');
});

test('evaluateToolCall: path rules (read vs write, inside workspace)', () => {
  const policy = {
    version: 1,
    name: 'paths',
    rules: { paths: { writeDeny: ['**/.env*'], readAllow: ['src/**'] } },
    defaults: { pathDecision: 'deny' },
  };
  // Write to .env is denied even though no allow-list blocks it first.
  assert.equal(evaluateToolCall(policy, 'apply_diff', { path: '.env' }).decision, 'block');
  assert.equal(evaluateToolCall(policy, 'apply_diff', { path: 'src/a.ts' }).decision, 'allow');
  // A read of a non-listed path is blocked under path deny-by-default.
  assert.equal(evaluateToolCall(policy, 'read', { path: 'other/b.txt' }).decision, 'block');
  assert.equal(evaluateToolCall(policy, 'read', { path: 'src/b.txt' }).decision, 'allow');
  // Writes outside the workspace are blocked by default.
  const ws = makeTempDir();
  assert.equal(
    evaluateToolCall(policy, 'apply_diff', { path: '/etc/passwd' }, { workspaceDir: ws }).decision,
    'block',
  );
  // ...unless the policy opts out of the inside-workspace rule.
  const noWsRule = {
    version: 1, name: 'paths2',
    rules: { paths: { requireInsideWorkspace: false } },
  };
  assert.equal(
    evaluateToolCall(noWsRule, 'apply_diff', { path: '/etc/passwd' }, { workspaceDir: ws }).decision,
    'allow',
  );
});

test('evaluateToolCall: network rules', () => {
  const net = {
    version: 1,
    name: 'net',
    rules: { network: { allowHosts: ['trusted.example.com'], denyHosts: ['evil.example.com', '*.tracker.example'] } },
    defaults: { networkDecision: 'deny' },
  };
  assert.equal(
    evaluateToolCall(net, 'browser_navigate', { url: 'https://evil.example.com/x' }).decision,
    'block',
  );
  assert.equal(
    evaluateToolCall(net, 'browser_navigate', { url: 'https://a.tracker.example/x' }).decision,
    'block',
  );
  assert.equal(
    evaluateToolCall(net, 'browser_navigate', { url: 'https://ok.example.com/x' }).decision,
    'block',
    'deny-by-default network: unlisted host is blocked',
  );
  assert.equal(
    evaluateToolCall(net, 'browser_navigate', { url: 'https://trusted.example.com/x' }).decision,
    'allow',
  );
  const permissive = { version: 1, name: 'net2', rules: { network: { denyHosts: ['evil.example.com'] } } };
  assert.equal(
    evaluateToolCall(permissive, 'browser_navigate', { url: 'https://ok.example.com/x' }).decision,
    'allow',
  );
  // A non-URL argument is not a network call.
  assert.equal(evaluateToolCall(permissive, 'read', { path: 'a.txt' }).decision, 'allow');
});

test('compilePolicyToPrompt: renders every rule group deterministically', () => {
  const prompt = compilePolicyToPrompt(STRICT);
  assert.ok(prompt.includes('## Behavioral policy: strict (version 1)'));
  assert.ok(prompt.includes('delete_file'));
  assert.ok(prompt.includes('shell-*'));
  assert.ok(prompt.includes('apply_diff'));
  assert.ok(prompt.includes('**/.env*'));
  assert.ok(prompt.includes('evil.example.com'));
  assert.ok(prompt.includes('Maximum 25 steps'));
  assert.ok(prompt.includes('default-deny'));
  assert.equal(compilePolicyToPrompt(STRICT), prompt, 'deterministic');
});

test('createPolicyHook: blocks denied calls via the runner, allows the rest', async () => {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  registry.register(createPolicyHook(STRICT, { workspaceDir: makeTempDir() }));
  const runner = new HookRunner(registry);
  const blocked = await runner.runPreToolUse({ toolName: 'delete_file', toolCallId: 'c1', args: { path: 'a.txt' } });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.blockedBy, 'policy-enforcer');
  assert.ok(blocked.reason.includes('delete_file'));
  const needsApproval = await runner.runPreToolUse({ toolName: 'apply_diff', toolCallId: 'c2', args: {} });
  assert.equal(needsApproval.decision, 'block', 'needs-approval maps to fail-closed block');
  assert.ok(needsApproval.reason.includes('duyệt'));
  const allowed = await runner.runPreToolUse({ toolName: 'read', toolCallId: 'c3', args: { path: 'src/a.ts' } });
  assert.equal(allowed.decision, 'allow', 'read is in tools.allow and src/a.ts is not denied');
  // The policy hook runs first (priority 10) — a later allow-hook cannot unblock it.
  const seen = [];
  registry.register({
    name: 'late-allow', events: ['PreToolUse'],
    handler: () => { seen.push('late'); return undefined; },
    source: 'builtin', enabled: true, priority: 200,
  });
  await runner.runPreToolUse({ toolName: 'delete_file', toolCallId: 'c4', args: {} });
  assert.deepEqual(seen, [], 'first block wins: later hooks never run');
});

test('store: save + load round-trip (yaml + json), invalid save writes nothing', () => {
  const ws = makeTempDir();
  const saved = saveBehaviorPolicy(ws, STRICT);
  assert.equal(saved.ok, true);
  assert.ok(saved.filePath.endsWith('policy.yaml'));
  const loaded = loadBehaviorPolicy(ws);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.policy.name, 'strict');
  assert.equal(loaded.sha256, hashPolicy(STRICT));
  // JSON format.
  const savedJson = saveBehaviorPolicy(ws, { ...STRICT, name: 'strict-json' }, { format: 'json' });
  assert.equal(savedJson.ok, true);
  assert.ok(savedJson.filePath.endsWith('policy.json'));
  // YAML wins when both exist.
  assert.equal(loadBehaviorPolicy(ws).policy.name, 'strict');
  // Invalid policy: nothing written.
  const bad = saveBehaviorPolicy(ws, { version: 99, name: 'bad', rules: {} });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.length > 0);
  assert.equal(loadBehaviorPolicy(ws).policy.name, 'strict', 'previous policy untouched');
  // Missing policy: exists false, no issues.
  const empty = loadBehaviorPolicy(makeTempDir());
  assert.deepEqual(empty, { policy: null, exists: false, issues: [] });
  // Present but broken file: issues, no crash.
  const broken = makeTempDir();
  fs.mkdirSync(path.join(broken, '.open-bot'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.open-bot', 'policy.yaml'), 'version: 1\nname: [\n', 'utf-8');
  const loadedBroken = loadBehaviorPolicy(broken);
  assert.equal(loadedBroken.exists, true);
  assert.equal(loadedBroken.policy, null);
  assert.ok(loadedBroken.issues.length > 0);
});

test('audit: append + read + diff, corrupt lines skipped', () => {
  const dir = makeTempDir();
  appendPolicyAudit(dir, { action: 'created', name: 'a', version: 1, sha256: 'aaa', actor: 'user', ts: '2026-01-01T00:00:00.000Z' });
  appendPolicyAudit(dir, { action: 'updated', name: 'a', version: 1, sha256: 'bbb', prevSha256: 'aaa', note: 'tightened', ts: '2026-01-01T00:00:01.000Z' });
  const { entries, skippedLines } = readPolicyAudit(dir);
  assert.equal(entries.length, 2);
  assert.equal(skippedLines, 0);
  assert.equal(entries[0].action, 'updated', 'newest first');
  assert.equal(entries[0].prevSha256, 'aaa');
  assert.equal(entries[1].sha256, 'aaa');
  // Corrupt line: skipped, not fatal.
  fs.appendFileSync(path.join(dir, 'policy-audit.jsonl'), 'not json\n', 'utf-8');
  const reread = readPolicyAudit(dir);
  assert.equal(reread.entries.length, 2);
  assert.equal(reread.skippedLines, 1);
  // Missing file: empty log.
  assert.deepEqual(readPolicyAudit(makeTempDir()), { entries: [], skippedLines: 0 });
  // Diff.
  const diff = diffPolicies({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: 4 });
  assert.deepEqual(diff, [
    { path: 'b.c', before: 2, after: 3, kind: 'changed' },
    { path: 'd', before: undefined, after: 4, kind: 'added' },
  ]);
  // A save writes an audit entry.
  const ws = makeTempDir();
  saveBehaviorPolicy(ws, STRICT, { stateDir: path.join(ws, '.open-bot') });
  const audit = readPolicyAudit(path.join(ws, '.open-bot'));
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].action, 'created');
});

test('policy presets: all three validate; strict blocks shell, read-only blocks writes', () => {
  const ids = listPolicyPresets().map((p) => p.id);
  assert.deepEqual(ids, ['strict', 'read-only', 'permissive']);
  for (const id of ids) {
    const preset = getPolicyPreset(id);
    assert.notEqual(preset, null);
    assert.equal(validatePolicy(preset).issues.length, 0, `${id}: ${JSON.stringify(validatePolicy(preset).issues)}`);
  }
  assert.equal(getPolicyPreset('nope'), null);
  // Presets are copies: mutating one never changes the table.
  const a = getPolicyPreset('strict');
  a.rules.tools.deny.push('read');
  assert.equal(getPolicyPreset('strict').rules.tools.deny.includes('read'), false);

  const strict = getPolicyPreset('strict');
  assert.equal(evaluateToolCall(strict, 'shell-exec', {}).decision, 'block');
  assert.equal(evaluateToolCall(strict, 'read', {}).decision, 'allow');
  assert.equal(evaluateToolCall(strict, 'apply_diff', {}).decision, 'needs-approval');
  const readOnly = getPolicyPreset('read-only');
  assert.equal(evaluateToolCall(readOnly, 'apply_diff', {}).decision, 'block');
  assert.equal(evaluateToolCall(readOnly, 'read', {}).decision, 'allow');
  const permissive = getPolicyPreset('permissive');
  assert.equal(evaluateToolCall(permissive, 'read', {}).decision, 'allow');
  assert.equal(evaluateToolCall(permissive, 'delete_file', {}).decision, 'block');
});

after(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});
