/**
 * Coding agent v16 — FileWindowViewer: xem file theo cửa sổ 100 dòng
 * (phân trang nội dung file lớn).
 *
 * Ý tưởng từ nghiên cứu (survey v138 §3, Princeton/SWE-agent): cửa
 * sổ file 100 dòng cho +5.3 điểm so với đọc cả file — model thấy đủ
 * ngữ cảnh mà không ngập token. Viewer là hàm thuần trên text (đọc
 * file do tool layer lo): chia trang, nhảy tới dòng, tìm chuỗi trong
 * cửa sổ, lấy cửa sổ quanh một dòng (context window).
 */

import { CodingV16Error, V16_DEFAULTS } from './types';
import type { V16FileWindow } from './types';

/** Chia text thành mảng dòng (giữ nguyên nội dung, bỏ \r). */
export function v16SplitLines(content: string): string[] {
  if (content === '') return [];
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** Số trang khi chia `totalLines` dòng thành cửa sổ `windowLines` dòng. */
export function v16TotalPages(totalLines: number, windowLines: number): number {
  if (!Number.isInteger(totalLines) || totalLines < 0) {
    throw new CodingV16Error('window-invalid', 'totalLines must be a non-negative integer.');
  }
  if (!Number.isInteger(windowLines) || windowLines <= 0) {
    throw new CodingV16Error('window-invalid', 'windowLines must be a positive integer.');
  }
  if (totalLines === 0) return 0;
  return Math.ceil(totalLines / windowLines);
}

/** Trang nào chứa dòng `line` (1-based). */
export function v16PageForLine(line: number, windowLines: number, totalLines: number): number {
  if (!Number.isInteger(line) || line < 1 || line > totalLines) {
    throw new CodingV16Error('window-out-of-range', `Line ${line} is out of range (1..${totalLines}).`);
  }
  if (!Number.isInteger(windowLines) || windowLines <= 0) {
    throw new CodingV16Error('window-invalid', 'windowLines must be a positive integer.');
  }
  return Math.floor((line - 1) / windowLines) + 1;
}

/** Đánh số dòng cho một lát cắt: "  12| nội dung". */
export function v16NumberLines(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}| ${line}`)
    .join('\n');
}

/**
 * Lấy một cửa sổ (trang) của file.
 * `page` 1-based; page vượt quá → lỗi window-out-of-range.
 */
export function v16GetWindow(
  path: string,
  content: string,
  page: number,
  windowLines: number = V16_DEFAULTS.fileWindowLines,
): V16FileWindow {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new CodingV16Error('window-invalid', 'File window path must be a non-empty string.');
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new CodingV16Error('window-invalid', 'File window page must be a positive integer.');
  }
  if (!Number.isInteger(windowLines) || windowLines <= 0) {
    throw new CodingV16Error('window-invalid', 'windowLines must be a positive integer.');
  }
  const all = v16SplitLines(content);
  const totalLines = all.length;
  const totalPages = v16TotalPages(totalLines, windowLines);
  if (totalPages === 0) {
    return {
      path,
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      windowLines,
      totalPages: 0,
      page,
      lines: [],
      numbered: '',
    };
  }
  if (page > totalPages) {
    throw new CodingV16Error(
      'window-out-of-range',
      `Page ${page} is out of range (1..${totalPages}).`,
    );
  }
  const startLine = (page - 1) * windowLines + 1;
  const endLine = Math.min(page * windowLines, totalLines);
  const lines = all.slice(startLine - 1, endLine);
  return {
    path,
    startLine,
    endLine,
    totalLines,
    windowLines,
    totalPages,
    page,
    lines,
    numbered: v16NumberLines(lines, startLine),
  };
}

/** Lấy cửa sổ chứa một dòng cụ thể (context window quanh dòng đó). */
export function v16WindowAroundLine(
  path: string,
  content: string,
  line: number,
  windowLines: number = V16_DEFAULTS.fileWindowLines,
): V16FileWindow {
  const totalLines = v16SplitLines(content).length;
  const page = v16PageForLine(line, windowLines, totalLines);
  return v16GetWindow(path, content, page, windowLines);
}

/** Lấy cửa sổ "neo" quanh một dòng: dòng mục tiêu nằm giữa cửa sổ. */
export function v16WindowCenteredOnLine(
  path: string,
  content: string,
  line: number,
  windowLines: number = V16_DEFAULTS.fileWindowLines,
): V16FileWindow {
  if (!Number.isInteger(windowLines) || windowLines <= 0) {
    throw new CodingV16Error('window-invalid', 'windowLines must be a positive integer.');
  }
  const all = v16SplitLines(content);
  const totalLines = all.length;
  if (!Number.isInteger(line) || line < 1 || line > totalLines) {
    throw new CodingV16Error('window-out-of-range', `Line ${line} is out of range (1..${totalLines}).`);
  }
  const half = Math.floor(windowLines / 2);
  let startLine = Math.max(1, line - half);
  let endLine = Math.min(totalLines, startLine + windowLines - 1);
  // Dồn cửa sổ về cuối file khi chạm biên dưới.
  if (endLine - startLine + 1 < windowLines) {
    startLine = Math.max(1, endLine - windowLines + 1);
  }
  const lines = all.slice(startLine - 1, endLine);
  const page = v16PageForLine(startLine, windowLines, totalLines);
  return {
    path,
    startLine,
    endLine,
    totalLines,
    windowLines,
    totalPages: v16TotalPages(totalLines, windowLines),
    page,
    lines,
    numbered: v16NumberLines(lines, startLine),
  };
}

/** Một kết quả tìm chuỗi trong file (dòng + số dòng). */
export interface V16FileSearchHit {
  line: number;
  text: string;
  /** Trang (cửa sổ) chứa dòng này. */
  page: number;
}

/**
 * Tìm chuỗi trong file (tìm theo chuỗi con, không phân biệt hoa
 * thường khi `caseInsensitive=true`). Trả tối đa `maxHits` kết quả.
 */
export function v16SearchInFile(
  content: string,
  query: string,
  options: { caseInsensitive?: boolean; maxHits?: number; windowLines?: number } = {},
): V16FileSearchHit[] {
  if (typeof query !== 'string' || query === '') {
    throw new CodingV16Error('window-invalid', 'Search query must be a non-empty string.');
  }
  const windowLines = options.windowLines ?? V16_DEFAULTS.fileWindowLines;
  const maxHits = options.maxHits ?? 50;
  const needle = options.caseInsensitive ? query.toLowerCase() : query;
  const hits: V16FileSearchHit[] = [];
  const lines = v16SplitLines(content);
  for (let i = 0; i < lines.length && hits.length < maxHits; i += 1) {
    const haystack = options.caseInsensitive ? lines[i]!.toLowerCase() : lines[i]!;
    if (haystack.includes(needle)) {
      hits.push({
        line: i + 1,
        text: lines[i]!,
        page: v16PageForLine(i + 1, windowLines, lines.length),
      });
    }
  }
  return hits;
}

/** Render một cửa sổ thành text (header + nội dung có số dòng). */
export function renderV16FileWindow(window: V16FileWindow): string {
  if (window.totalLines === 0) return `${window.path}: empty file (0 lines).`;
  return (
    `${window.path}: lines ${window.startLine}-${window.endLine} of ${window.totalLines} ` +
    `(page ${window.page}/${window.totalPages}, window ${window.windowLines})\n${window.numbered}`
  );
}

/** Một mục trong outline của file (hàm/lớp/kiểu...). */
export interface V16FileOutlineEntry {
  /** 'function' | 'class' | 'interface' | 'type' | 'const' | 'def' | 'heading' | ... */
  kind: string;
  name: string;
  line: number;
  /** Trang (cửa sổ) chứa dòng này. */
  page: number;
}

/**
 * Outline của file: liệt kê hàm/lớp/interface/type/def/heading kèm
 * số dòng + trang, để agent nhảy thẳng tới đúng cửa sổ thay vì đọc
 * từ đầu. Quét bằng regex theo ngôn ngữ (nông — không thay parser).
 */
export function v16FileOutline(
  path: string,
  content: string,
  windowLines: number = V16_DEFAULTS.fileWindowLines,
): V16FileOutlineEntry[] {
  if (!Number.isInteger(windowLines) || windowLines <= 0) {
    throw new CodingV16Error('window-invalid', 'windowLines must be a positive integer.');
  }
  const language = v16LanguageForPath(path);
  const patterns: { kind: string; re: RegExp }[] = [];
  if (language === 'ts' || language === 'js') {
    patterns.push(
      { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
      { kind: 'function', re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'function', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
      { kind: 'function', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/ },
      { kind: 'method', re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*[:{]/ },
    );
  }
  if (language === 'python') {
    patterns.push(
      { kind: 'class', re: /^\s*class\s+([A-Za-z_][\w]*)/ },
      { kind: 'def', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/ },
    );
  }
  if (language === 'go') {
    patterns.push(
      { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/ },
      { kind: 'type', re: /^\s*type\s+([A-Za-z_][\w]*)\s+/ },
    );
  }
  if (language === 'rust') {
    patterns.push(
      { kind: 'function', re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
      { kind: 'struct', re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/ },
      { kind: 'enum', re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/ },
    );
  }
  if (language === 'markdown') {
    patterns.push({ kind: 'heading', re: /^(#{1,6})\s+(.+?)\s*$/ });
  }
  if (patterns.length === 0) return [];
  const lines = v16SplitLines(content);
  const totalLines = lines.length;
  const out: V16FileOutlineEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    for (const { kind, re } of patterns) {
      const m = re.exec(line);
      if (m) {
        const name = kind === 'heading' ? (m[2] ?? '').trim() : m[1]!;
        if (name) {
          out.push({
            kind,
            name,
            line: i + 1,
            page: v16PageForLine(i + 1, windowLines, totalLines),
          });
        }
        break;
      }
    }
  }
  return out;
}

/** Ngôn ngữ của file (để outline chọn pattern) — tái dùng từ editLinter qua đuôi file. */
function v16LanguageForPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'text';
  const ext = base.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    py: 'python', pyi: 'python',
    go: 'go',
    rs: 'rust',
    md: 'markdown', markdown: 'markdown',
  };
  return map[ext] ?? 'text';
}

/** Render outline thành text (1 dòng/mục: dòng + trang + tên). */
export function renderV16FileOutline(entries: V16FileOutlineEntry[], path: string): string {
  if (entries.length === 0) return `${path}: no outline entries found.`;
  const lines = [`${path}: ${entries.length} outline entr${entries.length === 1 ? 'y' : 'ies'}`];
  for (const e of entries) {
    lines.push(`- line ${e.line} (page ${e.page}) [${e.kind}] ${e.name}`);
  }
  return lines.join('\n');
}
