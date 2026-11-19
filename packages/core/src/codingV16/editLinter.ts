/**
 * Coding agent v16 — EditLinterGate: chặn thay đổi sai cú pháp trước
 * khi ghi file (không ghi file lỗi).
 *
 * Ý tưởng từ nghiên cứu (survey v138 §3, Princeton/SWE-agent): edit
 * tool có linter chặn thay đổi sai cú pháp cho +3 điểm — lỗi cú pháp
 * chỉ phát hiện sau khi ghi (chạy test/lint) thì tốn cả vòng sửa.
 * Gate chạy hoàn toàn local, không phụ thuộc ngoài: kiểm tra JSON
 * bằng JSON.parse, kiểm tra cân bằng delimiter + chuỗi/comment cho
 * TS/JS/Python/Go/Rust/CSS/HTML/XML/Markdown... bằng máy quét
 * ký tự đơn giản (không cần parser đầy đủ), kiểm tra dòng quá dài
 * và ký tự điều khiển. Ngôn ngữ suy ra từ đuôi file; file lạ thì
 * chỉ kiểm tra chung (delimiter + ký tự điều khiển).
 *
 * Giới hạn nói rõ: đây là gate cú pháp nông (shallow) — không thay
 * `tsc`, `eslint` hay test suite; nó chặn lỗi hiển nhiên trước khi
 * ghi, không chứng minh code đúng.
 */

import { CodingV16Error } from './types';
import type { V16LintIssue, V16LintResult } from './types';

/** Ngôn ngữ gate hỗ trợ (suy ra từ đuôi file). */
export type V16LintLanguage =
  | 'ts'
  | 'js'
  | 'json'
  | 'jsonc'
  | 'python'
  | 'go'
  | 'rust'
  | 'css'
  | 'html'
  | 'xml'
  | 'markdown'
  | 'yaml'
  | 'text';

/** Đuôi file → ngôn ngữ. */
export const V16_LINT_LANGUAGE_BY_EXTENSION: Record<string, V16LintLanguage> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'jsonc',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  txt: 'text',
};

/** Suy ngôn ngữ từ đường dẫn file (đuôi sau dấu chấm cuối). */
export function v16LanguageForPath(path: string): V16LintLanguage {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'text';
  const ext = base.slice(dot + 1).toLowerCase();
  return V16_LINT_LANGUAGE_BY_EXTENSION[ext] ?? 'text';
}

/** Cặp delimiter mở/đóng cần cân bằng. */
const DELIMITER_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
};

const DELIMITER_CLOSES = new Set(Object.values(DELIMITER_PAIRS));

interface DelimiterFrame {
  char: string;
  line: number;
  column: number;
}

/**
 * Quét cân bằng delimiter, bỏ qua nội dung trong chuỗi ('...', "...",
 * `...`) và comment (// ..., /* ... *\/, # ...). Trả issue cho mỗi
 * delimiter đóng thừa / mở không đóng. Python: bỏ qua vì indent
 * mới là cấu trúc (chỉ kiểm tra () [] {} trong chuỗi đã loại).
 */
export function v16CheckDelimiters(
  content: string,
  language: V16LintLanguage,
): V16LintIssue[] {
  const issues: V16LintIssue[] = [];
  const stack: DelimiterFrame[] = [];
  const lines = content.split('\n');
  let inBlockComment = false;
  let inString: string | null = null;
  let stringEscaped = false;
  const lineComment =
    language === 'python' || language === 'yaml' ? '#' : '//';
  const hasBlockComment =
    language !== 'python' && language !== 'yaml' && language !== 'markdown';

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!;
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;
      const next = line[i + 1] ?? '';
      if (inString !== null) {
        if (stringEscaped) {
          stringEscaped = false;
        } else if (ch === '\\') {
          stringEscaped = true;
        } else if (ch === inString) {
          inString = null;
        }
        i += 1;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      // Bắt đầu comment dòng → bỏ phần còn lại của dòng.
      if (line.startsWith(lineComment, i)) break;
      if (hasBlockComment && ch === '/' && next === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
      // Bắt đầu chuỗi (Python có cả ''' và """ — xử lý như ' và ").
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch;
        i += 1;
        continue;
      }
      if (ch in DELIMITER_PAIRS) {
        stack.push({ char: ch, line: li + 1, column: i + 1 });
      } else if (DELIMITER_CLOSES.has(ch)) {
        const top = stack[stack.length - 1];
        if (!top) {
          issues.push({
            severity: 'error',
            code: 'unbalanced-delimiter',
            message: `Unmatched closing delimiter "${ch}" with no opener.`,
            line: li + 1,
            column: i + 1,
          });
        } else if (DELIMITER_PAIRS[top.char] !== ch) {
          issues.push({
            severity: 'error',
            code: 'unbalanced-delimiter',
            message:
              `Mismatched delimiter: opened "${top.char}" at line ${top.line} but closed with "${ch}".`,
            line: li + 1,
            column: i + 1,
          });
          stack.pop();
        } else {
          stack.pop();
        }
      }
      i += 1;
    }
    // Chuỗi template `...` của JS/TS có thể nhiều dòng; chuỗi '...'/"..."
    // không được nhiều dòng (trừ Python) → lỗi unclosed-string ngay cuối dòng.
    if (inString !== null && inString !== '`' && language !== 'python') {
      issues.push({
        severity: 'error',
        code: 'unclosed-string',
        message: `String starting with ${inString} is never closed on this line.`,
        line: li + 1,
      });
      inString = null;
    }
  }
  for (const frame of stack) {
    issues.push({
      severity: 'error',
      code: 'unbalanced-delimiter',
      message: `Unclosed delimiter "${frame.char}" opened here (never closed).`,
      line: frame.line,
      column: frame.column,
    });
  }
  if (inBlockComment) {
    issues.push({
      severity: 'error',
      code: 'unclosed-comment',
      message: 'Block comment /* ... */ is never closed.',
    });
  }
  if (inString !== null) {
    issues.push({
      severity: 'error',
      code: 'unclosed-string',
      message: `String starting with ${inString} is never closed.`,
    });
  }
  return issues;
}

/** Kiểm tra JSON/JSONC bằng JSON.parse (JSONC: bỏ comment + trailing comma trước). */
export function v16CheckJson(content: string, language: V16LintLanguage): V16LintIssue[] {
  let text = content;
  if (language === 'jsonc') {
    text = text
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/,\s*([}\]])/g, '$1');
  }
  if (text.trim() === '') {
    return [
      { severity: 'error', code: 'json-invalid', message: 'JSON file is empty.' },
    ];
  }
  try {
    JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON.';
    return [{ severity: 'error', code: 'json-invalid', message: `Invalid JSON: ${message}` }];
  }
  return v16CheckJsonDuplicateKeys(text);
}

/**
 * Kiểm tra key trùng trong object JSON (JSON.parse nuốt key trùng
 * lặng lẽ — key sau ghi đè key trước, dễ mất config). Quét nông
 * theo chuỗi "..." ở đầu mỗi cặp key: value.
 */
export function v16CheckJsonDuplicateKeys(text: string): V16LintIssue[] {
  const issues: V16LintIssue[] = [];
  const stack: { depth: number; keys: Set<string> }[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  const lines = text.split('\n');
  const lineOf = (index: number): number => {
    let count = 0;
    for (let li = 0; li < lines.length; li += 1) {
      count += lines[li]!.length + 1;
      if (index < count) return li + 1;
    }
    return lines.length;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        // Chuỗi vừa đóng có phải key không: nhìn tiếp tới ký tự
        // không-trắng đầu tiên, nếu là ':' thì đây là key.
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j]!)) j += 1;
        if (text[j] === ':' && stack.length > 0) {
          const key = text.slice(stringStart + 1, i);
          const frame = stack[stack.length - 1]!;
          if (frame.keys.has(key)) {
            issues.push({
              severity: 'error',
              code: 'json-duplicate-key',
              message: `Duplicate JSON key "${key}" in the same object (later value wins silently).`,
              line: lineOf(stringStart),
            });
          } else {
            frame.keys.add(key);
          }
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
    } else if (ch === '{') {
      depth += 1;
      stack.push({ depth, keys: new Set<string>() });
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      stack.pop();
    }
  }
  return issues;
}

/** Kiểm tra YAML nông: tab đầu dòng + dòng "key:" thiếu giá trị/không có khoảng trắng sau dấu hai chấm. */
export function v16CheckYaml(content: string): V16LintIssue[] {
  const issues: V16LintIssue[] = [];
  const lines = content.split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!;
    if (line.startsWith('\t')) {
      issues.push({
        severity: 'error',
        code: 'yaml-tab-indent',
        message: 'YAML must not use tab indentation.',
        line: li + 1,
        column: 1,
      });
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon > 0 && line[colon + 1] !== undefined && line[colon + 1] !== ' ' && line[colon + 1] !== '\n') {
      const before = line.slice(0, colon);
      if (!before.includes('"') && !before.includes("'") && !before.includes('{')) {
        issues.push({
          severity: 'warning',
          code: 'yaml-colon-spacing',
          message: 'YAML mapping values should have a space after ":".',
          line: li + 1,
          column: colon + 1,
        });
      }
    }
  }
  return issues;
}

/** Kiểm tra Python nông: tab/space trộn trong indent + dòng kết thúc bằng ':' thiếu body sẽ do parser thật bắt — chỉ báo trộn indent. */
export function v16CheckPython(content: string): V16LintIssue[] {
  const issues: V16LintIssue[] = [];
  const lines = content.split('\n');
  let sawSpaceIndent = false;
  let sawTabIndent = false;
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!;
    if (line.startsWith(' ')) sawSpaceIndent = true;
    if (line.startsWith('\t')) sawTabIndent = true;
    if (line.trim() === '') continue;
    if (/^[ \t]+/.test(line) && line.trim().length > 0) {
      const indent = line.match(/^[ \t]+/)![0];
      if (indent.includes(' ') && indent.includes('\t')) {
        issues.push({
          severity: 'error',
          code: 'python-mixed-indent',
          message: 'Python indentation mixes tabs and spaces on the same line.',
          line: li + 1,
          column: 1,
        });
      }
    }
  }
  if (sawSpaceIndent && sawTabIndent) {
    issues.push({
      severity: 'warning',
      code: 'python-mixed-indent-file',
      message: 'File mixes space-indented and tab-indented lines (Python prefers one style).',
    });
  }
  return issues;
}

/** Kiểm tra chung cho mọi file: ký tự điều khiển lạ, dòng quá dài, file không kết thúc bằng newline (warning). */
export function v16CheckGeneric(content: string): V16LintIssue[] {
  const issues: V16LintIssue[] = [];
  const lines = content.split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!;
    for (let ci = 0; ci < line.length; ci += 1) {
      const code = line.charCodeAt(ci);
      if (code < 0x20 && code !== 0x09) {
        issues.push({
          severity: 'error',
          code: 'control-character',
          message: `Control character U+${code.toString(16).padStart(4, '0')} is not allowed in source files.`,
          line: li + 1,
          column: ci + 1,
        });
        break;
      }
    }
    if (line.length > 500) {
      issues.push({
        severity: 'warning',
        code: 'line-too-long',
        message: `Line is ${line.length} characters (over 500).`,
        line: li + 1,
        column: 501,
      });
    }
  }
  if (content.length > 0 && !content.endsWith('\n')) {
    issues.push({
      severity: 'warning',
      code: 'missing-final-newline',
      message: 'File does not end with a newline.',
    });
  }
  return issues;
}

/** Kiểm tra thẻ HTML/XML đóng mở (nông: chỉ đếm thẻ không tự đóng, bỏ void element). */
export function v16CheckHtmlTags(content: string): V16LintIssue[] {
  const issues: V16LintIssue[] = [];
  const voidElements = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);
  const stack: { tag: string; line: number }[] = [];
  const tagRe = /<\/?([A-Za-z][A-Za-z0-9-]*)[^>]*?(\/?)>/g;
  const lines = content.split('\n');
  const lineOf = (index: number): number => {
    let count = 0;
    for (let li = 0; li < lines.length; li += 1) {
      count += lines[li]!.length + 1;
      if (index < count) return li + 1;
    }
    return lines.length;
  };
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(content)) !== null) {
    const raw = match[0];
    const tag = match[1]!.toLowerCase();
    const selfClosing = match[2] === '/' || raw.endsWith('/>') || voidElements.has(tag);
    if (raw.startsWith('</')) {
      const top = stack[stack.length - 1];
      if (!top) {
        issues.push({
          severity: 'error',
          code: 'html-unmatched-close',
          message: `Closing tag </${tag}> has no matching opener.`,
          line: lineOf(match.index),
        });
      } else if (top.tag !== tag) {
        issues.push({
          severity: 'error',
          code: 'html-mismatched-tag',
          message: `Opened <${top.tag}> at line ${top.line} but closed with </${tag}>.`,
          line: lineOf(match.index),
        });
        stack.pop();
      } else {
        stack.pop();
      }
    } else if (!selfClosing) {
      stack.push({ tag, line: lineOf(match.index) });
    }
  }
  for (const frame of stack) {
    issues.push({
      severity: 'error',
      code: 'html-unclosed-tag',
      message: `Tag <${frame.tag}> opened here is never closed.`,
      line: frame.line,
    });
  }
  return issues;
}

/** Chạy toàn bộ gate cho một nội dung file mới (chưa ghi). */
export function v16LintContent(path: string, content: string): V16LintResult {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new CodingV16Error('lint-parse-failed', 'Lint path must be a non-empty string.');
  }
  if (typeof content !== 'string') {
    throw new CodingV16Error('lint-parse-failed', 'Lint content must be a string.');
  }
  const language = v16LanguageForPath(path);
  const issues: V16LintIssue[] = [];
  issues.push(...v16CheckGeneric(content));
  switch (language) {
    case 'json':
    case 'jsonc':
      issues.push(...v16CheckJson(content, language));
      break;
    case 'yaml':
      issues.push(...v16CheckYaml(content));
      break;
    case 'python':
      issues.push(...v16CheckDelimiters(content, language));
      issues.push(...v16CheckPython(content));
      break;
    case 'html':
    case 'xml':
      issues.push(...v16CheckHtmlTags(content));
      issues.push(...v16CheckDelimiters(content, language));
      break;
    case 'markdown':
    case 'text':
      // Markdown/text: chỉ kiểm tra chung (không ép delimiter).
      break;
    default:
      issues.push(...v16CheckDelimiters(content, language));
      break;
  }
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const blocked = errorCount > 0;
  return {
    path,
    language,
    issues,
    blocked,
    errorCount,
    warningCount,
    summary: blocked
      ? `BLOCKED: ${errorCount} error(s), ${warningCount} warning(s) — file not written.`
      : `OK: ${warningCount} warning(s), 0 errors — safe to write.`,
  };
}

/** Render kết quả linter thành text (danh sách issue có dòng/cột). */
export function renderV16LintResult(result: V16LintResult): string {
  const lines: string[] = [result.summary, `${result.path} (${result.language})`];
  for (const issue of result.issues) {
    const where = issue.line !== undefined ? `line ${issue.line}${issue.column !== undefined ? `:${issue.column}` : ''}` : 'file';
    lines.push(`- [${issue.severity}] ${issue.code} (${where}): ${issue.message}`);
  }
  return lines.join('\n');
}

/** Gate tiện ích: true = được ghi; false = bị chặn (có lỗi error). */
export function v16LintAllowsWrite(path: string, content: string): boolean {
  return !v16LintContent(path, content).blocked;
}
