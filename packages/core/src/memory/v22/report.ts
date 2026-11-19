/**
 * Memory v22 — Report: dinh dang bao cao dream de doc + xu huong
 * (v1.37, Doi T1).
 *
 * Y tuong (bai "Agent Memory Consolidation": job nightly phai
 * kiem chung duoc no da lam gi): bao cao khong chi la JSON —
 * no render duoc thanh text/Markdown de user doc, va nhieu bao
 * cao gop lai cho thay xu huong (dream co dang lam sach memory
 * hay chi dao qua dao lai).
 *
 *  - `formatDreamChangeV22`: mot thay doi thanh mot dong co
 *    bang chung (fact truoc -> fact sau + ly do).
 *  - `formatDreamReportV22`: toan bo bao cao thanh text de doc.
 *  - `dreamReportToMarkdownV22`: bao cao day du dang Markdown
 *    (de luu file / hien UI).
 *  - `summarizeDreamTrendV22`: gop nhieu bao cao thanh xu
 *    huong (tong gop/supersede/het han/pattern, thoi gian trung
 *    binh, ty le dream that bai/rollback).
 */
import type { V22DreamChange, V22DreamReport } from './types';

/** Mot thay doi thanh mot dong co bang chung. */
export function formatDreamChangeV22(change: V22DreamChange): string {
  const before = change.factIdsBefore.length > 0 ? change.factIdsBefore.join(', ') : '(moi)';
  const after = change.factIdsAfter.length > 0 ? change.factIdsAfter.join(', ') : '(khong con)';
  const detail = change.detail ? ` — ${change.detail}` : '';
  return `[${change.kind}] ${before} -> ${after}: ${change.reason}${detail}`;
}

/** Nhom thay doi theo kind (de bao cao gon). */
export function groupChangesByKindV22(
  changes: V22DreamChange[],
): Map<V22DreamChange['kind'], V22DreamChange[]> {
  const grouped = new Map<V22DreamChange['kind'], V22DreamChange[]>();
  for (const change of changes) {
    const list = grouped.get(change.kind) ?? [];
    list.push(change);
    grouped.set(change.kind, list);
  }
  return grouped;
}

/** Bao cao thanh text de doc (tom tat + thay doi theo nhom). */
export function formatDreamReportV22(report: V22DreamReport): string {
  const lines: string[] = [];
  lines.push(`Dream ${report.jobId} (${report.trigger}${report.dryRun ? ', dry-run' : ''}) — ${report.durationMs}ms.`);
  lines.push(`Fact active: ${report.factsBefore} -> ${report.factsAfter} (thu thap them ${report.factsCollected}).`);
  lines.push(`Gop ${report.duplicatesMerged} | supersede ${report.factsSuperseded} | het han ${report.factsExpired} | pattern moi ${report.patternsCreated} / cap nhat ${report.patternsUpdated} | wiki ${report.wikiPages} trang.`);
  lines.push(
    `Always-loaded: ${report.budgetBefore.chars} -> ${report.budgetAfter.chars} ky tu (ngan sach ${report.budgetAfter.budgetChars}), ${report.budgetAfter.factCount} fact, ${report.budgetAfter.withinBudget ? 'vua ngan sach' : `vuot ${report.budgetAfter.overByChars} ky tu`}.`,
  );
  if (report.snapshotId) lines.push(`Snapshot: ${report.snapshotId}.`);
  if (report.rolledBack) lines.push('CANH BAO: dream gap loi va da rollback ve snapshot.');
  if (report.errors.length > 0) {
    lines.push(`Loi (${report.errors.length}):`);
    for (const error of report.errors) lines.push(`- ${error}`);
  }
  if (report.skipped.length > 0) {
    lines.push(`Bo qua (${report.skipped.length}):`);
    for (const skip of report.skipped.slice(0, 10)) lines.push(`- ${skip}`);
    if (report.skipped.length > 10) lines.push(`- ... va ${report.skipped.length - 10} muc khac.`);
  }
  const grouped = groupChangesByKindV22(report.changes);
  if (grouped.size > 0) {
    lines.push(`Thay doi (${report.changes.length}):`);
    for (const [kind, list] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`## ${kind} (${list.length})`);
      for (const change of list.slice(0, 10)) lines.push(`- ${formatDreamChangeV22(change)}`);
      if (list.length > 10) lines.push(`- ... va ${list.length - 10} thay doi ${kind} khac.`);
    }
  } else {
    lines.push('Khong co thay doi nao.');
  }
  return lines.join('\n');
}

/** Bao cao day du dang Markdown (de luu file / hien UI). */
export function dreamReportToMarkdownV22(report: V22DreamReport): string {
  const lines: string[] = [];
  lines.push(`# Dream report ${report.jobId}`);
  lines.push('');
  lines.push(`- Trigger: \`${report.trigger}\`${report.dryRun ? ' (dry-run)' : ''}`);
  lines.push(`- Thoi gian: ${new Date(report.startedAt).toISOString()} → ${new Date(report.finishedAt).toISOString()} (${report.durationMs}ms)`);
  lines.push(`- Fact active: ${report.factsBefore} → ${report.factsAfter} (thu thap them ${report.factsCollected})`);
  lines.push(`- Gop: ${report.duplicatesMerged} | Supersede: ${report.factsSuperseded} | Het han: ${report.factsExpired}`);
  lines.push(`- Pattern: moi ${report.patternsCreated} / cap nhat ${report.patternsUpdated} | Wiki: ${report.wikiPages} trang`);
  lines.push(`- Always-loaded: ${report.budgetBefore.chars} → ${report.budgetAfter.chars} ky tu (ngan sach ${report.budgetAfter.budgetChars})`);
  if (report.snapshotId) lines.push(`- Snapshot: \`${report.snapshotId}\``);
  if (report.rolledBack) lines.push('- **Da rollback ve snapshot do loi.**');
  lines.push('');
  lines.push('## Thay doi');
  lines.push('');
  if (report.changes.length === 0) {
    lines.push('Khong co thay doi nao.');
  } else {
    for (const change of report.changes) {
      lines.push(`- ${formatDreamChangeV22(change)}`);
    }
  }
  if (report.errors.length > 0) {
    lines.push('');
    lines.push('## Loi');
    lines.push('');
    for (const error of report.errors) lines.push(`- ${error}`);
  }
  if (report.skipped.length > 0) {
    lines.push('');
    lines.push('## Bo qua');
    lines.push('');
    for (const skip of report.skipped) lines.push(`- ${skip}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Xu huong gop tu nhieu bao cao dream. */
export interface V22DreamTrend {
  dreams: number;
  dryRuns: number;
  failed: number;
  rolledBack: number;
  totalMerged: number;
  totalSuperseded: number;
  totalExpired: number;
  totalPatternsCreated: number;
  totalPatternsUpdated: number;
  avgDurationMs: number;
  avgFactsAfter: number;
  /** Ty le dream that bai (0..1). */
  failureRate: number;
}

/** Gop nhieu bao cao thanh xu huong (de UI bao "dream co hieu qua khong"). */
export function summarizeDreamTrendV22(reports: V22DreamReport[]): V22DreamTrend {
  const trend: V22DreamTrend = {
    dreams: reports.length,
    dryRuns: 0,
    failed: 0,
    rolledBack: 0,
    totalMerged: 0,
    totalSuperseded: 0,
    totalExpired: 0,
    totalPatternsCreated: 0,
    totalPatternsUpdated: 0,
    avgDurationMs: 0,
    avgFactsAfter: 0,
    failureRate: 0,
  };
  if (reports.length === 0) return trend;
  let durationSum = 0;
  let factsAfterSum = 0;
  for (const report of reports) {
    if (report.dryRun) trend.dryRuns += 1;
    if (report.errors.length > 0) trend.failed += 1;
    if (report.rolledBack) trend.rolledBack += 1;
    trend.totalMerged += report.duplicatesMerged;
    trend.totalSuperseded += report.factsSuperseded;
    trend.totalExpired += report.factsExpired;
    trend.totalPatternsCreated += report.patternsCreated;
    trend.totalPatternsUpdated += report.patternsUpdated;
    durationSum += report.durationMs;
    factsAfterSum += report.factsAfter;
  }
  trend.avgDurationMs = Math.round(durationSum / reports.length);
  trend.avgFactsAfter = Math.round((factsAfterSum / reports.length) * 100) / 100;
  trend.failureRate = Math.round((trend.failed / reports.length) * 1000) / 1000;
  return trend;
}

/** Xu huong thanh mot dong tom tat de doc. */
export function formatDreamTrendV22(trend: V22DreamTrend): string {
  if (trend.dreams === 0) return 'Chua co dream nao chay.';
  return `${trend.dreams} dream (${trend.dryRuns} dry-run): gop ${trend.totalMerged}, supersede ${trend.totalSuperseded}, het han ${trend.totalExpired}, pattern ${trend.totalPatternsCreated}/${trend.totalPatternsUpdated}, trung binh ${trend.avgDurationMs}ms/dream, ${trend.avgFactsAfter} fact active sau dream, that bai ${trend.failed} (${(trend.failureRate * 100).toFixed(1)}%)${trend.rolledBack > 0 ? `, rollback ${trend.rolledBack} lan` : ''}.`;
}

/**
 * Lich su dream: giu cac bao cao da chay (toi da 50 — cu nhat
 * tu roi) de tinh xu huong bat cu luc nao. Dreamer tu ghi moi
 * lan chay vao history cua no (ke ca dry-run — trend tach
 * rieng so dry-run).
 */
export class V22DreamHistory {
  private reports: V22DreamReport[] = [];
  private maxReports: number;

  constructor(maxReports = 50) {
    this.maxReports = maxReports > 0 ? Math.floor(maxReports) : 50;
  }

  /** So bao cao dang giu. */
  size(): number {
    return this.reports.length;
  }

  /** Ghi mot bao cao (cu nhat tu roi khi day gioi han). */
  record(report: V22DreamReport): void {
    this.reports.push(report);
    while (this.reports.length > this.maxReports) this.reports.shift();
  }

  /** Bao cao moi nhat (neu co). */
  latest(): V22DreamReport | undefined {
    return this.reports[this.reports.length - 1];
  }

  /** Liet ke bao cao (moi nhat truoc, gioi han so luong). */
  list(limit?: number): V22DreamReport[] {
    const sorted = [...this.reports].reverse();
    return limit !== undefined ? sorted.slice(0, limit) : sorted;
  }

  /** Xu huong gop tu toan bo lich su. */
  trend(): V22DreamTrend {
    return summarizeDreamTrendV22(this.reports);
  }

  /** Xu huong thanh mot dong tom tat de doc. */
  summarize(): string {
    return formatDreamTrendV22(this.trend());
  }

  /** Xoa lich su (chi dung khi user chu dich reset). */
  clear(): number {
    const n = this.reports.length;
    this.reports = [];
    return n;
  }
}
