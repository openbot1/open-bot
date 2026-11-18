/**
 * Composio v119 tests — mock toolkits (v1.19, Doi T4 — node:test,
 * no network, no key).
 *
 * Covers toolkitsV119.ts:
 * - 3 mock toolkits (wrike/bamboohr/ringcentral), 10 candidate slugs
 *   each (30 total), none overlapping the 40 live toolkits or the
 *   v110/v111/v112/v114/v118 mock toolkits; every toolkit is
 *   mockOnly + not live-verified and carries authKind + authNote
 * - Lookup helpers (find/isMock/slugs/appId), app definitions,
 *   catalogue summary (write/read split)
 * - Mock executor: deterministic samples + args echo, mock:true /
 *   live:false, deterministic requestId, throws on unknown
 *   toolkit/slug
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v119-toolkits.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_V119_MOCK_TOOLKITS,
  MockComposioV119Executor,
  createMockComposioV119AppDefinitions,
  executeMockComposioV119Tool,
  findMockComposioV119Toolkit,
  isMockComposioV119Slug,
  mockComposioV119AppId,
  mockComposioV119DeterministicId,
  mockComposioV119Slugs,
  mockComposioV119ToolNeedsApproval,
  resolveMockComposioV119Slug,
  summarizeMockComposioV119Catalogue,
} from '../packages/core/dist/composio/toolkitsV119.js';
import { COMPOSIO_TOOLKIT_SLUGS } from '../packages/core/dist/composio/toolkits.js';
import { COMPOSIO_V110_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV110.js';
import { COMPOSIO_V111_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV111.js';
import { COMPOSIO_V112_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV112.js';
import { COMPOSIO_V114_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV114.js';
import { COMPOSIO_V118_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV118.js';

test('v119 mock toolkits: 3 toolkits, 10 candidate slugs each, 30 total', () => {
  assert.equal(COMPOSIO_V119_MOCK_TOOLKITS.length, 3);
  assert.deepEqual(
    COMPOSIO_V119_MOCK_TOOLKITS.map((t) => t.slug),
    ['wrike', 'bamboohr', 'ringcentral'],
  );
  for (const t of COMPOSIO_V119_MOCK_TOOLKITS) {
    assert.equal(t.candidateToolSlugs.length, 10);
    assert.equal(new Set(t.candidateToolSlugs).size, 10, `${t.slug}: slugs must be unique`);
    assert.equal(t.mockOnly, true);
    assert.equal(t.liveVerified, false);
    assert.ok(t.label.length > 0);
    assert.ok(t.icon.length > 0);
    assert.ok(t.description.includes('[MOCK]'), `${t.slug}: description must say [MOCK]`);
    assert.ok(['oauth2', 'api-key', 'oauth2-or-api-key'].includes(t.authKind));
    assert.ok(t.authNote.length > 20, `${t.slug}: authNote must guide the user`);
    for (const slug of t.candidateToolSlugs) {
      assert.match(slug, /^[A-Z0-9_]+$/, `${slug}: slug shape`);
      assert.ok(slug.startsWith(`${t.slug.toUpperCase()}_`), `${slug}: must be prefixed with the toolkit`);
    }
  }
  assert.equal(mockComposioV119Slugs().length, 30);
  assert.equal(new Set(mockComposioV119Slugs()).size, 30, 'slugs must be unique across toolkits');
});

test('v119 mock toolkits: no overlap with live or older mock toolkits', () => {
  const liveToolkits = new Set(COMPOSIO_TOOLKIT_SLUGS);
  assert.equal(liveToolkits.size, 40, 'live catalog is still 40 toolkits');
  for (const t of COMPOSIO_V119_MOCK_TOOLKITS) {
    assert.ok(!liveToolkits.has(t.slug), `${t.slug} must not be a live toolkit`);
  }
  const olderMockSlugs = new Set([
    ...COMPOSIO_V110_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V111_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V112_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V114_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V118_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
  ]);
  for (const slug of mockComposioV119Slugs()) {
    assert.ok(!olderMockSlugs.has(slug), `${slug} must not repeat an older mock slug`);
  }
});

test('v119 mock toolkits: lookup helpers', () => {
  assert.equal(findMockComposioV119Toolkit('wrike')?.label, 'Wrike (mock — via Composio)');
  assert.equal(findMockComposioV119Toolkit('bamboohr')?.authKind, 'api-key');
  assert.equal(findMockComposioV119Toolkit('ringcentral')?.authKind, 'oauth2-or-api-key');
  assert.equal(findMockComposioV119Toolkit('gmail'), undefined);
  assert.equal(findMockComposioV119Toolkit(''), undefined);
  assert.equal(isMockComposioV119Slug('WRIKE_LIST_TASKS'), true);
  assert.equal(isMockComposioV119Slug('BAMBOOHR_LIST_EMPLOYEES'), true);
  assert.equal(isMockComposioV119Slug('RINGCENTRAL_SEND_SMS'), true);
  assert.equal(isMockComposioV119Slug('GMAIL_SEND_MESSAGE'), false);
  assert.equal(isMockComposioV119Slug('WRIKE_NOPE'), false);
  assert.equal(mockComposioV119AppId('wrike'), 'composio-wrike');
  assert.equal(mockComposioV119AppId('ringcentral'), 'composio-ringcentral');
  // Approval rule matches the live Composio rule (write verbs need approval).
  assert.equal(mockComposioV119ToolNeedsApproval('WRIKE_CREATE_TASK'), true);
  assert.equal(mockComposioV119ToolNeedsApproval('WRIKE_LIST_TASKS'), false);
  assert.equal(mockComposioV119ToolNeedsApproval('RINGCENTRAL_SEND_SMS'), true);
  assert.equal(mockComposioV119ToolNeedsApproval('BAMBOOHR_GET_EMPLOYEE'), false);
});

test('v119 mock toolkits: app definitions', () => {
  const defs = createMockComposioV119AppDefinitions();
  assert.equal(defs.length, 3);
  for (const def of defs) {
    assert.ok(def.id.startsWith('composio-'));
    assert.equal(def.authType, 'composio');
    assert.equal(def.source, 'composio');
    assert.equal(def.tools.length, 10);
    assert.ok(def.description.includes('[MOCK]'));
    for (const tool of def.tools) {
      assert.ok(tool.description.includes('[MOCK]'));
      assert.equal(typeof tool.needsApproval, 'boolean');
    }
  }
  assert.deepEqual(
    defs.map((d) => d.toolkit),
    ['wrike', 'bamboohr', 'ringcentral'],
  );
});

test('v119 mock toolkits: catalogue summary', () => {
  const s = summarizeMockComposioV119Catalogue();
  assert.equal(s.totalToolkits, 3);
  assert.equal(s.totalSlugs, 30);
  assert.equal(s.writeSlugs + s.readSlugs, 30);
  assert.ok(s.writeSlugs > 0, 'some slugs are writes');
  assert.ok(s.readSlugs > 0, 'some slugs are reads');
  assert.equal(s.byToolkit.length, 3);
  for (const b of s.byToolkit) {
    assert.equal(b.total, 10);
    assert.equal(b.write + b.read, 10);
  }
  // Wrike: CREATE/UPDATE/DELETE task + CREATE project = 4 writes.
  assert.equal(s.byToolkit.find((b) => b.slug === 'wrike')?.write, 4);
  // BambooHR: CREATE/UPDATE employee + CREATE time-off = 3 writes.
  assert.equal(s.byToolkit.find((b) => b.slug === 'bamboohr')?.write, 3);
  // RingCentral: only SEND_SMS = 1 write per the shared verb rule
  // (MAKE is not in COMPOSIO_WRITE_VERBS, so MAKE_CALL counts as
  // read — shared-rule limitation, same for all Composio tools).
  assert.equal(s.byToolkit.find((b) => b.slug === 'ringcentral')?.write, 1);
});

test('v119 mock toolkits: deterministic id is stable and seed-scoped', () => {
  const a = mockComposioV119DeterministicId('wrike:WRIKE_LIST_TASKS');
  const b = mockComposioV119DeterministicId('wrike:WRIKE_LIST_TASKS');
  const c = mockComposioV119DeterministicId('bamboohr:BAMBOOHR_LIST_EMPLOYEES');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith('mock-v119-'));
});

test('v119 mock toolkits: executor returns deterministic samples + echo', () => {
  const r = executeMockComposioV119Tool('wrike', 'WRIKE_LIST_TASKS', { limit: 5 });
  assert.equal(r.mock, true);
  assert.equal(r.live, false);
  assert.equal(r.toolkit, 'wrike');
  assert.equal(r.slug, 'WRIKE_LIST_TASKS');
  assert.equal(r.data.total, 1);
  assert.deepEqual(r.data.echo, { limit: 5 });
  assert.equal(typeof r.data.requestId, 'string');
  assert.ok(String(r.data.requestId).startsWith('mock-v119-'));
  assert.ok(r.note.includes('Mock response'));
  // Same call twice → same data (deterministic, no clock/random).
  const r2 = executeMockComposioV119Tool('wrike', 'WRIKE_LIST_TASKS', { limit: 5 });
  assert.deepEqual(r2, r);
  // Every slug has a sample.
  for (const slug of mockComposioV119Slugs()) {
    const toolkit = COMPOSIO_V119_MOCK_TOOLKITS.find((t) => t.candidateToolSlugs.includes(slug)).slug;
    const res = executeMockComposioV119Tool(toolkit, slug);
    assert.equal(res.mock, true);
    assert.equal(res.live, false);
    assert.equal(res.data.requestId, mockComposioV119DeterministicId(`${toolkit}:${slug}`));
  }
});

test('v119 mock toolkits: executor class + resolve errors', () => {
  const ex = new MockComposioV119Executor();
  assert.equal(ex.listToolkits().length, 3);
  assert.equal(ex.listSlugs('bamboohr').length, 10);
  assert.equal(ex.execute('ringcentral', 'RINGCENTRAL_SEND_SMS', { to: '+1' }).data.sent, true);
  assert.throws(() => ex.execute('gmail', 'GMAIL_SEND_MESSAGE'), /Unknown mock Composio v119 toolkit/);
  assert.throws(() => ex.execute('wrike', 'WRIKE_NOPE'), /Unknown mock Composio v119 tool slug/);
  assert.throws(() => ex.listSlugs('gmail'), /Unknown mock Composio v119 toolkit/);
  assert.throws(() => resolveMockComposioV119Slug('wrike', 'WRIKE_NOPE'), /Unknown mock Composio v119 tool slug/);
  assert.equal(resolveMockComposioV119Slug('wrike', 'WRIKE_GET_TASK').slug, 'wrike');
});
