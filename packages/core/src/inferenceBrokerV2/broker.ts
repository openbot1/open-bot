/**
 * Inference broker v2 — orchestrator (v1.33, Doi T5).
 *
 * Noi cac manh lai voi nhau va noi vao router hien co (routerV3) thay
 * vi viet he song song:
 * - Capability matrix (capabilityMatrix.ts) -> route task -> engine +
 *   model, ke ca fallback chain (Ollama -> llama.cpp khi thieu
 *   tool_choice / strict).
 * - Probe registry (probe.ts) -> capability THAT ghi de khai bao khi
 *   chon engine; engine probe that bai khong duoc chon lam primary.
 * - Validation gate (validate.ts) -> moi tool call trong response
 *   deu validate truoc khi tra ve cho caller thuc thi; call sai
 *   schema bi chan + gui thong diep sua loi de model retry co gioi
 *   han (khong retry vo han).
 * - Prefix cache (prefixCache.ts) -> moi turn cua agent loop do hit
 *   rate truoc khi gui, ghi prefix sau khi gui.
 * - RouterV3: model local da probe tot duoc dang ky vao
 *   UnifiedRouterV3 voi capability da dieu chinh theo probe
 *   (toolCalling = probe that, khong phai khai bao); router van la
 *   noi cham diem + fallback + circuit breaker nhu cu.
 *
 * Executor chat inject duoc (test dung mock, khong goi API that).
 * Khong doc credential. Voice realtime van mock neu khong co key
 * that — xem voiceV22.ts (mock-first theo lenh dung).
 */

import type { ChatCompletionRequest, ChatMessage, ProviderResponse, ToolCall } from '../types';
import type { UnifiedRouterV3 } from '../routerV3/routerV3';
import type { RouterV3LocalModel } from '../routerV3/types';
import { capabilitiesForModel } from '../routerV3/capabilities';
import {
  inferenceBrokerV2EngineLabel,
  pickModelForTaskV2,
  requirementsForTask,
  routeTaskToEngineV2,
  type InferenceBrokerV2EngineKind,
  type InferenceBrokerV2EngineScore,
  type InferenceBrokerV2TaskKind,
  type InferenceBrokerV2TaskRequirements,
} from './capabilityMatrix';
import {
  InferenceBrokerV2ProbedRegistry,
  probeBrokerV2Engines,
  resolveBrokerV2Fallback,
  type InferenceBrokerV2ProbeFetch,
  type InferenceBrokerV2ProbedCapability,
} from './probe';
import {
  InferenceBrokerV2PrefixCache,
  type InferenceBrokerV2CacheMessage,
  type InferenceBrokerV2PrefixLookup,
} from './prefixCache';
import {
  brokerV2RepairMessage,
  InferenceBrokerV2ValidationGate,
  type InferenceBrokerV2ToolDefinition,
} from './validate';

/** Executor chat cua broker: nhan engine + request, tra response chuan hoa. */
export type InferenceBrokerV2ChatExecutor = (
  engine: InferenceBrokerV2EngineKind,
  baseUrl: string,
  req: ChatCompletionRequest,
) => Promise<ProviderResponse>;

/** 1 lan chat qua broker (da validate tool call + prefix cache). */
export interface InferenceBrokerV2ChatResult {
  /** true = co response hop le (text hoac tool call da validate). */
  ok: boolean;
  /** Response chuan hoa (khi ok). */
  response?: ProviderResponse;
  /** Engine da phuc vu. */
  servedByEngine?: InferenceBrokerV2EngineKind;
  /** Model da phuc vu. */
  servedByModel?: string;
  /** Prefix lookup cua turn nay (do truoc khi gui). */
  prefixLookup?: InferenceBrokerV2PrefixLookup;
  /** So lan retry do tool call bi chan (0 = khong can). */
  validationRetries: number;
  /** So tool call bi chan trong lan chat nay. */
  blockedToolCalls: number;
  /** Ly do chan (neu co). */
  blockedReasons: string[];
  /** Chuoi fallback da thu (neu primary loi). */
  attemptedEngines: InferenceBrokerV2EngineKind[];
  /** Loi cuoi (khi khong ok). */
  error?: string;
  /** Tong latency (ms). */
  totalLatencyMs: number;
}

/** Thong ke cua broker. */
export interface InferenceBrokerV2Stats {
  chats: number;
  chatsOk: number;
  toolCallsValidated: number;
  toolCallsBlocked: number;
  validationRetries: number;
  fallbacksUsed: number;
  prefixHitRate: number;
}

/** Cau hinh broker. */
export interface InferenceBrokerV2Options {
  /** Cac engine ung vien (mac dinh ca 4). */
  engines?: readonly InferenceBrokerV2EngineKind[];
  /** Base URL rieng cho tung engine (ghi de mac dinh). */
  baseUrls?: Readonly<Partial<Record<InferenceBrokerV2EngineKind, string>>>;
  /** Dinh nghia tool cho gate validate (mac dinh rong — caller dang ky). */
  toolDefinitions?: readonly InferenceBrokerV2ToolDefinition[];
  /** So lan retry toi da khi tool call bi chan. */
  maxValidationRetries?: number;
  /** Executor chat (mac dinh: throw ro rang — host phai inject). */
  executor?: InferenceBrokerV2ChatExecutor;
  /** Fetch dung de probe engine (mac dinh: khong probe tu dong). */
  probeFetch?: InferenceBrokerV2ProbeFetch;
  /** Gioi han node prefix cache. */
  prefixCacheMaxNodes?: number;
  /** Clock inject duoc (test). */
  now?: () => number;
}

/** Executor mac dinh: bao loi ro — broker khong tu goi HTTP lung tung. */
export const BROKER_V2_NO_EXECUTOR_ERROR =
  'Inference broker v2 chua co chat executor — host phai inject executor (vd routerV3 executor hoac fetch OpenAI-compatible).';

/**
 * Inference broker v2: chon engine theo task + probe that + validate
 * tool call + prefix cache cho agent loop.
 */
export class InferenceBrokerV2 {
  readonly registry: InferenceBrokerV2ProbedRegistry;
  readonly prefixCache: InferenceBrokerV2PrefixCache;
  readonly gate: InferenceBrokerV2ValidationGate;
  private readonly engines: readonly InferenceBrokerV2EngineKind[];
  private readonly baseUrls: Partial<Record<InferenceBrokerV2EngineKind, string>>;
  private readonly executor?: InferenceBrokerV2ChatExecutor;
  private readonly probeFetch?: InferenceBrokerV2ProbeFetch;
  private readonly nowFn: () => number;
  private chats = 0;
  private chatsOk = 0;
  private toolCallsValidated = 0;
  private toolCallsBlocked = 0;
  private validationRetries = 0;
  private fallbacksUsed = 0;

  constructor(opts?: InferenceBrokerV2Options) {
    this.engines = opts?.engines ?? ['ollama', 'llamacpp', 'vllm', 'sglang'];
    this.baseUrls = { ...(opts?.baseUrls ?? {}) };
    this.executor = opts?.executor;
    this.probeFetch = opts?.probeFetch;
    this.nowFn = opts?.now ?? Date.now;
    this.registry = new InferenceBrokerV2ProbedRegistry({ now: this.nowFn });
    this.prefixCache = new InferenceBrokerV2PrefixCache({
      maxNodes: opts?.prefixCacheMaxNodes,
      now: this.nowFn,
    });
    this.gate = new InferenceBrokerV2ValidationGate({
      defs: opts?.toolDefinitions ?? [],
      maxRetries: opts?.maxValidationRetries,
      now: this.nowFn,
    });
  }

  /** Base URL hieu dung cua 1 engine (ghi de > mac dinh matrix). */
  baseUrlFor(engine: InferenceBrokerV2EngineKind): string {
    return this.baseUrls[engine] ?? '';
  }

  /** Dat base URL rieng cho 1 engine. */
  setBaseUrl(engine: InferenceBrokerV2EngineKind, baseUrl: string): void {
    this.baseUrls[engine] = baseUrl.replace(/\/$/, '');
  }

  // --- Routing -----------------------------------------------------------

  /** Xep hang engine cho 1 task (dung capability THAT neu da probe). */
  rankEnginesForTask(
    req: InferenceBrokerV2TaskRequirements,
  ): { ranked: InferenceBrokerV2EngineScore[]; primary: InferenceBrokerV2EngineScore | undefined; fallbackChain: InferenceBrokerV2EngineKind[]; reason: string } {
    return routeTaskToEngineV2(req, this.engines, this.registry.probedMapForRouter());
  }

  /** Route theo loai task + ghi de (tien dung nhat cho caller). */
  routeForTaskKind(
    kind: InferenceBrokerV2TaskKind,
    overrides?: Partial<InferenceBrokerV2TaskRequirements>,
  ): ReturnType<typeof routeTaskToEngineV2> {
    return this.rankEnginesForTask(requirementsForTask(kind, overrides));
  }

  /** Chon engine + model tot nhat cho task trong danh sach model local. */
  pickModelForTask(
    req: InferenceBrokerV2TaskRequirements,
    models: readonly { modelId: string; engine: InferenceBrokerV2EngineKind }[],
  ): ReturnType<typeof pickModelForTaskV2> {
    return pickModelForTaskV2(req, models, this.registry.probedMapForRouter());
  }

  /** Fallback cho 1 engine theo ket qua probe. */
  fallbackFor(
    engine: InferenceBrokerV2EngineKind,
  ): { fallback: InferenceBrokerV2EngineKind | undefined; reason: string } {
    return resolveBrokerV2Fallback(engine, this.registry);
  }

  // --- Probe -------------------------------------------------------------

  /** Probe tat ca engine ung vien (tuan tu), ghi vao registry. */
  async probeAll(opts?: {
    fetchFn?: InferenceBrokerV2ProbeFetch;
    timeoutMs?: number;
    forceToolCall?: boolean;
  }): Promise<InferenceBrokerV2ProbedCapability[]> {
    const fetchFn = opts?.fetchFn ?? this.probeFetch;
    if (!fetchFn) return [];
    const results = await probeBrokerV2Engines(this.engines, {
      baseUrls: this.baseUrls,
      fetchFn,
      timeoutMs: opts?.timeoutMs,
      forceToolCall: opts?.forceToolCall,
      now: this.nowFn,
    });
    this.registry.recordAll(results);
    return results;
  }

  /** Probe 1 engine (ghi vao registry). */
  async probeOne(
    engine: InferenceBrokerV2EngineKind,
    opts?: { fetchFn?: InferenceBrokerV2ProbeFetch; timeoutMs?: number; forceToolCall?: boolean },
  ): Promise<InferenceBrokerV2ProbedCapability | undefined> {
    const results = await this.probeAll({
      fetchFn: opts?.fetchFn,
      timeoutMs: opts?.timeoutMs,
      forceToolCall: opts?.forceToolCall,
    });
    void results;
    // probeAll da probe het — tra lai muc cua engine nay (don gian,
    // tranh them 1 API rieng; may 1.5 CPU khong probe rieng le thuong xuyen).
    return this.registry.probedFor(engine);
  }

  // --- Chat co validate + prefix cache -----------------------------------

  /**
   * Chat qua broker: chon engine theo task, do prefix truoc khi gui,
   * validate moi tool call trong response truoc khi tra ve. Tool call
   * sai schema bi chan, model duoc retry co gioi han (gui thong diep
   * sua loi); het retry thi tra blocked (khong thuc thi call sai).
   * Neu executor loi thi thu fallback chain (moi engine 1 lan).
   */
  async chat(
    req: ChatCompletionRequest,
    opts?: {
      task?: InferenceBrokerV2TaskRequirements;
      taskKind?: InferenceBrokerV2TaskKind;
      engine?: InferenceBrokerV2EngineKind;
      model?: string;
      sessionId?: string;
      toolDefinitions?: readonly string[];
    },
  ): Promise<InferenceBrokerV2ChatResult> {
    const startedAt = this.nowFn();
    this.chats += 1;
    const taskReq = opts?.task ?? (opts?.taskKind ? requirementsForTask(opts.taskKind) : undefined);
    const cacheMessages: InferenceBrokerV2CacheMessage[] = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
      name: m.name,
    }));
    const prefixLookup = this.prefixCache.beginTurn(cacheMessages, {
      toolDefinitions: opts?.toolDefinitions,
      sessionId: opts?.sessionId,
    });
    const attempted: InferenceBrokerV2EngineKind[] = [];
    let blockedReasons: string[] = [];
    let blockedCount = 0;
    let retries = 0;

    // Thu tu engine: chi dinh > route theo task > thu tu mac dinh.
    let chain: InferenceBrokerV2EngineKind[];
    if (opts?.engine) {
      chain = [opts.engine, ...this.engines.filter((e) => e !== opts.engine)];
    } else if (taskReq) {
      const routed = this.rankEnginesForTask(taskReq);
      chain = [
        ...(routed.primary ? [routed.primary.engine] : []),
        ...routed.fallbackChain,
        ...this.engines.filter(
          (e) => e !== routed.primary?.engine && !routed.fallbackChain.includes(e),
        ),
      ];
    } else {
      chain = [...this.engines];
    }

    for (const engine of chain) {
      attempted.push(engine);
      if (!this.executor) {
        return {
          ok: false,
          validationRetries: retries,
          blockedToolCalls: blockedCount,
          blockedReasons: [BROKER_V2_NO_EXECUTOR_ERROR],
          attemptedEngines: attempted,
          error: BROKER_V2_NO_EXECUTOR_ERROR,
          totalLatencyMs: Math.max(0, this.nowFn() - startedAt),
          prefixLookup,
        };
      }
      let response: ProviderResponse;
      try {
        response = await this.executor(engine, this.baseUrlFor(engine), {
          ...req,
          model: opts?.model ?? req.model,
        });
      } catch (err) {
        // Executor loi -> thu engine tiep theo trong chain.
        if (engine !== chain[chain.length - 1]) {
          this.fallbacksUsed += 1;
          continue;
        }
        return {
          ok: false,
          validationRetries: retries,
          blockedToolCalls: blockedCount,
          blockedReasons,
          attemptedEngines: attempted,
          error: (err as Error).message,
          totalLatencyMs: Math.max(0, this.nowFn() - startedAt),
          prefixLookup,
        };
      }

      // Validate moi tool call truoc khi tra ve (khong tin parser).
      if (response.toolCalls.length === 0) {
        this.chatsOk += 1;
        return {
          ok: true,
          response,
          servedByEngine: engine,
          servedByModel: opts?.model ?? req.model,
          prefixLookup,
          validationRetries: retries,
          blockedToolCalls: blockedCount,
          blockedReasons,
          attemptedEngines: attempted,
          totalLatencyMs: Math.max(0, this.nowFn() - startedAt),
        };
      }

      // Co tool call: validate tung call; neu co call bi chan thi retry
      // (gui lai thong diep sua loi, toi da maxValidationRetries).
      let current: ProviderResponse = response;
      let attempt = 0;
      for (;;) {
        const validated = this.gate.validateAll(
          current.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
          engine,
        );
        this.toolCallsValidated += current.toolCalls.length;
        if (validated.ok) {
          this.chatsOk += 1;
          const clean: ProviderResponse = {
            ...current,
            toolCalls: validated.valid.map((v, i) => ({
              id: v.id ?? current.toolCalls[i]?.id ?? `call-${i}`,
              name: v.name,
              args: v.args,
            })),
          };
          return {
            ok: true,
            response: clean,
            servedByEngine: engine,
            servedByModel: opts?.model ?? req.model,
            prefixLookup,
            validationRetries: retries,
            blockedToolCalls: blockedCount,
            blockedReasons,
            attemptedEngines: attempted,
            totalLatencyMs: Math.max(0, this.nowFn() - startedAt),
          };
        }
        // Co call bi chan.
        const bad = validated.results.filter((r) => !r.ok);
        blockedCount += bad.length;
        this.toolCallsBlocked += bad.length;
        blockedReasons = bad.flatMap((r) => r.blockedReasons);
        if (!this.gate.canRetry(attempt)) {
          return {
            ok: false,
            validationRetries: retries,
            blockedToolCalls: blockedCount,
            blockedReasons,
            attemptedEngines: attempted,
            error: `Tool call bi chan sau ${attempt + 1} lan thu: ${blockedReasons.join(' ')}`,
            totalLatencyMs: Math.max(0, this.nowFn() - startedAt),
            prefixLookup,
          };
        }
        // Retry: gui lai thong diep sua loi cho model (qua executor).
        this.gate.noteRetry();
        retries += 1;
        this.validationRetries += 1;
        attempt += 1;
        const repairText = bad.map((r) => brokerV2RepairMessage(r)).join('\n');
        try {
          current = await this.executor(engine, this.baseUrlFor(engine), {
            ...req,
            model: opts?.model ?? req.model,
            messages: [
              ...req.messages,
              { role: 'assistant', content: current.text, toolCalls: current.toolCalls } as ChatMessage,
              { role: 'user', content: repairText } as ChatMessage,
            ],
          });
        } catch (err) {
          return {
            ok: false,
            validationRetries: retries,
            blockedToolCalls: blockedCount,
            blockedReasons,
            attemptedEngines: attempted,
            error: (err as Error).message,
            totalLatencyMs: Math.max(0, this.nowFn() - startedAt),
            prefixLookup,
          };
        }
        // Lap lai vong validate voi response moi (co gioi han boi canRetry).
      }
    }
    return {
      ok: false,
      validationRetries: retries,
      blockedToolCalls: blockedCount,
      blockedReasons,
      attemptedEngines: attempted,
      error: 'Khong engine nao tra response.',
      totalLatencyMs: Math.max(0, this.nowFn() - startedAt),
      prefixLookup,
    };
  }

  // --- Noi vao routerV3 ---------------------------------------------------

  /**
   * Dang ky model local da probe tot vao UnifiedRouterV3: capability
   * cua model duoc dieu chinh theo probe that (toolCalling = probe,
   * khong phai khai bao). Model cua engine probe that bai tool-call
   * thi khong dang ky (router khong duoc chon no cho task can tool).
   */
  registerProbedModelsIntoRouter(
    router: UnifiedRouterV3,
    models: readonly {
      modelId: string;
      engine: InferenceBrokerV2EngineKind;
      baseUrl: string;
      running?: boolean;
      sizeBytes?: number;
    }[],
    opts?: { now?: number },
  ): { registered: number; skipped: number; skippedModels: string[] } {
    const now = opts?.now ?? this.nowFn();
    let registered = 0;
    let skipped = 0;
    const skippedModels: string[] = [];
    const localModels: RouterV3LocalModel[] = [];
    for (const m of models) {
      const entry = this.registry.entryFor(m.engine, now);
      const declaredCap = capabilitiesForModel(m.modelId);
      // Engine da probe that bai tool-call -> khong dang ky cho task
      // can tool (van co the dung cho chat thuong, nhung router se
      // tu loai khi task doi tool-calling nho capability duoi day).
      const toolCalling = entry.probed
        ? entry.effectiveToolCallWorks && declaredCap.toolCalling
        : declaredCap.toolCalling;
      if (entry.probed && !entry.effectiveToolCallWorks && declaredCap.toolCalling) {
        skipped += 1;
        skippedModels.push(`${m.modelId} (${m.engine}: probe tool-call that bai)`);
        continue;
      }
      localModels.push({
        modelId: m.modelId,
        serverKind: m.engine as RouterV3LocalModel['serverKind'],
        baseUrl: m.baseUrl,
        providerId: `local:${m.engine}`,
        capability: { ...declaredCap, toolCalling, source: entry.probed ? 'known' : declaredCap.source },
        running: m.running ?? false,
        sizeBytes: m.sizeBytes,
        discoveredAt: now,
      });
      registered += 1;
    }
    if (localModels.length > 0) router.registerLocalModels(localModels);
    return { registered, skipped, skippedModels };
  }

  /** Thong ke broker. */
  stats(): InferenceBrokerV2Stats {
    return {
      chats: this.chats,
      chatsOk: this.chatsOk,
      toolCallsValidated: this.toolCallsValidated,
      toolCallsBlocked: this.toolCallsBlocked,
      validationRetries: this.validationRetries,
      fallbacksUsed: this.fallbacksUsed,
      prefixHitRate: this.prefixCache.stats().hitRate,
    };
  }

  /** Tom tat dang markdown (de UI / log). */
  markdown(): string {
    const s = this.stats();
    const lines = [
      '# Inference broker v2',
      '',
      `- Chat: ${s.chatsOk}/${s.chats} ok; tool call validate: ${s.toolCallsValidated}, chan: ${s.toolCallsBlocked}; retry do validate: ${s.validationRetries}; fallback: ${s.fallbacksUsed}.`,
      `- Prefix-cache hit rate: ${(s.prefixHitRate * 100).toFixed(1)}%.`,
      '',
      this.registry.markdown(),
      '',
      this.prefixCache.markdown(),
      '',
      this.gate.markdown(),
    ];
    return lines.join('\n');
  }
}

/** Tao broker mac dinh (khong executor — host inject sau). */
export function createInferenceBrokerV2(opts?: InferenceBrokerV2Options): InferenceBrokerV2 {
  return new InferenceBrokerV2(opts);
}

/** Tool call mau cua broker (de test / UI): dang OpenAI ToolCall. */
export function brokerV2ToolCallFromRaw(
  name: string,
  args: Record<string, unknown>,
  id = 'call-broker-v2-1',
): ToolCall {
  return { id, name, args };
}
