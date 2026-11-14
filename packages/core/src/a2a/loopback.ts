/**
 * Cặp A2A loopback (server + client thật trên 127.0.0.1), v1.07 Đội T3.
 *
 * Để chứng minh server + client A2A chạy được thật (không mock
 * fetch, không giả lập SSE), module này dựng một cặp peer trên
 * loopback: server HTTP thật bind cổng ephemeral (port 0 → OS cấp),
 * client thật gọi qua `fetch`. Dùng trong test end-to-end và trong
 * demo/dev khi muốn thử protocol mà không cần agent ngoài.
 *
 *  - `startLoopbackA2aPair(options)` — start server với runner echo
 *    mặc định (trả lại đúng text nhận được, kèm một artifact text),
 *    hoặc runner do caller truyền (vd runner cần input, runner lỗi).
 *    Trả `{ server, client, http, baseUrl, cardUrl, close }`.
 *  - Runner echo mặc định đẩy tiến độ qua `onProgress` (2 chunk)
 *    để test SSE thấy được streaming thật.
 *  - `close()` dừng HTTP server; gọi trong `finally`/`test.after`.
 *
 * Bảo mật: server bind 127.0.0.1, cổng ephemeral, token rỗng thì
 * dùng `allowUnauthenticated: true` (chỉ test/dev local — KHÔNG
 * dùng trong app thật, xem `server.ts`).
 */

import { A2aClient } from './client';
import { startA2aHttpServer, type A2aHttpServer, type A2aServerOptions } from './server';
import type { A2aAgentRunner, A2aRunResult } from './types';

/** Runner echo: trả lại text nhận được, đẩy 2 chunk tiến độ qua SSE. */
export function createEchoA2aRunner(prefix = 'echo:'): A2aAgentRunner {
  return async (input): Promise<A2aRunResult> => {
    input.onProgress(`${prefix} working`);
    input.onProgress(`${prefix} ${input.text}`);
    if (input.signal.aborted) return { error: 'Task đã bị hủy.' };
    return { text: `${prefix} ${input.text}` };
  };
}

/** Options khi dựng cặp loopback. */
export interface LoopbackA2aPairOptions {
  /** Tên agent trong Agent Card (mặc định 'open-bot-loopback'). */
  name?: string;
  /** Mô tả agent trong Agent Card. */
  description?: string;
  /** Skill khai trong Agent Card. */
  skills?: A2aServerOptions['skills'];
  /** Runner chạy task (mặc định echo). */
  runner?: A2aAgentRunner;
  /** Key ký Agent Card (có → card phục vụ có `signature` + JWS). */
  signer?: A2aServerOptions['signer'];
  /** Bearer <redacted> cho cả server lẫn client (mặc định không auth — chỉ loopback test). */
  token?: string;
  /** Timeout mặc định của client (ms). */
  clientTimeoutMs?: number;
}

/** Một cặp A2A loopback đang chạy. */
export interface LoopbackA2aPair {
  /** Server logic thật (cùng store task với HTTP layer). */
  server: A2aHttpServer['server'];
  /** Client thật (gọi qua HTTP loopback). */
  client: A2aClient;
  /** HTTP server đã bind (port, url, cardUrl). */
  http: A2aHttpServer;
  /** URL gốc của server (vd http://127.0.0.1:54321). */
  baseUrl: string;
  /** URL Agent Card (/.well-known/agent-card.json). */
  cardUrl: string;
  /** Dừng HTTP server. */
  close(): Promise<void>;
}

/**
 * Start một cặp A2A loopback (server + client thật). Server bind
 * 127.0.0.1 cổng ephemeral; client trỏ đúng URL đó. Caller nhớ
 * gọi `close()` khi xong (test dùng `t.after(() => pair.close())`).
 */
export async function startLoopbackA2aPair(options: LoopbackA2aPairOptions = {}): Promise<LoopbackA2aPair> {
  const runner = options.runner ?? createEchoA2aRunner();
  const serverOptions: A2aServerOptions = {
    name: options.name ?? 'open-bot-loopback',
    description: options.description ?? 'Local loopback A2A agent for tests and demos.',
    skills: options.skills ?? [{ id: 'echo', name: 'Echo', description: 'Echoes the task text back.' }],
    runner,
    ...(options.signer ? { signer: options.signer } : {}),
    ...(options.token ? { token: options.token } : { allowUnauthenticated: true }),
  };
  const http = await startA2aHttpServer(serverOptions, { port: 0, host: '127.0.0.1' });
  const client = new A2aClient({
    baseUrl: http.url,
    ...(options.token ? { token: options.token } : {}),
    ...(options.clientTimeoutMs !== undefined ? { timeoutMs: options.clientTimeoutMs } : {}),
  });
  return {
    // v1.07: http.server là server logic thật (cùng store task với
    // HTTP layer) — không tạo server thứ hai.
    server: http.server,
    client,
    http,
    baseUrl: http.url,
    cardUrl: http.cardUrl,
    close: () => http.close(),
  };
}
