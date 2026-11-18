/**
 * Coding agent v10 — repo map v3 mở rộng: hierarchical summaries.
 *
 * Trên nền PageRank v3 của v8 (graph import/call + PageRank có trọng
 * số, incremental theo content hash, query có reasons): v10 thêm
 * lớp tóm tắt phân cấp MODULE → FILE → SYMBOL để agent đọc repo
 * bằng ít token hơn, và query trực tiếp theo symbol.
 *
 * - Tóm tắt file: symbol export chính + số symbol + import, kèm
 *   điểm PageRank của file/symbol để sắp xếp theo độ quan trọng.
 * - Tóm tắt module (thư mục): gộp các file trong cùng thư mục, điểm
 *   là tổng điểm file, tóm tắt một dòng liệt kê file quan trọng nhất.
 * - Nén token: render theo ngân sách — giữ module/file/symbol có
 *   điểm cao trước, bỏ symbol thấp điểm trước, cắt signature dài;
 *   báo rõ đã nén bao nhiêu (compressed + kept/total).
 * - Cập nhật tăng dần: dùng `V8RepoMap.updateFiles()` (chỉ parse lại
 *   file đổi hash); summary cache theo contentHash nên file không
 *   đổi được tái dùng nguyên tóm tắt, chỉ build lại file đổi.
 * - Query theo symbol: khớp exact → prefix → substring, xếp theo
 *   PageRank, trả reasons (khớp tên / export / PageRank cao).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { V8RepoMap, buildV8Graph, queryV8Repo, scanV8RepoFiles, v8FileNodeId, v8SymbolNodeId } from '../codingV8/repoMap';
import type { V8Graph, V8ParsedFile } from '../codingV8/types';
import { CodingV10Error } from './types';
import type {
  V10FileSummary,
  V10ModuleSummary,
  V10RepoMapData,
  V10RepoMapRender,
  V10RepoMapUpdateResult,
  V10SymbolQueryHit,
  V10SymbolQueryResult,
  V10SymbolSummary,
} from './types';

/** Số ký tự ước lượng cho 1 token (chars/4, như v9). */
export const V10_TOKEN_CHARS_PER_TOKEN = 4;
/** Độ dài signature tối đa giữ trong tóm tắt symbol. */
export const V10_MAX_SIGNATURE_CHARS = 120;
/** Số symbol tối đa giữ trong tóm tắt một file (trước khi nén). */
export const V10_MAX_SYMBOLS_PER_FILE = 40;
/** Số file tối đa liệt kê trong tóm tắt một module. */
export const V10_MAX_FILES_PER_MODULE = 20;
/** Ngân sách token mặc định khi render repo map. */
export const V10_REPOMAP_DEFAULT_BUDGET = 4000;

/** Version của định dạng cache summary JSON trên đĩa. */
export const V10_SUMMARY_CACHE_VERSION = 1;

/** File cache summary trên đĩa (versioned). */
export interface V10SummaryCacheFile {
  version: number;
  rootDir: string;
  files: Record<string, V10FileSummary>;
}

/** Ước lượng token của một đoạn text (chars/4, làm tròn lên). */
export function v10EstimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / V10_TOKEN_CHARS_PER_TOKEN));
}

/** Thư mục chứa một file repo-relative ('.' = root). */
export function v10ModuleDir(relPath: string): string {
  const dir = path.posix.dirname(relPath.replace(/\\/g, '/'));
  return dir === '' ? '.' : dir;
}

/** Build tóm tắt một symbol từ parsed file + điểm PageRank. */
export function v10SummarizeSymbol(
  relPath: string,
  symbol: V8ParsedFile['symbols'][number],
  score: number,
): V10SymbolSummary {
  const signature =
    symbol.signature.length > V10_MAX_SIGNATURE_CHARS
      ? `${symbol.signature.slice(0, V10_MAX_SIGNATURE_CHARS)}…`
      : symbol.signature;
  return {
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    signature,
    line: symbol.line,
    exported: symbol.exported,
    score,
  };
}

/** Build tóm tắt một file từ parsed file + điểm PageRank. */
export function v10SummarizeFile(parsed: V8ParsedFile, fileScore: number, symbolScores: Map<string, number>): V10FileSummary {
  const symbols = [...parsed.symbols]
    .sort((a, b) => (symbolScores.get(b.qualifiedName) ?? 0) - (symbolScores.get(a.qualifiedName) ?? 0))
    .slice(0, V10_MAX_SYMBOLS_PER_FILE)
    .map((s) => v10SummarizeSymbol(parsed.relPath, s, symbolScores.get(s.qualifiedName) ?? 0));
  const exported = symbols.filter((s) => s.exported).map((s) => s.qualifiedName);
  const shown = exported.slice(0, 5);
  const summary =
    exported.length > 0
      ? `${parsed.relPath}: exports ${shown.join(', ')}${exported.length > shown.length ? ` +${exported.length - shown.length} more` : ''} (${parsed.symbols.length} symbols)`
      : `${parsed.relPath}: ${parsed.symbols.length} symbols, no exports`;
  const imports = parsed.imports.map((i) => i.specifier);
  const tokenEstimate = v10EstimateTokens(
    `${summary}\n${symbols.map((s) => `  ${s.kind} ${s.signature}`).join('\n')}\nimports: ${imports.join(', ')}`,
  );
  return {
    path: parsed.relPath,
    language: parsed.language,
    summary,
    symbols,
    imports,
    score: fileScore,
    tokenEstimate,
    contentHash: parsed.contentHash,
  };
}

/** Gộp các file summary thành tóm tắt module (thư mục). */
export function v10SummarizeModule(dir: string, files: V10FileSummary[]): V10ModuleSummary {
  const sorted = [...files].sort((a, b) => b.score - a.score);
  const totalSymbols = files.reduce((sum, f) => sum + f.symbols.length, 0);
  const score = files.reduce((sum, f) => sum + f.score, 0);
  const topFiles = sorted.slice(0, 5).map((f) => path.posix.basename(f.path));
  const summary =
    files.length === 0
      ? `${dir}: (empty)`
      : `${dir}: ${files.length} files, ${totalSymbols} symbols — top: ${topFiles.join(', ')}`;
  return {
    dir,
    summary,
    files: sorted.slice(0, V10_MAX_FILES_PER_MODULE),
    totalSymbols,
    score,
    tokenEstimate: files.reduce((sum, f) => sum + f.tokenEstimate, 0),
  };
}

/** Điểm PageRank của node file/symbol trong graph (0 khi chưa có). */
export function v10GraphScores(graph: V8Graph | null): { fileScores: Map<string, number>; symbolScores: Map<string, Map<string, number>> } {
  const fileScores = new Map<string, number>();
  const symbolScores = new Map<string, Map<string, number>>();
  if (!graph) return { fileScores, symbolScores };
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file') {
      fileScores.set(node.file, node.score);
    } else if (node.kind === 'symbol' && node.symbol) {
      let perFile = symbolScores.get(node.file);
      if (!perFile) {
        perFile = new Map<string, number>();
        symbolScores.set(node.file, perFile);
      }
      perFile.set(node.symbol, node.score);
    }
  }
  return { fileScores, symbolScores };
}

export interface V10RepoMapOptions {
  /** Số file tối đa quét (mặc định không giới hạn). */
  maxFiles?: number;
}

/**
 * Repo map v10: bọc V8RepoMap (PageRank v3) + lớp tóm tắt phân cấp.
 * Giữ cache summary theo contentHash để cập nhật tăng dần rẻ.
 */
export class V10RepoMap {
  readonly rootDir: string;
  private readonly v8map: V8RepoMap;
  private summaryCache = new Map<string, V10FileSummary>();
  private repoMap: V10RepoMapData | null = null;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.v8map = new V8RepoMap(this.rootDir);
  }

  /** Repo map hiện tại (null khi chưa build). */
  current(): V10RepoMapData | null {
    return this.repoMap;
  }

  /** Số file đã parse (từ v8 map). */
  get fileCount(): number {
    return this.v8map.fileCount;
  }

  /** Quét thư mục + build toàn bộ map (lần đầu). */
  scanAndBuild(options: V10RepoMapOptions = {}): V10RepoMapData {
    const files = scanV8RepoFiles(this.rootDir, options.maxFiles ? { maxFiles: options.maxFiles } : {});
    return this.updateFiles(files);
  }

  /**
   * Cập nhật tăng dần: parse lại chỉ file đổi hash (v8), build lại
   * summary chỉ cho file đó, tái dùng summary cũ cho file không đổi.
   */
  updateFiles(relPaths: readonly string[]): V10RepoMapData {
    const incremental = this.v8map.updateFiles(relPaths);
    const graph = this.v8map.currentGraph();
    const { fileScores, symbolScores } = v10GraphScores(graph);
    const parsedFiles = this.v8map.parsedFiles();
    const reparsedSet = new Set(incremental.reparsed);
    let summariesRebuilt = 0;
    let summariesReused = 0;
    const fileSummaries: V10FileSummary[] = [];
    for (const parsed of parsedFiles) {
      const cached = this.summaryCache.get(parsed.relPath);
      if (cached && cached.contentHash === parsed.contentHash && !reparsedSet.has(parsed.relPath)) {
        // Nội dung không đổi: tái dùng summary, nhưng cập nhật điểm
        // PageRank mới (điểm có thể đổi khi graph đổi).
        const reused: V10FileSummary = {
          ...cached,
          score: fileScores.get(parsed.relPath) ?? cached.score,
        };
        this.summaryCache.set(parsed.relPath, reused);
        fileSummaries.push(reused);
        summariesReused += 1;
        continue;
      }
      const summary = v10SummarizeFile(
        parsed,
        fileScores.get(parsed.relPath) ?? 0,
        symbolScores.get(parsed.relPath) ?? new Map(),
      );
      this.summaryCache.set(parsed.relPath, summary);
      fileSummaries.push(summary);
      summariesRebuilt += 1;
    }
    // Xóa cache của file đã bị xóa khỏi repo.
    for (const removed of incremental.removed) this.summaryCache.delete(removed);
    const byModule = new Map<string, V10FileSummary[]>();
    for (const file of fileSummaries) {
      const dir = v10ModuleDir(file.path);
      const list = byModule.get(dir) ?? [];
      list.push(file);
      byModule.set(dir, list);
    }
    const modules = [...byModule.entries()]
      .map(([dir, files]) => v10SummarizeModule(dir, files))
      .sort((a, b) => b.score - a.score);
    const totalTokenEstimate = modules.reduce((sum, m) => sum + m.tokenEstimate, 0);
    this.repoMap = {
      rootDir: this.rootDir,
      modules,
      fileCount: fileSummaries.length,
      symbolCount: fileSummaries.reduce((sum, f) => sum + f.symbols.length, 0),
      moduleCount: modules.length,
      totalTokenEstimate,
      builtAt: new Date().toISOString(),
    };
    const lastUpdate: V10RepoMapUpdateResult = {
      reparsed: incremental.reparsed,
      reused: incremental.reused,
      removed: incremental.removed,
      summariesRebuilt,
      summariesReused,
      subgraphNodesRecomputed: incremental.subgraphNodesRecomputed,
    };
    this.lastUpdateResult = lastUpdate;
    return this.repoMap;
  }

  private lastUpdateResult: V10RepoMapUpdateResult | null = null;

  /** Kết quả cập nhật tăng dần gần nhất (null khi chưa update). */
  lastUpdate(): V10RepoMapUpdateResult | null {
    return this.lastUpdateResult;
  }

  /**
   * Render repo map theo ngân sách token: giữ module/file/symbol có
   * điểm PageRank cao trước; bỏ symbol thấp điểm trước, rồi bỏ file
   * thấp điểm; báo rõ đã nén bao nhiêu.
   */
  render(budget = V10_REPOMAP_DEFAULT_BUDGET): V10RepoMapRender {
    if (!this.repoMap) {
      throw new CodingV10Error('repomap-not-built', 'V10RepoMap: chưa build — gọi scanAndBuild() trước.');
    }
    const totalSymbols = this.repoMap.symbolCount;
    const totalFiles = this.repoMap.fileCount;
    const lines: string[] = [];
    let keptSymbols = 0;
    let keptFiles = 0;
    let usedTokens = 0;
    const addLine = (line: string): boolean => {
      const cost = v10EstimateTokens(`${line}\n`);
      if (usedTokens + cost > budget && lines.length > 0) return false;
      lines.push(line);
      usedTokens += cost;
      return true;
    };
    for (const mod of this.repoMap.modules) {
      if (!addLine(`## ${mod.summary}`)) break;
      for (const file of mod.files) {
        const fileLine = `- ${file.summary}`;
        if (!addLine(fileLine)) break;
        keptFiles += 1;
        for (const sym of file.symbols) {
          const symLine = `    ${sym.kind} ${sym.signature}  (${sym.qualifiedName}:${sym.line})`;
          if (!addLine(symLine)) break;
          keptSymbols += 1;
        }
      }
    }
    const text = lines.join('\n');
    return {
      text,
      tokenEstimate: v10EstimateTokens(text),
      budget,
      compressed: keptSymbols < totalSymbols || keptFiles < totalFiles,
      symbolsKept: keptSymbols,
      symbolsTotal: totalSymbols,
      filesKept: keptFiles,
      filesTotal: totalFiles,
    };
  }

  /**
   * Query theo symbol: khớp exact → prefix → substring, xếp theo
   * PageRank; mỗi hit có reasons để agent giải thích lựa chọn.
   */
  querySymbol(query: string, limit = 10): V10SymbolQueryResult {
    if (!this.repoMap) {
      throw new CodingV10Error('repomap-not-built', 'V10RepoMap: chưa build — gọi scanAndBuild() trước.');
    }
    const q = query.trim();
    if (q === '') {
      throw new CodingV10Error('symbol-not-found', 'Query symbol rỗng.');
    }
    const lower = q.toLowerCase();
    const scored: Array<{ hit: V10SymbolQueryHit; rank: number }> = [];
    let searched = 0;
    for (const mod of this.repoMap.modules) {
      for (const file of mod.files) {
        for (const sym of file.symbols) {
          searched += 1;
          const name = sym.qualifiedName;
          const short = name.split('.').pop() ?? name;
          const reasons: string[] = [];
          let rank = -1;
          if (name === q || short === q) {
            rank = 0;
            reasons.push('exact match');
          } else if (name.toLowerCase().startsWith(lower) || short.toLowerCase().startsWith(lower)) {
            rank = 1;
            reasons.push('prefix match');
          } else if (name.toLowerCase().includes(lower) || short.toLowerCase().includes(lower)) {
            rank = 2;
            reasons.push('substring match');
          } else {
            continue;
          }
          if (sym.exported) reasons.push('exported');
          if (sym.score > 0) reasons.push(`pagerank ${sym.score.toFixed(4)}`);
          scored.push({
            hit: {
              qualifiedName: name,
              kind: sym.kind,
              file: file.path,
              line: sym.line,
              signature: sym.signature,
              score: sym.score,
              reasons,
            },
            rank,
          });
        }
      }
    }
    scored.sort((a, b) => a.rank - b.rank || b.hit.score - a.hit.score || a.hit.qualifiedName.localeCompare(b.hit.qualifiedName));
    return { query: q, hits: scored.slice(0, Math.max(1, limit)).map((s) => s.hit), symbolsSearched: searched };
  }

  /**
   * Query repo theo từ khóa tự do (dùng query PageRank của v8) rồi
   * gắn thêm tóm tắt file của các hit — để agent có cả lý do chọn
   * file (v8) lẫn nội dung tóm tắt (v10).
   */
  queryText(query: string, limit = 10): Array<{ path: string; score: number; reasons: string[]; summary: string }> {
    const graph = this.v8map.currentGraph();
    if (!graph || !this.repoMap) {
      throw new CodingV10Error('repomap-not-built', 'V10RepoMap: chưa build — gọi scanAndBuild() trước.');
    }
    const result = queryV8Repo(graph, query, { limit });
    const byPath = new Map<string, V10FileSummary>();
    for (const mod of this.repoMap.modules) {
      for (const file of mod.files) byPath.set(file.path, file);
    }
    return result.files.map((hit) => ({
      path: hit.file,
      score: hit.score,
      reasons: hit.reasons,
      summary: byPath.get(hit.file)?.summary ?? '',
    }));
  }

  /** Lưu cache parse v8 xuống đĩa (để lần sau nạp nhanh). */
  saveCache(cachePath: string): void {
    this.v8map.saveCache(cachePath);
  }

  /** Nạp cache parse v8 từ đĩa (trả số file nạp được). */
  loadCache(cachePath: string): number {
    return this.v8map.loadCache(cachePath);
  }

  /**
   * Lưu cache tóm tắt file (V10FileSummary, key theo contentHash)
   * xuống đĩa — lần sau `loadSummaries` + `updateFiles` sẽ tái dùng
   * tóm tắt của file không đổi mà không cần build lại.
   */
  saveSummaries(cachePath: string): void {
    const data: V10SummaryCacheFile = {
      version: V10_SUMMARY_CACHE_VERSION,
      rootDir: this.rootDir,
      files: Object.fromEntries(this.summaryCache),
    };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  /**
   * Nạp cache tóm tắt từ đĩa (chỉ nhận đúng version + đúng rootDir).
   * Trả số file summary nạp được; summary sai hash sẽ bị build lại
   * ở lần `updateFiles` tiếp theo.
   */
  loadSummaries(cachePath: string): number {
    let data: V10SummaryCacheFile;
    try {
      data = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as V10SummaryCacheFile;
    } catch {
      return 0;
    }
    if (data.version !== V10_SUMMARY_CACHE_VERSION || data.rootDir !== this.rootDir || !data.files) return 0;
    let loaded = 0;
    for (const [relPath, summary] of Object.entries(data.files)) {
      if (summary && summary.path === relPath && typeof summary.contentHash === 'string') {
        this.summaryCache.set(relPath, summary);
        loaded += 1;
      }
    }
    return loaded;
  }
}

/** Build graph v8 từ danh sách parsed file (tiện cho test/tools). */
export function v10BuildGraphFromParsed(files: readonly V8ParsedFile[]): V8Graph {
  return buildV8Graph({ files: [...files] });
}

/** Id node file/symbol (re-export tiện dụng từ v8). */
export { v8FileNodeId, v8SymbolNodeId };
