/**
 * Coding agent v15 — run report (báo cáo tổng hợp một run).
 *
 * Một run v15 chạm 4 lớp (profile, budget, hooks dialog, verify) —
 * mỗi lớp có report riêng, nhưng người đọc cần MỘT báo cáo duy nhất
 * để trả lời "run này chạy profile nào, tốn bao nhiêu, hook nói gì,
 * kiểm chứng ra sao". `buildV15RunReport()` gom 4 report thành một
 * object + render markdown; `renderV15RunReportMarkdown()` cho host
 * lưu file / gửi chat / đưa lên UI.
 *
 * Ngoài ra: export/import lịch sử budget ra JSON (để host lưu trữ
 * lâu dài / chuyển máy) — format `{ version: 1, exportedAt,
 * records: V15UsageRecord[] }`, import validate từng record và bỏ
 * qua record hỏng thay vì fail cả file.
 */

import { CodingV15BudgetMeter, renderV15BudgetReport, v15FormatUsd } from './budget';
import { renderV15VerifyReport } from './verifyScenarios';
import { renderV15ProfileSummary } from './profiles';
import { CodingV15Error } from './types';
import type {
  V15AgentRunResult,
  V15BudgetHistoryEntry,
  V15BudgetReport,
  V15HooksDialogState,
  V15ProfileApplyResult,
  V15UsageRecord,
  V15VerifyReport,
} from './types';

/** Báo cáo tổng hợp của một run v15. */
export interface V15RunReport {
  runId: string;
  botId: string;
  profileId: string;
  profileSummary: string;
  prompt: string;
  stepsExecuted: number;
  done: boolean;
  stoppedByMaxSteps: boolean;
  filesWritten: string[];
  toolErrors: string[];
  budget: V15BudgetReport;
  hooksDialog: V15HooksDialogState;
  verify: V15VerifyReport | null;
  /** Tóm tắt một dòng. */
  summary: string;
  createdAt: string;
}

export interface V15RunReportInput {
  result: V15AgentRunResult;
  applied: V15ProfileApplyResult;
}

/** Gom kết quả agent + profile đã áp thành báo cáo tổng hợp. */
export function buildV15RunReport(input: V15RunReportInput, now?: string): V15RunReport {
  const { result, applied } = input;
  if (!result || typeof result !== 'object') {
    throw new CodingV15Error('agent-run-invalid', 'Run report cần agent result.');
  }
  if (!applied || typeof applied !== 'object') {
    throw new CodingV15Error('profile-apply-invalid', 'Run report cần profile apply result.');
  }
  const budgetPart = `${result.budget.state.totalTokens.toLocaleString('en-US')} tokens, ${v15FormatUsd(result.budget.state.costUsd)}${result.budget.state.overCap ? ' (OVER CAP — report-only)' : ''}`;
  const hooksPart = `${result.hooksDialog.pending} pending / ${result.hooksDialog.total} hook feedback`;
  const verifyPart = result.verify ? `verify ${result.verify.passed}/${result.verify.total}` : 'verify not run';
  return {
    runId: result.runId,
    botId: result.botId,
    profileId: result.profileId,
    profileSummary: renderV15ProfileSummary(applied.profile),
    prompt: result.prompt,
    stepsExecuted: result.stepsExecuted,
    done: result.done,
    stoppedByMaxSteps: result.stoppedByMaxSteps,
    filesWritten: [...result.filesWritten],
    toolErrors: [...result.toolErrors],
    budget: result.budget,
    hooksDialog: {
      ...result.hooksDialog,
      pendingItems: result.hooksDialog.pendingItems.map((f) => ({ ...f })),
    },
    verify: result.verify ?? null,
    summary: `Run ${result.runId} (${applied.acpDisplayName}): ${result.stepsExecuted} steps, done=${result.done} — ${budgetPart}; ${hooksPart}; ${verifyPart}.`,
    createdAt: now ?? new Date().toISOString(),
  };
}

/** Render báo cáo tổng hợp thành markdown (lưu file / gửi chat). */
export function renderV15RunReportMarkdown(report: V15RunReport): string {
  const lines: string[] = [
    `# Coding agent v15 — run ${report.runId}`,
    ``,
    `- Profile: ${report.profileSummary}`,
    `- Prompt: ${report.prompt}`,
    `- Steps: ${report.stepsExecuted} (done=${report.done}, stoppedByMaxSteps=${report.stoppedByMaxSteps})`,
    `- Files written: ${report.filesWritten.length > 0 ? report.filesWritten.join(', ') : 'none'}`,
    `- Tool errors: ${report.toolErrors.length > 0 ? report.toolErrors.join(' | ') : 'none'}`,
    ``,
    `## Budget (report-only)`,
    ``,
    renderV15BudgetReport(report.budget).split('\n').map((l) => `  ${l}`).join('\n'),
    ``,
    `## Hooks dialog (feedback outside the chat)`,
    ``,
    `- Pending: ${report.hooksDialog.pending} / total ${report.hooksDialog.total} (confirmed ${report.hooksDialog.confirmed}, dismissed ${report.hooksDialog.dismissed}, snoozed ${report.hooksDialog.snoozed})`,
  ];
  for (const item of report.hooksDialog.pendingItems) {
    lines.push(`- [${item.severity}] ${item.title} — ${item.source}: ${item.body.slice(0, 200)}`);
  }
  lines.push(``);
  if (report.verify) {
    lines.push(`## Verify scenarios`);
    lines.push(``);
    lines.push(renderV15VerifyReport(report.verify).split('\n').map((l) => `  ${l}`).join('\n'));
  } else {
    lines.push(`## Verify scenarios`);
    lines.push(``);
    lines.push(`Not run for this run.`);
  }
  lines.push(``);
  lines.push(report.summary);
  return lines.join('\n');
}

/* ================================================================== */
/* Export / import lịch sử budget (JSON)                               */
/* ================================================================== */

/** Format file export lịch sử budget. */
export interface V15BudgetExportFile {
  version: 1;
  exportedAt: string;
  botId: string;
  records: V15UsageRecord[];
}

/** Validate một usage record thô (dùng khi import). */
export function v15IsValidUsageRecord(value: unknown): value is V15UsageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['runId'] === 'string' && (r['runId'] as string).length > 0 &&
    typeof r['botId'] === 'string' &&
    typeof r['model'] === 'string' && (r['model'] as string).length > 0 &&
    Number.isInteger(r['inputTokens']) && (r['inputTokens'] as number) >= 0 &&
    Number.isInteger(r['outputTokens']) && (r['outputTokens'] as number) >= 0 &&
    (r['costUsd'] === null || typeof r['costUsd'] === 'number') &&
    typeof r['at'] === 'string'
  );
}

/** Export toàn bộ record của meter thành object file (host tự ghi file). */
export function v15ExportBudgetHistory(
  meter: CodingV15BudgetMeter,
  runIds?: string[],
): V15BudgetExportFile {
  const ids = runIds ?? meter.history().map((h) => h.runId);
  const records: V15UsageRecord[] = [];
  for (const runId of ids) records.push(...meter.recordsForRun(runId));
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    botId: meter.getBotId(),
    records,
  };
}

/** Kết quả import: số record nạp được + số record hỏng bị bỏ qua. */
export interface V15BudgetImportResult {
  imported: number;
  skipped: number;
  history: V15BudgetHistoryEntry[];
}

/**
 * Import file export vào meter: record hợp lệ được nạp lại (giữ
 * nguyên runId/botId/model/token/cost/at), record hỏng bị bỏ qua
 * và đếm vào `skipped` thay vì fail cả file.
 */
export function v15ImportBudgetHistory(
  meter: CodingV15BudgetMeter,
  file: unknown,
): V15BudgetImportResult {
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new CodingV15Error('budget-record-invalid', 'Budget export file phải là object.');
  }
  const f = file as Record<string, unknown>;
  if (f['version'] !== 1) {
    throw new CodingV15Error('budget-record-invalid', 'Budget export file version phải là 1.');
  }
  if (!Array.isArray(f['records'])) {
    throw new CodingV15Error('budget-record-invalid', 'Budget export file cần mảng records.');
  }
  let imported = 0;
  let skipped = 0;
  for (const entry of f['records'] as unknown[]) {
    if (!v15IsValidUsageRecord(entry)) {
      skipped += 1;
      continue;
    }
    meter.record({
      runId: entry.runId,
      botId: entry.botId,
      profileId: entry.profileId,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd,
      tokensEstimated: entry.tokensEstimated,
      step: entry.step,
      at: entry.at,
    });
    imported += 1;
  }
  return { imported, skipped, history: meter.history() };
}
