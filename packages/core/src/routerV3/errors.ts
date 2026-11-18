/**
 * Normalised provider errors (v1.18, Doi T3) — LiteLLM-style.
 *
 * Moi provider tra loi theo cach rieng (HTTP status + body JSON/HTML
 * khac nhau); router chi can biet: loai loi la gi, co retry duoc
 * khong, co nen chuyen fallback ngay khong. Module nay chuan hoa tat
 * ca ve mot dang `RouterV3Error` — thuan, khong I/O, test truc tiep.
 *
 * Quy tac phan loai (theo status truoc, body sau):
 * - 401 / 403 (sai key / het quyen) -> 'auth', khong retry.
 * - 402 / 403 quota / 429 -> 'rate-limit' (retry sau Retry-After) /
 *   'quota' (het han muc, khong retry trong lan nay).
 * - 404 model khong ton tai -> 'not-found', khong retry.
 * - 400 -> 'invalid-request' (truyen sai tham so / context qua dai
 *   thi la 'context-overflow' khi body noi vay), khong retry.
 * - 408 / 499 / 504 / timeout fetch -> 'timeout', retry duoc.
 * - 5xx -> 'server', retry duoc.
 * - Khong ket noi duoc (ECONNREFUSED / fetch throw) -> 'network', retry duoc.
 * - 422 content-filter / safety -> 'content-filter', khong retry.
 * - Con lai -> 'unknown', khong retry (an toan hon retry vo ich).
 *
 * Khong bao gio dua API key / token vao message (body bi cat 300 ky tu).
 */

import type { RouterV3Attempt } from './types';

/** Loai loi chuan hoa cua router v3. */
export type RouterErrorKind =
  | 'rate-limit'
  | 'quota'
  | 'auth'
  | 'not-found'
  | 'invalid-request'
  | 'context-overflow'
  | 'content-filter'
  | 'timeout'
  | 'server'
  | 'network'
  | 'aborted'
  | 'unknown';

/** Loi provider da chuan hoa. */
export interface RouterV3Error {
  kind: RouterErrorKind;
  /** HTTP status (undefined khi loi mang/timeout truoc khi co response). */
  status?: number;
  /** Provider da gay loi. */
  providerId: string;
  /** Message ngan gon, an toan hien UI (da cat, khong secret). */
  message: string;
  /** true = thu lai (cung provider) co ich. */
  retryable: boolean;
  /** So giay server yeu cau doi (Retry-After), neu co. */
  retryAfterSeconds?: number;
}

/** Loai loi nao duoc retry (cung provider, co backoff). */
export const RETRYABLE_ERROR_KINDS: ReadonlySet<RouterErrorKind> = new Set([
  'rate-limit',
  'timeout',
  'server',
  'network',
]);

/** Loai loi nao nen chuyen fallback ngay (khong retry cung provider). */
export const FALLBACK_IMMEDIATE_KINDS: ReadonlySet<RouterErrorKind> = new Set([
  'auth',
  'not-found',
  'invalid-request',
  'context-overflow',
  'content-filter',
  'quota',
]);

/** Cat body loi ve toi da `max` ky tu (body HTML dai khong lam tran log). */
export function truncateRouterErrorText(text: string, max = 300): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Doc Retry-After tu header (giay) — tra undefined khi khong co / khong hop le. */
export function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600) return Math.ceil(seconds);
  // Dang HTTP-date: doi den thoi diem do (cap 1h).
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const diff = Math.ceil((dateMs - Date.now()) / 1000);
    if (diff >= 0 && diff <= 3600) return diff;
  }
  return undefined;
}

/** Dau hieu body noi ve het quota (phan biet voi rate-limit thuan). */
const QUOTA_MARKERS = [
  'quota',
  'insufficient_quota',
  'exceeded your current quota',
  'billing',
  'credit balance',
  'out of credits',
  'payment required',
  'usage limit',
];

/** Dau hieu body noi ve context qua dai. */
const CONTEXT_OVERFLOW_MARKERS = [
  'context_length_exceeded',
  'context length',
  'maximum context length',
  'too long',
  'input too long',
  'prompt too long',
  'max_tokens',
];

/** Dau hieu body noi ve content filter / safety. */
const CONTENT_FILTER_MARKERS = [
  'content_filter',
  'content filter',
  'safety',
  'blocked by',
  'harmful',
  'policy violation',
];

/** Dau hieu body noi ve model khong ton tai. */
const NOT_FOUND_MARKERS = ['model_not_found', 'model not found', 'does not exist', 'unknown model', 'no such model'];

/** Kiem tra body co chua mot trong cac marker (khong phan biet hoa/thuong). */
function bodyContains(body: string, markers: string[]): boolean {
  const lower = body.toLowerCase();
  return markers.some((m) => lower.includes(m));
}

/**
 * Phan loai loi tu HTTP status + body (thuan). `providerId` chi de
 * gan nhan; khong dua vao quyet dinh phan loai.
 */
export function classifyProviderError(
  providerId: string,
  status: number | undefined,
  bodyText: string,
  retryAfterSeconds?: number,
): RouterV3Error {
  const body = truncateRouterErrorText(bodyText ?? '');
  const label = providerId || 'provider';
  if (status === undefined) {
    return { kind: 'network', providerId, message: `${label}: khong ket noi duoc toi provider.`, retryable: true };
  }
  if (status === 429) {
    if (bodyContains(body, QUOTA_MARKERS)) {
      return { kind: 'quota', status, providerId, message: `${label}: het han muc su dung (quota) — nap them hoac doi chu ky moi.`, retryable: false };
    }
    return {
      kind: 'rate-limit',
      status,
      providerId,
      message: `${label}: bi gioi han toc do (429) — thu lai sau vai giay.`,
      retryable: true,
      retryAfterSeconds,
    };
  }
  if (status === 402 || bodyContains(body, QUOTA_MARKERS)) {
    return { kind: 'quota', status, providerId, message: `${label}: het han muc su dung (quota) — nap them hoac doi chu ky moi.`, retryable: false };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, providerId, message: `${label}: sai key hoac khong co quyen (HTTP ${status}) — kiem tra key trong Settings.`, retryable: false };
  }
  if (status === 404 || bodyContains(body, NOT_FOUND_MARKERS)) {
    return { kind: 'not-found', status, providerId, message: `${label}: model khong ton tai tren provider (HTTP ${status}) — chon model khac.`, retryable: false };
  }
  if (status === 400) {
    if (bodyContains(body, CONTEXT_OVERFLOW_MARKERS)) {
      return { kind: 'context-overflow', status, providerId, message: `${label}: prompt vuot qua context window — rut ngan prompt hoac chon model context dai hon.`, retryable: false };
    }
    if (bodyContains(body, CONTENT_FILTER_MARKERS)) {
      return { kind: 'content-filter', status, providerId, message: `${label}: noi dung bi chan boi bo loc an toan.`, retryable: false };
    }
    return { kind: 'invalid-request', status, providerId, message: `${label}: request khong hop le (HTTP 400) — ${body || 'khong ro ly do'}.`, retryable: false };
  }
  if (status === 422) {
    if (bodyContains(body, CONTENT_FILTER_MARKERS)) {
      return { kind: 'content-filter', status, providerId, message: `${label}: noi dung bi chan boi bo loc an toan.`, retryable: false };
    }
    return { kind: 'invalid-request', status, providerId, message: `${label}: request khong hop le (HTTP 422) — ${body || 'khong ro ly do'}.`, retryable: false };
  }
  if (status === 408 || status === 499 || status === 504) {
    return { kind: 'timeout', status, providerId, message: `${label}: het thoi gian cho phan hoi (HTTP ${status}) — thu lai.`, retryable: true };
  }
  if (status >= 500) {
    return { kind: 'server', status, providerId, message: `${label}: loi phia provider (HTTP ${status}) — thu lai sau.`, retryable: true };
  }
  return { kind: 'unknown', status, providerId, message: `${label}: loi khong xac dinh (HTTP ${status}) — ${body || 'khong ro ly do'}.`, retryable: false };
}

/**
 * Phan loai loi tu mot Error / gia tri throw cua fetch (thuan):
 * AbortError -> 'aborted', TimeoutError -> 'timeout', con lai -> 'network'.
 */
export function classifyFetchError(providerId: string, error: unknown): RouterV3Error {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { kind: 'aborted', providerId, message: `${providerId || 'provider'}: yeu cau da bi huy.`, retryable: false };
    }
    if (error.name === 'TimeoutError') {
      return { kind: 'timeout', providerId, message: `${providerId || 'provider'}: het thoi gian cho phan hoi — thu lai.`, retryable: true };
    }
    return {
      kind: 'network',
      providerId,
      message: `${providerId || 'provider'}: loi mang — ${truncateRouterErrorText(error.message)}`,
      retryable: true,
    };
  }
  return { kind: 'network', providerId, message: `${providerId || 'provider'}: loi mang khong xac dinh.`, retryable: true };
}

/**
 * Delay backoff giua cac retry (ms): exponential `base * 2^attempt`,
 * cap o `max`. Khong jitter ngau nhien — xac dinh de test duoc;
 * nhieu worker cung retry thi jitter them o tang goi neu can.
 *
 * LUU Y: barrel `@open-bot/core` export mot `retryDelayMs` khac
 * (mcp/tasksRunner.ts, nhan TaskRetryPolicy + random) qua explicit
 * export — ten nay KHONG phai ham nay khi import tu barrel. Code
 * router v3 (va test) import truc tiep tu module nay (`./errors`).
 */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt < 0) attempt = 0;
  const delay = baseMs * 2 ** attempt;
  return Math.min(maxMs, Math.max(0, delay));
}

/**
 * Co nen retry loi nay khong (cung provider, lan thu `attempt` chua
 * vuot `maxRetries`).
 */
export function shouldRetry(error: RouterV3Error, attempt: number, maxRetries: number): boolean {
  return error.retryable && attempt < maxRetries;
}

/**
 * Huong dan tong khi fallback chain v3 that bai het — dua tren loai
 * loi tung buoc (giong fallback v2, mo rong them auth/quota).
 */
export function buildRouterV3FailureGuidance(attempts: RouterV3Attempt[]): string {
  if (attempts.length === 0) return 'Chua co provider nao duoc cau hinh — them provider, bat nguon local, hoac kiem tra lai cau hinh router.';
  const failed = attempts.filter((a) => a.outcome === 'failed');
  const circuit = attempts.filter((a) => a.outcome === 'skipped-circuit-open');
  const capability = attempts.filter((a) => a.outcome === 'skipped-capability');
  const disabled = attempts.filter((a) => a.outcome === 'skipped-disabled');
  const parts: string[] = ['Tat ca provider deu khong tra loi duoc.'];
  const kinds = new Set(failed.map((a) => a.errorKind).filter((k): k is string => typeof k === 'string'));
  if (kinds.has('auth')) parts.push('Co provider bao sai key — kiem tra key trong Settings → Provider.');
  if (kinds.has('quota')) parts.push('Co provider het quota — nap them hoac doi chu ky moi, hoac chuyen sang model local mien phi.');
  if (kinds.has('rate-limit')) parts.push('Co provider bi gioi han toc do — doi vai giay roi thu lai.');
  if (kinds.has('not-found')) parts.push('Co model khong ton tai tren provider — chon model khac trong danh sach model cua provider do.');
  if (kinds.has('context-overflow')) parts.push('Prompt vuot context window — rut ngan prompt hoac chon model context dai hon.');
  if (circuit.length > 0) {
    parts.push(`Provider ${circuit.map((a) => a.providerId).join(', ')} dang bi circuit breaker mo sau nhieu loi lien tiep — cho 1 phut roi thu lai.`);
  }
  if (capability.length > 0) {
    parts.push(`Provider ${capability.map((a) => a.providerId).join(', ')} bi bo qua vi model khong du capability task can — chon model khac.`);
  }
  if (disabled.length > 0 && disabled.length === attempts.length) {
    parts.push('Tat ca provider dang bi tat — bat it nhat mot provider trong Settings → Router.');
  }
  if (failed.length > 0) {
    parts.push(`Loi tung provider: ${failed.map((a) => `${a.providerId} (${a.errorKind ?? 'unknown'}: ${a.error ?? 'khong ro'})`).join('; ')}.`);
  }
  parts.push('Neu van loi, thu model local (Ollama / vLLM / LM Studio) de chay offline hoan toan.');
  return parts.join(' ');
}
