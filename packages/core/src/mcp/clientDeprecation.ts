/**
 * Client-side deprecation — Roots / Sampling / Logging (v1.06, Đội T2).
 *
 * MCP 2.0 (SEP-2577) deprecates sampling, roots và logging: chúng
 * vẫn chạy tới ít nhất 2027-07-28, nhưng code mới không được dùng
 * chúng nữa — server nên gọi LLM API trực tiếp thay cho
 * `sampling/createMessage`, tự đọc workspace thay cho `roots/list`,
 * và log ra stderr / OpenTelemetry thay cho `notifications/message`.
 *
 * Phía server đã có shim (`deprecation.ts`, dùng trong `server.ts`).
 * Module này là nửa còn thiếu — phía CLIENT:
 *
 *   - `ClientDeprecationTracker`: một tracker gắn vào mỗi client.
 *     Mỗi lần client trả lời một request deprecated do server gửi
 *     (`sampling/createMessage`, `roots/list`, `notifications/
 *     message`) hoặc tự gửi một request deprecated (`logging/
 *     setLevel`, `roots/subscribe`), tracker ghi một notice (đếm
 *     số lần dùng) và cảnh báo đúng MỘT lần qua `onWarning`
 *     (client tự chọn log đi đâu — mặc định không in gì ra
 *     stdout/stderr, vì stdio server phải giữ stdout sạch).
 *   - `noteAdvertisedCapabilities`: khi client quảng cáo capability
 *     deprecated trong `initialize` / `_meta` (vd `roots` vì có
 *     workspace), tracker ghi notice ngay từ lúc connect để
 *     operator thấy client này còn dựa vào surface cũ — không từ
 *     chối kết nối, chỉ ghi nhận.
 *   - `wrapHandler`: bọc handler của client (sampling/roots/
 *     logging) để lần gọi đầu tiên cảnh báo, các lần sau chỉ đếm.
 *   - `formatClientDeprecationWarning`: câu cảnh báo tiếng Việt
 *     một dòng cho UI/log, nêu rõ thay thế và ngày có thể bị gỡ.
 *
 * Quy tắc: tracker KHÔNG chặn gì cả — mọi thứ vẫn chạy như cũ,
 * chỉ thêm cảnh báo + đếm. Việc gỡ bỏ là quyết định 2027, không
 * phải bây giờ. Code mới trong repo phải dùng MRTR (`needs_
 * sampling` / `needs_roots` / `needs_elicitation`, xem `mrtr.ts`)
 * thay cho các callback này.
 *
 * Ideas only — không copy code/text/tài sản của repo nào.
 */

import {
  checkDeprecatedCapabilities,
  DeprecationShim,
  formatDeprecationWarning,
  getDeprecatedMethod,
  isDeprecatedMcpMethod,
  type DeprecatedMcpMethod,
  type DeprecationNotice,
} from './deprecation';

/** Ba capability client bị deprecated trong MCP 2.0 (SEP-2577). */
export const CLIENT_DEPRECATED_CAPABILITIES: readonly string[] = [
  'sampling',
  'roots',
  'logging',
];

/**
 * Method deprecated mà client có thể gặp — cả hai chiều:
 * server→client (`sampling/createMessage`, `roots/list`,
 * `notifications/message`) và client→server (`logging/setLevel`,
 * `roots/subscribe`). Lấy từ bảng chung trong `deprecation.ts`,
 * lọc theo ba capability trên.
 */
export const CLIENT_DEPRECATED_METHODS: readonly DeprecatedMcpMethod[] = [
  'sampling/createMessage',
  'roots/list',
  'roots/subscribe',
  'notifications/message',
  'logging/setLevel',
]
  .map((method) => getDeprecatedMethod(method))
  .filter((meta): meta is DeprecatedMcpMethod => meta !== null);

/** Chiều của một lần dùng method deprecated (để log rõ). */
export type ClientDeprecationDirection = 'incoming' | 'outgoing';

/** Tuỳ chọn cho `ClientDeprecationTracker`. */
export interface ClientDeprecationTrackerOptions {
  /** Tên server client đang nói chuyện (để warning nêu rõ ai). */
  serverName?: string;
  /** Gọi đúng một lần cho mỗi method khi nó bị dùng lần đầu. */
  onWarning?: (notice: DeprecationNotice, message: string) => void;
  /** Đồng hồ (test tiêm giờ cố định). */
  nowMs?: () => number;
}

/** True khi capability là một trong ba capability deprecated của client. */
export function isDeprecatedClientCapability(capability: string): boolean {
  return (CLIENT_DEPRECATED_CAPABILITIES as readonly string[]).includes(capability);
}

/** True khi method là method deprecated mà client có thể gặp. */
export function isDeprecatedClientMethod(method: string): boolean {
  if (!isDeprecatedMcpMethod(method)) return false;
  const meta = getDeprecatedMethod(method);
  return meta !== null && isDeprecatedClientCapability(meta.capability);
}

/**
 * Các capability deprecated có trong một capabilities record
 * (vd capabilities client quảng cáo trong `initialize` / `_meta`).
 */
export function deprecatedClientCapabilitiesIn(
  capabilities: Record<string, unknown> | undefined,
): string[] {
  if (!capabilities) return [];
  return CLIENT_DEPRECATED_CAPABILITIES.filter((cap) => cap in capabilities);
}

/**
 * Câu cảnh báo tiếng Việt một dòng cho một notice phía client —
 * nêu server, method, thay thế và ngày có thể bị gỡ.
 */
export function formatClientDeprecationWarning(
  notice: DeprecationNotice,
  serverName?: string,
): string {
  const where = serverName ? ` (server "${serverName}")` : '';
  return (
    `MCP client${where}: method "${notice.method}" đã deprecated ` +
    `(không gỡ trước 2027-07-28) — đã dùng ${notice.callCount} lần. ` +
    `Thay thế: ${notice.replacement}`
  );
}

/**
 * Tracker deprecation cho một MCP client. Giữ một `DeprecationShim`
 * chung bên trong (đếm + warn-once), cộng thêm chiều incoming/
 * outgoing và context tên server cho message.
 */
export class ClientDeprecationTracker {
  private readonly shim: DeprecationShim;
  private readonly serverName?: string;
  private readonly onWarning?: (notice: DeprecationNotice, message: string) => void;
  /** Số lần dùng theo method + chiều (vd `roots/list:incoming`). */
  private readonly directionalCounts = new Map<string, number>();

  constructor(options: ClientDeprecationTrackerOptions = {}) {
    this.serverName = options.serverName;
    this.onWarning = options.onWarning;
    this.shim = new DeprecationShim({
      onWarning: (notice, message) => {
        this.onWarning?.(notice, message);
      },
      ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    });
  }

  /** True khi đã ghi nhận ít nhất một lần dùng deprecated. */
  get hasUsedDeprecated(): boolean {
    return this.shim.hasNotices;
  }

  /**
   * Ghi một lần dùng method deprecated. `direction` = `incoming`
   * khi server gửi request cho client trả lời, `outgoing` khi
   * client tự gửi request deprecated. Method không deprecated thì
   * trả null và không ghi gì. Cảnh báo chỉ phát một lần/method
   * (qua `onWarning`); các lần sau chỉ tăng `callCount`.
   */
  noteUse(
    method: string,
    direction: ClientDeprecationDirection = 'incoming',
  ): DeprecationNotice | null {
    if (!isDeprecatedClientMethod(method)) return null;
    const key = `${method}:${direction}`;
    this.directionalCounts.set(key, (this.directionalCounts.get(key) ?? 0) + 1);
    const notice = this.shim.record(method);
    return notice;
  }

  /**
   * Ghi các capability deprecated mà client quảng cáo (vd `roots`
   * vì client có workspace, `sampling` vì client đăng ký handler
   * sampling). Gọi một lần lúc connect. Trả danh sách capability
   * đã ghi nhận (rỗng khi không có gì deprecated).
   */
  noteAdvertisedCapabilities(
    capabilities: Record<string, unknown> | undefined,
  ): string[] {
    const found = checkDeprecatedCapabilities(capabilities).filter((meta) =>
      isDeprecatedClientCapability(meta.capability),
    );
    const recorded: string[] = [];
    for (const meta of found) {
      // Ghi nhận qua method đại diện của capability để notice có
      // đủ method + replacement; shim tự dedupe theo method.
      this.shim.record(meta.method);
      recorded.push(meta.capability);
    }
    return recorded;
  }

  /**
   * Bọc một handler của client (sampling/roots/logging) để lần gọi
   * đầu tiên cảnh báo + các lần sau chỉ đếm. Handler của method
   * không deprecated trả về nguyên vẹn, không bọc.
   */
  wrapHandler<TArgs extends unknown[], TResult>(
    method: string,
    handler: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    if (!isDeprecatedClientMethod(method)) return handler;
    return this.shim.wrap(method, handler);
  }

  /** Mọi notice đã ghi, theo thứ tự xuất hiện lần đầu. */
  getNotices(): DeprecationNotice[] {
    return this.shim.getNotices();
  }

  /** Số lần một method đã được dùng (mọi chiều cộng lại). */
  callCount(method: string): number {
    const notice = this.shim.getNotices().find((n) => n.method === method);
    return notice?.callCount ?? 0;
  }

  /** Số lần một method đã được dùng theo chiều. */
  directionalCallCount(
    method: string,
    direction: ClientDeprecationDirection,
  ): number {
    return this.directionalCounts.get(`${method}:${direction}`) ?? 0;
  }

  /** Câu cảnh báo tiếng Việt cho một notice (kèm tên server). */
  formatWarning(notice: DeprecationNotice): string {
    return formatClientDeprecationWarning(notice, this.serverName);
  }

  /** Tóm tắt một dòng mọi notice (cho log/activity feed). */
  describeNotices(): string {
    const notices = this.getNotices();
    if (notices.length === 0) return 'Không dùng method MCP nào đã deprecated.';
    return notices
      .map(
        (n) =>
          `"${n.method}" × ${n.callCount} (thay bằng: ${n.replacement})`,
      )
      .join('; ');
  }

  /** Xoá mọi notice + đếm (dùng cho test / reconnect). */
  clear(): void {
    this.shim.clear();
    this.directionalCounts.clear();
  }
}

/**
 * Ghi một lần dùng deprecated vào tracker có sẵn (helper cho
 * client gọi ở hot path mà không cần nhớ API tracker). Trả notice
 * hoặc null khi method không deprecated / không có tracker.
 */
export function noteDeprecatedClientUse(
  tracker: ClientDeprecationTracker | undefined,
  method: string,
  direction: ClientDeprecationDirection = 'incoming',
): DeprecationNotice | null {
  if (!tracker) return null;
  return tracker.noteUse(method, direction);
}

/** Re-export để caller không cần import cả hai module. */
export { formatDeprecationWarning };
