/**
 * Composio v112 tests (v1.12, Doi T6 — node:test, no network, no key).
 *
 * Covers:
 * - Mock toolkits v112: 6 toolkits (grafana/elasticsearch/bigquery/
 *   clickhouse/launchdarkly/greenhouse), 10 candidate slugs each, none
 *   overlapping the 40 live toolkits, the 6 mock v110 toolkits or the
 *   6 mock v111 toolkits; every toolkit is mockOnly + not live-verified;
 *   AppDefinitions carry the [MOCK] description
 * - Mock executor: deterministic sample data per slug, echo of args,
 *   mock:true/live:false; unknown toolkit/slug throws
 * - Catalogue summary: per-toolkit counts + write-tool lists
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v112.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_V112_MOCK_TOOLKITS,
  MockComposioV112Executor,
  createMockComposioV112AppDefinitions,
  executeMockComposioV112Tool,
  findMockComposioV112Toolkit,
  isMockComposioV112Slug,
  mockComposioV112AppId,
  mockComposioV112DeterministicId,
  mockComposioV112Slugs,
  summarizeMockComposioV112Catalogue,
} from '../packages/core/dist/composio/toolkitsV112.js';
import { COMPOSIO_TOOLKIT_SLUGS } from '../packages/core/dist/composio/toolkits.js';
import { COMPOSIO_V110_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV110.js';
import { COMPOSIO_V111_MOCK_TOOLKITS } from '../packages/core/dist/composio/toolkitsV111.js';

const EXPECTED_SLUGS = ['grafana', 'elasticsearch', 'bigquery', 'clickhouse', 'launchdarkly', 'greenhouse'];

test('composio v112: 6 mock toolkits, 10 candidate slugs each, no overlap', () => {
  assert.deepEqual(COMPOSIO_V112_MOCK_TOOLKITS.map((t) => t.slug), EXPECTED_SLUGS);
  const allSlugs = mockComposioV112Slugs();
  assert.equal(allSlugs.length, 60);
  assert.equal(new Set(allSlugs).size, 60);
  for (const toolkit of COMPOSIO_V112_MOCK_TOOLKITS) {
    assert.equal(toolkit.candidateToolSlugs.length, 10);
    assert.equal(toolkit.mockOnly, true);
    assert.equal(toolkit.liveVerified, false);
    assert.match(toolkit.description, /\[MOCK\]/);
    assert.match(toolkit.label, /mock — via Composio/);
    // No overlap with live / v110 / v111 toolkits.
    assert.ok(!COMPOSIO_TOOLKIT_SLUGS.includes(toolkit.slug), `${toolkit.slug} overlaps live`);
    assert.ok(!COMPOSIO_V110_MOCK_TOOLKITS.some((t) => t.slug === toolkit.slug), `${toolkit.slug} overlaps v110`);
    assert.ok(!COMPOSIO_V111_MOCK_TOOLKITS.some((t) => t.slug === toolkit.slug), `${toolkit.slug} overlaps v111`);
    // Slugs are namespaced per toolkit and follow PREFIX_VERB_NOUN.
    const prefix = toolkit.slug.toUpperCase();
    for (const slug of toolkit.candidateToolSlugs) {
      assert.ok(slug.startsWith(`${prefix}_`), `${slug} should start with ${prefix}_`);
      assert.match(slug, /^[A-Z][A-Z0-9_]+$/);
    }
  }
  // No slug overlap with the other mock waves either.
  const v110Slugs = new Set(COMPOSIO_V110_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs));
  const v111Slugs = new Set(COMPOSIO_V111_MOCK_TOOLKITS.flatMap((t) => t.candidateToolSlugs));
  for (const slug of allSlugs) {
    assert.ok(!v110Slugs.has(slug), `${slug} overlaps v110 slugs`);
    assert.ok(!v111Slugs.has(slug), `${slug} overlaps v111 slugs`);
  }
});

test('composio v112: lookup helpers + deterministic ids', () => {
  assert.equal(findMockComposioV112Toolkit('grafana')?.label, 'Grafana (mock — via Composio)');
  assert.equal(findMockComposioV112Toolkit('nope'), undefined);
  assert.ok(isMockComposioV112Slug('GRAFANA_LIST_DASHBOARDS'));
  assert.ok(isMockComposioV112Slug('GREENHOUSE_LIST_JOBS'));
  assert.ok(!isMockComposioV112Slug('GMAIL_LIST_MESSAGES'));
  assert.ok(!isMockComposioV112Slug('SENTRY_LIST_ISSUES'));
  assert.equal(mockComposioV112AppId('grafana'), 'composio-grafana');
  assert.equal(
    mockComposioV112DeterministicId('seed-1'),
    mockComposioV112DeterministicId('seed-1'),
  );
  assert.notEqual(
    mockComposioV112DeterministicId('seed-1'),
    mockComposioV112DeterministicId('seed-2'),
  );
  assert.match(mockComposioV112DeterministicId('x'), /^mock-v112-/);
});

test('composio v112: mock executor returns deterministic sample data', () => {
  const executor = new MockComposioV112Executor();
  for (const toolkit of COMPOSIO_V112_MOCK_TOOLKITS) {
    for (const slug of toolkit.candidateToolSlugs) {
      const result = executor.execute(toolkit.slug, slug, { q: 'test' });
      assert.equal(result.mock, true);
      assert.equal(result.live, false);
      assert.equal(result.toolkit, toolkit.slug);
      assert.equal(result.slug, slug);
      assert.deepEqual(result.data.echo, { q: 'test' });
      assert.match(result.note, /Mock response/);
      // Same call twice -> same data (deterministic).
      assert.deepEqual(executor.execute(toolkit.slug, slug, { q: 'test' }), result);
    }
  }
  assert.throws(() => executor.execute('nope', 'GRAFANA_LIST_DASHBOARDS'), /Unknown mock toolkit/);
  assert.throws(() => executor.execute('grafana', 'GMAIL_LIST_MESSAGES'), /not a candidate tool/);
  assert.throws(() => executeMockComposioV112Tool('grafana', 'NOPE'), /not a candidate tool/);
  const viaHelper = executeMockComposioV112Tool('bigquery', 'BIGQUERY_RUN_QUERY', { sql: 'SELECT 1' });
  assert.equal(viaHelper.data.totalRows, 1);
});

test('composio v112: app definitions carry [MOCK] + approval flags', () => {
  const apps = createMockComposioV112AppDefinitions();
  assert.equal(apps.length, 6);
  for (const app of apps) {
    assert.match(app.description, /\[MOCK\]/);
    assert.equal(app.authType, 'composio');
    assert.equal(app.source, 'composio');
    assert.equal(app.tools.length, 10);
    for (const tool of app.tools) {
      assert.match(tool.description, /\[MOCK\]/);
      assert.equal(typeof tool.needsApproval, 'boolean');
    }
  }
  // Write tools need approval, read tools do not (same rule as live).
  const grafana = apps.find((a) => a.toolkit === 'grafana');
  assert.equal(grafana.tools.find((t) => t.name === 'GRAFANA_LIST_DASHBOARDS').needsApproval, false);
  assert.equal(grafana.tools.find((t) => t.name === 'GRAFANA_CREATE_DASHBOARD').needsApproval, true);
});

test('composio v112: catalogue summary counts', () => {
  const summary = summarizeMockComposioV112Catalogue();
  assert.equal(summary.length, 6);
  for (const row of summary) {
    assert.equal(row.toolCount, 10);
    assert.ok(Array.isArray(row.writeTools));
    assert.ok(row.writeTools.length > 0, `${row.toolkit} should have write tools`);
    assert.ok(row.writeTools.every((slug) => isMockComposioV112Slug(slug)));
  }
});
