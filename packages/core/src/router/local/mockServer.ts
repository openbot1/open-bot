/**
 * Mock Ollama / llama.cpp server cho test (v1.15, Doi T3).
 *
 * Mot HTTP server in-process (node:http) mo phong dung API can de
 * registry + gateway test ma khong can GPU/model that:
 * - Ollama: GET /api/tags, GET /api/show, POST /api/pull (gia lap
 *   them model vao danh sach), POST /api/chat.
 * - OpenAI-compatible (ca hai): GET /v1/models, POST /v1/chat/completions
 *   (tra echo xac dinh), GET /health.
 * Response xac dinh (deterministic) — khong random, khong mang.
 */

import * as http from 'node:http';

export interface MockModelSpec {
  name: string;
  sizeBytes: number;
  /** Latency gia mo phong (ms) truoc khi tra chat completions. */
  latencyMs?: number;
  /** true = endpoint nay tra loi 500 cho chat (de test fallback). */
  failChat?: boolean;
}

export interface MockServerOptions {
  /** Port 0 = chon port trong tu dong. */
  port?: number;
  host?: string;
  models?: MockModelSpec[];
  /** Ten hien thi cua server trong log. */
  label?: string;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** Dem token tho: so tu (dung cho mock usage). */
export function mockCountTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.max(1, words.length);
}

/**
 * MockOllamaServer — mo phong Ollama daemon.
 * Dung cho Registry.load(backend='ollama') + health check trong test.
 */
export class MockOllamaServer {
  private readonly server: http.Server;
  private readonly models: MockModelSpec[];
  private readonly label: string;
  private readonly host: string;
  private readonly port: number;
  private actualPort: number | undefined;
  /** So request da nhan (theo path) — de test assert. */
  readonly requests: Array<{ method: string; path: string }> = [];

  constructor(options: MockServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.label = options.label ?? 'mock-ollama';
    this.models = [...(options.models ?? [{ name: 'qwen3:4b', sizeBytes: 2_500_000_000 }])];
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  get baseUrl(): string {
    if (!this.actualPort) throw new Error(`${this.label} chua start — goi start() truoc.`);
    return `http://${this.host}:${this.actualPort}`;
  }

  /** Base URL dang /v1 (OpenAI-compatible) cua mock. */
  get openAiBaseUrl(): string {
    return `${this.baseUrl}/v1`;
  }

  listModelNames(): string[] {
    return this.models.map((m) => m.name);
  }

  addModel(spec: MockModelSpec): void {
    if (!this.models.some((m) => m.name === spec.name)) this.models.push(spec);
  }

  removeModel(name: string): void {
    const idx = this.models.findIndex((m) => m.name === name);
    if (idx >= 0) this.models.splice(idx, 1);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        this.actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.host}`);
    const path = url.pathname;
    this.requests.push({ method: req.method ?? 'GET', path });
    try {
      if (req.method === 'GET' && path === '/api/tags') {
        sendJson(res, 200, {
          models: this.models.map((m) => ({
            name: m.name,
            model: m.name,
            size: m.sizeBytes,
            modified_at: new Date().toISOString(),
            details: { format: 'gguf', family: m.name.split(':')[0], parameter_size: '4B', quantization_level: 'Q4_K_M' },
          })),
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/show') {
        const name = url.searchParams.get('name') ?? '';
        const found = this.models.find((m) => m.name === name);
        if (!found) {
          sendJson(res, 404, { error: `model "${name}" not found` });
          return;
        }
        sendJson(res, 200, { model: found.name, details: { family: found.name.split(':')[0] } });
        return;
      }
      if (req.method === 'POST' && path === '/api/pull') {
        const body = JSON.parse((await readBody(req)) || '{}') as { name?: string };
        const name = body.name ?? '';
        if (!name) {
          sendJson(res, 400, { error: 'missing name' });
          return;
        }
        this.addModel({ name, sizeBytes: 1_000_000_000 });
        sendJson(res, 200, { status: 'success' });
        return;
      }
      if (req.method === 'GET' && path === '/v1/models') {
        sendJson(res, 200, {
          object: 'list',
          data: this.models.map((m) => ({ id: m.name, object: 'model', created: 0, owned_by: 'mock' })),
        });
        return;
      }
      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/api/chat')) {
        const body = JSON.parse((await readBody(req)) || '{}') as {
          model?: string;
          messages?: Array<{ role?: string; content?: string }>;
        };
        const modelName = body.model ?? '';
        const spec = this.models.find((m) => m.name === modelName);
        if (spec?.failChat) {
          sendJson(res, 500, { error: { message: 'mock chat failure', type: 'mock_error' } });
          return;
        }
        const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
        const prompt = lastUser?.content ?? '';
        const reply = `[mock:${modelName}] ${prompt}`;
        const promptTokens = mockCountTokens(prompt);
        const completionTokens = mockCountTokens(reply);
        if (spec?.latencyMs) await sleep(spec.latencyMs);
        if (path === '/api/chat') {
          sendJson(res, 200, {
            model: modelName,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: reply },
            done: true,
            prompt_eval_count: promptTokens,
            eval_count: completionTokens,
          });
          return;
        }
        sendJson(res, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        });
        return;
      }
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      sendJson(res, 404, { error: `mock ${this.label}: unknown path ${path}` });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * MockLlamaCppServer — mo phong llama-server (mot process mot model).
 * Chi OpenAI-compatible + /health (khong co /api/tags cua Ollama).
 */
export class MockLlamaCppServer {
  private readonly inner: MockOllamaServer;
  readonly requests: Array<{ method: string; path: string }>;

  constructor(options: MockServerOptions & { modelName?: string }) {
    const modelName = options.modelName ?? 'qwen3-4b';
    this.inner = new MockOllamaServer({
      ...options,
      label: options.label ?? 'mock-llamacpp',
      models: options.models ?? [{ name: modelName, sizeBytes: 2_500_000_000 }],
    });
    this.requests = this.inner.requests;
  }

  get baseUrl(): string {
    return this.inner.baseUrl;
  }

  get openAiBaseUrl(): string {
    return this.inner.openAiBaseUrl;
  }

  listModelNames(): string[] {
    return this.inner.listModelNames();
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
