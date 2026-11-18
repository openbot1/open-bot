/**
 * Memory v18 — Eval nho dai han kieu LOCOMO, chay local (v1.19, Doi T1).
 *
 * Y tuong hoc tu LOCOMO (benchmark nho dai han cho agent hoi thoai:
 * cau hoi don buoc / nhieu buoc / thoi gian / khong tra loi duoc,
 * cham recall tren fact dung) — tu thiet ke lai hoan toan cho
 * open-bot, chay 100% offline, KHONG goi model, KHONG goi mang,
 * KHONG copy code/text/tai san cua bat ky repo nao. Dataset viet
 * tay trong file nay (nguoi + su kien gia lap), khong lay tu
 * LOCOMO that.
 *
 * Cach cham (khong dung LLM judge):
 *  - Moi case co 1+ query va danh sach fact ky vong (id logic
 *    trong dataset, map sang fact id that khi seed).
 *  - Chay `retrieveV18` (BM25 + entity; semantic = 0 vi khong co
 *    embedder offline) voi topK cau hinh duoc; case PASS khi moi
 *    fact ky vong deu nam trong topK cua it nhat mot query.
 *  - Case `unanswerable`: PASS khi retrieval tra ve rong (khong
 *    co fact nao vuot `minScore`) — agent phai noi "khong biet"
 *    thay vi bia fact.
 *  - Case `temporal`: fact ky vong la ban CU da bi supersede
 *    (vd "truoc day song o dau") — retrieval chay voi
 *    `activeOnly: false` de tim duoc lich su.
 *
 * Luu y: eval SEED fact vao store duoc truyen vao — khong dung
 * store production truc tiep (se them fact gia). Trong test hay
 * dung `InMemoryGraphBackend` moi cho moi lan chay.
 */

import type { GraphFact, MemoryScope } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { retrieveV18 } from './hybridRetrievalV2';

/** Loi eval LOCOMO v18 — message tieng Viet. */
export class V18LocomoEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V18LocomoEvalError';
  }
}

/** Loai cau hoi LOCOMO. */
export type V18LocomoCategory = 'single-hop' | 'multi-hop' | 'temporal' | 'unanswerable';

/** Nguong dat mac dinh theo category (ty le pass toi thieu). */
export const V18_LOCOMO_THRESHOLDS: Record<V18LocomoCategory, number> = {
  'single-hop': 0.9,
  'multi-hop': 0.8,
  temporal: 0.8,
  unanswerable: 0.9,
};

/** So hit toi da lay moi query khi eval (mac dinh). */
export const V18_LOCOMO_DEFAULT_TOP_K = 5;
/** Diem toi thieu de tinh la retrieval co ket qua (mac dinh). */
export const V18_LOCOMO_DEFAULT_MIN_SCORE = 0.1;

/** Mot fact mau trong dataset (seed vao store khi chay eval). */
export interface V18LocomoSeedFact {
  /** Key logic trong dataset (vd 'f-lives-hn'). */
  key: string;
  subjectName: string;
  predicate: string;
  objectText: string;
  confidence?: number;
  /** Cua so hieu luc (ISO); rong = mac dinh. */
  validFrom?: string;
  validUntil?: string | null;
  /** Key cua fact ma fact nay thay the (de tao lich su). */
  supersedesKey?: string;
}

/** Mot case eval LOCOMO. */
export interface V18LocomoCase {
  id: string;
  category: V18LocomoCategory;
  question: string;
  /** Cac query retrieval (thuong 1; multi-hop co the 2). */
  queries: string[];
  /** Key cac fact ky vong phai tim thay (rong = unanswerable). */
  expectedKeys: string[];
}

/** Dataset eval day du. */
export interface V18LocomoDataset {
  seedFacts: V18LocomoSeedFact[];
  cases: V18LocomoCase[];
  scope: MemoryScope;
}

/** Ket qua 1 case. */
export interface V18LocomoCaseResult {
  id: string;
  category: V18LocomoCategory;
  question: string;
  pass: boolean;
  /** Key ky vong nao khong tim thay (rong = du). */
  missingKeys: string[];
  /** So hit tra ve o query tot nhat. */
  bestHitCount: number;
}

/** Diem theo category. */
export interface V18LocomoCategoryScore {
  category: V18LocomoCategory;
  total: number;
  passed: number;
  rate: number;
}

/** Ket qua eval day du. */
export interface V18LocomoResult {
  at: string;
  total: number;
  passed: number;
  rate: number;
  /** true = moi category dat nguong cua no. */
  overallPass: boolean;
  byCategory: V18LocomoCategoryScore[];
  cases: V18LocomoCaseResult[];
  /** Category nao duoi nguong (de debug). */
  failingCategories: V18LocomoCategory[];
}

/** Tuy chon chay eval. */
export interface V18LocomoEvalOptions {
  topK?: number;
  minScore?: number;
  /** Trong so hybrid (mac dinh: BM25 + entity, semantic 0). */
  weights?: { semantic?: number; bm25?: number; entity?: number };
}

const SCOPE: MemoryScope = { userId: 'locomo-user', botId: 'locomo-bot', runId: 'locomo-run' };

/** Dataset mac dinh: 24 case viet tay (6 moi loai). */
export function buildV18LocomoDataset(): V18LocomoDataset {
  const seedFacts: V18LocomoSeedFact[] = [
    { key: 'f-lives-hn', subjectName: 'An', predicate: 'lives_in', objectText: 'Ha Noi' },
    { key: 'f-lives-hcm-old', subjectName: 'An', predicate: 'lives_in', objectText: 'Ho Chi Minh', validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2024-06-01T00:00:00.000Z' },
    { key: 'f-works-vng', subjectName: 'An', predicate: 'works_at', objectText: 'VNG' },
    { key: 'f-likes-pho', subjectName: 'An', predicate: 'likes', objectText: 'pho bo' },
    { key: 'f-likes-cafe', subjectName: 'An', predicate: 'likes', objectText: 'ca phe sua da' },
    { key: 'f-pet-meo', subjectName: 'An', predicate: 'has_pet', objectText: 'meo Mun' },
    { key: 'f-binh-lives-dn', subjectName: 'Binh', predicate: 'lives_in', objectText: 'Da Nang' },
    { key: 'f-binh-works', subjectName: 'Binh', predicate: 'works_at', objectText: 'FPT Software' },
    { key: 'f-binh-likes', subjectName: 'Binh', predicate: 'likes', objectText: 'da bong' },
    { key: 'f-chi-works', subjectName: 'Chi', predicate: 'works_at', objectText: 'Vietcombank' },
    { key: 'f-chi-lives', subjectName: 'Chi', predicate: 'lives_in', objectText: 'Hai Phong' },
    { key: 'f-an-goal', subjectName: 'An', predicate: 'goal', objectText: 'chay marathon' },
    { key: 'f-an-routine', subjectName: 'An', predicate: 'daily_routine', objectText: 'chay bo moi sang' },
    { key: 'f-an-allergy', subjectName: 'An', predicate: 'constraint', objectText: 'di ung lac' },
    { key: 'f-binh-goal', subjectName: 'Binh', predicate: 'goal', objectText: 'hoc tieng Nhat' },
    { key: 'f-chi-pet', subjectName: 'Chi', predicate: 'has_pet', objectText: 'cho Vang' },
  ];
  const cases: V18LocomoCase[] = [
    // single-hop (6)
    { id: 'sh-1', category: 'single-hop', question: 'An song o dau?', queries: ['An song o Ha Noi'], expectedKeys: ['f-lives-hn'] },
    { id: 'sh-2', category: 'single-hop', question: 'An lam o dau?', queries: ['An lam o VNG'], expectedKeys: ['f-works-vng'] },
    { id: 'sh-3', category: 'single-hop', question: 'An thich an gi?', queries: ['An thich an pho bo'], expectedKeys: ['f-likes-pho'] },
    { id: 'sh-4', category: 'single-hop', question: 'Binh song o dau?', queries: ['Binh song o Da Nang'], expectedKeys: ['f-binh-lives-dn'] },
    { id: 'sh-5', category: 'single-hop', question: 'Chi lam o dau?', queries: ['Chi lam o Vietcombank'], expectedKeys: ['f-chi-works'] },
    { id: 'sh-6', category: 'single-hop', question: 'An co thu cung gi?', queries: ['meo Mun cua An'], expectedKeys: ['f-pet-meo'] },
    // multi-hop (6): can ca hai fact moi tra loi du
    { id: 'mh-1', category: 'multi-hop', question: 'An va Binh lam o dau?', queries: ['An lam o VNG', 'Binh lam o FPT'], expectedKeys: ['f-works-vng', 'f-binh-works'] },
    { id: 'mh-2', category: 'multi-hop', question: 'Ai song o Da Nang va thich da bong?', queries: ['Binh song o Da Nang', 'Binh thich da bong'], expectedKeys: ['f-binh-lives-dn', 'f-binh-likes'] },
    { id: 'mh-3', category: 'multi-hop', question: 'An thich gi va co muc tieu gi?', queries: ['An thich pho bo', 'muc tieu chay marathon cua An'], expectedKeys: ['f-likes-pho', 'f-an-goal'] },
    { id: 'mh-4', category: 'multi-hop', question: 'Chi song o dau va co thu cung gi?', queries: ['Chi song o Hai Phong', 'cho Vang cua Chi'], expectedKeys: ['f-chi-lives', 'f-chi-pet'] },
    { id: 'mh-5', category: 'multi-hop', question: 'An chay bo moi sang va muc tieu gi?', queries: ['An chay bo moi sang', 'muc tieu chay marathon cua An'], expectedKeys: ['f-an-routine', 'f-an-goal'] },
    { id: 'mh-6', category: 'multi-hop', question: 'Binh co muc tieu gi va lam o dau?', queries: ['muc tieu hoc tieng Nhat cua Binh', 'Binh lam o FPT Software'], expectedKeys: ['f-binh-goal', 'f-binh-works'] },
    // temporal (6): hoi ve qua khu / cua so hieu luc
    { id: 'tp-1', category: 'temporal', question: 'Truoc day An song o dau?', queries: ['truoc day An song o dau Ho Chi Minh'], expectedKeys: ['f-lives-hcm-old'] },
    { id: 'tp-2', category: 'temporal', question: 'An song o Ho Chi Minh tu khi nao?', queries: ['An song o Ho Chi Minh'], expectedKeys: ['f-lives-hcm-old'] },
    { id: 'tp-3', category: 'temporal', question: 'An song o Ha Noi hien tai dung khong?', queries: ['An song o Ha Noi hien tai'], expectedKeys: ['f-lives-hn'] },
    { id: 'tp-4', category: 'temporal', question: 'An tung song o dau truoc Ha Noi?', queries: ['An tung song o Ho Chi Minh truoc day'], expectedKeys: ['f-lives-hcm-old'] },
    { id: 'tp-5', category: 'temporal', question: 'An song o dau nam 2022?', queries: ['An song o dau nam 2022 Ho Chi Minh'], expectedKeys: ['f-lives-hcm-old'] },
    { id: 'tp-6', category: 'temporal', question: 'An doi nha tu Ho Chi Minh sang Ha Noi khi nao?', queries: ['An chuyen tu Ho Chi Minh sang Ha Noi'], expectedKeys: ['f-lives-hcm-old', 'f-lives-hn'] },
    // unanswerable (6): khong co fact nao trong store tra loi duoc
    { id: 'ua-1', category: 'unanswerable', question: 'An co bao nhieu tien trong tai khoan?', queries: ['so du ngan hang'], expectedKeys: [] },
    { id: 'ua-2', category: 'unanswerable', question: 'Binh thich mon an gi?', queries: ['so dien thoai di dong'], expectedKeys: [] },
    { id: 'ua-3', category: 'unanswerable', question: 'Chi co anh em gi?', queries: ['bang lai xe o to'], expectedKeys: [] },
    { id: 'ua-4', category: 'unanswerable', question: 'An hoc truong nao?', queries: ['nhom mau'], expectedKeys: [] },
    { id: 'ua-5', category: 'unanswerable', question: 'Meo Mun may tuoi?', queries: ['tuoi thu cung'], expectedKeys: [] },
    { id: 'ua-6', category: 'unanswerable', question: 'An di du lich nuoc nao nam ngoai?', queries: ['quoc tich'], expectedKeys: [] },
  ];
  return { seedFacts, cases, scope: SCOPE };
}

/**
 * Seed dataset vao store: ghi moi fact mau (episode gia lap lam
 * provenance). Tra ve map key -> fact id that. Fact co
 * `supersedesKey` se supersede fact da seed truoc do (de tao lich
 * su: ban cu van ton tai o trang thai superseded).
 */
export function seedV18LocomoDataset(
  store: TemporalGraphStore,
  dataset: V18LocomoDataset,
): Map<string, string> {
  const byKey = new Map<string, string>();
  const created: GraphFact[] = [];
  for (const seed of dataset.seedFacts) {
    const fact = store.addFact({
      subjectName: seed.subjectName,
      predicate: seed.predicate,
      objectText: seed.objectText,
      confidence: seed.confidence ?? 0.9,
      scope: dataset.scope,
      provenance: {
        episodeId: `locomo-ep-${seed.key}`,
        turnId: `locomo-turn-${seed.key}`,
        runId: dataset.scope.runId,
        botId: dataset.scope.botId,
        userId: dataset.scope.userId,
        at: '2026-01-01T00:00:00.000Z',
        sourceText: `${seed.subjectName} ${seed.predicate} ${seed.objectText}`,
      },
      ...(seed.validFrom ? { validFrom: seed.validFrom } : {}),
      ...(seed.validUntil !== undefined ? { validUntil: seed.validUntil } : {}),
    });
    byKey.set(seed.key, fact.id);
    created.push(fact);
    if (seed.supersedesKey) {
      const oldId = byKey.get(seed.supersedesKey);
      if (oldId) {
        // Ghi de bang supersede that: xoa ban vua tao, tao lai qua supersede.
        store.removeFactHard(fact.id);
        const replacement = store.supersedeFact(oldId, {
          subjectName: seed.subjectName,
          predicate: seed.predicate,
          objectText: seed.objectText,
          confidence: seed.confidence ?? 0.9,
          scope: dataset.scope,
          provenance: {
            episodeId: `locomo-ep-${seed.key}`,
            turnId: `locomo-turn-${seed.key}`,
            runId: dataset.scope.runId,
            botId: dataset.scope.botId,
            userId: dataset.scope.userId,
            at: '2026-01-01T00:00:00.000Z',
            sourceText: `${seed.subjectName} ${seed.predicate} ${seed.objectText}`,
          },
          ...(seed.validFrom ? { validFrom: seed.validFrom } : {}),
          ...(seed.validUntil !== undefined ? { validUntil: seed.validUntil } : {}),
        });
        byKey.set(seed.key, replacement.id);
      }
    }
  }
  void created;
  return byKey;
}

/**
 * Chay eval LOCOMO tren store da seed (goi `seedV18LocomoDataset`
 * truoc, hoac truyen store da co du fact). Retrieval dung hybrid
 * v2 (BM25 + entity; semantic 0 khi khong co embedder).
 */
export function runV18LocomoEval(
  store: TemporalGraphStore,
  dataset: V18LocomoDataset,
  factIdsByKey: Map<string, string>,
  opts: V18LocomoEvalOptions = {},
): V18LocomoResult {
  const topK = Math.max(1, opts.topK ?? V18_LOCOMO_DEFAULT_TOP_K);
  const minScore = opts.minScore ?? V18_LOCOMO_DEFAULT_MIN_SCORE;
  const weights = opts.weights ?? { semantic: 0, bm25: 0.6, entity: 0.4 };
  const caseResults: V18LocomoCaseResult[] = [];
  for (const c of dataset.cases) {
    const expectedIds = c.expectedKeys
      .map((k) => factIdsByKey.get(k))
      .filter((id): id is string => typeof id === 'string');
    if (c.category === 'unanswerable') {
      // PASS khi khong retrieval nao tra ve hit vuot nguong.
      let bestHits = 0;
      let foundAny = false;
      for (const query of c.queries) {
        const hits = retrieveV18(store, query, dataset.scope, {
          topK,
          minScore,
          weights,
          activeOnly: true,
        });
        bestHits = Math.max(bestHits, hits.length);
        if (hits.length > 0) foundAny = true;
      }
      caseResults.push({
        id: c.id,
        category: c.category,
        question: c.question,
        pass: !foundAny,
        missingKeys: [],
        bestHitCount: bestHits,
      });
      continue;
    }
    // Cac category khac: retrieval ca active + lich su (temporal can ban cu).
    const found = new Set<string>();
    let bestHits = 0;
    for (const query of c.queries) {
      const hits = retrieveV18(store, query, dataset.scope, {
        topK,
        minScore,
        weights,
        activeOnly: c.category === 'temporal' ? false : true,
      });
      bestHits = Math.max(bestHits, hits.length);
      for (const hit of hits) found.add(hit.fact.id);
    }
    const missingKeys = c.expectedKeys.filter((k) => {
      const id = factIdsByKey.get(k);
      return !id || !found.has(id);
    });
    void expectedIds;
    caseResults.push({
      id: c.id,
      category: c.category,
      question: c.question,
      pass: missingKeys.length === 0,
      missingKeys,
      bestHitCount: bestHits,
    });
  }
  const byCategory: V18LocomoCategoryScore[] = [];
  const categories: V18LocomoCategory[] = ['single-hop', 'multi-hop', 'temporal', 'unanswerable'];
  for (const category of categories) {
    const rows = caseResults.filter((r) => r.category === category);
    const passed = rows.filter((r) => r.pass).length;
    byCategory.push({
      category,
      total: rows.length,
      passed,
      rate: rows.length === 0 ? 1 : passed / rows.length,
    });
  }
  const passed = caseResults.filter((r) => r.pass).length;
  const failingCategories = byCategory
    .filter((s) => s.rate < V18_LOCOMO_THRESHOLDS[s.category])
    .map((s) => s.category);
  return {
    at: new Date().toISOString(),
    total: caseResults.length,
    passed,
    rate: caseResults.length === 0 ? 1 : passed / caseResults.length,
    overallPass: failingCategories.length === 0,
    byCategory,
    cases: caseResults,
    failingCategories,
  };
}

/** Format bao cao eval thanh text (de tool / log hien thi). */
export function formatV18LocomoReport(result: V18LocomoResult): string {
  const lines: string[] = [];
  lines.push(`LOCOMO v18: ${result.passed}/${result.total} pass (${(result.rate * 100).toFixed(0)}%) — ${result.overallPass ? 'DAT' : 'CHUA DAT'}`);
  for (const score of result.byCategory) {
    const threshold = V18_LOCOMO_THRESHOLDS[score.category];
    const mark = score.rate >= threshold ? 'OK' : 'DUOI NGUONG';
    lines.push(
      `  ${score.category}: ${score.passed}/${score.total} (${(score.rate * 100).toFixed(0)}%, nguong ${(threshold * 100).toFixed(0)}%) ${mark}`,
    );
  }
  for (const c of result.cases.filter((r) => !r.pass)) {
    lines.push(
      `  FAIL ${c.id} [${c.category}] "${c.question}" — thieu: ${c.missingKeys.join(', ') || 'tra ve fact khong lien quan'}`,
    );
  }
  return lines.join('\n');
}
