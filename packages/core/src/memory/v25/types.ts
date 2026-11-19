/**
 * Memory v25 — types (v1.40, Doi T1).
 *
 * Y tuong hoc tu survey v140 muc 2 + 3 + 4 (chi y tuong, KHONG copy
 * code/text/tai san cua bat ky repo nao):
 *  - Letta-style: sleep-time agent chay nen khi agent ranh, to chuc lai
 *    memory ngoai vong lap chinh; memory block co label + mo ta + gia
 *    tri, attach/detach, chia se giua cac bot, danh dau read-only.
 *  - Graphiti/Zep-style: fact edge bi-temporal — moi edge co valid_at +
 *    invalid_at + created_at + expired_at; fact moi mau thuan fact cu
 *    thi DONG khoang hieu luc (set invalid_at/expired_at), KHONG xoa
 *    vat ly; query "fact dung tai thoi diem X" loc cua so valid chua X.
 *  - Mem0-style: LLM judge quyet dinh ADD / UPDATE / DELETE / NOISE
 *    cho fact moi so voi memory hien co; DELETE o day nghia la dong
 *    hieu luc, khong xoa.
 *
 * Khac biet voi v24: v24 co shared block co khoa + sleep don gian +
 * conflict resolver theo rule; v25 them sleep-time agent day du
 * (trigger sau N buoc, model rieng cho sleep pass, budget), block
 * chia se co read-only theo bot, fact edge bi-temporal day du 4 moc
 * thoi gian + query as-of, va judge ADD/UPDATE/DELETE/NOISE co the
 * cam LLM that qua V25JudgeFn (mac dinh rule judge xac dinh, chay
 * 100% local, khong goi mang).
 *
 * Chay 100% local: khong goi model chat, khong goi API ngoai —
 * judge mac dinh la rule-based, embedder/search la keyword noi bo.
 */

/** Loi memory v25 — message tieng Viet. */
export class V25Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V25Error';
  }
}

/** Ket qua tra ve kieu Result — loi la chuoi, khong throw qua tool. */
export type V25Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function okV25<T>(value: T): V25Result<T> {
  return { ok: true, value };
}

export function errV25<T>(error: string): V25Result<T> {
  return { ok: false, error };
}

/** Scope cua mot record — chay theo hierarchy run < agent < user < app. */
export interface V25Scope {
  /** Id user so huu ('' = user hien tai / legacy). */
  userId: string;
  /** Id bot (agent) ghi record ('' = khong gan bot nao). */
  agentId: string;
  /** Id run tao ra record ('' = khong ro run). */
  runId: string;
  /** App / workspace ('' = thay o moi noi). */
  appId: string;
}

/** Scope rong: thay o moi scope (dung cho query mac dinh). */
export const V25_EMPTY_SCOPE: Readonly<V25Scope> = {
  userId: '',
  agentId: '',
  runId: '',
  appId: '',
};

export function makeV25Scope(partial: Partial<V25Scope> = {}): V25Scope {
  return {
    userId: partial.userId ?? '',
    agentId: partial.agentId ?? '',
    runId: partial.runId ?? '',
    appId: partial.appId ?? '',
  };
}

/** Muc scope cua mot record — dung de tinh trong so retrieval. */
export type V25ScopeLevel = 'run' | 'agent' | 'user' | 'app';

export function scopeLevelV25(scope: V25Scope): V25ScopeLevel {
  if (scope.runId) return 'run';
  if (scope.agentId) return 'agent';
  if (scope.userId) return 'user';
  return 'app';
}

/** Scope key duy nhat de partition du lieu. */
export function scopeKeyV25(scope: V25Scope): string {
  return [scope.userId, scope.agentId, scope.runId, scope.appId]
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** Hai scope co khop nhau khong (scope rong khop moi thu). */
export function scopeMatchesV25(record: V25Scope, query: V25Scope): boolean {
  if (query.userId && record.userId !== query.userId) return false;
  if (query.agentId && record.agentId !== query.agentId) return false;
  if (query.runId && record.runId !== query.runId) return false;
  if (query.appId && record.appId !== query.appId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Fact edge bi-temporal (Graphiti-style, 4 moc thoi gian)
// ---------------------------------------------------------------------------

/** Trang thai cua mot fact edge. */
export type V25EdgeStatus = 'active' | 'superseded' | 'expired';

/** Su kien trong lich su mot edge — audit day du, khong xoa. */
export interface V25EdgeEvent {
  /** Thoi diem su kien (ISO). */
  at: string;
  /** Loai su kien. */
  kind: 'created' | 'superseded' | 'expired' | 'revalidated' | 'judged';
  /** Chi tiet doc duoc (vd "superseded by edge_... vi UPDATE"). */
  detail: string;
  /** Ai thuc hien (bot id / 'sleep-agent' / 'user'). */
  by: string;
}

/**
 * Fact edge bi-temporal: 2 truc thoi gian.
 *  - valid time: fact dung trong the gioi that tu validAt den invalidAt
 *    (null = van dung / khong ro diem bat dau).
 *  - transaction time: he thong biet fact tu createdAt, het biet tu
 *    expiredAt (null = van biet).
 * Fact bi supersede chi DONG cua so (set invalidAt/expiredAt), khong
 * bao gio bi xoa vat ly — lich su con nguyen de audit.
 */
export interface V25FactEdge {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  /** Fact dung trong the gioi that tu luc nao (ISO, null = khong ro). */
  validAt: string | null;
  /** Fact het dung luc nao (ISO, null = van dung). */
  invalidAt: string | null;
  /** He thong hoc duoc fact luc nao (ISO). */
  createdAt: string;
  /** He thong het luu fact luc nao (ISO, null = van luu). */
  expiredAt: string | null;
  status: V25EdgeStatus;
  /** Episode / turn nguon sinh ra fact (vd "turn:12" / "sleep-pass:3"). */
  episodeId: string;
  /** Doan text goc lam chung cu. */
  sourceText: string;
  scope: V25Scope;
  /** Do tin cay 0..1. */
  confidence: number;
  /** Fact nay thay the fact nao (id, neu la supersede/UPDATE). */
  supersedesId: string | null;
  /** Fact nay bi fact nao thay the (id, neu bi supersede). */
  supersededById: string | null;
  /** Judge nao dan toi edge nay (ADD/UPDATE/DELETE/NOISE). */
  judgeDecision: V25JudgeDecision | null;
  history: V25EdgeEvent[];
}

/** Input tao fact edge moi (store tu dien createdAt/expiredAt/status). */
export interface V25FactEdgeInput {
  subject: string;
  predicate: string;
  object: string;
  /** Valid time bat dau (ISO, rong = lay luc tao). */
  validAt?: string | null;
  episodeId?: string;
  sourceText?: string;
  scope?: Partial<V25Scope>;
  confidence?: number;
  judgeDecision?: V25JudgeDecision | null;
}

/** Fact dung tai thoi diem X? Cua so valid chua X. */
export function edgeValidAtV25(edge: V25FactEdge, atMs: number): boolean {
  const validMs = edge.validAt ? Date.parse(edge.validAt) : Number.NEGATIVE_INFINITY;
  if (Number.isNaN(validMs)) return false;
  if (atMs < validMs) return false;
  if (edge.invalidAt) {
    const invalidMs = Date.parse(edge.invalidAt);
    if (Number.isNaN(invalidMs)) return false;
    if (atMs >= invalidMs) return false;
  }
  return true;
}

/** He thong co biet fact tai thoi diem X khong (transaction time)? */
export function edgeKnownAtV25(edge: V25FactEdge, atMs: number): boolean {
  const createdMs = Date.parse(edge.createdAt);
  if (Number.isNaN(createdMs) || atMs < createdMs) return false;
  if (edge.expiredAt) {
    const expiredMs = Date.parse(edge.expiredAt);
    if (Number.isNaN(expiredMs)) return false;
    if (atMs >= expiredMs) return false;
  }
  return true;
}

/** Edge con hieu luc hien tai? Cua so valid mo + chua het han. */
export function edgeIsCurrentV25(edge: V25FactEdge): boolean {
  return edge.status === 'active' && edge.invalidAt === null && edge.expiredAt === null;
}

// ---------------------------------------------------------------------------
// LLM judge (Mem0-style ADD / UPDATE / DELETE / NOISE)
// ---------------------------------------------------------------------------

/** Quyet dinh cua judge cho 1 fact moi so voi memory hien co. */
export type V25JudgeDecision = 'ADD' | 'UPDATE' | 'DELETE' | 'NOISE';

/** Ket qua judge 1 fact ung vien. */
export interface V25JudgeVerdict {
  decision: V25JudgeDecision;
  /** Do tin cay cua quyet dinh 0..1. */
  confidence: number;
  /** Ly do doc duoc (vd "trung subject+predicate, object khac"). */
  reason: string;
  /** Fact hien co lien quan nhat (neu co). */
  matchedFactId: string | null;
  /** Object de xuat khi UPDATE (neu khac object ung vien). */
  suggestedObject: string | null;
}

/** Input cho judge: ung vien + fact hien co cung subject/predicate. */
export interface V25JudgeInput {
  candidate: V25FactEdgeInput;
  existing: V25FactEdge[];
  /** Nguon goi judge (vd "sleep-pass:3", "tool:memory_v25_judge"). */
  source: string;
}

/**
 * Ham judge co the cam LLM that: host truyen ham async goi model roi
 * parse ve V25JudgeVerdict. Mac dinh dung rule judge xac dinh
 * (createRuleJudgeV25) — chay 100% local, khong goi mang.
 */
export type V25JudgeFn = (input: V25JudgeInput) => Promise<V25JudgeVerdict> | V25JudgeVerdict;

/** 1 muc log judge — moi quyet dinh deu ghi lai de audit. */
export interface V25JudgeLogEntry {
  id: string;
  at: string;
  candidateSubject: string;
  candidatePredicate: string;
  candidateObject: string;
  decision: V25JudgeDecision;
  confidence: number;
  reason: string;
  matchedFactId: string | null;
  /** Quyet dinh da duoc ap dung chua (ADD/UPDATE/DELETE) hay chi xem? */
  applied: boolean;
  /** Ket qua ap dung (vd "added edge_...; closed edge_..."). */
  appliedDetail: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Shared memory block (Letta-style)
// ---------------------------------------------------------------------------

/** 1 version cua block — lich su day du, revert tao version moi. */
export interface V25BlockVersion {
  version: number;
  value: string;
  updatedAt: string;
  updatedBy: string;
  reason: string;
}

/**
 * Memory block chia se giua cac bot (Letta-style):
 * label + mo ta + gia tri, attach/detach nhieu bot, co the danh dau
 * read-only — bot khac (khong phai owner) chi duoc doc block
 * read-only, khong duoc ghi.
 */
export interface V25SharedBlock {
  id: string;
  /** Label duy nhat trong scope, vd "human", "persona", "project". */
  label: string;
  /** Mo ta ngan de bot biet block chua gi. */
  description: string;
  /** Gia tri hien tai (Markdown/text). */
  value: string;
  /** Bot so huu block (duoc ghi ca khi read-only). */
  ownerBotId: string;
  /** Cac bot dang attach (duoc doc; ghi tuy readOnly). */
  attachedBotIds: string[];
  /** true = bot khac owner chi doc, khong ghi. */
  readOnly: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  scope: V25Scope;
  /** Gioi han ky tu cua value (0 = khong gioi han). */
  maxChars: number;
  history: V25BlockVersion[];
}

/** Input tao block moi. */
export interface V25SharedBlockInput {
  label: string;
  description?: string;
  value: string;
  ownerBotId: string;
  scope?: Partial<V25Scope>;
  readOnly?: boolean;
  maxChars?: number;
  attachBotIds?: string[];
}

/** Bot co duoc ghi block nay khong? */
export function blockWritableByV25(block: V25SharedBlock, botId: string): boolean {
  if (botId === block.ownerBotId) return true;
  if (block.readOnly) return false;
  return block.attachedBotIds.includes(botId);
}

/** Bot co duoc doc block nay khong? */
export function blockReadableByV25(block: V25SharedBlock, botId: string): boolean {
  if (botId === block.ownerBotId) return true;
  return block.attachedBotIds.includes(botId);
}

// ---------------------------------------------------------------------------
// Sleep-time consolidation agent (Letta-style)
// ---------------------------------------------------------------------------

/** 1 turn hoi thoai cho vao buffer cho sleep pass xu ly. */
export interface V25Turn {
  role: 'user' | 'agent' | 'system';
  text: string;
  /** Thoi diem turn (ISO). */
  at: string;
}

/** Cau hinh sleep-time agent. */
export interface V25SleepConfig {
  /** Bat/tat sleep pass tu dong. */
  enabled: boolean;
  /** So buoc tro chuyen (turn) thi chay 1 pass. */
  triggerSteps: number;
  /** Model dung cho sleep pass (vd "local-rule-v1" / ten model LLM). */
  model: string;
  /** Ngan sach moi pass. */
  budget: {
    /** So fact toi da xu ly moi pass. */
    maxFactsPerPass: number;
    /** So turn toi da quet moi pass. */
    maxTurnsPerPass: number;
    /** So ky tu toi da quet moi pass. */
    maxCharsPerPass: number;
  };
  /** Label cac block sleep agent duoc cap nhat (ngoai vong lap chinh). */
  blockTargets: string[];
}

/** Cau hinh mac dinh: trigger sau 10 turn, rule judge, budget vua. */
export const V25_DEFAULT_SLEEP_CONFIG: Readonly<V25SleepConfig> = {
  enabled: true,
  triggerSteps: 10,
  model: 'local-rule-v1',
  budget: { maxFactsPerPass: 50, maxTurnsPerPass: 20, maxCharsPerPass: 20000 },
  blockTargets: [],
};

/** 1 hanh dong trong sleep pass — de doc bao cao. */
export interface V25SleepAction {
  kind: 'judge' | 'add' | 'update' | 'close' | 'noise' | 'block' | 'skip' | 'budget';
  detail: string;
}

/** Bao cao 1 sleep pass. */
export interface V25SleepPass {
  id: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  turnsScanned: number;
  charsScanned: number;
  factsExtracted: number;
  judged: number;
  added: number;
  updated: number;
  closed: number;
  noise: number;
  blocksUpdated: number;
  budgetHit: boolean;
  actions: V25SleepAction[];
  /** Ly do chay pass (vd "trigger:10 turns", "manual", "tool"). */
  reason: string;
}

/** Trang thai sleep agent (de luu xuong disk). */
export interface V25SleepState {
  config: V25SleepConfig;
  /** So turn tu pass gan nhat. */
  turnsSinceLastPass: number;
  /** Turn dang cho xu ly. */
  pendingTurns: V25Turn[];
  /** Tong so pass da chay. */
  totalPasses: number;
  lastPass: V25SleepPass | null;
  passes: V25SleepPass[];
}

// ---------------------------------------------------------------------------
// Store stats / health / snapshot
// ---------------------------------------------------------------------------

/** Thong ke store v25. */
export interface V25Stats {
  factsTotal: number;
  factsActive: number;
  factsSuperseded: number;
  factsExpired: number;
  blocksTotal: number;
  blocksReadOnly: number;
  blocksAttached: number;
  judgeTotal: number;
  judgeByDecision: Record<V25JudgeDecision, number>;
  sleepPasses: number;
  turnsBuffered: number;
  turnsSinceLastPass: number;
}

/** 1 muc health check. */
export interface V25Health {
  severity: 'info' | 'warn' | 'error';
  code: string;
  detail: string;
}

/** Snapshot store de luu/load JSON. */
export interface V25StoreSnapshot {
  version: 25;
  exportedAt: string;
  facts: V25FactEdge[];
  blocks: V25SharedBlock[];
  judgeLog: V25JudgeLogEntry[];
  sleep: V25SleepState;
}

/** Ket qua tim kiem (keyword + time-aware). */
export interface V25SearchHit {
  kind: 'fact' | 'block';
  id: string;
  text: string;
  score: number;
  explanation: string;
  /** Edge di kem (khi kind=fact). */
  edge?: V25FactEdge;
}

// ---------------------------------------------------------------------------
// Tien ich dung chung
// ---------------------------------------------------------------------------

/** Tao id duy nhat co prefix (vd "edge_...", "blk_...", "pass_..."). */
export function makeV25Id(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** Clamp so ve [0, 1]. */
export function clamp01V25(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Parse ISO date, tra null neu khong hop le. */
export function parseIsoV25(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO string tai thoi diem ms cho truoc (mac dinh now). */
export function isoAtV25(ms: number): string {
  return new Date(ms).toISOString();
}

/** Cat ngan text ve gioi han, them dau ... neu bi cat. */
export function truncateV25(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 3) return text.slice(0, limit);
  return `${text.slice(0, limit - 3)}...`;
}

/** Chuan hoa text de so sanh (lowercase, gom khoang trang, bo dau cau cuoi). */
export function normalizeTextV25(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:!?'"“”‘’()[\]{}]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tach text thanh token chu (bo dau cau) de tinh overlap. */
export function tokenizeV25(text: string): string[] {
  return normalizeTextV25(text)
    .split(/[^a-z0-9àáâãèéêìíòóôõùúýăâđêôơưàảãạảấầẩẫậắằẳẵặẹẻẽềềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+/u)
    .filter((t) => t.length > 0);
}

/** Do tuong dong Jaccard giua 2 tap token (0..1). */
export function jaccardV25(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/** Kiem tra label block hop le: [a-z0-9_-], 1..64 ky tu. */
export function isValidBlockLabelV25(label: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(label);
}

/** Kiem tra cau hinh sleep hop le — tra loi neu sai. */
export function validateSleepConfigV25(config: Partial<V25SleepConfig>): string | null {
  if (config.triggerSteps !== undefined) {
    if (!Number.isInteger(config.triggerSteps) || config.triggerSteps < 1 || config.triggerSteps > 1000) {
      return 'triggerSteps phai la so nguyen 1..1000.';
    }
  }
  if (config.model !== undefined && config.model.trim().length === 0) {
    return 'model khong duoc rong.';
  }
  if (config.budget !== undefined) {
    const b = config.budget;
    if (b.maxFactsPerPass !== undefined && (!Number.isInteger(b.maxFactsPerPass) || b.maxFactsPerPass < 1 || b.maxFactsPerPass > 500)) {
      return 'budget.maxFactsPerPass phai la so nguyen 1..500.';
    }
    if (b.maxTurnsPerPass !== undefined && (!Number.isInteger(b.maxTurnsPerPass) || b.maxTurnsPerPass < 1 || b.maxTurnsPerPass > 200)) {
      return 'budget.maxTurnsPerPass phai la so nguyen 1..200.';
    }
    if (b.maxCharsPerPass !== undefined && (!Number.isInteger(b.maxCharsPerPass) || b.maxCharsPerPass < 10 || b.maxCharsPerPass > 500000)) {
      return 'budget.maxCharsPerPass phai la so nguyen 10..500000.';
    }
  }
  if (config.blockTargets !== undefined) {
    for (const label of config.blockTargets) {
      if (!isValidBlockLabelV25(label)) return `blockTargets chua label khong hop le: "${label}".`;
    }
  }
  return null;
}
