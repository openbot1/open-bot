/**
 * Agent Teams v2 — types (v1.10, Đội T3).
 *
 * V2 xây trên v1 (packages/core/src/teams, Đội T1): giữ nguyên
 * TeamService/TeamTask/MailboxMessage v1, thêm lớp bền vững trên
 * disk cho những gì v1 chỉ giữ trong bộ nhớ/process:
 *
 * - Claim lock trên disk: lock file nguyên tử (`wx`) + lease có
 *   hạn + heartbeat — 2 process/agent khác nhau không giành cùng
 *   task, teammate chết thì lease hết hạn và task được requeue.
 * - Mailbox bền vững theo TÊN: inbox/outbox là file JSON trên
 *   disk, gửi/nhận theo tên teammate, xác nhận đã đọc (readAt).
 * - Session/context riêng mỗi teammate: file session lưu goal,
 *   model, specialty, ghi chú ngữ cảnh của teammate đó.
 * - Fork subagent: cây fork có giới hạn độ sâu + song song, merge
 *   kết quả (tóm tắt + artifact) về task cha.
 * - Hook TaskCompleted: chạy khi teammate đánh dấu xong; exit 2
 *   = giữ task mở kèm feedback của reviewer.
 * - Giới hạn team 3–5 teammate + ước tính/cảnh báo chi phí token.
 *
 * Ý tưởng học từ Claude Code Agent Teams + Codex manager/worker
 * (survey v1.10 §2 — shared task list file-locked, mailbox theo
 * tên, fork subagent, hook TaskCompleted exit 2, team 3–5, chi phí
 * ~7x token): chỉ học ý tưởng, toàn bộ code viết mới cho open-bot.
 *
 * Không chứa secret: lock/mailbox/session/fork chỉ lưu tên, id,
 * tóm tắt, artifact path — không lưu API key hay nội dung nhạy cảm.
 */

import type { AgentTeamV109, TeamTask, Teammate } from '../types';

/** Team v2 nên có 3–5 teammate (khuyến nghị của Claude Code Agent Teams). */
export const RECOMMENDED_MIN_TEAMMATES = 3;
export const RECOMMENDED_MAX_TEAMMATES = 5;

/** Lease mặc định của claim lock (ms): teammate phải heartbeat trước khi hết hạn. */
export const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
/** Khoảng heartbeat khuyến nghị (ms) — nhỏ hơn lease để kịp gia hạn. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/** Độ sâu fork tối đa (mặc định 3 tầng, như Claude Code). */
export const DEFAULT_MAX_FORK_DEPTH = 3;
/** Số fork chạy song song tối đa mặc định (gắn với cỡ team 3–5). */
export const DEFAULT_MAX_CONCURRENT_FORKS = 5;
/** Trần tuyệt đối số fork song song (tránh fork-bomb). */
export const ABSOLUTE_MAX_CONCURRENT_FORKS = 20;

/** Ngân sách token mặc định của một team (token ước tính). */
export const DEFAULT_TEAM_TOKEN_BUDGET = 200_000;
/** Ngưỡng cảnh báo chi phí: vượt 80% ngân sách thì cảnh báo. */
export const DEFAULT_TOKEN_WARN_RATIO = 0.8;

/** Số tin tối đa giữ trong một hộp thư disk (inbox/outbox) của một teammate. */
export const MAX_DISK_MAILBOX_PER_BOX = 500;

/** Tên thư mục v2 trong thư mục dữ liệu của app. */
export const TEAMS_V2_DIR = 'teams-v2';
/** Tên file trạng thái v2 của một team (trong teams-v2/<teamId>/). */
export const TEAM_V2_STATE_FILE = 'v2.json';

/** Cấu hình v2 của một team (lưu riêng trong teams-v2/<teamId>/v2.json). */
export interface TeamV2Config {
  /** Số teammate tối thiểu khuyến nghị (mặc định 3 — chỉ cảnh báo, không chặn). */
  recommendedMinTeammates: number;
  /** Số teammate tối đa khuyến nghị (mặc định 5 — vượt thì cần allowOverRecommended). */
  recommendedMaxTeammates: number;
  /** Cho phép vượt recommendedMaxTeammates (mặc định false). */
  allowOverRecommended: boolean;
  /** Ngân sách token ước tính của team (mặc định 200.000). */
  tokenBudget: number;
  /** Tỉ lệ ngân sách thì cảnh báo (mặc định 0.8 = 80%). */
  tokenWarnRatio: number;
  /** Token ước tính cho mỗi teammate (mặc định 8000). */
  tokensPerTeammate: number;
  /** Token ước tính cho mỗi task (mặc định 4000). */
  tokensPerTask: number;
  /** Token ước tính cho mỗi tin mailbox (mặc định 300). */
  tokensPerMessage: number;
  /** Token ước tính cho mỗi fork subagent (mặc định 6000). */
  tokensPerFork: number;
  /** Lease của claim lock, ms (mặc định 5 phút). */
  claimLeaseMs: number;
  /** Khoảng heartbeat khuyến nghị, ms (mặc định 60 giây). */
  heartbeatIntervalMs: number;
  /** Độ sâu fork tối đa (mặc định 3). */
  maxForkDepth: number;
  /** Số fork chạy song song tối đa (mặc định 5, tối đa 20). */
  maxConcurrentForks: number;
  /** Lệnh hook TaskCompleted (shell command; trống = không chạy hook). */
  taskCompletedHookCommand?: string;
  /** Timeout hook TaskCompleted, ms (mặc định 30 giây). */
  hookTimeoutMs: number;
}

/** Cấu hình v2 mặc định. */
export function defaultTeamV2Config(): TeamV2Config {
  return {
    recommendedMinTeammates: RECOMMENDED_MIN_TEAMMATES,
    recommendedMaxTeammates: RECOMMENDED_MAX_TEAMMATES,
    allowOverRecommended: false,
    tokenBudget: DEFAULT_TEAM_TOKEN_BUDGET,
    tokenWarnRatio: DEFAULT_TOKEN_WARN_RATIO,
    tokensPerTeammate: 8000,
    tokensPerTask: 4000,
    tokensPerMessage: 300,
    tokensPerFork: 6000,
    claimLeaseMs: DEFAULT_CLAIM_LEASE_MS,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    maxForkDepth: DEFAULT_MAX_FORK_DEPTH,
    maxConcurrentForks: DEFAULT_MAX_CONCURRENT_FORKS,
    hookTimeoutMs: 30_000,
  };
}

/** Validate cấu hình v2, trả về lỗi (rỗng = hợp lệ). */
export function validateTeamV2Config(config: Partial<TeamV2Config>): string[] {
  const errors: string[] = [];
  const checkInt = (v: number | undefined, name: string, min: number, max?: number): void => {
    if (v === undefined) return;
    if (!Number.isInteger(v) || v < min) errors.push(`${name} phải là số nguyên >= ${min}.`);
    else if (max !== undefined && v > max) errors.push(`${name} tối đa ${max}.`);
  };
  checkInt(config.recommendedMinTeammates, 'recommendedMinTeammates', 1);
  checkInt(config.recommendedMaxTeammates, 'recommendedMaxTeammates', 1, 32);
  checkInt(config.tokenBudget, 'tokenBudget', 1);
  if (config.tokenWarnRatio !== undefined && (!Number.isFinite(config.tokenWarnRatio) || config.tokenWarnRatio <= 0 || config.tokenWarnRatio > 1)) {
    errors.push('tokenWarnRatio phải trong (0, 1].');
  }
  checkInt(config.tokensPerTeammate, 'tokensPerTeammate', 0);
  checkInt(config.tokensPerTask, 'tokensPerTask', 0);
  checkInt(config.tokensPerMessage, 'tokensPerMessage', 0);
  checkInt(config.tokensPerFork, 'tokensPerFork', 0);
  checkInt(config.claimLeaseMs, 'claimLeaseMs', 1000);
  checkInt(config.heartbeatIntervalMs, 'heartbeatIntervalMs', 1000);
  checkInt(config.maxForkDepth, 'maxForkDepth', 1, 5);
  checkInt(config.maxConcurrentForks, 'maxConcurrentForks', 1, ABSOLUTE_MAX_CONCURRENT_FORKS);
  checkInt(config.hookTimeoutMs, 'hookTimeoutMs', 1000);
  if (
    config.recommendedMinTeammates !== undefined &&
    config.recommendedMaxTeammates !== undefined &&
    config.recommendedMinTeammates > config.recommendedMaxTeammates
  ) {
    errors.push('recommendedMinTeammates không được lớn hơn recommendedMaxTeammates.');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Claim lock (disk)
// ---------------------------------------------------------------------------

/** Một claim lock trên disk: ai giữ task nào, lease tới khi nào. */
export interface ClaimLock {
  /** Id task bị khóa. */
  taskId: string;
  /** Id teammate đang giữ. */
  ownerId: string;
  /** Tên teammate đang giữ (snapshot để đọc log). */
  ownerName: string;
  /** Thời điểm lấy lock (ms epoch). */
  acquiredAt: number;
  /** Thời điểm heartbeat gần nhất (ms epoch). */
  heartbeatAt: number;
  /** Lease hết hạn lúc này (ms epoch) — quá hạn = lock treo. */
  leaseUntil: number;
  /** PID của process giữ lock (để debug, có thể trống). */
  pid?: number;
}

/** Kết quả một thao tác lock. */
export type ClaimLockResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

// ---------------------------------------------------------------------------
// Disk mailbox (theo tên)
// ---------------------------------------------------------------------------

/** Một tin nhắn mailbox bền vững trên disk (mở rộng MailboxMessage v1). */
export interface DiskMailboxMessage {
  /** Id ổn định, `msg-<uuid ngắn>` (cùng id ở inbox người nhận + outbox người gửi). */
  id: string;
  teamId: string;
  /** Tên người gửi (địa chỉ theo TÊN — mailbox v2 định danh bằng tên). */
  fromName: string;
  fromId: string;
  /** Tên người nhận, hoặc '*' = broadcast toàn team. */
  toName: string;
  toId: string;
  kind: 'request' | 'result' | 'question' | 'broadcast';
  taskId?: string;
  body: string;
  createdAt: number;
  /** Đã đọc chưa — xác nhận đã đọc: thời điểm + ai đọc (chỉ inbox mới có). */
  read: boolean;
  readAt?: number;
  readBy?: string;
}

/** Hộp thư disk của một teammate: inbox + outbox + số chưa đọc. */
export interface DiskMailboxBox {
  teammateName: string;
  inbox: DiskMailboxMessage[];
  outbox: DiskMailboxMessage[];
  unreadCount: number;
}

// ---------------------------------------------------------------------------
// Teammate session / context riêng
// ---------------------------------------------------------------------------

/** Session riêng của một teammate: context của nó, tách khỏi lead và teammate khác. */
export interface TeammateSession {
  /** Id teammate. */
  mateId: string;
  /** Tên teammate. */
  name: string;
  teamId: string;
  role: 'lead' | 'teammate';
  model?: string;
  specialty?: string;
  partition?: string;
  /** Mục tiêu team (snapshot lúc spawn — context riêng của teammate). */
  teamGoal: string;
  /** Ghi chú ngữ cảnh riêng (lead dặn, kết quả fork, ...). */
  contextNotes: { at: number; note: string }[];
  /** Task đang được giao (lead assign). */
  assignedTaskIds: string[];
  createdAt: number;
  updatedAt: number;
  /** Thời điểm session đóng (teammate rời team / team tan). */
  closedAt?: number;
}

// ---------------------------------------------------------------------------
// Fork subagent
// ---------------------------------------------------------------------------

/** Trạng thái của một fork subagent. */
export type ForkStatus = 'running' | 'done' | 'error' | 'merged';

/** Một fork subagent: context riêng + merge kết quả về parent. */
export interface ForkNode {
  /** Id ổn định, `fork-<uuid ngắn>`. */
  id: string;
  teamId: string;
  /** Task cha mà fork này phục vụ (fork làm một phần của task cha). */
  parentTaskId: string;
  /** Fork cha (khi fork lồng nhau); trống = fork trực tiếp từ team. */
  parentForkId?: string;
  /** Độ sâu: fork trực tiếp = 1, fork của fork = 2, ... */
  depth: number;
  /** Tên/mục đích ngắn của fork. */
  name: string;
  /** Context riêng của fork: việc nó phải làm. */
  task: string;
  /** Id teammate sở hữu fork (ai spawn). */
  spawnedById: string;
  spawnedByName: string;
  status: ForkStatus;
  /** Tóm tắt kết quả khi fork xong. */
  resultSummary?: string;
  /** Artifact fork tạo ra (đường dẫn tương đối, vd file báo cáo). */
  artifacts: string[];
  /** Token fork đã dùng (khi runner báo). */
  tokensUsed?: number;
  /** Đã merge kết quả về task cha chưa. */
  merged: boolean;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

/** Kết quả merge fork về task cha (để ghi vào resultSummary của task cha). */
export interface ForkMergeResult {
  forkId: string;
  parentTaskId: string;
  /** Đoạn tóm tắt đã merge (ghi thêm vào resultSummary task cha). */
  mergedSummary: string;
  artifacts: string[];
}

// ---------------------------------------------------------------------------
// Chi phí token
// ---------------------------------------------------------------------------

/** Ước tính chi phí token của một team. */
export interface TeamCostEstimate {
  teammates: number;
  tasks: number;
  messages: number;
  forks: number;
  /** Token ước tính theo từng hạng mục. */
  byTeammate: number;
  byTask: number;
  byMessage: number;
  byFork: number;
  /** Tổng token ước tính. */
  estimatedTokens: number;
  /** Ngân sách token cấu hình. */
  budget: number;
  /** Tỉ lệ đã dùng ngân sách (0..n, có thể > 1). */
  usageRatio: number;
  /** Mức cảnh báo: 'ok' | 'warn' (vượt ngưỡng) | 'over' (vượt ngân sách). */
  level: 'ok' | 'warn' | 'over';
  /** Cảnh báo đọc được (rỗng khi ok). */
  warnings: string[];
}

/** Kết quả kiểm tra cỡ team 3–5. */
export interface TeamSizeCheck {
  /** Được phép thêm teammate này không (vượt max mà không có override thì chặn). */
  allowed: boolean;
  /** Cảnh báo đọc được (team quá nhỏ / quá lớn). */
  warnings: string[];
  /** Lỗi chặn (khi vượt max mà không override). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Hook TaskCompleted
// ---------------------------------------------------------------------------

/** Input gửi cho hook TaskCompleted (JSON qua stdin + env). */
export interface TaskCompletedHookInput {
  event: 'TaskCompleted';
  teamId: string;
  teamName: string;
  taskId: string;
  taskTitle: string;
  teammateId: string;
  teammateName: string;
  resultSummary?: string;
}

/** Kết quả chạy hook TaskCompleted. */
export interface TaskCompletedHookResult {
  /** true = chấp nhận task done; false = giữ task mở (exit 2). */
  accepted: boolean;
  /** Exit code của lệnh hook (null khi timeout/killed/spawn lỗi). */
  exitCode: number | null;
  /** Feedback của reviewer khi exit 2 (task quay lại hàng đợi). */
  feedback?: string;
  /** Lỗi hạ tầng của hook (timeout/signal/spawn lỗi) — task vẫn done, lỗi được ghi lại. */
  hookError?: string;
}

// ---------------------------------------------------------------------------
// Lead/worker: giao việc + tổng hợp
// ---------------------------------------------------------------------------

/** Lead giao một task cho đúng một teammate (worker chỉ claim task được giao). */
export interface TaskAssignment {
  taskId: string;
  teammateId: string;
  teammateName: string;
  assignedById: string;
  assignedAt: number;
}

/** Tổng hợp kết quả của lead: gom resultSummary các task done theo teammate. */
export interface TeamAggregateReport {
  teamId: string;
  teamName: string;
  tasksDone: number;
  tasksFailed: number;
  tasksPending: number;
  /** Kết quả theo từng teammate. */
  byTeammate: {
    teammateId: string;
    teammateName: string;
    done: number;
    failed: number;
    summaries: { taskId: string; taskTitle: string; summary?: string }[];
  }[];
  /** Báo cáo text ngắn để lead đọc / gửi tiếp. */
  reportText: string;
}

// ---------------------------------------------------------------------------
// Trạng thái v2 bền vững (teams-v2/<teamId>/v2.json)
// ---------------------------------------------------------------------------

/** Feedback reviewer giữ task mở (hook TaskCompleted exit 2). */
export interface ReviewFeedback {
  taskId: string;
  feedback: string;
  reviewer: string;
  at: number;
}

/** Trạng thái v2 của một team (lưu disk, tách khỏi file team v1). */
export interface TeamV2State {
  version: 2;
  teamId: string;
  config: TeamV2Config;
  /** Task nào được giao cho teammate nào (lead assign). */
  assignments: TaskAssignment[];
  /** Feedback reviewer cho task bị giữ mở (task quay lại hàng đợi). */
  reviewFeedback: ReviewFeedback[];
  /** Fork của team (snapshot nhẹ — chi tiết đầy đủ trong forks/*.json). */
  forks: ForkNode[];
  updatedAt: number;
}

/** Trạng thái v2 mặc định cho một team mới. */
export function defaultTeamV2State(teamId: string, config?: Partial<TeamV2Config>): TeamV2State {
  return {
    version: 2,
    teamId,
    config: { ...defaultTeamV2Config(), ...(config ?? {}) },
    assignments: [],
    reviewFeedback: [],
    forks: [],
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Một lock đang giữ (để dashboard hiển thị). */
export interface DashboardLock {
  taskId: string;
  taskTitle: string;
  ownerName: string;
  leaseUntil: number;
  stale: boolean;
}

/** Snapshot dashboard v2 của một team (để UI Team hiển thị + tool teams_v2_dashboard). */
export interface TeamV2Dashboard {
  teamId: string;
  teamName: string;
  goal: string;
  status: AgentTeamV109['status'];
  leadName: string;
  /** Teammate + trạng thái + session còn mở không. */
  teammates: {
    id: string;
    name: string;
    role: Teammate['role'];
    status: Teammate['status'];
    specialty?: string;
    currentTaskId?: string;
    currentTaskTitle?: string;
    tasksDone: number;
    tasksFailed: number;
    sessionOpen: boolean;
    assignedTaskIds: string[];
  }[];
  tasks: TeamTask[];
  /** Lock đang giữ (task nào, ai giữ, lease tới khi nào, treo không). */
  locks: DashboardLock[];
  /** Số tin chưa đọc theo tên teammate (disk mailbox). */
  mailboxUnreadByName: Record<string, number>;
  /** Tin mailbox mới nhất (disk + v1 gộp, tối đa 20). */
  recentMessages: DiskMailboxMessage[];
  /** Fork của team (cây, trạng thái, đã merge chưa). */
  forks: ForkNode[];
  cost: TeamCostEstimate;
  sizeCheck: TeamSizeCheck;
  /** Feedback reviewer đang giữ task mở. */
  reviewFeedback: ReviewFeedback[];
  /** Log hoạt động mới nhất (event v1, tối đa 50). */
  events: { at: number; type: string; message: string }[];
}

/** Slug hóa tên teammate thành tên thư mục an toàn (mailbox/session trên disk). */
export function slugifyTeammateName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'teammate';
}
