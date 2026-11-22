/**
 * LocalModelRegistry (v1.15, Doi T3) — quan ly model local qua Ollama
 * + llama.cpp router-mode-style.
 *
 * Y tuong (llama-server router mode): mot process quan nhieu model,
 * load on-demand, moi model llamacpp mot process rieng (spawn
 * `llama-server -m <gguf> --port <port>`), endpoint OpenAI-compatible
 * noi bo 127.0.0.1; Ollama thi dung chung mot daemon (pull/tag qua
 * API). Switch model 3–10s (cold start). Registry KHONG tu y chay
 * lenh shell tuy tien: spawner duoc inject (mac dinh child_process),
 * chi spawn dung 2 lenh da biet (llama-server / ollama) voi arg
 * whitelist — test dung spawner gia.
 *
 * Muc tieu: chay duoc that voi Ollama that hoac llama-server that,
 * nhung test xanh hoan toan bang mock (khong can GPU/model that).
 */

import { spawn, type ChildProcess } from 'node:child_process';

import {
  findLocalModel,
  validateModelLicense,
  type LocalModelEntry,
} from '../../models/localCatalog';
import { LruModelCache, RamTracker } from './lru';
import {
  DEFAULT_LRU_CONFIG,
  type LocalBackendEndpoint,
  type LocalBackendKind,
  type LocalModelInstance,
  type LocalModelLoadState,
  type LruConfig,
  type RamSnapshot,
} from './types';

/** Len h nho nhat de lam health check (ms). */
export const REGISTRY_HEALTH_TIMEOUT_MS = 3000;
/** So lan load that lien tiep toi da truoc khi danh dau backoff. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Port bat dau cap cho llama-server rieng (tang dan). */
export const LLAMACPP_PORT_START = 12100;

/** Mot process da spawn (giao dien toi thieu de mock duoc). */
export interface SpawnedProcess {
  pid?: number;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null) => void): void;
}

/** Ham spawn process — inject de test (mac dinh child_process.spawn). */
export type ProcessSpawner = (
  command: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => SpawnedProcess;

/**
 * Environment variables that local model runtimes need, without exposing
 * provider credentials or unrelated application configuration.
 *
 * Keep this allowlist intentionally narrow. GPU device selectors are
 * preserved so users can still choose which accelerator a local runtime sees.
 */
const LOCAL_MODEL_PROCESS_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'TERM',
  'SHELL',
  'NODE_ENV',
  'CUDA_VISIBLE_DEVICES',
  'HIP_VISIBLE_DEVICES',
  'ROCR_VISIBLE_DEVICES',
  'GPU_DEVICE_ORDINAL',
  'NVIDIA_VISIBLE_DEVICES',
]);

const LOCAL_MODEL_SECRET_ENV_PATTERN =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;

/**
 * Build a minimal environment for Ollama / llama-server child processes.
 * An explicit caller env may be passed to defaultSpawner, but the implicit
 * default must never inherit the full application process.env.
 */
export function buildLocalModelProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!LOCAL_MODEL_PROCESS_ENV_ALLOWLIST.has(key)) continue;
    if (LOCAL_MODEL_SECRET_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}

export function defaultSpawner(
  command: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
): SpawnedProcess {
  const child: ChildProcess = spawn(command, args, {
    stdio: 'ignore',
    detached: false,
    env: opts?.env ?? buildLocalModelProcessEnv(),
  });
  return {
    get pid() {
      return child.pid;
    },
    get killed() {
      return child.killed;
    },
    kill: (signal?: NodeJS.Signals) => child.kill(signal ?? 'SIGTERM'),
    on: (event: 'exit', listener: (code: number | null) => void) => {
      child.on(event, listener);
    },
  };
}

/** HTTP client toi thieu — inject de test (mac dinh fetch toan cuc). */
export type HttpClient = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export async function defaultHttpClient(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
}

/** Cau hinh registry. */
export interface LocalModelRegistryOptions {
  /** Backend mac dinh khi load model chua ro backend. */
  defaultBackend?: LocalBackendKind;
  /** Base URL Ollama daemon (mac dinh http://127.0.0.1:11434). */
  ollamaBaseUrl?: string;
  /** Duong dan binary llama-server (mac dinh 'llama-server' trong PATH). */
  llamaServerBin?: string;
  /** Duong dan binary ollama CLI (mac dinh 'ollama' trong PATH). */
  ollamaBin?: string;
  /** Thu muc chua file GGUF (cho llamacpp). */
  ggufDir?: string;
  lru?: Partial<LruConfig>;
  /** Gioi han RAM registry duoc dung (byte). 0 = 80% RAM tong. */
  ramBudgetBytes?: number;
  spawner?: ProcessSpawner;
  http?: HttpClient;
  /** Ham lay thoi gian (de test). */
  now?: () => number;
}

export interface LoadResult {
  ok: boolean;
  modelId: string;
  endpoint?: string;
  /** Cac model bi unload de nhuong cho (LRU). */
  evicted: string[];
  /** true = model da loaded san, khong can load lai. */
  alreadyLoaded: boolean;
  error?: string;
}

export interface RegistryStatus {
  backends: LocalBackendEndpoint[];
  models: Array<{
    id: string;
    label: string;
    backend: LocalBackendKind;
    state: LocalModelLoadState;
    endpoint?: string;
    pid?: number;
    activeTasks: number;
    pinned: boolean;
    lastUsedAt?: number;
    ramBytes: number;
  }>;
  ram: RamSnapshot;
  maxLoadedModels: number;
  loadedCount: number;
}

/**
 * LocalModelRegistry.
 *
 * - `load(modelId)`: validate license truoc (chan model khong ro
 *   license) -> lap ke hoach LRU eviction -> spawn/pull -> health
 *   check -> danh dau loaded. That bai thi state=failed + backoff
 *   (sau 3 lan that lien tiep thi tu choi load ngay lap tuc 60s).
 * - `unload(modelId)`: khong unload model dang chay task.
 * - `chatCompletionsUrl(modelId)`: URL OpenAI-compatible de goi.
 * - `healthCheck()`: ping tung backend + tung model loaded.
 */
export class LocalModelRegistry {
  private readonly opts: Required<Omit<LocalModelRegistryOptions, 'lru' | 'ramBudgetBytes'>> & {
    lru: Partial<LruConfig>;
    ramBudgetBytes: number;
  };
  private readonly cache: LruModelCache;
  private readonly ramTracker: RamTracker;
  private readonly instances = new Map<string, LocalModelInstance>();
  private readonly processes = new Map<string, SpawnedProcess>();
  private readonly backoffUntil = new Map<string, number>();
  private nextLlamaPort = LLAMACPP_PORT_START;
  private ollamaHealthy = false;
  private lastOllamaCheckAt?: number;

  constructor(options: LocalModelRegistryOptions = {}) {
    this.opts = {
      defaultBackend: options.defaultBackend ?? 'ollama',
      ollamaBaseUrl: options.ollamaBaseUrl ?? 'http://127.0.0.1:11434',
      llamaServerBin: options.llamaServerBin ?? 'llama-server',
      ollamaBin: options.ollamaBin ?? 'ollama',
      ggufDir: options.ggufDir ?? '',
      lru: options.lru ?? {},
      ramBudgetBytes: options.ramBudgetBytes ?? 0,
      spawner: options.spawner ?? defaultSpawner,
      http: options.http ?? defaultHttpClient,
      now: options.now ?? Date.now,
    };
    const lruConfig: LruConfig = { ...DEFAULT_LRU_CONFIG, ...this.opts.lru };
    this.cache = new LruModelCache(lruConfig);
    this.ramTracker = new RamTracker({
      budgetBytes: this.opts.ramBudgetBytes > 0 ? this.opts.ramBudgetBytes : undefined,
    });
  }

  getLruConfig(): LruConfig {
    return this.cache.getConfig();
  }

  /** Endpoint Ollama (loopback-only — tu choi baseUrl khong phai loopback). */
  getOllamaBaseUrl(): string {
    return this.opts.ollamaBaseUrl;
  }

  listInstances(): LocalModelInstance[] {
    return [...this.instances.values()];
  }

  getInstance(modelId: string): LocalModelInstance | undefined {
    return this.instances.get(modelId);
  }

  /** RAM snapshot hien tai. */
  ramSnapshot(): RamSnapshot {
    return this.ramTracker.snapshot(this.cache.totalRamBytes());
  }

  /** URL OpenAI-compatible cho model da loaded (undefined neu chua load). */
  chatCompletionsUrl(modelId: string): string | undefined {
    const inst = this.instances.get(modelId);
    if (!inst || inst.state !== 'loaded' || !inst.endpoint) return undefined;
    return `${inst.endpoint}/v1/chat/completions`;
  }

  /** URL /v1/models cua endpoint model. */
  modelsUrl(modelId: string): string | undefined {
    const inst = this.instances.get(modelId);
    if (!inst || inst.state !== 'loaded' || !inst.endpoint) return undefined;
    return `${inst.endpoint}/v1/models`;
  }

  /**
   * Load mot model. Tra LoadResult — khong throw tru truong hop
   * lap trinh sai (modelId rong). Moi loi van hanh nam trong `error`.
   */
  async load(modelId: string, opts?: { backend?: LocalBackendKind; pin?: boolean }): Promise<LoadResult> {
    const now = this.opts.now();
    const entry = findLocalModel(modelId);
    if (!entry) {
      return { ok: false, modelId, evicted: [], alreadyLoaded: false, error: `Khong co model "${modelId}" trong catalogue local.` };
    }
    // 1) Validate license TRUOC KHI tai/cai.
    const license = validateModelLicense(entry);
    if (!license.allowed) {
      return { ok: false, modelId, evicted: [], alreadyLoaded: false, error: license.reasons.join(' ') };
    }
    // 2) Backoff sau that lien tiep.
    const blockedUntil = this.backoffUntil.get(modelId) ?? 0;
    if (now < blockedUntil) {
      return {
        ok: false,
        modelId,
        evicted: [],
        alreadyLoaded: false,
        error: `Model "${modelId}" dang backoff sau ${MAX_CONSECUTIVE_FAILURES} lan load that — thu lai sau ${Math.ceil((blockedUntil - now) / 1000)}s.`,
      };
    }
    const existing = this.instances.get(modelId);
    if (existing?.state === 'loaded') {
      this.cache.touch(modelId, now);
      existing.lastUsedAt = now;
      if (opts?.pin !== undefined) {
        existing.pinned = opts.pin;
        this.cache.pin(modelId, opts.pin);
      }
      return { ok: true, modelId, endpoint: existing.endpoint, evicted: [], alreadyLoaded: true };
    }
    if (existing?.state === 'loading') {
      return { ok: false, modelId, evicted: [], alreadyLoaded: false, error: `Model "${modelId}" dang loading — doi lan load truoc xong.` };
    }

    const backend = opts?.backend ?? this.opts.defaultBackend;
    const instance: LocalModelInstance = existing ?? {
      entry,
      backend,
      state: 'unloaded',
      activeTasks: 0,
      pinned: opts?.pin ?? false,
      consecutiveFailures: 0,
    };
    instance.backend = backend;
    instance.state = 'loading';
    if (opts?.pin !== undefined) instance.pinned = opts.pin;
    this.instances.set(modelId, instance);

    // 3) LRU eviction truoc khi load.
    const plan = this.cache.planEviction(entry.ramRequiredBytes, now);
    const evicted: string[] = [];
    for (const victimId of plan.toUnload) {
      // Chi unload khi du cho that su can (plan da tinh); neu model
      // bi block thi plan khong chon no — an toan.
      const okEvict = this.unloadSync(victimId);
      if (okEvict) evicted.push(victimId);
    }
    // Kiem tra lai: neu van khong du cho (model bi block het) thi bao loi.
    if (!this.cache.canLoadWithoutEviction(entry.ramRequiredBytes) && this.cache.size() > 0) {
      const stillBlocked = plan.blocked.filter((b) => this.instances.get(b)?.state === 'loaded');
      if (stillBlocked.length > 0 && this.cache.size() >= this.cache.getConfig().maxLoadedModels) {
        instance.state = 'failed';
        instance.lastError = `Khong du cho: ${stillBlocked.length} model dang chay/pin (${stillBlocked.join(', ')}) — doi task xong hoac unpin truoc.`;
        return { ok: false, modelId, evicted, alreadyLoaded: false, error: instance.lastError };
      }
    }
    // 4) RAM thuc te: tu choi neu model lon hon ca budget.
    if (entry.ramRequiredBytes > this.ramTracker.getBudgetBytes()) {
      instance.state = 'failed';
      instance.lastError = `Model "${modelId}" can ${Math.round(entry.ramRequiredBytes / 1e9)} GB RAM, vuot budget ${Math.round(this.ramTracker.getBudgetBytes() / 1e9)} GB.`;
      return { ok: false, modelId, evicted, alreadyLoaded: false, error: instance.lastError };
    }

    // 5) Load theo backend.
    try {
      const endpoint = await this.startBackend(entry, backend);
      instance.endpoint = endpoint;
      instance.state = 'loaded';
      instance.loadedAt = now;
      instance.lastUsedAt = now;
      instance.consecutiveFailures = 0;
      this.cache.markLoaded(modelId, entry.ramRequiredBytes, { pinned: instance.pinned });
      this.cache.touch(modelId, now);
      return { ok: true, modelId, endpoint, evicted, alreadyLoaded: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      instance.state = 'failed';
      instance.lastError = message;
      instance.consecutiveFailures += 1;
      if (instance.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.backoffUntil.set(modelId, now + 60_000);
      }
      return { ok: false, modelId, evicted, alreadyLoaded: false, error: message };
    }
  }

  /** Unload model (khong unload khi dang chay task). */
  unload(modelId: string): { ok: boolean; error?: string } {
    const inst = this.instances.get(modelId);
    if (!inst) return { ok: false, error: `Model "${modelId}" chua tung duoc quan ly.` };
    if (inst.state !== 'loaded') {
      this.cache.remove(modelId);
      inst.state = 'unloaded';
      inst.endpoint = undefined;
      return { ok: true };
    }
    if (inst.activeTasks > 0) {
      return { ok: false, error: `Model "${modelId}" dang chay ${inst.activeTasks} task — khong the unload.` };
    }
    this.unloadSync(modelId);
    return { ok: true };
  }

  /** Unload khong kiem tra activeTasks (chi dung noi bo cho LRU — LRU da loai active). */
  private unloadSync(modelId: string): boolean {
    const inst = this.instances.get(modelId);
    if (!inst) return false;
    const proc = this.processes.get(modelId);
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Tien trinh co the da chet — bo qua, van danh dau unloaded.
      }
    }
    this.processes.delete(modelId);
    this.cache.remove(modelId);
    inst.state = 'unloaded';
    inst.endpoint = undefined;
    inst.pid = undefined;
    return true;
  }

  /** Bat dau tang so task dang chay (de LRU bao ve). */
  beginTask(modelId: string): boolean {
    const inst = this.instances.get(modelId);
    if (!inst || inst.state !== 'loaded') return false;
    inst.activeTasks += 1;
    this.cache.setActiveTasks(modelId, inst.activeTasks);
    this.cache.touch(modelId, this.opts.now());
    inst.lastUsedAt = this.opts.now();
    return true;
  }

  /** Ket thuc task. */
  endTask(modelId: string): void {
    const inst = this.instances.get(modelId);
    if (!inst) return;
    inst.activeTasks = Math.max(0, inst.activeTasks - 1);
    this.cache.setActiveTasks(modelId, inst.activeTasks);
    this.cache.touch(modelId, this.opts.now());
  }

  /** Pin/unpin model (pin = LRU khong duoc unload). */
  pin(modelId: string, pinned: boolean): boolean {
    const inst = this.instances.get(modelId);
    if (!inst) return false;
    inst.pinned = pinned;
    this.cache.pin(modelId, pinned);
    return true;
  }

  /** Quet idle: unload cac model idle qua nguong. Tra danh sach da unload. */
  sweepIdle(now = this.opts.now()): string[] {
    const plan = this.cache.planIdleSweep(now);
    const done: string[] = [];
    for (const id of plan.toUnload) {
      if (this.unloadSync(id)) done.push(id);
    }
    return done;
  }

  /** Health check: Ollama daemon + tung model loaded (ping /v1/models). */
  async healthCheck(): Promise<RegistryStatus> {
    const now = this.opts.now();
    const ollamaOk = await this.pingOllama();
    this.ollamaHealthy = ollamaOk;
    this.lastOllamaCheckAt = now;
    const backends: LocalBackendEndpoint[] = [
      {
        kind: 'ollama',
        baseUrl: this.opts.ollamaBaseUrl,
        port: ollamaPortOf(this.opts.ollamaBaseUrl),
        healthy: ollamaOk,
        lastHealthCheckAt: now,
      },
    ];
    const seenPorts = new Set<number>([ollamaPortOf(this.opts.ollamaBaseUrl)]);
    for (const inst of this.instances.values()) {
      if (inst.backend === 'llamacpp' && inst.endpoint) {
        const port = ollamaPortOf(inst.endpoint);
        if (!seenPorts.has(port)) {
          seenPorts.add(port);
          const healthy = inst.state === 'loaded' ? await this.pingEndpoint(inst.endpoint) : false;
          backends.push({ kind: 'llamacpp', baseUrl: inst.endpoint, port, healthy, lastHealthCheckAt: now });
        }
      }
    }
    return {
      backends,
      models: this.listInstances().map((i) => ({
        id: i.entry.id,
        label: i.entry.label,
        backend: i.backend,
        state: i.state,
        endpoint: i.endpoint,
        pid: i.pid,
        activeTasks: i.activeTasks,
        pinned: i.pinned,
        lastUsedAt: i.lastUsedAt,
        ramBytes: i.entry.ramRequiredBytes,
      })),
      ram: this.ramSnapshot(),
      maxLoadedModels: this.cache.getConfig().maxLoadedModels,
      loadedCount: this.listInstances().filter((i) => i.state === 'loaded').length,
    };
  }

  /** Ping Ollama daemon (GET /api/tags, timeout ngan). */
  private async pingOllama(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REGISTRY_HEALTH_TIMEOUT_MS);
      try {
        const res = await this.opts.http(`${this.opts.ollamaBaseUrl.replace(/\/v1$/, '')}/api/tags`, {
          method: 'GET',
          signal: controller.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /** Ping mot endpoint llamacpp (GET /health hoac /v1/models). */
  private async pingEndpoint(endpoint: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REGISTRY_HEALTH_TIMEOUT_MS);
      try {
        const res = await this.opts.http(`${endpoint}/health`, { method: 'GET', signal: controller.signal });
        if (res.ok) return true;
        const res2 = await this.opts.http(`${endpoint}/v1/models`, { method: 'GET', signal: controller.signal });
        return res2.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /** Khoi dong backend cho mot model, tra endpoint. */
  private async startBackend(entry: LocalModelEntry, backend: LocalBackendKind): Promise<string> {
    if (backend === 'ollama') {
      return this.startOllama(entry);
    }
    return this.startLlamaCpp(entry);
  }

  /** Ollama: dam bao daemon chay + pull tag neu can (qua API/CLI gia lap). */
  private async startOllama(entry: LocalModelEntry): Promise<string> {
    const tag = entry.ollamaTag ?? entry.id;
    const nativeBase = this.opts.ollamaBaseUrl.replace(/\/v1$/, '');
    const alive = await this.pingOllama();
    if (!alive) {
      throw new Error(
        `Ollama daemon khong tra loi tai ${nativeBase} — hay chay "ollama serve" truoc (hoac dung mock server khi test).`,
      );
    }
    // Kiem tra model da co trong Ollama chua (GET /api/tags).
    const tags = await this.listOllamaTags(nativeBase);
    if (!tags.includes(tag) && !tags.includes(entry.id)) {
      // Pull qua CLI (spawn) — neu that bai thi bao loi ro rang.
      await this.pullOllamaModel(tag);
      const tagsAfter = await this.listOllamaTags(nativeBase);
      if (!tagsAfter.includes(tag) && !tagsAfter.includes(entry.id)) {
        throw new Error(`Ollama pull "${tag}" xong nhung model van khong xuat hien trong /api/tags.`);
      }
    }
    // Tra native base (khong /v1): chatCompletionsUrl() se append
    // /v1/chat/completions — tra ca /v1 se bi double /v1/v1.
    return nativeBase;
  }

  private async listOllamaTags(nativeBase: string): Promise<string[]> {
    try {
      const res = await this.opts.http(`${nativeBase}/api/tags`, { method: 'GET' });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Pull model Ollama bang CLI (spawn `ollama pull <tag>`); cho doi exit. */
  private pullOllamaModel(tag: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let proc: SpawnedProcess;
      try {
        proc = this.opts.spawner(this.opts.ollamaBin, ['pull', tag], { env: buildLocalModelProcessEnv() });
      } catch (err) {
        reject(new Error(`Khong spawn duoc "${this.opts.ollamaBin} pull ${tag}": ${(err as Error).message}`));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            proc.kill('SIGTERM');
          } catch {
            // bo qua
          }
          reject(new Error(`Ollama pull "${tag}" qua thoi gian (120s).`));
        }
      }, 120_000);
      proc.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Ollama pull "${tag}" that voi exit code ${code}.`));
      });
    });
  }

  /** llama.cpp: spawn llama-server rieng cho model, doi health. */
  private async startLlamaCpp(entry: LocalModelEntry): Promise<string> {
    if (!entry.ggufSource) {
      throw new Error(`Model "${entry.id}" khong co ggufSource — khong the spawn llama-server.`);
    }
    const port = this.nextLlamaPort;
    this.nextLlamaPort += 1;
    const ggufPath = this.opts.ggufDir
      ? `${this.opts.ggufDir}/${entry.id}.gguf`
      : `${entry.id}.gguf`;
    let proc: SpawnedProcess;
    try {
      proc = this.opts.spawner(this.opts.llamaServerBin, [
        '-m',
        ggufPath,
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '-c',
        String(entry.contextTokens),
      ], { env: buildLocalModelProcessEnv() });
    } catch (err) {
      throw new Error(`Khong spawn duoc llama-server cho "${entry.id}": ${(err as Error).message}`);
    }
    this.processes.set(entry.id, proc);
    const inst = this.instances.get(entry.id);
    if (inst) inst.pid = proc.pid;
    const endpoint = `http://127.0.0.1:${port}`;
    // Doi health toi da 30s (cold start 3–10s binh thuong).
    const deadline = this.opts.now() + 30_000;
    let lastError = '';
    while (this.opts.now() < deadline) {
      if (proc.killed) {
        this.processes.delete(entry.id);
        throw new Error(`llama-server cho "${entry.id}" thoat som (exit truoc khi healthy).`);
      }
      try {
        if (await this.pingEndpoint(endpoint)) return endpoint;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await sleep(500);
    }
    this.unloadSync(entry.id);
    throw new Error(`llama-server cho "${entry.id}" khong healthy sau 30s tai ${endpoint}. ${lastError}`);
  }
}

function ollamaPortOf(baseUrl: string): number {
  try {
    return Number(new URL(baseUrl).port) || 80;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
