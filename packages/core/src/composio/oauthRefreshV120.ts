/**
 * Composio OAuth refresh v3 — lich refresh chu dong + rotation co
 * grace + phan loai loi + xu ly revoked (v1.20, Doi T4).
 *
 * Tang tren oauthRefreshV119.ts — KHONG viet lai:
 * - `attemptComposioV119Refresh` van la bo may refresh cua mot
 *   connection: retry co gioi han, rotate refresh token, entry
 *   OAuth → expired khi het luot, revoked thi xoa token khoi
 *   Vault. V3 DUNG LAI ham do cho tung connection, khong goi
 *   refreshFn truc tiep.
 * - `ComposioV119RefreshState` / `ComposioV119RefreshPolicy` /
 *   Vault namespace `composio-oauth-refresh` van nguyen ven.
 *
 * Moi trong v3:
 * 1. Lich refresh chu dong (proactive scheduling): moi toolkit
 *    co cua so refresh-rieng (`refreshBeforeExpiryMs` theo
 *    toolkit — vd token 1h thi refresh truoc 10 phut, token 90
 *    ngay thi refresh truoc 1 ngay). `runComposioV120RefreshCycle`
 *    quet TAT CA connection, sap xep theo muc do gap (token sap
 *    het han nhat truoc), chi refresh cai nao toi han — mot
 *    connection loi khong chan cac connection khac (loi duoc
 *    cach ly theo connection, ghi vao bao cao chu ky).
 * 2. Rotation co grace: server tra refresh token moi thi token
 *    CU khong bi xoa ngay — no duoc giu lai trong Vault (key
 *    rieng, co han grace ngan) lam du phong. Neu lan refresh
 *    KE TIEP bao `invalid_grant` voi token moi (vd server chua
 *    kip dong bo rotation), v3 thu lai MOT lan bang token cu
 *    truoc khi ket luan revoked — tranh mat ket noi oan vi
 *    rotation chua dong bo.
 * 3. Phan loai loi: `classifyComposioV120RefreshError` phan biet
 *    'transient' (mang/timeout — retry duoc), 'invalid-grant'
 *    (token khong dung duoc nua — thu token cu roi moi ket
 *    luan), 'revoked' (provider thu hoi — xoa token ngay, can
 *    ket noi lai), 'rate-limited' (bi gioi han — ton trong
 *    delay `retryAfterMs` host truyen vao, khong retry dot
 *    ngay), 'unknown'. Moi loai co huong xu ly rieng, khong
 *    con "loi nao cung retry nhu nhau" nhu v2.
 * 4. Revoked xu ly dut khoat: provider bao revoked (hoac
 *    invalid_grant sau khi da thu ca token cu) → entry →
 *    revoked, XOA CA token hien tai LAN token grace khoi
 *    Vault ngay, `needsReconnect = true`, audit ghi ro ly do
 *    + token nao da thu — UI hien nut "Ket noi lai" thay vi
 *    tiep tuc refresh vo ich.
 * 5. Chong refresh dong loat (thundering herd): nhieu
 *    connection cung het han mot luc thi moi connection co
 *    jitter rieng (`scheduleJitterMs`) cong vao thoi diem
 *    refresh — khong dot tat ca cung mot giay.
 *
 * Module nay KHONG goi mang truc tiep: ham refresh that
 * (`refreshFn`) do host tiem vao nhu v2. KHONG log token,
 * KHONG dua token vao error/audit.
 */

import * as crypto from 'node:crypto';
import {
  attemptComposioV119Refresh,
  createComposioV119RefreshState,
  deleteComposioV119RefreshToken,
  hasComposioV119RefreshToken,
  isComposioV119RefreshDue,
  setComposioV119RefreshToken,
  validateComposioV119RefreshPolicy,
  type ComposioV119RefreshPolicy,
  type ComposioV119RefreshState,
  type ComposioV119RefreshTokenVault,
} from './oauthRefreshV119';
import type { ComposioV118OAuthEntry } from './oauthStateV118';

/** Suffix key Vault chua refresh token CU trong thoi gian grace. */
export const COMPOSIO_V120_PREVIOUS_TOKEN_KEY_SUFFIX = ':previous-v120';
/** Grace mac dinh giu token cu sau rotation (ms) — 10 phut. */
export const COMPOSIO_V120_DEFAULT_ROTATION_GRACE_MS = 10 * 60 * 1000;
/** Jitter lich toi da cong vao thoi diem refresh (ms) — 60 giay. */
export const COMPOSIO_V120_DEFAULT_SCHEDULE_JITTER_MS = 60 * 1000;
/** So connection toi da moi chu ky refresh (0 = khong gioi han). */
export const COMPOSIO_V120_DEFAULT_MAX_CONNECTIONS_PER_CYCLE = 0;
/** Cua so refresh truoc han mac dinh khi toolkit khong co override (ms) — 5 phut (bang v118/v119). */
export const COMPOSIO_V120_DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
/** So lan thu lai bang token cu toi da khi gap invalid_grant. */
export const COMPOSIO_V120_MAX_PREVIOUS_TOKEN_RETRIES = 1;

/** Loai loi refresh (de quyet dinh huong xu ly). */
export type ComposioV120RefreshErrorKind =
  | 'transient'
  | 'invalid-grant'
  | 'revoked'
  | 'rate-limited'
  | 'unknown';

/** Map message loi → loai (khong phan biet hoa/thuong). */
const ERROR_PATTERNS: { kind: ComposioV120RefreshErrorKind; patterns: RegExp[] }[] = [
  {
    kind: 'revoked',
    patterns: [/revoked/i, /access_denied/i, /consent_required/i, /account\s+suspended/i, /authorization\s+revoked/i],
  },
  {
    kind: 'invalid-grant',
    patterns: [/invalid_grant/i, /invalid_grant/i, /token\s+(expired|invalid|not\s+found)/i, /refresh\s+token\s+(invalid|expired|not\s+found)/i],
  },
  {
    kind: 'rate-limited',
    patterns: [/rate[\s_-]?limit/i, /too\s+many\s+requests/i, /429/, /quota\s+exceeded/i],
  },
  {
    kind: 'transient',
    patterns: [
      /timeout/i,
      /timed\s+out/i,
      /econnreset/i,
      /econnrefused/i,
      /enotfound/i,
      /network/i,
      /temporar/i,
      /unavailable/i,
      /5\d\d/,
      /gateway/i,
    ],
  },
];

/**
 * Phan loai mot loi refresh theo message (ham thuan). Thu tu
 * uu tien: revoked > invalid-grant > rate-limited > transient >
 * unknown — de `invalid_grant` khong bi nham thanh transient
 * (retry vo ich) va `revoked` khong bi nham thanh loi mang.
 */
export function classifyComposioV120RefreshError(message: string): ComposioV120RefreshErrorKind {
  const text = typeof message === 'string' ? message : String(message);
  for (const { kind, patterns } of ERROR_PATTERNS) {
    if (patterns.some((re) => re.test(text))) return kind;
  }
  return 'unknown';
}

/** Lich refresh chu dong cua v3 (theo toolkit). */
export interface ComposioV120RefreshSchedule {
  /** Cua so refresh mac dinh (ms truoc khi token het han). */
  defaultRefreshBeforeExpiryMs: number;
  /** Override theo toolkit: slug → ms truoc han. */
  perToolkitRefreshBeforeExpiryMs: Readonly<Record<string, number>>;
  /** Grace giu token cu sau rotation (ms). */
  rotationGraceMs: number;
  /** Jitter lich toi da (ms) — 0 = tat (de test xac dinh). */
  scheduleJitterMs: number;
  /** So connection toi da moi chu ky (0 = khong gioi han). */
  maxConnectionsPerCycle: number;
}

/** Lich mac dinh cua refresh v3. */
export const DEFAULT_COMPOSIO_V120_REFRESH_SCHEDULE: ComposioV120RefreshSchedule = {
  defaultRefreshBeforeExpiryMs: COMPOSIO_V120_DEFAULT_REFRESH_BEFORE_EXPIRY_MS,
  perToolkitRefreshBeforeExpiryMs: {},
  rotationGraceMs: COMPOSIO_V120_DEFAULT_ROTATION_GRACE_MS,
  scheduleJitterMs: COMPOSIO_V120_DEFAULT_SCHEDULE_JITTER_MS,
  maxConnectionsPerCycle: COMPOSIO_V120_DEFAULT_MAX_CONNECTIONS_PER_CYCLE,
};

/** Kiem tra + chuan hoa lich refresh v3 (throw neu sai). */
export function validateComposioV120RefreshSchedule(
  raw: Partial<ComposioV120RefreshSchedule> | undefined,
): ComposioV120RefreshSchedule {
  const s: ComposioV120RefreshSchedule = { ...DEFAULT_COMPOSIO_V120_REFRESH_SCHEDULE, ...(raw ?? {}) };
  if (!Number.isInteger(s.defaultRefreshBeforeExpiryMs) || s.defaultRefreshBeforeExpiryMs < 0) {
    throw new Error('refresh schedule defaultRefreshBeforeExpiryMs must be a non-negative integer');
  }
  if (typeof s.perToolkitRefreshBeforeExpiryMs !== 'object' || s.perToolkitRefreshBeforeExpiryMs === null) {
    throw new Error('refresh schedule perToolkitRefreshBeforeExpiryMs must be an object');
  }
  for (const [toolkit, ms] of Object.entries(s.perToolkitRefreshBeforeExpiryMs)) {
    if (toolkit.trim() === '' || !Number.isInteger(ms) || ms < 0) {
      throw new Error(`refresh schedule override for toolkit ${toolkit} must be a non-negative integer`);
    }
  }
  if (!Number.isInteger(s.rotationGraceMs) || s.rotationGraceMs < 0) {
    throw new Error('refresh schedule rotationGraceMs must be a non-negative integer');
  }
  if (!Number.isInteger(s.scheduleJitterMs) || s.scheduleJitterMs < 0) {
    throw new Error('refresh schedule scheduleJitterMs must be a non-negative integer');
  }
  if (!Number.isInteger(s.maxConnectionsPerCycle) || s.maxConnectionsPerCycle < 0) {
    throw new Error('refresh schedule maxConnectionsPerCycle must be a non-negative integer');
  }
  return s;
}

/** Cua so refresh cua mot toolkit (override thang mac dinh). */
export function composioV120RefreshBeforeExpiryMs(
  toolkit: string,
  schedule: ComposioV120RefreshSchedule,
): number {
  return schedule.perToolkitRefreshBeforeExpiryMs[toolkit] ?? schedule.defaultRefreshBeforeExpiryMs;
}

/** Policy v2 cua mot toolkit (cua so refresh lay theo lich v3). */
export function composioV120PolicyForToolkit(
  toolkit: string,
  schedule: ComposioV120RefreshSchedule,
  policyOverride?: Partial<ComposioV119RefreshPolicy>,
): ComposioV119RefreshPolicy {
  return validateComposioV119RefreshPolicy({
    ...policyOverride,
    refreshBeforeExpiryMs: composioV120RefreshBeforeExpiryMs(toolkit, schedule),
  });
}

// ---------------------------------------------------------------------------
// Token cu trong thoi gian grace (Vault, key rieng)
// ---------------------------------------------------------------------------

/** Key Vault chua refresh token cu cua mot connection. */
export function composioV120PreviousTokenKey(connectionId: string): string {
  return `${connectionId.trim()}${COMPOSIO_V120_PREVIOUS_TOKEN_KEY_SUFFIX}`;
}

/**
 * Luu refresh token CU vao Vault lam du phong grace (ghi de lan
 * truoc). Chi goi khi rotation tra token moi.
 */
export function setComposioV120PreviousRefreshToken(
  vault: ComposioV119RefreshTokenVault,
  connectionId: string,
  previousToken: string,
): void {
  if (typeof previousToken !== 'string' || previousToken.trim() === '') {
    throw new Error('previous refresh token must be a non-empty string');
  }
  vault.setSecret(
    'composio-oauth-refresh',
    composioV120PreviousTokenKey(connectionId),
    previousToken.trim(),
  );
}

/** Co refresh token cu trong thoi gian grace khong (chi boolean). */
export function hasComposioV120PreviousRefreshToken(
  vault: ComposioV119RefreshTokenVault,
  connectionId: string,
): boolean {
  return vault.hasSecret('composio-oauth-refresh', composioV120PreviousTokenKey(connectionId));
}

/** Xoa refresh token cu khoi Vault (het grace / revoked / ket noi lai). */
export function deleteComposioV120PreviousRefreshToken(
  vault: ComposioV119RefreshTokenVault,
  connectionId: string,
): boolean {
  return vault.deleteSecret('composio-oauth-refresh', composioV120PreviousTokenKey(connectionId));
}

/** Xoa CA token hien tai LAN token grace (khi revoked). */
export function purgeComposioV120RefreshTokens(
  vault: ComposioV119RefreshTokenVault,
  connectionId: string,
): { currentDeleted: boolean; previousDeleted: boolean } {
  return {
    currentDeleted: deleteComposioV119RefreshToken(vault, connectionId),
    previousDeleted: deleteComposioV120PreviousRefreshToken(vault, connectionId),
  };
}

// ---------------------------------------------------------------------------
// Trang thai refresh v3 (ghe ben canh state v2 — khong chua token)
// ---------------------------------------------------------------------------

/** Trang thai bo sung cua refresh v3 cho MOT connection. */
export interface ComposioV120RefreshState {
  /** Id connection Composio. */
  connectionId: string;
  /** ms epoch token grace het han (null = khong co token cu). */
  previousTokenExpiresAtMs: number | null;
  /** So lan da thu bang token cu (reset khi rotation moi). */
  previousTokenRetries: number;
  /** Loai loi cua lan that bai cuoi (null khi lan cuoi thanh cong). */
  lastErrorKind: ComposioV120RefreshErrorKind | null;
  /** ms epoch lan thu lai tiep theo khi bi rate-limited (null = khong hen). */
  rateLimitedUntilMs: number | null;
  /** ms epoch lan chay chu ky gan nhat da xet connection nay. */
  lastCycleCheckedAtMs: number | null;
}

/** Tao state refresh v3 moi cho mot connection. */
export function createComposioV120RefreshState(connectionId: string): ComposioV120RefreshState {
  if (typeof connectionId !== 'string' || connectionId.trim() === '') {
    throw new Error('connectionId must be a non-empty string');
  }
  return {
    connectionId,
    previousTokenExpiresAtMs: null,
    previousTokenRetries: 0,
    lastErrorKind: null,
    rateLimitedUntilMs: null,
    lastCycleCheckedAtMs: null,
  };
}

/** Kiem tra state refresh v3 co hop le khong (throw neu sai). */
export function validateComposioV120RefreshState(raw: unknown): ComposioV120RefreshState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV120RefreshState must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['connectionId'] !== 'string' || (rec['connectionId'] as string).trim() === '') {
    throw new Error('refresh v3 state connectionId must be a non-empty string.');
  }
  for (const f of ['previousTokenExpiresAtMs', 'rateLimitedUntilMs', 'lastCycleCheckedAtMs'] as const) {
    if (rec[f] !== null && (typeof rec[f] !== 'number' || !Number.isFinite(rec[f]) || (rec[f] as number) < 0)) {
      throw new Error(`refresh v3 state ${f} must be null or a non-negative number.`);
    }
  }
  if (!Number.isInteger(rec['previousTokenRetries']) || (rec['previousTokenRetries'] as number) < 0) {
    throw new Error('refresh v3 state previousTokenRetries must be a non-negative integer.');
  }
  const kinds: readonly string[] = ['transient', 'invalid-grant', 'revoked', 'rate-limited', 'unknown'];
  if (rec['lastErrorKind'] !== null && (typeof rec['lastErrorKind'] !== 'string' || !kinds.includes(rec['lastErrorKind']))) {
    throw new Error('refresh v3 state lastErrorKind is invalid.');
  }
  return {
    connectionId: rec['connectionId'] as string,
    previousTokenExpiresAtMs: rec['previousTokenExpiresAtMs'] as number | null,
    previousTokenRetries: rec['previousTokenRetries'] as number,
    lastErrorKind: rec['lastErrorKind'] as ComposioV120RefreshErrorKind | null,
    rateLimitedUntilMs: rec['rateLimitedUntilMs'] as number | null,
    lastCycleCheckedAtMs: rec['lastCycleCheckedAtMs'] as number | null,
  };
}

/**
 * Muc do gap cua mot connection: ms con lai toi khi token het
 * han tru cua so refresh (am = da toi han). null = khong biet
 * han (khong xep hang gap).
 */
export function composioV120RefreshUrgencyMs(
  oauth: ComposioV118OAuthEntry,
  schedule: ComposioV120RefreshSchedule,
  nowMs: number,
): number | null {
  if (oauth.expiresAtMs === null) return null;
  return oauth.expiresAtMs - nowMs - composioV120RefreshBeforeExpiryMs(oauth.toolkit, schedule);
}

// ---------------------------------------------------------------------------
// Refresh 1 connection theo v3 (tren bo may v2)
// ---------------------------------------------------------------------------

/** Ket qua refresh v3 cua mot connection. */
export interface ComposioV120RefreshConnectionResult {
  connectionId: string;
  toolkit: string;
  outcome: 'refreshed' | 'not-needed' | 'no-token' | 'failed' | 'revoked';
  /** true = lan refresh nay dung token CU (grace) moi thanh cong. */
  usedPreviousToken: boolean;
  /** Loai loi (chi khi failed/revoked). */
  errorKind: ComposioV120RefreshErrorKind | null;
  /** So lan goi refreshFn (0 khi khong can goi). */
  attempts: number;
  oauth: ComposioV118OAuthEntry;
  refreshV2: ComposioV119RefreshState;
  refreshV3: ComposioV120RefreshState;
}

/**
 * Refresh MOT connection theo v3:
 * - Chua toi han → 'not-needed' (khong goi refreshFn).
 * - Dang bi rate-limited (rateLimitedUntilMs chua qua) → 'failed'
 *   voi errorKind 'rate-limited', khong goi refreshFn (ton
 *   trong delay).
 * - Refresh bang token hien tai qua bo may v2. Thanh cong +
 *   server tra token moi (rotation) → luu token CU vao grace
 *   (het han sau rotationGraceMs), reset dem token cu.
 * - That bai voi `invalid_grant` (loi cuoi cua v2) + con token
 *   cu trong grace + chua thu qua → thu lai MOT lan bang token
 *   cu (doi refreshFn nhan token cu). Thanh cong thi coi nhu
 *   refreshed (usedPreviousToken = true) va giu token cu lam
 *   token hien tai; that bai nua → ket luan revoked, XOA CA
 *   hai token khoi Vault.
 * - That bai loai khac → giu ket qua v2, ghi errorKind de chu
 *   ky sau xu ly (rate-limited thi hen lai sau retryAfterMs).
 */
export async function attemptComposioV120Refresh(
  oauth: ComposioV118OAuthEntry,
  refreshV2: ComposioV119RefreshState,
  refreshV3: ComposioV120RefreshState,
  deps: {
    vault: ComposioV119RefreshTokenVault;
    refreshFn: (connectionId: string, refreshToken: string) => Promise<{
      newExpiresAtMs: number;
      newRefreshToken?: string | null;
      revoked?: boolean;
    }>;
    schedule?: Partial<ComposioV120RefreshSchedule>;
    policy?: Partial<ComposioV119RefreshPolicy>;
    nowMs?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    /** Delay ton trong khi bi rate-limited (ms) — mac dinh 60s. */
    rateLimitRetryAfterMs?: number;
  },
): Promise<ComposioV120RefreshConnectionResult> {
  const schedule = validateComposioV120RefreshSchedule(deps.schedule);
  const nowMs = deps.nowMs ?? Date.now();
  const rateLimitRetryAfterMs = deps.rateLimitRetryAfterMs ?? 60_000;
  validateComposioV120RefreshState(refreshV3);
  if (refreshV3.connectionId !== oauth.connectionId) {
    throw new Error('refresh v3 state connectionId does not match OAuth entry connectionId');
  }
  const policy = composioV120PolicyForToolkit(oauth.toolkit, schedule, deps.policy);

  const base: Omit<ComposioV120RefreshConnectionResult, 'outcome' | 'usedPreviousToken' | 'errorKind' | 'attempts' | 'oauth' | 'refreshV2'> = {
    connectionId: oauth.connectionId,
    toolkit: oauth.toolkit,
    refreshV3: { ...refreshV3, lastCycleCheckedAtMs: nowMs },
  };

  // Dang bi rate-limited: khong goi gi ca.
  if (refreshV3.rateLimitedUntilMs !== null && nowMs < refreshV3.rateLimitedUntilMs) {
    return {
      ...base,
      outcome: 'failed',
      usedPreviousToken: false,
      errorKind: 'rate-limited',
      attempts: 0,
      oauth,
      refreshV2,
      refreshV3: { ...base.refreshV3 },
    };
  }

  // Jitter lich: token chi refresh khi da qua diem "han - cua so +
  // jitter". Jitter duoc tinh xac dinh tu connectionId (khong
  // random moi lan — tranh luc thi refresh luc thi khong).
  const jitter = schedule.scheduleJitterMs > 0
    ? Math.abs(hashComposioV120ConnectionId(oauth.connectionId)) % (schedule.scheduleJitterMs + 1)
    : 0;
  const effectivePolicy: ComposioV119RefreshPolicy = {
    ...policy,
    refreshBeforeExpiryMs: Math.max(0, policy.refreshBeforeExpiryMs - jitter),
  };
  if (!isComposioV119RefreshDue(oauth, refreshV2, effectivePolicy, nowMs)) {
    return {
      ...base,
      outcome: 'not-needed',
      usedPreviousToken: false,
      errorKind: null,
      attempts: 0,
      oauth,
      refreshV2,
      refreshV3: { ...base.refreshV3 },
    };
  }

  // Ghi lai token hien tai TRUOC khi refresh — neu rotation tra
  // token moi thi day la token CU can giu trong grace.
  const tokenBefore = deps.vault.getSecret('composio-oauth-refresh', oauth.connectionId);
  let totalAttempts = 0;
  const v2 = await attemptComposioV119Refresh(oauth, refreshV2, {
    vault: deps.vault,
    refreshFn: deps.refreshFn,
    policy: effectivePolicy,
    nowMs,
    sleep: deps.sleep,
    random: deps.random,
  });
  totalAttempts += v2.attempts;

  if (v2.outcome === 'revoked') {
    // Provider thu hoi that: xoa ca token grace (neu con).
    deleteComposioV120PreviousRefreshToken(deps.vault, oauth.connectionId);
    return {
      ...base,
      outcome: 'revoked',
      usedPreviousToken: false,
      errorKind: 'revoked',
      attempts: totalAttempts,
      oauth: v2.oauth,
      refreshV2: v2.refresh,
      refreshV3: { ...base.refreshV3, previousTokenExpiresAtMs: null, previousTokenRetries: 0, lastErrorKind: 'revoked', rateLimitedUntilMs: null },
    };
  }

  if (v2.outcome === 'refreshed') {
    // Rotation: token hien tai trong Vault da doi → token truoc
    // do (neu co va khac) vao grace.
    const tokenAfter = deps.vault.getSecret('composio-oauth-refresh', oauth.connectionId);
    let previousTokenExpiresAtMs: number | null = null;
    if (
      typeof tokenBefore === 'string' && tokenBefore.trim() !== '' &&
      typeof tokenAfter === 'string' && tokenAfter.trim() !== '' &&
      tokenBefore !== tokenAfter
    ) {
      setComposioV120PreviousRefreshToken(deps.vault, oauth.connectionId, tokenBefore);
      previousTokenExpiresAtMs = nowMs + schedule.rotationGraceMs;
    }
    return {
      ...base,
      outcome: 'refreshed',
      usedPreviousToken: false,
      errorKind: null,
      attempts: totalAttempts,
      oauth: v2.oauth,
      refreshV2: v2.refresh,
      refreshV3: {
        ...base.refreshV3,
        previousTokenExpiresAtMs,
        previousTokenRetries: 0,
        lastErrorKind: null,
        rateLimitedUntilMs: null,
      },
    };
  }

  if (v2.outcome === 'no-token') {
    return {
      ...base,
      outcome: 'no-token',
      usedPreviousToken: false,
      errorKind: null,
      attempts: totalAttempts,
      oauth: v2.oauth,
      refreshV2: v2.refresh,
      refreshV3: { ...base.refreshV3, lastErrorKind: null },
    };
  }

  // v2 failed — phan loai loi cuoi de quyet dinh buoc tiep.
  const errorKind = classifyComposioV120RefreshError(v2.refresh.lastError ?? '');
  if (errorKind === 'rate-limited') {
    return {
      ...base,
      outcome: 'failed',
      usedPreviousToken: false,
      errorKind,
      attempts: totalAttempts,
      oauth: v2.oauth,
      refreshV2: v2.refresh,
      refreshV3: { ...base.refreshV3, lastErrorKind: errorKind, rateLimitedUntilMs: nowMs + rateLimitRetryAfterMs },
    };
  }

  if (
    errorKind === 'invalid-grant' &&
    refreshV3.previousTokenRetries < COMPOSIO_V120_MAX_PREVIOUS_TOKEN_RETRIES &&
    refreshV3.previousTokenExpiresAtMs !== null &&
    nowMs <= refreshV3.previousTokenExpiresAtMs &&
    hasComposioV120PreviousRefreshToken(deps.vault, oauth.connectionId)
  ) {
    // Thu lai MOT lan bang token cu: doi refreshFn nhan token cu
    // (host truyen token tu Vault — o day lay truc tiep vi day la
    // lop thuc thi, khong log gia tri).
    const previousToken = deps.vault.getSecret(
      'composio-oauth-refresh',
      composioV120PreviousTokenKey(oauth.connectionId),
    );
    if (typeof previousToken === 'string' && previousToken.trim() !== '') {
      try {
        totalAttempts += 1;
        const retry = await deps.refreshFn(oauth.connectionId, previousToken);
        if (retry.revoked === true) throw new Error('provider revoked access');
        if (!Number.isFinite(retry.newExpiresAtMs) || retry.newExpiresAtMs <= nowMs) {
          throw new Error('refresh returned an invalid expiry');
        }
        // Token cu van dung duoc: dua no ve lam token hien tai.
        setComposioV119RefreshToken(deps.vault, oauth.connectionId, previousToken);
        deleteComposioV120PreviousRefreshToken(deps.vault, oauth.connectionId);
        const recoveredV2: ComposioV119RefreshState = {
          ...v2.refresh,
          lastRefreshAtMs: nowMs,
          consecutiveFailures: 0,
          totalRefreshed: v2.refresh.totalRefreshed + 1,
          lastError: null,
          nextRetryAtMs: null,
          needsReconnect: false,
        };
        const recoveredOauth: ComposioV118OAuthEntry = {
          ...v2.oauth,
          state: 'connected',
          expiresAtMs: retry.newExpiresAtMs,
          autoRefreshAttempts: 0,
          updatedAtMs: nowMs,
          lastReason: 'token refreshed with previous (grace) token',
        };
        return {
          ...base,
          outcome: 'refreshed',
          usedPreviousToken: true,
          errorKind: null,
          attempts: totalAttempts,
          oauth: recoveredOauth,
          refreshV2: recoveredV2,
          refreshV3: {
            ...base.refreshV3,
            previousTokenExpiresAtMs: null,
            previousTokenRetries: refreshV3.previousTokenRetries + 1,
            lastErrorKind: null,
            rateLimitedUntilMs: null,
          },
        };
      } catch (err) {
        // Token cu cung hong → ket luan revoked: xoa ca hai.
        purgeComposioV120RefreshTokens(deps.vault, oauth.connectionId);
        const message = err instanceof Error ? err.message : String(err);
        const kind = classifyComposioV120RefreshError(message);
        const revokedOauth: ComposioV118OAuthEntry = {
          ...v2.oauth,
          state: 'revoked',
          updatedAtMs: nowMs,
          lastReason: 'refresh failed with current and previous tokens — access revoked',
        };
        return {
          ...base,
          outcome: 'revoked',
          usedPreviousToken: false,
          errorKind: kind === 'revoked' ? 'revoked' : 'invalid-grant',
          attempts: totalAttempts,
          oauth: revokedOauth,
          refreshV2: {
            ...v2.refresh,
            consecutiveFailures: v2.refresh.consecutiveFailures + 1,
            totalFailed: v2.refresh.totalFailed + 1,
            lastFailureAtMs: nowMs,
            lastError: message,
            nextRetryAtMs: null,
            needsReconnect: true,
          },
          refreshV3: {
            ...base.refreshV3,
            previousTokenExpiresAtMs: null,
            previousTokenRetries: refreshV3.previousTokenRetries + 1,
            lastErrorKind: 'invalid-grant',
            rateLimitedUntilMs: null,
          },
        };
      }
    }
  }

  // Loi khac (transient/unknown hoac het luot thu token cu):
  // giu ket qua v2, ghi loai loi de chu ky sau biet.
  return {
    ...base,
    outcome: 'failed',
    usedPreviousToken: false,
    errorKind,
    attempts: totalAttempts,
    oauth: v2.oauth,
    refreshV2: v2.refresh,
    refreshV3: { ...base.refreshV3, lastErrorKind: errorKind },
  };
}

/** Hash xac dinh (khong crypto) tu connectionId — de tinh jitter lich. */
export function hashComposioV120ConnectionId(connectionId: string): number {
  let hash = 0;
  for (let i = 0; i < connectionId.length; i += 1) {
    hash = (hash * 31 + connectionId.charCodeAt(i)) | 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Chu ky refresh: quet nhieu connection, loi cach ly theo connection
// ---------------------------------------------------------------------------

/** Dau vao mot connection cho chu ky refresh. */
export interface ComposioV120CycleConnection {
  oauth: ComposioV118OAuthEntry;
  refreshV2: ComposioV119RefreshState;
  refreshV3: ComposioV120RefreshState;
}

/** Ket qua mot chu ky refresh. */
export interface ComposioV120RefreshCycleResult {
  /** ms epoch chu ky chay. */
  atMs: number;
  /** So connection da xet. */
  checked: number;
  /** So connection da refresh thanh cong. */
  refreshed: number;
  /** So connection khong can refresh. */
  notNeeded: number;
  /** So connection that bai (con retry duoc). */
  failed: number;
  /** So connection bi thu hoi / het token (can ket noi lai). */
  needsReconnect: number;
  /** Ket qua tung connection (theo thu tu gap giam dan). */
  results: ComposioV120RefreshConnectionResult[];
  /** Id cycle (de log/trace). */
  cycleId: string;
}

/**
 * Chay mot chu ky refresh cho nhieu connection:
 * - Sap xep theo muc do gap (token sap het han nhat truoc;
 *   khong biet han xep cuoi).
 * - Gioi han so connection moi chu ky (neu lich dat).
 * - Moi connection loi khong chan connection khac: loi bat
 *   ngoai du kien (vd vault hong) ghi thanh ket qua 'failed'
 *   voi errorKind 'unknown' thay vi nem.
 * - Tra ve bao cao chu ky de UI/log nam duoc.
 */
export async function runComposioV120RefreshCycle(
  connections: ComposioV120CycleConnection[],
  deps: {
    vault: ComposioV119RefreshTokenVault;
    refreshFn: (connectionId: string, refreshToken: string) => Promise<{
      newExpiresAtMs: number;
      newRefreshToken?: string | null;
      revoked?: boolean;
    }>;
    schedule?: Partial<ComposioV120RefreshSchedule>;
    policy?: Partial<ComposioV119RefreshPolicy>;
    nowMs?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    rateLimitRetryAfterMs?: number;
  },
): Promise<ComposioV120RefreshCycleResult> {
  const schedule = validateComposioV120RefreshSchedule(deps.schedule);
  const nowMs = deps.nowMs ?? Date.now();
  const sorted = [...connections].sort((a, b) => {
    const ua = composioV120RefreshUrgencyMs(a.oauth, schedule, nowMs);
    const ub = composioV120RefreshUrgencyMs(b.oauth, schedule, nowMs);
    if (ua === null && ub === null) return 0;
    if (ua === null) return 1;
    if (ub === null) return -1;
    return ua - ub;
  });
  const limited =
    schedule.maxConnectionsPerCycle > 0 ? sorted.slice(0, schedule.maxConnectionsPerCycle) : sorted;

  const results: ComposioV120RefreshConnectionResult[] = [];
  for (const conn of limited) {
    try {
      const r = await attemptComposioV120Refresh(conn.oauth, conn.refreshV2, conn.refreshV3, {
        vault: deps.vault,
        refreshFn: deps.refreshFn,
        schedule,
        policy: deps.policy,
        nowMs,
        sleep: deps.sleep,
        random: deps.random,
        rateLimitRetryAfterMs: deps.rateLimitRetryAfterMs,
      });
      results.push(r);
    } catch (err) {
      // Loi bat ngoai du kien (vd vault hong): cach ly, ghi failed.
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        connectionId: conn.oauth.connectionId,
        toolkit: conn.oauth.toolkit,
        outcome: 'failed',
        usedPreviousToken: false,
        errorKind: 'unknown',
        attempts: 0,
        oauth: conn.oauth,
        refreshV2: {
          ...conn.refreshV2,
          lastFailureAtMs: nowMs,
          consecutiveFailures: conn.refreshV2.consecutiveFailures + 1,
          totalFailed: conn.refreshV2.totalFailed + 1,
          lastError: message,
        },
        refreshV3: { ...conn.refreshV3, lastCycleCheckedAtMs: nowMs, lastErrorKind: 'unknown' },
      });
    }
  }

  const refreshed = results.filter((r) => r.outcome === 'refreshed').length;
  const notNeeded = results.filter((r) => r.outcome === 'not-needed').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  const needsReconnect = results.filter((r) => r.outcome === 'revoked' || r.outcome === 'no-token').length;
  return {
    atMs: nowMs,
    checked: results.length,
    refreshed,
    notNeeded,
    failed,
    needsReconnect,
    results,
    cycleId: `rfc120-${crypto.randomUUID()}`,
  };
}

/** Reset v3 sau khi user ket noi lai: xoa token grace + trang thai loi. */
export function resetComposioV120Refresh(
  refreshV3: ComposioV120RefreshState,
  vault: ComposioV119RefreshTokenVault,
): ComposioV120RefreshState {
  validateComposioV120RefreshState(refreshV3);
  deleteComposioV120PreviousRefreshToken(vault, refreshV3.connectionId);
  return {
    ...refreshV3,
    previousTokenExpiresAtMs: null,
    previousTokenRetries: 0,
    lastErrorKind: null,
    rateLimitedUntilMs: null,
    lastCycleCheckedAtMs: null,
  };
}

/** Tom tat mot chu ky refresh (1 dong) cho UI/log. */
export function summarizeComposioV120RefreshCycle(result: ComposioV120RefreshCycleResult): string {
  return `refresh cycle ${new Date(result.atMs).toISOString()}: ${result.checked} checked, ${result.refreshed} refreshed, ${result.notNeeded} not needed, ${result.failed} failed, ${result.needsReconnect} need reconnect.`;
}

/** Tao state v2 moi cho mot connection (tien ich — dung chung voi v3). */
export function createComposioV120RefreshStatePair(
  connectionId: string,
  toolkit: string,
): { refreshV2: ComposioV119RefreshState; refreshV3: ComposioV120RefreshState } {
  return {
    refreshV2: createComposioV119RefreshState(connectionId, toolkit),
    refreshV3: createComposioV120RefreshState(connectionId),
  };
}

/** Re-export tien ich v2 ma host v3 hay dung kem (de import 1 cho). */
export { hasComposioV119RefreshToken };
