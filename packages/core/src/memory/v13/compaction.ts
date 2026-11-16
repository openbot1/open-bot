/**
 * Memory v13 — compaction theo CoALA (v1.14, Doi T1).
 *
 * Y tuong hoc tu CoALA (Cognitive Architectures for Language Agents:
 * bo nho chia 4 tang working / episodic / semantic / procedural, agent
 * tu bien dich episodic thanh semantic khi day) va Letta (memory
 * compaction khi context day) — tu thiet ke lai hoan toan cho
 * open-bot, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - Tang episodic = fact cua `TemporalGraphStore` (co validFrom /
 *    validUntil / confidence / provenance).
 *  - Tang semantic = memory block (`MemoryBlockStore` + git version
 *    cua v13): ban tom tat theo subject duoc ghi thanh block de
 *    bien dich vao prompt.
 *  - Tang working = block dang mo / phien hien tai (khong dong vao
 *    o day — compaction chi doc working, khong xoa no).
 *
 * Luat v13:
 *  1. Compaction KHONG xoa: fact cu / version cu khong bi xoa, chi
 *     duoc danh dau "da tom tat" (qua bao cao) hoac de xuat review.
 *     Lich su van truy van duoc day du.
 *  2. Tom tat theo subject: gom fact active cua mot subject, xep
 *     theo confidence, lay top-N, viet thanh markdown de ghi vao
 *     block semantic (caller tu quyet dinh co ghi khong — ham nay
 *     chi TRA VE ban tom tat, khong tu ghi).
 *  3. Fact "cu" (khong cap nhat qua X ngay + confidence thap) duoc
 *     liet ke de review, kem ly do — khong tu dong xoa hay
 *     invalidate.
 *  4. Bao cao compaction tong hop: so fact theo subject, so version
 *     block, so fact cu, ban tom tat de nghi — de UI / sleep janitor
 *     goi dinh ky luc ranh.
 */

import type { GraphFact } from '../graph/types';
import { factSearchText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import type { ScopeFilter } from '../graph/store';
import { isFactValidAt } from '../graph/types';
import type { V13BlockGitStore } from './gitBlocks';

/** Loi compaction — message tieng Viet. */
export class V13CompactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V13CompactionError';
  }
}

/** Mot subject + fact cua no, de tom tat. */
export interface V13SubjectSummary {
  subject: string;
  factCount: number;
  /** Fact lay vao ban tom tat (top theo confidence). */
  topFacts: GraphFact[];
  /** Ban tom tat markdown (de ghi vao block semantic). */
  markdown: string;
  /** Fact khong lay vao tom tat (vuot top-N). */
  omittedCount: number;
}

/** Mot fact cu can review. */
export interface V13StaleFact {
  fact: GraphFact;
  subjectName: string;
  /** So ngay tu lan cap nhat cuoi. */
  ageDays: number;
  /** Ly do bi cho la cu (ket hop tuoi + confidence). */
  reason: string;
}

export interface V13CompactionOptions {
  /** So fact toi da moi subject trong ban tom tat (mac dinh 10). */
  topFactsPerSubject?: number;
  /** Chi fact con hieu luc (mac dinh true). */
  onlyValidNow?: boolean;
  /** Loc scope. */
  scope?: ScopeFilter;
  /** So ngay khong cap nhat thi tinh la "cu" (mac dinh 90). */
  staleAfterDays?: number;
  /** Confidence duoi nguong nay + cu thi dua vao review (mac dinh 0.6). */
  staleMaxConfidence?: number;
  /** Thoi diem "bay gio" (de test xac dinh). */
  now?: Date;
}

export interface V13CompactionReport {
  at: string;
  /** Tong fact active trong scope. */
  activeFacts: number;
  /** Tong subject co fact. */
  subjects: number;
  summaries: V13SubjectSummary[];
  staleFacts: V13StaleFact[];
  /** Thong ke version block (khi co gitStore). */
  blockVersions: { blockId: string; versions: number; branches: number }[];
  notes: string[];
}

export const V13_DEFAULT_TOP_FACTS_PER_SUBJECT = 10;
export const V13_DEFAULT_STALE_AFTER_DAYS = 90;
export const V13_DEFAULT_STALE_MAX_CONFIDENCE = 0.6;

/** Nhom fact active theo subject (ten entity). */
export function groupFactsBySubject(
  store: TemporalGraphStore,
  opts: V13CompactionOptions = {},
): Map<string, GraphFact[]> {
  const onlyValidNow = opts.onlyValidNow !== false;
  const now = opts.now ?? new Date();
  const facts = store
    .listFacts({ ...(opts.scope ?? {}), status: 'active', limit: 5000 })
    .filter((f) => !onlyValidNow || isFactValidAt(f, now));
  const groups = new Map<string, GraphFact[]>();
  for (const fact of facts) {
    const name = store.getEntity(fact.subjectId)?.name ?? 'user';
    const list = groups.get(name) ?? [];
    list.push(fact);
    groups.set(name, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt));
  }
  return groups;
}

/** Viet ban tom tat markdown cho mot subject tu fact cua no. */
export function summarizeSubject(
  store: TemporalGraphStore,
  subject: string,
  facts: GraphFact[],
  opts: V13CompactionOptions = {},
): V13SubjectSummary {
  const topN = Math.max(
    1,
    Math.min(50, Math.floor(opts.topFactsPerSubject ?? V13_DEFAULT_TOP_FACTS_PER_SUBJECT)),
  );
  const sorted = [...facts].sort(
    (a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt),
  );
  const topFacts = sorted.slice(0, topN);
  const lines: string[] = [`# ${subject}`, ''];
  for (const fact of topFacts) {
    const text = factSearchText(
      fact,
      subject,
      fact.objectId ? store.getEntity(fact.objectId)?.name : fact.objectText,
    );
    lines.push(
      `- ${text} (tin cay ${fact.confidence.toFixed(2)}, tu ${fact.validFrom.slice(0, 10)}` +
        (fact.validUntil ? ` den ${fact.validUntil.slice(0, 10)}` : '') +
        `)`,
    );
  }
  if (sorted.length > topN) {
    lines.push('', `_Con ${sorted.length - topN} fact khac ve ${subject} chua tom tat._`);
  }
  return {
    subject,
    factCount: facts.length,
    topFacts,
    markdown: lines.join('\n'),
    omittedCount: Math.max(0, sorted.length - topN),
  };
}

/** Tim fact cu: khong cap nhat qua X ngay va confidence thap. */
export function findStaleFacts(
  store: TemporalGraphStore,
  opts: V13CompactionOptions = {},
): V13StaleFact[] {
  const now = opts.now ?? new Date();
  const staleAfterDays = Math.max(
    1,
    Math.floor(opts.staleAfterDays ?? V13_DEFAULT_STALE_AFTER_DAYS),
  );
  const maxConfidence = opts.staleMaxConfidence ?? V13_DEFAULT_STALE_MAX_CONFIDENCE;
  const thresholdMs = now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000;
  const out: V13StaleFact[] = [];
  const facts = store.listFacts({ ...(opts.scope ?? {}), status: 'active', limit: 5000 });
  for (const fact of facts) {
    const updatedMs = Date.parse(fact.updatedAt);
    if (Number.isNaN(updatedMs) || updatedMs >= thresholdMs) continue;
    if (fact.confidence >= maxConfidence) continue;
    const ageDays = Math.floor((now.getTime() - updatedMs) / (24 * 60 * 60 * 1000));
    const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
    out.push({
      fact,
      subjectName,
      ageDays,
      reason:
        `Khong cap nhat ${ageDays} ngay (qua ${staleAfterDays} ngay) ` +
        `va confidence ${fact.confidence.toFixed(2)} < ${maxConfidence} — can review.`,
    });
  }
  out.sort((a, b) => b.ageDays - a.ageDays || a.fact.confidence - b.fact.confidence);
  return out;
}

/**
 * Chay compaction: tom tat tung subject + liet ke fact cu + thong ke
 * version block. Chi TRA VE bao cao — khong ghi, khong xoa gi ca.
 * Caller (UI / sleep janitor) tu quyet dinh co ghi ban tom tat vao
 * block semantic hay khong.
 */
export function compactMemory(
  store: TemporalGraphStore,
  opts: V13CompactionOptions & { gitStore?: V13BlockGitStore; blockIds?: string[] } = {},
): V13CompactionReport {
  const now = opts.now ?? new Date();
  const notes: string[] = [];
  const groups = groupFactsBySubject(store, opts);
  const summaries: V13SubjectSummary[] = [];
  for (const [subject, facts] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    summaries.push(summarizeSubject(store, subject, facts, opts));
  }
  const staleFacts = findStaleFacts(store, opts);
  const activeFacts = [...groups.values()].reduce((s, list) => s + list.length, 0);
  if (activeFacts === 0) notes.push('Khong co fact active nao de compact.');
  if (staleFacts.length > 0) {
    notes.push(`${staleFacts.length} fact cu can review (khong tu dong xoa).`);
  }
  const blockVersions: V13CompactionReport['blockVersions'] = [];
  if (opts.gitStore) {
    for (const blockId of opts.blockIds ?? []) {
      const stats = opts.gitStore.stats(blockId);
      blockVersions.push({ blockId, versions: stats.versions, branches: stats.branches });
    }
    if ((opts.blockIds ?? []).length === 0) {
      notes.push('Khong truyen blockIds nen khong thong ke version block.');
    }
  }
  return {
    at: now.toISOString(),
    activeFacts,
    subjects: groups.size,
    summaries,
    staleFacts,
    blockVersions,
    notes,
  };
}

/**
 * Dinh dang bao cao compaction dang markdown (de ghi log / hien UI).
 */
export function formatCompactionReport(report: V13CompactionReport): string {
  const lines: string[] = [
    `# Compaction memory v13 — ${report.at}`,
    '',
    `- Fact active: ${report.activeFacts} (tren ${report.subjects} subject)`,
    `- Fact cu can review: ${report.staleFacts.length}`,
    `- Block co thong ke version: ${report.blockVersions.length}`,
    '',
  ];
  for (const s of report.summaries) {
    lines.push(`## ${s.subject} (${s.factCount} fact, tom tat ${s.topFacts.length})`, '');
    lines.push(s.markdown, '');
  }
  if (report.staleFacts.length > 0) {
    lines.push('## Fact cu can review', '');
    for (const stale of report.staleFacts.slice(0, 20)) {
      lines.push(
        `- ${stale.subjectName}: "${stale.fact.objectText ?? ''}" — ${stale.reason}`,
      );
    }
    if (report.staleFacts.length > 20) {
      lines.push(`- … va ${report.staleFacts.length - 20} fact cu khac.`);
    }
    lines.push('');
  }
  if (report.notes.length > 0) {
    lines.push('## Ghi chu', '');
    for (const n of report.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}
