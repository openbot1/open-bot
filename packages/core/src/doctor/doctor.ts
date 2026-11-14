/**
 * `open-bot doctor` — kiểm tra sức khoẻ hệ thống (v1.05, Đội T3).
 *
 * Học ý tưởng từ lệnh `doctor` của các CLI agent khác (kiểm tra nhanh
 * môi trường trước khi chạy bot) nhưng viết mới hoàn toàn cho open-bot:
 * mọi check đều thuần, nhận dependencies qua `DoctorDeps` để test có
 * thể mock hết (không gọi mạng / không đọc đĩa thật trong test).
 *
 * Một check không bao giờ throw: lỗi khi chạy check được ghi thành
 * status 'fail' với detail là message — doctor luôn trả về báo cáo đầy
 * đủ thay vì crash giữa chừng.
 *
 * Quy tắc trung thực: doctor chỉ báo những gì đo được. Provider "đã
 * cấu hình" nghĩa là có API key trong env `OPENBOT_<PROVIDER>_API_KEY`
 * (hoặc vault có secret — do caller truyền vào), KHÔNG thử gọi API
 * thật để "verify key". Ollama "đang chạy" nghĩa là GET
 * `http://127.0.0.1:11434/api/tags` trả 2xx trong timeout.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/** Trạng thái của một check. */
export type DoctorCheckStatus = 'ok' | 'warn' | 'fail';

/** Kết quả một check riêng lẻ. */
export interface DoctorCheck {
  /** Id ổn định, vd 'node', 'ollama', 'disk'. */
  id: string;
  /** Nhãn hiển thị cho người dùng. */
  label: string;
  status: DoctorCheckStatus;
  /** Chi tiết ngắn, vd 'v22.14.0 (>= 20)' hay 'còn trống 12,3 GB'. */
  detail: string;
  /** Gợi ý khắc phục khi status != 'ok' (không có thì thôi). */
  hint?: string;
}

/** Toàn bộ báo cáo doctor. */
export interface DoctorReport {
  /** true khi không có check nào 'fail' (warn vẫn cho exit 0). */
  ok: boolean;
  /** Số check ok / warn / fail. */
  summary: { ok: number; warn: number; fail: number };
  checks: DoctorCheck[];
  /** Thời điểm chạy (ISO string). */
  checkedAt: string;
  /** Thời gian chạy toàn bộ (ms). */
  durationMs: number;
}

/** Provider mà doctor biết cách nhận diện key trong env. */
export const DOCTOR_ENV_PROVIDERS: readonly string[] = [
  'openai',
  'anthropic',
  'gemini',
  'xai',
  'deepseek',
  'moonshot',
  'qwen',
  'mistral',
  'groq',
  'together',
  'cohere',
];

/** Port mặc định của headless server — doctor kiểm tra xem có trống không. */
export const DOCTOR_HEADLESS_PORT = 8799;
/** Port mặc định của Ollama local. */
export const DOCTOR_OLLAMA_PORT = 11434;
/** Node tối thiểu open-bot hỗ trợ. */
export const DOCTOR_MIN_NODE_MAJOR = 20;
/** Ngưỡng cảnh báo: đĩa trống dưới 5 GB thì warn, dưới 1 GB thì fail. */
export const DOCTOR_DISK_WARN_BYTES = 5 * 1024 * 1024 * 1024;
export const DOCTOR_DISK_FAIL_BYTES = 1 * 1024 * 1024 * 1024;
/** Ngưỡng cảnh báo: RAM trống dưới 512 MB thì warn. */
export const DOCTOR_RAM_WARN_BYTES = 512 * 1024 * 1024;

/**
 * Dependencies có thể inject (test mock, CLI dùng mặc định).
 * Mọi field đều optional — thiếu thì dùng implementation thật.
 */
export interface DoctorDeps {
  /** Thư mục dữ liệu của app (`~/.open-bot` mặc định). */
  dataDir?: string;
  /** Đọc biến môi trường (mặc định process.env). */
  getEnv?: (name: string) => string | undefined;
  /** Kiểm tra một provider có secret trong vault không (mặc định: không). */
  hasVaultSecret?: (providerId: string) => boolean;
  /** Fetch tối thiểu dùng cho Ollama probe (mặc định global fetch). */
  fetchFn?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
  /** Timeout probe Ollama (ms, mặc định 3000). */
  ollamaTimeoutMs?: number;
  /** Base URL Ollama (mặc định http://127.0.0.1:11434). */
  ollamaBaseUrl?: string;
  /** Đọc thư mục (mặc định fs.readdirSync). */
  readDir?: (dir: string) => string[];
  /** Kiểm tra tồn tại (mặc định fs.existsSync). */
  exists?: (p: string) => boolean;
  /** Đọc file text (mặc định fs.readFileSync utf8). */
  readFile?: (p: string) => string;
  /** Tổng RAM (bytes, mặc định os.totalmem()). */
  totalMem?: () => number;
  /** RAM trống (bytes, mặc định os.freemem()). */
  freeMem?: () => number;
  /** Thông tin đĩa của dataDir (mặc định fs.statfsSync). */
  diskStats?: (dir: string) => { totalBytes: number; freeBytes: number };
  /** Thử bind một port để xem có trống không (mặc định net thật). */
  isPortFree?: (port: number) => Promise<boolean>;
  /** Phiên bản Node (mặc định process.version). */
  nodeVersion?: string;
  /** Nền tảng (mặc định process.platform). */
  platform?: string;
}

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.open-bot');

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

function parseNodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}

async function realIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function probeOllama(
  baseUrl: string,
  fetchFn: DoctorDeps['fetchFn'],
  timeoutMs: number,
): Promise<{ running: boolean; modelCount: number | null; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await (fetchFn ?? fetch)(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: controller.signal,
    });
    if (!res.ok) return { running: false, modelCount: null, detail: `trả HTTP ${res.status}` };
    return { running: true, modelCount: null, detail: 'đang chạy' };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { running: false, modelCount: null, detail: `timeout sau ${timeoutMs}ms` };
    }
    return { running: false, modelCount: null, detail: 'không kết nối được' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chạy toàn bộ check và trả về báo cáo. Không bao giờ throw vì lỗi
 * của một check riêng lẻ — check đó thành 'fail'.
 */
export async function runDoctorChecks(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const startedAt = Date.now();
  const checks: DoctorCheck[] = [];
  const dataDir = deps.dataDir ?? DEFAULT_DATA_DIR;
  const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const readDir = deps.readDir ?? ((dir: string) => fs.readdirSync(dir));
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const totalMem = deps.totalMem ?? (() => os.totalmem());
  const freeMem = deps.freeMem ?? (() => os.freemem());
  const diskStats =
    deps.diskStats ??
    ((dir: string) => {
      const s = fs.statfsSync(dir);
      return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    });
  const isPortFree = deps.isPortFree ?? realIsPortFree;
  const nodeVersion = deps.nodeVersion ?? process.version;
  const platform = deps.platform ?? process.platform;

  const push = (check: DoctorCheck): void => {
    checks.push(check);
  };
  const safe = async (id: string, label: string, fn: () => DoctorCheck | Promise<DoctorCheck>): Promise<void> => {
    try {
      push(await fn());
    } catch (err) {
      push({ id, label, status: 'fail', detail: (err as Error).message });
    }
  };

  // 1. Node runtime.
  await safe('node', 'Node.js', () => {
    const major = parseNodeMajor(nodeVersion);
    if (major === null) {
      return { id: 'node', label: 'Node.js', status: 'warn', detail: `không đọc được phiên bản ("${nodeVersion}")` };
    }
    return major >= DOCTOR_MIN_NODE_MAJOR
      ? { id: 'node', label: 'Node.js', status: 'ok', detail: `${nodeVersion} (>= ${DOCTOR_MIN_NODE_MAJOR}) — ${platform}` }
      : {
          id: 'node',
          label: 'Node.js',
          status: 'fail',
          detail: `${nodeVersion} — cần >= ${DOCTOR_MIN_NODE_MAJOR}`,
          hint: 'Nâng cấp Node.js lên 20 trở lên.',
        };
  });

  // 2. Thư mục dữ liệu + vault.
  await safe('datadir', 'Thư mục dữ liệu', () => {
    if (!exists(dataDir)) {
      return {
        id: 'datadir',
        label: 'Thư mục dữ liệu',
        status: 'warn',
        detail: `${dataDir} chưa tồn tại (sẽ tạo khi chạy lần đầu)`,
      };
    }
    return { id: 'datadir', label: 'Thư mục dữ liệu', status: 'ok', detail: dataDir };
  });
  await safe('vault', 'Vault (khóa API)', () => {
    const vaultDir = path.join(dataDir, 'vault');
    if (!exists(vaultDir)) {
      return {
        id: 'vault',
        label: 'Vault (khóa API)',
        status: 'warn',
        detail: 'chưa có vault — chưa lưu khóa API nào',
        hint: 'Mở app desktop → Settings để thêm khóa, hoặc dùng CLI login của provider.',
      };
    }
    const entries = readDir(vaultDir).length;
    return {
      id: 'vault',
      label: 'Vault (khóa API)',
      status: 'ok',
      detail: `${entries} mục đã lưu`,
    };
  });

  // 3. Provider đã cấu hình (env key hoặc vault) — chỉ đếm, không in secret.
  await safe('providers', 'Provider đã cấu hình', () => {
    const configured: string[] = [];
    for (const providerId of DOCTOR_ENV_PROVIDERS) {
      const envName = `OPENBOT_${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      const fromEnv = (getEnv(envName) ?? '').trim() !== '';
      const fromVault = deps.hasVaultSecret?.(providerId) ?? false;
      if (fromEnv || fromVault) configured.push(providerId);
    }
    if (configured.length === 0) {
      return {
        id: 'providers',
        label: 'Provider đã cấu hình',
        status: 'warn',
        detail: 'chưa có provider API-key nào (vẫn dùng được Ollama / CLI login)',
        hint: 'Đặt OPENBOT_<PROVIDER>_API_KEY hoặc thêm khóa trong Settings.',
      };
    }
    return {
      id: 'providers',
      label: 'Provider đã cấu hình',
      status: 'ok',
      detail: `${configured.length} provider: ${configured.join(', ')}`,
    };
  });

  // 4. Ollama local.
  await safe('ollama', 'Ollama local', async () => {
    const probe = await probeOllama(
      deps.ollamaBaseUrl ?? `http://127.0.0.1:${DOCTOR_OLLAMA_PORT}`,
      deps.fetchFn,
      deps.ollamaTimeoutMs ?? 3000,
    );
    if (probe.running) {
      return { id: 'ollama', label: 'Ollama local', status: 'ok', detail: probe.detail };
    }
    return {
      id: 'ollama',
      label: 'Ollama local',
      status: 'warn',
      detail: `không chạy (${probe.detail})`,
      hint: 'Cài/chạy Ollama để dùng model local miễn phí, hoặc bỏ qua nếu dùng API key.',
    };
  });

  // 5. MCP servers đã đăng ký (marketplace registry).
  await safe('mcp', 'MCP servers', () => {
    const registryFile = path.join(dataDir, 'marketplace', 'mcp-servers.json');
    if (!exists(registryFile)) {
      return {
        id: 'mcp',
        label: 'MCP servers',
        status: 'ok',
        detail: 'chưa đăng ký server nào',
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFile(registryFile)) as unknown;
    } catch {
      return {
        id: 'mcp',
        label: 'MCP servers',
        status: 'fail',
        detail: 'mcp-servers.json hỏng (không phải JSON)',
        hint: 'Xoá hoặc sửa file marketplace/mcp-servers.json trong thư mục dữ liệu.',
      };
    }
    const count = Array.isArray(parsed)
      ? parsed.length
      : typeof parsed === 'object' && parsed !== null
        ? Object.keys(parsed as Record<string, unknown>).length
        : 0;
    return { id: 'mcp', label: 'MCP servers', status: 'ok', detail: `${count} server đã đăng ký` };
  });

  // 6. RAM.
  await safe('memory', 'RAM', () => {
    const total = totalMem();
    const free = freeMem();
    const detail = `trống ${formatBytes(free)} / tổng ${formatBytes(total)}`;
    if (free < DOCTOR_RAM_WARN_BYTES) {
      return {
        id: 'memory',
        label: 'RAM',
        status: 'warn',
        detail,
        hint: 'RAM trống thấp — giảm số bot chạy song song.',
      };
    }
    return { id: 'memory', label: 'RAM', status: 'ok', detail };
  });

  // 7. Đĩa (đo tại dataDir, fallback về cwd khi dataDir chưa tồn tại).
  await safe('disk', 'Ổ đĩa', () => {
    const dir = exists(dataDir) ? dataDir : process.cwd();
    const stats = diskStats(dir);
    const detail = `trống ${formatBytes(stats.freeBytes)} / tổng ${formatBytes(stats.totalBytes)} (${dir})`;
    if (stats.freeBytes < DOCTOR_DISK_FAIL_BYTES) {
      return { id: 'disk', label: 'Ổ đĩa', status: 'fail', detail, hint: 'Dọn đĩa trước khi chạy bot (workspace/model chiếm nhiều chỗ).' };
    }
    if (stats.freeBytes < DOCTOR_DISK_WARN_BYTES) {
      return { id: 'disk', label: 'Ổ đĩa', status: 'warn', detail, hint: 'Ổ đĩa sắp đầy — dọn bớt workspace/model cũ.' };
    }
    return { id: 'disk', label: 'Ổ đĩa', status: 'ok', detail };
  });

  // 8. Port headless còn trống không.
  await safe('headless-port', 'Port headless', async () => {
    const free = await isPortFree(DOCTOR_HEADLESS_PORT);
    return free
      ? { id: 'headless-port', label: 'Port headless', status: 'ok', detail: `${DOCTOR_HEADLESS_PORT} đang trống` }
      : {
          id: 'headless-port',
          label: 'Port headless',
          status: 'warn',
          detail: `${DOCTOR_HEADLESS_PORT} đang bị chiếm (có thể headless server đang chạy)`,
          hint: `Dùng "open-bot headless status" để xem, hoặc chạy với --port khác.`,
        };
  });

  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };
  return {
    ok: summary.fail === 0,
    summary,
    checks,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/** Exit code cho CLI: 0 khi không có fail, 1 khi có fail. */
export function doctorExitCode(report: DoctorReport): number {
  return report.ok ? 0 : 1;
}

/** Render báo cáo dạng text có màu (ANSI) cho terminal. */
export function renderDoctorReport(report: DoctorReport, useColor = true): string {
  const color = (code: string, text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
  const icon = (status: DoctorCheckStatus): string =>
    status === 'ok' ? color('32', '✓') : status === 'warn' ? color('33', '!') : color('31', '✗');
  const lines: string[] = [];
  lines.push(color('1', 'open-bot doctor — kiểm tra sức khoẻ hệ thống'));
  lines.push('');
  for (const check of report.checks) {
    lines.push(`${icon(check.status)} ${check.label}: ${check.detail}`);
    if (check.hint) lines.push(`    ↳ ${check.hint}`);
  }
  lines.push('');
  const verdict = report.ok
    ? color('32', `OK — ${report.summary.ok} ok, ${report.summary.warn} cảnh báo, 0 lỗi`)
    : color('31', `LỖI — ${report.summary.fail} check lỗi, ${report.summary.warn} cảnh báo`);
  lines.push(verdict);
  return lines.join('\n');
}
