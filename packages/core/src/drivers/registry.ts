/**
 * Driver registry — lưu bền + validate driver CLI tuỳ chỉnh (v1.06, Đội T3).
 *
 * Mọi mutation đều validate trước rồi mới ghi (fail-closed): id sai
 * mẫu, binary không tồn tại, argv chứa cờ key/token, streamFormat lạ
 * đều bị từ chối với lỗi rõ ràng — không bao giờ ghi driver hỏng
 * xuống đĩa. File hỏng (JSON sai / shape lạ) thì load trả registry
 * rỗng kèm cảnh báo qua `onWarn`, không crash app.
 *
 * Ghi atomic (writeDurableFileSync) để VM bị thay giữa chừng cũng
 * không để lại file nửa vời.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeDurableFileSync } from '../vault/durableFile';
import { DRIVER_STREAM_FORMATS, CLI_DRIVERS_FILE, type CliDriverConfig, type CliDriversStateFile, type DriverStreamFormat, type RegisterDriverInput } from './types';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROVIDER_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Cờ dòng lệnh bị từ chối vì trông như đang nhét key/token vào argv (theo mẫu detected/custom.ts). */
const SECRET_FLAG_RE = /^(--api-key|--token|--auth-token|--access-token|--apikey|--api_key|--password|--secret)(=.*)?$/i;
const SECRET_VALUE_RE = /(api[_-]?key|token|secret|password)\s*=/i;

export interface DriverRegistryOptions {
  /** File state (mặc định: <dataDir>/cli-drivers.json). */
  stateFilePath?: string;
  /** Thư mục dữ liệu (dùng khi không truyền stateFilePath). */
  dataDir?: string;
  /** Kiểm tra binary có tồn tại không (mặc định: fs.existsSync hoặc tìm trên PATH). */
  binaryExists?: (binaryPath: string) => boolean;
  /** Đồng hồ (test). */
  now?: () => number;
  /** Nhận cảnh báo không chặn (vd file state hỏng). */
  onWarn?: (message: string) => void;
}

export function getDriverStateFilePath(dataDir: string): string {
  return path.join(dataDir, CLI_DRIVERS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultBinaryExists(binaryPath: string): boolean {
  if (path.isAbsolute(binaryPath)) return fs.existsSync(binaryPath);
  // Tên binary trên PATH: thử từng thư mục PATH (không spawn gì cả).
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, binaryPath))) return true;
  }
  return false;
}

function validateArgList(value: unknown, field: string, opts: { min: number; max: number }): string[] {
  if (!Array.isArray(value)) throw new Error(`Driver: "${field}" phải là mảng chuỗi (vd ["acp"]).`);
  if (value.length < opts.min || value.length > opts.max) {
    throw new Error(`Driver: "${field}" cần ${opts.min}–${opts.max} phần tử.`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 200 || item.includes('\0')) {
      throw new Error(`Driver: "${field}" chỉ nhận chuỗi không rỗng (tối đa 200 ký tự).`);
    }
    const trimmed = item.trim();
    if (SECRET_FLAG_RE.test(trimmed) || SECRET_VALUE_RE.test(trimmed)) {
      throw new Error(
        `Driver: không dùng "${trimmed}" — API key/token không được lưu vào cấu hình driver. Hãy đăng nhập bằng chính CLI đó rồi để open-bot mượn login của nó.`,
      );
    }
    out.push(trimmed);
  }
  return out;
}

/** Validate input đăng ký driver; trả config đầy đủ (chưa ghi). */
export function validateDriverInput(
  input: RegisterDriverInput,
  opts: { binaryExists?: (binaryPath: string) => boolean; now?: () => number; existing?: CliDriverConfig } = {},
): CliDriverConfig {
  const binaryExists = opts.binaryExists ?? defaultBinaryExists;
  const now = opts.now ?? Date.now;
  if (!isRecord(input)) throw new Error('Driver: input phải là object.');
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) {
    throw new Error('Driver: "id" phải là slug chữ thường/số/dấu gạch ngang (vd "my-cli", tối đa 32 ký tự).');
  }
  if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 100) {
    throw new Error('Driver: "name" phải là chuỗi không rỗng (tối đa 100 ký tự).');
  }
  if (typeof input.providerId !== 'string' || !PROVIDER_RE.test(input.providerId)) {
    throw new Error('Driver: "providerId" phải bắt đầu bằng chữ thường, chỉ chữ thường/số/dấu gạch ngang.');
  }
  if (typeof input.binaryPath !== 'string' || input.binaryPath.trim() === '' || input.binaryPath.length > 500) {
    throw new Error('Driver: "binaryPath" phải là đường dẫn tuyệt đối hoặc tên binary trên PATH.');
  }
  const binaryPath = input.binaryPath.trim();
  if (!binaryExists(binaryPath)) {
    throw new Error(`Driver: không tìm thấy binary "${binaryPath}" (đường dẫn tuyệt đối hoặc trên PATH).`);
  }
  if (!(DRIVER_STREAM_FORMATS as readonly string[]).includes(input.streamFormat)) {
    throw new Error(`Driver: "streamFormat" phải là một trong: ${DRIVER_STREAM_FORMATS.join(', ')}.`);
  }
  const argv = input.argv === undefined ? [] : validateArgList(input.argv, 'argv', { min: 0, max: 20 });
  const versionArgs = input.versionArgs === undefined ? ['--version'] : validateArgList(input.versionArgs, 'versionArgs', { min: 1, max: 5 });
  let probeArgs: string[] | undefined;
  if (input.probeArgs !== undefined) {
    probeArgs = validateArgList(input.probeArgs, 'probeArgs', { min: 1, max: 10 });
  }
  const ts = now();
  const prev = opts.existing;
  return {
    id: input.id,
    name: input.name.trim(),
    providerId: input.providerId,
    binaryPath,
    argv,
    streamFormat: input.streamFormat as DriverStreamFormat,
    versionArgs,
    ...(probeArgs ? { probeArgs } : {}),
    enabled: input.enabled ?? prev?.enabled ?? true,
    createdAt: prev?.createdAt ?? ts,
    updatedAt: ts,
  };
}

export class DriverRegistry {
  private readonly stateFilePath: string;
  private readonly binaryExists: (binaryPath: string) => boolean;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private drivers = new Map<string, CliDriverConfig>();

  constructor(options: DriverRegistryOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? getDriverStateFilePath(options.dataDir ?? path.join(process.env['HOME'] ?? '', '.open-bot'));
    this.binaryExists = options.binaryExists ?? defaultBinaryExists;
    this.now = options.now ?? Date.now;
    this.onWarn = options.onWarn ?? (() => undefined);
    this.load();
  }

  /** Đường dẫn file state (để CLI/tool báo cho user). */
  get filePath(): string {
    return this.stateFilePath;
  }

  private load(): void {
    if (!fs.existsSync(this.stateFilePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
    } catch {
      this.onWarn(`${CLI_DRIVERS_FILE} hỏng (không phải JSON hợp lệ); coi như chưa có driver nào.`);
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed['drivers'])) {
      this.onWarn(`${CLI_DRIVERS_FILE} sai định dạng (cần {version: 1, drivers: [...]}); coi như chưa có driver nào.`);
      return;
    }
    for (const entry of parsed['drivers'] as unknown[]) {
      try {
        const cfg = validateDriverInput(entry as RegisterDriverInput, { binaryExists: this.binaryExists, now: this.now });
        // Giữ nguyên createdAt/updatedAt/enabled trong file (validate
        // đã giữ lại qua opts.existing khi có — ở đây entry chính là
        // config đầy đủ nên ép lại các field bền vững).
        const stored = entry as Partial<CliDriverConfig>;
        this.drivers.set(cfg.id, {
          ...cfg,
          enabled: typeof stored.enabled === 'boolean' ? stored.enabled : cfg.enabled,
          createdAt: typeof stored.createdAt === 'number' ? stored.createdAt : cfg.createdAt,
          updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : cfg.updatedAt,
        });
      } catch (err) {
        this.onWarn(`${CLI_DRIVERS_FILE}: bỏ qua driver không hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private save(): void {
    const state: CliDriversStateFile = { version: 1, drivers: this.list() };
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    writeDurableFileSync(this.stateFilePath, JSON.stringify(state, null, 2) + '\n');
  }

  /** Tất cả driver, sắp xếp theo id. */
  list(): CliDriverConfig[] {
    return [...this.drivers.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Chỉ driver đang bật. */
  listEnabled(): CliDriverConfig[] {
    return this.list().filter((d) => d.enabled);
  }

  get(id: string): CliDriverConfig | null {
    return this.drivers.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.drivers.has(id);
  }

  /** Đăng ký driver mới (id trùng → lỗi, dùng update để sửa). */
  register(input: RegisterDriverInput): CliDriverConfig {
    if (this.drivers.has(input.id)) {
      throw new Error(`Driver "${input.id}" đã tồn tại — dùng update để sửa, hoặc remove rồi đăng ký lại.`);
    }
    const cfg = validateDriverInput(input, { binaryExists: this.binaryExists, now: this.now });
    this.drivers.set(cfg.id, cfg);
    this.save();
    return cfg;
  }

  /** Cập nhật driver đã có (giữ createdAt; id không đổi). */
  update(id: string, input: Omit<RegisterDriverInput, 'id'> & { id?: string }): CliDriverConfig {
    const prev = this.drivers.get(id);
    if (!prev) throw new Error(`Driver "${id}" chưa tồn tại — dùng register để đăng ký mới.`);
    const cfg = validateDriverInput({ ...input, id }, { binaryExists: this.binaryExists, now: this.now, existing: prev });
    this.drivers.set(id, cfg);
    this.save();
    return cfg;
  }

  /** Xoá driver (không tồn tại → lỗi rõ). */
  remove(id: string): CliDriverConfig {
    const prev = this.drivers.get(id);
    if (!prev) throw new Error(`Driver "${id}" không tồn tại.`);
    this.drivers.delete(id);
    this.save();
    return prev;
  }

  /** Bật driver. */
  enable(id: string): CliDriverConfig {
    return this.setEnabled(id, true);
  }

  /** Tắt driver (picker ẩn, bot không dùng được). */
  disable(id: string): CliDriverConfig {
    return this.setEnabled(id, false);
  }

  private setEnabled(id: string, enabled: boolean): CliDriverConfig {
    const prev = this.drivers.get(id);
    if (!prev) throw new Error(`Driver "${id}" không tồn tại.`);
    const next: CliDriverConfig = { ...prev, enabled, updatedAt: this.now() };
    this.drivers.set(id, next);
    this.save();
    return next;
  }
}
