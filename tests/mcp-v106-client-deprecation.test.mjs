/**
 * Test v1.06 T2: client-side deprecation tracker (node:test).
 * Pure logic, no network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v106-client-deprecation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ClientDeprecationTracker,
  deprecatedClientCapabilitiesIn,
  formatClientDeprecationWarning,
  isDeprecatedClientCapability,
  isDeprecatedClientMethod,
  noteDeprecatedClientUse,
  CLIENT_DEPRECATED_CAPABILITIES,
  CLIENT_DEPRECATED_METHODS,
} from '../packages/core/dist/mcp/clientDeprecation.js';

test('client deprecation: the three deprecated capabilities + their methods', () => {
  assert.deepEqual([...CLIENT_DEPRECATED_CAPABILITIES], ['sampling', 'roots', 'logging']);
  const methods = CLIENT_DEPRECATED_METHODS.map((m) => m.method);
  assert.ok(methods.includes('sampling/createMessage'));
  assert.ok(methods.includes('roots/list'));
  assert.ok(methods.includes('roots/subscribe'));
  assert.ok(methods.includes('notifications/message'));
  assert.ok(methods.includes('logging/setLevel'));
  assert.equal(isDeprecatedClientCapability('sampling'), true);
  assert.equal(isDeprecatedClientCapability('roots'), true);
  assert.equal(isDeprecatedClientCapability('logging'), true);
  assert.equal(isDeprecatedClientCapability('elicitation'), false);
  assert.equal(isDeprecatedClientCapability('tools'), false);
  assert.equal(isDeprecatedClientMethod('sampling/createMessage'), true);
  assert.equal(isDeprecatedClientMethod('roots/list'), true);
  assert.equal(isDeprecatedClientMethod('notifications/message'), true);
  assert.equal(isDeprecatedClientMethod('tools/call'), false);
  assert.equal(isDeprecatedClientMethod('elicitation/create'), false);
  assert.deepEqual(deprecatedClientCapabilitiesIn({ roots: {}, sampling: {}, tools: {} }), [
    'sampling',
    'roots',
  ]);
  assert.deepEqual(deprecatedClientCapabilitiesIn({ tools: {} }), []);
  assert.deepEqual(deprecatedClientCapabilitiesIn(undefined), []);
});

test('client deprecation: noteUse records + warns exactly once per method', () => {
  const warnings = [];
  const tracker = new ClientDeprecationTracker({
    serverName: 'srv-old',
    onWarning: (notice, message) => warnings.push({ notice, message }),
  });
  assert.equal(tracker.hasUsedDeprecated, false);
  assert.equal(tracker.noteUse('tools/call'), null);
  const first = tracker.noteUse('roots/list', 'incoming');
  assert.ok(first);
  assert.equal(first.method, 'roots/list');
  assert.equal(first.callCount, 1);
  tracker.noteUse('roots/list', 'incoming');
  tracker.noteUse('roots/list', 'outgoing');
  assert.equal(tracker.callCount('roots/list'), 3);
  assert.equal(tracker.directionalCallCount('roots/list', 'incoming'), 2);
  assert.equal(tracker.directionalCallCount('roots/list', 'outgoing'), 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].notice.method, 'roots/list');
  assert.match(warnings[0].message, /roots\/list/);
  assert.equal(tracker.hasUsedDeprecated, true);
});

test('client deprecation: noteAdvertisedCapabilities records roots/sampling once', () => {
  const warnings = [];
  const tracker = new ClientDeprecationTracker({ onWarning: (n) => warnings.push(n) });
  const recorded = tracker.noteAdvertisedCapabilities({
    roots: { listChanged: false },
    sampling: {},
    experimental: {},
  });
  assert.deepEqual(recorded, ['sampling', 'roots']);
  assert.equal(tracker.getNotices().length, 2);
  assert.equal(warnings.length, 2);
  // Advertising again does not re-warn.
  tracker.noteAdvertisedCapabilities({ roots: {}, sampling: {} });
  assert.equal(warnings.length, 2);
  assert.equal(tracker.callCount('roots/list'), 2);
  assert.deepEqual(tracker.noteAdvertisedCapabilities({ tools: {} }), []);
});

test('client deprecation: wrapHandler warns once, still runs the handler every time', () => {
  const warnings = [];
  let calls = 0;
  const tracker = new ClientDeprecationTracker({ onWarning: (n) => warnings.push(n) });
  const wrapped = tracker.wrapHandler('sampling/createMessage', (params) => {
    calls += 1;
    return { reply: params };
  });
  assert.deepEqual(wrapped({ text: 'hi' }), { reply: { text: 'hi' } });
  wrapped({ text: 'again' });
  assert.equal(calls, 2);
  assert.equal(warnings.length, 1);
  assert.equal(tracker.callCount('sampling/createMessage'), 2);
  // Non-deprecated methods pass through unwrapped.
  const plain = tracker.wrapHandler('tools/call', (x) => x);
  assert.equal(plain(5), 5);
  assert.equal(tracker.getNotices().length, 1);
});

test('client deprecation: format + describe + clear', () => {
  const tracker = new ClientDeprecationTracker({ serverName: 'srv-old' });
  tracker.noteUse('logging/setLevel', 'outgoing');
  tracker.noteUse('notifications/message', 'incoming');
  const notices = tracker.getNotices();
  assert.equal(notices.length, 2);
  const text = tracker.formatWarning(notices[0]);
  assert.match(text, /srv-old/);
  assert.match(text, /logging\/setLevel/);
  assert.match(text, /2027-07-28/);
  assert.match(tracker.describeNotices(), /logging\/setLevel/);
  assert.match(tracker.describeNotices(), /notifications\/message/);
  tracker.clear();
  assert.equal(tracker.getNotices().length, 0);
  assert.equal(tracker.hasUsedDeprecated, false);
  assert.equal(tracker.callCount('logging/setLevel'), 0);
  assert.equal(tracker.describeNotices(), 'Không dùng method MCP nào đã deprecated.');
});

test('client deprecation: formatClientDeprecationWarning without server name', () => {
  const tracker = new ClientDeprecationTracker({});
  const notice = tracker.noteUse('roots/list');
  assert.ok(notice);
  const text = formatClientDeprecationWarning(notice);
  assert.match(text, /roots\/list/);
  assert.match(text, /1 lần/);
});

test('client deprecation: noteDeprecatedClientUse helper tolerates missing tracker', () => {
  assert.equal(noteDeprecatedClientUse(undefined, 'roots/list'), null);
  const tracker = new ClientDeprecationTracker({});
  assert.ok(noteDeprecatedClientUse(tracker, 'roots/list'));
  assert.equal(noteDeprecatedClientUse(tracker, 'tools/call'), null);
});
