/**
 * Composio trigger instances v3 — retry voi backoff + escalation
 * (v1.20, Doi T4).
 *
 * Tang tren triggerInstancesV119.ts — KHONG viet lai:
 * - `ComposioV119TriggerInstance` van la instance goc (metadata
 *   v118 + lifecycle draft/active/paused/stopped/archived + lich
 *   su run). V3 BOC no: moi instance v3 giu mot instance v119 ben
 *   trong (`base`) + them retry state rieng.
 * - `startComposioV119TriggerRun` / `finishComposioV119TriggerRun`
 *   van mo/dong run; v3 goi lai chung roi moi xu ly retry.
 *
 * Moi trong v3:
 * 1. Retry voi backoff: run failed (loi retryable) thi khong bo
 *    ngay — len lich thu lai: delay = baseDelayMs *
 *    multiplier^(attempt-1), cap o maxDelayMs, cong jitter tuy
 *    chon. Het `maxRetries` lan thi dung, danh dau escalated.
 * 2. Phan loai loi: loi tam thoi (timeout, 429, 5xx, network,
 *    'temporarily', 'try again') → retryable; loi vinh vien
 *    (400, 401, 403, 404, 'not found', 'invalid', 'revoked',
 *    'unauthorized') → permanent, khong retry. Khong phan loai
 *    duoc → 'unknown' (mac dinh retryable, nhung chi 1 lan).
 * 3. Escalation: het luot retry ma van loi → instance bi
 *    `escalated` (can chu y), lifecycle tu dong chuyen
 *    active → paused (dung dot quota / spam loi), ghi audit.
 *    Run thanh cong sau do thi tu dong ha escalation + reset
 *    retry (instance ve active neu truoc do bi pause do loi).
 * 4. Retry queue: hang doi cac retry den han, sap theo
 *    `nextRetryAtMs`; `dueRetries(nowMs)` tra ve danh sach den
 *    han de worker chay — khong chay retry som, khong quen retry.
 * 5. Bulk enable/disable: bat/tat nhieu instance mot luc (theo
 *    filter toolkit/connection/lifecycle), tra ket qua tung cai —
 *    de UI "tam dung tat ca trigger cua toolkit X" lam duoc.
 * 6. Store: memory + JSON file atomic (mode 0600) trong
 *    `<userData>/composio/`, cung mau v119 — file rieng
 *    `composio-trigger-retries-v120.json` (khong dung chung file
 *    v119 de khoi xung dot dinh dang khi coordinator gop).
 *
 * NGUYEN TAC (tu v118, van giu): trigger instances KHONG duoc tao
 * boi open-bot — user tao trigger trong Composio, module nay chi
 * QUAN LY PHIA OPEN-BOT. KHONG goi Composio API, KHONG thay key.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MemoryComposioV119TriggerInstanceStore,
  createComposioV119TriggerInstance,
  finishComposioV119TriggerRun,
  isComposioV119TriggerInstanceRunnable,
  startComposioV119TriggerRun,
  transitionComposioV119TriggerLifecycle,
  validateComposioV119TriggerInstance,
  type ComposioV119RegisterTriggerInput,
  type ComposioV119RunStatus,
  type ComposioV119TriggerInstance,
  type ComposioV119TriggerLifecycle,
} from './triggerInstancesV119';

/** File retry state v3 trong thu muc composio cua userData. */
export const COMPOSIO_V120_TRIGGER_RETRIES_FILE = 'composio-trigger-retries-v120.json';
/** File audit log trigger retry v3 (JSONL, append). */
export const COMPOSIO_V120_TRIGGER_RETRY_AUDIT_FILE = 'composio-trigger-retries-audit-v120.jsonl';
/** Phien ban dinh dang file retry v3. */
export const COMPOSIO_V120_TRIGGER_RETRIES_VERSION = 1;
/** Giu toi da tung nay dong audit. */
export const COMPOSIO_V120_MAX_RETRY_AUDIT_LINES = 500;
/** Giu toi da tung nay instance trong store retry. */
export const COMPOSIO_V120_MAX_RETRY_INSTANCES = 500;
/** So lan retry toi da sau mot run failed (mac dinh). */
export const COMPOSIO_V120_DEFAULT_MAX_RETRIES = 3;
/** Delay co so giua cac lan retry (ms). */
export const COMPOSIO_V120_DEFAULT_RETRY_BASE_DELAY_MS = 5000;
/** He so nhan delay moi lan retry (cap o maxDelayMs). */
export const COMPOSIO_V120_DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;
/** Delay retry toi da (ms). */
export const COMPOSIO_V120_DEFAULT_MAX_RETRY_DELAY_MS = 10 * 60 * 1000;
/** Phan tram jitter ap len delay retry (0 = tat, de test xac dinh). */
export const COMPOSIO_V120_DEFAULT_RETRY_JITTER_FRACTION = 0.1;
/** So lan retry toi da cho loi 'unknown' (mac dinh 1). */
export const COMPOSIO_V120_DEFAULT_UNKNOWN_MAX_RETRIES = 1;

/** Phan loai loi cua mot run failed. */
export type ComposioV120ErrorKind = 'retryable' | 'permanent' | 'unknown';

export const COMPOSIO_V120_ERROR_KINDS: readonly ComposioV120ErrorKind[] = [
  'retryable',
  'permanent',
  'unknown',
];

/** Mau nhan dien loi TAM THOI (retry duoc) — khop khong phan biet hoa/thuong. */
export const COMPOSIO_V120_RETRYABLE_ERROR_PATTERNS: readonly string[] = [
  'timeout',
  'timed out',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'network',
  '429',
  'rate limit',
  'too many requests',
  '500',
  '502',
  '503',
  '504',
  'bad gateway',
  'service unavailable',
  'temporarily',
  'try again',
  'overloaded',
];

/** Mau nhan dien loi VINH VIEN (retry vo ich) — khop khong phan biet hoa/thuong. */
export const COMPOSIO_V120_PERMANENT_ERROR_PATTERNS: readonly string[] = [
  '400',
  '401',
  '403',
  '404',
  'unauthorized',
  'forbidden',
  'not found',
  'invalid',
  'bad request',
  'revoked',
  'expired token',
  'permission denied',
  'not supported',
  'unknown trigger',
  'unknown toolkit',
];

/**
 * Phan loai loi: permanent duoc uu tien truoc retryable (vd '404'
 * trong message 'timeout 404' van la permanent). Khong khop mau
 * nao → 'unknown'.
 */
export function classifyComposioV120Error(error: string | null | undefined): ComposioV120ErrorKind {
  if (!error) return 'unknown';
  const lower = error.toLowerCase();
  if (COMPOSIO_V120_PERMANENT_ERROR_PATTERNS.some((p) => lower.includes(p))) return 'permanent';
  if (COMPOSIO_V120_RETRYABLE_ERROR_PATTERNS.some((p) => lower.includes(p))) return 'retryable';
  return 'unknown';
}

/** Cau hinh retry cua trigger instances v3. */
export interface ComposioV120TriggerRetryConfig {
  /** So lan retry toi da cho loi retryable. */
  maxRetries: number;
  /** So lan retry toi da cho loi unknown. */
  unknownMaxRetries: number;
  /** Delay co so giua cac lan retry (ms). */
  baseDelayMs: number;
  /** He so nhan delay moi lan retry. */
  backoffMultiplier: number;
  /** Delay retry toi da (ms). */
  maxDelayMs: number;
  /** Phan tram jitter ap len delay (0..0.5). */
  jitterFraction: number;
  /** true = het luot retry thi tu pause instance (mac dinh true). */
  escalatePausesInstance: boolean;
}

/** Cau hinh mac dinh retry v3. */
export const DEFAULT_COMPOSIO_V120_TRIGGER_RETRY_CONFIG: ComposioV120TriggerRetryConfig = {
  maxRetries: COMPOSIO_V120_DEFAULT_MAX_RETRIES,
  unknownMaxRetries: COMPOSIO_V120_DEFAULT_UNKNOWN_MAX_RETRIES,
  baseDelayMs: COMPOSIO_V120_DEFAULT_RETRY_BASE_DELAY_MS,
  backoffMultiplier: COMPOSIO_V120_DEFAULT_RETRY_BACKOFF_MULTIPLIER,
  maxDelayMs: COMPOSIO_V120_DEFAULT_MAX_RETRY_DELAY_MS,
  jitterFraction: COMPOSIO_V120_DEFAULT_RETRY_JITTER_FRACTION,
  escalatePausesInstance: true,
};

/** Kiem tra + chuan hoa cau hinh retry (throw neu sai). */
export function validateComposioV120TriggerRetryConfig(
  raw: Partial<ComposioV120TriggerRetryConfig> | undefined,
): ComposioV120TriggerRetryConfig {
  const cfg: ComposioV120TriggerRetryConfig = { ...DEFAULT_COMPOSIO_V120_TRIGGER_RETRY_CONFIG, ...(raw ?? {}) };
  const fail = (msg: string): never => {
    throw new Error(`ComposioV120TriggerRetryConfig khong hop le: ${msg}`);
  };
  if (!Number.isInteger(cfg.maxRetries) || cfg.maxRetries < 0 || cfg.maxRetries > 20) {
    fail('maxRetries phai la so nguyen trong [0, 20]');
  }
  if (!Number.isInteger(cfg.unknownMaxRetries) || cfg.unknownMaxRetries < 0 || cfg.unknownMaxRetries > cfg.maxRetries) {
    fail('unknownMaxRetries phai la so nguyen trong [0, maxRetries]');
  }
  if (!Number.isFinite(cfg.baseDelayMs) || cfg.baseDelayMs <= 0) fail('baseDelayMs phai > 0');
  if (!Number.isFinite(cfg.backoffMultiplier) || cfg.backoffMultiplier < 1) fail('backoffMultiplier phai >= 1');
  if (!Number.isFinite(cfg.maxDelayMs) || cfg.maxDelayMs < cfg.baseDelayMs) fail('maxDelayMs phai >= baseDelayMs');
  if (!Number.isFinite(cfg.jitterFraction) || cfg.jitterFraction < 0 || cfg.jitterFraction > 0.5) {
    fail('jitterFraction phai trong [0, 0.5]');
  }
  if (typeof cfg.escalatePausesInstance !== 'boolean') fail('escalatePausesInstance phai la boolean');
  return cfg;
}

/**
 * Delay truoc lan retry thu `attempt` (1-based): base * mult^(n-1),
 * cap o maxDelay, cong jitter. `random` tra [0,1); 0.5 → jitter 0.
 */
export function composioV120RetryDelayMs(
  attempt: number,
  cfg: ComposioV120TriggerRetryConfig,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`ComposioV120: attempt phai la so nguyen >= 1, nhan ${String(attempt)}`);
  }
  const base = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt - 1));
  const r = Math.min(1, Math.max(0, random()));
  const jitter = Math.round(base * cfg.jitterFraction * (r * 2 - 1));
  return Math.max(1, base + jitter);
}

/** So lan retry toi da cho mot loai loi. */
export function composioV120MaxRetriesForKind(
  kind: ComposioV120ErrorKind,
  cfg: ComposioV120TriggerRetryConfig,
): number {
  if (kind === 'permanent') return 0;
  if (kind === 'unknown') return cfg.unknownMaxRetries;
  return cfg.maxRetries;
}

/** Trang thai mot lan thu lai (retry attempt). */
export interface ComposioV120RetryAttempt {
  /** So thu tu lan retry (1-based). */
  attempt: number;
  /** Id run goc da failed. */
  runId: string;
  /** Id event goc (neu co) — retry chay lai cung event. */
  eventId: string | null;
  /** ms epoch hen chay retry. */
  scheduledAtMs: number;
  /** ms epoch bat dau chay retry (null = chua chay). */
  startedAtMs: number | null;
  /** ms epoch chay retry xong (null = chua xong). */
  finishedAtMs: number | null;
  /** Ket qua lan retry (null = chua xong). */
  status: ComposioV119RunStatus | null;
  /** Loi cua lan retry (null neu thanh cong/chua chay). */
  error: string | null;
  /** Delay (ms) da doi truoc lan retry nay. */
  delayMs: number;
}

/** Trang thai retry cua mot instance. */
export interface ComposioV120RetryState {
  /** Id run failed dang duoc retry (null = khong co retry dang cho). */
  failedRunId: string | null;
  /** Phan loai loi cua run failed hien tai. */
  errorKind: ComposioV120ErrorKind | null;
  /** Loi day du cua run failed hien tai (null neu khong co). */
  lastError: string | null;
  /** Cac lan retry da len lich / da chay cho run hien tai. */
  attempts: ComposioV120RetryAttempt[];
  /** ms epoch lan retry ke den han (0 = khong co retry cho). */
  nextRetryAtMs: number;
  /** Tong so lan retry da chay (tich luy, khong reset). */
  totalRetries: number;
  /** Tong so lan retry thanh cong (tich luy). */
  totalRetrySuccesses: number;
  /** true = het luot retry ma van loi, can chu y. */
  escalated: boolean;
  /** ms epoch lan escalation gan nhat (0 = chua tung escalate). */
  escalatedAtMs: number;
  /** true = instance bi pause DO escalation (de tu resume khi khoi). */
  pausedByEscalation: boolean;
}

/** Mot trigger instance v3: instance v119 + retry state. */
export interface ComposioV120TriggerInstance {
  /** Instance v119 ben trong (metadata + lifecycle + run history). */
  base: ComposioV119TriggerInstance;
  /** Trang thai retry v3. */
  retry: ComposioV120RetryState;
}

/** Tao retry state rong. */
export function createComposioV120RetryState(): ComposioV120RetryState {
  return {
    failedRunId: null,
    errorKind: null,
    lastError: null,
    attempts: [],
    nextRetryAtMs: 0,
    totalRetries: 0,
    totalRetrySuccesses: 0,
    escalated: false,
    escalatedAtMs: 0,
    pausedByEscalation: false,
  };
}

/** Tao instance v3 moi (dang ky nhu v119, lifecycle bat dau o draft). */
export function createComposioV120TriggerInstance(
  input: ComposioV119RegisterTriggerInput,
  nowMs: number = Date.now(),
): ComposioV120TriggerInstance {
  return { base: createComposioV119TriggerInstance(input, nowMs), retry: createComposioV120RetryState() };
}

/** Kiem tra instance v3 co hop le khong (throw neu sai). */
export function validateComposioV120TriggerInstance(inst: ComposioV120TriggerInstance): void {
  if (!inst || typeof inst !== 'object') throw new Error('ComposioV120TriggerInstance khong hop le: khong phai object');
  validateComposioV119TriggerInstance(inst.base);
  const r = inst.retry;
  if (!r || typeof r !== 'object') throw new Error('ComposioV120TriggerInstance khong hop le: thieu retry state');
  if (r.failedRunId !== null && typeof r.failedRunId !== 'string') {
    throw new Error('ComposioV120TriggerInstance khong hop le: failedRunId phai la string hoac null');
  }
  if (r.errorKind !== null && !COMPOSIO_V120_ERROR_KINDS.includes(r.errorKind)) {
    throw new Error('ComposioV120TriggerInstance khong hop le: errorKind khong hop le');
  }
  if (!Array.isArray(r.attempts)) throw new Error('ComposioV120TriggerInstance khong hop le: attempts phai la array');
  if (r.nextRetryAtMs < 0 || !Number.isFinite(r.nextRetryAtMs)) {
    throw new Error('ComposioV120TriggerInstance khong hop le: nextRetryAtMs khong hop le');
  }
  if (r.totalRetries < 0 || r.totalRetrySuccesses < 0 || r.totalRetrySuccesses > r.totalRetries) {
    throw new Error('ComposioV120TriggerInstance khong hop le: dem retry khong hop le');
  }
  if (typeof r.escalated !== 'boolean' || typeof r.pausedByEscalation !== 'boolean') {
    throw new Error('ComposioV120TriggerInstance khong hop le: escalated/pausedByEscalation phai la boolean');
  }
}

/** true khi instance v3 co the chay (lifecycle + status goc cho phep). */
export function isComposioV120TriggerInstanceRunnable(inst: ComposioV120TriggerInstance): boolean {
  return isComposioV119TriggerInstanceRunnable(inst.base);
}

/**
 * Mo mot run moi (nhu v119). Neu instance dang co retry cho thi
 * van mo duoc — run moi la run chinh, retry cu bi huy (event moi
 * quan trong hon event cu loi).
 */
export function startComposioV120TriggerRun(
  prev: ComposioV120TriggerInstance,
  eventId: string | null,
  nowMs: number = Date.now(),
): { instance: ComposioV120TriggerInstance; runId: string } {
  validateComposioV120TriggerInstance(prev);
  const { instance: base, run } = startComposioV119TriggerRun(prev.base, eventId, nowMs);
  const retry: ComposioV120RetryState =
    prev.retry.failedRunId !== null
      ? { ...prev.retry, failedRunId: null, nextRetryAtMs: 0, attempts: [] }
      : prev.retry;
  return { instance: { base, retry }, runId: run.runId };
}

/** Ket qua dong mot run v3 (co the len lich retry hoac escalate). */
export interface ComposioV120FinishRunResult {
  /** Instance sau khi dong run (da cap nhat retry/escalation). */
  instance: ComposioV120TriggerInstance;
  /** 'none' = khong retry (thanh cong / loi permanent / skipped);
   * 'scheduled' = da len lich retry; 'escalated' = het luot, da escalate. */
  retryAction: 'none' | 'scheduled' | 'escalated';
  /** ms epoch retry ke den han (0 neu khong co). */
  nextRetryAtMs: number;
}

/**
 * Dong mot run:
 * - success/skipped → dong nhu v119; neu instance dang escalated
 *   thi HA escalation + reset retry; neu bi pause do escalation
 *   thi ve lai active (khoi benh thi chay tiep).
 * - failed + loi permanent → dong nhu v119, khong retry.
 * - failed + loi retryable/unknown + con luot → dong nhu v119,
 *   len lich retry (attempt tiep theo), `nextRetryAtMs` = now + delay.
 * - failed + het luot → dong nhu v119, escalate: danh dau
 *   escalated, neu cau hinh thi lifecycle active → paused.
 */
export function finishComposioV120TriggerRun(
  prev: ComposioV120TriggerInstance,
  runId: string,
  status: ComposioV119RunStatus,
  opts: { error?: string; nowMs?: number; config?: Partial<ComposioV120TriggerRetryConfig>; random?: () => number } = {},
): ComposioV120FinishRunResult {
  validateComposioV120TriggerInstance(prev);
  const cfg = validateComposioV120TriggerRetryConfig(opts.config);
  const nowMs = opts.nowMs ?? Date.now();
  const run = prev.base.runs.find((r) => r.runId === runId);
  if (!run) throw new Error(`Unknown trigger run id: ${runId}`);
  const base = finishComposioV119TriggerRun(prev.base, runId, status, { error: opts.error, nowMs });

  if (status !== 'failed') {
    // Khoi benh: ha escalation, reset retry dang cho.
    if (!prev.retry.escalated && prev.retry.failedRunId === null) {
      return { instance: { base, retry: prev.retry }, retryAction: 'none', nextRetryAtMs: 0 };
    }
    let nextBase = base;
    let pausedByEscalation = prev.retry.pausedByEscalation;
    if (pausedByEscalation && nextBase.lifecycle === 'paused') {
      nextBase = transitionComposioV119TriggerLifecycle(
        nextBase,
        'active',
        'tu resume sau khi retry/run thanh cong (het escalation)',
        nowMs,
      );
      pausedByEscalation = false;
    }
    return {
      instance: {
        base: nextBase,
        retry: { ...createComposioV120RetryState(), totalRetries: prev.retry.totalRetries, totalRetrySuccesses: prev.retry.totalRetrySuccesses },
      },
      retryAction: 'none',
      nextRetryAtMs: 0,
    };
  }

  const error = opts.error ?? run.error ?? null;
  const kind = classifyComposioV120Error(error);
  const maxRetries = composioV120MaxRetriesForKind(kind, cfg);
  const usedAttempts = prev.retry.failedRunId === runId ? prev.retry.attempts.length : 0;
  if (maxRetries === 0 || usedAttempts >= maxRetries) {
    // Het luot (hoac loi permanent): escalate.
    let nextBase = base;
    let pausedByEscalation = prev.retry.pausedByEscalation;
    if (cfg.escalatePausesInstance && nextBase.lifecycle === 'active') {
      nextBase = transitionComposioV119TriggerLifecycle(
        nextBase,
        'paused',
        `het ${Math.max(usedAttempts, maxRetries)} luot retry (loi: ${error ?? 'khong ro'}) — tam dung de khoi dot quota`,
        nowMs,
      );
      pausedByEscalation = true;
    }
    return {
      instance: {
        base: nextBase,
        retry: {
          ...prev.retry,
          failedRunId: runId,
          errorKind: kind,
          lastError: error,
          nextRetryAtMs: 0,
          escalated: true,
          escalatedAtMs: nowMs,
          pausedByEscalation,
        },
      },
      retryAction: 'escalated',
      nextRetryAtMs: 0,
    };
  }

  // Con luot: len lich retry ke.
  const attemptNo = usedAttempts + 1;
  const delayMs = composioV120RetryDelayMs(attemptNo, cfg, opts.random ?? (() => 0.5));
  const attempt: ComposioV120RetryAttempt = {
    attempt: attemptNo,
    runId,
    eventId: run.eventId,
    scheduledAtMs: nowMs + delayMs,
    startedAtMs: null,
    finishedAtMs: null,
    status: null,
    error: null,
    delayMs,
  };
  const attempts =
    prev.retry.failedRunId === runId ? [...prev.retry.attempts, attempt] : [attempt];
  return {
    instance: {
      base,
      retry: {
        ...prev.retry,
        failedRunId: runId,
        errorKind: kind,
        lastError: error,
        attempts,
        nextRetryAtMs: attempt.scheduledAtMs,
        escalated: false,
        pausedByEscalation: prev.retry.pausedByEscalation,
      },
    },
    retryAction: 'scheduled',
    nextRetryAtMs: attempt.scheduledAtMs,
  };
}

/** true khi instance co retry den han tai `nowMs`. */
export function isComposioV120RetryDue(inst: ComposioV120TriggerInstance, nowMs: number): boolean {
  return (
    inst.retry.nextRetryAtMs > 0 &&
    nowMs >= inst.retry.nextRetryAtMs &&
    inst.retry.attempts.some((a) => a.status === null)
  );
}

/**
 * Bat dau chay mot lan retry den han: danh dau attempt dang chay.
 * Tra ve instance moi + attempt (null neu khong co retry den han).
 * Caller chay cong viec that roi goi `finishComposioV120Retry`.
 */
export function startComposioV120Retry(
  prev: ComposioV120TriggerInstance,
  nowMs: number = Date.now(),
): { instance: ComposioV120TriggerInstance; attempt: ComposioV120RetryAttempt } | null {
  validateComposioV120TriggerInstance(prev);
  if (!isComposioV120RetryDue(prev, nowMs)) return null;
  const idx = prev.retry.attempts.findIndex((a) => a.status === null);
  if (idx < 0) return null;
  const attempt: ComposioV120RetryAttempt = { ...prev.retry.attempts[idx], startedAtMs: nowMs };
  const attempts = [...prev.retry.attempts];
  attempts[idx] = attempt;
  return {
    instance: { base: prev.base, retry: { ...prev.retry, attempts, totalRetries: prev.retry.totalRetries + 1 } },
    attempt,
  };
}

/**
 * Dong mot lan retry: thanh cong → mo run thanh cong vao lich su
 * (run retry), ha escalation, reset retry; that bai → dong attempt,
 * neu con luot thi len lich tiep, het luot thi escalate.
 */
export function finishComposioV120Retry(
  prev: ComposioV120TriggerInstance,
  attemptNo: number,
  status: ComposioV119RunStatus,
  opts: { error?: string; nowMs?: number; config?: Partial<ComposioV120TriggerRetryConfig>; random?: () => number } = {},
): ComposioV120FinishRunResult {
  validateComposioV120TriggerInstance(prev);
  const cfg = validateComposioV120TriggerRetryConfig(opts.config);
  const nowMs = opts.nowMs ?? Date.now();
  const idx = prev.retry.attempts.findIndex((a) => a.attempt === attemptNo && a.status === null);
  if (idx < 0) throw new Error(`ComposioV120: khong co retry dang chay so ${attemptNo}`);
  const attempt = prev.retry.attempts[idx];
  const doneAttempt: ComposioV120RetryAttempt = {
    ...attempt,
    finishedAtMs: nowMs,
    status,
    error: status === 'failed' ? (opts.error ?? null) : null,
  };
  const attempts = [...prev.retry.attempts];
  attempts[idx] = doneAttempt;

  if (status === 'success' || status === 'skipped') {
    // Ghi run thanh cong vao lich su v119 (mo + dong ngay) neu instance chay duoc.
    let base = prev.base;
    if (isComposioV119TriggerInstanceRunnable(base)) {
      const opened = startComposioV119TriggerRun(base, attempt.eventId, attempt.startedAtMs ?? nowMs);
      base = finishComposioV119TriggerRun(opened.instance, opened.run.runId, status, { nowMs });
    }
    let pausedByEscalation = prev.retry.pausedByEscalation;
    if (pausedByEscalation && base.lifecycle === 'paused') {
      base = transitionComposioV119TriggerLifecycle(
        base,
        'active',
        'tu resume sau khi retry thanh cong (het escalation)',
        nowMs,
      );
      pausedByEscalation = false;
    }
    return {
      instance: {
        base,
        retry: {
          ...createComposioV120RetryState(),
          totalRetries: prev.retry.totalRetries,
          totalRetrySuccesses: prev.retry.totalRetrySuccesses + 1,
        },
      },
      retryAction: 'none',
      nextRetryAtMs: 0,
    };
  }

  // Retry van loi: mo run failed vao lich su (neu chay duoc) roi len lich tiep / escalate.
  let base = prev.base;
  const error = opts.error ?? null;
  if (isComposioV119TriggerInstanceRunnable(base)) {
    const opened = startComposioV119TriggerRun(base, attempt.eventId, attempt.startedAtMs ?? nowMs);
    base = finishComposioV119TriggerRun(opened.instance, opened.run.runId, 'failed', { error: error ?? undefined, nowMs });
  }
  const kind = classifyComposioV120Error(error);
  const maxRetries = composioV120MaxRetriesForKind(kind, cfg);
  const used = attempts.length;
  if (maxRetries === 0 || used >= maxRetries) {
    let nextBase = base;
    let pausedByEscalation = prev.retry.pausedByEscalation;
    if (cfg.escalatePausesInstance && nextBase.lifecycle === 'active') {
      nextBase = transitionComposioV119TriggerLifecycle(
        nextBase,
        'paused',
        `het ${Math.max(used, maxRetries)} luot retry (loi: ${error ?? 'khong ro'}) — tam dung de khoi dot quota`,
        nowMs,
      );
      pausedByEscalation = true;
    }
    return {
      instance: {
        base: nextBase,
        retry: {
          ...prev.retry,
          attempts,
          nextRetryAtMs: 0,
          lastError: error,
          errorKind: kind,
          escalated: true,
          escalatedAtMs: nowMs,
          pausedByEscalation,
        },
      },
      retryAction: 'escalated',
      nextRetryAtMs: 0,
    };
  }
  const attemptNoNext = used + 1;
  const delayMs = composioV120RetryDelayMs(attemptNoNext, cfg, opts.random ?? (() => 0.5));
  const nextAttempt: ComposioV120RetryAttempt = {
    attempt: attemptNoNext,
    runId: prev.retry.failedRunId ?? attempt.runId,
    eventId: attempt.eventId,
    scheduledAtMs: nowMs + delayMs,
    startedAtMs: null,
    finishedAtMs: null,
    status: null,
    error: null,
    delayMs,
  };
  return {
    instance: {
      base,
      retry: {
        ...prev.retry,
        attempts: [...attempts, nextAttempt],
        nextRetryAtMs: nextAttempt.scheduledAtMs,
        lastError: error,
        errorKind: kind,
      },
    },
    retryAction: 'scheduled',
    nextRetryAtMs: nextAttempt.scheduledAtMs,
  };
}

/** Bo retry dang cho (user huy thu cong) — giu lai lich su attempt. */
export function cancelComposioV120Retry(
  prev: ComposioV120TriggerInstance,
  reason: string,
  nowMs: number = Date.now(),
): ComposioV120TriggerInstance {
  validateComposioV120TriggerInstance(prev);
  if (!reason) throw new Error('ComposioV120: cancel retry can ly do');
  void nowMs;
  return {
    base: prev.base,
    retry: { ...prev.retry, failedRunId: null, nextRetryAtMs: 0, attempts: prev.retry.attempts.filter((a) => a.status !== null) },
  };
}

/** Tom tat retry cua mot instance (mot dong). */
export function summarizeComposioV120Retry(inst: ComposioV120TriggerInstance): string {
  const r = inst.retry;
  const pending = r.attempts.filter((a) => a.status === null).length;
  return (
    `${inst.base.base.triggerId}: lifecycle ${inst.base.lifecycle}, ` +
    `retry ${r.totalRetries} lan (${r.totalRetrySuccesses} thanh cong), ` +
    `${pending > 0 ? `${pending} retry dang cho (ke luc ${r.nextRetryAtMs})` : 'khong co retry cho'}, ` +
    `${r.escalated ? `ESCALATED tu ${r.escalatedAtMs} (loi: ${r.lastError ?? 'khong ro'})` : 'khong escalate'}`
  );
}

/** Tom tat retry toan cuc (nhieu instance). */
export function summarizeComposioV120Retries(instances: ComposioV120TriggerInstance[], nowMs: number): string {
  const due = instances.filter((i) => isComposioV120RetryDue(i, nowMs)).length;
  const escalated = instances.filter((i) => i.retry.escalated).length;
  const pending = instances.filter((i) => i.retry.nextRetryAtMs > 0).length;
  const totalRetries = instances.reduce((n, i) => n + i.retry.totalRetries, 0);
  return (
    `${instances.length} instance, ${pending} co retry cho (${due} den han), ` +
    `${escalated} escalated, tong ${totalRetries} lan retry`
  );
}

/** Bo loc instance v3 (tai su dung bo loc v119 + them retry). */
export interface ComposioV120TriggerInstanceFilter {
  /** Loc theo toolkit (vd 'gmail'). */
  toolkit?: string;
  /** Loc theo connection id. */
  connectionId?: string;
  /** Loc theo lifecycle. */
  lifecycle?: ComposioV119TriggerLifecycle;
  /** true = chi lay instance dang escalated. */
  escalatedOnly?: boolean;
  /** true = chi lay instance co retry den han tai `nowMs`. */
  retryDueOnly?: boolean;
}

/** Loc instance v3 theo filter (retryDueOnly can `nowMs`). */
export function filterComposioV120TriggerInstances(
  instances: ComposioV120TriggerInstance[],
  filter: ComposioV120TriggerInstanceFilter = {},
  nowMs: number = Date.now(),
): ComposioV120TriggerInstance[] {
  return instances.filter((i) => {
    if (filter.toolkit && i.base.base.toolkit !== filter.toolkit) return false;
    if (filter.connectionId && i.base.base.connectionId !== filter.connectionId) return false;
    if (filter.lifecycle && i.base.lifecycle !== filter.lifecycle) return false;
    if (filter.escalatedOnly && !i.retry.escalated) return false;
    if (filter.retryDueOnly && !isComposioV120RetryDue(i, nowMs)) return false;
    return true;
  });
}

/** Ket qua mot muc trong bulk enable/disable. */
export interface ComposioV120BulkResult {
  /** Id trigger. */
  triggerId: string;
  /** true = doi thanh cong. */
  ok: boolean;
  /** Lifecycle moi (null neu loi). */
  lifecycle: ComposioV119TriggerLifecycle | null;
  /** Loi khi ok = false. */
  error: string | null;
}

/**
 * Bulk doi lifecycle nhieu instance (vd tat het trigger cua mot
 * toolkit): chuyen hop le thi doi, chuyen sai thi ghi loi tung cai
 * chu khong dung ca loat. Tra ve instance moi + ket qua tung cai.
 */
export function bulkComposioV120SetLifecycle(
  instances: ComposioV120TriggerInstance[],
  triggerIds: string[],
  to: ComposioV119TriggerLifecycle,
  reason: string,
  nowMs: number = Date.now(),
): { instances: ComposioV120TriggerInstance[]; results: ComposioV120BulkResult[] } {
  if (!reason) throw new Error('ComposioV120 bulk: can ly do');
  const results: ComposioV120BulkResult[] = [];
  const next = instances.map((inst) => {
    if (!triggerIds.includes(inst.base.base.triggerId)) return inst;
    try {
      const base = transitionComposioV119TriggerLifecycle(inst.base, to, reason, nowMs);
      results.push({ triggerId: inst.base.base.triggerId, ok: true, lifecycle: to, error: null });
      return { base, retry: inst.retry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ triggerId: inst.base.base.triggerId, ok: false, lifecycle: null, error: message });
      return inst;
    }
  });
  // Them ket qua cho id khong tim thay.
  for (const id of triggerIds) {
    if (!instances.some((i) => i.base.base.triggerId === id)) {
      results.push({ triggerId: id, ok: false, lifecycle: null, error: `Khong tim thay trigger instance: ${id}` });
    }
  }
  return { instances: next, results };
}

/** Store retry v3 (memory + JSON file). */
export interface ComposioV120TriggerRetryStore {
  upsert(instance: ComposioV120TriggerInstance): ComposioV120TriggerInstance;
  get(triggerId: string): ComposioV120TriggerInstance | undefined;
  list(filter?: ComposioV120TriggerInstanceFilter, nowMs?: number): ComposioV120TriggerInstance[];
  remove(triggerId: string): boolean;
  clear(): void;
}

function cloneV120Instance(i: ComposioV120TriggerInstance): ComposioV120TriggerInstance {
  return JSON.parse(JSON.stringify(i)) as ComposioV120TriggerInstance;
}

/** Store trong bo nho (test + session). */
export class MemoryComposioV120TriggerRetryStore implements ComposioV120TriggerRetryStore {
  private readonly items = new Map<string, ComposioV120TriggerInstance>();

  upsert(instance: ComposioV120TriggerInstance): ComposioV120TriggerInstance {
    validateComposioV120TriggerInstance(instance);
    if (this.items.size >= COMPOSIO_V120_MAX_RETRY_INSTANCES && !this.items.has(instance.base.base.triggerId)) {
      throw new Error(`ComposioV120: vuot gioi han ${COMPOSIO_V120_MAX_RETRY_INSTANCES} instance`);
    }
    const copy = cloneV120Instance(instance);
    this.items.set(copy.base.base.triggerId, copy);
    return cloneV120Instance(copy);
  }

  get(triggerId: string): ComposioV120TriggerInstance | undefined {
    const found = this.items.get(triggerId);
    return found ? cloneV120Instance(found) : undefined;
  }

  list(filter: ComposioV120TriggerInstanceFilter = {}, nowMs: number = Date.now()): ComposioV120TriggerInstance[] {
    return filterComposioV120TriggerInstances([...this.items.values()].map(cloneV120Instance), filter, nowMs);
  }

  remove(triggerId: string): boolean {
    return this.items.delete(triggerId);
  }

  clear(): void {
    this.items.clear();
  }
}

/** Duong dan file retry v3. */
export function getComposioV120TriggerRetriesPath(dir: string): string {
  return path.join(dir, COMPOSIO_V120_TRIGGER_RETRIES_FILE);
}

/** Duong dan file audit retry v3. */
export function getComposioV120TriggerRetryAuditPath(dir: string): string {
  return path.join(dir, COMPOSIO_V120_TRIGGER_RETRY_AUDIT_FILE);
}

interface ComposioV120RetriesDoc {
  version: number;
  instances: ComposioV120TriggerInstance[];
}

function readV120RetriesDoc(file: string): ComposioV120RetriesDoc {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ComposioV120RetriesDoc;
    if (!raw || raw.version !== COMPOSIO_V120_TRIGGER_RETRIES_VERSION || !Array.isArray(raw.instances)) {
      return { version: COMPOSIO_V120_TRIGGER_RETRIES_VERSION, instances: [] };
    }
    return { version: COMPOSIO_V120_TRIGGER_RETRIES_VERSION, instances: raw.instances.filter((i) => {
      try { validateComposioV120TriggerInstance(i); return true; } catch { return false; }
    }) };
  } catch {
    return { version: COMPOSIO_V120_TRIGGER_RETRIES_VERSION, instances: [] };
  }
}

function writeV120RetriesDocAtomic(file: string, doc: ComposioV120RetriesDoc): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Store JSON file (ghi atomic, mode 0600 — cung mau v119). */
export class JsonFileComposioV120TriggerRetryStore implements ComposioV120TriggerRetryStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = getComposioV120TriggerRetriesPath(dir);
  }

  upsert(instance: ComposioV120TriggerInstance): ComposioV120TriggerInstance {
    validateComposioV120TriggerInstance(instance);
    const doc = readV120RetriesDoc(this.file);
    const idx = doc.instances.findIndex((i) => i.base.base.triggerId === instance.base.base.triggerId);
    const copy = cloneV120Instance(instance);
    if (idx >= 0) doc.instances[idx] = copy;
    else {
      if (doc.instances.length >= COMPOSIO_V120_MAX_RETRY_INSTANCES) {
        throw new Error(`ComposioV120: vuot gioi han ${COMPOSIO_V120_MAX_RETRY_INSTANCES} instance`);
      }
      doc.instances.push(copy);
    }
    writeV120RetriesDocAtomic(this.file, doc);
    return cloneV120Instance(copy);
  }

  get(triggerId: string): ComposioV120TriggerInstance | undefined {
    const found = readV120RetriesDoc(this.file).instances.find((i) => i.base.base.triggerId === triggerId);
    return found ? cloneV120Instance(found) : undefined;
  }

  list(filter: ComposioV120TriggerInstanceFilter = {}, nowMs: number = Date.now()): ComposioV120TriggerInstance[] {
    return filterComposioV120TriggerInstances(readV120RetriesDoc(this.file).instances.map(cloneV120Instance), filter, nowMs);
  }

  remove(triggerId: string): boolean {
    const doc = readV120RetriesDoc(this.file);
    const before = doc.instances.length;
    doc.instances = doc.instances.filter((i) => i.base.base.triggerId !== triggerId);
    if (doc.instances.length === before) return false;
    writeV120RetriesDocAtomic(this.file, doc);
    return true;
  }

  clear(): void {
    writeV120RetriesDocAtomic(this.file, { version: COMPOSIO_V120_TRIGGER_RETRIES_VERSION, instances: [] });
  }
}

/** Ghi mot dong audit retry v3 (JSONL, append, cat 500 dong). */
export function appendComposioV120TriggerRetryAudit(
  dir: string,
  entry: { triggerId: string; action: string; detail: string; atMs?: number },
): void {
  const file = getComposioV120TriggerRetryAuditPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify({ atMs: entry.atMs ?? Date.now(), ...entry })}\n`;
  fs.appendFileSync(file, line, { mode: 0o600 });
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > COMPOSIO_V120_MAX_RETRY_AUDIT_LINES) {
      fs.writeFileSync(file, `${lines.slice(-COMPOSIO_V120_MAX_RETRY_AUDIT_LINES).join('\n')}\n`, { mode: 0o600 });
    }
  } catch {
    // Khong doc duoc audit cu thi bo qua — khong lam hong flow chinh.
  }
}

/** Tao store v119 ben duoi (de test/tool tai su dung khi can). */
export function createComposioV120BaseStore(): MemoryComposioV119TriggerInstanceStore {
  return new MemoryComposioV119TriggerInstanceStore();
}
