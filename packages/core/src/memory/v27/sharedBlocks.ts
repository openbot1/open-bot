/**
 * Memory v27 — shared memory block bi-temporal (v1.42, Doi T3).
 *
 * Y tuong hoc tu Letta (survey v142 muc 3): memory block chia
 * se giua nhieu agent, cap nhat cho tat ca cung luc. Tu thiet
 * ke lai hoan toan cho open-bot, xay TREN NEN v26 (khong sua
 * code v26): block goc van do V26Store quan ly (registry +
 * audit + conflict + budget), v27 them lop bi-temporal:
 *
 *   - Timeline: moi lan cap nhat block ghi 1 entry (validFrom /
 *     validTo + version + by + factIds). Entry cu DONG validTo
 *     chu khong xoa — valueAt(X) dung lai gia tri block tai X.
 *   - Sync log: moi lan cap nhat ghi 1 muc cho MOI agent attach
 *     (append-only) — chung minh cap nhat toi tat ca cung luc,
 *     cung gia tri (doc chung 1 store, khong copy rieng).
 *   - Append fact: fact v27 moi co the duoc "gan" vao block:
 *     timeline entry moi ghi them factIds + value block duoc
 *     noi them dong fact (neu chua co).
 *
 * Block chi doc (readOnly) hoac het quota thi cap nhat bi tu
 * choi o lop v26 — v27 khong vuot qua quy tac do.
 */
import {
  errV27,
  isoAtV27,
  makeV27Id,
  okV27,
  truncateV27,
  V27_LIMITS,
  type V27BlockRegistration,
  type V27BlockSyncEntry,
  type V27BlockTimelineEntry,
  type V27BlockUpdateResult,
  type V27Result,
} from './types';
import { parseIsoV25, type V25Scope } from '../v25/types';
import type { V26Store } from '../v26/store';
import type { V25SharedBlock } from '../v25/types';

/** Lop bi-temporal tren V26Store (khong sua code v26). */
export class V27SharedBlockLayer {
  private readonly timeline = new Map<string, V27BlockTimelineEntry[]>();
  private readonly syncLog = new Map<string, V27BlockSyncEntry[]>();
  private readonly registeredAt = new Map<string, string>();

  constructor(private readonly v26: V26Store) {}

  /** So block da dang ky lop bi-temporal. */
  get registeredCount(): number {
    return this.registeredAt.size;
  }

  /** Tong so timeline entry. */
  get timelineTotal(): number {
    let n = 0;
    for (const list of this.timeline.values()) n += list.length;
    return n;
  }

  /** Tong so sync entry. */
  get syncTotal(): number {
    let n = 0;
    for (const list of this.syncLog.values()) n += list.length;
    return n;
  }

  /**
   * Dang ky block v26 lam block bi-temporal v27: tao timeline
   * entry dau tien tu value hien tai (validFrom = createdAt).
   */
  registerBlock(
    blockId: string,
    opts: { nowMs?: number } = {},
  ): V27Result<V27BlockRegistration> {
    const block = this.v26.listBlocks().find((b) => b.id === blockId);
    if (!block) return errV27(`Khong co block "${blockId}" trong store v26.`);
    if (this.registeredAt.has(blockId)) {
      return errV27(`Block "${block.label}" da dang ky lop bi-temporal v27.`);
    }
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV27(nowMs);
    const entry: V27BlockTimelineEntry = {
      id: makeV27Id('bt'),
      blockId,
      label: block.label,
      value: block.value,
      validFrom: block.createdAt,
      validTo: null,
      version: block.version,
      by: block.ownerBotId,
      reason: 'dang ky block bi-temporal v27 (gia tri khoi tao)',
      factIds: [],
      createdAt: nowIso,
    };
    this.timeline.set(blockId, [entry]);
    this.syncLog.set(blockId, []);
    this.registeredAt.set(blockId, nowIso);
    const regEntry = this.v26.registry.getEntry(blockId);
    return okV27({
      blockId,
      label: block.label,
      kind: regEntry?.kind ?? 'custom',
      ownerBotId: block.ownerBotId,
      attachedBotIds: [...block.attachedBotIds],
      timelineEntries: 1,
      registeredAt: nowIso,
    });
  }

  /** Block da dang ky lop bi-temporal chua? */
  isRegistered(blockId: string): boolean {
    return this.registeredAt.has(blockId);
  }

  /** Timeline day du cua 1 block (cu nhat truoc). */
  timelineFor(blockId: string): V27BlockTimelineEntry[] {
    const list = this.timeline.get(blockId) ?? [];
    return [...list].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
  }

  /** Sync log cua 1 block (moi nhat truoc). */
  syncLogFor(blockId: string, limit?: number): V27BlockSyncEntry[] {
    const list = [...(this.syncLog.get(blockId) ?? [])];
    list.sort((a, b) => (a.at < b.at ? 1 : -1));
    if (limit !== undefined) return list.slice(0, Math.max(0, limit));
    return list;
  }

  /**
   * Gia tri block tai thoi diem X (ISO): timeline entry nao co
   * validFrom <= X < validTo (validTo null = van hieu luc).
   * Tra '' neu block chua ton tai tai X.
   */
  valueAt(blockId: string, at: string): V27Result<string> {
    const parsed = parseIsoV25(at);
    if (!parsed) return errV27(`Thoi diem "${at}" khong phai ISO date hop le.`);
    const atMs = parsed.getTime();
    const entries = this.timelineFor(blockId);
    for (const entry of entries) {
      const fromMs = Date.parse(entry.validFrom);
      if (Number.isNaN(fromMs) || atMs < fromMs) continue;
      if (entry.validTo) {
        const toMs = Date.parse(entry.validTo);
        if (!Number.isNaN(toMs) && atMs >= toMs) continue;
      }
      return okV27(entry.value);
    }
    return okV27('');
  }

  /**
   * Cap nhat shared block — DONG BO cho moi agent attach.
   * Quy trinh: ghi vao v26 (registry.write — kiem tra version,
   * readOnly, audit) -> dong timeline entry cu (validTo = now)
   * -> them entry moi -> ghi sync log cho moi agent attach.
   * Moi agent attach doc cung 1 store nen thay cung gia tri ngay.
   */
  updateBlock(
    blockId: string,
    value: string,
    byBotId: string,
    opts: {
      nowMs?: number;
      reason?: string;
      expectedVersion?: number;
      factIds?: string[];
    } = {},
  ): V27Result<V27BlockUpdateResult> {
    const block = this.v26.listBlocks().find((b) => b.id === blockId);
    if (!block) return errV27(`Khong co block "${blockId}" trong store v26.`);
    if (!this.registeredAt.has(blockId)) {
      return errV27(`Block "${block.label}" chua dang ky lop bi-temporal v27 — dang ky truoc.`);
    }
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV27(nowMs);
    const entries = this.timeline.get(blockId) ?? [];
    if (entries.length >= V27_LIMITS.maxTimelineEntriesPerBlock) {
      return errV27(`Timeline block "${block.label}" da day (${V27_LIMITS.maxTimelineEntriesPerBlock} entry).`);
    }
    // Ghi vao v26 truoc — that bai (conflict/readOnly) thi dung.
    const written = this.v26.registry.write(blockId, value, byBotId, {
      nowMs,
      reason: opts.reason ?? 'v27 block update',
      ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
    });
    if (!written.ok) return errV27(written.error);
    const updated: V25SharedBlock = written.value.block;
    // Dong entry cu, them entry moi.
    const open = entries.find((e) => e.validTo === null);
    if (open) open.validTo = nowIso;
    const entry: V27BlockTimelineEntry = {
      id: makeV27Id('bt'),
      blockId,
      label: block.label,
      value,
      validFrom: nowIso,
      validTo: null,
      version: updated.version,
      by: byBotId,
      reason: opts.reason ?? 'v27 block update',
      factIds: [...(opts.factIds ?? [])],
      createdAt: nowIso,
    };
    entries.push(entry);
    this.timeline.set(blockId, entries);
    // Sync log: 1 muc cho moi agent attach (+ owner neu chua attach).
    const recipients = [...new Set([updated.ownerBotId, ...updated.attachedBotIds])];
    const syncEntries: V27BlockSyncEntry[] = [];
    const log = this.syncLog.get(blockId) ?? [];
    for (const agentId of recipients) {
      if (log.length >= V27_LIMITS.maxSyncLogPerBlock) break;
      const sync: V27BlockSyncEntry = {
        id: makeV27Id('sync'),
        blockId,
        label: block.label,
        timelineEntryId: entry.id,
        agentId,
        at: nowIso,
        applied: true,
      };
      log.push(sync);
      syncEntries.push(sync);
    }
    this.syncLog.set(blockId, log);
    return okV27({
      blockId,
      label: block.label,
      version: updated.version,
      timelineEntry: entry,
      syncedAgents: syncEntries.map((s) => s.agentId),
      syncEntries,
      attachedCount: updated.attachedBotIds.length,
    });
  }

  /**
   * Gan fact v27 vao block: noi them 1 dong fact vao value
   * block (neu dong do chua co) + ghi timeline entry moi.
   * Fact van nam trong graph — block chi giu ban sao hien thi.
   */
  appendFactToBlock(
    blockId: string,
    factLine: string,
    byBotId: string,
    opts: { nowMs?: number; factIds?: string[]; reason?: string } = {},
  ): V27Result<V27BlockUpdateResult> {
    const block = this.v26.listBlocks().find((b) => b.id === blockId);
    if (!block) return errV27(`Khong co block "${blockId}" trong store v26.`);
    const line = factLine.trim();
    if (!line) return errV27('Dong fact gan vao block khong duoc rong.');
    const current = block.value;
    const newValue = current.includes(line)
      ? current
      : `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}- ${line}`;
    return this.updateBlock(blockId, newValue, byBotId, {
      ...opts,
      reason: opts.reason ?? 'v27 append fact to block',
    });
  }

  /** Kiem tra 1 agent co thay gia tri moi nhat khong (doc chung store). */
  agentSeesLatest(blockId: string, agentId: string): V27Result<boolean> {
    const block = this.v26.listBlocks().find((b) => b.id === blockId);
    if (!block) return errV27(`Khong co block "${blockId}" trong store v26.`);
    const attached =
      block.attachedBotIds.includes(agentId) || block.ownerBotId === agentId;
    if (!attached) return okV27(false);
    const log = this.syncLog.get(blockId) ?? [];
    const latestEntry = (this.timeline.get(blockId) ?? []).find((e) => e.validTo === null);
    if (!latestEntry) return okV27(true);
    const seen = log.some(
      (s) => s.agentId === agentId && s.timelineEntryId === latestEntry.id && s.applied,
    );
    return okV27(seen);
  }

  /** Snapshot JSON cua lop bi-temporal (timeline + sync log). */
  toJSON(): {
    timeline: V27BlockTimelineEntry[];
    syncLog: V27BlockSyncEntry[];
    registeredAt: [string, string][];
  } {
    const timeline: V27BlockTimelineEntry[] = [];
    for (const list of this.timeline.values()) timeline.push(...list);
    const syncLog: V27BlockSyncEntry[] = [];
    for (const list of this.syncLog.values()) syncLog.push(...list);
    return { timeline, syncLog, registeredAt: [...this.registeredAt.entries()] };
  }

  static fromJSON(data: unknown, v26: V26Store): V27SharedBlockLayer {
    const layer = new V27SharedBlockLayer(v26);
    if (!data || typeof data !== 'object') return layer;
    const raw = data as {
      timeline?: unknown;
      syncLog?: unknown;
      registeredAt?: unknown;
    };
    if (Array.isArray(raw.timeline)) {
      for (const entry of raw.timeline as V27BlockTimelineEntry[]) {
        if (!entry || typeof entry.blockId !== 'string') continue;
        const list = layer.timeline.get(entry.blockId) ?? [];
        list.push({ ...entry, factIds: [...(entry.factIds ?? [])] });
        layer.timeline.set(entry.blockId, list);
      }
    }
    if (Array.isArray(raw.syncLog)) {
      for (const entry of raw.syncLog as V27BlockSyncEntry[]) {
        if (!entry || typeof entry.blockId !== 'string') continue;
        const list = layer.syncLog.get(entry.blockId) ?? [];
        list.push({ ...entry });
        layer.syncLog.set(entry.blockId, list);
      }
    }
    if (Array.isArray(raw.registeredAt)) {
      for (const [blockId, at] of raw.registeredAt as [string, string][]) {
        if (typeof blockId === 'string' && typeof at === 'string') {
          layer.registeredAt.set(blockId, at);
        }
      }
    }
    return layer;
  }
}

/** Lay block v26 theo label (tien ich cho tool/pipeline). */
export function findV26BlockByLabel(
  v26: V26Store,
  label: string,
  scope?: V25Scope,
): V25SharedBlock | undefined {
  return v26.listBlocks().find((b) => {
    if (b.label !== label) return false;
    if (scope) {
      if (scope.userId && b.scope.userId !== scope.userId) return false;
      if (scope.agentId && b.scope.agentId !== scope.agentId) return false;
    }
    return true;
  });
}

export { truncateV27 };
