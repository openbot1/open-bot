/**
 * Deprecation policy engine v16 — MCP 2026-07-28, SEP-2577
 * (v1.36, Đội T3).
 *
 * SEP-2577 deprecate Roots, Sampling và Logging với cam kết tối
 * thiểu 12 tháng báo trước, earliest removal 2027-07-28. Sóng v0.97
 * đã có shim (`deprecation.ts`: `DEPRECATED_MCP_METHODS`,
 * `DeprecationShim`, cảnh báo một lần) và sóng v1.04 có migration
 * guide (`deprecationMigration.ts`). V16 xây policy engine vận hành
 * lộ trình đó theo ngày tháng thật:
 *
 *   1. Policy theo từng capability (roots / sampling / logging):
 *      ngày deprecate, earliest removal, migration path (replacement
 *      + từng bước + độ khó + link tài liệu), trạng thái tính từ
 *      ngày hiện tại (active → deprecated → removal-due → removed).
 *   2. Usage tracking: đếm mỗi lần một method/capability deprecated
 *      còn được dùng (firstSeen / lastSeen / count) để operator biết
 *      codebase nào còn phụ thuộc trước ngày removal.
 *   3. Warning throttle: cảnh báo theo chu kỳ (mặc định 1 lần/ngày
 *      cho mỗi capability) thay vì spam mỗi lần gọi; vẫn đếm đủ.
 *   4. Guard `assertNotRemoved()`: sau ngày removal, gọi method
 *      deprecated ném lỗi rõ ràng kèm migration path thay vì chạy
 *      âm thầm rồi lỗi khó hiểu ở server.
 *   5. Policy report: bảng tổng hợp cho UI / audit — còn bao nhiêu
 *      ngày tới removal, capability nào còn được dùng nhiều nhất.
 *
 * Engine không tự xoá gì: tới ngày removal nó chỉ báo `removed`
 * và chặn qua guard; việc gỡ code thật là quyết định của operator.
 * Ideas only — không copy code/text/tài sản của bất kỳ repo nào,
 * của xAI/Cursor.
 */

import {
  DEPRECATED_MCP_METHODS,
  MCP_DEPRECATION_REMOVE_AFTER,
  getDeprecatedMethod,
  type DeprecatedMcpMethod,
} from './deprecation';

/** Ngày removal sớm nhất theo spec (không trước ngày này). */
export const DEPRECATION_V16_EARLIEST_REMOVAL = MCP_DEPRECATION_REMOVE_AFTER;

/** Thời gian báo trước tối thiểu theo policy (12 tháng ≈ 365 ngày). */
export const DEPRECATION_V16_NOTICE_DAYS = 365;

/** Chu kỳ throttle cảnh báo mặc định (1 ngày). */
export const DEPRECATION_V16_WARN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Lỗi policy deprecation v16. */
export class DeprecationPolicyV16Error extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'DeprecationPolicyV16Error';
    if (code) this.code = code;
  }
}

/** Trạng thái vòng đời của một capability deprecated. */
export type DeprecationLifecycleStatus =
  | 'active'
  | 'deprecated'
  | 'removal-due'
  | 'removed';

/** Một bước trong migration path. */
export interface MigrationStepV16 {
  /** Thứ tự bước (1-based). */
  order: number;
  /** Mô tả việc cần làm. */
  action: string;
  /** File / vị trí gợi ý (khi biết). */
  where?: string;
}

/** Migration path đầy đủ cho một capability. */
export interface MigrationPathV16 {
  capability: string;
  replacement: string;
  steps: MigrationStepV16[];
  /** Độ khó ước tính. */
  effort: 'low' | 'medium' | 'high';
  /** Link tài liệu (nội bộ hoặc spec). */
  docs?: string;
}

/** Policy cho một capability deprecated. */
export interface DeprecationPolicyV16 {
  capability: string;
  methods: string[];
  deprecatedIn: string;
  /** Ngày deprecate (ISO date). */
  deprecatedOn: string;
  /** Ngày removal sớm nhất (ISO date). */
  removeAfter: string;
  reason: string;
  migration: MigrationPathV16;
}

/** Số liệu sử dụng một capability deprecated. */
export interface DeprecationUsageV16 {
  capability: string;
  methods: Record<string, number>;
  totalCalls: number;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
}

/** Một dòng trong policy report. */
export interface DeprecationReportRowV16 {
  capability: string;
  status: DeprecationLifecycleStatus;
  daysUntilRemoval: number | null;
  removeAfter: string;
  replacement: string;
  totalCalls: number;
  lastSeenAtMs: number | null;
  migrationEffort: MigrationPathV16['effort'];
}

/** Migration path mặc định cho từng capability (theo spec + thực tế repo). */
export const DEPRECATION_V16_MIGRATIONS: readonly MigrationPathV16[] = [
  {
    capability: 'roots',
    replacement: 'Đọc workspace roots từ local configuration, hoặc MRTR needs_roots.',
    steps: [
      { order: 1, action: 'Liệt kê mọi chỗ gọi roots/list hoặc subscribe roots trong code.' },
      { order: 2, action: 'Thay bằng đọc roots từ cấu hình local của host (file cấu hình / biến môi trường).' },
      { order: 3, action: 'Trường hợp cần roots động theo request: dùng MRTR needs_roots — server trả input_required, client gửi roots trong follow-up.' },
      { order: 4, action: 'Bỏ đăng ký capability roots khỏi _meta / initialize.' },
    ],
    effort: 'medium',
    docs: 'docs/mcp-deprecation-v16.md#roots',
  },
  {
    capability: 'sampling',
    replacement: 'Gọi LLM API trực tiếp, hoặc MRTR needs_sampling.',
    steps: [
      { order: 1, action: 'Liệt kê mọi chỗ gọi sampling/createMessage.' },
      { order: 2, action: 'Thay bằng gọi trực tiếp LLM API đã cấu hình (provider key / CLI login local).' },
      { order: 3, action: 'Trường hợp cần model của client: dùng MRTR needs_sampling — server trả input_required, client chạy model rồi gửi lại.' },
      { order: 4, action: 'Bỏ đăng ký capability sampling khỏi _meta / initialize.' },
    ],
    effort: 'high',
    docs: 'docs/mcp-deprecation-v16.md#sampling',
  },
  {
    capability: 'logging',
    replacement: 'Log ra stderr hoặc OpenTelemetry; tiến trình hiển thị qua notifications/progress.',
    steps: [
      { order: 1, action: 'Liệt kê mọi chỗ gọi logging/setLevel và notifications/message.' },
      { order: 2, action: 'Chuyển log vận hành sang stderr / OpenTelemetry.' },
      { order: 3, action: 'Tiến trình user-visible chuyển sang notifications/progress.' },
      { order: 4, action: 'Bỏ đăng ký capability logging khỏi _meta / initialize.' },
    ],
    effort: 'low',
    docs: 'docs/mcp-deprecation-v16.md#logging',
  },
];

const MIGRATION_BY_CAPABILITY = new Map(
  DEPRECATION_V16_MIGRATIONS.map((m) => [m.capability, m]),
);

/** Lấy migration path của một capability, hoặc undefined. */
export function getMigrationPathV16(capability: string): MigrationPathV16 | undefined {
  return MIGRATION_BY_CAPABILITY.get(capability);
}

/**
 * Tính số ngày từ `fromMs` tới một ngày ISO (`YYYY-MM-DD`, tính
 * theo UTC). Âm khi đã qua ngày đó.
 */
export function daysUntilDate(dateIso: string, fromMs: number): number {
  const target = Date.parse(`${dateIso}T00:00:00.000Z`);
  if (Number.isNaN(target)) return Number.NaN;
  return Math.floor((target - fromMs) / (24 * 60 * 60 * 1000));
}

/**
 * Trạng thái vòng đời tại một thời điểm: trước ngày deprecate thì
 * `active`; từ deprecate tới removal thì `deprecated`; đúng/ngày
 * removal (đã tới hạn nhưng policy chưa gỡ) thì `removal-due`;
 * khi operator đánh dấu đã gỡ thì `removed` (xem `markRemoved`).
 */
export function lifecycleStatusAt(
  policy: DeprecationPolicyV16,
  nowMs: number,
  removed: boolean,
): DeprecationLifecycleStatus {
  if (removed) return 'removed';
  if (nowMs >= Date.parse(`${policy.removeAfter}T00:00:00.000Z`)) return 'removal-due';
  if (nowMs >= Date.parse(`${policy.deprecatedOn}T00:00:00.000Z`)) return 'deprecated';
  return 'active';
}

/**
 * Dựng policy cho cả ba capability từ `DEPRECATED_MCP_METHODS`
 * của sóng v0.97 (nguồn sự thật duy nhất về method nào deprecated)
 * + migration path của v16.
 */
export function buildDeprecationPoliciesV16(): DeprecationPolicyV16[] {
  const byCapability = new Map<string, DeprecatedMcpMethod[]>();
  for (const method of DEPRECATED_MCP_METHODS) {
    // elicitation/create là deprecated nhưng đã có MRTR thay thế
    // hoàn chỉnh ở sóng v1.05 — không nằm trong lộ trình Roots /
    // Sampling / Logging của SEP-2577 nên v16 không policy hoá nó.
    if (method.capability === 'elicitation') continue;
    const list = byCapability.get(method.capability) ?? [];
    list.push(method);
    byCapability.set(method.capability, list);
  }
  const policies: DeprecationPolicyV16[] = [];
  for (const [capability, methods] of [...byCapability.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const migration = MIGRATION_BY_CAPABILITY.get(capability);
    if (!migration) continue;
    const first = methods[0] as DeprecatedMcpMethod;
    policies.push({
      capability,
      methods: methods.map((m) => m.method),
      deprecatedIn: first.deprecatedIn,
      deprecatedOn: first.deprecatedIn,
      removeAfter: MCP_DEPRECATION_REMOVE_AFTER,
      reason: first.reason,
      migration,
    });
  }
  return policies;
}

/** Tuỳ chọn cho DeprecationPolicyEngineV16. */
export interface DeprecationEngineOptions {
  /** Chu kỳ throttle cảnh báo mỗi capability (ms). */
  warnIntervalMs?: number;
  /** Đồng hồ (để test điều khiển thời gian). */
  now?: () => number;
  /** Hàm nhận cảnh báo (mặc định không làm gì). */
  onWarning?: (message: string, capability: string) => void;
}

/**
 * Policy engine v16: giữ policy + usage + trạng thái removed cho
 * Roots/Sampling/Logging, phát cảnh báo có throttle, chặn gọi sau
 * ngày removal, xuất report.
 */
export class DeprecationPolicyEngineV16 {
  private readonly policies: DeprecationPolicyV16[];
  private readonly policyByCapability = new Map<string, DeprecationPolicyV16>();
  private readonly usage = new Map<string, DeprecationUsageV16>();
  private readonly removed = new Set<string>();
  private readonly lastWarnedAt = new Map<string, number>();
  private readonly warnIntervalMs: number;
  private readonly now: () => number;
  private readonly onWarning?: (message: string, capability: string) => void;

  constructor(options: DeprecationEngineOptions = {}) {
    this.policies = buildDeprecationPoliciesV16();
    for (const policy of this.policies) {
      this.policyByCapability.set(policy.capability, policy);
    }
    this.warnIntervalMs = options.warnIntervalMs ?? DEPRECATION_V16_WARN_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning;
  }

  /** Toàn bộ policy (bản sao). */
  listPolicies(): DeprecationPolicyV16[] {
    return this.policies.map((p) => ({
      ...p,
      methods: [...p.methods],
      migration: { ...p.migration, steps: p.migration.steps.map((s) => ({ ...s })) },
    }));
  }

  /** Policy của một capability, hoặc undefined. */
  policyFor(capability: string): DeprecationPolicyV16 | undefined {
    return this.policyByCapability.get(capability);
  }

  /** Trạng thái vòng đời của một capability tại thời điểm hiện tại. */
  statusOf(capability: string, nowMs?: number): DeprecationLifecycleStatus | null {
    const policy = this.policyByCapability.get(capability);
    if (!policy) return null;
    return lifecycleStatusAt(policy, nowMs ?? this.now(), this.removed.has(capability));
  }

  /** Số ngày còn lại tới removal (âm khi đã qua hạn). */
  daysUntilRemoval(capability: string, nowMs?: number): number | null {
    const policy = this.policyByCapability.get(capability);
    if (!policy) return null;
    return daysUntilDate(policy.removeAfter, nowMs ?? this.now());
  }

  /** Đánh dấu một capability đã gỡ khỏi code (sau removal). */
  markRemoved(capability: string): boolean {
    if (!this.policyByCapability.has(capability)) return false;
    this.removed.add(capability);
    return true;
  }

  /** Capability đã gỡ chưa. */
  isRemoved(capability: string): boolean {
    return this.removed.has(capability);
  }

  /**
   * Ghi nhận một lần dùng method deprecated: tăng đếm, cập nhật
   * first/last seen, phát cảnh báo (có throttle) kèm migration
   * path. Trả về policy tương ứng (hoặc null khi method không
   * deprecated). Không ném — tracking không được phá luồng gọi.
   */
  recordUsage(method: string): DeprecationPolicyV16 | null {
    const meta = getDeprecatedMethod(method);
    if (!meta) return null;
    const policy = this.policyByCapability.get(meta.capability);
    if (!policy) return null;
    const nowMs = this.now();
    let usage = this.usage.get(meta.capability);
    if (!usage) {
      usage = {
        capability: meta.capability,
        methods: {},
        totalCalls: 0,
        firstSeenAtMs: null,
        lastSeenAtMs: null,
      };
      this.usage.set(meta.capability, usage);
    }
    usage.methods[method] = (usage.methods[method] ?? 0) + 1;
    usage.totalCalls += 1;
    if (usage.firstSeenAtMs === null) usage.firstSeenAtMs = nowMs;
    usage.lastSeenAtMs = nowMs;
    const lastWarned = this.lastWarnedAt.get(meta.capability) ?? 0;
    if (nowMs - lastWarned >= this.warnIntervalMs) {
      this.lastWarnedAt.set(meta.capability, nowMs);
      const days = daysUntilDate(policy.removeAfter, nowMs);
      this.onWarning?.(
        `MCP deprecated: "${meta.capability}" (${method}) sẽ bị gỡ sớm nhất ${policy.removeAfter} (còn ${days} ngày). Thay bằng: ${policy.migration.replacement}`,
        meta.capability,
      );
    }
    return policy;
  }

  /** Số liệu sử dụng của một capability (bản sao), hoặc undefined. */
  usageOf(capability: string): DeprecationUsageV16 | undefined {
    const usage = this.usage.get(capability);
    return usage ? { ...usage, methods: { ...usage.methods } } : undefined;
  }

  /**
   * Guard: ném khi capability đã tới hạn removal (hoặc đã đánh dấu
   * removed) và caller vẫn gọi method của nó. Thông báo kèm migration
   * path để caller biết sửa thế nào.
   */
  assertNotRemoved(method: string, nowMs?: number): void {
    const meta = getDeprecatedMethod(method);
    if (!meta) return;
    const policy = this.policyByCapability.get(meta.capability);
    if (!policy) return;
    const now = nowMs ?? this.now();
    const status = lifecycleStatusAt(policy, now, this.removed.has(meta.capability));
    if (status === 'removal-due' || status === 'removed') {
      throw new DeprecationPolicyV16Error(
        `MCP deprecated: "${meta.capability}" (${method}) đã tới hạn gỡ (${policy.removeAfter}). Thay bằng: ${policy.migration.replacement} (docs: ${policy.migration.docs ?? 'xem migration path'}).`,
        'deprecated-removed',
      );
    }
  }

  /** Report tổng hợp: một dòng cho mỗi capability trong policy. */
  report(nowMs?: number): DeprecationReportRowV16[] {
    const now = nowMs ?? this.now();
    return this.policies.map((policy) => {
      const usage = this.usage.get(policy.capability);
      return {
        capability: policy.capability,
        status: lifecycleStatusAt(policy, now, this.removed.has(policy.capability)),
        daysUntilRemoval: daysUntilDate(policy.removeAfter, now),
        removeAfter: policy.removeAfter,
        replacement: policy.migration.replacement,
        totalCalls: usage?.totalCalls ?? 0,
        lastSeenAtMs: usage?.lastSeenAtMs ?? null,
        migrationEffort: policy.migration.effort,
      };
    });
  }

  /** Tóm tắt một dòng cho log: "roots: deprecated, còn 512 ngày; ...". */
  describe(nowMs?: number): string {
    return this.report(nowMs)
      .map(
        (row) =>
          `${row.capability}: ${row.status}, còn ${row.daysUntilRemoval} ngày tới ${row.removeAfter}, ${row.totalCalls} lần gọi`,
      )
      .join('; ');
  }
}
