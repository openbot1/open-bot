/**
 * Model picker v2 (v1.16, Doi T3).
 *
 * Cham diem task -> model theo cost / latency / quality, co giai
 * thich tung lua chon (de UI hien "vi sao chon model nay") va ghi nho
 * lua chon cua user de lan sau uu tien.
 *
 * Quy tac (noi tiep policy v1.15, mo rong them nguon CLI + embedding):
 * - Task nho (simple-chat / summarize / translate / embedding, prompt
 *   ngan, qualityNeed thap) -> model local 3–4B (re, nhanh).
 * - Code nang / reasoning / research, prompt dai, qualityNeed cao,
 *   can tool-use manh -> cloud hoac CLI agent (model manh).
 * - Nguon CLI: re nhu local (dung login san) nhung cham hon local
 *   (phai qua CLI) va phu thuoc CLI dang chay; chat luong theo model
 *   ma CLI chay.
 * - Manual override luon duoc ton trong (neu model ton tai va kha
 *   dung); neu khong kha dung thi giai thich ro va de xuat thay the.
 * - UserChoiceMemory: moi lan user chon tay mot model cho mot dang
 *   task, lan sau model do duoc cong diem (co tran, khong lat do
 *   hoan toan quyet dinh khi task doi nang).
 */

import type {
  PickerCandidate,
  PickerPreference,
  PickerSuggestion,
  PickerTask,
  RememberedChoice,
  ScoredPickerCandidate,
} from './types';

/** Trong so cham diem theo preference cua user. */
export interface PickerWeights {
  cost: number;
  latency: number;
  quality: number;
}

/** Trong so mac dinh theo tung preference. */
export const PICKER_WEIGHTS: Record<PickerPreference, PickerWeights> = {
  speed: { cost: 0.2, latency: 0.55, quality: 0.25 },
  cost: { cost: 0.55, latency: 0.2, quality: 0.25 },
  quality: { cost: 0.15, latency: 0.2, quality: 0.65 },
  balanced: { cost: 0.3, latency: 0.3, quality: 0.4 },
};

/** Diem cong toi da nho lua chon truoc cua user (khong lat do hoan toan). */
export const MEMORY_BOOST_MAX = 0.12;

/** So lan chon toi thieu de boost dat tran. */
export const MEMORY_BOOST_FULL_AFTER = 5;

/** Task nang can model manh. */
export const HEAVY_PICKER_KINDS: ReadonlySet<PickerTask['kind']> = new Set([
  'code',
  'reasoning',
  'research',
]);

/** Prompt dai (token) thi coi la nang them. */
export const HEAVY_PROMPT_TOKENS = 8000;

/**
 * Muc nang cua task (0..1): kind + prompt + tool-use + long-context
 * + qualityNeed. Dung de giai thich + chon nguong.
 */
export function taskHeavinessV2(task: PickerTask): number {
  let score = 0;
  if (HEAVY_PICKER_KINDS.has(task.kind)) score += 0.45;
  if (task.kind === 'embedding') score += 0.05;
  if (task.needsToolUse) score += 0.15;
  if (task.needsLongContext) score += 0.15;
  if (task.promptTokens >= HEAVY_PROMPT_TOKENS) score += 0.2;
  else if (task.promptTokens >= HEAVY_PROMPT_TOKENS / 2) score += 0.1;
  score += task.qualityNeed * 0.25;
  return Math.min(1, score);
}

/** Khoa task de ghi nho lua chon (kind + preference + bucket prompt). */
export function taskKeyFor(task: PickerTask): string {
  const bucket = task.promptTokens >= HEAVY_PROMPT_TOKENS ? 'long' : task.promptTokens >= 2000 ? 'medium' : 'short';
  return `${task.kind}:${task.preference ?? 'balanced'}:${bucket}`;
}

/** Chuan hoa: gia tri nho hon tot hon (cost, latency) ve 0..1. */
export function normalizeLowerBetter(value: number, min: number, max: number): number {
  if (max <= min) return 1;
  return Math.min(1, Math.max(0, 1 - (value - min) / (max - min)));
}

/** Chuan hoa: gia tri lon hon tot hon (quality) ve 0..1. */
export function normalizeHigherBetter(value: number, min: number, max: number): number {
  if (max <= min) return 1;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Giai thich ngan gon vi sao ung vien nay duoc diem nhu vay. */
export function explainCandidate(
  candidate: PickerCandidate,
  breakdown: { costScore: number; latencyScore: number; qualityScore: number },
  task: PickerTask,
): string {
  const parts: string[] = [];
  if (candidate.source === 'local') {
    parts.push(`Local (${candidate.paramsB ? `${candidate.paramsB}B` : 'model tren may'}) — mien phi, khong gui du lieu ra ngoai`);
  } else if (candidate.source === 'cli') {
    parts.push(`Qua ${candidate.cliKind ?? 'CLI agent'} (dung login san tren may)`);
  } else {
    parts.push('Cloud (model manh, tinh phi theo token)');
  }
  if (candidate.estLatencyMs <= 300) parts.push('phan hoi rat nhanh');
  else if (candidate.estLatencyMs >= 1500) parts.push('can thoi gian khoi dong / goi mang');
  if (candidate.costPer1kTokensUsd <= 0.0002) parts.push('chi phi gan nhu bang 0');
  if (candidate.quality >= 0.95) parts.push('chat luong cao nhat');
  else if (candidate.quality <= 0.7) parts.push('chat luong vua du cho task don gian');
  if (task.needsLongContext && candidate.quality >= 0.9) parts.push('phu hop context dai');
  if (breakdown.costScore >= 0.9 && breakdown.qualityScore < 0.6) parts.push('re nhat trong danh sach');
  return parts.join('; ') + '.';
}

/**
 * UserChoiceMemory — ghi nho lua chon tay cua user theo dang task.
 * Luu in-memory; `toJSON`/`fromJSON` de host persist xuong disk.
 * Chi ghi modelId + so lan chon — khong ghi noi dung task / prompt.
 */
export class UserChoiceMemory {
  private readonly choices = new Map<string, RememberedChoice>();

  /** Ghi mot lan user chon model cho task nay. */
  recordChoice(task: PickerTask, modelId: string, source: PickerCandidate['source']): RememberedChoice {
    const key = taskKeyFor(task);
    const existing = this.choices.get(key);
    const updated: RememberedChoice = existing
      ? { ...existing, modelId, source, timesChosen: existing.timesChosen + 1, lastChosenAt: Date.now() }
      : { taskKey: key, modelId, source, timesChosen: 1, lastChosenAt: Date.now() };
    // User doi y -> reset dem (lua chon moi la lua chon hien tai).
    if (existing && existing.modelId !== modelId) {
      updated.timesChosen = 1;
    }
    this.choices.set(key, updated);
    return { ...updated };
  }

  /** Lua chon da nho cho task nay (neu co). */
  rememberedFor(task: PickerTask): RememberedChoice | undefined {
    const found = this.choices.get(taskKeyFor(task));
    return found ? { ...found } : undefined;
  }

  /** Diem boost (0..MEMORY_BOOST_MAX) cho model da duoc user chon truoc. */
  boostFor(task: PickerTask, modelId: string): number {
    const remembered = this.choices.get(taskKeyFor(task));
    if (!remembered || remembered.modelId !== modelId) return 0;
    const ratio = Math.min(1, remembered.timesChosen / MEMORY_BOOST_FULL_AFTER);
    return MEMORY_BOOST_MAX * ratio;
  }

  list(): RememberedChoice[] {
    return [...this.choices.values()].map((c) => ({ ...c }));
  }

  /** Xoa lua chon da nho cho mot dang task (user doi y / reset). */
  forget(taskKey: string): boolean {
    return this.choices.delete(taskKey);
  }

  clear(): void {
    this.choices.clear();
  }

  toJSON(): RememberedChoice[] {
    return this.list();
  }

  static fromJSON(choices: RememberedChoice[]): UserChoiceMemory {
    const memory = new UserChoiceMemory();
    for (const choice of choices) {
      if (choice.taskKey && choice.modelId) memory.choices.set(choice.taskKey, { ...choice });
    }
    return memory;
  }
}

/**
 * PickerV2 — cham diem + goi y model cho mot task.
 * Thuan: khong goi model that, chi tinh tren candidate caller cung cap.
 */
export class PickerV2 {
  private readonly memory: UserChoiceMemory;

  constructor(memory?: UserChoiceMemory) {
    this.memory = memory ?? new UserChoiceMemory();
  }

  getMemory(): UserChoiceMemory {
    return this.memory;
  }

  /** Cham diem tat ca ung vien kha dung, tra theo thu tu diem giam dan. */
  scoreCandidates(task: PickerTask, candidates: PickerCandidate[]): ScoredPickerCandidate[] {
    const preference = task.preference ?? 'balanced';
    const weights = PICKER_WEIGHTS[preference];
    let available = candidates.filter((c) => c.available && !c.excludedReason);
    // Task nang (heaviness >= 0.7) can chat luong toi thieu: loai model
    // yeu (quality < 0.8) tru khi khong con ung vien nao khac — tranh
    // truong hop model 4B re nhat thang ca task code nang.
    if (taskHeavinessV2(task) >= 0.7) {
      const strong = available.filter((c) => c.quality >= 0.8);
      if (strong.length > 0) available = strong;
    }
    // Task nhe (heaviness <= 0.3): uu tien local (nhanh, re, du lieu
    // o tren may) khi co model local kha dung — CLI/cloud manh hon
    // nhung cham hon, khong dang cho task don gian.
    if (taskHeavinessV2(task) <= 0.3) {
      const local = available.filter((c) => c.source === 'local');
      if (local.length > 0) available = local;
    }
    if (available.length === 0) return [];
    const costs = available.map((c) => c.costPer1kTokensUsd);
    const latencies = available.map((c) => c.estLatencyMs);
    const qualities = available.map((c) => c.quality);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const minQuality = Math.min(...qualities);
    const maxQuality = Math.max(...qualities);
    const scored: ScoredPickerCandidate[] = available.map((candidate) => {
      const costScore = normalizeLowerBetter(candidate.costPer1kTokensUsd, minCost, maxCost);
      const latencyScore = normalizeLowerBetter(candidate.estLatencyMs, minLatency, maxLatency);
      const qualityScore = normalizeHigherBetter(candidate.quality, minQuality, maxQuality);
      const boost = this.memory.boostFor(task, candidate.modelId);
      const score =
        weights.cost * costScore + weights.latency * latencyScore + weights.quality * qualityScore + boost;
      const breakdown = { costScore, latencyScore, qualityScore };
      return { ...candidate, score, breakdown, explanation: explainCandidate(candidate, breakdown, task) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Goi y model tot nhat cho task.
   * - Manual override: neu model ton tai + kha dung -> chon luon.
   * - Neu khong co ung vien kha dung -> throw Error co thong diep ro
   *   (caller chuyen thanh fallback chain / loi co huong dan).
   */
  suggest(task: PickerTask, candidates: PickerCandidate[]): PickerSuggestion {
    const ranked = this.scoreCandidates(task, candidates);
    const remembered = this.memory.rememberedFor(task);
    if (task.manualModelId) {
      const manual = ranked.find((c) => c.modelId === task.manualModelId);
      if (manual) {
        return {
          task,
          best: manual,
          ranked,
          reason: `Ban da chon ${manual.modelId} — picker ton trong lua chon nay. ${manual.explanation}`,
          manualOverride: true,
          influencedByMemory: false,
          decidedAt: Date.now(),
        };
      }
      const knownButExcluded = candidates.find((c) => c.modelId === task.manualModelId);
      const reason = knownButExcluded
        ? `Model ${task.manualModelId} khong dung duoc luc nay (${knownButExcluded.excludedReason ?? 'khong kha dung'}) — picker de xuat thay the tot nhat.`
        : `Khong tim thay model ${task.manualModelId} — picker de xuat thay the tot nhat.`;
      if (ranked.length === 0) throw new Error(reason);
      return {
        task,
        best: ranked[0],
        ranked,
        reason,
        manualOverride: false,
        influencedByMemory: false,
        decidedAt: Date.now(),
      };
    }
    if (ranked.length === 0) {
      throw new Error('Khong co model nao kha dung cho task nay (kiem tra model local / CLI agent / provider cloud).');
    }
    const best = ranked[0];
    const heaviness = taskHeavinessV2(task);
    const influencedByMemory = remembered !== undefined && remembered.modelId === best.modelId;
    const reasonParts: string[] = [];
    if (heaviness >= 0.7) {
      reasonParts.push('Task nang (code/reasoning/prompt dai) nen uu tien model manh');
    } else if (heaviness <= 0.3) {
      reasonParts.push('Task nhe nen uu tien model nho, nhanh, re');
    } else {
      reasonParts.push('Task vua nen can bang cost/latency/quality');
    }
    if (influencedByMemory) {
      reasonParts.push(`ban da chon ${best.modelId} ${remembered.timesChosen} lan cho dang task nay truoc day`);
    }
    if (best.source === 'local') reasonParts.push('chay local, khong ton phi, du lieu o tren may');
    return {
      task,
      best,
      ranked,
      reason: `${reasonParts.join('; ')}. ${best.explanation}`,
      manualOverride: false,
      influencedByMemory,
      decidedAt: Date.now(),
    };
  }

  /** Ghi nho lua chon tay cua user (goi khi user chon model thu cong). */
  rememberUserChoice(task: PickerTask, modelId: string, source: PickerCandidate['source']): RememberedChoice {
    return this.memory.recordChoice(task, modelId, source);
  }
}

/**
 * Candidate mac dinh cho picker (de host dung khi chua co du lieu that):
 * local 3–4B, CLI agent, cloud. Host nen thay bang du lieu that tu
 * registry / probe / gia cau hinh.
 */
export function defaultPickerCandidates(): PickerCandidate[] {
  return [
    { modelId: 'qwen3-4b', source: 'local', costPer1kTokensUsd: 0.0001, estLatencyMs: 150, quality: 0.72, available: true, paramsB: 4 },
    { modelId: 'qwen3-1p7b', source: 'local', costPer1kTokensUsd: 0.0001, estLatencyMs: 90, quality: 0.6, available: true, paramsB: 1.7 },
    { modelId: 'qwen2p5-coder-7b', source: 'local', costPer1kTokensUsd: 0.0001, estLatencyMs: 250, quality: 0.78, available: true, paramsB: 7 },
    { modelId: 'cli:claude:sonnet', source: 'cli', cliKind: 'claude', costPer1kTokensUsd: 0.0001, estLatencyMs: 800, quality: 0.95, available: true },
    { modelId: 'cli:codex:gpt-5', source: 'cli', cliKind: 'codex', costPer1kTokensUsd: 0.0001, estLatencyMs: 900, quality: 0.96, available: true },
    { modelId: 'gemini-2.5-flash', source: 'cloud', costPer1kTokensUsd: 0.0003, estLatencyMs: 600, quality: 0.85, available: true },
    { modelId: 'claude-sonnet-4.5', source: 'cloud', costPer1kTokensUsd: 0.003, estLatencyMs: 1100, quality: 0.96, available: true },
    { modelId: 'grok-4.7', source: 'cloud', costPer1kTokensUsd: 0.003, estLatencyMs: 900, quality: 0.97, available: true },
  ];
}
