/**
 * Inference broker v2 — probe tool-call parser that luc khoi dong
 * (v1.33, Doi T5).
 *
 * Nguyen tac (tu survey v133 muc 4): KHONG tin doc / quang cao cua
 * engine — gui 1 call mau toi tung engine dang chay, do parser that
 * (parse duoc khong? arguments khop schema khong? co parallel khong?
 * tool_choice / strict co tac dung khong?), ghi capability THAT vao
 * registry. Khai bao o capabilityMatrix.ts chi la diem xuat phat.
 *
 * Call mau: 1 tool don gian `broker_probe_echo` (1 arg string bat
 * buoc + 1 arg enum tuy chon), yeu cau model goi dung tool do voi gia
 * tri cu the. Probe KHONG thuc thi tool — chi doc phan hoi cua engine
 * (tool_calls) roi ket luan. Neu engine tra text thay vi tool call,
 * hoac arguments sai JSON / sai schema, probe ghi that bai ro rang.
 *
 * Chi goi HTTP loopback (baseUrl do host truyen; mac dinh tu matrix).
 * Fetch inject duoc (test dung fake server); khong co fetch thi chi
 * tra ket qua "khong probe duoc" chu khong throw. Khong doc credential,
 * khong gui credential di dau. Timeout mac dinh 10s / engine.
 */

import {
  inferenceBrokerV2CapabilityFor,
  inferenceBrokerV2DefaultBaseUrl,
  inferenceBrokerV2EngineLabel,
  type InferenceBrokerV2EngineKind,
  type InferenceBrokerV2EngineCapability,
} from './capabilityMatrix';

/** Ham fetch toi thieu ma probe can (giong LocalDetectFetch cua routerV3). */
export type InferenceBrokerV2ProbeFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown },
) => Promise<{
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

/** Tool mau dung de probe parser (khong bao gio duoc thuc thi). */
export const BROKER_V2_PROBE_TOOL_NAME = 'broker_probe_echo';
export const BROKER_V2_PROBE_ARG_VALUE = 'ping-v2';
export const BROKER_V2_PROBE_ARG_MODE = 'exact';

/** Dinh nghia tool mau (OpenAI function format). */
export function brokerV2ProbeToolDefinition(): {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  return {
    type: 'function',
    function: {
      name: BROKER_V2_PROBE_TOOL_NAME,
      description: 'Echo back the given value (probe-only tool, never executed).',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'Value to echo back.' },
          mode: { type: 'string', enum: ['exact', 'upper'], description: 'Echo mode.' },
        },
        required: ['value'],
        additionalProperties: false,
      },
    },
  };
}

/** Body chat completions gui di khi probe (OpenAI-compatible). */
export function brokerV2ProbeRequestBody(opts?: {
  model?: string;
  forceToolCall?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts?.model ?? 'probe-model',
    messages: [
      {
        role: 'user',
        content: `Call ${BROKER_V2_PROBE_TOOL_NAME} with value "${BROKER_V2_PROBE_ARG_VALUE}" and mode "${BROKER_V2_PROBE_ARG_MODE}". Do not answer in text.`,
      },
    ],
    tools: [brokerV2ProbeToolDefinition()],
    temperature: 0,
    max_tokens: 256,
  };
  // Chi gui tool_choice khi caller yeu cau ep (de do xem engine co ton
  // trong no khong); Ollama khong ho tro — server se 400, probe ghi lai.
  if (opts?.forceToolCall) {
    body.tool_choice = { type: 'function', function: { name: BROKER_V2_PROBE_TOOL_NAME } };
  }
  return body;
}

/** Ket qua probe 1 engine (capability THAT). */
export interface InferenceBrokerV2ProbedCapability {
  /** Engine vua probe. */
  engine: InferenceBrokerV2EngineKind;
  /** Base URL da probe. */
  baseUrl: string;
  /** Model da dung de probe (neu co). */
  modelId?: string;
  /** Server co phan hoi HTTP khong. */
  reachable: boolean;
  /** Parser that co tra tool call khong. */
  toolCallParsed: boolean;
  /** Arguments tra ve co parse duoc JSON khong. */
  argumentsParseable: boolean;
  /** Arguments co khop gia tri mong doi (name + value + mode) khong. */
  argumentsMatchExpected: boolean;
  /** So tool call tra ve trong 1 turn (do parallel). */
  toolCallsObserved: number;
  /** Co hon 1 tool call trong 1 turn khong. */
  parallelObserved: boolean;
  /** tool_choice co duoc ton trong khong (chi do khi forceToolCall). */
  toolChoiceHonored?: boolean;
  /** Strict mode co tac dung khong (chi do khi engine khai co strict). */
  strictHonored?: boolean;
  /** Latency probe (ms). */
  latencyMs: number;
  /** Thoi diem probe (ms epoch). */
  probedAt: number;
  /** Loi (neu co): timeout / HTTP / parse. */
  error?: string;
  /** Nguon: 'probed' = do that, 'declared' = chua probe (khai bao). */
  source: 'probed' | 'declared';
  /** Ghi chu ngan gon (tieng Viet). */
  note: string;
}

/** Timeout mac dinh cho 1 probe (ms). */
export const BROKER_V2_PROBE_TIMEOUT_MS = 10_000;
/** So model toi da lay tu /v1/models khi probe (de chon model mau). */
export const BROKER_V2_PROBE_MAX_MODELS = 50;

/** Dang toi thieu cua 1 tool call trong response OpenAI-compatible. */
export interface BrokerV2RawToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

/** Boc tach tool_calls tu response chat completions (phong thu). */
export function extractBrokerV2ToolCalls(response: unknown): BrokerV2RawToolCall[] {
  if (!response || typeof response !== 'object') return [];
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return [];
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.filter(
    (c): c is BrokerV2RawToolCall => !!c && typeof c === 'object',
  );
}

/** Parse arguments cua 1 tool call: chuoi JSON hoac object san. */
export function parseBrokerV2ToolCallArguments(
  call: BrokerV2RawToolCall,
): { ok: boolean; args?: Record<string, unknown>; error?: string } {
  const raw = call.function?.arguments;
  if (raw === undefined || raw === null) return { ok: false, error: 'missing arguments' };
  if (typeof raw === 'object') return { ok: true, args: raw as Record<string, unknown> };
  if (typeof raw !== 'string') return { ok: false, error: `arguments co kieu ${typeof raw}` };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'arguments rong' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'arguments khong phai object JSON' };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: `arguments khong parse duoc JSON: ${(err as Error).message}` };
  }
}

/** Kiem tra arguments co khop gia tri mong doi cua probe khong. */
export function brokerV2ProbeArgumentsMatch(args: Record<string, unknown>): boolean {
  return (
    args.value === BROKER_V2_PROBE_ARG_VALUE && args.mode === BROKER_V2_PROBE_ARG_MODE
  );
}

/**
 * Danh gia 1 response chat completions thanh ket qua probe (thuan,
 * khong I/O — test truc tiep duoc, khong can server that).
 */
export function evaluateBrokerV2ProbeResponse(
  engine: InferenceBrokerV2EngineKind,
  baseUrl: string,
  response: unknown,
  opts?: { modelId?: string; latencyMs?: number; probedAt?: number; forceToolCall?: boolean },
): InferenceBrokerV2ProbedCapability {
  const now = opts?.probedAt ?? Date.now();
  const latencyMs = opts?.latencyMs ?? 0;
  const calls = extractBrokerV2ToolCalls(response);
  const base: InferenceBrokerV2ProbedCapability = {
    engine,
    baseUrl,
    modelId: opts?.modelId,
    reachable: true,
    toolCallParsed: false,
    argumentsParseable: false,
    argumentsMatchExpected: false,
    toolCallsObserved: calls.length,
    parallelObserved: calls.length > 1,
    latencyMs,
    probedAt: now,
    source: 'probed',
    note: '',
  };
  if (calls.length === 0) {
    base.note = `${inferenceBrokerV2EngineLabel(engine)} khong tra tool call — tra text thay vi goi ${BROKER_V2_PROBE_TOOL_NAME} (parser chua bat hoac model khong ho tro).`;
    return base;
  }
  const first = calls[0];
  const name = first.function?.name;
  if (name !== BROKER_V2_PROBE_TOOL_NAME) {
    base.toolCallParsed = true;
    base.note = `${inferenceBrokerV2EngineLabel(engine)} tra tool call nhung sai ten: "${name ?? ''}" (mong doi ${BROKER_V2_PROBE_TOOL_NAME}) — parser chay nhung khong chinh xac.`;
    return base;
  }
  base.toolCallParsed = true;
  const parsed = parseBrokerV2ToolCallArguments(first);
  if (!parsed.ok) {
    base.note = `${inferenceBrokerV2EngineLabel(engine)} tra dung tool nhung arguments loi: ${parsed.error} — parser gay schema.`;
    return base;
  }
  base.argumentsParseable = true;
  base.argumentsMatchExpected = brokerV2ProbeArgumentsMatch(parsed.args ?? {});
  if (base.argumentsMatchExpected) {
    base.note =
      `${inferenceBrokerV2EngineLabel(engine)} parser that hoat dong: tra dung tool, arguments khop (${calls.length} call).` +
      (base.parallelObserved ? ' Co parallel.' : '');
  } else {
    base.note = `${inferenceBrokerV2EngineLabel(engine)} tra dung tool, arguments parse duoc nhung SAI gia tri (value/mode khong khop) — model khong tuan thu lenh probe.`;
  }
  if (opts?.forceToolCall) {
    // Neu da ep tool_choice ma van tra tool call dung -> ton trong.
    base.toolChoiceHonored = base.toolCallParsed;
  }
  return base;
}

/** Ket qua probe that bai (khong phan hoi / loi HTTP / timeout). */
export function brokerV2ProbeFailure(
  engine: InferenceBrokerV2EngineKind,
  baseUrl: string,
  error: string,
  opts?: { latencyMs?: number; probedAt?: number },
): InferenceBrokerV2ProbedCapability {
  return {
    engine,
    baseUrl,
    reachable: false,
    toolCallParsed: false,
    argumentsParseable: false,
    argumentsMatchExpected: false,
    toolCallsObserved: 0,
    parallelObserved: false,
    latencyMs: opts?.latencyMs ?? 0,
    probedAt: opts?.probedAt ?? Date.now(),
    error,
    source: 'probed',
    note: `${inferenceBrokerV2EngineLabel(engine)} khong probe duoc (${error}) — coi nhu chua co capability that.`,
  };
}

/** Lay danh sach model tu /v1/models (thuan theo fetch inject). */
export async function listBrokerV2Models(
  baseUrl: string,
  fetchFn: InferenceBrokerV2ProbeFetch,
  timeoutMs = BROKER_V2_PROBE_TIMEOUT_MS,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
  const res = await fetchWithBrokerV2Timeout(fetchFn, url, { method: 'GET' }, timeoutMs);
  if (!res.ok) return [];
  const body: unknown = res.json ? await res.json() : undefined;
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      ids.push((item as { id: string }).id);
      if (ids.length >= BROKER_V2_PROBE_MAX_MODELS) break;
    }
  }
  return ids;
}

/** Fetch co timeout (dung AbortController khi co, fallback race). */
export async function fetchWithBrokerV2Timeout(
  fetchFn: InferenceBrokerV2ProbeFetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> }> {
  if (timeoutMs <= 0) return fetchFn(url, init);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout sau ${timeoutMs}ms`)), timeoutMs);
    });
    return await Promise.race([fetchFn(url, init), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Probe 1 engine dang chay: lay model dau tien tu /v1/models (neu co),
 * gui 1 call mau, danh gia response. Khong throw — loi nao cung tra
 * ket qua probe that bai.
 */
export async function probeBrokerV2Engine(
  engine: InferenceBrokerV2EngineKind,
  opts?: {
    baseUrl?: string;
    fetchFn?: InferenceBrokerV2ProbeFetch;
    modelId?: string;
    timeoutMs?: number;
    forceToolCall?: boolean;
    now?: () => number;
  },
): Promise<InferenceBrokerV2ProbedCapability> {
  const baseUrl = (opts?.baseUrl ?? inferenceBrokerV2DefaultBaseUrl(engine)).replace(/\/$/, '');
  const now = opts?.now ?? Date.now;
  const timeoutMs = opts?.timeoutMs ?? BROKER_V2_PROBE_TIMEOUT_MS;
  const fetchFn = opts?.fetchFn;
  if (!fetchFn) {
    return brokerV2ProbeFailure(engine, baseUrl, 'khong co fetch de probe', { probedAt: now() });
  }
  const startedAt = now();
  try {
    let modelId = opts?.modelId;
    if (!modelId) {
      try {
        const models = await listBrokerV2Models(baseUrl, fetchFn, timeoutMs);
        modelId = models[0];
      } catch {
        modelId = undefined;
      }
    }
    const url = `${baseUrl}${inferenceBrokerV2CapabilityFor(engine).chatCompletionsPath}`;
    const res = await fetchWithBrokerV2Timeout(
      fetchFn,
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(brokerV2ProbeRequestBody({ model: modelId, forceToolCall: opts?.forceToolCall })),
      },
      timeoutMs,
    );
    const latencyMs = Math.max(0, now() - startedAt);
    if (!res.ok) {
      const text = res.text ? await res.text().catch(() => '') : '';
      const detail = text ? `: ${text.slice(0, 200)}` : '';
      return brokerV2ProbeFailure(engine, baseUrl, `HTTP ${res.status}${detail}`, {
        latencyMs,
        probedAt: now(),
      });
    }
    const body: unknown = res.json ? await res.json() : undefined;
    return evaluateBrokerV2ProbeResponse(engine, baseUrl, body, {
      modelId,
      latencyMs,
      probedAt: now(),
      forceToolCall: opts?.forceToolCall,
    });
  } catch (err) {
    return brokerV2ProbeFailure(engine, baseUrl, (err as Error).message, {
      latencyMs: Math.max(0, now() - startedAt),
      probedAt: now(),
    });
  }
}

/** Probe nhieu engine tuan tu (tranh qua tai may 1.5 CPU). */
export async function probeBrokerV2Engines(
  engines: readonly InferenceBrokerV2EngineKind[],
  opts?: {
    baseUrls?: Readonly<Partial<Record<InferenceBrokerV2EngineKind, string>>>;
    fetchFn?: InferenceBrokerV2ProbeFetch;
    timeoutMs?: number;
    forceToolCall?: boolean;
    now?: () => number;
  },
): Promise<InferenceBrokerV2ProbedCapability[]> {
  const out: InferenceBrokerV2ProbedCapability[] = [];
  for (const engine of engines) {
    out.push(
      await probeBrokerV2Engine(engine, {
        baseUrl: opts?.baseUrls?.[engine],
        fetchFn: opts?.fetchFn,
        timeoutMs: opts?.timeoutMs,
        forceToolCall: opts?.forceToolCall,
        now: opts?.now,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry: capability THAT (probed) ghi de capability khai bao
// ---------------------------------------------------------------------------

/** Mot muc registry: khai bao + that (neu da probe) + thoi diem. */
export interface InferenceBrokerV2RegistryEntry {
  engine: InferenceBrokerV2EngineKind;
  declared: InferenceBrokerV2EngineCapability;
  probed?: InferenceBrokerV2ProbedCapability;
  /** Capability hieu dung: tool calling that neu da probe, khai bao neu chua. */
  effectiveToolCallWorks: boolean;
  /** Strict that neu da probe, khai bao neu chua. */
  effectiveStrictWorks: boolean;
  /** true = da probe trong TTL (con tuoi). */
  fresh: boolean;
}

/** TTL mac dinh cua ket qua probe (ms) — het han thi probe lai. */
export const BROKER_V2_PROBE_TTL_MS = 10 * 60 * 1000;

/** Registry capability that cua cac engine local. */
export class InferenceBrokerV2ProbedRegistry {
  private readonly entries = new Map<InferenceBrokerV2EngineKind, InferenceBrokerV2ProbedCapability>();
  private readonly ttlMs: number;
  private readonly nowFn: () => number;

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? BROKER_V2_PROBE_TTL_MS;
    this.nowFn = opts?.now ?? Date.now;
  }

  /** Ghi ket qua probe (ghi de lan truoc). */
  record(probed: InferenceBrokerV2ProbedCapability): void {
    this.entries.set(probed.engine, { ...probed });
  }

  /** Ghi nhieu ket qua cung luc. */
  recordAll(probed: readonly InferenceBrokerV2ProbedCapability[]): void {
    for (const p of probed) this.record(p);
  }

  /** Ket qua probe gan nhat cua 1 engine (neu co). */
  probedFor(engine: InferenceBrokerV2EngineKind): InferenceBrokerV2ProbedCapability | undefined {
    const p = this.entries.get(engine);
    return p ? { ...p } : undefined;
  }

  /** true = da probe va con tuoi (trong TTL). */
  isFresh(engine: InferenceBrokerV2EngineKind, now: number = this.nowFn()): boolean {
    const p = this.entries.get(engine);
    return !!p && now - p.probedAt <= this.ttlMs;
  }

  /** Muc registry day du cho 1 engine. */
  entryFor(engine: InferenceBrokerV2EngineKind, now: number = this.nowFn()): InferenceBrokerV2RegistryEntry {
    const declared = inferenceBrokerV2CapabilityFor(engine);
    const probed = this.entries.get(engine);
    const fresh = this.isFresh(engine, now);
    const effectiveToolCallWorks = probed
      ? probed.toolCallParsed && probed.argumentsParseable
      : declared.toolCalling.supported;
    const effectiveStrictWorks = probed
      ? probed.strictHonored ?? declared.toolCalling.strictMode
      : declared.toolCalling.strictMode;
    return {
      engine,
      declared,
      probed: probed ? { ...probed } : undefined,
      effectiveToolCallWorks,
      effectiveStrictWorks,
      fresh,
    };
  }

  /** Tat ca muc registry. */
  entriesAll(now: number = this.nowFn()): InferenceBrokerV2RegistryEntry[] {
    return (['ollama', 'llamacpp', 'vllm', 'sglang'] as const).map((e) => this.entryFor(e, now));
  }

  /** Map engine -> { toolCallWorks, strictWorks } de dua vao router. */
  probedMapForRouter(): Partial<
    Record<InferenceBrokerV2EngineKind, { toolCallWorks: boolean; strictWorks: boolean }>
  > {
    const out: Partial<
      Record<InferenceBrokerV2EngineKind, { toolCallWorks: boolean; strictWorks: boolean }>
    > = {};
    for (const engine of ['ollama', 'llamacpp', 'vllm', 'sglang'] as const) {
      const e = this.entryFor(engine);
      if (e.probed) {
        out[engine] = {
          toolCallWorks: e.effectiveToolCallWorks,
          strictWorks: e.effectiveStrictWorks,
        };
      }
    }
    return out;
  }

  /** So engine da probe thanh cong (tool call parse duoc). */
  workingCount(): number {
    let n = 0;
    for (const p of this.entries.values()) {
      if (p.toolCallParsed && p.argumentsParseable) n += 1;
    }
    return n;
  }

  /** Xoa ket qua probe cua 1 engine (ep probe lai). */
  clear(engine: InferenceBrokerV2EngineKind): boolean {
    return this.entries.delete(engine);
  }

  /** Xoa het. */
  clearAll(): void {
    this.entries.clear();
  }

  /** Tom tat dang markdown. */
  markdown(now: number = this.nowFn()): string {
    const lines = ['# Inference broker v2 — probed capabilities (that, khong phai quang cao)', ''];
    for (const e of this.entriesAll(now)) {
      const p = e.probed;
      if (!p) {
        lines.push(`- ${inferenceBrokerV2EngineLabel(e.engine)}: chua probe (khai bao: tool-calling ${e.declared.toolCalling.supported ? 'co' : 'khong'}).`);
      } else if (!p.reachable) {
        lines.push(`- ${inferenceBrokerV2EngineLabel(e.engine)}: KHONG chay (${p.error ?? 'unreachable'}).`);
      } else {
        lines.push(
          `- ${inferenceBrokerV2EngineLabel(e.engine)}: tool-call ${p.toolCallParsed ? 'parse duoc' : 'KHONG parse duoc'}, arguments ${p.argumentsParseable ? 'hop le' : 'loi'}${p.argumentsMatchExpected ? ', khop gia tri mong doi' : ''}, ${p.toolCallsObserved} call/turn, ${p.latencyMs}ms${e.fresh ? '' : ' (het han, can probe lai)'}.`,
        );
      }
    }
    return lines.join('\n');
  }
}

/**
 * Giai quyet fallback theo ket qua probe: engine nao do that bai thi
 * doi sang engine nao. Quy tac Ollama -> llama.cpp server khi Ollama
 * thieu tool_choice / strict (xem capabilityMatrix.fallbackEngineForV2).
 */
export function resolveBrokerV2Fallback(
  engine: InferenceBrokerV2EngineKind,
  registry: InferenceBrokerV2ProbedRegistry,
): { fallback: InferenceBrokerV2EngineKind | undefined; reason: string } {
  const entry = registry.entryFor(engine);
  const probed = entry.probed;
  if (!probed) {
    return { fallback: undefined, reason: `${inferenceBrokerV2EngineLabel(engine)} chua probe — khong doi fallback.` };
  }
  if (!probed.reachable) {
    const fb = engine === 'llamacpp' ? 'ollama' : 'llamacpp';
    return {
      fallback: fb as InferenceBrokerV2EngineKind,
      reason: `${inferenceBrokerV2EngineLabel(engine)} khong chay — fallback sang ${inferenceBrokerV2EngineLabel(fb as InferenceBrokerV2EngineKind)}.`,
    };
  }
  if (!probed.toolCallParsed || !probed.argumentsParseable) {
    return {
      fallback: 'llamacpp',
      reason: `${inferenceBrokerV2EngineLabel(engine)} parser that gay (khong parse duoc / arguments loi) — fallback sang llama.cpp server (--jinja).`,
    };
  }
  if (engine === 'ollama') {
    // Ollama khong co tool_choice/strict theo khai bao — neu task can
    // thi fallback sang llama.cpp (co ca hai).
    return {
      fallback: 'llamacpp',
      reason: 'Ollama thieu tool_choice/strict mode — task can ep tool thi fallback sang llama.cpp server.',
    };
  }
  return { fallback: undefined, reason: `${inferenceBrokerV2EngineLabel(engine)} probe tot — khong can fallback.` };
}
