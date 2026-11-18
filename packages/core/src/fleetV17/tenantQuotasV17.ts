/**
 * Tenant quotas v2 — hạn mức tài nguyên theo tenant: CPU/RAM/disk
 * (mức hiện tại), API calls (theo kỳ), enforcement mềm/cứng, quota
 * override có audit (v1.20, Đội T6).
 *
 * Tầng trên của tenant quotas v16 (`fleetV16/tenantQuotasV16.ts` —
 * model-calls/model-tokens/tool-calls theo kỳ, storage-bytes/bots
 * theo mức, cảnh báo 80/90/100%, override giới hạn). V16 trả lời
 * "tenant này đã dùng bao nhiêu quota loại X"; v17 trả lời 4 câu
 * vận hành tài nguyên còn thiếu:
 *
 * - QUOTA TÀI NGUYÊN: `cpu-cores` + `ram-mb` + `disk-mb` là quota
 *   MỨC (level — chiếm bao nhiêu thì trừ bấy nhiêu, giải phóng thì
 *   trả lại, như số bot của v16 nhưng cho tài nguyên máy thật);
 *   `api-calls` là quota KỲ (ngày/tuần/tháng, tái dùng period key
 *   của v16). Caller đo tài nguyên thật và truyền vào.
 * - ENFORCEMENT MỀM/CỨNG: mỗi loại quota có chế độ `soft` (vượt
 *   thì vẫn cho qua nhưng ghi cảnh báo — dùng cho tenant đang
 *   migrate / thử nghiệm) hoặc `hard` (vượt thì chặn lượt gọi mới).
 *   Mặc định: tài nguyên mức = hard, api-calls = hard; admin đổi
 *   được từng loại từng tenant.
 * - CẢNH BÁO MỀM/CỨNG: vượt soft limit thì mức cảnh báo là
 *   `soft-exceeded` (cho qua + ghi log để admin xử lý sau); chạm
 *   hard limit thì `exceeded` (chặn). Mức cảnh báo v16 (watch /
 *   warning / critical) vẫn dùng cho phần dưới 100%.
 * - OVERRIDE CÓ AUDIT: mọi lần admin đổi giới hạn / đổi chế độ
 *   enforcement đều ghi một entry audit (seq, thời gian, ai đổi,
 *   giới hạn cũ → mới, lý do) — không còn đổi quota âm thầm như
 *   v16; audit list lọc được theo tenant/kind/actor.
 *
 * Module này KHÔNG đo tài nguyên thật, KHÔNG chặn gọi thật: nó
 * quyết định "tenant này còn quota không, vượt mềm hay cứng, ai
 * đã đổi quota" từ số liệu caller truyền vào — việc chặn / đo
 * dung lượng do caller làm theo kết quả.
 */

import {
  tenantV16PeriodKey,
  tenantV16WarningLevel,
} from '../fleetV16/tenantQuotasV16';
import type { TenantV16QuotaPeriod, TenantV16WarningLevel } from '../fleetV16/tenantQuotasV16';

/** Phiên bản định dạng state. */
export const TENANT_V17_QUOTA_STATE_VERSION = 1;
/** Số tenant tối đa. */
export const TENANT_V17_MAX_TENANTS = 1000;
/** Số entry audit override giữ tối đa (cũ nhất bị cắt). */
export const TENANT_V17_MAX_OVERRIDE_AUDIT = 5000;

/** Loại quota tài nguyên v17. */
export type TenantV17QuotaKind = 'cpu-cores' | 'ram-mb' | 'disk-mb' | 'api-calls';

export const TENANT_V17_QUOTA_KINDS: readonly TenantV17QuotaKind[] = [
  'cpu-cores',
  'ram-mb',
  'disk-mb',
  'api-calls',
];

/** Loại quota theo kỳ (chỉ `api-calls`). */
export const TENANT_V17_PERIOD_QUOTA_KINDS: readonly TenantV17QuotaKind[] = ['api-calls'];

/** Loại quota theo mức hiện tại. */
export const TENANT_V17_LEVEL_QUOTA_KINDS: readonly TenantV17QuotaKind[] = [
  'cpu-cores',
  'ram-mb',
  'disk-mb',
];

export function isTenantV17PeriodQuota(kind: TenantV17QuotaKind): boolean {
  return (TENANT_V17_PERIOD_QUOTA_KINDS as readonly TenantV17QuotaKind[]).includes(kind);
}

/** Giới hạn mặc định theo loại. */
export const TENANT_V17_DEFAULT_LIMITS: Readonly<Record<TenantV17QuotaKind, number>> = {
  'cpu-cores': 16,
  'ram-mb': 65536,
  'disk-mb': 512000,
  'api-calls': 10000,
};

/** Kỳ mặc định của `api-calls`. */
export const TENANT_V17_DEFAULT_API_CALLS_PERIOD: TenantV16QuotaPeriod = 'daily';

/** Chế độ enforcement mặc định theo loại. */
export const TENANT_V17_DEFAULT_ENFORCEMENT: Readonly<
  Record<TenantV17QuotaKind, TenantV17Enforcement>
> = {
  'cpu-cores': 'hard',
  'ram-mb': 'hard',
  'disk-mb': 'hard',
  'api-calls': 'hard',
};

/** Chế độ enforcement: mềm (vượt vẫn cho qua + cảnh báo) / cứng (vượt thì chặn). */
export type TenantV17Enforcement = 'soft' | 'hard';

export const TENANT_V17_ENFORCEMENTS: readonly TenantV17Enforcement[] = ['soft', 'hard'];

/** Mức cảnh báo v17 (mở rộng mức v16 bằng `soft-exceeded`). */
export type TenantV17WarningLevel = TenantV16WarningLevel | 'soft-exceeded';

export const TENANT_V17_WARNING_LEVELS: readonly TenantV17WarningLevel[] = [
  'none',
  'watch',
  'warning',
  'critical',
  'exceeded',
  'soft-exceeded',
];

/**
 * Mức cảnh báo từ tỷ lệ đã dùng + chế độ enforcement: dưới/vừa
 * 100% dùng thang v16 (80% watch, 90% warning, 100% critical);
 * VƯỢT 100%: hard → `exceeded`, soft → `soft-exceeded`.
 */
export function tenantV17WarningLevel(
  fraction: number,
  enforcement: TenantV17Enforcement,
): TenantV17WarningLevel {
  if (fraction > 1) return enforcement === 'hard' ? 'exceeded' : 'soft-exceeded';
  return tenantV16WarningLevel(fraction);
}

/** Một entry audit khi admin đổi quota. */
export interface TenantV17OverrideAudit {
  seq: number;
  at: number;
  tenantId: string;
  kind: TenantV17QuotaKind;
  /** Giới hạn cũ (null = đang dùng mặc định). */
  oldLimit: number | null;
  /** Giới hạn mới (null = về mặc định). */
  newLimit: number | null;
  /** Enforcement cũ (null = đang dùng mặc định). */
  oldEnforcement: TenantV17Enforcement | null;
  /** Enforcement mới (null = không đổi). */
  newEnforcement: TenantV17Enforcement | null;
  actorUserId: string;
  reason: string;
}

/** Bản ghi quota v17 của một tenant. */
export interface TenantV17Record {
  tenantId: string;
  displayName: string;
  /** Giới hạn override theo loại (thiếu = mặc định). */
  limits: Partial<Record<TenantV17QuotaKind, number>>;
  /** Enforcement override theo loại (thiếu = mặc định). */
  enforcement: Partial<Record<TenantV17QuotaKind, TenantV17Enforcement>>;
  /** Kỳ của `api-calls` (mặc định daily). */
  apiCallsPeriod: TenantV16QuotaPeriod;
  /** Mức đang dùng của quota level (cpu/ram/disk). */
  levelUsage: Record<'cpu-cores' | 'ram-mb' | 'disk-mb', number>;
  /** Lượt gọi API theo kỳ (period key → số lần). */
  apiCallsUsage: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

/** Toàn bộ state quota v17. */
export interface TenantV17QuotaState {
  version: 1;
  tenants: TenantV17Record[];
  overrideAudit: TenantV17OverrideAudit[];
  /** Seq tiếp theo cho audit. */
  nextAuditSeq: number;
  updatedAt: number;
}

export function createTenantV17QuotaState(now = Date.now()): TenantV17QuotaState {
  return { version: 1, tenants: [], overrideAudit: [], nextAuditSeq: 1, updatedAt: now };
}

/** Lỗi validate tenant id + tên hiển thị, '' = hợp lệ. */
export function validateTenantV17Id(tenantId: string, displayName: string): string {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') return 'tenantId không được rỗng';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tenantId)) return `tenantId không hợp lệ: ${tenantId}`;
  if (typeof displayName !== 'string' || displayName.trim() === '') return 'displayName không được rỗng';
  return '';
}

/** Giới hạn áp dụng cho tenant + loại (override thắng mặc định). */
export function tenantV17LimitFor(record: TenantV17Record, kind: TenantV17QuotaKind): number {
  return record.limits[kind] ?? TENANT_V17_DEFAULT_LIMITS[kind];
}

/** Enforcement áp dụng cho tenant + loại (override thắng mặc định). */
export function tenantV17EnforcementFor(
  record: TenantV17Record,
  kind: TenantV17QuotaKind,
): TenantV17Enforcement {
  return record.enforcement[kind] ?? TENANT_V17_DEFAULT_ENFORCEMENT[kind];
}

/** Lượng đã dùng hiện tại của tenant + loại (level hoặc kỳ hiện tại). */
export function tenantV17UsedAmount(
  record: TenantV17Record,
  kind: TenantV17QuotaKind,
  now = Date.now(),
): number {
  if (kind === 'api-calls') {
    return record.apiCallsUsage[tenantV16PeriodKey(record.apiCallsPeriod, now)] ?? 0;
  }
  return record.levelUsage[kind];
}

/** Lượng còn lại (có thể âm khi đã vượt). */
export function tenantV17Remaining(
  record: TenantV17Record,
  kind: TenantV17QuotaKind,
  now = Date.now(),
): number {
  return tenantV17LimitFor(record, kind) - tenantV17UsedAmount(record, kind, now);
}

/** Tìm bản ghi tenant (null = chưa có). */
export function findTenantV17Record(
  state: TenantV17QuotaState,
  tenantId: string,
): TenantV17Record | null {
  return state.tenants.find((t) => t.tenantId === tenantId) ?? null;
}

/** Tạo tenant mới (trùng id → lỗi). */
export function createTenantV17Record(
  state: TenantV17QuotaState,
  tenantId: string,
  displayName: string,
  now = Date.now(),
): { ok: true; record: TenantV17Record } | { ok: false; reason: string } {
  const invalid = validateTenantV17Id(tenantId, displayName);
  if (invalid) return { ok: false, reason: invalid };
  if (findTenantV17Record(state, tenantId)) return { ok: false, reason: `tenant đã tồn tại: ${tenantId}` };
  if (state.tenants.length >= TENANT_V17_MAX_TENANTS) {
    return { ok: false, reason: `đã chạm tối đa ${TENANT_V17_MAX_TENANTS} tenant` };
  }
  const record: TenantV17Record = {
    tenantId,
    displayName,
    limits: {},
    enforcement: {},
    apiCallsPeriod: TENANT_V17_DEFAULT_API_CALLS_PERIOD,
    levelUsage: { 'cpu-cores': 0, 'ram-mb': 0, 'disk-mb': 0 },
    apiCallsUsage: {},
    createdAt: now,
    updatedAt: now,
  };
  state.tenants.push(record);
  state.updatedAt = now;
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Kiểm tra + tiêu thụ quota
// ---------------------------------------------------------------------------

/** Kết quả kiểm tra quota trước một lần dùng. */
export interface TenantV17CheckResult {
  allowed: boolean;
  kind: TenantV17QuotaKind;
  tenantId: string;
  /** Mức cảnh báo (tính trên lượng dùng SAU lần này nếu được phép). */
  level: TenantV17WarningLevel;
  enforcement: TenantV17Enforcement;
  limit: number;
  used: number;
  remaining: number;
  /** Tỷ lệ đã dùng sau lần này (0..n, có thể > 1). */
  fraction: number;
  reason: string;
}

/**
 * Kiểm tra một lần dùng quota (KHÔNG ghi): hard + VƯỢT 100% thì
 * chặn (đúng 100% vẫn cho qua với mức critical, theo thang v16);
 * soft + vượt thì cho qua với mức `soft-exceeded`; giới hạn 0 =
 * chặn hẳn loại đó (kể cả soft — 0 nghĩa là tắt loại quota này).
 */
export function checkTenantV17Quota(
  record: TenantV17Record,
  kind: TenantV17QuotaKind,
  amount: number,
  now = Date.now(),
): TenantV17CheckResult {
  const limit = tenantV17LimitFor(record, kind);
  const enforcement = tenantV17EnforcementFor(record, kind);
  const used = tenantV17UsedAmount(record, kind, now);
  const after = used + amount;
  const fraction = limit === 0 ? (after > 0 ? Number.POSITIVE_INFINITY : 0) : after / limit;
  const level = tenantV17WarningLevel(fraction, enforcement);
  if (limit === 0 && amount > 0) {
    return {
      allowed: false, kind, tenantId: record.tenantId, level: 'exceeded', enforcement,
      limit, used, remaining: -after, fraction, reason: `quota ${kind} đã tắt cho tenant này (giới hạn 0)`,
    };
  }
  if (fraction > 1 && enforcement === 'hard') {
    return {
      allowed: false, kind, tenantId: record.tenantId, level, enforcement,
      limit, used, remaining: limit - after, fraction,
      reason: `vượt quota cứng ${kind}: ${after}/${limit}`,
    };
  }
  return {
    allowed: true, kind, tenantId: record.tenantId, level, enforcement,
    limit, used, remaining: limit - after, fraction,
    reason:
      level === 'soft-exceeded'
        ? `vượt quota mềm ${kind}: ${after}/${limit} (vẫn cho qua, đã ghi cảnh báo)`
        : '',
  };
}

/** Kết quả tiêu thụ quota. */
export interface TenantV17ConsumeResult extends TenantV17CheckResult {
  /** true = lần dùng đã được ghi. */
  consumed: boolean;
}

/**
 * Tiêu thụ quota: kiểm tra trước, chỉ ghi khi được phép (soft vượt
 * vẫn ghi). Lượng âm → lỗi (dùng `releaseTenantV17Quota` để trả).
 */
export function consumeTenantV17Quota(
  state: TenantV17QuotaState,
  tenantId: string,
  kind: TenantV17QuotaKind,
  amount: number,
  now = Date.now(),
): TenantV17ConsumeResult {
  const record = findTenantV17Record(state, tenantId);
  if (!record) {
    return {
      allowed: false, consumed: false, kind, tenantId, level: 'exceeded', enforcement: 'hard',
      limit: 0, used: 0, remaining: 0, fraction: Number.POSITIVE_INFINITY,
      reason: `tenant chưa tồn tại: ${tenantId}`,
    };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      allowed: false, consumed: false, kind, tenantId, level: 'none', enforcement: tenantV17EnforcementFor(record, kind),
      limit: tenantV17LimitFor(record, kind), used: tenantV17UsedAmount(record, kind, now),
      remaining: tenantV17Remaining(record, kind, now), fraction: 0, reason: 'amount phải > 0',
    };
  }
  const check = checkTenantV17Quota(record, kind, amount, now);
  if (!check.allowed) return { ...check, consumed: false };
  if (kind === 'api-calls') {
    const key = tenantV16PeriodKey(record.apiCallsPeriod, now);
    record.apiCallsUsage[key] = (record.apiCallsUsage[key] ?? 0) + amount;
  } else {
    record.levelUsage[kind] += amount;
  }
  record.updatedAt = now;
  state.updatedAt = now;
  return { ...check, consumed: true };
}

/** Trả lại quota mức đã chiếm (cpu/ram/disk) — không cho âm. */
export function releaseTenantV17Quota(
  state: TenantV17QuotaState,
  tenantId: string,
  kind: 'cpu-cores' | 'ram-mb' | 'disk-mb',
  amount: number,
  now = Date.now(),
): { ok: boolean; remaining: number; reason: string } {
  const record = findTenantV17Record(state, tenantId);
  if (!record) return { ok: false, remaining: 0, reason: `tenant chưa tồn tại: ${tenantId}` };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, remaining: record.levelUsage[kind], reason: 'amount phải > 0' };
  record.levelUsage[kind] = Math.max(0, record.levelUsage[kind] - amount);
  record.updatedAt = now;
  state.updatedAt = now;
  return { ok: true, remaining: record.levelUsage[kind], reason: '' };
}

// ---------------------------------------------------------------------------
// Override có audit
// ---------------------------------------------------------------------------

/**
 * Đặt override giới hạn và/hoặc enforcement cho một loại quota —
 * MỖI lần gọi đều ghi một entry audit (kể cả khi giá trị không
 * đổi? không — chỉ ghi khi có thay đổi thật). Giới hạn âm → lỗi;
 * 0 = chặn hẳn loại đó. `newLimit: null` = về mặc định.
 */
export function setTenantV17QuotaOverride(
  state: TenantV17QuotaState,
  tenantId: string,
  kind: TenantV17QuotaKind,
  opts: { newLimit?: number | null; newEnforcement?: TenantV17Enforcement | null; actorUserId: string; reason: string },
  now = Date.now(),
): { ok: true; audit: TenantV17OverrideAudit } | { ok: false; reason: string } {
  const record = findTenantV17Record(state, tenantId);
  if (!record) return { ok: false, reason: `tenant chưa tồn tại: ${tenantId}` };
  if (opts.actorUserId.trim() === '') return { ok: false, reason: 'actorUserId không được rỗng' };
  if (opts.reason.trim() === '') return { ok: false, reason: 'reason không được rỗng (override quota phải có lý do)' };
  if (opts.newLimit !== undefined && opts.newLimit !== null) {
    if (!Number.isFinite(opts.newLimit) || opts.newLimit < 0) return { ok: false, reason: 'newLimit phải >= 0 hoặc null' };
  }
  const oldLimit = record.limits[kind] ?? null;
  const oldEnforcement = record.enforcement[kind] ?? null;
  const newLimit = opts.newLimit === undefined ? oldLimit : opts.newLimit;
  const newEnforcement = opts.newEnforcement === undefined ? oldEnforcement : opts.newEnforcement;
  if (newLimit === oldLimit && newEnforcement === oldEnforcement) {
    return { ok: false, reason: 'không có thay đổi nào (giới hạn + enforcement giữ nguyên)' };
  }
  if (opts.newLimit === undefined) {
    // Chỉ đổi enforcement.
  } else if (opts.newLimit === null) {
    delete record.limits[kind];
  } else {
    record.limits[kind] = opts.newLimit;
  }
  if (opts.newEnforcement !== undefined && opts.newEnforcement !== null) {
    record.enforcement[kind] = opts.newEnforcement;
  } else if (opts.newEnforcement === null) {
    delete record.enforcement[kind];
  }
  const audit: TenantV17OverrideAudit = {
    seq: state.nextAuditSeq,
    at: now,
    tenantId,
    kind,
    oldLimit,
    newLimit,
    oldEnforcement,
    newEnforcement,
    actorUserId: opts.actorUserId,
    reason: opts.reason,
  };
  state.nextAuditSeq += 1;
  state.overrideAudit.push(audit);
  if (state.overrideAudit.length > TENANT_V17_MAX_OVERRIDE_AUDIT) {
    state.overrideAudit.splice(0, state.overrideAudit.length - TENANT_V17_MAX_OVERRIDE_AUDIT);
  }
  record.updatedAt = now;
  state.updatedAt = now;
  return { ok: true, audit };
}

/** Lọc audit override theo tenant/kind/actor/khoảng thời gian. */
export function listTenantV17OverrideAudit(
  state: TenantV17QuotaState,
  filter: { tenantId?: string; kind?: TenantV17QuotaKind; actorUserId?: string; fromAt?: number; toAt?: number } = {},
): TenantV17OverrideAudit[] {
  return state.overrideAudit.filter((a) => {
    if (filter.tenantId !== undefined && a.tenantId !== filter.tenantId) return false;
    if (filter.kind !== undefined && a.kind !== filter.kind) return false;
    if (filter.actorUserId !== undefined && a.actorUserId !== filter.actorUserId) return false;
    if (filter.fromAt !== undefined && a.at < filter.fromAt) return false;
    if (filter.toAt !== undefined && a.at > filter.toAt) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Tóm tắt + cảnh báo + prune
// ---------------------------------------------------------------------------

/** Một dòng tóm tắt quota của tenant. */
export interface TenantV17QuotaRow {
  kind: TenantV17QuotaKind;
  limit: number;
  used: number;
  remaining: number;
  fraction: number;
  level: TenantV17WarningLevel;
  enforcement: TenantV17Enforcement;
  isOverride: boolean;
}

export function summarizeTenantV17Quota(
  record: TenantV17Record,
  now = Date.now(),
): TenantV17QuotaRow[] {
  return TENANT_V17_QUOTA_KINDS.map((kind) => {
    const limit = tenantV17LimitFor(record, kind);
    const used = tenantV17UsedAmount(record, kind, now);
    const enforcement = tenantV17EnforcementFor(record, kind);
    const fraction = limit === 0 ? (used > 0 ? Number.POSITIVE_INFINITY : 0) : used / limit;
    return {
      kind,
      limit,
      used,
      remaining: limit - used,
      fraction: Math.round(fraction * 1000) / 1000,
      level: tenantV17WarningLevel(fraction, enforcement),
      enforcement,
      isOverride: record.limits[kind] !== undefined || record.enforcement[kind] !== undefined,
    };
  });
}

/** Một cảnh báo quota (chỉ các dòng đáng chú ý). */
export interface TenantV17Alert {
  tenantId: string;
  kind: TenantV17QuotaKind;
  level: TenantV17WarningLevel;
  enforcement: TenantV17Enforcement;
  fraction: number;
  message: string;
}

/** Cảnh báo của toàn bộ tenant (mức watch trở lên). */
export function tenantV17Alerts(state: TenantV17QuotaState, now = Date.now()): TenantV17Alert[] {
  const out: TenantV17Alert[] = [];
  for (const record of state.tenants) {
    for (const row of summarizeTenantV17Quota(record, now)) {
      if (row.level === 'none') continue;
      const pct = Math.round(row.fraction * 100);
      out.push({
        tenantId: record.tenantId,
        kind: row.kind,
        level: row.level,
        enforcement: row.enforcement,
        fraction: row.fraction,
        message:
          row.level === 'exceeded'
            ? `tenant ${record.tenantId} vượt quota cứng ${row.kind} (${pct}%) — lượt gọi mới bị chặn`
            : row.level === 'soft-exceeded'
              ? `tenant ${record.tenantId} vượt quota mềm ${row.kind} (${pct}%) — vẫn cho qua, cần xem lại giới hạn`
              : `tenant ${record.tenantId} dùng ${pct}% quota ${row.kind}`,
      });
    }
  }
  return out.sort((a, b) => b.fraction - a.fraction);
}

/** Dọn usage api-calls của kỳ quá 90 ngày (giữ state gọn). */
export function pruneTenantV17Usage(state: TenantV17QuotaState, now = Date.now()): number {
  const cutoff = now - 90 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const record of state.tenants) {
    for (const key of Object.keys(record.apiCallsUsage)) {
      // Period key dạng YYYY-MM-DD / YYYY-Www / YYYY-MM — ước lượng
      // thời gian kỳ từ key ngày; key tuần/tháng giữ lại (không đủ
      // chính xác để cắt) trừ khi key ngày đã quá hạn.
      const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
      if (!day) continue;
      const keyMs = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
      if (keyMs < cutoff) {
        delete record.apiCallsUsage[key];
        removed += 1;
      }
    }
  }
  if (removed > 0) state.updatedAt = now;
  return removed;
}
