/**
 * MCP legacy versions — ma trận tính năng theo protocol version
 * (v1.06, Đội T2).
 *
 * Một client nói được 2026-07-28 vẫn phải nói chuyện với server cũ:
 * 2025-11-25, 2025-06-18, 2024-11-05. Mỗi version có một tập tính
 * năng khác nhau — gọi method server không biết thì chỉ nhận
 * `-32601` (method not found), tệ hơn là treo chờ một tính năng
 * server không bao giờ trả. Module này là bảng tra cứu duy nhất
 * cho việc đó:
 *
 *   - `MCP_VERSION_FEATURE_MATRIX`: tính năng nào có ở version nào.
 *     Bảng này được viết theo MCP spec của từng version (ý tưởng
 *     học từ spec, không copy code/text/tài sản của repo nào).
 *   - `featuresForVersion` / `supportsFeature` / `unsupportedFeatures`:
 *     tra cứu không-throw (version lạ → coi như version cũ nhất
 *     mà client biết, an toàn hơn là đoán có).
 *   - `detectServerAge`: xếp server vào nhóm modern / legacy-2025 /
 *     legacy-2024 / unknown từ protocol version + capabilities nó
 *     khai (discovery document hoặc `initialize` result).
 *   - `chooseConnectionStrategy`: từ kết quả detect + mode cấu hình
 *     (`stateless: true | 'auto' | false`) quyết định đi stateless
 *     hay handshake truyền thống, kèm lý do + cảnh báo đọc được.
 *   - `describeVersionGap`: câu giải thích tiếng Việt khi một tính
 *     năng không có ở version của server (để UI/log hiện cho user).
 *
 * Quy tắc an toàn: version không nằm trong bảng → mọi tính năng
 * mới đều coi là KHÔNG có. Client cũ hơn server cũng vậy: chỉ dùng
 * tính năng nào CẢ HAI bên cùng có (giao của hai bảng), không dùng
 * tính năng chỉ một bên có.
 */

import {
  MCP_PROTOCOL_VERSION_2026,
  MCP_PROTOCOL_VERSIONS_2026,
} from './stateless';

/** Mọi protocol version client này biết nói (mới nhất trước). */
export const MCP_KNOWN_PROTOCOL_VERSIONS: readonly string[] = MCP_PROTOCOL_VERSIONS_2026;

/** Version cũ nhất client còn hỗ trợ. */
export const MCP_OLDEST_SUPPORTED_VERSION = '2024-11-05';

/** Các version được coi là "legacy" (trước MCP 2.0). */
export const MCP_LEGACY_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2024-11-05',
];

/** Tính năng có thể khác nhau giữa các protocol version. */
export type McpVersionFeature =
  | 'stateless'
  | 'serverDiscover'
  | 'mrtr'
  | 'tasksExtension'
  | 'tasksExperimental'
  | 'elicitationForm'
  | 'elicitationUrl'
  | 'apps'
  | 'roots'
  | 'sampling'
  | 'logging'
  | 'structuredOutput'
  | 'pagination'
  | 'icons'
  | 'progressNotifications'
  | 'completion'
  | 'prompts'
  | 'resources';

/** Mọi tính năng trong ma trận (để liệt kê / kiểm tra đầy đủ). */
export const MCP_VERSION_FEATURES: readonly McpVersionFeature[] = [
  'stateless',
  'serverDiscover',
  'mrtr',
  'tasksExtension',
  'tasksExperimental',
  'elicitationForm',
  'elicitationUrl',
  'apps',
  'roots',
  'sampling',
  'logging',
  'structuredOutput',
  'pagination',
  'icons',
  'progressNotifications',
  'completion',
  'prompts',
  'resources',
];

/**
 * Ma trận tính năng theo version (theo MCP spec từng version):
 *
 * 2024-11-05 — bản đầu client này hỗ trợ: tools/resources/prompts
 *   cơ bản, roots/sampling/logging (lúc đó chưa deprecated),
 *   progress notification, completion. Chưa có elicitation, tasks,
 *   pagination cursor chuẩn, structured output, icons, stateless.
 * 2025-06-18 — thêm structured output, pagination, icons, resource
 *   link; vẫn chưa có elicitation/tasks/stateless/MRTR.
 * 2025-11-25 — thêm elicitation (form + url) và tasks experimental
 *   (SEP-1686); sampling/roots/logging vẫn dùng được; chưa có
 *   stateless/MRTR/tasks extension chính thức/apps.
 * 2026-07-28 — MCP 2.0: stateless + server/discover + MRTR +
 *   tasks extension chính thức; sampling/roots/logging bị
 *   deprecated (vẫn chạy, xem `deprecation.ts`); elicitation chuyển
 *   sang MRTR `needs_elicitation` (server-initiated `elicitation/
 *   create` không còn là đường chính); apps có mặt.
 */
export const MCP_VERSION_FEATURE_MATRIX: Readonly<
  Record<string, Readonly<Record<McpVersionFeature, boolean>>>
> = {
  '2026-07-28': {
    stateless: true,
    serverDiscover: true,
    mrtr: true,
    tasksExtension: true,
    tasksExperimental: false,
    elicitationForm: true,
    elicitationUrl: true,
    apps: true,
    roots: true,
    sampling: true,
    logging: true,
    structuredOutput: true,
    pagination: true,
    icons: true,
    progressNotifications: true,
    completion: true,
    prompts: true,
    resources: true,
  },
  '2025-11-25': {
    stateless: false,
    serverDiscover: false,
    mrtr: false,
    tasksExtension: false,
    tasksExperimental: true,
    elicitationForm: true,
    elicitationUrl: true,
    apps: false,
    roots: true,
    sampling: true,
    logging: true,
    structuredOutput: true,
    pagination: true,
    icons: true,
    progressNotifications: true,
    completion: true,
    prompts: true,
    resources: true,
  },
  '2025-06-18': {
    stateless: false,
    serverDiscover: false,
    mrtr: false,
    tasksExtension: false,
    tasksExperimental: false,
    elicitationForm: false,
    elicitationUrl: false,
    apps: false,
    roots: true,
    sampling: true,
    logging: true,
    structuredOutput: true,
    pagination: true,
    icons: true,
    progressNotifications: true,
    completion: true,
    prompts: true,
    resources: true,
  },
  '2024-11-05': {
    stateless: false,
    serverDiscover: false,
    mrtr: false,
    tasksExtension: false,
    tasksExperimental: false,
    elicitationForm: false,
    elicitationUrl: false,
    apps: false,
    roots: true,
    sampling: true,
    logging: true,
    structuredOutput: false,
    pagination: false,
    icons: false,
    progressNotifications: true,
    completion: true,
    prompts: true,
    resources: true,
  },
};

/** Nhãn đọc được cho từng tính năng (dùng trong thông báo). */
export const MCP_VERSION_FEATURE_LABELS: Readonly<Record<McpVersionFeature, string>> = {
  stateless: 'stateless (không session)',
  serverDiscover: 'server/discover',
  mrtr: 'MRTR (multi round-trip)',
  tasksExtension: 'Tasks extension (io.modelcontextprotocol/tasks)',
  tasksExperimental: 'Tasks experimental (2025-11-25)',
  elicitationForm: 'elicitation form-mode',
  elicitationUrl: 'elicitation url-mode',
  apps: 'MCP Apps',
  roots: 'roots',
  sampling: 'sampling',
  logging: 'logging',
  structuredOutput: 'structured output',
  pagination: 'phân trang (cursor)',
  icons: 'icons',
  progressNotifications: 'progress notification',
  completion: 'completion',
  prompts: 'prompts',
  resources: 'resources',
};

/** True khi version là version client biết (nằm trong bảng). */
export function isKnownProtocolVersionStrict(version: unknown): boolean {
  return (
    typeof version === 'string' &&
    Object.prototype.hasOwnProperty.call(MCP_VERSION_FEATURE_MATRIX, version)
  );
}

/** True khi version là legacy (trước 2026-07-28). */
export function isLegacyProtocolVersion(version: unknown): boolean {
  return (
    typeof version === 'string' &&
    (MCP_LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version)
  );
}

/**
 * Chuẩn hoá version: version lạ / rỗng → version cũ nhất client
 * biết (`2024-11-05`) — an toàn hơn là đoán server có tính năng
 * mới. Version đã biết giữ nguyên.
 */
export function normalizeProtocolVersion(version: unknown): string {
  if (typeof version === 'string' && isKnownProtocolVersionStrict(version)) {
    return version;
  }
  return MCP_OLDEST_SUPPORTED_VERSION;
}

/**
 * Toàn bộ tính năng của một version. Version lạ → bảng của version
 * cũ nhất (an toàn). Không throw.
 */
export function featuresForVersion(
  version: string | undefined,
): Readonly<Record<McpVersionFeature, boolean>> {
  const normalized = normalizeProtocolVersion(version);
  return MCP_VERSION_FEATURE_MATRIX[normalized] as Readonly<
    Record<McpVersionFeature, boolean>
  >;
}

/** True khi version hỗ trợ tính năng này. */
export function supportsFeature(
  version: string | undefined,
  feature: McpVersionFeature,
): boolean {
  return featuresForVersion(version)[feature] === true;
}

/** Các tính năng trong danh sách mà version này KHÔNG hỗ trợ. */
export function unsupportedFeatures(
  version: string | undefined,
  wanted: readonly McpVersionFeature[],
): McpVersionFeature[] {
  const features = featuresForVersion(version);
  return wanted.filter((feature) => features[feature] !== true);
}

/**
 * Các tính năng CẢ HAI bên cùng hỗ trợ (giao của hai bảng) —
 * client và server chỉ nên dùng tính năng trong giao này. Version
 * nào lạ cũng được chuẩn hoá về cũ nhất trước khi giao.
 */
export function commonFeatures(
  clientVersion: string | undefined,
  serverVersion: string | undefined,
): McpVersionFeature[] {
  const client = featuresForVersion(clientVersion);
  const server = featuresForVersion(serverVersion);
  return MCP_VERSION_FEATURES.filter(
    (feature) => client[feature] === true && server[feature] === true,
  );
}

/** Nhóm tuổi của server, từ protocol version + capabilities nó khai. */
export type McpServerAge = 'modern' | 'legacy-2025' | 'legacy-2024' | 'unknown';

/** Kết quả detect tuổi server. */
export interface ServerAgeDetection {
  age: McpServerAge;
  /** Protocol version server khai (undefined khi server không khai). */
  protocolVersion?: string;
  /** True khi server khai có tasks (capability hoặc extension). */
  declaresTasks: boolean;
  /** True khi server khai có elicitation. */
  declaresElicitation: boolean;
  /** Ghi chú đọc được cho log/UI. */
  note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Xếp server vào nhóm tuổi. `capabilities` là capabilities từ
 * discovery document hoặc `initialize` result (có thể undefined).
 * Server không khai version → `unknown` (coi như cũ nhất khi tra
 * tính năng, nhưng age vẫn báo `unknown` để caller biết là đoán).
 */
export function detectServerAge(
  protocolVersion: string | undefined,
  capabilities?: Record<string, unknown>,
): ServerAgeDetection {
  const caps = isRecord(capabilities) ? capabilities : {};
  const declaresTasks =
    isRecord(caps['tasks']) ||
    (Array.isArray(caps['extensions']) &&
      (caps['extensions'] as unknown[]).includes('io.modelcontextprotocol/tasks'));
  const declaresElicitation = isRecord(caps['elicitation']);
  if (protocolVersion === MCP_PROTOCOL_VERSION_2026) {
    return {
      age: 'modern',
      protocolVersion,
      declaresTasks,
      declaresElicitation,
      note: 'Server MCP 2.0 (2026-07-28): stateless, MRTR, Tasks extension.',
    };
  }
  if (protocolVersion === '2025-11-25' || protocolVersion === '2025-06-18') {
    return {
      age: 'legacy-2025',
      protocolVersion,
      declaresTasks,
      declaresElicitation,
      note: `Server legacy ${protocolVersion}: cần handshake initialize, không có stateless/MRTR.`,
    };
  }
  if (protocolVersion === '2024-11-05') {
    return {
      age: 'legacy-2024',
      protocolVersion,
      declaresTasks,
      declaresElicitation,
      note: 'Server legacy 2024-11-05: bản cũ nhất — chỉ có tools/resources/prompts cơ bản + roots/sampling/logging.',
    };
  }
  return {
    age: 'unknown',
    ...(protocolVersion ? { protocolVersion } : {}),
    declaresTasks,
    declaresElicitation,
    note: 'Server không khai protocol version quen thuộc — coi như legacy cũ nhất khi tra tính năng.',
  };
}

/** Mode kết nối đã cấu hình (giống `McpServerConfig.stateless`). */
export type LegacyConnectMode = boolean | 'auto';

/** Cách kết nối nên dùng với server này. */
export type LegacyConnectionPath = 'stateless' | 'handshake';

/** Kết quả chọn chiến lược kết nối. */
export interface ConnectionStrategy {
  /** Đường kết nối nên dùng. */
  path: LegacyConnectionPath;
  /** Protocol version sẽ dùng sau khi kết nối. */
  protocolVersion: string;
  /** Tuổi server đã detect. */
  serverAge: McpServerAge;
  /** True khi `'auto'` đã fallback từ stateless sang handshake. */
  fellBack: boolean;
  /** Lý do chọn đường này (đọc được, để log/UI). */
  reason: string;
  /** Cảnh báo thêm (tính năng sẽ thiếu, deprecation...). */
  warnings: string[];
}

/**
 * Chọn chiến lược kết nối từ tuổi server + mode cấu hình:
 *  - server modern + mode `true`/`'auto'` → stateless.
 *  - server legacy + mode `'auto'` → handshake (fallback), kèm
 *    cảnh báo liệt kê tính năng sẽ thiếu.
 *  - server legacy + mode `true` (stateless-only) → vẫn stateless
 *    (cấu hình ép), nhưng cảnh báo rõ là server cũ có thể không
 *    hiểu `server/discover` và mọi request chỉ còn `_meta`.
 *  - mode `false` → handshake luôn, bất kể server mới hay cũ.
 *  - server `unknown` + `'auto'` → handshake (an toàn).
 */
export function chooseConnectionStrategy(
  detection: ServerAgeDetection,
  mode: LegacyConnectMode,
): ConnectionStrategy {
  const warnings: string[] = [];
  const protocolVersion = detection.protocolVersion ?? MCP_OLDEST_SUPPORTED_VERSION;
  if (mode === false) {
    return {
      path: 'handshake',
      protocolVersion,
      serverAge: detection.age,
      fellBack: false,
      reason: `Handshake initialize (cấu hình stateless=false) với server ${protocolVersion}.`,
      warnings,
    };
  }
  if (detection.age === 'modern') {
    return {
      path: 'stateless',
      protocolVersion,
      serverAge: detection.age,
      fellBack: false,
      reason: 'Server MCP 2.0 — kết nối stateless qua server/discover, không handshake, không session.',
      warnings,
    };
  }
  if (mode === true) {
    warnings.push(
      `Server ${protocolVersion} là legacy — stateless-only được ép bằng cấu hình; server có thể không hiểu server/discover, mọi request chỉ mang _meta.`,
    );
    return {
      path: 'stateless',
      protocolVersion,
      serverAge: detection.age,
      fellBack: false,
      reason: `Stateless-only (cấu hình ép) với server legacy ${protocolVersion}.`,
      warnings,
    };
  }
  // 'auto' + server legacy/unknown → fallback handshake.
  const missing = unsupportedFeatures(protocolVersion, [
    'stateless',
    'mrtr',
    'tasksExtension',
  ]);
  if (missing.length > 0) {
    warnings.push(
      `Server ${protocolVersion} thiếu: ${missing
        .map((f) => MCP_VERSION_FEATURE_LABELS[f])
        .join(', ')} — dùng handshake và tính năng tương đương cũ.`,
    );
  }
  if (!supportsFeature(protocolVersion, 'elicitationForm')) {
    warnings.push(
      `Server ${protocolVersion} không có elicitation — tool nào cần hỏi user sẽ lỗi rõ ràng thay vì treo.`,
    );
  }
  return {
    path: 'handshake',
    protocolVersion,
    serverAge: detection.age,
    fellBack: true,
    reason: `Fallback handshake initialize: server ${protocolVersion} (pre-2.0) không biết server/discover.`,
    warnings,
  };
}

/**
 * Câu giải thích khi một tính năng không có ở version của server —
 * để UI/log hiện cho user thay vì lỗi `-32601` khó hiểu. Trả null
 * khi tính năng CÓ ở version đó (không có gap để giải thích).
 */
export function describeVersionGap(
  version: string | undefined,
  feature: McpVersionFeature,
): string | null {
  if (supportsFeature(version, feature)) return null;
  const shown = version ?? '(không rõ version)';
  const label = MCP_VERSION_FEATURE_LABELS[feature];
  const introduced = firstVersionWithFeature(feature);
  const since = introduced
    ? ` — tính năng này chỉ có từ ${introduced} trở đi`
    : '';
  return (
    `Server ${shown} không hỗ trợ ${label}${since}. ` +
    `Cần server mới hơn, hoặc dùng đường tương đương cũ (nếu có).`
  );
}

/** Version đầu tiên có tính năng này (null khi không version nào có). */
export function firstVersionWithFeature(feature: McpVersionFeature): string | null {
  // Duyệt từ cũ tới mới; version đầu tiên có feature là đáp án.
  const oldestFirst = [...MCP_KNOWN_PROTOCOL_VERSIONS].reverse();
  for (const version of oldestFirst) {
    const row = MCP_VERSION_FEATURE_MATRIX[version];
    if (row && row[feature] === true) return version;
  }
  return null;
}

/**
 * Tóm tắt một dòng về hỗ trợ version của server (cho log/activity).
 * Vd: `Server 2025-11-25: elicitation + tasks (experimental); thiếu stateless/MRTR/Tasks extension.`
 */
export function describeVersionSupport(version: string | undefined): string {
  const shown = version ?? '(không rõ version)';
  const features = featuresForVersion(version);
  const present = MCP_VERSION_FEATURES.filter((f) => features[f] === true);
  const missing = MCP_VERSION_FEATURES.filter((f) => features[f] !== true);
  const presentLabel =
    present.length > 0 ? present.map((f) => MCP_VERSION_FEATURE_LABELS[f]).join(', ') : 'không có tính năng nào đã biết';
  const missingLabel =
    missing.length > 0 ? `; thiếu ${missing.map((f) => MCP_VERSION_FEATURE_LABELS[f]).join(', ')}` : '';
  return `Server ${shown}: có ${presentLabel}${missingLabel}.`;
}
