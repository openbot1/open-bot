/**
 * Tests for v1.42 (Team T2) — protocols v11 versions + Apps UI:
 * packages/core/src/protocols/v11/versionsV11.ts (deprecation half)
 * packages/core/src/protocols/v11/appsV11.ts
 *
 * Covers:
 *  - deprecation table: roots / sampling / logging, deprecated
 *    2026-07-28, earliest removal 2027-07-28, replacements named
 *  - earliest-removal math: 12-month floor, 90-day security floor
 *  - app resource validation: ui:// only, text/html only,
 *    forbidden sandbox tokens rejected, allow-scripts required,
 *    javascript: links and remote script src rejected
 *  - CSP: built from declared domains only, default-src 'none',
 *    no unsafe-inline, frame-ancestors 'none'
 *  - UI message validation: only ui/* methods, tool-call needs a
 *    tool name, initialize needs a ui:// appUri
 *  - app session: open -> initialize -> tool-call (host arbitrates)
 *    -> notify -> close; messages after close rejected; invalid
 *    resource throws at open; audit log records every step
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v11-apps-versions-v142.test.mjs
 *
 * No network, no model. HTML is validated, never executed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV11AppSession,
  buildMcpV11AppCsp,
  defaultMcpV11Deprecations,
  mcpV11DaysBetween,
  mcpV11EarliestRemovalDate,
  mcpV11TodayIso,
  protocolV11ChangesSinceV10,
  validateMcpV11AppResource,
  validateMcpV11Features,
  validateMcpV11UiMessage,
} from '../packages/core/dist/index.js';

const GOOD_RESOURCE = {
  uri: 'ui://example.com/weather-card',
  mimeType: 'text/html',
  sandbox: ['allow-scripts', 'allow-same-origin'],
  allowedDomains: ['cdn.example.com'],
  title: 'Weather card',
};

test('deprecation table: roots/sampling/logging, 2026-07-28 -> 2027-07-28, replacements named', () => {
  const entries = defaultMcpV11Deprecations();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.id).sort(), ['logging', 'roots', 'sampling']);
  for (const entry of entries) {
    assert.equal(entry.deprecatedSince, '2026-07-28');
    assert.equal(entry.earliestRemoval, '2027-07-28');
    assert.ok(entry.replacedBy.length > 0);
    assert.ok(entry.reason.length > 0);
  }
  const sampling = entries.find((e) => e.id === 'sampling');
  assert.match(sampling.replacedBy, /input_required/);
  assert.equal(mcpV11EarliestRemovalDate('2026-07-28'), '2027-07-28');
  assert.equal(mcpV11EarliestRemovalDate('2026-07-28', true), '2026-10-26');
  assert.equal(mcpV11EarliestRemovalDate('not-a-date'), '2027-07-28');
  assert.equal(mcpV11DaysBetween('2026-07-28', '2027-07-28'), 365);
  assert.equal(mcpV11DaysBetween('2027-07-28', '2026-07-28'), -365);
  assert.match(mcpV11TodayIso(), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(protocolV11ChangesSinceV10().some((c) => c.includes('routing headers')));
  assert.ok(protocolV11ChangesSinceV10().some((c) => c.includes('iss')));
});

test('feature flags: known boolean flags pass; unknown / non-boolean flags listed', () => {
  assert.deepEqual(validateMcpV11Features({ multiRoundTrip: true, tasks: false }), []);
  assert.deepEqual(validateMcpV11Features({}), []);
  assert.ok(validateMcpV11Features(null).length > 0);
  assert.ok(validateMcpV11Features([]).length > 0);
  const unknown = validateMcpV11Features({ sampling: true });
  assert.ok(unknown.some((p) => p.includes('Unknown capability flag "sampling"')));
  const badType = validateMcpV11Features({ tasks: 'yes' });
  assert.ok(badType.some((p) => p.includes('must be a boolean')));
});

test('app resource validation: good passes; bad uri/mime/sandbox/html rejected', () => {
  assert.deepEqual(validateMcpV11AppResource(GOOD_RESOURCE), []);
  assert.ok(validateMcpV11AppResource(null).length > 0);
  assert.ok(validateMcpV11AppResource({ ...GOOD_RESOURCE, uri: 'https://example.com/card' }).some((p) => p.includes('ui://')));
  assert.ok(validateMcpV11AppResource({ ...GOOD_RESOURCE, mimeType: 'application/json' }).some((p) => p.includes('text/html')));
  assert.ok(
    validateMcpV11AppResource({ ...GOOD_RESOURCE, sandbox: ['allow-scripts', 'allow-top-navigation'] }).some((p) => p.includes('forbidden')),
  );
  assert.ok(
    validateMcpV11AppResource({ ...GOOD_RESOURCE, sandbox: ['allow-same-origin'] }).some((p) => p.includes('allow-scripts')),
  );
  assert.ok(
    validateMcpV11AppResource({ ...GOOD_RESOURCE, sandbox: ['allow-scripts', 'allow-everything'] }).some((p) => p.includes('not a known')),
  );
  assert.ok(
    validateMcpV11AppResource({ ...GOOD_RESOURCE, allowedDomains: ['*.example.com'] }).some((p) => p.includes('bare host')),
  );
  assert.ok(
    validateMcpV11AppResource({ ...GOOD_RESOURCE, html: '<a href="javascript:alert(1)">x</a>' }).some((p) => p.includes('javascript:')),
  );
  assert.ok(
    validateMcpV11AppResource({ ...GOOD_RESOURCE, html: '<script src="https://evil.example.com/x.js"></script>' }).some((p) => p.includes('remote URLs')),
  );
});

test('app CSP: from declared domains only, locked down by default', () => {
  const csp = buildMcpV11AppCsp(GOOD_RESOURCE);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/cdn\.example\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /\*/);
  const empty = buildMcpV11AppCsp({});
  assert.match(empty, /script-src 'self'/);
  assert.doesNotMatch(empty, /https:\/\//);
});

test('UI message validation: only ui/* methods; tool-call and initialize shapes enforced', () => {
  assert.deepEqual(validateMcpV11UiMessage({ jsonrpc: '2.0', method: 'ui/initialize', params: { appUri: 'ui://example.com/x' } }), []);
  assert.deepEqual(validateMcpV11UiMessage({ jsonrpc: '2.0', method: 'ui/tool-call', params: { tool: 'echo', arguments: {} } }), []);
  assert.deepEqual(validateMcpV11UiMessage({ jsonrpc: '2.0', method: 'ui/notify', params: { message: 'hi' } }), []);
  assert.deepEqual(validateMcpV11UiMessage({ jsonrpc: '2.0', method: 'ui/close' }), []);
  assert.ok(validateMcpV11UiMessage(null).length > 0);
  assert.ok(validateMcpV11UiMessage({ jsonrpc: '2.0', method: 'tools/call' }).some((p) => p.includes('ui/')));
  assert.ok(validateMcpV11UiMessage({ jsonrpc: '1.0', method: 'ui/close' }).some((p) => p.includes('2.0')));
  assert.ok(validateMcpV11UiMessage({ jsonrpc: '2.0', method: 'ui/tool-call', params: {} }).some((p) => p.includes('params.tool')));
  assert.ok(validateMcpV11UiMessage({ jsonrpc: '2.0', method: 'ui/tool-call', params: { tool: 'echo', arguments: 'nope' } }).some((p) => p.includes('arguments')));
  assert.ok(validateMcpV11UiMessage({ jsonrpc: '2.0', method: 'ui/initialize', params: { appUri: 'https://example.com' } }).some((p) => p.includes('ui://')));
});

test('app session: open -> initialize -> tool-call -> notify -> close, audited; closed rejects', () => {
  const session = new McpV11AppSession(GOOD_RESOURCE);
  assert.equal(session.status, 'opened');
  assert.match(session.csp, /default-src 'none'/);
  assert.equal(session.audit.length, 1);
  assert.equal(session.audit[0].kind, 'open');
  const init = session.handle({ jsonrpc: '2.0', method: 'ui/initialize', params: { appUri: GOOD_RESOURCE.uri } });
  assert.equal(init.ok, true);
  assert.equal(session.status, 'initialized');
  assert.equal(init.result.sessionId, session.id);
  const call = session.handle({ jsonrpc: '2.0', method: 'ui/tool-call', params: { tool: 'weather.get', arguments: { city: 'Hanoi' } } });
  assert.equal(call.ok, true);
  assert.equal(call.result.queued, true);
  assert.equal(session.allowedCalls.length, 1);
  assert.equal(session.allowedCalls[0].tool, 'weather.get');
  const notify = session.handle({ jsonrpc: '2.0', method: 'ui/notify', params: { message: 'rendered' } });
  assert.equal(notify.ok, true);
  const bad = session.handle({ jsonrpc: '2.0', method: 'tools/call', params: {} });
  assert.equal(bad.ok, false);
  const close = session.handle({ jsonrpc: '2.0', method: 'ui/close' });
  assert.equal(close.ok, true);
  assert.equal(session.status, 'closed');
  const afterClose = session.handle({ jsonrpc: '2.0', method: 'ui/notify', params: { message: 'late' } });
  assert.equal(afterClose.ok, false);
  assert.match(afterClose.error, /closed/);
  assert.deepEqual(session.audit.map((a) => a.kind), ['open', 'initialize', 'tool-call', 'notify', 'rejected', 'close', 'rejected']);
  // Host-side close is idempotent.
  session.close();
  assert.equal(session.status, 'closed');
});

test('app session: invalid resource throws at open', () => {
  assert.throws(() => new McpV11AppSession({ ...GOOD_RESOURCE, uri: 'https://example.com' }), /ui:\/\//);
  assert.throws(
    () => new McpV11AppSession({ ...GOOD_RESOURCE, sandbox: ['allow-scripts', 'allow-top-navigation'] }),
    /forbidden/,
  );
});
