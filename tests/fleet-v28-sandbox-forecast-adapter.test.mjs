/**
 * Tests for fleet v28 sandbox policy + budget forecast + conversation
 * adapter (v1.41, Team T6).
 *
 * Covers:
 * - Sandbox policy: cgroup derivation from limits (quota/shares/
 *   memory/disk), workspace containment (lexical escape refused,
 *   symlink escape refused, inside allowed), exec validation
 *   (allowlist, blocked patterns in command AND args, cwd escape,
 *   timeout over sandbox/runtime max, secret value in env refused,
 *   non-allowlisted env name refused), watchdog deadline/status
 *   (remaining, overdue, nearly-overdue).
 * - Forecast: burn rate (idle days do not dilute), forecast to a
 *   horizon (reliable only with >= 2 active days), per-model
 *   breakdown (shares sum to 1, unpriced flagged), cap runway
 *   (days until cap, risk low/watch/over), day diff + window days.
 * - Conversation adapter: attach (preset limits + cap applied,
 *   re-attach is a no-op, queued start still attaches), onMessage
 *   (touch + probe), onToolCall (usage recorded, result redacted,
 *   hard cap blocks), onIdle (sweep evicts), onEnd (stop + detach,
 *   meter kept for reports), host errors never break the flow.
 * - Forecast panel + dashboard forecast area.
 * - Runnable tools for the 10 new tools (via createFleetV28Tools).
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v28-sandbox-forecast-adapter.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FLEET_V28_DEFAULT_RUNTIME_LIMITS,
  FleetV28RuntimeStore,
} from '../packages/core/dist/fleetV28/runtime.js';
import { FleetV28SecretStore } from '../packages/core/dist/fleetV28/secrets.js';
import { FleetV28BudgetStore } from '../packages/core/dist/fleetV28/budget.js';
import { FleetV28PresetStore } from '../packages/core/dist/fleetV28/presets.js';
import {
  checkFleetV28WorkspacePath,
  defaultFleetV28SandboxPolicy,
  deriveFleetV28CgroupLimits,
  validateFleetV28ExecEnv,
  validateFleetV28ExecRequest,
  watchdogDeadline,
  watchdogStatus,
} from '../packages/core/dist/fleetV28/sandbox.js';
import {
  breakdownFleetV28ByModel,
  computeFleetV28BurnRate,
  computeFleetV28CapRunways,
  dayDiff,
  fleetV28ForecastRisk,
  fleetV28WindowDays,
  forecastFleetV28Spend,
  summarizeFleetV28Forecast,
} from '../packages/core/dist/fleetV28/forecast.js';
import { FleetV28ConversationAdapter } from '../packages/core/dist/fleetV28/conversationAdapter.js';
import { buildFleetV28ForecastPanel } from '../packages/core/dist/fleetV28/panelsV28.js';
import {
  createEmptyFleetV28ToolState,
  createFleetV28Tools,
} from '../packages/tools/dist/fleetV28Tools.js';

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);

function makeStores() {
  const runtimes = new FleetV28RuntimeStore();
  const secrets = new FleetV28SecretStore();
  const budget = new FleetV28BudgetStore();
  const presets = new FleetV28PresetStore();
  return { runtimes, secrets, budget, presets };
}

function seedBudget(budget, profileId, model, days) {
  // days: [{ day: 'YYYY-MM-DD', in: n, out: n }]
  for (const d of days) {
    const ms = Date.parse(`${d.day}T09:00:00.000Z`);
    budget.recordUsage(`conv-${profileId}-${d.day}`, profileId, model, d.in, d.out, ms);
  }
}

test('sandbox: cgroup derivation from limits', () => {
  const c = deriveFleetV28CgroupLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS });
  assert.equal(c.cpuPeriodUs, 100000);
  assert.equal(c.cpuQuotaUs, 100000, '1 core = full period quota');
  assert.equal(c.cpuShares, 1024);
  assert.equal(c.memoryMaxBytes, 2048 * 1024 * 1024);
  assert.equal(c.diskQuotaBytes, 5120 * 1024 * 1024);
  const half = deriveFleetV28CgroupLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, cpuCores: 0.5, ramMB: 512, diskMB: 1024 });
  assert.equal(half.cpuQuotaUs, 50000);
  assert.equal(half.cpuShares, 512);
  assert.equal(half.memoryMaxBytes, 512 * 1024 * 1024);
  const tiny = deriveFleetV28CgroupLimits({ ...FLEET_V28_DEFAULT_RUNTIME_LIMITS, cpuCores: 0.01 });
  assert.equal(tiny.cpuQuotaUs, 1000, 'quota floors at 1000µs');
  assert.ok(tiny.cpuShares >= 2, 'shares floor at 2');
});

test('sandbox: workspace containment (lexical + symlink)', () => {
  const root = mkdtempSync(join(tmpdir(), 'v28-ws-'));
  const sub = join(root, 'proj');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'a.txt'), 'hello');
  // Inside: allowed.
  assert.equal(checkFleetV28WorkspacePath(root, join(sub, 'a.txt')).allowed, true);
  assert.equal(checkFleetV28WorkspacePath(root, sub).allowed, true);
  assert.equal(checkFleetV28WorkspacePath(root, root).allowed, true);
  // Lexical escape: refused.
  assert.equal(checkFleetV28WorkspacePath(root, '../outside.txt').allowed, false);
  assert.equal(checkFleetV28WorkspacePath(root, '/etc/passwd').allowed, false);
  // Symlink escape: a link inside the root pointing outside is refused.
  const outside = mkdtempSync(join(tmpdir(), 'v28-out-'));
  writeFileSync(join(outside, 'secret.txt'), 'x');
  symlinkSync(join(outside, 'secret.txt'), join(sub, 'link.txt'));
  const viaLink = checkFleetV28WorkspacePath(root, join(sub, 'link.txt'));
  assert.equal(viaLink.allowed, false, 'symlink escaping the root is refused');
  assert.ok(viaLink.reasons.join(' ').includes('symlink'));
  // Non-existent path inside: allowed (lexical check on nearest ancestor).
  assert.equal(checkFleetV28WorkspacePath(root, join(sub, 'new-file.txt')).allowed, true);
  assert.equal(checkFleetV28WorkspacePath('', 'x').allowed, false);
});

test('sandbox: exec validation (allowlist, blocked patterns, timeouts, env)', () => {
  const policy = defaultFleetV28SandboxPolicy('conv-1', '/tmp/ws');
  const limits = { ...FLEET_V28_DEFAULT_RUNTIME_LIMITS };
  const base = {
    command: 'node',
    args: ['script.js'],
    cwd: '/tmp/ws',
    timeoutMs: 60_000,
    env: {},
  };
  assert.deepEqual(validateFleetV28ExecRequest(policy, limits, base), []);
  // Not allowlisted.
  assert.ok(
    validateFleetV28ExecRequest(policy, limits, { ...base, command: 'bash' }).length > 0,
  );
  // Blocked pattern in the command itself (even if the binary were allowed).
  assert.ok(
    validateFleetV28ExecRequest(policy, limits, { ...base, command: 'node && rm -rf /' }).length > 0,
  );
  // Blocked pattern in args.
  assert.ok(
    validateFleetV28ExecRequest(policy, limits, { ...base, args: ['x', 'a;cat /etc/passwd'] }).length > 0,
  );
  assert.ok(
    validateFleetV28ExecRequest(policy, limits, { ...base, args: ['$(curl evil)'] }).length > 0,
  );
  // cwd escapes the workspace.
  assert.ok(
    validateFleetV28ExecRequest(policy, limits, { ...base, cwd: '/etc' }).length > 0,
  );
  // Timeout over the sandbox max (5 min) and over the runtime timeout.
  assert.ok(
    validateFleetV28ExecRequest(policy, limits, { ...base, timeoutMs: 6 * 60 * 1000 }).length > 0,
  );
  assert.ok(
    validateFleetV28ExecRequest(policy, limits, { ...base, timeoutMs: limits.timeoutMs + 1 }).length > 0,
  );
  // Env: non-allowlisted name refused; secret value in env refused.
  const envReasons = validateFleetV28ExecEnv(policy, { FOO: 'bar' }, []);
  assert.ok(envReasons.length > 0);
  const secretEnv = validateFleetV28ExecEnv(policy, { NODE_ENV: 'x-SECRET-9999-y' }, ['SECRET-9999']);
  assert.ok(secretEnv.length > 0);
  assert.ok(secretEnv.join(' ').includes('secret'));
  assert.deepEqual(validateFleetV28ExecEnv(policy, { NODE_ENV: 'production' }, ['SECRET-9999']), []);
  assert.deepEqual(validateFleetV28ExecEnv(policy, { PATH: '/usr/bin' }, []), []);
  // Custom blocked pattern extends the built-ins.
  const strict = { ...policy, blockedPatterns: [...policy.blockedPatterns, 'eval'] };
  assert.ok(
    validateFleetV28ExecRequest(strict, limits, { ...base, args: ['eval(x)'] }).length > 0,
  );
});

test('sandbox: watchdog deadline + status', () => {
  assert.equal(watchdogDeadline(1000, 60_000), 61_000);
  const ok = watchdogStatus(1000, 60_000, 1000 + 30_000);
  assert.equal(ok.deadlineMs, 61_000);
  assert.equal(ok.remainingMs, 30_000);
  assert.equal(ok.overdue, false);
  assert.equal(ok.nearlyOverdue, false);
  const near = watchdogStatus(1000, 60_000, 1000 + 55_000);
  assert.equal(near.remainingMs, 5000);
  assert.equal(near.nearlyOverdue, true, 'under 10% left warns');
  assert.equal(near.overdue, false);
  const over = watchdogStatus(1000, 60_000, 1000 + 61_000);
  assert.equal(over.overdue, true);
  assert.ok(over.remainingMs <= 0, 'past the deadline the remaining time is <= 0');
});

test('forecast: burn rate ignores idle days; forecast needs history', () => {
  const { budget } = makeStores();
  seedBudget(budget, 'profile-a', 'gpt-4o-mini', [
    { day: '2026-11-16', in: 100000, out: 0 },
    { day: '2026-11-18', in: 100000, out: 0 },
  ]);
  const entries = budget.listEntries({ profileId: 'profile-a' });
  const rate = computeFleetV28BurnRate('profile-a', entries, '2026-11-16', '2026-11-18');
  assert.equal(rate.activeDays, 2, 'only days with spend count');
  assert.equal(rate.totalCostUsd, 0.03, '2 x 100k input tokens at 0.00015/1k');
  assert.equal(rate.costPerDayUsd, 0.015, 'idle 17th does NOT dilute the rate');
  assert.equal(rate.reliable, true);
  const forecast = forecastFleetV28Spend(rate, '2026-11-30');
  assert.equal(forecast.daysRemaining, 12);
  assert.equal(forecast.projectedAdditionalUsd, 0.18);
  assert.equal(forecast.projectedTotalUsd, 0.21);
  assert.equal(forecast.reliable, true);
  assert.equal(forecast.note, null);
  assert.ok(summarizeFleetV28Forecast(forecast).includes('$0.2100'));
  // One active day: unreliable forecast says so instead of inventing.
  const thin = computeFleetV28BurnRate('profile-a', entries, '2026-11-16', '2026-11-16');
  assert.equal(thin.reliable, false);
  assert.ok(forecastFleetV28Spend(thin, '2026-11-30').note?.includes('1 active day'));
  // Empty window: zero rate, unreliable.
  const empty = computeFleetV28BurnRate('profile-a', entries, '2026-11-01', '2026-11-02');
  assert.equal(empty.activeDays, 0);
  assert.equal(empty.costPerDayUsd, 0);
  assert.equal(empty.reliable, false);
  assert.equal(dayDiff('2026-11-16', '2026-11-30'), 14);
  assert.deepEqual(fleetV28WindowDays('2026-11-16', '2026-11-18'), ['2026-11-16', '2026-11-17', '2026-11-18']);
  assert.equal(fleetV28ForecastRisk(0.5, 1), 'low');
  assert.equal(fleetV28ForecastRisk(0.7, 1), 'watch');
  assert.equal(fleetV28ForecastRisk(1.2, 1), 'over');
  assert.equal(fleetV28ForecastRisk(999, null), 'low');
});

test('forecast: per-model breakdown + cap runway', () => {
  const { budget } = makeStores();
  budget.ensureMeter('conv-1', 'profile-a', { capUsd: 1, nowMs: T0 });
  budget.ensureMeter('conv-2', 'profile-a', { capUsd: 0.05, nowMs: T0 });
  seedBudget(budget, 'profile-a', 'gpt-4o-mini', [
    { day: '2026-11-16', in: 100000, out: 50000 },
    { day: '2026-11-17', in: 100000, out: 50000 },
  ]);
  // A second model on another conversation, same profile.
  budget.recordUsage('conv-2', 'profile-a', 'gpt-4o', 1000, 500, Date.parse('2026-11-17T09:00:00.000Z'));
  const entries = budget.listEntries({ profileId: 'profile-a' });
  const rows = breakdownFleetV28ByModel(entries, '2026-11-16', '2026-11-17');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, 'gpt-4o-mini');
  assert.equal(rows[0].records, 2);
  assert.equal(rows[0].estimated, false);
  const shareSum = Math.round(rows.reduce((s, r) => s + r.share, 0) * 1000) / 1000;
  assert.equal(shareSum, 1, 'shares sum to 1');
  // Unpriced model rows are flagged estimated.
  budget.recordUsage('conv-9', 'profile-a', 'mystery-model', 1000, 1000, Date.parse('2026-11-17T10:00:00.000Z'));
  const rows2 = breakdownFleetV28ByModel(budget.listEntries({ profileId: 'profile-a' }), '2026-11-16', '2026-11-17');
  assert.equal(rows2.find((r) => r.model === 'mystery-model')?.estimated, true);

  const runways = computeFleetV28CapRunways(budget, '2026-11-16', '2026-11-17');
  assert.equal(runways.length, 2, 'only capped meters get a runway');
  const conv2 = runways.find((r) => r.conversationId === 'conv-2');
  assert.ok(conv2);
  assert.equal(conv2.capUsd, 0.05);
  assert.ok((conv2.daysUntilCap ?? 99) < 5, 'small cap + real burn = short runway');
  assert.equal(conv2.risk, 'over', '30-day projection at this burn blows the $0.05 cap');
});

test('forecast panel: joins burn, forecast, runway, models', () => {
  const { budget } = makeStores();
  seedBudget(budget, 'profile-a', 'gpt-4o-mini', [
    { day: '2026-11-16', in: 100000, out: 0 },
    { day: '2026-11-17', in: 100000, out: 0 },
  ]);
  const panel = buildFleetV28ForecastPanel(budget, {
    windowStart: '2026-11-16',
    windowEnd: '2026-11-17',
    horizon: '2026-11-30',
  });
  assert.equal(panel.burnRates.length, 1);
  assert.equal(panel.forecasts.length, 1);
  assert.equal(panel.forecasts[0].projectedTotalUsd, 0.225, 'spent 0.03 + 13 days x 0.015');
  assert.equal(panel.models.length, 1);
  assert.ok(panel.summary.includes('2026-11-30'));
  const filtered = buildFleetV28ForecastPanel(budget, {
    windowStart: '2026-11-16',
    windowEnd: '2026-11-17',
    horizon: '2026-11-30',
    profileId: 'profile-nope',
  });
  assert.equal(filtered.burnRates.length, 0);
});

test('adapter: attach/message/toolcall/idle/end full loop', () => {
  const { runtimes, secrets, budget, presets } = makeStores();
  presets.setPreset('profile-a', 'small', { nowMs: T0 });
  secrets.setSecret('profile-a', 'api-key', 'ADAPTER-SECRET-123', T0);
  const adapter = new FleetV28ConversationAdapter(runtimes, secrets, budget, presets);
  assert.equal(adapter.isAttached('conv-1'), false);

  const attached = adapter.attachConversation('conv-1', 'profile-a', { botId: 'bot-1', nowMs: T0 });
  assert.equal(attached.ok, true);
  assert.equal(attached.attachment?.presetName, 'small');
  assert.equal(attached.attachment?.capUsd, 1, 'small preset cap $1 applied to the meter');
  assert.equal(attached.runtime?.state, 'running');
  assert.equal(attached.runtime?.limits.cpuCores, 0.5, 'small preset limits applied');
  assert.equal(budget.getMeter('conv-1')?.capUsd, 1);
  assert.equal(adapter.isAttached('conv-1'), true);
  // Re-attach is a no-op.
  assert.equal(adapter.attachConversation('conv-1', 'profile-a', { nowMs: T0 }).ok, true);
  assert.equal(adapter.listAttachments().length, 1);

  // Message: counts + touches the runtime (idle clock resets).
  const msg = adapter.onMessage('conv-1', { healthy: true, nowMs: T0 + 1000 });
  assert.equal(msg.ok, true);
  assert.equal(adapter.getAttachment('conv-1')?.messages, 1);
  assert.equal(runtimes.getRuntime('conv-1')?.health, 'ok');
  assert.equal(adapter.onMessage('conv-missing', { nowMs: T0 }).ok, false);

  // Tool call: usage recorded, secret redacted from the result.
  const call = adapter.onToolCall('conv-1', {
    model: 'gpt-4o-mini',
    inputTokens: 10000,
    outputTokens: 5000,
    resultText: 'key is ADAPTER-SECRET-123, done',
    nowMs: T0 + 2000,
  });
  assert.equal(call.ok, true);
  assert.equal(call.accepted, true);
  assert.equal(call.costUsd, 0.0045);
  assert.equal(call.redactedResult, 'key is [REDACTED], done');
  assert.equal(call.redactedCount, 1);
  assert.equal(adapter.getAttachment('conv-1')?.toolCalls, 1);
  assert.equal(budget.getMeter('conv-1')?.costUsd, 0.0045);

  // Hard cap blocks: $1 cap, record ~$15 of usage -> refused.
  const blocked = adapter.onToolCall('conv-1', {
    model: 'gpt-4o',
    inputTokens: 1000000,
    outputTokens: 1000000,
    resultText: 'too expensive',
    nowMs: T0 + 3000,
  });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.blocked, true);
  assert.equal(adapter.getAttachment('conv-1')?.blockedToolCalls, 1);
  assert.equal(budget.getMeter('conv-1')?.costUsd, 0.0045, 'blocked record leaves the meter unchanged');

  // Idle sweep evicts when past the small preset idle timeout (5 min).
  const idle = adapter.onIdle(T0 + 6 * 60 * 1000);
  assert.deepEqual(idle.evicted, ['conv-1']);
  assert.equal(runtimes.getRuntime('conv-1')?.state, 'evicted');

  // End: stops + detaches; the meter stays for reports.
  adapter.attachConversation('conv-2', 'profile-a', { nowMs: T0 });
  const ended = adapter.onEnd('conv-2', T0 + 1000);
  assert.equal(ended.ok, true);
  assert.equal(adapter.isAttached('conv-2'), false);
  assert.equal(runtimes.getRuntime('conv-2')?.state, 'stopped');
  assert.equal(budget.getMeter('conv-1')?.costUsd, 0.0045);
  assert.equal(adapter.onEnd('conv-missing').ok, false);
});

test('adapter: queued start still attaches; host errors never break the flow', () => {
  const { runtimes, secrets, budget, presets } = makeStores();
  const capped = new FleetV28RuntimeStore({ maxConcurrentRuntimes: 1 });
  capped.startRuntime('conv-busy', 'profile-a', { nowMs: T0 });
  const adapter = new FleetV28ConversationAdapter(capped, secrets, budget, presets);
  const attached = adapter.attachConversation('conv-1', 'profile-a', { nowMs: T0 });
  assert.equal(attached.ok, true, 'queued start still attaches');
  assert.equal(capped.listQueue().length, 1);

  const throwingHost = {
    enforceLimits() {
      throw new Error('host cgroup write failed');
    },
    destroyRuntime() {
      throw new Error('host destroy failed');
    },
  };
  const adapter2 = new FleetV28ConversationAdapter(runtimes, secrets, budget, presets, throwingHost);
  const a2 = adapter2.attachConversation('conv-9', 'profile-a', { nowMs: T0 });
  assert.equal(a2.ok, true);
  assert.deepEqual(a2.hostErrors, ['host cgroup write failed'], 'host failure is reported, not thrown');
  const end = adapter2.onEnd('conv-9', T0 + 1000);
  assert.equal(end.ok, true);
  assert.deepEqual(end.hostErrors, ['host destroy failed']);
  // Null host = decide-only, no errors.
  const adapter3 = new FleetV28ConversationAdapter(runtimes, secrets, budget, presets, null);
  assert.deepEqual(adapter3.attachConversation('conv-10', 'profile-a', { nowMs: T0 }).hostErrors, []);
});

test('tools v28: new sandbox/forecast/conversation tools', async () => {
  const state = createEmptyFleetV28ToolState();
  const tools = createFleetV28Tools(() => state);
  const run = async (name, args = {}) => {
    const tool = tools.find((t) => t.definition.name === name);
    assert.ok(tool, `tool ${name} must exist`);
    return tool.execute(args);
  };
  const asJson = (out) => {
    assert.ok(!out.startsWith('Error:'), `expected JSON, got ${out}`);
    return JSON.parse(out);
  };

  const policy = asJson(await run('fleet_v28_sandbox_policy', { conversationId: 'conv-1', workspaceRoot: '/tmp/ws' }));
  assert.equal(policy.cgroup.cpuShares, 1024);
  assert.equal(policy.policy.workspaceRoot, '/tmp/ws');
  const pathOk = asJson(await run('fleet_v28_sandbox_validate_path', { workspaceRoot: '/tmp/ws', targetPath: '/tmp/ws/a.txt' }));
  assert.equal(pathOk.allowed, true);
  const pathBad = asJson(await run('fleet_v28_sandbox_validate_path', { workspaceRoot: '/tmp/ws', targetPath: '/etc/passwd' }));
  assert.equal(pathBad.allowed, false);
  const cmdOk = asJson(await run('fleet_v28_sandbox_validate_command', {
    conversationId: 'conv-1', workspaceRoot: '/tmp/ws', command: 'node', args: ['x.js'], cwd: '/tmp/ws', timeoutMs: 1000,
  }));
  assert.equal(cmdOk.allowed, true);
  const cmdBad = asJson(await run('fleet_v28_sandbox_validate_command', {
    conversationId: 'conv-1', workspaceRoot: '/tmp/ws', command: 'curl', args: [], cwd: '/tmp/ws', timeoutMs: 1000,
  }));
  assert.equal(cmdBad.allowed, false);
  const watchdog = asJson(await run('fleet_v28_sandbox_watchdog', { startedAtMs: 1000, timeoutMs: 60000 }));
  assert.equal(watchdog.deadlineMs, 61000);

  // Forecast tools need entries: record two days of spend first.
  state.budget.recordUsage('conv-a', 'profile-a', 'gpt-4o-mini', 100000, 0, Date.parse('2026-11-16T09:00:00.000Z'));
  state.budget.recordUsage('conv-b', 'profile-a', 'gpt-4o-mini', 100000, 0, Date.parse('2026-11-17T09:00:00.000Z'));
  const forecast = asJson(await run('fleet_v28_budget_forecast', {
    profileId: 'profile-a', windowStart: '2026-11-16', windowEnd: '2026-11-17', horizon: '2026-11-30',
  }));
  assert.equal(forecast.forecast.projectedTotalUsd, 0.225);
  assert.equal(forecast.burnRate.reliable, true);
  const burn = asJson(await run('fleet_v28_budget_burn_rate', {
    profileId: 'profile-a', windowStart: '2026-11-16', windowEnd: '2026-11-17',
  }));
  assert.equal(burn.burnRate.costPerDayUsd, 0.015);
  const models = asJson(await run('fleet_v28_budget_model_breakdown', {
    windowStart: '2026-11-16', windowEnd: '2026-11-17',
  }));
  assert.equal(models.models.length, 1);
  const badDate = await run('fleet_v28_budget_forecast', {
    profileId: 'profile-a', windowStart: '16/11/2026', windowEnd: '2026-11-17', horizon: '2026-11-30',
  });
  assert.ok(badDate.startsWith('Error:'));

  // Conversation tools: attach + event + list.
  const attached = asJson(await run('fleet_v28_conversation_attach', { conversationId: 'conv-1', profileId: 'profile-a' }));
  assert.equal(attached.attached, true);
  assert.equal(attached.attachment.presetName, 'medium');
  const listed = asJson(await run('fleet_v28_conversation_list', {}));
  assert.equal(listed.attachments.length, 1);
  const ev = asJson(await run('fleet_v28_conversation_event', { conversationId: 'conv-1', kind: 'message', healthy: true }));
  assert.equal(ev.ok, true);
  const call = asJson(await run('fleet_v28_conversation_event', {
    conversationId: 'conv-1', kind: 'toolcall', model: 'gpt-4o-mini',
    inputTokens: 1000, outputTokens: 500, resultText: 'done',
  }));
  assert.equal(call.accepted, true);
  const unknown = await run('fleet_v28_conversation_event', { conversationId: 'conv-1', kind: 'dance' });
  assert.ok(unknown.startsWith('Error:'));
  const ended = asJson(await run('fleet_v28_conversation_event', { conversationId: 'conv-1', kind: 'end' }));
  assert.equal(ended.ok, true);
  assert.equal(asJson(await run('fleet_v28_conversation_list', {})).attachments.length, 0);
});
