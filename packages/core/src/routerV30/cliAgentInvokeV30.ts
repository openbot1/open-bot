/**
 * CLI agent invoke v30 (v1.44, Doi T5) — chay model qua CLI agent da
 * phat hien, bang chinh session dang nhap goc cua CLI do.
 *
 * Noi tiep cliAgentDetectV30 (chi phat hien + dong y + bat/tat): file
 * nay la DUONG CHAY that — host goi 1 prompt qua binary goc cua CLI
 * (che do non-interactive cua tung CLI), CLI tu dung tai khoan/model
 * da dang nhap cua no. Open-bot KHONG doc, KHONG copy, KHONG gui
 * credential di dau; KHONG tu goi API cua provider.
 *
 * Dieu kien chay (kiem tra truoc moi lan invoke):
 * - user da dong y (`consented === true`) VA nguon dang bat;
 * - CLI da duoc phat hien (co binary).
 * Thieu 1 trong 3 dieu kien -> tra `{ ok: false, error }`, KHONG spawn.
 *
 * Goi CLI bang `execFile` (khong qua shell), prompt truyen qua argv
 * theo template non-interactive cua tung CLI (host co the ghi de
 * template qua `customArgv`), co timeout (mac dinh 120s) + gioi han
 * output (mac dinh 1MB, vuot thi cat + danh dau truncated).
 */
import { execFile } from 'node:child_process';
import {
  type CliAgentConsentV30,
  type CliAgentDetectionV30,
  type CliAgentKindV30,
} from './cliAgentDetectV30';

/** Timeout mac dinh cho 1 lan invoke (ms). */
export const CLI_INVOKE_TIMEOUT_MS_V30 = 120_000;
/** Output toi da giu lai (ky tu) — vuot thi cat + truncated=true. */
export const CLI_INVOKE_MAX_OUTPUT_CHARS_V30 = 1_000_000;

/**
 * Template argv non-interactive cua tung CLI (giao dien cong khai cua
 * chinh CLI do; host ghi de qua `customArgv` neu CLI doi cu phap).
 * `{prompt}` duoc thay bang prompt that (truyen nhu 1 argv rieng,
 * khong noi chuoi vao shell — khong co shell o day).
 */
export const CLI_INVOKE_TEMPLATES_V30: Record<
  CliAgentKindV30,
  string[]
> = {
  codex: ['exec', '{prompt}'],
  'claude-code': ['-p', '{prompt}'],
  opencode: ['run', '{prompt}'],
  'gemini-cli': ['-p', '{prompt}'],
  aider: ['--message', '{prompt}'],
  'cursor-cli': ['-p', '{prompt}'],
};

/** Yeu cau invoke 1 CLI agent. */
export interface CliInvokeRequestV30 {
  kind: CliAgentKindV30;
  /** Prompt gui cho model (qua CLI). */
  prompt: string;
  /** Model ghi de (neu khong truyen thi dung model mac dinh / override cua source). */
  modelId?: string;
  /** Timeout (ms) — mac dinh CLI_INVOKE_TIMEOUT_MS_V30. */
  timeoutMs?: number;
  /** Thu muc lam viec cua tien trinh CLI (mac dinh thu muc hien tai). */
  cwd?: string;
  /** Ghi de template argv (dung `{prompt}` lam placeholder). */
  customArgv?: string[];
}

/** Ket qua invoke 1 CLI agent. */
export interface CliInvokeResultV30 {
  ok: boolean;
  /** Output (stdout) cua CLI — da cat o gioi han. */
  output: string;
  /** Ma thoat cua tien trinh (neu chay xong). */
  exitCode: number | null;
  /** Thoi gian chay (ms). */
  durationMs: number;
  /** Output co bi cat o gioi han khong. */
  truncated: boolean;
  /** Loi (neu that): consent / disabled / not-detected / timeout / spawn / non-zero-exit. */
  error?: string;
  /** Kind + binary da dung (de log / hien thi). */
  kind?: CliAgentKindV30;
  binary?: string;
}

/** Runner invoke — host co the mock trong test hoac thay the. */
export type CliInvokeRunnerV30 = (
  binary: string,
  argv: string[],
  options: { timeoutMs: number; cwd?: string },
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}>;

/**
 * Runner mac dinh: spawn binary goc bang execFile (khong shell),
 * prompt da nam trong argv. Timeout thi kill tien trinh.
 */
export async function defaultCliInvokeRunnerV30(
  binary: string,
  argv: string[],
  options: { timeoutMs: number; cwd?: string },
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
      error?: string;
    }) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        stdout,
        stderr,
        exitCode: null,
        timedOut: true,
        error: 'invoke timed out',
      });
    }, options.timeoutMs);
    timer.unref?.();
    const child = execFile(
      binary,
      argv,
      {
        timeout: options.timeoutMs,
        windowsHide: true,
        cwd: options.cwd,
        maxBuffer: CLI_INVOKE_MAX_OUTPUT_CHARS_V30 * 2,
      },
      (error, out, err) => {
        clearTimeout(timer);
        if (out) stdout = out.toString();
        if (err) stderr = err.toString();
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          finish({
            stdout,
            stderr,
            exitCode: null,
            timedOut: false,
            error: `binary not found: ${binary}`,
          });
          return;
        }
        finish({
          stdout,
          stderr,
          exitCode: error
            ? typeof error.code === 'number'
              ? error.code
              : 1
            : 0,
          timedOut: false,
          error: error ? error.message : undefined,
        });
      },
    );
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        stdout,
        stderr,
        exitCode: null,
        timedOut: false,
        error: error.message,
      });
    });
  });
}

/** Xay argv tu template: thay `{prompt}` bang prompt that. */
export function buildCliInvokeArgvV30(
  kind: CliAgentKindV30,
  prompt: string,
  customArgv?: string[],
): string[] {
  const template = customArgv ?? CLI_INVOKE_TEMPLATES_V30[kind];
  return template.map((part) => (part === '{prompt}' ? prompt : part));
}

/**
 * Invoke 1 CLI agent (co kiem tra consent + enabled + detected).
 *
 * Tra `{ ok: false, error }` (khong throw) khi: chua dong y, nguon
 * dang tat, CLI chua duoc phat hien, prompt rong, timeout, spawn loi,
 * CLI thoat ma != 0. Khi thanh cong, `output` la stdout (stderr chi
 * ghi vao `error` khi that — tranh lam nhieu log).
 */
export async function invokeCliAgentV30(
  request: CliInvokeRequestV30,
  detections: CliAgentDetectionV30[],
  consent: CliAgentConsentV30,
  runner: CliInvokeRunnerV30 = defaultCliInvokeRunnerV30,
): Promise<CliInvokeResultV30> {
  const startedAt = Date.now();
  const fail = (error: string): CliInvokeResultV30 => ({
    ok: false,
    output: '',
    exitCode: null,
    durationMs: Date.now() - startedAt,
    truncated: false,
    error,
    kind: request.kind,
  });
  if (!request.prompt || request.prompt.trim() === '') {
    return fail('prompt is required');
  }
  if (!consent.consented) {
    return fail('user consent required to use CLI agents');
  }
  if (!consent.enabledByKind[request.kind]) {
    return fail(`CLI source disabled: ${request.kind}`);
  }
  const detection = detections.find((d) => d.kind === request.kind);
  if (!detection || !detection.detected || !detection.binary) {
    return fail(`CLI agent not detected on this machine: ${request.kind}`);
  }
  const argv = buildCliInvokeArgvV30(
    request.kind,
    request.prompt,
    request.customArgv,
  );
  const timeoutMs = request.timeoutMs ?? CLI_INVOKE_TIMEOUT_MS_V30;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fail('timeoutMs must be > 0');
  }
  const raw = await runner(detection.binary, argv, {
    timeoutMs,
    cwd: request.cwd,
  });
  const durationMs = Date.now() - startedAt;
  if (raw.timedOut) {
    return {
      ok: false,
      output: '',
      exitCode: null,
      durationMs,
      truncated: false,
      error: 'invoke timed out',
      kind: request.kind,
      binary: detection.binary,
    };
  }
  if (raw.error && raw.exitCode !== 0) {
    return {
      ok: false,
      output: '',
      exitCode: raw.exitCode,
      durationMs,
      truncated: false,
      error: raw.error,
      kind: request.kind,
      binary: detection.binary,
    };
  }
  const stdout = raw.stdout ?? '';
  const truncated = stdout.length > CLI_INVOKE_MAX_OUTPUT_CHARS_V30;
  return {
    ok: true,
    output: truncated
      ? stdout.slice(0, CLI_INVOKE_MAX_OUTPUT_CHARS_V30)
      : stdout,
    exitCode: raw.exitCode ?? 0,
    durationMs,
    truncated,
    kind: request.kind,
    binary: detection.binary,
  };
}
