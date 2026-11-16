/**
 * Repo map v5 — incremental index (v1.13, Doi T3).
 *
 * Y tuong hoc tu OpenHands Repository Map (index tang dan: chi
 * re-index file doi) — chi hoc y tuong, tu thiet ke va viet lai hoan
 * toan tu dau.
 *
 * Mo rong cache tang dan cua v2/v4 (fingerprint mtimeMs + size):
 *
 *   - v2/v4 chi biet file doi theo mtime/size. mtime doi khi
 *     checkout git, touch, hay copy file — du noi dung khong doi
 *     van phai parse lai. v5 them CONTENT HASH (FNV-1a 64-bit tren
 *     noi dung file): file doi mtime nhung cung hash thi giu nguyen
 *     entry, khong parse lai; file doi that thi moi parse.
 *   - v2/v4 invalid theo file don le. v5 invalid theo PHU THUOC:
 *     file doi lam stale ca file import no (truc tiep + bac tiep
 *     theo, gioi han do sau), vi diem PageRank / call graph / tom
 *     tat cua file import phu thuoc vao symbol cua file doi. File
 *     bi xoa cung lam stale file import no (import treo).
 *   - cache v5 tren dia (JSON version 5): luu tung file record
 *     (fingerprint + content hash + so symbol + import), ke ca
 *     do thi phu thuoc dao (importers) de lan sau chi can doc cache
 *     la biet file nao anh huong, khong can quet lai source.
 *
 * Module nay thuan tuy (khong fs, khong crypto cua Node — hash
 * FNV-1a tu viet tren string UTF-16, du nhanh cho muc dich phat
 * hien thay doi; khong phai hash bao mat). Lop fs song o
 * `packages/tools/src/codingV5RepoMap.ts`.
 *
 * Gioi han trung thuc:
 *   - FNV-1a 64-bit (BigInt) chi de phat hien thay doi, khong chong
 *     va cham co chu dich; va cham thuc te khong dang ke voi kich
 *     thuoc file code.
 *   - invalid theo phu thuoc chi xet import tinh + re-export (khong
 *     xet import dong, khong xet goi ham xuyen file qua ten — goi
 *     ham duoc tinh lai o buoc build do thi sau do).
 *   - hash tinh tren noi dung doc duoc; file doc loi thi coi nhu
 *     doi (hash '').
 */

import type { CodingV2FileEntry } from '../codingV2/repoMapGraph';

/** Version cua dinh dang cache index v5 tren dia. */
export const CODING_V5_INDEX_CACHE_VERSION = 5;
/** Do sau toi da lan invalid theo phu thuoc (0 = chi file doi). */
export const CODING_V5_DEFAULT_INVALIDATION_DEPTH = 3;
/** Offset basis FNV-1a 64-bit. */
export const CODING_V5_FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
/** Prime FNV-1a 64-bit. */
export const CODING_V5_FNV_PRIME = 0x100000001b3n;
/** Mask 64-bit. */
const FNV_MASK = 0xffffffffffffffffn;

// ---------------------------------------------------------------------------
// Content hash (FNV-1a 64-bit, tu viet)
// ---------------------------------------------------------------------------

/**
 * Hash FNV-1a 64-bit cua mot string, tra hex 16 ky tu (lowercase).
 * Rong -> hash cua chuoi rong (co dinh). Dung de phat hien file doi
 * noi dung that, ke ca khi mtime doi ma noi dung giong nhau.
 */
export function codingV5ContentHash(content: string): string {
  let hash = CODING_V5_FNV_OFFSET_BASIS;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= BigInt(content.charCodeAt(i));
    hash = (hash * CODING_V5_FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Hash cua nhieu chunk noi lien (tien ich cho file doc theo doan). */
export function codingV5ContentHashOfParts(parts: string[]): string {
  return codingV5ContentHash(parts.join(''));
}

// ---------------------------------------------------------------------------
// Record + cache tren dia
// ---------------------------------------------------------------------------

/** Fingerprint nhe cua mot file (giong v2/v4). */
export interface CodingV5Fingerprint {
  relPath: string;
  mtimeMs: number;
  size: number;
}

/** Mot ban ghi trong index v5. */
export interface CodingV5IndexRecord {
  relPath: string;
  mtimeMs: number;
  size: number;
  /** Hash noi dung (FNV-1a hex). '' khi chua tinh. */
  contentHash: string;
  /** So symbol entry v2 da parse duoc. */
  symbols: number;
  /** File trong repo ma file nay import truc tiep (da resolve). */
  imports: string[];
  /** Co loi cu phap nhung van parse duoc phan nao (entry v2). */
  hasError: boolean;
}

/** Dinh dang cache index v5 tren dia. */
export interface CodingV5IndexCacheFile {
  version: number;
  rootDir: string;
  updatedAt: string;
  files: number;
  records: Record<string, CodingV5IndexRecord>;
  /** Do thi phu thuoc dao: file -> file import no (de invalid nhanh). */
  importers: Record<string, string[]>;
}

/** Dung mot record tu entry v2 + hash noi dung + import da resolve. */
export function codingV5RecordOf(
  entry: CodingV2FileEntry,
  contentHash: string,
): CodingV5IndexRecord {
  return {
    relPath: entry.relPath,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    contentHash,
    symbols: entry.symbols.length,
    imports: [...entry.imports].sort(),
    hasError: entry.hasError,
  };
}

/** Fingerprint cua mot record (de so sanh nhanh voi file tren dia). */
export function codingV5FingerprintOfRecord(record: CodingV5IndexRecord): CodingV5Fingerprint {
  return { relPath: record.relPath, mtimeMs: record.mtimeMs, size: record.size };
}

/** Dung do thi phu thuoc dao tu cac record (file -> file import no). */
export function buildCodingV5Importers(
  records: Map<string, CodingV5IndexRecord> | Record<string, CodingV5IndexRecord>,
): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  const list = records instanceof Map ? [...records.values()] : Object.values(records);
  for (const record of list) {
    if (!importers.has(record.relPath)) importers.set(record.relPath, []);
    for (const target of record.imports) {
      const cur = importers.get(target) ?? [];
      if (!cur.includes(record.relPath)) cur.push(record.relPath);
      importers.set(target, cur);
    }
  }
  for (const arr of importers.values()) arr.sort();
  return importers;
}

/** Serialize cache index v5 (key file sap xep cho diff on dinh). */
export function serializeCodingV5IndexCache(cache: CodingV5IndexCacheFile): string {
  const sortedRecords: Record<string, CodingV5IndexRecord> = {};
  for (const key of Object.keys(cache.records).sort()) sortedRecords[key] = cache.records[key]!;
  const sortedImporters: Record<string, string[]> = {};
  for (const key of Object.keys(cache.importers).sort()) {
    sortedImporters[key] = [...(cache.importers[key] ?? [])].sort();
  }
  return `${JSON.stringify({ ...cache, records: sortedRecords, importers: sortedImporters }, null, 2)}\n`;
}

/**
 * Parse cache index v5. Tra `{ error }` khi version khac, rootDir
 * khac, hoac thieu truong — caller build lai thay vi crash (giong
 * v2/v3/v4).
 */
export function parseCodingV5IndexCache(
  text: string,
  expectedRootDir: string,
): { cache: CodingV5IndexCacheFile } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    return { error: `cache index v5 JSON hong: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'cache index v5 khong phai object JSON' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CODING_V5_INDEX_CACHE_VERSION) {
    return { error: `cache index v5 version ${String(obj.version)} khac ${CODING_V5_INDEX_CACHE_VERSION}, build lai` };
  }
  if (typeof obj.rootDir !== 'string' || obj.rootDir !== expectedRootDir) {
    return { error: 'cache index v5 thuoc workspace khac, build lai' };
  }
  if (!obj.records || typeof obj.records !== 'object' || Array.isArray(obj.records)) {
    return { error: 'cache index v5 thieu records' };
  }
  if (!obj.importers || typeof obj.importers !== 'object' || Array.isArray(obj.importers)) {
    return { error: 'cache index v5 thieu importers' };
  }
  const records: Record<string, CodingV5IndexRecord> = {};
  for (const [relPath, raw] of Object.entries(obj.records as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.relPath !== 'string' ||
      r.relPath !== relPath ||
      typeof r.mtimeMs !== 'number' ||
      typeof r.size !== 'number' ||
      typeof r.contentHash !== 'string' ||
      typeof r.symbols !== 'number' ||
      !Array.isArray(r.imports)
    ) {
      continue;
    }
    records[relPath] = {
      relPath,
      mtimeMs: r.mtimeMs,
      size: r.size,
      contentHash: r.contentHash,
      symbols: r.symbols,
      imports: (r.imports as unknown[]).filter((i): i is string => typeof i === 'string'),
      hasError: r.hasError === true,
    };
  }
  const importers: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(obj.importers as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    importers[key] = raw.filter((i): i is string => typeof i === 'string');
  }
  return {
    cache: {
      version: CODING_V5_INDEX_CACHE_VERSION,
      rootDir: expectedRootDir,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
      files: typeof obj.files === 'number' ? obj.files : Object.keys(records).length,
      records,
      importers,
    },
  };
}

/** Dung cache index v5 tu cac record hien tai (de ghi dia). */
export function buildCodingV5IndexCacheFile(
  rootDir: string,
  records: Map<string, CodingV5IndexRecord> | Record<string, CodingV5IndexRecord>,
): CodingV5IndexCacheFile {
  const asRecord: Record<string, CodingV5IndexRecord> = records instanceof Map
    ? Object.fromEntries(records)
    : { ...records };
  const importers = buildCodingV5Importers(asRecord);
  return {
    version: CODING_V5_INDEX_CACHE_VERSION,
    rootDir,
    updatedAt: new Date().toISOString(),
    files: Object.keys(asRecord).length,
    records: asRecord,
    importers: Object.fromEntries(importers),
  };
}

// ---------------------------------------------------------------------------
// Ke hoach tang dan + invalid theo phu thuoc
// ---------------------------------------------------------------------------

/** Ket qua phan loai tang dan v5 (mo rong plan v2/v4). */
export interface CodingV5IncrementalPlan {
  /** File khong doi gi (mtime/size/hash giong cache). */
  unchanged: string[];
  /** File doi mtime/size nhung cung content hash (chi cap nhat fingerprint, khong parse lai). */
  metadataOnly: string[];
  /** File doi noi dung that (can parse lai). */
  changed: string[];
  /** File moi. */
  added: string[];
  /** File da xoa. */
  removed: string[];
  /** File khong doi nhung bi invalid vi phu thuoc vao file doi/xoa (can tinh lai diem/tom tat, khong can parse lai symbol). */
  invalidatedByDependency: string[];
  /** Tong so file can xu ly (changed + added + removed + invalidatedByDependency). */
  invalidatedCount: number;
  /** true khi co bat ky thay doi nao. */
  needsRebuild: boolean;
}

export interface CodingV5PlanInput {
  /** Fingerprint hien tai tren dia (relPath -> fingerprint). */
  current: Map<string, CodingV5Fingerprint> | Record<string, CodingV5Fingerprint>;
  /** Content hash hien tai (relPath -> hash). Thieu hash = coi nhu doi khi mtime/size doi. */
  contentHashes?: Map<string, string> | Record<string, string>;
  /** Cache cu (record theo file). */
  previous: Map<string, CodingV5IndexRecord> | Record<string, CodingV5IndexRecord>;
  /** Do thi phu thuoc dao cu (file -> file import no). Neu khong truyen thi dung tu `previous`. */
  importers?: Map<string, string[]> | Record<string, string[]>;
  /** Do sau lan invalid theo phu thuoc (mac dinh 3). */
  invalidationDepth?: number;
}

function asMap<T>(v: Map<string, T> | Record<string, T>): Map<string, T> {
  return v instanceof Map ? v : new Map(Object.entries(v));
}

/**
 * Phan loai file theo cache cu + fingerprint/hash hien tai, roi lan
 * invalid theo phu thuoc: file doi/xoa lam stale file import no
 * (truc tiep o do sau 1, gian tiep toi `invalidationDepth`).
 *
 * Thu tu uu tien cua mot file: removed > added > changed >
 * metadataOnly > invalidatedByDependency > unchanged.
 */
export function planCodingV5Incremental(input: CodingV5PlanInput): CodingV5IncrementalPlan {
  const current = asMap(input.current);
  const hashes = input.contentHashes ? asMap(input.contentHashes) : new Map<string, string>();
  const previous = asMap(input.previous);
  const importers = input.importers
    ? asMap(input.importers)
    : buildCodingV5Importers(previous);
  const depth = Math.max(0, Math.floor(input.invalidationDepth ?? CODING_V5_DEFAULT_INVALIDATION_DEPTH));

  const unchanged: string[] = [];
  const metadataOnly: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [relPath, fp] of current) {
    const old = previous.get(relPath);
    if (!old) {
      added.push(relPath);
      continue;
    }
    if (old.mtimeMs === fp.mtimeMs && old.size === fp.size) {
      unchanged.push(relPath);
      continue;
    }
    // mtime/size doi: so hash noi dung (neu co) de phan biet doi that
    // voi chi doi metadata (checkout/touch).
    const newHash = hashes.get(relPath);
    if (newHash !== undefined && old.contentHash !== '' && newHash === old.contentHash) {
      metadataOnly.push(relPath);
    } else {
      changed.push(relPath);
    }
  }
  for (const relPath of previous.keys()) {
    if (!current.has(relPath)) removed.push(relPath);
  }

  // Lan invalid theo phu thuoc tu file doi + file xoa.
  const invalidated = new Set<string>();
  const seeds = [...changed, ...removed];
  let frontier = [...seeds];
  for (let d = 0; d < depth && frontier.length > 0; d += 1) {
    const next: string[] = [];
    for (const seed of frontier) {
      for (const importer of importers.get(seed) ?? []) {
        if (changed.includes(importer) || added.includes(importer) || removed.includes(importer)) continue;
        if (invalidated.has(importer)) continue;
        if (!current.has(importer)) continue; // importer da xoa.
        invalidated.add(importer);
        next.push(importer);
      }
    }
    frontier = next;
  }
  const invalidatedByDependency = [...invalidated].sort();
  const invalidatedCount =
    changed.length + added.length + removed.length + invalidatedByDependency.length;
  return {
    unchanged: unchanged.sort(),
    metadataOnly: metadataOnly.sort(),
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    invalidatedByDependency,
    invalidatedCount,
    needsRebuild: invalidatedCount > 0 || metadataOnly.length > 0,
  };
}

/**
 * Kiem tra cache index v5 con tuoi khong: so record trong cache voi
 * fingerprint hien tai tren dia. Tra plan (needsRebuild = false
 * nghia la cache dung duoc nguyen).
 */
export function checkCodingV5IndexFreshness(
  cache: CodingV5IndexCacheFile,
  currentFiles: CodingV2FileEntry[],
  contentHashes?: Map<string, string>,
): CodingV5IncrementalPlan {
  const current = new Map<string, CodingV5Fingerprint>();
  for (const file of currentFiles) {
    current.set(file.relPath, { relPath: file.relPath, mtimeMs: file.mtimeMs, size: file.size });
  }
  return planCodingV5Incremental({
    current,
    contentHashes,
    previous: cache.records,
    importers: cache.importers,
  });
}

/** Gop record moi vao cache cu: bo file xoa, cap nhat file doi/moi + metadata-only. */
export function mergeCodingV5Records(
  previous: Map<string, CodingV5IndexRecord>,
  fresh: CodingV5IndexRecord[],
  removed: string[],
  metadataOnlyUpdates: CodingV5Fingerprint[] = [],
): Map<string, CodingV5IndexRecord> {
  const next = new Map(previous);
  for (const relPath of removed) next.delete(relPath);
  for (const record of fresh) next.set(record.relPath, record);
  for (const fp of metadataOnlyUpdates) {
    const old = next.get(fp.relPath);
    if (old) next.set(fp.relPath, { ...old, mtimeMs: fp.mtimeMs, size: fp.size });
  }
  return next;
}

/** Thong ke nhanh cua index (dung cho tool status). */
export function summarizeCodingV5Index(
  cache: CodingV5IndexCacheFile,
): { files: number; symbols: number; imports: number; hasErrorFiles: number; updatedAt: string } {
  let symbols = 0;
  let imports = 0;
  let hasErrorFiles = 0;
  for (const record of Object.values(cache.records)) {
    symbols += record.symbols;
    imports += record.imports.length;
    if (record.hasError) hasErrorFiles += 1;
  }
  return { files: cache.files, symbols, imports, hasErrorFiles, updatedAt: cache.updatedAt };
}
