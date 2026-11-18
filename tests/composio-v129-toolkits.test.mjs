/**
 * Composio v129 tests — mock toolkits (v1.29, Doi T4 — node:test,
 * no network, no key, mock-only).
 *
 * Covers packages/core/src/composio/toolkitsV129.ts:
 * - 4 toolkits (smartsheet/servicenow/klaviyo/onedrive), 10
 *   candidate slugs each, none overlapping the 40 live toolkits or
 *   any earlier mock set (v110/v111/v112/v114/v118/v119/v120);
 *   every toolkit is mockOnly + not live-verified and carries
 *   authKind + authNote
 * - Param-names table covers every candidate slug; validator
 *   flags unknown params and passes known ones
 * - Mock executor deterministic (same call -> same result,
 *   deterministic requestId), echo args, mock:true/live:false;
 *   unknown toolkit/slug throws; app definitions + catalogue
 *   summary (write/read split)
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v129-toolkits.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { COMPOSIO_TOOLKIT_SLUGS } from '../packages/core/dist/composio/toolkits.js';
import {
  COMPOSIO_V110_MOCK_TOOLKITS,
  mockComposioV110Slugs,
} from '../packages/core/dist/composio/toolkitsV110.js';
import { COMPOSIO_V111_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV111.js';
import { COMPOSIO_V112_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV112.js';
import { COMPOSIO_V114_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV114.js';
import { COMPOSIO_V118_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV118.js';
import { COMPOSIO_V119_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV119.js';
import { COMPOSIO_V120_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV120.js';
import {
  COMPOSIO_V129_MOCK_TOOLKITS,
  MockComposioV129Executor,
  createMockComposioV129AppDefinitions,
  executeMockComposioV129Tool,
  findMockComposioV129Toolkit,
  isMockComposioV129Slug,
  mockComposioV129AppId,
  mockComposioV129DeterministicId,
  mockComposioV129ParamNames,
  mockComposioV129Slugs,
  mockComposioV129ToolNeedsApproval,
  resolveMockComposioV129Slug,
  summarizeMockComposioV129Catalogue,
  validateMockComposioV129Params,
} from '../packages/core/dist/composio/toolkitsV129.js';

test('mock toolkits v129: 4 toolkits x 10 slugs, mock-only, auth info', () => {
  assert.equal(COMPOSIO_V129_MOCK_TOOLKITS.length, 4);
  assert.deepEqual(
    COMPOSIO_V129_MOCK_TOOLKITS.map((t) => t.slug),
    ['smartsheet', 'servicenow', 'klaviyo', 'onedrive'],
  );
  for (const toolkit of COMPOSIO_V129_MOCK_TOOLKITS) {
    assert.equal(toolkit.candidateToolSlugs.length, 10, `${toolkit.slug} must have 10 slugs`);
    assert.equal(new Set(toolkit.candidateToolSlugs).size, 10, `${toolkit.slug} slugs must be unique`);
    assert.equal(toolkit.mockOnly, true);
    assert.equal(toolkit.liveVerified, false);
    assert.ok(['oauth2', 'api-key', 'oauth2-or-api-key'].includes(toolkit.authKind));
    assert.ok(toolkit.authNote.trim().length > 0, `${toolkit.slug} needs an authNote`);
    assert.ok(toolkit.label.includes('mock'), `${toolkit.slug} label must say mock`);
    assert.ok(toolkit.description.startsWith('[MOCK]'), `${toolkit.slug} description must start with [MOCK]`);
    for (const slug of toolkit.candidateToolSlugs) {
      assert.match(slug, /^[A-Z0-9_]+$/, `${slug} must be UPPER_SNAKE`);
      assert.ok(slug.startsWith(`${toolkit.slug.toUpperCase().replace('-', '_')}_`), `${slug} must start with the toolkit prefix`);
    }
  }
  assert.equal(mockComposioV129Slugs().length, 40);
  assert.equal(new Set(mockComposioV129Slugs()).size, 40);
});

test('mock toolkits v129: no overlap with live catalog or earlier mocks', () => {
  const live = new Set(COMPOSIO_TOOLKIT_SLUGS);
  assert.equal(live.size, 40, 'live catalog is still 40 toolkits');
  for (const toolkit of COMPOSIO_V129_MOCK_TOOLKITS) {
    assert.ok(!live.has(toolkit.slug), `${toolkit.slug} must not be a live toolkit`);
  }
  const earlier = new Set([
    ...mockComposioV110Slugs(),
    ...COMPOSIO_V111_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V112_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V114_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V118_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V119_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
    ...COMPOSIO_V120_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs),
  ]);
  const earlierToolkits = new Set([
    ...COMPOSIO_V110_MOCK_TOOLKITS.map((t) => t.slug),
    ...COMPOSIO_V111_MOCK_TOOLKITS.map((t) => t.slug),
    ...COMPOSIO_V112_MOCK_TOOLKITS.map((t) => t.slug),
    ...COMPOSIO_V114_MOCK_TOOLKITS.map((t) => t.slug),
    ...COMPOSIO_V118_MOCK_TOOLKITS.map((t) => t.slug),
    ...COMPOSIO_V119_MOCK_TOOLKITS.map((t) => t.slug),
    ...COMPOSIO_V120_MOCK_TOOLKITS.map((t) => t.slug),
  ]);
  for (const toolkit of COMPOSIO_V129_MOCK_TOOLKITS) {
    assert.ok(!earlierToolkits.has(toolkit.slug), `${toolkit.slug} must not repeat an earlier mock toolkit`);
    for (const slug of toolkit.candidateToolSlugs) {
      assert.ok(!earlier.has(slug), `${slug} must not repeat an earlier mock slug`);
    }
  }
});

test('mock toolkits v129: lookup helpers + app id + approval rule', () => {
  assert.equal(findMockComposioV129Toolkit('klaviyo').label, 'Klaviyo (mock — via Composio)');
  assert.equal(findMockComposioV129Toolkit('nope'), undefined);
  assert.equal(isMockComposioV129Slug('ONEDRIVE_LIST_FILES'), true);
  assert.equal(isMockComposioV129Slug('GMAIL_LIST_MESSAGES'), false);
  assert.equal(mockComposioV129AppId('smartsheet'), 'composio-smartsheet');
  assert.equal(mockComposioV129DeterministicId('a'), mockComposioV129DeterministicId('a'));
  assert.notEqual(mockComposioV129DeterministicId('a'), mockComposioV129DeterministicId('b'));
  // Write verbs need approval; read verbs do not (same rule as live tools).
  assert.equal(mockComposioV129ToolNeedsApproval('SMARTSHEET_CREATE_ROW'), true);
  assert.equal(mockComposioV129ToolNeedsApproval('SMARTSHEET_LIST_ROWS'), false);
  assert.equal(mockComposioV129ToolNeedsApproval('KLAVIYO_SEND_CAMPAIGN'), true);
  assert.equal(mockComposioV129ToolNeedsApproval('ONEDRIVE_SEARCH_FILES'), false);
  assert.equal(resolveMockComposioV129Slug('servicenow', 'SERVICENOW_GET_INCIDENT').slug, 'servicenow');
  assert.throws(() => resolveMockComposioV129Slug('nope', 'X'), /Unknown mock.*toolkit/);
  assert.throws(() => resolveMockComposioV129Slug('klaviyo', 'KLAVIYO_NOPE'), /Unknown mock.*tool slug/);
});

test('mock toolkits v129: param names cover every slug; validator flags unknowns', () => {
  for (const slug of mockComposioV129Slugs()) {
    const names = mockComposioV129ParamNames(slug);
    assert.ok(Array.isArray(names), `${slug} must have a param-names entry`);
    assert.ok(names.length >= 0);
  }
  assert.equal(mockComposioV129ParamNames('NOT_A_SLUG'), undefined);
  assert.deepEqual(validateMockComposioV129Params('SMARTSHEET_GET_SHEET', { sheetId: 's1' }), []);
  assert.deepEqual(validateMockComposioV129Params('SMARTSHEET_GET_SHEET', { sheetId: 's1', bogus: 1 }), ['bogus']);
  assert.deepEqual(validateMockComposioV129Params('NOT_A_SLUG', { anything: 1 }), []);
  assert.deepEqual(mockComposioV129ParamNames('ONEDRIVE_SEARCH_FILES'), ['query', 'limit']);
});

test('mock toolkits v129: executor deterministic, echo, mock flags', () => {
  const first = executeMockComposioV129Tool('smartsheet', 'SMARTSHEET_LIST_SHEETS', { limit: 5 });
  const second = executeMockComposioV129Tool('smartsheet', 'SMARTSHEET_LIST_SHEETS', { limit: 5 });
  assert.deepEqual(first, second);
  assert.equal(first.mock, true);
  assert.equal(first.live, false);
  assert.equal(first.toolkit, 'smartsheet');
  assert.equal(first.slug, 'SMARTSHEET_LIST_SHEETS');
  assert.equal(first.data.echo.limit, 5);
  assert.match(first.note, /Mock response/);
  assert.ok(first.data.requestId.startsWith('mock-v129-'));
  assert.throws(() => executeMockComposioV129Tool('nope', 'X'), /Unknown mock/);
  assert.throws(() => executeMockComposioV129Tool('klaviyo', 'KLAVIYO_NOPE'), /Unknown mock/);
  const executor = new MockComposioV129Executor();
  assert.equal(executor.listToolkits().length, 4);
  assert.equal(executor.listSlugs('onedrive').length, 10);
  assert.deepEqual(executor.paramNames('SERVICENOW_ADD_COMMENT'), ['incidentId', 'comment']);
  assert.deepEqual(executor.unknownParams('SERVICENOW_ADD_COMMENT', { incidentId: 'i1' }), []);
  assert.deepEqual(executor.unknownParams('SERVICENOW_ADD_COMMENT', { nope: 1 }), ['nope']);
  assert.throws(() => executor.listSlugs('nope'), /Unknown mock/);
  const viaClass = executor.execute('klaviyo', 'KLAVIYO_LIST_LISTS', {});
  assert.equal(viaClass.mock, true);
  assert.ok(Array.isArray(viaClass.data.lists));
});

test('mock toolkits v129: app definitions + catalogue summary', () => {
  const apps = createMockComposioV129AppDefinitions();
  assert.equal(apps.length, 4);
  for (const app of apps) {
    assert.equal(app.source, 'composio');
    assert.equal(app.authType, 'composio');
    assert.equal(app.tools.length, 10);
    assert.ok(app.description.startsWith('[MOCK]'));
    for (const tool of app.tools) {
      assert.equal(typeof tool.needsApproval, 'boolean');
    }
  }
  const summary = summarizeMockComposioV129Catalogue();
  assert.equal(summary.totalToolkits, 4);
  assert.equal(summary.totalSlugs, 40);
  assert.equal(summary.writeSlugs + summary.readSlugs, 40);
  assert.ok(summary.writeSlugs > 0 && summary.readSlugs > 0);
  assert.equal(summary.byToolkit.length, 4);
  for (const entry of summary.byToolkit) {
    assert.equal(entry.total, 10);
    assert.equal(entry.write + entry.read, 10);
  }
});
