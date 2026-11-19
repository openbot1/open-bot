/**
 * Memory v27 — types (v1.42, Doi T3).
 *
 * Y tuong hoc tu survey v142 muc 3 (Mem0 v3 + Graphiti 0.30-0.31 +
 * Letta, chi y tuong, KHONG copy code/text/tai san cua bat ky
 * repo nao, cua xAI/Cursor):
 *  - Mem0 (04/2026): add-only, single-pass extraction — khong
 *    UPDATE/DELETE; entity linking luc ghi + entity boosting
 *    luc search; SDK open-source bo graph store (graph chi con
 *    tren Platform tra phi) nen open-bot tu giu graph cua minh.
 *  - Graphiti (Zep): temporal knowledge graph bi-temporal — moi
 *    fact co valid_at / invalid_at / created_at / expired_at;
 *    fact doi thi edge cu DONG bang invalid_at chu khong xoa;
 *    episode giu nguyen lam provenance; search ket hop
 *    embedding + BM25 + graph traversal.
 *  - Letta: memory block chia se giua nhieu agent, cap nhat
 *    cho tat ca cung luc.
 *
 * Khac biet voi v25/v26 (v25 da co fact edge bi-temporal +
 * judge ADD/UPDATE/DELETE/NOISE; v26 da co shared block +
 * registry/audit/conflict/budget):
 *  - v27 BO quyet dinh UPDATE/DELETE cua judge: chi con ADD.
 *    Fact moi mau thuan fact cu thi ADD edge moi + DONG edge cu
 *    (supersede) — khong bao gio sua/xoa edge da ghi.
 *  - Extraction single-pass: 1 lan quet text, moi cau chi trich
 *    xuat 1 lan, khong pass 2 sua lai ket qua pass 1.
 *  - Entity linking LUC GHI: mention trong text duoc giai quyet
 *    ve entity chuan ngay khi ingest (khong phai luc search);
 *    search dung entity da link de boosting.
 *  - Episode provenance day du: moi fact giu episodeId +
 *    sourceText; truy tu fact ve episode goc bat cu luc nao.
 *  - Time-travel chat: queryAt(X) loc CA valid time (fact dung
 *    tai X) VA transaction time (he thong da biet fact truoc X)
 *    — chat hon queryAt cua v25 (chi loc valid time).
 *  - Shared block bi-temporal: moi lan cap nhat block ghi 1
 *    timeline entry (validFrom/validTo) + sync log cho tung
 *    agent attach; valueAt(X) dung lai gia tri block tai X.
 *
 * Chay 100% local: khong goi model chat, khong goi API ngoai.
 * "Embedding" o day la lexical proxy xac dinh (token-overlap
 * vector, khong phai vector model) — ghi ro o moi noi hien
 * diem embedding, de khong ai tuong la embedding that.
 */
import {
  edgeIsCurrentV25,
  edgeKnownAtV25,
  edgeValidAtV25,
  isoAtV25,
  makeV25Id,
  makeV25Scope,
  normalizeTextV25,
  parseIsoV25,
  scopeMatchesV25,
  tokenizeV25,
  type V25FactEdge,
  type V25Scope,
} from '../v25/types';
import {
  estimateTokensV26,
  isoAtV26,
  normalizeTextV26,
  parseIsoV26,
  tokenizeV26,
  type V26BlockKind,
} from '../v26/types';

export type { V25FactEdge, V25Scope, V26BlockKind };
export {
  edgeIsCurrentV25,
  edgeKnownAtV25,
  edgeValidAtV25,
  estimateTokensV26,
  makeV25Scope,
  normalizeTextV25,
  scopeMatchesV25,
};

/** Loi memory v27 — message tieng Viet. */
export class V27Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V27Error';
  }
}

/** Ket qua tra ve kieu Result — loi la chuoi, khong throw qua tool. */
export type V27Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function okV27<T>(value: T): V27Result<T> {
  return { ok: true, value };
}

export function errV27<T>(error: string): V27Result<T> {
  return { ok: false, error };
}

/** Tao id duy nhat co prefix (vd "ep_...", "ent_...", "bt_..."). */
export function makeV27Id(prefix: string): string {
  return makeV25Id(prefix);
}

/** ISO string tai thoi diem ms cho truoc (mac dinh now). */
export function isoAtV27(ms: number): string {
  return isoAtV25(ms);
}

/** Parse ISO date, tra null neu khong hop le. */
export function parseIsoV27(value: string | null | undefined): Date | null {
  return parseIsoV26(value);
}

/** Chuan hoa text de so sanh/tim kiem (lowercase, gom khoang trang). */
export function normalizeTextV27(text: string): string {
  return normalizeTextV26(text);
}

/** Tach text thanh token chu (bo dau cau). */
export function tokenizeV27(text: string): string[] {
  return tokenizeV26(text);
}

/** Uoc luong token cua text (xap xi, local): 1 token ~ 4 ky tu. */
export function estimateTokensV27(text: string): number {
  return estimateTokensV26(text);
}

/** Cat ngan text ve gioi han, them dau ... neu bi cat. */
export function truncateV27(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 3) return text.slice(0, limit);
  return `${text.slice(0, limit - 3)}...`;
}

/** Day key `YYYY-MM-DD` (UTC) cua 1 thoi diem ISO. */
export function dayKeyV27(iso: string): string | null {
  const d = parseIsoV27(iso);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/** Gioi han do dai cac truong de store khong phong vo han. */
export const V27_LIMITS = {
  /** Do dai toi da 1 episode text (ky tu). */
  maxEpisodeChars: 20000,
  /** Do dai toi da 1 cau khi trich xuat (ky tu). */
  maxSentenceChars: 2000,
  /** So fact toi da trich xuat tu 1 episode. */
  maxFactsPerEpisode: 200,
  /** So entity toi da trong 1 registry. */
  maxEntities: 10000,
  /** So fact toi da trong 1 graph. */
  maxFacts: 100000,
  /** So episode toi da trong 1 store. */
  maxEpisodes: 20000,
  /** So timeline entry toi da moi block. */
  maxTimelineEntriesPerBlock: 5000,
  /** So sync log entry toi da moi block. */
  maxSyncLogPerBlock: 5000,
  /** Do dai toi da ten entity (ky tu). */
  maxEntityNameChars: 200,
  /** So alias toi da moi entity. */
  maxAliasesPerEntity: 50,
  /** So ket qua search mac dinh. */
  defaultSearchLimit: 10,
  /** So ket qua search toi da. */
  maxSearchLimit: 100,
} as const;

// ---------------------------------------------------------------------------
// Episode — don vi provenance (Graphiti-style, tu thiet ke lai)
// ---------------------------------------------------------------------------

/** Nguon goc cua 1 episode. */
export type V27EpisodeSource =
  | 'chat'
  | 'tool'
  | 'sleep'
  | 'import'
  | 'system'
  | 'voice';

/**
 * 1 episode: doan text goc chua qua xu ly, la bang chung cho moi
 * fact trich xuat tu no. Episode KHONG BAO GIO bi sua/xoa sau khi
 * tao — chi them episode moi. Fact giu episodeId + sourceText de
 * truy nguoc ve day bat cu luc nao.
 */
export interface V27Episode {
  id: string;
  /** Text goc day du (cat o maxEpisodeChars luc tao). */
  text: string;
  /** Nguon sinh ra episode. */
  source: V27EpisodeSource;
  /** Agent/bot ghi episode ('' = he thong). */
  agentId: string;
  /** Nguoi dung lien quan ('' = khong ro). */
  userId: string;
  /** Thoi diem episode xay ra / duoc ghi (ISO). */
  at: string;
  /** Thoi diem he thong luu episode (ISO). */
  createdAt: string;
  scope: V25Scope;
  /** Id cac fact trich xuat tu episode nay (theo thu tu tao). */
  factIds: string[];
  /** Id cac entity duoc link luc ghi episode nay. */
  entityIds: string[];
  /** So cau da quet trong pass trich xuat duy nhat. */
  sentencesScanned: number;
  /** So fact ung vien pass trich xuat sinh ra (truoc dedup). */
  candidatesExtracted: number;
}

/** Input tao episode moi. */
export interface V27EpisodeInput {
  text: string;
  source?: V27EpisodeSource;
  agentId?: string;
  userId?: string;
  /** Thoi diem episode xay ra (ISO, mac dinh = luc tao). */
  at?: string;
  scope?: Partial<V25Scope>;
}

/** Bo loc khi liet ke episode. */
export interface V27EpisodeFilter {
  scope?: V25Scope;
  source?: V27EpisodeSource;
  agentId?: string;
  userId?: string;
  /** Chi episode tu ngay nay (day key YYYY-MM-DD). */
  fromDay?: string;
  /** Chi episode den ngay nay (day key YYYY-MM-DD). */
  toDay?: string;
  /** Tim theo noi dung (khop 1 phan, khong phan biet hoa/thuong). */
  textContains?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Entity — linking luc ghi + boosting luc search (Mem0-style)
// ---------------------------------------------------------------------------

/** Loai entity suy ra tu ngu canh (rule-based, local). */
export type V27EntityKind =
  | 'person'
  | 'place'
  | 'org'
  | 'project'
  | 'tool'
  | 'topic'
  | 'unknown';

/** Cac loai entity hop le (de validate input). */
export const V27_ENTITY_KINDS: readonly V27EntityKind[] = [
  'person',
  'place',
  'org',
  'project',
  'tool',
  'topic',
  'unknown',
];

export function isV27EntityKind(value: string): value is V27EntityKind {
  return (V27_ENTITY_KINDS as readonly string[]).includes(value);
}

/**
 * 1 entity chuan: ten chuan + alias + loai + so lieu dung.
 * Mention trong text duoc LINK ve entity nay LUC GHI (ingest),
 * khong phai luc search — search chi doc entityIds da link san.
 */
export interface V27Entity {
  id: string;
  /** Ten chuan (dang hien thi, giu hoa/thuong goc). */
  name: string;
  /** Ten chuan hoa (lowercase) — khoa dedup/link. */
  normalizedName: string;
  /** Cac ten khac cung chi entity nay (vd nickname, viet tat). */
  aliases: string[];
  kind: V27EntityKind;
  /** So lan entity duoc mention (tang moi lan link thanh cong). */
  mentionCount: number;
  /** So fact dang active co subject/object la entity nay. */
  activeFactCount: number;
  /** Lan mention gan nhat (ISO). */
  lastMentionedAt: string;
  /** Lan tao entity (ISO). */
  createdAt: string;
  scope: V25Scope;
  /** Id entity dich khi entity nay da gop (undefined = chua gop). */
  mergedIntoId?: string;
}

/** Input dang ky entity moi (hoac lay entity co san cung ten). */
export interface V27EntityInput {
  name: string;
  kind?: V27EntityKind;
  aliases?: string[];
  scope?: Partial<V25Scope>;
}

/**
 * Ket qua link 1 mention ve entity.
 *  - `linked`: tim thay entity (moi hoac cu).
 *  - `created`: entity vua duoc tao moi (true) hay da co (false).
 *  - `match`: cach khop — 'exact' (ten chuan), 'alias' (ten phu),
 *    'fuzzy' (overlap token >= nguong), 'none' (khong khop).
 */
export interface V27EntityLink {
  mention: string;
  entityId: string;
  entityName: string;
  kind: V27EntityKind;
  created: boolean;
  match: 'exact' | 'alias' | 'fuzzy' | 'none';
  /** Do tin cay cua link 0..1. */
  confidence: number;
}

/** Trong so boosting cua 1 entity luc search (0..1, da cap). */
export interface V27EntityBoost {
  entityId: string;
  entityName: string;
  /** Trong so boost: mention nhieu + moi thi cao, cap o 1. */
  weight: number;
  mentionCount: number;
  lastMentionedAt: string;
}

// ---------------------------------------------------------------------------
// Fact — add-only candidate + edge bi-temporal (ke thua v25)
// ---------------------------------------------------------------------------

/**
 * 1 fact ung vien do single-pass extraction sinh ra.
 * Chi co quyet dinh ADD — khong co UPDATE/DELETE. Neu fact moi
 * mau thuan fact cu (cung subject+predicate, object khac) thi
 * `supersedesId` tro ve edge cu; lop graph se ADD edge moi +
 * DONG edge cu, khong sua edge cu.
 */
export interface V27CandidateFact {
  subject: string;
  predicate: string;
  object: string;
  /** Do tin cay trich xuat 0..1 (dua vao pattern khop). */
  confidence: number;
  /** Cau goc sinh ra fact (lam sourceText). */
  sourceSentence: string;
  /** Entity da link trong cau (luc ghi). */
  entityIds: string[];
  /** Pattern nao khop (vd "is-a", "likes", "works-at"). */
  pattern: string;
  /** Edge active cu bi fact nay thay the ('' = khong co). */
  supersedesId: string;
  /** Ly do supersede (vd "cung subject+predicate, object khac"). */
  supersedeReason: string;
}

/**
 * Ket qua them 1 fact vao graph (add-only).
 *  - `added`: true = edge moi duoc tao; false = fact da ton tai
 *    (trung y het edge active) nen khong them.
 *  - `edge`: edge moi (neu added) hoac edge trung da co.
 *  - `closed`: cac edge cu bi dong do supersede (rong neu khong).
 *  - `duplicateOf`: id edge trung ('' neu khong trung).
 */
export interface V27AddFactResult {
  added: boolean;
  edge: V25FactEdge;
  closed: V25FactEdge[];
  duplicateOf: string;
}

/**
 * Edge bi-temporal cua v27: ke thua V25FactEdge + them entity
 * da link + episode provenance day du. Cac moc thoi gian giu
 * nguyen ngu nghia v25: validAt/invalidAt (valid time),
 * createdAt/expiredAt (transaction time).
 */
export interface V27Fact extends V25FactEdge {
  /** Entity da link luc ghi (subject/object/mention trong cau). */
  entityIds: string[];
  /** Text episode goc (snapshot ngan, de hien thi khong can join). */
  episodeText: string;
}

/** Chuyen V25FactEdge thanh V27Fact (them entityIds/episodeText). */
export function toV27Fact(
  edge: V25FactEdge,
  opts: { entityIds?: string[]; episodeText?: string } = {},
): V27Fact {
  return {
    ...edge,
    entityIds: opts.entityIds ?? [],
    episodeText: opts.episodeText ?? edge.sourceText,
  };
}

/** Fact dung tai thoi diem X? Ca valid time VA transaction time. */
export function factValidAtV27(fact: V25FactEdge, atMs: number): boolean {
  return edgeValidAtV25(fact, atMs) && edgeKnownAtV25(fact, atMs);
}

/** Fact con hieu luc hien tai? Ke thua dinh nghia v25. */
export function factIsCurrentV27(fact: V25FactEdge): boolean {
  return edgeIsCurrentV25(fact);
}

// ---------------------------------------------------------------------------
// Extraction — single-pass, add-only
// ---------------------------------------------------------------------------

/** Ket qua 1 pass trich xuat duy nhat tren 1 doan text. */
export interface V27ExtractionResult {
  /** So cau da quet (1 pass, moi cau 1 lan). */
  sentencesScanned: number;
  /** So fact ung vien sinh ra (truoc dedup/supersede). */
  candidates: V27CandidateFact[];
  /** So mention da link duoc ve entity. */
  entityLinks: V27EntityLink[];
  /** So cau khong trich duoc fact nao (khong phai loi). */
  sentencesWithNoFact: number;
  /** So fact trung edge active da co (se khong them lai). */
  duplicates: number;
  /** So fact se supersede edge cu (se dong edge cu khi ghi). */
  supersedes: number;
  /** Thoi gian trich xuat (ms, do local). */
  elapsedMs: number;
}

/** Cau hinh extractor (toan bo rule-based, local). */
export interface V27ExtractorConfig {
  /** Chi trich fact tu cau co it nhat N token (mac dinh 3). */
  minSentenceTokens: number;
  /** Bo qua cau chi co < N ky tu (mac dinh 8). */
  minSentenceChars: number;
  /** Nguong overlap token cho fuzzy entity link 0..1 (mac dinh 0.6). */
  fuzzyThreshold: number;
  /** Do tin cay mac dinh cho pattern manh (vd "is-a") 0..1. */
  strongPatternConfidence: number;
  /** Do tin cay mac dinh cho pattern yeu (vd "mentions") 0..1. */
  weakPatternConfidence: number;
}

/** Cau hinh mac dinh cua extractor. */
export const DEFAULT_V27_EXTRACTOR_CONFIG: V27ExtractorConfig = {
  minSentenceTokens: 3,
  minSentenceChars: 8,
  fuzzyThreshold: 0.6,
  strongPatternConfidence: 0.9,
  weakPatternConfidence: 0.6,
};

// ---------------------------------------------------------------------------
// Search — hybrid: BM25-ish + lexical-embedding proxy + entity boost +
// graph traversal + recency (Graphiti-style, tu thiet ke lai)
// ---------------------------------------------------------------------------

/** Thanh phan diem cua 1 ket qua search (tong = diem cuoi). */
export interface V27SearchScore {
  /** Diem BM25-ish: TF cua query token trong fact text. */
  bm25: number;
  /** Diem lexical-embedding proxy: cosine overlap token (KHONG phai vector model). */
  embeddingProxy: number;
  /** Diem entity boosting: query co entity da link trong fact. */
  entityBoost: number;
  /** Diem graph traversal: fact ke 1 hop voi top hit. */
  graphBonus: number;
  /** He so recency 0..1 (fact moi hon thi cao hon). */
  recency: number;
  /** Diem tong sau khi cong cac thanh phan + nhan recency. */
  total: number;
}

/** 1 ket qua search. */
export interface V27SearchHit {
  fact: V27Fact;
  score: V27SearchScore;
  /** Ly do fact duoc chon (vd "entity: Huy + bm25 cao"). */
  reason: string;
  /** Fact nay den tu traversal (true) hay match truc tiep (false). */
  viaTraversal: boolean;
}

/** Input search hybrid. */
export interface V27SearchInput {
  query: string;
  /** Loc theo thoi diem: chi fact dung tai X (time-travel). */
  asOf?: string | null;
  /** Chi fact con hieu luc hien tai (mac dinh false = ca lich su). */
  currentOnly?: boolean;
  scope?: Partial<V25Scope>;
  /** So ket qua toi da (mac dinh 10, toi da 100). */
  limit?: number;
  /** Bat/tat entity boosting (mac dinh true). */
  useEntityBoost?: boolean;
  /** Bat/tat graph traversal mo rong (mac dinh true). */
  useTraversal?: boolean;
  /** Trong so BM25 (mac dinh 0.4). */
  weightBm25?: number;
  /** Trong so embedding proxy (mac dinh 0.3). */
  weightEmbedding?: number;
  /** Trong so entity boost (mac dinh 0.2). */
  weightEntity?: number;
  /** Trong so graph bonus (mac dinh 0.1). */
  weightGraph?: number;
}

/** Ket qua search day du. */
export interface V27SearchResult {
  query: string;
  hits: V27SearchHit[];
  /** So fact da xet truoc khi cat limit. */
  considered: number;
  /** Entity trong query da link duoc (de boosting). */
  queryEntities: V27EntityLink[];
  /** Thoi gian search (ms, do local). */
  elapsedMs: number;
  /** Co loc asOf khong (time-travel). */
  timeTravel: boolean;
}

// ---------------------------------------------------------------------------
// Shared block bi-temporal (Letta-style, tren nen v26)
// ---------------------------------------------------------------------------

/** 1 muc timeline cua shared block: gia tri block tai 1 khoang. */
export interface V27BlockTimelineEntry {
  id: string;
  blockId: string;
  label: string;
  /** Gia tri block trong khoang nay (Markdown/text). */
  value: string;
  /** Khoang hieu luc bat dau (ISO). */
  validFrom: string;
  /** Khoang hieu luc ket thuc (ISO, null = van hieu luc). */
  validTo: string | null;
  /** Version block v26 tuong ung. */
  version: number;
  /** Ai cap nhat (bot id / 'user'). */
  by: string;
  /** Ly do cap nhat. */
  reason: string;
  /** Fact v27 nao dan toi cap nhat nay (co the rong). */
  factIds: string[];
  /** Thoi diem ghi entry (ISO). */
  createdAt: string;
}

/** 1 muc sync log: cap nhat da toi agent attach nao. */
export interface V27BlockSyncEntry {
  id: string;
  blockId: string;
  label: string;
  /** Timeline entry da sync. */
  timelineEntryId: string;
  /** Agent nhan cap nhat. */
  agentId: string;
  /** Thoi diem sync (ISO). */
  at: string;
  /** Agent thay gia tri moi ngay (luon true: doc chung 1 store). */
  applied: boolean;
}

/** Ket qua cap nhat shared block (dong bo cho moi agent attach). */
export interface V27BlockUpdateResult {
  blockId: string;
  label: string;
  version: number;
  timelineEntry: V27BlockTimelineEntry;
  /** Cac agent attach da nhan cap nhat (cung gia tri). */
  syncedAgents: string[];
  syncEntries: V27BlockSyncEntry[];
  /** So agent attach luc cap nhat. */
  attachedCount: number;
}

/** Ket qua dang ky block v26 lam block bi-temporal v27. */
export interface V27BlockRegistration {
  blockId: string;
  label: string;
  kind: V26BlockKind;
  ownerBotId: string;
  attachedBotIds: string[];
  timelineEntries: number;
  registeredAt: string;
}

// ---------------------------------------------------------------------------
// Store / pipeline / panel
// ---------------------------------------------------------------------------

/** Cau hinh store v27. */
export interface V27StoreConfig {
  extractor?: Partial<V27ExtractorConfig>;
  /** Gioi han fact toi da (mac dinh V27_LIMITS.maxFacts). */
  maxFacts?: number;
  /** Gioi han episode toi da (mac dinh V27_LIMITS.maxEpisodes). */
  maxEpisodes?: number;
}

/** Thong ke tong hop cua store v27. */
export interface V27Stats {
  factsTotal: number;
  factsActive: number;
  factsSuperseded: number;
  factsExpired: number;
  entitiesTotal: number;
  entitiesByKind: Record<string, number>;
  episodesTotal: number;
  episodesBySource: Record<string, number>;
  sharedBlocksTotal: number;
  timelineEntriesTotal: number;
  syncEntriesTotal: number;
  /** So fact trung bi bo (add-only dedup) tu dau. */
  duplicatesSkipped: number;
  /** So edge cu bi dong do supersede tu dau. */
  edgesClosedBySupersede: number;
  /** So fact trich xuat tu dau (ke ca trung). */
  candidatesExtractedTotal: number;
}

/** Ket qua ingest 1 episode (pipeline day du). */
export interface V27IngestResult {
  episode: V27Episode;
  extraction: V27ExtractionResult;
  addedFacts: V27AddFactResult[];
  /** So fact moi that su duoc them (added=true). */
  factsAdded: number;
  /** So edge cu bi dong do supersede. */
  edgesClosed: number;
  /** Block nao duoc sync fact moi (neu co block attach). */
  syncedBlocks: string[];
}

/** Ket qua time-travel: fact + block value tai 1 thoi diem. */
export interface V27TimeTravelResult {
  at: string;
  facts: V27Fact[];
  /** Gia tri block tai X (label -> value, '' neu chua co). */
  blockValues: Record<string, string>;
  /** So fact dung tai X. */
  factsAtTime: number;
}

/** Snapshot JSON cua toan bo store v27 (export/import). */
export interface V27StoreSnapshot {
  version: string;
  exportedAt: string;
  facts: V25FactEdge[];
  entities: V27Entity[];
  episodes: V27Episode[];
  timeline: V27BlockTimelineEntry[];
  syncLog: V27BlockSyncEntry[];
  counters: {
    duplicatesSkipped: number;
    edgesClosedBySupersede: number;
    candidatesExtractedTotal: number;
  };
}

/** 1 van de nhat quan tim thay khi kiem tra store. */
export type V27HealthIssue = string;

/** Kiem tra 1 fact co dung tai thoi diem X khong (ISO). */
export function factValidAtIsoV27(fact: V25FactEdge, at: string): boolean {
  const parsed = parseIsoV25(at);
  if (!parsed) return false;
  return factValidAtV27(fact, parsed.getTime());
}
