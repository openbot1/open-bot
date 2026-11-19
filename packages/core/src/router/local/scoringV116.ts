/**
 * Multi-criteria scoring v116 (v1.39, Doi T3) — tiep noi PolicyRouter
 * v115 (router/local/policy.ts), khong thay doi API cu.
 *
 * V115 da co scoring cost/latency/quality voi mot bo trong so co dinh
 * + 2 nhanh dac biet (task nang -> cloud, task nhe -> local). V116 them:
 *
 * 1) Profile cau hinh duoc: `balanced` (mac dinh, giong V115),
 *    `cost-first`, `latency-first`, `quality-first`, `privacy-first`
 *    (local-only, tru khi khong co local nao du kha nang) va `custom`
 *    (trong so do host truyen vao). Moi profile co them trong so
 *    rieng theo task kind (vd code uu tien quality hon chat).
 * 2) Ly do chon day du: moi ung vien nhan mot danh sach `reasons`
 *    (dong giai thich ngan, tieng Viet, de UI/log hien thi); ung vien
 *    bi loai co ly do loai cu the (het RAM / khong tool-use / chat
 *    luong thap hon muc toi thieu...). Quyet dinh tra ve `decisionLog`
 *    ghi lai toan bo bang xep hang — host co the luu lai de audit
 *    vi sao model A thang model B.
 * 3) Nguong chat luong toi thieu (`minQuality`): ung vien duoi nguong
 *    bi loai co ly do, thay vi chi bi tru diem — de task quan trong
 *    khong roi vao model yeu chi vi re.
 * 4) `DecisionLogStore`: ring buffer luu N quyet dinh gan nhat
 *    (serialize duoc, de host ghi xuong disk / hien thi lich su).
 *
 * Toan bo la tinh toan thuan tren candidate do caller cung cap —
 * khong goi model that, khong goi mang.
 */

import {
  buildCloudCandidates,
  buildLocalCandidates,
  DEFAULT_CLOUD_PRICES,
  PolicyRouter,
  scoreCandidate,
  taskHeaviness,
} from './policy';
import {
  DEFAULT_POLICY_CONFIG,
  type PolicyRouterConfig,
  type RouteCandidate,
  type RouterTask,
  type RouterWeights,
  type ScoredCandidate,
} from './types';

/** Id cua mot scoring profile co san. */
export type RoutingProfileId =
  | 'balanced'
  | 'cost-first'
  | 'latency-first'
  | 'quality-first'
  | 'privacy-first'
  | 'custom';

/** Mo ta mot profile: trong so + mo ta + hanh vi dac biet. */
export interface RoutingProfile {
  id: RoutingProfileId;
  /** Ten hien thi (i18n o UI, day chi la nhan goc tieng Viet). */
  label: string;
  description: string;
  weights: RouterWeights;
  /**
   * Trong so rieng theo task kind (ghi de mot phan weights khi task
   * thuoc kind do). Vd code: quality +0.15, cost -0.15.
   */
  kindOverrides?: Partial<Record<RouterTask['kind'], Partial<RouterWeights>>>;
  /**
   * true = chi xet ung vien local; cloud chi duoc dung khi khong co
   * local nao du kha nang (privacy-first).
   */
  localOnly?: boolean;
  /** Chat luong toi thieu (0..1): ung vien duoi nguong bi loai. 0 = khong ap dung. */
  minQuality?: number;
}

/** Cac profile co san (trong so tong luon = 1). */
export const ROUTING_PROFILES: Record<Exclude<RoutingProfileId, 'custom'>, RoutingProfile> = {
  balanced: {
    id: 'balanced',
    label: 'Cân bằng',
    description: 'Cost 40%, latency 30%, quality 30% — giong V115.',
    weights: { cost: 0.4, latency: 0.3, quality: 0.3 },
    kindOverrides: {
      code: { quality: 0.45, cost: 0.25, latency: 0.3 },
      reasoning: { quality: 0.5, cost: 0.2, latency: 0.3 },
      research: { quality: 0.45, cost: 0.25, latency: 0.3 },
      'simple-chat': { latency: 0.4, cost: 0.4, quality: 0.2 },
    },
  },
  'cost-first': {
    id: 'cost-first',
    label: 'Tiết kiệm chi phí',
    description: 'Cost 70%, latency 15%, quality 15% — uu tien local re nhat.',
    weights: { cost: 0.7, latency: 0.15, quality: 0.15 },
    kindOverrides: {
      code: { quality: 0.3, cost: 0.55, latency: 0.15 },
      reasoning: { quality: 0.3, cost: 0.55, latency: 0.15 },
    },
  },
  'latency-first': {
    id: 'latency-first',
    label: 'Nhanh nhất',
    description: 'Latency 60%, cost 20%, quality 20% — uu tien token dau tien som nhat.',
    weights: { cost: 0.2, latency: 0.6, quality: 0.2 },
    kindOverrides: {
      'simple-chat': { latency: 0.7, cost: 0.15, quality: 0.15 },
    },
  },
  'quality-first': {
    id: 'quality-first',
    label: 'Chất lượng cao nhất',
    description: 'Quality 60%, cost 15%, latency 25% — uu tien model manh nhat.',
    weights: { cost: 0.15, latency: 0.25, quality: 0.6 },
    minQuality: 0.8,
    kindOverrides: {
      code: { quality: 0.65, cost: 0.1, latency: 0.25 },
      reasoning: { quality: 0.7, cost: 0.1, latency: 0.2 },
    },
  },
  'privacy-first': {
    id: 'privacy-first',
    label: 'Riêng tư (chỉ local)',
    description: 'Chi dung model local — du lieu khong roi khoi may. Cloud chi khi khong co local nao du kha nang.',
    weights: { cost: 0.3, latency: 0.35, quality: 0.35 },
    localOnly: true,
    kindOverrides: {
      'simple-chat': { latency: 0.45, cost: 0.3, quality: 0.25 },
    },
  },
};

/** Profile mac dinh. */
export const DEFAULT_ROUTING_PROFILE_ID: RoutingProfileId = 'balanced';

/** Lay profile theo id (custom thi dung weights truyen vao). */
export function getRoutingProfile(
  id: RoutingProfileId,
  customWeights?: RouterWeights,
): RoutingProfile {
  if (id === 'custom') {
    const weights = normalizeWeights(customWeights ?? { cost: 0.4, latency: 0.3, quality: 0.3 });
    return {
      id: 'custom',
      label: 'Tuỳ chỉnh',
      description: `Trong so tu chon: cost ${weights.cost}, latency ${weights.latency}, quality ${weights.quality}.`,
      weights,
    };
  }
  return ROUTING_PROFILES[id];
}

/** Chuan hoa trong so ve tong = 1 (phong thu: so am -> 0, tong 0 -> deu nhau). */
export function normalizeWeights(weights: RouterWeights): RouterWeights {
  const cost = Math.max(0, weights.cost);
  const latency = Math.max(0, weights.latency);
  const quality = Math.max(0, weights.quality);
  const total = cost + latency + quality;
  if (total <= 0) return { cost: 1 / 3, latency: 1 / 3, quality: 1 / 3 };
  return { cost: cost / total, latency: latency / total, quality: quality / total };
}

/** Trong so thuc te cho mot task: profile + override theo kind (roi chuan hoa lai). */
export function weightsForTask(profile: RoutingProfile, task: RouterTask): RouterWeights {
  const override = profile.kindOverrides?.[task.kind];
  if (!override) return normalizeWeights(profile.weights);
  return normalizeWeights({
    cost: override.cost ?? profile.weights.cost,
    latency: override.latency ?? profile.weights.latency,
    quality: override.quality ?? profile.weights.quality,
  });
}

/** Ung vien da score kem ly do (mo rong ScoredCandidate cua V115). */
export interface ExplainedCandidate extends ScoredCandidate {
  /** Cac dong ly do (ngan, de UI hien thi). */
  reasons: string[];
  /** true = bi loai khoi xet duyet (ly do o reasons[0]). */
  excluded: boolean;
}

/** Mot quyet dinh route day du, kem bang xep hang de audit. */
export interface RoutingDecisionLog {
  id: string;
  decidedAt: number;
  task: RouterTask;
  profileId: RoutingProfileId;
  weights: RouterWeights;
  heaviness: number;
  /** Tat ca ung vien, da sap xep giam dan theo score (ke ca bi loai, score = 0). */
  ranked: ExplainedCandidate[];
  chosen: ExplainedCandidate | null;
  fallbacks: ExplainedCandidate[];
  reason: string;
  manualOverride: boolean;
}

/** Bo dem id quyet dinh (don gian, tang dan trong process). */
let decisionCounter = 0;

/** Giai thich ngan cho mot ung vien duoc score (khong bi loai). */
function explainScored(candidate: ScoredCandidate): string[] {
  const out: string[] = [];
  out.push(
    `score ${candidate.score.toFixed(2)} (cost ${candidate.breakdown.costScore.toFixed(2)}, ` +
      `latency ${candidate.breakdown.latencyScore.toFixed(2)}, quality ${candidate.breakdown.qualityScore.toFixed(2)})`,
  );
  if (candidate.kind === 'local') {
    out.push(
      `local — $${candidate.costPer1kTokensUsd}/1k token, ~${candidate.estLatencyMs} ms den token dau, quality ${candidate.quality.toFixed(2)}`,
    );
  } else {
    out.push(
      `cloud — $${candidate.costPer1kTokensUsd}/1k token, ~${candidate.estLatencyMs} ms den token dau, quality ${candidate.quality.toFixed(2)}`,
    );
  }
  return out;
}

/**
 * Xep hang ung vien theo profile: score + ly do tung ung vien.
 * Ung vien bi loai (excludedReason cua V115, minQuality, localOnly)
 * van co mat trong bang voi score 0 va ly do loai ro rang.
 */
export function rankCandidatesV116(
  candidates: RouteCandidate[],
  task: RouterTask,
  profile: RoutingProfile,
  config: PolicyRouterConfig = DEFAULT_POLICY_CONFIG,
): ExplainedCandidate[] {
  const weights = weightsForTask(profile, task);
  const minQuality = profile.minQuality ?? 0;
  const eligible: RouteCandidate[] = [];
  const explained: ExplainedCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.excludedReason) {
      explained.push({
        ...candidate,
        score: 0,
        breakdown: { costScore: 0, latencyScore: 0, qualityScore: candidate.quality },
        reasons: [`Loai: ${candidate.excludedReason}`],
        excluded: true,
      });
      continue;
    }
    if (profile.localOnly && candidate.kind === 'cloud') {
      explained.push({
        ...candidate,
        score: 0,
        breakdown: { costScore: 0, latencyScore: 0, qualityScore: candidate.quality },
        reasons: ['Loai: profile privacy-first chi dung model local'],
        excluded: true,
      });
      continue;
    }
    if (minQuality > 0 && candidate.quality < minQuality) {
      explained.push({
        ...candidate,
        score: 0,
        breakdown: { costScore: 0, latencyScore: 0, qualityScore: candidate.quality },
        reasons: [`Loai: quality ${candidate.quality.toFixed(2)} duoi nguong toi thieu ${minQuality}`],
        excluded: true,
      });
      continue;
    }
    eligible.push(candidate);
  }

  const ranges = {
    maxCost: Math.max(0, ...eligible.map((c) => c.costPer1kTokensUsd)),
    maxLatency: Math.max(0, ...eligible.map((c) => c.estLatencyMs)),
  };
  const scored = eligible
    .map((c) => scoreCandidate(c, weights, ranges))
    .sort((a, b) => b.score - a.score);
  for (const s of scored) {
    explained.push({ ...s, reasons: explainScored(s), excluded: false });
  }
  // Sap xep: ung vien duoc xet truoc (theo score), ung vien bi loai sau.
  explained.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    return b.score - a.score;
  });
  return explained;
}

/** Ly do vi sao ung vien thang: so sanh voi doi thu xep ngay sau. */
export function winnerReason(ranked: ExplainedCandidate[]): string {
  const winner = ranked.find((c) => !c.excluded);
  if (!winner) return 'Khong co ung vien nao du kha nang.';
  const runnerUp = ranked.find((c) => !c.excluded && c.modelId !== winner.modelId);
  if (!runnerUp) {
    return `"${winner.modelId}" la ung vien duy nhat du kha nang (score ${winner.score.toFixed(2)}).`;
  }
  const parts: string[] = [`"${winner.modelId}" thang "${runnerUp.modelId}" (${winner.score.toFixed(2)} vs ${runnerUp.score.toFixed(2)})`];
  const w = winner.breakdown;
  const r = runnerUp.breakdown;
  if (w.costScore > r.costScore + 0.05) parts.push('re hon');
  if (w.latencyScore > r.latencyScore + 0.05) parts.push('nhanh hon');
  if (w.qualityScore > r.qualityScore + 0.05) parts.push('chat luong cao hon');
  if (parts.length === 1) parts.push('tong diem cao hon');
  return `${parts.join(', ')}.`;
}

/**
 * ScoringPolicyV116 — bo them tren PolicyRouter V115.
 *
 * - `decide()` dung lai PolicyRouter goc de giu hanh vi nhanh dac biet
 *   (task nang -> cloud, task nhe -> local), nhung bo sung bang xep
 *   hang day du + log ly do theo profile da chon.
 * - `rankOnly()` chi xep hang (khong ap dung nhanh dac biet) — de UI
 *   hien thi "neu chi tinh diem thi model nao thang".
 * - Profile co the doi luc chay (`setProfile`); moi quyet dinh duoc
 *   ghi vao DecisionLogStore.
 */
export class ScoringPolicyV116 {
  private readonly base: PolicyRouter;
  private readonly config: PolicyRouterConfig;
  private profile: RoutingProfile;
  private readonly logStore: DecisionLogStore;

  constructor(
    base?: PolicyRouter,
    config?: Partial<PolicyRouterConfig>,
    profileId: RoutingProfileId = DEFAULT_ROUTING_PROFILE_ID,
    customWeights?: RouterWeights,
    logCapacity = 100,
  ) {
    this.config = {
      ...DEFAULT_POLICY_CONFIG,
      ...config,
      weights: { ...DEFAULT_POLICY_CONFIG.weights, ...(config?.weights ?? {}) },
    };
    this.base = base ?? new PolicyRouter(config, undefined);
    this.profile = getRoutingProfile(profileId, customWeights);
    this.logStore = new DecisionLogStore(logCapacity);
  }

  getProfile(): RoutingProfile {
    return { ...this.profile, weights: { ...this.profile.weights } };
  }

  setProfile(id: RoutingProfileId, customWeights?: RouterWeights): RoutingProfile {
    this.profile = getRoutingProfile(id, customWeights);
    return this.getProfile();
  }

  getConfig(): PolicyRouterConfig {
    return { ...this.config, weights: { ...this.config.weights } };
  }

  getLogStore(): DecisionLogStore {
    return this.logStore;
  }

  /** Build toan bo ung vien local + cloud cho mot task (dung lai ham V115). */
  buildCandidates(
    task: RouterTask,
    env: { loadedModelIds: ReadonlySet<string>; availableRamBytes: number },
    cloudPrices: Record<string, { inputUsdPer1k: number; quality: number; estLatencyMs: number }> = DEFAULT_CLOUD_PRICES,
  ): RouteCandidate[] {
    return [
      ...buildLocalCandidates(task, env.loadedModelIds, env.availableRamBytes, this.config),
      ...buildCloudCandidates(cloudPrices),
    ];
  }

  /**
   * Chi xep hang ung vien theo profile (khong ap nhanh dac biet).
   * Tra ve bang day du + log (khong ghi vao store — chi `decide()` ghi).
   * `profileOverride` cho phep xep hang theo profile khac ma khong
   * doi profile hien hanh cua policy.
   */
  rankOnly(
    task: RouterTask,
    env: { loadedModelIds: ReadonlySet<string>; availableRamBytes: number },
    candidates?: RouteCandidate[],
    profileOverride?: RoutingProfile,
  ): RoutingDecisionLog {
    const profile = profileOverride ?? this.profile;
    const all = candidates ?? this.buildCandidates(task, env);
    const ranked = rankCandidatesV116(all, task, profile, this.config);
    const usable = ranked.filter((c) => !c.excluded);
    const chosen = usable[0] ?? null;
    const fallbacks = usable.slice(1, 3);
    return {
      id: `route-${++decisionCounter}`,
      decidedAt: Date.now(),
      task: { ...task },
      profileId: profile.id,
      weights: weightsForTask(profile, task),
      heaviness: taskHeaviness(task, this.config),
      ranked,
      chosen,
      fallbacks,
      reason: winnerReason(ranked),
      manualOverride: false,
    };
  }

  /**
   * Quyet dinh route day du: dung PolicyRouter V115 de chon (giu
   * hanh vi nhanh dac biet + manual override), kem bang xep hang V116
   * theo profile de giai thich. Log duoc ghi vao store.
   * `profileOverride` cho phep quyet dinh theo profile khac ma khong
   * doi profile hien hanh cua policy.
   */
  decide(
    task: RouterTask,
    env: { loadedModelIds: ReadonlySet<string>; availableRamBytes: number },
    profileOverride?: RoutingProfile,
    candidatesOverride?: RouteCandidate[],
  ): RoutingDecisionLog {
    const profile = profileOverride ?? this.profile;
    const all = candidatesOverride ?? this.buildCandidates(task, env);
    const ranked = rankCandidatesV116(all, task, profile, this.config);
    const baseDecision = this.base.decide(task, env);

    // Tim ung vien thang theo V115 trong bang V116 (de lay reasons day du).
    const baseChosen = ranked.find((c) => c.modelId === baseDecision.chosen.modelId && !c.excluded)
      ?? ranked.find((c) => !c.excluded)
      ?? null;
    // CLI source (chi co khi caller truyen candidatesOverride, vd tool
    // includeCliSources): neu ung vien dung dau bang V116 la model CLI
    // va diem cao hon lua chon V115 thi chon no — model chay qua
    // login san cua user tren may, khong ton phi API. Khong co
    // candidatesOverride thi khong co model CLI nao trong bang nen
    // nhanh nay khong bao gio kich hoat.
    let chosen = baseChosen;
    const topRanked = ranked.find((c) => !c.excluded);
    if (topRanked && topRanked.modelId.startsWith('cli:') && (!chosen || topRanked.score > chosen.score)) {
      chosen = topRanked;
    }
    const fallbacks = (baseDecision.fallbacks
      .map((f) => ranked.find((c) => c.modelId === f.modelId && !c.excluded))
      .filter((c): c is ExplainedCandidate => !!c)
      .slice(0, 3));
    // Neu V115 chon model ma V116 loai (vd privacy-first loai cloud):
    // ton trong profile — chon ung vien dung dau bang V116.
    let reason = chosen
      ? `${baseDecision.reason} [${profile.label}] ${winnerReason(ranked)}`
      : 'Khong co ung vien nao du kha nang theo profile hien tai.';
    // Override bi profile loai (vd user chi cloud nhung dang
    // privacy-first): noi ro, khong de reason cu noi "override" trong
    // khi model thang khong phai model override.
    if (
      task.manualModelId &&
      baseDecision.manualOverride &&
      chosen?.modelId !== task.manualModelId
    ) {
      reason += ` Override "${task.manualModelId}" khong ap dung duoc theo profile ${profile.id} — chon "${chosen?.modelId ?? 'khong co'}" thay the.`;
    }
    const log: RoutingDecisionLog = {
      id: `route-${++decisionCounter}`,
      decidedAt: Date.now(),
      task: { ...task },
      profileId: profile.id,
      weights: weightsForTask(profile, task),
      heaviness: taskHeaviness(task, this.config),
      ranked,
      chosen,
      fallbacks,
      reason,
      manualOverride: baseDecision.manualOverride,
    };
    this.logStore.add(log);
    return log;
  }
}

/** Ring buffer luu N quyet dinh route gan nhat (de audit / hien thi lich su). */
export class DecisionLogStore {
  private readonly capacity: number;
  private readonly entries: RoutingDecisionLog[] = [];

  constructor(capacity = 100) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  add(log: RoutingDecisionLog): void {
    this.entries.push(log);
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  list(): RoutingDecisionLog[] {
    return [...this.entries];
  }

  get(id: string): RoutingDecisionLog | undefined {
    return this.entries.find((e) => e.id === id);
  }

  last(): RoutingDecisionLog | undefined {
    return this.entries[this.entries.length - 1];
  }

  clear(): void {
    this.entries.length = 0;
  }

  size(): number {
    return this.entries.length;
  }

  serialize(): RoutingDecisionLog[] {
    return this.list();
  }

  static deserialize(logs: RoutingDecisionLog[], capacity = 100): DecisionLogStore {
    const store = new DecisionLogStore(capacity);
    for (const log of logs.slice(-capacity)) store.add(log);
    return store;
  }
}

/** Ghi chu: `localLatencyMs`, `localQualityOf`, `taskHeaviness` va
 * `LocalModelEntry` da duoc export tu policy.ts / localCatalog —
 * khong re-export o day de tranh xung dot `export *` o core index. */
