/**
 * Memory v6 — kiểu dữ liệu (v1.05, Đội T1).
 *
 * Ý tưởng học từ Mem0 v3 (add-only store, một lần gọi LLM cho
 * extraction + consolidation, multi-scope, fused retrieval) và Letta
 * (shared memory blocks, sleep-time compute) — tự thiết kế lại hoàn
 * toàn cho open-bot, 100% local, không copy code/text/tài sản của bất
 * kỳ repo nào, kể cả của xAI/Cursor.
 *
 * Khác với memory v5 (đồ thị tri thức `memory/graph`, fact dạng
 * subject—predicate→object): v6 là kho bản ghi PHẲNG, append-only,
 * mỗi bản ghi là một mẩu text tự do + scope + entity + tag. Hai hệ
 * sống song song; `migration.ts` chuyển dữ liệu v5/long-term sang v6
 * mà không sửa kho cũ.
 *
 * NGUYÊN TẮC ADD-ONLY (cốt lõi của module này):
 *  - Ghi mới LUÔN append một bản ghi mới; không bao giờ sửa/xoá một
 *    bản ghi đã ghi tại chỗ.
 *  - "Thay thế / xoá / cách ly" chỉ là EVENT append vào nhật ký
 *    version (`V6VersionEvent`): trạng thái hiệu lực của một bản ghi
 *    được SUY RA lúc đọc bằng cách replay event (xem `versioning.ts`).
 *  - Trùng lặp CHÍNH XÁC (cùng text đã chuẩn hoá + scope + kind,
 *    đang active) thì dedupe lúc ghi — trả về bản ghi cũ, không tạo
 *    bản sao. Đây là dedupe, không phải update.
 */

import type { Embedder } from '../embeddings';

/** Mức scope — thứ tự ưu tiên mặc định khi resolve: run > agent > user > app. */
export type V6ScopeLevel = 'run' | 'agent' | 'user' | 'app';

/** Scope đầy đủ của một bản ghi v6. Chuỗi rỗng = không gắn mức đó. */
export interface V6Scope {
  /** User sở hữu ('' = legacy, thuộc user hiện tại). */
  userId: string;
  /** Bot (agent) đã ghi ('' = nhớ chung, không gắn bot). */
  agentId: string;
  /** Run đã sinh ra bản ghi ('' = không rõ run). */
  runId: string;
  /** App/workspace ('' = không gắn app, thấy ở mọi nơi). */
  appId: string;
}

/** Scope truy vấn: mức nào để trống thì không lọc theo mức đó. */
export interface V6ScopeQuery {
  userId?: string;
  agentId?: string;
  runId?: string;
  appId?: string;
}

/** Loại bản ghi v6. */
export type V6RecordKind = 'fact' | 'preference' | 'summary' | 'episode' | 'note';

/** Trạng thái HIỆU LỰC (suy ra từ event, không lưu trực tiếp). */
export type V6RecordStatus = 'active' | 'superseded' | 'retired' | 'quarantined';

/** Nguồn gốc của một bản ghi — bắt buộc, không có bản ghi "mồ côi". */
export interface V6RecordSource {
  /** 'longterm' | 'graph' | 'tool' | 'sleep' | 'migration' | 'user'. */
  type: string;
  /** Tham chiếu nguồn (id entry v5, id fact graph, tên tool, ...). */
  ref: string;
  /** Bot đã ghi (để UI hiển thị, trùng scope.agentId khi có). */
  botId?: string;
  /** Câu gốc đã rút ra bản ghi (tối đa 500 ký tự). */
  sourceText?: string;
}

/** Một bản ghi v6 — BẤT BIẾN sau khi append (chỉ event mới đổi trạng thái hiệu lực). */
export interface V6Record {
  /** Id ổn định (uuid). */
  id: string;
  /** Version trong chuỗi thay thế của cùng một key (bắt đầu từ 1). */
  version: number;
  kind: V6RecordKind;
  /** Key tuỳ chọn cho fact dạng key/value (vd "home_city") — dùng để phát hiện mâu thuẫn. */
  key?: string;
  /** Nội dung text tự do (tối đa 8000 ký tự lúc ghi). */
  text: string;
  /** Entity nhắc tới (tên đã chuẩn hoá thấp, vd ["hà nội", "mưa"]). */
  entities: string[];
  /** Tag tự do. */
  tags: string[];
  /** Độ tin cậy 0..1. */
  confidence: number;
  scope: V6Scope;
  /** Nguồn gốc bắt buộc. */
  source: V6RecordSource;
  /** Id bản ghi mà bản ghi này thay thế (chuỗi version). */
  supersedes?: string;
  /** Thời điểm ghi (ISO). */
  createdAt: string;
  /** Thời điểm ghi (= createdAt; giữ để tương thích shape v5). */
  updatedAt: string;
}

/** Bản ghi kèm trạng thái hiệu lực đã suy ra từ event (dạng trả về khi đọc). */
export interface V6RecordView extends V6Record {
  /** Trạng thái hiệu lực lúc đọc. */
  status: V6RecordStatus;
  /** Id bản ghi đã thay thế bản ghi này (khi status = superseded). */
  supersededBy?: string;
  /** Lý do của event gần nhất đổi trạng thái (khi không active). */
  statusReason?: string;
}

/** Một event version — append-only, không bao giờ sửa/xoá. */
export interface V6VersionEvent {
  /** Số thứ tự tăng dần trong nhật ký (bắt đầu từ 1). */
  seq: number;
  type: 'supersede' | 'retire' | 'quarantine' | 'restore';
  /** Id bản ghi bị tác động. */
  targetId: string;
  /** Id bản ghi thay thế (chỉ cho supersede). */
  byId?: string;
  /** Lý do (bắt buộc với retire/quarantine, để audit). */
  reason: string;
  /** Ai thực hiện ('user' | 'sleep' | 'tool:memory_v6_*' | botId). */
  actor: string;
  /** Thời điểm event (ISO). */
  at: string;
}

/** Input khi append một bản ghi mới. */
export interface V6AppendInput {
  kind?: V6RecordKind;
  key?: string;
  text: string;
  entities?: string[];
  tags?: string[];
  confidence?: number;
  scope: V6Scope;
  source: V6RecordSource;
  /** Id bản ghi mà bản ghi mới này thay thế (tạo chuỗi version). */
  supersedes?: string;
}

/** Bucket thời gian của một bản ghi lúc truy vấn. */
export type V6TemporalBucket = 'today' | 'this_week' | 'this_month' | 'older';

/** Phân loại thời gian của một bản ghi. */
export interface V6TemporalClass {
  bucket: V6TemporalBucket;
  /** Tuổi tính bằng ngày (số thực, >= 0). */
  ageDays: number;
  /** Hệ số decay recency 0..1 (1 = vừa ghi, -> 0 khi rất cũ). */
  recencyDecay: number;
}

/** Trọng số fused retrieval — tổng 3 nguồn = 1 (được chuẩn hoá khi dùng). */
export interface V6FusedWeights {
  /** Trọng số semantic (embedding, fallback TF-IDF). */
  semantic: number;
  /** Trọng số BM25 (từ khoá). */
  bm25: number;
  /** Trọng số entity match. */
  entity: number;
}

/** Trọng số mặc định: semantic nặng nhất, BM25 giữa, entity bổ trợ. */
export const DEFAULT_V6_FUSED_WEIGHTS: V6FusedWeights = {
  semantic: 0.45,
  bm25: 0.35,
  entity: 0.2,
};

/** Thứ tự ưu tiên scope mặc định khi resolve: hẹp thắng rộng. */
export const DEFAULT_V6_SCOPE_PRIORITY: V6ScopeLevel[] = ['run', 'agent', 'user', 'app'];

/** Half-life mặc định cho recency decay (ngày): sau 30 ngày còn 0.5. */
export const DEFAULT_V6_RECENCY_HALF_LIFE_DAYS = 30;

/** Text tối đa (ký tự) của một bản ghi v6 lúc ghi. */
export const V6_MAX_TEXT_CHARS = 8000;

/** Source text tối đa (ký tự) lưu kèm bản ghi. */
export const V6_MAX_SOURCE_TEXT_CHARS = 500;

/** Giải thích điểm số của một hit fused retrieval (để debug). */
export interface V6ScoreBreakdown {
  /** Điểm semantic 0..1 (cosine; TF-IDF khi không có embedding). */
  semantic: number;
  /** Nguồn đã dùng cho điểm semantic. */
  semanticSource: 'embedding' | 'tfidf';
  /** Điểm BM25 đã chuẩn hoá 0..1. */
  bm25: number;
  /** Điểm entity match 0..1. */
  entity: number;
  /** Hệ số boost theo độ hẹp của scope (run cao nhất). */
  scopeBoost: number;
  /** Hệ số recency decay 0..1. */
  recencyDecay: number;
  /** Điểm cuối = (wS*sem + wB*bm25 + wE*ent) * scopeBoost * recencyDecay. */
  final: number;
}

/** Một hit của fused retrieval. */
export interface V6FusedHit {
  record: V6RecordView;
  /** Mức scope mà hit này thuộc về (để UI giải thích "nhớ ở mức nào"). */
  scopeLevel: V6ScopeLevel;
  /** Phân loại thời gian lúc truy vấn. */
  temporal: V6TemporalClass;
  breakdown: V6ScoreBreakdown;
}

/** Tuỳ chọn fused retrieval. */
export interface V6FusedOptions {
  scope?: V6ScopeQuery;
  /** Thứ tự ưu tiên scope (mặc định run > agent > user > app). */
  scopePriority?: V6ScopeLevel[];
  weights?: Partial<V6FusedWeights>;
  /** Số hit tối đa (mặc định 10, tối đa 50). */
  topK?: number;
  /** Half-life recency (ngày, mặc định 30). */
  recencyHalfLifeDays?: number;
  /** Embedder cho nguồn semantic (mặc định: TF-IDF, không gọi mạng). */
  embedder?: Embedder;
  /** Chỉ lấy bản ghi active (mặc định true). */
  activeOnly?: boolean;
  /** Lọc theo kind. */
  kinds?: V6RecordKind[];
  /** Bỏ qua nguồn semantic khi embedder lỗi (mặc định true = fail-open). */
  skipSemanticOnError?: boolean;
  /** "Bây giờ" (để test; mặc định new Date()). */
  now?: Date;
}

/** Quyền trên một shared block. */
export type V6BlockPermission = 'read' | 'write';

/** ACL của một shared block: botId -> quyền. Owner luôn có write. */
export type V6BlockAcl = Record<string, V6BlockPermission>;

/** Một memory block chia sẻ giữa các bot trong fleet (kiểu Letta). */
export interface V6SharedBlock {
  /** Id ổn định. */
  id: string;
  /** Tên block (duy nhất trong store, vd "team-preferences"). */
  name: string;
  /** Nội dung text của block. */
  content: string;
  /** Bot sở hữu block. */
  ownerBotId: string;
  /** Version tăng dần mỗi lần update (update = append version mới vào history). */
  version: number;
  /** ACL: bot nào được đọc/ghi (owner không cần có mặt ở đây). */
  acl: V6BlockAcl;
  /** Lịch sử version (append-only, mỗi phần tử là một snapshot nội dung). */
  history: V6BlockVersion[];
  createdAt: string;
  updatedAt: string;
}

/** Một snapshot version của shared block. */
export interface V6BlockVersion {
  version: number;
  content: string;
  actorBotId: string;
  at: string;
  reason?: string;
}

/** Event đồng bộ của shared block (để bot subscribe nhận thay đổi). */
export interface V6BlockSyncEvent {
  /** Số thứ tự tăng dần (bắt đầu từ 1). */
  seq: number;
  type: 'created' | 'updated' | 'shared' | 'unshared' | 'deleted';
  blockId: string;
  blockName: string;
  /** Version mới của block (khi updated). */
  version?: number;
  /** Bot liên quan tới event (người share/unshare, người update). */
  actorBotId: string;
  /** Bot được cấp/thu quyền (khi shared/unshared). */
  targetBotId?: string;
  at: string;
}

/** Cấu hình sleep-time compute v6. */
export interface V6SleepConfig {
  /** Bật/tắt scheduler (mặc định false — host bật tường minh). */
  enabled: boolean;
  /** Chạy khi rảnh ít nhất từng này ms kể từ hoạt động cuối (mặc định 5 phút). */
  idleMs: number;
  /** Chu kỳ kiểm tra rảnh (mặc định 60 giây). */
  checkIntervalMs: number;
  /** Tối đa số bản ghi xem xét trong một lần chạy (mặc định 500). */
  maxRecordsPerRun: number;
  /** Ngân sách thời gian một lần chạy (ms, mặc định 30 giây). */
  maxMsPerRun: number;
  /** Chỉ tóm tắt cụm có bản ghi cũ hơn từng này ngày (mặc định 30). */
  summarizeOlderThanDays: number;
  /** Cụm cần ít nhất từng này bản ghi mới tóm tắt (mặc định 3). */
  minClusterSize: number;
  /** Tóm tắt tối đa từng này ký tự (mặc định 2000). */
  maxSummaryChars: number;
  /** Ngưỡng Jaccard cho near-dup (mặc định 0.8). */
  nearDupJaccard: number;
}

/** Cấu hình mặc định của sleep-time compute v6. */
export const DEFAULT_V6_SLEEP_CONFIG: V6SleepConfig = {
  enabled: false,
  idleMs: 5 * 60_000,
  checkIntervalMs: 60_000,
  maxRecordsPerRun: 500,
  maxMsPerRun: 30_000,
  summarizeOlderThanDays: 30,
  minClusterSize: 3,
  maxSummaryChars: 2000,
  nearDupJaccard: 0.8,
};

/** Báo cáo một lần chạy sleep-time compute v6. */
export interface V6SleepRunReport {
  /** Id lần chạy (uuid). */
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** Thời gian chạy (ms). */
  durationMs: number;
  /** Số bản ghi đã xem xét. */
  examined: number;
  /** Số bản ghi trùng chính xác đã retire. */
  dedupedExact: number;
  /** Số bản ghi near-dup đã retire. */
  dedupedNear: number;
  /** Số cụm cũ đã tóm tắt thành bản ghi tổng hợp. */
  summarizedClusters: number;
  /** Số bản ghi tổng hợp đã append. */
  summaryRecords: number;
  /** Số bản ghi mâu thuẫn đã quarantine. */
  quarantined: number;
  /** Số bản ghi đã supersede trong lúc tóm tắt. */
  superseded: number;
  /** true khi dừng sớm vì hết ngân sách (chưa làm hết). */
  stoppedByBudget: boolean;
  /** Lỗi gặp trong lúc chạy (không fail cả lần chạy). */
  errors: string[];
}

/** Thống kê kho v6 (cho tool memory_v6_stats + dashboard). */
export interface V6StoreStats {
  totalRecords: number;
  activeRecords: number;
  supersededRecords: number;
  retiredRecords: number;
  quarantinedRecords: number;
  byKind: Record<V6RecordKind, number>;
  byBucket: Record<V6TemporalBucket, number>;
  byScopeLevel: Record<V6ScopeLevel, number>;
  totalEvents: number;
  /** Bản ghi mới nhất (ISO) hoặc null khi kho rỗng. */
  newestAt: string | null;
  /** Bản ghi cũ nhất (ISO) hoặc null khi kho rỗng. */
  oldestAt: string | null;
}

/** Báo cáo migration v5/long-term -> v6. */
export interface V6MigrationReport {
  /** Nguồn migration ('longterm' | 'graph'). */
  source: string;
  /** Số entry/fact đã đọc từ nguồn. */
  read: number;
  /** Số bản ghi v6 đã append. */
  migrated: number;
  /** Số bản ghi bỏ qua vì đã có bản giống hệt trong v6. */
  skippedDuplicate: number;
  /** Số bản ghi bỏ qua vì thiếu dữ liệu (vd text rỗng). */
  skippedInvalid: number;
  /** Lỗi từng mục (không fail cả lần migration). */
  errors: string[];
}

/** Chuẩn hoá text để dedupe/so sánh: lowercase, gọn khoảng trắng. */
export function normalizeV6Text(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Chuẩn hoá một entity/tag: lowercase, gọn khoảng trắng, bỏ rỗng. */
export function normalizeV6Token(token: string): string {
  return token.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Scope rỗng (không gắn mức nào) — dùng làm mặc định. */
export function emptyV6Scope(): V6Scope {
  return { userId: '', agentId: '', runId: '', appId: '' };
}

/** Gộp scope từng phần thành scope đầy đủ (thiếu -> ''). */
export function toV6Scope(partial: V6ScopeQuery | V6Scope): V6Scope {
  return {
    userId: partial.userId ?? '',
    agentId: partial.agentId ?? '',
    runId: partial.runId ?? '',
    appId: partial.appId ?? '',
  };
}
