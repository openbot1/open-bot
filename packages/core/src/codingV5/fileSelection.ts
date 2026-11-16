/**
 * Chon loc file theo repo map cho coding agent v5 (v1.13, Doi T4):
 * lenh `/add`, `/drop`, `/ls-files`.
 *
 * Y tuong hoc tu Aider (`/add` file vao context, repo map gioi han
 * context) — chi hoc y tuong, tu thiet ke va viet lai hoan toan tu
 * dau, KHONG doc, KHONG copy code/text/tai san cua Aider hay bat ky
 * repo nao:
 *
 *   - FileSet: tap file agent dang lam viec — add/drop co validate
 *     (nam trong repo, ton tai, khong phai thu muc he thong nhu
 *     `.git`/`node_modules`/`dist`), uoc luong token moi file, canh
 *     bao khi vuot ngan sach token.
 *   - Goi y file theo truy van: dung xep hang PageRank v2 cua v4
 *     (`rankCodingV4FilesForQuery`) tren do thi symbol-level cua v2
 *     — file seed khop truy van + file duoc tham chieu nhieu + file
 *     moi duoc uu tien; tra ve kem ly do tung file de agent/user
 *     quyet dinh add hay khong.
 *   - Parse lenh chat `/add a.ts b.ts`, `/drop a.ts`, `/ls-files`,
 *     `/add --suggest <query>` thanh cau truc de tool/CLI goi.
 *
 * Gioi han trung thuc:
 *   - Uoc luong token = so ky tu / 4 (giong v4) — chi la uoc luong,
 *     khong phai dem token that cua model.
 *   - Goi y chi tot nhu repo map dua vao: repo chua build map thi
 *     goi y roi ve xep hang theo ten file (substring) — bao ro
 *     `fellBackToNameMatch`.
 *   - FileSet chi giu trong bo nho (theo session); host luu JSON
 *     qua serialize neu can ben vung.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodingV2FileEntry, CodingV2Graph } from '../codingV2/repoMapGraph';
import {
  CODING_V4_CHARS_PER_TOKEN,
  codingV4ReferenceTotals,
  estimateCodingV4Tokens,
  rankCodingV4FilesForQuery,
} from '../codingV4/repoMapV4';
import type { CodingV4RankOptions } from '../codingV4/repoMapV4';

export const CODING_V5_DEFAULT_TOKEN_BUDGET = 8000;
export const CODING_V5_MAX_FILE_SET_SIZE = 200;
/** Thu muc khong bao gio add vao context (he thong/build output). */
export const CODING_V5_IGNORED_DIR_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.open-bot',
  'coverage',
  '.tmp',
]);

export class CodingV5FileSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingV5FileSelectionError';
  }
}

/** Ly do mot duong dan bi tu choi khi add. */
export function validateCodingV5AddPath(repoRoot: string, relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath.trim() === '') return 'Duong dan rong.';
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return `Duong dan "${relPath}" la tuyet doi — chi chap nhan duong dan tuong doi trong repo.`;
  }
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return 'Duong dan rong.';
  if (segments.some((s) => s === '..')) {
    return `Duong dan "${relPath}" thoat khoi repo ("..").`;
  }
  if (segments.some((s) => CODING_V5_IGNORED_DIR_SEGMENTS.has(s))) {
    return `Duong dan "${relPath}" nam trong thu muc he thong/build — khong add vao context.`;
  }
  const resolved = path.resolve(repoRoot, ...segments);
  const rootResolved = path.resolve(repoRoot);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return `Duong dan "${relPath}" nam ngoai repo root.`;
  }
  if (!fs.existsSync(resolved)) return `File khong ton tai: "${relPath}".`;
  if (!fs.statSync(resolved).isFile()) return `"${relPath}" khong phai file.`;
  return null;
}

export interface CodingV5FileEntry {
  relPath: string;
  size: number;
  /** Uoc luong token (ky tu / 4). */
  tokens: number;
  addedAt: string;
}

export interface CodingV5FileSetStats {
  files: number;
  totalBytes: number;
  totalTokens: number;
  budgetTokens: number;
  /** true khi vuot ngan sach. */
  overBudget: boolean;
  /** So token vuot (0 neu khong vuot). */
  overByTokens: number;
}

/** Tap file agent dang lam viec trong mot session/repo. */
export class CodingV5FileSet {
  readonly repoRoot: string;
  budgetTokens: number;
  private readonly filesMap = new Map<string, CodingV5FileEntry>();

  constructor(repoRoot: string, budgetTokens: number = CODING_V5_DEFAULT_TOKEN_BUDGET) {
    const resolved = path.resolve(repoRoot);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new CodingV5FileSelectionError(`Repo root khong ton tai hoac khong phai thu muc: ${repoRoot}.`);
    }
    this.repoRoot = resolved;
    this.budgetTokens = Math.max(1, Math.floor(budgetTokens));
  }

  /** So file trong tap. */
  get size(): number {
    return this.filesMap.size;
  }

  /** true khi file da co trong tap. */
  has(relPath: string): boolean {
    return this.filesMap.has(normalizeCodingV5RelPath(relPath));
  }

  /** Them mot file (validate + doc noi dung de uoc luong token). */
  add(relPath: string): CodingV5FileEntry {
    const normalized = normalizeCodingV5RelPath(relPath);
    if (this.filesMap.has(normalized)) {
      return this.filesMap.get(normalized) as CodingV5FileEntry;
    }
    if (this.filesMap.size >= CODING_V5_MAX_FILE_SET_SIZE) {
      throw new CodingV5FileSelectionError(
        `Tap file da dat toi da ${CODING_V5_MAX_FILE_SET_SIZE} file — drop bot truoc khi add them.`,
      );
    }
    const problem = validateCodingV5AddPath(this.repoRoot, normalized);
    if (problem) throw new CodingV5FileSelectionError(problem);
    const abs = path.resolve(this.repoRoot, ...normalized.split('/'));
    const content = fs.readFileSync(abs, 'utf8');
    const entry: CodingV5FileEntry = {
      relPath: normalized,
      size: Buffer.byteLength(content, 'utf8'),
      tokens: estimateCodingV4Tokens(content),
      addedAt: new Date().toISOString(),
    };
    this.filesMap.set(normalized, entry);
    return entry;
  }

  /** Them nhieu file, tra ve ket qua tung file (khong dung o file loi). */
  addMany(relPaths: string[]): { added: CodingV5FileEntry[]; skipped: Array<{ path: string; reason: string }> } {
    const added: CodingV5FileEntry[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const p of relPaths) {
      try {
        added.push(this.add(p));
      } catch (e) {
        skipped.push({ path: p, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { added, skipped };
  }

  /** Bo mot file khoi tap (khong co thi throw). */
  drop(relPath: string): CodingV5FileEntry {
    const normalized = normalizeCodingV5RelPath(relPath);
    const entry = this.filesMap.get(normalized);
    if (!entry) {
      throw new CodingV5FileSelectionError(`File "${normalized}" khong co trong tap — khong drop duoc.`);
    }
    this.filesMap.delete(normalized);
    return entry;
  }

  /** Bo nhieu file, tra ve ket qua tung file. */
  dropMany(relPaths: string[]): { dropped: CodingV5FileEntry[]; missing: string[] } {
    const dropped: CodingV5FileEntry[] = [];
    const missing: string[] = [];
    for (const p of relPaths) {
      try {
        dropped.push(this.drop(p));
      } catch {
        missing.push(p);
      }
    }
    return { dropped, missing };
  }

  /** Xoa het file trong tap. */
  clear(): void {
    this.filesMap.clear();
  }

  /** Danh sach file (sap xep theo duong dan). */
  list(): CodingV5FileEntry[] {
    return [...this.filesMap.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  /** Thong ke tap: file, byte, token, ngan sach. */
  stats(): CodingV5FileSetStats {
    const entries = this.list();
    const totalTokens = entries.reduce((s, e) => s + e.tokens, 0);
    const totalBytes = entries.reduce((s, e) => s + e.size, 0);
    return {
      files: entries.length,
      totalBytes,
      totalTokens,
      budgetTokens: this.budgetTokens,
      overBudget: totalTokens > this.budgetTokens,
      overByTokens: Math.max(0, totalTokens - this.budgetTokens),
    };
  }

  /** Render danh sach file dang text (de hien trong chat/UI). */
  render(): string {
    const entries = this.list();
    const stats = this.stats();
    if (entries.length === 0) {
      return 'Tap file trong (chua /add file nao).';
    }
    const lines = [
      `Tap file: ${stats.files} file(s), ${stats.totalTokens}/${stats.budgetTokens} token uoc luong` +
        (stats.overBudget ? ` — VUOT ${stats.overByTokens} token!` : ''),
    ];
    for (const e of entries) {
      lines.push(`  - ${e.relPath} (~${e.tokens} token, ${e.size} bytes)`);
    }
    return lines.join('\n');
  }

  /** Serialize tap thanh JSON (de luu session). */
  serialize(): string {
    return JSON.stringify(
      { repoRoot: this.repoRoot, budgetTokens: this.budgetTokens, files: this.list() },
      null,
      2,
    );
  }

  /** Khoi phuc tap tu JSON (file phai ton tai luc add lai — bo qua file mat). */
  static deserialize(json: string): CodingV5FileSet {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new CodingV5FileSelectionError('JSON tap file khong doc duoc.');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new CodingV5FileSelectionError('JSON tap file sai dinh dang (can object).');
    }
    const obj = parsed as { repoRoot?: unknown; budgetTokens?: unknown; files?: unknown };
    if (typeof obj.repoRoot !== 'string') {
      throw new CodingV5FileSelectionError('JSON tap file thieu repoRoot.');
    }
    const set = new CodingV5FileSet(obj.repoRoot, typeof obj.budgetTokens === 'number' ? obj.budgetTokens : undefined);
    if (Array.isArray(obj.files)) {
      for (const f of obj.files) {
        if (typeof f === 'object' && f !== null && typeof (f as { relPath?: unknown }).relPath === 'string') {
          try {
            set.add((f as { relPath: string }).relPath);
          } catch {
            // File da xoa/moi — bo qua khi khoi phuc.
          }
        }
      }
    }
    return set;
  }
}

/** Chuan hoa duong dan tuong doi: `\` -> `/`, bo `./` va `/` thua. */
export function normalizeCodingV5RelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/');
}

export type CodingV5AddCommandKind = 'add' | 'drop' | 'ls-files' | 'clear' | 'suggest';

export interface CodingV5AddCommand {
  kind: CodingV5AddCommandKind;
  /** Duong dan doi voi add/drop. */
  paths: string[];
  /** Truy van doi voi suggest. */
  query?: string;
  /** Gioi han goi y (suggest). */
  limit?: number;
}

export class CodingV5CommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingV5CommandParseError';
  }
}

/**
 * Parse lenh chat `/add`, `/drop`, `/ls-files`, `/clear`,
 * `/add --suggest <query>` (co the kem `--limit n`).
 * Tach theo khoang trang, ho tro duong dan trong dau nhay kep.
 */
export function parseCodingV5FileCommand(input: string): CodingV5AddCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    throw new CodingV5CommandParseError('Lenh phai bat dau bang "/" (vd "/add src/a.ts").');
  }
  const tokens = tokenizeCodingV5Command(trimmed);
  const head = tokens[0] ?? '';
  if (head === '/ls-files') {
    if (tokens.length > 1) {
      throw new CodingV5CommandParseError('"/ls-files" khong nhan tham so.');
    }
    return { kind: 'ls-files', paths: [] };
  }
  if (head === '/clear') {
    if (tokens.length > 1) {
      throw new CodingV5CommandParseError('"/clear" khong nhan tham so.');
    }
    return { kind: 'clear', paths: [] };
  }
  if (head === '/drop') {
    const paths = tokens.slice(1);
    if (paths.length === 0) {
      throw new CodingV5CommandParseError('"/drop" can it nhat 1 duong dan (vd "/drop src/a.ts").');
    }
    return { kind: 'drop', paths };
  }
  if (head === '/add') {
    const rest = tokens.slice(1);
    if (rest.length === 0) {
      throw new CodingV5CommandParseError('"/add" can it nhat 1 duong dan hoac "--suggest <truy van>".');
    }
    if (rest[0] === '--suggest') {
      const queryTokens: string[] = [];
      let limit: number | undefined;
      for (let i = 1; i < rest.length; i++) {
        const tok = rest[i] ?? '';
        if (tok === '--limit') {
          const next = rest[i + 1];
          const n = next === undefined ? NaN : Number(next);
          if (!Number.isFinite(n) || n < 1) {
            throw new CodingV5CommandParseError('"--limit" can mot so nguyen >= 1.');
          }
          limit = Math.floor(n);
          i += 1;
        } else {
          queryTokens.push(tok);
        }
      }
      const query = queryTokens.join(' ').trim();
      if (query === '') {
        throw new CodingV5CommandParseError('"/add --suggest" can mot truy van (vd "/add --suggest auth login").');
      }
      return { kind: 'suggest', paths: [], query, limit };
    }
    return { kind: 'add', paths: rest };
  }
  throw new CodingV5CommandParseError(
    `Lenh khong ho tro: "${head}" (chi ho tro /add, /drop, /ls-files, /clear).`,
  );
}

/** Tach lenh theo khoang trang, giu nguyen phan trong dau nhay kep. */
function tokenizeCodingV5Command(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? '';
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

export interface CodingV5FileSuggestion {
  relPath: string;
  /** Diem xep hang hop nhat (0-1, cao hon = lien quan hon). */
  score: number;
  /** Diem PageRank rieng. */
  pageRankScore: number;
  /** So lan duoc tham chieu. */
  referenceCount: number;
  /** true khi file khop truc tiep truy van (seed). */
  isSeed: boolean;
  /** Ly do de xuat (de hien cho user). */
  reason: string;
}

export interface CodingV5SuggestOptions extends CodingV4RankOptions {
  limit?: number;
  /** Loai bo file da co trong tap khoi goi y. */
  excludeSelected?: Set<string>;
}

/**
 * Goi y file theo truy van qua xep hang v4 (Personalized PageRank +
 * tan suat tham chieu + do moi). Can graph + file entries cua repo
 * (lay tu store v3/v4 cua tools, hoac tu build thu cong).
 */
export function suggestCodingV5Files(
  graph: CodingV2Graph,
  files: CodingV2FileEntry[],
  query: string,
  options: CodingV5SuggestOptions = {},
): { suggestions: CodingV5FileSuggestion[]; fellBackToGlobal: boolean; seedFiles: string[] } {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
  const { ranking, seedFiles, fellBackToGlobal } = rankCodingV4FilesForQuery(graph, files, query, options);
  const referenceTotals = codingV4ReferenceTotals(graph);
  const suggestions: CodingV5FileSuggestion[] = [];
  const seedSet = new Set(seedFiles);
  for (const rank of ranking.ranks) {
    if (suggestions.length >= limit) break;
    if (options.excludeSelected?.has(rank.relPath)) continue;
    const isSeed = seedSet.has(rank.relPath);
    const referenceCount = Math.round(referenceTotals.get(rank.relPath) ?? 0);
    const reason = isSeed
      ? `Khop truy van "${query}" (ten file/symbol).`
      : `Duoc tham chieu nhieu (PageRank ${rank.pageRankScore.toFixed(3)}, ${referenceCount} luot).`;
    suggestions.push({
      relPath: rank.relPath,
      score: rank.score,
      pageRankScore: rank.pageRankScore,
      referenceCount,
      isSeed,
      reason,
    });
  }
  return { suggestions, fellBackToGlobal, seedFiles };
}

/**
 * Goi y du phong khi chua co repo map: khop ten file theo substring
 * (khong can graph). Dung khi store chua build — bao ro rang la
 * fallback de agent khong tuong la xep hang PageRank.
 */
export function suggestCodingV5FilesByName(
  files: CodingV2FileEntry[],
  query: string,
  options: { limit?: number; excludeSelected?: Set<string> } = {},
): { suggestions: CodingV5FileSuggestion[]; fellBackToNameMatch: true } {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
  const scored: Array<{ entry: CodingV2FileEntry; score: number }> = [];
  for (const entry of files) {
    if (options.excludeSelected?.has(entry.relPath)) continue;
    const lower = entry.relPath.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (lower.includes(token)) score += 1;
      const base = lower.split('/').pop() ?? '';
      if (base.includes(token)) score += 1;
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.relPath.localeCompare(b.entry.relPath));
  return {
    suggestions: scored.slice(0, limit).map(({ entry, score }) => ({
      relPath: entry.relPath,
      score: score / Math.max(1, tokens.length * 2),
      pageRankScore: 0,
      referenceCount: 0,
      isSeed: true,
      reason: `Khop ten file voi truy van "${query}" (fallback — chua co repo map).`,
    })),
    fellBackToNameMatch: true as const,
  };
}

/** Render danh sach goi y dang text. */
export function renderCodingV5Suggestions(
  suggestions: CodingV5FileSuggestion[],
  query: string,
  fellBack: boolean,
): string {
  if (suggestions.length === 0) {
    return `Khong goi y duoc file nao cho truy van "${query}".`;
  }
  const lines = [
    `Goi y ${suggestions.length} file cho "${query}"${fellBack ? ' (khong khop chinh xac — xep hang toan cuc)' : ''}:`,
  ];
  for (const s of suggestions) {
    lines.push(`  - ${s.relPath} (score ${s.score.toFixed(3)}) — ${s.reason}`);
  }
  lines.push('Dung "/add <duong dan>" de them file vao tap.');
  return lines.join('\n');
}

/** So ky tu moi token dung trong uoc luong (de test khong can import v4). */
export function codingV5CharsPerToken(): number {
  return CODING_V4_CHARS_PER_TOKEN;
}
