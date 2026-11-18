/**
 * Memory v16 — Core promotion (v1.17, Doi T1).
 *
 * Y tuong hoc tu Letta/MemGPT (core memory blocks luon nam trong
 * context, agent tu quan ly bang tool; archival memory chi tim khi
 * can) — tu thiet ke lai hoan toan cho open-bot, chay 100% local,
 * KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `V15BlockStore` / `compileBlocksV15` / `applyBlockEditV15` cua
 *    memoryV15: store block + bien tap co version/history; v16 chi
 *    goi qua adapter, khong doi block engine.
 *  - `promoteToHumanBlock` cua graph/consolidateGraph.ts (v0.98):
 *    promotion don gian len block `human`; v16 mo rong thanh
 *    chinh sach day du (gate + dedup + budget + nhieu block dich).
 *  - `corePromotionGateV16` / `corePromotionGateForFactV16` cua
 *    poisoningGuard.ts: moi fact deu phai qua gate truoc khi vao
 *    core — promotion khong bao gio bo qua gate.
 *
 * Chinh sach promotion v16:
 *  - Dich block theo predicate: `likes/dislikes/prefers` va so
 *    thich -> block `human`; `lives_in/works_at/lives_with` va thong
 *    tin dinh danh -> block `persona`; `goal/constraint/task` ->
 *    block `task`; con lai -> block `human`. Block dich co label
 *    mac dinh (`v16-persona`, `v16-human`, `v16-task`) va duoc tao
 *    neu chua co.
 *  - Dedup: dong fact da co trong block (so sanh sau chuan hoa,
 *    bo dau tieng Viet) thi khong append lai; dong cu cung
 *    (subject, predicate) don tri nhung object khac thi duoc thay
 *    the bang dong moi (predicate da tri thi cac gia tri cung ton
 *    tai); block luon phan anh fact hien tai, lich su nam o graph.
 *  - Budget: moi block toi da `maxBlockChars` (mac dinh 8000, giong
 *    v15); vuot budget thi dong cu nhat (theo thoi gian promote)
 *    bi day xuong archival summary thay vi bi xoa lang.
 *  - Provenance footer: moi dong promote kem `[fact:<id8> <ngay>]`
 *    de UI nhay ve fact goc trong graph; dong khong co provenance
 *    hop le khong duoc promote (gate chan truoc).
 *  - Archival summary: fact du dieu kien nhung khong vao core
 *    (het budget / confidence vua du) duoc gom thanh tom tat theo
 *    predicate, luu vao block `custom` label `v16-archival` (chi
 *    doc khi retrieval can, khong nam trong prompt mac dinh).
 */

import type { GraphFact, MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import type { V15BlockKind, V15BlockStore } from '../../memoryV15/blocks';
import { V15_MAX_BLOCK_CHARS } from '../../memoryV15/blocks';
import { isSingleValuedPredicateV14 } from '../v14/extraction';
import { corePromotionGateForFactV16 } from './poisoningGuard';
import type { V16CoreGateOptions } from './poisoningGuard';

/** Loi core promotion v16 — message tieng Viet. */
export class V16PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V16PromotionError';
  }
}

/** Label block dich mac dinh cua v16. */
export const V16_PROMOTION_BLOCK_LABELS: Record<'persona' | 'human' | 'task', string> = {
  persona: 'v16-persona',
  human: 'v16-human',
  task: 'v16-task',
};
/** Label block archival summary cua v16. */
export const V16_ARCHIVAL_BLOCK_LABEL = 'v16-archival';
/** So ky tu toi da cua mot block promote (mac dinh = gioi han v15). */
export const V16_DEFAULT_MAX_BLOCK_CHARS = V15_MAX_BLOCK_CHARS;

/** Predicate nao -> block dich nao. */
export function targetBlockKindForPredicateV16(predicate: string): 'persona' | 'human' | 'task' {
  const p = (predicate ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (p === 'lives_in' || p === 'works_at' || p === 'lives_with' || p === 'speaks') return 'persona';
  if (p === 'goal' || p === 'constraint' || p === 'plans' || p === 'daily_routine') return 'task';
  return 'human';
}

/** Dinh dang mot fact thanh mot dong block (kem provenance footer). */
export function formatFactLineV16(fact: GraphFact, subjectName: string, at = new Date()): string {
  const object = fact.objectText ?? '';
  const predicateText = fact.predicate.replace(/_/g, ' ');
  const shortId = fact.id.slice(0, 8);
  const date = (fact.validFrom ?? at.toISOString()).slice(0, 10);
  return `- ${subjectName} ${predicateText} ${object} [fact:${shortId} ${date}]`;
}

/** Trich khoa (subject, predicate) chuan hoa tu mot dong block. */
export function blockLineKeyV16(line: string): { subjectPredicate: string; normalized: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('- ')) return null;
  const body = trimmed.slice(2).replace(/\s*\[fact:[^\]]*\]\s*$/, '').trim();
  const normalized = normalizeGraphText(body);
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { subjectPredicate: parts.slice(0, 2).join(' '), normalized };
}

/** Adapter toi thieu de promotion lam viec voi bat ky block store nao. */
export interface V16BlockAdapter {
  getBlock(label: string): { label: string; kind: V15BlockKind; content: string } | undefined;
  createBlock(label: string, kind: V15BlockKind, content: string): void;
  replaceBlock(label: string, content: string): void;
  appendToBlock(label: string, text: string): void;
}

/** Adapter cho V15BlockStore that (dung truc tiep trong open-bot). */
export class V16V15BlockAdapter implements V16BlockAdapter {
  constructor(private readonly store: V15BlockStore) {}

  getBlock(label: string): { label: string; kind: V15BlockKind; content: string } | undefined {
    const b = this.store.get(label);
    return b ? { label: b.label, kind: b.kind, content: b.content } : undefined;
  }

  createBlock(label: string, kind: V15BlockKind, content: string): void {
    this.store.create(label, kind, content, 'system:v16-promotion');
  }

  replaceBlock(label: string, content: string): void {
    this.store.replace(label, content, 'system:v16-promotion', 'v16-promotion-replace');
  }

  appendToBlock(label: string, text: string): void {
    this.store.append(label, text, 'system:v16-promotion', 'v16-promotion-append');
  }
}

/** Mot fact da promote (de bao cao). */
export interface V16PromotedFact {
  factId: string;
  blockLabel: string;
  kind: V15BlockKind;
  line: string;
}

/** Bao cao mot lan promotion. */
export interface V16PromotionReport {
  /** So fact da xet. */
  considered: number;
  /** So fact da vao core block. */
  promoted: V16PromotedFact[];
  /** So fact bi dedup (dong da co trong block). */
  deduplicated: number;
  /** So fact bi gate chan (kem ly do). */
  gatedOut: Array<{ factId: string; reasons: string[] }>;
  /** So fact day xuong archival vi het budget. */
  archived: number;
  /** So dong cu bi day khoi block do vuot budget. */
  evictedLines: number;
}

/** Tuy chon promotion. */
export interface V16PromotionOptions extends V16CoreGateOptions {
  /** So ky tu toi da cua mot block dich (mac dinh 8000). */
  maxBlockChars?: number;
  /** Ghi de label block dich mac dinh. */
  blockLabels?: Partial<Record<'persona' | 'human' | 'task', string>>;
  /** Actor ghi lich su block (mac dinh 'system:v16-promotion'). */
  actor?: string;
}

/**
 * Promote mot danh sach fact vao core block (qua adapter). Moi fact
 * deu qua `corePromotionGateForFactV16` truoc: gate chan thi ghi vao
 * `gatedOut`, khong vao block. Fact vuot budget cua block dich thi
 * xuong archival summary (khong mat).
 */
export function promoteFactsToCoreV16(
  store: TemporalGraphStore,
  facts: GraphFact[],
  scope: MemoryScope,
  adapter: V16BlockAdapter,
  sourceName: string,
  opts: V16PromotionOptions = {},
): V16PromotionReport {
  const maxChars = opts.maxBlockChars ?? V16_DEFAULT_MAX_BLOCK_CHARS;
  const labels = { ...V16_PROMOTION_BLOCK_LABELS, ...(opts.blockLabels ?? {}) };
  const report: V16PromotionReport = {
    considered: facts.length,
    promoted: [],
    deduplicated: 0,
    gatedOut: [],
    archived: 0,
    evictedLines: 0,
  };
  const archivalLines: string[] = [];

  for (const fact of facts) {
    const gate = corePromotionGateForFactV16(store, fact, scope, sourceName, opts);
    if (gate.decision !== 'allow') {
      report.gatedOut.push({ factId: fact.id, reasons: gate.reasons });
      continue;
    }
    const subjectName = store.getEntity(fact.subjectId)?.name ?? fact.subjectId;
    const kind = targetBlockKindForPredicateV16(fact.predicate);
    const label = labels[kind];
    const line = formatFactLineV16(fact, subjectName);
    const normalizedLine = normalizeGraphText(line.replace(/\s*\[fact:[^\]]*\]\s*$/, ''));

    let block = adapter.getBlock(label);
    if (!block) {
      // V15BlockStore cam content rong — tao block thang bang dong
      // dau tien (neu vuot budget thi xuong archival).
      if (line.length > maxChars) {
        archivalLines.push(line);
        report.archived += 1;
        continue;
      }
      adapter.createBlock(label, kind, line);
      report.promoted.push({ factId: fact.id, blockLabel: label, kind, line });
      continue;
    }
    const lines = block.content.split('\n').filter((l) => l.trim() !== '');
    const isDuplicate = lines.some((l) => {
      const parsed = blockLineKeyV16(l);
      return parsed !== null && parsed.normalized === normalizedLine;
    });
    if (isDuplicate) {
      report.deduplicated += 1;
      continue;
    }
    // Dong cu cung (subject, predicate) nhung object khac: chi thay
    // the khi predicate DON TRI (vd lives_in) — predicate da tri
    // (vd likes) thi cac gia tri khac nhau CUNG TON TAI trong block.
    const lineKey = blockLineKeyV16(line);
    const subjectPredicate = lineKey ? lineKey.subjectPredicate : '';
    const singleValued = isSingleValuedPredicateV14(fact.predicate);
    const keptLines = singleValued
      ? lines.filter((l) => {
          const parsed = blockLineKeyV16(l);
          if (!parsed) return true;
          return parsed.subjectPredicate !== subjectPredicate;
        })
      : lines;
    const replaced = keptLines.length !== lines.length;

    const nextContent = [...keptLines, line].join('\n');
    if (nextContent.length > maxChars) {
      archivalLines.push(line);
      report.archived += 1;
      continue;
    }
    if (replaced || keptLines.length === lines.length) {
      if (replaced) {
        adapter.replaceBlock(label, nextContent);
      } else {
        adapter.appendToBlock(label, line);
      }
      report.promoted.push({ factId: fact.id, blockLabel: label, kind, line });
    }
  }

  // Day dong cu nhat khoi block dich khi vuot budget (ghi vao archival).
  for (const kind of ['persona', 'human', 'task'] as const) {
    const label = labels[kind];
    const block = adapter.getBlock(label);
    if (!block || block.content.length <= maxChars) continue;
    const lines = block.content.split('\n').filter((l) => l.trim() !== '');
    let content = block.content;
    let evicted = 0;
    while (content.length > maxChars && lines.length > 1) {
      const removed = lines.shift();
      if (removed) archivalLines.push(removed);
      evicted += 1;
      content = lines.join('\n');
    }
    if (evicted > 0) {
      adapter.replaceBlock(label, content);
      report.evictedLines += evicted;
    }
  }

  if (archivalLines.length > 0) {
    let archival = adapter.getBlock(V16_ARCHIVAL_BLOCK_LABEL);
    const existing = archival
      ? archival.content.split('\n').filter((l) => l.trim() !== '')
      : [];
    const fresh = archivalLines.filter((l) => {
      const norm = normalizeGraphText(l.replace(/\s*\[fact:[^\]]*\]\s*$/, ''));
      return !existing.some((e) => normalizeGraphText(e.replace(/\s*\[fact:[^\]]*\]\s*$/, '')) === norm);
    });
    if (fresh.length > 0) {
      if (!archival) {
        adapter.createBlock(V16_ARCHIVAL_BLOCK_LABEL, 'custom', fresh.join('\n'));
      } else {
        adapter.appendToBlock(V16_ARCHIVAL_BLOCK_LABEL, fresh.join('\n'));
      }
    }
  }

  return report;
}

/**
 * Promote tat ca fact active du dieu kien trong scope (tien ich
 * cho sleep agent): loc fact theo scope, chi lay fact active va
 * dang hieu luc tai `at`, roi goi `promoteFactsToCoreV16`.
 */
export function promoteActiveFactsV16(
  store: TemporalGraphStore,
  scope: MemoryScope,
  adapter: V16BlockAdapter,
  sourceName: string,
  opts: V16PromotionOptions & { at?: Date; limit?: number } = {},
): V16PromotionReport {
  const at = opts.at ?? new Date();
  const limit = opts.limit ?? 200;
  const facts = store
    .listFacts({ ...scope, limit: 100000 })
    .filter((f) => f.status === 'active')
    .filter((f) => {
      const fromMs = Date.parse(f.validFrom);
      const untilMs = f.validUntil === null ? Infinity : Date.parse(f.validUntil);
      return !Number.isNaN(fromMs) && fromMs <= at.getTime() && at.getTime() < untilMs;
    })
    .sort((a, b) => b.confidence - a.confidence || b.validFrom.localeCompare(a.validFrom))
    .slice(0, Math.max(0, limit));
  return promoteFactsToCoreV16(store, facts, scope, adapter, sourceName, opts);
}
