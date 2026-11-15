/**
 * Chống memory poisoning v8 (OWASP ASI06 — Memory & Context Poisoning).
 *
 * Nối tiếp `memory/provenance.ts` (quét nội dung nghi ngờ, phát hiện
 * mâu thuẫn theo key, trust score) và sleep v6 (quarantine bản yếu
 * khi cùng key mâu thuẫn). v8 thêm lớp QUYẾT ĐỊNH mà các bản trước
 * chưa có:
 *
 *  1. `PoisoningReviewQueue` — hàng đợi duyệt bền trên đĩa: fact bị
 *     nghi ngờ vào hàng đợi `pending`, user duyệt `approved` (fact
 *     được tin lại, restore khỏi quarantine) hoặc `rejected` (fact
 *     bị retire, không bao giờ tin nữa). Không có quyết định tự động
 *     xóa fact — chỉ user mới xóa.
 *  2. `detectBursts` — phát hiện burst: một nguồn ghi ồ ạt nhiều fact
 *     trong cửa sổ ngắn (vd 10 fact/5 phút) — dấu hiệu import độc
 *     hoặc tool bị lợi dụng chèn memory.
 *  3. `findContradictionClusters` — cụm mâu thuẫn xuyên scope: cùng
 *     key nhưng giá trị khác nhau ở các scope khác nhau (vd user nói
 *     "thích cà phê" ở run A, "ghét cà phê" ở run B) — gom thành cụm
 *     để user quyết một lần thay vì từng cặp rời rạc.
 *  4. `scanStoreForPoisoning` — quét toàn kho v6 một lượt: nội dung
 *     nghi ngờ + cụm mâu thuẫn + burst, trả báo cáo đọc (không sửa
 *     gì); host quyết định đưa mục nào vào hàng đợi.
 *
 * 100% local, xác định, không gọi model/mạng. Không tuyên bố điểm
 * benchmark nào (xem types.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { V6RecordStore } from '../v3/store';
import type { V6RecordView } from '../v3/types';
import { normalizeV6Text } from '../v3/types';
import { scopeLevelOf } from '../v3/scopes';
import { quarantineRecord, restoreRecord, retireRecord } from '../v3/versioning';
import { buildV8Provenance, v8SourceKeyOf } from './provenance';
import { detectSuspiciousContent, hasHighSeverityFlag } from '../provenance';
import type {
  V8BurstFinding,
  V8ContradictionCluster,
  V8PoisoningScanReport,
  V8ReviewItem,
  V8ReviewQueueFile,
  V8ReviewReason,
  V8ReviewStatus,
} from './types';

/** Đường dẫn tương đối của hàng đợi duyệt v8 trong workspace. */
export const V8_REVIEW_QUEUE_REL_PATH = path.join('.open-bot', 'memory-v8-review-queue.json');
/** Số mục duyệt tối đa giữ trong file (cũ nhất, đã quyết, bị cắt trước). */
export const V8_REVIEW_QUEUE_KEEP = 500;
/** Text preview tối đa trong một mục duyệt (ký tự). */
export const V8_REVIEW_PREVIEW_CHARS = 500;
/** Ngưỡng burst mặc định: 10 fact trong 5 phút từ cùng một nguồn. */
export const DEFAULT_V8_BURST_COUNT = 10;
export const DEFAULT_V8_BURST_WINDOW_MINUTES = 5;
/** Ngưỡng trust: fact dưới ngưỡng này từ nguồn lạ bị đưa vào hàng đợi. */
export const DEFAULT_V8_LOW_TRUST_THRESHOLD = 0.3;

/** Lỗi poisoning v8 — mọi message đều tiếng Việt. */
export class V8PoisoningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V8PoisoningError';
  }
}

/** File hàng đợi rỗng (để khởi tạo). */
export function emptyV8ReviewQueueFile(): V8ReviewQueueFile {
  return { version: 1, items: [] };
}

/**
 * Hàng đợi duyệt chống poisoning (lưu bền, user quyết định).
 *
 *  - `flag(record, reason, detail)`: đưa một bản ghi vào hàng đợi
 *    `pending`. Đưa trùng (cùng recordId + reason, đang pending) thì
 *    trả về mục cũ, không tạo mục mới.
 *  - `decide(itemId, 'approved'|'rejected', by, note?)`: user quyết.
 *    Approved -> restore bản ghi khỏi quarantine (nếu đang bị
 *    quarantine). Rejected -> retire bản ghi (không tin nữa). Cả hai
 *    đều ghi `decidedBy/decidedAt` và lưu bền. Quyết định cần store
 *    v6 (truyền vào lúc decide); không có store thì chỉ đổi trạng
 *    thái mục duyệt.
 *  - `listPending()` / `list(status?)`: đọc hàng đợi.
 *  - `expireOlderThan(days)`: mục pending quá cũ -> `expired`
 *    (không tự quyết, chỉ đánh dấu hết hạn để user khỏi phải xem
 *    fact đã lỗi thời). Trả về số mục đã hết hạn.
 *  - In-memory khi không có dir (dùng cho test).
 */
export class PoisoningReviewQueue {
  private readonly filePath: string | null;
  private items: V8ReviewItem[] = [];
  private loaded = false;

  constructor(opts: { dir?: string; filePath?: string; inMemory?: boolean } = {}) {
    if (opts.inMemory) {
      this.filePath = null;
    } else if (opts.filePath) {
      this.filePath = opts.filePath;
    } else if (opts.dir) {
      this.filePath = path.join(opts.dir, V8_REVIEW_QUEUE_REL_PATH);
    } else {
      this.filePath = null;
    }
  }

  /** Hàng đợi file-backed trong workspace của bot. */
  static fromWorkspace(workspaceDir: string): PoisoningReviewQueue {
    return new PoisoningReviewQueue({ dir: workspaceDir });
  }

  /** Hàng đợi thuần bộ nhớ (test). */
  static inMemory(): PoisoningReviewQueue {
    return new PoisoningReviewQueue({ inMemory: true });
  }

  /** Đường dẫn file (null khi in-memory). */
  get path(): string | null {
    return this.filePath;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V8PoisoningError(`File hàng đợi duyệt v8 hỏng (không parse được JSON): ${this.filePath}`);
    }
    const file = parsed as Partial<V8ReviewQueueFile>;
    if (!Array.isArray(file.items)) {
      throw new V8PoisoningError(`File hàng đợi duyệt v8 sai định dạng: ${this.filePath}`);
    }
    this.items = (file.items as V8ReviewItem[]).filter(
      (i) => i && typeof i.id === 'string' && typeof i.recordId === 'string',
    );
  }

  /** Ghi toàn bộ hàng đợi ra đĩa (atomic: temp + rename, mode 0600). */
  save(): void {
    if (!this.filePath) return;
    this.load();
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload: V8ReviewQueueFile = { version: 1, items: this.items };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Đưa một bản ghi vào hàng đợi (trùng pending thì trả mục cũ). */
  flag(
    record: V6RecordView,
    reason: V8ReviewReason,
    detail: string,
    opts: { trustAtFlag?: number; now?: Date } = {},
  ): V8ReviewItem {
    this.load();
    const existing = this.items.find(
      (i) => i.recordId === record.id && i.reason === reason && i.status === 'pending',
    );
    if (existing) return { ...existing };
    const now = (opts.now ?? new Date()).toISOString();
    const item: V8ReviewItem = {
      id: randomUUID(),
      recordId: record.id,
      textPreview: record.text.slice(0, V8_REVIEW_PREVIEW_CHARS),
      reason,
      detail: detail.slice(0, 500),
      trustAtFlag: opts.trustAtFlag ?? record.confidence,
      sourceKey: v8SourceKeyOf(record),
      status: 'pending',
      createdAt: now,
    };
    this.items.push(item);
    // Giữ tối đa N mục: cắt mục đã quyết cũ nhất trước, không cắt pending.
    if (this.items.length > V8_REVIEW_QUEUE_KEEP) {
      const decidedIdx: number[] = [];
      this.items.forEach((it, idx) => {
        if (it.status !== 'pending') decidedIdx.push(idx);
      });
      const overflow = this.items.length - V8_REVIEW_QUEUE_KEEP;
      const toRemove = new Set(decidedIdx.slice(0, overflow));
      this.items = this.items.filter((_, idx) => !toRemove.has(idx));
    }
    this.save();
    return { ...item };
  }

  /** Một mục duyệt theo id (undefined khi không có). */
  get(itemId: string): V8ReviewItem | undefined {
    this.load();
    const found = this.items.find((i) => i.id === itemId);
    return found ? { ...found } : undefined;
  }

  /**
   * User quyết định một mục duyệt.
   *
   *  - 'approved': fact được tin lại — restore khỏi quarantine khi
   *    đang bị quarantine (qua store, khi caller truyền store).
   *  - 'rejected': fact không được tin — retire bản ghi (qua store).
   *  - Không có store: chỉ đổi trạng thái mục duyệt, không chạm kho.
   *  - Mục đã quyết rồi thì throw (không quyết 2 lần).
   */
  decide(
    itemId: string,
    decision: 'approved' | 'rejected',
    opts: { by?: string; note?: string; store?: V6RecordStore; now?: Date } = {},
  ): V8ReviewItem {
    this.load();
    const item = this.items.find((i) => i.id === itemId);
    if (!item) throw new V8PoisoningError(`Không tìm thấy mục duyệt "${itemId}".`);
    if (item.status !== 'pending') {
      throw new V8PoisoningError(`Mục duyệt "${itemId}" đã quyết rồi (trạng thái ${item.status}) — không quyết lại.`);
    }
    const by = (opts.by ?? 'user').trim() || 'user';
    if (opts.store) {
      const record = opts.store.getById(item.recordId);
      if (record) {
        if (decision === 'approved' && record.status === 'quarantined') {
          restoreRecord(opts.store, record.id, by, `User duyệt fact (review ${item.id}).`);
        } else if (decision === 'rejected' && record.status !== 'retired') {
          retireRecord(opts.store, record.id, by, `User từ chối fact nghi ngờ (review ${item.id}).`);
        }
      }
    }
    item.status = decision;
    item.decidedBy = by;
    item.decidedAt = (opts.now ?? new Date()).toISOString();
    if (opts.note !== undefined) item.decisionNote = opts.note.slice(0, 500);
    this.save();
    return { ...item };
  }

  /** Các mục đang chờ duyệt (mới nhất trước). */
  listPending(): V8ReviewItem[] {
    return this.list('pending');
  }

  /** Các mục theo trạng thái (mới nhất trước); không truyền = tất cả. */
  list(status?: V8ReviewStatus): V8ReviewItem[] {
    this.load();
    const filtered = status ? this.items.filter((i) => i.status === status) : [...this.items];
    return filtered
      .map((i) => ({ ...i }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  /** Số mục theo từng trạng thái. */
  counts(): Record<V8ReviewStatus, number> {
    this.load();
    const out: Record<V8ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0, expired: 0 };
    for (const item of this.items) out[item.status] += 1;
    return out;
  }

  /**
   * Đánh dấu hết hạn các mục pending quá cũ (mặc định 30 ngày).
   * Hết hạn KHÔNG phải quyết định — fact vẫn ở trạng thái cũ trong
   * kho, chỉ là hàng đợi không bắt user xem fact đã lỗi thời nữa.
   */
  expireOlderThan(days: number, now = new Date()): number {
    if (!(days > 0)) throw new V8PoisoningError('Số ngày hết hạn phải > 0.');
    this.load();
    const cutoff = now.getTime() - days * 86_400_000;
    let expired = 0;
    for (const item of this.items) {
      if (item.status !== 'pending') continue;
      if (Date.parse(item.createdAt) < cutoff) {
        item.status = 'expired';
        expired += 1;
      }
    }
    if (expired > 0) this.save();
    return expired;
  }
}

/* ------------------------------------------------------------------ */
/* Phát hiện burst + cụm mâu thuẫn (hàm thuần, không chạm đĩa)        */
/* ------------------------------------------------------------------ */

/**
 * Phát hiện burst: một nguồn ghi ồ ạt trong cửa sổ ngắn.
 *
 * Thuật toán: gom bản ghi theo sourceKey, sắp theo thời gian, trượt
 * cửa sổ `windowMinutes` — cửa sổ nào chứa >= threshold fact thì là
 * burst (mỗi nguồn tối đa 1 finding, lấy cửa sổ đông nhất). Chỉ xét
 * bản ghi active (fact đã retire/quarantine không tính).
 */
export function detectBursts(
  records: V6RecordView[],
  opts: { threshold?: number; windowMinutes?: number } = {},
): V8BurstFinding[] {
  const threshold = opts.threshold ?? DEFAULT_V8_BURST_COUNT;
  const windowMinutes = opts.windowMinutes ?? DEFAULT_V8_BURST_WINDOW_MINUTES;
  if (!(threshold > 0) || !(windowMinutes > 0)) return [];
  const windowMs = windowMinutes * 60_000;
  const bySource = new Map<string, V6RecordView[]>();
  for (const record of records) {
    if (record.status !== 'active') continue;
    const key = v8SourceKeyOf(record);
    const list = bySource.get(key) ?? [];
    list.push(record);
    bySource.set(key, list);
  }
  const findings: V8BurstFinding[] = [];
  for (const [sourceKey, group] of bySource) {
    if (group.length < threshold) continue;
    const sorted = [...group].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let bestCount = 0;
    let bestFirst = 0;
    let bestLast = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      const start = Date.parse((sorted[i] as V6RecordView).createdAt);
      let j = i;
      while (j < sorted.length && Date.parse((sorted[j] as V6RecordView).createdAt) - start <= windowMs) j += 1;
      const count = j - i;
      if (count > bestCount) {
        bestCount = count;
        bestFirst = i;
        bestLast = j - 1;
      }
    }
    if (bestCount >= threshold) {
      findings.push({
        sourceKey,
        count: bestCount,
        windowMinutes,
        threshold,
        firstAt: (sorted[bestFirst] as V6RecordView).createdAt,
        lastAt: (sorted[bestLast] as V6RecordView).createdAt,
      });
    }
  }
  return findings.sort((a, b) => b.count - a.count);
}

/**
 * Tìm cụm mâu thuẫn xuyên scope: cùng key (chuẩn hoá), giá trị khác
 * nhau, ở các scope khác nhau hoặc cùng scope. Mỗi cụm gom mọi bản
 * ghi active có cùng key; `strongestId` là bản trust cao nhất (hoà
 * thì mới nhất) — gợi ý cho user, không tự quyết thay user.
 */
export function findContradictionClusters(records: V6RecordView[]): V8ContradictionCluster[] {
  const byKey = new Map<string, V6RecordView[]>();
  for (const record of records) {
    if (record.status !== 'active') continue;
    if (!record.key) continue;
    const key = normalizeV6Text(record.key);
    if (key === '') continue;
    const list = byKey.get(key) ?? [];
    list.push(record);
    byKey.set(key, list);
  }
  const clusters: V8ContradictionCluster[] = [];
  for (const [key, group] of byKey) {
    const distinct = new Set(group.map((r) => normalizeV6Text(r.text)));
    if (distinct.size < 2) continue;
    const members = group.map((r) => ({
      recordId: r.id,
      value: r.text.slice(0, 200),
      scopeLabel: `${scopeLevelOf(r.scope)}:${r.scope.userId || '-'}${r.scope.agentId ? `/${r.scope.agentId}` : ''}`,
      trust: r.confidence,
      recordedAt: r.createdAt,
    }));
    const strongest = [...group].sort((a, b) => {
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    })[0] as V6RecordView;
    clusters.push({
      key,
      members,
      distinctValues: distinct.size,
      strongestId: strongest.id,
    });
  }
  return clusters.sort((a, b) => b.distinctValues - a.distinctValues || b.members.length - a.members.length);
}

/**
 * Quét toàn kho v6 tìm dấu hiệu poisoning (chỉ đọc, không sửa gì).
 *
 *  - Nội dung nghi ngờ: quét từng bản ghi active bằng
 *    detectSuspiciousContent (flag high = nghi ngờ).
 *  - Cụm mâu thuẫn: findContradictionClusters.
 *  - Burst: detectBursts.
 * Host dùng báo cáo này để đưa mục vào hàng đợi duyệt (flag) hoặc
 * chỉ hiển thị cảnh báo — quét không tự quarantine gì cả.
 */
export function scanStoreForPoisoning(
  store: V6RecordStore,
  opts: {
    burstThreshold?: number;
    burstWindowMinutes?: number;
    now?: Date;
  } = {},
): V8PoisoningScanReport {
  const now = opts.now ?? new Date();
  const actives = store.listActive();
  const suspiciousIds: string[] = [];
  for (const record of actives) {
    const flags = detectSuspiciousContent(record.text);
    if (hasHighSeverityFlag(flags)) suspiciousIds.push(record.id);
  }
  const clusters = findContradictionClusters(actives).slice(0, 20);
  const burstFindings = detectBursts(actives, {
    threshold: opts.burstThreshold,
    windowMinutes: opts.burstWindowMinutes,
  }).slice(0, 20);
  return {
    scannedAt: now.toISOString(),
    scanned: actives.length,
    suspicious: suspiciousIds.length,
    contradictionClusters: clusters.length,
    bursts: burstFindings.length,
    clusters,
    burstFindings,
    suspiciousIds: suspiciousIds.slice(0, 50),
  };
}

/**
 * Đưa kết quả quét vào hàng đợi duyệt (tiện ích cho tool/host).
 * Trả về số mục mới đã tạo (mục trùng pending không tạo lại).
 * Bản ghi nghi ngờ nội dung -> reason 'suspicious-content'; bản
 * ghi trong cụm mâu thuẫn (trừ bản mạnh nhất) -> 'contradiction';
 * bản ghi trong burst -> 'burst-source'.
 */
export function flagScanResults(
  queue: PoisoningReviewQueue,
  store: V6RecordStore,
  report: V8PoisoningScanReport,
): number {
  let created = 0;
  const flagged = new Set<string>();
  for (const id of report.suspiciousIds) {
    const record = store.getById(id);
    if (!record || flagged.has(id)) continue;
    queue.flag(record, 'suspicious-content', 'Nội dung khớp mẫu nghi ngờ (prompt-injection / rò secret).');
    flagged.add(id);
    created += 1;
  }
  for (const cluster of report.clusters) {
    for (const member of cluster.members) {
      if (member.recordId === cluster.strongestId || flagged.has(member.recordId)) continue;
      const record = store.getById(member.recordId);
      if (!record) continue;
      queue.flag(
        record,
        'contradiction',
        `Mâu thuẫn key "${cluster.key}" với ${cluster.distinctValues} giá trị khác nhau (bản mạnh nhất: ${cluster.strongestId}).`,
      );
      flagged.add(member.recordId);
      created += 1;
    }
  }
  for (const burst of report.burstFindings) {
    const burstRecords = store
      .listActive()
      .filter((r) => v8SourceKeyOf(r) === burst.sourceKey)
      .filter((r) => Date.parse(r.createdAt) >= Date.parse(burst.firstAt) && Date.parse(r.createdAt) <= Date.parse(burst.lastAt));
    for (const record of burstRecords) {
      if (flagged.has(record.id)) continue;
      queue.flag(
        record,
        'burst-source',
        `Nguồn "${burst.sourceKey}" ghi ${burst.count} fact trong ${burst.windowMinutes} phút (ngưỡng ${burst.threshold}).`,
      );
      flagged.add(record.id);
      created += 1;
    }
  }
  return created;
}
