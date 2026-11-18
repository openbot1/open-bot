/**
 * Composio polling v7 — adaptive interval + jitter + pause/resume +
 * metrics (v1.20, Doi T4).
 *
 * Tang tren polling v6 (pollingV119.ts) — KHONG viet lai:
 * - `ComposioV119PollEngine` van la engine chay batch (gom page,
 *   dedupe id + cursor, retry co gioi han, tinh lich v118).
 * - `nextComposioV118Poll` van tinh lich co ban sau moi tick; v7
 *   CHI DE LEN tren lich do: lay `nextPollAtMs` v6 tra ve roi ap
 *   adaptive + jitter truoc khi ghi lai — khong sua logic batch.
 *
 * Moi trong v7:
 * 1. Adaptive interval theo tan suat thay doi: moi connection giu
 *    EMA cua ti le hit (hit = tick tra ve >= 1 item moi). EMA cao
 *    (>= 0.6) → thu hep interval ve phia min (co item lien tuc thi
 *    poll nhanh hon); EMA thap (<= 0.2) → gian interval ve phia
 *    max (nguon im lang thi dung dot quota); giua thi giu nguyen.
 *    He so thu/nga co gioi han moi tick (khong nhay vot) va luon
 *    clamp trong [minIntervalMs, maxIntervalMs].
 * 2. Jitter chong thundering herd: moi lich poll ke deu cong mot
 *    luong jitter ngau nhien trong [-fraction, +fraction] cua
 *    interval (mac dinh 10%). Ham jitter nhan `random` do caller
 *    truyen — truyen `() => 0.5` thi xac dinh (jitter = 0) de test.
 *    Tong jitter da ap duoc ghi vao metrics de UI thay do lech.
 * 3. Pause/resume theo trang thai ket noi: connection co trang
 *    thai `online | degraded | offline | unknown`. Offline →
 *    tu dong pause (khong poll, khong dem loi); online tro lai →
 *    tu dong resume (poll ngay o tick ke). Degraded → gian
 *    interval gap doi (poll thua, khong dung han). Pause thu cong
 *    (ly do + het han toi da) van duoc ho tro rieng.
 * 4. Metrics moi connection: so poll / hit / miss / error, ti le
 *    hit EMA, latency trung binh (EMA) + latency lau nhat, tong
 *    item moi, tong jitter da ap, so lan pause, lan poll/hit cuoi
 *    — de UI + usage metering v120 co so lieu that.
 * 5. Engine v7 boc engine v6: `tick` chi goi v6 cho connection
 *    den han VA khong bi pause; sau moi tick, ghi metrics, cap
 *    nhat adaptive state, ap jitter len `nextPollAtMs` roi ghi
 *    lai vao engine v6. Loi cua mot connection khong anh huong
 *    connection khac (ke thua tu v6).
 *
 * Tat ca ham quyet dinh deu thuan (khong doc/ghi file, khong goi
 * mang; `nowMs` do caller truyen). Fetch do engine v6 thuc hien
 * qua `fetchPage` caller cung cap.
 */

import {
  ComposioV119PollEngine,
  createComposioV119ConnState,
  type ComposioV119FetchPageFn,
  type ComposioV119PollEngineOptions,
  type ComposioV119TickResult,
} from './pollingV119';
import type { ComposioV118PollConnState } from './pollingV118';

/** Phien ban dinh dang adaptive state v120. */
export const COMPOSIO_V120_POLL_STATE_VERSION = 1;
/** Interval co so mac dinh (ms) — 5 phut. */
export const COMPOSIO_V120_DEFAULT_BASE_INTERVAL_MS = 5 * 60 * 1000;
/** Interval nho nhat mac dinh (ms) — 30 giay. */
export const COMPOSIO_V120_DEFAULT_MIN_INTERVAL_MS = 30 * 1000;
/** Interval lon nhat mac dinh (ms) — 1 gio. */
export const COMPOSIO_V120_DEFAULT_MAX_INTERVAL_MS = 60 * 60 * 1000;
/** He so EMA cho ti le hit (0..1). */
export const COMPOSIO_V120_DEFAULT_EMA_ALPHA = 0.25;
/** Nguong EMA hit de thu hep interval. */
export const COMPOSIO_V120_HIGH_HIT_RATE = 0.6;
/** Nguong EMA hit de gian interval. */
export const COMPOSIO_V120_LOW_HIT_RATE = 0.2;
/** He so thu interval moi tick co hit lien tuc (nhan). */
export const COMPOSIO_V120_DEFAULT_SHRINK_FACTOR = 0.8;
/** He so gian interval moi tick miss (nhan). */
export const COMPOSIO_V120_DEFAULT_GROW_FACTOR = 1.25;
/** He so gian interval khi tick loi (nhan). */
export const COMPOSIO_V120_DEFAULT_ERROR_GROW_FACTOR = 2;
/** He so gian interval khi degraded (nhan). */
export const COMPOSIO_V120_DEGRADED_GROW_FACTOR = 2;
/** Phan tram jitter mac dinh ap len interval (0..0.5). */
export const COMPOSIO_V120_DEFAULT_JITTER_FRACTION = 0.1;
/** Pause toi da mac dinh (ms) — 24 gio; qua thi tu resume. */
export const COMPOSIO_V120_DEFAULT_MAX_PAUSED_MS = 24 * 60 * 60 * 1000;

/** Trang thai ket noi cua mot connection (do host cap nhat). */
export type ComposioV120ConnectionStatus = 'online' | 'degraded' | 'offline' | 'unknown';

export const COMPOSIO_V120_CONNECTION_STATUSES: readonly ComposioV120ConnectionStatus[] = [
  'online',
  'degraded',
  'offline',
  'unknown',
];

/** Ly do pause. */
export type ComposioV120PauseReason =
  | 'manual'
  | 'offline'
  | 'degraded-backoff'
  | 'quota'
  | 'maintenance';

export const COMPOSIO_V120_PAUSE_REASONS: readonly ComposioV120PauseReason[] = [
  'manual',
  'offline',
  'degraded-backoff',
  'quota',
  'maintenance',
];

/** Ket qua mot tick (hit / miss / error) — de adaptive hoc. */
export type ComposioV120PollOutcome = 'hit' | 'miss' | 'error';

/** Cau hinh adaptive + jitter + pause cua polling v7. */
export interface ComposioV120PollAdaptiveConfig {
  /** Interval khoi diem khi chua co du lieu hit (ms). */
  baseIntervalMs: number;
  /** Interval nho nhat cho phep (ms). */
  minIntervalMs: number;
  /** Interval lon nhat cho phep (ms). */
  maxIntervalMs: number;
  /** He so EMA ti le hit. */
  emaAlpha: number;
  /** Nguong EMA tren: tren nguong thi thu hep. */
  highHitRate: number;
  /** Nguong EMA duoi: duoi nguong thi gian ra. */
  lowHitRate: number;
  /** He so thu interval moi tick hit (0..1). */
  shrinkFactor: number;
  /** He so gian interval moi tick miss (> 1). */
  growFactor: number;
  /** He so gian interval moi tick loi (> 1). */
  errorGrowFactor: number;
  /** Phan tram jitter (0..0.5). */
  jitterFraction: number;
  /** true = offline thi tu dong pause (mac dinh true). */
  pauseOnOffline: boolean;
  /** Pause toi da (ms); qua thi tu dong resume o tick ke. */
  maxPausedMs: number;
}

/** Cau hinh mac dinh polling v7. */
export const DEFAULT_COMPOSIO_V120_POLL_ADAPTIVE_CONFIG: ComposioV120PollAdaptiveConfig = {
  baseIntervalMs: COMPOSIO_V120_DEFAULT_BASE_INTERVAL_MS,
  minIntervalMs: COMPOSIO_V120_DEFAULT_MIN_INTERVAL_MS,
  maxIntervalMs: COMPOSIO_V120_DEFAULT_MAX_INTERVAL_MS,
  emaAlpha: COMPOSIO_V120_DEFAULT_EMA_ALPHA,
  highHitRate: COMPOSIO_V120_HIGH_HIT_RATE,
  lowHitRate: COMPOSIO_V120_LOW_HIT_RATE,
  shrinkFactor: COMPOSIO_V120_DEFAULT_SHRINK_FACTOR,
  growFactor: COMPOSIO_V120_DEFAULT_GROW_FACTOR,
  errorGrowFactor: COMPOSIO_V120_DEFAULT_ERROR_GROW_FACTOR,
  jitterFraction: COMPOSIO_V120_DEFAULT_JITTER_FRACTION,
  pauseOnOffline: true,
  maxPausedMs: COMPOSIO_V120_DEFAULT_MAX_PAUSED_MS,
};

/** Kiem tra + chuan hoa cau hinh adaptive (throw neu sai). */
export function validateComposioV120PollAdaptiveConfig(
  raw: Partial<ComposioV120PollAdaptiveConfig> | undefined,
): ComposioV120PollAdaptiveConfig {
  const cfg: ComposioV120PollAdaptiveConfig = { ...DEFAULT_COMPOSIO_V120_POLL_ADAPTIVE_CONFIG, ...(raw ?? {}) };
  const fail = (msg: string): never => {
    throw new Error(`ComposioV120PollAdaptiveConfig khong hop le: ${msg}`);
  };
  if (!Number.isFinite(cfg.baseIntervalMs) || cfg.baseIntervalMs <= 0) fail('baseIntervalMs phai > 0');
  if (!Number.isFinite(cfg.minIntervalMs) || cfg.minIntervalMs <= 0) fail('minIntervalMs phai > 0');
  if (!Number.isFinite(cfg.maxIntervalMs) || cfg.maxIntervalMs < cfg.minIntervalMs) {
    fail('maxIntervalMs phai >= minIntervalMs');
  }
  if (cfg.baseIntervalMs < cfg.minIntervalMs || cfg.baseIntervalMs > cfg.maxIntervalMs) {
    fail('baseIntervalMs phai nam trong [minIntervalMs, maxIntervalMs]');
  }
  if (!Number.isFinite(cfg.emaAlpha) || cfg.emaAlpha <= 0 || cfg.emaAlpha > 1) fail('emaAlpha phai trong (0, 1]');
  if (!Number.isFinite(cfg.highHitRate) || cfg.highHitRate < 0 || cfg.highHitRate > 1) {
    fail('highHitRate phai trong [0, 1]');
  }
  if (!Number.isFinite(cfg.lowHitRate) || cfg.lowHitRate < 0 || cfg.lowHitRate > 1) {
    fail('lowHitRate phai trong [0, 1]');
  }
  if (cfg.lowHitRate >= cfg.highHitRate) fail('lowHitRate phai < highHitRate');
  if (!Number.isFinite(cfg.shrinkFactor) || cfg.shrinkFactor <= 0 || cfg.shrinkFactor >= 1) {
    fail('shrinkFactor phai trong (0, 1)');
  }
  if (!Number.isFinite(cfg.growFactor) || cfg.growFactor <= 1) fail('growFactor phai > 1');
  if (!Number.isFinite(cfg.errorGrowFactor) || cfg.errorGrowFactor <= 1) fail('errorGrowFactor phai > 1');
  if (!Number.isFinite(cfg.jitterFraction) || cfg.jitterFraction < 0 || cfg.jitterFraction > 0.5) {
    fail('jitterFraction phai trong [0, 0.5]');
  }
  if (!Number.isFinite(cfg.maxPausedMs) || cfg.maxPausedMs <= 0) fail('maxPausedMs phai > 0');
  return cfg;
}

/** Kep interval vao [min, max] cua cau hinh. */
export function clampComposioV120IntervalMs(ms: number, cfg: ComposioV120PollAdaptiveConfig): number {
  if (!Number.isFinite(ms)) return cfg.baseIntervalMs;
  return Math.min(cfg.maxIntervalMs, Math.max(cfg.minIntervalMs, Math.round(ms)));
}

/**
 * Ap jitter len interval: tra ve interval da lech trong
 * [interval * (1 - fraction), interval * (1 + fraction)].
 * `random` tra ve [0, 1); random = 0.5 → jitter = 0 (xac dinh).
 */
export function applyComposioV120Jitter(
  intervalMs: number,
  fraction: number,
  random: () => number = Math.random,
): { jitteredMs: number; jitterMs: number } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { jitteredMs: intervalMs, jitterMs: 0 };
  const f = Math.min(0.5, Math.max(0, fraction));
  if (f === 0) return { jitteredMs: intervalMs, jitterMs: 0 };
  const r = Math.min(1, Math.max(0, random()));
  const jitterMs = Math.round(intervalMs * f * (r * 2 - 1));
  return { jitteredMs: Math.max(1, intervalMs + jitterMs), jitterMs };
}

/** State adaptive cua mot connection (v7 giu them tren state v118/v119). */
export interface ComposioV120AdaptiveState {
  /** Id connection (trung connectionId cua state v118). */
  connectionId: string;
  /** EMA ti le hit: 1 = tick nao cung co item moi, 0 = khong bao gio. */
  emaHitRate: number;
  /** Interval hien tai ma v7 dang dung (ms). */
  currentIntervalMs: number;
  /** So tick hit lien tuc. */
  consecutiveHits: number;
  /** So tick miss lien tuc. */
  consecutiveMisses: number;
  /** So tick loi lien tuc. */
  consecutiveErrors: number;
  /** Outcome cua tick gan nhat (null = chua poll). */
  lastOutcome: ComposioV120PollOutcome | null;
  /** ms epoch lan poll gan nhat (0 = chua poll). */
  lastPollAtMs: number;
  /** ms epoch lan hit gan nhat (0 = chua hit). */
  lastHitAtMs: number;
  /** Trang thai ket noi hien tai. */
  connectivity: ComposioV120ConnectionStatus;
  /** true = dang pause (khong poll). */
  paused: boolean;
  /** Ly do pause (null neu khong pause). */
  pauseReason: ComposioV120PauseReason | null;
  /** ms epoch bat dau pause (0 neu khong pause). */
  pausedAtMs: number;
  /** ms epoch hen resume (0 = khong hen; qua thi tu resume). */
  resumeAtMs: number;
  /** So lan da pause (ke ca tu dong). */
  pauseCount: number;
}

/** Tao state adaptive moi cho mot connection. */
export function createComposioV120AdaptiveState(
  connectionId: string,
  cfg: ComposioV120PollAdaptiveConfig = DEFAULT_COMPOSIO_V120_POLL_ADAPTIVE_CONFIG,
): ComposioV120AdaptiveState {
  if (!connectionId) throw new Error('ComposioV120AdaptiveState: connectionId khong duoc rong');
  return {
    connectionId,
    emaHitRate: 0.5,
    currentIntervalMs: cfg.baseIntervalMs,
    consecutiveHits: 0,
    consecutiveMisses: 0,
    consecutiveErrors: 0,
    lastOutcome: null,
    lastPollAtMs: 0,
    lastHitAtMs: 0,
    connectivity: 'unknown',
    paused: false,
    pauseReason: null,
    pausedAtMs: 0,
    resumeAtMs: 0,
    pauseCount: 0,
  };
}

/** Kiem tra state adaptive co hop le khong (throw neu sai). */
export function validateComposioV120AdaptiveState(s: ComposioV120AdaptiveState): void {
  const fail = (msg: string): never => {
    throw new Error(`ComposioV120AdaptiveState khong hop le: ${msg}`);
  };
  if (!s || typeof s.connectionId !== 'string' || !s.connectionId) fail('connectionId rong');
  if (!Number.isFinite(s.emaHitRate) || s.emaHitRate < 0 || s.emaHitRate > 1) fail('emaHitRate phai trong [0, 1]');
  if (!Number.isFinite(s.currentIntervalMs) || s.currentIntervalMs <= 0) fail('currentIntervalMs phai > 0');
  for (const f of ['consecutiveHits', 'consecutiveMisses', 'consecutiveErrors'] as const) {
    if (!Number.isInteger(s[f]) || s[f] < 0) fail(`${f} phai la so nguyen >= 0`);
  }
  if (s.lastOutcome !== null && s.lastOutcome !== 'hit' && s.lastOutcome !== 'miss' && s.lastOutcome !== 'error') {
    fail('lastOutcome khong hop le');
  }
  if (!COMPOSIO_V120_CONNECTION_STATUSES.includes(s.connectivity)) fail('connectivity khong hop le');
  if (typeof s.paused !== 'boolean') fail('paused phai la boolean');
  if (s.paused && !s.pauseReason) fail('dang pause thi phai co pauseReason');
  if (!s.paused && s.pauseReason !== null) fail('khong pause thi pauseReason phai null');
  if (s.paused && (!Number.isFinite(s.pausedAtMs) || s.pausedAtMs <= 0)) fail('dang pause thi pausedAtMs phai > 0');
  if (s.pauseCount < 0 || !Number.isInteger(s.pauseCount)) fail('pauseCount phai la so nguyen >= 0');
}

/**
 * Tinh interval ke tiep sau mot tick: cap nhat EMA hit rate roi
 * thu/nga interval theo nguong. Tra ve state moi (khong sua state cu).
 * - hit: EMA tang; neu EMA >= highHitRate thi interval *= shrink.
 * - miss: EMA giam; neu EMA <= lowHitRate thi interval *= grow.
 * - error: EMA giam manh (tinh nhu miss), interval *= errorGrow.
 * - degraded: nhan them DEGRADED_GROW_FACTOR (poll thua hon).
 */
export function composioV120NextInterval(
  state: ComposioV120AdaptiveState,
  outcome: ComposioV120PollOutcome,
  cfg: ComposioV120PollAdaptiveConfig,
  nowMs: number,
): ComposioV120AdaptiveState {
  validateComposioV120AdaptiveState(state);
  const hitValue = outcome === 'hit' ? 1 : 0;
  const emaHitRate = cfg.emaAlpha * hitValue + (1 - cfg.emaAlpha) * state.emaHitRate;
  let interval = state.currentIntervalMs;
  if (outcome === 'hit') {
    if (emaHitRate >= cfg.highHitRate) interval *= cfg.shrinkFactor;
  } else if (outcome === 'miss') {
    if (emaHitRate <= cfg.lowHitRate) interval *= cfg.growFactor;
  } else {
    interval *= cfg.errorGrowFactor;
  }
  if (state.connectivity === 'degraded') interval *= COMPOSIO_V120_DEGRADED_GROW_FACTOR;
  return {
    ...state,
    emaHitRate,
    currentIntervalMs: clampComposioV120IntervalMs(interval, cfg),
    consecutiveHits: outcome === 'hit' ? state.consecutiveHits + 1 : 0,
    consecutiveMisses: outcome === 'miss' ? state.consecutiveMisses + 1 : 0,
    consecutiveErrors: outcome === 'error' ? state.consecutiveErrors + 1 : 0,
    lastOutcome: outcome,
    lastPollAtMs: nowMs,
    lastHitAtMs: outcome === 'hit' ? nowMs : state.lastHitAtMs,
  };
}

/**
 * Tinh thoi diem poll ke (co jitter): now + interval da jitter.
 * Tra ve ca `nextPollAtMs` lan `jitterMs` de ghi metrics.
 */
export function composioV120JitteredNextPoll(
  state: ComposioV120AdaptiveState,
  cfg: ComposioV120PollAdaptiveConfig,
  nowMs: number,
  random: () => number = Math.random,
): { nextPollAtMs: number; jitterMs: number; intervalMs: number } {
  const { jitteredMs, jitterMs } = applyComposioV120Jitter(state.currentIntervalMs, cfg.jitterFraction, random);
  return { nextPollAtMs: nowMs + jitteredMs, jitterMs, intervalMs: jitteredMs };
}

/** Pause mot connection (thu cong hoac tu dong). */
export function pauseComposioV120Connection(
  state: ComposioV120AdaptiveState,
  reason: ComposioV120PauseReason,
  nowMs: number,
  resumeAtMs = 0,
): ComposioV120AdaptiveState {
  validateComposioV120AdaptiveState(state);
  if (state.paused) return { ...state, pauseReason: reason, resumeAtMs };
  return {
    ...state,
    paused: true,
    pauseReason: reason,
    pausedAtMs: nowMs,
    resumeAtMs,
    pauseCount: state.pauseCount + 1,
  };
}

/** Resume mot connection da pause. */
export function resumeComposioV120Connection(
  state: ComposioV120AdaptiveState,
  nowMs: number,
): ComposioV120AdaptiveState {
  validateComposioV120AdaptiveState(state);
  if (!state.paused) return state;
  return { ...state, paused: false, pauseReason: null, pausedAtMs: 0, resumeAtMs: 0, lastPollAtMs: state.lastPollAtMs };
}

/**
 * true khi connection duoc phep poll tai `nowMs`: khong pause, hoac
 * pause da het han (resumeAtMs qua hoac qua maxPausedMs) thi coi nhu
 * het pause — caller goi `resumeComposioV120Connection` sau do.
 */
export function composioV120CanPoll(
  state: ComposioV120AdaptiveState,
  cfg: ComposioV120PollAdaptiveConfig,
  nowMs: number,
): boolean {
  if (!state.paused) return true;
  if (state.resumeAtMs > 0 && nowMs >= state.resumeAtMs) return true;
  if (nowMs - state.pausedAtMs >= cfg.maxPausedMs) return true;
  return false;
}

/**
 * Cap nhat trang thai ket noi; tu dong pause khi offline (neu
 * `pauseOnOffline`), tu dong resume khi online tro lai. Degraded
 * khong pause ma chi lam interval gian ra o tick ke (xem
 * `composioV120NextInterval`). Tra ve state moi + co doi pause khong.
 */
export function setComposioV120Connectivity(
  state: ComposioV120AdaptiveState,
  status: ComposioV120ConnectionStatus,
  cfg: ComposioV120PollAdaptiveConfig,
  nowMs: number,
): { state: ComposioV120AdaptiveState; pauseChanged: boolean } {
  validateComposioV120AdaptiveState(state);
  if (!COMPOSIO_V120_CONNECTION_STATUSES.includes(status)) {
    throw new Error(`ComposioV120: connectivity khong hop le: ${String(status)}`);
  }
  let next: ComposioV120AdaptiveState = { ...state, connectivity: status };
  let pauseChanged = false;
  if (status === 'offline' && cfg.pauseOnOffline && !state.paused) {
    next = pauseComposioV120Connection(next, 'offline', nowMs);
    pauseChanged = true;
  } else if (status === 'online' && state.paused && state.pauseReason === 'offline') {
    next = resumeComposioV120Connection(next, nowMs);
    pauseChanged = true;
  }
  return { state: next, pauseChanged };
}

/** Metrics tich luy cua mot connection. */
export interface ComposioV120PollMetrics {
  /** Id connection. */
  connectionId: string;
  /** Tong so tick da chay. */
  polls: number;
  /** So tick hit (>= 1 item moi). */
  hits: number;
  /** So tick miss (0 item moi). */
  misses: number;
  /** So tick loi. */
  errors: number;
  /** Tong so item moi thu duoc. */
  totalNewItems: number;
  /** Latency trung binh (EMA, ms) — 0 khi chua co tick. */
  avgLatencyMs: number;
  /** Latency lau nhat (ms). */
  maxLatencyMs: number;
  /** Tong jitter (tri tuyet doi, ms) da ap len lich poll. */
  totalJitterMs: number;
  /** So lan pause (ke ca tu dong). */
  pauses: number;
  /** ms epoch lan poll gan nhat (0 = chua poll). */
  lastPollAtMs: number;
  /** ms epoch lan hit gan nhat (0 = chua hit). */
  lastHitAtMs: number;
}

/** Tao metrics rong cho mot connection. */
export function createComposioV120PollMetrics(connectionId: string): ComposioV120PollMetrics {
  if (!connectionId) throw new Error('ComposioV120PollMetrics: connectionId khong duoc rong');
  return {
    connectionId,
    polls: 0,
    hits: 0,
    misses: 0,
    errors: 0,
    totalNewItems: 0,
    avgLatencyMs: 0,
    maxLatencyMs: 0,
    totalJitterMs: 0,
    pauses: 0,
    lastPollAtMs: 0,
    lastHitAtMs: 0,
  };
}

/**
 * Ghi mot tick vao metrics: tang dem theo outcome, cap nhat EMA
 * latency (alpha 0.25) + max latency, cong jitter tuyet doi.
 */
export function recordComposioV120PollTick(
  metrics: ComposioV120PollMetrics,
  outcome: ComposioV120PollOutcome,
  opts: { latencyMs: number; newItems: number; jitterMs: number; nowMs: number; paused?: boolean },
): ComposioV120PollMetrics {
  const latencyMs = Math.max(0, opts.latencyMs);
  return {
    ...metrics,
    polls: metrics.polls + 1,
    hits: metrics.hits + (outcome === 'hit' ? 1 : 0),
    misses: metrics.misses + (outcome === 'miss' ? 1 : 0),
    errors: metrics.errors + (outcome === 'error' ? 1 : 0),
    totalNewItems: metrics.totalNewItems + Math.max(0, opts.newItems),
    avgLatencyMs:
      metrics.polls === 0 ? latencyMs : Math.round(0.25 * latencyMs + 0.75 * metrics.avgLatencyMs),
    maxLatencyMs: Math.max(metrics.maxLatencyMs, latencyMs),
    totalJitterMs: metrics.totalJitterMs + Math.abs(opts.jitterMs),
    pauses: metrics.pauses + (opts.paused ? 1 : 0),
    lastPollAtMs: opts.nowMs,
    lastHitAtMs: outcome === 'hit' ? opts.nowMs : metrics.lastHitAtMs,
  };
}

/** Ti le hit cua metrics (0..1; 0 khi chua poll). */
export function composioV120HitRate(metrics: ComposioV120PollMetrics): number {
  if (metrics.polls === 0) return 0;
  return metrics.hits / metrics.polls;
}

/** Ti le loi cua metrics (0..1; 0 khi chua poll). */
export function composioV120ErrorRate(metrics: ComposioV120PollMetrics): number {
  if (metrics.polls === 0) return 0;
  return metrics.errors / metrics.polls;
}

/** Tom tat mot dong cho UI/log. */
export function summarizeComposioV120PollMetrics(
  metrics: ComposioV120PollMetrics,
  adaptive: ComposioV120AdaptiveState,
): string {
  const hitPct = Math.round(composioV120HitRate(metrics) * 100);
  const errPct = Math.round(composioV120ErrorRate(metrics) * 100);
  return (
    `${metrics.connectionId}: ${metrics.polls} poll, ${metrics.hits} hit (${hitPct}%), ` +
    `${metrics.errors} loi (${errPct}%), ${metrics.totalNewItems} item moi, ` +
    `latency TB ${metrics.avgLatencyMs}ms (max ${metrics.maxLatencyMs}ms), ` +
    `interval hien tai ${adaptive.currentIntervalMs}ms, EMA hit ${adaptive.emaHitRate.toFixed(2)}, ` +
    `${adaptive.paused ? `PAUSE (${adaptive.pauseReason})` : adaptive.connectivity}`
  );
}

/** Tuy chon engine v7. */
export interface ComposioV120PollEngineOptions {
  /** Cau hinh adaptive (mot phan hoac day du). */
  adaptiveConfig?: Partial<ComposioV120PollAdaptiveConfig>;
  /** Tuy chon engine v6 ben duoi. */
  v6Options?: ComposioV119PollEngineOptions;
  /** Ham random cho jitter (mac dinh Math.random). */
  random?: () => number;
}

/** Ket qua tick cua engine v7 (them adaptive + metrics). */
export interface ComposioV120TickResult extends ComposioV119TickResult {
  /** Interval adaptive moi sau tick (ms). */
  adaptiveIntervalMs: number;
  /** EMA hit rate sau tick. */
  emaHitRate: number;
  /** Jitter (ms, co dau) da ap len lich poll ke. */
  jitterMs: number;
  /** Latency cua tick nay (ms, do engine do). */
  latencyMs: number;
}

/**
 * Engine polling v7: boc `ComposioV119PollEngine`, them adaptive
 * interval + jitter + pause/resume theo ket noi + metrics.
 */
export class ComposioV120PollEngine {
  private readonly v6: ComposioV119PollEngine;
  private readonly cfg: ComposioV120PollAdaptiveConfig;
  private readonly adaptive = new Map<string, ComposioV120AdaptiveState>();
  private readonly metrics = new Map<string, ComposioV120PollMetrics>();
  private readonly random: () => number;

  constructor(options: ComposioV120PollEngineOptions = {}) {
    this.cfg = validateComposioV120PollAdaptiveConfig(options.adaptiveConfig);
    this.v6 = new ComposioV119PollEngine(options.v6Options ?? {});
    this.random = options.random ?? Math.random;
  }

  /** Cau hinh adaptive dang dung (ban sao). */
  getConfig(): ComposioV120PollAdaptiveConfig {
    return { ...this.cfg };
  }

  /** Them connection (state v118 + state adaptive + metrics moi). */
  addConnection(state: ComposioV118PollConnState): void {
    this.v6.addConnection(state);
    if (!this.adaptive.has(state.connectionId)) {
      this.adaptive.set(state.connectionId, createComposioV120AdaptiveState(state.connectionId, this.cfg));
    }
    if (!this.metrics.has(state.connectionId)) {
      this.metrics.set(state.connectionId, createComposioV120PollMetrics(state.connectionId));
    }
  }

  /** Xoa connection (ca 3 lop state). */
  removeConnection(connectionId: string): boolean {
    this.adaptive.delete(connectionId);
    this.metrics.delete(connectionId);
    return this.v6.removeConnection(connectionId);
  }

  /** State adaptive (ban sao, undefined neu khong co). */
  getAdaptiveState(connectionId: string): ComposioV120AdaptiveState | undefined {
    const s = this.adaptive.get(connectionId);
    return s ? { ...s } : undefined;
  }

  /** Metrics (ban sao, undefined neu khong co). */
  getMetrics(connectionId: string): ComposioV120PollMetrics | undefined {
    const m = this.metrics.get(connectionId);
    return m ? { ...m } : undefined;
  }

  /** Tat ca metrics (ban sao). */
  listMetrics(): ComposioV120PollMetrics[] {
    return [...this.metrics.values()].map((m) => ({ ...m }));
  }

  /** State v118 ben duoi (ban sao). */
  getConnection(connectionId: string): ComposioV118PollConnState | undefined {
    return this.v6.getConnection(connectionId);
  }

  /** Tat ca state v118 ben duoi (ban sao). */
  listConnections(): ComposioV118PollConnState[] {
    return this.v6.listConnections();
  }

  /** Bat/tat mot connection (giu state). */
  setEnabled(connectionId: string, enabled: boolean): ComposioV118PollConnState {
    return this.v6.setEnabled(connectionId, enabled);
  }

  /** Pause thu cong mot connection. */
  pause(connectionId: string, reason: ComposioV120PauseReason, nowMs: number, resumeAtMs = 0): boolean {
    const s = this.adaptive.get(connectionId);
    if (!s) return false;
    this.adaptive.set(connectionId, pauseComposioV120Connection(s, reason, nowMs, resumeAtMs));
    const m = this.metrics.get(connectionId);
    if (m) this.metrics.set(connectionId, { ...m, pauses: m.pauses + 1 });
    return true;
  }

  /** Resume mot connection da pause. */
  resume(connectionId: string, nowMs: number): boolean {
    const s = this.adaptive.get(connectionId);
    if (!s || !s.paused) return false;
    this.adaptive.set(connectionId, resumeComposioV120Connection(s, nowMs));
    return true;
  }

  /** Cap nhat trang thai ket noi (tu dong pause/resume khi offline/online). */
  setConnectivity(
    connectionId: string,
    status: ComposioV120ConnectionStatus,
    nowMs: number,
  ): { state: ComposioV120AdaptiveState; pauseChanged: boolean } | undefined {
    const s = this.adaptive.get(connectionId);
    if (!s) return undefined;
    const out = setComposioV120Connectivity(s, status, this.cfg, nowMs);
    this.adaptive.set(connectionId, out.state);
    if (out.pauseChanged) {
      const m = this.metrics.get(connectionId);
      if (m) this.metrics.set(connectionId, { ...m, pauses: m.pauses + 1 });
    }
    return out;
  }

  /**
   * Chay tat ca connection den han tai `nowMs`:
   * - Bo qua connection dang pause (het han thi tu resume truoc).
   * - Gọi engine v6 cho phan con lai; sau moi tick, cap nhat
   *   adaptive + metrics, ap jitter len `nextPollAtMs` roi ghi
   *   lai vao engine v6 (bang remove + add state da sua).
   */
  async tick(nowMs: number, fetchPage: ComposioV119FetchPageFn): Promise<ComposioV120TickResult[]> {
    // Het han pause → tu resume truoc khi tick.
    for (const [id, s] of this.adaptive) {
      if (s.paused && composioV120CanPoll(s, this.cfg, nowMs)) {
        this.adaptive.set(id, resumeComposioV120Connection(s, nowMs));
      }
    }
    // Tam tat connection dang pause trong engine v6 (giu state ben
    // ngoai roi khoi phuc sau tick) — v6 khong biet pause cua v7.
    const pausedStates: ComposioV118PollConnState[] = [];
    for (const [id, s] of this.adaptive) {
      if (s.paused) {
        const conn = this.v6.getConnection(id);
        if (conn) {
          pausedStates.push(conn);
          this.v6.removeConnection(id);
        }
      }
    }
    const startedAt = Date.now();
    let results: ComposioV119TickResult[];
    try {
      results = await this.v6.tick(nowMs, fetchPage);
    } finally {
      for (const conn of pausedStates) this.v6.addConnection(conn);
    }
    const out: ComposioV120TickResult[] = [];
    for (const r of results) {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const outcome: ComposioV120PollOutcome = !r.ok ? 'error' : r.fresh > 0 ? 'hit' : 'miss';
      const prev = this.adaptive.get(r.connectionId) ?? createComposioV120AdaptiveState(r.connectionId, this.cfg);
      const next = composioV120NextInterval(prev, outcome, this.cfg, nowMs);
      const jittered = composioV120JitteredNextPoll(next, this.cfg, nowMs, this.random);
      this.adaptive.set(r.connectionId, next);
      const m = this.metrics.get(r.connectionId) ?? createComposioV120PollMetrics(r.connectionId);
      this.metrics.set(
        r.connectionId,
        recordComposioV120PollTick(m, outcome, {
          latencyMs,
          newItems: r.fresh,
          jitterMs: jittered.jitterMs,
          nowMs,
        }),
      );
      // Ghi lich poll ke (adaptive + jitter) ve engine v6.
      const conn = this.v6.getConnection(r.connectionId);
      if (conn) {
        this.v6.removeConnection(r.connectionId);
        this.v6.addConnection({ ...conn, nextPollAtMs: jittered.nextPollAtMs });
      }
      out.push({
        ...r,
        adaptiveIntervalMs: next.currentIntervalMs,
        emaHitRate: next.emaHitRate,
        jitterMs: jittered.jitterMs,
        latencyMs,
      });
    }
    return out;
  }

  /** Tom tat nhanh cho UI: dem theo che do + tong metrics v7. */
  summarize(nowMs: number): {
    total: number;
    enabled: number;
    due: number;
    erroring: number;
    bursting: number;
    idle: number;
    totalNewItems: number;
    totalPages: number;
    totalRetries: number;
    totalCursorDuplicates: number;
    nextPollAtMs: number | null;
    paused: number;
    offline: number;
    totalPolls: number;
    totalHits: number;
    totalErrors: number;
    avgLatencyMs: number;
  } {
    const base = this.v6.summarize(nowMs);
    let paused = 0;
    let offline = 0;
    let totalPolls = 0;
    let totalHits = 0;
    let totalErrors = 0;
    let latencySum = 0;
    let latencyN = 0;
    for (const s of this.adaptive.values()) {
      if (s.paused) paused += 1;
      if (s.connectivity === 'offline') offline += 1;
    }
    for (const m of this.metrics.values()) {
      totalPolls += m.polls;
      totalHits += m.hits;
      totalErrors += m.errors;
      if (m.polls > 0) {
        latencySum += m.avgLatencyMs * m.polls;
        latencyN += m.polls;
      }
    }
    return {
      ...base,
      paused,
      offline,
      totalPolls,
      totalHits,
      totalErrors,
      avgLatencyMs: latencyN === 0 ? 0 : Math.round(latencySum / latencyN),
    };
  }
}

/** Tao state v118 nhanh cho test/tool (tai xuat de tool v120 dung). */
export function createComposioV120ConnState(
  connectionId: string,
  toolkit: string,
  triggerSlug: string,
  startAtMs?: number,
): ComposioV118PollConnState {
  return createComposioV119ConnState(connectionId, toolkit, triggerSlug, startAtMs);
}
