/**
 * Swap-groups (v1.16, Doi T3).
 *
 * Y tuong (llama-swap: groups quy dinh model nao duoc chia GPU;
 * "embedder luon resident"): moi nhom co mot ngan tai nguyen rieng
 * (maxBytes). Model trong nhom 'always' (embedder / model nho hay
 * dung) khong bao gio bi evict de nhuong cho; model 'on-demand' thi
 * tranh slot theo thu tu uu tien.
 *
 * Preemption co thu tu: khi nhom het cho, model co priority thap
 * nhat + it dung nhat bi preempt truoc; model resident khong bao gio
 * nam trong danh sach preempt (tru khi force). Nhom khong co
 * maxBytes (0) thi khong gioi han rieng — chi gioi han toan cuc cua
 * LRU v2 ap dung.
 */

import type { SwapGroupDefinition } from './types';

/** Trang thai runtime cua mot nhom (model nao dang loaded, bao nhieu byte). */
export interface SwapGroupState {
  definition: SwapGroupDefinition;
  /** Model id dang loaded trong nhom. */
  loadedModelIds: string[];
  /** Tong byte cac model dang loaded trong nhom. */
  loadedBytes: number;
}

/** Ke hoach preempt trong mot nhom. */
export interface PreemptionPlan {
  groupId: string;
  /** Model can unload truoc (theo thu tu uu tien). */
  toPreempt: string[];
  /** Byte se giai phong. */
  freedBytes: number;
  /** true = du cho cho model moi sau khi preempt. */
  enough: boolean;
  /** Model khong the preempt (resident / dang chay). */
  blocked: string[];
}

/** Thong tin mot model trong boi canh nhom (de tinh preemption). */
export interface GroupMemberInfo {
  modelId: string;
  footprintBytes: number;
  lastUsedAt: number;
  activeTasks: number;
  /** true = resident (embedder / pin): khong preempt tru khi force. */
  resident: boolean;
  /** Uu tien giu lai (cao hon = kho preempt hon). */
  priority: number;
}

/**
 * SwapGroupManager — quan ly dinh nghia nhom + trang thai loaded.
 * Thuan (khong giu process): router cap nhat loaded/unloaded qua
 * `markLoaded` / `markUnloaded`.
 */
export class SwapGroupManager {
  private readonly groups = new Map<string, SwapGroupDefinition>();
  private readonly loaded = new Map<string, { groupId: string; bytes: number }>();

  constructor(definitions: SwapGroupDefinition[] = []) {
    for (const def of definitions) this.addGroup(def);
  }

  /** Them / cap nhat mot nhom (validate co ban). */
  addGroup(def: SwapGroupDefinition): { ok: boolean; error?: string } {
    if (!def.id || def.id.trim().length === 0) return { ok: false, error: 'Swap-group can id.' };
    if (def.maxBytes < 0) return { ok: false, error: `Swap-group ${def.id}: maxBytes khong duoc am.` };
    if (def.modelIds.length === 0) return { ok: false, error: `Swap-group ${def.id}: chua co model nao.` };
    const dup = new Set(def.modelIds);
    if (dup.size !== def.modelIds.length) {
      return { ok: false, error: `Swap-group ${def.id}: model id lap lai.` };
    }
    // Mot model chi thuoc mot nhom (tranh tai nguyen bi dem doi).
    for (const [otherId, other] of this.groups) {
      if (otherId === def.id) continue;
      const overlap = other.modelIds.filter((m) => def.modelIds.includes(m));
      if (overlap.length > 0) {
        return { ok: false, error: `Model ${overlap.join(', ')} da thuoc nhom ${otherId}.` };
      }
    }
    this.groups.set(def.id, { ...def, modelIds: [...def.modelIds] });
    return { ok: true };
  }

  removeGroup(groupId: string): boolean {
    for (const [modelId, info] of [...this.loaded]) {
      if (info.groupId === groupId) this.loaded.delete(modelId);
    }
    return this.groups.delete(groupId);
  }

  getGroup(groupId: string): SwapGroupDefinition | undefined {
    const def = this.groups.get(groupId);
    return def ? { ...def, modelIds: [...def.modelIds] } : undefined;
  }

  listGroups(): SwapGroupDefinition[] {
    return [...this.groups.values()].map((d) => ({ ...d, modelIds: [...d.modelIds] }));
  }

  /** Nhom cua mot model (neu co). */
  groupOf(modelId: string): SwapGroupDefinition | undefined {
    for (const def of this.groups.values()) {
      if (def.modelIds.includes(modelId)) return { ...def, modelIds: [...def.modelIds] };
    }
    return undefined;
  }

  /** Model co phai resident theo nhom khong ('always' policy). */
  isResidentByGroup(modelId: string): boolean {
    const group = this.groupOf(modelId);
    return group?.residentPolicy === 'always';
  }

  /** Danh dau model da load (tinh vao ngan cua nhom). */
  markLoaded(modelId: string, footprintBytes: number): void {
    const group = this.groupOf(modelId);
    if (!group) return;
    this.loaded.set(modelId, { groupId: group.id, bytes: Math.max(0, footprintBytes) });
  }

  /** Danh dau model da unload. */
  markUnloaded(modelId: string): void {
    this.loaded.delete(modelId);
  }

  /** Trang thai mot nhom: model dang loaded + byte da dung. */
  groupState(groupId: string): SwapGroupState | undefined {
    const def = this.groups.get(groupId);
    if (!def) return undefined;
    const loadedModelIds: string[] = [];
    let loadedBytes = 0;
    for (const [modelId, info] of this.loaded) {
      if (info.groupId === groupId) {
        loadedModelIds.push(modelId);
        loadedBytes += info.bytes;
      }
    }
    return { definition: { ...def, modelIds: [...def.modelIds] }, loadedModelIds, loadedBytes };
  }

  listStates(): SwapGroupState[] {
    return [...this.groups.keys()]
      .map((id) => this.groupState(id))
      .filter((s): s is SwapGroupState => s !== undefined);
  }

  /**
   * Nhom co du cho cho model moi khong (theo maxBytes cua nhom).
   * Nhom khong gioi han (maxBytes = 0) hoac model khong thuoc nhom
   * nao -> luon true (gioi han toan cuc do LRU v2 quyet).
   */
  groupHasRoom(modelId: string, footprintBytes: number): boolean {
    const group = this.groupOf(modelId);
    if (!group || group.maxBytes <= 0) return true;
    const state = this.groupState(group.id);
    const used = state?.loadedBytes ?? 0;
    return used + footprintBytes <= group.maxBytes;
  }

  /**
   * Tinh ke hoach preempt trong nhom cua model moi: can giai phong
   * `neededBytes` (footprint model moi tru cho trong nhom). Thu tu
   * preempt: priority thap truoc, roi it dung nhat (LRU) truoc.
   * `members` la anh chup cac model dang loaded trong nhom.
   */
  planPreemption(
    modelId: string,
    footprintBytes: number,
    members: GroupMemberInfo[],
    opts?: { force?: boolean },
  ): PreemptionPlan {
    const group = this.groupOf(modelId);
    const empty: PreemptionPlan = { groupId: group?.id ?? '', toPreempt: [], freedBytes: 0, enough: true, blocked: [] };
    if (!group) return empty;
    if (group.maxBytes <= 0) return empty;
    const state = this.groupState(group.id);
    const used = state?.loadedBytes ?? 0;
    const needed = used + footprintBytes - group.maxBytes;
    if (needed <= 0) return empty;
    const force = opts?.force ?? false;
    const blocked: string[] = [];
    const candidates = members.filter((m) => m.modelId !== modelId);
    const evictable: GroupMemberInfo[] = [];
    for (const m of candidates) {
      if (m.activeTasks > 0) {
        blocked.push(m.modelId);
        continue;
      }
      if (m.resident && !force) {
        blocked.push(m.modelId);
        continue;
      }
      evictable.push(m);
    }
    evictable.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.lastUsedAt - b.lastUsedAt;
    });
    const plan: PreemptionPlan = { groupId: group.id, toPreempt: [], freedBytes: 0, enough: false, blocked };
    for (const m of evictable) {
      plan.toPreempt.push(m.modelId);
      plan.freedBytes += m.footprintBytes;
      if (plan.freedBytes >= needed) break;
    }
    plan.enough = plan.freedBytes >= needed;
    return plan;
  }

  /**
   * Nhom mac dinh cho fleet local: embedder luon resident, model chat
   * chia mot ngan, model code chia mot ngan rieng. Host co the thay
   * bang cau hinh cua minh; day chi la diem khoi dau hop ly.
   */
  static defaultGroups(): SwapGroupDefinition[] {
    return [
      {
        id: 'embedders',
        label: 'Embedder (luôn resident)',
        modelIds: ['nomic-embed-text', 'all-minilm-l6-v2'],
        maxBytes: 2 * 1024 * 1024 * 1024,
        residentPolicy: 'always',
        priority: 100,
      },
      {
        id: 'chat-small',
        label: 'Chat nhỏ (3–4B)',
        modelIds: ['qwen3-4b', 'qwen3-1p7b', 'gemma-3-4b'],
        maxBytes: 8 * 1024 * 1024 * 1024,
        residentPolicy: 'on-demand',
        priority: 50,
      },
      {
        id: 'code-heavy',
        label: 'Code / reasoning nặng',
        modelIds: ['qwen2p5-coder-7b', 'qwen3-8b', 'llama-3p1-8b'],
        maxBytes: 12 * 1024 * 1024 * 1024,
        residentPolicy: 'on-demand',
        priority: 30,
      },
    ];
  }
}
