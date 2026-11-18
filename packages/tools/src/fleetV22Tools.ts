/**
 * Fleet v22 tools (v1.35, Đội T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Tool chạy thật cho fleet v22 (định nghĩa thuần nằm ở
 * `packages/core/src/fleetV22/toolsV22.ts` — 24 tool, 4 nhóm; file này
 * là bản chạy được, nối vào core qua `@open-bot/core`):
 *
 * - `fleet_v22_create_user` / `fleet_v22_list_users` /
 *   `fleet_v22_set_user_role` / `fleet_v22_set_user_active` /
 *   `fleet_v22_user_quota` — đa người dùng + quota.
 * - `fleet_v22_create_computer` / `fleet_v22_list_computers` /
 *   `fleet_v22_computer_status` — per-bot computer (3 loại) + vòng đời.
 * - `fleet_v22_probe_host` / `fleet_v22_allocatable` /
 *   `fleet_v22_partition` — probe thật + phân vùng sau headroom.
 * - `delegate_v22_create` / `delegate_v22_finish` / `delegate_v22_verify` /
 *   `delegate_v22_cancel` / `delegate_v22_list` — subagent delegation
 *   (parent kiểm soát, xác minh trước khi xong).
 * - `handoff_v22_register_agent` / `handoff_v22_transfer` /
 *   `handoff_v22_approve` / `handoff_v22_chain` — handoff chuyển giao
 *   toàn bộ hội thoại (`transfer_to_*`).
 * - `orchestrate_v22_route` / `orchestrate_v22_escalation` /
 *   `orchestrate_v22_audit` + `fleet_v22_dashboard` — router,
 *   escalation, audit trail, dashboard.
 *
 * Như fleet v21, đây là placeholder trong ALL_TOOLS cho tới khi host
 * bind: `createFleetV22Tools(getState)` với state của host (registries
 * + routing rules + audit log + usage + probe). Unbound, tool trả về
 * thông báo "not configured" rõ ràng thay vì đoán state. Tool ghi cần
 * duyệt (`needsApproval: true`); tool KHÔNG tự chạy model hay spawn
 * VM — nó chỉ ghi state, host/provisioner thực thi.
 */

import type { Tool } from '@open-bot/core';
import {
  FleetV22ComputerRegistry,
  FleetV22DelegationRegistry,
  FleetV22HandoffAgentRegistry,
  FleetV22HandoffChain,
  FleetV22OrchestrationAuditLog,
  FleetV22UserRegistry,
  allocatableFromProbeV22,
  approveFleetV22Handoff,
  buildFleetV22ComputerPanel,
  buildFleetV22Dashboard,
  buildFleetV22UserPanel,
  checkFleetV22Escalation,
  computerFromGrantedShareV22,
  computerTransitionAllowedV22,
  createFleetV22Delegation,
  createFleetV22Handoff,
  createFleetV22RoutingRule,
  createFleetV22User,
  delegationFinishV22,
  delegationVerifyV22,
  handoffToolNameV22,
  partitionResourcesV22,
  probeHostResourcesV22,
  quotaFitsV22,
  quotaShortfallV22,
  routeFleetV22Task,
  transitionFleetV22Computer,
  transitionFleetV22Delegation,
  validateFleetV22HandoffAgent,
} from '@open-bot/core';
import type {
  FleetV22BotComputer,
  FleetV22ComputerKind,
  FleetV22ComputerStatus,
  FleetV22Delegation,
  FleetV22Handoff,
  FleetV22HandoffAgent,
  FleetV22HostProbe,
  FleetV22RoutingRule,
  FleetV22Usage,
  FleetV22User,
  FleetV22UserRole,
} from '@open-bot/core';

/** State fleet v22 host cung cấp cho tools (đọc lười mỗi lần tool chạy). */
export interface FleetV22ToolState {
  /** Registry user (host giữ 1 instance). */
  users: FleetV22UserRegistry;
  /** Registry per-bot computer. */
  computers: FleetV22ComputerRegistry;
  /** Registry delegation. */
  delegations: FleetV22DelegationRegistry;
  /** Registry agent nhận handoff. */
  handoffAgents: FleetV22HandoffAgentRegistry;
  /** Chuỗi handoff theo conversationId (host giữ Map, tool tự tạo chain mới khi chưa có). */
  chains: Map<string, FleetV22HandoffChain>;
  /** Mọi handoff đã xảy ra (host giữ mảng — để dashboard/audit đọc). */
  handoffs: FleetV22Handoff[];
  /** Rule routing của orchestrator. */
  routingRules: FleetV22RoutingRule[];
  /** Audit trail orchestration. */
  audit: FleetV22OrchestrationAuditLog;
  /** Usage (tài nguyên đã cấp) theo userId — host tính từ bot/computer/run. */
  usageByUserId: Record<string, FleetV22Usage>;
  /** Probe host mới nhất (null = chưa probe). */
  probe: FleetV22HostProbe | null;
}

export const FLEET_V22_TOOL_NAMES = [
  'fleet_v22_create_user',
  'fleet_v22_list_users',
  'fleet_v22_set_user_role',
  'fleet_v22_set_user_active',
  'fleet_v22_user_quota',
  'fleet_v22_create_computer',
  'fleet_v22_list_computers',
  'fleet_v22_computer_status',
  'fleet_v22_probe_host',
  'fleet_v22_allocatable',
  'fleet_v22_partition',
  'delegate_v22_create',
  'delegate_v22_finish',
  'delegate_v22_verify',
  'delegate_v22_cancel',
  'delegate_v22_list',
  'handoff_v22_register_agent',
  'handoff_v22_transfer',
  'handoff_v22_approve',
  'handoff_v22_chain',
  'orchestrate_v22_route',
  'orchestrate_v22_escalation',
  'orchestrate_v22_audit',
  'fleet_v22_dashboard',
] as const;

const NOT_WIRED =
  'Fleet v22 is not configured: the host has not wired fleet state (user/computer/delegation registries, handoff agents, routing rules, audit log) into the v22 tools.';

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 20000);
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Argument "${name}" must be a number >= 0.`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

export function createFleetV22Tools(
  getState?: () => FleetV22ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV22ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  const audit = (state: FleetV22ToolState, kind: 'route' | 'delegate' | 'handoff' | 'escalate' | 'verify' | 'cancel', conversationId: string, runId: string, ownerId: string, summary: string, detail: Record<string, string>): void => {
    try {
      state.audit.record({ kind, conversationId, runId, ownerId, summary, detail });
    } catch {
      // Audit không bao giờ làm hỏng tool chính.
    }
  };

  // --- Multi-user -------------------------------------------------------
  const createUserTool: Tool = {
    definition: toolDef(
      'fleet_v22_create_user',
      'Create a fleet user (display name, email, role viewer/member/operator/admin) with the default quota for that role; admins only, email must be unique.',
      {
        id: { type: 'string', description: 'Unique id for the new user.' },
        displayName: { type: 'string', description: 'Display name.' },
        email: { type: 'string', description: 'Email (must be unique in the fleet).' },
        role: { type: 'string', enum: ['viewer', 'member', 'operator', 'admin'], description: 'Role for the new user.' },
      },
      ['id', 'displayName', 'email'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const user = createFleetV22User({
          id: getStringArg(args, 'id'),
          displayName: getStringArg(args, 'displayName'),
          email: getStringArg(args, 'email'),
          role: (args.role as FleetV22UserRole | undefined) ?? 'member',
        });
        state.users.add(user);
        return jsonResult({ created: user.id, role: user.role, quota: user.quota });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listUsersTool: Tool = {
    definition: toolDef(
      'fleet_v22_list_users',
      'List fleet users with role, active flag, team and quota usage fraction (who is near their limit).',
      {
        team: { type: 'string', description: 'Only users of this team.' },
        role: { type: 'string', enum: ['viewer', 'member', 'operator', 'admin'], description: 'Only users with this role.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        let users = state.users.list();
        if (args.team) users = users.filter((u: FleetV22User) => u.team === args.team);
        if (args.role) users = users.filter((u: FleetV22User) => u.role === args.role);
        return jsonResult(buildFleetV22UserPanel(users, state.usageByUserId));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const setUserRoleTool: Tool = {
    definition: toolDef(
      'fleet_v22_set_user_role',
      'Change a user role (cannot demote the last admin); the new role changes the minimum permissions immediately.',
      {
        userId: { type: 'string', description: 'Id of the user.' },
        role: { type: 'string', enum: ['viewer', 'member', 'operator', 'admin'], description: 'New role.' },
      },
      ['userId', 'role'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const updated = state.users.setRole(getStringArg(args, 'userId'), args.role as FleetV22UserRole);
        return jsonResult({ userId: updated.id, role: updated.role });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const setUserActiveTool: Tool = {
    definition: toolDef(
      'fleet_v22_set_user_active',
      'Lock or unlock a fleet user (locked users cannot run anything until reactivated).',
      {
        userId: { type: 'string', description: 'Id of the user.' },
        active: { type: 'boolean', description: 'true = unlock, false = lock.' },
      },
      ['userId', 'active'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const updated = state.users.setActive(getStringArg(args, 'userId'), getBoolArg(args, 'active', true));
        return jsonResult({ userId: updated.id, active: updated.active });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const userQuotaTool: Tool = {
    definition: toolDef(
      'fleet_v22_user_quota',
      'Show one user quota usage (CPU/RAM/disk/bots/runs/computers reserved vs limit, fractions, near-limit flag) and what a new request would exceed.',
      {
        userId: { type: 'string', description: 'Id of the user.' },
        extraCpuCores: { type: 'number', description: 'Extra CPU cores the new request would reserve.' },
        extraRamBytes: { type: 'number', description: 'Extra RAM bytes the new request would reserve.' },
        extraDiskBytes: { type: 'number', description: 'Extra disk bytes the new request would reserve.' },
      },
      ['userId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const userId = getStringArg(args, 'userId');
        const user = state.users.get(userId);
        if (!user) return errorResult(`User "${userId}" chưa có trong fleet v22.`);
        const usage = state.usageByUserId[userId] ?? { cpuCores: 0, ramBytes: 0, diskBytes: 0, bots: 0, concurrentRuns: 0, computers: 0 };
        const extra = {
          cpuCores: getNumberArg(args, 'extraCpuCores', 0),
          ramBytes: getNumberArg(args, 'extraRamBytes', 0),
          diskBytes: getNumberArg(args, 'extraDiskBytes', 0),
        };
        return jsonResult({
          userId,
          quota: user.quota,
          usage,
          fitsExtra: quotaFitsV22(user.quota, usage, extra),
          shortfall: quotaShortfallV22(user.quota, usage, extra),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- Per-bot computers --------------------------------------------------
  const createComputerTool: Tool = {
    definition: toolDef(
      'fleet_v22_create_computer',
      'Create a per-bot computer (cloud-linux-desktop, local-vm or own-computer) from a granted resource share; one active computer per bot.',
      {
        id: { type: 'string', description: 'Unique id for the computer.' },
        botId: { type: 'string', description: 'Id of the bot owning this computer.' },
        ownerId: { type: 'string', description: 'Id of the user owning the bot.' },
        kind: { type: 'string', enum: ['cloud-linux-desktop', 'local-vm', 'own-computer'], description: 'Kind of computer.' },
        cpuCores: { type: 'number', description: 'CPU cores granted to the computer.' },
        ramBytes: { type: 'number', description: 'RAM bytes granted.' },
        diskBytes: { type: 'number', description: 'Disk bytes granted.' },
        nodeId: { type: 'string', description: 'Fleet node to place the computer on (optional).' },
      },
      ['id', 'botId', 'ownerId', 'kind', 'cpuCores', 'ramBytes', 'diskBytes'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const ownerId = getStringArg(args, 'ownerId');
        const owner = state.users.get(ownerId);
        if (!owner) return errorResult(`User "${ownerId}" chưa có trong fleet v22.`);
        const share = {
          id: getStringArg(args, 'id'),
          ownerId,
          granted: true,
          grantedCpuCores: getNumberArg(args, 'cpuCores', 0),
          grantedRamBytes: getNumberArg(args, 'ramBytes', 0),
          grantedDiskBytes: getNumberArg(args, 'diskBytes', 0),
        };
        const computer = computerFromGrantedShareV22(share, {
          botId: getStringArg(args, 'botId'),
          ownerId,
          kind: args.kind as FleetV22ComputerKind,
          nodeId: (args.nodeId as string | undefined) ?? null,
        });
        state.computers.add(computer);
        return jsonResult({ created: computer.id, kind: computer.kind, status: computer.status });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listComputersTool: Tool = {
    definition: toolDef(
      'fleet_v22_list_computers',
      'List per-bot computers with kind, status, node, granted vs used CPU/RAM/disk and pressure flag.',
      {
        ownerId: { type: 'string', description: 'Only computers of this user.' },
        kind: { type: 'string', enum: ['cloud-linux-desktop', 'local-vm', 'own-computer'], description: 'Only computers of this kind.' },
        status: { type: 'string', description: 'Only computers in this status.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        let computers = state.computers.list();
        if (args.ownerId) computers = computers.filter((c: FleetV22BotComputer) => c.ownerId === args.ownerId);
        if (args.kind) computers = computers.filter((c: FleetV22BotComputer) => c.kind === args.kind);
        if (args.status) computers = computers.filter((c: FleetV22BotComputer) => c.status === args.status);
        return jsonResult(buildFleetV22ComputerPanel(computers));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const computerStatusTool: Tool = {
    definition: toolDef(
      'fleet_v22_computer_status',
      'Move a bot computer through its lifecycle (provisioning/ready/running/paused/draining/stopped/failed); illegal transitions are rejected with the allowed list.',
      {
        computerId: { type: 'string', description: 'Id of the computer.' },
        toStatus: { type: 'string', description: 'Target status.' },
        reason: { type: 'string', description: 'Reason for the transition.' },
      },
      ['computerId', 'toStatus'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const computerId = getStringArg(args, 'computerId');
        const to = args.toStatus as FleetV22ComputerStatus;
        const computer = state.computers.get(computerId);
        if (!computer) return errorResult(`Computer "${computerId}" chưa có trong fleet v22.`);
        if (!computerTransitionAllowedV22(computer.status, to)) {
          return errorResult(`Computer "${computerId}" không chuyển được từ "${computer.status}" sang "${to}".`);
        }
        const updated = transitionFleetV22Computer(computer, to, (args.reason as string | undefined) ?? undefined);
        state.computers.update(updated);
        return jsonResult({ computerId, from: computer.status, to: updated.status });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- Probe + partition ----------------------------------------------------
  const probeHostTool: Tool = {
    definition: toolDef(
      'fleet_v22_probe_host',
      'Probe the host machine CPU/RAM/disk right now (real measurement via the OS module) and report how fresh the measurement is.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const probe = probeHostResourcesV22({});
        state.probe = probe;
        return jsonResult(probe);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const allocatableTool: Tool = {
    definition: toolDef(
      'fleet_v22_allocatable',
      'Show how much CPU/RAM/disk can be shared with bots after reserving headroom for the host (25% CPU, 2 GB RAM, 10% disk minimum 5 GB).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.probe) return errorResult('Chưa có probe nào — chạy fleet_v22_probe_host trước.');
        return jsonResult(allocatableFromProbeV22(state.probe));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const partitionTool: Tool = {
    definition: toolDef(
      'fleet_v22_partition',
      'Partition the allocatable resources across many share requests (priority order, all-or-nothing per request) and report granted/denied with reasons.',
      {
        requests: { type: 'array', description: 'Share requests [{id, ownerId, cpuCores, ramBytes, diskBytes, priority}].' },
      },
      ['requests'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.probe) return errorResult('Chưa có probe nào — chạy fleet_v22_probe_host trước.');
        if (!Array.isArray(args.requests)) return errorResult('Argument "requests" must be an array.');
        const requests = (args.requests as Record<string, unknown>[]).map((r) => ({
          id: String(r.id ?? ''),
          ownerId: String(r.ownerId ?? ''),
          cpuCores: Number(r.cpuCores ?? 0),
          ramBytes: Number(r.ramBytes ?? 0),
          diskBytes: Number(r.diskBytes ?? 0),
          priority: Number(r.priority ?? 0),
        }));
        return jsonResult(partitionResourcesV22(allocatableFromProbeV22(state.probe), requests));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- Subagent delegation ----------------------------------------------------
  const delegateCreateTool: Tool = {
    definition: toolDef(
      'delegate_v22_create',
      'Delegate a task to a subagent: the subagent runs in its own context with only the given task, an allowlisted tool set and a budget (max tool calls, duration, depth, cost); the parent keeps control and can cancel.',
      {
        id: { type: 'string', description: 'Unique id for the delegation.' },
        subagentId: { type: 'string', description: 'Id of the subagent.' },
        subagentName: { type: 'string', description: 'Name of the subagent (e.g. researcher, coder).' },
        task: { type: 'string', description: 'Task for the subagent (the only context it sees).' },
        allowedTools: { type: 'array', description: 'Tools the subagent may use (allowlist).' },
        runId: { type: 'string', description: 'Id of the run containing this delegation.' },
        ownerId: { type: 'string', description: 'Id of the user owning the run.' },
        maxToolCalls: { type: 'number', description: 'Budget: max tool calls (default 50).' },
        maxDurationMs: { type: 'number', description: 'Budget: max duration in ms (default 600000).' },
        maxDepth: { type: 'number', description: 'Budget: max subagent depth (default 0).' },
        parentAgentId: { type: 'string', description: 'Id of the parent agent delegating (default parent).' },
      },
      ['id', 'subagentId', 'subagentName', 'task', 'runId', 'ownerId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const delegation = createFleetV22Delegation({
          id: getStringArg(args, 'id'),
          parentAgentId: (args.parentAgentId as string | undefined) ?? 'parent',
          subagentId: getStringArg(args, 'subagentId'),
          subagentName: getStringArg(args, 'subagentName'),
          task: getStringArg(args, 'task'),
          allowedTools: getStringArrayArg(args, 'allowedTools'),
          budget: {
            maxToolCalls: getNumberArg(args, 'maxToolCalls', 50),
            maxDurationMs: getNumberArg(args, 'maxDurationMs', 600_000),
            maxDepth: getNumberArg(args, 'maxDepth', 0),
          },
          runId: getStringArg(args, 'runId'),
          ownerId: getStringArg(args, 'ownerId'),
        });
        state.delegations.add(delegation);
        audit(state, 'delegate', delegation.runId, delegation.runId, delegation.ownerId,
          `Delegation "${delegation.id}" tạo cho subagent "${delegation.subagentName}" (${delegation.task.slice(0, 120)}).`,
          { delegationId: delegation.id, subagent: delegation.subagentName });
        return jsonResult({ created: delegation.id, status: delegation.status, budget: delegation.budget });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const delegateFinishTool: Tool = {
    definition: toolDef(
      'delegate_v22_finish',
      'Record a subagent finishing its work with a summary and artifacts; the delegation waits for parent verification before it counts as completed.',
      {
        delegationId: { type: 'string', description: 'Id of the delegation.' },
        summary: { type: 'string', description: 'Summary of the subagent result.' },
      },
      ['delegationId', 'summary'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const delegation = state.delegations.get(getStringArg(args, 'delegationId'));
        if (!delegation) return errorResult('Delegation chưa có trong registry.');
        const updated = delegationFinishV22(delegation, { summary: getStringArg(args, 'summary') });
        state.delegations.update(updated);
        return jsonResult({ delegationId: updated.id, status: updated.status });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const delegateVerifyTool: Tool = {
    definition: toolDef(
      'delegate_v22_verify',
      'Parent verifies (or rejects) a finished subagent result with a note; verified becomes completed, rejected becomes failed.',
      {
        delegationId: { type: 'string', description: 'Id of the delegation.' },
        verified: { type: 'boolean', description: 'true = accept the result, false = reject it.' },
        note: { type: 'string', description: 'Verification note.' },
      },
      ['delegationId', 'verified'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const delegation = state.delegations.get(getStringArg(args, 'delegationId'));
        if (!delegation) return errorResult('Delegation chưa có trong registry.');
        const updated = delegationVerifyV22(delegation, getBoolArg(args, 'verified', false), (args.note as string | undefined) ?? undefined);
        state.delegations.update(updated);
        audit(state, 'verify', updated.runId, updated.runId, updated.ownerId,
          `Delegation "${updated.id}" ${updated.verified ? 'được xác minh (completed)' : 'bị từ chối (failed)'}.`,
          { delegationId: updated.id, verified: String(updated.verified ?? false) });
        return jsonResult({ delegationId: updated.id, status: updated.status, verified: updated.verified });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const delegateCancelTool: Tool = {
    definition: toolDef(
      'delegate_v22_cancel',
      'Cancel a pending or running delegation (the subagent stops; its partial work is kept for audit).',
      {
        delegationId: { type: 'string', description: 'Id of the delegation.' },
      },
      ['delegationId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const delegation = state.delegations.get(getStringArg(args, 'delegationId'));
        if (!delegation) return errorResult('Delegation chưa có trong registry.');
        const updated = transitionFleetV22Delegation(delegation, 'cancelled');
        state.delegations.update(updated);
        audit(state, 'cancel', updated.runId, updated.runId, updated.ownerId,
          `Delegation "${updated.id}" bị huỷ.`, { delegationId: updated.id });
        return jsonResult({ delegationId: updated.id, status: updated.status });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const delegateListTool: Tool = {
    definition: toolDef(
      'delegate_v22_list',
      'List delegations with status, budget used (tool calls, cost, elapsed time) and verification state; awaiting-verification first.',
      {
        runId: { type: 'string', description: 'Only delegations of this run.' },
        ownerId: { type: 'string', description: 'Only delegations of this user.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        let list = state.delegations.list();
        if (args.runId) list = list.filter((d: FleetV22Delegation) => d.runId === args.runId);
        if (args.ownerId) list = list.filter((d: FleetV22Delegation) => d.ownerId === args.ownerId);
        const rank: Record<string, number> = { 'awaiting-verification': 0, running: 1, pending: 2, completed: 3, failed: 4, 'timed-out': 5, cancelled: 6 };
        list.sort((a: FleetV22Delegation, b: FleetV22Delegation) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
        return jsonResult(list);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- Handoff ---------------------------------------------------------------
  const handoffRegisterTool: Tool = {
    definition: toolDef(
      'handoff_v22_register_agent',
      'Register an agent that can receive handoffs (id, specialty, instructions, allowed tools, whether approval is required); its transfer tool is transfer_to_<id>.',
      {
        id: { type: 'string', description: 'Id of the agent (letters, digits, underscore only).' },
        name: { type: 'string', description: 'Display name.' },
        description: { type: 'string', description: 'Specialty description (used to decide when to hand off).' },
        instructions: { type: 'string', description: 'System instructions for the agent.' },
        specialty: { type: 'string', description: 'Specialty tag (e.g. billing, coding, support).' },
        allowedTools: { type: 'array', description: 'Tools the agent may use.' },
        requiresApproval: { type: 'boolean', description: 'true = handoff to this agent needs approval first.' },
      },
      ['id', 'name', 'description', 'instructions', 'specialty'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const agent: FleetV22HandoffAgent = {
          id: getStringArg(args, 'id'),
          name: getStringArg(args, 'name'),
          description: getStringArg(args, 'description'),
          instructions: getStringArg(args, 'instructions'),
          specialty: getStringArg(args, 'specialty'),
          allowedTools: getStringArrayArg(args, 'allowedTools'),
          requiresApproval: getBoolArg(args, 'requiresApproval', false),
        };
        const errors = validateFleetV22HandoffAgent(agent);
        if (errors.length > 0) return errorResult(errors.join(' '));
        state.handoffAgents.register(agent);
        return jsonResult({ registered: agent.id, transferTool: handoffToolNameV22(agent.id) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const handoffTransferTool: Tool = {
    definition: toolDef(
      'handoff_v22_transfer',
      'Hand the whole conversation over to a registered specialist agent (full history moves with it); loop guards reject ping-pong and over-limit chains, approval-gated agents wait for approval.',
      {
        conversationId: { type: 'string', description: 'Id of the conversation.' },
        fromAgentId: { type: 'string', description: 'Id of the agent currently holding the conversation.' },
        toAgentId: { type: 'string', description: 'Id of the registered specialist agent.' },
        reason: { type: 'string', description: 'Why hand off.' },
        triggerMessage: { type: 'string', description: 'User message that triggered the handoff.' },
        runId: { type: 'string', description: 'Id of the run containing this handoff.' },
        ownerId: { type: 'string', description: 'Id of the user owning the conversation.' },
      },
      ['conversationId', 'fromAgentId', 'toAgentId', 'reason', 'runId', 'ownerId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId');
        const fromAgentId = getStringArg(args, 'fromAgentId');
        const toAgentId = getStringArg(args, 'toAgentId');
        const toAgent = state.handoffAgents.get(toAgentId);
        if (!toAgent) return errorResult(`Agent "${toAgentId}" chưa đăng ký nhận handoff — đăng ký trước khi chuyển.`);
        let chain = state.chains.get(conversationId);
        if (!chain) {
          chain = new FleetV22HandoffChain(conversationId, fromAgentId);
          state.chains.set(conversationId, chain);
        }
        const errors = chain.validateNext(toAgentId, state.handoffAgents);
        if (errors.length > 0) return errorResult(errors.join(' '));
        const handoff = createFleetV22Handoff({
          id: `handoff-${state.handoffs.length + 1}`,
          conversationId,
          fromAgentId,
          toAgent,
          reason: getStringArg(args, 'reason'),
          triggerMessage: (args.triggerMessage as string | undefined) ?? null,
          messagesTransferred: 0,
          runId: getStringArg(args, 'runId'),
          ownerId: getStringArg(args, 'ownerId'),
        });
        state.handoffs.push(handoff);
        if (handoff.status === 'transferred') {
          chain.append(handoff);
        }
        audit(state, 'handoff', conversationId, handoff.runId, handoff.ownerId,
          `Handoff ${fromAgentId} → ${toAgentId} qua ${handoff.toolName} (${handoff.status}).`,
          { handoffId: handoff.id, from: fromAgentId, to: toAgentId });
        return jsonResult({ handoffId: handoff.id, status: handoff.status, transferTool: handoff.toolName, currentAgent: chain.currentAgentId() });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const handoffApproveTool: Tool = {
    definition: toolDef(
      'handoff_v22_approve',
      'Approve a pending handoff (the specialist agent takes over the conversation).',
      {
        handoffId: { type: 'string', description: 'Id of the handoff.' },
        approvedBy: { type: 'string', description: 'Id of who approves.' },
      },
      ['handoffId', 'approvedBy'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const handoffId = getStringArg(args, 'handoffId');
        const handoff = state.handoffs.find((h: FleetV22Handoff) => h.id === handoffId);
        if (!handoff) return errorResult(`Handoff "${handoffId}" không có.`);
        const approved = approveFleetV22Handoff(handoff, getStringArg(args, 'approvedBy'));
        const idx = state.handoffs.findIndex((h: FleetV22Handoff) => h.id === handoffId);
        state.handoffs[idx] = approved;
        const chain = state.chains.get(approved.conversationId);
        if (chain) chain.append(approved);
        return jsonResult({ handoffId, status: approved.status });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const handoffChainTool: Tool = {
    definition: toolDef(
      'handoff_v22_chain',
      'Show the handoff chain of a conversation (which agents held it, in order) and whether the next handoff would loop.',
      {
        conversationId: { type: 'string', description: 'Id of the conversation.' },
      },
      ['conversationId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const conversationId = getStringArg(args, 'conversationId');
        const chain = state.chains.get(conversationId);
        if (!chain) return jsonResult({ conversationId, steps: [], currentAgent: null, count: 0 });
        return jsonResult({
          conversationId,
          steps: chain.list(),
          currentAgent: chain.currentAgentId(),
          trail: chain.agentTrail(),
          count: chain.count,
          overLimit: chain.isOverLimit(),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- Orchestration ---------------------------------------------------------
  const routeTool: Tool = {
    definition: toolDef(
      'orchestrate_v22_route',
      'Route a task through the rule router: keyword rules pick delegation (background work, parent keeps the conversation) or handoff (specialist takes over); no rule matches defaults to delegation.',
      {
        message: { type: 'string', description: 'Task / user message to route.' },
        conversationId: { type: 'string', description: 'Id of the conversation (for audit).' },
        runId: { type: 'string', description: 'Id of the run (for audit).' },
        ownerId: { type: 'string', description: 'Id of the user (for audit).' },
      },
      ['message'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const decision = routeFleetV22Task(getStringArg(args, 'message'), state.routingRules);
        if (state && args.conversationId && args.runId && args.ownerId) {
          audit(state, 'route', String(args.conversationId), String(args.runId), String(args.ownerId),
            `Route: ${decision.reason}`, { ruleId: decision.ruleId ?? '', mode: decision.mode });
        }
        return jsonResult(decision);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const escalationTool: Tool = {
    definition: toolDef(
      'orchestrate_v22_escalation',
      'Check whether repeated delegation failures should escalate (notify the parent or hand off to a specialist) under the escalation policy.',
      {
        runId: { type: 'string', description: 'Only delegations of this run.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        let list = state.delegations.list();
        if (args.runId) list = list.filter((d: FleetV22Delegation) => d.runId === args.runId);
        const check = checkFleetV22Escalation(list);
        if (check.shouldEscalate) {
          audit(state, 'escalate', String(args.runId ?? ''), String(args.runId ?? ''), '',
            check.reason, { action: check.action });
        }
        return jsonResult(check);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const auditTool: Tool = {
    definition: toolDef(
      'orchestrate_v22_audit',
      'Show the orchestration audit trail (routing, delegation, handoff, escalation, verification decisions), newest first.',
      {
        conversationId: { type: 'string', description: 'Only entries of this conversation.' },
        limit: { type: 'number', description: 'Max entries (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        let entries = state.audit.list();
        if (args.conversationId) entries = entries.filter((e) => e.conversationId === args.conversationId);
        const limit = getNumberArg(args, 'limit', 20);
        return jsonResult(entries.slice(-limit).reverse());
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const dashboardTool: Tool = {
    definition: toolDef(
      'fleet_v22_dashboard',
      'Show the aggregated fleet v22 dashboard: users (roles, quota pressure), computers (kinds, statuses, pressure), orchestration (delegations, handoffs, pending approvals/verifications) and alerts.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        return jsonResult(buildFleetV22Dashboard({
          users: state.users.list(),
          usageByUserId: state.usageByUserId,
          computers: state.computers.list(),
          delegations: state.delegations.list(),
          handoffs: state.handoffs,
          audit: state.audit.list(),
          probe: state.probe,
        }));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    createUserTool,
    listUsersTool,
    setUserRoleTool,
    setUserActiveTool,
    userQuotaTool,
    createComputerTool,
    listComputersTool,
    computerStatusTool,
    probeHostTool,
    allocatableTool,
    partitionTool,
    delegateCreateTool,
    delegateFinishTool,
    delegateVerifyTool,
    delegateCancelTool,
    delegateListTool,
    handoffRegisterTool,
    handoffTransferTool,
    handoffApproveTool,
    handoffChainTool,
    routeTool,
    escalationTool,
    auditTool,
    dashboardTool,
  ];
}

/** Toàn bộ tool v22 (unbound placeholders — host bind qua `createFleetV22Tools`). */
export const FLEET_V22_TOOLS: Tool[] = createFleetV22Tools();

/** true khi mọi tên tool v22 là duy nhất. */
export function fleetV22ToolNamesUnique(): boolean {
  return new Set(FLEET_V22_TOOLS.map((t) => t.definition.name)).size === FLEET_V22_TOOLS.length;
}

/**
 * Tạo state v22 trống cho host (registries rỗng, rule mẫu, audit rỗng) —
 * host chỉ cần giữ 1 instance này rồi truyền vào `createFleetV22Tools`.
 */
export function createEmptyFleetV22ToolState(): FleetV22ToolState {
  return {
    users: new FleetV22UserRegistry(),
    computers: new FleetV22ComputerRegistry(),
    delegations: new FleetV22DelegationRegistry(),
    handoffAgents: new FleetV22HandoffAgentRegistry(),
    chains: new Map<string, FleetV22HandoffChain>(),
    handoffs: [],
    routingRules: [
      createFleetV22RoutingRule({
        id: 'rule-billing',
        name: 'Hoá đơn → handoff billing',
        keywords: ['hoá đơn', 'thanh toán', 'billing', 'invoice', 'payment'],
        mode: 'handoff',
        targetAgentId: 'billing',
        priority: 10,
      }),
      createFleetV22RoutingRule({
        id: 'rule-code',
        name: 'Viết code → delegation coder',
        keywords: ['viết code', 'code', 'lập trình', 'bug', 'fix'],
        mode: 'delegation',
        subagentName: 'coder',
        priority: 5,
      }),
      createFleetV22RoutingRule({
        id: 'rule-research',
        name: 'Nghiên cứu → delegation researcher',
        keywords: ['nghiên cứu', 'tìm hiểu', 'research', 'so sánh'],
        mode: 'delegation',
        subagentName: 'researcher',
        priority: 5,
      }),
    ],
    audit: new FleetV22OrchestrationAuditLog(),
    usageByUserId: {},
    probe: null,
  };
}
