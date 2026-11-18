/**
 * Composio OAuth refresh v2 — lam moi token tu dong + fallback
 * (v1.19, Doi T4).
 *
 * Tang tren oauthStateV118.ts — KHONG viet lai:
 * - `ComposioV118OAuthEntry` van la state OAuth cua mot connection
 *   (connected/connecting/expired/revoked/refreshing + expiresAtMs
 *   + autoRefreshAttempts). V2 dung lai may trang thai do:
 *   connected → refreshing → connected (refresh ok) hoac expired
 *   (refresh het luot) hoac revoked (app ben kia thu hoi).
 * - `decideComposioV118AutoRefresh` van quyet dinh CO refresh
 *   khong theo han token; v2 them LOP THUC THI: goi ham refresh,
 *   retry co gioi han, xoay refresh token, fallback khi that bai.
 *
 * Moi trong v2:
 * 1. Refresh token trong Vault: namespace rieng
 *    `composio-oauth-refresh`, key = connectionId. Chi co refresh
 *    token moi ve may — access token KHONG BAO GIO ve may (no
 *    nam phia Composio managed auth). Ham getter chi tra boolean
 *    (has), KHONG tra gia tri; rotate chi xay ra khi server tra
 *    refresh token moi; thu hoi (revoked) thi xoa ngay khoi Vault.
 *    Module nay KHONG log token, KHONG dua token vao error.
 * 2. Refresh co retry gioi han: that bai thi thu lai toi da
 *    `maxAttempts` lan, moi lan cach nhau delay tang theo he so
 *    nhan (cap o maxDelayMs), co jitter tuy chon. Het luot thi
 *    entry → expired + `nextRetryAtMs` (lan thu lai o chu ky sau)
 *    + tang `consecutiveFailures` — khong retry vo han.
 * 3. Fallback khi refresh fail: sau `maxConsecutiveFailures` lan
 *    that bai lien tiep, entry danh dau `needsReconnect: true` —
 *    UI hien nut "Ket noi lai" thay vi tiep tuc refresh vo ich;
 *    user ket noi lai thi `resetComposioV119Refresh` xoa trang
 *    thai loi + xoa refresh token cu (neu con).
 * 4. Rotation: server tra refresh token moi thi luu de len token
 *    cu trong Vault (atomic theo Vault — ghi truoc, xoa sau
 *    khong can vi cung key); token cu khong con dung duoc nua.
 * 5. Audit: moi lan refresh (thanh cong/that bai/thu hoi/het
 *    luot) ghi 1 dong audit (khong chua token, chi connection +
 *    ket qua + so lan thu + thoi gian).
 *
 * Ham refresh that (`refreshFn`) do host tiem vao: trong app that
 * la loi goi Composio (qua session/router), trong test la mock.
 * Module nay KHONG goi mang truc tiep.
 */

import * as crypto from 'node:crypto';
import {
  COMPOSIO_V118_DEFAULT_MAX_AUTO_REFRESHES,
  COMPOSIO_V118_DEFAULT_REFRESH_BEFORE_EXPIRY_MS,
  transitionComposioV118OAuth,
  type ComposioV118OAuthEntry,
} from './oauthStateV118';

/** Vault namespace chua refresh token OAuth Composio (rieng, khong chung key API). */
export const COMPOSIO_V119_OAUTH_REFRESH_NAMESPACE = 'composio-oauth-refresh';
/** So lan refresh toi da moi chu ky (mac dinh — bang v118). */
export const COMPOSIO_V119_DEFAULT_MAX_REFRESH_ATTEMPTS = COMPOSIO_V118_DEFAULT_MAX_AUTO_REFRESHES;
/** Delay co so giua cac lan retry refresh (ms). */
export const COMPOSIO_V119_DEFAULT_REFRESH_RETRY_DELAY_MS = 5000;
/** He so nhan delay moi lan retry refresh. */
export const COMPOSIO_V119_DEFAULT_REFRESH_BACKOFF_MULTIPLIER = 2;
/** Delay retry refresh toi da (ms). */
export const COMPOSIO_V119_DEFAULT_MAX_REFRESH_RETRY_DELAY_MS = 5 * 60 * 1000;
/** Refresh truoc khi token het han bao lau (ms) — mac dinh 5 phut (bang v118). */
export const COMPOSIO_V119_DEFAULT_REFRESH_BEFORE_EXPIRY_MS = COMPOSIO_V118_DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
/** So lan that bai lien tiep thi danh dau can ket noi lai. */
export const COMPOSIO_V119_DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
/** Phan tram jitter ap len delay retry (0 = tat, de test xac dinh). */
export const COMPOSIO_V119_DEFAULT_REFRESH_JITTER_FRACTION = 0.1;
/** Giu toi da tung nay dong audit moi connection. */
export const COMPOSIO_V119_MAX_REFRESH_AUDIT_ENTRIES = 200;

/** Mat Vault toi thieu ma module nay can (Vault that thoa man). */
export interface ComposioV119RefreshTokenVault {
  getSecret(namespace: string, key: string): string | null;
  setSecret(namespace: string, key: string, value: string): void;
  deleteSecret(namespace: string, key: string): boolean;
  hasSecret(namespace: string, key: string): boolean;
}

/** Chinh sach refresh v2. */
export interface ComposioV119RefreshPolicy {
  /** So lan thu refresh toi da moi chu ky (bao gom lan dau). */
  maxAttempts: number;
  /** Delay co so giua cac lan retry (ms). */
  retryDelayMs: number;
  /** He so nhan delay moi lan retry. */
  backoffMultiplier: number;
  /** Delay retry toi da (ms). */
  maxRetryDelayMs: number;
  /** Refresh truoc khi token het han bao lau (ms). */
  refreshBeforeExpiryMs: number;
  /** So lan that bai lien tiep thi danh dau can ket noi lai. */
  maxConsecutiveFailures: number;
  /** Phan tram jitter ap len delay retry (0..0.5). */
  jitterFraction: number;
}

/** Chinh sach mac dinh cua refresh v2. */
export const DEFAULT_COMPOSIO_V119_REFRESH_POLICY: ComposioV119RefreshPolicy = {
  maxAttempts: COMPOSIO_V119_DEFAULT_MAX_REFRESH_ATTEMPTS,
  retryDelayMs: COMPOSIO_V119_DEFAULT_REFRESH_RETRY_DELAY_MS,
  backoffMultiplier: COMPOSIO_V119_DEFAULT_REFRESH_BACKOFF_MULTIPLIER,
  maxRetryDelayMs: COMPOSIO_V119_DEFAULT_MAX_REFRESH_RETRY_DELAY_MS,
  refreshBeforeExpiryMs: COMPOSIO_V119_DEFAULT_REFRESH_BEFORE_EXPIRY_MS,
  maxConsecutiveFailures: COMPOSIO_V119_DEFAULT_MAX_CONSECUTIVE_FAILURES,
  jitterFraction: COMPOSIO_V119_DEFAULT_REFRESH_JITTER_FRACTION,
};

/** Kiem tra + chuan hoa chinh sach refresh (throw neu sai). */
export function validateComposioV119RefreshPolicy(
  raw: Partial<ComposioV119RefreshPolicy> | undefined,
): ComposioV119RefreshPolicy {
  const p: ComposioV119RefreshPolicy = { ...DEFAULT_COMPOSIO_V119_REFRESH_POLICY, ...(raw ?? {}) };
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) {
    throw new Error('refresh policy maxAttempts must be a positive integer');
  }
  if (!Number.isInteger(p.retryDelayMs) || p.retryDelayMs < 0) {
    throw new Error('refresh policy retryDelayMs must be a non-negative integer');
  }
  if (typeof p.backoffMultiplier !== 'number' || p.backoffMultiplier < 1) {
    throw new Error('refresh policy backoffMultiplier must be a number >= 1');
  }
  if (!Number.isInteger(p.maxRetryDelayMs) || p.maxRetryDelayMs < p.retryDelayMs) {
    throw new Error('refresh policy maxRetryDelayMs must be an integer >= retryDelayMs');
  }
  if (!Number.isInteger(p.refreshBeforeExpiryMs) || p.refreshBeforeExpiryMs < 0) {
    throw new Error('refresh policy refreshBeforeExpiryMs must be a non-negative integer');
  }
  if (!Number.isInteger(p.maxConsecutiveFailures) || p.maxConsecutiveFailures < 1) {
    throw new Error('refresh policy maxConsecutiveFailures must be a positive integer');
  }
  if (typeof p.jitterFraction !== 'number' || p.jitterFraction < 0 || p.jitterFraction > 0.5) {
    throw new Error('refresh policy jitterFraction must be a number between 0 and 0.5');
  }
  return p;
}

/**
 * Delay truoc lan retry thu `attempt` (0-based): delay co so nhan
 * he so mu, cap o max, cong jitter tuy chon. Ham thuan.
 */
export function composioV119RefreshDelayMs(
  attempt: number,
  policy: ComposioV119RefreshPolicy,
  random: () => number = Math.random,
): number {
  if (attempt < 0) throw new Error('refresh retry attempt must be a non-negative integer');
  const base = Math.min(
    policy.retryDelayMs * Math.pow(policy.backoffMultiplier, attempt),
    policy.maxRetryDelayMs,
  );
  if (policy.jitterFraction <= 0) return Math.round(base);
  const jitter = base * policy.jitterFraction * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

// ---------------------------------------------------------------------------
// Refresh token trong Vault (chi luu/kiem tra/xoa — khong tra gia tri)
// ---------------------------------------------------------------------------

/**
 * Chuyen trang thai OAuth v118 — tra ve entry moi (transition goc
 * tra { entry, audit }; o day chi can entry, audit cua chu ky
 * refresh nam o `ComposioV119RefreshAuditEntry` rieng).
 */
function transitionOAuth(
  prev: ComposioV118OAuthEntry,
  to: Parameters<typeof transitionComposioV118OAuth>[1],
  reason: string,
  nowMs: number,
): ComposioV118OAuthEntry {
  return transitionComposioV118OAuth(prev, to, reason, { nowMs }).entry;
}

function assertConnectionId(connectionId: string): void {
  if (typeof connectionId !== 'string' || connectionId.trim() === '') {
    throw new Error('connectionId must be a non-empty string');
  }
}

/** Luu refresh token vao Vault (ghi de token cu — dung khi rotate). Khong log gia tri. */
export function setComposioV119RefreshToken(
  vault: ComposioV119RefreshTokenVault,
  connectionId: string,
  refreshToken: string,
): void {
  assertConnectionId(connectionId);
  if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
    throw new Error('refresh token must be a non-empty string');
  }
  vault.setSecret(COMPOSIO_V119_OAUTH_REFRESH_NAMESPACE, connectionId.trim(), refreshToken.trim());
}

/** Co refresh token trong Vault khong (chi boolean — khong lo gia tri). */
export function hasComposioV119RefreshToken(
  vault: ComposioV119RefreshTokenVault,
  connectionId: string,
): boolean {
  assertConnectionId(connectionId);
  return vault.hasSecret(COMPOSIO_V119_OAUTH_REFRESH_NAMESPACE, connectionId.trim());
}

/** Xoa refresh token khoi Vault (khi thu hoi / ket noi lai). Tra true neu co de xoa. */
export function deleteComposioV119RefreshToken(
  vault: ComposioV119RefreshTokenVault,
  connectionId: string,
): boolean {
  assertConnectionId(connectionId);
  return vault.deleteSecret(COMPOSIO_V119_OAUTH_REFRESH_NAMESPACE, connectionId.trim());
}

// ---------------------------------------------------------------------------
// Trang thai refresh v2 (ghe ben canh entry OAuth v118)
// ---------------------------------------------------------------------------

/** Ket qua cua mot chu ky refresh. */
export type ComposioV119RefreshOutcome =
  | 'refreshed'
  | 'not-needed'
  | 'no-token'
  | 'failed'
  | 'revoked';

/** Trang thai refresh cua MOT connection (persist duoc, khong chua token). */
export interface ComposioV119RefreshState {
  /** Id connection Composio. */
  connectionId: string;
  /** Slug toolkit. */
  toolkit: string;
  /** ms epoch lan refresh thanh cong cuoi (null = chua bao gio). */
  lastRefreshAtMs: number | null;
  /** ms epoch lan refresh that bai cuoi (null = chua bao gio). */
  lastFailureAtMs: number | null;
  /** So lan that bai lien tiep (reset khi refresh thanh cong). */
  consecutiveFailures: number;
  /** Tong so lan refresh thanh cong tich luy. */
  totalRefreshed: number;
  /** Tong so lan refresh that bai tich luy. */
  totalFailed: number;
  /** Loi cua lan that bai cuoi (null khi lan cuoi thanh cong). */
  lastError: string | null;
  /** ms epoch lan thu lai ke tiep (null = khong hen thu lai). */
  nextRetryAtMs: number | null;
  /** true = da het luot that bai, user phai ket noi lai tu dau. */
  needsReconnect: boolean;
}

/** Tao state refresh moi cho mot connection. */
export function createComposioV119RefreshState(
  connectionId: string,
  toolkit: string,
): ComposioV119RefreshState {
  assertConnectionId(connectionId);
  if (typeof toolkit !== 'string' || toolkit.trim() === '') {
    throw new Error('toolkit must be a non-empty string');
  }
  return {
    connectionId,
    toolkit,
    lastRefreshAtMs: null,
    lastFailureAtMs: null,
    consecutiveFailures: 0,
    totalRefreshed: 0,
    totalFailed: 0,
    lastError: null,
    nextRetryAtMs: null,
    needsReconnect: false,
  };
}

/** Kiem tra state refresh co hop le khong (throw neu sai). */
export function validateComposioV119RefreshState(s: ComposioV119RefreshState): void {
  assertConnectionId(s.connectionId);
  if (typeof s.toolkit !== 'string' || s.toolkit.trim() === '') {
    throw new Error('refresh state toolkit must be a non-empty string');
  }
  for (const f of ['lastRefreshAtMs', 'lastFailureAtMs', 'nextRetryAtMs'] as const) {
    if (s[f] !== null && (!Number.isFinite(s[f]) || (s[f] as number) < 0)) {
      throw new Error(`refresh state ${f} must be null or a non-negative number`);
    }
  }
  for (const f of ['consecutiveFailures', 'totalRefreshed', 'totalFailed'] as const) {
    if (!Number.isInteger(s[f]) || s[f] < 0) throw new Error(`refresh state ${f} must be a non-negative integer`);
  }
  if (s.lastError !== null && typeof s.lastError !== 'string') {
    throw new Error('refresh state lastError must be a string or null');
  }
  if (typeof s.needsReconnect !== 'boolean') throw new Error('refresh state needsReconnect must be a boolean');
}

/**
 * Co can refresh luc nay khong: token da het han hoac sap het han
 * trong `refreshBeforeExpiryMs`, hoac da toi `nextRetryAtMs` sau
 * mot lan that bai. Entry revoked / needsReconnect thi KHONG
 * refresh nua — user phai ket noi lai.
 */
export function isComposioV119RefreshDue(
  oauth: ComposioV118OAuthEntry,
  refresh: ComposioV119RefreshState,
  policy: ComposioV119RefreshPolicy,
  nowMs: number,
): boolean {
  if (oauth.state === 'revoked') return false;
  if (refresh.needsReconnect) return false;
  if (refresh.nextRetryAtMs !== null && nowMs >= refresh.nextRetryAtMs) return true;
  if (oauth.expiresAtMs === null) return false;
  return oauth.expiresAtMs - nowMs <= policy.refreshBeforeExpiryMs;
}

/** Mot dong audit refresh. */
export interface ComposioV119RefreshAuditEntry {
  id: string;
  connectionId: string;
  toolkit: string;
  outcome: ComposioV119RefreshOutcome;
  attempts: number;
  reason: string;
  atMs: number;
}

/** Tao mot dong audit refresh (ham thuan). */
export function createComposioV119RefreshAuditEntry(
  connectionId: string,
  toolkit: string,
  outcome: ComposioV119RefreshOutcome,
  attempts: number,
  reason: string,
  atMs: number = Date.now(),
): ComposioV119RefreshAuditEntry {
  assertConnectionId(connectionId);
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error('audit attempts must be a non-negative integer');
  return {
    id: `rf119-${crypto.randomUUID()}`,
    connectionId,
    toolkit,
    outcome,
    attempts,
    reason: reason.trim() === '' ? outcome : reason.trim(),
    atMs,
  };
}

/** Kiem tra mot dong audit refresh (throw neu sai). */
export function validateComposioV119RefreshAuditEntry(raw: unknown): ComposioV119RefreshAuditEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119RefreshAuditEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || (rec['id'] as string).trim() === '') throw new Error('audit id must be a non-empty string.');
  if (typeof rec['connectionId'] !== 'string' || (rec['connectionId'] as string).trim() === '') throw new Error('audit connectionId must be a non-empty string.');
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') throw new Error('audit toolkit must be a non-empty string.');
  const outcomes: readonly string[] = ['refreshed', 'not-needed', 'no-token', 'failed', 'revoked'];
  if (typeof rec['outcome'] !== 'string' || !outcomes.includes(rec['outcome'])) throw new Error('audit outcome is invalid.');
  if (!Number.isInteger(rec['attempts']) || (rec['attempts'] as number) < 0) throw new Error('audit attempts must be a non-negative integer.');
  if (typeof rec['reason'] !== 'string' || (rec['reason'] as string).trim() === '') throw new Error('audit reason must be a non-empty string.');
  if (typeof rec['atMs'] !== 'number' || !Number.isFinite(rec['atMs'])) throw new Error('audit atMs must be a number.');
  return {
    id: rec['id'] as string,
    connectionId: rec['connectionId'] as string,
    toolkit: rec['toolkit'] as string,
    outcome: rec['outcome'] as ComposioV119RefreshOutcome,
    attempts: rec['attempts'] as number,
    reason: rec['reason'] as string,
    atMs: rec['atMs'] as number,
  };
}

// ---------------------------------------------------------------------------
// Thuc thi refresh — retry co gioi han + rotation + fallback
// ---------------------------------------------------------------------------

/** Ket qua mot lan goi refresh that (do host cung cap). */
export interface ComposioV119RefreshResult {
  /** ms epoch access token moi het han. */
  newExpiresAtMs: number;
  /** Refresh token moi (rotation) — null/undefined = giu token cu. */
  newRefreshToken?: string | null;
  /** true = app ben kia da thu hoi quyen — khong refresh duoc nua. */
  revoked?: boolean;
}

/** Ham refresh that do host tiem (mock trong test, Composio that trong app). */
export type ComposioV119RefreshFn = (
  connectionId: string,
  refreshToken: string,
) => Promise<ComposioV119RefreshResult>;

/** Ket qua mot chu ky refresh v2. */
export interface ComposioV119RefreshAttempt {
  outcome: ComposioV119RefreshOutcome;
  /** Entry OAuth v118 sau chu ky (da chuyen trang thai neu can). */
  oauth: ComposioV118OAuthEntry;
  /** State refresh sau chu ky. */
  refresh: ComposioV119RefreshState;
  /** So lan da thu goi refreshFn (0 khi khong can goi). */
  attempts: number;
  /** Dong audit cua chu ky nay. */
  audit: ComposioV119RefreshAuditEntry;
}

/**
 * Chay mot chu ky refresh cho mot connection:
 * - Chua toi han + chua toi lich thu lai → 'not-needed', khong
 *   goi refreshFn, khong doi state.
 * - Khong co refresh token trong Vault → 'no-token': entry OAuth
 *   → expired (neu dang connected/refreshing), state danh dau
 *   needsReconnect (user phai ket noi lai de co token moi).
 * - Gọi refreshFn toi da `maxAttempts` lan (retry khi loi, doi
 *   delay tang dan). Thanh cong → entry → connected + han moi,
 *   rotate refresh token neu server tra token moi, reset loi.
 * - Server bao revoked → entry → revoked, XOA refresh token khoi
 *   Vault ngay, needsReconnect = true.
 * - Het luot van loi → entry → expired, tang consecutiveFailures,
 *   hen `nextRetryAtMs` = now + delay lan cuoi; du
 *   `maxConsecutiveFailures` thi needsReconnect = true (fallback:
 *   dung refresh, cho user ket noi lai).
 */
export async function attemptComposioV119Refresh(
  oauth: ComposioV118OAuthEntry,
  refresh: ComposioV119RefreshState,
  deps: {
    vault: ComposioV119RefreshTokenVault;
    refreshFn: ComposioV119RefreshFn;
    policy?: Partial<ComposioV119RefreshPolicy>;
    nowMs?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  },
): Promise<ComposioV119RefreshAttempt> {
  const policy = validateComposioV119RefreshPolicy(deps.policy);
  const nowMs = deps.nowMs ?? Date.now();
  const sleep = deps.sleep ?? (async () => undefined);
  const random = deps.random ?? (() => 0.5);
  validateComposioV119RefreshState(refresh);
  if (refresh.connectionId !== oauth.connectionId) {
    throw new Error('refresh state connectionId does not match OAuth entry connectionId');
  }

  const auditFor = (outcome: ComposioV119RefreshOutcome, attempts: number, reason: string): ComposioV119RefreshAuditEntry =>
    createComposioV119RefreshAuditEntry(oauth.connectionId, oauth.toolkit, outcome, attempts, reason, nowMs);

  if (!isComposioV119RefreshDue(oauth, refresh, policy, nowMs)) {
    return {
      outcome: 'not-needed',
      oauth,
      refresh,
      attempts: 0,
      audit: auditFor('not-needed', 0, 'token still valid, no refresh needed'),
    };
  }

  const stored = deps.vault.getSecret(COMPOSIO_V119_OAUTH_REFRESH_NAMESPACE, oauth.connectionId);
  if (typeof stored !== 'string' || stored.trim() === '') {
    const nextOauth =
      oauth.state === 'connected' || oauth.state === 'refreshing'
        ? transitionOAuth(oauth, 'expired', 'no refresh token in Vault — reconnect required', nowMs)
        : oauth;
    const nextRefresh: ComposioV119RefreshState = {
      ...refresh,
      lastError: 'no refresh token in Vault',
      needsReconnect: true,
    };
    return {
      outcome: 'no-token',
      oauth: nextOauth,
      refresh: nextRefresh,
      attempts: 0,
      audit: auditFor('no-token', 0, 'no refresh token in Vault — user must reconnect'),
    };
  }

  const refreshToken = stored;
  let workingOauth: ComposioV118OAuthEntry =
    oauth.state === 'connected'
      ? transitionOAuth(oauth, 'refreshing', 'refreshing OAuth token', nowMs)
      : oauth;
  let attempts = 0;
  let lastError = 'refresh failed';
  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    attempts += 1;
    try {
      const result = await deps.refreshFn(oauth.connectionId, refreshToken);
      if (result.revoked === true) {
        deps.vault.deleteSecret(COMPOSIO_V119_OAUTH_REFRESH_NAMESPACE, oauth.connectionId);
        const revokedOauth = transitionOAuth(workingOauth, 'revoked', 'provider revoked access', nowMs);
        const nextRefresh: ComposioV119RefreshState = {
          ...refresh,
          consecutiveFailures: refresh.consecutiveFailures + 1,
          totalFailed: refresh.totalFailed + 1,
          lastFailureAtMs: nowMs,
          lastError: 'provider revoked access',
          nextRetryAtMs: null,
          needsReconnect: true,
        };
        return {
          outcome: 'revoked',
          oauth: revokedOauth,
          refresh: nextRefresh,
          attempts,
          audit: auditFor('revoked', attempts, 'provider revoked access — refresh token deleted from Vault'),
        };
      }
      if (!Number.isFinite(result.newExpiresAtMs) || result.newExpiresAtMs <= nowMs) {
        throw new Error('refresh returned an invalid expiry');
      }
      if (typeof result.newRefreshToken === 'string' && result.newRefreshToken.trim() !== '') {
        setComposioV119RefreshToken(deps.vault, oauth.connectionId, result.newRefreshToken);
      }
      const connectedOauth = transitionOAuth(
        workingOauth,
        'connected',
        'token refreshed',
        nowMs,
      );
      const syncedOauth: ComposioV118OAuthEntry = {
        ...connectedOauth,
        expiresAtMs: result.newExpiresAtMs,
        autoRefreshAttempts: 0,
      };
      const nextRefresh: ComposioV119RefreshState = {
        ...refresh,
        lastRefreshAtMs: nowMs,
        consecutiveFailures: 0,
        totalRefreshed: refresh.totalRefreshed + 1,
        lastError: null,
        nextRetryAtMs: null,
        needsReconnect: false,
      };
      return {
        outcome: 'refreshed',
        oauth: syncedOauth,
        refresh: nextRefresh,
        attempts,
        audit: auditFor('refreshed', attempts, 'token refreshed successfully'),
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt + 1 < policy.maxAttempts) {
        await sleep(composioV119RefreshDelayMs(attempt, policy, random));
      }
    }
  }

  // Het luot van loi.
  const consecutiveFailures = refresh.consecutiveFailures + 1;
  const needsReconnect = consecutiveFailures >= policy.maxConsecutiveFailures;
  const retryDelay = composioV119RefreshDelayMs(policy.maxAttempts - 1, policy, random);
  const expiredOauth =
    workingOauth.state === 'refreshing'
      ? transitionOAuth(workingOauth, 'expired', `refresh failed after ${attempts} attempts: ${lastError}`, nowMs)
      : workingOauth;
  const nextRefresh: ComposioV119RefreshState = {
    ...refresh,
    lastFailureAtMs: nowMs,
    consecutiveFailures,
    totalFailed: refresh.totalFailed + 1,
    lastError,
    nextRetryAtMs: needsReconnect ? null : nowMs + retryDelay,
    needsReconnect,
  };
  return {
    outcome: 'failed',
    oauth: expiredOauth,
    refresh: nextRefresh,
    attempts,
    audit: auditFor(
      'failed',
      attempts,
      needsReconnect
        ? `refresh failed ${consecutiveFailures} times in a row — reconnect required`
        : `refresh failed after ${attempts} attempts — will retry`,
    ),
  };
}

/**
 * Reset sau khi user ket noi lai: xoa trang thai loi + xoa refresh
 * token cu (neu con) de chu ky moi bat dau sach. Tra ve state
 * refresh moi (giua tong dem tich luy).
 */
export function resetComposioV119Refresh(
  refresh: ComposioV119RefreshState,
  vault: ComposioV119RefreshTokenVault,
): ComposioV119RefreshState {
  validateComposioV119RefreshState(refresh);
  deleteComposioV119RefreshToken(vault, refresh.connectionId);
  return {
    ...refresh,
    lastError: null,
    consecutiveFailures: 0,
    nextRetryAtMs: null,
    needsReconnect: false,
  };
}

/** Tom tat refresh cho UI (1 dong). */
export function summarizeComposioV119Refresh(refresh: ComposioV119RefreshState): string {
  if (refresh.needsReconnect) return `${refresh.toolkit}/${refresh.connectionId}: needs reconnect (${refresh.consecutiveFailures} consecutive failures).`;
  if (refresh.lastRefreshAtMs === null) return `${refresh.toolkit}/${refresh.connectionId}: never refreshed.`;
  return `${refresh.toolkit}/${refresh.connectionId}: refreshed ${refresh.totalRefreshed} times, ${refresh.totalFailed} failures, last refresh ${new Date(refresh.lastRefreshAtMs).toISOString()}.`;
}
