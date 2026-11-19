/**
 * Memory v22 — Expiry: het han fact co thoi han (v1.37, Doi T1).
 *
 * Y tuong (bai "Agent Memory Consolidation", maximem.ai): job
 * nightly phai het han fact co thoi han — vd "dang o Ha Noi
 * den 20/11" sau ngay do khong con dung nua, nhung cung khong
 * nen bien mat lang le.
 *
 * Quy tac cua module nay:
 *  1. Fact co `validUntil` <= `now` va dang active thi het han:
 *     status `expired` (KHONG xoa — lich su van con, UI van
 *     hien duoc "fact nay da het han luc nao, vi sao").
 *  2. Fact co `validFrom` > `now` thi CHUA co hieu luc: khong
 *     het han, nhung bi dua vao `skipped` (de dream report noi
 *     ro "chua toi han hieu luc", khong phai "con dung").
 *  3. `listExpiringSoonV22` bao truoc fact sap het han trong
 *     khoang `withinMs` (mac dinh 7 ngay) de host nhac user
 *     gia han / xac nhan lai.
 *  4. Het han la mot chieu: fact da expired khong tu song lai
 *     khi dream chay lai; muon dung lai thi host phai tao fact
 *     moi (co audit) hoac doi validUntil qua tool.
 */
import type { V22DreamChange, V22DreamFact } from './types';
import type { V22DreamStore } from './store';

/** Tuy chon expiry. */
export interface V22ExpiryOptions {
  /** Epoch ms moc het han (mac dinh Date.now()). */
  now?: number;
  /** Chi xet fact active (mac dinh true). */
  onlyActive?: boolean;
  /** So fact toi da xet trong mot lan. */
  maxFacts?: number;
}

/** Ket qua mot pass expiry. */
export interface V22ExpiryResult {
  expired: V22DreamFact[];
  /** Fact chua toi han hieu luc (validFrom > now). */
  notYetValid: V22DreamFact[];
  changes: V22DreamChange[];
  skipped: string[];
}

/** Dinh dang epoch ms thanh ngay ISO (YYYY-MM-DD) de hien thi. */
export function formatValidUntilV22(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** true = fact da qua han tai `now`. */
export function isFactExpiredV22(fact: V22DreamFact, now: number): boolean {
  return fact.validUntil !== undefined && fact.validUntil <= now;
}

/** true = fact chua toi han hieu luc tai `now`. */
export function isFactNotYetValidV22(fact: V22DreamFact, now: number): boolean {
  return fact.validFrom !== undefined && fact.validFrom > now;
}

/**
 * Ap dung mot pass expiry len store: fact qua han thi chuyen
 * `expired` co bang chung (het han luc nao, han la ngay nao).
 */
export function applyExpiryV22(
  store: V22DreamStore,
  options: V22ExpiryOptions = {},
): V22ExpiryResult {
  const now = options.now ?? Date.now();
  const onlyActive = options.onlyActive ?? true;
  const maxFacts = options.maxFacts ?? 500;
  const pool = store.list(onlyActive ? { status: 'active' } : {}).slice(0, maxFacts);
  const expired: V22DreamFact[] = [];
  const notYetValid: V22DreamFact[] = [];
  const changes: V22DreamChange[] = [];
  const skipped: string[] = [];
  let changeSeq = 0;
  for (const fact of pool) {
    if (isFactNotYetValidV22(fact, now)) {
      notYetValid.push(fact);
      skipped.push(
        `fact "${fact.id}" chua toi han hieu luc (validFrom ${formatValidUntilV22(fact.validFrom as number)}) — khong het han, khong dua vao always-loaded.`,
      );
      continue;
    }
    if (!isFactExpiredV22(fact, now)) continue;
    store.setStatus(fact.id, 'expired', { now });
    expired.push(fact);
    changeSeq += 1;
    changes.push({
      id: `chg-expire-${changeSeq}`,
      kind: 'expire',
      factIdsBefore: [fact.id],
      factIdsAfter: [fact.id],
      reason: `Fact "${fact.id}" het han: validUntil ${formatValidUntilV22(fact.validUntil as number)} <= hom nay — chuyen status expired (khong xoa, lich su van con).`,
      detail: `text: "${fact.text.slice(0, 120)}"`,
      at: now,
    });
  }
  return { expired, notYetValid, changes, skipped };
}

/**
 * Fact sap het han trong khoang `withinMs` ke tu `now`
 * (mac dinh 7 ngay) — de host nhac user gia han truoc.
 */
export function listExpiringSoonV22(
  store: V22DreamStore,
  options: { now?: number; withinMs?: number } = {},
): V22DreamFact[] {
  const now = options.now ?? Date.now();
  const withinMs = options.withinMs ?? 7 * 24 * 60 * 60 * 1000;
  return store
    .list({ status: 'active' })
    .filter((f) => f.validUntil !== undefined && f.validUntil > now && f.validUntil - now <= withinMs)
    .sort((a, b) => (a.validUntil as number) - (b.validUntil as number));
}

/** Thong ke han cua store (de UI bao quat). */
export function expiryStatsV22(
  store: V22DreamStore,
  now = Date.now(),
): { active: number; withDeadline: number; expired: number; expiringSoon: number; notYetValid: number } {
  const all = store.list();
  return {
    active: all.filter((f) => f.status === 'active').length,
    withDeadline: all.filter((f) => f.status === 'active' && f.validUntil !== undefined).length,
    expired: all.filter((f) => f.status === 'expired').length,
    expiringSoon: listExpiringSoonV22(store, { now }).length,
    notYetValid: all.filter((f) => f.status === 'active' && isFactNotYetValidV22(f, now)).length,
  };
}
