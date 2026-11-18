/**
 * Coding agent v11 — call graph + PageRank v2 (repo map v4).
 *
 * Trên nền repo map v3 của v8 (graph import/call + PageRank có trọng
 * số, query có reasons) và tóm tắt phân cấp của v10: v11 thêm ĐỒ THỊ
 * LỜI GỌI HÀM ở mức symbol với resolve theo import, và PageRank v2:
 *
 * - Resolve call theo import: một call `save()` được nối tới symbol
 *   `save` ở file NÀO mà file gọi đã import (hoặc cùng file), chỉ
 *   fallback tên ngắn duy nhất khi không có import; call không
 *   resolve được vẫn ghi lại (`unresolved`) thay vì nối nhầm như v8
 *   (v8 báo `ambiguousSymbolsSkipped`, v11 ghi rõ từng call chưa
 *   resolve để refactor kiểm tra được).
 * - PageRank v2: power iteration có trọng số theo số lần gọi (cùng
 *   caller gọi callee nhiều lần = cạnh nặng hơn) + personalization
 *   theo truy vấn (teleport về node khớp query) để `queryMap` xếp
 *   hạng theo đúng task, không chỉ xếp hạng toàn cục.
 * - HITS hub/authority: hub = symbol gọi nhiều symbol quan trọng
 *   (điểm vào tốt để hiểu luồng), authority = symbol được nhiều
 *   symbol quan trọng gọi (core utility) — xếp hạng 2 chiều, phân
 *   biệt "hàm trung tâm điều phối" với "hàm tiện ích lõi".
 * - Impact set: đổi một symbol thì ai bị ảnh hưởng (caller đệ quy,
 *   kèm độ sâu) — để refactor v11 biết phải kiểm tra những file nào.
 * - Chu trình: Tarjan SCC tìm nhóm symbol gọi vòng nhau (cảnh báo
 *   khi refactor/tách file).
 *
 * Giới hạn trung thực: resolve vẫn dựa trên phân tích tĩnh (parser
 * regex của v8) — gọi động (`obj[method]()`, `eval`, re-export
 * qua barrel) có thể không resolve; `unresolvedCalls` báo rõ số
 * lượng để caller không tin mù.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { v8ParseFile } from '../codingV8/parser';
import { scanV8RepoFiles } from '../codingV8/repoMap';
import type { V8ParsedFile } from '../codingV8/types';
import { CodingV11Error } from './types';
import type {
  V11CallCycle,
  V11CallEdge,
  V11CallGraphData,
  V11CallGraphStats,
  V11FileRank,
  V11ImpactSet,
  V11QueryMapHit,
  V11QueryMapResult,
  V11SymbolRank,
} from './types';

/** Hệ số damping PageRank v2. */
export const V11_PAGERANK_DAMPING = 0.85;
/** Số vòng power iteration tối đa (PageRank + HITS). */
export const V11_PAGERANK_MAX_ITERATIONS = 80;
/** Ngưỡng hội tụ: max |delta| nhỏ hơn thì dừng. */
export const V11_PAGERANK_EPSILON = 1e-7;
/** Độ sâu tối đa khi đi impact set (tránh đệ quy vô hạn trên graph lớn). */
export const V11_IMPACT_MAX_DEPTH = 6;
/** Số kết quả tối đa mặc định của queryMap. */
export const V11_QUERY_MAP_DEFAULT_LIMIT = 10;

/** Ngắn tên của một callee (`fs.readFile` → `readFile`, `save` → `save`). */
export function v11ShortName(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1] as string;
}

/** Chạy PageRank có trọng số trên đồ thị symbol (cạnh caller → callee). */
export function v11PageRankV2(
  nodes: readonly string[],
  edges: readonly { from: string; to: string; weight: number }[],
  options: { damping?: number; maxIterations?: number; epsilon?: number; personalization?: Map<string, number> } = {},
): { scores: Map<string, number>; iterations: number; delta: number } {
  const damping = options.damping ?? V11_PAGERANK_DAMPING;
  const maxIterations = options.maxIterations ?? V11_PAGERANK_MAX_ITERATIONS;
  const epsilon = options.epsilon ?? V11_PAGERANK_EPSILON;
  const n = nodes.length;
  const scores = new Map<string, number>();
  if (n === 0) return { scores, iterations: 0, delta: 0 };
  const index = new Map(nodes.map((id, i) => [id, i]));
  // Trọng số cạnh ra của mỗi node (để chuẩn hoá).
  const outWeight = new Array<number>(n).fill(0);
  const adjacency: Array<Array<{ to: number; weight: number }>> = nodes.map(() => []);
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || edge.weight <= 0) continue;
    adjacency[from]?.push({ to, weight: edge.weight });
    outWeight[from] = (outWeight[from] ?? 0) + edge.weight;
  }
  // Vector teleport (personalization hoặc đều).
  const teleport = new Array<number>(n).fill(1 / n);
  if (options.personalization && options.personalization.size > 0) {
    let total = 0;
    for (const v of options.personalization.values()) total += Math.max(0, v);
    for (let i = 0; i < n; i++) {
      const w = options.personalization.get(nodes[i] as string) ?? 0;
      teleport[i] = total > 0 ? Math.max(0, w) / total : 1 / n;
    }
  }
  let current = [...teleport];
  let iterations = 0;
  let delta = Number.POSITIVE_INFINITY;
  for (let iter = 0; iter < maxIterations && delta > epsilon; iter++) {
    const next = new Array<number>(n).fill(0);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if ((outWeight[i] ?? 0) === 0) danglingMass += current[i] as number;
    }
    for (let i = 0; i < n; i++) {
      // Teleport + phần dangling chia đều.
      next[i] = (1 - damping) * (teleport[i] as number) + damping * (danglingMass / n);
    }
    for (let i = 0; i < n; i++) {
      const out = outWeight[i] ?? 0;
      if (out === 0) continue;
      for (const { to, weight } of adjacency[i] as Array<{ to: number; weight: number }>) {
        next[to] = (next[to] as number) + damping * ((current[i] as number) * weight) / out;
      }
    }
    delta = 0;
    for (let i = 0; i < n; i++) delta = Math.max(delta, Math.abs((next[i] as number) - (current[i] as number)));
    current = next;
    iterations = iter + 1;
  }
  for (let i = 0; i < n; i++) scores.set(nodes[i] as string, current[i] as number);
  return { scores, iterations, delta };
}

/** Chạy HITS (hub/authority) trên đồ thị symbol. */
export function v11Hits(
  nodes: readonly string[],
  edges: readonly { from: string; to: string; weight: number }[],
  options: { maxIterations?: number; epsilon?: number } = {},
): { hubs: Map<string, number>; authorities: Map<string, number>; iterations: number } {
  const maxIterations = options.maxIterations ?? V11_PAGERANK_MAX_ITERATIONS;
  const epsilon = options.epsilon ?? V11_PAGERANK_EPSILON;
  const n = nodes.length;
  const hubs = new Map<string, number>();
  const authorities = new Map<string, number>();
  if (n === 0) return { hubs, authorities, iterations: 0 };
  const index = new Map(nodes.map((id, i) => [id, i]));
  const outEdges: Array<Array<{ to: number; weight: number }>> = nodes.map(() => []);
  const inEdges: Array<Array<{ from: number; weight: number }>> = nodes.map(() => []);
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || edge.weight <= 0) continue;
    outEdges[from]?.push({ to, weight: edge.weight });
    inEdges[to]?.push({ from, weight: edge.weight });
  }
  let hub = new Array<number>(n).fill(1 / n);
  let auth = new Array<number>(n).fill(1 / n);
  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    const nextAuth = new Array<number>(n).fill(0);
    const nextHub = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (const { from, weight } of inEdges[i] as Array<{ from: number; weight: number }>) {
        nextAuth[i] = (nextAuth[i] as number) + (hub[from] as number) * weight;
      }
    }
    for (let i = 0; i < n; i++) {
      for (const { to, weight } of outEdges[i] as Array<{ to: number; weight: number }>) {
        nextHub[i] = (nextHub[i] as number) + (nextAuth[to] as number) * weight;
      }
    }
    const normAuth = Math.sqrt(nextAuth.reduce((s, v) => s + v * v, 0)) || 1;
    const normHub = Math.sqrt(nextHub.reduce((s, v) => s + v * v, 0)) || 1;
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const a = (nextAuth[i] as number) / normAuth;
      const h = (nextHub[i] as number) / normHub;
      delta = Math.max(delta, Math.abs(a - (auth[i] as number)), Math.abs(h - (hub[i] as number)));
      nextAuth[i] = a;
      nextHub[i] = h;
    }
    auth = nextAuth;
    hub = nextHub;
    iterations = iter + 1;
    if (delta < epsilon) break;
  }
  for (let i = 0; i < n; i++) {
    hubs.set(nodes[i] as string, hub[i] as number);
    authorities.set(nodes[i] as string, auth[i] as number);
  }
  return { hubs, authorities, iterations };
}

/** Tarjan SCC: trả các thành phần có chu trình (>1 node hoặc self-loop). */
export function v11FindCycles(
  nodes: readonly string[],
  edges: readonly { from: string; to: string }[],
): V11CallCycle[] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
  }
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const cycles: V11CallCycle[] = [];
  const strongconnect = (v: string): void => {
    indexOf.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) as number, lowlink.get(w) as number));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) as number, indexOf.get(w) as number));
      }
    }
    if (lowlink.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      let w = '';
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      const selfLoop = component.length === 1 && (adjacency.get(component[0] as string) ?? []).includes(component[0] as string);
      if (component.length > 1 || selfLoop) {
        cycles.push({ members: component.sort(), files: [] });
      }
    }
  };
  for (const node of nodes) {
    if (!indexOf.has(node)) strongconnect(node);
  }
  return cycles;
}

export interface V11CallGraphOptions {
  /** Số file tối đa quét (mặc định không giới hạn). */
  maxFiles?: number;
}

/**
 * Call graph v11: parse repo bằng parser v8, resolve call theo
 * import, chạy PageRank v2 + HITS, xếp hạng file/symbol.
 */
export class V11CallGraph {
  readonly rootDir: string;
  private parsedFiles: V8ParsedFile[] = [];
  private graph: V11CallGraphData | null = null;
  /** Cạnh call đã resolve (để callersOf/calleesOf/impactSet dùng). */
  private edges: V11CallEdge[] = [];
  /** Id symbol = `file#qualifiedName`. */
  private symbolIds = new Map<string, string>();

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** Call graph hiện tại (null khi chưa build). */
  current(): V11CallGraphData | null {
    return this.graph;
  }

  /** Số file đã parse. */
  get fileCount(): number {
    return this.parsedFiles.length;
  }

  /** Quét thư mục + build toàn bộ call graph (lần đầu). */
  scanAndBuild(options: V11CallGraphOptions = {}): V11CallGraphData {
    const relPaths = scanV8RepoFiles(this.rootDir, options.maxFiles ? { maxFiles: options.maxFiles } : {});
    return this.buildFromFiles(relPaths);
  }

  /** Build call graph từ danh sách file repo-relative. */
  buildFromFiles(relPaths: readonly string[]): V11CallGraphData {
    const knownFiles = new Set(relPaths);
    this.parsedFiles = relPaths.map((rel) => {
      let content = '';
      try {
        content = fs.readFileSync(path.join(this.rootDir, rel), 'utf8');
      } catch {
        content = '';
      }
      return v8ParseFile(rel, content, knownFiles);
    });
    return this.buildFromParsed(this.parsedFiles);
  }

  /** Build call graph từ file đã parse sẵn (tiện cho test/tools). */
  buildFromParsed(files: readonly V8ParsedFile[]): V11CallGraphData {
    this.parsedFiles = [...files];
    this.edges = this.resolveCalls(files);
    const symbolNodes = new Map<string, { file: string; qualifiedName: string; kind: string; line: number; exported: boolean }>();
    for (const file of files) {
      for (const sym of file.symbols) {
        const id = `${file.relPath}#${sym.qualifiedName}`;
        this.symbolIds.set(`${file.relPath}:${sym.qualifiedName}`, id);
        symbolNodes.set(id, {
          file: file.relPath,
          qualifiedName: sym.qualifiedName,
          kind: sym.kind,
          line: sym.line,
          exported: sym.exported,
        });
      }
    }
    const nodeIds = [...symbolNodes.keys()];
    // Trọng số cạnh = số lần gọi (cùng caller gọi callee nhiều lần = nặng hơn).
    const edgeWeights = new Map<string, number>();
    for (const edge of this.edges) {
      const key = `${edge.callerFile}#${edge.caller}\u0000${edge.calleeFile}#${edge.callee}`;
      edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
    }
    const weightedEdges = [...edgeWeights.entries()].map(([key, weight]) => {
      const [from, to] = key.split('\u0000');
      return { from: from as string, to: to as string, weight };
    });
    const { scores, iterations, delta } = v11PageRankV2(nodeIds, weightedEdges);
    const { hubs, authorities, iterations: hitsIterations } = v11Hits(nodeIds, weightedEdges);
    const callerCount = new Map<string, number>();
    const calleeCount = new Map<string, number>();
    for (const edge of this.edges) {
      const callerId = `${edge.callerFile}#${edge.caller}`;
      const calleeId = `${edge.calleeFile}#${edge.callee}`;
      if (edge.caller !== '') callerCount.set(callerId, (callerCount.get(callerId) ?? 0) + 1);
      calleeCount.set(calleeId, (calleeCount.get(calleeId) ?? 0) + 1);
    }
    const symbols: V11SymbolRank[] = nodeIds
      .map((id) => {
        const info = symbolNodes.get(id) as { file: string; qualifiedName: string; kind: string; line: number; exported: boolean };
        return {
          qualifiedName: info.qualifiedName,
          file: info.file,
          kind: info.kind,
          line: info.line,
          exported: info.exported,
          pageRank: scores.get(id) ?? 0,
          hub: hubs.get(id) ?? 0,
          authority: authorities.get(id) ?? 0,
          callerCount: callerCount.get(id) ?? 0,
          calleeCount: calleeCount.get(id) ?? 0,
        };
      })
      .sort((a, b) => b.pageRank - a.pageRank);
    // Xếp hạng file: tổng điểm symbol + số file import nó.
    const fileScore = new Map<string, { pageRank: number; hub: number; authority: number; symbols: number }>();
    for (const sym of symbols) {
      const agg = fileScore.get(sym.file) ?? { pageRank: 0, hub: 0, authority: 0, symbols: 0 };
      agg.pageRank += sym.pageRank;
      agg.hub += sym.hub;
      agg.authority += sym.authority;
      agg.symbols += 1;
      fileScore.set(sym.file, agg);
    }
    const importedBy = new Map<string, number>();
    const importsOf = new Map<string, number>();
    for (const file of files) {
      const resolved = new Set(file.imports.map((i) => i.resolved).filter((r): r is string => r !== null));
      importsOf.set(file.relPath, resolved.size);
      for (const target of resolved) importedBy.set(target, (importedBy.get(target) ?? 0) + 1);
    }
    const filePaths = new Set(files.map((f) => f.relPath));
    const fileRanks: V11FileRank[] = [...filePaths]
      .map((p) => {
        const agg = fileScore.get(p) ?? { pageRank: 0, hub: 0, authority: 0, symbols: 0 };
        return {
          path: p,
          pageRank: agg.pageRank,
          hub: agg.hub,
          authority: agg.authority,
          symbolCount: agg.symbols,
          importedByCount: importedBy.get(p) ?? 0,
          importsCount: importsOf.get(p) ?? 0,
        };
      })
      .sort((a, b) => b.pageRank - a.pageRank);
    const unresolvedCalls = this.edges.filter((e) => e.resolvedBy === 'unresolved').length;
    const cycles = v11FindCycles(
      nodeIds,
      this.edges
        .filter((e) => e.resolvedBy !== 'unresolved' && e.caller !== '')
        .map((e) => ({ from: `${e.callerFile}#${e.caller}`, to: `${e.calleeFile}#${e.callee}` })),
    );
    // Gắn file cho từng chu trình.
    const fileOfSymbol = new Map(nodeIds.map((id) => [id, id.split('#')[0] as string]));
    for (const cycle of cycles) {
      cycle.files = [...new Set(cycle.members.map((m) => fileOfSymbol.get(m) ?? ''))].filter(Boolean).sort();
    }
    const stats: V11CallGraphStats = {
      files: files.length,
      symbols: nodeIds.length,
      resolvedEdges: this.edges.length - unresolvedCalls,
      unresolvedCalls,
      pageRankIterations: iterations,
      pageRankDelta: delta,
      hitsIterations,
      cyclicComponents: cycles.length,
    };
    this.graph = {
      rootDir: this.rootDir,
      files: fileRanks,
      symbols,
      edges: this.edges,
      stats,
      builtAt: new Date().toISOString(),
    };
    this.cycles = cycles;
    return this.graph;
  }

  private cycles: V11CallCycle[] = [];

  /** Chu trình gọi nhau trong call graph (Tarjan SCC). */
  findCycles(): V11CallCycle[] {
    if (!this.graph) {
      throw new CodingV11Error('callgraph-not-built', 'V11CallGraph: chưa build — gọi scanAndBuild() trước.');
    }
    return this.cycles.map((c) => ({ members: [...c.members], files: [...c.files] }));
  }

  /** Top file theo PageRank v2. */
  rankFiles(limit = 10): V11FileRank[] {
    if (!this.graph) {
      throw new CodingV11Error('callgraph-not-built', 'V11CallGraph: chưa build — gọi scanAndBuild() trước.');
    }
    return this.graph.files.slice(0, Math.max(1, limit));
  }

  /** Top symbol theo PageRank v2. */
  rankSymbols(limit = 10): V11SymbolRank[] {
    if (!this.graph) {
      throw new CodingV11Error('callgraph-not-built', 'V11CallGraph: chưa build — gọi scanAndBuild() trước.');
    }
    return this.graph.symbols.slice(0, Math.max(1, limit));
  }

  /** Top symbol theo authority (được gọi nhiều) / hub (gọi nhiều). */
  rankByHub(limit = 10): V11SymbolRank[] {
    if (!this.graph) {
      throw new CodingV11Error('callgraph-not-built', 'V11CallGraph: chưa build — gọi scanAndBuild() trước.');
    }
    return [...this.graph.symbols].sort((a, b) => b.hub - a.hub).slice(0, Math.max(1, limit));
  }

  rankByAuthority(limit = 10): V11SymbolRank[] {
    if (!this.graph) {
      throw new CodingV11Error('callgraph-not-built', 'V11CallGraph: chưa build — gọi scanAndBuild() trước.');
    }
    return [...this.graph.symbols].sort((a, b) => b.authority - a.authority).slice(0, Math.max(1, limit));
  }

  /** Symbol nào gọi symbol này (kèm file + dòng gọi). */
  callersOf(qualifiedName: string, file?: string): V11CallEdge[] {
    if (!this.graph) {
      throw new CodingV11Error('callgraph-not-built', 'V11CallGraph: chưa build — gọi scanAndBuild() trước.');
    }
    const matches = this.edges.filter(
      (e) => e.callee === qualifiedName && (file === undefined || e.calleeFile === file),
    );
    if (matches.length === 0) {
      throw new CodingV11Error(
        'callgraph-symbol-not-found',
        `V11CallGraph: không tìm thấy symbol "${qualifiedName}"${file ? ` trong ${file}` : ''}.`,
      );
    }
    return matches;
  }

  /** Symbol này gọi những symbol nào. */
  calleesOf(qualifiedName: string, file?: string): V11CallEdge[] {
    if (!this.graph) {
      throw new CodingV11Error('callgraph-not-built', 'V11CallGraph: chưa build — gọi scanAndBuild() trước.');
    }
    const matches = this.edges.filter(
      (e) => e.caller === qualifiedName && (file === undefined || e.callerFile === file),
    );
    if (matches.length === 0 && !this.graph.symbols.some((s) => s.qualifiedName === qualifiedName)) {
      throw new CodingV11Error(
        'callgraph-symbol-not-found',
        `V11CallGraph: không tìm thấy symbol "${qualifiedName}"${file ? ` trong ${file}` : ''}.`,
      );
    }
    return matches;
  }

  /**
   * Impact set: mọi symbol gọi (trực tiếp/gián tiếp) tới symbol này
   * — đổi symbol này thì những symbol/file này có thể bị ảnh hưởng.
   */
  impactSet(qualifiedName: string, file?: string, maxDepth = V11_IMPACT_MAX_DEPTH): V11ImpactSet {
    if (!this.graph) {
      throw new CodingV11Error('callgraph-not-built', 'V11CallGraph: chưa build — gọi scanAndBuild() trước.');
    }
    const def = this.graph.symbols.find((s) => s.qualifiedName === qualifiedName && (file === undefined || s.file === file));
    if (!def) {
      throw new CodingV11Error(
        'callgraph-symbol-not-found',
        `V11CallGraph: không tìm thấy symbol "${qualifiedName}"${file ? ` trong ${file}` : ''}.`,
      );
    }
    // Đồ thị ngược: callee → caller.
    const reverse = new Map<string, Array<{ caller: string; file: string }>>();
    for (const edge of this.edges) {
      if (edge.resolvedBy === 'unresolved' || edge.caller === '') continue;
      const key = `${edge.calleeFile}#${edge.callee}`;
      const list = reverse.get(key) ?? [];
      list.push({ caller: edge.caller, file: edge.callerFile });
      reverse.set(key, list);
    }
    const affected = new Map<string, { qualifiedName: string; file: string; depth: number }>();
    const queue: Array<{ id: string; depth: number }> = [{ id: `${def.file}#${def.qualifiedName}`, depth: 0 }];
    const visited = new Set<string>([`${def.file}#${def.qualifiedName}`]);
    let maxDepthReached = 0;
    while (queue.length > 0) {
      const { id, depth } = queue.shift() as { id: string; depth: number };
      if (depth >= maxDepth) continue;
      for (const { caller, file: callerFile } of reverse.get(id) ?? []) {
        const callerId = `${callerFile}#${caller}`;
        if (visited.has(callerId)) continue;
        visited.add(callerId);
        affected.set(callerId, { qualifiedName: caller, file: callerFile, depth: depth + 1 });
        maxDepthReached = Math.max(maxDepthReached, depth + 1);
        queue.push({ id: callerId, depth: depth + 1 });
      }
    }
    const affectedSymbols = [...affected.values()].sort((a, b) => a.depth - b.depth || a.qualifiedName.localeCompare(b.qualifiedName));
    return {
      symbol: def.qualifiedName,
      file: def.file,
      affectedSymbols,
      affectedFiles: [...new Set(affectedSymbols.map((s) => s.file))].sort(),
      maxDepthReached,
    };
  }

  /**
   * Query map theo truy vấn: PageRank v2 personalize về node khớp
   * query + khớp tên, trả top file/symbol kèm reasons.
   */
  queryMap(query: string, limit = V11_QUERY_MAP_DEFAULT_LIMIT): V11QueryMapResult {
    if (!this.graph) {
      throw new CodingV11Error('callgraph-not-built', 'V11CallGraph: chưa build — gọi scanAndBuild() trước.');
    }
    const q = query.trim();
    if (q === '') {
      throw new CodingV11Error('callgraph-symbol-not-found', 'Query map rỗng.');
    }
    const lower = q.toLowerCase();
    const tokens = lower.split(/[^a-z0-9_]+/).filter(Boolean);
    const nodeIds = this.graph.symbols.map((s) => `${s.file}#${s.qualifiedName}`);
    // Personalization: symbol khớp token query được teleport weight cao.
    const personalization = new Map<string, number>();
    for (const sym of this.graph.symbols) {
      const id = `${sym.file}#${sym.qualifiedName}`;
      const nameLower = sym.qualifiedName.toLowerCase();
      let weight = 0;
      if (nameLower === lower) weight = 10;
      else if (nameLower.includes(lower)) weight = 6;
      else {
        for (const token of tokens) {
          if (token.length >= 3 && nameLower.includes(token)) weight += 2;
        }
      }
      if (weight > 0) personalization.set(id, weight);
    }
    const edgeWeights = new Map<string, number>();
    for (const edge of this.edges) {
      if (edge.resolvedBy === 'unresolved' || edge.caller === '') continue;
      const key = `${edge.callerFile}#${edge.caller}\u0000${edge.calleeFile}#${edge.callee}`;
      edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
    }
    const weightedEdges = [...edgeWeights.entries()].map(([key, weight]) => {
      const [from, to] = key.split('\u0000');
      return { from: from as string, to: to as string, weight };
    });
    const { scores } = v11PageRankV2(nodeIds, weightedEdges, { personalization });
    const scored: Array<{ hit: V11QueryMapHit; score: number }> = [];
    let searched = 0;
    for (const sym of this.graph.symbols) {
      searched += 1;
      const id = `${sym.file}#${sym.qualifiedName}`;
      const personalized = scores.get(id) ?? 0;
      const nameLower = sym.qualifiedName.toLowerCase();
      const reasons: string[] = [];
      let matchBonus = 0;
      if (nameLower === lower) {
        matchBonus = 1;
        reasons.push('exact name match');
      } else if (nameLower.includes(lower)) {
        matchBonus = 0.6;
        reasons.push('name contains query');
      } else if (tokens.some((t) => t.length >= 3 && nameLower.includes(t))) {
        matchBonus = 0.3;
        reasons.push('name token match');
      }
      if (personalized <= 0 && matchBonus === 0) continue;
      if (sym.exported) reasons.push('exported');
      if (sym.pageRank > 0) reasons.push(`pagerank ${sym.pageRank.toFixed(4)}`);
      const score = personalized * 10 + matchBonus;
      scored.push({
        hit: {
          kind: 'symbol',
          path: sym.file,
          symbol: sym.qualifiedName,
          score,
          pageRank: sym.pageRank,
          reasons,
        },
        score,
      });
    }
    // Thêm hit cấp file: file có symbol khớp query hoặc PageRank file cao.
    const fileScores = new Map<string, number>();
    for (const sym of this.graph.symbols) {
      const id = `${sym.file}#${sym.qualifiedName}`;
      const personalized = scores.get(id) ?? 0;
      fileScores.set(sym.file, (fileScores.get(sym.file) ?? 0) + personalized);
    }
    for (const file of this.graph.files) {
      searched += 1;
      const personalized = fileScores.get(file.path) ?? 0;
      if (personalized <= 0) continue;
      const reasons = [`pagerank ${file.pageRank.toFixed(4)}`];
      if (file.path.toLowerCase().includes(lower)) reasons.push('path matches query');
      scored.push({
        hit: { kind: 'file', path: file.path, score: personalized * 10, pageRank: file.pageRank, reasons },
        score: personalized * 10,
      });
    }
    scored.sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path));
    return { query: q, hits: scored.slice(0, Math.max(1, limit)).map((s) => s.hit), searched };
  }

  /**
   * Resolve call site thành cạnh call đã resolve (theo import).
   * Thứ tự ưu tiên: cùng file → import từ file khác → tên ngắn
   * duy nhất toàn repo → unresolved (ghi lại, không nối nhầm).
   */
  private resolveCalls(files: readonly V8ParsedFile[]): V11CallEdge[] {
    // Index: short name → symbol (file + qualified + exported).
    const byShort = new Map<string, Array<{ file: string; qualifiedName: string; exported: boolean }>>();
    // Index: file → symbol theo qualified name.
    const byFileAndName = new Map<string, Map<string, { qualifiedName: string; exported: boolean }>>();
    for (const file of files) {
      const perFile = new Map<string, { qualifiedName: string; exported: boolean }>();
      for (const sym of file.symbols) {
        perFile.set(sym.qualifiedName, { qualifiedName: sym.qualifiedName, exported: sym.exported });
        const short = v11ShortName(sym.qualifiedName);
        const list = byShort.get(short) ?? [];
        list.push({ file: file.relPath, qualifiedName: sym.qualifiedName, exported: sym.exported });
        byShort.set(short, list);
      }
      byFileAndName.set(file.relPath, perFile);
    }
    const edges: V11CallEdge[] = [];
    for (const file of files) {
      // Map tên import → file đã resolve (để resolve call qua import).
      const importTarget = new Map<string, string>();
      for (const imp of file.imports) {
        if (!imp.resolved) continue;
        for (const name of imp.names) {
          const short = v11ShortName(name);
          if (!importTarget.has(short)) importTarget.set(short, imp.resolved);
        }
      }
      for (const call of file.calls) {
        const short = v11ShortName(call.calleeName);
        const sameFile = byFileAndName.get(file.relPath)?.get(call.calleeName)
          ?? byFileAndName.get(file.relPath)?.get(short);
        if (sameFile) {
          edges.push({
            caller: call.caller,
            callerFile: file.relPath,
            callee: sameFile.qualifiedName,
            calleeFile: file.relPath,
            line: call.line,
            memberCall: call.memberCall,
            resolvedBy: 'same-file',
          });
          continue;
        }
        const importedFile = importTarget.get(short);
        if (importedFile) {
          const target = byFileAndName.get(importedFile)?.get(short)
            ?? byFileAndName.get(importedFile)?.get(call.calleeName);
          if (target) {
            edges.push({
              caller: call.caller,
              callerFile: file.relPath,
              callee: target.qualifiedName,
              calleeFile: importedFile,
              line: call.line,
              memberCall: call.memberCall,
              resolvedBy: 'import',
            });
            continue;
          }
        }
        const candidates = (byShort.get(short) ?? []).filter((c) => c.qualifiedName === short || v11ShortName(c.qualifiedName) === short);
        if (candidates.length === 1) {
          const only = candidates[0] as { file: string; qualifiedName: string };
          edges.push({
            caller: call.caller,
            callerFile: file.relPath,
            callee: only.qualifiedName,
            calleeFile: only.file,
            line: call.line,
            memberCall: call.memberCall,
            resolvedBy: 'unique-name',
          });
          continue;
        }
        edges.push({
          caller: call.caller,
          callerFile: file.relPath,
          callee: call.calleeName,
          calleeFile: '',
          line: call.line,
          memberCall: call.memberCall,
          resolvedBy: 'unresolved',
        });
      }
    }
    return edges;
  }
}

/** Build call graph nhanh từ file đã parse sẵn (không cần giữ class). */
export function v11BuildCallGraphFromParsed(files: readonly V8ParsedFile[], rootDir = ''): V11CallGraphData {
  const graph = new V11CallGraph(rootDir || process.cwd());
  return graph.buildFromParsed(files);
}
