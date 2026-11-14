/**
 * Eval trends — xu hướng báo cáo eval theo thời gian (v1.06, Đội T6).
 *
 * Một báo cáo eval chỉ nói "lần này pass/fail". Module này đọc NHIỀU
 * báo cáo đã lưu (`eval-reports/`) và trả lời:
 *
 * - suite nào đang xấu đi (pass rate giảm qua các lần chạy);
 * - case nào flaky (lúc pass lúc fail qua các lần chạy — dấu hiệu
 *   của test không ổn định, không phải của code);
 * - case nào fail liên tục (hỏng thật, cần sửa ngay);
 * - lần chạy gần nhất của từng case là khi nào.
 *
 * Chỉ đọc file báo cáo — không chạy lại eval, không ghi gì. Báo cáo
 * hỏng (JSON lỗi) thì bỏ qua, không fail cả trend.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getEvalReportsDir, type EvalReport, type EvalSuiteName } from './types';

/** Lịch sử pass/fail của một case qua các lần chạy. */
export interface EvalCaseTrend {
  id: string;
  suite: EvalSuiteName;
  runs: number;
  passes: number;
  fails: number;
  /** Pass rate 0..1 (null khi chưa chạy lần nào — không xảy ra ở đây). */
  passRate: number | null;
  /** True khi case lúc pass lúc fail (flaky — cần xem lại test). */
  flaky: boolean;
  /** True khi fail ở TẤT CẢ các lần chạy gần đây (hỏng thật). */
  alwaysFailing: boolean;
  /** Epoch ms lần chạy gần nhất. */
  lastRunAt: number;
  /** Kết quả lần chạy gần nhất. */
  lastPassed: boolean;
}

/** Xu hướng của một suite qua các lần chạy. */
export interface EvalSuiteTrend {
  suite: EvalSuiteName;
  reports: number;
  /** Pass rate trung bình qua các báo cáo (0..1). */
  avgPassRate: number | null;
  /** Pass rate báo cáo mới nhất (0..1). */
  latestPassRate: number | null;
  /** 'improving' | 'stable' | 'worsening' theo 2 nửa gần đây. */
  direction: 'improving' | 'stable' | 'worsening';
  cases: EvalCaseTrend[];
}

/** Xu hướng toàn bộ eval. */
export interface EvalTrends {
  at: number;
  reports: number;
  /** Khoảng thời gian bao phủ (epoch ms) — null khi chưa có báo cáo. */
  range: { from: number; to: number } | null;
  suites: EvalSuiteTrend[];
  flakyCases: EvalCaseTrend[];
  alwaysFailingCases: EvalCaseTrend[];
}

/** Đọc tất cả báo cáo eval đã lưu (mới nhất trước; báo cáo hỏng thì bỏ qua). */
export function loadEvalReportHistory(baseDir: string): EvalReport[] {
  const dir = getEvalReportsDir(baseDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const reports: EvalReport[] = [];
  for (const file of files) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as EvalReport;
      if (typeof report.id !== 'string' || !Array.isArray(report.results)) continue;
      reports.push(report);
    } catch {
      // Báo cáo hỏng — bỏ qua.
    }
  }
  return reports.sort((a, b) => b.createdAt - a.createdAt);
}

/** Tính trend của một case từ danh sách kết quả (mới nhất trước). */
export function caseTrendFromResults(
  id: string,
  suite: EvalSuiteName,
  results: Array<{ passed: boolean; at: number }>,
): EvalCaseTrend {
  const runs = results.length;
  const passes = results.filter((r) => r.passed).length;
  const fails = runs - passes;
  const latest = results[0];
  return {
    id,
    suite,
    runs,
    passes,
    fails,
    passRate: runs === 0 ? null : passes / runs,
    flaky: passes > 0 && fails > 0,
    alwaysFailing: runs > 0 && fails === runs,
    lastRunAt: latest?.at ?? 0,
    lastPassed: latest?.passed ?? false,
  };
}

/**
 * Tính xu hướng eval từ lịch sử báo cáo. `limit` giới hạn số báo cáo
 * mới nhất được xét (mặc định 20 — đủ để thấy trend mà không đọc
 * cả trăm file cũ).
 */
export function buildEvalTrends(
  reports: EvalReport[],
  limit = 20,
  at = Date.now(),
): EvalTrends {
  const recent = [...reports].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  const trends: EvalTrends = {
    at,
    reports: recent.length,
    range: recent.length === 0
      ? null
      : { from: recent[recent.length - 1].createdAt, to: recent[0].createdAt },
    suites: [],
    flakyCases: [],
    alwaysFailingCases: [],
  };
  if (recent.length === 0) return trends;
  const suitesSeen: EvalSuiteName[] = [...new Set(recent.flatMap((r) => r.suites))];
  for (const suite of suitesSeen) {
    const suiteReports = recent.filter((r) => r.suites.includes(suite));
    const rates = suiteReports.map((r) => {
      const s = r.results.find((x) => x.suite === suite);
      if (!s || s.cases.length === 0) return null;
      return s.passed / s.cases.length;
    }).filter((x): x is number => x !== null);
    const avgPassRate = rates.length === 0 ? null : rates.reduce((a, b) => a + b, 0) / rates.length;
    const latestPassRate = rates.length === 0 ? null : rates[0];
    // Hướng trend: so pass rate trung bình nửa mới vs nửa cũ.
    const half = Math.max(1, Math.floor(rates.length / 2));
    const newer = rates.slice(0, half);
    const older = rates.slice(half);
    const newerAvg = newer.length === 0 ? null : newer.reduce((a, b) => a + b, 0) / newer.length;
    const olderAvg = older.length === 0 ? null : older.reduce((a, b) => a + b, 0) / older.length;
    let direction: EvalSuiteTrend['direction'] = 'stable';
    if (newerAvg !== null && olderAvg !== null) {
      if (newerAvg - olderAvg > 0.05) direction = 'improving';
      else if (olderAvg - newerAvg > 0.05) direction = 'worsening';
    }
    const caseMap = new Map<string, Array<{ passed: boolean; at: number }>>();
    for (const report of suiteReports) {
      const s = report.results.find((x) => x.suite === suite);
      if (!s) continue;
      for (const c of s.cases) {
        const list = caseMap.get(c.id) ?? [];
        list.push({ passed: c.passed, at: report.createdAt });
        caseMap.set(c.id, list);
      }
    }
    const cases = [...caseMap.entries()]
      .map(([id, results]) => caseTrendFromResults(id, suite, results))
      .sort((a, b) => a.id.localeCompare(b.id));
    trends.suites.push({ suite, reports: suiteReports.length, avgPassRate, latestPassRate, direction, cases });
    for (const c of cases) {
      if (c.flaky) trends.flakyCases.push(c);
      if (c.alwaysFailing) trends.alwaysFailingCases.push(c);
    }
  }
  return trends;
}

/** Format trend thành text đọc được (để CLI/tool in ra). */
export function formatEvalTrendsText(trends: EvalTrends): string {
  const lines: string[] = [];
  if (trends.reports === 0) return 'No eval reports yet — run an eval first.\n';
  lines.push(`Eval trends over ${trends.reports} report(s)`);
  for (const suite of trends.suites) {
    const avg = suite.avgPassRate === null ? 'n/a' : `${Math.round(suite.avgPassRate * 100)}%`;
    const latest = suite.latestPassRate === null ? 'n/a' : `${Math.round(suite.latestPassRate * 100)}%`;
    lines.push(`\n[${suite.suite}] ${suite.reports} run(s), avg pass ${avg}, latest ${latest}, ${suite.direction}`);
    for (const c of suite.cases) {
      const flag = c.alwaysFailing ? 'ALWAYS-FAILING' : c.flaky ? 'FLAKY' : 'stable';
      lines.push(`  ${flag}  ${c.id} — ${c.passes}/${c.runs} passed`);
    }
  }
  return `${lines.join('\n')}\n`;
}
