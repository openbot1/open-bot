/**
 * Delegation v2 — hợp nhất kết quả các con (v1.04, Đội T4).
 *
 * Ba chiến lược (xác định, không gọi LLM):
 * - `concat`: nối kết quả theo thứ tự con, mỗi con một mục có tiêu đề
 *   (tên + trạng thái + thời gian). Mặc định, giữ đầy đủ nhất.
 * - `summarize`: trích xuất gọn — mỗi con chỉ giữ dòng đầu (kết luận),
 *   verdict (nếu có), lỗi (nếu có), và số liệu (thời gian); output dài
 *   bị cắt ở 500 ký tự/con. Dùng khi cha chỉ cần nắm ý chính.
 * - `verdict`: gộp theo verdict có cấu trúc — verdict đa số, số con
 *   đồng ý, liệt kê xung đột (con nào verdict khác). Con không có
 *   verdict thì rơi vào nhóm `no-verdict` (không bịa verdict).
 *
 * Xung đột verdict được phát hiện bằng so sánh chuỗi verdict (sau khi
 * trim + lowercase): verdict khác nhau → conflicts liệt kê tên con.
 * Đây là phát hiện xung đột "chắc chắn" theo nghĩa đen của chuỗi —
 * không suy diễn ngữ nghĩa (xem thêm `agent/subagent.ts`: gộp v1 cũng
 * dùng verdict có cấu trúc thay vì so khớp text).
 */

import { estimateTokens } from '../agent/tokens';
import type {
  DelegationChildResult,
  DelegationMergeReport,
  DelegationMergeStrategy,
} from './types';

/** Số ký tự tối đa giữ lại cho mỗi con ở chiến lược summarize. */
export const DELEGATION_SUMMARIZE_CHARS_PER_CHILD = 500;

/** Kết quả hợp nhất: output + báo cáo. */
export interface DelegationMergeResult {
  merged: string;
  report: DelegationMergeReport;
}

/** Chuẩn hoá verdict để so sánh (trim + lowercase, rỗng = không verdict). */
export function normalizeVerdict(verdict: string | undefined): string | undefined {
  if (verdict === undefined) return undefined;
  const v = verdict.trim().toLowerCase();
  return v === '' ? undefined : v;
}

/**
 * Phát hiện xung đột verdict: trả tên các con có verdict khác với
 * verdict đa số (con không có verdict không tính là xung đột — nó chỉ
 * là "không kết luận").
 */
export function detectVerdictConflicts(results: readonly DelegationChildResult[]): string[] {
  const counts = new Map<string, { verdict: string; names: string[] }>();
  for (const r of results) {
    const v = normalizeVerdict(r.verdict);
    if (v === undefined) continue;
    const entry = counts.get(v) ?? { verdict: r.verdict!.trim(), names: [] };
    entry.names.push(r.name);
    counts.set(v, entry);
  }
  if (counts.size <= 1) return [];
  // Verdict đa số = nhóm đông nhất (hoà thì nhóm đầu tiên theo thứ tự con).
  let majority = '';
  let majorityCount = -1;
  for (const [v, entry] of counts) {
    if (entry.names.length > majorityCount) {
      majority = v;
      majorityCount = entry.names.length;
    }
  }
  const conflicts: string[] = [];
  for (const [v, entry] of counts) {
    if (v !== majority) conflicts.push(...entry.names);
  }
  return conflicts;
}

/** Verdict đa số (chuỗi gốc của nhóm đông nhất), undefined khi không có verdict nào. */
export function majorityVerdict(results: readonly DelegationChildResult[]): string | undefined {
  const counts = new Map<string, { verdict: string; names: string[]; firstIdx: number }>();
  results.forEach((r, idx) => {
    const v = normalizeVerdict(r.verdict);
    if (v === undefined) return;
    const entry = counts.get(v) ?? { verdict: r.verdict!.trim(), names: [], firstIdx: idx };
    entry.names.push(r.name);
    counts.set(v, entry);
  });
  let best: { verdict: string; names: string[]; firstIdx: number } | undefined;
  for (const entry of counts.values()) {
    if (
      best === undefined ||
      entry.names.length > best.names.length ||
      (entry.names.length === best.names.length && entry.firstIdx < best.firstIdx)
    ) {
      best = entry;
    }
  }
  return best?.verdict;
}

/** Dòng đầu không rỗng của output (kết luận của con). */
function firstLine(output: string): string {
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return '';
}

/** Cắt output ở N ký tự (giữ nguyên khi ngắn hơn). */
function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Tiêu đề mục của một con khi gộp (tên + trạng thái + thời gian). */
function childHeading(result: DelegationChildResult): string {
  const status =
    result.status === 'done'
      ? 'done'
      : result.status === 'timeout'
        ? `timeout (${result.durationMs}ms)`
        : `error (${result.durationMs}ms)`;
  return `### ${result.name} (${status})`;
}

/**
 * Hợp nhất kết quả các con theo chiến lược. Trả output đã hợp nhất +
 * báo cáo (số con xong/lỗi, xung đột verdict, ước lượng token).
 * Kết quả rỗng → merged là chuỗi rỗng, report đếm 0.
 */
export function mergeDelegationResults(
  results: readonly DelegationChildResult[],
  strategy: DelegationMergeStrategy = 'concat',
): DelegationMergeResult {
  const succeeded = results.filter((r) => r.status === 'done').length;
  const failed = results.length - succeeded;
  const conflicts = detectVerdictConflicts(results);
  let merged: string;
  let majority: string | undefined;

  switch (strategy) {
    case 'concat': {
      merged = results
        .map((r) => {
          const body = r.status === 'done' ? r.output : (r.error ?? r.output);
          return `${childHeading(r)}\n${body}`;
        })
        .join('\n\n');
      break;
    }
    case 'summarize': {
      const lines = results.map((r) => {
        const parts = [childHeading(r)];
        const verdict = normalizeVerdict(r.verdict);
        if (verdict !== undefined) parts.push(`Verdict: ${r.verdict!.trim()}`);
        if (r.status !== 'done' && r.error !== undefined) parts.push(`Lỗi: ${r.error}`);
        const head = firstLine(r.output);
        if (head !== '') parts.push(clip(head, DELEGATION_SUMMARIZE_CHARS_PER_CHILD));
        if (r.output.length > DELEGATION_SUMMARIZE_CHARS_PER_CHILD) {
          parts.push(`(output đầy đủ ${r.output.length} ký tự đã rút gọn)`);
        }
        return parts.join('\n');
      });
      merged = lines.join('\n\n');
      break;
    }
    case 'verdict': {
      majority = majorityVerdict(results);
      const agreeCount =
        majority === undefined
          ? 0
          : results.filter((r) => normalizeVerdict(r.verdict) === normalizeVerdict(majority)).length;
      const lines: string[] = [];
      if (majority !== undefined) {
        lines.push(`Verdict đa số: ${majority} (${agreeCount}/${results.length} con đồng ý)`);
      } else {
        lines.push('Không có con nào đưa verdict — gộp theo kết quả từng con.');
      }
      if (conflicts.length > 0) {
        lines.push(`Xung đột verdict: ${conflicts.join(', ')}`);
      }
      for (const r of results) {
        const verdict = normalizeVerdict(r.verdict);
        const verdictText = verdict !== undefined ? r.verdict!.trim() : 'no-verdict';
        const head = firstLine(r.output);
        lines.push(`- ${r.name}: ${verdictText}${head !== '' ? ` — ${clip(head, 200)}` : ''}`);
      }
      merged = lines.join('\n');
      break;
    }
    default:
      throw new Error(`Delegation: strategy không biết "${strategy as string}".`);
  }

  return {
    merged,
    report: {
      strategy,
      children: results.length,
      succeeded,
      failed,
      conflicts,
      ...(majority !== undefined ? { majorityVerdict: majority } : {}),
      mergedTokensEstimate: estimateTokens(merged),
    },
  };
}
