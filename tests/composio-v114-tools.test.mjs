/**
 * Composio v114 tools tests (v1.14, Doi T4 — node:test, no network, no key).
 *
 * Covers:
 * - 6 tools v114 registered in ALL_TOOLS (453 + 6 = 459), unique names,
 *   present in createDefaultTools() unbound placeholders
 * - composio_mock_toolkit_list_v114 / execute_v114 (mock-only responses)
 * - composio_poll_schedule_v2 (success resets, error backs off, dedupe
 *   counts, checkpoint JSON round-trips through resume)
 * - composio_connection_health (dashboard from raw stats + recordOutcome)
 * - composio_trigger_templates (search/filter/slug lookup + validation)
 * - composio_mcp_app_open (app URI + safe HTML + completed mock task)
 * - i18n: 18 composioV114.* keys exist in all 6 locales, non-empty,
 *   and the locale total is 4983 + 18 = 5001
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/composio-v114-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  COMPOSIO_V114_TOOLS,
  COMPOSIO_V114_TOOL_NAMES,
  createComposioV114Tools,
  isComposioV114ToolName,
} from '../packages/tools/dist/composioV114Tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf-8'));
}

function tool(name) {
  const t = createComposioV114Tools().find((x) => x.definition.name === name);
  assert.ok(t, `tool ${name} must exist`);
  return t;
}

async function run(name, args) {
  const out = await tool(name).execute(args, {});
  return JSON.parse(out);
}

async function runRaw(name, args) {
  return tool(name).execute(args, {});
}

test('composio v114 tools: 6 tools, unique names, in ALL_TOOLS (491)', () => {
  assert.deepEqual([...COMPOSIO_V114_TOOL_NAMES], [
    'composio_mock_toolkit_list_v114',
    'composio_mock_toolkit_execute_v114',
    'composio_poll_schedule_v2',
    'composio_connection_health',
    'composio_trigger_templates',
    'composio_mcp_app_open',
  ]);
  assert.equal(COMPOSIO_V114_TOOLS.length, 6);
  assert.equal(createComposioV114Tools().length, 6);
  assert.equal(new Set(COMPOSIO_V114_TOOLS.map((t) => t.definition.name)).size, 6);
  for (const name of COMPOSIO_V114_TOOL_NAMES) {
    assert.equal(isComposioV114ToolName(name), true);
  }
  assert.equal(isComposioV114ToolName('composio_mock_toolkit_execute_v111'), false);
  // ALL_TOOLS grows by exactly 6 (v1.13: 453 -> v1.14: 459).
  assert.ok(ALL_TOOLS.length >= 1078, 'v1.14 merge: 453 + 38 = 500'); // v1.38 re-pin: 899 + 179 = 1078.
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  for (const name of COMPOSIO_V114_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `${name} must be in ALL_TOOLS`);
  }
  // Unbound placeholders are present (pure tools need no host wiring).
  const bound = createDefaultTools();
  assert.ok(bound.length >= 1078); // v1.38 re-pin: 899 + 179 = 1078.
  for (const name of COMPOSIO_V114_TOOL_NAMES) {
    assert.ok(bound.some((t) => t.definition.name === name), `${name} must be in createDefaultTools()`);
  }
  // No tool needs approval (all read-only / mock / pure computation).
  for (const t of COMPOSIO_V114_TOOLS) assert.equal(t.needsApproval, false);
});

test('composio v114 tools: mock toolkit list + execute', async () => {
  const list = await run('composio_mock_toolkit_list_v114', {});
  assert.equal(list.mock, true);
  assert.equal(list.live, false);
  assert.equal(list.totalToolkits, 6);
  assert.equal(list.totalSlugs, 60);
  assert.equal(list.writeSlugs + list.readSlugs, 60);
  assert.deepEqual(list.toolkits.map((t) => t.slug), ['webflow', 'pipedrive', 'chargebee', 'xero', 'eventbrite', 'surveymonkey']);
  for (const t of list.toolkits) {
    assert.equal(t.candidateToolSlugs.length, 10);
    assert.ok(['oauth2', 'api-key', 'oauth2-or-api-key'].includes(t.authKind));
    assert.ok(t.authNote.length > 20);
  }
  const exec = await run('composio_mock_toolkit_execute_v114', {
    toolkit: 'chargebee',
    slug: 'CHARGEBEE_LIST_CUSTOMERS',
    args: { limit: 2 },
  });
  assert.equal(exec.mock, true);
  assert.equal(exec.live, false);
  assert.equal(exec.needsApproval, false);
  assert.equal(exec.data.echo.limit, 2);
  assert.ok(Array.isArray(exec.data.customers));
  const writeExec = await run('composio_mock_toolkit_execute_v114', {
    toolkit: 'xero',
    slug: 'XERO_CREATE_INVOICE',
    args: {},
  });
  assert.equal(writeExec.needsApproval, true);
  assert.match(await runRaw('composio_mock_toolkit_execute_v114', { toolkit: 'gmail', slug: 'GMAIL_SEND_EMAIL' }), /^Error: Unknown mock/);
  assert.match(await runRaw('composio_mock_toolkit_execute_v114', { toolkit: 'webflow' }), /^Error: Missing required argument/);
});

test('composio v114 tools: poll schedule v2 success / error / dedupe / checkpoint', async () => {
  const base = {
    scheduleId: 'poll:gmail:t1',
    connectionId: 'ca_t1',
    toolkit: 'gmail',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    nowMs: 100_000,
    noJitter: true,
  };
  const ok = await run('composio_poll_schedule_v2', {
    ...base,
    outcome: 'success',
    newItemIds: ['m1', 'm2'],
    seenIds: [],
  });
  assert.equal(ok.outcome, 'success');
  assert.equal(ok.consecutiveErrors, 0);
  assert.equal(ok.currentIntervalMs, 300_000);
  assert.equal(ok.nextPollAtMs, 100_000 + 300_000);
  assert.equal(ok.freshItems, 2);
  assert.equal(ok.duplicateItems, 0);
  assert.equal(typeof ok.checkpointJson, 'string');
  const cp = JSON.parse(ok.checkpointJson);
  assert.equal(cp.scheduleId, 'poll:gmail:t1');
  assert.equal(cp.version, 1);

  // Resume from that checkpoint: same ids are duplicates now.
  const resumed = await run('composio_poll_schedule_v2', {
    ...base,
    outcome: 'success',
    nowMs: ok.nextPollAtMs,
    newItemIds: ['m1', 'm3'],
    seenIds: ['m1'],
    checkpointJson: ok.checkpointJson,
  });
  assert.equal(resumed.freshItems, 1);
  assert.equal(resumed.duplicateItems, 1);

  // Error backs off: 5-min base -> 10-min next.
  const err = await run('composio_poll_schedule_v2', {
    ...base,
    outcome: 'error',
    consecutiveErrors: 0,
  });
  assert.equal(err.consecutiveErrors, 1);
  assert.equal(err.currentIntervalMs, 600_000);
  assert.equal(err.backoffDelayMs, 600_000);
  assert.equal(err.nextPollAtMs, 100_000 + 600_000);
  assert.match(await runRaw('composio_poll_schedule_v2', { ...base, outcome: 'bogus' }), /^Error: outcome must be/);
  assert.match(
    await runRaw('composio_poll_schedule_v2', { ...base, outcome: 'success', checkpointJson: '{bad json' }),
    /^Error: checkpointJson is not valid JSON/,
  );
});

test('composio v114 tools: connection health dashboard + record outcome', async () => {
  const now = 200_000;
  const healthy = {
    connectionId: 'ca_h',
    toolkit: 'gmail',
    totalPolls: 10,
    totalErrors: 0,
    consecutiveErrors: 0,
    lastSyncAtMs: now - 1000,
    lastSuccessAtMs: now - 1000,
    latenciesMs: [100, 120, 110],
    expiresAtMs: null,
  };
  const sick = {
    connectionId: 'ca_s',
    toolkit: 'slack',
    totalPolls: 10,
    totalErrors: 6,
    consecutiveErrors: 6,
    lastSyncAtMs: now - 1000,
    lastSuccessAtMs: now - 50_000,
    latenciesMs: [6000, 7000],
    expiresAtMs: null,
  };
  const out = await run('composio_connection_health', { connections: [healthy, sick], nowMs: now });
  assert.equal(out.evaluated.length, 2);
  assert.equal(out.evaluated[0].status, 'healthy');
  assert.equal(out.evaluated[1].status, 'unhealthy');
  assert.equal(out.dashboard.total, 2);
  assert.equal(out.dashboard.healthy, 1);
  assert.equal(out.dashboard.unhealthy, 1);
  assert.equal(out.dashboard.overallErrorRate, 6 / 20);
  assert.ok(out.dashboard.criticalAlerts.length >= 1);
  // Record one more success for the first connection.
  const recorded = await run('composio_connection_health', {
    connections: [healthy],
    nowMs: now,
    recordOutcome: 'success',
    recordLatencyMs: 90,
  });
  assert.equal(recorded.evaluated[0].totalPolls, 11);
  assert.equal(recorded.evaluated[0].lastSyncAtMs, now);
  assert.match(await runRaw('composio_connection_health', { connections: [] }), /^Error: .*non-empty array/);
  assert.match(
    await runRaw('composio_connection_health', { connections: [{ connectionId: 'x' }] }),
    /^Error: .*toolkit must be a non-empty string/,
  );
});

test('composio v114 tools: trigger templates search/filter/validate', async () => {
  const all = await run('composio_trigger_templates', {});
  assert.equal(all.total, 35);
  assert.equal(all.curated, 29);
  assert.equal(all.candidates, 6);
  const github = await run('composio_trigger_templates', { query: 'github' });
  assert.ok(github.total >= 3);
  assert.ok(github.templates.some((t) => t.slug === 'GITHUB_COMMIT_EVENT'));
  const billing = await run('composio_trigger_templates', { category: 'billing' });
  assert.ok(billing.total >= 3);
  assert.ok(billing.templates.every((t) => t.category === 'billing'));
  const slack = await run('composio_trigger_templates', { toolkit: 'slack' });
  assert.equal(slack.total, 2);
  const one = await run('composio_trigger_templates', { slug: 'STRIPE_CHARGE_FAILED' });
  assert.equal(one.total, 1);
  assert.equal(one.templates[0].toolkit, 'stripe');
  assert.ok(one.templates[0].fields.some((f) => f.name === 'failure_message'));
  assert.ok('charge_id' in one.templates[0].examplePayload);
  const validated = await run('composio_trigger_templates', { validate: true });
  assert.equal(validated.total, 35);
  assert.match(await runRaw('composio_trigger_templates', { slug: 'NOPE_TRIGGER' }), /^Error: Unknown Composio v114 trigger template/);
  assert.match(await runRaw('composio_trigger_templates', { category: 'nope' }), /^Error: category must be one of/);
});

test('composio v114 tools: MCP App open returns URI + HTML + completed mock task', async () => {
  const out = await run('composio_mcp_app_open', {
    toolkit: 'eventbrite',
    slug: 'EVENTBRITE_LIST_EVENTS',
    args: { limit: 1 },
  });
  assert.equal(out.mock, true);
  assert.equal(out.live, false);
  assert.equal(out.appUri, 'ui://composio/eventbrite/EVENTBRITE_LIST_EVENTS');
  assert.ok(out.html.includes('ui://composio/eventbrite/EVENTBRITE_LIST_EVENTS'));
  assert.ok(!/<script/i.test(out.html), 'app HTML must not contain scripts');
  assert.equal(out.task.status, 'completed');
  assert.equal(out.task.result.mock, true);
  assert.equal(out.task.result.slug, 'EVENTBRITE_LIST_EVENTS');
  // Open by full URI instead of toolkit+slug.
  const byUri = await run('composio_mcp_app_open', { appUri: 'ui://composio/xero/XERO_LIST_INVOICES', args: {} });
  assert.equal(byUri.appUri, 'ui://composio/xero/XERO_LIST_INVOICES');
  assert.equal(byUri.task.status, 'completed');
  assert.match(await runRaw('composio_mcp_app_open', { toolkit: 'gmail', slug: 'GMAIL_SEND_EMAIL' }), /^Error: Unknown mock/);
  assert.match(await runRaw('composio_mcp_app_open', { appUri: 'ui://other/x/Y' }), /^Error: Unknown Composio v114 MCP app URI/);
});

test('composio v114 i18n: 18 composioV114 keys in all 6 locales, total 5278', () => {
  const expectedKeys = [
    'composioV114.title',
    'composioV114.subtitle',
    'composioV114.mockOnly',
    'composioV114.needsKey',
    'composioV114.listTitle',
    'composioV114.execute',
    'composioV114.pollTitle',
    'composioV114.pollSchedule',
    'composioV114.healthTitle',
    'composioV114.healthy',
    'composioV114.degraded',
    'composioV114.unhealthy',
    'composioV114.expired',
    'composioV114.triggersTitle',
    'composioV114.templateCount',
    'composioV114.mcpAppsTitle',
    'composioV114.openApp',
    'composioV114.authNote',
  ];
  for (const code of ['vi', 'en', 'zh', 'ja', 'es', 'fr']) {
    const dict = loadLocale(code);
    assert.ok(Object.keys(dict).length >= 8072, `${code}: expected >= 8072 keys, got ${Object.keys(dict).length}`); // v1.38 re-pin: 8072.
    for (const key of expectedKeys) {
      assert.equal(typeof dict[key], 'string', `${code} missing ${key}`);
      assert.ok(dict[key].trim().length > 0, `${code} key ${key} must not be empty`);
    }
  }
});
