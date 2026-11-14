/**
 * Versioning cho memory v6 (v1.05, Đội T1).
 *
 * Ý tưởng học từ Mem0 v3 (mỗi bản ghi có version + supersededBy,
 * lịch sử giữ nguyên) — tự thiết kế lại hoàn toàn cho open-bot, 100%
 * local, không copy code/text/tài sản của bất kỳ repo nào.
 *
 * NGUYÊN TẮC: trạng thái hiệu lực KHÔNG lưu trong bản ghi. Nó được
 * suy ra bằng cách replay nhật ký event theo thứ tự seq:
 *  - Không event nào -> active.
 *  - Event gần nhất quyết định: supersede -> superseded, retire ->
 *    retired, quarantine -> quarantined, restore -> active trở lại.
 *  - Một bản ghi có `supersedes` trỏ về bản cũ cũng làm bản cũ
 *    superseded (dù chưa có event tường minh — append() luôn ghi
 *    event kèm theo, đây chỉ là lưới an toàn khi đọc file cũ).
 *
 * Mọi hàm đổi trạng thái ở đây chỉ APPEND event (qua store), không
 * bao giờ sửa bản ghi. `restore` cũng vậy: append event restore,
 * bản ghi cũ active trở lại — lịch sử vẫn còn nguyên.
 */

import type { V6Record, V6RecordView, V6VersionEvent } from './types';
import type { V6RecordStore } from './store';

/** Kết quả suy ra trạng thái hiệu lực từ event. */
export interface EffectiveStatus {
  status: V6RecordView['status'];
  /** Id bản ghi đã thay thế (khi superseded). */
  supersededBy?: string;
  /** Lý do của event gần nhất (khi không active). */
  reason?: string;
}

/**
 * Suy ra trạng thái hiệu lực của một bản ghi từ nhật ký event.
 * Event phải theo thứ tự seq tăng dần (store luôn giữ như vậy).
 */
export function deriveEffectiveStatus(record: V6Record, events: V6VersionEvent[]): EffectiveStatus {
  let status: EffectiveStatus = { status: 'active' };
  for (const event of events) {
    if (event.targetId !== record.id) continue;
    switch (event.type) {
      case 'supersede':
        status = {
          status: 'superseded',
          ...(event.byId ? { supersededBy: event.byId } : {}),
          reason: event.reason,
        };
        break;
      case 'retire':
        status = { status: 'retired', reason: event.reason };
        break;
      case 'quarantine':
        status = { status: 'quarantined', reason: event.reason };
        break;
      case 'restore':
        status = { status: 'active' };
        break;
    }
  }
  return status;
}

/**
 * Như `deriveEffectiveStatus` nhưng xét thêm liên kết `supersedes`
 * giữa các bản ghi (dùng khi đọc snapshot thô, không qua store).
 */
export function deriveEffectiveStatusWithRecords(
  record: V6Record,
  events: V6VersionEvent[],
  allRecords: V6Record[],
): EffectiveStatus {
  const fromEvents = deriveEffectiveStatus(record, events);
  if (fromEvents.status !== 'active') return fromEvents;
  const replacer = allRecords.find((r) => r.supersedes === record.id);
  if (replacer) {
    return {
      status: 'superseded',
      supersededBy: replacer.id,
      reason: `Thay bằng version ${replacer.version} (${replacer.id}).`,
    };
  }
  return fromEvents;
}

/** Lỗi versioning — mọi message đều tiếng Việt. */
export class V6VersioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V6VersioningError';
  }
}

function requireRecord(store: V6RecordStore, id: string): V6RecordView {
  const record = store.getById(id);
  if (!record) throw new V6VersioningError(`Không tìm thấy bản ghi memory v6: ${id}`);
  return record;
}

/**
 * Đánh dấu bản ghi cũ đã bị thay thế (append event supersede).
 * Thường đi kèm append bản ghi mới có `supersedes` — nhưng hàm này
 * cho phép supersede tường minh khi bản mới đã tồn tại trước.
 */
export function supersedeRecord(
  store: V6RecordStore,
  oldId: string,
  newId: string,
  actor: string,
  reason?: string,
): V6VersionEvent {
  const oldRecord = requireRecord(store, oldId);
  const newRecord = requireRecord(store, newId);
  if (oldRecord.status === 'retired') {
    throw new V6VersioningError(`Không thể supersede bản ghi đã retired: ${oldId}`);
  }
  if (oldId === newId) {
    throw new V6VersioningError('Không thể supersede một bản ghi bằng chính nó.');
  }
  return store.appendEvent({
    type: 'supersede',
    targetId: oldId,
    byId: newId,
    reason: reason ?? `Thay bằng version ${newRecord.version} (${newId}).`,
    actor,
  });
}

/**
 * "Xoá" một bản ghi theo nghĩa add-only: append event retire.
 * Bản ghi vẫn còn trong file và truy vấn được lịch sử; chỉ không
 * còn active. Cần `reason` không rỗng (audit).
 */
export function retireRecord(
  store: V6RecordStore,
  id: string,
  actor: string,
  reason: string,
): V6VersionEvent {
  const record = requireRecord(store, id);
  if (record.status === 'retired') {
    throw new V6VersioningError(`Bản ghi đã retired rồi: ${id}`);
  }
  if (reason.trim() === '') {
    throw new V6VersioningError('Retire bản ghi cần lý do không rỗng (để audit).');
  }
  return store.appendEvent({ type: 'retire', targetId: id, reason, actor });
}

/**
 * Cách ly một bản ghi mâu thuẫn / nghi ngờ (append event quarantine).
 * Dùng trong sleep-time compute khi phát hiện mâu thuẫn; user duyệt
 * sau bằng `restoreRecord` hoặc `retireRecord`.
 */
export function quarantineRecord(
  store: V6RecordStore,
  id: string,
  actor: string,
  reason: string,
): V6VersionEvent {
  const record = requireRecord(store, id);
  if (record.status === 'quarantined') {
    throw new V6VersioningError(`Bản ghi đã quarantined rồi: ${id}`);
  }
  if (reason.trim() === '') {
    throw new V6VersioningError('Quarantine bản ghi cần lý do không rỗng (để audit).');
  }
  return store.appendEvent({ type: 'quarantine', targetId: id, reason, actor });
}

/**
 * Khôi phục một bản ghi đã superseded/retired/quarantined về active
 * (append event restore). Lịch sử event vẫn còn nguyên.
 */
export function restoreRecord(
  store: V6RecordStore,
  id: string,
  actor: string,
  reason?: string,
): V6VersionEvent {
  const record = requireRecord(store, id);
  if (record.status === 'active') {
    throw new V6VersioningError(`Bản ghi đang active rồi, không cần restore: ${id}`);
  }
  return store.appendEvent({
    type: 'restore',
    targetId: id,
    reason: reason ?? 'Khôi phục về active theo yêu cầu.',
    actor,
  });
}

/** Một mắt xích trong chuỗi version của một key/bản ghi. */
export interface V6VersionChainLink {
  record: V6RecordView;
  /** Event đã đổi trạng thái bản ghi này (nếu có). */
  events: V6VersionEvent[];
}

/**
 * Lịch sử version đầy đủ của một bản ghi: đi ngược chuỗi `supersedes`
 * về bản đầu tiên, rồi đi xuôi tới bản mới nhất; kèm event của từng
 * bản. Trả về theo thứ tự version tăng dần.
 */
export function recordHistory(store: V6RecordStore, id: string): V6VersionChainLink[] {
  const start = store.getById(id);
  if (!start) throw new V6VersioningError(`Không tìm thấy bản ghi memory v6: ${id}`);
  const all = store.listAll();
  const byId = new Map(all.map((r) => [r.id, r]));
  // Đi ngược về bản đầu tiên của chuỗi.
  let first: V6RecordView = start;
  const guard = new Set<string>();
  while (first.supersedes && byId.has(first.supersedes) && !guard.has(first.id)) {
    guard.add(first.id);
    first = byId.get(first.supersedes) as V6RecordView;
  }
  // Đi xuôi theo chuỗi supersedes.
  const chain: V6RecordView[] = [first];
  guard.clear();
  guard.add(first.id);
  let current = first;
  for (;;) {
    const next = all.find((r) => r.supersedes === current.id);
    if (!next || guard.has(next.id)) break;
    guard.add(next.id);
    chain.push(next);
    current = next;
  }
  const events = store.listEvents();
  return chain.map((record) => ({
    record,
    events: events.filter((e) => e.targetId === record.id),
  }));
}

/**
 * Kiểm tra tính toàn vẹn của chuỗi version trong store:
 *  - `supersedes` phải trỏ tới bản ghi tồn tại;
 *  - version của bản mới = version bản cũ + 1;
 *  - không có vòng lặp supersedes.
 * Trả về danh sách vấn đề (rỗng = khoẻ).
 */
export function validateVersionChain(store: V6RecordStore): string[] {
  const problems: string[] = [];
  const all = store.listAll();
  const byId = new Map(all.map((r) => [r.id, r]));
  for (const record of all) {
    if (!record.supersedes) continue;
    const prev = byId.get(record.supersedes);
    if (!prev) {
      problems.push(`Bản ghi ${record.id} supersedes id không tồn tại: ${record.supersedes}`);
      continue;
    }
    if (record.version !== prev.version + 1) {
      problems.push(
        `Bản ghi ${record.id} version ${record.version} nhưng bản trước ${prev.id} version ${prev.version} (phải +1).`,
      );
    }
  }
  // Phát hiện vòng lặp: đi ngược tối đa N bước (N = số bản ghi).
  for (const record of all) {
    let cursor: V6RecordView | undefined = record;
    const seen = new Set<string>();
    while (cursor?.supersedes) {
      if (seen.has(cursor.id)) {
        problems.push(`Vòng lặp supersedes tại bản ghi ${cursor.id}.`);
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.supersedes);
      if (seen.size > all.length) {
        problems.push(`Chuỗi supersedes quá dài (nghi vòng lặp) tại ${record.id}.`);
        break;
      }
    }
  }
  return problems;
}
