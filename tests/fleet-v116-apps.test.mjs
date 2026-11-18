/**
 * App integration mới v13 tests (v1.16, Đội T6 — node:test, no network).
 *
 * Covers:
 * - 6 toolkit mới, không trùng slug với toolkit cũ (docusign,
 *   freshbooks, gong, lever, quickbooks, resend); tổng số tool
 *   được pin (53 tool, 16 tool ghi); mọi tool có prefix đúng slug;
 *   không action trùng; validate sạch.
 * - find toolkit/tool: theo slug/action, không phân biệt hoa thường;
 *   không tìm thấy → null.
 * - Mock responses: mọi tool đều có mock (có nhãn mock: true);
 *   mock là dữ liệu mẫu có prefix mock-; action lạ → null.
 * - Per-app health: probe ok → healthy (chậm >= 2000ms →
 *   degraded); 3 lỗi liên tiếp → down; lỗi lẻ → degraded.
 * - Per-app quota: fraction, cảnh báo 80%, hết quota; ghi nhận
 *   dùng vượt giới hạn → từ chối; không giới hạn → không cảnh báo.
 * - Summary: đếm healthy/down/not-connected + quota warn/exhausted.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v116-apps.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPOSIO_V13_TOOLKITS,
  COMPOSIO_V13_TOOLKIT_SLUGS,
  composioV13AllToolsHaveMocks,
  composioV13MockResponse,
  composioV13QuotaFraction,
  composioV13QuotaWarning,
  composioV13ToolCount,
  composioV13WriteToolCount,
  createComposioV13AppHealth,
  createComposioV13AppQuota,
  findComposioV13Tool,
  findComposioV13Toolkit,
  recordComposioV13QuotaUse,
  summarizeComposioV13Apps,
  updateComposioV13AppHealth,
  validateComposioV13Toolkits,
} from '../packages/core/dist/fleetV13/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

test('six new toolkits: pinned slugs, 54 tools, 15 write tools, no duplicates, validation clean', () => {
  assert.deepEqual([...COMPOSIO_V13_TOOLKIT_SLUGS], [
    'docusign',
    'freshbooks',
    'gong',
    'lever',
    'quickbooks',
    'resend',
  ]);
  assert.equal(COMPOSIO_V13_TOOLKITS.length, 6);
  assert.equal(composioV13ToolCount(), 54);
  assert.equal(composioV13WriteToolCount(), 15);
  assert.deepEqual(validateComposioV13Toolkits(), []);
  for (const toolkit of COMPOSIO_V13_TOOLKITS) {
    assert.ok(toolkit.tools.length >= 8 && toolkit.tools.length <= 10, `${toolkit.slug} has ${toolkit.tools.length} tools`);
    assert.ok(toolkit.liveNote.includes('[MOCK]'), `${toolkit.slug} liveNote must say MOCK`);
    assert.ok(toolkit.description.length > 0);
    for (const toolDef of toolkit.tools) {
      assert.ok(toolDef.action.startsWith(`${toolkit.slug.toUpperCase()}_`), toolDef.action);
      assert.ok(toolDef.description.length > 0);
    }
  }
  // Không trùng slug với toolkit cũ trong repo (đối chiếu trực tiếp file).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '..');
  const oldSlugs = new Set();
  for (const file of fs.readdirSync(path.join(root, 'packages/core/src/composio'))) {
    if (!file.startsWith('toolkits')) continue;
    const src = fs.readFileSync(path.join(root, 'packages/core/src/composio', file), 'utf8');
    for (const m of src.matchAll(/slug: '([a-z0-9-]+)'/g)) oldSlugs.add(m[1]);
  }
  for (const slug of COMPOSIO_V13_TOOLKIT_SLUGS) {
    assert.equal(oldSlugs.has(slug), false, `slug ${slug} already exists in older toolkits`);
  }
});

test('find toolkit/tool: case-insensitive; missing returns null', () => {
  assert.equal(findComposioV13Toolkit('DocuSign')?.displayName, 'DocuSign');
  assert.equal(findComposioV13Toolkit('QUICKBOOKS')?.slug, 'quickbooks');
  assert.equal(findComposioV13Toolkit('notion'), null);
  assert.equal(findComposioV13Toolkit(''), null);
  const hit = findComposioV13Tool('docusign_send_envelope');
  assert.ok(hit);
  assert.equal(hit.toolkit.slug, 'docusign');
  assert.equal(hit.tool.write, true);
  const read = findComposioV13Tool('RESEND_LIST_EMAILS');
  assert.ok(read);
  assert.equal(read.tool.write, false);
  assert.equal(findComposioV13Tool('NOPE_ACTION'), null);
  assert.equal(findComposioV13Tool(''), null);
});

test('mock responses: every tool has a mock labelled mock:true; unknown action null', () => {
  assert.equal(composioV13AllToolsHaveMocks(), true);
  for (const toolkit of COMPOSIO_V13_TOOLKITS) {
    for (const toolDef of toolkit.tools) {
      const mock = composioV13MockResponse(toolDef.action);
      assert.ok(mock, `missing mock for ${toolDef.action}`);
      assert.equal(mock.mock, true);
    }
  }
  assert.equal(composioV13MockResponse('NOPE_ACTION'), null);
  assert.equal(composioV13MockResponse(''), null);
  // Mock là bản sao (sửa bản trả về không ảnh hưởng bản gốc).
  const m1 = composioV13MockResponse('RESEND_SEND_EMAIL');
  m1.sent = false;
  assert.equal(composioV13MockResponse('RESEND_SEND_EMAIL').sent, true);
});

test('app health: ok→healthy, slow→degraded, 3 consecutive errors→down, recovery resets', () => {
  let health = createComposioV13AppHealth('gong');
  assert.equal(health.status, 'not-connected');
  assert.equal(health.lastOkAt, null);

  health = updateComposioV13AppHealth(health, { ok: true, latencyMs: 120 }, T0);
  assert.equal(health.status, 'healthy');
  assert.equal(health.lastLatencyMs, 120);
  assert.equal(health.lastOkAt, T0);
  assert.equal(health.consecutiveErrors, 0);

  health = updateComposioV13AppHealth(health, { ok: true, latencyMs: 2500 }, T0 + 1000);
  assert.equal(health.status, 'degraded');
  assert.equal(health.consecutiveErrors, 0);

  health = updateComposioV13AppHealth(health, { ok: false, error: 'timeout' }, T0 + 2000);
  assert.equal(health.status, 'degraded');
  assert.equal(health.consecutiveErrors, 1);
  assert.equal(health.lastError, 'timeout');
  health = updateComposioV13AppHealth(health, { ok: false, error: 'timeout' }, T0 + 3000);
  assert.equal(health.status, 'degraded');
  assert.equal(health.consecutiveErrors, 2);
  health = updateComposioV13AppHealth(health, { ok: false, error: 'timeout' }, T0 + 4000);
  assert.equal(health.status, 'down');
  assert.equal(health.consecutiveErrors, 3);

  // Probe ok lại → healthy, lỗi reset.
  health = updateComposioV13AppHealth(health, { ok: true, latencyMs: 90 }, T0 + 5000);
  assert.equal(health.status, 'healthy');
  assert.equal(health.consecutiveErrors, 0);
  assert.equal(health.lastError, '');
});

test('app quota: fraction, 80% warning, exhausted, over-limit rejected, unlimited never warns', () => {
  const quota = { ...createComposioV13AppQuota('resend', 'month'), limitPerPeriod: 100, usedInPeriod: 10 };
  assert.equal(composioV13QuotaFraction(quota), 0.1);
  assert.deepEqual(composioV13QuotaWarning(quota).warned, false);

  const near = { ...quota, usedInPeriod: 85 };
  assert.equal(composioV13QuotaWarning(near).warned, true);
  assert.equal(composioV13QuotaWarning(near).exhausted, false);
  assert.match(composioV13QuotaWarning(near).detail, /85%/);

  const full = { ...quota, usedInPeriod: 100 };
  assert.equal(composioV13QuotaWarning(full).exhausted, true);

  const unlimited = createComposioV13AppQuota('gong');
  assert.equal(composioV13QuotaFraction(unlimited), null);
  assert.equal(composioV13QuotaWarning(unlimited).warned, false);

  const used = recordComposioV13QuotaUse(quota, 5);
  assert.equal(used.ok, true);
  assert.equal(used.quota.usedInPeriod, 15);
  const over = recordComposioV13QuotaUse(quota, 95);
  assert.equal(over.ok, false);
  assert.equal(over.quota.usedInPeriod, 10); // không đổi khi bị từ chối
  assert.match(over.error, /hết quota/);
  assert.equal(recordComposioV13QuotaUse(quota, 0).ok, false);
  assert.equal(recordComposioV13QuotaUse(quota, -1).ok, false);
});

test('apps summary: counts healthy/down/not-connected and quota warnings', () => {
  const healths = COMPOSIO_V13_TOOLKIT_SLUGS.map((slug) => {
    let h = createComposioV13AppHealth(slug);
    if (slug === 'resend') h = updateComposioV13AppHealth(h, { ok: true, latencyMs: 100 }, T0);
    if (slug === 'gong') {
      h = updateComposioV13AppHealth(h, { ok: false, error: 'x' }, T0);
      h = updateComposioV13AppHealth(h, { ok: false, error: 'x' }, T0);
      h = updateComposioV13AppHealth(h, { ok: false, error: 'x' }, T0);
    }
    return h;
  });
  const quotas = [
    { ...createComposioV13AppQuota('resend', 'month'), limitPerPeriod: 100, usedInPeriod: 90 },
    { ...createComposioV13AppQuota('docusign', 'month'), limitPerPeriod: 50, usedInPeriod: 50 },
    createComposioV13AppQuota('gong'),
  ];
  const summary = summarizeComposioV13Apps(healths, quotas);
  assert.equal(summary.appCount, 6);
  assert.equal(summary.toolCount, 54);
  assert.equal(summary.healthyCount, 1);
  assert.equal(summary.downCount, 1);
  assert.equal(summary.notConnectedCount, 4);
  assert.deepEqual(summary.quotaWarned, ['resend']);
  assert.deepEqual(summary.quotaExhausted, ['docusign']);
  assert.match(summary.summary, /6 app mới v13/);
});
