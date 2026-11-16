/**
 * Repo map v5 — jump-to-definition cho agent loop (v1.13, Doi T3).
 *
 * Y tuong hoc tu OpenHands Repository Map / Language Server "go to
 * definition" (chi hoc y tuong, tu thiet ke va viet lai hoan toan tu
 * dau): agent dang doc code, gap mot ten, hoi "symbol X dinh nghia o
 * dau, dung o dau" va nhan ve vi tri chinh xac + context ngan de
 * quyet dinh buoc tiep, thay vi phai mo ca file.
 *
 * Mo rong `codingV2SymbolDetail` (dinh nghia + file nhac toi, khong
 * context, khong phan biet dinh nghia chinh/phu):
 *
 *   - resolve dinh nghia theo ten ngan / ten day du, uu tien dinh
 *     nghia trong file goi truoc (`fromFile`), roi dinh nghia co
 *     diem PageRank cao nhat (khi co do thi v2), roi dinh nghia
 *     duoc export cong khai (topology v5);
 *   - tra context: vai dong quanh dong dinh nghia (tu source lines
 *     truyen vao — module thuan tuy, khong doc dia) + signature
 *     (dong dinh nghia) + khoang dong;
 *   - tra usages: call site that (caller + dong goi) tu topology
 *     v5, file import dinh nghia, va file nhac ten (canh references
 *     cua do thi v2);
 *   - dinh nghia mo ho: tra tat ca dinh nghia kem ly do xep hang,
 *     khong doan bua mot dinh nghia; dinh nghia khong thay: tra
 *     goi y ten gan nhat (tim substring tren ten symbol).
 *
 * Module nay thuan tuy (khong fs): source lines truyen vao qua
 * `sources: Map<relPath, string[]>`. Lop fs song o
 * `packages/tools/src/codingV5RepoMap.ts`.
 *
 * Gioi han trung thuc:
 *   - context chi la dong text quanh dinh nghia, khong phai AST
 *     chinh xac (dinh nghia nhieu dong thi chi thay phan dau).
 *   - "dinh nghia chinh" la heuristic (file goi -> PageRank ->
 *     export cong khai); khi ten trung nhau o nhieu file ma khong
 *     co tin hieu nao phan biet thi van tra danh sach mo ho.
 *   - usages tu call site regex (xem topology.ts) + canh references
 *     cua v2 (dem theo ten, co the thua).
 */

import type { CodingV2FileEntry, CodingV2Graph } from '../codingV2/repoMapGraph';
import type { CodingV5Topology } from './topology';
import { codingV5BestDefinitionFile } from './topology';
import { findCodingV5Callers } from './search';

/** So dong context mac dinh moi phia cua dong dinh nghia. */
export const CODING_V5_DEFAULT_CONTEXT_LINES = 3;
/** So goi y toi da khi khong tim thay dinh nghia. */
export const CODING_V5_DEFAULT_SUGGESTIONS = 5;
/** So usage toi da tra ve trong mot ket qua. */
export const CODING_V5_DEFAULT_USAGE_LIMIT = 10;

// ---------------------------------------------------------------------------
// Kieu du lieu
// ---------------------------------------------------------------------------

/** Mot dinh nghia tim duoc. */
export interface CodingV5Definition {
  file: string;
  name: string;
  qualifiedName: string;
  kind: string;
  line: number;
  column: number;
  endLine: number;
  /** Dong dinh nghia (signature, da trim). */
  signature: string;
  /** Context: dong quanh dinh nghia (kem so dong). */
  context: Array<{ line: number; text: string }>;
  /** Diem PageRank symbol cua v2 (0 khi khong co do thi). */
  score: number;
  /** Dinh nghia co duoc export cong khai khong. */
  exported: boolean;
  /** Ly do xep hang dinh nghia nay truoc dinh nghia khac. */
  rankReason: string;
}

/** Mot usage cua symbol (noi no duoc goi / nhac toi / import). */
export interface CodingV5Usage {
  kind: 'call' | 'reference' | 'import';
  file: string;
  line: number;
  /** Ham chua usage ('' = top-level). */
  caller: string;
  /** Chi tiet ngan (vd ten goi day du, specifier import). */
  detail: string;
}

/** Ket qua jump-to-definition. */
export interface CodingV5JumpResult {
  query: string;
  found: boolean;
  /** Dinh nghia chinh (khi found). */
  definition: CodingV5Definition | null;
  /** Tat ca dinh nghia trung ten (khi mo ho hoac khi co nhieu). */
  allDefinitions: CodingV5Definition[];
  /** true khi co > 1 dinh nghia trung ten. */
  ambiguous: boolean;
  /** Usage cua dinh nghia chinh. */
  usages: CodingV5Usage[];
  /** So usage (truoc khi cat theo limit). */
  totalUsages: number;
  /** Goi y ten gan nhat khi khong tim thay. */
  suggestions: string[];
  /** Ly do khong tim thay (khi !found). */
  notFoundReason: string | null;
}

export interface CodingV5JumpOptions {
  /** File agent dang doc (uu tien dinh nghia trong file nay). */
  fromFile?: string;
  /** So dong context moi phia (mac dinh 3). */
  contextLines?: number;
  /** So usage toi da (mac dinh 10). */
  usageLimit?: number;
  /** So goi y toi da khi khong thay (mac dinh 5). */
  suggestionLimit?: number;
}

// ---------------------------------------------------------------------------
// Dung dinh nghia + context
// ---------------------------------------------------------------------------

function contextOf(
  lines: string[] | undefined,
  line: number,
  contextLines: number,
): Array<{ line: number; text: string }> {
  if (!lines) return [];
  const out: Array<{ line: number; text: string }> = [];
  const start = Math.max(1, line - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  for (let n = start; n <= end; n += 1) {
    out.push({ line: n, text: lines[n - 1] ?? '' });
  }
  return out;
}

function signatureOf(lines: string[] | undefined, line: number): string {
  if (!lines) return '';
  return (lines[line - 1] ?? '').trim();
}

function buildDefinition(
  file: CodingV2FileEntry,
  symbol: CodingV2FileEntry['symbols'][number],
  graph: CodingV2Graph | null,
  topology: CodingV5Topology | null,
  sources: Map<string, string[]>,
  contextLines: number,
  rankReason: string,
): CodingV5Definition {
  const lines = sources.get(file.relPath);
  const nodeId = `s:${file.relPath}#${symbol.qualifiedName}`;
  const exported = topology
    ? (topology.exportsByFile.get(file.relPath) ?? []).some(
        (e) => e.localName === symbol.name || e.localName === symbol.qualifiedName,
      )
    : false;
  return {
    file: file.relPath,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    line: symbol.line,
    column: symbol.column,
    endLine: symbol.endLine,
    signature: signatureOf(lines, symbol.line),
    context: contextOf(lines, symbol.line, contextLines),
    score: graph?.symbolScores.get(nodeId) ?? 0,
    exported,
    rankReason,
  };
}

function rankReasonFor(
  file: CodingV2FileEntry,
  symbol: CodingV2FileEntry['symbols'][number],
  fromFile: string | undefined,
  exported: boolean,
): string {
  if (fromFile && file.relPath === fromFile) return 'defined in the file you are reading';
  if (exported) return 'public export (importable from other files)';
  return 'highest PageRank among definitions with this name';
}

// ---------------------------------------------------------------------------
// Jump-to-definition
// ---------------------------------------------------------------------------

/**
 * Giai quyet "symbol X dinh nghia o dau, dung o dau".
 *
 * Thu tu uu tien dinh nghia chinh:
 *   1. dinh nghia trong `fromFile` (file agent dang doc);
 *   2. dinh nghia duoc export cong khai;
 *   3. dinh nghia co diem PageRank symbol cao nhat (khi co do thi);
 *   4. dinh nghia dau tien theo thu tu alphabet (on dinh, khong ngau nhien).
 *
 * Khi khong tim thay: tra goi y la symbol co ten chua query (substring,
 * khong phan biet hoa thuong), xep theo do dai ten tang dan.
 */
export function jumpCodingV5ToDefinition(
  files: CodingV2FileEntry[],
  query: string,
  topology: CodingV5Topology | null,
  graph: CodingV2Graph | null,
  sources: Map<string, string[]>,
  options: CodingV5JumpOptions = {},
): CodingV5JumpResult {
  const needle = query.trim();
  const contextLines = Math.max(0, Math.floor(options.contextLines ?? CODING_V5_DEFAULT_CONTEXT_LINES));
  const usageLimit = Math.max(0, Math.floor(options.usageLimit ?? CODING_V5_DEFAULT_USAGE_LIMIT));
  const suggestionLimit = Math.max(0, Math.floor(options.suggestionLimit ?? CODING_V5_DEFAULT_SUGGESTIONS));
  const base: CodingV5JumpResult = {
    query,
    found: false,
    definition: null,
    allDefinitions: [],
    ambiguous: false,
    usages: [],
    totalUsages: 0,
    suggestions: [],
    notFoundReason: null,
  };
  if (needle === '') {
    return { ...base, notFoundReason: 'empty symbol name' };
  }
  // Thu thap moi dinh nghia trung ten ngan hoac ten day du.
  const matches: Array<{ file: CodingV2FileEntry; symbol: CodingV2FileEntry['symbols'][number] }> = [];
  for (const file of files) {
    for (const symbol of file.symbols) {
      if (symbol.name === needle || symbol.qualifiedName === needle) {
        matches.push({ file, symbol });
      }
    }
  }
  if (matches.length === 0) {
    const lower = needle.toLowerCase();
    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const file of files) {
      for (const symbol of file.symbols) {
        if (seen.has(symbol.qualifiedName)) continue;
        seen.add(symbol.qualifiedName);
        if (symbol.name.toLowerCase().includes(lower) || symbol.qualifiedName.toLowerCase().includes(lower)) {
          suggestions.push(`${symbol.qualifiedName} (${file.relPath}:${symbol.line})`);
        }
      }
    }
    suggestions.sort((a, b) => a.length - b.length || a.localeCompare(b));
    return {
      ...base,
      suggestions: suggestions.slice(0, suggestionLimit),
      notFoundReason: `no symbol named "${needle}" in the indexed files`,
    };
  }
  // Xep hang dinh nghia.
  const withMeta = matches.map(({ file, symbol }) => {
    const nodeId = `s:${file.relPath}#${symbol.qualifiedName}`;
    const score = graph?.symbolScores.get(nodeId) ?? 0;
    const exported = topology
      ? (topology.exportsByFile.get(file.relPath) ?? []).some(
          (e) => e.localName === symbol.name || e.localName === symbol.qualifiedName,
        )
      : false;
    return { file, symbol, score, exported };
  });
  const fromFile = options.fromFile;
  withMeta.sort((a, b) => {
    const aSelf = fromFile && a.file.relPath === fromFile ? 0 : 1;
    const bSelf = fromFile && b.file.relPath === fromFile ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return `${a.file.relPath}#${a.symbol.qualifiedName}`.localeCompare(
      `${b.file.relPath}#${b.symbol.qualifiedName}`,
    );
  });
  const best = withMeta[0]!;
  const allDefinitions = withMeta.map(({ file, symbol, exported }) =>
    buildDefinition(
      file,
      symbol,
      graph,
      topology,
      sources,
      contextLines,
      rankReasonFor(file, symbol, fromFile, exported),
    ),
  );
  const definition = allDefinitions[0]!;

  // Usages cua dinh nghia chinh: call site that + import + references (v2).
  const usages: CodingV5Usage[] = [];
  const seenUsage = new Set<string>();
  const pushUsage = (u: CodingV5Usage): void => {
    const key = `${u.kind}\n${u.file}\n${u.line}\n${u.detail}`;
    if (seenUsage.has(key)) return;
    seenUsage.add(key);
    usages.push(u);
  };
  if (topology) {
    const { callers } = findCodingV5Callers(topology, files, definition.qualifiedName, {
      limit: usageLimit,
    });
    for (const c of callers) {
      pushUsage({
        kind: 'call',
        file: c.callerFile,
        line: c.callLine,
        caller: c.caller,
        detail: c.calleeQualified,
      });
    }
    // File import file dinh nghia (ke ca khi chua goi symbol cu the).
    for (const [from, imports] of topology.importsByFile) {
      for (const imp of imports) {
        if (imp.resolved === definition.file) {
          pushUsage({
            kind: 'import',
            file: from,
            line: imp.line,
            caller: '',
            detail: `imports ${imp.specifier}${imp.importedNames.length > 0 ? ` (${imp.importedNames.join(', ')})` : ''}`,
          });
          break;
        }
      }
    }
  }
  if (graph) {
    // Canh references cua v2: file -> symbol (theo ten ngan).
    const nodeId = `s:${definition.file}#${definition.qualifiedName}`;
    for (const edge of graph.edges) {
      if (edge.kind !== 'references' || edge.to !== nodeId) continue;
      const fromNode = graph.nodes.get(edge.from);
      if (fromNode?.kind !== 'file') continue;
      // Da co usage cu the hon (call/import) tu cung file thi bo qua
      // canh references mo (chi biet file, khong biet dong).
      if (usages.some((u) => u.file === fromNode.file)) continue;
      pushUsage({
        kind: 'reference',
        file: fromNode.file,
        line: 0,
        caller: '',
        detail: `mentions ${definition.name}`,
      });
    }
  }
  usages.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const totalUsages = usages.length;
  return {
    query,
    found: true,
    definition,
    allDefinitions,
    ambiguous: allDefinitions.length > 1,
    usages: usages.slice(0, usageLimit),
    totalUsages,
    suggestions: [],
    notFoundReason: null,
  };
}

/** Dinh nghia chinh cua mot symbol theo ten (tien ich gon cho agent loop). */
export function codingV5BestDefinitionFileForSymbol(
  graph: CodingV2Graph | null,
  candidates: string[],
): string | null {
  if (!graph) return candidates.length > 0 ? [...candidates].sort()[0]! : null;
  return codingV5BestDefinitionFile(graph, candidates);
}

// ---------------------------------------------------------------------------
// Render ket qua cho agent loop
// ---------------------------------------------------------------------------

/** Render ket qua jump-to-definition thanh text ngan cho agent loop. */
export function renderCodingV5JumpResult(result: CodingV5JumpResult): string {
  if (!result.found || !result.definition) {
    const lines = [`Symbol "${result.query}" not found: ${result.notFoundReason ?? 'unknown reason'}.`];
    if (result.suggestions.length > 0) {
      lines.push('Did you mean:');
      for (const s of result.suggestions) lines.push(`  - ${s}`);
    }
    return lines.join('\n');
  }
  const d = result.definition;
  const lines: string[] = [
    `${d.qualifiedName} (${d.kind}) defined at ${d.file}:${d.line}:${d.column} ` +
      `(ends line ${d.endLine})${d.exported ? ' — public export' : ''} [${d.rankReason}].`,
  ];
  if (d.signature) lines.push(`Signature: ${d.signature}`);
  if (d.context.length > 0) {
    lines.push('Context:');
    for (const c of d.context) {
      const marker = c.line === d.line ? '>' : ' ';
      lines.push(`${marker} ${c.line}: ${c.text}`);
    }
  }
  if (result.ambiguous) {
    lines.push(`Note: ${result.allDefinitions.length} definitions share this name:`);
    for (const alt of result.allDefinitions) {
      lines.push(`  - ${alt.qualifiedName} (${alt.kind}) at ${alt.file}:${alt.line} [${alt.rankReason}]`);
    }
  }
  if (result.totalUsages > 0) {
    lines.push(`Used in ${result.totalUsages} place(s)${result.usages.length < result.totalUsages ? ` (showing ${result.usages.length})` : ''}:`);
    for (const u of result.usages) {
      lines.push(`  - [${u.kind}] ${u.file}${u.line > 0 ? `:${u.line}` : ''}${u.caller ? ` in ${u.caller}` : ''} — ${u.detail}`);
    }
  } else {
    lines.push('(no usages found in the indexed files)');
  }
  return lines.join('\n');
}
