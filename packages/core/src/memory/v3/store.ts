/**
 * Add-only record store — Memory v6 (v1.05, Đội T1).
 *
 * Ý tưởng học từ Mem0 v3 (append-only: bản ghi mới luôn ADD cạnh bản
 * ghi cũ thay vì UPDATE/DELETE tại chỗ) — tự thiết kế lại hoàn toàn
 * cho open-bot, 100% local, không copy code/text/tài sản của bất kỳ
 * repo nào.
 *
 * MÔ HÌNH LƯU TRỮ (file JSON `<workspace>/.open-bot/memory-v6.json`):
 *  - `records`: mảng append-only. Mỗi bản ghi BẤT BIẾN sau khi ghi:
 *    không field nào của nó bị sửa. Muốn "thay đổi" một bản ghi thì
 *    append bản ghi mới (version + 1, `supersedes` trỏ về bản cũ).
 *  - `events`: mảng append-only các `V6VersionEvent` (supersede /
 *    retire / quarantine / restore). Trạng thái HIỆU LỰC của bản ghi
 *    được suy ra lúc đọc bằng cách replay event — xem `versioning.ts`.
 *
 * Vì vậy "xoá" trong v6 không bao giờ mất dữ liệu: bản ghi cũ vẫn
 * còn trong file, vẫn truy vấn được lịch sử; chỉ trạng thái hiệu lực
 * đổi thành retired/quarantined. Ghi file dùng temp + rename (atomic)
 * và mode 0600 như LongTermMemory.
 *
 * Ngoại lệ duy nhất: trùng lặp CHÍNH XÁC (cùng text chuẩn hoá +
 * scope + kind, đang active) thì dedupe lúc ghi — trả về bản ghi cũ.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  V6AppendInput,
  V6Record,
  V6RecordKind,
  V6RecordView,
  V6Scope,
  V6StoreStats,
  V6TemporalBucket,
  V6VersionEvent,
} from './types';
import {
  V6_MAX_SOURCE_TEXT_CHARS,
  V6_MAX_TEXT_CHARS,
  normalizeV6Text,
  normalizeV6Token,
  toV6Scope,
} from './types';
import { deriveEffectiveStatus } from './versioning';
import { bucketForAgeDays, ageInDays } from './temporal';

/** Đường dẫn tương đối của file kho v6 trong workspace. */
export const MEMORY_V6_REL_PATH = path.join('.open-bot', 'memory-v6.json');
/** Version của định dạng file kho v6. */
export const MEMORY_V6_FILE_VERSION = 1;

/** Hình dạng file kho v6 trên đĩa. */
export interface V6StoreFile {
  version: number;
  records: V6Record[];
  events: V6VersionEvent[];
}

/** File rỗng hợp lệ. */
export function emptyV6StoreFile(): V6StoreFile {
  return { version: MEMORY_V6_FILE_VERSION, records: [], events: [] };
}

/** Lỗi validation của store v6 — mọi message đều tiếng Việt. */
export class V6StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V6StoreError';
  }
}

/** Tuỳ chọn khởi tạo store. */
export interface V6RecordStoreOptions {
  /** Thư mục workspace (file = `<dir>/.open-bot/memory-v6.json`). */
  dir?: string;
  /** Đường dẫn file trực tiếp (ưu tiên hơn `dir`). */
  filePath?: string;
  /** true = chỉ bộ nhớ, không chạm đĩa (dùng cho test). */
  inMemory?: boolean;
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0, value));
}

function cleanTokens(values: string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const token = normalizeV6Token(raw);
    if (token === '' || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Kho bản ghi v6 — add-only, file-backed (hoặc in-memory).
 *
 * Luồng ghi duy nhất: `append()` (bản ghi mới) và `appendEvent()`
 * (event version). Không có hàm nào sửa/xoá một bản ghi đã lưu.
 */
export class V6RecordStore {
  private readonly filePath: string | null;
  private records: V6Record[] = [];
  private events: V6VersionEvent[] = [];
  private loaded = false;
  private nextSeq = 1;

  constructor(opts: V6RecordStoreOptions = {}) {
    if (opts.inMemory) {
      this.filePath = null;
    } else if (opts.filePath) {
      this.filePath = opts.filePath;
    } else if (opts.dir) {
      this.filePath = path.join(opts.dir, MEMORY_V6_REL_PATH);
    } else {
      this.filePath = null;
    }
  }

  /** Store file-backed trong workspace của bot. */
  static fromWorkspace(workspaceDir: string): V6RecordStore {
    return new V6RecordStore({ dir: workspaceDir });
  }

  /** Store thuần bộ nhớ (test, hoặc phiên chạy tạm). */
  static inMemory(): V6RecordStore {
    return new V6RecordStore({ inMemory: true });
  }

  /** Đường dẫn file (null khi in-memory). */
  get path(): string | null {
    return this.filePath;
  }

  /** Nạp file từ đĩa (lười: gọi lần đầu khi cần; gọi lại không nạp lại). */
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
      throw new V6StoreError(`File kho memory v6 hỏng (không parse được JSON): ${this.filePath}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new V6StoreError(`File kho memory v6 sai định dạng: ${this.filePath}`);
    }
    const file = parsed as Partial<V6StoreFile>;
    if (!Array.isArray(file.records) || !Array.isArray(file.events)) {
      throw new V6StoreError(`File kho memory v6 thiếu records/events: ${this.filePath}`);
    }
    this.records = file.records as V6Record[];
    this.events = file.events as V6VersionEvent[];
    this.nextSeq = this.events.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  }

  /** Ghi toàn bộ state ra đĩa (atomic: temp + rename, mode 0600). */
  save(): void {
    if (!this.filePath) return;
    this.load();
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload: V6StoreFile = {
      version: MEMORY_V6_FILE_VERSION,
      records: this.records,
      events: this.events,
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Snapshot thô (để test/backup) — không sửa state. */
  snapshot(): V6StoreFile {
    this.load();
    return {
      version: MEMORY_V6_FILE_VERSION,
      records: this.records.map((r) => ({ ...r, scope: { ...r.scope }, source: { ...r.source } })),
      events: this.events.map((e) => ({ ...e })),
    };
  }

  /** Tổng số bản ghi đã append (kể cả đã superseded/retired). */
  count(): number {
    this.load();
    return this.records.length;
  }

  /** Tổng số event version. */
  eventCount(): number {
    this.load();
    return this.events.length;
  }

  /** Tất cả event (bản sao, theo thứ tự seq). */
  listEvents(): V6VersionEvent[] {
    this.load();
    return this.events.map((e) => ({ ...e }));
  }

  /**
   * Trạng thái hiệu lực của một bản ghi (replay event).
   * Xem `versioning.ts` — đây là NƠI DUY NHẤT status được tính.
   */
  effectiveStatus(record: V6Record): { status: V6RecordView['status']; supersededBy?: string; reason?: string } {
    this.load();
    return deriveEffectiveStatus(record, this.events);
  }

  /** Một bản ghi kèm trạng thái hiệu lực (view để trả ra ngoài). */
  toView(record: V6Record): V6RecordView {
    const eff = this.effectiveStatus(record);
    const view: V6RecordView = { ...record, status: eff.status };
    if (eff.supersededBy) view.supersededBy = eff.supersededBy;
    if (eff.reason) view.statusReason = eff.reason;
    return view;
  }

  /** Tất cả bản ghi kèm trạng thái hiệu lực (theo thứ tự ghi). */
  listAll(): V6RecordView[] {
    this.load();
    return this.records.map((r) => this.toView(r));
  }

  /** Chỉ bản ghi đang active. */
  listActive(): V6RecordView[] {
    return this.listAll().filter((r) => r.status === 'active');
  }

  /** Tìm bản ghi theo id (kèm trạng thái hiệu lực), không có -> undefined. */
  getById(id: string): V6RecordView | undefined {
    this.load();
    const record = this.records.find((r) => r.id === id);
    return record ? this.toView(record) : undefined;
  }

  /** Bản ghi thô theo id (không tính status) — dùng nội bộ cho versioning. */
  getRawById(id: string): V6Record | undefined {
    this.load();
    return this.records.find((r) => r.id === id);
  }

  /**
   * Append một bản ghi mới.
   *
   *  - Validate: text không rỗng, <= 8000 ký tự; confidence clamp 0..1.
   *  - Exact-dedupe: đã có bản ghi ACTIVE cùng text chuẩn hoá + scope
   *    + kind thì trả về bản cũ (không tạo bản sao, không ghi đĩa).
   *  - Version: mặc định 1; nếu `supersedes` trỏ bản cũ thì version =
   *    version bản cũ + 1 và append event supersede cho bản cũ.
   *  - Không bao giờ sửa bản ghi cũ tại chỗ.
   */
  append(input: V6AppendInput): V6RecordView {
    this.load();
    const text = (input.text ?? '').trim();
    if (text === '') {
      throw new V6StoreError('Không thể ghi memory v6 rỗng (text trống).');
    }
    if (text.length > V6_MAX_TEXT_CHARS) {
      throw new V6StoreError(`Text memory v6 quá dài (${text.length} > ${V6_MAX_TEXT_CHARS} ký tự).`);
    }
    const scope: V6Scope = toV6Scope(input.scope);
    const kind: V6RecordKind = input.kind ?? 'fact';
    const normalized = normalizeV6Text(text);
    const existing = this.records.find(
      (r) =>
        r.kind === kind &&
        normalizeV6Text(r.text) === normalized &&
        r.scope.userId === scope.userId &&
        r.scope.agentId === scope.agentId &&
        r.scope.runId === scope.runId &&
        r.scope.appId === scope.appId &&
        this.effectiveStatus(r).status === 'active',
    );
    if (existing) return this.toView(existing);

    const now = new Date().toISOString();
    let version = 1;
    let supersedes: string | undefined;
    if (input.supersedes) {
      const prev = this.getRawById(input.supersedes);
      if (!prev) {
        throw new V6StoreError(`Không tìm thấy bản ghi cần thay thế: ${input.supersedes}`);
      }
      version = prev.version + 1;
      supersedes = prev.id;
    }
    const sourceText = (input.source.sourceText ?? '').slice(0, V6_MAX_SOURCE_TEXT_CHARS);
    const record: V6Record = {
      id: randomUUID(),
      version,
      kind,
      ...(input.key !== undefined && input.key !== '' ? { key: input.key.trim() } : {}),
      text,
      entities: cleanTokens(input.entities),
      tags: cleanTokens(input.tags),
      confidence: clampConfidence(input.confidence),
      scope,
      source: {
        type: input.source.type,
        ref: input.source.ref,
        ...(input.source.botId ? { botId: input.source.botId } : {}),
        ...(sourceText !== '' ? { sourceText } : {}),
      },
      ...(supersedes ? { supersedes } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    if (supersedes) {
      this.appendEventInternal({
        type: 'supersede',
        targetId: supersedes,
        byId: record.id,
        reason: `Thay bằng version ${version} (${record.id}).`,
        actor: input.source.botId ?? 'tool:memory_v6_append',
      });
    }
    this.save();
    return this.toView(record);
  }

  /**
   * Append một event version (supersede/retire/quarantine/restore).
   * Event là cách DUY NHẤT để đổi trạng thái hiệu lực của bản ghi cũ.
   */
  appendEvent(event: Omit<V6VersionEvent, 'seq' | 'at'> & { at?: string }): V6VersionEvent {
    this.load();
    return this.appendEventInternal(event);
  }

  private appendEventInternal(event: Omit<V6VersionEvent, 'seq' | 'at'> & { at?: string }): V6VersionEvent {
    const full: V6VersionEvent = {
      seq: this.nextSeq,
      at: event.at ?? new Date().toISOString(),
      ...event,
    };
    // Giữ `at`/`seq` do hàm này quyết định (tránh caller ghi đè sau spread).
    full.seq = this.nextSeq;
    full.at = event.at ?? full.at;
    this.nextSeq += 1;
    this.events.push(full);
    this.save();
    return { ...full };
  }

  /** Tìm bản ghi active theo key + scope (key/value lookup). */
  findByKey(
    key: string,
    scope: Partial<V6Scope> & { userId: string },
  ): V6RecordView | undefined {
    const trimmed = key.trim();
    if (trimmed === '') return undefined;
    return this.listActive().find(
      (r) =>
        r.key === trimmed &&
        r.scope.userId === scope.userId &&
        (scope.agentId === undefined || r.scope.agentId === scope.agentId) &&
        (scope.runId === undefined || r.scope.runId === scope.runId) &&
        (scope.appId === undefined || r.scope.appId === scope.appId),
    );
  }

  /** Thống kê kho (đếm theo kind / bucket / scope level / status). */
  stats(now: Date = new Date()): V6StoreStats {
    const views = this.listAll();
    const byKind: Record<V6RecordKind, number> = {
      fact: 0,
      preference: 0,
      summary: 0,
      episode: 0,
      note: 0,
    };
    const byBucket: Record<V6TemporalBucket, number> = {
      today: 0,
      this_week: 0,
      this_month: 0,
      older: 0,
    };
    const byScopeLevel: Record<string, number> = { run: 0, agent: 0, user: 0, app: 0 };
    let active = 0;
    let superseded = 0;
    let retired = 0;
    let quarantined = 0;
    let newest: number | null = null;
    let oldest: number | null = null;
    for (const v of views) {
      byKind[v.kind] += 1;
      byBucket[bucketForAgeDays(ageInDays(v.createdAt, now))] += 1;
      if (v.scope.runId !== '') byScopeLevel['run'] += 1;
      else if (v.scope.agentId !== '') byScopeLevel['agent'] += 1;
      else if (v.scope.userId !== '') byScopeLevel['user'] += 1;
      else byScopeLevel['app'] += 1;
      if (v.status === 'active') active += 1;
      else if (v.status === 'superseded') superseded += 1;
      else if (v.status === 'retired') retired += 1;
      else quarantined += 1;
      const at = Date.parse(v.createdAt);
      if (Number.isFinite(at)) {
        if (newest === null || at > newest) newest = at;
        if (oldest === null || at < oldest) oldest = at;
      }
    }
    return {
      totalRecords: views.length,
      activeRecords: active,
      supersededRecords: superseded,
      retiredRecords: retired,
      quarantinedRecords: quarantined,
      byKind,
      byBucket,
      byScopeLevel: {
        run: byScopeLevel['run'],
        agent: byScopeLevel['agent'],
        user: byScopeLevel['user'],
        app: byScopeLevel['app'],
      },
      totalEvents: this.events.length,
      newestAt: newest === null ? null : new Date(newest).toISOString(),
      oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
    };
  }
}
