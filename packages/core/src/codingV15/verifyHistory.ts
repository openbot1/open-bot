/**
 * Coding agent v15 — verify history (lịch sử kiểm chứng).
 *
 * Một lần chạy verify chỉ nói "hôm nay pass mấy" — muốn biết agent
 * có đang tốt lên hay tệ đi thì phải so với lần chạy trước. Store
 * này lưu mỗi `V15VerifyReport` thành một dòng JSONL (append-only,
 * không sửa lịch sử), rồi:
 *
 * - `compareWithBaseline()`: scenario nào mới fail (regression),
 *   scenario nào vừa được sửa (fixed), scenario nào vẫn fail.
 * - `flaky()`: scenario lúc pass lúc fail qua các lần chạy (dấu
 *   hiệu test không ổn định hoặc agent không ổn định).
 * - `trend()`: pass rate qua thời gian (mỗi lần chạy một điểm).
 *
 * Store đọc/ghi file JSONL trong data dir (tuỳ chọn — không có
 * dataDir thì chỉ memory). Report trong file được validate nhẹ
 * (đủ field mới nạp, dòng hỏng bị bỏ qua và đếm).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV15Error } from './types';
import type { V15VerifyReport, V15VerifyScenarioResult } from './types';

/** Tên file lịch sử verify trong data dir. */
export const V15_VERIFY_HISTORY_FILE_NAME = 'verify-history.jsonl';

/** Số report tối đa giữ trong memory (file JSONL giữ toàn bộ). */
export const V15_VERIFY_HISTORY_MAX_MEMORY = 200;

/** Kết quả so sánh một lần chạy với baseline. */
export interface V15VerifyComparison {
  baselineRunId: string;
  currentRunId: string;
  /** Scenario pass ở baseline nhưng fail ở lần này (regression). */
  newlyFailed: string[];
  /** Scenario fail ở baseline nhưng pass ở lần này (đã sửa). */
  newlyPassed: string[];
  /** Scenario fail ở cả hai lần. */
  stillFailing: string[];
  /** Scenario pass ở cả hai lần. */
  stillPassing: string[];
  /** Scenario chỉ có ở một trong hai lần chạy. */
  onlyInOne: string[];
  summary: string;
}

/** Một scenario bị nghi flaky (lúc pass lúc fail). */
export interface V15VerifyFlaky {
  scenarioId: string;
  name: string;
  runs: number;
  passes: number;
  fails: number;
  /** Tỉ lệ pass (0..1). */
  passRate: number;
}

/** Một điểm trend: pass rate của một lần chạy. */
export interface V15VerifyTrendPoint {
  runId: string;
  createdAt: string;
  total: number;
  passed: number;
  passRate: number;
}

/** Validate nhẹ một report thô đọc từ file (đủ field mới nạp). */
export function v15IsValidVerifyReport(value: unknown): value is V15VerifyReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['runId'] === 'string' && (r['runId'] as string).length > 0 &&
    Number.isInteger(r['total']) && Number.isInteger(r['passed']) && Number.isInteger(r['failed']) &&
    Array.isArray(r['results']) &&
    (r['results'] as unknown[]).every((x) => {
      if (!x || typeof x !== 'object') return false;
      const s = x as Record<string, unknown>;
      return typeof s['scenarioId'] === 'string' && typeof s['passed'] === 'boolean';
    })
  );
}

/** So sánh hai report scenario-theo-scenario. */
export function v15CompareVerifyReports(baseline: V15VerifyReport, current: V15VerifyReport): V15VerifyComparison {
  const baseMap = new Map(baseline.results.map((r) => [r.scenarioId, r]));
  const curMap = new Map(current.results.map((r) => [r.scenarioId, r]));
  const newlyFailed: string[] = [];
  const newlyPassed: string[] = [];
  const stillFailing: string[] = [];
  const stillPassing: string[] = [];
  const onlyInOne: string[] = [];
  for (const [id, base] of baseMap) {
    const cur = curMap.get(id);
    if (!cur) {
      onlyInOne.push(id);
      continue;
    }
    if (base.passed && !cur.passed) newlyFailed.push(id);
    else if (!base.passed && cur.passed) newlyPassed.push(id);
    else if (!base.passed && !cur.passed) stillFailing.push(id);
    else stillPassing.push(id);
  }
  for (const id of curMap.keys()) {
    if (!baseMap.has(id)) onlyInOne.push(id);
  }
  return {
    baselineRunId: baseline.runId,
    currentRunId: current.runId,
    newlyFailed,
    newlyPassed,
    stillFailing,
    stillPassing,
    onlyInOne,
    summary:
      `Verify ${baseline.runId} → ${current.runId}: ` +
      `${newlyFailed.length > 0 ? `REGRESSION ${newlyFailed.join(', ')}; ` : ''}` +
      `${newlyPassed.length > 0 ? `fixed ${newlyPassed.join(', ')}; ` : ''}` +
      `${stillFailing.length > 0 ? `still failing ${stillFailing.join(', ')}; ` : ''}` +
      `${stillPassing.length} still passing.`,
  };
}

/** Render so sánh thành text. */
export function renderV15VerifyComparison(c: V15VerifyComparison): string {
  const lines = [
    `Verify comparison — ${c.baselineRunId} → ${c.currentRunId}`,
    `  Newly failed (regression): ${c.newlyFailed.length > 0 ? c.newlyFailed.join(', ') : 'none'}`,
    `  Newly passed (fixed): ${c.newlyPassed.length > 0 ? c.newlyPassed.join(', ') : 'none'}`,
    `  Still failing: ${c.stillFailing.length > 0 ? c.stillFailing.join(', ') : 'none'}`,
    `  Still passing: ${c.stillPassing.length}`,
    `  Only in one run: ${c.onlyInOne.length > 0 ? c.onlyInOne.join(', ') : 'none'}`,
    `  ${c.summary}`,
  ];
  return lines.join('\n');
}

/** Render danh sách flaky scenario thành text. */
export function renderV15VerifyFlaky(flaky: V15VerifyFlaky[]): string {
  if (flaky.length === 0) return 'No flaky scenarios.';
  return flaky
    .map((f) => `${f.scenarioId} (${f.name}): ${(f.passRate * 100).toFixed(0)}% pass over ${f.runs} run(s) — ${f.passes} passed, ${f.fails} failed`)
    .join('\n');
}

export interface V15VerifyHistoryOptions {
  /** Thư mục chứa verify-history.jsonl (bỏ qua = chỉ memory). */
  dataDir?: string;
  now?: () => string;
}

/**
 * Store lịch sử verify: append-only JSONL + memory cache.
 * Dòng hỏng trong file bị bỏ qua khi load (đếm vào `skippedLines`).
 */
export class CodingV15VerifyHistory {
  private reports: V15VerifyReport[] = [];
  private skippedLines = 0;
  private readonly dataDir?: string;

  constructor(options: V15VerifyHistoryOptions = {}) {
    this.dataDir = options.dataDir;
    if (this.dataDir) this.loadFromDisk();
  }

  private filePath(): string {
    return path.join(this.dataDir as string, V15_VERIFY_HISTORY_FILE_NAME);
  }

  private loadFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (v15IsValidVerifyReport(parsed)) {
            this.reports.push(parsed);
          } else {
            this.skippedLines += 1;
          }
        } catch {
          this.skippedLines += 1;
        }
      }
      if (this.reports.length > V15_VERIFY_HISTORY_MAX_MEMORY) {
        this.reports = this.reports.slice(-V15_VERIFY_HISTORY_MAX_MEMORY);
      }
    } catch {
      // File chưa có = history mới.
    }
  }

  /** Số dòng hỏng đã bỏ qua khi load file. */
  getSkippedLines(): number {
    return this.skippedLines;
  }

  /** Số report trong history. */
  get size(): number {
    return this.reports.length;
  }

  /** Thêm một report (ghi append vào file khi có dataDir). */
  append(report: V15VerifyReport): V15VerifyReport {
    if (!v15IsValidVerifyReport(report)) {
      throw new CodingV15Error('verify-invalid', 'Verify report không hợp lệ, không lưu history được.');
    }
    const copy: V15VerifyReport = {
      ...report,
      results: report.results.map((r: V15VerifyScenarioResult) => ({ ...r, checks: r.checks.map((c) => ({ ...c })) })),
    };
    this.reports.push(copy);
    if (this.reports.length > V15_VERIFY_HISTORY_MAX_MEMORY) {
      this.reports = this.reports.slice(-V15_VERIFY_HISTORY_MAX_MEMORY);
    }
    if (this.dataDir) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(this.filePath(), `${JSON.stringify(copy)}\n`, 'utf8');
    }
    return copy;
  }

  /** Report mới nhất (null khi chưa có). */
  latest(): V15VerifyReport | null {
    return this.reports.length > 0 ? this.reports[this.reports.length - 1] as V15VerifyReport : null;
  }

  /** Tìm report theo runId. */
  get(runId: string): V15VerifyReport | null {
    const found = this.reports.find((r) => r.runId === runId);
    return found ? { ...found, results: found.results.map((r) => ({ ...r, checks: r.checks.map((c) => ({ ...c })) })) } : null;
  }

  /** Tất cả report (cũ nhất trước, bản copy). */
  all(): V15VerifyReport[] {
    return this.reports.map((r) => ({ ...r, results: r.results.map((x) => ({ ...x, checks: x.checks.map((c) => ({ ...c })) })) }));
  }

  /** So sánh report mới nhất với report ngay trước nó. */
  compareLatestWithPrevious(): V15VerifyComparison | null {
    if (this.reports.length < 2) return null;
    const current = this.reports[this.reports.length - 1] as V15VerifyReport;
    const baseline = this.reports[this.reports.length - 2] as V15VerifyReport;
    return v15CompareVerifyReports(baseline, current);
  }

  /** So sánh một report bất kỳ với baseline theo runId. */
  compare(runId: string, baselineRunId: string): V15VerifyComparison {
    const current = this.get(runId);
    if (!current) throw new CodingV15Error('verify-scenario-not-found', `Không tìm thấy verify report "${runId}".`);
    const baseline = this.get(baselineRunId);
    if (!baseline) throw new CodingV15Error('verify-scenario-not-found', `Không tìm thấy verify baseline "${baselineRunId}".`);
    return v15CompareVerifyReports(baseline, current);
  }

  /** Scenario flaky: pass rate trong (0, 1) qua ít nhất 2 lần chạy. */
  flaky(minRuns = 2): V15VerifyFlaky[] {
    const byId = new Map<string, { name: string; runs: number; passes: number; fails: number }>();
    for (const report of this.reports) {
      for (const r of report.results) {
        let entry = byId.get(r.scenarioId);
        if (!entry) {
          entry = { name: r.name, runs: 0, passes: 0, fails: 0 };
          byId.set(r.scenarioId, entry);
        }
        entry.runs += 1;
        if (r.passed) entry.passes += 1;
        else entry.fails += 1;
      }
    }
    return [...byId.entries()]
      .filter(([, e]) => e.runs >= minRuns && e.passes > 0 && e.fails > 0)
      .map(([scenarioId, e]) => ({
        scenarioId,
        name: e.name,
        runs: e.runs,
        passes: e.passes,
        fails: e.fails,
        passRate: e.passes / e.runs,
      }))
      .sort((a, b) => a.passRate - b.passRate);
  }

  /**
   * Scenario tệ nhất theo pass rate (kể cả scenario luôn fail):
   * trả về tối đa `limit` scenario có pass rate thấp nhất, để host
   * ưu tiên sửa. Scenario chưa từng pass (0%) đứng đầu.
   */
  worstScenarios(limit = 5): V15VerifyFlaky[] {
    const byId = new Map<string, { name: string; runs: number; passes: number; fails: number }>();
    for (const report of this.reports) {
      for (const r of report.results) {
        let entry = byId.get(r.scenarioId);
        if (!entry) {
          entry = { name: r.name, runs: 0, passes: 0, fails: 0 };
          byId.set(r.scenarioId, entry);
        }
        entry.runs += 1;
        if (r.passed) entry.passes += 1;
        else entry.fails += 1;
      }
    }
    return [...byId.entries()]
      .map(([scenarioId, e]) => ({
        scenarioId,
        name: e.name,
        runs: e.runs,
        passes: e.passes,
        fails: e.fails,
        passRate: e.runs > 0 ? e.passes / e.runs : 0,
      }))
      .sort((a, b) => a.passRate - b.passRate || b.runs - a.runs)
      .slice(0, Math.max(1, limit));
  }

  /** Trend pass rate qua các lần chạy (cũ nhất trước). */
  trend(): V15VerifyTrendPoint[] {
    return this.reports.map((r) => ({
      runId: r.runId,
      createdAt: r.createdAt,
      total: r.total,
      passed: r.passed,
      passRate: r.total > 0 ? r.passed / r.total : 0,
    }));
  }

  /** Render trend thành text (một dòng mỗi lần chạy). */
  renderTrend(): string {
    const points = this.trend();
    if (points.length === 0) return 'No verify history yet.';
    return points
      .map((p) => `${p.runId}: ${p.passed}/${p.total} (${(p.passRate * 100).toFixed(0)}%) — ${p.createdAt}`)
      .join('\n');
  }
}
