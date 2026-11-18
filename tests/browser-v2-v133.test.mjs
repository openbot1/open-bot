/**
 * Tests for browser driver v2 (v1.33, Đội T4):
 *  - a11y snapshot parse / serialize round-trip / diff
 *  - snapshot cache (diff vs full, token savings)
 *  - egress gate (allowlist, wildcard, form-submit, redirect chain, block log)
 *  - vision fallback (viewport validation, element registry, click audit)
 *  - driver v2 session (fake launcher — no real Chromium)
 *  - Playwright MCP server mode (JSON-RPC over handleRequest, no stdio)
 *  - 8 agent tools v2 (fake launcher) + i18n browserV2.* (18 keys x 6 locales)
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/browser-v2-v133.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseAriaSnapshot,
  serializeAriaSnapshot,
  assignRefs,
  findNodeByRef,
  interactiveNodes,
  diffSnapshots,
  renderSnapshotDiff,
  estimateTokens,
  truncateSnapshot,
  SnapshotCache,
  BrowserEgressGate,
  hostMatchesPattern,
  VisionFallback,
  BrowserV2Session,
  PlaywrightMcpServer,
  PLAYWRIGHT_MCP_TOOLS,
  createBrowserV2Tools,
  BROWSER_V2_TOOLS,
} from '../packages/tools/dist/browserV2/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'fr', 'es'];

const HOME_SNAPSHOT = [
  '- heading "Fixture Store" [level=1]',
  '- textbox "Search products" [ref=e1]',
  '- button "Search" [ref=e2]',
  '- link "Widget Pro" [ref=e3]',
  '- text: Welcome to the fixture store.',
].join('\n');

const CTX = { workspaceDir: '/tmp/open-bot-bw2-test', signal: undefined };

// ---------------------------------------------------------------------------
// a11y snapshot
// ---------------------------------------------------------------------------

test('a11y: parse snapshot Playwright -> nodes (role/name/ref/attrs)', () => {
  const nodes = parseAriaSnapshot(HOME_SNAPSHOT);
  assert.equal(nodes.length, 5);
  assert.equal(nodes[0].role, 'heading');
  assert.equal(nodes[0].name, 'Fixture Store');
  assert.equal(nodes[0].level, 1);
  assert.equal(nodes[1].role, 'textbox');
  assert.equal(nodes[1].ref, 'e1');
  assert.equal(nodes[4].role, 'text');
  assert.equal(nodes[4].name, 'Welcome to the fixture store.');
});

test('a11y: parse Playwright mode-ai inline value (textbox "Name" [ref=e4]: hello)', () => {
  const nodes = parseAriaSnapshot(
    [
      '- generic [active] [ref=e1]:',
      '  - heading "Hello" [level=1] [ref=e2]',
      '  - button "Click me" [ref=e3]',
      '  - textbox "Name" [ref=e4]: hello',
    ].join('\n'),
  );
  assert.equal(nodes.length, 1);
  const textbox = nodes[0].children[2];
  assert.equal(textbox.role, 'textbox');
  assert.equal(textbox.name, 'Name');
  assert.equal(textbox.ref, 'e4');
  assert.equal(textbox.value, 'hello');
  assert.equal(nodes[0].active, true);
});

test('a11y: parse nested generic block + checkbox states', () => {
  const text = [
    '- generic [ref=e1]:',
    '  - checkbox "Accept terms" [ref=e2] [checked]',
    '  - checkbox "Newsletter" [ref=e3] [checked=mixed] [disabled]',
    '  - button "Submit" [ref=e4] [disabled]',
  ].join('\n');
  const nodes = parseAriaSnapshot(text);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].children.length, 3);
  assert.equal(nodes[0].children[0].checked, true);
  assert.equal(nodes[0].children[1].checked, 'mixed');
  assert.equal(nodes[0].children[1].disabled, true);
  assert.equal(nodes[0].children[2].disabled, true);
});

test('a11y: serialize -> parse round-trip preserves tree', () => {
  const nodes = parseAriaSnapshot(HOME_SNAPSHOT);
  const text = serializeAriaSnapshot(nodes);
  const reparsed = parseAriaSnapshot(text);
  assert.deepEqual(reparsed, nodes);
});

test('a11y: assignRefs numbers nodes DFS (e1..eN, deterministic)', () => {
  const nodes = parseAriaSnapshot('- generic:\n  - button "A"\n  - button "B"');
  const numbered = assignRefs(nodes);
  assert.equal(numbered[0].ref, 'e1');
  assert.equal(numbered[0].children[0].ref, 'e2');
  assert.equal(numbered[0].children[1].ref, 'e3');
});

test('a11y: findNodeByRef + interactiveNodes', () => {
  const nodes = parseAriaSnapshot(HOME_SNAPSHOT);
  const btn = findNodeByRef(nodes, 'e2');
  assert.ok(btn);
  assert.equal(btn.role, 'button');
  assert.equal(findNodeByRef(nodes, 'e99'), null);
  const interactive = interactiveNodes(nodes);
  assert.deepEqual(
    interactive.map((n) => n.ref),
    ['e1', 'e2', 'e3'],
  );
});

test('a11y: diff detects added/removed/changed, render is short', () => {
  const prev = parseAriaSnapshot(HOME_SNAPSHOT);
  const nextText = [
    '- heading "Fixture Store" [level=1]',
    '- textbox "Search products" [ref=e1] [value="cats"]',
    '- button "Search" [ref=e2]',
    '- button "Cart (1)" [ref=e9]',
    '- text: Welcome to the fixture store.',
  ].join('\n');
  const next = parseAriaSnapshot(nextText);
  const diff = diffSnapshots(prev, next);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].ref, 'e9');
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].ref, 'e3');
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].after.ref, 'e1');
  assert.deepEqual(diff.changed[0].fields, ['value']);
  assert.equal(diff.unchangedCount, 3);
  const rendered = renderSnapshotDiff(diff);
  assert.ok(rendered.includes('[ref=e9]'));
  assert.ok(rendered.includes('Cart (1)'));
  // Diff ngắn hơn hẳn full snapshot.
  assert.ok(rendered.length < serializeAriaSnapshot(next).length * 2);
});

test('a11y: diff of identical snapshots is empty; estimateTokens + truncate', () => {
  const nodes = parseAriaSnapshot(HOME_SNAPSHOT);
  const diff = diffSnapshots(nodes, parseAriaSnapshot(HOME_SNAPSHOT));
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.unchangedCount, 5);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  const long = 'x'.repeat(100);
  const cut = truncateSnapshot(long, 20);
  assert.ok(cut.length < 100);
  assert.ok(cut.includes('truncated'));
});

// ---------------------------------------------------------------------------
// Snapshot cache
// ---------------------------------------------------------------------------

test('cache: step 0 full, step 1 diff, token savings counted', () => {
  const cache = new SnapshotCache();
  const first = cache.capture(HOME_SNAPSHOT, 'https://example.com/');
  assert.equal(first.payload.kind, 'full');
  const changed = HOME_SNAPSHOT.replace('[ref=e2]', '[ref=e2] [disabled]');
  const second = cache.capture(changed, 'https://example.com/');
  assert.equal(second.payload.kind, 'diff');
  assert.ok(second.payload.text.includes('disabled'));
  const stats = cache.stats();
  assert.equal(stats.steps, 2);
  assert.equal(stats.fullSnapshotsSent, 1);
  assert.equal(stats.diffsSent, 1);
  assert.ok(stats.tokensSaved > 0);
  assert.ok(stats.savedRatio > 0 && stats.savedRatio < 1);
});

test('cache: navigation to a new URL forces full snapshot', () => {
  const cache = new SnapshotCache();
  cache.capture(HOME_SNAPSHOT, 'https://example.com/');
  const second = cache.capture(HOME_SNAPSHOT, 'https://other.com/');
  assert.equal(second.payload.kind, 'full');
});

test('cache: huge change (>=60%) falls back to full snapshot', () => {
  const cache = new SnapshotCache({ fullSnapshotThreshold: 0.6 });
  cache.capture(HOME_SNAPSHOT, 'https://example.com/');
  const totallyDifferent = [
    '- heading "Other" [level=1]',
    '- button "X" [ref=e9]',
    '- button "Y" [ref=e10]',
    '- button "Z" [ref=e11]',
    '- text: nothing alike',
  ].join('\n');
  const second = cache.capture(totallyDifferent, 'https://example.com/');
  assert.equal(second.payload.kind, 'full');
});

test('cache: forceFull + reset work', () => {
  const cache = new SnapshotCache();
  cache.capture(HOME_SNAPSHOT, 'https://example.com/');
  const forced = cache.capture(HOME_SNAPSHOT, 'https://example.com/', { forceFull: true });
  assert.equal(forced.payload.kind, 'full');
  cache.reset();
  assert.equal(cache.stats().steps, 0);
  assert.equal(cache.latest(), null);
});

// ---------------------------------------------------------------------------
// Egress gate
// ---------------------------------------------------------------------------

test('gate: exact + wildcard + suffix matching', () => {
  assert.equal(hostMatchesPattern('example.com', 'example.com'), true);
  assert.equal(hostMatchesPattern('sub.example.com', '*.example.com'), true);
  assert.equal(hostMatchesPattern('example.com', '*.example.com'), false);
  assert.equal(hostMatchesPattern('deep.sub.example.com', '*.example.com'), true);
  assert.equal(hostMatchesPattern('sub.example.com', '.example.com'), true);
  assert.equal(hostMatchesPattern('evil.com', 'example.com'), false);
  assert.equal(hostMatchesPattern('example.com', '*'), true);
});

test('gate: allowlist allows start host, blocks others, logs blocks', () => {
  const gate = new BrowserEgressGate({
    allowedHosts: ['example.com', '*.cdn.example.com'],
    startUrl: 'https://example.com/home',
  });
  assert.equal(gate.check('https://example.com/page', 'navigate', 0).allowed, true);
  assert.equal(gate.check('https://a.cdn.example.com/x', 'navigate', 1).allowed, true);
  const blocked = gate.check('https://evil.example/page', 'navigate', 2);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /not in the egress allowlist/);
  assert.equal(gate.counts.blocked, 1);
  assert.equal(gate.blocks.length, 1);
  assert.equal(gate.blocks[0].url, 'https://evil.example/page');
  assert.equal(gate.blocks[0].step, 2);
});

test('gate: data:text/html allowed, other schemes + localhost blocked', () => {
  const gate = new BrowserEgressGate({ allowedHosts: ['example.com'] });
  assert.equal(gate.check('data:text/html,<h1>hi</h1>', 'navigate').allowed, true);
  assert.equal(gate.check('data:text/plain,hi', 'navigate').allowed, false);
  assert.equal(gate.check('file:///etc/passwd', 'navigate').allowed, false);
  assert.equal(gate.check('javascript:alert(1)', 'navigate').allowed, false);
  assert.equal(gate.check('http://localhost:3000/', 'navigate').allowed, false);
  const local = new BrowserEgressGate({ allowedHosts: [], allowLocalhost: true });
  assert.equal(local.check('http://localhost:3000/', 'navigate').allowed, true);
});

test('gate: form-submit to foreign host blocked even from allowed page', () => {
  const gate = new BrowserEgressGate({ allowedHosts: ['example.com'] });
  const ok = gate.checkFormSubmit('/submit', 'https://example.com/form');
  assert.equal(ok.allowed, true);
  const bad = gate.checkFormSubmit('https://evil.example/steal', 'https://example.com/form');
  assert.equal(bad.allowed, false);
  assert.equal(bad.action, 'form-submit');
});

test('gate: redirect chain — first blocked hop is returned', () => {
  const gate = new BrowserEgressGate({ allowedHosts: ['example.com'] });
  const blocked = gate.checkRedirectChain([
    'https://example.com/a',
    'https://evil.example/b',
    'https://example.com/c',
  ]);
  assert.ok(blocked);
  assert.equal(blocked.url, 'https://evil.example/b');
  assert.equal(gate.checkRedirectChain(['https://example.com/a']), null);
});

test('gate: allowAll + add/remove host at runtime', () => {
  const gate = new BrowserEgressGate({ allowAll: true });
  assert.equal(gate.check('https://anything.example/', 'navigate').allowed, true);
  const strict = new BrowserEgressGate({ allowedHosts: [] });
  assert.equal(strict.check('https://example.com/', 'navigate').allowed, false);
  strict.addAllowedHost('example.com');
  assert.equal(strict.check('https://example.com/', 'navigate').allowed, true);
  strict.removeAllowedHost('example.com');
  assert.equal(strict.check('https://example.com/', 'navigate').allowed, false);
});

// ---------------------------------------------------------------------------
// Vision fallback
// ---------------------------------------------------------------------------

test('vision: coordinates validated against viewport', () => {
  const v = new VisionFallback({ viewport: { width: 800, height: 600 } });
  assert.equal(v.validateCoordinates(100, 100), null);
  assert.match(v.validateCoordinates(800, 100) ?? '', /outside/);
  assert.match(v.validateCoordinates(-1, 100) ?? '', /negative/);
  assert.match(v.validateCoordinates(NaN, 100) ?? '', /finite/);
  assert.equal(v.isInViewport(799, 599), true);
  assert.equal(v.isInViewport(800, 599), false);
});

test('vision: register element + click by name records audit trail', async () => {
  const v = new VisionFallback();
  v.registerElement('canvas-chart', { x: 100, y: 100, width: 200, height: 100 }, 'price chart');
  const center = v.centerOfElement('canvas-chart');
  assert.deepEqual(center, { x: 200, y: 150 });
  let clicked = null;
  await v.clickElement('canvas-chart', {
    step: 3,
    url: 'https://example.com/',
    clicker: async (x, y) => {
      clicked = { x, y };
    },
  });
  assert.deepEqual(clicked, { x: 200, y: 150 });
  assert.equal(v.clickCount, 1);
  assert.equal(v.clickHistory[0].elementName, 'canvas-chart');
  assert.equal(v.clickHistory[0].step, 3);
  await assert.rejects(() => v.clickElement('no-such-element'), /no registered visual element/);
  await assert.rejects(() => v.clickAt(9999, 9999), /outside the .* viewport/);
});

// ---------------------------------------------------------------------------
// Fake v2 driver + session
// ---------------------------------------------------------------------------

/** Fake page: 2 trang (home -> product), click link e3 navigate. */
function makeFakeV2Launcher() {
  const pages = new Map([
    [
      'https://example.com/',
      {
        title: 'Home',
        snapshot: HOME_SNAPSHOT,
        clicks: { e3: 'https://example.com/product' },
      },
    ],
    [
      'https://example.com/product',
      {
        title: 'Product',
        snapshot: [
          '- heading "Widget Pro" [level=1]',
          '- text: Price: $19.99',
          '- button "Add to cart" [ref=e1]',
        ].join('\n'),
        clicks: {},
      },
    ],
  ]);
  return async () => {
    let currentUrl = '';
    let currentSnapshot = '';
    let clickedRefs = [];
    let filledRefs = [];
    let clickedAt = [];
    let closed = false;
    const page = {
      url: () => currentUrl,
      title: () => Promise.resolve(pages.get(currentUrl)?.title ?? ''),
      goto: (url) => {
        const def = pages.get(url);
        if (!def) return Promise.reject(new Error(`fake: no page ${url}`));
        currentUrl = url;
        currentSnapshot = def.snapshot;
        return Promise.resolve();
      },
      click: () => Promise.resolve(),
      fill: () => Promise.resolve(),
      screenshot: () => Promise.resolve(Buffer.from('89504e470d0a1a0a', 'hex')),
      innerText: () => Promise.resolve(currentSnapshot),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      ariaSnapshot: () => Promise.resolve(currentSnapshot),
      clickRef: (ref) => {
        clickedRefs.push(ref);
        const target = pages.get(currentUrl)?.clicks[ref];
        if (target) {
          currentUrl = target;
          currentSnapshot = pages.get(target).snapshot;
        }
        return Promise.resolve();
      },
      fillRef: (ref, text) => {
        filledRefs.push({ ref, text });
        return Promise.resolve();
      },
      clickAt: (x, y) => {
        clickedAt.push({ x, y });
        return Promise.resolve();
      },
      viewportSize: () => Promise.resolve({ width: 1280, height: 720 }),
      goBack: () => {
        currentUrl = 'https://example.com/';
        currentSnapshot = pages.get(currentUrl).snapshot;
        return Promise.resolve();
      },
      __state: { clickedRefs, filledRefs, clickedAt, get closed() { return closed; } },
    };
    return {
      newPage: () => Promise.resolve(page),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      __page: page,
    };
  };
}

test('session v2: navigate + snapshot (full then diff) + clickRef navigates', async () => {
  const launcher = makeFakeV2Launcher();
  const session = new BrowserV2Session({
    createBrowser: launcher,
    egress: { allowedHosts: ['example.com'] },
  });
  const url = await session.navigate('https://example.com/');
  assert.equal(url, 'https://example.com/');
  const snap1 = await session.snapshot();
  assert.equal(snap1.payload.kind, 'full');
  assert.equal(snap1.nodeCount, 5);
  const clicked = await session.clickRef('e3');
  assert.match(clicked, /Widget Pro/);
  assert.equal(session.url, 'https://example.com/product');
  const snap2 = await session.snapshot();
  // URL đổi -> full snapshot (không phải diff).
  assert.equal(snap2.payload.kind, 'full');
  assert.ok(snap2.payload.text.includes('$19.99'));
  const stats = session.cache.stats();
  assert.equal(stats.steps, 2);
  await session.close();
  assert.equal(session.isOpen(), false);
});

test('session v2: navigate outside allowlist is blocked before launch', async () => {
  const launcher = makeFakeV2Launcher();
  const session = new BrowserV2Session({
    createBrowser: launcher,
    egress: { allowedHosts: ['example.com'] },
  });
  await assert.rejects(() => session.navigate('https://evil.example/'), /egress gate/);
  assert.equal(session.isOpen(), false);
  assert.equal(session.gate.counts.blocked, 1);
  await session.close();
});

test('session v2: clickRef with unknown ref fails with vision hint; disabled ref fails', async () => {
  const launcher = makeFakeV2Launcher();
  const session = new BrowserV2Session({
    createBrowser: launcher,
    egress: { allowedHosts: ['example.com'] },
  });
  await session.navigate('https://example.com/');
  await session.snapshot();
  await assert.rejects(() => session.clickRef('e99'), /vision fallback/);
  await session.close();
});

test('session v2: clickAt validates + records vision step; typeRef fills', async () => {
  const launcher = makeFakeV2Launcher();
  const session = new BrowserV2Session({
    createBrowser: launcher,
    egress: { allowedHosts: ['example.com'] },
  });
  await session.navigate('https://example.com/');
  await session.snapshot();
  const typed = await session.typeRef('e1', 'cats');
  assert.match(typed, /Typed 4 chars/);
  const clicked = await session.clickAt(640, 360);
  assert.match(clicked, /vision fallback/);
  assert.equal(session.vision.clickCount, 1);
  assert.ok(session.stepsLog.some((s) => s.viaVision && s.action === 'clickAt'));
  await assert.rejects(() => session.clickAt(99999, 10), /outside/);
  const summary = session.statusSummary();
  assert.match(summary, /tokens saved/);
  assert.match(summary, /Egress gate/);
  await session.close();
});

test('session v2: goBack returns to home and is gate-checked', async () => {
  const launcher = makeFakeV2Launcher();
  const session = new BrowserV2Session({
    createBrowser: launcher,
    egress: { allowedHosts: ['example.com'] },
  });
  await session.navigate('https://example.com/');
  await session.clickRef('e3');
  assert.equal(session.url, 'https://example.com/product');
  const back = await session.goBack();
  assert.equal(back, 'https://example.com/');
  await session.close();
});

// ---------------------------------------------------------------------------
// MCP server mode
// ---------------------------------------------------------------------------

test('mcp: initialize + tools/list + tools/call navigate/snapshot/click', async () => {
  const launcher = makeFakeV2Launcher();
  const session = new BrowserV2Session({
    createBrowser: launcher,
    egress: { allowedHosts: ['example.com'] },
  });
  const server = new PlaywrightMcpServer({ sessionInstance: session });
  const init = await server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' },
  });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.equal(init.result.serverInfo.name, 'open-bot-browser');
  const list = await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  for (const expected of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_click_at', 'browser_screenshot', 'browser_go_back', 'browser_close']) {
    assert.ok(names.includes(expected), `missing MCP tool ${expected}`);
  }
  assert.equal(list.result.tools.length, PLAYWRIGHT_MCP_TOOLS.length);
  const nav = await server.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'browser_navigate', arguments: { url: 'https://example.com/' } },
  });
  assert.match(nav.result.content[0].text, /Navigated to/);
  const snap = await server.handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'browser_snapshot', arguments: {} },
  });
  assert.match(snap.result.content[0].text, /Fixture Store/);
  const click = await server.handleRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'browser_click', arguments: { ref: 'e3' } },
  });
  assert.match(click.result.content[0].text, /Clicked/);
  await session.close();
});

test('mcp: unknown tool / bad args / uninitialized return errors, not crashes', async () => {
  const server = new PlaywrightMcpServer({
    sessionInstance: new BrowserV2Session({
      createBrowser: makeFakeV2Launcher(),
      egress: { allowedHosts: ['example.com'] },
    }),
  });
  const unknown = await server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'browser_nope', arguments: {} },
  });
  assert.equal(unknown.error.code, -32002); // not initialized yet
  await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  const badTool = await server.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'browser_nope', arguments: {} },
  });
  assert.equal(badTool.result.isError, true);
  const badArgs = await server.handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'browser_navigate', arguments: {} },
  });
  assert.equal(badArgs.result.isError, true);
  const badMethod = await server.handleRequest({ jsonrpc: '2.0', id: 5, method: 'nope/method' });
  assert.equal(badMethod.error.code, -32601);
  const ping = await server.handleRequest({ jsonrpc: '2.0', id: 6, method: 'ping' });
  assert.deepEqual(ping.result, {});
  const notif = await server.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif, null);
  // Blocked navigation via MCP returns isError (SEP-1303), not a protocol error.
  const blocked = await server.handleRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'browser_navigate', arguments: { url: 'https://evil.example/' } },
  });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /egress gate/);
  await server.session.close();
});

test('mcp: browser_evaluate_form answers allowed/blocked without submitting', async () => {  const server = new PlaywrightMcpServer({
    sessionInstance: new BrowserV2Session({
      createBrowser: makeFakeV2Launcher(),
      egress: { allowedHosts: ['example.com'] },
    }),
  });
  await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const ok = await server.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'browser_evaluate_form', arguments: { formAction: 'https://example.com/submit' } },
  });
  assert.match(ok.result.content[0].text, /ALLOWED/);
  const bad = await server.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'browser_evaluate_form', arguments: { formAction: 'https://evil.example/steal' } },
  });
  assert.match(bad.result.content[0].text, /BLOCKED/);
  await server.session.close();
});

// ---------------------------------------------------------------------------
// Agent tools v2
// ---------------------------------------------------------------------------

test('tools v2: 8 tools, names + approval flags, snapshot needs navigation first', async () => {
  const { createBrowserV2ToolsSession } = await import('../packages/tools/dist/browserV2Tools.js');
  const { tools } = createBrowserV2ToolsSession();
  assert.equal(tools.length, 8);
  const names = tools.map((t) => t.definition.name);
  assert.deepEqual(names, [
    'browser_v2_navigate',
    'browser_snapshot',
    'browser_click_ref',
    'browser_type_ref',
    'browser_click_at',
    'browser_v2_status',
    'browser_egress_check',
    'browser_v2_eval',
  ]);
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  assert.equal(byName.get('browser_v2_navigate').needsApproval, true);
  assert.equal(byName.get('browser_snapshot').needsApproval, false);
  assert.equal(byName.get('browser_v2_status').needsApproval, false);
  // Default export list matches the factory.
  assert.equal(BROWSER_V2_TOOLS.length, 8);
  // createBrowserV2Tools factory (default session, no browser yet).
  const created = createBrowserV2Tools();
  assert.equal(created.length, 8);
});

test('tools v2: snapshot without navigation errors; egress_check answers; status is read-only', async () => {
  const { createBrowserV2ToolsSession } = await import('../packages/tools/dist/browserV2Tools.js');
  const { tools, session } = createBrowserV2ToolsSession({
    createBrowser: makeFakeV2Launcher(),
    egress: { allowedHosts: ['example.com'] },
  });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const snapBefore = await byName.get('browser_snapshot').execute({}, CTX);
  assert.match(snapBefore, /Navigate first/);
  const nav = await byName.get('browser_v2_navigate').execute({ url: 'https://example.com/' }, CTX);
  assert.match(nav, /Navigated to/);
  const snap = await byName.get('browser_snapshot').execute({}, CTX);
  assert.match(snap, /Fixture Store/);
  assert.match(snap, /\(full\)/);
  const snap2 = await byName.get('browser_snapshot').execute({}, CTX);
  assert.match(snap2, /\(diff\)/);
  const blocked = await byName.get('browser_v2_navigate').execute({ url: 'https://evil.example/' }, CTX);
  assert.match(blocked, /Error: .*egress gate/);
  const formOk = await byName.get('browser_egress_check').execute({ formAction: 'https://example.com/submit' }, CTX);
  assert.match(formOk, /ALLOWED/);
  const formBad = await byName.get('browser_egress_check').execute({ formAction: 'https://evil.example/steal' }, CTX);
  assert.match(formBad, /BLOCKED/);
  // typeRef refuses secret-looking text (>= 32 chars, mixed case+digits, no spaces).
  const secret = await byName.get('browser_type_ref').execute({ ref: 'e1', text: 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGh' }, CTX);
  assert.match(secret, /Refusing to type/);
  const status = await byName.get('browser_v2_status').execute({}, CTX);
  assert.match(status, /Browser v2 session/);
  await session.close();
});

test('tools v2: browser_v2_eval runs the fixture eval end to end', async () => {
  const { createBrowserV2ToolsSession } = await import('../packages/tools/dist/browserV2Tools.js');
  const { tools, session } = createBrowserV2ToolsSession({
    createBrowser: makeFakeV2Launcher(),
    egress: { allowedHosts: ['example.com'] },
  });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const out = await byName.get('browser_v2_eval').execute({}, CTX);
  assert.match(out, /WebVoyager-local eval/);
  assert.match(out, /Success: 8\/8/);
  await session.close();
});

// ---------------------------------------------------------------------------
// MCP server over real stdio pipes + REAL Chromium smoke test
// ---------------------------------------------------------------------------

test('mcp: serveStdio speaks NDJSON (initialize -> tools/call -> parse error)', async () => {
  const { PassThrough } = await import('node:stream');
  const server = new PlaywrightMcpServer({
    sessionInstance: new BrowserV2Session({
      createBrowser: makeFakeV2Launcher(),
      egress: { allowedHosts: ['example.com'] },
    }),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let outBuf = '';
  output.on('data', (chunk) => {
    outBuf += chunk.toString();
  });
  const serving = server.serveStdio(input, output);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com/' } } }) + '\n');
  input.write('this is not json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.end();
  await serving;
  const responses = outBuf
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  // 3 responses: initialize, tools/call, parse error. Notification: none.
  assert.equal(responses.length, 3);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.serverInfo.name, 'open-bot-browser');
  assert.equal(responses[1].id, 2);
  assert.match(responses[1].result.content[0].text, /Navigated to/);
  assert.equal(responses[2].error.code, -32700);
  await server.session.close();
});

test('session v2: REAL Chromium smoke — snapshot refs, clickRef, typeRef, diff (skips when no Chromium)', async (t) => {
  const session = new BrowserV2Session({ egress: { allowedHosts: [] } });
  try {
    const html =
      '<html><body><h1>Hello</h1>' +
      '<button onclick="document.title=\'clicked\'">Click me</button>' +
      '<input type="text" aria-label="Name"></body></html>';
    let navigated;
    try {
      navigated = await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    } catch (err) {
      t.skip(`Chromium thật chưa cài được (${(err).message}) — chạy \`npx playwright install chromium\`.`);
      return;
    }
    assert.ok(navigated.startsWith('data:text/html'));
    const snap1 = await session.snapshot();
    // Playwright mode 'ai' phải kèm ref thật (e1..eN), không phải auto-*.
    assert.equal(snap1.payload.kind, 'full');
    assert.ok(snap1.payload.text.includes('[ref=e3]'), `expected real refs, got:\n${snap1.payload.text}`);
    const clicked = await session.clickRef('e3');
    assert.match(clicked, /Clicked \[ref=e3\] button "Click me"/);
    const typed = await session.typeRef('e4', 'hello');
    assert.match(typed, /Typed 5 chars/);
    const snap2 = await session.snapshot();
    // Chỉ value + active đổi -> diff, không phải full.
    assert.equal(snap2.payload.kind, 'diff');
    assert.match(snap2.payload.text, /value: "" -> "hello"/);
    assert.equal(session.vision.clickCount, 0);
  } finally {
    await session.close();
  }
  assert.equal(session.isOpen(), false);
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

const BROWSER_V2_KEYS = [
  'browserV2.blocked',
  'browserV2.clickAt',
  'browserV2.clickRef',
  'browserV2.close',
  'browserV2.diff',
  'browserV2.egressCheck',
  'browserV2.eval',
  'browserV2.evalTitle',
  'browserV2.full',
  'browserV2.goBack',
  'browserV2.navigate',
  'browserV2.noPageOpen',
  'browserV2.refNotFound',
  'browserV2.snapshot',
  'browserV2.status',
  'browserV2.title',
  'browserV2.tokensSaved',
  'browserV2.typeRef',
];

test('i18n: 18 key browserV2.* có đủ 6 locale, giá trị không rỗng, tổng 7540', () => { // v1.36 re-pin: 7540.
  assert.equal(BROWSER_V2_KEYS.length, 18);
  for (const locale of LOCALES) {
    const data = JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8'));
    // v1.33 T4 re-pin: 6863 + 18 browserV2 = 6881. (Merge coordinator
    // re-pin lại nếu các đội khác cùng sóng thêm key.)
    assert.equal(Object.keys(data).length, 7540, `${locale} total keys`); // v1.36 re-pin: 7540.
    for (const key of BROWSER_V2_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} missing`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} empty`);
    }
  }
});

test('i18n: locale files vẫn sorted (không vỡ thứ tự key)', () => {
  for (const locale of LOCALES) {
    const data = JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8'));
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${locale} keys must stay sorted`);
  }
});
