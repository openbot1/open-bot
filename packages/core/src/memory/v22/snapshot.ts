/**
 * Memory v22 — Snapshot + audit log: moi thay doi revert duoc
 * (v1.37, Doi T1).
 *
 * Y tuong (Anthropic Dreams "sua ghi chu sai" + bai Agent Memory
 * Consolidation "phai kiem chung duoc job da lam gi"): dream
 * chi duoc phep sua memory khi truoc do da chup snapshot day du
 * va moi thay doi deu ghi vao audit log append-only. Rollback
 * khoi phuc DUNG snapshot (fact + wiki), khong viet lai lich su:
 * ban than rollback cung la mot muc audit moi.
 *
 *  - `V22SnapshotStore`: giu toi da 50 snapshot (cu nhat tu
 *    roi khi day, co dem so snapshot da roi de bao cao).
 *  - Hash toan ven: FNV-1a 32-bit tren JSON (facts + wiki) —
 *    du de phat hien snapshot hong / bi sua tay, khong phai
 *    hash mat ma (khong dung de chong tan cong).
 *  - `V22AuditLog`: append-only, giu toi da 2000 muc (cu nhat
 *    tu roi, co dem). Loc theo actor / action / factId /
 *    khoang thoi gian.
 */
import { createHash } from 'node:crypto';
import type { V22AuditEntry, V22DreamFact, V22Snapshot, V22WikiIndex } from './types';
import { V22_MAX_AUDIT_ENTRIES, V22_MAX_SNAPSHOTS } from './types';
import { cloneDreamFactV22, type V22DreamStore } from './store';

/** Hash toan ven SHA-256 tren JSON (de phat hien snapshot hong). */
export function hashSnapshotContentV22(facts: V22DreamFact[], wiki?: V22WikiIndex): string {
  const payload = JSON.stringify({ facts, wiki: wiki ?? null });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Kiem tra snapshot con nguyen ven (hash khop noi dung). */
export function verifySnapshotV22(snapshot: V22Snapshot): boolean {
  return hashSnapshotContentV22(snapshot.facts, snapshot.wiki) === snapshot.hash;
}

/** Store snapshot (trong bo nho). */
export class V22SnapshotStore {
  private snapshots = new Map<string, V22Snapshot>();
  private order: string[] = [];
  private seq = 0;
  private dropped = 0;

  /** So snapshot dang giu. */
  size(): number {
    return this.snapshots.size;
  }

  /** So snapshot cu da tu roi do day gioi han. */
  droppedCount(): number {
    return this.dropped;
  }

  get(id: string): V22Snapshot | undefined {
    const snap = this.snapshots.get(id);
    return snap ? cloneSnapshotV22(snap) : undefined;
  }

  /** Snapshot moi nhat (neu co). */
  latest(): V22Snapshot | undefined {
    const lastId = this.order[this.order.length - 1];
    return lastId ? this.get(lastId) : undefined;
  }

  /** Liet ke snapshot (moi nhat truoc). */
  list(): V22Snapshot[] {
    return [...this.order].reverse().map((id) => this.get(id) as V22Snapshot);
  }

  /**
   * Chup snapshot toan bo store + wiki hien tai. Tra snapshot
   * (ban sao sau — sua store sau do khong anh huong snapshot).
   */
  create(
    store: V22DreamStore,
    opts: { actor?: string; reason?: string; wiki?: V22WikiIndex; label?: string; now?: number } = {},
  ): V22Snapshot {
    const now = opts.now ?? Date.now();
    this.seq += 1;
    const id = `snap-${now}-${this.seq}`;
    const facts = store.list().map((f) => cloneDreamFactV22(f));
    const wiki = opts.wiki ? cloneWikiIndexV22(opts.wiki) : undefined;
    const snapshot: V22Snapshot = {
      id,
      createdAt: now,
      actor: opts.actor ?? 'dream:v22',
      reason: opts.reason ?? 'snapshot truoc dream',
      facts,
      ...(wiki ? { wiki } : {}),
      hash: hashSnapshotContentV22(facts, wiki),
      ...(opts.label ? { label: opts.label } : {}),
    };
    this.snapshots.set(id, snapshot);
    this.order.push(id);
    while (this.order.length > V22_MAX_SNAPSHOTS) {
      const oldest = this.order.shift() as string;
      this.snapshots.delete(oldest);
      this.dropped += 1;
    }
    return cloneSnapshotV22(snapshot);
  }

  /**
   * Khoi phuc store (+ wiki) ve dung snapshot: fact trong store
   * duoc thay bang ban sao trong snapshot; fact tao sau snapshot
   * se bien mat khoi store (nhung van con trong audit log de
   * truy vet). Tra so fact da khoi phuc, hoac loi khi snapshot
   * khong co / hong hash.
   */
  restore(
    store: V22DreamStore,
    snapshotId: string,
  ): { ok: boolean; restoredFacts?: number; wikiRestored?: boolean; error?: string } {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      return { ok: false, error: `khong co snapshot "${snapshotId}".` };
    }
    if (!verifySnapshotV22(snapshot)) {
      return { ok: false, error: `snapshot "${snapshotId}" hong hash toan ven — khong rollback de tranh mat du lieu.` };
    }
    const imported = store.importState({ facts: snapshot.facts.map((f) => cloneDreamFactV22(f)) });
    return {
      ok: true,
      restoredFacts: imported.imported,
      wikiRestored: snapshot.wiki !== undefined,
    };
  }

  /** Xuat toan bo snapshot (JSON-safe) de luu tru / nap lai. */
  exportState(): { snapshots: V22Snapshot[]; seq: number } {
    return {
      snapshots: this.list().map((s) => cloneSnapshotV22(s)),
      seq: this.seq,
    };
  }

  /**
   * Nap lai snapshot da xuat (ghi de). Snapshot hong hash thi
   * bo qua co dem (khong crash ca lan nap).
   */
  importState(state: { snapshots: V22Snapshot[]; seq?: number }): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;
    const next = new Map<string, V22Snapshot>();
    const order: string[] = [];
    for (const raw of state.snapshots ?? []) {
      if (typeof raw === 'object' && raw !== null && typeof raw.id === 'string' && Array.isArray(raw.facts) && typeof raw.hash === 'string') {
        const snap = cloneSnapshotV22(raw as V22Snapshot);
        if (!verifySnapshotV22(snap)) {
          skipped += 1;
          continue;
        }
        next.set(snap.id, snap);
        order.push(snap.id);
        imported += 1;
      } else {
        skipped += 1;
      }
    }
    // Giu thu tu cu -> moi (exportState tra moi nhat truoc).
    this.order = [...order].reverse();
    this.snapshots = next;
    this.seq = Math.max(this.seq, state.seq ?? 0, imported);
    while (this.order.length > V22_MAX_SNAPSHOTS) {
      const oldest = this.order.shift() as string;
      this.snapshots.delete(oldest);
      this.dropped += 1;
    }
    return { imported, skipped };
  }

  /** Xoa mot snapshot (chi dung khi user chu dich xoa lich su). */
  delete(id: string): boolean {
    if (!this.snapshots.has(id)) return false;
    this.snapshots.delete(id);
    this.order = this.order.filter((x) => x !== id);
    return true;
  }
}

/** Deep copy mot snapshot. */
export function cloneSnapshotV22(snapshot: V22Snapshot): V22Snapshot {
  return {
    ...snapshot,
    facts: snapshot.facts.map((f) => cloneDreamFactV22(f)),
    ...(snapshot.wiki ? { wiki: cloneWikiIndexV22(snapshot.wiki) } : {}),
  };
}

/** Deep copy mot wiki index. */
export function cloneWikiIndexV22(wiki: V22WikiIndex): V22WikiIndex {
  return {
    ...wiki,
    pages: wiki.pages.map((p) => ({
      ...p,
      factIds: [...p.factIds],
      links: p.links.map((l) => ({ ...l })),
    })),
  };
}

/** Bo loc khi doc audit log. */
export interface V22AuditFilter {
  actor?: string;
  action?: string;
  factId?: string;
  snapshotId?: string;
  from?: number;
  to?: number;
  limit?: number;
}

/** Audit log append-only (trong bo nho). */
export class V22AuditLog {
  private entries: V22AuditEntry[] = [];
  private seq = 0;
  private dropped = 0;

  /** Tong so muc dang giu. */
  size(): number {
    return this.entries.length;
  }

  /** So muc cu da tu roi do day gioi han. */
  droppedCount(): number {
    return this.dropped;
  }

  /** Them mot muc audit (tra muc vua them). */
  append(
    entry: Omit<V22AuditEntry, 'id' | 'at'> & { at?: number },
  ): V22AuditEntry {
    this.seq += 1;
    const record: V22AuditEntry = {
      id: `audit-${this.seq}`,
      at: entry.at ?? Date.now(),
      actor: entry.actor,
      action: entry.action,
      factIds: [...entry.factIds],
      ...(entry.snapshotId ? { snapshotId: entry.snapshotId } : {}),
      detail: entry.detail,
    };
    this.entries.push(record);
    while (this.entries.length > V22_MAX_AUDIT_ENTRIES) {
      this.entries.shift();
      this.dropped += 1;
    }
    return { ...record, factIds: [...record.factIds] };
  }

  /** Doc audit log theo bo loc (moi nhat truoc). */
  list(filter: V22AuditFilter = {}): V22AuditEntry[] {
    const out = this.entries.filter((e) => {
      if (filter.actor !== undefined && e.actor !== filter.actor) return false;
      if (filter.action !== undefined && e.action !== filter.action) return false;
      if (filter.factId !== undefined && !e.factIds.includes(filter.factId)) return false;
      if (filter.snapshotId !== undefined && e.snapshotId !== filter.snapshotId) return false;
      if (filter.from !== undefined && e.at < filter.from) return false;
      if (filter.to !== undefined && e.at > filter.to) return false;
      return true;
    });
    const sorted = [...out].sort((a, b) => b.at - a.at);
    const limited = filter.limit !== undefined ? sorted.slice(0, filter.limit) : sorted;
    return limited.map((e) => ({ ...e, factIds: [...e.factIds] }));
  }

  /** Xuat toan bo audit log (JSON-safe) de luu tru. */
  exportAll(): V22AuditEntry[] {
    return this.list();
  }

  /** Nap lai audit log (ghi de). */
  importAll(entries: V22AuditEntry[]): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;
    const next: V22AuditEntry[] = [];
    for (const raw of entries ?? []) {
      if (
        typeof raw === 'object' && raw !== null
        && typeof (raw as V22AuditEntry).action === 'string'
        && typeof (raw as V22AuditEntry).actor === 'string'
        && Array.isArray((raw as V22AuditEntry).factIds)
      ) {
        next.push({ ...(raw as V22AuditEntry), factIds: [...(raw as V22AuditEntry).factIds] });
        imported += 1;
      } else {
        skipped += 1;
      }
    }
    this.entries = next.slice(-V22_MAX_AUDIT_ENTRIES);
    this.seq = Math.max(this.seq, imported);
    return { imported, skipped };
  }
}
