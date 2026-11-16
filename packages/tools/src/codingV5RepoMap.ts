/**
 * Repo map v5 — store + cache dia (v1.13, Doi T3).
 *
 * Lop fs cho `packages/core/src/codingV5/*`: boc
 * `CodingV2RepoMapStore` (quet/parse/cache v2 — tree-sitter symbol
 * + do thi symbol-level + PageRank) roi dung them 5 lop v5 tren
 * entries + source text doc tu dia:
 *
 *   1. Symbol topology: export/import/call-site (regex tren source,
 *      resolve import tuong doi bang `resolveRelativeImport` cua v2).
 *   2. Hierarchical summaries: tom tat tung thu muc, rollup len cha.
 *   3. Incremental index v5: record (fingerprint + content hash
 *      FNV-1a + import) + cache JSON version 5
 *      `.open-bot/coding-v5/repo-map-v5.json`; build sau chi parse
 *      lai file doi noi dung that, invalid theo phu thuoc.
 *   4. Code graph search: tim symbol / caller / callee / importer.
 *   5. Jump-to-definition: dinh nghia + context dong + usages.
 *
 * File entries lay lai tu cache v2 tren dia — v2 store ghi cache sau
 * moi lan build nen luon tuoi (giong cach v3/v4 lam). Source text
 * doc lai tu dia khi build topology (re hon cache: luon khop file
 * hien tai, khong phu thuoc vao cache v2).
 *
 * Cache v5 hong/khac workspace thi build lai, khong crash (giong
 * v2/v3/v4). Khong co file code nao thi build tra map rong + warning.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildCodingV5IndexCacheFile,
  buildCodingV5SummaryTree,
  buildCodingV5Topology,
  checkCodingV5IndexFreshness,
  codingV5ContentHash,
  codingV5RecordOf,
  findCodingV5Callers,
  findCodingV5Callees,
  findCodingV5Importers,
  impactCodingV5Of,
  jumpCodingV5ToDefinition,
  mergeCodingV5Records,
  parseCodingV2Cache,
  parseCodingV5IndexCache,
  planCodingV5Incremental,
  renderCodingV5JumpResult,
  renderCodingV5Skeleton,
  renderCodingV5TopologySummary,
  searchCodingV5Symbols,
  serializeCodingV5IndexCache,
  CODING_V5_DEFAULT_SUMMARY_BUDGET_TOKENS,
  CODING_V5_INDEX_CACHE_VERSION,
} from '@open-bot/core';
import type {
  CodingV2FileEntry,
  CodingV2Graph,
  CodingV5CallerHit,
  CodingV5CalleeHit,
  CodingV5DirectorySummary,
  CodingV5ImportSearchResult,
  CodingV5IncrementalPlan,
  CodingV5IndexCacheFile,
  CodingV5IndexRecord,
  CodingV5JumpOptions,
  CodingV5JumpResult,
  CodingV5SearchOptions,
  CodingV5Skeleton,
  CodingV5SummaryTree,
  CodingV5SymbolSearchHit,
  CodingV5Topology,
} from '@open-bot/core';
import { CodingV2RepoMapStore } from './codingV2RepoMap';
import type { CodingV2MapBuildOptions, CodingV2MapBuildResult } from './codingV2RepoMap';
import { resolveRelativeImport } from './repoMap';

/** Duong dan cache index v5 mac dinh trong workspace (repo-relative). */
export const CODING_V5_DEFAULT_CACHE_REL_PATH = '.open-bot/coding-v5/repo-map-v5.json';
/** Tran file doc source khi build topology (cung tran mac dinh voi v2). */
export const CODING_V5_MAX_SOURCE_FILES = 2000;
/** File lon hon nguong nay khong doc source (topology bo qua file do). */
export const CODING_V5_MAX_SOURCE_BYTES = 1_000_000;

export interface CodingV5MapBuildResult extends CodingV2MapBuildResult {
  /** Duong dan cache index v5. */
  v5CachePath: string;
  v5CacheWritten: boolean;
  /** Thong ke topology v5 (export/import/call site/chu trinh/orphan). */
  topology: CodingV5Topology['stats'] | null;
  /** So thu muc co trong cay tom tat phan cap. */
  directories: number;
  /** Ke hoach tang dan v5 cua lan build nay (so voi cache cu). */
  plan: CodingV5IncrementalPlan | null;
  /** File doi metadata nhung cung content hash (khong parse lai). */
  metadataOnly: number;
  /** File bi invalid theo phu thuoc (tinh lai diem/tom tat). */
  invalidatedByDependency: number;
}

export function resolveCodingV5CachePath(rootDir: string, cachePath?: string): string {
  if (!cachePath) return path.join(rootDir, CODING_V5_DEFAULT_CACHE_REL_PATH);
  const resolved = path.isAbsolute(cachePath) ? path.resolve(cachePath) : path.resolve(rootDir, cachePath);
  return resolved;
}

/** Doc source text cua cac entry (bo file qua lon / doc loi). */
export function readCodingV5Sources(
  rootDir: string,
  entries: CodingV2FileEntry[],
  maxFiles: number = CODING_V5_MAX_SOURCE_FILES,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    if (out.size >= maxFiles) break;
    if (entry.size > CODING_V5_MAX_SOURCE_BYTES) continue;
    try {
      out.set(entry.relPath, fs.readFileSync(path.join(rootDir, entry.relPath), 'utf8'));
    } catch {
      // File bien mat giua chung: bo qua, topology van co entry.
    }
  }
  return out;
}

/**
 * Store repo map v5 cho mot workspace: giu store v2 ben trong, cache
 * index v5 tren dia, build tang dan (nho v2: chi parse lai file doi/
 * moi; nho v5: chi tinh lai topology/tom tat cho file doi + file bi
 * invalid theo phu thuoc — phan con lai tai dung tu cache).
 */
export class CodingV5RepoMapStore {
  readonly rootDir: string;
  readonly v5CachePath: string;
  private readonly v2Store: CodingV2RepoMapStore;
  private topology: CodingV5Topology | null = null;
  private summaryTree: CodingV5SummaryTree | null = null;
  private indexCache: CodingV5IndexCacheFile | null = null;
  private lastBuild: CodingV5MapBuildResult | null = null;

  constructor(rootDir: string, options: { cachePath?: string; v2Store?: CodingV2RepoMapStore } = {}) {
    const resolved = path.resolve(rootDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Thư mục workspace không tồn tại: ${rootDir}.`);
    }
    this.rootDir = resolved;
    this.v5CachePath = resolveCodingV5CachePath(resolved, options.cachePath);
    this.v2Store = options.v2Store ?? new CodingV2RepoMapStore(resolved);
  }

  get entryCount(): number {
    return this.v2Store.entryCount;
  }

  get isBuilt(): boolean {
    return this.v2Store.isBuilt && this.topology !== null && this.summaryTree !== null;
  }

  get lastBuildResult(): CodingV5MapBuildResult | null {
    return this.lastBuild;
  }

  get v2(): CodingV2RepoMapStore {
    return this.v2Store;
  }

  /** File entries tu cache v2 tren dia (ghi sau moi lan build v2). */
  private fileEntries(): CodingV2FileEntry[] {
    try {
      const text = fs.readFileSync(this.v2Store.cachePath, 'utf8');
      const parsed = parseCodingV2Cache(text, this.rootDir);
      if ('error' in parsed) return [];
      return Object.values(parsed.cache.files).sort((a, b) => a.relPath.localeCompare(b.relPath));
    } catch {
      return [];
    }
  }

  /** Do thi v2 hien tai (null khi chua build). */
  getGraph(): CodingV2Graph | null {
    return this.v2Store.getGraph();
  }

  getTopology(): CodingV5Topology | null {
    return this.topology;
  }

  getSummaryTree(): CodingV5SummaryTree | null {
    return this.summaryTree;
  }

  getIndexCache(): CodingV5IndexCacheFile | null {
    return this.indexCache;
  }

  private loadV5Cache(cachePath: string): { cache: CodingV5IndexCacheFile | null; warning?: string } {
    let text: string;
    try {
      text = fs.readFileSync(cachePath, 'utf8');
    } catch {
      return { cache: null };
    }
    const parsed = parseCodingV5IndexCache(text, this.rootDir);
    if ('error' in parsed) {
      return { cache: null, warning: `Cache repo map v5 không dùng được (${parsed.error}) — build lại từ đầu.` };
    }
    return { cache: parsed.cache };
  }

  private saveV5Cache(cachePath: string): boolean {
    if (!this.indexCache) return false;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, serializeCodingV5IndexCache(this.indexCache), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** Dung lai topology + summary tree tu entries + graph hien tai. */
  private rebuildV5Layers(): void {
    const graph = this.v2Store.getGraph();
    const entries = this.fileEntries();
    if (!graph || entries.length === 0) {
      this.topology = null;
      this.summaryTree = null;
      return;
    }
    const sources = readCodingV5Sources(this.rootDir, entries);
    const knownAbs = new Set(entries.map((e) => path.join(this.rootDir, e.relPath)));
    this.topology = buildCodingV5Topology({
      files: entries,
      sources,
      resolveImport: (fromFile, specifier) => {
        const resolved = resolveRelativeImport(specifier, path.join(this.rootDir, fromFile), knownAbs);
        if (resolved === null) return null;
        return path.relative(this.rootDir, resolved).split(path.sep).join('/');
      },
    });
    this.summaryTree = buildCodingV5SummaryTree(entries, graph, this.topology);
  }

  /**
   * Build/refresh: v2 build tang dan (chi parse lai file doi/moi),
   * roi dung topology + summary + index cache v5. Index cache cu
   * dung de phan loai metadata-only (doi mtime nhung cung hash) va
   * invalid theo phu thuoc.
   */
  async build(
    options: CodingV2MapBuildOptions & { v5CachePath?: string } = {},
  ): Promise<CodingV5MapBuildResult> {
    const started = Date.now();
    const v5CachePath = options.v5CachePath
      ? resolveCodingV5CachePath(this.rootDir, options.v5CachePath)
      : this.v5CachePath;
    const loaded = this.loadV5Cache(v5CachePath);
    const v2Result = await this.v2Store.build(options);
    const warnings = [...v2Result.warnings];
    if (loaded.warning) warnings.push(loaded.warning);

    const entries = this.fileEntries();
    const graph = this.v2Store.getGraph();
    this.rebuildV5Layers();

    // Ke hoach tang dan v5: so fingerprint + hash hien tai voi cache cu.
    let plan: CodingV5IncrementalPlan | null = null;
    let metadataOnly = 0;
    let invalidatedByDependency = 0;
    const sources = readCodingV5Sources(this.rootDir, entries);
    const contentHashes = new Map<string, string>();
    for (const [relPath, source] of sources) contentHashes.set(relPath, codingV5ContentHash(source));
    if (loaded.cache) {
      plan = planCodingV5Incremental({
        current: new Map(entries.map((e) => [e.relPath, { relPath: e.relPath, mtimeMs: e.mtimeMs, size: e.size }])),
        contentHashes,
        previous: loaded.cache.records,
        importers: loaded.cache.importers,
      });
      metadataOnly = plan.metadataOnly.length;
      invalidatedByDependency = plan.invalidatedByDependency.length;
    } else if (entries.length > 0) {
      // Chua co cache v5: moi file deu la "added" o lan dau.
      plan = {
        unchanged: [],
        metadataOnly: [],
        changed: [],
        added: entries.map((e) => e.relPath).sort(),
        removed: [],
        invalidatedByDependency: [],
        invalidatedCount: entries.length,
        needsRebuild: true,
      };
    }

    // Cap nhat index cache v5: record moi cho file doi/moi, giu record
    // cu cho file khong doi, cap nhat fingerprint cho metadata-only.
    const freshRecords: CodingV5IndexRecord[] = [];
    const changedSet = new Set([...(plan?.changed ?? []), ...(plan?.added ?? [])]);
    for (const entry of entries) {
      if (changedSet.has(entry.relPath)) {
        freshRecords.push(codingV5RecordOf(entry, contentHashes.get(entry.relPath) ?? ''));
      }
    }
    const removed = plan?.removed ?? [];
    const metadataUpdates = (plan?.metadataOnly ?? [])
      .map((relPath) => entries.find((e) => e.relPath === relPath))
      .filter((e): e is CodingV2FileEntry => e !== undefined)
      .map((e) => ({ relPath: e.relPath, mtimeMs: e.mtimeMs, size: e.size }));
    const previousRecords = new Map<string, CodingV5IndexRecord>(
      loaded.cache ? Object.entries(loaded.cache.records) : [],
    );
    // Lan dau (khong co cache cu): record cho TAT CA file, khong chi file doi.
    if (!loaded.cache) {
      for (const entry of entries) {
        if (!changedSet.has(entry.relPath)) {
          freshRecords.push(codingV5RecordOf(entry, contentHashes.get(entry.relPath) ?? ''));
        }
      }
    }
    const merged = mergeCodingV5Records(previousRecords, freshRecords, removed, metadataUpdates);
    this.indexCache = buildCodingV5IndexCacheFile(this.rootDir, merged);
    const v5CacheWritten = this.saveV5Cache(v5CachePath);
    if (!v5CacheWritten) warnings.push(`Không ghi được cache v5 ${v5CachePath}.`);

    const result: CodingV5MapBuildResult = {
      ...v2Result,
      warnings,
      durationMs: Date.now() - started,
      v5CachePath,
      v5CacheWritten,
      topology: this.topology?.stats ?? null,
      directories: this.summaryTree?.stats.directories ?? 0,
      plan,
      metadataOnly,
      invalidatedByDependency,
    };
    void graph;
    this.lastBuild = result;
    return result;
  }

  /** Build neu chua co topology/summary trong bo nho. */
  async ensureBuilt(): Promise<CodingV5MapBuildResult> {
    if (this.isBuilt && this.lastBuild) return this.lastBuild;
    return this.build();
  }

  /** Kiem tra index v5 con tuoi khong (khong build lai). */
  checkIndexFreshness(): CodingV5IncrementalPlan | { error: string } {
    const cache = this.indexCache ?? this.loadV5Cache(this.v5CachePath).cache;
    if (!cache) return { error: 'Chưa có cache index v5 — gọi repomap_v5_build trước.' };
    const entries = this.fileEntries();
    // Repo trong (0 file) van la da build neu co cache index v5 —
    // khong nham "khong co entry" voi "chua build".
    const sources = readCodingV5Sources(this.rootDir, entries);
    const contentHashes = new Map<string, string>();
    for (const [relPath, source] of sources) contentHashes.set(relPath, codingV5ContentHash(source));
    return checkCodingV5IndexFreshness(cache, entries, contentHashes);
  }

  /** Thong ke nhanh cho tool status (khong build lai). */
  stats(): {
    built: boolean;
    rootDir: string;
    cachePath: string;
    files: number;
    symbols: number;
    exports: number;
    imports: number;
    callSites: number;
    cycles: number;
    orphans: number;
    directories: number;
  } {
    const t = this.topology?.stats;
    return {
      built: this.isBuilt,
      rootDir: this.rootDir,
      cachePath: this.v5CachePath,
      files: this.v2Store.entryCount,
      symbols: t?.symbols ?? 0,
      exports: t?.exports ?? 0,
      imports: t?.imports ?? 0,
      callSites: t?.callSites ?? 0,
      cycles: t?.cycles ?? 0,
      orphans: t?.orphans ?? 0,
      directories: this.summaryTree?.stats.directories ?? 0,
    };
  }

  // -- Truy van (can build truoc) -------------------------------------------

  private requireBuilt(): { entries: CodingV2FileEntry[]; graph: CodingV2Graph; topology: CodingV5Topology } {
    const graph = this.v2Store.getGraph();
    if (!graph || !this.topology) {
      throw new Error('Repo map v5 chưa được build — gọi repomap_v5_build trước.');
    }
    return { entries: this.fileEntries(), graph, topology: this.topology };
  }

  /** Tim symbol theo ten/mau tren do thi code. */
  searchSymbols(
    query: string,
    options: CodingV5SearchOptions = {},
  ): { hits: CodingV5SymbolSearchHit[]; modeUsed: string; fellBack: boolean } {
    const { entries, graph, topology } = this.requireBuilt();
    return searchCodingV5Symbols(entries, query, topology, graph, options);
  }

  /** Caller cua mot symbol (ham nao goi no, o dong nao). */
  callersOf(
    name: string,
    options: { limit?: number; file?: string } = {},
  ): { callers: CodingV5CallerHit[]; definitions: string[]; ambiguous: boolean } {
    const { entries, topology } = this.requireBuilt();
    return findCodingV5Callers(topology, entries, name, options);
  }

  /** Callee cua mot symbol (ham do goi ham nao). */
  calleesOf(
    file: string,
    qualifiedName: string,
    options: { limit?: number } = {},
  ): { callees: CodingV5CalleeHit[]; found: boolean } {
    const { topology } = this.requireBuilt();
    return findCodingV5Callees(topology, file, qualifiedName, options);
  }

  /** Impact analysis: doi symbol nay thi anh huong toi dau. */
  impactOf(
    name: string,
    options: { maxDepth?: number; limit?: number } = {},
  ): ReturnType<typeof impactCodingV5Of> {
    const { entries, topology } = this.requireBuilt();
    return impactCodingV5Of(topology, entries, name, options);
  }

  /** File nao import mot module. */
  importersOf(query: string, options: { limit?: number } = {}): CodingV5ImportSearchResult {
    const { topology } = this.requireBuilt();
    return findCodingV5Importers(topology, query, options);
  }

  /** Jump-to-definition: dinh nghia + context + usages. */
  jumpToDefinition(
    query: string,
    options: CodingV5JumpOptions = {},
  ): { result: CodingV5JumpResult; rendered: string } {
    const { entries, graph, topology } = this.requireBuilt();
    const sources = readCodingV5Sources(this.rootDir, entries);
    const sourceLines = new Map<string, string[]>();
    for (const [relPath, source] of sources) sourceLines.set(relPath, source.split('\n'));
    const result = jumpCodingV5ToDefinition(entries, query, topology, graph, sourceLines, options);
    return { result, rendered: renderCodingV5JumpResult(result) };
  }

  /** Tom tat cua mot thu muc (null khi chua build / khong co). */
  summaryOf(dirPath: string): CodingV5DirectorySummary | null {
    if (!this.summaryTree) return null;
    return this.summaryTree.byPath.get(dirPath) ?? null;
  }

  /** Skeleton phan cap vua ngan sach token. */
  skeleton(options: { budgetTokens?: number; maxDepth?: number; seedDirectory?: string } = {}): CodingV5Skeleton {
    if (!this.summaryTree) {
      throw new Error('Repo map v5 chưa được build — gọi repomap_v5_build trước.');
    }
    return renderCodingV5Skeleton(this.summaryTree, {
      budgetTokens: options.budgetTokens ?? CODING_V5_DEFAULT_SUMMARY_BUDGET_TOKENS,
      maxDepth: options.maxDepth,
      seedDirectory: options.seedDirectory,
    });
  }

  /** Tom tat topology thanh text ngan (dung trong tool status). */
  topologySummary(): string {
    if (!this.topology) return '(repo map v5 chưa được build)';
    return renderCodingV5TopologySummary(this.topology);
  }
}
