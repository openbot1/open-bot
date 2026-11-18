/**
 * Protocols v4 — IETF agentproto WG watch-track tests (v1.20, Team T2).
 *
 * Covers packages/core/src/protocolsV4/ietfWatchV4.ts: charter
 * milestones in due order, next-milestone lookup, and the
 * readiness report (2 ready / 3 partial / 3 watch).
 *
 * No network, no provider: everything runs in-process against
 * the built core dist.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v120-ietf-watch.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IETF_V4_AGENTPROTO_CHARTER_DATE,
  IETF_V4_AGENTPROTO_MILESTONES,
  ietfV4NextMilestone,
  ietfV4ReadinessReport,
  ietfV4WatchSummary,
} from '../packages/core/dist/index.js';

test('charter milestones are the approved four, in due order', () => {
  assert.equal(IETF_V4_AGENTPROTO_CHARTER_DATE, '2026-10-08');
  assert.equal(IETF_V4_AGENTPROTO_MILESTONES.length, 4);
  assert.deepEqual(
    IETF_V4_AGENTPROTO_MILESTONES.map((m) => m.due),
    ['2026-12-31', '2027-02-28', '2027-03-31', '2028-03-31'],
  );
  assert.match(IETF_V4_AGENTPROTO_MILESTONES[0].title, /use-cases/);
  assert.match(IETF_V4_AGENTPROTO_MILESTONES[2].title, /dialog management/);
  assert.match(IETF_V4_AGENTPROTO_MILESTONES[3].title, /IESG/);
  for (const m of IETF_V4_AGENTPROTO_MILESTONES) {
    assert.ok(m.openBotAction.length > 20, 'each milestone tells open-bot what to do');
  }
});

test('next milestone depends on the date; null after the last one', () => {
  const now = ietfV4NextMilestone(new Date('2026-11-16T00:00:00Z'));
  assert.ok(now);
  assert.match(now.title, /use-cases/);

  const feb = ietfV4NextMilestone(new Date('2027-01-15T00:00:00Z'));
  assert.ok(feb);
  assert.match(feb.title, /architecture/);

  const after = ietfV4NextMilestone(new Date('2028-04-01T00:00:00Z'));
  assert.equal(after, null);
});

test('readiness report counts 2 ready / 3 partial / 3 watch and names the gaps', () => {
  const report = ietfV4ReadinessReport(new Date('2026-11-16T00:00:00Z'));
  assert.equal(report.wg, 'agentproto');
  assert.deepEqual(report.counts, { ready: 2, partial: 3, watch: 3 });
  assert.equal(report.rows.length, 8);
  assert.match(report.nextMilestone.title, /use-cases/);
  assert.match(report.summary, /No wire protocol exists yet/);

  const byConcept = Object.fromEntries(report.rows.map((r) => [r.concept, r]));
  assert.equal(byConcept['Dialog lifecycle semantics'].status, 'ready');
  assert.equal(byConcept['Identity management'].status, 'ready');
  assert.equal(byConcept['Dialog identifiers'].status, 'partial');
  assert.match(byConcept['Dialog identifiers'].gap, /cross-protocol dialog id/);
  assert.equal(byConcept['Bindings over existing IETF protocols'].status, 'watch');
  assert.equal(byConcept['Discovery (sibling WG DAWN)'].status, 'watch');
  for (const row of report.rows) {
    assert.ok(row.openBotHas.length > 10);
    assert.ok(row.gap.length > 10);
  }
});

test('watch summary is a one-liner naming the WG and the next milestone', () => {
  const summary = ietfV4WatchSummary(new Date('2026-11-16T00:00:00Z'));
  assert.match(summary, /agentproto/);
  assert.match(summary, /use-cases/);
  assert.equal(summary.includes('\n'), false);
});
