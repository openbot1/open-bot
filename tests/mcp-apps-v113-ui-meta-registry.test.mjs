/**
 * Test v1.13 T2: MCP Apps host v13 — _meta.ui + registry ui:// (node:test).
 * Local only, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-apps-v113-ui-meta-registry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUiResourceUri,
  describeToolUi,
  isMcpAppMimeType,
  isProfiledMcpAppMimeType,
  isValidUiResourceUri,
  listUiTools,
  matchDeclaredResourceInResult,
  parseToolUiMeta,
  parseUiMimeType,
  parseUiResourceUri,
  toolDeclaresUi,
  MCP_APP_PROFILE_MIME_TYPE,
} from '../packages/core/dist/mcp/appsUiMeta.js';
import {
  McpAppUiRegistry,
  UI_REGISTRY_MAX_ENTRIES,
} from '../packages/core/dist/mcp/appsUiRegistry.js';

const SAFE_HTML = '<!doctype html><html><head><style>body{color:navy}</style></head><body><h1>Hi</h1></body></html>';
const TOOL_WITH_UI = {
  name: 'show-dashboard',
  description: 'Show a dashboard.',
  inputSchema: { type: 'object', properties: {} },
  _meta: {
    ui: {
      resourceUri: 'ui://my-server/dashboard',
      displayMode: 'pip',
      preferredWidth: 720,
      preferredHeight: 480,
      capabilities: ['tools-call', 'open-link'],
      title: 'Dashboard',
    },
  },
};

test('ui-meta: profile MIME constants + parsing', () => {
  assert.equal(MCP_APP_PROFILE_MIME_TYPE, 'text/html;profile=mcp-app');
  assert.equal(isMcpAppMimeType('text/html'), true);
  assert.equal(isMcpAppMimeType('text/html;profile=mcp-app'), true);
  assert.equal(isMcpAppMimeType('Text/HTML ; Profile=MCP-App'), true);
  assert.equal(isMcpAppMimeType('text/html;profile=other'), false);
  assert.equal(isMcpAppMimeType('application/json'), false);
  assert.equal(isMcpAppMimeType(undefined), false);
  assert.equal(isProfiledMcpAppMimeType('text/html;profile=mcp-app'), true);
  assert.equal(isProfiledMcpAppMimeType('text/html'), false);
  const parsed = parseUiMimeType('text/html;profile=mcp-app;charset=utf-8');
  assert.equal(parsed.base, 'text/html');
  assert.equal(parsed.profile, 'mcp-app');
  assert.equal(parsed.isMcpApp, true);
});

test('ui-meta: parseUiResourceUri accepts ui://server/path, rejects bad shapes', () => {
  const parsed = parseUiResourceUri('ui://my-server/dashboard/main');
  assert.equal(parsed.server, 'my-server');
  assert.equal(parsed.path, 'dashboard/main');
  assert.equal(parsed.name, 'main');
  assert.equal(buildUiResourceUri('my-server', 'dashboard/main'), 'ui://my-server/dashboard/main');
  for (const bad of [
    '',
    'https://example.com/app',
    'ui://',
    'ui:///app',
    'ui://server',
    'ui://server/',
    'ui://server//app',
    'ui://server/app with space',
    'ui://server/../secret',
    'ui://server/app?x=1',
    'ui://server/app#frag',
  ]) {
    assert.equal(isValidUiResourceUri(bad), false, bad);
    assert.throws(() => parseUiResourceUri(bad), /resourceUri/);
  }
});

test('ui-meta: parseToolUiMeta reads _meta.ui, null when absent, throws when malformed', () => {
  const decl = parseToolUiMeta(TOOL_WITH_UI);
  assert.ok(decl);
  assert.equal(decl.resourceUri, 'ui://my-server/dashboard');
  assert.equal(decl.server, 'my-server');
  assert.equal(decl.appName, 'dashboard');
  assert.equal(decl.displayMode, 'pip');
  assert.equal(decl.preferredWidth, 720);
  assert.equal(decl.preferredHeight, 480);
  assert.deepEqual(decl.capabilities, ['tools-call', 'open-link']);
  assert.equal(decl.title, 'Dashboard');
  assert.equal(parseToolUiMeta({ name: 'plain-tool' }), null);
  assert.equal(parseToolUiMeta(null), null);
  assert.equal(toolDeclaresUi(TOOL_WITH_UI), true);
  assert.equal(toolDeclaresUi({ name: 'plain' }), false);
  assert.throws(() => parseToolUiMeta({ name: 'x', _meta: { ui: { displayMode: 'inline' } } }), /resourceUri/);
  assert.throws(
    () => parseToolUiMeta({ name: 'x', _meta: { ui: { resourceUri: 'ui://s/a', displayMode: 'side' } } }),
    /displayMode/,
  );
  assert.throws(
    () => parseToolUiMeta({ name: 'x', _meta: { ui: { resourceUri: 'ui://s/a', capabilities: ['fly'] } } }),
    /Capability/,
  );
  assert.throws(
    () => parseToolUiMeta({ name: 'x', _meta: { ui: { resourceUri: 'ui://s/a', preferredWidth: -5 } } }),
    /preferredWidth/,
  );
  assert.equal(describeToolUi(decl), 'ui://my-server/dashboard mode=pip size=720x480 caps=tools-call+open-link');
});

test('ui-meta: listUiTools filters tools with UI declarations', () => {
  const found = listUiTools([TOOL_WITH_UI, { name: 'plain' }, { name: 'bad', _meta: { ui: { resourceUri: 'ui://s/b' } } }]);
  assert.equal(found.length, 2);
  assert.equal(found[0].name, 'show-dashboard');
  assert.throws(() => listUiTools([{ name: 'bad', _meta: { ui: { resourceUri: 'http://x' } } }]), /resourceUri/);
});

test('ui-meta: matchDeclaredResourceInResult finds the declared resource in a tool result', () => {
  const decl = parseToolUiMeta(TOOL_WITH_UI);
  const result = {
    content: [
      { type: 'text', text: 'hello' },
      {
        type: 'resource',
        resource: { uri: 'ui://my-server/dashboard', mimeType: 'text/html;profile=mcp-app', text: SAFE_HTML },
      },
    ],
  };
  const match = matchDeclaredResourceInResult(decl, result);
  assert.equal(match.found, true);
  assert.equal(match.uri, 'ui://my-server/dashboard');
  assert.equal(match.mimeType, 'text/html;profile=mcp-app');
  assert.equal(matchDeclaredResourceInResult(decl, { content: [{ type: 'text', text: 'x' }] }).found, false);
  assert.equal(matchDeclaredResourceInResult(decl, null).found, false);
  // Resource with a non-app MIME does not match.
  const wrongMime = {
    content: [{ type: 'resource', resource: { uri: 'ui://my-server/dashboard', mimeType: 'application/json', text: '{}' } }],
  };
  assert.equal(matchDeclaredResourceInResult(decl, wrongMime).found, false);
});

test('registry: register + resolve + list + stats', () => {
  const registry = new McpAppUiRegistry();
  const entry = registry.register({ uri: 'ui://srv/app', html: SAFE_HTML, title: 'App' });
  assert.equal(entry.uri, 'ui://srv/app');
  assert.equal(entry.mimeType, 'text/html');
  assert.equal(entry.version, 1);
  assert.equal(entry.sizeBytes, new TextEncoder().encode(SAFE_HTML).length);
  assert.equal(registry.size, 1);
  const resolved = registry.resolve('ui://srv/app');
  assert.equal(resolved?.hits, 1);
  assert.equal(resolved?.html, SAFE_HTML);
  assert.equal(registry.resolve('ui://srv/missing'), undefined);
  assert.equal(registry.resolve('not-a-uri'), undefined);
  assert.equal(registry.has('ui://srv/app'), true);
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].uri, 'ui://srv/app');
  assert.equal('html' in list[0], false);
  const stats = registry.stats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.servers, 1);
  assert.equal(stats.totalHits, 1);
});

test('registry: re-register bumps version, profile MIME is normalized', () => {
  const registry = new McpAppUiRegistry();
  registry.register({ uri: 'ui://srv/app', html: SAFE_HTML, mimeType: 'text/html;profile=mcp-app' });
  const updated = registry.register({ uri: 'ui://srv/app', html: SAFE_HTML.replace('Hi', 'Hello') });
  assert.equal(updated.version, 2);
  assert.equal(updated.mimeType, 'text/html');
  assert.equal(registry.size, 1);
});

test('registry: rejects bad MIME, bad URI, blocked HTML — and keeps the old entry', () => {
  const registry = new McpAppUiRegistry();
  registry.register({ uri: 'ui://srv/app', html: SAFE_HTML });
  assert.throws(
    () => registry.register({ uri: 'ui://srv/app2', html: SAFE_HTML, mimeType: 'application/json' }),
    /MIME/,
  );
  assert.throws(() => registry.register({ uri: 'https://x/app', html: SAFE_HTML }), /resourceUri/);
  assert.throws(
    () => registry.register({ uri: 'ui://srv/app', html: '<script src="https://evil.example/x.js"></script>' }),
    /remote script|App/,
  );
  assert.equal(registry.size, 1);
  assert.equal(registry.resolve('ui://srv/app')?.html, SAFE_HTML);
  assert.ok(registry.stats().rejected >= 2);
});

test('registry: registerFromDeclaration uses _meta.ui defaults', () => {
  const registry = new McpAppUiRegistry();
  const decl = parseToolUiMeta(TOOL_WITH_UI);
  const entry = registry.registerFromDeclaration(decl, SAFE_HTML, { toolName: 'show-dashboard' });
  assert.equal(entry.uri, 'ui://my-server/dashboard');
  assert.equal(entry.displayMode, 'pip');
  assert.equal(entry.toolName, 'show-dashboard');
  assert.equal(entry.mimeType, 'text/html;profile=mcp-app');
});

test('registry: resolveForTool prefers the entry of the right tool', () => {
  const registry = new McpAppUiRegistry();
  registry.register({ uri: 'ui://srv/a', html: SAFE_HTML, toolName: 'tool-a' });
  registry.register({ uri: 'ui://srv/b', html: SAFE_HTML, toolName: 'tool-b' });
  const decl = parseToolUiMeta({ name: 'tool-b', _meta: { ui: { resourceUri: 'ui://srv/b' } } });
  assert.equal(registry.resolveForTool('srv', 'tool-b', decl)?.uri, 'ui://srv/b');
  assert.equal(registry.resolveForTool('srv', 'tool-a')?.uri, 'ui://srv/a');
  assert.equal(registry.resolveForTool('srv', 'tool-unknown', decl)?.uri, 'ui://srv/b');
  assert.equal(registry.resolveForTool('srv', 'tool-unknown'), undefined);
});

test('registry: unregister + unregisterServer + TTL prune + LRU eviction', () => {
  let nowMs = 1_000_000;
  const registry = new McpAppUiRegistry({ maxEntries: 3, maxTotalBytes: 10_000, now: () => nowMs });
  registry.register({ uri: 'ui://srv/a', html: SAFE_HTML, ttlMs: 1000 });
  registry.register({ uri: 'ui://srv/b', html: SAFE_HTML });
  registry.register({ uri: 'ui://srv/c', html: SAFE_HTML });
  assert.equal(registry.unregister('ui://srv/c'), true);
  assert.equal(registry.unregister('ui://srv/c'), false);
  assert.equal(registry.unregister('bad-uri'), false);
  registry.register({ uri: 'ui://srv/c', html: SAFE_HTML });
  registry.register({ uri: 'ui://other/d', html: SAFE_HTML });
  // Đăng ký entry thứ 4 khi maxEntries=3 đã đuổi entry ít dùng nhất ('a').
  assert.equal(registry.unregisterServer('srv'), 2);
  assert.equal(registry.size, 1);
  // TTL: entry 'a' is gone (server unregistered); re-add with TTL and advance time.
  registry.register({ uri: 'ui://srv/a', html: SAFE_HTML, ttlMs: 1000 });
  nowMs += 2000;
  assert.equal(registry.pruneExpired(), 1);
  assert.equal(registry.resolve('ui://srv/a'), undefined);
  // LRU eviction: maxEntries 3 — registering a 4th evicts the least recently used.
  const small = new McpAppUiRegistry({ maxEntries: 2, now: () => nowMs });
  small.register({ uri: 'ui://s/1', html: SAFE_HTML });
  small.register({ uri: 'ui://s/2', html: SAFE_HTML });
  small.resolve('ui://s/1');
  small.register({ uri: 'ui://s/3', html: SAFE_HTML });
  assert.equal(small.size, 2);
  assert.equal(small.has('ui://s/2'), false);
  assert.equal(small.has('ui://s/1'), true);
  assert.ok(small.stats().evicted >= 1);
  assert.equal(UI_REGISTRY_MAX_ENTRIES, 200);
});
