/**
 * Agent Teams v3 — types (v1.11, Đội T3).
 *
 * V3 xây trên v2 (packages/core/src/teams/v2, Đội T3 v1.10): giữ
 * nguyên TeamServiceV2 (claim lock disk, mailbox disk, session,
 * fork, hook TaskCompleted, chi phí token), thêm đúng 7 primitives
 * của Claude Code Agent Teams (survey v1.11 §3 — chỉ học ý tưởng,
 * toàn bộ code viết mới cho open-bot):
 *
 *   1. team-create — TeamCreate: tạo team (kèm ước tính chi phí
 *      tuyến tính TRƯỚC khi tạo, để UI cảnh báo).
 *   2. task-spawn — Task: lead spawn teammate cho một task.
 *   3. send-message — SendMessage: teammate nhắn trực tiếp cho
 *      teammate khác, không qua lead.
 *   4. task-lifecycle — vòng đời task 3 trạng thái: open →
 *      in-progress → closed (closed kèm outcome done/failed).
 *   5. file-lock — file locking chống double-claim (kế thừa lock
 *      disk v2 + file guard v3: 2 teammate không sửa cùng file).
 *   6. dependency-wave — waves theo dependency chain: wave sau
 *      chỉ chạy khi wave trước đã closed hết.
 *   7. lead-control — lead control layer: lead có 2 mode
 *      (delegate = chỉ giao việc, implement = lead cũng trực tiếp
 *      làm), chuyển mode được giữa chừng, xem trạng thái từng
 *      teammate. Lưu ý luật v1 (không đổi): lead KHÔNG claim task
 *      trực tiếp được (TeamService v1 chặn, test v1 assert) — nên
 *      implement mode cho lead làm việc qua một worker seat
 *      (teammate "lead · worker", specialty lead-implementer) do
 *      lead điều khiển; delegate mode thì seat này không claim được.
 *
 * Luật bất biến của module này:
 * - 1 session chỉ có 1 team; teammate không tạo team con (team con
 *   là lỗi, không tự tạo ngầm).
 * - Task lifecycle chỉ đi một chiều open → in-progress → closed;
 *   reopen chỉ qua hook TaskCompleted exit 2 của v2 (task về open).
 * - Wave sau bị khóa claim cho tới khi wave trước closed hết.
 * - 2 teammate không sửa cùng file: claim chạm file đang bị giữ
 *   thì chặn, trừ khi lead override có kiểm soát (ghi log).
 * - Lead ở delegate mode không được claim/start task; ở implement
 *   mode lead claim như teammate thường.
 * - Challenge (thách thức kết luận của nhau) luôn ghi lại vào log
 *   hội thoại team; chỉ lead mới resolve challenge.
 * - Không chứa secret: log/pane/challenge chỉ lưu tên, id, tóm
 *   tắt — không lưu API key hay nội dung nhạy cảm.
 */

import type { AgentTeamV109, TeamTask, Teammate } from '../types';
import type { TeamCostEstimate, TeamV2Config } from '../v2/types';

/** Đúng 7 primitives của Agent Teams v3 (theo thứ tự survey). */
export const TEAM_V3_PRIMITIVES = [
  'team-create',
  'task-spawn',
  'send-message',
  'task-lifecycle',
  'file-lock',
  'dependency-wave',
  'lead-control',
] as const;

/** Một primitive trong 7 primitives v3. */
export type TeamV3Primitive = (typeof TEAM_V3_PRIMITIVES)[number];

/** Mô tả đọc được của từng primitive (để UI/tool liệt kê). */
export const TEAM_V3_PRIMITIVE_DESCRIPTIONS: Record<TeamV3Primitive, string> = {
  'team-create': 'TeamCreate: tạo team, kèm ước tính chi phí tuyến tính trước khi tạo.',
  'task-spawn': 'Task: lead spawn teammate cho một task.',
  'send-message': 'SendMessage: teammate nhắn trực tiếp cho teammate khác, không qua lead.',
  'task-lifecycle': 'Task lifecycle 3 trạng thái: open → in-progress → closed.',
  'file-lock': 'File locking: lock disk chống double-claim, 2 teammate không sửa cùng file.',
  'dependency-wave': 'Dependency waves: wave sau chỉ chạy khi wave trước closed hết.',
  'lead-control': 'Lead control: delegate mode vs implement mode, chuyển mode giữa chừng.',
};

/** Vòng đời task v3: đúng 3 trạng thái. */
export type V3TaskState = 'open' | 'in-progress' | 'closed';

/** Kết quả khi task closed. */
export type V3TaskOutcome = 'done' | 'failed';

/** Mode của lead: delegate (chỉ giao việc) vs implement (cũng trực tiếp làm). */
export type LeadMode = 'delegate' | 'implement';

/** Trạng thái của một wave. */
export type TeamWaveStatus = 'pending' | 'active' | 'done';

/** Trạng thái của một challenge. */
export type TeamChallengeStatus = 'open' | 'answered' | 'resolved';

/** Loại mục trong log hội thoại team (append-only). */
export type TeamConversationKind =
  | 'message'
  | 'challenge'
  | 'challenge-answer'
  | 'challenge-resolved'
  | 'mode-switch'
  | 'wave-advance'
  | 'wave-blocked'
  | 'file-override'
  | 'lifecycle'
  | 'team-created'
  | 'teammate-spawned';

/** Số teammate khuyến nghị khi bắt đầu team v3 (3–5, như v2). */
export const V3_RECOMMENDED_MIN_TEAMMATES = 3;
export const V3_RECOMMENDED_MAX_TEAMMATES = 5;

/** Số dòng log tối đa giữ trong một pane teammate (cũ nhất bị cắt). */
export const MAX_PANE_LOG_LINES = 200;

/** Số mục tối đa giữ trong log hội thoại team (cũ nhất bị cắt). */
export const MAX_TEAM_CONVERSATION_ENTRIES = 500;

/** Số challenge tối đa giữ trong một team. */
export const MAX_TEAM_CHALLENGES = 200;

/** Tên thư mục v3 trong thư mục dữ liệu của app. */
export const TEAMS_V3_DIR = 'teams-v3';
/** Tên file trạng thái v3 của một team (trong teams-v3/<teamId>/). */
export const TEAM_V3_STATE_FILE = 'v3.json';
/** Tên file registry session → team (trong teams-v3/). */
export const TEAM_V3_SESSIONS_FILE = 'sessions.json';

/** Token cơ sở của một session team (lead + khung team, chưa tính teammate). */
export const V3_BASE_SESSION_TOKENS = 4000;
/** Token ước tính cho mỗi teammate thêm vào (chi phí tuyến tính). */
export const V3_TOKENS_PER_TEAMMATE = 8000;
/** Token ước tính cho mỗi task trong team. */
export const V3_TOKENS_PER_TASK = 4000;
/** Token ước tính cho mỗi tin nhắn mailbox. */
export const V3_TOKENS_PER_MESSAGE = 300;

/** Một wave trong dependency chain: nhóm task cùng tầng topo. */
export interface TeamWave {
  /** Số thứ tự wave (0 = wave đầu, không dependency). */
  index: number;
  /** Id các task thuộc wave này. */
  taskIds: string[];
  status: TeamWaveStatus;
  /** Số task đã done trong wave (wave chỉ xong khi mọi task đều done — luật v1). */
  closedCount: number;
  /** Wave có được phép claim task không (wave trước đã done hết). */
  claimable: boolean;
  /** Lý do wave chưa claimable (khi claimable = false). */
  blockedBy?: string;
}

/** Một challenge: teammate thách thức/góp ý kết luận của teammate khác. */
export interface TeamChallenge {
  /** Id ổn định, `challenge-<uuid ngắn>`. */
  id: string;
  teamId: string;
  /** Task bị thách thức (kết luận của task này). */
  taskId: string;
  taskTitle: string;
  /** Người thách thức. */
  challengerId: string;
  challengerName: string;
  /** Người bị thách thức (chủ task/kết luận). */
  targetId: string;
  targetName: string;
  /** Kết luận đang bị thách thức (snapshot resultSummary lúc challenge). */
  conclusion: string;
  /** Nội dung thách thức/góp ý. */
  body: string;
  status: TeamChallengeStatus;
  /** Câu trả lời của người bị thách thức (khi answered/resolved). */
  answer?: string;
  answeredBy?: string;
  answeredAt?: number;
  /** Lead resolve kèm nhận xét (khi resolved). */
  resolution?: string;
  resolvedBy?: string;
  resolvedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Một mục trong log hội thoại team (append-only, để UI/audit xem lại). */
export interface TeamConversationEntry {
  at: number;
  kind: TeamConversationKind;
  /** Tên người ghi mục (lead/teammate/hệ thống). */
  fromName: string;
  /** Id teammate ghi mục (trống = hệ thống). */
  fromId?: string;
  /** Task liên quan (nếu có). */
  taskId?: string;
  /** Nội dung (text ngắn; không chứa secret). */
  body: string;
}

/** Một dòng log trong pane của teammate. */
export interface PaneLogLine {
  at: number;
  line: string;
}

/** Một pane teammate kiểu tmux: mỗi teammate một pane, xem log/output trực tiếp. */
export interface TeammatePane {
  /** Id teammate của pane. */
  teammateId: string;
  name: string;
  role: Teammate['role'];
  status: Teammate['status'];
  /** Task đang làm (tiêu đề, để pane hiển thị). */
  currentTaskTitle?: string;
  /** Vị trí pane trong lưới tmux (hàng/cột, 0-based). */
  row: number;
  col: number;
  /** Log/output của teammate trong pane (mới nhất cuối, tối đa 200 dòng). */
  logLines: PaneLogLine[];
  /** Pane đang được focus trong agent view không. */
  focused: boolean;
  updatedAt: number;
}

/** Một background session trong agent-view dashboard. */
export interface TeamBackgroundSession {
  sessionId: string;
  teamId: string;
  teamName: string;
  leadName: string;
  status: AgentTeamV109['status'];
  leadMode: LeadMode;
  teammateCount: number;
  workingCount: number;
  currentWave: number;
  totalWaves: number;
  tasksDone: number;
  tasksTotal: number;
  createdAt: number;
  updatedAt: number;
}

/** Tóm tắt trạng thái từng teammate cho lead xem (lead status board). */
export interface LeadTeammateBoardEntry {
  id: string;
  name: string;
  role: Teammate['role'];
  status: Teammate['status'];
  specialty?: string;
  currentTaskId?: string;
  currentTaskTitle?: string;
  /** Wave của task đang làm (nếu có). */
  currentWave?: number;
  tasksDone: number;
  tasksFailed: number;
  /** Số tin chưa đọc của teammate này (mailbox v1 + disk v2). */
  unreadMessages: number;
  /** Số challenge đang mở liên quan teammate này. */
  openChallenges: number;
  /** Pane của teammate (hàng/cột trong lưới tmux). */
  paneRow: number;
  paneCol: number;
}

/** Ước tính chi phí tuyến tính v3 (hiển thị TRƯỚC khi tạo team). */
export interface TeamV3CostEstimate extends TeamCostEstimate {
  /** Token cơ sở của session team (lead + khung). */
  baseTokens: number;
  /** Hệ số nhân so với session đơn (1 + số teammate). */
  multiplier: number;
  /** Chi phí từng teammate (bảng tuyến tính để UI hiển thị). */
  perTeammateBreakdown: { teammates: number; estimatedTokens: number }[];
}

/** Cấu hình v3 của một team (lưu riêng trong teams-v3/<teamId>/v3.json). */
export interface TeamV3Config {
  /** Mode khởi đầu của lead (mặc định 'delegate'). */
  leadMode: LeadMode;
  /** Có cho teammate thách thức kết luận của nhau không (mặc định true). */
  allowChallenges: boolean;
  /** Có cho lead override file guard không (mặc định true — override vẫn ghi log). */
  allowFileOverride: boolean;
  /** Số cột lưới pane tmux (mặc định 2; 0 = tự tính từ số teammate). */
  paneColumns: number;
  /** Kế thừa cấu hình v2 (lease, ngân sách token, giới hạn team...). */
  v2: Partial<TeamV2Config>;
}

/** Cấu hình v3 mặc định. */
export function defaultTeamV3Config(): TeamV3Config {
  return {
    leadMode: 'delegate',
    allowChallenges: true,
    allowFileOverride: true,
    paneColumns: 2,
    v2: {},
  };
}

/** Validate cấu hình v3, trả về lỗi (rỗng = hợp lệ). */
export function validateTeamV3Config(config: Partial<TeamV3Config>): string[] {
  const errors: string[] = [];
  if (config.leadMode !== undefined && config.leadMode !== 'delegate' && config.leadMode !== 'implement') {
    errors.push('leadMode phải là "delegate" hoặc "implement".');
  }
  if (config.paneColumns !== undefined) {
    if (!Number.isInteger(config.paneColumns) || config.paneColumns < 0 || config.paneColumns > 4) {
      errors.push('paneColumns phải là số nguyên 0..4 (0 = tự tính).');
    }
  }
  return errors;
}

/** Trạng thái v3 của một team (lưu disk, tách khỏi file team v1 + v2). */
export interface TeamV3State {
  version: 3;
  teamId: string;
  config: TeamV3Config;
  /** Mode hiện tại của lead (đổi được giữa chừng). */
  leadMode: LeadMode;
  /** Lịch sử chuyển mode của lead (để audit). */
  leadModeHistory: { mode: LeadMode; at: number; byName: string }[];
  /** Challenge trong team. */
  challenges: TeamChallenge[];
  /** Log hội thoại team (message/challenge/mode/wave/override/lifecycle). */
  conversation: TeamConversationEntry[];
  /** Pane tmux của từng teammate (log/output trực tiếp). */
  panes: TeammatePane[];
  /** Id worker seat của lead (teammate "lead · worker" — lead làm việc qua seat này ở implement mode). */
  leadWorkerId?: string;
  /** Session sở hữu team này (1 team/session — xem session registry). */
  sessionId?: string;
  updatedAt: number;
}

/** Trạng thái v3 mặc định cho một team mới. */
export function defaultTeamV3State(teamId: string, config?: Partial<TeamV3Config>): TeamV3State {
  const cfg = { ...defaultTeamV3Config(), ...(config ?? {}) };
  return {
    version: 3,
    teamId,
    config: cfg,
    leadMode: cfg.leadMode,
    leadModeHistory: [],
    challenges: [],
    conversation: [],
    panes: [],
    updatedAt: Date.now(),
  };
}

/** Một mục registry session → team (1 team/session). */
export interface TeamSessionEntry {
  sessionId: string;
  teamId: string;
  teamName: string;
  createdAt: number;
}

/** Kết quả một thao tác v3. */
export type TeamV3Result<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

/** Ánh xạ trạng thái task v1 (6 trạng thái) sang vòng đời v3 (3 trạng thái). */
export function v3StateOf(task: TeamTask): V3TaskState {
  if (task.status === 'done' || task.status === 'failed') return 'closed';
  if (task.status === 'in-progress') return 'in-progress';
  return 'open';
}

/** Kết quả (outcome) của task đã closed: done hay failed. */
export function v3OutcomeOf(task: TeamTask): V3TaskOutcome | undefined {
  if (task.status === 'done') return 'done';
  if (task.status === 'failed') return 'failed';
  return undefined;
}

/** Chuyển trạng thái v3 có hợp lệ không (chỉ đi một chiều). */
export function isValidV3Transition(from: V3TaskState, to: V3TaskState): boolean {
  if (from === to) return false;
  if (from === 'open' && to === 'in-progress') return true;
  if (from === 'in-progress' && to === 'closed') return true;
  return false;
}

/** Tên đọc được của trạng thái v3 (để UI/tool hiển thị). */
export function v3StateLabel(state: V3TaskState): string {
  if (state === 'open') return 'open';
  if (state === 'in-progress') return 'in-progress';
  return 'closed';
}

/** Tên đọc được của mode lead. */
export function leadModeLabel(mode: LeadMode): string {
  return mode === 'delegate' ? 'delegate (chỉ giao việc)' : 'implement (lead cũng trực tiếp làm)';
}

/** Tính vị trí pane trong lưới tmux cho teammate thứ `index`. */
export function panePosition(index: number, columns: number): { row: number; col: number } {
  const cols = columns > 0 ? columns : 2;
  return { row: Math.floor(index / cols), col: index % cols };
}

/** Số cột lưới pane tự tính từ số teammate (tối đa 3 cột). */
export function autoPaneColumns(teammateCount: number): number {
  if (teammateCount <= 2) return 1;
  if (teammateCount <= 4) return 2;
  return 3;
}
