/**
 * AST-aware edit cho coding agent v9 (v1.17, Đội T4).
 *
 * Học ý tưởng (survey v1.17 §2): Aider edit kiểu search-and-replace
 * block (ít token hơn whole-file); xu hướng edit theo cấu trúc
 * (structured diff / AST-aware) thay vì ghi đè whole-file; Claude
 * Code apply-diff workflow (dev review trước khi áp).
 *
 * Cách làm (tự thiết kế, dùng lại parser v8 làm nền AST):
 * - Parse file bằng `v8ParseFile` (parser tree-sitter-lite của v8):
 *   symbol có `line` (1-based) + `endLine` + `kind` + `qualifiedName`.
 * - Thay symbol = thay đúng vùng dòng [line, endLine] bằng nội dung
 *   mới (splice dòng), không chạm phần còn lại của file.
 * - `endLine = 0` (parser không xác định được) → brace-matching:
 *   quét từ dòng khai báo, đếm `{`/`}` trên source đã mask (chuỗi/
 *   comment đã loại bằng `v8MaskSource`) để tìm dòng đóng scope.
 * - Replace import: tìm import theo specifier trong `parsed.imports`,
 *   thay đúng dòng đó (hoặc thêm import mới sau import cuối cùng).
 * - Rename: thay tên theo word-boundary trên source đã mask (không
 *   chạm chuỗi/comment), chỉ trong file đó.
 * - Fallback: khi không parse được AST (symbol không tìm thấy, file
 *   không phải TS/JS/Python) → search-and-replace block: block cũ
 *   phải khớp đúng 1 vị trí (dùng contextBefore/After để phân biệt),
 *   nếu không khớp hoặc khớp nhiều vị trí thì lỗi rõ ràng, KHÔNG đoán.
 * - Verify sau edit: parse lại file mới — symbol đích phải còn tồn
 *   tại (replace/insert), hash nội dung phải đổi, và tổng dòng đổi
 *   phải dưới ngưỡng "diff tối thiểu" (mặc định 200 dòng).
 *
 * Giới hạn trung thực:
 * - Parser v8 không phân biệt method trùng tên ở 2 class khác nhau
 *   khi resolve call — nhưng edit thì phân biệt được nhờ qualifiedName
 *   (`Calc.sum` khác `Other.sum`); khi chỉ cho tên ngắn mà trùng thì
 *   báo `ambiguous-symbol`, không đoán.
 * - Rename chỉ đổi trong một file (không đổi cross-file); rename
 *   method chỉ đổi đúng method đó (theo vùng dòng của symbol).
 * - Edit không tự sửa import thiếu: thay symbol không tự thêm import
 *   cho tên mới dùng trong `newText` (host phải thêm bằng replace/
 *   insert import riêng).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { v8ContentHash, v8MaskSource, v8ParseFile } from '../codingV8/parser';
import type { V8ParsedFile, V8Symbol } from '../codingV8/types';
import { v9CheckMinimalDiff, v9JoinLines, v9SplitLines, v9UnifiedDiff } from './diffUtil';
import { CodingV9Error } from './types';
import type { V9EditOperation, V9EditResult } from './types';

/** Số dòng đổi tối đa mặc định cho một edit (diff tối thiểu). */
export const V9_AST_DEFAULT_MAX_CHANGED_LINES = 200;
/** Số ký tự tối đa của `newText` trong một edit. */
export const V9_AST_MAX_NEW_TEXT_CHARS = 100_000;

/** Tùy chọn cho `applyV9AstEdit`. */
export interface V9AstEditOptions {
  /** Thư mục repo (root để resolve `operation.path`). */
  workingDir: string;
  /** Ngưỡng diff tối thiểu (dòng). Mặc định 200. */
  maxChangedLines?: number;
  /** Cho phép fallback search-replace khi không tìm được AST. Mặc định true. */
  allowFallback?: boolean;
  /** Ghi file thật hay chỉ tính toán (dry-run). Mặc định false = ghi thật. */
  dryRun?: boolean;
}

/** Kết quả locate một symbol (kèm vùng dòng đã resolve). */
export interface V9LocatedSymbol {
  symbol: V8Symbol;
  /** Dòng bắt đầu vùng thay (1-based). */
  startLine: number;
  /** Dòng kết thúc vùng thay (1-based, đã resolve brace khi cần). */
  endLine: number;
}

function fail(code: string, message: string): never {
  throw new CodingV9Error(code, message);
}

/** Đọc file tuyệt đối, lỗi rõ ràng khi thiếu file. */
export function v9ReadEditFile(workingDir: string, relPath: string): string {
  const abs = path.resolve(workingDir, relPath);
  if (!abs.startsWith(path.resolve(workingDir) + path.sep) && abs !== path.resolve(workingDir)) {
    fail('edit-too-large', `Refusing to edit outside working dir: ${relPath}`);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    fail('symbol-not-found', `File not found: ${relPath}`);
  }
  return fs.readFileSync(abs, 'utf8');
}

/**
 * Tìm symbol theo tên (ưu tiên qualifiedName, rồi tên ngắn).
 * Trả về null khi không thấy; throw `ambiguous-symbol` khi tên ngắn
 * khớp nhiều symbol khác nhau (host phải cho qualifiedName/kind).
 */
export function v9FindSymbol(
  parsed: V8ParsedFile,
  symbolName: string,
  opts: { qualifiedName?: string; symbolKind?: string } = {},
): V8Symbol | null {
  let candidates = parsed.symbols.filter((s) => s.name === symbolName);
  if (opts.qualifiedName) {
    candidates = candidates.filter((s) => s.qualifiedName === opts.qualifiedName);
  }
  if (opts.symbolKind) {
    candidates = candidates.filter((s) => s.kind === opts.symbolKind);
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    const where = candidates.map((s) => `${s.qualifiedName} (line ${s.line})`).join(', ');
    fail(
      'ambiguous-symbol',
      `Symbol "${symbolName}" is ambiguous in ${parsed.relPath}: ${where}. ` +
        `Provide qualifiedName or symbolKind to disambiguate.`,
    );
  }
  return candidates[0] as V8Symbol;
}

/**
 * Brace-matching trên source đã mask: từ dòng bắt đầu (1-based),
 * đếm `{`/`}` để tìm dòng đóng scope. Trả về dòng đóng (1-based),
 * hoặc dòng cuối file khi không tìm thấy `}` cân bằng.
 */
export function v9FindScopeEndLine(maskedLines: string[], startLine: number): number {
  let depth = 0;
  let seenOpen = false;
  for (let i = startLine - 1; i < maskedLines.length; i += 1) {
    const line = maskedLines[i] as string;
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        seenOpen = true;
      } else if (ch === '}') {
        depth -= 1;
        if (seenOpen && depth === 0) return i + 1;
      }
    }
  }
  return maskedLines.length;
}

/**
 * Resolve vùng dòng của một symbol: dùng `endLine` của parser khi
 * có; khi `endLine = 0` hoặc nhỏ hơn `line`, dùng brace-matching.
 * Với symbol một dòng (variable, type alias không có `{`), vùng là
 * đúng dòng khai báo (có thể kéo dài tới `;` khi khai báo nhiều dòng).
 */
export function v9ResolveSymbolRange(
  symbol: V8Symbol,
  maskedLines: string[],
  rawLines: string[],
): { startLine: number; endLine: number } {
  const startLine = symbol.line;
  if (symbol.endLine > symbol.line) {
    return { startLine, endLine: symbol.endLine };
  }
  if (symbol.kind === 'variable' || symbol.kind === 'property') {
    // Khai báo biến có thể kéo nhiều dòng tới dấu `;` hoặc `,`.
    let end = startLine;
    while (end < rawLines.length) {
      const line = rawLines[end - 1] as string;
      if (/[;,]\s*$/.test(line) || /=\s*[^,;]+[,;]\s*$/.test(line)) break;
      if (end > startLine && /^\s*(export|const|let|var|function|class|interface|type|enum)\b/.test(line)) break;
      end += 1;
    }
    return { startLine, endLine: end };
  }
  const endLine = v9FindScopeEndLine(maskedLines, startLine);
  return { startLine, endLine: Math.max(startLine, endLine) };
}

/** Locate symbol + resolve vùng dòng (dùng cho replace/insert-after). */
export function v9LocateSymbol(
  parsed: V8ParsedFile,
  content: string,
  symbolName: string,
  opts: { qualifiedName?: string; symbolKind?: string } = {},
): V9LocatedSymbol | null {
  const symbol = v9FindSymbol(parsed, symbolName, opts);
  if (!symbol) return null;
  const masked = v8MaskSource(content).map((m) => m.text);
  const rawLines = v9SplitLines(content);
  const range = v9ResolveSymbolRange(symbol, masked, rawLines);
  return { symbol, startLine: range.startLine, endLine: range.endLine };
}

/**
 * Thay vùng dòng [startLine, endLine] (1-based, inclusive) bằng
 * `newText` (nhiều dòng). Trả về nội dung mới.
 */
export function v9SpliceLines(
  lines: string[],
  startLine: number,
  endLine: number,
  newText: string,
): string[] {
  const replacement = v9SplitLines(newText);
  return [
    ...lines.slice(0, startLine - 1),
    ...replacement,
    ...lines.slice(endLine),
  ];
}

/**
 * Search-and-replace block (fallback khi không có AST): tìm block cũ
 * (exact, theo dòng) trong file. Block phải khớp đúng 1 vị trí; dùng
 * contextBefore/After (dòng kề) để phân biệt khi block trùng. Trả về
 * vùng dòng đã khớp, hoặc throw `block-not-found` / `block-ambiguous`.
 */
export function v9FindBlock(
  lines: string[],
  oldBlock: string,
  contextBefore?: string,
  contextAfter?: string,
): { startLine: number; endLine: number } {
  const blockLines = v9SplitLines(oldBlock);
  if (blockLines.length === 0) {
    fail('block-not-found', 'Old block is empty — nothing to search for.');
  }
  const matches: number[] = [];
  for (let i = 0; i + blockLines.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < blockLines.length; j += 1) {
      if (lines[i + j] !== blockLines[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (contextBefore !== undefined) {
      if (i === 0 || lines[i - 1] !== contextBefore) continue;
    }
    if (contextAfter !== undefined) {
      const afterIdx = i + blockLines.length;
      if (afterIdx >= lines.length || lines[afterIdx] !== contextAfter) continue;
    }
    matches.push(i + 1);
  }
  if (matches.length === 0) {
    fail(
      'block-not-found',
      `Block not found (${blockLines.length} lines, starting with "${(blockLines[0] as string).trim().slice(0, 60)}"). ` +
        `The file may have changed since the block was captured.`,
    );
  }
  if (matches.length > 1) {
    fail(
      'block-ambiguous',
      `Block matches ${matches.length} locations (lines ${matches.join(', ')}). ` +
        `Provide contextBefore/contextAfter to disambiguate.`,
    );
  }
  const startLine = matches[0] as number;
  return { startLine, endLine: startLine + blockLines.length - 1 };
}

/**
 * Rename một symbol trong MỘT file: thay tên theo word-boundary trên
 * source đã mask (không chạm chuỗi/comment). Với method, chỉ thay
 * trong vùng dòng của symbol đó; với top-level symbol, thay toàn file.
 * Trả về nội dung mới (chưa ghi).
 */
export function v9RenameInContent(
  content: string,
  parsed: V8ParsedFile,
  symbolName: string,
  newName: string,
  opts: { qualifiedName?: string } = {},
): { newContent: string; replaced: number } {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) {
    fail('symbol-not-found', `Invalid new name for rename: "${newName}".`);
  }
  const symbol = v9FindSymbol(parsed, symbolName, opts);
  if (!symbol) {
    fail('symbol-not-found', `Symbol "${symbolName}" not found in ${parsed.relPath}.`);
  }
  const masked = v8MaskSource(content);
  const rawLines = v9SplitLines(content);
  const range = v9ResolveSymbolRange(symbol, masked.map((m) => m.text), rawLines);
  const wordRe = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'g');
  let replaced = 0;
  const outLines = rawLines.map((raw, idx) => {
    const lineNo = idx + 1;
    const inScope =
      symbol.qualifiedName.includes('.') || symbol.kind === 'method'
        ? lineNo >= range.startLine && lineNo <= range.endLine
        : true;
    if (!inScope) return raw;
    const maskedLine = masked[idx]?.text ?? '';
    // Chỉ thay ở vị trí mà masked line cũng có từ đó (không phải trong string/comment).
    let result = '';
    let last = 0;
    let m: RegExpExecArray | null;
    const re = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'g');
    while ((m = re.exec(maskedLine)) !== null) {
      void wordRe;
      result += raw.slice(last, m.index) + newName;
      last = m.index + symbolName.length;
      replaced += 1;
    }
    result += raw.slice(last);
    return result;
  });
  return { newContent: v9JoinLines(outLines), replaced };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Áp dụng MỘT thao tác edit AST-aware lên file trong workingDir.
 * Luồng: đọc file → parse → locate/apply theo kind → verify (parse
 * lại + diff tối thiểu) → ghi file (trừ dryRun) → trả kết quả.
 */
export function applyV9AstEdit(
  operation: V9EditOperation,
  options: V9AstEditOptions,
): V9EditResult {
  const maxChangedLines = Math.max(1, Math.floor(options.maxChangedLines ?? V9_AST_DEFAULT_MAX_CHANGED_LINES));
  const allowFallback = options.allowFallback ?? true;
  const absPath = path.resolve(options.workingDir, operation.path);
  const oldContent = v9ReadEditFile(options.workingDir, operation.path);
  const oldLines = v9SplitLines(oldContent);
  const oldHash = v8ContentHash(oldContent);
  let parsed: V8ParsedFile;
  try {
    parsed = v8ParseFile(operation.path, oldContent);
  } catch {
    parsed = {
      relPath: operation.path,
      language: 'unknown',
      contentHash: oldHash,
      size: Buffer.byteLength(oldContent, 'utf8'),
      symbols: [],
      calls: [],
      imports: [],
      hasError: true,
      parseErrors: ['parser threw'],
    };
  }

  let newContent: string | null = null;
  let appliedKind: V9EditOperation['kind'] = operation.kind;
  let usedFallback = false;
  let symbolName = operation.symbolName ?? '';
  let startLine = 0;
  let endLine = 0;

  switch (operation.kind) {
    case 'replace-symbol': {
      if (!operation.symbolName || operation.newText === undefined) {
        fail('symbol-not-found', 'replace-symbol needs symbolName and newText.');
      }
      if (operation.newText.length > V9_AST_MAX_NEW_TEXT_CHARS) {
        fail('edit-too-large', `newText is too large (${operation.newText.length} chars).`);
      }
      const located = v9LocateSymbol(parsed, oldContent, operation.symbolName, {
        qualifiedName: operation.qualifiedName,
        symbolKind: operation.symbolKind,
      });
      if (!located) {
        if (allowFallback && operation.oldBlock && operation.newBlock) {
          const found = v9FindBlock(oldLines, operation.oldBlock, operation.contextBefore, operation.contextAfter);
          newContent = v9JoinLines(v9SpliceLines(oldLines, found.startLine, found.endLine, operation.newBlock));
          appliedKind = 'search-replace';
          usedFallback = true;
          startLine = found.startLine;
          endLine = found.startLine + v9SplitLines(operation.newBlock).length - 1;
          break;
        }
        fail('symbol-not-found', `Symbol "${operation.symbolName}" not found in ${operation.path}.`);
      }
      startLine = located.startLine;
      endLine = located.endLine;
      newContent = v9JoinLines(v9SpliceLines(oldLines, startLine, endLine, operation.newText));
      break;
    }
    case 'replace-import': {
      if (!operation.newSpecifier) {
        fail('symbol-not-found', 'replace-import needs newSpecifier.');
      }
      const specifier = operation.symbolName ?? '';
      const imp = parsed.imports.find((i) => i.specifier === specifier);
      if (!imp) {
        fail('symbol-not-found', `Import "${specifier}" not found in ${operation.path}.`);
      }
      const newText = operation.newText ?? oldLines[imp.line - 1] ?? '';
      const replaced = (oldLines[imp.line - 1] as string).replace(
        new RegExp(`(['"])${escapeRegExp(specifier)}\\1`),
        `$1${operation.newSpecifier}$1`,
      );
      const finalText = newText === (oldLines[imp.line - 1] ?? '') ? replaced : newText;
      startLine = imp.line;
      endLine = imp.line;
      newContent = v9JoinLines(v9SpliceLines(oldLines, imp.line, imp.line, finalText));
      symbolName = specifier;
      break;
    }
    case 'insert-after': {
      if (!operation.symbolName || operation.newText === undefined) {
        fail('symbol-not-found', 'insert-after needs symbolName and newText.');
      }
      const located = v9LocateSymbol(parsed, oldContent, operation.symbolName, {
        qualifiedName: operation.qualifiedName,
        symbolKind: operation.symbolKind,
      });
      if (!located) {
        fail('symbol-not-found', `Symbol "${operation.symbolName}" not found in ${operation.path}.`);
      }
      startLine = located.endLine + 1;
      const insertion = v9SplitLines(operation.newText);
      const lines = [...oldLines];
      lines.splice(located.endLine, 0, '', ...insertion);
      newContent = v9JoinLines(lines);
      endLine = startLine + insertion.length - 1;
      break;
    }
    case 'rename-symbol': {
      if (!operation.symbolName || !operation.newName) {
        fail('symbol-not-found', 'rename-symbol needs symbolName and newName.');
      }
      const { newContent: renamed, replaced } = v9RenameInContent(
        oldContent,
        parsed,
        operation.symbolName,
        operation.newName,
        { qualifiedName: operation.qualifiedName },
      );
      if (replaced === 0) {
        fail('symbol-not-found', `Nothing to rename for "${operation.symbolName}" in ${operation.path}.`);
      }
      const located = v9LocateSymbol(parsed, oldContent, operation.symbolName, {
        qualifiedName: operation.qualifiedName,
      });
      startLine = located?.startLine ?? 1;
      endLine = located?.endLine ?? 1;
      newContent = renamed;
      break;
    }
    case 'search-replace': {
      if (!operation.oldBlock || operation.newBlock === undefined) {
        fail('block-not-found', 'search-replace needs oldBlock and newBlock.');
      }
      const found = v9FindBlock(oldLines, operation.oldBlock, operation.contextBefore, operation.contextAfter);
      newContent = v9JoinLines(v9SpliceLines(oldLines, found.startLine, found.endLine, operation.newBlock));
      startLine = found.startLine;
      endLine = found.startLine + v9SplitLines(operation.newBlock).length - 1;
      break;
    }
    default: {
      fail('symbol-not-found', `Unknown edit kind: ${String(operation.kind)}.`);
    }
  }

  if (newContent === null) {
    fail('verify-failed', 'Edit produced no new content.');
  }
  if (newContent === oldContent) {
    fail('verify-failed', 'Edit produced no change (new content equals old content).');
  }

  // Verify: diff tối thiểu + parse lại + symbol còn tồn tại.
  const diff = v9UnifiedDiff(oldContent, newContent, operation.path);
  const tooLarge = v9CheckMinimalDiff(diff.linesAdded, diff.linesRemoved, maxChangedLines);
  if (tooLarge) {
    fail('edit-too-large', tooLarge);
  }
  let verifyNote = `diff +${diff.linesAdded} -${diff.linesRemoved}`;
  // Chỉ kiểm tra symbol còn tồn tại khi edit đi theo đường AST
  // (fallback search-replace không có symbol đích để kiểm tra).
  if ((operation.kind === 'replace-symbol' || operation.kind === 'insert-after') && !usedFallback) {
    const reparsed = v8ParseFile(operation.path, newContent);
    const nameToCheck =
      operation.kind === 'replace-symbol' ? operation.symbolName : operation.symbolName;
    const stillThere = nameToCheck
      ? v9FindSymbol(reparsed, nameToCheck, { qualifiedName: operation.qualifiedName })
      : null;
    if (operation.kind === 'replace-symbol' && !stillThere && operation.newText && operation.newText.trim() !== '') {
      fail(
        'verify-failed',
        `After edit, symbol "${operation.symbolName}" no longer parses in ${operation.path} — the replacement may be malformed.`,
      );
    }
    verifyNote += reparsed.hasError
      ? '; re-parse reports errors (kept, file may be partially broken)'
      : '; re-parse clean';
    verifyNote += `; symbols before ${parsed.symbols.length}, after ${reparsed.symbols.length}`;
  }
  if (operation.kind === 'rename-symbol' && operation.newName) {
    const reparsed = v8ParseFile(operation.path, newContent);
    const renamed = v9FindSymbol(reparsed, operation.newName);
    if (!renamed) {
      fail(
        'verify-failed',
        `After rename, new name "${operation.newName}" not found in ${operation.path}.`,
      );
    }
    verifyNote += `; renamed to ${operation.newName}`;
  }
  void oldHash;

  if (!options.dryRun) {
    fs.writeFileSync(absPath, newContent, 'utf8');
  }

  return {
    ok: true,
    appliedKind,
    usedFallback,
    path: operation.path,
    symbolName,
    startLine,
    endLine,
    linesAdded: diff.linesAdded,
    linesRemoved: diff.linesRemoved,
    diff: diff.text,
    verifyNote,
  };
}

/**
 * Áp dụng NHIỀU edit theo thứ tự lên cùng một repo (mỗi edit đọc
 * lại file từ đĩa nên edit sau thấy kết quả edit trước). Dừng ở edit
 * đầu tiên lỗi (throw) — host tự quyết định rollback (xem gitAtomic).
 */
export function applyV9AstEdits(
  operations: V9EditOperation[],
  options: V9AstEditOptions,
): V9EditResult[] {
  const results: V9EditResult[] = [];
  for (const op of operations) {
    results.push(applyV9AstEdit(op, options));
  }
  return results;
}

/**
 * Preview một edit mà KHÔNG ghi file (dry-run): trả về kết quả +
 * diff để UI cho user review trước khi approve (kiểu apply-diff).
 */
export function previewV9AstEdit(
  operation: V9EditOperation,
  options: V9AstEditOptions,
): V9EditResult {
  return applyV9AstEdit(operation, { ...options, dryRun: true });
}
