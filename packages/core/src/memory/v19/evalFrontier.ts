/**
 * Memory v19 — Eval harness kieu FrontierMemory + LoCoMo chay LOCAL (v1.20, Doi T1).
 *
 * Y tuong hoc tu Letta FrontierMemory (10/2026: benchmark memory
 * dai han kieu moi, Fable 5.2 = Opus 5.5 dat 73,3%) + Mem0 LoCoMo
 * (benchmark nho dai han cho agent hoi thoai) — tu thiet ke lai
 * hoan toan cho open-bot, KHONG copy code/text/tai san cua bat ky
 * repo nao. Dataset viet tay trong file nay (nguoi + su kien gia
 * lap, KHAC dataset v18), khong lay tu benchmark that.
 *
 * Harness do 3 thu cho MOI writer model (BYOK — model viet memory):
 *  1. Accuracy theo TUNG benchmark (LoCoMo-style v18 + Frontier-
 *     style v19): chay retrieval that tren store that (seed qua
 *     writer adapter), cham PASS/FAIL giong v18, khong dung LLM
 *     judge.
 *  2. Chi phi that: token input/output + latency do duoc moi lan
 *     writer viet 1 fact, quy ra USD/1000 adds theo gia trong
 *     profile (`writerModels.ts`). Writer khong bao token thi chi
 *     phi = null (khong doan).
 *  3. Mau thuan benchmark: hai benchmark co the xep hang nguoc
 *     nhau (vd GPT-6 Luna gan top LoCoMo nhung chot FrontierMemory
 *     28,9%). Harness LUON hien thi ca hai benchmark + canh bao
 *     khi thu hang doi nhau — KHONG duoc tin so vendor mu, KHONG
 *     duoc chi bao cao benchmark co loi cho model.
 *
 * Writer that vs mock:
 *  - `MockWriterV19`: viet local, xac dinh, khong goi model — dung
 *    cho test + eval offline. No tra ve fact tu `hint` kem theo
 *    (khong doan mo).
 *  - `ProviderWriterAdapterV19`: boc mot ham do caller cung cap
 *    (goi provider that qua interface co san cua open-bot). Ham
 *    nay KHONG goi mang truc tiep — caller chiu trach nhiem goi
 *    provider; harness chi do token/latency tra ve.
 */

import type { GraphFact, MemoryScope } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { retrieveV18 } from '../v18/hybridRetrievalV2';
import { buildV18LocomoDataset, seedV18LocomoDataset } from '../v18/evalLocomo';
import type { V18LocomoDataset } from '../v18/evalLocomo';
import {
  getDefaultWriterRegistryV19,
  costOfOneAddV19,
} from './writerModels';
import type { V19WriterModelProfile } from './writerModels';

/** Loi eval Frontier — message tieng Viet. */
export class V19FrontierEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V19FrontierEvalError';
  }
}

/** Benchmark ma harness chay. */
export type V19EvalBenchmark = 'locomo' | 'frontier';

/** Loai case Frontier. */
export type V19FrontierCategory =
  | 'single-hop'
  | 'multi-hop'
  | 'temporal'
  | 'unanswerable'
  | 'conflict';

/** Nguong dat mac dinh theo category (ty le pass toi thieu). */
export const V19_FRONTIER_THRESHOLDS: Record<V19FrontierCategory, number> = {
  'single-hop': 0.9,
  'multi-hop': 0.8,
  temporal: 0.8,
  unanswerable: 0.9,
  conflict: 0.9,
};

/** So hit toi da lay moi query khi eval (mac dinh). */
export const V19_FRONTIER_DEFAULT_TOP_K = 5;
/** Diem toi thieu de tinh la retrieval co ket qua (mac dinh). */
export const V19_FRONTIER_DEFAULT_MIN_SCORE = 0.1;

/** Dau vao 1 lan writer viet memory. */
export interface V19WriterWriteInput {
  /** Text goc can rut fact (vd mot turn hoi thoai). */
  text: string;
  /** Goi y cau truc (eval truyen de mock viet xac dinh; provider that co the bo qua). */
  hint?: { subjectName: string; predicate: string; objectText: string };
}

/** Dau ra 1 lan writer viet memory. */
export interface V19WriterWriteOutput {
  subjectName: string;
  predicate: string;
  objectText: string;
  confidence: number;
  /** Token input that (null = writer khong bao). */
  inputTokens: number | null;
  /** Token output that (null = writer khong bao). */
  outputTokens: number | null;
  /** Do tre that cua lan viet (ms). */
  latencyMs: number;
}

/** Adapter writer: bat ky model nao viet memory deu qua interface nay. */
export interface V19WriterAdapter {
  /** Id adapter (vd 'mock-writer', 'provider:opus-5.5'). */
  id: string;
  /** Id profile trong registry (de lay gia tinh chi phi). */
  profileId: string;
  /** Viet 1 fact tu text (co the throw — harness dem la add that bai). */
  write(input: V19WriterWriteInput): Promise<V19WriterWriteOutput>;
}

/**
 * Mock writer chay local, xac dinh 100%: tra ve fact tu `hint`
 * (neu co), khong thi tach don gian "Subject predicate object"
 * bang cach cat text thanh 3 phan. Token uoc tinh chars/4 (ghi ro
 * la uoc tinh, khong phai do that). Latency ~0 (do that).
 */
export class MockWriterV19 implements V19WriterAdapter {
  readonly id = 'mock-writer';
  readonly profileId = 'mock-writer';

  async write(input: V19WriterWriteInput): Promise<V19WriterWriteOutput> {
    const started = Date.now();
    const hint = input.hint;
    let subjectName = 'Unknown';
    let predicate = 'note';
    let objectText = input.text.trim();
    if (hint) {
      subjectName = hint.subjectName;
      predicate = hint.predicate;
      objectText = hint.objectText;
    } else {
      // Tach tho: "An song o Ha Noi" -> subject=An, predicate=song_o, object=Ha Noi.
      const parts = input.text.trim().split(/\s+/);
      if (parts.length >= 3) {
        subjectName = parts[0] as string;
        predicate = parts.slice(1, -1).join('_').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'note';
        objectText = parts[parts.length - 1] as string;
      }
    }
    const inputTokens = Math.max(1, Math.ceil(input.text.length / 4));
    const outputTokens = Math.max(1, Math.ceil(objectText.length / 4));
    return {
      subjectName,
      predicate,
      objectText,
      confidence: 0.9,
      inputTokens,
      outputTokens,
      latencyMs: Math.max(0, Date.now() - started),
    };
  }
}

/**
 * Adapter boc ham provider that do caller cung cap: `fn` nhan
 * input, tra ve output (caller goi model that qua provider
 * interface co san, tu xu ly key + retry). Harness chi do them
 * latency wall-clock neu `fn` khong tra `latencyMs` (lay
 * `latencyMs` tu output neu co).
 */
export class ProviderWriterAdapterV19 implements V19WriterAdapter {
  readonly id: string;
  readonly profileId: string;
  private readonly fn: (input: V19WriterWriteInput) => Promise<V19WriterWriteOutput>;

  constructor(
    profileId: string,
    fn: (input: V19WriterWriteInput) => Promise<V19WriterWriteOutput>,
    id?: string,
  ) {
    if (typeof fn !== 'function') {
      throw new V19FrontierEvalError('ProviderWriterAdapterV19 can mot ham goi provider that.');
    }
    this.profileId = profileId;
    this.id = id ?? `provider:${profileId}`;
    this.fn = fn;
  }

  async write(input: V19WriterWriteInput): Promise<V19WriterWriteOutput> {
    const started = Date.now();
    const out = await this.fn(input);
    if (!out || typeof out.objectText !== 'string' || out.objectText.trim() === '') {
      throw new V19FrontierEvalError(`Writer "${this.id}" tra ve fact rong.`);
    }
    return {
      ...out,
      latencyMs: out.latencyMs ?? Math.max(0, Date.now() - started),
    };
  }
}

/** Mot fact mau trong dataset Frontier (seed vao store qua writer). */
export interface V19FrontierSeedFact {
  key: string;
  subjectName: string;
  predicate: string;
  objectText: string;
  /** Text goc de writer viet (mo phong turn hoi thoai). */
  sourceText: string;
  confidence?: number;
  validFrom?: string;
  validUntil?: string | null;
  /** Key cua fact ma fact nay thay the (de tao lich su xung dot). */
  supersedesKey?: string;
}

/** Mot case eval Frontier. */
export interface V19FrontierCase {
  id: string;
  category: V19FrontierCategory;
  question: string;
  queries: string[];
  /** Key cac fact ky vong phai tim thay (rong = unanswerable). */
  expectedKeys: string[];
  /** Key cac fact CU KHONG duoc xuat hien (chi dung cho category conflict). */
  forbiddenKeys?: string[];
}

/** Dataset eval Frontier day du. */
export interface V19FrontierDataset {
  seedFacts: V19FrontierSeedFact[];
  cases: V19FrontierCase[];
  scope: MemoryScope;
}

const FRONTIER_SCOPE: MemoryScope = { userId: 'frontier-user', botId: 'frontier-bot', runId: 'frontier-run' };

/** Dataset Frontier mac dinh: 25 case viet tay (5 moi loai). Nguoi/su kien gia lap, khac v18. */
export function buildV19FrontierDataset(): V19FrontierDataset {
  const seedFacts: V19FrontierSeedFact[] = [
    { key: 'f-dung-lives-hn', subjectName: 'Dung', predicate: 'lives_in', objectText: 'Ha Noi', sourceText: 'Dung song o Ha Noi.' },
    { key: 'f-dung-works-old', subjectName: 'Dung', predicate: 'works_at', objectText: 'Shopee', sourceText: 'Dung lam o Shopee.', validFrom: '2021-01-01T00:00:00.000Z', validUntil: '2025-01-01T00:00:00.000Z' },
    { key: 'f-dung-works-new', subjectName: 'Dung', predicate: 'works_at', objectText: 'Grab', sourceText: 'Dung chuyen sang lam o Grab.', supersedesKey: 'f-dung-works-old' },
    { key: 'f-dung-likes', subjectName: 'Dung', predicate: 'likes', objectText: 'bun cha', sourceText: 'Dung thich an bun cha.' },
    { key: 'f-hoa-lives', subjectName: 'Hoa', predicate: 'lives_in', objectText: 'Hue', sourceText: 'Hoa song o Hue.' },
    { key: 'f-hoa-works', subjectName: 'Hoa', predicate: 'works_at', objectText: 'Vinmec', sourceText: 'Hoa lam o Vinmec.' },
    { key: 'f-hoa-pet', subjectName: 'Hoa', predicate: 'has_pet', objectText: 'cho Bong', sourceText: 'Hoa nuoi cho Bong.' },
    { key: 'f-khanh-lives', subjectName: 'Khanh', predicate: 'lives_in', objectText: 'Can Tho', sourceText: 'Khanh song o Can Tho.' },
    { key: 'f-khanh-goal', subjectName: 'Khanh', predicate: 'goal', objectText: 'hoc piano', sourceText: 'Khanh muon hoc piano.' },
    { key: 'f-khanh-likes', subjectName: 'Khanh', predicate: 'likes', objectText: 'che troi nuoc', sourceText: 'Khanh thich che troi nuoc.' },
    { key: 'f-dung-allergy', subjectName: 'Dung', predicate: 'constraint', objectText: 'di ung hai san', sourceText: 'Dung bi di ung hai san.' },
    { key: 'f-hoa-goal', subjectName: 'Hoa', predicate: 'goal', objectText: 'chay 10km', sourceText: 'Hoa muon chay duoc 10km.' },
    { key: 'f-khanh-works', subjectName: 'Khanh', predicate: 'works_at', objectText: 'Viettel', sourceText: 'Khanh lam o Viettel.' },
    { key: 'f-dung-routine', subjectName: 'Dung', predicate: 'daily_routine', objectText: 'tap gym buoi toi', sourceText: 'Dung tap gym moi buoi toi.' },
    { key: 'f-hoa-likes', subjectName: 'Hoa', predicate: 'likes', objectText: 'tra sua', sourceText: 'Hoa thich tra sua.' },
    { key: 'f-khanh-pet', subjectName: 'Khanh', predicate: 'has_pet', objectText: 'meo Tam', sourceText: 'Khanh nuoi meo Tam.' },
  ];
  const cases: V19FrontierCase[] = [
    { id: 'fsh-1', category: 'single-hop', question: 'Dung song o dau?', queries: ['Dung song o Ha Noi'], expectedKeys: ['f-dung-lives-hn'] },
    { id: 'fsh-2', category: 'single-hop', question: 'Hoa lam o dau?', queries: ['Hoa lam o Vinmec'], expectedKeys: ['f-hoa-works'] },
    { id: 'fsh-3', category: 'single-hop', question: 'Khanh thich an gi?', queries: ['Khanh thich che troi nuoc'], expectedKeys: ['f-khanh-likes'] },
    { id: 'fsh-4', category: 'single-hop', question: 'Hoa nuoi thu cung gi?', queries: ['cho Bong cua Hoa'], expectedKeys: ['f-hoa-pet'] },
    { id: 'fsh-5', category: 'single-hop', question: 'Dung bi di ung gi?', queries: ['Dung di ung hai san'], expectedKeys: ['f-dung-allergy'] },
    { id: 'fmh-1', category: 'multi-hop', question: 'Dung va Hoa lam o dau?', queries: ['Dung lam o Grab', 'Hoa lam o Vinmec'], expectedKeys: ['f-dung-works-new', 'f-hoa-works'] },
    { id: 'fmh-2', category: 'multi-hop', question: 'Khanh song o dau va lam o dau?', queries: ['Khanh song o Can Tho', 'Khanh lam o Viettel'], expectedKeys: ['f-khanh-lives', 'f-khanh-works'] },
    { id: 'fmh-3', category: 'multi-hop', question: 'Hoa thich gi va muc tieu gi?', queries: ['Hoa thich tra sua', 'muc tieu chay 10km cua Hoa'], expectedKeys: ['f-hoa-likes', 'f-hoa-goal'] },
    { id: 'fmh-4', category: 'multi-hop', question: 'Dung tap gym khi nao va thich an gi?', queries: ['Dung tap gym buoi toi', 'Dung thich bun cha'], expectedKeys: ['f-dung-routine', 'f-dung-likes'] },
    { id: 'fmh-5', category: 'multi-hop', question: 'Khanh nuoi meo gi va muc tieu gi?', queries: ['meo Tam cua Khanh', 'muc tieu hoc piano cua Khanh'], expectedKeys: ['f-khanh-pet', 'f-khanh-goal'] },
    { id: 'ftp-1', category: 'temporal', question: 'Truoc day Dung lam o dau?', queries: ['truoc day Dung lam o Shopee'], expectedKeys: ['f-dung-works-old'] },
    { id: 'ftp-2', category: 'temporal', question: 'Dung lam o Shopee tu khi nao?', queries: ['Dung lam o Shopee'], expectedKeys: ['f-dung-works-old'] },
    { id: 'ftp-3', category: 'temporal', question: 'Dung lam o Grab hien tai dung khong?', queries: ['Dung lam o Grab hien tai'], expectedKeys: ['f-dung-works-new'] },
    { id: 'ftp-4', category: 'temporal', question: 'Dung doi viec khi nao?', queries: ['Dung chuyen tu Shopee sang Grab'], expectedKeys: ['f-dung-works-old', 'f-dung-works-new'] },
    { id: 'ftp-5', category: 'temporal', question: 'Dung lam o dau nam 2023?', queries: ['Dung lam o dau nam 2023 Shopee'], expectedKeys: ['f-dung-works-old'] },
    { id: 'fua-1', category: 'unanswerable', question: 'Dung co bao nhieu tien?', queries: ['so du ngan hang'], expectedKeys: [] },
    { id: 'fua-2', category: 'unanswerable', question: 'Hoa hoc truong nao?', queries: ['bang dai hoc'], expectedKeys: [] },
    { id: 'fua-3', category: 'unanswerable', question: 'Khanh co anh em gi?', queries: ['so dien thoai'], expectedKeys: [] },
    { id: 'fua-4', category: 'unanswerable', question: 'Cho Bong may tuoi?', queries: ['tuoi thu cung'], expectedKeys: [] },
    { id: 'fua-5', category: 'unanswerable', question: 'Dung di du lich dau nam ngoai?', queries: ['ho chieu'], expectedKeys: [] },
    { id: 'fcf-1', category: 'conflict', question: 'Dung lam o dau hien tai?', queries: ['Dung lam o dau hien tai Grab'], expectedKeys: ['f-dung-works-new'], forbiddenKeys: ['f-dung-works-old'] },
    { id: 'fcf-2', category: 'conflict', question: 'Dung con lam o Shopee khong?', queries: ['Dung lam o Shopee hien tai'], expectedKeys: ['f-dung-works-new'], forbiddenKeys: ['f-dung-works-old'] },
    { id: 'fcf-3', category: 'conflict', question: 'Cong viec moi nhat cua Dung la gi?', queries: ['cong viec moi nhat cua Dung Grab'], expectedKeys: ['f-dung-works-new'], forbiddenKeys: ['f-dung-works-old'] },
    { id: 'fcf-4', category: 'conflict', question: 'Dung lam o Grab tu khi nao?', queries: ['Dung lam o Grab'], expectedKeys: ['f-dung-works-new'], forbiddenKeys: ['f-dung-works-old'] },
    { id: 'fcf-5', category: 'conflict', question: 'Ai lam o Grab?', queries: ['lam o Grab'], expectedKeys: ['f-dung-works-new'], forbiddenKeys: ['f-dung-works-old'] },
  ];
  return { seedFacts, cases, scope: FRONTIER_SCOPE };
}

/** Thong ke viet (seed) cua mot lan chay eval. */
export interface V19WriteStats {
  /** So add writer viet thanh cong. */
  addsSucceeded: number;
  /** So add that bai (writer throw). */
  addsFailed: number;
  /** Tong token input do duoc (null neu writer khong bao token). */
  totalInputTokens: number | null;
  /** Tong token output do duoc (null neu writer khong bao token). */
  totalOutputTokens: number | null;
  /** Do tre trung binh moi add (ms). */
  avgLatencyMs: number;
  /** Chi phi USD thuc do cho tat ca adds (null neu thieu gia/token). */
  totalCostUsd: number | null;
  /** Chi phi USD quy ra 1000 adds (null neu khong tinh duoc). */
  costPer1000AddsUsd: number | null;
}

/** Ket qua 1 case Frontier. */
export interface V19FrontierCaseResult {
  id: string;
  category: V19FrontierCategory;
  question: string;
  pass: boolean;
  missingKeys: string[];
  /** Fact cu bi cam nhung van xuat hien (chi category conflict). */
  forbiddenFoundKeys: string[];
  bestHitCount: number;
}

/** Diem theo category. */
export interface V19FrontierCategoryScore {
  category: V19FrontierCategory;
  total: number;
  passed: number;
  rate: number;
}

/** Ket qua eval 1 benchmark cho 1 writer. */
export interface V19BenchmarkResult {
  benchmark: V19EvalBenchmark;
  at: string;
  total: number;
  passed: number;
  rate: number;
  overallPass: boolean;
  byCategory: { category: string; total: number; passed: number; rate: number }[];
  failingCategories: string[];
  cases: { id: string; category: string; question: string; pass: boolean; missingKeys: string[]; bestHitCount: number }[];
}

/** Ket qua eval day du cho 1 writer (ca hai benchmark + chi phi that). */
export interface V19WriterEvalResult {
  at: string;
  writerId: string;
  profileId: string;
  /** Profile dung tinh chi phi (null neu khong tim thay trong registry). */
  profile: V19WriterModelProfile | null;
  locomo: V19BenchmarkResult;
  frontier: V19BenchmarkResult;
  writeStats: V19WriteStats;
  /** Canh bao mau thuan giua hai benchmark (rong = khong mau thuan dang ke). */
  contradictionWarnings: string[];
  /** Ghi chu trung thuc: so do local, khong phai so vendor. */
  provenanceNote: string;
}

/** Tuy chon chay eval writer. */
export interface V19WriterEvalOptions {
  topK?: number;
  minScore?: number;
  weights?: { semantic?: number; bm25?: number; entity?: number };
  /** Chi chay benchmark nay (mac dinh ca hai). */
  onlyBenchmark?: V19EvalBenchmark;
  /** Registry de lay gia (mac dinh registry mac dinh). */
  registry?: { get(id: string): V19WriterModelProfile | undefined };
}

/**
 * Seed dataset Frontier vao store QUA writer adapter: moi seed fact
 * la 1 lan writer viet (do token/latency/chi phi that). Fact co
 * `supersedesKey` se supersede fact da seed truoc (tao lich su).
 * Tra ve map key -> fact id that + thong ke viet.
 */
export async function seedV19FrontierDataset(
  store: TemporalGraphStore,
  dataset: V19FrontierDataset,
  writer: V19WriterAdapter,
  profile: V19WriterModelProfile | null,
): Promise<{ byKey: Map<string, string>; writeStats: V19WriteStats }> {
  const byKey = new Map<string, string>();
  let addsSucceeded = 0;
  let addsFailed = 0;
  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let totalLatencyMs = 0;
  let totalCostUsd: number | null = 0;
  const addCost = (out: V19WriterWriteOutput): void => {
    if (out.inputTokens === null || out.outputTokens === null) {
      totalInputTokens = null;
      totalOutputTokens = null;
      totalCostUsd = null;
      return;
    }
    if (totalInputTokens !== null) totalInputTokens += out.inputTokens;
    if (totalOutputTokens !== null) totalOutputTokens += out.outputTokens;
    if (totalCostUsd !== null && profile) {
      const c = costOfOneAddV19(profile, out.inputTokens, out.outputTokens);
      totalCostUsd = c === null ? null : totalCostUsd + c;
    } else if (totalCostUsd !== null) {
      totalCostUsd = null;
    }
  };
  for (const seed of dataset.seedFacts) {
    let out: V19WriterWriteOutput;
    try {
      out = await writer.write({
        text: seed.sourceText,
        hint: { subjectName: seed.subjectName, predicate: seed.predicate, objectText: seed.objectText },
      });
    } catch {
      addsFailed += 1;
      continue;
    }
    addsSucceeded += 1;
    totalLatencyMs += out.latencyMs;
    addCost(out);
    const provenance = {
      episodeId: `frontier-ep-${seed.key}`,
      turnId: `frontier-turn-${seed.key}`,
      runId: dataset.scope.runId,
      botId: dataset.scope.botId,
      userId: dataset.scope.userId,
      at: '2026-01-01T00:00:00.000Z',
      sourceText: seed.sourceText,
    };
    const addInput = {
      subjectName: out.subjectName,
      predicate: out.predicate,
      objectText: out.objectText,
      confidence: out.confidence,
      scope: dataset.scope,
      provenance,
      ...(seed.validFrom ? { validFrom: seed.validFrom } : {}),
      ...(seed.validUntil !== undefined ? { validUntil: seed.validUntil } : {}),
    };
    if (seed.supersedesKey) {
      const oldId = byKey.get(seed.supersedesKey);
      if (oldId) {
        const replacement = store.supersedeFact(oldId, addInput);
        byKey.set(seed.key, replacement.id);
        continue;
      }
    }
    const fact = store.addFact(addInput);
    byKey.set(seed.key, fact.id);
  }
  void profile;
  const writeStats: V19WriteStats = {
    addsSucceeded,
    addsFailed,
    totalInputTokens,
    totalOutputTokens,
    avgLatencyMs: addsSucceeded === 0 ? 0 : totalLatencyMs / addsSucceeded,
    totalCostUsd,
    costPer1000AddsUsd:
      totalCostUsd === null || addsSucceeded === 0 ? null : (totalCostUsd / addsSucceeded) * 1000,
  };
  return { byKey, writeStats };
}

/** Chay cac case Frontier tren store da seed (retrieval hybrid v18). */
export function runV19FrontierCases(
  store: TemporalGraphStore,
  dataset: V19FrontierDataset,
  factIdsByKey: Map<string, string>,
  opts: V19WriterEvalOptions = {},
): { result: V19BenchmarkResult; caseResults: V19FrontierCaseResult[] } {
  const topK = Math.max(1, opts.topK ?? V19_FRONTIER_DEFAULT_TOP_K);
  const minScore = opts.minScore ?? V19_FRONTIER_DEFAULT_MIN_SCORE;
  const weights = opts.weights ?? { semantic: 0, bm25: 0.6, entity: 0.4 };
  const caseResults: V19FrontierCaseResult[] = [];
  for (const c of dataset.cases) {
    const found = new Set<string>();
    let bestHits = 0;
    const activeOnly = c.category !== 'temporal';
    for (const query of c.queries) {
      const hits = retrieveV18(store, query, dataset.scope, { topK, minScore, weights, activeOnly });
      bestHits = Math.max(bestHits, hits.length);
      for (const hit of hits) found.add(hit.fact.id);
    }
    if (c.category === 'unanswerable') {
      caseResults.push({
        id: c.id,
        category: c.category,
        question: c.question,
        pass: found.size === 0,
        missingKeys: [],
        forbiddenFoundKeys: [],
        bestHitCount: bestHits,
      });
      continue;
    }
    const missingKeys = c.expectedKeys.filter((k) => {
      const id = factIdsByKey.get(k);
      return !id || !found.has(id);
    });
    const forbiddenFoundKeys = (c.forbiddenKeys ?? []).filter((k) => {
      const id = factIdsByKey.get(k);
      return id !== undefined && found.has(id);
    });
    caseResults.push({
      id: c.id,
      category: c.category,
      question: c.question,
      pass: missingKeys.length === 0 && forbiddenFoundKeys.length === 0,
      missingKeys,
      forbiddenFoundKeys,
      bestHitCount: bestHits,
    });
  }
  const categories: V19FrontierCategory[] = ['single-hop', 'multi-hop', 'temporal', 'unanswerable', 'conflict'];
  const byCategory: V19FrontierCategoryScore[] = categories.map((category) => {
    const rows = caseResults.filter((r) => r.category === category);
    const passed = rows.filter((r) => r.pass).length;
    return { category, total: rows.length, passed, rate: rows.length === 0 ? 1 : passed / rows.length };
  });
  const passed = caseResults.filter((r) => r.pass).length;
  const failingCategories = byCategory
    .filter((s) => s.rate < V19_FRONTIER_THRESHOLDS[s.category])
    .map((s) => s.category);
  const result: V19BenchmarkResult = {
    benchmark: 'frontier',
    at: new Date().toISOString(),
    total: caseResults.length,
    passed,
    rate: caseResults.length === 0 ? 1 : passed / caseResults.length,
    overallPass: failingCategories.length === 0,
    byCategory,
    failingCategories,
    cases: caseResults.map((r) => ({
      id: r.id,
      category: r.category,
      question: r.question,
      pass: r.pass,
      missingKeys: r.missingKeys,
      bestHitCount: r.bestHitCount,
    })),
  };
  return { result, caseResults };
}

/** Chay cac case LoCoMo v18 tren store da seed bang writer (de so sanh cung writer). */
export async function runV19LocomoForWriter(
  store: TemporalGraphStore,
  writer: V19WriterAdapter,
  opts: V19WriterEvalOptions = {},
): Promise<{ result: V19BenchmarkResult; writeStats: V19WriteStats }> {
  // Seed LoCoMo qua writer: dung sourceText suy ra tu fact (khong co hint that -> dung hint tu seed).
  const dataset: V18LocomoDataset = buildV18LocomoDataset();
  const profile = opts.registry?.get(writer.profileId) ?? getDefaultWriterRegistryV19().get(writer.profileId) ?? null;
  const byKey = new Map<string, string>();
  let addsSucceeded = 0;
  let addsFailed = 0;
  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let totalLatencyMs = 0;
  let totalCostUsd: number | null = 0;
  for (const seed of dataset.seedFacts) {
    let out: V19WriterWriteOutput;
    try {
      out = await writer.write({
        text: `${seed.subjectName} ${seed.predicate} ${seed.objectText}`,
        hint: { subjectName: seed.subjectName, predicate: seed.predicate, objectText: seed.objectText },
      });
    } catch {
      addsFailed += 1;
      continue;
    }
    addsSucceeded += 1;
    totalLatencyMs += out.latencyMs;
    if (out.inputTokens === null || out.outputTokens === null) {
      totalInputTokens = null;
      totalOutputTokens = null;
      totalCostUsd = null;
    } else {
      if (totalInputTokens !== null) totalInputTokens += out.inputTokens;
      if (totalOutputTokens !== null) totalOutputTokens += out.outputTokens;
      if (totalCostUsd !== null && profile) {
        const c = costOfOneAddV19(profile, out.inputTokens, out.outputTokens);
        totalCostUsd = c === null ? null : totalCostUsd + c;
      } else if (totalCostUsd !== null) {
        totalCostUsd = null;
      }
    }
    const provenance = {
      episodeId: `locomo-ep-${seed.key}`,
      turnId: `locomo-turn-${seed.key}`,
      runId: dataset.scope.runId,
      botId: dataset.scope.botId,
      userId: dataset.scope.userId,
      at: '2026-01-01T00:00:00.000Z',
      sourceText: `${seed.subjectName} ${seed.predicate} ${seed.objectText}`,
    };
    const addInput = {
      subjectName: out.subjectName,
      predicate: out.predicate,
      objectText: out.objectText,
      confidence: out.confidence,
      scope: dataset.scope,
      provenance,
      ...(seed.validFrom ? { validFrom: seed.validFrom } : {}),
      ...(seed.validUntil !== undefined ? { validUntil: seed.validUntil } : {}),
    };
    if (seed.supersedesKey) {
      const oldId = byKey.get(seed.supersedesKey);
      if (oldId) {
        const replacement = store.supersedeFact(oldId, addInput);
        byKey.set(seed.key, replacement.id);
        continue;
      }
    }
    const fact = store.addFact(addInput);
    byKey.set(seed.key, fact.id);
  }
  // Cham LoCoMo: dung lai logic retrieval giong v18 (import truc tiep de tranh vong lap phu thuoc).
  const topK = Math.max(1, opts.topK ?? V19_FRONTIER_DEFAULT_TOP_K);
  const minScore = opts.minScore ?? V19_FRONTIER_DEFAULT_MIN_SCORE;
  const weights = opts.weights ?? { semantic: 0, bm25: 0.6, entity: 0.4 };
  const caseResults: { id: string; category: string; question: string; pass: boolean; missingKeys: string[]; bestHitCount: number }[] = [];
  for (const c of dataset.cases) {
    if (c.category === 'unanswerable') {
      let bestHits = 0;
      let foundAny = false;
      for (const query of c.queries) {
        const hits = retrieveV18(store, query, dataset.scope, { topK, minScore, weights, activeOnly: true });
        bestHits = Math.max(bestHits, hits.length);
        if (hits.length > 0) foundAny = true;
      }
      caseResults.push({ id: c.id, category: c.category, question: c.question, pass: !foundAny, missingKeys: [], bestHitCount: bestHits });
      continue;
    }
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
      const id = byKey.get(k);
      return !id || !found.has(id);
    });
    caseResults.push({ id: c.id, category: c.category, question: c.question, pass: missingKeys.length === 0, missingKeys, bestHitCount: bestHits });
  }
  const cats = ['single-hop', 'multi-hop', 'temporal', 'unanswerable'];
  const byCategory = cats.map((category) => {
    const rows = caseResults.filter((r) => r.category === category);
    const passedCount = rows.filter((r) => r.pass).length;
    return { category, total: rows.length, passed: passedCount, rate: rows.length === 0 ? 1 : passedCount / rows.length };
  });
  const passed = caseResults.filter((r) => r.pass).length;
  const thresholds: Record<string, number> = { 'single-hop': 0.9, 'multi-hop': 0.8, temporal: 0.8, unanswerable: 0.9 };
  const failingCategories = byCategory.filter((s) => s.rate < (thresholds[s.category] ?? 0.8)).map((s) => s.category);
  const writeStats: V19WriteStats = {
    addsSucceeded,
    addsFailed,
    totalInputTokens,
    totalOutputTokens,
    avgLatencyMs: addsSucceeded === 0 ? 0 : totalLatencyMs / addsSucceeded,
    totalCostUsd,
    costPer1000AddsUsd: totalCostUsd === null || addsSucceeded === 0 ? null : (totalCostUsd / addsSucceeded) * 1000,
  };
  const result: V19BenchmarkResult = {
    benchmark: 'locomo',
    at: new Date().toISOString(),
    total: caseResults.length,
    passed,
    rate: caseResults.length === 0 ? 1 : passed / caseResults.length,
    overallPass: failingCategories.length === 0,
    byCategory,
    failingCategories,
    cases: caseResults,
  };
  void byKey;
  return { result, writeStats };
}

/**
 * Phat hien mau thuan giua hai benchmark cua CUNG mot writer: mot
 * benchmark DAT (>= nguong trung binh 0.85) trong khi benchmark kia
 * ROT (< 0.5). Tra ve canh bao (rong = khong mau thuan). Day la
 * truong hop GPT-6 Luna trong brief: gan top LoCoMo nhung chot
 * FrontierMemory 28,9%.
 */
export function detectBenchmarkContradictionV19(
  locomoRate: number,
  frontierRate: number,
  writerLabel: string,
): string[] {
  const warnings: string[] = [];
  if (locomoRate >= 0.85 && frontierRate < 0.5) {
    warnings.push(
      `MAU THUAN BENCHMARK (${writerLabel}): LoCoMo ${(locomoRate * 100).toFixed(0)}% (tot) nhung ` +
        `FrontierMemory ${(frontierRate * 100).toFixed(0)}% (rot). Hai benchmark do khac nhau — ` +
        `khong ket luan model tot dua tren mot benchmark. Kiem tra lai dataset + retrieval truoc khi chon model.`,
    );
  } else if (frontierRate >= 0.85 && locomoRate < 0.5) {
    warnings.push(
      `MAU THUAN BENCHMARK (${writerLabel}): FrontierMemory ${(frontierRate * 100).toFixed(0)}% (tot) nhung ` +
        `LoCoMo ${(locomoRate * 100).toFixed(0)}% (rot). Hai benchmark do khac nhau — ` +
        `khong ket luan model tot dua tren mot benchmark. Kiem tra lai dataset + retrieval truoc khi chon model.`,
    );
  }
  return warnings;
}

/**
 * So sanh nhieu writer da eval: xep hang theo tung benchmark +
 * canh bao khi mot writer doi hang manh giua hai benchmark (top 1
 * benchmark nay, chot benchmark kia). Dung cho UI chon model.
 */
export function compareWriterEvalsV19(
  results: V19WriterEvalResult[],
): { locomoRanking: string[]; frontierRanking: string[]; warnings: string[] } {
  const byRate = (r: V19WriterEvalResult, b: V19EvalBenchmark): number =>
    b === 'locomo' ? r.locomo.rate : r.frontier.rate;
  const locomoRanking = [...results].sort((a, b) => byRate(b, 'locomo') - byRate(a, 'locomo')).map((r) => r.writerId);
  const frontierRanking = [...results].sort((a, b) => byRate(b, 'frontier') - byRate(a, 'frontier')).map((r) => r.writerId);
  const warnings: string[] = [];
  if (results.length >= 2) {
    const locomoTop = locomoRanking[0] as string;
    const frontierBottom = frontierRanking[frontierRanking.length - 1] as string;
    if (locomoTop === frontierBottom) {
      warnings.push(
        `MAU THUAN XEP HANG: "${locomoTop}" dung dau LoCoMo nhung dung cuoi FrontierMemory. ` +
          `Khong chon model dua tren mot benchmark duy nhat.`,
      );
    }
    const frontierTop = frontierRanking[0] as string;
    const locomoBottom = locomoRanking[locomoRanking.length - 1] as string;
    if (frontierTop === locomoBottom && frontierTop !== locomoTop) {
      warnings.push(
        `MAU THUAN XEP HANG: "${frontierTop}" dung dau FrontierMemory nhung dung cuoi LoCoMo. ` +
          `Khong chon model dua tren mot benchmark duy nhat.`,
      );
    }
  }
  return { locomoRanking, frontierRanking, warnings };
}

/**
 * Chay eval day du cho 1 writer: seed + cham ca hai benchmark tren
 * CUNG store (hai scope khac nhau nen khong lan fact). Luu y: eval
 * GHI fact gia vao store duoc truyen — dung store moi cho moi lan
 * chay, khong dung store production.
 */
export async function runV19WriterEval(
  store: TemporalGraphStore,
  writer: V19WriterAdapter,
  opts: V19WriterEvalOptions = {},
): Promise<V19WriterEvalResult> {
  const registry = opts.registry ?? getDefaultWriterRegistryV19();
  const profile = registry.get(writer.profileId) ?? null;
  const at = new Date().toISOString();
  let locomo: V19BenchmarkResult;
  let frontier: V19BenchmarkResult;
  let writeStats: V19WriteStats;
  if (opts.onlyBenchmark === 'locomo') {
    const r = await runV19LocomoForWriter(store, writer, opts);
    locomo = r.result;
    writeStats = r.writeStats;
    frontier = {
      benchmark: 'frontier',
      at,
      total: 0,
      passed: 0,
      rate: 1,
      overallPass: true,
      byCategory: [],
      failingCategories: [],
      cases: [],
    };
  } else if (opts.onlyBenchmark === 'frontier') {
    const dataset = buildV19FrontierDataset();
    const seeded = await seedV19FrontierDataset(store, dataset, writer, profile);
    const fr = runV19FrontierCases(store, dataset, seeded.byKey, opts);
    frontier = fr.result;
    writeStats = seeded.writeStats;
    locomo = {
      benchmark: 'locomo',
      at,
      total: 0,
      passed: 0,
      rate: 1,
      overallPass: true,
      byCategory: [],
      failingCategories: [],
      cases: [],
    };
  } else {
    const locomoRun = await runV19LocomoForWriter(store, writer, opts);
    locomo = locomoRun.result;
    const dataset = buildV19FrontierDataset();
    const seeded = await seedV19FrontierDataset(store, dataset, writer, profile);
    const fr = runV19FrontierCases(store, dataset, seeded.byKey, opts);
    frontier = fr.result;
    // Gop thong ke viet cua ca hai benchmark (tong adds, chi phi, tre trung binh co trong so).
    const totalAdds = locomoRun.writeStats.addsSucceeded + seeded.writeStats.addsSucceeded;
    const totalFailed = locomoRun.writeStats.addsFailed + seeded.writeStats.addsFailed;
    const inTok =
      locomoRun.writeStats.totalInputTokens === null || seeded.writeStats.totalInputTokens === null
        ? null
        : locomoRun.writeStats.totalInputTokens + seeded.writeStats.totalInputTokens;
    const outTok =
      locomoRun.writeStats.totalOutputTokens === null || seeded.writeStats.totalOutputTokens === null
        ? null
        : locomoRun.writeStats.totalOutputTokens + seeded.writeStats.totalOutputTokens;
    const cost =
      locomoRun.writeStats.totalCostUsd === null || seeded.writeStats.totalCostUsd === null
        ? null
        : locomoRun.writeStats.totalCostUsd + seeded.writeStats.totalCostUsd;
    writeStats = {
      addsSucceeded: totalAdds,
      addsFailed: totalFailed,
      totalInputTokens: inTok,
      totalOutputTokens: outTok,
      avgLatencyMs:
        totalAdds === 0
          ? 0
          : (locomoRun.writeStats.avgLatencyMs * locomoRun.writeStats.addsSucceeded +
              seeded.writeStats.avgLatencyMs * seeded.writeStats.addsSucceeded) / totalAdds,
      totalCostUsd: cost,
      costPer1000AddsUsd: cost === null || totalAdds === 0 ? null : (cost / totalAdds) * 1000,
    };
  }
  const contradictionWarnings =
    locomo.total > 0 && frontier.total > 0
      ? detectBenchmarkContradictionV19(locomo.rate, frontier.rate, writer.id)
      : [];
  return {
    at,
    writerId: writer.id,
    profileId: writer.profileId,
    profile,
    locomo,
    frontier,
    writeStats,
    contradictionWarnings,
    provenanceNote:
      'So do duoc LOCAL boi harness open-bot (mock hoac provider that qua adapter), khong phai so vendor. ' +
      'Accuracy phu thuoc dataset viet tay + retrieval hybrid v18 (BM25 + entity, semantic 0 khi khong co embedder).',
  };
}

/** Format bao cao eval writer thanh text (de tool / log hien thi). */
export function formatV19WriterEvalReport(result: V19WriterEvalResult): string {
  const lines: string[] = [];
  const fmtCost = (c: number | null): string => (c === null ? 'chua tinh duoc' : `$${c.toFixed(4)}`);
  lines.push(`Eval writer v19: ${result.writerId} (profile: ${result.profileId}) — ${result.at}`);
  lines.push(
    `  LoCoMo: ${result.locomo.passed}/${result.locomo.total} pass (${(result.locomo.rate * 100).toFixed(0)}%) ${result.locomo.overallPass ? 'DAT' : 'CHUA DAT'}`,
  );
  lines.push(
    `  FrontierMemory: ${result.frontier.passed}/${result.frontier.total} pass (${(result.frontier.rate * 100).toFixed(0)}%) ${result.frontier.overallPass ? 'DAT' : 'CHUA DAT'}`,
  );
  lines.push(
    `  Viet: ${result.writeStats.addsSucceeded} add thanh cong, ${result.writeStats.addsFailed} that bai; ` +
      `tre TB ${result.writeStats.avgLatencyMs.toFixed(1)}ms/add; ` +
      `chi phi ${fmtCost(result.writeStats.totalCostUsd)} tong, ${fmtCost(result.writeStats.costPer1000AddsUsd)}/1000 adds.`,
  );
  for (const score of result.locomo.byCategory) {
    lines.push(`  LoCoMo/${score.category}: ${score.passed}/${score.total} (${(score.rate * 100).toFixed(0)}%)`);
  }
  for (const score of result.frontier.byCategory) {
    lines.push(`  Frontier/${score.category}: ${score.passed}/${score.total} (${(score.rate * 100).toFixed(0)}%)`);
  }
  for (const w of result.contradictionWarnings) lines.push(`  CANH BAO: ${w}`);
  lines.push(`  Ghi chu: ${result.provenanceNote}`);
  return lines.join('\n');
}

export type { GraphFact };
