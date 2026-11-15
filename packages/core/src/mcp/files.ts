/**
 * Files extension — bản nháp `io.modelcontextprotocol/files` (v1.10, Team T2).
 *
 * MCP spec 2026-07-28 đưa file bytes ra ngoài model: thay vì nhét nội
 * dung file vào context (tốn token, vỡ giới hạn), client/server trao
 * đổi file bằng chunk base64 qua các method `files/*`, kèm metadata
 * (tên, kích thước, sha256, mime). Extension này vẫn là bản nháp
 * (đăng 2026-11-10, mục tiêu ổn định cuối 2026) nên module này giữ
 * đúng phần lõi ổn định — upload/download chunked + metadata + giới
 * hạn — và ghi rõ mọi chỗ bản nháp còn có thể đổi (tên method, shape
 * metadata) để nâng cấp sau không vỡ code gọi.
 *
 * Thiết kế:
 *   - `McpFilesStore`: store file trên đĩa, giới hạn trong một root
 *     dir của workspace (`.open-bot/mcp-files/`). Mọi đường dẫn đều
 *     đi qua containment check có realpath (kiểu `resolveWithin`):
 *     `fileId` chỉ là `file-<16 hex của sha256>` nên không thể mang
 *     `../` hay symlink escape; tên file upload cũng bị chặn ký tự
 *     phân tách đường dẫn.
 *   - Upload chia chunk tuần tự: `beginUpload` → `writeChunk`
 *     (index phải đúng thứ tự, chunk ≤ 1 MiB) → `completeUpload`
 *     (ghép file, tính sha256, ghi metadata). Upload dở được
 *     `abortUpload`; upload quá hạn (TTL) được dọn bởi `pruneStaleUploads`.
 *   - Download phân trang theo byte: `downloadChunk(fileId, offset,
 *     length)` trả base64 + `eof`; offset/length được clamp về trong
 *     file, không bao giờ đọc ngoài file.
 *   - `createMcpFilesMethodHandler(store)`: dispatcher JSON-RPC cho
 *     các method `files/*` — host (server MCP nội bộ) chỉ cần nối
 *     vào dispatch của mình; dispatcher tự validate params và trả
 *     lỗi rõ ràng thay vì throw.
 *
 * Giới hạn mặc định: file tối đa 10 MiB, chunk tối đa 1 MiB, tối đa
 * 500 file trong store (file cũ nhất theo mtime bị prune). Không gọi
 * model, không chạm mạng. Ideas only — không copy code/text/tài sản
 * của bất kỳ MCP implementation hay SDK nào.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Tên extension Files (bản nháp, đăng 2026-11-10). */
export const MCP_FILES_EXTENSION = 'io.modelcontextprotocol/files';

/** Phiên bản draft của Files extension mà module này implement. */
export const MCP_FILES_SPEC_VERSION = '2026-11-10-draft';

/** File lớn nhất store nhận (mặc định 10 MiB). */
export const MCP_FILES_DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Một chunk upload/download lớn nhất (mặc định 1 MiB). */
export const MCP_FILES_DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;
/** Số file tối đa giữ trong store (vượt thì prune file cũ nhất). */
export const MCP_FILES_DEFAULT_MAX_FILES = 500;
/** Upload dở quá hạn này thì bị dọn (mặc định 30 phút). */
export const MCP_FILES_DEFAULT_UPLOAD_TTL_MS = 30 * 60_000;

/** Lỗi của Files extension (kèm mã để caller phân loại). */
export class McpFilesError extends Error {
  readonly code: string;
  constructor(message: string, code = 'files_error') {
    super(message);
    this.name = 'McpFilesError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict base64 check: Node's Buffer.from is lenient (ignores junk chars) — compare the round-trip. */
export function isValidBase64(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return true;
  if (/[^A-Za-z0-9+/=\s]/.test(value)) return false;
  try {
    const buf = Buffer.from(value, 'base64');
    return buf.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '').replace(/\s/g, '');
  } catch {
    return false;
  }
}
const FILE_ID_RE = /^file-[0-9a-f]{16}$/;
/** Upload id nội bộ: `upl-<16 hex ngẫu nhiên>`. */
const UPLOAD_ID_RE = /^upl-[0-9a-f]{16}$/;
/** Tên file an toàn: không chứa `/`, `\`, NUL, không phải `.`/`..`. */
const FILE_NAME_RE = /^[^\u0000-\u001f/\\]+$/;

export function isValidFileId(fileId: unknown): fileId is string {
  return typeof fileId === 'string' && FILE_ID_RE.test(fileId);
}

export function isValidUploadId(uploadId: unknown): uploadId is string {
  return typeof uploadId === 'string' && UPLOAD_ID_RE.test(uploadId);
}

/** True khi tên file upload được chấp nhận (không mang path traversal). */
export function isValidFileName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('..')) return false;
  return FILE_NAME_RE.test(name);
}

/** Metadata một file trong store (trả qua `files/info` / `files/list`). */
export interface McpFileMetadata {
  fileId: string;
  /** Tên gốc lúc upload (chỉ để hiển thị — file trên đĩa dùng fileId). */
  name: string;
  sizeBytes: number;
  sha256Hex: string;
  mimeType: string;
  createdAtMs: number;
  /** Số chunk đã upload để tạo file này. */
  chunks: number;
}

/** Một chunk download (`files/download`). */
export interface McpFileChunk {
  fileId: string;
  /** Dữ liệu chunk, base64. */
  dataBase64: string;
  /** Offset byte chunk này bắt đầu. */
  offset: number;
  /** Số byte thực tế trong chunk. */
  length: number;
  /** Tổng số byte của file. */
  totalBytes: number;
  /** True khi chunk này tới cuối file. */
  eof: boolean;
}

/** Trạng thái một upload đang dở. */
export interface McpUploadState {
  uploadId: string;
  name: string;
  mimeType: string;
  /** Tổng byte kỳ vọng (khi client khai báo trước). */
  totalBytes?: number;
  /** Byte đã nhận tới nay. */
  receivedBytes: number;
  /** Chunk tiếp theo phải có index này (tuần tự, không nhảy). */
  nextIndex: number;
  createdAtMs: number;
}

/** Tuỳ chọn cho `McpFilesStore`. */
export interface McpFilesStoreOptions {
  maxFileBytes?: number;
  maxChunkBytes?: number;
  maxFiles?: number;
  uploadTtlMs?: number;
  /** Đồng hồ tiêm vào (test dùng đồng hồ giả). */
  now?: () => number;
  /** Sinh id ngẫu nhiên (test tiêm seed ổn định). */
  randomId?: () => string;
}

function defaultRandomId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Resolve `target` trong `root` và NÉM khi thoát ra ngoài — kể cả qua
 * symlink (realpath phần tồn tại dài nhất rồi nối phần đuôi, giống
 * `resolveWithin` bên tools). Dùng cho mọi đường dẫn file/upload.
 */
export function resolveFilesPath(rootDir: string, target: string): string {
  const rootReal = fs.realpathSync(path.resolve(rootDir));
  const joined = path.resolve(rootReal, target);
  let existing = joined;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const realExisting = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  const resolved = tail.length > 0 ? path.join(realExisting, ...tail) : realExisting;
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    throw new McpFilesError(
      `Files: đường dẫn "${target}" thoát khỏi files root.`,
      'path_traversal',
    );
  }
  return resolved;
}

function fileIdForContent(sha256Hex: string): string {
  return `file-${sha256Hex.slice(0, 16)}`;
}

function metaPath(rootDir: string, fileId: string): string {
  return path.join(rootDir, `${fileId}.meta.json`);
}

function dataPath(rootDir: string, fileId: string): string {
  return path.join(rootDir, fileId);
}

function uploadsDir(rootDir: string): string {
  return path.join(rootDir, '.uploads');
}

function uploadDir(rootDir: string, uploadId: string): string {
  return path.join(uploadsDir(rootDir), uploadId);
}

/** Đoán mime từ đuôi tên file (đủ dùng cho metadata; không sniff nội dung). */
export function guessMimeType(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  switch (ext) {
    case 'txt':
    case 'md':
    case 'csv':
      return 'text/plain';
    case 'json':
      return 'application/json';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'pdf':
      return 'application/pdf';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Store file cho Files extension: disk-backed, workspace-confined,
 * giới hạn kích thước + số file, metadata JSON đi kèm mỗi file.
 * Mọi method đều đồng bộ (fs) — caller async bọc ngoài khi cần.
 */
export class McpFilesStore {
  readonly rootDir: string;
  readonly maxFileBytes: number;
  readonly maxChunkBytes: number;
  readonly maxFiles: number;
  readonly uploadTtlMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(rootDir: string, options: McpFilesStoreOptions = {}) {
    this.rootDir = path.resolve(rootDir);
    this.maxFileBytes = options.maxFileBytes ?? MCP_FILES_DEFAULT_MAX_FILE_BYTES;
    this.maxChunkBytes = options.maxChunkBytes ?? MCP_FILES_DEFAULT_MAX_CHUNK_BYTES;
    this.maxFiles = options.maxFiles ?? MCP_FILES_DEFAULT_MAX_FILES;
    this.uploadTtlMs = options.uploadTtlMs ?? MCP_FILES_DEFAULT_UPLOAD_TTL_MS;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? defaultRandomId;
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(uploadsDir(this.rootDir), { recursive: true });
  }

  // -- upload: begin / chunk / complete / abort ----------------------------

  /**
   * Bắt đầu một upload: trả `uploadId` + kích thước chunk tối đa.
   * `totalBytes` (khi có) phải ≤ giới hạn file — khai sai thì lỗi ngay
   * thay vì nhận chunk rồi mới vỡ ở cuối.
   */
  beginUpload(options: {
    name: string;
    mimeType?: string;
    totalBytes?: number;
  }): { uploadId: string; chunkSizeBytes: number } {
    if (!isValidFileName(options.name)) {
      throw new McpFilesError(
        `Files: tên file không hợp lệ: ${JSON.stringify(options.name)}`,
        'invalid_name',
      );
    }
    if (
      options.totalBytes !== undefined &&
      (!Number.isInteger(options.totalBytes) ||
        options.totalBytes < 0 ||
        options.totalBytes > this.maxFileBytes)
    ) {
      throw new McpFilesError(
        `Files: totalBytes phải là số nguyên 0..${this.maxFileBytes}, nhận ${String(options.totalBytes)}`,
        'invalid_size',
      );
    }
    const uploadId = `upl-${this.randomId()}`;
    const dir = uploadDir(this.rootDir, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    const state: McpUploadState = {
      uploadId,
      name: options.name,
      mimeType: options.mimeType ?? guessMimeType(options.name),
      ...(options.totalBytes !== undefined ? { totalBytes: options.totalBytes } : {}),
      receivedBytes: 0,
      nextIndex: 0,
      createdAtMs: this.now(),
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state), 'utf8');
    return { uploadId, chunkSizeBytes: this.maxChunkBytes };
  }

  private readUploadState(uploadId: string): McpUploadState {
    if (!isValidUploadId(uploadId)) {
      throw new McpFilesError(`Files: uploadId không hợp lệ: ${JSON.stringify(uploadId)}`, 'invalid_upload');
    }
    const dir = uploadDir(this.rootDir, uploadId);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    } catch {
      throw new McpFilesError(`Files: không có upload "${uploadId}" (hết hạn hoặc chưa begin).`, 'unknown_upload');
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed['name'] !== 'string') {
      throw new McpFilesError(`Files: state upload "${uploadId}" hỏng.`, 'corrupt_upload');
    }
    return parsed as unknown as McpUploadState;
  }

  private writeUploadState(state: McpUploadState): void {
    const dir = uploadDir(this.rootDir, state.uploadId);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state), 'utf8');
  }

  /**
   * Nhận một chunk (base64). Chunk phải đúng thứ tự (`index` phải bằng
   * `nextIndex` — chunk trùng/lệch bị từ chối thay vì ghi đè lặng) và
   * không vượt quá giới hạn chunk/file. Trả số byte đã nhận tới nay.
   */
  writeChunk(uploadId: string, index: number, dataBase64: string): { receivedBytes: number; nextIndex: number } {
    const state = this.readUploadState(uploadId);
    if (!Number.isInteger(index) || index < 0) {
      throw new McpFilesError(`Files: chunk index phải là số nguyên >= 0, nhận ${String(index)}`, 'invalid_chunk');
    }
    if (index !== state.nextIndex) {
      throw new McpFilesError(
        `Files: chunk index ${index} lệch thứ tự — upload "${uploadId}" đang chờ index ${state.nextIndex}`,
        'out_of_order_chunk',
      );
    }
    if (typeof dataBase64 !== 'string') {
      throw new McpFilesError('Files: chunk data phải là chuỗi base64.', 'invalid_chunk');
    }
    if (!isValidBase64(dataBase64)) {
      throw new McpFilesError('Files: chunk data không phải base64 hợp lệ.', 'invalid_chunk');
    }
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length > this.maxChunkBytes) {
      throw new McpFilesError(
        `Files: chunk ${buf.length} bytes vượt giới hạn ${this.maxChunkBytes} bytes.`,
        'chunk_too_large',
      );
    }
    if (state.receivedBytes + buf.length > this.maxFileBytes) {
      throw new McpFilesError(
        `Files: upload vượt giới hạn file ${this.maxFileBytes} bytes.`,
        'file_too_large',
      );
    }
    if (state.totalBytes !== undefined && state.receivedBytes + buf.length > state.totalBytes) {
      throw new McpFilesError(
        `Files: upload vượt totalBytes đã khai (${state.totalBytes}).`,
        'file_too_large',
      );
    }
    const dir = uploadDir(this.rootDir, uploadId);
    fs.writeFileSync(path.join(dir, `chunk-${index}`), buf);
    state.receivedBytes += buf.length;
    state.nextIndex += 1;
    this.writeUploadState(state);
    return { receivedBytes: state.receivedBytes, nextIndex: state.nextIndex };
  }

  /**
   * Hoàn tất upload: ghép các chunk theo thứ tự, tính sha256, ghi
   * file + metadata. Khi `totalBytes` đã khai mà nhận thiếu → lỗi,
   * không tạo file nửa vời. File id suy từ sha256 (trùng nội dung =
   * cùng id — upload lại chỉ ghi đè metadata).
   */
  completeUpload(uploadId: string): McpFileMetadata {
    const state = this.readUploadState(uploadId);
    if (state.totalBytes !== undefined && state.receivedBytes !== state.totalBytes) {
      throw new McpFilesError(
        `Files: upload "${uploadId}" thiếu byte (nhận ${state.receivedBytes}/${state.totalBytes}).`,
        'incomplete_upload',
      );
    }
    const dir = uploadDir(this.rootDir, uploadId);
    const hash = crypto.createHash('sha256');
    const parts: Buffer[] = [];
    for (let i = 0; i < state.nextIndex; i += 1) {
      const chunk = fs.readFileSync(path.join(dir, `chunk-${i}`));
      hash.update(chunk);
      parts.push(chunk);
    }
    const content = Buffer.concat(parts);
    const sha256Hex = hash.digest('hex');
    const fileId = fileIdForContent(sha256Hex);
    const target = dataPath(this.rootDir, fileId);
    // Containment: fileId đã validate bằng regex nên target luôn trong
    // root, nhưng vẫn đi qua resolveFilesPath để bắt symlink ở root.
    resolveFilesPath(this.rootDir, fileId);
    fs.writeFileSync(target, content);
    const meta: McpFileMetadata = {
      fileId,
      name: state.name,
      sizeBytes: content.length,
      sha256Hex,
      mimeType: state.mimeType,
      createdAtMs: this.now(),
      chunks: state.nextIndex,
    };
    fs.writeFileSync(metaPath(this.rootDir, fileId), JSON.stringify(meta, null, 2), 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    this.pruneOldestFiles();
    return meta;
  }

  /** Huỷ upload dở (xoá thư mục tạm). Trả false khi upload không còn. */
  abortUpload(uploadId: string): boolean {
    if (!isValidUploadId(uploadId)) return false;
    const dir = uploadDir(this.rootDir, uploadId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Dọn các upload quá TTL (mặc định 30 phút). Trả số upload đã dọn. */
  pruneStaleUploads(): number {
    const base = uploadsDir(this.rootDir);
    let removed = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      try {
        const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
        const state = JSON.parse(raw) as McpUploadState;
        if (this.now() - state.createdAtMs > this.uploadTtlMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // state hỏng → coi như upload dở, dọn luôn cho sạch.
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          removed += 1;
        } catch {
          // bỏ qua
        }
      }
    }
    return removed;
  }

  // -- tiện ích một lần: upload/download trọn file ---------------------------

  /** Upload trọn file từ base64 (tự chia chunk trong nội bộ). */
  uploadBytes(name: string, dataBase64: string, mimeType?: string): McpFileMetadata {
    // Validate chuỗi gốc TRƯỚC khi decode: Buffer.from lenient sẽ
    // lặng lẽ bỏ ký tự rác, nên phải check strict ở đây (writeChunk
    // chỉ thấy base64 đã re-encode, không phát hiện được input hỏng).
    if (!isValidBase64(dataBase64)) {
      throw new McpFilesError('Files: data không phải base64 hợp lệ.', 'invalid_chunk');
    }
    const buf = Buffer.from(dataBase64, 'base64');
    const { uploadId } = this.beginUpload({ name, mimeType, totalBytes: buf.length });
    let offset = 0;
    let index = 0;
    while (offset < buf.length) {
      const end = Math.min(buf.length, offset + this.maxChunkBytes);
      this.writeChunk(uploadId, index, buf.subarray(offset, end).toString('base64'));
      offset = end;
      index += 1;
    }
    return this.completeUpload(uploadId);
  }

  /** Download trọn file về base64 (file ≤ giới hạn nên vừa bộ nhớ). */
  downloadBytes(fileId: string): { dataBase64: string; metadata: McpFileMetadata } {
    const metadata = this.getFile(fileId);
    // Page theo maxChunkBytes (downloadChunk clamp mỗi lần đọc về
    // tối đa một chunk) rồi ghép lại — không đọc một lần vượt giới hạn.
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < metadata.sizeBytes) {
      const chunk = this.downloadChunk(fileId, offset, metadata.sizeBytes - offset);
      parts.push(Buffer.from(chunk.dataBase64, 'base64'));
      offset += chunk.length;
      if (chunk.length === 0) break;
    }
    return { dataBase64: Buffer.concat(parts).toString('base64'), metadata };
  }

  // -- đọc / liệt kê / xoá ----------------------------------------------------

  /** Metadata một file. Ném khi fileId sai định dạng hoặc không có file. */
  getFile(fileId: string): McpFileMetadata {
    if (!isValidFileId(fileId)) {
      throw new McpFilesError(`Files: fileId không hợp lệ: ${JSON.stringify(fileId)}`, 'invalid_file_id');
    }
    resolveFilesPath(this.rootDir, fileId);
    let raw: string;
    try {
      raw = fs.readFileSync(metaPath(this.rootDir, fileId), 'utf8');
    } catch {
      throw new McpFilesError(`Files: không có file "${fileId}".`, 'unknown_file');
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed['fileId'] !== fileId) {
      throw new McpFilesError(`Files: metadata của "${fileId}" hỏng.`, 'corrupt_file');
    }
    return parsed as unknown as McpFileMetadata;
  }

  /**
   * Đọc một chunk theo byte: `offset`/`length` được clamp về trong
   * file (offset ngoài file → lỗi; length vượt cuối file → cắt tới
   * cuối). Không bao giờ đọc ngoài file.
   */
  downloadChunk(fileId: string, offset: number, length: number): McpFileChunk {
    const meta = this.getFile(fileId);
    if (!Number.isInteger(offset) || offset < 0 || offset > meta.sizeBytes) {
      throw new McpFilesError(
        `Files: offset phải là số nguyên 0..${meta.sizeBytes}, nhận ${String(offset)}`,
        'invalid_range',
      );
    }
    if (!Number.isInteger(length) || length < 0) {
      throw new McpFilesError(`Files: length phải là số nguyên >= 0, nhận ${String(length)}`, 'invalid_range');
    }
    const take = Math.min(length, this.maxChunkBytes, meta.sizeBytes - offset);
    const fd = fs.openSync(dataPath(this.rootDir, fileId), 'r');
    try {
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, offset);
      return {
        fileId,
        dataBase64: buf.toString('base64'),
        offset,
        length: take,
        totalBytes: meta.sizeBytes,
        eof: offset + take >= meta.sizeBytes,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Liệt kê file trong store (mới nhất trước). */
  listFiles(): McpFileMetadata[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: McpFileMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue;
      const fileId = entry.name.slice(0, -'.meta.json'.length);
      try {
        out.push(this.getFile(fileId));
      } catch {
        // metadata hỏng → bỏ qua, không làm vỡ cả danh sách.
      }
    }
    out.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return out;
  }

  /** Xoá file + metadata. Trả false khi file không có. */
  deleteFile(fileId: string): boolean {
    if (!isValidFileId(fileId)) return false;
    try {
      resolveFilesPath(this.rootDir, fileId);
    } catch {
      return false;
    }
    let existed = false;
    for (const target of [dataPath(this.rootDir, fileId), metaPath(this.rootDir, fileId)]) {
      try {
        fs.unlinkSync(target);
        existed = true;
      } catch {
        // đã không có thì thôi
      }
    }
    return existed;
  }

  /** Giữ tối đa `maxFiles` file — prune file cũ nhất theo createdAtMs. */
  private pruneOldestFiles(): void {
    const files = this.listFiles();
    if (files.length <= this.maxFiles) return;
    const sorted = [...files].sort((a, b) => a.createdAtMs - b.createdAtMs);
    for (const meta of sorted.slice(0, files.length - this.maxFiles)) {
      this.deleteFile(meta.fileId);
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher JSON-RPC cho các method files/* (host nối vào server của mình)
// ---------------------------------------------------------------------------

/** Kết quả dispatch: `{ ok: true, result }` hoặc `{ ok: false, error }`. */
export type McpFilesDispatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: number; message: string } };

const JSON_RPC_INVALID_PARAMS = -32602;

/**
 * Dispatcher cho Files extension: nhận `{ method, params }` thô và
 * trả kết quả / lỗi JSON-RPC. Các method (draft 2026-11-10):
 *   - `files/upload/begin` { name, mimeType?, totalBytes? }
 *   - `files/upload/chunk` { uploadId, index, dataBase64 }
 *   - `files/upload/complete` { uploadId }
 *   - `files/upload/abort` { uploadId }
 *   - `files/download` { fileId, offset?, length? }
 *   - `files/info` { fileId }
 *   - `files/list` {}
 *   - `files/delete` { fileId }
 * Dispatcher không throw — lỗi nào cũng thành `{ ok: false, error }`.
 */
export function createMcpFilesMethodHandler(
  store: McpFilesStore,
): (method: string, params: Record<string, unknown>) => McpFilesDispatchResult {
  const fail = (message: string): McpFilesDispatchResult => ({
    ok: false,
    error: { code: JSON_RPC_INVALID_PARAMS, message },
  });
  const requireString = (params: Record<string, unknown>, field: string): string | null => {
    const value = params[field];
    return typeof value === 'string' ? value : null;
  };
  const requireInt = (params: Record<string, unknown>, field: string): number | null => {
    const value = params[field];
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  };

  return (method: string, params: Record<string, unknown>): McpFilesDispatchResult => {
    try {
      switch (method) {
        case 'files/upload/begin': {
          const name = requireString(params, 'name');
          if (!name) return fail('files/upload/begin cần { name: string }.');
          const mimeType = requireString(params, 'mimeType') ?? undefined;
          const totalBytes = requireInt(params, 'totalBytes') ?? undefined;
          return { ok: true, result: store.beginUpload({ name, ...(mimeType ? { mimeType } : {}), ...(totalBytes !== undefined ? { totalBytes } : {}) }) };
        }
        case 'files/upload/chunk': {
          const uploadId = requireString(params, 'uploadId');
          const index = requireInt(params, 'index');
          const dataBase64 = requireString(params, 'dataBase64');
          if (!uploadId || index === null || dataBase64 === null) {
            return fail('files/upload/chunk cần { uploadId: string, index: number, dataBase64: string }.');
          }
          return { ok: true, result: store.writeChunk(uploadId, index, dataBase64) };
        }
        case 'files/upload/complete': {
          const uploadId = requireString(params, 'uploadId');
          if (!uploadId) return fail('files/upload/complete cần { uploadId: string }.');
          return { ok: true, result: store.completeUpload(uploadId) };
        }
        case 'files/upload/abort': {
          const uploadId = requireString(params, 'uploadId');
          if (!uploadId) return fail('files/upload/abort cần { uploadId: string }.');
          return { ok: true, result: { aborted: store.abortUpload(uploadId) } };
        }
        case 'files/download': {
          const fileId = requireString(params, 'fileId');
          if (!fileId) return fail('files/download cần { fileId: string }.');
          const offset = requireInt(params, 'offset') ?? 0;
          const length = requireInt(params, 'length') ?? store.maxChunkBytes;
          return { ok: true, result: store.downloadChunk(fileId, offset, length) };
        }
        case 'files/info': {
          const fileId = requireString(params, 'fileId');
          if (!fileId) return fail('files/info cần { fileId: string }.');
          return { ok: true, result: store.getFile(fileId) };
        }
        case 'files/list': {
          return { ok: true, result: { files: store.listFiles() } };
        }
        case 'files/delete': {
          const fileId = requireString(params, 'fileId');
          if (!fileId) return fail('files/delete cần { fileId: string }.');
          return { ok: true, result: { deleted: store.deleteFile(fileId) } };
        }
        default:
          return {
            ok: false,
            error: { code: -32601, message: `Method "${method}" không thuộc Files extension ${MCP_FILES_SPEC_VERSION}.` },
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof McpFilesError ? JSON_RPC_INVALID_PARAMS : -32603;
      return { ok: false, error: { code, message } };
    }
  };
}

/** Tất cả method của Files extension draft (cho capability advertisement). */
export const MCP_FILES_METHODS: readonly string[] = [
  'files/upload/begin',
  'files/upload/chunk',
  'files/upload/complete',
  'files/upload/abort',
  'files/download',
  'files/info',
  'files/list',
  'files/delete',
];
