/**
 * Mid-conversation RouterLLM (v1.40, Doi T3) — y tuong tu OpenHands V1 SDK
 * RouterLLM (chi hoc y tuong, khong copy code/text cua repo nao).
 *
 * Router chon model DONG giua cuoc tro chuyen, theo noi dung tung message:
 * - Leo thang len model manh / da phuong thuc chi khi gap anh hoac code
 *   kho / suy luan nang; ha cap xuong model re/nhe khi noi dung de.
 * - Router long duoc: mot router node co the tro toi router khac, thanh
 *   cay quyet dinh (resolve theo predicate tung nhanh).
 * - Moi quyet dinh deu ghi log ly do (difficulty, signal, nguong, duong
 *   di trong cay) de audit vi sao model A duoc chon thay vi model B.
 * - Cooldown chong flip-flop: sau khi leo thang, khong ha cap ngay ma
 *   phai doi `minTurnsAfterEscalate` message.
 *
 * Thuan logic (khong goi model that, khong doc credential). Host truyen
 * candidate/policy rieng; mac dinh dung id model trong local catalog
 * (qwen3-0.6b nhe / qwen3-4b chuan / qwen3-32b manh / gemma-3-12b da
 * phuong thuc).
 */

export type MidChatTier = 'light' | 'standard' | 'strong' | 'multimodal';

export interface MidChatCandidate {
  modelId: string;
  tier: MidChatTier;
  /** USD / 1k token (uoc tinh, de giai thich chi phi). */
  costPer1kTokensUsd: number;
  /** Chat luong uoc tinh 0..1. */
  quality: number;
  multimodal: boolean;
  maxContextTokens: number;
  label?: string;
}

export interface MidChatDifficultyContribution {
  signal: string;
  points: number;
  detail: string;
}

export interface MidChatSignals {
  hasImage: boolean;
  hasCodeBlock: boolean;
  /** So dong code trong cac code block (0 neu khong co). */
  codeLines: number;
  codeLanguage?: string;
  /** Do kho 0..1 (da clamp). */
  difficulty: number;
  lengthChars: number;
  reasoningHits: string[];
  multiStep: boolean;
  questionCount: number;
  isShortChat: boolean;
  contributions: MidChatDifficultyContribution[];
}

export interface MidChatPolicy {
  /** difficulty >= nguong nay thi leo thang (mac dinh 0.65). */
  escalateThreshold: number;
  /** difficulty <= nguong nay thi ha cap (mac dinh 0.30). */
  deescalateThreshold: number;
  defaultModelId: string;
  lightModelId: string;
  strongModelId: string;
  multimodalModelId: string;
  /** So message toi thieu sau leo thang moi duoc ha cap (mac dinh 2). */
  minTurnsAfterEscalate: number;
  candidates: MidChatCandidate[];
}

export type MidChatRouteDirection = 'escalate' | 'deescalate' | 'stay';

export interface MidChatDecision {
  id: string;
  decidedAt: number;
  messageExcerpt: string;
  signals: MidChatSignals;
  difficulty: number;
  direction: MidChatRouteDirection;
  previousModelId: string;
  chosenModelId: string;
  reasons: string[];
  /** Duong di qua cay router (rong neu dung policy phang theo nguong). */
  nodePath: string[];
  policy: { escalateThreshold: number; deescalateThreshold: number };
}

/** Predicate mot nhanh trong cay router. Tat ca dieu kien deu phai dung. */
export interface MidChatPredicate {
  hasImage?: boolean;
  hasCode?: boolean;
  minDifficulty?: number;
  maxDifficulty?: number;
  tier?: MidChatTier;
}

export interface MidChatBranch {
  predicate: MidChatPredicate;
  node: MidChatRouterNode;
}

export type MidChatRouterNode =
  | { kind: 'model'; modelId: string }
  | {
      kind: 'router';
      id: string;
      label?: string;
      branches: MidChatBranch[];
      fallback: MidChatRouterNode;
    };

export const MID_CHAT_TIER_RANK: Record<MidChatTier, number> = {
  light: 0,
  standard: 1,
  strong: 2,
  multimodal: 2,
};

export const MAX_ROUTER_TREE_DEPTH = 8;

const REASONING_KEYWORDS: readonly string[] = [
  'prove', 'proof', 'derive', 'debug', 'optimize', 'optimise', 'algorithm',
  'complexity', 'architecture', 'refactor', 'trade-off', 'tradeoff',
  'compare', 'evaluate', 'implement', 'step by step', 'multi-step',
  'multi step', 'stack trace', 'traceback', 'segfault', 'deadlock',
  'race condition', 'design pattern', 'benchmark', 'why does', 'how does',
  'explain why', 'root cause',
];

const HARD_CODE_LANGUAGES: readonly string[] = [
  'rust', 'c++', 'cpp', 'c', 'haskell', 'scala', 'zig', 'go', 'assembly', 'asm',
];

const MULTI_STEP_MARKERS: readonly RegExp[] = [
  /(^|\n)\s*1[.)]\s+\S/m,
  /\bfirst\b.{0,40}\bthen\b/i,
  /\bstep\s+1\b/i,
  /\bphase\s+1\b/i,
];

export function defaultMidChatCandidates(): MidChatCandidate[] {
  return [
    {
      modelId: 'qwen3-0.6b',
      tier: 'light',
      costPer1kTokensUsd: 0,
      quality: 0.45,
      multimodal: false,
      maxContextTokens: 32768,
      label: 'Light local (fast, free)',
    },
    {
      modelId: 'qwen3-4b',
      tier: 'standard',
      costPer1kTokensUsd: 0,
      quality: 0.7,
      multimodal: false,
      maxContextTokens: 32768,
      label: 'Standard local',
    },
    {
      modelId: 'qwen3-32b',
      tier: 'strong',
      costPer1kTokensUsd: 0,
      quality: 0.9,
      multimodal: false,
      maxContextTokens: 32768,
      label: 'Strong local (hard reasoning/code)',
    },
    {
      modelId: 'gemma-3-12b',
      tier: 'multimodal',
      costPer1kTokensUsd: 0,
      quality: 0.82,
      multimodal: true,
      maxContextTokens: 131072,
      label: 'Multimodal local (image + text)',
    },
  ];
}

export function defaultMidChatPolicy(): MidChatPolicy {
  return {
    escalateThreshold: 0.65,
    deescalateThreshold: 0.3,
    defaultModelId: 'qwen3-4b',
    lightModelId: 'qwen3-0.6b',
    strongModelId: 'qwen3-32b',
    multimodalModelId: 'gemma-3-12b',
    minTurnsAfterEscalate: 2,
    candidates: defaultMidChatCandidates(),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Uoc tinh so token cua mot message (khoang 4 ky tu / token). */
export function estimateMidChatTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Phan tich noi dung mot message thanh signal + do kho 0..1.
 * `hasImage` truyen rieng vi text khong the hien duoc attachment anh.
 */
export function analyzeMidChatMessage(
  content: string,
  opts: { hasImage?: boolean } = {},
): MidChatSignals {
  const text = typeof content === 'string' ? content : '';
  const lower = text.toLowerCase();
  const contributions: MidChatDifficultyContribution[] = [];
  let difficulty = 0.12;
  contributions.push({ signal: 'base', points: 0.12, detail: 'Base difficulty for any message.' });

  const hasImage = opts.hasImage === true
    || /\[image\]|\[img\]|!\[.*?\]\(.*?\)|<image>/i.test(text);
  if (hasImage) {
    difficulty += 0.3;
    contributions.push({ signal: 'image', points: 0.3, detail: 'Message contains an image — needs a multimodal model.' });
  }

  const codeBlocks = [...text.matchAll(/```(\w*)\n?([\s\S]*?)```/g)];
  const hasCodeBlock = codeBlocks.length > 0;
  let codeLines = 0;
  let codeLanguage: string | undefined;
  if (hasCodeBlock) {
    const firstLang = (codeBlocks[0]?.[1] ?? '').toLowerCase();
    if (firstLang) codeLanguage = firstLang;
    for (const block of codeBlocks) {
      const body = block[2] ?? '';
      codeLines += body.split('\n').filter((line) => line.trim().length > 0).length;
    }
    difficulty += 0.12;
    contributions.push({ signal: 'code-block', points: 0.12, detail: `${codeBlocks.length} code block(s), ${codeLines} code line(s).` });
    const codePoints = Math.min(0.18, codeLines * 0.012);
    if (codePoints > 0) {
      difficulty += codePoints;
      contributions.push({ signal: 'code-lines', points: round3(codePoints), detail: `${codeLines} code lines add difficulty.` });
    }
    if (codeLanguage && HARD_CODE_LANGUAGES.includes(codeLanguage)) {
      difficulty += 0.06;
      contributions.push({ signal: 'hard-language', points: 0.06, detail: `Hard language "${codeLanguage}".` });
    }
  }

  const reasoningHits = REASONING_KEYWORDS.filter((kw) => lower.includes(kw));
  if (reasoningHits.length > 0) {
    const points = Math.min(0.2, reasoningHits.length * 0.05);
    difficulty += points;
    contributions.push({
      signal: 'reasoning-keywords',
      points: round3(points),
      detail: `Reasoning keywords: ${reasoningHits.slice(0, 6).join(', ')}${reasoningHits.length > 6 ? ', …' : ''}.`,
    });
  }

  const multiStep = MULTI_STEP_MARKERS.some((re) => re.test(text));
  if (multiStep) {
    difficulty += 0.06;
    contributions.push({ signal: 'multi-step', points: 0.06, detail: 'Message describes multiple steps/phases.' });
  }

  const questionCount = (text.match(/\?/g) ?? []).length;
  if (questionCount >= 3) {
    difficulty += 0.04;
    contributions.push({ signal: 'many-questions', points: 0.04, detail: `${questionCount} questions in one message.` });
  }

  const lengthPoints = Math.min(0.16, Math.floor(text.length / 400) * 0.04);
  if (lengthPoints > 0) {
    difficulty += lengthPoints;
    contributions.push({ signal: 'length', points: round3(lengthPoints), detail: `${text.length} characters.` });
  }

  const isShortChat = text.trim().length < 60
    && !hasCodeBlock && !hasImage && reasoningHits.length === 0;
  if (isShortChat) {
    difficulty = Math.min(difficulty, 0.25);
    contributions.push({ signal: 'short-chat', points: 0, detail: 'Short casual message — capped at 0.25.' });
  }

  return {
    hasImage,
    hasCodeBlock,
    codeLines,
    codeLanguage,
    difficulty: round3(clamp01(difficulty)),
    lengthChars: text.length,
    reasoningHits,
    multiStep,
    questionCount,
    isShortChat,
    contributions,
  };
}

export function predicateMatches(predicate: MidChatPredicate, signals: MidChatSignals): boolean {
  if (predicate.hasImage !== undefined && predicate.hasImage !== signals.hasImage) return false;
  if (predicate.hasCode !== undefined && predicate.hasCode !== signals.hasCodeBlock) return false;
  if (predicate.minDifficulty !== undefined && signals.difficulty < predicate.minDifficulty) return false;
  if (predicate.maxDifficulty !== undefined && signals.difficulty > predicate.maxDifficulty) return false;
  return true;
}

/** Giai mot cay router: tra modelId la + duong di qua cac node id. */
export function resolveRouterNode(
  node: MidChatRouterNode,
  signals: MidChatSignals,
  path: string[] = [],
): { modelId: string; path: string[] } {
  if (node.kind === 'model') {
    return { modelId: node.modelId, path: [...path, `model:${node.modelId}`] };
  }
  const here = [...path, `router:${node.id}`];
  for (const branch of node.branches) {
    if (predicateMatches(branch.predicate, signals)) {
      return resolveRouterNode(branch.node, signals, here);
    }
  }
  return resolveRouterNode(node.fallback, signals, [...here, 'fallback']);
}

/** Kiem tra tinh hop le cua cay router; tra danh sach loi (rong = hop le). */
export function validateRouterNode(node: unknown, depth = 0): string[] {
  const errors: string[] = [];
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    errors.push('Router node phai la object.');
    return errors;
  }
  const n = node as Record<string, unknown>;
  if (depth > MAX_ROUTER_TREE_DEPTH) {
    errors.push(`Cay router vuot do sau toi da ${MAX_ROUTER_TREE_DEPTH}.`);
    return errors;
  }
  if (n.kind === 'model') {
    if (typeof n.modelId !== 'string' || n.modelId.trim() === '') {
      errors.push('Model node can modelId la string khong rong.');
    }
    return errors;
  }
  if (n.kind === 'router') {
    if (typeof n.id !== 'string' || n.id.trim() === '') {
      errors.push('Router node can id la string khong rong.');
    }
    if (!Array.isArray(n.branches) || n.branches.length === 0) {
      errors.push(`Router "${String(n.id ?? '')}" can it nhat 1 branch.`);
    } else {
      n.branches.forEach((branch, index) => {
        if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) {
          errors.push(`Branch ${index} cua router "${String(n.id ?? '')}" phai la object.`);
          return;
        }
        const b = branch as Record<string, unknown>;
        const pred = b.predicate as Record<string, unknown> | undefined;
        if (typeof pred !== 'object' || pred === null || Array.isArray(pred)) {
          errors.push(`Branch ${index} cua router "${String(n.id ?? '')}" thieu predicate.`);
        } else {
          if (pred.minDifficulty !== undefined
            && (typeof pred.minDifficulty !== 'number' || pred.minDifficulty < 0 || pred.minDifficulty > 1)) {
            errors.push(`Branch ${index}: minDifficulty phai la so 0..1.`);
          }
          if (pred.maxDifficulty !== undefined
            && (typeof pred.maxDifficulty !== 'number' || pred.maxDifficulty < 0 || pred.maxDifficulty > 1)) {
            errors.push(`Branch ${index}: maxDifficulty phai la so 0..1.`);
          }
          if (pred.minDifficulty !== undefined && pred.maxDifficulty !== undefined
            && (pred.minDifficulty as number) > (pred.maxDifficulty as number)) {
            errors.push(`Branch ${index}: minDifficulty khong duoc lon hon maxDifficulty.`);
          }
          if (pred.tier !== undefined && !['light', 'standard', 'strong', 'multimodal'].includes(String(pred.tier))) {
            errors.push(`Branch ${index}: tier khong hop le.`);
          }
        }
        errors.push(...validateRouterNode(b.node, depth + 1).map((e) => `Branch ${index}: ${e}`));
      });
    }
    if (n.fallback === undefined) {
      errors.push(`Router "${String(n.id ?? '')}" thieu fallback node.`);
    } else {
      errors.push(...validateRouterNode(n.fallback, depth + 1).map((e) => `Fallback: ${e}`));
    }
    return errors;
  }
  errors.push('Router node kind phai la "model" hoac "router".');
  return errors;
}

export class MidChatDecisionStore {
  private readonly capacity: number;
  private entries: MidChatDecision[] = [];

  constructor(capacity = 200) {
    this.capacity = Math.max(1, capacity);
  }

  add(decision: MidChatDecision): void {
    this.entries.push(decision);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  list(): MidChatDecision[] {
    return [...this.entries].reverse();
  }

  get(id: string): MidChatDecision | undefined {
    return this.entries.find((e) => e.id === id);
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

let midChatDecisionCounter = 0;

/**
 * MidChatRouter — giu policy + cay router + log quyet dinh cho mot
 * cuoc tro chuyen (moi conversation nen co mot instance rieng).
 */
export class MidChatRouter {
  private policy: MidChatPolicy;
  private tree: MidChatRouterNode | null = null;
  private readonly logStore: MidChatDecisionStore;
  /** So message ke tu lan leo thang gan nhat (de cooldown ha cap). */
  private turnsSinceEscalation = Number.POSITIVE_INFINITY;

  constructor(policy?: Partial<MidChatPolicy>, logCapacity = 200) {
    this.policy = { ...defaultMidChatPolicy(), ...(policy ?? {}) };
    this.policy.candidates = [...(policy?.candidates ?? defaultMidChatCandidates())];
    this.logStore = new MidChatDecisionStore(logCapacity);
  }

  getPolicy(): MidChatPolicy {
    return { ...this.policy, candidates: this.policy.candidates.map((c) => ({ ...c })) };
  }

  setPolicy(partial: Partial<MidChatPolicy>): MidChatPolicy {
    if (partial.escalateThreshold !== undefined) {
      if (typeof partial.escalateThreshold !== 'number'
        || partial.escalateThreshold < 0 || partial.escalateThreshold > 1) {
        throw new Error('escalateThreshold phai la so 0..1.');
      }
    }
    if (partial.deescalateThreshold !== undefined) {
      if (typeof partial.deescalateThreshold !== 'number'
        || partial.deescalateThreshold < 0 || partial.deescalateThreshold > 1) {
        throw new Error('deescalateThreshold phai la so 0..1.');
      }
    }
    const next = { ...this.policy, ...partial };
    if (next.deescalateThreshold >= next.escalateThreshold) {
      throw new Error('deescalateThreshold phai nho hon escalateThreshold (can vung "stay" o giua).');
    }
    if (partial.minTurnsAfterEscalate !== undefined
      && (!Number.isInteger(partial.minTurnsAfterEscalate) || partial.minTurnsAfterEscalate < 0)) {
      throw new Error('minTurnsAfterEscalate phai la so nguyen >= 0.');
    }
    this.policy = next;
    if (partial.candidates !== undefined) {
      this.policy.candidates = [...partial.candidates];
    }
    return this.getPolicy();
  }

  setCandidates(candidates: MidChatCandidate[]): MidChatCandidate[] {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('candidates khong duoc rong.');
    }
    this.policy.candidates = candidates.map((c) => ({ ...c }));
    return this.getPolicy().candidates;
  }

  getTree(): MidChatRouterNode | null {
    return this.tree;
  }

  setTree(node: MidChatRouterNode | null): MidChatRouterNode | null {
    if (node === null) {
      this.tree = null;
      return null;
    }
    const errors = validateRouterNode(node);
    if (errors.length > 0) throw new Error(`Cay router khong hop le: ${errors.join(' ')}`);
    this.tree = node;
    return this.tree;
  }

  getLogStore(): MidChatDecisionStore {
    return this.logStore;
  }

  getTurnsSinceEscalation(): number {
    return this.turnsSinceEscalation;
  }

  resetConversation(): void {
    this.turnsSinceEscalation = Number.POSITIVE_INFINITY;
    this.logStore.clear();
  }

  tierOf(modelId: string): MidChatTier {
    const found = this.policy.candidates.find((c) => c.modelId === modelId);
    if (found) return found.tier;
    if (modelId === this.policy.lightModelId) return 'light';
    if (modelId === this.policy.strongModelId) return 'strong';
    if (modelId === this.policy.multimodalModelId) return 'multimodal';
    return 'standard';
  }

  candidateOf(modelId: string): MidChatCandidate | undefined {
    return this.policy.candidates.find((c) => c.modelId === modelId)
      ?? this.policy.candidates.find((c) => c.modelId === this.policy.defaultModelId);
  }

  /** Message co vuot 80% context window cua model hien tai khong. */
  needsBiggerContext(content: string, currentModelId: string): boolean {
    const candidate = this.candidateOf(currentModelId);
    if (!candidate) return false;
    return estimateMidChatTokens(content) > candidate.maxContextTokens * 0.8;
  }

  /**
   * Chon model co context du lon cho message: ung vien nho nhat ma
   * context chua duoc message; neu khong co thi lay context lon nhat.
   */
  pickBiggerContextModel(content: string, currentModelId: string, hasImage: boolean): string {
    const needed = estimateMidChatTokens(content);
    const fitting = this.policy.candidates
      .filter((c) => c.maxContextTokens >= needed)
      .sort((a, b) => a.maxContextTokens - b.maxContextTokens);
    const pool = fitting.length > 0 ? fitting : [...this.policy.candidates]
      .sort((a, b) => b.maxContextTokens - a.maxContextTokens);
    if (hasImage) {
      const multimodal = pool.find((c) => c.multimodal);
      if (multimodal) return multimodal.modelId;
    }
    return (pool[0] ?? this.candidateOf(currentModelId))?.modelId ?? this.policy.defaultModelId;
  }

  /** Route mot message: tra quyet dinh day du + ghi log. */
  route(
    content: string,
    currentModelId?: string,
    opts: { hasImage?: boolean } = {},
  ): MidChatDecision {
    const signals = analyzeMidChatMessage(content, opts);
    const current = currentModelId && currentModelId.trim() !== ''
      ? currentModelId
      : this.policy.defaultModelId;
    const reasons: string[] = [];
    let chosen: string;
    let nodePath: string[] = [];

    if (this.tree) {
      const resolved = resolveRouterNode(this.tree, signals);
      chosen = resolved.modelId;
      nodePath = resolved.path;
      reasons.push(`Router tree: ${resolved.path.join(' -> ')}.`);
    } else if (signals.hasImage) {
      chosen = this.policy.multimodalModelId;
      reasons.push('Message co anh — can model da phuong thuc.');
    } else if (this.needsBiggerContext(content, current)) {
      chosen = this.pickBiggerContextModel(content, current, signals.hasImage);
      reasons.push(
        `Message uoc tinh ~${estimateMidChatTokens(content)} token, vuot 80% context cua ${current} — leo len model context lon hon.`,
      );
    } else if (signals.difficulty >= this.policy.escalateThreshold) {
      chosen = this.policy.strongModelId;
      reasons.push(
        `Do kho ${signals.difficulty} >= nguong leo ${this.policy.escalateThreshold} — can model manh.`,
      );
    } else if (signals.difficulty <= this.policy.deescalateThreshold) {
      if (this.turnsSinceEscalation < this.policy.minTurnsAfterEscalate) {
        chosen = current;
        reasons.push(
          `Do kho ${signals.difficulty} <= nguong ha ${this.policy.deescalateThreshold} nhung moi leo thang `
          + `${this.turnsSinceEscalation} turn truoc (can toi thieu ${this.policy.minTurnsAfterEscalate}) — giu nguyen de chong flip-flop.`,
        );
      } else {
        chosen = this.policy.lightModelId;
        reasons.push(
          `Do kho ${signals.difficulty} <= nguong ha ${this.policy.deescalateThreshold} — noi dung de, dung model nhe/re.`,
        );
      }
    } else {
      chosen = current;
      reasons.push(
        `Do kho ${signals.difficulty} nam giua hai nguong (${this.policy.deescalateThreshold}..${this.policy.escalateThreshold}) — giu nguyen model.`,
      );
    }

    for (const c of signals.contributions) {
      if (c.signal !== 'base' && c.points > 0) {
        reasons.push(`${c.detail} (+${c.points}).`);
      }
    }
    if (chosen !== current && this.tierOf(chosen) === this.tierOf(current)) {
      reasons.push('Model doi nhung cung tier — xem nhu giu nguyen cap suc manh.');
    }

    const currentRank = MID_CHAT_TIER_RANK[this.tierOf(current)];
    const chosenRank = MID_CHAT_TIER_RANK[this.tierOf(chosen)];
    const direction: MidChatRouteDirection = chosenRank > currentRank
      ? 'escalate'
      : chosenRank < currentRank ? 'deescalate' : 'stay';
    if (direction === 'escalate') {
      this.turnsSinceEscalation = 0;
    } else if (Number.isFinite(this.turnsSinceEscalation)) {
      this.turnsSinceEscalation += 1;
    }

    const decision: MidChatDecision = {
      id: `midchat-${++midChatDecisionCounter}`,
      decidedAt: Date.now(),
      messageExcerpt: content.slice(0, 120),
      signals,
      difficulty: signals.difficulty,
      direction,
      previousModelId: current,
      chosenModelId: chosen,
      reasons,
      nodePath,
      policy: {
        escalateThreshold: this.policy.escalateThreshold,
        deescalateThreshold: this.policy.deescalateThreshold,
      },
    };
    this.logStore.add(decision);
    return decision;
  }
}

export interface MidChatSessionSummary {
  id: string;
  createdAt: number;
  messageCount: number;
  decisions: number;
  escalations: number;
  deescalations: number;
  stays: number;
  tokensByModel: Record<string, number>;
  currentModelId: string;
}

export interface MidChatCostReport extends MidChatSessionSummary {
  /** Token da phuc vu bang model nhe thay vi model manh (tiet kiem). */
  tokensRoutedAwayFromStrong: number;
  /** Ty le message duoc phuc vu bang model nhe/re (0..1). */
  lightShare: number;
  decisionsDetail: MidChatDecision[];
}

interface MidChatSessionEntry {
  router: MidChatRouter;
  createdAt: number;
  currentModelId: string;
}

let midChatSessionCounter = 0;

/**
 * MidChatSessionManager — mot router rieng cho moi conversation.
 *
 * Moi session giu router + model hien tai cua no, de leo/ha model theo
 * tung cuoc tro chuyen ma khong lan sang cuoc khac. Bao cao chi phi
 * cho thay bao nhieu token duoc phuc vu bang model nhe thay vi luc nao
 * cung chay model manh — bang chung RouterLLM tiet kiem duoc bao nhieu.
 */
export class MidChatSessionManager {
  private policy: MidChatPolicy;
  private readonly sessions = new Map<string, MidChatSessionEntry>();

  constructor(policy?: Partial<MidChatPolicy>) {
    this.policy = { ...defaultMidChatPolicy(), ...(policy ?? {}) };
    this.policy.candidates = [...(policy?.candidates ?? defaultMidChatCandidates())];
  }

  getPolicy(): MidChatPolicy {
    return { ...this.policy, candidates: this.policy.candidates.map((c) => ({ ...c })) };
  }

  setPolicy(partial: Partial<MidChatPolicy>): MidChatPolicy {
    const probe = new MidChatRouter(this.policy);
    const next = probe.setPolicy({ ...this.policy, ...partial });
    this.policy = next;
    for (const entry of this.sessions.values()) {
      entry.router.setPolicy(this.policy);
    }
    return this.getPolicy();
  }

  createSession(id?: string): MidChatSessionSummary {
    const sessionId = id && id.trim() !== '' ? id : `session-${++midChatSessionCounter}`;
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session "${sessionId}" da ton tai.`);
    }
    this.sessions.set(sessionId, {
      router: new MidChatRouter(this.policy),
      createdAt: Date.now(),
      currentModelId: this.policy.defaultModelId,
    });
    return this.summarize(sessionId);
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()].sort();
  }

  /** Route trong mot session (tu tao session neu chua co). */
  route(
    sessionId: string,
    content: string,
    currentModelId?: string,
    opts: { hasImage?: boolean } = {},
  ): MidChatDecision {
    if (!this.sessions.has(sessionId)) this.createSession(sessionId);
    const entry = this.sessions.get(sessionId) as MidChatSessionEntry;
    const current = currentModelId && currentModelId.trim() !== ''
      ? currentModelId
      : entry.currentModelId;
    const decision = entry.router.route(content, current, opts);
    entry.currentModelId = decision.chosenModelId;
    return decision;
  }

  getSessionRouter(sessionId: string): MidChatRouter | undefined {
    return this.sessions.get(sessionId)?.router;
  }

  private summarize(sessionId: string): MidChatSessionSummary {
    const entry = this.sessions.get(sessionId) as MidChatSessionEntry;
    const decisions = entry.router.getLogStore().list();
    const tokensByModel: Record<string, number> = {};
    let escalations = 0;
    let deescalations = 0;
    let stays = 0;
    for (const d of decisions) {
      // lengthChars la do dai day du (excerpt chi cat 120 ky tu de hien thi).
      const tokens = Math.max(1, Math.ceil(d.signals.lengthChars / 4));
      tokensByModel[d.chosenModelId] = (tokensByModel[d.chosenModelId] ?? 0) + tokens;
      if (d.direction === 'escalate') escalations += 1;
      else if (d.direction === 'deescalate') deescalations += 1;
      else stays += 1;
    }
    return {
      id: sessionId,
      createdAt: entry.createdAt,
      messageCount: decisions.length,
      decisions: decisions.length,
      escalations,
      deescalations,
      stays,
      tokensByModel,
      currentModelId: entry.currentModelId,
    };
  }

  /** Bao cao chi phi/tiet kiem cho 1 session (hoac gop tat ca neu khong truyen id). */
  costReport(sessionId?: string): MidChatCostReport {
    const ids = sessionId !== undefined ? [sessionId] : this.sessionIds();
    if (sessionId !== undefined && !this.sessions.has(sessionId)) {
      throw new Error(`Khong co session nao co id "${sessionId}".`);
    }
    const aggregate: MidChatCostReport = {
      id: sessionId ?? 'all-sessions',
      createdAt: ids.length > 0
        ? Math.min(...ids.map((id) => (this.sessions.get(id) as MidChatSessionEntry).createdAt))
        : Date.now(),
      messageCount: 0,
      decisions: 0,
      escalations: 0,
      deescalations: 0,
      stays: 0,
      tokensByModel: {},
      currentModelId: ids.length === 1
        ? (this.sessions.get(ids[0]) as MidChatSessionEntry).currentModelId
        : this.policy.defaultModelId,
      tokensRoutedAwayFromStrong: 0,
      lightShare: 0,
      decisionsDetail: [],
    };
    for (const id of ids) {
      const summary = this.summarize(id);
      aggregate.messageCount += summary.messageCount;
      aggregate.decisions += summary.decisions;
      aggregate.escalations += summary.escalations;
      aggregate.deescalations += summary.deescalations;
      aggregate.stays += summary.stays;
      for (const [model, tokens] of Object.entries(summary.tokensByModel)) {
        aggregate.tokensByModel[model] = (aggregate.tokensByModel[model] ?? 0) + tokens;
      }
      const entry = this.sessions.get(id) as MidChatSessionEntry;
      aggregate.decisionsDetail.push(...entry.router.getLogStore().list());
    }
    aggregate.decisionsDetail.sort((a, b) => b.decidedAt - a.decidedAt);
    const totalTokens = Object.values(aggregate.tokensByModel).reduce((a, b) => a + b, 0);
    const lightTokens = Object.entries(aggregate.tokensByModel)
      .filter(([model]) => this.policy.candidates
        .find((c) => c.modelId === model)?.tier === 'light')
      .reduce((a, [, t]) => a + t, 0);
    aggregate.tokensRoutedAwayFromStrong = lightTokens;
    aggregate.lightShare = totalTokens > 0 ? Math.round((lightTokens / totalTokens) * 1000) / 1000 : 0;
    return aggregate;
  }

  listSessions(): MidChatSessionSummary[] {
    return this.sessionIds().map((id) => this.summarize(id));
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  clearAll(): void {
    this.sessions.clear();
  }
}
