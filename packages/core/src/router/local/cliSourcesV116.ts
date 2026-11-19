/**
 * CLI agent sources v116 (v1.39, Doi T3) — mo rong auto-detect CLI
 * agent cho local-model router.
 *
 * He thong `detected/` da co 12 CLI (claude, codex, grok, opencode,
 * gemini, cursor, aider, continue, copilot, amazonq, windsurf, kiro)
 * voi nguyen tac bao mat: chi hoi chinh CLI bang lenh status cua no,
 * khong doc/gui credential di dau, opt-in mac dinh TAT. V116 KHONG
 * sua 12 detector do — chi THEM 6 CLI moi bang `registerDetector()`:
 *
 * - Crush (Charmbracelet) — binary `crush`
 * - Goose (Block) — binary `goose`
 * - Qwen Code (Alibaba) — binary `qwen`
 * - Amp (Sourcegraph) — binary `amp`
 * - Factory Droid — binary `droid`
 * - Pi coding agent — binary `pi`
 *
 * TRUNG THUC VE AUTH: voi 6 CLI moi nay, chua co lenh kiem tra dang
 * nhap nao duoc kiem chung tren may nay (moi CLI doi cach dang nhap
 * khac nhau, docs thay doi nhanh), nen detector dung auth kieu
 * `none` — giong Windsurf/custom ACP CLI co san: trang thai detect
 * la 'unknown' (KHONG bia la da dang nhap). Nguon chi duoc dung khi
 * user bat tay (opt-in) va chay thu that: loi auth (neu co) se hien
 * ro luc chay bot, khong giau. Khi co lenh status duoc kiem chung
 * thi doi `auth` cua detector do sang `command`/`file-exists` nhu
 * cac detector cu — khong can sua registry.
 *
 * `CliSourceRegistry` la lop boc tren DetectedEngineRegistry danh
 * rieng cho router: liet ke nguon + nhan tai khoan, bat/tat tung
 * nguon, va bien nguon dang bat + dung duoc thanh model co the route
 * (`cli:<kind>:default`) — model chay qua CLI/auth session goc tren
 * may user, khong can key rieng, khong copy credential.
 */

import { DetectedEngineRegistry } from '../../detected/registry';
import { isEngineUsableAllowingUnknown } from '../../detected/visibility';
import type {
  DetectedEngineSnapshot,
  DetectedEnginesSnapshot,
  DetectorDefinition,
  EngineAccount,
} from '../../detected/types';
import type { RouteCandidate } from './types';

/** 6 kind moi do V116 them (ngoai 12 kind co san cua detected/). */
export const CLI_SOURCES_V116_KINDS = ['crush', 'goose', 'qwen', 'amp', 'droid', 'pi'] as const;

/** Kind cua mot CLI source V116. */
export type CliSourceV116Kind = (typeof CLI_SOURCES_V116_KINDS)[number];

/**
 * Detector cho 6 CLI moi. Auth `none` = chua kiem chung lenh status
 * (xem ghi chu dau file) — trang thai la 'unknown' khi co binary.
 */
export const CLI_SOURCES_V116_DETECTORS: DetectorDefinition[] = [
  {
    kind: 'crush',
    label: 'Crush',
    binaries: ['crush'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: { type: 'none' },
  },
  {
    kind: 'goose',
    label: 'Goose',
    binaries: ['goose'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: { type: 'none' },
  },
  {
    kind: 'qwen',
    label: 'Qwen Code',
    binaries: ['qwen'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: { type: 'none' },
  },
  {
    kind: 'amp',
    label: 'Amp',
    binaries: ['amp'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: { type: 'none' },
  },
  {
    kind: 'droid',
    label: 'Factory Droid',
    binaries: ['droid'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: { type: 'none' },
  },
  {
    kind: 'pi',
    label: 'Pi',
    binaries: ['pi'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: { type: 'none' },
  },
];

/** true = kind nay la CLI moi do V116 them. */
export function isCliSourceV116Kind(kind: string): boolean {
  return (CLI_SOURCES_V116_KINDS as readonly string[]).includes(kind);
}

/** Model id ma router dung cho mot CLI source (model mac dinh cua CLI do). */
export function cliSourceModelId(kind: string): string {
  return `cli:${kind}:default`;
}

/** Chat luong uoc tinh khi route qua CLI session (0..1). CLI chay
 * model manh cua hang (subscription) nen mac dinh kha cao; co the
 * hieu chinh theo kind khi co du lieu thuc. */
export const CLI_SOURCE_DEFAULT_QUALITY = 0.88;

/** Latency uoc tinh den token dau tien khi route qua CLI (ms).
 * CLI chay qua process phu + subscription cloud nen cham hon local
 * nhung thuong nhanh hon goi API key thong thuong. */
export const CLI_SOURCE_DEFAULT_LATENCY_MS = 900;

/** Mot CLI source nhu UI/router nhin thay (khong chua secret). */
export interface CliAgentSource {
  kind: string;
  label: string;
  binary: string;
  binaryPath: string | null;
  version: string | null;
  status: DetectedEngineSnapshot['status'];
  reason?: DetectedEngineSnapshot['reason'];
  reasonDetail?: string;
  /** Nhan tai khoan CLI bao (chi khi available); undefined = khong ro. */
  accountLabel?: string;
  /** Cach tai khoan dang nhap (neu CLI bao). */
  accountMethod?: EngineAccount['method'];
  /** User da bat nguon nay chua (opt-in, mac dinh false). */
  enabled: boolean;
  /** true = nguon moi do V116 them (de UI danh dau "moi"). */
  isNewInV116: boolean;
  /** true = nguon nay dang dung duoc de route (bat + available/unknown). */
  usable: boolean;
  /** Model id de route qua nguon nay. */
  modelId: string;
  detectedAt: string | null;
}

/** Model co the route qua mot CLI source (mo rong RouteCandidate). */
export interface CliRoutableModel extends RouteCandidate {
  /** Kind CLI phuc vu model nay (vd 'codex'). */
  viaCli: string;
  /** Nhan tai khoan dang chay model nay (de UI hien thi). */
  accountLabel?: string;
  /** Binary CLI thuc thi (de host spawn dung CLI). */
  binaryPath: string | null;
}

function sourceFromSnapshot(
  snapshot: DetectedEngineSnapshot | undefined,
  definition: DetectorDefinition,
  usable: boolean,
): CliAgentSource {
  return {
    kind: definition.kind,
    label: definition.label,
    binary: definition.binaries[0] ?? definition.kind,
    binaryPath: snapshot?.binaryPath ?? null,
    version: snapshot?.version ?? null,
    status: snapshot?.status ?? 'unavailable',
    reason: snapshot?.reason,
    reasonDetail: snapshot?.reasonDetail,
    accountLabel: snapshot?.account?.label,
    accountMethod: snapshot?.account?.method,
    enabled: snapshot?.enabled ?? false,
    isNewInV116: isCliSourceV116Kind(definition.kind),
    usable,
    modelId: cliSourceModelId(definition.kind),
    detectedAt: snapshot?.detectedAt ?? null,
  };
}

/** Cau hinh CliSourceRegistry. */
export interface CliSourceRegistryOptions {
  /** Registry co san (test inject registry gia; khong co thi tao moi). */
  registry?: DetectedEngineRegistry;
  /** Co dang ky 6 detector V116 vao registry khong (mac dinh true). */
  registerV116Detectors?: boolean;
}

/**
 * Registry nguon CLI cho router: boc DetectedEngineRegistry, them 6
 * detector V116, cung cap API bat/tat + list + routable models.
 */
export class CliSourceRegistry {
  private readonly registry: DetectedEngineRegistry;
  private readonly v116Kinds: Set<string>;

  constructor(options: CliSourceRegistryOptions = {}) {
    this.registry = options.registry ?? new DetectedEngineRegistry();
    this.v116Kinds = new Set<string>();
    if (options.registerV116Detectors !== false) {
      for (const def of CLI_SOURCES_V116_DETECTORS) {
        this.registry.registerDetector(def);
        this.v116Kinds.add(def.kind);
      }
    }
  }

  /** Registry detected ben duoi (de host dung API goc khi can). */
  getDetectedRegistry(): DetectedEngineRegistry {
    return this.registry;
  }

  /** Tat ca kind CLI ma registry biet (12 cu + 6 moi + custom). */
  listKinds(): string[] {
    return this.registry.listKinds();
  }

  /** Chay detect (co cache TTL cua registry; force=true de quet lai). */
  async detect(force = false): Promise<DetectedEnginesSnapshot> {
    return this.registry.detect({ force });
  }

  /** Snapshot lan detect gan nhat (null khi chua detect). */
  snapshot(): DetectedEnginesSnapshot | null {
    return this.registry.snapshot();
  }

  /** Bat/tat mot nguon (opt-in). Throw khi kind khong ton tai. */
  setEnabled(kind: string, enabled: boolean): void {
    this.registry.setEnabled(kind, enabled);
  }

  /** true = user da bat nguon nay. */
  isEnabled(kind: string): boolean {
    return this.registry.isEnabled(kind);
  }

  /** Danh sach nguon (tu snapshot; chua detect thi tra trang thai "chua quet"). */
  listSources(): CliAgentSource[] {
    const snapshot = this.registry.snapshot();
    const out: CliAgentSource[] = [];
    for (const kind of this.registry.listKinds()) {
      const engine = snapshot?.engines[kind];
      const def = definitionFor(kind, this.v116Kinds.has(kind));
      const usable = isEngineUsableAllowingUnknown(snapshot, kind);
      out.push(sourceFromSnapshot(engine, def, usable));
    }
    return out.sort((a, b) => {
      // Nguon dung duoc truoc, roi theo label.
      if (a.usable !== b.usable) return a.usable ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }

  /** Mot nguon theo kind (undefined khi kind khong ton tai). */
  getSource(kind: string): CliAgentSource | undefined {
    return this.listSources().find((s) => s.kind === kind);
  }

  /** Chi cac nguon dang dung duoc de route (bat + available/unknown). */
  usableSources(): CliAgentSource[] {
    return this.listSources().filter((s) => s.usable);
  }

  /**
   * Bien cac nguon dung duoc thanh model co the route. Cost = 0
   * (chay tren subscription/login san cua user, khong ton them
   * phi API); quality/latency la uoc tinh mac dinh cua CLI source.
   * Chi tra ve nguon co binaryPath (da cai that).
   */
  routableModels(): CliRoutableModel[] {
    return this.usableSources()
      .filter((s) => s.binaryPath)
      .map((s) => ({
        kind: 'local' as const,
        modelId: s.modelId,
        costPer1kTokensUsd: 0,
        estLatencyMs: CLI_SOURCE_DEFAULT_LATENCY_MS,
        quality: CLI_SOURCE_DEFAULT_QUALITY,
        viaCli: s.kind,
        accountLabel: s.accountLabel,
        binaryPath: s.binaryPath,
      }));
  }

  /**
   * Chuoi hien thi "model chay qua tai khoan nao" cho UI/log.
   * Vd: `Codex (qua tai khoan huy@example.com)` hoac
   * `Crush (chua ro tai khoan — dang nhap chua duoc kiem chung)`.
   */
  describeSource(kind: string): string {
    const source = this.getSource(kind);
    if (!source) return `Nguon khong ro: "${kind}".`;
    const account = source.accountLabel
      ? `qua tai khoan ${source.accountLabel}`
      : source.status === 'unknown'
        ? 'chua ro tai khoan — dang nhap chua duoc kiem chung'
        : 'chua dang nhap';
    const state = source.enabled ? 'dang bat' : 'dang tat';
    return `${source.label} (${account}, ${state})`;
  }
}

/** DetectorDefinition toi thieu cho kind chi biet qua registry (label = kind). */
function definitionFor(kind: string, isV116: boolean): DetectorDefinition {
  const v116 = CLI_SOURCES_V116_DETECTORS.find((d) => d.kind === kind);
  if (v116) return v116;
  if (isV116) {
    return {
      kind,
      label: kind,
      binaries: [kind],
      minVersion: '',
      versionArgs: ['--version'],
      auth: { type: 'none' },
    };
  }
  // Kind cu (12 built-in): label lay theo kind — registry khong
  // expose definition, nen dung ban do nhan hien thi co san.
  return {
    kind,
    label: KNOWN_CLI_LABELS[kind] ?? kind,
    binaries: [kind],
    minVersion: '',
    versionArgs: ['--version'],
    auth: { type: 'none' },
  };
}

/** Nhan hien thi cua 12 CLI co san (de listSources co label dung
 * ca khi snapshot chua co entry). */
export const KNOWN_CLI_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok CLI',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  cursor: 'Cursor CLI',
  aider: 'Aider',
  continue: 'Continue',
  copilot: 'GitHub Copilot CLI',
  amazonq: 'Amazon Q CLI',
  windsurf: 'Windsurf',
  kiro: 'Kiro CLI',
  crush: 'Crush',
  goose: 'Goose',
  qwen: 'Qwen Code',
  amp: 'Amp',
  droid: 'Factory Droid',
  pi: 'Pi',
};
