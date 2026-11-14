/**
 * Test v1.04 T2: MCP 2.0 stateless auto-negotiation (node:test).
 * Local only, no network: fake clients drive the negotiator.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v104-stateless-auto.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attachStatelessMetaToParams,
  buildRequestStatelessMeta,
  describeStatelessNegotiation,
  negotiateStatelessConnection,
  statelessCapabilitiesFor,
} from '../packages/core/dist/mcp/statelessClient.js';

function discoverDoc(version = '2026-07-28') {
  return {
    protocolVersion: version,
    capabilities: { tools: {}, resources: {}, prompts: {} },
    serverInfo: { name: 'fake', version: '1.0.0' },
  };
}

function fakeClient({ discoverResult = undefined, discoverThrows = false, initializeVersion = '2025-11-25' } = {}) {
  return {
    discoverCalls: 0,
    initializeCalls: 0,
    async discover() {
      this.discoverCalls += 1;
      if (discoverThrows) throw new Error('discover boom');
      return discoverResult === undefined ? null : discoverResult;
    },
    async initialize() {
      this.initializeCalls += 1;
      return { protocolVersion: initializeVersion };
    },
  };
}

test('auto: 2026 server -> stateless, no handshake', async () => {
  const client = fakeClient({ discoverResult: discoverDoc() });
  const n = await negotiateStatelessConnection(client, 'auto');
  assert.equal(n.mode, 'stateless');
  assert.equal(n.protocolVersion, '2026-07-28');
  assert.equal(n.fellBack, false);
  assert.equal(n.discoveredOlderVersion, false);
  assert.equal(client.discoverCalls, 1);
  assert.equal(client.initializeCalls, 0);
});

test('auto: pre-2.0 server (discover null) -> handshake fallback', async () => {
  const client = fakeClient({ discoverResult: null, initializeVersion: '2025-11-25' });
  const n = await negotiateStatelessConnection(client, 'auto');
  assert.equal(n.mode, 'handshake');
  assert.equal(n.protocolVersion, '2025-11-25');
  assert.equal(n.fellBack, true);
  assert.equal(n.discovered, null);
  assert.equal(client.initializeCalls, 1);
});

test('auto: older discovery document -> stateless but flagged older', async () => {
  const client = fakeClient({ discoverResult: discoverDoc('2025-06-18') });
  const n = await negotiateStatelessConnection(client, 'auto');
  assert.equal(n.mode, 'stateless');
  assert.equal(n.protocolVersion, '2025-06-18');
  assert.equal(n.discoveredOlderVersion, true);
  assert.equal(client.initializeCalls, 0);
});

test('auto: discover throws -> handshake fallback; both fail -> throws', async () => {
  const client = fakeClient({ discoverThrows: true, initializeVersion: '2025-11-25' });
  const n = await negotiateStatelessConnection(client, 'auto');
  assert.equal(n.mode, 'handshake');
  assert.equal(n.fellBack, true);

  const failing = fakeClient({ discoverThrows: true });
  failing.initialize = async () => {
    throw new Error('handshake boom');
  };
  await assert.rejects(() => negotiateStatelessConnection(failing, 'auto'), /handshake boom/);
});

test('stateless:true -> stateless-only, never handshakes even without discovery', async () => {
  const client = fakeClient({ discoverResult: null });
  const n = await negotiateStatelessConnection(client, true);
  assert.equal(n.mode, 'stateless');
  assert.equal(n.fellBack, false);
  assert.equal(client.initializeCalls, 0);
});

test('stateless:false -> handshake only, never discovers', async () => {
  const client = fakeClient({ discoverResult: discoverDoc() });
  const n = await negotiateStatelessConnection(client, false);
  assert.equal(n.mode, 'handshake');
  assert.equal(n.fellBack, false);
  assert.equal(client.discoverCalls, 0);
  assert.equal(client.initializeCalls, 1);
});

test('attachStatelessMetaToParams: merges _meta, keeps progressToken, never mutates', () => {
  const meta = buildRequestStatelessMeta({ protocolVersion: '2026-07-28' });
  assert.equal(meta.protocolVersion, '2026-07-28');
  assert.equal(meta.clientCapabilities.multiRoundTrip, true);

  const params = { name: 'x', _meta: { progressToken: 'tok-1' } };
  const out = attachStatelessMetaToParams(params, meta);
  assert.equal(out['_meta'].progressToken, 'tok-1');
  assert.equal(out['_meta'].protocolVersion, '2026-07-28');
  assert.equal(params['_meta'].protocolVersion, undefined);

  const fromUndefined = attachStatelessMetaToParams(undefined, meta);
  assert.equal(fromUndefined['_meta'].protocolVersion, '2026-07-28');
});

test('statelessCapabilitiesFor: picks known boolean keys only', () => {
  assert.equal(statelessCapabilitiesFor(undefined), undefined);
  assert.equal(statelessCapabilitiesFor({}), undefined);
  assert.deepEqual(statelessCapabilitiesFor({ tasks: true, apps: true, bogus: true }), {
    tasks: true,
    apps: true,
  });
});

test('describeStatelessNegotiation: names the path taken', () => {
  assert.match(
    describeStatelessNegotiation({
      mode: 'handshake',
      protocolVersion: '2025-11-25',
      discovered: null,
      fellBack: true,
      discoveredOlderVersion: false,
    }),
    /fallback/,
  );
  assert.match(
    describeStatelessNegotiation({
      mode: 'stateless',
      protocolVersion: '2026-07-28',
      discovered: discoverDoc(),
      fellBack: false,
      discoveredOlderVersion: false,
    }),
    /stateless 2026-07-28/,
  );
});
