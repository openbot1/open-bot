/**
 * Tests for fleet v23 scheduler v2 (v1.36, Đội T6).
 *
 * Covers:
 * - Priority queue: order by effective priority, aging (low job waiting
 *   long overtakes a fresh normal job), deadline + FIFO tie-breaks.
 * - Queue lifecycle: enqueue duplicate/validate, start/finish/remove
 *   guards (illegal transitions throw).
 * - Cron: parse (lists, ranges, steps, Sunday 7→0), validate errors,
 *   next run (minute/hour/weekday, dom/dow OR rule), matches-at.
 * - SLA: breach detection, remaining time, waited time.
 * - Preemption: only critical preempts; never critical victims, never
 *   just-started jobs, max-preemptions cap; victim = lowest priority /
 *   longest remaining; apply moves victim back + starts incoming.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v23-scheduler.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V23_MAX_PREEMPTIONS,
  FleetV23SchedulerQueue,
  applyFleetV23Preemption,
  breachedSlaJobsV23,
  checkFleetV23Sla,
  compareFleetV23Jobs,
  createFleetV23Job,
  cronMatchesAtV23,
  decideFleetV23Preemption,
  effectivePriorityV23,
  nextFleetV23CronRun,
  parseFleetV23Cron,
  snapshotFleetV23Queue,
  sortFleetV23Queue,
  validateFleetV23Cron,
  validateFleetV23Job,
} from '../packages/core/dist/fleetV23/schedulerV2.js';

const NOW = 1780000000000; // 2026-05-26T... (cố định để test xác định)

function makeJob(id, overrides = {}) {
  return createFleetV23Job({ id, botId: `bot-${id}`, title: id, submittedAt: NOW, ...overrides });
}

test('scheduler: create + validate job', () => {
  const job = makeJob('j1', { priority: 'high', slaDeadlineMs: NOW + 60_000, cron: '0 9 * * 1-5' });
  assert.equal(job.status, 'queued');
  assert.equal(job.startedAt, null);
  assert.equal(job.preemptCount, 0);
  assert.deepEqual(validateFleetV23Job(job), []);
  assert.deepEqual(validateFleetV23Job(null), ['job phải là object.']);
  assert.ok(validateFleetV23Job({ ...job, priority: 'urgent' }).some((e) => e.includes('priority')));
  assert.ok(
    validateFleetV23Job({ ...job, slaDeadlineMs: NOW - 1 }).some((e) => e.includes('slaDeadlineMs')),
  );
  assert.ok(validateFleetV23Job({ ...job, cron: 'bad cron' }).some((e) => e.includes('cron')));
  assert.ok(validateFleetV23Job({ ...job, estimatedMs: 0 }).some((e) => e.includes('estimatedMs')));
});

test('scheduler: effective priority + aging (low chờ lâu vượt normal mới)', () => {
  const fresh = makeJob('fresh', { priority: 'normal', submittedAt: NOW });
  const oldLow = makeJob('old-low', { priority: 'low', submittedAt: NOW - 150 * 60_000 }); // chờ 150 phút
  assert.equal(effectivePriorityV23(fresh, NOW), 200);
  assert.equal(effectivePriorityV23(oldLow, NOW), 100 + 150);
  assert.ok(compareFleetV23Jobs(oldLow, fresh, NOW) < 0); // old-low chạy trước
  // Job đang chạy không tính aging.
  const running = { ...makeJob('run', { priority: 'low', submittedAt: NOW - 150 * 60_000 }), status: 'running' };
  assert.equal(effectivePriorityV23(running, NOW), 100);
});

test('scheduler: queue order — priority, deadline, FIFO', () => {
  const jobs = [
    makeJob('low-1', { priority: 'low', submittedAt: NOW }),
    makeJob('crit-1', { priority: 'critical', submittedAt: NOW + 1000 }),
    makeJob('high-early', { priority: 'high', submittedAt: NOW, slaDeadlineMs: NOW + 10_000 }),
    makeJob('high-late', { priority: 'high', submittedAt: NOW, slaDeadlineMs: NOW + 50_000 }),
    makeJob('high-nodl', { priority: 'high', submittedAt: NOW - 5000 }),
  ];
  const ordered = sortFleetV23Queue(jobs, NOW).map((j) => j.id);
  assert.equal(ordered[0], 'crit-1');
  // high: deadline sớm nhất trước (high-early), rồi high-late, rồi high-nodl (không deadline);
  // nhưng high-nodl nộp sớm hơn — deadline (kể cả vô hạn) được xét trước FIFO.
  assert.deepEqual(ordered.slice(1, 4), ['high-early', 'high-late', 'high-nodl']);
  assert.equal(ordered[4], 'low-1');
});

test('scheduler: queue lifecycle guards', () => {
  const q = new FleetV23SchedulerQueue();
  const j1 = makeJob('j1');
  q.enqueue(j1);
  assert.equal(q.size, 1);
  assert.equal(q.queuedCount, 1);
  assert.throws(() => q.enqueue(j1), /đã có trong hàng đợi/);
  assert.throws(() => q.enqueue(makeJob('bad', { priority: 'urgent' })), /không hợp lệ/);

  assert.equal(q.peekNext(NOW)?.id, 'j1');
  const started = q.start('j1', NOW + 1000);
  assert.equal(started.status, 'running');
  assert.equal(started.startedAt, NOW + 1000);
  assert.equal(q.runningCount, 1);
  assert.throws(() => q.start('j1', NOW + 2000), /chỉ job queued\/preempted/);
  assert.throws(() => q.remove('j1'), /finish\/cancel trước/);
  const done = q.finish('j1', 'completed');
  assert.equal(done.status, 'completed');
  assert.throws(() => q.finish('j1', 'completed'), /không kết thúc được/);
  assert.equal(q.remove('j1'), true);
  assert.equal(q.remove('j1'), false);
  assert.throws(() => q.start('nope'), /không có trong hàng đợi/);
  assert.equal(q.get('nope'), undefined);
});

test('scheduler: cron parse + validate', () => {
  const parsed = parseFleetV23Cron('*/15 9-17 * * 1-5');
  assert.equal(parsed.minute?.size, 4); // 0,15,30,45
  assert.ok(parsed.hour?.has(9) && parsed.hour?.has(17) && !parsed.hour?.has(18));
  assert.equal(parsed.dayOfMonth, null);
  // Thứ 7 = Chủ nhật → chuẩn hoá về 0.
  const sunday = parseFleetV23Cron('0 0 * * 7');
  assert.ok(sunday.dayOfWeek?.has(0) && !sunday.dayOfWeek?.has(7));
  assert.deepEqual(validateFleetV23Cron('0 9 * * 1-5'), []);
  assert.ok(validateFleetV23Cron('0 9 * *').length > 0); // thiếu trường
  assert.ok(validateFleetV23Cron('61 9 * * *').length > 0); // phút ngoài khoảng
  assert.ok(validateFleetV23Cron('*/0 9 * * *').length > 0); // bước 0
  assert.ok(validateFleetV23Cron('').length > 0);
  assert.ok(validateFleetV23Cron(42).length > 0);
  assert.throws(() => parseFleetV23Cron('0 25 * * *'), /ngoài khoảng/);
});

test('scheduler: cron next run (UTC, phút/giờ/thứ, dom/dow OR)', () => {
  // 2026-05-26 là thứ Ba. from = 2026-05-26T08:30:00Z.
  const from = Date.UTC(2026, 4, 26, 8, 30, 0);
  assert.equal(new Date(from).getUTCDay(), 2);
  // Mỗi ngày 9:00 → 2026-05-26T09:00Z.
  assert.equal(nextFleetV23CronRun('0 9 * * *', from), Date.UTC(2026, 4, 26, 9, 0, 0));
  // 8:00 đã qua hôm nay → ngày mai.
  assert.equal(nextFleetV23CronRun('0 8 * * *', from), Date.UTC(2026, 4, 27, 8, 0, 0));
  // Thứ 2 hàng tuần 9:00 → thứ 2 tuần sau (2026-06-01).
  assert.equal(nextFleetV23CronRun('0 9 * * 1', from), Date.UTC(2026, 5, 1, 9, 0, 0));
  // Mỗi 30 phút → 09:00 (từ 08:30, phút tiếp theo khớp là 09:00).
  assert.equal(nextFleetV23CronRun('*/30 * * * *', from), Date.UTC(2026, 4, 26, 9, 0, 0));
  // Ngày 1 hàng tháng → 2026-06-01T00:00Z.
  assert.equal(nextFleetV23CronRun('0 0 1 * *', from), Date.UTC(2026, 5, 1, 0, 0, 0));
  // dom=1 OR dow=thứ 3 (2): hôm nay là thứ 3 → 9:00 hôm nay khớp theo dow.
  assert.equal(nextFleetV23CronRun('0 9 1 * 2', from), Date.UTC(2026, 4, 26, 9, 0, 0));
  // 31/2 không bao giờ khớp → throw.
  assert.throws(() => nextFleetV23CronRun('0 0 31 2 *', from), /không có lần chạy/);
  // matches-at: đúng phút khớp, sai phút không khớp.
  assert.equal(cronMatchesAtV23('0 9 * * *', Date.UTC(2026, 4, 26, 9, 0, 0)), true);
  assert.equal(cronMatchesAtV23('0 9 * * *', Date.UTC(2026, 4, 26, 9, 1, 0)), false);
});

test('scheduler: SLA breach + waited', () => {
  const breached = makeJob('late', { submittedAt: NOW - 120_000, slaDeadlineMs: NOW - 1000 });
  const onTime = makeJob('ontime', { submittedAt: NOW - 1000, slaDeadlineMs: NOW + 60_000 });
  const noSla = makeJob('nosla', { submittedAt: NOW - 5000 });
  const checkB = checkFleetV23Sla(breached, NOW);
  assert.equal(checkB.hasSla, true);
  assert.equal(checkB.breached, true);
  assert.equal(checkB.remainingMs, -1000);
  assert.equal(checkB.waitedMs, 120_000);
  assert.equal(checkFleetV23Sla(onTime, NOW).breached, false);
  assert.equal(checkFleetV23Sla(noSla, NOW).hasSla, false);
  assert.equal(checkFleetV23Sla(noSla, NOW).remainingMs, null);
  // Job đã completed thì không tính breach nữa.
  const doneBreached = { ...breached, status: 'completed' };
  assert.equal(checkFleetV23Sla(doneBreached, NOW).breached, false);
  assert.deepEqual(
    breachedSlaJobsV23([onTime, breached, noSla], NOW).map((j) => j.id),
    ['late'],
  );
});

test('scheduler: preemption — only critical, victim rules, apply', () => {
  const q = new FleetV23SchedulerQueue();
  const lowRunning = makeJob('low-run', { priority: 'low', submittedAt: NOW - 600_000, estimatedMs: 600_000 });
  const highRunning = makeJob('high-run', { priority: 'high', submittedAt: NOW - 600_000, estimatedMs: 120_000 });
  const critRunning = makeJob('crit-run', { priority: 'critical', submittedAt: NOW - 600_000 });
  const freshLow = makeJob('fresh-low', { priority: 'low', submittedAt: NOW - 1000, estimatedMs: 600_000 });
  const incomingCrit = makeJob('incoming', { priority: 'critical', submittedAt: NOW });
  const incomingHigh = makeJob('incoming-high', { priority: 'high', submittedAt: NOW });
  for (const j of [lowRunning, highRunning, critRunning, freshLow, incomingCrit, incomingHigh]) q.enqueue(j);
  q.start('low-run', NOW - 300_000);
  q.start('high-run', NOW - 300_000);
  q.start('crit-run', NOW - 300_000);
  q.start('fresh-low', NOW - 1000); // mới chạy 1s < min 30s → không bị preempt
  const running = q.byStatus('running');

  // Job high vào → không preempt.
  const dHigh = decideFleetV23Preemption(incomingHigh, running, undefined, NOW);
  assert.equal(dHigh.preempt, false);

  // Job critical vào → nạn nhân là low-run (priority thấp nhất; fresh-low
  // mới chạy nên bị loại dù cũng low).
  const decision = decideFleetV23Preemption(incomingCrit, running, undefined, NOW);
  assert.equal(decision.preempt, true);
  if (decision.preempt) assert.equal(decision.victimJobId, 'low-run');

  const { victim, incoming } = applyFleetV23Preemption(q, decision, NOW);
  assert.equal(victim.status, 'preempted');
  assert.equal(victim.preemptCount, 1);
  assert.equal(incoming.status, 'running');
  assert.equal(incoming.id, 'incoming');
  // Nạn nhân chạy lại được (start từ preempted).
  assert.equal(q.start('low-run', NOW + 5000).status, 'running');

  // Không còn nạn nhân đủ điều kiện (chỉ còn critical + high bị cấm khi
  // policy allowPreemptHigh=false + fresh-low mới chạy) → không preempt.
  const q2 = new FleetV23SchedulerQueue();
  const h = makeJob('h', { priority: 'high', submittedAt: NOW - 600_000 });
  const c2 = makeJob('c2', { priority: 'critical', submittedAt: NOW });
  q2.enqueue(h);
  q2.enqueue(c2);
  q2.start('h', NOW - 300_000);
  const d2 = decideFleetV23Preemption(c2, q2.byStatus('running'), { minRuntimeBeforePreemptMs: 30_000, allowPreemptHigh: false }, NOW);
  assert.equal(d2.preempt, false);

  // Job đã preempt đủ FLEET_V23_MAX_PREEMPTIONS lần → không làm nạn nhân nữa.
  const worn = makeJob('worn', { priority: 'low', submittedAt: NOW - 600_000, estimatedMs: 600_000 });
  const q3 = new FleetV23SchedulerQueue();
  q3.enqueue({ ...worn, preemptCount: FLEET_V23_MAX_PREEMPTIONS });
  q3.enqueue(makeJob('c3', { priority: 'critical', submittedAt: NOW }));
  q3.start('worn', NOW - 300_000);
  const d3 = decideFleetV23Preemption(q3.get('c3'), q3.byStatus('running'), undefined, NOW);
  assert.equal(d3.preempt, false);
});

test('scheduler: snapshot queue', () => {
  const jobs = [
    makeJob('q1', { priority: 'critical', submittedAt: NOW - 5000 }),
    makeJob('q2', { priority: 'low', submittedAt: NOW - 9000, slaDeadlineMs: NOW - 1000 }),
    { ...makeJob('r1', { priority: 'normal' }), status: 'running', startedAt: NOW - 1000 },
    { ...makeJob('d1', { priority: 'normal' }), status: 'completed' },
  ];
  const snap = snapshotFleetV23Queue(jobs, NOW);
  assert.equal(snap.total, 4);
  assert.equal(snap.queued, 2);
  assert.equal(snap.running, 1);
  assert.equal(snap.completed, 1);
  assert.equal(snap.byPriorityQueued.critical, 1);
  assert.equal(snap.byPriorityQueued.low, 1);
  assert.deepEqual(snap.breachedSlaIds, ['q2']);
  assert.equal(snap.longestWaitingJobId, 'q2');
  assert.equal(snap.longestWaitMs, 9000);
});
