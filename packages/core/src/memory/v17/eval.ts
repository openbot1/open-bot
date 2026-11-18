/**
 * Memory v17 — Eval offline (v1.18, Doi T1).
 *
 * Eval co dinh, khong goi model, khong goi mang: moi case la mot
 * ham kiem tra (pass/fail) tren cac module v17 (lifecycle,
 * scheduler, scoring, versioning, guard). Chay bang
 * `runV17Eval()` — dung cho tool `memory_v17_eval` va test.
 * Y tuong hoc tu eval v15/v16 (dataset co dinh + nguong PASS/FAIL
 * theo category); tu thiet ke lai cho v17.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TemporalGraphStore, InMemoryGraphBackend } from '../graph/store';
import { V15BlockStore } from '../../memoryV15/blocks';
import {
  V17BlockLifecycleManager,
  renderBlockTemplateV17,
  compileBlocksWithLifecycleV17,
} from './blockLifecycle';
import {
  nextRunAtV17,
  shouldRunScheduledV17,
  isInQuietHoursV17,
  V17_DEFAULT_SLEEP_SCHEDULE_CONFIG,
} from './sleepScheduler';
import type { V17SleepScheduleState } from './sleepScheduler';
import { scorePassageV17, V17_ARCHIVAL_SCORING_DEFAULTS } from './archivalScoring';
import {
  commitBlockV17,
  diffCommitsV17,
  rollbackToCommitV17,
  queryBlockAuditV17,
} from './blockVersioning';
import { verifyProvenanceChainV17, admitCandidateV17, readV17AdmissionAudit } from './poisoningGuardV2';
import type { V17AdmissionCandidate } from './poisoningGuardV2';
import { V16SourceAllowlist } from '../v16/poisoningGuard';

/** Loi eval v17 — message tieng Viet. */
export class V17EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V17EvalError';
  }
}

/** Category eval v17. */
export type V17EvalCategory = 'lifecycle' | 'scheduler' | 'scoring' | 'versioning' | 'guard';

/** Mot case eval. */
export interface V17EvalCase {
  id: string;
  category: V17EvalCategory;
  name: string;
  run: () => boolean;
}

/** Ket qua 1 case. */
export interface V17EvalCaseResult {
  id: string;
  category: V17EvalCategory;
  name: string;
  pass: boolean;
  error: string | null;
}

/** Diem theo category. */
export interface V17EvalCategoryScore {
  category: V17EvalCategory;
  total: number;
  passed: number;
  /** Ty le pass 0..1. */
  rate: number;
}

/** Ket qua eval day du. */
export interface V17EvalResult {
  at: string;
  total: number;
  passed: number;
  failed: number;
  rate: number;
  categories: V17EvalCategoryScore[];
  cases: V17EvalCaseResult[];
  /** true = tat ca category dat nguong. */
  pass: boolean;
}

/** Nguong PASS theo category (ty le pass toi thieu). */
export const V17_EVAL_THRESHOLDS: Record<V17EvalCategory, number> = {
  lifecycle: 1,
  scheduler: 1,
  scoring: 1,
  versioning: 1,
  guard: 1,
};

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function tmpDirV17(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshStore(): TemporalGraphStore {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function seedFactV17(
  store: TemporalGraphStore,
  subject: string,
  predicate: string,
  objectText: string,
  opts: { confidence?: number; validFrom?: string; episodeId?: string } = {},
) {
  const episodeKey = opts.episodeId ?? 'e1';
  // ingestEpisode tu sinh id; dedup theo turnId+botId nen goi lai
  // cung key se tra ve episode cu (khong tao trung).
  const { id: episodeId } = store.ingestEpisode({
    turnId: episodeKey,
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text: `${subject} ${predicate} ${objectText}.`,
  });
  return store.addFact({
    subjectName: subject,
    predicate,
    objectText,
    confidence: opts.confidence ?? 0.9,
    scope: SCOPE,
    provenance: {
      episodeId,
      turnId: episodeKey,
      runId: 'r1',
      botId: 'b1',
      userId: 'u1',
      at: '2026-01-01T00:00:00.000Z',
      sourceText: `${subject} ${predicate} ${objectText}.`,
    },
    validFrom: opts.validFrom ?? '2025-01-01T00:00:00.000Z',
  });
}

/** Dataset eval v17 — 25 case co dinh (5 moi category). */
export function buildV17EvalDataset(): V17EvalCase[] {
  const cases: V17EvalCase[] = [];

  // --- lifecycle (5) ---
  cases.push({
    id: 'L1',
    category: 'lifecycle',
    name: 'Template persona render du bien bat buoc',
    run: () => {
      const { content } = renderBlockTemplateV17('persona', { agentName: 'Bot' });
      return content.includes('Bot') && !content.includes('{{');
    },
  });
  cases.push({
    id: 'L2',
    category: 'lifecycle',
    name: 'Template thieu bien bat buoc thi throw',
    run: () => {
      try {
        renderBlockTemplateV17('persona', {});
        return false;
      } catch {
        return true;
      }
    },
  });
  cases.push({
    id: 'L3',
    category: 'lifecycle',
    name: 'Block readOnly chan edit',
    run: () => {
      const store = new V15BlockStore();
      const m = new V17BlockLifecycleManager(store);
      m.createFromTemplate('human', 'human', { userName: 'Huy' });
      m.setReadOnly('human', true);
      return m.checkEdit({ action: 'append', label: 'human', text: 'them' }) !== null;
    },
  });
  cases.push({
    id: 'L4',
    category: 'lifecycle',
    name: 'Gioi han ky tu rieng chan edit vuot qua',
    run: () => {
      const store = new V15BlockStore();
      const m = new V17BlockLifecycleManager(store);
      m.createFromTemplate('custom', 'note', { title: 'N' });
      // Content template ~47 ky tu -> dat gioi han 60 (tren content hien tai).
      m.setMaxChars('note', 60);
      return m.checkEdit({ action: 'append', label: 'note', text: 'x'.repeat(50) }) !== null;
    },
  });
  cases.push({
    id: 'L5',
    category: 'lifecycle',
    name: 'Block pin compile len dau',
    run: () => {
      const store = new V15BlockStore();
      const m = new V17BlockLifecycleManager(store);
      m.createFromTemplate('custom', 'aaa', { title: 'A' });
      m.createFromTemplate('persona', 'persona', { agentName: 'Bot' });
      m.setPinned('aaa', true);
      const compiled = compileBlocksWithLifecycleV17(m);
      return compiled.indexOf('[custom:aaa]') < compiled.indexOf('[persona:persona]');
    },
  });

  // --- scheduler (5) ---
  cases.push({
    id: 'S1',
    category: 'scheduler',
    name: 'Chua chay bao gio thi nextRun = now (khong quiet hours)',
    run: () => {
      const config = { ...V17_DEFAULT_SLEEP_SCHEDULE_CONFIG, enabled: true, quietHours: null };
      const state: V17SleepScheduleState = {
        version: 1,
        lastRunAt: null,
        nextRunAt: null,
        dayKey: '2026-01-01',
        runsToday: 0,
        consecutiveFailures: 0,
        totalRuns: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const now = new Date('2026-01-01T10:00:00.000Z');
      return nextRunAtV17(config, state, now).getTime() === now.getTime();
    },
  });
  cases.push({
    id: 'S2',
    category: 'scheduler',
    name: 'Dang quiet hours thi khong chay dinh ky',
    run: () => {
      const config = {
        ...V17_DEFAULT_SLEEP_SCHEDULE_CONFIG,
        enabled: true,
        quietHours: { startHour: 23, endHour: 7 },
      };
      const state: V17SleepScheduleState = {
        version: 1,
        lastRunAt: null,
        nextRunAt: null,
        dayKey: '2026-01-01',
        runsToday: 0,
        consecutiveFailures: 0,
        totalRuns: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      // 01:00 gio UTC — gio local cua VM co the khac UTC; dung ham
      // truc tiep tren gio local: tao date voi gio local 2h sang.
      const now = new Date();
      now.setHours(2, 0, 0, 0);
      const decision = shouldRunScheduledV17(config, state, now);
      return decision.run === false && isInQuietHoursV17(config.quietHours, now);
    },
  });
  cases.push({
    id: 'S3',
    category: 'scheduler',
    name: 'Vuot maxRunsPerDay thi doi sang ngay mai',
    run: () => {
      const config = { ...V17_DEFAULT_SLEEP_SCHEDULE_CONFIG, enabled: true, maxRunsPerDay: 1, quietHours: null };
      const now = new Date('2026-01-01T10:00:00.000Z');
      const state: V17SleepScheduleState = {
        version: 1,
        lastRunAt: '2026-01-01T08:00:00.000Z',
        nextRunAt: null,
        dayKey: '2026-01-01',
        runsToday: 1,
        consecutiveFailures: 0,
        totalRuns: 1,
        updatedAt: '2026-01-01T08:00:00.000Z',
      };
      return shouldRunScheduledV17(config, state, now).run === false;
    },
  });
  cases.push({
    id: 'S4',
    category: 'scheduler',
    name: 'Tat lich thi khong chay',
    run: () => {
      const config = { ...V17_DEFAULT_SLEEP_SCHEDULE_CONFIG, enabled: false, quietHours: null };
      const state: V17SleepScheduleState = {
        version: 1,
        lastRunAt: null,
        nextRunAt: null,
        dayKey: '2026-01-01',
        runsToday: 0,
        consecutiveFailures: 0,
        totalRuns: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      return shouldRunScheduledV17(config, state, new Date('2026-01-01T10:00:00.000Z')).run === false;
    },
  });
  cases.push({
    id: 'S5',
    category: 'scheduler',
    name: 'Quiet hours qua dem (23h-7h) tinh dung',
    run: () => {
      const q = { startHour: 23, endHour: 7 };
      const night = new Date();
      night.setHours(23, 30, 0, 0);
      const day = new Date();
      day.setHours(12, 0, 0, 0);
      return isInQuietHoursV17(q, night) === true && isInQuietHoursV17(q, day) === false;
    },
  });

  // --- scoring (5) ---
  cases.push({
    id: 'C1',
    category: 'scoring',
    name: 'Fact truy cap nhieu diem cao hon fact khong ai dung',
    run: () => {
      const store = freshStore();
      const hot = seedFactV17(store, 'Huy', 'likes', 'ca phe', { episodeId: 'e-hot' });
      const cold = seedFactV17(store, 'Huy', 'likes', 'tra da', { episodeId: 'e-cold' });
      const now = new Date('2026-01-02T00:00:00.000Z');
      const hotScore = scorePassageV17(hot, { factId: hot.id, accessCount: 20, lastAccessedAt: '2026-01-02T00:00:00.000Z' }, V17_ARCHIVAL_SCORING_DEFAULTS, now);
      const coldScore = scorePassageV17(cold, undefined, V17_ARCHIVAL_SCORING_DEFAULTS, now);
      return hotScore.score > coldScore.score;
    },
  });
  cases.push({
    id: 'C2',
    category: 'scoring',
    name: 'Fact confidence thap diem thap hon',
    run: () => {
      const store = freshStore();
      const hi = seedFactV17(store, 'Huy', 'likes', 'ca phe', { confidence: 0.95, episodeId: 'e-hi' });
      const lo = seedFactV17(store, 'Huy', 'likes', 'tra da', { confidence: 0.2, episodeId: 'e-lo' });
      const now = new Date('2026-01-02T00:00:00.000Z');
      const access = { factId: hi.id, accessCount: 1, lastAccessedAt: '2026-01-02T00:00:00.000Z' };
      const hiScore = scorePassageV17(hi, access, V17_ARCHIVAL_SCORING_DEFAULTS, now);
      const loScore = scorePassageV17(lo, { factId: lo.id, accessCount: 1, lastAccessedAt: '2026-01-02T00:00:00.000Z' }, V17_ARCHIVAL_SCORING_DEFAULTS, now);
      return hiScore.score > loScore.score;
    },
  });
  cases.push({
    id: 'C3',
    category: 'scoring',
    name: 'Fact khong ai dung 90+ ngay thi stale',
    run: () => {
      const store = freshStore();
      const fact = seedFactV17(store, 'Huy', 'likes', 'ca phe', { episodeId: 'e-stale' });
      const now = new Date('2026-06-01T00:00:00.000Z');
      const scored = scorePassageV17(fact, undefined, V17_ARCHIVAL_SCORING_DEFAULTS, now);
      return scored.stale === true;
    },
  });
  cases.push({
    id: 'C4',
    category: 'scoring',
    name: 'Diem luon trong [0, 1]',
    run: () => {
      const store = freshStore();
      const fact = seedFactV17(store, 'Huy', 'likes', 'ca phe', { confidence: 1, episodeId: 'e-c4' });
      const scored = scorePassageV17(
        fact,
        { factId: fact.id, accessCount: 1000000, lastAccessedAt: '2026-01-02T00:00:00.000Z' },
        V17_ARCHIVAL_SCORING_DEFAULTS,
        new Date('2026-01-02T00:00:00.000Z'),
      );
      return scored.score >= 0 && scored.score <= 1;
    },
  });
  cases.push({
    id: 'C5',
    category: 'scoring',
    name: 'Trong so cau hinh duoc: access nang hon doi diem',
    run: () => {
      const store = freshStore();
      const fact = seedFactV17(store, 'Huy', 'likes', 'ca phe', { confidence: 0.5, episodeId: 'e-c5' });
      const now = new Date('2026-01-02T00:00:00.000Z');
      const access = { factId: fact.id, accessCount: 10, lastAccessedAt: '2026-01-02T00:00:00.000Z' };
      const a = scorePassageV17(fact, access, V17_ARCHIVAL_SCORING_DEFAULTS, now);
      const b = scorePassageV17(
        fact,
        access,
        { weights: { access: 1, confidence: 0, recency: 0, freshness: 0 }, thresholds: V17_ARCHIVAL_SCORING_DEFAULTS.thresholds },
        now,
      );
      return a.score !== b.score;
    },
  });

  // --- versioning (5) ---
  cases.push({
    id: 'V1',
    category: 'versioning',
    name: 'Commit 2 lan doi noi dung tao 2 commit noi nhau',
    run: () => {
      const dir = tmpDirV17('v17-eval-v1-');
      const store = new V15BlockStore();
      store.create('persona', 'persona', 'dong 1');
      const c1 = commitBlockV17(store, dir, 'persona', 'user', 'tao').commit;
      store.replace('persona', 'dong 1\ndong 2', 'user', 'them');
      const c2 = commitBlockV17(store, dir, 'persona', 'user', 'them').commit;
      return c2.parent === c1.hash && c1.hash !== c2.hash;
    },
  });
  cases.push({
    id: 'V2',
    category: 'versioning',
    name: 'Commit khi khong doi thi khong tao commit moi',
    run: () => {
      const dir = tmpDirV17('v17-eval-v2-');
      const store = new V15BlockStore();
      store.create('persona', 'persona', 'dong 1');
      commitBlockV17(store, dir, 'persona', 'user', 'tao');
      const again = commitBlockV17(store, dir, 'persona', 'user', 'tao lai');
      return again.created === false;
    },
  });
  cases.push({
    id: 'V3',
    category: 'versioning',
    name: 'Diff 2 commit thay added/removed dung',
    run: () => {
      const dir = tmpDirV17('v17-eval-v3-');
      const store = new V15BlockStore();
      store.create('persona', 'persona', 'dong 1');
      const c1 = commitBlockV17(store, dir, 'persona', 'user', 'tao').commit;
      store.replace('persona', 'dong 2', 'user', 'doi');
      const c2 = commitBlockV17(store, dir, 'persona', 'user', 'doi').commit;
      const diff = diffCommitsV17(dir, c1.hash, c2.hash);
      return diff.added === 1 && diff.removed === 1;
    },
  });
  cases.push({
    id: 'V4',
    category: 'versioning',
    name: 'Rollback ve commit cu khoi phuc noi dung',
    run: () => {
      const dir = tmpDirV17('v17-eval-v4-');
      const store = new V15BlockStore();
      store.create('persona', 'persona', 'dong 1');
      const c1 = commitBlockV17(store, dir, 'persona', 'user', 'tao').commit;
      store.replace('persona', 'dong 2', 'user', 'doi');
      commitBlockV17(store, dir, 'persona', 'user', 'doi');
      const { block } = rollbackToCommitV17(store, dir, 'persona', c1.hash, 'user', 'quay lai');
      return block.content === 'dong 1';
    },
  });
  cases.push({
    id: 'V5',
    category: 'versioning',
    name: 'Audit query loc theo author dung',
    run: () => {
      const dir = tmpDirV17('v17-eval-v5-');
      const store = new V15BlockStore();
      store.create('persona', 'persona', 'dong 1');
      commitBlockV17(store, dir, 'persona', 'alice', 'tao');
      store.replace('persona', 'dong 2', 'bob', 'doi');
      commitBlockV17(store, dir, 'persona', 'bob', 'doi');
      const found = queryBlockAuditV17(dir, { author: 'alice' });
      return found.length === 1 && found[0].label === 'persona';
    },
  });

  // --- guard (5) ---
  cases.push({
    id: 'G1',
    category: 'guard',
    name: 'Chain hong (episode khong ton tai) thi khong ok',
    run: () => {
      const store = freshStore();
      const candidate: V17AdmissionCandidate = {
        subject: 'Huy',
        predicate: 'likes',
        objectText: 'ca phe',
        confidence: 0.9,
        effectiveConfidence: 0.9,
        sourceTrust: 1,
        sourceText: 'Huy likes ca phe.',
        pattern: 'test',
        origin: 'rule',
        intent: 'assert',
        episodeId: 'ep-khong-co',
        turnId: 't1',
        runId: 'r1',
        botId: 'b1',
        userId: 'u1',
        at: '2026-01-01T00:00:00.000Z',
        sourceName: 'user-chat',
      };
      return verifyProvenanceChainV17(store, candidate).ok === false;
    },
  });
  cases.push({
    id: 'G2',
    category: 'guard',
    name: 'Nguon deny thi admit reject thang',
    run: () => {
      const dir = tmpDirV17('v17-eval-g2-');
      const store = freshStore();
      const seeded = seedFactV17(store, 'Huy', 'likes', 'ca phe', { episodeId: 'e1' });
      const candidate: V17AdmissionCandidate = {
        subject: 'Huy',
        predicate: 'likes',
        objectText: 'tra da',
        confidence: 0.9,
        effectiveConfidence: 0.9,
        sourceTrust: 1,
        sourceText: 'Huy likes tra da.',
        pattern: 'test',
        origin: 'rule',
        intent: 'assert',
        episodeId: seeded.provenance.episodeId,
        turnId: 't1',
        runId: 'r1',
        botId: 'b1',
        userId: 'u1',
        at: '2026-01-01T00:00:00.000Z',
        sourceName: 'web-xau',
      };
      const allowlist = new V16SourceAllowlist();
      allowlist.upsert('web-xau', 'deny', null, 'test', 'user');
      const result = admitCandidateV17(store, dir, candidate, SCOPE, 'web-xau', { allowlist });
      return result.decision === 'reject';
    },
  });
  cases.push({
    id: 'G3',
    category: 'guard',
    name: 'Fact cha khong ton tai thi chain khong ok',
    run: () => {
      const store = freshStore();
      const seeded = seedFactV17(store, 'Huy', 'likes', 'ca phe', { episodeId: 'e1' });
      const candidate: V17AdmissionCandidate = {
        subject: 'Huy',
        predicate: 'likes',
        objectText: 'tra da',
        confidence: 0.9,
        effectiveConfidence: 0.9,
        sourceTrust: 1,
        sourceText: 'Huy likes tra da.',
        pattern: 'test',
        origin: 'rule',
        intent: 'assert',
        episodeId: seeded.provenance.episodeId,
        turnId: 't1',
        runId: 'r1',
        botId: 'b1',
        userId: 'u1',
        at: '2026-01-01T00:00:00.000Z',
        sourceName: 'user-chat',
        parentFactIds: ['fact-khong-co'],
      };
      return verifyProvenanceChainV17(store, candidate).ok === false;
    },
  });
  cases.push({
    id: 'G4',
    category: 'guard',
    name: 'Admit reject ghi audit (doc lai duoc)',
    run: () => {
      const dir = tmpDirV17('v17-eval-g4-');
      const store = freshStore();
      const seeded = seedFactV17(store, 'Huy', 'likes', 'ca phe', { episodeId: 'e1' });
      const candidate: V17AdmissionCandidate = {
        subject: 'Huy',
        predicate: 'likes',
        objectText: 'tra da',
        confidence: 0.9,
        effectiveConfidence: 0.9,
        sourceTrust: 1,
        sourceText: 'Huy likes tra da.',
        pattern: 'test',
        origin: 'rule',
        intent: 'assert',
        episodeId: seeded.provenance.episodeId,
        turnId: 't1',
        runId: 'r1',
        botId: 'b1',
        userId: 'u1',
        at: '2026-01-01T00:00:00.000Z',
        sourceName: 'web-xau',
      };
      const allowlist = new V16SourceAllowlist();
      allowlist.upsert('web-xau', 'deny', null, 'test', 'user');
      admitCandidateV17(store, dir, candidate, SCOPE, 'web-xau', { allowlist });
      const audit = readV17AdmissionAudit(dir, 10);
      return audit.length === 1 && audit[0].decision === 'reject';
    },
  });
  cases.push({
    id: 'G5',
    category: 'guard',
    name: 'Chain day du (episode + fact cha ton tai) thi ok',
    run: () => {
      const store = freshStore();
      const parent = seedFactV17(store, 'Huy', 'likes', 'ca phe', { episodeId: 'e1' });
      const candidate: V17AdmissionCandidate = {
        subject: 'Huy',
        predicate: 'likes',
        objectText: 'tra da',
        confidence: 0.9,
        effectiveConfidence: 0.9,
        sourceTrust: 1,
        sourceText: 'Huy likes tra da.',
        pattern: 'test',
        origin: 'rule',
        intent: 'assert',
        episodeId: parent.provenance.episodeId,
        turnId: 't1',
        runId: 'r1',
        botId: 'b1',
        userId: 'u1',
        at: '2026-01-01T00:00:00.000Z',
        sourceName: 'user-chat',
        parentFactIds: [parent.id],
      };
      return verifyProvenanceChainV17(store, candidate).ok === true;
    },
  });

  return cases;
}

/** Chay eval v17 (25 case co dinh). */
export function runV17Eval(): V17EvalResult {
  const cases = buildV17EvalDataset();
  const results: V17EvalCaseResult[] = [];
  for (const c of cases) {
    try {
      const pass = c.run();
      results.push({ id: c.id, category: c.category, name: c.name, pass, error: null });
    } catch (err) {
      results.push({
        id: c.id,
        category: c.category,
        name: c.name,
        pass: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const categories: V17EvalCategoryScore[] = [];
  for (const cat of ['lifecycle', 'scheduler', 'scoring', 'versioning', 'guard'] as V17EvalCategory[]) {
    const total = results.filter((r) => r.category === cat).length;
    const passed = results.filter((r) => r.category === cat && r.pass).length;
    categories.push({ category: cat, total, passed, rate: total > 0 ? passed / total : 0 });
  }
  const passed = results.filter((r) => r.pass).length;
  const pass = categories.every((c) => c.rate >= (V17_EVAL_THRESHOLDS[c.category] ?? 1));
  return {
    at: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    rate: results.length > 0 ? passed / results.length : 0,
    categories,
    cases: results,
    pass,
  };
}

/** Format ket qua eval thanh text (de tool tra ve). */
export function formatV17EvalReport(result: V17EvalResult): string {
  const lines = [
    `Memory v17 eval: ${result.passed}/${result.total} pass (${(result.rate * 100).toFixed(0)}%) — ${result.pass ? 'PASS' : 'FAIL'}.`,
  ];
  for (const c of result.categories) {
    lines.push(`  - ${c.category}: ${c.passed}/${c.total} (${(c.rate * 100).toFixed(0)}%, nguong ${(V17_EVAL_THRESHOLDS[c.category] * 100).toFixed(0)}%)`);
  }
  for (const r of result.cases.filter((c) => !c.pass)) {
    lines.push(`  FAIL ${r.id} (${r.category}): ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }
  return lines.join('\n');
}
