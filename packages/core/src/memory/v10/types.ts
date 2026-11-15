/**
 * Memory v10 — kiểu dữ liệu (v1.10, Đội T1).
 *
 * Hợp nhất 3 ý tưởng đã nghiên cứu (xem docs/repo-survey-v110.md §3,
 * chỉ học ý tưởng, tự thiết kế lại hoàn toàn):
 *  - Mem0: pipeline extraction → consolidation (add / update / delete
 *    khi mâu thuẫn / drop noise) + retrieval 3 tín hiệu.
 *  - Zep/Graphiti: bi-temporal knowledge graph — mỗi fact mang validity
 *    window (đúng trong thế giới từ–đến khi nào) + thời điểm hệ thống
 *    học được nó; fact mâu thuẫn làm edge cũ invalid thay vì ghi đè.
 *  - Letta Code: memory block là artifact version được — commit /
 *    branch / rollback.
 *  - CoALA: 4 loại memory — working / episodic / semantic / procedural —
 *    mỗi loại store + lifecycle riêng, hợp nhất trong MemoryManagerV10.
 *
 * Chạy 100% local, không gọi model ngoài: extraction luật xác định
 * (tái dùng RuleBasedFactExtractor của graph v0.98) + embedding hash
 * nội bộ (xem localEmbedding.ts). Mọi fact đều có provenance bắt buộc
 * về episode đã sinh ra nó, như graph v0.98.
 */

import type { MemoryScope } from '../graph/types';

/** 4 loại memory theo khung CoALA. */
export type CoalaKind = 'working' | 'episodic' | 'semantic' | 'procedural';

/** Trạng thái vòng đời của một fact v10. */
export type V10FactStatus = 'active' | 'superseded' | 'deleted' | 'quarantined';

/**
 * Một fact v10 — đơn vị semantic memory.
 *
 * Bi-temporal: `validFrom`/`validUntil` nói fact ĐÚNG trong khoảng
 * nào của thế giới thật; `learnedAt` nói hệ thống HỌC được nó lúc
 * nào. Hai trục độc lập: một fact có thể được học hôm nay nhưng chỉ
 * đúng từ tháng 3 ("từ tháng 3 tôi sống ở Đà Nẵng"), và một fact có
 * thể đúng tới nay nhưng đã bị thay thế bởi fact mới học được.
 * Fact cũ KHÔNG bị xoá khi mâu thuẫn: nó bị đóng cửa sổ hiệu lực
 * (`validUntil` = lúc thay thế) và chuyển trạng thái `superseded`,
 * trỏ `supersededBy` sang fact mới — lịch sử vẫn truy vấn được.
 */
export interface V10Fact {
  id: string;
  /** Tên chủ ngữ đã chuẩn hoá (vd "user"). */
  subject: string;
  /** Vị ngữ đã chuẩn hoá (tập ALLOWED_PREDICATES của graph). */
  predicate: string;
  /** Tân ngữ dạng text. */
  object: string;
  /** Fact đúng từ lúc nào trong thế giới thật (ISO). */
  validFrom: string;
  /** Fact hết đúng lúc nào (null = vẫn đúng tới nay). */
  validUntil: string | null;
  /** Thời điểm hệ thống học được fact này (ISO, transaction time). */
  learnedAt: string;
  /** Fact này thay thế fact nào (khi UPDATE). */
  supersedes?: string;
  /** Fact này bị fact nào thay thế (khi bị UPDATE). */
  supersededBy?: string;
  /** Độ tin cậy 0..1. */
  confidence: number;
  status: V10FactStatus;
  scope: MemoryScope;
  /** Nguồn gốc bắt buộc — không có fact "mồ côi". */
  provenance: V10FactProvenance;
  /** Vector embedding hash-local, L2-chuẩn hoá (optional). */
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

/** Nguồn gốc của một fact v10. */
export interface V10FactProvenance {
  episodeId: string;
  turnId: string;
  runId: string;
  botId: string;
  userId: string;
  /** Thời điểm ghi (ISO). */
  at: string;
  /** Câu gốc đã rút ra fact (tối đa 500 ký tự). */
  sourceText: string;
  /** Extractor đã rút fact (vd "rule-based-v1"). */
  extractor: string;
}

/** Một episode: một turn hội thoại đã ghi lại (episodic memory). */
export interface V10Episode {
  id: string;
  turnId: string;
  runId: string;
  botId: string;
  userId: string;
  role: string;
  text: string;
  /** Tóm tắt trích xuất (câu đầu / câu có fact, tối đa 400 ký tự). */
  summary: string;
  /** Fact đã rút ra từ episode này. */
  factIds: string[];
  /** true = episode đã qua consolidation (không xét lại). */
  processed: boolean;
  createdAt: string;
}

/** Một thủ tục (procedural memory): trigger → các bước. */
export interface V10Procedure {
  id: string;
  /** Điều kiện kích hoạt, dạng text (vd "đăng bài lên Facebook"). */
  trigger: string;
  /** Các bước thực hiện, theo thứ tự. */
  steps: string[];
  /** Số lần đã dùng. */
  uses: number;
  /** Số lần dùng thành công (theo phản hồi / không lỗi). */
  successes: number;
  /** Scope sở hữu. */
  scope: MemoryScope;
  /** Episode đã sinh ra thủ tục. */
  sourceEpisodeId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Một mục trong working memory: turn gần nhất, có TTL. */
export interface V10WorkingItem {
  turnId: string;
  role: string;
  text: string;
  /** Hết hạn sau thời điểm này (ISO) — working memory quên nhanh. */
  expiresAt: string;
  createdAt: string;
}

/** Quyết định consolidation kiểu Mem0 cho một fact ứng viên. */
export type V10ConsolidationDecision =
  | 'ADD'
  | 'UPDATE'
  | 'DELETE'
  | 'QUARANTINE'
  | 'SKIP'
  | 'NOISE';

/** Lý do một ứng viên bị coi là noise (bị drop, không vào store). */
export type V10NoiseReason =
  | 'greeting'
  | 'filler'
  | 'question-only'
  | 'too-short'
  | 'no-fact-pattern'
  | 'low-salience'
  | 'duplicate';

/** Một fact ứng viên sau bước extraction, kèm điểm salience. */
export interface V10ExtractedCandidate {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  /** Câu gốc đã rút ra fact. */
  sourceText: string;
  /** Điểm nổi bật 0..1: fact càng đáng nhớ càng cao. */
  salience: number;
  /** true = noise, nên drop trước consolidation. */
  isNoise: boolean;
  /** Lý do noise (khi isNoise = true). */
  noiseReason?: V10NoiseReason;
  /** true = câu phủ định ("không còn thích...") → ứng viên DELETE. */
  isNegation: boolean;
  /** Cửa sổ hiệu lực suy ra từ text (nếu câu nói rõ thời gian). */
  validity?: { validFrom?: string; validUntil?: string | null };
}

/** Một ứng viên thủ tục rút từ turn (procedural extraction). */
export interface V10ProceduralCandidate {
  trigger: string;
  steps: string[];
  confidence: number;
  sourceText: string;
}

/** Kết quả extraction của một turn. */
export interface V10ExtractionResult {
  episodeId: string;
  turnId: string;
  /** Fact ứng viên (đã gồm cả noise — caller lọc theo isNoise). */
  candidates: V10ExtractedCandidate[];
  /** Thủ tục ứng viên. */
  procedures: V10ProceduralCandidate[];
  /** Số ứng viên bị drop vì noise. */
  noiseDropped: number;
  extractor: string;
  extractedAt: string;
}

/** Một quyết định consolidation đã áp dụng. */
export interface V10ConsolidationAction {
  decision: V10ConsolidationDecision;
  candidate: V10ExtractedCandidate;
  /** Fact đã tạo / thay thế / xoá (nếu có). */
  factId?: string;
  /** Fact cũ bị supersede (UPDATE) hoặc bị xoá (DELETE). */
  affectedFactId?: string;
  reason: string;
}

/** Kết quả một lần consolidation của một turn. */
export interface V10ConsolidationResult {
  episodeId: string;
  actions: V10ConsolidationAction[];
  added: number;
  updated: number;
  deleted: number;
  quarantined: number;
  skipped: number;
  noiseDropped: number;
  consolidatedAt: string;
}

/** Một mục quarantine v10: fact ứng viên mâu thuẫn chờ duyệt. */
export interface V10QuarantineItem {
  id: string;
  candidate: V10ExtractedCandidate;
  /** Id fact cũ mâu thuẫn (nếu có). */
  conflictingFactId?: string;
  /** Chi tiết cho user. */
  detail: string;
  status: 'pending' | 'approved' | 'rejected';
  scope: MemoryScope;
  createdAt: string;
  reviewedAt?: string;
}

/** Một phiên bản của memory block (versioned block kiểu Letta Code). */
export interface V10BlockVersion {
  /** Số phiên bản, tăng đơn điệu trong block (bắt đầu từ 1). */
  version: number;
  /** Nội dung block tại phiên bản này. */
  content: string;
  /** Message commit. */
  message: string;
  /** Phiên bản cha (null = phiên bản đầu). */
  parent: number | null;
  /** Nhánh chứa phiên bản này. */
  branch: string;
  author: string;
  createdAt: string;
  /** SHA-256 hex của content (để kiểm tra toàn vẹn). */
  contentHash: string;
}

/** Một memory block version được. */
export interface V10MemoryBlock {
  id: string;
  /** Nhãn hiển thị (vd "persona", "human", "project"). */
  label: string;
  kind: CoalaKind;
  /** Nhánh hiện tại. */
  currentBranch: string;
  /** Phiên bản hiện tại trên nhánh hiện tại. */
  currentVersion: number;
  versions: V10BlockVersion[];
  createdAt: string;
  updatedAt: string;
}

/** Một dòng diff giữa hai phiên bản block. */
export interface V10BlockDiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Kết quả diff hai phiên bản. */
export interface V10BlockDiff {
  blockId: string;
  fromVersion: number;
  toVersion: number;
  lines: V10BlockDiffLine[];
  added: number;
  removed: number;
}

/** Báo cáo rollback: rollback KHÔNG viết lại lịch sử — nó ghi một
 *  phiên bản MỚI mang nội dung cũ, nên lịch sử vẫn đầy đủ. */
export interface V10RollbackReport {
  blockId: string;
  fromVersion: number;
  toVersion: number;
  newVersion: number;
  branch: string;
  message: string;
}

/** Điểm từng tín hiệu của một hit retrieval (giải thích được). */
export interface V10ScoreBreakdown {
  /** Cosine similarity vector (embedding hash-local), 0..1. */
  vector: number;
  /** BM25 keyword, chuẩn hoá 0..1 trên tập ứng viên. */
  bm25: number;
  /** Entity-match: query nhắc tới entity của fact, 0..1. */
  entity: number;
  /** Trọng số đã dùng cho từng tín hiệu. */
  weights: { vector: number; bm25: number; entity: number };
  /** Tổng có trọng số 0..1. */
  total: number;
}

/** Một hit retrieval hợp nhất 3 tín hiệu. */
export interface V10RetrievalHit {
  /** Id fact / episode / procedure tuỳ kind. */
  id: string;
  kind: CoalaKind;
  /** Text hiển thị của hit. */
  text: string;
  /** Fact gốc (khi kind = semantic). */
  fact?: V10Fact;
  scores: V10ScoreBreakdown;
  /** Lý do chọn, đọc được (vd "vector 0.81 · bm25 0.42 · entity: Hà Nội"). */
  reasons: string[];
}

/** Kết quả retrieval hợp nhất. */
export interface V10RetrievalResult {
  query: string;
  /** Thời điểm truy vấn (để bi-temporal query "ở đâu vào tháng 3"). */
  asOf: string | null;
  hits: V10RetrievalHit[];
  /** Số ứng viên đã chấm điểm trước khi cắt topK. */
  candidatesScored: number;
  retrievedAt: string;
}

/** Thống kê tổng hợp của MemoryManagerV10 (cho UI + tool stats). */
export interface V10MemoryStats {
  workingItems: number;
  episodes: number;
  factsActive: number;
  factsSuperseded: number;
  factsDeleted: number;
  procedures: number;
  blocks: number;
  blockVersions: number;
  quarantinePending: number;
  scope: MemoryScope;
}

/** Toàn bộ file JSON lưu memory v10 của một scope. */
export interface V10MemoryFile {
  version: 1;
  facts: V10Fact[];
  episodes: V10Episode[];
  procedures: V10Procedure[];
  quarantine: V10QuarantineItem[];
  blocks: V10MemoryBlock[];
  createdAt: string;
  updatedAt: string;
}

/** File rỗng hợp lệ — điểm bắt đầu của một store mới. */
export function emptyV10MemoryFile(now: string): V10MemoryFile {
  return {
    version: 1,
    facts: [],
    episodes: [],
    procedures: [],
    quarantine: [],
    blocks: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Chuẩn hoá text để so sánh fact/entity: chữ thường, bỏ dấu
 *  tiếng Việt, bỏ dấu câu, gộp khoảng trắng (cùng quy tắc graph). */
export function normalizeV10Text(text: string): string {
  return (text ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text hiển thị của một fact v10. */
export function v10FactDisplayText(fact: V10Fact): string {
  return `${fact.subject} —${fact.predicate}→ ${fact.object}`;
}

/** Text dùng để embed / BM25 cho một fact v10. */
export function v10FactSearchText(fact: V10Fact): string {
  return `${fact.subject} ${fact.predicate.replace(/_/g, ' ')} ${fact.object}`.trim();
}

/** Fact có đang hiệu lực tại một thời điểm không (mặc định: bây giờ).
 *  Fact `active` HOẶC `superseded` đều có thể đúng tại một thời
 *  điểm trong quá khứ: supersede chỉ đóng cửa sổ validity tại lúc
 *  thay thế, không xoá lịch sử ("tháng 1 sống ở Hà Nội" vẫn đúng
 *  dù tháng 3 đã chuyển đi). Fact `deleted`/`quarantined` không
 *  bao giờ tính là đúng — đây là lõi của truy vấn bi-temporal. */
export function isV10FactValidAt(fact: V10Fact, at: Date = new Date()): boolean {
  if (fact.status === 'deleted' || fact.status === 'quarantined') return false;
  const atMs = at.getTime();
  if (Number.isNaN(atMs)) return false;
  if (Date.parse(fact.validFrom) > atMs) return false;
  if (fact.validUntil !== null && Date.parse(fact.validUntil) <= atMs) return false;
  return true;
}

/** Fact đã được hệ thống biết tới tại một thời điểm chưa (trục
 *  transaction time: learnedAt <= at). */
export function isV10FactKnownAt(fact: V10Fact, at: Date = new Date()): boolean {
  const atMs = at.getTime();
  if (Number.isNaN(atMs)) return false;
  return Date.parse(fact.learnedAt) <= atMs;
}
