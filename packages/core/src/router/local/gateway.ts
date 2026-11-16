/**
 * LocalGateway (v1.15, Doi T3) — gateway noi bo kieu LiteLLM.
 *
 * Dat truoc endpoint local (Ollama / llama.cpp chi listen 127.0.0.1):
 * - Auth bang virtual key (moi bot mot key, budget rieng).
 * - Route request qua PolicyRouter (local truoc, cloud khi can).
 * - Budget gate truoc moi call + ghi spend sau moi call.
 * - Rate limit theo key.
 * - Fallback theo thu tu khi backend loi.
 * - Chi phuc vu loopback: neu baseUrl khong phai 127.0.0.1 thi tu choi
 *   khoi dong (khong de lo model local ra mang LAN).
 *
 * Gateway khong goi model cloud that — cloud duoc mo phong qua
 * `cloudChat` injectable (host truyen provider that; test truyen mock).
 * Local thi goi that qua HTTP toi endpoint cua registry (mock server
 * trong test, Ollama/llama-server that khi chay that).
 */

import { DEFAULT_GATEWAY_CONFIG, isLoopbackUrl, type LocalGatewayConfig, type RouterTask } from './types';
import { LocalBudgetTracker } from './budget';
import { PolicyRouter } from './policy';
import type { LocalModelRegistry } from './registry';
import { defaultHttpClient, type HttpClient } from './registry';

/** Mot message chat OpenAI-compatible. */
export interface GatewayChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** Request chat toi gateway. */
export interface GatewayChatRequest {
  /** Virtual key (secret day du, dang `obk_...`). */
  apiKey: string;
  messages: GatewayChatMessage[];
  /** Model yeu cau (neu khong co thi policy router tu chon). */
  model?: string;
  botId: string;
  /** Loai task de policy phan loai (mac dinh simple-chat). */
  taskKind?: RouterTask['kind'];
  /** So token toi da cho completion (de tinh gia tam). */
  maxTokens?: number;
}

/** Response chat tu gateway. */
export interface GatewayChatResponse {
  ok: boolean;
  model?: string;
  /** 'local' | 'cloud' — backend that su da tra loi. */
  servedBy?: 'local' | 'cloud';
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  /** So lan fallback da thu truoc khi thanh cong. */
  fallbacksTried?: number;
  error?: string;
  /** Canh bao budget (khi gan vuot). */
  budgetWarning?: string;
}

/** Ham goi cloud that — host inject (provider that); test inject mock. */
export type CloudChatFn = (input: {
  model: string;
  messages: GatewayChatMessage[];
  maxTokens?: number;
}) => Promise<{ content: string; promptTokens: number; completionTokens: number }>;

export interface LocalGatewayOptions {
  config?: Partial<LocalGatewayConfig>;
  registry: LocalModelRegistry;
  budget: LocalBudgetTracker;
  policy?: PolicyRouter;
  http?: HttpClient;
  /** Cloud chat that (neu khong co thi cloud route se bao loi ro rang). */
  cloudChat?: CloudChatFn;
}

/** Gateway chua khoi dong / da khoi dong. */
export class LocalGateway {
  private readonly config: LocalGatewayConfig;
  private readonly registry: LocalModelRegistry;
  private readonly budget: LocalBudgetTracker;
  private readonly policy: PolicyRouter;
  private readonly http: HttpClient;
  private readonly cloudChat?: CloudChatFn;
  private started = false;

  constructor(options: LocalGatewayOptions) {
    this.config = { ...DEFAULT_GATEWAY_CONFIG, ...options.config };
    this.registry = options.registry;
    this.budget = options.budget;
    this.policy = options.policy ?? new PolicyRouter();
    this.http = options.http ?? defaultHttpClient;
    this.cloudChat = options.cloudChat;
  }

  getConfig(): LocalGatewayConfig {
    return { ...this.config };
  }

  isStarted(): boolean {
    return this.started;
  }

  /**
   * Khoi dong gateway. Tu choi neu endpoint registry khong loopback.
   * (Gateway chi phuc vu tren loopback — khong mo ra LAN.)
   */
  start(): { ok: boolean; error?: string } {
    const ollamaBase = this.registry.getOllamaBaseUrl();
    if (!isLoopbackUrl(ollamaBase)) {
      return { ok: false, error: `Tu choi khoi dong: Ollama baseUrl "${ollamaBase}" khong phai loopback (127.0.0.1).` };
    }
    this.started = true;
    return { ok: true };
  }

  stop(): void {
    this.started = false;
  }

  /** Tao virtual key cho bot (uy quyen qua LocalBudgetTracker). */
  createKey(botId: string, opts?: { limitUsd?: number; period?: 'daily' | 'monthly'; expiresAt?: number }): { keyId: string; keyHint: string; secret: string } {
    const { key, secret } = this.budget.createVirtualKey(botId, {
      budget: opts?.limitUsd !== undefined
        ? { period: opts.period ?? 'monthly', limitUsd: opts.limitUsd, warnAt: 0.8, blockOnExceed: true }
        : undefined,
      expiresAt: opts?.expiresAt,
    });
    return { keyId: key.id, keyHint: key.keyHint, secret };
  }

  /** Xu ly mot chat request: auth -> gate -> route -> goi -> ghi spend. */
  async chat(req: GatewayChatRequest): Promise<GatewayChatResponse> {
    if (!this.started) {
      return { ok: false, error: 'Gateway chua khoi dong — goi start() truoc.' };
    }
    if (!req.messages || req.messages.length === 0) {
      return { ok: false, error: 'messages rong — can it nhat 1 message.' };
    }
    // 1) Auth virtual key (neu bat buoc).
    let keyId: string | undefined;
    if (this.config.requireKey) {
      const key = this.budget.resolveKey(req.apiKey);
      if (!key) {
        return { ok: false, error: 'Virtual key khong hop le, het han hoac bi thu hoi.' };
      }
      if (key.botId !== req.botId) {
        return { ok: false, error: `Virtual key thuoc bot "${key.botId}", khong phai "${req.botId}".` };
      }
      keyId = key.id;
      // 1b) Budget cua chinh key nay (doc lap voi budget bot).
      const ks = this.budget.keyStatus(key);
      if (ks.state === 'exceeded' && key.budget.blockOnExceed) {
        return { ok: false, error: `Virtual key da vuot budget ${ks.period}: da dung $${ks.spentUsd.toFixed(4)} / $${ks.limitUsd.toFixed(2)}.` };
      }
      // 2) Rate limit theo key.
      if (!this.budget.checkRateLimit(keyId, this.config.rateLimitPerMinute)) {
        return { ok: false, error: `Rate limit: qua ${this.config.rateLimitPerMinute} request/phut cho key nay.` };
      }
    }
    // 3) Budget gate.
    const gate = this.budget.gate(req.botId);
    if (!gate.allowed) {
      return { ok: false, error: gate.reason };
    }
    const budgetWarning = gate.status.state === 'warning' ? gate.reason : undefined;

    // 4) Route.
    const promptText = req.messages.map((m) => m.content).join('\n');
    const promptTokens = estimateTokensRough(promptText);
    const loaded = new Set(
      this.registry.listInstances().filter((i) => i.state === 'loaded').map((i) => i.entry.id),
    );
    const ram = this.registry.ramSnapshot();
    const decision = this.policy.decide(
      {
        kind: req.taskKind ?? 'simple-chat',
        promptTokens,
        needsToolUse: false,
        needsLongContext: promptTokens > 32000,
        qualityNeed: 0.5,
        manualModelId: req.model,
        botId: req.botId,
      },
      { loadedModelIds: loaded, availableRamBytes: ram.budgetBytes - ram.usedByModelsBytes },
    );
    const attempts: Array<{ kind: 'local' | 'cloud'; modelId: string }> = [
      { kind: decision.chosen.kind, modelId: decision.chosen.modelId },
      ...decision.fallbacks.map((f) => ({ kind: f.kind, modelId: f.modelId })),
    ];
    // 5) Thu theo thu tu, ghi spend cho lan thanh cong (va ca lan that neu co token).
    let fallbacksTried = 0;
    let lastError = '';
    for (const attempt of attempts) {
      try {
        const result = attempt.kind === 'local'
          ? await this.callLocal(attempt.modelId, req)
          : await this.callCloud(attempt.modelId, req);
        const record = this.budget.recordSpend({
          botId: req.botId,
          modelId: attempt.modelId,
          kind: attempt.kind,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          virtualKeyId: keyId,
        });
        return {
          ok: true,
          model: attempt.modelId,
          servedBy: attempt.kind,
          content: result.content,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          costUsd: record.costUsd,
          fallbacksTried,
          budgetWarning,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        fallbacksTried += 1;
      }
    }
    return {
      ok: false,
      error: `Tat ca ${attempts.length} backend deu that. Loi cuoi: ${lastError}`,
      fallbacksTried,
      budgetWarning,
    };
  }

  /** Goi model local qua endpoint OpenAI-compatible (load on-demand neu chua loaded). */
  private async callLocal(
    modelId: string,
    req: GatewayChatRequest,
  ): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    let url = this.registry.chatCompletionsUrl(modelId);
    if (!url) {
      const loaded = await this.registry.load(modelId);
      if (!loaded.ok) {
        throw new Error(`Khong load duoc model local "${modelId}": ${loaded.error ?? 'unknown error'}`);
      }
      url = this.registry.chatCompletionsUrl(modelId);
    }
    if (!url) throw new Error(`Model local "${modelId}" khong co endpoint sau khi load.`);
    const inst = this.registry.getInstance(modelId);
    const tag = inst?.entry.ollamaTag ?? modelId;
    const began = this.registry.beginTask(modelId);
    try {
      const res = await this.http(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: tag,
          messages: req.messages,
          max_tokens: req.maxTokens,
          stream: false,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Local backend tra HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const promptTokens = data.usage?.prompt_tokens ?? estimateTokensRough(req.messages.map((m) => m.content).join('\n'));
      const completionTokens = data.usage?.completion_tokens ?? estimateTokensRough(content);
      return { content, promptTokens, completionTokens };
    } finally {
      if (began) this.registry.endTask(modelId);
    }
  }

  /** Goi cloud qua ham inject (host cung cap provider that). */
  private async callCloud(
    modelId: string,
    req: GatewayChatRequest,
  ): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    if (!this.cloudChat) {
      throw new Error(`Khong co cloudChat de goi model cloud "${modelId}" — host chua cau hinh provider cloud.`);
    }
    return this.cloudChat({ model: modelId, messages: req.messages, maxTokens: req.maxTokens });
  }
}

/** Uoc tinh token tho: ~4 ky tu / token (dung cho prompt truoc khi goi). */
export function estimateTokensRough(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
