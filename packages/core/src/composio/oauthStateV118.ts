/**
 * Composio OAuth state machine v1.18 (v1.18, Doi T4).
 *
 * Tang tren `connectionLifecycle.ts` (v111: vong doi connection
 * active/initiated/disconnected/reconnecting/failed) — tang do lo
 * ket noi/tat/moi lai o muc toolkit. Tang nay lo OAUTH TOKEN cua
 * tung connection: token co han su dung, co the het han, bi thu hoi
 * (revoked) ben phia app (user doi mat khau / thu hoi quyen trong
 * Google/GitHub...), va Composio managed auth se refresh token khi
 * can. Open-bot KHONG bao gio thay token that: state machine nay
 * chi giu TRANG THAI + thoi gian het han + so lan refresh, khong
 * giu token; viec refresh that do Composio lam (qua session/router),
 * o day host tiem mot ham `refresh` mock de test + de host that
 * noi vao sau.
 *
 * Trang thai:
 * - `connected` — token con han, dung duoc.
 * - `connecting` — dang cho user hoan tat OAuth (Composio Connect
 *   Link mo tren trinh duyet) hoac dang doi Composio xac nhan.
 * - `refreshing` — token sap het han / vua het han, dang refresh.
 * - `expired` — token het han, refresh chua chay hoac da that bai
 *   (co the thu lai).
 * - `revoked` — app ben kia thu hoi quyen (hoac user ngat ket noi
 *   ben Composio): KHONG tu refresh duoc, user phai ket noi lai tu
 *   dau. Trang thai cuoi — chi co `reconnect` (ket noi moi) moi
 *   thoat duoc.
 *
 * Chuyen trang thai hop le (may trang thai — chuyen sai thi throw,
 * khong lang le doi):
 *   connecting -> connected | expired | revoked
 *   connected -> refreshing | expired | revoked
 *   refreshing -> connected | expired | revoked
 *   expired -> refreshing | revoked | connected (khi host bao token
 *     moi da co ma khong qua buoc refreshing — vd user ket noi lai
 *     nhanh ben Composio)
 *   revoked -> connecting (ket noi lai tu dau)
 * Moi chuyen trang thai deu ghi audit (trang thai cu -> moi, ly do,
 * thoi gian) — KHONG chua token.
 *
 * UI state: `composioV118OAuthUiState` tra ve nhan hien thi + mau
 * badge + hanh dong kha dung (connect / refresh / reconnect) de
 * Settings → Composio ve dung nut theo trang thai.
 */

import * as crypto from 'node:crypto';

/** Trang thai OAuth cua mot connection. */
export type ComposioV118OAuthState =
  | 'connected'
  | 'connecting'
  | 'expired'
  | 'revoked'
  | 'refreshing';

export const COMPOSIO_V118_OAUTH_STATES: readonly ComposioV118OAuthState[] = [
  'connected',
  'connecting',
  'expired',
  'revoked',
  'refreshing',
];

/**
 * Bang chuyen trang thai hop le. `revoked` la trang thai cuoi: chi
 * `connecting` (ket noi lai tu dau) moi thoat duoc — khong tu
 * refresh token da bi thu hoi.
 */
export const COMPOSIO_V118_OAUTH_TRANSITIONS: Readonly<Record<ComposioV118OAuthState, readonly ComposioV118OAuthState[]>> = {
  connecting: ['connected', 'expired', 'revoked'],
  connected: ['refreshing', 'expired', 'revoked'],
  refreshing: ['connected', 'expired', 'revoked'],
  expired: ['refreshing', 'revoked', 'connected'],
  revoked: ['connecting'],
};

/** So lan refresh tu dong toi da truoc khi dung o `expired` va cho user. */
export const COMPOSIO_V118_DEFAULT_MAX_AUTO_REFRESHES = 3;
/** Refresh truoc khi token het han bao lau (ms) — mac dinh 5 phut. */
export const COMPOSIO_V118_DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
/** Giu toi da tung nay dong audit moi connection. */
export const COMPOSIO_V118_MAX_OAUTH_AUDIT_ENTRIES = 200;

/** true khi chuyen tu `from` sang `to` la hop le. */
export function isComposioV118OAuthTransitionAllowed(from: ComposioV118OAuthState, to: ComposioV118OAuthState): boolean {
  return (COMPOSIO_V118_OAUTH_TRANSITIONS[from] as readonly ComposioV118OAuthState[]).includes(to);
}

/** Trang thai OAuth cua mot connection (khong chua token). */
export interface ComposioV118OAuthEntry {
  /** Id connection Composio. */
  connectionId: string;
  /** Slug toolkit. */
  toolkit: string;
  /** Trang thai hien tai. */
  state: ComposioV118OAuthState;
  /** ms epoch token het han (null = khong biet han — vd app khong bao han). */
  expiresAtMs: number | null;
  /** ms epoch lan doi trang thai cuoi. */
  updatedAtMs: number;
  /** So lan refresh tu dong da thu trong chuoi hien tai. */
  autoRefreshAttempts: number;
  /** Ly do cua lan doi trang thai cuoi. */
  lastReason: string | null;
  /** Nhan tai khoan (neu co) — de UI hien dung tai khoan nao. */
  accountLabel?: string;
}

/** Mot dong audit chuyen trang thai OAuth. */
export interface ComposioV118OAuthAuditEntry {
  id: string;
  connectionId: string;
  toolkit: string;
  from: ComposioV118OAuthState;
  to: ComposioV118OAuthState;
  reason: string;
  atMs: number;
}

/** Tao entry moi (mac dinh `connecting` — user vua bam Connect). */
export function createComposioV118OAuthEntry(
  connectionId: string,
  toolkit: string,
  opts: { state?: ComposioV118OAuthState; expiresAtMs?: number | null; accountLabel?: string; nowMs?: number } = {},
): ComposioV118OAuthEntry {
  if (typeof connectionId !== 'string' || connectionId.trim() === '') {
    throw new Error('connectionId must be a non-empty string');
  }
  if (typeof toolkit !== 'string' || toolkit.trim() === '') {
    throw new Error('toolkit must be a non-empty string');
  }
  const state = opts.state ?? 'connecting';
  if (!COMPOSIO_V118_OAUTH_STATES.includes(state)) throw new Error(`Unknown ComposioV118OAuthState: ${state}`);
  const nowMs = opts.nowMs ?? Date.now();
  return {
    connectionId: connectionId.trim(),
    toolkit: toolkit.trim(),
    state,
    expiresAtMs: opts.expiresAtMs ?? null,
    updatedAtMs: nowMs,
    autoRefreshAttempts: 0,
    lastReason: 'created',
    ...(typeof opts.accountLabel === 'string' && opts.accountLabel !== '' ? { accountLabel: opts.accountLabel } : {}),
  };
}

/** Kiem tra mot entry (throw neu sai). */
export function validateComposioV118OAuthEntry(raw: unknown): ComposioV118OAuthEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV118OAuthEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['connectionId'] !== 'string' || (rec['connectionId'] as string).trim() === '') {
    throw new Error('oauthEntry.connectionId must be a non-empty string.');
  }
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') {
    throw new Error('oauthEntry.toolkit must be a non-empty string.');
  }
  if (typeof rec['state'] !== 'string' || !(COMPOSIO_V118_OAUTH_STATES as readonly string[]).includes(rec['state'])) {
    throw new Error('oauthEntry.state is invalid.');
  }
  if (rec['expiresAtMs'] !== null && (typeof rec['expiresAtMs'] !== 'number' || !Number.isFinite(rec['expiresAtMs']))) {
    throw new Error('oauthEntry.expiresAtMs must be null or a number.');
  }
  if (typeof rec['updatedAtMs'] !== 'number' || !Number.isFinite(rec['updatedAtMs'])) {
    throw new Error('oauthEntry.updatedAtMs must be a number.');
  }
  if (!Number.isInteger(rec['autoRefreshAttempts']) || (rec['autoRefreshAttempts'] as number) < 0) {
    throw new Error('oauthEntry.autoRefreshAttempts must be a non-negative integer.');
  }
  if (rec['lastReason'] !== null && rec['lastReason'] !== undefined && typeof rec['lastReason'] !== 'string') {
    throw new Error('oauthEntry.lastReason must be a string or null.');
  }
  if (rec['accountLabel'] !== undefined && typeof rec['accountLabel'] !== 'string') {
    throw new Error('oauthEntry.accountLabel must be a string when present.');
  }
  return {
    connectionId: rec['connectionId'] as string,
    toolkit: rec['toolkit'] as string,
    state: rec['state'] as ComposioV118OAuthState,
    expiresAtMs: rec['expiresAtMs'] as number | null,
    updatedAtMs: rec['updatedAtMs'] as number,
    autoRefreshAttempts: rec['autoRefreshAttempts'] as number,
    lastReason: typeof rec['lastReason'] === 'string' ? rec['lastReason'] : null,
    ...(typeof rec['accountLabel'] === 'string' ? { accountLabel: rec['accountLabel'] } : {}),
  };
}

/**
 * Chuyen trang thai (ham thuan): throw khi chuyen khong hop le
 * (vd revoked -> connected truc tiep). Tra entry moi + dong audit.
 * Chuyen sang `connected` thi reset dem refresh; chuyen khoi
 * `refreshing` ma khong ve `connected` thi giu nguyen dem.
 */
export function transitionComposioV118OAuth(
  prev: ComposioV118OAuthEntry,
  to: ComposioV118OAuthState,
  reason: string,
  opts: { nowMs?: number; expiresAtMs?: number | null } = {},
): { entry: ComposioV118OAuthEntry; audit: ComposioV118OAuthAuditEntry } {
  const entry = validateComposioV118OAuthEntry(prev);
  if (!isComposioV118OAuthTransitionAllowed(entry.state, to)) {
    throw new Error(`Invalid OAuth transition: ${entry.state} -> ${to} (revoked can only go back to connecting).`);
  }
  const nowMs = opts.nowMs ?? Date.now();
  const next: ComposioV118OAuthEntry = {
    ...entry,
    state: to,
    expiresAtMs: opts.expiresAtMs !== undefined ? opts.expiresAtMs : entry.expiresAtMs,
    updatedAtMs: nowMs,
    autoRefreshAttempts: to === 'connected' ? 0 : entry.autoRefreshAttempts,
    lastReason: reason.trim() === '' ? `${entry.state} -> ${to}` : reason.trim(),
  };
  const audit: ComposioV118OAuthAuditEntry = {
    id: `oauth118-${crypto.randomUUID()}`,
    connectionId: entry.connectionId,
    toolkit: entry.toolkit,
    from: entry.state,
    to,
    reason: next.lastReason ?? `${entry.state} -> ${to}`,
    atMs: nowMs,
  };
  return { entry: validateComposioV118OAuthEntry(next), audit };
}

/**
 * Token co sap het han khong: con han nhung trong vong
 * `refreshBeforeMs` nua la het (mac dinh 5 phut). `null` (khong
 * biet han) thi tra false — khong doan.
 */
export function isComposioV118TokenExpiringSoon(
  entry: ComposioV118OAuthEntry,
  nowMs: number = Date.now(),
  refreshBeforeMs: number = COMPOSIO_V118_DEFAULT_REFRESH_BEFORE_EXPIRY_MS,
): boolean {
  if (entry.expiresAtMs === null) return false;
  return entry.expiresAtMs > nowMs && entry.expiresAtMs - nowMs <= refreshBeforeMs;
}

/** Token da het han chua (theo dong ho caller truyen vao). */
export function isComposioV118TokenExpired(entry: ComposioV118OAuthEntry, nowMs: number = Date.now()): boolean {
  return entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs;
}

/**
 * Quyet dinh co nen tu dong refresh khong (ham thuan, fail-closed):
 * - Chi khi state la `connected` + sap het han, hoac `expired`.
 * - `refreshing`/`connecting` → khong (dang co luong chay roi).
 * - `revoked` → khong bao gio (token da bi thu hoi).
 * - Het luot auto-refresh (mac dinh 3) → khong, cho user.
 */
export function decideComposioV118AutoRefresh(
  entry: ComposioV118OAuthEntry,
  nowMs: number = Date.now(),
  opts: { maxAutoRefreshes?: number; refreshBeforeMs?: number } = {},
): { allowed: boolean; reason: string } {
  const max = opts.maxAutoRefreshes ?? COMPOSIO_V118_DEFAULT_MAX_AUTO_REFRESHES;
  if (entry.state === 'revoked') {
    return { allowed: false, reason: 'token revoked — user must reconnect from scratch' };
  }
  if (entry.state === 'refreshing' || entry.state === 'connecting') {
    return { allowed: false, reason: `already ${entry.state} — no parallel refresh` };
  }
  if (entry.autoRefreshAttempts >= max) {
    return { allowed: false, reason: `auto-refresh budget exhausted (${entry.autoRefreshAttempts}/${max}) — waiting for the user` };
  }
  if (entry.state === 'expired' || isComposioV118TokenExpired(entry, nowMs)) {
    return { allowed: true, reason: 'token expired — auto-refresh now' };
  }
  if (entry.state === 'connected' && isComposioV118TokenExpiringSoon(entry, nowMs, opts.refreshBeforeMs)) {
    return { allowed: true, reason: 'token expiring soon — auto-refresh now' };
  }
  return { allowed: false, reason: 'token still valid — no refresh needed' };
}

/** Ket qua refresh (mock): token moi co han moi hay that bai. */
export type ComposioV118RefreshResult =
  | { ok: true; expiresAtMs: number | null }
  | { ok: false; error: string; revoked?: boolean };

/** Ham refresh do host tiem: chay refresh that (Composio) hoac mock (test). */
export type ComposioV118RefreshFn = (entry: ComposioV118OAuthEntry) => Promise<ComposioV118RefreshResult>;

/**
 * Chay mot luot auto-refresh (async): kiem tra quyet dinh truoc,
 * chuyen sang `refreshing`, goi ham refresh do host tiem, roi
 * chuyen ve `connected` (thanh cong, reset dem + han moi) hoac
 * `expired` (that bai thuong — dem +1) hoac `revoked` (ben kia thu
 * hoi token). Tra entry moi + tat ca dong audit da ghi. Khong bao
 * gio nem (loi khong luong truoc thi ve `expired`).
 */
export async function autoRefreshComposioV118OAuth(
  prev: ComposioV118OAuthEntry,
  refresh: ComposioV118RefreshFn,
  nowMs: number = Date.now(),
  opts: { maxAutoRefreshes?: number; refreshBeforeMs?: number } = {},
): Promise<{ entry: ComposioV118OAuthEntry; audits: ComposioV118OAuthAuditEntry[] }> {
  const entry = validateComposioV118OAuthEntry(prev);
  const decision = decideComposioV118AutoRefresh(entry, nowMs, opts);
  if (!decision.allowed) {
    return { entry, audits: [] };
  }
  const audits: ComposioV118OAuthAuditEntry[] = [];
  const started = transitionComposioV118OAuth(entry, 'refreshing', decision.reason, { nowMs });
  audits.push(started.audit);
  let result: ComposioV118RefreshResult;
  try {
    result = await refresh(started.entry);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.ok) {
    const done = transitionComposioV118OAuth(started.entry, 'connected', 'token refreshed', {
      nowMs,
      expiresAtMs: result.expiresAtMs,
    });
    audits.push(done.audit);
    return { entry: done.entry, audits };
  }
  if (result.revoked === true) {
    const done = transitionComposioV118OAuth(started.entry, 'revoked', `token revoked during refresh: ${result.error}`, { nowMs });
    audits.push(done.audit);
    return { entry: done.entry, audits };
  }
  const failed: ComposioV118OAuthEntry = {
    ...started.entry,
    autoRefreshAttempts: started.entry.autoRefreshAttempts + 1,
  };
  const done = transitionComposioV118OAuth(failed, 'expired', `refresh failed: ${result.error}`, { nowMs });
  audits.push(done.audit);
  return { entry: done.entry, audits };
}

/**
 * Dong bo han token tu session that (ham thuan): token het han ma
 * state van `connected` → chuyen `expired` (de auto-refresh co co
 * hoi); token con han ma state `expired` → ve `connected` (vd user
 * vua ket noi lai ben Composio). `revoked`/`connecting`/`refreshing`
 * khong bi dong bo nay doi.
 */
export function syncComposioV118OAuthExpiry(
  prev: ComposioV118OAuthEntry,
  nowMs: number = Date.now(),
): { entry: ComposioV118OAuthEntry; audit: ComposioV118OAuthAuditEntry | null } {
  const entry = validateComposioV118OAuthEntry(prev);
  if (entry.state === 'connected' && isComposioV118TokenExpired(entry, nowMs)) {
    const { entry: next, audit } = transitionComposioV118OAuth(entry, 'expired', 'token expired (expiry sync)', { nowMs });
    return { entry: next, audit };
  }
  if (entry.state === 'expired' && !isComposioV118TokenExpired(entry, nowMs) && entry.expiresAtMs !== null) {
    const { entry: next, audit } = transitionComposioV118OAuth(entry, 'connected', 'token valid again (expiry sync)', { nowMs });
    return { entry: next, audit };
  }
  return { entry, audit: null };
}

// ---------------------------------------------------------------------------
// UI state — Settings → Composio ve theo trang thai
// ---------------------------------------------------------------------------

/** Hanh dong UI kha dung theo trang thai OAuth. */
export type ComposioV118OAuthUiAction = 'connect' | 'refresh' | 'reconnect' | 'none';

/** Trang thai hien thi cho UI (nhan + mau badge + nut). */
export interface ComposioV118OAuthUiState {
  connectionId: string;
  toolkit: string;
  state: ComposioV118OAuthState;
  /** Nhan hien thi (key i18n o UI: composioV118.oauth.<state>). */
  labelKey: string;
  /** Mau badge: green | amber | red | grey | blue. */
  badge: 'green' | 'amber' | 'red' | 'grey' | 'blue';
  /** Nut chinh UI nen hien. */
  action: ComposioV118OAuthUiAction;
  /** true khi token sap het han (UI hien canh bao nhe). */
  expiringSoon: boolean;
  /** true khi user can lam gi do (het han / bi thu hoi / het luot refresh). */
  needsAttention: boolean;
  /** Ghi chu 1 dong cho UI (khong chua token). */
  note: string;
}

/** Tinh UI state tu entry OAuth (ham thuan). */
export function composioV118OAuthUiState(
  entry: ComposioV118OAuthEntry,
  nowMs: number = Date.now(),
  opts: { maxAutoRefreshes?: number } = {},
): ComposioV118OAuthUiState {
  const expiringSoon = isComposioV118TokenExpiringSoon(entry, nowMs);
  const base = {
    connectionId: entry.connectionId,
    toolkit: entry.toolkit,
    state: entry.state,
    expiringSoon,
  };
  switch (entry.state) {
    case 'connected':
      return {
        ...base,
        labelKey: 'composioV118.oauth.connected',
        badge: expiringSoon ? 'amber' : 'green',
        action: expiringSoon ? 'refresh' : 'none',
        needsAttention: false,
        note: expiringSoon ? 'Token expiring soon — refresh available.' : 'Connected — token valid.',
      };
    case 'connecting':
      return {
        ...base,
        labelKey: 'composioV118.oauth.connecting',
        badge: 'blue',
        action: 'none',
        needsAttention: false,
        note: 'Waiting for the user to finish connecting.',
      };
    case 'refreshing':
      return {
        ...base,
        labelKey: 'composioV118.oauth.refreshing',
        badge: 'blue',
        action: 'none',
        needsAttention: false,
        note: 'Refreshing the token…',
      };
    case 'expired': {
      const outOfBudget =
        entry.autoRefreshAttempts >= (opts.maxAutoRefreshes ?? COMPOSIO_V118_DEFAULT_MAX_AUTO_REFRESHES);
      return {
        ...base,
        labelKey: 'composioV118.oauth.expired',
        badge: 'amber',
        action: outOfBudget ? 'reconnect' : 'refresh',
        needsAttention: true,
        note: outOfBudget ? 'Auto-refresh budget exhausted — reconnect to continue.' : 'Token expired — refresh to continue.',
      };
    }
    case 'revoked':
      return {
        ...base,
        labelKey: 'composioV118.oauth.revoked',
        badge: 'red',
        action: 'reconnect',
        needsAttention: true,
        note: 'Access revoked by the app — reconnect from scratch.',
      };
  }
}

/** Tom tat nhieu connection cho UI: dem theo state + ai can chu y. */
export function summarizeComposioV118OAuth(
  entries: readonly ComposioV118OAuthEntry[],
  nowMs: number = Date.now(),
): {
  total: number;
  connected: number;
  connecting: number;
  expired: number;
  revoked: number;
  refreshing: number;
  needsAttention: string[];
} {
  const summary = {
    total: entries.length,
    connected: 0,
    connecting: 0,
    expired: 0,
    revoked: 0,
    refreshing: 0,
    needsAttention: [] as string[],
  };
  for (const e of entries) {
    summary[e.state] += 1;
    const ui = composioV118OAuthUiState(e, nowMs);
    if (ui.needsAttention) summary.needsAttention.push(e.connectionId);
  }
  summary.needsAttention.sort();
  return summary;
}
