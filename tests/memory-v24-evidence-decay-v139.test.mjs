/**
 * Tests for memory v24 — evidence/lessons + decay (v1.39, Doi T1).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v24-evidence-decay-v139.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDecayToFactV24,
  applyDecayToLessonV24,
  applyLessonV24,
  attachEvidenceV24,
  createLessonV24,
  decayedConfidenceV24,
  evidenceCoverageV24,
  evidenceFreshnessV24,
  lessonHasValidEvidenceV24,
  lessonNeedsReverifyV24,
  makeEvidenceV24,
  makeV24Scope,
  nextReviewAtV24,
  recordAccessFactV24,
  traceLessonV24,
  validateEvidenceV24,
} from '../packages/core/dist/memory/v24/index.js';

const NOW = 1794000000000;
const DAY = 24 * 3600 * 1000;
const SCOPE = makeV24Scope({ userId: 'u1', agentId: 'bot-a' });

function fact(overrides = {}) {
  return {
    id: 'f1',
    subject: 'user',
    edge: 'prefers',
    object: 'cà phê đen',
    kind: 'fact',
    validFrom: null,
    validTo: null,
    learnedAt: new Date(NOW).toISOString(),
    invalidatedAt: null,
    invalidReason: null,
    supersedesId: null,
    supersededById: null,
    mergedFromIds: [],
    confidence: 0.8,
    importance: 0.5,
    lastAccessedAt: null,
    accessCount: 0,
    expiresAt: null,
    status: 'active',
    scope: SCOPE,
    provenance: {
      episodeId: 'ep1', turnId: 't1', runId: '', botId: 'bot-a', userId: 'u1',
      at: new Date(NOW).toISOString(), sourceText: 'Tôi thích cà phê đen.',
      method: 'rule', extractor: 'v24-rule-v1', embeddingKind: 'hash',
    },
    evidenceIds: [],
    note: '',
    ...overrides,
  };
}

// --- Evidence / lessons ---

test('v24 evidence: validate + freshness', () => {
  const good = makeEvidenceV24({
    kind: 'conversation', source: 'conv-1', excerpt: 'Tôi thích cà phê đen.',
    capturedAt: new Date(NOW).toISOString(), capturedBy: 'bot-a', confidence: 0.9,
  });
  assert.equal(validateEvidenceV24(good), null);
  assert.equal(evidenceFreshnessV24(good, NOW), 1);
  const old = { ...good, capturedAt: new Date(NOW - 400 * DAY).toISOString() };
  assert.ok(evidenceFreshnessV24(old, NOW) <= 0.15);
  const bad = { ...good, excerpt: '   ' };
  assert.ok(validateEvidenceV24(bad));
  const badUri = { ...good, uri: 'notaurl' };
  assert.ok(validateEvidenceV24(badUri));
  const okUri = { ...good, uri: 'memfs://profile/preferences.md' };
  assert.equal(validateEvidenceV24(okUri), null);
});

test('v24 lesson: khong evidence -> quarantine; co evidence -> active', () => {
  const noEv = createLessonV24({
    title: 'Khong evidence', body: 'Nen lam X.', evidence: [],
    scope: SCOPE, authorBotId: 'bot-a', nowMs: NOW,
  });
  assert.equal(noEv.status, 'quarantined');
  assert.ok(noEv.statusReason);
  assert.equal(lessonHasValidEvidenceV24(noEv), false);

  const ev = makeEvidenceV24({
    kind: 'conversation', source: 'conv-1', excerpt: 'Deploy that bai vi thieu bien moi truong.',
    capturedAt: new Date(NOW).toISOString(), capturedBy: 'bot-a',
  });
  const withEv = createLessonV24({
    title: 'Kiem tra env truoc khi deploy', body: 'Luon kiem tra bien moi truong truoc khi deploy.',
    evidence: [ev], scope: SCOPE, authorBotId: 'bot-a', nowMs: NOW,
  });
  assert.equal(withEv.status, 'active');
  assert.equal(lessonHasValidEvidenceV24(withEv), true);
  const trace = traceLessonV24(withEv);
  assert.ok(trace[0].includes('Kiem tra env'));
  assert.ok(trace[1].includes('conv-1'));
  assert.equal(evidenceCoverageV24([noEv, withEv]).ratio, 0.5);
});

test('v24 lesson: attach evidence mo quarantine; apply tang count; reverify', () => {
  const quarantined = createLessonV24({
    title: 'Lesson thieu evidence', body: 'Body.', evidence: [],
    scope: SCOPE, nowMs: NOW,
  });
  const ev = makeEvidenceV24({
    kind: 'document', source: 'notes.md', excerpt: 'Doan trich goc.',
    capturedAt: new Date(NOW).toISOString(), capturedBy: 'bot-a',
  });
  const attached = attachEvidenceV24(quarantined, ev);
  assert.equal(attached.ok, true);
  assert.equal(attached.value.status, 'active');
  assert.equal(attached.value.evidence.length, 1);
  const badAttach = attachEvidenceV24(attached.value, { ...ev, excerpt: '' });
  assert.equal(badAttach.ok, false);

  const applied = applyLessonV24(attached.value, NOW);
  assert.equal(applied.appliedCount, 1);
  assert.equal(applied.lastAppliedAt, new Date(NOW).toISOString());

  // Lesson co evidence rat cu -> can re-verify.
  const staleLesson = createLessonV24({
    title: 'Cu', body: 'Body cu.',
    evidence: [makeEvidenceV24({
      kind: 'conversation', source: 'old-conv', excerpt: 'Cu.',
      capturedAt: new Date(NOW - 400 * DAY).toISOString(), capturedBy: 'bot-a',
    })],
    scope: SCOPE, confidence: 0.4, nowMs: NOW - 400 * DAY,
  });
  assert.equal(lessonNeedsReverifyV24(staleLesson, NOW), true);
  assert.equal(lessonNeedsReverifyV24(applied, NOW), false);
});

// --- Decay ---

test('v24 decay: cong thuc half-life + stale + archive + expired', () => {
  // Sau 1 half-life (fact 180 ngay), confidence giam mot nua.
  assert.ok(Math.abs(decayedConfidenceV24(0.8, 180, 180) - 0.4) < 0.001);
  assert.equal(decayedConfidenceV24(0.8, 0, 180), 0.8);
  assert.equal(decayedConfidenceV24(0.8, -5, 180), 0.8);

  // Fact hoc tu 200 ngay truoc, khong duoc dung -> decay.
  const oldFact = fact({
    learnedAt: new Date(NOW - 200 * DAY).toISOString(),
    confidence: 0.8,
  });
  const decayed = applyDecayToFactV24(oldFact, undefined, NOW);
  assert.equal(decayed.outcome.action, 'decayed');
  assert.ok(decayed.fact.confidence < 0.8 && decayed.fact.confidence > 0.3);

  // Fact confidence thap + cu -> archive.
  const veryOld = fact({
    learnedAt: new Date(NOW - 2000 * DAY).toISOString(),
    confidence: 0.2,
  });
  const archived = applyDecayToFactV24(veryOld, undefined, NOW);
  assert.equal(archived.outcome.action, 'archived');
  assert.equal(archived.fact.status, 'archived');

  // Fact het han -> expired (archive luon).
  const expired = fact({ expiresAt: new Date(NOW - DAY).toISOString() });
  const expiredRes = applyDecayToFactV24(expired, undefined, NOW);
  assert.equal(expiredRes.outcome.action, 'expired');
  assert.equal(expiredRes.fact.status, 'archived');

  // Fact moi -> unchanged.
  const fresh = applyDecayToFactV24(fact(), undefined, NOW);
  assert.equal(fresh.outcome.action, 'unchanged');
});

test('v24 decay: access boost + revive + next review', () => {
  const staleFact = fact({ confidence: 0.1, accessCount: 5 });
  const accessed = recordAccessFactV24(staleFact, undefined, NOW);
  assert.equal(accessed.fact.accessCount, 6);
  assert.ok(accessed.fact.confidence > 0.1);
  assert.equal(accessed.outcome.action, 'revived');
  assert.equal(accessed.fact.lastAccessedAt, new Date(NOW).toISOString());

  const normal = recordAccessFactV24(fact({ confidence: 0.8 }), undefined, NOW);
  assert.equal(normal.outcome.action, 'unchanged');
  assert.ok(Math.abs(normal.fact.confidence - 0.85) < 0.001);

  const review = nextReviewAtV24(fact(), undefined, NOW);
  const reviewMs = new Date(review).getTime();
  assert.ok(reviewMs > NOW && reviewMs <= NOW + 180 * DAY);

  // Lesson decay: confidence giam theo tuoi.
  const oldLesson = createLessonV24({
    title: 'Cu', body: 'Body.',
    evidence: [makeEvidenceV24({
      kind: 'conversation', source: 's', excerpt: 'e.',
      capturedAt: new Date(NOW - 400 * DAY).toISOString(), capturedBy: 'bot-a',
    })],
    scope: SCOPE, confidence: 0.8, nowMs: NOW - 400 * DAY,
  });
  const lessonDecayed = applyDecayToLessonV24(oldLesson, undefined, NOW);
  assert.ok(['decayed', 'stale', 'archived'].includes(lessonDecayed.outcome.action));
  assert.ok(lessonDecayed.lesson.confidence < 0.8);
});
