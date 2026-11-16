/**
 * LRU + TTL unload theo RAM/VRAM THAT (v1.16, Doi T3).
 *
 * Khac v1.15 (LRU chu yeu theo so model): router v2 tinh theo BYTE —
 * mot model 8B chiem gap doi model 4B thi phai duoc tinh gap doi khi
 * quyet dinh evict. Thu tu evict:
 *   1. Model idle qua TTL (lau khong dung nhat truoc).
 *   2. Model it dung nhat (LRU) trong so model con lai.
 *   3. Khong bao gio evict: model dang chay task, model resident
 *      (pin / embedder luon resident), model vua load chua qua TTL
 *      toi thieu — tru khi `force` (bat buoc de load model moi).
 * Ke hoach evict la thuan (pure): tra danh sach can unload + so byte
 * se giai phong, router tu thuc hien unload.
 */

/** Mot muc trong cache LRU v2. */
export interface LruV2Entry {
  modelId: string;
  /** Footprint RAM (byte) — GGUF + KV + overhead. */
  ramBytes: number;
  /** Footprint VRAM (byte); 0 khi chay CPU-only. */
  vramBytes: number;
  lastUsedAt: number;
  loadedAt: number;
  activeTasks: number;
  /** true = resident (pin / embedder): khong evict tru khi force. */
  resident: boolean;
  /** Thu tu uu tien giu lai (cao hon = kho evict hon). */
  priority: number;
}

/** Cau hinh LRU v2. */
export interface LruV2Config {
  maxLoadedModels: number;
  maxRamBytes: number;
  maxVramBytes: number;
  idleTimeoutMs: number;
  /** Thoi gian toi thieu mot model duoc o lai sau khi load (ms). */
  minStayMs: number;
}

/** Cau hinh mac dinh LRU v2. */
export const DEFAULT_LRU_V2_CONFIG: LruV2Config = {
  maxLoadedModels: 2,
  maxRamBytes: 0,
  maxVramBytes: 0,
  idleTimeoutMs: 10 * 60 * 1000,
  minStayMs: 60_000,
};

/** Ly do evict. */
export type EvictionReasonV2 = 'max-models' | 'ram' | 'vram' | 'idle' | 'none';

/** Ke hoach evict. */
export interface EvictionPlanV2 {
  toUnload: string[];
  reason: EvictionReasonV2;
  freedRamBytes: number;
  freedVramBytes: number;
  /** Model khong the unload (dang ban / resident) — de log/giai thich. */
  blocked: string[];
  /** true = du byte can giai phong sau khi evict theo ke hoach. */
  enough: boolean;
}

/** Ly do mot entry bi chan khoi evict. */
export type EvictionBlockReason = 'active' | 'resident' | 'min-stay';

/**
 * LruV2Cache — giu metadata cac model dang loaded, tinh ke hoach
 * evict theo byte. Khong giu process that (router giu).
 */
export class LruV2Cache {
  private readonly config: LruV2Config;
  private readonly entries = new Map<string, LruV2Entry>();

  constructor(config: Partial<LruV2Config> = {}) {
    this.config = { ...DEFAULT_LRU_V2_CONFIG, ...config };
  }

  getConfig(): LruV2Config {
    return { ...this.config };
  }

  add(entry: LruV2Entry): void {
    this.entries.set(entry.modelId, { ...entry });
  }

  remove(modelId: string): boolean {
    return this.entries.delete(modelId);
  }

  get(modelId: string): LruV2Entry | undefined {
    const entry = this.entries.get(modelId);
    return entry ? { ...entry } : undefined;
  }

  has(modelId: string): boolean {
    return this.entries.has(modelId);
  }

  list(): LruV2Entry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  size(): number {
    return this.entries.size;
  }

  /** Cap nhat lastUsedAt khi model duoc dung. */
  touch(modelId: string, at: number = Date.now()): boolean {
    const entry = this.entries.get(modelId);
    if (!entry) return false;
    entry.lastUsedAt = at;
    return true;
  }

  /** Tang/giam so task dang chay (de bao ve khoi evict). */
  setActiveTasks(modelId: string, count: number): boolean {
    const entry = this.entries.get(modelId);
    if (!entry) return false;
    entry.activeTasks = Math.max(0, count);
    return true;
  }

  /** Dat/clear resident (pin). */
  setResident(modelId: string, resident: boolean): boolean {
    const entry = this.entries.get(modelId);
    if (!entry) return false;
    entry.resident = resident;
    return true;
  }

  totalRamBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.ramBytes;
    return total;
  }

  totalVramBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.vramBytes;
    return total;
  }

  /** Ly do mot entry khong the evict luc `now` (undefined = evict duoc). */
  blockReason(entry: LruV2Entry, now: number, force: boolean, ignoreMinStay = false): EvictionBlockReason | undefined {
    if (entry.activeTasks > 0) return 'active';
    if (entry.resident && !force) return 'resident';
    if (!ignoreMinStay && !force && now - entry.loadedAt < this.config.minStayMs) return 'min-stay';
    return undefined;
  }

  /**
   * Tinh ke hoach evict de chua model moi (can `neededRamBytes` /
   * `neededVramBytes`, cong them 1 slot neu vuot maxLoadedModels).
   * `excludeModelId` = model sap load (khong evict chinh no).
   * Thu tu uu tien evict: idle-qua-TTL truoc, roi LRU (it dung nhat),
   * trong cung muc idle thi model nho uu tien thap / priority thap
   * evict truoc.
   */
  planEviction(
    neededRamBytes: number,
    neededVramBytes: number,
    opts?: { now?: number; force?: boolean; excludeModelId?: string; ignoreMinStay?: boolean },
  ): EvictionPlanV2 {
    const now = opts?.now ?? Date.now();
    const force = opts?.force ?? false;
    const exclude = opts?.excludeModelId;
    const blocked: string[] = [];
    const candidates: LruV2Entry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.modelId === exclude) continue;
      const reason = this.blockReason(entry, now, force, opts?.ignoreMinStay ?? false);
      if (reason) {
        blocked.push(entry.modelId);
        continue;
      }
      candidates.push(entry);
    }
    // Sap xep: idle-qua-TTL truoc; trong moi nhom: priority thap truoc,
    // roi lastUsedAt cu truoc, roi ram lon truoc (giai phong nhanh).
    const idleCutoff = now - this.config.idleTimeoutMs;
    candidates.sort((a, b) => {
      const aIdle = a.lastUsedAt <= idleCutoff ? 0 : 1;
      const bIdle = b.lastUsedAt <= idleCutoff ? 0 : 1;
      if (aIdle !== bIdle) return aIdle - bIdle;
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
      return b.ramBytes - a.ramBytes;
    });

    const plan: EvictionPlanV2 = {
      toUnload: [],
      reason: 'none',
      freedRamBytes: 0,
      freedVramBytes: 0,
      blocked,
      enough: false,
    };
    const needSlot = this.entries.size >= this.config.maxLoadedModels && !this.entries.has(exclude ?? '');
    const needRam =
      this.config.maxRamBytes > 0 && this.totalRamBytes() + neededRamBytes > this.config.maxRamBytes;
    const needVram =
      this.config.maxVramBytes > 0 && this.totalVramBytes() + neededVramBytes > this.config.maxVramBytes;
    if (!needSlot && !needRam && !needVram) {
      return plan;
    }
    plan.reason = needVram ? 'vram' : needRam ? 'ram' : 'max-models';
    let freedRam = 0;
    let freedVram = 0;
    for (const entry of candidates) {
      plan.toUnload.push(entry.modelId);
      freedRam += entry.ramBytes;
      freedVram += entry.vramBytes;
      const slotOk = !needSlot || plan.toUnload.length >= 1;
      const ramOk =
        !needRam || this.totalRamBytes() - freedRam + neededRamBytes <= this.config.maxRamBytes;
      const vramOk =
        !needVram || this.totalVramBytes() - freedVram + neededVramBytes <= this.config.maxVramBytes;
      if (slotOk && ramOk && vramOk) break;
    }
    plan.freedRamBytes = freedRam;
    plan.freedVramBytes = freedVram;
    const ramOkAfter =
      this.config.maxRamBytes <= 0 ||
      this.totalRamBytes() - freedRam + neededRamBytes <= this.config.maxRamBytes;
    const vramOkAfter =
      this.config.maxVramBytes <= 0 ||
      this.totalVramBytes() - freedVram + neededVramBytes <= this.config.maxVramBytes;
    const slotOkAfter = !needSlot || plan.toUnload.length >= 1;
    plan.enough = slotOkAfter && ramOkAfter && vramOkAfter;
    return plan;
  }

  /**
   * Quet idle: cac model vuot TTL, khong active, khong resident.
   * Router goi dinh ky (sweep) de unload model bo khong.
   */
  sweepIdle(now: number = Date.now()): string[] {
    const idleCutoff = now - this.config.idleTimeoutMs;
    const out: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.activeTasks > 0 || entry.resident) continue;
      if (entry.lastUsedAt <= idleCutoff) out.push(entry.modelId);
    }
    out.sort((a, b) => {
      const ea = this.entries.get(a);
      const eb = this.entries.get(b);
      return (ea?.lastUsedAt ?? 0) - (eb?.lastUsedAt ?? 0);
    });
    return out;
  }

  /** Serialize (de host persist). */
  toJSON(): LruV2Entry[] {
    return this.list();
  }

  static fromJSON(entries: LruV2Entry[], config?: Partial<LruV2Config>): LruV2Cache {
    const cache = new LruV2Cache(config);
    for (const entry of entries) cache.add(entry);
    return cache;
  }
}
