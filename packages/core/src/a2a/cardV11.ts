/**
 * Agent Card v1.1 (v1.09, Đội T4) — mở rộng Agent Card A2A 1.0.
 *
 * Ý tưởng học từ A2A v1.0/v1.1 (chỉ học ý tưởng, không copy code/text
 * của bất kỳ repo nào): một card v1.1 vẫn là Agent Card 1.0 (mọi field
 * cũ giữ nguyên ý nghĩa, client 1.0 đọc được), cộng thêm:
 *  - `protocolVersions`: danh sách mọi bản protocol agent nói được,
 *    mới nhất trước — client đàm phán bản chung cao nhất (xem
 *    `version11.ts`) thay vì chỉ đọc một `protocolVersion` duy nhất.
 *  - `capabilities` mở rộng: `resumableStreams` (stream task có thể
 *    resume sau ngắt kết nối), `multiTenancy` (server phục vụ nhiều
 *    tenant, mỗi tenant một card), `signedCardRequired` (server từ
 *    chối client không ký card khi gọi — chỉ là khai báo, việc ép
 *    buộc thuộc về policy của server).
 *  - `validUntil`: thời điểm card hết hiệu lực (ISO-8601). Card quá
 *    hạn vẫn đọc được nhưng client phải fetch lại trước khi giao
 *    việc; card không có `validUntil` được coi là không hết hạn
 *    (tương thích card 1.0 cũ).
 *  - `tenants`: khai báo các tenant mà card này phục vụ (mỗi tenant
 *    có card con riêng — xem `tenantCards.ts`). Card gốc (không có
 *    tenant) phục vụ tenant mặc định.
 *  - `keyRotation`: thông tin luân chuyển key ký (keyId cũ còn được
 *    chấp nhận trong thời gian chuyển đổi, để client trust-on-first-
 *    use không báo "đổi key" giả khi server rotate key có kế hoạch).
 *
 * Module này chỉ build/validate/chuyển đổi card thuần (không gọi
 * mạng, không đọc file). Ký card vẫn dùng `signing.ts` (Ed25519) và
 * `cardJws.ts` (JWS compact) — card v1.1 ký y hệt card 1.0, vì chữ ký
 * bao phủ toàn bộ nội dung card (không gồm field `signature`).
 */

import { buildAgentCard, validateAgentCard, A2A_CARD_PROTOCOL_VERSION } from './card';
import type { A2aAgentCard, A2aAgentSkill } from './types';
import { A2A_SUPPORTED_PROTOCOL_VERSIONS_V11, A2A_PROTOCOL_VERSION_V11 } from './version11';

/** Capability mở rộng của Agent Card v1.1 (cộng thêm trên capability 1.0). */
export interface A2aCardCapabilitiesV11 {
  /** Card 1.0: agent có stream task updates qua SSE không. */
  streaming?: boolean;
  /** Card 1.0: agent có nhận push notification config không. */
  pushNotifications?: boolean;
  /** Card 1.0: agent có trả stateTransitionHistory không. */
  stateTransitionHistory?: boolean;
  /**
   * v1.1: stream task có thể resume sau khi ngắt (client gửi lại
   * checkpoint, server phát lại event đã mất). False/absent = stream
   * ngắt là mất, client phải poll lại từ đầu.
   */
  resumableStreams?: boolean;
  /**
   * v1.1: server phục vụ nhiều tenant (mỗi tenant một card + quyền
   * riêng, cô lập dữ liệu). False/absent = single-tenant.
   */
  multiTenancy?: boolean;
  /**
   * v1.1: server yêu cầu client cũng trình card đã ký của mình khi
   * gọi (mutual card auth). Chỉ là khai báo — client không ký thì
   * server có thể từ chối với lỗi rõ ràng.
   */
  signedCardRequired?: boolean;
}

/** Thông tin luân chuyển key ký card (v1.1). */
export interface A2aCardKeyRotation {
  /** Fingerprint key ĐANG ký card (khớp `signature.keyId`). */
  currentKeyId: string;
  /**
   * Fingerprint key CŨ vẫn được chấp nhận (trong thời gian chuyển
   * đổi). Client đã trust key cũ không báo "đổi key" khi gặp key
   * mới, miễn là key mới nằm trong danh sách này hoặc ngược lại.
   */
  previousKeyIds?: string[];
  /** ISO-8601 lúc key cũ hết được chấp nhận (hết thời gian chuyển đổi). */
  previousKeysValidUntil?: string;
}

/** Khai báo một tenant mà card v1.1 phục vụ (tóm tắt; card con đầy đủ xem `tenantCards.ts`). */
export interface A2aCardTenantSummary {
  /** Tenant id (xem `tenancy.ts` — chỉ chữ, số, `.`, `_`, `-`). */
  tenantId: string;
  /** Tên hiển thị của tenant (vd tên team). */
  displayName?: string;
  /** Skill id mà tenant này được dùng (rỗng = mọi skill của card gốc). */
  allowedSkillIds?: string[];
  /** URL card con của tenant (khi server phục vụ card riêng từng tenant). */
  cardUrl?: string;
}

/** Agent Card v1.1 — Agent Card 1.0 + các field mở rộng (đều tùy chọn). */
export interface A2aAgentCardV11 extends A2aAgentCard {
  /** Mọi bản protocol agent nói được, mới nhất trước (vd ['1.1','1.0.1','1.0']). */
  protocolVersions?: string[];
  capabilities?: A2aCardCapabilitiesV11;
  /** ISO-8601 lúc card hết hiệu lực (absent = không hết hạn). */
  validUntil?: string;
  /** ISO-8601 lúc card được phát hành (để client biết card có mới không). */
  issuedAt?: string;
  /** Các tenant card này phục vụ (absent/rỗng = chỉ tenant mặc định). */
  tenants?: A2aCardTenantSummary[];
  /** Thông tin luân chuyển key ký (absent = chưa từng rotate). */
  keyRotation?: A2aCardKeyRotation;
}

/** Input build card v1.1 (mở rộng input của `buildAgentCard`). */
export interface AgentCardV11Input {
  name: string;
  description: string;
  url: string;
  version?: string;
  /** Bản protocol cao nhất ghi vào `protocolVersion` (mặc định '1.1'). */
  protocolVersion?: string;
  /** Danh sách bản hỗ trợ (mặc định mọi bản open-bot hỗ trợ). */
  protocolVersions?: string[];
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  resumableStreams?: boolean;
  multiTenancy?: boolean;
  signedCardRequired?: boolean;
  skills?: A2aAgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  /** ISO-8601 lúc card hết hiệu lực (vd phát hành + 24h). */
  validUntil?: string;
  issuedAt?: string;
  tenants?: A2aCardTenantSummary[];
  keyRotation?: A2aCardKeyRotation;
}

/**
 * Build một Agent Card v1.1. Dùng `buildAgentCard` cho phần 1.0 rồi
 * đắp thêm field v1.1 — card 1.0 cũ vẫn build được y hệt, không đổi.
 */
export function buildAgentCardV11(input: AgentCardV11Input): A2aAgentCardV11 {
  const protocolVersion = input.protocolVersion ?? A2A_PROTOCOL_VERSION_V11;
  const base = buildAgentCard({
    name: input.name,
    description: input.description,
    url: input.url,
    ...(input.version !== undefined ? { version: input.version } : {}),
    protocolVersion,
    streaming: input.streaming,
    pushNotifications: input.pushNotifications,
    stateTransitionHistory: input.stateTransitionHistory,
    skills: input.skills,
    defaultInputModes: input.defaultInputModes,
    defaultOutputModes: input.defaultOutputModes,
  });
  const protocolVersions =
    input.protocolVersions && input.protocolVersions.length > 0
      ? [...input.protocolVersions]
      : [...A2A_SUPPORTED_PROTOCOL_VERSIONS_V11];
  // protocolVersion (bản cao nhất) phải đứng đầu protocolVersions.
  if (protocolVersions[0] !== protocolVersion) {
    const without = protocolVersions.filter((v) => v !== protocolVersion);
    protocolVersions.splice(0, protocolVersions.length, protocolVersion, ...without);
  }
  const card: A2aAgentCardV11 = {
    ...base,
    protocolVersions,
    capabilities: {
      streaming: input.streaming ?? false,
      pushNotifications: input.pushNotifications ?? false,
      stateTransitionHistory: input.stateTransitionHistory ?? false,
      resumableStreams: input.resumableStreams ?? false,
      multiTenancy: input.multiTenancy ?? false,
      signedCardRequired: input.signedCardRequired ?? false,
    },
  };
  if (input.validUntil !== undefined) card.validUntil = input.validUntil;
  if (input.issuedAt !== undefined) card.issuedAt = input.issuedAt;
  if (input.tenants !== undefined) card.tenants = input.tenants.map((t) => ({ ...t }));
  if (input.keyRotation !== undefined) {
    card.keyRotation = {
      ...input.keyRotation,
      ...(input.keyRotation.previousKeyIds !== undefined
        ? { previousKeyIds: [...input.keyRotation.previousKeyIds] }
        : {}),
    };
  }
  return card;
}

/** True khi card là card v1.1 (ghi protocolVersion 1.1 hoặc có protocolVersions). */
export function isAgentCardV11(card: A2aAgentCard | A2aAgentCardV11 | unknown): card is A2aAgentCardV11 {
  if (typeof card !== 'object' || card === null) return false;
  const rec = card as Record<string, unknown>;
  if (Array.isArray(rec['protocolVersions'])) return true;
  return rec['protocolVersion'] === A2A_PROTOCOL_VERSION_V11;
}

/**
 * Nâng một card 1.0 lên 1.1: giữ nguyên mọi field, thêm
 * `protocolVersions` (bản trong card + mọi bản cũ hơn mà open-bot
 * nói được) và capability v1.1 mặc định false. Card đã là 1.1 thì
 * trả bản copy không đổi.
 */
export function upgradeAgentCardToV11(card: A2aAgentCard): A2aAgentCardV11 {
  const copy: A2aAgentCardV11 = {
    ...(card as A2aAgentCardV11),
    capabilities: { ...(card.capabilities ?? {}) } as A2aCardCapabilitiesV11,
  };
  if (Array.isArray((card as A2aAgentCardV11).protocolVersions)) {
    return copy;
  }
  const own = typeof card.protocolVersion === 'string' ? card.protocolVersion : A2A_CARD_PROTOCOL_VERSION;
  const versions = [own, ...A2A_SUPPORTED_PROTOCOL_VERSIONS_V11.filter((v) => v !== own)];
  copy.protocolVersions = versions;
  copy.protocolVersion = own;
  const caps = copy.capabilities as A2aCardCapabilitiesV11;
  if (caps.resumableStreams === undefined) caps.resumableStreams = false;
  if (caps.multiTenancy === undefined) caps.multiTenancy = false;
  if (caps.signedCardRequired === undefined) caps.signedCardRequired = false;
  return copy;
}

/**
 * Hạ một card v1.1 xuống 1.0 cho client cũ: bỏ các field v1.1
 * (`protocolVersions`, `validUntil`, `issuedAt`, `tenants`,
 * `keyRotation`, capability v1.1). Card gốc không bị sửa.
 */
export function downgradeAgentCardToV10(card: A2aAgentCardV11): A2aAgentCard {
  const { protocolVersions: _pv, validUntil: _vu, issuedAt: _ia, tenants: _tn, keyRotation: _kr, ...rest } =
    card as A2aAgentCardV11 & Record<string, unknown>;
  void _pv;
  void _vu;
  void _ia;
  void _tn;
  void _kr;
  const caps = (rest as A2aAgentCard).capabilities as
    | (A2aCardCapabilitiesV11 & Record<string, unknown>)
    | undefined;
  const downgraded: A2aAgentCard = { ...(rest as A2aAgentCard) };
  if (caps !== undefined) {
    const { resumableStreams: _rs, multiTenancy: _mt, signedCardRequired: _scr, ...oldCaps } = caps;
    void _rs;
    void _mt;
    void _scr;
    downgraded.capabilities = oldCaps as A2aAgentCard['capabilities'];
  }
  // Client 1.0 chỉ hiểu protocolVersion 1.0/1.0.1 — card v1.1 hạ xuống
  // ghi bản 1.0.1 cao nhất mà client 1.0 nói được.
  downgraded.protocolVersion = '1.0.1';
  if (Array.isArray(downgraded.supportedInterfaces)) {
    downgraded.supportedInterfaces = downgraded.supportedInterfaces.map((iface) => ({
      ...iface,
      protocolVersion: '1.0.1',
    }));
  }
  return downgraded;
}

/** Kết quả kiểm tra hạn của card. */
export interface A2aCardExpiryCheck {
  /** true khi card đã hết hạn (client nên fetch lại). */
  expired: boolean;
  /** true khi card có ghi validUntil. */
  hasExpiry: boolean;
  /** validUntil đã parse (null khi không ghi hoặc ghi sai). */
  validUntil: string | null;
  /** Số ms còn lại tới khi hết hạn (âm khi đã hết; null khi không có hạn). */
  msRemaining: number | null;
  /** Lý do khi expired=true hoặc validUntil ghi sai. */
  reason?: string;
}

/**
 * Kiểm tra hạn của card v1.1. Card không ghi `validUntil` → không
 * hết hạn (tương thích card 1.0). `nowMs` cho phép test ép thời gian.
 */
export function checkAgentCardExpiry(
  card: { validUntil?: string | null } | undefined | null,
  nowMs: number = Date.now(),
): A2aCardExpiryCheck {
  if (!card || typeof card !== 'object') {
    return { expired: false, hasExpiry: false, validUntil: null, msRemaining: null };
  }
  const raw = card.validUntil;
  if (raw === undefined || raw === null || raw === '') {
    return { expired: false, hasExpiry: false, validUntil: null, msRemaining: null };
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) {
    return {
      expired: true,
      hasExpiry: true,
      validUntil: raw,
      msRemaining: null,
      reason: `validUntil trong Agent Card không đọc được: "${raw}" — coi như card hết hạn, fetch lại.`,
    };
  }
  const remaining = at - nowMs;
  if (remaining <= 0) {
    return {
      expired: true,
      hasExpiry: true,
      validUntil: raw,
      msRemaining: remaining,
      reason: `Agent Card đã hết hạn lúc ${raw} — fetch lại card mới trước khi giao việc.`,
    };
  }
  return { expired: false, hasExpiry: true, validUntil: raw, msRemaining: remaining };
}

/** True khi card đã hết hạn (xem `checkAgentCardExpiry`). */
export function isAgentCardExpired(
  card: { validUntil?: string | null } | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  return checkAgentCardExpiry(card, nowMs).expired;
}

/**
 * Validate một Agent Card v1.1: chạy validator 1.0 trước, rồi kiểm
 * tra thêm các field v1.1 (protocolVersions hợp lệ, validUntil đọc
 * được, tenants có tenantId hợp lệ, keyRotation có currentKeyId).
 * Trả danh sách lỗi, rỗng = hợp lệ.
 */
export function validateAgentCardV11(card: unknown): string[] {
  const problems = validateAgentCard(card);
  if (typeof card !== 'object' || card === null) return problems;
  const rec = card as Record<string, unknown>;
  const versions = rec['protocolVersions'];
  if (versions !== undefined) {
    if (!Array.isArray(versions) || versions.length === 0) {
      problems.push('card.protocolVersions must be a non-empty array');
    } else {
      for (const v of versions) {
        if (typeof v !== 'string' || v.trim() === '') {
          problems.push('card.protocolVersions entries must be non-empty strings');
          break;
        }
      }
      if (
        typeof rec['protocolVersion'] === 'string' &&
        Array.isArray(versions) &&
        !versions.includes(rec['protocolVersion'])
      ) {
        problems.push('card.protocolVersion must be listed in card.protocolVersions');
      }
    }
  }
  if (rec['validUntil'] !== undefined) {
    if (typeof rec['validUntil'] !== 'string' || Number.isNaN(Date.parse(rec['validUntil']))) {
      problems.push('card.validUntil must be an ISO-8601 date string');
    }
  }
  if (rec['issuedAt'] !== undefined) {
    if (typeof rec['issuedAt'] !== 'string' || Number.isNaN(Date.parse(rec['issuedAt']))) {
      problems.push('card.issuedAt must be an ISO-8601 date string');
    }
  }
  if (rec['tenants'] !== undefined) {
    if (!Array.isArray(rec['tenants'])) {
      problems.push('card.tenants must be an array');
    } else {
      const seen = new Set<string>();
      for (const tenant of rec['tenants']) {
        if (typeof tenant !== 'object' || tenant === null) {
          problems.push('card.tenants entries must be objects');
          break;
        }
        const t = tenant as Record<string, unknown>;
        if (typeof t['tenantId'] !== 'string' || t['tenantId'].trim() === '') {
          problems.push('card.tenants entries need a tenantId');
          break;
        }
        if (seen.has(t['tenantId'] as string)) {
          problems.push(`card.tenants has duplicate tenantId "${t['tenantId'] as string}"`);
          break;
        }
        seen.add(t['tenantId'] as string);
        if (t['allowedSkillIds'] !== undefined && !Array.isArray(t['allowedSkillIds'])) {
          problems.push('card.tenants[].allowedSkillIds must be an array');
          break;
        }
      }
    }
  }
  if (rec['keyRotation'] !== undefined) {
    if (typeof rec['keyRotation'] !== 'object' || rec['keyRotation'] === null) {
      problems.push('card.keyRotation must be an object');
    } else {
      const kr = rec['keyRotation'] as Record<string, unknown>;
      if (typeof kr['currentKeyId'] !== 'string' || kr['currentKeyId'].trim() === '') {
        problems.push('card.keyRotation.currentKeyId is missing');
      }
      if (
        kr['previousKeysValidUntil'] !== undefined &&
        (typeof kr['previousKeysValidUntil'] !== 'string' ||
          Number.isNaN(Date.parse(kr['previousKeysValidUntil'] as string)))
      ) {
        problems.push('card.keyRotation.previousKeysValidUntil must be an ISO-8601 date string');
      }
    }
  }
  const caps = rec['capabilities'];
  if (caps !== undefined && typeof caps === 'object' && caps !== null) {
    const c = caps as Record<string, unknown>;
    for (const key of ['resumableStreams', 'multiTenancy', 'signedCardRequired'] as const) {
      if (c[key] !== undefined && typeof c[key] !== 'boolean') {
        problems.push(`card.capabilities.${key} must be a boolean`);
      }
    }
  }
  return problems;
}

/** True khi card v1.1 hợp lệ. */
export function isValidAgentCardV11(card: unknown): card is A2aAgentCardV11 {
  return validateAgentCardV11(card).length === 0;
}

/**
 * Tóm tắt card v1.1 cho UI/logs: tên, bản protocol cao nhất, các
 * capability bật, số skill, số tenant, còn hạn bao lâu. Không bao
 * gồm chữ ký hay key (không log secret).
 */
export function summarizeAgentCardV11(card: A2aAgentCardV11): {
  name: string;
  url: string;
  protocolVersion: string;
  protocolVersions: string[];
  capabilities: string[];
  skillCount: number;
  tenantCount: number;
  signed: boolean;
  expired: boolean;
} {
  const caps = (card.capabilities ?? {}) as A2aCardCapabilitiesV11;
  const enabled: string[] = [];
  if (caps.streaming) enabled.push('streaming');
  if (caps.pushNotifications) enabled.push('pushNotifications');
  if (caps.stateTransitionHistory) enabled.push('stateTransitionHistory');
  if (caps.resumableStreams) enabled.push('resumableStreams');
  if (caps.multiTenancy) enabled.push('multiTenancy');
  if (caps.signedCardRequired) enabled.push('signedCardRequired');
  return {
    name: card.name,
    url: card.url,
    protocolVersion: card.protocolVersion ?? A2A_CARD_PROTOCOL_VERSION,
    protocolVersions: card.protocolVersions ?? [card.protocolVersion ?? A2A_CARD_PROTOCOL_VERSION],
    capabilities: enabled,
    skillCount: card.skills?.length ?? 0,
    tenantCount: card.tenants?.length ?? 0,
    signed: card.signature !== undefined,
    expired: isAgentCardExpired(card),
  };
}
