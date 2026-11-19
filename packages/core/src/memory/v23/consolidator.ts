/**
 * Memory v23 — consolidator (v1.38, Doi T1).
 *
 * Mem0-style consolidate: moi ung vien trich xuat duoc so sanh voi
 * store hien tai va nhan mot quyet dinh:
 *  - add: chua co gi giong — them moi.
 *  - update: cung chu de, bo sung chi tiet — cap nhat record cu
 *    (tang version, giu lich su qua version).
 *  - supersede: mau thuan truc tiep (gia tri moi thay gia tri cu)
 *    — record cu -> superseded, them record moi.
 *  - merge: gan trung lap — gop vao record cu (text dai hon thang,
 *    confidence lay max, entity hop nhat).
 *  - noise: cau khong co gia tri luu tru (du extractor lot) — bo.
 *  - drop: trung lap hoan toan / confidence qua thap — bo.
 *
 * Phat hien mau thuan kieu luat (khong can model):
 *  - Cung entity + cung kind preference/decision/fact nhung gia tri
 *    doi lap ("thich" vs "khong thich", "dung X" vs "dung Y" voi
 *    cung chu de, so lieu khac nhau cung don vi).
 *  - Phu dinh truc tiep: mot cau phu dinh cau kia ("khong ..." vs
 *    khong co "khong") voi Jaccard cao.
 *
 * Consolidator KHONG tu goi model, KHONG xoa cung du lieu: record
 * cu chi doi status (superseded/merged), van doc duoc qua store.
 */

import { jaccardV23 } from './types';
import type { V23MemoryStore } from './store';
import type {
  V23ConsolidationDecision,
  V23ConsolidationReport,
  V23DecisionKind,
  V23ExtractCandidate,
  V23MemoryRecord,
} from './types';

/** Tuy chon consolidator. */
export interface V23ConsolidatorOptions {
  /** Jaccard >= nguong nay = gan trung lap (mac dinh 0.6). */
  mergeThreshold?: number;
  /** Jaccard >= nguong nay = trung lap hoan toan (mac dinh 0.9). */
  duplicateThreshold?: number;
  /** Confidence toi thieu de xet add (mac dinh 0.35). */
  minConfidence?: number;
  /** Ham lay thoi gian (test truyen clock co dinh). */
  now?: () => number;
}

/** Cap doi lap don gian cho phat hien mau thuan preference/decision. */
const OPPOSITE_PAIRS: [RegExp, RegExp][] = [
  [/\bthích\b/i, /\bkhông thích\b/i],
  [/\bthich\b/i, /\bkhong thich\b/i],
  [/\bthích\b/i, /\bkhong thich\b/i],
  [/\bthich\b/i, /\bkhông thích\b/i],
  [/\bghét\b/i, /\bthích\b/i],
  [/\bghet\b/i, /\bthich\b/i],
  [/\blove\b/i, /\bhate\b/i],
  [/\blike\b/i, /\bdislike\b/i],
  [/\bprefer\b/i, /\bdislike\b/i],
  [/\bwill use\b/i, /\bwill not use\b/i],
  [/\bsẽ dùng\b/i, /\bkhông dùng\b/i],
  [/\bse dung\b/i, /\bkhong dung\b/i],
];

/** Cau co chua phu dinh manh khong. */
export function hasNegationV23(text: string): boolean {
  return /\b(không|khong|never|not|no longer|ngừng|ngung|dừng|dung)\b/i.test(text);
}

/**
 * Hai text co mau thuan truc tiep khong (cung chu de, gia tri doi lap).
 * Dieu kien: Jaccard >= 0.35 (cung chu de) VA (cap doi lap khop
 * hoac mot ben phu dinh, ben kia khong).
 */
export function isContradictionV23(a: string, b: string): boolean {
  const sim = jaccardV23(a, b);
  if (sim < 0.35) return false;
  for (const [p1, p2] of OPPOSITE_PAIRS) {
    if ((p1.test(a) && p2.test(b)) || (p2.test(a) && p1.test(b))) return true;
  }
  const negA = hasNegationV23(a);
  const negB = hasNegationV23(b);
  if (negA !== negB && sim >= 0.55) return true;
  return false;
}

/** Gop text: lay cau dai hon (nhieu chi tiet hon) lam goc, giu cau kia trong ly do. */
export function mergeTextsV23(existing: string, incoming: string): string {
  const a = existing.trim();
  const b = incoming.trim();
  if (a === b) return a;
  return a.length >= b.length ? a : b;
}

/** Hop nhat entity/tags (duy nhat, giu thu tu). */
export function unionStringsV23(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...a, ...b]) {
    const norm = s.trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Quyet dinh cho mot ung vien so voi store (khong ghi — chi tinh).
 * Dung chung cho ca consolidate() lan luot lan preview (dry-run).
 */
export function decideV23(
  candidate: V23ExtractCandidate,
  store: V23MemoryStore,
  opts: V23ConsolidatorOptions = {},
): { decision: V23DecisionKind; target?: V23MemoryRecord; reason: string } {
  const mergeThreshold = opts.mergeThreshold ?? 0.6;
  const duplicateThreshold = opts.duplicateThreshold ?? 0.9;
  const minConfidence = opts.minConfidence ?? 0.35;

  if (candidate.confidence < minConfidence) {
    return { decision: 'drop', reason: `confidence ${candidate.confidence} < ${minConfidence}` };
  }
  const trimmed = candidate.text.trim();
  if (trimmed.length < 8) return { decision: 'noise', reason: 'cau qua ngan, khong co gia tri luu' };

  const actives = store.listActive();
  let best: V23MemoryRecord | null = null;
  let bestSim = 0;
  for (const record of actives) {
    const sim = jaccardV23(candidate.text, record.text);
    if (sim > bestSim) {
      bestSim = sim;
      best = record;
    }
  }

  // Trung lap hoan toan -> drop.
  if (best && bestSim >= duplicateThreshold) {
    return { decision: 'drop', target: best, reason: `trung lap ${(bestSim).toFixed(2)} voi ${best.id}` };
  }
  // Mau thuan truc tiep voi record giong nhat -> supersede.
  if (best && isContradictionV23(candidate.text, best.text)) {
    return {
      decision: 'supersede',
      target: best,
      reason: `mau thuan voi ${best.id} (similarity ${bestSim.toFixed(2)})`,
    };
  }
  // Gan trung lap -> merge (neu cung kind) hoac update (khac kind nhung cung chu de).
  if (best && bestSim >= mergeThreshold) {
    if (best.kind === candidate.kind) {
      return {
        decision: 'merge',
        target: best,
        reason: `gan trung lap ${(bestSim).toFixed(2)} voi ${best.id} (cung kind ${best.kind})`,
      };
    }
    return {
      decision: 'update',
      target: best,
      reason: `bo sung chi tiet cho ${best.id} (similarity ${bestSim.toFixed(2)})`,
    };
  }
  // Cung entity + cung kind nhung text khac han -> update (lam giau record).
  if (best && bestSim >= 0.3 && candidate.entities.length > 0) {
    const shared = candidate.entities.filter((e) => best?.entities.includes(e));
    if (shared.length > 0 && best.kind === candidate.kind) {
      return {
        decision: 'update',
        target: best,
        reason: `cung entity (${shared.join(', ')}) + cung kind ${best.kind} voi ${best.id}`,
      };
    }
  }
  return { decision: 'add', reason: 'chua co record tuong tu' };
}

/**
 * Consolidator: chay lan luot cac ung vien, ap dung quyet dinh vao
 * store, tra bao cao day du (kem audit trail tung quyet dinh).
 * Thu tu xu ly: confidence cao truoc (de quyet dinh tot thang).
 */
export class V23Consolidator {
  private readonly mergeThreshold: number;
  private readonly duplicateThreshold: number;
  private readonly minConfidence: number;
  private readonly now: () => number;

  constructor(opts: V23ConsolidatorOptions = {}) {
    this.mergeThreshold = opts.mergeThreshold ?? 0.6;
    this.duplicateThreshold = opts.duplicateThreshold ?? 0.9;
    this.minConfidence = opts.minConfidence ?? 0.35;
    this.now = opts.now ?? Date.now;
  }

  /** Preview (dry-run): quyet dinh ma khong ghi store. */
  preview(
    candidates: V23ExtractCandidate[],
    store: V23MemoryStore,
  ): V23ConsolidationDecision[] {
    const ordered = [...candidates].sort((a, b) => b.confidence - a.confidence);
    return ordered.map((candidate) => {
      const d = decideV23(candidate, store, {
        mergeThreshold: this.mergeThreshold,
        duplicateThreshold: this.duplicateThreshold,
        minConfidence: this.minConfidence,
      });
      return {
        candidate,
        decision: d.decision,
        ...(d.target ? { targetId: d.target.id } : {}),
        reason: d.reason,
      };
    });
  }

  /** Chay that: ap dung tung quyet dinh vao store. */
  consolidate(
    candidates: V23ExtractCandidate[],
    store: V23MemoryStore,
    source = 'consolidate-v23',
  ): V23ConsolidationReport {
    const started = Date.now();
    const ranAt = this.now();
    const ordered = [...candidates].sort((a, b) => b.confidence - a.confidence);
    const decisions: V23ConsolidationDecision[] = [];
    let added = 0;
    let updated = 0;
    let superseded = 0;
    let merged = 0;
    let noise = 0;
    let dropped = 0;

    for (const candidate of ordered) {
      const d = decideV23(candidate, store, {
        mergeThreshold: this.mergeThreshold,
        duplicateThreshold: this.duplicateThreshold,
        minConfidence: this.minConfidence,
      });
      const decision: V23ConsolidationDecision = {
        candidate,
        decision: d.decision,
        ...(d.target ? { targetId: d.target.id } : {}),
        reason: d.reason,
      };

      if (d.decision === 'add') {
        const res = store.put({
          kind: candidate.kind,
          text: candidate.text,
          entities: candidate.entities,
          confidence: candidate.confidence,
          source,
        });
        if (res.ok && res.record) {
          decision.resultId = res.record.id;
          added += 1;
        } else {
          decision.decision = 'drop';
          decision.reason = `add that bai: ${res.error ?? '?'}`;
          dropped += 1;
        }
      } else if (d.decision === 'update' && d.target) {
        const target = store.get(d.target.id);
        if (!target) {
          decision.decision = 'drop';
          decision.reason = 'target bien mat truoc khi update';
          dropped += 1;
        } else {
          const res = store.update(target.id, {
            text: mergeTextsV23(target.text, candidate.text),
            entities: unionStringsV23(target.entities, candidate.entities),
            confidence: Math.max(target.confidence, candidate.confidence),
          });
          if (res.ok && res.record) {
            decision.resultId = res.record.id;
            updated += 1;
          } else {
            decision.decision = 'drop';
            decision.reason = `update that bai: ${res.error ?? '?'}`;
            dropped += 1;
          }
        }
      } else if (d.decision === 'merge' && d.target) {
        const target = store.get(d.target.id);
        if (!target) {
          decision.decision = 'drop';
          decision.reason = 'target bien mat truoc khi merge';
          dropped += 1;
        } else {
          const res = store.update(target.id, {
            text: mergeTextsV23(target.text, candidate.text),
            entities: unionStringsV23(target.entities, candidate.entities),
            tags: unionStringsV23(target.tags, []),
            confidence: Math.max(target.confidence, candidate.confidence),
            status: 'active',
          });
          if (res.ok && res.record) {
            decision.resultId = res.record.id;
            merged += 1;
          } else {
            decision.decision = 'drop';
            decision.reason = `merge that bai: ${res.error ?? '?'}`;
            dropped += 1;
          }
        }
      } else if (d.decision === 'supersede' && d.target) {
        const target = store.get(d.target.id);
        if (!target) {
          decision.decision = 'drop';
          decision.reason = 'target bien mat truoc khi supersede';
          dropped += 1;
        } else {
          store.update(target.id, { status: 'superseded' });
          const res = store.put({
            kind: candidate.kind,
            text: candidate.text,
            entities: candidate.entities,
            confidence: candidate.confidence,
            source,
          });
          if (res.ok && res.record) {
            store.update(target.id, { supersededBy: res.record.id });
            decision.resultId = res.record.id;
            superseded += 1;
          } else {
            decision.decision = 'drop';
            decision.reason = `supersede that bai: ${res.error ?? '?'}`;
            dropped += 1;
          }
        }
      } else if (d.decision === 'noise') {
        noise += 1;
      } else {
        dropped += 1;
      }
      decisions.push(decision);
    }

    return {
      candidates: candidates.length,
      added,
      updated,
      superseded,
      merged,
      noise,
      dropped,
      decisions,
      ranAt,
      durationMs: Date.now() - started,
    };
  }
}
