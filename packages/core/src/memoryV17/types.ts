/**
 * Memory v17 — shared types (v1.36, Doi T1).
 *
 * Y tuong hoc tu mem0 v3 (04/2026, Apache 2.0) — extraction single-pass
 * ADD-only, entity linking vao collection phu `<ten>_entities`, retrieval
 * hop nhat semantic + BM25 + entity + time-aware ranking — va tu
 * Graphiti/Zep (bi-temporal knowledge graph: hai timeline valid time +
 * transaction time, fact cu danh dau invalid thay vi xoa) — tu thiet ke
 * lai hoan toan cho open-bot, chay 100% local, KHONG copy code/text/tai
 * san cua bat ky repo nao.
 *
 * Khac biet voi memory v16 (lop RIENG cua v17, khong dung lai code v16):
 *  1. Extraction ADD-only: pipeline trich xuat CHI them fact moi; khong
 *     bao gio tu UPDATE/DELETE fact cu trong luc trich xuat. Moi thay
 *     doi deu di qua conflict resolver co provenance (xem conflicts.ts).
 *  2. Entity linking co collection phu rieng: moi collection fact
 *     `<name>` co collection doi `<name>_entities` chua entity + typed
 *     edge (lives_in / prefers / owns / works_at / knows / ...).
 *  3. Bi-temporal that: moi fact mang ca validFrom/validTo (fact dung
 *     khi nao trong the gioi that) va learnedAt/invalidatedAt (he thong
 *     biet khi nao); fact cu danh dau invalid, khong bao gio xoa dong.
 *  4. Scope isolation chat: scope key bat buoc (tenant/user/agent/
 *     conversation); moi truy van loc dung scope; moi co gang doc cheo
 *     scope deu bi chan + ghi audit (bai hoc vu ro ri cross-tenant
 *     cua mem0, cong bo 20/10/2026).
 */

/** Loi memory v17 — message tieng Viet. */
export class M17Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M17Error';
  }
}

/** Scope bat buoc cua moi fact / entity / truy van v17. */
export interface M17Scope {
  /** Tenant / to chuc ('' = mac dinh, single-tenant local). */
  tenantId: string;
  /** User so huu memory. */
  userId: string;
  /** Bot (agent) ghi memory. */
  botId: string;
  /** Conversation / session ('' = khong gan conversation cu the). */
  conversationId: string;
}

/** Scope mac dinh cho single-user local. */
export const M17_DEFAULT_SCOPE: M17Scope = {
  tenantId: '',
  userId: 'local-user',
  botId: '',
  conversationId: '',
};

/** Loai quan he co kieu (typed edge) giua entity va fact / entity. */
export type M17EdgeType =
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
export const M17_EDGE_TYPES: ReadonlySet<string> = new Set([
  'lives_in',
  'prefers',
  'dislikes',
  'owns',
  'works_at',
  'works_as',
  'studies_at',
  'knows',
  'member_of',
  'speaks',
  'interested_in',
  'allergic_to',
  'has_goal',
  'uses',
  'located_in',
  'related_to',
]);

/** Predicate don tri (mot subject chi co 1 object dung tai 1 thoi diem). */
export const M17_SINGLE_VALUED_EDGES: ReadonlySet<string> = new Set([
  'lives_in',
  'works_at',
  'works_as',
  'studies_at',
]);

/** Edge nao la \"cam xuc / so thich\" (duoc phep nhieu object song song). */
export const M17_MULTI_VALUED_EDGES: ReadonlySet<string> = new Set([
  'prefers',
  'dislikes',
  'owns',
  'knows',
  'member_of',
  'speaks',
  'interested_in',
  'allergic_to',
  'has_goal',
  'uses',
  'located_in',
  'related_to',
]);

export function isValidEdgeTypeM17(value: string): value is M17EdgeType {
  return M17_EDGE_TYPES.has(value);
}

export function isSingleValuedEdgeM17(edge: string): boolean {
  return M17_SINGLE_VALUED_EDGES.has(edge);
}

/** Loai thuc the v17. */
export type M17EntityKind =
  | 'person'
  | 'place'
  | 'organization'
  | 'thing'
  | 'food'
  | 'activity'
  | 'language'
  | 'tool'
  | 'other';

/** Tat ca kind hop le. */
export const M17_ENTITY_KINDS: ReadonlySet<string> = new Set([
  'person',
  'place',
  'organization',
  'thing',
  'food',
  'activity',
  'language',
  'tool',
  'other',
]);

export function isValidEntityKindM17(value: string): value is M17EntityKind {
  return M17_ENTITY_KINDS.has(value);
}

/** Trang thai vong doi cua fact v17 (khong bao gio xoa vat ly). */
export type M17FactStatus =
  | 'active'
  | 'invalidated'
  | 'superseded'
  | 'merged'
  | 'quarantined';

/** Trang thai vong doi cua entity. */
export type M17EntityStatus = 'active' | 'merged' | 'invalidated';

/** Nguon goc bat buoc cua moi fact — khong co fact \"mo coi\". */
export interface M17Provenance {
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
  /** Model / rule set da dung (vd \"m17-rule-v1\", \"gemini-2.5-flash\"). */
  extractor: string;
}

/** Mot fact bi-temporal: subject —edge→ object. */
export interface M17Fact {
  id: string;
  /** Chu the (thuong la user, hoac ten entity). */
  subject: string;
  /** Quan he co kieu. */
  edge: M17EdgeType;
  /** Doi tuong (gia tri / ten entity). */
  object: string;
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
  /** Do tin cay 0..1. */
  confidence: number;
  /** Trang thai vong doi. */
  status: M17FactStatus;
  /** Scope bat buoc — fact chi thay trong scope nay (tru share). */
  scope: M17Scope;
  /** Nguon goc. */
  provenance: M17Provenance;
  /** Ghi chu giai thich them (vd ly do resolver). */
  note: string;
}

/** Mot entity trong collection phu `<name>_entities`. */
export interface M17Entity {
  id: string;
  /** Ten chuan hoa (duy nhat trong scope sau chuan hoa). */
  name: string;
  kind: M17EntityKind;
  /** Ten goi khac. */
  aliases: string[];
  /** Lan dau thay (ISO). */
  firstSeenAt: string;
  /** Lan cuoi thay (ISO). */
  lastSeenAt: string;
  /** So fact dang tro toi entity nay. */
  factCount: number;
  /** Trang thai. */
  status: M17EntityStatus;
  /** Entity nay gop vao entity nao (neu merged). */
  mergedIntoId: string | null;
  /** Scope bat buoc. */
  scope: M17Scope;
}

/** Mot typed edge giua 2 entity (graph edge rieng, khong phai fact). */
export interface M17EntityEdge {
  id: string;
  /** Entity nguon (id). */
  fromEntityId: string;
  /** Entity dich (id). */
  toEntityId: string;
  /** Quan he co kieu. */
  edge: M17EdgeType;
  /** Fact nao chung minh edge nay (id, co the null neu suy ra). */
  factId: string | null;
  /** Do tin cay 0..1. */
  confidence: number;
  /** Tao luc nao (ISO). */
  createdAt: string;
  /** Scope bat buoc. */
  scope: M17Scope;
}

/** Fact vua trich xuat trong 1 pass (chua ghi vao store). */
export interface M17ExtractedFact {
  subject: string;
  edge: M17EdgeType;
  object: string;
  /** Do tin cay 0..1 cua lan trich nay. */
  confidence: number;
  /** Co phai phu dinh (\"khong con thich...\") khong. */
  isNegation: boolean;
  /** Cua so hieu luc suy ra tu text (neu co). */
  validFrom: string | null;
  validTo: string | null;
  /** Entity duoc nhac trong object (de linking). */
  mentionedEntities: { name: string; kind: M17EntityKind }[];
  /** Cau goc. */
  sourceText: string;
}

/** Ket qua trich xuat 1 pass (ADD-only). */
export interface M17ExtractionResult {
  /** Fact ung vien (chi them moi, khong sua/xoa). */
  candidates: M17ExtractedFact[];
  /** So turn bi loai la noise (chao hoi / cam on / hoi don thuan). */
  noiseTurns: number;
  /** So fact bi loai vi trung lap trong cung pass. */
  dedupedWithinPass: number;
  /** So fact bi loai vi confidence duoi nguong. */
  belowThreshold: number;
  /** So LLM call da dung trong pass (mem0 v3: toi da 1). */
  llmCalls: number;
  /** Thoi gian trich (ms). */
  elapsedMs: number;
}

/** Xung dot giua fact moi va fact cu. */
export interface M17Conflict {
  id: string;
  /** Fact moi (ung vien). */
  incoming: M17ExtractedFact;
  /** Fact cu dang active mau thuan. */
  existingFactId: string;
  /** Loai xung dot. */
  kind: 'same_edge_different_object' | 'negation_vs_positive' | 'temporal_overlap' | 'duplicate';
  /** Muc do nghiem trong 0..1. */
  severity: number;
  /** Giai thich ngan cho nguoi doc. */
  explanation: string;
  /** Phat hien luc nao (ISO). */
  detectedAt: string;
  /** Scope. */
  scope: M17Scope;
}

/** Cach giai quyet xung dot. */
export type M17ResolutionStrategy = 'overwrite' | 'merge' | 'keep_both' | 'reject_incoming';

/** Ban ghi giai quyet xung dot (provenance day du). */
export interface M17Resolution {
  conflictId: string;
  strategy: M17ResolutionStrategy;
  /** Ai quyet dinh: 'user' | 'auto' | 'system'. */
  decidedBy: string;
  /** Ly do (bat buoc khi overwrite). */
  reason: string;
  /** Quyet dinh luc nao (ISO). */
  decidedAt: string;
  /** Fact moi duoc tao ra boi resolution (neu co). */
  resultingFactId: string | null;
  /** Fact cu bi anh huong (invalid/superseded, neu co). */
  affectedFactId: string | null;
}

/** Mot lan co gang doc cheo scope (bi chan). */
export interface M17ScopeViolation {
  id: string;
  /** Scope cua nguoi hoi. */
  requestedScope: M17Scope;
  /** Scope cua du lieu bi cham toi. */
  targetScope: M17Scope;
  /** Hanh dong: 'read' | 'write' | 'search' | 'export'. */
  action: string;
  /** Thoi diem (ISO). */
  at: string;
  /** Mo ta ngan. */
  detail: string;
}

/** Cap chia se tuong minh giua cac scope (khong co la khong share). */
export interface M17ScopeGrant {
  id: string;
  /** Scope nguon (chu du lieu). */
  fromScope: M17Scope;
  /** Scope dich (duoc phep doc). */
  toScope: M17Scope;
  /** Quyen: chi 'read'. */
  permission: 'read';
  /** Cap boi ai, luc nao. */
  grantedBy: string;
  grantedAt: string;
  /** Het han luc nao (null = khong het han). */
  expiresAt: string | null;
}

/** Diem thanh phan giai thich duoc cua retrieval fusion. */
export interface M17FusionScore {
  /** Diem semantic (cosine embedding cuc bo) 0..1. */
  semantic: number;
  /** Diem keyword BM25 chuan hoa 0..1. */
  keyword: number;
  /** Diem entity matching 0..1. */
  entity: number;
  /** Diem time-aware (recency + validity) 0..1. */
  time: number;
  /** Tong co trong so 0..1. */
  total: number;
}

/** Mot hit cua retrieval fusion. */
export interface M17FusionHit {
  fact: M17Fact;
  score: M17FusionScore;
  /** Entity nao khop (ten, neu co). */
  matchedEntities: string[];
}

/** Gioi han kich thuoc v17. */
export const M17_MAX_FACTS_PER_SCOPE = 10000;
export const M17_MAX_ENTITIES_PER_SCOPE = 5000;
export const M17_MAX_EDGES_PER_SCOPE = 20000;
export const M17_MAX_OBJECT_CHARS = 500;
export const M17_MAX_SUBJECT_CHARS = 200;
export const M17_MAX_SOURCE_TEXT_CHARS = 500;
export const M17_MAX_ALIASES_PER_ENTITY = 20;
export const M17_DEFAULT_MIN_CONFIDENCE = 0.5;
export const M17_DEFAULT_FUSION_TOP_K = 10;
/** Nguong conflict: confidence fact cu >= nguong nay thi khong tu dong overwrite. */
export const M17_HIGH_CONFIDENCE_GATE = 0.8;
/** Ten collection phu entity mac dinh. */
export const M17_ENTITY_COLLECTION_SUFFIX = '_entities';

/** Ten collection entity phu cua mot collection fact. */
export function entityCollectionNameM17(factCollection: string): string {
  return `${factCollection}${M17_ENTITY_COLLECTION_SUFFIX}`;
}

/** Chuan hoa ten entity: trim, gom khoang trang, giu nguyen chu hoa dau tu rieng. */
export function normalizeEntityNameM17(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^[.,;:!?'"()\[\]]+/, '')
    .replace(/[.,;:!?'"()\[\]]+$/, '');
}

/** Chuan hoa text de so sanh (khong dau hoa, khong dau cau thua). */
export function normalizeCompareTextM17(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kiem tra scope hop le (userId bat buoc, cac field khong chua ky tu nguy hiem). */
export function validateScopeM17(scope: M17Scope): string | null {
  if (!scope || typeof scope !== 'object') return 'Scope phai la object.';
  if (!scope.userId || typeof scope.userId !== 'string' || !scope.userId.trim()) {
    return 'Scope thieu userId.';
  }
  const bad = /[/\\:*?"<>|\n\r]/;
  for (const [key, value] of Object.entries(scope)) {
    if (typeof value !== 'string') return `Scope field "${key}" phai la string.`;
    if (bad.test(value)) return `Scope field "${key}" chua ky tu khong hop le.`;
    if (value.length > 200) return `Scope field "${key}" qua dai (>200 ky tu).`;
  }
  return null;
}

/** Scope key duy nhat de partition du lieu (dung lam khoa dict / prefix file). */
export function scopeKeyM17(scope: M17Scope): string {
  return [scope.tenantId, scope.userId, scope.botId, scope.conversationId]
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** Hai scope co bang nhau khong (so sanh tung field). */
export function scopesEqualM17(a: M17Scope, b: M17Scope): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.userId === b.userId &&
    a.botId === b.botId &&
    a.conversationId === b.conversationId
  );
}

/** Cat ngan text ve gioi han, them dau ... neu bi cat. */
export function truncateTextM17(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

/** Tao id duy nhat co tien to (khong dung crypto, du cho local store). */
export function makeM17Id(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** Parse ISO date, tra null neu khong hop le. */
export function parseIsoM17(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Kiem tra 2 khoang valid time co giao nhau khong (null = vo han). */
export function validWindowsOverlapM17(
  aFrom: string | null,
  aTo: string | null,
  bFrom: string | null,
  bTo: string | null,
): boolean {
  const aStart = parseIsoM17(aFrom)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const aEnd = parseIsoM17(aTo)?.getTime() ?? Number.POSITIVE_INFINITY;
  const bStart = parseIsoM17(bFrom)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bEnd = parseIsoM17(bTo)?.getTime() ?? Number.POSITIVE_INFINITY;
  return aStart < bEnd && bStart < aEnd;
}

/** Clamp so ve [0, 1]. */
export function clamp01M17(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
