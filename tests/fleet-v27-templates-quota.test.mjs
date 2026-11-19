/**
 * Tests for fleet v27 automation templates + quota v2 (v1.40, Team T6).
 *
 * Covers:
 * - Cron: presets, 5-field validation, lists/ranges/steps, next-run
 *   calculation (local time), human description.
 * - Templates: catalog (8), find/list by category, task rendering.
 * - Suggestions: ranked for the repo/bot context, with reasons.
 * - Automation store: create from template (param defaults, missing
 *   required param, bad cron), enable/disable/remove, due checks,
 *   mark-ran recomputes next run, JSON round-trip.
 * - Quota v2: alerts (warn 80% / critical 95%), evaluate admit /
 *   queue / defer / reject with reasons, policy per resource, disk
 *   unknown refused, queue enqueue/promote/expire, ledger bounded,
 *   limits validation, JSON round-trip.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v27-templates-quota.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V27_TEMPLATES,
  FleetV27AutomationStore,
  describeFleetV27Cron,
  findFleetV27Template,
  listFleetV27Templates,
  nextFleetV27CronRunMs,
  parseFleetV27Cron,
  renderFleetV27TaskText,
  suggestFleetV27Templates,
  validateFleetV27Cron,
} from '../packages/core/dist/fleetV27/templates.js';
import {
  FLEET_V27_DEFAULT_LIMITS,
  FLEET_V27_DEFAULT_POLICY,
  FleetV27QuotaStore,
  checkFleetV27QuotaAlerts,
  evaluateFleetV27Quota,
  fleetV27AlertLevelForRatio,
  validateFleetV27Limits,
} from '../packages/core/dist/fleetV27/quotaV2.js';

const T0 = new Date(2026, 10, 18, 7, 0, 0).getTime(); // Wed 2026-11-18 07:00 local

test('templates v27: cron presets + validation', () => {
  assert.equal(validateFleetV27Cron('daily-08-00').valid, true);
  assert.equal(validateFleetV27Cron('daily-08-00').preset, 'daily-08-00');
  assert.equal(validateFleetV27Cron('0 8 * * *').valid, true);
  assert.equal(validateFleetV27Cron('0 8 * * *').preset, null);
  assert.equal(validateFleetV27Cron('*/15 * * * *').valid, true);
  assert.equal(validateFleetV27Cron('0 8-17 * * 1-5').valid, true);
  assert.equal(validateFleetV27Cron('0 8,12,18 * * *').valid, true);
  assert.equal(validateFleetV27Cron('').valid, false);
  assert.equal(validateFleetV27Cron('not a cron').valid, false);
  assert.equal(validateFleetV27Cron('0 8 * *').valid, false); // 4 fields
  assert.equal(validateFleetV27Cron('60 8 * * *').valid, false); // minute 60
  assert.equal(validateFleetV27Cron('0 24 * * *').valid, false); // hour 24
  assert.equal(validateFleetV27Cron('0 8 32 * *').valid, false); // dom 32
  assert.equal(validateFleetV27Cron('0 8 * * 8').valid, false); // dow 8
  assert.equal(parseFleetV27Cron('daily-08-00')?.hour, '8');
  assert.equal(parseFleetV27Cron('garbage'), null);
  assert.equal(describeFleetV27Cron(parseFleetV27Cron('daily-08-00')), 'preset daily-08-00 (0 8 * * *)');
  assert.ok(describeFleetV27Cron(parseFleetV27Cron('15 3 * * *')).includes('15 3'));
});

test('templates v27: next run is the next matching minute (local time)', () => {
  const daily8 = parseFleetV27Cron('0 8 * * *');
  assert.equal(nextFleetV27CronRunMs(daily8, T0), new Date(2026, 10, 18, 8, 0, 0).getTime());
  // After 08:00 the next run is tomorrow 08:00.
  const after8 = new Date(2026, 10, 18, 8, 30, 0).getTime();
  assert.equal(nextFleetV27CronRunMs(daily8, after8), new Date(2026, 10, 19, 8, 0, 0).getTime());
  // Weekly Monday 08:00 from Wed 07:00 -> next Monday.
  const monday = parseFleetV27Cron('0 8 * * 1');
  assert.equal(nextFleetV27CronRunMs(monday, T0), new Date(2026, 10, 23, 8, 0, 0).getTime());
  // Hourly: next top of the hour.
  const hourly = parseFleetV27Cron('0 * * * *');
  assert.equal(nextFleetV27CronRunMs(hourly, T0), new Date(2026, 10, 18, 8, 0, 0).getTime());
  // Every 15 minutes.
  const quarter = parseFleetV27Cron('*/15 * * * *');
  assert.equal(nextFleetV27CronRunMs(quarter, T0), new Date(2026, 10, 18, 7, 15, 0).getTime());
});

test('templates v27: catalog + find + list + render', () => {
  assert.equal(FLEET_V27_TEMPLATES.length, 8);
  assert.equal(new Set(FLEET_V27_TEMPLATES.map((t) => t.id)).size, 8);
  assert.equal(findFleetV27Template('pr-review-morning')?.category, 'review');
  assert.equal(findFleetV27Template('nope'), undefined);
  assert.equal(listFleetV27Templates('memory').length, 1);
  assert.equal(listFleetV27Templates('maintenance').length, 2);
  assert.equal(listFleetV27Templates().length, 8);
  for (const t of FLEET_V27_TEMPLATES) {
    assert.equal(validateFleetV27Cron(t.defaultCron).valid, true, `${t.id} default cron must be valid`);
    assert.ok(t.defaultTask.length > 0);
    assert.ok(t.name.length > 0);
  }
  assert.equal(
    renderFleetV27TaskText('Review {repo} for {bot}.', { repo: '/x', bot: 'b1' }),
    'Review /x for b1.',
  );
  assert.equal(renderFleetV27TaskText('Hello {missing}.', {}), 'Hello {missing}.');
});

test('templates v27: suggestions rank the right template first', () => {
  const ranked = suggestFleetV27Templates(
    { repoPath: '/home/hatch/workspace/open-bot', hasGit: true, botTags: ['review', 'coding'], botCount: 3, capabilities: ['git', 'repo-read'], hourOfDay: 8 },
    3,
  );
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].templateId, 'pr-review-morning');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].reasons.some((r) => r.includes('review')));
  // A memory bot context surfaces the nightly digest near the top.
  const mem = suggestFleetV27Templates(
    { botTags: ['memory'], botCount: 4, capabilities: ['memory-read', 'memory-write'], hourOfDay: 21 },
    8,
  );
  assert.ok(mem.slice(0, 3).some((s) => s.templateId === 'memory-digest-nightly'));
  // Scores stay in 0..100 and are deterministic.
  for (const s of mem) assert.ok(s.score >= 0 && s.score <= 100);
  assert.deepEqual(
    suggestFleetV27Templates({ botTags: ['review'] }, 2).map((s) => s.templateId),
    suggestFleetV27Templates({ botTags: ['review'] }, 2).map((s) => s.templateId),
  );
});

test('templates v27: automation store create/enable/due/mark-ran', () => {
  const store = new FleetV27AutomationStore();
  // Unknown template refused.
  assert.equal(store.createFromTemplate({ templateId: 'nope', botId: 'b1' }).ok, false);
  // Missing bot refused.
  assert.equal(store.createFromTemplate({ templateId: 'pr-review-morning', botId: '  ' }).ok, false);
  // Bad cron refused.
  assert.equal(store.createFromTemplate({ templateId: 'pr-review-morning', botId: 'b1', cron: 'nope' }).ok, false);
  // Missing required param (memory digest needs a bot param with no default).
  const missing = store.createFromTemplate({ templateId: 'memory-digest-nightly', botId: 'b1', params: {} });
  assert.equal(missing.ok, false);
  assert.ok(missing.reasons.includes('missing-param'));
  // Happy path: repo param defaults to '.', task rendered.
  const created = store.createFromTemplate({
    templateId: 'pr-review-morning', botId: 'bot-review', repoPath: '/home/hatch/workspace/open-bot', createdAtMs: T0,
  });
  assert.equal(created.ok, true, created.reasons.join(','));
  assert.equal(created.automation.id, 'auto-0001');
  assert.equal(created.automation.enabled, true);
  assert.equal(created.automation.params.repo, '.');
  assert.ok(created.automation.taskText.includes('/home/hatch/workspace/open-bot'));
  assert.equal(created.automation.nextRunAtMs, new Date(2026, 10, 18, 8, 0, 0).getTime());
  // Not due before 08:00, due at 08:00.
  assert.equal(store.dueAutomations(T0).length, 0);
  assert.equal(store.dueAutomations(new Date(2026, 10, 18, 8, 0, 0).getTime()).length, 1);
  // Mark ran: count bumps, next run moves to tomorrow.
  const ran = store.markRan('auto-0001', new Date(2026, 10, 18, 8, 0, 0).getTime());
  assert.equal(ran.runCount, 1);
  assert.equal(ran.lastRunAtMs, new Date(2026, 10, 18, 8, 0, 0).getTime());
  assert.equal(ran.nextRunAtMs, new Date(2026, 10, 19, 8, 0, 0).getTime());
  // Disable: no longer due.
  assert.equal(store.setEnabled('auto-0001', false), true);
  assert.equal(store.dueAutomations(new Date(2026, 10, 19, 8, 0, 0).getTime()).length, 0);
  assert.equal(store.setEnabled('nope', false), false);
  assert.equal(store.listAutomations({ botId: 'bot-review' }).length, 1);
  assert.equal(store.listAutomations({ enabled: true }).length, 0);
  assert.equal(store.getAutomation('auto-0001')?.name, 'Review PRs every morning');
  assert.equal(store.markRan('nope'), null);
  assert.equal(store.removeAutomation('auto-0001'), true);
  assert.equal(store.removeAutomation('auto-0001'), false);
});

test('templates v27: automation store JSON round-trip', () => {
  const store = new FleetV27AutomationStore();
  store.createFromTemplate({ templateId: 'fleet-health-hourly', botId: 'bot-ops', createdAtMs: T0 });
  const restored = FleetV27AutomationStore.fromJSON(store.toJSON());
  assert.equal(restored.listAutomations().length, 1);
  const again = restored.createFromTemplate({ templateId: 'backup-weekly', botId: 'bot-ops', createdAtMs: T0 });
  assert.equal(again.automation.id, 'auto-0002'); // sequence preserved
});

test('quota v2: alert levels at 80% warn / 95% critical', () => {
  assert.equal(fleetV27AlertLevelForRatio(0.5), 'ok');
  assert.equal(fleetV27AlertLevelForRatio(0.8), 'warn');
  assert.equal(fleetV27AlertLevelForRatio(0.94), 'warn');
  assert.equal(fleetV27AlertLevelForRatio(0.95), 'critical');
  assert.equal(fleetV27AlertLevelForRatio(null), 'ok');
  const alerts = checkFleetV27QuotaAlerts(
    { ...FLEET_V27_DEFAULT_LIMITS },
    { cpuCores: 4, ramMB: 8192, diskMB: 51200, runningBots: 8, activeCampaigns: 4, runsToday: 50, totalBots: 50 },
  );
  assert.equal(alerts.length, 7);
  assert.ok(alerts.every((a) => a.level === 'critical'));
  const half = checkFleetV27QuotaAlerts(
    { ...FLEET_V27_DEFAULT_LIMITS },
    { cpuCores: 2, ramMB: 4096, diskMB: 25600, runningBots: 4, activeCampaigns: 2, runsToday: 25, totalBots: 25 },
  );
  assert.ok(half.every((a) => a.level === 'ok'));
  // Unknown disk warns instead of guessing.
  const unknown = checkFleetV27QuotaAlerts(
    { ...FLEET_V27_DEFAULT_LIMITS, diskMB: null },
    { cpuCores: 0, ramMB: 0, diskMB: 0, runningBots: 0, activeCampaigns: 0, runsToday: 0, totalBots: 0 },
  );
  assert.equal(unknown.find((a) => a.resource === 'disk').level, 'warn');
  assert.equal(unknown.find((a) => a.resource === 'disk').ratio, null);
});

test('quota v2: evaluate admit / queue / defer / reject with reasons', () => {
  const usage = { cpuCores: 3, ramMB: 6000, diskMB: 10000, runningBots: 7, activeCampaigns: 3, runsToday: 49, totalBots: 10 };
  // Fits: admitted.
  const admit = evaluateFleetV27Quota(FLEET_V27_DEFAULT_LIMITS, usage, { kind: 'bot-start', cpuCores: 0.5, ramMB: 512, extraRunningBots: 1 });
  assert.equal(admit.decision, 'admit');
  assert.deepEqual(admit.reasons, ['ok']);
  assert.equal(admit.usageAfter.runningBots, 8);
  // CPU over the limit: default policy queues.
  const cpu = evaluateFleetV27Quota(FLEET_V27_DEFAULT_LIMITS, usage, { kind: 'bot-start', cpuCores: 2, extraRunningBots: 2 });
  assert.equal(cpu.decision, 'queue');
  assert.ok(cpu.reasons.includes('cpu-over-limit'));
  assert.ok(cpu.reasons.includes('concurrent-bots-over-limit'));
  assert.equal(cpu.usageAfter, null);
  // Daily runs over the cap: default policy defers.
  const runs = evaluateFleetV27Quota(FLEET_V27_DEFAULT_LIMITS, usage, { kind: 'campaign-run', extraRunsToday: 2 });
  assert.equal(runs.decision, 'defer');
  assert.ok(runs.reasons.includes('runs-today-over-limit'));
  // Disk unknown + disk needed: rejected (never guessed).
  const disk = evaluateFleetV27Quota({ ...FLEET_V27_DEFAULT_LIMITS, diskMB: null }, usage, { kind: 'bot-start', diskMB: 100 });
  assert.equal(disk.decision, 'reject');
  assert.ok(disk.reasons.includes('disk-unknown'));
  // Total bots over the cap: rejected.
  const total = evaluateFleetV27Quota(FLEET_V27_DEFAULT_LIMITS, usage, { kind: 'bot-register', extraTotalBots: 41 });
  assert.equal(total.decision, 'reject');
  assert.ok(total.reasons.includes('total-bots-over-limit'));
  // Invalid request (negative amount) is rejected.
  const bad = evaluateFleetV27Quota(FLEET_V27_DEFAULT_LIMITS, usage, { kind: 'bot-start', cpuCores: -1 });
  assert.equal(bad.decision, 'reject');
  assert.deepEqual(bad.reasons, ['invalid-request']);
  // Policy override: CPU exhaustion rejects when the operator says so.
  const strict = evaluateFleetV27Quota(
    FLEET_V27_DEFAULT_LIMITS, usage,
    { kind: 'bot-start', cpuCores: 2 },
    { ...FLEET_V27_DEFAULT_POLICY, onCpuExhausted: 'reject' },
  );
  assert.equal(strict.decision, 'reject');
});

test('quota v2: store evaluate applies usage, queue, promote, expire, ledger', () => {
  const store = new FleetV27QuotaStore();
  assert.deepEqual(store.getLimits(), FLEET_V27_DEFAULT_LIMITS);
  assert.deepEqual(store.getPolicy(), FLEET_V27_DEFAULT_POLICY);
  // Admitted evaluation applies the usage.
  const ok = store.evaluate({ kind: 'bot-start', cpuCores: 1, ramMB: 1024, extraRunningBots: 1 }, T0);
  assert.equal(ok.decision, 'admit');
  assert.equal(store.getUsage().runningBots, 1);
  // Fill the fleet, then a further bot-start queues (policy) — enqueue it.
  store.setUsage({ cpuCores: 4, ramMB: 8192, runningBots: 8 });
  const queued = store.evaluate({ kind: 'bot-start', cpuCores: 0.5, extraRunningBots: 1 }, T0 + 1000);
  assert.equal(queued.decision, 'queue');
  const enq = store.enqueue({ kind: 'bot-start', cpuCores: 0.5, extraRunningBots: 1 }, T0 + 1000);
  assert.equal(enq.ok, true);
  assert.equal(enq.entry.position, 0);
  assert.equal(store.listQueue().length, 1);
  // Still blocked while full: promote refuses, entry stays.
  const blocked = store.promoteHead(T0 + 2000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'still-blocked');
  assert.equal(store.listQueue().length, 1);
  // Free capacity: promote admits and removes the entry.
  store.setUsage({ cpuCores: 2, ramMB: 4096, runningBots: 4 });
  const promoted = store.promoteHead(T0 + 3000);
  assert.equal(promoted.ok, true);
  assert.equal(promoted.evaluation.decision, 'admit');
  assert.equal(store.listQueue().length, 0);
  assert.equal(store.getUsage().runningBots, 5);
  // Empty queue: promote reports it.
  assert.equal(store.promoteHead(T0 + 4000).reason, 'queue-empty');
  // Expiry: a queued request past its wait drops out.
  store.setPolicy({ queueMaxWaitMs: 1000 });
  store.enqueue({ kind: 'bot-start', cpuCores: 0.5, extraRunningBots: 1 }, T0 + 5000);
  assert.equal(store.expireQueue(T0 + 5000 + 999), 0);
  assert.equal(store.expireQueue(T0 + 5000 + 1001), 1);
  assert.equal(store.listQueue().length, 0);
  // Ledger recorded the decisions.
  assert.ok(store.getLedger().length >= 4);
  assert.ok(store.getLedger().every((e) => e.atMs > 0));
  assert.ok(store.summarize().includes('5/8 bots'));
});

test('quota v2: limits validation + queue-full + JSON round-trip', () => {
  assert.deepEqual(validateFleetV27Limits({ cpuCores: 4, ramMB: 8192 }), []);
  assert.ok(validateFleetV27Limits({ cpuCores: -1 }).length > 0);
  assert.ok(validateFleetV27Limits({ maxConcurrentBots: 1.5 }).length > 0);
  const store = new FleetV27QuotaStore();
  assert.equal(store.setLimits({ cpuCores: -1 }).ok, false);
  assert.equal(store.getLimits().cpuCores, 4); // old limits kept
  assert.equal(store.setLimits({ cpuCores: 2 }).ok, true);
  assert.equal(store.getLimits().cpuCores, 2);
  // Queue cap: queueMaxLength 1 -> second enqueue refused.
  store.setPolicy({ queueMaxLength: 1 });
  assert.equal(store.enqueue({ kind: 'bot-start' }, T0).ok, true);
  const full = store.enqueue({ kind: 'bot-start' }, T0);
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'queue-full');
  // Round-trip preserves limits + queue + ledger.
  const restored = FleetV27QuotaStore.fromJSON(store.toJSON());
  assert.equal(restored.getLimits().cpuCores, 2);
  assert.equal(restored.listQueue().length, 1);
  assert.equal(restored.getLedger().length, store.getLedger().length);
});
