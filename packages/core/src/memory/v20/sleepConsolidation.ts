/**
 * Memory v20 — Sleep-time consolidation (Letta-style, v1.28, Doi T1).
 *
 * Y tuong hoc tu Letta sleep-time compute: mot agent nen gom memory
 * GIUA session, ngoai critical path cua chat — tu thiet ke lai hoan
 * toan cho open-bot, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Pipeline (khong goi model, khong goi mang, chay hoan toan local):
 *   collect  — nhan candidate fact tu session vua xong (host day vao)
 *   dedupe   — gop fact trung lap theo Jaccard token; nhom co so
 *              khac nhau (vd ngay/gio) thi KHONG tu dong promote
 *              ma dua vao `needsReview` de user/agent quyet dinh
 *   decay    — confidence giam theo ham mu 0.5^(tuoi / halfLifeDays);
 *              fact roi duoi minConfidence thi bi prune khoi pool
 *   promote  — fact con lai, du tin cay, duoc append vao core block
 *              dich (mac dinh block `facts`) qua `applyEdit` voi
 *              actorKind 'sleep' — co ly do, version, lich su day du
 *   prune    — xoa fact het han khoi pool (block khong bi dong toi)
 *   report   — V20SleepReport tom tat moi buoc + loi theo muc
 *
 * An toan: loi o mot fact chi ghi vao report (fail-open theo muc),
 * khong throw ra caller; block day (vuot charLimit) thi fact bi
 * skip co ly do thay vi bi cat ngam; khong bao gio xoa lich su
 * block hay tu y sua block ngoai append qua tool path.
 */
import type { V20SleepReport, V20SleepTrigger } from './types';
import type { V20CoreBlockStore } from './coreBlocks';

/** Mot fact ung vien cho vao core memory — host thu thap tu session. */
export interface V20SleepFactCandidate {
  id: string;
  text: string;
  source: 'chat' | 'tool' | 'import' | 'sleep';
  confidence: number;
  observedAt: number;
  sessionId?: string;
  tags?: string[];
}

export interface V20SleepConsolidationOptions {
  /** Thoi gian confidence giam mot nua (ngay). Mac dinh 30. */
  halfLifeDays?: number;
  /** Confidence toi thieu de fact con song sau decay. Mac dinh 0.25. */
  minConfidence?: number;
  /** Confidence toi thieu de promote vao block. Mac dinh 0.6. */
  promoteThreshold?: number;
  /** So fact promote toi da moi lan chay. Mac dinh 20. */
  maxPromotePerRun?: number;
  /** Nguong Jaccard de coi hai fact la trung lap. Mac dinh 0.6. */
  dedupeThreshold?: number;
  /** Muc giam confidence toi thieu moi ap dung decay. Mac dinh 0.01. */
  minDecayApply?: number;
  /** Label block dich. Mac dinh 'facts'. */
  targetBlockLabel?: string;
  /** Do dai text toi thieu de nhan fact. Mac dinh 8 ky tu. */
  minTextLength?: number;
  /** Do dai text toi da de nhan fact. Mac dinh 500 ky tu. */
  maxTextLength?: number;
}

export interface V20SleepIntakeSummary {
  received: number;
  accepted: number;
  rejectedEmpty: number;
  rejectedTooLong: number;
  rejectedBadConfidence: number;
  rejectedDuplicateInBatch: number;
}

export interface V20SleepDedupeGroup {
  keepId: string;
  mergedIds: string[];
  mergedText: string;
  confidence: number;
  /** Nhom co so khac nhau (vd ngay khac nhau) — can nguoi xem lai. */
  needsReview: boolean;
  reviewReason?: string;
}

export interface V20SleepDecayEntry {
  factId: string;
  before: number;
  after: number;
  pruned: boolean;
}

export interface V20SleepPromoteEntry {
  factId: string;
  text: string;
  blockId: string;
  blockVersion: number;
  skipped?: string;
}

export const V20_SLEEP_DEFAULTS: Required<V20SleepConsolidationOptions> = {
  halfLifeDays: 30,
  minConfidence: 0.25,
  promoteThreshold: 0.6,
  maxPromotePerRun: 20,
  dedupeThreshold: 0.6,
  minDecayApply: 0.01,
  targetBlockLabel: 'facts',
  minTextLength: 8,
  maxTextLength: 500,
};

/** Chuan hoa text de so sanh trung lap: ha chu, bo dau cau, gon khoang trang. */
export function normalizeSleepTextV20(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sleepTextTokensV20(text: string): string[] {
  const norm = normalizeSleepTextV20(text);
  if (!norm) return [];
  return [...new Set(norm.split(' '))];
}

/** Jaccard tren tap token (da loai trung). 1 = giong het, 0 = khong chung token nao. */
export function jaccardSimilarityV20(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const t of a) if (setB.has(t)) inter += 1;
  return inter / (a.length + b.length - inter);
}

/** Confidence sau decay mu theo tuoi (ms) va half-life (ngay). */
export function decayConfidenceV20(confidence: number, ageMs: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return confidence;
  const ageDays = ageMs / 86_400_000;
  return confidence * Math.pow(0.5, ageDays / halfLifeDays);
}

function extractNumbersV20(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(',', '.'));
}

function groupNeedsReviewV20(members: V20SleepFactCandidate[]): string | undefined {
  const numberSets = members.map((m) => new Set(extractNumbersV20(m.text)));
  for (let i = 1; i < numberSets.length; i += 1) {
    const a = numberSets[0];
    const b = numberSets[i];
    const same = a.size === b.size && [...a].every((x) => b.has(x));
    if (!same) return 'cac fact gop co so khac nhau (ngay/gio/luong) — can xem lai truoc khi promote';
  }
  return undefined;
}

/**
 * Bo gom sleep-time: giu pool candidate fact trong bo nho, chay
 * pipeline theo yeu cau cua scheduler. Pool la ephemeral — nguon
 * chan ly van la core block; pool mat khi restart thi chi mat
 * candidate chua promote, khong mat memory da luu.
 */
export class V20SleepConsolidator {
  private pool = new Map<string, V20SleepFactCandidate>();
  private seq = 0;
  private lastReport: V20SleepReport | undefined;

  poolSize(): number {
    return this.pool.size;
  }

  listPool(): V20SleepFactCandidate[] {
    return [...this.pool.values()].sort((a, b) => b.confidence - a.confidence || b.observedAt - a.observedAt);
  }

  getLastReport(): V20SleepReport | undefined {
    return this.lastReport;
  }

  clearPool(): number {
    const n = this.pool.size;
    this.pool.clear();
    return n;
  }

  /**
   * Cap nhat confidence cua mot fact trong pool (v21 dung de boost
   * fact lap lai xuyen session). Tra false neu khong co fact hoac
   * confidence khong hop le.
   */
  setFactConfidence(factId: string, confidence: number): boolean {
    const fact = this.pool.get(factId);
    if (!fact) return false;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return false;
    this.pool.set(factId, { ...fact, confidence });
    return true;
  }

  /** Nhan candidate fact moi; loai fact rong / qua dai / confidence vo ly ngay tu dau. */
  addCandidates(
    facts: Omit<V20SleepFactCandidate, 'id'>[] | V20SleepFactCandidate[],
    options?: V20SleepConsolidationOptions,
  ): V20SleepIntakeSummary {
    const opts = { ...V20_SLEEP_DEFAULTS, ...options };
    const summary: V20SleepIntakeSummary = {
      received: facts.length,
      accepted: 0,
      rejectedEmpty: 0,
      rejectedTooLong: 0,
      rejectedBadConfidence: 0,
      rejectedDuplicateInBatch: 0,
    };
    const seenNormalized = new Set<string>();
    for (const f of this.pool.values()) seenNormalized.add(normalizeSleepTextV20(f.text));
    for (const raw of facts) {
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (text.length < opts.minTextLength) {
        summary.rejectedEmpty += 1;
        continue;
      }
      if (text.length > opts.maxTextLength) {
        summary.rejectedTooLong += 1;
        continue;
      }
      if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
        summary.rejectedBadConfidence += 1;
        continue;
      }
      const norm = normalizeSleepTextV20(text);
      if (seenNormalized.has(norm)) {
        summary.rejectedDuplicateInBatch += 1;
        continue;
      }
      seenNormalized.add(norm);
      this.seq += 1;
      const id = 'id' in raw && raw.id ? raw.id : `sleep-fact-${Date.now()}-${this.seq}`;
      this.pool.set(id, {
        id,
        text,
        source: raw.source,
        confidence: raw.confidence,
        observedAt: raw.observedAt,
        sessionId: raw.sessionId,
        tags: raw.tags ? [...raw.tags] : [],
      });
      summary.accepted += 1;
    }
    return summary;
  }

  /**
   * Gop fact trung lap trong pool theo Jaccard token. Giu fact co
   * confidence cao nhat (hoa thi moi nhat); nhom co so khac nhau
   * thi danh dau needsReview va KHONG promote tu dong.
   */
  dedupePool(options?: V20SleepConsolidationOptions): V20SleepDedupeGroup[] {
    const opts = { ...V20_SLEEP_DEFAULTS, ...options };
    const facts = this.listPool();
    const used = new Set<string>();
    const groups: V20SleepDedupeGroup[] = [];
    for (const fact of facts) {
      if (used.has(fact.id)) continue;
      const tokens = sleepTextTokensV20(fact.text);
      const members: V20SleepFactCandidate[] = [fact];
      used.add(fact.id);
      for (const other of facts) {
        if (used.has(other.id)) continue;
        const sim = jaccardSimilarityV20(tokens, sleepTextTokensV20(other.text));
        if (sim >= opts.dedupeThreshold) {
          members.push(other);
          used.add(other.id);
        }
      }
      members.sort((a, b) => b.confidence - a.confidence || b.observedAt - a.observedAt);
      const keep = members[0];
      const reviewReason = members.length > 1 ? groupNeedsReviewV20(members) : undefined;
      groups.push({
        keepId: keep.id,
        mergedIds: members.slice(1).map((m) => m.id),
        mergedText: keep.text,
        confidence: keep.confidence,
        needsReview: reviewReason !== undefined,
        reviewReason,
      });
      for (const m of members.slice(1)) this.pool.delete(m.id);
    }
    return groups;
  }

  /**
   * Decay toan bo pool ve thoi diem `now`. Fact roi duoi
   * minConfidence thi bi prune khoi pool (chi dem, khong dong
   * toi block). Tra ve bang decay de report/ghi log.
   */
  decayPool(now: number, options?: V20SleepConsolidationOptions): V20SleepDecayEntry[] {
    const opts = { ...V20_SLEEP_DEFAULTS, ...options };
    const entries: V20SleepDecayEntry[] = [];
    for (const fact of [...this.pool.values()]) {
      const after = decayConfidenceV20(fact.confidence, now - fact.observedAt, opts.halfLifeDays);
      const applied = fact.confidence - after >= opts.minDecayApply ? after : fact.confidence;
      const pruned = applied < opts.minConfidence;
      entries.push({ factId: fact.id, before: fact.confidence, after: applied, pruned });
      if (pruned) this.pool.delete(fact.id);
      else if (applied !== fact.confidence) this.pool.set(fact.id, { ...fact, confidence: applied });
    }
    return entries;
  }

  /**
   * Promote fact du tin cay vao block dich. Moi fact la mot
   * `append` rieng (ly do + actorKind 'sleep') de lich su ro
   * rang fact nao vao luc nao. Fact vao nhom needsReview, fact
   * vuot qua maxPromotePerRun, hoac block day deu bi skip co
   * ly do ghi trong report.
   */
  promotePool(
    store: V20CoreBlockStore,
    now: number,
    reviewGroups: Map<string, V20SleepDedupeGroup>,
    options?: V20SleepConsolidationOptions,
  ): { promoted: V20SleepPromoteEntry[]; skipped: string[] } {
    const opts = { ...V20_SLEEP_DEFAULTS, ...options };
    const promoted: V20SleepPromoteEntry[] = [];
    const skipped: string[] = [];
    let target = store.getBlock(opts.targetBlockLabel);
    if (!target) {
      const created = store.createBlock({
        label: opts.targetBlockLabel,
        kind: 'facts',
        value: '',
        actor: 'sleep-time',
      });
      if (!created.ok || !created.block) {
        skipped.push(`khong tao duoc block dich "${opts.targetBlockLabel}": ${created.error ?? 'loi khong ro'}`);
        return { promoted, skipped };
      }
      target = created.block;
    }
    const candidates = this.listPool()
      .filter((f) => f.confidence >= opts.promoteThreshold)
      .slice(0, opts.maxPromotePerRun);
    for (const fact of candidates) {
      const group = reviewGroups.get(fact.id);
      if (group?.needsReview) {
        skipped.push(`fact ${fact.id} can xem lai: ${group.reviewReason ?? 'mau thuan so'}`);
        continue;
      }
      const res = store.applyEdit({
        blockId: target.id,
        op: 'append',
        actor: 'sleep-time',
        actorKind: 'sleep',
        text: `- ${fact.text}`,
        reason: `sleep-time promote fact (confidence ${fact.confidence.toFixed(2)})`,
      });
      if (!res.ok || !res.block) {
        skipped.push(`fact ${fact.id} khong promote duoc: ${res.error ?? 'loi khong ro'}`);
        continue;
      }
      target = res.block;
      promoted.push({ factId: fact.id, text: fact.text, blockId: target.id, blockVersion: target.version });
      this.pool.delete(fact.id);
    }
    return { promoted, skipped };
  }

  /**
   * Chay tron pipeline mot pass: dedupe -> decay -> promote.
   * Khong throw: moi loi theo muc ghi vao report.errors.
   */
  run(
    store: V20CoreBlockStore,
    trigger: V20SleepTrigger,
    options?: V20SleepConsolidationOptions,
    now = Date.now(),
  ): V20SleepReport {
    const opts = { ...V20_SLEEP_DEFAULTS, ...options };
    const startedAt = now;
    const jobId = `sleep-${startedAt}-${Math.floor(Math.random() * 1e6)}`;
    const errors: string[] = [];
    const skipped: string[] = [];
    const blocksUpdated: string[] = [];
    let factsCollected = 0;
    let duplicatesMerged = 0;
    let factsDecayed = 0;
    let factsPromoted = 0;
    let factsPruned = 0;
    try {
      factsCollected = this.poolSize();
      const groups = this.dedupePool(opts);
      const reviewByKeep = new Map(groups.map((g) => [g.keepId, g]));
      for (const g of groups) duplicatesMerged += g.mergedIds.length;
      const decayed = this.decayPool(startedAt, opts);
      for (const d of decayed) {
        if (d.pruned) factsPruned += 1;
        else if (d.after < d.before) factsDecayed += 1;
      }
      const { promoted, skipped: promoteSkipped } = this.promotePool(store, startedAt, reviewByKeep, opts);
      factsPromoted = promoted.length;
      skipped.push(...promoteSkipped);
      for (const p of promoted) if (!blocksUpdated.includes(p.blockId)) blocksUpdated.push(p.blockId);
      for (const g of groups) {
        if (g.needsReview) skipped.push(`nhom ${g.keepId} can xem lai: ${g.reviewReason ?? ''}`);
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    const finishedAt = Date.now();
    const report: V20SleepReport = {
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
    };
    this.lastReport = report;
    return report;
  }
}
