/**
 * LRU load/unload theo RAM (v1.15, Doi T3).
 *
 * Y tuong (llama.cpp router-mode `--models-max`): gioi han so model
 * dong thoi + RAM, unload model it dung nhat khi vuot nguong, khong
 * bao gio unload model dang chay task (protectActive) hoac dang pin.
 * Thiet ke thuan — khong phu thuoc process that — de test duoc ma
 * khong can GPU/model that.
 */

import * as os from 'node:os';

import type { LocalModelEntry } from '../../models/localCatalog';
import {
  DEFAULT_LRU_CONFIG,
  type LruConfig,
  type RamSnapshot,
} from './types';

/** Mot muc trong cache LRU (chi metadata — registry giu instance that). */
export interface LruEntry {
  modelId: string;
  ramBytes: number;
  lastUsedAt: number;
  activeTasks: number;
  pinned: boolean;
  loadedAt: number;
}

/** Ket qua mot lan danh gia eviction. */
export interface EvictionPlan {
  /** Cac model can unload (theo thu tu uu tien unload truoc). */
  toUnload: string[];
  /** Ly do: 'max-models' | 'ram' | 'idle' | 'none'. */
  reason: 'max-models' | 'ram' | 'idle' | 'none';
  /** RAM se giai phong (byte). */
  freedBytes: number;
  /** Cac model khong the unload vi dang ban/pin (de log). */
  blocked: string[];
}

/** Doc RAM he thong that (co the inject de test). */
export type RamReader = () => { totalBytes: number; freeBytes: number };

export function defaultRamReader(): { totalBytes: number; freeBytes: number } {
  return { totalBytes: os.totalmem(), freeBytes: os.freemem() };
}

/**
 * RamTracker — theo doi RAM kha dung + RAM model dang chiem.
 * `budgetBytes` la gioi han registry duoc phep dung (mac dinh 80%
 * RAM tong — de lai cho he thong); co the dat cu the hon qua config.
 */
export class RamTracker {
  private readonly readRam: RamReader;
  private readonly budgetBytes: number;

  constructor(opts?: { readRam?: RamReader; budgetBytes?: number }) {
    this.readRam = opts?.readRam ?? defaultRamReader;
    const total = this.readRam().totalBytes;
    this.budgetBytes = opts?.budgetBytes ?? Math.floor(total * 0.8);
  }

  getBudgetBytes(): number {
    return this.budgetBytes;
  }

  snapshot(usedByModelsBytes: number): RamSnapshot {
    const { totalBytes, freeBytes } = this.readRam();
    return {
      totalBytes,
      freeBytes,
      budgetBytes: this.budgetBytes,
      usedByModelsBytes,
      takenAt: Date.now(),
    };
  }

  /** RAM con lai cho model moi (trong budget). */
  availableForModels(usedByModelsBytes: number): number {
    return Math.max(0, this.budgetBytes - usedByModelsBytes);
  }

  /** true = model vua trong RAM con lai. */
  fits(entry: LocalModelEntry, usedByModelsBytes: number): boolean {
    return entry.ramRequiredBytes <= this.availableForModels(usedByModelsBytes);
  }
}

/**
 * LruModelCache — quyet dinh unload cai gi, khi nao.
 *
 * Thu tu uu tien unload: idle lau nhat truoc, model nhe truoc khi
 * hoa (de giai phong du RAM voi it lan unload nhat thi nguoc lai:
 * chon model lon truoc neu can giai phong nhieu — xem planEviction).
 * Model dang chay task (activeTasks > 0, khi protectActive) va model
 * pin khong bao gio bi chon, du co vuot nguong — caller phai xu ly
 * (tu choi load moi thay vi giet task dang chay).
 */
export class LruModelCache {
  private readonly config: LruConfig;
  private readonly entries = new Map<string, LruEntry>();

  constructor(config?: Partial<LruConfig>) {
    this.config = { ...DEFAULT_LRU_CONFIG, ...config };
  }

  getConfig(): LruConfig {
    return { ...this.config };
  }

  size(): number {
    return this.entries.size;
  }

  has(modelId: string): boolean {
    return this.entries.has(modelId);
  }

  get(modelId: string): LruEntry | undefined {
    return this.entries.get(modelId);
  }

  list(): LruEntry[] {
    return [...this.entries.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }

  totalRamBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.ramBytes;
    return total;
  }

  /** Ghi nhan model vua load xong. */
  markLoaded(modelId: string, ramBytes: number, opts?: { pinned?: boolean }): void {
    const now = Date.now();
    this.entries.set(modelId, {
      modelId,
      ramBytes,
      lastUsedAt: now,
      activeTasks: 0,
      pinned: opts?.pinned ?? false,
      loadedAt: now,
    });
  }

  /** Ghi nhan model vua duoc dung (cap nhat LRU). */
  touch(modelId: string, at = Date.now()): void {
    const e = this.entries.get(modelId);
    if (e) e.lastUsedAt = at;
  }

  /** Tang/giam so task dang chay tren model. */
  setActiveTasks(modelId: string, count: number): void {
    const e = this.entries.get(modelId);
    if (e) e.activeTasks = Math.max(0, count);
  }

  pin(modelId: string, pinned: boolean): boolean {
    const e = this.entries.get(modelId);
    if (!e) return false;
    e.pinned = pinned;
    return true;
  }

  remove(modelId: string): boolean {
    return this.entries.delete(modelId);
  }

  /** Cac model idle qua nguong (ms) — co the unload de do RAM. */
  idleEntries(now = Date.now()): LruEntry[] {
    return this.list().filter(
      (e) => now - e.lastUsedAt >= this.config.idleTimeoutMs && e.activeTasks === 0 && !e.pinned,
    );
  }

  /** Model it dung nhat (LRU) trong so cac model duoc phep unload. */
  private evictable(now = Date.now()): LruEntry[] {
    return this.list().filter((e) => {
      if (e.pinned) return false;
      if (this.config.protectActive && e.activeTasks > 0) return false;
      return true;
    });
  }

  /**
   * Lap ke hoach eviction khi muon load model moi.
   *
   * - Vuot maxLoadedModels: unload LRU cho den khi du cho.
   * - Vuot maxRamBytes (neu > 0): unload model LON truoc (giai phong
   *   du RAM voi it lan unload nhat), tru model dang ban/pin.
   * - Khong du cho vi model bi block: tra blocked de caller bao loi
   *   ro rang thay vi lang le giet task dang chay.
   */
  planEviction(newModelRamBytes: number, now = Date.now()): EvictionPlan {
    const blocked: string[] = [];
    for (const e of this.entries.values()) {
      if (e.pinned) blocked.push(e.modelId);
      else if (this.config.protectActive && e.activeTasks > 0) blocked.push(e.modelId);
    }
    const evictable = this.evictable(now);
    const toUnload: string[] = [];
    let freed = 0;
    let reason: EvictionPlan['reason'] = 'none';

    // 1) Gioi han so model dong thoi.
    let slotsNeeded = this.entries.size + 1 - this.config.maxLoadedModels;
    if (slotsNeeded > 0) {
      reason = 'max-models';
      const byLru = [...evictable].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const e of byLru) {
        if (slotsNeeded <= 0) break;
        toUnload.push(e.modelId);
        freed += e.ramBytes;
        slotsNeeded -= 1;
      }
    }

    // 2) Gioi han RAM (neu cau hinh).
    if (this.config.maxRamBytes > 0) {
      const projected = this.totalRamBytes() - freed + newModelRamBytes;
      if (projected > this.config.maxRamBytes) {
        reason = reason === 'none' ? 'ram' : reason;
        let need = projected - this.config.maxRamBytes;
        // Model lon truoc — giai phong du voi it lan unload nhat.
        const remaining = evictable
          .filter((e) => !toUnload.includes(e.modelId))
          .sort((a, b) => b.ramBytes - a.ramBytes);
        for (const e of remaining) {
          if (need <= 0) break;
          toUnload.push(e.modelId);
          freed += e.ramBytes;
          need -= e.ramBytes;
        }
      }
    }

    return { toUnload, reason, freedBytes: freed, blocked };
  }

  /**
   * Ke hoach don dep idle: unload tat ca model idle qua nguong.
   * Khong bao gio cham model dang chay hoac pin.
   */
  planIdleSweep(now = Date.now()): EvictionPlan {
    const idle = this.idleEntries(now);
    return {
      toUnload: idle.map((e) => e.modelId),
      reason: idle.length > 0 ? 'idle' : 'none',
      freedBytes: idle.reduce((s, e) => s + e.ramBytes, 0),
      blocked: [],
    };
  }

  /** true = co the load them model moi ma khong can evict. */
  canLoadWithoutEviction(newModelRamBytes: number): boolean {
    if (this.entries.size + 1 > this.config.maxLoadedModels) return false;
    if (this.config.maxRamBytes > 0 && this.totalRamBytes() + newModelRamBytes > this.config.maxRamBytes) {
      return false;
    }
    return true;
  }

  /** Serialize de luu/khoi phuc (khong luu process that). */
  toJSON(): LruEntry[] {
    return this.list();
  }

  static fromJSON(entries: LruEntry[], config?: Partial<LruConfig>): LruModelCache {
    const cache = new LruModelCache(config);
    for (const e of entries) {
      cache.entries.set(e.modelId, { ...e, activeTasks: 0 });
    }
    return cache;
  }
}
