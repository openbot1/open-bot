/**
 * Memory v24 — sleep-time consolidation job (v1.39, Doi T1).
 *
 * Y tuong Letta sleep-time compute (chi y tuong): agent nen don
 * dep/to chuc lai memory blocks luc ranh, khong ton luot tra loi
 * nguoi dung.
 *
 * Tu thiet ke lai hoan toan cho open-bot, chay local:
 *  - shouldRun(lastActivityAt, now): chi chay khi idle du
 *    V24_DEFAULT_SLEEP_IDLE_MS (5 phut) — neu chay tay thi
 *    idleTriggered=false.
 *  - 1 pass co ngan sach: maxOps thao tac + maxMs thoi gian.
 *    Het ngan sach -> budgetHit=true, pass sau lam tiep.
 *  - Cac pass theo thu tu: (1) giai phong khoa block het han,
 *    (2) decay fact/lesson, (3) merge fact trung lap chinh xac,
 *    (4) promote fact/lesson hay duoc dung (accessCount >= 3),
 *    (5) quarantine lesson active thieu evidence, (6) danh dau
 *    lesson can re-verify, (7) snapshot MemFS (neu co thay doi).
 *  - KHONG xoa du lieu: archive/expired chi doi status; merge
 *    giu provenance ca 2 fact goc.
 *  - Tra V24SleepReport day du de UI/tool hien thi.
 */
import {
  isoAtV24,
  normalizeTextV24,
  type V24SleepAction,
  type V24SleepReport,
  V24_DEFAULT_SLEEP_IDLE_MS,
  V24_DEFAULT_SLEEP_MAX_OPS,
} from './types';
import { decayStoreV24 } from './storeExt';
import { lessonHasValidEvidenceV24, lessonNeedsReverifyV24 } from './evidence';
import type { V24Store } from './store';

/** Thoi diem hoat dong cuoi (ms) — sleep job chi chay khi idle du lau. */
export function shouldRunSleepV24(
  lastActivityAtMs: number | null,
  nowMs: number = Date.now(),
  idleMs: number = V24_DEFAULT_SLEEP_IDLE_MS,
): boolean {
  if (lastActivityAtMs === null) return true;
  return nowMs - lastActivityAtMs >= idleMs;
}

/** Input chay sleep job. */
export interface V24SleepOptions {
  /** So thao tac toi da moi pass. */
  maxOps?: number;
  /** Thoi gian toi da moi pass (ms). */
  maxMs?: number;
  /** Thoi diem hoat dong cuoi (ms) — dung de tinh idle. */
  lastActivityAtMs?: number | null;
  /** Idle toi thieu de chay (ms). */
  idleMs?: number;
  /** Bat buoc chay ke ca khi chua idle (chay tay). */
  force?: boolean;
  nowMs?: number;
}

/** Chay 1 pass sleep-time consolidation tren store. */
export function runV24Sleep(
  store: V24Store,
  opts: V24SleepOptions = {},
): V24SleepReport {
  const started = Date.now();
  const nowMs = opts.nowMs ?? started;
  const maxOps = opts.maxOps ?? V24_DEFAULT_SLEEP_MAX_OPS;
  const maxMs = opts.maxMs ?? 30_000;
  const idleTriggered = !opts.force;
  if (idleTriggered && !shouldRunSleepV24(opts.lastActivityAtMs ?? null, nowMs, opts.idleMs ?? V24_DEFAULT_SLEEP_IDLE_MS)) {
    return {
      ranAt: isoAtV24(nowMs),
      idleTriggered: true,
      scanned: 0,
      decayed: 0,
      merged: 0,
      promoted: 0,
      markedStale: 0,
      archived: 0,
      lessonsQuarantined: 0,
      locksReleased: 0,
      budgetHit: false,
      durationMs: Date.now() - started,
      actions: [{ kind: 'snapshot', detail: 'Chua du idle — bo qua pass nay (can force=true de chay tay).' }],
    };
  }

  const actions: V24SleepAction[] = [];
  let ops = 0;
  let budgetHit = false;
  const overBudget = (): boolean => {
    if (ops >= maxOps) { budgetHit = true; return true; }
    if (Date.now() - started > maxMs) { budgetHit = true; return true; }
    return false;
  };

  // Pass 1: giai phong khoa block het han.
  const released = store.blocks.releaseExpiredLocks();
  if (released > 0) {
    ops += released;
    actions.push({ kind: 'lock', detail: `Giai phong ${released} khoa block het han.` });
  }

  // Pass 2: decay fact/lesson (ton trong ngan sach: chi xu ly toi da
  // so record con lai trong budget, phan con lai pass sau lam tiep).
  const scanned = store.stats().factsTotal + store.stats().lessonsTotal;
  const decayed = decayStoreV24(store, nowMs, Math.max(0, maxOps - ops));
  ops += decayed.processed;
  if (decayed.processed < decayed.total) budgetHit = true;
  let decayCount = 0;
  let staleCount = 0;
  let archivedCount = 0;
  for (const o of decayed.outcomes) {
    if (o.action === 'decayed') decayCount++;
    if (o.action === 'stale') { staleCount++; actions.push({ kind: 'stale', detail: o.detail }); }
    if (o.action === 'archived' || o.action === 'expired') { archivedCount++; actions.push({ kind: 'archive', detail: o.detail }); }
  }
  if (decayed.outcomes.length > 0 && decayCount > 0) {
    actions.unshift({ kind: 'decay', detail: `Decay ${decayCount} fact/lesson (confidence giam theo tuoi).` });
  }

  // Pass 3: merge fact trung lap chinh xac (cung subject/edge/object, cung active).
  let merged = 0;
  if (!overBudget()) {
    const seen = new Map<string, string>();
    const active = store.listFacts({ status: 'active' });
    for (const f of active) {
      if (overBudget()) break;
      const key = normalizeTextV24(`${f.subject}|${f.edge}|${f.object}`);
      const firstId = seen.get(key);
      if (!firstId) {
        seen.set(key, f.id);
        continue;
      }
      const first = store.getFact(firstId);
      if (!first || first.status !== 'active') {
        seen.set(key, f.id);
        continue;
      }
      // Danh dau fact sau la merged vao fact dau (giu ca 2, khong xoa).
      const self = store as unknown as {
        facts: Map<string, import('./types').V24Fact>;
      };
      const later = self.facts.get(f.id);
      const earlier = self.facts.get(firstId);
      if (later && earlier) {
        later.status = 'merged';
        later.mergedFromIds = [firstId];
        later.invalidReason = `Trung lap chinh xac voi ${firstId} — gop o sleep pass.`;
        earlier.accessCount += later.accessCount;
        merged++;
        ops++;
        actions.push({ kind: 'merge', detail: `Gop fact ${f.id} vao ${firstId} (trung lap: ${f.subject} ${f.edge} ${f.object}).` });
      }
    }
  }

  // Pass 4: promote fact hay duoc dung (accessCount >= 3) — tang importance.
  let promoted = 0;
  if (!overBudget()) {
    const self = store as unknown as {
      facts: Map<string, import('./types').V24Fact>;
    };
    for (const f of self.facts.values()) {
      if (overBudget()) break;
      if (f.status === 'active' && f.accessCount >= 3 && f.importance < 0.9) {
        f.importance = Math.min(0.9, f.importance + 0.1);
        promoted++;
        ops++;
        actions.push({ kind: 'promote', detail: `Promote fact ${f.id} (dung ${f.accessCount} lan) importance -> ${f.importance.toFixed(2)}.` });
      }
    }
  }

  // Pass 5+6: lesson thieu evidence -> quarantine; lesson can re-verify -> ghi action.
  let lessonsQuarantined = 0;
  if (!overBudget()) {
    const self = store as unknown as {
      lessons: Map<string, import('./types').V24Lesson>;
    };
    for (const l of self.lessons.values()) {
      if (overBudget()) break;
      if (l.status === 'active' && !lessonHasValidEvidenceV24(l)) {
        l.status = 'quarantined';
        l.statusReason = 'Sleep pass: lesson active khong co evidence hop le — can bo sung evidence.';
        l.updatedAt = isoAtV24(nowMs);
        lessonsQuarantined++;
        ops++;
        actions.push({ kind: 'evidence', detail: `Quarantine lesson ${l.id} ("${l.title}") — thieu evidence hop le.` });
      } else if (l.status === 'active' && lessonNeedsReverifyV24(l, nowMs)) {
        ops++;
        actions.push({ kind: 'evidence', detail: `Lesson ${l.id} ("${l.title}") can re-verify: evidence cu / lau khong dung.` });
      }
    }
  }

  // Pass 7: snapshot MemFS (chi ghi nhan — snapshot that do pipeline goi khi can).
  if (!overBudget()) {
    const snap = store.snapshotForPrompt({ budgetChars: 8000 });
    actions.push({
      kind: 'snapshot',
      detail: `Snapshot MemFS: ${snap.tree.length} file, ${Object.keys(snap.nodes).length} node, ${snap.lessons.length} lesson, ${snap.facts.length} fact trong ngan sach ${snap.budgetChars} ky tu.`,
    });
    ops++;
  }

  return {
    ranAt: isoAtV24(nowMs),
    idleTriggered,
    scanned,
    decayed: decayCount,
    merged,
    promoted,
    markedStale: staleCount,
    archived: archivedCount,
    lessonsQuarantined,
    locksReleased: released,
    budgetHit,
    durationMs: Date.now() - started,
    actions,
  };
}
