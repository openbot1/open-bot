/**
 * Per-bot computer v2 — quota + trạng thái máy-tính-bot (v1.05, Đội T3).
 *
 * Nối tiếp `packages/core/src/compute/` hiện có (probe/planner/runtime/
 * cgroup/scheduler) chứ không viết lại: module này chỉ thêm lớp "quota
 * mềm + cảnh báo" trên cùng một `MachineProfile`/`BotComputer`:
 * - `BotComputerQuota`: giới hạn mềm mỗi bot tự đặt (CPU/RAM/đĩa/số
 *   process) — cgroup thật vẫn do `cgroup.ts` enforce khi có, quota
 *   ở đây là cảnh báo + dashboard, không giả vờ enforce khi không có.
 * - `measureBotComputerUsage`: đo thật những gì đo được (dung lượng
 *   đĩa workspace của bot, số process con đang chạy của bot nếu caller
 *   truyền vào) — số nào không đo được thì ghi `null`, không bịa.
 * - `evaluateQuota`: so usage với quota → cảnh báo theo ngưỡng 80%
 *   (warn) / 100% (over).
 * - Quota lưu ở `<dataDir>/team-computers.json` (JSON, không phải YAML
 *   — file này do app ghi, team YAML chỉ là định dạng trao đổi).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ComputerLevel, MachineProfile } from './types';

export const TEAM_COMPUTERS_FILE = 'team-computers.json';

/** Giới hạn mềm của một máy-tính-bot. Mọi field đều optional: không đặt = không giới hạn. */
export interface BotComputerQuota {
  botId: string;
  /** Mức cách ly mong muốn ('box' | 'container' | 'vm'). */
  level?: ComputerLevel;
  /** Số core logic tối đa. */
  cpuCores?: number;
  /** RAM tối đa (MB). */
  memoryMb?: number;
  /** Đĩa tối đa cho workspace của bot (MB). */
  diskMb?: number;
  /** Số process tối đa. */
  maxProcesses?: number;
}

/** Mức sử dụng đo được của một máy-tính-bot (null = không đo được). */
export interface BotComputerUsage {
  botId: string;
  /** Số core đang dùng (ước lượng từ load/process, null khi không đo được). */
  cpuCores: number | null;
  /** RAM đang dùng (MB, null khi không đo được). */
  memoryMb: number | null;
  /** Đĩa workspace đang dùng (MB, null khi không đo được). */
  diskMb: number | null;
  /** Số process đang chạy (null khi không đo được). */
  processes: number | null;
  /** Thời điểm đo (ISO string). */
  measuredAt: string;
}

export type QuotaWarningSeverity = 'warn' | 'over';

/** Một cảnh báo vượt quota. */
export interface QuotaWarning {
  field: 'cpuCores' | 'memoryMb' | 'diskMb' | 'maxProcesses';
  severity: QuotaWarningSeverity;
  /** Tỉ lệ dùng/quota (vd 1.25 = 125%). */
  ratio: number;
  message: string;
}

/** Trạng thái đầy đủ của một máy-tính-bot để dashboard hiển thị. */
export interface BotComputerStatusView {
  botId: string;
  level: ComputerLevel | null;
  quota: BotComputerQuota | null;
  usage: BotComputerUsage;
  warnings: QuotaWarning[];
  /** 'ok' | 'warn' | 'over' — mức nghiêm trọng nhất trong warnings. */
  status: 'ok' | 'warn' | 'over';
  /** Backend có sẵn trên máy host không (vd KVM/QEMU cho 'vm'). */
  levelFeasible: boolean | null;
  /** Lý do level không khả thi (khi levelFeasible === false). */
  levelNote?: string;
}

/** Ngưỡng warn: dùng trên 80% quota thì cảnh báo sớm. */
export const QUOTA_WARN_RATIO = 0.8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Validate một quota thô (từ YAML/JSON). Trả về quota đã làm sạch hoặc
 * throw với message rõ ràng. BotId rỗng / level lạ / số không dương
 * đều bị từ chối.
 */
export function validateBotComputerQuota(raw: unknown): BotComputerQuota {
  if (!isRecord(raw)) throw new Error('quota máy-tính-bot phải là object.');
  const botId = raw['botId'];
  if (typeof botId !== 'string' || botId.trim() === '') {
    throw new Error('quota máy-tính-bot cần "botId" không rỗng.');
  }
  const quota: BotComputerQuota = { botId: botId.trim() };
  if (raw['level'] !== undefined) {
    if (raw['level'] !== 'box' && raw['level'] !== 'container' && raw['level'] !== 'vm') {
      throw new Error(`quota của bot "${quota.botId}": "level" phải là box | container | vm.`);
    }
    quota.level = raw['level'];
  }
  for (const field of ['cpuCores', 'memoryMb', 'diskMb', 'maxProcesses'] as const) {
    if (raw[field] !== undefined) {
      if (!isPositiveNumber(raw[field])) {
        throw new Error(`quota của bot "${quota.botId}": "${field}" phải là số dương.`);
      }
      quota[field] = raw[field];
    }
  }
  return quota;
}

/** Parse file team-computers.json (mảng quota). File hỏng → throw rõ. */
export function parseBotComputerQuotas(raw: unknown): BotComputerQuota[] {
  if (!Array.isArray(raw)) throw new Error('team-computers.json phải chứa một mảng quota.');
  return raw.map((entry) => validateBotComputerQuota(entry));
}

export function loadBotComputerQuotas(dataDir: string): BotComputerQuota[] {
  const file = path.join(dataDir, TEAM_COMPUTERS_FILE);
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`Không đọc được ${TEAM_COMPUTERS_FILE}: ${(err as Error).message}`);
  }
  return parseBotComputerQuotas(parsed);
}

export function saveBotComputerQuotas(dataDir: string, quotas: BotComputerQuota[]): void {
  const file = path.join(dataDir, TEAM_COMPUTERS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(quotas, null, 2)}\n`, 'utf8');
}

/** Gộp quota mới vào danh sách cũ (cùng botId thì thay thế). */
export function upsertBotComputerQuota(quotas: BotComputerQuota[], quota: BotComputerQuota): BotComputerQuota[] {
  const next = quotas.filter((q) => q.botId !== quota.botId);
  next.push(quota);
  return next.sort((a, b) => a.botId.localeCompare(b.botId));
}

/**
 * Đo dung lượng đĩa của một thư mục (đệ quy, chỉ file thường + symlink
 * tới file). Trả về MB (làm tròn 1 chữ số). Thư mục không tồn tại → null.
 * Có giới hạn số file duyệt để không treo máy trên workspace khổng lồ.
 */
export const MAX_MEASURED_FILES = 50_000;

export function measureDirSizeMb(dir: string): number | null {
  if (!fs.existsSync(dir)) return null;
  let totalBytes = 0;
  let seen = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= MAX_MEASURED_FILES) return Number((totalBytes / 1024 / 1024).toFixed(1));
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() || entry.isSymbolicLink()) {
          totalBytes += fs.statSync(full).size;
          seen += 1;
        }
      } catch {
        // File biến mất giữa chừng: bỏ qua, không fail cả lần đo.
      }
    }
  }
  return Number((totalBytes / 1024 / 1024).toFixed(1));
}

/**
 * So usage với quota → warnings. Chỉ field nào CẢ quota và usage đều
 * có số mới so được; thiếu một bên thì bỏ qua (không cảnh báo giả).
 */
export function evaluateQuota(quota: BotComputerQuota, usage: BotComputerUsage): QuotaWarning[] {
  const warnings: QuotaWarning[] = [];
  const pairs: Array<{
    field: QuotaWarning['field'];
    limit?: number;
    used: number | null;
    unit: string;
    label: string;
  }> = [
    { field: 'cpuCores', limit: quota.cpuCores, used: usage.cpuCores, unit: 'core', label: 'CPU' },
    { field: 'memoryMb', limit: quota.memoryMb, used: usage.memoryMb, unit: 'MB', label: 'RAM' },
    { field: 'diskMb', limit: quota.diskMb, used: usage.diskMb, unit: 'MB', label: 'Đĩa' },
    { field: 'maxProcesses', limit: quota.maxProcesses, used: usage.processes, unit: 'process', label: 'Process' },
  ];
  for (const p of pairs) {
    if (p.limit === undefined || p.used === null) continue;
    const ratio = p.used / p.limit;
    if (ratio >= 1) {
      warnings.push({
        field: p.field,
        severity: 'over',
        ratio: Number(ratio.toFixed(2)),
        message: `${p.label} vượt quota: ${p.used} / ${p.limit} ${p.unit} (${Math.round(ratio * 100)}%)`,
      });
    } else if (ratio >= QUOTA_WARN_RATIO) {
      warnings.push({
        field: p.field,
        severity: 'warn',
        ratio: Number(ratio.toFixed(2)),
        message: `${p.label} gần hết quota: ${p.used} / ${p.limit} ${p.unit} (${Math.round(ratio * 100)}%)`,
      });
    }
  }
  return warnings;
}

/**
 * Level mong muốn có khả thi trên máy host không (dựa trên probe thật):
 * - 'box': luôn khả thi.
 * - 'container': cần Linux + (bwrap/unshare/systemd-nspawn) — ở đây
 *   kiểm tra đơn giản qua `virtualization.supported` là chưa đủ nên
 *   chỉ dùng thông tin OS: container cần Linux; trên macOS/Windows
 *   thì ghi không khả thi với lý do rõ.
 * - 'vm': cần CPU hỗ trợ ảo hoá (KVM/Hyper-V/Apple Virtualization).
 * Trả về { feasible, note } — caller quyết định hiển thị.
 */
export function checkLevelFeasible(level: ComputerLevel, profile: MachineProfile): { feasible: boolean; note?: string } {
  if (level === 'box') return { feasible: true };
  if (level === 'container') {
    if (profile.os !== 'linux') {
      return { feasible: false, note: `container cần Linux, máy đang chạy ${profile.os}` };
    }
    return { feasible: true };
  }
  // vm
  if (!profile.virtualization.supported) {
    return { feasible: false, note: 'CPU không hỗ trợ ảo hoá (không thấy vmx/svm/Apple Silicon)' };
  }
  return { feasible: true, note: profile.virtualization.detail || undefined };
}

/** Ghép quota + usage + profile thành view cho dashboard. */
export function buildBotComputerStatusView(
  botId: string,
  quota: BotComputerQuota | null,
  usage: BotComputerUsage,
  profile: MachineProfile | null,
): BotComputerStatusView {
  const warnings = quota ? evaluateQuota(quota, usage) : [];
  const status: BotComputerStatusView['status'] = warnings.some((w) => w.severity === 'over')
    ? 'over'
    : warnings.length > 0
      ? 'warn'
      : 'ok';
  let levelFeasible: boolean | null = null;
  let levelNote: string | undefined;
  if (quota?.level && profile) {
    const check = checkLevelFeasible(quota.level, profile);
    levelFeasible = check.feasible;
    levelNote = check.note;
  }
  return {
    botId,
    level: quota?.level ?? null,
    quota,
    usage,
    warnings,
    status,
    levelFeasible,
    levelNote,
  };
}

/** Usage rỗng (chưa đo được gì) cho một bot. */
export function emptyBotComputerUsage(botId: string): BotComputerUsage {
  return {
    botId,
    cpuCores: null,
    memoryMb: null,
    diskMb: null,
    processes: null,
    measuredAt: new Date().toISOString(),
  };
}
