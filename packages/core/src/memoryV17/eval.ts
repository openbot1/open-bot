/**
 * Memory v17 — Eval (v1.36, Doi T1).
 *
 * Eval 40 case, khong goi model, khong goi mang:
 *  - extraction (12 case): rule trich dung edge/object, noise bi loai,
 *    phu dinh phat hien, cua so hieu luc parse dung, dedupe trong pass.
 *  - conflict (10 case): single-valued mau thuan phat hien, multi-valued
 *    khong xung dot, phu dinh vs khang dinh, duplicate, auto-resolve
 *    dung strategy, merge bi chan voi single-valued.
 *  - fusion (8 case): query dung entity ve dung fact, keyword hiem
 *    thang, time-aware uu tien fact moi, scope khac khong lot ket qua.
 *  - bi-temporal (6 case): queryAt dung, asKnownAt dung, invalidate
 *    giu dong cu, supersede tro dung, timeline du buoc.
 *  - isolation (4 case): doc cheo scope bi chan + ghi violation,
 *    grant share mo doc, grant het han khong mo, scope rong bi cam.
 *
 * Moi case co ky vong ro rang; runner tra ti le pass theo category +
 * tong; nguong PASS mac dinh >= 90% tong va khong category nao < 80%.
 */

import {
  M17Scope,
  M17_DEFAULT_SCOPE,
  M17ExtractedFact,
} from './types';
import {
  M17ConflictQueue,
  autoResolveStrategyM17,
  detectConflictsM17,
  validateResolutionM17,
} from './conflicts';
import { M17BiTemporalStore } from './biTemporal';
import { fusionSearchM17 } from './fusion';
import { M17ScopeGuard, validateReadScopeM17 } from './scope';
import { M17Store } from './store';
import { extractTurnsSinglePassM17 } from './extraction';

/** Loi eval v17. */
export class M17EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M17EvalError';
  }
}

/** Category eval. */
export type M17EvalCategory = 'extraction' | 'conflict' | 'fusion' | 'bi-temporal' | 'isolation';

/** Mot case eval. */
export interface M17EvalCase {
  id: string;
  category: M17EvalCategory;
  title: string;
  /** Ham kiem tra: tra true neu pass, throw / tra false neu fail. */
  check: () => boolean | Promise<boolean>;
}

/** Ket qua 1 case. */
export interface M17EvalPerCase {
  id: string;
  category: M17EvalCategory;
  title: string;
  passed: boolean;
  detail: string;
}

/** Diem theo category. */
export interface M17EvalCategoryScore {
  category: M17EvalCategory;
  passed: number;
  total: number;
  rate: number;
}

/** Nguong PASS. */
export interface M17EvalThresholds {
  overallMin: number;
  perCategoryMin: number;
}

export const M17_EVAL_THRESHOLDS: M17EvalThresholds = {
  overallMin: 0.9,
  perCategoryMin: 0.8,
};

/** Ket qua eval. */
export interface M17EvalResult {
  total: number;
  passed: number;
  failed: number;
  rate: number;
  perCategory: M17EvalCategoryScore[];
  cases: M17EvalPerCase[];
  passedOverall: boolean;
  thresholds: M17EvalThresholds;
}

/** Tuy chon runner. */
export interface M17EvalOptions {
  thresholds?: Partial<M17EvalThresholds>;
  categories?: M17EvalCategory[];
}

const SCOPE_A: M17Scope = { tenantId: '', userId: 'user-a', botId: 'bot-1', conversationId: 'conv-1' };
const SCOPE_B: M17Scope = { tenantId: '', userId: 'user-b', botId: 'bot-1', conversationId: 'conv-1' };

function provenanceFor(scope: M17Scope): {
  episodeId: string;
  turnId: string;
  runId: string;
  botId: string;
  userId: string;
  sourceText: string;
} {
  return {
    episodeId: 'eval-ep',
    turnId: 'eval-turn',
    runId: 'eval-run',
    botId: scope.botId,
    userId: scope.userId,
    sourceText: 'eval',
  };
}

function factCandidate(
  edge: M17ExtractedFact['edge'],
  object: string,
  confidence = 0.85,
): M17ExtractedFact {
  return {
    subject: 'user',
    edge,
    object,
    confidence,
    isNegation: false,
    validFrom: null,
    validTo: null,
    mentionedEntities: [{ name: object, kind: 'other' }],
    sourceText: `Tôi ${edge} ${object}.`,
  };
}

/** Build dataset 40 case. */
export function buildM17EvalDataset(): M17EvalCase[] {
  const cases: M17EvalCase[] = [];

  // ---- extraction (12) ----
  cases.push({
    id: 'ext-01', category: 'extraction', title: 'Trich prefers tieng Viet',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: 'Tôi rất thích ăn phở bò.', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.some((c) => c.edge === 'prefers' && c.object.includes('phở'));
    },
  });
  cases.push({
    id: 'ext-02', category: 'extraction', title: 'Trich lives_in tieng Viet',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: 'Tôi đang sống ở Đà Nẵng.', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.some((c) => c.edge === 'lives_in' && c.object.includes('Đà Nẵng'));
    },
  });
  cases.push({
    id: 'ext-03', category: 'extraction', title: 'Trich works_at tieng Anh',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: 'I work at Acme Corp.', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.some((c) => c.edge === 'works_at' && c.object.includes('Acme'));
    },
  });
  cases.push({
    id: 'ext-04', category: 'extraction', title: 'Trich speaks language',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: 'Tôi nói tiếng Nhật.', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.some((c) => c.edge === 'speaks' && c.object.includes('Nhật'));
    },
  });
  cases.push({
    id: 'ext-05', category: 'extraction', title: 'Noise: chao hoi bi loai',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: 'Xin chào bạn!', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.length === 0 && res.noiseTurns === 1;
    },
  });
  cases.push({
    id: 'ext-06', category: 'extraction', title: 'Noise: cau hoi don thuan bi loai',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: 'Hôm nay trời thế nào?', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.length === 0;
    },
  });
  cases.push({
    id: 'ext-07', category: 'extraction', title: 'Phu dinh: khong con thich -> dislikes',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: 'Tôi không còn thích ăn phở bò nữa.', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.some((c) => c.edge === 'dislikes');
    },
  });
  cases.push({
    id: 'ext-08', category: 'extraction', title: 'Cua so hieu luc: tu thang 3/2026',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: 'Từ tháng 3/2026 tôi sống ở Đà Nẵng.', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.some((c) => c.validFrom?.startsWith('2026-03-01') === true);
    },
  });
  cases.push({
    id: 'ext-09', category: 'extraction', title: 'Dedupe trong pass: 2 cau giong nhau -> 1',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: 'Tôi thích ăn phở bò. Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.length === 1 && res.dedupedWithinPass === 1;
    },
  });
  cases.push({
    id: 'ext-10', category: 'extraction', title: 'Turn assistant bi bo qua (userTurnsOnly)',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'assistant', text: 'Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.length === 0;
    },
  });
  cases.push({
    id: 'ext-11', category: 'extraction', title: 'LLM call toi da 1 / pass',
    check: async () => {
      let calls = 0;
      const res = await extractTurnsSinglePassM17(
        [
          { role: 'user', text: 'Tôi thích ăn phở bò.', episodeId: 'e1', turnId: 't1' },
          { role: 'user', text: 'Tôi sống ở Hà Nội.', episodeId: 'e1', turnId: 't2' },
        ],
        {
          llmExtract: async () => {
            calls += 1;
            return [];
          },
        },
      );
      return calls === 1 && res.llmCalls === 1;
    },
  });
  cases.push({
    id: 'ext-12', category: 'extraction', title: 'Allergic_to tieng Anh',
    check: async () => {
      const res = await extractTurnsSinglePassM17([
        { role: 'user', text: "I'm allergic to peanuts.", episodeId: 'e1', turnId: 't1' },
      ]);
      return res.candidates.some((c) => c.edge === 'allergic_to' && c.object.includes('peanut'));
    },
  });

  // ---- conflict (10) ----
  cases.push({
    id: 'cf-01', category: 'conflict', title: 'Single-valued khac object -> conflict',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('lives_in', 'Hà Nội', 0.9), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const found = detectConflictsM17(
        factCandidate('lives_in', 'Đà Nẵng'),
        [old],
        SCOPE_A,
        '2026-11-18T00:00:00.000Z',
      );
      return found.length === 1 && found[0].kind !== 'duplicate';
    },
  });
  cases.push({
    id: 'cf-02', category: 'conflict', title: 'Multi-valued khac object -> khong conflict',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('prefers', 'phở bò', 0.9), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const found = detectConflictsM17(
        factCandidate('prefers', 'bún chả'),
        [old],
        SCOPE_A,
        '2026-11-18T00:00:00.000Z',
      );
      return found.length === 0;
    },
  });
  cases.push({
    id: 'cf-03', category: 'conflict', title: 'Duplicate -> kind duplicate, severity thap',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('prefers', 'phở bò', 0.9), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const found = detectConflictsM17(
        factCandidate('prefers', 'phở bò'),
        [old],
        SCOPE_A,
        '2026-11-18T00:00:00.000Z',
      );
      return found.length === 1 && found[0].kind === 'duplicate' && found[0].severity < 0.5;
    },
  });
  cases.push({
    id: 'cf-04', category: 'conflict', title: 'Phu dinh vs khang dinh -> conflict',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('prefers', 'phở bò', 0.9), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const neg = factCandidate('prefers', 'phở bò');
      neg.isNegation = true;
      const found = detectConflictsM17(neg, [old], SCOPE_A, '2026-11-18T00:00:00.000Z');
      return found.some((c) => c.kind === 'negation_vs_positive');
    },
  });
  cases.push({
    id: 'cf-05', category: 'conflict', title: 'Auto overwrite khi fact cu yeu + moi manh',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('lives_in', 'Hà Nội', 0.5), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const found = detectConflictsM17(
        factCandidate('lives_in', 'Đà Nẵng', 0.9),
        [old],
        SCOPE_A,
        '2026-11-18T00:00:00.000Z',
      );
      if (found.length !== 1) return false;
      return autoResolveStrategyM17(found[0], 0.5, 0.9) === 'overwrite';
    },
  });
  cases.push({
    id: 'cf-06', category: 'conflict', title: 'Fact cu manh -> pending, khong tu overwrite',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('lives_in', 'Hà Nội', 0.95), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const found = detectConflictsM17(
        factCandidate('lives_in', 'Đà Nẵng', 0.9),
        [old],
        SCOPE_A,
        '2026-11-18T00:00:00.000Z',
      );
      if (found.length !== 1) return false;
      return autoResolveStrategyM17(found[0], 0.95, 0.9) === 'pending';
    },
  });
  cases.push({
    id: 'cf-07', category: 'conflict', title: 'Merge bi chan voi edge don tri',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('lives_in', 'Hà Nội', 0.9), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const found = detectConflictsM17(
        factCandidate('lives_in', 'Đà Nẵng'),
        [old],
        SCOPE_A,
        '2026-11-18T00:00:00.000Z',
      );
      if (found.length !== 1) return false;
      return validateResolutionM17('merge', found[0], 'gop thu') !== null;
    },
  });
  cases.push({
    id: 'cf-08', category: 'conflict', title: 'Overwrite khong ly do bi chan',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('lives_in', 'Hà Nội', 0.9), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const found = detectConflictsM17(
        factCandidate('lives_in', 'Đà Nẵng'),
        [old],
        SCOPE_A,
        '2026-11-18T00:00:00.000Z',
      );
      if (found.length !== 1) return false;
      return validateResolutionM17('overwrite', found[0], '') !== null;
    },
  });
  cases.push({
    id: 'cf-09', category: 'conflict', title: 'Queue: enqueue + resolve khoi pending',
    check: () => {
      const queue = new M17ConflictQueue();
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('lives_in', 'Hà Nội', 0.95), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const found = detectConflictsM17(
        factCandidate('lives_in', 'Đà Nẵng'),
        [old],
        SCOPE_A,
        '2026-11-18T00:00:00.000Z',
      );
      if (found.length !== 1) return false;
      queue.enqueue(found[0]);
      const pendingAfterEnqueue = queue.pendingCount;
      if (pendingAfterEnqueue !== 1) return false;
      queue.resolve(found[0].id, 'keep_both', 'user', 'Giu ca hai noi da song.', '2026-11-18T00:00:00.000Z');
      const pendingAfterResolve = queue.pendingCount;
      const resolvedAfterResolve = queue.resolvedCount;
      return pendingAfterResolve === 0 && resolvedAfterResolve === 1;
    },
  });
  cases.push({
    id: 'cf-10', category: 'conflict', title: 'Store resolve overwrite: cu superseded, moi active',
    check: async () => {
      const store = new M17Store({ autoResolve: false });
      await store.ingestTurns(
        [{ role: 'user', text: 'Tôi đang sống ở Hà Nội.', episodeId: 'e1', turnId: 't1' }],
        SCOPE_A,
      );
      await store.ingestTurns(
        [{ role: 'user', text: 'Tôi đang sống ở Đà Nẵng.', episodeId: 'e2', turnId: 't1' }],
        SCOPE_A,
      );
      if (store.conflicts.pendingCount !== 1) return false;
      const pending = store.conflicts.listPending()[0];
      const { resultingFact } = store.resolvePendingConflict(
        pending.id,
        'overwrite',
        'user',
        'User da chuyen nha.',
        SCOPE_A,
      );
      if (!resultingFact) return false;
      const oldFact = store.graph.getFact(pending.existingFactId);
      return oldFact?.status === 'superseded' && resultingFact.status === 'active';
    },
  });

  // ---- fusion (8) ----
  cases.push({
    id: 'fu-01', category: 'fusion', title: 'Query dung object -> hit dau tien',
    check: () => {
      const store = new M17BiTemporalStore();
      store.addFact(factCandidate('prefers', 'phở bò'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      store.addFact(factCandidate('prefers', 'bún chả'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      const res = fusionSearchM17(
        'phở bò',
        store.listActive(SCOPE_A, { limit: 100 }).facts,
        SCOPE_A,
        { atIso: '2026-11-18T00:00:00.000Z' },
      );
      return res.hits.length > 0 && res.hits[0].fact.object.includes('phở');
    },
  });
  cases.push({
    id: 'fu-02', category: 'fusion', title: 'Keyword hiem (BM25) thang embedding mo',
    check: () => {
      const store = new M17BiTemporalStore();
      store.addFact(factCandidate('uses', 'Obsidian'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      store.addFact(factCandidate('prefers', 'phở bò'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      const res = fusionSearchM17(
        'Obsidian',
        store.listActive(SCOPE_A, { limit: 100 }).facts,
        SCOPE_A,
        { weights: { keyword: 0.8, semantic: 0.1, entity: 0.05, time: 0.05 } },
      );
      return res.hits.length > 0 && res.hits[0].fact.object === 'Obsidian';
    },
  });
  cases.push({
    id: 'fu-03', category: 'fusion', title: 'Entity score: query co entity khop',
    check: () => {
      const store = new M17BiTemporalStore();
      store.addFact(factCandidate('lives_in', 'Đà Nẵng'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      const res = fusionSearchM17(
        'Đà Nẵng ở đâu',
        store.listActive(SCOPE_A, { limit: 100 }).facts,
        SCOPE_A,
        { queryEntities: ['Đà Nẵng'] },
      );
      return res.hits.length > 0 && res.hits[0].score.entity >= 0.7;
    },
  });
  cases.push({
    id: 'fu-04', category: 'fusion', title: 'Score breakdown du 4 tin hieu 0..1',
    check: () => {
      const store = new M17BiTemporalStore();
      store.addFact(factCandidate('prefers', 'phở bò'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      const res = fusionSearchM17(
        'phở',
        store.listActive(SCOPE_A, { limit: 100 }).facts,
        SCOPE_A,
      );
      if (res.hits.length === 0) return false;
      const s = res.hits[0].score;
      return [s.semantic, s.keyword, s.entity, s.time, s.total].every(
        (v) => v >= 0 && v <= 1,
      );
    },
  });
  cases.push({
    id: 'fu-05', category: 'fusion', title: 'Time-aware: fact moi hon duoc uu tien',
    check: () => {
      const store = new M17BiTemporalStore();
      store.addFact(factCandidate('prefers', 'phở bò'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2025-01-01T00:00:00.000Z',
      });
      store.addFact(factCandidate('prefers', 'phở gà'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-17T00:00:00.000Z',
      });
      const res = fusionSearchM17(
        'phở',
        store.listActive(SCOPE_A, { limit: 100 }).facts,
        SCOPE_A,
        { weights: { semantic: 0.1, keyword: 0.1, entity: 0.1, time: 0.7 } },
      );
      return res.hits.length >= 2 && res.hits[0].fact.object.includes('gà');
    },
  });
  cases.push({
    id: 'fu-06', category: 'fusion', title: 'Loc theo edge',
    check: () => {
      const store = new M17BiTemporalStore();
      store.addFact(factCandidate('prefers', 'phở bò'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      store.addFact(factCandidate('lives_in', 'Hà Nội'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      const res = fusionSearchM17(
        'Hà Nội',
        store.listActive(SCOPE_A, { limit: 100 }).facts,
        SCOPE_A,
        { edge: 'lives_in' },
      );
      return res.hits.length === 1 && res.hits[0].fact.edge === 'lives_in';
    },
  });
  cases.push({
    id: 'fu-07', category: 'fusion', title: 'Scope khac khong lot ket qua fusion',
    check: () => {
      const store = new M17BiTemporalStore();
      store.addFact(factCandidate('prefers', 'phở bò'), SCOPE_B, {
        provenance: provenanceFor(SCOPE_B),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      const res = fusionSearchM17(
        'phở bò',
        store.listActive(SCOPE_A, { limit: 100 }).facts,
        SCOPE_A,
      );
      return res.hits.length === 0 && res.considered === 0;
    },
  });
  cases.push({
    id: 'fu-08', category: 'fusion', title: 'Query rong bi tu choi',
    check: () => {
      try {
        fusionSearchM17('', [], SCOPE_A);
        return false;
      } catch {
        return true;
      }
    },
  });

  // ---- bi-temporal (6) ----
  cases.push({
    id: 'bt-01', category: 'bi-temporal', title: 'queryAt: fact dung tai T',
    check: () => {
      const store = new M17BiTemporalStore();
      const fact = factCandidate('lives_in', 'Hà Nội');
      fact.validFrom = '2020-01-01T00:00:00.000Z';
      fact.validTo = '2026-06-01T00:00:00.000Z';
      store.addFact(fact, SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const at2024 = store.factsValidAt(SCOPE_A, '2024-05-01T00:00:00.000Z');
      const at2027 = store.factsValidAt(SCOPE_A, '2027-01-01T00:00:00.000Z');
      return at2024.facts.length === 1 && at2027.facts.length === 0;
    },
  });
  cases.push({
    id: 'bt-02', category: 'bi-temporal', title: 'asKnownAt: chua hoc thi chua biet',
    check: () => {
      const store = new M17BiTemporalStore();
      store.addFact(factCandidate('prefers', 'phở bò'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-10T00:00:00.000Z',
      });
      const before = store.factsAsKnownAt(SCOPE_A, '2026-11-01T00:00:00.000Z');
      const after = store.factsAsKnownAt(SCOPE_A, '2026-11-15T00:00:00.000Z');
      return before.facts.length === 0 && after.facts.length === 1;
    },
  });
  cases.push({
    id: 'bt-03', category: 'bi-temporal', title: 'Invalidate giu dong cu (khong xoa)',
    check: () => {
      const store = new M17BiTemporalStore();
      const fact = store.addFact(factCandidate('prefers', 'phở bò'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-01T00:00:00.000Z',
      });
      store.invalidateFact(fact.id, SCOPE_A, 'User bao sai.', '2026-11-18T00:00:00.000Z');
      const kept = store.getFact(fact.id);
      return kept !== null && kept.status === 'invalidated' && store.totalFacts === 1;
    },
  });
  cases.push({
    id: 'bt-04', category: 'bi-temporal', title: 'Supersede: cu dong validTo + tro sang moi',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('lives_in', 'Hà Nội'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const next = store.addFact(factCandidate('lives_in', 'Đà Nẵng'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-18T00:00:00.000Z',
      });
      store.supersedeFact(old.id, next.id, SCOPE_A, 'Chuyen nha.', '2026-11-18T00:00:00.000Z');
      const oldAfter = store.getFact(old.id);
      return (
        oldAfter?.status === 'superseded' &&
        oldAfter.supersededById === next.id &&
        oldAfter.validTo === '2026-11-18T00:00:00.000Z'
      );
    },
  });
  cases.push({
    id: 'bt-05', category: 'bi-temporal', title: 'Timeline du buoc learned + superseded',
    check: () => {
      const store = new M17BiTemporalStore();
      const old = store.addFact(factCandidate('lives_in', 'Hà Nội'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const next = store.addFact(factCandidate('lives_in', 'Đà Nẵng'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-18T00:00:00.000Z',
      });
      store.supersedeFact(old.id, next.id, SCOPE_A, 'Chuyen nha.', '2026-11-18T00:00:00.000Z');
      const steps = store.factTimeline(old.id, SCOPE_A);
      return steps.some((s) => s.kind === 'learned') && steps.some((s) => s.kind === 'superseded');
    },
  });
  cases.push({
    id: 'bt-06', category: 'bi-temporal', title: 'Supersession chain truy vet duoc',
    check: () => {
      const store = new M17BiTemporalStore();
      const f1 = store.addFact(factCandidate('lives_in', 'Hà Nội'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-01-01T00:00:00.000Z',
      });
      const f2 = store.addFact(factCandidate('lives_in', 'Đà Nẵng'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-06-01T00:00:00.000Z',
      });
      const f3 = store.addFact(factCandidate('lives_in', 'Huế'), SCOPE_A, {
        provenance: provenanceFor(SCOPE_A),
        learnedAt: '2026-11-18T00:00:00.000Z',
      });
      store.supersedeFact(f1.id, f2.id, SCOPE_A, 'Chuyen 1.', '2026-06-01T00:00:00.000Z');
      store.supersedeFact(f2.id, f3.id, SCOPE_A, 'Chuyen 2.', '2026-11-18T00:00:00.000Z');
      const chain = store.supersessionChain(f3.id, SCOPE_A);
      return chain.length === 3 && chain[0].id === f1.id && chain[2].id === f3.id;
    },
  });

  // ---- isolation (4) ----
  cases.push({
    id: 'iso-01', category: 'isolation', title: 'Doc cheo scope bi chan + ghi violation',
    check: () => {
      const guard = new M17ScopeGuard();
      const check = guard.guardRead(SCOPE_A, SCOPE_B, 'read', '2026-11-18T00:00:00.000Z');
      return !check.allowed && guard.violationCount === 1;
    },
  });
  cases.push({
    id: 'iso-02', category: 'isolation', title: 'Grant share mo doc cheo scope',
    check: () => {
      const guard = new M17ScopeGuard();
      guard.grantRead(SCOPE_A, SCOPE_B, 'user-a', '2026-11-18T00:00:00.000Z');
      const check = guard.guardRead(SCOPE_A, SCOPE_B, 'read', '2026-11-18T00:00:00.000Z');
      return check.allowed && check.viaGrant;
    },
  });
  cases.push({
    id: 'iso-03', category: 'isolation', title: 'Grant het han khong mo doc',
    check: () => {
      const guard = new M17ScopeGuard();
      guard.grantRead(SCOPE_A, SCOPE_B, 'user-a', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
      const check = guard.guardRead(SCOPE_A, SCOPE_B, 'read', '2026-11-18T00:00:00.000Z');
      return !check.allowed;
    },
  });
  cases.push({
    id: 'iso-04', category: 'isolation', title: 'Scope rong toan cuc bi cam doc',
    check: () => {
      const emptyScope: M17Scope = { ...M17_DEFAULT_SCOPE, userId: '' };
      return validateReadScopeM17(emptyScope) !== null;
    },
  });

  return cases;
}

/** Chay eval (loc theo category neu co). */
export async function runM17Eval(options: M17EvalOptions = {}): Promise<M17EvalResult> {
  const thresholds: M17EvalThresholds = {
    overallMin: options.thresholds?.overallMin ?? M17_EVAL_THRESHOLDS.overallMin,
    perCategoryMin: options.thresholds?.perCategoryMin ?? M17_EVAL_THRESHOLDS.perCategoryMin,
  };
  const all = buildM17EvalDataset();
  const dataset = options.categories
    ? all.filter((c) => options.categories?.includes(c.category))
    : all;
  const results: M17EvalPerCase[] = [];
  for (const testCase of dataset) {
    try {
      const passed = (await testCase.check()) === true;
      results.push({
        id: testCase.id,
        category: testCase.category,
        title: testCase.title,
        passed,
        detail: passed ? 'PASS' : 'FAIL: check tra false.',
      });
    } catch (err) {
      results.push({
        id: testCase.id,
        category: testCase.category,
        title: testCase.title,
        passed: false,
        detail: `FAIL: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  const perCategory: M17EvalCategoryScore[] = [];
  for (const category of ['extraction', 'conflict', 'fusion', 'bi-temporal', 'isolation'] as M17EvalCategory[]) {
    const inCategory = results.filter((r) => r.category === category);
    if (inCategory.length === 0) continue;
    const catPassed = inCategory.filter((r) => r.passed).length;
    perCategory.push({
      category,
      passed: catPassed,
      total: inCategory.length,
      rate: catPassed / inCategory.length,
    });
  }
  const rate = results.length === 0 ? 0 : passed / results.length;
  const passedOverall =
    rate >= thresholds.overallMin &&
    perCategory.every((c) => c.rate >= thresholds.perCategoryMin);
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    rate,
    perCategory,
    cases: results,
    passedOverall,
    thresholds,
  };
}

/** Format bao cao eval thanh text. */
export function formatM17EvalReport(result: M17EvalResult): string {
  const lines = [
    `Memory v17 eval: ${result.passed}/${result.total} PASS (${(result.rate * 100).toFixed(1)}%) — ` +
      (result.passedOverall ? 'PASS' : 'FAIL'),
  ];
  for (const category of result.perCategory) {
    lines.push(
      `  - ${category.category}: ${category.passed}/${category.total} (${(category.rate * 100).toFixed(1)}%)`,
    );
  }
  const failed = result.cases.filter((c) => !c.passed);
  if (failed.length > 0) {
    lines.push('  Case FAIL:');
    for (const f of failed) {
      lines.push(`    * [${f.id}] ${f.title}: ${f.detail}`);
    }
  }
  return lines.join('\n');
}
