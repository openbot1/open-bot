/**
 * Policy cho CodeAct-lite v112 (Đội T2).
 *
 * CodeAct-lite chạy code agent viết (bash/python trích từ fenced code
 * block trong text agent) trong BotBox sandbox — NHƯNG trước khi chạy,
 * policy này chặn thêm một lớp so với denylist của CodeAct v2
 * (`isCodeActCommandBlocked`):
 * - Lệnh leo thang / truy cập hệ thống: sudo, su, passwd, ssh/scp,
 *   netcat, thay đổi quyền hệ thống.
 * - Pipe ra shell từ mạng: `curl … | sh`, `wget … | sh` (CodeAct v2
 *   cho phép; lite chặn vì code trích từ text model dễ bị prompt
 *   injection chèn lệnh tải mã độc).
 * - Đọc/ghi ngoài workspace: đường dẫn tuyệt đối ngoài box, `..`
 *   escape (CodeAct edit đã chặn; bash thì kiểm tra chuỗi).
 * - Lộ secret qua env: `env`, `printenv`, `export` kèm secret — chặn
 *   `env`/`printenv` trần (không đối số).
 * - Ghi đè file hệ thống / device: `> /dev/`, `> /etc/`, `> /usr/`.
 *
 * Policy là *fail-closed*: không chắc chắn → chặn với lý do rõ ràng
 * (agent đọc được như một observation, không throw). Host có thể nới
 * policy qua options (vd cho phép `curl|sh` trong môi trường tin
 * cậy) — mặc định chặn hết.
 *
 * Ngoài denylist, policy còn giới hạn *ngân sách*: số action CodeAct
 * tối đa mỗi turn (`maxActionsPerTurn`, mặc định 8) và số ký tự code
 * tối đa mỗi action (mặc định 32.000 — nhỏ hơn CodeAct v2 vì lite
 * chỉ chạy snippet ngắn trích từ text).
 */

import { isCodeActCommandBlocked } from '../codeact/index';

/** Một quy tắc chặn: mẫu + lý do trả cho agent. */
export interface CodeActLiteBlockRule {
  pattern: RegExp;
  reason: string;
}

/** Denylist riêng của CodeAct-lite (áp cho cả bash lẫn python-source scan). */
export const CODEACT_LITE_BLOCKED_PATTERNS: ReadonlyArray<CodeActLiteBlockRule> = [
  { pattern: /(^|[;|&]\s*)sudo(\s|$)/i, reason: 'sudo (leo thang quyền)' },
  { pattern: /(^|[;|&]\s*)su(\s+|;|$)/i, reason: 'su (đổi user)' },
  { pattern: /(^|[;|&]\s*)passwd(\s|;|$)/i, reason: 'passwd (đổi mật khẩu)' },
  { pattern: /(^|[;|&]\s*)ssh(\s|;|$)/i, reason: 'ssh (truy cập mạng ra ngoài)' },
  { pattern: /(^|[;|&]\s*)scp(\s|;|$)/i, reason: 'scp (copy file ra ngoài)' },
  { pattern: /(^|[;|&]\s*)(nc|ncat|netcat)(\s|;|$)/i, reason: 'netcat (mở kết nối thô)' },
  { pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sh|bash|zsh)\b/i, reason: 'curl/wget pipe sang shell (tải + chạy mã từ mạng)' },
  { pattern: /(^|[;|&]\s*)env(\s|;|$)/i, reason: 'env trần (in biến môi trường, có thể lộ secret)' },
  { pattern: /(^|[;|&]\s*)printenv(\s|;|$)/i, reason: 'printenv (in biến môi trường)' },
  { pattern: />\s*\/dev\/[a-z]/i, reason: 'ghi trực tiếp device' },
  { pattern: />\s*\/(etc|usr|bin|sbin|var|opt)\//i, reason: 'ghi ra ngoài workspace (thư mục hệ thống)' },
  { pattern: /(^|[;|&]\s*)chmod\s+(-R\s+)?777\s+/i, reason: 'chmod 777 (mở quyền toàn bộ)' },
  { pattern: /(^|[;|&]\s*)chown(\s|;|$)/i, reason: 'chown (đổi chủ sở hữu)' },
  { pattern: /\.\.(\/|\\)/, reason: 'đường dẫn ../ (thoát khỏi workspace)' },
  { pattern: /(^|[;|&]\s*)kill\s+-9\s+-1\b/i, reason: 'kill -9 -1 (giết mọi process)' },
  { pattern: /(^|[;|&]\s*)reboot|shutdown|poweroff|halt(\s|;|$)/i, reason: 'shutdown/reboot/poweroff' },
  { pattern: /\/proc\/|\/sys\//i, reason: 'truy cập /proc hoặc /sys' },
];

/** Python: ngoài các mẫu bash, quét thêm các lời gọi nguy hiểm trong code. */
export const CODEACT_LITE_PYTHON_BLOCKED_PATTERNS: ReadonlyArray<CodeActLiteBlockRule> = [
  { pattern: /\bos\.system\s*\(/, reason: 'os.system (chạy shell từ Python — dùng bash action thay thế)' },
  { pattern: /\bsubprocess\.(Popen|call|run)\s*\(/, reason: 'subprocess (chạy process con từ Python — dùng bash action thay thế)' },
  { pattern: /\bos\.environ\b/, reason: 'os.environ (đọc biến môi trường, có thể lộ secret)' },
  { pattern: /\bopen\s*\(\s*['"]\/(etc|proc|sys)\//, reason: 'mở file hệ thống từ Python' },
  { pattern: /\bsocket\s*\.\s*socket\s*\(/, reason: 'socket (mở kết nối mạng thô từ Python)' },
  { pattern: /\beval\s*\(/, reason: 'eval (chạy code động)' },
  { pattern: /\bexec\s*\(/, reason: 'exec (chạy code động)' },
];

/** Giới hạn ngân sách của CodeAct-lite. */
export interface CodeActLiteLimits {
  /** Số action tối đa mỗi turn. Mặc định 8. */
  maxActionsPerTurn: number;
  /** Số ký tự code tối đa mỗi action. Mặc định 32.000. */
  maxCodeChars: number;
  /** Timeout mặc định mỗi lần chạy, ms. Mặc định 30.000. */
  timeoutMs: number;
  /** Output tối đa giữ lại mỗi bên (stdout/stderr), ký tự. Mặc định 8.000. */
  maxOutputChars: number;
}

export const DEFAULT_CODEACT_LITE_LIMITS: CodeActLiteLimits = {
  maxActionsPerTurn: 8,
  maxCodeChars: 32_000,
  timeoutMs: 30_000,
  maxOutputChars: 8000,
};

/** Kết quả kiểm tra policy cho một action. */
export interface CodeActLitePolicyCheck {
  blocked: boolean;
  reason?: string;
  /** Nguồn luật đã chặn: 'lite' | 'codeact-v2'. */
  source?: 'lite' | 'codeact-v2';
}

/**
 * Kiểm tra một action bash/python có vi phạm policy không.
 * `allowPipeToShell` = true cho phép `curl|sh` (host tin cậy).
 */
export function checkCodeActLitePolicy(
  kind: 'bash' | 'python',
  code: string,
  options?: { allowPipeToShell?: boolean },
): CodeActLitePolicyCheck {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return { blocked: true, reason: 'code rỗng', source: 'lite' };
  }
  if (kind === 'bash') {
    // Lớp CodeAct v2 trước (rm -rf /, mkfs, fork bomb…).
    const v2 = isCodeActCommandBlocked(trimmed);
    if (v2.blocked) {
      return { blocked: true, reason: v2.reason, source: 'codeact-v2' };
    }
  }
  for (const rule of CODEACT_LITE_BLOCKED_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      if (options?.allowPipeToShell && rule.reason.startsWith('curl/wget pipe')) continue;
      return { blocked: true, reason: rule.reason, source: 'lite' };
    }
  }
  if (kind === 'python') {
    for (const rule of CODEACT_LITE_PYTHON_BLOCKED_PATTERNS) {
      if (rule.pattern.test(trimmed)) {
        return { blocked: true, reason: rule.reason, source: 'lite' };
      }
    }
  }
  return { blocked: false };
}

/** Đếm số action CodeAct đã chạy trong turn hiện tại (dùng cho budget). */
export function codeActLiteBudgetExceeded(actionsRun: number, limits: CodeActLiteLimits): boolean {
  return actionsRun >= limits.maxActionsPerTurn;
}
