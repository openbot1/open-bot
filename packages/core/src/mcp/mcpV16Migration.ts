/**
 * Migration v15 → v16 — MCP 2026-07-28 (v1.36, Đội T3).
 *
 * Lên MCP 2.0 không phải đổi tên version: client/server cũ dùng
 * handshake `initialize`, header `Mcp-Session-Id`, callback
 * server-initiated (sampling/roots/elicitation), form elicitation
 * cho secret và Dynamic Client Registration đều phải đổi. Module
 * này là bộ kiểm tra + chuyển đổi cấu hình, không tự sửa code:
 *
 *   1. Readiness check: quét một cấu hình client/server (dạng
 *      object khai báo) và liệt kê từng vấn đề theo mức độ —
 *      blocking (chặn lên v16: còn initialize, còn gửi session id,
 *      form elicitation xin secret, DCR) và warning (nên sửa:
 *      còn dùng Roots/Sampling/Logging, extension chưa khai báo,
 *      chưa có `server/discover`).
 *   2. Chuyển đổi cấu hình: `migrateStatelessConfig()` biến config
 *      handshake cũ (initialize + session) thành options cho
 *      `StatelessClientV16` (endpoints + capabilities + protocol
 *      version), giữ lại những gì còn dùng được, bỏ những gì v16
 *      cấm và ghi rõ từng thứ đã bỏ.
 *   3. Readiness report + điểm số: tỉ lệ mục đã đạt, danh sách
 *      blocking phải sửa trước, migration path gợi ý cho từng mục
 *      (nối vào `deprecationPolicyV16.ts` khi vấn đề là deprecated
 *      capability).
 *   4. Checklist theo từng vai: client, server, app host — mỗi vai
 *      có các mục kiểm tra riêng (vd server phải có discover +
 *      MRTR input_required; app host phải declare template trước).
 *
 * Module thuần logic, không chạm mạng, không sửa file. Ideas only —
 * không copy code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
 */

import { getMigrationPathV16 } from './deprecationPolicyV16';
import { EXTENSION_APPS_ID, EXTENSION_TASKS_ID } from './extensionsV16';
import { MCP_PROTOCOL_VERSION_2026 } from './stateless';

/** Vai của bên đang migrate. */
export type V16MigrationRole = 'client' | 'server' | 'app-host';

/** Mức độ của một vấn đề migration. */
export type V16MigrationSeverity = 'blocking' | 'warning' | 'info';

/** Một mục trong readiness check. */
export interface V16MigrationIssue {
  /** Mã ổn định của vấn đề (để test / tài liệu tra cứu). */
  code: string;
  severity: V16MigrationSeverity;
  /** Vai liên quan. */
  role: V16MigrationRole;
  /** Mô tả ngắn. */
  title: string;
  /** Chi tiết + cách sửa. */
  detail: string;
  /** Mục migration path (khi có, vd từ deprecation policy). */
  migration?: string;
}

/** Cấu hình cũ (pre-2.0) cần kiểm tra / chuyển đổi. */
export interface LegacyMcpConfig {
  /** Client/server có gọi handshake `initialize` không. */
  usesInitialize?: boolean;
  /** Có gửi / nhận header `Mcp-Session-Id` không. */
  usesSessionIdHeader?: boolean;
  /** Có gọi `server/discover` không. */
  hasServerDiscover?: boolean;
  /** Protocol version đang dùng (vd '2025-11-25'). */
  protocolVersion?: string;
  /** Capability deprecated còn dùng (roots / sampling / logging). */
  deprecatedCapabilities?: string[];
  /** Server có gửi request ngược giữa tool call không (sampling / elicitation / roots). */
  usesServerInitiatedRequests?: boolean;
  /** Elicitation form có xin trường secret không. */
  formElicitsSecrets?: boolean;
  /** OAuth dùng Dynamic Client Registration không. */
  usesDynamicClientRegistration?: boolean;
  /** Extension đã khai báo (vd ['io.modelcontextprotocol/ui']). */
  declaredExtensions?: string[];
  /** App host có declare UI template trước không. */
  declaresAppTemplates?: boolean;
  /** Endpoint URL của server (để chuyển sang pool). */
  endpointUrls?: string[];
  /** Tên client/server (để ghi vào clientInfo / serverInfo). */
  name?: string;
  /** Version client/server. */
  version?: string;
}

/** Kết quả readiness check. */
export interface V16ReadinessReport {
  /** Vai đã kiểm tra. */
  role: V16MigrationRole;
  /** true khi không còn vấn đề blocking. */
  ready: boolean;
  /** Điểm readiness 0–100 (blocking trừ 25, warning trừ 10, info trừ 0). */
  score: number;
  blocking: V16MigrationIssue[];
  warnings: V16MigrationIssue[];
  info: V16MigrationIssue[];
  /** Tổng số mục đã kiểm tra. */
  checksRun: number;
  /** Tóm tắt một dòng. */
  summary: string;
}

/** Tuỳ chọn khi kiểm tra readiness. */
export interface V16ReadinessOptions {
  /** Vai cần kiểm tra (mặc định 'client'). */
  role?: V16MigrationRole;
  /** Ngày tham chiếu để tính ngày còn lại tới removal (mặc định Date.now). */
  nowMs?: number;
}

/** Điểm trừ cho từng mức độ. */
export const V16_MIGRATION_SCORE_PENALTY: Record<V16MigrationSeverity, number> = {
  blocking: 25,
  warning: 10,
  info: 0,
};

/**
 * Kiểm tra một cấu hình cũ và trả về từng vấn đề tìm thấy (chưa
 * gom thành report — dùng khi caller muốn tự trình bày).
 */
export function checkLegacyConfig(
  config: LegacyMcpConfig,
  role: V16MigrationRole = 'client',
): V16MigrationIssue[] {
  const issues: V16MigrationIssue[] = [];
  const push = (issue: V16MigrationIssue): void => {
    issues.push(issue);
  };

  if (config.usesInitialize === true) {
    push({
      code: 'uses-initialize',
      severity: 'blocking',
      role,
      title: 'Còn dùng handshake initialize',
      detail:
        'MCP 2026-07-28 bỏ initialize: mỗi request phải tự mang protocol version + capabilities trong _meta, và client phải gọi server/discover trước. Bỏ initialize, chuyển sang StatelessClientV16.',
    });
  }
  if (config.usesSessionIdHeader === true) {
    push({
      code: 'uses-session-id-header',
      severity: 'blocking',
      role,
      title: 'Còn gửi header Mcp-Session-Id',
      detail:
        'Client stateless v16 không bao giờ gửi Mcp-Session-Id (stripSessionIdHeader + assertNoSessionIdHeader). Bỏ mọi code gắn session id vào header.',
    });
  }
  if (role !== 'app-host' && config.hasServerDiscover !== true) {
    push({
      code: 'no-server-discover',
      severity: 'blocking',
      role,
      title: 'Chưa có server/discover',
      detail:
        'server/discover là điểm bắt đầu mọi phiên MCP 2.0 (thay initialize). Server phải implement method này; client phải gọi nó trước mọi method khác.',
    });
  }
  if (
    typeof config.protocolVersion === 'string' &&
    config.protocolVersion.length > 0 &&
    config.protocolVersion !== MCP_PROTOCOL_VERSION_2026
  ) {
    push({
      code: 'old-protocol-version',
      severity: 'warning',
      role,
      title: `Đang dùng protocol version ${config.protocolVersion}`,
      detail: `Nâng lên ${MCP_PROTOCOL_VERSION_2026}. Version cũ vẫn nói chuyện được với server hỗ trợ nhiều version, nhưng không có stateless/MRTR/extensions của MCP 2.0.`,
    });
  }
  for (const capability of config.deprecatedCapabilities ?? []) {
    const migration = getMigrationPathV16(capability);
    push({
      code: `uses-deprecated-${capability}`,
      severity: 'warning',
      role,
      title: `Còn dùng capability deprecated: ${capability}`,
      detail:
        `${capability} sẽ bị gỡ sớm nhất 2027-07-28 (tối thiểu 12 tháng báo trước). ` +
        (migration
          ? `Thay bằng: ${migration.replacement}`
          : 'Xem lộ trình deprecate trong deprecationPolicyV16.'),
      ...(migration ? { migration: migration.replacement } : {}),
    });
  }
  if (config.usesServerInitiatedRequests === true) {
    push({
      code: 'uses-server-initiated-requests',
      severity: 'blocking',
      role,
      title: 'Còn dùng server-initiated request giữa tool call',
      detail:
        'MCP 2.0 cấm server gửi request ngược giữa tool call (SEP-2260): server phải trả resultType input_required + inputRequests, client gọi lại method cũ kèm inputResponses + requestState (xem mrtrV16).',
    });
  }
  if (config.formElicitsSecrets === true) {
    push({
      code: 'form-elicits-secrets',
      severity: 'blocking',
      role,
      title: 'Form elicitation đang xin secret/credential',
      detail:
        'Form mode bị cấm cho password / API key / token / thanh toán — phải chuyển sang URL mode (OAuth sign-in, payment page) qua elicitationUrlV16.',
    });
  }
  if (config.usesDynamicClientRegistration === true) {
    push({
      code: 'uses-dynamic-client-registration',
      severity: 'blocking',
      role,
      title: 'OAuth còn dùng Dynamic Client Registration',
      detail:
        'Chuyển sang Client ID Metadata Documents (oauthClientIdV16): công bố metadata document tĩnh, server đối chiếu để chống reuse credential.',
    });
  }
  const declared = config.declaredExtensions ?? [];
  if (role === 'client' || role === 'server') {
    if (!declared.includes(EXTENSION_APPS_ID) && !declared.includes(EXTENSION_TASKS_ID)) {
      push({
        code: 'no-extensions-declared',
        severity: 'info',
        role,
        title: 'Chưa khai báo extension nào',
        detail:
          'Extensions mặc định tắt — nếu không dùng Apps/Tasks thì không cần khai báo. Muốn dùng thì cả client và server phải khai trong field extensions của capabilities.',
      });
    }
  }
  if (role === 'app-host' && config.declaresAppTemplates !== true) {
    push({
      code: 'app-templates-not-declared',
      severity: 'warning',
      role,
      title: 'App host chưa declare UI template trước',
      detail:
        'MCP Apps v16 yêu cầu declare template trước để host prefetch / cache / security-review (AppsHostV16). App render trực tiếp mà không qua pipeline sẽ bị chặn ở bước open.',
    });
  }
  if ((config.endpointUrls ?? []).length === 0 && (role === 'client' || role === 'server')) {
    push({
      code: 'no-endpoints',
      severity: 'warning',
      role,
      title: 'Chưa khai báo endpoint URL nào',
      detail:
        'Stateless client v16 cần ít nhất một endpoint (pool round-robin). Khai báo endpointUrls để client biết gọi vào đâu.',
    });
  }
  return issues;
}

/** Gom issues thành readiness report có điểm số. */
export function buildReadinessReport(
  config: LegacyMcpConfig,
  options: V16ReadinessOptions = {},
): V16ReadinessReport {
  const role = options.role ?? 'client';
  const issues = checkLegacyConfig(config, role);
  const blocking = issues.filter((i) => i.severity === 'blocking');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const info = issues.filter((i) => i.severity === 'info');
  let score = 100;
  for (const issue of issues) score -= V16_MIGRATION_SCORE_PENALTY[issue.severity];
  score = Math.max(0, score);
  const summary =
    blocking.length === 0 && warnings.length === 0
      ? `Sẵn sàng lên MCP ${MCP_PROTOCOL_VERSION_2026} (điểm ${score}/100).`
      : `Chưa sẵn sàng: ${blocking.length} blocking, ${warnings.length} warning (điểm ${score}/100).`;
  return {
    role,
    ready: blocking.length === 0,
    score,
    blocking,
    warnings,
    info,
    checksRun: 10,
    summary,
  };
}

/** Kết quả chuyển đổi cấu hình cũ sang options client v16. */
export interface MigratedStatelessConfig {
  /** Endpoint cho pool (giữ nguyên thứ tự khai báo). */
  endpoints: { url: string }[];
  /** Protocol version v16. */
  protocolVersion: string;
  /** Capabilities client khai trong _meta mỗi request. */
  capabilities: {
    multiRoundTrip: boolean;
    tasks: boolean;
    apps: boolean;
    deprecatedCallbacks: boolean;
  };
  /** Client info (khi config cũ có name/version). */
  clientInfo?: { name: string; version: string };
  /** Những gì đã bỏ trong lúc chuyển đổi (để operator soát lại). */
  dropped: string[];
  /** Cảnh báo trong lúc chuyển đổi (không chặn). */
  warnings: string[];
}

/**
 * Chuyển cấu hình handshake cũ thành options cho StatelessClientV16.
 * Những gì v16 cấm (initialize, session id, server-initiated
 * callback) bị bỏ và ghi vào `dropped` — hàm không ném khi gặp
 * chúng, chỉ ghi nhận, để operator chuyển đổi từng bước.
 */
export function migrateStatelessConfig(config: LegacyMcpConfig): MigratedStatelessConfig {
  const dropped: string[] = [];
  const warnings: string[] = [];
  if (config.usesInitialize === true) {
    dropped.push('initialize handshake (MCP 2026-07-28 bỏ handshake — dùng server/discover + _meta)');
  }
  if (config.usesSessionIdHeader === true) {
    dropped.push('Mcp-Session-Id header (client stateless không gửi session id)');
  }
  if (config.usesServerInitiatedRequests === true) {
    dropped.push('server-initiated requests (chuyển sang MRTR input_required)');
    warnings.push('Server vẫn gửi request ngược — phải sửa server sang MRTR trước khi client v16 gọi được.');
  }
  const endpoints = (config.endpointUrls ?? []).map((url) => ({ url }));
  if (endpoints.length === 0) {
    warnings.push('Không có endpointUrls — StatelessClientV16 cần ít nhất một endpoint để chạy.');
  }
  const declared = config.declaredExtensions ?? [];
  const capabilities = {
    multiRoundTrip: true,
    tasks: declared.includes(EXTENSION_TASKS_ID),
    apps: declared.includes(EXTENSION_APPS_ID),
    deprecatedCallbacks: (config.deprecatedCapabilities ?? []).length > 0,
  };
  if (capabilities.deprecatedCallbacks) {
    warnings.push(
      `Còn dùng capability deprecated (${(config.deprecatedCapabilities ?? []).join(', ')}) — sẽ bị gỡ sớm nhất 2027-07-28, xem deprecation report.`,
    );
  }
  return {
    endpoints,
    protocolVersion: MCP_PROTOCOL_VERSION_2026,
    capabilities,
    ...(config.name && config.version
      ? { clientInfo: { name: config.name, version: config.version } }
      : {}),
    dropped,
    warnings,
  };
}

/** Checklist migration theo vai (để UI hiển thị từng bước). */
export function migrationChecklistFor(role: V16MigrationRole): string[] {
  const common = [
    'Gọi server/discover trước mọi method khác (thay initialize).',
    'Mỗi request tự mang protocol version + capabilities trong _meta.',
    'Không gửi header Mcp-Session-Id.',
    'Khai báo extensions trong capabilities (mặc định tắt).',
  ];
  if (role === 'client') {
    return [
      ...common,
      'Xử lý resultType input_required: thu đáp án rồi gọi lại method cũ kèm inputResponses + requestState.',
      'Form elicitation không xin secret — secret đi URL mode.',
      'OAuth: validate iss bắt buộc (RFC 9207), dùng Client ID Metadata Documents.',
    ];
  }
  if (role === 'server') {
    return [
      ...common,
      'Implement server/discover (protocol version + capabilities + extensions).',
      'Không gửi request ngược giữa tool call — trả input_required + inputRequests.',
      'Handler idempotent trước điểm cần input; không giữ secret trong requestState.',
      'Roots/Sampling/Logging: lên kế hoạch bỏ trước 2027-07-28.',
    ];
  }
  return [
    'Declare UI template trước (AppsHostV16: declare → prefetch → review → open).',
    'Chỉ mở app khi extension Apps đã negotiate bật.',
    'Kiểm tra hash HTML lúc mở khớp hash lúc prefetch.',
    'Sandbox profile privileged cần review ghi chú tường minh.',
  ];
}
