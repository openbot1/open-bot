/**
 * Multi-tenant Agent Cards (v1.09, Đội T4) — A2A v1.1.
 *
 * Mở rộng multi-tenancy đã có (`tenancy.ts`: task của tenant nào chỉ
 * tenant đó thấy) lên tầng Agent Card: một server phục vụ nhiều
 * tenant, mỗi tenant có card riêng + quyền riêng, cô lập hoàn toàn:
 *  - Card gốc (server) khai `tenants[]`; mỗi tenant có card con:
 *    cùng name/url gốc nhưng `tenantId` riêng, skill bị giới hạn
 *    theo allowlist, capability có thể bị thu hẹp (vd tenant khách
 *    không được stream, không được push).
 *  - Card con được ký riêng (cùng key ký card gốc, hoặc key riêng
 *    của tenant — `signTenantCard` nhận keypair nào cũng được, vì
 *    chữ ký chỉ bao phủ nội dung card).
 *  - Cô lập: `getCardForTenant(tenantB)` không bao giờ trả card của
 *    tenant A; tenant không tồn tại → undefined (caller báo "not
 *    found", không tiết lộ tenant khác tồn tại).
 *  - Quyền (permissions) đi kèm card con: tenant được gửi task
 *    không, được stream không, tối đa bao nhiêu task đồng thời, skill
 *    nào được dùng. Quyền được kiểm tra ở tầng này (`canTenantUseSkill`,
 *    `canTenantStartTask`) trước khi server nhận task.
 *
 * Chỉ thuần logic + ký (dùng `signing.ts`), không gọi mạng, không
 * đọc file. Lưu trữ card tenant ở bộ nhớ; server lưu disk bằng store
 * của mình nếu cần.
 */

import { buildAgentCardV11, validateAgentCardV11 } from './cardV11';
import type { A2aAgentCardV11, A2aCardTenantSummary } from './cardV11';
import { signAgentCard, type A2aSigningKeyPair } from './signing';
import { isValidA2aTenantId, normalizeA2aTenantId, DEFAULT_A2A_TENANT } from './tenancy';
import type { A2aAgentSkill } from './types';

/** Quyền của một tenant trên server A2A. */
export interface A2aTenantPermissions {
  /** Tenant được gửi task mới không. */
  canSendTasks: boolean;
  /** Tenant được stream task updates không. */
  canStream: boolean;
  /** Tenant được đăng ký push notification không. */
  canUsePush: boolean;
  /** Tối đa task đồng thời của tenant (0 = không giới hạn). */
  maxConcurrentTasks: number;
  /** Skill id tenant được dùng; rỗng = mọi skill của card gốc. */
  allowedSkillIds: string[];
}

/** Quyền mặc định: mọi thứ bật, không giới hạn số task. */
export function defaultTenantPermissions(): A2aTenantPermissions {
  return {
    canSendTasks: true,
    canStream: true,
    canUsePush: true,
    maxConcurrentTasks: 0,
    allowedSkillIds: [],
  };
}

/** Một tenant đã đăng ký trên server: card con + quyền + metadata. */
export interface A2aTenantCardEntry {
  tenantId: string;
  /** Tên hiển thị (vd tên team). */
  displayName: string;
  /** Card con của tenant (đã ký khi `signed=true`). */
  card: A2aAgentCardV11;
  /** Quyền của tenant. */
  permissions: A2aTenantPermissions;
  /** true khi card con đã được ký bằng key local. */
  signed: boolean;
  /** ISO-8601 lúc đăng ký tenant. */
  registeredAt: string;
}

/** Input đăng ký một tenant mới. */
export interface RegisterTenantInput {
  tenantId: string;
  displayName?: string;
  /** Quyền riêng (mặc định: mọi thứ bật). */
  permissions?: Partial<A2aTenantPermissions>;
  /** Skill id tenant được dùng (ghi đè permissions.allowedSkillIds). */
  allowedSkillIds?: string[];
  /** Card con có hết hạn lúc này không (ISO-8601). */
  validUntil?: string;
}

/**
 * Registry card theo tenant. Giữ card gốc (server) + map tenant →
 * entry. Mọi lookup đều qua tenantId đã normalize; tenant lạ →
 * undefined, không throw (caller báo "not found").
 */
export class TenantCardRegistry {
  private readonly baseCard: A2aAgentCardV11;
  private readonly entries = new Map<string, A2aTenantCardEntry>();

  constructor(baseCard: A2aAgentCardV11) {
    const problems = validateAgentCardV11(baseCard);
    if (problems.length > 0) {
      throw new Error(`TenantCardRegistry cần card gốc hợp lệ: ${problems.join('; ')}`);
    }
    this.baseCard = { ...baseCard };
  }

  /** Card gốc của server (bản copy). */
  getBaseCard(): A2aAgentCardV11 {
    return { ...this.baseCard };
  }

  /** Số tenant đã đăng ký. */
  get tenantCount(): number {
    return this.entries.size;
  }

  /** Tenant id đã đăng ký, theo thứ tự đăng ký. */
  tenantIds(): string[] {
    return [...this.entries.keys()];
  }

  /** True khi tenant này đã đăng ký. */
  hasTenant(tenantId: string): boolean {
    try {
      return this.entries.has(normalizeA2aTenantId(tenantId));
    } catch {
      return false;
    }
  }

  /**
   * Đăng ký một tenant mới (build card con từ card gốc + quyền).
   * Throw khi tenantId sai định dạng hoặc tenant đã tồn tại.
   */
  registerTenant(input: RegisterTenantInput): A2aTenantCardEntry {
    const tenantId = normalizeA2aTenantId(input.tenantId);
    if (this.entries.has(tenantId)) {
      throw new Error(`Tenant "${tenantId}" đã đăng ký — dùng updateTenantPermissions để đổi quyền.`);
    }
    const permissions: A2aTenantPermissions = {
      ...defaultTenantPermissions(),
      ...(input.permissions ?? {}),
      allowedSkillIds:
        input.allowedSkillIds ?? input.permissions?.allowedSkillIds ?? [],
    };
    const card = buildTenantCard(this.baseCard, tenantId, permissions, {
      displayName: input.displayName,
      validUntil: input.validUntil,
    });
    const entry: A2aTenantCardEntry = {
      tenantId,
      displayName: input.displayName ?? tenantId,
      card,
      permissions,
      signed: false,
      registeredAt: new Date().toISOString(),
    };
    this.entries.set(tenantId, entry);
    return copyTenantEntry(entry);
  }

  /**
   * Ký card con của một tenant bằng key local (ghi đè card cũ bằng
   * bản đã ký). Trả entry mới; throw khi tenant chưa đăng ký.
   */
  signTenantCard(tenantId: string, keyPair: A2aSigningKeyPair): A2aTenantCardEntry {
    const id = normalizeA2aTenantId(tenantId);
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Tenant "${id}" chưa đăng ký.`);
    const signedCard = signAgentCard(entry.card, keyPair);
    const updated: A2aTenantCardEntry = {
      ...entry,
      card: signedCard as unknown as A2aAgentCardV11,
      signed: true,
    };
    this.entries.set(id, updated);
    return copyTenantEntry(updated);
  }

  /**
   * Lấy card con của một tenant (bản copy). Tenant chưa đăng ký →
   * undefined (caller báo "not found"). Tenant mặc định chưa đăng
   * ký riêng → trả card gốc (single-tenant tương thích ngược).
   */
  getCardForTenant(tenantId: string): A2aAgentCardV11 | undefined {
    let id: string;
    try {
      id = normalizeA2aTenantId(tenantId);
    } catch {
      return undefined;
    }
    const entry = this.entries.get(id);
    if (entry) return { ...entry.card };
    if (id === DEFAULT_A2A_TENANT) return { ...this.baseCard };
    return undefined;
  }

  /** Lấy entry đầy đủ của tenant (bản copy), undefined khi chưa đăng ký. */
  getTenant(tenantId: string): A2aTenantCardEntry | undefined {
    let id: string;
    try {
      id = normalizeA2aTenantId(tenantId);
    } catch {
      return undefined;
    }
    const entry = this.entries.get(id);
    return entry ? copyTenantEntry(entry) : undefined;
  }

  /**
   * Đổi quyền của tenant (giữ nguyên card con — quyền không nằm
   * trong card, mà do server kiểm tra khi nhận task). Throw khi
   * tenant chưa đăng ký.
   */
  updateTenantPermissions(
    tenantId: string,
    patch: Partial<A2aTenantPermissions>,
  ): A2aTenantCardEntry {
    const id = normalizeA2aTenantId(tenantId);
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Tenant "${id}" chưa đăng ký.`);
    const permissions: A2aTenantPermissions = {
      ...entry.permissions,
      ...patch,
      ...(patch.allowedSkillIds !== undefined ? { allowedSkillIds: [...patch.allowedSkillIds] } : {}),
    };
    const updated: A2aTenantCardEntry = { ...entry, permissions };
    this.entries.set(id, updated);
    return copyTenantEntry(updated);
  }

  /** Gỡ một tenant (card + quyền biến mất; task cũ của tenant do server xử lý riêng). */
  removeTenant(tenantId: string): boolean {
    try {
      return this.entries.delete(normalizeA2aTenantId(tenantId));
    } catch {
      return false;
    }
  }

  /**
   * Tóm tắt card gốc cho client discovery: card gốc + danh sách
   * tenant (không lộ quyền chi tiết, không lộ card con của tenant
   * khác — client chỉ thấy tenant của mình qua `getCardForTenant`).
   */
  buildDiscoveryCard(): A2aAgentCardV11 {
    const tenants: A2aCardTenantSummary[] = this.tenantIds().map((id) => {
      const entry = this.entries.get(id) as A2aTenantCardEntry;
      return {
        tenantId: id,
        ...(entry.displayName !== id ? { displayName: entry.displayName } : {}),
        ...(entry.permissions.allowedSkillIds.length > 0
          ? { allowedSkillIds: [...entry.permissions.allowedSkillIds] }
          : {}),
      };
    });
    return { ...this.baseCard, tenants };
  }
}

function copyTenantEntry(entry: A2aTenantCardEntry): A2aTenantCardEntry {
  return {
    ...entry,
    card: { ...entry.card },
    permissions: {
      ...entry.permissions,
      allowedSkillIds: [...entry.permissions.allowedSkillIds],
    },
  };
}

/**
 * Build card con cho một tenant từ card gốc: tên/URL giữ nguyên,
 * skill lọc theo allowlist, capability thu hẹp theo quyền (không
 * stream → streaming=false; không push → pushNotifications=false),
 * thêm `tenants: [tenant này]` để card con tự khai tenant của nó.
 * Card con không mang keyRotation (rotate key là việc của card gốc).
 */
export function buildTenantCard(
  baseCard: A2aAgentCardV11,
  tenantId: string,
  permissions: A2aTenantPermissions,
  opts: { displayName?: string; validUntil?: string } = {},
): A2aAgentCardV11 {
  if (!isValidA2aTenantId(tenantId)) {
    throw new Error(`Tenant id không hợp lệ: "${tenantId}".`);
  }
  const allowed =
    permissions.allowedSkillIds.length > 0 ? new Set(permissions.allowedSkillIds) : null;
  const skills: A2aAgentSkill[] | undefined = baseCard.skills
    ? allowed === null
      ? baseCard.skills.map((s) => ({ ...s }))
      : baseCard.skills.filter((s) => allowed.has(s.id)).map((s) => ({ ...s }))
    : undefined;
  const caps = (baseCard.capabilities ?? {}) as A2aAgentCardV11['capabilities'];
  const card = buildAgentCardV11({
    name: baseCard.name,
    description: baseCard.description,
    url: baseCard.url,
    ...(baseCard.version !== undefined ? { version: baseCard.version } : {}),
    ...(baseCard.protocolVersion !== undefined ? { protocolVersion: baseCard.protocolVersion } : {}),
    ...(baseCard.protocolVersions !== undefined ? { protocolVersions: [...baseCard.protocolVersions] } : {}),
    streaming: permissions.canStream && (caps?.streaming ?? false),
    pushNotifications: permissions.canUsePush && (caps?.pushNotifications ?? false),
    stateTransitionHistory: caps?.stateTransitionHistory ?? false,
    resumableStreams: permissions.canStream && (caps?.resumableStreams ?? false),
    multiTenancy: true,
    signedCardRequired: caps?.signedCardRequired ?? false,
    skills,
    defaultInputModes: baseCard.defaultInputModes,
    defaultOutputModes: baseCard.defaultOutputModes,
    ...(opts.validUntil ?? baseCard.validUntil
      ? { validUntil: (opts.validUntil ?? baseCard.validUntil) as string }
      : {}),
    ...(baseCard.issuedAt !== undefined ? { issuedAt: baseCard.issuedAt } : {}),
    tenants: [
      {
        tenantId,
        ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
        ...(permissions.allowedSkillIds.length > 0
          ? { allowedSkillIds: [...permissions.allowedSkillIds] }
          : {}),
      },
    ],
  });
  return card;
}

/** True khi tenant được dùng skill này (allowlist rỗng = mọi skill). */
export function canTenantUseSkill(
  permissions: A2aTenantPermissions,
  skillId: string,
): boolean {
  if (permissions.allowedSkillIds.length === 0) return true;
  return permissions.allowedSkillIds.includes(skillId);
}

/** True khi tenant được bắt đầu task mới (quyền + giới hạn đồng thời). */
export function canTenantStartTask(
  permissions: A2aTenantPermissions,
  runningTaskCount: number,
): { allowed: boolean; reason?: string } {
  if (!permissions.canSendTasks) {
    return { allowed: false, reason: 'Tenant này không được gửi task (canSendTasks=false).' };
  }
  if (
    permissions.maxConcurrentTasks > 0 &&
    runningTaskCount >= permissions.maxConcurrentTasks
  ) {
    return {
      allowed: false,
      reason: `Tenant đã chạy ${runningTaskCount}/${permissions.maxConcurrentTasks} task đồng thời — chờ task cũ xong.`,
    };
  }
  return { allowed: true };
}

/** True khi tenant được stream task (quyền canStream). */
export function canTenantStream(permissions: A2aTenantPermissions): boolean {
  return permissions.canStream;
}
