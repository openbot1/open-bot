/**
 * Uoc tinh tai nguyen RAM/VRAM that (v1.16, Doi T3).
 *
 * Y tuong (llama.cpp router-mode: `--models-max` dem model la chua du,
 * phai set theo VRAM that; KV cache 8k ctx ~ 1.15 GB):
 * - Footprint mot model = kich thuoc GGUF + KV cache (tinh tu so
 *   layer x KV head x head-dim x context x byte/element theo kieu KV)
 *   + overhead runtime co dinh.
 * - RAM he thong doc tu `os` that; VRAM doc tu `nvidia-smi` neu co
 *   (injectable runner de test; khong co GPU -> null, khong doan).
 * - ResourceBudget: tra loi "model nay co vua khong" truoc khi load,
 *   dua tren RAM/VRAM CON LAI that, khong chi dem so model.
 */

import * as os from 'node:os';
import { execFile } from 'node:child_process';

import type { GgufModelFile, KvCacheType, PerModelFlags, ResourceSnapshot } from './types';

/** Byte moi phan tu theo kieu KV cache. */
export const KV_BYTES_PER_ELEMENT: Record<KvCacheType, number> = {
  f16: 2,
  q8_0: 1,
  q4_0: 0.5,
};

/** Overhead runtime co dinh moi model (llama-server + overhead, byte). */
export const RUNTIME_OVERHEAD_BYTES = 256 * 1024 * 1024;

/** So layer mac dinh khi metadata khong co block_count. */
export const DEFAULT_BLOCK_COUNT = 32;

/** So KV head mac dinh khi metadata khong co. */
export const DEFAULT_KV_HEAD_COUNT = 8;

/** Head-dim mac dinh khi metadata khong co. */
export const DEFAULT_HEAD_DIM = 128;

/** Ket qua uoc tinh footprint. */
export interface FootprintEstimate {
  /** Tong byte can de load (GGUF + KV + overhead). */
  totalBytes: number;
  /** KV cache (byte). */
  kvBytes: number;
  /** Phan GGUF (byte). */
  weightsBytes: number;
}

/**
 * Tinh KV cache: 2 (K + V) x layers x kvHeads x headDim x context
 * x byte/element. Cong thuc chuan cua llama.cpp (kv cache per token).
 */
export function estimateKvCacheBytes(
  contextSize: number,
  kvCacheType: KvCacheType,
  blockCount: number,
  kvHeadCount: number,
  headDim: number,
): number {
  const perElement = KV_BYTES_PER_ELEMENT[kvCacheType] ?? 2;
  return Math.ceil(2 * blockCount * kvHeadCount * headDim * contextSize * perElement);
}

/**
 * Uoc tinh footprint day du mot model tu file GGUF + flags hieu luc.
 * Khi metadata thieu, dung gia tri mac dinh va ghi ro trong ket qua
 * (caller co the hien "uoc tinh" trong UI).
 */
export function estimateFootprint(
  file: GgufModelFile,
  flags: PerModelFlags,
): FootprintEstimate {
  const kvBytes = estimateKvCacheBytes(
    flags.contextSize,
    flags.kvCacheType,
    file.blockCount ?? DEFAULT_BLOCK_COUNT,
    file.kvHeadCount ?? DEFAULT_KV_HEAD_COUNT,
    file.headDim ?? DEFAULT_HEAD_DIM,
  );
  const weightsBytes = file.sizeBytes;
  return { totalBytes: weightsBytes + kvBytes + RUNTIME_OVERHEAD_BYTES, kvBytes, weightsBytes };
}

/** Kieu runner de doc VRAM (injectable de test, mac dinh chay nvidia-smi). */
export type VramRunner = (binary: string, args: string[]) => Promise<{ stdout: string; code: number | null }>;

function defaultVramRunner(binary: string, args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      resolve({
        stdout: stdout ?? '',
        code: !error ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null,
      });
    });
  });
}

/**
 * Parse output `nvidia-smi --query-gpu=memory.total,memory.free
 * --format=csv,noheader,nounits` (MiB moi dong, lay GPU dau tien).
 * Tra null khi parse khong duoc.
 */
export function parseNvidiaSmiOutput(stdout: string): { totalBytes: number; freeBytes: number } | null {
  const firstLine = stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  const parts = firstLine.split(',').map((p) => p.trim());
  if (parts.length < 2) return null;
  const totalMib = Number(parts[0]);
  const freeMib = Number(parts[1]);
  if (!Number.isFinite(totalMib) || !Number.isFinite(freeMib) || totalMib <= 0 || freeMib < 0) return null;
  return { totalBytes: Math.floor(totalMib * 1024 * 1024), freeBytes: Math.floor(freeMib * 1024 * 1024) };
}

/** Doc VRAM qua nvidia-smi (null = khong co GPU / khong co cong cu). */
export async function readVram(runner: VramRunner = defaultVramRunner): Promise<{ totalBytes: number; freeBytes: number } | null> {
  try {
    const res = await runner('nvidia-smi', [
      '--query-gpu=memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ]);
    if (res.code !== 0) return null;
    return parseNvidiaSmiOutput(res.stdout);
  } catch {
    return null;
  }
}

/** Doc RAM he thong that (injectable de test). */
export type SystemRamReader = () => { totalBytes: number; freeBytes: number };

export function defaultSystemRamReader(): { totalBytes: number; freeBytes: number } {
  return { totalBytes: os.totalmem(), freeBytes: os.freemem() };
}

/** Lay snapshot tai nguyen that (RAM + VRAM neu do duoc). */
export async function snapshotResources(opts?: {
  readRam?: SystemRamReader;
  readVram?: () => Promise<{ totalBytes: number; freeBytes: number } | null>;
}): Promise<ResourceSnapshot> {
  const ram = (opts?.readRam ?? defaultSystemRamReader)();
  const vram = await (opts?.readVram ?? (() => readVram()))();
  return {
    totalRamBytes: ram.totalBytes,
    freeRamBytes: ram.freeBytes,
    totalVramBytes: vram?.totalBytes ?? null,
    freeVramBytes: vram?.freeBytes ?? null,
    vramSource: vram ? 'nvidia-smi' : 'unavailable',
    takenAt: Date.now(),
  };
}

/**
 * ResourceBudget — quyet dinh "co load duoc model nay khong" dua tren
 * RAM/VRAM CON LAI that + gioi han cau hinh (maxRamBytes / maxVramBytes).
 *
 * - `usedByModelsBytes`: tong footprint cac model dang loaded.
 * - `reservedBytes`: RAM giu lai cho he thong (mac dinh 10% RAM tong).
 * - Khi khong do duoc VRAM, chi kiem tra RAM (khong doan VRAM).
 */
export class ResourceBudget {
  private readonly readRam: SystemRamReader;
  private readonly maxRamBytes: number;
  private readonly maxVramBytes: number;
  private readonly reservedBytes: number;

  constructor(opts?: {
    readRam?: SystemRamReader;
    maxRamBytes?: number;
    maxVramBytes?: number;
    reservedBytes?: number;
  }) {
    this.readRam = opts?.readRam ?? defaultSystemRamReader;
    const total = this.readRam().totalBytes;
    this.maxRamBytes = opts?.maxRamBytes && opts.maxRamBytes > 0 ? opts.maxRamBytes : Math.floor(total * 0.8);
    this.maxVramBytes = opts?.maxVramBytes ?? 0;
    this.reservedBytes = opts?.reservedBytes ?? Math.floor(total * 0.1);
  }

  getMaxRamBytes(): number {
    return this.maxRamBytes;
  }

  getMaxVramBytes(): number {
    return this.maxVramBytes;
  }

  /** RAM con lai cho model moi (trong budget, tru phan giu cho he thong). */
  availableRam(usedByModelsBytes: number): number {
    const free = this.readRam().freeBytes;
    const withinBudget = this.maxRamBytes - usedByModelsBytes;
    const withinSystem = free - this.reservedBytes;
    return Math.max(0, Math.min(withinBudget, withinSystem));
  }

  /** Model co vua RAM khong. */
  fitsRam(footprintBytes: number, usedByModelsBytes: number): boolean {
    return footprintBytes <= this.availableRam(usedByModelsBytes);
  }

  /**
   * Model co vua VRAM khong. Khi khong biet VRAM (null) hoac khong dat
   * gioi han VRAM -> tra true (khong chan vo co; RAM van la cua chan).
   */
  fitsVram(footprintBytes: number, usedVramBytes: number, freeVramBytes: number | null): boolean {
    if (freeVramBytes === null) return true;
    if (this.maxVramBytes > 0) {
      return footprintBytes <= this.maxVramBytes - usedVramBytes;
    }
    return footprintBytes <= freeVramBytes;
  }

  /** Ly do khong load duoc (null = load duoc). */
  checkFit(
    footprintBytes: number,
    usedByModelsBytes: number,
    usedVramBytes: number,
    freeVramBytes: number | null,
  ): { fits: boolean; reason?: string } {
    if (!this.fitsRam(footprintBytes, usedByModelsBytes)) {
      return { fits: false, reason: 'ram' };
    }
    if (!this.fitsVram(footprintBytes, usedVramBytes, freeVramBytes)) {
      return { fits: false, reason: 'vram' };
    }
    return { fits: true };
  }
}
