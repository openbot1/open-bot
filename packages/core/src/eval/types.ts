/**
 * Eval benchmark types + runner chung (v1.06, Đội T6).
 *
 * Một "eval suite" là một danh sách case, mỗi case trả về pass/fail
 * kèm chi tiết — không có điểm số mơ hồ, không có "gần đúng". Runner
 * chạy từng case, bắt mọi exception thành fail (case lỗi cũng là
 * kết quả, không crash cả suite), đo thời gian từng case, và xuất
 * báo cáo JSON lưu đĩa (`eval-reports/`) để CLI/tool/UI đọc lại.
 *
 * Hai suite đầu tiên:
 * - `memory` (xem `memoryEval.ts`): recall đúng fact sau N lượt,
 *   tier promotion đúng, block edit không làm mất fact — chạy trên
 *   `LongTermMemory` + `MemoryBlockStore` thật, trong thư mục tạm.
 * - `mcp-conformance` (xem `mcpConformanceEval.ts`): stateless
 *   request đúng format, discover, elicitation form/URL, Tasks
 *   poll/cancel, fallback handshake server cũ — chạy trên các hàm
 *   pure của `mcp/*` + một fake transport trong bộ nhớ, không cần
 *   server MCP thật, không gọi mạng.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Tên suite eval. */
export type EvalSuiteName = 'memory' | 'mcp-conformance';

export const EVAL_SUITE_NAMES: readonly EvalSuiteName[] = ['memory', 'mcp-conformance'];

/** Kết quả một case eval. */
export interface EvalCaseResult {
  /** Id ổn định của case, vd `memory.recall-after-20-turns`. */
  id: string;
  /** Tên hiển thị ngắn. */
  name: string;
  passed: boolean;
  /** Chi tiết: cái gì đã kiểm tra, giá trị thực tế là gì. */
  detail: string;
  /** Thời gian chạy case (ms). */
  durationMs: number;
  /** Thông điệp lỗi khi fail (nếu có). */
  error?: string;
}

/** Kết quả một suite eval. */
export interface EvalSuiteResult {
  suite: EvalSuiteName;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  cases: EvalCaseResult[];
  passed: number;
  failed: number;
}

/** Báo cáo eval đầy đủ (một hoặc nhiều suite). */
export interface EvalReport {
  /** Id ổn định: `eval-<uuid>`. */
  id: string;
  /** Suite đã chạy trong báo cáo này. */
  suites: EvalSuiteName[];
  results: EvalSuiteResult[];
  passed: number;
  failed: number;
  createdAt: number;
  durationMs: number;
}

/** Thư mục lưu báo cáo eval trong một thư mục dữ liệu. */
export const EVAL_REPORTS_DIR = 'eval-reports';

export function getEvalReportsDir(baseDir: string): string {
  return path.join(baseDir, EVAL_REPORTS_DIR);
}

/** Kiểu của một case eval: hàm async trả về { passed, detail }. */
export type EvalCaseFn = () => Promise<{ passed: boolean; detail: string }>;

/**
 * Chạy một case: đo thời gian, bắt exception thành fail. Không bao
 * giờ throw — suite luôn chạy hết các case còn lại.
 */
export async function runEvalCase(
  id: string,
  name: string,
  fn: EvalCaseFn,
): Promise<EvalCaseResult> {
  const started = Date.now();
  try {
    const outcome = await fn();
    return {
      id,
      name,
      passed: outcome.passed,
      detail: outcome.detail,
      durationMs: Date.now() - started,
      ...(outcome.passed ? {} : { error: outcome.detail }),
    };
  } catch (err) {
    return {
      id,
      name,
      passed: false,
      detail: `case threw: ${(err as Error).message}`,
      durationMs: Date.now() - started,
      error: (err as Error).message,
    };
  }
}

/** Gộp các case đã chạy thành kết quả suite. */
export function buildEvalSuiteResult(
  suite: EvalSuiteName,
  startedAt: number,
  cases: EvalCaseResult[],
): EvalSuiteResult {
  const finishedAt = Date.now();
  return {
    suite,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    cases,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
  };
}

/** Gộp các suite thành một báo cáo. */
export function buildEvalReport(results: EvalSuiteResult[]): EvalReport {
  const createdAt = Date.now();
  const durationMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  return {
    id: `eval-${randomId()}`,
    suites: results.map((r) => r.suite),
    results,
    passed: results.reduce((sum, r) => sum + r.passed, 0),
    failed: results.reduce((sum, r) => sum + r.failed, 0),
    createdAt,
    durationMs,
  };
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Lưu báo cáo eval (atomic: tmp + rename, mode 0600). */
export function saveEvalReport(baseDir: string, report: EvalReport): string {
  const dir = getEvalReportsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${report.id}.json`);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Filesystem không hỗ trợ chmod — bỏ qua.
  }
  return filePath;
}

/** Đọc một báo cáo eval theo id (không có → null). */
export function loadEvalReport(baseDir: string, reportId: string): EvalReport | null {
  const filePath = path.join(getEvalReportsDir(baseDir), `${reportId}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as EvalReport;
}

/** Liệt kê báo cáo eval đã lưu (mới nhất trước). */
export function listEvalReports(baseDir: string): Array<{ id: string; createdAt: number; passed: number; failed: number; suites: EvalSuiteName[] }> {
  const dir = getEvalReportsDir(baseDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ id: string; createdAt: number; passed: number; failed: number; suites: EvalSuiteName[] }> = [];
  for (const file of files) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as EvalReport;
      out.push({ id: report.id, createdAt: report.createdAt, passed: report.passed, failed: report.failed, suites: report.suites });
    } catch {
      // Báo cáo hỏng — bỏ qua, không fail cả danh sách.
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Format báo cáo thành text đọc được (để CLI/tool in ra). */
export function formatEvalReportText(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Eval report ${report.id} — ${report.passed} passed, ${report.failed} failed (${report.durationMs}ms)`);
  for (const suite of report.results) {
    lines.push(`\n[${suite.suite}] ${suite.passed} passed, ${suite.failed} failed (${suite.durationMs}ms)`);
    for (const c of suite.cases) {
      lines.push(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.id} — ${c.detail} (${c.durationMs}ms)`);
    }
  }
  return `${lines.join('\n')}\n`;
}
