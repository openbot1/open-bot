/**
 * Discovery models-dir + preset (v1.16, Doi T3).
 *
 * Y tuong (llama.cpp router-mode `--models-dir` / `--models-preset`):
 * quet thu muc tim file GGUF, doc header GGUF that de lay metadata
 * (ten, kien truc, context, so block, KV head) thay vi doan tu ten
 * file; preset INI per-model nam rieng trong presets.ts.
 *
 * Chi doc file local; khong tai gi, khong goi mang. Header GGUF parse
 * phong thu: file hong / khong phai GGUF -> validMagic=false, metadata
 * null, van giu lai muc (de UI bao "file khong hop le" thay vi mat hut).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_PER_MODEL_FLAGS, type DiscoveredModel, type GgufModelFile, type PerModelFlags } from './types';
import { estimateFootprint } from './resourceEstimator';

/** Magic GGUF (4 byte dau, little-endian 0x46554747 = "GGUF"). */
export const GGUF_MAGIC = 0x46554747;

/** So byte header toi da doc de parse metadata (du cho hang tram kv). */
export const GGUF_HEADER_READ_BYTES = 256 * 1024;

/** Do sau de quy toi da khi quet models-dir. */
export const MAX_SCAN_DEPTH = 3;

/** Metadata rut ra tu header GGUF. */
export interface GgufMetadata {
  ggufVersion: number;
  name?: string;
  architecture?: string;
  contextLength?: number;
  blockCount?: number;
  kvHeadCount?: number;
  headCount?: number;
  embeddingLength?: number;
}

/** Kieu gia tri metadata GGUF (spec GGUF). */
const GGUF_VALUE_TYPES = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

/** Kich thuoc (byte) cua tung kieu vo dinh trong GGUF. */
const FIXED_TYPE_SIZES: Record<number, number> = {
  [GGUF_VALUE_TYPES.UINT8]: 1,
  [GGUF_VALUE_TYPES.INT8]: 1,
  [GGUF_VALUE_TYPES.UINT16]: 2,
  [GGUF_VALUE_TYPES.INT16]: 2,
  [GGUF_VALUE_TYPES.UINT32]: 4,
  [GGUF_VALUE_TYPES.INT32]: 4,
  [GGUF_VALUE_TYPES.FLOAT32]: 4,
  [GGUF_VALUE_TYPES.BOOL]: 1,
  [GGUF_VALUE_TYPES.UINT64]: 8,
  [GGUF_VALUE_TYPES.INT64]: 8,
  [GGUF_VALUE_TYPES.FLOAT64]: 8,
};

/**
 * Doc mot chuoi GGUF: uint64 do dai + byte UTF-8.
 * Tra { value, nextOffset } hoac null khi vuot gioi han buffer.
 */
function readGgufString(buf: Buffer, offset: number): { value: string; nextOffset: number } | null {
  if (offset + 8 > buf.length) return null;
  const len = Number(buf.readBigUInt64LE(offset));
  if (!Number.isSafeInteger(len) || len > 10_000 || offset + 8 + len > buf.length) return null;
  return { value: buf.toString('utf8', offset + 8, offset + 8 + len), nextOffset: offset + 8 + len };
}

/**
 * Doc mot gia tri metadata tai offset; tra { value, nextOffset } hoac
 * null khi kieu khong biet / vuot buffer. Chi ho tro kieu vo dinh +
 * string + array (array chi doc de bo qua dung kich thuoc).
 */
function readGgufValue(
  buf: Buffer,
  offset: number,
  valueType: number,
): { value: unknown; nextOffset: number } | null {
  if (valueType === GGUF_VALUE_TYPES.STRING) {
    return readGgufString(buf, offset);
  }
  if (valueType === GGUF_VALUE_TYPES.ARRAY) {
    if (offset + 8 > buf.length) return null;
    const elemType = buf.readUInt32LE(offset);
    const count = Number(buf.readBigUInt64LE(offset + 4));
    if (!Number.isSafeInteger(count) || count > 100_000) return null;
    let cur = offset + 12;
    if (elemType === GGUF_VALUE_TYPES.STRING) {
      for (let i = 0; i < count; i++) {
        const s = readGgufString(buf, cur);
        if (!s) return null;
        cur = s.nextOffset;
      }
      return { value: undefined, nextOffset: cur };
    }
    const size = FIXED_TYPE_SIZES[elemType];
    if (size === undefined || cur + count * size > buf.length) return null;
    return { value: undefined, nextOffset: cur + count * size };
  }
  const size = FIXED_TYPE_SIZES[valueType];
  if (size === undefined || offset + size > buf.length) return null;
  let value: unknown;
  switch (valueType) {
    case GGUF_VALUE_TYPES.UINT8:
      value = buf.readUInt8(offset);
      break;
    case GGUF_VALUE_TYPES.INT8:
      value = buf.readInt8(offset);
      break;
    case GGUF_VALUE_TYPES.UINT16:
      value = buf.readUInt16LE(offset);
      break;
    case GGUF_VALUE_TYPES.INT16:
      value = buf.readInt16LE(offset);
      break;
    case GGUF_VALUE_TYPES.UINT32:
      value = buf.readUInt32LE(offset);
      break;
    case GGUF_VALUE_TYPES.INT32:
      value = buf.readInt32LE(offset);
      break;
    case GGUF_VALUE_TYPES.FLOAT32:
      value = buf.readFloatLE(offset);
      break;
    case GGUF_VALUE_TYPES.BOOL:
      value = buf.readUInt8(offset) !== 0;
      break;
    case GGUF_VALUE_TYPES.UINT64:
      value = Number(buf.readBigUInt64LE(offset));
      break;
    case GGUF_VALUE_TYPES.INT64:
      value = Number(buf.readBigInt64LE(offset));
      break;
    case GGUF_VALUE_TYPES.FLOAT64:
      value = buf.readDoubleLE(offset);
      break;
    default:
      return null;
  }
  return { value, nextOffset: offset + size };
}

/**
 * Parse header GGUF tu buffer (da doc toi da GGUF_HEADER_READ_BYTES).
 * Tra metadata khi magic hop le; null khi khong phai GGUF / header hong.
 * Chi giu nhung key can cho router; key khac van phai doc de bo qua
 * dung kich thuoc (neu khong offset se lech).
 */
export function parseGgufHeader(buf: Buffer): GgufMetadata | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32LE(0) !== GGUF_MAGIC) return null;
  const version = buf.readUInt32LE(4);
  if (version !== 2 && version !== 3) return null;
  // v2: tensor_count uint32 + kv_count uint32; v3: ca hai uint64.
  let offset: number;
  let kvCount: number;
  if (version === 2) {
    kvCount = buf.readUInt32LE(12);
    offset = 16;
  } else {
    kvCount = Number(buf.readBigUInt64LE(16));
    offset = 24;
  }
  if (!Number.isSafeInteger(kvCount) || kvCount > 100_000) return null;
  const meta: GgufMetadata = { ggufVersion: version };
  for (let i = 0; i < kvCount; i++) {
    const keyRes = readGgufString(buf, offset);
    if (!keyRes) return null;
    offset = keyRes.nextOffset;
    if (offset + 4 > buf.length) return null;
    const valueType = buf.readUInt32LE(offset);
    offset += 4;
    const valRes = readGgufValue(buf, offset, valueType);
    if (!valRes) return null;
    offset = valRes.nextOffset;
    const v = valRes.value;
    switch (keyRes.value) {
      case 'general.name':
        if (typeof v === 'string') meta.name = v;
        break;
      case 'general.architecture':
        if (typeof v === 'string') meta.architecture = v;
        break;
      case 'llama.context_length':
      case 'qwen2.context_length':
      case 'gemma.context_length':
        if (typeof v === 'number') meta.contextLength = v;
        break;
      case 'llama.block_count':
      case 'qwen2.block_count':
      case 'gemma.block_count':
        if (typeof v === 'number') meta.blockCount = v;
        break;
      case 'llama.attention.head_count_kv':
      case 'qwen2.attention.head_count_kv':
      case 'gemma.attention.head_count_kv':
        if (typeof v === 'number') meta.kvHeadCount = v;
        break;
      case 'llama.attention.head_count':
      case 'qwen2.attention.head_count':
        if (typeof v === 'number') meta.headCount = v;
        break;
      case 'llama.embedding_length':
      case 'qwen2.embedding_length':
      case 'gemma.embedding_length':
        if (typeof v === 'number') meta.embeddingLength = v;
        break;
      default:
        break;
    }
  }
  return meta;
}

/** Doc metadata GGUF tu file that (chi doc phan dau file). */
export function readGgufMetadata(filePath: string): GgufMetadata | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const toRead = Math.min(GGUF_HEADER_READ_BYTES, stat.size);
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, 0);
      return parseGgufHeader(buf);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Id on dinh tu ten file: bo .gguf, chu thuong, khoang trang -> '-'. */
export function modelIdFromFileName(fileName: string): string {
  const base = fileName.replace(/\.gguf$/i, '');
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Kiem tra nhanh mot file co phai GGUF khong (chi doc 4 byte dau). */
export function hasGgufMagic(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const n = fs.readSync(fd, buf, 0, 4, 0);
      return n === 4 && buf.readUInt32LE(0) === GGUF_MAGIC;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Quet de quy mot thu muc tim file .gguf (gioi han do sau + so file). */
export function scanModelsDir(
  dir: string,
  opts: { maxDepth?: number; maxFiles?: number; readMetadata?: boolean } = {},
): GgufModelFile[] {
  const maxDepth = opts.maxDepth ?? MAX_SCAN_DEPTH;
  const maxFiles = opts.maxFiles ?? 500;
  const readMetadata = opts.readMetadata ?? true;
  const found: GgufModelFile[] = [];
  const walk = (current: string, depth: number): void => {
    if (found.length >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        const meta = readMetadata ? readGgufMetadata(full) : null;
        const discoveredAt = Date.now();
        const headDim =
          meta?.embeddingLength && meta?.headCount
            ? Math.floor(meta.embeddingLength / meta.headCount)
            : undefined;
        found.push({
          id: modelIdFromFileName(entry.name),
          fileName: entry.name,
          absolutePath: full,
          sizeBytes: size,
          validMagic: meta !== null,
          ggufVersion: meta?.ggufVersion ?? null,
          metadataName: meta?.name,
          architecture: meta?.architecture,
          metadataContextLength: meta?.contextLength,
          blockCount: meta?.blockCount,
          kvHeadCount: meta?.kvHeadCount,
          headDim,
          discoveredAt,
        });
      }
    }
  };
  walk(dir, 0);
  found.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return found;
}

/** Quet nhieu models-dir, dedupe theo duong dan tuyet doi. */
export function scanModelsDirs(dirs: string[], opts?: { maxDepth?: number; maxFiles?: number }): GgufModelFile[] {
  const seen = new Set<string>();
  const all: GgufModelFile[] = [];
  for (const dir of dirs) {
    for (const file of scanModelsDir(dir, opts)) {
      if (seen.has(file.absolutePath)) continue;
      seen.add(file.absolutePath);
      all.push(file);
    }
  }
  all.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return all;
}

/**
 * Gop file GGUF + preset thanh DiscoveredModel, tinh footprint.
 * `presetFor` tra preset khop model id (neu co); `flagsOverride` la
 * override cua user (uu tien cao nhat).
 */
export function buildDiscoveredModel(
  file: GgufModelFile,
  presetFor?: (modelId: string) => import('./types').ModelPreset | undefined,
  flagsOverride?: Partial<PerModelFlags>,
): DiscoveredModel {
  const preset = presetFor?.(file.id);
  const merged: PerModelFlags = {
    ...DEFAULT_PER_MODEL_FLAGS,
    ...(preset?.flags ?? {}),
    ...(flagsOverride ?? {}),
    sampler: {
      ...DEFAULT_PER_MODEL_FLAGS.sampler,
      ...(preset?.sampler ?? {}),
      ...(flagsOverride?.sampler ?? {}),
    },
    extraArgs: [...(preset?.extraArgs ?? [])],
  };
  if (flagsOverride?.extraArgs) {
    merged.extraArgs = [...(preset?.extraArgs ?? []), ...flagsOverride.extraArgs];
  }
  // Context trong metadata GGUF la tran tren that cua model.
  if (file.metadataContextLength && merged.contextSize > file.metadataContextLength) {
    merged.contextSize = file.metadataContextLength;
  }
  const { totalBytes, kvBytes } = estimateFootprint(file, merged);
  return {
    file,
    preset,
    effectiveFlags: merged,
    estimatedFootprintBytes: totalBytes,
    estimatedKvBytes: kvBytes,
  };
}
