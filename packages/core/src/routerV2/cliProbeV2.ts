/**
 * Auto-detect CLI agents — probe sau (v1.16, Doi T3).
 *
 * Mo rong detected v1 (chi biet co cai + co login khong): probe sau
 * tra ve version + version co trong range ho tro khong + format
 * output co khop adapter khong + model list (neu CLI co lenh list).
 *
 * Y tuong (OpenMausBot: khong pin CLI thi doi format la gay): moi CLI
 * mot adapter co version range (minVersion / maxTestedVersion); khi
 * format output la (khong thay marker da biet) thi ha cap — tra
 * formatStatus='unknown' + warning, KHONG crash, KHONG doan login.
 *
 * NGUYEN TAC BAO MAT (giong detected v1, ap dung nghiem):
 * - Chi probe bang lenh cua chinh CLI (`--version`, lenh status/list).
 * - KHONG BAO GIO doc noi dung file credential / token. Ngoai le duy
 *   nhat: Gemini `google_accounts.json` chi doc truong email (nhan
 *   tai khoan); `oauth_creds.json` chi kiem tra TON TAI.
 * - Aider khong co login: chi kiem tra TEN bien moi truong co ton tai
 *   khong (env-present) — KHONG BAO GIO doc gia tri key.
 * - Ket qua probe chi chua nhan (ten, version, trang thai) — an toan
 *   gui qua IPC / hien UI.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

import type { CliAdapter, CliAgentKind, CliProbeResult } from './types';

/** Timeout mac dinh cho probe version (ms). */
export const CLI_PROBE_TIMEOUT_MS = 10_000;

/** Timeout cho lenh auth/list (co the cham hon). */
export const CLI_AUTH_TIMEOUT_MS = 15_000;

/** Bang adapter cho 6 CLI agent (version tu docs cong khai, 11/2026). */
export const CLI_ADAPTERS: Record<CliAgentKind, CliAdapter> = {
  claude: {
    kind: 'claude',
    label: 'Claude Code',
    binaries: ['claude'],
    minVersion: '1.0.0',
    maxTestedVersion: '2.0.0',
    versionArgs: ['--version'],
    authArgs: ['auth', 'status', '--json'],
    listModelsArgs: null,
    authMethod: 'cli-status',
    knownFormatMarkers: ['claude', 'version'],
  },
  codex: {
    kind: 'codex',
    label: 'Codex CLI',
    binaries: ['codex'],
    minVersion: '0.1.0',
    maxTestedVersion: '1.0.0',
    versionArgs: ['--version'],
    authArgs: ['login', 'status'],
    listModelsArgs: null,
    authMethod: 'cli-status',
    knownFormatMarkers: ['codex', 'version'],
  },
  opencode: {
    kind: 'opencode',
    label: 'OpenCode',
    binaries: ['opencode'],
    minVersion: '0.1.0',
    maxTestedVersion: '1.5.0',
    versionArgs: ['--version'],
    authArgs: ['auth', 'list'],
    listModelsArgs: null,
    authMethod: 'cli-list',
    knownFormatMarkers: ['opencode', 'version'],
  },
  gemini: {
    kind: 'gemini',
    label: 'Gemini CLI',
    binaries: ['gemini'],
    minVersion: '0.1.0',
    maxTestedVersion: '1.0.0',
    versionArgs: ['--version'],
    authArgs: null,
    listModelsArgs: null,
    authMethod: 'file-label',
    knownFormatMarkers: ['gemini', 'version'],
  },
  aider: {
    kind: 'aider',
    label: 'Aider',
    binaries: ['aider'],
    minVersion: '0.1.0',
    maxTestedVersion: '1.0.0',
    versionArgs: ['--version'],
    authArgs: null,
    listModelsArgs: null,
    authMethod: 'env-present',
    knownFormatMarkers: ['aider', 'version'],
  },
  cursor: {
    kind: 'cursor',
    label: 'Cursor CLI',
    binaries: ['cursor-agent'],
    minVersion: '0.1.0',
    maxTestedVersion: '1.0.0',
    versionArgs: ['--version'],
    authArgs: ['status', '--format', 'json'],
    listModelsArgs: null,
    authMethod: 'cli-status',
    knownFormatMarkers: ['cursor', 'version'],
  },
};

/** Model mac dinh moi CLI chay khi khong co lenh list (de UI hien). */
export const CLI_DEFAULT_MODELS: Record<CliAgentKind, string[]> = {
  claude: ['claude-sonnet-4.5', 'claude-opus-4.5'],
  codex: ['gpt-5', 'gpt-5-codex'],
  opencode: ['opencode-default'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  aider: ['aider-default'],
  cursor: ['cursor-default'],
};

/** Bien moi truong API key ma Aider co the dung (chi kiem tra TEN). */
export const AIDER_API_KEY_ENV_NAMES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
] as const;

/** Ket qua chay mot lenh probe. */
export interface CliCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/** Ham chay mot lenh CLI (injectable de test). */
export type CliRunner = (
  binary: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<CliCommandResult>;

/** Ham tim binary tren PATH (injectable de test). */
export type BinaryFinder = (names: string[]) => string | null;

function defaultRunner(binary: string, args: string[], opts: { timeoutMs: number }): Promise<CliCommandResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const timedOut = !!error && (error as Error).message.includes('ETIMEDOUT');
        const code = !error
          ? 0
          : typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : null;
        resolve({
          code,
          stdout: (stdout ?? '').slice(0, 4096),
          stderr: (stderr ?? '').slice(0, 4096),
          timedOut,
          spawnError: error && code === null && !timedOut ? (error as Error).message : undefined,
        });
      },
    );
  });
}

function defaultFinder(names: string[]): string | null {
  const pathValue = process.env.PATH ?? '';
  const dirs = pathValue.split(path.delimiter).filter((d) => d.length > 0);
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, `${name}${suffix}`);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // Thu ung vien tiep theo.
        }
      }
    }
  }
  return null;
}

/** Trich semver x.y[.z] dau tien tu output `--version`. */
export function parseCliVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return null;
  return match[3] !== undefined ? `${match[1]}.${match[2]}.${match[3]}` : `${match[1]}.${match[2]}.0`;
}

/** So sanh semver: -1 | 0 | 1 (a < b | a = b | a > b). */
export function compareCliVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** Output co chua marker format da biet khong. */
export function formatMatchesKnown(output: string, markers: string[]): boolean {
  const lower = output.toLowerCase();
  return markers.some((m) => lower.includes(m.toLowerCase()));
}

/** Parse JSON phong thu: tra null khi hong (khong throw). */
export function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Doc nhan tai khoan Gemini tu `~/.gemini/google_accounts.json`.
 * CHI doc truong email (nhan hien thi); file co the khong ton tai
 * hoac JSON hong -> tra undefined. KHONG BAO GIO doc oauth_creds.json
 * (chua token) — chi kiem tra ton tai o noi khac neu can.
 */
export function readGeminiAccountLabel(homeDir: string = os.homedir()): string | undefined {
  const file = path.join(homeDir, '.gemini', 'google_accounts.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = safeParseJson<unknown>(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const obj = parsed as Record<string, unknown>;
    const candidates: unknown[] = [
      obj.email,
      obj.activeAccount,
      Array.isArray(obj.accounts) ? (obj.accounts[0] as Record<string, unknown> | undefined)?.email : undefined,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.includes('@')) return c;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Kiem tra file oauth Gemini co ton tai khong (chi ton tai, khong doc). */
export function geminiOauthCredsExist(homeDir: string = os.homedir()): boolean {
  try {
    return fs.existsSync(path.join(homeDir, '.gemini', 'oauth_creds.json'));
  } catch {
    return false;
  }
}

/**
 * Parse ket qua lenh auth status cua tung CLI thanh { loggedIn, label }.
 * Phong thu: field la/thieu -> loggedIn=null (khong ket luan) thay vi
 * crash; JSON hong -> loggedIn=false + warning o caller.
 */
export function parseAuthStatus(
  kind: CliAgentKind,
  result: CliCommandResult,
): { loggedIn: boolean | null; accountLabel?: string } {
  if (result.timedOut || result.spawnError) return { loggedIn: null };
  if (result.code !== 0) return { loggedIn: false };
  const text = `${result.stdout}\n${result.stderr}`.trim();
  switch (kind) {
    case 'claude': {
      const json = safeParseJson<Record<string, unknown>>(result.stdout.trim());
      if (json) {
        const status = typeof json.status === 'string' ? json.status.toLowerCase() : '';
        const email = typeof json.email === 'string' ? json.email : undefined;
        const account = (json.account as Record<string, unknown> | undefined)?.email;
        if (status.includes('signed') || status.includes('logged') || json.signedIn === true) {
          return { loggedIn: true, accountLabel: email ?? (typeof account === 'string' ? account : undefined) };
        }
        if (status.includes('not') || json.signedIn === false) return { loggedIn: false };
        return { loggedIn: null };
      }
      if (/signed in|logged in/i.test(text)) return { loggedIn: true };
      if (/not (signed|logged) in/i.test(text)) return { loggedIn: false };
      return { loggedIn: null };
    }
    case 'codex': {
      if (/logged in|authenticated|signed in/i.test(text)) {
        const emailMatch = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(text);
        return { loggedIn: true, accountLabel: emailMatch?.[1] };
      }
      if (/not logged in|not authenticated|no active/i.test(text)) return { loggedIn: false };
      return { loggedIn: null };
    }
    case 'opencode': {
      // `opencode auth list` liet ke provider da luu (khong in secret).
      if (/anthropic|openai|google|github/i.test(text) && !/no (provider|auth)/i.test(text)) {
        return { loggedIn: true };
      }
      if (/no (provider|auth)/i.test(text) || text.length === 0) return { loggedIn: false };
      return { loggedIn: null };
    }
    case 'cursor': {
      const json = safeParseJson<Record<string, unknown>>(result.stdout.trim());
      if (json) {
        const email = typeof json.email === 'string' ? json.email : undefined;
        if (json.authenticated === true || json.loggedIn === true) return { loggedIn: true, accountLabel: email };
        if (json.authenticated === false || json.loggedIn === false) return { loggedIn: false };
        return { loggedIn: null };
      }
      if (/authenticated|logged in/i.test(text)) return { loggedIn: true };
      if (/not (authenticated|logged in)/i.test(text)) return { loggedIn: false };
      return { loggedIn: null };
    }
    default:
      return { loggedIn: null };
  }
}

/** Probe sau mot CLI agent (khong copy/gui credential di dau). */
export async function probeCliAgent(
  kind: CliAgentKind,
  opts?: {
    runner?: CliRunner;
    finder?: BinaryFinder;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    enabled?: boolean;
  },
): Promise<CliProbeResult> {
  const adapter = CLI_ADAPTERS[kind];
  const runner = opts?.runner ?? defaultRunner;
  const finder = opts?.finder ?? defaultFinder;
  const enabled = opts?.enabled ?? false;
  const now = Date.now();
  const base: CliProbeResult = {
    kind,
    label: adapter.label,
    exists: false,
    binaryPath: null,
    version: null,
    versionSupported: false,
    versionUntested: false,
    formatStatus: 'not-checked',
    loggedIn: null,
    models: [],
    warnings: [],
    enabled,
    probedAt: now,
  };
  const binaryPath = finder(adapter.binaries);
  if (!binaryPath) {
    return { ...base, unavailableReason: 'not-installed' };
  }
  base.exists = true;
  base.binaryPath = binaryPath;

  // 1. Version probe.
  const versionRes = await runner(binaryPath, adapter.versionArgs, { timeoutMs: CLI_PROBE_TIMEOUT_MS });
  if (versionRes.timedOut || versionRes.spawnError || versionRes.code !== 0) {
    return { ...base, unavailableReason: 'version-probe-failed', warnings: ['Khong chay duoc --version (timeout/loi spawn).'] };
  }
  const versionText = `${versionRes.stdout}\n${versionRes.stderr}`.trim();
  base.version = parseCliVersion(versionText);
  base.formatStatus = formatMatchesKnown(versionText, adapter.knownFormatMarkers) ? 'known' : 'unknown';
  if (base.formatStatus === 'unknown') {
    base.warnings.push(`Output --version la so voi adapter ${adapter.label} (co the CLI doi format) — van thu dung, giam do tin cay.`);
  }
  if (!base.version) {
    return { ...base, unavailableReason: 'version-probe-failed', warnings: ['Khong doc duoc version tu output --version.'] };
  }
  base.versionSupported = compareCliVersions(base.version, adapter.minVersion) >= 0;
  base.versionUntested = compareCliVersions(base.version, adapter.maxTestedVersion) > 0;
  if (!base.versionSupported) {
    return { ...base, unavailableReason: 'version-too-old', warnings: [`Version ${base.version} duoi muc toi thieu ${adapter.minVersion}.`] };
  }
  if (base.versionUntested) {
    base.warnings.push(`Version ${base.version} moi hon ban da kiem chung (${adapter.maxTestedVersion}) — van dung duoc, co the format da doi.`);
  }

  // 2. Auth probe theo co che cua tung CLI.
  if (adapter.authMethod === 'env-present') {
    const env = opts?.env ?? process.env;
    const present = AIDER_API_KEY_ENV_NAMES.filter((name) => env[name] && env[name]!.length > 0);
    base.loggedIn = present.length > 0;
    if (present.length > 0) {
      base.accountLabel = `${present.join(', ')} (API key)`;
      base.models = CLI_DEFAULT_MODELS[kind];
    } else {
      base.unavailableReason = 'not-signed-in';
      base.warnings.push('Aider can API key qua bien moi truong (OPENAI_API_KEY / ANTHROPIC_API_KEY / ...) — chua thay bien nao.');
    }
    return base;
  }
  if (adapter.authMethod === 'file-label') {
    const label = readGeminiAccountLabel(opts?.homeDir);
    const hasOauth = geminiOauthCredsExist(opts?.homeDir);
    base.loggedIn = label !== undefined || hasOauth;
    if (label) base.accountLabel = label;
    if (base.loggedIn) {
      base.models = CLI_DEFAULT_MODELS[kind];
    } else {
      base.unavailableReason = 'not-signed-in';
      base.warnings.push('Chua thay tai khoan Gemini CLI (google_accounts.json / oauth_creds.json).');
    }
    return base;
  }
  if (adapter.authArgs) {
    const authRes = await runner(binaryPath, adapter.authArgs, { timeoutMs: CLI_AUTH_TIMEOUT_MS });
    if (authRes.timedOut || authRes.spawnError) {
      base.loggedIn = null;
      base.warnings.push('Lenh kiem tra dang nhap timeout/loi spawn — khong ket luan duoc.');
      return base;
    }
    const parsed = parseAuthStatus(kind, authRes);
    base.loggedIn = parsed.loggedIn;
    if (parsed.accountLabel) base.accountLabel = parsed.accountLabel;
    if (parsed.loggedIn === true) {
      base.models = CLI_DEFAULT_MODELS[kind];
    } else if (parsed.loggedIn === false) {
      base.unavailableReason = 'not-signed-in';
    } else {
      base.warnings.push('Khong doc duoc trang thai dang nhap tu output cua CLI (format la?) — coi nhu chua xac dinh.');
    }
    return base;
  }
  return base;
}

/** Probe tat ca 6 CLI (tuan tu, moi cai co timeout rieng). */
export async function probeAllCliAgents(
  opts?: {
    runner?: CliRunner;
    finder?: BinaryFinder;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    enabledKinds?: Set<CliAgentKind>;
  },
): Promise<CliProbeResult[]> {
  const kinds: CliAgentKind[] = ['codex', 'claude', 'opencode', 'gemini', 'aider', 'cursor'];
  const results: CliProbeResult[] = [];
  for (const kind of kinds) {
    results.push(
      await probeCliAgent(kind, {
        ...opts,
        enabled: opts?.enabledKinds?.has(kind) ?? false,
      }),
    );
  }
  return results;
}
