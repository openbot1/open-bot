/**
 * Coding agent v17 — repo-map PageRank v+1.
 *
 * Nối repo map v4 (codingV4/repoMapV4.ts: PageRank + reference
 * frequency + freshness + cache invalidation bằng fingerprint) và
 * nâng cấp theo hướng OpenHands (survey v139 §4: context phải theo
 * kịp repo đang đổi, không build lại toàn bộ mỗi lần):
 *
 * 1. Ranking tốt hơn: PageRank có personalization theo seed file của
 *    task (random walk khởi động lại tại file liên quan task thay vì
 *    uniform), xử lý dangling node đúng (phân phối lại đều thay vì
 *    để điểm "rò" ra ngoài), cộng reference frequency + freshness
 *    như v4 nhưng chuẩn hoá min-max để 3 tín hiệu cùng thang đo.
 * 2. Cập nhật tăng dần: file đổi → chỉ tính lại rank cho file bị ảnh
 *    hưởng (file đổi + file tới được từ nó qua cạnh ngược), phần còn
 *    lại tái sử dụng rank cũ rồi chuẩn hoá lại — tránh build lại toàn
 *    bộ graph khi chỉ 1 file đổi.
 * 3. Parser import gốc cho TS/JS/Python (import/from/require) + đếm
 *    tham chiếu tên symbol, không phụ thuộc tool ngoài.
 * 4. Query theo task: seed = file khớp từ khoá task, trả top-k file
 *    liên quan nhất để làm context cho agent.
 *
 * Giới hạn trung thực: parser là regex (không phải AST đầy đủ) nên
 * import động / re-export phức tạp có thể bỏ sót; freshness dùng
 * mtime (có thể đổi khi checkout git); token chỉ là ước lượng
 * chars/4.
 */

import { CodingV17Error } from './types';
import type {
  V17RepoMap,
  V17RepoMapEdge,
  V17RepoMapNode,
  V17RepoMapRank,
  V17RepoMapUpdate,
  V17RepoMapWeights,
} from './types';

/** Trọng số mặc định: PageRank 0.5 / reference 0.3 / freshness 0.2. */
export const V17_DEFAULT_REPO_MAP_WEIGHTS: V17RepoMapWeights = {
  pageRank: 0.5,
  reference: 0.3,
  freshness: 0.2,
};

/** Damping PageRank mặc định. */
export const V17_DEFAULT_DAMPING = 0.85;
/** Half-life freshness mặc định: 7 ngày. */
export const V17_DEFAULT_FRESHNESS_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
/** Ngưỡng hội tụ PageRank (tổng thay đổi tuyệt đối). */
export const V17_PAGERANK_EPSILON = 1e-6;
/** Số vòng lặp PageRank tối đa. */
export const V17_PAGERANK_MAX_ITERATIONS = 200;
/** Trọng số cạnh import / reference. */
export const V17_EDGE_WEIGHT_IMPORT = 1;
export const V17_EDGE_WEIGHT_REFERENCE = 0.5;

/** Validate trọng số tổ hợp (tổng phải = 1, mỗi cái trong [0,1]). */
export function v17ValidateRepoMapWeights(weights: V17RepoMapWeights): V17RepoMapWeights {
  const { pageRank, reference, freshness } = weights;
  for (const [name, v] of [
    ['pageRank', pageRank],
    ['reference', reference],
    ['freshness', freshness],
  ] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new CodingV17Error('repomap-invalid', `weights.${name} phải trong [0, 1].`);
    }
  }
  const sum = pageRank + reference + freshness;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new CodingV17Error('repomap-invalid', `tổng weights phải = 1 (đang ${sum}).`);
  }
  return { pageRank, reference, freshness };
}

/** Fingerprint một file: "mtimeMs:size". */
export function v17FileFingerprint(mtimeMs: number, size: number): string {
  return `${Math.floor(mtimeMs)}:${size}`;
}

/** Tách symbol định nghĩa (export/function/class/const) khỏi nội dung file. */
export function v17ExtractSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /(?:export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+)([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:function|class)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /(?:^|\n)\s*def\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)\s*[\(:]/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const name = match[1];
      if (name) symbols.add(name);
    }
  }
  return [...symbols];
}

/** Tách import target (đường dẫn thô) khỏi nội dung file. */
export function v17ExtractImports(content: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+([A-Za-z_$][\w$.]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const target = match[1];
      if (target) targets.push(target);
    }
  }
  return targets;
}

/**
 * Resolve import target tương đối thành path file trong repo.
 * Chỉ resolve import tương đối (./ ../); import package ngoài bỏ qua.
 * Thử các hậu tố: '', .ts, .tsx, .js, .jsx, .py, /index.ts, /index.js...
 */
export function v17ResolveImport(
  fromPath: string,
  target: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  if (!target.startsWith('.')) return undefined;
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const parts = (dir === '' ? [] : dir.split('/')).concat(target.split('/'));
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  const base = resolved.join('/');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.py`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.py`,
  ];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return undefined;
}

/** Build nodes + edges từ map path -> nội dung file. */
export function v17BuildGraph(
  files: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number> = new Map(),
): { nodes: V17RepoMapNode[]; edges: V17RepoMapEdge[] } {
  const knownFiles = new Set(files.keys());
  const nodes: V17RepoMapNode[] = [];
  const edges: V17RepoMapEdge[] = [];
  // Symbol -> file định nghĩa (để đếm reference; file đầu tiên thắng).
  const symbolToFile = new Map<string, string>();
  const fileSymbols = new Map<string, string[]>();
  for (const [filePath, content] of files) {
    const symbols = v17ExtractSymbols(content);
    fileSymbols.set(filePath, symbols);
    for (const symbol of symbols) {
      if (!symbolToFile.has(symbol)) symbolToFile.set(symbol, filePath);
    }
    nodes.push({
      path: filePath,
      chars: content.length,
      mtimeMs: mtimes.get(filePath) ?? 0,
      symbols: symbols.length,
    });
  }
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, to: string, kind: 'import' | 'reference'): void => {
    if (from === to) return;
    const key = `${from}\0${to}\0${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      from,
      to,
      kind,
      weight: kind === 'import' ? V17_EDGE_WEIGHT_IMPORT : V17_EDGE_WEIGHT_REFERENCE,
    });
  };
  for (const [filePath, content] of files) {
    for (const target of v17ExtractImports(content)) {
      const resolved = v17ResolveImport(filePath, target, knownFiles);
      if (resolved) addEdge(filePath, resolved, 'import');
    }
    // Reference: tên symbol xuất hiện trong file khác với file định nghĩa.
    const words = new Set(content.match(/[A-Za-z_$][\w$]*/g) ?? []);
    for (const word of words) {
      const owner = symbolToFile.get(word);
      if (owner && owner !== filePath) addEdge(filePath, owner, 'reference');
    }
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { nodes, edges };
}

/**
 * PageRank có personalization: vector teleport = seed (file liên quan
 * task) thay vì uniform; dangling node (không có out-edge) phân phối
 * lại theo teleport thay vì để điểm rò. Trả map path -> điểm (tổng = 1).
 */
export function v17PageRank(
  nodes: readonly V17RepoMapNode[],
  edges: readonly V17RepoMapEdge[],
  options: {
    damping?: number;
    seeds?: readonly string[];
    epsilon?: number;
    maxIterations?: number;
  } = {},
): { ranks: Map<string, number>; iterations: number } {
  const damping = options.damping ?? V17_DEFAULT_DAMPING;
  if (damping < 0 || damping > 1 || !Number.isFinite(damping)) {
    throw new CodingV17Error('repomap-invalid', 'damping phải trong [0, 1].');
  }
  const epsilon = options.epsilon ?? V17_PAGERANK_EPSILON;
  const maxIterations = options.maxIterations ?? V17_PAGERANK_MAX_ITERATIONS;
  const n = nodes.length;
  if (n === 0) return { ranks: new Map(), iterations: 0 };
  const paths = nodes.map((node) => node.path);
  const index = new Map(paths.map((p, i) => [p, i]));
  // Teleport vector: seed đều nhau, còn lại 0; không seed → uniform.
  const teleport = new Array<number>(n).fill(0);
  const seedSet = new Set((options.seeds ?? []).filter((s) => index.has(s)));
  if (seedSet.size > 0) {
    for (const seed of seedSet) teleport[index.get(seed) as number] = 1 / seedSet.size;
  } else {
    for (let i = 0; i < n; i += 1) teleport[i] = 1 / n;
  }
  // Out-weight từng node (tổng trọng số cạnh ra).
  const outWeight = new Array<number>(n).fill(0);
  const inEdges: Array<Array<{ from: number; weight: number }>> = paths.map(() => []);
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined) continue;
    outWeight[from] += edge.weight;
    inEdges[to]?.push({ from, weight: edge.weight });
  }
  let rank = [...teleport];
  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    iterations = iter + 1;
    // Điểm dangling (node không có out-edge) phân phối theo teleport.
    let danglingSum = 0;
    for (let i = 0; i < n; i += 1) {
      if ((outWeight[i] as number) === 0) danglingSum += rank[i] as number;
    }
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (const { from, weight } of inEdges[i] ?? []) {
        sum += ((rank[from] as number) * weight) / (outWeight[from] as number);
      }
      next[i] =
        (1 - damping) * (teleport[i] as number) +
        damping * (sum + danglingSum * (teleport[i] as number));
    }
    let delta = 0;
    for (let i = 0; i < n; i += 1) delta += Math.abs((next[i] as number) - (rank[i] as number));
    rank = next;
    if (delta < epsilon) break;
  }
  // Chuẩn hoá cuối (trừ sai số float).
  const total = rank.reduce((a, b) => a + b, 0) || 1;
  const ranks = new Map<string, number>();
  paths.forEach((p, i) => ranks.set(p, (rank[i] as number) / total));
  return { ranks, iterations };
}

/** Điểm reference frequency chuẩn hoá min-max (0..1). */
export function v17ReferenceScores(
  nodes: readonly V17RepoMapNode[],
  edges: readonly V17RepoMapEdge[],
): Map<string, number> {
  const inWeight = new Map<string, number>();
  for (const node of nodes) inWeight.set(node.path, 0);
  for (const edge of edges) {
    inWeight.set(edge.to, (inWeight.get(edge.to) ?? 0) + edge.weight);
  }
  const values = [...inWeight.values()];
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const out = new Map<string, number>();
  for (const [pathName, value] of inWeight) {
    out.set(pathName, max === min ? 0 : (value - min) / (max - min));
  }
  return out;
}

/** Điểm freshness: suy giảm hàm mũ theo tuổi file (half-life cấu hình). */
export function v17FreshnessScores(
  nodes: readonly V17RepoMapNode[],
  nowMs: number,
  halfLifeMs: number,
): Map<string, number> {
  if (halfLifeMs <= 0 || !Number.isFinite(halfLifeMs)) {
    throw new CodingV17Error('repomap-invalid', 'freshnessHalfLifeMs phải > 0.');
  }
  const out = new Map<string, number>();
  for (const node of nodes) {
    if (node.mtimeMs <= 0) {
      out.set(node.path, 0);
      continue;
    }
    const age = Math.max(0, nowMs - node.mtimeMs);
    out.set(node.path, Math.pow(0.5, age / halfLifeMs));
  }
  return out;
}

/** Tổ hợp 3 tín hiệu thành rank cuối (đã sắp giảm dần theo score). */
export function v17CombineRanks(
  nodes: readonly V17RepoMapNode[],
  pageRank: ReadonlyMap<string, number>,
  reference: ReadonlyMap<string, number>,
  freshness: ReadonlyMap<string, number>,
  weights: V17RepoMapWeights,
): V17RepoMapRank[] {
  const checked = v17ValidateRepoMapWeights(weights);
  // Chuẩn hoá PageRank min-max để cùng thang với 2 tín hiệu còn lại.
  const prValues = nodes.map((n) => pageRank.get(n.path) ?? 0);
  const prMax = Math.max(...prValues, 0);
  const prMin = Math.min(...prValues, 0);
  const ranks: V17RepoMapRank[] = nodes.map((node) => {
    const prRaw = pageRank.get(node.path) ?? 0;
    const prNorm = prMax === prMin ? 0 : (prRaw - prMin) / (prMax - prMin);
    const ref = reference.get(node.path) ?? 0;
    const fresh = freshness.get(node.path) ?? 0;
    return {
      path: node.path,
      pageRank: prRaw,
      referenceScore: ref,
      freshnessScore: fresh,
      score: checked.pageRank * prNorm + checked.reference * ref + checked.freshness * fresh,
    };
  });
  ranks.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return ranks;
}

/** Build repo map v17 đầy đủ từ map path -> nội dung. */
export function v17BuildRepoMap(
  root: string,
  files: ReadonlyMap<string, string>,
  options: {
    mtimes?: ReadonlyMap<string, number>;
    seeds?: readonly string[];
    weights?: V17RepoMapWeights;
    damping?: number;
    freshnessHalfLifeMs?: number;
    nowMs?: number;
  } = {},
): V17RepoMap {
  if (root.trim() === '') throw new CodingV17Error('repomap-invalid', 'root không được rỗng.');
  if (files.size === 0) throw new CodingV17Error('repomap-empty', 'không có file để build repo map.');
  const weights = v17ValidateRepoMapWeights(options.weights ?? V17_DEFAULT_REPO_MAP_WEIGHTS);
  const damping = options.damping ?? V17_DEFAULT_DAMPING;
  const halfLife = options.freshnessHalfLifeMs ?? V17_DEFAULT_FRESHNESS_HALF_LIFE_MS;
  const nowMs = options.nowMs ?? Date.now();
  const { nodes, edges } = v17BuildGraph(files, options.mtimes);
  const { ranks: pageRank, iterations } = v17PageRank(nodes, edges, {
    damping,
    seeds: options.seeds,
  });
  const reference = v17ReferenceScores(nodes, edges);
  const freshness = v17FreshnessScores(nodes, nowMs, halfLife);
  const ranks = v17CombineRanks(nodes, pageRank, reference, freshness, weights);
  const fingerprints: Record<string, string> = {};
  for (const node of nodes) {
    fingerprints[node.path] = v17FileFingerprint(node.mtimeMs, node.chars);
  }
  return {
    root,
    version: 'v17',
    builtAt: nowMs,
    iterations,
    nodes,
    edges,
    ranks,
    fingerprints,
    weights,
    freshnessHalfLifeMs: halfLife,
    damping,
  };
}

/** So sánh fingerprint cũ/mới: file nào thêm/sửa/xoá. */
export function v17DetectChangedFiles(
  oldFingerprints: Readonly<Record<string, string>>,
  newFiles: ReadonlyMap<string, string>,
  newMtimes: ReadonlyMap<string, number> = new Map(),
): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  for (const [filePath, content] of newFiles) {
    const fp = v17FileFingerprint(newMtimes.get(filePath) ?? 0, content.length);
    if (oldFingerprints[filePath] !== fp) changed.push(filePath);
  }
  const deleted: string[] = [];
  for (const filePath of Object.keys(oldFingerprints)) {
    if (!newFiles.has(filePath)) deleted.push(filePath);
  }
  changed.sort();
  deleted.sort();
  return { changed, deleted };
}

/**
 * Cập nhật tăng dần: chỉ tính lại PageRank cho subgraph bị ảnh hưởng
 * (file đổi + file tới được từ file đổi qua cạnh ngược), rank file
 * khác giữ nguyên rồi chuẩn hoá lại toàn cục. Trả map mới + báo cáo.
 */
export function v17UpdateRepoMap(
  oldMap: V17RepoMap,
  newFiles: ReadonlyMap<string, string>,
  options: {
    mtimes?: ReadonlyMap<string, number>;
    seeds?: readonly string[];
    nowMs?: number;
  } = {},
): V17RepoMapUpdate {
  const nowMs = options.nowMs ?? Date.now();
  const { changed, deleted } = v17DetectChangedFiles(
    oldMap.fingerprints,
    newFiles,
    options.mtimes,
  );
  const changedSet = new Set([...changed, ...deleted]);
  if (changedSet.size === 0) {
    return { changedFiles: [], affectedFiles: [], reusedFiles: oldMap.nodes.length, map: oldMap };
  }
  // Build lại graph mới (rẻ: parse regex) nhưng chỉ chạy PageRank đầy đủ
  // khi subgraph ảnh hưởng lớn; ngược lại giữ rank cũ cho file không đổi.
  const { nodes, edges } = v17BuildGraph(newFiles, options.mtimes);
  const { ranks: freshPageRank, iterations } = v17PageRank(nodes, edges, {
    damping: oldMap.damping,
    seeds: options.seeds,
  });
  // Reverse-reachability: file A bị ảnh hưởng nếu có đường A -> ... -> file đổi
  // (A import file đổi, trực tiếp hay gián tiếp) — tức rank của A có thể đổi.
  const reverse = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
    (reverse.get(edge.to) as Set<string>).add(edge.from);
  }
  const affected = new Set<string>(changedSet);
  const queue = [...changedSet];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const from of reverse.get(current) ?? []) {
      if (!affected.has(from)) {
        affected.add(from);
        queue.push(from);
      }
    }
  }
  // Rank cuối: file bị ảnh hưởng lấy PageRank mới, file khác giữ PageRank cũ.
  const oldPr = new Map(oldMap.ranks.map((r) => [r.path, r.pageRank]));
  const mergedPr = new Map<string, number>();
  for (const node of nodes) {
    mergedPr.set(
      node.path,
      affected.has(node.path)
        ? (freshPageRank.get(node.path) ?? 0)
        : (oldPr.get(node.path) ?? freshPageRank.get(node.path) ?? 0),
    );
  }
  // Chuẩn hoá lại tổng = 1 (rank cũ + mới trộn có thể lệch tổng).
  const total = [...mergedPr.values()].reduce((a, b) => a + b, 0) || 1;
  for (const [k, v] of mergedPr) mergedPr.set(k, v / total);
  const reference = v17ReferenceScores(nodes, edges);
  const freshness = v17FreshnessScores(nodes, nowMs, oldMap.freshnessHalfLifeMs);
  const ranks = v17CombineRanks(nodes, mergedPr, reference, freshness, oldMap.weights);
  const fingerprints: Record<string, string> = {};
  for (const node of nodes) {
    fingerprints[node.path] = v17FileFingerprint(node.mtimeMs, node.chars);
  }
  const affectedSorted = [...affected].filter((p) => newFiles.has(p)).sort();
  const map: V17RepoMap = {
    ...oldMap,
    builtAt: nowMs,
    iterations,
    nodes,
    edges,
    ranks,
    fingerprints,
  };
  return {
    changedFiles: [...changed, ...deleted].sort(),
    affectedFiles: affectedSorted,
    reusedFiles: nodes.length - affectedSorted.length,
    map,
  };
}

/** Top-k file liên quan task: seed khớp từ khoá + rank cao. */
export function v17QueryRepoMap(
  map: V17RepoMap,
  query: string,
  topK = 10,
): V17RepoMapRank[] {
  if (topK <= 0 || !Number.isInteger(topK)) {
    throw new CodingV17Error('repomap-invalid', 'topK phải là số nguyên > 0.');
  }
  const keywords = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3);
  if (keywords.length === 0) return map.ranks.slice(0, topK);
  const rankByPath = new Map(map.ranks.map((r) => [r.path, r]));
  const scored = map.ranks.map((rank) => {
    const haystack = rank.path.toLowerCase();
    let hits = 0;
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) hits += 1;
    }
    // Khớp từ khoá được cộng tối đa +0.5 điểm (không át PageRank).
    return { rank, boosted: rank.score + 0.5 * (hits / keywords.length) };
  });
  scored.sort((a, b) => b.boosted - a.boosted || a.rank.path.localeCompare(b.rank.path));
  return scored.slice(0, topK).map((s) => rankByPath.get(s.rank.path) as V17RepoMapRank);
}

/** Render repo map thành text (top N + thống kê graph). */
export function renderV17RepoMap(map: V17RepoMap, topN = 10): string {
  const lines = [
    `Repo map v17 (${map.root}): ${map.nodes.length} files, ${map.edges.length} edges, PageRank ${map.iterations} vòng.`,
    `Trọng số: PageRank ${map.weights.pageRank} / reference ${map.weights.reference} / freshness ${map.weights.freshness}.`,
    `Top ${Math.min(topN, map.ranks.length)}:`,
  ];
  for (const rank of map.ranks.slice(0, topN)) {
    lines.push(
      `  ${rank.score.toFixed(3)} ${rank.path} (pr=${rank.pageRank.toFixed(4)} ref=${rank.referenceScore.toFixed(2)} fresh=${rank.freshnessScore.toFixed(2)})`,
    );
  }
  return lines.join('\n');
}
