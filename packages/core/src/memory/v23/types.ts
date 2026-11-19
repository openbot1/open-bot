/**
 * Memory v23 — types (v1.38, Doi T1).
 *
 * Y tuong hoc tu survey v138 muc 2 (Mem0 / Letta / Zep / CoALA) —
 * tu thiet ke lai hoan toan cho open-bot, KHONG copy code/text/tai
 * san cua bat ky repo nao:
 *  - Mem0-style: pipeline extract -> consolidate (add / update /
 *    supersede / merge / noise) -> retrieve; fusion 3 tin hieu
 *    (semantic + BM25 + entity); da scope user/agent/run.
 *  - Letta-style: sleep-time compute — don dep block/record luc
 *    idle, khong chiem turn cua nguoi dung.
 *  - CoALA-style: procedural memory — workflow thanh cong duoc ghi
 *    thanh skill co version + danh gia, tai dung duoc.
 *  - Zep-style: moi record co validity window (validFrom/validTo)
 *    nen retrieval biet fact dung *khi nao*.
 *
 * Chay 100% local: khong goi model chat, khong goi mang ngoai.
 * Embedder mac dinh la Ollama local (nomic-embed-text); khi Ollama
 * khong co, dung hash-embedder xac dinh noi bo (ghi ro provenance
 * `hash`, khong bao gio gia vo la embedding that).
 *
 * Moi loi tra ve ket qua co cau truc thay vi throw (tru lap trinh
 * sai dau vao kieu).
 */

/** Scope cua mot record — chay theo hierarchy run < agent < user < app. */
export interface V23Scope {
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
export const V23_EMPTY_SCOPE: Readonly<V23Scope> = {
  userId: '',
  agentId: '',
  runId: '',
  appId: '',
};

/** Tao scope day du tu cac phan rieng le (phan nao thieu = ''). */
export function makeV23Scope(
  partial: Partial<V23Scope> = {},
): V23Scope {
  return {
    userId: partial.userId ?? '',
    agentId: partial.agentId ?? '',
    runId: partial.runId ?? '',
    appId: partial.appId ?? '',
  };
}

/** Muc scope cua mot record — dung de tinh trong so retrieval. */
export type V23ScopeLevel = 'run' | 'agent' | 'user' | 'app';

/** Trong so mac dinh theo muc scope (run hep nhat = lien quan nhat). */
export const V23_SCOPE_LEVEL_WEIGHTS: Readonly<Record<V23ScopeLevel, number>> = {
  run: 1.0,
  agent: 0.8,
  user: 0.6,
  app: 0.4,
};

/** Loai record v23. */
export type V23RecordKind =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'procedure'
  | 'person'
  | 'project'
  | 'note';

export const V23_RECORD_KINDS: readonly V23RecordKind[] = [
  'fact',
  'preference',
  'decision',
  'procedure',
  'person',
  'project',
  'note',
];

/** Trang thai vong doi cua record. */
export type V23RecordStatus =
  | 'active'
  | 'superseded'
  | 'merged'
  | 'archived'
  | 'deleted';

export const V23_RECORD_STATUSES: readonly V23RecordStatus[] = [
  'active',
  'superseded',
  'merged',
  'archived',
  'deleted',
];

/** Nguon goc embedding gan tren record (trung thuc ve chat luong). */
export type V23EmbeddingKind = 'ollama' | 'hash' | 'none';

/**
 * Ban ghi memory v23 — don vi duy nhat cua store v23.
 * Tuong thich y niem voi V21PortableRecord nhung them scope,
 * entity, validity window va truong phuc vu fusion/retrieval.
 */
export interface V23MemoryRecord {
  /** Id on dinh, duy nhat trong store (slug, vd `v23-fact-0001`). */
  id: string;
  kind: V23RecordKind;
  /** Noi dung day du (mot cau / mot doan ngan, <= 2000 ky tu). */
  text: string;
  /** Scope so huu. */
  scope: V23Scope;
  /** Entity duoc trich tu text (ten chuan hoa, viet thuong). */
  entities: string[];
  /** Tags tu do. */
  tags: string[];
  /** Do tin cay 0..1 (extractor danh gia, consolidation dieu chinh). */
  confidence: number;
  /** Nguon goc (vd `chat:session-7`, `sleep-v23`, `tool:memory_v23_add`). */
  source: string;
  /** ISO date (YYYY-MM-DD) — fact bat dau dung tu ngay nay. */
  validFrom?: string;
  /** ISO date (YYYY-MM-DD) — fact het dung sau ngay nay. */
  validTo?: string;
  /** Embedding L2-normalised (neu co) + loai nguon cua no. */
  embedding?: number[];
  embeddingKind?: V23EmbeddingKind;
  /** Version tang dan, bat dau tu 1. */
  version: number;
  status: V23RecordStatus;
  /** Id record da thay the record nay (khi status = superseded/merged). */
  supersededBy?: string;
  /** So lan record duoc retrieval tra ve (dung cho sleep promote). */
  retrievalCount: number;
  /** Epoch ms tao / sua lan cuoi / truy cap lan cuoi. */
  createdAt: number;
  updatedAt: number;
  lastRetrievedAt?: number;
}

/** Input toi thieu de tao record moi (store tu dien cac field con lai). */
export interface V23NewRecordInput {
  kind?: V23RecordKind;
  text: string;
  scope?: Partial<V23Scope>;
  entities?: string[];
  tags?: string[];
  confidence?: number;
  source?: string;
  validFrom?: string;
  validTo?: string;
}

/** Ung vien trich xuat tu hoi thoai (chua vao store). */
export interface V23ExtractCandidate {
  /** Text ung vien (da cat sach). */
  text: string;
  kind: V23RecordKind;
  /** Do tin cay ban dau 0..1. */
  confidence: number;
  /** Entity duoc thay trong cau. */
  entities: string[];
  /** Ly do chon loai / danh gia (giai thich duoc). */
  reason: string;
  /** Vi tri cau trong input (index cau). */
  sentenceIndex: number;
  /** Nguon: user / agent / system. */
  speaker: 'user' | 'agent' | 'system';
}

/** Quyet dinh consolidation cho mot ung vien (kieu Mem0). */
export type V23DecisionKind =
  | 'add'
  | 'update'
  | 'supersede'
  | 'merge'
  | 'noise'
  | 'drop';

/** Mot quyet dinh consolidation + audit trail. */
export interface V23ConsolidationDecision {
  candidate: V23ExtractCandidate;
  decision: V23DecisionKind;
  /** Record dich (neu update/supersede/merge). */
  targetId?: string;
  /** Record ket qua (neu add/update/merge tao/cap nhat record). */
  resultId?: string;
  /** Giai thich ngan gon, doc duoc. */
  reason: string;
}

/** Bao cao mot lan chay consolidation. */
export interface V23ConsolidationReport {
  candidates: number;
  added: number;
  updated: number;
  superseded: number;
  merged: number;
  noise: number;
  dropped: number;
  decisions: V23ConsolidationDecision[];
  /** Epoch ms chay. */
  ranAt: number;
  /** Thoi gian chay (ms). */
  durationMs: number;
}

/** Trong so fusion 3 tin hieu (tong khong bat buoc = 1, se chuan hoa). */
export interface V23FusionWeights {
  semantic: number;
  bm25: number;
  entity: number;
}

export const V23_FUSION_DEFAULT_WEIGHTS: Readonly<V23FusionWeights> = {
  semantic: 0.45,
  bm25: 0.35,
  entity: 0.2,
};

/** Mot hit fusion: record + diem tung tin hieu + giai thich. */
export interface V23FusionHit {
  record: V23MemoryRecord;
  /** Diem tong hop 0..1. */
  score: number;
  /** Diem tung tin hieu, da chuan hoa 0..1. */
  signals: { semantic: number; bm25: number; entity: number };
  /** Giai thich doc duoc, vd "semantic 0.81 · bm25 0.62 · entity 1.00". */
  explanation: string;
}

/** Hit retrieval da scope: them muc scope + nguon da gop. */
export interface V23ScopedHit extends V23FusionHit {
  /** Muc scope cua record (run/agent/user/app). */
  scopeLevel: V23ScopeLevel;
  /** Trong so scope da ap dung. */
  scopeWeight: number;
  /** Id cac record khac da gop vao hit nay khi dedupe. */
  mergedSources: string[];
}

/** Trang thai cua mot procedural skill. */
export type V23SkillStatus = 'candidate' | 'active' | 'deprecated' | 'retired';

export const V23_SKILL_STATUSES: readonly V23SkillStatus[] = [
  'candidate',
  'active',
  'deprecated',
  'retired',
];

/** Mot lan chay workflow (attempt) — dau vao cua procedural memory. */
export interface V23WorkflowAttempt {
  /** Ten workflow (vd `deploy-preview`, `fix-flaky-test`). */
  workflow: string;
  /** Cac buoc da chay (mo ta ngan, theo thu tu). */
  steps: string[];
  /** Ten tool da goi (vd `shell_exec`, `memory_v23_search`). */
  toolsUsed: string[];
  /** Ket qua: thanh cong hay that bai. */
  outcome: 'success' | 'failure';
  /** Thoi gian chay (ms). */
  durationMs: number;
  /** Ghi chu / loi (neu that bai). */
  note?: string;
  /** Scope chay workflow. */
  scope?: Partial<V23Scope>;
  /** Epoch ms chay. */
  ranAt: number;
}

/**
 * Procedural skill — workflow thanh cong duoc ghi lai de tai dung.
 * Version tang khi workflow duoc cai tien (steps doi + danh gia tot hon).
 */
export interface V23ProceduralSkill {
  /** Id on dinh (slug cua workflow). */
  id: string;
  /** Ten workflow goc. */
  workflow: string;
  /** Phien ban skill (bat dau 1, tang moi lan cai tien). */
  version: number;
  status: V23SkillStatus;
  /** Cac buoc chuan (dang dung tot nhat hien tai). */
  steps: string[];
  /** Tool nen dung theo thu tu uu tien. */
  toolsUsed: string[];
  /** Khi nao dung skill nay (mo ta dieu kien kich hoat). */
  trigger: string;
  /** So lan chay thanh cong / tong so lan chay. */
  successCount: number;
  totalCount: number;
  /** Ti le thanh cong 0..1 (tinh tu successCount/totalCount). */
  successRate: number;
  /** Thoi gian chay trung binh (ms). */
  avgDurationMs: number;
  /** Danh gia chat luong 0..5 (nguoi dung / he thong cham). */
  rating: number;
  /** So luot danh gia da nhan. */
  ratingCount: number;
  /** Scope skill thuoc ve. */
  scope: V23Scope;
  /** Epoch ms tao / sua lan cuoi. */
  createdAt: number;
  updatedAt: number;
}

/** Bao cao mot lan chay sleep-time consolidation v2. */
export interface V23SleepReport {
  /** So record quet. */
  scanned: number;
  /** So record bi decay (giam confidence). */
  decayed: number;
  /** So record bi prune (xoa mem -> archived/deleted). */
  pruned: number;
  /** So cap trung lap da merge. */
  merged: number;
  /** So record duoc promote (tang confidence vi xuat hien nhieu). */
  promoted: number;
  /** So record danh dau stale theo validTo. */
  markedStale: number;
  /** Ly do ngan gon cho tung hanh dong dang ke (toi da 50 dong). */
  actions: string[];
  ranAt: number;
  durationMs: number;
  /** Pass co dung han ngan sach (time/ops) khong. */
  budgetHit: boolean;
}

/** Mot case eval cua harness v23 (offline, khong can model). */
export interface V23EvalCase {
  id: string;
  /** Nhom: extract | fusion | scope | sleep | procedural. */
  group: 'extract' | 'fusion' | 'scope' | 'sleep' | 'procedural';
  name: string;
  /** Input tuy nhom (hoa thoai, query, ...). */
  input: unknown;
  /** Dieu kien pass (mo ta; harness tu kiem tra theo nhom). */
  expect: string;
}

/** Ket qua mot case eval. */
export interface V23EvalResult {
  caseId: string;
  group: V23EvalCase['group'];
  passed: boolean;
  detail: string;
}

/** Tom tat chay eval. */
export interface V23EvalSummary {
  total: number;
  passed: number;
  failed: number;
  results: V23EvalResult[];
  ranAt: number;
}

/** Thong ke store v23 (cho tool stats + UI). */
export interface V23StoreStats {
  total: number;
  active: number;
  byKind: Record<string, number>;
  byScopeLevel: Record<string, number>;
  byStatus: Record<string, number>;
  withEmbedding: number;
  avgConfidence: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
}

// ---------------------------------------------------------------------------
// Helper thuan tuy (dung chung cho moi module v23)
// ---------------------------------------------------------------------------

let v23IdCounter = 0;

/**
 * Tao id duy nhat dang `v23-<kind>-<base36>-<counter>` (khong dung
 * random de test on dinh theo thoi gian truyen vao).
 */
export function createV23Id(kind: string, now = Date.now()): string {
  v23IdCounter += 1;
  const safe = kind.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'rec';
  return `v23-${safe}-${now.toString(36)}-${v23IdCounter.toString(36)}`;
}

/** Cat khoang trang thua, chuan hoa khoang trang trong text. */
export function normalizeV23Text(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Tach text thanh token viet thuong (bo dau cau, giu so + chu co dau). */
export function tokenizeV23(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Stopword tieng Viet + tieng Anh (dung cho BM25 / dedupe / entity). */
export const V23_STOPWORDS: Readonly<Set<string>> = new Set([
  'la', 'cua', 'va', 'thi', 'ma', 'de', 'cho', 'voi', 'trong', 'tren',
  'duoi', 'khi', 'neu', 'vi', 'do', 'này', 'nay', 'kia', 'ay',
  'mot', 'cac', 'nhung', 'rat', 'cung', 'da', 'se',
  'dang', 'bi', 'duoc', 'co', 'khong', 'toi', 'ban', 'anh', 'chi', 'em',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'to', 'in', 'on', 'for', 'with', 'and', 'or', 'but', 'if',
  'when', 'then', 'than', 'that', 'this', 'it', 'its', 'as', 'at', 'by',
  'from', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his',
  'her', 'our', 'their', 'me', 'him', 'us', 'them', 'do', 'does', 'did',
  'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
]);

/** Token co nghia (bo stopword, dai >= 2). */
export function contentTokensV23(text: string): string[] {
  return tokenizeV23(text).filter((t) => t.length >= 2 && !V23_STOPWORDS.has(t));
}

/** Jaccard tren tap token co nghia (0..1). */
export function jaccardV23(a: string, b: string): number {
  const setA = new Set(contentTokensV23(a));
  const setB = new Set(contentTokensV23(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

/** Kep so vao [min, max]. */
export function clampMemoryV23(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Hom nay dang YYYY-MM-DD (UTC, dung cho validFrom/validTo). */
export function todayIsoV23(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Kiem tra record con hieu luc tai thoi diem `now` theo validity
 * window (khong co window = luon hieu luc).
 */
export function isV23RecordValidAt(record: V23MemoryRecord, now = Date.now()): boolean {
  const today = todayIsoV23(now);
  if (record.validFrom && today < record.validFrom) return false;
  if (record.validTo && today > record.validTo) return false;
  return true;
}

/** Muc scope cua mot scope cu the (run > agent > user > app). */
export function scopeLevelOfV23(scope: V23Scope): V23ScopeLevel {
  if (scope.runId) return 'run';
  if (scope.agentId) return 'agent';
  if (scope.userId) return 'user';
  return 'app';
}
