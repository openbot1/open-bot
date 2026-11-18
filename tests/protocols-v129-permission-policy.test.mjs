/**
 * Protocols v5 — per-tool permission_policy tests (v1.29, Team T2).
 *
 * Covers packages/core/src/protocolsV5/mcpPermissionPolicyV5.ts:
 * pattern matching, most-specific-rule-wins, server default
 * (safe: `ask`), ask queue + resolutions (once vs always),
 * audit log, JSON round-trip, and the multi-server registry.
 *
 * No network, no provider: everything runs in-process against
 * the built core dist.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v129-permission-policy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpPermissionPolicy,
  McpPermissionPolicyRegistry,
  matchPermissionPattern,
  validatePermissionPattern,
} from '../packages/core/dist/index.js';

test('pattern matching: exact, prefix, suffix, interior wildcard, star', () => {
  assert.equal(matchPermissionPattern('*', 'anything'), true);
  assert.equal(matchPermissionPattern('read', 'read'), true);
  assert.equal(matchPermissionPattern('read', 'write'), false);
  assert.equal(matchPermissionPattern('fs:*', 'fs:read'), true);
  assert.equal(matchPermissionPattern('fs:*', 'net:read'), false);
  assert.equal(matchPermissionPattern('*:read', 'fs:read'), true);
  assert.equal(matchPermissionPattern('*:read', 'fs:write'), false);
  assert.equal(matchPermissionPattern('git:*', 'git:commit'), true);
  assert.equal(matchPermissionPattern('pre*post', 'pre-middle-post'), true);
  assert.equal(matchPermissionPattern('pre*post', 'pre-post-x'), false);
  assert.equal(matchPermissionPattern('a*b*c', 'abc'), false);
});

test('invalid patterns are refused', () => {
  assert.throws(() => validatePermissionPattern(''), /non-empty/);
  assert.throws(() => validatePermissionPattern('a*b*c'), /more than one/);
  assert.throws(() => validatePermissionPattern(' read'), /spaces/);
  assert.throws(
    () => new McpPermissionPolicy({ serverName: 's' }).setRule('a*b*c', 'allow'),
    /more than one/,
  );
});

test('default is ask (safe); explicit rules decide before the default', () => {
  const policy = new McpPermissionPolicy({ serverName: 'files' });
  assert.equal(policy.getDefault(), 'ask');

  const ask = policy.evaluate('read_file');
  assert.equal(ask.decision, 'ask');
  assert.equal(ask.source, 'server-default');
  assert.ok(ask.askId);
  assert.equal(policy.listPendingAsks().length, 1);

  policy.setRule('read_file', 'allow', 'Reading is harmless.');
  assert.equal(policy.evaluate('read_file').decision, 'allow');
  assert.equal(policy.evaluate('read_file').source, 'explicit');
  assert.match(policy.evaluate('read_file').reason, /harmless/);
});

test('most specific rule wins: exact beats prefix beats star', () => {
  const policy = new McpPermissionPolicy({ serverName: 's', defaultDecision: 'deny' });
  policy.setRule('*', 'ask');
  policy.setRule('fs:*', 'deny');
  policy.setRule('fs:read', 'allow');
  assert.equal(policy.evaluate('fs:read').decision, 'allow');
  assert.equal(policy.evaluate('fs:read').matchedPattern, 'fs:read');
  assert.equal(policy.evaluate('fs:write').decision, 'deny');
  assert.equal(policy.evaluate('other:tool').decision, 'ask');
  assert.equal(policy.evaluate('other:tool').matchedPattern, '*');
});

test('allows() is a convenience over evaluate(); setDefault changes the fallback', () => {
  const policy = new McpPermissionPolicy({ serverName: 's', defaultDecision: 'deny' });
  assert.equal(policy.allows('x'), false);
  policy.setDefault('allow');
  assert.equal(policy.allows('x'), true);
  assert.throws(() => policy.setDefault('maybe'), /Unknown permission decision/);
});

test('ask queue: one pending ask per tool; resolve once vs always', () => {
  const policy = new McpPermissionPolicy({ serverName: 'git' });
  const first = policy.evaluate('git:commit');
  const second = policy.evaluate('git:commit');
  assert.equal(first.askId, second.askId);
  assert.equal(policy.listPendingAsks().length, 1);

  const resolved = policy.resolveAsk(first.askId, 'allow-always');
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.resolution, 'allow-always');
  assert.equal(policy.listPendingAsks().length, 0);
  // allow-always wrote the rule back: no more asking.
  assert.equal(policy.evaluate('git:commit').decision, 'allow');
  assert.equal(policy.evaluate('git:commit').source, 'explicit');
  assert.equal(policy.listPendingAsks().length, 0);

  assert.throws(() => policy.resolveAsk(first.askId, 'deny-once'), /already resolved/);
  assert.throws(() => policy.resolveAsk('ask-git-999', 'deny-once'), /Unknown permission request/);
});

test('deny-once / allow-once do not write a rule back', () => {
  const policy = new McpPermissionPolicy({ serverName: 'net' });
  const ask = policy.evaluate('net:fetch');
  policy.resolveAsk(ask.askId, 'deny-once');
  // Next call asks again — nothing was persisted.
  const again = policy.evaluate('net:fetch');
  assert.equal(again.decision, 'ask');
  assert.notEqual(again.askId, ask.askId);
});

test('deny-always persists; rules can be removed and listed most-specific-first', () => {
  const policy = new McpPermissionPolicy({ serverName: 's' });
  const ask = policy.evaluate('danger:run');
  policy.resolveAsk(ask.askId, 'deny-always');
  assert.equal(policy.evaluate('danger:run').decision, 'deny');
  assert.equal(policy.removeRule('danger:run'), true);
  assert.equal(policy.removeRule('danger:run'), false);
  assert.equal(policy.evaluate('danger:run').decision, 'ask');

  policy.setRule('*', 'ask');
  policy.setRule('a:*', 'deny');
  policy.setRule('a:b', 'allow');
  assert.deepEqual(policy.listRules().map((r) => r.pattern), ['a:b', 'a:*', '*']);
});

test('audit log records every evaluation in order, including ask resolutions', () => {
  const policy = new McpPermissionPolicy({ serverName: 's' });
  policy.setRule('ok', 'allow');
  policy.evaluate('ok');
  const ask = policy.evaluate('maybe');
  policy.resolveAsk(ask.askId, 'deny-once');
  const log = policy.auditLog();
  assert.equal(log.length, 3);
  assert.deepEqual(log.map((e) => e.sequence), [1, 2, 3]);
  assert.equal(log[0].decision, 'allow');
  assert.equal(log[1].source, 'server-default');
  assert.equal(log[2].source, 'ask-resolution');
  assert.equal(log[2].decision, 'deny');
  assert.equal(policy.auditForTool('ok').length, 1);
  assert.equal(policy.auditForTool('nope').length, 0);
});

test('JSON round-trip preserves rules and default; bad JSON is refused', () => {
  const policy = new McpPermissionPolicy({ serverName: 's', defaultDecision: 'deny' });
  policy.setRule('a:*', 'allow', 'safe reads');
  policy.setRule('b', 'deny');
  const json = policy.toJSON();
  const restored = McpPermissionPolicy.fromJSON(json);
  assert.equal(restored.serverName, 's');
  assert.equal(restored.getDefault(), 'deny');
  assert.equal(restored.evaluate('a:x').decision, 'allow');
  assert.equal(restored.evaluate('b').decision, 'deny');
  assert.equal(restored.evaluate('c').decision, 'deny');
  assert.throws(() => McpPermissionPolicy.fromJSON(null), /must be an object/);
  assert.throws(() => McpPermissionPolicy.fromJSON({}), /serverName/);
  // Unknown fields / bad rules are skipped, not fatal.
  const lenient = McpPermissionPolicy.fromJSON({
    serverName: 's2',
    rules: [{ pattern: 'x', decision: 'allow' }, { pattern: 1, decision: 'allow' }, null],
  });
  assert.equal(lenient.evaluate('x').decision, 'allow');
});

test('registry keeps one policy per server and aggregates pending asks', () => {
  const registry = new McpPermissionPolicyRegistry();
  assert.equal(registry.has('a'), false);
  registry.policyFor('a', 'allow').setRule('t', 'deny');
  registry.policyFor('b'); // default ask
  assert.deepEqual(registry.serverNames(), ['a', 'b']);
  assert.equal(registry.evaluate('a', 't').decision, 'deny');
  assert.equal(registry.evaluate('a', 'other').decision, 'allow');
  assert.equal(registry.evaluate('b', 'anything').decision, 'ask');
  assert.equal(registry.listAllPendingAsks().length, 1);
  assert.equal(registry.listAllPendingAsks()[0].serverName, 'b');
});
