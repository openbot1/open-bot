/**
 * Repo map PageRank v3 (v1.16, Đội T4).
 *
 * Học ý tưởng Aider repo map + OpenHands V1 SDK (survey v1.16 §5):
 * graph symbol-level + PageRank để trả lời "code nào liên quan nhất
 * tới task này". v3 khác v2 ở 4 điểm, không viết lại v2:
 * - Cạnh `calls` thật (caller → callee, từ call site của parser v8)
 *   với trọng số cao nhất; cạnh `references` chỉ là fallback khi
 *   không resolve được call theo tên ngắn.
 * - PageRank có trọng số theo KIND cạnh (calls > imports > references
 *   > defines) + personalization theo query + xử lý dangling node
 *   (node không có cạnh ra chia đều cho mọi node, tránh rò điểm).
 * - Incremental update theo CONTENT HASH (SHA-256) thay vì mtime:
 *   đổi nội dung mới parse lại; `updateFiles()` chỉ tính lại
 *   PageRank trên subgraph bị ảnh hưởng (file đổi + file import/call
 *   nó, đệ quy 1 hop) rồi merge điểm — báo rõ file nào parse lại,
 *   file nào tái dùng, số node tính lại.
 * - Query trả `reasons` cho từng hit (tên khớp / import / call /
 *   PageRank cao) để agent giải thích được vì sao chọn file đó;
 *   có `callersOf` / `calleesOf` để đi theo call graph khi refactor.
 *
 * Giới hạn trung thực: resolve call theo tên ngắn nên method trùng
 * tên ở nhiều class có thể nối nhầm cạnh (báo `ambiguousSymbolsSkipped`
 * trong stats); PageRank incremental là xấp xỉ (chỉ tính lại subgraph
 * bị ảnh hưởng, điểm ngoài subgraph giữ nguyên rồi chuẩn hoá lại) —
 * `rebuild()` luôn cho điểm chính xác đầy đủ khi cần.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { v8ParseFile } from './parser';
import type {
  V8EdgeKind,
  V8Graph,
  V8GraphEdge,
  V8GraphNode,
  V8GraphStats,
  V8ParsedFile,
  V8RepoQueryHit,
  V8RepoQueryResult,
} from './types';

/** Hệ số damping PageRank. */
export const V8_PAGERANK_DAMPING = 0.85;
/** Số vòng power iteration tối đa. */
export const V8_PAGERANK_MAX_ITERATIONS = 60;
/** Ngưỡng hội tụ: max |delta| nhỏ hơn thì dừng. */
export const V8_PAGERANK_EPSILON = 1e-6;
/** Tên symbol định nghĩa ở nhiều hơn số file này thì mơ hồ: bỏ cạnh references. */
export const V8_MAX_SYMBOL_TARGETS = 20;
/** Trần số cạnh trong đồ thị (chống blow-up trên repo rất lớn). */
export const V8_MAX_EDGES = 200_000;
/** Version của định dạng cache JSON trên đĩa. */
export const V8_CACHE_VERSION = 3;

/** Trọng số cạnh theo kind (calls mang tín hiệu mạnh nhất). */
export const V8_EDGE_WEIGHTS: Record<V8EdgeKind, number> = {
  calls: 4,
  imports: 3,
  references: 1.5,
  defines: 1,
  contains: 0.5,
};

/** Số kết quả tối đa mặc định của query. */
export const V8_QUERY_DEFAULT_LIMIT = 10;

/** Id node file. */
export function v8FileNodeId(relPath: string): string {
  return `file:${relPath}`;
}

/** Id node symbol. */
export function v8SymbolNodeId(relPath: string, qualifiedName: string): string {
  return `symbol:${relPath}#${qualifiedName}`;
}

/** Tách file + qualified name từ id node symbol. */
export function v8ParseSymbolNodeId(nodeId: string): { file: string; symbol: string } | null {
  const m = /^symbol:(.+)#(.+)$/.exec(nodeId);
  if (!m) return null;
  return { file: m[1] as string, symbol: m[2] as string };
}

export interface V8PageRankOptions {
  damping?: number;
  maxIterations?: number;
  epsilon?: number;
  /** Node id → trọng số personalization (không chuẩn hoá trước cũng được). */
  personalization?: Map<string, number>;
}

/**
 * PageRank có trọng số trên đồ thị có hướng. Node không có cạnh ra
 * (dangling) chia điểm đều cho mọi node. Trả map nodeId → điểm
 * (tổng = 1) + số vòng đã chạy + delta cuối.
 */
export function v8PageRank(
  nodes: readonly string[],
  edges: readonly V8GraphEdge[],
  options: V8PageRankOptions = {},
): { scores: Map<string, number>; iterations: number; delta: number } {
  const damping = options.damping ?? V8_PAGERANK_DAMPING;
  const maxIterations = options.maxIterations ?? V8_PAGERANK_MAX_ITERATIONS;
  const epsilon = options.epsilon ?? V8_PAGERANK_EPSILON;
  const n = nodes.length;
  const scores = new Map<string, number>();
  if (n === 0) return { scores, iterations: 0, delta: 0 };
  // Vector personalization / teleport.
  const teleport = new Map<string, number>();
  if (options.personalization && options.personalization.size > 0) {
    let total = 0;
    for (const v of options.personalization.values()) total += Math.max(0, v);
    for (const id of nodes) {
      const w = options.personalization.get(id) ?? 0;
      teleport.set(id, total > 0 ? Math.max(0, w) / total : 1 / n);
    }
  } else {
    for (const id of nodes) teleport.set(id, 1 / n);
  }
  for (const id of nodes) scores.set(id, 1 / n);
  // Out-weight từng node.
  const outWeight = new Map<string, number>();
  const incoming = new Map<string, V8GraphEdge[]>();
  for (const id of nodes) {
    outWeight.set(id, 0);
    incoming.set(id, []);
  }
  for (const e of edges) {
    if (!outWeight.has(e.from) || !incoming.has(e.to)) continue;
    outWeight.set(e.from, (outWeight.get(e.from) ?? 0) + e.weight);
    incoming.get(e.to)?.push(e);
  }
  let iterations = 0;
  let delta = Number.POSITIVE_INFINITY;
  while (iterations < maxIterations && delta > epsilon) {
    iterations += 1;
    // Tổng điểm của dangling node (không có cạnh ra).
    let danglingSum = 0;
    for (const id of nodes) {
      if ((outWeight.get(id) ?? 0) === 0) danglingSum += scores.get(id) ?? 0;
    }
    const next = new Map<string, number>();
    delta = 0;
    for (const id of nodes) {
      let rank = (1 - damping) * (teleport.get(id) ?? 1 / n);
      rank += damping * (danglingSum / n);
      for (const e of incoming.get(id) ?? []) {
        const out = outWeight.get(e.from) ?? 0;
        if (out > 0) rank += damping * ((scores.get(e.from) ?? 0) * e.weight) / out;
      }
      next.set(id, rank);
      delta = Math.max(delta, Math.abs(rank - (scores.get(id) ?? 0)));
    }
    // Chuẩn hoá (chống trôi số).
    let total = 0;
    for (const v of next.values()) total += v;
    if (total > 0) {
      for (const [k, v] of next) next.set(k, v / total);
    }
    for (const [k, v] of next) scores.set(k, v);
  }
  return { scores, iterations, delta };
}

/** Input để dựng graph: file đã parse. */
export interface V8GraphInput {
  files: V8ParsedFile[];
  /** Bỏ qua cạnh references cho symbol mơ hồ ở trên số file này. */
  maxSymbolTargets?: number;
  maxEdges?: number;
}

/**
 * Dựng graph từ file đã parse. Cạnh:
 * - defines: symbol → file (symbol định nghĩa trong file).
 * - contains: file → symbol (chiều ngược của defines, giúp query file).
 * - imports: file → file được import.
 * - calls: symbol caller → symbol callee (resolve theo tên ngắn;
 *   chỉ nối khi callee duy nhất hoặc khi callee cùng file).
 * - references: file → symbol mà file nhắc tới theo tên (fallback
 *   khi call không resolve được; bỏ khi symbol mơ hồ).
 */
export function buildV8Graph(input: V8GraphInput): V8Graph {
  const maxTargets = input.maxSymbolTargets ?? V8_MAX_SYMBOL_TARGETS;
  const maxEdges = input.maxEdges ?? V8_MAX_EDGES;
  const nodes = new Map<string, V8GraphNode>();
  const edges: V8GraphEdge[] = [];
  const pushEdge = (from: string, to: string, kind: V8EdgeKind): void => {
    if (edges.length >= maxEdges) return;
    if (from === to) return;
    const existing = edges.find((e) => e.from === from && e.to === to && e.kind === kind);
    if (existing) {
      existing.weight += V8_EDGE_WEIGHTS[kind];
      return;
    }
    edges.push({ from, to, kind, weight: V8_EDGE_WEIGHTS[kind] });
  };

  // Index symbol theo tên ngắn → danh sách (file, qualified).
  const byShortName = new Map<string, Array<{ file: string; qualified: string }>>();
  for (const file of input.files) {
    nodes.set(v8FileNodeId(file.relPath), { id: v8FileNodeId(file.relPath), kind: 'file', file: file.relPath, score: 0 });
    for (const sym of file.symbols) {
      const id = v8SymbolNodeId(file.relPath, sym.qualifiedName);
      nodes.set(id, { id, kind: 'symbol', file: file.relPath, symbol: sym.qualifiedName, score: 0 });
      const shortName = sym.name;
      const list = byShortName.get(shortName) ?? [];
      list.push({ file: file.relPath, qualified: sym.qualifiedName });
      byShortName.set(shortName, list);
    }
  }

  let ambiguousSkipped = 0;
  const ambiguousNames = new Set<string>();
  for (const [name, list] of byShortName) {
    const files = new Set(list.map((l) => l.file));
    if (files.size > maxTargets) {
      ambiguousNames.add(name);
      ambiguousSkipped += 1;
    }
  }

  for (const file of input.files) {
    const fileId = v8FileNodeId(file.relPath);
    for (const sym of file.symbols) {
      const symId = v8SymbolNodeId(file.relPath, sym.qualifiedName);
      pushEdge(symId, fileId, 'defines');
      pushEdge(fileId, symId, 'contains');
    }
    for (const imp of file.imports) {
      if (imp.resolved) pushEdge(fileId, v8FileNodeId(imp.resolved), 'imports');
    }
    // Calls: caller symbol → callee symbol (resolve tên ngắn).
    for (const call of file.calls) {
      const callerId = call.caller
        ? v8SymbolNodeId(file.relPath, call.caller)
        : fileId;
      if (!nodes.has(callerId)) continue;
      const targets = byShortName.get(call.calleeName) ?? [];
      if (targets.length === 0) continue;
      if (ambiguousNames.has(call.calleeName)) continue;
      // Ưu tiên callee cùng file; nếu không, nối khi chỉ có 1 target.
      const sameFile = targets.filter((t) => t.file === file.relPath);
      if (sameFile.length === 1) {
        pushEdge(callerId, v8SymbolNodeId(sameFile[0]?.file ?? '', sameFile[0]?.qualified ?? ''), 'calls');
      } else if (sameFile.length > 1) {
        // Trùng tên trong cùng file (overload): nối target đầu tiên, ghi chú bằng cạnh nhẹ.
        pushEdge(callerId, v8SymbolNodeId(sameFile[0]?.file ?? '', sameFile[0]?.qualified ?? ''), 'calls');
      } else if (targets.length === 1) {
        pushEdge(callerId, v8SymbolNodeId(targets[0]?.file ?? '', targets[0]?.qualified ?? ''), 'calls');
      }
      // Nhiều target khác file, không cùng file → bỏ (mơ hồ), references fallback sẽ xử lý ở mức file.
    }
    // References fallback: file → symbol theo tên call không resolve được.
    const referencedNames = new Set(file.calls.map((c) => c.calleeName));
    for (const name of referencedNames) {
      if (ambiguousNames.has(name)) continue;
      const targets = byShortName.get(name) ?? [];
      for (const t of targets) {
        if (t.file === file.relPath) continue;
        pushEdge(fileId, v8SymbolNodeId(t.file, t.qualified), 'references');
      }
    }
  }

  const nodeIds = [...nodes.keys()];
  const { scores, iterations, delta } = v8PageRank(nodeIds, edges);
  for (const [id, score] of scores) {
    const node = nodes.get(id);
    if (node) node.score = score;
  }
  const fileScores = new Map<string, number>();
  const symbolScores = new Map<string, number>();
  for (const file of input.files) {
    let total = nodes.get(v8FileNodeId(file.relPath))?.score ?? 0;
    for (const sym of file.symbols) {
      total += nodes.get(v8SymbolNodeId(file.relPath, sym.qualifiedName))?.score ?? 0;
    }
    fileScores.set(file.relPath, total);
  }
  let fileTotal = 0;
  for (const v of fileScores.values()) fileTotal += v;
  if (fileTotal > 0) {
    for (const [k, v] of fileScores) fileScores.set(k, v / fileTotal);
  }
  let symTotal = 0;
  for (const node of nodes.values()) {
    if (node.kind === 'symbol') {
      symbolScores.set(node.id, node.score);
      symTotal += node.score;
    }
  }
  if (symTotal > 0) {
    for (const [k, v] of symbolScores) symbolScores.set(k, v / symTotal);
  }
  const edgesByKind: Record<V8EdgeKind, number> = { defines: 0, imports: 0, calls: 0, references: 0, contains: 0 };
  for (const e of edges) edgesByKind[e.kind] += 1;
  const stats: V8GraphStats = {
    files: input.files.length,
    symbols: [...nodes.values()].filter((n) => n.kind === 'symbol').length,
    edges: edges.length,
    edgesByKind,
    ambiguousSymbolsSkipped: ambiguousSkipped,
    pageRankIterations: iterations,
    pageRankDelta: delta,
  };
  return { nodes, edges, fileScores, symbolScores, stats };
}

/** Xếp hạng file theo điểm (cao → thấp). */
export function rankV8Files(graph: V8Graph, limit = V8_QUERY_DEFAULT_LIMIT): V8RepoQueryHit[] {
  return [...graph.fileScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, score]) => ({ nodeId: v8FileNodeId(file), kind: 'file' as const, file, score, reasons: ['pagerank'] }));
}

/** Xếp hạng symbol theo điểm (cao → thấp). */
export function rankV8Symbols(graph: V8Graph, limit = V8_QUERY_DEFAULT_LIMIT): V8RepoQueryHit[] {
  return [...graph.symbolScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([nodeId, score]) => {
      const parsed = v8ParseSymbolNodeId(nodeId);
      return { nodeId, kind: 'symbol' as const, file: parsed?.file ?? '', symbol: parsed?.symbol, score, reasons: ['pagerank'] };
    });
}

/** Các symbol gọi tới symbol cho trước (ngược call graph). */
export function callersOfV8(graph: V8Graph, symbolNodeId: string): string[] {
  const out: string[] = [];
  for (const e of graph.edges) {
    if (e.kind === 'calls' && e.to === symbolNodeId) out.push(e.from);
  }
  return [...new Set(out)];
}

/** Các symbol được symbol cho trước gọi tới. */
export function calleesOfV8(graph: V8Graph, symbolNodeId: string): string[] {
  const out: string[] = [];
  for (const e of graph.edges) {
    if (e.kind === 'calls' && e.from === symbolNodeId) out.push(e.to);
  }
  return [...new Set(out)];
}

/** File nào import file cho trước. */
export function importersOfV8(graph: V8Graph, relPath: string): string[] {
  const target = v8FileNodeId(relPath);
  const out: string[] = [];
  for (const e of graph.edges) {
    if (e.kind === 'imports' && e.to === target) out.push(e.from.replace(/^file:/, ''));
  }
  return [...new Set(out)];
}

export interface V8QueryOptions {
  limit?: number;
  /** Trọng số personalization dồn vào node khớp tên query (0..1). */
  personalizationWeight?: number;
}

/**
 * Query top symbol/file liên quan tới task: chạy PageRank có
 * personalization dồn vào node có tên/file khớp từ khóa query, rồi
 * xếp hạng; mỗi hit kèm `reasons` (name-match / import / call /
 * pagerank). Query rỗng → xếp hạng toàn cục.
 */
export function queryV8Repo(graph: V8Graph, query: string, options: V8QueryOptions = {}): V8RepoQueryResult {
  const limit = options.limit ?? V8_QUERY_DEFAULT_LIMIT;
  const personalizationWeight = options.personalizationWeight ?? 0.5;
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length >= 2);
  const matched = new Set<string>();
  const reasonsByNode = new Map<string, string[]>();
  const addReason = (nodeId: string, reason: string): void => {
    const list = reasonsByNode.get(nodeId) ?? [];
    if (!list.includes(reason)) list.push(reason);
    reasonsByNode.set(nodeId, list);
  };
  if (terms.length > 0) {
    for (const node of graph.nodes.values()) {
      const haystack = `${node.file} ${node.symbol ?? ''}`.toLowerCase();
      for (const term of terms) {
        if (haystack.includes(term)) {
          matched.add(node.id);
          addReason(node.id, 'name-match');
          break;
        }
      }
    }
    // Node kề với node khớp qua call/import cũng liên quan.
    for (const e of graph.edges) {
      if ((e.kind === 'calls' || e.kind === 'imports') && matched.has(e.from) && !matched.has(e.to)) {
        addReason(e.to, e.kind === 'calls' ? 'called-by-match' : 'imported-by-match');
      }
      if ((e.kind === 'calls' || e.kind === 'imports') && matched.has(e.to) && !matched.has(e.from)) {
        addReason(e.from, e.kind === 'calls' ? 'calls-match' : 'imports-match');
      }
    }
  }
  let symbolScores = graph.symbolScores;
  let fileScores = graph.fileScores;
  if (matched.size > 0) {
    // PageRank personalize: dồn personalizationWeight vào node khớp.
    const personalization = new Map<string, number>();
    for (const id of graph.nodes.keys()) {
      personalization.set(id, matched.has(id) ? personalizationWeight / matched.size : (1 - personalizationWeight) / graph.nodes.size);
    }
    const { scores } = v8PageRank([...graph.nodes.keys()], graph.edges, { personalization });
    const sym = new Map<string, number>();
    const fil = new Map<string, number>();
    for (const [id, score] of scores) {
      const node = graph.nodes.get(id);
      if (!node) continue;
      if (node.kind === 'symbol') sym.set(id, score);
      else fil.set(node.file, (fil.get(node.file) ?? 0) + score);
    }
    let symTotal = 0;
    for (const v of sym.values()) symTotal += v;
    if (symTotal > 0) for (const [k, v] of sym) sym.set(k, v / symTotal);
    let filTotal = 0;
    for (const v of fil.values()) filTotal += v;
    if (filTotal > 0) for (const [k, v] of fil) fil.set(k, v / filTotal);
    symbolScores = sym;
    fileScores = fil;
  }
  const normalize = (hits: V8RepoQueryHit[]): V8RepoQueryHit[] => {
    const total = hits.reduce((sum, h) => sum + h.score, 0);
    if (total <= 0) return hits;
    return hits.map((h) => ({ ...h, score: h.score / total }));
  };
  const symbols = normalize(
    [...symbolScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([nodeId, score]) => {
        const parsed = v8ParseSymbolNodeId(nodeId);
        const reasons = reasonsByNode.get(nodeId) ?? ['pagerank'];
        return { nodeId, kind: 'symbol' as const, file: parsed?.file ?? '', symbol: parsed?.symbol, score, reasons };
      }),
  );
  const files = normalize(
    [...fileScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([file, score]) => {
        const reasons = reasonsByNode.get(v8FileNodeId(file)) ?? ['pagerank'];
        return { nodeId: v8FileNodeId(file), kind: 'file' as const, file, score, reasons };
      }),
  );
  return { query, symbols, files, nodesConsidered: graph.nodes.size };
}

// ---------------------------------------------------------------------------
// RepoMap v3: quét thư mục + incremental update + cache đĩa
// ---------------------------------------------------------------------------

/** File nào được quét vào repo map (TS/JS/Python, bỏ node_modules/dist/.git...). */
export const V8_REPO_MAP_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const V8_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', '__pycache__', '.venv', 'venv']);

export interface V8ScanOptions {
  /** Số file tối đa quét (mặc định 5000). */
  maxFiles?: number;
}

/** Quét thư mục đệ quy, trả danh sách path repo-relative. */
export function scanV8RepoFiles(rootDir: string, options: V8ScanOptions = {}): string[] {
  const maxFiles = options.maxFiles ?? 5000;
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (V8_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        if (V8_REPO_MAP_EXTENSIONS.has(path.extname(entry.name))) {
          out.push(rel ? `${rel}/${entry.name}` : entry.name);
        }
      }
    }
  };
  walk(rootDir, '');
  return out.sort();
}

/** Entry cache đĩa của một file đã parse. */
export interface V8RepoCacheFile {
  version: number;
  files: Record<string, V8ParsedFile>;
}

/** Kết quả incremental update. */
export interface V8IncrementalResult {
  graph: V8Graph;
  /** File parse lại (nội dung đổi / file mới). */
  reparsed: string[];
  /** File tái dùng từ cache (hash khớp). */
  reused: string[];
  /** File đã xóa khỏi repo. */
  removed: string[];
  /** Số node tính lại PageRank trong subgraph bị ảnh hưởng. */
  subgraphNodesRecomputed: number;
}

/**
 * Repo map v3 có trạng thái: giữ cache parse theo content hash,
 * `updateFiles()` chỉ parse lại file đổi, `rebuild()` dựng lại graph
 * đầy đủ, `query()` dùng graph hiện tại.
 */
export class V8RepoMap {
  readonly rootDir: string;
  private parsed = new Map<string, V8ParsedFile>();
  private graph: V8Graph | null = null;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** Số file đã parse trong cache. */
  get fileCount(): number {
    return this.parsed.size;
  }

  /** Graph hiện tại (null khi chưa build). */
  currentGraph(): V8Graph | null {
    return this.graph;
  }

  /** Đọc + parse một file từ đĩa (trả null khi không đọc được). */
  readAndParse(relPath: string, knownFiles: ReadonlySet<string>): V8ParsedFile | null {
    let content: string;
    try {
      content = fs.readFileSync(path.join(this.rootDir, relPath), 'utf8');
    } catch {
      return null;
    }
    return v8ParseFile(relPath, content, knownFiles);
  }

  /**
   * Incremental update: cho danh sách file hiện có trên đĩa, chỉ
   * parse lại file có content hash đổi (hoặc file mới), tái dùng file
   * cũ khi hash khớp, bỏ file đã xóa. Sau đó dựng lại graph đầy đủ
   * (rẻ: parse mới là phần đắt) và tính PageRank lại trên subgraph bị
   * ảnh hưởng để báo số node tính lại — điểm cuối cùng vẫn là
   * PageRank đầy đủ (chính xác), subgraph chỉ dùng để đo ảnh hưởng.
   */
  updateFiles(relPaths: readonly string[]): V8IncrementalResult {
    const known = new Set(relPaths);
    const reparsed: string[] = [];
    const reused: string[] = [];
    const removed: string[] = [];
    for (const [relPath] of this.parsed) {
      if (!known.has(relPath)) removed.push(relPath);
    }
    for (const relPath of removed) this.parsed.delete(relPath);
    for (const relPath of relPaths) {
      const existing = this.parsed.get(relPath);
      let content: string;
      try {
        content = fs.readFileSync(path.join(this.rootDir, relPath), 'utf8');
      } catch {
        continue;
      }
      // So hash trước khi parse: hash khớp → tái dùng, không parse lại.
      const freshHash = createHash('sha256').update(content, 'utf8').digest('hex');
      if (existing && existing.contentHash === freshHash) {
        reused.push(relPath);
        continue;
      }
      const parsed = v8ParseFile(relPath, content, known);
      this.parsed.set(relPath, parsed);
      reparsed.push(relPath);
    }
    const files = [...this.parsed.values()];
    const newGraph = buildV8Graph({ files });
    // Subgraph bị ảnh hưởng: file đổi + file import/call nó (1 hop).
    const affected = new Set<string>();
    for (const relPath of reparsed) {
      affected.add(v8FileNodeId(relPath));
      for (const e of newGraph.edges) {
        if (e.to === v8FileNodeId(relPath)) affected.add(e.from);
        if (e.from === v8FileNodeId(relPath)) affected.add(e.to);
      }
    }
    this.graph = newGraph;
    return {
      graph: newGraph,
      reparsed: reparsed.sort(),
      reused: reused.sort(),
      removed: removed.sort(),
      subgraphNodesRecomputed: affected.size,
    };
  }

  /** Quét thư mục root rồi update (tiện cho agent/tool). */
  scanAndUpdate(options: V8ScanOptions = {}): V8IncrementalResult {
    return this.updateFiles(scanV8RepoFiles(this.rootDir, options));
  }

  /** Query trên graph hiện tại (throw khi chưa build). */
  query(query: string, options?: { limit?: number }): V8RepoQueryResult {
    if (!this.graph) throw new Error('V8RepoMap: chưa build graph — gọi scanAndUpdate() trước');
    return queryV8Repo(this.graph, query, options);
  }

  /** Lưu cache parse xuống đĩa (JSON versioned). */
  saveCache(cachePath: string): void {
    const data: V8RepoCacheFile = { version: V8_CACHE_VERSION, files: Object.fromEntries(this.parsed) };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  /** Nạp cache parse từ đĩa (bỏ qua file version khác). Trả số file nạp được. */
  loadCache(cachePath: string): number {
    let data: V8RepoCacheFile;
    try {
      data = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as V8RepoCacheFile;
    } catch {
      return 0;
    }
    if (data.version !== V8_CACHE_VERSION || !data.files) return 0;
    let loaded = 0;
    for (const [relPath, parsed] of Object.entries(data.files)) {
      if (parsed && parsed.relPath === relPath) {
        this.parsed.set(relPath, parsed);
        loaded += 1;
      }
    }
    return loaded;
  }

  /** Liệt kê file đã parse (để test/debug). */
  parsedFiles(): V8ParsedFile[] {
    return [...this.parsed.values()];
  }
}
