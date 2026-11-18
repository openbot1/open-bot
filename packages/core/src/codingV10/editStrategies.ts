/**
 * Coding agent v10 — edit strategies (mở rộng v9).
 *
 * v9 đã có: AST-aware edit (thay symbol theo vị trí AST) + fallback
 * search-replace block. v10 thêm:
 *
 * - Whole-file fallback: khi AST không tìm được symbol VÀ block
 *   search-replace không khớp (vd file viết lại gần hết), thay toàn
 *   bộ nội dung file — có verify parse lại + khôi phục nội dung cũ
 *   khi verify fail (không để file hỏng).
 * - Strategy selector: preview cả 3 chiến lược, chấm điểm (AST cao
 *   nhất vì diff tối thiểu, search-replace giữa, whole-file thấp
 *   nhất vì diff lớn), chọn điểm cao nhất; trả toàn bộ ứng viên để
 *   agent giải thích lựa chọn. Caller có thể ép một chiến lược —
 *   khi đó chỉ thử chiến lược đó, fallback sang chiến lược thấp
 *   hơn khi nó không áp được (ghi rõ `usedFallback`).
 * - Mỗi edit thành công có thể commit atomic ngay (git-first của
 *   Aider, dùng `commitV9Atomic` của v9) và ghi event vào session
 *   v10 qua callback `onEvent` (để event log ghi lại toàn bộ lịch
 *   sử edit của phiên).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { v8ParseFile } from '../codingV8/parser';
import { applyV9AstEdit, previewV9AstEdit, v9FindBlock, v9ReadEditFile } from '../codingV9/astEdit';
import { v9JoinLines, v9SplitLines, v9UnifiedDiff } from '../codingV9/diffUtil';
import { commitV9Atomic } from '../codingV9/gitAtomic';
import type { V9EditOperation, V9EditResult } from '../codingV9/types';
import { CodingV10Error } from './types';
import type { V10EditApplyResult, V10EditCandidate, V10EditStrategy } from './types';

/** Điểm cơ bản của từng chiến lược (AST > search-replace > whole-file). */
export const V10_STRATEGY_BASE_SCORES: Record<V10EditStrategy, number> = {
  ast: 100,
  'search-replace': 80,
  'whole-file': 40,
};
/** Trừ điểm mỗi dòng đổi (AST/search-replace ưu tiên diff nhỏ). */
export const V10_STRATEGY_LINE_PENALTY = 0.5;
/** Phần mở rộng file mà v10 verify được bằng parser v8. */
export const V10_VERIFIABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py']);

/** Yêu cầu edit v10: một operation v9 + nội dung whole-file (nếu có). */
export interface V10EditRequest {
  /** Operation v9 (AST / search-replace). */
  operation: V9EditOperation;
  /** Nội dung mới đầy đủ của file — bắt buộc cho whole-file fallback. */
  newContent?: string;
  /** Ép chiến lược cụ thể (không ép = selector tự chọn điểm cao nhất). */
  forceStrategy?: V10EditStrategy;
  /** Commit atomic sau khi edit thành công. */
  commit?: boolean;
  /** Tóm tắt dùng cho commit message (mặc định từ operation). */
  commitSummary?: string;
}

export interface V10EditStrategyOptions {
  /** Thư mục repo (root để resolve operation.path). */
  workingDir: string;
  /** Ngưỡng diff tối đa cho AST edit (dòng). Mặc định 200. */
  maxChangedLines?: number;
  /** Callback ghi event vào session v10 (edit-result). */
  onEvent?: (event: { type: string; payload: Record<string, unknown> }) => void;
}

/** Verify nội dung file bằng parser v8 (chỉ file có phần mở rộng hỗ trợ). */
export function v10VerifyContent(relPath: string, content: string): { ok: boolean; note: string } {
  const ext = path.posix.extname(relPath).toLowerCase();
  if (!V10_VERIFIABLE_EXTENSIONS.has(ext)) {
    return { ok: true, note: `Không verify parse (phần mở rộng ${ext || '(không có)'} ngoài parser v8).` };
  }
  const parsed = v8ParseFile(relPath, content);
  if (parsed.hasError) {
    return { ok: false, note: `Parse lỗi sau edit: ${parsed.parseErrors.slice(0, 3).join('; ')}` };
  }
  return { ok: true, note: `Parse lại ok (${parsed.symbols.length} symbols).` };
}

/** Preview các ứng viên chiến lược cho một edit (không ghi file). */
export function v10PlanEditCandidates(
  request: V10EditRequest,
  options: V10EditStrategyOptions,
): V10EditCandidate[] {
  const { operation } = request;
  const workingDir = options.workingDir;
  const candidates: V10EditCandidate[] = [];

  // 1. AST-aware (preview dry-run, không fallback — để đo riêng).
  try {
    const preview = previewV9AstEdit(operation, {
      workingDir,
      allowFallback: false,
      maxChangedLines: options.maxChangedLines,
    });
    const changed = preview.linesAdded + preview.linesRemoved;
    candidates.push({
      strategy: 'ast',
      score: Math.max(50, V10_STRATEGY_BASE_SCORES.ast - changed * V10_STRATEGY_LINE_PENALTY),
      reasons: preview.ok
        ? [`AST tìm được symbol ${preview.symbolName || operation.symbolName || ''} (${preview.startLine}-${preview.endLine})`]
        : ['AST preview không ok'],
      linesChanged: changed,
      applicable: preview.ok,
    });
  } catch (err) {
    candidates.push({
      strategy: 'ast',
      score: 0,
      reasons: [`AST không áp được: ${err instanceof Error ? err.message : String(err)}`],
      linesChanged: 0,
      applicable: false,
    });
  }

  // 2. Search-replace block (chỉ khi operation có oldBlock/newBlock).
  if (operation.oldBlock !== undefined && operation.newBlock !== undefined) {
    try {
      const oldContent = v9ReadEditFile(workingDir, operation.path);
      const lines = v9SplitLines(oldContent);
      const found = v9FindBlock(lines, operation.oldBlock, operation.contextBefore, operation.contextAfter);
      const changed = v9SplitLines(operation.newBlock).length + v9SplitLines(operation.oldBlock).length;
      candidates.push({
        strategy: 'search-replace',
        score: Math.max(30, V10_STRATEGY_BASE_SCORES['search-replace'] - changed * V10_STRATEGY_LINE_PENALTY),
        reasons: [`Tìm được block tại dòng ${found.startLine}-${found.endLine}`],
        linesChanged: Math.abs(v9SplitLines(operation.newBlock).length - v9SplitLines(operation.oldBlock).length),
        applicable: true,
      });
    } catch (err) {
      candidates.push({
        strategy: 'search-replace',
        score: 0,
        reasons: [`Search-replace không áp được: ${err instanceof Error ? err.message : String(err)}`],
        linesChanged: 0,
        applicable: false,
      });
    }
  } else {
    candidates.push({
      strategy: 'search-replace',
      score: 0,
      reasons: ['Không có oldBlock/newBlock nên không thử search-replace.'],
      linesChanged: 0,
      applicable: false,
    });
  }

  // 3. Whole-file fallback (chỉ khi caller cho newContent).
  if (request.newContent !== undefined) {
    const oldContent = (() => {
      try {
        return v9ReadEditFile(workingDir, operation.path);
      } catch {
        return '';
      }
    })();
    const diff = v9UnifiedDiff(oldContent, request.newContent, operation.path);
    const verify = v10VerifyContent(operation.path, request.newContent);
    candidates.push({
      strategy: 'whole-file',
      score: verify.ok
        ? Math.max(5, V10_STRATEGY_BASE_SCORES['whole-file'] - (diff.linesAdded + diff.linesRemoved) / 10)
        : 0,
      reasons: verify.ok
        ? [`Whole-file: thay ${diff.linesAdded + diff.linesRemoved} dòng, ${verify.note}`]
        : [`Whole-file verify fail: ${verify.note}`],
      linesChanged: diff.linesAdded + diff.linesRemoved,
      applicable: verify.ok,
    });
  } else {
    candidates.push({
      strategy: 'whole-file',
      score: 0,
      reasons: ['Không có newContent nên không thử whole-file.'],
      linesChanged: 0,
      applicable: false,
    });
  }

  return candidates;
}

/** Áp search-replace block trực tiếp (ghi file + verify parse). */
function applyV10SearchReplace(
  workingDir: string,
  operation: V9EditOperation,
): { result: V9EditResult; newContent: string; oldContent: string } {
  const oldContent = v9ReadEditFile(workingDir, operation.path);
  const lines = v9SplitLines(oldContent);
  const found = v9FindBlock(lines, operation.oldBlock as string, operation.contextBefore, operation.contextAfter);
  const newBlockLines = v9SplitLines(operation.newBlock as string);
  const newLines = [...lines.slice(0, found.startLine - 1), ...newBlockLines, ...lines.slice(found.endLine)];
  const newContent = v9JoinLines(newLines);
  const absPath = path.resolve(workingDir, operation.path);
  fs.writeFileSync(absPath, newContent, 'utf8');
  const verify = v10VerifyContent(operation.path, newContent);
  if (!verify.ok) {
    fs.writeFileSync(absPath, oldContent, 'utf8');
    throw new CodingV10Error('edit-verify-failed', `Search-replace verify fail, đã khôi phục file: ${verify.note}`);
  }
  const diff = v9UnifiedDiff(oldContent, newContent, operation.path);
  const result: V9EditResult = {
    ok: true,
    appliedKind: 'search-replace',
    usedFallback: false,
    path: operation.path,
    symbolName: operation.symbolName ?? '',
    startLine: found.startLine,
    endLine: found.startLine + newBlockLines.length - 1,
    linesAdded: diff.linesAdded,
    linesRemoved: diff.linesRemoved,
    diff: diff.text,
    verifyNote: verify.note,
  };
  return { result, newContent, oldContent };
}

/** Áp whole-file: ghi toàn bộ nội dung mới, verify, khôi phục khi fail. */
function applyV10WholeFile(
  workingDir: string,
  operation: V9EditOperation,
  newContent: string,
): { result: V9EditResult; oldContent: string } {
  const oldContent = (() => {
    try {
      return v9ReadEditFile(workingDir, operation.path);
    } catch {
      return '';
    }
  })();
  const absPath = path.resolve(workingDir, operation.path);
  if (absPath !== path.resolve(workingDir) && !absPath.startsWith(`${path.resolve(workingDir)}${path.sep}`)) {
    throw new CodingV10Error('edit-verify-failed', `Refusing to edit outside working dir: ${operation.path}`);
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, newContent, 'utf8');
  const verify = v10VerifyContent(operation.path, newContent);
  if (!verify.ok) {
    if (oldContent !== '') fs.writeFileSync(absPath, oldContent, 'utf8');
    else {
      try {
        fs.unlinkSync(absPath);
      } catch {
        // File mới tạo không xóa được — báo lỗi verify là chính.
      }
    }
    throw new CodingV10Error('edit-verify-failed', `Whole-file verify fail, đã khôi phục file: ${verify.note}`);
  }
  const diff = v9UnifiedDiff(oldContent, newContent, operation.path);
  const result: V9EditResult = {
    ok: true,
    appliedKind: 'search-replace',
    usedFallback: true,
    path: operation.path,
    symbolName: operation.symbolName ?? '',
    startLine: 1,
    endLine: v9SplitLines(newContent).length,
    linesAdded: diff.linesAdded,
    linesRemoved: diff.linesRemoved,
    diff: diff.text,
    verifyNote: verify.note,
  };
  return { result, oldContent };
}

/**
 * Áp một edit bằng chiến lược tốt nhất (hoặc chiến lược bị ép).
 * Trả kết quả kèm toàn bộ ứng viên đã xét; lỗi khi không có chiến
 * lược nào áp được. Commit atomic khi `request.commit = true`.
 */
export async function applyV10Edit(
  request: V10EditRequest,
  options: V10EditStrategyOptions,
): Promise<V10EditApplyResult> {
  const candidates = v10PlanEditCandidates(request, options);
  const ordered = [...candidates]
    .filter((c) => c.applicable)
    .sort((a, b) => b.score - a.score);
  let chosen: V10EditCandidate | undefined;
  let usedFallback = false;
  if (request.forceStrategy) {
    chosen = candidates.find((c) => c.strategy === request.forceStrategy && c.applicable);
    if (!chosen) {
      // Chiến lược bị ép không áp được: fallback sang chiến lược tốt
      // nhất còn lại (ghi rõ usedFallback).
      chosen = ordered[0];
      usedFallback = true;
    }
  } else {
    chosen = ordered[0];
  }
  if (!chosen) {
    throw new CodingV10Error(
      'edit-no-strategy',
      `Không có chiến lược edit nào áp được cho ${request.operation.path}: ${candidates.map((c) => `${c.strategy} (${c.reasons.join('; ')})`).join(' | ')}`,
    );
  }
  let edit: V9EditResult;
  if (chosen.strategy === 'ast') {
    edit = applyV9AstEdit(request.operation, {
      workingDir: options.workingDir,
      allowFallback: false,
      maxChangedLines: options.maxChangedLines,
    });
    if (!edit.ok) {
      throw new CodingV10Error('edit-verify-failed', `AST edit fail: ${edit.error ?? 'unknown'}`);
    }
  } else if (chosen.strategy === 'search-replace') {
    edit = applyV10SearchReplace(options.workingDir, request.operation).result;
  } else {
    edit = applyV10WholeFile(options.workingDir, request.operation, request.newContent as string).result;
  }
  let commitSha: string | undefined;
  if (request.commit) {
    const commit = await commitV9Atomic({
      workingDir: options.workingDir,
      files: [request.operation.path],
      summary: request.commitSummary ?? `v10 edit ${chosen.strategy}: ${request.operation.path}`,
      task: request.commitSummary,
    });
    commitSha = commit.shortSha;
  }
  const result: V10EditApplyResult = {
    ok: true,
    strategy: chosen.strategy,
    usedFallback: usedFallback || edit.usedFallback,
    path: edit.path,
    symbolName: edit.symbolName,
    startLine: edit.startLine,
    endLine: edit.endLine,
    linesAdded: edit.linesAdded,
    linesRemoved: edit.linesRemoved,
    diff: edit.diff,
    verifyNote: edit.verifyNote,
    score: chosen.score,
    candidates,
    ...(commitSha ? { commitSha } : {}),
  };
  options.onEvent?.({
    type: 'edit-result',
    payload: {
      path: result.path,
      strategy: result.strategy,
      usedFallback: result.usedFallback,
      linesAdded: result.linesAdded,
      linesRemoved: result.linesRemoved,
      score: result.score,
      ...(commitSha ? { shortSha: commitSha } : {}),
    },
  });
  return result;
}
