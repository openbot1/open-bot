/**
 * Continuous batching awareness v116 (v1.39, Doi T3) — scheduler
 * nhan biet batching lien tuc kieu vLLM.
 *
 * Y tuong (vLLM): request khong doi het batch cu chay xong moi vao
 * (static batching) ma duoc chen vao batch dang chay ngay khi con
 * cho (continuous batching); token moi sinh ra theo tung buoc decode
 * chung cho ca batch. V116 KHONG chay vLLM that — module nay la mo
 * hinh uoc tinh + lap lich thua tren mo hinh do, de router biet:
 *
 * 1) `estimateBatch()`: voi N request dong thoi (moi request co so
 *    prompt token + so token can sinh), uoc tinh TTFT (time to first
 *    token), tong thoi gian decode, throughput (token/s), KV cache
 *    can dung va nut that (prefill-bound / decode-bound / KV-bound).
 *    Mo hinh don gian, co ghi ro gia dinh — du de so sanh "chay
 *    rieng le" vs "chay gop batch", khong phai benchmark that.
 * 2) `BatchAdmission`: kiem tra mot request co duoc nhan vao batch
 *    dang chay khong (gioi han so sequence dong thoi, KV cache con
 *    lai, prompt qua dai so voi max model len) — tra ve ly do tu choi
 *    ro rang thay vi im lang.
 * 3) `BatchScheduler`: xep hang doi request (FIFO, uu tien request
 *    ngan truoc khi hang doi dai — short-job-first de giam TTFT trung
 *    binh), chia thanh cac batch theo suc chua, uoc tinh thoi diem
 *    xong tung request. Thuan tinh toan, khong timer.
 * 4) `parseVllmMetrics()`: doc text Prometheus tu endpoint
 *    `/metrics` cua vLLM that (neu host cung cap) thanh snapshot
 *    running/waiting + TTFT — de UI hien thi trang thai that cua
 *    server, khong phai uoc tinh. Parser chi doc so, khong goi mang.
 *
 * Gia dinh mo hinh (ghi ro de khong ai doc nham la so do that):
 * - Prefill: toc do xu ly prompt tuyen tinh theo token.
 * - Decode: moi buoc decode sinh 1 token/sequence; thoi gian moi
 *   buoc tang nhe theo batch size (do doc KV cache nhieu hon).
 * - KV cache: moi token giu `kvBytesPerToken` (tuy model/GPU).
 */

import type { LocalModelEntry } from '../../models/localCatalog';

/** Cau hinh mo hinh batching (theo engine/model cu the). */
export interface ContinuousBatchingConfig {
  /** So sequence toi da dong thoi (vLLM: max_num_seqs). */
  maxNumSeqs: number;
  /** Do dai context toi da cua model (token). */
  maxModelLen: number;
  /** Dung luong KV cache (byte). 0 = khong gioi han rieng. */
  kvCacheBytes: number;
  /** Byte KV moi token (phu thuoc model + dtype). */
  kvBytesPerToken: number;
  /** Toc do prefill (token/s). */
  prefillTokensPerSec: number;
  /** Toc do decode cua 1 sequence chay don (token/s). */
  decodeTokensPerSecPerSeq: number;
  /** He so cham them moi sequence trong batch decode (0..1). */
  decodeBatchOverhead: number;
  /** Do tre co dinh moi buoc lap lich (ms). */
  schedulerDelayMs: number;
}

/** Cau hinh mac dinh: tuong duong mot model 7-8B chay tren GPU
 * 16 GB (KV ~8 GB, prefill 2000 tok/s, decode 40 tok/s/seq). */
export const DEFAULT_BATCHING_CONFIG: ContinuousBatchingConfig = {
  maxNumSeqs: 32,
  maxModelLen: 32768,
  kvCacheBytes: 8 * 1024 * 1024 * 1024,
  kvBytesPerToken: 1024,
  prefillTokensPerSec: 2000,
  decodeTokensPerSecPerSeq: 40,
  decodeBatchOverhead: 0.02,
  schedulerDelayMs: 5,
};

/** Mot request can chay (dau vao cua estimator/scheduler). */
export interface BatchRequest {
  id: string;
  /** So token prompt. */
  promptTokens: number;
  /** So token du kien sinh ra (neu khong ro thi lay muc dich). */
  expectedCompletionTokens: number;
  /** Do uu tien (cao hon = chay truoc khi cung hang doi). Mac dinh 0. */
  priority?: number;
  /** Model phuc vu request (de tinh KV/token neu biet). */
  modelId?: string;
  /** Thoi diem request den (ms epoch, de tinh thoi gian cho). */
  arrivedAt?: number;
};

/** Ket qua uoc tinh cho mot batch (N request chay gop). */
export interface BatchEstimate {
  /** So request trong batch. */
  batchSize: number;
  /** TTFT trung binh (ms): cho hang doi + prefill prompt. */
  avgTtftMs: number;
  /** TTFT cua request cham nhat (ms). */
  maxTtftMs: number;
  /** Tong thoi gian tu khi bat dau den khi request cuoi cung xong (ms). */
  totalDurationMs: number;
  /** Throughput uoc tinh (token/s, ca prompt + completion). */
  throughputTokensPerSec: number;
  /** KV cache uoc tinh can dung (byte). */
  kvCacheBytesUsed: number;
  /** Ti le KV cache su dung (0..1; >1 = khong du KV). */
  kvCacheUtilization: number;
  /** Nut that cua batch. */
  bottleneck: 'prefill-bound' | 'decode-bound' | 'kv-bound' | 'balanced';
  /** true = batch vuot gioi han (KV hoac max seqs) — can tach nho. */
  overCapacity: boolean;
  /** Ghi chu giai thich (de UI hien thi). */
  notes: string[];
  /** Uoc tinh tung request (theo thu tu vao batch). */
  perRequest: Array<{
    id: string;
    ttftMs: number;
    completionMs: number;
    finishMs: number;
  }>;
}

/** Ket qua kiem tra nhan request vao batch dang chay. */
export interface AdmissionDecision {
  admitted: boolean;
  reason: string;
  /** KV con lai sau khi nhan (byte); am = khong du. */
  kvRemainingBytes: number;
  /** So sequence dong thoi sau khi nhan. */
  seqsAfter: number;
}

/** Uoc tinh KV cache can cho mot request (prompt + completion). */
export function kvBytesForRequest(
  request: BatchRequest,
  config: ContinuousBatchingConfig,
): number {
  const tokens = Math.max(0, request.promptTokens + request.expectedCompletionTokens);
  return tokens * Math.max(0, config.kvBytesPerToken);
}

/**
 * Uoc tinh mot batch: cac request vao batch cung luc, prefill tuan
 * tu theo thu tu, decode chay song song den khi request dai nhat xong.
 */
export function estimateBatch(
  requests: BatchRequest[],
  config: ContinuousBatchingConfig = DEFAULT_BATCHING_CONFIG,
  queueWaitMs = 0,
): BatchEstimate {
  const batchSize = requests.length;
  const notes: string[] = [];
  if (batchSize === 0) {
    return {
      batchSize: 0,
      avgTtftMs: 0,
      maxTtftMs: 0,
      totalDurationMs: 0,
      throughputTokensPerSec: 0,
      kvCacheBytesUsed: 0,
      kvCacheUtilization: 0,
      bottleneck: 'balanced',
      overCapacity: false,
      notes: ['Batch rong.'],
      perRequest: [],
    };
  }
  const overSeqs = batchSize > config.maxNumSeqs;
  if (overSeqs) notes.push(`Batch ${batchSize} vuot max_num_seqs ${config.maxNumSeqs} — can tach thanh nhieu batch.`);
  const kvUsed = requests.reduce((sum, r) => sum + kvBytesForRequest(r, config), 0);
  const kvUtil = config.kvCacheBytes > 0 ? kvUsed / config.kvCacheBytes : 0;
  const overKv = kvUtil > 1;
  if (overKv) notes.push(`KV cache can ${Math.round(kvUsed / 1e6)} MB, vuot gioi han ${Math.round(config.kvCacheBytes / 1e6)} MB.`);

  // Prefill tuan tu: request thu i doi (i prompt truoc no) + prompt minh.
  // queueWaitMs = thoi gian doi truoc khi batch bat dau (tinh vao TTFT
  // tung request, KHONG tinh vao totalDurationMs cua batch).
  const perRequest: BatchEstimate['perRequest'] = [];
  let prefillElapsedMs = 0;
  let maxCompletion = 0;
  let totalTokens = 0;
  for (const request of requests) {
    const prefillMs = config.prefillTokensPerSec > 0
      ? (request.promptTokens / config.prefillTokensPerSec) * 1000
      : 0;
    const ttftMs = queueWaitMs + prefillElapsedMs + prefillMs + config.schedulerDelayMs;
    prefillElapsedMs += prefillMs;
    // Decode: moi buoc sinh 1 token/sequence; batch cang dong thi
    // moi buoc cang cham (overhead theo so sequence).
    const stepMs = config.decodeTokensPerSecPerSeq > 0
      ? (1000 / config.decodeTokensPerSecPerSeq) * (1 + config.decodeBatchOverhead * (batchSize - 1))
      : 0;
    const completionMs = Math.max(0, request.expectedCompletionTokens) * stepMs;
    maxCompletion = Math.max(maxCompletion, completionMs);
    totalTokens += request.promptTokens + request.expectedCompletionTokens;
    perRequest.push({ id: request.id, ttftMs, completionMs, finishMs: ttftMs + completionMs });
  }
  const avgTtftMs = perRequest.reduce((s, r) => s + r.ttftMs, 0) / perRequest.length;
  const maxTtftMs = Math.max(...perRequest.map((r) => r.ttftMs));
  const totalDurationMs = prefillElapsedMs + maxCompletion;
  const throughputTokensPerSec = totalDurationMs > 0 ? (totalTokens / totalDurationMs) * 1000 : 0;

  let bottleneck: BatchEstimate['bottleneck'];
  if (overKv) {
    bottleneck = 'kv-bound';
  } else if (prefillElapsedMs > maxCompletion * 1.5) {
    bottleneck = 'prefill-bound';
    notes.push('Prefill chiem phan lon thoi gian — prompt dai hoac batch dong.');
  } else if (maxCompletion > prefillElapsedMs * 1.5) {
    bottleneck = 'decode-bound';
    notes.push('Decode chiem phan lon thoi gian — nhieu token can sinh.');
  } else {
    bottleneck = 'balanced';
  }
  if (!overSeqs && !overKv && bottleneck === 'balanced') {
    notes.push('Batch can bang: prefill va decode tuong duong nhau.');
  }
  return {
    batchSize,
    avgTtftMs,
    maxTtftMs,
    totalDurationMs,
    throughputTokensPerSec,
    kvCacheBytesUsed: kvUsed,
    kvCacheUtilization: kvUtil,
    bottleneck,
    overCapacity: overSeqs || overKv,
    notes,
    perRequest,
  };
}

/** So sanh chay gop batch vs chay rieng le tung request. */
export function compareBatchVsSolo(
  requests: BatchRequest[],
  config: ContinuousBatchingConfig = DEFAULT_BATCHING_CONFIG,
): { batch: BatchEstimate; soloTotalMs: number; speedup: number; savedMs: number } {
  const batch = estimateBatch(requests, config);
  let soloTotalMs = 0;
  for (const request of requests) {
    soloTotalMs += estimateBatch([request], config).totalDurationMs;
  }
  const speedup = batch.totalDurationMs > 0 ? soloTotalMs / batch.totalDurationMs : 1;
  return { batch, soloTotalMs, speedup, savedMs: Math.max(0, soloTotalMs - batch.totalDurationMs) };
}

/**
 * Kiem tra mot request co duoc nhan vao batch dang chay khong.
 * `running` la cac request dang chay (KV + so sequence hien tai).
 */
export function admitRequest(
  request: BatchRequest,
  running: BatchRequest[],
  config: ContinuousBatchingConfig = DEFAULT_BATCHING_CONFIG,
): AdmissionDecision {
  const seqsAfter = running.length + 1;
  if (seqsAfter > config.maxNumSeqs) {
    return {
      admitted: false,
      reason: `Da dat max_num_seqs ${config.maxNumSeqs} — request phai doi batch sau.`,
      kvRemainingBytes: kvRemaining(config, running),
      seqsAfter,
    };
  }
  if (request.promptTokens + request.expectedCompletionTokens > config.maxModelLen) {
    return {
      admitted: false,
      reason: `Request dai ${request.promptTokens + request.expectedCompletionTokens} token, vuot max_model_len ${config.maxModelLen}.`,
      kvRemainingBytes: kvRemaining(config, running),
      seqsAfter,
    };
  }
  const need = kvBytesForRequest(request, config);
  const remaining = kvRemaining(config, running);
  if (config.kvCacheBytes > 0 && need > remaining) {
    return {
      admitted: false,
      reason: `KV cache khong du: can ${Math.round(need / 1e6)} MB, con ${Math.round(remaining / 1e6)} MB.`,
      kvRemainingBytes: remaining,
      seqsAfter,
    };
  }
  return {
    admitted: true,
    reason: `Nhan vao batch (${seqsAfter}/${config.maxNumSeqs} sequence).`,
    kvRemainingBytes: remaining - need,
    seqsAfter,
  };
}

function kvRemaining(config: ContinuousBatchingConfig, running: BatchRequest[]): number {
  if (config.kvCacheBytes <= 0) return Number.POSITIVE_INFINITY;
  const used = running.reduce((sum, r) => sum + kvBytesForRequest(r, config), 0);
  return config.kvCacheBytes - used;
}

/** Mot batch da xep lich (de tra ve tu scheduler). */
export interface ScheduledBatch {
  /** Thu tu batch (0 = chay dau tien). */
  index: number;
  requests: BatchRequest[];
  estimate: BatchEstimate;
  /** Thoi diem bat dau (ms, tuong doi tu luc scheduler chay). */
  startsAtMs: number;
}

/**
 * BatchScheduler — xep hang doi request thanh cac batch theo suc
 * chua, theo chinh sach sap xep (FIFO hoac short-job-first).
 */
export class BatchScheduler {
  private readonly config: ContinuousBatchingConfig;

  constructor(config?: Partial<ContinuousBatchingConfig>) {
    this.config = { ...DEFAULT_BATCHING_CONFIG, ...config };
  }

  getConfig(): ContinuousBatchingConfig {
    return { ...this.config };
  }

  /**
   * Xep lich: sap xep request (mac dinh FIFO theo arrivedAt; neu
   * `shortJobFirst` thi request ngan len truoc khi hang doi dai),
   * roi cat thanh batch vua suc chua (max seqs + KV). Moi batch chay
   * sau batch truoc (mo hinh don gian 1 worker).
   */
  schedule(
    requests: BatchRequest[],
    options: { shortJobFirst?: boolean; queueWaitMs?: number } = {},
  ): ScheduledBatch[] {
    const sorted = [...requests].sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pb - pa;
      if (options.shortJobFirst) {
        const la = a.promptTokens + a.expectedCompletionTokens;
        const lb = b.promptTokens + b.expectedCompletionTokens;
        if (la !== lb) return la - lb;
      }
      return (a.arrivedAt ?? 0) - (b.arrivedAt ?? 0);
    });
    const batches: ScheduledBatch[] = [];
    let current: BatchRequest[] = [];
    let startsAtMs = options.queueWaitMs ?? 0;
    const flush = () => {
      if (current.length === 0) return;
      const estimate = estimateBatch(current, this.config, startsAtMs);
      batches.push({ index: batches.length, requests: [...current], estimate, startsAtMs });
      startsAtMs += estimate.totalDurationMs;
      current = [];
    };
    for (const request of sorted) {
      const decision = admitRequest(request, current, this.config);
      if (!decision.admitted && current.length > 0) {
        flush();
      }
      // Request don le vuot suc chua (prompt qua dai): van xep rieng
      // 1 batch de UI thay ro ly do overCapacity thay vi mat request.
      current.push(request);
      if (current.length >= this.config.maxNumSeqs) flush();
    }
    flush();
    return batches;
  }
}

/** Snapshot trang thai that cua mot server vLLM (tu /metrics). */
export interface VllmMetricsSnapshot {
  /** So request dang chay (decode). */
  numRunning: number | null;
  /** So request dang doi (prefill queue). */
  numWaiting: number | null;
  /** TTFT trung binh (giay) — neu server expose. */
  avgTtftSeconds: number | null;
  /** Thoi gian sinh token trung binh (giay/token). */
  avgGenerationSeconds: number | null;
  /** Ti le KV cache dang dung (0..1). */
  kvCacheUsage: number | null;
  /** So token da sinh (counter). */
  numTokensGenerated: number | null;
  /** Cac metric khac tim duoc (ten -> gia tri). */
  extra: Record<string, number>;
}

/**
 * Parse text Prometheus tu vLLM `/metrics` (vd `vllm:num_requests_running 3`).
 * Chi doc so — khong goi mang. Metric khong co thi null (khong doan).
 */
export function parseVllmMetrics(text: string): VllmMetricsSnapshot {
  const snapshot: VllmMetricsSnapshot = {
    numRunning: null,
    numWaiting: null,
    avgTtftSeconds: null,
    avgGenerationSeconds: null,
    kvCacheUsage: null,
    numTokensGenerated: null,
    extra: {},
  };
  const wanted: Record<string, keyof Omit<VllmMetricsSnapshot, 'extra'>> = {
    'vllm:num_requests_running': 'numRunning',
    'vllm:num_requests_waiting': 'numWaiting',
    'vllm:time_to_first_token_seconds_sum': 'avgTtftSeconds',
    'vllm:time_per_output_token_seconds_sum': 'avgGenerationSeconds',
    'vllm:kv_cache_usage_perc': 'kvCacheUsage',
    'vllm:num_requests_total': 'numTokensGenerated',
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+-]+)/.exec(line);
    if (!match) continue;
    const name = match[1];
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    const field = wanted[name];
    if (field) {
      (snapshot as unknown as Record<string, number | null>)[field] = value;
    } else if (name.startsWith('vllm:')) {
      snapshot.extra[name] = value;
    }
  }
  return snapshot;
}

/** Go i y cau hinh batching theo model catalogue (KV/token theo params). */
export function batchingConfigForModel(
  entry: LocalModelEntry,
  gpuMemBytes: number,
  overrides?: Partial<ContinuousBatchingConfig>,
): ContinuousBatchingConfig {
  // Uoc tinh tho: KV/token ~ paramsB * 2 byte/layer-ish; dung he so
  // don gian 512 byte / ti param (ghi ro la uoc tinh de host hieu chinh).
  const kvBytesPerToken = Math.max(256, Math.round(entry.paramsB * 512));
  const kvCacheBytes = Math.max(0, Math.floor(gpuMemBytes * 0.5));
  return {
    ...DEFAULT_BATCHING_CONFIG,
    kvBytesPerToken,
    kvCacheBytes,
    maxModelLen: entry.contextTokens,
    ...overrides,
  };
}
