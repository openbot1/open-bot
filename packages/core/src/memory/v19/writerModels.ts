/**
 * Memory v19 — BYOK writer model registry (v1.20, Doi T1).
 *
 * Y tuong hoc tu Mem0 BYOK (model nao viet memory, 17 writer model
 * so sanh tren LoCoMo) + Letta FrontierMemory (benchmark memory
 * kieu khac, cho ket qua khac) — tu thiet ke lai hoan toan cho
 * open-bot, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * NGUYEN TAC TRUNG THUC CUA MODULE NAY (doc ky truoc khi dung):
 *  - Cac con so accuracy / gia trong `V19_WRITER_MODEL_REFERENCE`
 *    la SO THAM KHAO tu nghien cuu ben ngoai (ghi ro `source` tung
 *    muc), KHONG phai so do duoc boi open-bot. Chung chi dung de
 *    chon model mac dinh + uoc tinh chi phi, KHONG dung lam bang
 *    chung hieu nang.
 *  - Hai benchmark LoCoMo va FrontierMemory CHO KET QUA TRAI NGUOC
 *    nhau tren cung model (vd GPT-6 Luna gan top LoCoMo nhung chot
 *    FrontierMemory 28,9%). Vi vay KHONG co "model tot nhat tuyet
 *    doi": module nay luu ca hai benchmark rieng biet, va ham chon
 *    model bat buoc nguoi goi chi ro benchmark nao dang toi uu
 *    (`benchmark: 'locomo' | 'frontier' | 'balanced'`).
 *  - So do that cua open-bot chi co khi chay `evalFrontier.ts`
 *    (harness chay local): ket qua do duoc ghi de len so tham khao
 *    trong bao cao eval, khong ghi de registry nay.
 *  - Gia USD la gia tham khao tai thoi diem nghien cuu (11/2026),
 *    co the da doi: host nen cap nhat `inputUsdPerMillion` /
 *    `outputUsdPerMillion` khi gia that thay doi; ham tinh chi phi
 *    luon dung gia trong profile dang co, khong hard-code gia moi.
 *
 * BYOK: user dung model nao viet memory tuy y (key cua user, qua
 * provider interface co san cua open-bot). Registry nay chi mo ta
 * model + tinh chi phi + goi y lua chon; no KHONG goi model, KHONG
 * goi mang, KHONG giu key.
 */

/** Loi writer model registry — message tieng Viet. */
export class V19WriterModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V19WriterModelError';
  }
}

/** Benchmark ma so accuracy tham khao dang noi toi. */
export type V19WriterBenchmark = 'locomo' | 'frontier';

/** Nguon goc cua mot con so tham khao. */
export type V19ReferenceSource =
  | 'research-brief-2026-11' // so trong brief nghien cuu song v1.20
  | 'vendor-reported' // so vendor tu bao cao (chua kiem chung doc lap)
  | 'measured-locally'; // so do duoc boi harness open-bot (ghi de sau)

/** Nhom gia / nang luc cua writer model. */
export type V19WriterTier = 'flagship' | 'balanced' | 'cheap' | 'local';

/** Ho so mot writer model co the viet memory (BYOK). */
export interface V19WriterModelProfile {
  /** Id on dinh trong registry (vd 'opus-5.5'). */
  id: string;
  /** Ten hien thi. */
  label: string;
  /** Nha cung cap (vd 'anthropic', 'openai', 'local'). */
  vendor: string;
  /** Nhom gia / nang luc. */
  tier: V19WriterTier;
  /** Accuracy tham khao tren LoCoMo (0..1), null = chua co so. */
  locomoAccuracy: number | null;
  /** Accuracy tham khao tren FrontierMemory (0..1), null = chua co so. */
  frontierAccuracy: number | null;
  /** Nguon cua so LoCoMo. */
  locomoSource: V19ReferenceSource | null;
  /** Nguon cua so FrontierMemory. */
  frontierSource: V19ReferenceSource | null;
  /** Gia input USD / 1 trieu token (tham khao, co the doi). */
  inputUsdPerMillion: number | null;
  /** Gia output USD / 1 trieu token (tham khao, co the doi). */
  outputUsdPerMillion: number | null;
  /** Do tre trung binh moi lan viet (ms, tham khao; null = chua biet). */
  avgLatencyMs: number | null;
  /** Ghi chu (vd "dat nhat", "nua gia Opus"). */
  notes: string;
}

/** So token trung binh cho 1 lan viet memory (add) — dung de uoc tinh chi phi. */
export const V19_DEFAULT_TOKENS_PER_ADD = 800;
/** Token input mac dinh moi add (episode + prompt). */
export const V19_DEFAULT_INPUT_TOKENS_PER_ADD = 600;
/** Token output mac dinh moi add (fact JSON). */
export const V19_DEFAULT_OUTPUT_TOKENS_PER_ADD = 200;

/**
 * Bang tham khao writer model (11/2026, tu brief nghien cuu song
 * v1.20). Doc ky phan dau file: day la SO THAM KHAO, khong phai so
 * do duoc. Model "re" la nhom model gia re noi chung (trong 1 diem
 * LoCoMo so voi flagship, <$10/1000 adds) — khong gan ten cu the
 * vi brief khong neu ten; host co the them profile cu the bang
 * `registerWriterModelV19`.
 *
 *  - opus-5.5: LoCoMo 93,5% (cao nhat), dat nhat.
 *  - sonnet-5.5: LoCoMo 93,4% (kem 0,1 diem), nua gia Opus.
 *  - gpt-6-luna: gan top LoCoMo NHUNG chot FrontierMemory 28,9%
 *    — vi du dien hinh cho mau thuan benchmark (xem evalFrontier).
 *  - fable-5.2 (= Opus 5.5 tren FrontierMemory): 73,3% Frontier.
 *  - cheap-tier: nhom gia re, LoCoMo trong 1 diem so flagship,
 *    duoi $10/1000 adds.
 *  - mock-writer: writer gia lap chay local (khong goi model),
 *    chi phi 0 — dung cho test + eval offline.
 */
export const V19_WRITER_MODEL_REFERENCE: readonly V19WriterModelProfile[] = [
  {
    id: 'opus-5.5',
    label: 'Opus 5.5',
    vendor: 'anthropic',
    tier: 'flagship',
    locomoAccuracy: 0.935,
    frontierAccuracy: 0.733,
    locomoSource: 'research-brief-2026-11',
    frontierSource: 'research-brief-2026-11',
    inputUsdPerMillion: 15,
    outputUsdPerMillion: 75,
    avgLatencyMs: 2400,
    notes: 'LoCoMo cao nhat (93,5%), dat nhat. FrontierMemory 73,3% (duoi ten Fable 5.2).',
  },
  {
    id: 'sonnet-5.5',
    label: 'Sonnet 5.5',
    vendor: 'anthropic',
    tier: 'balanced',
    locomoAccuracy: 0.934,
    frontierAccuracy: null,
    locomoSource: 'research-brief-2026-11',
    frontierSource: null,
    inputUsdPerMillion: 7.5,
    outputUsdPerMillion: 37.5,
    avgLatencyMs: 1600,
    notes: 'LoCoMo 93,4% (kem Opus 0,1 diem), gia khoang nua Opus — lua chon can bang tot nhat theo brief.',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    vendor: 'openai',
    tier: 'flagship',
    locomoAccuracy: 0.92,
    frontierAccuracy: 0.289,
    locomoSource: 'research-brief-2026-11',
    frontierSource: 'research-brief-2026-11',
    inputUsdPerMillion: 10,
    outputUsdPerMillion: 40,
    avgLatencyMs: 1800,
    notes: 'CANH BAO MAU THUAN: gan top LoCoMo nhung CHOT FrontierMemory (28,9%). Dung lam vi du mau thuan benchmark.',
  },
  {
    id: 'cheap-tier',
    label: 'Cheap tier (nhom gia re)',
    vendor: 'various',
    tier: 'cheap',
    locomoAccuracy: 0.925,
    frontierAccuracy: null,
    locomoSource: 'research-brief-2026-11',
    frontierSource: null,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 4,
    avgLatencyMs: 900,
    notes: 'Nhom model re: LoCoMo trong 1 diem so voi flagship, duoi $10/1000 adds. Them profile cu the khi co gia that.',
  },
  {
    id: 'mock-writer',
    label: 'Mock writer (local, khong goi model)',
    vendor: 'local',
    tier: 'local',
    locomoAccuracy: null,
    frontierAccuracy: null,
    locomoSource: null,
    frontierSource: null,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    avgLatencyMs: 5,
    notes: 'Writer gia lap chay local: chi phi 0, dung cho test va eval offline. Accuracy do bang harness, khong co so tham khao.',
  },
];

/** Registry writer model (ban sao cua bang tham khao + model host dang ky them). */
export class V19WriterModelRegistry {
  private readonly models = new Map<string, V19WriterModelProfile>();

  constructor(initial: readonly V19WriterModelProfile[] = V19_WRITER_MODEL_REFERENCE) {
    for (const m of initial) this.models.set(m.id, { ...m });
  }

  /** Liet ke tat ca profile (ban sao, khong sua duoc registry qua ket qua). */
  list(): V19WriterModelProfile[] {
    return [...this.models.values()].map((m) => ({ ...m }));
  }

  /** Tim profile theo id (undefined neu khong co). */
  get(id: string): V19WriterModelProfile | undefined {
    const found = this.models.get(id);
    return found ? { ...found } : undefined;
  }

  /** Dang ky / ghi de mot profile (host them model cu the, gia that). */
  register(profile: V19WriterModelProfile): void {
    validateWriterProfileV19(profile);
    this.models.set(profile.id, { ...profile });
  }

  /** Xoa mot profile khoi registry (khong xoa duoc mock-writer). */
  remove(id: string): boolean {
    if (id === 'mock-writer') return false;
    return this.models.delete(id);
  }
}

/** Registry mac dinh dung chung (chi doc qua ham, khong export truc tiep). */
let defaultRegistryV19: V19WriterModelRegistry | undefined;

/** Lay registry mac dinh (tao mot lan). */
export function getDefaultWriterRegistryV19(): V19WriterModelRegistry {
  if (!defaultRegistryV19) defaultRegistryV19 = new V19WriterModelRegistry();
  return defaultRegistryV19;
}

/** Kiem tra tinh hop le cua profile (throw V19WriterModelError neu sai). */
export function validateWriterProfileV19(profile: V19WriterModelProfile): void {
  if (!profile || typeof profile.id !== 'string' || profile.id.trim() === '') {
    throw new V19WriterModelError('Writer model phai co id khong rong.');
  }
  for (const acc of [profile.locomoAccuracy, profile.frontierAccuracy]) {
    if (acc !== null && (!Number.isFinite(acc) || acc < 0 || acc > 1)) {
      throw new V19WriterModelError(`Accuracy tham khao cua "${profile.id}" phai trong [0,1] hoac null.`);
    }
  }
  for (const price of [profile.inputUsdPerMillion, profile.outputUsdPerMillion]) {
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      throw new V19WriterModelError(`Gia cua "${profile.id}" phai >= 0 hoac null.`);
    }
  }
  if (
    profile.avgLatencyMs !== null &&
    (!Number.isFinite(profile.avgLatencyMs) || profile.avgLatencyMs < 0)
  ) {
    throw new V19WriterModelError(`Do tre cua "${profile.id}" phai >= 0 hoac null.`);
  }
}

/** Clamp 0..1. */
export function clamp01V19Writer(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Uoc tinh chi phi USD cho 1000 lan viet (adds) cua mot profile.
 * Tra ve null khi profile chua co gia (khong doan gia).
 */
export function estimateCostPer1000AddsV19(
  profile: V19WriterModelProfile,
  inputTokensPerAdd: number = V19_DEFAULT_INPUT_TOKENS_PER_ADD,
  outputTokensPerAdd: number = V19_DEFAULT_OUTPUT_TOKENS_PER_ADD,
): number | null {
  if (profile.inputUsdPerMillion === null || profile.outputUsdPerMillion === null) return null;
  if (inputTokensPerAdd < 0 || outputTokensPerAdd < 0) {
    throw new V19WriterModelError('So token moi add phai >= 0.');
  }
  const perAdd =
    (inputTokensPerAdd * profile.inputUsdPerMillion) / 1_000_000 +
    (outputTokensPerAdd * profile.outputUsdPerMillion) / 1_000_000;
  return perAdd * 1000;
}

/**
 * Chi phi USD cho mot lan viet (add) — dung khi harness do that
 * (truyen token that do duoc thay vi mac dinh).
 */
export function costOfOneAddV19(
  profile: V19WriterModelProfile,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (profile.inputUsdPerMillion === null || profile.outputUsdPerMillion === null) return null;
  if (inputTokens < 0 || outputTokens < 0) {
    throw new V19WriterModelError('So token phai >= 0.');
  }
  return (
    (inputTokens * profile.inputUsdPerMillion) / 1_000_000 +
    (outputTokens * profile.outputUsdPerMillion) / 1_000_000
  );
}

/** Tieu chi chon writer model. */
export interface V19WriterPickCriteria {
  /** Benchmark dang toi uu (bat buoc chi ro — khong co "tot nhat tuyet doi"). */
  benchmark: V19WriterBenchmark | 'balanced';
  /** Accuracy toi thieu chap nhan tren benchmark do (mac dinh 0.9). */
  minAccuracy?: number;
  /** Chi phi toi da USD/1000 adds (mac dinh khong gioi han). */
  maxCostPer1000Adds?: number;
  /** Chi chon tier nay (vd chi 'cheap'). */
  tier?: V19WriterTier;
}

/** Ket qua lua chon writer model (kem ly do de UI giai thich). */
export interface V19WriterPickResult {
  profile: V19WriterModelProfile;
  /** Accuracy tren benchmark dang toi uu (null = chua co so tham khao). */
  accuracy: number | null;
  /** Chi phi uoc tinh USD/1000 adds (null = chua co gia). */
  costPer1000Adds: number | null;
  /** Ly do chon (de UI hien thi, khong phai so "tot nhat"). */
  reason: string;
}

/**
 * Chon writer model theo tieu chi. Quy tac:
 *  - Loai model khong co so accuracy tren benchmark dang toi uu
 *    (tru mock-writer chi dung cho test — chi chon khi khong con
 *    lua chon nao khac va criteria cho phep).
 *  - Trong so dat minAccuracy + maxCost, chon RE NHAT (tien it
 *    nhat cho cung muc accuracy) — vi brief cho thay model re
 *    chi kem flagship < 1 diem LoCoMo.
 *  - 'balanced': trung binh hai benchmark (chi tinh model co ca hai
 *    so); neu khong co model nao du ca hai, fallback ve LoCoMo.
 * Throw V19WriterModelError khi khong co model nao dat tieu chi.
 */
export function pickWriterModelV19(
  registry: V19WriterModelRegistry,
  criteria: V19WriterPickCriteria,
): V19WriterPickResult {
  const minAccuracy = criteria.minAccuracy ?? 0.9;
  if (minAccuracy < 0 || minAccuracy > 1) {
    throw new V19WriterModelError('minAccuracy phai trong [0,1].');
  }
  const accuracyOf = (m: V19WriterModelProfile): number | null => {
    if (criteria.benchmark === 'locomo') return m.locomoAccuracy;
    if (criteria.benchmark === 'frontier') return m.frontierAccuracy;
    if (m.locomoAccuracy !== null && m.frontierAccuracy !== null) {
      return (m.locomoAccuracy + m.frontierAccuracy) / 2;
    }
    return m.locomoAccuracy;
  };
  const candidates: V19WriterPickResult[] = [];
  for (const m of registry.list()) {
    if (criteria.tier && m.tier !== criteria.tier) continue;
    const accuracy = accuracyOf(m);
    if (accuracy === null) continue;
    if (accuracy < minAccuracy) continue;
    const cost = estimateCostPer1000AddsV19(m);
    if (criteria.maxCostPer1000Adds !== undefined && cost !== null && cost > criteria.maxCostPer1000Adds) {
      continue;
    }
    candidates.push({
      profile: m,
      accuracy,
      costPer1000Adds: cost,
      reason: '',
    });
  }
  if (candidates.length === 0) {
    throw new V19WriterModelError(
      `Khong co writer model nao dat tieu chi (benchmark=${criteria.benchmark}, minAccuracy=${minAccuracy}` +
        `${criteria.maxCostPer1000Adds !== undefined ? `, maxCostPer1000Adds=$${criteria.maxCostPer1000Adds}` : ''}). ` +
        'Ha minAccuracy, tang budget, hoac dang ky them profile co so tham khao.',
    );
  }
  // Re nhat truoc; hoa gia thi accuracy cao hon truoc; hoa nua thi tre thap hon.
  candidates.sort((a, b) => {
    const costA = a.costPer1000Adds ?? Number.POSITIVE_INFINITY;
    const costB = b.costPer1000Adds ?? Number.POSITIVE_INFINITY;
    if (costA !== costB) return costA - costB;
    if ((b.accuracy ?? 0) !== (a.accuracy ?? 0)) return (b.accuracy ?? 0) - (a.accuracy ?? 0);
    return (a.profile.avgLatencyMs ?? Number.POSITIVE_INFINITY) - (b.profile.avgLatencyMs ?? Number.POSITIVE_INFINITY);
  });
  const best = candidates[0] as V19WriterPickResult;
  best.reason =
    `Chon "${best.profile.label}" (${best.profile.tier}): accuracy tham khao ` +
    `${best.accuracy !== null ? (best.accuracy * 100).toFixed(1) + '%' : 'chua co'} tren ${criteria.benchmark}, ` +
    `chi phi uoc tinh ${best.costPer1000Adds !== null ? '$' + best.costPer1000Adds.toFixed(2) + '/1000 adds' : 'chua co gia'} — ` +
    `re nhat trong ${candidates.length} model dat tieu chi. So tham khao, chua do local.`;
  return best;
}

/**
 * Xep hang writer model theo mot benchmark (cao -> thap), kem
 * canh bao khi mot model doi hang manh giua hai benchmark.
 * Dung cho UI so sanh, khong dung de ket luan "tot nhat".
 */
export function rankWriterModelsV19(
  registry: V19WriterModelRegistry,
  benchmark: V19WriterBenchmark,
): { profile: V19WriterModelProfile; accuracy: number }[] {
  const rows: { profile: V19WriterModelProfile; accuracy: number }[] = [];
  for (const m of registry.list()) {
    const acc = benchmark === 'locomo' ? m.locomoAccuracy : m.frontierAccuracy;
    if (acc !== null) rows.push({ profile: m, accuracy: acc });
  }
  rows.sort((a, b) => b.accuracy - a.accuracy);
  return rows;
}

/**
 * Phat hien mau thuan xep hang giua hai benchmark: model nam top
 * 2 LoCoMo nhung bottom 2 Frontier (hoac nguoc lai) — truong hop
 * GPT-6 Luna. Tra ve danh sach canh bao (rong = khong mau thuan
 * dang ke trong registry hien tai).
 */
export function detectWriterRankingContradictionV19(
  registry: V19WriterModelRegistry,
): string[] {
  const warnings: string[] = [];
  const locomo = rankWriterModelsV19(registry, 'locomo');
  const frontier = rankWriterModelsV19(registry, 'frontier');
  if (locomo.length < 2 || frontier.length < 2) return warnings;
  const topLocomo = new Set(locomo.slice(0, 2).map((r) => r.profile.id));
  const bottomFrontier = new Set(frontier.slice(-2).map((r) => r.profile.id));
  for (const id of topLocomo) {
    if (bottomFrontier.has(id)) {
      const l = locomo.find((r) => r.profile.id === id);
      const f = frontier.find((r) => r.profile.id === id);
      warnings.push(
        `MAU THUAN BENCHMARK: "${l?.profile.label ?? id}" top LoCoMo (${((l?.accuracy ?? 0) * 100).toFixed(1)}%) ` +
          `nhung chot FrontierMemory (${((f?.accuracy ?? 0) * 100).toFixed(1)}%). ` +
          `Khong tin so vendor mu — chay ca hai benchmark local truoc khi chon model nay.`,
      );
    }
  }
  return warnings;
}
