/**
 * Probe phân vùng CPU/RAM/disk cho fleet v22 (v1.35, Đội T6).
 *
 * Fleet v21 biết node có bao nhiêu tài nguyên NHƯNG không đo thật —
 * node khai bao nhiêu thì tin bấy nhiêu. Fleet v22 đo thật rồi mới
 * chia: host chạy probe (đọc CPU/RAM/disk của máy) và tính phân vùng
 * cho từng bot/computer.
 *
 * NGUYÊN TẮC AN TOÀN (không làm hại máy user — luật cứng của module):
 * 1. Luôn giữ headroom cho host: không bao giờ cấp hết 100% CPU/RAM/
 *    disk — phần giữ lại mặc định 25% CPU, 2 GB RAM, 10% disk (tối
 *    thiểu 5 GB). Phân vùng chỉ chia phần CÒN LẠI sau headroom.
 * 2. Probe chỉ ĐO, không thay đổi gì: không kill process, không ghi
 *    file ngoài thư mục probe, không đổi giới hạn hệ thống.
 * 3. Số đo là ẢNH CHỤP tại một thời điểm (CPU dùng bao nhiêu % lúc đo)
 *    — module nói rõ độ tươi của số đo (age ms) và không giả vờ số đo
 *    cũ vẫn đúng.
 * 4. Mọi con số đều có nguồn: `source` ghi rõ đo bằng cách nào
 *    (`os` = Node os module, `manual` = host tự đưa số, `estimate` =
 *    ước lượng từ lần đo trước khi chưa đo được).
 *
 * Probe thật (đọc `os.cpus()` / `os.totalmem()` / `os.freemem()`) nằm
 * ở hàm `probeHostResourcesV22` — host gọi khi muốn đo; các hàm còn
 * lại thuần, tính toán trên số đo đã có nên test được không cần máy thật.
 */

import * as os from 'node:os';

/** Nguồn của một số đo. */
export type FleetV22ProbeSource = 'os' | 'manual' | 'estimate';

/** Một lần đo tài nguyên host (ảnh chụp tại `measuredAt`). */
export interface FleetV22HostProbe {
  /** Tổng CPU (core, có thể lẻ — os.cpus().length). */
  cpuCores: number;
  /** CPU đang dùng lúc đo (core, ước từ loadavg / cpu times). */
  cpuUsed: number;
  /** Tổng RAM (byte). */
  ramBytes: number;
  /** RAM đang dùng (byte). */
  ramUsed: number;
  /** Tổng disk (byte) của volume chứa `diskPath`. */
  diskBytes: number;
  /** Disk đang dùng (byte). */
  diskUsed: number;
  /** Đường dẫn volume đã đo disk (vd `/`). */
  diskPath: string;
  /** Lúc đo (epoch ms). */
  measuredAt: number;
  /** Số đo lấy từ đâu. */
  source: FleetV22ProbeSource;
}

/** Headroom giữ lại cho host — không bao giờ chia phần này cho bot. */
export interface FleetV22Headroom {
  /** Giữ lại bao nhiêu % CPU (0..1). */
  cpuFraction: number;
  /** Giữ lại tối thiểu bao nhiêu RAM (byte). */
  minRamBytes: number;
  /** Giữ lại bao nhiêu % disk (0..1). */
  diskFraction: number;
  /** Giữ lại tối thiểu bao nhiêu disk (byte). */
  minDiskBytes: number;
}

/** Headroom mặc định: 25% CPU, 2 GB RAM, 10% disk (tối thiểu 5 GB). */
export const DEFAULT_FLEET_V22_HEADROOM: FleetV22Headroom = {
  cpuFraction: 0.25,
  minRamBytes: 2 * 1024 ** 3,
  diskFraction: 0.1,
  minDiskBytes: 5 * 1024 ** 3,
};

/** Tài nguyên CÓ THỂ CHIA cho bot sau khi trừ headroom + phần đang dùng. */
export interface FleetV22Allocatable {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  /** Headroom đã trừ (để UI giải thích "sao chỉ chia được bấy nhiêu"). */
  reserved: { cpuCores: number; ramBytes: number; diskBytes: number };
}

/**
 * Đo tài nguyên host thật bằng Node `os` module. Disk chỉ ước được
 * tổng/dùng khi host truyền `diskTotalBytes`/`diskUsedBytes` (Node os
 * không có API disk) — không truyền thì disk = 0 và `source` vẫn là
 * `os` cho CPU/RAM; caller PHẢI tự đo disk bằng `df` và truyền vào.
 */
export function probeHostResourcesV22(input: {
  diskPath?: string;
  diskTotalBytes?: number;
  diskUsedBytes?: number;
  now?: number;
}): FleetV22HostProbe {
  const now = input.now ?? Date.now();
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load1 = os.loadavg()[0] ?? 0;
  const cpuCores = Math.max(1, cpus.length);
  // Load average 1 phút ≈ số core đang bận (kẹp 0..tổng core).
  const cpuUsed = Math.min(cpuCores, Math.max(0, load1));
  return {
    cpuCores,
    cpuUsed: Math.round(cpuUsed * 100) / 100,
    ramBytes: totalMem,
    ramUsed: Math.max(0, totalMem - freeMem),
    diskBytes: input.diskTotalBytes ?? 0,
    diskUsed: input.diskUsedBytes ?? 0,
    diskPath: input.diskPath ?? process.cwd(),
    measuredAt: now,
    source: 'os',
  };
}

/** Tuổi của số đo (ms) — số đo càng cũ càng không đáng tin. */
export function probeAgeMsV22(probe: FleetV22HostProbe, now: number = Date.now()): number {
  return Math.max(0, now - probe.measuredAt);
}

/** true khi số đo còn tươi (mặc định < 60s). */
export function probeIsFreshV22(probe: FleetV22HostProbe, maxAgeMs = 60_000, now: number = Date.now()): boolean {
  return probeAgeMsV22(probe, now) <= maxAgeMs;
}

// ---------------------------------------------------------------------------
// Phân vùng: trừ headroom rồi chia phần còn lại
// ---------------------------------------------------------------------------

/** Tính phần tài nguyên chia được sau khi trừ headroom + phần đang dùng. */
export function allocatableFromProbeV22(
  probe: FleetV22HostProbe,
  headroom: FleetV22Headroom = DEFAULT_FLEET_V22_HEADROOM,
): FleetV22Allocatable {
  const reservedCpu = probe.cpuCores * headroom.cpuFraction;
  const reservedRam = Math.max(headroom.minRamBytes, 0);
  const reservedDisk = Math.max(probe.diskBytes * headroom.diskFraction, headroom.minDiskBytes);
  return {
    cpuCores: Math.max(0, probe.cpuCores - probe.cpuUsed - reservedCpu),
    ramBytes: Math.max(0, probe.ramBytes - probe.ramUsed - reservedRam),
    diskBytes: Math.max(0, probe.diskBytes - probe.diskUsed - reservedDisk),
    reserved: {
      cpuCores: Math.round(reservedCpu * 100) / 100,
      ramBytes: reservedRam,
      diskBytes: Math.round(reservedDisk),
    },
  };
}

/** Một phần chia (share) cho một bot/computer: xin bao nhiêu, được bao nhiêu. */
export interface FleetV22ShareRequest {
  /** Id bot/computer xin tài nguyên. */
  id: string;
  /** Id user sở hữu (để tính theo user, không cho user này lấy phần user kia). */
  ownerId: string;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  /** Mức ưu tiên khi thiếu tài nguyên (số lớn được trước; mặc định 0). */
  priority?: number;
}

/** Kết quả chia một share. */
export interface FleetV22ShareResult {
  id: string;
  ownerId: string;
  granted: boolean;
  /** Được cấp bao nhiêu (0 khi không cấp được). */
  grantedCpuCores: number;
  grantedRamBytes: number;
  grantedDiskBytes: number;
  /** Lý do không cấp / cấp thiếu. */
  reason?: string;
}

/**
 * Chia tài nguyên cho nhiều share cùng lúc (theo thứ tự ưu tiên, rồi
 * theo thứ tự xin): share nào cũng được xét — KHÔNG cấp quá phần chia
 * được; share thiếu thì bị từ chối toàn bộ (không cấp một nửa rồi để
 * bot chạy thiếu RAM và chết giữa chừng).
 */
export function partitionResourcesV22(
  allocatable: FleetV22Allocatable,
  requests: readonly FleetV22ShareRequest[],
): { results: FleetV22ShareResult[]; remaining: FleetV22Allocatable; summary: string } {
  const ordered = [...requests].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  let cpuLeft = allocatable.cpuCores;
  let ramLeft = allocatable.ramBytes;
  let diskLeft = allocatable.diskBytes;
  const results: FleetV22ShareResult[] = [];
  for (const req of ordered) {
    const short: string[] = [];
    if (req.cpuCores > cpuLeft) short.push(`thiếu ${Math.round((req.cpuCores - cpuLeft) * 100) / 100} CPU core`);
    if (req.ramBytes > ramLeft) short.push(`thiếu ${Math.round((req.ramBytes - ramLeft) / 1024 / 1024)} MB RAM`);
    if (req.diskBytes > diskLeft) short.push(`thiếu ${Math.round((req.diskBytes - diskLeft) / 1024 / 1024)} MB disk`);
    if (short.length > 0) {
      results.push({
        id: req.id,
        ownerId: req.ownerId,
        granted: false,
        grantedCpuCores: 0,
        grantedRamBytes: 0,
        grantedDiskBytes: 0,
        reason: `Không đủ tài nguyên chia được: ${short.join(', ')}.`,
      });
      continue;
    }
    cpuLeft -= req.cpuCores;
    ramLeft -= req.ramBytes;
    diskLeft -= req.diskBytes;
    results.push({
      id: req.id,
      ownerId: req.ownerId,
      granted: true,
      grantedCpuCores: req.cpuCores,
      grantedRamBytes: req.ramBytes,
      grantedDiskBytes: req.diskBytes,
    });
  }
  const grantedCount = results.filter((r) => r.granted).length;
  return {
    results,
    remaining: {
      cpuCores: Math.round(cpuLeft * 100) / 100,
      ramBytes: ramLeft,
      diskBytes: diskLeft,
      reserved: allocatable.reserved,
    },
    summary:
      requests.length === 0
        ? 'Không có yêu cầu chia tài nguyên nào.'
        : `${grantedCount}/${requests.length} yêu cầu được cấp đủ tài nguyên` +
          (grantedCount < requests.length ? `, ${requests.length - grantedCount} bị từ chối (không đủ phần chia được).` : '.'),
  };
}

/**
 * Chia theo từng user (fair-share): mỗi user chỉ được lấy trong phần
 * của mình — user A xin nhiều không lấy được phần đã chia cho user B.
 * `perUser` cho biết mỗi user được tối đa bao nhiêu (thường = quota
 * user, kẹp bởi phần chia được của host).
 */
export function partitionResourcesPerUserV22(
  allocatable: FleetV22Allocatable,
  perUserCaps: Readonly<Record<string, FleetV22Allocatable>>,
  requests: readonly FleetV22ShareRequest[],
): { results: FleetV22ShareResult[]; remaining: FleetV22Allocatable; perUserRemaining: Record<string, FleetV22Allocatable>; summary: string } {
  const userLeft = new Map<string, FleetV22Allocatable>();
  for (const [userId, cap] of Object.entries(perUserCaps)) {
    userLeft.set(userId, {
      cpuCores: Math.min(cap.cpuCores, allocatable.cpuCores),
      ramBytes: Math.min(cap.ramBytes, allocatable.ramBytes),
      diskBytes: Math.min(cap.diskBytes, allocatable.diskBytes),
      reserved: cap.reserved,
    });
  }
  // Host còn lại = phần chia được trừ đi tổng cap của các user (cap
  // không dùng tới vẫn nằm trong host — user khác không lấy được).
  let hostCpu = allocatable.cpuCores;
  let hostRam = allocatable.ramBytes;
  let hostDisk = allocatable.diskBytes;
  for (const cap of userLeft.values()) {
    hostCpu = Math.max(0, hostCpu - cap.cpuCores);
    hostRam = Math.max(0, hostRam - cap.ramBytes);
    hostDisk = Math.max(0, hostDisk - cap.diskBytes);
  }
  const ordered = [...requests].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  const results: FleetV22ShareResult[] = [];
  for (const req of ordered) {
    const cap = userLeft.get(req.ownerId);
    if (!cap) {
      results.push({
        id: req.id,
        ownerId: req.ownerId,
        granted: false,
        grantedCpuCores: 0,
        grantedRamBytes: 0,
        grantedDiskBytes: 0,
        reason: `User "${req.ownerId}" không có phần tài nguyên nào được chia (chưa được cấp cap).`,
      });
      continue;
    }
    const short: string[] = [];
    if (req.cpuCores > cap.cpuCores) short.push(`thiếu ${Math.round((req.cpuCores - cap.cpuCores) * 100) / 100} CPU core trong phần của user`);
    if (req.ramBytes > cap.ramBytes) short.push(`thiếu ${Math.round((req.ramBytes - cap.ramBytes) / 1024 / 1024)} MB RAM trong phần của user`);
    if (req.diskBytes > cap.diskBytes) short.push(`thiếu ${Math.round((req.diskBytes - cap.diskBytes) / 1024 / 1024)} MB disk trong phần của user`);
    if (short.length > 0) {
      results.push({
        id: req.id,
        ownerId: req.ownerId,
        granted: false,
        grantedCpuCores: 0,
        grantedRamBytes: 0,
        grantedDiskBytes: 0,
        reason: `Không đủ tài nguyên trong phần của user: ${short.join(', ')}.`,
      });
      continue;
    }
    userLeft.set(req.ownerId, {
      cpuCores: cap.cpuCores - req.cpuCores,
      ramBytes: cap.ramBytes - req.ramBytes,
      diskBytes: cap.diskBytes - req.diskBytes,
      reserved: cap.reserved,
    });
    results.push({
      id: req.id,
      ownerId: req.ownerId,
      granted: true,
      grantedCpuCores: req.cpuCores,
      grantedRamBytes: req.ramBytes,
      grantedDiskBytes: req.diskBytes,
    });
  }
  const grantedCount = results.filter((r) => r.granted).length;
  const perUserRemaining: Record<string, FleetV22Allocatable> = {};
  for (const [userId, left] of userLeft) perUserRemaining[userId] = left;
  return {
    results,
    remaining: { cpuCores: Math.round(hostCpu * 100) / 100, ramBytes: hostRam, diskBytes: hostDisk, reserved: allocatable.reserved },
    perUserRemaining,
    summary: `${grantedCount}/${requests.length} yêu cầu được cấp trong phần của user` +
      (grantedCount < requests.length ? `, ${requests.length - grantedCount} bị từ chối.` : '.'),
  };
}

/** Validate một probe từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV22Probe(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['probe phải là object.'];
  const p = input as Record<string, unknown>;
  for (const field of ['cpuCores', 'cpuUsed', 'ramBytes', 'ramUsed', 'diskBytes', 'diskUsed'] as const) {
    if (typeof p[field] !== 'number' || !Number.isFinite(p[field]) || (p[field] as number) < 0) {
      errors.push(`probe.${field} phải là số >= 0.`);
    }
  }
  if (typeof p.cpuUsed === 'number' && typeof p.cpuCores === 'number' && p.cpuUsed > p.cpuCores) {
    errors.push('probe.cpuUsed không được lớn hơn probe.cpuCores.');
  }
  if (typeof p.ramUsed === 'number' && typeof p.ramBytes === 'number' && p.ramUsed > p.ramBytes) {
    errors.push('probe.ramUsed không được lớn hơn probe.ramBytes.');
  }
  if (typeof p.diskUsed === 'number' && typeof p.diskBytes === 'number' && p.diskBytes > 0 && p.diskUsed > p.diskBytes) {
    errors.push('probe.diskUsed không được lớn hơn probe.diskBytes.');
  }
  if (typeof p.source === 'string' && !['os', 'manual', 'estimate'].includes(p.source)) {
    errors.push('probe.source phải là os, manual hoặc estimate.');
  }
  return errors;
}

/** Tóm tắt 1 dòng về probe (cho log/dashboard). */
export function summarizeProbeV22(probe: FleetV22HostProbe, now: number = Date.now()): string {
  const gb = (b: number): string => `${Math.round((b / 1024 ** 3) * 10) / 10} GB`;
  return (
    `Host: ${probe.cpuCores} CPU core (${probe.cpuUsed} đang dùng), ` +
    `RAM ${gb(probe.ramUsed)}/${gb(probe.ramBytes)}, disk ${gb(probe.diskUsed)}/${gb(probe.diskBytes)} ` +
    `(${probe.diskPath}), đo cách đây ${Math.round(probeAgeMsV22(probe, now) / 1000)}s (${probe.source}).`
  );
}
