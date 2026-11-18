/**
 * Tenant quotas v16 — hạn mức theo tenant: lượt gọi model, token,
 * storage, số bot, lượt gọi tool + cảnh báo khi gần chạm ngưỡng
 * (v1.19, Đội T6).
 *
 * Tầng trên của quota theo user v3/v4 (`fleetV14/multiUserV14.ts`
 * — quota ngày theo 6 loại + grant bot/tool; `fleetV15/
 * multiUserV15.ts` — thêm quota tài nguyên CPU/RAM/disk mức hiện
 * tại). Quota user trả lời "mỗi USER được dùng bao nhiêu"; v16
 * trả lời "mỗi TENANT (một nhóm user chia sẻ một tổ chức) được
 * dùng bao nhiêu" — vì nhiều user cùng tenant gọi chung một model
 * key / chung một ổ đĩa thì giới hạn theo user là chưa đủ:
 *
 * - 5 LOẠI QUOTA: `model-calls` + `model-tokens` + `tool-calls`
 *   theo kỳ (ngày/tuần/tháng); `storage-bytes` + `bots` theo mức
 *   hiện tại (level — dùng bao nhiêu thì trừ bấy nhiêu, giải phóng
 *   thì trả lại). Kỳ tháng = tháng dương lịch (UTC), tuần = tuần
 *   bắt đầu thứ Hai (UTC), ngày = ngày UTC.
 * - CẢNH BÁO NGƯỠNG: 80% → `watch`, 90% → `warning`, 100% →
 *   `critical`, vượt → `exceeded` (chặn lượt gọi mới). Mức cảnh
 *   báo tính trên lượt consume TRƯỚC khi ghi — caller cảnh báo
 *   user ngay trong response ("còn 5% quota tháng này").
 * - RESET KỲ: usage theo kỳ tự tách bằng period key
 *   (`2026-11-16`, `2026-W46`, `2026-11`); kỳ mới bắt đầu thì
 *   usage cũ không còn tính (prune dọn kỳ quá 90 ngày).
 * - GHI ĐÈ + MẶC ĐỊNH: mỗi tenant có giới hạn mặc định theo loại;
 *   admin đặt override riêng (0 = chặn hẳn loại đó, null = về
 *   mặc định); override âm → lỗi.
 *
 * Module này KHÔNG gọi model, KHÔNG đo storage thật, KHÔNG đếm
 * bot thật: nó quyết định "tenant này còn quota không, đã chạm
 * ngưỡng cảnh báo chưa" từ số liệu caller đo thật và truyền vào
 * — việc chặn gọi / đo dung lượng do caller làm theo kết quả.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu state tenant quota trong team root. */
export const TENANT_V16_QUOTAS_FILE = 'tenant-quotas-v119.json';
/** Phiên bản định dạng state. */
export const TENANT_V16_QUOTA_STATE_VERSION = 1;
/** Số tenant tối đa. */
export const TENANT_V16_MAX_TENANTS = 1000;
/** Usage kỳ quá số ngày này thì prune. */
export const TENANT_V16_USAGE_RETENTION_DAYS = 90;

/** Loại quota theo tenant. */
export type TenantV16QuotaKind =
  | 'model-calls'
  | 'model-tokens'
  | 'tool-calls'
  | 'storage-bytes'
  | 'bots';

export const TENANT_V16_QUOTA_KINDS: readonly TenantV16QuotaKind[] = [
  'model-calls',
  'model-tokens',
  'tool-calls',
  'storage-bytes',
  'bots',
];

/** Loại quota theo kỳ (reset theo kỳ) — còn lại là quota mức hiện tại. */
export const TENANT_V16_PERIOD_QUOTA_KINDS: readonly TenantV16QuotaKind[] = [
  'model-calls',
  'model-tokens',
  'tool-calls',
];

export function isTenantV16PeriodQuota(kind: TenantV16QuotaKind): boolean {
  return (TENANT_V16_PERIOD_QUOTA_KINDS as readonly TenantV16QuotaKind[]).includes(kind);
}

/** Kỳ reset của quota theo kỳ. */
export type TenantV16QuotaPeriod = 'daily' | 'weekly' | 'monthly';

export const TENANT_V16_QUOTA_PERIODS: readonly TenantV16QuotaPeriod[] = [
  'daily',
  'weekly',
  'monthly',
];

/** Giới hạn mặc định theo loại (Infinity = không giới hạn). */
export const TENANT_V16_DEFAULT_LIMITS: Readonly<Record<TenantV16QuotaKind, number>> = {
  'model-calls': 10000,
  'model-tokens': 10_000_000,
  'tool-calls': 50000,
  'storage-bytes': 10 * 1024 * 1024 * 1024,
  bots: 50,
};

/** Kỳ mặc định theo loại quota theo kỳ. */
export const TENANT_V16_DEFAULT_PERIODS: Readonly<Record<TenantV16QuotaKind, TenantV16QuotaPeriod>> = {
  'model-calls': 'daily',
  'model-tokens': 'monthly',
  'tool-calls': 'daily',
  'storage-bytes': 'daily',
  bots: 'daily',
};

/** Mức cảnh báo quota. */
export type TenantV16WarningLevel = 'none' | 'watch' | 'warning' | 'critical' | 'exceeded';

export const TENANT_V16_WARNING_LEVELS: readonly TenantV16WarningLevel[] = [
  'none',
  'watch',
  'warning',
  'critical',
  'exceeded',
];

/** Ngưỡng phần trăm cho từng mức cảnh báo. */
export const TENANT_V16_WARNING_THRESHOLDS: Readonly<Record<Exclude<TenantV16WarningLevel, 'none' | 'exceeded'>, number>> = {
  watch: 0.8,
  warning: 0.9,
  critical: 1,
};

/** Mức cảnh báo từ tỉ lệ đã dùng (0..1+, vượt 1 = exceeded). */
export function tenantV16WarningLevel(fraction: number): TenantV16WarningLevel {
  if (fraction > 1) return 'exceeded';
  if (fraction >= TENANT_V16_WARNING_THRESHOLDS.critical) return 'critical';
  if (fraction >= TENANT_V16_WARNING_THRESHOLDS.warning) return 'warning';
  if (fraction >= TENANT_V16_WARNING_THRESHOLDS.watch) return 'watch';
  return 'none';
}

// ---------------------------------------------------------------------------
// Period key (UTC)
// ---------------------------------------------------------------------------

/** Key kỳ cho một thời điểm: daily `2026-11-16`, weekly `2026-W46`, monthly `2026-11`. */
export function tenantV16PeriodKey(period: TenantV16QuotaPeriod, now = Date.now()): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (period === 'monthly') return `${y}-${m}`;
  if (period === 'daily') {
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  // weekly: tuần bắt đầu thứ Hai (ISO week).
  const day = d.getUTCDay();
  const monday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - ((day + 6) % 7)));
  const firstJan = new Date(Date.UTC(monday.getUTCFullYear(), 0, 1));
  const week = Math.floor((monday.getTime() - firstJan.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${monday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Epoch ms bắt đầu kỳ chứa `now` (để tính "reset sau bao lâu"). */
export function tenantV16PeriodStartMs(period: TenantV16QuotaPeriod, now = Date.now()): number {
  const d = new Date(now);
  if (period === 'daily') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === 'monthly') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = d.getUTCDay();
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((day + 6) % 7)));
  return monday.getTime();
}

/** Epoch ms kỳ tiếp theo bắt đầu (dùng cho "reset lúc ..."). */
export function tenantV16NextPeriodStartMs(period: TenantV16QuotaPeriod, now = Date.now()): number {
  const d = new Date(now);
  if (period === 'daily') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  if (period === 'monthly') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return tenantV16PeriodStartMs(period, now) + 7 * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// State + consume/release
// ---------------------------------------------------------------------------

/** Usage của một tenant: period kind → period key → đã dùng; level kind → mức hiện tại. */
export interface TenantV16Usage {
  period: Record<string, Record<string, number>>;
  level: Partial<Record<TenantV16QuotaKind, number>>;
}

/** Một tenant + giới hạn của nó. */
export interface TenantV16Record {
  tenantId: string;
  displayName: string;
  /** Override giới hạn (null = dùng mặc định). */
  overrides: Partial<Record<TenantV16QuotaKind, number | null>>;
  /** Kỳ reset riêng cho từng loại theo kỳ (null = kỳ mặc định). */
  periods: Partial<Record<TenantV16QuotaKind, TenantV16QuotaPeriod>>;
  usage: TenantV16Usage;
  createdAt: number;
  updatedAt: number;
}

/** State tenant quotas. */
export interface TenantV16QuotaState {
  version: number;
  tenants: TenantV16Record[];
  createdAt: number;
  updatedAt: number;
}

export function createTenantV16QuotaState(now = Date.now()): TenantV16QuotaState {
  return { version: TENANT_V16_QUOTA_STATE_VERSION, tenants: [], createdAt: now, updatedAt: now };
}

/** Giới hạn hiệu lực của tenant cho một loại (override thắng mặc định). */
export function tenantV16LimitFor(record: TenantV16Record, kind: TenantV16QuotaKind): number {
  const override = record.overrides[kind];
  if (override !== undefined && override !== null) return override;
  return TENANT_V16_DEFAULT_LIMITS[kind];
}

/** Kỳ hiệu lực của tenant cho một loại theo kỳ. */
export function tenantV16PeriodFor(record: TenantV16Record, kind: TenantV16QuotaKind): TenantV16QuotaPeriod {
  return record.periods[kind] ?? TENANT_V16_DEFAULT_PERIODS[kind];
}

/** Lượng đã dùng hiện tại (kỳ hiện tại với period kind, mức hiện tại với level kind). */
export function tenantV16UsedAmount(
  record: TenantV16Record,
  kind: TenantV16QuotaKind,
  now = Date.now(),
): number {
  if (isTenantV16PeriodQuota(kind)) {
    const period = tenantV16PeriodFor(record, kind);
    const key = tenantV16PeriodKey(period, now);
    return record.usage.period[kind]?.[key] ?? 0;
  }
  return record.usage.level[kind] ?? 0;
}

/** Lượng còn lại (có thể âm khi đã vượt). */
export function tenantV16Remaining(
  record: TenantV16Record,
  kind: TenantV16QuotaKind,
  now = Date.now(),
): number {
  return tenantV16LimitFor(record, kind) - tenantV16UsedAmount(record, kind, now);
}

export interface TenantV16ConsumeResult {
  ok: boolean;
  state: TenantV16QuotaState;
  /** Lượng còn lại sau khi consume (âm = đã vượt — chỉ khi ok). */
  remaining: number;
  /** Mức cảnh báo sau khi consume. */
  warning: TenantV16WarningLevel;
  /** Epoch ms kỳ reset (period kind) hoặc 0 (level kind). */
  resetAtMs: number;
  error: string;
}

function tenantV16Fail(
  state: TenantV16QuotaState,
  error: string,
): TenantV16ConsumeResult {
  return { ok: false, state, remaining: 0, warning: 'none', resetAtMs: 0, error };
}

/** Tìm tenant theo id. */
export function findTenantV16Record(
  state: TenantV16QuotaState,
  tenantId: string,
): TenantV16Record | null {
  return state.tenants.find((t) => t.tenantId === tenantId) ?? null;
}

/** Lỗi validate tenant id/tên, '' = hợp lệ. */
export function validateTenantV16Id(tenantId: string, displayName: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenantId)) {
    return 'tenantId phải là slug: chữ thường/số/_/-, bắt đầu bằng chữ/số';
  }
  if (displayName.trim().length === 0 || displayName.length > 80) {
    return 'displayName không được rỗng và tối đa 80 ký tự';
  }
  return '';
}

/** Tạo tenant mới (trùng id → lỗi). */
export function createTenantV16Record(
  state: TenantV16QuotaState,
  input: { tenantId: string; displayName: string },
  now = Date.now(),
): { ok: boolean; state: TenantV16QuotaState; error: string } {
  const invalid = validateTenantV16Id(input.tenantId, input.displayName);
  if (invalid) return { ok: false, state, error: invalid };
  if (findTenantV16Record(state, input.tenantId)) {
    return { ok: false, state, error: `tenant đã tồn tại: ${input.tenantId}` };
  }
  if (state.tenants.length >= TENANT_V16_MAX_TENANTS) {
    return { ok: false, state, error: `đã đạt tối đa ${TENANT_V16_MAX_TENANTS} tenant` };
  }
  const record: TenantV16Record = {
    tenantId: input.tenantId,
    displayName: input.displayName.trim(),
    overrides: {},
    periods: {},
    usage: { period: {}, level: {} },
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, state: { ...state, tenants: [...state.tenants, record], updatedAt: now }, error: '' };
}

/**
 * Đặt override giới hạn cho tenant (0 = chặn hẳn loại đó;
 * null = về mặc định). Giới hạn âm → lỗi.
 */
export function setTenantV16QuotaOverride(
  state: TenantV16QuotaState,
  input: { tenantId: string; kind: TenantV16QuotaKind; limit: number | null },
  now = Date.now(),
): { ok: boolean; state: TenantV16QuotaState; error: string } {
  const record = findTenantV16Record(state, input.tenantId);
  if (!record) return { ok: false, state, error: `không tìm thấy tenant: ${input.tenantId}` };
  if (!TENANT_V16_QUOTA_KINDS.includes(input.kind)) {
    return { ok: false, state, error: `loại quota không hợp lệ: ${input.kind}` };
  }
  if (input.limit !== null && (!Number.isFinite(input.limit) || input.limit < 0)) {
    return { ok: false, state, error: 'giới hạn override phải >= 0 hoặc null' };
  }
  const tenants = state.tenants.map((t) =>
    t.tenantId === input.tenantId
      ? {
          ...t,
          overrides: { ...t.overrides, [input.kind]: input.limit },
          updatedAt: now,
        }
      : t,
  );
  return { ok: true, state: { ...state, tenants, updatedAt: now }, error: '' };
}

/** Đặt kỳ reset cho một loại quota theo kỳ. */
export function setTenantV16QuotaPeriod(
  state: TenantV16QuotaState,
  input: { tenantId: string; kind: TenantV16QuotaKind; period: TenantV16QuotaPeriod },
  now = Date.now(),
): { ok: boolean; state: TenantV16QuotaState; error: string } {
  const record = findTenantV16Record(state, input.tenantId);
  if (!record) return { ok: false, state, error: `không tìm thấy tenant: ${input.tenantId}` };
  if (!isTenantV16PeriodQuota(input.kind)) {
    return { ok: false, state, error: `loại ${input.kind} không phải quota theo kỳ` };
  }
  if (!TENANT_V16_QUOTA_PERIODS.includes(input.period)) {
    return { ok: false, state, error: `kỳ không hợp lệ: ${input.period}` };
  }
  const tenants = state.tenants.map((t) =>
    t.tenantId === input.tenantId
      ? { ...t, periods: { ...t.periods, [input.kind]: input.period }, updatedAt: now }
      : t,
  );
  return { ok: true, state: { ...state, tenants, updatedAt: now }, error: '' };
}

function updateTenantV16Record(
  state: TenantV16QuotaState,
  tenantId: string,
  patch: (r: TenantV16Record) => TenantV16Record,
  now: number,
): TenantV16QuotaState {
  return {
    ...state,
    tenants: state.tenants.map((t) => (t.tenantId === tenantId ? { ...patch(t), updatedAt: now } : t)),
    updatedAt: now,
  };
}

/**
 * Consume quota: trừ trước rồi kiểm tra — vượt giới hạn thì từ
 * chối và KHÔNG ghi (state không đổi). amount <= 0 → lỗi.
 * Trả về mức cảnh báo sau khi consume để caller báo cho user.
 */
export function consumeTenantV16Quota(
  state: TenantV16QuotaState,
  input: { tenantId: string; kind: TenantV16QuotaKind; amount: number },
  now = Date.now(),
): TenantV16ConsumeResult {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return tenantV16Fail(state, 'amount phải > 0');
  }
  const record = findTenantV16Record(state, input.tenantId);
  if (!record) return tenantV16Fail(state, `không tìm thấy tenant: ${input.tenantId}`);
  const limit = tenantV16LimitFor(record, input.kind);
  const used = tenantV16UsedAmount(record, input.kind, now);
  if (used + input.amount > limit) {
    return {
      ok: false,
      state,
      remaining: limit - used,
      warning: tenantV16WarningLevel(limit > 0 ? used / limit : 1),
      resetAtMs: isTenantV16PeriodQuota(input.kind)
        ? tenantV16NextPeriodStartMs(tenantV16PeriodFor(record, input.kind), now)
        : 0,
      error: `tenant ${input.tenantId} vượt quota ${input.kind}: cần ${input.amount}, còn ${limit - used}`,
    };
  }
  let next: TenantV16QuotaState;
  if (isTenantV16PeriodQuota(input.kind)) {
    const period = tenantV16PeriodFor(record, input.kind);
    const key = tenantV16PeriodKey(period, now);
    next = updateTenantV16Record(state, input.tenantId, (r) => ({
      ...r,
      usage: {
        ...r.usage,
        period: {
          ...r.usage.period,
          [input.kind]: { ...(r.usage.period[input.kind] ?? {}), [key]: used + input.amount },
        },
      },
    }), now);
  } else {
    next = updateTenantV16Record(state, input.tenantId, (r) => ({
      ...r,
      usage: {
        ...r.usage,
        level: { ...r.usage.level, [input.kind]: used + input.amount },
      },
    }), now);
  }
  const afterUsed = used + input.amount;
  return {
    ok: true,
    state: next,
    remaining: limit - afterUsed,
    warning: tenantV16WarningLevel(limit > 0 ? afterUsed / limit : 1),
    resetAtMs: isTenantV16PeriodQuota(input.kind)
      ? tenantV16NextPeriodStartMs(tenantV16PeriodFor(record, input.kind), now)
      : 0,
    error: '',
  };
}

/**
 * Release quota mức hiện tại (storage/bots): giải phóng thì trả
 * lại — không bao giờ âm. Quota theo kỳ không release được (kỳ
 * tự reset).
 */
export function releaseTenantV16Quota(
  state: TenantV16QuotaState,
  input: { tenantId: string; kind: TenantV16QuotaKind; amount: number },
  now = Date.now(),
): { ok: boolean; state: TenantV16QuotaState; error: string } {
  if (isTenantV16PeriodQuota(input.kind)) {
    return { ok: false, state, error: `quota theo kỳ (${input.kind}) không release được — chờ reset kỳ` };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, state, error: 'amount phải > 0' };
  }
  const record = findTenantV16Record(state, input.tenantId);
  if (!record) return { ok: false, state, error: `không tìm thấy tenant: ${input.tenantId}` };
  const used = tenantV16UsedAmount(record, input.kind, now);
  const next = updateTenantV16Record(state, input.tenantId, (r) => ({
    ...r,
    usage: {
      ...r.usage,
      level: { ...r.usage.level, [input.kind]: Math.max(0, used - input.amount) },
    },
  }), now);
  return { ok: true, state: next, error: '' };
}

// ---------------------------------------------------------------------------
// Tóm tắt + cảnh báo
// ---------------------------------------------------------------------------

/** Một dòng quota của tenant cho panel. */
export interface TenantV16QuotaRow {
  kind: TenantV16QuotaKind;
  limit: number;
  used: number;
  remaining: number;
  fraction: number;
  warning: TenantV16WarningLevel;
  period: TenantV16QuotaPeriod | null;
  resetAtMs: number;
}

export function summarizeTenantV16Quota(
  record: TenantV16Record,
  now = Date.now(),
): TenantV16QuotaRow[] {
  return TENANT_V16_QUOTA_KINDS.map((kind) => {
    const limit = tenantV16LimitFor(record, kind);
    const used = tenantV16UsedAmount(record, kind, now);
    const fraction = limit > 0 ? used / limit : used > 0 ? 1 : 0;
    return {
      kind,
      limit,
      used,
      remaining: limit - used,
      fraction,
      warning: tenantV16WarningLevel(fraction),
      period: isTenantV16PeriodQuota(kind) ? tenantV16PeriodFor(record, kind) : null,
      resetAtMs: isTenantV16PeriodQuota(kind)
        ? tenantV16NextPeriodStartMs(tenantV16PeriodFor(record, kind), now)
        : 0,
    };
  });
}

/** Một cảnh báo quota (tenant sắp/vượt ngưỡng). */
export interface TenantV16Alert {
  tenantId: string;
  kind: TenantV16QuotaKind;
  warning: TenantV16WarningLevel;
  used: number;
  limit: number;
  fraction: number;
}

/** Tất cả tenant đang ở mức warning trở lên (để panel Admin báo động). */
export function tenantV16Alerts(
  state: TenantV16QuotaState,
  minLevel: TenantV16WarningLevel = 'warning',
  now = Date.now(),
): TenantV16Alert[] {
  const order: Record<TenantV16WarningLevel, number> = {
    none: 0,
    watch: 1,
    warning: 2,
    critical: 3,
    exceeded: 4,
  };
  const out: TenantV16Alert[] = [];
  for (const record of state.tenants) {
    for (const row of summarizeTenantV16Quota(record, now)) {
      if (order[row.warning] >= order[minLevel] && row.warning !== 'none') {
        out.push({
          tenantId: record.tenantId,
          kind: row.kind,
          warning: row.warning,
          used: row.used,
          limit: row.limit,
          fraction: row.fraction,
        });
      }
    }
  }
  return out.sort((a, b) => order[b.warning] - order[a.warning] || b.fraction - a.fraction);
}

/** Xóa usage kỳ cũ hơn N ngày (giữ state gọn). */
export function pruneTenantV16Usage(
  state: TenantV16QuotaState,
  retentionDays = TENANT_V16_USAGE_RETENTION_DAYS,
  now = Date.now(),
): TenantV16QuotaState {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  const tenants = state.tenants.map((t) => {
    const period: Record<string, Record<string, number>> = {};
    for (const [kind, byKey] of Object.entries(t.usage.period)) {
      const kept: Record<string, number> = {};
      for (const [key, value] of Object.entries(byKey)) {
        // Key kỳ dạng ngày YYYY-MM-DD so sánh được theo chuỗi;
        // key tuần/tháng (YYYY-W.. / YYYY-MM) giữ nguyên vì không
        // suy ra ngày chính xác — chỉ prune key ngày.
        if (/^\d{4}-\d{2}-\d{2}$/.test(key) && key < cutoffDay) continue;
        kept[key] = value;
      }
      period[kind] = kept;
    }
    return { ...t, usage: { ...t.usage, period } };
  });
  return { ...state, tenants, updatedAt: now };
}

/** Lưu state tenant quota xuống team root (JSON). */
export function saveTenantV16QuotaState(teamRoot: string, state: TenantV16QuotaState): void {
  fs.mkdirSync(teamRoot, { recursive: true });
  fs.writeFileSync(path.join(teamRoot, TENANT_V16_QUOTAS_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Đọc state tenant quota (null khi chưa có file / file hỏng / sai version). */
export function loadTenantV16QuotaState(teamRoot: string): TenantV16QuotaState | null {
  try {
    const raw = fs.readFileSync(path.join(teamRoot, TENANT_V16_QUOTAS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as TenantV16QuotaState;
    if (parsed.version !== TENANT_V16_QUOTA_STATE_VERSION || !Array.isArray(parsed.tenants)) return null;
    return parsed;
  } catch {
    return null;
  }
}
