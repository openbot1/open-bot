/**
 * Composio v129 tests — tools wiring (v1.29, Doi T4 — node:test,
 * no network, no real key, mock-only).
 *
 * Covers packages/tools/src/composioV129Tools.ts end to end through
 * the Tool interface (the same surface the agent loop calls):
 * - Registry: 10 v129 tools, unique names, all in ALL_TOOLS,
 *   ALL_TOOLS = 899 (825 merge/v135 + 74 v136). NOTE: the
 *   1274 pin in other tests counts defaultToolFactory (ALL_TOOLS +
 *   the registry factories in coordinator.ts: A2A/MCP/memory/voice
 *   /plan/...), NOT ALL_TOOLS alone — v1.36 re-pin: factory 1274
 *   (ALL_TOOLS 899 + 375).
 *   createDefaultTools({ getComposioV129ToolOptions }) binds with
 *   shared stores (same job visible through both the placeholder
 *   and the bound set — no duplicates);
 *   ToolRegistry.registerComposioV129Tools
 * - Long jobs through tools: submit -> poll xN -> done with mock
 *   step results; get/list/cancel; submit rejects non-v129 toolkits
 *   and unknown params; poll of unknown job errors; cancel of a
 *   done job is refused; timeout via nowMs
 * - Mock toolkit list/execute (samples, echo, unknown param error)
 * - Sandbox: create -> status; call quota enforced through the
 *   tools (mock execute denied past maxCalls); write tool denied
 *   when allowWrite=false; poll quota enforced on job polls
 * - App bindings through tools: bind (write scope) -> write job
 *   submit allowed; bind read-only -> write submit denied;
 *   check/list/unbind/enable; unknown default param rejected
 * - Shared stores: one createComposioV129Tools() call shares one
 *   job store across its 10 tools (submit with one tool instance,
 *   poll with another from the same set)
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/composio-v129-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_V129_TOOLS,
  COMPOSIO_V129_TOOL_NAMES,
  createComposioV129Tools,
  isComposioV129ToolName,
} from '../packages/tools/dist/composioV129Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';
import { MemoryComposioV129JobStore } from '../packages/core/dist/composio/longJobsV129.js';
import { MemoryComposioV129SandboxStore } from '../packages/core/dist/composio/sandboxV129.js';
import { MemoryComposioV129BindingStore } from '../packages/core/dist/composio/appBindingsV129.js';

const NOW = 1780000000000;

/** Run one v129 tool by name on a tool set; parse JSON results. */
async function runTool(tools, name, args) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  const raw = await tool.execute(args);
  assert.equal(typeof raw, 'string');
  return raw.startsWith('{') ? JSON.parse(raw) : raw;
}

/** Fresh tools (fresh in-session stores) per test. */
function freshTools() {
  return createComposioV129Tools({ nowMs: () => NOW });
}

test('tools: 10 v129 tools, unique names, all in ALL_TOOLS (663)', () => {
  assert.equal(COMPOSIO_V129_TOOLS.length, 10);
  assert.deepEqual([...COMPOSIO_V129_TOOL_NAMES], [
    'composio_long_job_submit_v129',
    'composio_long_job_poll_v129',
    'composio_long_job_get_v129',
    'composio_long_job_list_v129',
    'composio_long_job_cancel_v129',
    'composio_mock_toolkit_list_v129',
    'composio_mock_toolkit_execute_v129',
    'composio_sandbox_create_v129',
    'composio_sandbox_status_v129',
    'composio_app_bind_v129',
  ]);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  // ALL_TOOLS = 899 (825 merge/v135 + 74 v136). The 1274 pin counts
  // defaultToolFactory (ALL_TOOLS + registry factories) — v1.36 re-pin.
  assert.equal(names.length, 899, `expected 899 tools (825 + 74 v136), got ${names.length}`); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(names).size, names.length, 'duplicate tool names in ALL_TOOLS');
  for (const name of COMPOSIO_V129_TOOL_NAMES) {
    assert.ok(names.includes(name), `${name} must be in ALL_TOOLS`);
    assert.ok(isComposioV129ToolName(name));
  }
  assert.equal(isComposioV129ToolName('read_file'), false);
  for (const tool of COMPOSIO_V129_TOOLS) {
    assert.equal(tool.definition.parameters.type, 'object');
    assert.equal(typeof tool.needsApproval, 'boolean');
  }
});

test('tools: createDefaultTools binds shared stores without duplicates', () => {
  const jobStore = new MemoryComposioV129JobStore();
  const bound = createDefaultTools({
    getComposioV129ToolOptions: () => ({ jobStore, nowMs: () => NOW }),
  });
  assert.equal(bound.length, ALL_TOOLS.length, 'bind must not add/remove tools');
  const names = bound.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  // The bound set shares the store: submit via bound tools, read via the store.
  return (async () => {
    const submitted = await runTool(bound, 'composio_long_job_submit_v129', {
      toolkit: 'klaviyo',
      slug: 'KLAVIYO_LIST_LISTS',
      totalSteps: 1,
      nowMs: NOW,
    });
    assert.equal(submitted.mock, true);
    assert.equal(jobStore.get(submitted.jobId).slug, 'KLAVIYO_LIST_LISTS');
  })();
});

test('tools: registry registerComposioV129Tools', () => {
  const registry = new ToolRegistry();
  registry.registerComposioV129Tools({ nowMs: () => NOW });
  assert.equal(registry.size(), 10);
  assert.ok(registry.has('composio_long_job_submit_v129'));
  assert.throws(() => registry.registerComposioV129Tools(), /already registered/);
});

test('tools: long job submit -> poll -> done, get/list', async () => {
  const tools = freshTools();
  const submitted = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_LIST_ROWS',
    args: { sheetId: 's1' },
    totalSteps: 2,
    nowMs: NOW,
  });
  assert.equal(submitted.mock, true);
  assert.equal(submitted.live, false);
  assert.equal(submitted.status, 'pending');
  assert.equal(submitted.totalSteps, 2);
  assert.ok(submitted.jobId.startsWith('job-v129-'));
  assert.ok(submitted.nextPollAtMs > NOW);
  assert.equal(submitted.pollDelayTable.length, 4);

  const poll1 = await runTool(tools, 'composio_long_job_poll_v129', {
    jobId: submitted.jobId,
    nowMs: submitted.nextPollAtMs,
  });
  assert.equal(poll1.outcome, 'progress');
  assert.equal(poll1.job.status, 'running');
  assert.equal(poll1.job.stepsDone, 1);
  assert.equal(poll1.finished, false);
  assert.ok(poll1.nextDelayMs >= 2000);

  const poll2 = await runTool(tools, 'composio_long_job_poll_v129', {
    jobId: submitted.jobId,
    nowMs: poll1.nextPollAtMs,
  });
  assert.equal(poll2.outcome, 'done');
  assert.equal(poll2.job.status, 'done');
  assert.equal(poll2.finished, true);
  assert.equal(poll2.nextDelayMs, 0);
  assert.ok(poll2.result);
  assert.equal(poll2.result.stepsDone, 2);
  assert.equal(poll2.result.steps[0].step, 1);

  // Polling a done job again is a no-op done.
  const poll3 = await runTool(tools, 'composio_long_job_poll_v129', {
    jobId: submitted.jobId,
    nowMs: NOW + 999999,
  });
  assert.equal(poll3.outcome, 'done');
  assert.equal(poll3.job.stepsDone, 2);

  const got = await runTool(tools, 'composio_long_job_get_v129', { jobId: submitted.jobId, nowMs: NOW });
  assert.equal(got.job.status, 'done');
  assert.equal(got.stepResultsTail.length, 2);
  assert.equal(got.result.stepsDone, 2);

  const listed = await runTool(tools, 'composio_long_job_list_v129', { nowMs: NOW });
  assert.equal(listed.jobs.length, 1);
  assert.equal(listed.summary.total, 1);
  assert.equal(listed.summary.done, 1);
  const active = await runTool(tools, 'composio_long_job_list_v129', { activeOnly: true, nowMs: NOW });
  assert.equal(active.jobs.length, 0);
});

test('tools: long job submit validation + cancel + timeout', async () => {
  const tools = freshTools();
  // Non-v129 toolkit: no live key, so the job is refused (mock-only).
  const live = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'gmail',
    slug: 'GMAIL_LIST_MESSAGES',
    nowMs: NOW,
  });
  assert.match(live, /Unknown mock Composio v129 toolkit: gmail/);
  // Unknown slug for a v129 toolkit.
  const badSlug = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_NOPE',
    nowMs: NOW,
  });
  assert.match(badSlug, /Unknown mock Composio v129 tool slug/);
  // Unknown param.
  const badParam = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_GET_SHEET',
    args: { bogus: 1 },
    nowMs: NOW,
  });
  assert.match(badParam, /Unknown params for SMARTSHEET_GET_SHEET: bogus/);
  // Unknown job.
  assert.match(await runTool(tools, 'composio_long_job_poll_v129', { jobId: 'nope', nowMs: NOW }), /Unknown Composio v129 job/);
  assert.match(await runTool(tools, 'composio_long_job_get_v129', { jobId: 'nope', nowMs: NOW }), /Unknown Composio v129 job/);
  assert.match(await runTool(tools, 'composio_long_job_cancel_v129', { jobId: 'nope', nowMs: NOW }), /Unknown Composio v129 job/);

  // Cancel: requested, then applied at the next poll.
  const submitted = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'onedrive',
    slug: 'ONEDRIVE_LIST_FILES',
    totalSteps: 5,
    nowMs: NOW,
  });
  const cancelled = await runTool(tools, 'composio_long_job_cancel_v129', {
    jobId: submitted.jobId,
    reason: 'no longer needed',
    nowMs: NOW,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.cancelRequested, true);
  const polled = await runTool(tools, 'composio_long_job_poll_v129', {
    jobId: submitted.jobId,
    nowMs: NOW + 2000,
  });
  assert.equal(polled.job.status, 'cancelled');
  assert.equal(polled.job.stepsDone, 0);
  // Cancel of a terminal job is refused.
  const again = await runTool(tools, 'composio_long_job_cancel_v129', { jobId: submitted.jobId, nowMs: NOW });
  assert.equal(again.cancelled, false);
  assert.match(again.note, /already cancelled/);

  // Timeout: a job past its deadline times out on poll.
  const slow = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'klaviyo',
    slug: 'KLAVIYO_LIST_LISTS',
    totalSteps: 100,
    timeoutMs: 1000,
    nowMs: NOW,
  });
  const timedOut = await runTool(tools, 'composio_long_job_poll_v129', {
    jobId: slow.jobId,
    nowMs: NOW + 5000,
  });
  assert.equal(timedOut.job.status, 'timed-out');
  assert.match(timedOut.note, /timed out/);
});

test('tools: mock toolkit list/execute', async () => {
  const tools = freshTools();
  const listed = await runTool(tools, 'composio_mock_toolkit_list_v129', {});
  assert.equal(listed.mock, true);
  assert.equal(listed.live, false);
  assert.equal(listed.totalToolkits, 4);
  assert.equal(listed.totalSlugs, 40);
  assert.deepEqual(listed.toolkits.map((t) => t.slug), ['smartsheet', 'servicenow', 'klaviyo', 'onedrive']);
  const executed = await runTool(tools, 'composio_mock_toolkit_execute_v129', {
    toolkit: 'servicenow',
    slug: 'SERVICENOW_LIST_INCIDENTS',
    args: { state: 'new' },
  });
  assert.equal(executed.mock, true);
  assert.equal(executed.live, false);
  assert.ok(Array.isArray(executed.data.incidents));
  assert.equal(executed.data.echo.state, 'new');
  assert.equal(executed.needsApproval, false);
  const write = await runTool(tools, 'composio_mock_toolkit_execute_v129', {
    toolkit: 'klaviyo',
    slug: 'KLAVIYO_SEND_CAMPAIGN',
    args: { campaignId: 'c1' },
  });
  assert.equal(write.needsApproval, true);
  assert.equal(write.data.sent, true);
  assert.match(
    await runTool(tools, 'composio_mock_toolkit_execute_v129', {
      toolkit: 'klaviyo',
      slug: 'KLAVIYO_SEND_CAMPAIGN',
      args: { nope: 1 },
    }),
    /Unknown params for KLAVIYO_SEND_CAMPAIGN: nope/,
  );
  assert.match(
    await runTool(tools, 'composio_mock_toolkit_execute_v129', { toolkit: 'gmail', slug: 'X' }),
    /Unknown mock Composio v129 toolkit: gmail/,
  );
});

test('tools: sandbox create/status + quota enforced through tools', async () => {
  const tools = freshTools();
  const missing = await runTool(tools, 'composio_sandbox_status_v129', { conversationId: 'c-none', nowMs: NOW });
  assert.match(missing, /No Composio v129 sandbox for conversation: c-none/);
  const created = await runTool(tools, 'composio_sandbox_create_v129', {
    conversationId: 'c1',
    allowedToolkits: ['smartsheet'],
    maxCalls: 1,
    nowMs: NOW,
  });
  assert.equal(created.mock, true);
  assert.equal(created.sandbox.conversationId, 'c1');
  assert.deepEqual(created.sandbox.allowedToolkits, ['smartsheet']);
  assert.equal(created.sandbox.headroom.callsLeft, 1);
  // One call succeeds and consumes the quota.
  const ok = await runTool(tools, 'composio_mock_toolkit_execute_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_LIST_ROWS',
    args: { sheetId: 's1' },
    conversationId: 'c1',
  });
  assert.equal(ok.mock, true);
  // Second call is denied by the sandbox (quota), and audited.
  const denied = await runTool(tools, 'composio_mock_toolkit_execute_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_LIST_ROWS',
    args: { sheetId: 's1' },
    conversationId: 'c1',
  });
  assert.match(denied, /Call quota exceeded/);
  const status = await runTool(tools, 'composio_sandbox_status_v129', { conversationId: 'c1', nowMs: NOW });
  assert.equal(status.sandbox.usage.calls, 1);
  assert.equal(status.sandbox.usage.deniedCalls, 1);
  assert.equal(status.sandbox.headroom.callsLeft, 0);
  assert.ok(status.sandbox.auditTail.some((e) => e.action === 'call-denied'));
  // A toolkit outside the allowlist is denied even with quota left.
  const created2 = await runTool(tools, 'composio_sandbox_create_v129', {
    conversationId: 'c2',
    allowedToolkits: ['klaviyo'],
    nowMs: NOW,
  });
  assert.equal(created2.sandbox.allowedToolkits[0], 'klaviyo');
  const wrongToolkit = await runTool(tools, 'composio_mock_toolkit_execute_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_LIST_ROWS',
    args: { sheetId: 's1' },
    conversationId: 'c2',
  });
  assert.match(wrongToolkit, /not allowed in this conversation sandbox/);
});

test('tools: sandbox blocks write tools when allowWrite=false', async () => {
  const tools = freshTools();
  await runTool(tools, 'composio_sandbox_create_v129', { conversationId: 'c1', nowMs: NOW });
  // Bind with write scope first, so the binding layer passes and the
  // sandbox allowWrite=false denial is what surfaces.
  await runTool(tools, 'composio_app_bind_v129', {
    action: 'bind',
    conversationId: 'c1',
    toolkit: 'smartsheet',
    scopes: ['read', 'write'],
    nowMs: NOW,
  });
  const denied = await runTool(tools, 'composio_mock_toolkit_execute_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_CREATE_ROW',
    args: { sheetId: 's1', cells: [] },
    conversationId: 'c1',
  });
  assert.match(denied, /allowWrite=false/);
  // Read tools still pass in the same sandbox.
  const ok = await runTool(tools, 'composio_mock_toolkit_execute_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_LIST_ROWS',
    args: { sheetId: 's1' },
    conversationId: 'c1',
  });
  assert.equal(ok.mock, true);
});

test('tools: app bind gates write jobs; check/list/unbind', async () => {
  const tools = freshTools();
  await runTool(tools, 'composio_sandbox_create_v129', {
    conversationId: 'c1',
    allowWrite: true,
    nowMs: NOW,
  });
  // Machine default is read-only: a write job submit is denied.
  const deniedWrite = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_CREATE_ROW',
    args: { sheetId: 's1', cells: [] },
    totalSteps: 1,
    conversationId: 'c1',
    nowMs: NOW,
  });
  assert.match(deniedWrite, /lacks 'write' scope/);
  // A read job submit passes on the machine default.
  const readOk = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_LIST_ROWS',
    args: { sheetId: 's1' },
    totalSteps: 1,
    conversationId: 'c1',
    nowMs: NOW,
  });
  assert.equal(readOk.status, 'pending');
  // Bind with write scope, then the write job passes.
  const bound = await runTool(tools, 'composio_app_bind_v129', {
    action: 'bind',
    conversationId: 'c1',
    toolkit: 'smartsheet',
    scopes: ['read', 'write'],
    nowMs: NOW,
  });
  assert.equal(bound.action, 'bind');
  assert.deepEqual(bound.binding.scopes, ['read', 'write']);
  const writeOk = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_CREATE_ROW',
    args: { sheetId: 's1', cells: [] },
    totalSteps: 1,
    conversationId: 'c1',
    nowMs: NOW,
  });
  assert.equal(writeOk.status, 'pending');
  // Check + list.
  const checked = await runTool(tools, 'composio_app_bind_v129', {
    action: 'check',
    conversationId: 'c1',
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_CREATE_ROW',
    nowMs: NOW,
  });
  assert.equal(checked.allowed, true);
  assert.equal(checked.neededScope, 'write');
  const listed = await runTool(tools, 'composio_app_bind_v129', {
    action: 'list',
    conversationId: 'c1',
    nowMs: NOW,
  });
  assert.equal(listed.bindings.length, 1);
  assert.equal(listed.summary.total, 1);
  // Unknown default param rejected at bind time.
  const badBind = await runTool(tools, 'composio_app_bind_v129', {
    action: 'bind',
    conversationId: 'c1',
    toolkit: 'klaviyo',
    defaultParams: { bogus: 1 },
    nowMs: NOW,
  });
  assert.match(badBind, /unknown params/);
  // Disable -> write check fails; unbind -> gone.
  const disabled = await runTool(tools, 'composio_app_bind_v129', {
    action: 'disable',
    conversationId: 'c1',
    toolkit: 'smartsheet',
    nowMs: NOW,
  });
  assert.equal(disabled.binding.enabled, false);
  const checkedAfterDisable = await runTool(tools, 'composio_app_bind_v129', {
    action: 'check',
    conversationId: 'c1',
    toolkit: 'smartsheet',
    slug: 'SMARTSHEET_LIST_ROWS',
    nowMs: NOW,
  });
  assert.equal(checkedAfterDisable.allowed, false);
  const unbound = await runTool(tools, 'composio_app_bind_v129', {
    action: 'unbind',
    conversationId: 'c1',
    toolkit: 'smartsheet',
    nowMs: NOW,
  });
  assert.equal(unbound.removed, true);
  assert.match(
    await runTool(tools, 'composio_app_bind_v129', { action: 'bogus', conversationId: 'c1', nowMs: NOW }),
    /Unknown action: bogus/,
  );
});

test('tools: shared stores across one tool set (submit here, poll there)', async () => {
  const jobStore = new MemoryComposioV129JobStore();
  const sandboxStore = new MemoryComposioV129SandboxStore();
  const bindingStore = new MemoryComposioV129BindingStore();
  const tools = createComposioV129Tools({
    jobStore,
    sandboxStore,
    bindingStore,
    nowMs: () => NOW,
  });
  const submitted = await runTool(tools, 'composio_long_job_submit_v129', {
    toolkit: 'onedrive',
    slug: 'ONEDRIVE_LIST_FILES',
    totalSteps: 1,
    nowMs: NOW,
  });
  assert.equal(jobStore.size(), 1);
  // A second tool set built on the SAME stores sees the job.
  const tools2 = createComposioV129Tools({
    jobStore,
    sandboxStore,
    bindingStore,
    nowMs: () => NOW,
  });
  const polled = await runTool(tools2, 'composio_long_job_poll_v129', {
    jobId: submitted.jobId,
    nowMs: NOW + 2000,
  });
  assert.equal(polled.job.status, 'done');
});
