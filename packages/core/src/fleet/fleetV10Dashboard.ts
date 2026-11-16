/**
 * Fleet v10 — ACP Control Center extension: fleet dashboard (v1.13, Doi T6).
 *
 * Tang tren ACP Control Center (`acp/control/manager.ts`, v1.12) va
 * fleet dashboard v8 (`fleetV8Dashboard.ts`): Control Center hien tai
 * quan ly agent da dang ky (budget + usage + lifecycle qua
 * ExternalAgentManager) nhung chi nhin tung agent rieng le; dashboard
 * v8 tong hop node/bot/campaign nhung khong co dieu khien tu xa va
 * khong xem log truc tiep. Module nay them lop dieu khien fleet:
 *
 * - Trang thai runtime cua agent: `stopped -> running -> paused ->
 *   running | stopped`, `error` chi thoat bang `start`/`stop`. May
 *   trang thai la ham thuan (`applyFleetV10ControlAction`) — chuyen
 *   doi khong hop le bi tu choi ro rang thay vi im lang.
 * - Dashboard trang thai fleet: tong hop tu danh sach agent runtime
 *   + hang doi + tai nguyen host + muc su dung theo user — ham thuan
 *   `buildFleetV10Dashboard`, khong doc file, khong cham mang. Host
 *   chi can thu thap dau vao roi goi ham.
 * - Dieu khien tu xa: lenh `start` / `stop` / `pause` / `resume` kem
 *   actor (user) + ly do; moi lenh hop le sinh mot su kien dieu
 *   khien de host ghi audit (audit that nam o `fleetV10Users.ts` /
 *   `fleet/audit.ts`, module nay chi tra ve su kien).
 * - Xem log truc tiep: `readFleetV10LogTail` doc N dong cuoi cua mot
 *   file log (gioi han so byte doc de khong doc het file log lon),
 *   tra ve kem vi tri byte de UI phan trang / poll phan moi.
 * - Canh bao: agent khong heartbeat qua nguong, hang doi doi qua
 *   lau, tai nguyen vuot nguong, user vuot quota — deu tinh tu du
 *   lieu dau vao, khong doan.
 *
 * Khong spawn process, khong mo port, khong goi mang. Tat ca file
 * log doc qua duong dan tuyet doi do host cung cap (host chiu trach
 * nhiem gioi han trong thu muc fleet).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Trang thai runtime cua mot agent trong fleet. */
export type FleetV10AgentRuntimeStatus = 'stopped' | 'running' | 'paused' | 'error';

export const FLEET_V10_AGENT_RUNTIME_STATUSES: readonly FleetV10AgentRuntimeStatus[] = [
  'stopped',
  'running',
  'paused',
  'error',
];

/** Trang thai runtime cua mot agent (dau vao cho dashboard). */
export interface FleetV10AgentRuntimeState {
  /** Id agent (bot id). */
  agentId: string;
  /** Ten hien thi. */
  name: string;
  /** User so huu agent. */
  ownerUserId: string;
  status: FleetV10AgentRuntimeStatus;
  /** Epoch ms bat dau lan chay hien tai (null = khong chay). */
  startedAt: number | null;
  /** Epoch ms heartbeat gan nhat (null = chua co). */
  lastHeartbeatAt: number | null;
  /** CPU dang dung (core). */
  cpuCores: number;
  /** RAM dang dung (byte). */
  ramBytes: number;
  /** So cong viec dang cho trong hang doi cua agent. */
  queueDepth: number;
  /** Mo ta cong viec dang chay (neu co). */
  currentTask?: string;
  /** Loi gan nhat (chi khi status = error). */
  lastError?: string;
  /** So lan khoi dong lai. */
  restarts: number;
}

/** Lenh dieu khien agent tu xa. */
export type FleetV10ControlAction = 'start' | 'stop' | 'pause' | 'resume';

export const FLEET_V10_CONTROL_ACTIONS: readonly FleetV10ControlAction[] = [
  'start',
  'stop',
  'pause',
  'resume',
];

/** Su kien dieu khien sinh ra tu mot lenh hop le (host ghi audit). */
export interface FleetV10ControlEvent {
  agentId: string;
  action: FleetV10ControlAction;
  fromStatus: FleetV10AgentRuntimeStatus;
  toStatus: FleetV10AgentRuntimeStatus;
  actorUserId: string;
  reason: string;
  at: number;
}

/** Ket qua ap dung mot lenh dieu khien (ham thuan). */
export type FleetV10ControlResult =
  | { ok: true; state: FleetV10AgentRuntimeState; event: FleetV10ControlEvent }
  | { ok: false; state: FleetV10AgentRuntimeState; error: string };

/** Trang thai hang doi fleet (dau vao cho dashboard). */
export interface FleetV10QueueSnapshot {
  waiting: number;
  running: number;
  doneLast24h: number;
  failedLast24h: number;
  /** Epoch ms muc cho lau nhat dang doi (null = khong co muc cho). */
  oldestWaitingAt: number | null;
}

/** Tai nguyen host (dau vao cho dashboard). */
export interface FleetV10HostResources {
  cpuCoresTotal: number;
  cpuCoresUsed: number;
  ramBytesTotal: number;
  ramBytesUsed: number;
  diskBytesTotal: number;
  diskBytesUsed: number;
}

/** Muc su dung cua mot user (dau vao cho dashboard). */
export interface FleetV10DashboardUserRow {
  userId: string;
  agents: number;
  runningAgents: number;
  queueDepth: number;
  cpuCores: number;
  ramBytes: number;
}

/** Mot canh bao tren dashboard. */
export interface FleetV10DashboardAlert {
  level: 'warning' | 'critical';
  kind: 'stale-heartbeat' | 'queue-waiting' | 'resource-high' | 'agent-error';
  agentId?: string;
  message: string;
}

/** Snapshot dashboard fleet (dau ra cho UI / tool). */
export interface FleetV10DashboardSnapshot {
  at: number;
  agentsTotal: number;
  agentsRunning: number;
  agentsPaused: number;
  agentsStopped: number;
  agentsError: number;
  queue: FleetV10QueueSnapshot;
  resources: FleetV10HostResources & {
    cpuUsedPercent: number;
    ramUsedPercent: number;
    diskUsedPercent: number;
  };
  users: FleetV10DashboardUserRow[];
  alerts: FleetV10DashboardAlert[];
  agents: FleetV10AgentRuntimeState[];
}

/** Nguong canh bao mac dinh cua dashboard. */
export interface FleetV10DashboardThresholds {
  /** Heartbeat qua N ms thi coi la stale. */
  staleHeartbeatMs: number;
  /** Muc cho lau hon N ms thi canh bao. */
  queueWaitWarnMs: number;
  /** Tai nguyen vuot N% thi canh bao. */
  resourceWarnPercent: number;
}

export const DEFAULT_FLEET_V10_DASHBOARD_THRESHOLDS: FleetV10DashboardThresholds = {
  staleHeartbeatMs: 5 * 60 * 1000,
  queueWaitWarnMs: 10 * 60 * 1000,
  resourceWarnPercent: 80,
};

/** Ket qua doc duoi file log. */
export interface FleetV10LogTail {
  /** Duong dan file da doc. */
  path: string;
  /** Cac dong tra ve (khong bao gom ky tu xuong dong). */
  lines: string[];
  /** Tong so byte cua file luc doc. */
  fileSizeBytes: number;
  /** Byte bat dau cua vung da doc (de poll phan moi). */
  startByte: number;
  /** true = file co nhieu hon so dong yeu cau (bi cat). */
  truncated: boolean;
}

// --- Dieu khien agent -----------------------------------------------------------

/** Bang chuyen doi trang thai hop le cho moi lenh. */
export const FLEET_V10_CONTROL_TRANSITIONS: Record<
  FleetV10ControlAction,
  Partial<Record<FleetV10AgentRuntimeStatus, FleetV10AgentRuntimeStatus>>
> = {
  start: { stopped: 'running', error: 'running' },
  stop: { running: 'stopped', paused: 'stopped', error: 'stopped' },
  pause: { running: 'paused' },
  resume: { paused: 'running' },
};

/** Tao trang thai runtime mac dinh cho mot agent moi. */
export function createFleetV10AgentRuntimeState(
  agentId: string,
  name: string,
  ownerUserId: string,
): FleetV10AgentRuntimeState {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new Error('agent runtime state needs a non-empty agentId.');
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('agent runtime state needs a non-empty name.');
  }
  if (typeof ownerUserId !== 'string' || ownerUserId.trim().length === 0) {
    throw new Error('agent runtime state needs a non-empty ownerUserId.');
  }
  return {
    agentId: agentId.trim(),
    name: name.trim(),
    ownerUserId: ownerUserId.trim(),
    status: 'stopped',
    startedAt: null,
    lastHeartbeatAt: null,
    cpuCores: 0,
    ramBytes: 0,
    queueDepth: 0,
    restarts: 0,
  };
}

/**
 * Ap dung mot lenh dieu khien len trang thai agent — ham thuan.
 * Lenh khong hop le (vd `pause` khi agent dang `stopped`) tra ve
 * `{ ok: false }` kem ly do, khong doi trang thai.
 */
export function applyFleetV10ControlAction(
  state: FleetV10AgentRuntimeState,
  action: FleetV10ControlAction,
  actorUserId: string,
  reason: string,
  now: number = Date.now(),
): FleetV10ControlResult {
  if (!FLEET_V10_CONTROL_ACTIONS.includes(action)) {
    return { ok: false, state, error: `unknown control action: ${String(action)}` };
  }
  if (typeof actorUserId !== 'string' || actorUserId.trim().length === 0) {
    return { ok: false, state, error: 'control action needs a non-empty actorUserId.' };
  }
  const toStatus = FLEET_V10_CONTROL_TRANSITIONS[action][state.status];
  if (toStatus === undefined) {
    return {
      ok: false,
      state,
      error: `cannot ${action} agent ${state.agentId} while ${state.status}`,
    };
  }
  const next: FleetV10AgentRuntimeState = {
    ...state,
    status: toStatus,
    startedAt: toStatus === 'running' && state.status !== 'paused' ? now : state.startedAt,
    ...(toStatus === 'running' && state.status === 'error'
      ? { restarts: state.restarts + 1, lastError: undefined }
      : {}),
    ...(toStatus === 'stopped' ? { startedAt: null, currentTask: undefined, queueDepth: 0 } : {}),
  };
  return {
    ok: true,
    state: next,
    event: {
      agentId: state.agentId,
      action,
      fromStatus: state.status,
      toStatus,
      actorUserId: actorUserId.trim(),
      reason: reason.trim(),
      at: now,
    },
  };
}

/** Danh dau agent loi (chuyen sang `error`, giu lai thong tin chay). */
export function markFleetV10AgentError(
  state: FleetV10AgentRuntimeState,
  error: string,
  now: number = Date.now(),
): FleetV10AgentRuntimeState {
  if (typeof error !== 'string' || error.trim().length === 0) {
    throw new Error('agent error needs a non-empty message.');
  }
  return { ...state, status: 'error', lastError: error.trim(), lastHeartbeatAt: now };
}

/** Cap nhat heartbeat + muc su dung cua agent (khong doi trang thai). */
export function heartbeatFleetV10Agent(
  state: FleetV10AgentRuntimeState,
  input: { cpuCores: number; ramBytes: number; queueDepth: number; currentTask?: string },
  now: number = Date.now(),
): FleetV10AgentRuntimeState {
  if (!Number.isFinite(input.cpuCores) || input.cpuCores < 0) {
    throw new Error('heartbeat cpuCores must be a number >= 0.');
  }
  if (!Number.isFinite(input.ramBytes) || input.ramBytes < 0) {
    throw new Error('heartbeat ramBytes must be a number >= 0.');
  }
  if (!Number.isInteger(input.queueDepth) || input.queueDepth < 0) {
    throw new Error('heartbeat queueDepth must be a non-negative integer.');
  }
  return {
    ...state,
    lastHeartbeatAt: now,
    cpuCores: input.cpuCores,
    ramBytes: input.ramBytes,
    queueDepth: input.queueDepth,
    ...(input.currentTask !== undefined ? { currentTask: input.currentTask } : {}),
  };
}

// --- Dashboard ------------------------------------------------------------------

function percent(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/**
 * Xay snapshot dashboard fleet — ham thuan.
 * Canh bao duoc tinh tu du lieu dau vao:
 * - agent `running` nhung heartbeat qua `staleHeartbeatMs` -> stale.
 * - agent `error` -> critical.
 * - muc cho lau nhat vuot `queueWaitWarnMs` -> warning.
 * - CPU/RAM/dia vuot `resourceWarnPercent` -> warning.
 */
export function buildFleetV10Dashboard(
  input: {
    agents: readonly FleetV10AgentRuntimeState[];
    queue: FleetV10QueueSnapshot;
    resources: FleetV10HostResources;
  },
  now: number = Date.now(),
  thresholds: FleetV10DashboardThresholds = DEFAULT_FLEET_V10_DASHBOARD_THRESHOLDS,
): FleetV10DashboardSnapshot {
  const agents = [...input.agents];
  let running = 0;
  let paused = 0;
  let stopped = 0;
  let error = 0;
  const byUser = new Map<string, FleetV10DashboardUserRow>();
  const alerts: FleetV10DashboardAlert[] = [];
  for (const a of agents) {
    if (a.status === 'running') running++;
    else if (a.status === 'paused') paused++;
    else if (a.status === 'stopped') stopped++;
    else error++;
    const row = byUser.get(a.ownerUserId) ?? {
      userId: a.ownerUserId,
      agents: 0,
      runningAgents: 0,
      queueDepth: 0,
      cpuCores: 0,
      ramBytes: 0,
    };
    row.agents++;
    if (a.status === 'running') row.runningAgents++;
    row.queueDepth += a.queueDepth;
    row.cpuCores += a.cpuCores;
    row.ramBytes += a.ramBytes;
    byUser.set(a.ownerUserId, row);
    if (a.status === 'error') {
      alerts.push({
        level: 'critical',
        kind: 'agent-error',
        agentId: a.agentId,
        message: `Agent ${a.name} is in error: ${a.lastError ?? 'unknown error'}`,
      });
    } else if (a.status === 'running' && a.lastHeartbeatAt !== null) {
      if (now - a.lastHeartbeatAt > thresholds.staleHeartbeatMs) {
        alerts.push({
          level: 'warning',
          kind: 'stale-heartbeat',
          agentId: a.agentId,
          message: `Agent ${a.name} has no heartbeat for ${now - a.lastHeartbeatAt}ms`,
        });
      }
    }
  }
  if (input.queue.oldestWaitingAt !== null && now - input.queue.oldestWaitingAt > thresholds.queueWaitWarnMs) {
    alerts.push({
      level: 'warning',
      kind: 'queue-waiting',
      message: `Oldest queued job has waited ${now - input.queue.oldestWaitingAt}ms`,
    });
  }
  const cpuUsedPercent = percent(input.resources.cpuCoresUsed, input.resources.cpuCoresTotal);
  const ramUsedPercent = percent(input.resources.ramBytesUsed, input.resources.ramBytesTotal);
  const diskUsedPercent = percent(input.resources.diskBytesUsed, input.resources.diskBytesTotal);
  if (cpuUsedPercent >= thresholds.resourceWarnPercent) {
    alerts.push({ level: 'warning', kind: 'resource-high', message: `CPU usage ${cpuUsedPercent.toFixed(1)}%` });
  }
  if (ramUsedPercent >= thresholds.resourceWarnPercent) {
    alerts.push({ level: 'warning', kind: 'resource-high', message: `RAM usage ${ramUsedPercent.toFixed(1)}%` });
  }
  if (diskUsedPercent >= thresholds.resourceWarnPercent) {
    alerts.push({ level: 'warning', kind: 'resource-high', message: `Disk usage ${diskUsedPercent.toFixed(1)}%` });
  }
  return {
    at: now,
    agentsTotal: agents.length,
    agentsRunning: running,
    agentsPaused: paused,
    agentsStopped: stopped,
    agentsError: error,
    queue: { ...input.queue },
    resources: {
      ...input.resources,
      cpuUsedPercent,
      ramUsedPercent,
      diskUsedPercent,
    },
    users: [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId)),
    alerts,
    agents: agents.sort((a, b) => a.agentId.localeCompare(b.agentId)),
  };
}

/** Tom tat 1 dong cho dashboard (de log / hien thi nhanh). */
export function summarizeFleetV10Dashboard(snapshot: FleetV10DashboardSnapshot): string {
  const alerts = snapshot.alerts.length === 0
    ? 'no alerts'
    : `${snapshot.alerts.length} alert(s): ${snapshot.alerts.map((a) => a.message).join('; ')}`;
  return (
    `Fleet: ${snapshot.agentsRunning}/${snapshot.agentsTotal} agents running ` +
    `(${snapshot.agentsPaused} paused, ${snapshot.agentsError} error), ` +
    `queue ${snapshot.queue.waiting} waiting / ${snapshot.queue.running} running, ` +
    `CPU ${snapshot.resources.cpuUsedPercent.toFixed(1)}%, ` +
    `RAM ${snapshot.resources.ramUsedPercent.toFixed(1)}%, ${alerts}.`
  );
}

// --- Log tail ---------------------------------------------------------------------

/** Gioi han doc: toi da 1 MB cuoi file cho 1 lan goi. */
export const FLEET_V10_LOG_TAIL_MAX_BYTES = 1024 * 1024;
/** Gioi han dong mac dinh tra ve. */
export const FLEET_V10_LOG_TAIL_DEFAULT_LINES = 100;
/** File luu trang thai runtime cua agent trong fleet root. */
export const FLEET_V10_AGENT_RUNTIME_FILE = 'fleet-agent-runtime-v113.json';

/**
 * Doc N dong cuoi cua mot file log.
 * Chi doc toi da `maxBytes` cuoi file (mac dinh 1 MB) de khong doc
 * het file log lon; tra ve kem `startByte` de UI poll phan moi.
 * File khong ton tai -> tra ve danh sach rong (khong nem loi).
 */
export function readFleetV10LogTail(
  logPath: string,
  maxLines: number = FLEET_V10_LOG_TAIL_DEFAULT_LINES,
  maxBytes: number = FLEET_V10_LOG_TAIL_MAX_BYTES,
): FleetV10LogTail {
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error('log tail maxLines must be an integer >= 1.');
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('log tail maxBytes must be an integer >= 1.');
  }
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return { path: logPath, lines: [], fileSizeBytes: 0, startByte: 0, truncated: false };
  }
  if (size === 0) {
    return { path: logPath, lines: [], fileSizeBytes: 0, startByte: 0, truncated: false };
  }
  const readBytes = Math.min(size, maxBytes);
  const startByte = size - readBytes;
  const fd = fs.openSync(logPath, 'r');
  try {
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, startByte);
    const text = buf.toString('utf8');
    const allLines = text.split('\n');
    // Dong dau tien co the bi cat do bat dau giua dong.
    if (startByte > 0 && allLines.length > 0) allLines.shift();
    // Bo dong rong cuoi do file ket thuc bang newline.
    while (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
    const truncated = allLines.length > maxLines;
    const lines = truncated ? allLines.slice(allLines.length - maxLines) : allLines;
    return { path: logPath, lines, fileSizeBytes: size, startByte, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

// --- Persistence trang thai runtime -------------------------------------------

/** Duong dan file luu trang thai runtime agent. */
export function getFleetV10AgentRuntimePath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V10_AGENT_RUNTIME_FILE);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Validate mot trang thai runtime agent (nem loi khi truong nao hong). */
export function validateFleetV10AgentRuntimeState(raw: unknown): FleetV10AgentRuntimeState {
  if (!isRecord(raw)) throw new Error('agent runtime state must be an object.');
  const {
    agentId, name, ownerUserId, status, startedAt, lastHeartbeatAt,
    cpuCores, ramBytes, queueDepth, currentTask, lastError, restarts,
  } = raw;
  if (!isNonEmptyString(agentId)) throw new Error('agent runtime state needs a non-empty agentId.');
  if (!isNonEmptyString(name)) throw new Error('agent runtime state needs a non-empty name.');
  if (!isNonEmptyString(ownerUserId)) throw new Error('agent runtime state needs a non-empty ownerUserId.');
  if (!FLEET_V10_AGENT_RUNTIME_STATUSES.includes(status as FleetV10AgentRuntimeStatus)) {
    throw new Error(`agent runtime status must be one of: ${FLEET_V10_AGENT_RUNTIME_STATUSES.join(', ')}.`);
  }
  if (startedAt !== null && !isNonNegativeInt(startedAt)) throw new Error('startedAt must be null or a non-negative integer.');
  if (lastHeartbeatAt !== null && !isNonNegativeInt(lastHeartbeatAt)) throw new Error('lastHeartbeatAt must be null or a non-negative integer.');
  if (typeof cpuCores !== 'number' || !Number.isFinite(cpuCores) || cpuCores < 0) throw new Error('cpuCores must be a number >= 0.');
  if (typeof ramBytes !== 'number' || !Number.isFinite(ramBytes) || ramBytes < 0) throw new Error('ramBytes must be a number >= 0.');
  if (!isNonNegativeInt(queueDepth)) throw new Error('queueDepth must be a non-negative integer.');
  if (currentTask !== undefined && !isNonEmptyString(currentTask)) throw new Error('currentTask must be a non-empty string.');
  if (lastError !== undefined && !isNonEmptyString(lastError)) throw new Error('lastError must be a non-empty string.');
  if (!isNonNegativeInt(restarts)) throw new Error('restarts must be a non-negative integer.');
  return {
    agentId: agentId as string,
    name: name as string,
    ownerUserId: ownerUserId as string,
    status: status as FleetV10AgentRuntimeStatus,
    startedAt: startedAt as number | null,
    lastHeartbeatAt: lastHeartbeatAt as number | null,
    cpuCores: cpuCores as number,
    ramBytes: ramBytes as number,
    queueDepth: queueDepth as number,
    ...(currentTask !== undefined ? { currentTask: currentTask as string } : {}),
    ...(lastError !== undefined ? { lastError: lastError as string } : {}),
    restarts: restarts as number,
  };
}

/** Doc trang thai runtime agent tu fleet root (file hong/missing = rong). */
export function loadFleetV10AgentRuntimeStates(fleetRoot: string): FleetV10AgentRuntimeState[] {
  let text: string;
  try {
    text = fs.readFileSync(getFleetV10AgentRuntimePath(fleetRoot), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FleetV10AgentRuntimeState[] = [];
  for (const item of parsed) {
    try {
      out.push(validateFleetV10AgentRuntimeState(item));
    } catch {
      // Ban ghi hong thi bo qua thay vi lam hong ca file.
    }
  }
  return out;
}

/** Ghi trang thai runtime agent xuong fleet root (atomic, mode 0600). */
export function saveFleetV10AgentRuntimeStates(
  fleetRoot: string,
  states: readonly FleetV10AgentRuntimeState[],
): void {
  const filePath = getFleetV10AgentRuntimePath(fleetRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(states.map((s) => validateFleetV10AgentRuntimeState(s)), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows khong co chmod POSIX — bo qua.
  }
}
