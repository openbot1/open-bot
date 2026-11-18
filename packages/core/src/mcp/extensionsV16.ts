/**
 * Extension negotiation v16 — MCP 2026-07-28 (v1.36, Đội T3).
 *
 * Từ MCP 2026-07-28, extensions là cơ chế chính thức để mở rộng
 * protocol: client và server thương lượng qua field `extensions`
 * trong capabilities, và mọi extension MẶC ĐỊNH TẮT — một tính năng
 * chỉ bật khi cả hai phía cùng khai báo nó (cùng version tương
 * thích). Sóng trước đã có thương lượng capability tổng quát
 * (`capabilityNegotiation.ts`, `capabilityNegotiationV2.ts`) và
 * parser discover trả về `extensions: string[]`; v16 xây lớp
 * negotiation chuyên cho extensions:
 *
 *   - Registry extension đã biết: MCP Apps (`io.modelcontextprotocol/ui`,
 *     ổn định 01/2026, SEP-1865) và Tasks (`io.modelcontextprotocol/tasks`,
 *     dự kiến vào core). Extension lạ (chưa biết) không bị cấm —
 *     nó được ghi nhận là `unknown` và mặc định tắt, để server/client
 *     mới thử nghiệm mà không phá client cũ.
 *   - Thương lượng hai chiều: client khai `requested`, server khai
 *     `supported`; kết quả là giao nhau + kiểm tra version; mỗi
 *     extension có trạng thái enabled/disabled + lý do.
 *   - Version tương thích: version dạng ngày `YYYY-MM-DD` (chuẩn
 *     MCP) hoặc semver; client chấp nhận server version >= version
 *     tối thiểu của mình khi cùng major/dòng ngày.
 *   - Gate: `isExtensionEnabled()` là điểm kiểm tra duy nhất trước
 *     khi dùng một tính năng extension (vd host chỉ serve MCP App
 *     khi Apps đã negotiate — xem `appsV16.ts`).
 *
 * Module thuần logic, không chạm mạng. Ideas only — không copy
 * code/text/tài sản của bất kỳ repo nào, của xAI/Cursor.
 */

import type { ServerDiscoverResult } from './stateless';

/** Id chuẩn của extension MCP Apps. */
export const EXTENSION_APPS_ID = 'io.modelcontextprotocol/ui' as const;
/** Id chuẩn của extension Tasks. */
export const EXTENSION_TASKS_ID = 'io.modelcontextprotocol/tasks' as const;

/** Version ổn định đầu tiên của extension Apps. */
export const EXTENSION_APPS_STABLE_VERSION = '2026-01-01';
/** Version hiện tại của extension Tasks (vẫn đang tiến vào core). */
export const EXTENSION_TASKS_VERSION = '2026-07-28';

/** Lỗi negotiation extension v16. */
export class ExtensionV16Error extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ExtensionV16Error';
    if (code) this.code = code;
  }
}

/** Mô tả một extension đã biết. */
export interface KnownExtension {
  /** Id đầy đủ, vd `io.modelcontextprotocol/ui`. */
  id: string;
  /** Tên ngắn hiển thị. */
  name: string;
  /** Version ổn định / hiện tại. */
  version: string;
  /** Version tối thiểu client/server phải hỗ trợ để bật. */
  minVersion: string;
  /** SEP / tài liệu gốc. */
  spec: string;
  /** Mô tả một dòng. */
  description: string;
  /** Tính năng này có phải core (luôn có mặt) không. */
  core: boolean;
}

/** Registry extension đã biết của v16. */
export const KNOWN_EXTENSIONS_V16: readonly KnownExtension[] = [
  {
    id: EXTENSION_APPS_ID,
    name: 'MCP Apps',
    version: EXTENSION_APPS_STABLE_VERSION,
    minVersion: EXTENSION_APPS_STABLE_VERSION,
    spec: 'SEP-1865 (ổn định 01/2026)',
    description: 'Server render HTML tương tác trong sandboxed iframe.',
    core: false,
  },
  {
    id: EXTENSION_TASKS_ID,
    name: 'Tasks',
    version: EXTENSION_TASKS_VERSION,
    minVersion: EXTENSION_TASKS_VERSION,
    spec: 'MCP Tasks (dự kiến vào core)',
    description: 'Handle cho công việc dài hạn (task chạy nền, poll kết quả).',
    core: false,
  },
];

const KNOWN_BY_ID = new Map(KNOWN_EXTENSIONS_V16.map((e) => [e.id, e]));

/** Tra cứu extension đã biết theo id, hoặc undefined. */
export function getKnownExtension(id: string): KnownExtension | undefined {
  return KNOWN_BY_ID.get(id);
}

/** Một extension một phía khai báo trong capabilities. */
export interface ExtensionDeclaration {
  /** Id extension. */
  id: string;
  /** Version phía này hỗ trợ (dạng YYYY-MM-DD hoặc semver). */
  version?: string;
  /** Ghi chú thêm của phía khai báo. */
  note?: string;
}

/** Kết quả thương lượng cho một extension. */
export interface NegotiatedExtension {
  id: string;
  /** Extension có trong registry đã biết không. */
  known: boolean;
  /** Bật hay tắt sau thương lượng (mặc định tắt). */
  enabled: boolean;
  /** Version đã thống nhất (khi bật). */
  version?: string;
  /** Lý do tắt / cảnh báo (khi không bật hoặc có vấn đề). */
  reason?: string;
}

/** Kết quả thương lượng toàn bộ extensions. */
export interface ExtensionNegotiationResult {
  /** Từng extension đã xét (theo thứ tự client request trước). */
  extensions: NegotiatedExtension[];
  /** Id các extension đang bật (tiện kiểm tra nhanh). */
  enabledIds: string[];
  /** Id các extension client xin nhưng server không hỗ trợ. */
  unsupportedByServer: string[];
  /** Id các extension server hỗ trợ nhưng client không xin. */
  notRequestedByClient: string[];
  /** Id extension lạ (không có trong registry). */
  unknownIds: string[];
  /** Có extension nào được bật không. */
  anyEnabled: boolean;
}

/**
 * Parse field `extensions` trong capabilities thành danh sách
 * declaration. Chấp nhận cả hai hình thức server/client hay dùng:
 * mảng chuỗi id (`["io.modelcontextprotocol/ui"]`) và mảng object
 * (`[{ id, version }]`). Mục không hợp lệ bị bỏ qua (ghi vào
 * `skipped`), không ném — để một extension hỏng không phá cả
 * phiên thương lượng.
 */
export function parseExtensionsField(value: unknown): {
  declarations: ExtensionDeclaration[];
  skipped: unknown[];
} {
  const declarations: ExtensionDeclaration[] = [];
  const skipped: unknown[] = [];
  if (!Array.isArray(value)) return { declarations, skipped };
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      declarations.push({ id: item });
      continue;
    }
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if (typeof rec['id'] === 'string' && (rec['id'] as string).length > 0) {
        declarations.push({
          id: rec['id'] as string,
          ...(typeof rec['version'] === 'string' ? { version: rec['version'] as string } : {}),
          ...(typeof rec['note'] === 'string' ? { note: rec['note'] as string } : {}),
        });
        continue;
      }
    }
    skipped.push(item);
  }
  return { declarations, skipped };
}

/** Dựng field `extensions` để đưa vào capabilities (dạng mảng object). */
export function buildExtensionsField(
  declarations: ExtensionDeclaration[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const decl of declarations) {
    if (typeof decl.id !== 'string' || decl.id.length === 0) continue;
    if (seen.has(decl.id)) continue;
    seen.add(decl.id);
    out.push({
      id: decl.id,
      ...(decl.version ? { version: decl.version } : {}),
      ...(decl.note ? { note: decl.note } : {}),
    });
  }
  return out;
}

/**
 * So sánh hai version. Hỗ trợ cả dạng ngày `YYYY-MM-DD` (so sánh
 * chuỗi là đủ vì định dạng cố định) và semver `x.y.z` (so sánh
 * từng phần số). Trả -1 / 0 / 1. Version không parse được coi là
 * bằng nhau (0) để không chặn nhầm extension lạ.
 */
export function compareExtensionVersions(a: string, b: string): number {
  if (a === b) return 0;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (datePattern.test(a) && datePattern.test(b)) {
    return a < b ? -1 : 1;
  }
  const parseSemver = (v: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (av && bv) {
    for (let i = 0; i < 3; i++) {
      if ((av[i] as number) !== (bv[i] as number)) {
        return (av[i] as number) < (bv[i] as number) ? -1 : 1;
      }
    }
    return 0;
  }
  return 0;
}

/** True khi `candidate` >= `minimum` theo compareExtensionVersions. */
export function versionAtLeast(candidate: string, minimum: string): boolean {
  return compareExtensionVersions(candidate, minimum) >= 0;
}

/**
 * Thương lượng extensions: giao nhau giữa client request và server
 * support, kiểm tra version tối thiểu, mặc định TẮT mọi thứ còn lại.
 *
 * Quy tắc bật một extension:
 *   1. Client phải xin, server phải hỗ trợ (thiếu một phía → tắt).
 *   2. Version server >= minVersion của registry (khi extension đã
 *      biết); version client (khi khai) cũng phải >= minVersion.
 *   3. Extension lạ (không trong registry): chỉ bật khi caller
 *      truyền `allowUnknown: true` — mặc định tắt để thử nghiệm
 *      không tự bật tính năng chưa review.
 */
export function negotiateExtensions(
  clientRequested: ExtensionDeclaration[] | unknown,
  serverSupported: ExtensionDeclaration[] | unknown,
  options: { allowUnknown?: boolean } = {},
): ExtensionNegotiationResult {
  const client = Array.isArray(clientRequested)
    ? parseExtensionsField(clientRequested).declarations
    : [];
  const server = Array.isArray(serverSupported)
    ? parseExtensionsField(serverSupported).declarations
    : [];
  const serverById = new Map(server.map((d) => [d.id, d]));
  const clientById = new Map(client.map((d) => [d.id, d]));
  const extensions: NegotiatedExtension[] = [];
  const unsupportedByServer: string[] = [];
  const unknownIds: string[] = [];

  for (const req of client) {
    const known = getKnownExtension(req.id);
    const offered = serverById.get(req.id);
    if (!known) unknownIds.push(req.id);
    if (!offered) {
      unsupportedByServer.push(req.id);
      extensions.push({
        id: req.id,
        known: Boolean(known),
        enabled: false,
        reason: 'Server không hỗ trợ extension này.',
      });
      continue;
    }
    if (!known) {
      extensions.push({
        id: req.id,
        known: false,
        enabled: options.allowUnknown === true,
        ...(options.allowUnknown === true
          ? { version: offered.version ?? req.version }
          : { reason: 'Extension lạ — mặc định tắt, cần allowUnknown để bật thử nghiệm.' }),
      });
      continue;
    }
    const serverVersion = offered.version ?? known.version;
    const clientVersion = req.version ?? known.version;
    if (!versionAtLeast(serverVersion, known.minVersion)) {
      extensions.push({
        id: req.id,
        known: true,
        enabled: false,
        reason: `Server version ${serverVersion} thấp hơn tối thiểu ${known.minVersion}.`,
      });
      continue;
    }
    if (!versionAtLeast(clientVersion, known.minVersion)) {
      extensions.push({
        id: req.id,
        known: true,
        enabled: false,
        reason: `Client version ${clientVersion} thấp hơn tối thiểu ${known.minVersion}.`,
      });
      continue;
    }
    // Version thống nhất: lấy version thấp hơn trong hai phía (điểm
    // chung an toàn nhất cả hai đều hiểu).
    const agreed =
      compareExtensionVersions(serverVersion, clientVersion) <= 0
        ? serverVersion
        : clientVersion;
    extensions.push({ id: req.id, known: true, enabled: true, version: agreed });
  }

  const notRequestedByClient = server
    .filter((d) => !clientById.has(d.id))
    .map((d) => d.id);
  const enabledIds = extensions.filter((e) => e.enabled).map((e) => e.id);
  return {
    extensions,
    enabledIds,
    unsupportedByServer,
    notRequestedByClient,
    unknownIds,
    anyEnabled: enabledIds.length > 0,
  };
}

/**
 * Trích extensions từ kết quả `server/discover` (field `extensions`
 * ở top-level của document) thành declarations để đưa tiếp vào
 * `negotiateExtensions()`. Document không khai extensions thì trả
 * về mảng rỗng (không ném) — server cũ không biết extensions vẫn
 * discover được, chỉ là không có extension nào để bật.
 */
export function extensionsFromDiscover(
  result: ServerDiscoverResult,
): ExtensionDeclaration[] {
  const raw = (result as { extensions?: unknown })['extensions'];
  return parseExtensionsField(raw).declarations;
}

/** True khi extension đã được thương lượng bật trong kết quả. */
export function isExtensionEnabled(
  result: ExtensionNegotiationResult,
  extensionId: string,
): boolean {
  return result.enabledIds.includes(extensionId);
}

/**
 * Ném khi một tính năng cần extension mà extension chưa được bật.
 * Dùng làm gate ở đầu mọi handler dùng Apps / Tasks.
 */
export function requireExtension(
  result: ExtensionNegotiationResult,
  extensionId: string,
  feature: string,
): void {
  if (isExtensionEnabled(result, extensionId)) return;
  const known = getKnownExtension(extensionId);
  throw new ExtensionV16Error(
    `Tính năng "${feature}" cần extension ${known ? known.name : extensionId} (${extensionId}) — extension chưa được thương lượng bật (mặc định tắt, cả client và server phải khai báo).`,
    'extension-not-negotiated',
  );
}

/** Tóm tắt một dòng cho log / UI: "Apps: bật (2026-01-01); Tasks: tắt (server không hỗ trợ)". */
export function describeNegotiation(result: ExtensionNegotiationResult): string {
  if (result.extensions.length === 0) return 'Không có extension nào được yêu cầu.';
  return result.extensions
    .map((e) => {
      const known = getKnownExtension(e.id);
      const label = known ? known.name : e.id;
      if (e.enabled) return `${label}: bật (${e.version ?? 'không rõ version'})`;
      return `${label}: tắt (${e.reason ?? 'không rõ lý do'})`;
    })
    .join('; ');
}
