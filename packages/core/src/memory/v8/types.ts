/**
 * Memory v8 — kiểu dữ liệu (v1.07, Đội T1).
 *
 * Ý tưởng học từ tài liệu công khai (docs/repo-survey-v107.md §4):
 *  - Mem0 v3: fused retrieval nhiều tín hiệu, extraction add-only.
 *  - Letta: sleep-time compute (consolidation lúc idle) + shared
 *    memory block xuyên fleet/bot.
 *  - Zep/Graphiti: temporal knowledge graph, hybrid search.
 *  - OWASP ASI06 Memory & Context Poisoning: memory là bề mặt tấn
 *    công — ghi nguồn gốc mỗi fact, nghi ngờ fact mâu thuẫn, cho
 *    user duyệt/xóa; xóa theo yêu cầu kiểu GDPR.
 *
 * Tự thiết kế lại hoàn toàn cho open-bot, 100% local, không copy
 * code/text/tài sản của bất kỳ repo nào, kể cả của xAI/Cursor.
 *
 * v8 NỐI TIẾP v6/v7, không viết lại:
 *  - Kho bản ghi vẫn là V6RecordStore (add-only) + V7 git blocks.
 *  - Sleep v8 = policy bền + scheduler bọc SleepV6Scheduler, thêm
 *    bước nén block cũ (block-level compression) và dry-run preview.
 *  - Fleet v8 = gói đồng bộ (sync packet) trên SharedBlockStore v6:
 *    version vector + merge có phát hiện xung đột.
 *  - Retrieval v8 = fused 3 tín hiệu LOCAL (keyword BM25 + entity +
 *    recency), KHÔNG embedding, KHÔNG gọi mạng — API không có tham
 *    số embedder nên không thể rò embedding ra ngoài.
 *  - Provenance v8 = chuỗi bằng chứng (evidence chain) + registry
 *    độ tin cậy theo nguồn (user điều chỉnh được).
 *  - Poisoning v8 = hàng đợi duyệt (review queue) + phát hiện burst
 *    (một nguồn ghi ồ ạt) + cụm mâu thuẫn xuyên scope.
 *  - Erasure v8 = xóa theo yêu cầu (GDPR): export trước khi xóa,
 *    scrub text + retire bản ghi, xóa block, audit log, verify.
 *
 * KHÔNG TUYÊN BỐ ĐIỂM BENCHMARK: open-bot không chạy harness công
 * khai nào cho memory v8, nên module này không công bố điểm
 * LoCoMo/LongMemEval hay bất kỳ điểm benchmark nào. Mọi con số trong
 * doc/test là số đo nội bộ trên fixture (đếm được, tái lập được),
 * không phải benchmark bên ngoài. Xem `V8_NO_BENCHMARK_CLAIM`.
 */

/** Tuyên bố rõ trong code: không có điểm benchmark nào được công bố. */
export const V8_NO_BENCHMARK_CLAIM =
  'Memory v8 không công bố điểm benchmark (LoCoMo/LongMemEval/...) vì chưa tự chạy harness công khai nào. ' +
  'Mọi con số trong module này là số đo nội bộ trên fixture, không phải benchmark bên ngoài.';

/* ------------------------------------------------------------------ */
/* Provenance v8 — nguồn gốc + chuỗi bằng chứng của một fact          */
/* ------------------------------------------------------------------ */

/** Loại nguồn gốc của một fact v8 (mở rộng từ ProvenanceSourceKind). */
export type V8SourceKind =
  | 'user'
  | 'bot'
  | 'tool'
  | 'import'
  | 'system'
  | 'sleep'
  | 'fleet';

/** Một mắt xích trong chuỗi bằng chứng của fact. */
export interface V8EvidenceLink {
  /** Loại bằng chứng: 'chat' | 'tool-result' | 'file' | 'summary' | 'sync' | 'user-confirm'. */
  kind: string;
  /** Tham chiếu ổn định: id chat, tên tool, tên file, id gói sync... */
  ref: string;
  /** Ghi chú ngắn (tối đa 200 ký tự). */
  note?: string;
  /** Thời điểm bằng chứng (ISO). */
  at: string;
}

/** Provenance đầy đủ của một fact/bản ghi v8. */
export interface V8FactProvenance {
  /** Id bản ghi v6 (hoặc id block v7) mà provenance này mô tả. */
  recordId: string;
  /** Loại nguồn gốc. */
  sourceKind: V8SourceKind;
  /** Nguồn chi tiết: tên tool, tên file import, bot id, ... */
  origin: string;
  /** Bot đã ghi fact ('' = không gắn bot). */
  botId: string;
  /** User sở hữu fact ('' = không rõ). */
  userId: string;
  /** Thời điểm ghi fact (ISO). */
  recordedAt: string;
  /** Độ tin cậy 0..1 lúc ghi (xem provenance.ts). */
  trust: number;
  /** Chuỗi bằng chứng (cũ nhất trước). */
  evidence: V8EvidenceLink[];
  /** Flag nghi ngờ lúc ghi (mã từ detectSuspiciousContent). */
  flags: string[];
  /** true khi fact đang bị quarantine chờ duyệt. */
  quarantined: boolean;
}

/** Một nguồn gốc trong registry độ tin cậy (user điều chỉnh được). */
export interface V8SourceTrustEntry {
  /** Khóa nguồn: vd 'tool:memory_v6_append', 'import:notes.md', 'bot:researcher'. */
  sourceKey: string;
  /** Độ tin cậy cơ sở 0..1 do user đặt (mặc định theo loại nguồn). */
  baseTrust: number;
  /** Số fact đã ghi từ nguồn này (đếm tích lũy). */
  factCount: number;
  /** Số fact từ nguồn này đã bị flag/quarantine. */
  flaggedCount: number;
  /** Ghi chú của user (vd lý do hạ trust). */
  note?: string;
  /** Lần cập nhật cuối (ISO). */
  updatedAt: string;
}

/** File registry độ tin cậy nguồn v8 trên đĩa. */
export interface V8SourceTrustFile {
  version: 1;
  entries: V8SourceTrustEntry[];
}

/* ------------------------------------------------------------------ */
/* Poisoning v8 — hàng đợi duyệt + phát hiện burst/mâu thuẫn          */
/* ------------------------------------------------------------------ */

/** Lý do một fact bị đưa vào hàng đợi duyệt. */
export type V8ReviewReason =
  | 'suspicious-content'
  | 'contradiction'
  | 'burst-source'
  | 'low-trust-source'
  | 'manual';

/** Trạng thái một mục trong hàng đợi duyệt. */
export type V8ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** Một mục chờ user duyệt trong hàng đợi chống poisoning. */
export interface V8ReviewItem {
  /** Id mục duyệt (uuid). */
  id: string;
  /** Id bản ghi v6 (hoặc id block) bị nghi ngờ. */
  recordId: string;
  /** Text fact (cắt 500 ký tự để UI hiển thị). */
  textPreview: string;
  /** Lý do đưa vào hàng đợi. */
  reason: V8ReviewReason;
  /** Chi tiết: mã flag, key mâu thuẫn, nguồn burst... */
  detail: string;
  /** Độ tin cậy của fact lúc bị flag (0..1). */
  trustAtFlag: number;
  /** Nguồn gốc fact (khóa nguồn trong registry). */
  sourceKey: string;
  /** Trạng thái duyệt. */
  status: V8ReviewStatus;
  /** Thời điểm đưa vào hàng đợi (ISO). */
  createdAt: string;
  /** Ai quyết định ('' khi chưa quyết). */
  decidedBy?: string;
  /** Thời điểm quyết định (ISO). */
  decidedAt?: string;
  /** Ghi chú của người duyệt. */
  decisionNote?: string;
}

/** File hàng đợi duyệt v8 trên đĩa. */
export interface V8ReviewQueueFile {
  version: 1;
  items: V8ReviewItem[];
}

/** Một cụm mâu thuẫn xuyên scope (cùng key, giá trị khác nhau). */
export interface V8ContradictionCluster {
  /** Key chuẩn hoá gây mâu thuẫn. */
  key: string;
  /** Các bản ghi trong cụm (id + giá trị + scope + trust). */
  members: Array<{
    recordId: string;
    value: string;
    scopeLabel: string;
    trust: number;
    recordedAt: string;
  }>;
  /** Số giá trị khác nhau trong cụm. */
  distinctValues: number;
  /** Id bản ghi mạnh nhất (trust cao nhất, hoà thì mới nhất). */
  strongestId: string;
}

/** Kết quả phát hiện burst: một nguồn ghi ồ ạt trong cửa sổ ngắn. */
export interface V8BurstFinding {
  /** Khóa nguồn gây burst. */
  sourceKey: string;
  /** Số fact ghi trong cửa sổ. */
  count: number;
  /** Cửa sổ tính bằng phút. */
  windowMinutes: number;
  /** Ngưỡng đã vượt. */
  threshold: number;
  /** Thời điểm fact đầu tiên trong burst (ISO). */
  firstAt: string;
  /** Thời điểm fact cuối cùng trong burst (ISO). */
  lastAt: string;
}

/** Báo cáo quét poisoning trên toàn kho (đọc, không sửa gì). */
export interface V8PoisoningScanReport {
  /** Thời điểm quét (ISO). */
  scannedAt: string;
  /** Số bản ghi active đã quét. */
  scanned: number;
  /** Số fact có nội dung nghi ngờ. */
  suspicious: number;
  /** Số cụm mâu thuẫn tìm thấy. */
  contradictionClusters: number;
  /** Số burst phát hiện. */
  bursts: number;
  /** Chi tiết cụm mâu thuẫn (tối đa 20). */
  clusters: V8ContradictionCluster[];
  /** Chi tiết burst (tối đa 20). */
  burstFindings: V8BurstFinding[];
  /** Id bản ghi nghi ngờ (tối đa 50). */
  suspiciousIds: string[];
}

/* ------------------------------------------------------------------ */
/* Retrieval v8 — fused 3 tín hiệu LOCAL (keyword + entity + recency) */
/* ------------------------------------------------------------------ */

/** Trọng số fused v8 — tổng 3 nguồn = 1 (được chuẩn hoá khi dùng). */
export interface V8LocalWeights {
  /** Trọng số keyword BM25. */
  keyword: number;
  /** Trọng số entity match. */
  entity: number;
  /** Trọng số recency (độ mới theo thời gian). */
  recency: number;
}

/** Trọng số mặc định: keyword nặng nhất, entity giữa, recency bổ trợ. */
export const DEFAULT_V8_LOCAL_WEIGHTS: V8LocalWeights = {
  keyword: 0.5,
  entity: 0.3,
  recency: 0.2,
};

/** Half-life mặc định cho điểm recency v8 (ngày): sau 30 ngày còn 0.5. */
export const DEFAULT_V8_RECENCY_HALF_LIFE_DAYS = 30;

/** Điểm tối đa của topK (mặc định 10, trần 50). */
export const V8_LOCAL_DEFAULT_TOP_K = 10;
export const V8_LOCAL_MAX_TOP_K = 50;

/** Giải thích điểm số của một hit retrieval v8 (để debug/UI). */
export interface V8LocalScoreBreakdown {
  /** Điểm keyword BM25 đã chuẩn hoá 0..1. */
  keyword: number;
  /** Điểm entity match 0..1. */
  entity: number;
  /** Điểm recency 0..1 (1 = vừa ghi). */
  recency: number;
  /** Điểm cuối = wK*keyword + wE*entity + wR*recency (0..1). */
  final: number;
}

/** Một hit của retrieval v8. */
export interface V8LocalHit {
  /** Id bản ghi v6. */
  recordId: string;
  /** Nội dung text của bản ghi. */
  text: string;
  /** Kind của bản ghi. */
  kind: string;
  /** Nhãn scope đọc được (vd "user:u1 / agent:bot-a"). */
  scopeLabel: string;
  /** Độ tin cậy của bản ghi. */
  confidence: number;
  /** Tuổi tính bằng ngày. */
  ageDays: number;
  /** Điểm từng tín hiệu + điểm cuối. */
  breakdown: V8LocalScoreBreakdown;
}

/** Tuỳ chọn retrieval v8. */
export interface V8LocalOptions {
  /** Lọc theo userId ('' = không lọc). */
  userId?: string;
  /** Lọc theo agentId ('' = không lọc). */
  agentId?: string;
  /** Lọc theo kind. */
  kinds?: string[];
  /** Trọng số từng tín hiệu (được chuẩn hoá về tổng = 1). */
  weights?: Partial<V8LocalWeights>;
  /** Số hit tối đa (mặc định 10, tối đa 50). */
  topK?: number;
  /** Half-life recency (ngày, mặc định 30). */
  recencyHalfLifeDays?: number;
  /** Chỉ lấy bản ghi active (mặc định true). */
  activeOnly?: boolean;
  /** "Bây giờ" (để test; mặc định new Date()). */
  now?: Date;
}

/* ------------------------------------------------------------------ */
/* Sleep v8 — policy bền + scheduler bọc sleep v6 + nén block         */
/* ------------------------------------------------------------------ */

/** Giờ yên lặng trong ngày (không chạy sleep dù đang rảnh). */
export interface V8QuietHours {
  /** Giờ bắt đầu (0..23, giờ địa phương của máy). */
  startHour: number;
  /** Giờ kết thúc (0..23). startHour == endHour = không có giờ yên lặng. */
  endHour: number;
}

/** Policy sleep-time compute v8 (lưu bền trong workspace). */
export interface V8SleepPolicy {
  /** Bật/tắt sleep compute v8 (mặc định false — host bật tường minh). */
  enabled: boolean;
  /** Chạy khi rảnh ít nhất từng này ms kể từ hoạt động cuối (mặc định 5 phút). */
  idleMs: number;
  /** Chu kỳ kiểm tra rảnh (mặc định 60 giây). */
  checkIntervalMs: number;
  /** Giờ yên lặng (mặc định không có). */
  quietHours: V8QuietHours;
  /** Tối đa số lần chạy mỗi ngày (mặc định 24; 0 = không giới hạn). */
  maxRunsPerDay: number;
  /** Chỉ nén block cũ hơn từng này ngày (mặc định 30). */
  compressBlocksOlderThanDays: number;
  /** Cụm block cần ít nhất từng này block mới nén (mặc định 2). */
  minBlocksToCompress: number;
  /** Nén tối đa từng này block trong một lần chạy (mặc định 20). */
  maxBlocksPerRun: number;
}

/** Policy mặc định của sleep v8. */
export const DEFAULT_V8_SLEEP_POLICY: V8SleepPolicy = {
  enabled: false,
  idleMs: 5 * 60_000,
  checkIntervalMs: 60_000,
  quietHours: { startHour: 0, endHour: 0 },
  maxRunsPerDay: 24,
  compressBlocksOlderThanDays: 30,
  minBlocksToCompress: 2,
  maxBlocksPerRun: 20,
};

/** File policy sleep v8 trên đĩa. */
export interface V8SleepPolicyFile {
  version: 1;
  policy: V8SleepPolicy;
}

/** Một block cũ được chọn để nén trong lần chạy sleep v8. */
export interface V8BlockCompressionCandidate {
  /** Label block v7. */
  label: string;
  /** Tier hiện tại. */
  tier: string;
  /** Scope hiện tại. */
  scope: string;
  /** Tuổi tính bằng ngày. */
  ageDays: number;
  /** Số ký tự nội dung. */
  chars: number;
}

/** Kế hoạch nén block (dry-run): chưa ghi gì cả. */
export interface V8BlockCompressionPlan {
  /** Số block cũ đủ điều kiện nén. */
  candidates: V8BlockCompressionCandidate[];
  /** Số cụm nén sẽ tạo (gom theo tier + scope). */
  clusters: number;
  /** Label các block tóm tắt sẽ tạo. */
  summaryLabels: string[];
  /** Tổng số ký tự sẽ nén vào block tóm tắt. */
  totalChars: number;
}

/** Báo cáo một lần chạy sleep v8 (bọc báo cáo v6 + phần block). */
export interface V8SleepRunReport {
  /** Id lần chạy (uuid). */
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** Thời gian chạy (ms). */
  durationMs: number;
  /** Báo cáo consolidation v6 (dedupe/summary/quarantine bản ghi). */
  v6: {
    examined: number;
    dedupedExact: number;
    dedupedNear: number;
    summarizedClusters: number;
    summaryRecords: number;
    quarantined: number;
    superseded: number;
    stoppedByBudget: boolean;
    errors: string[];
  };
  /** Số block cũ đã nén thành block tóm tắt. */
  blocksCompressed: number;
  /** Số block tóm tắt đã tạo. */
  summaryBlocksCreated: number;
  /** true khi dừng sớm vì hết ngân sách ngày (maxRunsPerDay). */
  stoppedByDailyBudget: boolean;
  /** true khi lần chạy này là dry-run (không ghi gì). */
  dryRun: boolean;
  /** Lỗi gặp trong lúc chạy (không fail cả lần chạy). */
  errors: string[];
}

/** File ledger các lần chạy sleep v8 trên đĩa. */
export interface V8SleepLedgerFile {
  version: 1;
  runs: V8SleepRunReport[];
}

/* ------------------------------------------------------------------ */
/* Fleet v8 — gói đồng bộ shared block xuyên fleet/bot                */
/* ------------------------------------------------------------------ */

/** Vector version của một block: botId -> version cao nhất đã thấy. */
export type V8VersionVector = Record<string, number>;

/** Một block trong gói đồng bộ fleet. */
export interface V8FleetBlockPacket {
  /** Id block v6. */
  blockId: string;
  /** Tên block. */
  name: string;
  /** Nội dung block lúc export. */
  content: string;
  /** Version của block lúc export. */
  version: number;
  /** Bot sở hữu block. */
  ownerBotId: string;
  /** ACL lúc export (botId -> quyền). */
  acl: Record<string, string>;
  /** Version vector của block lúc export. */
  vector: V8VersionVector;
  /** Thời điểm export (ISO). */
  exportedAt: string;
}

/** Gói đồng bộ fleet v8 (file JSON, mang đi máy khác được). */
export interface V8FleetSyncPacket {
  /** Định dạng gói. */
  format: 'open-bot-fleet-sync-v8';
  /** Version định dạng. */
  version: 1;
  /** Id gói (uuid). */
  packetId: string;
  /** Bot đã export gói. */
  fromBotId: string;
  /** Thời điểm export (ISO). */
  exportedAt: string;
  /** Các block trong gói. */
  blocks: V8FleetBlockPacket[];
}

/** Một xung đột khi merge gói fleet (cả hai bên cùng sửa một block). */
export interface V8FleetConflict {
  /** Id block xung đột. */
  blockId: string;
  /** Tên block. */
  name: string;
  /** Version phía local lúc merge. */
  localVersion: number;
  /** Version trong gói lúc merge. */
  incomingVersion: number;
  /** Cách giải quyết: 'kept-local' (giữ local, ghi log) — v8 không tự ghi đè. */
  resolution: 'kept-local';
  /** Thời điểm phát hiện (ISO). */
  detectedAt: string;
}

/** Báo cáo merge một gói fleet vào store local. */
export interface V8FleetMergeReport {
  /** Id gói đã merge. */
  packetId: string;
  /** Bot đã export gói. */
  fromBotId: string;
  /** Số block đã import mới. */
  imported: number;
  /** Số block đã cập nhật (incoming mới hơn local, không xung đột). */
  updated: number;
  /** Số block bỏ qua (local đã mới hơn hoặc bằng). */
  skipped: number;
  /** Số xung đột (giữ local, cần user quyết sau). */
  conflicts: V8FleetConflict[];
  /** Lỗi từng block (không fail cả lần merge). */
  errors: string[];
  /** Thời điểm merge (ISO). */
  mergedAt: string;
}

/** Trạng thái đồng bộ fleet của một workspace (đọc, không sửa). */
export interface V8FleetSyncStatus {
  /** Số shared block local. */
  localBlocks: number;
  /** Bot có block trong workspace này. */
  botIds: string[];
  /** Block mới nhất (ISO) hoặc null khi chưa có block nào. */
  newestBlockAt: string | null;
  /** Số event đồng bộ đã ghi trong nhật ký v6. */
  eventCount: number;
  /** Số xung đột đang chờ user quyết (đọc từ file conflict log). */
  pendingConflicts: number;
}

/** File log xung đột fleet v8 trên đĩa. */
export interface V8FleetConflictLogFile {
  version: 1;
  conflicts: V8FleetConflict[];
}

/* ------------------------------------------------------------------ */
/* Erasure v8 — xóa theo yêu cầu kiểu GDPR                            */
/* ------------------------------------------------------------------ */

/** Phạm vi xóa của một yêu cầu erasure. */
export type V8ErasureScope = 'all' | 'records' | 'blocks' | 'shared-blocks';

/** Một yêu cầu xóa theo user. */
export interface V8ErasureRequest {
  /** Id yêu cầu (uuid). */
  id: string;
  /** User yêu cầu xóa. */
  userId: string;
  /** Phạm vi xóa. */
  scope: V8ErasureScope;
  /** Lý do (vd "user yêu cầu xóa dữ liệu", "GDPR Article 17"). */
  reason: string;
  /** Ai yêu cầu ('user' hoặc bot id). */
  requestedBy: string;
  /** Thời điểm yêu cầu (ISO). */
  requestedAt: string;
}

/** Kết quả xóa một hạng mục trong yêu cầu erasure. */
export interface V8ErasureItemResult {
  /** Hạng mục: 'v6-records' | 'v7-blocks' | 'shared-blocks' | 'provenance-log' | 'sleep-log'. */
  category: string;
  /** Số mục đã xóa/scrub. */
  erased: number;
  /** Số mục bỏ qua (không thuộc user). */
  skipped: number;
  /** Lỗi từng mục (không fail cả lần xóa). */
  errors: string[];
}

/** Báo cáo hoàn tất một yêu cầu xóa (để trả cho user + audit). */
export interface V8ErasureReport {
  /** Id yêu cầu. */
  requestId: string;
  /** User đã xóa. */
  userId: string;
  /** Phạm vi đã xóa. */
  scope: V8ErasureScope;
  /** Thời điểm bắt đầu / kết thúc (ISO). */
  startedAt: string;
  finishedAt: string;
  /** Kết quả từng hạng mục. */
  results: V8ErasureItemResult[];
  /** Tổng số mục đã xóa/scrub. */
  totalErased: number;
  /** true khi bước verify sau xóa xác nhận không còn dữ liệu của user. */
  verified: boolean;
  /** Chi tiết verify (vd bản ghi nào còn sót, rỗng khi sạch). */
  verifyFindings: string[];
}

/** Một dòng audit log xóa (append-only JSONL). */
export interface V8ErasureAuditEntry {
  /** Id yêu cầu xóa. */
  requestId: string;
  /** User đã xóa. */
  userId: string;
  /** Phạm vi đã xóa. */
  scope: V8ErasureScope;
  /** Tổng số mục đã xóa/scrub. */
  totalErased: number;
  /** true khi verify sau xóa sạch. */
  verified: boolean;
  /** Ai yêu cầu. */
  requestedBy: string;
  /** Thời điểm hoàn tất (ISO). */
  at: string;
}

/** Gói export dữ liệu của user trước khi xóa (quyền portability). */
export interface V8UserDataExport {
  /** Định dạng gói. */
  format: 'open-bot-user-data-v8';
  /** Version định dạng. */
  version: 1;
  /** User được export. */
  userId: string;
  /** Thời điểm export (ISO). */
  exportedAt: string;
  /** Bản ghi v6 của user (đã scrub secret? KHÔNG — export đầy đủ cho chính user). */
  records: Array<Record<string, unknown>>;
  /** Block v7 của user. */
  blocks: Array<Record<string, unknown>>;
  /** Shared block do user/bot của user sở hữu. */
  sharedBlocks: Array<Record<string, unknown>>;
}
