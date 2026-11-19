/**
 * Fallback chain v30 (v1.44, Doi T5) — chuyen provider khi chinh loi.
 *
 * Noi tiep fallback v29: v30 them
 * - phan loai loi (retryable vs fatal) de biet khi nao nen fallback:
 *   429 / 5xx / timeout / network -> fallback; 401 / 403 / 404 /
 *   model-not-found -> dung ngay (doi provider cung loi y het).
 * - gioi han so lan: moi buoc co `maxAttempts`, ca chuoi co
 *   `maxTotalAttempts` (lay min voi policy.maxFallbackAttempts).
 * - cooldown theo buoc: buoc vua that thi nghi `cooldownMs` truoc khi
 *   duoc thu lai trong cung chuoi.
 * - decision log co cau truc (cap 200 muc) ghi lai moi lan thu:
 *   model nao, loi gi, co fallback khong, ly do.
 *
 * Executor la ham host truyen vao (goi model that hoac mock trong test).
 * File nay KHONG goi model that, KHONG doc credential.
 */
import { entryKeyV30, modelCatalogKeyV30 } from './modelCatalogV30';

/** Loai loi provider — quyet dinh co fallback hay khong. */
export type ProviderErrorKindV30 =
  | 'rate-limited'
  | 'server-error'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'not-found'
  | 'invalid-request'
  | 'unknown';

/** Loi provider da phan loai. */
export interface ClassifiedProviderErrorV30 {
  kind: ProviderErrorKindV30;
  /** Co nen thu provider tiep theo khong. */
  retryable: boolean;
  /** Ma loi goc (HTTP status hoac code). */
  code?: string | number;
  /** Thong diep goc. */
  message: string;
}

/** Phan loai loi tu status/code/message (khong phu thuoc provider cu the). */
export function classifyProviderErrorV30(
  error: { status?: number; code?: string | number; message?: string } | string,
): ClassifiedProviderErrorV30 {
  const raw = typeof error === 'string' ? { message: error } : error;
  const message = raw.message ?? String(error);
  const code = raw.code;
  const status = raw.status;
  const lower = `${message} ${code ?? ''}`.toLowerCase();

  if (status === 429 || lower.includes('rate limit') || lower.includes('429')) {
    return { kind: 'rate-limited', retryable: true, code: status ?? code, message };
  }
  if (status === 401 || status === 403 || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('authentication')) {
    return { kind: 'auth', retryable: false, code: status ?? code, message };
  }
  if (status === 404 || lower.includes('model not found') || lower.includes('not_found')) {
    return { kind: 'not-found', retryable: false, code: status ?? code, message };
  }
  if (status === 400 || lower.includes('invalid request') || lower.includes('bad request')) {
    return { kind: 'invalid-request', retryable: false, code: status ?? code, message };
  }
  if (
    status === 408 ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('deadline exceeded')
  ) {
    return { kind: 'timeout', retryable: true, code: status ?? code, message };
  }
  if (
    status !== undefined && status >= 500 && status < 600
  ) {
    return { kind: 'server-error', retryable: true, code: status, message };
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('socket hang up')
  ) {
    return { kind: 'network', retryable: true, code, message };
  }
  return { kind: 'unknown', retryable: false, code, message };
}

/** Mot buoc trong fallback chain. */
export interface FallbackStepV30 {
  provider: string;
  modelId: string;
  /** So lan thu toi da o buoc nay (mac dinh 1). */
  maxAttempts?: number;
  /** Nghi bao lau (ms) sau khi buoc nay that truoc khi thu lai. */
  cooldownMs?: number;
}

/** Mot fallback chain co ten. */
export interface FallbackChainV30 {
  name: string;
  steps: FallbackStepV30[];
  /** Tong so lan thu toi da ca chuoi (mac dinh = tong maxAttempts). */
  maxTotalAttempts?: number;
}

/** Khoa cua 1 buoc. */
export function fallbackStepKeyV30(step: FallbackStepV30): string {
  return entryKeyV30({ provider: step.provider, modelId: step.modelId } as never);
}

/** Chain mac dinh: model chinh -> model re cung provider -> local mien phi. */
export function buildDefaultFallbackChainV30(
  primaryProvider: string,
  primaryModelId: string,
  cheapProvider = 'ollama',
  cheapModelId = 'llama-4-scout',
): FallbackChainV30 {
  const steps: FallbackStepV30[] = [];
  const seen = new Set<string>();
  const push = (provider: string, modelId: string) => {
    const key = modelCatalogKeyV30(provider, modelId);
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ provider, modelId, maxAttempts: 1 });
  };
  push(primaryProvider, primaryModelId);
  push(cheapProvider, cheapModelId);
  push('local', 'local-echo');
  return { name: `default-${primaryProvider}-${primaryModelId}`, steps };
}

/** Validate chain — tra loi (rong = hop le). */
export function validateFallbackChainV30(chain: unknown): string[] {
  const errors: string[] = [];
  if (!chain || typeof chain !== 'object') return ['chain must be an object'];
  const c = chain as Partial<FallbackChainV30>;
  if (!c.name || typeof c.name !== 'string') errors.push('name is required');
  if (!Array.isArray(c.steps) || c.steps.length === 0) {
    errors.push('steps must be a non-empty array');
    return errors;
  }
  const seen = new Set<string>();
  for (const [i, s] of c.steps.entries()) {
    if (!s?.provider || !s?.modelId) {
      errors.push(`steps[${i}] needs provider + modelId`);
      continue;
    }
    const key = fallbackStepKeyV30(s);
    if (seen.has(key)) errors.push(`steps[${i}] duplicates ${key}`);
    seen.add(key);
    if (s.maxAttempts !== undefined && (!Number.isInteger(s.maxAttempts) || s.maxAttempts < 1 || s.maxAttempts > 5)) {
      errors.push(`steps[${i}].maxAttempts must be 1..5`);
    }
    if (s.cooldownMs !== undefined && (s.cooldownMs < 0 || s.cooldownMs > 600_000)) {
      errors.push(`steps[${i}].cooldownMs must be 0..600000`);
    }
  }
  if (
    c.maxTotalAttempts !== undefined &&
    (!Number.isInteger(c.maxTotalAttempts) || c.maxTotalAttempts < 1 || c.maxTotalAttempts > 20)
  ) {
    errors.push('maxTotalAttempts must be 1..20');
  }
  return errors;
}

/** Ke hoach fallback (tinh truoc khi chay — de UI hien thi). */
export interface FallbackPlanV30 {
  chainName: string;
  steps: FallbackStepV30[];
  totalAttempts: number;
  /** Buoc nao bi bo qua vi dang cooldown (neu co). */
  skippedCoolingDown: string[];
  /** Tong so buoc. */
  stepCount: number;
}

/** Lap ke hoach chay chain: tinh tong so lan thu + bo buoc dang cooldown. */
export function planFallbackV30(
  chain: FallbackChainV30,
  cooldownUntilByKey: Map<string, number> = new Map(),
  now = Date.now(),
): FallbackPlanV30 {
  const skippedCoolingDown: string[] = [];
  const steps: FallbackStepV30[] = [];
  for (const step of chain.steps) {
    const until = cooldownUntilByKey.get(fallbackStepKeyV30(step)) ?? 0;
    if (until > now) {
      skippedCoolingDown.push(fallbackStepKeyV30(step));
      continue;
    }
    steps.push(step);
  }
  const totalAttempts = steps.reduce(
    (sum, s) => sum + (s.maxAttempts ?? 1),
    0,
  );
  return {
    chainName: chain.name,
    steps,
    totalAttempts: chain.maxTotalAttempts
      ? Math.min(totalAttempts, chain.maxTotalAttempts)
      : totalAttempts,
    skippedCoolingDown,
    stepCount: steps.length,
  };
}

/** Mot muc trong decision log. */
export interface FallbackDecisionV30 {
  /** Luc ghi (epoch ms). */
  at: number;
  /** Ten chain. */
  chainName: string;
  /** Buoc vua thu. */
  stepKey: string;
  /** Lan thu thu may o buoc nay (1-based). */
  attempt: number;
  /** Ket qua: thanh cong / that (retryable) / that (fatal) / bo qua. */
  outcome: 'success' | 'failed-retryable' | 'failed-fatal' | 'skipped-cooldown';
  /** Loai loi (neu that). */
  errorKind?: ProviderErrorKindV30;
  /** Thong diep loi (neu that). */
  errorMessage?: string;
  /** Sau muc nay co chuyen buoc tiep theo khong. */
  movedToNext: boolean;
}

/** So muc toi da trong decision log. */
export const MAX_FALLBACK_LOG_ENTRIES_V30 = 200;

/** Decision log co cap — host giu 1 instance, doc qua `entries`. */
export class FallbackDecisionLogV30 {
  private log: FallbackDecisionV30[] = [];

  record(entry: FallbackDecisionV30): void {
    this.log.push(entry);
    if (this.log.length > MAX_FALLBACK_LOG_ENTRIES_V30) {
      this.log.splice(0, this.log.length - MAX_FALLBACK_LOG_ENTRIES_V30);
    }
  }

  get entries(): FallbackDecisionV30[] {
    return [...this.log];
  }

  get length(): number {
    return this.log.length;
  }

  /** So lan fallback da dung trong N muc gan nhat. */
  fallbackCount(): number {
    return this.log.filter((e) => e.movedToNext).length;
  }

  /** Model nao that nhieu nhat (de UI canh bao). */
  mostFailedModel(): { stepKey: string; failures: number } | null {
    const counts = new Map<string, number>();
    for (const e of this.log) {
      if (e.outcome === 'failed-retryable' || e.outcome === 'failed-fatal') {
        counts.set(e.stepKey, (counts.get(e.stepKey) ?? 0) + 1);
      }
    }
    let best: { stepKey: string; failures: number } | null = null;
    for (const [stepKey, failures] of counts) {
      if (!best || failures > best.failures) best = { stepKey, failures };
    }
    return best;
  }

  clear(): void {
    this.log = [];
  }
}

/** Ket qua chay 1 buoc (executor tra ve). */
export type FallbackExecutorV30<T = unknown> = (
  step: FallbackStepV30,
  attempt: number,
) => Promise<{ ok: boolean; value?: T; error?: { status?: number; code?: string | number; message?: string } | string }>;

/** Ket qua chay ca chain. */
export interface FallbackRunResultV30<T = unknown> {
  ok: boolean;
  /** Gia tri executor tra ve (neu thanh cong). */
  value?: T;
  /** Buoc da thanh cong (neu co). */
  succeededStep?: FallbackStepV30;
  /** Tong so lan da thu. */
  attemptsMade: number;
  /** Loi cuoi cung (neu that het). */
  lastError?: ClassifiedProviderErrorV30;
  /** Cac buoc da thu (theo thu tu). */
  triedSteps: string[];
}

/**
 * Chay fallback chain voi executor host truyen vao.
 *
 * - Moi buoc thu toi da `maxAttempts` lan; loi fatal (401/404/...) thi
 *   dung ca chuoi ngay (doi buoc cung loi y het).
 * - Loi retryable thi sang buoc tiep theo; het chuoi -> that.
 * - `maxTotalAttempts` (chain hoac policy) gioi han tong so lan thu.
 * - Moi lan thu deu ghi vao `log` (neu co).
 */
export async function runFallbackChainV30<T = unknown>(
  chain: FallbackChainV30,
  executor: FallbackExecutorV30<T>,
  options: {
    maxTotalAttempts?: number;
    log?: FallbackDecisionLogV30;
    now?: number;
  } = {},
): Promise<FallbackRunResultV30<T>> {
  const errors = validateFallbackChainV30(chain);
  if (errors.length > 0) {
    throw new Error(`invalid fallback chain: ${errors.join('; ')}`);
  }
  const now = options.now ?? Date.now();
  const cap =
    options.maxTotalAttempts ??
    chain.maxTotalAttempts ??
    chain.steps.reduce((s, step) => s + (step.maxAttempts ?? 1), 0);
  const triedSteps: string[] = [];
  let attemptsMade = 0;
  let lastError: ClassifiedProviderErrorV30 | undefined;

  for (const step of chain.steps) {
    const key = fallbackStepKeyV30(step);
    const maxAttempts = step.maxAttempts ?? 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attemptsMade >= cap) {
        return { ok: false, attemptsMade, lastError, triedSteps };
      }
      attemptsMade += 1;
      triedSteps.push(key);
      const result = await executor(step, attempt);
      if (result.ok) {
        options.log?.record({
          at: now,
          chainName: chain.name,
          stepKey: key,
          attempt,
          outcome: 'success',
          movedToNext: false,
        });
        return {
          ok: true,
          value: result.value,
          succeededStep: step,
          attemptsMade,
          triedSteps,
        };
      }
      const classified = classifyProviderErrorV30(
        result.error ?? 'unknown error',
      );
      lastError = classified;
      const isLastAttemptOfStep = attempt === maxAttempts;
      options.log?.record({
        at: now,
        chainName: chain.name,
        stepKey: key,
        attempt,
        outcome: classified.retryable ? 'failed-retryable' : 'failed-fatal',
        errorKind: classified.kind,
        errorMessage: classified.message,
        movedToNext: classified.retryable,
      });
      if (!classified.retryable) {
        return { ok: false, attemptsMade, lastError, triedSteps };
      }
      if (!isLastAttemptOfStep) continue;
      break;
    }
  }
  return { ok: false, attemptsMade, lastError, triedSteps };
}
