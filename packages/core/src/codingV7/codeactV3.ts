/**
 * CodeAct-lite v3 (v1.15, Đội T4) — agent biểu diễn action bằng code.
 *
 * Học ý tưởng CodeActAgent của OpenHands V1 SDK (survey v1.15 §3):
 * thay vì 20 tool bespoke, agent viết code (bash + Python + file ops)
 * và host chạy code đó trong sandbox. Nối codeact (v1.04) và
 * CodeAct-lite v2 (v1.14), nhưng v7 viết lại parser + executor từ đầu:
 * - Parser v3: MỘT khối code duy nhất chứa nhiều action — fenced block
 *   ```bash / ```python / ```edit / ```read / ```think / ```finish /
 *   ```ask — cộng JSON array/object và dòng `ACTION: ...` dạng text.
 *   Parser trả cả action lẫn lỗi parse (không throw giữa chừng).
 * - Executor v3: tự chủ, chạy thật bằng child_process trong working
 *   dir bị nhốt — KHÔNG cần BotBox/host. Timeout kill process group,
 *   giới hạn stdout/stderr, env đã lược (không forward secret của
 *   host), chặn path thoát workspace ở mọi file op. Bash chạy qua
 *   `bash -c`, Python qua `python3 -` (stdin = code).
 * - Security gate tích hợp: executor LUÔN quét bằng V7SecurityAnalyzer
 *   trước khi chạy; block → observation blocked, không chạy.
 *
 * Giới hạn (ghi rõ, không giấu): executor chạy trên máy host với user
 * hiện tại — không phải VM/container cách ly; chặn lệnh nguy hiểm dựa
 * trên pattern (không phải syscall sandbox); không giới hạn CPU/RAM
 * ngoài timeout + output cap. Dùng cho repo mẫu / workspace tin cậy.
 */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { V7Action, V7Observation, V7SecurityVerdict } from './types';
import { V7SecurityAnalyzer, isOutsideWorkspacePath } from './security';

/** Timeout mặc định cho bash/python, ms. */
export const V7_CODEACT_DEFAULT_TIMEOUT_MS = 30_000;
/** Timeout tối đa cho phép (tool/host không được đặt cao hơn). */
export const V7_CODEACT_MAX_TIMEOUT_MS = 120_000;
/** Giới hạn stdout/stderr mỗi action, ký tự. */
export const V7_CODEACT_OUTPUT_LIMIT = 20_000;
/** Số action tối đa parse được từ một text model. */
export const V7_CODEACT_MAX_ACTIONS_PER_TEXT = 20;

/** Kết quả parse text model → actions. */
export interface V7ParseResult {
  actions: V7Action[];
  /** Lỗi parse (khối không nhận dạng được, JSON hỏng...). */
  errors: string[];
}

/** Lỗi khi parse một khối fenced. */
function parseFencedBlock(lang: string, body: string, errors: string[]): V7Action | null {
  const text = body.replace(/\r\n/g, '\n');
  switch (lang) {
    case 'bash':
    case 'sh':
      return text.trim() ? { kind: 'bash', command: text.trim() } : null;
    case 'python':
    case 'py':
      return text.trim() ? { kind: 'python', code: text.trim() } : null;
    case 'edit': {
      // Dòng đầu: path [+ mode append]. Phần còn lại là nội dung.
      const lines = text.split('\n');
      const header = (lines[0] ?? '').trim();
      if (!header) {
        errors.push('edit block is missing a path on the first line');
        return null;
      }
      const [rawPath, rawMode] = header.split(/\s+/);
      if (!rawPath) {
        errors.push('edit block is missing a path on the first line');
        return null;
      }
      const mode = rawMode === 'append' ? 'append' : 'write';
      let content = lines.slice(1).join('\n');
      // Fenced block luôn kết thúc bằng '\n' trước ``` — bỏ một newline
      // cuối để nội dung file khớp đúng ý model.
      if (content.endsWith('\n')) content = content.slice(0, -1);
      return { kind: 'edit', path: rawPath, content, mode };
    }
    case 'read': {
      const header = text.trim().split(/\s+/);
      if (!header[0]) {
        errors.push('read block is missing a path');
        return null;
      }
      const maxLines = header[1] ? Number.parseInt(header[1], 10) : undefined;
      return {
        kind: 'read',
        path: header[0],
        ...(Number.isFinite(maxLines) && (maxLines as number) > 0 ? { maxLines: maxLines as number } : {}),
      };
    }
    case 'think':
      return text.trim() ? { kind: 'think', text: text.trim() } : null;
    case 'finish':
      return { kind: 'finish', summary: text.trim() || 'done', done: true };
    case 'ask': {
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const question = lines[0] ?? '';
      const options = lines.slice(1).map((l) => l.replace(/^[-*]\s*/, ''));
      if (!question) {
        errors.push('ask block is missing a question');
        return null;
      }
      return { kind: 'ask', question, ...(options.length ? { options } : {}) };
    }
    default:
      errors.push(`unknown fenced block language: ${lang}`);
      return null;
  }
}

/** Parse một action từ object (JSON / tool-call args). */
export function parseV7ActionFromObject(value: unknown): V7Action | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const kind = obj['kind'];
  if (kind === 'bash' && typeof obj['command'] === 'string') {
    return { kind: 'bash', command: obj['command'], ...(typeof obj['timeoutMs'] === 'number' ? { timeoutMs: obj['timeoutMs'] } : {}) };
  }
  if (kind === 'python' && typeof obj['code'] === 'string') {
    return { kind: 'python', code: obj['code'], ...(typeof obj['timeoutMs'] === 'number' ? { timeoutMs: obj['timeoutMs'] } : {}) };
  }
  if (kind === 'edit' && typeof obj['path'] === 'string' && typeof obj['content'] === 'string') {
    return { kind: 'edit', path: obj['path'], content: obj['content'], mode: obj['mode'] === 'append' ? 'append' : 'write' };
  }
  if (kind === 'read' && typeof obj['path'] === 'string') {
    return { kind: 'read', path: obj['path'], ...(typeof obj['maxLines'] === 'number' ? { maxLines: obj['maxLines'] } : {}) };
  }
  if (kind === 'think' && typeof obj['text'] === 'string') return { kind: 'think', text: obj['text'] };
  if (kind === 'finish' && typeof obj['summary'] === 'string') {
    return { kind: 'finish', summary: obj['summary'], ...(typeof obj['done'] === 'boolean' ? { done: obj['done'] } : {}) };
  }
  if (kind === 'ask' && typeof obj['question'] === 'string') {
    return {
      kind: 'ask',
      question: obj['question'],
      ...(Array.isArray(obj['options']) ? { options: obj['options'].filter((o): o is string => typeof o === 'string') } : {}),
    };
  }
  return null;
}

const FENCED_RE = /```([A-Za-z]+)\n([\s\S]*?)```/g;
const JSON_BLOCK_RE = /```json\n([\s\S]*?)```/;

/** Parse tất cả action từ text model trả về. */
export function parseV7ActionsFromText(text: string): V7ParseResult {
  const actions: V7Action[] = [];
  const errors: string[] = [];
  if (!text || !text.trim()) return { actions, errors: ['empty model output'] };

  // 1) JSON block: ```json { ... } hoặc [ ... ] (ưu tiên khi có).
  const jsonMatch = JSON_BLOCK_RE.exec(text);
  if (jsonMatch?.[1]) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const action = parseV7ActionFromObject(item);
        if (action) actions.push(action);
        else errors.push(`unrecognized JSON action: ${JSON.stringify(item).slice(0, 120)}`);
      }
      if (actions.length > 0) return { actions: actions.slice(0, V7_CODEACT_MAX_ACTIONS_PER_TEXT), errors };
    } catch (err) {
      errors.push(`invalid JSON block: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2) Fenced blocks theo ngôn ngữ.
  let match: RegExpExecArray | null;
  FENCED_RE.lastIndex = 0;
  while ((match = FENCED_RE.exec(text)) !== null) {
    const lang = (match[1] ?? '').toLowerCase();
    if (lang === 'json') continue; // đã xử lý ở trên
    const action = parseFencedBlock(lang, match[2] ?? '', errors);
    if (action) actions.push(action);
    if (actions.length >= V7_CODEACT_MAX_ACTIONS_PER_TEXT) break;
  }

  // 3) Dòng ACTION: <kind> <nội dung> (fallback text thuần).
  if (actions.length === 0) {
    for (const line of text.split('\n')) {
      const m = /^ACTION:\s*(bash|python|think|finish|ask)\s*:\s*(.+)$/i.exec(line.trim());
      if (!m) continue;
      const kind = (m[1] ?? '').toLowerCase();
      const body = m[2] ?? '';
      if (kind === 'bash') actions.push({ kind: 'bash', command: body });
      else if (kind === 'python') actions.push({ kind: 'python', code: body });
      else if (kind === 'think') actions.push({ kind: 'think', text: body });
      else if (kind === 'finish') actions.push({ kind: 'finish', summary: body, done: true });
      else if (kind === 'ask') actions.push({ kind: 'ask', question: body });
    }
  }

  if (actions.length === 0 && errors.length === 0) {
    errors.push('no recognizable action block found (expected ```bash/```python/```edit/```read/```think/```finish/```ask or JSON)');
  }
  return { actions: actions.slice(0, V7_CODEACT_MAX_ACTIONS_PER_TEXT), errors };
}

/** Chữ ký ngắn của action (để dedupe/log). */
export function v7ActionSignature(action: V7Action): string {
  switch (action.kind) {
    case 'bash':
      return `bash:${action.command.slice(0, 80)}`;
    case 'python':
      return `python:${action.code.slice(0, 80)}`;
    case 'edit':
      return `edit:${action.mode}:${action.path}`;
    case 'read':
      return `read:${action.path}`;
    case 'think':
      return `think:${action.text.slice(0, 80)}`;
    case 'finish':
      return `finish:${action.summary.slice(0, 80)}`;
    case 'ask':
      return `ask:${action.question.slice(0, 80)}`;
  }
}

/** Validate action trước khi chạy (ngoài security scan). */
export function validateV7Action(action: V7Action): string | null {
  switch (action.kind) {
    case 'bash':
      if (!action.command.trim()) return 'bash command is empty';
      if (action.timeoutMs !== undefined && (action.timeoutMs <= 0 || action.timeoutMs > V7_CODEACT_MAX_TIMEOUT_MS)) {
        return `bash timeoutMs must be 1..${V7_CODEACT_MAX_TIMEOUT_MS}`;
      }
      return null;
    case 'python':
      if (!action.code.trim()) return 'python code is empty';
      if (action.timeoutMs !== undefined && (action.timeoutMs <= 0 || action.timeoutMs > V7_CODEACT_MAX_TIMEOUT_MS)) {
        return `python timeoutMs must be 1..${V7_CODEACT_MAX_TIMEOUT_MS}`;
      }
      return null;
    case 'edit':
      if (!action.path.trim()) return 'edit path is empty';
      if (isOutsideWorkspacePath(action.path)) return `edit path escapes workspace: ${action.path}`;
      return null;
    case 'read':
      if (!action.path.trim()) return 'read path is empty';
      if (isOutsideWorkspacePath(action.path)) return `read path escapes workspace: ${action.path}`;
      return null;
    case 'think':
      return action.text.trim() ? null : 'think text is empty';
    case 'finish':
      return action.summary.trim() ? null : 'finish summary is empty';
    case 'ask':
      return action.question.trim() ? null : 'ask question is empty';
  }
}

function clipOutput(text: string): string {
  return text.length <= V7_CODEACT_OUTPUT_LIMIT ? text : `${text.slice(0, V7_CODEACT_OUTPUT_LIMIT)}\n…[truncated, ${text.length - V7_CODEACT_OUTPUT_LIMIT} more chars]`;
}

/** Env tối thiểu cho process con (không forward secret của host). */
function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; stdin?: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: cleanEnv(),
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Timer riêng (không dùng spawn `timeout`: nó kill mà không báo
    // timedOut rõ ràng — close tới trước khi timer của ta kịp chạy).
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > V7_CODEACT_OUTPUT_LIMIT * 2) child.kill('SIGKILL');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > V7_CODEACT_OUTPUT_LIMIT * 2) child.kill('SIGKILL');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: clipOutput(stdout), stderr: err.message, exitCode: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: clipOutput(stdout), stderr: clipOutput(stderr), exitCode: code, timedOut });
    });
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

/** Tùy chọn executor v3. */
export interface V7CodeActExecutorOptions {
  /** Working dir bị nhốt — mọi bash/python/file op đều trong này. */
  workingDir: string;
  /** Analyzer riêng (mặc định tạo mới). */
  analyzer?: V7SecurityAnalyzer;
  /** Timeout mặc định, ms. */
  defaultTimeoutMs?: number;
}

/** Kết quả execute kèm verdict (để agent ghi log). */
export interface V7ExecuteResult {
  observation: V7Observation;
  verdict: V7SecurityVerdict | null;
}

/**
 * Executor CodeAct-lite v3: chạy action thật trong working dir bị nhốt,
 * luôn quét security trước.
 */
export class V7CodeActExecutor {
  readonly workingDir: string;
  private readonly analyzer: V7SecurityAnalyzer;
  private readonly defaultTimeoutMs: number;

  constructor(options: V7CodeActExecutorOptions) {
    this.workingDir = path.resolve(options.workingDir);
    this.analyzer = options.analyzer ?? new V7SecurityAnalyzer();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? V7_CODEACT_DEFAULT_TIMEOUT_MS;
    fs.mkdirSync(this.workingDir, { recursive: true });
  }

  /** Resolve path tương đối trong working dir (throw khi thoát). */
  resolveInWorkspace(relPath: string): string {
    if (isOutsideWorkspacePath(relPath)) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    const resolved = path.resolve(this.workingDir, relPath);
    const rel = path.relative(this.workingDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return resolved;
  }

  /** Chạy một action → observation (+ verdict). */
  async execute(action: V7Action): Promise<V7ExecuteResult> {
    const started = Date.now();
    const validationError = validateV7Action(action);
    if (validationError) {
      return {
        observation: {
          action, ok: false, stdout: '', stderr: validationError,
          exitCode: null, timedOut: false, blocked: false, durationMs: Date.now() - started,
        },
        verdict: null,
      };
    }

    // think/finish/ask không chạy code — không cần quét.
    if (action.kind === 'think' || action.kind === 'finish' || action.kind === 'ask') {
      const stdout = action.kind === 'think' ? action.text : action.kind === 'finish' ? action.summary : action.question;
      return {
        observation: {
          action, ok: true, stdout, stderr: '', exitCode: null,
          timedOut: false, blocked: false, durationMs: Date.now() - started,
        },
        verdict: null,
      };
    }

    const verdict = this.analyzer.assess(action);
    if (!verdict.allowed) {
      return {
        observation: {
          action, ok: false, stdout: '', stderr: '',
          exitCode: null, timedOut: false, blocked: true,
          blockReason: verdict.summary, durationMs: Date.now() - started,
        },
        verdict,
      };
    }

    const timeoutMs = Math.min(
      action.kind === 'bash' || action.kind === 'python' ? (action.timeoutMs ?? this.defaultTimeoutMs) : this.defaultTimeoutMs,
      V7_CODEACT_MAX_TIMEOUT_MS,
    );

    try {
      if (action.kind === 'bash') {
        const result = await runProcess('bash', ['-c', action.command], { cwd: this.workingDir, timeoutMs });
        return {
          observation: {
            action, ok: result.exitCode === 0 && !result.timedOut,
            stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
            timedOut: result.timedOut, blocked: false, durationMs: Date.now() - started,
          },
          verdict,
        };
      }
      if (action.kind === 'python') {
        const result = await runProcess('python3', ['-'], { cwd: this.workingDir, timeoutMs, stdin: action.code });
        return {
          observation: {
            action, ok: result.exitCode === 0 && !result.timedOut,
            stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
            timedOut: result.timedOut, blocked: false, durationMs: Date.now() - started,
          },
          verdict,
        };
      }
      if (action.kind === 'edit') {
        const target = this.resolveInWorkspace(action.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (action.mode === 'append' && fs.existsSync(target)) {
          fs.appendFileSync(target, action.content, 'utf8');
        } else {
          fs.writeFileSync(target, action.content, 'utf8');
        }
        const bytes = Buffer.byteLength(action.content, 'utf8');
        return {
          observation: {
            action, ok: true, stdout: `wrote ${action.path} (${bytes} bytes, mode=${action.mode})`,
            stderr: '', exitCode: 0, timedOut: false, blocked: false,
            durationMs: Date.now() - started, fileWritten: { path: action.path, bytes },
          },
          verdict,
        };
      }
      // read
      const target = this.resolveInWorkspace(action.path);
      if (!fs.existsSync(target)) {
        return {
          observation: {
            action, ok: false, stdout: '', stderr: `file not found: ${action.path}`,
            exitCode: null, timedOut: false, blocked: false, durationMs: Date.now() - started,
          },
          verdict,
        };
      }
      const content = fs.readFileSync(target, 'utf8');
      const maxLines = action.maxLines ?? 200;
      const lines = content.split('\n').slice(0, maxLines).join('\n');
      return {
        observation: {
          action, ok: true, stdout: lines, stderr: '', exitCode: 0,
          timedOut: false, blocked: false, durationMs: Date.now() - started,
        },
        verdict,
      };
    } catch (err) {
      return {
        observation: {
          action, ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err),
          exitCode: null, timedOut: false, blocked: false, durationMs: Date.now() - started,
        },
        verdict,
      };
    }
  }

  /** Chạy nhiều action theo thứ tự, dừng ở action đầu tiên lỗi/block. */
  async executeAll(actions: readonly V7Action[], stopOnFailure = true): Promise<V7ExecuteResult[]> {
    const results: V7ExecuteResult[] = [];
    for (const action of actions) {
      const result = await this.execute(action);
      results.push(result);
      if (stopOnFailure && (!result.observation.ok || result.observation.blocked)) break;
    }
    return results;
  }
}

/** Chạy một lệnh shell thật (tiện cho eval check) — có timeout + cwd. */
export function runV7Shell(
  command: string,
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { cwd, env: cleanEnv(), timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const timedOut = (err as NodeJS.ErrnoException | null)?.code === 'ETIMEDOUT' || (err as unknown as { signal?: unknown } | null)?.signal === 'SIGKILL';
      resolve({
        stdout: clipOutput(stdout),
        stderr: clipOutput(stderr),
        exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        timedOut,
      });
    });
  });
}
