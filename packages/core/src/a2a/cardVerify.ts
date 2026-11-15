/**
 * Xác thực Agent Card trước khi kết nối (v1.09, Đội T4) — A2A v1.1.
 *
 * Trước đây client chỉ *đọc* card (`fetchCheckedAgentCard`: version +
 * chữ ký) rồi caller tự quyết. Module này gộp mọi kiểm tra thành một
 * "cổng" duy nhất trước khi giao task:
 *   1. Card hợp lệ (validate 1.0 + field v1.1).
 *   2. Version đàm phán được (v1.1, fallback 1.0).
 *   3. Chữ ký Ed25519 khớp nội dung (card bị sửa sau khi ký → chặn).
 *   4. Card chưa hết hạn (`validUntil`, card 1.0 không có hạn → qua).
 *   5. Policy của user/server: có bắt buộc ký không, bản tối thiểu,
 *      key nào bị chặn, key nào được phép.
 *   6. Trust store (trust-on-first-use): key mới → cảnh báo lần đầu;
 *      key đổi so với key đã trust cho cùng URL → chặn (có thể là
 *      giả mạo) TRỪ khi card khai `keyRotation` hợp lệ giải thích
 *      việc đổi key.
 *
 * Không gọi mạng, không đọc file. `verifyCardForConnect` nhận card
 * đã fetch (caller dùng `fetchAgentCard`/`fetchCheckedAgentCard`).
 * Trust store ở đây là in-memory; app lưu fingerprint đã trust
 * xuống disk bằng store của mình rồi nạp lại vào đây.
 */

import { validateAgentCard } from './card';
import { checkAgentCardExpiry } from './cardV11';
import type { A2aAgentCardV11 } from './cardV11';
import { verifyAgentCardSignature } from './signing';
import type { A2aSignatureVerification } from './signing';
import { checkAgentCardVersionV11 } from './version11';
import type { A2aCardVersionCheckV11, A2aProtocolFeature } from './version11';
import type { A2aAgentCard } from './types';

/** Policy cổng kết nối — user/server đặt, mặc định nới lỏng (tương thích agent cũ). */
export interface A2aCardConnectPolicy {
  /**
   * Bắt buộc card có chữ ký hợp lệ. Mặc định false (agent cũ không
   * ký vẫn dùng được, nhưng kết quả sẽ cảnh báo unsigned).
   */
  requireSigned?: boolean;
  /**
   * Bản protocol tối thiểu chấp nhận (vd '1.1' để chỉ nói với agent
   * v1.1). Mặc định '1.0' (mọi agent 1.x).
   */
  minVersion?: string;
  /** Tính năng bắt buộc phải có ở bản đàm phán (vd ['resumableStreams']). */
  requiredFeatures?: A2aProtocolFeature[];
  /**
   * Chỉ chấp nhận key có fingerprint trong danh sách này (allowlist).
   * Rỗng/absent = chấp nhận mọi key ký đúng.
   */
  allowedKeyIds?: string[];
  /** Từ chối key có fingerprint trong danh sách này (blocklist). */
  blockedKeyIds?: string[];
  /**
   * Bắt buộc card còn hạn (có `validUntil` và chưa hết). Mặc định
   * false — card 1.0 không có hạn vẫn qua, card v1.1 hết hạn thì
   * luôn bị chặn dù policy này false.
   */
  requireExpiry?: boolean;
  /**
   * Chặn key đổi so với key đã trust cho cùng URL (trust store).
   * Mặc định true — trừ khi card khai keyRotation hợp lệ.
   */
  blockKeyChange?: boolean;
}

/** Mặc định policy: tương thích agent cũ, chỉ chặn card hỏng/chữ ký sai/hết hạn. */
export const DEFAULT_A2A_CARD_CONNECT_POLICY: Required<
  Pick<A2aCardConnectPolicy, 'requireSigned' | 'minVersion' | 'requireExpiry' | 'blockKeyChange'>
> = {
  requireSigned: false,
  minVersion: '1.0',
  requireExpiry: false,
  blockKeyChange: true,
};

/** Một kiểm tra trong cổng kết nối. */
export interface A2aCardCheckItem {
  /** Tên kiểm tra (ổn định, để UI/test đối chiếu). */
  id:
    | 'valid'
    | 'version'
    | 'signature'
    | 'expiry'
    | 'policy'
    | 'trust';
  /** true = qua, false = chặn/cảnh báo (xem `blocking`). */
  ok: boolean;
  /** true = lỗi này chặn kết nối; false = chỉ cảnh báo. */
  blocking: boolean;
  /** Thông điệp cho user (tiếng Việt). */
  message: string;
}

/** Kết quả cổng kết nối — caller chỉ cần đọc `allowed` + `checks`. */
export interface A2aCardConnectResult {
  /** true khi được phép giao task với agent này. */
  allowed: boolean;
  /** Bản protocol sẽ dùng (null khi không đàm phán được). */
  negotiatedVersion: string | null;
  /** Tính năng dùng được ở bản đã đàm phán. */
  features: A2aProtocolFeature[];
  /** Từng kiểm tra (theo thứ tự chạy). */
  checks: A2aCardCheckItem[];
  /** Cảnh báo không chặn (để UI hiện). */
  warnings: string[];
  /** Lý do chặn đầu tiên (khi allowed=false). */
  reason?: string;
  /** Kiểm tra version chi tiết (để caller dùng tiếp). */
  version: A2aCardVersionCheckV11;
  /** Kiểm tra chữ ký chi tiết. */
  signature: A2aSignatureVerification;
  /** true khi key ký là key mới (chưa từng gặp ở URL này). */
  firstSeenKey: boolean;
  /** true khi key ký khác key đã trust cho URL này. */
  keyChanged: boolean;
}

/**
 * Ghi nhớ fingerprint key đã trust cho từng agent URL (trust-on-
 * first-use, như SSH host key). Key mới → firstSeen; key đổi →
 * keyChanged (nghi giả mạo, trừ khi keyRotation giải thích).
 */
export class A2aTrustStore {
  private readonly trusted = new Map<string, Set<string>>();
  /** Số URL đang được theo dõi. */
  get urlCount(): number {
    return this.trusted.size;
  }

  /** Fingerprint đã trust cho URL này (bản copy). */
  keyIdsFor(url: string): string[] {
    const set = this.trusted.get(normalizeTrustUrl(url));
    return set ? [...set] : [];
  }

  /** True khi key này đã được trust cho URL này. */
  isTrusted(url: string, keyId: string): boolean {
    return this.trusted.get(normalizeTrustUrl(url))?.has(keyId) ?? false;
  }

  /** True khi URL này đã từng trust key nào đó (dù khác keyId). */
  hasAnyTrustedKey(url: string): boolean {
    return (this.trusted.get(normalizeTrustUrl(url))?.size ?? 0) > 0;
  }

  /**
   * Ghi trust cho key này ở URL này (user xác nhận key mới). Trả
   * true khi đây là key mới (chưa trust trước đó).
   */
  trust(url: string, keyId: string): boolean {
    const key = normalizeTrustUrl(url);
    let set = this.trusted.get(key);
    if (!set) {
      set = new Set();
      this.trusted.set(key, set);
    }
    const isNew = !set.has(keyId);
    set.add(keyId);
    return isNew;
  }

  /** Quên mọi key đã trust của một URL (vd user gỡ trust agent). */
  forgetUrl(url: string): boolean {
    return this.trusted.delete(normalizeTrustUrl(url));
  }

  /** Quên một key cụ thể của một URL. */
  forgetKey(url: string, keyId: string): boolean {
    const set = this.trusted.get(normalizeTrustUrl(url));
    if (!set) return false;
    const removed = set.delete(keyId);
    if (set.size === 0) this.trusted.delete(normalizeTrustUrl(url));
    return removed;
  }

  /** Xoá toàn bộ trust store (test/reset). */
  clear(): void {
    this.trusted.clear();
  }

  /** Xuất trust store thành JSON (để app lưu disk). */
  toJSON(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [url, set] of [...this.trusted.entries()].sort()) out[url] = [...set].sort();
    return out;
  }

  /** Nạp trust store từ JSON (bỏ qua entry sai định dạng). */
  static fromJSON(data: unknown): A2aTrustStore {
    const store = new A2aTrustStore();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return store;
    for (const [url, keyIds] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(keyIds)) continue;
      for (const keyId of keyIds) {
        if (typeof keyId === 'string' && keyId.length > 0) store.trust(url, keyId);
      }
    }
    return store;
  }
}

/** Chuẩn hoá URL làm key trust store (bỏ `/` cuối, lowercase host). */
export function normalizeTrustUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

/**
 * Kiểm tra keyRotation trong card có giải thích việc đổi key không:
 * key mới phải là `currentKeyId`, key cũ phải nằm trong
 * `previousKeyIds` và chưa quá `previousKeysValidUntil`.
 */
export function keyRotationExplainsChange(
  card: A2aAgentCardV11 | undefined | null,
  oldKeyId: string,
  newKeyId: string,
  nowMs: number = Date.now(),
): boolean {
  const rotation = card?.keyRotation;
  if (!rotation) return false;
  if (rotation.currentKeyId !== newKeyId) return false;
  if (!rotation.previousKeyIds?.includes(oldKeyId)) return false;
  if (rotation.previousKeysValidUntil !== undefined) {
    const until = Date.parse(rotation.previousKeysValidUntil);
    if (!Number.isNaN(until) && nowMs > until) return false;
  }
  return true;
}

/**
 * Cổng kết nối: chạy mọi kiểm tra trên card đã fetch. Không throw
 * với card sai — trả `allowed=false` + lý do; chỉ throw khi input
 * không phải object (lỗi lập trình của caller).
 */
export function verifyCardForConnect(
  card: A2aAgentCard | A2aAgentCardV11 | unknown,
  options: {
    policy?: A2aCardConnectPolicy;
    trustStore?: A2aTrustStore | null;
    /** URL agent (để tra trust store); mặc định lấy `card.url`. */
    agentUrl?: string;
    nowMs?: number;
  } = {},
): A2aCardConnectResult {
  const policy: A2aCardConnectPolicy = {
    requireSigned: options.policy?.requireSigned ?? DEFAULT_A2A_CARD_CONNECT_POLICY.requireSigned,
    minVersion: options.policy?.minVersion ?? DEFAULT_A2A_CARD_CONNECT_POLICY.minVersion,
    requireExpiry: options.policy?.requireExpiry ?? DEFAULT_A2A_CARD_CONNECT_POLICY.requireExpiry,
    blockKeyChange: options.policy?.blockKeyChange ?? DEFAULT_A2A_CARD_CONNECT_POLICY.blockKeyChange,
    ...(options.policy?.requiredFeatures !== undefined
      ? { requiredFeatures: [...options.policy.requiredFeatures] }
      : {}),
    ...(options.policy?.allowedKeyIds !== undefined
      ? { allowedKeyIds: [...options.policy.allowedKeyIds] }
      : {}),
    ...(options.policy?.blockedKeyIds !== undefined
      ? { blockedKeyIds: [...options.policy.blockedKeyIds] }
      : {}),
  };
  const nowMs = options.nowMs ?? Date.now();
  const checks: A2aCardCheckItem[] = [];
  const warnings: string[] = [];
  const version = checkAgentCardVersionV11(
    (card as { protocolVersion?: string; protocolVersions?: string[] } | null) ?? null,
  );
  const signature = verifyAgentCardSignature(card as Record<string, unknown> | null);
  const agentUrl =
    options.agentUrl ??
    (typeof card === 'object' && card !== null && typeof (card as Record<string, unknown>)['url'] === 'string'
      ? ((card as Record<string, unknown>)['url'] as string)
      : '');
  const trustStore = options.trustStore ?? null;
  const trustedKeys = trustStore && agentUrl ? trustStore.keyIdsFor(agentUrl) : [];
  const firstSeenKey =
    signature.ok && signature.keyId !== null
      ? trustedKeys.length > 0 && !trustedKeys.includes(signature.keyId)
        ? false
        : trustedKeys.length === 0
      : false;
  // firstSeen = key chưa từng gặp ở URL này (kể cả URL chưa có key nào).
  const isFirstSeen =
    signature.ok && signature.keyId !== null && !trustedKeys.includes(signature.keyId);
  const keyChanged =
    signature.ok &&
    signature.keyId !== null &&
    trustedKeys.length > 0 &&
    !trustedKeys.includes(signature.keyId);
  void firstSeenKey;

  // 1. Card hợp lệ.
  const validProblems = validateAgentCard(card);
  if (validProblems.length > 0) {
    checks.push({
      id: 'valid',
      ok: false,
      blocking: true,
      message: `Agent Card không hợp lệ: ${validProblems.join('; ')}.`,
    });
  } else {
    checks.push({ id: 'valid', ok: true, blocking: false, message: 'Agent Card hợp lệ.' });
  }

  // 2. Version đàm phán được + đạt bản tối thiểu.
  if (!version.ok || version.negotiated === null) {
    checks.push({
      id: 'version',
      ok: false,
      blocking: true,
      message: version.reason ?? 'Không đàm phán được protocol version.',
    });
  } else {
    const min = policy.minVersion ?? '1.0';
    const belowMin = versionBelow(version.negotiated, min);
    if (belowMin) {
      checks.push({
        id: 'version',
        ok: false,
        blocking: true,
        message: `Agent chỉ nói protocol ${version.negotiated}, thấp hơn bản tối thiểu ${min} mà policy yêu cầu.`,
      });
    } else {
      checks.push({
        id: 'version',
        ok: true,
        blocking: false,
        message: `Đàm phán protocol ${version.negotiated}.`,
      });
    }
    for (const warning of version.warnings) warnings.push(warning);
    const missing = (policy.requiredFeatures ?? []).filter((f) => !version.features.includes(f));
    if (missing.length > 0) {
      checks.push({
        id: 'version',
        ok: false,
        blocking: true,
        message: `Agent thiếu tính năng bắt buộc ở bản ${version.negotiated}: ${missing.join(', ')}.`,
      });
    }
  }

  // 3. Chữ ký.
  if (signature.unsigned) {
    if (policy.requireSigned) {
      checks.push({
        id: 'signature',
        ok: false,
        blocking: true,
        message: 'Agent Card không có chữ ký, mà policy yêu cầu card phải ký.',
      });
    } else {
      checks.push({
        id: 'signature',
        ok: false,
        blocking: false,
        message: 'Agent Card không có chữ ký — chưa xác minh được danh tính agent, chỉ dùng khi bạn tin URL này.',
      });
      warnings.push('Agent Card không có chữ ký.');
    }
  } else if (!signature.ok) {
    checks.push({
      id: 'signature',
      ok: false,
      blocking: true,
      message: signature.reason ?? 'Chữ ký Agent Card không hợp lệ.',
    });
  } else {
    // Key nằm blocklist / ngoài allowlist → chặn.
    if (policy.blockedKeyIds?.includes(signature.keyId ?? '')) {
      checks.push({
        id: 'signature',
        ok: false,
        blocking: true,
        message: `Key ký card (${signature.keyId}) nằm trong blocklist.`,
      });
    } else if (
      policy.allowedKeyIds !== undefined &&
      policy.allowedKeyIds.length > 0 &&
      !policy.allowedKeyIds.includes(signature.keyId ?? '')
    ) {
      checks.push({
        id: 'signature',
        ok: false,
        blocking: true,
        message: `Key ký card (${signature.keyId}) không nằm trong allowlist.`,
      });
    } else {
      checks.push({
        id: 'signature',
        ok: true,
        blocking: false,
        message: `Chữ ký hợp lệ (key ${signature.keyId?.slice(0, 12)}…).`,
      });
    }
  }

  // 4. Hạn card.
  const expiry = checkAgentCardExpiry(
    (card as { validUntil?: string } | null) ?? null,
    nowMs,
  );
  if (expiry.expired) {
    checks.push({
      id: 'expiry',
      ok: false,
      blocking: true,
      message: expiry.reason ?? 'Agent Card đã hết hạn.',
    });
  } else if (policy.requireExpiry && !expiry.hasExpiry) {
    checks.push({
      id: 'expiry',
      ok: false,
      blocking: true,
      message: 'Policy yêu cầu card phải có hạn sử dụng (validUntil) mà card này không có.',
    });
  } else {
    checks.push({
      id: 'expiry',
      ok: true,
      blocking: false,
      message: expiry.hasExpiry ? 'Agent Card còn hạn.' : 'Agent Card không ghi hạn sử dụng.',
    });
  }

  // 5. Trust store: key đổi.
  if (keyChanged && signature.keyId !== null && policy.blockKeyChange) {
    const explained = keyRotationExplainsChange(
      card as A2aAgentCardV11,
      trustedKeys[0],
      signature.keyId,
      nowMs,
    );
    if (explained) {
      checks.push({
        id: 'trust',
        ok: true,
        blocking: false,
        message: 'Agent đã rotate key ký (khai trong card.keyRotation) — key mới hợp lệ.',
      });
      warnings.push('Agent vừa rotate key ký card; key cũ vẫn được chấp nhận trong thời gian chuyển đổi.');
    } else {
      checks.push({
        id: 'trust',
        ok: false,
        blocking: true,
        message:
          `Key ký card đã đổi so với key đã trust cho ${agentUrl || 'agent này'} ` +
          `(cũ ${trustedKeys[0]?.slice(0, 12)}…, mới ${signature.keyId.slice(0, 12)}…) — có thể là giả mạo. ` +
          `Xác minh fingerprint với chủ agent rồi trust lại.`,
      });
    }
  } else if (isFirstSeen && signature.keyId !== null) {
    checks.push({
      id: 'trust',
      ok: true,
      blocking: false,
      message: `Key ký mới (fingerprint ${signature.keyId.slice(0, 16)}…) — lần đầu gặp, kiểm tra rồi trust.`,
    });
    warnings.push('Key ký card mới — kiểm tra fingerprint với chủ agent trước khi trust.');
  } else {
    checks.push({ id: 'trust', ok: true, blocking: false, message: 'Key ký đã được trust từ trước.' });
  }

  const blocking = checks.find((c) => !c.ok && c.blocking);
  return {
    allowed: blocking === undefined,
    negotiatedVersion: version.negotiated,
    features: version.features,
    checks,
    warnings,
    ...(blocking ? { reason: blocking.message } : {}),
    version,
    signature,
    firstSeenKey: isFirstSeen,
    keyChanged,
  };
}

/** True khi `version` thấp hơn `min` (so semver major.minor.patch). */
function versionBelow(version: string, min: string): boolean {
  const parse = (raw: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])];
  };
  const v = parse(version);
  const m = parse(min);
  if (!v || !m) return true;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== m[i]) return v[i] < m[i];
  }
  return false;
}
