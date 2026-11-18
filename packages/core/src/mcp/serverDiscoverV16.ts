/**
 * server/discover v16 — MCP 2026-07-28 (v1.36, Đội T3).
 *
 * Trong MCP 2.0, `server/discover` thay handshake `initialize` làm
 * điểm bắt đầu mọi phiên: client gọi discover trước, server trả
 * protocol version + capabilities + extensions + endpoints, client
 * kiểm tra tương thích rồi mới gọi tiếp. Sóng trước (`stateless.ts`)
 * đã có `parseServerDiscoverResult` + `discoverServer` và
 * `statelessClientFull.ts` đã có client discover có cache; v16 xây
 * phía còn lại + lớp cache dùng chung:
 *
 *   1. Descriptor builder phía server: dựng document discover đầy
 *      đủ từ server info + capabilities + extensions đã đăng ký +
 *      endpoint + health; validate trước khi trả (thiếu protocol
 *      version / serverInfo thì ném, không trả document nửa vời).
 *   2. Version compatibility: kiểm tra giao nhau giữa version
 *      client hỗ trợ và version server hỗ trợ, chọn version cao
 *      nhất chung; không có giao nhau thì báo rõ hai danh sách.
 *   3. Discovery cache v16: cache theo endpoint + fingerprint của
 *      document; stale-while-revalidate — document hết TTL vẫn trả
 *      bản cũ kèm cờ `stale: true` trong lúc fetch mới ở nền (caller
 *      tự quyết định có chờ bản mới không).
 *   4. `discoverFromTransport`: gọi discover qua transport v16
 *      (dùng lại `V16StatelessTransport`), parse + kiểm tra version,
 *      ghi cache.
 *
 * Module này không chạm mạng. Ideas only — không copy code/text/
 * tài sản của bất kỳ repo nào, của xAI/Cursor.
 */

import {
  MCP_PROTOCOL_VERSION_2026,
  MCP_PROTOCOL_VERSIONS_2026,
  isKnownProtocolVersion,
  parseServerDiscoverResult,
  type ServerDiscoverResult,
} from './stateless';
import { parseV16DiscoverResult } from './statelessClientV16';
import type { V16StatelessTransport } from './statelessClientV16';
import { buildExtensionsField, type ExtensionDeclaration } from './extensionsV16';

/** TTL cache discover mặc định (60s). */
export const DISCOVER_V16_TTL_MS = 60_000;

/** Lỗi server/discover v16. */
export class ServerDiscoverV16Error extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ServerDiscoverV16Error';
    if (code) this.code = code;
  }
}

/** Health của một endpoint trong document discover. */
export type DiscoverEndpointHealth = 'healthy' | 'degraded' | 'down';

/** Một endpoint server quảng bá trong document discover. */
export interface DiscoverEndpointV16 {
  url: string;
  /** Vai trò endpoint (vd "rpc", "stream", "tasks"). */
  role?: string;
  health: DiscoverEndpointHealth;
  /** Độ trễ đo được gần nhất (ms, khi có). */
  latencyMs?: number;
}

/** Input dựng document discover phía server. */
export interface BuildDiscoverDocumentInput {
  serverName: string;
  serverVersion: string;
  /** Protocol version chính server nói (mặc định 2026-07-28). */
  protocolVersion?: string;
  /** Các version server còn hỗ trợ (mặc định danh sách chuẩn). */
  supportedVersions?: string[];
  /** Capabilities server (tools / resources / prompts / tasks / apps...). */
  capabilities?: Record<string, unknown>;
  /** Extensions server hỗ trợ. */
  extensions?: ExtensionDeclaration[];
  /** Endpoint server quảng bá. */
  endpoints?: DiscoverEndpointV16[];
  /** Ghi chú thêm cho client (vd "migrated from v1.35"). */
  note?: string;
}

/** Document discover đầy đủ phía server trả (kèm endpoint v16). */
export interface ServerDiscoverDocumentV16 extends ServerDiscoverResult {
  endpoints?: DiscoverEndpointV16[];
}

/**
 * Dựng document `server/discover` phía server. Ném khi thiếu
 * server name/version hoặc protocol version không rõ.
 */
export function buildServerDiscoverDocumentV16(
  input: BuildDiscoverDocumentInput,
): ServerDiscoverDocumentV16 {
  if (typeof input.serverName !== 'string' || input.serverName.length === 0) {
    throw new ServerDiscoverV16Error('server/discover cần serverName.', 'bad-server-info');
  }
  if (typeof input.serverVersion !== 'string' || input.serverVersion.length === 0) {
    throw new ServerDiscoverV16Error('server/discover cần serverVersion.', 'bad-server-info');
  }
  const protocolVersion = input.protocolVersion ?? MCP_PROTOCOL_VERSION_2026;
  if (!isKnownProtocolVersion(protocolVersion)) {
    throw new ServerDiscoverV16Error(
      `Protocol version không rõ: "${protocolVersion}".`,
      'unknown-version',
    );
  }
  const supportedVersions = input.supportedVersions ?? [...MCP_PROTOCOL_VERSIONS_2026];
  for (const version of supportedVersions) {
    if (!isKnownProtocolVersion(version)) {
      throw new ServerDiscoverV16Error(
        `Supported version không rõ: "${version}".`,
        'unknown-version',
      );
    }
  }
  const capabilities: Record<string, Record<string, unknown>> = {};
  if (input.capabilities) {
    for (const [key, value] of Object.entries(input.capabilities)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        capabilities[key] = value as Record<string, unknown>;
      }
    }
  }
  const document: ServerDiscoverDocumentV16 = {
    protocolVersion,
    supportedVersions,
    capabilities: {
      tools: {},
      ...capabilities,
    } as ServerDiscoverResult['capabilities'],
    serverInfo: { name: input.serverName, version: input.serverVersion },
    ...(input.extensions && input.extensions.length > 0
      ? { extensions: buildExtensionsField(input.extensions).map((e) => String(e['id'])) }
      : {}),
    ...(input.endpoints && input.endpoints.length > 0
      ? { endpoints: input.endpoints.map((e) => ({ ...e })) }
      : {}),
    ...(input.note ? { note: input.note } : {}),
  };
  // Validate lại bằng parser chuẩn trước khi trả — document tự
  // dựng cũng phải qua cùng một cửa kiểm tra như document nhận về.
  parseServerDiscoverResult(document);
  return document;
}

/**
 * Chọn protocol version chung cao nhất giữa client và server.
 * Trả null khi không có giao nhau (caller báo lỗi kèm hai danh sách).
 * Thứ tự ưu tiên: danh sách chuẩn mới → cũ.
 */
export function pickCommonProtocolVersion(
  clientSupported: readonly string[],
  serverSupported: readonly string[],
): string | null {
  const serverSet = new Set(serverSupported);
  for (const candidate of MCP_PROTOCOL_VERSIONS_2026) {
    if (clientSupported.includes(candidate) && serverSet.has(candidate)) return candidate;
  }
  for (const candidate of clientSupported) {
    if (serverSet.has(candidate)) return candidate;
  }
  return null;
}

/** Kết quả kiểm tra tương thích version. */
export interface VersionCompatibilityV16 {
  compatible: boolean;
  /** Version chung đã chọn (khi tương thích). */
  agreedVersion?: string;
  clientSupported: string[];
  serverSupported: string[];
  /** Thông báo giải thích (khi không tương thích). */
  reason?: string;
}

/** Kiểm tra tương thích version giữa client và server. */
export function checkVersionCompatibility(
  clientSupported: readonly string[],
  serverSupported: readonly string[],
): VersionCompatibilityV16 {
  const agreed = pickCommonProtocolVersion(clientSupported, serverSupported);
  if (agreed) {
    return {
      compatible: true,
      agreedVersion: agreed,
      clientSupported: [...clientSupported],
      serverSupported: [...serverSupported],
    };
  }
  return {
    compatible: false,
    clientSupported: [...clientSupported],
    serverSupported: [...serverSupported],
    reason: `Không có protocol version chung — client hỗ trợ [${clientSupported.join(', ')}], server hỗ trợ [${serverSupported.join(', ')}].`,
  };
}

/** Một mục trong discovery cache v16. */
export interface DiscoverCacheEntryV16 {
  endpointUrl: string;
  result: ServerDiscoverResult;
  fetchedAtMs: number;
  expiresAtMs: number;
  /** Số lần entry này được dùng. */
  hits: number;
}

/** Tuỳ chọn cho DiscoverCacheV16. */
export interface DiscoverCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

/**
 * Cache discover v16: theo endpoint, có TTL, hỗ trợ stale-while-
 * revalidate — `get()` trả entry kèm cờ stale; `getFresh()` chỉ
 * trả khi còn hạn.
 */
export class DiscoverCacheV16 {
  private readonly entries = new Map<string, DiscoverCacheEntryV16>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: DiscoverCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DISCOVER_V16_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  size(): number {
    return this.entries.size;
  }

  put(endpointUrl: string, result: ServerDiscoverResult): DiscoverCacheEntryV16 {
    const nowMs = this.now();
    const entry: DiscoverCacheEntryV16 = {
      endpointUrl,
      result,
      fetchedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      hits: 0,
    };
    this.entries.set(endpointUrl, entry);
    return { ...entry };
  }

  /** Lấy entry (kể cả đã hết hạn) kèm cờ stale; null khi chưa có. */
  get(endpointUrl: string): { entry: DiscoverCacheEntryV16; stale: boolean } | null {
    const entry = this.entries.get(endpointUrl);
    if (!entry) return null;
    const stale = this.now() >= entry.expiresAtMs;
    entry.hits += 1;
    return { entry: { ...entry }, stale };
  }

  /** Chỉ lấy khi còn hạn; hết hạn thì null (không xoá entry cũ). */
  getFresh(endpointUrl: string): DiscoverCacheEntryV16 | null {
    const found = this.get(endpointUrl);
    if (!found || found.stale) return null;
    return found.entry;
  }

  invalidate(endpointUrl?: string): void {
    if (endpointUrl) this.entries.delete(endpointUrl);
    else this.entries.clear();
  }

  /** Quét dọn entry hết hạn quá 2 lần TTL (tránh cache phình). */
  sweep(nowMs?: number): number {
    const now = nowMs ?? this.now();
    let removed = 0;
    for (const [url, entry] of this.entries.entries()) {
      if (now - entry.expiresAtMs > 2 * this.ttlMs) {
        this.entries.delete(url);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * Gọi `server/discover` qua transport v16 rồi parse + kiểm tra
 * version, ghi cache. `clientSupported` dùng để kiểm tra tương
 * thích (mặc định danh sách chuẩn). Ném `ServerDiscoverV16Error`
 * khi version không tương thích.
 */
export async function discoverFromTransportV16(
  transport: V16StatelessTransport,
  endpointUrl: string,
  options: {
    cache?: DiscoverCacheV16;
    clientSupported?: readonly string[];
    protocolVersion?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ServerDiscoverResult> {
  const cached = options.cache?.getFresh(endpointUrl);
  if (cached) return cached.result;
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: `discover-${Date.now()}`,
    method: 'server/discover',
    params: {
      _meta: {
        protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION_2026,
        clientCapabilities: { multiRoundTrip: true, tasks: true, apps: true },
      },
    },
  };
  const raw = await transport.request(endpointUrl, body, {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  });
  const parsed = parseV16DiscoverResult(raw);
  const compatibility = checkVersionCompatibility(
    options.clientSupported ?? MCP_PROTOCOL_VERSIONS_2026,
    parsed.supportedVersions ?? [parsed.protocolVersion],
  );
  if (!compatibility.compatible) {
    throw new ServerDiscoverV16Error(
      `server/discover ở ${endpointUrl}: ${compatibility.reason ?? 'version không tương thích.'}`,
      'version-incompatible',
    );
  }
  options.cache?.put(endpointUrl, parsed);
  return parsed;
}
