/**
 * Fleet nodes v1 — multi-machine fleet (v1.04, Team T6).
 *
 * Fleet v1–v3 chỉ đặt bot lên workspace trên CÙNG MỘT máy. Module này
 * là bước đầu của multi-machine dispatch: mỗi máy trong mạng LAN của
 * user là một "node" có CPU/RAM/disk + heartbeat, và controller chỉ
 * dispatch job sang node còn sống.
 *
 * NGUYÊN TẮC (hướng đứng của Huy — local-first, không cloud):
 * - Chỉ máy local / LAN của user. Không có khái niệm cloud VM, không
 *   tài khoản, không thanh toán. Node đăng ký bằng host LAN hoặc
 *   loopback; host công khai bị từ chối fail-closed.
 * - Loopback-first: node local (127.0.0.1 / localhost / ::1) luôn
 *   được ưu tiên hơn node LAN xa khi ngang sức — không tốn mạng, không
 *   phụ thuộc mạng.
 * - Trung thực về liveness: một node chỉ "alive" khi heartbeat của nó
 *   còn trong hạn. Không có heartbeat gần đây = nghi ngờ/chết, không
 *   bao giờ đoán là sống. Dispatch sang node chết là lỗi của
 *   controller, không phải của node.
 * - Store durable: `<fleetRoot>/fleet-nodes.json` (atomic write, mode
 *   0600, cùng posture với fleet.json / fleet-schedule.json).
 *
 * Module này KHÔNG làm lại scheduler trong máy
 * (`fleet/scheduling.ts` — placement lên workspace): node scoring ở
 * đây chọn MÁY, scheduling.ts chọn WORKSPACE trên máy đó. Hai tầng
 * xếp chồng nhau, không trùng lặp.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu registry node trong fleet root. */
export const FLEET_NODES_FILE = 'fleet-nodes.json';

/** Node chết khi không thấy heartbeat quá ngưỡng này (mặc định). */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
/** Node quá hạn này mà không heartbeat thì coi là stale (cảnh báo sớm). */
export const DEFAULT_HEARTBEAT_STALE_MS = 10_000;
/** Node tự đăng ký mặc định sống bao lâu nếu không heartbeat tiếp (dọn dẹp). */
export const DEFAULT_NODE_TTL_MS = 10 * 60_000;

/** Vai trò của node trong fleet LAN. */
export type FleetNodeRole = 'controller' | 'worker';

export const FLEET_NODE_ROLES: readonly FleetNodeRole[] = ['controller', 'worker'];

/** Trạng thái liveness suy ra từ heartbeat (không lưu, tính lúc đọc). */
export type FleetNodeLiveness = 'alive' | 'stale' | 'dead' | 'never-seen';

export interface FleetNodeLoad {
  /** Số job đang chạy trên node (do node tự báo qua heartbeat). */
  runningJobs: number;
  /** Số job đang chờ trên node. */
  queuedJobs: number;
  /** CPU đang dùng, 0..1 — null khi node không báo. */
  cpuUsedFraction: number | null;
  /** RAM đang dùng (bytes) — null khi node không báo. */
  ramUsedBytes: number | null;
}

/** Một máy trong fleet LAN. */
export interface FleetNode {
  /** Id ổn định: `fn-<uuid>`. */
  id: string;
  /** Hostname hiển thị (vd 'may-phong-khach'). */
  hostname: string;
  /** Host để kết nối: IP LAN, hostname LAN, hoặc 127.0.0.1/localhost. */
  host: string;
  /** Port của agent node trên máy đó (1024–65535). */
  port: number;
  role: FleetNodeRole;
  /** CPU node khai báo (core, có thể là 0.5). */
  cpuCores: number;
  /** RAM node khai báo (bytes). */
  ramBytes: number;
  /** Đĩa node khai báo (bytes). */
  diskBytes: number;
  /** True khi host là loopback (127.0.0.1 / localhost / ::1). */
  loopback: boolean;
  /** Epoch ms của heartbeat gần nhất — null khi chưa từng heartbeat. */
  lastHeartbeatAt: number | null;
  /** Load gần nhất node báo qua heartbeat — null khi chưa có. */
  lastLoad: FleetNodeLoad | null;
  /** Epoch ms đăng ký. */
  registeredAt: number;
  /** Epoch ms cập nhật gần nhất. */
  updatedAt: number;
}

/** Đầu vào đăng ký node (id/hostname mặc định sinh tự động). */
export interface RegisterFleetNodeInput {
  id?: string;
  hostname: string;
  host: string;
  port?: number;
  role?: FleetNodeRole;
  cpuCores?: number;
  ramBytes?: number;
  diskBytes?: number;
}

/** Node + liveness tính tại thời điểm đọc. */
export interface FleetNodeView {
  node: FleetNode;
  liveness: FleetNodeLiveness;
  /** Ms từ heartbeat gần nhất — null khi chưa từng heartbeat. */
  msSinceHeartbeat: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function newNodeId(): string {
  return `fn-${crypto.randomUUID()}`;
}

/** True khi host là loopback (local machine). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/**
 * True khi host là địa chỉ LAN riêng (RFC 1918) hoặc loopback.
 * Host công khai / tên miền công khai bị từ chối — fleet chỉ chạy
 * trên máy của user, không gọi ra internet.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (isLoopbackHost(h)) return true;
  // IPv4: 10/8, 172.16/12, 192.168/16.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6 link-local / unique-local: fe80::/10, fc00::/7.
  if (h.startsWith('fe80:') || h.startsWith('fe80::') || h.startsWith('fc') || h.startsWith('fd')) return true;
  // Hostname LAN không có dấu chấm hoặc kết thúc bằng .local / .lan / .home.
  if (!h.includes('.')) return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.intranet')) return true;
  return false;
}

/** Validate đầu vào đăng ký node (throw khi sai, kèm lý do rõ). */
export function validateRegisterNodeInput(raw: unknown): RegisterFleetNodeInput {
  if (!isRecord(raw)) throw new Error('node registration must be an object.');
  const { id, hostname, host, port, role, cpuCores, ramBytes, diskBytes } = raw;
  if (id !== undefined && (typeof id !== 'string' || id.trim().length === 0)) {
    throw new Error('node id must be a non-empty string when given.');
  }
  if (typeof hostname !== 'string' || hostname.trim().length === 0) {
    throw new Error('node registration needs a non-empty hostname.');
  }
  if (typeof host !== 'string' || host.trim().length === 0) {
    throw new Error('node registration needs a non-empty host.');
  }
  if (!isPrivateOrLoopbackHost(host)) {
    throw new Error(
      `node host "${host}" is not a loopback or private LAN address — fleet nodes must be local/LAN machines, never a public host.`,
    );
  }
  if (port !== undefined && (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535)) {
    throw new Error('node port must be an integer between 1024 and 65535.');
  }
  if (role !== undefined && !FLEET_NODE_ROLES.includes(role as FleetNodeRole)) {
    throw new Error(`node role must be one of: ${FLEET_NODE_ROLES.join(', ')}.`);
  }
  if (cpuCores !== undefined && !isPositiveFinite(cpuCores)) {
    throw new Error('node cpuCores must be a number > 0.');
  }
  if (ramBytes !== undefined && !isPositiveFinite(ramBytes)) {
    throw new Error('node ramBytes must be a number > 0.');
  }
  if (diskBytes !== undefined && !isPositiveFinite(diskBytes)) {
    throw new Error('node diskBytes must be a number > 0.');
  }
  return {
    ...(id !== undefined ? { id } : {}),
    hostname: hostname.trim(),
    host: host.trim(),
    ...(port !== undefined ? { port: port as number } : {}),
    ...(role !== undefined ? { role: role as FleetNodeRole } : {}),
    ...(cpuCores !== undefined ? { cpuCores } : {}),
    ...(ramBytes !== undefined ? { ramBytes } : {}),
    ...(diskBytes !== undefined ? { diskBytes } : {}),
  };
}

/** Validate load node báo qua heartbeat (throw khi sai). */
export function validateNodeLoad(raw: unknown): FleetNodeLoad {
  if (!isRecord(raw)) throw new Error('node load must be an object.');
  const { runningJobs, queuedJobs, cpuUsedFraction, ramUsedBytes } = raw;
  if (!Number.isInteger(runningJobs) || (runningJobs as number) < 0) {
    throw new Error('node load runningJobs must be an integer >= 0.');
  }
  if (!Number.isInteger(queuedJobs) || (queuedJobs as number) < 0) {
    throw new Error('node load queuedJobs must be an integer >= 0.');
  }
  if (
    cpuUsedFraction !== null &&
    (!isNonNegativeFinite(cpuUsedFraction) || (cpuUsedFraction as number) > 1)
  ) {
    throw new Error('node load cpuUsedFraction must be null or a number between 0 and 1.');
  }
  if (ramUsedBytes !== null && !isNonNegativeFinite(ramUsedBytes)) {
    throw new Error('node load ramUsedBytes must be null or a number >= 0.');
  }
  return {
    runningJobs: runningJobs as number,
    queuedJobs: queuedJobs as number,
    cpuUsedFraction: cpuUsedFraction as number | null,
    ramUsedBytes: ramUsedBytes as number | null,
  };
}

/** Đường dẫn file registry node. */
export function getFleetNodesPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_NODES_FILE);
}

function parseNode(raw: unknown, index: number): FleetNode {
  if (!isRecord(raw)) throw new Error(`fleet node at index ${index} is not an object.`);
  const { id, hostname, host, port, role, cpuCores, ramBytes, diskBytes, loopback, lastHeartbeatAt, lastLoad, registeredAt, updatedAt } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error(`fleet node at index ${index} needs a non-empty id.`);
  if (typeof hostname !== 'string' || hostname.trim().length === 0) throw new Error(`fleet node ${id} needs a non-empty hostname.`);
  if (typeof host !== 'string' || host.trim().length === 0) throw new Error(`fleet node ${id} needs a non-empty host.`);
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535) throw new Error(`fleet node ${id} has an invalid port.`);
  if (role !== 'controller' && role !== 'worker') throw new Error(`fleet node ${id} has an invalid role.`);
  if (!isPositiveFinite(cpuCores) || !isPositiveFinite(ramBytes) || !isPositiveFinite(diskBytes)) {
    throw new Error(`fleet node ${id} needs positive cpuCores/ramBytes/diskBytes.`);
  }
  if (typeof loopback !== 'boolean') throw new Error(`fleet node ${id} needs a boolean loopback.`);
  if (lastHeartbeatAt !== null && !Number.isInteger(lastHeartbeatAt)) throw new Error(`fleet node ${id} has an invalid lastHeartbeatAt.`);
  if (lastLoad !== null) validateNodeLoad(lastLoad);
  if (!Number.isInteger(registeredAt) || !Number.isInteger(updatedAt)) throw new Error(`fleet node ${id} needs integer registeredAt/updatedAt.`);
  return {
    id: id as string,
    hostname: hostname as string,
    host: host as string,
    port: port as number,
    role: role as FleetNodeRole,
    cpuCores: cpuCores as number,
    ramBytes: ramBytes as number,
    diskBytes: diskBytes as number,
    loopback: loopback as boolean,
    lastHeartbeatAt: lastHeartbeatAt as number | null,
    lastLoad: lastLoad as FleetNodeLoad | null,
    registeredAt: registeredAt as number,
    updatedAt: updatedAt as number,
  };
}

/** Đọc registry node (file chưa có → danh sách rỗng; file hỏng → throw rõ). */
export function loadFleetNodes(fleetRoot: string): FleetNode[] {
  const filePath = getFleetNodesPath(fleetRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`fleet nodes file ${filePath} is not valid JSON — refusing to guess; fix or remove it.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`fleet nodes file ${filePath} must contain a JSON array.`);
  return parsed.map((entry, index) => parseNode(entry, index));
}

/** Ghi registry node (atomic: tmp + rename, mode 0600). */
export function saveFleetNodes(fleetRoot: string, nodes: FleetNode[]): void {
  fs.mkdirSync(fleetRoot, { recursive: true });
  const filePath = getFleetNodesPath(fleetRoot);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(nodes, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Filesystem không hỗ trợ chmod (vd một số mount Windows) — bỏ qua.
  }
}

/** Đăng ký node mới (host+port trùng → throw; hostname trùng → throw). */
export function registerFleetNode(fleetRoot: string, input: RegisterFleetNodeInput): FleetNode {
  const valid = validateRegisterNodeInput(input);
  const nodes = loadFleetNodes(fleetRoot);
  const id = valid.id ?? newNodeId();
  if (nodes.some((n) => n.id === id)) throw new Error(`fleet node id "${id}" is already registered.`);
  if (nodes.some((n) => n.hostname === valid.hostname)) {
    throw new Error(`fleet node hostname "${valid.hostname}" is already registered.`);
  }
  if (nodes.some((n) => n.host === valid.host && n.port === (valid.port ?? 18080))) {
    throw new Error(`fleet node ${valid.host}:${valid.port ?? 18080} is already registered.`);
  }
  const now = Date.now();
  const node: FleetNode = {
    id,
    hostname: valid.hostname,
    host: valid.host,
    port: valid.port ?? 18080,
    role: valid.role ?? 'worker',
    cpuCores: valid.cpuCores ?? 2,
    ramBytes: valid.ramBytes ?? 4 * 1024 ** 3,
    diskBytes: valid.diskBytes ?? 50 * 1024 ** 3,
    loopback: isLoopbackHost(valid.host),
    lastHeartbeatAt: null,
    lastLoad: null,
    registeredAt: now,
    updatedAt: now,
  };
  saveFleetNodes(fleetRoot, [...nodes, node]);
  return node;
}

/** Gỡ node khỏi registry (không có → throw). */
export function removeFleetNode(fleetRoot: string, nodeId: string): FleetNode {
  const nodes = loadFleetNodes(fleetRoot);
  const found = nodes.find((n) => n.id === nodeId);
  if (!found) throw new Error(`fleet node "${nodeId}" is not registered.`);
  saveFleetNodes(fleetRoot, nodes.filter((n) => n.id !== nodeId));
  return found;
}

/** Tìm node theo id (không có → null, không throw). */
export function findFleetNode(fleetRoot: string, nodeId: string): FleetNode | null {
  return loadFleetNodes(fleetRoot).find((n) => n.id === nodeId) ?? null;
}

/**
 * Ghi nhận heartbeat của node: cập nhật lastHeartbeatAt + load báo cáo.
 * Node chưa đăng ký → throw (heartbeat không tự đăng ký node lạ).
 */
export function recordNodeHeartbeat(fleetRoot: string, nodeId: string, load: FleetNodeLoad, at = Date.now()): FleetNode {
  const validLoad = validateNodeLoad(load);
  const nodes = loadFleetNodes(fleetRoot);
  const index = nodes.findIndex((n) => n.id === nodeId);
  if (index === -1) throw new Error(`heartbeat from unknown fleet node "${nodeId}" — register it first.`);
  const updated: FleetNode = { ...nodes[index], lastHeartbeatAt: at, lastLoad: validLoad, updatedAt: at };
  nodes[index] = updated;
  saveFleetNodes(fleetRoot, nodes);
  return updated;
}

/**
 * Liveness của một node tại thời điểm `now` (pure, dễ test):
 * - chưa từng heartbeat → 'never-seen';
 * - quá heartbeatTimeoutMs → 'dead';
 * - quá heartbeatStaleMs → 'stale';
 * - còn lại → 'alive'.
 */
export function nodeLiveness(
  node: FleetNode,
  now = Date.now(),
  staleMs = DEFAULT_HEARTBEAT_STALE_MS,
  timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
): FleetNodeLiveness {
  if (node.lastHeartbeatAt === null) return 'never-seen';
  const age = now - node.lastHeartbeatAt;
  if (age >= timeoutMs) return 'dead';
  if (age >= staleMs) return 'stale';
  return 'alive';
}

/** Node + liveness tại thời điểm đọc. */
export function viewFleetNode(node: FleetNode, now = Date.now()): FleetNodeView {
  return {
    node,
    liveness: nodeLiveness(node, now),
    msSinceHeartbeat: node.lastHeartbeatAt === null ? null : now - node.lastHeartbeatAt,
  };
}

/** Tất cả node kèm liveness (mới heartbeat nhất trước). */
export function listFleetNodeViews(fleetRoot: string, now = Date.now()): FleetNodeView[] {
  return loadFleetNodes(fleetRoot)
    .map((node) => viewFleetNode(node, now))
    .sort((a, b) => (b.node.lastHeartbeatAt ?? 0) - (a.node.lastHeartbeatAt ?? 0));
}

/** Các node đã chết tại `now` (quá timeout, hoặc chưa từng heartbeat mà đã quá TTL đăng ký). */
export function detectDeadNodes(
  nodes: FleetNode[],
  now = Date.now(),
  timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  ttlMs = DEFAULT_NODE_TTL_MS,
): FleetNode[] {
  return nodes.filter((node) => {
    if (node.lastHeartbeatAt === null) return now - node.registeredAt >= ttlMs;
    return now - node.lastHeartbeatAt >= timeoutMs;
  });
}

/**
 * Gỡ các node chết khỏi registry, trả về danh sách đã gỡ.
 * Dọn dẹp là hành động tường minh của caller (thường sau khi job của
 * node chết đã được requeue — xem fleet/dispatch.ts).
 */
export function pruneDeadNodes(
  fleetRoot: string,
  now = Date.now(),
  timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  ttlMs = DEFAULT_NODE_TTL_MS,
): FleetNode[] {
  const nodes = loadFleetNodes(fleetRoot);
  const dead = detectDeadNodes(nodes, now, timeoutMs, ttlMs);
  if (dead.length === 0) return [];
  const deadIds = new Set(dead.map((n) => n.id));
  saveFleetNodes(fleetRoot, nodes.filter((n) => !deadIds.has(n.id)));
  return dead;
}

/** Yêu cầu tài nguyên của một job cần dispatch. */
export interface FleetNodeDispatchRequest {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
}

/** Một node được chấm điểm cho một dispatch request. */
export interface FleetNodeScore {
  node: FleetNode;
  liveness: FleetNodeLiveness;
  /** True khi node đủ tài nguyên khai báo (chưa trừ load đo được — load chỉ để xếp hạng). */
  fits: boolean;
  /** 0..1, cao hơn = dispatch tốt hơn (0 khi không fit hoặc không alive). */
  score: number;
  /** Lý do ngắn gọn. */
  reason: string;
}

/**
 * Chấm điểm một node cho một dispatch request (pure):
 * - dead / never-seen → 0, không bao giờ là target;
 * - không đủ tài nguyên khai báo → 0;
 * - còn lại: điểm từ tài nguyên trống sau khi trừ request + load hiện
 *   tại (node rảnh hơn thắng) + bonus loopback (+0.15, tối đa 1).
 * Stale node vẫn được chấm (điểm bị phạt một nửa) nhưng caller nên
 * ưu tiên alive; dispatch sang stale node chỉ khi không còn alive.
 */
export function scoreNodeForDispatch(
  node: FleetNode,
  request: FleetNodeDispatchRequest,
  now = Date.now(),
): FleetNodeScore {
  const liveness = nodeLiveness(node, now);
  if (liveness === 'dead' || liveness === 'never-seen') {
    return { node, liveness, fits: false, score: 0, reason: `node is ${liveness}, never dispatch to it.` };
  }
  if (request.cpuCores > node.cpuCores || request.ramBytes > node.ramBytes || request.diskBytes > node.diskBytes) {
    return { node, liveness, fits: false, score: 0, reason: 'node does not have the requested resources.' };
  }
  const load = node.lastLoad;
  const queued = load?.queuedJobs ?? 0;
  const running = load?.runningJobs ?? 0;
  const cpuUsed = load?.cpuUsedFraction ?? 0;
  // Tài nguyên trống sau request (phần còn lại của khai báo).
  const freeCpu = Math.max(0, (node.cpuCores - request.cpuCores) / node.cpuCores);
  const freeRam = Math.max(0, (node.ramBytes - request.ramBytes) / node.ramBytes);
  const freeDisk = Math.max(0, (node.diskBytes - request.diskBytes) / node.diskBytes);
  const headroom = (freeCpu + freeRam + freeDisk) / 3;
  // Phạt theo load: mỗi job đang chạy/chờ trừ điểm, CPU dùng cao trừ thêm.
  const loadPenalty = Math.min(0.5, (running + queued) * 0.05 + cpuUsed * 0.2);
  let score = Math.max(0, Math.min(1, headroom * 0.85 - loadPenalty + 0.15));
  if (node.loopback) score = Math.min(1, score + 0.15);
  if (liveness === 'stale') score *= 0.5;
  const reason = node.loopback
    ? 'loopback node with enough resources.'
    : 'LAN node with enough resources.';
  return { node, liveness, fits: true, score, reason };
}

/** Chọn node tốt nhất cho một request (null khi không node nào fit + alive/stale). */
export function pickBestNode(
  nodes: FleetNode[],
  request: FleetNodeDispatchRequest,
  now = Date.now(),
): FleetNodeScore | null {
  const scored = nodes
    .map((node) => scoreNodeForDispatch(node, request, now))
    .filter((s) => s.fits)
    .sort((a, b) => {
      // Alive trước stale; trong cùng liveness thì điểm cao trước.
      if (a.liveness !== b.liveness) return a.liveness === 'alive' ? -1 : 1;
      return b.score - a.score;
    });
  return scored[0] ?? null;
}
