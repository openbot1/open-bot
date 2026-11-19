/**
 * Cost-aware routing (v1.41, Doi T3).
 *
 * Chon model re nhat dat nguong chat luong cho task nhe, chi leo len
 * model dat/khoe khi task kho hoac can da phuong thuc — ke thua y
 * tuong cua MidChatRouter v117 (do kho theo signal) nhung quyet dinh
 * theo CHI PHI: gia / 1k token + do kho + yeu cau chat luong toi
 * thieu + budget con lai cua bot.
 *
 * Thuan logic (khong goi model that, khong doc credential). Gia la
 * uoc tinh khai bao (USD / 1k token) do host cap nhat; router khong
 * tu fetch gia live.
 */

/** Mo ta mot model ung vien cho cost-aware routing. */
export interface CostModelCandidate {
  modelId: string;
  provider: string;
  /** USD / 1k token input (uoc tinh). */
  costPer1kInputUsd: number;
  /** USD / 1k token output (uoc tinh). */
  costPer1kOutputUsd: number;
  /** Chat luong uoc tinh 0..1 (so voi model manh nhat = 1). */
  quality: number;
  /** Do tre uoc tinh (ms cho mot turn ngan). */
  latencyMs: number;
  multimodal: boolean;
  maxContextTokens: number;
  /** Model chay local (mien phi) khong. */
  local: boolean;
}

/** Task can route theo chi phi. */
export interface CostRoutingTask {
  /** Do kho 0..1 (co the lay tu analyzeMidChatMessage cua v117). */
  difficulty: number;
  /** Co anh dinh kem khong. */
  hasImage?: boolean;
  /** Chat luong toi thieu chap nhan duoc 0..1 (mac dinh 0.6). */
  minQuality?: number;
  /** So token input uoc tinh (mac dinh 1000). */
  estimatedInputTokens?: number;
  /** So token output uoc tinh (mac dinh 500). */
  estimatedOutputTokens?: number;
  /** Budget con lai cua bot (USD); 0/undefined = khong gioi han. */
  budgetRemainingUsd?: number;
}

/** Quyet dinh cost-aware routing. */
export interface CostRoutingDecision {
  chosenModelId: string;
  provider: string;
  estimatedCostUsd: number;
  estimatedCostVsStrongestUsd: number;
  savedUsd: number;
  savedPct: number;
  quality: number;
  difficulty: number;
  /** Model re nhat dat nguong (neu khac chosen thi do rang buoc khac). */
  cheapestEligibleModelId: string;
  rejected: { modelId: string; reason: string }[];
  reasons: string[];
}

/** Candidate mac dinh (gia uoc tinh 2026-11, local = 0). */
export function defaultCostCandidates(): CostModelCandidate[] {
  return [
    {
      modelId: 'qwen3-0.6b',
      provider: 'ollama',
      costPer1kInputUsd: 0,
      costPer1kOutputUsd: 0,
      quality: 0.45,
      latencyMs: 120,
      multimodal: false,
      maxContextTokens: 32768,
      local: true,
    },
    {
      modelId: 'qwen3-4b',
      provider: 'ollama',
      costPer1kInputUsd: 0,
      costPer1kOutputUsd: 0,
      quality: 0.7,
      latencyMs: 350,
      multimodal: false,
      maxContextTokens: 32768,
      local: true,
    },
    {
      modelId: 'gemma-3-12b',
      provider: 'ollama',
      costPer1kInputUsd: 0,
      costPer1kOutputUsd: 0,
      quality: 0.82,
      latencyMs: 700,
      multimodal: true,
      maxContextTokens: 131072,
      local: true,
    },
    {
      modelId: 'claude-sonnet-4-5',
      provider: 'anthropic',
      costPer1kInputUsd: 0.003,
      costPer1kOutputUsd: 0.015,
      quality: 0.93,
      latencyMs: 900,
      multimodal: true,
      maxContextTokens: 200000,
      local: false,
    },
    {
      modelId: 'claude-opus-5-1',
      provider: 'anthropic',
      costPer1kInputUsd: 0.005,
      costPer1kOutputUsd: 0.025,
      quality: 1,
      latencyMs: 1400,
      multimodal: true,
      maxContextTokens: 200000,
      local: false,
    },
    {
      modelId: 'gpt-5-mini',
      provider: 'openai',
      costPer1kInputUsd: 0.00025,
      costPer1kOutputUsd: 0.002,
      quality: 0.85,
      latencyMs: 600,
      multimodal: true,
      maxContextTokens: 400000,
      local: false,
    },
    {
      modelId: 'gemini-2.5-flash',
      provider: 'gemini',
      costPer1kInputUsd: 0.0003,
      costPer1kOutputUsd: 0.0025,
      quality: 0.86,
      latencyMs: 500,
      multimodal: true,
      maxContextTokens: 1048576,
      local: false,
    },
    {
      modelId: 'grok-4-1',
      provider: 'xai',
      costPer1kInputUsd: 0.003,
      costPer1kOutputUsd: 0.015,
      quality: 0.92,
      latencyMs: 1000,
      multimodal: true,
      maxContextTokens: 256000,
      local: false,
    },
  ];
}

/** Uoc tinh chi phi mot turn theo candidate + token. */
export function estimateTurnCost(
  candidate: CostModelCandidate,
  inputTokens: number,
  outputTokens: number,
): number {
  const cost =
    (inputTokens / 1000) * candidate.costPer1kInputUsd +
    (outputTokens / 1000) * candidate.costPer1kOutputUsd;
  return Math.round(cost * 1e6) / 1e6;
}

/** Do kho can chat luong toi thieu bao nhieu (task cang kho, nguong cang cao). */
export function requiredQualityForDifficulty(difficulty: number): number {
  const d = Math.min(1, Math.max(0, difficulty));
  if (d < 0.3) return 0.45;
  if (d < 0.55) return 0.65;
  if (d < 0.75) return 0.8;
  return 0.9;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Chon model: loc ung vien dat nguong chat luong (max cua minQuality
 * caller yeu cau va nguong theo do kho), loai model khong da phuong
 * thuc khi co anh, loai model vuot budget, roi chon re nhat (hoa neu
 * cung gia thi lay latency thap hon).
 */
export function chooseCostAwareModel(
  task: CostRoutingTask,
  candidates: readonly CostModelCandidate[] = defaultCostCandidates(),
): CostRoutingDecision {
  const difficulty = Math.min(1, Math.max(0, task.difficulty));
  const minQuality = Math.max(
    task.minQuality ?? 0,
    requiredQualityForDifficulty(difficulty),
  );
  const inputTokens = task.estimatedInputTokens ?? 1000;
  const outputTokens = task.estimatedOutputTokens ?? 500;
  const budget = task.budgetRemainingUsd ?? 0;
  const rejected: { modelId: string; reason: string }[] = [];
  const reasons: string[] = [];

  const eligible: CostModelCandidate[] = [];
  for (const c of candidates) {
    if (c.quality < minQuality) {
      rejected.push({ modelId: c.modelId, reason: `quality ${c.quality} < ${minQuality} (task kho ${difficulty}).` });
      continue;
    }
    if (task.hasImage === true && !c.multimodal) {
      rejected.push({ modelId: c.modelId, reason: 'Task co anh nhung model khong da phuong thuc.' });
      continue;
    }
    const cost = estimateTurnCost(c, inputTokens, outputTokens);
    if (budget > 0 && cost > budget) {
      rejected.push({ modelId: c.modelId, reason: `Chi phi uoc tinh $${cost} vuot budget con lai $${budget}.` });
      continue;
    }
    eligible.push(c);
  }

  // Khong con ung vien: ha nguong xuong muc chat luong cao nhat co the
  // (fail-open co kiem soat, kem ly do) thay vi tra loi rong.
  let pool = eligible;
  if (pool.length === 0) {
    const sorted = [...candidates].sort((a, b) => b.quality - a.quality);
    const best = sorted[0];
    if (best) {
      pool = [best];
      reasons.push(
        `Khong co model dat nguong quality ${minQuality} trong budget — dung model chat luong cao nhat (${best.modelId}) kem canh bao.`,
      );
    }
  }
  if (pool.length === 0) {
    throw new Error('Khong co candidate nao de route.');
  }

  const sorted = [...pool].sort((a, b) => {
    const ca = estimateTurnCost(a, inputTokens, outputTokens);
    const cb = estimateTurnCost(b, inputTokens, outputTokens);
    if (ca !== cb) return ca - cb;
    return a.latencyMs - b.latencyMs;
  });
  const chosen = sorted[0] as CostModelCandidate;
  const strongest = [...candidates].sort((a, b) => b.quality - a.quality)[0] as CostModelCandidate;
  const chosenCost = estimateTurnCost(chosen, inputTokens, outputTokens);
  const strongestCost = estimateTurnCost(strongest, inputTokens, outputTokens);
  const savedUsd = round6(Math.max(0, strongestCost - chosenCost));
  const savedPct = strongestCost > 0 ? Math.round((savedUsd / strongestCost) * 1000) / 10 : 0;

  reasons.push(
    `Task kho ${difficulty} can quality >= ${minQuality}; chon ${chosen.modelId} (${chosen.provider}) re nhat trong ${pool.length} ung vien dat chuan.`,
  );
  if (chosen.local) reasons.push('Model local: chi phi $0.');
  if (savedUsd > 0) reasons.push(`Tiet kiem $${savedUsd} (${savedPct}%) so voi model manh nhat ${strongest.modelId}.`);

  return {
    chosenModelId: chosen.modelId,
    provider: chosen.provider,
    estimatedCostUsd: round6(chosenCost),
    estimatedCostVsStrongestUsd: round6(strongestCost),
    savedUsd,
    savedPct,
    quality: chosen.quality,
    difficulty,
    cheapestEligibleModelId: chosen.modelId,
    rejected,
    reasons,
  };
}

/** Nhat ky chi phi theo bot (in-memory, host tong hop theo ngay neu can). */
export interface CostLedgerEntry {
  botId: string;
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  at: number;
}

export class CostLedger {
  private entries: CostLedgerEntry[] = [];

  record(entry: Omit<CostLedgerEntry, 'at'> & { at?: number }): CostLedgerEntry {
    const full: CostLedgerEntry = { ...entry, at: entry.at ?? Date.now() };
    this.entries.push(full);
    if (this.entries.length > 1000) this.entries = this.entries.slice(-1000);
    return full;
  }

  totalCostUsd(botId?: string): number {
    const sum = this.entries
      .filter((e) => botId === undefined || e.botId === botId)
      .reduce((s, e) => s + e.costUsd, 0);
    return round6(sum);
  }

  totalTokens(botId?: string): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const e of this.entries) {
      if (botId !== undefined && e.botId !== botId) continue;
      input += e.inputTokens;
      output += e.outputTokens;
    }
    return { input, output };
  }

  byModel(botId?: string): { modelId: string; costUsd: number; turns: number }[] {
    const map = new Map<string, { costUsd: number; turns: number }>();
    for (const e of this.entries) {
      if (botId !== undefined && e.botId !== botId) continue;
      const cur = map.get(e.modelId) ?? { costUsd: 0, turns: 0 };
      cur.costUsd += e.costUsd;
      cur.turns += 1;
      map.set(e.modelId, cur);
    }
    return [...map.entries()]
      .map(([modelId, v]) => ({ modelId, costUsd: round6(v.costUsd), turns: v.turns }))
      .sort((a, b) => b.costUsd - a.costUsd);
  }

  count(): number {
    return this.entries.length;
  }

  /** Ban sao cac entry (de tong hop ben ngoai ma khong sua ledger). */
  snapshot(botId?: string): CostLedgerEntry[] {
    return this.entries
      .filter((e) => botId === undefined || e.botId === botId)
      .map((e) => ({ ...e }));
  }

  clear(): void {
    this.entries = [];
  }
}

/** Bao cao tiet kiem: tong chi phi that vs neu toan chay model manh nhat. */
export function summarizeCostSaving(
  ledger: CostLedger,
  candidates: readonly CostModelCandidate[] = defaultCostCandidates(),
  botId?: string,
): { spentUsd: number; wouldSpendUsd: number; savedUsd: number; savedPct: number; turns: number } {
  const strongest = [...candidates].sort((a, b) => b.quality - a.quality)[0];
  const entries = ledger.snapshot(botId);
  let would = 0;
  for (const e of entries) {
    if (strongest) would += estimateTurnCost(strongest, e.inputTokens, e.outputTokens);
  }
  const spent = ledger.totalCostUsd(botId);
  const wouldSpendUsd = round6(would);
  const savedUsd = round6(Math.max(0, wouldSpendUsd - spent));
  const savedPct = wouldSpendUsd > 0 ? Math.round((savedUsd / wouldSpendUsd) * 1000) / 10 : 0;
  return { spentUsd: spent, wouldSpendUsd, savedUsd, savedPct, turns: entries.length };
}
