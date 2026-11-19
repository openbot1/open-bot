/**
 * Regression tests for consistent team egress policy across generic HTTP tools.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/egress-http-tools-c8.test.mjs
 *
 * No live network: fetch is mocked; allowlist and private-IP checks must
 * reject before the transport is invoked.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultTools } from '../packages/tools/dist/tools.js';

const realFetch = globalThis.fetch;
const CTX = { workspaceDir: '/tmp/open-bot-egress-test', botId: 'egress-test' };

afterEach(() => {
  globalThis.fetch = realFetch;
});

function toolByName(tools, name) {
  const tool = tools.find((item) => item.definition.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool;
}

function allowPublicPolicy() {
  return { mode: 'allow-public' };
}

test('web_fetch rejects a team-blocked host before calling fetch', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('<html><body>should not fetch</body></html>', { status: 200 });
  };

  const tools = createDefaultTools({
    getEgressPolicy: () => ({ mode: 'allowlist', allowHosts: ['allowed.example'] }),
  });
  const out = await toolByName(tools, 'web_fetch').execute(
    { url: 'https://blocked.example/page' },
    CTX,
  );

  assert.match(out, /^Error:/);
  assert.match(out, /egress_not_allowlisted/);
  assert.equal(fetchCalls, 0, 'team-blocked URL must not reach fetch');
});

test('http_get rejects metadata and localhost through the team SSRF policy', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('should not fetch', { status: 200 });
  };

  const tools = createDefaultTools({ getEgressPolicy: allowPublicPolicy });
  const httpGet = toolByName(tools, 'http_get');

  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:11434/api/tags',
  ]) {
    const out = await httpGet.execute({ url }, CTX);
    assert.match(out, /^Error:/, url);
    assert.match(out, /egress_(private_destination|loopback_blocked)/, url);
  }
  assert.equal(fetchCalls, 0, 'private destinations must never reach fetch');
});

test('http_request remains policy-bound and public requests still pass', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const tools = createDefaultTools({ getEgressPolicy: allowPublicPolicy });
  const out = await toolByName(tools, 'http_request').execute(
    { url: 'http://93.184.216.34/api', method: 'GET' },
    CTX,
  );

  assert.match(out, /HTTP 200 OK GET/);
  assert.match(out, /"ok":true/);
  assert.equal(fetchCalls, 1);
});

test('web_fetch_clean is policy-bound even when no other internet-data option is configured', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('<html><body>should not fetch</body></html>', { status: 200 });
  };

  const tools = createDefaultTools({
    getEgressPolicy: () => ({ mode: 'allowlist', allowHosts: ['allowed.example'] }),
  });
  const out = await toolByName(tools, 'web_fetch_clean').execute(
    { url: 'https://blocked.example/page' },
    CTX,
  );

  assert.match(out, /^Error:/);
  assert.match(out, /egress_not_allowlisted/);
  assert.equal(fetchCalls, 0);
});

test('web_search checks the policy before its external search fetch', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('no results', { status: 200 });
  };

  const tools = createDefaultTools({
    getEgressPolicy: () => ({ mode: 'allowlist', allowHosts: ['allowed.example'] }),
  });
  const out = await toolByName(tools, 'web_search').execute({ query: 'test query' }, CTX);

  assert.match(out, /^Error:/);
  assert.equal(fetchCalls, 0, 'search provider hosts outside allowlist must not reach fetch');
});
