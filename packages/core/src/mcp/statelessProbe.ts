/**
 * Stateless server probe — chẩn đoán server MCP qua transport
 * stateless (v1.06, Đội T2).
 *
 * `StatelessHttpTransport` (xem `statelessTransport.ts`) là transport
 * POST-only không session; module này là người dùng đầu tiên của nó
 * ngoài test: `probeStatelessServer` gọi `server/discover` rồi
 * `tools/list` lên một URL và báo cáo lại mọi thứ operator cần biết
 * để quyết định có dùng server này ở mode stateless không:
 *
 *   - Server có biết `server/discover` không (2026) hay trả `-32601`
 *     (pre-2.0 — phải fallback handshake, xem `legacyVersions.ts`).
 *   - Protocol version + capabilities + extensions server khai.
 *   - Server có trả header `Mcp-Session-Id` không (đã bị bỏ bao
 *     nhiêu lần — server chưa thuần stateless).
 *   - Số tool server liệt kê được (0 tool mà discover OK thì server
 *     có thể đang chạy ở chế độ hạn chế).
 *
 * Probe không đăng nhập, không giữ kết nối, không gửi credential —
 * chỉ hai request đọc (discover + tools/list). Lỗi transport /
 * discovery sai shape được trả về trong `error` thay vì throw, để
 * tool `mcp2_probe_stateless` hiện được kết quả chẩn đoán đầy đủ
 * thay vì chỉ một dòng lỗi.
 *
 * Ideas only — không copy code/text/tài sản của repo nào.
 */

import { parseServerDiscoverResult } from './stateless';
import {
  StatelessHttpTransport,
  type StatelessFetchFn,
  type StatelessTransportNotice,
} from './statelessTransport';

/** Kết quả chẩn đoán một server MCP ở mode stateless. */
export interface StatelessProbeResult {
  /** URL đã probe. */
  url: string;
  /** True khi server trả discovery document hợp lệ. */
  discovered: boolean;
  /** Protocol version server khai (undefined khi không discover được). */
  protocolVersion?: string;
  /** Tên server (từ discovery document). */
  serverName?: string;
  /** Version của server (từ discovery document). */
  serverVersion?: string;
  /** Capability server khai (tên key, vd `tools`, `tasks`). */
  capabilities: string[];
  /** Extension server khai (vd `io.modelcontextprotocol/tasks`). */
  extensions: string[];
  /** Số tool `tools/list` trả về (undefined khi không list được). */
  toolsListed?: number;
  /** Số lần server trả header `Mcp-Session-Id` (đã bị bỏ). */
  droppedSessionHeaders: number;
  /** Số request đã gửi (discover + tools/list khi thành công). */
  requestsSent: number;
  /** Notice transport đã phát (session header bị bỏ, timeout...). */
  notices: StatelessTransportNotice[];
  /** Lỗi chẩn đoán (khi discovered=false hoặc tools/list lỗi). */
  error?: string;
}

/** Tuỳ chọn cho `probeStatelessServer`. */
export interface StatelessProbeOptions {
  /** Hàm fetch (mặc định `fetch` toàn cục). Test tiêm fake vào đây. */
  fetchFn?: StatelessFetchFn;
  /** Timeout mỗi request (ms). Mặc định 30_000. */
  timeoutMs?: number;
  /** Protocol version khai trong `_meta` mỗi request. */
  protocolVersion?: string;
  /** Nghe notice của transport. */
  onNotice?: (notice: StatelessTransportNotice) => void;
  /** Đồng hồ (test tiêm giờ cố định). */
  nowMs?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Probe một URL MCP ở mode stateless: `server/discover` rồi
 * `tools/list`. Không throw — mọi lỗi nằm trong `result.error`
 * để caller hiện chẩn đoán đầy đủ.
 */
export async function probeStatelessServer(
  url: string,
  options: StatelessProbeOptions = {},
): Promise<StatelessProbeResult> {
  const notices: StatelessTransportNotice[] = [];
  const transport = new StatelessHttpTransport({
    url,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    onNotice: (notice) => {
      notices.push(notice);
      options.onNotice?.(notice);
    },
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  });
  const base: StatelessProbeResult = {
    url,
    discovered: false,
    capabilities: [],
    extensions: [],
    droppedSessionHeaders: 0,
    requestsSent: 0,
    notices,
  };
  try {
    let rawDiscover: unknown;
    try {
      rawDiscover = await transport.requestJsonRpc('server/discover', {});
    } catch (err) {
      const message = (err as Error).message;
      base.error =
        /-32601|Method not found/i.test(message)
          ? `Server không biết server/discover (pre-2.0, method not found) — cần handshake initialize thay vì stateless. Chi tiết: ${message}`
          : `Không discover được server: ${message}`;
      return finish(transport, base);
    }
    let discovered;
    try {
      discovered = parseServerDiscoverResult(rawDiscover);
    } catch (err) {
      base.error = `Server trả discovery document sai shape: ${(err as Error).message}`;
      return finish(transport, base);
    }
    base.discovered = true;
    base.protocolVersion = discovered.protocolVersion;
    base.serverName = discovered.serverInfo.name;
    base.serverVersion = discovered.serverInfo.version;
    base.capabilities = Object.keys(discovered.capabilities);
    base.extensions = [...(discovered.extensions ?? [])];
    try {
      const toolsRaw = await transport.requestJsonRpc('tools/list', {});
      if (isRecord(toolsRaw) && Array.isArray(toolsRaw['tools'])) {
        base.toolsListed = (toolsRaw['tools'] as unknown[]).length;
      }
    } catch (err) {
      base.error = `Discover OK nhưng tools/list lỗi: ${(err as Error).message}`;
    }
    return finish(transport, base);
  } finally {
    transport.close();
  }
}

function finish(
  transport: StatelessHttpTransport,
  result: StatelessProbeResult,
): StatelessProbeResult {
  return {
    ...result,
    droppedSessionHeaders: transport.droppedSessionHeaders,
    requestsSent: transport.requestsSent,
  };
}

/**
 * Tóm tắt một dòng kết quả probe (cho log / kết quả tool).
 * Vd: `Probe https://x/mcp: 2026-07-28, server mock-2026 1.0.0,
 * capabilities tools/tasks/prompts, 3 tools, 0 session header bị bỏ.`
 */
export function describeStatelessProbe(result: StatelessProbeResult): string {
  if (!result.discovered) {
    return `Probe ${result.url}: không discover được — ${result.error ?? 'lỗi không rõ'}.`;
  }
  const parts = [
    `Probe ${result.url}: ${result.protocolVersion ?? '(không rõ version)'}`,
    result.serverName ? `server ${result.serverName} ${result.serverVersion ?? ''}`.trim() : '',
    result.capabilities.length > 0
      ? `capabilities ${result.capabilities.join('/')}`
      : 'không khai capability nào',
    result.toolsListed !== undefined ? `${result.toolsListed} tools` : 'không list được tools',
    result.droppedSessionHeaders > 0
      ? `${result.droppedSessionHeaders} session header đã bị bỏ (server chưa thuần stateless)`
      : '0 session header bị bỏ',
  ].filter(Boolean);
  const suffix = result.error ? ` — lưu ý: ${result.error}` : '';
  return `${parts.join(', ')}.${suffix}`;
}
