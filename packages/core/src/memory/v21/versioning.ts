/**
 * Memory v21 — Versioning + record store co lich su.
 *
 * Moi record co version tang dan + hash noi dung + lich su
 * append-only (khong bao gio viet lai). Store giu ban ghi hien
 * tai + toan bo lich su; rollback tao version MOI copy noi dung
 * cu (giong v20), xoa thi ghi tombstone (xem tombstones.ts).
 * Diff theo dong tai su dung `diffLinesV20` cua v20.
 */
import type {
  V21ChangeKind,
  V21PortableRecord,
  V21RecordVersion,
  V21Result,
} from './types';
import { hashRecordV21 } from './okfFormat';
import { diffLinesV20, type V20VersionDiffLine } from '../v20/blockVersioning';

export interface V21RecordVersionSummary {
  recordId: string;
  currentVersion: number;
  totalVersions: number;
  firstAt: number;
  lastAt: number;
  lastBy: string;
  lastChange: V21ChangeKind;
  lastSummary: string;
  deleted: boolean;
}

/** Lich su append-only cho nhieu record (serializable JSON). */
export class V21VersionLog {
  private entries = new Map<string, V21RecordVersion[]>();

  record(change: Omit<V21RecordVersion, 'hash'> & { hash?: string }): V21RecordVersion {
    const hash = change.hash ?? hashContentOfV21(change.recordId, change.version, change.summary);
    const entry: V21RecordVersion = { ...change, hash };
    const list = this.entries.get(change.recordId) ?? [];
    list.push(entry);
    this.entries.set(change.recordId, list);
    return entry;
  }

  list(recordId: string): V21RecordVersion[] {
    return [...(this.entries.get(recordId) ?? [])].sort((a, b) => a.version - b.version);
  }

  get(recordId: string, version: number): V21RecordVersion | undefined {
    return this.list(recordId).find((e) => e.version === version);
  }

  latest(recordId: string): V21RecordVersion | undefined {
    const list = this.list(recordId);
    return list[list.length - 1];
  }

  count(recordId: string): number {
    return this.entries.get(recordId)?.length ?? 0;
  }

  recordIds(): string[] {
    return [...this.entries.keys()].sort();
  }

  summary(recordId: string): V21RecordVersionSummary | undefined {
    const list = this.list(recordId);
    if (list.length === 0) return undefined;
    const first = list[0];
    const last = list[list.length - 1];
    return {
      recordId,
      currentVersion: last.version,
      totalVersions: list.length,
      firstAt: first.at,
      lastAt: last.at,
      lastBy: last.by,
      lastChange: last.change,
      lastSummary: last.summary,
      deleted: last.change === 'delete',
    };
  }

  toJSON(): V21RecordVersion[] {
    const out: V21RecordVersion[] = [];
    for (const id of this.recordIds()) out.push(...this.list(id));
    return out;
  }

  static fromJSON(entries: V21RecordVersion[]): V21VersionLog {
    const log = new V21VersionLog();
    for (const entry of entries) {
      const list = log.entries.get(entry.recordId) ?? [];
      list.push({ ...entry });
      log.entries.set(entry.recordId, list);
    }
    return log;
  }
}

function hashContentOfV21(recordId: string, version: number, summary: string): string {
  return hashRecordV21({
    id: recordId,
    type: 'note',
    title: '',
    body: `${version}:${summary}`,
    tags: [],
    sources: [],
    codeRefs: [],
    version,
    createdAt: 0,
    updatedAt: 0,
  });
}

export interface V21RecordDiff {
  recordId: string;
  fromVersion: number;
  toVersion: number;
  lines: V20VersionDiffLine[];
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
}

/**
 * Store record portable trong bo nho: CRUD + versioning + lich su
 * + diff + rollback. Xoa qua `deleteRecord` se tao tombstone o
 * lop tombstones.ts (store nay chi danh dau deleted + giu snapshot
 * trong lich su de rollback duoc).
 */
export class V21RecordStore {
  private records = new Map<string, V21PortableRecord>();
  private snapshots = new Map<string, Map<number, V21PortableRecord>>();
  private deleted = new Set<string>();
  readonly versions = new V21VersionLog();

  size(includeDeleted = false): number {
    if (includeDeleted) return this.records.size;
    return [...this.records.values()].filter((r) => !this.deleted.has(r.id)).length;
  }

  get(id: string): V21PortableRecord | undefined {
    const record = this.records.get(id);
    if (!record || this.deleted.has(id)) return undefined;
    return { ...record, tags: [...record.tags], sources: [...record.sources], codeRefs: [...record.codeRefs] };
  }

  getIncludingDeleted(id: string): V21PortableRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    return { ...record, tags: [...record.tags], sources: [...record.sources], codeRefs: [...record.codeRefs] };
  }

  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  list(includeDeleted = false): V21PortableRecord[] {
    const all = [...this.records.values()]
      .filter((r) => includeDeleted || !this.deleted.has(r.id))
      .sort((a, b) => a.title.localeCompare(b.title));
    return all.map((r) => ({ ...r, tags: [...r.tags], sources: [...r.sources], codeRefs: [...r.codeRefs] }));
  }

  create(record: V21PortableRecord, by = 'system', change: V21ChangeKind = 'create'): V21Result<V21PortableRecord> {
    if (this.records.has(record.id) && !this.deleted.has(record.id)) {
      return { ok: false, error: `da co record "${record.id}"`, errorCode: 'duplicate_id' };
    }
    const now = Date.now();
    const stored: V21PortableRecord = {
      ...record,
      tags: [...record.tags],
      sources: [...record.sources],
      codeRefs: [...record.codeRefs],
      version: 1,
      createdAt: record.createdAt || now,
      updatedAt: now,
    };
    this.records.set(stored.id, stored);
    this.deleted.delete(stored.id);
    this.saveSnapshot(stored);
    this.versions.record({
      recordId: stored.id,
      version: 1,
      hash: hashRecordV21(stored),
      at: now,
      by,
      change,
      summary: change === 'import' ? `import record ${stored.id}` : `tao record ${stored.id}`,
      parentVersion: 0,
    });
    return { ok: true, data: { ...stored } };
  }

  update(
    id: string,
    patch: Partial<Omit<V21PortableRecord, 'id' | 'version' | 'createdAt'>>,
    by = 'system',
    change: V21ChangeKind = 'update',
  ): V21Result<V21PortableRecord> {
    const current = this.records.get(id);
    if (!current || this.deleted.has(id)) {
      return { ok: false, error: `khong tim thay record "${id}"`, errorCode: 'missing_file' };
    }
    const next: V21PortableRecord = {
      ...current,
      ...patch,
      id: current.id,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      tags: patch.tags ? [...patch.tags] : [...current.tags],
      sources: patch.sources ? [...patch.sources] : [...current.sources],
      codeRefs: patch.codeRefs ? [...patch.codeRefs] : [...current.codeRefs],
    };
    this.records.set(id, next);
    this.saveSnapshot(next);
    this.versions.record({
      recordId: id,
      version: next.version,
      hash: hashRecordV21(next),
      at: next.updatedAt,
      by,
      change,
      summary: `cap nhat record ${id} len v${next.version}`,
      parentVersion: current.version,
    });
    return { ok: true, data: { ...next } };
  }

  /** Xoa mem (soft): danh dau deleted, giu snapshot + lich su. */
  delete(id: string, by = 'system', reason = ''): V21Result<V21PortableRecord> {
    const current = this.records.get(id);
    if (!current || this.deleted.has(id)) {
      return { ok: false, error: `khong tim thay record "${id}"`, errorCode: 'missing_file' };
    }
    if (!reason || reason.trim().length < 3) {
      return { ok: false, error: 'can ly do xoa (toi thieu 3 ky tu)', errorCode: 'invalid_args' };
    }
    this.deleted.add(id);
    const next: V21PortableRecord = { ...current, version: current.version + 1, updatedAt: Date.now() };
    this.records.set(id, next);
    this.saveSnapshot(next);
    this.versions.record({
      recordId: id,
      version: next.version,
      hash: hashRecordV21(next),
      at: next.updatedAt,
      by,
      change: 'delete',
      summary: `xoa record ${id} (tombstone, ly do: ${reason.trim()})`,
      parentVersion: current.version,
    });
    return { ok: true, data: { ...next } };
  }

  /** Khoi phuc record da xoa mem: tao version moi, mo co deleted. */
  restore(id: string, by = 'system'): V21Result<V21PortableRecord> {
    const current = this.records.get(id);
    if (!current || !this.deleted.has(id)) {
      return { ok: false, error: `record "${id}" khong o trang thai da xoa`, errorCode: 'invalid_args' };
    }
    this.deleted.delete(id);
    const next: V21PortableRecord = { ...current, version: current.version + 1, updatedAt: Date.now() };
    this.records.set(id, next);
    this.saveSnapshot(next);
    this.versions.record({
      recordId: id,
      version: next.version,
      hash: hashRecordV21(next),
      at: next.updatedAt,
      by,
      change: 'restore',
      summary: `khoi phuc record ${id} tu tombstone`,
      parentVersion: current.version,
    });
    return { ok: true, data: { ...next } };
  }

  /** Rollback ve snapshot version cu: tao version MOI, lich su con nguyen. */
  rollback(id: string, targetVersion: number, by = 'system', reason = ''): V21Result<V21PortableRecord> {
    const current = this.records.get(id);
    if (!current || this.deleted.has(id)) {
      return { ok: false, error: `khong tim thay record "${id}"`, errorCode: 'missing_file' };
    }
    if (!reason || reason.trim().length < 3) {
      return { ok: false, error: 'can ly do rollback (toi thieu 3 ky tu)', errorCode: 'invalid_args' };
    }
    if (current.version === targetVersion) {
      return { ok: false, error: `record "${id}" dang o version ${targetVersion}`, errorCode: 'invalid_args' };
    }
    const snapshot = this.snapshots.get(id)?.get(targetVersion);
    if (!snapshot) {
      return { ok: false, error: `record "${id}" khong co version ${targetVersion}`, errorCode: 'bad_version' };
    }
    const next: V21PortableRecord = {
      ...snapshot,
      tags: [...snapshot.tags],
      sources: [...snapshot.sources],
      codeRefs: [...snapshot.codeRefs],
      version: current.version + 1,
      updatedAt: Date.now(),
    };
    this.records.set(id, next);
    this.saveSnapshot(next);
    this.versions.record({
      recordId: id,
      version: next.version,
      hash: hashRecordV21(next),
      at: next.updatedAt,
      by,
      change: 'update',
      summary: `rollback record ${id} ve v${targetVersion} (ly do: ${reason.trim()})`,
      parentVersion: current.version,
    });
    return { ok: true, data: { ...next } };
  }

  getVersionContent(id: string, version: number): V21PortableRecord | undefined {
    const snap = this.snapshots.get(id)?.get(version);
    if (!snap) return undefined;
    return { ...snap, tags: [...snap.tags], sources: [...snap.sources], codeRefs: [...snap.codeRefs] };
  }

  listVersions(id: string): V21RecordVersion[] {
    return this.versions.list(id);
  }

  diffVersions(id: string, fromVersion: number, toVersion: number): V21Result<V21RecordDiff> {
    const from = this.getVersionContent(id, fromVersion);
    const to = this.getVersionContent(id, toVersion);
    if (!from) return { ok: false, error: `record "${id}" khong co version ${fromVersion}`, errorCode: 'bad_version' };
    if (!to) return { ok: false, error: `record "${id}" khong co version ${toVersion}`, errorCode: 'bad_version' };
    const a = from.body.split('\n');
    const b = to.body.split('\n');
    const lines = diffLinesV20(a, b);
    let addedCount = 0;
    let removedCount = 0;
    let unchangedCount = 0;
    for (const line of lines) {
      if (line.kind === 'added') addedCount += 1;
      else if (line.kind === 'removed') removedCount += 1;
      else unchangedCount += 1;
    }
    return { ok: true, data: { recordId: id, fromVersion, toVersion, lines, addedCount, removedCount, unchangedCount } };
  }

  summary(id: string): V21RecordVersionSummary | undefined {
    return this.versions.summary(id);
  }

  private saveSnapshot(record: V21PortableRecord): void {
    const perRecord = this.snapshots.get(record.id) ?? new Map<number, V21PortableRecord>();
    perRecord.set(record.version, {
      ...record,
      tags: [...record.tags],
      sources: [...record.sources],
      codeRefs: [...record.codeRefs],
    });
    this.snapshots.set(record.id, perRecord);
  }
}
