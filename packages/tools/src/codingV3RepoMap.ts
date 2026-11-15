/**
 * Repo map v3 — store + cache đĩa (v1.10, Đội T4).
 *
 * Lớp fs cho `packages/core/src/codingV3/repoMapV3.ts`: bọc
 * `CodingV2RepoMapStore` (quét/parse/cache v2) rồi dựng thêm 3 lớp
 * v3 trên đồ thị v2:
 *
 *   - call edges file -> file (import + nhắc symbol),
 *   - module graph (gom file theo thư mục),
 *   - budget map (repo map rút gọn theo ngân sách token).
 *
 * Cache tóm tắt v3 (JSON version 3) nằm cạnh cache v2:
 * `.open-bot/coding-v3/repo-map-v3.json` — lưu module ranking + top
 * call edges để tool status đọc nhanh mà không build lại đồ thị.
 * Cache v3 hỏng/khác workspace thì build lại, không crash (giống v2).
 *
 * Lưu ý: file entries (symbols từng file) lấy lại từ cache v2 trên
 * đĩa — v2 store ghi cache sau mỗi lần build nên luôn tươi; nếu ghi
 * cache v2 thất bại thì budget map trả rỗng và build đã báo warning.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildCodingV3CacheSummary,
  buildCodingV3CallGraph,
  buildCodingV3ModuleGraph,
  codingV3TopCallersOf,
  codingV3TopCallsFrom,
  parseCodingV2Cache,
  parseCodingV3Cache,
  renderCodingV3BudgetMap,
  renderCodingV3QueryBudgetMap,
  serializeCodingV3Cache,
  CODING_V3_CACHE_VERSION,
  CODING_V3_DEFAULT_BUDGET_TOKENS,
} from '@open-bot/core';
import type {
  CodingV2FileEntry,
  CodingV2Graph,
  CodingV3BudgetMap,
  CodingV3CacheFile,
  CodingV3CallEdge,
  CodingV3CallGraph,
  CodingV3ModuleGraph,
} from '@open-bot/core';
import { CodingV2RepoMapStore } from './codingV2RepoMap';
import type { CodingV2MapBuildOptions, CodingV2MapBuildResult } from './codingV2RepoMap';

/** Đường dẫn cache tóm tắt v3 mặc định trong workspace (repo-relative). */
export const CODING_V3_DEFAULT_CACHE_REL_PATH = '.open-bot/coding-v3/repo-map-v3.json';

export interface CodingV3MapBuildResult extends CodingV2MapBuildResult {
  /** Đường dẫn cache tóm tắt v3. */
  v3CachePath: string;
  v3CacheWritten: boolean;
  callEdges: number;
  modules: number;
  /** Module xếp hạng cao nhất (tên + điểm). */
  topModule: { module: string; score: number } | null;
}

export function resolveCodingV3CachePath(rootDir: string, cachePath?: string): string {
  if (!cachePath) return path.join(rootDir, CODING_V3_DEFAULT_CACHE_REL_PATH);
  const resolved = path.isAbsolute(cachePath) ? path.resolve(cachePath) : path.resolve(rootDir, cachePath);
  return resolved;
}

/**
 * Store repo map v3 cho một workspace: giữ store v2 bên trong, cache
 * tóm tắt v3 trên đĩa, build tăng dần (nhờ v2: chỉ parse lại file
 * đổi/mới).
 */
export class CodingV3RepoMapStore {
  readonly rootDir: string;
  readonly v3CachePath: string;
  private readonly v2Store: CodingV2RepoMapStore;
  private callGraph: CodingV3CallGraph | null = null;
  private moduleGraph: CodingV3ModuleGraph | null = null;
  private lastBuild: CodingV3MapBuildResult | null = null;

  constructor(rootDir: string, options: { cachePath?: string; v2Store?: CodingV2RepoMapStore } = {}) {
    const resolved = path.resolve(rootDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Thư mục workspace không tồn tại: ${rootDir}.`);
    }
    this.rootDir = resolved;
    this.v3CachePath = resolveCodingV3CachePath(resolved, options.cachePath);
    this.v2Store = options.v2Store ?? new CodingV2RepoMapStore(resolved);
  }

  get entryCount(): number {
    return this.v2Store.entryCount;
  }

  get isBuilt(): boolean {
    return this.v2Store.isBuilt && this.callGraph !== null && this.moduleGraph !== null;
  }

  get lastBuildResult(): CodingV3MapBuildResult | null {
    return this.lastBuild;
  }

  get v2(): CodingV2RepoMapStore {
    return this.v2Store;
  }

  /** File entries từ cache v2 trên đĩa (ghi sau mỗi lần build v2). */
  private fileEntries(): CodingV2FileEntry[] {
    try {
      const text = fs.readFileSync(this.v2Store.cachePath, 'utf8');
      const parsed = parseCodingV2Cache(text, this.rootDir);
      if ('error' in parsed) return [];
      return Object.values(parsed.cache.files);
    } catch {
      return [];
    }
  }

  private rebuildV3Layers(): void {
    const graph = this.v2Store.getGraph();
    if (!graph) {
      this.callGraph = null;
      this.moduleGraph = null;
      return;
    }
    const callGraph = buildCodingV3CallGraph(graph);
    this.callGraph = callGraph;
    this.moduleGraph = buildCodingV3ModuleGraph(graph, callGraph, this.fileEntries());
  }

  private loadV3Cache(cachePath: string): { cache: CodingV3CacheFile | null; warning?: string } {
    let text: string;
    try {
      text = fs.readFileSync(cachePath, 'utf8');
    } catch {
      return { cache: null };
    }
    const parsed = parseCodingV3Cache(text, this.rootDir);
    if ('error' in parsed) {
      return { cache: null, warning: `Cache repo map v3 không dùng được (${parsed.error}) — build lại từ đầu.` };
    }
    return { cache: parsed.cache };
  }

  private saveV3Cache(cachePath: string): boolean {
    const graph = this.v2Store.getGraph();
    if (!graph || !this.callGraph || !this.moduleGraph) return false;
    const summary = buildCodingV3CacheSummary(this.rootDir, graph, this.callGraph, this.moduleGraph);
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, serializeCodingV3Cache(summary), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** Build/refresh: v2 build tăng dần rồi dựng lớp v3 + ghi cache v3. */
  async build(options: CodingV2MapBuildOptions & { v3CachePath?: string } = {}): Promise<CodingV3MapBuildResult> {
    const v2Result = await this.v2Store.build(options);
    const v3CachePath = options.v3CachePath
      ? resolveCodingV3CachePath(this.rootDir, options.v3CachePath)
      : this.v3CachePath;
    const warnings = [...v2Result.warnings];
    const loaded = this.loadV3Cache(v3CachePath);
    if (loaded.warning) warnings.push(loaded.warning);

    this.rebuildV3Layers();
    const v3CacheWritten = this.saveV3Cache(v3CachePath);
    if (!v3CacheWritten) warnings.push(`Không ghi được cache v3 ${v3CachePath}.`);

    const topModuleEntry = this.moduleGraph?.modules[0];
    const result: CodingV3MapBuildResult = {
      ...v2Result,
      warnings,
      v3CachePath,
      v3CacheWritten,
      callEdges: this.callGraph?.edges.length ?? 0,
      modules: this.moduleGraph?.modules.length ?? 0,
      topModule: topModuleEntry ? { module: topModuleEntry.module, score: topModuleEntry.score } : null,
    };
    this.lastBuild = result;
    return result;
  }

  /** Build nếu chưa có đồ thị trong bộ nhớ. */
  async ensureBuilt(): Promise<CodingV3MapBuildResult> {
    if (this.isBuilt && this.lastBuild) return this.lastBuild;
    return this.build();
  }

  /** Đồ thị v2 hiện tại (null khi chưa build). */
  getGraph(): CodingV2Graph | null {
    return this.v2Store.getGraph();
  }

  getCallGraph(): CodingV3CallGraph | null {
    return this.callGraph;
  }

  getModuleGraph(): CodingV3ModuleGraph | null {
    return this.moduleGraph;
  }

  /** Top call edges (file -> file) theo trọng số. */
  topCallEdges(limit = 20): CodingV3CallEdge[] {
    if (!this.callGraph) throw new Error('Repo map v3 chưa được build — gọi repomap_v3_build trước.');
    return this.callGraph.edges.slice(0, Math.max(0, limit));
  }

  /** File mà `relPath` gọi nhiều nhất. */
  topCallsFrom(relPath: string, limit = 10): CodingV3CallEdge[] {
    if (!this.callGraph) throw new Error('Repo map v3 chưa được build — gọi repomap_v3_build trước.');
    return codingV3TopCallsFrom(this.callGraph, relPath, limit);
  }

  /** File gọi tới `relPath` nhiều nhất. */
  topCallersOf(relPath: string, limit = 10): CodingV3CallEdge[] {
    if (!this.callGraph) throw new Error('Repo map v3 chưa được build — gọi repomap_v3_build trước.');
    return codingV3TopCallersOf(this.callGraph, relPath, limit);
  }

  /** Repo map rút gọn theo ngân sách token (toàn cục). */
  budgetMap(budgetTokens: number = CODING_V3_DEFAULT_BUDGET_TOKENS): CodingV3BudgetMap {
    const graph = this.v2Store.getGraph();
    if (!graph) throw new Error('Repo map v3 chưa được build — gọi repomap_v3_build trước.');
    return renderCodingV3BudgetMap(graph, this.fileEntries(), { budgetTokens });
  }

  /** Repo map rút gọn theo truy vấn (Personalized PageRank + ngân sách). */
  queryBudgetMap(
    query: string,
    budgetTokens: number = CODING_V3_DEFAULT_BUDGET_TOKENS,
  ): CodingV3BudgetMap & { fellBackToGlobal: boolean; seedFiles: string[] } {
    const graph = this.v2Store.getGraph();
    if (!graph) throw new Error('Repo map v3 chưa được build — gọi repomap_v3_build trước.');
    return renderCodingV3QueryBudgetMap(graph, this.fileEntries(), query, { budgetTokens });
  }

  /** Thống kê nhanh (không build lại). */
  stats(): {
    built: boolean;
    rootDir: string;
    v2CachePath: string;
    v3CachePath: string;
    v3CacheVersion: number;
    files: number;
    symbols: number;
    edges: number;
    callEdges: number;
    modules: number;
  } {
    const graph = this.v2Store.getGraph();
    return {
      built: this.isBuilt,
      rootDir: this.rootDir,
      v2CachePath: this.v2Store.cachePath,
      v3CachePath: this.v3CachePath,
      v3CacheVersion: CODING_V3_CACHE_VERSION,
      files: this.v2Store.entryCount,
      symbols: graph?.stats.symbols ?? 0,
      edges: graph?.stats.edges ?? 0,
      callEdges: this.callGraph?.edges.length ?? 0,
      modules: this.moduleGraph?.modules.length ?? 0,
    };
  }
}
