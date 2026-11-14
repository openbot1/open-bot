/**
 * Model list tự refresh (v1.05, Đội T3).
 *
 * Ý tưởng (học từ model picker tự làm mới của các agent khác): danh
 * sách model không còn là catalogue tĩnh đóng gói cùng app — picker
 * hỏi provider lấy danh sách mới, cache lại với TTL, refresh nền,
 * hiển thị "đã cập nhật lúc …". Người dùng không cần update app để
 * thấy model mới.
 *
 * Thiết kế:
 * - `ModelListFetcher`: một hàm `(providerId) => Promise<string[]>`
 *   do host cung cấp. Core chỉ ship 2 fetcher thật: Ollama local
 *   (`GET /api/tags`) và OpenAI-compatible (`GET /v1/models`). Các
 *   provider API-key khác dùng chung fetcher OpenAI-compatible khi
 *   host truyền baseUrl + key; test dùng fetcher mock, KHÔNG gọi
 *   API thật trong test.
 * - `ModelRefreshService`: cache theo provider `{models, updatedAt,
 *   source}`, TTL mặc định 15 phút, stale-while-revalidate: `list()`
 *   trả cache ngay (kể cả đã hết hạn) và refresh nền khi quá TTL;
 *   `refresh()` ép làm mới đồng bộ; `startAutoRefresh()` chạy nền
 *   theo chu kỳ; `onUpdate` callback để UI/registry cập nhật.
 * - Tích hợp với `ModelRegistry` qua `setDiscoveredModels` (model
 *   Ollama đã pull) — service KHÔNG tự giữ registry, host nối dây.
 *
 * Trung thực: `updatedAt` là thời điểm fetch thành công gần nhất;
 * khi fetch lỗi, cache cũ vẫn giữ nguyên và `lastError` được ghi rõ
 * — picker hiện "không làm mới được" thay vì danh sách rỗng giả.
 */
import type { ModelRegistry } from './registry';

/** Nguồn của danh sách model trong cache. */
export type ModelRefreshSource = 'builtin' | 'ollama' | 'provider-api' | 'mock';

/** Một entry cache của một provider. */
export interface ModelCacheEntry {
  providerId: string;
  models: string[];
  /** Thời điểm fetch thành công gần nhất (epoch ms). */
  updatedAt: number;
  source: ModelRefreshSource;
  /** Lỗi của lần refresh gần nhất (nếu có) — cache vẫn giữ danh sách cũ. */
  lastError?: string;
  /** true khi entry đã quá TTL. */
  stale: boolean;
}

/** Trạng thái refresh để UI hiển thị. */
export interface ModelRefreshStatus {
  providerId: string;
  modelCount: number;
  updatedAt: number | null;
  stale: boolean;
  refreshing: boolean;
  lastError?: string;
}

/** Fetcher do host cung cấp: trả về danh sách model id của provider. */
export type ModelListFetcher = (providerId: string) => Promise<string[]>;

export interface ModelRefreshServiceOptions {
  /** TTL của cache (ms, mặc định 15 phút). */
  ttlMs?: number;
  /** Fetcher mặc định khi host không truyền riêng cho provider. */
  fetcher?: ModelListFetcher;
  /** Fetcher riêng theo provider (thắng fetcher chung). */
  fetchers?: Record<string, ModelListFetcher>;
  /** Nguồn mặc định ghi vào entry (mặc định 'provider-api'). */
  source?: ModelRefreshSource;
  /** Callback khi một provider refresh xong (thành công hay lỗi). */
  onUpdate?: (entry: ModelCacheEntry) => void;
  /** Lấy thời gian hiện tại (mặc định Date.now) — để test điều khiển TTL. */
  now?: () => number;
}

/** TTL mặc định: 15 phút. */
export const DEFAULT_MODEL_REFRESH_TTL_MS = 15 * 60 * 1000;
/** Chu kỳ auto-refresh nền mặc định: 30 phút. */
export const DEFAULT_MODEL_AUTO_REFRESH_MS = 30 * 60 * 1000;

/** Chuẩn hoá danh sách model: trim, bỏ rỗng, bỏ trùng, giữ thứ tự. */
export function cleanModelIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const clean = id.trim();
    if (clean === '' || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * Fetcher Ollama local: GET `<baseUrl>/api/tags` → `models[].name`.
 * `fetchFn` mặc định là global fetch; test truyền mock.
 */
export function createOllamaModelFetcher(
  baseUrl = 'http://127.0.0.1:11434',
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
): ModelListFetcher {
  return async (providerId: string): Promise<string[]> => {
    if (providerId !== 'ollama') throw new Error(`Ollama fetcher không hỗ trợ provider "${providerId}".`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
      if (!res.ok) throw new Error(`Ollama trả HTTP ${res.status}.`);
      const parsed = (await res.json()) as unknown;
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { models?: unknown }).models)) {
        throw new Error('Ollama trả về JSON không có mảng "models".');
      }
      const models = (parsed as { models: Array<{ name?: unknown }> }).models;
      return cleanModelIds(models.map((m) => m.name));
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Fetcher Gemini: GET `<baseUrl>/v1beta/models?key=<apiKey>` →
 * `models[].name` (bỏ tiền tố `models/`). Key đi trong query param
 * theo đúng quy ước của Gemini API (đã dùng cho custom.gemini).
 */
export function createGeminiModelFetcher(
  baseUrl: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): ModelListFetcher {
  return async (providerId: string): Promise<string[]> => {
    if (providerId !== 'gemini') throw new Error(`Gemini fetcher không hỗ trợ provider "${providerId}".`);
    if (!apiKey) throw new Error('Gemini fetcher cần API key.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`;
      const res = await fetchFn(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Gemini trả HTTP ${res.status}.`);
      const parsed = (await res.json()) as unknown;
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { models?: unknown }).models)) {
        throw new Error('Gemini trả về JSON không có mảng "models".');
      }
      const models = (parsed as { models: Array<{ name?: unknown }> }).models;
      return cleanModelIds(
        models.map((m) => (typeof m.name === 'string' ? m.name.replace(/^models\//, '') : m.name)),
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Fetcher Anthropic: GET `https://api.anthropic.com/v1/models` với
 * header `x-api-key` + `anthropic-version: 2023-06-01` → `data[].id`.
 */
export function createAnthropicModelFetcher(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): ModelListFetcher {
  return async (providerId: string): Promise<string[]> => {
    if (providerId !== 'anthropic') throw new Error(`Anthropic fetcher không hỗ trợ provider "${providerId}".`);
    if (!apiKey) throw new Error('Anthropic fetcher cần API key.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn('https://api.anthropic.com/v1/models', {
        signal: controller.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) throw new Error(`Anthropic trả HTTP ${res.status}.`);
      const parsed = (await res.json()) as unknown;
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { data?: unknown }).data)) {
        throw new Error('Anthropic trả về JSON không có mảng "data".');
      }
      const data = (parsed as { data: Array<{ id?: unknown }> }).data;
      return cleanModelIds(data.map((m) => m.id));
    } finally {
      clearTimeout(timer);
    }
  };
}
export function createOpenAiCompatibleModelFetcher(
  baseUrl: string,
  apiKey?: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): ModelListFetcher {
  return async (): Promise<string[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
        signal: controller.signal,
        headers,
      });
      if (!res.ok) throw new Error(`Provider trả HTTP ${res.status}.`);
      const parsed = (await res.json()) as unknown;
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { data?: unknown }).data)) {
        throw new Error('Provider trả về JSON không có mảng "data".');
      }
      const data = (parsed as { data: Array<{ id?: unknown }> }).data;
      return cleanModelIds(data.map((m) => m.id));
    } finally {
      clearTimeout(timer);
    }
  };
}

export class ModelRefreshService {
  private readonly ttlMs: number;
  private readonly fetchers: Record<string, ModelListFetcher>;
  private readonly fetcher?: ModelListFetcher;
  private readonly source: ModelRefreshSource;
  private readonly onUpdate?: (entry: ModelCacheEntry) => void;
  private readonly now: () => number;
  private readonly cache = new Map<string, ModelCacheEntry>();
  private readonly refreshing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ModelRefreshServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_MODEL_REFRESH_TTL_MS;
    this.fetchers = options.fetchers ?? {};
    this.fetcher = options.fetcher;
    this.source = options.source ?? 'provider-api';
    this.onUpdate = options.onUpdate;
    this.now = options.now ?? Date.now;
  }

  /** Cache hiện tại của provider (undefined khi chưa refresh lần nào). */
  getCached(providerId: string): ModelCacheEntry | undefined {
    const entry = this.cache.get(providerId);
    if (!entry) return undefined;
    return { ...entry, models: [...entry.models], stale: this.isStale(entry) };
  }

  /** Trạng thái tóm tắt để UI hiển thị ("đã cập nhật lúc …"). */
  getStatus(providerId: string): ModelRefreshStatus {
    const entry = this.cache.get(providerId);
    return {
      providerId,
      modelCount: entry?.models.length ?? 0,
      updatedAt: entry?.updatedAt ?? null,
      stale: entry ? this.isStale(entry) : true,
      refreshing: this.refreshing.has(providerId),
      lastError: entry?.lastError,
    };
  }

  /** Provider có đang refresh không. */
  isRefreshing(providerId: string): boolean {
    return this.refreshing.has(providerId);
  }

  private isStale(entry: ModelCacheEntry): boolean {
    return this.now() - entry.updatedAt > this.ttlMs;
  }

  private fetcherFor(providerId: string): ModelListFetcher | undefined {
    return this.fetchers[providerId] ?? this.fetcher;
  }

  /**
   * Làm mới danh sách của một provider (đồng bộ, throw khi không có
   * fetcher hoặc fetch lỗi — cache cũ vẫn giữ nguyên).
   */
  async refresh(providerId: string): Promise<ModelCacheEntry> {
    const fetcher = this.fetcherFor(providerId);
    if (!fetcher) throw new Error(`Không có fetcher cho provider "${providerId}" (chưa cấu hình refresh).`);
    if (this.refreshing.has(providerId)) {
      // Đang refresh ở nơi khác: đợi lần đó xong rồi trả cache.
      await this.waitForRefresh(providerId);
      const entry = this.cache.get(providerId);
      if (!entry) throw new Error(`Refresh provider "${providerId}" thất bại (không có cache).`);
      return this.getCached(providerId) as ModelCacheEntry;
    }
    this.refreshing.add(providerId);
    try {
      const models = cleanModelIds(await fetcher(providerId));
      const entry: ModelCacheEntry = {
        providerId,
        models,
        updatedAt: this.now(),
        source: this.source,
        stale: false,
      };
      this.cache.set(providerId, entry);
      this.onUpdate?.(entry);
      return { ...entry, models: [...entry.models] };
    } catch (err) {
      const message = (err as Error).message;
      const prev = this.cache.get(providerId);
      if (prev) {
        const entry: ModelCacheEntry = { ...prev, lastError: message, stale: this.isStale(prev) };
        this.cache.set(providerId, entry);
        this.onUpdate?.(entry);
      }
      throw new Error(`Không làm mới được model của "${providerId}": ${message}`);
    } finally {
      this.refreshing.delete(providerId);
    }
  }

  private async waitForRefresh(providerId: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      if (!this.refreshing.has(providerId)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Lấy danh sách model: trả cache ngay nếu còn tươi; nếu quá TTL thì
   * refresh nền (không đợi) và trả cache cũ; nếu chưa có cache thì
   * refresh đồng bộ. Không bao giờ trả mảng rỗng giả khi fetch lỗi mà
   * cache cũ còn — lúc đó trả cache cũ kèm lastError trong status.
   */
  async list(providerId: string): Promise<string[]> {
    const entry = this.cache.get(providerId);
    if (!entry) return (await this.refresh(providerId)).models;
    if (this.isStale(entry)) {
      void this.refresh(providerId).catch(() => {
        // Lỗi refresh nền đã ghi vào lastError; list() vẫn trả cache cũ.
      });
    }
    return [...entry.models];
  }

  /** Refresh nhiều provider, trả về kết quả từng cái (lỗi không chặn cái khác). */
  async refreshAll(providerIds: string[]): Promise<Array<{ providerId: string; ok: boolean; models?: string[]; error?: string }>> {
    const results: Array<{ providerId: string; ok: boolean; models?: string[]; error?: string }> = [];
    for (const providerId of providerIds) {
      try {
        const entry = await this.refresh(providerId);
        results.push({ providerId, ok: true, models: [...entry.models] });
      } catch (err) {
        results.push({ providerId, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /** Đặt cache thủ công (vd seed từ catalogue built-in khi khởi động). */
  seed(providerId: string, models: string[], source: ModelRefreshSource = 'builtin'): void {
    this.cache.set(providerId, {
      providerId,
      models: cleanModelIds(models),
      updatedAt: this.now(),
      source,
      stale: false,
    });
  }

  /**
   * Bắt đầu auto-refresh nền: mỗi chu kỳ refresh các provider đã có
   * cache (hoặc danh sách cho trước). Gọi lại khi đã chạy thì đổi chu
   * kỳ. Dừng bằng `stopAutoRefresh()`.
   */
  startAutoRefresh(providerIds: string[], intervalMs: number = DEFAULT_MODEL_AUTO_REFRESH_MS): void {
    this.stopAutoRefresh();
    this.timer = setInterval(() => {
      void this.refreshAll(providerIds).catch(() => undefined);
    }, intervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  stopAutoRefresh(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Auto-refresh có đang chạy không. */
  get autoRefreshRunning(): boolean {
    return this.timer !== null;
  }
}

/** Helper tạo service đã nối registry cho provider Ollama. */
export function createOllamaRefreshService(
  registry: ModelRegistry,
  options?: { ttlMs?: number; baseUrl?: string; fetchFn?: typeof fetch; now?: () => number },
): ModelRefreshService {
  return new ModelRefreshService({
    ttlMs: options?.ttlMs,
    fetchers: {
      ollama: createOllamaModelFetcher(options?.baseUrl, options?.fetchFn),
    },
    source: 'ollama',
    now: options?.now,
    onUpdate: (entry) => {
      if (entry.providerId === 'ollama') {
        try {
          registry.setDiscoveredModels('ollama', entry.models);
        } catch {
          // Registry chưa có provider ollama (không xảy ra với catalogue
          // hiện tại) — bỏ qua, cache vẫn đúng.
        }
      }
    },
  });
}
