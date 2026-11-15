/**
 * Tests v1.09 (Đội T4): 2 tool A2A v1.1 mới — a2a_verify_card_v11 (cổng
 * kết nối qua server thật) + a2a_negotiate_version (thuần tính toán).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/a2a-v109-tools.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createA2aTools } from '../packages/tools/dist/a2aTools.js';
import { startA2aHttpServer } from '../packages/core/dist/a2a/server.js';

const servers = [];
after(async () => {
  for (const srv of servers) {
    try { await srv.close(); } catch { /* already closed */ }
  }
});

const echoRunner = async ({ text }) => ({ text: `echo: ${text}` });

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `thiếu tool ${name}`);
  return tool;
}

test('tools v1.09: a2a_negotiate_version đàm phán đúng, không gọi mạng', async () => {
  const tools = createA2aTools();
  const negotiate = toolByName(tools, 'a2a_negotiate_version');
  const out = JSON.parse(
    await negotiate.execute({ clientVersions: '1.1,1.0.1', serverVersions: '1.0' }, {}),
  );
  assert.equal(out.ok, true);
  assert.equal(out.negotiated, '1.0');
  assert.ok(!out.features.includes('resumableStreams'));
  const out2 = JSON.parse(
    await negotiate.execute(
      { clientVersions: '1.1', serverVersions: '1.1', wantedFeatures: 'resumableStreams,multiTenancy' },
      {},
    ),
  );
  assert.equal(out2.negotiated, '1.1');
  assert.deepEqual(out2.missingFeatures, []);
  const out3 = JSON.parse(
    await negotiate.execute({ clientVersions: '2.0', serverVersions: '1.1' }, {}),
  );
  assert.equal(out3.ok, false);
  assert.equal(out3.negotiated, null);
});

test('tools v1.09: a2a_verify_card_v11 allowed=true với server local thật', async () => {
  const srv = await startA2aHttpServer({ allowUnauthenticated: true, runner: echoRunner }, { port: 0 });
  servers.push(srv);
  const tools = createA2aTools();
  const verify = toolByName(tools, 'a2a_verify_card_v11');
  const out = JSON.parse(await verify.execute({ url: srv.url }, {}));
  assert.equal(out.allowed, true);
  assert.equal(typeof out.negotiatedVersion, 'string');
  assert.ok(Array.isArray(out.checks));
  assert.ok(out.checks.some((c) => c.id === 'version' && c.ok));
  assert.equal(out.trusted, false);
});

test('tools v1.09: a2a_verify_card_v11 chặn server có card hỏng (URL không phải A2A)', async () => {
  const tools = createA2aTools();
  const verify = toolByName(tools, 'a2a_verify_card_v11');
  const out = await verify.execute({ url: 'http://127.0.0.1:1/' }, {});
  assert.match(out, /Lỗi|không|error/i);
});
