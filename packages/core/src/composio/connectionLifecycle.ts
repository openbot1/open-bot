/**
 * Composio connection lifecycle v1.11 — list / disconnect / reconnect
 * (v1.11, Đội T6).
 *
 * Tầng trên của `toolkitConnections.ts` (enable/disable + health check
 * từng toolkit) và `executors.ts` (trạng thái connection trong session).
 * Module này quản lý VÒNG ĐỜI kết nối của một toolkit: một connection
 * đang `active` có thể bị ngắt (`disconnect`), rồi nối lại
 * (`reconnect`) với backoff tăng dần; mọi chuyển đổi đều ghi audit
 * để UI/Settings thấy "ai ngắt cái gì, lúc nào, vì sao".
 *
 * Quy tắc (hướng đứng — local-first, không cloud tự ý):
 * - Module này KHÔNG gọi Composio và KHÔNG thấy key: trạng thái thật
 *   (`active`/`initiated`/`none`) do host cung cấp qua fetcher được
 *   inject (production: kết quả `COMPOSIO_MANAGE_CONNECTIONS` của
 *   router; test: stub). Disconnect/reconnect ở đây chỉ là quyết
 *   định + ghi trạng thái local; việc gọi API thật do host làm sau
 *   khi user bấm — giống cách toolkitConnections làm với health.
 * - Disconnect là hành động của USER (bấm nút trong Settings →
 *   Composio): connection bị ngắt không tự nối lại cho tới khi user
 *   bấm reconnect (không auto-reconnect sau disconnect tay).
 * - Reconnect tự động CHỈ sau lỗi tạm thời (poll/health fail): tối
 *   đa N lần trong một cửa sổ, backoff tăng dần; hết lượt thì dừng
 *   ở `failed` và chờ user — không retry vô hạn.
 * - Audit log: `<userData>/composio-connection-audit-v111.jsonl` —
 *   append từng dòng JSON (connect / disconnect / reconnect /
 *   reconnect-failed / auto-reconnect), giữ tối đa N dòng mới nhất.
 *   Audit KHÔNG chứa key/token/user id — chỉ toolkit + hành động +
 *   lý do + thời gian.
 * - Trạng thái lifecycle bền trong
 *   `<userData>/composio-connections-v111.json` (atomic tmp + rename,
 *   mode 0600): mỗi toolkit một entry (status, lần đổi cuối, số lần
 *   reconnect đã thử, có phải disconnect tay không).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMPOSIO_TOOLKIT_SLUGS } from './toolkits';
import { ComposioError } from './types';
import type { ComposioConnectionStatus } from './types';

/** File trạng thái lifecycle trong thư mục userData/composio. */
export const COMPOSIO_V111_CONNECTIONS_FILE = 'composio-connections-v111.json';
/** File audit log lifecycle (JSONL, append). */
export const COMPOSIO_V111_CONNECTION_AUDIT_FILE = 'composio-connection-audit-v111.jsonl';
/** Số lần reconnect tối đa trong một cửa sổ trước khi dừng. */
export const COMPOSIO_V111_DEFAULT_MAX_RECONNECTS = 3;
/** Cửa sổ đếm reconnect (ms). */
export const COMPOSIO_V111_DEFAULT_RECONNECT_WINDOW_MS = 15 * 60 * 1000;
/** Backoff cơ số giữa các lần reconnect (ms). */
export const COMPOSIO_V111_DEFAULT_RECONNECT_BASE_BACKOFF_MS = 10_000;
/** Backoff tối đa giữa các lần reconnect (ms). */
export const COMPOSIO_V111_DEFAULT_RECONNECT_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Giữ tối đa từng này dòng audit. */
export const COMPOSIO_V111_MAX_AUDIT_LINES = 500;
/** Giữ tối đa từng này entry toolkit trong file trạng thái. */
export const COMPOSIO_V111_MAX_TRACKED_TOOLKITS = 200;

/** Trạng thái vòng đời của một connection (rộng hơn status session). */
export type ComposioV111LifecycleStatus =
  | 'active'
  | 'initiated'
  | 'disconnected'
  | 'reconnecting'
  | 'failed';

export const COMPOSIO_V111_LIFECYCLE_STATUSES: readonly ComposioV111LifecycleStatus[] = [
  'active',
  'initiated',
  'disconnected',
  'reconnecting',
  'failed',
];

/** Một entry lifecycle của một toolkit. */
export interface ComposioV111ConnectionEntry {
  toolkit: string;
  /** Trạng thái vòng đời (suy ra từ status session + hành động user). */
  status: ComposioV111LifecycleStatus;
  /** Trạng thái connection thật trong session (do host báo). */
  sessionStatus: ComposioConnectionStatus;
  /** Nhãn tài khoản đã kết nối (chỉ khi active). */
  accountLabel?: string;
  /** true khi user tự tay disconnect — không auto-reconnect. */
  disconnectedByUser: boolean;
  /** ms epoch lần đổi trạng thái cuối. */
  updatedAtMs: number;
  /** Các lần reconnect đã thử trong cửa sổ hiện tại (epoch ms). */
  reconnectAttemptsMs: number[];
  /** Lý do của lần đổi trạng thái cuối (vd 'user disconnected'). */
  lastReason: string | null;
}

/** Hành động lifecycle ghi vào audit. */
export type ComposioV111AuditAction =
  | 'connect'
  | 'disconnect'
  | 'reconnect'
  | 'reconnect-failed'
  | 'auto-reconnect'
  | 'status-sync';

export const COMPOSIO_V111_AUDIT_ACTIONS: readonly ComposioV111AuditAction[] = [
  'connect',
  'disconnect',
  'reconnect',
  'reconnect-failed',
  'auto-reconnect',
  'status-sync',
];

/** Một dòng audit lifecycle. */
export interface ComposioV111ConnectionAuditEntry {
  id: string;
  toolkit: string;
  action: ComposioV111AuditAction;
  /** Trạng thái sau hành động. */
  status: ComposioV111LifecycleStatus;
  reason: string;
  atMs: number;
}

/** Chính sách reconnect. */
export interface ComposioV111ReconnectPolicy {
  maxReconnects: number;
  windowMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_COMPOSIO_V111_RECONNECT_POLICY: ComposioV111ReconnectPolicy = {
  maxReconnects: COMPOSIO_V111_DEFAULT_MAX_RECONNECTS,
  windowMs: COMPOSIO_V111_DEFAULT_RECONNECT_WINDOW_MS,
  baseBackoffMs: COMPOSIO_V111_DEFAULT_RECONNECT_BASE_BACKOFF_MS,
  maxBackoffMs: COMPOSIO_V111_DEFAULT_RECONNECT_MAX_BACKOFF_MS,
};

/** Kết quả quyết định reconnect (hàm thuần). */
export interface ComposioV111ReconnectDecision {
  allowed: boolean;
  /** ms nên đợi trước khi reconnect (0 = ngay). */
  delayMs: number;
  /** Số lần reconnect đã thử trong cửa sổ. */
  attemptsInWindow: number;
  reason: string;
}

function isKnownToolkit(toolkit: string): boolean {
  return (COMPOSIO_TOOLKIT_SLUGS as readonly string[]).includes(toolkit);
}

/** Toolkit có được quản lý lifecycle không: 40 toolkit live + 6 mock v110 + 6 mock v111. */
export function isComposioV111ManagedToolkit(toolkit: string): boolean {
  if (isKnownToolkit(toolkit)) return true;
  const mock = ['figma', 'supabase', 'vercel', 'todoist', 'intercom', 'miro', 'sentry', 'datadog', 'posthog', 'snowflake', 'amplitude', 'mixpanel'];
  return mock.includes(toolkit);
}

function assertManagedToolkit(toolkit: string): void {
  if (typeof toolkit !== 'string' || toolkit.trim() === '') {
    throw new ComposioError('composio_unknown_toolkit', 'Toolkit slug must be a non-empty string.');
  }
  if (!isComposioV111ManagedToolkit(toolkit.trim())) {
    throw new ComposioError('composio_unknown_toolkit', `Unknown Composio toolkit: ${toolkit}`);
  }
}

/** Backoff tăng dần: base * 2^attempt, chặn trên max. */
export function composioV111ReconnectBackoffMs(policy: ComposioV111ReconnectPolicy, attempt: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** safeAttempt);
}

export function emptyComposioV111ConnectionEntry(
  toolkit: string,
  sessionStatus: ComposioConnectionStatus = 'none',
  nowMs: number = Date.now(),
): ComposioV111ConnectionEntry {
  assertManagedToolkit(toolkit);
  return {
    toolkit: toolkit.trim(),
    status: sessionStatus === 'active' ? 'active' : sessionStatus === 'initiated' ? 'initiated' : 'disconnected',
    sessionStatus,
    disconnectedByUser: false,
    updatedAtMs: nowMs,
    reconnectAttemptsMs: [],
    lastReason: null,
  };
}

export function validateComposioV111ConnectionEntry(raw: unknown): ComposioV111ConnectionEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV111ConnectionEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') {
    throw new Error('ComposioV111ConnectionEntry.toolkit must be a non-empty string.');
  }
  if (typeof rec['status'] !== 'string' || !(COMPOSIO_V111_LIFECYCLE_STATUSES as readonly string[]).includes(rec['status'])) {
    throw new Error('ComposioV111ConnectionEntry.status is invalid.');
  }
  if (typeof rec['sessionStatus'] !== 'string' || !['active', 'initiated', 'none'].includes(rec['sessionStatus'])) {
    throw new Error('ComposioV111ConnectionEntry.sessionStatus is invalid.');
  }
  if (typeof rec['disconnectedByUser'] !== 'boolean') {
    throw new Error('ComposioV111ConnectionEntry.disconnectedByUser must be a boolean.');
  }
  if (typeof rec['updatedAtMs'] !== 'number' || !Number.isFinite(rec['updatedAtMs'])) {
    throw new Error('ComposioV111ConnectionEntry.updatedAtMs must be a number.');
  }
  if (!Array.isArray(rec['reconnectAttemptsMs']) || rec['reconnectAttemptsMs'].some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('ComposioV111ConnectionEntry.reconnectAttemptsMs must be an array of numbers.');
  }
  if (rec['accountLabel'] !== undefined && typeof rec['accountLabel'] !== 'string') {
    throw new Error('ComposioV111ConnectionEntry.accountLabel must be a string when present.');
  }
  if (rec['lastReason'] !== null && rec['lastReason'] !== undefined && typeof rec['lastReason'] !== 'string') {
    throw new Error('ComposioV111ConnectionEntry.lastReason must be a string or null.');
  }
  return {
    toolkit: rec['toolkit'] as string,
    status: rec['status'] as ComposioV111LifecycleStatus,
    sessionStatus: rec['sessionStatus'] as ComposioConnectionStatus,
    ...(typeof rec['accountLabel'] === 'string' ? { accountLabel: rec['accountLabel'] } : {}),
    disconnectedByUser: rec['disconnectedByUser'] as boolean,
    updatedAtMs: rec['updatedAtMs'] as number,
    reconnectAttemptsMs: [...(rec['reconnectAttemptsMs'] as number[])],
    lastReason: typeof rec['lastReason'] === 'string' ? rec['lastReason'] : null,
  };
}

/**
 * Đồng bộ trạng thái session thật vào entry lifecycle (hàm thuần).
 * Session báo active → entry active (xoá cờ disconnect tay, reset
 * đếm reconnect). Session báo none trong khi entry active → entry
 * chuyển 'failed' khi không phải do user ngắt (để auto-reconnect
 * có cơ hội), giữ nguyên 'disconnected' khi user đã ngắt tay.
 */
export function syncComposioV111SessionStatus(
  prev: ComposioV111ConnectionEntry | undefined,
  toolkit: string,
  sessionStatus: ComposioConnectionStatus,
  accountLabel: string | undefined,
  nowMs: number = Date.now(),
): ComposioV111ConnectionEntry {
  const base = prev ?? emptyComposioV111ConnectionEntry(toolkit, sessionStatus, nowMs);
  if (sessionStatus === 'active') {
    return {
      ...base,
      status: 'active',
      sessionStatus,
      ...(accountLabel ? { accountLabel } : { accountLabel: undefined }),
      disconnectedByUser: false,
      updatedAtMs: nowMs,
      reconnectAttemptsMs: [],
      lastReason: 'session active',
    };
  }
  if (sessionStatus === 'initiated') {
    return { ...base, status: base.status === 'active' ? base.status : 'initiated', sessionStatus, updatedAtMs: nowMs, lastReason: 'session initiated' };
  }
  // session none
  if (base.disconnectedByUser) {
    return { ...base, status: 'disconnected', sessionStatus, updatedAtMs: nowMs, lastReason: base.lastReason ?? 'disconnected by user' };
  }
  if (base.status === 'active') {
    return { ...base, status: 'failed', sessionStatus, updatedAtMs: nowMs, lastReason: 'connection lost (session none)' };
  }
  return { ...base, status: base.status === 'failed' ? 'failed' : 'disconnected', sessionStatus, updatedAtMs: nowMs, lastReason: base.lastReason };
}

/**
 * User bấm disconnect (hàm thuần): entry → 'disconnected', cờ tay
 * bật, đếm reconnect reset (không auto-reconnect sau đó).
 */
export function disconnectComposioV111Connection(
  prev: ComposioV111ConnectionEntry | undefined,
  toolkit: string,
  reason: string,
  nowMs: number = Date.now(),
): ComposioV111ConnectionEntry {
  const base = prev ?? emptyComposioV111ConnectionEntry(toolkit, 'active', nowMs);
  return {
    ...base,
    status: 'disconnected',
    sessionStatus: 'none',
    accountLabel: undefined,
    disconnectedByUser: true,
    updatedAtMs: nowMs,
    reconnectAttemptsMs: [],
    lastReason: reason.trim() === '' ? 'disconnected by user' : reason.trim(),
  };
}

/**
 * User bấm reconnect (hàm thuần): entry → 'reconnecting', ghi một
 * lần thử vào cửa sổ đếm. Host gọi API thật sau đó rồi sync lại
 * bằng `syncComposioV111SessionStatus`.
 */
export function reconnectComposioV111Connection(
  prev: ComposioV111ConnectionEntry | undefined,
  toolkit: string,
  nowMs: number = Date.now(),
): ComposioV111ConnectionEntry {
  const base = prev ?? emptyComposioV111ConnectionEntry(toolkit, 'none', nowMs);
  return {
    ...base,
    status: 'reconnecting',
    disconnectedByUser: false,
    updatedAtMs: nowMs,
    reconnectAttemptsMs: [...base.reconnectAttemptsMs, nowMs],
    lastReason: 'reconnect requested by user',
  };
}

/**
 * Quyết định auto-reconnect sau lỗi tạm thời (hàm thuần, fail-closed):
 * - Entry disconnected-by-user → không bao giờ tự nối lại.
 * - Entry active/initiated/reconnecting → không cần reconnect.
 * - Entry failed/disconnected (không phải tay) → cho reconnect khi
 *   còn lượt trong cửa sổ; hết lượt thì từ chối, chờ user.
 */
export function decideComposioV111AutoReconnect(
  entry: ComposioV111ConnectionEntry,
  policy: Partial<ComposioV111ReconnectPolicy> = {},
  nowMs: number = Date.now(),
): ComposioV111ReconnectDecision {
  const p: ComposioV111ReconnectPolicy = { ...DEFAULT_COMPOSIO_V111_RECONNECT_POLICY, ...policy };
  if (entry.disconnectedByUser) {
    return { allowed: false, delayMs: 0, attemptsInWindow: 0, reason: 'disconnected by user — auto-reconnect disabled until the user reconnects' };
  }
  if (entry.status === 'active' || entry.status === 'initiated' || entry.status === 'reconnecting') {
    return { allowed: false, delayMs: 0, attemptsInWindow: 0, reason: `connection is ${entry.status} — no reconnect needed` };
  }
  const windowStart = nowMs - p.windowMs;
  const attempts = entry.reconnectAttemptsMs.filter((t) => t >= windowStart);
  if (attempts.length >= p.maxReconnects) {
    return {
      allowed: false,
      delayMs: 0,
      attemptsInWindow: attempts.length,
      reason: `reconnect budget exhausted (${attempts.length}/${p.maxReconnects} in ${Math.round(p.windowMs / 60000)}m) — waiting for the user`,
    };
  }
  return {
    allowed: true,
    delayMs: composioV111ReconnectBackoffMs(p, attempts.length),
    attemptsInWindow: attempts.length,
    reason: `auto-reconnect attempt ${attempts.length + 1}/${p.maxReconnects}`,
  };
}

// ---------------------------------------------------------------------------
// Audit log + durable store
// ---------------------------------------------------------------------------

export function createComposioV111AuditEntry(
  toolkit: string,
  action: ComposioV111AuditAction,
  status: ComposioV111LifecycleStatus,
  reason: string,
  atMs: number = Date.now(),
): ComposioV111ConnectionAuditEntry {
  assertManagedToolkit(toolkit);
  if (!COMPOSIO_V111_AUDIT_ACTIONS.includes(action)) throw new Error(`Unknown ComposioV111AuditAction: ${action}`);
  return {
    id: `ca111-${crypto.randomUUID()}`,
    toolkit: toolkit.trim(),
    action,
    status,
    reason: reason.trim() === '' ? action : reason.trim(),
    atMs,
  };
}

export function validateComposioV111AuditEntry(raw: unknown): ComposioV111ConnectionAuditEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV111ConnectionAuditEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || (rec['id'] as string).trim() === '') throw new Error('audit id must be a non-empty string.');
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') throw new Error('audit toolkit must be a non-empty string.');
  if (typeof rec['action'] !== 'string' || !(COMPOSIO_V111_AUDIT_ACTIONS as readonly string[]).includes(rec['action'])) {
    throw new Error('audit action is invalid.');
  }
  if (typeof rec['status'] !== 'string' || !(COMPOSIO_V111_LIFECYCLE_STATUSES as readonly string[]).includes(rec['status'])) {
    throw new Error('audit status is invalid.');
  }
  if (typeof rec['reason'] !== 'string' || (rec['reason'] as string).trim() === '') throw new Error('audit reason must be a non-empty string.');
  if (typeof rec['atMs'] !== 'number' || !Number.isFinite(rec['atMs'])) throw new Error('audit atMs must be a number.');
  return {
    id: rec['id'] as string,
    toolkit: rec['toolkit'] as string,
    action: rec['action'] as ComposioV111AuditAction,
    status: rec['status'] as ComposioV111LifecycleStatus,
    reason: rec['reason'] as string,
    atMs: rec['atMs'] as number,
  };
}

export function getComposioV111ConnectionsPath(dir: string): string {
  return path.join(dir, COMPOSIO_V111_CONNECTIONS_FILE);
}

export function getComposioV111AuditPath(dir: string): string {
  return path.join(dir, COMPOSIO_V111_CONNECTION_AUDIT_FILE);
}

export function loadComposioV111Connections(dir: string): ComposioV111ConnectionEntry[] {
  const file = getComposioV111ConnectionsPath(dir);
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`Invalid ${COMPOSIO_V111_CONNECTIONS_FILE}: expected an array.`);
  return raw.map((entry) => validateComposioV111ConnectionEntry(entry));
}

export function saveComposioV111Connections(dir: string, entries: ComposioV111ConnectionEntry[]): void {
  const file = getComposioV111ConnectionsPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  const trimmed = entries.slice(-COMPOSIO_V111_MAX_TRACKED_TOOLKITS);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows không có chmod unix — bỏ qua.
  }
}

export function appendComposioV111Audit(dir: string, entry: ComposioV111ConnectionAuditEntry): void {
  const file = getComposioV111AuditPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length > COMPOSIO_V111_MAX_AUDIT_LINES) {
    const kept = lines.slice(-COMPOSIO_V111_MAX_AUDIT_LINES);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

export function listComposioV111Audit(
  dir: string,
  opts: { toolkit?: string; action?: ComposioV111AuditAction; limit?: number } = {},
): ComposioV111ConnectionAuditEntry[] {
  const file = getComposioV111AuditPath(dir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const all = lines.map((line) => validateComposioV111AuditEntry(JSON.parse(line) as unknown));
  const filtered = all.filter(
    (e) => (opts.toolkit === undefined || e.toolkit === opts.toolkit) && (opts.action === undefined || e.action === opts.action),
  );
  const reversed = filtered.reverse();
  return opts.limit !== undefined ? reversed.slice(0, Math.max(0, opts.limit)) : reversed;
}

/** Tóm tắt connection cho UI Settings → Composio. */
export interface ComposioV111ConnectionSummary {
  total: number;
  active: number;
  initiated: number;
  disconnected: number;
  reconnecting: number;
  failed: number;
  /** Toolkit failed/disconnected-không-phải-tay cần user chú ý. */
  needsAttention: string[];
}

export function summarizeComposioV111Connections(entries: ComposioV111ConnectionEntry[]): ComposioV111ConnectionSummary {
  const summary: ComposioV111ConnectionSummary = {
    total: entries.length,
    active: 0,
    initiated: 0,
    disconnected: 0,
    reconnecting: 0,
    failed: 0,
    needsAttention: [],
  };
  for (const e of entries) {
    summary[e.status] += 1;
    if (e.status === 'failed' || (e.status === 'disconnected' && !e.disconnectedByUser)) {
      summary.needsAttention.push(e.toolkit);
    }
  }
  summary.needsAttention.sort();
  return summary;
}
