/**
 * Tests for memory v22 — collect / report / eval (v1.37, Doi T1).
 * packages/core/src/memory/v22/{collect,report,eval}.ts
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v22-collect-report-eval-v137.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V22Dreamer,
  V22TranscriptCollector,
  collectFromTranscriptV22,
  dreamReportToMarkdownV22,
  extractTopicValueV22,
  formatDreamChangeV22,
  formatDreamEvalReportV22,
  formatDreamReportV22,
  formatDreamTrendV22,
  groupChangesByKindV22,
  isGreetingV22,
  runDreamEvalV22,
  splitTurnIntoSentencesV22,
  summarizeDreamTrendV22,
  V22_DREAM_EVAL_CASES,
} from '../packages/core/dist/memory/v22/index.js';

const NOW = 1794000000000;

// --- collect -------------------------------------------------------------

test('v22 collect: tach cau, bo cau hoi / chao hoi / qua ngan', () => {
  assert.deepEqual(splitTurnIntoSentencesV22('Toi thich ca phe. Ban thi sao? Cam on nhe!'), [
    'Toi thich ca phe',
    'Ban thi sao',
    'Cam on nhe',
  ]);
  assert.equal(isGreetingV22('Xin chao ban'), true);
  assert.equal(isGreetingV22('Cam on ban nhieu'), true);
  assert.equal(isGreetingV22('User thich ca phe den'), false);
  const res = collectFromTranscriptV22(
    [
      { role: 'user', text: 'Xin chao. Toi thich ca phe den. Ban co thich khong?', sessionId: 's1' },
      { role: 'agent', text: 'Toi se nho dieu do. Chuc ban mot ngay tot lanh.', sessionId: 's1' },
      { role: 'user', text: 'ok', sessionId: 's1' },
    ],
    { now: NOW },
  );
  // Cau giu: "Toi thich ca phe den" (user, 0.75) + "Toi se nho dieu do" (agent, 0.55)
  // + "Chuc ban mot ngay tot lanh" (agent, 0.55). Cau hoi cuoi turn 1 bi bo.
  assert.equal(res.sentencesSeen, 6);
  assert.equal(res.candidates.length, 3);
  assert.equal(res.candidates[0].confidence, 0.75);
  assert.equal(res.candidates[0].topic, 'user|thich');
  assert.equal(res.candidates[0].value, 'ca-phe-den');
  assert.equal(res.candidates[1].confidence, 0.55);
  assert.ok(res.skipped.some((s) => s.includes('cau hoi')));
  assert.ok(res.skipped.some((s) => s.includes('chao hoi')));
  assert.ok(res.skipped.some((s) => s.includes('qua ngan')));
});

test('v22 collect: trich topic/value theo mau Viet + Anh', () => {
  assert.deepEqual(extractTopicValueV22('User thich ca phe den'), { topic: 'user|thich', value: 'ca-phe-den' });
  // Cau co dau day du van trich duoc (bo dau truoc khi khop mau).
  assert.deepEqual(extractTopicValueV22('Tôi thích cà phê đen'), { topic: 'user|thich', value: 'ca-phe-den' });
  assert.deepEqual(extractTopicValueV22('Tôi sống ở Hà Nội'), { topic: 'user|dia_diem', value: 'ha-noi' });
  assert.equal(isGreetingV22('Xin chào bạn'), true);
  assert.deepEqual(extractTopicValueV22('User likes black coffee'), { topic: 'user|likes', value: 'black-coffee' });
  assert.deepEqual(extractTopicValueV22('User song o Ha Noi'), { topic: 'user|dia_diem', value: 'ha-noi' });
  assert.deepEqual(extractTopicValueV22('User lives in Da Nang'), { topic: 'user|location', value: 'da-nang' });
  assert.deepEqual(extractTopicValueV22('User ten la Minh'), { topic: 'user|ten', value: 'minh' });
  assert.equal(extractTopicValueV22('Troi hom nay dep qua'), null);
  assert.equal(extractTopicValueV22('User thich'), null); // value rong
});

test('v22 collect: collector dem so turn/cau/ung vien + gioi han maxTurns', () => {
  const collector = new V22TranscriptCollector();
  const turns = Array.from({ length: 5 }, (_, i) => ({
    role: 'user', text: `User thich mon an so ${i + 1}.`, sessionId: 's1',
  }));
  const res = collector.collect(turns, { now: NOW, maxTurns: 3 });
  assert.equal(res.candidates.length, 3);
  assert.equal(collector.getTurnsSeen(), 3);
  assert.equal(collector.getSentencesSeen(), 3);
  assert.equal(collector.getCandidatesTotal(), 3);
  assert.ok(res.skipped.some((s) => s.includes('vuot maxTurns')));
  collector.reset();
  assert.equal(collector.getTurnsSeen(), 0);
});

test('v22 collect: dreamer nap transcript o phase collect roi moi consolidate', () => {
  const dreamer = new V22Dreamer();
  const report = dreamer.runDream('manual', {
    now: NOW,
    transcriptTurns: [
      { role: 'user', text: 'Toi thich ca phe den.', sessionId: 's1' },
      { role: 'user', text: 'Toi thich ca phe den.', sessionId: 's2' },
      { role: 'user', text: 'Toi thich ca phe den.', sessionId: 's3' },
    ],
  });
  assert.equal(report.factsCollected, 3);
  // 3 ung vien giong nhau -> dedupe gop 2, con 1 keeper + pattern (3 session).
  assert.equal(report.duplicatesMerged, 2);
  assert.equal(report.patternsCreated, 1);
  assert.equal(report.factsAfter, 2);
});

// --- report --------------------------------------------------------------

test('v22 report: format change + report text + markdown + trend', () => {
  const dreamer = new V22Dreamer();
  dreamer.store.addFact({ text: 'User thich ca phe den moi sang.', confidence: 0.9 }, NOW);
  dreamer.store.addFact({ text: 'User thich ca phe den moi sang khong duong.', confidence: 0.7 }, NOW);
  const report = dreamer.runDream('manual', { now: NOW });
  const change = report.changes.find((c) => c.kind === 'merge');
  assert.ok(change);
  const line = formatDreamChangeV22(change);
  assert.match(line, /^\[merge\]/);
  assert.match(line, /Jaccard/);
  const text = formatDreamReportV22(report);
  assert.match(text, /Dream dream-v22-/);
  assert.match(text, /Gop 1/);
  assert.match(text, /Always-loaded:/);
  const md = dreamReportToMarkdownV22(report);
  assert.match(md, /^# Dream report dream-v22-/);
  assert.match(md, /## Thay doi/);
  assert.match(md, /Snapshot: `snap-/);
  const grouped = groupChangesByKindV22(report.changes);
  assert.equal(grouped.get('merge').length, 1);
  // Trend: 2 report gop lai.
  const trend = summarizeDreamTrendV22([report, report]);
  assert.equal(trend.dreams, 2);
  assert.equal(trend.totalMerged, 2);
  assert.equal(trend.failureRate, 0);
  assert.match(formatDreamTrendV22(trend), /2 dream/);
  assert.equal(formatDreamTrendV22(summarizeDreamTrendV22([])), 'Chua co dream nao chay.');
});

// --- eval ----------------------------------------------------------------

test('v22 report: history ghi moi lan dream + trend tu lich su', () => {
  const dreamer = new V22Dreamer();
  assert.equal(dreamer.history.size(), 0);
  assert.equal(dreamer.history.summarize(), 'Chua co dream nao chay.');
  dreamer.store.addFact({ text: 'User thich ca phe den moi sang.', confidence: 0.9 }, NOW);
  dreamer.store.addFact({ text: 'User thich ca phe den moi sang khong duong.', confidence: 0.7 }, NOW);
  const r1 = dreamer.runDream('manual', { now: NOW });
  assert.equal(dreamer.history.size(), 1);
  assert.equal(dreamer.history.latest().jobId, r1.jobId);
  const r2 = dreamer.runDream('manual', { now: NOW + 1000 });
  assert.equal(dreamer.history.size(), 2);
  assert.equal(dreamer.history.list(1)[0].jobId, r2.jobId);
  const trend = dreamer.history.trend();
  assert.equal(trend.dreams, 2);
  assert.equal(trend.totalMerged, 1);
  assert.match(dreamer.history.summarize(), /2 dream/);
  assert.equal(dreamer.history.clear(), 2);
  assert.equal(dreamer.history.size(), 0);
});

test('v22 eval: bo 7 case mac dinh deu pass', () => {
  assert.equal(V22_DREAM_EVAL_CASES.length, 7);
  const report = runDreamEvalV22(undefined, { now: NOW });
  assert.equal(report.total, 7);
  assert.equal(report.passed, 7);
  assert.equal(report.failed, 0);
  assert.equal(formatDreamEvalReportV22(report).split('\n')[0], 'Dream eval: 7/7 case pass.');
  for (const result of report.results) {
    assert.equal(result.passed, true, `${result.name} fail: ${result.mismatches.join('; ')}`);
  }
});

test('v22 eval: case sai ky vong thi fail co ly do ro', () => {
  const report = runDreamEvalV22([
    {
      name: 'sai-ky-vong',
      description: 'Ky vong gop 5 trong khi chi gop 1.',
      seed: [
        { text: 'User thich ca phe den moi sang.', confidence: 0.9 },
        { text: 'User thich ca phe den moi sang khong duong.', confidence: 0.7 },
      ],
      expect: { duplicatesMerged: 5 },
    },
  ], { now: NOW });
  assert.equal(report.passed, 0);
  assert.equal(report.failed, 1);
  assert.match(report.results[0].mismatches[0], /duplicatesMerged: ky vong 5, thuc te 1/);
});
