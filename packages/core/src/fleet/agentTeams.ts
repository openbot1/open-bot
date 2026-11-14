/**
 * Agent Teams — nhiều agent peer điều phối, chia workstream song song
 * (v1.07, Đội T6).
 *
 * Ý tưởng học từ Claude Code Agent Teams (research preview, survey
 * v1.07 §2): team tỏa sáng khi task tách được thành workstream ĐỘC
 * LẬP — mỗi agent sở hữu một lát cắt không chặn nhau, có điều phối
 * viên gom kết quả về. Khác fan-out một lần (`subagents/fanout.ts`):
 * team là quan hệ peer LÂU HƠN một task — team tồn tại qua nhiều lần
 * chạy, có điều phối viên, có lát cắt sở hữu ổn định, có lịch sử
 * chạy và báo cáo gộp.
 *
 * Luật bất biến của module này:
 * - Lát cắt KHÔNG CHỒNG nhau: hai workstream không được sở hữu cùng
 *   một slice (tiền tố đường dẫn hoặc key slice trùng nhau) — chồng
 *   nhau là lỗi validate, vì hai agent sẽ giẫm chân nhau và merge
 *   về sau thành xung đột.
 * - Workstream có phụ thuộc thì chạy THEO SÓNG topo: sóng sau chỉ
 *   chạy khi sóng trước xong; workstream phụ thuộc vào workstream
 *   thất bại thì bị SKIP (không chạy mù), ghi rõ lý do.
 * - Một member lỗi không kéo sập team: kết quả ghi failed, team vẫn
 *   gộp phần còn lại; điều phối viên tóm tắt cả phần lỗi trong báo
 *   cáo cuối.
 * - Module thuần + runner tiêm vào (cùng mẫu `FanOutTaskInput`):
 *   runner thật do caller cung cấp (agent thật / CLI / subagent);
 *   test dùng runner giả. Không spawn process, không gọi model ở đây.
 *
 * Persistence: file `<fleetRoot>/agent-teams-v107.json` (atomic write,
 * cùng mẫu registry của fleet) — team sống qua restart.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const AGENT_TEAMS_FILE = 'agent-teams-v107.json';

/** Vai trò của một member trong team. */
export type AgentTeamMemberRole =
  | 'coordinator'
  | 'researcher'
  | 'implementer'
  | 'reviewer'
  | 'specialist';

/** Trạng thái của một workstream / member. */
export type AgentTeamWorkstreamStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

/** Trạng thái tổng của team. */
export type AgentTeamStatus = 'active' | 'paused' | 'completed' | 'archived';

/** Một member peer trong team. */
export interface AgentTeamMember {
  /** Id ổn định, `tm-<uuid>` (ngắn khi tạo từ input: `tm-<slug>`). */
  id: string;
  /** Tên hiển thị (duy nhất trong team). */
  name: string;
  role: AgentTeamMemberRole;
  /** Model member này chạy (vd 'claude-sonnet-4-5'); vắng = model mặc định của team. */
  model?: string;
  /** Workstream member sở hữu (id workstream); vắng = chưa giao việc. */
  workstreamId?: string;
  status: AgentTeamWorkstreamStatus;
}

/** Một lát cắt công việc mà một member sở hữu. */
export interface AgentTeamWorkstream {
  /** Id ổn định, `ws-<slug>` do caller đặt (duy nhất trong team). */
  id: string;
  /** Tiêu đề ngắn (vd 'Research memory v8'). */
  title: string;
  /** Mô tả việc cần làm (không chứa secret). */
  brief: string;
  /** Member sở hữu lát cắt này (id member). */
  ownerId: string;
  /**
   * Slice sở hữu: tiền tố đường dẫn (vd 'packages/core/src/memory/')
   * hoặc key slice trừu tượng (vd 'docs:memory'). Hai workstream
   * chồng slice → validate lỗi. Rỗng = không khai slice (chỉ dùng
   * khi team làm việc phi-file, vd research thuần).
   */
  owns: string[];
  /** Id workstream phải xong trước khi workstream này chạy. */
  dependsOn: string[];
  status: AgentTeamWorkstreamStatus;
  /** Ghi chú kết quả lần chạy gần nhất (tóm tắt, không phải full log). */
  lastSummary?: string;
}

/** Một sự kiện trong đời team (append-only, để UI/audit xem lại). */
export interface AgentTeamEvent {
  at: number;
  type: 'created' | 'workstream-started' | 'workstream-done' | 'workstream-failed' | 'workstream-skipped' | 'run-finished' | 'paused' | 'resumed' | 'archived';
  workstreamId?: string;
  memberId?: string;
  message: string;
}

/** Một Agent Team đầy đủ. */
export interface AgentTeam {
  /** Id ổn định, `team-<uuid>`. */
  id: string;
  /** Tên team (duy nhất trong file team). */
  name: string;
  /** Mục tiêu chung của team. */
  goal: string;
  /** Member điều phối (id member có role coordinator). */
  coordinatorId: string;
  members: AgentTeamMember[];
  workstreams: AgentTeamWorkstream[];
  status: AgentTeamStatus;
  createdAt: number;
  updatedAt: number;
  events: AgentTeamEvent[];
}

export interface CreateTeamMemberInput {
  name: string;
  role: AgentTeamMemberRole;
  model?: string;
}

export interface CreateTeamWorkstreamInput {
  id: string;
  title: string;
  brief: string;
  /** Tên member sở hữu (khớp `members[].name`). */
  ownerName: string;
  owns?: string[];
  dependsOn?: string[];
}

export interface CreateAgentTeamInput {
  name: string;
  goal: string;
  /** Tên member điều phối (phải có trong members với role coordinator). */
  coordinatorName: string;
  members: CreateTeamMemberInput[];
  workstreams: CreateTeamWorkstreamInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slugOf(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'item';
}

/** Chuẩn hoá một slice sở hữu: bỏ `/` đầu/cuối, viết thường đường dẫn. */
export function normalizeOwnedSlice(slice: string): string {
  return slice.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Hai slice có chồng nhau không: bằng nhau, hoặc một cái là tiền tố
 * đường dẫn của cái kia (`a/b` chồng `a/b/c`), hoặc cùng key slice
 * trừu tượng. So sánh không phân biệt hoa thường ở phần đường dẫn.
 */
export function ownedSlicesOverlap(a: string, b: string): boolean {
  const na = normalizeOwnedSlice(a).toLowerCase();
  const nb = normalizeOwnedSlice(b).toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

/** Tìm mọi cặp workstream chồng slice — trả danh sách mô tả chồng nhau. */
export function findOverlappingWorkstreams(
  workstreams: AgentTeamWorkstream[],
): Array<{ a: string; b: string; sliceA: string; sliceB: string }> {
  const overlaps: Array<{ a: string; b: string; sliceA: string; sliceB: string }> = [];
  for (let i = 0; i < workstreams.length; i += 1) {
    for (let j = i + 1; j < workstreams.length; j += 1) {
      const wa = workstreams[i] as AgentTeamWorkstream;
      const wb = workstreams[j] as AgentTeamWorkstream;
      for (const sa of wa.owns) {
        for (const sb of wb.owns) {
          if (ownedSlicesOverlap(sa, sb)) {
            overlaps.push({ a: wa.id, b: wb.id, sliceA: sa, sliceB: sb });
          }
        }
      }
    }
  }
  return overlaps;
}

/** Validate một member đã parse; sai shape → throw. */
export function validateTeamMember(raw: unknown): AgentTeamMember {
  if (!isRecord(raw)) throw new Error('team member phải là object.');
  const { id, name, role, model, workstreamId, status } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('team member cần id không rỗng.');
  if (typeof name !== 'string' || name.trim().length === 0) throw new Error('team member cần name không rỗng.');
  const roles: AgentTeamMemberRole[] = ['coordinator', 'researcher', 'implementer', 'reviewer', 'specialist'];
  if (typeof role !== 'string' || !(roles as string[]).includes(role)) {
    throw new Error(`team member cần role hợp lệ (${roles.join(', ')}).`);
  }
  if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
    throw new Error('team member model (nếu có) phải là chuỗi không rỗng.');
  }
  if (workstreamId !== undefined && typeof workstreamId !== 'string') {
    throw new Error('team member workstreamId (nếu có) phải là chuỗi.');
  }
  const statuses: AgentTeamWorkstreamStatus[] = ['pending', 'running', 'done', 'failed', 'skipped'];
  if (typeof status !== 'string' || !(statuses as string[]).includes(status)) {
    throw new Error('team member cần status hợp lệ.');
  }
  return {
    id: (id as string).trim(),
    name: (name as string).trim(),
    role: role as AgentTeamMemberRole,
    ...(model !== undefined ? { model: (model as string).trim() } : {}),
    ...(workstreamId !== undefined ? { workstreamId: workstreamId as string } : {}),
    status: status as AgentTeamWorkstreamStatus,
  };
}

/** Validate một workstream đã parse; sai shape → throw. */
export function validateTeamWorkstream(raw: unknown): AgentTeamWorkstream {
  if (!isRecord(raw)) throw new Error('team workstream phải là object.');
  const { id, title, brief, ownerId, owns, dependsOn, status, lastSummary } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('team workstream cần id không rỗng.');
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('team workstream cần title không rỗng.');
  if (typeof brief !== 'string' || brief.trim().length === 0) throw new Error('team workstream cần brief không rỗng.');
  if (typeof ownerId !== 'string' || ownerId.trim().length === 0) throw new Error('team workstream cần ownerId không rỗng.');
  if (!Array.isArray(owns) || owns.some((o) => typeof o !== 'string' || o.trim().length === 0)) {
    throw new Error('team workstream owns phải là mảng chuỗi không rỗng.');
  }
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string' || d.trim().length === 0)) {
    throw new Error('team workstream dependsOn phải là mảng chuỗi không rỗng.');
  }
  const statuses: AgentTeamWorkstreamStatus[] = ['pending', 'running', 'done', 'failed', 'skipped'];
  if (typeof status !== 'string' || !(statuses as string[]).includes(status)) {
    throw new Error('team workstream cần status hợp lệ.');
  }
  if (lastSummary !== undefined && typeof lastSummary !== 'string') {
    throw new Error('team workstream lastSummary (nếu có) phải là chuỗi.');
  }
  return {
    id: (id as string).trim(),
    title: (title as string).trim(),
    brief: (brief as string).trim(),
    ownerId: (ownerId as string).trim(),
    owns: (owns as string[]).map((o) => o.trim()),
    dependsOn: (dependsOn as string[]).map((d) => d.trim()),
    status: status as AgentTeamWorkstreamStatus,
    ...(lastSummary !== undefined ? { lastSummary: lastSummary as string } : {}),
  };
}

/**
 * Validate toàn bộ team đã parse: id/name/goal, coordinator phải là
 * member role coordinator, member trùng tên/id → lỗi, workstream
 * trùng id / owner không tồn tại / dependsOn không tồn tại hoặc tự
 * phụ thuộc / slice chồng nhau → lỗi. Không echo nội dung file.
 */
export function validateAgentTeam(raw: unknown): AgentTeam {
  if (!isRecord(raw)) throw new Error('agent team phải là object.');
  const { id, name, goal, coordinatorId, members, workstreams, status, createdAt, updatedAt, events } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('agent team cần id không rỗng.');
  if (typeof name !== 'string' || name.trim().length === 0) throw new Error('agent team cần name không rỗng.');
  if (typeof goal !== 'string' || goal.trim().length === 0) throw new Error('agent team cần goal không rỗng.');
  if (typeof coordinatorId !== 'string' || coordinatorId.trim().length === 0) {
    throw new Error('agent team cần coordinatorId không rỗng.');
  }
  if (!Array.isArray(members) || members.length === 0) throw new Error('agent team cần ít nhất 1 member.');
  if (!Array.isArray(workstreams)) throw new Error('agent team workstreams phải là mảng.');
  const teamStatuses: AgentTeamStatus[] = ['active', 'paused', 'completed', 'archived'];
  if (typeof status !== 'string' || !(teamStatuses as string[]).includes(status)) {
    throw new Error('agent team cần status hợp lệ.');
  }
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    throw new Error('agent team cần createdAt là epoch ms > 0.');
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    throw new Error('agent team cần updatedAt là epoch ms > 0.');
  }
  if (!Array.isArray(events)) throw new Error('agent team events phải là mảng.');
  const validMembers = members.map(validateTeamMember);
  const validStreams = workstreams.map(validateTeamWorkstream);
  const memberIds = new Set<string>();
  const memberNames = new Set<string>();
  for (const m of validMembers) {
    if (memberIds.has(m.id)) throw new Error(`team trùng member id "${m.id}".`);
    memberIds.add(m.id);
    const lower = m.name.toLowerCase();
    if (memberNames.has(lower)) throw new Error(`team trùng tên member "${m.name}".`);
    memberNames.add(lower);
  }
  const coordinator = validMembers.find((m) => m.id === coordinatorId);
  if (!coordinator) throw new Error(`team coordinator "${coordinatorId}" không phải member.`);
  if (coordinator.role !== 'coordinator') {
    throw new Error(`team coordinator "${coordinator.name}" phải có role coordinator.`);
  }
  const streamIds = new Set<string>();
  for (const w of validStreams) {
    if (streamIds.has(w.id)) throw new Error(`team trùng workstream id "${w.id}".`);
    streamIds.add(w.id);
    if (!memberIds.has(w.ownerId)) throw new Error(`workstream "${w.id}" có owner không tồn tại.`);
    if (w.dependsOn.includes(w.id)) throw new Error(`workstream "${w.id}" tự phụ thuộc chính nó.`);
    for (const dep of w.dependsOn) {
      if (!streamIds.has(dep) && !validStreams.some((s) => s.id === dep)) {
        throw new Error(`workstream "${w.id}" phụ thuộc "${dep}" không tồn tại.`);
      }
    }
  }
  const overlaps = findOverlappingWorkstreams(validStreams);
  if (overlaps.length > 0) {
    const first = overlaps[0] as { a: string; b: string; sliceA: string; sliceB: string };
    throw new Error(
      `workstream "${first.a}" và "${first.b}" chồng slice sở hữu ("${first.sliceA}" vs "${first.sliceB}") — tách lát cắt trước khi chạy team.`,
    );
  }
  const validEvents: AgentTeamEvent[] = events.map((e) => {
    if (!isRecord(e) || typeof e.at !== 'number' || typeof e.type !== 'string' || typeof e.message !== 'string') {
      throw new Error('team event sai shape.');
    }
    return {
      at: e.at as number,
      type: e.type as AgentTeamEvent['type'],
      ...(typeof e.workstreamId === 'string' ? { workstreamId: e.workstreamId as string } : {}),
      ...(typeof e.memberId === 'string' ? { memberId: e.memberId as string } : {}),
      message: e.message as string,
    };
  });
  return {
    id: (id as string).trim(),
    name: (name as string).trim(),
    goal: (goal as string).trim(),
    coordinatorId: (coordinatorId as string).trim(),
    members: validMembers,
    workstreams: validStreams,
    status: status as AgentTeamStatus,
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
    events: validEvents,
  };
}

/**
 * Tạo team mới (pure — không ghi file). Điều phối viên phải có trong
 * members với role coordinator; owner workstream khớp theo tên member;
 * slice chồng nhau → throw trước khi team tồn tại.
 */
export function createAgentTeam(input: CreateAgentTeamInput, now = Date.now()): AgentTeam {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error('createAgentTeam cần name không rỗng.');
  }
  if (typeof input.goal !== 'string' || input.goal.trim().length === 0) {
    throw new Error('createAgentTeam cần goal không rỗng.');
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new Error('createAgentTeam cần ít nhất 1 member.');
  }
  if (!Array.isArray(input.workstreams)) {
    throw new Error('createAgentTeam cần workstreams là mảng.');
  }
  const members: AgentTeamMember[] = input.members.map((m) => {
    if (typeof m.name !== 'string' || m.name.trim().length === 0) {
      throw new Error('team member cần name không rỗng.');
    }
    const roles: AgentTeamMemberRole[] = ['coordinator', 'researcher', 'implementer', 'reviewer', 'specialist'];
    if (!roles.includes(m.role)) throw new Error(`team member "${m.name}" cần role hợp lệ.`);
    return {
      id: `tm-${slugOf(m.name)}-${randomUUID().slice(0, 8)}`,
      name: m.name.trim(),
      role: m.role,
      ...(m.model ? { model: m.model.trim() } : {}),
      status: 'pending' as AgentTeamWorkstreamStatus,
    };
  });
  const byName = new Map(members.map((m) => [m.name.toLowerCase(), m]));
  const coordinator = byName.get(input.coordinatorName.trim().toLowerCase());
  if (!coordinator) throw new Error(`coordinator "${input.coordinatorName}" không có trong members.`);
  if (coordinator.role !== 'coordinator') {
    throw new Error(`coordinator "${input.coordinatorName}" phải có role coordinator.`);
  }
  const workstreams: AgentTeamWorkstream[] = input.workstreams.map((w) => {
    if (typeof w.id !== 'string' || w.id.trim().length === 0) throw new Error('workstream cần id không rỗng.');
    if (typeof w.title !== 'string' || w.title.trim().length === 0) throw new Error('workstream cần title không rỗng.');
    if (typeof w.brief !== 'string' || w.brief.trim().length === 0) throw new Error('workstream cần brief không rỗng.');
    const owner = byName.get(w.ownerName.trim().toLowerCase());
    if (!owner) throw new Error(`workstream "${w.id}" có owner "${w.ownerName}" không có trong members.`);
    return {
      id: w.id.trim(),
      title: w.title.trim(),
      brief: w.brief.trim(),
      ownerId: owner.id,
      owns: (w.owns ?? []).map((o) => o.trim()).filter(Boolean),
      dependsOn: (w.dependsOn ?? []).map((d) => d.trim()).filter(Boolean),
      status: 'pending' as AgentTeamWorkstreamStatus,
    };
  });
  // Gắn workstream cho member sở hữu (member chỉ sở hữu tối đa 1
  // workstream trong một lần tạo — sở hữu 2 lát cắt cùng lúc thì
  // member đó thành nút thắt; tách ra thành 2 member hoặc chạy nối tiếp).
  for (const w of workstreams) {
    const owner = members.find((m) => m.id === w.ownerId) as AgentTeamMember;
    if (owner.workstreamId) {
      throw new Error(`member "${owner.name}" đã sở hữu workstream "${owner.workstreamId}" — một member chỉ sở hữu một lát cắt mỗi lần chạy.`);
    }
    owner.workstreamId = w.id;
  }
  const team: AgentTeam = {
    id: `team-${randomUUID()}`,
    name: input.name.trim(),
    goal: input.goal.trim(),
    coordinatorId: coordinator.id,
    members,
    workstreams,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    events: [{ at: now, type: 'created', message: `Team "${input.name.trim()}" tạo với ${members.length} member, ${workstreams.length} workstream.` }],
  };
  // Validate cuối (bắt chồng slice + dependsOn lạ) trước khi trả về.
  return validateAgentTeam(team);
}

/** Đường dẫn file team của một fleet root. */
export function getAgentTeamsPath(fleetRoot: string): string {
  if (typeof fleetRoot !== 'string' || fleetRoot.trim().length === 0) {
    throw new Error('getAgentTeamsPath cần fleetRoot không rỗng.');
  }
  return path.join(fleetRoot, AGENT_TEAMS_FILE);
}

/** Đọc danh sách team. File chưa có → []. JSON hỏng / shape sai → throw. */
export function loadAgentTeams(fleetRoot: string): AgentTeam[] {
  const filePath = getAgentTeamsPath(fleetRoot);
  if (!fs.existsSync(filePath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Không đọc được ${AGENT_TEAMS_FILE}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${AGENT_TEAMS_FILE} hỏng (không phải JSON hợp lệ): ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${AGENT_TEAMS_FILE} phải là mảng JSON.`);
  return parsed.map(validateAgentTeam);
}

/** Ghi danh sách team (atomic: file tạm + đổi tên). */
export function saveAgentTeams(fleetRoot: string, teams: AgentTeam[]): void {
  const valid = teams.map(validateAgentTeam);
  const filePath = getAgentTeamsPath(fleetRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Tìm team theo id, hoặc undefined khi không có. */
export function findAgentTeam(teams: AgentTeam[], id: string): AgentTeam | undefined {
  return teams.find((t) => t.id === id);
}

/** Tìm team theo tên (không phân biệt hoa thường), hoặc undefined. */
export function findAgentTeamByName(teams: AgentTeam[], name: string): AgentTeam | undefined {
  return teams.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
}

/** Tóm tắt nhanh một team để UI/list hiển thị. */
export function summarizeAgentTeam(team: AgentTeam): {
  id: string;
  name: string;
  status: AgentTeamStatus;
  members: number;
  workstreams: number;
  done: number;
  failed: number;
  skipped: number;
  pending: number;
} {
  const count = (s: AgentTeamWorkstreamStatus): number =>
    team.workstreams.filter((w) => w.status === s).length;
  return {
    id: team.id,
    name: team.name,
    status: team.status,
    members: team.members.length,
    workstreams: team.workstreams.length,
    done: count('done'),
    failed: count('failed'),
    skipped: count('skipped'),
    pending: count('pending') + count('running'),
  };
}

// ---------------------------------------------------------------------------
// Chạy team: chia sóng topo + chạy song song + gom kết quả về điều phối viên.
// ---------------------------------------------------------------------------

/** Kết quả một workstream do runner trả về. */
export interface TeamWorkstreamResult {
  workstreamId: string;
  memberId: string;
  status: 'done' | 'failed';
  /** Tóm tắt nén (vài trăm ký tự) — điều phối viên chỉ nhận phần này. */
  summary: string;
  /** Artifact tạo ra (đường dẫn file / branch / link — không chứa nội dung). */
  artifacts: string[];
  /** Số tool call member đã dùng (để điều phối viên biết độ tốn kém). */
  toolCallCount: number;
  durationMs: number;
  error?: string;
}

/** Runner chạy một workstream — caller tiêm agent thật / CLI / mock. */
export type TeamMemberRunner = (
  member: AgentTeamMember,
  workstream: AgentTeamWorkstream,
  ctx: { team: AgentTeam; attempt: number },
) => Promise<TeamWorkstreamResult>;

export interface RunAgentTeamOptions {
  /** Số workstream chạy cùng lúc tối đa trong một sóng (mặc định 4). */
  concurrency?: number;
  /** Callback theo dõi tiến độ (mỗi workstream xong / skip / sóng mới). */
  onEvent?: (event: AgentTeamEvent) => void;
  /** Thời điểm bắt đầu (epoch ms) — test tiêm giờ cố định. */
  now?: () => number;
}

/** Báo cáo gộp của điều phối viên sau một lần chạy team. */
export interface AgentTeamRunReport {
  teamId: string;
  teamName: string;
  coordinatorName: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** Số sóng topo đã chạy. */
  waves: number;
  done: number;
  failed: number;
  skipped: number;
  totalToolCalls: number;
  results: TeamWorkstreamResult[];
  /** Bản tóm tắt markdown do điều phối viên gom — user đọc phần này. */
  summary: string;
}

/**
 * Xếp workstream thành sóng topo theo dependsOn: sóng 0 = không phụ
 * thuộc ai; sóng N = phụ thuộc đã nằm ở sóng < N. Chu trình phụ thuộc
 * → throw (validate đã chặn tự phụ thuộc, nhưng chu trình 2+ node
 * vẫn có thể lọt qua input tay).
 */
export function planTeamWaves(workstreams: AgentTeamWorkstream[]): AgentTeamWorkstream[][] {
  const byId = new Map(workstreams.map((w) => [w.id, w]));
  const done = new Set<string>();
  const remaining = [...workstreams];
  const waves: AgentTeamWorkstream[][] = [];
  while (remaining.length > 0) {
    const wave = remaining.filter((w) => w.dependsOn.every((d) => done.has(d)));
    if (wave.length === 0) {
      const cycle = remaining.map((w) => w.id).join(', ');
      throw new Error(`team có chu trình phụ thuộc giữa các workstream: ${cycle}.`);
    }
    for (const w of wave) {
      done.add(w.id);
      const idx = remaining.indexOf(w);
      remaining.splice(idx, 1);
    }
    // Ổn định: sóng xếp theo id để log/UI đọc được.
    wave.sort((a, b) => a.id.localeCompare(b.id));
    waves.push(wave);
  }
  void byId;
  return waves;
}

/** Gộp kết quả các workstream thành bản tóm tắt markdown của điều phối viên. */
export function mergeTeamResults(
  team: AgentTeam,
  results: TeamWorkstreamResult[],
  opts: { startedAt: number; finishedAt: number; waves: number },
): AgentTeamRunReport {
  const byId = new Map(team.workstreams.map((w) => [w.id, w]));
  const coordinator = team.members.find((m) => m.id === team.coordinatorId);
  const done = results.filter((r) => r.status === 'done').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = team.workstreams.filter((w) => w.status === 'skipped').length;
  const totalToolCalls = results.reduce((sum, r) => sum + Math.max(0, r.toolCallCount), 0);
  const lines: string[] = [
    `# Team "${team.name}" — báo cáo điều phối viên`,
    ``,
    `Mục tiêu: ${team.goal}`,
    `Điều phối: ${coordinator?.name ?? team.coordinatorId} · ${opts.waves} sóng · ${done} xong, ${failed} lỗi, ${skipped} bỏ qua · ${totalToolCalls} tool call · ${opts.finishedAt - opts.startedAt}ms.`,
    ``,
  ];
  for (const r of results) {
    const w = byId.get(r.workstreamId);
    const member = team.members.find((m) => m.id === r.memberId);
    lines.push(`## ${w?.title ?? r.workstreamId} — ${r.status === 'done' ? 'xong' : 'LỖI'} (${member?.name ?? r.memberId}, ${r.durationMs}ms, ${r.toolCallCount} tool call)`);
    lines.push(r.summary.trim() || '(không có tóm tắt)');
    if (r.artifacts.length > 0) lines.push(`Artifact: ${r.artifacts.join(', ')}`);
    if (r.error) lines.push(`Lỗi: ${r.error}`);
    lines.push(``);
  }
  const skippedStreams = team.workstreams.filter((w) => w.status === 'skipped');
  for (const w of skippedStreams) {
    const member = team.members.find((m) => m.id === w.ownerId);
    lines.push(`## ${w.title} — BỎ QUA (${member?.name ?? w.ownerId})`);
    lines.push(w.lastSummary ?? 'Workstream phụ thuộc vào workstream thất bại nên không chạy.');
    lines.push(``);
  }
  return {
    teamId: team.id,
    teamName: team.name,
    coordinatorName: coordinator?.name ?? team.coordinatorId,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
    durationMs: opts.finishedAt - opts.startedAt,
    waves: opts.waves,
    done,
    failed,
    skipped,
    totalToolCalls,
    results,
    summary: lines.join('\n').trim(),
  };
}

/** Chạy các hàm với giới hạn đồng thời, giữ đúng thứ tự kết quả. */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= items.length) return;
          results[index] = await fn(items[index] as T, index);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/**
 * Chạy một team: xếp sóng topo, mỗi sóng chạy song song (giới hạn
 * concurrency), sóng sau chỉ chạy khi sóng trước xong. Workstream
 * phụ thuộc vào workstream thất bại → skip có ghi lý do. Trả về team
 * đã cập nhật trạng thái + báo cáo gộp của điều phối viên. Team
 * paused/archived → throw; team không có workstream → báo cáo rỗng.
 */
export async function runAgentTeam(
  team: AgentTeam,
  runner: TeamMemberRunner,
  opts: RunAgentTeamOptions = {},
): Promise<{ team: AgentTeam; report: AgentTeamRunReport }> {
  if (team.status === 'paused' || team.status === 'archived') {
    throw new Error(`team "${team.name}" đang ${team.status} — resume trước khi chạy.`);
  }
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const emit = opts.onEvent ?? ((): void => undefined);
  const concurrency = opts.concurrency ?? 4;
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error(`runAgentTeam cần concurrency > 0 (nhận ${String(opts.concurrency)}).`);
  }
  const next: AgentTeam = JSON.parse(JSON.stringify(team)) as AgentTeam;
  const events: AgentTeamEvent[] = [];
  const pushEvent = (e: AgentTeamEvent): void => {
    events.push(e);
    next.events.push(e);
    emit(e);
  };
  const results: TeamWorkstreamResult[] = [];
  const failedIds = new Set<string>();
  const waves = planTeamWaves(next.workstreams);
  let wavesRun = 0;
  for (const wave of waves) {
    wavesRun += 1;
    // Workstream nào phụ thuộc vào workstream đã fail → skip ngay,
    // không chạy mù (ghi rõ lý do để điều phối viên thấy).
    const runnable: AgentTeamWorkstream[] = [];
    for (const w of wave) {
      const badDep = w.dependsOn.find((d) => failedIds.has(d));
      if (badDep) {
        w.status = 'skipped';
        w.lastSummary = `Bỏ qua vì workstream phụ thuộc "${badDep}" đã thất bại.`;
        const member = next.members.find((m) => m.id === w.ownerId);
        if (member) member.status = 'skipped';
        pushEvent({
          at: now(),
          type: 'workstream-skipped',
          workstreamId: w.id,
          memberId: w.ownerId,
          message: `Workstream "${w.title}" bỏ qua vì phụ thuộc "${badDep}" thất bại.`,
        });
      } else {
        runnable.push(w);
      }
    }
    if (runnable.length === 0) continue;
    const waveResults = await runWithConcurrency(runnable, concurrency, async (w) => {
      const member = next.members.find((m) => m.id === w.ownerId) as AgentTeamMember;
      w.status = 'running';
      member.status = 'running';
      pushEvent({
        at: now(),
        type: 'workstream-started',
        workstreamId: w.id,
        memberId: w.ownerId,
        message: `Workstream "${w.title}" bắt đầu (owner ${member.name}).`,
      });
      const t0 = now();
      try {
        const result = await runner(member, w, { team: next, attempt: 1 });
        const duration = Math.max(0, now() - t0);
        const normalized: TeamWorkstreamResult = {
          workstreamId: w.id,
          memberId: w.ownerId,
          status: result.status === 'done' ? 'done' : 'failed',
          summary: typeof result.summary === 'string' ? result.summary : '',
          artifacts: Array.isArray(result.artifacts) ? result.artifacts.filter((a) => typeof a === 'string') : [],
          toolCallCount: Math.max(0, Math.floor(result.toolCallCount) || 0),
          durationMs: duration,
          ...(result.error ? { error: result.error } : {}),
        };
        w.status = normalized.status;
        w.lastSummary = normalized.summary.slice(0, 500);
        member.status = normalized.status;
        if (normalized.status === 'failed') failedIds.add(w.id);
        pushEvent({
          at: now(),
          type: normalized.status === 'done' ? 'workstream-done' : 'workstream-failed',
          workstreamId: w.id,
          memberId: w.ownerId,
          message:
            normalized.status === 'done'
              ? `Workstream "${w.title}" xong (${normalized.toolCallCount} tool call).`
              : `Workstream "${w.title}" lỗi: ${normalized.error ?? 'không rõ lý do'}.`,
        });
        return normalized;
      } catch (err) {
        const duration = Math.max(0, now() - t0);
        const message = (err as Error).message;
        w.status = 'failed';
        w.lastSummary = `Lỗi runner: ${message}`.slice(0, 500);
        member.status = 'failed';
        failedIds.add(w.id);
        pushEvent({
          at: now(),
          type: 'workstream-failed',
          workstreamId: w.id,
          memberId: w.ownerId,
          message: `Workstream "${w.title}" lỗi runner: ${message}.`,
        });
        return {
          workstreamId: w.id,
          memberId: w.ownerId,
          status: 'failed' as const,
          summary: '',
          artifacts: [],
          toolCallCount: 0,
          durationMs: duration,
          error: message,
        };
      }
    });
    results.push(...waveResults);
  }
  const finishedAt = now();
  const allDone = next.workstreams.every((w) => w.status === 'done');
  const anyDone = next.workstreams.some((w) => w.status === 'done');
  next.status = next.workstreams.length === 0 || allDone ? 'completed' : anyDone ? 'active' : 'active';
  next.updatedAt = finishedAt;
  pushEvent({
    at: finishedAt,
    type: 'run-finished',
    message: `Team "${next.name}" chạy xong: ${results.filter((r) => r.status === 'done').length} xong, ${results.filter((r) => r.status === 'failed').length} lỗi, ${next.workstreams.filter((w) => w.status === 'skipped').length} bỏ qua.`,
  });
  const report = mergeTeamResults(next, results, { startedAt, finishedAt, waves: wavesRun });
  return { team: next, report };
}
