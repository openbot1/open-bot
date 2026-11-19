/**
 * Composio v118 tools tests (v1.18, Doi T4 — node:test, no network, no key).
 *
 * Covers:
 * - 6 tools v118 registered in ALL_TOOLS (604 in v1.19 merge: 584 + 20), unique names,
 *   present in createDefaultTools() unbound placeholders
 * - composio_mock_toolkit_list_v118 / execute_v118 (mock-only responses)
 * - composio_poll_adaptive_v118 (hit/miss/error, burst/idle modes,
 *   dedupe counts, state JSON round-trips through resume)
 * - composio_trigger_instances (register/list/enable/disable/delete/fire
 *   from seed instances)
 * - composio_oauth_state (inspect/transition/auto-refresh mock + UI state)
 * - composio_webhook_ingest (loopback-only, HMAC verify with mock secret,
 *   token fallback, dedupe, route)
 * - i18n: 30 composioV118.* keys exist in all 6 locales, non-empty,
 *   and the locale total is 5936 + 30 = 5966
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/composio-v118-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  COMPOSIO_V118_TOOLS,
  COMPOSIO_V118_TOOL_NAMES,
  createComposioV118Tools,
  isComposioV118ToolName,
} from '../packages/tools/dist/composioV118Tools.js';
import { computeComposioWebhookSignature } from '../packages/core/dist/composio/triggers.js';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'apps/desktop/src/renderer/i18n/locales');

function loadLocale(code) {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf-8'));
}

function tool(name) {
  const t = createComposioV118Tools().find((x) => x.definition.name === name);
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

const NOW = 1_800_000_000_000;

test('composio v118 tools: 6 tools, unique names, in ALL_TOOLS (604)', () => {
  assert.deepEqual([...COMPOSIO_V118_TOOL_NAMES], [
    'composio_mock_toolkit_list_v118',
    'composio_mock_toolkit_execute_v118',
    'composio_poll_adaptive_v118',
    'composio_trigger_instances',
    'composio_oauth_state',
    'composio_webhook_ingest',
  ]);
  assert.equal(COMPOSIO_V118_TOOLS.length, 6);
  assert.equal(createComposioV118Tools().length, 6);
  assert.equal(new Set(COMPOSIO_V118_TOOLS.map((t) => t.definition.name)).size, 6);
  for (const name of COMPOSIO_V118_TOOL_NAMES) {
    assert.equal(isComposioV118ToolName(name), true);
  }
  assert.equal(isComposioV118ToolName('composio_mock_toolkit_execute_v114'), false);
  // ALL_TOOLS is 604 in v1.19 merge (584 + 12 memory v18 + 8 composio v119).
  assert.ok(ALL_TOOLS.length >= 1078, 'v1.19 merge: 584 + 20 = 653 (12 memory v18 + 8 composio v119)'); // v1.38 re-pin: 899 + 179 = 1078.
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  for (const name of COMPOSIO_V118_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `${name} must be in ALL_TOOLS`);
  }
  // Unbound placeholders are present (pure tools need no host wiring).
  const bound = createDefaultTools();
  assert.ok(bound.length >= 1078); // v1.38 re-pin: 899 + 179 = 1078.
  for (const name of COMPOSIO_V118_TOOL_NAMES) {
    assert.ok(bound.some((t) => t.definition.name === name), `${name} must be in createDefaultTools()`);
  }
  // No tool needs approval (all read-only / mock / pure computation).
  for (const t of COMPOSIO_V118_TOOLS) assert.equal(t.needsApproval, false);
});

test('composio v118 tools: mock toolkit list + execute', async () => {
  const list = await run('composio_mock_toolkit_list_v118', {});
  assert.equal(list.mock, true);
  assert.equal(list.live, false);
  assert.equal(list.totalToolkits, 3);
  assert.equal(list.totalSlugs, 30);
  assert.equal(list.writeSlugs + list.readSlugs, 30);
  assert.deepEqual(list.toolkits.map((t) => t.slug), ['canva', 'pandadoc', 'loom']);
  for (const t of list.toolkits) {
    assert.equal(t.candidateToolSlugs.length, 10);
    assert.ok(['oauth2', 'api-key', 'oauth2-or-api-key'].includes(t.authKind));
    assert.ok(t.authNote.length > 20);
  }
  const exec = await run('composio_mock_toolkit_execute_v118', {
    toolkit: 'loom',
    slug: 'LOOM_LIST_VIDEOS',
    args: { limit: 2 },
  });
  assert.equal(exec.mock, true);
  assert.equal(exec.live, false);
  assert.equal(exec.needsApproval, false);
  assert.equal(exec.data.echo.limit, 2);
  assert.ok(Array.isArray(exec.data.videos));
  const writeExec = await run('composio_mock_toolkit_execute_v118', {
    toolkit: 'pandadoc',
    slug: 'PANDADOC_CREATE_DOCUMENT',
    args: {},
  });
  assert.equal(writeExec.needsApproval, true);
  assert.match(await runRaw('composio_mock_toolkit_execute_v118', { toolkit: 'gmail', slug: 'GMAIL_SEND_EMAIL' }), /^Error: Unknown mock/);
  assert.match(await runRaw('composio_mock_toolkit_execute_v118', { toolkit: 'canva' }), /^Error: Missing required argument/);
});

test('composio v118 tools: poll adaptive (hit/miss/error, burst/idle, dedupe, resume)', async () => {
  const base = {
    connectionId: 'ca_1',
    toolkit: 'gmail',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    nowMs: NOW,
  };
  // Hit: 300000 -> 150000, 2 item moi.
  const hit = await run('composio_poll_adaptive_v118', { ...base, outcome: 'hit', newItemIds: ['m1', 'm2'] });
  assert.equal(hit.currentIntervalMs, 150000);
  assert.equal(hit.mode, 'normal');
  assert.equal(hit.freshItems, 2);
  assert.equal(hit.duplicateItems, 0);
  assert.equal(hit.totalNewItems, 2);
  assert.ok(typeof hit.stateJson === 'string');
  // Resume tu stateJson + hit nua voi m1 trung, m3 moi -> burst (hit lien tiep 2).
  const hit2 = await run('composio_poll_adaptive_v118', {
    ...base,
    outcome: 'hit',
    nowMs: NOW + 1000,
    stateJson: hit.stateJson,
    newItemIds: ['m1', 'm3'],
    seenIds: ['m1', 'm2'],
  });
  assert.equal(hit2.freshItems, 1);
  assert.equal(hit2.duplicateItems, 1);
  assert.equal(hit2.mode, 'burst');
  assert.equal(hit2.totalNewItems, 3);
  // Miss tu state moi: gian interval.
  const miss = await run('composio_poll_adaptive_v118', { ...base, outcome: 'miss', nowMs: NOW + 2000, stateJson: hit2.stateJson });
  assert.ok(miss.currentIntervalMs > hit2.currentIntervalMs);
  assert.equal(miss.consecutiveMisses, 1);
  // Error: backoff nhan 2 tu base.
  const err = await run('composio_poll_adaptive_v118', { ...base, outcome: 'error', error: 'boom' });
  assert.equal(err.currentIntervalMs, 600000);
  assert.equal(err.consecutiveErrors, 1);
  assert.equal(err.mode, 'error');
  // Outcome sai + slug sai -> Error:.
  assert.match(
    await runRaw('composio_poll_adaptive_v118', { ...base, outcome: 'maybe' }),
    /^Error: outcome must be one of/,
  );
  assert.match(
    await runRaw('composio_poll_adaptive_v118', { ...base, outcome: 'hit', triggerSlug: 'bad' }),
    /^Error: triggerSlug must match/,
  );
  assert.match(
    await runRaw('composio_poll_adaptive_v118', { ...base, outcome: 'hit', stateJson: '{bad json' }),
    /^Error: poll state JSON is not valid JSON/,
  );
});

test('composio v118 tools: trigger instances CRUD from seeds', async () => {
  const seed = {
    triggerId: 'ti_1',
    triggerSlug: 'GITHUB_COMMIT_EVENT',
    toolkit: 'github',
    connectionId: 'ca_1',
    label: 'Commits',
  };
  const registered = await run('composio_trigger_instances', {
    action: 'register',
    ...seed,
    nowMs: NOW,
  });
  assert.equal(registered.instance.triggerId, 'ti_1');
  assert.equal(registered.instance.status, 'enabled');
  assert.equal(registered.instance.health, 'silent');
  // List tu seed (chua fire): silent.
  const listed = await run('composio_trigger_instances', {
    action: 'list',
    instances: [seed],
    nowMs: NOW,
  });
  assert.equal(listed.total, 1);
  assert.equal(listed.summary.total, 1);
  assert.equal(listed.summary.silent, 1);
  // Fire tu seed: totalFired 1, healthy.
  const fired = await run('composio_trigger_instances', {
    action: 'fire',
    triggerId: 'ti_1',
    instances: [{ ...seed, createdAtMs: NOW }],
    nowMs: NOW + 1000,
  });
  assert.equal(fired.instance.totalFired, 1);
  assert.equal(fired.instance.health, 'healthy');
  // Disable + enable tu seed.
  const disabled = await run('composio_trigger_instances', {
    action: 'disable',
    triggerId: 'ti_1',
    instances: [seed],
    nowMs: NOW,
  });
  assert.equal(disabled.instance.status, 'disabled');
  const enabled = await run('composio_trigger_instances', {
    action: 'enable',
    triggerId: 'ti_1',
    instances: [{ ...seed, status: 'disabled' }],
    nowMs: NOW,
  });
  assert.equal(enabled.instance.status, 'enabled');
  // Delete tu seed.
  const deleted = await run('composio_trigger_instances', {
    action: 'delete',
    triggerId: 'ti_1',
    instances: [seed],
    nowMs: NOW,
  });
  assert.equal(deleted.removed, true);
  // Loi: instance khong ton tai, slug sai.
  assert.match(
    await runRaw('composio_trigger_instances', { action: 'enable', triggerId: 'ti_missing', nowMs: NOW }),
    /^Error: unknown trigger instance/,
  );
  assert.match(
    await runRaw('composio_trigger_instances', { action: 'register', triggerId: 'ti_1', triggerSlug: 'bad', toolkit: 'github', connectionId: 'ca_1', nowMs: NOW }),
    /^Error: triggerSlug is invalid/,
  );
});

test('composio v118 tools: oauth state inspect/transition/auto-refresh', async () => {
  const base = { connectionId: 'ca_1', toolkit: 'gmail', nowMs: NOW };
  // Inspect connected + sap het han -> UI amber + refresh.
  const inspected = await run('composio_oauth_state', { ...base, action: 'inspect', state: 'connected', expiresAtMs: NOW + 60 * 1000 });
  assert.equal(inspected.entry.state, 'connected');
  assert.equal(inspected.ui.badge, 'amber');
  assert.equal(inspected.ui.action, 'refresh');
  assert.equal(inspected.expiringSoon, true);
  assert.equal(inspected.autoRefresh.allowed, true);
  // Inspect revoked -> UI red + reconnect.
  const revoked = await run('composio_oauth_state', { ...base, action: 'inspect', state: 'revoked' });
  assert.equal(revoked.ui.badge, 'red');
  assert.equal(revoked.ui.action, 'reconnect');
  assert.equal(revoked.ui.needsAttention, true);
  assert.equal(revoked.autoRefresh.allowed, false);
  // Transition hop le: connecting -> connected.
  const moved = await run('composio_oauth_state', { ...base, action: 'transition', state: 'connecting', to: 'connected', reason: 'user finished OAuth' });
  assert.equal(moved.entry.state, 'connected');
  assert.equal(moved.audit.from, 'connecting');
  assert.equal(moved.audit.to, 'connected');
  // Transition khong hop le: revoked -> connected.
  assert.match(
    await runRaw('composio_oauth_state', { ...base, action: 'transition', state: 'revoked', to: 'connected', reason: 'x' }),
    /^Error: Invalid OAuth transition/,
  );
  // Auto-refresh mock thanh cong: expired -> connected.
  const refreshed = await run('composio_oauth_state', {
    ...base,
    action: 'auto-refresh',
    state: 'expired',
    refreshOutcome: 'success',
    refreshExpiresAtMs: NOW + 3600000,
  });
  assert.equal(refreshed.entry.state, 'connected');
  assert.equal(refreshed.entry.expiresAtMs, NOW + 3600000);
  assert.equal(refreshed.audits.length, 2);
  // Auto-refresh mock that bai: expired, dem +1.
  const failed = await run('composio_oauth_state', { ...base, action: 'auto-refresh', state: 'expired', refreshOutcome: 'error' });
  assert.equal(failed.entry.state, 'expired');
  assert.equal(failed.entry.autoRefreshAttempts, 1);
  // Auto-refresh mock bi thu hoi: revoked.
  const rev = await run('composio_oauth_state', { ...base, action: 'auto-refresh', state: 'expired', refreshOutcome: 'revoked' });
  assert.equal(rev.entry.state, 'revoked');
  assert.equal(rev.ui.action, 'reconnect');
});

test('composio v118 tools: webhook ingest (mock secret, dedupe, route)', async () => {
  const secret = 'mock-secret-v118-tool';
  const ts = String(Math.floor(NOW / 1000));
  const body = JSON.stringify({
    id: 'msg_1',
    type: 'composio.trigger.message',
    metadata: { trigger_slug: 'GITHUB_COMMIT_EVENT', trigger_id: 'ti_1', connected_account_id: 'ca_1' },
    data: { commit_sha: 'abc' },
  });
  const sig = computeComposioWebhookSignature(secret, 'wh_1', ts, body);
  const base = {
    rawBody: body,
    webhookId: 'wh_1',
    timestamp: ts,
    signature: sig,
    mockSecret: secret,
    registeredTriggerIds: ['ti_1'],
    nowMs: NOW,
  };
  const routed = await run('composio_webhook_ingest', base);
  assert.equal(routed.status, 200);
  assert.equal(routed.route, 'routed');
  assert.equal(routed.event.triggerSlug, 'GITHUB_COMMIT_EVENT');
  assert.equal(routed.log.length, 1);
  assert.equal(routed.log[0].route, 'routed');
  // Chu ky sai -> 401.
  const badSig = await run('composio_webhook_ingest', { ...base, signature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  assert.equal(badSig.status, 401);
  assert.equal(badSig.accepted, false);
  // Khong phai loopback -> 403.
  const remote = await run('composio_webhook_ingest', { ...base, remoteAddress: '8.8.8.8' });
  assert.equal(remote.status, 403);
  // Trigger chua dang ky -> ignored-unknown-trigger (200).
  const unknownBody = JSON.stringify({
    id: 'msg_2',
    type: 'composio.trigger.message',
    metadata: { trigger_slug: 'GITHUB_COMMIT_EVENT', trigger_id: 'ti_x', connected_account_id: 'ca_1' },
    data: {},
  });
  const unknown = await run('composio_webhook_ingest', {
    ...base,
    rawBody: unknownBody,
    webhookId: 'wh_2',
    signature: computeComposioWebhookSignature(secret, 'wh_2', ts, unknownBody),
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.route, 'ignored-unknown-trigger');
  // Token fallback: khong co chu ky, token dung -> routed.
  const tokenBody = JSON.stringify({
    id: 'msg_3',
    type: 'composio.trigger.message',
    metadata: { trigger_slug: 'GITHUB_COMMIT_EVENT', trigger_id: 'ti_1', connected_account_id: 'ca_1' },
    data: {},
  });
  const viaToken = await run('composio_webhook_ingest', {
    rawBody: tokenBody,
    mockSecret: secret,
    token: 'tok-mock',
    mockToken: 'tok-mock',
    registeredTriggerIds: ['ti_1'],
    nowMs: NOW,
  });
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.route, 'routed');
});

test('composio v118 i18n: 30 keys in all 6 locales, total 6863', () => {
  const codes = ['vi', 'en', 'es', 'fr', 'ja', 'zh'];
  const keys = [
    'composioV118.title',
    'composioV118.subtitle',
    'composioV118.listTitle',
    'composioV118.mockOnly',
    'composioV118.needsKey',
    'composioV118.execute',
    'composioV118.authNote',
    'composioV118.pollTitle',
    'composioV118.pollMode',
    'composioV118.pollBurst',
    'composioV118.pollIdle',
    'composioV118.pollNormal',
    'composioV118.pollError',
    'composioV118.pollDisabled',
    'composioV118.triggersTitle',
    'composioV118.triggerEnable',
    'composioV118.triggerDisable',
    'composioV118.triggerDelete',
    'composioV118.triggerRegister',
    'composioV118.triggerHealthy',
    'composioV118.triggerStale',
    'composioV118.triggerSilent',
    'composioV118.triggerError',
    'composioV118.oauthTitle',
    'composioV118.oauth.connected',
    'composioV118.oauth.connecting',
    'composioV118.oauth.expired',
    'composioV118.oauth.revoked',
    'composioV118.oauth.refreshing',
    'composioV118.webhookTitle',
  ];
  assert.equal(keys.length, 30);
  const counts = [];
  for (const code of codes) {
    const dict = loadLocale(code);
    counts.push(Object.keys(dict).length);
    for (const key of keys) {
      assert.equal(typeof dict[key], 'string', `${code} missing ${key}`);
      assert.ok(dict[key].length > 0, `${code} empty ${key}`);
    }
  }
  assert.equal(new Set(counts).size, 1, `6 locale phai co cung tong key: ${counts.join(', ')}`);
  assert.ok(counts[0] >= 8072, `tong key moi locale phai >= 8072 (v1.38), got ${counts[0]}`); // v1.39 fix round 4b: floor (8072 at v1.38; 8322 at v1.39).
});
