/**
 * MCP Apps live template + data tests (v1.09, Team T3 — node:test, không mạng live).
 *
 * Covers packages/core/src/mcp/appsLive.ts:
 *  - renderAppTemplate: placeholder thay bằng giá trị đã escape HTML
 *    (dữ liệu chứa <script> chỉ hiện thành text), placeholder thiếu
 *    được báo missing, object thành JSON escape
 *  - readDataPath: path lồng nhau + index mảng
 *  - applyDataPatch: JSON Merge Patch (null xoá key, merge đệ quy,
 *    array thay nguyên, không mutate đầu vào, quá sâu thì lỗi)
 *  - createAppLiveInstance: template lỗi (script src ngoài) bị chặn,
 *    data quá lớn bị chặn, TTL
 *  - patchAppLiveInstance: version tăng, stale patch bị từ chối
 *  - setAppLiveStatus: state machine hợp lệ / sai bị ném lỗi,
 *    progress ngoài 0..100 bị ném lỗi
 *  - parseLiveAppResult: dạng uiTemplate + dạng resource ui:// + data,
 *    result thường -> { app: null } không error
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v109-apps-live.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDataPatch,
  canTransitionAppStatus,
  createAppLiveInstance,
  describeAppLiveInstance,
  escapeAppDataHtml,
  isAppLiveExpired,
  isAppToolCallTerminal,
  listTemplatePlaceholders,
  parseLiveAppResult,
  patchAppLiveInstance,
  readDataPath,
  renderAppTemplate,
  setAppLiveStatus,
} from '../packages/core/dist/mcp/appsLive.js';

const BASE = { toolName: 'demo_tool', serverName: 'srv', now: () => 5_000_000 };

// ---------------------------------------------------------------------------
// escape + path + placeholders
// ---------------------------------------------------------------------------

test('live: escapeAppDataHtml escape đủ 5 ký tự nguy hiểm', () => {
  assert.equal(escapeAppDataHtml('<script>"\'&</script>'), '&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;');
});

test('live: readDataPath đọc object lồng + index mảng, thiếu trả undefined', () => {
  const data = { user: { name: 'An', tags: ['a', 'b'] }, n: 0 };
  assert.equal(readDataPath(data, 'user.name'), 'An');
  assert.equal(readDataPath(data, 'user.tags.1'), 'b');
  assert.equal(readDataPath(data, 'user.tags.5'), undefined);
  assert.equal(readDataPath(data, 'missing.deep'), undefined);
  assert.equal(readDataPath(data, 'n'), 0);
});

test('live: listTemplatePlaceholders liệt kê đủ, không trùng', () => {
  assert.deepEqual(
    listTemplatePlaceholders('<p>{{user.name}}</p><p>{{user.name}}</p><span>{{items.0.title}}</span>'),
    ['user.name', 'items.0.title'],
  );
});

// ---------------------------------------------------------------------------
// render template
// ---------------------------------------------------------------------------

test('live: render thay placeholder bằng giá trị đã escape — dữ liệu chứa script chỉ thành text', () => {
  const { html, missing } = renderAppTemplate(
    '<h1>{{title}}</h1><p>{{comment}}</p>',
    { title: 'Chào', comment: '<script>alert(1)</script>' },
  );
  assert.equal(html, '<h1>Chào</h1><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.deepEqual(missing, []);
  assert.ok(!html.includes('<script>alert'));
});

test('live: placeholder thiếu giá trị giữ nguyên + báo missing', () => {
  const { html, missing } = renderAppTemplate('<p>{{a}} {{b.c}}</p>', { a: 'x' });
  assert.equal(html, '<p>x {{b.c}}</p>');
  assert.deepEqual(missing, ['b.c']);
});

test('live: giá trị object render thành JSON đã escape, null thành rỗng', () => {
  const { html } = renderAppTemplate('<pre>{{obj}}</pre><span>{{nothing}}</span>', {
    obj: { a: 1 },
    nothing: null,
  });
  assert.ok(html.includes('{&quot;a&quot;:1}'));
  assert.ok(html.includes('<span></span>'));
});

// ---------------------------------------------------------------------------
// data patch
// ---------------------------------------------------------------------------

test('live: applyDataPatch merge đệ quy, null xoá key, array thay nguyên, không mutate', () => {
  const data = { a: { x: 1, y: 2 }, list: [1, 2], keep: true };
  const out = applyDataPatch(data, { a: { y: 20, z: 3 }, list: [9], keep: null });
  assert.deepEqual(out, { a: { x: 1, y: 20, z: 3 }, list: [9] });
  assert.deepEqual(data, { a: { x: 1, y: 2 }, list: [1, 2], keep: true });
  assert.throws(() => {
    let deep = { v: 1 };
    for (let i = 0; i < 15; i++) deep = { next: deep };
    applyDataPatch({}, deep);
  }, /quá sâu/);
});

// ---------------------------------------------------------------------------
// instance lifecycle
// ---------------------------------------------------------------------------

test('live: tạo instance ok — version 1, status idle, TTL, describe', () => {
  const inst = createAppLiveInstance('<h1>{{title}}</h1>', { title: 'Hi' }, BASE);
  assert.equal(inst.version, 1);
  assert.equal(inst.status, 'idle');
  assert.equal(inst.expiresAtMs, 5_000_000 + 30 * 60_000);
  assert.equal(isAppLiveExpired(inst, 5_000_000), false);
  assert.equal(isAppLiveExpired(inst, 5_000_000 + 30 * 60_000 + 1), true);
  assert.match(describeAppLiveInstance(inst), /v1 idle/);
});

test('live: template chứa script src ngoài bị chặn ngay khi tạo instance', () => {
  assert.throws(
    () => createAppLiveInstance('<script src="https://evil.example.com/x.js"></script>', {}, BASE),
    /không hợp lệ/,
  );
});

test('live: patch tăng version + cập nhật data; stale patch bị từ chối', () => {
  const inst = createAppLiveInstance('<p>{{count}}</p>', { count: 1 }, BASE);
  const next = patchAppLiveInstance(inst, { count: 2 }, { now: () => 5_000_100 });
  assert.equal(next.version, 2);
  assert.equal(next.data.count, 2);
  assert.equal(inst.version, 1);
  assert.throws(
    () => patchAppLiveInstance(next, { count: 3 }, { expectedVersion: 1 }),
    /stale/,
  );
  const ok = patchAppLiveInstance(next, { count: 3 }, { expectedVersion: 2 });
  assert.equal(ok.version, 3);
});

test('live: state machine — idle->running->progress->done ok; done->running sai; progress sai bị chặn', () => {
  assert.equal(canTransitionAppStatus('idle', 'running'), true);
  assert.equal(canTransitionAppStatus('done', 'running'), false);
  assert.equal(isAppToolCallTerminal('done'), true);
  assert.equal(isAppToolCallTerminal('running'), false);
  const inst = createAppLiveInstance('<p>x</p>', {}, BASE);
  const running = setAppLiveStatus(inst, 'running', { message: 'bắt đầu' });
  const prog = setAppLiveStatus(running, 'progress', { progress: 55 });
  assert.equal(prog.progress, 55);
  const done = setAppLiveStatus(prog, 'done');
  assert.equal(done.status, 'done');
  assert.throws(() => setAppLiveStatus(done, 'running'), /Không thể chuyển/);
  assert.throws(() => setAppLiveStatus(running, 'progress', { progress: 101 }), /0\.\.100/);
});

// ---------------------------------------------------------------------------
// parseLiveAppResult
// ---------------------------------------------------------------------------

test('live: parse dạng uiTemplate trong structuredContent', () => {
  const { app, error } = parseLiveAppResult(
    { content: [], structuredContent: { uiTemplate: { template: '<b>{{name}}</b>', data: { name: 'An' }, title: 'Card' } } },
    { toolName: 't', serverName: 's', now: () => 1000 },
  );
  assert.equal(error, undefined);
  assert.equal(app.title, 'Card');
  assert.equal(app.data.name, 'An');
});

test('live: parse dạng resource ui:// + appData', () => {
  const { app } = parseLiveAppResult(
    {
      content: [{ type: 'resource', uri: 'ui://srv/card', text: '<i>{{v}}</i>' }],
      structuredContent: { appData: { v: 7 } },
    },
    { toolName: 't', serverName: 's', now: () => 1000 },
  );
  assert.equal(app.uri, 'ui://srv/card');
  assert.equal(app.data.v, 7);
});

test('live: uiTemplate sai (thiếu template / data không phải object) trả error rõ', () => {
  const bad1 = parseLiveAppResult(
    { content: [], structuredContent: { uiTemplate: { data: {} } } },
    { toolName: 't', serverName: 's' },
  );
  assert.equal(bad1.app, null);
  assert.match(bad1.error, /thiếu template/);
  const bad2 = parseLiveAppResult(
    { content: [], structuredContent: { uiTemplate: { template: '<p>x</p>', data: 'nope' } } },
    { toolName: 't', serverName: 's' },
  );
  assert.match(bad2.error, /phải là object/);
});

test('live: result thường (không app) trả { app: null } không error', () => {
  const res = parseLiveAppResult({ content: [{ type: 'text', text: 'hello' }] }, { toolName: 't', serverName: 's' });
  assert.equal(res.app, null);
  assert.equal(res.error, undefined);
  const res2 = parseLiveAppResult('not-an-object', { toolName: 't', serverName: 's' });
  assert.equal(res2.app, null);
});
