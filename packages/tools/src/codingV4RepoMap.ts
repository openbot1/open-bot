/**
 * Repo map v4 — store + cache dia (v1.11, Doi T4).
 *
 * Lop fs cho `packages/core/src/codingV4/repoMapV4.ts`: boc
 * `CodingV3RepoMapStore` (quet/parse/cache v2 + call edges + module
 * graph v3) roi dung them 2 lop v4 tren do thi v2:
 *
 *   - PageRank v2: xep hang file theo to hop co trong so (PageRank +
 *     tan suat tham chieu + do moi), map co trong so file -> file.
 *   - Cache invalidation: fingerprint (mtimeMs, size) tung file luu
 *     trong cache v4 `.open-bot/coding-v4/repo-map-v4.json`; build sau
 *     so fingerprint cu/moi de biet file nao doi/them/xoa, chi phan
 *     do bi danh dau stale.
 *
 * Cache v4 hong/khac workspace thi build lai, khong crash (giong v2/v3).
 * File entries lay lai tu cache v2 tren dia — v2 store ghi cache sau
 * moi lan build nen luon tuoi.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildCodingV4CacheFile,
  buildCodingV4WeightedMap,
  checkCodingV4CacheFreshness,
  parseCodingV2Cache,
  parseCodingV4Cache,
  planCodingV4Invalidation,
  rankCodingV4Files,
  renderCodingV4BudgetMap,
  renderCodingV4QueryBudgetMap,
  serializeCodingV4Cache,
  CODING_V4_CACHE_VERSION,
  CODING_V4_DEFAULT_BUDGET_TOKENS,
} from '@open-bot/core';
import type {
  CodingV2FileEntry,
  CodingV2Graph,
  CodingV4BudgetMap,
  CodingV4CacheFile,
  CodingV4Fingerprint,
  CodingV4InvalidationPlan,
  CodingV4RankOptions,
  CodingV4Ranking,
  CodingV4WeightedMap,
} from '@open-bot/core';
import { CodingV3RepoMapStore } from './codingV3RepoMap';
import type { CodingV2MapBuildOptions, CodingV2MapBuildResult } from './codingV2RepoMap';
import type { CodingV3MapBuildResult } from './codingV3RepoMap';

/** Duong dan cache tom tat v4 mac dinh trong workspace (repo-relative). */
export const CODING_V4_DEFAULT_CACHE_REL_PATH = '.open-bot/coding-v4/repo-map-v4.json';

/** File duoc quet khi tinh fingerprint tu dia. */
const CODING_V4_SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);
const CODING_V4_SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.open-bot', 'dist', 'coverage']);
/** Tran file quet fingerprint (cung tran mac dinh voi v2). */
export const CODING_V4_MAX_SCAN_FILES = 5000;

export interface CodingV4MapBuildResult extends CodingV3MapBuildResult {
  /** Duong dan cache v4. */
  v4CachePath: string;
  v4CacheWritten: boolean;
  /** File xep hang cao nhat theo PageRank v2. */
  topFile: { relPath: string; score: number } | null;
  /** Trong so 3 tin hieu da dung cho lan build nay. */
  weights: { pageRank: number; references: number; freshness: number };
  /** Invalidation so voi cache v4 truoc (doi/them/xoa). */
  changed: number;
  added: number;
  removed: number;
}

export function resolveCodingV4CachePath(rootDir: string, cachePath?: string): string {
  if (!cachePath) return path.join(rootDir, CODING_V4_DEFAULT_CACHE_REL_PATH);
  const resolved = path.isAbsolute(cachePath) ? path.resolve(cachePath) : path.resolve(rootDir, cachePath);
  return resolved;
}

/** Quet fingerprint (mtimeMs, size) cua file code trong workspace. */
export function scanCodingV4Fingerprints(rootDir: string): Map<string, CodingV4Fingerprint> {
  const out = new Map<string, CodingV4Fingerprint>();
  const walk = (dir: string, relBase: string): void => {
    if (out.size >= CODING_V4_MAX_SCAN_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= CODING_V4_MAX_SCAN_FILES) return;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (CODING_V4_SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(abs, rel);
      } else if (entry.isFile()) {
        if (!CODING_V4_SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
        try {
          const stat = fs.statSync(abs);
          if (stat.size > 1024 * 1024) continue;
          out.set(rel, { relPath: rel, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // File bien mat giua chung: bo qua.
        }
      }
    }
  };
  walk(rootDir, '');
  return out;
}

/**
 * Store repo map v4 cho mot workspace: giu store v3 ben trong, cache
 * v4 tren dia, build tang dan (nho v2/v3: chi parse lai file doi/moi).
 */
export class CodingV4RepoMapStore {
  readonly rootDir: string;
  readonly v4CachePath: string;
  private readonly v3Store: CodingV3RepoMapStore;
  private ranking: CodingV4Ranking | null = null;
  private weightedMap: CodingV4WeightedMap | null = null;
  private lastBuild: CodingV4MapBuildResult | null = null;

  constructor(rootDir: string, options: { cachePath?: string; v3Store?: CodingV3RepoMapStore } = {}) {
    const resolved = path.resolve(rootDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Thu muc workspace khong ton tai: ${rootDir}.`);
    }
    this.rootDir = resolved;
    this.v4CachePath = resolveCodingV4CachePath(resolved, options.cachePath);
    this.v3Store = options.v3Store ?? new CodingV3RepoMapStore(resolved);
  }

  get entryCount(): number {
    return this.v3Store.entryCount;
  }

  get isBuilt(): boolean {
    return this.v3Store.isBuilt && this.ranking !== null && this.weightedMap !== null;
  }

  get lastBuildResult(): CodingV4MapBuildResult | null {
    return this.lastBuild;
  }

  get v3(): CodingV3RepoMapStore {
    return this.v3Store;
  }

  /** File entries tu cache v2 tren dia (ghi sau moi lan build v2). */
  private fileEntries(): CodingV2FileEntry[] {
    try {
      const text = fs.readFileSync(this.v3Store.v2.cachePath, 'utf8');
      const parsed = parseCodingV2Cache(text, this.rootDir);
      if ('error' in parsed) return [];
      return Object.values(parsed.cache.files);
    } catch {
      return [];
    }
  }

  private loadV4Cache(): CodingV4CacheFile | null {
    try {
      const text = fs.readFileSync(this.v4CachePath, 'utf8');
      const parsed = parseCodingV4Cache(text, this.rootDir);
      if ('error' in parsed) return null;
      return parsed.cache;
    } catch {
      return null;
    }
  }

  private rebuildV4Layers(options: CodingV4RankOptions = {}): void {
    const graph = this.v3Store.getGraph();
    if (!graph) {
      this.ranking = null;
      this.weightedMap = null;
      return;
    }
    const files = this.fileEntries();
    this.weightedMap = buildCodingV4WeightedMap(graph, files, options);
    this.ranking = this.weightedMap.ranking;
  }

  private saveV4Cache(): boolean {
    const graph = this.v3Store.getGraph();
    if (!graph || !this.ranking || !this.weightedMap) return false;
    const cache = buildCodingV4CacheFile(
      this.rootDir,
      graph,
      this.fileEntries(),
      this.ranking,
      this.weightedMap.edges.length,
    );
    try {
      fs.mkdirSync(path.dirname(this.v4CachePath), { recursive: true });
      fs.writeFileSync(this.v4CachePath, serializeCodingV4Cache(cache), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** Build/refresh: v3 build tang dan roi dung lop v4 + ghi cache v4. */
  async build(
    options: CodingV2MapBuildOptions & { v4CachePath?: string; rankOptions?: CodingV4RankOptions } = {},
  ): Promise<CodingV4MapBuildResult> {
    const prevCache = this.loadV4Cache();
    const v3Result = await this.v3Store.build(options);
    const v4CachePath = options.v4CachePath
      ? resolveCodingV4CachePath(this.rootDir, options.v4CachePath)
      : this.v4CachePath;
    const warnings = [...v3Result.warnings];

    this.rebuildV4Layers(options.rankOptions);
    const v4CacheWritten = this.saveV4Cache();
    if (!v4CacheWritten) warnings.push(`Khong ghi duoc cache v4 ${v4CachePath}.`);

    // Invalidation so voi cache v4 truoc (neu co).
    let changed = 0;
    let added = 0;
    let removed = 0;
    if (prevCache) {
      const plan = checkCodingV4CacheFreshness(prevCache, this.fileEntries());
      changed = plan.changed.length;
      added = plan.added.length;
      removed = plan.removed.length;
    } else if (this.ranking) {
      added = this.ranking.stats.files;
    }

    const topRank = this.ranking?.ranks[0] ?? null;
    const result: CodingV4MapBuildResult = {
      ...v3Result,
      warnings,
      v4CachePath,
      v4CacheWritten,
      topFile: topRank ? { relPath: topRank.relPath, score: topRank.score } : null,
      weights: this.ranking?.weights ?? { pageRank: 0.5, references: 0.3, freshness: 0.2 },
      changed,
      added,
      removed,
    };
    this.lastBuild = result;
    return result;
  }

  /** Build neu chua co ranking trong bo nho. */
  async ensureBuilt(): Promise<CodingV4MapBuildResult> {
    if (this.isBuilt && this.lastBuild) return this.lastBuild;
    return this.build();
  }

  /** Do thi v2 hien tai (null khi chua build). */
  getGraph(): CodingV2Graph | null {
    return this.v3Store.getGraph();
  }

  getRanking(): CodingV4Ranking | null {
    return this.ranking;
  }

  getWeightedMap(): CodingV4WeightedMap | null {
    return this.weightedMap;
  }

  /** Top file theo PageRank v2 (ke ca diem thanh phan). */
  topFiles(limit = 10): CodingV4Ranking['ranks'] {
    if (!this.ranking) throw new Error('Repo map v4 chua duoc build — goi repomap_v4_build truoc.');
    return this.ranking.ranks.slice(0, Math.max(0, limit));
  }

  /**
   * Xep hang lai voi trong so tuy chinh (khong ghi cache): dung khi
   * host muon thu trong so khac ma khong build lai toan bo.
   */
  rankWithWeights(options: CodingV4RankOptions): CodingV4Ranking {
    const graph = this.v3Store.getGraph();
    if (!graph) throw new Error('Repo map v4 chua duoc build — goi repomap_v4_build truoc.');
    return rankCodingV4Files(graph, this.fileEntries(), options);
  }

  /** Repo map rut gon theo ngan sach token (PageRank v2, co/khong truy van). */
  budgetMap(budgetTokens: number = CODING_V4_DEFAULT_BUDGET_TOKENS, query?: string): CodingV4BudgetMap {
    const graph = this.v3Store.getGraph();
    if (!graph) throw new Error('Repo map v4 chua duoc build — goi repomap_v4_build truoc.');
    const files = this.fileEntries();
    if (query && query.trim() !== '') {
      return renderCodingV4QueryBudgetMap(graph, files, query, { budgetTokens });
    }
    return renderCodingV4BudgetMap(graph, files, { budgetTokens });
  }

  /**
   * Kiem tra invalidation ma khong build: quet fingerprint tren dia
   * roi so voi cache v4 truoc. Chua tung build -> moi file deu la
   * "added" (can build).
   */
  invalidate(): CodingV4InvalidationPlan & { cachedFiles: number; scannedFiles: number } {
    const current = scanCodingV4Fingerprints(this.rootDir);
    const cache = this.loadV4Cache();
    if (!cache) {
      return {
        unchanged: [],
        changed: [],
        added: [...current.keys()].sort(),
        removed: [],
        invalidatedCount: current.size,
        needsRebuild: true,
        cachedFiles: 0,
        scannedFiles: current.size,
      };
    }
    const plan = planCodingV4Invalidation(cache.fingerprints, current);
    return { ...plan, cachedFiles: Object.keys(cache.fingerprints).length, scannedFiles: current.size };
  }

  /** Thong ke nhanh (khong build lai). */
  stats(): {
    built: boolean;
    rootDir: string;
    v2CachePath: string;
    v3CachePath: string;
    v4CachePath: string;
    v4CacheVersion: number;
    files: number;
    symbols: number;
    edges: number;
    weightedEdges: number;
  } {
    const graph = this.v3Store.getGraph();
    return {
      built: this.isBuilt,
      rootDir: this.rootDir,
      v2CachePath: this.v3Store.v2.cachePath,
      v3CachePath: this.v3Store.v3CachePath,
      v4CachePath: this.v4CachePath,
      v4CacheVersion: CODING_V4_CACHE_VERSION,
      files: this.v3Store.entryCount,
      symbols: graph?.stats.symbols ?? 0,
      edges: graph?.stats.edges ?? 0,
      weightedEdges: this.weightedMap?.edges.length ?? 0,
    };
  }
}

export type { CodingV2MapBuildResult };
