/**
 * Composio mock toolkits tests (v1.10, Đội T6 — node:test, no network,
 * NO live Composio calls, NO real keys).
 *
 * Covers:
 *  - 6 mock toolkits (figma/supabase/vercel/todoist/intercom/miro),
 *    10 candidate slugs each, all flagged mockOnly + liveVerified false
 *  - No slug collides with the 40 live-verified toolkits
 *    (COMPOSIO_TOOLKITS stays untouched at 40)
 *  - Mock executor: every slug returns a deterministic mock response
 *    (mock: true, live: false, sample data, stable mockId); same
 *    input → same mockId; args echoed back
 *  - Unknown slug / bad args throw (fail-closed); slugs outside the
 *    mock list are never executed by the mock
 *  - Approval follows the write-verb rule (write slugs need
 *    approval, read slugs do not)
 *  - App definitions: 4 mock apps, composio-<slug> ids, [MOCK]
 *    descriptions, approval flags match the verb rule
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v110-mock-toolkits.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_TOOLKITS,
  COMPOSIO_V110_MOCK_TOOLKITS,
  MockComposioV110Executor,
  createMockComposioV110AppDefinitions,
  executeMockComposioV110Tool,
  findMockComposioV110Toolkit,
  isMockComposioV110Slug,
  mockComposioV110AppId,
  mockComposioV110Slugs,
  mockComposioV110ToolNeedsApproval,
} from '../packages/core/dist/composio/index.js';

test('composio v110 mock: 6 toolkits, 10 candidate slugs each, all mock-only', () => {
  assert.equal(COMPOSIO_V110_MOCK_TOOLKITS.length, 6);
  assert.deepEqual(
    COMPOSIO_V110_MOCK_TOOLKITS.map((t) => t.slug),
    ['figma', 'supabase', 'vercel', 'todoist', 'intercom', 'miro'],
  );
  for (const toolkit of COMPOSIO_V110_MOCK_TOOLKITS) {
    assert.equal(toolkit.mockOnly, true);
    assert.equal(toolkit.liveVerified, false);
    assert.equal(toolkit.candidateToolSlugs.length, 10);
    assert.equal(new Set(toolkit.candidateToolSlugs).size, 10, `${toolkit.slug} has duplicate slugs`);
    assert.ok(toolkit.label.includes('mock'), `${toolkit.slug} label must say mock`);
    assert.ok(toolkit.description.startsWith('[MOCK]'), `${toolkit.slug} description must start with [MOCK]`);
    assert.ok(toolkit.description.includes('chưa có Composio API key') || toolkit.description.includes('Composio API key'), `${toolkit.slug} description must mention the missing key`);
  }
  const all = mockComposioV110Slugs();
  assert.equal(all.length, 60);
  assert.equal(new Set(all).size, 60, 'mock slugs must be unique across toolkits');
});

test('composio v110 mock: no slug collides with the 40 live-verified toolkits', () => {
  assert.equal(COMPOSIO_TOOLKITS.length, 40, 'live catalog untouched by the mock wave');
  const liveSlugs = new Set(COMPOSIO_TOOLKITS.flatMap((t) => [...t.verifiedToolSlugs]));
  assert.equal(liveSlugs.size, 400);
  for (const slug of mockComposioV110Slugs()) {
    assert.ok(!liveSlugs.has(slug), `mock slug ${slug} collides with a live-verified slug`);
    assert.ok(isMockComposioV110Slug(slug), `${slug} must be recognised as a mock slug`);
  }
  assert.equal(isMockComposioV110Slug('GMAIL_SEND_EMAIL'), false);
  assert.equal(isMockComposioV110Slug('NOT_A_SLUG'), false);
  assert.equal(findMockComposioV110Toolkit('figma').slug, 'figma');
  assert.equal(findMockComposioV110Toolkit('gmail'), undefined);
  assert.equal(mockComposioV110AppId('figma'), 'composio-figma');
});

test('composio v110 mock: executor returns deterministic mock data for every slug', () => {
  const executor = new MockComposioV110Executor();
  for (const slug of mockComposioV110Slugs()) {
    const first = executor.execute(slug, { probe: 'x' });
    assert.equal(first.mock, true);
    assert.equal(first.live, false);
    assert.equal(first.slug, slug);
    assert.ok(typeof first.toolkit === 'string' && first.toolkit.length > 0);
    assert.ok(first.note.includes('Mock response'), 'response must carry the mock note');
    assert.ok(first.note.includes('Composio API key'), 'response must say a real key is needed for live');
    assert.equal(typeof first.data.mockId, 'string');
    assert.ok(first.data.mockId.startsWith('mock-'));
    assert.equal(first.data.echo.probe, 'x');
    // Deterministic: same input → same mockId, same data.
    const second = executor.execute(slug, { probe: 'x' });
    assert.equal(second.data.mockId, first.data.mockId);
    assert.deepEqual(second.data, first.data);
    // Different input → different mockId.
    const third = executor.execute(slug, { probe: 'y' });
    assert.notEqual(third.data.mockId, first.data.mockId);
  }
  assert.equal(executor.calls, mockComposioV110Slugs().length * 3);
});

test('composio v110 mock: sample data looks like the tool it mocks', () => {
  assert.deepEqual(executeMockComposioV110Tool('FIGMA_GET_FILE', {}).data.name, 'Mock Design File');
  assert.deepEqual(
    executeMockComposioV110Tool('SUPABASE_QUERY_TABLE', { table: 'users' }).data.rows,
    [{ id: 1, name: 'Mock row' }],
  );
  assert.equal(
    executeMockComposioV110Tool('VERCEL_LIST_DEPLOYMENTS', {}).data.deployments[0].state,
    'READY',
  );
  assert.equal(
    executeMockComposioV110Tool('TODOIST_CREATE_TASK', { content: 'Buy milk' }).data.created,
    true,
  );
  // Args whose key is NOT in the sample are echoed back; sample keys
  // keep their sample value (content is a sample field here).
  assert.equal(
    executeMockComposioV110Tool('TODOIST_CREATE_TASK', { content: 'Buy milk', priority: 4 }).data.echo.priority,
    4,
  );
  assert.equal(
    executeMockComposioV110Tool('TODOIST_CREATE_TASK', { content: 'Buy milk' }).data.content,
    'Mock task created',
  );
  assert.equal(
    executeMockComposioV110Tool('INTERCOM_LIST_CONVERSATIONS', {}).data.conversations[0].state,
    'open',
  );
  assert.equal(
    executeMockComposioV110Tool('MIRO_CREATE_BOARD', { name: 'Sprint' }).data.created,
    true,
  );
});

test('composio v110 mock: unknown slug / bad args throw (fail-closed)', () => {
  const executor = new MockComposioV110Executor();
  assert.throws(() => executor.execute('GMAIL_SEND_EMAIL', {}), /không thuộc toolkit mock v110/);
  assert.throws(() => executor.execute('FIGMA_GET_FIL', {}), /không thuộc toolkit mock v110/);
  assert.throws(() => executor.execute('', {}), /slug không rỗng/);
  assert.throws(() => executor.execute('FIGMA_GET_FILE', null), /phải là object/);
  assert.throws(() => executor.execute('FIGMA_GET_FILE', []), /phải là object/);
});

test('composio v110 mock: approval follows the write-verb rule', () => {
  // Write slugs need approval, read slugs do not — same rule as live tools.
  assert.equal(mockComposioV110ToolNeedsApproval('FIGMA_CREATE_COMMENT'), true);
  assert.equal(mockComposioV110ToolNeedsApproval('SUPABASE_INSERT_ROW'), true);
  assert.equal(mockComposioV110ToolNeedsApproval('SUPABASE_DELETE_ROW'), true);
  assert.equal(mockComposioV110ToolNeedsApproval('VERCEL_CREATE_DEPLOYMENT'), true);
  // NOTE (real gap, coordinator decision): 'COMPLETE' is NOT in the
  // shared COMPOSIO_WRITE_VERBS set, so completing a task currently
  // needs NO approval — same rule as live tools. If the coordinator
  // adds COMPLETE to the shared set, this assertion must flip to true.
  assert.equal(mockComposioV110ToolNeedsApproval('TODOIST_COMPLETE_TASK'), false);
  assert.equal(mockComposioV110ToolNeedsApproval('FIGMA_GET_FILE'), false);
  assert.equal(mockComposioV110ToolNeedsApproval('SUPABASE_QUERY_TABLE'), false);
  assert.equal(mockComposioV110ToolNeedsApproval('VERCEL_LIST_DEPLOYMENTS'), false);
  assert.equal(mockComposioV110ToolNeedsApproval('TODOIST_LIST_TASKS'), false);
});

test('composio v110 mock: app definitions for the UI (6 mock apps)', () => {
  const apps = createMockComposioV110AppDefinitions();
  assert.equal(apps.length, 6);
  assert.deepEqual(
    apps.map((a) => a.id),
    [
      'composio-figma',
      'composio-supabase',
      'composio-vercel',
      'composio-todoist',
      'composio-intercom',
      'composio-miro',
    ],
  );
  for (const app of apps) {
    assert.equal(app.source, 'composio');
    assert.equal(app.authType, 'composio');
    assert.ok(app.description.startsWith('[MOCK]'));
    assert.equal(app.tools.length, 10);
    for (const tool of app.tools) {
      assert.equal(tool.needsApproval, mockComposioV110ToolNeedsApproval(tool.name));
      assert.ok(tool.description.includes('[MOCK]'));
    }
  }
});
