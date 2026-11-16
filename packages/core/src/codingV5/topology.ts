/**
 * Repo map v5 — symbol topology (v1.13, Doi T3).
 *
 * Y tuong hoc tu OpenHands Repository Map (chi hoc y tuong, tu thiet
 * ke va viet lai hoan toan tu dau — KHONG doc, KHONG copy code/text/
 * tai san cua bat ky repo nao, cua xAI/Cursor).
 *
 * Lop nay mo rong repo map v2/v3/v4 cua open-bot (`codingV2` do thi
 * symbol-level + PageRank, `codingV3` call edges + module graph,
 * `codingV4` PageRank v2 + weighted map + cache invalidation):
 *
 *   - v2 biet symbol nao duoc dinh nghia o dau va file nao nhac ten
 *     no, nhung KHONG biet symbol nao duoc export (public API cua
 *     file), import nao la type-only / dynamic / re-export, va
 *     caller that su cua mot symbol la ai (chi co "file A nhac ten
 *     symbol cua file B", khong co "ham f trong A goi ham g o dong
 *     nao").
 *   - v5 them topology o muc do chinh xac hon mot bac: export map
 *     (named/default/namespace/re-export), import map (static /
 *     dynamic / type-only / require, ke ca alias), call site
 *     (caller -> callee, kem dong goi) suy tu source, va cac chi so
 *     do thi suy tu topology do: fan-in/fan-out, hub, file mo coi,
 *     chu trinh import.
 *
 * Module nay thuan tuy (khong fs, khong tree-sitter): dinh nghia
 * symbol lay tu entry v2 da parse (`CodingV2FileEntry` — tree-sitter
 * la nguon that cho dinh nghia), con export/import/call site trich
 * bang regex tren source text (re hon v2 o cho: v2 chi co import
 * specifier tho va dem ident; o day trich ca ten import, alias,
 * re-export va vi tri goi ham). Lop fs (doc source tu dia) song o
 * `packages/tools/src/codingV5RepoMap.ts`.
 *
 * Gioi han trung thuc (ghi ca trong mo ta tool):
 *   - call site trich bang regex tren dong source sau khi cat bo
 *     string/comment don gian: goi ham trong template literal phuc
 *     tap, goi qua bien trung gian (`const f = g; f()`), goi dong
 *     (`obj[method]()`) hoac goi ham tra ve tu ham khac khong nhan
 *     duoc; callee chi khop theo ten ngan (giong v2) nen ten mo ho
 *     (dinh nghia o nhieu file) duoc danh dau `ambiguous` thay vi
 *     doan bua mot file.
 *   - export/import cua Python chi o muc co ban (`import`/`from`
 *     / `__all__`); khong phan tich `importlib` dong.
 *   - chu trinh chi tinh tren import tinh (static + re-export),
 *     khong tinh import dong (`import()`/`require()` trong ham).
 */

import type {
  CodingV2FileEntry,
  CodingV2Graph,
  CodingV2SymbolEntry,
} from '../codingV2/repoMapGraph';

/** Version cua dinh dang cache topology v5 tren dia. */
export const CODING_V5_CACHE_VERSION = 5;
/** So ky tu uoc tinh = 1 token khi render (giong v3/v4). */
export const CODING_V5_CHARS_PER_TOKEN = 4;
/** Tran call site giu trong mot topology (chong blow-up). */
export const CODING_V5_MAX_CALL_SITES = 200_000;
/** Tran export/import giu trong mot topology. */
export const CODING_V5_MAX_EDGES = 200_000;

// ---------------------------------------------------------------------------
// Kieu du lieu
// ---------------------------------------------------------------------------

/** Loai export: named / default / namespace (`export * as ns`) / re-export. */
export type CodingV5ExportKind = 'named' | 'default' | 'namespace' | 're-export';

/** Mot export cua mot file. */
export interface CodingV5Export {
  /** Ten export nhin tu ben ngoai (`default` cho export mac dinh). */
  name: string;
  /** Ten cuc bo trong file (khi `export { local as name }`). */
  localName: string;
  kind: CodingV5ExportKind;
  /** File nguon khi la re-export (`export { x } from './y'`). */
  reExportFrom: string | null;
  /** Dong khai bao export, 1-based. */
  line: number;
  /** Symbol dinh nghia ten cuc bo nay khong (theo entry v2). */
  definedLocally: boolean;
}

/** Loai import: static / dynamic (`import()`) / type-only / require / python. */
export type CodingV5ImportKind = 'static' | 'dynamic' | 'type' | 'require' | 'python';

/** Mot import cua mot file (da resolve ve file trong repo khi duoc). */
export interface CodingV5Import {
  /** Specifier tho (`./foo`, `react`, `.foo` cua Python...). */
  specifier: string;
  /** File dich trong repo (duong dan repo-relative), null khi o ngoai repo. */
  resolved: string | null;
  kind: CodingV5ImportKind;
  /** Ten duoc import (`{ a, b as c }`, `* as ns`, default...). */
  importedNames: string[];
  /** Dong import, 1-based. */
  line: number;
  /** true khi specifier la bare (`react`, `os`) — ngoai repo. */
  external: boolean;
}

/** Loai call site: goi truc tiep / goi method / goi constructor. */
export type CodingV5CallKind = 'call' | 'method' | 'new';

/** Mot diem goi ham trong source. */
export interface CodingV5CallSite {
  /** File chua diem goi (repo-relative). */
  file: string;
  /** Dong goi, 1-based. */
  line: number;
  /** Cot bat dau cua ten callee, 1-based. */
  column: number;
  /** Ten ngan cua callee (`save`, `run`). */
  callee: string;
  /** Ten day du khi goi method (`obj.save` -> `save`, giu `obj` o day). */
  calleeQualified: string;
  /** Ham/class chua diem goi (qualifiedName), '' khi o muc top-level. */
  caller: string;
  kind: CodingV5CallKind;
  /** File dinh nghia callee (khop theo ten ngan), null khi khong tim thay. */
  resolvedFile: string | null;
  /** Ten day du cua callee khi resolve duoc, null khi khong. */
  resolvedQualified: string | null;
  /** true khi ten callee dinh nghia o > 1 file (khong doan bua). */
  ambiguous: boolean;
}

/** Chi so fan-in/fan-out cua mot file hoac mot symbol. */
export interface CodingV5Fan {
  /** So file/symbol khac tro toi node nay. */
  fanIn: number;
  /** So file/symbol khac node nay tro toi. */
  fanOut: number;
  /** Danh sach file tro toi (toi da, da sap xep). */
  importedBy: string[];
  /** Danh sach file node nay tro toi. */
  imports: string[];
}

/** Mot chu trinh import (danh sach file, kheo kin). */
export interface CodingV5ImportCycle {
  /** File trong chu trinh theo thu tu import. */
  files: string[];
  /** Do dai chu trinh. */
  length: number;
}

/** Topology day du cua mot repo (hoac mot tap file). */
export interface CodingV5Topology {
  /** Export theo file: relPath -> export[]. */
  exportsByFile: Map<string, CodingV5Export[]>;
  /** Import theo file: relPath -> import[]. */
  importsByFile: Map<string, CodingV5Import[]>;
  /** Moi call site trich duoc. */
  callSites: CodingV5CallSite[];
  /** Fan-in/fan-out theo file. */
  fileFan: Map<string, CodingV5Fan>;
  /** Fan-in/fan-out theo symbol (key `file#qualifiedName`). */
  symbolFan: Map<string, CodingV5Fan>;
  /** Chu trinh import tinh. */
  cycles: CodingV5ImportCycle[];
  /** File khong ai import va khong import ai (chi tinh trong tap file). */
  orphans: string[];
  stats: CodingV5TopologyStats;
}

export interface CodingV5TopologyStats {
  files: number;
  symbols: number;
  exports: number;
  /** Export co `definedLocally = true` (noi duoc voi symbol that). */
  exportsLinked: number;
  imports: number;
  /** Import resolve duoc ve file trong repo. */
  importsResolved: number;
  /** Import bare (ngoai repo). */
  importsExternal: number;
  /** Import type-only. */
  importsTypeOnly: number;
  /** Import dong (`import()` / `require()` trong code). */
  importsDynamic: number;
  callSites: number;
  /** Call site resolve duoc ve mot dinh nghia duy nhat. */
  callsResolved: number;
  /** Call site mo ho (ten dinh nghia o > 1 file). */
  callsAmbiguous: number;
  /** Call site khong tim thay dinh nghia (ham ngoai repo / global). */
  callsUnresolved: number;
  cycles: number;
  orphans: number;
  /** Call site bi luoc vi vuot tran. */
  callSitesTruncated: number;
}

// ---------------------------------------------------------------------------
// Tien ich text
// ---------------------------------------------------------------------------

/** Cat bo string literal don gian + comment `//` tren mot dong. */
export function codingV5StripLine(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const V5_KEYWORD_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'class', 'new', 'delete', 'void', 'await', 'yield', 'super', 'import',
  'export', 'require', 'console', 'print', 'def', 'elif', 'except',
]);

/** true khi ten khong phai tu khoa / ten ham duoc goi that. */
export function codingV5IsCallableName(name: string): boolean {
  return name.length > 0 && !V5_KEYWORD_CALLS.has(name);
}

/**
 * Tim symbol chua mot dong (symbol co khoang [line, endLine] nho
 * nhat chua dong do). Tra qualifiedName, '' khi o top-level.
 */
export function codingV5EnclosingSymbol(
  symbols: CodingV2SymbolEntry[],
  line: number,
): string {
  let best: CodingV2SymbolEntry | null = null;
  for (const s of symbols) {
    if (line < s.line || line > s.endLine) continue;
    if (best === null || s.endLine - s.line < best.endLine - best.line) best = s;
  }
  return best?.qualifiedName ?? '';
}

// ---------------------------------------------------------------------------
// Trich export
// ---------------------------------------------------------------------------

/**
 * Trich export tu source cua mot file. Dinh nghia symbol (entry v2)
 * dung de danh dau `definedLocally`. Python: moi `def`/`class` cap
 * module + ten trong `__all__` duoc coi la export (mo hinh don gian,
 * ghi ro trong gioi han).
 */
export function extractCodingV5Exports(
  source: string,
  language: string,
  symbols: CodingV2SymbolEntry[],
): CodingV5Export[] {
  const defined = new Set(symbols.map((s) => s.name));
  for (const s of symbols) defined.add(s.qualifiedName);
  const out: CodingV5Export[] = [];
  const push = (
    name: string,
    localName: string,
    kind: CodingV5ExportKind,
    reExportFrom: string | null,
    line: number,
  ): void => {
    if (out.length >= CODING_V5_MAX_EDGES) return;
    out.push({
      name,
      localName,
      kind,
      reExportFrom,
      line,
      definedLocally: defined.has(localName),
    });
  };
  const lines = source.split('\n');
  if (language === 'python') {
    const allRe = /__all__\s*=\s*\[([^\]]*)\]/;
    const allMatch = allRe.exec(source);
    if (allMatch) {
      const names = [...allMatch[1]!.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)].map((m) => m[1]!);
      const lineNo = source.slice(0, allMatch.index).split('\n').length;
      for (const n of names) push(n, n, 'named', null, lineNo);
      return out;
    }
    lines.forEach((raw, idx) => {
      const trimmed = raw.trim();
      const m = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
      if (m && !raw.startsWith(' ') && !raw.startsWith('\t')) {
        push(m[1]!, m[1]!, 'named', null, idx + 1);
      }
    });
    return out;
  }
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    let m: RegExpExecArray | null;
    // export * as ns from './x'
    m = /^export\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/.exec(trimmed);
    if (m) {
      push(m[1]!, m[1]!, 'namespace', m[2]!, lineNo);
      return;
    }
    // export * from './x'
    m = /^export\s+\*\s+from\s+['"]([^'"]+)['"]/.exec(trimmed);
    if (m) {
      push('*', '*', 're-export', m[2]!, lineNo);
      return;
    }
    // export { a, b as c } [from './x']
    m = /^export\s*\{([^}]*)\}\s*(?:from\s+['"]([^'"]+)['"])?/.exec(trimmed);
    if (m) {
      const from = m[2] ?? null;
      for (const part of m[1]!.split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const asMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(piece);
        if (asMatch) push(asMatch[2]!, asMatch[1]!, from ? 're-export' : 'named', from, lineNo);
        else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(piece)) {
          push(piece, piece, from ? 're-export' : 'named', from, lineNo);
        }
      }
      return;
    }
    // export default function/class/identifier/expression
    m = /^export\s+default\s+(?:(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)|(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)|([A-Za-z_$][A-Za-z0-9_$]*))/.exec(trimmed);
    if (m) {
      const local = m[1] ?? m[2] ?? m[3] ?? 'default';
      push('default', local, 'default', null, lineNo);
      return;
    }
    // export function/class/interface/type/enum/const ...
    m = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s*|(?:abstract\s+)?class\s+|interface\s+|type\s+|enum\s+|const\s+|let\s+|var\s+)([A-Za-z_$][A-Za-z0-9_$]*)/.exec(trimmed);
    if (m) push(m[1]!, m[1]!, 'named', null, lineNo);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Trich import
// ---------------------------------------------------------------------------

/**
 * Trich import tu source cua mot file. `resolve` (neu co) chuyen
 * specifier tuong doi thanh duong dan repo-relative; khong co thi
 * `resolved = null` (lop fs truyen resolver cua v2 vao).
 */
export function extractCodingV5Imports(
  source: string,
  language: string,
  resolve?: (specifier: string) => string | null,
): CodingV5Import[] {
  const out: CodingV5Import[] = [];
  const push = (
    specifier: string,
    kind: CodingV5ImportKind,
    importedNames: string[],
    line: number,
  ): void => {
    if (out.length >= CODING_V5_MAX_EDGES) return;
    const external = !specifier.startsWith('.');
    const resolved = external ? null : (resolve?.(specifier) ?? null);
    out.push({ specifier, resolved, kind, importedNames, line, external });
  };
  const lines = source.split('\n');
  if (language === 'python') {
    lines.forEach((raw, idx) => {
      const lineNo = idx + 1;
      const trimmed = raw.trim();
      if (trimmed.startsWith('#')) return;
      let m: RegExpExecArray | null;
      m = /^from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*)\s+import\s+(.+)$/.exec(trimmed);
      if (m) {
        const names = m[2]!
          .split(',')
          .map((p) => p.trim().split(/\s+/)[0] ?? '')
          .filter((n) => n !== '' && n !== '*');
        push(m[1]!, 'python', names, lineNo);
        return;
      }
      m = /^import\s+([A-Za-z_][A-Za-z0-9_.,\s]*)$/.exec(trimmed);
      if (m) {
        for (const part of m[1]!.split(',')) {
          const name = part.trim().split(/\s+/)[0];
          if (name) push(name, 'python', [name], lineNo);
        }
      }
    });
    return out;
  }
  const importRe =
    /^import\s+(type\s+)?((?:[A-Za-z_$][A-Za-z0-9_$]*|\*\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*|\{[^}]*\})(?:\s*,\s*(?:[A-Za-z_$][A-Za-z0-9_$]*|\{[^}]*\}))?)\s+from\s+['"]([^'"]+)['"]/;
  const sideEffectRe = /^import\s+['"]([^'"]+)['"]/;
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    let m: RegExpExecArray | null;
    m = importRe.exec(trimmed);
    if (m) {
      const names: string[] = [];
      const clause = m[2]!;
      for (const nm of clause.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
        if (nm[1] !== 'as') names.push(nm[1]!);
      }
      push(m[3]!, m[1] ? 'type' : 'static', names, lineNo);
      return;
    }
    m = sideEffectRe.exec(trimmed);
    if (m) {
      push(m[1]!, 'static', [], lineNo);
      return;
    }
    // export ... from './x' cung la mot import (re-export keo phu thuoc).
    m = /^export\s+(?:\*\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*|\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/.exec(trimmed);
    if (m) {
      push(m[1]!, 'static', [], lineNo);
      return;
    }
    // dynamic import('...') / require('...')
    for (const dyn of trimmed.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      push(dyn[1]!, 'dynamic', [], lineNo);
    }
    for (const req of trimmed.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      push(req[1]!, 'require', [], lineNo);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Trich call site
// ---------------------------------------------------------------------------

/**
 * Trich call site tu source cua mot file. Caller suy tu symbol chua
 * dong goi (entry v2). Callee resolve theo ten ngan qua chi muc
 * `byShortName` (tu entries); ten dinh nghia o > 1 file -> ambiguous,
 * khong doan bua. Dinh nghia trong chinh file goi thi khong tinh la
 * call site xuyen file (van giu trong danh sach de caller/callee
 * trong cung file dung duoc, `resolvedFile` = file hien tai).
 */
export function extractCodingV5CallSites(
  source: string,
  file: CodingV2FileEntry,
  byShortName: Map<string, Array<{ relPath: string; qualifiedName: string }>>,
): CodingV5CallSite[] {
  const out: CodingV5CallSite[] = [];
  const lines = source.split('\n');
  const callRe =
    /(?:\bnew\s+)?(?:([A-Za-z_$][A-Za-z0-9_$]*)\.)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  lines.forEach((raw, idx) => {
    if (out.length >= CODING_V5_MAX_CALL_SITES) return;
    const lineNo = idx + 1;
    const stripped = codingV5StripLine(raw);
    const trimmed = stripped.trim();
    if (
      trimmed === '' ||
      trimmed.startsWith('import ') ||
      trimmed.startsWith('export ') ||
      trimmed.startsWith('//')
    ) {
      return;
    }
    // Bo dong khai bao ham/class (ten ham xuat hien ke `(` cua tham so).
    if (/^(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*[A-Za-z_$]/.test(trimmed)) return;
    if (/^(export\s+)?(abstract\s+)?class\s+[A-Za-z_$]/.test(trimmed)) return;
    if (/^\s*(?:async\s+)?def\s+[A-Za-z_]/.test(trimmed)) return;
    // Bo dong dinh nghia method (`save(): void {`, `async run() {`):
    // ten method ke `(` cua tham so, khong phai diem goi.
    if (/^(?:(?:public|private|protected|static|async|get|set)\s+)*[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/.test(trimmed)) return;
    callRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(stripped)) !== null) {
      const receiver = m[1];
      const callee = m[2]!;
      if (!codingV5IsCallableName(callee)) continue;
      // Bo `foo(` khi `foo` la tu khoa kieu / kieu du lieu.
      if (receiver === undefined && /^(?:string|number|boolean|void|any|unknown)$/.test(callee)) continue;
      const isNew = /^\s*new\s+/.test(m[0]!);
      const caller = codingV5EnclosingSymbol(file.symbols, lineNo);
      const targets = byShortName.get(callee) ?? [];
      const uniqueFiles = [...new Set(targets.map((t) => t.relPath))];
      let resolvedFile: string | null = null;
      let resolvedQualified: string | null = null;
      let ambiguous = false;
      if (targets.length === 1) {
        resolvedFile = targets[0]!.relPath;
        resolvedQualified = targets[0]!.qualifiedName;
      } else if (targets.length > 1) {
        // Uu tien dinh nghia trong chinh file goi — CHI khi goi tran
        // (khong co receiver): `gamma()` trong file dinh nghia gamma
        // thuong la goi noi bo. Goi method `ns.gamma()` co receiver
        // rieng (vd namespace import tu file khac) thi khong doan.
        const self = receiver === undefined
          ? targets.find((t) => t.relPath === file.relPath)
          : undefined;
        if (self) {
          resolvedFile = self.relPath;
          resolvedQualified = self.qualifiedName;
        } else {
          ambiguous = true;
        }
      }
      out.push({
        file: file.relPath,
        line: lineNo,
        column: m.index + 1,
        callee,
        calleeQualified: receiver ? `${receiver}.${callee}` : callee,
        caller,
        kind: isNew ? 'new' : receiver ? 'method' : 'call',
        resolvedFile,
        resolvedQualified,
        ambiguous,
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Dung topology
// ---------------------------------------------------------------------------

export interface CodingV5TopologyInput {
  files: CodingV2FileEntry[];
  /** Source text theo file (relPath -> source). File thieu source van co trong topology nhung khong co export/import/call. */
  sources: Map<string, string>;
  /** Resolver specifier tuong doi -> repo-relative (lop fs truyen vao). */
  resolveImport?: (fromFile: string, specifier: string) => string | null;
}

/**
 * Dung topology day du tu entries v2 + source text. Export/import/
 * call site trich tung file; fan-in/out, chu trinh, orphan tinh tu
 * do thi import tinh + call site da resolve.
 */
export function buildCodingV5Topology(input: CodingV5TopologyInput): CodingV5Topology {
  const { files, sources } = input;
  const byShortName = new Map<string, Array<{ relPath: string; qualifiedName: string }>>();
  for (const file of files) {
    for (const s of file.symbols) {
      const list = byShortName.get(s.name) ?? [];
      list.push({ relPath: file.relPath, qualifiedName: s.qualifiedName });
      byShortName.set(s.name, list);
    }
  }
  const exportsByFile = new Map<string, CodingV5Export[]>();
  const importsByFile = new Map<string, CodingV5Import[]>();
  const callSites: CodingV5CallSite[] = [];
  let exportsLinked = 0;
  let importsResolved = 0;
  let importsExternal = 0;
  let importsTypeOnly = 0;
  let importsDynamic = 0;
  let callsResolved = 0;
  let callsAmbiguous = 0;
  let callsUnresolved = 0;
  let callSitesTruncated = 0;
  for (const file of files) {
    const source = sources.get(file.relPath) ?? '';
    const exports = source
      ? extractCodingV5Exports(source, file.language, file.symbols)
      : [];
    exportsByFile.set(file.relPath, exports);
    exportsLinked += exports.filter((e) => e.definedLocally).length;
    const imports = source
      ? extractCodingV5Imports(source, file.language, (spec) =>
          input.resolveImport ? input.resolveImport(file.relPath, spec) : null,
        )
      : [];
    importsByFile.set(file.relPath, imports);
    importsResolved += imports.filter((i) => i.resolved !== null).length;
    importsExternal += imports.filter((i) => i.external).length;
    importsTypeOnly += imports.filter((i) => i.kind === 'type').length;
    importsDynamic += imports.filter((i) => i.kind === 'dynamic' || i.kind === 'require').length;
    if (source) {
      const sites = extractCodingV5CallSites(source, file, byShortName);
      for (const site of sites) {
        if (callSites.length >= CODING_V5_MAX_CALL_SITES) {
          callSitesTruncated += 1;
          continue;
        }
        callSites.push(site);
        if (site.ambiguous) callsAmbiguous += 1;
        else if (site.resolvedFile !== null) callsResolved += 1;
        else callsUnresolved += 1;
      }
    }
  }

  // Fan-in/fan-out theo file (import tinh + re-export).
  const fileFan = new Map<string, CodingV5Fan>();
  for (const file of files) {
    fileFan.set(file.relPath, { fanIn: 0, fanOut: 0, importedBy: [], imports: [] });
  }
  const importPairs = new Set<string>();
  for (const [from, imports] of importsByFile) {
    for (const imp of imports) {
      if (imp.resolved === null || imp.resolved === from) continue;
      const key = `${from}\n${imp.resolved}`;
      if (importPairs.has(key)) continue;
      importPairs.add(key);
      const fromFan = fileFan.get(from);
      const toFan = fileFan.get(imp.resolved);
      if (fromFan && toFan) {
        fromFan.imports.push(imp.resolved);
        toFan.importedBy.push(from);
      }
    }
  }
  for (const fan of fileFan.values()) {
    fan.fanIn = fan.importedBy.length;
    fan.fanOut = fan.imports.length;
    fan.importedBy.sort();
    fan.imports.sort();
  }

  // Fan-in/fan-out theo symbol (call site da resolve).
  const symbolFan = new Map<string, CodingV5Fan>();
  const symbolKey = (relPath: string, qualified: string): string => `${relPath}#${qualified}`;
  for (const file of files) {
    for (const s of file.symbols) {
      symbolFan.set(symbolKey(file.relPath, s.qualifiedName), {
        fanIn: 0,
        fanOut: 0,
        importedBy: [],
        imports: [],
      });
    }
  }
  const symbolPairs = new Set<string>();
  for (const site of callSites) {
    if (site.resolvedFile === null || site.resolvedQualified === null) continue;
    if (site.caller === '') continue; // goi o top-level: khong gan caller symbol.
    const callerFile = site.file;
    const callerKey = symbolKey(callerFile, site.caller);
    const calleeKey = symbolKey(site.resolvedFile, site.resolvedQualified);
    const pairKey = `${callerKey}\n${calleeKey}`;
    if (symbolPairs.has(pairKey)) continue;
    symbolPairs.add(pairKey);
    const callerFan = symbolFan.get(callerKey);
    const calleeFan = symbolFan.get(calleeKey);
    if (callerFan && calleeFan) {
      callerFan.imports.push(calleeKey);
      calleeFan.importedBy.push(callerKey);
    }
  }
  for (const fan of symbolFan.values()) {
    fan.fanIn = fan.importedBy.length;
    fan.fanOut = fan.imports.length;
    fan.importedBy.sort();
    fan.imports.sort();
  }

  const cycles = findCodingV5ImportCycles(importsByFile);
  const orphans: string[] = [];
  for (const [relPath, fan] of fileFan) {
    if (fan.fanIn === 0 && fan.fanOut === 0) orphans.push(relPath);
  }
  orphans.sort();
  const totalSymbols = files.reduce((acc, f) => acc + f.symbols.length, 0);
  const totalExports = [...exportsByFile.values()].reduce((acc, e) => acc + e.length, 0);
  const totalImports = [...importsByFile.values()].reduce((acc, e) => acc + e.length, 0);
  return {
    exportsByFile,
    importsByFile,
    callSites,
    fileFan,
    symbolFan,
    cycles,
    orphans,
    stats: {
      files: files.length,
      symbols: totalSymbols,
      exports: totalExports,
      exportsLinked,
      imports: totalImports,
      importsResolved,
      importsExternal,
      importsTypeOnly,
      importsDynamic,
      callSites: callSites.length,
      callsResolved,
      callsAmbiguous,
      callsUnresolved,
      cycles: cycles.length,
      orphans: orphans.length,
      callSitesTruncated,
    },
  };
}

/**
 * Tim chu trinh trong do thi import tinh (DFS + stack, chuan hoa
 * chu trinh ve dang xoay nho nhat de khong trung lap).
 */
export function findCodingV5ImportCycles(
  importsByFile: Map<string, CodingV5Import[]>,
): CodingV5ImportCycle[] {
  const adj = new Map<string, string[]>();
  for (const [from, imports] of importsByFile) {
    const targets = [...new Set(
      imports.filter((i) => i.resolved !== null && i.resolved !== from).map((i) => i.resolved as string),
    )].sort();
    adj.set(from, targets);
  }
  const cycles = new Map<string, string[]>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const s = state.get(next);
      if (s === 'visiting') {
        const idx = stack.indexOf(next);
        const raw = stack.slice(idx);
        // Chuan hoa: xoay ve file nho nhat theo thu tu alphabet.
        let minIdx = 0;
        for (let i = 1; i < raw.length; i += 1) {
          if (raw[i]! < raw[minIdx]!) minIdx = i;
        }
        const norm = [...raw.slice(minIdx), ...raw.slice(0, minIdx)];
        cycles.set(norm.join('\n'), norm);
      } else if (s === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of [...adj.keys()].sort()) {
    if (state.get(node) === undefined) visit(node);
  }
  return [...cycles.values()]
    .map((files) => ({ files, length: files.length }))
    .sort((a, b) => a.length - b.length || a.files.join().localeCompare(b.files.join()));
}

// ---------------------------------------------------------------------------
// Truy van tren topology
// ---------------------------------------------------------------------------

/** Top file hub: tong fan-in + fan-out cao nhat. */
export function codingV5TopHubs(
  topology: CodingV5Topology,
  limit = 10,
): Array<{ relPath: string; fanIn: number; fanOut: number; total: number }> {
  return [...topology.fileFan.entries()]
    .map(([relPath, fan]) => ({ relPath, fanIn: fan.fanIn, fanOut: fan.fanOut, total: fan.fanIn + fan.fanOut }))
    .sort((a, b) => b.total - a.total || a.relPath.localeCompare(b.relPath))
    .slice(0, Math.max(0, limit));
}

/** Top symbol duoc goi nhieu nhat (fan-in cua symbol). */
export function codingV5TopCalledSymbols(
  topology: CodingV5Topology,
  limit = 10,
): Array<{ key: string; file: string; qualifiedName: string; fanIn: number; fanOut: number }> {
  return [...topology.symbolFan.entries()]
    .map(([key, fan]) => {
      const [file, qualifiedName] = key.split('#');
      return { key, file: file ?? '', qualifiedName: qualifiedName ?? '', fanIn: fan.fanIn, fanOut: fan.fanOut };
    })
    .sort((a, b) => b.fanIn - a.fanIn || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}

/** File nao import truc tiep mot file cho truoc. */
export function codingV5ImportersOf(topology: CodingV5Topology, relPath: string): string[] {
  return [...(topology.fileFan.get(relPath)?.importedBy ?? [])].sort();
}

/** File nao duoc mot file cho truoc import truc tiep. */
export function codingV5ImportsOf(topology: CodingV5Topology, relPath: string): string[] {
  return [...(topology.fileFan.get(relPath)?.imports ?? [])].sort();
}

/** Export public (named/default/namespace) cua mot file. */
export function codingV5PublicExports(topology: CodingV5Topology, relPath: string): CodingV5Export[] {
  return (topology.exportsByFile.get(relPath) ?? []).filter((e) => e.kind !== 're-export');
}

// ---------------------------------------------------------------------------
// Re-export chain: public API that suot qua nhieu tang re-export
// ---------------------------------------------------------------------------

/** Mot export sau khi giai chuoi re-export ve dinh nghia goc. */
export interface CodingV5ResolvedExport {
  /** Ten export nhin tu file goc (file bat dau chuoi). */
  name: string;
  /** File dinh nghia symbol that su (sau khi giai het re-export). */
  definingFile: string | null;
  /** Ten day du cua symbol o file dinh nghia (null khi khong giai duoc). */
  definingQualified: string | null;
  /** Chuoi file da di qua (bat dau = file goc, ket thuc = file dinh nghia). */
  chain: string[];
  /** true khi chuoi bi dut (re-export tro toi file khong co trong map / symbol khong ton tai). */
  unresolved: boolean;
  /** true khi chuoi gap vong lap re-export. */
  cyclic: boolean;
}

/**
 * Giai chuoi re-export cua mot file: `export { x } from './c'` trong
 * A, ma C lai `export { x } from './d'`, thi public API cua A chua
 * `x` dinh nghia o D. Giai toi da theo chuoi, dung khi gap vong lap
 * hoac file/symbol khong ton tai (danh dau, khong crash).
 */
export function resolveCodingV5ReExports(
  topology: CodingV5Topology,
  files: CodingV2FileEntry[],
  relPath: string,
): CodingV5ResolvedExport[] {
  const fileByRel = new Map(files.map((f) => [f.relPath, f] as const));
  const out: CodingV5ResolvedExport[] = [];
  const startExports = topology.exportsByFile.get(relPath) ?? [];
  for (const exp of startExports) {
    if (exp.kind !== 're-export' && exp.kind !== 'namespace') continue;
    if (exp.kind === 'namespace') {
      // `export * as ns from './c'`: khong giai tung symbol, chi ghi
      // namespace tro toi file dich (neu resolve duoc).
      const target = exp.reExportFrom !== null
        ? (topology.importsByFile.get(relPath) ?? []).find((i) => i.specifier === exp.reExportFrom)?.resolved ?? null
        : null;
      out.push({
        name: exp.name,
        definingFile: target,
        definingQualified: null,
        chain: target ? [relPath, target] : [relPath],
        unresolved: target === null,
        cyclic: false,
      });
      continue;
    }
    if (exp.name === '*') {
      // `export * from './c'`: giai thanh moi export cua file dich.
      const target = (topology.importsByFile.get(relPath) ?? []).find((i) => i.specifier === exp.reExportFrom)?.resolved ?? null;
      if (target === null) {
        out.push({ name: '*', definingFile: null, definingQualified: null, chain: [relPath], unresolved: true, cyclic: false });
        continue;
      }
      const sub = resolveCodingV5ReExports(topology, files, target);
      for (const s of sub) {
        out.push({ ...s, chain: [relPath, ...s.chain] });
      }
      continue;
    }
    // `export { x } from './c'` — lan theo chuoi.
    const chain: string[] = [relPath];
    const visited = new Set<string>([relPath]);
    let currentFile = relPath;
    let currentName = exp.localName;
    let cyclic = false;
    let unresolved = false;
    let definingFile: string | null = null;
    let definingQualified: string | null = null;
    for (;;) {
      // Tim export tuong ung trong file hien tai: neu file hien tai
      // dinh nghia truc tiep ten nay thi xong; neu no re-export ten
      // nay tu file khac thi di tiep.
      const currentExports = topology.exportsByFile.get(currentFile) ?? [];
      const reExport = currentExports.find(
        (e) => e.name === currentName && (e.kind === 're-export' || e.kind === 'namespace'),
      );
      const entry = fileByRel.get(currentFile);
      const defined = entry?.symbols.find(
        (s) => s.name === currentName || s.qualifiedName === currentName,
      );
      if (defined) {
        definingFile = currentFile;
        definingQualified = defined.qualifiedName;
        break;
      }
      if (!reExport || reExport.reExportFrom === null) {
        unresolved = true;
        break;
      }
      const nextFile = (topology.importsByFile.get(currentFile) ?? []).find(
        (i) => i.specifier === reExport.reExportFrom,
      )?.resolved ?? null;
      if (nextFile === null) {
        unresolved = true;
        break;
      }
      if (visited.has(nextFile)) {
        cyclic = true;
        chain.push(nextFile);
        break;
      }
      visited.add(nextFile);
      chain.push(nextFile);
      currentFile = nextFile;
      currentName = reExport.localName;
    }
    out.push({
      name: exp.name,
      definingFile,
      definingQualified,
      chain,
      unresolved,
      cyclic,
    });
  }
  return out;
}

/**
 * Public API hieu dung cua mot file: export truc tiep + re-export da
 * giai ve dinh nghia goc (ten -> file dinh nghia). Dung cho agent
 * hoi "import X tu file A thi that ra lay code o dau".
 */
export function codingV5EffectiveExports(
  topology: CodingV5Topology,
  files: CodingV2FileEntry[],
  relPath: string,
): Array<{ name: string; definingFile: string | null; definingQualified: string | null }> {
  const direct = codingV5PublicExports(topology, relPath).map((e) => ({
    name: e.name,
    definingFile: e.definedLocally ? relPath : null,
    definingQualified: e.definedLocally ? e.localName : null,
  }));
  const viaReExport = resolveCodingV5ReExports(topology, files, relPath)
    .filter((r) => r.name !== '*')
    .map((r) => ({
      name: r.name,
      definingFile: r.definingFile,
      definingQualified: r.definingQualified,
    }));
  const seen = new Set<string>();
  const out: Array<{ name: string; definingFile: string | null; definingQualified: string | null }> = [];
  for (const item of [...direct, ...viaReExport]) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tom tat topology thanh text ngan cho agent (dung trong tool
 * status): so file/symbol/export/import/call, hub lon nhat, so chu
 * trinh, so file mo coi.
 */
export function renderCodingV5TopologySummary(topology: CodingV5Topology): string {
  const s = topology.stats;
  const hubs = codingV5TopHubs(topology, 3);
  const hubText = hubs.length > 0
    ? hubs.map((h) => `${h.relPath} (in ${h.fanIn}/out ${h.fanOut})`).join(', ')
    : '(none)';
  return [
    `Topology v5: ${s.files} file(s), ${s.symbols} symbol(s), ${s.exports} export(s) (${s.exportsLinked} linked), ` +
      `${s.imports} import(s) (${s.importsResolved} resolved, ${s.importsExternal} external, ${s.importsTypeOnly} type-only, ${s.importsDynamic} dynamic), ` +
      `${s.callSites} call site(s) (${s.callsResolved} resolved, ${s.callsAmbiguous} ambiguous, ${s.callsUnresolved} unresolved).`,
    `Hubs: ${hubText}. Import cycles: ${s.cycles}. Orphan files: ${s.orphans}.`,
  ].join('\n');
}

/**
 * Noi topology v5 voi do thi v2: tra ve file co diem PageRank cao
 * nhat trong so cac file dinh nghia mot symbol (dung khi can chon
 * dinh nghia "chinh" giua cac dinh nghia trung ten).
 */
export function codingV5BestDefinitionFile(
  graph: CodingV2Graph,
  candidates: string[],
): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const file of candidates) {
    const score = graph.fileScores.get(file) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = file;
    }
  }
  return best;
}
