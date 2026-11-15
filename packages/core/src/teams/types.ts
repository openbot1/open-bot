/**
 * Agent Teams v1 — shared types (v1.09, Đội T1).
 *
 * Một team = một lead bot điều phối nhiều teammate bot chạy song song
 * trong cùng một phiên làm việc. Khác với Agent Teams của fleet v1.07
 * (peer lâu dài, workstream có lát cắt sở hữu ổn định): team ở đây
 * là phiên làm việc có thời hạn — lead chia task, teammate claim task
 * từ danh sách chia sẻ, nhắn nhau qua mailbox, làm việc trong vùng
 * file riêng; team tan khi mục tiêu xong hoặc lead giải tán.
 *
 * Ý tưởng học từ Claude Code Agent Teams (research preview, survey
 * v1.07 §2 — lead điều phối teammate song song, task list chia sẻ,
 * nhắn tin trực tiếp giữa teammate): chỉ học ý tưởng, toàn bộ code
 * viết mới cho open-bot, không copy code/text/tài sản của repo nào.
 *
 * Luật bất biến của module này:
 * - Một task chỉ có tối đa một owner tại một thời điểm: claim là
 *   nguyên tử trong process (kiểm tra + gán trong cùng một lần gọi,
 *   không có await ở giữa), kèm file-lock trên các file task chạm
 *   tới — hai teammate không bao giờ cùng sửa một file.
 * - Task có dependency chỉ chạy khi mọi dependency đã done (topo);
 *   dependency tạo chu trình là lỗi validate, không được tạo team.
 * - Mailbox là kênh duy nhất để teammate giao tiếp: tin nhắn có
 *   loại rõ ràng (request/result/question/broadcast), question gửi
 *   cho lead khi teammate bí, broadcast chỉ lead mới được gửi.
 * - Giới hạn song song có cấu hình: mặc định tối đa 8 teammate;
 *   vượt giới hạn là lỗi, không tự ý cắt bớt.
 * - Module thuần + runner tiêm vào: không spawn process, không gọi
 *   model ở đây — runner thật do caller cung cấp.
 */

import { randomUUID } from 'node:crypto';

/** Trạng thái của một team. */
export type AgentTeamV109Status = 'active' | 'paused' | 'completed' | 'dissolved';

/** Trạng thái của một teammate. */
export type TeammateStatus =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'failed';

/** Vai trò trong team: một lead duy nhất + teammate. */
export type TeammateRole = 'lead' | 'teammate';

/** Trạng thái của một task trong danh sách chia sẻ. */
export type TeamTaskStatus =
  | 'pending'
  | 'claimed'
  | 'in-progress'
  | 'done'
  | 'failed'
  | 'blocked';

/** Loại tin nhắn trong mailbox. */
export type MailboxMessageKind = 'request' | 'result' | 'question' | 'broadcast';

/** Độ ưu tiên của task (1 thấp nhất, 5 cao nhất). */
export type TeamTaskPriority = 1 | 2 | 3 | 4 | 5;

/** Cách phân vùng file cho teammate: thư mục riêng hoặc worktree riêng. */
export type FilePartitionMode = 'directory' | 'worktree';

/** Số teammate tối đa mặc định trong một team. */
export const DEFAULT_MAX_TEAMMATES = 8;

/** Số teammate tối đa tuyệt đối (trần an toàn, tránh fork-bomb bot). */
export const ABSOLUTE_MAX_TEAMMATES = 32;

/** Số task tối đa trong một team (trần chống danh sách phình vô hạn). */
export const MAX_TASKS_PER_TEAM = 500;

/** Số tin nhắn tối đa giữ trong mailbox của một bot (cũ nhất bị cắt). */
export const MAX_MAILBOX_MESSAGES_PER_BOT = 500;

/** Số sự kiện tối đa giữ trong nhật ký team. */
export const MAX_TEAM_EVENTS = 1000;

/** Tên file lưu team (trong thư mục dữ liệu của app). */
export const AGENT_TEAMS_V109_FILE = 'agent-teams-v109.json';

/** Một teammate bot trong team. */
export interface Teammate {
  /** Id ổn định, `mate-<uuid ngắn>`. */
  id: string;
  /** Tên hiển thị (duy nhất trong team). */
  name: string;
  role: TeammateRole;
  /** Model teammate này chạy (trống = model mặc định của team). */
  model?: string;
  /** Role chuyên biệt của subagent (researcher/coder/reviewer/...). */
  specialty?: string;
  status: TeammateStatus;
  /** Task đang làm (id task); trống = đang rảnh. */
  currentTaskId?: string;
  /** Vùng file teammate sở hữu (tiền tố đường dẫn, vd 'src/memory/'). */
  partition?: string;
  /** Worktree riêng (khi partition mode = worktree). */
  worktreePath?: string;
  /** Số task đã hoàn thành trong team này. */
  tasksDone: number;
  /** Số task thất bại trong team này. */
  tasksFailed: number;
  createdAt: number;
  updatedAt: number;
}

/** Một task trong danh sách chia sẻ của team. */
export interface TeamTask {
  /** Id ổn định, `task-<uuid ngắn>`. */
  id: string;
  /** Tiêu đề ngắn. */
  title: string;
  /** Mô tả việc cần làm (không chứa secret). */
  detail?: string;
  status: TeamTaskStatus;
  /** Id task phải done trước khi task này được claim. */
  dependsOn: string[];
  priority: TeamTaskPriority;
  /** Id teammate đang giữ task (claim); trống = chưa ai giữ. */
  claimedBy?: string;
  /** Thời điểm claim (ms epoch); dùng để phát hiện claim treo. */
  claimedAt?: number;
  /** File task này sẽ chạm tới (đường dẫn tương đối) — dùng cho file-lock. */
  touchesFiles: string[];
  /** Số lần thử (claim lại sau fail tăng attempts). */
  attempts: number;
  /** Số lần thử tối đa (mặc định 3). */
  maxAttempts: number;
  /** Kết quả text ngắn khi done (tóm tắt, không phải full log). */
  resultSummary?: string;
  /** Lỗi ngắn khi failed. */
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** Một tin nhắn trong mailbox. */
export interface MailboxMessage {
  /** Id ổn định, `msg-<uuid ngắn>`. */
  id: string;
  /** Id team chứa tin nhắn. */
  teamId: string;
  /** Người gửi: id teammate, hoặc 'lead' khi gửi với tư cách lead. */
  fromId: string;
  /** Tên hiển thị người gửi (snapshot lúc gửi, để đọc log sau khi đổi tên). */
  fromName: string;
  /** Người nhận: id teammate, hoặc '*' = broadcast toàn team. */
  toId: string;
  kind: MailboxMessageKind;
  /** Task liên quan (nếu có). */
  taskId?: string;
  /** Nội dung (text ngắn; không chứa secret). */
  body: string;
  /** Đã đọc chưa (chỉ có nghĩa với tin trực tiếp, không áp cho broadcast). */
  read: boolean;
  createdAt: number;
}

/** Một sự kiện trong đời team (append-only, để UI/audit xem lại). */
export interface TeamV109Event {
  at: number;
  type:
    | 'created'
    | 'teammate-added'
    | 'teammate-removed'
    | 'task-added'
    | 'task-claimed'
    | 'task-started'
    | 'task-done'
    | 'task-failed'
    | 'task-released'
    | 'message-sent'
    | 'conflict-detected'
    | 'paused'
    | 'resumed'
    | 'completed'
    | 'dissolved';
  teammateId?: string;
  taskId?: string;
  message: string;
}

/** Cấu hình giới hạn + chính sách của một team. */
export interface TeamV109Config {
  /** Số teammate tối đa (mặc định 8, tối đa 32). */
  maxTeammates: number;
  /** Số task chạy song song tối đa (mặc định = maxTeammates). */
  maxParallelTasks: number;
  /** Cách phân vùng file (mặc định 'directory'). */
  partitionMode: FilePartitionMode;
  /** Timeout claim: claim quá hạn này mà task chưa in-progress thì coi như treo (ms, mặc định 10 phút). */
  claimTimeoutMs: number;
  /** Timeout một task (ms, mặc định 30 phút); runner dùng để hủy task treo. */
  taskTimeoutMs: number;
  /** Có cho teammate hỏi lead khi bí không (mặc định true). */
  allowQuestionsToLead: boolean;
}

/** Một Agent Team v1 đầy đủ (lead + teammate + task list + mailbox). */
export interface AgentTeamV109 {
  /** Id ổn định, `team-<uuid>`. */
  id: string;
  /** Tên team (duy nhất trong file lưu). */
  name: string;
  /** Mục tiêu chung của team. */
  goal: string;
  /** Id của lead (member có role 'lead'). */
  leadId: string;
  /** Model mặc định của team (teammate không đặt model riêng thì dùng). */
  defaultModel?: string;
  teammates: Teammate[];
  tasks: TeamTask[];
  /** Mailbox: toàn bộ tin nhắn của team (lọc theo toId khi đọc). */
  messages: MailboxMessage[];
  config: TeamV109Config;
  status: AgentTeamV109Status;
  /** Lý do team kết thúc / giải tán (khi status completed/dissolved). */
  endReason?: string;
  events: TeamV109Event[];
  createdAt: number;
  updatedAt: number;
}

/** Input tạo team mới. */
export interface CreateTeamV109Input {
  name: string;
  goal: string;
  /** Tên lead (mặc định 'lead'). */
  leadName?: string;
  /** Model mặc định của team. */
  defaultModel?: string;
  config?: Partial<TeamV109Config>;
}

/** Input thêm teammate. */
export interface AddTeammateInput {
  name: string;
  model?: string;
  specialty?: string;
  /** Vùng file teammate sở hữu (tiền tố đường dẫn). */
  partition?: string;
}

/** Input thêm task vào danh sách chia sẻ. */
export interface AddTeamTaskInput {
  title: string;
  detail?: string;
  dependsOn?: string[];
  priority?: TeamTaskPriority;
  touchesFiles?: string[];
  maxAttempts?: number;
}

/** Input gửi tin nhắn mailbox. */
export interface SendTeamMessageInput {
  fromId: string;
  /** Id teammate nhận, hoặc '*' = broadcast toàn team (chỉ lead). */
  toId: string;
  kind: MailboxMessageKind;
  taskId?: string;
  body: string;
}

/** Một xung đột file: hai teammate chạm cùng file. */
export interface FileConflict {
  /** File bị chạm bởi nhiều teammate. */
  file: string;
  /** Id các task đang giữ file này. */
  taskIds: string[];
  /** Id các teammate đang giữ file này. */
  teammateIds: string[];
  /** Mức độ: 'overlap' = partition chồng nhau, 'touch' = cùng chạm một file. */
  kind: 'overlap' | 'touch';
  detectedAt: number;
}

/** Kết quả đánh giá có nên dùng team hay single-bot. */
export interface TeamEscalationAssessment {
  /** Gợi ý: dùng team hay chỉ một bot là đủ. */
  recommendation: 'single-bot' | 'team';
  /** Điểm phức tạp 0..100 (càng cao càng nên dùng team). */
  complexityScore: number;
  /** Lý do cụ thể cho gợi ý (để lead/UI hiển thị). */
  reasons: string[];
  /** Số teammate gợi ý khi dùng team (2..8). */
  suggestedTeammates: number;
}

/** Tín hiệu đầu vào cho đánh giá leo cấp team/single-bot. */
export interface TeamEscalationSignals {
  /** Số subtask độc lập ước tính. */
  subtaskCount: number;
  /** Số vùng file khác nhau mà công việc chạm tới. */
  fileAreaCount: number;
  /** Công việc có cần nhiều chuyên môn khác nhau không (research + code + review...). */
  needsMultipleSpecialties: boolean;
  /** Ước tính độ dài công việc theo bước (số step agent). */
  estimatedSteps: number;
  /** Có deadline gấp mà song song giúp kịp không. */
  timeSensitive: boolean;
}

/** Tóm tắt trạng thái team (để UI/tool đọc nhanh). */
export interface TeamV109Summary {
  id: string;
  name: string;
  goal: string;
  status: AgentTeamV109Status;
  leadName: string;
  teammateCount: number;
  idleTeammates: number;
  workingTeammates: number;
  tasksTotal: number;
  tasksPending: number;
  tasksClaimed: number;
  tasksInProgress: number;
  tasksDone: number;
  tasksFailed: number;
  tasksBlocked: number;
  tasksReady: number;
  unreadMessages: number;
  createdAt: number;
  updatedAt: number;
}

/** Tạo id ngắn có tiền tố (`team-<uuid>`, `mate-<8 ký tự>`...). */
export function newTeamId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Chuẩn hóa tên (trim + gộp khoảng trắng) — tên rỗng sau chuẩn hóa là lỗi. */
export function normalizeTeamName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Slug ngắn từ tên (dùng cho id đọc được khi tạo từ input). */
export function slugOf(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'item';
}

/** Chuẩn hóa tiền tố đường dẫn partition: bỏ './', bảo đảm có '/' cuối khi không rỗng. */
export function normalizePartitionPrefix(prefix: string): string {
  let p = prefix.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  if (p && !p.endsWith('/')) p += '/';
  return p;
}

/** Hai tiền tố partition có chồng nhau không (một cái là tiền tố của cái kia). */
export function partitionsOverlap(a: string, b: string): boolean {
  const na = normalizePartitionPrefix(a);
  const nb = normalizePartitionPrefix(b);
  if (!na || !nb) return false;
  return na.startsWith(nb) || nb.startsWith(na);
}

/** File có nằm trong partition không. */
export function fileInPartition(file: string, partition: string): boolean {
  const p = normalizePartitionPrefix(partition);
  if (!p) return true;
  const f = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return f.startsWith(p);
}

/** Cấu hình mặc định của team. */
export function defaultTeamV109Config(): TeamV109Config {
  return {
    maxTeammates: DEFAULT_MAX_TEAMMATES,
    maxParallelTasks: DEFAULT_MAX_TEAMMATES,
    partitionMode: 'directory',
    claimTimeoutMs: 10 * 60_000,
    taskTimeoutMs: 30 * 60_000,
    allowQuestionsToLead: true,
  };
}

/** Validate cấu hình team, trả về lỗi (rỗng = hợp lệ). */
export function validateTeamV109Config(config: Partial<TeamV109Config>): string[] {
  const errors: string[] = [];
  if (config.maxTeammates !== undefined) {
    if (!Number.isInteger(config.maxTeammates) || config.maxTeammates < 1) {
      errors.push('maxTeammates phải là số nguyên >= 1.');
    } else if (config.maxTeammates > ABSOLUTE_MAX_TEAMMATES) {
      errors.push(`maxTeammates tối đa ${ABSOLUTE_MAX_TEAMMATES}.`);
    }
  }
  if (config.maxParallelTasks !== undefined) {
    if (!Number.isInteger(config.maxParallelTasks) || config.maxParallelTasks < 1) {
      errors.push('maxParallelTasks phải là số nguyên >= 1.');
    }
  }
  if (config.claimTimeoutMs !== undefined && (!Number.isFinite(config.claimTimeoutMs) || config.claimTimeoutMs <= 0)) {
    errors.push('claimTimeoutMs phải là số > 0.');
  }
  if (config.taskTimeoutMs !== undefined && (!Number.isFinite(config.taskTimeoutMs) || config.taskTimeoutMs <= 0)) {
    errors.push('taskTimeoutMs phải là số > 0.');
  }
  return errors;
}
