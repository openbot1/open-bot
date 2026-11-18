/**
 * Memory v21 — MemFS-style format (git-backed memory blocks).
 *
 * Y tuong hoc tu Letta git-backed memory / MemFS: memory la cay
 * file trong git — moi block mot file, manifest theo doi hash +
 * version, xoa thi ghi tombstone chu khong xoa lich su. Tu thiet
 * ke lai hoan toan cho open-bot, KHONG copy code/text/tai san cua
 * bat ky repo nao.
 *
 * Layout trong thu muc store:
 *   blocks/<id>.md        — file block (header comment + body)
 *   manifest.json         — id -> {path, hash, version, updatedAt}
 *   tombstones/<id>.json  — tombstone khi xoa
 *   history.jsonl         — lich su append-only (mot dong/ thay doi)
 *
 * Khong goi git CLI: "git-backed" o day nghia la file nam trong
 * repo git cua user de ho commit/review — store chi quan ly file
 * + hash, khong tu dong commit. Moi thao tac tra ket qua co cau
 * truc, khong throw (tru loi IO bat ngo truyen len caller).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { V21MemfsBlock, V21PortableRecord, V21Result, V21Tombstone } from './types';
import { hashContentV21, slugifyV21 } from './okfFormat';

export const V21_MEMFS_BLOCKS_DIR = 'blocks';
export const V21_MEMFS_MANIFEST_FILE = 'manifest.json';
export const V21_MEMFS_TOMBSTONES_DIR = 'tombstones';
export const V21_MEMFS_HISTORY_FILE = 'history.jsonl';

export interface V21MemfsManifestEntry {
  path: string;
  hash: string;
  version: number;
  updatedAt: number;
}

export type V21MemfsManifest = Record<string, V21MemfsManifestEntry>;

export interface V21MemfsHistoryEntry {
  at: number;
  by: string;
  action: 'create' | 'update' | 'delete' | 'restore' | 'import';
  recordId: string;
  version: number;
  hash: string;
  summary: string;
}

export interface V21MemfsIntegrityIssue {
  id: string;
  kind: 'hash_mismatch' | 'missing_file' | 'orphan_file' | 'manifest_missing';
  detail: string;
}

/** Header block file: `<!-- memfs:id=... version=... hash=... -->`. */
export function memfsBlockHeaderV21(block: V21MemfsBlock): string {
  return `<!-- memfs:id=${block.id} version=${block.version} hash=${block.hash} updatedAt=${block.updatedAt} -->`;
}

export function parseMemfsBlockHeaderV21(
  text: string,
): V21Result<{ id: string; version: number; hash: string; updatedAt: number; body: string }> {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const m = firstLine.match(/^<!-- memfs:id=(\S+) version=(\d+) hash=([0-9a-f]{64}) updatedAt=(\d+) -->$/);
  if (!m) {
    return { ok: false, error: 'thieu header MemFS hop le o dong dau file block', errorCode: 'missing_file' };
  }
  const body = text.split('\n').slice(1).join('\n').trim();
  return {
    ok: true,
    data: { id: m[1], version: Number(m[2]), hash: m[3], updatedAt: Number(m[4]), body },
  };
}

export function memfsBlockToTextV21(block: V21MemfsBlock): string {
  return `${memfsBlockHeaderV21(block)}\n\n${block.body}\n`;
}

export function recordToMemfsBlockV21(
  record: V21PortableRecord,
): V21MemfsBlock {
  const body = record.body;
  return {
    id: record.id,
    // Duong dan theo id (on dinh) — khong theo title vi title doi
    // duoc; `readBlock`/`blockPath` cung dung slug(id).
    path: `${V21_MEMFS_BLOCKS_DIR}/${slugifyV21(record.id)}.md`,
    title: record.title,
    body,
    hash: hashContentV21(body),
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

export function memfsBlockToRecordV21(
  block: V21MemfsBlock,
  now = Date.now(),
): V21PortableRecord {
  return {
    id: block.id,
    type: 'note',
    title: block.title || block.id,
    body: block.body,
    tags: [],
    sources: [],
    codeRefs: [],
    version: block.version,
    createdAt: block.updatedAt,
    updatedAt: block.updatedAt,
    originFormat: 'memfs',
    originPath: block.path,
  };
}

function readJsonFileV21<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFileV21(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Store MemFS tren dia — doc/ghi file + manifest + tombstone. */
export class V21MemfsStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Tao cay thu muc + manifest rong neu chua co. */
  init(): void {
    mkdirSync(join(this.dir, V21_MEMFS_BLOCKS_DIR), { recursive: true });
    mkdirSync(join(this.dir, V21_MEMFS_TOMBSTONES_DIR), { recursive: true });
    if (!existsSync(join(this.dir, V21_MEMFS_MANIFEST_FILE))) {
      writeJsonFileV21(join(this.dir, V21_MEMFS_MANIFEST_FILE), {});
    }
    if (!existsSync(join(this.dir, V21_MEMFS_HISTORY_FILE))) {
      writeFileSync(join(this.dir, V21_MEMFS_HISTORY_FILE), '', 'utf8');
    }
  }

  manifestPath(): string {
    return join(this.dir, V21_MEMFS_MANIFEST_FILE);
  }

  readManifest(): V21MemfsManifest {
    return readJsonFileV21<V21MemfsManifest>(this.manifestPath(), {});
  }

  private writeManifest(manifest: V21MemfsManifest): void {
    writeJsonFileV21(this.manifestPath(), manifest);
  }

  private appendHistory(entry: V21MemfsHistoryEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    try {
      const current = existsSync(join(this.dir, V21_MEMFS_HISTORY_FILE))
        ? readFileSync(join(this.dir, V21_MEMFS_HISTORY_FILE), 'utf8')
        : '';
      writeFileSync(join(this.dir, V21_MEMFS_HISTORY_FILE), current + line, 'utf8');
    } catch {
      // Lich su la phu tro — loi ghi log khong lam hong thao tac chinh.
    }
  }

  readHistory(): V21MemfsHistoryEntry[] {
    const path = join(this.dir, V21_MEMFS_HISTORY_FILE);
    if (!existsSync(path)) return [];
    const out: V21MemfsHistoryEntry[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as V21MemfsHistoryEntry);
      } catch {
        // Bo dong hong, giu cac dong tot.
      }
    }
    return out;
  }

  blockPath(id: string): string {
    return join(this.dir, V21_MEMFS_BLOCKS_DIR, `${slugifyV21(id)}.md`);
  }

  tombstonePath(id: string): string {
    return join(this.dir, V21_MEMFS_TOMBSTONES_DIR, `${slugifyV21(id)}.json`);
  }

  /** Ghi (tao moi hoac cap nhat) mot block tu record. */
  writeBlock(record: V21PortableRecord, by = 'system'): V21Result<V21MemfsBlock> {
    this.init();
    const manifest = this.readManifest();
    const existing = manifest[record.id];
    const version = existing ? existing.version + 1 : 1;
    const block: V21MemfsBlock = {
      ...recordToMemfsBlockV21({ ...record, version }),
      version,
    };
    const fullPath = join(this.dir, block.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, memfsBlockToTextV21(block), 'utf8');
    manifest[record.id] = { path: block.path, hash: block.hash, version, updatedAt: block.updatedAt };
    this.writeManifest(manifest);
    this.appendHistory({
      at: Date.now(),
      by,
      action: existing ? 'update' : 'create',
      recordId: record.id,
      version,
      hash: block.hash,
      summary: existing ? `cap nhat block ${record.id} len v${version}` : `tao block ${record.id} v${version}`,
    });
    return { ok: true, data: block };
  }

  readBlock(id: string): V21Result<V21MemfsBlock> {
    const path = this.blockPath(id);
    if (!existsSync(path)) return { ok: false, error: `khong tim thay block "${id}"`, errorCode: 'missing_file' };
    const parsed = parseMemfsBlockHeaderV21(readFileSync(path, 'utf8'));
    if (!parsed.ok || !parsed.data) return { ok: false, error: parsed.error, errorCode: parsed.errorCode };
    const title = parsed.data.body.split('\n')[0]?.replace(/^#\s+/, '').trim() || id;
    return {
      ok: true,
      data: {
        id: parsed.data.id,
        path: `${V21_MEMFS_BLOCKS_DIR}/${basename(path)}`,
        title,
        body: parsed.data.body,
        hash: parsed.data.hash,
        version: parsed.data.version,
        updatedAt: parsed.data.updatedAt,
      },
    };
  }

  listBlocks(): V21MemfsBlock[] {
    const manifest = this.readManifest();
    const out: V21MemfsBlock[] = [];
    for (const id of Object.keys(manifest).sort()) {
      const read = this.readBlock(id);
      if (read.ok && read.data) out.push(read.data);
    }
    return out;
  }

  /** Xoa block: xoa file + ghi tombstone JSON (khong mat dau vet). */
  deleteBlock(id: string, by: string, reason: string): V21Result<V21Tombstone> {
    const read = this.readBlock(id);
    if (!read.ok || !read.data) return { ok: false, error: read.error, errorCode: read.errorCode };
    if (!reason || reason.trim().length < 3) {
      return { ok: false, error: 'can ly do xoa (toi thieu 3 ky tu)', errorCode: 'invalid_args' };
    }
    const block = read.data;
    const manifest = this.readManifest();
    const tombstone: V21Tombstone = {
      recordId: id,
      format: 'memfs',
      originalPath: block.path,
      previousVersion: block.version,
      previousHash: block.hash,
      snapshot: memfsBlockToRecordV21(block),
      deletedAt: Date.now(),
      deletedBy: by,
      reason: reason.trim(),
    };
    writeJsonFileV21(this.tombstonePath(id), tombstone);
    try {
      rmSync(this.blockPath(id));
    } catch {
      // File da mat truoc do — tombstone van la ban ghi xoa hop le.
    }
    delete manifest[id];
    this.writeManifest(manifest);
    this.appendHistory({
      at: tombstone.deletedAt,
      by,
      action: 'delete',
      recordId: id,
      version: block.version,
      hash: block.hash,
      summary: `xoa block ${id} (tombstone, ly do: ${reason.trim()})`,
    });
    return { ok: true, data: tombstone };
  }

  readTombstone(id: string): V21Result<V21Tombstone> {
    const path = this.tombstonePath(id);
    if (!existsSync(path)) return { ok: false, error: `khong co tombstone cho "${id}"`, errorCode: 'missing_file' };
    try {
      return { ok: true, data: JSON.parse(readFileSync(path, 'utf8')) as V21Tombstone };
    } catch {
      return { ok: false, error: `tombstone "${id}" hong dinh dang JSON`, errorCode: 'yaml_error' };
    }
  }

  listTombstones(): V21Tombstone[] {
    const dir = join(this.dir, V21_MEMFS_TOMBSTONES_DIR);
    if (!existsSync(dir)) return [];
    const out: V21Tombstone[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.json')) continue;
      const read = this.readTombstone(file.replace(/\.json$/, ''));
      if (read.ok && read.data) out.push(read.data);
    }
    return out;
  }

  /** Khoi phuc block tu tombstone (tao version moi, lich su con nguyen). */
  restoreBlock(id: string, by = 'system'): V21Result<V21MemfsBlock> {
    const tomb = this.readTombstone(id);
    if (!tomb.ok || !tomb.data) return { ok: false, error: tomb.error, errorCode: tomb.errorCode };
    if (!tomb.data.snapshot) {
      return { ok: false, error: `tombstone "${id}" khong con snapshot — da bi purge`, errorCode: 'missing_file' };
    }
    const record: V21PortableRecord = { ...tomb.data.snapshot, version: tomb.data.previousVersion, updatedAt: Date.now() };
    const written = this.writeBlock(record, by);
    if (!written.ok || !written.data) return written;
    this.appendHistory({
      at: Date.now(),
      by,
      action: 'restore',
      recordId: id,
      version: written.data.version,
      hash: written.data.hash,
      summary: `khoi phuc block ${id} tu tombstone`,
    });
    return written;
  }

  /**
   * Kiem tra toan ven: hash lai moi file block, doi chieu manifest,
   * bao file thua (co file nhung khong co trong manifest) va file
   * thieu (co trong manifest nhung mat file).
   */
  verifyIntegrity(): V21MemfsIntegrityIssue[] {
    const issues: V21MemfsIntegrityIssue[] = [];
    const manifest = this.readManifest();
    const blocksDir = join(this.dir, V21_MEMFS_BLOCKS_DIR);
    const onDisk = new Set<string>();
    if (existsSync(blocksDir)) {
      for (const file of readdirSync(blocksDir)) {
        if (file.endsWith('.md')) onDisk.add(file.replace(/\.md$/, ''));
      }
    }
    for (const [id, entry] of Object.entries(manifest)) {
      const path = join(this.dir, entry.path);
      if (!existsSync(path)) {
        issues.push({ id, kind: 'missing_file', detail: `manifest co "${id}" nhung mat file ${entry.path}` });
        continue;
      }
      const parsed = parseMemfsBlockHeaderV21(readFileSync(path, 'utf8'));
      if (!parsed.ok || !parsed.data) {
        issues.push({ id, kind: 'hash_mismatch', detail: `block "${id}" hong header: ${parsed.error ?? ''}` });
        continue;
      }
      const actualHash = hashContentV21(parsed.data.body);
      if (actualHash !== entry.hash || actualHash !== parsed.data.hash) {
        issues.push({ id, kind: 'hash_mismatch', detail: `block "${id}" hash khong khop manifest (file da bi sua ngoai store)` });
      }
      if (parsed.data.version !== entry.version) {
        issues.push({ id, kind: 'hash_mismatch', detail: `block "${id}" version header (${parsed.data.version}) khac manifest (${entry.version})` });
      }
    }
    for (const id of onDisk) {
      if (!manifest[id]) {
        issues.push({ id, kind: 'orphan_file', detail: `file blocks/${id}.md ton tai nhung khong co trong manifest` });
      }
    }
    if (!existsSync(this.manifestPath())) {
      issues.push({ id: '', kind: 'manifest_missing', detail: 'thieu manifest.json' });
    }
    return issues;
  }

  /** Duong dan thay doi so voi anh chup manifest truoc (goi y commit git). */
  changedPathsSince(snapshot: V21MemfsManifest): string[] {
    const current = this.readManifest();
    const changed = new Set<string>();
    for (const [id, entry] of Object.entries(current)) {
      const old = snapshot[id];
      if (!old || old.hash !== entry.hash || old.version !== entry.version) changed.add(entry.path);
    }
    for (const [id, entry] of Object.entries(snapshot)) {
      if (!current[id]) changed.add(entry.path);
    }
    return [...changed].sort();
  }
}

/** Import mot block file MemFS (doc lap, khong can store). */
export function parseMemfsFileV21(
  text: string,
  path: string,
  now = Date.now(),
): V21Result<V21PortableRecord> {
  const parsed = parseMemfsBlockHeaderV21(text);
  if (!parsed.ok || !parsed.data) return { ok: false, error: parsed.error, errorCode: parsed.errorCode };
  const actualHash = hashContentV21(parsed.data.body);
  if (actualHash !== parsed.data.hash) {
    return { ok: false, error: `block ${parsed.data.id}: hash khong khop (file co the da bi sua)`, errorCode: 'hash_mismatch' };
  }
  const block: V21MemfsBlock = {
    id: parsed.data.id,
    path,
    title: parsed.data.body.split('\n')[0]?.replace(/^#\s+/, '').trim() || parsed.data.id,
    body: parsed.data.body,
    hash: parsed.data.hash,
    version: parsed.data.version,
    updatedAt: parsed.data.updatedAt,
  };
  const record = memfsBlockToRecordV21(block, now);
  return { ok: true, data: record };
}

/** Duong dan tuong doi chuan trong store (dung tren moi OS). */
export function memfsRelativePathV21(absPath: string, storeDir: string): string {
  return relative(storeDir, absPath).split(sep).join('/');
}
