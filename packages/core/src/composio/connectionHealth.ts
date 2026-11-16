/**
 * Composio connection health dashboard v2 (v1.14, Doi T4).
 *
 * `toolkitConnections.ts` (v1.08) da co quan ly bat/tat + health
 * check theo toolkit, va `toolkitStatusPolling.ts` poll trang thai
 * connection theo lich — nhung ca hai deu khong giu LICH SU: khong
 * biet connection loi bao nhieu lan, cham bao nhieu, lan sync cuoi
 * cach day bao lau, hay khi nao thi coi la "yeu" de bao user.
 * Module nay them lop do — dashboard suc khoe theo tung connection:
 *
 * - Moi connection giu: trang thai, lan sync cuoi, lan thanh cong
 *   cuoi, tong so poll / so loi, ti le loi, latency cac lan sync
 *   gan nhat (avg + p50 + p95), han het han (neu co, vd OAuth
 *   token het han), danh sach canh bao hien tai.
 * - Quy tac danh gia (pure, de test): ti le loi >= 50% hoac loi
 *   lien tiep >= 5 → unhealthy; ti le loi >= 20% hoac khong sync
 *   qua 24h → degraded; qua han het han → expired; con lai →
 *   healthy. Canh bao sinh ra tu cac quy tac do (weak connection,
 *   stale sync, slow p95, expiring soon, expired).
 * - Store trong bo nho + serialize JSON de caller luu xuong dia;
 *   khong goi mang, khong doc Vault, khong chua secret — chi co
 *   id connection + so lieu tong hop.
 *
 * Tat ca ham quyet dinh deu thuan (nowMs do caller truyen vao).
 */

/** Trang thai suc khoe mot connection. */
export type ComposioV114HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'expired' | 'unknown';

/** Loai canh bao tren mot connection. */
export type ComposioV114HealthAlertKind =
  | 'high-error-rate'
  | 'consecutive-errors'
  | 'stale-sync'
  | 'slow-response'
  | 'expiring-soon'
  | 'expired'
  | 'never-synced';

/** Mot canh bao (de UI hien + de automation phan ung). */
export interface ComposioV114HealthAlert {
  kind: ComposioV114HealthAlertKind;
  /** Muc do: 'warning' = can chu y, 'critical' = can xu ly ngay. */
  severity: 'warning' | 'critical';
  /** Thong diep hien cho user (khong chua secret). */
  message: string;
  /** Thoi diem canh bao duoc sinh (epoch ms). */
  atMs: number;
}

/** Suc khoe cua mot connection Composio. */
export interface ComposioV114ConnectionHealth {
  /** Id connection (khong chua secret). */
  connectionId: string;
  /** Slug toolkit, vd 'gmail'. */
  toolkit: string;
  /** Nhan tai khoan hien thi (vd email/login — do caller cung cap). */
  accountLabel?: string;
  /** Trang thai hien tai (tinh tu so lieu). */
  status: ComposioV114HealthStatus;
  /** Lan sync gan nhat (epoch ms) — null neu chua sync lan nao. */
  lastSyncAtMs: number | null;
  /** Lan sync thanh cong gan nhat (epoch ms). */
  lastSuccessAtMs: number | null;
  /** Tong so lan poll/sync da thu. */
  totalPolls: number;
  /** Tong so lan loi. */
  totalErrors: number;
  /** So loi lien tiep hien tai (reset ve 0 khi sync thanh cong). */
  consecutiveErrors: number;
  /** Ti le loi 0..1 (totalErrors / totalPolls, 0 neu chua poll). */
  errorRate: number;
  /** Latency cac lan sync gan nhat (ms, toi da giu 100 mau). */
  recentLatenciesMs: number[];
  /** Latency trung binh cac mau gan nhat (ms) — null neu chua co mau. */
  avgLatencyMs: number | null;
  /** Latency p50 (ms) — null neu chua co mau. */
  p50LatencyMs: number | null;
  /** Latency p95 (ms) — null neu chua co mau. */
  p95LatencyMs: number | null;
  /** Han het han cua connection (epoch ms) — null neu khong biet. */
  expiresAtMs: number | null;
  /** Canh bao dang hoat dong tren connection nay. */
  alerts: ComposioV114HealthAlert[];
  /** Lan cap nhat so lieu gan nhat (epoch ms). */
  updatedAtMs: number;
}

/** Nguong danh gia suc khoe (co the ghi de qua options). */
export interface ComposioV114HealthThresholds {
  /** Ti le loi >= nguong nay → unhealthy. */
  unhealthyErrorRate: number;
  /** Ti le loi >= nguong nay → degraded. */
  degradedErrorRate: number;
  /** So loi lien tiep >= nguong nay → unhealthy. */
  unhealthyConsecutiveErrors: number;
  /** Khong sync qua bao lau (ms) → stale (degraded). */
  staleAfterMs: number;
  /** p95 latency vuot nguong nay (ms) → canh bao cham. */
  slowP95Ms: number;
  /** Sap het han trong bao lau (ms) → canh bao expiring-soon. */
  expiringSoonMs: number;
}

/** Nguong mac dinh. */
export const DEFAULT_COMPOSIO_V114_HEALTH_THRESHOLDS: ComposioV114HealthThresholds = {
  unhealthyErrorRate: 0.5,
  degradedErrorRate: 0.2,
  unhealthyConsecutiveErrors: 5,
  staleAfterMs: 24 * 60 * 60 * 1000,
  slowP95Ms: 5000,
  expiringSoonMs: 7 * 24 * 60 * 60 * 1000,
};

/** Giu toi da 100 mau latency moi connection. */
export const COMPOSIO_V114_MAX_LATENCY_SAMPLES = 100;
/** Can toi thieu 10 lan poll moi tinh ti le loi thanh trang thai (tranh ket luan voi khi it mau). */
export const COMPOSIO_V114_MIN_POLLS_FOR_RATE = 10;

/** Kiem tra nguong co hop le khong (throw neu sai). */
export function validateComposioV114HealthThresholds(t: ComposioV114HealthThresholds): void {
  if (t.unhealthyErrorRate <= 0 || t.unhealthyErrorRate > 1) {
    throw new Error('thresholds.unhealthyErrorRate must be within (0, 1]');
  }
  if (t.degradedErrorRate <= 0 || t.degradedErrorRate >= t.unhealthyErrorRate) {
    throw new Error('thresholds.degradedErrorRate must be within (0, unhealthyErrorRate)');
  }
  if (!Number.isInteger(t.unhealthyConsecutiveErrors) || t.unhealthyConsecutiveErrors < 1) {
    throw new Error('thresholds.unhealthyConsecutiveErrors must be an integer >= 1');
  }
  if (t.staleAfterMs <= 0) throw new Error('thresholds.staleAfterMs must be positive');
  if (t.slowP95Ms <= 0) throw new Error('thresholds.slowP95Ms must be positive');
  if (t.expiringSoonMs < 0) throw new Error('thresholds.expiringSoonMs must be >= 0');
}

/** Tao ban ghi suc khoe moi cho mot connection (chua co so lieu). */
export function emptyComposioV114ConnectionHealth(
  connectionId: string,
  toolkit: string,
  nowMs: number,
  accountLabel?: string,
): ComposioV114ConnectionHealth {
  if (typeof connectionId !== 'string' || connectionId.trim() === '') {
    throw new Error('connectionId must be a non-empty string');
  }
  if (typeof toolkit !== 'string' || toolkit.trim() === '') {
    throw new Error('toolkit must be a non-empty string');
  }
  return {
    connectionId,
    toolkit,
    ...(accountLabel ? { accountLabel } : {}),
    status: 'unknown',
    lastSyncAtMs: null,
    lastSuccessAtMs: null,
    totalPolls: 0,
    totalErrors: 0,
    consecutiveErrors: 0,
    errorRate: 0,
    recentLatenciesMs: [],
    avgLatencyMs: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    expiresAtMs: null,
    alerts: [],
    updatedAtMs: nowMs,
  };
}

/** Tinh percentile (p50/p95) cua mot mang so — tra null neu rong. */
export function percentileComposioV114Latency(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  if (p < 0 || p > 100) throw new Error('percentile p must be within [0, 100]');
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Tinh trung binh — tra null neu rong. */
export function averageComposioV114Latency(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}

/**
 * Sinh canh bao + trang thai tu so lieu cua mot connection tai `nowMs`.
 * Thu tu uu tien: expired > unhealthy (loi) > degraded (loi/stale) >
 * healthy. Canh bao 'slow-response' / 'expiring-soon' / 'never-synced'
 * chi bo sung, khong doi trang thai (tru expired).
 */
export function evaluateComposioV114Health(
  health: ComposioV114ConnectionHealth,
  nowMs: number,
  thresholds: ComposioV114HealthThresholds = DEFAULT_COMPOSIO_V114_HEALTH_THRESHOLDS,
): { status: ComposioV114HealthStatus; alerts: ComposioV114HealthAlert[] } {
  validateComposioV114HealthThresholds(thresholds);
  const alerts: ComposioV114HealthAlert[] = [];
  const add = (kind: ComposioV114HealthAlertKind, severity: 'warning' | 'critical', message: string): void => {
    alerts.push({ kind, severity, message, atMs: nowMs });
  };

  // Het han luon thang — connection het han khong sync duoc nua.
  if (health.expiresAtMs !== null && nowMs >= health.expiresAtMs) {
    add('expired', 'critical', `Connection ${health.toolkit} da het han — can ket noi lai.`);
    return { status: 'expired', alerts };
  }

  let status: ComposioV114HealthStatus = 'healthy';
  const hasRateSignal = health.totalPolls >= COMPOSIO_V114_MIN_POLLS_FOR_RATE;

  if (health.totalPolls === 0) {
    add('never-synced', 'warning', `Connection ${health.toolkit} chua sync lan nao.`);
    return { status: 'unknown', alerts };
  }

  if (hasRateSignal && health.errorRate >= thresholds.unhealthyErrorRate) {
    status = 'unhealthy';
    add(
      'high-error-rate',
      'critical',
      `Connection ${health.toolkit} loi ${Math.round(health.errorRate * 100)}% trong ${health.totalPolls} lan sync gan nhat.`,
    );
  } else if (hasRateSignal && health.errorRate >= thresholds.degradedErrorRate) {
    status = 'degraded';
    add(
      'high-error-rate',
      'warning',
      `Connection ${health.toolkit} loi ${Math.round(health.errorRate * 100)}% trong ${health.totalPolls} lan sync gan nhat.`,
    );
  }

  if (health.consecutiveErrors >= thresholds.unhealthyConsecutiveErrors) {
    status = 'unhealthy';
    add(
      'consecutive-errors',
      'critical',
      `Connection ${health.toolkit} loi lien tiep ${health.consecutiveErrors} lan.`,
    );
  }

  if (health.lastSyncAtMs !== null && nowMs - health.lastSyncAtMs > thresholds.staleAfterMs) {
    if (status === 'healthy') status = 'degraded';
    const hours = Math.round((nowMs - health.lastSyncAtMs) / 3_600_000);
    add('stale-sync', 'warning', `Connection ${health.toolkit} khong sync ${hours} gio roi.`);
  }

  if (health.p95LatencyMs !== null && health.p95LatencyMs > thresholds.slowP95Ms) {
    add(
      'slow-response',
      'warning',
      `Connection ${health.toolkit} phan hoi cham (p95 ${health.p95LatencyMs} ms).`,
    );
  }

  if (
    health.expiresAtMs !== null &&
    health.expiresAtMs - nowMs <= thresholds.expiringSoonMs &&
    health.expiresAtMs > nowMs
  ) {
    const days = Math.max(1, Math.round((health.expiresAtMs - nowMs) / 86_400_000));
    add('expiring-soon', 'warning', `Connection ${health.toolkit} se het han trong ${days} ngay — can gia han.`);
  }

  return { status, alerts };
}

/** Cap nhat so lieu latency (avg/p50/p95) sau khi them mau moi. */
function refreshLatencyStats(
  health: ComposioV114ConnectionHealth,
): Pick<ComposioV114ConnectionHealth, 'avgLatencyMs' | 'p50LatencyMs' | 'p95LatencyMs'> {
  return {
    avgLatencyMs: averageComposioV114Latency(health.recentLatenciesMs),
    p50LatencyMs: percentileComposioV114Latency(health.recentLatenciesMs, 50),
    p95LatencyMs: percentileComposioV114Latency(health.recentLatenciesMs, 95),
  };
}

/** Ghi mot lan sync THANH CONG (kem latency neu do duoc). */
export function recordComposioV114SyncSuccess(
  health: ComposioV114ConnectionHealth,
  nowMs: number,
  latencyMs?: number,
  thresholds: ComposioV114HealthThresholds = DEFAULT_COMPOSIO_V114_HEALTH_THRESHOLDS,
): ComposioV114ConnectionHealth {
  const next: ComposioV114ConnectionHealth = {
    ...health,
    lastSyncAtMs: nowMs,
    lastSuccessAtMs: nowMs,
    totalPolls: health.totalPolls + 1,
    consecutiveErrors: 0,
    updatedAtMs: nowMs,
    recentLatenciesMs:
      typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0
        ? [...health.recentLatenciesMs, Math.round(latencyMs)].slice(-COMPOSIO_V114_MAX_LATENCY_SAMPLES)
        : [...health.recentLatenciesMs],
  };
  next.errorRate = next.totalPolls > 0 ? next.totalErrors / next.totalPolls : 0;
  Object.assign(next, refreshLatencyStats(next));
  const { status, alerts } = evaluateComposioV114Health(next, nowMs, thresholds);
  next.status = status;
  next.alerts = alerts;
  return next;
}

/** Ghi mot lan sync LOI (kem thong diep loi — khong chua secret). */
export function recordComposioV114SyncError(
  health: ComposioV114ConnectionHealth,
  nowMs: number,
  thresholds: ComposioV114HealthThresholds = DEFAULT_COMPOSIO_V114_HEALTH_THRESHOLDS,
): ComposioV114ConnectionHealth {
  const next: ComposioV114ConnectionHealth = {
    ...health,
    lastSyncAtMs: nowMs,
    totalPolls: health.totalPolls + 1,
    totalErrors: health.totalErrors + 1,
    consecutiveErrors: health.consecutiveErrors + 1,
    updatedAtMs: nowMs,
  };
  next.errorRate = next.totalPolls > 0 ? next.totalErrors / next.totalPolls : 0;
  const { status, alerts } = evaluateComposioV114Health(next, nowMs, thresholds);
  next.status = status;
  next.alerts = alerts;
  return next;
}

/** Dat han het han cho mot connection (vd tu OAuth token expiry). */
export function setComposioV114ConnectionExpiry(
  health: ComposioV114ConnectionHealth,
  expiresAtMs: number | null,
  nowMs: number,
  thresholds: ComposioV114HealthThresholds = DEFAULT_COMPOSIO_V114_HEALTH_THRESHOLDS,
): ComposioV114ConnectionHealth {
  if (expiresAtMs !== null && (!Number.isFinite(expiresAtMs) || expiresAtMs < 0)) {
    throw new Error('expiresAtMs must be null or a non-negative number');
  }
  const next: ComposioV114ConnectionHealth = { ...health, expiresAtMs, updatedAtMs: nowMs };
  const { status, alerts } = evaluateComposioV114Health(next, nowMs, thresholds);
  next.status = status;
  next.alerts = alerts;
  return next;
}

/** Kiem tra mot ban ghi suc khoe co hop le khong (throw neu sai). */
export function validateComposioV114ConnectionHealth(h: ComposioV114ConnectionHealth): void {
  if (typeof h.connectionId !== 'string' || h.connectionId.trim() === '') {
    throw new Error('health.connectionId must be a non-empty string');
  }
  if (typeof h.toolkit !== 'string' || h.toolkit.trim() === '') {
    throw new Error('health.toolkit must be a non-empty string');
  }
  if (!Number.isInteger(h.totalPolls) || h.totalPolls < 0) throw new Error('health.totalPolls must be >= 0');
  if (!Number.isInteger(h.totalErrors) || h.totalErrors < 0 || h.totalErrors > h.totalPolls) {
    throw new Error('health.totalErrors must be within [0, totalPolls]');
  }
  if (!Number.isInteger(h.consecutiveErrors) || h.consecutiveErrors < 0 || h.consecutiveErrors > h.totalPolls) {
    throw new Error('health.consecutiveErrors must be within [0, totalPolls]');
  }
  if (h.errorRate < 0 || h.errorRate > 1) throw new Error('health.errorRate must be within [0, 1]');
  if (h.recentLatenciesMs.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new Error('health.recentLatenciesMs must contain only non-negative numbers');
  }
  if (h.recentLatenciesMs.length > COMPOSIO_V114_MAX_LATENCY_SAMPLES) {
    throw new Error(`health.recentLatenciesMs must hold at most ${COMPOSIO_V114_MAX_LATENCY_SAMPLES} samples`);
  }
  if (h.lastSyncAtMs !== null && (!Number.isFinite(h.lastSyncAtMs) || h.lastSyncAtMs < 0)) {
    throw new Error('health.lastSyncAtMs must be null or a non-negative number');
  }
  if (h.lastSuccessAtMs !== null && (!Number.isFinite(h.lastSuccessAtMs) || h.lastSuccessAtMs < 0)) {
    throw new Error('health.lastSuccessAtMs must be null or a non-negative number');
  }
  if (h.expiresAtMs !== null && (!Number.isFinite(h.expiresAtMs) || h.expiresAtMs < 0)) {
    throw new Error('health.expiresAtMs must be null or a non-negative number');
  }
}

// ---------------------------------------------------------------------------
// Store + dashboard tong hop
// ---------------------------------------------------------------------------

/** Tom tat dashboard suc khoe cua tat ca connection. */
export interface ComposioV114HealthDashboard {
  total: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  expired: number;
  unknown: number;
  /** Connection te nhat (nhieu canh bao critical nhat, roi ti le loi cao nhat). */
  worst: ComposioV114ConnectionHealth[];
  /** Tat ca canh bao critical dang hoat dong (de UI bao dong). */
  criticalAlerts: { connectionId: string; toolkit: string; alert: ComposioV114HealthAlert }[];
  /** Canh bao warning (khong critical). */
  warningAlerts: { connectionId: string; toolkit: string; alert: ComposioV114HealthAlert }[];
  /** Ti le loi trung binh co trong so theo so lan poll. */
  overallErrorRate: number;
}

/** Tinh dashboard tu danh sach suc khoe cac connection. */
export function summarizeComposioV114HealthDashboard(
  all: readonly ComposioV114ConnectionHealth[],
): ComposioV114HealthDashboard {
  const counts = { healthy: 0, degraded: 0, unhealthy: 0, expired: 0, unknown: 0 };
  for (const h of all) counts[h.status] += 1;
  const criticalAlerts: ComposioV114HealthDashboard['criticalAlerts'] = [];
  const warningAlerts: ComposioV114HealthDashboard['warningAlerts'] = [];
  for (const h of all) {
    for (const alert of h.alerts) {
      const entry = { connectionId: h.connectionId, toolkit: h.toolkit, alert };
      if (alert.severity === 'critical') criticalAlerts.push(entry);
      else warningAlerts.push(entry);
    }
  }
  const worst = [...all]
    .filter((h) => h.status === 'unhealthy' || h.status === 'expired' || h.status === 'degraded')
    .sort((a, b) => {
      const ca = a.alerts.filter((x) => x.severity === 'critical').length;
      const cb = b.alerts.filter((x) => x.severity === 'critical').length;
      if (cb !== ca) return cb - ca;
      return b.errorRate - a.errorRate;
    })
    .slice(0, 5);
  const totalPolls = all.reduce((n, h) => n + h.totalPolls, 0);
  const totalErrors = all.reduce((n, h) => n + h.totalErrors, 0);
  return {
    total: all.length,
    ...counts,
    worst,
    criticalAlerts,
    warningAlerts,
    overallErrorRate: totalPolls > 0 ? totalErrors / totalPolls : 0,
  };
}

/**
 * Store suc khoe trong bo nho: giu mot ban ghi moi connection,
 * cap nhat qua record* + serialize toan bo ra JSON de luu dia.
 */
export class ComposioV114HealthStore {
  private readonly records = new Map<string, ComposioV114ConnectionHealth>();
  private readonly thresholds: ComposioV114HealthThresholds;

  constructor(thresholds: ComposioV114HealthThresholds = DEFAULT_COMPOSIO_V114_HEALTH_THRESHOLDS) {
    validateComposioV114HealthThresholds(thresholds);
    this.thresholds = { ...thresholds };
  }

  /** Dang ky mot connection (throw neu trung id). */
  register(connectionId: string, toolkit: string, nowMs: number, accountLabel?: string): ComposioV114ConnectionHealth {
    if (this.records.has(connectionId)) throw new Error(`duplicate health record: ${connectionId}`);
    const rec = emptyComposioV114ConnectionHealth(connectionId, toolkit, nowMs, accountLabel);
    this.records.set(connectionId, rec);
    return { ...rec, alerts: [...rec.alerts], recentLatenciesMs: [...rec.recentLatenciesMs] };
  }

  /** Lay ban sao ban ghi (undefined neu khong co). */
  get(connectionId: string): ComposioV114ConnectionHealth | undefined {
    const rec = this.records.get(connectionId);
    if (!rec) return undefined;
    return { ...rec, alerts: [...rec.alerts], recentLatenciesMs: [...rec.recentLatenciesMs] };
  }

  /** Tat ca ban ghi (ban sao). */
  list(): ComposioV114ConnectionHealth[] {
    return [...this.records.values()].map((rec) => ({
      ...rec,
      alerts: [...rec.alerts],
      recentLatenciesMs: [...rec.recentLatenciesMs],
    }));
  }

  /** Ghi sync thanh cong cho mot connection. */
  recordSuccess(connectionId: string, nowMs: number, latencyMs?: number): ComposioV114ConnectionHealth {
    const rec = this.records.get(connectionId);
    if (!rec) throw new Error(`unknown connection: ${connectionId}`);
    const next = recordComposioV114SyncSuccess(rec, nowMs, latencyMs, this.thresholds);
    this.records.set(connectionId, next);
    return { ...next, alerts: [...next.alerts], recentLatenciesMs: [...next.recentLatenciesMs] };
  }

  /** Ghi sync loi cho mot connection. */
  recordError(connectionId: string, nowMs: number): ComposioV114ConnectionHealth {
    const rec = this.records.get(connectionId);
    if (!rec) throw new Error(`unknown connection: ${connectionId}`);
    const next = recordComposioV114SyncError(rec, nowMs, this.thresholds);
    this.records.set(connectionId, next);
    return { ...next, alerts: [...next.alerts], recentLatenciesMs: [...next.recentLatenciesMs] };
  }

  /** Dat han het han cho mot connection. */
  setExpiry(connectionId: string, expiresAtMs: number | null, nowMs: number): ComposioV114ConnectionHealth {
    const rec = this.records.get(connectionId);
    if (!rec) throw new Error(`unknown connection: ${connectionId}`);
    const next = setComposioV114ConnectionExpiry(rec, expiresAtMs, nowMs, this.thresholds);
    this.records.set(connectionId, next);
    return { ...next, alerts: [...next.alerts], recentLatenciesMs: [...next.recentLatenciesMs] };
  }

  /** Dashboard tong hop hien tai. */
  dashboard(): ComposioV114HealthDashboard {
    return summarizeComposioV114HealthDashboard(this.list());
  }

  /** Serialize toan bo store ra JSON (de luu xuong dia). */
  serialize(): string {
    return JSON.stringify(this.list());
  }

  /** Khoi phuc store tu JSON (throw neu sai dinh dang). */
  static deserialize(json: string): ComposioV114HealthStore {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('health store JSON is not valid JSON');
    }
    if (!Array.isArray(parsed)) throw new Error('health store JSON must be an array');
    const store = new ComposioV114HealthStore();
    for (const entry of parsed as ComposioV114ConnectionHealth[]) {
      validateComposioV114ConnectionHealth(entry);
      if (store.records.has(entry.connectionId)) throw new Error(`duplicate health record: ${entry.connectionId}`);
      store.records.set(entry.connectionId, {
        ...entry,
        alerts: [...entry.alerts],
        recentLatenciesMs: [...entry.recentLatenciesMs],
      });
    }
    return store;
  }
}
