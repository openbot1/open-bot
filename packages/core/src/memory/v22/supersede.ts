/**
 * Memory v22 — Supersede: fact moi thay the fact cu cung chu de
 * (v1.37, Doi T1).
 *
 * Y tuong (Mem0 Dream "supersede" + Mnemoverse memory_write):
 * memory moi cung chu de, gia tri khac thi thay the memory cu —
 * nhung KHONG xoa: fact cu chuyen `superseded`, tro
 * `supersededBy` sang fact moi; fact moi ghi `supersedes` tro
 * ve fact cu. Lich su giu lai day du, rollback duoc.
 *
 * Quy tac cua module nay (xac dinh, khong can model):
 *  1. CUNG CHU DE = cung `topic` da chuan hoa + `value` chuan
 *     hoa KHAC nhau. Fact khong co topic/value thi khong tham
 *     gia supersede (chi dedupe theo text).
 *  2. THANG = confidence cao nhat (hoa thi moi nhat). Ban
 *     thang phai manh hon ban thua it nhat `minConfidenceGap`
 *     (mac dinh 0.1) — neu khong, nhom bi danh dau can xem lai
 *     va KHONG tu dong thay the (ly do: fact 0.95 khong nen bi
 *     thay bang fact 0.4 chi vi no moi hon; cung khong nen tu
 *     thay khi hai ban ngang nhau).
 *  3. NHIEU BAN CU: chi supersede truc tiep ban manh nhat
 *     ("hien tai"); cac ban cu khac cung chu de bi invalidate
 *     co ly do tro ve fact moi — de khong con 2 fact active
 *     cung chu de doi nhau.
 *  4. KHONG GHI DE LANG LE: moi lan thay the deu tra ve
 *     V22DreamChange co bang chung (fact cu / moi / ly do),
 *     de dream report hien duoc "fact nao thang va vi sao".
 *  5. ROLLBACK = PHIEN BAN MOI: khoi phuc ban cu khong xoa ban
 *     moi — xem `rollbackSupersededV22` (tao fact moi copy noi
 *     dung ban cu va supersede ban hien tai).
 */
import type { V22DreamChange, V22DreamFact } from './types';
import { V22_DREAM_DEFAULT_CONFIG } from './types';
import { normalizeTopicV22, normalizeValueV22, type V22DreamStore } from './store';

/** Tuy chon supersede. */
export interface V22SupersedeOptions {
  /** Chenh confidence toi thieu de chap nhan thay the. Mac dinh 0.1. */
  minConfidenceGap?: number;
  /** true = thay the ca khi fact moi yeu hon (ghi ro vao change). */
  force?: boolean;
  /** Chi xet fact active (mac dinh true). */
  onlyActive?: boolean;
  /** So fact toi da xet trong mot lan. */
  maxFacts?: number;
  /** Epoch ms ghi change (mac dinh Date.now()). */
  now?: number;
}

/** Mot nhom mau thuan: cung topic, value khac nhau. */
export interface V22ContradictionGroup {
  /** Topic da chuan hoa. */
  topic: string;
  /** Cac fact trong nhom (sap confidence giam dan). */
  facts: V22DreamFact[];
  /** Gia tri chuan hoa cua tung fact (factId -> value). */
  values: Record<string, string>;
  /** Ban thang du kien (confidence cao nhat). */
  winner?: V22DreamFact;
  /** Chenh confidence giua thang va nhi (0 khi chi 1 fact). */
  gap: number;
  /** true = chenh qua nho, can nguoi xem lai truoc khi thay the. */
  needsReview: boolean;
  reviewReason?: string;
}

/** Ket qua mot pass supersede. */
export interface V22SupersedeResult {
  groups: V22ContradictionGroup[];
  /** So fact bi supersede. */
  supersededCount: number;
  /** So fact bi invalidate (ban cu phu cung chu de). */
  invalidatedCount: number;
  /** Nhom can xem lai (khong tu thay the). */
  needsReviewCount: number;
  changes: V22DreamChange[];
  skipped: string[];
}

/**
 * Nhom cac fact active theo topic: chi nhom co >= 2 value
 * khac nhau moi la mau thuan. Fact khong co topic/value thi
 * bo qua (tra ve rong cho nhom do).
 */
export function findContradictionGroupsV22(
  facts: V22DreamFact[],
  options: V22SupersedeOptions = {},
): V22ContradictionGroup[] {
  const gap = options.minConfidenceGap ?? V22_DREAM_DEFAULT_CONFIG.minConfidenceGap;
  const onlyActive = options.onlyActive ?? true;
  const maxFacts = options.maxFacts ?? V22_DREAM_DEFAULT_CONFIG.maxFactsPerDream;
  const pool = facts
    .filter((f) => !onlyActive || f.status === 'active')
    .filter((f) => typeof f.topic === 'string' && f.topic.trim() !== '')
    .filter((f) => typeof f.value === 'string' && f.value.trim() !== '')
    .slice(0, maxFacts);
  const byTopic = new Map<string, V22DreamFact[]>();
  for (const fact of pool) {
    const key = normalizeTopicV22(fact.topic as string);
    const list = byTopic.get(key) ?? [];
    list.push(fact);
    byTopic.set(key, list);
  }
  const groups: V22ContradictionGroup[] = [];
  for (const [topic, members] of [...byTopic.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const values: Record<string, string> = {};
    const distinct = new Set<string>();
    for (const fact of members) {
      const value = normalizeValueV22(fact.value as string);
      values[fact.id] = value;
      distinct.add(value);
    }
    // Cung topic, cung value = dong y nhau (dedupe lo, khong phai mau thuan).
    if (distinct.size < 2) continue;
    const sorted = [...members].sort((a, b) => b.confidence - a.confidence || b.observedAt - a.observedAt);
    const winner = sorted[0];
    const runnerUp = sorted[1];
    const measuredGap = runnerUp ? winner.confidence - runnerUp.confidence : 0;
    const needsReview = measuredGap < gap;
    groups.push({
      topic,
      facts: sorted,
      values,
      winner,
      gap: measuredGap,
      needsReview,
      ...(needsReview
        ? { reviewReason: `chenh confidence giua "${winner.id}" (${winner.confidence.toFixed(2)}) va "${runnerUp?.id}" (${runnerUp?.confidence.toFixed(2)}) chi ${measuredGap.toFixed(2)} < nguong ${gap} — can nguoi xem lai truoc khi thay the` }
        : {}),
    });
  }
  return groups;
}

/**
 * Ap dung mot pass supersede len store. Voi moi nhom mau thuan
 * DU manh (gap >= nguong): ban thang supersede ban manh nhat
 * con lai, cac ban cu khac bi invalidate co ly do. Nhom yeu
 * (gap < nguong) thi bo qua co ghi ly do — tru khi host `force`
 * (luc do change ghi ro `forced: true`).
 */
export function applySupersedeV22(
  store: V22DreamStore,
  options: V22SupersedeOptions = {},
): V22SupersedeResult {
  const now = options.now ?? Date.now();
  const forced = options.force === true;
  const groups = findContradictionGroupsV22(store.list({ status: 'active' }), options);
  const changes: V22DreamChange[] = [];
  const skipped: string[] = [];
  let supersededCount = 0;
  let invalidatedCount = 0;
  let needsReviewCount = 0;
  let changeSeq = 0;
  for (const group of groups) {
    const winner = group.winner as V22DreamFact;
    if (group.needsReview && !forced) {
      needsReviewCount += 1;
      skipped.push(
        `chu de "${group.topic}" can xem lai: ${group.reviewReason ?? 'chenh confidence qua nho'} (cac fact: ${group.facts.map((f) => `${f.id}=${group.values[f.id]}`).join(', ')})`,
      );
      continue;
    }
    // Ban "hien tai" = ban manh nhat trong cac ban thua (confidence cao nhat sau winner).
    const losers = group.facts.filter((f) => f.id !== winner.id);
    const current = losers[0];
    const beforeIds = group.facts.map((f) => f.id);
    // 1. Supersede ban manh nhat: status superseded + tro ve winner.
    store.setStatus(current.id, 'superseded', { supersededBy: winner.id, now });
    store.linkSupersede(winner.id, current.id, now);
    supersededCount += 1;
    // 2. Invalidate cac ban cu con lai cung chu de.
    const invalidatedIds: string[] = [];
    for (const other of losers.slice(1)) {
      if (store.setStatus(other.id, 'invalidated', { now })) {
        invalidatedIds.push(other.id);
        invalidatedCount += 1;
      }
    }
    changeSeq += 1;
    changes.push({
      id: `chg-supersede-${changeSeq}`,
      kind: 'supersede',
      factIdsBefore: beforeIds,
      factIdsAfter: [winner.id],
      reason: `Chu de "${group.topic}": fact "${winner.id}" (value "${group.values[winner.id]}", confidence ${winner.confidence.toFixed(2)}) thang va thay the "${current.id}" (value "${group.values[current.id]}", confidence ${current.confidence.toFixed(2)}) — chenh ${group.gap.toFixed(2)}${forced && group.needsReview ? ' (ep buoc: chenh duoi nguong)' : ''}.`,
      detail: invalidatedIds.length > 0
        ? `cac ban cu phu bi invalidate: ${invalidatedIds.join(', ')}; lich su giu lai qua chuoi supersedes.`
        : 'lich su giu lai qua chuoi supersedes.',
      at: now,
    });
  }
  return { groups, supersededCount, invalidatedCount, needsReviewCount, changes, skipped };
}

/** Mot buoc trong lich su thay the cua mot fact (doc qua chuoi supersedes). */
export interface V22SupersedeHistoryEntry {
  version: number;
  factId: string;
  text: string;
  value?: string;
  confidence: number;
  status: V22DreamFact['status'];
  updatedAt: number;
  supersedes?: string[];
  supersededBy?: string;
  isCurrent: boolean;
}

/**
 * Lich su thay the cua mot fact: di tu ban goc (ban bi supersede
 * som nhat) toi ban hien tai qua chuoi `supersededBy` /
 * `supersedes`. Doc truc tiep tu store — khong can lich su rieng.
 */
export function supersedeHistoryV22(store: V22DreamStore, factId: string): V22SupersedeHistoryEntry[] {
  const start = store.get(factId);
  if (!start) return [];
  // Chuoi: ban cu nhat -> ... -> ban moi nhat. Ban moi ghi
  // `supersedes: [id ban no thay the]` (tro ve ban cu), ban cu
  // ghi `supersededBy: id ban thay the no` (tro toi ban moi).
  // Di nguoc ve ban goc: ban truoc = fact co id nam trong
  // `supersedes` cua fact hien tai. Di xuoi ve ban moi nhat:
  // ban sau = fact co id bang `supersededBy` cua fact hien tai.
  const chain: V22DreamFact[] = [start];
  const seen = new Set<string>([start.id]);
  let cursor = start;
  for (let guard = 0; guard < 100; guard += 1) {
    const prevId = cursor.supersedes.find((id) => !seen.has(id));
    if (!prevId) break;
    const prev = store.get(prevId);
    if (!prev) break;
    chain.unshift(prev);
    seen.add(prev.id);
    cursor = prev;
  }
  cursor = chain[chain.length - 1];
  for (let guard = 0; guard < 100; guard += 1) {
    if (!cursor.supersededBy) break;
    const next = store.get(cursor.supersededBy);
    if (!next || seen.has(next.id)) break;
    chain.push(next);
    seen.add(next.id);
    cursor = next;
  }
  const currentId = chain[chain.length - 1]?.id;
  return chain.map((fact, index) => ({
    version: index + 1,
    factId: fact.id,
    text: fact.text,
    ...(fact.value !== undefined ? { value: fact.value } : {}),
    confidence: fact.confidence,
    status: fact.status,
    updatedAt: fact.updatedAt,
    ...(fact.supersedes.length > 0 ? { supersedes: [...fact.supersedes] } : {}),
    ...(fact.supersededBy ? { supersededBy: fact.supersededBy } : {}),
    isCurrent: fact.id === currentId,
  }));
}

/**
 * Rollback supersede: khoi phuc noi dung cua mot phien ban cu
 * bang cach viet mot fact MOI copy noi dung ban cu va supersede
 * ban hien tai. Lich su khong bi viet lai — rollback cung la
 * mot buoc trong timeline.
 */
export function rollbackSupersededV22(
  store: V22DreamStore,
  factId: string,
  opts: { targetVersion?: number; now?: number } = {},
): { ok: boolean; newFact?: V22DreamFact; history?: V22SupersedeHistoryEntry[]; error?: string } {
  const now = opts.now ?? Date.now();
  const history = supersedeHistoryV22(store, factId);
  if (history.length < 2) {
    return { ok: false, error: 'Khong co phien ban cu de rollback (can it nhat 2 phien ban).' };
  }
  const current = history[history.length - 1];
  if (current.status !== 'active') {
    return { ok: false, error: 'Chi rollback duoc khi ban hien tai dang active.' };
  }
  const targetVersion = opts.targetVersion ?? history.length - 1;
  const target = history[targetVersion - 1];
  if (!target) return { ok: false, error: `Khong co phien ban ${targetVersion}.` };
  if (target.factId === current.factId) {
    return { ok: false, error: 'Ban dich da la ban hien tai — khong can rollback.' };
  }
  const targetFact = store.get(target.factId);
  if (!targetFact) return { ok: false, error: `Khong doc duoc ban ${targetVersion}.` };
  const currentFact = store.get(current.factId);
  if (!currentFact) return { ok: false, error: 'Khong doc duoc ban hien tai.' };
  const created = store.addFact(
    {
      kind: targetFact.kind,
      text: targetFact.text,
      ...(targetFact.topic !== undefined ? { topic: targetFact.topic } : {}),
      ...(targetFact.value !== undefined ? { value: targetFact.value } : {}),
      confidence: targetFact.confidence,
      sources: [...targetFact.sources, `rollback-v22:${targetFact.id}`],
      tags: [...targetFact.tags, 'rollback'],
      sessionIds: [...targetFact.sessionIds],
      observedAt: now,
      origin: 'dream',
    },
    now,
  );
  if (!created.ok || !created.data) {
    return { ok: false, error: created.error ?? 'Khong tao duoc fact rollback.' };
  }
  store.setStatus(current.factId, 'superseded', { supersededBy: created.data.id, now });
  store.linkSupersede(created.data.id, current.factId, now);
  return { ok: true, newFact: created.data, history: supersedeHistoryV22(store, created.data.id) };
}
