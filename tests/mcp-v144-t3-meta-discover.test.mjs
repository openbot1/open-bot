/**
 * Test v1.44 T3: _meta / discover extended — meta parsing, inventory,
 * compatibility, diff (node:test, no network).
 *
 * Covers:
 *   - packages/core/src/mcp/metaDiscoverV2.ts
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v144-t3-meta-discover.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCapabilityInventory,
  checkHostCompatibility,
  describeDiscoveryDiff,
  describeInventory,
  diffDiscoveries,
  fingerprintDiscover,
  mergeMeta,
  metaToPlain,
  parseRequestMeta,
  parseResultMeta,
} from '../packages/core/dist/mcp/metaDiscoverV2.js';

function makeDoc(overrides = {}) {
  return {
    protocolVersion: '2026-07-28',
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      tasks: { supported: true },
      apps: { supported: true },
    },
    serverInfo: { name: 'acme', version: '1.2.3' },
    extensions: ['io.modelcontextprotocol/tasks'],
    tools: [
      { name: 'search', description: 'Search the web', version: '1.0.0', inputSchema: { type: 'object' } },
      { name: 'fetch', description: 'Fetch a URL', version: '1.0.0' },
      { name: 'nodoc', version: '1.0.0' },
    ],
    resources: [{ name: 'file://docs', description: 'Docs' }],
    prompts: [{ name: 'summarise', description: 'Summarise text' }],
    ...overrides,
  };
}

test('parseRequestMeta: progressToken + task ttl + extension keys, extras kept', () => {
  const meta = parseRequestMeta({
    progressToken: 'tok-1',
    task: { ttl: 60_000 },
    'io.modelcontextprotocol/tasks': { foo: 1 },
    custom: 'kept',
  });
  assert.equal(meta.progressToken, 'tok-1');
  assert.deepEqual(meta.task, { ttl: 60_000 });
  assert.deepEqual(meta.extensions, { 'io.modelcontextprotocol/tasks': { foo: 1 } });
  assert.deepEqual(meta.extra, { custom: 'kept' });
  assert.equal(parseRequestMeta(undefined).progressToken, undefined);
});

test('parseRequestMeta: bad progressToken / task ttl / non-object throw', () => {
  assert.throws(() => parseRequestMeta({ progressToken: {} }), /progressToken/);
  assert.throws(() => parseRequestMeta({ progressToken: '' }), /progressToken/);
  assert.throws(() => parseRequestMeta({ task: { ttl: -1 } }), /ttl/);
  assert.throws(() => parseRequestMeta({ task: 'x' }), /task/);
  assert.throws(() => parseRequestMeta('nope'), /object/);
});

test('parseResultMeta: task handle validated, bad status rejected', () => {
  const meta = parseResultMeta({ task: { taskId: 't-1', status: 'working', pollInterval: 500 } });
  assert.deepEqual(meta.task, { taskId: 't-1', status: 'working', pollInterval: 500 });
  assert.throws(() => parseResultMeta({ task: { taskId: 't-1', status: 'weird' } }), /status/);
  assert.throws(() => parseResultMeta({ task: { status: 'working' } }), /taskId/);
  assert.throws(() => parseResultMeta({ task: { taskId: '', status: 'working' } }), /taskId/);
});

test('mergeMeta + metaToPlain: client wins, extensions union, empty -> undefined', () => {
  const merged = mergeMeta(
    { progressToken: 'c1', task: { ttl: 1000 }, extensions: { 'x-a': 1 } },
    { progressToken: 's1', extensions: { 'x-b': 2 }, extra: { e: 1 } },
  );
  assert.equal(merged.progressToken, 'c1');
  assert.deepEqual(merged.task, { ttl: 1000 });
  assert.deepEqual(merged.extensions, { 'x-a': 1, 'x-b': 2 });
  assert.deepEqual(merged.extra, { e: 1 });
  assert.equal(metaToPlain({}), undefined);
  assert.deepEqual(metaToPlain({ progressToken: 'p' }), { progressToken: 'p' });
  // Server token used when the client has none.
  assert.equal(mergeMeta({}, { progressToken: 's9' }).progressToken, 's9');
});

test('fingerprintDiscover: stable for same doc, changes when doc changes', () => {
  const a = fingerprintDiscover(makeDoc());
  const b = fingerprintDiscover(makeDoc());
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, fingerprintDiscover(makeDoc({ protocolVersion: '2025-11-25' })));
});

test('buildCapabilityInventory: counts, flags, findings (missing description)', () => {
  const inv = buildCapabilityInventory(makeDoc());
  assert.equal(inv.serverName, 'acme');
  assert.equal(inv.serverVersion, '1.2.3');
  assert.equal(inv.tools.length, 3);
  assert.equal(inv.resources.length, 1);
  assert.equal(inv.prompts.length, 1);
  assert.equal(inv.tasksSupported, true);
  assert.equal(inv.appsSupported, true);
  assert.deepEqual(inv.extensions, ['io.modelcontextprotocol/tasks']);
  assert.equal(inv.fingerprint.length, 64);
  const missing = inv.findings.filter((f) => f.code === 'missing-description');
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.capability, 'nodoc');
  assert.match(describeInventory(inv), /3 tool, 1 resource, 1 prompt/);
});

test('buildCapabilityInventory: duplicate names are errors; record-form capabilities work', () => {
  const dup = buildCapabilityInventory(makeDoc({
    tools: [
      { name: 'search', description: 'a' },
      { name: 'search', description: 'b' },
    ],
  }));
  assert.equal(dup.findings.filter((f) => f.code === 'duplicate-capability').length, 1);

  const recordForm = buildCapabilityInventory({
    protocolVersion: '2026-07-28',
    capabilities: {
      tools: { list: [{ name: 'x', description: 'X tool' }] },
      tasks: {},
      apps: {},
    },
    serverInfo: { name: 'rec', version: '0.1.0' },
  });
  assert.equal(recordForm.tools.length, 1);
  assert.equal(recordForm.tools[0]?.name, 'x');
  assert.equal(recordForm.tasksSupported, true); // record without supported:false
});

test('buildCapabilityInventory: oversized schema is a warning', () => {
  const big = buildCapabilityInventory(makeDoc({
    tools: [{ name: 'huge', description: 'big', blob: 'x'.repeat(70 * 1024) }],
  }));
  assert.equal(big.findings.filter((f) => f.code === 'oversized-schema').length, 1);
});

test('checkHostCompatibility: ready / degraded / incompatible + deterministic score', () => {
  const host = { protocolVersions: ['2026-07-28'], supportsTasks: true, supportsApps: true };
  const ready = checkHostCompatibility(buildCapabilityInventory(makeDoc()), host);
  assert.equal(ready.verdict, 'ready');
  assert.equal(ready.score, 100);

  const old = checkHostCompatibility(
    buildCapabilityInventory(makeDoc({ protocolVersion: '2024-11-05' })),
    host,
  );
  assert.equal(old.verdict, 'incompatible');
  assert.equal(old.score, 60);
  assert.deepEqual(old.missing, ['protocol 2024-11-05']);

  const noApps = checkHostCompatibility(buildCapabilityInventory(makeDoc()), {
    protocolVersions: ['2026-07-28'],
    supportsTasks: true,
    supportsApps: false,
  });
  assert.equal(noApps.verdict, 'degraded');
  assert.deepEqual(noApps.unsupported, ['apps']);

  const tooMany = checkHostCompatibility(buildCapabilityInventory(makeDoc()), {
    ...host,
    maxTools: 2,
  });
  assert.equal(tooMany.verdict, 'degraded');
  assert.match(tooMany.reasons.join(' '), /vượt giới hạn/);
});

test('diffDiscoveries: added / removed / version-changed / breaking', () => {
  const before = buildCapabilityInventory(makeDoc());
  const after = buildCapabilityInventory(makeDoc({
    tools: [
      { name: 'search', description: 'Search the web', version: '2.0.0' },
      { name: 'fetch', description: 'Fetch a URL', version: '1.0.0' },
      { name: 'brand-new', description: 'New tool', version: '1.0.0' },
    ],
  }));
  const diff = diffDiscoveries(before, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0]?.name, 'brand-new');
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0]?.name, 'nodoc');
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]?.change, 'version-changed');
  assert.equal(diff.changed[0]?.from, '1.0.0');
  assert.equal(diff.changed[0]?.to, '2.0.0');
  assert.equal(diff.breaking, true);
  assert.equal(diff.fingerprintChanged, true);
  assert.match(describeDiscoveryDiff(diff), /BREAKING/);

  const same = diffDiscoveries(before, buildCapabilityInventory(makeDoc()));
  assert.equal(same.breaking, false);
  assert.equal(same.fingerprintChanged, false);
  assert.match(describeDiscoveryDiff(same), /không đổi/);
});
