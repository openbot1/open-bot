/**
 * Tools v13 — định nghĩa tool riêng của platform/fleet v13
 * (v1.16, Đội T6).
 *
 * Registry riêng của đội T6 (không sửa registry trung tâm của các
 * đội khác): mỗi tool là một định nghĩa thuần (tên, mô tả, params,
 * cần quyền gì, có ghi hay không) để agent loop / UI gọi qua các
 * hàm core ở `fleetV13/` — module này KHÔNG tự đăng ký vào registry
 * trung tâm, KHÔNG chạy tool. Coordinator gộp sẽ quyết định có
 * merge các def này vào registry trung tâm hay không; số đếm tool
 * được pin trong test của đội (`tests/fleet-v116-tools.test.mjs`).
 *
 * Quy ước tên: `fleetV13.*` cho fleet, `teamV13.*` cho multi-user,
 * `rolloutV13.*` cho rollout, `composioV13.*` cho polling/app.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật — xem
 * permission broker (survey v116 mục 1).
 */

/** Định nghĩa một tool v13 (thuần, JSON-able). */
export interface FleetV13ToolDef {
  /** Tên tool, vd `fleetV13.pinModel`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `multiUserV13.ts` TEAM_V13_ACTIONS). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v13 (định nghĩa thuần). */
export const FLEET_V13_TOOLS: readonly FleetV13ToolDef[] = [
  {
    name: 'teamV13.listMembers',
    description: 'Liệt kê member của team (tên, role, trạng thái) — không kèm secret.',
    write: false,
    requiresAction: 'view-members',
    params: [],
  },
  {
    name: 'teamV13.inviteMember',
    description: 'Mời member mới vào team (email + role thấp hơn role của người mời).',
    write: true,
    requiresAction: 'invite-member',
    params: ['email', 'role'],
  },
  {
    name: 'teamV13.deactivateMember',
    description: 'Vô hiệu hóa một member (mất quyền xem vault/bot ngay).',
    write: true,
    requiresAction: 'deactivate-member',
    params: ['userId'],
  },
  {
    name: 'teamV13.reactivateMember',
    description: 'Kích hoạt lại member đã deactivate.',
    write: true,
    requiresAction: 'reactivate-member',
    params: ['userId'],
  },
  {
    name: 'teamV13.changeRole',
    description: 'Đổi role của member (chỉ owner).',
    write: true,
    requiresAction: 'change-role',
    params: ['userId', 'role'],
  },
  {
    name: 'teamV13.listVaultKeys',
    description: 'Liệt kê key vault mà user được thấy (chỉ key của mình; admin/owner xem thêm metadata).',
    write: false,
    requiresAction: 'manage-own-vault',
    params: [],
  },
  {
    name: 'teamV13.verifyAuditLog',
    description: 'Verify chuỗi hash của audit log team (phát hiện sửa/xóa).',
    write: false,
    requiresAction: 'view-audit',
    params: [],
  },
  {
    name: 'rolloutV13.createRollout',
    description: 'Tạo rollout tính năng mới theo nhóm % user (bắt đầu ở stage draft).',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['id', 'feature', 'version', 'previousVersion'],
  },
  {
    name: 'rolloutV13.advanceStage',
    description: 'Mở rộng rollout sang stage kế tiếp (chỉ khi health gate đạt).',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV13.checkGate',
    description: 'Kiểm tra health gate trước khi mở rộng stage (trả từng điều kiện).',
    write: false,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'rolloutV13.rollback',
    description: 'Rollback một nút: đưa rollout về rolled-back, khôi phục version trước.',
    write: true,
    requiresAction: 'manage-rollout',
    params: ['rolloutId', 'reason'],
  },
  {
    name: 'rolloutV13.cohort',
    description: 'Liệt kê user trong cohort của stage hiện tại (deterministic theo hash).',
    write: false,
    requiresAction: 'manage-rollout',
    params: ['rolloutId'],
  },
  {
    name: 'composioV13.listTriggers',
    description: 'Liệt kê trigger polling Composio v3 (trạng thái, lần poll cuối, lỗi liên tiếp).',
    write: false,
    requiresAction: 'manage-own-bots',
    params: [],
  },
  {
    name: 'composioV13.resumeTrigger',
    description: 'Bật lại trigger polling đã pause (reset lỗi, poll ngay).',
    write: true,
    requiresAction: 'manage-own-bots',
    params: ['triggerId'],
  },
  {
    name: 'composioV13.appHealth',
    description: 'Xem sức khỏe + quota của app Composio v13 (docusign/freshbooks/gong/lever/quickbooks/resend).',
    write: false,
    requiresAction: 'manage-own-bots',
    params: ['slug'],
  },
  {
    name: 'fleetV13.pinModel',
    description: 'Pin model lên node sau khi kiểm tra vừa RAM/VRAM (từ chối khi thiếu tài nguyên).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'modelId', 'ramMb', 'vramMb'],
  },
  {
    name: 'fleetV13.unpinModel',
    description: 'Gỡ pin model khỏi node.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'modelId'],
  },
  {
    name: 'fleetV13.checkNodeHealth',
    description: 'Health check một node (heartbeat, CPU/RAM/VRAM, đĩa) kèm từng điều kiện.',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['nodeId'],
  },
  {
    name: 'fleetV13.capacityReport',
    description: 'Báo cáo capacity toàn fleet (RAM/VRAM đã pin, node quá tải).',
    write: false,
    requiresAction: 'manage-fleet',
    params: [],
  },
  {
    name: 'fleetV13.rebalance',
    description: 'Gợi ý rebalance: chuyển model từ node quá tải sang node còn trống.',
    write: false,
    requiresAction: 'manage-fleet',
    params: [],
  },
  {
    name: 'fleetV13.eventLog',
    description: 'Lọc fleet event log (pin/unpin/health/rebalance/rollout) theo node/khoảng thời gian.',
    write: false,
    requiresAction: 'manage-fleet',
    params: ['kind', 'nodeId'],
  },
];

/** Tổng số tool v13 (pin trong test của đội). */
export const FLEET_V13_TOOL_COUNT = FLEET_V13_TOOLS.length;

/** Số tool ghi v13 (cần duyệt + audit). */
export const FLEET_V13_WRITE_TOOL_COUNT = FLEET_V13_TOOLS.filter((t) => t.write).length;

/** Tìm tool theo tên (null khi không có). */
export function findFleetV13Tool(name: string): FleetV13ToolDef | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  return FLEET_V13_TOOLS.find((t) => t.name === name.trim()) ?? null;
}

/** Validate định nghĩa tool v13 (tên trùng, thiếu mô tả/param...). */
export function validateFleetV13Tools(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const toolDef of FLEET_V13_TOOLS) {
    if (seen.has(toolDef.name)) errors.push(`tool trùng tên: ${toolDef.name}`);
    seen.add(toolDef.name);
    if (!toolDef.description.trim()) errors.push(`tool ${toolDef.name} thiếu description`);
    if (!toolDef.requiresAction.trim()) errors.push(`tool ${toolDef.name} thiếu requiresAction`);
    if (!/^(teamV13|rolloutV13|composioV13|fleetV13)\./.test(toolDef.name)) {
      errors.push(`tool ${toolDef.name} không có prefix v13 hợp lệ`);
    }
  }
  return errors;
}
