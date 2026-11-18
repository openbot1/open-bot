/**
 * Memory v21 — Deletion tombstones (kieu Portable Memory).
 *
 * Y tuong hoc tu MacPaw Portable Memory: xoa khong phai la mat
 * han — he ghi tombstone (ai xoa, khi nao, vi sao, version cuoi,
 * hash noi dung cuoi, snapshot de restore) de audit trail con
 * nguyen. Tu thiet ke lai hoan toan cho open-bot, KHONG copy
 * code/text/tai san cua bat ky repo nao.
 *
 * Phan biet ro:
 *  - Tombstone (mem xoa): giu audit + snapshot, restore duoc.
 *  - Purge (xoa cung): chi xoa snapshot sau thoi gian luu giu,
 *    tombstone van giu lai (khong co noi dung) de lich su xoa
 *    khong mat. Purge khong phai GDPR erase (v18 co erase
 *    rieng, xoa ca audit theo yeu cau phap ly).
 */
import type {
  V21PortableFormat,
  V21PortableRecord,
  V21Result,
  V21Tombstone,
} from './types';
import { V21_TOMBSTONE_MIN_RETENTION_DAYS } from './types';
import { hashRecordV21 } from './okfFormat';

export interface V21TombstoneAuditEntry {
  at: number;
  action: 'tombstone_created' | 'restored' | 'snapshot_purged' | 'tombstone_expired';
  recordId: string;
  by: string;
  detail: string;
}

export interface V21PurgeResult {
  purgedSnapshots: string[];
  kept: string[];
  skippedTooRecent: string[];
}

/** Store tombstone trong bo nho + audit append-only. */
export class V21TombstoneStore {
  private tombstones = new Map<string, V21Tombstone>();
  private audit: V21TombstoneAuditEntry[] = [];

  size(): number {
    return this.tombstones.size;
  }

  /** Tao tombstone cho mot record (snapshot giu lai de restore). */
  create(
    record: V21PortableRecord,
    by: string,
    reason: string,
    format: V21PortableFormat = 'okf',
    originalPath?: string,
  ): V21Result<V21Tombstone> {
    if (!reason || reason.trim().length < 3) {
      return { ok: false, error: 'can ly do xoa (toi thieu 3 ky tu)', errorCode: 'invalid_args' };
    }
    if (this.tombstones.has(record.id)) {
      return { ok: false, error: `record "${record.id}" da co tombstone`, errorCode: 'duplicate_id' };
    }
    const tombstone: V21Tombstone = {
      recordId: record.id,
      format,
      originalPath,
      previousVersion: record.version,
      previousHash: hashRecordV21(record),
      snapshot: { ...record, tags: [...record.tags], sources: [...record.sources], codeRefs: [...record.codeRefs] },
      deletedAt: Date.now(),
      deletedBy: by,
      reason: reason.trim(),
    };
    this.tombstones.set(record.id, tombstone);
    this.audit.push({
      at: tombstone.deletedAt,
      action: 'tombstone_created',
      recordId: record.id,
      by,
      detail: `xoa ${record.id} v${record.version} (ly do: ${reason.trim()})`,
    });
    return { ok: true, data: { ...tombstone } };
  }

  get(recordId: string): V21Tombstone | undefined {
    const found = this.tombstones.get(recordId);
    if (!found) return undefined;
    return { ...found, snapshot: found.snapshot ? { ...found.snapshot } : undefined };
  }

  has(recordId: string): boolean {
    return this.tombstones.has(recordId);
  }

  list(): V21Tombstone[] {
    return [...this.tombstones.values()]
      .sort((a, b) => b.deletedAt - a.deletedAt)
      .map((t) => ({ ...t, snapshot: t.snapshot ? { ...t.snapshot } : undefined }));
  }

  /** Lay snapshot de restore (undefined neu da purge). */
  getSnapshot(recordId: string): V21PortableRecord | undefined {
    const found = this.tombstones.get(recordId);
    if (!found?.snapshot) return undefined;
    const snap = found.snapshot;
    return { ...snap, tags: [...snap.tags], sources: [...snap.sources], codeRefs: [...snap.codeRefs] };
  }

  /** Khoi phuc: xoa tombstone, tra snapshot cho caller tao lai record. */
  restore(recordId: string, by = 'system'): V21Result<V21PortableRecord> {
    const found = this.tombstones.get(recordId);
    if (!found) return { ok: false, error: `khong co tombstone cho "${recordId}"`, errorCode: 'missing_file' };
    if (!found.snapshot) {
      return { ok: false, error: `tombstone "${recordId}" da bi purge snapshot — khong restore duoc`, errorCode: 'missing_file' };
    }
    const snapshot = this.getSnapshot(recordId) as V21PortableRecord;
    this.tombstones.delete(recordId);
    this.audit.push({
      at: Date.now(),
      action: 'restored',
      recordId,
      by,
      detail: `khoi phuc ${recordId} tu tombstone (v${found.previousVersion})`,
    });
    return { ok: true, data: snapshot };
  }

  auditLog(): V21TombstoneAuditEntry[] {
    return this.audit.map((e) => ({ ...e }));
  }

  auditFor(recordId: string): V21TombstoneAuditEntry[] {
    return this.audit.filter((e) => e.recordId === recordId).map((e) => ({ ...e }));
  }

  /**
   * Purge snapshot cua tombstone qua han luu giu. Tombstone (ban
   * ghi xoa) VAN GIU — chi xoa noi dung snapshot de tiet kiem
   * dung luong; lich su xoa khong mat. Tombstone chua du tuoi
   * hoac da purge roi thi bo qua.
   */
  purgeExpiredSnapshots(retentionDays = V21_TOMBSTONE_MIN_RETENTION_DAYS, now = Date.now()): V21PurgeResult {
    const result: V21PurgeResult = { purgedSnapshots: [], kept: [], skippedTooRecent: [] };
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    for (const [id, tomb] of this.tombstones) {
      if (!tomb.snapshot) {
        result.kept.push(id);
        continue;
      }
      if (tomb.deletedAt > cutoff) {
        result.skippedTooRecent.push(id);
        continue;
      }
      this.tombstones.set(id, { ...tomb, snapshot: undefined });
      result.purgedSnapshots.push(id);
      this.audit.push({
        at: now,
        action: 'snapshot_purged',
        recordId: id,
        by: 'system',
        detail: `purge snapshot cua tombstone ${id} (xoa ${new Date(tomb.deletedAt).toISOString()}, giu ${retentionDays} ngay)`,
      });
    }
    return result;
  }

  /** Xuat toan bo tombstone + audit ra JSON (de backup). */
  exportJson(): { tombstones: V21Tombstone[]; audit: V21TombstoneAuditEntry[] } {
    return { tombstones: this.list(), audit: this.auditLog() };
  }

  static importJson(data: { tombstones: V21Tombstone[]; audit: V21TombstoneAuditEntry[] }): V21TombstoneStore {
    const store = new V21TombstoneStore();
    for (const tomb of data.tombstones ?? []) {
      store.tombstones.set(tomb.recordId, { ...tomb });
    }
    store.audit = (data.audit ?? []).map((e) => ({ ...e }));
    return store;
  }
}

/** Tao tombstone truc tiep tu record + ly do (khong can store). */
export function createTombstoneV21(
  record: V21PortableRecord,
  by: string,
  reason: string,
  format: V21PortableFormat = 'okf',
  originalPath?: string,
  now = Date.now(),
): V21Result<V21Tombstone> {
  if (!reason || reason.trim().length < 3) {
    return { ok: false, error: 'can ly do xoa (toi thieu 3 ky tu)', errorCode: 'invalid_args' };
  }
  return {
    ok: true,
    data: {
      recordId: record.id,
      format,
      originalPath,
      previousVersion: record.version,
      previousHash: hashRecordV21(record),
      snapshot: { ...record, tags: [...record.tags], sources: [...record.sources], codeRefs: [...record.codeRefs] },
      deletedAt: now,
      deletedBy: by,
      reason: reason.trim(),
    },
  };
}
