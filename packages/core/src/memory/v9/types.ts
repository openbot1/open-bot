/**
 * Memory v9 — types chung (v1.08, Đội T1).
 *
 * Ý tưởng học từ Letta (sleep-time compute, git-backed memory,
 * shared memory blocks), viết lại hoàn toàn cho open-bot, chạy 100%
 * local, không copy code/tài sản nào. v9 nối ba mảnh mà các phiên
 * bản trước để rời:
 *
 *  1. SLEEP AGENT NỀN TỰ ĐỘNG: v0.97 có SleepTimeAgent (chạy theo
 *     bước/khi compact/thủ công) và v8 có SleepV8Scheduler (policy
 *     bền + nén block + ledger), nhưng chưa có một daemon nối chúng
 *     lại — chạy nền giữa các session, trigger khi session kết thúc,
 *     khi rảnh, hoặc theo giờ hẹn, với job lifecycle + run log đầy
 *     đủ. Đó là `SleepV9Agent` (xem sleepAgent.ts).
 *  2. GIT-BACKED VERSIONING CHO BLOCK: v7 lưu block thành file .md
 *     trong repo git riêng (diff/blame/history thô đã có), v3/v1.02
 *     có snapshot JSONL — nhưng chưa có một API thống nhất: snapshot
 *     có tên + ghi chú, xem lịch sử phiên bản gộp (snapshot + git),
 *     diff từng dòng giữa hai phiên bản, rollback về phiên bản cũ
 *     (ghi lại thành phiên bản mới, không viết lại lịch sử). Đó là
 *     `MemoryV9VersionStore` (xem versioning.ts).
 *  3. SHARED-BLOCK REGISTRY: v1.03 có nhóm share (SharedBlockGroup)
 *     và v8 có gói sync fleet — nhưng chưa có registry cấp block:
 *     đăng ký block dùng chung, ACL đọc/ghi theo từng bot, đồng bộ
 *     thay đổi qua change feed, phát hiện xung đột ghi đồng thời
 *     (base-version check). Đó là `SharedBlockRegistry`
 *     (xem sharedRegistry.ts).
 *
 * File này chỉ chứa type + hằng số + chuẩn hoá — không có I/O.
 */
import * as path from 'node:path';

/* ------------------------------------------------------------------ */
/* Đường dẫn lưu trữ (trong workspace, dưới .open-bot/)               */
/* ------------------------------------------------------------------ */

/** Policy sleep v9 (JSON, ghi atomic, mode 0600). */
export const V9_SLEEP_POLICY_REL_PATH = path.join('.open-bot', 'memory-v9-sleep-policy.json');
/** Run log sleep v9 (JSONL append-only, một dòng một lần chạy). */
export const V9_SLEEP_RUN_LOG_REL_PATH = path.join('.open-bot', 'memory-v9-sleep-runs.jsonl');
/** Tóm tắt lần chạy sleep v9 gần nhất (JSON, để UI đọc nhanh). */
export const V9_SLEEP_LATEST_REL_PATH = path.join('.open-bot', 'memory-v9-sleep-latest.json');
/** Snapshot phiên bản block v9 (JSONL append-only). */
export const V9_SNAPSHOTS_REL_PATH = path.join('.open-bot', 'memory-v9-snapshots.jsonl');
/** Registry block dùng chung v9 (JSON). */
export const V9_SHARED_REGISTRY_REL_PATH = path.join('.open-bot', 'memory-v9-shared-registry.json');
/** Change feed block dùng chung v9 (JSONL append-only). */
export const V9_SHARED_CHANGES_REL_PATH = path.join('.open-bot', 'memory-v9-shared-changes.jsonl');
/** Xung đột ghi block dùng chung v9 (JSON). */
export const V9_SHARED_CONFLICTS_REL_PATH = path.join('.open-bot', 'memory-v9-shared-conflicts.json');

/** Actor ghi vào git/history khi sleep v9 hoặc versioning v9 sửa block. */
export const V9_SLEEP_ACTOR = 'sleep:v9';
export const V9_VERSION_ACTOR = 'version:v9';
export const V9_SHARED_ACTOR_PREFIX = 'shared:v9';

/** Số lần chạy tối đa giữ trong run log (cũ hơn bị cắt khi đọc). */
export const V9_SLEEP_RUN_LOG_KEEP = 200;
/** Số snapshot tối đa giữ cho một block (cũ nhất bị cắt khi ghi). */
export const V9_SNAPSHOTS_PER_BLOCK_KEEP = 30;
/** Số change feed tối đa giữ cho một block (cũ nhất bị cắt khi ghi). */
export const V9_SHARED_CHANGES_PER_BLOCK_KEEP = 200;
/** Số xung đột tối đa giữ trong file xung đột. */
export const V9_SHARED_CONFLICTS_KEEP = 100;
/** Độ dài tối đa của ghi chú snapshot / tóm tắt change. */
export const V9_MAX_NOTE_CHARS = 500;
/** Độ dài tối đa của nội dung merge khi resolve xung đột. */
export const V9_MAX_MERGED_CONTENT_CHARS = 20000;

/** Lỗi memory v9 — mọi message đều tiếng Việt. */
export class V9Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V9Error';
  }
}

/* ------------------------------------------------------------------ */
/* Sleep agent v9 — policy                                            */
/* ------------------------------------------------------------------ */

/** Cách một lần chạy sleep v9 được kích hoạt. */
export type V9SleepTrigger = 'session-end' | 'idle' | 'scheduled' | 'manual';

/** Trigger nào được phép chạy tự động (manual luôn chạy khi gọi tay). */
export interface V9SleepTriggers {
  /** Chạy khi một session kết thúc (đủ dài/đủ turn). */
  sessionEnd: boolean;
  /** Chạy khi không có hoạt động đủ lâu (idleMs). */
  idle: boolean;
  /** Chạy một lần mỗi ngày vào giờ hẹn (scheduledHour != null). */
  scheduled: boolean;
}

/** Giờ yên lặng: không chạy tự động (chạy tay vẫn được). */
export interface V9QuietHours {
  startHour: number;
  endHour: number;
}

/** Các bước trong một lần chạy sleep v9 (tắt bước nào thì bỏ qua). */
export interface V9SleepSteps {
  /** Chạy consolidation v8: dedupe/summary/quarantine bản ghi + nén block. */
  consolidateV8: boolean;
  /** Trích xuất fact từ transcript session (SleepTimeAgent v0.97). */
  extractFacts: boolean;
  /** Snapshot các block đã đổi trong lần chạy (để rollback được). */
  snapshotBlocks: boolean;
}

/** Policy sleep v9 (lưu bền trong workspace). */
export interface V9SleepPolicy {
  /** Master switch — mặc định TẮT (không chạy gì khi chưa bật). */
  enabled: boolean;
  triggers: V9SleepTriggers;
  /** Ngưỡng rảnh cho trigger idle (ms, mặc định 10 phút). */
  idleMs: number;
  /** Chu kỳ kiểm tra trigger của daemon (ms, mặc định 60 giây). */
  checkIntervalMs: number;
  /** Session phải có ít nhất bấy nhiêu turn mới đủ điều kiện chạy khi kết thúc. */
  sessionMinTurns: number;
  /** Session phải kéo dài ít nhất bấy nhiêu phút mới đủ điều kiện chạy khi kết thúc. */
  sessionMinMinutes: number;
  /** Nghỉ tối thiểu giữa hai lần chạy tự động (ms, mặc định 30 phút). */
  cooldownMs: number;
  /** Giờ hẹn chạy mỗi ngày (0-23, null = không hẹn giờ). */
  scheduledHour: number | null;
  /** Phút hẹn (0-59, dùng cùng scheduledHour). */
  scheduledMinute: number;
  quietHours: V9QuietHours;
  /** Số lần chạy tự động tối đa mỗi ngày (0 = không giới hạn). */
  maxRunsPerDay: number;
  /** Thời gian tối đa một job được chạy (ms) — quá thì dừng sớm, báo partial. */
  maxJobMs: number;
  steps: V9SleepSteps;
}

/** Policy mặc định (bản sao mới mỗi lần gọi). */
export const DEFAULT_V9_SLEEP_POLICY: V9SleepPolicy = {
  enabled: false,
  triggers: { sessionEnd: true, idle: true, scheduled: false },
  idleMs: 10 * 60 * 1000,
  checkIntervalMs: 60 * 1000,
  sessionMinTurns: 5,
  sessionMinMinutes: 5,
  cooldownMs: 30 * 60 * 1000,
  scheduledHour: null,
  scheduledMinute: 0,
  quietHours: { startHour: 0, endHour: 0 },
  maxRunsPerDay: 12,
  maxJobMs: 120 * 1000,
  steps: { consolidateV8: true, extractFacts: true, snapshotBlocks: true },
};

/** File policy trên đĩa. */
export interface V9SleepPolicyFile {
  version: 1;
  policy: V9SleepPolicy;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(value as number);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clampHour(value: unknown, fallback: number): number {
  return clampInt(value, fallback, 0, 23);
}

/** Policy mặc định (bản sao mới, tránh caller sửa nhầm hằng số). */
export function defaultV9SleepPolicy(): V9SleepPolicy {
  return {
    ...DEFAULT_V9_SLEEP_POLICY,
    triggers: { ...DEFAULT_V9_SLEEP_POLICY.triggers },
    quietHours: { ...DEFAULT_V9_SLEEP_POLICY.quietHours },
    steps: { ...DEFAULT_V9_SLEEP_POLICY.steps },
  };
}

/** Chuẩn hoá policy đọc từ đĩa (thiếu trường -> mặc định, sai -> kẹp về biên). */
export function normalizeV9SleepPolicy(raw: Partial<V9SleepPolicy>): V9SleepPolicy {
  const base = defaultV9SleepPolicy();
  const triggers: Partial<V9SleepTriggers> = raw.triggers ?? {};
  const steps: Partial<V9SleepSteps> = raw.steps ?? {};
  const quiet: Partial<V9QuietHours> = raw.quietHours ?? {};
  const scheduledHour =
    raw.scheduledHour === null || raw.scheduledHour === undefined
      ? null
      : clampHour(raw.scheduledHour, 0);
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    triggers: {
      sessionEnd: typeof triggers.sessionEnd === 'boolean' ? triggers.sessionEnd : base.triggers.sessionEnd,
      idle: typeof triggers.idle === 'boolean' ? triggers.idle : base.triggers.idle,
      scheduled: typeof triggers.scheduled === 'boolean' ? triggers.scheduled : base.triggers.scheduled,
    },
    idleMs: clampInt(raw.idleMs, base.idleMs, 0, 24 * 60 * 60 * 1000),
    checkIntervalMs: clampInt(raw.checkIntervalMs, base.checkIntervalMs, 1000, 60 * 60 * 1000),
    sessionMinTurns: clampInt(raw.sessionMinTurns, base.sessionMinTurns, 0, 1000),
    sessionMinMinutes: clampInt(raw.sessionMinMinutes, base.sessionMinMinutes, 0, 24 * 60),
    cooldownMs: clampInt(raw.cooldownMs, base.cooldownMs, 0, 24 * 60 * 60 * 1000),
    scheduledHour,
    scheduledMinute: clampInt(raw.scheduledMinute, base.scheduledMinute, 0, 59),
    quietHours: {
      startHour: clampHour(quiet.startHour, base.quietHours.startHour),
      endHour: clampHour(quiet.endHour, base.quietHours.endHour),
    },
    maxRunsPerDay: clampInt(raw.maxRunsPerDay, base.maxRunsPerDay, 0, 1000),
    maxJobMs: clampInt(raw.maxJobMs, base.maxJobMs, 1000, 30 * 60 * 1000),
    steps: {
      consolidateV8: typeof steps.consolidateV8 === 'boolean' ? steps.consolidateV8 : base.steps.consolidateV8,
      extractFacts: typeof steps.extractFacts === 'boolean' ? steps.extractFacts : base.steps.extractFacts,
      snapshotBlocks: typeof steps.snapshotBlocks === 'boolean' ? steps.snapshotBlocks : base.steps.snapshotBlocks,
    },
  };
}

/** true khi `date` rơi vào giờ yên lặng của policy (giờ địa phương). */
export function isInV9QuietHours(policy: V9SleepPolicy, date = new Date()): boolean {
  const { startHour, endHour } = policy.quietHours;
  if (startHour === endHour) return false;
  const hour = date.getHours();
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/* ------------------------------------------------------------------ */
/* Sleep agent v9 — job + run log                                     */
/* ------------------------------------------------------------------ */

/** Vòng đời của một sleep job. */
export type V9SleepJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

/** Kết quả một bước trong job. */
export interface V9SleepStepResult {
  step: 'consolidate-v8' | 'extract-facts' | 'snapshot-blocks';
  ok: boolean;
  /** Tóm tắt ngắn gọn những gì bước đó đã làm. */
  detail: string;
  ms: number;
}

/** Đếm số liệu gộp của một job. */
export interface V9SleepJobCounts {
  recordsExamined: number;
  recordsDeduped: number;
  recordsSummarized: number;
  recordsQuarantined: number;
  blocksCompressed: number;
  summaryBlocksCreated: number;
  factsExtracted: number;
  factsStored: number;
  factsFlagged: number;
  snapshotsCreated: number;
}

export function emptyV9SleepJobCounts(): V9SleepJobCounts {
  return {
    recordsExamined: 0,
    recordsDeduped: 0,
    recordsSummarized: 0,
    recordsQuarantined: 0,
    blocksCompressed: 0,
    summaryBlocksCreated: 0,
    factsExtracted: 0,
    factsStored: 0,
    factsFlagged: 0,
    snapshotsCreated: 0,
  };
}

/** Một sleep job: từ lúc xếp hàng tới lúc xong (hoặc lỗi/bỏ qua). */
export interface V9SleepJob {
  id: string;
  trigger: V9SleepTrigger;
  botId: string;
  /** Session gây ra job (chỉ trigger session-end / manual có session). */
  sessionId?: string;
  status: V9SleepJobStatus;
  dryRun: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  steps: V9SleepStepResult[];
  counts: V9SleepJobCounts;
  /** Lý do skip/cancel (vd "session quá ngắn", "đang trong giờ yên lặng"). */
  reason?: string;
  errors: string[];
}

/** Một dòng trong run log = một job đã kết thúc (hoặc bị skip). */
export type V9SleepRunLogEntry = V9SleepJob;

/** Session đang mở mà daemon theo dõi (để quyết định session-end). */
export interface V9TrackedSession {
  sessionId: string;
  botId: string;
  startedAt: string;
  endedAt?: string;
  turns: number;
  /** Transcript (turn user/bot) để trích fact khi session kết thúc. */
  episodes: Array<{ id: string; role: 'user' | 'bot'; text: string; at: string }>;
}

/** Trạng thái daemon trả về cho tool/UI. */
export interface V9SleepAgentStatus {
  enabled: boolean;
  started: boolean;
  runningJobId: string | null;
  queuedJobs: number;
  trackedSessions: number;
  totalRuns: number;
  runsToday: number;
  lastRun: V9SleepRunLogEntry | null;
  /** Lần chạy tự động kế tiếp dự kiến (null khi không hẹn được). */
  nextScheduledRunAt: string | null;
  policy: V9SleepPolicy;
}

/* ------------------------------------------------------------------ */
/* Versioning v9 — snapshot / history / diff / rollback               */
/* ------------------------------------------------------------------ */

/** Một snapshot phiên bản của block (lưu đủ nội dung để rollback). */
export interface V9Snapshot {
  id: string;
  label: string;
  version: number;
  content: string;
  /** SHA-256 hex của content (để đối chiếu nhanh, chống sửa tay). */
  contentHash: string;
  /** Commit git gần nhất của block lúc snapshot ('' khi không có git). */
  commit: string;
  note: string;
  actor: string;
  at: string;
}

/** Một phiên bản trong lịch sử gộp của block. */
export interface V9VersionInfo {
  version: number;
  at: string;
  actor: string;
  /** create/update/delete/rollback/snapshot — nguồn nào ghi version này. */
  action: string;
  commit: string;
  contentHash: string;
  chars: number;
  note?: string;
  /** 'snapshot' = snapshot v9, 'git' = commit git v7, 'history-log' = history.jsonl dự phòng. */
  source: 'snapshot' | 'git' | 'history-log';
}

/** Một dòng trong diff (kiểu unified, có số dòng hai phía). */
export interface V9DiffLine {
  type: ' ' | '+' | '-';
  text: string;
  /** Số dòng phía cũ (null khi dòng mới thêm). */
  oldLineNo: number | null;
  /** Số dòng phía mới (null khi dòng bị xoá). */
  newLineNo: number | null;
}

/** Một hunk trong diff (nhóm dòng đổi liền kề + 3 dòng context). */
export interface V9DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: V9DiffLine[];
}

/** Kết quả diff giữa hai phiên bản của một block. */
export interface V9VersionDiff {
  label: string;
  fromVersion: number;
  toVersion: number;
  fromAt: string;
  toAt: string;
  addedLines: number;
  removedLines: number;
  hunks: V9DiffHunk[];
  /** Text diff thô từ git (khi có git và hai phiên bản đều có commit). */
  gitDiff?: string;
}

/** Kết quả rollback một block về phiên bản cũ. */
export interface V9RollbackReport {
  label: string;
  fromVersion: number;
  toVersion: number;
  /** Phiên bản mới được tạo ra bởi rollback (version cũ + 1). */
  newVersion: number;
  actor: string;
  at: string;
  /** true = nội dung đã được ghi lại; false = đã ở đúng nội dung đó. */
  changed: boolean;
  snapshotId: string | null;
}

/* ------------------------------------------------------------------ */
/* Shared-block registry v9 — ACL / change feed / xung đột            */
/* ------------------------------------------------------------------ */

/** Quyền của một bot trên block dùng chung. */
export type V9SharedRole = 'read' | 'write' | 'admin';

/** Một mục ACL: bot nào, quyền gì, ai cấp, khi nào. */
export interface V9SharedAclEntry {
  botId: string;
  role: V9SharedRole;
  grantedBy: string;
  grantedAt: string;
}

/** Một block đã đăng ký dùng chung. */
export interface V9SharedBlockEntry {
  id: string;
  label: string;
  ownerBotId: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /** Phiên bản hiện tại của block (đồng bộ với version của projection). */
  version: number;
  /** Version vector: bot nào đã ghi tới version nào (phát hiện ghi đồng thời). */
  versionVector: Record<string, number>;
  acl: V9SharedAclEntry[];
  /** Seq change cuối cùng mỗi bot đã thấy (đồng bộ). */
  seenSeq: Record<string, number>;
  /** Seq change mới nhất của block. */
  lastChangeSeq: number;
}

/** File registry trên đĩa. */
export interface V9SharedRegistryFile {
  version: 1;
  blocks: V9SharedBlockEntry[];
}

/** Một thay đổi trên block dùng chung (change feed). */
export interface V9SharedChange {
  seq: number;
  label: string;
  botId: string;
  baseVersion: number;
  newVersion: number;
  contentHash: string;
  summary: string;
  at: string;
}

/** Cách giải quyết một xung đột ghi. */
export type V9SharedConflictResolution = 'keep-mine' | 'keep-theirs' | 'merged';

/** Trạng thái xung đột. */
export type V9SharedConflictStatus = 'pending' | 'resolved';

/** Một xung đột ghi đồng thời trên block dùng chung. */
export interface V9SharedConflict {
  id: string;
  label: string;
  /** Bot đã ghi đè lên version mà writer dựa vào. */
  writerBotId: string;
  /** Version mà writer dựa vào khi sửa (base). */
  baseVersion: number;
  /** Version hiện tại lúc writer ghi (đã có người khác ghi trước). */
  localVersion: number;
  /** Version mà lần ghi này muốn tạo (localVersion + 1). */
  incomingVersion: number;
  incomingContentHash: string;
  incomingSummary: string;
  /** Nội dung writer muốn ghi (giữ lại để resolve keep-theirs/merged). */
  incomingContent: string;
  status: V9SharedConflictStatus;
  resolution?: V9SharedConflictResolution;
  resolvedBy?: string;
  resolvedAt?: string;
  /** Nội dung cuối cùng sau khi resolve (merged / keep-theirs). */
  resolvedContentHash?: string;
  at: string;
}

/** File xung đột trên đĩa. */
export interface V9SharedConflictsFile {
  version: 1;
  conflicts: V9SharedConflict[];
}

/** Kết quả ghi vào block dùng chung. */
export interface V9SharedWriteResult {
  label: string;
  botId: string;
  /** true = ghi thành công; false = bị chặn (không có quyền / xung đột). */
  ok: boolean;
  /** 'written' | 'conflict' | 'forbidden' | 'not-registered' | 'not-found'. */
  outcome: 'written' | 'conflict' | 'forbidden' | 'not-registered' | 'not-found';
  newVersion?: number;
  conflictId?: string;
  changeSeq?: number;
  detail: string;
}

/** Trạng thái đồng bộ của một block dùng chung. */
export interface V9SharedSyncStatus {
  label: string;
  registered: boolean;
  ownerBotId?: string;
  version?: number;
  versionVector?: Record<string, number>;
  bots: Array<{ botId: string; role: V9SharedRole; lastSeenSeq: number }>;
  pendingConflicts: number;
  lastChangeSeq: number;
  lastChangeAt?: string;
}

/** Thứ tự quyền: read < write < admin (để so sánh). */
export const V9_SHARED_ROLE_RANK: Record<V9SharedRole, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/** Chuẩn hoá label block (trim + lowercase, giống MemoryBlockStore). */
export function normalizeV9BlockLabel(raw: string): string {
  return (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Chuẩn hoá bot id (trim + lowercase, rỗng -> ''). */
export function normalizeV9BotId(raw: string): string {
  return (raw ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}
