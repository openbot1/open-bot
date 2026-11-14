/**
 * Fleet node maintenance — drain / undrain + maintenance windows
 * (v1.06, Đội T6).
 *
 * Khi một máy trong fleet cần bảo trì (cập nhật OS, thay RAM, …),
 * controller không được giao thêm bot run cho nó, và các run đang
 * giữ trên đó nên được chuyển đi trước khi máy tắt. Module này làm
 * đúng 2 việc đó, trên cùng store với `fleet/nodes.ts`:
 *
 * - `drainFleetNode` / `undrainFleetNode`: gắn cờ `draining` lên
 *   node (lưu trong `fleet-nodes.json` — xem `nodes.ts`; cờ này là
 *   field optional nên node cũ không có cờ vẫn đọc được). Node đang
 *   drain KHÔNG BAO GIỜ được `scoreNodeForBotRun` chọn (xem
 *   `botScheduling.ts` — hàm đó nhận `draining` qua `FleetNode`
 *   mở rộng), nhưng run đang chạy trên đó không bị giết — caller
 *   chủ động `requeueDrainedNodeRuns` để chuyển chúng về hàng đợi.
 * - Maintenance window: `scheduleMaintenanceWindow` ghi một cửa sổ
 *   bảo trì (bắt đầu/kết thúc, lý do) vào
 *   `<fleetRoot>/fleet-maintenance.json`; `maintenanceDueNow` cho
 *   biết node nào đang trong cửa sổ bảo trì tại `now` (để controller
 *   tự drain trước giờ bảo trì), `pruneMaintenanceWindows` dọn cửa
 *   sổ đã qua.
 *
 * Module này KHÔNG tắt máy, KHÔNG kill process: nó chỉ ghi sổ trạng
 * thái để scheduler + con người phối hợp. Drain là hành động tường
 * minh của admin, ghi rõ lý do; undrain cũng vậy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  loadFleetNodes,
  saveFleetNodes,
  type FleetNode,
} from './nodes';
import {
  loadBotRuns,
  saveBotRuns,
  type BotRun,
} from './botScheduling';

/** File lưu cửa sổ bảo trì trong fleet root. */
export const FLEET_MAINTENANCE_FILE = 'fleet-maintenance.json';

/** Một cửa sổ bảo trì của một node. */
export interface FleetMaintenanceWindow {
  /** Id ổn định: `fm-<uuid>`. */
  id: string;
  nodeId: string;
  /** Epoch ms bắt đầu bảo trì. */
  startsAt: number;
  /** Epoch ms kết thúc bảo trì (phải sau startsAt). */
  endsAt: number;
  /** Lý do (vd 'cập nhật OS'). */
  reason: string;
  createdBy: string;
  createdAt: number;
}

/** Đầu vào đặt cửa sổ bảo trì. */
export interface ScheduleMaintenanceInput {
  id?: string;
  nodeId: string;
  startsAt: number;
  endsAt: number;
  reason: string;
  createdBy?: string;
}

/** Node + cờ draining (mở rộng FleetNode, không đổi shape gốc). */
export interface DrainingFleetNode extends FleetNode {
  /** True khi node đang drain (không nhận run mới). */
  draining?: boolean;
  /** Lý do drain (khi draining = true). */
  drainReason?: string;
  /** Epoch ms bắt đầu drain. */
  drainedAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function newMaintenanceId(): string {
  return `fm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** True khi node đang drain (field optional — node cũ mặc định không drain). */
export function isNodeDraining(node: FleetNode): boolean {
  return (node as DrainingFleetNode).draining === true;
}

/** Gắn cờ drain cho node (node chưa đăng ký → throw; đã drain → throw rõ). */
export function drainFleetNode(
  fleetRoot: string,
  nodeId: string,
  reason: string,
  at = Date.now(),
): FleetNode {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('drainFleetNode needs a non-empty reason.');
  }
  const nodes = loadFleetNodes(fleetRoot);
  const index = nodes.findIndex((n) => n.id === nodeId);
  if (index === -1) throw new Error(`fleet node "${nodeId}" is not registered.`);
  if (isNodeDraining(nodes[index])) {
    throw new Error(`fleet node "${nodes[index].hostname}" is already draining.`);
  }
  const updated: FleetNode = {
    ...nodes[index],
    draining: true,
    drainReason: reason.trim().slice(0, 500),
    drainedAt: at,
    updatedAt: at,
  } as FleetNode;
  nodes[index] = updated;
  saveFleetNodes(fleetRoot, nodes);
  return updated;
}

/** Gỡ cờ drain của node (node không drain → throw rõ). */
export function undrainFleetNode(fleetRoot: string, nodeId: string, at = Date.now()): FleetNode {
  const nodes = loadFleetNodes(fleetRoot);
  const index = nodes.findIndex((n) => n.id === nodeId);
  if (index === -1) throw new Error(`fleet node "${nodeId}" is not registered.`);
  if (!isNodeDraining(nodes[index])) {
    throw new Error(`fleet node "${nodes[index].hostname}" is not draining.`);
  }
  const { draining: _draining, drainReason: _reason, drainedAt: _at, ...rest } = nodes[index] as DrainingFleetNode;
  const updated: FleetNode = { ...rest, updatedAt: at };
  nodes[index] = updated;
  saveFleetNodes(fleetRoot, nodes);
  return updated;
}

/**
 * Đưa các run (scheduled/running) của node đang drain về queued để
 * schedule lại sang node khác. Run scheduled nhưng chưa claim thì về
 * queued ngay; run đang running thì cũng về queued (lần chạy dở đó
 * vẫn tính là 1 lần thử — attempts giữ nguyên). Trả về danh sách đã
 * đưa về hàng đợi. Node không drain → trả [] (không làm gì).
 */
export function requeueDrainedNodeRuns(fleetRoot: string, nodeId: string, at = Date.now()): BotRun[] {
  const nodes = loadFleetNodes(fleetRoot);
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`fleet node "${nodeId}" is not registered.`);
  if (!isNodeDraining(node)) return [];
  const runs = loadBotRuns(fleetRoot);
  const requeued: BotRun[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if ((run.status !== 'scheduled' && run.status !== 'running') || run.nodeId !== nodeId) continue;
    const updated: BotRun = {
      ...run,
      status: 'queued',
      nodeId: null,
      scheduledAt: null,
      startedAt: null,
      nextAttemptAt: null,
      history: [...run.history, { at, event: 'requeued', nodeId, detail: 'node draining for maintenance, back to queue.' }],
    };
    runs[i] = updated;
    requeued.push(updated);
  }
  if (requeued.length > 0) saveBotRuns(fleetRoot, runs);
  return requeued;
}

/** Đường dẫn file cửa sổ bảo trì. */
export function getFleetMaintenancePath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_MAINTENANCE_FILE);
}

function parseMaintenanceWindow(raw: unknown, index: number): FleetMaintenanceWindow {
  if (!isRecord(raw)) throw new Error(`maintenance window at index ${index} is not an object.`);
  const { id, nodeId, startsAt, endsAt, reason, createdBy, createdAt } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error(`maintenance window at index ${index} needs a non-empty id.`);
  if (typeof nodeId !== 'string' || nodeId.trim().length === 0) throw new Error(`maintenance window ${id} needs a non-empty nodeId.`);
  if (!Number.isInteger(startsAt) || !Number.isInteger(endsAt) || (endsAt as number) <= (startsAt as number)) {
    throw new Error(`maintenance window ${id} needs integer startsAt < endsAt.`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error(`maintenance window ${id} needs a non-empty reason.`);
  if (typeof createdBy !== 'string' || createdBy.trim().length === 0) throw new Error(`maintenance window ${id} needs a non-empty createdBy.`);
  if (!Number.isInteger(createdAt)) throw new Error(`maintenance window ${id} needs an integer createdAt.`);
  return {
    id: id as string,
    nodeId: nodeId as string,
    startsAt: startsAt as number,
    endsAt: endsAt as number,
    reason: reason as string,
    createdBy: createdBy as string,
    createdAt: createdAt as number,
  };
}

/** Đọc các cửa sổ bảo trì (file chưa có → rỗng; file hỏng → throw rõ). */
export function loadMaintenanceWindows(fleetRoot: string): FleetMaintenanceWindow[] {
  const filePath = getFleetMaintenancePath(fleetRoot);
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
    throw new Error(`maintenance file ${filePath} is not valid JSON — refusing to guess; fix or remove it.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`maintenance file ${filePath} must contain a JSON array.`);
  return parsed.map((entry, index) => parseMaintenanceWindow(entry, index));
}

/** Ghi các cửa sổ bảo trì (atomic: tmp + rename, mode 0600). */
export function saveMaintenanceWindows(fleetRoot: string, windows: FleetMaintenanceWindow[]): void {
  fs.mkdirSync(fleetRoot, { recursive: true });
  const filePath = getFleetMaintenancePath(fleetRoot);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(windows, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Filesystem không hỗ trợ chmod — bỏ qua.
  }
}

/** Validate đầu vào đặt cửa sổ bảo trì (throw khi sai). */
export function validateMaintenanceInput(raw: unknown): ScheduleMaintenanceInput {
  if (!isRecord(raw)) throw new Error('maintenance input must be an object.');
  const { id, nodeId, startsAt, endsAt, reason, createdBy } = raw;
  if (id !== undefined && (typeof id !== 'string' || id.trim().length === 0)) {
    throw new Error('maintenance id must be a non-empty string when given.');
  }
  if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
    throw new Error('maintenance needs a non-empty nodeId.');
  }
  if (!Number.isInteger(startsAt) || !Number.isInteger(endsAt) || (endsAt as number) <= (startsAt as number)) {
    throw new Error('maintenance needs integer startsAt < endsAt.');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('maintenance needs a non-empty reason.');
  }
  if (createdBy !== undefined && (typeof createdBy !== 'string' || createdBy.trim().length === 0)) {
    throw new Error('maintenance createdBy must be a non-empty string when given.');
  }
  return {
    ...(id !== undefined ? { id } : {}),
    nodeId: nodeId as string,
    startsAt: startsAt as number,
    endsAt: endsAt as number,
    reason: (reason as string).trim(),
    ...(createdBy !== undefined ? { createdBy: createdBy as string } : {}),
  };
}

/**
 * Đặt một cửa sổ bảo trì cho node. Node chưa đăng ký → throw.
 * Cửa sổ chồng lấn với cửa sổ đã có của cùng node → throw (một node
 * không có 2 lịch bảo trì chồng nhau — tránh drain 2 lần).
 */
export function scheduleMaintenanceWindow(
  fleetRoot: string,
  input: ScheduleMaintenanceInput,
  at = Date.now(),
): FleetMaintenanceWindow {
  const valid = validateMaintenanceInput(input);
  const nodes = loadFleetNodes(fleetRoot);
  if (!nodes.some((n) => n.id === valid.nodeId)) {
    throw new Error(`fleet node "${valid.nodeId}" is not registered.`);
  }
  const windows = loadMaintenanceWindows(fleetRoot);
  const id = valid.id ?? newMaintenanceId();
  if (windows.some((w) => w.id === id)) throw new Error(`maintenance window id "${id}" already exists.`);
  const overlap = windows.some(
    (w) => w.nodeId === valid.nodeId && valid.startsAt < w.endsAt && w.startsAt < valid.endsAt,
  );
  if (overlap) {
    throw new Error(`maintenance window overlaps an existing window for node "${valid.nodeId}".`);
  }
  const window: FleetMaintenanceWindow = {
    id,
    nodeId: valid.nodeId,
    startsAt: valid.startsAt,
    endsAt: valid.endsAt,
    reason: valid.reason,
    createdBy: valid.createdBy ?? 'admin',
    createdAt: at,
  };
  saveMaintenanceWindows(fleetRoot, [...windows, window]);
  return window;
}

/** Huỷ một cửa sổ bảo trì (không có → throw). */
export function cancelMaintenanceWindow(fleetRoot: string, windowId: string): FleetMaintenanceWindow {
  const windows = loadMaintenanceWindows(fleetRoot);
  const found = windows.find((w) => w.id === windowId);
  if (!found) throw new Error(`maintenance window "${windowId}" does not exist.`);
  saveMaintenanceWindows(fleetRoot, windows.filter((w) => w.id !== windowId));
  return found;
}

/** Các cửa sổ bảo trì đang diễn ra tại `now` (startsAt <= now < endsAt). */
export function maintenanceDueNow(
  windows: FleetMaintenanceWindow[],
  now = Date.now(),
): FleetMaintenanceWindow[] {
  return windows
    .filter((w) => w.startsAt <= now && now < w.endsAt)
    .sort((a, b) => a.startsAt - b.startsAt);
}

/** Các node đang trong cửa sổ bảo trì tại `now` (theo id node). */
export function nodesInMaintenance(
  fleetRoot: string,
  now = Date.now(),
): Array<{ node: FleetNode; window: FleetMaintenanceWindow }> {
  const nodes = loadFleetNodes(fleetRoot);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Array<{ node: FleetNode; window: FleetMaintenanceWindow }> = [];
  for (const window of maintenanceDueNow(loadMaintenanceWindows(fleetRoot), now)) {
    const node = byId.get(window.nodeId);
    if (node) out.push({ node, window });
  }
  return out;
}

/** Dọn các cửa sổ bảo trì đã kết thúc (endsAt <= now), trả về số đã dọn. */
export function pruneMaintenanceWindows(fleetRoot: string, now = Date.now()): number {
  const windows = loadMaintenanceWindows(fleetRoot);
  const kept = windows.filter((w) => w.endsAt > now);
  const pruned = windows.length - kept.length;
  if (pruned > 0) saveMaintenanceWindows(fleetRoot, kept);
  return pruned;
}
