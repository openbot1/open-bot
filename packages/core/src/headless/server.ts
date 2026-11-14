/**
 * Headless server mode (v1.05, Đội T3) — chạy core không cần UI desktop.
 *
 * Học ý tưởng headless server của các agent khác (server local chỉ
 * nghe loopback, health endpoint, quản lý bằng start/stop/status)
 * nhưng viết mới hoàn toàn cho open-bot, dùng `node:http` thuần.
 *
 * - Chỉ bind `127.0.0.1` (loopback) — không bao giờ listen 0.0.0.0.
 * - Endpoints: `GET /health` (liveness, không cần auth),
 *   `GET /status` (uptime, version, pid, số bot nếu host cung cấp),
 *   `GET /models` (snapshot registry nếu host cung cấp — không lộ key).
 * - Log ra file (append, mỗi dòng có timestamp ISO) khi host truyền
 *   `logFile`; không log ra stdout để stdout của daemon sạch.
 * - PID file: `writePidFile`/`readPidFile` để CLI `headless stop`
 *   tìm đúng process; `isProcessAlive` kiểm tra bằng `process.kill(pid, 0)`.
 * - Không có auth token ở v1.05: server chỉ nghe loopback nên chỉ
 *   process trên cùng máy gọi được; ghi rõ trong docstring để không
 *   ai tưởng là public API.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

export const HEADLESS_DEFAULT_PORT = 8799;
export const HEADLESS_DEFAULT_HOST = '127.0.0.1';
export const HEADLESS_PID_FILE = 'headless.pid';
export const HEADLESS_LOG_FILE = 'headless.log';
export const HEADLESS_VERSION = '1.05.0';

/** Thông tin trạng thái host cung cấp cho /status (optional). */
export interface HeadlessStatusInfo {
  /** Số bot đã cấu hình. */
  botCount?: number;
  /** Số provider đã cấu hình key. */
  configuredProviders?: number;
  /** Ollama local có chạy không. */
  ollamaRunning?: boolean;
}

export interface HeadlessServerOptions {
  /** Port (mặc định 8799). 0 = để OS chọn port trống. */
  port?: number;
  /** Host — luôn 127.0.0.1 trừ khi caller cố tình đổi (không khuyến khích). */
  host?: string;
  /** File log (append). Không truyền thì không ghi file. */
  logFile?: string;
  /** Callback cung cấp thông tin cho /status. */
  getStatusInfo?: () => HeadlessStatusInfo | Promise<HeadlessStatusInfo>;
  /** Lấy snapshot model cho /models (trả về providerId -> model ids). */
  getModels?: () => Record<string, string[]> | Promise<Record<string, string[]>>;
  /** Ghi log ra đâu ngoài file (mặc định không log đâu cả). */
  logger?: { info(message: string): void };
}

export interface HeadlessServerHandle {
  host: string;
  port: number;
  /** Thời điểm start (epoch ms). */
  startedAt: number;
  /** URL gốc, vd http://127.0.0.1:8799. */
  url: string;
  /** Dừng server (đợi connection đóng). */
  close: () => Promise<void>;
}

export interface HeadlessHealth {
  status: 'ok';
  version: string;
  uptimeSeconds: number;
  pid: number;
}

function logLine(options: HeadlessServerOptions, line: string): void {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  if (options.logFile) {
    try {
      fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
      fs.appendFileSync(options.logFile, stamped, 'utf8');
    } catch {
      // Ghi log lỗi không được làm chết server.
    }
  }
  options.logger?.info(stamped.trimEnd());
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * Khởi động headless server. Resolve khi đã listen; reject khi port
 * bận hoặc bind lỗi. Caller giữ handle để `close()`.
 */
export function startHeadlessServer(options: HeadlessServerOptions = {}): Promise<HeadlessServerHandle> {
  const host = options.host ?? HEADLESS_DEFAULT_HOST;
  const requestedPort = options.port ?? HEADLESS_DEFAULT_PORT;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      void (async () => {
        try {
          if (req.method === 'GET' && url.pathname === '/health') {
            const health: HeadlessHealth = {
              status: 'ok',
              version: HEADLESS_VERSION,
              uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
              pid: process.pid,
            };
            jsonResponse(res, 200, health);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/status') {
            const info = (await options.getStatusInfo?.()) ?? {};
            jsonResponse(res, 200, {
              status: 'ok',
              version: HEADLESS_VERSION,
              uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
              pid: process.pid,
              startedAt: new Date(startedAt).toISOString(),
              ...info,
            });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/models') {
            const models = (await options.getModels?.()) ?? {};
            jsonResponse(res, 200, { providers: models });
            return;
          }
          jsonResponse(res, 404, { error: `Không có endpoint ${url.pathname}.` });
        } catch (err) {
          jsonResponse(res, 500, { error: (err as Error).message });
        }
      })();
    });
    server.once('error', (err) => {
      logLine(options, `headless: không start được (${(err as Error).message})`);
      reject(err);
    });
    server.listen(requestedPort, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
      logLine(options, `headless: đang nghe http://${host}:${port} (pid ${process.pid})`);
      resolve({
        host,
        port,
        startedAt,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              logLine(options, 'headless: đã dừng');
              resolveClose();
            });
          }),
      });
    });
  });
}

/** Ghi PID file `<dataDir>/headless.pid` (ghi đè nếu đã có). */
export function writePidFile(dataDir: string, pid: number): string {
  const file = path.join(dataDir, HEADLESS_PID_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${pid}\n`, 'utf8');
  return file;
}

/** Đọc PID file; trả về null khi không có file / nội dung không phải số. */
export function readPidFile(dataDir: string): number | null {
  const file = path.join(dataDir, HEADLESS_PID_FILE);
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Xoá PID file (khi đã stop). */
export function removePidFile(dataDir: string): void {
  try {
    fs.unlinkSync(path.join(dataDir, HEADLESS_PID_FILE));
  } catch {
    // Không có file thì thôi.
  }
}

/** Process có pid còn sống không (kill(pid, 0)). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Trạng thái headless từ PID file: 'running' | 'stopped' | 'stale'. */
export function headlessPidStatus(dataDir: string): { status: 'running' | 'stopped' | 'stale'; pid: number | null } {
  const pid = readPidFile(dataDir);
  if (pid === null) return { status: 'stopped', pid: null };
  return isProcessAlive(pid) ? { status: 'running', pid } : { status: 'stale', pid };
}

/** Kiểm tra server có trả /health không (dùng cho `headless status`). */
export async function probeHeadlessHealth(
  host: string,
  port: number,
  timeoutMs = 3000,
): Promise<HeadlessHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const parsed = (await res.json()) as unknown;
    if (typeof parsed !== 'object' || parsed === null || (parsed as { status?: unknown }).status !== 'ok') return null;
    return parsed as HeadlessHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
