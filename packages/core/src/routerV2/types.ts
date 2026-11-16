/**
 * Local-model router v2 — shared types (v1.16, Doi T3).
 *
 * Y tuong (hoc tu llama.cpp router-mode tu 12/2025 + llama-swap, viet
 * lai hoan toan cho open-bot, khong copy code/text/tai san repo nao):
 * - Router khong giu model nao mac dinh: model duoc load on-demand
 *   theo `model` trong request, moi model mot child process rieng
 *   (crash mot model khong keo sap router), unload theo LRU + TTL
 *   dua tren RAM/VRAM THAT (khong chi dem model nhu --models-max).
 * - Swap-groups: nhom model chia se tai nguyen; embedder / model nho
 *   co chinh sach "luon resident"; preemption co thu tu uu tien.
 * - Model picker v2: cham diem task -> model theo cost/latency/
 *   quality, co giai thich, ghi nho lua chon cua user.
 * - Auto-detect CLI agents sau hon: probe version + login + model
 *   list, adapter co version range, format la thi ha cap chu khong gay.
 * - Fallback chain: cloud -> CLI agent -> local -> loi co huong dan;
 *   circuit breaker + health check theo tung nguon; spend tracking
 *   noi tiep budget v1.15.
 *
 * Local-first, mien phi, khong du lieu X, khong cloud VM/tai khoan/
 * thanh toan. Khong goi model that, khong doc credential.
 */

/** Backend chay model local trong router v2. */
export type RouterV2Backend = 'llamacpp' | 'ollama' | 'custom';

/** Trang thai cua mot model trong router v2. */
export type RouterV2ModelState =
  | 'discovered' // thay file/preset nhung chua load
  | 'loading'
  | 'loaded'
  | 'unloading'
  | 'unloaded'
  | 'failed'
  | 'crashed';

/** Kieu KV cache (anh huong truc tiep RAM/VRAM uoc tinh). */
export type KvCacheType = 'f16' | 'q8_0' | 'q4_0';

/** Loai sampler / tham so lay mau per-model. */
export interface SamplerFlags {
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  minP?: number;
}

/**
 * Per-model flags — tuong duong preset INI per-model cua llama.cpp
 * (`--models-preset`): context, KV cache, sampler, GPU layers.
 * Moi gia tri deu co gioi han hop le (xem presets.ts).
 */
export interface PerModelFlags {
  /** Kich thuoc context (token). Mac dinh 8192. */
  contextSize: number;
  /** Kieu KV cache. Mac dinh 'f16'. */
  kvCacheType: KvCacheType;
  /** So thread CPU. 0 = tu dong. */
  threads: number;
  /** So layer chay tren GPU. -1 = tat ca (neu co GPU), 0 = CPU only. */
  gpuLayers: number;
  /** Sampler. */
  sampler: SamplerFlags;
  /** Co so CLI phu them (da tach token, khong chua secret). */
  extraArgs: string[];
}

/** Gia tri mac dinh cho per-model flags. */
export const DEFAULT_PER_MODEL_FLAGS: PerModelFlags = {
  contextSize: 8192,
  kvCacheType: 'f16',
  threads: 0,
  gpuLayers: -1,
  sampler: { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1, minP: 0.05 },
  extraArgs: [],
};

/** Mot file GGUF tren dia (ket qua quet models-dir). */
export interface GgufModelFile {
  /** Id on dinh: ten file khong duoi .gguf, chu thuong, gach noi. */
  id: string;
  /** Ten file goc, vd "qwen3-4b-q4_k_m.gguf". */
  fileName: string;
  /** Duong dan tuyet doi. */
  absolutePath: string;
  /** Kich thuoc file (byte). */
  sizeBytes: number;
  /** Magic GGUF hop le khong (doc 4 byte dau). */
  validMagic: boolean;
  /** GGUF version (2 hoac 3) khi doc duoc header; null khi khong doc duoc. */
  ggufVersion: number | null;
  /** Ten model trong metadata `general.name` (neu co). */
  metadataName?: string;
  /** Kien truc trong metadata `general.architecture` (neu co). */
  architecture?: string;
  /** Context length trong metadata (neu co). */
  metadataContextLength?: number;
  /** So block (layer) trong metadata (neu co). */
  blockCount?: number;
  /** So KV head trong metadata (neu co). */
  kvHeadCount?: number;
  /** Kich thuoc head (embedding / head) trong metadata (neu co). */
  headDim?: number;
  /** Thoi diem quet thay file (ms epoch). */
  discoveredAt: number;
}

/** Mot preset INI cho mot model (section `[model:<id>]` hoac `[preset:<ten>]`). */
export interface ModelPreset {
  /** Ten preset (ten section sau dau hai cham). */
  name: string;
  /** Model id ma preset ap cho; undefined = preset chung, ap theo ten. */
  modelId?: string;
  /** Flags da parse (chi nhung key hop le; key la bi bo + ghi warning). */
  flags: Partial<PerModelFlags>;
  /** Sampler rieng (tach ra de de merge). */
  sampler: SamplerFlags;
  /** Extra args tu preset. */
  extraArgs: string[];
  /** Canh bao khi parse (key khong biet / gia tri ngoai gioi han). */
  warnings: string[];
  /** Duong dan file preset goc. */
  sourcePath: string;
}

/** Mot model da discovered: file GGUF + preset (neu co) + flags hieu luc. */
export interface DiscoveredModel {
  file: GgufModelFile;
  /** Preset khop model id (neu co). */
  preset?: ModelPreset;
  /** Flags hieu luc = mac dinh + preset + override cua user (chua ap). */
  effectiveFlags: PerModelFlags;
  /** RAM/VRAM uoc tinh de load (byte) — xem resourceEstimator.ts. */
  estimatedFootprintBytes: number;
  /** RAM uoc tinh cho KV cache o context hieu luc (byte). */
  estimatedKvBytes: number;
}

/** Chinh sach resident cua mot swap-group. */
export type ResidentPolicy = 'always' | 'on-demand';

/** Dinh nghia mot swap-group: cac model chia se mot ngan tai nguyen. */
export interface SwapGroupDefinition {
  /** Id nhom, vd "gpu-main", "embedders". */
  id: string;
  /** Ten hien thi. */
  label: string;
  /** Model id thuoc nhom. */
  modelIds: string[];
  /** RAM/VRAM toi da nhom duoc dung (byte). 0 = khong gioi han rieng. */
  maxBytes: number;
  /** Chinh sach resident: 'always' = giu model trong nhom, khong evict. */
  residentPolicy: ResidentPolicy;
  /** Thu tu uu tien cua nhom khi tranh tai nguyen (cao hon = giu lai). */
  priority: number;
}

/** Trang thai load cua mot model trong runtime router v2. */
export interface LoadedModelV2 {
  modelId: string;
  state: RouterV2ModelState;
  backend: RouterV2Backend;
  /** Port loopback cua child process (neu loaded). */
  port?: number;
  /** PID cua child process (neu co). */
  pid?: number;
  loadedAt?: number;
  lastUsedAt?: number;
  /** So task dang chay tren model (LRU/TTL khong unload khi > 0). */
  activeTasks: number;
  /** true = user pin hoac resident-policy: khong evict tru khi bat buoc. */
  resident: boolean;
  /** Swap-group cua model (neu co). */
  swapGroupId?: string;
  /** RAM that model dang chiem (uoc tinh luc load, byte). */
  footprintBytes: number;
  /** So lan crash lien tiep (de backoff). */
  consecutiveCrashes: number;
  /** Loi lan load/crash gan nhat. */
  lastError?: string;
  /** So lan restart tu dong da thu (trong chu ky crash hien tai). */
  restartsAttempted: number;
}

/** Anh chup tai nguyen he thong that (RAM + VRAM neu do duoc). */
export interface ResourceSnapshot {
  totalRamBytes: number;
  freeRamBytes: number;
  /** Tong VRAM (byte); null = khong do duoc (khong co GPU / khong co cong cu). */
  totalVramBytes: number | null;
  /** VRAM trong (byte); null = khong do duoc. */
  freeVramBytes: number | null;
  /** Nguon so VRAM: 'nvidia-smi' | 'unavailable'. */
  vramSource: 'nvidia-smi' | 'unavailable';
  takenAt: number;
}

/** Cau hinh router v2. */
export interface RouterV2Config {
  /** Thu muc quet GGUF (models-dir). Co the nhieu thu muc. */
  modelsDirs: string[];
  /** Thu muc / file preset INI (models-preset). */
  presetPaths: string[];
  /** So model toi da dong thoi (tran tren, nhu --models-max). */
  maxLoadedModels: number;
  /** RAM toi da cho model (byte). 0 = dung 80% RAM tong. */
  maxRamBytes: number;
  /** VRAM toi da cho model (byte). 0 = dung VRAM trong do duoc (neu co). */
  maxVramBytes: number;
  /** Idle bao lau (ms) thi duoc phep unload. Mac dinh 10 phut. */
  idleTimeoutMs: number;
  /** So lan restart toi da sau crash lien tiep truoc khi danh 'failed'. */
  maxRestarts: number;
  /** Backoff co so giua cac lan restart (ms); nhan doi moi lan. */
  restartBackoffBaseMs: number;
  /** Backoff toi da (ms). */
  restartBackoffMaxMs: number;
  /** RAM giu lai cho he thong (byte). undefined = 10% RAM tong. */
  reservedRamBytes?: number;
  /** Port loopback bat dau cap cho child process. */
  portStart: number;
  /** Binary llama-server (neu dung backend llamacpp). */
  llamaServerBinary: string;
}

/** Cau hinh mac dinh router v2. */
export const DEFAULT_ROUTER_V2_CONFIG: RouterV2Config = {
  modelsDirs: [],
  presetPaths: [],
  maxLoadedModels: 2,
  maxRamBytes: 0,
  maxVramBytes: 0,
  idleTimeoutMs: 10 * 60 * 1000,
  maxRestarts: 3,
  restartBackoffBaseMs: 1000,
  restartBackoffMaxMs: 30_000,
  portStart: 18_100,
  llamaServerBinary: 'llama-server',
};

/** Loai task cho picker v2 (mo rong tu v1.15). */
export type PickerTaskKind =
  | 'simple-chat'
  | 'code'
  | 'reasoning'
  | 'research'
  | 'creative'
  | 'howto'
  | 'summarize'
  | 'translate'
  | 'embedding'
  | 'vision';

/** Muc uu tien cua user khi chon model: nhanh / re / chat luong. */
export type PickerPreference = 'speed' | 'cost' | 'quality' | 'balanced';

/** Mo ta mot task can picker v2 cham diem. */
export interface PickerTask {
  kind: PickerTaskKind;
  /** Do dai prompt uoc tinh (token). */
  promptTokens: number;
  /** Co can tool-use khong. */
  needsToolUse: boolean;
  /** Co can context dai (> 32k) khong. */
  needsLongContext: boolean;
  /** Do uu tien chat luong (0..1). */
  qualityNeed: number;
  /** User uu tien gi (mac dinh 'balanced'). */
  preference?: PickerPreference;
  /** User chi dinh model cu the (override). */
  manualModelId?: string;
  /** Bot goi task (de tinh budget per-bot). */
  botId?: string;
}

/** Nguon chay cua mot candidate: local / CLI agent / cloud. */
export type PickerSourceKind = 'local' | 'cli' | 'cloud';

/** Mot ung vien model cho picker v2. */
export interface PickerCandidate {
  /** Id model (id local, ten model cloud, hoac "cli:<kind>:<model>"). */
  modelId: string;
  source: PickerSourceKind;
  /** Nguon CLI cu the (khi source = 'cli'). */
  cliKind?: string;
  /** Chi phi uoc tinh (USD / 1k token). */
  costPer1kTokensUsd: number;
  /** Latency uoc tinh den token dau tien (ms). */
  estLatencyMs: number;
  /** Chat luong uoc tinh (0..1). */
  quality: number;
  /** Model co dang loaded san khong (local) / kha dung khong. */
  available: boolean;
  /** Ly do loai bo (neu khong du kha nang). */
  excludedReason?: string;
  /** Kich thuoc model (ty tham so) — de giai thich "task nho -> model nho". */
  paramsB?: number;
}

/** Ket qua cham diem mot ung vien. */
export interface ScoredPickerCandidate extends PickerCandidate {
  score: number;
  breakdown: { costScore: number; latencyScore: number; qualityScore: number };
  /** Giai thich ngan gon, de UI hien (tieng Viet). */
  explanation: string;
}

/** Goi y cua picker v2. */
export interface PickerSuggestion {
  task: PickerTask;
  best: ScoredPickerCandidate;
  /** Cac ung vien khac theo thu tu diem giam dan. */
  ranked: ScoredPickerCandidate[];
  /** Giai thich tong (vi sao chon best). */
  reason: string;
  /** true = user da chi dinh thu cong. */
  manualOverride: boolean;
  /** true = goi y bi anh huong boi lua chon truoc cua user. */
  influencedByMemory: boolean;
  decidedAt: number;
}

/** Mot lua chon user da ghi nho (de picker hoc theo). */
export interface RememberedChoice {
  /** Khoa task: `${kind}:${preference ?? 'balanced'}` (+ bucket prompt). */
  taskKey: string;
  modelId: string;
  source: PickerSourceKind;
  /** So lan user chon model nay cho taskKey nay. */
  timesChosen: number;
  lastChosenAt: number;
}

/** CLI agent ma router v2 biet probe sau (mo rong detected v1). */
export type CliAgentKind = 'codex' | 'claude' | 'opencode' | 'gemini' | 'aider' | 'cursor';

/** Adapter version cho mot CLI: version range ho tro + cach doc format. */
export interface CliAdapter {
  kind: CliAgentKind;
  label: string;
  /** Ten binary (co the nhieu ten, thu theo thu tu). */
  binaries: string[];
  /** Version toi thieu ho tro. */
  minVersion: string;
  /** Version toi da da kiem chung (tren la "chua kiem chung", van thu). */
  maxTestedVersion: string;
  /** Args lay version. */
  versionArgs: string[];
  /** Args kiem tra dang nhap (doi voi CLI co lenh status). */
  authArgs: string[] | null;
  /** Args liet ke model (neu CLI co). null = khong co lenh list. */
  listModelsArgs: string[] | null;
  /** Kieu kiem tra dang nhap. */
  authMethod: 'cli-status' | 'cli-list' | 'env-present' | 'file-label' | 'none';
  /** Dau hieu format output da biet (de phat hien format la). */
  knownFormatMarkers: string[];
}

/** Ket qua probe sau mot CLI agent. */
export interface CliProbeResult {
  kind: CliAgentKind;
  label: string;
  /** Binary co ton tai tren PATH khong. */
  exists: boolean;
  binaryPath: string | null;
  /** Version probe duoc (null khi khong doc duoc). */
  version: string | null;
  /** Version co trong range ho tro khong. */
  versionSupported: boolean;
  /** true = version moi hon max da kiem chung (van dung duoc, co canh bao). */
  versionUntested: boolean;
  /** Format output co khop adapter khong ('known' | 'unknown' | 'not-checked'). */
  formatStatus: 'known' | 'unknown' | 'not-checked';
  /** Da dang nhap chua (theo CLI tu bao). */
  loggedIn: boolean | null;
  /** Nhan tai khoan (email/ten) — CHI NHAN, khong bao gio token. */
  accountLabel?: string;
  /** Model CLI nay co the chay (tu lenh list hoac mac dinh cua CLI). */
  models: string[];
  /** Canh bao (format la, version chua kiem chung...). */
  warnings: string[];
  /** Ly do ngan khi khong dung duoc. */
  unavailableReason?: string;
  /** User da bat nguon nay chua (opt-in; mac dinh false). */
  enabled: boolean;
  probedAt: number;
}

/** Nguon trong fallback chain. */
export type FallbackSourceKind = 'cloud' | 'cli' | 'local';

/** Trang thai circuit breaker cua mot nguon. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Trang thai circuit breaker + health cua mot nguon fallback. */
export interface SourceHealth {
  source: FallbackSourceKind;
  /** Dinh danh nguon: ten provider / kind CLI / model id local. */
  sourceId: string;
  circuit: CircuitState;
  /** So loi lien tiep hien tai. */
  consecutiveFailures: number;
  /** So loi lien tiep thi mo circuit. */
  failureThreshold: number;
  /** Thoi diem circuit mo (ms); undefined khi closed. */
  openedAt?: number;
  /** Thoi gian circuit mo truoc khi thu lai (ms). */
  resetTimeoutMs: number;
  /** Lan health check thanh cong gan nhat (ms). */
  lastHealthyAt?: number;
  /** Lan health check gan nhat (ms). */
  lastCheckedAt?: number;
  /** Loi gan nhat (da cat ngan, khong secret). */
  lastError?: string;
}

/** Mot buoc thu trong fallback chain. */
export interface FallbackAttempt {
  source: FallbackSourceKind;
  sourceId: string;
  outcome: 'success' | 'failed' | 'skipped-circuit-open' | 'skipped-disabled' | 'skipped-budget';
  error?: string;
  latencyMs: number;
  attemptedAt: number;
}

/** Ket qua chay fallback chain cho mot request. */
export interface FallbackResult {
  /** true = co nguon tra ket qua. */
  ok: boolean;
  /** Nguon da phuc vu (neu ok). */
  servedBy?: FallbackSourceKind;
  /** Dinh danh nguon da phuc vu. */
  servedById?: string;
  /** Cac buoc da thu (theo thu tu). */
  attempts: FallbackAttempt[];
  /** Huong dan cho user khi tat ca nguon deu loi (tieng Viet). */
  guidance?: string;
  /** Chi phi uoc tinh cua call thanh cong (USD) — ghi vao budget. */
  costUsd?: number;
  totalLatencyMs: number;
}

/** Quyet dinh route tong cua router v2 cho mot task. */
export interface RouterV2Decision {
  suggestion: PickerSuggestion;
  /** Nguon fallback se thu theo thu tu (cloud -> cli -> local...). */
  fallbackOrder: FallbackSourceKind[];
  decidedAt: number;
}

/** Trang thai tong hop cua router v2 (de UI ve). */
export interface RouterV2Status {
  discoveredModels: number;
  loadedModels: LoadedModelV2[];
  swapGroups: { id: string; label: string; loadedBytes: number; maxBytes: number; members: string[] }[];
  resources: ResourceSnapshot;
  cliSources: CliProbeResult[];
  fallbackHealth: SourceHealth[];
  config: RouterV2Config;
}
