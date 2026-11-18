/**
 * Memory v19 — Feedback POSITIVE / NEGATIVE cho memory (v1.20, Doi T1).
 *
 * Y tuong hoc tu he thong ranking co phan hoi nguoi dung (memory
 * nao giup duoc thi len hang, memory nao sai / gay hieu thi xuong
 * hang) + Mem0/Letta (memory duoc cham diem theo muc do huu ich
 * khi recall) — tu thiet ke lai hoan toan cho open-bot, KHONG
 * copy code/text/tai san cua bat ky repo nao.
 *
 * Co che (don gian, giai thich duoc, khong hop den):
 *  1. Moi fact co bo dem `positive` / `negative`. User (hoac
 *     agent, khi co bang chung ro rang) danh dau memory vua
 *     duoc recall la huu ich (POSITIVE) hay sai / gay hieu
 *     (NEGATIVE). Chi ghi qua `recordFeedbackForFactV19` —
 *     fact phai ton tai trong graph, neu khong throw.
 *  2. Diem feedback: `(pos - neg) / (pos + neg + 2)` (lam min
 *     Laplace +2 de fact moi co 1 feedback khong nhay cuc doan),
 *     nam trong (-1, 1). Nhan them he so \"mo dan theo thoi
 *     gian\" dua tren `lastFeedbackAt`: `max(0.25,
 *     0.5^(tuoiNgay / halfLifeDays))` — feedback cu van con
 *     anh huong nhung nhe dan (mac dinh half-life 180 ngay,
 *     san 0.25 de lich su lau dai khong bien mat han).
 *  3. Boost xep hang: `1 + 0.5 * score`, nam trong [0.5, 1.5].
 *     `applyFeedbackToHitsV19` nhan diem co ban cua hit (retrieval
 *     score) voi boost roi sap xep lai — memory duoc khen nhieu
 *     len tren, memory bi che nhieu xuong duoi. Khong bao gio
 *     an fact: boost toi thieu 0.5, fact bi che van thay duoc
 *     neu retrieval score goc cao.
 *  4. Luu tru: JSON file (mot object `{factId: entry}`), load
 *     fail-open (file thieu/hong -> rong), save ghi de nguyen
 *     file. Store KHONG tu dong ghi file sau moi feedback —
 *     host goi `save()` (de tranh ghi dia lien tuc khi recall
 *     dong); `recordFeedbackForFactV19` co tuy chon `autosave`.
 *
 * Feedback KHONG thay confidence goc cua fact, KHONG xoa fact,
 * KHONG goi model/mang. No chi la mot lop xep hang phu them
 * tren retrieval.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TemporalGraphStore } from '../graph/store';

/** Loi feedback memory v19 — message tieng Viet. */
export class V19FeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V19FeedbackError';
  }
}

/** Loai feedback cho mot memory. */
export type V19FeedbackKind = 'positive' | 'negative';

/** Chu ky ban ra mac dinh cua anh huong feedback: 180 ngay. */
export const V19_DEFAULT_FEEDBACK_HALF_LIFE_DAYS = 180;
/** San duoi cua he so mo dan (feedback cu khong bien mat han). */
export const V19_FEEDBACK_RECENCY_FLOOR = 0.25;
/** Bien do toi da cua boost xep hang (boost nam trong [1-A, 1+A]). */
export const V19_FEEDBACK_MAX_BOOST = 0.5;
/** Hang so lam min Laplace cho diem feedback. */
export const V19_FEEDBACK_SMOOTHING = 2;

/** Mot muc feedback cua mot fact. */
export interface V19MemoryFeedbackEntry {
  /** Id fact duoc danh gia. */
  factId: string;
  /** So luot POSITIVE. */
  positive: number;
  /** So luot NEGATIVE. */
  negative: number;
  /** Thoi diem feedback dau tien (ISO). */
  firstFeedbackAt: string;
  /** Thoi diem feedback gan nhat (ISO). */
  lastFeedbackAt: string;
  /** Ai danh gia gan nhat (user id / `agent:<botId>`). */
  lastActor: string;
}

/** Tom tat toan bo feedback (de UI / bao cao). */
export interface V19FeedbackSummary {
  /** So fact co it nhat 1 feedback. */
  facts: number;
  /** Tong luot POSITIVE. */
  totalPositive: number;
  /** Tong luot NEGATIVE. */
  totalNegative: number;
  /** Fact duoc khen nhieu nhat (null neu chua co feedback). */
  topPositive: { factId: string; positive: number; negative: number } | null;
  /** Fact bi che nhieu nhat (null neu chua co feedback). */
  topNegative: { factId: string; positive: number; negative: number } | null;
}

/** Mot hit retrieval truoc khi ap feedback (can `factId` + `score`). */
export interface V19FeedbackHit {
  factId: string;
  /** Diem retrieval goc (semantic/BM25/hybrid...). */
  score: number;
}

/** Mot hit sau khi ap feedback (them diem hieu dung + boost). */
export interface V19FeedbackRankedHit<T extends V19FeedbackHit> {
  hit: T;
  /** Diem feedback (-1..1, da mo dan theo thoi gian). */
  feedbackScore: number;
  /** He so nhan xep hang [0.5, 1.5]. */
  boost: number;
  /** Diem hieu dung = score goc * boost. */
  effectiveScore: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Diem feedback tho cua mot entry: `(pos - neg) / (pos + neg + 2)`,
 * nam trong (-1, 1). Fact chua co feedback -> 0.
 */
export function rawFeedbackScoreV19(entry: V19MemoryFeedbackEntry): number {
  const total = entry.positive + entry.negative;
  if (total === 0) return 0;
  return (entry.positive - entry.negative) / (total + V19_FEEDBACK_SMOOTHING);
}

/**
 * He so mo dan theo thoi gian dua tren `lastFeedbackAt`:
 * `max(0.25, 0.5^(tuoiNgay / halfLifeDays))`. Feedback moi -> 1,
 * feedback cu -> giam dan nhung khong duoi 0.25.
 */
export function feedbackRecencyV19(
  entry: V19MemoryFeedbackEntry,
  now: Date = new Date(),
  halfLifeDays: number = V19_DEFAULT_FEEDBACK_HALF_LIFE_DAYS,
): number {
  const lastMs = Date.parse(entry.lastFeedbackAt);
  if (Number.isNaN(lastMs)) return 1;
  const ageDays = Math.max(0, (now.getTime() - lastMs) / (24 * 60 * 60 * 1000));
  const half = halfLifeDays > 0 ? halfLifeDays : V19_DEFAULT_FEEDBACK_HALF_LIFE_DAYS;
  return Math.max(V19_FEEDBACK_RECENCY_FLOOR, Math.pow(0.5, ageDays / half));
}

/**
 * Diem feedback hieu dung: diem tho * he so mo dan. Nam trong
 * (-1, 1); 0 = trung lap / chua co feedback / feedback da qua cu.
 */
export function feedbackScoreV19(
  entry: V19MemoryFeedbackEntry,
  now: Date = new Date(),
  halfLifeDays: number = V19_DEFAULT_FEEDBACK_HALF_LIFE_DAYS,
): number {
  return rawFeedbackScoreV19(entry) * feedbackRecencyV19(entry, now, halfLifeDays);
}

/**
 * He so nhan xep hang: `1 + 0.5 * score`, nam trong [0.5, 1.5].
 * Entry null (fact chua co feedback) -> 1 (khong doi).
 */
export function feedbackBoostV19(
  entry: V19MemoryFeedbackEntry | undefined,
  now: Date = new Date(),
  halfLifeDays: number = V19_DEFAULT_FEEDBACK_HALF_LIFE_DAYS,
): number {
  if (!entry) return 1;
  return 1 + V19_FEEDBACK_MAX_BOOST * feedbackScoreV19(entry, now, halfLifeDays);
}

/** Kiem tra tinh hop le cua mot entry doc tu file (bo qua entry hong). */
export function isValidFeedbackEntryV19(value: unknown): value is V19MemoryFeedbackEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.factId === 'string'
    && value.factId !== ''
    && Number.isInteger(value.positive)
    && (value.positive as number) >= 0
    && Number.isInteger(value.negative)
    && (value.negative as number) >= 0
    && typeof value.firstFeedbackAt === 'string'
    && typeof value.lastFeedbackAt === 'string'
    && typeof value.lastActor === 'string'
  );
}

/** Parse JSON file feedback (fail-open: tra ve object rong khi loi). */
export function parseFeedbackFileV19(text: string): Record<string, V19MemoryFeedbackEntry> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return {};
    const out: Record<string, V19MemoryFeedbackEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isValidFeedbackEntryV19(value) && value.factId === key) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Doc file feedback JSON (file thieu -> rong). */
export function loadFeedbackFileV19(filePath: string): Record<string, V19MemoryFeedbackEntry> {
  try {
    if (!fs.existsSync(filePath)) return {};
    return parseFeedbackFileV19(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/** Ghi file feedback JSON (tao thu muc neu can). Tra ve false khi loi ghi. */
export function saveFeedbackFileV19(
  filePath: string,
  entries: Record<string, V19MemoryFeedbackEntry>,
): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Store feedback memory v19: giu trong RAM, luu file JSON khi host
 * goi `save()`. Tao bang `new V19MemoryFeedbackStore()` (chi RAM)
 * hoac `V19MemoryFeedbackStore.load(filePath)` (nap tu file).
 */
export class V19MemoryFeedbackStore {
  private readonly entries = new Map<string, V19MemoryFeedbackEntry>();
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) {
      for (const [factId, entry] of Object.entries(loadFeedbackFileV19(filePath))) {
        this.entries.set(factId, entry);
      }
    }
  }

  /** Nap store tu file (ve rong khi file thieu/hong). */
  static load(filePath: string): V19MemoryFeedbackStore {
    return new V19MemoryFeedbackStore(filePath);
  }

  /** So fact co feedback. */
  get size(): number {
    return this.entries.size;
  }

  /** Lay entry cua mot fact (undefined neu chua co feedback). */
  get(factId: string): V19MemoryFeedbackEntry | undefined {
    return this.entries.get(factId);
  }

  /** Tat ca entry (ban sao, de UI / bao cao). */
  list(): V19MemoryFeedbackEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Ghi mot feedback cho mot fact. Khong kiem tra fact co ton
   * tai trong graph khong — dung `recordFeedbackForFactV19` khi
   * can kiem tra do (khuyen dung).
   */
  record(
    factId: string,
    kind: V19FeedbackKind,
    actor = 'user',
    now: Date = new Date(),
  ): V19MemoryFeedbackEntry {
    const cleanId = (factId ?? '').trim();
    if (cleanId === '') throw new V19FeedbackError('factId khong duoc rong.');
    const cleanActor = (actor ?? '').trim() || 'user';
    const nowIso = now.toISOString();
    const prev = this.entries.get(cleanId);
    const next: V19MemoryFeedbackEntry = prev
      ? {
          ...prev,
          positive: prev.positive + (kind === 'positive' ? 1 : 0),
          negative: prev.negative + (kind === 'negative' ? 1 : 0),
          lastFeedbackAt: nowIso,
          lastActor: cleanActor,
        }
      : {
          factId: cleanId,
          positive: kind === 'positive' ? 1 : 0,
          negative: kind === 'negative' ? 1 : 0,
          firstFeedbackAt: nowIso,
          lastFeedbackAt: nowIso,
          lastActor: cleanActor,
        };
    this.entries.set(cleanId, next);
    return next;
  }

  /** Xoa toan bo feedback cua mot fact (vd khi fact bi xoa cung). */
  remove(factId: string): boolean {
    return this.entries.delete((factId ?? '').trim());
  }

  /** Xoa sach store (chi RAM; muon xoa file thi goi `save()` sau). */
  clear(): void {
    this.entries.clear();
  }

  /** Diem feedback hieu dung cua mot fact (0 neu chua co feedback). */
  score(
    factId: string,
    now: Date = new Date(),
    halfLifeDays: number = V19_DEFAULT_FEEDBACK_HALF_LIFE_DAYS,
  ): number {
    const entry = this.entries.get((factId ?? '').trim());
    if (!entry) return 0;
    return feedbackScoreV19(entry, now, halfLifeDays);
  }

  /** Boost xep hang cua mot fact (1 neu chua co feedback). */
  boost(
    factId: string,
    now: Date = new Date(),
    halfLifeDays: number = V19_DEFAULT_FEEDBACK_HALF_LIFE_DAYS,
  ): number {
    const entry = this.entries.get((factId ?? '').trim());
    return feedbackBoostV19(entry, now, halfLifeDays);
  }

  /** Tom tat toan bo feedback. */
  summary(): V19FeedbackSummary {
    let totalPositive = 0;
    let totalNegative = 0;
    let topPositive: V19FeedbackSummary['topPositive'] = null;
    let topNegative: V19FeedbackSummary['topNegative'] = null;
    for (const entry of this.entries.values()) {
      totalPositive += entry.positive;
      totalNegative += entry.negative;
      if (!topPositive || entry.positive > topPositive.positive) {
        topPositive = { factId: entry.factId, positive: entry.positive, negative: entry.negative };
      }
      if (!topNegative || entry.negative > topNegative.negative) {
        topNegative = { factId: entry.factId, positive: entry.positive, negative: entry.negative };
      }
    }
    return {
      facts: this.entries.size,
      totalPositive,
      totalNegative,
      topPositive,
      topNegative,
    };
  }

  /** Serialize ve object JSON (de host tu luu neu khong dung file). */
  toJSON(): Record<string, V19MemoryFeedbackEntry> {
    return Object.fromEntries(this.entries);
  }

  /**
   * Ghi file JSON (chi khi store duoc tao kem `filePath`).
   * Tra ve false khi khong co filePath hoac loi ghi.
   */
  save(): boolean {
    if (!this.filePath) return false;
    return saveFeedbackFileV19(this.filePath, this.toJSON());
  }
}

/**
 * Ghi feedback cho mot fact CO THAT trong graph (kiem tra qua
 * `store.getFact`, khong ton tai thi throw). Mac dinh khong tu
 * ghi file — truyen `autosave: true` de ghi ngay.
 */
export function recordFeedbackForFactV19(
  graphStore: TemporalGraphStore,
  feedback: V19MemoryFeedbackStore,
  factId: string,
  kind: V19FeedbackKind,
  opts: { actor?: string; now?: Date; autosave?: boolean } = {},
): V19MemoryFeedbackEntry {
  const cleanId = (factId ?? '').trim();
  if (cleanId === '') throw new V19FeedbackError('factId khong duoc rong.');
  if (kind !== 'positive' && kind !== 'negative') {
    throw new V19FeedbackError('kind phai la positive hoac negative.');
  }
  if (!graphStore.getFact(cleanId)) {
    throw new V19FeedbackError(`Khong tim thay fact ${cleanId} trong graph.`);
  }
  const entry = feedback.record(cleanId, kind, opts.actor ?? 'user', opts.now ?? new Date());
  if (opts.autosave === true) feedback.save();
  return entry;
}

/**
 * Ap feedback len danh sach hit retrieval roi sap xep lai theo
 * `effectiveScore` (giam dan; hoa thi giu thu tu goc — sort on
 * dinh). Hit nao khong co feedback thi boost = 1 (khong doi).
 */
export function applyFeedbackToHitsV19<T extends V19FeedbackHit>(
  hits: readonly T[],
  feedback: V19MemoryFeedbackStore,
  now: Date = new Date(),
  halfLifeDays: number = V19_DEFAULT_FEEDBACK_HALF_LIFE_DAYS,
): V19FeedbackRankedHit<T>[] {
  const ranked: V19FeedbackRankedHit<T>[] = hits.map((hit) => {
    const entry = feedback.get(hit.factId);
    const fScore = entry ? feedbackScoreV19(entry, now, halfLifeDays) : 0;
    const boost = 1 + V19_FEEDBACK_MAX_BOOST * fScore;
    return {
      hit,
      feedbackScore: fScore,
      boost,
      effectiveScore: hit.score * boost,
    };
  });
  ranked.sort((a, b) => b.effectiveScore - a.effectiveScore);
  return ranked;
}

/** Tom tat feedback thanh text (tieng Viet) cho log/UI. */
export function formatV19FeedbackSummary(summary: V19FeedbackSummary): string {
  return [
    `Feedback memory v19: ${summary.facts} fact co feedback, ${summary.totalPositive} positive / ${summary.totalNegative} negative.`,
    summary.topPositive
      ? `  Khen nhieu nhat: ${summary.topPositive.factId} (${summary.topPositive.positive} positive).`
      : '  Chua co fact nao duoc khen.',
    summary.topNegative
      ? `  Che nhieu nhat: ${summary.topNegative.factId} (${summary.topNegative.negative} negative).`
      : '  Chua co fact nao bi che.',
  ].join('\n');
}
