/**
 * Bi-temporal graph v2 — đồ thị tri thức 2 trục thời gian (v1.10, Đội T1).
 *
 * Khác graph v0.98 ở 3 điểm:
 *  1. Hai trục thời gian tách bạch trên MỖI fact: validity (fact đúng
 *     trong thế giới từ–đến khi nào) và transaction time (learnedAt —
 *     hệ thống học được lúc nào). Truy vấn được cả hai câu hỏi:
 *     "ở đâu vào tháng 3" (validity) lẫn "hôm qua hệ thống biết gì"
 *     (transaction time).
 *  2. Mâu thuẫn KHÔNG ghi đè: fact cũ bị đóng cửa sổ validity tại
 *     thời điểm thay thế, chuyển `superseded`, trỏ `supersededBy`
 *     sang fact mới. `deleteFact` cũng chỉ đóng cửa sổ + đánh dấu
 *     `deleted` — không xoá dòng nào, lịch sử còn nguyên.
 *  3. Timeline theo subject: toàn bộ đời sống của một thực thể
 *     (fact nào đúng khi nào, bị thay bởi fact nào) trả về theo thứ
 *     tự thời gian, để UI vẽ được trục thời gian bi-temporal.
 *
 * Store chạy trong bộ nhớ + persist JSON xuống file (load/save thô,
 * không cần SQLite). Id fact xác định: `v10f-<counter>-<random>` —
 * counter + random để không trùng khi load lại file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryScope } from '../graph/types';
import {
  isV10FactKnownAt,
  isV10FactValidAt,
  normalizeV10Text,
  v10FactSearchText,
  type V10ExtractedCandidate,
  type V10Fact,
  type V10FactProvenance,
  type V10FactStatus,
  type V10MemoryFile,
} from './types';

export interface V10AddFactInput {
  candidate: V10ExtractedCandidate;
  scope: MemoryScope;
  provenance: Omit<V10FactProvenance, 'extractor'> & { extractor?: string };
  /** Ghi đè cửa sổ validity (mặc định: từ validity của candidate,
   *  nếu không có thì validFrom = learnedAt, validUntil = null). */
  validFrom?: string;
  validUntil?: string | null;
  embedding?: number[];
}

export interface V10FactFilter {
  subject?: string;
  predicate?: string;
  /** Chỉ fact thuộc scope này (so khớp userId/botId/runId khác rỗng). */
  scope?: Partial<MemoryScope>;
  status?: V10FactStatus;
  /** Chỉ fact có object chứa chuỗi này (chuẩn hoá). */
  objectContains?: string;
}

export interface V10TimelineEntry {
  fact: V10Fact;
  /** Fact này bắt đầu đúng lúc nào (validFrom). */
  startsAt: string;
  /** Fact này hết đúng lúc nào (validUntil, null = tới nay). */
  endsAt: string | null;
  /** Fact thay thế nó (nếu bị supersede). */
  replacedBy?: V10Fact;
}

function scopeMatches(factScope: MemoryScope, filter: Partial<MemoryScope>): boolean {
  if (filter.userId !== undefined && filter.userId !== '' && factScope.userId !== filter.userId) return false;
  if (filter.botId !== undefined && filter.botId !== '' && factScope.botId !== filter.botId) return false;
  if (filter.runId !== undefined && filter.runId !== '' && factScope.runId !== filter.runId) return false;
  return true;
}

export class BiTemporalGraphV10 {
  private facts: V10Fact[] = [];
  private counter = 0;

  constructor(initial: V10Fact[] = []) {
    this.facts = initial.map((f) => ({ ...f }));
    this.counter = this.facts.length;
  }

  /** Tất cả fact (bản sao) — test/UI dùng để kiểm kê. */
  allFacts(): V10Fact[] {
    return this.facts.map((f) => ({ ...f }));
  }

  count(): number {
    return this.facts.length;
  }

  countByStatus(status: V10FactStatus): number {
    return this.facts.filter((f) => f.status === status).length;
  }

  getFact(id: string): V10Fact | undefined {
    const found = this.facts.find((f) => f.id === id);
    return found ? { ...found } : undefined;
  }

  private nextId(): string {
    this.counter += 1;
    return `v10f-${this.counter}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Thêm fact mới. KHÔNG kiểm tra trùng — việc quyết định ADD hay
   * UPDATE thuộc về consolidation (xem consolidation.ts); hàm này
   * chỉ ghi. validFrom mặc định = validity của candidate, nếu không
   * có thì = learnedAt (fact đúng từ lúc học được).
   */
  addFact(input: V10AddFactInput): V10Fact {
    const now = new Date().toISOString();
    const learnedAt = input.provenance.at;
    const validFrom = input.validFrom ?? input.candidate.validity?.validFrom ?? learnedAt;
    const validUntil = input.validUntil ?? input.candidate.validity?.validUntil ?? null;
    const fact: V10Fact = {
      id: this.nextId(),
      subject: input.candidate.subject,
      predicate: input.candidate.predicate,
      object: input.candidate.object,
      validFrom,
      validUntil,
      learnedAt,
      confidence: input.candidate.confidence,
      status: 'active',
      scope: { ...input.scope },
      provenance: { ...input.provenance, extractor: input.provenance.extractor ?? 'v10-rule-based' },
      embedding: input.embedding ? [...input.embedding] : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.facts.push(fact);
    return { ...fact };
  }

  /**
   * Thay thế fact cũ bằng fact mới (UPDATE kiểu Mem0): fact cũ bị
   * đóng cửa sổ validity tại `at` (mặc định: bây giờ), chuyển
   * `superseded`, trỏ sang fact mới; fact mới trỏ ngược `supersedes`.
   * Trả cả hai — KHÔNG xoá gì.
   */
  supersedeFact(oldId: string, newFact: V10Fact, at: Date = new Date()): { oldFact: V10Fact; newFact: V10Fact } | null {
    const oldFact = this.facts.find((f) => f.id === oldId);
    const storedNew = this.facts.find((f) => f.id === newFact.id);
    if (!oldFact || !storedNew) return null;
    const atIso = at.toISOString();
    oldFact.status = 'superseded';
    oldFact.validUntil = atIso;
    oldFact.supersededBy = storedNew.id;
    oldFact.updatedAt = atIso;
    storedNew.supersedes = oldFact.id;
    storedNew.updatedAt = atIso;
    return { oldFact: { ...oldFact }, newFact: { ...storedNew } };
  }

  /**
   * Xoá logic một fact (DELETE kiểu Mem0): đóng cửa sổ validity,
   * chuyển `deleted`. Dòng fact vẫn còn — truy vấn lịch sử vẫn thấy
   * nó từng đúng tới lúc nào.
   */
  deleteFact(id: string, at: Date = new Date()): V10Fact | null {
    const fact = this.facts.find((f) => f.id === id);
    if (!fact) return null;
    const atIso = at.toISOString();
    fact.status = 'deleted';
    if (fact.validUntil === null || Date.parse(fact.validUntil) > at.getTime()) {
      fact.validUntil = atIso;
    }
    fact.updatedAt = atIso;
    return { ...fact };
  }

  /** Fact active đang mâu thuẫn với ứng viên: cùng subject +
   *  predicate, object khác (chuẩn hoá). */
  findConflictingActive(
    candidate: V10ExtractedCandidate,
    scope?: Partial<MemoryScope>,
  ): V10Fact[] {
    const normObject = normalizeV10Text(candidate.object);
    return this.facts.filter((f) => {
      if (f.status !== 'active') return false;
      if (normalizeV10Text(f.subject) !== normalizeV10Text(candidate.subject)) return false;
      if (f.predicate !== candidate.predicate) return false;
      if (normalizeV10Text(f.object) === normObject) return false;
      if (scope && !scopeMatches(f.scope, scope)) return false;
      return true;
    });
  }

  /** Fact active trùng hệt ứng viên (cùng subject/predicate/object). */
  findDuplicateActive(candidate: V10ExtractedCandidate, scope?: Partial<MemoryScope>): V10Fact | undefined {
    const normObject = normalizeV10Text(candidate.object);
    return this.facts.find((f) => {
      if (f.status !== 'active') return false;
      if (normalizeV10Text(f.subject) !== normalizeV10Text(candidate.subject)) return false;
      if (f.predicate !== candidate.predicate) return false;
      if (normalizeV10Text(f.object) !== normObject) return false;
      if (scope && !scopeMatches(f.scope, scope)) return false;
      return true;
    });
  }

  /** Lọc fact theo filter (không lọc theo thời gian). */
  query(filter: V10FactFilter = {}): V10Fact[] {
    return this.facts.filter((f) => {
      if (filter.status && f.status !== filter.status) return false;
      if (filter.subject && normalizeV10Text(f.subject) !== normalizeV10Text(filter.subject)) return false;
      if (filter.predicate && f.predicate !== filter.predicate) return false;
      if (filter.scope && !scopeMatches(f.scope, filter.scope)) return false;
      if (filter.objectContains && !normalizeV10Text(f.object).includes(normalizeV10Text(filter.objectContains))) return false;
      return true;
    }).map((f) => ({ ...f }));
  }

  /**
   * Truy vấn "đúng tại thời điểm X": chỉ fact active VÀ nằm trong
   * cửa sổ validity tại X (vd "sống ở đâu vào tháng 3/2026").
   * Mặc định asOf = bây giờ ("ở đâu bây giờ").
   */
  queryAt(at: Date, filter: V10FactFilter = {}): V10Fact[] {
    return this.query(filter).filter((f) => isV10FactValidAt(f, at));
  }

  /** Fact hệ thống ĐÃ BIẾT tại thời điểm X (trục transaction time):
   *  learnedAt <= X, bất kể validity. Dùng để trả lời "hôm qua hệ
   *  thống biết gì về user" — khác với queryAt (đúng trong thế giới). */
  queryKnownAt(at: Date, filter: V10FactFilter = {}): V10Fact[] {
    return this.query(filter).filter((f) => isV10FactKnownAt(f, at));
  }

  /** Fact đang đúng bây giờ (tiện ích cho retrieval mặc định). */
  queryNow(filter: V10FactFilter = {}): V10Fact[] {
    return this.queryAt(new Date(), filter);
  }

  /**
   * Tăng confidence của một fact đã có vì nó vừa được nhắc lại.
   * Chỉ đổi confidence + updatedAt — KHÔNG đổi validity, status hay
   * provenance. Đây là đường duy nhất để sửa confidence mà không
   * qua supersede, để tránh ghi đè lặng lẽ từ bên ngoài.
   */
  bumpConfidence(id: string, confidence: number): V10Fact | null {
    const fact = this.facts.find((f) => f.id === id);
    if (!fact) return null;
    fact.confidence = Math.min(0.99, Math.max(0, confidence));
    fact.updatedAt = new Date().toISOString();
    return { ...fact };
  }

  /**
   * Timeline của một subject: mọi fact của subject đó theo thứ tự
   * validFrom, kèm fact thay thế (nếu có). UI vẽ trục thời gian từ đây.
   */
  timeline(subject: string, scope?: Partial<MemoryScope>): V10TimelineEntry[] {
    const facts = this.query({ subject, scope }).sort(
      (a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom),
    );
    return facts.map((f) => {
      const entry: V10TimelineEntry = {
        fact: f,
        startsAt: f.validFrom,
        endsAt: f.validUntil,
      };
      if (f.supersededBy) {
        const replacement = this.getFact(f.supersededBy);
        if (replacement) entry.replacedBy = replacement;
      }
      return entry;
    });
  }

  /** Text tìm kiếm của một fact (cho BM25 / embedding). */
  static searchText(fact: V10Fact): string {
    return v10FactSearchText(fact);
  }

  /** Ghi toàn bộ fact xuống file JSON (persist thô). */
  saveToFile(filePath: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: { version: 1; facts: V10Fact[]; savedAt: string } = {
      version: 1,
      facts: this.facts,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  /** Đọc file JSON đã lưu (file không có/hỏng → graph rỗng). */
  static loadFromFile(filePath: string): BiTemporalGraphV10 {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { facts?: V10Fact[] };
      if (!Array.isArray(parsed.facts)) return new BiTemporalGraphV10();
      return new BiTemporalGraphV10(parsed.facts);
    } catch {
      return new BiTemporalGraphV10();
    }
  }

  /** Nạp fact từ V10MemoryFile (manager dùng khi load toàn bộ). */
  static fromMemoryFile(file: V10MemoryFile): BiTemporalGraphV10 {
    return new BiTemporalGraphV10(file.facts);
  }
}
