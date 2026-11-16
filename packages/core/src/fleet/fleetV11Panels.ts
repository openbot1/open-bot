/**
 * Fleet panels v11 — view-model cho 3 panel riêng của platform/fleet v11
 * (v1.14, Đội T6): memory, voice, MCP Apps.
 *
 * Các panel này là panel RIÊNG, không nhồi vào màn chat chính (theo
 * hướng UI: chat/bot list/tool browsing/settings quen Grok Bot, tính
 * năng nâng cao sau panel/menu — progressive disclosure). Module này
 * chỉ xây VIEW-MODEL thuần (dữ liệu đã lọc/sắp xếp + quyền + tóm tắt)
 * từ dữ liệu thật của các tầng dưới; component React ở
 * `apps/desktop/src/renderer/components/*PanelV11.tsx` render từ đó.
 *
 * - Memory panel: danh sách block (tìm kiếm/lọc theo loại), lịch sử
 *   version từng block (từ `memory/blockHistory.ts`), kế hoạch rollback
 *   về một version, và ACL — ai được sửa/xóa/restore block nào. Quy tắc
 *   ACL nối tiếp store v12 (`memory/blocks.ts`): block `systemOwned`
 *   chỉ actor `user` được sửa/xóa/restore; agent (`agent:<botId>`) bị
 *   chặn; block `readOnly` không sửa nội dung (chỉ user mới bỏ
 *   readOnly). Module này không tự ghi file — host/store làm việc đó.
 * - Voice panel: dashboard latency từ `VoiceLatencyReport`
 *   (`voice/latencyPipeline.ts`): hàng theo stage (p50/p95/p99), stage
 *   chậm nhất, kiểm tra ngân sách p95; cấu hình barge-in (bật/tắt +
 *   validate ngưỡng); wake word (validate); provider picker từ catalog
 *   v10 (`voice/voiceSettingsV10.ts` — provider + voice + cần key?).
 * - MCP Apps panel: gallery từ catalogue v112
 *   (`mcp/appsCatalogV112.ts` — tìm kiếm/lọc theo category, chỉ app
 *   tương thích), template tạo app mới (blank / note / dashboard),
 *   review quyền (quyền app xin so với quyền host đã cấp, quyền rủi
 *   ro cao được đánh dấu), và tóm tắt CSP/sandbox cho iframe host.
 *
 * Tất cả hàm đều thuần, không đọc file, không chạm mạng. Dữ liệu mock
 * chỉ xuất hiện ở component demo (khi tầng T1/T2/T5 chưa có mặt) — module
 * này không chứa mock.
 */

import {
  compareBlocksForPrompt,
  type MemoryBlock,
} from '../memory/blocks';
import type { BlockVersionSnapshot } from '../memory/blockHistory';
import {
  checkMcpAppV112Compatibility,
  DEFAULT_MCP_APP_V112_HOST_CAPS,
  MCP_APPS_V112_CATALOGUE,
  searchMcpAppsV112,
  type McpAppV112Category,
  type McpAppV112Entry,
  type McpAppV112HostCaps,
  type McpAppV112Install,
  type McpAppV112Permission,
} from '../mcp/appsCatalogV112';
import type { VoiceLatencyReport, VoiceLatencyStage } from '../voice/latencyPipeline';
import {
  VOICE_V10_PROVIDER_CATALOG,
  type VoiceV10ProviderId,
} from '../voice/voiceSettingsV10';

// ---------------------------------------------------------------------------
// Memory panel
// ---------------------------------------------------------------------------

/** Actor đang xem panel memory: `user` hoặc `agent:<botId>`. */
export type FleetV11MemoryActor = string;

/** Quyền của actor trên một block. */
export interface FleetV11MemoryAcl {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  /** Lý do chặn ('' khi được phép làm mọi thứ). */
  deniedReason: string;
}

export function isFleetV11UserActor(actor: string): boolean {
  return actor === 'user';
}

export function isFleetV11AgentActor(actor: string): boolean {
  return actor.startsWith('agent:') && actor.length > 'agent:'.length;
}

/**
 * ACL cho một block. Quy tắc (nối store v12):
 * - Mọi actor đều được xem.
 * - Block `systemOwned`: chỉ `user` được sửa/xóa/restore.
 * - Block `readOnly`: không ai sửa nội dung (kể cả user — user phải bỏ
 *   readOnly trước, việc đó nằm ngoài panel này); xóa/restore vẫn theo
 *   quy tắc systemOwned.
 * - Agent chỉ được sửa/xóa block thường do chính bot đó tạo (hoặc block
 *   không gắn bot nào mà user đã attach cho bot — panel không biết
 *   attachment nên cho phép khi `createdByBotId` rỗng hoặc trùng bot).
 */
export function checkFleetV11MemoryAcl(
  block: MemoryBlock,
  actor: FleetV11MemoryActor,
): FleetV11MemoryAcl {
  const isUser = isFleetV11UserActor(actor);
  const agentBotId = isFleetV11AgentActor(actor) ? actor.slice('agent:'.length) : null;
  if (block.systemOwned && !isUser) {
    return {
      canView: true,
      canEdit: false,
      canDelete: false,
      canRestore: false,
      deniedReason: 'block hệ thống — chỉ người dùng mới được sửa',
    };
  }
  if (block.readOnly) {
    return {
      canView: true,
      canEdit: false,
      canDelete: isUser || agentBotId === block.createdByBotId,
      canRestore: isUser,
      deniedReason: 'block đang read-only — không sửa được nội dung',
    };
  }
  if (agentBotId !== null) {
    const own = block.createdByBotId === '' || block.createdByBotId === agentBotId;
    return {
      canView: true,
      canEdit: own,
      canDelete: own,
      canRestore: own,
      deniedReason: own ? '' : 'block do bot khác tạo',
    };
  }
  return { canView: true, canEdit: true, canDelete: true, canRestore: true, deniedReason: '' };
}

/** Bộ lọc của memory panel. */
export type FleetV11MemoryFilter = 'all' | 'system' | 'user' | 'read-only';

/** Một hàng block trong memory panel. */
export interface FleetV11MemoryBlockRow {
  block: MemoryBlock;
  acl: FleetV11MemoryAcl;
  /** Số version đã lưu trong history (0 = chưa có history). */
  versionCount: number;
  /** Version mới nhất trong history (null = chưa có). */
  latestVersion: number | null;
  /** Block có đang vượt charLimit không (content dài hơn giới hạn). */
  overLimit: boolean;
}

/** View-model của memory panel. */
export interface FleetV11MemoryPanel {
  actor: string;
  filter: FleetV11MemoryFilter;
  query: string;
  totalBlocks: number;
  shownBlocks: number;
  systemBlocks: number;
  readOnlyBlocks: number;
  overLimitBlocks: number;
  rows: FleetV11MemoryBlockRow[];
  summary: string;
}

function memoryBlockMatchesQuery(block: MemoryBlock, needle: string): boolean {
  if (needle.length === 0) return true;
  const hay = `${block.label} ${block.description} ${block.content}`.toLowerCase();
  return hay.includes(needle);
}

/**
 * Xây view-model memory panel: lọc theo loại + tìm kiếm, sắp xếp theo
 * thứ tự prompt (system label trước — tái dùng `compareBlocksForPrompt`
 * của store), kèm ACL từng block và số version từ history.
 */
export function buildFleetV11MemoryPanel(
  blocks: MemoryBlock[],
  historyByBlockId: Record<string, BlockVersionSnapshot[]>,
  actor: FleetV11MemoryActor,
  opts?: { filter?: FleetV11MemoryFilter; query?: string },
): FleetV11MemoryPanel {
  const filter = opts?.filter ?? 'all';
  const query = (opts?.query ?? '').trim().toLowerCase();
  const rows: FleetV11MemoryBlockRow[] = [];
  let systemBlocks = 0;
  let readOnlyBlocks = 0;
  let overLimitBlocks = 0;
  for (const block of blocks) {
    if (block.systemOwned) systemBlocks += 1;
    if (block.readOnly) readOnlyBlocks += 1;
    if (block.content.length > block.charLimit) overLimitBlocks += 1;
    if (filter === 'system' && !block.systemOwned) continue;
    if (filter === 'user' && block.systemOwned) continue;
    if (filter === 'read-only' && !block.readOnly) continue;
    if (!memoryBlockMatchesQuery(block, query)) continue;
    const history = historyByBlockId[block.id] ?? [];
    rows.push({
      block,
      acl: checkFleetV11MemoryAcl(block, actor),
      versionCount: history.length,
      latestVersion: history.length > 0 ? (history[history.length - 1]?.version ?? null) : null,
      overLimit: block.content.length > block.charLimit,
    });
  }
  rows.sort((a, b) => compareBlocksForPrompt(a.block, b.block));
  return {
    actor,
    filter,
    query: opts?.query ?? '',
    totalBlocks: blocks.length,
    shownBlocks: rows.length,
    systemBlocks,
    readOnlyBlocks,
    overLimitBlocks,
    rows,
    summary:
      rows.length === 0
        ? 'Không có block nào khớp bộ lọc.'
        : `${rows.length}/${blocks.length} block — ${systemBlocks} hệ thống, ${readOnlyBlocks} read-only, ${overLimitBlocks} vượt giới hạn ký tự.`,
  };
}

/** Kế hoạch rollback một block về một version trong history. */
export interface FleetV11MemoryRollbackPlan {
  ok: boolean;
  blockId: string;
  label: string;
  fromVersion: number;
  toVersion: number | null;
  /** Nội dung sẽ được khôi phục (null khi không rollback được). */
  restoreContent: string | null;
  /** Actor có được phép restore không + lý do. */
  acl: FleetV11MemoryAcl;
  error: string;
}

/**
 * Lập kế hoạch rollback: tìm snapshot đúng version trong history, kiểm
 * tra ACL của actor. Không ghi file — host áp dụng plan (ghi block +
 * record history) khi user xác nhận.
 */
export function planFleetV11MemoryRollback(
  block: MemoryBlock,
  history: BlockVersionSnapshot[],
  targetVersion: number,
  actor: FleetV11MemoryActor,
): FleetV11MemoryRollbackPlan {
  const acl = checkFleetV11MemoryAcl(block, actor);
  const base = {
    blockId: block.id,
    label: block.label,
    fromVersion: block.version,
    toVersion: null as number | null,
    restoreContent: null as string | null,
    acl,
    error: '',
  };
  if (!acl.canRestore) {
    return { ...base, ok: false, error: acl.deniedReason || 'không có quyền restore block này' };
  }
  if (targetVersion === block.version) {
    return { ...base, ok: false, error: `block đã ở version ${targetVersion}` };
  }
  const snapshot = history.find((s) => s.version === targetVersion);
  if (!snapshot) {
    return { ...base, ok: false, error: `không tìm thấy version ${targetVersion} trong lịch sử` };
  }
  if (snapshot.blockId !== block.id) {
    return { ...base, ok: false, error: 'snapshot không thuộc block này' };
  }
  return { ...base, ok: true, toVersion: targetVersion, restoreContent: snapshot.content };
}

/** Lịch sử version của một block, mới nhất trước, kèm diff ngắn gọn. */
export interface FleetV11MemoryHistoryRow {
  snapshot: BlockVersionSnapshot;
  /** Số ký tự thay đổi so với version trước đó (null = version đầu tiên). */
  charsChanged: number | null;
  /** Có phải version hiện tại của block không. */
  isCurrent: boolean;
}

export function buildFleetV11MemoryHistory(
  block: MemoryBlock,
  history: BlockVersionSnapshot[],
): FleetV11MemoryHistoryRow[] {
  const sorted = [...history].sort((a, b) => b.version - a.version);
  return sorted.map((snapshot, i) => {
    const prev = sorted[i + 1];
    return {
      snapshot,
      charsChanged: prev ? snapshot.content.length - prev.content.length : null,
      isCurrent: snapshot.version === block.version,
    };
  });
}

// ---------------------------------------------------------------------------
// Voice panel
// ---------------------------------------------------------------------------

/** Ngưỡng ngân sách latency cho voice panel (ms). */
export const FLEET_V11_VOICE_P95_BUDGET_MS = 1200;
/** Ngưỡng cảnh báo latency p95 (ms). */
export const FLEET_V11_VOICE_P95_WARN_MS = 800;

/** Một hàng latency theo stage. */
export interface FleetV11VoiceLatencyRow {
  stage: VoiceLatencyStage;
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  meanMs: number | null;
  /** true khi p95 vượt ngân sách. */
  overBudget: boolean;
}

/** Cấu hình barge-in của voice panel. */
export interface FleetV11VoiceBargeInConfig {
  enabled: boolean;
  /** Ngưỡng năng lượng giọng nói để ngắt (0–1). */
  threshold: number;
  /** Thời gian chờ tối thiểu trước khi cho ngắt (ms). */
  minSpeechMs: number;
}

export const DEFAULT_FLEET_V11_BARGE_IN_CONFIG: FleetV11VoiceBargeInConfig = {
  enabled: true,
  threshold: 0.5,
  minSpeechMs: 300,
};

/** Kết quả validate cấu hình barge-in. */
export function validateFleetV11BargeInConfig(
  input: Partial<FleetV11VoiceBargeInConfig> | null | undefined,
): { ok: boolean; errors: string[]; config: FleetV11VoiceBargeInConfig } {
  const errors: string[] = [];
  const enabled = input?.enabled ?? DEFAULT_FLEET_V11_BARGE_IN_CONFIG.enabled;
  const threshold = input?.threshold ?? DEFAULT_FLEET_V11_BARGE_IN_CONFIG.threshold;
  const minSpeechMs = input?.minSpeechMs ?? DEFAULT_FLEET_V11_BARGE_IN_CONFIG.minSpeechMs;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    errors.push('ngưỡng barge-in phải nằm trong khoảng 0–1');
  }
  if (typeof minSpeechMs !== 'number' || !Number.isFinite(minSpeechMs) || minSpeechMs < 0 || minSpeechMs > 5000) {
    errors.push('thời gian chờ tối thiểu phải nằm trong khoảng 0–5000 ms');
  }
  return {
    ok: errors.length === 0,
    errors,
    config: {
      enabled: enabled === true,
      threshold:
        typeof threshold === 'number' && Number.isFinite(threshold)
          ? Math.max(0, Math.min(1, threshold))
          : DEFAULT_FLEET_V11_BARGE_IN_CONFIG.threshold,
      minSpeechMs:
        typeof minSpeechMs === 'number' && Number.isFinite(minSpeechMs)
          ? Math.max(0, Math.min(5000, Math.floor(minSpeechMs)))
          : DEFAULT_FLEET_V11_BARGE_IN_CONFIG.minSpeechMs,
    },
  };
}

/**
 * Validate wake word: 1–3 từ, mỗi từ 2–20 ký tự chữ/số/dấu gạch ngang,
 * tổng 3–40 ký tự, không chứa ký tự đặc biệt. Wake word quá ngắn/dài
 * hoặc có ký tự lạ đều dễ nhận nhầm nên bị từ chối rõ ràng.
 */
export function validateFleetV11WakeWord(raw: unknown): { ok: boolean; errors: string[]; wakeWord: string } {
  const errors: string[] = [];
  const wakeWord = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (wakeWord.length === 0) {
    return { ok: false, errors: ['wake word không được trống'], wakeWord: '' };
  }
  if (wakeWord.length < 3) errors.push('wake word quá ngắn (cần ít nhất 3 ký tự)');
  if (wakeWord.length > 40) errors.push('wake word quá dài (tối đa 40 ký tự)');
  const words = wakeWord.split(' ');
  if (words.length > 3) errors.push('wake word tối đa 3 từ');
  for (const w of words) {
    if (w.length < 2) errors.push(`từ "${w}" quá ngắn (cần ít nhất 2 ký tự)`);
    if (!/^[A-Za-zÀ-ỹ0-9-]+$/.test(w)) errors.push(`từ "${w}" chứa ký tự không hợp lệ`);
  }
  return { ok: errors.length === 0, errors, wakeWord };
}

/** Một provider trong picker của voice panel. */
export interface FleetV11VoiceProviderRow {
  id: VoiceV10ProviderId;
  name: string;
  needsKey: boolean;
  /** true khi provider đã có key / không cần key (dùng được ngay). */
  available: boolean;
  keyHint: string;
  voices: { id: string; name: string; languages: string[]; isDefault: boolean }[];
  /** Voice mặc định của provider (null = không có). */
  defaultVoiceId: string | null;
}

/** View-model của voice panel. */
export interface FleetV11VoicePanel {
  sessionId: string | null;
  mode: string;
  turns: number;
  latencyRows: FleetV11VoiceLatencyRow[];
  slowestStage: { stage: VoiceLatencyStage; p95Ms: number } | null;
  endToEndP95Ms: number | null;
  /** true khi p95 end-to-end vượt ngân sách. */
  endToEndOverBudget: boolean;
  jitterBufferMs: number;
  bargeIn: FleetV11VoiceBargeInConfig;
  bargeInErrors: string[];
  wakeWord: string;
  wakeWordErrors: string[];
  providers: FleetV11VoiceProviderRow[];
  selectedProviderId: VoiceV10ProviderId | null;
  summary: string;
}

/**
 * Xây view-model voice panel từ latency report + cấu hình hiện tại.
 * `providersWithKey` là id các provider đã có key (host biết, panel
 * không đọc key). Provider không có trong catalog thì bị bỏ qua.
 */
export function buildFleetV11VoicePanel(
  report: VoiceLatencyReport | null,
  opts?: {
    bargeIn?: Partial<FleetV11VoiceBargeInConfig>;
    wakeWord?: string;
    providersWithKey?: string[];
    selectedProviderId?: string;
  },
): FleetV11VoicePanel {
  const bargeInCheck = validateFleetV11BargeInConfig(opts?.bargeIn);
  const wakeCheck = validateFleetV11WakeWord(opts?.wakeWord ?? '');
  const withKey = new Set(opts?.providersWithKey ?? []);
  const providers: FleetV11VoiceProviderRow[] = VOICE_V10_PROVIDER_CATALOG.map((p) => ({
    id: p.id,
    name: p.name,
    needsKey: p.needsKey,
    available: !p.needsKey || withKey.has(p.id),
    keyHint: p.keyHint,
    voices: p.voices.map((v) => ({
      id: v.id,
      name: v.name,
      languages: [...v.languages],
      isDefault: v.isDefault === true,
    })),
    defaultVoiceId: p.voices.find((v) => v.isDefault === true)?.id ?? p.voices[0]?.id ?? null,
  }));
  const selected =
    providers.find((p) => p.id === opts?.selectedProviderId) ??
    providers.find((p) => p.available) ??
    null;
  const latencyRows: FleetV11VoiceLatencyRow[] = [];
  if (report) {
    for (const stage of Object.keys(report.stages) as VoiceLatencyStage[]) {
      const s = report.stages[stage];
      latencyRows.push({
        stage,
        count: s?.count ?? 0,
        p50Ms: s?.p50Ms ?? null,
        p95Ms: s?.p95Ms ?? null,
        p99Ms: s?.p99Ms ?? null,
        meanMs: s?.meanMs ?? null,
        overBudget: (s?.p95Ms ?? 0) > FLEET_V11_VOICE_P95_BUDGET_MS,
      });
    }
  }
  const endToEndP95Ms = report?.endToEnd?.p95Ms ?? null;
  const slowestStage = report?.slowestStage ?? null;
  const summary = !report
    ? 'Chưa có dữ liệu latency — bắt đầu một phiên voice để đo.'
    : endToEndP95Ms !== null && endToEndP95Ms > FLEET_V11_VOICE_P95_BUDGET_MS
      ? `Latency end-to-end p95 ${endToEndP95Ms}ms vượt ngân sách ${FLEET_V11_VOICE_P95_BUDGET_MS}ms — stage chậm nhất: ${slowestStage?.stage ?? '?'} (${slowestStage?.p95Ms ?? '?'}ms).`
      : `${report.turns} lượt nói — latency end-to-end p95 ${endToEndP95Ms ?? '?'}ms, trong ngân sách.`;
  return {
    sessionId: report?.sessionId ?? null,
    mode: report?.mode ?? 'balanced',
    turns: report?.turns ?? 0,
    latencyRows,
    slowestStage,
    endToEndP95Ms,
    endToEndOverBudget: endToEndP95Ms !== null && endToEndP95Ms > FLEET_V11_VOICE_P95_BUDGET_MS,
    jitterBufferMs: report?.jitterBufferMs ?? 0,
    bargeIn: bargeInCheck.config,
    bargeInErrors: bargeInCheck.errors,
    wakeWord: wakeCheck.wakeWord,
    wakeWordErrors: wakeCheck.errors,
    providers,
    selectedProviderId: selected?.id ?? null,
    summary,
  };
}

// ---------------------------------------------------------------------------
// MCP Apps panel
// ---------------------------------------------------------------------------

/** Quyền rủi ro cao — panel đánh dấu để user chú ý khi review. */
export const FLEET_V11_MCP_RISKY_PERMISSIONS: readonly McpAppV112Permission[] = [
  'write-files',
  'network',
];

/** Review quyền của một app so với quyền host đã cấp. */
export interface FleetV11McpPermissionReview {
  permission: McpAppV112Permission;
  requested: boolean;
  granted: boolean;
  /** true khi app xin quyền rủi ro cao mà host chưa cấp. */
  risky: boolean;
  /** true khi app xin quyền mà host không cấp (app sẽ bị chặn quyền đó). */
  blocked: boolean;
}

export function reviewFleetV11McpPermissions(
  app: McpAppV112Entry,
  caps: McpAppV112HostCaps,
): FleetV11McpPermissionReview[] {
  const all: McpAppV112Permission[] = [
    'read-files',
    'write-files',
    'network',
    'clipboard',
    'notifications',
  ];
  return all.map((permission) => {
    const requested = app.permissions.includes(permission);
    const granted = caps.grantedPermissions.includes(permission);
    return {
      permission,
      requested,
      granted,
      risky: requested && FLEET_V11_MCP_RISKY_PERMISSIONS.includes(permission),
      blocked: requested && !granted,
    };
  });
}

/** Tóm tắt CSP/sandbox cho một app trên host hiện tại. */
export interface FleetV11McpCspSummary {
  sandboxDirectives: string[];
  allowsNetwork: boolean;
  allowsScripts: boolean;
  /** Cảnh báo (vd app cần mạng nhưng host chặn). */
  warnings: string[];
  summary: string;
}

export function summarizeFleetV11McpCsp(
  app: McpAppV112Entry,
  caps: McpAppV112HostCaps,
): FleetV11McpCspSummary {
  const directives = ["sandbox allow-scripts"];
  if (caps.sandboxStrict) directives.push('sandbox-strict (không allow-same-origin)');
  if (caps.allowNetwork && app.needsNetwork) directives.push('connect-src https: wss:');
  else directives.push('connect-src none');
  const warnings: string[] = [];
  if (app.needsNetwork && !caps.allowNetwork) {
    warnings.push('app cần mạng nhưng host đang chặn mạng — app vẫn mở được, tính năng mạng sẽ lỗi');
  }
  if (app.permissions.includes('write-files') && !caps.grantedPermissions.includes('write-files')) {
    warnings.push('app xin quyền ghi file nhưng host chưa cấp — thao tác ghi sẽ bị chặn');
  }
  if (app.needsScripts && caps.sandboxStrict) {
    warnings.push('sandbox strict: app chạy script trong iframe cô lập, không truy cập được DOM của host');
  }
  return {
    sandboxDirectives: directives,
    allowsNetwork: caps.allowNetwork && app.needsNetwork,
    allowsScripts: app.needsScripts,
    warnings,
    summary:
      warnings.length === 0
        ? 'CSP/sandbox: app chạy an toàn trong iframe cô lập.'
        : `CSP/sandbox: ${warnings.length} cảnh báo cần xem trước khi mở app.`,
  };
}

/** Một hàng app trong gallery. */
export interface FleetV11McpAppRow {
  app: McpAppV112Entry;
  compatible: boolean;
  compatibilityReasons: string[];
  installed: boolean;
  enabled: boolean;
  installedVersion: string | null;
  permissionReviews: FleetV11McpPermissionReview[];
  csp: FleetV11McpCspSummary;
}

/** View-model của MCP Apps panel. */
export interface FleetV11McpAppsPanel {
  query: string;
  category: McpAppV112Category | 'all';
  onlyCompatible: boolean;
  totalApps: number;
  shownApps: number;
  installedCount: number;
  compatibleCount: number;
  categories: { category: McpAppV112Category; count: number }[];
  rows: FleetV11McpAppRow[];
  summary: string;
}

/**
 * Xây view-model MCP Apps panel: gallery (tìm kiếm/lọc category/chỉ app
 * tương thích) + trạng thái cài đặt + review quyền + CSP từng app.
 */
export function buildFleetV11McpAppsPanel(
  opts?: {
    query?: string;
    category?: McpAppV112Category | 'all';
    onlyCompatible?: boolean;
    catalogue?: readonly McpAppV112Entry[];
    installs?: McpAppV112Install[];
    hostCaps?: McpAppV112HostCaps;
  },
): FleetV11McpAppsPanel {
  const catalogue = opts?.catalogue ?? MCP_APPS_V112_CATALOGUE;
  const caps = opts?.hostCaps ?? DEFAULT_MCP_APP_V112_HOST_CAPS;
  const installs = opts?.installs ?? [];
  const installById = new Map(installs.map((i) => [i.appId, i]));
  const category = opts?.category ?? 'all';
  const onlyCompatible = opts?.onlyCompatible ?? false;
  const found = searchMcpAppsV112(opts?.query ?? '', {
    catalogue,
    category: category === 'all' ? undefined : category,
    onlyCompatible,
    hostCaps: caps,
  });
  const categories: { category: McpAppV112Category; count: number }[] = [];
  for (const entry of catalogue) {
    const row = categories.find((c) => c.category === entry.category);
    if (row) row.count += 1;
    else categories.push({ category: entry.category, count: 1 });
  }
  categories.sort((a, b) => a.category.localeCompare(b.category));
  const rows: FleetV11McpAppRow[] = found.map((app) => {
    const compat = checkMcpAppV112Compatibility(app, caps);
    const install = installById.get(app.id);
    return {
      app,
      compatible: compat.compatible,
      compatibilityReasons: compat.reasons,
      installed: install !== undefined,
      enabled: install?.enabled ?? false,
      installedVersion: install?.version ?? null,
      permissionReviews: reviewFleetV11McpPermissions(app, caps),
      csp: summarizeFleetV11McpCsp(app, caps),
    };
  });
  const compatibleCount = rows.filter((r) => r.compatible).length;
  return {
    query: opts?.query ?? '',
    category,
    onlyCompatible,
    totalApps: catalogue.length,
    shownApps: rows.length,
    installedCount: installs.length,
    compatibleCount,
    categories,
    rows,
    summary:
      rows.length === 0
        ? 'Không có app nào khớp bộ lọc.'
        : `${rows.length}/${catalogue.length} app — ${compatibleCount} tương thích, ${installs.length} đã cài.`,
  };
}

/** Loại template tạo app mới. */
export type FleetV11McpAppTemplateKind = 'blank' | 'note' | 'dashboard';

export const FLEET_V11_MCP_APP_TEMPLATE_KINDS: readonly FleetV11McpAppTemplateKind[] = [
  'blank',
  'note',
  'dashboard',
];

/** Template tạo app mới (manifest + file khởi đầu, chưa ghi đĩa). */
export interface FleetV11McpAppTemplate {
  kind: FleetV11McpAppTemplateKind;
  name: string;
  description: string;
  category: McpAppV112Category;
  permissions: McpAppV112Permission[];
  /** Tên file khởi đầu -> nội dung mẫu. */
  files: Record<string, string>;
}

/**
 * Tạo template app mới từ loại. Template chỉ là dữ liệu (manifest +
 * file mẫu) — host ghi file khi user xác nhận tạo app.
 */
export function buildFleetV11McpAppTemplate(
  kind: FleetV11McpAppTemplateKind,
  appId: string,
): FleetV11McpAppTemplate {
  const id = appId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'my-app';
  const manifest = (name: string, description: string, category: McpAppV112Category): string =>
    JSON.stringify(
      { id, name, version: '0.1.0', description, category, permissions: [] as string[] },
      null,
      2,
    );
  if (kind === 'note') {
    return {
      kind,
      name: 'Note',
      description: 'App ghi chú nhanh: một ô nhập + danh sách note lưu local.',
      category: 'productivity',
      permissions: [],
      files: {
        'manifest.json': manifest('Note', 'App ghi chú nhanh', 'productivity'),
        'index.html': [
          '<!doctype html>',
          '<meta charset="utf-8">',
          '<h1>Note</h1>',
          '<textarea id="note" rows="8" cols="40" placeholder="Viết note..."></textarea>',
          '<button id="save">Lưu</button>',
          '<script>',
          "document.getElementById('save').onclick = () => {",
          "  localStorage.setItem('note', document.getElementById('note').value);",
          '};',
          "document.getElementById('note').value = localStorage.getItem('note') || '';",
          '</script>',
        ].join('\n'),
      },
    };
  }
  if (kind === 'dashboard') {
    return {
      kind,
      name: 'Dashboard',
      description: 'App dashboard: 3 thẻ số liệu mẫu, tự cập nhật mỗi giây.',
      category: 'productivity',
      permissions: [],
      files: {
        'manifest.json': manifest('Dashboard', 'App dashboard mẫu', 'productivity'),
        'index.html': [
          '<!doctype html>',
          '<meta charset="utf-8">',
          '<h1>Dashboard</h1>',
          '<div id="stats">—</div>',
          '<script>',
          'setInterval(() => {',
          "  document.getElementById('stats').textContent = 'Cập nhật lúc ' + new Date().toLocaleTimeString();",
          '}, 1000);',
          '</script>',
        ].join('\n'),
      },
    };
  }
  return {
    kind,
    name: 'Blank',
    description: 'App trống: chỉ có manifest + trang trắng để tự xây tiếp.',
    category: 'productivity',
    permissions: [],
    files: {
      'manifest.json': manifest('Blank app', 'App trống', 'productivity'),
      'index.html': [
        '<!doctype html>',
        '<meta charset="utf-8">',
        '<h1>Blank app</h1>',
        '<p>Bắt đầu xây app của bạn từ đây.</p>',
      ].join('\n'),
    },
  };
}
