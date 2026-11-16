/**
 * Security analyzer v7 (v1.15, Đội T4) — quét code/command TRƯỚC khi chạy.
 *
 * Học ý tưởng SecurityAnalyzer của OpenHands V1 SDK (survey v1.15 §3)
 * và nối RiskAnalyzer (v1.01) + V6SecurityAnalyzer (v1.14), nhưng v7
 * viết lại từ đầu với 3 điểm khác:
 * - 3 mức allow/warn/block thay cho thang LOW/MEDIUM/HIGH: `warn` vẫn
 *   cho chạy nhưng ghi audit + agent thấy cảnh báo trong observation;
 *   `block` không chạy, trả observation blocked.
 * - Rule engine khai báo dạng bảng (pattern + mức + lý do), dễ thêm
 *   rule mới mà không sửa code quét; quét cả bash, python, edit path
 *   và nội dung file ghi.
 * - Audit log append-only riêng (`V7SecurityAuditLog`) — mỗi lần quét
 *   ghi một dòng, phục vụ điều tra sau sự cố; secret bị redact trước
 *   khi ghi.
 *
 * Quy tắc an toàn mặc định:
 * - BLOCK: rm -rf / hoặc rm -rf $HOME, `curl|sh` / `wget|sh`, ghi đè
 *   ngoài workspace, đọc file secret (~/.ssh, *.pem, .env...), gửi
 *   secret ra ngoài (curl với nội dung file secret), sudo/su, fork
 *   bomb, mkfs/dd lên device, chmod 777 /, eval mã tải từ mạng.
 * - WARN: rm -rf trong workspace, curl/wget tải file, chmod +x,
 *   pip/npm install, git push, xóa file, ghi đè file hệ thống trong
 *   workspace, dùng `eval`/`exec` trong Python.
 * - ALLOW: còn lại.
 *
 * Module thuần (không fs, không mạng).
 */

import type { V7Action, V7SecurityAuditEntry, V7SecurityFinding, V7SecurityLevel, V7SecurityVerdict } from './types';

/** Một rule quét: regex + mức + mã + thông điệp. */
export interface V7SecurityRule {
  id: string;
  level: V7SecurityLevel;
  /** Áp dụng cho kind nào: 'bash' | 'python' | 'edit' | 'any'. */
  appliesTo: Array<'bash' | 'python' | 'edit' | 'read' | 'any'>;
  pattern: RegExp;
  message: string;
}

/** Cắt ngắn đoạn khớp để đưa vào finding. */
export const V7_SECURITY_MATCH_LIMIT = 120;

/** Redact secret thường gặp trước khi ghi audit/log. */
export function redactV7Secrets(text: string): string {
  return text
    .replace(/(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*['"]?[^'"\s]{4,}['"]?/gi, '$1=[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
    .replace(/(ghp_[A-Za-z0-9]{8,})/g, '[REDACTED]')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g, '[REDACTED PRIVATE KEY]');
}

function clipMatch(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= V7_SECURITY_MATCH_LIMIT ? single : `${single.slice(0, V7_SECURITY_MATCH_LIMIT)}…`;
}

/** Bảng rule mặc định của v7. */
export const V7_SECURITY_RULES: readonly V7SecurityRule[] = [
  // --- BLOCK: phá hủy hệ thống / ngoài workspace ---
  { id: 'V7SEC-RM-RF-ROOT', level: 'block', appliesTo: ['bash'], pattern: /\brm\s+[^|;&]*?(-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b[^|;&]*?\s+(\/|\$HOME|\$USERPROFILE|~)(\s|[/\\]|$|[;&|])/i, message: 'rm -rf targeting filesystem root or home directory' },
  { id: 'V7SEC-RM-RF-ROOT2', level: 'block', appliesTo: ['bash'], pattern: /\brm\s+[^|;&]*--no-preserve-root\b/i, message: 'rm with --no-preserve-root' },
  { id: 'V7SEC-MKFS-DD', level: 'block', appliesTo: ['bash'], pattern: /\b(mkfs|dd\s+[^|;&]*of=\/dev\/|fdisk)\b/i, message: 'disk formatting / raw device write' },
  { id: 'V7SEC-FORK-BOMB', level: 'block', appliesTo: ['bash'], pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, message: 'fork bomb pattern' },
  { id: 'V7SEC-SUDO-SU', level: 'block', appliesTo: ['bash'], pattern: /(^|[;&|]\s*)\s*(sudo|su\s|doas\s)\b/i, message: 'privilege escalation (sudo/su/doas)' },
  { id: 'V7SEC-CURL-PIPE-SH', level: 'block', appliesTo: ['bash'], pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python3?)\b/i, message: 'piping downloaded content straight into a shell' },
  { id: 'V7SEC-REMOTE-EVAL', level: 'block', appliesTo: ['python'], pattern: /\b(eval|exec)\s*\(\s*(requests|urllib)[^)]*\)/i, message: 'evaluating code fetched from the network' },
  { id: 'V7SEC-SECRET-READ', level: 'block', appliesTo: ['bash', 'python', 'read'], pattern: /(\.ssh\/|\.aws\/credentials|\.gnupg\/|id_rsa|id_ed25519|\.pem\b|credentials\.json|\.env\b)/i, message: 'reading private credentials / secret files' },
  { id: 'V7SEC-SECRET-EXFIL', level: 'block', appliesTo: ['bash', 'python'], pattern: /\b(curl|wget|nc|netcat)\b[^|;&]*(~\/\.ssh|\.env|id_rsa|\.pem|Authorization)/i, message: 'sending credential material over the network' },
  { id: 'V7SEC-OUTSIDE-WRITE', level: 'block', appliesTo: ['bash'], pattern: />\s*(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|~\/)/, message: 'redirecting output outside the workspace' },
  { id: 'V7SEC-CHMOD-ROOT', level: 'block', appliesTo: ['bash'], pattern: /\bchmod\s+(-R\s+)?777\s+(\/|\$HOME|~)(\s|$)/i, message: 'chmod 777 on root or home' },
  { id: 'V7SEC-ENV-LEAK', level: 'block', appliesTo: ['bash'], pattern: /\benv\s*\|\s*(curl|wget|nc)\b/i, message: 'piping environment (may contain secrets) to the network' },
  // --- WARN: nguy hiểm trong workspace / thay đổi trạng thái ---
  { id: 'V7SEC-RM-RF-WORKSPACE', level: 'warn', appliesTo: ['bash'], pattern: /\brm\s+[^|;&]*?(-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*|-r\s+-f|-f\s+-r|--recursive)\b/i, message: 'recursive force delete inside workspace' },
  { id: 'V7SEC-RM-FILE', level: 'warn', appliesTo: ['bash'], pattern: /(^|[;&|]\s*)\s*rm\s+\S/i, message: 'deleting a file' },
  { id: 'V7SEC-DOWNLOAD', level: 'warn', appliesTo: ['bash'], pattern: /\b(curl|wget)\s+(-[A-Za-z]+\s+)*(https?:\/\/\S+)/i, message: 'downloading from the network' },
  { id: 'V7SEC-PKG-INSTALL', level: 'warn', appliesTo: ['bash'], pattern: /\b(npm\s+install|pip\s+install|pip3\s+install|apt(-get)?\s+install|brew\s+install)\b/i, message: 'installing packages' },
  { id: 'V7SEC-GIT-PUSH', level: 'warn', appliesTo: ['bash'], pattern: /\bgit\s+push\b/i, message: 'pushing to a remote git repository' },
  { id: 'V7SEC-GIT-RESET-HARD', level: 'warn', appliesTo: ['bash'], pattern: /\bgit\s+(reset\s+--hard|clean\s+-[fd]+)/i, message: 'destructive git operation' },
  { id: 'V7SEC-CHMOD-X', level: 'warn', appliesTo: ['bash'], pattern: /\bchmod\s+\+x\b/i, message: 'making a file executable' },
  { id: 'V7SEC-PY-EVAL', level: 'warn', appliesTo: ['python'], pattern: /\b(eval|exec|__import__)\s*\(/, message: 'dynamic code evaluation in Python' },
  { id: 'V7SEC-PY-OS-SYSTEM', level: 'warn', appliesTo: ['python'], pattern: /\b(os\.system|subprocess\.(run|call|Popen)|os\.popen)\s*\(/, message: 'shelling out from Python' },
  { id: 'V7SEC-PY-NETWORK', level: 'warn', appliesTo: ['python'], pattern: /\b(requests\.(get|post|put|delete)|urllib\.request\.urlopen|socket\.create_connection)\s*\(/, message: 'network call from Python' },
  { id: 'V7SEC-EDIT-SENSITIVE', level: 'warn', appliesTo: ['edit'], pattern: /(\.env|secret|credential|token|password)/i, message: 'editing a file that looks secret-bearing' },
  { id: 'V7SEC-READ-SENSITIVE', level: 'warn', appliesTo: ['read'], pattern: /(\.env|secret|credential|token|password)/i, message: 'reading a file that looks secret-bearing' },
];

/** Text cần quét của một action (code + path). */
export function v7ActionScannedText(action: V7Action): string {
  switch (action.kind) {
    case 'bash':
      return action.command;
    case 'python':
      return action.code;
    case 'edit':
      return `${action.path}\n${action.content}`;
    case 'read':
      return action.path;
    default:
      return '';
  }
}

/** Quét text thô với bảng rule (kind lọc rule áp dụng). */
export function scanV7Text(
  kind: 'bash' | 'python' | 'edit' | 'read' | 'any',
  text: string,
  rules: readonly V7SecurityRule[] = V7_SECURITY_RULES,
): V7SecurityFinding[] {
  const findings: V7SecurityFinding[] = [];
  for (const rule of rules) {
    if (!rule.appliesTo.includes('any') && !rule.appliesTo.includes(kind)) continue;
    const match = rule.pattern.exec(text);
    if (match) {
      findings.push({
        ruleId: rule.id,
        level: rule.level,
        message: rule.message,
        matched: clipMatch(match[0]),
      });
    }
    // Reset lastIndex cho regex có flag g (phòng khi rule dùng /g).
    rule.pattern.lastIndex = 0;
  }
  return findings;
}

/** Mức tổng hợp: block > warn > allow. */
export function aggregateV7Level(findings: readonly V7SecurityFinding[]): V7SecurityLevel {
  if (findings.some((f) => f.level === 'block')) return 'block';
  if (findings.some((f) => f.level === 'warn')) return 'warn';
  return 'allow';
}

/** Analyzer: quét một action, trả verdict + ghi audit (qua callback/log). */
export class V7SecurityAnalyzer {
  private readonly rules: readonly V7SecurityRule[];
  private readonly audit: V7SecurityAuditEntry[] = [];

  constructor(rules: readonly V7SecurityRule[] = V7_SECURITY_RULES) {
    this.rules = rules;
  }

  /** Quét một action, trả verdict (luôn ghi audit). */
  assess(action: V7Action): V7SecurityVerdict {
    const kind = action.kind === 'think' || action.kind === 'finish' || action.kind === 'ask' ? 'any' : action.kind;
    const text = v7ActionScannedText(action);
    const findings = kind === 'any' ? [] : scanV7Text(kind, text, this.rules);
    // Edit/read: kiểm tra path thoát workspace (.., absolute).
    if ((action.kind === 'edit' || action.kind === 'read') && isOutsideWorkspacePath(action.path)) {
      findings.push({
        ruleId: 'V7SEC-PATH-ESCAPE',
        level: 'block',
        message: 'path escapes the workspace (absolute or ..)',
        matched: clipMatch(action.path),
      });
    }
    const level = aggregateV7Level(findings);
    const verdict: V7SecurityVerdict = {
      level,
      findings,
      allowed: level !== 'block',
      summary:
        level === 'allow'
          ? 'clean'
          : `${level}: ${findings.map((f) => f.ruleId).join(', ')}`,
    };
    this.audit.push({
      at: new Date().toISOString(),
      kind: action.kind,
      level,
      ruleIds: findings.map((f) => f.ruleId),
      scanned: redactV7Secrets(clipMatch(text)),
    });
    return verdict;
  }

  /** Quét text thô (tiện cho tool `coding_v7_security`). */
  assessText(kind: 'bash' | 'python' | 'edit' | 'read', text: string): V7SecurityVerdict {
    const findings = scanV7Text(kind, text, this.rules);
    const level = aggregateV7Level(findings);
    this.audit.push({
      at: new Date().toISOString(),
      kind,
      level,
      ruleIds: findings.map((f) => f.ruleId),
      scanned: redactV7Secrets(clipMatch(text)),
    });
    return {
      level,
      findings,
      allowed: level !== 'block',
      summary: level === 'allow' ? 'clean' : `${level}: ${findings.map((f) => f.ruleId).join(', ')}`,
    };
  }

  /** Audit log (bản sao). */
  auditLog(): V7SecurityAuditEntry[] {
    return this.audit.map((e) => ({ ...e, ruleIds: [...e.ruleIds] }));
  }

  /** Số dòng audit theo mức. */
  auditStats(): Record<V7SecurityLevel, number> {
    const stats: Record<V7SecurityLevel, number> = { allow: 0, warn: 0, block: 0 };
    for (const entry of this.audit) stats[entry.level] += 1;
    return stats;
  }
}

/** true = path tuyệt đối hoặc chứa `..` (thoát workspace). */
export function isOutsideWorkspacePath(pathValue: string): boolean {
  if (pathValue.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pathValue)) return true;
  const parts = pathValue.split(/[\\/]+/);
  return parts.includes('..');
}

/** Chấm nhanh một action (không giữ audit) — tiện cho test/tool. */
export function assessV7Action(action: V7Action): V7SecurityVerdict {
  return new V7SecurityAnalyzer().assess(action);
}
