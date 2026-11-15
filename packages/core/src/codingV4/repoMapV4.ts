/**
 * Repo map PageRank v2 (v1.11, Doi T4) — coding agent v4.
 *
 * Y tuong hoc tu Aider repo map / OpenHands sub-agent visualizer (chi hoc
 * y tuong, tu thiet ke va viet lai hoan toan tu dau — KHONG doc, KHONG
 * copy code/text/tai san cua bat ky repo nao, cua xAI/Cursor).
 *
 * Nang cap repo map v3 (`codingV3/repoMapV3.ts` — call edges + module
 * graph + budget map tren diem PageRank thuan tuy cua v2) thanh PageRank
 * v2 dung nghia: diem file la TO HOP CO TRONG SO cua 3 tin hieu:
 *
 *   1. PageRank (do thi symbol-level v2): file duoc import/nhac nhieu
 *      boi file quan trong thi quan trong.
 *   2. Tan suat tham chieu (reference frequency): tong trong so canh
 *      `references` cham toi symbol do file dinh nghia — file duoc goi
 *      truc tiep nhieu thi noi len, ke ca khi PageRank thuan tuy bi
 *      pha loang boi node dangling.
 *   3. Do moi (freshness): file sua gan day duoc cong diem (phai suy
 *      giam theo ham mu theo tuoi file, half-life cau hinh duoc) —
 *      code moi thay doi thuong la noi agent can doc truoc.
 *
 * Them 2 lop ma v3 chua co:
 *
 *   - Map co trong so (weighted map): canh file -> file mang trong so
 *     hop nhat (import + call) kem diem v4 cua hai dau, de host cat
 *     context theo muc do lien quan that, khong chi theo thu tu
 *     PageRank.
 *   - Cache invalidation: fingerprint (mtimeMs, size) tung file luu
 *     trong cache v4; khi file doi/them/xoa, chi phan do bi danh dau
 *     stale — build sau chi tinh lai rank cho file anh huong, phan
 *     con lai tai dung. Cache sai version/khac workspace thi build lai.
 *
 * Module nay thuan tuy (khong fs): quet file/cache dia song o
 * `packages/tools/src/codingV4RepoMap.ts`, giong cach v2/v3 tach.
 *
 * Gioi han trung thuc:
 *   - references dem theo ten ngan (ke thua v2) nen co the dem thua.
 *   - freshness dung mtime cua file (co the bi thay khi checkout git).
 *   - token chi la uoc luong (chars/4), khong dem bang tokenizer that.
 */

import { buildCodingV3CallGraph } from '../codingV3/repoMapV3';
import type { CodingV3CallEdge } from '../codingV3/repoMapV3';
import {
  codingV2PageRank,
  codingV2SymbolNodeId,
} from '../codingV2/repoMapGraph';
import type {
  CodingV2FileEntry,
  CodingV2Graph,
} from '../codingV2/repoMapGraph';

/** Version cua dinh dang cache v4 tren dia. */
export const CODING_V4_CACHE_VERSION = 4;
/** So ky tu uoc tinh = 1 token khi render budget map (giong v3). */
export const CODING_V4_CHARS_PER_TOKEN = 4;
/** Ngan sach token mac dinh cho budget map v4. */
export const CODING_V4_DEFAULT_BUDGET_TOKENS = 2000;
/** Half-life mac dinh cua freshness: file 90 ngay tuoi chi con 1/2 diem moi. */
export const CODING_V4_DEFAULT_FRESHNESS_HALF_LIFE_DAYS = 90;
/** So ngay = 1 don vi tuoi khi tinh freshness. */
export const CODING_V4_MS_PER_DAY = 86_400_000;

/** Trong so 3 tin hieu cua diem v4 (tong khong nhat thiet = 1, se chuan hoa). */
export interface CodingV4RankWeights {
  /** Trong so PageRank thuan tuy (v2). Mac dinh 0.5. */
  pageRank: number;
  /** Trong so tan suat tham chieu. Mac dinh 0.3. */
  references: number;
  /** Trong so do moi. Mac dinh 0.2. */
  freshness: number;
}

export const CODING_V4_DEFAULT_WEIGHTS: CodingV4RankWeights = {
  pageRank: 0.5,
  references: 0.3,
  freshness: 0.2,
};

/** Chuan hoa trong so ve tong 1; trong so am hoac NaN bi dua ve 0. */
export function normalizeCodingV4Weights(
  weights: Partial<CodingV4RankWeights> = {},
): CodingV4RankWeights {
  const raw: CodingV4RankWeights = {
    pageRank: weights.pageRank ?? CODING_V4_DEFAULT_WEIGHTS.pageRank,
    references: weights.references ?? CODING_V4_DEFAULT_WEIGHTS.references,
    freshness: weights.freshness ?? CODING_V4_DEFAULT_WEIGHTS.freshness,
  };
  const clean = (v: number): number =>
    Number.isFinite(v) && v > 0 ? v : 0;
  const pr = clean(raw.pageRank);
  const ref = clean(raw.references);
  const fresh = clean(raw.freshness);
  const total = pr + ref + fresh;
  if (total <= 0) return { ...CODING_V4_DEFAULT_WEIGHTS };
  return { pageRank: pr / total, references: ref / total, freshness: fresh / total };
}

// ---------------------------------------------------------------------------
// Freshness (do moi theo mtime)
// ---------------------------------------------------------------------------

/**
 * Diem moi cua mot file: 1 khi vua sua, giam theo ham mu khi tuoi tang.
 * `nowMs` mac dinh la thoi diem goi; file co mtime trong tuong lai bi
 * kep ve 1. Half-life = so ngay de diem giam mot nua.
 */
export function codingV4FreshnessScore(
  mtimeMs: number,
  nowMs: number = Date.now(),
  halfLifeDays: number = CODING_V4_DEFAULT_FRESHNESS_HALF_LIFE_DAYS,
): number {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs)) return 0;
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0
    ? halfLifeDays
    : CODING_V4_DEFAULT_FRESHNESS_HALF_LIFE_DAYS;
  const ageDays = Math.max(0, (nowMs - mtimeMs) / CODING_V4_MS_PER_DAY);
  return Math.pow(0.5, ageDays / halfLife);
}

// ---------------------------------------------------------------------------
// Tan suat tham chieu (reference frequency)
// ---------------------------------------------------------------------------

/**
 * Tong trong so canh `references` cham toi symbol cua moi file.
 * File duoc goi truc tiep nhieu co tong lon — tin hieu bo sung cho
 * PageRank (vốn bi pha loang boi node dangling va canh defines).
 */
export function codingV4ReferenceTotals(
  graph: CodingV2Graph,
): Map<string, number> {
  const symbolFile = new Map<string, string>();
  for (const [id, node] of graph.nodes) {
    if (node.kind === 'symbol') symbolFile.set(id, node.file);
  }
  const totals = new Map<string, number>();
  for (const [relPath] of graph.fileScores) totals.set(relPath, 0);
  for (const edge of graph.edges) {
    if (edge.kind !== 'references') continue;
    const targetFile = symbolFile.get(edge.to);
    if (targetFile === undefined) continue;
    totals.set(targetFile, (totals.get(targetFile) ?? 0) + edge.weight);
  }
  return totals;
}

/**
 * Chuan hoa log: log1p(x) / log1p(max) — ne'n tin hieu tham chieu khi
 * mot file hut het luot nhac (hub), van giu thu tu.
 */
export function codingV4NormalizeLog(values: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of values.values()) max = Math.max(max, v);
  const out = new Map<string, number>();
  const denom = Math.log1p(max);
  for (const [k, v] of values) {
    out.set(k, denom > 0 ? Math.log1p(Math.max(0, v)) / denom : 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Xep hang PageRank v2
// ---------------------------------------------------------------------------

export interface CodingV4FileRank {
  relPath: string;
  /** Thu hang 1-based (1 = quan trong nhat). */
  rank: number;
  /** Diem hop nhat (0-1), chua chuan hoa tong = 1. */
  score: number;
  /** Diem PageRank thuan tuy (v2, da chuan hoa max = 1). */
  pageRankScore: number;
  /** Diem tan suat tham chieu (log-chuan hoa, 0-1). */
  referenceScore: number;
  /** Diem do moi (0-1). */
  freshnessScore: number;
  symbols: number;
  mtimeMs: number;
}

export interface CodingV4RankOptions {
  weights?: Partial<CodingV4RankWeights>;
  /** Thoi diem tinh freshness (mac dinh Date.now()). */
  nowMs?: number;
  /** Half-life cua freshness (ngay). */
  halfLifeDays?: number;
}

export interface CodingV4Ranking {
  ranks: CodingV4FileRank[];
  weights: CodingV4RankWeights;
  stats: {
    files: number;
    symbols: number;
    /** File co diem tham chieu > 0. */
    referencedFiles: number;
    /** File sua trong 7 ngay gan nhat (freshness > 0.94 voi half-life mac dinh). */
    freshFiles: number;
  };
}

/**
 * Xep hang file theo PageRank v2: hop nhat PageRank + tan suat tham
 * chieu (log-chuan hoa) + do moi, moi thanh phan chuan hoa max = 1
 * truoc khi cong trong so. Tra ve thu tu giam dan theo diem hop nhat.
 * `pageRankScores` cho phep dung diem PageRank tuy chinh (vd
 * Personalized PageRank theo truy van) thay vi diem toan cuc.
 */
export function rankCodingV4Files(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  options: CodingV4RankOptions = {},
): CodingV4Ranking {
  return combineCodingV4Scores(graph, files, graph.fileScores, options);
}

/**
 * Hop nhat 3 tin hieu thanh ranking v4 tu mot ban do diem PageRank
 * bat ky (toan cuc hoac personalized). Dung chung cho ca xep hang
 * toan cuc va xep hang theo truy van.
 */
export function combineCodingV4Scores(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  pageRankScores: Map<string, number>,
  options: CodingV4RankOptions = {},
): CodingV4Ranking {
  const weights = normalizeCodingV4Weights(options.weights);
  const nowMs = options.nowMs ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? CODING_V4_DEFAULT_FRESHNESS_HALF_LIFE_DAYS;

  const fileByRel = new Map(files.map((f) => [f.relPath, f] as const));
  const refTotals = codingV4ReferenceTotals(graph);
  const refNorm = codingV4NormalizeLog(refTotals);

  let maxPr = 0;
  for (const s of pageRankScores.values()) maxPr = Math.max(maxPr, s);

  const ranks: CodingV4FileRank[] = [];
  let referencedFiles = 0;
  let freshFiles = 0;
  for (const [relPath, prRaw] of pageRankScores) {
    const file = fileByRel.get(relPath);
    if (!file) continue;
    const pageRankScore = maxPr > 0 ? prRaw / maxPr : 0;
    const referenceScore = refNorm.get(relPath) ?? 0;
    const freshnessScore = codingV4FreshnessScore(file.mtimeMs, nowMs, halfLifeDays);
    if (referenceScore > 0) referencedFiles += 1;
    if (nowMs - file.mtimeMs <= 7 * CODING_V4_MS_PER_DAY) freshFiles += 1;
    const score =
      weights.pageRank * pageRankScore +
      weights.references * referenceScore +
      weights.freshness * freshnessScore;
    ranks.push({
      relPath,
      rank: 0,
      score,
      pageRankScore,
      referenceScore,
      freshnessScore,
      symbols: file.symbols.length,
      mtimeMs: file.mtimeMs,
    });
  }
  ranks.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
  ranks.forEach((r, i) => {
    r.rank = i + 1;
  });
  const symbols = files.reduce((acc, f) => acc + f.symbols.length, 0);
  return {
    ranks,
    weights,
    stats: { files: ranks.length, symbols, referencedFiles, freshFiles },
  };
}

/** Top N file theo PageRank v2 (mac dinh 10). */
export function codingV4TopFiles(ranking: CodingV4Ranking, limit = 10): CodingV4FileRank[] {
  return ranking.ranks.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Weighted map (map co trong so)
// ---------------------------------------------------------------------------

export interface CodingV4WeightedEdge extends CodingV3CallEdge {
  /** Diem v4 cua file nguon (0 khi file khong co trong ranking). */
  fromScore: number;
  /** Diem v4 cua file dich. */
  toScore: number;
  /** Trong so hop nhat: trong so call/import * (0.5 + diem dich). */
  combinedWeight: number;
}

export interface CodingV4WeightedMap {
  ranking: CodingV4Ranking;
  /** Canh file -> file co trong so hop nhat, giam dan. */
  edges: CodingV4WeightedEdge[];
  stats: {
    files: number;
    edges: number;
    importOnlyEdges: number;
    callOnlyEdges: number;
    bothEdges: number;
  };
}

/**
 * Dung weighted map tu do thi v2 + entries: lay call graph v3 (import +
 * call), gan moi canh trong so hop nhat theo diem v4 cua file dich —
 * canh toi file quan trong duoc uu tien khi cat context. Canh co
 * `combinedWeight = weight * (0.5 + toScore)` (toScore 0-1) nen thu tu
 * tuong doi cua trong so goc duoc giu, chi dieu chinh theo muc do
 * quan trong cua dich.
 */
export function buildCodingV4WeightedMap(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  options: CodingV4RankOptions = {},
): CodingV4WeightedMap {
  const ranking = rankCodingV4Files(graph, files, options);
  const scoreOf = new Map(ranking.ranks.map((r) => [r.relPath, r.score] as const));
  const callGraph = buildCodingV3CallGraph(graph);
  const edges: CodingV4WeightedEdge[] = callGraph.edges.map((e) => {
    const toScore = scoreOf.get(e.to) ?? 0;
    const fromScore = scoreOf.get(e.from) ?? 0;
    return {
      ...e,
      fromScore,
      toScore,
      combinedWeight: e.weight * (0.5 + toScore),
    };
  });
  edges.sort((a, b) => b.combinedWeight - a.combinedWeight);
  return {
    ranking,
    edges,
    stats: {
      files: ranking.stats.files,
      edges: edges.length,
      importOnlyEdges: callGraph.stats.importOnlyEdges,
      callOnlyEdges: callGraph.stats.callOnlyEdges,
      bothEdges: callGraph.stats.bothEdges,
    },
  };
}

// ---------------------------------------------------------------------------
// Budget map theo PageRank v2
// ---------------------------------------------------------------------------

export function estimateCodingV4Tokens(text: string): number {
  return Math.ceil(text.length / CODING_V4_CHARS_PER_TOKEN);
}

export interface CodingV4BudgetMapOptions extends CodingV4RankOptions {
  budgetTokens?: number;
  topSymbolsPerFile?: number;
  /** File uu tien xep truoc (vd file seed cua truy van). */
  prioritizeFiles?: Set<string>;
  /** Ranking tinh san (vd ranking theo truy van) — dung thay vi tinh lai. */
  ranking?: CodingV4Ranking;
}

export interface CodingV4BudgetMap {
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  includedFiles: string[];
  excludedFiles: string[];
  truncated: boolean;
  totalFiles: number;
  weights: CodingV4RankWeights;
}

function renderV4Line(
  rank: CodingV4FileRank,
  file: CodingV2FileEntry,
  topSymbolsPerFile: number,
): string {
  const topSymbols = [...file.symbols]
    .sort((a, b) => a.line - b.line)
    .slice(0, topSymbolsPerFile);
  const symbolPart =
    topSymbols.length > 0
      ? ` — ${topSymbols.map((s) => `${s.kind} ${s.qualifiedName}:${s.line}`).join(', ')}`
      : '';
  return (
    `${rank.relPath} [v4 ${rank.score.toFixed(4)} = pr ${rank.pageRankScore.toFixed(2)} ` +
    `ref ${rank.referenceScore.toFixed(2)} fresh ${rank.freshnessScore.toFixed(2)}, ` +
    `${rank.symbols} symbols]${symbolPart}`
  );
}

/**
 * Render repo map rut gon vua ngan sach token theo thu tu PageRank v2.
 * Luon giu it nhat 1 file. File uu tien (seed truy van) xep truoc.
 */
export function renderCodingV4BudgetMap(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  options: CodingV4BudgetMapOptions = {},
): CodingV4BudgetMap {
  const budgetTokens = Math.max(1, Math.floor(options.budgetTokens ?? CODING_V4_DEFAULT_BUDGET_TOKENS));
  const topSymbolsPerFile = Math.max(0, Math.floor(options.topSymbolsPerFile ?? 3));
  const ranking = options.ranking ?? rankCodingV4Files(graph, files, options);
  const fileByRel = new Map(files.map((f) => [f.relPath, f] as const));
  const prioritize = options.prioritizeFiles;

  const ordered = [...ranking.ranks].sort((a, b) => {
    if (prioritize) {
      const aSeed = prioritize.has(a.relPath) ? 0 : 1;
      const bSeed = prioritize.has(b.relPath) ? 0 : 1;
      if (aSeed !== bSeed) return aSeed - bSeed;
    }
    return b.score - a.score;
  });

  const header = `# Repo map v4 (PageRank v2, budget ${budgetTokens} tokens, ${ordered.length} files ranked)`;
  const lines: string[] = [header];
  const includedFiles: string[] = [];
  const excludedFiles: string[] = [];
  let usedChars = header.length + 1;
  for (const rank of ordered) {
    const file = fileByRel.get(rank.relPath);
    if (!file) continue;
    const line = renderV4Line(rank, file, topSymbolsPerFile);
    const nextChars = usedChars + line.length + 1;
    if (includedFiles.length > 0 && Math.ceil(nextChars / CODING_V4_CHARS_PER_TOKEN) > budgetTokens) {
      excludedFiles.push(rank.relPath);
      continue;
    }
    lines.push(line);
    includedFiles.push(rank.relPath);
    usedChars = nextChars;
  }
  for (const rank of ordered) {
    if (!includedFiles.includes(rank.relPath) && !excludedFiles.includes(rank.relPath)) {
      excludedFiles.push(rank.relPath);
    }
  }
  const text = lines.join('\n');
  return {
    text,
    estimatedTokens: estimateCodingV4Tokens(text),
    budgetTokens,
    includedFiles,
    excludedFiles,
    truncated: excludedFiles.length > 0,
    totalFiles: ordered.length,
    weights: ranking.weights,
  };
}

export interface CodingV4QueryRanking {
  ranking: CodingV4Ranking;
  seedFiles: string[];
  fellBackToGlobal: boolean;
}

/**
 * Xep hang theo truy van bang Personalized PageRank v2: chay PageRank
 * voi khoi luong don vao file/symbol khop truy van (ten file hoac ten
 * symbol chua token cua truy van), cong diem symbol vao file dinh
 * nghia no (giong cach v2 tinh diem file), roi hop nhat voi tan suat
 * tham chieu + do moi nhu xep hang toan cuc. Truy van khong khop gi
 * thi roi ve xep hang toan cuc (fellBackToGlobal = true).
 */
export function rankCodingV4FilesForQuery(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  query: string,
  options: CodingV4RankOptions = {},
): CodingV4QueryRanking {
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
            (t) =>
              symbol.qualifiedName.toLowerCase().includes(t) ||
              symbol.name.toLowerCase().includes(t),
          )
        ) {
          seedFiles.add(file.relPath);
          seedNodeIds.set(codingV2SymbolNodeId(file.relPath, symbol.qualifiedName), 1);
        }
      }
    }
  }
  if (seedNodeIds.size === 0) {
    return { ranking: rankCodingV4Files(graph, files, options), seedFiles: [], fellBackToGlobal: true };
  }
  const nodeIds = [...graph.nodes.keys()];
  const { scores } = codingV2PageRank(nodeIds, graph.edges, { personalization: seedNodeIds });
  const fileScores = new Map<string, number>();
  const symbolFile = new Map<string, string>();
  for (const [id, node] of graph.nodes) {
    const score = scores.get(id) ?? 0;
    if (node.kind === 'file') {
      fileScores.set(node.file, score);
    } else {
      symbolFile.set(id, node.file);
    }
  }
  for (const [id, node] of graph.nodes) {
    if (node.kind !== 'symbol') continue;
    const file = symbolFile.get(id);
    if (file !== undefined) {
      fileScores.set(file, (fileScores.get(file) ?? 0) + (scores.get(id) ?? 0));
    }
  }
  // File khong co trong fileScores (khong co node) van can xuat hien
  // voi diem 0 de ranking du file — combine chi xep file co trong map.
  for (const file of files) {
    if (!fileScores.has(file.relPath)) fileScores.set(file.relPath, 0);
  }
  return {
    ranking: combineCodingV4Scores(graph, files, fileScores, options),
    seedFiles: [...seedFiles].sort(),
    fellBackToGlobal: false,
  };
}

/**
 * Budget map theo truy van: Personalized PageRank v2 voi seed la
 * file/symbol khop truy van, roi render map rut gon theo diem truy
 * van do (seed xep truoc trong moi nhom diem bang nhau).
 */
export function renderCodingV4QueryBudgetMap(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  query: string,
  options: CodingV4BudgetMapOptions = {},
): CodingV4BudgetMap & { fellBackToGlobal: boolean; seedFiles: string[] } {
  const { ranking, seedFiles, fellBackToGlobal } = rankCodingV4FilesForQuery(
    graph,
    files,
    query,
    options,
  );
  return {
    ...renderCodingV4BudgetMap(graph, files, {
      ...options,
      ranking,
      prioritizeFiles: new Set(seedFiles),
    }),
    fellBackToGlobal,
    seedFiles,
  };
}

// ---------------------------------------------------------------------------
// Cache invalidation (fingerprint tung file)
// ---------------------------------------------------------------------------

/** Fingerprint nhe cua mot file (de phan loai tang dan). */
export interface CodingV4Fingerprint {
  relPath: string;
  mtimeMs: number;
  size: number;
}

export function codingV4FingerprintOf(entry: CodingV2FileEntry): CodingV4Fingerprint {
  return { relPath: entry.relPath, mtimeMs: entry.mtimeMs, size: entry.size };
}

/** Ket qua phan loai invalidation: file nao giu, tinh lai, them, bo. */
export interface CodingV4InvalidationPlan {
  unchanged: string[];
  /** File doi mtime/size: rank cua no + file lien quan phai tinh lai. */
  changed: string[];
  added: string[];
  removed: string[];
  /** Tong so file bi invalid (changed + added + removed). */
  invalidatedCount: number;
  /** true khi co bat ky thay doi nao (can build lai). */
  needsRebuild: boolean;
}

/**
 * So sanh fingerprint cu (trong cache v4) voi fingerprint hien tai
 * (quet tu dia): file doi mtime/size -> changed, file moi -> added,
 * file mat -> removed (stale, bi loai khoi cache).
 */
export function planCodingV4Invalidation(
  previous: Map<string, CodingV4Fingerprint> | Record<string, CodingV4Fingerprint>,
  current: Map<string, CodingV4Fingerprint> | Record<string, CodingV4Fingerprint>,
): CodingV4InvalidationPlan {
  const prev = previous instanceof Map
    ? previous
    : new Map(Object.entries(previous));
  const curr = current instanceof Map
    ? current
    : new Map(Object.entries(current));
  const unchanged: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [relPath, fp] of curr) {
    const old = prev.get(relPath);
    if (!old) {
      added.push(relPath);
    } else if (old.mtimeMs !== fp.mtimeMs || old.size !== fp.size) {
      changed.push(relPath);
    } else {
      unchanged.push(relPath);
    }
  }
  for (const relPath of prev.keys()) {
    if (!curr.has(relPath)) removed.push(relPath);
  }
  const invalidatedCount = changed.length + added.length + removed.length;
  return {
    unchanged: unchanged.sort(),
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    invalidatedCount,
    needsRebuild: invalidatedCount > 0,
  };
}

// ---------------------------------------------------------------------------
// Cache v4 tren dia (ranking snapshot + fingerprint)
// ---------------------------------------------------------------------------

export interface CodingV4CacheFile {
  version: number;
  rootDir: string;
  updatedAt: string;
  weights: CodingV4RankWeights;
  files: number;
  symbols: number;
  edges: number;
  fingerprints: Record<string, CodingV4Fingerprint>;
  /** Top rank snapshot de tool status doc nhanh ma khong build lai. */
  topRanks: Array<{ relPath: string; score: number; pageRankScore: number; referenceScore: number; freshnessScore: number }>;
}

export function serializeCodingV4Cache(cache: CodingV4CacheFile): string {
  return `${JSON.stringify(cache, null, 2)}\n`;
}

/**
 * Parse cache v4. Tra `{ error }` khi version khac, rootDir khac, hoac
 * thieu truong — caller build lai thay vi crash.
 */
export function parseCodingV4Cache(
  text: string,
  expectedRootDir: string,
): { cache: CodingV4CacheFile } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    return { error: `cache v4 JSON hong: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'cache v4 khong phai object JSON' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CODING_V4_CACHE_VERSION) {
    return { error: `cache v4 version ${String(obj.version)} khac ${CODING_V4_CACHE_VERSION}, build lai` };
  }
  if (typeof obj.rootDir !== 'string' || obj.rootDir !== expectedRootDir) {
    return { error: 'cache v4 thuoc workspace khac, build lai' };
  }
  if (
    typeof obj.files !== 'number' ||
    typeof obj.symbols !== 'number' ||
    typeof obj.edges !== 'number' ||
    !obj.fingerprints ||
    typeof obj.fingerprints !== 'object' ||
    Array.isArray(obj.fingerprints) ||
    !Array.isArray(obj.topRanks)
  ) {
    return { error: 'cache v4 thieu truong' };
  }
  const weights = obj.weights as Partial<CodingV4RankWeights> | undefined;
  return {
    cache: {
      version: CODING_V4_CACHE_VERSION,
      rootDir: expectedRootDir,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
      weights: normalizeCodingV4Weights(weights ?? {}),
      files: obj.files,
      symbols: obj.symbols,
      edges: obj.edges,
      fingerprints: obj.fingerprints as Record<string, CodingV4Fingerprint>,
      topRanks: (obj.topRanks as CodingV4CacheFile['topRanks']).filter(
        (r) => r && typeof r.relPath === 'string' && typeof r.score === 'number',
      ),
    },
  };
}

/** Dung cache v4 tu ranking + fingerprint hien tai (de ghi dia). */
export function buildCodingV4CacheFile(
  rootDir: string,
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  ranking: CodingV4Ranking,
  edgeCount: number,
): CodingV4CacheFile {
  const fingerprints: Record<string, CodingV4Fingerprint> = {};
  for (const file of files) fingerprints[file.relPath] = codingV4FingerprintOf(file);
  return {
    version: CODING_V4_CACHE_VERSION,
    rootDir,
    updatedAt: new Date().toISOString(),
    weights: ranking.weights,
    files: graph.stats.files,
    symbols: graph.stats.symbols,
    edges: edgeCount,
    fingerprints,
    topRanks: ranking.ranks.slice(0, 50).map((r) => ({
      relPath: r.relPath,
      score: r.score,
      pageRankScore: r.pageRankScore,
      referenceScore: r.referenceScore,
      freshnessScore: r.freshnessScore,
    })),
  };
}

/**
 * Kiem tra cache v4 con tuoi khong: so fingerprint trong cache voi
 * fingerprint hien tai. Tra plan invalidation (needsRebuild = false
 * nghia la cache dung duoc nguyen).
 */
export function checkCodingV4CacheFreshness(
  cache: CodingV4CacheFile,
  currentFiles: CodingV2FileEntry[],
): CodingV4InvalidationPlan {
  const current = new Map<string, CodingV4Fingerprint>();
  for (const file of currentFiles) current.set(file.relPath, codingV4FingerprintOf(file));
  return planCodingV4Invalidation(cache.fingerprints, current);
}

/** Tien ich: dung toan bo lop v4 tu entries + do thi v2 (mot lan goi). */
export function buildCodingV4All(input: {
  graph: CodingV2Graph;
  files: CodingV2FileEntry[];
  options?: CodingV4RankOptions;
}): CodingV4WeightedMap {
  return buildCodingV4WeightedMap(input.graph, input.files, input.options ?? {});
}
