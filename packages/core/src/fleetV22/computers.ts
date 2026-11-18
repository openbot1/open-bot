/**
 * Per-bot computers cho fleet v22 (v1.35, Đội T6).
 *
 * Ý tưởng (học từ OpenMausBot — chỉ học ý tưởng, không copy): mỗi bot
 * có MỘT máy tính riêng để chạy — bot không chạy lẫn vào máy host của
 * user và không nhìn thấy máy tính của bot khác. Ba loại máy tính:
 *
 * - `cloud-linux-desktop`: desktop Linux trên cloud (nhà cung cấp bên
 *   ngoài) — bot chạy xa, host local nhẹ, cần key/tunnel của user.
 * - `local-vm`: máy ảo local (microVM/VM trên chính máy user) — cách
 *   ly mạnh, tốn tài nguyên local, không cần mạng ngoài.
 * - `own-computer`: chạy trên chính máy user (host) nhưng trong
 *   sandbox tier của bot — nhẹ nhất, cách ly yếu nhất.
 *
 * Mỗi computer gắn với 1 user (owner) + 1 bot, giữ một phân vùng tài
 * nguyên (đã cấp qua `probes.ts` — computer không tự xin thêm), và có
 * vòng đời riêng: provisioning → ready → running → paused → draining
 * → stopped / failed. Computer `failed` không tự chạy lại — admin/
 * operator phải xem lý do rồi retry rõ ràng.
 *
 * Module thuần: không spawn VM thật, không chạm cloud — host/provisioner
 * thật đọc state ở đây rồi thực thi; module này giữ luật + tính toán.
 */

import type { FleetV22ShareResult } from './probes';

/** Loại máy tính của bot. */
export type FleetV22ComputerKind = 'cloud-linux-desktop' | 'local-vm' | 'own-computer';

/** Mọi loại máy tính. */
export const FLEET_V22_COMPUTER_KINDS: readonly FleetV22ComputerKind[] = [
  'cloud-linux-desktop',
  'local-vm',
  'own-computer',
];

/** Trạng thái vòng đời của computer. */
export type FleetV22ComputerStatus =
  | 'provisioning'
  | 'ready'
  | 'running'
  | 'paused'
  | 'draining'
  | 'stopped'
  | 'failed';

/** Mọi trạng thái vòng đời. */
export const FLEET_V22_COMPUTER_STATUSES: readonly FleetV22ComputerStatus[] = [
  'provisioning',
  'ready',
  'running',
  'paused',
  'draining',
  'stopped',
  'failed',
];

/** Trạng thái nào được tính là "đang giữ tài nguyên" (cấp rồi chưa trả). */
export const FLEET_V22_COMPUTER_HOLDING_STATUSES: readonly FleetV22ComputerStatus[] = [
  'provisioning',
  'ready',
  'running',
  'paused',
  'draining',
];

/** Mô tả ngắn từng loại máy tính (UI dùng i18n `fleet.v22.*`). */
export const FLEET_V22_COMPUTER_KIND_DESCRIPTION: Readonly<Record<FleetV22ComputerKind, string>> = {
  'cloud-linux-desktop': 'Desktop Linux trên cloud — bot chạy xa, máy local nhẹ, cần tài khoản cloud của user.',
  'local-vm': 'Máy ảo local (microVM) — kernel riêng, cách ly mạnh, tốn tài nguyên máy user.',
  'own-computer': 'Chạy trên chính máy user trong sandbox tier của bot — nhẹ nhất, cách ly yếu nhất.',
};

/** Mức cách ly tương đối của từng loại (0..2 — để so sánh, không phải tier sandbox). */
export const FLEET_V22_COMPUTER_ISOLATION: Readonly<Record<FleetV22ComputerKind, number>> = {
  'own-computer': 0,
  'local-vm': 1,
  'cloud-linux-desktop': 2,
};

/** Một máy tính của bot. */
export interface FleetV22BotComputer {
  /** Id duy nhất. */
  id: string;
  /** Id bot sở hữu computer này (1 bot — 1 computer đang hoạt động). */
  botId: string;
  /** Id user sở hữu bot (để kiểm tra quyền + tính quota). */
  ownerId: string;
  kind: FleetV22ComputerKind;
  status: FleetV22ComputerStatus;
  /** Tên hiển thị (vd `bot-ghi-chep-vm`). */
  name: string;
  /** Node fleet đặt computer này lên (null khi chưa đặt / cloud chưa gắn node). */
  nodeId: string | null;
  /** CPU đã cấp (core). */
  cpuCores: number;
  /** RAM đã cấp (byte). */
  ramBytes: number;
  /** Disk đã cấp (byte). */
  diskBytes: number;
  /** CPU đang dùng đo được (core) — null khi chưa đo. */
  cpuUsed: number | null;
  /** RAM đang dùng đo được (byte) — null khi chưa đo. */
  ramUsed: number | null;
  /** Disk đang dùng đo được (byte) — null khi chưa đo. */
  diskUsed: number | null;
  /** Lần cuối đo tài nguyên đang dùng (epoch ms) — null khi chưa đo. */
  lastMeasuredAt: number | null;
  /** Endpoint để điều khiển computer (vd `127.0.0.1:51234`, URL cloud) — null khi chưa có. */
  endpoint: string | null;
  /** Số lần provisioning thất bại liên tiếp (để backoff / dừng retry). */
  consecutiveFailures: number;
  /** Lý do fail/drain/stop gần nhất. */
  statusReason?: string;
  /** Khi computer được tạo (epoch ms). */
  createdAt: number;
  /** Khi computer đổi trạng thái lần cuối (epoch ms). */
  updatedAt: number;
}

/** Tạo computer mới (trạng thái ban đầu `provisioning`). */
export function createFleetV22BotComputer(input: {
  id: string;
  botId: string;
  ownerId: string;
  kind: FleetV22ComputerKind;
  name?: string;
  nodeId?: string | null;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  now?: number;
}): FleetV22BotComputer {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    botId: input.botId,
    ownerId: input.ownerId,
    kind: input.kind,
    status: 'provisioning',
    name: input.name ?? input.id,
    nodeId: input.nodeId ?? null,
    cpuCores: input.cpuCores,
    ramBytes: input.ramBytes,
    diskBytes: input.diskBytes,
    cpuUsed: null,
    ramUsed: null,
    diskUsed: null,
    lastMeasuredAt: null,
    endpoint: null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Vòng đời: chuyển trạng thái nào được phép?
// ---------------------------------------------------------------------------

/** Các chuyển trạng thái hợp lệ (từ → tới). Chuyển ngoài bảng = lỗi gọi. */
export const FLEET_V22_COMPUTER_TRANSITIONS: Readonly<Record<FleetV22ComputerStatus, readonly FleetV22ComputerStatus[]>> = {
  provisioning: ['ready', 'failed', 'stopped'],
  ready: ['running', 'paused', 'draining', 'stopped', 'failed'],
  running: ['paused', 'draining', 'stopped', 'failed'],
  paused: ['running', 'draining', 'stopped', 'failed'],
  draining: ['stopped', 'failed'],
  stopped: ['provisioning'],
  failed: ['provisioning', 'stopped'],
};

/** true khi chuyển từ `from` sang `to` được phép. */
export function computerTransitionAllowedV22(
  from: FleetV22ComputerStatus,
  to: FleetV22ComputerStatus,
): boolean {
  return (FLEET_V22_COMPUTER_TRANSITIONS[from] as readonly FleetV22ComputerStatus[]).includes(to);
}

/**
 * Chuyển trạng thái (trả về computer mới; chuyển không hợp lệ → throw
 * kèm bảng chuyển hợp lệ để caller sửa — không chuyển lén).
 */
export function transitionFleetV22Computer(
  computer: FleetV22BotComputer,
  to: FleetV22ComputerStatus,
  reason?: string,
  now: number = Date.now(),
): FleetV22BotComputer {
  if (!computerTransitionAllowedV22(computer.status, to)) {
    throw new Error(
      `Computer "${computer.id}" không chuyển được từ "${computer.status}" sang "${to}" ` +
        `(được phép: ${FLEET_V22_COMPUTER_TRANSITIONS[computer.status].join(', ') || 'không có'}).`,
    );
  }
  return {
    ...computer,
    status: to,
    updatedAt: now,
    ...(reason ? { statusReason: reason } : {}),
    ...(to === 'failed' ? { consecutiveFailures: computer.consecutiveFailures + 1 } : {}),
    ...(to === 'provisioning' ? { consecutiveFailures: 0 } : {}),
  };
}

/** Ghi nhận computer đã đo tài nguyên đang dùng (không đổi trạng thái). */
export function computerRecordUsageV22(
  computer: FleetV22BotComputer,
  usage: { cpuUsed: number; ramUsed: number; diskUsed: number },
  now: number = Date.now(),
): FleetV22BotComputer {
  return { ...computer, ...usage, lastMeasuredAt: now };
}

/** true khi computer đang giữ tài nguyên (cần trả lại khi stop/drain xong). */
export function computerHoldsResourcesV22(computer: FleetV22BotComputer): boolean {
  return (FLEET_V22_COMPUTER_HOLDING_STATUSES as readonly FleetV22ComputerStatus[]).includes(computer.status);
}

/** Tỉ lệ CPU đang dùng so với đã cấp (null khi chưa đo). */
export function computerCpuFractionV22(computer: FleetV22BotComputer): number | null {
  if (computer.cpuUsed === null || computer.cpuCores <= 0) return null;
  return Math.round((computer.cpuUsed / computer.cpuCores) * 1000) / 1000;
}

/** Tỉ lệ RAM đang dùng so với đã cấp (null khi chưa đo). */
export function computerRamFractionV22(computer: FleetV22BotComputer): number | null {
  if (computer.ramUsed === null || computer.ramBytes <= 0) return null;
  return Math.round((computer.ramUsed / computer.ramBytes) * 1000) / 1000;
}

/** Tỉ lệ disk đang dùng so với đã cấp (null khi chưa đo). */
export function computerDiskFractionV22(computer: FleetV22BotComputer): number | null {
  if (computer.diskUsed === null || computer.diskBytes <= 0) return null;
  return Math.round((computer.diskUsed / computer.diskBytes) * 1000) / 1000;
}

/** true khi computer dùng quá 90% tài nguyên đã cấp ở CPU hoặc RAM (cần tăng cấp hoặc giảm tải). */
export function computerIsPressuredV22(computer: FleetV22BotComputer): boolean {
  const cpu = computerCpuFractionV22(computer);
  const ram = computerRamFractionV22(computer);
  return (cpu !== null && cpu >= 0.9) || (ram !== null && ram >= 0.9);
}

// ---------------------------------------------------------------------------
// Registry computer trong bộ nhớ
// ---------------------------------------------------------------------------

/** Registry computer trong bộ nhớ — host giữ 1 instance cho cả fleet. */
export class FleetV22ComputerRegistry {
  private readonly computers = new Map<string, FleetV22BotComputer>();
  private readonly byBot = new Map<string, string>(); // botId -> computer id đang hoạt động

  /** Thêm computer (id trùng → throw; bot đã có computer đang hoạt động → throw). */
  add(computer: FleetV22BotComputer): void {
    if (this.computers.has(computer.id)) throw new Error(`Computer "${computer.id}" đã tồn tại trong fleet v22.`);
    if (computerHoldsResourcesV22(computer) && this.byBot.has(computer.botId)) {
      throw new Error(`Bot "${computer.botId}" đã có computer đang hoạt động ("${this.byBot.get(computer.botId)}").`);
    }
    this.computers.set(computer.id, structuredClone(computer));
    if (computerHoldsResourcesV22(computer)) this.byBot.set(computer.botId, computer.id);
  }

  /** Thay thế computer đã có (bot đổi computer → cập nhật chỉ mục byBot). */
  update(computer: FleetV22BotComputer): void {
    const existing = this.computers.get(computer.id);
    if (!existing) throw new Error(`Computer "${computer.id}" chưa có trong fleet v22.`);
    // Kiểm tra xung đột TRƯỚC khi ghi — throw thì registry giữ nguyên.
    if (computerHoldsResourcesV22(computer)) {
      const other = this.byBot.get(computer.botId);
      if (other !== undefined && other !== computer.id) {
        throw new Error(`Bot "${computer.botId}" đã có computer đang hoạt động ("${other}").`);
      }
    }
    if (computerHoldsResourcesV22(existing) && this.byBot.get(computer.botId) === computer.id) {
      this.byBot.delete(computer.botId);
    }
    this.computers.set(computer.id, structuredClone(computer));
    if (computerHoldsResourcesV22(computer)) {
      this.byBot.set(computer.botId, computer.id);
    }
  }

  /** Xoá computer (chỉ xoá được khi đã stopped — computer đang giữ tài nguyên thì không xoá lén). */
  remove(computerId: string): boolean {
    const existing = this.computers.get(computerId);
    if (!existing) return false;
    if (computerHoldsResourcesV22(existing)) {
      throw new Error(`Computer "${computerId}" đang "${existing.status}" (còn giữ tài nguyên) — stop/drain trước khi xoá.`);
    }
    if (this.byBot.get(existing.botId) === computerId) this.byBot.delete(existing.botId);
    return this.computers.delete(computerId);
  }

  get(computerId: string): FleetV22BotComputer | undefined {
    const c = this.computers.get(computerId);
    return c ? structuredClone(c) : undefined;
  }

  /** Computer đang hoạt động của một bot (undefined khi bot chưa có computer). */
  getByBot(botId: string): FleetV22BotComputer | undefined {
    const id = this.byBot.get(botId);
    return id ? this.get(id) : undefined;
  }

  list(): FleetV22BotComputer[] {
    return [...this.computers.values()].map((c) => structuredClone(c));
  }

  /** Computer của một user. */
  byOwner(ownerId: string): FleetV22BotComputer[] {
    return this.list().filter((c) => c.ownerId === ownerId);
  }

  /** Computer theo loại. */
  byKind(kind: FleetV22ComputerKind): FleetV22BotComputer[] {
    return this.list().filter((c) => c.kind === kind);
  }

  /** Computer theo trạng thái. */
  byStatus(status: FleetV22ComputerStatus): FleetV22BotComputer[] {
    return this.list().filter((c) => c.status === status);
  }

  /** Computer trên một node (để drain node thì liệt kê những computer này). */
  byNode(nodeId: string): FleetV22BotComputer[] {
    return this.list().filter((c) => c.nodeId === nodeId);
  }

  /** Tổng tài nguyên đã cấp cho các computer đang giữ tài nguyên. */
  totalsHolding(): { computers: number; cpuCores: number; ramBytes: number; diskBytes: number } {
    const holding = this.list().filter(computerHoldsResourcesV22);
    return {
      computers: holding.length,
      cpuCores: holding.reduce((s, c) => s + c.cpuCores, 0),
      ramBytes: holding.reduce((s, c) => s + c.ramBytes, 0),
      diskBytes: holding.reduce((s, c) => s + c.diskBytes, 0),
    };
  }

  get size(): number {
    return this.computers.size;
  }
}

// ---------------------------------------------------------------------------
// Cấp computer từ kết quả phân vùng probe
// ---------------------------------------------------------------------------

/**
 * Tạo computer từ một share đã được cấp (`partitionResourcesV22`):
 * share bị từ chối (granted=false) → throw, không tạo computer "nửa vời".
 */
export function computerFromGrantedShareV22(
  share: FleetV22ShareResult,
  input: { botId: string; ownerId: string; kind: FleetV22ComputerKind; name?: string; nodeId?: string | null; now?: number },
): FleetV22BotComputer {
  if (!share.granted) {
    throw new Error(`Không tạo được computer cho "${share.id}": ${share.reason ?? 'không được cấp tài nguyên.'}`);
  }
  return createFleetV22BotComputer({
    id: share.id,
    botId: input.botId,
    ownerId: input.ownerId,
    kind: input.kind,
    name: input.name,
    nodeId: input.nodeId,
    cpuCores: share.grantedCpuCores,
    ramBytes: share.grantedRamBytes,
    diskBytes: share.grantedDiskBytes,
    now: input.now,
  });
}

/** Validate computer từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV22Computer(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['computer phải là object.'];
  const c = input as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.trim().length === 0) errors.push('computer.id phải là chuỗi không rỗng.');
  if (typeof c.botId !== 'string' || c.botId.trim().length === 0) errors.push('computer.botId phải là chuỗi không rỗng.');
  if (typeof c.ownerId !== 'string' || c.ownerId.trim().length === 0) errors.push('computer.ownerId phải là chuỗi không rỗng.');
  if (typeof c.kind !== 'string' || !(FLEET_V22_COMPUTER_KINDS as readonly string[]).includes(c.kind)) {
    errors.push(`computer.kind phải là một trong: ${FLEET_V22_COMPUTER_KINDS.join(', ')}.`);
  }
  if (typeof c.status !== 'string' || !(FLEET_V22_COMPUTER_STATUSES as readonly string[]).includes(c.status)) {
    errors.push(`computer.status phải là một trong: ${FLEET_V22_COMPUTER_STATUSES.join(', ')}.`);
  }
  for (const field of ['cpuCores', 'ramBytes', 'diskBytes'] as const) {
    if (typeof c[field] !== 'number' || !Number.isFinite(c[field]) || (c[field] as number) <= 0) {
      errors.push(`computer.${field} phải là số > 0.`);
    }
  }
  return errors;
}
