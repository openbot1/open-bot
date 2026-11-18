/**
 * Repo map v4 (v1.17, Doi T3) — signature extraction + PageRank +
 * token-budget rendering.
 *
 * Y tuong (hoc tu Aider repo map: tree-sitter lay signature class /
 * function + import, khong lay than ham; PageRank tren do thi
 * import/call — viet lai hoan toan cho open-bot, khong copy code /
 * text / tai san repo nao):
 * - Signature extraction: TS/JS/Python tai dung parser v8 cua repo
 *   (da co san, da test); Go/Rust/Java them parser rieng o day
 *   (regex theo khai bao, chi lay signature — khong than ham).
 * - Graph: node file + node symbol; canh imports (file -> file),
 *   calls (symbol -> symbol, resolve theo ten ngan trong file da
 *   import hoac cung file), defines (file -> symbol).
 * - PageRank co trong so theo kind canh (calls > imports >
 *   references > defines) + personalization theo query, xu ly
 *   dangling node — diem file = tong diem symbol cua file + diem
 *   file, chuan hoa ve tong 1.
 * - Token budget: render map theo thu tu rank, cat khi het budget
 *   (token uoc luong chars/4, cau hinh duoc); bao ro file nao duoc
 *   dua vao, file nao bi cat, bao nhieu token.
 * - Query: tim symbol theo ten, tra hit kem `reasons` (ten khop /
 *   import / call / PageRank cao) de agent giai thich duoc.
 *
 * Gioi han trung thuc: call resolve theo ten ngan nen method trung
 * ten o nhieu class co the noi nham canh (bao trong stats);
 * token chi la uoc luong (chars/4), khong dem bang tokenizer that.
 */

import { v8ParseFile } from '../codingV8/parser';
import type { V8ParsedFile, V8Symbol } from '../codingV8/types';

/** Ngon ngu repo map v4 ho tro (them Go/Rust/Java so voi v8). */
export type Rm4Language = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'unknown';

/** So ky tu uoc tinh = 1 token khi render (giong cac ban truoc). */
export const RM4_CHARS_PER_TOKEN = 4;
/** Ngan sach token mac dinh cho budget map. */
export const RM4_DEFAULT_BUDGET_TOKENS = 2000;
/** He so damping PageRank. */
export const RM4_PAGERANK_DAMPING = 0.85;
/** So vong power iteration toi da. */
export const RM4_PAGERANK_MAX_ITERATIONS = 60;
/** Nguong hoi tu PageRank. */
export const RM4_PAGERANK_EPSILON = 1e-6;
/** Tran canh trong do thi (chong blow-up). */
export const RM4_MAX_EDGES = 200_000;
/** Do dai toi da mot signature khi render. */
export const RM4_MAX_SIGNATURE_CHARS = 200;

/** Kind canh trong graph v4. */
export type Rm4EdgeKind = 'calls' | 'imports' | 'references' | 'defines';

/** Trong so canh theo kind (calls mang tin hieu manh nhat). */
export const RM4_EDGE_WEIGHTS: Record<Rm4EdgeKind, number> = {
  calls: 4,
  imports: 3,
  references: 1.5,
  defines: 1,
};

/** Mot signature da trich xuat (khong bao gom than ham). */
export interface Rm4Signature {
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable';
  /** Ten ngan. */
  name: string;
  /** Ten day du theo scope, vd `Foo.save`. */
  qualifiedName: string;
  /** Chu ky khai bao (da cat ngan), vd `func Save(id string) error`. */
  signature: string;
  /** Dong bat dau, 1-based. */
  line: number;
  /** true = duoc export / public. */
  exported: boolean;
  /** true = async (TS/Python). */
  async: boolean;
}

/** Mot call site: symbol nao goi ten nao (caller '' = top-level/file). */
export interface Rm4Call {
  /** Qualified name cua symbol chua call, '' khi o top-level. */
  caller: string;
  /** Ten duoc goi (ngan). */
  calleeName: string;
}

/** Ket qua trich signature mot file. */
export interface Rm4ParsedFile {
  relPath: string;
  language: Rm4Language;
  signatures: Rm4Signature[];
  /** Specifier import tho (vd `./auth`, `fmt`). */
  imports: string[];
  /** Ten duoc goi trong file (ten ngan, de noi canh calls). */
  calledNames: string[];
  /** Call site kem caller (de noi canh calls dung symbol). */
  calls: Rm4Call[];
  /** true khi co loi parse (van giu phan parse duoc). */
  hasError: boolean;
  parseErrors: string[];
}

/** Mot canh co trong so trong graph v4. */
export interface Rm4Edge {
  from: string;
  to: string;
  kind: Rm4EdgeKind;
  weight: number;
}

/** Do thi repo map v4. */
export interface Rm4Graph {
  /** Id node file: `file:<relPath>`; node symbol: `symbol:<path>#<name>`. */
  nodes: string[];
  edges: Rm4Edge[];
  /** relPath -> file node id. */
  fileNodes: Map<string, string>;
  /** symbol node id -> thong tin signature. */
  symbols: Map<string, { file: string; signature: Rm4Signature }>;
  /** Thong ke build. */
  stats: Rm4BuildStats;
}

/** Thong ke build graph. */
export interface Rm4BuildStats {
  filesParsed: number;
  filesWithErrors: number;
  symbols: number;
  edges: number;
  /** So call khong resolve duoc theo ten (ten goi khong co symbol nao). */
  unresolvedCalls: number;
  /** So ten goi mo ho (nhieu symbol cung ten) — canh references bi bo. */
  ambiguousNames: number;
  /** So file bi cat vi tran canh. */
  edgesTruncated: boolean;
}

/** Diem rank cua mot file. */
export interface Rm4FileRank {
  relPath: string;
  /** Diem PageRank ket hop (tong = 1 tren toan bo file). */
  score: number;
  /** Diem PageRank thuan cua node file + symbol cua no. */
  pageRank: number;
  /** So symbol file dinh nghia. */
  symbolCount: number;
  /** So file khac import file nay. */
  importedByCount: number;
}

/** Ket qua query repo map. */
export interface Rm4QueryHit {
  relPath: string;
  symbol?: string;
  signature?: string;
  score: number;
  reasons: string[];
}

/** Ket qua render budget map. */
export interface Rm4BudgetMap {
  /** Noi dung map (chu ky theo rank, cat theo budget). */
  text: string;
  /** Token uoc tinh da dung. */
  tokensUsed: number;
  /** Ngan sach token. */
  budgetTokens: number;
  /** File duoc dua vao map (theo rank). */
  includedFiles: string[];
  /** File bi cat vi het budget. */
  omittedFiles: string[];
  /** File duoc dua vao mot phan (chi mot so signature). */
  partialFiles: string[];
}

// ---------------------------------------------------------------------------
// Ngon ngu + signature extraction
// ---------------------------------------------------------------------------

/** Doan ngon ngu tu duoi file. */
export function rm4LanguageForPath(relPath: string): Rm4Language {
  if (/\.(ts|tsx|mts|cts)$/.test(relPath)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(relPath)) return 'javascript';
  if (/\.py$/.test(relPath)) return 'python';
  if (/\.go$/.test(relPath)) return 'go';
  if (/\.rs$/.test(relPath)) return 'rust';
  if (/\.java$/.test(relPath)) return 'java';
  return 'unknown';
}

/** Cat signature ve do dai toi da, giu nguyen dau. */
function truncateSignature(sig: string): string {
  const s = sig.replace(/\s+/g, ' ').trim();
  return s.length > RM4_MAX_SIGNATURE_CHARS ? `${s.slice(0, RM4_MAX_SIGNATURE_CHARS - 3)}...` : s;
}

/** Chuyen V8Symbol (TS/Python) thanh Rm4Signature. */
function fromV8Symbol(sym: V8Symbol): Rm4Signature {
  return {
    kind: sym.kind === 'namespace' || sym.kind === 'property' ? 'variable' : sym.kind,
    name: sym.name,
    qualifiedName: sym.qualifiedName,
    signature: truncateSignature(sym.signature),
    line: sym.line,
    exported: sym.exported,
    async: sym.async,
  };
}

/** Lay ten goi (ngan) tu source Go/Rust/Java bang regex don gian. */
function collectCalledNames(source: string): string[] {
  const names = new Set<string>();
  const re = /(?:^|[^\w$.])([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1] as string;
    if (!['if', 'for', 'while', 'switch', 'return', 'func', 'fn'].includes(name)) names.add(name);
  }
  return [...names];
}

/** Chuyen danh sach ten goi thanh call site file-level (caller khong ro). */
function fileLevelCalls(calledNames: string[]): Rm4Call[] {
  return calledNames.map((calleeName) => ({ caller: '', calleeName }));
}
function parseGoSignatures(relPath: string, content: string): Rm4ParsedFile {
  const signatures: Rm4Signature[] = [];
  const errors: string[] = [];
  const lines = content.split('\n');
  const funcRe = /^func\s+(?:\(([^)]*)\)\s*)?([A-Z][A-Za-z0-9_]*|[a-z][A-Za-z0-9_]*)\s*(\([^)]*\))\s*(.*)\{/;
  const typeRe = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface|map|chan|func)\b/;
  const importRe = /^\s*"([^"]+)"\s*$/;
  const imports: string[] = [];
  let inImportBlock = false;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === 'import (') { inImportBlock = true; return; }
    if (inImportBlock && trimmed === ')') { inImportBlock = false; return; }
    if (inImportBlock) {
      const im = importRe.exec(trimmed);
      if (im) imports.push(im[1] as string);
      return;
    }
    const singleImport = /^import\s+"([^"]+)"/.exec(trimmed);
    if (singleImport) imports.push(singleImport[1] as string);
    const fm = funcRe.exec(line);
    if (fm) {
      const receiver = fm[1] as string | undefined;
      const name = fm[2] as string;
      const params = fm[3] as string;
      const ret = (fm[4] as string).trim();
      const exported = /^[A-Z]/.test(name);
      signatures.push({
        kind: receiver ? 'method' : 'function',
        name,
        qualifiedName: name,
        signature: truncateSignature(`func ${receiver ? `(${receiver}) ` : ''}${name}${params}${ret ? ` ${ret}` : ''}`),
        line: idx + 1,
        exported,
        async: false,
      });
      return;
    }
    const tm = typeRe.exec(line);
    if (tm) {
      const name = tm[1] as string;
      signatures.push({
        kind: tm[2] === 'struct' || tm[2] === 'interface' ? 'class' : 'type',
        name,
        qualifiedName: name,
        signature: truncateSignature(`type ${name} ${tm[2]}`),
        line: idx + 1,
        exported: /^[A-Z]/.test(name),
        async: false,
      });
    }
  });
  const calledNames = collectCalledNames(content);
  return { relPath, language: 'go', signatures, imports, calledNames, calls: fileLevelCalls(calledNames), hasError: errors.length > 0, parseErrors: errors };
}

/** Trich signature Rust: fn / struct / enum / trait / impl method. */
function parseRustSignatures(relPath: string, content: string): Rm4ParsedFile {
  const signatures: Rm4Signature[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');
  let currentImpl: string | null = null;
  let braceDepth = 0;
  const useRe = /^use\s+([^;]+);/;
  const fnRe = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))\s*(?:->\s*([^{\n]+))?/;
  const structRe = /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const enumRe = /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const traitRe = /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const implRe = /^impl(?:\s+[^{]+)?\s+for\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{|^impl\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) currentImpl = null;
    const um = useRe.exec(trimmed);
    if (um) imports.push((um[1] as string).trim());
    const im = implRe.exec(trimmed);
    if (im) currentImpl = (im[1] ?? im[2]) as string;
    const fm = fnRe.exec(trimmed);
    if (fm) {
      const name = fm[1] as string;
      const isPub = /^\s*pub\b/.test(line);
      signatures.push({
        kind: currentImpl ? 'method' : 'function',
        name,
        qualifiedName: currentImpl ? `${currentImpl}.${name}` : name,
        signature: truncateSignature(`${isPub ? 'pub ' : ''}fn ${name}${fm[2]}${fm[3] ? ` -> ${fm[3].trim()}` : ''}`),
        line: idx + 1,
        exported: isPub,
        async: /async\s+fn/.test(trimmed),
      });
      return;
    }
    const sm = structRe.exec(trimmed) ?? enumRe.exec(trimmed) ?? traitRe.exec(trimmed);
    if (sm) {
      const name = sm[1] as string;
      signatures.push({
        kind: 'class',
        name,
        qualifiedName: name,
        signature: truncateSignature(`${/^\s*pub\b/.test(line) ? 'pub ' : ''}${trimmed.split(' ')[0] === 'pub' ? '' : ''}${trimmed.replace(/\{.*$/, '').trim()}`),
        line: idx + 1,
        exported: /^\s*pub\b/.test(line),
        async: false,
      });
    }
  });
  const calledNames = collectCalledNames(content);
  return { relPath, language: 'rust', signatures, imports, calledNames, calls: fileLevelCalls(calledNames), hasError: false, parseErrors: [] };
}

/** Trich signature Java: class / interface / enum / method. */
function parseJavaSignatures(relPath: string, content: string): Rm4ParsedFile {
  const signatures: Rm4Signature[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');
  const importRe = /^import\s+(?:static\s+)?([^;]+);/;
  const classRe = /^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?(class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const methodRe = /^(?:public\s+|private\s+|protected\s+)?(?:static\s+|final\s+|abstract\s+)?(?:[\w<>\[\],\s]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))\s*(?:throws\s+[^{]+)?\{/;
  let currentClass: string | null = null;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const im = importRe.exec(trimmed);
    if (im) imports.push((im[1] as string).trim());
    const cm = classRe.exec(trimmed);
    if (cm) {
      const name = cm[2] as string;
      currentClass = name;
      signatures.push({
        kind: 'class',
        name,
        qualifiedName: name,
        signature: truncateSignature(trimmed.replace(/\{.*$/, '').trim()),
        line: idx + 1,
        exported: /^\s*public\b/.test(line),
        async: false,
      });
      return;
    }
    const mm = methodRe.exec(trimmed);
    if (mm && currentClass) {
      const name = mm[1] as string;
      if (['if', 'for', 'while', 'switch', 'catch'].includes(name)) return;
      signatures.push({
        kind: 'method',
        name,
        qualifiedName: `${currentClass}.${name}`,
        signature: truncateSignature(trimmed.replace(/\{.*$/, '').trim()),
        line: idx + 1,
        exported: /^\s*public\b/.test(line),
        async: false,
      });
    }
  });
  const calledNames = collectCalledNames(content);
  return { relPath, language: 'java', signatures, imports, calledNames, calls: fileLevelCalls(calledNames), hasError: false, parseErrors: [] };
}

/**
 * Trich signature mot file (khong lay than ham). TS/JS/Python dung
 * parser v8; Go/Rust/Java dung parser rieng o day; ngon ngu khac
 * tra file rong (khong crash).
 */
export function rm4ParseFile(relPath: string, content: string): Rm4ParsedFile {
  const lang = rm4LanguageForPath(relPath);
  if (lang === 'typescript' || lang === 'javascript' || lang === 'python') {
    let parsed: V8ParsedFile;
    try {
      parsed = v8ParseFile(relPath, content);
    } catch (err) {
      return { relPath, language: lang, signatures: [], imports: [], calledNames: [], calls: [], hasError: true, parseErrors: [err instanceof Error ? err.message : String(err)] };
    }
    return {
      relPath,
      language: lang,
      signatures: parsed.symbols.map(fromV8Symbol),
      imports: parsed.imports.map((i) => i.specifier),
      calledNames: [...new Set(parsed.calls.map((c) => c.calleeName.split('.').pop() ?? c.calleeName))],
      calls: parsed.calls.map((c) => ({
        caller: c.caller,
        calleeName: c.calleeName.split('.').pop() ?? c.calleeName,
      })),
      hasError: parsed.hasError,
      parseErrors: parsed.parseErrors,
    };
  }
  if (lang === 'go') return parseGoSignatures(relPath, content);
  if (lang === 'rust') return parseRustSignatures(relPath, content);
  if (lang === 'java') return parseJavaSignatures(relPath, content);
  return { relPath, language: 'unknown', signatures: [], imports: [], calledNames: [], calls: [], hasError: false, parseErrors: [] };
}

// ---------------------------------------------------------------------------
// PageRank co trong so
// ---------------------------------------------------------------------------

/** Id node file. */
export function rm4FileNodeId(relPath: string): string {
  return `file:${relPath}`;
}

/** Id node symbol. */
export function rm4SymbolNodeId(relPath: string, qualifiedName: string): string {
  return `symbol:${relPath}#${qualifiedName}`;
}

/**
 * PageRank co trong so tren do thi co huong. Node dangling (khong co
 * canh ra) chia diem deu cho moi node. Tra map nodeId -> diem (tong
 * = 1) + so vong + delta cuoi.
 */
export function rm4PageRank(
  nodes: readonly string[],
  edges: readonly Rm4Edge[],
  options: {
    damping?: number;
    maxIterations?: number;
    epsilon?: number;
    personalization?: Map<string, number>;
  } = {},
): { scores: Map<string, number>; iterations: number; delta: number } {
  const damping = options.damping ?? RM4_PAGERANK_DAMPING;
  const maxIterations = options.maxIterations ?? RM4_PAGERANK_MAX_ITERATIONS;
  const epsilon = options.epsilon ?? RM4_PAGERANK_EPSILON;
  const n = nodes.length;
  const scores = new Map<string, number>();
  if (n === 0) return { scores, iterations: 0, delta: 0 };
  const teleport = new Map<string, number>();
  if (options.personalization && options.personalization.size > 0) {
    let total = 0;
    for (const v of options.personalization.values()) total += Math.max(0, v);
    for (const id of nodes) {
      const w = options.personalization.get(id) ?? 0;
      teleport.set(id, total > 0 ? Math.max(0, w) / total : 1 / n);
    }
  } else {
    for (const id of nodes) teleport.set(id, 1 / n);
  }
  for (const id of nodes) scores.set(id, 1 / n);
  const outWeight = new Map<string, number>();
  const incoming = new Map<string, Rm4Edge[]>();
  for (const id of nodes) {
    outWeight.set(id, 0);
    incoming.set(id, []);
  }
  for (const e of edges) {
    if (!outWeight.has(e.from) || !incoming.has(e.to)) continue;
    outWeight.set(e.from, (outWeight.get(e.from) ?? 0) + e.weight);
    incoming.get(e.to)?.push(e);
  }
  let iterations = 0;
  let delta = Number.POSITIVE_INFINITY;
  while (iterations < maxIterations && delta > epsilon) {
    iterations += 1;
    let danglingSum = 0;
    for (const id of nodes) {
      if ((outWeight.get(id) ?? 0) === 0) danglingSum += scores.get(id) ?? 0;
    }
    const next = new Map<string, number>();
    delta = 0;
    for (const id of nodes) {
      let rank = (1 - damping) * (teleport.get(id) ?? 1 / n);
      rank += damping * (danglingSum / n);
      for (const e of incoming.get(id) ?? []) {
        const out = outWeight.get(e.from) ?? 0;
        if (out > 0) rank += damping * ((scores.get(e.from) ?? 0) * e.weight) / out;
      }
      next.set(id, rank);
      delta = Math.max(delta, Math.abs(rank - (scores.get(id) ?? 0)));
    }
    for (const [id, v] of next) scores.set(id, v);
  }
  return { scores, iterations, delta };
}

// ---------------------------------------------------------------------------
// Build graph
// ---------------------------------------------------------------------------

/**
 * Giai quyet specifier import tuong doi ve relPath trong repo (don
 * gian: `./x`, `../x` + thu cac duoi; chi dung khi file dich co
 * trong tap file da biet).
 */
export function rm4ResolveImport(fromRelPath: string, specifier: string, knownFiles: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = fromRelPath.includes('/') ? fromRelPath.slice(0, fromRelPath.lastIndexOf('/')) : '';
  const parts = (dir ? `${dir}/` : '') + specifier;
  const segs: string[] = [];
  for (const seg of parts.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') segs.pop();
    else segs.push(seg);
  }
  const base = segs.join('/');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.py`,
    `${base}.go`,
    `${base}.rs`,
    `${base}.java`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ];
  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  return null;
}

/**
 * Build graph tu danh sach file (path + noi dung). Canh:
 * - defines: file -> symbol cua no.
 * - imports: file -> file duoc import (resolve tuong doi).
 * - calls: symbol goi -> symbol duoc goi (resolve theo ten ngan;
 *   uu tien symbol trong file da import hoac cung file; ten mo ho
 *   thi bo canh, dem vao stats).
 * - references: file goi -> file dinh nghia ten do (fallback khi
 *   khong resolve duoc call theo symbol).
 */
export function buildRm4Graph(files: ReadonlyArray<{ relPath: string; content: string }>): Rm4Graph {
  const parsed = files.map((f) => rm4ParseFile(f.relPath, f.content));
  const knownFiles = new Set(files.map((f) => f.relPath));
  const nodes: string[] = [];
  const nodeSet = new Set<string>();
  const fileNodes = new Map<string, string>();
  const symbols = new Map<string, { file: string; signature: Rm4Signature }>();
  const addNode = (id: string): void => {
    if (!nodeSet.has(id)) {
      nodeSet.add(id);
      nodes.push(id);
    }
  };
  for (const p of parsed) {
    const fileId = rm4FileNodeId(p.relPath);
    fileNodes.set(p.relPath, fileId);
    addNode(fileId);
    for (const sig of p.signatures) {
      const symId = rm4SymbolNodeId(p.relPath, sig.qualifiedName);
      addNode(symId);
      symbols.set(symId, { file: p.relPath, signature: sig });
    }
  }
  // Index ten ngan -> symbol node (de resolve call).
  const byShortName = new Map<string, string[]>();
  for (const [symId, info] of symbols) {
    const list = byShortName.get(info.signature.name) ?? [];
    list.push(symId);
    byShortName.set(info.signature.name, list);
  }
  const edges: Rm4Edge[] = [];
  const edgeKeys = new Set<string>();
  const stats: Rm4BuildStats = {
    filesParsed: parsed.length,
    filesWithErrors: parsed.filter((p) => p.hasError).length,
    symbols: symbols.size,
    edges: 0,
    unresolvedCalls: 0,
    ambiguousNames: 0,
    edgesTruncated: false,
  };
  const addEdge = (from: string, to: string, kind: Rm4EdgeKind): void => {
    if (from === to) return;
    const key = `${from}|${to}|${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    if (edges.length >= RM4_MAX_EDGES) {
      stats.edgesTruncated = true;
      return;
    }
    edges.push({ from, to, kind, weight: RM4_EDGE_WEIGHTS[kind] });
  };
  for (const p of parsed) {
    const fileId = fileNodes.get(p.relPath) as string;
    for (const sig of p.signatures) {
      addEdge(fileId, rm4SymbolNodeId(p.relPath, sig.qualifiedName), 'defines');
    }
    // Imports: chi noi khi resolve duoc file trong repo.
    const importedFiles = new Set<string>();
    for (const spec of p.imports) {
      const resolved = rm4ResolveImport(p.relPath, spec, knownFiles);
      if (resolved && resolved !== p.relPath) {
        importedFiles.add(resolved);
        addEdge(fileId, fileNodes.get(resolved) as string, 'imports');
      }
    }
    // Calls: resolve theo ten ngan, uu tien symbol o file da import
    // hoac cung file; mo ho thi dem + bo canh calls. Caller la
    // symbol chua call site (khi biet) — khong dung signature dau
    // file cho moi call.
    const candidateFiles = new Set<string>([p.relPath, ...importedFiles]);
    const seenCallNames = new Set<string>();
    for (const call of p.calls) {
      const name = call.calleeName;
      const targets = byShortName.get(name) ?? [];
      if (targets.length === 0) {
        if (!seenCallNames.has(name)) {
          seenCallNames.add(name);
          stats.unresolvedCalls += 1;
        }
        continue;
      }
      const callerId = call.caller
        ? rm4SymbolNodeId(p.relPath, call.caller)
        : fileId;
      const callerNode = nodeSet.has(callerId) ? callerId : fileId;
      const inScope = targets.filter((t) => candidateFiles.has(symbols.get(t)?.file ?? ''));
      if (inScope.length === 1) {
        addEdge(callerNode, inScope[0] as string, 'calls');
      } else if (inScope.length > 1) {
        if (!seenCallNames.has(name)) {
          seenCallNames.add(name);
          stats.ambiguousNames += 1;
        }
        // Fallback references: file goi -> moi file dinh nghia ten do.
        for (const t of inScope) {
          const targetFile = symbols.get(t)?.file;
          if (targetFile) addEdge(fileId, fileNodes.get(targetFile) as string, 'references');
        }
      } else {
        // Ten ton tai nhung khong o file trong scope: references toi
        // file dinh nghia dau tien (tin hieu yeu, khong noi nham call).
        const targetFile = symbols.get(targets[0] as string)?.file;
        if (targetFile && targetFile !== p.relPath) {
          addEdge(fileId, fileNodes.get(targetFile) as string, 'references');
        }
      }
    }
  }
  stats.edges = edges.length;
  return { nodes, edges, fileNodes, symbols, stats };
}

/**
 * Xep hang file: diem file = diem PageRank node file + tong diem
 * symbol cua file, chuan hoa ve tong 1. `queryTerms` (ten symbol /
 * tu khoa) dung lam personalization: file chua symbol khop duoc
 * cong diem teleport.
 */
export function rankRm4Files(
  graph: Rm4Graph,
  queryTerms: readonly string[] = [],
): { ranks: Rm4FileRank[]; iterations: number; delta: number } {
  const personalization = new Map<string, number>();
  if (queryTerms.length > 0) {
    const terms = queryTerms.map((t) => t.toLowerCase());
    for (const [symId, info] of graph.symbols) {
      const name = info.signature.name.toLowerCase();
      const qualified = info.signature.qualifiedName.toLowerCase();
      if (terms.some((t) => name.includes(t) || qualified.includes(t))) {
        personalization.set(symId, 3);
        personalization.set(rm4FileNodeId(info.file), (personalization.get(rm4FileNodeId(info.file)) ?? 0) + 1);
      }
    }
    for (const [file, fileId] of graph.fileNodes) {
      if (terms.some((t) => file.toLowerCase().includes(t))) {
        personalization.set(fileId, (personalization.get(fileId) ?? 0) + 2);
      }
    }
  }
  const { scores, iterations, delta } = rm4PageRank(graph.nodes, graph.edges, { personalization });
  const importedBy = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.kind === 'imports') {
      const toFile = e.to.replace(/^file:/, '');
      importedBy.set(toFile, (importedBy.get(toFile) ?? 0) + 1);
    }
  }
  const symbolCount = new Map<string, number>();
  const symbolScore = new Map<string, number>();
  for (const [symId, info] of graph.symbols) {
    symbolCount.set(info.file, (symbolCount.get(info.file) ?? 0) + 1);
    symbolScore.set(info.file, (symbolScore.get(info.file) ?? 0) + (scores.get(symId) ?? 0));
  }
  const raw: Rm4FileRank[] = [];
  let total = 0;
  for (const [file, fileId] of graph.fileNodes) {
    const score = (scores.get(fileId) ?? 0) + (symbolScore.get(file) ?? 0);
    total += score;
    raw.push({
      relPath: file,
      score,
      pageRank: score,
      symbolCount: symbolCount.get(file) ?? 0,
      importedByCount: importedBy.get(file) ?? 0,
    });
  }
  const ranks = raw
    .map((r) => ({ ...r, score: total > 0 ? r.score / total : 0, pageRank: total > 0 ? r.pageRank / total : 0 }))
    .sort((a, b) => b.score - a.score);
  return { ranks, iterations, delta };
}

// ---------------------------------------------------------------------------
// Query + budget rendering
// ---------------------------------------------------------------------------

/** Uoc tinh token cua mot chuoi (chars / 4). */
export function rm4EstimateTokens(text: string): number {
  return Math.ceil(text.length / RM4_CHARS_PER_TOKEN);
}

/**
 * Tim symbol theo ten (substring, khong phan biet hoa thuong) trong
 * graph; tra hit theo rank file + do khop ten, kem reasons.
 */
export function queryRm4Graph(
  graph: Rm4Graph,
  ranks: readonly Rm4FileRank[],
  query: string,
  limit = 10,
): Rm4QueryHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rankByFile = new Map(ranks.map((r) => [r.relPath, r.score]));
  const hits: Rm4QueryHit[] = [];
  for (const [symId, info] of graph.symbols) {
    const name = info.signature.name.toLowerCase();
    const qualified = info.signature.qualifiedName.toLowerCase();
    if (!name.includes(q) && !qualified.includes(q)) continue;
    const reasons: string[] = [];
    if (name === q) reasons.push('exact name match');
    else reasons.push('name match');
    if (info.signature.exported) reasons.push('exported');
    const score = rankByFile.get(info.file) ?? 0;
    if (score > 0.05) reasons.push('high PageRank file');
    hits.push({
      relPath: info.file,
      symbol: info.signature.qualifiedName,
      signature: info.signature.signature,
      score: score + (name === q ? 0.1 : 0.02),
      reasons,
    });
    void symId;
  }
  // File khop ten duong dan (khong co symbol khop) van tra ve.
  if (hits.length === 0) {
    for (const r of ranks) {
      if (r.relPath.toLowerCase().includes(q)) {
        hits.push({ relPath: r.relPath, score: r.score, reasons: ['file path match'] });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}

/**
 * Render map theo rank, cat theo budget token: file rank cao truoc;
 * moi file chi dua signature (khong than ham); file vuot budget thi
 * dua mot phan signature (partial) hoac bo han (omitted). Tra text
 * + bao cao file nao duoc dua / cat.
 */
export function renderRm4BudgetMap(
  parsedFiles: ReadonlyMap<string, Rm4ParsedFile>,
  ranks: readonly Rm4FileRank[],
  budgetTokens: number = RM4_DEFAULT_BUDGET_TOKENS,
): Rm4BudgetMap {
  const budget = Math.max(0, Math.floor(budgetTokens));
  const includedFiles: string[] = [];
  const omittedFiles: string[] = [];
  const partialFiles: string[] = [];
  const chunks: string[] = [];
  let tokensUsed = 0;
  const header = 'Repo map (signatures only, ranked by PageRank):\n';
  tokensUsed += rm4EstimateTokens(header);
  chunks.push(header);
  for (const rank of ranks) {
    const parsed = parsedFiles.get(rank.relPath);
    if (!parsed) {
      omittedFiles.push(rank.relPath);
      continue;
    }
    const fileHeader = `\n${rank.relPath}:\n`;
    const sigLines = parsed.signatures.map((s) => `  ${s.signature}\n`);
    const importLines = parsed.imports.length > 0 ? [`  imports: ${parsed.imports.join(', ')}\n`] : [];
    const allLines = [...importLines, ...sigLines];
    const fileText = fileHeader + allLines.join('');
    const fileTokens = rm4EstimateTokens(fileText);
    if (tokensUsed + fileTokens <= budget) {
      chunks.push(fileText);
      tokensUsed += fileTokens;
      includedFiles.push(rank.relPath);
      continue;
    }
    // Het budget cho ca file: thu dua mot phan signature.
    let partial = fileHeader;
    let partialTokens = rm4EstimateTokens(partial);
    let added = 0;
    for (const line of allLines) {
      const lt = rm4EstimateTokens(line);
      if (tokensUsed + partialTokens + lt > budget) break;
      partial += line;
      partialTokens += lt;
      added += 1;
    }
    if (added > 0) {
      chunks.push(partial);
      tokensUsed += partialTokens;
      partialFiles.push(rank.relPath);
    } else {
      omittedFiles.push(rank.relPath);
    }
    // Het budget: cac file rank thap hon deu omitted.
    const idx = ranks.indexOf(rank);
    for (const rest of ranks.slice(idx + 1)) omittedFiles.push(rest.relPath);
    break;
  }
  return {
    text: chunks.join(''),
    tokensUsed,
    budgetTokens: budget,
    includedFiles,
    omittedFiles,
    partialFiles,
  };
}
