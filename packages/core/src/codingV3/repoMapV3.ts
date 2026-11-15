/**
 * Repo map v3 — call edges + module graph + token-budget map (v1.10, Đội T4).
 *
 * Xây trên repo map v2 (`codingV2/repoMapGraph.ts` — đồ thị symbol-level
 * + PageRank + cache đĩa). v3 thêm 3 lớp mà v2 chưa có:
 *
 *   1. Call edges file -> file: từ cạnh references (file -> symbol) của
 *      v2, đối chiếu symbol về file định nghĩa nó, cộng dồn thành cạnh
 *      "file A gọi code của file B"; cộng với cạnh imports (file -> file)
 *      thành một đồ thị file-level duy nhất có 2 loại trọng số.
 *   2. Module graph: gom file theo module (thư mục cấp 1, hoặc cấp 2
 *      khi cấp 1 là `packages`/`apps` — vd `packages/core`,
 *      `apps/desktop`), cộng điểm PageRank của file thành điểm module,
 *      cộng cạnh call/import thành cạnh module -> module.
 *   3. Repo map rút gọn theo ngân sách token: render text map chỉ gồm
 *      file xếp hạng cao nhất + symbol nổi bật, ước lượng token bằng
 *      ceil(chars / 4), cắt đúng ngân sách (luôn giữ ít nhất 1 file),
 *      báo rõ file nào bị lược.
 *
 * Module này thuần túy (không fs): quét file/cache đĩa sống ở
 * `packages/tools/src/codingV3RepoMap.ts`, giống cách v2 tách
 * `repoMapGraph.ts` (thuần) khỏi `codingV2RepoMap.ts` (fs).
 *
 * Giới hạn trung thực:
 *   - "call" suy ra từ nhắc tên symbol (kể cả trong string/comment),
 *     giống v2 — không phải call graph chính xác theo AST.
 *   - token chỉ là ước lượng (chars/4), không đếm bằng tokenizer thật.
 *   - module = thư mục, không suy ra từ package.json hay boundary thật.
 */

import {
  buildCodingV2Graph,
  codingV2PageRank,
  codingV2SymbolNodeId,
  CODING_V2_MAX_EDGES,
} from '../codingV2/repoMapGraph';
import type {
  CodingV2FileEntry,
  CodingV2Graph,
  CodingV2GraphEdge,
} from '../codingV2/repoMapGraph';

/** Version của định dạng cache tóm tắt v3 trên đĩa. */
export const CODING_V3_CACHE_VERSION = 3;
/** Số ký tự ước tính = 1 token khi render budget map. */
export const CODING_V3_CHARS_PER_TOKEN = 4;
/** Ngân sách token mặc định cho budget map. */
export const CODING_V3_DEFAULT_BUDGET_TOKENS = 2000;
/** Trần cạnh call file -> file (chống blow-up, cùng trần với v2). */
export const CODING_V3_MAX_CALL_EDGES = CODING_V2_MAX_EDGES;

// ---------------------------------------------------------------------------
// Call edges file -> file
// ---------------------------------------------------------------------------

export interface CodingV3CallEdge {
  from: string;
  to: string;
  /** Tổng trọng số: import (2 mỗi cạnh) + call (sqrt số lần nhắc). */
  weight: number;
  /** Trọng số phần import (0 khi không import trực tiếp). */
  importWeight: number;
  /** Trọng số phần call qua symbol (0 khi không nhắc symbol nào). */
  callWeight: number;
  /** Số symbol khác nhau của `to` mà `from` nhắc tới. */
  distinctSymbolsCalled: number;
}

export interface CodingV3CallGraph {
  edges: CodingV3CallEdge[];
  stats: {
    files: number;
    edges: number;
    importOnlyEdges: number;
    callOnlyEdges: number;
    bothEdges: number;
    /** Số cạnh bị lược vì vượt trần. */
    edgesTruncated: number;
  };
}

/**
 * Dựng call graph file -> file từ đồ thị v2. Cạnh references
 * file -> symbol được đối chiếu về file định nghĩa symbol đó; nhiều
 * symbol cùng file đích thì cộng dồn trọng số. Cạnh imports của v2
 * cộng thêm trọng số 2 (theo CODING_V2_IMPORT_EDGE_WEIGHT).
 */
export function buildCodingV3CallGraph(graph: CodingV2Graph): CodingV3CallGraph {
  const symbolFile = new Map<string, string>();
  for (const [id, node] of graph.nodes) {
    if (node.kind === 'symbol') symbolFile.set(id, node.file);
  }
  const acc = new Map<string, CodingV3CallEdge>();
  const key = (from: string, to: string): string => `${from}\n${to}`;
  let edgesTruncated = 0;

  const add = (from: string, to: string, weight: number, kind: 'import' | 'call'): void => {
    if (from === to) return;
    const k = key(from, to);
    let edge = acc.get(k);
    if (!edge) {
      if (acc.size >= CODING_V3_MAX_CALL_EDGES) {
        edgesTruncated += 1;
        return;
      }
      edge = { from, to, weight: 0, importWeight: 0, callWeight: 0, distinctSymbolsCalled: 0 };
      acc.set(k, edge);
    }
    edge.weight += weight;
    if (kind === 'import') edge.importWeight += weight;
    else edge.callWeight += weight;
  };

  const seenCallPairs = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === 'imports') {
      const fromNode = graph.nodes.get(edge.from);
      const toNode = graph.nodes.get(edge.to);
      if (fromNode?.kind === 'file' && toNode?.kind === 'file') {
        add(fromNode.file, toNode.file, edge.weight, 'import');
      }
    } else if (edge.kind === 'references') {
      const fromNode = graph.nodes.get(edge.from);
      const targetFile = symbolFile.get(edge.to);
      if (fromNode?.kind === 'file' && targetFile !== undefined) {
        add(fromNode.file, targetFile, edge.weight, 'call');
        const pairKey = `${fromNode.file}\n${targetFile}\n${edge.to}`;
        if (!seenCallPairs.has(pairKey)) {
          seenCallPairs.add(pairKey);
          const accEdge = acc.get(key(fromNode.file, targetFile));
          if (accEdge) accEdge.distinctSymbolsCalled += 1;
        }
      }
    }
  }

  const edges = [...acc.values()].sort((a, b) => b.weight - a.weight);
  let importOnlyEdges = 0;
  let callOnlyEdges = 0;
  let bothEdges = 0;
  for (const edge of edges) {
    if (edge.importWeight > 0 && edge.callWeight > 0) bothEdges += 1;
    else if (edge.importWeight > 0) importOnlyEdges += 1;
    else callOnlyEdges += 1;
  }
  return {
    edges,
    stats: {
      files: graph.fileScores.size,
      edges: edges.length,
      importOnlyEdges,
      callOnlyEdges,
      bothEdges,
      edgesTruncated,
    },
  };
}

/** File mà `relPath` gọi nhiều nhất (top N đích theo trọng số call). */
export function codingV3TopCallsFrom(
  callGraph: CodingV3CallGraph,
  relPath: string,
  limit = 10,
): CodingV3CallEdge[] {
  return callGraph.edges.filter((e) => e.from === relPath).slice(0, Math.max(0, limit));
}

/** File gọi tới `relPath` nhiều nhất (top N nguồn theo trọng số call). */
export function codingV3TopCallersOf(
  callGraph: CodingV3CallGraph,
  relPath: string,
  limit = 10,
): CodingV3CallEdge[] {
  return callGraph.edges.filter((e) => e.to === relPath).slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Module graph
// ---------------------------------------------------------------------------

/**
 * Module của một file: thư mục cấp 1, hoặc cấp 2 khi cấp 1 là
 * `packages`/`apps` (vd `packages/core`, `apps/desktop`). File ở root
 * thuộc module `.` (root).
 */
export function codingV3ModuleOf(relPath: string): string {
  const parts = relPath.split('/').filter((p) => p !== '');
  if (parts.length <= 1) return '.';
  const first = parts[0]!;
  if ((first === 'packages' || first === 'apps') && parts.length >= 2) {
    return `${first}/${parts[1]!}`;
  }
  return first;
}

export interface CodingV3ModuleEdge {
  from: string;
  to: string;
  weight: number;
  fileEdges: number;
}

export interface CodingV3ModuleNode {
  module: string;
  /** Điểm module = tổng điểm PageRank file trong module (chuẩn hoá tổng = 1). */
  score: number;
  files: number;
  symbols: number;
  topFiles: Array<{ relPath: string; score: number }>;
}

export interface CodingV3ModuleGraph {
  modules: CodingV3ModuleNode[];
  edges: CodingV3ModuleEdge[];
  stats: { modules: number; edges: number; files: number };
}

/**
 * Gom đồ thị file-level thành đồ thị module-level. Điểm module cộng
 * từ điểm file (chuẩn hoá tổng = 1); cạnh module cộng từ cạnh call
 * giữa các file khác module.
 */
export function buildCodingV3ModuleGraph(
  graph: CodingV2Graph,
  callGraph: CodingV3CallGraph,
  files: CodingV2FileEntry[],
): CodingV3ModuleGraph {
  const byModule = new Map<string, { files: string[]; symbols: number; score: number }>();
  const symbolsPerFile = new Map<string, number>();
  for (const file of files) symbolsPerFile.set(file.relPath, file.symbols.length);

  let totalScore = 0;
  for (const [relPath, score] of graph.fileScores) {
    const module = codingV3ModuleOf(relPath);
    let entry = byModule.get(module);
    if (!entry) {
      entry = { files: [], symbols: 0, score: 0 };
      byModule.set(module, entry);
    }
    entry.files.push(relPath);
    entry.symbols += symbolsPerFile.get(relPath) ?? 0;
    entry.score += score;
    totalScore += score;
  }

  const modules: CodingV3ModuleNode[] = [...byModule.entries()]
    .map(([module, entry]) => {
      const topFiles = entry.files
        .map((relPath) => ({ relPath, score: graph.fileScores.get(relPath) ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      return {
        module,
        score: totalScore > 0 ? entry.score / totalScore : 0,
        files: entry.files.length,
        symbols: entry.symbols,
        topFiles,
      };
    })
    .sort((a, b) => b.score - a.score);

  const edgeAcc = new Map<string, CodingV3ModuleEdge>();
  for (const edge of callGraph.edges) {
    const fromModule = codingV3ModuleOf(edge.from);
    const toModule = codingV3ModuleOf(edge.to);
    if (fromModule === toModule) continue;
    const k = `${fromModule}\n${toModule}`;
    const existing = edgeAcc.get(k);
    if (existing) {
      existing.weight += edge.weight;
      existing.fileEdges += 1;
    } else {
      edgeAcc.set(k, { from: fromModule, to: toModule, weight: edge.weight, fileEdges: 1 });
    }
  }
  const edges = [...edgeAcc.values()].sort((a, b) => b.weight - a.weight);
  return {
    modules,
    edges,
    stats: { modules: modules.length, edges: edges.length, files: graph.fileScores.size },
  };
}

// ---------------------------------------------------------------------------
// Repo map rút gọn theo ngân sách token
// ---------------------------------------------------------------------------

export function estimateCodingV3Tokens(text: string): number {
  return Math.ceil(text.length / CODING_V3_CHARS_PER_TOKEN);
}

export interface CodingV3BudgetMapOptions {
  /** Ngân sách token (ước lượng chars/4). Mặc định 2000. */
  budgetTokens?: number;
  /** Số symbol nổi bật nhất liệt kê mỗi file. Mặc định 3. */
  topSymbolsPerFile?: number;
  /** Điểm PageRank dùng để xếp hạng (mặc định: điểm toàn cục của đồ thị). */
  fileScores?: Map<string, number>;
  /** Điểm symbol dùng để chọn symbol nổi bật (mặc định: điểm toàn cục). */
  symbolScores?: Map<string, number>;
  /** File ưu tiên xếp trước (vd file seed của truy vấn) — trong mỗi nhóm giữ thứ tự điểm. */
  prioritizeFiles?: Set<string>;
}

export interface CodingV3BudgetMap {
  text: string;
  /** Token ước lượng của text đã render. */
  estimatedTokens: number;
  budgetTokens: number;
  includedFiles: string[];
  /** File bị lược vì hết ngân sách (theo thứ tự xếp hạng). */
  excludedFiles: string[];
  /** true khi map đã cắt bớt file vì ngân sách. */
  truncated: boolean;
  totalFiles: number;
}

function renderBudgetMapLine(
  file: CodingV2FileEntry,
  score: number,
  symbolScores: Map<string, number>,
  topSymbolsPerFile: number,
): string {
  const topSymbols = file.symbols
    .map((s) => ({
      ...s,
      score: symbolScores.get(codingV2SymbolNodeId(file.relPath, s.qualifiedName)) ?? 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topSymbolsPerFile);
  const symbolPart =
    topSymbols.length > 0
      ? ` — ${topSymbols.map((s) => `${s.kind} ${s.qualifiedName}:${s.line}`).join(', ')}`
      : '';
  return `${file.relPath} [score ${score.toFixed(4)}, ${file.symbols.length} symbols]${symbolPart}`;
}

/**
 * Render repo map rút gọn vừa ngân sách token: lấy file theo thứ tự
 * điểm giảm dần, thêm từng dòng cho tới khi chạm ngân sách. Luôn giữ
 * ít nhất 1 file (kể cả khi 1 dòng đã vượt ngân sách — khi đó báo
 * truncated và estimatedTokens > budget).
 */
export function renderCodingV3BudgetMap(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  options: CodingV3BudgetMapOptions = {},
): CodingV3BudgetMap {
  const budgetTokens = Math.max(1, Math.floor(options.budgetTokens ?? CODING_V3_DEFAULT_BUDGET_TOKENS));
  const topSymbolsPerFile = Math.max(0, Math.floor(options.topSymbolsPerFile ?? 3));
  const fileScores = options.fileScores ?? graph.fileScores;
  const symbolScores = options.symbolScores ?? graph.symbolScores;

  // Xếp hạng: file ưu tiên (seed của truy vấn) đứng trước — giống
  // v2 (queryCodingV2Graph): một file "hub" nhận mass từ nhiều
  // symbol có thể vượt file thực sự định nghĩa symbol được hỏi nếu
  // chỉ xếp theo điểm PageRank.
  const prioritizeFiles = options.prioritizeFiles;
  const ranked = [...fileScores.entries()]
    .filter(([relPath]) => files.some((f) => f.relPath === relPath))
    .sort((a, b) => {
      if (prioritizeFiles) {
        const aSeed = prioritizeFiles.has(a[0]) ? 0 : 1;
        const bSeed = prioritizeFiles.has(b[0]) ? 0 : 1;
        if (aSeed !== bSeed) return aSeed - bSeed;
      }
      return b[1] - a[1];
    });
  const fileByRel = new Map(files.map((f) => [f.relPath, f] as const));

  const header = `# Repo map (v3, budget ${budgetTokens} tokens, ${ranked.length} files ranked)`;
  const lines: string[] = [header];
  const includedFiles: string[] = [];
  const excludedFiles: string[] = [];
  let usedChars = header.length + 1;

  for (const [relPath, score] of ranked) {
    const file = fileByRel.get(relPath);
    if (!file) continue;
    const line = renderBudgetMapLine(file, score, symbolScores, topSymbolsPerFile);
    const nextChars = usedChars + line.length + 1;
    if (includedFiles.length > 0 && Math.ceil(nextChars / CODING_V3_CHARS_PER_TOKEN) > budgetTokens) {
      excludedFiles.push(relPath);
      continue;
    }
    lines.push(line);
    includedFiles.push(relPath);
    usedChars = nextChars;
  }
  // Các file còn lại sau lần lược đầu đều bị lược (giữ thứ tự xếp hạng).
  for (const [relPath] of ranked) {
    if (!includedFiles.includes(relPath) && !excludedFiles.includes(relPath)) {
      excludedFiles.push(relPath);
    }
  }

  const text = lines.join('\n');
  return {
    text,
    estimatedTokens: estimateCodingV3Tokens(text),
    budgetTokens,
    includedFiles,
    excludedFiles,
    truncated: excludedFiles.length > 0,
    totalFiles: ranked.length,
  };
}

/**
 * Budget map theo truy vấn: chạy Personalized PageRank với seed là
 * file/symbol khớp truy vấn (dùng lại logic seed của v2 qua
 * queryCodingV2Graph thì tốn một lần PageRank nữa — ở đây tự tính
 * seed đơn giản theo tên rồi chạy PageRank có personalization),
 * rồi render map rút gọn theo điểm truy vấn đó.
 */
export function renderCodingV3QueryBudgetMap(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  query: string,
  options: CodingV3BudgetMapOptions = {},
): CodingV3BudgetMap & { fellBackToGlobal: boolean; seedFiles: string[] } {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
  const seedNodeIds = new Map<string, number>();
  const seedFiles = new Set<string>();
  if (tokens.length > 0) {
    for (const file of files) {
      const relLower = file.relPath.toLowerCase();
      if (tokens.some((t) => relLower.includes(t))) {
        seedFiles.add(file.relPath);
        seedNodeIds.set(`f:${file.relPath}`, 1);
      }
      for (const symbol of file.symbols) {
        if (
          tokens.some(
            (t) => symbol.qualifiedName.toLowerCase().includes(t) || symbol.name.toLowerCase().includes(t),
          )
        ) {
          seedFiles.add(file.relPath);
          seedNodeIds.set(codingV2SymbolNodeId(file.relPath, symbol.qualifiedName), 1);
        }
      }
    }
  }
  const fellBackToGlobal = seedNodeIds.size === 0;
  if (fellBackToGlobal) {
    return { ...renderCodingV3BudgetMap(graph, files, options), fellBackToGlobal, seedFiles: [] };
  }
  const nodeIds = [...graph.nodes.keys()];
  const { scores } = codingV2PageRank(nodeIds, graph.edges, { personalization: seedNodeIds });
  const fileScores = new Map<string, number>();
  const symbolScores = new Map<string, number>();
  const symbolFile = new Map<string, string>();
  let fileTotal = 0;
  let symbolTotal = 0;
  for (const [id, node] of graph.nodes) {
    const score = scores.get(id) ?? 0;
    if (node.kind === 'file') {
      fileScores.set(node.file, score);
      fileTotal += score;
    } else {
      symbolScores.set(id, score);
      symbolTotal += score;
      symbolFile.set(id, node.file);
    }
  }
  for (const [symbolId, score] of symbolScores) {
    const file = symbolFile.get(symbolId);
    if (file !== undefined) {
      fileScores.set(file, (fileScores.get(file) ?? 0) + score);
      fileTotal += score;
    }
  }
  if (fileTotal > 0) {
    for (const [file, score] of fileScores) fileScores.set(file, score / fileTotal);
  }
  if (symbolTotal > 0) {
    for (const [id, score] of symbolScores) symbolScores.set(id, score / symbolTotal);
  }
  return {
    ...renderCodingV3BudgetMap(graph, files, { ...options, fileScores, symbolScores, prioritizeFiles: seedFiles }),
    fellBackToGlobal,
    seedFiles: [...seedFiles].sort(),
  };
}

// ---------------------------------------------------------------------------
// Cache tóm tắt v3 trên đĩa (module ranking + call stats)
// ---------------------------------------------------------------------------

export interface CodingV3CacheFile {
  version: number;
  rootDir: string;
  updatedAt: string;
  /** Số file/symbol/cạnh của đồ thị v2 lúc build tóm tắt. */
  files: number;
  symbols: number;
  edges: number;
  callEdges: number;
  modules: Array<{ module: string; score: number; files: number; symbols: number }>;
  topCallEdges: CodingV3CallEdge[];
}

export function serializeCodingV3Cache(cache: CodingV3CacheFile): string {
  return `${JSON.stringify(cache, null, 2)}\n`;
}

/**
 * Parse cache tóm tắt v3. Trả `{ error }` khi version khác, rootDir
 * khác, hoặc thiếu trường — caller build lại thay vì crash.
 */
export function parseCodingV3Cache(
  text: string,
  expectedRootDir: string,
): { cache: CodingV3CacheFile } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    return { error: `cache v3 JSON hỏng: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'cache v3 không phải object JSON' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CODING_V3_CACHE_VERSION) {
    return { error: `cache v3 version ${String(obj.version)} khác ${CODING_V3_CACHE_VERSION}, build lại` };
  }
  if (typeof obj.rootDir !== 'string' || obj.rootDir !== expectedRootDir) {
    return { error: 'cache v3 thuộc workspace khác, build lại' };
  }
  if (
    typeof obj.files !== 'number' ||
    typeof obj.symbols !== 'number' ||
    typeof obj.edges !== 'number' ||
    typeof obj.callEdges !== 'number' ||
    !Array.isArray(obj.modules) ||
    !Array.isArray(obj.topCallEdges)
  ) {
    return { error: 'cache v3 thiếu trường' };
  }
  return {
    cache: {
      version: CODING_V3_CACHE_VERSION,
      rootDir: expectedRootDir,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
      files: obj.files,
      symbols: obj.symbols,
      edges: obj.edges,
      callEdges: obj.callEdges,
      modules: (obj.modules as CodingV3CacheFile['modules']).filter(
        (m) => m && typeof m.module === 'string' && typeof m.score === 'number',
      ),
      topCallEdges: (obj.topCallEdges as CodingV3CallEdge[]).filter(
        (e) => e && typeof e.from === 'string' && typeof e.to === 'string' && typeof e.weight === 'number',
      ),
    },
  };
}

/** Dựng cache tóm tắt v3 từ đồ thị đã build (để ghi đĩa). */
export function buildCodingV3CacheSummary(
  rootDir: string,
  graph: CodingV2Graph,
  callGraph: CodingV3CallGraph,
  moduleGraph: CodingV3ModuleGraph,
): CodingV3CacheFile {
  return {
    version: CODING_V3_CACHE_VERSION,
    rootDir,
    updatedAt: new Date().toISOString(),
    files: graph.stats.files,
    symbols: graph.stats.symbols,
    edges: graph.stats.edges,
    callEdges: callGraph.edges.length,
    modules: moduleGraph.modules.map((m) => ({
      module: m.module,
      score: m.score,
      files: m.files,
      symbols: m.symbols,
    })),
    topCallEdges: callGraph.edges.slice(0, 50),
  };
}

/** Tiện ích: dựng toàn bộ lớp v3 từ entries + idents (một lần gọi). */
export function buildCodingV3All(input: {
  files: CodingV2FileEntry[];
  idents: Map<string, Map<string, number>>;
}): {
  graph: CodingV2Graph;
  callGraph: CodingV3CallGraph;
  moduleGraph: CodingV3ModuleGraph;
} {
  const graph = buildCodingV2Graph(input);
  const callGraph = buildCodingV3CallGraph(graph);
  const moduleGraph = buildCodingV3ModuleGraph(graph, callGraph, input.files);
  return { graph, callGraph, moduleGraph };
}
