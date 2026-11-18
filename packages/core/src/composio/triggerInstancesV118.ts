/**
 * Composio trigger instances v1.18 — quan ly metadata + trang thai
 * trigger instance (v1.18, Doi T4).
 *
 * NGUYEN TAC (ghi trong triggers.ts tu v0.83, van giu nguyen):
 * trigger instances KHONG duoc tao boi open-bot — user tao trigger
 * trong Composio (dashboard/SDK/CLI) cho connected account cua ho,
 * tro webhook ve Local API. Module nay la tang QUAN LY PHIA
 * OPEN-BOT: khi user da tao trigger ben Composio, ho dang ky
 * instance do vao open-bot (bang trigger id `ti_...` + trigger slug
 * + connection id) de open-bot theo doi, bat/tat, do suc khoe va
 * biet lan cuoi no fire luc nao.
 *
 * Module nay KHONG goi Composio API va KHONG thay key: no chi giu
 * metadata local (trigger id, slug, connection, trang thai bat/tat,
 * lan fire cuoi, so lan fire, loi gan nhat). Viec tao that ben
 * Composio van do user lam trong dashboard; viec bat/tat o day chi
 * la quyet dinh local — open-bot co xu ly event cua instance do hay
 * khong (route trong webhookIngestV118 ton trong co `enabled`).
 *
 * Tinh nang:
 * - CRUD: dang ky / liet ke / lay / bat / tat / xoa instance.
 * - Health: moi instance co `health` (healthy/stale/silent/error)
 *   tinh tu lan fire cuoi + loi lien tiep; `lastFiredAtMs` cap nhat
 *   khi webhookIngestV118 route event toi instance.
 * - Audit: moi lan doi trang thai (dang ky/bat/tat/xoa/fire) deu
 *   ghi mot dong audit (khong chua secret, chi id + hanh dong +
 *   ly do + thoi gian).
 * - Store: memory + JSON file atomic (mode 0600) trong
 *   `<userData>/composio/` — cung mau voi connectionLifecycle.ts
 *   va pollCheckpointStoreV114.ts.
 *
 * Tat ca ham quyet dinh deu thuan; chi store doc/ghi file.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isValidComposioTriggerSlug } from './triggers';

/** File instance trong thu muc composio cua userData. */
export const COMPOSIO_V118_TRIGGER_INSTANCES_FILE = 'composio-trigger-instances-v118.json';
/** File audit log trigger instance (JSONL, append). */
export const COMPOSIO_V118_TRIGGER_INSTANCE_AUDIT_FILE = 'composio-trigger-instances-audit-v118.jsonl';
/** Phien ban dinh dang file instance. */
export const COMPOSIO_V118_TRIGGER_INSTANCES_VERSION = 1;
/** Giu toi da tung nay dong audit. */
export const COMPOSIO_V118_MAX_AUDIT_LINES = 500;
/** Giu toi da tung nay instance. */
export const COMPOSIO_V118_MAX_INSTANCES = 500;

/** Trang thai bat/tat cua mot trigger instance. */
export type ComposioV118TriggerInstanceStatus = 'enabled' | 'disabled';

/** Suc khoe cua mot trigger instance (tinh tu lan fire + loi). */
export type ComposioV118TriggerHealth = 'healthy' | 'stale' | 'silent' | 'error';

/** Nguong tinh health (ms): chua fire qua bao lau thi 'stale'. */
export const COMPOSIO_V118_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Nguong tinh health (ms): chua fire qua bao lau thi 'silent'. */
export const COMPOSIO_V118_SILENT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Mot trigger instance do user dang ky (metadata local). */
export interface ComposioV118TriggerInstance {
  /** Trigger instance id ben Composio, vd 'ti_xyz789'. */
  triggerId: string;
  /** Trigger slug, vd 'GITHUB_COMMIT_EVENT'. */
  triggerSlug: string;
  /** Toolkit slug, vd 'github'. */
  toolkit: string;
  /** Connected account id (`ca_...`) ma trigger thuoc ve. */
  connectionId: string;
  /** Ten goi nho do user dat (vd 'PR cua repo open-bot'). */
  label: string;
  /** Bat/tat: tat thi open-bot bo qua event cua instance nay. */
  status: ComposioV118TriggerInstanceStatus;
  /** ms epoch lan dang ky (luc user them vao open-bot). */
  createdAtMs: number;
  /** ms epoch lan doi trang thai cuoi. */
  updatedAtMs: number;
  /** ms epoch lan event cua instance nay fire gan nhat (null = chua fire). */
  lastFiredAtMs: number | null;
  /** Tong so event da fire (tich luy). */
  totalFired: number;
  /** So loi lien tiep khi xu ly event cua instance nay. */
  consecutiveErrors: number;
  /** Loi gan nhat (null khi lan cuoi khong loi). */
  lastError: string | null;
  /** Ghi chu tuy y cua user (vd 'chi chay gio hanh chinh'). */
  note?: string;
}

/** Input dang ky mot instance moi (toi thieu). */
export interface ComposioV118RegisterTriggerInput {
  triggerId: string;
  triggerSlug: string;
  toolkit: string;
  connectionId: string;
  label?: string;
  note?: string;
  /** Mac dinh enabled. */
  status?: ComposioV118TriggerInstanceStatus;
}

/** Hanh dong ghi vao audit. */
export type ComposioV118TriggerAuditAction =
  | 'register'
  | 'enable'
  | 'disable'
  | 'delete'
  | 'fired'
  | 'error';

export const COMPOSIO_V118_TRIGGER_AUDIT_ACTIONS: readonly ComposioV118TriggerAuditAction[] = [
  'register',
  'enable',
  'disable',
  'delete',
  'fired',
  'error',
];

/** Mot dong audit trigger instance. */
export interface ComposioV118TriggerAuditEntry {
  id: string;
  triggerId: string;
  triggerSlug: string;
  action: ComposioV118TriggerAuditAction;
  reason: string;
  atMs: number;
}

function assertTriggerId(triggerId: string): void {
  if (typeof triggerId !== 'string' || triggerId.trim() === '') {
    throw new Error('triggerId must be a non-empty string');
  }
}

function assertConnectionId(connectionId: string): void {
  if (typeof connectionId !== 'string' || connectionId.trim() === '') {
    throw new Error('connectionId must be a non-empty string');
  }
}

/** Kiem tra mot instance co hop le khong (throw neu sai). */
export function validateComposioV118TriggerInstance(raw: unknown): ComposioV118TriggerInstance {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV118TriggerInstance must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['triggerId'] !== 'string' || (rec['triggerId'] as string).trim() === '') {
    throw new Error('triggerInstance.triggerId must be a non-empty string.');
  }
  if (!isValidComposioTriggerSlug(rec['triggerSlug'])) {
    throw new Error(`triggerInstance.triggerSlug is invalid: ${JSON.stringify(rec['triggerSlug'])}.`);
  }
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') {
    throw new Error('triggerInstance.toolkit must be a non-empty string.');
  }
  if (typeof rec['connectionId'] !== 'string' || (rec['connectionId'] as string).trim() === '') {
    throw new Error('triggerInstance.connectionId must be a non-empty string.');
  }
  if (typeof rec['label'] !== 'string' || (rec['label'] as string).trim() === '') {
    throw new Error('triggerInstance.label must be a non-empty string.');
  }
  if (rec['status'] !== 'enabled' && rec['status'] !== 'disabled') {
    throw new Error('triggerInstance.status must be enabled or disabled.');
  }
  for (const f of ['createdAtMs', 'updatedAtMs'] as const) {
    if (typeof rec[f] !== 'number' || !Number.isFinite(rec[f]) || (rec[f] as number) < 0) {
      throw new Error(`triggerInstance.${f} must be a non-negative number.`);
    }
  }
  if (rec['lastFiredAtMs'] !== null && (typeof rec['lastFiredAtMs'] !== 'number' || !Number.isFinite(rec['lastFiredAtMs']))) {
    throw new Error('triggerInstance.lastFiredAtMs must be null or a number.');
  }
  if (!Number.isInteger(rec['totalFired']) || (rec['totalFired'] as number) < 0) {
    throw new Error('triggerInstance.totalFired must be a non-negative integer.');
  }
  if (!Number.isInteger(rec['consecutiveErrors']) || (rec['consecutiveErrors'] as number) < 0) {
    throw new Error('triggerInstance.consecutiveErrors must be a non-negative integer.');
  }
  if (rec['lastError'] !== null && rec['lastError'] !== undefined && typeof rec['lastError'] !== 'string') {
    throw new Error('triggerInstance.lastError must be a string or null.');
  }
  if (rec['note'] !== undefined && typeof rec['note'] !== 'string') {
    throw new Error('triggerInstance.note must be a string when present.');
  }
  return {
    triggerId: rec['triggerId'] as string,
    triggerSlug: rec['triggerSlug'] as string,
    toolkit: rec['toolkit'] as string,
    connectionId: rec['connectionId'] as string,
    label: rec['label'] as string,
    status: rec['status'] as ComposioV118TriggerInstanceStatus,
    createdAtMs: rec['createdAtMs'] as number,
    updatedAtMs: rec['updatedAtMs'] as number,
    lastFiredAtMs: rec['lastFiredAtMs'] as number | null,
    totalFired: rec['totalFired'] as number,
    consecutiveErrors: rec['consecutiveErrors'] as number,
    lastError: typeof rec['lastError'] === 'string' ? rec['lastError'] : null,
    ...(typeof rec['note'] === 'string' ? { note: rec['note'] } : {}),
  };
}

/** Dang ky mot instance moi tu input toi thieu (ham thuan, chua luu). */
export function createComposioV118TriggerInstance(
  input: ComposioV118RegisterTriggerInput,
  nowMs: number = Date.now(),
): ComposioV118TriggerInstance {
  assertTriggerId(input.triggerId);
  if (!isValidComposioTriggerSlug(input.triggerSlug)) {
    throw new Error(`triggerSlug is invalid: ${JSON.stringify(input.triggerSlug)}.`);
  }
  if (typeof input.toolkit !== 'string' || input.toolkit.trim() === '') {
    throw new Error('toolkit must be a non-empty string');
  }
  assertConnectionId(input.connectionId);
  const label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim() : input.triggerSlug;
  const instance: ComposioV118TriggerInstance = {
    triggerId: input.triggerId.trim(),
    triggerSlug: input.triggerSlug,
    toolkit: input.toolkit.trim(),
    connectionId: input.connectionId.trim(),
    label,
    status: input.status ?? 'enabled',
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    lastFiredAtMs: null,
    totalFired: 0,
    consecutiveErrors: 0,
    lastError: null,
    ...(typeof input.note === 'string' && input.note.trim() !== '' ? { note: input.note.trim() } : {}),
  };
  return validateComposioV118TriggerInstance(instance);
}

/** Bat mot instance (ham thuan): status → enabled, doi updatedAtMs. */
export function enableComposioV118TriggerInstance(
  prev: ComposioV118TriggerInstance,
  nowMs: number = Date.now(),
): ComposioV118TriggerInstance {
  return validateComposioV118TriggerInstance({ ...prev, status: 'enabled', updatedAtMs: nowMs });
}

/** Tat mot instance (ham thuan): status → disabled, doi updatedAtMs. */
export function disableComposioV118TriggerInstance(
  prev: ComposioV118TriggerInstance,
  nowMs: number = Date.now(),
): ComposioV118TriggerInstance {
  return validateComposioV118TriggerInstance({ ...prev, status: 'disabled', updatedAtMs: nowMs });
}

/** Ghi mot lan fire thanh cong (ham thuan): tang totalFired, reset loi. */
export function recordComposioV118TriggerFired(
  prev: ComposioV118TriggerInstance,
  nowMs: number = Date.now(),
): ComposioV118TriggerInstance {
  return validateComposioV118TriggerInstance({
    ...prev,
    lastFiredAtMs: nowMs,
    totalFired: prev.totalFired + 1,
    consecutiveErrors: 0,
    lastError: null,
    updatedAtMs: nowMs,
  });
}

/** Ghi mot lan xu ly event bi loi (ham thuan): tang loi lien tiep. */
export function recordComposioV118TriggerError(
  prev: ComposioV118TriggerInstance,
  error: string,
  nowMs: number = Date.now(),
): ComposioV118TriggerInstance {
  return validateComposioV118TriggerInstance({
    ...prev,
    consecutiveErrors: prev.consecutiveErrors + 1,
    lastError: error.trim() === '' ? 'trigger error' : error.trim(),
    updatedAtMs: nowMs,
  });
}

/**
 * Suc khoe cua mot instance tai `nowMs`:
 * - error: loi lien tiep > 0 (xu ly event dang hong).
 * - healthy: da fire trong 24h qua.
 * - stale: da fire nhung da qua 24h (co the trigger ben Composio
 *   bi tat, hoac kenh im).
 * - silent: chua fire lan nao, hoac da qua 7 ngay.
 * Instance disabled van tinh health nhu tren (de UI thay ca instance
 * tat co dang fire khong).
 */
export function evaluateComposioV118TriggerHealth(
  instance: ComposioV118TriggerInstance,
  nowMs: number = Date.now(),
): ComposioV118TriggerHealth {
  if (instance.consecutiveErrors > 0) return 'error';
  if (instance.lastFiredAtMs === null) return 'silent';
  const age = nowMs - instance.lastFiredAtMs;
  if (age <= COMPOSIO_V118_STALE_AFTER_MS) return 'healthy';
  if (age <= COMPOSIO_V118_SILENT_AFTER_MS) return 'stale';
  return 'silent';
}

/** Tom tat mot instance cho UI (1 dong). */
export function summarizeComposioV118TriggerInstance(
  instance: ComposioV118TriggerInstance,
  nowMs: number = Date.now(),
): string {
  const health = evaluateComposioV118TriggerHealth(instance, nowMs);
  const lastFired = instance.lastFiredAtMs === null ? 'never' : new Date(instance.lastFiredAtMs).toISOString();
  return `${instance.label} (${instance.triggerSlug}, ${instance.status}, health ${health}): fired ${instance.totalFired} times, last ${lastFired}.`;
}

/** Filter khi liet ke instance. */
export interface ComposioV118TriggerInstanceFilter {
  toolkit?: string;
  triggerSlug?: string;
  connectionId?: string;
  status?: ComposioV118TriggerInstanceStatus;
  health?: ComposioV118TriggerHealth;
}

/** Loc instance theo filter (ham thuan). */
export function filterComposioV118TriggerInstances(
  instances: readonly ComposioV118TriggerInstance[],
  filter: ComposioV118TriggerInstanceFilter,
  nowMs: number = Date.now(),
): ComposioV118TriggerInstance[] {
  return instances.filter(
    (i) =>
      (filter.toolkit === undefined || i.toolkit === filter.toolkit) &&
      (filter.triggerSlug === undefined || i.triggerSlug === filter.triggerSlug) &&
      (filter.connectionId === undefined || i.connectionId === filter.connectionId) &&
      (filter.status === undefined || i.status === filter.status) &&
      (filter.health === undefined || evaluateComposioV118TriggerHealth(i, nowMs) === filter.health),
  );
}

/** Tom tat nhanh cho UI: dem theo status + health. */
export function summarizeComposioV118TriggerInstances(
  instances: readonly ComposioV118TriggerInstance[],
  nowMs: number = Date.now(),
): {
  total: number;
  enabled: number;
  disabled: number;
  healthy: number;
  stale: number;
  silent: number;
  error: number;
  totalFired: number;
  needsAttention: string[];
} {
  const summary = {
    total: instances.length,
    enabled: 0,
    disabled: 0,
    healthy: 0,
    stale: 0,
    silent: 0,
    error: 0,
    totalFired: 0,
    needsAttention: [] as string[],
  };
  for (const i of instances) {
    summary[i.status] += 1;
    summary[evaluateComposioV118TriggerHealth(i, nowMs)] += 1;
    summary.totalFired += i.totalFired;
    const health = evaluateComposioV118TriggerHealth(i, nowMs);
    if (health === 'error' || (health === 'silent' && i.status === 'enabled' && i.totalFired > 0)) {
      summary.needsAttention.push(i.triggerId);
    }
  }
  summary.needsAttention.sort();
  return summary;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** Tao mot dong audit (ham thuan). */
export function createComposioV118TriggerAuditEntry(
  triggerId: string,
  triggerSlug: string,
  action: ComposioV118TriggerAuditAction,
  reason: string,
  atMs: number = Date.now(),
): ComposioV118TriggerAuditEntry {
  assertTriggerId(triggerId);
  if (!isValidComposioTriggerSlug(triggerSlug)) {
    throw new Error(`triggerSlug is invalid: ${JSON.stringify(triggerSlug)}.`);
  }
  if (!COMPOSIO_V118_TRIGGER_AUDIT_ACTIONS.includes(action)) {
    throw new Error(`Unknown ComposioV118TriggerAuditAction: ${action}`);
  }
  return {
    id: `ti118-${crypto.randomUUID()}`,
    triggerId: triggerId.trim(),
    triggerSlug,
    action,
    reason: reason.trim() === '' ? action : reason.trim(),
    atMs,
  };
}

/** Kiem tra mot dong audit (throw neu sai). */
export function validateComposioV118TriggerAuditEntry(raw: unknown): ComposioV118TriggerAuditEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV118TriggerAuditEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || (rec['id'] as string).trim() === '') throw new Error('audit id must be a non-empty string.');
  if (typeof rec['triggerId'] !== 'string' || (rec['triggerId'] as string).trim() === '') throw new Error('audit triggerId must be a non-empty string.');
  if (!isValidComposioTriggerSlug(rec['triggerSlug'])) throw new Error('audit triggerSlug is invalid.');
  if (
    typeof rec['action'] !== 'string' ||
    !(COMPOSIO_V118_TRIGGER_AUDIT_ACTIONS as readonly string[]).includes(rec['action'])
  ) {
    throw new Error('audit action is invalid.');
  }
  if (typeof rec['reason'] !== 'string' || (rec['reason'] as string).trim() === '') throw new Error('audit reason must be a non-empty string.');
  if (typeof rec['atMs'] !== 'number' || !Number.isFinite(rec['atMs'])) throw new Error('audit atMs must be a number.');
  return {
    id: rec['id'] as string,
    triggerId: rec['triggerId'] as string,
    triggerSlug: rec['triggerSlug'] as string,
    action: rec['action'] as ComposioV118TriggerAuditAction,
    reason: rec['reason'] as string,
    atMs: rec['atMs'] as number,
  };
}

// ---------------------------------------------------------------------------
// Store — memory + JSON file (atomic, mode 0600) + audit JSONL
// ---------------------------------------------------------------------------

/** Interface store instance. */
export interface ComposioV118TriggerInstanceStore {
  register(input: ComposioV118RegisterTriggerInput, nowMs?: number): ComposioV118TriggerInstance;
  get(triggerId: string): ComposioV118TriggerInstance | undefined;
  list(filter?: ComposioV118TriggerInstanceFilter, nowMs?: number): ComposioV118TriggerInstance[];
  update(instance: ComposioV118TriggerInstance): ComposioV118TriggerInstance;
  remove(triggerId: string): boolean;
  clear(): void;
}

function cloneInstance(i: ComposioV118TriggerInstance): ComposioV118TriggerInstance {
  return JSON.parse(JSON.stringify(i)) as ComposioV118TriggerInstance;
}

/** Store trong bo nho — de test + host khong co userData dir. */
export class MemoryComposioV118TriggerInstanceStore implements ComposioV118TriggerInstanceStore {
  private readonly instances = new Map<string, ComposioV118TriggerInstance>();
  private readonly audit: ComposioV118TriggerAuditEntry[] = [];

  register(input: ComposioV118RegisterTriggerInput, nowMs: number = Date.now()): ComposioV118TriggerInstance {
    const instance = createComposioV118TriggerInstance(input, nowMs);
    if (this.instances.has(instance.triggerId)) {
      throw new Error(`duplicate trigger instance id: ${instance.triggerId}`);
    }
    if (this.instances.size >= COMPOSIO_V118_MAX_INSTANCES) {
      throw new Error(`too many trigger instances (max ${COMPOSIO_V118_MAX_INSTANCES})`);
    }
    this.instances.set(instance.triggerId, instance);
    this.audit.push(
      createComposioV118TriggerAuditEntry(instance.triggerId, instance.triggerSlug, 'register', 'registered by user', nowMs),
    );
    return cloneInstance(instance);
  }

  get(triggerId: string): ComposioV118TriggerInstance | undefined {
    const i = this.instances.get(triggerId);
    return i ? cloneInstance(i) : undefined;
  }

  list(filter: ComposioV118TriggerInstanceFilter = {}, nowMs: number = Date.now()): ComposioV118TriggerInstance[] {
    return filterComposioV118TriggerInstances([...this.instances.values()], filter, nowMs).map(cloneInstance);
  }

  update(instance: ComposioV118TriggerInstance): ComposioV118TriggerInstance {
    const valid = validateComposioV118TriggerInstance(instance);
    if (!this.instances.has(valid.triggerId)) throw new Error(`unknown trigger instance id: ${valid.triggerId}`);
    this.instances.set(valid.triggerId, valid);
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
  listAudit(limit?: number): ComposioV118TriggerAuditEntry[] {
    const reversed = [...this.audit].reverse();
    return limit !== undefined ? reversed.slice(0, Math.max(0, limit)) : reversed;
  }
}

/** Duong dan file instance. */
export function getComposioV118TriggerInstancesPath(dir: string): string {
  return path.join(dir, COMPOSIO_V118_TRIGGER_INSTANCES_FILE);
}

/** Duong dan file audit. */
export function getComposioV118TriggerInstanceAuditPath(dir: string): string {
  return path.join(dir, COMPOSIO_V118_TRIGGER_INSTANCE_AUDIT_FILE);
}

/** Store tren dia (file JSON + audit JSONL). */
export class JsonFileComposioV118TriggerInstanceStore implements ComposioV118TriggerInstanceStore {
  private readonly filePath: string;
  private readonly auditPath: string;

  constructor(dir: string) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('trigger instance store dir must be a non-empty string');
    }
    this.filePath = getComposioV118TriggerInstancesPath(dir);
    this.auditPath = getComposioV118TriggerInstanceAuditPath(dir);
  }

  /** Duong dan file dang dung (de UI/log hien). */
  get path(): string {
    return this.filePath;
  }

  private loadAllRaw(): ComposioV118TriggerInstance[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) throw new Error(`Invalid ${COMPOSIO_V118_TRIGGER_INSTANCES_FILE}: expected an array.`);
    return raw.map((entry) => validateComposioV118TriggerInstance(entry));
  }

  private saveAllRaw(instances: readonly ComposioV118TriggerInstance[]): void {
    for (const i of instances) validateComposioV118TriggerInstance(i);
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

  private appendAudit(entry: ComposioV118TriggerAuditEntry): void {
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
    fs.appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const lines = fs.readFileSync(this.auditPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    if (lines.length > COMPOSIO_V118_MAX_AUDIT_LINES) {
      const kept = lines.slice(-COMPOSIO_V118_MAX_AUDIT_LINES);
      const tmp = `${this.auditPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.auditPath);
    }
  }

  register(input: ComposioV118RegisterTriggerInput, nowMs: number = Date.now()): ComposioV118TriggerInstance {
    const instance = createComposioV118TriggerInstance(input, nowMs);
    const all = this.loadAllRaw();
    if (all.some((i) => i.triggerId === instance.triggerId)) {
      throw new Error(`duplicate trigger instance id: ${instance.triggerId}`);
    }
    if (all.length >= COMPOSIO_V118_MAX_INSTANCES) {
      throw new Error(`too many trigger instances (max ${COMPOSIO_V118_MAX_INSTANCES})`);
    }
    all.push(instance);
    this.saveAllRaw(all);
    this.appendAudit(
      createComposioV118TriggerAuditEntry(instance.triggerId, instance.triggerSlug, 'register', 'registered by user', nowMs),
    );
    return cloneInstance(instance);
  }

  get(triggerId: string): ComposioV118TriggerInstance | undefined {
    const i = this.loadAllRaw().find((x) => x.triggerId === triggerId);
    return i ? cloneInstance(i) : undefined;
  }

  list(filter: ComposioV118TriggerInstanceFilter = {}, nowMs: number = Date.now()): ComposioV118TriggerInstance[] {
    return filterComposioV118TriggerInstances(this.loadAllRaw(), filter, nowMs).map(cloneInstance);
  }

  update(instance: ComposioV118TriggerInstance): ComposioV118TriggerInstance {
    const valid = validateComposioV118TriggerInstance(instance);
    const all = this.loadAllRaw();
    const idx = all.findIndex((i) => i.triggerId === valid.triggerId);
    if (idx < 0) throw new Error(`unknown trigger instance id: ${valid.triggerId}`);
    all[idx] = valid;
    this.saveAllRaw(all);
    return cloneInstance(valid);
  }

  remove(triggerId: string): boolean {
    const all = this.loadAllRaw();
    const kept = all.filter((i) => i.triggerId !== triggerId);
    if (kept.length === all.length) return false;
    this.saveAllRaw(kept);
    return true;
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    if (fs.existsSync(this.auditPath)) fs.unlinkSync(this.auditPath);
  }

  /** Audit tren dia (moi nhat truoc). */
  listAudit(opts: { triggerId?: string; action?: ComposioV118TriggerAuditAction; limit?: number } = {}): ComposioV118TriggerAuditEntry[] {
    if (!fs.existsSync(this.auditPath)) return [];
    const lines = fs.readFileSync(this.auditPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const all = lines.map((line) => validateComposioV118TriggerAuditEntry(JSON.parse(line) as unknown));
    const filtered = all.filter(
      (e) => (opts.triggerId === undefined || e.triggerId === opts.triggerId) && (opts.action === undefined || e.action === opts.action),
    );
    const reversed = filtered.reverse();
    return opts.limit !== undefined ? reversed.slice(0, Math.max(0, opts.limit)) : reversed;
  }
}
