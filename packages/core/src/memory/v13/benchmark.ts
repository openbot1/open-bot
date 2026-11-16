/**
 * Memory v13 — benchmark harness kieu LongMemEval/LoCoMo thu nho
 * (v1.14, Doi T1).
 *
 * Y tuong hoc tu LongMemEval/LoCoMo (bo cau hoi + scorer do recall/
 * precision cua memory theo tung phien ban, chay offline tren memory
 * gia lap) — tu thiet ke lai hoan toan cho open-bot, KHONG copy
 * code/text/tai san cua bat ky repo nao: bo cau hoi va du lieu mau
 * deu la nhan vat/tinh huong hu cau do open-bot tu tao.
 *
 * Cach dung:
 *  1. `buildSampleBenchmarkDataset()` tao dataset mau xac dinh
 *     (seed co dinh — chay lai cho cung ket qua): cac fact gia lap
 *     ve vai user hu cau + cau hoi o 4 nhom (temporal, preference,
 *     contradiction, multi-hop), moi cau kem dap an mong doi + id
 *     fact ho tro.
 *  2. Caller nap fact mau vao mot `TemporalGraphStore` (xem
 *     `seedBenchmarkFacts`) roi truyen mot ham retriever
 *     `(question) => string[]` (vd goi `multiSignalRetrieve` roi lay
 *     text cac hit) vao `runV13Benchmark`.
 *  3. Scorer tinh recall@k / precision@k / F1 theo 2 goc:
 *     - `answerHit`: dap an mong doi co xuat hien trong top-k
 *       retrieved text khong (so khop sau chuan hoa bo dau).
 *     - `supportRecall`: bao nhieu fact ho tro duoc lay ve.
 *  4. Ket qua tong + theo tung nhom + tung cau, kem
 *     `formatBenchmarkReport` de in markdown.
 *
 * Khong goi model, khong goi mang — chay offline hoan toan.
 */

import type { GraphFact } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';

/** Nhom cau hoi benchmark. */
export type V13BenchmarkCategory = 'temporal' | 'preference' | 'contradiction' | 'multi-hop';

/** Mot cau hoi benchmark. */
export interface V13BenchmarkQuestion {
  id: string;
  category: V13BenchmarkCategory;
  question: string;
  /** Dap an mong doi (chuoi ngan, vd ten thanh pho / mon an). */
  expectedAnswer: string;
  /** Key cac fact ho tro (key = `${subject}|${predicate}|${object}`). */
  supportingFactKeys: string[];
  /** Thoi diem hoi (chi nhom temporal/contradiction). */
  asOf?: string;
}

/** Mot fact mau de nap vao store truoc khi chay benchmark. */
export interface V13BenchmarkSeedFact {
  key: string;
  subject: string;
  predicate: string;
  objectText: string;
  confidence: number;
  validFrom: string;
  validUntil: string | null;
  sourceText: string;
}

export interface V13BenchmarkDataset {
  name: string;
  version: number;
  questions: V13BenchmarkQuestion[];
  seedFacts: V13BenchmarkSeedFact[];
}

export interface V13BenchmarkPerQuestion {
  id: string;
  category: V13BenchmarkCategory;
  question: string;
  expectedAnswer: string;
  /** true = dap an xuat hien trong retrieved text. */
  answerHit: boolean;
  /** Ti le fact ho tro lay duoc. */
  supportRecall: number;
  /** So fact ho tro lay duoc / tong so fact ho tro. */
  supportFound: number;
  supportTotal: number;
  /** So text lay ve (top-k). */
  retrievedCount: number;
}

export interface V13BenchmarkCategoryScore {
  category: V13BenchmarkCategory;
  questions: number;
  answerHitRate: number;
  supportRecall: number;
  f1: number;
}

export interface V13BenchmarkResult {
  dataset: string;
  datasetVersion: number;
  topK: number;
  questions: number;
  /** Ti le cau co dap an dung trong retrieved text. */
  answerHitRate: number;
  /** Recall trung binh tren fact ho tro. */
  supportRecall: number;
  /** Precision uoc luong: fact ho tro lay duoc / tong text lay ve. */
  precision: number;
  f1: number;
  perCategory: V13BenchmarkCategoryScore[];
  perQuestion: V13BenchmarkPerQuestion[];
  notes: string[];
}

/** Retriever ma benchmark goi: nhan cau hoi, tra text da lay ve. */
export type V13BenchmarkRetriever = (
  question: V13BenchmarkQuestion,
) => Promise<string[]> | string[];

export interface V13BenchmarkOptions {
  topK?: number;
}

/**
 * Dataset mau xac dinh: 4 user hu cau (An, Binh, Chi, Dung) voi
 * lich su doi cho o / doi mon an yeu thich theo thoi gian + 12 cau
 * hoi. Du lieu co dinh trong code — khong random, chay lai cho cung
 * ket qua.
 */
export function buildSampleBenchmarkDataset(): V13BenchmarkDataset {
  const seedFacts: V13BenchmarkSeedFact[] = [
    { key: 'an|lives_in|ha noi', subject: 'An', predicate: 'lives_in', objectText: 'Ha Noi', confidence: 0.9, validFrom: '2025-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z', sourceText: 'An song o Ha Noi tu nam 2025.' },
    { key: 'an|lives_in|da nang', subject: 'An', predicate: 'lives_in', objectText: 'Da Nang', confidence: 0.9, validFrom: '2026-03-01T00:00:00.000Z', validUntil: null, sourceText: 'An chuyen ve Da Nang thang 3/2026.' },
    { key: 'an|likes|pho bo', subject: 'An', predicate: 'likes', objectText: 'pho bo', confidence: 0.85, validFrom: '2025-06-01T00:00:00.000Z', validUntil: null, sourceText: 'An rat thich pho bo.' },
    { key: 'binh|likes|bun cha', subject: 'Binh', predicate: 'likes', objectText: 'bun cha', confidence: 0.85, validFrom: '2025-06-01T00:00:00.000Z', validUntil: null, sourceText: 'Binh thich bun cha.' },
    { key: 'binh|works_at|cong ty xanh', subject: 'Binh', predicate: 'works_at', objectText: 'Cong ty Xanh', confidence: 0.9, validFrom: '2024-01-01T00:00:00.000Z', validUntil: '2026-01-15T00:00:00.000Z', sourceText: 'Binh lam o Cong ty Xanh.' },
    { key: 'binh|works_at|cong ty do', subject: 'Binh', predicate: 'works_at', objectText: 'Cong ty Do', confidence: 0.9, validFrom: '2026-01-15T00:00:00.000Z', validUntil: null, sourceText: 'Binh chuyen sang Cong ty Do thang 1/2026.' },
    { key: 'chi|likes|tra sua', subject: 'Chi', predicate: 'likes', objectText: 'tra sua', confidence: 0.8, validFrom: '2025-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z', sourceText: 'Chi thich tra sua.' },
    { key: 'chi|likes|ca phe den', subject: 'Chi', predicate: 'likes', objectText: 'ca phe den', confidence: 0.85, validFrom: '2026-02-01T00:00:00.000Z', validUntil: null, sourceText: 'Chi doi sang ca phe den thang 2/2026.' },
    { key: 'chi|speaks|tieng nhat', subject: 'Chi', predicate: 'speaks', objectText: 'tieng Nhat', confidence: 0.8, validFrom: '2025-01-01T00:00:00.000Z', validUntil: null, sourceText: 'Chi noi tieng Nhat.' },
    { key: 'dung|lives_in|ho chi minh', subject: 'Dung', predicate: 'lives_in', objectText: 'Ho Chi Minh', confidence: 0.9, validFrom: '2025-01-01T00:00:00.000Z', validUntil: null, sourceText: 'Dung song o Ho Chi Minh.' },
    { key: 'dung|likes|com tam', subject: 'Dung', predicate: 'likes', objectText: 'com tam', confidence: 0.85, validFrom: '2025-01-01T00:00:00.000Z', validUntil: null, sourceText: 'Dung thich com tam.' },
    { key: 'dung|works_at|cong ty vang', subject: 'Dung', predicate: 'works_at', objectText: 'Cong ty Vang', confidence: 0.9, validFrom: '2025-03-01T00:00:00.000Z', validUntil: null, sourceText: 'Dung lam o Cong ty Vang.' },
  ];
  const questions: V13BenchmarkQuestion[] = [
    { id: 'q01', category: 'temporal', question: 'An song o dau vao thang 2/2026?', expectedAnswer: 'Ha Noi', supportingFactKeys: ['an|lives_in|ha noi'], asOf: '2026-02-15T00:00:00.000Z' },
    { id: 'q02', category: 'temporal', question: 'An song o dau vao thang 4/2026?', expectedAnswer: 'Da Nang', supportingFactKeys: ['an|lives_in|da nang'], asOf: '2026-04-15T00:00:00.000Z' },
    { id: 'q03', category: 'temporal', question: 'Binh lam o dau vao thang 6/2025?', expectedAnswer: 'Cong ty Xanh', supportingFactKeys: ['binh|works_at|cong ty xanh'], asOf: '2025-06-15T00:00:00.000Z' },
    { id: 'q04', category: 'temporal', question: 'Binh lam o dau hien tai?', expectedAnswer: 'Cong ty Do', supportingFactKeys: ['binh|works_at|cong ty do'] },
    { id: 'q05', category: 'preference', question: 'An thich mon an gi?', expectedAnswer: 'pho bo', supportingFactKeys: ['an|likes|pho bo'] },
    { id: 'q06', category: 'preference', question: 'Binh thich mon an gi?', expectedAnswer: 'bun cha', supportingFactKeys: ['binh|likes|bun cha'] },
    { id: 'q07', category: 'preference', question: 'Dung thich mon an gi?', expectedAnswer: 'com tam', supportingFactKeys: ['dung|likes|com tam'] },
    { id: 'q08', category: 'contradiction', question: 'Chi thich uong gi hien tai — tra sua hay ca phe den?', expectedAnswer: 'ca phe den', supportingFactKeys: ['chi|likes|ca phe den'] },
    { id: 'q09', category: 'contradiction', question: 'Chi thich uong gi vao thang 1/2026?', expectedAnswer: 'tra sua', supportingFactKeys: ['chi|likes|tra sua'], asOf: '2026-01-15T00:00:00.000Z' },
    { id: 'q10', category: 'multi-hop', question: 'Nguoi song o Da Nang thich mon an gi?', expectedAnswer: 'pho bo', supportingFactKeys: ['an|lives_in|da nang', 'an|likes|pho bo'] },
    { id: 'q11', category: 'multi-hop', question: 'Nguoi lam o Cong ty Do thich mon an gi?', expectedAnswer: 'bun cha', supportingFactKeys: ['binh|works_at|cong ty do', 'binh|likes|bun cha'] },
    { id: 'q12', category: 'multi-hop', question: 'Chi noi tieng gi va thich uong gi hien tai?', expectedAnswer: 'ca phe den', supportingFactKeys: ['chi|speaks|tieng nhat', 'chi|likes|ca phe den'] },
  ];
  return { name: 'open-bot-memory-v13-sample', version: 1, questions, seedFacts };
}

/**
 * Nap fact mau vao store (add-only, scope rong = user hien tai).
 * Tra ve map key -> fact that de test doi chieu.
 */
export function seedBenchmarkFacts(
  store: TemporalGraphStore,
  dataset: V13BenchmarkDataset,
  scope: { userId: string; botId: string; runId: string } = { userId: '', botId: '', runId: '' },
): Map<string, GraphFact> {
  const out = new Map<string, GraphFact>();
  for (const seed of dataset.seedFacts) {
    const fact = store.addFact({
      subjectName: seed.subject,
      predicate: seed.predicate,
      objectText: seed.objectText,
      confidence: seed.confidence,
      scope: { ...scope },
      provenance: {
        episodeId: `bench-${seed.key}`,
        turnId: 'seed',
        runId: scope.runId,
        botId: scope.botId,
        userId: scope.userId,
        at: seed.validFrom,
        sourceText: seed.sourceText,
      },
      validFrom: seed.validFrom,
      ...(seed.validUntil ? { validUntil: seed.validUntil } : {}),
    });
    out.set(seed.key, fact);
  }
  return out;
}

/** Chuan hoa text de so khop dap an (bo dau, chu thuong). */
export function normalizeAnswerText(text: string): string {
  return normalizeGraphText(text ?? '');
}

/**
 * Kiem tra dap an co xuat hien trong cac text lay ve khong (so khop
 * sau khi chuan hoa bo dau tieng Viet).
 */
export function answerAppearsIn(expectedAnswer: string, retrievedTexts: string[]): boolean {
  const needle = normalizeAnswerText(expectedAnswer);
  if (needle === '') return false;
  return retrievedTexts.some((t) => normalizeAnswerText(t).includes(needle));
}

/**
 * Kiem tra mot fact ho tro co duoc lay ve khong: text lay ve phai
 * chua ca object (da chuan hoa) cua fact do.
 */
export function supportingFactRetrieved(
  seedFact: V13BenchmarkSeedFact,
  retrievedTexts: string[],
): boolean {
  const needle = normalizeAnswerText(seedFact.objectText);
  if (needle === '') return false;
  return retrievedTexts.some((t) => normalizeAnswerText(t).includes(needle));
}

function f1Of(precision: number, recall: number): number {
  if (precision + recall <= 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** Chay benchmark: goi retriever cho tung cau, cham diem, tong hop. */
export async function runV13Benchmark(
  retriever: V13BenchmarkRetriever,
  dataset: V13BenchmarkDataset,
  opts: V13BenchmarkOptions = {},
): Promise<V13BenchmarkResult> {
  const topK = Math.max(1, Math.min(50, Math.floor(opts.topK ?? 5)));
  const seedByKey = new Map(dataset.seedFacts.map((f) => [f.key, f]));
  const perQuestion: V13BenchmarkPerQuestion[] = [];
  const notes: string[] = [];
  let totalRetrieved = 0;
  let totalSupportFound = 0;
  let totalSupport = 0;

  for (const q of dataset.questions) {
    let retrieved: string[];
    try {
      retrieved = (await retriever(q)) ?? [];
    } catch (err) {
      notes.push(`Retriever loi o ${q.id}: ${(err as Error).message}`);
      retrieved = [];
    }
    const top = retrieved.slice(0, topK);
    totalRetrieved += top.length;
    const answerHit = answerAppearsIn(q.expectedAnswer, top);
    let found = 0;
    for (const key of q.supportingFactKeys) {
      const seed = seedByKey.get(key);
      if (!seed) {
        notes.push(`Cau ${q.id} tro toi fact mau khong ton tai: ${key}`);
        continue;
      }
      if (supportingFactRetrieved(seed, top)) found += 1;
    }
    totalSupportFound += found;
    totalSupport += q.supportingFactKeys.length;
    perQuestion.push({
      id: q.id,
      category: q.category,
      question: q.question,
      expectedAnswer: q.expectedAnswer,
      answerHit,
      supportRecall:
        q.supportingFactKeys.length === 0 ? 0 : found / q.supportingFactKeys.length,
      supportFound: found,
      supportTotal: q.supportingFactKeys.length,
      retrievedCount: top.length,
    });
  }

  const answerHitRate =
    perQuestion.length === 0
      ? 0
      : perQuestion.filter((p) => p.answerHit).length / perQuestion.length;
  const supportRecall = totalSupport === 0 ? 0 : totalSupportFound / totalSupport;
  // Precision uoc luong: so fact ho tro lay duoc / tong so text lay ve.
  const precision = totalRetrieved === 0 ? 0 : totalSupportFound / totalRetrieved;
  const f1 = f1Of(precision, supportRecall);

  const categories: V13BenchmarkCategory[] = ['temporal', 'preference', 'contradiction', 'multi-hop'];
  const perCategory: V13BenchmarkCategoryScore[] = categories
    .map((category) => {
      const rows = perQuestion.filter((p) => p.category === category);
      if (rows.length === 0) return null;
      const hitRate = rows.filter((r) => r.answerHit).length / rows.length;
      const recall = rows.reduce((s, r) => s + r.supportRecall, 0) / rows.length;
      const found = rows.reduce((s, r) => s + r.supportFound, 0);
      const retrieved = rows.reduce((s, r) => s + r.retrievedCount, 0);
      const prec = retrieved === 0 ? 0 : found / retrieved;
      return {
        category,
        questions: rows.length,
        answerHitRate: hitRate,
        supportRecall: recall,
        f1: f1Of(prec, recall),
      };
    })
    .filter((c): c is V13BenchmarkCategoryScore => c !== null);

  return {
    dataset: dataset.name,
    datasetVersion: dataset.version,
    topK,
    questions: dataset.questions.length,
    answerHitRate,
    supportRecall,
    precision,
    f1,
    perCategory,
    perQuestion,
    notes,
  };
}

/** Dinh dang ket qua benchmark dang markdown (de ghi log / hien UI). */
export function formatBenchmarkReport(result: V13BenchmarkResult): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [
    `# Benchmark memory v13 — ${result.dataset} (v${result.datasetVersion})`,
    '',
    `- Cau hoi: ${result.questions}, topK: ${result.topK}`,
    `- Answer hit rate: ${pct(result.answerHitRate)}`,
    `- Support recall: ${pct(result.supportRecall)}`,
    `- Precision (uoc luong): ${pct(result.precision)}`,
    `- F1: ${pct(result.f1)}`,
    '',
    '| Nhom | Cau | Answer hit | Support recall | F1 |',
    '|---|---|---|---|---|',
  ];
  for (const c of result.perCategory) {
    lines.push(
      `| ${c.category} | ${c.questions} | ${pct(c.answerHitRate)} | ${pct(c.supportRecall)} | ${pct(c.f1)} |`,
    );
  }
  lines.push('', '## Tung cau', '');
  for (const p of result.perQuestion) {
    lines.push(
      `- ${p.id} [${p.category}] ${p.answerHit ? 'HIT' : 'MISS'} ` +
        `(support ${p.supportFound}/${p.supportTotal}): ${p.question} → "${p.expectedAnswer}"`,
    );
  }
  if (result.notes.length > 0) {
    lines.push('', '## Ghi chu', '');
    for (const n of result.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}
