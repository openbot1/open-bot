/**
 * Parser TS/JS kiểu tree-sitter-lite cho repo map v3 (v1.16, Đội T4).
 *
 * Ý tưởng học từ tree-sitter (survey v1.16 §5): parse theo scope
 * bằng brace thay vì regex từng dòng rời rạc — parser đi qua file một
 * lần, giữ stack scope (class/interface/namespace/function), nhận diện
 * symbol khi gặp từ khóa khai báo ở đầu scope, và ghi call site khi
 * gặp `name(` / `obj.name(` trong thân scope. Không dùng dependency
 * nặng, không dùng tree-sitter WASM: parser tự viết, chỉ dùng regex +
 * quét ký tự, chạy được trên mọi file TS/JS (kể cả file lỗi cú pháp —
 * giữ phần parse được, báo `hasError`).
 *
 * Quy tắc làm sạch trước khi parse:
 * - String/template/comment được "mask" (thay bằng khoảng trắng, giữ
 *   nguyên vị trí dòng/cột) để regex không khớp nhầm code trong chuỗi.
 *   Template literal `${...}` giữ nguyên vì có thể chứa call thật —
 *   parser chấp nhận đếm thừa ở đó, ghi rõ trong giới hạn.
 * - Decorator `@Name` được ghi nhận vào symbol ngay dưới nó.
 *
 * Giới hạn trung thực:
 * - Không phân biệt được method trùng tên ở 2 class khác nhau khi
 *   resolve call `obj.method()` — call ghi theo tên ngắn, graph resolve
 *   theo tên ngắn (giống v2) và báo ambiguous khi trùng nhiều file.
 * - Không parse JSX/TSX chi tiết: component được nhận diện như
 *   function/class thường; JSX tag không tính là call.
 * - Python: chỉ parse mức cơ bản (def/class/import) để repo map không
 *   bỏ sót file .py trong repo mẫu; không parse call Python chi tiết.
 */

import { createHash } from 'node:crypto';
import type { V8CallSite, V8Import, V8Language, V8ParsedFile, V8Symbol, V8SymbolKind } from './types';

/** Số ký tự tối đa giữ trong signature/doc. */
export const V8_PARSER_TEXT_LIMIT = 300;
/** Số lỗi parse tối đa ghi lại mỗi file. */
export const V8_PARSER_MAX_ERRORS = 10;

/** Xác định ngôn ngữ theo đuôi file. */
export function v8LanguageForPath(relPath: string): V8Language {
  if (/\.(ts|tsx|mts|cts)$/.test(relPath)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(relPath)) return 'javascript';
  if (/\.py$/.test(relPath)) return 'python';
  return 'unknown';
}

/** SHA-256 hex của nội dung (dùng cho incremental update). */
export function v8ContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

interface MaskedLine {
  /** Nội dung đã mask (string/comment → khoảng trắng, giữ độ dài). */
  text: string;
  /** Dòng gốc (để trích doc comment). */
  raw: string;
}

/**
 * Mask string/template/comment trong toàn bộ source, giữ nguyên vị
 * trí (độ dài mỗi dòng không đổi) để số dòng/cột khớp với file gốc.
 * Trả về mảng theo dòng. Template `${...}` KHÔNG mask phần trong
 * ${} (có thể chứa call thật) — mask phần text của template thôi.
 */
export function v8MaskSource(content: string): MaskedLine[] {
  const lines = content.split('\n');
  const out: MaskedLine[] = [];
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code';
  let templateExprDepth = 0;
  for (const raw of lines) {
    const chars = raw.split('');
    let i = 0;
    while (i < chars.length) {
      const c = chars[i] ?? '';
      const next = chars[i + 1] ?? '';
      if (state === 'line-comment') {
        chars[i] = ' ';
        i += 1;
        continue;
      }
      if (state === 'block-comment') {
        if (c === '*' && next === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          state = 'code';
        } else {
          chars[i] = ' ';
          i += 1;
        }
        continue;
      }
      if (state === 'single') {
        if (c === '\\') {
          chars[i] = ' ';
          if (i + 1 < chars.length) chars[i + 1] = ' ';
          i += 2;
        } else if (c === "'") {
          chars[i] = ' ';
          i += 1;
          state = 'code';
        } else {
          chars[i] = ' ';
          i += 1;
        }
        continue;
      }
      if (state === 'double') {
        if (c === '\\') {
          chars[i] = ' ';
          if (i + 1 < chars.length) chars[i + 1] = ' ';
          i += 2;
        } else if (c === '"') {
          chars[i] = ' ';
          i += 1;
          state = 'code';
        } else {
          chars[i] = ' ';
          i += 1;
        }
        continue;
      }
      if (state === 'template') {
        if (c === '\\') {
          chars[i] = ' ';
          if (i + 1 < chars.length) chars[i + 1] = ' ';
          i += 2;
        } else if (c === '`') {
          chars[i] = ' ';
          i += 1;
          state = 'code';
        } else if (c === '$' && next === '{') {
          // Giữ `${...}` nguyên để call bên trong vẫn parse được.
          i += 2;
          templateExprDepth = 1;
          // Quét tới `}` tương ứng (không mask).
          while (i < chars.length && templateExprDepth > 0) {
            if (chars[i] === '{') templateExprDepth += 1;
            if (chars[i] === '}') templateExprDepth -= 1;
            i += 1;
          }
        } else {
          chars[i] = ' ';
          i += 1;
        }
        continue;
      }
      // state === 'code'
      if (c === '/' && next === '/') {
        state = 'line-comment';
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      } else if (c === '/' && next === '*') {
        state = 'block-comment';
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      } else if (c === "'") {
        state = 'single';
        chars[i] = ' ';
        i += 1;
      } else if (c === '"') {
        state = 'double';
        chars[i] = ' ';
        i += 1;
      } else if (c === '`') {
        state = 'template';
        chars[i] = ' ';
        i += 1;
      } else {
        i += 1;
      }
    }
    if (state === 'line-comment') state = 'code';
    out.push({ text: chars.join(''), raw });
  }
  return out;
}

interface ScopeFrame {
  /** Tên scope, vd `Foo` (class) / `save` (function) / '' (top-level). */
  name: string;
  kind: V8SymbolKind | 'block';
  /** Depth brace khi mở scope. */
  braceDepth: number;
  /** Symbol của scope (để cập nhật endLine). */
  symbolIndex: number;
  /** true = scope này được export (method/property trong class export cũng coi là export). */
  exported: boolean;
}

const TS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'new',
  'typeof', 'instanceof', 'in', 'of', 'await', 'yield', 'throw', 'try',
  'catch', 'finally', 'void', 'delete', 'this', 'super', 'import', 'export',
  'from', 'as', 'function', 'class', 'interface', 'type', 'enum', 'const',
  'let', 'var', 'extends', 'implements', 'static', 'public', 'private',
  'protected', 'readonly', 'abstract', 'async', 'get', 'set', 'namespace',
  'module', 'declare', 'default', 'true', 'false', 'null', 'undefined',
  'break', 'continue', 'debugger',
]);

/** Regex nhận diện khai báo (áp dụng trên dòng đã mask). */
const DECL_PATTERNS: Array<{
  kind: V8SymbolKind;
  re: RegExp;
  nameGroup: number;
}> = [
  // class Foo / abstract class Foo / export class Foo
  { kind: 'class', re: /(?:^|[{\s;])\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
  // interface Foo / type Foo = ...
  { kind: 'interface', re: /(?:^|[{\s;])\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
  { kind: 'type', re: /(?:^|[{\s;])\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/, nameGroup: 1 },
  { kind: 'enum', re: /(?:^|[{\s;])\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
  // namespace Foo / module Foo
  { kind: 'namespace', re: /(?:^|[{\s;])\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
  // function foo(...) / async function foo / export function foo / function* foo
  { kind: 'function', re: /(?:^|[{\s;])\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, nameGroup: 1 },
  // const foo = (x) => / const foo = async (x) => / const foo: Type = function
  { kind: 'variable', re: /(?:^|[{\s;])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/, nameGroup: 1 },
];

/** Regex method trong class: `  name(...) {` / `async name(...)` / `static name(` / `get name(`. */
const METHOD_RE = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|abstract\s+|get\s+|set\s+)*(?:#)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;{}]*\)\s*(?::[^{]+)?\{/;
/** Regex property trong class/interface: `  name: Type;` / `  name = ...`. */
const PROPERTY_RE = /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+)?([A-Za-z_$][\w$]*)\s*[?:]\s*[^=({]+[;,]/;

/** Regex import: `import ... from '...'` / `import '...'` / `require('...')`. */
const IMPORT_FROM_RE = /import\s+(?:type\s+)?(?:([^'";]+?)\s+from\s+)?['"]([^'"]+)['"]/g;
const IMPORT_SIDE_RE = /import\s+['"]([^'"]+)['"]/g;
const REQUIRE_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Regex call: `name(` hoặc `obj.name(` hoặc `obj?.name(`. */
const CALL_RE = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\(|([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\(/g;

function clip(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= V8_PARSER_TEXT_LIMIT ? single : `${single.slice(0, V8_PARSER_TEXT_LIMIT)}…`;
}

/** Tách tham số từ chuỗi trong `(...)` → [{name, type}]. */
export function v8ParseParams(paramText: string): Array<{ name: string; type?: string }> {
  const out: Array<{ name: string; type?: string }> = [];
  const trimmed = paramText.trim();
  if (!trimmed) return out;
  // Tách theo dấu phẩy ở depth 0 (bỏ qua generic / default có dấu phẩy).
  let depth = 0;
  let current = '';
  const parts: string[] = [];
  for (const ch of trimmed) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  for (const part of parts) {
    const p = part.trim().replace(/^\.{3}/, '').replace(/[?=].*$/, '').trim();
    if (!p) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*(.+))?$/.exec(p);
    if (m) out.push({ name: m[1] ?? p, type: m[2]?.trim() });
    else out.push({ name: p });
  }
  return out;
}

/** Lấy danh sách tham số + kiểu trả về từ phần sau tên hàm trong dòng. */
function parseSignatureTail(text: string, nameEnd: number): { params: Array<{ name: string; type?: string }>; returnType?: string; signature: string } {
  const rest = text.slice(nameEnd);
  const open = rest.indexOf('(');
  if (open === -1) return { params: [], signature: clip(text) };
  let depth = 0;
  let close = -1;
  for (let i = open; i < rest.length; i += 1) {
    if (rest[i] === '(') depth += 1;
    if (rest[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return { params: [], signature: clip(text) };
  const params = v8ParseParams(rest.slice(open + 1, close));
  const after = rest.slice(close + 1);
  const ret = /^\s*:\s*([A-Za-z_$][\w$.<>\[\]|& ]+?)(?:\s*\{|\s*=>|\s*$)/.exec(after);
  return { params, returnType: ret?.[1]?.trim(), signature: clip(text) };
}

/** Gom doc comment (JSDoc /** ... *\/) ngay trên dòng khai báo. */
function collectDoc(rawLines: string[], lineIndex: number): string | undefined {
  let j = lineIndex - 1;
  const parts: string[] = [];
  while (j >= 0 && parts.length < 12) {
    const raw = (rawLines[j] ?? '').trim();
    if (raw.startsWith('*/')) {
      j -= 1;
      continue;
    }
    if (raw.startsWith('*')) {
      parts.unshift(raw.replace(/^\*\s?/, ''));
      j -= 1;
      continue;
    }
    if (raw.startsWith('/**')) {
      parts.unshift(raw.replace(/^\/\*\*\s?/, ''));
      break;
    }
    break;
  }
  const doc = parts.join(' ').replace(/\s+/g, ' ').trim();
  return doc ? clip(doc) : undefined;
}

/** Đếm số `{` trừ `}` trong text đã mask (bỏ qua generic `<...>`). */
function braceDelta(text: string): number {
  let delta = 0;
  for (const ch of text) {
    if (ch === '{') delta += 1;
    if (ch === '}') delta -= 1;
  }
  return delta;
}

/** Resolve specifier tương đối thành path repo-relative (hoặc null). */
export function v8ResolveImport(fromRelPath: string, specifier: string, knownFiles: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null; // package ngoài / node: / alias
  const fromDir = fromRelPath.split('/').slice(0, -1).join('/');
  const parts: string[] = [];
  for (const seg of `${fromDir}/${specifier}`.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const base = parts.join('/');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  return null;
}

/** Parse một file TS/JS. */
export function v8ParseTypeScript(relPath: string, content: string, knownFiles: ReadonlySet<string> = new Set()): V8ParsedFile {
  const masked = v8MaskSource(content);
  const rawLines = content.split('\n');
  const symbols: V8Symbol[] = [];
  const calls: V8CallSite[] = [];
  const imports: V8Import[] = [];
  const parseErrors: string[] = [];
  const language: V8Language = v8LanguageForPath(relPath);
  let braceDepth = 0;
  const scopes: ScopeFrame[] = [{ name: '', kind: 'block', braceDepth: 0, symbolIndex: -1, exported: false }];
  let pendingDecorator = '';
  let lastExportLine = -1;

  const currentQualified = (): string =>
    scopes
      .filter((s) => s.name)
      .map((s) => s.name)
      .join('.');

  const pushSymbol = (kind: V8SymbolKind, name: string, lineNo: number, colNo: number, signatureText: string, nameEnd: number): number => {
    const scopePrefix = currentQualified();
    const qualifiedName = scopePrefix ? `${scopePrefix}.${name}` : name;
    const { params, returnType, signature } = kind === 'function' || kind === 'method'
      ? parseSignatureTail(signatureText, nameEnd)
      : { params: [] as Array<{ name: string; type?: string }>, returnType: undefined, signature: clip(signatureText) };
    const exported = /^\s*(?:export\s+)/.test(masked[lineNo - 1]?.text ?? '') || lastExportLine === lineNo
      // Method/property trong class export cũng coi là export.
      || ((kind === 'method' || kind === 'property') && scopes.some((s) => s.kind === 'class' && s.exported));
    const isAsync = /\basync\b/.test(signatureText.slice(0, nameEnd + 10));
    const idx = symbols.length;
    symbols.push({
      kind,
      name,
      qualifiedName,
      line: lineNo,
      column: colNo,
      endLine: 0,
      exported,
      async: isAsync,
      signature,
      params,
      returnType,
      doc: collectDoc(rawLines, lineNo - 1),
    });
    void pendingDecorator;
    return idx;
  };

  for (let li = 0; li < masked.length; li += 1) {
    const lineNo = li + 1;
    const text = masked[li]?.text ?? '';
    const trimmed = text.trim();
    if (!trimmed) continue;
    const depthBefore = braceDepth;

    // --- Import (chạy trên dòng GỐC: dòng đã mask mất dấu quote nên regex import không khớp) ---
    const rawText = rawLines[li] ?? '';
    if (trimmed.startsWith('import ') || trimmed.includes(' require(')) {
      let m: RegExpExecArray | null;
      IMPORT_FROM_RE.lastIndex = 0;
      while ((m = IMPORT_FROM_RE.exec(rawText)) !== null) {
        const namesRaw = (m[1] ?? '').trim();
        const names = namesRaw
          ? namesRaw
              .replace(/[{}]/g, '')
              .split(',')
              .map((s) => s.trim().split(/\s+as\s+/).pop() ?? '')
              .filter(Boolean)
          : [];
        imports.push({
          specifier: m[2] ?? '',
          resolved: v8ResolveImport(relPath, m[2] ?? '', knownFiles),
          names,
          line: lineNo,
        });
      }
      IMPORT_SIDE_RE.lastIndex = 0;
      while ((m = IMPORT_SIDE_RE.exec(rawText)) !== null) {
        imports.push({ specifier: m[1] ?? '', resolved: v8ResolveImport(relPath, m[1] ?? '', knownFiles), names: [], line: lineNo });
      }
      REQUIRE_RE.lastIndex = 0;
      while ((m = REQUIRE_RE.exec(rawText)) !== null) {
        imports.push({ specifier: m[2] ?? '', resolved: v8ResolveImport(relPath, m[2] ?? '', knownFiles), names: [m[1] ?? ''], line: lineNo });
      }
    }

    // --- Decorator: ghi nhớ để gắn vào symbol sau (hiện chỉ giữ tên) ---
    if (trimmed.startsWith('@')) {
      pendingDecorator = trimmed;
    }

    // --- Khai báo class/interface/type/enum/namespace/function/variable ---
    let declaredIdx = -1;
    let declaredKind: V8SymbolKind | null = null;
    for (const pat of DECL_PATTERNS) {
      const m = pat.re.exec(text);
      if (m && m[pat.nameGroup]) {
        const name = m[pat.nameGroup] as string;
        const nameStart = text.indexOf(name, m.index);
        const nameEnd = nameStart + name.length;
        declaredIdx = pushSymbol(pat.kind, name, lineNo, nameStart + 1, text, nameEnd);
        declaredKind = pat.kind;
        break;
      }
    }

    // --- Method / property trong class (khi scope hiện tại là class) ---
    if (declaredIdx === -1) {
      const top = scopes[scopes.length - 1];
      if (top && top.kind === 'class') {
        const mm = METHOD_RE.exec(text);
        if (mm && mm[1] && !TS_KEYWORDS.has(mm[1])) {
          const name = mm[1] as string;
          const nameStart = text.indexOf(name);
          declaredIdx = pushSymbol('method', name, lineNo, nameStart + 1, text, nameStart + name.length);
          declaredKind = 'method';
        } else {
          const pm = PROPERTY_RE.exec(text);
          if (pm && pm[1] && !TS_KEYWORDS.has(pm[1])) {
            const name = pm[1] as string;
            const nameStart = text.indexOf(name);
            declaredIdx = pushSymbol('property', name, lineNo, nameStart + 1, text, nameStart + name.length);
            declaredKind = 'property';
          }
        }
      }
    }

    // --- Call sites trong dòng (bỏ qua dòng khai báo function/class để tránh tự gọi) ---
    const isDeclLine = declaredIdx !== -1 && (declaredKind === 'function' || declaredKind === 'class');
    if (!isDeclLine) {
      CALL_RE.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = CALL_RE.exec(text)) !== null) {
        if (cm[2] && cm[3]) {
          // obj.method(
          calls.push({ caller: currentQualified(), calleeName: cm[3] as string, line: lineNo, memberCall: true });
        } else if (cm[1]) {
          const name = cm[1] as string;
          if (TS_KEYWORDS.has(name)) continue;
          // Bỏ `if (` / `for (` / `while (` / `switch (` / `return (` đã lọc keyword; còn `function name(` đã loại ở trên.
          calls.push({ caller: currentQualified(), calleeName: name, line: lineNo, memberCall: false });
        }
      }
    }

    // --- Cập nhật scope theo brace ---
    const delta = braceDelta(text);
    if (declaredIdx !== -1 && (declaredKind === 'class' || declaredKind === 'interface' || declaredKind === 'namespace' || declaredKind === 'function' || declaredKind === 'method') && delta > 0) {
      scopes.push({
        name: symbols[declaredIdx]?.name ?? '',
        kind: declaredKind,
        braceDepth: depthBefore + delta,
        symbolIndex: declaredIdx,
        exported: symbols[declaredIdx]?.exported ?? false,
      });
    }
    braceDepth += delta;
    if (braceDepth < 0) {
      parseErrors.push(`line ${lineNo}: unbalanced closing brace (depth ${braceDepth})`);
      braceDepth = 0;
    }
    // Đóng scope khi braceDepth về <= depth mở scope.
    while (scopes.length > 1) {
      const top = scopes[scopes.length - 1];
      if (!top) break;
      if (braceDepth < top.braceDepth) {
        if (top.symbolIndex >= 0 && symbols[top.symbolIndex]) {
          symbols[top.symbolIndex].endLine = lineNo;
        }
        scopes.pop();
      } else break;
    }
    if (trimmed.startsWith('export ')) lastExportLine = lineNo;
    if (pendingDecorator && declaredIdx === -1) pendingDecorator = '';
  }

  // Symbol chưa đóng scope → endLine = dòng cuối.
  for (const s of symbols) {
    if (s.endLine === 0) s.endLine = masked.length;
  }
  const hasError = parseErrors.length > 0 || braceDepth !== 0;
  if (braceDepth !== 0 && parseErrors.length < V8_PARSER_MAX_ERRORS) {
    parseErrors.push(`unbalanced braces at end of file (depth ${braceDepth})`);
  }

  return {
    relPath,
    language,
    contentHash: v8ContentHash(content),
    size: Buffer.byteLength(content, 'utf8'),
    symbols,
    calls,
    imports,
    hasError,
    parseErrors: parseErrors.slice(0, V8_PARSER_MAX_ERRORS),
  };
}

/** Parse một file Python ở mức cơ bản (def/class/import). */
export function v8ParsePython(relPath: string, content: string, knownFiles: ReadonlySet<string> = new Set()): V8ParsedFile {
  const lines = content.split('\n');
  const symbols: V8Symbol[] = [];
  const calls: V8CallSite[] = [];
  const imports: V8Import[] = [];
  const parseErrors: string[] = [];
  let indentStack: Array<{ name: string; indent: number }> = [];
  for (let li = 0; li < lines.length; li += 1) {
    const raw = lines[li] ?? '';
    const lineNo = li + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    while (indentStack.length > 0 && (indentStack[indentStack.length - 1]?.indent ?? 0) >= indent) {
      indentStack.pop();
    }
    const defM = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(trimmed);
    const classM = /^class\s+([A-Za-z_]\w*)\s*(?:\(|:)/.exec(trimmed);
    const impM = /^(?:from\s+(\S+)\s+import\s+(.+)|import\s+(.+))$/.exec(trimmed);
    if (classM) {
      const name = classM[1] as string;
      const qualified = [...indentStack.map((s) => s.name), name].join('.');
      symbols.push({ kind: 'class', name, qualifiedName: qualified, line: lineNo, column: raw.indexOf(name) + 1, endLine: lineNo, exported: true, async: false, signature: trimmed, params: [], doc: undefined });
      indentStack.push({ name, indent });
    } else if (defM) {
      const name = defM[1] as string;
      const isMethod = indentStack.length > 0;
      const qualified = [...indentStack.map((s) => s.name), name].join('.');
      const params = v8ParseParams(defM[2] ?? '').map((p) => ({ name: p.name }));
      symbols.push({ kind: isMethod ? 'method' : 'function', name, qualifiedName: qualified, line: lineNo, column: raw.indexOf(name) + 1, endLine: lineNo, exported: !isMethod, async: trimmed.startsWith('async'), signature: trimmed, params, doc: undefined });
      indentStack.push({ name, indent });
    } else if (impM) {
      const spec = impM[1] ?? impM[3] ?? '';
      imports.push({ specifier: spec.trim(), resolved: v8ResolveImport(relPath, spec.trim().replace(/\./g, '/'), knownFiles), names: [], line: lineNo });
    } else {
      // Call site Python đơn giản: `name(` ở đầu câu lệnh.
      const callM = /^([A-Za-z_]\w*)\s*\(/.exec(trimmed);
      if (callM && !['if', 'for', 'while', 'return', 'print'].includes(callM[1] as string)) {
        calls.push({ caller: indentStack.map((s) => s.name).join('.'), calleeName: callM[1] as string, line: lineNo, memberCall: false });
      }
    }
  }
  // endLine: dòng trước symbol tiếp theo cùng cấp (ước lượng đơn giản).
  for (let i = 0; i < symbols.length; i += 1) {
    const s = symbols[i];
    const next = symbols[i + 1];
    if (s) s.endLine = next ? next.line - 1 : lines.length;
  }
  return {
    relPath,
    language: 'python',
    contentHash: v8ContentHash(content),
    size: Buffer.byteLength(content, 'utf8'),
    symbols,
    calls,
    imports,
    hasError: false,
    parseErrors,
  };
}

/** Parse một file bất kỳ theo ngôn ngữ (unknown → entry rỗng, không lỗi). */
export function v8ParseFile(relPath: string, content: string, knownFiles: ReadonlySet<string> = new Set()): V8ParsedFile {
  const language = v8LanguageForPath(relPath);
  if (language === 'python') return v8ParsePython(relPath, content, knownFiles);
  if (language === 'typescript' || language === 'javascript') return v8ParseTypeScript(relPath, content, knownFiles);
  return {
    relPath,
    language: 'unknown',
    contentHash: v8ContentHash(content),
    size: Buffer.byteLength(content, 'utf8'),
    symbols: [],
    calls: [],
    imports: [],
    hasError: false,
    parseErrors: [],
  };
}
