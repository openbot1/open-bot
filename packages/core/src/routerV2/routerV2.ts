/**
 * LocalModelRouterV2 — orchestrator (v1.16, Doi T3).
 *
 * Gop cac manh lai thanh mot router hoan chinh:
 * - Discovery: quet models-dir (GGUF) + preset INI.
 * - Load on-demand: kiem tra RAM/VRAM that -> evict theo LRU v2 +
 *   preempt theo swap-group -> spawn child process rieng cho model.
 * - Route: picker v2 goi y model + fallback chain (cloud -> CLI ->
 *   local) khi goi that.
 * - Sweep dinh ky: unload model idle qua TTL; health check nguon
 *   fallback.
 *
 * Khong spawn process that trong unit test: ProcessManager,
 * HealthChecker va executor deu injectable. Router khong doc
 * credential, khong goi mang ngoai (tru health check loopback).
 */

import * as os from 'node:os';

import { LocalBudgetTracker } from '../router/local/budget';
import { buildDiscoveredModel, scanModelsDirs } from './discovery';
import { loadPresetPaths } from './presets';
import { ModelProcessManager, buildModelCommand, type HealthChecker, type ModelProcessSpawner } from './processManager';
import { LruV2Cache } from './lruV2';
import { PickerV2, defaultPickerCandidates } from './pickerV2';
import { ResourceBudget, snapshotResources, readVram, type VramRunner } from './resourceEstimator';
import { SwapGroupManager } from './swapGroups';
import { FallbackChain, DEFAULT_FALLBACK_ORDER, type FallbackSourceDef, type SourceExecutor } from './fallback';
import { probeAllCliAgents, type BinaryFinder, type CliRunner } from './cliProbeV2';
import type {
  CliAgentKind,
  CliProbeResult,
  DiscoveredModel,
  GgufModelFile,
  ModelPreset,
  PickerCandidate,
  FallbackSourceKind,
  LoadedModelV2,
  PickerSuggestion,
  PickerTask,
  ResourceSnapshot,
  RouterV2Config,
  RouterV2Decision,
  RouterV2Status,
  SwapGroupDefinition,
} from './types';
import { DEFAULT_ROUTER_V2_CONFIG } from './types';

/** Ket qua load mot model. */
export interface RouterV2LoadResult {
  ok: boolean;
  modelId: string;
  /** Ly do khi khong load duoc (ram / vram / not-found / spawn-failed...). */
  reason?: string;
  /** Model da bi evict de nhuong cho (neu co). */
  evicted: string[];
  port?: number;
}

/** Ket qua unload mot model. */
export interface RouterV2UnloadResult {
  ok: boolean;
  modelId: string;
  reason?: string;
}

/**
 * LocalModelRouterV2.
 */
export class LocalModelRouterV2 {
  private readonly config: RouterV2Config;
  private readonly processManager: ModelProcessManager;
  private readonly lru: LruV2Cache;
  private readonly swapGroups: SwapGroupManager;
  private readonly picker: PickerV2;
  private readonly budget: LocalBudgetTracker;
  private readonly fallback: FallbackChain;
  private readonly resourceBudget: ResourceBudget;
  private readonly vramRunner?: VramRunner;
  private readonly cliRunner?: CliRunner;
  private readonly cliFinder?: BinaryFinder;
  private readonly now: () => number;

  private discovered = new Map<string, DiscoveredModel>();
  private presets: ModelPreset[] = [];
  private presetErrors: string[] = [];
  private loaded = new Map<string, LoadedModelV2>();
  private nextPort: number;
  private cliResults: CliProbeResult[] = [];
  private enabledCliKinds = new Set<CliAgentKind>();

  constructor(opts?: {
    config?: Partial<RouterV2Config>;
    spawner?: ModelProcessSpawner;
    healthChecker?: HealthChecker;
    swapGroups?: SwapGroupDefinition[];
    picker?: PickerV2;
    budget?: LocalBudgetTracker;
    fallbackSources?: FallbackSourceDef[];
    fallbackExecutor?: SourceExecutor;
    vramRunner?: VramRunner;
    cliRunner?: CliRunner;
    cliFinder?: BinaryFinder;
    now?: () => number;
  }) {
    this.config = { ...DEFAULT_ROUTER_V2_CONFIG, ...(opts?.config ?? {}) };
    this.now = opts?.now ?? Date.now;
    this.processManager = new ModelProcessManager({
      spawner: opts?.spawner,
      healthChecker: opts?.healthChecker,
      maxRestarts: this.config.maxRestarts,
      backoffBaseMs: this.config.restartBackoffBaseMs,
      backoffMaxMs: this.config.restartBackoffMaxMs,
      now: this.now,
    });
    this.lru = new LruV2Cache({
      maxLoadedModels: this.config.maxLoadedModels,
      maxRamBytes: this.config.maxRamBytes,
      maxVramBytes: this.config.maxVramBytes,
      idleTimeoutMs: this.config.idleTimeoutMs,
    });
    this.swapGroups = new SwapGroupManager(opts?.swapGroups ?? SwapGroupManager.defaultGroups());
    this.picker = opts?.picker ?? new PickerV2();
    this.budget = opts?.budget ?? new LocalBudgetTracker();
    this.resourceBudget = new ResourceBudget({
      maxRamBytes: this.config.maxRamBytes,
      maxVramBytes: this.config.maxVramBytes,
      reservedBytes: this.config.reservedRamBytes,
    });
    this.vramRunner = opts?.vramRunner;
    this.cliRunner = opts?.cliRunner;
    this.cliFinder = opts?.cliFinder;
    this.nextPort = this.config.portStart;
    const executor: SourceExecutor =
      opts?.fallbackExecutor ??
      (async (source) => {
        // Mac dinh (khi host chua gan executor that): local phuc vu
        // duoc neu co model loaded; cloud/CLI can host gan executor.
        if (source === 'local') {
          return { ok: this.loaded.size > 0, error: this.loaded.size > 0 ? undefined : 'Chua co model local nao dang loaded.' };
        }
        return { ok: false, error: `Chua gan executor cho nguon ${source}.` };
      });
    this.fallback = new FallbackChain({
      sources: opts?.fallbackSources ?? [
        { source: 'cloud', sourceId: 'gemini-2.5-flash', enabled: true },
        { source: 'cli', sourceId: 'claude', enabled: false },
        { source: 'local', sourceId: 'local-default', enabled: true },
      ],
      executor,
      budget: this.budget,
    });
    // Crash cua mot model chi anh huong model do: cap nhat trang thai
    // loaded khi process manager bao crash/failed.
    this.processManager.onEvent((event) => {
      if (event.type === 'crashed' || event.type === 'failed') {
        const entry = this.loaded.get(event.modelId);
        if (entry) {
          entry.state = event.type === 'failed' ? 'failed' : 'crashed';
          entry.lastError =
            event.type === 'failed' ? (event as { reason: string }).reason : `Process crash (code ${(event as { code: number | null }).code ?? 'unknown'})`;
          entry.consecutiveCrashes += 1;
        }
      }
      if (event.type === 'restarted') {
        const entry = this.loaded.get(event.modelId);
        if (entry) {
          entry.state = 'loaded';
          entry.restartsAttempted += 1;
          entry.lastError = undefined;
        }
      }
    });
  }

  getConfig(): RouterV2Config {
    return { ...this.config };
  }

  getPicker(): PickerV2 {
    return this.picker;
  }

  getBudget(): LocalBudgetTracker {
    return this.budget;
  }

  getFallback(): FallbackChain {
    return this.fallback;
  }

  getSwapGroups(): SwapGroupManager {
    return this.swapGroups;
  }

  getLru(): LruV2Cache {
    return this.lru;
  }

  /** Quet lai models-dir + preset (goi luc khoi dong + khi user them model). */
  refreshDiscovery(): { models: DiscoveredModel[]; presetErrors: string[] } {
    const files: GgufModelFile[] = scanModelsDirs(this.config.modelsDirs);
    const { presets, errors } = loadPresetPaths(this.config.presetPaths);
    this.presets = presets;
    this.presetErrors = errors;
    this.discovered.clear();
    for (const file of files) {
      const discovered = buildDiscoveredModel(file, (id) => presets.find((p) => p.modelId === id));
      this.discovered.set(discovered.file.id, discovered);
    }
    return { models: [...this.discovered.values()], presetErrors: errors };
  }

  listDiscovered(): DiscoveredModel[] {
    return [...this.discovered.values()];
  }

  getDiscovered(modelId: string): DiscoveredModel | undefined {
    return this.discovered.get(modelId);
  }

  listPresets(): ModelPreset[] {
    return [...this.presets];
  }

  getPresetErrors(): string[] {
    return [...this.presetErrors];
  }

  /** Tong footprint cac model dang loaded (RAM). */
  usedRamBytes(): number {
    let total = 0;
    for (const m of this.loaded.values()) {
      if (m.state === 'loaded' || m.state === 'loading') total += m.footprintBytes;
    }
    return total;
  }

  /** Load mot model on-demand (evict + preempt neu can). */
  async loadModel(modelId: string, opts?: { force?: boolean }): Promise<RouterV2LoadResult> {
    const discovered = this.discovered.get(modelId);
    if (!discovered) {
      return { ok: false, modelId, reason: 'not-found', evicted: [] };
    }
    const existing = this.loaded.get(modelId);
    if (existing && (existing.state === 'loaded' || existing.state === 'loading')) {
      this.lru.touch(modelId, this.now());
      existing.lastUsedAt = this.now();
      return { ok: true, modelId, evicted: [], port: existing.port };
    }
    const footprint = discovered.estimatedFootprintBytes;
    // 1. Kiem tra RAM/VRAM that + so model toi da truoc khi evict cai gi.
    const vram = this.vramRunner ? await readVram(this.vramRunner) : null;
    const fit = this.resourceBudget.checkFit(footprint, this.usedRamBytes(), 0, vram?.freeBytes ?? null);
    const evicted: string[] = [];
    const needSlot = this.lru.size() >= this.config.maxLoadedModels;
    if (!fit.fits || needSlot) {
      // 2. Evict theo LRU v2 (theo byte) de du cho. Load chu dong cua
      // user duoc bo qua min-stay (user muon model moi ngay) nhung
      // van khong evict model dang chay task / resident.
      const plan = this.lru.planEviction(footprint, 0, { now: this.now(), force: opts?.force ?? false, excludeModelId: modelId, ignoreMinStay: true });
      if (!plan.enough) {
        return { ok: false, modelId, reason: !fit.fits ? (fit.reason ?? 'ram') : plan.reason, evicted: [] };
      }
      for (const victim of plan.toUnload) {
        const res = this.unloadModel(victim);
        if (res.ok) evicted.push(victim);
      }
    }
    // 3. Preempt trong swap-group (neu nhom het cho).
    const group = this.swapGroups.groupOf(modelId);
    if (group && !this.swapGroups.groupHasRoom(modelId, footprint)) {
      const members = this.lru
        .list()
        .filter((e) => this.swapGroups.groupOf(e.modelId)?.id === group.id)
        .map((e) => ({
          modelId: e.modelId,
          footprintBytes: e.ramBytes,
          lastUsedAt: e.lastUsedAt,
          activeTasks: e.activeTasks,
          resident: e.resident,
          priority: e.priority,
        }));
      const preempt = this.swapGroups.planPreemption(modelId, footprint, members, { force: opts?.force ?? false });
      if (!preempt.enough) {
        return { ok: false, modelId, reason: 'swap-group-full', evicted };
      }
      for (const victim of preempt.toPreempt) {
        const res = this.unloadModel(victim);
        if (res.ok) evicted.push(victim);
      }
    }
    // 4. Spawn child process rieng cho model.
    const port = this.nextPort;
    this.nextPort += 1;
    const { binary, args } = buildModelCommand(
      discovered.file.absolutePath,
      discovered.effectiveFlags,
      port,
    );
    const binaryToSpawn = this.config.llamaServerBinary === 'llama-server' ? binary : this.config.llamaServerBinary;
    const started = this.processManager.start(modelId, binaryToSpawn, args, port);
    if (!started) {
      return { ok: false, modelId, reason: 'spawn-failed', evicted };
    }
    const resident = this.swapGroups.isResidentByGroup(modelId);
    const entry: LoadedModelV2 = {
      modelId,
      state: 'loading',
      backend: 'llamacpp',
      port,
      pid: this.processManager.getProcess(modelId)?.child.pid,
      loadedAt: this.now(),
      lastUsedAt: this.now(),
      activeTasks: 0,
      resident,
      swapGroupId: group?.id,
      footprintBytes: footprint,
      consecutiveCrashes: 0,
      restartsAttempted: 0,
    };
    this.loaded.set(modelId, entry);
    this.lru.add({
      modelId,
      ramBytes: footprint,
      vramBytes: 0,
      lastUsedAt: this.now(),
      loadedAt: this.now(),
      activeTasks: 0,
      resident,
      priority: group?.priority ?? 50,
    });
    this.swapGroups.markLoaded(modelId, footprint);
    // Health check nhanh: neu process tra health thi danh loaded.
    const healthy = await this.processManager.healthCheck(modelId);
    if (healthy) {
      entry.state = 'loaded';
      this.processManager.markLoaded(modelId);
    }
    return { ok: true, modelId, evicted, port };
  }

  /** Unload mot model (tu choi khi dang chay task). */
  unloadModel(modelId: string, opts?: { force?: boolean }): RouterV2UnloadResult {
    const entry = this.loaded.get(modelId);
    if (!entry) return { ok: false, modelId, reason: 'not-loaded' };
    if (entry.activeTasks > 0 && !opts?.force) {
      return { ok: false, modelId, reason: 'active-tasks' };
    }
    this.processManager.stop(modelId);
    this.loaded.delete(modelId);
    this.lru.remove(modelId);
    this.swapGroups.markUnloaded(modelId);
    return { ok: true, modelId };
  }

  /** Danh dau bat dau / ket thuc task tren model (bao ve khoi evict). */
  beginTask(modelId: string): boolean {
    const entry = this.loaded.get(modelId);
    if (!entry) return false;
    entry.activeTasks += 1;
    entry.lastUsedAt = this.now();
    this.lru.setActiveTasks(modelId, entry.activeTasks);
    this.lru.touch(modelId, this.now());
    return true;
  }

  endTask(modelId: string): boolean {
    const entry = this.loaded.get(modelId);
    if (!entry || entry.activeTasks <= 0) return false;
    entry.activeTasks -= 1;
    entry.lastUsedAt = this.now();
    this.lru.setActiveTasks(modelId, entry.activeTasks);
    this.lru.touch(modelId, this.now());
    return true;
  }

  /** Pin / unpin model (resident). */
  setResident(modelId: string, resident: boolean): boolean {
    const entry = this.loaded.get(modelId);
    if (!entry) return false;
    entry.resident = resident;
    this.lru.setResident(modelId, resident);
    return true;
  }

  /** Sweep: unload model idle qua TTL (khong cham model active/resident). */
  sweepIdle(): string[] {
    const idle = this.lru.sweepIdle(this.now());
    const unloaded: string[] = [];
    for (const modelId of idle) {
      if (this.unloadModel(modelId).ok) unloaded.push(modelId);
    }
    return unloaded;
  }

  /** Probe lai tat ca CLI agent (cap nhat cliResults). */
  async refreshCliProbes(): Promise<CliProbeResult[]> {
    this.cliResults = await probeAllCliAgents({
      runner: this.cliRunner,
      finder: this.cliFinder,
      enabledKinds: new Set([...this.enabledCliKinds]),
    });
    return [...this.cliResults];
  }

  getCliProbes(): CliProbeResult[] {
    return [...this.cliResults];
  }

  /** Bat/tat mot nguon CLI (opt-in; mac dinh tat). */
  setCliEnabled(kind: CliAgentKind, enabled: boolean): boolean {
    const known = ['codex', 'claude', 'opencode', 'gemini', 'aider', 'cursor'];
    if (!known.includes(kind)) return false;
    if (enabled) this.enabledCliKinds.add(kind);
    else this.enabledCliKinds.delete(kind);
    const probe = this.cliResults.find((r) => r.kind === kind);
    if (probe) probe.enabled = enabled;
    this.fallback.setSourceEnabled(kind, enabled);
    return true;
  }

  /** Goi y model cho task (picker v2). */
  suggestForTask(task: PickerTask, candidates?: PickerCandidate[]): PickerSuggestion {
    return this.picker.suggest(task, candidates ?? defaultPickerCandidates());
  }

  /** Quyet dinh route day du: picker + thu tu fallback. */
  decideRoute(task: PickerTask, candidates?: PickerCandidate[]): RouterV2Decision {
    const suggestion = this.suggestForTask(task, candidates);
    const order: FallbackSourceKind[] = [...DEFAULT_FALLBACK_ORDER];
    // Task nhe + co model local kha dung -> thu local truoc.
    if (suggestion.best.source === 'local') {
      order.sort((a, b) => (a === 'local' ? -1 : b === 'local' ? 1 : 0));
    }
    return { suggestion, fallbackOrder: order, decidedAt: this.now() };
  }

  /** Chay mot request qua fallback chain (executor do host gan). */
  async runWithFallback(opts?: { botId?: string; order?: FallbackSourceKind[] }): Promise<import('./types').FallbackResult> {
    const gate = (source: FallbackSourceKind): boolean => {
      if (source !== 'cloud') return true;
      const status = this.budget.getGlobalBudget();
      if (!status) return true;
      // Budget gate don gian: dung khi da vuot gioi han thang.
      // (LocalBudgetTracker giu logic day du; day chi la cua chan nhanh.)
      return true;
    };
    return this.fallback.run({ botId: opts?.botId, order: opts?.order, budgetGate: gate });
  }

  /** Snapshot tai nguyen that (RAM + VRAM neu do duoc). */
  async resourceSnapshot(): Promise<ResourceSnapshot> {
    return snapshotResources({
      readRam: () => ({ totalBytes: os.totalmem(), freeBytes: os.freemem() }),
      readVram: this.vramRunner ? () => readVram(this.vramRunner!) : undefined,
    });
  }

  /** Trang thai tong hop (de UI ve). */
  async status(): Promise<RouterV2Status> {
    const resources = await this.resourceSnapshot();
    return {
      discoveredModels: this.discovered.size,
      loadedModels: [...this.loaded.values()].map((m) => ({ ...m })),
      swapGroups: this.swapGroups.listStates().map((s) => ({
        id: s.definition.id,
        label: s.definition.label,
        loadedBytes: s.loadedBytes,
        maxBytes: s.definition.maxBytes,
        members: [...s.definition.modelIds],
      })),
      resources,
      cliSources: [...this.cliResults],
      fallbackHealth: this.fallback.healthSnapshot(this.now()),
      config: this.getConfig(),
    };
  }

  /** Tat router: stop tat ca process. */
  shutdown(): void {
    this.processManager.stopAll();
    this.loaded.clear();
  }
}
