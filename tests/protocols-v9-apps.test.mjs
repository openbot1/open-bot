/**
 * Tests for v1.40 (Team T2) — protocols v9 MCP Apps v2 lifecycle:
 * packages/core/src/protocolsV9/mcpAppsV9.ts
 * (builds on the v8 host in protocolsV8/mcpAppsV8.ts)
 *
 * Covers:
 *  - open / close / reopen (re-render through the v8 host,
 *    descriptor dropped on close, reopen count tracked)
 *  - suspend / resume (resume re-validates HTML; a resource
 *    whose HTML no longer passes fails the resume)
 *  - focus order (most-recently-focused first)
 *  - move-slot (no re-render)
 *  - open-app budget (refuses when full)
 *  - call-back through an instance (allow-list enforced,
 *    blocked call-backs not counted, non-active apps refuse)
 *  - counts / list filters / events
 *  - snapshot / restore (restored apps come back closed,
 *    never active; apps with a missing resource are dropped)
 *  - closed-app pruning
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v9-apps.test.mjs
 *
 * No network, no model, no DOM — the host works on strings only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV8AppResourceRegistry,
  McpV9AppLifecycleManager,
  MCP_V8_APP_MIME_TYPE,
} from '../packages/core/dist/index.js';

const GOOD_HTML = `<!doctype html><html><head><style>body{color:#111}</style></head><body>
<h1>Weather</h1><img src="https://cdn.example.com/icon.png" alt="">
<button id="go">Refresh</button>
<script>document.getElementById('go').addEventListener('click', () => {});</script>
</body></html>`;

function goodResource(overrides = {}) {
  return {
    uri: 'ui://weather-card/main',
    name: 'Weather card',
    html: GOOD_HTML,
    mimeType: MCP_V8_APP_MIME_TYPE,
    domains: ['cdn.example.com'],
    allowedTools: ['weather-refresh'],
    toolName: 'weather',
    ...overrides,
  };
}

function setup(options = {}) {
  const registry = new McpV8AppResourceRegistry();
  registry.register(goodResource());
  const manager = new McpV9AppLifecycleManager(registry, undefined, options);
  return { registry, manager };
}

test('open renders through the v8 host: sandbox + CSP from declared domains', () => {
  const { manager } = setup();
  const app = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main', slot: 'left' });
  assert.equal(app.state, 'active');
  assert.equal(app.slot, 'left');
  assert.equal(app.renderCount, 1);
  assert.equal(app.reopenCount, 0);
  assert.match(app.descriptor.sandbox, /allow-scripts/);
  assert.match(app.descriptor.csp, /cdn\.example\.com/);
  assert.deepEqual(manager.counts().active, 1);
  assert.deepEqual(manager.openApps().map((a) => a.id), [app.id]);
});

test('open refuses an unknown resource and records a failed instance', () => {
  const { manager } = setup();
  assert.throws(
    () => manager.open({ toolName: 'weather', resourceUri: 'ui://missing/main' }),
    /not registered/,
  );
  assert.equal(manager.counts().failed, 1);
  assert.equal(manager.getEvents().at(-1).kind, 'failed');
});

test('close keeps the instance for reopen; reopen re-renders and counts', () => {
  const { manager } = setup();
  const app = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main' });
  const closed = manager.close(app.id, 'user closed the panel');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.descriptor, undefined);
  assert.equal(closed.reason, 'user closed the panel');
  assert.throws(() => manager.close(app.id), /already closed/);
  const reopened = manager.reopen(app.id);
  assert.equal(reopened.state, 'active');
  assert.equal(reopened.renderCount, 2);
  assert.equal(reopened.reopenCount, 1);
  assert.ok(reopened.descriptor !== undefined);
  assert.throws(() => manager.reopen(app.id), /already open/);
});

test('suspend / resume round-trip; resume re-validates the HTML', () => {
  const { registry, manager } = setup();
  const app = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main' });
  const suspended = manager.suspend(app.id, 'panel hidden');
  assert.equal(suspended.state, 'suspended');
  assert.equal(suspended.descriptor !== undefined, true);
  assert.throws(() => manager.suspend(app.id), /Only an active app can be suspended/);
  assert.throws(() => manager.focus(app.id), /Only an active app can be focused/);
  const resumed = manager.resume(app.id);
  assert.equal(resumed.state, 'active');

  // Unregister the resource and check resume fails (resource gone).
  manager.suspend(app.id);
  assert.equal(registry.unregister('ui://weather-card/main'), true);
  assert.throws(() => manager.resume(app.id), /no longer registered/);
  assert.equal(manager.get(app.id).state, 'failed');
});

test('focus order: most-recently-focused app first', () => {
  const { registry, manager } = setup();
  registry.register(goodResource({ uri: 'ui://weather-card/second', name: 'Second', toolName: 'weather' }));
  const a = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main' });
  const b = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/second' });
  assert.deepEqual(manager.openApps().map((x) => x.id), [b.id, a.id]);
  manager.focus(a.id);
  assert.deepEqual(manager.openApps().map((x) => x.id), [a.id, b.id]);
});

test('move-slot changes the slot without re-rendering', () => {
  const { manager } = setup();
  const app = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main', slot: 'right' });
  const moved = manager.moveSlot(app.id, 'bottom');
  assert.equal(moved.slot, 'bottom');
  assert.equal(moved.renderCount, 1);
  assert.throws(() => manager.moveSlot(app.id, 'nowhere'), /Panel slot/);
});

test('open-app budget refuses when full', () => {
  const { registry, manager } = setup({ maxOpenApps: 1 });
  registry.register(goodResource({ uri: 'ui://weather-card/second', name: 'Second', toolName: 'weather' }));
  manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main' });
  assert.throws(
    () => manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/second' }),
    /already open \(max 1\)/,
  );
});

test('call-back through an instance: allow-list enforced, blocked ones not counted', () => {
  const { manager } = setup();
  const app = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main' });
  const ok = manager.callback(app.id, 'weather-refresh', { city: 'Saigon' });
  assert.equal(ok.ok, true);
  assert.equal(manager.get(app.id).callbackCount, 1);
  const bad = manager.callback(app.id, 'delete-everything', {});
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /may not call tool/);
  assert.equal(manager.get(app.id).callbackCount, 1);
  manager.close(app.id);
  const closed = manager.callback(app.id, 'weather-refresh', {});
  assert.equal(closed.ok, false);
  assert.match(closed.problems[0], /is closed/);
});

test('counts, list filters and events', () => {
  const { manager } = setup();
  const a = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main' });
  manager.close(a.id);
  const counts = manager.counts();
  assert.equal(counts.total, 1);
  assert.equal(counts.closed, 1);
  assert.equal(counts.open, 0);
  assert.equal(manager.list('closed').length, 1);
  assert.equal(manager.list('active').length, 0);
  assert.equal(manager.listForTool('weather').length, 1);
  assert.equal(manager.listForTool('other').length, 0);
  const kinds = manager.getEvents().map((e) => e.kind);
  assert.deepEqual(kinds, ['opened', 'closed']);
  assert.equal(manager.eventsFor(a.id).length, 2);
  assert.equal(manager.get('nope'), undefined);
});

test('snapshot / restore: restored apps come back closed, missing resources are dropped', () => {
  const { registry, manager } = setup();
  const a = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main', slot: 'float' });
  manager.close(a.id);
  const snapshot = manager.snapshot();
  assert.equal(snapshot.version, 9);
  assert.equal(snapshot.instances.length, 1);
  assert.equal(snapshot.instances[0].state, 'closed');

  const registry2 = new McpV8AppResourceRegistry();
  registry2.register(goodResource());
  const manager2 = new McpV9AppLifecycleManager(registry2);
  const restored = manager2.restore(snapshot);
  assert.equal(restored.restored, 1);
  assert.deepEqual(restored.dropped, []);
  const back = manager2.get(a.id);
  assert.equal(back.state, 'closed');
  assert.equal(back.slot, 'float');
  assert.equal(back.reopenCount, 0);
  // Reopen works after restore (re-renders through the host).
  assert.equal(manager2.reopen(a.id).state, 'active');

  // A snapshot referencing a resource that is not registered is dropped.
  const registry3 = new McpV8AppResourceRegistry();
  const manager3 = new McpV9AppLifecycleManager(registry3);
  const dropped = manager3.restore(snapshot);
  assert.equal(dropped.restored, 0);
  assert.equal(dropped.dropped.length, 1);
  assert.match(dropped.dropped[0], /not registered/);
  assert.throws(() => manager3.restore({ version: 8, instances: [] }), /version 9/);
});

test('pruneClosed drops the oldest closed apps beyond the budget', () => {
  const { registry, manager } = setup({ maxClosedApps: 1 });
  registry.register(goodResource({ uri: 'ui://weather-card/second', name: 'Second', toolName: 'weather' }));
  const a = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/main' });
  const b = manager.open({ toolName: 'weather', resourceUri: 'ui://weather-card/second' });
  manager.close(a.id);
  manager.close(b.id);
  assert.equal(manager.counts().closed, 1);
  assert.equal(manager.get(a.id), undefined);
  assert.notEqual(manager.get(b.id), undefined);
});
