/**
 * Fleet node client — nói chuyện HTTP với node LAN thật (v1.04, Team T6).
 *
 * `fleet/dispatch.ts` chỉ là bộ điều phối ghi sổ: nó quyết định job
 * nào thuộc về node nào, nhưng không tự chạy job hay gọi node. Module
 * này là phía client còn thiếu: controller dùng nó để
 *
 * - `probeHealth`: GET `http://<host>:<port>/health` — node trả 200
 *   thì còn sống (kèm latency đo được); timeout / lỗi mạng / status
 *   khác 200 đều là "không sống", không throw ra ngoài.
 * - `fetchAssignedJobs`: GET `/jobs?nodeId=<id>` — lấy job node được
 *   giao (node tự poll controller; controller không "đẩy" job).
 * - `reportJobDone` / `reportJobFailed`: POST `/jobs/<id>/complete`
 *   và `/jobs/<id>/fail` — node báo kết quả về controller.
 *
 * An toàn (cùng posture với nodes.ts / otlp.ts):
 * - Chỉ gọi host loopback hoặc LAN riêng (tái dùng
 *   `isPrivateOrLoopbackHost`); host công khai bị từ chối fail-closed.
 * - Timeout ngắn cho mọi request (mặc định 5s), không follow redirect.
 * - Không gửi secret nào: request chỉ mang nodeId/jobId/status/error
 *   message (error message do caller tự sanitize trước khi gửi).
 * - `fetch` được inject qua constructor (mặc định fetch global) để
 *   test được mà không cần mạng thật; test vẫn có một case chạy
 *   server HTTP local thật.
 *
 * Node phía server (nhận các endpoint này) chưa thuộc phạm vi v1.04:
 * client này định nghĩa contract mà node server sẽ implement ở sóng
 * sau. Các hàm trả về kết quả có cấu trúc (không throw) để caller
 * luôn xử lý được node chết/mất mạng như một trạng thái bình thường.
 */

import { isPrivateOrLoopbackHost, type FleetNode } from './nodes';

/** Timeout mặc định cho request tới node (ms). */
export const DEFAULT_NODE_CLIENT_TIMEOUT_MS = 5_000;
/** Header nhận diện client (để node log được ai gọi). */
export const NODE_CLIENT_USER_AGENT = 'open-bot-fleet-client/1.04';

/** Kết quả probe health của một node. */
export interface NodeHealthProbe {
  nodeId: string;
  /** True khi node trả 200 trong hạn timeout. */
  alive: boolean;
  /** HTTP status khi có response (undefined khi lỗi mạng/timeout). */
  status?: number;
  /** Latency đo được (ms) — null khi không đo được. */
  latencyMs: number | null;
  /** Lỗi ngắn khi không alive (vd 'timeout', 'connection refused'). */
  error?: string;
  /** Nội dung JSON node trả về (nếu parse được) — vd { load: {...} }. */
  body?: unknown;
}

/** Job node được giao (dạng tối thiểu node cần để chạy). */
export interface NodeAssignedJob {
  id: string;
  botId: string;
  kind: string;
  summary: string;
  resources: { cpuCores: number; ramBytes: number; diskBytes: number };
}

/** Kết quả lấy job của node. */
export interface NodeJobsResult {
  ok: boolean;
  jobs: NodeAssignedJob[];
  error?: string;
}

/** Kết quả báo cáo job (done/fail). */
export interface NodeReportResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Kiểu fetch inject được (mặc định fetch global). */
export type NodeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FleetNodeClientOptions {
  /** Timeout cho mỗi request (ms, mặc định 5000). */
  timeoutMs?: number;
  /** Fetch thay thế (dùng trong test). */
  fetchFn?: NodeFetch;
}

/**
 * Validate host/port của node trước khi gọi (throw khi là host công
 * khai hoặc port sai). Tái dùng luật LAN-only của nodes.ts.
 */
export function validateNodeEndpoint(node: Pick<FleetNode, 'host' | 'port'>): void {
  if (!isPrivateOrLoopbackHost(node.host)) {
    throw new Error(`refusing to call node at public host "${node.host}" — fleet nodes must be local/LAN machines.`);
  }
  if (!Number.isInteger(node.port) || node.port < 1024 || node.port > 65535) {
    throw new Error(`node port ${node.port} is not a valid port (1024–65535).`);
  }
}

/** Base URL cho node (http — LAN tin cậy, không TLS nội bộ ở v1.04). */
export function nodeBaseUrl(node: Pick<FleetNode, 'host' | 'port'>): string {
  validateNodeEndpoint(node);
  const host = node.host.includes(':') && !node.host.startsWith('[') ? `[${node.host}]` : node.host;
  return `http://${host}:${node.port}`;
}

/** Parse body JSON an toàn (trả undefined khi body không phải JSON). */
async function tryParseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate một assigned job từ server (throw khi sai — server trả sai thì lỗi rõ). */
export function validateNodeAssignedJob(raw: unknown): NodeAssignedJob {
  if (!isRecord(raw)) throw new Error('assigned job must be an object.');
  const { id, botId, kind, summary, resources } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('assigned job needs a non-empty id.');
  if (typeof botId !== 'string' || botId.trim().length === 0) throw new Error('assigned job needs a non-empty botId.');
  if (typeof kind !== 'string' || kind.trim().length === 0) throw new Error('assigned job needs a non-empty kind.');
  if (typeof summary !== 'string') throw new Error('assigned job needs a string summary.');
  if (!isRecord(resources)) throw new Error('assigned job needs a resources object.');
  const { cpuCores, ramBytes, diskBytes } = resources;
  for (const [name, value] of [['cpuCores', cpuCores], ['ramBytes', ramBytes], ['diskBytes', diskBytes]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (value as number) <= 0) {
      throw new Error(`assigned job resources.${name} must be a number > 0.`);
    }
  }
  return {
    id: id.trim(),
    botId: botId.trim(),
    kind: kind.trim(),
    summary,
    resources: { cpuCores: cpuCores as number, ramBytes: ramBytes as number, diskBytes: diskBytes as number },
  };
}

/** Client HTTP cho một node fleet. */
export class FleetNodeClient {
  private readonly timeoutMs: number;
  private readonly fetchFn: NodeFetch;

  constructor(options: FleetNodeClientOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error('node client timeoutMs must be a positive integer.');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_NODE_CLIENT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    // Race against a timeout rejection as well: a fetch implementation
    // that ignores the AbortSignal must still not hang the caller.
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutRejection = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('request timed out')), this.timeoutMs);
      timeoutTimer.unref?.();
    });
    try {
      return await Promise.race([
        this.fetchFn(url, {
          ...init,
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'User-Agent': NODE_CLIENT_USER_AGENT, ...(init.headers ?? {}) },
        }),
        timeoutRejection,
      ]);
    } finally {
      clearTimeout(timer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }
  }

  /** Probe health: node trả 200 trong hạn thì alive. Không throw. */
  async probeHealth(node: FleetNode): Promise<NodeHealthProbe> {
    const started = Date.now();
    let url: string;
    try {
      url = `${nodeBaseUrl(node)}/health`;
    } catch (err) {
      return { nodeId: node.id, alive: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const response = await this.request(url, { method: 'GET' });
      const body = await tryParseJson(response);
      const alive = response.status === 200;
      return {
        nodeId: node.id,
        alive,
        status: response.status,
        latencyMs: Date.now() - started,
        ...(alive ? {} : { error: `node returned HTTP ${response.status}.` }),
        ...(body !== undefined ? { body } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = (err as Error).name === 'AbortError' || /aborted|timeout/i.test(message);
      return {
        nodeId: node.id,
        alive: false,
        latencyMs: Date.now() - started,
        error: timedOut ? `health probe timed out after ${this.timeoutMs}ms.` : `health probe failed: ${message}`,
      };
    }
  }

  /** Probe nhiều node song song (mỗi node độc lập — một node chết không chặn node khác). */
  async probeAll(nodes: FleetNode[]): Promise<NodeHealthProbe[]> {
    return Promise.all(nodes.map((node) => this.probeHealth(node)));
  }

  /** Lấy job node được giao. Server trả sai shape → ok false + error rõ. */
  async fetchAssignedJobs(node: FleetNode): Promise<NodeJobsResult> {
    let url: string;
    try {
      url = `${nodeBaseUrl(node)}/jobs?nodeId=${encodeURIComponent(node.id)}`;
    } catch (err) {
      return { ok: false, jobs: [], error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const response = await this.request(url, { method: 'GET' });
      if (response.status !== 200) {
        return { ok: false, jobs: [], error: `node returned HTTP ${response.status} for /jobs.` };
      }
      const body = await tryParseJson(response);
      if (!isRecord(body) || !Array.isArray(body.jobs)) {
        return { ok: false, jobs: [], error: 'node /jobs response has no jobs array.' };
      }
      const jobs = (body.jobs as unknown[]).map(validateNodeAssignedJob);
      return { ok: true, jobs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, jobs: [], error: `fetch jobs failed: ${message}` };
    }
  }

  /** Báo job xong: POST /jobs/<id>/complete. */
  async reportJobDone(node: FleetNode, jobId: string): Promise<NodeReportResult> {
    return this.reportJob(node, jobId, 'complete');
  }

  /** Báo job lỗi: POST /jobs/<id>/fail { error }. */
  async reportJobFailed(node: FleetNode, jobId: string, error: string): Promise<NodeReportResult> {
    if (typeof error !== 'string' || error.trim().length === 0) {
      return { ok: false, error: 'reportJobFailed needs a non-empty error message.' };
    }
    return this.reportJob(node, jobId, 'fail', { error: error.trim() });
  }

  private async reportJob(node: FleetNode, jobId: string, action: 'complete' | 'fail', payload: Record<string, unknown> = {}): Promise<NodeReportResult> {
    let url: string;
    try {
      url = `${nodeBaseUrl(node)}/jobs/${encodeURIComponent(jobId)}/${action}`;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const response = await this.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, status: response.status, error: `node returned HTTP ${response.status} for /jobs/${jobId}/${action}.` };
      }
      return { ok: true, status: response.status };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `report job ${action} failed: ${message}` };
    }
  }
}
