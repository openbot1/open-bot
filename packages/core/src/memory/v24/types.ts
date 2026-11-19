/**
 * Memory v24 — types (v1.39, Doi T1).
 *
 * Y tuong hoc tu survey v139 muc 3 + 6 (chi y tuong, KHONG copy
 * code/text/tai san cua bat ky repo nao):
 *  - MemFS-style: memory la cay Markdown co version (git-backed o
 *    muc y tuong), agent tu edit qua tool, snapshot luon co trong
 *    system prompt.
 *  - Mem0 v3-style: ADD-only extraction — chi append luc ghi, khong
 *    overwrite; retrieval tu phan xu cai nao con dung.
 *  - Graphiti/Zep-style: conflict resolution co provenance + valid
 *    time (thoi gian hieu luc trong the gioi that).
 *  - WikiTrace-style: moi lesson phai kem evidence link (nguon,
 *    doan trich, thoi diem) — lesson khong evidence bi quarantine.
 *  - Letta-style: shared memory blocks lien-bot + sleep-time
 *    consolidation chay luc idle.
 *  - R083 building blocks: admission policy (cai gi duoc ghi),
 *    scope + expiry luc ghi, decay/forgetting, chong memory
 *    poisoning o admission-time.
 *  - SoMem-style: memory doc co link cheo, duyet theo do thi.
 *
 * Khac biet voi v23: v23 la record JSON + fusion 3 tin hieu; v24
 * them lop MemFS Markdown (cay file co version), admission gate
 * truoc moi lan ghi, evidence bat buoc cho lesson, shared block
 * co khoa + lich su version, decay/forgetting co lich trinh, va
 * fused retrieval them time-aware weight theo valid-time.
 *
 * Chay 100% local: khong goi model chat, khong goi mang ngoai.
 * Embedder la hash-embedding xac dinh noi bo (ghi ro provenance
 * `hash`, khong bao gio gia vo la embedding that).
 */

/** Loi memory v24 — message tieng Viet. */
export class V24Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V24Error';
  }
}

/** Scope cua mot record — chay theo hierarchy run < agent < user < app. */
export interface V24Scope {
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
export const V24_EMPTY_SCOPE: Readonly<V24Scope> = {
  userId: '',
  agentId: '',
  runId: '',
  appId: '',
};

/** Tao scope day du tu cac phan rieng le (phan nao thieu = ''). */
export function makeV24Scope(partial: Partial<V24Scope> = {}): V24Scope {
  return {
    userId: partial.userId ?? '',
    agentId: partial.agentId ?? '',
    runId: partial.runId ?? '',
    appId: partial.appId ?? '',
  };
}

/** Muc scope cua mot record — dung de tinh trong so retrieval. */
export type V24ScopeLevel = 'run' | 'agent' | 'user' | 'app';

/** Muc scope cua 1 scope cu the: run > agent > user > app. */
export function scopeLevelV24(scope: V24Scope): V24ScopeLevel {
  if (scope.runId) return 'run';
  if (scope.agentId) return 'agent';
  if (scope.userId) return 'user';
  return 'app';
}

/** Scope key duy nhat de partition du lieu. */
export function scopeKeyV24(scope: V24Scope): string {
  return [scope.userId, scope.agentId, scope.runId, scope.appId]
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** Hai scope co bang nhau khong. */
export function scopesEqualV24(a: V24Scope, b: V24Scope): boolean {
  return (
    a.userId === b.userId &&
    a.agentId === b.agentId &&
    a.runId === b.runId &&
    a.appId === b.appId
  );
}

/** Kiem tra scope hop le. Tra null neu hop le, message loi neu khong. */
export function validateScopeV24(scope: V24Scope): string | null {
  if (!scope || typeof scope !== 'object') return 'Scope phai la object.';
  const bad = /[/\\:*?"<>|\n\r]/;
  for (const [key, value] of Object.entries(scope)) {
    if (typeof value !== 'string') return `Scope field "${key}" phai la string.`;
    if (bad.test(value)) return `Scope field "${key}" chua ky tu khong hop le.`;
    if (value.length > 200) return `Scope field "${key}" qua dai (>200 ky tu).`;
  }
  return null;
}

/** Loai quan he co kieu (typed edge) giua subject va object. */
export type V24EdgeType =
  | 'lives_in'
  | 'prefers'
  | 'dislikes'
  | 'owns'
  | 'works_at'
  | 'works_as'
  | 'studies_at'
  | 'knows'
  | 'member_of'
  | 'speaks'
  | 'interested_in'
  | 'allergic_to'
  | 'has_goal'
  | 'uses'
  | 'located_in'
  | 'related_to';

/** Tat ca typed edge hop le. */
export const V24_EDGE_TYPES: ReadonlySet<string> = new Set([
  'lives_in', 'prefers', 'dislikes', 'owns', 'works_at', 'works_as',
  'studies_at', 'knows', 'member_of', 'speaks', 'interested_in',
  'allergic_to', 'has_goal', 'uses', 'located_in', 'related_to',
]);

export function isValidEdgeTypeV24(value: string): value is V24EdgeType {
  return V24_EDGE_TYPES.has(value);
}

/** Predicate don tri (mot subject chi co 1 object dung tai 1 thoi diem). */
export const V24_SINGLE_VALUED_EDGES: ReadonlySet<string> = new Set([
  'lives_in', 'works_at', 'works_as', 'studies_at',
]);

export function isSingleValuedEdgeV24(edge: string): boolean {
  return V24_SINGLE_VALUED_EDGES.has(edge);
}

/** Kind cua record/fact v24. */
export type V24RecordKind =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'procedure'
  | 'lesson'
  | 'person'
  | 'project'
  | 'note';

export const V24_RECORD_KINDS: ReadonlySet<string> = new Set([
  'fact', 'preference', 'decision', 'procedure', 'lesson', 'person', 'project', 'note',
]);

export function isValidRecordKindV24(value: string): value is V24RecordKind {
  return V24_RECORD_KINDS.has(value);
}

/** Trang thai vong doi cua fact v24 (khong bao gio xoa vat ly). */
export type V24FactStatus = 'active' | 'invalidated' | 'superseded' | 'merged' | 'archived' | 'quarantined';

/** Nguon goc bat buoc cua moi fact — khong co fact "mo coi". */
export interface V24Provenance {
  /** Episode da sinh ra fact. */
  episodeId: string;
  /** Turn hoi thoai trong episode. */
  turnId: string;
  /** Phien chay luc ghi fact. */
  runId: string;
  /** Bot da ghi fact. */
  botId: string;
  /** User so huu fact. */
  userId: string;
  /** Thoi diem ghi (ISO). */
  at: string;
  /** Cau goc da rut ra fact (cat ngan, toi da 500 ky tu). */
  sourceText: string;
  /** Phuong phap trich xuat: rule | llm | merge | resolver | import. */
  method: 'rule' | 'llm' | 'merge' | 'resolver' | 'import';
  /** Model / rule set da dung (vd "v24-rule-v1"). */
  extractor: string;
  /** Embedding dung luc retrieval: 'hash' (noi bo, xac dinh). */
  embeddingKind: 'hash';
}

/** Mot fact bi-temporal + co evidence: subject —edge→ object. */
export interface V24Fact {
  id: string;
  subject: string;
  edge: V24EdgeType;
  object: string;
  kind: V24RecordKind;
  /** Fact dung trong the gioi that tu luc nao (ISO, null = khong ro). */
  validFrom: string | null;
  /** Fact het dung luc nao (ISO, null = van dung). */
  validTo: string | null;
  /** He thong hoc duoc fact luc nao (transaction time, ISO). */
  learnedAt: string;
  /** Fact bi danh dau invalid luc nao (ISO, null = chua invalid). */
  invalidatedAt: string | null;
  /** Ly do invalid (neu co). */
  invalidReason: string | null;
  /** Fact nay thay the fact nao (id, neu la supersede). */
  supersedesId: string | null;
  /** Fact nay bi fact nao thay the (id, neu bi supersede). */
  supersededById: string | null;
  /** Fact nay gop tu cac fact nao (id, neu la merge). */
  mergedFromIds: string[];
  /** Do tin cay 0..1 (bi decay theo thoi gian neu khong duoc dung). */
  confidence: number;
  /** Muc quan trong 0..1 (quyet dinh toc do decay + uu tien prompt). */
  importance: number;
  /** Lan cuoi duoc retrieval tra ve (ISO, null = chua bao gio). */
  lastAccessedAt: string | null;
  /** So lan duoc retrieval tra ve. */
  accessCount: number;
  /** Het han luu tru luc nao (ISO, null = khong het han). */
  expiresAt: string | null;
  /** Trang thai vong doi. */
  status: V24FactStatus;
  /** Scope bat buoc. */
  scope: V24Scope;
  /** Nguon goc. */
  provenance: V24Provenance;
  /** Id evidence (lesson) chung minh fact nay, neu co. */
  evidenceIds: string[];
  /** Ghi chu giai thich them. */
  note: string;
}

/** Fact vua trich xuat trong 1 pass (chua ghi vao store). */
export interface V24ExtractedFact {
  subject: string;
  edge: V24EdgeType;
  object: string;
  kind: V24RecordKind;
  /** Do tin cay 0..1 cua lan trich nay. */
  confidence: number;
  /** Co phai phu dinh ("khong con thich...") khong. */
  isNegation: boolean;
  /** Cua so hieu luc suy ra tu text (neu co). */
  validFrom: string | null;
  validTo: string | null;
  /** Entity duoc nhac trong object (de linking). */
  mentionedEntities: string[];
  /** Cau goc. */
  sourceText: string;
  /** Ly do trich (giai thich rule nao khop). */
  reason: string;
}

/** Ket qua trich xuat 1 pass (ADD-only). */
export interface V24ExtractionResult {
  /** Fact ung vien (chi them moi, khong sua/xoa). */
  candidates: V24ExtractedFact[];
  /** So turn bi loai la noise (chao hoi / cam on / hoi don thuan). */
  noiseTurns: number;
  /** So fact bi loai vi trung lap trong cung pass. */
  dedupedWithinPass: number;
  /** So fact bi loai vi confidence duoi nguong. */
  belowThreshold: number;
  /** So fact bi admission chan (doc hai / nhay cam). */
  blockedByAdmission: number;
  /** Thoi gian trich (ms). */
  elapsedMs: number;
}

/** --- Evidence (WikiTrace-style) --- */

/** Loai nguon evidence. */
export type V24EvidenceKind = 'conversation' | 'document' | 'tool_output' | 'url' | 'file' | 'observation';

/** Mot bang chung dang sau mot lesson / fact. */
export interface V24Evidence {
  id: string;
  kind: V24EvidenceKind;
  /** Nguon: ten file / ten conversation / URL / ten tool. */
  source: string;
  /** Doan trich goc (toi da 500 ky tu) — bang chung that, khong tom tat. */
  excerpt: string;
  /** URI toi nguon goc neu co (file://, https://, memfs://...). */
  uri: string | null;
  /** Thoi diem ghi nhan bang chung (ISO). */
  capturedAt: string;
  /** Ai ghi nhan. */
  capturedBy: string;
  /** Do tin cay cua bang chung 0..1. */
  confidence: number;
}

/** Trang thai lesson. */
export type V24LessonStatus = 'active' | 'quarantined' | 'superseded' | 'archived' | 'retracted';

/** Mot lesson — bai hoc rut ra, BAT BUOC kem evidence. */
export interface V24Lesson {
  id: string;
  /** Tieu de ngan (1 dong). */
  title: string;
  /** Noi dung bai hoc. */
  body: string;
  /** Evidence bat buoc: it nhat 1 evidence hop le, neu khong lesson bi quarantine. */
  evidence: V24Evidence[];
  /** Do tin cay 0..1. */
  confidence: number;
  /** Muc quan trong 0..1. */
  importance: number;
  /** Trang thai. */
  status: V24LessonStatus;
  /** Ly do quarantine/retract (neu co). */
  statusReason: string | null;
  /** Lesson nay thay the lesson nao (id). */
  supersedesId: string | null;
  /** Lesson nay bi lesson nao thay the (id). */
  supersededById: string | null;
  /** Bai hoc dung trong khoang thoi gian nao (valid-time). */
  validFrom: string | null;
  validTo: string | null;
  /** Tao luc nao (ISO). */
  createdAt: string;
  /** Cap nhat lan cuoi (ISO). */
  updatedAt: string;
  /** Het han luc nao (ISO, null = khong het han). */
  expiresAt: string | null;
  /** Tags. */
  tags: string[];
  /** Scope. */
  scope: V24Scope;
  /** Bot da rut ra lesson. */
  authorBotId: string;
  /** So lan lesson duoc retrieval tra ve / ap dung. */
  appliedCount: number;
  /** Lan cuoi duoc ap dung (ISO, null = chua bao gio). */
  lastAppliedAt: string | null;
}

/** --- MemFS (Markdown tree co version) --- */

/** Mot node trong cay MemFS: 1 file Markdown. */
export interface V24MemNode {
  /** Duong dan tuong doi trong cay, vd "profile/preferences.md". */
  path: string;
  /** Tieu de (dong # dau tien). */
  title: string;
  /** Noi dung Markdown (khong tinh dong tieu de). */
  body: string;
  /** Link cheo [[path]] toi node khac (SoMem-style graph). */
  links: string[];
  /** Version tang moi lan edit (bat dau 1). */
  version: number;
  /** Tao luc nao (ISO). */
  createdAt: string;
  /** Cap nhat lan cuoi (ISO). */
  updatedAt: string;
  /** Bot edit lan cuoi. */
  updatedBy: string;
  /** Hash noi dung (FNV-1a hex) de phat hien doi ngoai. */
  contentHash: string;
  /** Node da bi xoa mem (tombstone) chua. */
  deleted: boolean;
  /** Scope cua node. */
  scope: V24Scope;
}

/** Mot version trong lich su cua 1 MemFS node. */
export interface V24MemVersion {
  path: string;
  version: number;
  /** Noi dung tai version nay. */
  body: string;
  /** Ai edit, luc nao, vi sao. */
  updatedBy: string;
  updatedAt: string;
  reason: string;
  contentHash: string;
}

/** --- Admission policy (R083 building blocks) --- */

/** Ket qua admission: cho ghi / cach ly / tu choi. */
export type V24AdmissionVerdict = 'allow' | 'quarantine' | 'deny';

/** Quyet dinh admission cho 1 lan ghi. */
export interface V24AdmissionDecision {
  id: string;
  verdict: V24AdmissionVerdict;
  /** Ly do cu the (moi ly do 1 dong). */
  reasons: string[];
  /** Diem rui ro 0..1 (cao = nguy hiem). */
  riskScore: number;
  /** Rule nao da kich hoat. */
  triggeredRules: string[];
  /** Scope duoc gan luc ghi. */
  scope: V24Scope;
  /** Het han luc ghi (ISO, null = khong het han). */
  expiresAt: string | null;
  /** Kind duoc gan luc ghi. */
  kind: V24RecordKind;
  /** Danh gia luc nao (ISO). */
  screenedAt: string;
  /** Phien ban policy (vd "v24-admission-v1"). */
  policyVersion: string;
  /** Do dai text goc (ky tu). */
  sourceChars: number;
}

/** Mot ban ghi trong admission log. */
export interface V24AdmissionLogEntry extends V24AdmissionDecision {
  /** Text goc da cat ngan (toi da 200 ky tu, khong luu secret). */
  sourcePreview: string;
}

/** Cau hinh admission policy. */
export interface V24AdmissionPolicyConfig {
  /** Confidence toi thieu de duoc allow (mac dinh 0.3). */
  minConfidence: number;
  /** Diem rui ro >= nguong nay thi deny (mac dinh 0.8). */
  denyRiskThreshold: number;
  /** Diem rui ro >= nguong nay thi quarantine (mac dinh 0.5). */
  quarantineRiskThreshold: number;
  /** So ky tu toi da cho 1 lan ghi (mac dinh 4000). */
  maxChars: number;
  /** Co chan PII (email/sdt) khong (mac dinh true -> quarantine). */
  blockPII: boolean;
  /** Co chan credential-like khong (mac dinh true -> deny). */
  blockCredentials: boolean;
  /** Co chan instruction-injection khong (mac dinh true -> deny). */
  blockInjection: boolean;
  /** TTL mac dinh theo scope (ms). */
  ttlByScopeLevel: Record<V24ScopeLevel, number | null>;
}

/** Cau hinh admission mac dinh. */
export const V24_DEFAULT_ADMISSION_CONFIG: V24AdmissionPolicyConfig = {
  minConfidence: 0.3,
  denyRiskThreshold: 0.8,
  quarantineRiskThreshold: 0.5,
  maxChars: 4000,
  blockPII: true,
  blockCredentials: true,
  blockInjection: true,
  ttlByScopeLevel: {
    run: 7 * 24 * 3600 * 1000,
    agent: 180 * 24 * 3600 * 1000,
    user: 365 * 24 * 3600 * 1000,
    app: 365 * 24 * 3600 * 1000,
  },
};

/** --- Conflict resolution (Graphiti-style, co provenance) --- */

/** Loai xung dot. */
export type V24ConflictKind =
  | 'same_edge_different_object'
  | 'negation_vs_positive'
  | 'temporal_overlap'
  | 'duplicate'
  | 'lesson_contradicts';

/** Xung dot giua fact moi va fact cu. */
export interface V24Conflict {
  id: string;
  /** Fact ung vien moi. */
  incoming: V24ExtractedFact;
  /** Fact cu dang active mau thuan (id). */
  existingFactId: string;
  /** Loai xung dot. */
  kind: V24ConflictKind;
  /** Muc do nghiem trong 0..1. */
  severity: number;
  /** Giai thich ngan cho nguoi doc. */
  explanation: string;
  /** Phat hien luc nao (ISO). */
  detectedAt: string;
  /** Scope. */
  scope: V24Scope;
  /** Co phai valid-time cua 2 fact giao nhau khong. */
  validTimeOverlaps: boolean;
}

/** Cach giai quyet xung dot. */
export type V24ResolutionStrategy = 'supersede' | 'merge' | 'keep_both' | 'reject_incoming' | 'quarantine_both';

/** Ban ghi giai quyet xung dot (provenance day du). */
export interface V24Resolution {
  conflictId: string;
  strategy: V24ResolutionStrategy;
  /** Ai quyet dinh: 'user' | 'auto' | 'system'. */
  decidedBy: string;
  /** Ly do (bat buoc khi supersede/reject). */
  reason: string;
  /** Quyet dinh luc nao (ISO). */
  decidedAt: string;
  /** Fact moi duoc tao ra boi resolution (neu co). */
  resultingFactId: string | null;
  /** Fact cu bi anh huong (invalid/superseded, neu co). */
  affectedFactId: string | null;
  /** Valid-time moi cua fact ket qua (neu doi). */
  resultingValidFrom: string | null;
  resultingValidTo: string | null;
  /** Evidence dung de quyet dinh (id evidence, neu co). */
  evidenceIds: string[];
}

/** --- Shared memory blocks (Letta-style, lien-bot) --- */

/** Khoa viet cua 1 shared block (lease co han). */
export interface V24BlockLock {
  /** Bot dang giu khoa. */
  holderBotId: string;
  /** Lay khoa luc nao (ISO). */
  acquiredAt: string;
  /** Het han luc nao (ISO) — het han thi khoa tu giai phong. */
  expiresAt: string;
  /** Ly do lay khoa. */
  reason: string;
}

/** Mot version trong lich su cua shared block. */
export interface V24BlockVersion {
  version: number;
  content: string;
  updatedBy: string;
  updatedAt: string;
  reason: string;
  contentHash: string;
}

/** Mot shared memory block: 1 block, nhieu bot doc/ghi. */
export interface V24SharedBlock {
  id: string;
  /** Ten dinh danh (duy nhat trong scope, vd "organization"). */
  name: string;
  /** Tieu de hien thi. */
  title: string;
  /** Noi dung Markdown hien tai. */
  content: string;
  /** Version hien tai (bat dau 1). */
  version: number;
  /** Lich su version (day du, khong cat). */
  history: V24BlockVersion[];
  /** Bot nao dang attach block nay. */
  attachedBotIds: string[];
  /** Khoa viet hien tai (null = khong ai giu). */
  lock: V24BlockLock | null;
  /** Tao luc nao (ISO). */
  createdAt: string;
  /** Cap nhat lan cuoi (ISO). */
  updatedAt: string;
  /** Bot cap nhat lan cuoi. */
  updatedBy: string;
  /** Scope. */
  scope: V24Scope;
  /** Het han luc nao (ISO, null = khong het han). */
  expiresAt: string | null;
}

/** --- Decay / forgetting --- */

/** Chinh sach decay theo kind. */
export interface V24DecayPolicy {
  /** Half-life (ngay) theo kind: sau bao lau confidence giam mot nua neu khong duoc dung. */
  halfLifeDaysByKind: Record<V24RecordKind, number>;
  /** Confidence duoi nguong nay thi danh dau stale (mac dinh 0.15). */
  staleThreshold: number;
  /** Confidence duoi nguong nay + qua han thi archive (mac dinh 0.05). */
  archiveThreshold: number;
  /** Moi lan duoc dung thi confidence tang toi da bao nhieu (mac dinh 0.05). */
  accessBoost: number;
  /** Confidence toi da sau boost (mac dinh 0.95). */
  maxConfidence: number;
}

/** Chinh sach decay mac dinh. */
export const V24_DEFAULT_DECAY_POLICY: V24DecayPolicy = {
  halfLifeDaysByKind: {
    fact: 180,
    preference: 365,
    decision: 365,
    procedure: 365,
    lesson: 365,
    person: 365,
    project: 90,
    note: 30,
  },
  staleThreshold: 0.15,
  archiveThreshold: 0.05,
  accessBoost: 0.05,
  maxConfidence: 0.95,
};

/** Ket qua 1 lan ap dung decay cho 1 fact/lesson. */
export interface V24DecayOutcome {
  id: string;
  kind: V24RecordKind;
  oldConfidence: number;
  newConfidence: number;
  /** 'decayed' | 'stale' | 'archived' | 'revived' | 'unchanged' | 'expired'. */
  action: 'decayed' | 'stale' | 'archived' | 'revived' | 'unchanged' | 'expired';
  detail: string;
}

/** --- Fused retrieval (semantic + BM25 + entity + time-aware) --- */

/** Diem thanh phan giai thich duoc cua retrieval fusion v24. */
export interface V24FusionScore {
  /** Diem semantic (cosine hash-embedding) 0..1. */
  semantic: number;
  /** Diem keyword BM25 chuan hoa 0..1. */
  keyword: number;
  /** Diem entity matching 0..1. */
  entity: number;
  /** Diem time-aware (valid-time + recency + decay) 0..1. */
  time: number;
  /** Tong co trong so 0..1. */
  total: number;
}

/** Trong so fusion (tong khong nhat thiet = 1, se chuan hoa). */
export interface V24FusionWeights {
  semantic: number;
  keyword: number;
  entity: number;
  time: number;
}

/** Trong so fusion mac dinh. */
export const V24_DEFAULT_FUSION_WEIGHTS: V24FusionWeights = {
  semantic: 0.35,
  keyword: 0.25,
  entity: 0.2,
  time: 0.2,
};

/** Mot hit cua retrieval fusion. */
export interface V24FusionHit {
  /** Loai nguon: 'fact' | 'lesson' | 'memfs'. */
  sourceKind: 'fact' | 'lesson' | 'memfs';
  /** Id cua fact/lesson/node. */
  id: string;
  /** Text hien thi. */
  text: string;
  score: V24FusionScore;
  /** Entity nao khop (ten, neu co). */
  matchedEntities: string[];
  /** Giai thich ngan vi sao hit nay duoc chon. */
  explanation: string;
}

/** --- Sleep-time consolidation --- */

/** Mot hanh dong sleep job da lam. */
export interface V24SleepAction {
  /** Loai: decay | merge | promote | stale | archive | evidence | lock | snapshot. */
  kind: 'decay' | 'merge' | 'promote' | 'stale' | 'archive' | 'evidence' | 'lock' | 'snapshot';
  detail: string;
}

/** Bao cao 1 pass sleep-time consolidation. */
export interface V24SleepReport {
  /** Chay luc nao (ISO). */
  ranAt: string;
  /** Co phai chay vi idle khong (false = chay tay). */
  idleTriggered: boolean;
  /** So fact/lesson da quet. */
  scanned: number;
  decayed: number;
  merged: number;
  promoted: number;
  markedStale: number;
  archived: number;
  lessonsQuarantined: number;
  locksReleased: number;
  /** Co het ngan sach (ops/time) khong — pass sau lam tiep. */
  budgetHit: boolean;
  /** Thoi gian chay (ms). */
  durationMs: number;
  /** Danh sach hanh dong (toi da maxOps). */
  actions: V24SleepAction[];
}

/** --- Snapshot cho system prompt --- */

/** Snapshot MemFS + lesson/fact de dua vao system prompt. */
export interface V24Snapshot {
  /** Cay thu muc (danh sach path). */
  tree: string[];
  /** Noi dung cac node duoc chon (path -> markdown). */
  nodes: Record<string, string>;
  /** Lesson active duoc chon (tieu de + body ngan). */
  lessons: { id: string; title: string; body: string }[];
  /** Fact active quan trong nhat (dang "subject edge object"). */
  facts: string[];
  /** Tong ky tu cua snapshot. */
  chars: number;
  /** Ngan sach ky tu da dung / gioi han. */
  budgetChars: number;
  /** Tao luc nao (ISO). */
  generatedAt: string;
}

/** --- Stats / health --- */

/** Thong ke store v24. */
export interface V24Stats {
  factsTotal: number;
  factsActive: number;
  factsByKind: Record<string, number>;
  factsByStatus: Record<string, number>;
  lessonsTotal: number;
  lessonsActive: number;
  lessonsQuarantined: number;
  lessonsWithEvidence: number;
  memfsNodes: number;
  memfsDeleted: number;
  sharedBlocks: number;
  sharedBlocksLocked: number;
  conflictsOpen: number;
  resolutionsTotal: number;
  admissionAllowed: number;
  admissionQuarantined: number;
  admissionDenied: number;
  avgConfidence: number;
}

/** Mot van de suc khoe cua store. */
export interface V24HealthIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  detail: string;
  suggestion: string;
}

/** --- Gioi han --- */
export const V24_MAX_FACTS_PER_SCOPE = 10000;
export const V24_MAX_LESSONS_PER_SCOPE = 5000;
export const V24_MAX_MEMFS_NODES = 2000;
export const V24_MAX_SHARED_BLOCKS = 500;
export const V24_MAX_TEXT_CHARS = 4000;
export const V24_MAX_OBJECT_CHARS = 500;
export const V24_MAX_SUBJECT_CHARS = 200;
export const V24_MAX_SOURCE_TEXT_CHARS = 500;
export const V24_MAX_EVIDENCE_EXCERPT_CHARS = 500;
export const V24_MAX_BLOCK_CONTENT_CHARS = 20000;
export const V24_MAX_MEMFS_BODY_CHARS = 20000;
export const V24_MAX_LINKS_PER_NODE = 50;
export const V24_DEFAULT_MIN_CONFIDENCE = 0.3;
export const V24_DEFAULT_FUSION_TOP_K = 10;
export const V24_HIGH_CONFIDENCE_GATE = 0.8;
export const V24_DEFAULT_SNAPSHOT_BUDGET_CHARS = 8000;
export const V24_DEFAULT_SLEEP_IDLE_MS = 5 * 60 * 1000;
export const V24_DEFAULT_SLEEP_MAX_OPS = 200;
export const V24_ADMISSION_POLICY_VERSION = 'v24-admission-v1';
export const V24_EXTRACTOR_VERSION = 'v24-rule-v1';

/** --- Helpers --- */

/** Tao id duy nhat co tien to (khong dung crypto, du cho local store). */
export function makeV24Id(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** Clamp so ve [0, 1]. */
export function clamp01V24(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Parse ISO date, tra null neu khong hop le. */
export function parseIsoV24(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO string tai thoi diem ms cho truoc (mac dinh now). */
export function isoAtV24(ms: number): string {
  return new Date(ms).toISOString();
}

/** Cat ngan text ve gioi han, them dau ... neu bi cat. */
export function truncateV24(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

/** Chuan hoa text de so sanh (khong dau hoa, khong dau cau thua). */
export function normalizeTextV24(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tach token (tu) tu text de lam BM25 / entity matching. */
export function tokenizeV24(raw: string): string[] {
  const norm = normalizeTextV24(raw);
  if (!norm) return [];
  return norm.split(' ').filter((t) => t.length > 1);
}

/** Kiem tra 2 khoang valid time co giao nhau khong (null = vo han). */
export function validWindowsOverlapV24(
  aFrom: string | null,
  aTo: string | null,
  bFrom: string | null,
  bTo: string | null,
): boolean {
  const aStart = parseIsoV24(aFrom)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const aEnd = parseIsoV24(aTo)?.getTime() ?? Number.POSITIVE_INFINITY;
  const bStart = parseIsoV24(bFrom)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bEnd = parseIsoV24(bTo)?.getTime() ?? Number.POSITIVE_INFINITY;
  return aStart < bEnd && bStart < aEnd;
}

/** Hash FNV-1a 32-bit cua 1 chuoi — dung cho content hash + hash embedding. */
export function fnv1aV24(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Content hash hex cua 1 chuoi. */
export function contentHashV24(text: string): string {
  return fnv1aV24(text).toString(16).padStart(8, '0');
}
