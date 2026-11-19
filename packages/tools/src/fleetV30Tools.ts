/**
 * Fleet v30 tools (v1.44, Team T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Runnable tools for fleet v30 (pure definitions live in
 * `packages/core/src/fleetV30/toolsV30.ts` — 60 tools, 9 groups; this
 * file is the runnable version, wired to core via `@open-bot/core`):
 *
 * - `fleet_v30_iso_*` — per-conversation isolation (bind/list/get/
 *   suspend/resume/end/orphans/usage/events).
 * - `fleet_v30_driver_*` — drivers (capabilities/select/command).
 * - `fleet_v30_board_*` — board v2 (view/reassign/priority/due/
 *   depend/undepend/ready/overdue/retry/kanban/bulk).
 * - `fleet_v30_view_*` — saved board views.
 * - `fleet_v30_group_*` — peer groups (create/list/get/rename/
 *   delete/add-peer/remove-peer/score/pick/probe).
 * - `fleet_v30_admin_*` — admin policy (bootstrap/grant/revoke/
 *   rules/preflight/approvals/events).
 * - `fleet_v30_quota_*` — per-profile quotas (set/get/list/check).
 * - `fleet_v30_snapshot_*` — host persistence (save/load).
 * - `fleet_v30_dashboard` — combined rollup.
 *
 * Like fleet v29, this is a placeholder in ALL_TOOLS until the host
 * binds: `createFleetV30Tools(getState)` with the host's state
 * (isolation manager + board v2 + peer groups + admin policy on top
 * of the v29 registry/allowlist/board). Unbound, tools return a clear
 * "not configured" message instead of guessing state. Write tools need
 * approval (`needsApproval: true`). Tools never run a model, never
 * spawn a process, and never touch the network. A `local`-driver
 * binding is always labelled unisolated.
 */

import type { Tool } from '@open-bot/core';
import {
  FleetV28RuntimeStore,
  FleetV29Allowlist,
  FleetV29PeerRegistry,
  FleetV29TaskBoard,
  FleetV30AdminPolicy,
  FleetV30BoardV2,
  FleetV30IsolationManager,
  FleetV30PeerGroups,
  FleetV30ProfileQuotas,
  buildFleetV30Snapshot,
  fleetV30SnapshotFromJson,
  fleetV30SnapshotToJson,
  restoreFleetV30Snapshot,
  buildFleetV30DriverCommand,
  buildFleetV30Dashboard,
  fleetV30DriverAvailability,
  fleetV30DriverCapabilities,
  selectFleetV30Driver,
  type FleetV30DriverAvailability,
  type FleetV30NetworkMode,
  type FleetV30RuntimeDriverKind,
  type FleetV30TaskPriority,
  type FleetV30TaskType,
} from '@open-bot/core';
import { FLEET_V30_TOOL_NAMES } from '@open-bot/core';

/** State fleet v30 host provides for the tools (resolved lazily per call). */
export interface FleetV30ToolState {
  /** Isolation manager (host holds 1 instance). */
  isolation: FleetV30IsolationManager;
  /** Board v2 (host holds 1 instance). */
  boardV2: FleetV30BoardV2;
  /** v29 task board (host holds 1 instance). */
  board: FleetV29TaskBoard;
  /** v29 peer registry (host holds 1 instance). */
  registry: FleetV29PeerRegistry;
  /** v29 allowlist (host holds 1 instance). */
  allowlist: FleetV29Allowlist;
  /** Peer groups (host holds 1 instance). */
  groups: FleetV30PeerGroups;
  /** Admin policy (host holds 1 instance). */
  admin: FleetV30AdminPolicy;
  /** Per-profile quotas (host holds 1 instance). */
  quotas: FleetV30ProfileQuotas;
  /** v28 runtime store (host holds 1 instance). */
  runtimeStore: FleetV28RuntimeStore;
  /** Driver availability the host probed. */
  driverAvailability: FleetV30DriverAvailability[];
}

const NOT_WIRED =
  'Fleet v30 is not configured: the host has not wired fleet state (isolation manager, board v2, peer groups, admin policy, v29 registry/allowlist/board) into the v30 tools.';

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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value.trim() ? value : null;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
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

function getNumberArrayArg(args: Record<string, unknown>, name: string): number[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number')) {
    throw new Error(`Argument "${name}" must be an array of numbers.`);
  }
  return value as number[];
}

/** Default driver availability for hosts/tests without their own probe. */
export function defaultFleetV30DriverAvailability(): FleetV30DriverAvailability[] {
  return [
    fleetV30DriverAvailability('bwrap', { available: true, binaryPath: '/usr/bin/bwrap', version: null }),
    fleetV30DriverAvailability('docker', { available: false, reason: 'Docker is not installed on this host.' }),
    fleetV30DriverAvailability('local', { available: true }),
  ];
}

/** Build an empty state for hosts without their own state (tests + demo). */
export function createEmptyFleetV30ToolState(): FleetV30ToolState {
  const runtimeStore = new FleetV28RuntimeStore();
  const driverAvailability = defaultFleetV30DriverAvailability();
  const isolation = new FleetV30IsolationManager({
    runtimeStore,
    workspaceBaseDir: '/tmp/open-bot-fleet-v30',
    driverAvailability,
  });
  const registry = new FleetV29PeerRegistry();
  const allowlist = new FleetV29Allowlist();
  const board = new FleetV29TaskBoard({ registry, allowlist });
  const boardV2 = new FleetV30BoardV2({ board, registry, allowlist });
  const groups = new FleetV30PeerGroups({ registry, board });
  const admin = new FleetV30AdminPolicy({
    allowlist,
    registry,
    isolation,
    availableDrivers: ['bwrap', 'local'],
  });
  const quotas = new FleetV30ProfileQuotas({ isolation });
  isolation.setQuotas(quotas);
  return { isolation, boardV2, board, registry, allowlist, groups, admin, quotas, runtimeStore, driverAvailability };
}

/** true when every runnable v30 tool name is unique. */
export function fleetV30ToolNamesUnique(): boolean {
  return new Set(FLEET_V30_TOOL_NAMES).size === FLEET_V30_TOOL_NAMES.length;
}

type Handler = (state: FleetV30ToolState, args: Record<string, unknown>) => Promise<string> | string;

function wrap(handler: Handler, getState: () => FleetV30ToolState | null | undefined): Tool['execute'] {
  return async (args) => {
    try {
      const state = getState();
      if (!state) throw new Error(NOT_WIRED);
      return await handler(state, args as Record<string, unknown>);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

function asDriverKind(value: string | null): FleetV30RuntimeDriverKind | null {
  if (value === null) return null;
  if (value !== 'bwrap' && value !== 'docker' && value !== 'local') {
    throw new Error(`Unknown driver kind "${value}".`);
  }
  return value;
}

function asNetworkMode(value: string | null): FleetV30NetworkMode {
  if (value === null) return 'loopback';
  if (value !== 'none' && value !== 'loopback' && value !== 'host') {
    throw new Error(`Unknown network mode "${value}".`);
  }
  return value;
}

export function createFleetV30Tools(
  getState?: () => FleetV30ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV30ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  const defs: Array<{ definition: Tool['definition']; needsApproval: boolean; execute: Tool['execute'] }> = [
    // -- per-conversation isolation --------------------------------------
    {
      definition: toolDef('fleet_v30_iso_bind', 'Bind a conversation to an isolated runtime (bwrap default, Docker when available, local fallback labelled unisolated).', { conversationId: { type: 'string' }, profileId: { type: 'string' }, botId: { type: 'string' }, driverKind: { type: 'string' }, networkMode: { type: 'string' }, workspaceRoot: { type: 'string' }, allowLocalFallback: { type: 'boolean' } }, ['conversationId', 'profileId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.isolation.bind(getStringArg(args, 'conversationId'), getStringArg(args, 'profileId'), {
          ...(getOptionalStringArg(args, 'botId') ? { botId: getOptionalStringArg(args, 'botId') as string } : {}),
          driverKind: asDriverKind(getOptionalStringArg(args, 'driverKind')),
          networkMode: asNetworkMode(getOptionalStringArg(args, 'networkMode')),
          ...(getOptionalStringArg(args, 'workspaceRoot') ? { workspaceRoot: getOptionalStringArg(args, 'workspaceRoot') as string } : {}),
          allowLocalFallback: getBooleanArg(args, 'allowLocalFallback', true),
        });
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ binding: result.binding });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_iso_list', 'List isolation bindings, optionally filtered by status or profile.', { status: { type: 'string' }, profileId: { type: 'string' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => {
        const status = getOptionalStringArg(args, 'status');
        const profileId = getOptionalStringArg(args, 'profileId');
        let bindings = state.isolation.listBindings(
          status ? (status as 'active' | 'suspended' | 'cleaned') : undefined,
        );
        if (profileId) bindings = bindings.filter((b) => b.profileId === profileId);
        return jsonResult({ bindings });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_iso_get', 'Show one isolation binding (driver, workspace, network mode, status).', { conversationId: { type: 'string' } }, ['conversationId']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const binding = state.isolation.getBinding(getStringArg(args, 'conversationId'));
        if (!binding) return errorResult(`No isolation binding for "${getStringArg(args, 'conversationId')}".`);
        return jsonResult({ binding });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_iso_suspend', 'Suspend an isolation binding (runtime stopped, workspace kept).', { conversationId: { type: 'string' }, reason: { type: 'string' } }, ['conversationId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.isolation.suspend(getStringArg(args, 'conversationId'), getOptionalStringArg(args, 'reason') ?? undefined);
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ binding: result.binding });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_iso_resume', 'Resume a suspended isolation binding (runtime restarted).', { conversationId: { type: 'string' } }, ['conversationId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.isolation.resume(getStringArg(args, 'conversationId'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ binding: result.binding });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_iso_end', 'End a conversation: stop its runtime and list scratch paths for wiping.', { conversationId: { type: 'string' }, reason: { type: 'string' } }, ['conversationId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.isolation.endConversation(
          getStringArg(args, 'conversationId'),
          getOptionalStringArg(args, 'reason') ?? 'Conversation ended.',
        );
        if (!result.cleaned) return errorResult(result.reasons.join(' '));
        return jsonResult({ cleaned: true, conversationId: result.conversationId, wipedPaths: result.wipedPaths });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_iso_orphans', 'Clean up orphaned bindings whose v28 runtime vanished without cleanup.', {}, []),
      needsApproval: true,
      execute: wrap((state) => jsonResult({ orphaned: state.isolation.sweepOrphans() }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_iso_sweep_evicted', 'Suspend active bindings whose v28 runtime was evicted (idle) or failed (workspace kept, resumable).', {}, []),
      needsApproval: true,
      execute: wrap((state) => jsonResult({ suspended: state.isolation.sweepEvictedBindings() }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_iso_usage', 'Aggregate resource usage across active isolation bindings.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult(state.isolation.aggregateUsage()), resolveState),
    },
    {
      definition: toolDef('fleet_v30_iso_events', 'List isolation audit events, optionally for one conversation.', { conversationId: { type: 'string' }, limit: { type: 'number' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => {
        const conversationId = getOptionalStringArg(args, 'conversationId');
        const limit = getNumberArg(args, 'limit', 200);
        return jsonResult({
          events: conversationId
            ? state.isolation.eventsFor(conversationId, limit)
            : state.isolation.listEvents(limit),
        });
      }, resolveState),
    },
    // -- drivers ----------------------------------------------------------
    {
      definition: toolDef('fleet_v30_driver_capabilities', 'Show the capability matrix for every isolation driver (bwrap, docker, local).', {}, []),
      needsApproval: false,
      execute: wrap(() => jsonResult({
        drivers: (['bwrap', 'docker', 'local'] as const).map((k) => fleetV30DriverCapabilities(k)),
      }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_driver_select', 'Select the best available isolation driver for a network mode (preferred kind first, local only as fallback).', { preferred: { type: 'string' }, networkMode: { type: 'string' }, allowLocalFallback: { type: 'boolean' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => {
        const selected = selectFleetV30Driver(
          asDriverKind(getOptionalStringArg(args, 'preferred')),
          state.driverAvailability,
          asNetworkMode(getOptionalStringArg(args, 'networkMode')),
          getBooleanArg(args, 'allowLocalFallback', true),
        );
        if (!selected) return errorResult('No isolation driver is available on this host.');
        return jsonResult(selected);
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_driver_command', 'Build the driver argv for one command (bwrap/docker/local) without running it.', { driverKind: { type: 'string' }, command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, workspaceRoot: { type: 'string' }, networkMode: { type: 'string' }, cpuCores: { type: 'number' }, ramMB: { type: 'number' } }, ['driverKind', 'command', 'cwd', 'workspaceRoot']),
      needsApproval: false,
      execute: wrap((_state, args) => {
        const kind = asDriverKind(getOptionalStringArg(args, 'driverKind'));
        if (!kind) return errorResult('driverKind is required.');
        const built = buildFleetV30DriverCommand(kind, {
          command: getStringArg(args, 'command'),
          args: getStringArrayArg(args, 'args'),
          cwd: getStringArg(args, 'cwd'),
          workspaceRoot: getStringArg(args, 'workspaceRoot'),
          networkMode: asNetworkMode(getOptionalStringArg(args, 'networkMode')),
          cpuCores: getOptionalNumberArg(args, 'cpuCores'),
          ramMB: getOptionalNumberArg(args, 'ramMB'),
        });
        if (!built.ok) return errorResult(built.reasons.join(' '));
        return jsonResult({ argv: built.argv, isolated: kind !== 'local' });
      }, resolveState),
    },
    // -- board v2 ---------------------------------------------------------
    {
      definition: toolDef('fleet_v30_board_view', 'Show one board v2 task (v29 task + priority, deadline, SLA, dependencies, timeline).', { taskId: { type: 'string' } }, ['taskId']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const view = state.boardV2.viewTask(getStringArg(args, 'taskId'));
        if (!view) return errorResult(`No board task "${getStringArg(args, 'taskId')}".`);
        return jsonResult({ task: view });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_reassign', 'Reassign a submitted task to another peer (v29 delegation gate re-runs for the new peer).', { taskId: { type: 'string' }, newPeerId: { type: 'string' }, actor: { type: 'string' } }, ['taskId', 'newPeerId', 'actor']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.boardV2.reassign(getStringArg(args, 'taskId'), getStringArg(args, 'newPeerId'), getStringArg(args, 'actor'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ task: result.view });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_priority', 'Set a board v2 task priority (low/normal/high/urgent).', { taskId: { type: 'string' }, priority: { type: 'string' }, actor: { type: 'string' } }, ['taskId', 'priority', 'actor']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const priority = getStringArg(args, 'priority');
        if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return errorResult(`Unknown priority "${priority}".`);
        const result = state.boardV2.setPriority(getStringArg(args, 'taskId'), priority as FleetV30TaskPriority, getStringArg(args, 'actor'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ task: result.view });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_due', 'Set or clear a board v2 task deadline and SLA budget.', { taskId: { type: 'string' }, dueAt: { type: 'string' }, slaMinutes: { type: 'number' }, actor: { type: 'string' } }, ['taskId', 'actor']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.boardV2.setDue(
          getStringArg(args, 'taskId'),
          getOptionalStringArg(args, 'dueAt'),
          getOptionalNumberArg(args, 'slaMinutes'),
          getStringArg(args, 'actor'),
        );
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ task: result.view });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_depend', 'Add a dependency: one task waits for another (cycles refused).', { taskId: { type: 'string' }, blockerId: { type: 'string' }, actor: { type: 'string' } }, ['taskId', 'blockerId', 'actor']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.boardV2.addDependency(getStringArg(args, 'taskId'), getStringArg(args, 'blockerId'), getStringArg(args, 'actor'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ task: result.view });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_undepend', 'Remove a dependency between two tasks.', { taskId: { type: 'string' }, blockerId: { type: 'string' }, actor: { type: 'string' } }, ['taskId', 'blockerId', 'actor']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.boardV2.removeDependency(getStringArg(args, 'taskId'), getStringArg(args, 'blockerId'), getStringArg(args, 'actor'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ task: result.view });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_ready', 'List submitted tasks that are unblocked and ready to start.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ tasks: state.boardV2.readyTasks() }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_overdue', 'Sweep overdue tasks (flag missed deadlines, escalate SLA breaches).', { actor: { type: 'string' } }, []),
      needsApproval: true,
      execute: wrap((state, args) => jsonResult(state.boardV2.sweepOverdue(getOptionalStringArg(args, 'actor') ?? 'system')), resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_retry', 'Retry a failed task within its retry budget (re-runs the delegation gate).', { taskId: { type: 'string' }, actor: { type: 'string' } }, ['taskId', 'actor']),
      needsApproval: true,
      execute: wrap(async (state, args) => {
        const result = await state.boardV2.retryFailed(getStringArg(args, 'taskId'), getStringArg(args, 'actor'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ task: result.view, newTaskId: result.newTaskId });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_kanban', 'Show the board v2 kanban (tasks grouped by configurable columns).', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ columns: state.boardV2.kanbanBoard() }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_export', 'Export the board v2 as newline-delimited JSON (task + priority, deadline, SLA, dependencies; no prompt text).', { state: { type: 'string' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => {
        const stateFilter = getOptionalStringArg(args, 'state');
        const valid = ['submitted', 'working', 'input-required', 'auth-required', 'completed', 'failed', 'cancelled', 'rejected'];
        if (stateFilter !== null && !valid.includes(stateFilter)) {
          return errorResult(`Unknown A2A state "${stateFilter}".`);
        }
        return state.boardV2.exportBoard(stateFilter === null ? undefined : (stateFilter as 'submitted' | 'working' | 'input-required' | 'auth-required' | 'completed' | 'failed' | 'cancelled' | 'rejected'));
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_bulk_cancel', 'Cancel many board tasks at once (per-task reasons for refusals).', { taskIds: { type: 'array', items: { type: 'string' } }, byUser: { type: 'boolean' }, reason: { type: 'string' } }, ['taskIds']),
      needsApproval: true,
      execute: wrap(async (state, args) => jsonResult(await state.boardV2.bulkCancel(
        getStringArrayArg(args, 'taskIds'),
        getBooleanArg(args, 'byUser', true),
        getOptionalStringArg(args, 'reason') ?? undefined,
      )), resolveState),
    },
    {
      definition: toolDef('fleet_v30_board_bulk_reassign', 'Reassign many submitted tasks to one peer (per-task gate).', { taskIds: { type: 'array', items: { type: 'string' } }, newPeerId: { type: 'string' }, actor: { type: 'string' } }, ['taskIds', 'newPeerId', 'actor']),
      needsApproval: true,
      execute: wrap((state, args) => jsonResult(state.boardV2.bulkReassign(
        getStringArrayArg(args, 'taskIds'),
        getStringArg(args, 'newPeerId'),
        getStringArg(args, 'actor'),
      )), resolveState),
    },
    // -- saved views ------------------------------------------------------
    {
      definition: toolDef('fleet_v30_view_create', 'Create a saved board view (named filter preset).', { name: { type: 'string' }, createdBy: { type: 'string' }, peerId: { type: 'string' }, state: { type: 'string' }, priority: { type: 'string' }, query: { type: 'string' }, activeOnly: { type: 'boolean' }, overdueOnly: { type: 'boolean' }, groupId: { type: 'string' } }, ['name', 'createdBy']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.boardV2.createView({
          name: getStringArg(args, 'name'),
          createdBy: getStringArg(args, 'createdBy'),
          ...(getOptionalStringArg(args, 'peerId') ? { peerId: getOptionalStringArg(args, 'peerId') as string } : {}),
          ...(getOptionalStringArg(args, 'state') ? { state: getOptionalStringArg(args, 'state') as 'submitted' | 'working' | 'input-required' | 'auth-required' | 'completed' | 'failed' | 'cancelled' | 'rejected' } : {}),
          ...(getOptionalStringArg(args, 'priority') ? { priority: getOptionalStringArg(args, 'priority') as FleetV30TaskPriority } : {}),
          ...(getOptionalStringArg(args, 'query') ? { query: getOptionalStringArg(args, 'query') as string } : {}),
          activeOnly: getBooleanArg(args, 'activeOnly', false),
          overdueOnly: getBooleanArg(args, 'overdueOnly', false),
          ...(getOptionalStringArg(args, 'groupId') ? { groupId: getOptionalStringArg(args, 'groupId') as string } : {}),
        });
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ view: result.view });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_view_list', 'List saved board views.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ views: state.boardV2.listViews() }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_view_apply', 'Apply a saved board view and list the matching tasks.', { viewId: { type: 'string' } }, ['viewId']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const result = state.boardV2.applyView(getStringArg(args, 'viewId'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ tasks: result.tasks });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_view_delete', 'Delete a saved board view.', { viewId: { type: 'string' } }, ['viewId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        if (!state.boardV2.deleteView(getStringArg(args, 'viewId'))) {
          return errorResult(`No saved view "${getStringArg(args, 'viewId')}".`);
        }
        return jsonResult({ deleted: true, viewId: getStringArg(args, 'viewId') });
      }, resolveState),
    },
    // -- peer groups ------------------------------------------------------
    {
      definition: toolDef('fleet_v30_group_create', 'Create a peer group (named set of peers).', { name: { type: 'string' }, createdBy: { type: 'string' }, description: { type: 'string' }, defaultMaxConcurrent: { type: 'number' } }, ['name', 'createdBy']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.groups.createGroup(getStringArg(args, 'name'), getStringArg(args, 'createdBy'), {
          ...(getOptionalStringArg(args, 'description') ? { description: getOptionalStringArg(args, 'description') as string } : {}),
          defaultMaxConcurrent: getOptionalNumberArg(args, 'defaultMaxConcurrent'),
        });
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ group: result.group });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_group_list', 'List peer groups with their members.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ groups: state.groups.listGroups() }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_group_get', 'Show one peer group with member health.', { groupId: { type: 'string' } }, ['groupId']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const group = state.groups.getGroup(getStringArg(args, 'groupId'));
        if (!group) return errorResult(`No peer group "${getStringArg(args, 'groupId')}".`);
        return jsonResult({ group, peers: state.groups.peersInGroup(group.groupId) });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_group_rename', 'Rename a peer group.', { groupId: { type: 'string' }, name: { type: 'string' } }, ['groupId', 'name']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.groups.renameGroup(getStringArg(args, 'groupId'), getStringArg(args, 'name'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ group: result.group });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_group_delete', 'Delete a peer group (members keep their peers, group tags removed).', { groupId: { type: 'string' } }, ['groupId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.groups.deleteGroup(getStringArg(args, 'groupId'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ deleted: true, groupId: getStringArg(args, 'groupId') });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_group_add_peer', 'Add a registered peer to a group.', { groupId: { type: 'string' }, peerId: { type: 'string' } }, ['groupId', 'peerId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.groups.addPeer(getStringArg(args, 'groupId'), getStringArg(args, 'peerId'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ group: result.group });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_group_remove_peer', 'Remove a peer from a group.', { groupId: { type: 'string' }, peerId: { type: 'string' } }, ['groupId', 'peerId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.groups.removePeer(getStringArg(args, 'groupId'), getStringArg(args, 'peerId'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ group: result.group });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_group_score', 'Score candidate peers for a task requirement (skills, health, capacity, latency).', { requiredSkills: { type: 'array', items: { type: 'string' } }, latencyBudgetMs: { type: 'number' }, streamingRequired: { type: 'boolean' }, groupId: { type: 'string' }, excludePeerIds: { type: 'array', items: { type: 'string' } } }, []),
      needsApproval: false,
      execute: wrap((state, args) => jsonResult({
        scores: state.groups.scorePeers({
          requiredSkills: getStringArrayArg(args, 'requiredSkills'),
          latencyBudgetMs: getOptionalNumberArg(args, 'latencyBudgetMs'),
          streamingRequired: getBooleanArg(args, 'streamingRequired', false),
          groupId: getOptionalStringArg(args, 'groupId'),
          excludePeerIds: getStringArrayArg(args, 'excludePeerIds'),
        }),
      }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_group_pick', 'Pick the best peer for a task requirement (load-balanced, failover-aware).', { requiredSkills: { type: 'array', items: { type: 'string' } }, latencyBudgetMs: { type: 'number' }, streamingRequired: { type: 'boolean' }, groupId: { type: 'string' }, excludePeerIds: { type: 'array', items: { type: 'string' } } }, []),
      needsApproval: false,
      execute: wrap((state, args) => {
        const pick = state.groups.pickPeer({
          requiredSkills: getStringArrayArg(args, 'requiredSkills'),
          latencyBudgetMs: getOptionalNumberArg(args, 'latencyBudgetMs'),
          streamingRequired: getBooleanArg(args, 'streamingRequired', false),
          groupId: getOptionalStringArg(args, 'groupId'),
          excludePeerIds: getStringArrayArg(args, 'excludePeerIds'),
        });
        return jsonResult({ pick });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_group_probe', 'Record a discovery probe for a peer endpoint (feeds health scoring).', { peerId: { type: 'string' }, endpoint: { type: 'string' }, reachable: { type: 'boolean' }, latencyMs: { type: 'number' }, error: { type: 'string' } }, ['peerId', 'endpoint', 'reachable']),
      needsApproval: true,
      execute: wrap((state, args) => jsonResult({
        probe: state.groups.recordProbe({
          peerId: getStringArg(args, 'peerId'),
          endpoint: getStringArg(args, 'endpoint'),
          reachable: getBooleanArg(args, 'reachable', false),
          latencyMs: getOptionalNumberArg(args, 'latencyMs'),
          error: getOptionalStringArg(args, 'error'),
        }),
      }), resolveState),
    },
    // -- admin policy -----------------------------------------------------
    {
      definition: toolDef('fleet_v30_admin_bootstrap', 'Bootstrap the first admin (host calls once with the local user id).', { userId: { type: 'string' } }, ['userId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.admin.bootstrapAdmin(getStringArg(args, 'userId'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ admin: result.admin });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_list', 'List admins and their roles.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ admins: state.admin.listAdmins() }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_grant', 'Grant a role to a user (admin only).', { granterId: { type: 'string' }, userId: { type: 'string' }, role: { type: 'string' } }, ['granterId', 'userId', 'role']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const role = getStringArg(args, 'role');
        if (!['viewer', 'operator', 'admin'].includes(role)) return errorResult(`Unknown role "${role}".`);
        const result = state.admin.grantRole(getStringArg(args, 'granterId'), getStringArg(args, 'userId'), role as 'viewer' | 'operator' | 'admin');
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ admin: result.admin });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_revoke', 'Revoke a user role (admin only; cannot revoke the last admin).', { revokerId: { type: 'string' }, userId: { type: 'string' } }, ['revokerId', 'userId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.admin.revokeRole(getStringArg(args, 'revokerId'), getStringArg(args, 'userId'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ revoked: true, userId: getStringArg(args, 'userId') });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_rule_create', 'Create a policy rule (time window, runtime kinds, task types, caps, approval requirement).', { actor: { type: 'string' }, name: { type: 'string' }, taskTypes: { type: 'array', items: { type: 'string' } }, runtimeKinds: { type: 'array', items: { type: 'string' } }, peerIds: { type: 'array', items: { type: 'string' } }, startHour: { type: 'number' }, endHour: { type: 'number' }, days: { type: 'array', items: { type: 'number' } }, maxCostUsdPerTask: { type: 'number' }, maxConcurrentTasks: { type: 'number' }, requiresApprovalFor: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' } }, ['actor', 'name']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const startHour = getOptionalNumberArg(args, 'startHour');
        const endHour = getOptionalNumberArg(args, 'endHour');
        const days = getNumberArrayArg(args, 'days');
        const timeWindow = startHour !== null && endHour !== null
          ? { startHour, endHour, days: days.length > 0 ? days : [0, 1, 2, 3, 4, 5, 6] }
          : null;
        const result = state.admin.createRule(getStringArg(args, 'actor'), {
          name: getStringArg(args, 'name'),
          taskTypes: getStringArrayArg(args, 'taskTypes') as FleetV30TaskType[],
          runtimeKinds: getStringArrayArg(args, 'runtimeKinds') as FleetV30RuntimeDriverKind[],
          peerIds: getStringArrayArg(args, 'peerIds'),
          timeWindow,
          maxCostUsdPerTask: getOptionalNumberArg(args, 'maxCostUsdPerTask'),
          maxConcurrentTasks: getOptionalNumberArg(args, 'maxConcurrentTasks'),
          requiresApprovalFor: getStringArrayArg(args, 'requiresApprovalFor') as FleetV30TaskType[],
          enabled: getBooleanArg(args, 'enabled', true),
        });
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ rule: result.rule });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_rule_list', 'List policy rules.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ rules: state.admin.listRules() }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_rule_update', 'Update a policy rule (creator or admin).', { actor: { type: 'string' }, ruleId: { type: 'string' }, name: { type: 'string' }, enabled: { type: 'boolean' }, maxCostUsdPerTask: { type: 'number' }, maxConcurrentTasks: { type: 'number' } }, ['actor', 'ruleId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.admin.updateRule(getStringArg(args, 'actor'), getStringArg(args, 'ruleId'), {
          ...(getOptionalStringArg(args, 'name') ? { name: getOptionalStringArg(args, 'name') as string } : {}),
          ...(args['enabled'] !== undefined ? { enabled: getBooleanArg(args, 'enabled', true) } : {}),
          ...(getOptionalNumberArg(args, 'maxCostUsdPerTask') !== null ? { maxCostUsdPerTask: getOptionalNumberArg(args, 'maxCostUsdPerTask') } : {}),
          ...(getOptionalNumberArg(args, 'maxConcurrentTasks') !== null ? { maxConcurrentTasks: getOptionalNumberArg(args, 'maxConcurrentTasks') } : {}),
        });
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ rule: result.rule });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_rule_delete', 'Delete a policy rule (admin only).', { actor: { type: 'string' }, ruleId: { type: 'string' } }, ['actor', 'ruleId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.admin.deleteRule(getStringArg(args, 'actor'), getStringArg(args, 'ruleId'));
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ deleted: true, ruleId: getStringArg(args, 'ruleId') });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_preflight', 'Run the pre-flight permission check before executing work (allowlist + card + runtime + policy + cost).', { actor: { type: 'string' }, peerId: { type: 'string' }, taskType: { type: 'string' }, runtimeKind: { type: 'string' }, estimatedCostUsd: { type: 'number' }, conversationId: { type: 'string' }, activeTasksForPeer: { type: 'number' } }, ['actor', 'peerId', 'taskType', 'runtimeKind']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const taskType = getStringArg(args, 'taskType');
        const runtimeKind = asDriverKind(getOptionalStringArg(args, 'runtimeKind'));
        if (!runtimeKind) return errorResult('runtimeKind is required.');
        const decision = state.admin.preflightCheck({
          actor: getStringArg(args, 'actor'),
          peerId: getStringArg(args, 'peerId'),
          taskType: taskType as FleetV30TaskType,
          runtimeKind,
          estimatedCostUsd: getOptionalNumberArg(args, 'estimatedCostUsd'),
          conversationId: getOptionalStringArg(args, 'conversationId'),
          activeTasksForPeer: getNumberArg(args, 'activeTasksForPeer', 0),
        });
        return jsonResult(decision);
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_approval_request', 'Request approval for out-of-scope work (operator+).', { requestedBy: { type: 'string' }, peerId: { type: 'string' }, taskType: { type: 'string' }, summary: { type: 'string' }, expiresAt: { type: 'string' } }, ['requestedBy', 'peerId', 'taskType', 'summary']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.admin.requestApproval(
          getStringArg(args, 'requestedBy'),
          getStringArg(args, 'peerId'),
          getStringArg(args, 'taskType') as FleetV30TaskType,
          getStringArg(args, 'summary'),
          getOptionalStringArg(args, 'expiresAt'),
        );
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ request: result.request });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_approval_decide', 'Approve or deny an approval request (admin only).', { decidedBy: { type: 'string' }, requestId: { type: 'string' }, approve: { type: 'boolean' }, reason: { type: 'string' } }, ['decidedBy', 'requestId', 'approve']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.admin.decideApproval(
          getStringArg(args, 'decidedBy'),
          getStringArg(args, 'requestId'),
          getBooleanArg(args, 'approve', false),
          getOptionalStringArg(args, 'reason') ?? undefined,
        );
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ request: result.request });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_approval_list', 'List approval requests, optionally filtered by status.', { status: { type: 'string' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => {
        const status = getOptionalStringArg(args, 'status');
        if (status && !['pending', 'approved', 'denied', 'expired'].includes(status)) {
          return errorResult(`Unknown approval status "${status}".`);
        }
        return jsonResult({ requests: state.admin.listApprovals(status as 'pending' | 'approved' | 'denied' | 'expired' | undefined) });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_admin_events', 'List admin audit events.', { limit: { type: 'number' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => jsonResult({ events: state.admin.listEvents(getNumberArg(args, 'limit', 200)) }), resolveState),
    },
    // -- per-profile quotas -------------------------------------------------
    {
      definition: toolDef('fleet_v30_quota_set', 'Set (or replace) a profile fleet quota (max bindings, CPU, RAM, disk caps).', { profileId: { type: 'string' }, setBy: { type: 'string' }, maxBindings: { type: 'number' }, maxCpuCores: { type: 'number' }, maxRamMB: { type: 'number' }, maxDiskMB: { type: 'number' } }, ['profileId', 'setBy']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.quotas.setQuota(getStringArg(args, 'profileId'), getStringArg(args, 'setBy'), {
          maxBindings: getOptionalNumberArg(args, 'maxBindings'),
          maxCpuCores: getOptionalNumberArg(args, 'maxCpuCores'),
          maxRamMB: getOptionalNumberArg(args, 'maxRamMB'),
          maxDiskMB: getOptionalNumberArg(args, 'maxDiskMB'),
        });
        if (!result.ok) return errorResult(result.reasons.join(' '));
        return jsonResult({ quota: result.quota });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v30_quota_get', 'Show one profile quota with its live usage and over-quota flags.', { profileId: { type: 'string' } }, ['profileId']),
      needsApproval: false,
      execute: wrap((state, args) => jsonResult(state.quotas.usageFor(getStringArg(args, 'profileId'))), resolveState),
    },
    {
      definition: toolDef('fleet_v30_quota_list', 'List all profile quotas.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ quotas: state.quotas.listQuotas(), overQuota: state.quotas.profilesOverQuota() }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_quota_check', 'Check whether one more bind with given limits fits a profile quota (admission check).', { profileId: { type: 'string' }, cpuCores: { type: 'number' }, ramMB: { type: 'number' }, diskMB: { type: 'number' } }, ['profileId']),
      needsApproval: false,
      execute: wrap((state, args) => jsonResult(state.quotas.checkAdmission(getStringArg(args, 'profileId'), {
        cpuCores: getNumberArg(args, 'cpuCores', 1),
        ramMB: getNumberArg(args, 'ramMB', 2048),
        diskMB: getNumberArg(args, 'diskMB', 5120),
        timeoutMs: 30 * 60 * 1000,
        idleTimeoutMs: 15 * 60 * 1000,
        maxRestarts: 3,
      })), resolveState),
    },
    // -- snapshot ---------------------------------------------------------
    {
      definition: toolDef('fleet_v30_snapshot_save', 'Save the fleet v30 snapshot (groups, views, kanban, rules, admins, approvals, binding descriptors) as JSON.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({
        snapshotJson: fleetV30SnapshotToJson(buildFleetV30Snapshot({
          isolation: state.isolation,
          boardV2: state.boardV2,
          groups: state.groups,
          admin: state.admin,
        })),
      }), resolveState),
    },
    {
      definition: toolDef('fleet_v30_snapshot_load', 'Load a fleet v30 snapshot JSON into fresh stores (live bindings are not restored — the host re-binds).', { snapshotJson: { type: 'string' }, restoredBy: { type: 'string' } }, ['snapshotJson', 'restoredBy']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const parsed = fleetV30SnapshotFromJson(getStringArg(args, 'snapshotJson'));
        if (!parsed.ok) return errorResult(parsed.reasons.join(' '));
        return jsonResult(restoreFleetV30Snapshot(parsed.snapshot, {
          isolation: state.isolation,
          boardV2: state.boardV2,
          groups: state.groups,
          admin: state.admin,
          restoredBy: getStringArg(args, 'restoredBy'),
        }));
      }, resolveState),
    },
    // -- rollup -----------------------------------------------------------
    {
      definition: toolDef('fleet_v30_dashboard', 'Combined fleet v30 dashboard (isolation + board v2 + peer groups + admin).', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult(buildFleetV30Dashboard({
        isolation: state.isolation,
        boardV2: state.boardV2,
        board: state.board,
        groups: state.groups,
        admin: state.admin,
        registry: state.registry,
        allowlist: state.allowlist,
        quotas: state.quotas,
      })), resolveState),
    },
  ];

  return defs.map((d) => ({
    definition: d.definition,
    needsApproval: d.needsApproval,
    execute: d.execute,
  }));
}

export const FLEET_V30_TOOLS: Tool[] = createFleetV30Tools();
