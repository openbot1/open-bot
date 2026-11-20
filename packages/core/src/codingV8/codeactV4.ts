/**
 * CodeAct-lite v4 (v1.16, Đội T4) — nối CodeAct-lite v3 của v7.
 *
 * Học ý tưởng CodeActAgent của OpenHands V1 SDK (survey v1.16 §5):
 * agent biểu diễn action bằng code (bash/Python) thay vì 20 tool
 * bespoke; host chạy code trong sandbox. v4 khác v3 ở 4 điểm:
 * - Sandbox policy TƯỜNG MINH, cấu hình được (`V8SandboxPolicy`):
 *   allowlist lệnh (token đầu tiên), blocklist pattern (rm -rf ngoài
 *   workspace, curl|sh, sudo, fork bomb, ghi ngoài workspace...),
 *   timeout trần, cờ `allowNetwork` (tắt → chặn curl/wget/fetch),
 *   env đã lược (không forward secret host, chỉ giữ PATH/HOME/LANG
 *   + biến do host cho phép).
 * - Observation CHUẨN HÓA: stdout/stderr cắt ngắn + redact secret +
 *   trim, kèm `policy` (allow/deny), `policyDenial`, `securityLevel`
 *   (từ security v2: taint scan nhanh trên code action) trong mọi
 *   observation — agent luôn biết vì sao một action bị chặn.
 * - Action `script`: nhiều bước bash/python liên tiếp trong một
 *   action, dừng ở lỗi đầu (mặc định), trả `stepResults` từng bước.
 * - Executor KHÔNG tự tạo thư mục ngoài working dir, KHÔNG chạy
 *   lệnh ngoài allowlist khi policy ở chế độ `strict` (mặc định);
 *   chế độ `permissive` chỉ chặn blocklist (dùng cho repo tin cậy,
 *   phải bật tường minh).
 *
 * Giới hạn trung thực: bash/python đi qua BotBoxManager; isolation
 * none hoặc backend lỗi thì bị từ chối, không fallback về host. Đây
 * không phải VM; unshare yếu hơn bwrap (không cô lập mount). edit/read
 * vẫn thao tác trực tiếp trên workingDir được caller cấp.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotBoxManager } from '../sandbox/box';
import { detectIsolation } from '../sandbox/env';
import { analyzeV8Taint, scanV8Secrets } from './securityV2';
import type { V8CodeActAction, V8Observation, V8PolicyDenial, V8PolicyDecision, V8SecurityLevel } from './types';

/** Timeout mặc định cho bash/python, ms. */
export const V8_CODEACT_DEFAULT_TIMEOUT_MS = 30_000;
/** Timeout tối đa cho phép. */
export const V8_CODEACT_MAX_TIMEOUT_MS = 120_000;
/** Giới hạn stdout/stderr mỗi action, ký tự. */
export const V8_CODEACT_OUTPUT_LIMIT = 20_000;
/** Số bước tối đa trong một action script. */
export const V8_CODEACT_MAX_SCRIPT_STEPS = 20;

/** Lệnh được phép theo mặc định (token đầu tiên của command). */
export const V8_DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'echo', 'ls', 'cat', 'pwd', 'cd', 'mkdir', 'touch', 'cp', 'mv', 'rm',
  'grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'find', 'which',
  'node', 'npm', 'npx', 'python3', 'python', 'pip3', 'pip', 'git',
  'tsc', 'jest', 'vitest', 'make', 'sleep', 'date', 'env', 'printenv',
  'curl', 'wget', 'tar', 'unzip', 'zip', 'sed', 'awk', 'cut', 'tr',
  'test', 'true', 'false', 'printf', 'basename', 'dirname', 'realpath',
  'exit', 'export', 'set', 'unset',
];

/** Pattern chặn tuyệt đối (bất kể policy mode). */
export const V8_CODEACT_BLOCK_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; message: string }> = [
  { id: 'V8POL-RM-RF-ROOT', pattern: /\brm\s+[^|;&]*?(-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b[^|;&]*?\s+(\/|\$HOME|\$USERPROFILE|~)(\s|[/\\]|$|[;&|])/, message: 'rm -rf targeting filesystem root or home directory' },
  { id: 'V8POL-RM-NO-PRESERVE', pattern: /\brm\s+[^|;&]*--no-preserve-root\b/, message: 'rm with --no-preserve-root' },
  { id: 'V8POL-CURL-PIPE-SH', pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python3?)\b/i, message: 'piping downloaded content straight into a shell' },
  { id: 'V8POL-SUDO-SU', pattern: /(^|[;&|]\s*)\s*(sudo|su\s|doas\s)\b/i, message: 'privilege escalation (sudo/su/doas)' },
  { id: 'V8POL-FORK-BOMB', pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, message: 'fork bomb pattern' },
  { id: 'V8POL-MKFS-DD', pattern: /\b(mkfs|dd\s+[^|;&]*of=\/dev\/|fdisk)\b/i, message: 'disk formatting / raw device write' },
  { id: 'V8POL-OUTSIDE-REDIRECT', pattern: />\s*(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|~\/)/, message: 'redirecting output outside the workspace' },
  { id: 'V8POL-CHMOD-ROOT', pattern: /\bchmod\s+(-R\s+)?777\s+(\/|\$HOME|~)(\s|$)/i, message: 'chmod 777 on root or home' },
  { id: 'V8POL-ENV-LEAK', pattern: /\benv\s*\|\s*(curl|wget|nc)\b/i, message: 'piping environment (may contain secrets) to the network' },
  { id: 'V8POL-SECRET-READ', pattern: /(\.ssh\/|\.aws\/credentials|\.gnupg\/|id_rsa|id_ed25519|\.pem\b|credentials\.json)/i, message: 'reading private credentials / secret files' },
];

/** Chế độ policy: strict = allowlist, permissive = chỉ blocklist. */
export type V8PolicyMode = 'strict' | 'permissive';

/** Sandbox policy cho CodeAct v4. */
export interface V8SandboxPolicy {
  mode: V8PolicyMode;
  /** Lệnh cho phép (token đầu tiên). Mặc định V8_DEFAULT_ALLOWED_COMMANDS. */
  allowedCommands: string[];
  /** Cho phép gọi mạng (curl/wget/fetch) hay không. Mặc định false. */
  allowNetwork: boolean;
  /** Timeout tối đa cho một action, ms. */
  maxTimeoutMs: number;
  /** Biến môi trường host được phép forward thêm (ngoài PATH/HOME/LANG). */
  allowedEnvVars: string[];
}

/** Policy mặc định: strict, không mạng. */
export function defaultV8SandboxPolicy(overrides: Partial<V8SandboxPolicy> = {}): V8SandboxPolicy {
  return {
    mode: 'strict',
    allowedCommands: [...V8_DEFAULT_ALLOWED_COMMANDS],
    allowNetwork: false,
    maxTimeoutMs: V8_CODEACT_MAX_TIMEOUT_MS,
    allowedEnvVars: [],
    ...overrides,
  };
}

/** Redact secret trong output trước khi đưa vào observation/log. */
export function redactV8Text(text: string): string {
  return text
    .replace(/(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*['"]?[^'"\s]{4,}['"]?/gi, '$1=[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
    .replace(/(ghp_[A-Za-z0-9]{8,})/g, '[REDACTED]')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[REDACTED]');
}

/** Cắt ngắn + redact + trim output cho observation. */
export function normalizeV8Output(text: string, limit: number = V8_CODEACT_OUTPUT_LIMIT): string {
  const redacted = redactV8Text(text);
  const trimmed = redacted.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}… (truncated)`;
}

/** Tách token đầu tiên của một command (bỏ `VAR=x` prefix + sudo đã chặn). */
export function v8FirstCommandToken(command: string): string {
  const parts = command.trim().split(/\s+/);
  for (const part of parts) {
    if (/^[A-Za-z_][\w$]*=/.test(part)) continue; // VAR=x prefix
    return part.replace(/^["']/, '');
  }
  return '';
}

/** Tách command thành các lệnh con theo `;`, `&&`, `||`, `|` để kiểm tra từng lệnh. */
export function v8SplitCommandSegments(command: string): string[] {
  return command.split(/(?:;|&&|\|\||\|)/).map((s) => s.trim()).filter(Boolean);
}

/** Kiểm tra một action với policy → quyết định allow/deny + lý do. */
export function checkV8Policy(
  action: V8CodeActAction,
  policy: V8SandboxPolicy,
  workingDir: string,
): { decision: V8PolicyDecision; denial?: V8PolicyDenial } {
  const deny = (ruleId: string, message: string): { decision: V8PolicyDecision; denial: V8PolicyDenial } => ({
    decision: 'deny',
    denial: { ruleId, message },
  });
  const texts: Array<{ kind: string; text: string }> = [];
  if (action.kind === 'bash') texts.push({ kind: 'bash', text: action.command });
  else if (action.kind === 'python') texts.push({ kind: 'python', text: action.code });
  else if (action.kind === 'script') {
    for (const step of action.steps) texts.push({ kind: step.kind, text: step.code });
  } else if (action.kind === 'edit' || action.kind === 'read') {
    const p = action.path;
    if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.split(/[\\/]+/).includes('..')) {
      return deny('V8POL-PATH-ESCAPE', `path escapes the workspace: ${p}`);
    }
    if (action.kind === 'edit') texts.push({ kind: 'edit', text: `${action.path}\n${action.content}` });
    else return { decision: 'allow' };
  }
  for (const { kind, text } of texts) {
    // Blocklist tuyệt đối (áp dụng cho mọi mode, mọi kind code).
    for (const rule of V8_CODEACT_BLOCK_PATTERNS) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(text)) return deny(rule.id, rule.message);
    }
    if (kind === 'bash') {
      // Chặn mạng khi allowNetwork = false.
      if (!policy.allowNetwork && /\b(curl|wget|nc|netcat|ftp|scp|rsync)\b/i.test(text)) {
        return deny('V8POL-NETWORK-DISABLED', 'network commands are disabled by policy (allowNetwork=false)');
      }
      // Strict mode: mọi segment đều phải bắt đầu bằng lệnh trong allowlist.
      if (policy.mode === 'strict') {
        for (const segment of v8SplitCommandSegments(text)) {
          const token = v8FirstCommandToken(segment);
          if (!token) continue;
          if (!policy.allowedCommands.includes(token)) {
            return deny('V8POL-CMD-NOT-ALLOWED', `command not in allowlist (strict mode): ${token}`);
          }
        }
      }
      // Chặn rm -rf ngoài workspace ngay cả khi target là path tương đối thoát ra ngoài.
      if (/\brm\s+[^|;&]*-r/i.test(text) && /\.\.\//.test(text)) {
        return deny('V8POL-RM-OUTSIDE', 'recursive delete with .. path (outside workspace)');
      }
    }
    if (kind === 'python') {
      // Python: chặn eval mã tải từ mạng + ghi đè ngoài workspace (pattern).
      if (/\b(eval|exec)\s*\(\s*(requests|urllib)[^)]*\)/i.test(text)) {
        return deny('V8POL-PY-REMOTE-EVAL', 'evaluating code fetched from the network');
      }
      if (/\bopen\s*\([^)]*['"]\s*(\/etc\/|\/usr\/|~\/)/.test(text)) {
        return deny('V8POL-PY-OUTSIDE-WRITE', 'opening a file outside the workspace');
      }
      if (!policy.allowNetwork && /\b(requests\.(get|post|put|delete)|urllib\.request\.urlopen|socket\.create_connection)\s*\(/.test(text)) {
        return deny('V8POL-NETWORK-DISABLED', 'network calls are disabled by policy (allowNetwork=false)');
      }
    }
  }
  void workingDir;
  return { decision: 'allow' };
}

/** Mức security v2 nhanh cho một action (taint + secret scan trên code). */
export function v8ActionSecurityLevel(action: V8CodeActAction): V8SecurityLevel {
  const text = action.kind === 'bash' ? action.command
    : action.kind === 'python' ? action.code
    : action.kind === 'edit' ? `${action.path}\n${action.content}`
    : action.kind === 'read' ? action.path
    : action.steps.map((s) => s.code).join('\n');
  const secrets = scanV8Secrets(text, '<action>');
  if (secrets.some((s) => s.level === 'block')) return 'block';
  const flows = analyzeV8Taint(text, '<action>');
  if (flows.some((f) => f.level === 'block')) return 'block';
  if (secrets.length > 0 || flows.length > 0) return 'warn';
  return 'allow';
}

export interface V8CodeActExecutorOptions {
  workingDir: string;
  policy?: V8SandboxPolicy;
  /** Timeout mặc định cho bash/python, ms. */
  defaultTimeoutMs?: number;
}

export interface V8ExecuteResult {
  observation: V8Observation;
  /** Quyết định policy. */
  policy: V8PolicyDecision;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  writeCapExceeded: boolean;
}

/** Executor CodeAct v4: policy gate → security scan → chạy thật trong working dir bị nhốt. */
export class V8CodeActExecutor {
  readonly workingDir: string;
  readonly policy: V8SandboxPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly boxes: BotBoxManager;
  private readonly boxId = 'coding-v8';
  private readonly boxHomeDir: string;
  private readonly forwardedEnvNames: string[];

  constructor(options: V8CodeActExecutorOptions) {
    this.workingDir = path.resolve(options.workingDir);
    this.policy = options.policy ?? defaultV8SandboxPolicy();
    this.defaultTimeoutMs = Math.min(
      options.defaultTimeoutMs ?? V8_CODEACT_DEFAULT_TIMEOUT_MS,
      this.policy.maxTimeoutMs,
    );
    fs.mkdirSync(this.workingDir, { recursive: true });

    // Keep only explicitly allowed, non-secret extra variables. HOME is
    // always replaced with a private directory inside the box's tmp mount.
    const boxDefaultEnv = new Set([
      'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER', 'SHELL',
      'NO_COLOR', 'FORCE_COLOR', 'OPENBOT_BOX_ID', 'OPENBOT_BOT_ID',
    ]);
    const secretEnvName = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;
    this.forwardedEnvNames = [...new Set(this.policy.allowedEnvVars.filter((name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !boxDefaultEnv.has(name) &&
      !secretEnvName.test(name),
    ))];

    const boxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-codeact-v8-'));
    this.boxes = new BotBoxManager({ rootDir: boxRoot });
    const detectedIsolation = detectIsolation().kind;
    // unshare only provides user/pid namespaces, not mount confinement; do not
    // treat it as sufficient isolation for untrusted CodeAct execution.
    const requiredIsolation = detectedIsolation === 'bwrap' || detectedIsolation === 'sandbox-exec'
      ? detectedIsolation
      : 'none';
    const box = this.boxes.createBox(this.boxId, {
      workspaceDir: this.workingDir,
      envAllowlist: ['HOME', ...this.forwardedEnvNames],
      isolation: requiredIsolation,
    });
    this.boxHomeDir = path.join(box.dir, 'tmp', 'home');
    fs.mkdirSync(this.boxHomeDir, { recursive: true, mode: 0o700 });
  }

  private sandboxEnvValues(): Record<string, string> {
    const values: Record<string, string> = { HOME: this.boxHomeDir };
    for (const name of this.forwardedEnvNames) {
      const value = process.env[name];
      if (typeof value === 'string') values[name] = value;
    }
    return values;
  }

  private async runSandboxedProcess(
    command: string,
    args: string[],
    options: { timeoutMs: number; stdin?: string },
  ): Promise<ProcessResult> {
    const result = await this.boxes.runInBox(this.boxId, command, args, {
      timeoutMs: options.timeoutMs,
      maxWriteBytes: Number.POSITIVE_INFINITY,
      maxOutputChars: V8_CODEACT_OUTPUT_LIMIT * 2,
      envValues: this.sandboxEnvValues(),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      requireIsolation: true,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      writeCapExceeded: result.writeCapExceeded,
    };
  }

  private resolveInWorkspace(relPath: string): string | null {
    const resolved = path.resolve(this.workingDir, relPath);
    const rel = path.relative(this.workingDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return resolved;
  }

  private blockedObservation(
    action: V8CodeActAction,
    denial: V8PolicyDenial,
    securityLevel: V8SecurityLevel,
  ): V8Observation {
    return {
      action,
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      blocked: true,
      blockReason: `${denial.ruleId}: ${denial.message}`,
      policy: 'deny',
      policyDenial: denial,
      securityLevel,
      durationMs: 0,
    };
  }

  /** Chạy một action (policy gate trước, security scan kèm theo). */
  async execute(action: V8CodeActAction): Promise<V8ExecuteResult> {
    const startedAt = Date.now();
    const securityLevel = v8ActionSecurityLevel(action);
    const check = checkV8Policy(action, this.policy, this.workingDir);
    if (check.decision === 'deny' && check.denial) {
      return { observation: this.blockedObservation(action, check.denial, securityLevel), policy: 'deny' };
    }
    if (securityLevel === 'block') {
      return {
        observation: this.blockedObservation(
          action,
          { ruleId: 'V8SEC-TAINT-BLOCK', message: 'security v2: tainted data reaches a dangerous sink (or a high-confidence secret is present)' },
          securityLevel,
        ),
        policy: 'deny',
      };
    }
    const finish = (partial: Omit<V8Observation, 'policy' | 'securityLevel' | 'durationMs' | 'action'>): V8Observation => ({
      action,
      policy: 'allow',
      securityLevel,
      durationMs: Date.now() - startedAt,
      ...partial,
    });

    switch (action.kind) {
      case 'bash': {
        const timeoutMs = Math.min(action.timeoutMs ?? this.defaultTimeoutMs, this.policy.maxTimeoutMs);
        try {
          const result = await this.runSandboxedProcess('bash', ['-c', action.command], { timeoutMs });
          return {
            observation: finish({
              ok: !result.timedOut && !result.writeCapExceeded && result.exitCode === 0,
              stdout: normalizeV8Output(result.stdout),
              stderr: normalizeV8Output(result.stderr),
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              blocked: false,
            }),
            policy: 'allow',
          };
        } catch (err) {
          const denial: V8PolicyDenial = {
            ruleId: 'V8SEC-REQUIRE-ISOLATION',
            message: err instanceof Error ? err.message : String(err),
          };
          return { observation: this.blockedObservation(action, denial, securityLevel), policy: 'deny' };
        }
      }
      case 'python': {
        const timeoutMs = Math.min(action.timeoutMs ?? this.defaultTimeoutMs, this.policy.maxTimeoutMs);
        try {
          const result = await this.runSandboxedProcess('python3', ['-'], { timeoutMs, stdin: action.code });
          return {
            observation: finish({
              ok: !result.timedOut && !result.writeCapExceeded && result.exitCode === 0,
              stdout: normalizeV8Output(result.stdout),
              stderr: normalizeV8Output(result.stderr),
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              blocked: false,
            }),
            policy: 'allow',
          };
        } catch (err) {
          const denial: V8PolicyDenial = {
            ruleId: 'V8SEC-REQUIRE-ISOLATION',
            message: err instanceof Error ? err.message : String(err),
          };
          return { observation: this.blockedObservation(action, denial, securityLevel), policy: 'deny' };
        }
      }
      case 'edit': {
        const resolved = this.resolveInWorkspace(action.path);
        if (!resolved) {
          return {
            observation: finish({
              ok: false,
              stdout: '',
              stderr: `path escapes workspace: ${action.path}`,
              exitCode: null,
              timedOut: false,
              blocked: true,
              blockReason: 'V8POL-PATH-ESCAPE: path escapes the workspace',
            }),
            policy: 'deny',
          };
        }
        try {
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          if (action.mode === 'append') fs.appendFileSync(resolved, action.content, 'utf8');
          else fs.writeFileSync(resolved, action.content, 'utf8');
          const bytes = Buffer.byteLength(action.content, 'utf8');
          return {
            observation: finish({
              ok: true,
              stdout: `wrote ${action.path} (${bytes} bytes)`,
              stderr: '',
              exitCode: 0,
              timedOut: false,
              blocked: false,
              fileWritten: { path: action.path, bytes },
            }),
            policy: 'allow',
          };
        } catch (err) {
          return {
            observation: finish({
              ok: false,
              stdout: '',
              stderr: err instanceof Error ? err.message : String(err),
              exitCode: null,
              timedOut: false,
              blocked: false,
            }),
            policy: 'allow',
          };
        }
      }
      case 'read': {
        const resolved = this.resolveInWorkspace(action.path);
        if (!resolved) {
          return {
            observation: finish({
              ok: false,
              stdout: '',
              stderr: `path escapes workspace: ${action.path}`,
              exitCode: null,
              timedOut: false,
              blocked: true,
              blockReason: 'V8POL-PATH-ESCAPE: path escapes the workspace',
            }),
            policy: 'deny',
          };
        }
        try {
          const content = fs.readFileSync(resolved, 'utf8');
          const maxLines = action.maxLines ?? 200;
          const lines = content.split('\n').slice(0, maxLines).join('\n');
          return {
            observation: finish({
              ok: true,
              stdout: normalizeV8Output(lines),
              stderr: '',
              exitCode: 0,
              timedOut: false,
              blocked: false,
            }),
            policy: 'allow',
          };
        } catch {
          return {
            observation: finish({
              ok: false,
              stdout: '',
              stderr: `file not found: ${action.path}`,
              exitCode: null,
              timedOut: false,
              blocked: false,
            }),
            policy: 'allow',
          };
        }
      }
      case 'script': {
        const stepResults: NonNullable<V8Observation['stepResults']> = [];
        let allOk = true;
        let denied = false;
        let denial: V8PolicyDenial | undefined;
        for (let i = 0; i < Math.min(action.steps.length, V8_CODEACT_MAX_SCRIPT_STEPS); i += 1) {
          const step = action.steps[i];
          if (!step) break;
          const sub = step.kind === 'bash'
            ? { kind: 'bash' as const, command: step.code, timeoutMs: step.timeoutMs }
            : { kind: 'python' as const, code: step.code, timeoutMs: step.timeoutMs };
          const result = await this.execute(sub);
          stepResults.push({
            index: i,
            ok: result.observation.ok,
            stdout: result.observation.stdout,
            stderr: result.observation.stderr,
            exitCode: result.observation.exitCode,
            timedOut: result.observation.timedOut,
          });
          if (result.policy === 'deny') {
            denied = true;
            denial = result.observation.policyDenial ?? {
              ruleId: 'V8SEC-REQUIRE-ISOLATION',
              message: result.observation.blockReason ?? 'sandbox denied code execution',
            };
          }
          if (!result.observation.ok) {
            allOk = false;
            if (action.stopOnFailure !== false) break;
          }
        }
        return {
          observation: {
            ...finish({
            ok: allOk,
            stdout: stepResults.map((s) => s.stdout).filter(Boolean).join('\n'),
            stderr: stepResults.map((s) => s.stderr).filter(Boolean).join('\n'),
            exitCode: allOk ? 0 : 1,
            timedOut: stepResults.some((s) => s.timedOut),
            blocked: denied || stepResults.length === 0,
            ...(denial ? { blockReason: `${denial.ruleId}: ${denial.message}`, policyDenial: denial } : {}),
            stepResults,
            }),
            ...(denied ? { policy: 'deny' as const } : {}),
          },
          policy: denied ? 'deny' : 'allow',
        };
      }
      default:
        return {
          observation: finish({
            ok: false,
            stdout: '',
            stderr: `unknown action kind: ${(action as { kind: string }).kind}`,
            exitCode: null,
            timedOut: false,
            blocked: false,
          }),
          policy: 'allow',
        };
    }
  }

  /** Chạy nhiều action liên tiếp, dừng ở lỗi đầu (mặc định). */
  async executeAll(actions: readonly V8CodeActAction[], stopOnFailure = true): Promise<V8ExecuteResult[]> {
    const results: V8ExecuteResult[] = [];
    for (const action of actions) {
      const result = await this.execute(action);
      results.push(result);
      if (stopOnFailure && !result.observation.ok) break;
    }
    return results;
  }
}
