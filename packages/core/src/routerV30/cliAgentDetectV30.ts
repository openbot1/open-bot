/**
 * Auto-detect CLI agent v2 (v1.44, Doi T5) — phat hien Codex CLI,
 * Claude Code, OpenCode, Gemini CLI (them Aider, Cursor CLI) da co
 * tren may user va dung model/account da dang nhap cua chung.
 *
 * NGUYEN TAC AN TOAN — doc ky truoc khi sua file nay:
 * - CHI goi CLI qua binary goc cua no (spawn `binary --version` de
 *   phat hien; goi model thi host chay chinh CLI do voi session goc
 *   cua no). File nay KHONG doc, KHONG copy, KHONG gui credential
 *   di dau.
 * - KHONG BAO GIO doc file cau hinh / auth / session cua cac CLI khac
 *   (vd ~/.codex/auth.json, ~/.claude.json, ~/.config/...). Danh sach
 *   duong dan cam nam o FORBIDDEN_CLI_PATHS_V30 — moi thao tac doc
 *   file phai kiem tra qua `isForbiddenCliPathV30` (defense in depth);
 *   hien tai file nay KHONG doc bat ky file nao.
 * - CHI chay khi user DONG Y qua UI (`consented === true`); tung nguon
 *   bat/tat rieng (`enabledByKind`). Chua dong y thi detect chi tra
 *   "co binary hay khong", khong goi model qua CLI.
 * - Account hien thi: nhan user nhap (`accountLabel`) hoac chuoi chung
 *   "via CLI login" — KHONG suy ra tu file tren dia.
 * - Model mac dinh moi CLI la cau hinh khai bao trong file nay (host /
 *   user co the ghi de qua `modelOverride`); khong doc tu config CLI.
 *
 * Phat hien dung runner inject duoc (mac dinh spawn that, co timeout);
 * test dung mock runner — khong spawn that trong test.
 */
import { execFile } from 'node:child_process';

/** Cac CLI agent duoc ho tro phat hien. */
export type CliAgentKindV30 =
  | 'codex'
  | 'claude-code'
  | 'opencode'
  | 'gemini-cli'
  | 'aider'
  | 'cursor-cli';

/** Duong dan TUYET DOI KHONG DUOC DOC (auth/session/config cua CLI khac). */
export const FORBIDDEN_CLI_PATHS_V30: readonly string[] = [
  '.codex/auth.json',
  '.codex/config.toml',
  '.claude.json',
  '.claude/settings.json',
  '.config/claude-code',
  '.config/opencode',
  '.config/gemini',
  '.gemini/oauth_creds.json',
  '.cursor/auth.json',
  '.aider.conf.yml',
  '.config/aider',
];

/**
 * Kiem tra duong dan co nam trong danh sach cam khong: khop khi duong
 * dan ket thuc bang muc cam, hoac muc cam la mot thu muc cha cua no
 * (vd '.config/gemini/settings.json' bi chan vi nam duoi
 * '.config/gemini'). Khong phan biet hoa/thuong tren phan ten file.
 * Dung de chan moi thao tac doc file vo tinh cham vao credential
 * cua CLI khac.
 */
export function isForbiddenCliPathV30(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return FORBIDDEN_CLI_PATHS_V30.some((forbidden) => {
    const f = forbidden.toLowerCase();
    return (
      normalized.endsWith(f) ||
      normalized.endsWith(`/${f}`) ||
      normalized.includes(`/${f}/`)
    );
  });
}

/** Dinh nghia 1 CLI agent: binary + cach lay version + model mac dinh. */
export interface CliAgentDefinitionV30 {
  kind: CliAgentKindV30;
  /** Ten hien thi. */
  displayName: string;
  /** Ten binary tren PATH (vd 'codex', 'claude'). */
  binary: string;
  /** Binary phu (neu binary chinh doi ten theo he dieu hanh). */
  altBinaries: string[];
  /** Tham so lay version (khong can auth, khong doc credential). */
  versionArgs: string[];
  /** Model mac dinh khi chay qua CLI nay (khai bao, user ghi de duoc). */
  defaultModelId: string;
  /** Mo ta ngan de UI hien thi. */
  description: string;
}

/** Dinh nghia cho 6 CLI duoc ho tro. */
export const CLI_AGENT_DEFINITIONS_V30: readonly CliAgentDefinitionV30[] = [
  {
    kind: 'codex',
    displayName: 'Codex CLI',
    binary: 'codex',
    altBinaries: ['codex-cli'],
    versionArgs: ['--version'],
    defaultModelId: 'gpt-5.2',
    description: 'OpenAI Codex CLI — chay model qua tai khoan Codex da dang nhap.',
  },
  {
    kind: 'claude-code',
    displayName: 'Claude Code',
    binary: 'claude',
    altBinaries: [],
    versionArgs: ['--version'],
    defaultModelId: 'claude-sonnet-4.5',
    description: 'Claude Code — chay model qua tai khoan Claude da dang nhap.',
  },
  {
    kind: 'opencode',
    displayName: 'OpenCode',
    binary: 'opencode',
    altBinaries: [],
    versionArgs: ['--version'],
    defaultModelId: 'claude-sonnet-4.5',
    description: 'OpenCode — chay model qua tai khoan da dang nhap trong OpenCode.',
  },
  {
    kind: 'gemini-cli',
    displayName: 'Gemini CLI',
    binary: 'gemini',
    altBinaries: [],
    versionArgs: ['--version'],
    defaultModelId: 'gemini-3-pro',
    description: 'Gemini CLI — chay model qua tai khoan Google da dang nhap.',
  },
  {
    kind: 'aider',
    displayName: 'Aider',
    binary: 'aider',
    altBinaries: [],
    versionArgs: ['--version'],
    defaultModelId: 'gpt-5.2-mini',
    description: 'Aider — chay model qua key/session da cau hinh trong Aider.',
  },
  {
    kind: 'cursor-cli',
    displayName: 'Cursor CLI',
    binary: 'cursor-agent',
    altBinaries: ['cursor'],
    versionArgs: ['--version'],
    defaultModelId: 'claude-sonnet-4.5',
    description: 'Cursor CLI — chay model qua tai khoan Cursor da dang nhap.',
  },
];

/** Tim dinh nghia theo kind. */
export function cliAgentDefinitionV30(
  kind: CliAgentKindV30,
): CliAgentDefinitionV30 {
  const found = CLI_AGENT_DEFINITIONS_V30.find((d) => d.kind === kind);
  if (!found) throw new Error(`unknown CLI agent kind: ${kind}`);
  return found;
}

/** Ket qua phat hien 1 CLI. */
export interface CliAgentDetectionV30 {
  kind: CliAgentKindV30;
  displayName: string;
  /** Binary tim thay (neu co). */
  binary: string | null;
  /** Co tim thay binary tren may khong. */
  detected: boolean;
  /** Version in ra tu `binary --version` (neu lay duoc). */
  version: string | null;
  /** Luc phat hien (epoch ms). */
  detectedAt: number;
  /** Ly do khong phat hien duoc (neu co). */
  reason?: string;
}

/** Runner phat hien — tra version string hoac null (khong tim thay). */
export type CliDetectRunnerV30 = (
  definition: CliAgentDefinitionV30,
) => Promise<{ binary: string; version: string | null } | null>;

/** Timeout mac dinh cho 1 lan spawn --version (ms). */
export const CLI_DETECT_TIMEOUT_MS_V30 = 5000;

/**
 * Runner mac dinh: thu tung binary (chinh + phu) bang `which` logic don
 * gian — spawn truc tiep `binary --version` (khong qua shell, khong doc
 * file). Loi spawn (ENOENT) = khong co binary. Timeout thi huy tien trinh.
 */
export async function defaultCliDetectRunnerV30(
  definition: CliAgentDefinitionV30,
  timeoutMs = CLI_DETECT_TIMEOUT_MS_V30,
): Promise<{ binary: string; version: string | null } | null> {
  const candidates = [definition.binary, ...definition.altBinaries];
  for (const binary of candidates) {
    const found = await new Promise<{ binary: string; version: string | null } | null>(
      (resolve) => {
        let done = false;
        const finish = (
          value: { binary: string; version: string | null } | null,
        ) => {
          if (done) return;
          done = true;
          resolve(value);
        };
        const timer = setTimeout(() => {
          child.kill();
          finish(null);
        }, timeoutMs);
        timer.unref?.();
        const child = execFile(
          binary,
          definition.versionArgs,
          { timeout: timeoutMs, windowsHide: true },
          (error, stdout) => {
            clearTimeout(timer);
            if (error) {
              // ENOENT (khong co binary) hoac loi spawn khac -> thu binary tiep.
              finish(null);
              return;
            }
            const version = stdout.trim().split('\n')[0]?.trim() || null;
            finish({ binary, version });
          },
        );
        child.on('error', () => {
          clearTimeout(timer);
          finish(null);
        });
      },
    );
    if (found) return found;
  }
  return null;
}

/** Phat hien tat ca CLI da dinh nghia (tra du ca cai khong thay). */
export async function detectCliAgentsV30(
  runner: CliDetectRunnerV30 = defaultCliDetectRunnerV30,
  now = Date.now(),
): Promise<CliAgentDetectionV30[]> {
  const out: CliAgentDetectionV30[] = [];
  for (const def of CLI_AGENT_DEFINITIONS_V30) {
    let found: { binary: string; version: string | null } | null = null;
    let reason: string | undefined;
    try {
      found = await runner(def);
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    out.push({
      kind: def.kind,
      displayName: def.displayName,
      binary: found?.binary ?? null,
      detected: found !== null,
      version: found?.version ?? null,
      detectedAt: now,
      reason: found ? undefined : (reason ?? 'binary not found on PATH'),
    });
  }
  return out;
}

/** Trang thai dong y + bat/tat + nhan account cua user (luu local). */
export interface CliAgentConsentV30 {
  /** User da dong y dung CLI agent tren may minh chua (mac dinh false). */
  consented: boolean;
  /** Luc dong y / thu hoi (epoch ms). */
  consentedAt: number | null;
  /** Bat/tat tung nguon (mac dinh tat ca deu bat — nhung chi co tac dung khi consented). */
  enabledByKind: Record<CliAgentKindV30, boolean>;
  /** Nhan account user tu dat de hien thi (khong doc tu dia). */
  accountLabelByKind: Partial<Record<CliAgentKindV30, string>>;
  /** Model ghi de user tu chon cho tung CLI (neu co). */
  modelOverrideByKind: Partial<Record<CliAgentKindV30, string>>;
}

/** Consent mac dinh: chua dong y, tat ca nguon bat san (cho khi dong y). */
export function defaultCliAgentConsentV30(): CliAgentConsentV30 {
  return {
    consented: false,
    consentedAt: null,
    enabledByKind: {
      codex: true,
      'claude-code': true,
      opencode: true,
      'gemini-cli': true,
      aider: true,
      'cursor-cli': true,
    },
    accountLabelByKind: {},
    modelOverrideByKind: {},
  };
}

/** User dong y / thu hoi dong y (thu hoi thi tat het viec dung CLI). */
export function setCliConsentV30(
  consent: CliAgentConsentV30,
  consented: boolean,
  now = Date.now(),
): CliAgentConsentV30 {
  return {
    ...consent,
    consented,
    consentedAt: consented ? now : null,
  };
}

/** Bat/tat 1 nguon CLI (chi co tac dung khi da consented). */
export function setCliSourceEnabledV30(
  consent: CliAgentConsentV30,
  kind: CliAgentKindV30,
  enabled: boolean,
): CliAgentConsentV30 {
  return {
    ...consent,
    enabledByKind: { ...consent.enabledByKind, [kind]: enabled },
  };
}

/** Dat nhan account hien thi cho 1 CLI (user tu nhap; rong thi xoa). */
export function setCliAccountLabelV30(
  consent: CliAgentConsentV30,
  kind: CliAgentKindV30,
  label: string,
): CliAgentConsentV30 {
  const next = { ...consent.accountLabelByKind };
  const trimmed = label.trim().slice(0, 120);
  if (trimmed) next[kind] = trimmed;
  else delete next[kind];
  return { ...consent, accountLabelByKind: next };
}

/** Dat model ghi de cho 1 CLI (user tu chon; rong thi ve mac dinh). */
export function setCliModelOverrideV30(
  consent: CliAgentConsentV30,
  kind: CliAgentKindV30,
  modelId: string,
): CliAgentConsentV30 {
  const next = { ...consent.modelOverrideByKind };
  const trimmed = modelId.trim().slice(0, 200);
  if (trimmed) next[kind] = trimmed;
  else delete next[kind];
  return { ...consent, modelOverrideByKind: next };
}

/** Nhan account hien thi: label user dat, khong thi chuoi chung. */
export function cliAccountDisplayV30(
  consent: CliAgentConsentV30,
  kind: CliAgentKindV30,
): string {
  return consent.accountLabelByKind[kind] ?? 'via CLI login';
}

/** Mot nguon model chay qua CLI — de router + UI hien thi ro rang. */
export interface CliModelSourceV30 {
  kind: CliAgentKindV30;
  displayName: string;
  binary: string;
  /** Model se chay qua CLI nay. */
  modelId: string;
  /** Account hien thi (label user dat hoac 'via CLI login'). */
  accountLabel: string;
  /** Model chay qua session goc cua CLI — khong copy credential. */
  via: 'cli-session';
  version: string | null;
}

/**
 * Giai quyet danh sach nguon model chay qua CLI.
 *
 * Chi tra nguon nao: da phat hien + user da dong y + nguon dang bat.
 * Chua dong y -> danh sach rong (khong goi model qua CLI).
 */
export function resolveCliModelSourcesV30(
  detections: CliAgentDetectionV30[],
  consent: CliAgentConsentV30,
): CliModelSourceV30[] {
  if (!consent.consented) return [];
  const out: CliModelSourceV30[] = [];
  for (const d of detections) {
    if (!d.detected || !d.binary) continue;
    if (!consent.enabledByKind[d.kind]) continue;
    const def = cliAgentDefinitionV30(d.kind);
    out.push({
      kind: d.kind,
      displayName: d.displayName,
      binary: d.binary,
      modelId: consent.modelOverrideByKind[d.kind] ?? def.defaultModelId,
      accountLabel: cliAccountDisplayV30(consent, d.kind),
      via: 'cli-session',
      version: d.version,
    });
  }
  return out;
}

/** Tom tat trang thai CLI de UI hien thi 1 dong / 1 panel. */
export function summarizeCliSourcesV30(
  detections: CliAgentDetectionV30[],
  consent: CliAgentConsentV30,
): {
  detected: number;
  total: number;
  consented: boolean;
  enabledSources: CliModelSourceV30[];
  lines: string[];
} {
  const detected = detections.filter((d) => d.detected).length;
  const enabledSources = resolveCliModelSourcesV30(detections, consent);
  const lines = detections.map((d) => {
    const source = enabledSources.find((s) => s.kind === d.kind);
    if (source) {
      return `${d.displayName}: ${source.modelId} via ${source.accountLabel}`;
    }
    if (!d.detected) return `${d.displayName}: not installed`;
    if (!consent.consented) return `${d.displayName}: installed — waiting for consent`;
    return `${d.displayName}: installed — disabled`;
  });
  return {
    detected,
    total: detections.length,
    consented: consent.consented,
    enabledSources,
    lines,
  };
}
