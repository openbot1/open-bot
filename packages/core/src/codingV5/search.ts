/**
 * Repo map v5 — code graph search (v1.13, Doi T3).
 *
 * Y tuong hoc tu OpenHands Repository Map (tim symbol / caller /
 * callee tren do thi code) — chi hoc y tuong, tu thiet ke va viet
 * lai hoan toan tu dau.
 *
 * Mo rong truy van v2 (`queryCodingV2Graph` — Personalized PageRank
 * theo token cua truy van, tra file lien quan nhat) va chi tiet
 * symbol v2 (`codingV2SymbolDetail` — dinh nghia + file nhac toi):
 *
 *   - tim symbol theo nhieu che do khop: exact (ten ngan hoac ten
 *     day du), prefix, substring, regex, fuzzy (subsequence — vd
 *     `rmp` khop `RepoMapParser`), kem loc theo kind / file / thu
 *     muc;
 *   - tim caller / callee THAT (tu call site cua topology v5 —
 *     biet ham nao goi ham nao o dong nao), khong chi "file nao
 *     nhac ten symbol";
 *   - tim file import mot module (importer theo specifier hoac theo
 *     file dich da resolve);
 *   - xep hang lien quan: diem khop ten (exact > prefix > substring
 *     > fuzzy) + diem PageRank file/symbol cua v2 (khi co do thi)
 *     + fan-in cua symbol (duoc goi nhieu thi lien quan hon).
 *
 * Module nay thuan tuy (khong fs): dau vao la entries v2 + do thi
 * v2 (tuy chon) + topology v5. Lop fs song o
 * `packages/tools/src/codingV5RepoMap.ts`.
 *
 * Gioi han trung thuc:
 *   - fuzzy chi la subsequence tren ten (khong phai edit distance
 *     day du); regex khong hop le tra loi thay vi throw.
 *   - caller/callee chi thay call site ma regex trich duoc (goi qua
 *     bien trung gian / goi dong khong thay — xem topology.ts).
 *   - khong co do thi v2 thi diem PageRank = 0, xep hang chi theo
 *     diem khop ten + fan-in.
 */

import type { CodingV2FileEntry, CodingV2Graph } from '../codingV2/repoMapGraph';
import type { CodingV5Topology } from './topology';

/** Che do khop ten symbol. */
export type CodingV5MatchMode = 'exact' | 'prefix' | 'substring' | 'regex' | 'fuzzy';

/** Mot ket qua tim symbol. */
export interface CodingV5SymbolSearchHit {
  file: string;
  name: string;
  qualifiedName: string;
  kind: string;
  line: number;
  column: number;
  endLine: number;
  /** Che do khop da dung (sau khi ha cap neu can). */
  match: CodingV5MatchMode;
  /** Diem khop ten (0-1). */
  nameScore: number;
  /** Diem PageRank symbol cua v2 (0 khi khong co do thi). */
  symbolScore: number;
  /** Diem PageRank file cua v2 (0 khi khong co do thi). */
  fileScore: number;
  /** So caller khac nhau goi symbol nay (tu topology). */
  fanIn: number;
  /** Diem lien quan tong hop (0-1). */
  relevance: number;
}

/** Mot caller cua mot symbol (tu call site). */
export interface CodingV5CallerHit {
  /** Ham chua diem goi ('' = top-level). */
  caller: string;
  callerFile: string;
  callerLine: number;
  /** Dong goi ham. */
  callLine: number;
  callColumn: number;
  /** Ten day du o diem goi (`obj.save`). */
  calleeQualified: string;
}

/** Mot callee cua mot symbol (ham no goi). */
export interface CodingV5CalleeHit {
  callee: string;
  calleeFile: string | null;
  calleeQualified: string | null;
  /** Dong goi trong file cua caller. */
  callLine: number;
  callColumn: number;
  ambiguous: boolean;
}

/** Mot file import mot module. */
export interface CodingV5ImporterHit {
  file: string;
  line: number;
  specifier: string;
  kind: string;
  importedNames: string[];
}

/** Ket qua tim file import mot module. */
export interface CodingV5ImportSearchResult {
  query: string;
  /** File dich da resolve (null khi query la bare specifier ngoai repo). */
  resolvedTarget: string | null;
  importers: CodingV5ImporterHit[];
  totalImporters: number;
}

export interface CodingV5SearchOptions {
  /** Che do khop (mac dinh 'substring'). */
  mode?: CodingV5MatchMode;
  /** Loc theo kind (`function`, `class`, ...). */
  kind?: string;
  /** Chi tim trong file nay. */
  file?: string;
  /** Chi tim trong thu muc nay (tien to duong dan). */
  directory?: string;
  /** So ket qua toi da (mac dinh 20). */
  limit?: number;
  /** Trong so diem khop ten (mac dinh 0.5). */
  nameWeight?: number;
  /** Trong so diem PageRank (mac dinh 0.3). */
  rankWeight?: number;
  /** Trong so fan-in (mac dinh 0.2). */
  fanInWeight?: number;
}

// ---------------------------------------------------------------------------
// Khop ten
// ---------------------------------------------------------------------------

/** Fuzzy subsequence: moi ky tu cua pattern xuat hien theo thu tu trong ten. */
export function codingV5FuzzyMatch(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  let j = 0;
  for (let i = 0; i < n.length && j < p.length; i += 1) {
    if (n[i] === p[j]) j += 1;
  }
  return j === p.length;
}

/** Diem fuzzy: ty le ky tu pattern / do dai ten (ten ngan khop chat hon). */
export function codingV5FuzzyScore(pattern: string, name: string): number {
  if (pattern.length === 0) return 0;
  if (!codingV5FuzzyMatch(pattern, name)) return 0;
  return pattern.length / Math.max(name.length, pattern.length);
}

/**
 * Tinh diem khop ten theo che do. Tra null khi khong khop.
 * Exact khop ca ten ngan lan ten day du; prefix/substring chi xet
 * ten ngan + ten day du (lay max); regex chi xet ten day du.
 */
export function codingV5NameMatch(
  query: string,
  name: string,
  qualifiedName: string,
  mode: CodingV5MatchMode,
): { match: CodingV5MatchMode; score: number } | null {
  const q = query.trim();
  if (q === '') return null;
  const lowerQ = q.toLowerCase();
  const lowerName = name.toLowerCase();
  const lowerQualified = qualifiedName.toLowerCase();
  switch (mode) {
    case 'exact': {
      if (lowerName === lowerQ || lowerQualified === lowerQ) return { match: 'exact', score: 1 };
      return null;
    }
    case 'prefix': {
      if (lowerName.startsWith(lowerQ) || lowerQualified.startsWith(lowerQ)) {
        return { match: 'prefix', score: 0.85 };
      }
      return null;
    }
    case 'substring': {
      if (lowerName.includes(lowerQ) || lowerQualified.includes(lowerQ)) {
        const best = Math.max(lowerName.length, lowerQualified.length);
        return { match: 'substring', score: 0.7 * (q.length / Math.max(best, q.length)) + 0.1 };
      }
      return null;
    }
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(q, 'i');
      } catch {
        return null;
      }
      if (re.test(qualifiedName) || re.test(name)) return { match: 'regex', score: 0.75 };
      return null;
    }
    case 'fuzzy': {
      const s = Math.max(codingV5FuzzyScore(q, name), codingV5FuzzyScore(q, qualifiedName));
      if (s > 0) return { match: 'fuzzy', score: 0.4 + 0.6 * s };
      return null;
    }
    default:
      return null;
  }
}

/** Ha cap che do khop khi che do chinh khong ra ket qua (substring -> fuzzy). */
export function codingV5FallbackMode(mode: CodingV5MatchMode): CodingV5MatchMode | null {
  if (mode === 'substring') return 'fuzzy';
  if (mode === 'prefix') return 'substring';
  return null;
}

// ---------------------------------------------------------------------------
// Tim symbol
// ---------------------------------------------------------------------------

function normalizeWeights(options: CodingV5SearchOptions): {
  nameWeight: number;
  rankWeight: number;
  fanInWeight: number;
} {
  const clean = (v: number | undefined, dflt: number): number =>
    v !== undefined && Number.isFinite(v) && v >= 0 ? v : dflt;
  const nw = clean(options.nameWeight, 0.5);
  const rw = clean(options.rankWeight, 0.3);
  const fw = clean(options.fanInWeight, 0.2);
  const total = nw + rw + fw;
  if (total <= 0) return { nameWeight: 0.5, rankWeight: 0.3, fanInWeight: 0.2 };
  return { nameWeight: nw / total, rankWeight: rw / total, fanInWeight: fw / total };
}

/**
 * Tim symbol theo ten/mau. Neu che do chinh khong ra ket qua va co
 * che do ha cap thi tu dong thu lai (ghi ro che do da dung trong
 * tung hit). Ket qua xep theo relevance giam dan.
 */
export function searchCodingV5Symbols(
  files: CodingV2FileEntry[],
  query: string,
  topology: CodingV5Topology | null,
  graph: CodingV2Graph | null,
  options: CodingV5SearchOptions = {},
): { hits: CodingV5SymbolSearchHit[]; modeUsed: CodingV5MatchMode; fellBack: boolean } {
  const limit = Math.max(0, Math.floor(options.limit ?? 20));
  const mode = options.mode ?? 'substring';
  const weights = normalizeWeights(options);
  const run = (m: CodingV5MatchMode): CodingV5SymbolSearchHit[] => {
    const hits: CodingV5SymbolSearchHit[] = [];
    // Chuan hoa fan-in theo max de dua ve 0-1.
    let maxFanIn = 0;
    const fanInOf = new Map<string, number>();
    if (topology) {
      for (const [key, fan] of topology.symbolFan) {
        fanInOf.set(key, fan.fanIn);
        maxFanIn = Math.max(maxFanIn, fan.fanIn);
      }
    }
    for (const file of files) {
      if (options.file && file.relPath !== options.file) continue;
      if (options.directory && !file.relPath.startsWith(`${options.directory}/`) && file.relPath !== options.directory) {
        continue;
      }
      for (const s of file.symbols) {
        if (options.kind && s.kind !== options.kind) continue;
        const matched = codingV5NameMatch(query, s.name, s.qualifiedName, m);
        if (!matched) continue;
        const nodeId = `s:${file.relPath}#${s.qualifiedName}`;
        const symbolScore = graph?.symbolScores.get(nodeId) ?? 0;
        const fileScore = graph?.fileScores.get(file.relPath) ?? 0;
        const fanIn = fanInOf.get(`${file.relPath}#${s.qualifiedName}`) ?? 0;
        const fanInNorm = maxFanIn > 0 ? fanIn / maxFanIn : 0;
        const rankScore = Math.max(symbolScore, fileScore);
        const relevance =
          weights.nameWeight * matched.score +
          weights.rankWeight * rankScore +
          weights.fanInWeight * fanInNorm;
        hits.push({
          file: file.relPath,
          name: s.name,
          qualifiedName: s.qualifiedName,
          kind: s.kind,
          line: s.line,
          column: s.column,
          endLine: s.endLine,
          match: matched.match,
          nameScore: matched.score,
          symbolScore,
          fileScore,
          fanIn,
          relevance,
        });
      }
    }
    hits.sort((a, b) => b.relevance - a.relevance || a.file.localeCompare(b.file) || a.line - b.line);
    return hits.slice(0, limit);
  };
  let hits = run(mode);
  let modeUsed = mode;
  let fellBack = false;
  if (hits.length === 0) {
    const fallback = codingV5FallbackMode(mode);
    if (fallback) {
      hits = run(fallback);
      modeUsed = fallback;
      fellBack = true;
    }
  }
  return { hits, modeUsed, fellBack };
}

// ---------------------------------------------------------------------------
// Caller / callee
// ---------------------------------------------------------------------------

/**
 * Tim caller cua mot symbol: moi call site resolve ve dinh nghia
 * (file + qualifiedName) do. `name` co the la ten ngan hoac ten day
 * du; khi ten mo ho (nhieu dinh nghia) thi tra caller cua TAT CA
 * dinh nghia trung ten, ghi ro dinh nghia nao trong tung hit.
 */
export function findCodingV5Callers(
  topology: CodingV5Topology,
  files: CodingV2FileEntry[],
  name: string,
  options: { limit?: number; file?: string } = {},
): { callers: CodingV5CallerHit[]; definitions: string[]; ambiguous: boolean } {
  const limit = Math.max(0, Math.floor(options.limit ?? 20));
  const needle = name.trim();
  const definitions = new Set<string>();
  if (needle !== '') {
    for (const file of files) {
      for (const s of file.symbols) {
        if (s.name === needle || s.qualifiedName === needle) {
          definitions.add(`${file.relPath}#${s.qualifiedName}`);
        }
      }
    }
  }
  const callers: CodingV5CallerHit[] = [];
  for (const site of topology.callSites) {
    if (site.resolvedFile === null || site.resolvedQualified === null) continue;
    if (!definitions.has(`${site.resolvedFile}#${site.resolvedQualified}`)) continue;
    if (options.file && site.file !== options.file) continue;
    // Bo goi de quy trong chinh dinh nghia (caller = callee).
    if (site.file === site.resolvedFile && site.caller === site.resolvedQualified) continue;
    callers.push({
      caller: site.caller,
      callerFile: site.file,
      callerLine: site.line,
      callLine: site.line,
      callColumn: site.column,
      calleeQualified: site.calleeQualified,
    });
  }
  callers.sort((a, b) => a.callerFile.localeCompare(b.callerFile) || a.callLine - b.callLine);
  return {
    callers: callers.slice(0, limit),
    definitions: [...definitions].sort(),
    ambiguous: definitions.size > 1,
  };
}

/**
 * Tim callee cua mot symbol: moi call site nam trong ham/class do
 * (theo `caller` cua call site). Tra ca callee chua resolve (ham
 * ngoai repo / global) kem co `calleeFile = null`.
 */
export function findCodingV5Callees(
  topology: CodingV5Topology,
  file: string,
  qualifiedName: string,
  options: { limit?: number } = {},
): { callees: CodingV5CalleeHit[]; found: boolean } {
  const limit = Math.max(0, Math.floor(options.limit ?? 20));
  const found = topology.callSites.some(
    (s) => s.file === file && s.caller === qualifiedName,
  ) || (() => {
    // Symbol ton tai nhung khong co call site nao: van tra found=true
    // khi caller nam trong topology (khong co call site nao ca).
    return topology.symbolFan.has(`${file}#${qualifiedName}`);
  })();
  const seen = new Set<string>();
  const callees: CodingV5CalleeHit[] = [];
  for (const site of topology.callSites) {
    if (site.file !== file || site.caller !== qualifiedName) continue;
    const key = `${site.calleeQualified}@${site.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    callees.push({
      callee: site.callee,
      calleeFile: site.resolvedFile,
      calleeQualified: site.resolvedQualified,
      callLine: site.line,
      callColumn: site.column,
      ambiguous: site.ambiguous,
    });
  }
  callees.sort((a, b) => a.callLine - b.callLine || a.callee.localeCompare(b.callee));
  return { callees: callees.slice(0, limit), found };
}

// ---------------------------------------------------------------------------
// Tim file import mot module
// ---------------------------------------------------------------------------

/**
 * Tim file import mot module: query co the la duong dan file trong
 * repo (`src/foo.ts`), ten file (`foo.ts`), hoac specifier bare
 * (`react`). Voi file trong repo: khop ca import resolve ve file do
 * lan import specifier tuong doi tro toi no. Voi bare: khop specifier.
 */
export function findCodingV5Importers(
  topology: CodingV5Topology,
  query: string,
  options: { limit?: number } = {},
): CodingV5ImportSearchResult {
  const limit = Math.max(0, Math.floor(options.limit ?? 20));
  const q = query.trim();
  let resolvedTarget: string | null = null;
  const importers: CodingV5ImporterHit[] = [];
  if (q === '') return { query, resolvedTarget, importers, totalImporters: 0 };
  // Tim file dich trong repo: khop duong dan day du hoac ten file.
  const candidates = [...topology.importsByFile.keys()].filter(
    (f) => f === q || f.endsWith(`/${q}`) || f.split('/').pop() === q,
  );
  if (candidates.length === 1) resolvedTarget = candidates[0]!;
  for (const [file, imports] of topology.importsByFile) {
    for (const imp of imports) {
      let hit = false;
      if (resolvedTarget !== null && imp.resolved === resolvedTarget) hit = true;
      if (imp.specifier === q) hit = true;
      if (candidates.length > 1 && imp.resolved !== null && candidates.includes(imp.resolved)) hit = true;
      if (!hit) continue;
      importers.push({
        file,
        line: imp.line,
        specifier: imp.specifier,
        kind: imp.kind,
        importedNames: [...imp.importedNames],
      });
    }
  }
  importers.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    query,
    resolvedTarget,
    importers: importers.slice(0, limit),
    totalImporters: importers.length,
  };
}

// ---------------------------------------------------------------------------
// Render ket qua tim kiem (text cho agent)
// ---------------------------------------------------------------------------

/** Render ket qua tim symbol thanh text ngan cho agent loop. */
export function renderCodingV5SymbolHits(hits: CodingV5SymbolSearchHit[]): string {
  if (hits.length === 0) return '(no symbols found)';
  return hits
    .map(
      (h, i) =>
        `${i + 1}. ${h.qualifiedName} (${h.kind}) — ${h.file}:${h.line} ` +
        `[match ${h.match} ${h.nameScore.toFixed(2)}, relevance ${h.relevance.toFixed(3)}, ` +
        `fan-in ${h.fanIn}]`,
    )
    .join('\n');
}

/** Render caller/callee thanh text ngan. */
export function renderCodingV5Callers(callers: CodingV5CallerHit[]): string {
  if (callers.length === 0) return '(no callers found)';
  return callers
    .map(
      (c, i) =>
        `${i + 1}. ${c.caller || '(top-level)'} in ${c.callerFile}:${c.callLine} ` +
        `calls ${c.calleeQualified}`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Impact analysis: doi symbol X thi anh huong toi dau
// ---------------------------------------------------------------------------

/** Do sau mac dinh cua impact analysis (so bac lan theo caller/importer). */
export const CODING_V5_DEFAULT_IMPACT_DEPTH = 3;
/** So ket qua impact toi da mac dinh. */
export const CODING_V5_DEFAULT_IMPACT_LIMIT = 20;

/** Mot node bi anh huong khi doi mot symbol. */
export interface CodingV5ImpactHit {
  /** 'symbol' = ham/class bi anh huong; 'file' = file bi anh huong (import file chua symbol). */
  kind: 'symbol' | 'file';
  /** File cua node bi anh huong. */
  file: string;
  /** Ten day du (chi khi kind = 'symbol'). */
  qualifiedName: string | null;
  /** So bac tu symbol goc (0 = chinh dinh nghia, 1 = caller/importer truc tiep). */
  depth: number;
  /** Chuoi ly do ngan: `caller` / `imports` + ten node trung gian. */
  via: string;
}

/** Ket qua impact analysis. */
export interface CodingV5ImpactResult {
  query: string;
  found: boolean;
  /** Dinh nghia goc (file#qualifiedName). */
  definitions: string[];
  /** true khi ten mo ho (nhieu dinh nghia) — impact tinh tren TAT CA dinh nghia. */
  ambiguous: boolean;
  /** Node bi anh huong (da cat theo limit), xep theo depth roi file. */
  impacted: CodingV5ImpactHit[];
  /** Tong so node bi anh huong (truoc khi cat). */
  totalImpacted: number;
  /** true khi con node chua liet ke het vi vuot limit hoac vuot depth. */
  truncated: boolean;
  /** Do sau toi da da duyet. */
  maxDepthReached: number;
}

export interface CodingV5ImpactOptions {
  /** So bac lan toi da (mac dinh 3). */
  maxDepth?: number;
  /** So ket qua toi da (mac dinh 20). */
  limit?: number;
}

/**
 * Impact analysis: neu doi symbol X (doi signature / xoa / doi hanh
 * vi) thi nhung symbol/file nao co the bi anh huong? Lan nguoc theo
 * 2 loai canh:
 *
 *   - caller: ham goi X truc tiep, roi ham goi ham do (de quy theo
 *     call site cua topology v5);
 *   - importer: file import file chua X (ke ca khi chua goi X truc
 *     tiep — doi export co the pha import), roi file import file do.
 *
 * Moi node chi xuat hien mot lan (o depth nho nhat tim thay). Ket qua
 * la uoc luong "co the anh huong" (over-approximation co chu dich):
 * goi qua bien trung gian khong thay nen co the thieu, va file chi
 * import nhung khong dung X van bi liet ke (ghi ro `via: imports`).
 */
export function impactCodingV5Of(
  topology: CodingV5Topology,
  files: CodingV2FileEntry[],
  name: string,
  options: CodingV5ImpactOptions = {},
): CodingV5ImpactResult {
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? CODING_V5_DEFAULT_IMPACT_DEPTH));
  const limit = Math.max(0, Math.floor(options.limit ?? CODING_V5_DEFAULT_IMPACT_LIMIT));
  const needle = name.trim();
  const base: CodingV5ImpactResult = {
    query: name,
    found: false,
    definitions: [],
    ambiguous: false,
    impacted: [],
    totalImpacted: 0,
    truncated: false,
    maxDepthReached: 0,
  };
  if (needle === '') return base;
  const definitions = new Set<string>();
  for (const file of files) {
    for (const s of file.symbols) {
      if (s.name === needle || s.qualifiedName === needle) {
        definitions.add(`${file.relPath}#${s.qualifiedName}`);
      }
    }
  }
  if (definitions.size === 0) return base;
  const definitionFiles = new Set([...definitions].map((d) => d.split('#')[0]!));

  // BFS theo bac: frontier la tap (symbolKey | file) o bac hien tai.
  const seen = new Map<string, CodingV5ImpactHit>();
  const seed = (hit: CodingV5ImpactHit): void => {
    const key = hit.kind === 'symbol' ? `s:${hit.file}#${hit.qualifiedName}` : `f:${hit.file}`;
    const prev = seen.get(key);
    if (!prev || hit.depth < prev.depth) seen.set(key, hit);
  };
  // Bac 0: chinh cac dinh nghia.
  for (const def of definitions) {
    const [file, qualifiedName] = def.split('#');
    seed({ kind: 'symbol', file: file!, qualifiedName: qualifiedName!, depth: 0, via: 'definition' });
  }
  let frontierSymbols = new Set<string>(definitions);
  let frontierFiles = new Set<string>(definitionFiles);
  let maxDepthReached = 0;
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const nextSymbols = new Set<string>();
    const nextFiles = new Set<string>();
    // Caller cua moi symbol o frontier.
    for (const symKey of frontierSymbols) {
      const [file, qualifiedName] = symKey.split('#');
      for (const site of topology.callSites) {
        if (site.resolvedFile !== file || site.resolvedQualified !== qualifiedName) continue;
        if (site.caller === '') continue; // goi o top-level: tinh theo file.
        const callerKey = `${site.file}#${site.caller}`;
        const hit: CodingV5ImpactHit = {
          kind: 'symbol',
          file: site.file,
          qualifiedName: site.caller,
          depth,
          via: `calls ${qualifiedName} at line ${site.line}`,
        };
        seed(hit);
        nextSymbols.add(callerKey);
        nextFiles.add(site.file);
      }
      // File chua caller o top-level cung bi anh huong.
      for (const site of topology.callSites) {
        if (site.resolvedFile !== file || site.resolvedQualified !== qualifiedName) continue;
        if (site.caller !== '') continue;
        seed({ kind: 'file', file: site.file, qualifiedName: null, depth, via: `calls ${qualifiedName} at top level (line ${site.line})` });
        nextFiles.add(site.file);
      }
    }
    // Importer cua moi file o frontier.
    for (const targetFile of frontierFiles) {
      for (const [from, imports] of topology.importsByFile) {
        for (const imp of imports) {
          if (imp.resolved !== targetFile) continue;
          seed({
            kind: 'file',
            file: from,
            qualifiedName: null,
            depth,
            via: `imports ${targetFile} (${imp.specifier}, line ${imp.line})`,
          });
          nextFiles.add(from);
          break;
        }
      }
    }
    maxDepthReached = depth;
    // Loai node da thay o bac thap hon khoi frontier ke tiep.
    frontierSymbols = new Set(
      [...nextSymbols].filter((k) => {
        const prev = seen.get(`s:${k}`);
        return prev !== undefined && prev.depth === depth;
      }),
    );
    frontierFiles = new Set(
      [...nextFiles].filter((f) => {
        const prev = seen.get(`f:${f}`);
        return prev !== undefined && prev.depth === depth;
      }),
    );
    if (frontierSymbols.size === 0 && frontierFiles.size === 0) break;
  }
  const all = [...seen.values()].sort(
    (a, b) => a.depth - b.depth || a.file.localeCompare(b.file) || (a.qualifiedName ?? '').localeCompare(b.qualifiedName ?? ''),
  );
  return {
    query: name,
    found: true,
    definitions: [...definitions].sort(),
    ambiguous: definitions.size > 1,
    impacted: all.slice(0, limit),
    totalImpacted: all.length,
    truncated: all.length > limit,
    maxDepthReached,
  };
}

/** Render ket qua impact analysis thanh text ngan cho agent loop. */
export function renderCodingV5Impact(result: CodingV5ImpactResult): string {
  if (!result.found) return `Symbol "${result.query}" not found — no impact to report.`;
  const lines = [
    `Changing "${result.query}" may affect ${result.totalImpacted} node(s)` +
      (result.ambiguous ? ` (ambiguous name — impact over ALL ${result.definitions.length} definitions: ${result.definitions.join(', ')})` : ` (definition: ${result.definitions.join(', ')})`) +
      (result.truncated ? ` — showing ${result.impacted.length}` : '') +
      `, up to depth ${result.maxDepthReached}.`,
  ];
  for (const hit of result.impacted) {
    if (hit.kind === 'symbol') {
      lines.push(`  - [depth ${hit.depth}] ${hit.qualifiedName} in ${hit.file} — ${hit.via}`);
    } else {
      lines.push(`  - [depth ${hit.depth}] file ${hit.file} — ${hit.via}`);
    }
  }
  if (result.impacted.length === 0) lines.push('  (no callers or importers found — safe to change in isolation)');
  return lines.join('\n');
}
