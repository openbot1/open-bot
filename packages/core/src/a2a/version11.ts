/**
 * A2A protocol version negotiation v1.1 (v1.09, Đội T4).
 *
 * Mở rộng `version.ts` (1.0/1.0.1) lên 1.1 mà không đổi hành vi cũ:
 * `negotiateProtocolVersion` vẫn đàm phán trong major 1.x; module
 * này thêm bản 1.1 vào danh sách hỗ trợ và bảng tính năng theo bản
 * (feature matrix) để client biết sau khi đàm phán thì được dùng
 * tính năng nào.
 *
 * Quy tắc tương thích (giữ nguyên từ v0.97):
 *  - Cùng major 1.x → tương thích; bản đàm phán = min(max(client),
 *    max(server)) — bản chung cao nhất cả hai đều nói được.
 *  - Khác major → không tương thích, từ chối với lý do rõ ràng.
 *  - Card không ghi version → coi như 1.0 (server cũ).
 *
 * Tính năng theo bản (cộng dồn — bản mới có mọi tính năng bản cũ):
 *  - 1.0: task cơ bản, message/artifact, streaming SSE, push config.
 *  - 1.0.1: + stateTransitionHistory (lịch sử chuyển trạng thái).
 *  - 1.1: + resumableStreams (resume stream sau ngắt), + multiTenancy
 *    (card theo tenant), + signedCardRequired (khai báo mutual auth),
 *    + cardExpiry (validUntil), + protocolVersions (đàm phán nhiều bản).
 */

import {
  A2A_MIN_PROTOCOL_VERSION,
  A2A_PROTOCOL_VERSION,
  A2A_SUPPORTED_PROTOCOL_VERSIONS,
  compareA2aProtocolVersions,
  negotiateProtocolVersion,
  parseA2aProtocolVersion,
} from './version';
import type { A2aNegotiationResult, A2aParsedVersion } from './version';

/** Bản protocol mới nhất open-bot nói (v1.1). */
export const A2A_PROTOCOL_VERSION_V11 = '1.1';

/** Mọi bản protocol open-bot hỗ trợ, mới nhất trước. */
export const A2A_SUPPORTED_PROTOCOL_VERSIONS_V11: readonly string[] = [
  A2A_PROTOCOL_VERSION_V11,
  ...A2A_SUPPORTED_PROTOCOL_VERSIONS,
];

/** Tính năng đàm phán được theo bản protocol. */
export type A2aProtocolFeature =
  | 'basicTasks'
  | 'streaming'
  | 'pushNotifications'
  | 'stateTransitionHistory'
  | 'resumableStreams'
  | 'multiTenancy'
  | 'signedCardRequired'
  | 'cardExpiry'
  | 'multiVersionNegotiation';

/** Nhãn hiển thị cho từng tính năng (dùng cho UI/logs, không phải i18n). */
export const A2A_PROTOCOL_FEATURE_LABELS: Record<A2aProtocolFeature, string> = {
  basicTasks: 'Task cơ bản (message/artifact)',
  streaming: 'Streaming task updates (SSE)',
  pushNotifications: 'Push notifications',
  stateTransitionHistory: 'Lịch sử chuyển trạng thái task',
  resumableStreams: 'Resume stream sau ngắt kết nối',
  multiTenancy: 'Multi-tenancy (card theo tenant)',
  signedCardRequired: 'Yêu cầu client trình card đã ký',
  cardExpiry: 'Card có hạn sử dụng (validUntil)',
  multiVersionNegotiation: 'Đàm phán nhiều bản protocol',
};

/**
 * Tính năng một bản protocol có, theo bảng cộng dồn. Bản lạ (không
 * parse được) → không có tính năng nào; bản 0.x → chỉ task cơ bản
 * (không đàm phán được, nhưng hàm này vẫn mô tả được nó).
 */
export function featuresForProtocolVersion(version: string | undefined | null): A2aProtocolFeature[] {
  const parsed = parseA2aProtocolVersion(version);
  if (!parsed) return [];
  const v10 = parseA2aProtocolVersion('1.0');
  const v101 = parseA2aProtocolVersion('1.0.1');
  const v11 = parseA2aProtocolVersion('1.1');
  if (!v10 || !v101 || !v11) return [];
  const features: A2aProtocolFeature[] = ['basicTasks'];
  if (compareA2aProtocolVersions(parsed, v10) >= 0 && parsed.major === 1) {
    features.push('streaming', 'pushNotifications');
  }
  if (compareA2aProtocolVersions(parsed, v101) >= 0 && parsed.major === 1) {
    features.push('stateTransitionHistory');
  }
  if (compareA2aProtocolVersions(parsed, v11) >= 0 && parsed.major === 1) {
    features.push(
      'resumableStreams',
      'multiTenancy',
      'signedCardRequired',
      'cardExpiry',
      'multiVersionNegotiation',
    );
  }
  return features;
}

/** True khi bản protocol này có tính năng đó. */
export function protocolVersionHasFeature(
  version: string | undefined | null,
  feature: A2aProtocolFeature,
): boolean {
  return featuresForProtocolVersion(version).includes(feature);
}

/** Tính năng chung của hai bản (giao nhau) — dùng sau khi đàm phán. */
export function commonProtocolFeatures(
  a: string | undefined | null,
  b: string | undefined | null,
): A2aProtocolFeature[] {
  const fa = featuresForProtocolVersion(a);
  const fb = new Set(featuresForProtocolVersion(b));
  return fa.filter((f) => fb.has(f));
}

export interface A2aNegotiationV11Result extends A2aNegotiationResult {
  /** Tính năng dùng được ở bản đã đàm phán (rỗng khi đàm phán lỗi). */
  features: A2aProtocolFeature[];
  /** Tính năng client muốn mà bản đàm phán không có (để cảnh báo). */
  missingFeatures: A2aProtocolFeature[];
}

/**
 * Đàm phán bản protocol chung trong major 1.x, kể cả 1.1. Dùng
 * `negotiateProtocolVersion` (1.0) cho phần đàm phán rồi cộng thêm
 * bảng tính năng. Danh sách trống một bên → coi như bên đó chỉ nói
 * bản mặc định của open-bot (1.1).
 */
export function negotiateProtocolVersionV11(
  clientVersions: readonly string[] | undefined | null,
  serverVersions: readonly string[] | undefined | null,
  wantedFeatures: readonly A2aProtocolFeature[] = [],
): A2aNegotiationV11Result {
  const clientList =
    Array.isArray(clientVersions) && clientVersions.length > 0
      ? clientVersions
      : [A2A_PROTOCOL_VERSION_V11];
  const serverList =
    Array.isArray(serverVersions) && serverVersions.length > 0
      ? serverVersions
      : [A2A_PROTOCOL_VERSION_V11];
  // negotiateProtocolVersion dùng A2A_SUPPORTED... 1.0 làm "max của
  // open-bot" — không đúng khi client/server đều nói 1.1, nên đàm phán
  // trực tiếp ở đây bằng cùng quy tắc: min(max(client), max(server)).
  const min = parseA2aProtocolVersion(A2A_MIN_PROTOCOL_VERSION);
  const ownMajor = parseA2aProtocolVersion(A2A_PROTOCOL_VERSION)?.major ?? 1;
  const usable = (list: readonly string[]): A2aParsedVersion[] =>
    list
      .map((v) => parseA2aProtocolVersion(v))
      .filter(
        (v): v is A2aParsedVersion =>
          v !== null &&
          v.major === ownMajor &&
          min !== null &&
          compareA2aProtocolVersions(v, min) >= 0,
      );
  const clientUsable = usable(clientList);
  const serverUsable = usable(serverList);
  if (clientUsable.length === 0 || serverUsable.length === 0) {
    const base = negotiateProtocolVersion(clientList, serverList);
    return {
      ...base,
      features: [],
      missingFeatures: [...wantedFeatures],
    };
  }
  const maxOf = (list: NonNullable<ReturnType<typeof parseA2aProtocolVersion>>[]) =>
    [...list].sort(compareA2aProtocolVersions).pop() as NonNullable<
      ReturnType<typeof parseA2aProtocolVersion>
    >;
  const clientMax = maxOf(clientUsable);
  const serverMax = maxOf(serverUsable);
  const best = compareA2aProtocolVersions(clientMax, serverMax) <= 0 ? clientMax : serverMax;
  const features = featuresForProtocolVersion(best.raw);
  const featureSet = new Set(features);
  const unsupported = clientList.filter((v) => {
    const p = parseA2aProtocolVersion(v);
    return !p || p.major !== ownMajor || (min !== null && compareA2aProtocolVersions(p, min) < 0);
  });
  return {
    ok: true,
    negotiated: best.raw,
    ...(unsupported.length > 0 ? { unsupportedRequested: unsupported } : {}),
    features,
    missingFeatures: wantedFeatures.filter((f) => !featureSet.has(f)),
  };
}

export interface A2aCardVersionCheckV11 {
  /** true khi card dùng được (tương thích major 1.x). */
  ok: boolean;
  /** Bản protocol trong card (null khi card không ghi — coi như 1.0). */
  cardVersion: string | null;
  /** Mọi bản card khai hỗ trợ (protocolVersions, rỗng khi card 1.0 cũ). */
  cardVersions: string[];
  /** Bản sẽ dùng khi giao tiếp với agent này. */
  negotiated: string | null;
  /** Tính năng dùng được ở bản đã đàm phán. */
  features: A2aProtocolFeature[];
  /** Cảnh báo không chặn (vd card không ghi version, bản cũ). */
  warnings: string[];
  /** Lý do khi ok=false. */
  reason?: string;
}

/**
 * Kiểm tra protocol version trong một Agent Card v1.1 (hoặc 1.0):
 * đọc `protocolVersions` khi có (đàm phán nhiều bản), fallback về
 * `protocolVersion` đơn lẻ. Card thiếu version → coi như 1.0 +
 * cảnh báo; card major khác → ok=false.
 */
export function checkAgentCardVersionV11(
  card:
    | { protocolVersion?: string | null; protocolVersions?: readonly string[] | null }
    | undefined
    | null,
): A2aCardVersionCheckV11 {
  if (!card || typeof card !== 'object') {
    return {
      ok: false,
      cardVersion: null,
      cardVersions: [],
      negotiated: null,
      features: [],
      warnings: [],
      reason: 'Không có Agent Card để kiểm tra protocol version.',
    };
  }
  const versions = Array.isArray(card.protocolVersions)
    ? [...card.protocolVersions]
    : [];
  const raw = typeof card.protocolVersion === 'string' ? card.protocolVersion : null;
  if (versions.length === 0 && (raw === null || raw.trim().length === 0)) {
    return {
      ok: true,
      cardVersion: null,
      cardVersions: [],
      negotiated: A2A_MIN_PROTOCOL_VERSION,
      features: featuresForProtocolVersion(A2A_MIN_PROTOCOL_VERSION),
      warnings: [
        'Agent Card không ghi protocolVersion — coi như 1.0 (agent cũ, trước version negotiation).',
      ],
    };
  }
  const offered = versions.length > 0 ? versions : raw !== null ? [raw] : [];
  const result = negotiateProtocolVersionV11(offered, [...A2A_SUPPORTED_PROTOCOL_VERSIONS_V11]);
  if (!result.ok || result.negotiated === null) {
    return {
      ok: false,
      cardVersion: raw,
      cardVersions: offered,
      negotiated: null,
      features: [],
      warnings: [],
      reason: result.reason,
    };
  }
  const warnings: string[] = [];
  const negotiatedParsed = parseA2aProtocolVersion(result.negotiated);
  const latestParsed = parseA2aProtocolVersion(A2A_PROTOCOL_VERSION_V11);
  if (
    negotiatedParsed &&
    latestParsed &&
    compareA2aProtocolVersions(negotiatedParsed, latestParsed) < 0
  ) {
    warnings.push(
      `Agent dùng protocol ${result.negotiated} (cũ hơn ${A2A_PROTOCOL_VERSION_V11} của open-bot) — vẫn tương thích, một số tính năng mới có thể thiếu.`,
    );
  }
  if (versions.length === 0) {
    warnings.push(
      'Agent Card chỉ ghi một protocolVersion (card 1.0) — không đàm phán được nhiều bản, tính năng v1.1 có thể thiếu.',
    );
  }
  return {
    ok: true,
    cardVersion: raw,
    cardVersions: offered,
    negotiated: result.negotiated,
    features: result.features,
    warnings,
  };
}

/**
 * Header version client v1.1 gửi kèm mỗi request A2A. Server cũ bỏ
 * qua header lạ nên gửi kèm là an toàn; server v1.1 đọc để biết
 * client nói được tới bản nào trước cả khi đọc card.
 */
export function a2aVersionHeaderV11(): Record<string, string> {
  return {
    'A2A-Version': A2A_PROTOCOL_VERSION_V11,
    'A2A-Versions': A2A_SUPPORTED_PROTOCOL_VERSIONS_V11.join(', '),
  };
}
