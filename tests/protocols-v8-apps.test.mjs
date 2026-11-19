/**
 * Tests for v1.39 (Team T2) — protocols v8 MCP Apps host:
 * packages/core/src/protocolsV8/mcpAppsV8.ts
 *
 * Covers:
 *  - resource validation (ui:// scheme, mime profile, domain
 *    shape, HTML size, allowedTools)
 *  - HTML validation (external scripts refused, event handlers
 *    refused, javascript: refused, nested frames refused,
 *    undeclared domains refused, form off-domain refused)
 *  - domain matching (exact + subdomain, no parent match)
 *  - CSP building (from declared domains only; nothing else)
 *  - host render (sandbox descriptor, warnings, counts)
 *  - call-back validation (allow-list, unknown resource, size)
 *  - tool UI declaration builder
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v8-apps.test.mjs
 *
 * No network, no model, no DOM — the host works on strings only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV8AppHost,
  McpV8AppResourceRegistry,
  buildMcpV8AppCsp,
  buildMcpV8ToolUi,
  mcpV8AppExternalScripts,
  mcpV8AppReferencedDomains,
  mcpV8DomainAllowed,
  mcpV8DomainMatches,
  validateMcpV8AppCallback,
  validateMcpV8AppHtml,
  validateMcpV8AppResource,
  MCP_V8_APP_MAX_HTML_BYTES,
  MCP_V8_APP_MIME_TYPE,
  MCP_V8_APP_SANDBOX,
} from '../packages/core/dist/index.js';

const GOOD_HTML = `<!doctype html><html><head><style>body{color:#111}</style></head><body>
<h1>Weather</h1><img src="https://cdn.example.com/icon.png" alt="">
<button id="go">Refresh</button>
<script>document.getElementById('go').addEventListener('click', () => { window.parent.postMessage({tool:'weather-refresh'}, '*'); });</script>
</body></html>`;

function goodResource(overrides = {}) {
  return {
    uri: 'ui://weather-card/main',
    name: 'weather-card',
    html: GOOD_HTML,
    mimeType: MCP_V8_APP_MIME_TYPE,
    domains: ['cdn.example.com'],
    allowedTools: ['weather-refresh'],
    toolName: 'weather',
    ...overrides,
  };
}

test('resource validation: happy path + every structural problem', () => {
  assert.deepEqual(validateMcpV8AppResource(goodResource()), []);
  assert.ok(validateMcpV8AppResource(goodResource({ uri: 'https://example.com/x' })).some((p) => p.includes('ui://')));
  assert.ok(validateMcpV8AppResource(goodResource({ mimeType: 'text/html' })).some((p) => p.includes('text/html;profile=mcp-app')));
  assert.ok(validateMcpV8AppResource(goodResource({ domains: ['https://cdn.example.com'] })).some((p) => p.includes('bare hostname')));
  assert.ok(validateMcpV8AppResource(goodResource({ domains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com', 'h.com', 'i.com', 'j.com', 'k.com', 'l.com', 'm.com', 'n.com', 'o.com', 'p.com', 'q.com'] })).some((p) => p.includes('max 16')));
  assert.ok(validateMcpV8AppResource(goodResource({ html: 'x'.repeat(MCP_V8_APP_MAX_HTML_BYTES + 1) })).some((p) => p.includes('bytes')));
  assert.ok(validateMcpV8AppResource(goodResource({ name: '' })).some((p) => p.includes('name')));
});

test('domain matching: exact, subdomain yes, parent/sibling no', () => {
  assert.equal(mcpV8DomainMatches('cdn.example.com', 'cdn.example.com'), true);
  assert.equal(mcpV8DomainMatches('example.com', 'cdn.example.com'), true);
  assert.equal(mcpV8DomainMatches('example.com', 'example.com'), true);
  assert.equal(mcpV8DomainMatches('cdn.example.com', 'example.com'), false);
  assert.equal(mcpV8DomainMatches('cdn.example.com', 'evilcdn.example.com'), false);
  assert.equal(mcpV8DomainMatches('cdn.example.com', 'cdn.example.com.evil.com'), false);
  assert.equal(mcpV8DomainAllowed(['a.com', 'b.com'], 'x.b.com'), true);
  assert.equal(mcpV8DomainAllowed(['a.com'], 'c.com'), false);
});

test('referenced domains + external scripts extraction', () => {
  const html = '<img src="https://img.a.com/x.png"><script src="https://js.b.com/y.js"></script><a href="https://link.c.com/z">x</a>';
  assert.deepEqual(mcpV8AppReferencedDomains(html), ['img.a.com', 'js.b.com', 'link.c.com']);
  assert.deepEqual(mcpV8AppExternalScripts(html), ['https://js.b.com/y.js']);
  assert.deepEqual(mcpV8AppExternalScripts(GOOD_HTML), []);
});

test('HTML validation: good HTML passes with warnings only; bad HTML is refused', () => {
  const good = validateMcpV8AppHtml(GOOD_HTML, ['cdn.example.com']);
  assert.equal(good.ok, true);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.referencedDomains, ['cdn.example.com']);
  assert.ok(good.warnings.some((w) => w.includes('Inline <script>')));

  const extScript = validateMcpV8AppHtml('<script src="https://evil.com/x.js"></script>', []);
  assert.equal(extScript.ok, false);
  assert.ok(extScript.problems.some((p) => p.includes('External script')));

  const handler = validateMcpV8AppHtml('<button onclick="go()">x</button>', []);
  assert.equal(handler.ok, false);
  assert.ok(handler.problems.some((p) => p.includes('event-handler')));

  const jsUrl = validateMcpV8AppHtml('<a href="javascript:alert(1)">x</a>', []);
  assert.equal(jsUrl.ok, false);
  assert.ok(jsUrl.problems.some((p) => p.includes('javascript:')));

  const frame = validateMcpV8AppHtml('<iframe src="https://a.com"></iframe>', ['a.com']);
  assert.equal(frame.ok, false);
  assert.ok(frame.problems.some((p) => p.includes('Nested browsing')));

  const undeclared = validateMcpV8AppHtml('<img src="https://not-declared.com/x.png">', ['cdn.example.com']);
  assert.equal(undeclared.ok, false);
  assert.ok(undeclared.problems.some((p) => p.includes('not-declared.com') && p.includes('not in the resource-declared domains')));

  const formOff = validateMcpV8AppHtml('<form action="https://off.com/submit"></form>', ['cdn.example.com']);
  assert.equal(formOff.ok, false);
  assert.ok(formOff.problems.some((p) => p.includes('Form action')));
  const formOn = validateMcpV8AppHtml('<form action="https://cdn.example.com/submit"></form>', ['cdn.example.com']);
  assert.equal(formOn.ok, true);
});

test('registry: register / get / list / unregister; bad resources refused at registration', () => {
  const registry = new McpV8AppResourceRegistry();
  assert.equal(registry.size(), 0);
  const reg = registry.register(goodResource());
  assert.equal(reg.uri, 'ui://weather-card/main');
  assert.deepEqual(reg.domains, ['cdn.example.com']);
  assert.equal(registry.size(), 1);
  assert.deepEqual(registry.uris(), ['ui://weather-card/main']);
  assert.equal(registry.get('ui://weather-card/main')?.name, 'weather-card');
  assert.equal(registry.resourcesForTool('weather').length, 1);
  assert.equal(registry.resourcesForTool('other').length, 0);

  assert.throws(
    () => registry.register(goodResource({ uri: 'ui://bad/main', html: '<script src="https://evil.com/x.js"></script>' })),
    /External script/,
  );
  assert.throws(
    () => registry.register(goodResource({ uri: 'ui://bad2/main', html: '<img src="https://undeclared.com/x.png">' })),
    /not in the resource-declared domains/,
  );
  assert.equal(registry.size(), 1);
  assert.equal(registry.unregister('ui://weather-card/main'), true);
  assert.equal(registry.unregister('ui://weather-card/main'), false);
  assert.equal(registry.size(), 0);
});

test('CSP: built from declared domains only; empty domains mean none', () => {
  const csp = buildMcpV8AppCsp(goodResource());
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline' 'self'/);
  assert.match(csp, /img-src 'self' https:\/\/cdn\.example\.com data:/);
  assert.match(csp, /connect-src 'self' https:\/\/cdn\.example\.com/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /form-action 'self' https:\/\/cdn\.example\.com/);
  assert.doesNotMatch(csp, /evil/);

  const none = buildMcpV8AppCsp(goodResource({ domains: [] }));
  assert.match(none, /img-src 'self' 'none' data:/);
});

test('host: render descriptor, tool mismatch refused, render counts', () => {
  const registry = new McpV8AppResourceRegistry();
  registry.register(goodResource());
  const host = new McpV8AppHost(registry);
  assert.equal(host.renderCount(), 0);
  const desc = host.render({ toolName: 'weather', resourceUri: 'ui://weather-card/main', preferredWidth: 480, preferredHeight: 320 });
  assert.equal(desc.uri, 'ui://weather-card/main');
  assert.equal(desc.toolName, 'weather');
  assert.equal(desc.sandbox, MCP_V8_APP_SANDBOX);
  assert.match(desc.sandbox, /allow-scripts/);
  assert.match(desc.csp, /cdn\.example\.com/);
  assert.deepEqual(desc.allowedDomains, ['cdn.example.com']);
  assert.deepEqual(desc.blockedDomains, []);
  assert.equal(desc.preferredWidth, 480);
  assert.equal(desc.preferredHeight, 320);
  assert.equal(host.renderCount(), 1);

  assert.throws(
    () => host.render({ toolName: 'other-tool', resourceUri: 'ui://weather-card/main' }),
    /belongs to tool "weather"/,
  );
  assert.throws(
    () => host.render({ toolName: 'weather', resourceUri: 'ui://missing/main' }),
    /not registered/,
  );
});

test('call-back validation: allow-list, unknown resource, oversize args', () => {
  const registry = new McpV8AppResourceRegistry();
  registry.register(goodResource());
  const host = new McpV8AppHost(registry);
  const ok = host.checkCallback({ resourceUri: 'ui://weather-card/main', tool: 'weather-refresh', arguments: { city: 'Hanoi' } });
  assert.equal(ok.ok, true);
  assert.equal(host.blockedCallbackCount(), 0);

  const denied = host.checkCallback({ resourceUri: 'ui://weather-card/main', tool: 'delete-everything', arguments: {} });
  assert.equal(denied.ok, false);
  assert.ok(denied.problems.some((p) => p.includes('may not call tool')));
  assert.equal(host.blockedCallbackCount(), 1);

  const unknown = validateMcpV8AppCallback(registry, { resourceUri: 'ui://nope/main', tool: 'weather-refresh' });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.problems.some((p) => p.includes('unknown app resource')));

  const big = host.checkCallback({
    resourceUri: 'ui://weather-card/main',
    tool: 'weather-refresh',
    arguments: { blob: 'x'.repeat(70 * 1024) },
  });
  assert.equal(big.ok, false);
  assert.ok(big.problems.some((p) => p.includes('bytes')));
});

test('buildMcpV8ToolUi: validates scheme + sizes', () => {
  assert.deepEqual(buildMcpV8ToolUi('ui://a/b', 100, 200), { resourceUri: 'ui://a/b', preferredWidth: 100, preferredHeight: 200 });
  assert.throws(() => buildMcpV8ToolUi('https://a.com/b'), /must start with "ui:\/\/"/);
  assert.throws(() => buildMcpV8ToolUi('ui://a/b', 0), /positive integer/);
  assert.throws(() => buildMcpV8ToolUi('ui://a/b', undefined, -5), /positive integer/);
});
