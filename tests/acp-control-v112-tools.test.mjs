/**
 * Tests for v1.12 Team T4: ACP Control Center tools.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/acp-control-v112-tools.test.mjs
 *
 * Tools run against a real AcpControlCenter backed by the repo's
 * fake ACP agent (tests/fixtures/fake-acp-agent-v103.mjs) — no real
 * CLI, no network, no credential. The fake agent is registered
 * directly on the center (custom backend); the tools only drive it
 * through the center.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpControlCenter } from '../packages/core/dist/acp/control/index.js';
import {
  ACP_CONTROL_TOOLS,
  createAcpControlTools,
} from '../packages/tools/dist/acpControlTools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(here, 'fixtures', 'fake-acp-agent-v103.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-control-tools-v112-'));
}

function setup(t) {
  const center = new AcpControlCenter({ stateDir: tmpDir() });
  // Always kill the fake agent, even when the test throws first —
  // otherwise the child keeps the test file's event loop alive.
  if (t) t.after(() => center.dispose());
  const record = center.register({
    backendId: 'custom',
    name: 'Fake ACP agent',
    command: process.execPath,
    args: [FAKE_AGENT, 'acp'],
    speaksAcp: true,
    loggedIn: true,
  });
  center.setEnabled(record.id, true);
  const tools = createAcpControlTools({ center });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const ctx = { workspaceDir: os.tmpdir(), botId: 'test-bot' };
  const run = async (name, args = {}) => byName.get(name).execute(args, ctx);
  return { center, record, tools, byName, run };
}

test('tools: 9 tools, exact names, start + prompt need approval', () => {
  const tools = createAcpControlTools({ center: new AcpControlCenter({}) });
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    [
      'acp_control_discover',
      'acp_control_list',
      'acp_control_register',
      'acp_control_start',
      'acp_control_stop',
      'acp_control_set_budget',
      'acp_control_usage',
      'acp_control_prompt',
      'acp_control_report',
    ],
  );
  const needsApproval = tools.filter((t) => t.needsApproval).map((t) => t.definition.name);
  assert.deepEqual(needsApproval, ['acp_control_start', 'acp_control_prompt']);
  for (const tool of tools) {
    assert.equal(typeof tool.definition.description, 'string');
    assert.ok(tool.definition.description.length > 0);
    assert.equal(tool.definition.parameters.type, 'object');
  }
});

test('tools: unbound placeholders refuse with a clear message', async (t) => {
  for (const tool of ACP_CONTROL_TOOLS) {
    const out = await tool.execute({}, { workspaceDir: os.tmpdir() });
    assert.match(out, /not bound — use createAcpControlTools/);
  }
});

test('tools: discover lists all known backends (PATH-only, no spawn)', async (t) => {
  const { run } = setup(t);
  const out = await run('acp_control_discover');
  for (const id of ['claude', 'codex', 'gemini', 'opencode', 'grok', 'cursor', 'copilot', 'devin', 'zed']) {
    assert.ok(out.includes(id), `discover must list ${id}: ${out}`);
  }
});

test('tools: list shows the registered agent with budget + today usage', async (t) => {
  const { run, record } = setup(t);
  const out = await run('acp_control_list');
  assert.ok(out.includes(record.id));
  assert.ok(out.includes('Fake ACP agent'));
  assert.ok(out.includes('registered'));
  assert.ok(out.includes('no caps'));
  assert.ok(out.includes('Today: 0 tokens'));
});

test('tools: register rejects an unknown backend and a missing one', async (t) => {
  const { run } = setup(t);
  assert.match(await run('acp_control_register', { backendId: 'nope' }), /Error: unknown backend: nope/);
  // claude is (almost certainly) not installed on this CI machine; if it
  // ever is, the test still passes because registration would succeed —
  // so only assert the not-installed branch when discovery says so.
  const discovered = await run('acp_control_discover');
  if (discovered.includes('claude') && discovered.includes('not installed')) {
    assert.match(await run('acp_control_register', { backendId: 'claude' }), /not installed/);
  }
});

test('tools: start spawns the fake agent, usage shows the recorded turn', async (t) => {
  const { run, record, center } = setup(t);
  const started = await run('acp_control_start', { agentId: record.id });
  assert.match(started, /Started Fake ACP agent/);
  assert.match(started, /status: running/);
  const session = await center.newSession(record.id, os.tmpdir());
  await center.prompt(record.id, session.sessionId, 'hello from tools');
  const usage = await run('acp_control_usage', { agentId: record.id });
  assert.ok(usage.includes('Today: 17 tokens (11 in / 6 out)'), usage);
  assert.ok(usage.includes('1 calls'), usage);
  assert.ok(usage.includes('[completed]'), usage);
  const stopped = await run('acp_control_stop', { agentId: record.id });
  assert.match(stopped, /Stopped Fake ACP agent/);
  center.dispose();
});

test('tools: set_budget sets caps, validates, and clears with 0', async (t) => {
  const { run, record } = setup(t);
  const set = await run('acp_control_set_budget', { agentId: record.id, maxTokensPerDay: 1000, maxCallsPerDay: 5 });
  assert.ok(set.includes('tokens/day ≤ 1000'), set);
  assert.ok(set.includes('calls/day ≤ 5'), set);
  assert.ok(set.includes('within budget'), set);
  assert.match(await run('acp_control_set_budget', { agentId: record.id, maxTokensPerDay: -3 }), /Error: invalid budget/);
  assert.match(await run('acp_control_set_budget', { agentId: record.id }), /Error: no budget cap given/);
  assert.match(await run('acp_control_set_budget', { agentId: 'cc-nope', maxTokensPerDay: 10 }), /Error: unknown managed agent/);
  const listed = await run('acp_control_list');
  assert.ok(listed.includes('calls/day ≤ 5'), listed);
  const cleared = await run('acp_control_set_budget', { agentId: record.id, maxTokensPerDay: 0, maxCallsPerDay: 0 });
  assert.ok(cleared.includes('no caps'), cleared);
});

test('tools: start of a disabled agent fails with a readable error', async (t) => {
  const { run, center, record } = setup(t);
  center.setEnabled(record.id, false);
  const out = await run('acp_control_start', { agentId: record.id });
  assert.match(out, /Error: agent Fake ACP agent is disabled/);
  center.dispose();
});

test('tools: usage with no agent id covers all agents; unknown id errors', async (t) => {
  const { run } = setup(t);
  const all = await run('acp_control_usage');
  assert.ok(all.includes('Fake ACP agent'), all);
  assert.match(await run('acp_control_usage', { agentId: 'cc-nope' }), /Error: unknown managed agent: cc-nope/);
  assert.match(await run('acp_control_start', { agentId: 'cc-nope' }), /Error: unknown managed agent: cc-nope/);
  assert.match(await run('acp_control_stop', { agentId: 'cc-nope' }), /Error: unknown managed agent: cc-nope/);
});

test('tools: prompt sends one turn via the running agent (budget-checked)', async (t) => {
  const { run, record, center } = setup(t);
  await run('acp_control_start', { agentId: record.id });
  const out = await run('acp_control_prompt', { agentId: record.id, text: 'hello prompt tool' });
  assert.ok(out.includes('Fake reply to: hello prompt tool'), out);
  assert.ok(out.includes('stop: end_turn'), out);
  assert.ok(out.includes('17 tokens (11 in / 6 out)'), out);
  center.dispose();
});

test('tools: prompt on a stopped agent errors; report shows per-day usage + alerts', async (t) => {
  const { run, record, center } = setup(t);
  assert.match(await run('acp_control_prompt', { agentId: record.id, text: 'x' }), /Error: agent Fake ACP agent is not running/);
  await run('acp_control_start', { agentId: record.id });
  const session = await center.newSession(record.id, os.tmpdir());
  await center.prompt(record.id, session.sessionId, 'one');
  // Push over budget with a tiny cap to produce an alert, then report.
  center.setBudget(record.id, { maxCallsPerDay: 1, stopOnExceed: false });
  const blocked = await run('acp_control_prompt', { agentId: record.id, text: 'two' });
  assert.match(blocked, /Error: budget exceeded/);
  const report = await run('acp_control_report', { agentId: record.id, days: 7 });
  assert.ok(report.includes('Usage report for Fake ACP agent'), report);
  assert.ok(report.includes('2 calls'), report); // 1 completed + 1 blocked turn
  assert.ok(report.includes('Recent budget alerts:'), report);
  assert.ok(report.includes('[blocked]'), report);
  assert.match(await run('acp_control_report', { agentId: 'cc-nope' }), /Error: unknown managed agent/);
  center.dispose();
});

test('tools: list with no agents points at discover', async (t) => {
  const tools = createAcpControlTools({ center: new AcpControlCenter({}) });
  const list = tools.find((t) => t.definition.name === 'acp_control_list');
  const out = await list.execute({}, { workspaceDir: os.tmpdir() });
  assert.match(out, /No managed agents registered yet/);
});
