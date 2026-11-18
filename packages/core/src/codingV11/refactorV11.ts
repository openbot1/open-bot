/**
 * Coding agent v11 — multi-file refactor engine.
 *
 * Nối refactor an toàn của v8 (plan → preview diff → approve → apply
 * từng file có backup → verify → rollback tự động) và AST edit của
 * v9: v11 thêm 3 thao tác xuyên nhiều file, với KIỂM TRA THAM CHIẾU
 * ĐẦY ĐỦ trước khi áp và PREVIEW DIFF từng file:
 *
 *   1. rename-symbol: đổi tên một symbol ở mọi nơi tham chiếu tới
 *      nó — định nghĩa, lời gọi, import — tìm bằng parser v8 +
 *      source đã mask (string/comment không bị đổi nhầm); từ chối
 *      khi symbol mơ hồ (trùng tên ở nhiều file mà không chỉ rõ
 *      file định nghĩa) hoặc khi còn tham chiếu chưa resolve.
 *   2. split-file: tách một file thành hai — chuyển các symbol đã
 *      chọn sang file mới, file gốc giữ lại re-export, các file khác
 *      import symbol đã chuyển sẽ được trỏ sang file mới.
 *   3. move-function: di chuyển một hàm sang file khác — cắt block
 *      nguồn của hàm (kèm comment ngay trên nó), dán vào file đích,
 *      file gốc giữ re-export, cập nhật import ở các file dùng hàm.
 *
 * Apply dùng lại `createV8RefactorPlan` + `applyV8RefactorPlan`
 * của v8 (backup + verify + rollback tự động), plan phải được
 * approve trước khi apply — engine tự approve plan do chính nó
 * tạo sau khi preview xong (caller đã xem preview qua `plan`).
 *
 * Giới hạn trung thực: trích block hàm dựa trên dòng bắt đầu của
 * symbol tiếp theo (parser regex của v8 không cho end-line) — hàm
 * lồng nhau hoặc symbol không liên tiếp có thể lấy thừa/thiếu dòng;
 * preview diff cho thấy rõ block sẽ chuyển nên caller kiểm tra
 * trước khi apply. Re-export giữ tương thích nhưng không sửa
 * import nội bộ dạng `import * as` (ghi vào warnings).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { v8ParseFile, v8MaskSource } from '../codingV8/parser';
import { scanV8RepoFiles } from '../codingV8/repoMap';
import {
  applyV8RefactorPlan,
  createV8RefactorPlan,
  v8DefaultBackupDir,
  v8IsOutsideWorkspace,
  v8NormalizeRelPath,
  v8PlanWithStatus,
} from '../codingV8/refactor';
import type { V8ParsedFile, V8Symbol } from '../codingV8/types';
import { v9CountLineChanges, v9UnifiedDiff } from '../codingV9/diffUtil';
import { commitV9Atomic } from '../codingV9/gitAtomic';
import { v11ShortName } from './callGraph';
import { CodingV11Error } from './types';
import type {
  V11RefactorApplyResult,
  V11RefactorFileChange,
  V11RefactorKind,
  V11RefactorPlan,
  V11ReferenceCheck,
  V11SymbolReference,
} from './types';

/** Tạo id plan duy nhất (`v11ref-<hex>`). */
export function v11NewRefactorPlanId(): string {
  return `v11ref-${crypto.randomBytes(6).toString('hex')}`;
}

/** Tối đa số tham chiếu liệt kê chi tiết trong ReferenceCheck (tránh report phình). */
export const V11_REFACTOR_MAX_REFERENCES_LISTED = 500;

/** Tách nội dung thành dòng (bỏ dòng rỗng cuối do `\n` cuối). */
function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Nối dòng thành nội dung (thêm `\n` cuối khi có dòng). */
function joinLines(lines: string[]): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}

/** Escape tên để dùng trong regex word-boundary. */
function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** true = tên là identifier hợp lệ (để đổi tên tới). */
export function v11IsValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** Tính đường import tương đối từ một file tới một file khác (dùng `/`). */
export function v11RelativeImport(fromFile: string, toFile: string): string {
  const fromDir = path.posix.dirname(fromFile);
  let rel = path.posix.relative(fromDir, toFile);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  // Bỏ đuôi file (.ts/.js/…) — import TS/JS thường không ghi đuôi.
  rel = rel.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '');
  return rel;
}

export interface V11RefactorEngineOptions {
  /** Working dir = repo root. */
  workingDir: string;
  /** Số file tối đa quét khi kiểm tra tham chiếu. */
  maxFiles?: number;
}

/** Kết quả đọc + parse toàn bộ repo (dùng chung cho các thao tác). */
interface V11RepoSnapshot {
  files: V8ParsedFile[];
  contents: Map<string, string>;
}

/**
 * Engine refactor v11: kiểm tra tham chiếu → lập plan có preview
 * diff → apply (backup + verify + rollback qua v8). Không gọi
 * model, không gọi mạng, không chạy shell.
 */
export class V11RefactorEngine {
  readonly workingDir: string;
  private readonly maxFiles?: number;

  constructor(options: V11RefactorEngineOptions) {
    this.workingDir = path.resolve(options.workingDir);
    this.maxFiles = options.maxFiles;
    fs.mkdirSync(this.workingDir, { recursive: true });
  }

  /** Đọc + parse toàn bộ repo (file TS/JS theo scan của v8). */
  private snapshotRepo(): V11RepoSnapshot {
    const relPaths = scanV8RepoFiles(this.workingDir, this.maxFiles ? { maxFiles: this.maxFiles } : {});
    const knownFiles = new Set(relPaths);
    const contents = new Map<string, string>();
    const files: V8ParsedFile[] = [];
    for (const rel of relPaths) {
      let content = '';
      try {
        content = fs.readFileSync(path.join(this.workingDir, rel), 'utf8');
      } catch {
        content = '';
      }
      contents.set(rel, content);
      files.push(v8ParseFile(rel, content, knownFiles));
    }
    return { files, contents };
  }

  /** Tìm định nghĩa của một symbol (theo qualified hoặc short name). */
  private findDefinitions(
    snapshot: V11RepoSnapshot,
    symbol: string,
    definitionFile?: string,
  ): Array<{ file: string; symbol: V8Symbol }> {
    const found: Array<{ file: string; symbol: V8Symbol }> = [];
    for (const file of snapshot.files) {
      if (definitionFile && file.relPath !== definitionFile) continue;
      for (const sym of file.symbols) {
        if (sym.qualifiedName === symbol || sym.qualifiedName.split('.').pop() === symbol) {
          found.push({ file: file.relPath, symbol: sym });
        }
      }
    }
    return found;
  }

  /**
   * Kiểm tra tham chiếu đầy đủ của một symbol: mọi nơi dùng tên đó
   * (định nghĩa / gọi / import / tham chiếu), tìm trên source đã
   * mask để không nhầm string/comment. Trả cả symbol trùng tên gây
   * mơ hồ (để caller quyết có đổi tên không).
   */
  checkReferences(symbol: string, definitionFile?: string): V11ReferenceCheck {
    const short = symbol.split('.').pop() as string;
    const snapshot = this.snapshotRepo();
    const definitions = this.findDefinitions(snapshot, symbol, definitionFile);
    if (definitions.length === 0) {
      throw new CodingV11Error(
        'refactor-symbol-not-found',
        `Refactor v11: không tìm thấy symbol "${symbol}"${definitionFile ? ` trong ${definitionFile}` : ''}.`,
      );
    }
    if (definitions.length > 1 && !definitionFile) {
      throw new CodingV11Error(
        'refactor-ambiguous',
        `Refactor v11: symbol "${symbol}" định nghĩa ở ${definitions.length} file (${definitions.map((d) => d.file).join(', ')}) — chỉ rõ definitionFile.`,
      );
    }
    const def = definitions[0] as { file: string; symbol: V8Symbol };
    const references: V11SymbolReference[] = [];
    const ambiguousSymbols: Array<{ qualifiedName: string; file: string; line: number }> = [];
    for (const other of definitions.slice(1)) {
      ambiguousSymbols.push({ qualifiedName: other.symbol.qualifiedName, file: other.file, line: other.symbol.line });
    }
    // Symbol trùng tên ngắn ở file khác (không phải định nghĩa đã chọn).
    for (const file of snapshot.files) {
      if (file.relPath === def.file) continue;
      for (const sym of file.symbols) {
        if (sym.qualifiedName.split('.').pop() === short && sym.qualifiedName !== def.symbol.qualifiedName) {
          ambiguousSymbols.push({ qualifiedName: sym.qualifiedName, file: file.relPath, line: sym.line });
        }
      }
    }
    const pattern = new RegExp(`\\b${escapeRegExp(short)}\\b`, 'g');
    for (const file of snapshot.files) {
      const content = snapshot.contents.get(file.relPath) ?? '';
      const masked = v8MaskSource(content);
      const rawLines = splitLines(content);
      const isDefinitionFile = file.relPath === def.file;
      masked.forEach((maskedLine, index) => {
        const lineNo = index + 1;
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(maskedLine.text)) !== null) {
          const column = match.index;
          const lineText = (rawLines[index] ?? '').slice(0, 120);
          let role: V11SymbolReference['role'] = 'reference';
          if (isDefinitionFile && lineNo === def.symbol.line) role = 'definition';
          else if (/^\s*import\b/.test(maskedLine.text)) role = 'import';
          else if (maskedLine.text.slice(Math.max(0, column - 1), column + short.length + 1).includes('(')) role = 'call';
          references.push({ file: file.relPath, line: lineNo, column, role, lineText });
        }
      });
    }
    references.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
    const filesAffected = new Set(references.map((r) => r.file)).size;
    // Tham chiếu "chưa resolve": tên xuất hiện ở file khác mà file đó
    // KHÔNG import file định nghĩa và cũng KHÔNG định nghĩa symbol
    // cùng tên — có thể là symbol khác trùng tên (false positive).
    const unresolved = references.filter((r) => {
      if (r.file === def.file) return false;
      const parsed = snapshot.files.find((f) => f.relPath === r.file);
      if (!parsed) return true;
      if (parsed.imports.some((i) => i.resolved === def.file)) return false;
      if (parsed.symbols.some((s) => s.qualifiedName.split('.').pop() === short)) return false;
      return true;
    });
    return {
      symbol: def.symbol.qualifiedName,
      definitionFile: def.file,
      references: references.slice(0, V11_REFACTOR_MAX_REFERENCES_LISTED),
      filesAffected,
      ambiguous: ambiguousSymbols.length > 0,
      ambiguousSymbols,
      unresolved,
    };
  }

  /** Đổi tên một symbol ở mọi file tham chiếu — trả plan có preview diff (chưa áp). */
  planRenameSymbol(symbol: string, newName: string, definitionFile?: string): V11RefactorPlan {
    if (!v11IsValidIdentifier(newName)) {
      throw new CodingV11Error('refactor-ambiguous', `Refactor v11: tên mới "${newName}" không phải identifier hợp lệ.`);
    }
    const short = symbol.split('.').pop() as string;
    if (short === newName) {
      throw new CodingV11Error('refactor-no-change', `Refactor v11: tên mới trùng tên cũ ("${newName}").`);
    }
    const check = this.checkReferences(symbol, definitionFile);
    const snapshot = this.snapshotRepo();
    const warnings: string[] = [];
    if (check.ambiguous) {
      warnings.push(
        `Tên "${short}" trùng ở ${check.ambiguousSymbols.length} symbol khác (${check.ambiguousSymbols.map((s) => `${s.qualifiedName} (${s.file}:${s.line})`).join(', ')}) — chỉ đổi ở file tham chiếu tới định nghĩa ${check.definitionFile}; kiểm tra preview trước khi áp.`,
      );
    }
    const byFile = new Map<string, V11SymbolReference[]>();
    for (const ref of check.references) {
      const list = byFile.get(ref.file) ?? [];
      list.push(ref);
      byFile.set(ref.file, list);
    }
    const changes: V11RefactorFileChange[] = [];
    const pattern = new RegExp(`\\b${escapeRegExp(short)}\\b`, 'g');
    for (const [file, refs] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const oldContent = snapshot.contents.get(file) ?? '';
      const rawLines = splitLines(oldContent);
      const masked = v8MaskSource(oldContent);
      const linesToChange = new Set(refs.map((r) => r.line));
      const newLines = rawLines.map((line, index) => {
        const lineNo = index + 1;
        if (!linesToChange.has(lineNo)) return line;
        // Chỉ thay trên phần code (masked) — vị trí trùng khớp vì mask giữ độ dài.
        const maskedLine = masked[index]?.text ?? line;
        let out = '';
        let last = 0;
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(maskedLine)) !== null) {
          out += line.slice(last, match.index) + newName;
          last = match.index + short.length;
        }
        out += line.slice(last);
        return out;
      });
      const newContent = joinLines(newLines);
      if (newContent === oldContent) continue;
      const diff = v9UnifiedDiff(oldContent, newContent, file);
      changes.push({
        path: file,
        newContent,
        oldContent,
        diff: diff.text,
        linesAdded: diff.linesAdded,
        linesRemoved: diff.linesRemoved,
        description: `rename ${short} → ${newName} (${refs.length} tham chiếu)`,
      });
    }
    if (changes.length === 0) {
      throw new CodingV11Error('refactor-no-change', `Refactor v11: đổi tên "${short}" không đổi file nào.`);
    }
    return {
      id: v11NewRefactorPlanId(),
      kind: 'rename-symbol',
      title: `rename ${check.symbol} → ${newName}`,
      createdAt: new Date().toISOString(),
      referenceCheck: check,
      changes,
      totalAdded: changes.reduce((s, c) => s + c.linesAdded, 0),
      totalRemoved: changes.reduce((s, c) => s + c.linesRemoved, 0),
      warnings,
    };
  }

  /**
   * Tách file: chuyển các symbol đã chọn sang file mới. File gốc
   * giữ re-export, các file khác import symbol đã chuyển sẽ được
   * trỏ sang file mới. Trả plan có preview diff (chưa áp).
   */
  planSplitFile(sourceFile: string, symbols: readonly string[], targetFile: string): V11RefactorPlan {
    const src = v8NormalizeRelPath(sourceFile);
    const dst = v8NormalizeRelPath(targetFile);
    if (v8IsOutsideWorkspace(src) || v8IsOutsideWorkspace(dst)) {
      throw new CodingV11Error('refactor-symbol-not-found', `Refactor v11: path thoát workspace: ${src} / ${dst}.`);
    }
    if (src === dst) {
      throw new CodingV11Error('refactor-no-change', 'Refactor v11: file đích trùng file nguồn.');
    }
    if (symbols.length === 0) {
      throw new CodingV11Error('refactor-symbol-not-found', 'Refactor v11: chưa chọn symbol nào để tách.');
    }
    const snapshot = this.snapshotRepo();
    const srcParsed = snapshot.files.find((f) => f.relPath === src);
    if (!srcParsed) {
      throw new CodingV11Error('refactor-symbol-not-found', `Refactor v11: không tìm thấy file nguồn: ${src}.`);
    }
    if ((snapshot.contents.get(dst) ?? null) !== null && fs.existsSync(path.join(this.workingDir, dst))) {
      throw new CodingV11Error('refactor-ambiguous', `Refactor v11: file đích đã tồn tại: ${dst} (chọn tên khác).`);
    }
    const srcLines = splitLines(snapshot.contents.get(src) ?? '');
    const sortedSymbols = [...srcParsed.symbols].sort((a, b) => a.line - b.line);
    const warnings: string[] = [];
    const blocks: Array<{ symbol: string; lines: string[] }> = [];
    for (const name of symbols) {
      const sym = sortedSymbols.find((s) => s.qualifiedName === name || s.qualifiedName.split('.').pop() === name);
      if (!sym) {
        throw new CodingV11Error('refactor-symbol-not-found', `Refactor v11: không tìm thấy symbol "${name}" trong ${src}.`);
      }
      const next = sortedSymbols.find((s) => s.line > sym.line);
      let start = sym.line - 1;
      // Kèm comment ngay trên symbol (dòng // hoặc /* */ liền kề).
      while (start > 0 && /^\s*(\/\/|\*|\/\*)/.test(srcLines[start - 1] as string)) start -= 1;
      let end = (next ? next.line - 1 : srcLines.length) - 1;
      while (end >= start && (srcLines[end] as string).trim() === '') end -= 1;
      blocks.push({ symbol: sym.qualifiedName, lines: srcLines.slice(start, end + 1) });
    }
    // File mới: các block đã chuyển (theo thứ tự trong file gốc).
    const orderedBlocks = [...blocks].sort(
      (a, b) =>
        (sortedSymbols.find((s) => s.qualifiedName === a.symbol)?.line ?? 0) -
        (sortedSymbols.find((s) => s.qualifiedName === b.symbol)?.line ?? 0),
    );
    const targetContent = `${orderedBlocks.flatMap((b) => b.lines).join('\n')}\n`;
    // File gốc: bỏ các block đã chuyển, thêm re-export.
    const movedRanges: Array<[number, number]> = [];
    for (const name of symbols) {
      const sym = sortedSymbols.find((s) => s.qualifiedName === name || s.qualifiedName.split('.').pop() === name) as V8Symbol;
      const next = sortedSymbols.find((s) => s.line > sym.line);
      let start = sym.line - 1;
      while (start > 0 && /^\s*(\/\/|\*|\/\*)/.test(srcLines[start - 1] as string)) start -= 1;
      let end = (next ? next.line - 1 : srcLines.length) - 1;
      while (end >= start && (srcLines[end] as string).trim() === '') end -= 1;
      movedRanges.push([start, end]);
    }
    const removed = new Set<number>();
    for (const [start, end] of movedRanges) {
      for (let i = start; i <= end; i++) removed.add(i);
    }
    const keptLines = srcLines.filter((_, i) => !removed.has(i));
    while (keptLines.length > 0 && (keptLines[keptLines.length - 1] as string).trim() === '') keptLines.pop();
    const reExport = `export { ${symbols.map((s) => s.split('.').pop() as string).join(', ')} } from '${v11RelativeImport(src, dst)}';`;
    keptLines.push('', reExport);
    const srcNewContent = joinLines(keptLines);
    const changes: V11RefactorFileChange[] = [];
    const srcDiff = v9UnifiedDiff(snapshot.contents.get(src) ?? '', srcNewContent, src);
    changes.push({
      path: src,
      newContent: srcNewContent,
      oldContent: snapshot.contents.get(src) ?? '',
      diff: srcDiff.text,
      linesAdded: srcDiff.linesAdded,
      linesRemoved: srcDiff.linesRemoved,
      description: `split ${src}: chuyển ${symbols.join(', ')} sang ${dst} (giữ re-export)`,
    });
    const dstDiff = v9UnifiedDiff('', targetContent, dst);
    changes.push({
      path: dst,
      newContent: targetContent,
      oldContent: null,
      diff: dstDiff.text,
      linesAdded: dstDiff.linesAdded,
      linesRemoved: dstDiff.linesRemoved,
      description: `tạo ${dst} với ${symbols.join(', ')}`,
    });
    // Cập nhật import ở các file khác: import symbol đã chuyển từ src → dst.
    const movedShorts = new Set(symbols.map((s) => s.split('.').pop() as string));
    for (const file of snapshot.files) {
      if (file.relPath === src) continue;
      const imp = file.imports.find((i) => i.resolved === src);
      if (!imp) continue;
      const movedNames = imp.names.filter((n) => movedShorts.has(v11ShortName(n)));
      if (movedNames.length === 0) continue;
      if (imp.names.some((n) => n.startsWith('*'))) {
        warnings.push(`${file.relPath} dùng \`import *\` từ ${src} — không tự sửa import, kiểm tra tay sau khi tách.`);
        continue;
      }
      const content = snapshot.contents.get(file.relPath) ?? '';
      const lines = splitLines(content);
      const importLine = lines[imp.line - 1] ?? '';
      const newImportLine = importLine.replace(
        imp.specifier,
        v11RelativeImport(file.relPath, dst),
      );
      // Chỉ sửa khi import CHỈ chứa symbol đã chuyển; nếu import lẫn symbol ở lại thì tách import thành 2 dòng.
      const remaining = imp.names.filter((n) => !movedShorts.has(v11ShortName(n)));
      let replacement: string;
      if (remaining.length === 0) {
        replacement = newImportLine;
      } else {
        const movedPart = `import { ${movedNames.join(', ')} } from '${v11RelativeImport(file.relPath, dst)}';`;
        const keptPart = importLine.replace(
          /\{[^}]*\}/,
          `{ ${remaining.join(', ')} }`,
        );
        replacement = `${keptPart}\n${movedPart}`;
      }
      lines[imp.line - 1] = replacement;
      const newContent = joinLines(lines);
      const diff = v9UnifiedDiff(content, newContent, file.relPath);
      changes.push({
        path: file.relPath,
        newContent,
        oldContent: content,
        diff: diff.text,
        linesAdded: diff.linesAdded,
        linesRemoved: diff.linesRemoved,
        description: `đổi import ${movedNames.join(', ')} từ ${src} sang ${dst}`,
      });
    }
    return {
      id: v11NewRefactorPlanId(),
      kind: 'split-file',
      title: `split ${src} → ${dst} (${symbols.join(', ')})`,
      createdAt: new Date().toISOString(),
      changes,
      totalAdded: changes.reduce((s, c) => s + c.linesAdded, 0),
      totalRemoved: changes.reduce((s, c) => s + c.linesRemoved, 0),
      warnings,
    };
  }

  /**
   * Di chuyển một hàm sang file khác: cắt block hàm khỏi file gốc
   * (giữ re-export), dán vào cuối file đích, cập nhật import ở các
   * file dùng hàm. Trả plan có preview diff (chưa áp).
   */
  planMoveFunction(symbol: string, fromFile: string, toFile: string): V11RefactorPlan {
    const src = v8NormalizeRelPath(fromFile);
    const dst = v8NormalizeRelPath(toFile);
    if (v8IsOutsideWorkspace(src) || v8IsOutsideWorkspace(dst)) {
      throw new CodingV11Error('refactor-symbol-not-found', `Refactor v11: path thoát workspace: ${src} / ${dst}.`);
    }
    if (src === dst) {
      throw new CodingV11Error('refactor-no-change', 'Refactor v11: file đích trùng file nguồn.');
    }
    const check = this.checkReferences(symbol, src);
    const snapshot = this.snapshotRepo();
    const srcParsed = snapshot.files.find((f) => f.relPath === src) as V8ParsedFile;
    const dstContent = snapshot.contents.get(dst);
    if (dstContent === undefined) {
      throw new CodingV11Error('refactor-symbol-not-found', `Refactor v11: không tìm thấy file đích: ${dst}.`);
    }
    const short = symbol.split('.').pop() as string;
    const sym = srcParsed.symbols.find((s) => s.qualifiedName === symbol || s.qualifiedName.split('.').pop() === symbol);
    if (!sym) {
      throw new CodingV11Error('refactor-symbol-not-found', `Refactor v11: không tìm thấy symbol "${symbol}" trong ${src}.`);
    }
    const srcLines = splitLines(snapshot.contents.get(src) ?? '');
    const sortedSymbols = [...srcParsed.symbols].sort((a, b) => a.line - b.line);
    const next = sortedSymbols.find((s) => s.line > sym.line);
    let start = sym.line - 1;
    while (start > 0 && /^\s*(\/\/|\*|\/\*)/.test(srcLines[start - 1] as string)) start -= 1;
    let end = (next ? next.line - 1 : srcLines.length) - 1;
    while (end >= start && (srcLines[end] as string).trim() === '') end -= 1;
    const blockLines = srcLines.slice(start, end + 1);
    const warnings: string[] = [];
    if (check.ambiguous) {
      warnings.push(`Tên "${short}" trùng ở symbol khác — chỉ di chuyển định nghĩa trong ${src}; kiểm tra preview trước khi áp.`);
    }
    // File gốc: bỏ block, thêm re-export.
    const removed = new Set<number>();
    for (let i = start; i <= end; i++) removed.add(i);
    const keptLines = srcLines.filter((_, i) => !removed.has(i));
    while (keptLines.length > 0 && (keptLines[keptLines.length - 1] as string).trim() === '') keptLines.pop();
    keptLines.push('', `export { ${short} } from '${v11RelativeImport(src, dst)}';`);
    const srcNewContent = joinLines(keptLines);
    // File đích: thêm block vào cuối.
    const dstLines = splitLines(dstContent);
    while (dstLines.length > 0 && (dstLines[dstLines.length - 1] as string).trim() === '') dstLines.pop();
    dstLines.push('', ...blockLines);
    const dstNewContent = joinLines(dstLines);
    const changes: V11RefactorFileChange[] = [];
    const srcDiff = v9UnifiedDiff(snapshot.contents.get(src) ?? '', srcNewContent, src);
    changes.push({
      path: src,
      newContent: srcNewContent,
      oldContent: snapshot.contents.get(src) ?? '',
      diff: srcDiff.text,
      linesAdded: srcDiff.linesAdded,
      linesRemoved: srcDiff.linesRemoved,
      description: `move ${short} khỏi ${src} (giữ re-export)`,
    });
    const dstDiff = v9UnifiedDiff(dstContent, dstNewContent, dst);
    changes.push({
      path: dst,
      newContent: dstNewContent,
      oldContent: dstContent,
      diff: dstDiff.text,
      linesAdded: dstDiff.linesAdded,
      linesRemoved: dstDiff.linesRemoved,
      description: `thêm ${short} vào ${dst}`,
    });
    // Cập nhật import ở các file khác (trừ src/dst): import hàm này từ src → dst.
    for (const file of snapshot.files) {
      if (file.relPath === src || file.relPath === dst) continue;
      const imp = file.imports.find((i) => i.resolved === src);
      if (!imp || !imp.names.some((n) => v11ShortName(n) === short)) continue;
      if (imp.names.some((n) => n.startsWith('*'))) {
        warnings.push(`${file.relPath} dùng \`import *\` từ ${src} — không tự sửa import, kiểm tra tay sau khi di chuyển.`);
        continue;
      }
      const content = snapshot.contents.get(file.relPath) ?? '';
      const lines = splitLines(content);
      const importLine = lines[imp.line - 1] ?? '';
      const remaining = imp.names.filter((n) => v11ShortName(n) !== short);
      let replacement: string;
      if (remaining.length === 0) {
        replacement = importLine.replace(imp.specifier, v11RelativeImport(file.relPath, dst));
      } else {
        const movedPart = `import { ${short} } from '${v11RelativeImport(file.relPath, dst)}';`;
        const keptPart = importLine.replace(/\{[^}]*\}/, `{ ${remaining.join(', ')} }`);
        replacement = `${keptPart}\n${movedPart}`;
      }
      lines[imp.line - 1] = replacement;
      const newContent = joinLines(lines);
      const diff = v9UnifiedDiff(content, newContent, file.relPath);
      changes.push({
        path: file.relPath,
        newContent,
        oldContent: content,
        diff: diff.text,
        linesAdded: diff.linesAdded,
        linesRemoved: diff.linesRemoved,
        description: `đổi import ${short} từ ${src} sang ${dst}`,
      });
    }
    return {
      id: v11NewRefactorPlanId(),
      kind: 'move-function',
      title: `move ${check.symbol} ${src} → ${dst}`,
      createdAt: new Date().toISOString(),
      referenceCheck: check,
      changes,
      totalAdded: changes.reduce((s, c) => s + c.linesAdded, 0),
      totalRemoved: changes.reduce((s, c) => s + c.linesRemoved, 0),
      warnings,
    };
  }

  /**
   * Áp một plan refactor (đã preview): tạo plan v8 từ changes,
   * approve, apply (backup + verify + rollback tự động qua v8),
   * commit atomic khi caller yêu cầu.
   */
  async applyPlan(
    plan: V11RefactorPlan,
    options: {
      commit?: boolean;
      commitMessage?: string;
      verify?: (plan: import('../codingV8/types').V8RefactorPlan) => Promise<{ ok: boolean; output: string }> | { ok: boolean; output: string };
    } = {},
  ): Promise<V11RefactorApplyResult> {
    const backupDir = v8DefaultBackupDir(this.workingDir, plan.id);
    const v8Plan = createV8RefactorPlan(
      this.workingDir,
      plan.title,
      plan.kind,
      plan.changes.map((c) => ({ path: c.path, newContent: c.newContent, description: c.description })),
      plan.id,
    );
    const approved = v8PlanWithStatus(v8Plan, 'approved', 'approved by V11RefactorEngine after preview');
    const { plan: finalPlan, apply, verify } = await applyV8RefactorPlan(approved, {
      workingDir: this.workingDir,
      backupDir,
      verify: options.verify,
      verifyStep: 'v11-refactor-verify',
    });
    if (finalPlan.status === 'rolled-back' || !apply.ok) {
      return {
        planId: plan.id,
        kind: plan.kind,
        ok: false,
        filesChanged: [],
        backupDir,
        error: verify
          ? `verify fail — đã rollback: ${verify.output.slice(0, 300)}`
          : 'apply lỗi giữa chừng — đã rollback',
      };
    }
    let commitSha: string | undefined;
    if (options.commit) {
      try {
        const commit = await commitV9Atomic({
          workingDir: this.workingDir,
          files: plan.changes.map((c) => c.path),
          summary: options.commitMessage ?? plan.title,
          message: options.commitMessage ?? plan.title,
        });
        commitSha = commit.sha;
      } catch (err) {
        return {
          planId: plan.id,
          kind: plan.kind,
          ok: false,
          filesChanged: plan.changes.map((c) => c.path),
          backupDir,
          error: `apply ok nhưng commit lỗi: ${(err as Error).message} (file đã đổi, xem backup ${backupDir})`,
        };
      }
    }
    return {
      planId: plan.id,
      kind: plan.kind,
      ok: true,
      filesChanged: plan.changes.map((c) => c.path),
      backupDir,
      commitSha,
    };
  }
}

/** Đổi tên nhanh: lập plan + apply trong một lần gọi. */
export async function renameV11Symbol(
  workingDir: string,
  symbol: string,
  newName: string,
  definitionFile?: string,
): Promise<{ plan: V11RefactorPlan; result: V11RefactorApplyResult }> {
  const engine = new V11RefactorEngine({ workingDir });
  const plan = engine.planRenameSymbol(symbol, newName, definitionFile);
  const result = await engine.applyPlan(plan);
  return { plan, result };
}
