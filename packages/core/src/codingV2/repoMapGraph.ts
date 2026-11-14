/**
 * Repo map v2 — symbol-level graph + PageRank (v1.08, Đội T2).
 *
 * Ý tưởng học từ Aider repo map (chỉ học ý tưởng, tự thiết kế và viết
 * lại hoàn toàn từ đầu — KHÔNG đọc, KHÔNG copy code/text/tài sản của
 * Aider hay bất kỳ repo nào khác). Khác với repo map v1 của open-bot
 * (`packages/tools/src/repoMap.ts` — đồ thị chỉ ở mức file, cache
 * parse chỉ sống trong bộ nhớ của process):
 *
 *   1. Đồ thị ở mức SYMBOL, không chỉ mức file. Node là file và
 *      symbol (hàm/class/method/interface/type/enum, tên đầy đủ theo
 *      scope). Cạnh có ba loại:
 *        - defines:    symbol -> file chứa nó (trọng số 1);
 *        - references: file -> symbol mà file đó nhắc tới theo tên
 *          (trọng số sqrt(số lần nhắc), chỉ cạnh khác file);
 *        - imports:    file -> file mà nó import trực tiếp (trọng số 2).
 *      Nhờ đó một file được xếp hạng cao không chỉ vì nhiều file
 *      import nó, mà vì các symbol nó định nghĩa được nhắc tới nhiều.
 *   2. PageRank có personalization theo truy vấn: "file nào liên quan
 *      nhất tới X" chạy PageRank với khối lượng dồn vào các file/symbol
 *      khớp X (tên file, tên symbol), thay vì chỉ xếp hạng toàn cục.
 *   3. Cập nhật TĂNG DẦN + cache TRÊN ĐĨA: mỗi file có fingerprint
 *      (mtimeMs, size); lần build sau chỉ parse lại file đổi/mới, bỏ
 *      file đã xoá, còn lại tái dùng entry đã parse trong cache JSON
 *      versioned. Đồ thị được dựng lại từ entry đã cache (rẻ — không
 *      cần parse lại), còn số lần nhắc ident được quét lại từ text
 *      file (rẻ hơn parse tree-sitter nhiều) nên luôn tươi.
 *
 * Module này thuần túy (không tree-sitter, không fs, không import từ
 * `@open-bot/tools`): việc quét file/parse symbol sống ở
 * `packages/tools/src/codingV2RepoMap.ts`, còn đây là thuật toán +
 * định dạng cache — test được mà không cần grammar WASM.
 *
 * Giới hạn trung thực:
 *   - references đếm theo tên ngắn (vd `save` khớp mọi symbol tên
 *     `save` ở mọi file). Tên mơ hồ (định nghĩa ở > 20 file) bị bỏ
 *     qua vì không mang tín hiệu — số lượng bỏ qua được báo rõ.
 *   - ident chỉ đếm bằng token identifier trên text (kể cả trong
 *     string/comment) nên có thể đếm thừa, giống v1.
 *   - tối đa 200.000 cạnh — vượt thì phần thừa bị lược và báo rõ.
 */

export const CODING_V2_DAMPING = 0.85;
/** Số vòng power iteration tối đa (dừng sớm khi hội tụ). */
export const CODING_V2_PAGERANK_ITERATIONS = 50;
/** Ngưỡng hội tụ: max |delta| nhỏ hơn thì dừng. */
export const CODING_V2_PAGERANK_EPSILON = 1e-6;
/** Tên symbol định nghĩa ở nhiều hơn số file này thì mơ hồ: bỏ cạnh references. */
export const CODING_V2_MAX_SYMBOL_TARGETS = 20;
/** Trần số cạnh trong đồ thị (chống blow-up trên repo rất lớn). */
export const CODING_V2_MAX_EDGES = 200_000;
/** Version của định dạng cache JSON trên đĩa. */
export const CODING_V2_CACHE_VERSION = 2;
/** Trọng số cạnh import file -> file. */
export const CODING_V2_IMPORT_EDGE_WEIGHT = 2;
/** Trọng số cạnh defines symbol -> file. */
export const CODING_V2_DEFINES_EDGE_WEIGHT = 1;

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------

export type CodingV2SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum';

/** Một symbol đã parse được trong một file. */
export interface CodingV2SymbolEntry {
  kind: CodingV2SymbolKind;
  /** Tên ngắn, vd `save`. */
  name: string;
  /** Tên đầy đủ theo scope, vd `Foo.save` hay `Outer.Inner`. */
  qualifiedName: string;
  /** Dòng bắt đầu, 1-based. */
  line: number;
  /** Cột bắt đầu, 1-based. */
  column: number;
  /** Dòng kết thúc, 1-based. */
  endLine: number;
}

/** Entry đã parse của một file, lưu trong cache đĩa. */
export interface CodingV2FileEntry {
  /** Đường dẫn tương đối so với root, dùng `/` làm separator. */
  relPath: string;
  language: string;
  mtimeMs: number;
  size: number;
  symbols: CodingV2SymbolEntry[];
  /** Import tương đối đã resolve thành đường dẫn repo-relative, chỉ giữ file tồn tại. */
  imports: string[];
  /** true khi file lỗi cú pháp nhưng vẫn parse được phần còn lại. */
  hasError: boolean;
}

export type CodingV2EdgeKind = 'defines' | 'references' | 'imports';

export interface CodingV2GraphEdge {
  from: string;
  to: string;
  weight: number;
  kind: CodingV2EdgeKind;
}

export interface CodingV2GraphNode {
  id: string;
  kind: 'file' | 'symbol';
  /** File chứa node (với node file thì chính nó). */
  file: string;
  /** Tên đầy đủ của symbol (chỉ node symbol). */
  symbol?: string;
  /** Điểm PageRank (chuẩn hoá: tổng mọi node = 1). */
  score: number;
}

/** Đồ thị đã dựng + điểm xếp hạng đã tính. */
export interface CodingV2Graph {
  nodes: Map<string, CodingV2GraphNode>;
  edges: CodingV2GraphEdge[];
  /** Điểm file = điểm node file + tổng điểm symbol nó định nghĩa (chuẩn hoá tổng = 1). */
  fileScores: Map<string, number>;
  /** Điểm symbol (chuẩn hoá tổng = 1 trên mọi symbol, 0 khi không có symbol nào). */
  symbolScores: Map<string, number>;
  stats: CodingV2GraphStats;
}

export interface CodingV2GraphStats {
  files: number;
  symbols: number;
  edges: number;
  definesEdges: number;
  referenceEdges: number;
  importEdges: number;
  /** Số tên ident mơ hồ (> MAX_SYMBOL_TARGETS file định nghĩa) bị bỏ qua. */
  ambiguousNamesSkipped: number;
  /** Số cạnh bị lược vì vượt trần MAX_EDGES. */
  edgesTruncated: number;
  /** Số vòng PageRank đã chạy (dừng sớm khi hội tụ). */
  pageRankIterations: number;
}

/** Fingerprint nhẹ của một file trên đĩa (để phân loại tăng dần). */
export interface CodingV2FileFingerprint {
  relPath: string;
  mtimeMs: number;
  size: number;
}

/** Kết quả phân loại tăng dần: file nào giữ, parse lại, thêm, bỏ. */
export interface CodingV2IncrementalPlan {
  unchanged: string[];
  changed: string[];
  added: string[];
  removed: string[];
}

/** Định dạng cache JSON trên đĩa. */
export interface CodingV2CacheFile {
  version: number;
  rootDir: string;
  updatedAt: string;
  files: Record<string, CodingV2FileEntry>;
}

// ---------------------------------------------------------------------------
// ID node
// ---------------------------------------------------------------------------

export function codingV2FileNodeId(relPath: string): string {
  return `f:${relPath}`;
}

export function codingV2SymbolNodeId(relPath: string, qualifiedName: string): string {
  return `s:${relPath}#${qualifiedName}`;
}

// ---------------------------------------------------------------------------
// PageRank (power iteration, tự viết)
// ---------------------------------------------------------------------------

export interface CodingV2PageRankOptions {
  damping?: number;
  maxIterations?: number;
  epsilon?: number;
  /** Khối lượng personalization theo node (tổng không cần = 1, sẽ chuẩn hoá). */
  personalization?: Map<string, number>;
}

/**
 * PageRank có trọng số trên đồ thị có hướng. Node không có cạnh ra
 * (dangling) phân phối điểm của nó đều cho mọi node mỗi vòng — cách
 * xử lý chuẩn để tổng điểm luôn = 1.
 */
export function codingV2PageRank(
  nodeIds: string[],
  edges: CodingV2GraphEdge[],
  options: CodingV2PageRankOptions = {},
): { scores: Map<string, number>; iterations: number } {
  const n = nodeIds.length;
  const scores = new Map<string, number>();
  if (n === 0) return { scores, iterations: 0 };
  const damping = options.damping ?? CODING_V2_DAMPING;
  const maxIterations = options.maxIterations ?? CODING_V2_PAGERANK_ITERATIONS;
  const epsilon = options.epsilon ?? CODING_V2_PAGERANK_EPSILON;

  const index = new Map(nodeIds.map((id, i) => [id, i] as const));
  const outWeight = new Array<number>(n).fill(0);
  const outgoing: Array<Array<{ to: number; weight: number }>> = nodeIds.map(() => []);
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || edge.weight <= 0) continue;
    outgoing[from]!.push({ to, weight: edge.weight });
    outWeight[from]! += edge.weight;
  }

  // Vector personalization, chuẩn hoá về tổng 1 (mặc định: đều).
  const personalization = new Array<number>(n).fill(1 / n);
  if (options.personalization && options.personalization.size > 0) {
    let total = 0;
    for (const [id, mass] of options.personalization) {
      const i = index.get(id);
      if (i !== undefined && mass > 0) total += mass;
    }
    if (total > 0) {
      personalization.fill(0);
      for (const [id, mass] of options.personalization) {
        const i = index.get(id);
        if (i !== undefined && mass > 0) personalization[i] = mass / total;
      }
    }
  }

  let rank = [...personalization];
  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    iterations = iter + 1;
    const next = new Array<number>(n).fill(0);
    let danglingMass = 0;
    for (let i = 0; i < n; i += 1) {
      const r = rank[i]!;
      if (outWeight[i]! === 0) {
        danglingMass += r;
        continue;
      }
      const share = (damping * r) / outWeight[i]!;
      for (const { to, weight } of outgoing[i]!) {
        next[to]! += share * weight;
      }
    }
    const danglingShare = (damping * danglingMass) / n;
    let maxDelta = 0;
    for (let i = 0; i < n; i += 1) {
      const value = next[i]! + danglingShare + (1 - damping) * personalization[i]!;
      maxDelta = Math.max(maxDelta, Math.abs(value - rank[i]!));
      next[i] = value;
    }
    rank = next;
    if (maxDelta < epsilon) break;
  }
  for (let i = 0; i < n; i += 1) scores.set(nodeIds[i]!, rank[i]!);
  return { scores, iterations };
}

// ---------------------------------------------------------------------------
// Dựng đồ thị symbol-level
// ---------------------------------------------------------------------------

export interface CodingV2GraphInput {
  files: CodingV2FileEntry[];
  /** Số lần nhắc ident theo file: relPath -> (ident -> count). */
  idents: Map<string, Map<string, number>>;
}

/**
 * Dựng đồ thị symbol-level từ entry đã parse + số lần nhắc ident.
 * Không parse gì thêm: mọi dữ liệu đầu vào đã có sẵn.
 */
export function buildCodingV2Graph(input: CodingV2GraphInput): CodingV2Graph {
  const nodes = new Map<string, CodingV2GraphNode>();
  const edges: CodingV2GraphEdge[] = [];
  let ambiguousNamesSkipped = 0;
  let edgesTruncated = 0;

  const pushEdge = (from: string, to: string, weight: number, kind: CodingV2EdgeKind): void => {
    if (edges.length >= CODING_V2_MAX_EDGES) {
      edgesTruncated += 1;
      return;
    }
    edges.push({ from, to, weight, kind });
  };

  // Chỉ mục tên ngắn -> symbol (để khớp ident nhắc tới).
  const byShortName = new Map<string, Array<{ nodeId: string; relPath: string }>>();
  const symbolFile = new Map<string, string>();
  for (const file of input.files) {
    const fileId = codingV2FileNodeId(file.relPath);
    nodes.set(fileId, { id: fileId, kind: 'file', file: file.relPath, score: 0 });
    for (const symbol of file.symbols) {
      const symbolId = codingV2SymbolNodeId(file.relPath, symbol.qualifiedName);
      nodes.set(symbolId, {
        id: symbolId,
        kind: 'symbol',
        file: file.relPath,
        symbol: symbol.qualifiedName,
        score: 0,
      });
      symbolFile.set(symbolId, file.relPath);
      const list = byShortName.get(symbol.name) ?? [];
      list.push({ nodeId: symbolId, relPath: file.relPath });
      byShortName.set(symbol.name, list);
      // defines: symbol -> file.
      pushEdge(symbolId, fileId, CODING_V2_DEFINES_EDGE_WEIGHT, 'defines');
    }
  }

  // imports: file -> file (chỉ file có trong map).
  for (const file of input.files) {
    const fromId = codingV2FileNodeId(file.relPath);
    for (const target of file.imports) {
      const toId = codingV2FileNodeId(target);
      if (target !== file.relPath && nodes.has(toId)) {
        pushEdge(fromId, toId, CODING_V2_IMPORT_EDGE_WEIGHT, 'imports');
      }
    }
  }

  // references: file -> symbol theo tên ngắn + số lần nhắc.
  for (const [relPath, counts] of input.idents) {
    const fromId = codingV2FileNodeId(relPath);
    if (!nodes.has(fromId)) continue;
    for (const [ident, count] of counts) {
      if (count <= 0) continue;
      const targets = byShortName.get(ident);
      if (!targets || targets.length === 0) continue;
      if (targets.length > CODING_V2_MAX_SYMBOL_TARGETS) {
        ambiguousNamesSkipped += 1;
        continue;
      }
      const weight = Math.sqrt(count);
      for (const target of targets) {
        if (target.relPath === relPath) continue; // tự nhắc mình: defines đã nối.
        pushEdge(fromId, target.nodeId, weight, 'references');
      }
    }
  }

  const nodeIds = [...nodes.keys()];
  const { scores, iterations } = codingV2PageRank(nodeIds, edges);

  const fileScores = new Map<string, number>();
  const symbolScores = new Map<string, number>();
  let fileTotal = 0;
  let symbolTotal = 0;
  for (const [id, node] of nodes) {
    node.score = scores.get(id) ?? 0;
    if (node.kind === 'file') {
      fileScores.set(node.file, node.score);
      fileTotal += node.score;
    } else {
      symbolScores.set(id, node.score);
      symbolTotal += node.score;
    }
  }
  // Cộng điểm symbol vào file định nghĩa nó, rồi chuẩn hoá tổng file = 1.
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

  let definesEdges = 0;
  let referenceEdges = 0;
  let importEdges = 0;
  for (const edge of edges) {
    if (edge.kind === 'defines') definesEdges += 1;
    else if (edge.kind === 'references') referenceEdges += 1;
    else importEdges += 1;
  }
  return {
    nodes,
    edges,
    fileScores,
    symbolScores,
    stats: {
      files: input.files.length,
      symbols: symbolScores.size,
      edges: edges.length,
      definesEdges,
      referenceEdges,
      importEdges,
      ambiguousNamesSkipped,
      edgesTruncated,
      pageRankIterations: iterations,
    },
  };
}

/** Xếp hạng file theo điểm (cao -> thấp). */
export function rankCodingV2Files(
  graph: CodingV2Graph,
  limit = 20,
): Array<{ relPath: string; score: number; rank: number }> {
  return [...graph.fileScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([relPath, score], i) => ({ relPath, score, rank: i + 1 }));
}

/** Xếp hạng symbol theo điểm (cao -> thấp). */
export function rankCodingV2Symbols(
  graph: CodingV2Graph,
  limit = 20,
): Array<{ nodeId: string; file: string; symbol: string; score: number; rank: number }> {
  return [...graph.symbolScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([nodeId, score], i) => {
      const node = graph.nodes.get(nodeId);
      return {
        nodeId,
        file: node?.file ?? '',
        symbol: node?.symbol ?? '',
        score,
        rank: i + 1,
      };
    });
}

// ---------------------------------------------------------------------------
// Truy vấn "file nào liên quan nhất tới X"
// ---------------------------------------------------------------------------

export interface CodingV2QueryFileHit {
  relPath: string;
  score: number;
  rank: number;
  /** 'seed' = khớp trực tiếp truy vấn; 'related' = PageRank kéo lên. */
  match: 'seed' | 'related';
  topSymbols: Array<{ name: string; qualifiedName: string; kind: CodingV2SymbolKind; line: number; score: number }>;
}

export interface CodingV2QuerySymbolHit {
  nodeId: string;
  file: string;
  name: string;
  qualifiedName: string;
  kind: CodingV2SymbolKind;
  line: number;
  score: number;
}

export interface CodingV2QueryResult {
  query: string;
  /** true khi truy vấn không khớp seed nào và rơi về xếp hạng toàn cục. */
  fellBackToGlobal: boolean;
  seedFiles: string[];
  seedSymbols: string[];
  files: CodingV2QueryFileHit[];
  symbols: CodingV2QuerySymbolHit[];
  totalFiles: number;
  totalSymbols: number;
}

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Truy vấn đồ thị: chạy Personalized PageRank với personalization dồn
 * vào file/symbol khớp truy vấn, rồi trả file xếp hạng cao nhất kèm
 * symbol nổi bật trong mỗi file. Truy vấn rỗng hoặc không khớp gì thì
 * trả xếp hạng toàn cục (fellBackToGlobal = true).
 */
export function queryCodingV2Graph(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  query: string,
  options: { limit?: number; symbolLimit?: number; topSymbolsPerFile?: number } = {},
): CodingV2QueryResult {
  const limit = options.limit ?? 10;
  const symbolLimit = options.symbolLimit ?? 10;
  const topSymbolsPerFile = options.topSymbolsPerFile ?? 3;
  const tokens = queryTokens(query);

  const seedNodeIds = new Map<string, number>();
  const seedFiles = new Set<string>();
  const seedSymbols = new Set<string>();
  if (tokens.length > 0) {
    for (const file of files) {
      const relLower = file.relPath.toLowerCase();
      const pathHit = tokens.some((t) => relLower.includes(t));
      const symbolHits = file.symbols.filter((s) =>
        tokens.some((t) => s.qualifiedName.toLowerCase().includes(t) || s.name.toLowerCase().includes(t)),
      );
      if (pathHit) {
        seedFiles.add(file.relPath);
        seedNodeIds.set(codingV2FileNodeId(file.relPath), 1);
      }
      for (const symbol of symbolHits) {
        const nodeId = codingV2SymbolNodeId(file.relPath, symbol.qualifiedName);
        seedSymbols.add(nodeId);
        seedNodeIds.set(nodeId, 1);
        seedFiles.add(file.relPath);
      }
    }
  }

  const fellBackToGlobal = seedNodeIds.size === 0;
  let fileScores = graph.fileScores;
  let symbolScores = graph.symbolScores;
  if (!fellBackToGlobal) {
    const nodeIds = [...graph.nodes.keys()];
    const { scores } = codingV2PageRank(nodeIds, graph.edges, { personalization: seedNodeIds });
    fileScores = new Map<string, number>();
    symbolScores = new Map<string, number>();
    let fileTotal = 0;
    let symbolTotal = 0;
    const symbolFile = new Map<string, string>();
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
  }

  const fileEntryByRel = new Map(files.map((f) => [f.relPath, f] as const));
  // Xếp hạng file: file khớp trực tiếp truy vấn (seed) đứng trước file
  // chỉ được PageRank kéo lên (related) — trong mỗi nhóm giữ thứ tự
  // điểm. Nếu không, một file "hub" nhận mass từ nhiều symbol có thể
  // vượt file thực sự định nghĩa symbol được hỏi (vd hỏi `gamma`
  // thì file định nghĩa nó phải đứng đầu, không phải file nó import).
  const rankedFiles = [...fileScores.entries()]
    .sort((a, b) => {
      const aSeed = seedFiles.has(a[0]) ? 0 : 1;
      const bSeed = seedFiles.has(b[0]) ? 0 : 1;
      if (aSeed !== bSeed) return aSeed - bSeed;
      return b[1] - a[1];
    })
    .slice(0, Math.max(0, limit));
  const fileHits: CodingV2QueryFileHit[] = rankedFiles.map(([relPath, score], i) => {
    const entry = fileEntryByRel.get(relPath);
    const topSymbols = (entry?.symbols ?? [])
      .map((s) => {
        const nodeId = codingV2SymbolNodeId(relPath, s.qualifiedName);
        return {
          name: s.name,
          qualifiedName: s.qualifiedName,
          kind: s.kind,
          line: s.line,
          score: symbolScores.get(nodeId) ?? 0,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topSymbolsPerFile);
    return {
      relPath,
      score,
      rank: i + 1,
      match: seedFiles.has(relPath) ? 'seed' : 'related',
      topSymbols,
    };
  });
  const symbolHits: CodingV2QuerySymbolHit[] = [...symbolScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, symbolLimit))
    .map(([nodeId, score]) => {
      const node = graph.nodes.get(nodeId);
      const entry = node ? fileEntryByRel.get(node.file) : undefined;
      const nodeFile = node?.file ?? '';
      const symbol = entry?.symbols.find((s) => codingV2SymbolNodeId(nodeFile, s.qualifiedName) === nodeId);
      return {
        nodeId,
        file: node?.file ?? '',
        name: symbol?.name ?? node?.symbol ?? '',
        qualifiedName: node?.symbol ?? '',
        kind: symbol?.kind ?? 'function',
        line: symbol?.line ?? 0,
        score,
      };
    });
  return {
    query,
    fellBackToGlobal,
    seedFiles: [...seedFiles].sort(),
    seedSymbols: [...seedSymbols].sort(),
    files: fileHits,
    symbols: symbolHits,
    totalFiles: graph.fileScores.size,
    totalSymbols: graph.symbolScores.size,
  };
}

/** Chi tiết một symbol: định nghĩa ở đâu, file nào nhắc tới, nó nằm trong file nào nhắc tới symbol nào. */
export function codingV2SymbolDetail(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  name: string,
): {
  found: boolean;
  matches: Array<{
    nodeId: string;
    file: string;
    name: string;
    qualifiedName: string;
    kind: CodingV2SymbolKind;
    line: number;
    column: number;
    endLine: number;
    score: number;
    referencedBy: Array<{ file: string; weight: number }>;
  }>;
} {
  const needle = name.trim();
  const matches: ReturnType<typeof codingV2SymbolDetail>['matches'] = [];
  if (needle === '') return { found: false, matches };
  const fileEntryByRel = new Map(files.map((f) => [f.relPath, f] as const));
  for (const [nodeId, node] of graph.nodes) {
    if (node.kind !== 'symbol') continue;
    const entry = fileEntryByRel.get(node.file);
    const symbol = entry?.symbols.find((s) => codingV2SymbolNodeId(node.file, s.qualifiedName) === nodeId);
    if (!symbol) continue;
    if (symbol.qualifiedName !== needle && symbol.name !== needle) continue;
    const referencedByMap = new Map<string, number>();
    for (const edge of graph.edges) {
      if (edge.kind === 'references' && edge.to === nodeId) {
        const fromNode = graph.nodes.get(edge.from);
        if (fromNode?.kind === 'file') {
          referencedByMap.set(fromNode.file, (referencedByMap.get(fromNode.file) ?? 0) + edge.weight);
        }
      }
    }
    const referencedBy = [...referencedByMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([file, weight]) => ({ file, weight }));
    matches.push({
      nodeId,
      file: node.file,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      line: symbol.line,
      column: symbol.column,
      endLine: symbol.endLine,
      score: graph.symbolScores.get(nodeId) ?? 0,
      referencedBy,
    });
  }
  matches.sort((a, b) => b.score - a.score);
  return { found: matches.length > 0, matches };
}

// ---------------------------------------------------------------------------
// Cache trên đĩa + cập nhật tăng dần
// ---------------------------------------------------------------------------

/** Phân loại file theo fingerprint so với entry đã cache. */
export function classifyCodingV2Files(
  oldEntries: Map<string, CodingV2FileEntry>,
  fingerprints: CodingV2FileFingerprint[],
): CodingV2IncrementalPlan {
  const seen = new Set<string>();
  const unchanged: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  for (const fp of fingerprints) {
    seen.add(fp.relPath);
    const old = oldEntries.get(fp.relPath);
    if (!old) {
      added.push(fp.relPath);
    } else if (old.mtimeMs !== fp.mtimeMs || old.size !== fp.size) {
      changed.push(fp.relPath);
    } else {
      unchanged.push(fp.relPath);
    }
  }
  const removed: string[] = [];
  for (const relPath of oldEntries.keys()) {
    if (!seen.has(relPath)) removed.push(relPath);
  }
  return { unchanged, changed, added, removed };
}

/** Gộp entry mới parse vào map cũ, bỏ file đã xoá. */
export function mergeCodingV2Entries(
  oldEntries: Map<string, CodingV2FileEntry>,
  fresh: CodingV2FileEntry[],
  removed: string[],
): Map<string, CodingV2FileEntry> {
  const next = new Map(oldEntries);
  for (const relPath of removed) next.delete(relPath);
  for (const entry of fresh) next.set(entry.relPath, entry);
  return next;
}

/** Serialize cache để ghi đĩa (JSON gọn, key file sắp xếp cho diff ổn định). */
export function serializeCodingV2Cache(cache: CodingV2CacheFile): string {
  const sorted: Record<string, CodingV2FileEntry> = {};
  for (const relPath of Object.keys(cache.files).sort()) {
    sorted[relPath] = cache.files[relPath]!;
  }
  return `${JSON.stringify({ ...cache, files: sorted }, null, 2)}\n`;
}

/**
 * Parse cache JSON từ đĩa. Trả `{ error }` khi file không phải cache
 * v2 hợp lệ (version khác, thiếu trường, rootDir khác) — caller khi
 * đó build lại từ đầu thay vì crash.
 */
export function parseCodingV2Cache(
  text: string,
  expectedRootDir: string,
): { cache: CodingV2CacheFile } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    return { error: `cache JSON hỏng: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'cache không phải object JSON' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CODING_V2_CACHE_VERSION) {
    return { error: `cache version ${String(obj.version)} khác ${CODING_V2_CACHE_VERSION}, build lại` };
  }
  if (typeof obj.rootDir !== 'string' || obj.rootDir !== expectedRootDir) {
    return { error: 'cache thuộc workspace khác, build lại' };
  }
  if (!obj.files || typeof obj.files !== 'object' || Array.isArray(obj.files)) {
    return { error: 'cache thiếu files' };
  }
  const files: Record<string, CodingV2FileEntry> = {};
  for (const [relPath, raw] of Object.entries(obj.files as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.relPath !== 'string' ||
      entry.relPath !== relPath ||
      typeof entry.language !== 'string' ||
      typeof entry.mtimeMs !== 'number' ||
      typeof entry.size !== 'number' ||
      !Array.isArray(entry.symbols) ||
      !Array.isArray(entry.imports)
    ) {
      continue;
    }
    files[relPath] = {
      relPath,
      language: entry.language,
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      symbols: (entry.symbols as CodingV2SymbolEntry[]).filter(
        (s) => s && typeof s.name === 'string' && typeof s.qualifiedName === 'string',
      ),
      imports: (entry.imports as unknown[]).filter((i): i is string => typeof i === 'string'),
      hasError: entry.hasError === true,
    };
  }
  return {
    cache: {
      version: CODING_V2_CACHE_VERSION,
      rootDir: expectedRootDir,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
      files,
    },
  };
}
