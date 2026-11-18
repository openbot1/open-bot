/**
 * Unified diff cho coding agent v9 (v1.17, Đội T4).
 *
 * Tự viết từ đầu (không dùng dependency diff ngoài): so sánh theo
 * dòng bằng LCS (dynamic programming, có giới hạn kích thước để
 * tránh nổ bộ nhớ trên file lớn), nhóm thành hunk có context, render
 * theo định dạng unified diff (`--- a/<path>`, `+++ b/<path>`,
 * `@@ -a,b +c,d @@`). Dùng cho:
 * - preview edit AST-aware (cho user xem trước khi approve),
 * - đếm dòng đổi để kiểm tra "diff tối thiểu" sau edit,
 * - commit message tự sinh + draft-PR description (thống kê file).
 *
 * Giới hạn trung thực: LCS O(n*m) nên chỉ dùng cho vùng edit và
 * file vừa (mặc định tối đa 2000 dòng mỗi phía; vượt quá thì fallback
 * sang diff "toàn bộ file cũ → toàn bộ file mới" dưới dạng một hunk
 * duy nhất, vẫn đúng nhưng không tối thiểu).
 */

import type { V9DiffHunk, V9UnifiedDiff } from './types';

/** Số dòng context mỗi bên của hunk (chuẩn unified diff). */
export const V9_DIFF_CONTEXT_LINES = 3;
/** Số dòng tối đa mỗi phía cho LCS chính xác. */
export const V9_DIFF_LCS_LINE_LIMIT = 2000;
/** Số hunk tối đa giữ lại (tránh diff khổng lồ). */
export const V9_DIFF_MAX_HUNKS = 100;

/** Một dòng trong bảng so sánh LCS. */
export type DiffOp =
  | { type: 'same'; oldLine: string }
  | { type: 'add'; newLine: string }
  | { type: 'del'; oldLine: string };

/**
 * So sánh hai mảng dòng bằng LCS. Trả về danh sách op theo thứ tự.
 * Dùng DP đầy đủ khi cả hai phía đều nhỏ; khi quá lớn, dùng thuật
 * toán tham lam theo prefix/suffix chung (vẫn đúng, ít tối ưu hơn).
 */
export function v9DiffLineOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const commonPrefix = v9CommonPrefix(oldLines, newLines);
  const commonSuffix = v9CommonSuffix(
    oldLines.slice(commonPrefix),
    newLines.slice(commonPrefix),
  );
  const oldMid = oldLines.slice(commonPrefix, oldLines.length - commonSuffix);
  const newMid = newLines.slice(commonPrefix, newLines.length - commonSuffix);
  const ops: DiffOp[] = [];
  for (let i = 0; i < commonPrefix; i += 1) {
    ops.push({ type: 'same', oldLine: oldLines[i] as string });
  }
  ops.push(...v9DiffMiddle(oldMid, newMid));
  for (let i = 0; i < commonSuffix; i += 1) {
    const line = oldLines[oldLines.length - commonSuffix + i] as string;
    ops.push({ type: 'same', oldLine: line });
  }
  return ops;
}

function v9CommonPrefix(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function v9CommonSuffix(a: string[], b: string[]): number {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i += 1;
  }
  return i;
}

function v9DiffMiddle(oldMid: string[], newMid: string[]): DiffOp[] {
  if (oldMid.length === 0) return newMid.map((newLine): DiffOp => ({ type: 'add', newLine }));
  if (newMid.length === 0) return oldMid.map((oldLine): DiffOp => ({ type: 'del', oldLine }));
  if (
    oldMid.length > V9_DIFF_LCS_LINE_LIMIT ||
    newMid.length > V9_DIFF_LCS_LINE_LIMIT
  ) {
    // Fallback tham lam: xoá toàn bộ cũ rồi thêm toàn bộ mới.
    return [
      ...oldMid.map((oldLine): DiffOp => ({ type: 'del', oldLine })),
      ...newMid.map((newLine): DiffOp => ({ type: 'add', newLine })),
    ];
  }
  // DP LCS: dp[i][j] = độ dài LCS của oldMid[i..] và newMid[j..].
  const n = oldMid.length;
  const m = newMid.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        oldMid[i] === newMid[j]
          ? (dp[i + 1]![j + 1] as number) + 1
          : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      ops.push({ type: 'same', oldLine: oldMid[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      ops.push({ type: 'del', oldLine: oldMid[i] as string });
      i += 1;
    } else {
      ops.push({ type: 'add', newLine: newMid[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', oldLine: oldMid[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', newLine: newMid[j] as string });
    j += 1;
  }
  return ops;
}

/**
 * Nhóm các op thành hunk (mỗi hunk bao quanh vùng đổi bằng context).
 * Hunk kề nhau (khoảng cách <= 2 * context) được gộp lại.
 */
export function v9GroupHunks(ops: DiffOp[], contextLines = V9_DIFF_CONTEXT_LINES): V9DiffHunk[] {
  const changeIdx: number[] = [];
  ops.forEach((op, idx) => {
    if (op.type !== 'same') changeIdx.push(idx);
  });
  if (changeIdx.length === 0) return [];
  const groups: number[][] = [];
  let current: number[] = [changeIdx[0] as number];
  for (let k = 1; k < changeIdx.length; k += 1) {
    const prev = changeIdx[k - 1] as number;
    const cur = changeIdx[k] as number;
    if (cur - prev <= 2 * contextLines) {
      current.push(cur);
    } else {
      groups.push(current);
      current = [cur];
    }
  }
  groups.push(current);

  const hunks: V9DiffHunk[] = [];
  for (const group of groups.slice(0, V9_DIFF_MAX_HUNKS)) {
    const first = group[0] as number;
    const last = group[group.length - 1] as number;
    const start = Math.max(0, first - contextLines);
    const end = Math.min(ops.length - 1, last + contextLines);
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    const lines: string[] = [];
    // Đếm số dòng cũ/mới trước hunk để tính vị trí bắt đầu (1-based).
    for (let idx = 0; idx < start; idx += 1) {
      const op = ops[idx] as DiffOp;
      if (op.type === 'same' || op.type === 'del') oldCount += 1;
      if (op.type === 'same' || op.type === 'add') newCount += 1;
    }
    oldStart = oldCount + 1;
    newStart = newCount + 1;
    let hunkOld = 0;
    let hunkNew = 0;
    for (let idx = start; idx <= end; idx += 1) {
      const op = ops[idx] as DiffOp;
      if (op.type === 'same') {
        lines.push(` ${op.oldLine}`);
        hunkOld += 1;
        hunkNew += 1;
      } else if (op.type === 'add') {
        lines.push(`+${op.newLine}`);
        hunkNew += 1;
      } else {
        lines.push(`-${op.oldLine}`);
        hunkOld += 1;
      }
    }
    hunks.push({
      oldStart,
      oldLines: hunkOld,
      newStart,
      newLines: hunkNew,
      lines,
    });
  }
  return hunks;
}

/** Render một hunk thành text unified diff (header @@ + dòng). */
export function v9RenderHunk(hunk: V9DiffHunk): string {
  const oldRange = hunk.oldLines === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldLines}`;
  const newRange = hunk.newLines === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newLines}`;
  return [`@@ -${oldRange} +${newRange} @@`, ...hunk.lines].join('\n');
}

/**
 * Tạo unified diff giữa hai nội dung text (tách theo dòng).
 * `relPath` dùng cho header ---/+++ (dạng `a/<path>` / `b/<path>`).
 */
export function v9UnifiedDiff(oldContent: string, newContent: string, relPath: string): V9UnifiedDiff {
  const oldLines = v9SplitLines(oldContent);
  const newLines = v9SplitLines(newContent);
  const ops = v9DiffLineOps(oldLines, newLines);
  const hunks = v9GroupHunks(ops);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const op of ops) {
    if (op.type === 'add') linesAdded += 1;
    if (op.type === 'del') linesRemoved += 1;
  }
  if (hunks.length === 0) {
    return { text: '', hunks: [], linesAdded: 0, linesRemoved: 0 };
  }
  const body = hunks.map((h) => v9RenderHunk(h)).join('\n');
  const text = `--- a/${relPath}\n+++ b/${relPath}\n${body}\n`;
  return { text, hunks, linesAdded, linesRemoved };
}

/** Tách nội dung thành dòng (không giữ `\n`; dòng cuối rỗng do `\n` cuối bị bỏ). */
export function v9SplitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Nối các dòng lại thành nội dung (thêm `\n` cuối khi có dòng). */
export function v9JoinLines(lines: string[]): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}

/** Đếm dòng đổi giữa hai nội dung (không cần render diff đầy đủ). */
export function v9CountLineChanges(oldContent: string, newContent: string): {
  added: number;
  removed: number;
} {
  const diff = v9UnifiedDiff(oldContent, newContent, 'file');
  return { added: diff.linesAdded, removed: diff.linesRemoved };
}

/**
 * Kiểm tra "diff tối thiểu": tổng dòng đổi có vượt ngưỡng không.
 * Trả về chuỗi lý do khi vượt, null khi đạt.
 */
export function v9CheckMinimalDiff(
  added: number,
  removed: number,
  maxChangedLines: number,
): string | null {
  const total = added + removed;
  if (total > maxChangedLines) {
    return (
      `Edit changed ${total} lines (added ${added}, removed ${removed}), ` +
      `over the minimal-diff limit of ${maxChangedLines}.`
    );
  }
  return null;
}

/** Tóm tắt một diff thành một dòng (dùng cho commit message / log). */
export function v9SummarizeDiff(diff: V9UnifiedDiff, relPath: string): string {
  if (diff.hunks.length === 0) return `${relPath}: no changes`;
  return `${relPath}: +${diff.linesAdded} -${diff.linesRemoved} (${diff.hunks.length} hunk${diff.hunks.length > 1 ? 's' : ''})`;
}

/**
 * Kiểm tra deny-list cho một lệnh shell (argv đã tách).
 * CodeAct v9 chạy lệnh trực tiếp (không qua shell) nên mọi ký tự nối
 * lệnh / chuyển hướng / thay thế đều bị chặn; lệnh phá hoại cũng vậy.
 * Trả về chuỗi lý do khi bị chặn, null khi cho phép.
 * (v1.19 thêm — CodeAct v9 của codingV11 import hàm này.)
 */
export function v9CheckDenyList(argv: readonly string[]): string | null {
  if (argv.length === 0) return 'empty command';
  const joined = argv.join(' ');
  const meta = /[;&|><`$\\]/.exec(joined);
  if (meta) return `lệnh chứa ký tự shell bị cấm "${meta[0]}" — CodeAct chỉ chạy argv trực tiếp, không qua shell.`;
  if (/\$\(/.test(joined)) return 'lệnh chứa thay thế lệnh "$()" — bị cấm.';
  const first = argv[0] as string;
  const base = first.split('/').pop() as string;
  if (base === 'rm' && argv.some((a) => a === '-rf' || a === '--recursive')) {
    const target = argv[argv.length - 1] as string;
    if (target === '/' || target === '/*' || target === '~' || target === '.') {
      return `lệnh "rm -rf ${target}" quá nguy hiểm — bị cấm.`;
    }
  }
  if (base === 'sudo' || base === 'su') return `lệnh "${base}" cần quyền cao — bị cấm.`;
  return null;
}
