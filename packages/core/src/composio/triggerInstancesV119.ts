/**
 * Composio trigger instances v2 — vong doi + lich su chay
 * (v1.19, Doi T4).
 *
 * Tang tren triggerInstancesV118.ts — KHONG viet lai:
 * - `ComposioV118TriggerInstance` van la metadata goc cua mot
 *   instance (triggerId/slug/toolkit/connection/label, status
 *   enabled/disabled, lastFiredAtMs, totalFired, loi lien tiep).
 * - Viec bat/tat o muc v118 (enabled/disabled) van la quyet dinh
 *   local "co xu ly event hay khong"; v2 them vong doi RIENG o muc
 *   van hanh (draft/active/paused/stopped/archived) de UI phan
 *   biet instance moi tao chua chay, instance tam dung co chu dich,
 *   instance dung han, instance luu tru.
 *
 * Moi trong v2:
 * 1. Vong doi (lifecycle): draft → active → paused → active →
 *    stopped → archived; archived la trang thai cuoi (chi xoa moi
 *    thoat). Moi chuyen deu kiem tra bang chuyen hop le — chuyen
 *    sai thi throw, khong lang le doi. Moi chuyen ghi audit (trang
 *    thai cu → moi, ly do, thoi gian).
 * 2. Lich su chay (run history): moi lan event cua instance fire
 *    thi mo mot RUN (runId, startedAtMs, eventId); khi xu ly xong
 *    thi dong run (finishedAtMs, status success/failed/skipped,
 *    durationMs, error). Run dang chay (chua dong) duoc tinh
 *    rieng — de UI thay trigger co dang ket khong.
 * 3. Giu lich su co gioi han: moi instance giu toi da
 *    `maxRunsPerInstance` run gan nhat (mac dinh 100); vuot thi
 *    cat run cu nhat (chi cat run DA DONG — run dang chay khong
 *    bao gio bi cat).
 * 4. Tom tat chay: dem theo status, ti le loi, thoi gian chay
 *    trung binh / lau nhat, lan chay cuoi — de UI + health v118
 *    co them co so.
 * 5. Store: memory + JSON file atomic (mode 0600) trong
 *    `<userData>/composio/` — cung mau voi v118 (instance +
 *    audit JSONL rieng).
 *
 * NGUYEN TAC (ghi trong v118, van giu nguyen): trigger instances
 * KHONG duoc tao boi open-bot — user tao trigger trong Composio,
 * module nay chi QUAN LY PHIA OPEN-BOT (metadata + vong doi +
 * lich su chay local). Module nay KHONG goi Composio API va KHONG
 * thay key.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createComposioV118TriggerInstance,
  validateComposioV118TriggerInstance,
  type ComposioV118RegisterTriggerInput,
  type ComposioV118TriggerInstance,
} from './triggerInstancesV118';

/** File instance v2 trong thu muc composio cua userData. */
export const COMPOSIO_V119_TRIGGER_INSTANCES_FILE = 'composio-trigger-instances-v119.json';
/** File audit log trigger instance v2 (JSONL, append). */
export const COMPOSIO_V119_TRIGGER_INSTANCE_AUDIT_FILE = 'composio-trigger-instances-audit-v119.jsonl';
/** Phien ban dinh dang file instance v2. */
export const COMPOSIO_V119_TRIGGER_INSTANCES_VERSION = 1;
/** Giu toi da tung nay dong audit. */
export const COMPOSIO_V119_MAX_AUDIT_LINES = 500;
/** Giu toi da tung nay instance. */
export const COMPOSIO_V119_MAX_INSTANCES = 500;
/** Giu toi da tung nay run moi instance. */
export const COMPOSIO_V119_DEFAULT_MAX_RUNS_PER_INSTANCE = 100;
/** Run qua bao lau (ms) chua dong thi coi la ket (stuck). */
export const COMPOSIO_V119_STUCK_RUN_AFTER_MS = 30 * 60 * 1000;

/** Vong doi cua mot trigger instance v2. */
export type ComposioV119TriggerLifecycle =
  | 'draft'
  | 'active'
  | 'paused'
  | 'stopped'
  | 'archived';

export const COMPOSIO_V119_TRIGGER_LIFECYCLES: readonly ComposioV119TriggerLifecycle[] = [
  'draft',
  'active',
  'paused',
  'stopped',
  'archived',
];

/**
 * Bang chuyen vong doi hop le. `archived` la trang thai cuoi: chi
 * xoa (khong phai chuyen) moi thoat duoc — instance luu tru khong
 * chay lai duoc, muon dung lai thi dang ky instance moi.
 */
export const COMPOSIO_V119_TRIGGER_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ComposioV119TriggerLifecycle, readonly ComposioV119TriggerLifecycle[]>
> = {
  draft: ['active', 'archived'],
  active: ['paused', 'stopped', 'archived'],
  paused: ['active', 'stopped', 'archived'],
  stopped: ['active', 'archived'],
  archived: [],
};

/** true khi chuyen tu `from` sang `to` la hop le. */
export function isComposioV119LifecycleTransitionAllowed(
  from: ComposioV119TriggerLifecycle,
  to: ComposioV119TriggerLifecycle,
): boolean {
  return (COMPOSIO_V119_TRIGGER_LIFECYCLE_TRANSITIONS[from] as readonly ComposioV119TriggerLifecycle[]).includes(to);
}

/** Trang thai ket thuc cua mot run (da dong). */
export type ComposioV119RunStatus = 'success' | 'failed' | 'skipped';

/** Mot lan chay (run) cua mot trigger instance. */
export interface ComposioV119TriggerRun {
  /** Id run (duy nhat trong instance). */
  runId: string;
  /** Id event Composio da kich hoat run nay (neu co). */
  eventId: string | null;
  /** ms epoch bat dau chay. */
  startedAtMs: number;
  /** ms epoch chay xong (null = dang chay). */
  finishedAtMs: number | null;
  /** Trang thai ket thuc (null = dang chay). */
  status: ComposioV119RunStatus | null;
  /** Loi khi status = 'failed' (null neu khong loi). */
  error: string | null;
}

/** Mot trigger instance v2: metadata v118 + vong doi + lich su chay. */
export interface ComposioV119TriggerInstance {
  /** Metadata goc v118 (triggerId/slug/toolkit/connection/...). */
  base: ComposioV118TriggerInstance;
  /** Vong doi hien tai. */
  lifecycle: ComposioV119TriggerLifecycle;
  /** ms epoch lan doi vong doi cuoi. */
  lifecycleUpdatedAtMs: number;
  /** Ly do cua lan doi vong doi cuoi. */
  lifecycleReason: string | null;
  /** Lich su chay — moi nhat o CUOI (append). */
  runs: ComposioV119TriggerRun[];
  /** So run toi da giu (cat run cu khi vuot). */
  maxRuns: number;
}

/** Input dang ky mot instance v2 moi (toi thieu). */
export interface ComposioV119RegisterTriggerInput extends ComposioV118RegisterTriggerInput {
  /** Vong doi khoi tao (mac dinh 'draft'). */
  lifecycle?: ComposioV119TriggerLifecycle;
  /** So run toi da giu (mac dinh 100). */
  maxRuns?: number;
}

/** Hanh dong ghi vao audit v2. */
export type ComposioV119TriggerAuditAction =
  | 'register'
  | 'lifecycle'
  | 'enable'
  | 'disable'
  | 'delete'
  | 'run-started'
  | 'run-finished';

export const COMPOSIO_V119_TRIGGER_AUDIT_ACTIONS: readonly ComposioV119TriggerAuditAction[] = [
  'register',
  'lifecycle',
  'enable',
  'disable',
  'delete',
  'run-started',
  'run-finished',
];

/** Mot dong audit trigger instance v2. */
export interface ComposioV119TriggerAuditEntry {
  id: string;
  triggerId: string;
  triggerSlug: string;
  action: ComposioV119TriggerAuditAction;
  /** Chi tiet (vd 'draft -> active' hoac runId + status). */
  detail: string;
  reason: string;
  atMs: number;
}

/** Kiem tra mot run co hop le khong (throw neu sai). */
export function validateComposioV119TriggerRun(raw: unknown): ComposioV119TriggerRun {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119TriggerRun must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['runId'] !== 'string' || (rec['runId'] as string).trim() === '') {
    throw new Error('run.runId must be a non-empty string.');
  }
  if (rec['eventId'] !== null && typeof rec['eventId'] !== 'string') {
    throw new Error('run.eventId must be a string or null.');
  }
  if (typeof rec['startedAtMs'] !== 'number' || !Number.isFinite(rec['startedAtMs']) || (rec['startedAtMs'] as number) < 0) {
    throw new Error('run.startedAtMs must be a non-negative number.');
  }
  if (rec['finishedAtMs'] !== null && (typeof rec['finishedAtMs'] !== 'number' || !Number.isFinite(rec['finishedAtMs']))) {
    throw new Error('run.finishedAtMs must be null or a number.');
  }
  if (
    rec['status'] !== null &&
    rec['status'] !== 'success' &&
    rec['status'] !== 'failed' &&
    rec['status'] !== 'skipped'
  ) {
    throw new Error('run.status must be success, failed, skipped or null.');
  }
  if ((rec['finishedAtMs'] === null) !== (rec['status'] === null)) {
    throw new Error('run.finishedAtMs and run.status must both be null (running) or both set (finished).');
  }
  if (rec['finishedAtMs'] !== null && (rec['finishedAtMs'] as number) < (rec['startedAtMs'] as number)) {
    throw new Error('run.finishedAtMs must not be before run.startedAtMs.');
  }
  if (rec['error'] !== null && typeof rec['error'] !== 'string') {
    throw new Error('run.error must be a string or null.');
  }
  return {
    runId: rec['runId'] as string,
    eventId: rec['eventId'] as string | null,
    startedAtMs: rec['startedAtMs'] as number,
    finishedAtMs: rec['finishedAtMs'] as number | null,
    status: rec['status'] as ComposioV119RunStatus | null,
    error: rec['error'] as string | null,
  };
}

/** Kiem tra mot instance v2 co hop le khong (throw neu sai). */
export function validateComposioV119TriggerInstance(raw: unknown): ComposioV119TriggerInstance {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119TriggerInstance must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  const base = validateComposioV118TriggerInstance(rec['base']);
  if (
    typeof rec['lifecycle'] !== 'string' ||
    !(COMPOSIO_V119_TRIGGER_LIFECYCLES as readonly string[]).includes(rec['lifecycle'])
  ) {
    throw new Error('triggerInstance.lifecycle is invalid.');
  }
  if (typeof rec['lifecycleUpdatedAtMs'] !== 'number' || !Number.isFinite(rec['lifecycleUpdatedAtMs']) || (rec['lifecycleUpdatedAtMs'] as number) < 0) {
    throw new Error('triggerInstance.lifecycleUpdatedAtMs must be a non-negative number.');
  }
  if (rec['lifecycleReason'] !== null && typeof rec['lifecycleReason'] !== 'string') {
    throw new Error('triggerInstance.lifecycleReason must be a string or null.');
  }
  if (!Array.isArray(rec['runs'])) throw new Error('triggerInstance.runs must be an array.');
  const runs = (rec['runs'] as unknown[]).map((r) => validateComposioV119TriggerRun(r));
  if (new Set(runs.map((r) => r.runId)).size !== runs.length) {
    throw new Error('triggerInstance.runs must not contain duplicate runId.');
  }
  if (!Number.isInteger(rec['maxRuns']) || (rec['maxRuns'] as number) < 1) {
    throw new Error('triggerInstance.maxRuns must be a positive integer.');
  }
  if (runs.length > (rec['maxRuns'] as number)) {
    throw new Error('triggerInstance.runs must not exceed maxRuns.');
  }
  return {
    base,
    lifecycle: rec['lifecycle'] as ComposioV119TriggerLifecycle,
    lifecycleUpdatedAtMs: rec['lifecycleUpdatedAtMs'] as number,
    lifecycleReason: rec['lifecycleReason'] as string | null,
    runs,
    maxRuns: rec['maxRuns'] as number,
  };
}

/** Dang ky mot instance v2 moi tu input toi thieu (ham thuan, chua luu). */
export function createComposioV119TriggerInstance(
  input: ComposioV119RegisterTriggerInput,
  nowMs: number = Date.now(),
): ComposioV119TriggerInstance {
  const base = createComposioV118TriggerInstance(input, nowMs);
  const lifecycle = input.lifecycle ?? 'draft';
  if (!(COMPOSIO_V119_TRIGGER_LIFECYCLES as readonly string[]).includes(lifecycle)) {
    throw new Error(`Unknown ComposioV119TriggerLifecycle: ${lifecycle}`);
  }
  const maxRuns = input.maxRuns ?? COMPOSIO_V119_DEFAULT_MAX_RUNS_PER_INSTANCE;
  if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new Error('maxRuns must be a positive integer');
  return validateComposioV119TriggerInstance({
    base,
    lifecycle,
    lifecycleUpdatedAtMs: nowMs,
    lifecycleReason: null,
    runs: [],
    maxRuns,
  });
}

/**
 * Chuyen vong doi (ham thuan): kiem tra bang chuyen hop le roi moi
 * doi. `archived` la trang thai cuoi — chuyen ra khoi archived thi
 * throw. Instance o 'draft' chua chay: chuyen sang 'active' moi
 * duoc phep nhan event.
 */
export function transitionComposioV119TriggerLifecycle(
  prev: ComposioV119TriggerInstance,
  to: ComposioV119TriggerLifecycle,
  reason: string,
  nowMs: number = Date.now(),
): ComposioV119TriggerInstance {
  if (!isComposioV119LifecycleTransitionAllowed(prev.lifecycle, to)) {
    throw new Error(`Invalid Composio v119 lifecycle transition: ${prev.lifecycle} -> ${to}`);
  }
  return validateComposioV119TriggerInstance({
    ...prev,
    lifecycle: to,
    lifecycleUpdatedAtMs: nowMs,
    lifecycleReason: reason.trim() === '' ? to : reason.trim(),
  });
}

/** Instance co duoc nhan event luc nay khong: lifecycle active + base enabled. */
export function isComposioV119TriggerInstanceRunnable(
  instance: ComposioV119TriggerInstance,
): boolean {
  return instance.lifecycle === 'active' && instance.base.status === 'enabled';
}

/** So run dang chay (chua dong) cua mot instance. */
export function countComposioV119RunningRuns(instance: ComposioV119TriggerInstance): number {
  return instance.runs.filter((r) => r.status === null).length;
}

/** Run dang chay lau nhat (null neu khong co run nao dang chay). */
export function findComposioV119StuckRuns(
  instance: ComposioV119TriggerInstance,
  nowMs: number = Date.now(),
  stuckAfterMs: number = COMPOSIO_V119_STUCK_RUN_AFTER_MS,
): ComposioV119TriggerRun[] {
  return instance.runs.filter((r) => r.status === null && nowMs - r.startedAtMs > stuckAfterMs);
}

/**
 * Mo mot run moi (ham thuan): them run dang chay vao lich su.
 * Chi mo duoc khi instance runnable — mo run cho instance
 * draft/paused/stopped/archived thi throw (event do khong duoc
 * xu ly). Cat run cu khi vuot maxRuns (chi cat run DA DONG).
 */
export function startComposioV119TriggerRun(
  prev: ComposioV119TriggerInstance,
  eventId: string | null,
  nowMs: number = Date.now(),
): { instance: ComposioV119TriggerInstance; run: ComposioV119TriggerRun } {
  if (!isComposioV119TriggerInstanceRunnable(prev)) {
    throw new Error(
      `Trigger instance ${prev.base.triggerId} is not runnable (lifecycle ${prev.lifecycle}, status ${prev.base.status})`,
    );
  }
  const run: ComposioV119TriggerRun = {
    runId: `run119-${crypto.randomUUID()}`,
    eventId,
    startedAtMs: nowMs,
    finishedAtMs: null,
    status: null,
    error: null,
  };
  const withRun: ComposioV119TriggerInstance = {
    ...prev,
    runs: [...prev.runs, run],
    base: {
      ...prev.base,
      lastFiredAtMs: nowMs,
      totalFired: prev.base.totalFired + 1,
      consecutiveErrors: 0,
      lastError: null,
      updatedAtMs: nowMs,
    },
  };
  return { instance: pruneComposioV119Runs(withRun), run };
}

/**
 * Dong mot run (ham thuan): dat finishedAtMs + status + error
 * (neu failed). Run khong ton tai hoac da dong thi throw. Dong
 * run failed thi tang `consecutiveErrors` cua base.
 */
export function finishComposioV119TriggerRun(
  prev: ComposioV119TriggerInstance,
  runId: string,
  status: ComposioV119RunStatus,
  opts: { error?: string; nowMs?: number } = {},
): ComposioV119TriggerInstance {
  const nowMs = opts.nowMs ?? Date.now();
  const idx = prev.runs.findIndex((r) => r.runId === runId);
  if (idx < 0) throw new Error(`Unknown trigger run id: ${runId}`);
  const run = prev.runs[idx];
  if (run.status !== null) throw new Error(`Trigger run ${runId} is already finished`);
  const finished: ComposioV119TriggerRun = {
    ...run,
    finishedAtMs: nowMs,
    status,
    error: status === 'failed' ? (opts.error?.trim() === '' || opts.error === undefined ? 'trigger run failed' : opts.error.trim()) : null,
  };
  const runs = [...prev.runs];
  runs[idx] = finished;
  const base = {
    ...prev.base,
    consecutiveErrors: status === 'failed' ? prev.base.consecutiveErrors + 1 : 0,
    lastError: status === 'failed' ? finished.error : null,
    updatedAtMs: nowMs,
  };
  return validateComposioV119TriggerInstance({ ...prev, runs, base });
}

/** Cat run cu khi vuot maxRuns — chi cat run DA DONG, giu run dang chay. */
export function pruneComposioV119Runs(
  prev: ComposioV119TriggerInstance,
): ComposioV119TriggerInstance {
  if (prev.runs.length <= prev.maxRuns) return prev;
  const running = prev.runs.filter((r) => r.status === null);
  const finished = prev.runs.filter((r) => r.status !== null);
  const keepFinished = finished.slice(-Math.max(0, prev.maxRuns - running.length));
  const kept = new Set([...keepFinished, ...running].map((r) => r.runId));
  // Giu thu tu thoi gian: run cu truoc, run moi sau.
  const ordered = prev.runs.filter((r) => kept.has(r.runId));
  return validateComposioV119TriggerInstance({ ...prev, runs: ordered });
}

/** Thoi gian chay cua mot run da dong (ms) — null khi dang chay. */
export function composioV119RunDurationMs(run: ComposioV119TriggerRun): number | null {
  if (run.finishedAtMs === null) return null;
  return run.finishedAtMs - run.startedAtMs;
}

/** Tom tat chay cua mot instance (de UI hien). */
export function summarizeComposioV119TriggerRuns(
  instance: ComposioV119TriggerInstance,
  nowMs: number = Date.now(),
): {
  total: number;
  running: number;
  success: number;
  failed: number;
  skipped: number;
  stuck: number;
  failureRate: number;
  avgDurationMs: number | null;
  maxDurationMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: ComposioV119RunStatus | null;
} {
  const finished = instance.runs.filter((r) => r.status !== null);
  const durations = finished
    .map((r) => composioV119RunDurationMs(r))
    .filter((d): d is number => d !== null);
  const success = finished.filter((r) => r.status === 'success').length;
  const failed = finished.filter((r) => r.status === 'failed').length;
  const skipped = finished.filter((r) => r.status === 'skipped').length;
  const last = instance.runs[instance.runs.length - 1];
  return {
    total: instance.runs.length,
    running: countComposioV119RunningRuns(instance),
    success,
    failed,
    skipped,
    stuck: findComposioV119StuckRuns(instance, nowMs).length,
    failureRate: finished.length === 0 ? 0 : failed / finished.length,
    avgDurationMs: durations.length === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    maxDurationMs: durations.length === 0 ? null : Math.max(...durations),
    lastRunAtMs: last ? last.startedAtMs : null,
    lastStatus: last ? last.status : null,
  };
}

/** Tom tat mot instance v2 cho UI (1 dong). */
export function summarizeComposioV119TriggerInstance(
  instance: ComposioV119TriggerInstance,
  nowMs: number = Date.now(),
): string {
  const runs = summarizeComposioV119TriggerRuns(instance, nowMs);
  const runnable = isComposioV119TriggerInstanceRunnable(instance) ? 'runnable' : 'not runnable';
  return `${instance.base.label} (${instance.base.triggerSlug}, ${instance.lifecycle}/${instance.base.status}, ${runnable}): ${runs.total} runs (${runs.success} ok, ${runs.failed} failed, ${runs.running} running).`;
}

/** Filter khi liet ke instance v2. */
export interface ComposioV119TriggerInstanceFilter {
  toolkit?: string;
  triggerSlug?: string;
  connectionId?: string;
  lifecycle?: ComposioV119TriggerLifecycle;
  status?: 'enabled' | 'disabled';
  runnable?: boolean;
}

/** Loc instance theo filter (ham thuan). */
export function filterComposioV119TriggerInstances(
  instances: readonly ComposioV119TriggerInstance[],
  filter: ComposioV119TriggerInstanceFilter,
): ComposioV119TriggerInstance[] {
  return instances.filter(
    (i) =>
      (filter.toolkit === undefined || i.base.toolkit === filter.toolkit) &&
      (filter.triggerSlug === undefined || i.base.triggerSlug === filter.triggerSlug) &&
      (filter.connectionId === undefined || i.base.connectionId === filter.connectionId) &&
      (filter.lifecycle === undefined || i.lifecycle === filter.lifecycle) &&
      (filter.status === undefined || i.base.status === filter.status) &&
      (filter.runnable === undefined || isComposioV119TriggerInstanceRunnable(i) === filter.runnable),
  );
}

/** Tom tat nhanh cho UI: dem theo lifecycle + run. */
export function summarizeComposioV119TriggerInstances(
  instances: readonly ComposioV119TriggerInstance[],
  nowMs: number = Date.now(),
): {
  total: number;
  runnable: number;
  byLifecycle: Record<ComposioV119TriggerLifecycle, number>;
  totalRuns: number;
  totalFailed: number;
  totalRunning: number;
  stuck: string[];
  needsAttention: string[];
} {
  const summary = {
    total: instances.length,
    runnable: 0,
    byLifecycle: { draft: 0, active: 0, paused: 0, stopped: 0, archived: 0 } as Record<
      ComposioV119TriggerLifecycle,
      number
    >,
    totalRuns: 0,
    totalFailed: 0,
    totalRunning: 0,
    stuck: [] as string[],
    needsAttention: [] as string[],
  };
  for (const i of instances) {
    summary.byLifecycle[i.lifecycle] += 1;
    if (isComposioV119TriggerInstanceRunnable(i)) summary.runnable += 1;
    const runs = summarizeComposioV119TriggerRuns(i, nowMs);
    summary.totalRuns += runs.total;
    summary.totalFailed += runs.failed;
    summary.totalRunning += runs.running;
    if (runs.stuck > 0) summary.stuck.push(i.base.triggerId);
    if (runs.failed > 0 && runs.failureRate >= 0.5) summary.needsAttention.push(i.base.triggerId);
  }
  summary.stuck.sort();
  summary.needsAttention.sort();
  return summary;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** Tao mot dong audit v2 (ham thuan). */
export function createComposioV119TriggerAuditEntry(
  triggerId: string,
  triggerSlug: string,
  action: ComposioV119TriggerAuditAction,
  detail: string,
  reason: string,
  atMs: number = Date.now(),
): ComposioV119TriggerAuditEntry {
  if (typeof triggerId !== 'string' || triggerId.trim() === '') throw new Error('triggerId must be a non-empty string');
  if (!COMPOSIO_V119_TRIGGER_AUDIT_ACTIONS.includes(action)) {
    throw new Error(`Unknown ComposioV119TriggerAuditAction: ${action}`);
  }
  return {
    id: `ti119-${crypto.randomUUID()}`,
    triggerId: triggerId.trim(),
    triggerSlug,
    action,
    detail: detail.trim() === '' ? action : detail.trim(),
    reason: reason.trim() === '' ? action : reason.trim(),
    atMs,
  };
}

/** Kiem tra mot dong audit v2 (throw neu sai). */
export function validateComposioV119TriggerAuditEntry(raw: unknown): ComposioV119TriggerAuditEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119TriggerAuditEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || (rec['id'] as string).trim() === '') throw new Error('audit id must be a non-empty string.');
  if (typeof rec['triggerId'] !== 'string' || (rec['triggerId'] as string).trim() === '') throw new Error('audit triggerId must be a non-empty string.');
  if (typeof rec['triggerSlug'] !== 'string' || (rec['triggerSlug'] as string).trim() === '') throw new Error('audit triggerSlug must be a non-empty string.');
  if (
    typeof rec['action'] !== 'string' ||
    !(COMPOSIO_V119_TRIGGER_AUDIT_ACTIONS as readonly string[]).includes(rec['action'])
  ) {
    throw new Error('audit action is invalid.');
  }
  if (typeof rec['detail'] !== 'string' || (rec['detail'] as string).trim() === '') throw new Error('audit detail must be a non-empty string.');
  if (typeof rec['reason'] !== 'string' || (rec['reason'] as string).trim() === '') throw new Error('audit reason must be a non-empty string.');
  if (typeof rec['atMs'] !== 'number' || !Number.isFinite(rec['atMs'])) throw new Error('audit atMs must be a number.');
  return {
    id: rec['id'] as string,
    triggerId: rec['triggerId'] as string,
    triggerSlug: rec['triggerSlug'] as string,
    action: rec['action'] as ComposioV119TriggerAuditAction,
    detail: rec['detail'] as string,
    reason: rec['reason'] as string,
    atMs: rec['atMs'] as number,
  };
}

// ---------------------------------------------------------------------------
// Store — memory + JSON file (atomic, mode 0600) + audit JSONL
// ---------------------------------------------------------------------------

/** Interface store instance v2. */
export interface ComposioV119TriggerInstanceStore {
  register(input: ComposioV119RegisterTriggerInput, nowMs?: number): ComposioV119TriggerInstance;
  get(triggerId: string): ComposioV119TriggerInstance | undefined;
  list(filter?: ComposioV119TriggerInstanceFilter): ComposioV119TriggerInstance[];
  update(instance: ComposioV119TriggerInstance): ComposioV119TriggerInstance;
  remove(triggerId: string): boolean;
  clear(): void;
}

function cloneInstance(i: ComposioV119TriggerInstance): ComposioV119TriggerInstance {
  return JSON.parse(JSON.stringify(i)) as ComposioV119TriggerInstance;
}

/** Store trong bo nho — de test + host khong co userData dir. */
export class MemoryComposioV119TriggerInstanceStore implements ComposioV119TriggerInstanceStore {
  private readonly instances = new Map<string, ComposioV119TriggerInstance>();
  private readonly audit: ComposioV119TriggerAuditEntry[] = [];

  register(input: ComposioV119RegisterTriggerInput, nowMs: number = Date.now()): ComposioV119TriggerInstance {
    const instance = createComposioV119TriggerInstance(input, nowMs);
    if (this.instances.has(instance.base.triggerId)) {
      throw new Error(`duplicate trigger instance id: ${instance.base.triggerId}`);
    }
    if (this.instances.size >= COMPOSIO_V119_MAX_INSTANCES) {
      throw new Error(`too many trigger instances (max ${COMPOSIO_V119_MAX_INSTANCES})`);
    }
    this.instances.set(instance.base.triggerId, instance);
    this.audit.push(
      createComposioV119TriggerAuditEntry(
        instance.base.triggerId,
        instance.base.triggerSlug,
        'register',
        `lifecycle ${instance.lifecycle}`,
        'registered by user',
        nowMs,
      ),
    );
    return cloneInstance(instance);
  }

  get(triggerId: string): ComposioV119TriggerInstance | undefined {
    const i = this.instances.get(triggerId);
    return i ? cloneInstance(i) : undefined;
  }

  list(filter: ComposioV119TriggerInstanceFilter = {}): ComposioV119TriggerInstance[] {
    return filterComposioV119TriggerInstances([...this.instances.values()], filter).map(cloneInstance);
  }

  update(instance: ComposioV119TriggerInstance): ComposioV119TriggerInstance {
    const valid = validateComposioV119TriggerInstance(instance);
    if (!this.instances.has(valid.base.triggerId)) throw new Error(`unknown trigger instance id: ${valid.base.triggerId}`);
    this.instances.set(valid.base.triggerId, valid);
    return cloneInstance(valid);
  }

  remove(triggerId: string): boolean {
    return this.instances.delete(triggerId);
  }

  clear(): void {
    this.instances.clear();
    this.audit.length = 0;
  }

  /** Audit trong bo nho (moi nhat truoc). */
  listAudit(limit?: number): ComposioV119TriggerAuditEntry[] {
    const reversed = [...this.audit].reverse();
    return limit !== undefined ? reversed.slice(0, Math.max(0, limit)) : reversed;
  }
}

/** Duong dan file instance v2. */
export function getComposioV119TriggerInstancesPath(dir: string): string {
  return path.join(dir, COMPOSIO_V119_TRIGGER_INSTANCES_FILE);
}

/** Duong dan file audit v2. */
export function getComposioV119TriggerInstanceAuditPath(dir: string): string {
  return path.join(dir, COMPOSIO_V119_TRIGGER_INSTANCE_AUDIT_FILE);
}

/** Store tren dia (file JSON + audit JSONL). */
export class JsonFileComposioV119TriggerInstanceStore implements ComposioV119TriggerInstanceStore {
  private readonly filePath: string;
  private readonly auditPath: string;

  constructor(dir: string) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('trigger instance store dir must be a non-empty string');
    }
    this.filePath = getComposioV119TriggerInstancesPath(dir);
    this.auditPath = getComposioV119TriggerInstanceAuditPath(dir);
  }

  /** Duong dan file dang dung (de UI/log hien). */
  get path(): string {
    return this.filePath;
  }

  private loadAllRaw(): ComposioV119TriggerInstance[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) throw new Error(`Invalid ${COMPOSIO_V119_TRIGGER_INSTANCES_FILE}: expected an array.`);
    return raw.map((entry) => validateComposioV119TriggerInstance(entry));
  }

  private saveAllRaw(instances: readonly ComposioV119TriggerInstance[]): void {
    for (const i of instances) validateComposioV119TriggerInstance(i);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify(instances, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows khong co chmod unix — bo qua.
    }
  }

  private appendAudit(entry: ComposioV119TriggerAuditEntry): void {
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
    fs.appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const lines = fs.readFileSync(this.auditPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    if (lines.length > COMPOSIO_V119_MAX_AUDIT_LINES) {
      const kept = lines.slice(-COMPOSIO_V119_MAX_AUDIT_LINES);
      const tmp = `${this.auditPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.auditPath);
    }
  }

  register(input: ComposioV119RegisterTriggerInput, nowMs: number = Date.now()): ComposioV119TriggerInstance {
    const instance = createComposioV119TriggerInstance(input, nowMs);
    const all = this.loadAllRaw();
    if (all.some((i) => i.base.triggerId === instance.base.triggerId)) {
      throw new Error(`duplicate trigger instance id: ${instance.base.triggerId}`);
    }
    if (all.length >= COMPOSIO_V119_MAX_INSTANCES) {
      throw new Error(`too many trigger instances (max ${COMPOSIO_V119_MAX_INSTANCES})`);
    }
    all.push(instance);
    this.saveAllRaw(all);
    this.appendAudit(
      createComposioV119TriggerAuditEntry(
        instance.base.triggerId,
        instance.base.triggerSlug,
        'register',
        `lifecycle ${instance.lifecycle}`,
        'registered by user',
        nowMs,
      ),
    );
    return cloneInstance(instance);
  }

  get(triggerId: string): ComposioV119TriggerInstance | undefined {
    const i = this.loadAllRaw().find((x) => x.base.triggerId === triggerId);
    return i ? cloneInstance(i) : undefined;
  }

  list(filter: ComposioV119TriggerInstanceFilter = {}): ComposioV119TriggerInstance[] {
    return filterComposioV119TriggerInstances(this.loadAllRaw(), filter).map(cloneInstance);
  }

  update(instance: ComposioV119TriggerInstance): ComposioV119TriggerInstance {
    const valid = validateComposioV119TriggerInstance(instance);
    const all = this.loadAllRaw();
    const idx = all.findIndex((i) => i.base.triggerId === valid.base.triggerId);
    if (idx < 0) throw new Error(`unknown trigger instance id: ${valid.base.triggerId}`);
    all[idx] = valid;
    this.saveAllRaw(all);
    return cloneInstance(valid);
  }

  remove(triggerId: string): boolean {
    const all = this.loadAllRaw();
    const kept = all.filter((i) => i.base.triggerId !== triggerId);
    if (kept.length === all.length) return false;
    this.saveAllRaw(kept);
    return true;
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    if (fs.existsSync(this.auditPath)) fs.unlinkSync(this.auditPath);
  }

  /** Audit tren dia (moi nhat truoc). */
  listAudit(opts: { triggerId?: string; action?: ComposioV119TriggerAuditAction; limit?: number } = {}): ComposioV119TriggerAuditEntry[] {
    if (!fs.existsSync(this.auditPath)) return [];
    const lines = fs.readFileSync(this.auditPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const all = lines.map((line) => validateComposioV119TriggerAuditEntry(JSON.parse(line) as unknown));
    const filtered = all.filter(
      (e) => (opts.triggerId === undefined || e.triggerId === opts.triggerId) && (opts.action === undefined || e.action === opts.action),
    );
    const reversed = filtered.reverse();
    return opts.limit !== undefined ? reversed.slice(0, Math.max(0, opts.limit)) : reversed;
  }
}
