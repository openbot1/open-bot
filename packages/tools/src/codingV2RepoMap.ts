/**
 * Repo map v2 — scanner + cache đĩa (v1.08, Đội T2).
 *
 * Lớp quét file cho `packages/core/src/codingV2/repoMapGraph.ts`:
 * dùng tree-sitter đã có sẵn (`./code/ast`) để trích symbol, dùng
 * helper của repo map v1 (`./repoMap`: discoverRepoFiles,
 * extractImportSpecifiers, resolveRelativeImport, countIdents) để
 * quét file/import/đếm ident — KHÔNG viết lại parser, chỉ nối các
 * mảnh đã có thành pipeline tăng dần:
 *
 *   load cache đĩa -> discover file -> phân loại (unchanged/changed/
 *   added/removed) -> chỉ parse lại file đổi/mới -> gộp entry -> ghi
 *   cache -> dựng đồ thị symbol-level từ entry + ident scan.
 *
 * Cache mặc định nằm trong workspace: `.open-bot/coding-v2/
 * repo-map-v2.json` (ghi rõ đường dẫn trong kết quả; caller có thể
 * truyền cachePath khác). File cache là JSON versioned — cache cũ/
 * hỏng/khác workspace thì build lại từ đầu, không crash.
 *
 * Giới hạn trung thực (kế thừa từ v1): chỉ TS/TSX/JS/JSX/Python;
 * tối đa 2000 file, file tối đa 1 MB (phần thừa bị lược và báo rõ);
 * ident đếm bằng token trên toàn bộ text (kể cả string/comment)
 * nên có thể đếm thừa; import bare (`'react'`) bị bỏ qua.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildCodingV2Graph,
  classifyCodingV2Files,
  codingV2SymbolDetail,
  mergeCodingV2Entries,
  parseCodingV2Cache,
  queryCodingV2Graph,
  rankCodingV2Files,
  rankCodingV2Symbols,
  serializeCodingV2Cache,
  CODING_V2_CACHE_VERSION,
} from '@open-bot/core';
import type {
  CodingV2CacheFile,
  CodingV2FileEntry,
  CodingV2Graph,
  CodingV2QueryResult,
  CodingV2SymbolEntry,
} from '@open-bot/core';
import { detectAstLanguage, parseCodeSymbols } from './code/ast';
import type { AstLanguage, CodeSymbol } from './code/ast';
import {
  countIdents,
  discoverRepoFiles,
  extractImportSpecifiers,
  extractSymbolsRegexFallback,
  resolveRelativeImport,
} from './repoMap';

/** Đường dẫn cache mặc định trong workspace (repo-relative). */
export const CODING_V2_DEFAULT_CACHE_REL_PATH = '.open-bot/coding-v2/repo-map-v2.json';
/** Tối đa file quét mỗi lần build (cùng trần với repo map v1). */
export const CODING_V2_MAX_FILES = 2000;

export interface CodingV2MapBuildOptions {
  /** Build lại toàn bộ, bỏ cache cũ. */
  force?: boolean;
  /** Trần file quét (mặc định 2000). */
  maxFiles?: number;
  /** Đường dẫn cache khác (tuyệt đối, hoặc tương đối so với root). */
  cachePath?: string;
}

export interface CodingV2MapBuildResult {
  rootDir: string;
  cachePath: string;
  files: number;
  symbols: number;
  edges: number;
  scanned: number;
  reparsed: number;
  reused: number;
  removed: number;
  skippedOversize: number;
  skippedOverCap: number;
  /** File parse lỗi engine/grammar, đã dùng regex fallback. */
  fallbackFiles: string[];
  /** File không đọc/parse được cả fallback (bỏ khỏi map). */
  parseErrors: string[];
  cacheWritten: boolean;
  cacheFresh: boolean;
  durationMs: number;
  warnings: string[];
}

/** Resolve cachePath (tuyệt đối hoặc tương đối so với root), chặn escape. */
export function resolveCodingV2CachePath(rootDir: string, cachePath?: string): string {
  if (!cachePath) return path.join(rootDir, CODING_V2_DEFAULT_CACHE_REL_PATH);
  const resolved = path.isAbsolute(cachePath) ? path.resolve(cachePath) : path.resolve(rootDir, cachePath);
  return resolved;
}

function toCodingV2Symbol(symbol: CodeSymbol): CodingV2SymbolEntry {
  return {
    kind: symbol.kind,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    line: symbol.line,
    column: symbol.column,
    endLine: symbol.endLine,
  };
}

/** Parse một file thành entry (tree-sitter, fallback regex khi lỗi engine). */
export async function parseCodingV2File(
  rootDir: string,
  relPath: string,
  knownAbsFiles: Set<string>,
): Promise<{ entry: CodingV2FileEntry; usedFallback: boolean }> {
  const absPath = path.join(rootDir, relPath);
  const stat = fs.statSync(absPath);
  const source = fs.readFileSync(absPath, 'utf8');
  const language: AstLanguage | null = detectAstLanguage(relPath);
  if (language === null) {
    return {
      entry: {
        relPath,
        language: 'unknown',
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        symbols: [],
        imports: [],
        hasError: false,
      },
      usedFallback: false,
    };
  }
  let symbols: CodingV2SymbolEntry[] = [];
  let hasError = false;
  let usedFallback = false;
  try {
    const parsed = await parseCodeSymbols(source, language);
    symbols = parsed.symbols.map(toCodingV2Symbol);
    hasError = parsed.hasError;
  } catch {
    // Fallback regex không có column/endLine: mặc định cột 1, endLine = line.
    symbols = extractSymbolsRegexFallback(source, language).map((s) => ({
      kind: s.kind,
      name: s.name,
      qualifiedName: s.qualifiedName,
      line: s.line,
      column: 1,
      endLine: s.line,
    }));
    usedFallback = true;
  }
  const imports: string[] = [];
  for (const spec of extractImportSpecifiers(source, language)) {
    const resolved = resolveRelativeImport(spec, absPath, knownAbsFiles);
    if (resolved === null) continue;
    const rel = path.relative(rootDir, resolved).split(path.sep).join('/');
    if (rel !== relPath && !imports.includes(rel)) imports.push(rel);
  }
  return {
    entry: {
      relPath,
      language,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      symbols,
      imports: imports.sort(),
      hasError,
    },
    usedFallback,
  };
}

/** Quét số lần nhắc ident cho mọi file entry (đọc text, regex tokenize). */
export function scanCodingV2Idents(
  rootDir: string,
  entries: Map<string, CodingV2FileEntry>,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const relPath of entries.keys()) {
    try {
      const source = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
      out.set(relPath, countIdents(source));
    } catch {
      out.set(relPath, new Map());
    }
  }
  return out;
}

/**
 * Store repo map v2 cho một workspace: giữ entries + đồ thị trong bộ
 * nhớ, cache entries trên đĩa, build tăng dần.
 */
export class CodingV2RepoMapStore {
  readonly rootDir: string;
  readonly cachePath: string;
  private entries = new Map<string, CodingV2FileEntry>();
  private graph: CodingV2Graph | null = null;
  private graphVersion = 0;
  private entriesVersion = 0;
  private lastBuild: CodingV2MapBuildResult | null = null;

  constructor(rootDir: string, options: { cachePath?: string } = {}) {
    const resolved = path.resolve(rootDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Thư mục workspace không tồn tại: ${rootDir}.`);
    }
    this.rootDir = resolved;
    this.cachePath = resolveCodingV2CachePath(resolved, options.cachePath);
  }

  get entryCount(): number {
    return this.entries.size;
  }

  get isBuilt(): boolean {
    return this.graph !== null;
  }

  get lastBuildResult(): CodingV2MapBuildResult | null {
    return this.lastBuild;
  }

  /** Đồ thị hiện tại (null khi chưa build). */
  getGraph(): CodingV2Graph | null {
    if (this.graph === null || this.graphVersion !== this.entriesVersion) {
      if (this.entries.size === 0 && this.graph === null) return null;
      this.rebuildGraph();
    }
    return this.graph;
  }

  private rebuildGraph(): void {
    const idents = scanCodingV2Idents(this.rootDir, this.entries);
    this.graph = buildCodingV2Graph({ files: [...this.entries.values()], idents });
    this.graphVersion = this.entriesVersion;
  }

  private loadCache(cachePath: string): { entries: Map<string, CodingV2FileEntry>; warning?: string } {
    const empty = new Map<string, CodingV2FileEntry>();
    let text: string;
    try {
      text = fs.readFileSync(cachePath, 'utf8');
    } catch {
      return { entries: empty };
    }
    const parsed = parseCodingV2Cache(text, this.rootDir);
    if ('error' in parsed) {
      return { entries: empty, warning: `Cache repo map v2 không dùng được (${parsed.error}) — build lại từ đầu.` };
    }
    return { entries: new Map(Object.entries(parsed.cache.files)) };
  }

  private saveCache(cachePath: string): boolean {
    const cache: CodingV2CacheFile = {
      version: CODING_V2_CACHE_VERSION,
      rootDir: this.rootDir,
      updatedAt: new Date().toISOString(),
      files: Object.fromEntries(this.entries),
    };
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, serializeCodingV2Cache(cache), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build/refresh map: chỉ parse lại file đổi/mới, tái dùng entry
   * cache cho file không đổi, bỏ file đã xoá, rồi dựng lại đồ thị.
   */
  async build(options: CodingV2MapBuildOptions = {}): Promise<CodingV2MapBuildResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];
    const maxFiles = Math.min(Math.max(1, Math.floor(options.maxFiles ?? CODING_V2_MAX_FILES)), 5000);
    const cachePath = options.cachePath
      ? resolveCodingV2CachePath(this.rootDir, options.cachePath)
      : this.cachePath;

    const discovered = discoverRepoFiles(this.rootDir, maxFiles);
    const fingerprints: Array<{ relPath: string; mtimeMs: number; size: number }> = [];
    for (const relPath of discovered.relPaths) {
      try {
        const stat = fs.statSync(path.join(this.rootDir, relPath));
        fingerprints.push({ relPath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // File biến mất giữa chừng: bỏ qua.
      }
    }

    let oldEntries = new Map<string, CodingV2FileEntry>();
    if (!options.force) {
      const loaded = this.loadCache(cachePath);
      oldEntries = loaded.entries;
      if (loaded.warning) warnings.push(loaded.warning);
    }
    // Khi force, cache cũ vẫn dùng làm fallback nếu parse lỗi? Không —
    // force nghĩa là build lại toàn bộ từ đĩa.
    const plan = classifyCodingV2Files(oldEntries, fingerprints);
    const knownAbsFiles = new Set(fingerprints.map((f) => path.join(this.rootDir, f.relPath)));
    const fresh: CodingV2FileEntry[] = [];
    const fallbackFiles: string[] = [];
    const parseErrors: string[] = [];
    for (const relPath of [...plan.changed, ...plan.added]) {
      try {
        const { entry, usedFallback } = await parseCodingV2File(this.rootDir, relPath, knownAbsFiles);
        fresh.push(entry);
        if (usedFallback) fallbackFiles.push(relPath);
      } catch (e) {
        parseErrors.push(`${relPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.entries = mergeCodingV2Entries(oldEntries, fresh, plan.removed);
    this.entriesVersion += 1;
    this.graph = null;
    this.rebuildGraph();
    const cacheWritten = this.saveCache(cachePath);
    if (!cacheWritten) warnings.push(`Không ghi được cache ${cachePath} — lần sau sẽ build lại từ đầu.`);
    if (discovered.skippedOversize > 0) {
      warnings.push(`${discovered.skippedOversize} file > 1 MB bị bỏ khỏi map.`);
    }
    if (discovered.skippedOverCap > 0) {
      warnings.push(`${discovered.skippedOverCap} file vượt trần ${maxFiles} file bị bỏ khỏi map.`);
    }
    const graph = this.getGraph();
    const result: CodingV2MapBuildResult = {
      rootDir: this.rootDir,
      cachePath,
      files: this.entries.size,
      symbols: graph?.stats.symbols ?? 0,
      edges: graph?.stats.edges ?? 0,
      scanned: discovered.scanned,
      reparsed: plan.changed.length + plan.added.length,
      reused: plan.unchanged.length,
      removed: plan.removed.length,
      skippedOversize: discovered.skippedOversize,
      skippedOverCap: discovered.skippedOverCap,
      fallbackFiles,
      parseErrors,
      cacheWritten,
      cacheFresh: plan.changed.length === 0 && plan.added.length === 0 && plan.removed.length === 0,
      durationMs: Date.now() - startedAt,
      warnings,
    };
    this.lastBuild = result;
    return result;
  }

  /** Build nếu chưa có đồ thị trong bộ nhớ (tool query/rank gọi trước). */
  async ensureBuilt(): Promise<CodingV2MapBuildResult> {
    if (this.graph !== null) {
      return (
        this.lastBuild ?? {
          rootDir: this.rootDir,
          cachePath: this.cachePath,
          files: this.entries.size,
          symbols: this.graph.stats.symbols,
          edges: this.graph.stats.edges,
          scanned: 0,
          reparsed: 0,
          reused: this.entries.size,
          removed: 0,
          skippedOversize: 0,
          skippedOverCap: 0,
          fallbackFiles: [],
          parseErrors: [],
          cacheWritten: false,
          cacheFresh: true,
          durationMs: 0,
          warnings: [],
        }
      );
    }
    return this.build();
  }

  /** "File nào liên quan nhất tới X" — cần build trước (ensureBuilt). */
  query(query: string, options: { limit?: number; symbolLimit?: number } = {}): CodingV2QueryResult {
    const graph = this.getGraph();
    if (!graph) {
      throw new Error('Repo map v2 chưa được build — gọi coding_v2_repo_map_build trước.');
    }
    return queryCodingV2Graph(graph, [...this.entries.values()], query, options);
  }

  /** Chi tiết một symbol: định nghĩa ở đâu, file nào nhắc tới. */
  symbolDetail(name: string): ReturnType<typeof codingV2SymbolDetail> {
    const graph = this.getGraph();
    if (!graph) {
      throw new Error('Repo map v2 chưa được build — gọi coding_v2_repo_map_build trước.');
    }
    return codingV2SymbolDetail(graph, [...this.entries.values()], name);
  }

  /** Top file theo PageRank toàn cục. */
  rankFiles(limit = 20): ReturnType<typeof rankCodingV2Files> {
    const graph = this.getGraph();
    if (!graph) throw new Error('Repo map v2 chưa được build — gọi coding_v2_repo_map_build trước.');
    return rankCodingV2Files(graph, limit);
  }

  /** Top symbol theo PageRank toàn cục. */
  rankSymbols(limit = 20): ReturnType<typeof rankCodingV2Symbols> {
    const graph = this.getGraph();
    if (!graph) throw new Error('Repo map v2 chưa được build — gọi coding_v2_repo_map_build trước.');
    return rankCodingV2Symbols(graph, limit);
  }

  /** Thống kê nhanh cho tool status (không build lại). */
  stats(): {
    built: boolean;
    rootDir: string;
    cachePath: string;
    files: number;
    symbols: number;
    edges: number;
  } {
    const graph = this.graph;
    return {
      built: graph !== null,
      rootDir: this.rootDir,
      cachePath: this.cachePath,
      files: this.entries.size,
      symbols: graph?.stats.symbols ?? 0,
      edges: graph?.stats.edges ?? 0,
    };
  }
}
