/**
 * Memory v21 — Sleep-time consolidation mo rong (xuyen session).
 *
 * Noi tiep V20SleepConsolidator (v128): v20 gom fact TRONG mot
 * session (dedupe Jaccard + decay mu + promote vao core block).
 * v21 them lop XUYEN session:
 *  - Session ledger: fact nao den tu session nao, gap o bao nhieu
 *    session — fact xuat hien o >= 2 session duoc boost confidence
 *    (khong phai noise mot lan).
 *  - Stale marking: record qua `stale_after` duoc danh dau stale
 *    trong bao cao (khong tu xoa — user quyet dinh).
 *  - Export portable: fact da promote duoc xuat ra bundle OKF de
 *    dem di noi khac / commit cung code.
 *  - Import pool: nap lai pool tu lan chay truoc de consolidation
 *    lien tuc giua cac lan ngu (khong mat trang thai khi restart).
 *
 * Khong goi model, khong goi mang. Chay nen giua session, khong
 * nam tren critical path cua chat.
 */
import type { V21PortableRecord } from './types';
import {
  V20SleepConsolidator,
  normalizeSleepTextV20,
  type V20SleepConsolidationOptions,
  type V20SleepFactCandidate,
} from '../v20/sleepConsolidation';
import type { V20SleepReport } from '../v20/types';
import type { V20CoreBlockStore } from '../v20/coreBlocks';
import { isRecordStaleV21, recordToOkfV21, slugifyV21 } from './okfFormat';
import { V21RecordStore } from './versioning';

export interface V21SessionFactInput {
  sessionId: string;
  facts: Omit<V20SleepFactCandidate, 'id' | 'sessionId'>[];
}

export interface V21CrossSessionOptions extends V20SleepConsolidationOptions {
  /** So session toi thieu de boost confidence. Mac dinh 2. */
  minSessionsForBoost?: number;
  /** Muc boost cong them khi gap o nhieu session. Mac dinh 0.15. */
  crossSessionBoost?: number;
  /** Confidence toi da sau boost. Mac dinh 0.95. */
  maxBoostedConfidence?: number;
}

export const V21_CROSS_SESSION_DEFAULTS: Required<
  Pick<V21CrossSessionOptions, 'minSessionsForBoost' | 'crossSessionBoost' | 'maxBoostedConfidence'>
> = {
  minSessionsForBoost: 2,
  crossSessionBoost: 0.15,
  maxBoostedConfidence: 0.95,
};

export interface V21CrossSessionReport extends V20SleepReport {
  sessionsSeen: number;
  crossSessionFacts: number;
  boostedFacts: number;
  staleMarked: string[];
  exportedOkfFiles: string[];
}

/** So luot session mot fact da xuat hien. */
export interface V21FactSessionInfo {
  factId: string;
  sessions: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export class V21CrossSessionConsolidator {
  private inner: V20SleepConsolidator;
  private ledger = new Map<string, V21FactSessionInfo>();
  private sessionIds = new Set<string>();
  private lastReport: V21CrossSessionReport | undefined;
  private lastBoosted = 0;

  constructor() {
    this.inner = new V20SleepConsolidator();
  }

  poolSize(): number {
    return this.inner.poolSize();
  }

  sessionsSeen(): number {
    return this.sessionIds.size;
  }

  getLastReport(): V21CrossSessionReport | undefined {
    return this.lastReport;
  }

  /** Nap lai pool + ledger tu lan chay truoc (JSON). */
  importState(state: {
    pool: V20SleepFactCandidate[];
    ledger: V21FactSessionInfo[];
    sessions: string[];
  }): void {
    this.inner.addCandidates(
      state.pool.map((f) => ({ text: f.text, source: f.source, confidence: f.confidence, observedAt: f.observedAt, sessionId: f.sessionId, tags: f.tags })),
    );
    for (const info of state.ledger) {
      this.ledger.set(info.factId, { ...info, sessions: [...info.sessions] });
    }
    for (const s of state.sessions) this.sessionIds.add(s);
  }

  /** Xuat trang thai hien tai de lan sau nap lai. */
  exportState(): {
    pool: V20SleepFactCandidate[];
    ledger: V21FactSessionInfo[];
    sessions: string[];
  } {
    return {
      pool: this.inner.listPool(),
      ledger: [...this.ledger.values()].map((i) => ({ ...i, sessions: [...i.sessions] })),
      sessions: [...this.sessionIds].sort(),
    };
  }

  /**
   * Nhan fact tu nhieu session: ghi ledger (fact nao gap o
   * session nao), boost confidence cho fact lap lai xuyen session,
   * roi day vao consolidator v20. Boost tinh theo session MOI:
   * fact da co trong pool thi tang confidence cua ban dang giu
   * (khong them ban trung); fact moi thi nap voi confidence da
   * boost neu ledger da thay no o du session.
   */
  addSessionFacts(
    inputs: V21SessionFactInput[],
    options?: V21CrossSessionOptions,
  ): { received: number; accepted: number; boosted: number } {
    const opts = { ...V21_CROSS_SESSION_DEFAULTS, ...options };
    let received = 0;
    let accepted = 0;
    let boosted = 0;
    for (const input of inputs) {
      this.sessionIds.add(input.sessionId);
      const prepared: Omit<V20SleepFactCandidate, 'id'>[] = [];
      for (const raw of input.facts) {
        received += 1;
        const text = typeof raw.text === 'string' ? raw.text.trim() : '';
        if (text.length < 8) continue;
        // Ledger: dinh danh fact bang text chuan hoa (khong can id).
        const key = slugifyV21(text.slice(0, 80));
        const info = this.ledger.get(key) ?? {
          factId: key,
          sessions: [],
          firstSeenAt: raw.observedAt,
          lastSeenAt: raw.observedAt,
        };
        if (!info.sessions.includes(input.sessionId)) info.sessions.push(input.sessionId);
        info.lastSeenAt = Math.max(info.lastSeenAt, raw.observedAt);
        info.firstSeenAt = Math.min(info.firstSeenAt, raw.observedAt);
        this.ledger.set(key, info);
        const isRepeat = info.sessions.length >= opts.minSessionsForBoost;
        const norm = normalizeSleepTextV20(text);
        const existing = this.inner.listPool().find((f) => normalizeSleepTextV20(f.text) === norm);
        if (existing && isRepeat) {
          // Fact da co trong pool: boost ban dang giu, khong them trung.
          const bumped = Math.min(opts.maxBoostedConfidence, existing.confidence + opts.crossSessionBoost);
          if (this.inner.setFactConfidence(existing.id, bumped)) boosted += 1;
          continue;
        }
        const confidence = isRepeat
          ? Math.min(opts.maxBoostedConfidence, raw.confidence + opts.crossSessionBoost)
          : raw.confidence;
        if (isRepeat && !existing) boosted += 1;
        prepared.push({ ...raw, text, confidence, sessionId: input.sessionId });
      }
      const summary = this.inner.addCandidates(prepared, options);
      accepted += summary.accepted;
    }
    this.lastBoosted = boosted;
    return { received, accepted, boosted };
  }

  ledgerInfo(factKey: string): V21FactSessionInfo | undefined {
    const info = this.ledger.get(factKey);
    if (!info) return undefined;
    return { ...info, sessions: [...info.sessions] };
  }

  /**
   * Chay mot pass consolidation xuyen session. Khong dung
   * `V20SleepConsolidator.run()` ma chay tung buoc (dedupe ->
   * decay -> promote) de giu lai fact da promote: fact do vua vao
   * core block (v20) vua duoc ghi vao portable store dang record
   * tag `sleep-promoted` (de xuat bundle OKF dem di).
   *  1. dedupe/decay/promote vao core block (v20)
   *  2. ghi fact da promote vao portable store
   *  3. danh dau stale cac record trong portable store da qua han
   */
  runCrossSessionPass(
    blockStore: V20CoreBlockStore,
    portableStore: V21RecordStore | undefined,
    options?: V21CrossSessionOptions & { exportOkf?: boolean; actor?: string; trigger?: 'session_end' | 'idle' | 'manual' | 'scheduled' | 'memory_pressure' },
  ): V21CrossSessionReport {
    const opts = { ...V21_CROSS_SESSION_DEFAULTS, ...options };
    const startedAt = Date.now();
    const jobId = `sleep-v21-${startedAt}`;
    const trigger = options?.trigger ?? 'scheduled';
    const errors: string[] = [];
    const skipped: string[] = [];
    const factsCollected = this.inner.poolSize();
    let duplicatesMerged = 0;
    let factsDecayed = 0;
    let factsPruned = 0;
    let factsPromoted = 0;
    const blocksUpdated: string[] = [];
    try {
      const groups = this.inner.dedupePool(opts);
      const reviewByKeep = new Map(groups.map((g) => [g.keepId, g]));
      for (const g of groups) duplicatesMerged += g.mergedIds.length;
      const decayed = this.inner.decayPool(startedAt, opts);
      for (const d of decayed) {
        if (d.pruned) factsPruned += 1;
        else if (d.after < d.before) factsDecayed += 1;
      }
      const { promoted, skipped: promoteSkipped } = this.inner.promotePool(blockStore, startedAt, reviewByKeep, opts);
      factsPromoted = promoted.length;
      skipped.push(...promoteSkipped);
      for (const p of promoted) if (!blocksUpdated.includes(p.blockId)) blocksUpdated.push(p.blockId);
      for (const g of groups) {
        if (g.needsReview) skipped.push(`nhom ${g.keepId} can xem lai: ${g.reviewReason ?? ''}`);
      }
      // Ghi fact da promote vao portable store (de xuat OKF).
      if (portableStore) {
        for (const p of promoted) {
          const id = slugifyV21(p.text.slice(0, 80)) || `sleep-fact-${p.factId}`;
          const record: V21PortableRecord = {
            id,
            type: 'fact',
            title: p.text.slice(0, 80),
            body: p.text,
            tags: ['sleep-promoted'],
            sources: [`sleep:${jobId}`, `block:${p.blockId}@v${p.blockVersion}`],
            codeRefs: [],
            version: 1,
            createdAt: startedAt,
            updatedAt: startedAt,
            originFormat: 'okf',
          };
          if (portableStore.get(id)) {
            portableStore.update(id, { body: p.text, tags: ['sleep-promoted'] }, options?.actor ?? 'sleep-time', 'promote');
          } else {
            portableStore.create(record, options?.actor ?? 'sleep-time', 'promote');
          }
        }
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    const staleMarked: string[] = [];
    if (portableStore) {
      const today = new Date();
      for (const record of portableStore.list()) {
        if (isRecordStaleV21(record, today)) staleMarked.push(record.id);
      }
    }
    const exportedOkfFiles: string[] = [];
    if (options?.exportOkf && portableStore) {
      for (const record of portableStore.list()) {
        if (record.tags.includes('sleep-promoted')) exportedOkfFiles.push(`${record.id}.md`);
      }
    }
    const finishedAt = Date.now();
    const report: V21CrossSessionReport = {
      jobId,
      trigger,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      factsCollected,
      duplicatesMerged,
      factsDecayed,
      factsPromoted,
      blocksUpdated,
      factsPruned,
      summariesWritten: 0,
      errors,
      skipped,
      sessionsSeen: this.sessionIds.size,
      crossSessionFacts: [...this.ledger.values()].filter((i) => i.sessions.length >= 2).length,
      boostedFacts: this.lastBoosted,
      staleMarked,
      exportedOkfFiles,
    };
    this.lastReport = report;
    return report;
  }

  /** Xuat cac fact da promote trong pool thanh record OKF (de dem di). */
  exportPromotedAsOkf(
    portableStore: V21RecordStore,
  ): { path: string; content: string }[] {
    const files: { path: string; content: string }[] = [];
    for (const record of portableStore.list()) {
      if (!record.tags.includes('sleep-promoted')) continue;
      files.push({ path: `${record.id}.md`, content: recordToOkfV21(record) });
    }
    return files;
  }

  clearPool(): number {
    return this.inner.clearPool();
  }
}

/** Dem so session khac nhau trong mot danh sach fact. */
export function countDistinctSessionsV21(facts: V20SleepFactCandidate[]): number {
  return new Set(facts.map((f) => f.sessionId ?? 'unknown')).size;
}
