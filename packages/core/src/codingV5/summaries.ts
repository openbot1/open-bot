/**
 * Repo map v5 — hierarchical summaries (v1.13, Doi T3).
 *
 * Y tuong hoc tu OpenHands Repository Map (tom tat phan cap theo thu
 * muc de giu skeleton codebase lon trong context han che) — chi hoc y
 * tuong, tu thiet ke va viet lai hoan toan tu dau.
 *
 * Mo rong repo map v3 (`codingV3` module graph gom file theo thu muc
 * cap 1/2 + budget map theo PageRank) va v4 (budget map theo PageRank
 * v2): v5 tom tat O MOI CAP thu muc, khong chi cap 1/2:
 *
 *   - moi thu muc co mot ban tom tat: so file (truc tiep + de quy),
 *     so symbol theo kind, symbol chinh (top theo diem PageRank
 *     symbol cua v2), export cong khai, phu thuoc ra ngoai (file
 *     ngoai thu muc ma file trong thu muc import/goi) va phu thuoc
 *     vao trong (file ngoai import/goi vao), chu trinh import noi bo.
 *   - tom tat cap con duoc tong hop len cap cha (rollup): cha giu
 *     tong so + top symbol + top phu thuoc cua con, khong giu toan
 *     bo chi tiet — skeleton ca repo vua trong mot context nho.
 *   - render skeleton theo ngan sach token: duyet cay theo thu tu
 *     diem giam dan, cat nhanh thap diem truoc, luon giu goc + duong
 *     dan toi file seed (khi co truy van).
 *
 * Module nay thuan tuy (khong fs): dau vao la entries v2 + do thi
 * v2 + topology v5. Lop fs song o `packages/tools/src/codingV5RepoMap.ts`.
 *
 * Gioi han trung thuc:
 *   - "symbol chinh" xep theo diem PageRank symbol cua v2 (ten ngan
 *     co the dem thua, giong v2); thu muc khong co symbol thi tom
 *     tat chi liet ke file.
 *   - token chi la uoc luong (chars/4), giong v3/v4.
 *   - phu thuoc tinh theo import tinh + call site da resolve cua
 *     topology v5 (goi qua bien trung gian / goi dong khong thay).
 */

import type { CodingV2FileEntry, CodingV2Graph } from '../codingV2/repoMapGraph';
import type { CodingV5Topology } from './topology';
import { CODING_V5_CHARS_PER_TOKEN } from './topology';

/** Ngan sach token mac dinh cho skeleton phan cap. */
export const CODING_V5_DEFAULT_SUMMARY_BUDGET_TOKENS = 2000;
/** So symbol chinh toi da giu trong mot tom tat thu muc. */
export const CODING_V5_DEFAULT_TOP_SYMBOLS = 5;
/** So phu thuoc toi da giu trong mot tom tat thu muc. */
export const CODING_V5_DEFAULT_TOP_DEPS = 5;
/** Do sau toi da cua cay thu muc khi render (0 = khong gioi han). */
export const CODING_V5_DEFAULT_MAX_DEPTH = 0;

// ---------------------------------------------------------------------------
// Kieu du lieu
// ---------------------------------------------------------------------------

/** Dem symbol theo kind trong mot thu muc. */
export interface CodingV5SymbolKindCounts {
  function: number;
  class: number;
  method: number;
  interface: number;
  type: number;
  enum: number;
}

/** Mot symbol chinh trong tom tat thu muc. */
export interface CodingV5TopSymbol {
  qualifiedName: string;
  kind: string;
  file: string;
  line: number;
  score: number;
}

/** Mot phu thuoc cua thu muc (ra ngoai hoac vao trong). */
export interface CodingV5Dependency {
  /** Thu muc doi tac (duong dan repo-relative, '' = goc). */
  directory: string;
  /** So canh (import + call site resolve) toi thu muc do. */
  edges: number;
  /** Vi du mot file doi tac. */
  exampleFile: string;
}

/** Tom tat cua mot thu muc. */
export interface CodingV5DirectorySummary {
  /** Duong dan thu muc repo-relative ('' = goc repo). */
  path: string;
  /** Ten hien thi (ten thu muc cuoi, '(root)' cho goc). */
  name: string;
  /** Do sau (goc = 0). */
  depth: number;
  /** So file truc tiep trong thu muc. */
  filesDirect: number;
  /** So file trong ca cay con. */
  filesTotal: number;
  /** So symbol trong ca cay con. */
  symbolsTotal: number;
  /** Dem symbol theo kind (ca cay con). */
  symbolsByKind: CodingV5SymbolKindCounts;
  /** So export cong khai (ca cay con). */
  exportsTotal: number;
  /** Symbol chinh (top theo diem PageRank symbol v2). */
  topSymbols: CodingV5TopSymbol[];
  /** Thu muc ma cay nay phu thuoc vao (import/goi ra ngoai). */
  dependsOn: CodingV5Dependency[];
  /** Thu muc phu thuoc vao cay nay (import/goi tu ngoai vao). */
  dependedBy: CodingV5Dependency[];
  /** Chu trinh import nam tron trong cay nay. */
  internalCycles: number;
  /** File mo coi trong cay nay. */
  orphans: number;
  /** Diem tong hop cua thu muc (tong diem file v2, chuan hoa sau). */
  score: number;
  /** Duong dan thu muc con truc tiep (da sap xep). */
  children: string[];
}

/** Cay tom tat phan cap day du. */
export interface CodingV5SummaryTree {
  root: CodingV5DirectorySummary;
  /** Moi tom tat theo duong dan thu muc. */
  byPath: Map<string, CodingV5DirectorySummary>;
  stats: {
    directories: number;
    files: number;
    symbols: number;
    /** Thu muc la (khong co thu muc con). */
    leaves: number;
  };
}

/** Ket qua render skeleton vua ngan sach token. */
export interface CodingV5Skeleton {
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  includedDirectories: string[];
  excludedDirectories: string[];
  truncated: boolean;
  totalDirectories: number;
}

// ---------------------------------------------------------------------------
// Dung cay thu muc
// ---------------------------------------------------------------------------

function emptyKindCounts(): CodingV5SymbolKindCounts {
  return { function: 0, class: 0, method: 0, interface: 0, type: 0, enum: 0 };
}

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

function parentDir(dir: string): string | null {
  if (dir === '') return null;
  const idx = dir.lastIndexOf('/');
  return idx === -1 ? '' : dir.slice(0, idx);
}

function baseName(dir: string): string {
  if (dir === '') return '(root)';
  const idx = dir.lastIndexOf('/');
  return idx === -1 ? dir : dir.slice(idx + 1);
}

/** Moi thu muc to tien cua mot file (ke ca goc ''). */
export function codingV5AncestorDirs(relPath: string): string[] {
  const out: string[] = [''];
  const dir = dirOf(relPath);
  if (dir === '') return out;
  const parts = dir.split('/');
  let acc = '';
  for (const part of parts) {
    acc = acc === '' ? part : `${acc}/${part}`;
    out.push(acc);
  }
  return out;
}

interface DirAccumulator {
  path: string;
  filesDirect: Set<string>;
  filesTotal: Set<string>;
  symbolsByKind: CodingV5SymbolKindCounts;
  exportsTotal: number;
  topSymbols: CodingV5TopSymbol[];
  dependsOnCounts: Map<string, { edges: number; exampleFile: string }>;
  dependedByCounts: Map<string, { edges: number; exampleFile: string }>;
  internalCycles: number;
  orphans: number;
  score: number;
  children: Set<string>;
}

function topDeps(
  counts: Map<string, { edges: number; exampleFile: string }>,
  limit: number,
): CodingV5Dependency[] {
  return [...counts.entries()]
    .map(([directory, v]) => ({ directory, edges: v.edges, exampleFile: v.exampleFile }))
    .sort((a, b) => b.edges - a.edges || a.directory.localeCompare(b.directory))
    .slice(0, Math.max(0, limit));
}

function addDep(
  counts: Map<string, { edges: number; exampleFile: string }>,
  directory: string,
  exampleFile: string,
): void {
  const cur = counts.get(directory);
  if (cur) {
    cur.edges += 1;
  } else {
    counts.set(directory, { edges: 1, exampleFile });
  }
}

/**
 * Dung cay tom tat phan cap tu entries v2 + do thi v2 + topology v5.
 * Tom tat cap con tong hop len cap cha: so file/symbol/export, top
 * symbol (lay top theo diem, cat o moi cap), phu thuoc (cong don
 * theo thu muc doi tac, loai bo phu thuoc noi bo cap do).
 */
export function buildCodingV5SummaryTree(
  files: CodingV2FileEntry[],
  graph: CodingV2Graph | null,
  topology: CodingV5Topology,
  options: { topSymbols?: number; topDeps?: number } = {},
): CodingV5SummaryTree {
  const topSymbolsLimit = Math.max(0, options.topSymbols ?? CODING_V5_DEFAULT_TOP_SYMBOLS);
  const topDepsLimit = Math.max(0, options.topDeps ?? CODING_V5_DEFAULT_TOP_DEPS);
  const accs = new Map<string, DirAccumulator>();
  const ensure = (path: string): DirAccumulator => {
    let acc = accs.get(path);
    if (!acc) {
      acc = {
        path,
        filesDirect: new Set(),
        filesTotal: new Set(),
        symbolsByKind: emptyKindCounts(),
        exportsTotal: 0,
        topSymbols: [],
        dependsOnCounts: new Map(),
        dependedByCounts: new Map(),
        internalCycles: 0,
        orphans: 0,
        score: 0,
        children: new Set(),
      };
      accs.set(path, acc);
    }
    return acc;
  };
  ensure('');
  // Cay thu muc: moi file dang ky vao moi to tien cua no.
  for (const file of files) {
    const ancestors = codingV5AncestorDirs(file.relPath);
    const direct = dirOf(file.relPath);
    for (const dir of ancestors) {
      const acc = ensure(dir);
      acc.filesTotal.add(file.relPath);
      acc.score += graph?.fileScores.get(file.relPath) ?? 0;
      if (dir === direct) acc.filesDirect.add(file.relPath);
      for (const s of file.symbols) {
        acc.symbolsByKind[s.kind] = (acc.symbolsByKind[s.kind] ?? 0) + 1;
      }
      acc.exportsTotal += (topology.exportsByFile.get(file.relPath) ?? []).filter(
        (e) => e.kind !== 're-export',
      ).length;
    }
    // Top symbol: lay tu diem PageRank symbol cua v2 (khi co do thi).
    const scored = file.symbols.map((s) => {
      const nodeId = `s:${file.relPath}#${s.qualifiedName}`;
      return {
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        file: file.relPath,
        line: s.line,
        score: graph?.symbolScores.get(nodeId) ?? 0,
      };
    });
    scored.sort((a, b) => b.score - a.score || a.qualifiedName.localeCompare(b.qualifiedName));
    for (const dir of ancestors) {
      const acc = ensure(dir);
      for (const sym of scored.slice(0, topSymbolsLimit)) acc.topSymbols.push(sym);
    }
  }
  // Quan he cha/con giua cac thu muc.
  for (const dir of accs.keys()) {
    if (dir === '') continue;
    const parent = parentDir(dir);
    if (parent !== null) ensure(parent).children.add(dir);
  }
  // Phu thuoc: import tinh (file -> file) + call site da resolve.
  const depPairs = new Set<string>();
  const recordDep = (fromFile: string, toFile: string): void => {
    if (fromFile === toFile) return;
    const fromDir = dirOf(fromFile);
    const toDir = dirOf(toFile);
    if (fromDir === toDir) return;
    const key = `${fromFile}\n${toFile}`;
    if (depPairs.has(key)) return;
    depPairs.add(key);
    // Phu thuoc nay thuoc ve moi cap to tien chung? Khong — chi ghi
    // o cap thu muc truc tiep cua hai file, rollup len tren bang
    // cach cong don o buoc sau (tranh dem trung o cap cha).
    const fromAcc = accs.get(fromDir);
    const toAcc = accs.get(toDir);
    if (fromAcc) addDep(fromAcc.dependsOnCounts, toDir, toFile);
    if (toAcc) addDep(toAcc.dependedByCounts, fromDir, fromFile);
  };
  for (const [from, imports] of topology.importsByFile) {
    for (const imp of imports) {
      if (imp.resolved !== null) recordDep(from, imp.resolved);
    }
  }
  for (const site of topology.callSites) {
    if (site.resolvedFile !== null) recordDep(site.file, site.resolvedFile);
  }
  // Rollup phu thuoc len cap cha: phu thuoc cua con thanh phu thuoc
  // cua cha khi doi tac o ngoai cay cha (khong dem phu thuoc noi bo
  // cap cha, va khong dem trung cung cap file).
  const rollupOrder = [...accs.keys()].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const dir of rollupOrder) {
    if (dir === '') continue;
    const parent = parentDir(dir);
    if (parent === null) continue;
    const child = accs.get(dir)!;
    const parentAcc = accs.get(parent)!;
    for (const [depDir, v] of child.dependsOnCounts) {
      // Doi tac nam trong cay cha thi la phu thuoc noi bo — bo.
      if (depDir === parent || depDir.startsWith(`${parent}/`) || parent === '') {
        if (parent === '' && depDir !== '') {
          // Goc: moi phu thuoc deu la noi bo goc, khong ghi.
          continue;
        }
        if (depDir === parent || depDir.startsWith(`${parent}/`)) continue;
      }
      const cur = parentAcc.dependsOnCounts.get(depDir);
      if (cur) cur.edges += v.edges;
      else parentAcc.dependsOnCounts.set(depDir, { ...v });
    }
    for (const [depDir, v] of child.dependedByCounts) {
      if (depDir === parent || depDir.startsWith(`${parent}/`)) continue;
      const cur = parentAcc.dependedByCounts.get(depDir);
      if (cur) cur.edges += v.edges;
      else parentAcc.dependedByCounts.set(depDir, { ...v });
    }
  }
  // Chu trinh noi bo + orphan theo cay.
  for (const cycle of topology.cycles) {
    const dirs = new Set(cycle.files.map((f) => dirOf(f)));
    // Chu trinh thuoc ve thu muc chung sau nhat cua cac file trong no.
    let common = cycle.files[0] ? dirOf(cycle.files[0]!) : '';
    for (const f of cycle.files.slice(1)) {
      const d = dirOf(f);
      while (common !== '' && d !== common && !d.startsWith(`${common}/`)) {
        const p = parentDir(common);
        common = p ?? '';
      }
    }
    void dirs;
    const acc = accs.get(common);
    if (acc) acc.internalCycles += 1;
  }
  for (const orphan of topology.orphans) {
    for (const dir of codingV5AncestorDirs(orphan)) {
      const acc = accs.get(dir);
      if (acc) acc.orphans += 1;
    }
  }
  // Chot tom tat: cat top symbol / phu thuoc o moi cap, tinh diem.
  const byPath = new Map<string, CodingV5DirectorySummary>();
  let maxScore = 0;
  for (const acc of accs.values()) maxScore = Math.max(maxScore, acc.score);
  for (const acc of accs.values()) {
    const seen = new Set<string>();
    const topSymbols = acc.topSymbols
      .filter((s) => {
        const k = `${s.file}#${s.qualifiedName}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => b.score - a.score || a.qualifiedName.localeCompare(b.qualifiedName))
      .slice(0, topSymbolsLimit);
    byPath.set(acc.path, {
      path: acc.path,
      name: baseName(acc.path),
      depth: acc.path === '' ? 0 : acc.path.split('/').length,
      filesDirect: acc.filesDirect.size,
      filesTotal: acc.filesTotal.size,
      symbolsTotal: Object.values(acc.symbolsByKind).reduce((a, b) => a + b, 0),
      symbolsByKind: { ...acc.symbolsByKind },
      exportsTotal: acc.exportsTotal,
      topSymbols,
      dependsOn: topDeps(acc.dependsOnCounts, topDepsLimit),
      dependedBy: topDeps(acc.dependedByCounts, topDepsLimit),
      internalCycles: acc.internalCycles,
      orphans: acc.orphans,
      score: maxScore > 0 ? acc.score / maxScore : 0,
      children: [...acc.children].sort(),
    });
  }
  const root = byPath.get('')!;
  let leaves = 0;
  for (const s of byPath.values()) if (s.children.length === 0) leaves += 1;
  return {
    root,
    byPath,
    stats: {
      directories: byPath.size,
      files: files.length,
      symbols: files.reduce((acc, f) => acc + f.symbols.length, 0),
      leaves,
    },
  };
}

/** Tom tat cua mot thu muc (null khi thu muc khong co trong cay). */
export function codingV5SummaryOf(
  tree: CodingV5SummaryTree,
  dirPath: string,
): CodingV5DirectorySummary | null {
  return tree.byPath.get(dirPath) ?? null;
}

/** Duong dan tu goc toi mot thu muc (ke ca goc + chinh no). */
export function codingV5PathToDirectory(dirPath: string): string[] {
  if (dirPath === '') return [''];
  const parts = dirPath.split('/');
  const out: string[] = [''];
  let acc = '';
  for (const part of parts) {
    acc = acc === '' ? part : `${acc}/${part}`;
    out.push(acc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Uoc luong token theo heuristic chars/4. */
export function estimateCodingV5Tokens(text: string): number {
  return Math.ceil(text.length / CODING_V5_CHARS_PER_TOKEN);
}

function renderSummaryLine(summary: CodingV5DirectorySummary): string {
  const indent = '  '.repeat(summary.depth);
  const kinds = Object.entries(summary.symbolsByKind)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  const top = summary.topSymbols
    .map((s) => `${s.qualifiedName} (${s.kind}, ${s.file}:${s.line})`)
    .join(', ');
  const deps = summary.dependsOn.map((d) => `${d.directory || '(root)'} x${d.edges}`).join(', ');
  const parts = [
    `${indent}${summary.name}/ — ${summary.filesTotal} file(s), ${summary.symbolsTotal} symbol(s)` +
      (kinds ? ` [${kinds}]` : '') +
      `, ${summary.exportsTotal} export(s), score ${summary.score.toFixed(3)}`,
  ];
  if (top) parts.push(`${indent}  top: ${top}`);
  if (deps) parts.push(`${indent}  depends on: ${deps}`);
  if (summary.internalCycles > 0) parts.push(`${indent}  import cycles inside: ${summary.internalCycles}`);
  if (summary.orphans > 0) parts.push(`${indent}  orphans: ${summary.orphans}`);
  return parts.join('\n');
}

/**
 * Render mot thu muc (va cay con cua no) thanh text tom tat.
 */
export function renderCodingV5Directory(
  tree: CodingV5SummaryTree,
  dirPath: string,
): string {
  const summary = tree.byPath.get(dirPath);
  if (!summary) return '';
  const lines: string[] = [renderSummaryLine(summary)];
  const walk = (dir: string): void => {
    const s = tree.byPath.get(dir);
    if (!s) return;
    for (const child of s.children) {
      const cs = tree.byPath.get(child);
      if (cs) lines.push(renderSummaryLine(cs));
      walk(child);
    }
  };
  walk(dirPath);
  return lines.join('\n');
}

/**
 * Render skeleton ca repo vua ngan sach token: duyet theo thu tu
 * diem giam dan (thu muc quan trong truoc), cat nhanh thap diem
 * truoc; luon giu goc va duong dan toi thu muc seed (khi co).
 */
export function renderCodingV5Skeleton(
  tree: CodingV5SummaryTree,
  options: {
    budgetTokens?: number;
    maxDepth?: number;
    /** Thu muc seed: duong dan toi no luon duoc giu. */
    seedDirectory?: string;
  } = {},
): CodingV5Skeleton {
  const budgetTokens = Math.max(
    1,
    Math.floor(options.budgetTokens ?? CODING_V5_DEFAULT_SUMMARY_BUDGET_TOKENS),
  );
  const maxDepth = options.maxDepth ?? CODING_V5_DEFAULT_MAX_DEPTH;
  const keep = new Set<string>(['']);
  if (options.seedDirectory) {
    for (const d of codingV5PathToDirectory(options.seedDirectory)) keep.add(d);
  }
  // Thu tu duyet: BFS theo diem giam dan trong cung cap.
  const ordered: CodingV5DirectorySummary[] = [];
  const queue: string[] = [''];
  const seen = new Set<string>(['']);
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const summary = tree.byPath.get(dir);
    if (!summary) continue;
    ordered.push(summary);
    const children = summary.children
      .map((c) => tree.byPath.get(c))
      .filter((c): c is CodingV5DirectorySummary => c !== undefined)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    for (const child of children) {
      if (seen.has(child.path)) continue;
      seen.add(child.path);
      queue.push(child.path);
    }
  }
  const header = `# Repo skeleton v5 (hierarchical summaries, budget ${budgetTokens} tokens, ${tree.stats.directories} directories)`;
  const lines: string[] = [header];
  const included: string[] = [];
  const excluded: string[] = [];
  let usedChars = header.length + 1;
  for (const summary of ordered) {
    if (maxDepth > 0 && summary.depth > maxDepth && !keep.has(summary.path)) {
      excluded.push(summary.path);
      continue;
    }
    const line = renderSummaryLine(summary);
    const nextChars = usedChars + line.length + 1;
    const fits = Math.ceil(nextChars / CODING_V5_CHARS_PER_TOKEN) <= budgetTokens;
    if (!fits && included.length > 0 && !keep.has(summary.path)) {
      excluded.push(summary.path);
      continue;
    }
    lines.push(line);
    included.push(summary.path);
    usedChars = nextChars;
  }
  for (const summary of ordered) {
    if (!included.includes(summary.path) && !excluded.includes(summary.path)) {
      excluded.push(summary.path);
    }
  }
  const text = lines.join('\n');
  return {
    text,
    estimatedTokens: estimateCodingV5Tokens(text),
    budgetTokens,
    includedDirectories: included,
    excludedDirectories: excluded,
    truncated: excluded.length > 0,
    totalDirectories: tree.stats.directories,
  };
}
