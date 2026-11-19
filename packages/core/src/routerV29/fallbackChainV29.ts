/**
 * Fallback chain v29 (v1.42, Doi T5).
 *
 * Khi provider/model loi, thu model tiep theo theo thu tu uu tien va
 * ghi ro ly do moi lan fallback. Executor duoc host inject (mock
 * trong test / tool) — file nay KHONG goi API live that.
 *
 * Phan loai loi: rate-limit / auth / server / timeout / not-found /
 * invalid-request / unknown; chi rate-limit, server, timeout duoc
 * retry sang model khac (auth / invalid-request la loi cau hinh,
 * thu model khac cung loi — van ghi vao attempt nhung dung lai).
 */

import type { ModelCatalogEntryV29 } from './modelCatalogV29';

/** Loai loi provider (sau khi phan loai). */
export type ProviderErrorKindV29 =
  | 'rate-limit'
  | 'auth'
  | 'server'
  | 'timeout'
  | 'not-found'
  | 'invalid-request'
  | 'unknown';

/** Mot buoc trong chain fallback. */
export interface FallbackStepV29 {
  modelId: string;
  provider: string;
  /** Ly do uu tien buoc nay (vd 're nhat trong nhom realtime'). */
  reason?: string;
}

/** Cau hinh mot fallback chain. */
export interface FallbackChainConfigV29 {
  chainId: string;
  steps: FallbackStepV29[];
  /** So lan thu toi da (mac dinh = so buoc). */
  maxAttempts?: number;
  /** Ghi chu cho nguoi van hanh. */
  notes?: string;
}

/** Ket qua validate chain. */
export interface FallbackChainValidationV29 {
  ok: boolean;
  errors: string[];
}

/** Validate chain (thuan). */
export function validateFallbackChainV29(config: FallbackChainConfigV29): FallbackChainValidationV29 {
  const errors: string[] = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['config phai la object.'] };
  if (!config.chainId || config.chainId.trim() === '') errors.push('chainId khong duoc rong.');
  if (!Array.isArray(config.steps) || config.steps.length === 0) {
    errors.push('steps phai la array khong rong.');
    return { ok: false, errors };
  }
  const seen = new Set<string>();
  config.steps.forEach((step, i) => {
    if (!step || typeof step !== 'object') {
      errors.push(`steps[${i}] phai la object.`);
      return;
    }
    if (!step.modelId || step.modelId.trim() === '') errors.push(`steps[${i}].modelId khong duoc rong.`);
    if (!step.provider || step.provider.trim() === '') errors.push(`steps[${i}].provider khong duoc rong.`);
    if (step.modelId && seen.has(step.modelId)) errors.push(`modelId "${step.modelId}" lap lai trong chain.`);
    seen.add(step.modelId);
  });
  if (config.maxAttempts !== undefined) {
    if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) {
      errors.push('maxAttempts phai la so nguyen >= 1.');
    } else if (config.maxAttempts > config.steps.length) {
      errors.push('maxAttempts khong duoc lon hon so buoc.');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Phan loai loi provider tu HTTP status / message.
 * - 429 -> rate-limit; 401/403 -> auth; 5xx -> server;
 *   timeout (ETIMEDOUT / 'timeout' / AbortError) -> timeout;
 *   404 -> not-found; 400 -> invalid-request; con lai -> unknown.
 */
export function classifyProviderErrorV29(error: {
  status?: number;
  code?: string;
  message?: string;
}): ProviderErrorKindV29 {
  const status = error.status;
  const code = (error.code ?? '').toUpperCase();
  const message = (error.message ?? '').toLowerCase();
  if (status === 429) return 'rate-limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 400) return 'invalid-request';
  if (status !== undefined && status >= 500) return 'server';
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'ABORT_ERR' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted')
  ) {
    return 'timeout';
  }
  if (message.includes('rate limit') || message.includes('too many requests')) return 'rate-limit';
  if (message.includes('unauthorized') || message.includes('invalid api key') || message.includes('forbidden')) {
    return 'auth';
  }
  if (message.includes('not found') || message.includes('no such model')) return 'not-found';
  if (message.includes('bad request') || message.includes('invalid')) return 'invalid-request';
  if (message.includes('internal server error') || message.includes('overloaded') || message.includes('unavailable')) {
    return 'server';
  }
  return 'unknown';
}

/** Loi nao thi dang thu model khac (retryable). */
export function isRetryableProviderErrorV29(kind: ProviderErrorKindV29): boolean {
  return kind === 'rate-limit' || kind === 'server' || kind === 'timeout' || kind === 'unknown';
}

/** Ket qua mot lan thu goi model (do executor tra ve). */
export interface FallbackAttemptResultV29 {
  ok: boolean;
  output?: unknown;
  error?: { status?: number; code?: string; message?: string };
  latencyMs?: number;
}

/** Executor: host/mock goi that model; tra ok hoac loi. */
export type FallbackExecutorV29 = (
  modelId: string,
  provider: string,
  attemptIndex: number,
) => Promise<FallbackAttemptResultV29>;

/** Mot attempt da ghi trong lich su chay chain. */
export interface FallbackAttemptV29 {
  attemptIndex: number;
  modelId: string;
  provider: string;
  ok: boolean;
  errorKind?: ProviderErrorKindV29;
  errorMessage?: string;
  latencyMs: number;
  /** true = loi nay khong retry duoc, chain dung lai. */
  fatal?: boolean;
}

/** Ket qua chay het mot chain. */
export interface FallbackRunResultV29 {
  ok: boolean;
  chainId: string;
  /** Model cuoi cung tra ket qua (neu ok). */
  modelId: string | null;
  provider: string | null;
  output?: unknown;
  attempts: FallbackAttemptV29[];
  triedModelIds: string[];
  /** Ly do dung (neu that bai): 'all-failed' | 'fatal-error' | 'no-steps'. */
  gaveUpReason: string | null;
  totalLatencyMs: number;
  /** So lan fallback (so attempt - 1 khi ok, so attempt khi fail). */
  fallbackCount: number;
}

/**
 * Ke hoach fallback (thuan, khong chay): tu model loi + ly do, tra
 * cac buoc tiep theo con lai trong chain.
 */
export function planFallbackChainV29(
  config: FallbackChainConfigV29,
  failedModelId: string,
  error: { status?: number; code?: string; message?: string },
): {
  chainId: string;
  failedModelId: string;
  errorKind: ProviderErrorKindV29;
  retryable: boolean;
  nextSteps: FallbackStepV29[];
  reason: string;
} {
  const kind = classifyProviderErrorV29(error);
  const retryable = isRetryableProviderErrorV29(kind);
  const idx = config.steps.findIndex((s) => s.modelId === failedModelId);
  const remaining = idx >= 0 ? config.steps.slice(idx + 1) : [...config.steps];
  let reason: string;
  if (!retryable) {
    reason = `Loi ${kind} cua ${failedModelId} la loi cau hinh/quyen — thu model khac cung loi, dung lai.`;
  } else if (remaining.length === 0) {
    reason = `${failedModelId} loi ${kind} nhung khong con model nao trong chain.`;
  } else {
    reason = `${failedModelId} loi ${kind} (retry duoc) — fallback sang ${remaining[0].modelId}` +
      (remaining.length > 1 ? `, sau do ${remaining.slice(1).map((s) => s.modelId).join(', ')}.` : '.');
  }
  return {
    chainId: config.chainId,
    failedModelId,
    errorKind: kind,
    retryable,
    nextSteps: retryable ? remaining : [],
    reason,
  };
}

/**
 * Chay chain: thu tung buoc theo thu tu; loi retryable thi fallback,
 * loi fatal (auth / invalid-request / not-found) thi dung ngay.
 * Ghi moi attempt (model, loi, do tre) — lich su nay la bang chung
 * cho UI "da fallback vi sao".
 */
export async function runFallbackChainV29(
  config: FallbackChainConfigV29,
  executor: FallbackExecutorV29,
): Promise<FallbackRunResultV29> {
  const validation = validateFallbackChainV29(config);
  if (!validation.ok) {
    return {
      ok: false,
      chainId: config.chainId ?? '',
      modelId: null,
      provider: null,
      attempts: [],
      triedModelIds: [],
      gaveUpReason: 'invalid-config: ' + validation.errors.join('; '),
      totalLatencyMs: 0,
      fallbackCount: 0,
    };
  }
  const maxAttempts = config.maxAttempts ?? config.steps.length;
  const attempts: FallbackAttemptV29[] = [];
  let totalLatencyMs = 0;

  for (let i = 0; i < Math.min(maxAttempts, config.steps.length); i += 1) {
    const step = config.steps[i];
    let result: FallbackAttemptResultV29;
    try {
      result = await executor(step.modelId, step.provider, i);
    } catch (err) {
      result = { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
    const latencyMs = result.latencyMs ?? 0;
    totalLatencyMs += latencyMs;
    if (result.ok) {
      attempts.push({ attemptIndex: i, modelId: step.modelId, provider: step.provider, ok: true, latencyMs });
      return {
        ok: true,
        chainId: config.chainId,
        modelId: step.modelId,
        provider: step.provider,
        output: result.output,
        attempts,
        triedModelIds: attempts.map((a) => a.modelId),
        gaveUpReason: null,
        totalLatencyMs,
        fallbackCount: attempts.length - 1,
      };
    }
    const kind = classifyProviderErrorV29(result.error ?? {});
    const retryable = isRetryableProviderErrorV29(kind);
    attempts.push({
      attemptIndex: i,
      modelId: step.modelId,
      provider: step.provider,
      ok: false,
      errorKind: kind,
      errorMessage: result.error?.message ?? 'loi khong ro',
      latencyMs,
      fatal: !retryable,
    });
    if (!retryable) {
      return {
        ok: false,
        chainId: config.chainId,
        modelId: null,
        provider: null,
        attempts,
        triedModelIds: attempts.map((a) => a.modelId),
        gaveUpReason: `fatal-error (${kind}): ${result.error?.message ?? 'loi khong ro'}`,
        totalLatencyMs,
        fallbackCount: attempts.length,
      };
    }
  }

  return {
    ok: false,
    chainId: config.chainId,
    modelId: null,
    provider: null,
    attempts,
    triedModelIds: attempts.map((a) => a.modelId),
    gaveUpReason: 'all-failed: het model trong chain.',
    totalLatencyMs,
    fallbackCount: attempts.length,
  };
}

/** Xay chain mac dinh tu catalog: cung nhom (realtime/live) truoc, roi text re. */
export function buildDefaultFallbackChainV29(
  catalog: ModelCatalogEntryV29[],
  primaryModelId: string,
  chainId = 'default',
): FallbackChainConfigV29 {
  const primary = catalog.find((m) => m.modelId === primaryModelId);
  const steps: FallbackStepV29[] = [];
  if (primary) {
    steps.push({ modelId: primary.modelId, provider: primary.provider, reason: 'model chinh duoc chon.' });
    const sameKind = catalog
      .filter((m) => !m.deprecated && m.modelId !== primary.modelId && m.kind === primary.kind)
      .sort((a, b) => a.inputPricePer1kUsd - b.inputPricePer1kUsd || a.typicalLatencyMs - b.typicalLatencyMs);
    for (const m of sameKind.slice(0, 2)) {
      steps.push({ modelId: m.modelId, provider: m.provider, reason: `cung loai ${primary.kind}, re hon tiep theo.` });
    }
  }
  // Cuoi chain: text re nhat con ho tro (luon co the tra loi text).
  const cheapestText = catalog
    .filter((m) => !m.deprecated && m.kind === 'text' && !steps.some((s) => s.modelId === m.modelId))
    .sort((a, b) => a.inputPricePer1kUsd - b.inputPricePer1kUsd || a.typicalLatencyMs - b.typicalLatencyMs)[0];
  if (cheapestText) {
    steps.push({ modelId: cheapestText.modelId, provider: cheapestText.provider, reason: 'fallback cuoi: text re nhat.' });
  }
  return { chainId, steps };
}

/**
 * Registry chain + lich su chay gan nhat (in-memory, host luu neu can).
 */
export class FallbackChainRegistryV29 {
  private chains = new Map<string, FallbackChainConfigV29>();
  private lastRuns = new Map<string, FallbackRunResultV29>();

  register(config: FallbackChainConfigV29): FallbackChainValidationV29 {
    const validation = validateFallbackChainV29(config);
    if (!validation.ok) return validation;
    this.chains.set(config.chainId, config);
    return validation;
  }

  get(chainId: string): FallbackChainConfigV29 | undefined {
    return this.chains.get(chainId);
  }

  list(): FallbackChainConfigV29[] {
    return [...this.chains.values()];
  }

  remove(chainId: string): boolean {
    this.lastRuns.delete(chainId);
    return this.chains.delete(chainId);
  }

  recordRun(result: FallbackRunResultV29): void {
    this.lastRuns.set(result.chainId, result);
  }

  lastRun(chainId: string): FallbackRunResultV29 | undefined {
    return this.lastRuns.get(chainId);
  }

  /** Tom tat cac chain: id, so buoc, lan chay cuoi (ok/fail, model). */
  summary(): {
    chainId: string;
    steps: string[];
    lastRunOk: boolean | null;
    lastRunModelId: string | null;
    lastRunFallbacks: number | null;
  }[] {
    return this.list().map((c) => {
      const last = this.lastRuns.get(c.chainId);
      return {
        chainId: c.chainId,
        steps: c.steps.map((s) => s.modelId),
        lastRunOk: last ? last.ok : null,
        lastRunModelId: last ? last.modelId : null,
        lastRunFallbacks: last ? last.fallbackCount : null,
      };
    });
  }
}
