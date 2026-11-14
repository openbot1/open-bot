/**
 * Agent server v2 — HTTP server (v1.04, Đội T4).
 *
 * REST server gọn nhẹ bằng `node:http` thuần (không thêm dependency),
 * treo trên `ConversationManager` (event log):
 *
 *   GET  /v2/health                         (không cần auth — probe sống)
 *   POST /v2/conversations                  { botId?, prompt, title?, model?, maxSteps? }
 *   GET  /v2/conversations
 *   GET  /v2/conversations/:id
 *   GET  /v2/conversations/:id/events      ?types=&fromSeq=&toSeq=&limit=&offset=
 *   GET  /v2/conversations/:id/stream      ?fromSeq=   (SSE)
 *   POST /v2/conversations/:id/messages    { text }
 *   POST /v2/conversations/:id/pause       { reason? }
 *   POST /v2/conversations/:id/resume      { reason? }
 *   POST /v2/conversations/:id/cancel      { message? }
 *   POST /v2/conversations/:id/fork        { atSeq? }
 *   POST /v2/conversations/:id/condense    { strategy?, upToSeq? }
 *   GET  /v2/conversations/:id/snapshot    ?upToSeq=
 *
 * An toàn:
 * - Chỉ bind loopback (`127.0.0.1` mặc định, `::1` cho phép) — host
 *   khác bị từ chối ngay lúc khởi động; request từ địa chỉ không phải
 *   loopback cũng bị 403 (phòng khi bind bị cấu hình sai).
 * - Mọi route trừ `/v2/health` cần `Authorization: Bearer <token>`.
 *   Token sinh ngẫu nhiên mỗi lần khởi động (hoặc caller truyền vào),
 *   so sánh constant-time.
 * - Body JSON giới hạn `maxBodyBytes` (mặc định 1 MB); JSON sai → 400.
 * - Lỗi trả JSON `{ error: { message } }`, không lộ stack.
 */

import * as http from 'node:http';

import { RunControlRegistry } from '../event-log/control';
import { RunLogStore } from '../event-log/store';
import type { CondenseStrategyV2 } from '../event-log/condenser-v2';
import { generateAgentServerToken, isAuthorizedToken, isLoopbackAddress, parseBearerToken } from './auth';
import { ConversationManager } from './conversations';
import { subscribeConversationEvents } from './stream';
import {
  AGENT_SERVER_API_VERSION,
  AgentServerError,
  type AgentServerHandle,
  type AgentServerV2Options,
} from './types';

/** Tùy chọn khởi động (mở rộng: cho phép tiêm manager/store có sẵn). */
export interface StartAgentServerV2Options extends AgentServerV2Options {
  /** Manager đã có (mặc định tự tạo từ logDir). */
  manager?: ConversationManager;
  /** Registry gate đã có (chia sẻ với loop). */
  registry?: RunControlRegistry;
}

const MAX_BODY_BYTES_DEFAULT = 1024 * 1024;

/** Đọc body JSON (giới hạn kích thước, 400 khi JSON sai/quá lớn). */
function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new AgentServerError(400, `Body vượt giới hạn ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new AgentServerError(400, 'Body JSON phải là object.'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new AgentServerError(400, 'Body không phải JSON hợp lệ.'));
      }
    });
    req.on('error', (err) => {
      if (!failed) reject(new AgentServerError(400, `Đọc body lỗi: ${err.message}`));
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof AgentServerError) {
    sendJson(res, err.status, { error: { message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : 'Lỗi server.';
  // Lỗi validation từ manager (prompt rỗng, seq ngoài khoảng…) → 400.
  sendJson(res, 400, { error: { message } });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseQueryInt(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

/** Khởi động agent server v2. Bind loopback-only, token Bearer. */
export async function startAgentServerV2(
  options: StartAgentServerV2Options,
): Promise<AgentServerHandle> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackAddress(host) && host !== 'localhost') {
    throw new Error(`Agent server v2 chỉ bind loopback — host "${host}" bị từ chối.`);
  }
  const token = options.token ?? generateAgentServerToken();
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES_DEFAULT;
  const manager =
    options.manager ??
    new ConversationManager({
      store: new RunLogStore({ logDir: options.logDir }),
      ...(options.registry !== undefined ? { registry: options.registry } : {}),
      ...(options.defaultBotId !== undefined ? { defaultBotId: options.defaultBotId } : {}),
    });

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!res.writableEnded) sendError(res, err);
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Phòng thủ chiều sâu: dù bind loopback, request ngoài loopback vẫn 403.
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: { message: 'Agent server chỉ nhận kết nối loopback.' } });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    if (path === `/${AGENT_SERVER_API_VERSION}/health` && method === 'GET') {
      sendJson(res, 200, { ok: true, version: AGENT_SERVER_API_VERSION });
      return;
    }
    // Mọi route còn lại cần Bearer token.
    if (!isAuthorizedToken(parseBearerToken(req.headers.authorization), token)) {
      sendJson(res, 401, { error: { message: 'Thiếu hoặc sai Bearer token.' } });
      return;
    }

    try {
      // POST /v2/conversations
      if (path === `/${AGENT_SERVER_API_VERSION}/conversations` && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        const prompt = asString(body['prompt']);
        if (prompt === undefined || prompt.trim() === '') {
          throw new AgentServerError(400, 'Tạo conversation: thiếu prompt.');
        }
        const created = manager.create({
          ...(asString(body['botId']) !== undefined ? { botId: asString(body['botId']) } : {}),
          prompt,
          ...(asString(body['title']) !== undefined ? { title: asString(body['title']) } : {}),
          ...(asString(body['model']) !== undefined ? { model: asString(body['model']) } : {}),
          ...(asNumber(body['maxSteps']) !== undefined ? { maxSteps: asNumber(body['maxSteps']) } : {}),
        });
        sendJson(res, 201, created);
        return;
      }
      // GET /v2/conversations
      if (path === `/${AGENT_SERVER_API_VERSION}/conversations` && method === 'GET') {
        sendJson(res, 200, { conversations: manager.list() });
        return;
      }

      const match = new RegExp(`^/${AGENT_SERVER_API_VERSION}/conversations/([^/]+)(?:/(events|stream|messages|pause|resume|cancel|fork|condense|snapshot))?$`).exec(path);
      if (match === null) {
        sendJson(res, 404, { error: { message: `Không có route ${method} ${path}.` } });
        return;
      }
      const id = decodeURIComponent(match[1]!);
      const sub = match[2];

      // GET /v2/conversations/:id
      if (sub === undefined && method === 'GET') {
        sendJson(res, 200, manager.get(id));
        return;
      }
      // GET /v2/conversations/:id/events
      if (sub === 'events' && method === 'GET') {
        const types = url.searchParams.get('types');
        const result = manager.events(id, {
          ...(types !== null && types !== ''
            ? { types: types.split(',').map((t) => t.trim()).filter((t) => t !== '') as never }
            : {}),
          ...(parseQueryInt(url.searchParams.get('fromSeq')) !== undefined
            ? { fromSeq: parseQueryInt(url.searchParams.get('fromSeq')) }
            : {}),
          ...(parseQueryInt(url.searchParams.get('toSeq')) !== undefined
            ? { toSeq: parseQueryInt(url.searchParams.get('toSeq')) }
            : {}),
          ...(parseQueryInt(url.searchParams.get('limit')) !== undefined
            ? { limit: parseQueryInt(url.searchParams.get('limit')) }
            : {}),
          ...(parseQueryInt(url.searchParams.get('offset')) !== undefined
            ? { offset: parseQueryInt(url.searchParams.get('offset')) }
            : {}),
        });
        sendJson(res, 200, result);
        return;
      }
      // GET /v2/conversations/:id/stream (SSE)
      if (sub === 'stream' && method === 'GET') {
        if (!manager.store.exists(id)) {
          throw new AgentServerError(404, `Không tìm thấy conversation ${id}.`);
        }
        subscribeConversationEvents(manager.store, id, res, {
          ...(parseQueryInt(url.searchParams.get('fromSeq')) !== undefined
            ? { fromSeq: parseQueryInt(url.searchParams.get('fromSeq')) }
            : {}),
          pollMs: options.ssePollMs,
          heartbeatMs: options.sseHeartbeatMs,
        });
        return;
      }
      // GET /v2/conversations/:id/snapshot
      if (sub === 'snapshot' && method === 'GET') {
        const upToSeq = parseQueryInt(url.searchParams.get('upToSeq'));
        const snap = manager.snapshot(id, upToSeq);
        sendJson(res, 200, {
          runId: snap.snapshot.runId,
          upToSeq: snap.snapshot.upToSeq,
          createdAt: snap.snapshot.createdAt,
          digest: snap.snapshot.digest,
          eventCount: snap.snapshot.eventCount,
          filePath: snap.filePath,
        });
        return;
      }
      // POST /v2/conversations/:id/messages
      if (sub === 'messages' && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        const text = asString(body['text']);
        if (text === undefined || text.trim() === '') {
          throw new AgentServerError(400, 'Gửi message: thiếu text.');
        }
        sendJson(res, 200, manager.sendMessage(id, { text }));
        return;
      }
      // POST /v2/conversations/:id/pause | resume | cancel
      if ((sub === 'pause' || sub === 'resume' || sub === 'cancel') && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        const input = {
          ...(asString(body['reason']) !== undefined ? { reason: asString(body['reason']) } : {}),
          ...(asString(body['message']) !== undefined ? { message: asString(body['message']) } : {}),
        };
        if (sub === 'pause') sendJson(res, 200, manager.pause(id, input));
        else if (sub === 'resume') sendJson(res, 200, manager.resume(id, input));
        else sendJson(res, 200, manager.cancel(id, input));
        return;
      }
      // POST /v2/conversations/:id/fork
      if (sub === 'fork' && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        const result = manager.fork(id, {
          ...(asNumber(body['atSeq']) !== undefined ? { atSeq: asNumber(body['atSeq']) } : {}),
        });
        sendJson(res, 201, {
          parentRunId: result.parentRunId,
          childRunId: result.childRunId,
          forkFromSeq: result.forkFromSeq,
          copiedEvents: result.copiedEvents,
          child: result.child,
        });
        return;
      }
      // POST /v2/conversations/:id/condense
      if (sub === 'condense' && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes);
        const strategy = asString(body['strategy']);
        if (
          strategy !== undefined &&
          strategy !== 'summarize' &&
          strategy !== 'truncate' &&
          strategy !== 'extract-keep'
        ) {
          throw new AgentServerError(400, `strategy không biết "${strategy}" (summarize | truncate | extract-keep).`);
        }
        const report = manager.condense(id, {
          ...(strategy !== undefined ? { strategy: strategy as CondenseStrategyV2 } : {}),
          ...(asNumber(body['upToSeq']) !== undefined ? { upToSeq: asNumber(body['upToSeq']) } : {}),
        });
        sendJson(res, 200, report);
        return;
      }
      sendJson(res, 405, { error: { message: `Method ${method} không hỗ trợ cho ${path}.` } });
    } catch (err) {
      if (!res.writableEnded) sendError(res, err);
    }
  }

  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    token,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Ép đóng connection SSE đang mở (nếu close() treo).
        server.closeAllConnections?.();
      });
    },
  };
}
