/**
 * Provider config v29 (v1.42, Doi T5) — cau hinh tung provider cho router.
 *
 * Moi provider co: bat/tat, thu tu uu tien, kieu xac thuc (api-key /
 * cli-login / oauth / none / local — CHI ten kieu, khong chua key hay
 * credential), gioi han toc do, timeout, so retry mac dinh. Router
 * dung config nay de loai provider bi tat, sap xep thu tu fallback
 * va lay timeout/retry mac dinh — khong goi API live, khong doc key.
 *
 * Khac registry v115/v116 (endpoint local + model): day la cau hinh
 * van hanh theo provider (chinh sach + gioi han), khong phai endpoint.
 */

/** Kieu xac thuc cua provider (chi ten kieu — khong chua secret). */
export type ProviderAuthKindV29 = 'api-key' | 'cli-login' | 'oauth' | 'none' | 'local';

/** Cau hinh mot provider. */
export interface ProviderConfigV29 {
  /** Id provider, vi du 'openai' (khop catalog). */
  provider: string;
  /** true = router duoc dung provider nay. */
  enabled: boolean;
  /** Thu tu uu tien (so nho hon duoc uu tien hon khi ngang diem). */
  priority: number;
  /** Kieu xac thuc (chi ten kieu). */
  authKind: ProviderAuthKindV29;
  /** Gioi han request/phut (0/undefined = khong gioi han khai bao). */
  rateLimitPerMin?: number;
  /** Timeout mac dinh cho mot request (ms). */
  timeoutMs: number;
  /** So retry mac dinh khi loi retryable. */
  maxRetries: number;
  /** Co phai provider chay local (khong can mang) khong. */
  local: boolean;
  /** Ghi chu van hanh. */
  notes?: string;
}

/** Cau hinh mac dinh cho cac provider trong catalog v29. */
export function defaultProviderConfigsV29(): ProviderConfigV29[] {
  return [
    { provider: 'openai', enabled: true, priority: 1, authKind: 'api-key', rateLimitPerMin: 500, timeoutMs: 60000, maxRetries: 2, local: false, notes: 'gpt-realtime-2.1, GPT-Live, gpt-5-mini.' },
    { provider: 'gemini', enabled: true, priority: 2, authKind: 'api-key', rateLimitPerMin: 600, timeoutMs: 60000, maxRetries: 2, local: false, notes: 'Gemini 3.8 Live, Gemini 3.x live family, 2.5 flash/pro.' },
    { provider: 'anthropic', enabled: true, priority: 3, authKind: 'api-key', rateLimitPerMin: 400, timeoutMs: 60000, maxRetries: 2, local: false, notes: 'Claude Sonnet 4.5 (text).' },
    { provider: 'xai', enabled: true, priority: 4, authKind: 'api-key', rateLimitPerMin: 300, timeoutMs: 60000, maxRetries: 2, local: false, notes: 'Grok 4.7 (text).' },
    { provider: 'ollama', enabled: true, priority: 5, authKind: 'local', rateLimitPerMin: 0, timeoutMs: 120000, maxRetries: 1, local: true, notes: 'Model local mien phi (qwen3-4b); uu tien khi can re nhat.' },
  ];
}

/** Ket qua validate mot provider config. */
export interface ProviderConfigValidationV29 {
  ok: boolean;
  errors: string[];
}

/** Validate mot provider config (thuan). */
export function validateProviderConfigV29(config: ProviderConfigV29): ProviderConfigValidationV29 {
  const errors: string[] = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['config phai la object.'] };
  if (!config.provider || config.provider.trim() === '') errors.push('provider khong duoc rong.');
  if (!Number.isInteger(config.priority) || config.priority < 0) {
    errors.push('priority phai la so nguyen >= 0.');
  }
  const authKinds: readonly string[] = ['api-key', 'cli-login', 'oauth', 'none', 'local'];
  if (!authKinds.includes(config.authKind)) {
    errors.push(`authKind phai la mot trong: ${authKinds.join(', ')}.`);
  }
  if (config.rateLimitPerMin !== undefined && (!Number.isFinite(config.rateLimitPerMin) || config.rateLimitPerMin < 0)) {
    errors.push('rateLimitPerMin phai >= 0.');
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    errors.push('timeoutMs phai la so duong.');
  }
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 10) {
    errors.push('maxRetries phai la so nguyen 0..10.');
  }
  if (config.local && config.authKind !== 'local' && config.authKind !== 'none') {
    errors.push('provider local thi authKind phai la local hoac none.');
  }
  return { ok: errors.length === 0, errors };
}

/** Hop nhat mot config ghi de len config goc (chi cac field co gia tri). */
export function mergeProviderConfigV29(
  base: ProviderConfigV29,
  override: Partial<ProviderConfigV29>,
): ProviderConfigV29 {
  const merged: ProviderConfigV29 = { ...base };
  if (override.enabled !== undefined) merged.enabled = override.enabled;
  if (override.priority !== undefined) merged.priority = override.priority;
  if (override.authKind !== undefined) merged.authKind = override.authKind;
  if (override.rateLimitPerMin !== undefined) merged.rateLimitPerMin = override.rateLimitPerMin;
  if (override.timeoutMs !== undefined) merged.timeoutMs = override.timeoutMs;
  if (override.maxRetries !== undefined) merged.maxRetries = override.maxRetries;
  if (override.local !== undefined) merged.local = override.local;
  if (override.notes !== undefined) merged.notes = override.notes;
  return merged;
}

/**
 * Store cau hinh provider (in-memory; host luu neu can).
 *
 * - upsert: them/sua (validate truoc, tra loi neu sai).
 * - enabledProviders: provider dang bat, sap xep theo priority.
 * - routingOrder: thu tu provider router nen thu (enabled truoc,
 *   theo priority; provider bi tat xuong cuoi de ghi log).
 * - toJSON/fromJSON: luu/tai lai.
 */
export class ProviderConfigStoreV29 {
  private configs = new Map<string, ProviderConfigV29>();

  constructor(initial: ProviderConfigV29[] = defaultProviderConfigsV29()) {
    for (const c of initial) {
      if (validateProviderConfigV29(c).ok) this.configs.set(c.provider, { ...c });
    }
  }

  /** Them/sua mot provider; tra validation (khong ghi neu sai). */
  upsert(config: ProviderConfigV29): ProviderConfigValidationV29 {
    const validation = validateProviderConfigV29(config);
    if (!validation.ok) return validation;
    this.configs.set(config.provider, { ...config });
    return validation;
  }

  /** Ghi de mot phan config cua provider da co. */
  patch(provider: string, override: Partial<ProviderConfigV29>): ProviderConfigValidationV29 {
    const existing = this.configs.get(provider);
    if (!existing) return { ok: false, errors: [`Khong co provider "${provider}".`] };
    return this.upsert(mergeProviderConfigV29(existing, override));
  }

  get(provider: string): ProviderConfigV29 | undefined {
    const c = this.configs.get(provider);
    return c ? { ...c } : undefined;
  }

  list(): ProviderConfigV29[] {
    return [...this.configs.values()]
      .map((c) => ({ ...c }))
      .sort((a, b) => a.priority - b.priority || a.provider.localeCompare(b.provider));
  }

  /** Provider dang bat, sap xep theo priority. */
  enabledProviders(): ProviderConfigV29[] {
    return this.list().filter((c) => c.enabled);
  }

  /** Provider bi tat. */
  disabledProviders(): ProviderConfigV29[] {
    return this.list().filter((c) => !c.enabled);
  }

  remove(provider: string): boolean {
    return this.configs.delete(provider);
  }

  /** Provider co duoc phep dung khong (chua dang ky = khong). */
  isEnabled(provider: string): boolean {
    return this.configs.get(provider)?.enabled === true;
  }

  /**
   * Thu tu router nen thu cac provider: enabled truoc (theo
   * priority), sau do disabled (de ghi log ly do bo qua).
   */
  routingOrder(): { provider: string; enabled: boolean; priority: number }[] {
    return this.list().map((c) => ({ provider: c.provider, enabled: c.enabled, priority: c.priority }));
  }

  /** Timeout/retry mac dinh cho mot provider (fallback gia tri chung). */
  defaultsFor(provider: string): { timeoutMs: number; maxRetries: number } {
    const c = this.configs.get(provider);
    return { timeoutMs: c?.timeoutMs ?? 60000, maxRetries: c?.maxRetries ?? 2 };
  }

  /** So provider dang quan ly. */
  get size(): number {
    return this.configs.size;
  }

  toJSON(): ProviderConfigV29[] {
    return this.list();
  }

  /** Tai lai tu toJSON (bo qua muc sai, dem so bo qua). */
  static fromJSON(data: unknown): { store: ProviderConfigStoreV29; skipped: number } {
    const store = new ProviderConfigStoreV29([]);
    let skipped = 0;
    if (!Array.isArray(data)) return { store, skipped: 1 };
    for (const raw of data) {
      const validation = validateProviderConfigV29(raw as ProviderConfigV29);
      if (!validation.ok) {
        skipped += 1;
        continue;
      }
      store.configs.set((raw as ProviderConfigV29).provider, { ...(raw as ProviderConfigV29) });
    }
    return { store, skipped };
  }
}

/**
 * Loc danh sach provider theo config: chi giu provider enabled.
 * Tra ca danh sach bi loai kem ly do (de router ghi log/giai thich).
 */
export function filterProvidersByConfigV29(
  providers: string[],
  store: ProviderConfigStoreV29,
): { allowed: string[]; rejected: { provider: string; reason: string }[] } {
  const allowed: string[] = [];
  const rejected: { provider: string; reason: string }[] = [];
  for (const provider of providers) {
    const config = store.get(provider);
    if (!config) {
      rejected.push({ provider, reason: 'chua co cau hinh provider (chua dang ky).' });
    } else if (!config.enabled) {
      rejected.push({ provider, reason: 'provider dang tat trong cau hinh.' });
    } else {
      allowed.push(provider);
    }
  }
  return { allowed, rejected };
}
