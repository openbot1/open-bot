/**
 * Fleet v29 tools (v1.42, Team T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Runnable tools for fleet v29 (pure definitions live in
 * `packages/core/src/fleetV29/toolsV29.ts` — 37 tools, 7 groups; this
 * file is the runnable version, wired to core via `@open-bot/core`):
 *
 * - `fleet_v29_peer_*` — peer registry (register/list/get/remove/
 *   verify/health/samples/record-sample).
 * - `fleet_v29_board_*` — A2A task board (submit/list/get/start/
 *   progress/complete/fail/cancel/cancel-all/input/cost).
 * - `fleet_v29_allowlist_*` — allowlist admin (add/list/get/remove/
 *   suspend/resume/scope).
 * - `fleet_v29_audit_*` — audit log (list/verify/export).
 * - `fleet_v29_confirm_*` — sensitive confirmations (request/list/
 *   approve/deny).
 * - `fleet_v29_snapshot_*` — host persistence (save/load).
 * - `fleet_v29_health` + `fleet_v29_dashboard` — rollups.
 *
 * Like fleet v28, this is a placeholder in ALL_TOOLS until the host
 * binds: `createFleetV29Tools(getState)` with the host's state
 * (peer registry + allowlist + task board + audit log +
 * confirmation queue). Unbound, tools return a clear "not
 * configured" message instead of guessing state. Write tools need
 * approval (`needsApproval: true`). Tools never run a model, never
 * spawn a process, and never touch the network. The board in
 * simulation mode never claims a task reached a real peer.
 */

import type { Tool } from '@open-bot/core';
import {
  FleetV29Allowlist,
  FleetV29AuditLog,
  FleetV29ConfirmationQueue,
  FleetV29PeerRegistry,
  FleetV29TaskBoard,
  buildAgentCard,
  buildFleetV29Dashboard,
  buildFleetV29HealthSummary,
  buildFleetV29Snapshot,
  fleetV29CheckCard,
  fleetV29HealthAlerts,
  fleetV29SnapshotFromJson,
  restoreFleetV29Snapshot,
  type FleetV29AuditKind,
  type FleetV29CardPolicy,
  type FleetV29SensitiveAction,
} from '@open-bot/core';
import { FLEET_V29_TOOL_NAMES } from '@open-bot/core';

/** State fleet v29 host provides for the tools (resolved lazily per call). */
export interface FleetV29ToolState {
  /** Peer registry (host holds 1 instance). */
  registry: FleetV29PeerRegistry;
  /** Allowlist (host holds 1 instance). */
  allowlist: FleetV29Allowlist;
  /** Task board (host holds 1 instance). */
  board: FleetV29TaskBoard;
  /** Audit log (host holds 1 instance). */
  audit: FleetV29AuditLog;
  /** Sensitive-confirmation queue (host holds 1 instance). */
  confirmations: FleetV29ConfirmationQueue;
  /** Card policy override (default: signed cards required). */
  cardPolicy?: FleetV29CardPolicy;
}

const NOT_WIRED =
  'Fleet v29 is not configured: the host has not wired fleet state (peer registry, allowlist, task board, audit log, confirmation queue) into the v29 tools.';

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

/** Build an empty state for hosts without their own state (tests + demo). */
export function createEmptyFleetV29ToolState(): FleetV29ToolState {
  const registry = new FleetV29PeerRegistry();
  const allowlist = new FleetV29Allowlist();
  const board = new FleetV29TaskBoard({ registry, allowlist });
  const audit = new FleetV29AuditLog();
  const confirmations = new FleetV29ConfirmationQueue({ allowlist, board });
  return { registry, allowlist, board, audit, confirmations };
}

/** true when every runnable v29 tool name is unique. */
export function fleetV29ToolNamesUnique(): boolean {
  return new Set(FLEET_V29_TOOL_NAMES).size === FLEET_V29_TOOL_NAMES.length;
}

type Handler = (state: FleetV29ToolState, args: Record<string, unknown>) => Promise<string> | string;

function wrap(handler: Handler, getState: () => FleetV29ToolState | null | undefined): Tool['execute'] {
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

export function createFleetV29Tools(
  getState?: () => FleetV29ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV29ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  const audit = (state: FleetV29ToolState, kind: FleetV29AuditKind, actor: string, detail: string, peerId?: string, taskId?: string): void => {
    state.audit.append({ kind, actor, detail, ...(peerId ? { peerId } : {}), ...(taskId ? { taskId } : {}) });
  };

  const defs: Array<{ definition: Tool['definition']; needsApproval: boolean; execute: Tool['execute'] }> = [
    // -- peer registry ------------------------------------------------------
    {
      definition: toolDef('fleet_v29_peer_register', 'Register an A2A peer from its Agent Card (unverified until the card check passes).', { peerId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, url: { type: 'string' }, version: { type: 'string' }, protocolVersion: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, tenantId: { type: 'string' } }, ['peerId', 'name', 'description', 'url']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const card = buildAgentCard({
          name: getStringArg(args, 'name'),
          description: getStringArg(args, 'description'),
          url: getStringArg(args, 'url'),
          ...(getOptionalStringArg(args, 'version') ? { version: getOptionalStringArg(args, 'version') as string } : {}),
          ...(getOptionalStringArg(args, 'protocolVersion') ? { protocolVersion: getOptionalStringArg(args, 'protocolVersion') as string } : {}),
        });
        const peer = state.registry.registerPeer({
          peerId: getStringArg(args, 'peerId'),
          card,
          tags: getStringArrayArg(args, 'tags'),
          ...(getOptionalStringArg(args, 'tenantId') ? { tenantId: getOptionalStringArg(args, 'tenantId') as string } : {}),
        });
        audit(state, 'peer-registered', 'local-user', `Peer ${peer.peerId} registered (card unverified).`, peer.peerId);
        return jsonResult({ peer });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_peer_list', 'List registered A2A peers, optionally filtered by tenant, tag, card status, or reachability.', { tenantId: { type: 'string' }, tag: { type: 'string' }, cardStatus: { type: 'string' }, reachableOnly: { type: 'boolean' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => {
        const status = getOptionalStringArg(args, 'cardStatus');
        const valid = ['verified', 'unsigned', 'invalid', 'unverified', 'stale'];
        if (status && !valid.includes(status)) return errorResult(`Unknown card status "${status}".`);
        return jsonResult({
          peers: state.registry.listPeers({
            ...(getOptionalStringArg(args, 'tenantId') ? { tenantId: getOptionalStringArg(args, 'tenantId') as string } : {}),
            ...(getOptionalStringArg(args, 'tag') ? { tag: getOptionalStringArg(args, 'tag') as string } : {}),
            ...(status ? { cardStatus: status as 'verified' | 'unsigned' | 'invalid' | 'unverified' | 'stale' } : {}),
            reachableOnly: getBooleanArg(args, 'reachableOnly', false),
          }),
        });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_peer_get', 'Show one registered A2A peer (card, verification status, reachability).', { peerId: { type: 'string' } }, ['peerId']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const peer = state.registry.getPeer(getStringArg(args, 'peerId'));
        if (!peer) return errorResult(`No peer "${getStringArg(args, 'peerId')}".`);
        return jsonResult({ peer });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_peer_remove', 'Remove a registered A2A peer (does not remove its allowlist entry — remove that separately).', { peerId: { type: 'string' } }, ['peerId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const peerId = getStringArg(args, 'peerId');
        if (!state.registry.removePeer(peerId)) return errorResult(`No peer "${peerId}".`);
        audit(state, 'peer-removed', 'local-user', `Peer ${peerId} removed from the registry.`, peerId);
        return jsonResult({ removed: true, peerId });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_peer_verify', 'Verify a peer Agent Card (shape + version negotiation + signature) and record the outcome.', { peerId: { type: 'string' }, requireSigned: { type: 'boolean' } }, ['peerId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const peerId = getStringArg(args, 'peerId');
        const peer = state.registry.getPeer(peerId);
        if (!peer) return errorResult(`No peer "${peerId}".`);
        const policy: FleetV29CardPolicy = {
          ...(state.cardPolicy ?? { requireSigned: true, minVersion: '1.0', maxVersion: '1.0.1', blockedKeyIds: [], unsignedAllowedFingerprints: [] }),
          ...(args['requireSigned'] !== undefined ? { requireSigned: getBooleanArg(args, 'requireSigned', true) } : {}),
        };
        const check = fleetV29CheckCard(peer.card, policy, peer.verifiedAt ? peer.cardFingerprint : undefined);
        state.registry.recordVerification(peerId, check.status, check.method, check.problems);
        audit(
          state,
          check.usable ? 'peer-card-verified' : 'peer-card-rejected',
          'local-user',
          `Peer ${peerId} card check: ${check.status}${check.problems.length > 0 ? ` — ${check.problems.join('; ')}` : ''}.`,
          peerId,
        );
        return jsonResult({ peerId, check });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_peer_health', 'Show per-peer health (score, p50/p95 latency, error rate, cost, task counts).', { peerId: { type: 'string' } }, ['peerId']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const peerId = getStringArg(args, 'peerId');
        const health = state.registry.peerHealth(peerId, state.board.activeCountForPeer(peerId));
        if (!health) return errorResult(`No peer "${peerId}".`);
        return jsonResult({ health });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_peer_samples', 'List recent latency/cost samples for a peer.', { peerId: { type: 'string' }, limit: { type: 'number' } }, ['peerId']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const peerId = getStringArg(args, 'peerId');
        if (!state.registry.getPeer(peerId)) return errorResult(`No peer "${peerId}".`);
        return jsonResult({ samples: state.registry.listSamples(peerId, getNumberArg(args, 'limit', 50)) });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_peer_record_sample', 'Record one latency/cost sample for a peer (feeds health scoring).', { peerId: { type: 'string' }, latencyMs: { type: 'number' }, costUsd: { type: 'number' }, failed: { type: 'boolean' }, taskId: { type: 'string' } }, ['peerId', 'latencyMs']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const peerId = getStringArg(args, 'peerId');
        if (!state.registry.getPeer(peerId)) return errorResult(`No peer "${peerId}".`);
        const latencyMs = getNumberArg(args, 'latencyMs', -1);
        if (latencyMs < 0) return errorResult('latencyMs must be >= 0.');
        const costUsd = getNumberArg(args, 'costUsd', 0);
        if (costUsd < 0) return errorResult('costUsd must be >= 0.');
        state.registry.recordSample({
          peerId,
          latencyMs,
          costUsd,
          failed: getBooleanArg(args, 'failed', false),
          at: new Date().toISOString(),
          ...(getOptionalStringArg(args, 'taskId') ? { taskId: getOptionalStringArg(args, 'taskId') as string } : {}),
        });
        return jsonResult({ recorded: true, peerId, health: state.registry.peerHealth(peerId, state.board.activeCountForPeer(peerId)) });
      }, resolveState),
    },
    // -- A2A task board -----------------------------------------------------
    {
      definition: toolDef('fleet_v29_board_submit', 'Delegate a task to an allowlisted, card-verified peer (gate fails closed; simulation mode when no A2A transport is wired).', { peerId: { type: 'string' }, delegatedBy: { type: 'string' }, title: { type: 'string' }, messageText: { type: 'string' }, contextId: { type: 'string' }, tenantId: { type: 'string' }, skillId: { type: 'string' }, operation: { type: 'string' } }, ['peerId', 'delegatedBy', 'title', 'messageText']),
      needsApproval: true,
      execute: wrap(async (state, args) => {
        const operation = getOptionalStringArg(args, 'operation');
        const validOps = ['SendMessage', 'SendStreamingMessage', 'GetTask', 'ListTasks', 'CancelTask', 'SubscribeToTask', 'GetExtendedAgentCard'];
        if (operation && !validOps.includes(operation)) return errorResult(`Unknown A2A operation "${operation}".`);
        const result = await state.board.submit({
          peerId: getStringArg(args, 'peerId'),
          delegatedBy: getStringArg(args, 'delegatedBy'),
          title: getStringArg(args, 'title'),
          messageText: getStringArg(args, 'messageText'),
          ...(getOptionalStringArg(args, 'contextId') ? { contextId: getOptionalStringArg(args, 'contextId') as string } : {}),
          ...(getOptionalStringArg(args, 'tenantId') ? { tenantId: getOptionalStringArg(args, 'tenantId') as string } : {}),
          ...(getOptionalStringArg(args, 'skillId') ? { skillId: getOptionalStringArg(args, 'skillId') as string } : {}),
          ...(operation ? { operation: operation as 'SendMessage' | 'SendStreamingMessage' | 'GetTask' | 'ListTasks' | 'CancelTask' | 'SubscribeToTask' | 'GetExtendedAgentCard' } : {}),
        });
        if (!result.ok) return errorResult(`Delegation refused: ${result.reasons.join('; ')}`);
        audit(state, 'delegation-created', getStringArg(args, 'delegatedBy'), `Task ${result.boardTask.task.id} delegated to peer ${result.boardTask.peerId}${state.board.transportWired ? '.' : ' (local simulation — no A2A transport wired).'}`, result.boardTask.peerId, result.boardTask.task.id);
        return jsonResult({ boardTask: result.boardTask, simulated: !state.board.transportWired });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_list', 'List board tasks with cursor pagination, optionally filtered by peer, state, or query.', { peerId: { type: 'string' }, state: { type: 'string' }, activeOnly: { type: 'boolean' }, query: { type: 'string' }, cursor: { type: 'string' }, pageSize: { type: 'number' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => {
        const stateFilter = getOptionalStringArg(args, 'state');
        const valid = ['submitted', 'working', 'input-required', 'auth-required', 'completed', 'failed', 'cancelled', 'rejected'];
        if (stateFilter && !valid.includes(stateFilter)) return errorResult(`Unknown task state "${stateFilter}".`);
        return jsonResult(state.board.listTasks({
          ...(getOptionalStringArg(args, 'peerId') ? { peerId: getOptionalStringArg(args, 'peerId') as string } : {}),
          ...(stateFilter ? { state: stateFilter as 'submitted' | 'working' | 'input-required' | 'auth-required' | 'completed' | 'failed' | 'cancelled' | 'rejected' } : {}),
          activeOnly: getBooleanArg(args, 'activeOnly', false),
          ...(getOptionalStringArg(args, 'query') ? { query: getOptionalStringArg(args, 'query') as string } : {}),
        }, getOptionalStringArg(args, 'cursor'), getNumberArg(args, 'pageSize', 20)));
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_get', 'Show one board task (A2A state, streaming progress, cost, latency).', { taskId: { type: 'string' } }, ['taskId']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const task = state.board.getTask(getStringArg(args, 'taskId'));
        if (!task) return errorResult(`No board task "${getStringArg(args, 'taskId')}".`);
        return jsonResult({ boardTask: task });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_start', 'Start a submitted board task (submitted → working).', { taskId: { type: 'string' } }, ['taskId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.board.start(getStringArg(args, 'taskId'));
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, 'delegation-state-changed', 'local-user', `Task ${result.task.task.id} submitted → working.`, result.task.peerId, result.task.task.id);
        return jsonResult({ boardTask: result.task });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_progress', 'Record streaming progress for a working board task.', { taskId: { type: 'string' }, partialText: { type: 'string' }, progress: { type: 'number' } }, ['taskId', 'partialText']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const task = state.board.progress(getStringArg(args, 'taskId'), getStringArg(args, 'partialText'), getOptionalNumberArg(args, 'progress'));
        if (!task) return errorResult(`No working board task "${getStringArg(args, 'taskId')}".`);
        return jsonResult({ boardTask: task });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_complete', 'Complete a board task with an optional result text.', { taskId: { type: 'string' }, resultText: { type: 'string' } }, ['taskId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.board.complete(getStringArg(args, 'taskId'), getOptionalStringArg(args, 'resultText') ?? undefined);
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, 'delegation-completed', 'local-user', `Task ${result.task.task.id} completed.`, result.task.peerId, result.task.task.id);
        return jsonResult({ boardTask: result.task });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_fail', 'Fail a board task with a reason.', { taskId: { type: 'string' }, reason: { type: 'string' } }, ['taskId', 'reason']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.board.fail(getStringArg(args, 'taskId'), getStringArg(args, 'reason'));
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, 'delegation-failed', 'local-user', `Task ${result.task.task.id} failed: ${getStringArg(args, 'reason')}.`, result.task.peerId, result.task.task.id);
        return jsonResult({ boardTask: result.task });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_cancel', 'Cancel a board task (user-initiated by default).', { taskId: { type: 'string' }, byUser: { type: 'boolean' }, reason: { type: 'string' } }, ['taskId']),
      needsApproval: true,
      execute: wrap(async (state, args) => {
        const result = await state.board.cancel(getStringArg(args, 'taskId'), getBooleanArg(args, 'byUser', true), getOptionalStringArg(args, 'reason') ?? undefined);
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, 'delegation-cancelled', 'local-user', `Task ${result.task.task.id} cancelled${getBooleanArg(args, 'byUser', true) ? ' by user' : ''}.`, result.task.peerId, result.task.task.id);
        return jsonResult({ boardTask: result.task });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_input', 'Answer a board task waiting for input (input-required → working).', { taskId: { type: 'string' }, answer: { type: 'string' } }, ['taskId', 'answer']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.board.provideInput(getStringArg(args, 'taskId'), getStringArg(args, 'answer'));
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, 'task-input-provided', 'local-user', `Input provided for task ${result.task.task.id}; back to working.`, result.task.peerId, result.task.task.id);
        return jsonResult({ boardTask: result.task });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_cost', 'Record cost/latency for a board task and check its per-task cost cap.', { taskId: { type: 'string' }, costUsd: { type: 'number' }, latencyMs: { type: 'number' } }, ['taskId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const taskId = getStringArg(args, 'taskId');
        const task = state.board.recordCost(taskId, getNumberArg(args, 'costUsd', 0), getOptionalNumberArg(args, 'latencyMs'));
        if (!task) return errorResult(`No board task "${taskId}".`);
        return jsonResult({ boardTask: task, costCapBreached: state.board.costCapBreached(taskId) });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_board_cancel_all', 'Cancel every active board task for one peer (e.g. the peer is going down).', { peerId: { type: 'string' }, byUser: { type: 'boolean' }, reason: { type: 'string' } }, ['peerId']),
      needsApproval: true,
      execute: wrap(async (state, args) => {
        const peerId = getStringArg(args, 'peerId');
        if (!state.registry.getPeer(peerId)) return errorResult(`No peer "${peerId}".`);
        const result = await state.board.cancelAllForPeer(peerId, getBooleanArg(args, 'byUser', true), getOptionalStringArg(args, 'reason') ?? undefined);
        for (const taskId of result.cancelled) {
          audit(state, 'delegation-cancelled', 'local-user', `Task ${taskId} cancelled (bulk cancel for peer ${peerId}).`, peerId, taskId);
        }
        return jsonResult(result);
      }, resolveState),
    },
    // -- allowlist admin ----------------------------------------------------
    {
      definition: toolDef('fleet_v29_allowlist_add', 'Add a peer to the allowlist with a least-privilege scope.', { peerId: { type: 'string' }, addedBy: { type: 'string' }, reason: { type: 'string' }, expiresAt: { type: 'string' }, allowedSkills: { type: 'array', items: { type: 'string' } }, allowedOperations: { type: 'array', items: { type: 'string' } }, maxCostUsdPerTask: { type: 'number' }, maxConcurrentTasks: { type: 'number' }, sensitiveActionsAllowed: { type: 'array', items: { type: 'string' } } }, ['peerId', 'addedBy']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const peerId = getStringArg(args, 'peerId');
        if (!state.registry.getPeer(peerId)) return errorResult(`Peer "${peerId}" is not registered — register it first.`);
        const result = state.allowlist.add(peerId, getStringArg(args, 'addedBy'), {
          allowedSkills: getStringArrayArg(args, 'allowedSkills').length > 0 ? getStringArrayArg(args, 'allowedSkills') : undefined,
          allowedOperations: getStringArrayArg(args, 'allowedOperations').length > 0 ? getStringArrayArg(args, 'allowedOperations') as never : undefined,
          maxCostUsdPerTask: getOptionalNumberArg(args, 'maxCostUsdPerTask') ?? undefined,
          maxConcurrentTasks: args['maxConcurrentTasks'] === undefined ? undefined : getNumberArg(args, 'maxConcurrentTasks', 3),
          sensitiveActionsAllowed: getStringArrayArg(args, 'sensitiveActionsAllowed') as FleetV29SensitiveAction[],
        }, {
          reason: getOptionalStringArg(args, 'reason') ?? '',
          expiresAt: getOptionalStringArg(args, 'expiresAt'),
        });
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, result.change.kind, getStringArg(args, 'addedBy'), result.change.detail, peerId);
        return jsonResult({ entry: result.entry });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_allowlist_list', 'List allowlist entries with their scopes and expiry.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ entries: state.allowlist.list() }), resolveState),
    },
    {
      definition: toolDef('fleet_v29_allowlist_get', 'Show one allowlist entry (scope, added by, expiry, suspended).', { peerId: { type: 'string' } }, ['peerId']),
      needsApproval: false,
      execute: wrap((state, args) => {
        const entry = state.allowlist.get(getStringArg(args, 'peerId'));
        if (!entry) return errorResult(`No allowlist entry for peer "${getStringArg(args, 'peerId')}".`);
        return jsonResult({ entry });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_allowlist_remove', 'Remove a peer from the allowlist (delegation to it stops immediately).', { peerId: { type: 'string' } }, ['peerId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.allowlist.remove(getStringArg(args, 'peerId'));
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, result.change.kind, 'local-user', result.change.detail, getStringArg(args, 'peerId'));
        return jsonResult({ removed: true, peerId: getStringArg(args, 'peerId') });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_allowlist_suspend', 'Suspend an allowlist entry (peer kept, but not usable).', { peerId: { type: 'string' } }, ['peerId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.allowlist.suspend(getStringArg(args, 'peerId'));
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, result.change.kind, 'local-user', result.change.detail, getStringArg(args, 'peerId'));
        return jsonResult({ suspended: true, peerId: getStringArg(args, 'peerId') });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_allowlist_resume', 'Resume a suspended allowlist entry.', { peerId: { type: 'string' } }, ['peerId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.allowlist.resume(getStringArg(args, 'peerId'));
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, result.change.kind, 'local-user', result.change.detail, getStringArg(args, 'peerId'));
        return jsonResult({ resumed: true, peerId: getStringArg(args, 'peerId') });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_allowlist_scope', 'Update a peer allowlist scope (skills, operations, caps, sensitive actions).', { peerId: { type: 'string' }, allowedSkills: { type: 'array', items: { type: 'string' } }, allowedOperations: { type: 'array', items: { type: 'string' } }, maxCostUsdPerTask: { type: 'number' }, maxConcurrentTasks: { type: 'number' }, sensitiveActionsAllowed: { type: 'array', items: { type: 'string' } } }, ['peerId']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.allowlist.updateScope(getStringArg(args, 'peerId'), {
          allowedSkills: args['allowedSkills'] === undefined ? undefined : getStringArrayArg(args, 'allowedSkills'),
          allowedOperations: args['allowedOperations'] === undefined ? undefined : getStringArrayArg(args, 'allowedOperations') as never,
          maxCostUsdPerTask: getOptionalNumberArg(args, 'maxCostUsdPerTask') ?? undefined,
          maxConcurrentTasks: args['maxConcurrentTasks'] === undefined ? undefined : getNumberArg(args, 'maxConcurrentTasks', 3),
          sensitiveActionsAllowed: args['sensitiveActionsAllowed'] === undefined ? undefined : getStringArrayArg(args, 'sensitiveActionsAllowed') as FleetV29SensitiveAction[],
        });
        if (!result.ok) return errorResult(result.reasons.join('; '));
        return jsonResult({ entry: result.entry });
      }, resolveState),
    },
    // -- audit log ----------------------------------------------------------
    {
      definition: toolDef('fleet_v29_audit_list', 'List audit entries (delegation, allowlist, card, sensitive decisions), newest last.', { kind: { type: 'string' }, peerId: { type: 'string' }, taskId: { type: 'string' }, limit: { type: 'number' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => jsonResult({
        entries: state.audit.query({
          ...(getOptionalStringArg(args, 'kind') ? { kind: getOptionalStringArg(args, 'kind') as FleetV29AuditKind } : {}),
          ...(getOptionalStringArg(args, 'peerId') ? { peerId: getOptionalStringArg(args, 'peerId') as string } : {}),
          ...(getOptionalStringArg(args, 'taskId') ? { taskId: getOptionalStringArg(args, 'taskId') as string } : {}),
          limit: getNumberArg(args, 'limit', 100),
        }),
      }), resolveState),
    },
    {
      definition: toolDef('fleet_v29_audit_verify', 'Verify the audit log hash chain (detects edits, deletions, reordering).', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ verification: state.audit.verifyChain(), entries: state.audit.count() }), resolveState),
    },
    {
      definition: toolDef('fleet_v29_audit_export', 'Export the audit log as newline-delimited JSON.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ ndjson: state.audit.toNdjson(), entries: state.audit.count() }), resolveState),
    },
    // -- sensitive confirmations --------------------------------------------
    {
      definition: toolDef('fleet_v29_confirm_request', 'Request user confirmation for a sensitive action on a task (peer requests, never approves).', { peerId: { type: 'string' }, taskId: { type: 'string' }, action: { type: 'string' }, summary: { type: 'string' }, amountUsd: { type: 'number' } }, ['peerId', 'taskId', 'action', 'summary']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const action = getStringArg(args, 'action');
        const valid = ['purchase', 'payment', 'secret-access', 'file-write-outside-sandbox', 'external-send', 'account-change'];
        if (!valid.includes(action)) return errorResult(`Unknown sensitive action "${action}".`);
        const result = state.confirmations.request({
          peerId: getStringArg(args, 'peerId'),
          taskId: getStringArg(args, 'taskId'),
          action: action as FleetV29SensitiveAction,
          summary: getStringArg(args, 'summary'),
          amountUsd: getOptionalNumberArg(args, 'amountUsd'),
        });
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, 'sensitive-requested', getStringArg(args, 'peerId'), `Peer ${getStringArg(args, 'peerId')} requested sensitive action "${action}" on task ${getStringArg(args, 'taskId')}.`, getStringArg(args, 'peerId'), getStringArg(args, 'taskId'));
        return jsonResult({ confirmation: result.confirmation });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_confirm_list', 'List sensitive confirmation requests, optionally filtered by status, peer, or task.', { status: { type: 'string' }, peerId: { type: 'string' }, taskId: { type: 'string' } }, []),
      needsApproval: false,
      execute: wrap((state, args) => {
        const status = getOptionalStringArg(args, 'status');
        const valid = ['pending', 'approved', 'denied', 'expired'];
        if (status && !valid.includes(status)) return errorResult(`Unknown confirmation status "${status}".`);
        return jsonResult({
          confirmations: state.confirmations.list({
            ...(status ? { status: status as 'pending' | 'approved' | 'denied' | 'expired' } : {}),
            ...(getOptionalStringArg(args, 'peerId') ? { peerId: getOptionalStringArg(args, 'peerId') as string } : {}),
            ...(getOptionalStringArg(args, 'taskId') ? { taskId: getOptionalStringArg(args, 'taskId') as string } : {}),
          }),
        });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_confirm_approve', 'Approve a pending sensitive-action request (user only).', { id: { type: 'string' }, decidedBy: { type: 'string' } }, ['id', 'decidedBy']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.confirmations.approve(getStringArg(args, 'id'), getStringArg(args, 'decidedBy'));
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, 'sensitive-approved', getStringArg(args, 'decidedBy'), `Sensitive action "${result.confirmation.action}" approved for task ${result.confirmation.taskId}.`, result.confirmation.peerId, result.confirmation.taskId);
        return jsonResult({ confirmation: result.confirmation });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_confirm_deny', 'Deny a pending sensitive-action request (user only).', { id: { type: 'string' }, decidedBy: { type: 'string' } }, ['id', 'decidedBy']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const result = state.confirmations.deny(getStringArg(args, 'id'), getStringArg(args, 'decidedBy'));
        if (!result.ok) return errorResult(result.reasons.join('; '));
        audit(state, 'sensitive-denied', getStringArg(args, 'decidedBy'), `Sensitive action "${result.confirmation.action}" denied for task ${result.confirmation.taskId}.`, result.confirmation.peerId, result.confirmation.taskId);
        return jsonResult({ confirmation: result.confirmation });
      }, resolveState),
    },
    // -- snapshot (host persistence) --------------------------------------
    {
      definition: toolDef('fleet_v29_snapshot_save', 'Save the fleet v29 snapshot (peer registry + allowlist + samples) as JSON.', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult({ snapshot: buildFleetV29Snapshot({ registry: state.registry, allowlist: state.allowlist }) }), resolveState),
    },
    {
      definition: toolDef('fleet_v29_snapshot_load', 'Load a fleet v29 snapshot JSON (peers restore as unverified — trust is re-earned).', { snapshotJson: { type: 'string' } }, ['snapshotJson']),
      needsApproval: true,
      execute: wrap((state, args) => {
        const parsed = fleetV29SnapshotFromJson(getStringArg(args, 'snapshotJson'));
        if (!parsed.ok) return errorResult(`Snapshot refused: ${parsed.reasons.join('; ')}`);
        const result = restoreFleetV29Snapshot(parsed.snapshot, { registry: state.registry, allowlist: state.allowlist });
        if (!result.ok) return errorResult(`Snapshot refused: ${result.reasons.join('; ')}`);
        return jsonResult(result);
      }, resolveState),
    },
    // -- rollups ------------------------------------------------------------
    {
      definition: toolDef('fleet_v29_health', 'Fleet health summary (peers by level, task counts, cost, pending confirmations, alerts).', {}, []),
      needsApproval: false,
      execute: wrap((state) => {
        const summary = buildFleetV29HealthSummary({
          registry: state.registry,
          board: state.board,
          allowlist: state.allowlist,
          pendingConfirmations: state.confirmations.pendingCount(),
        });
        return jsonResult({ summary, alerts: fleetV29HealthAlerts(summary) });
      }, resolveState),
    },
    {
      definition: toolDef('fleet_v29_dashboard', 'Combined fleet v29 dashboard (health + board summary + allowlist + audit counts).', {}, []),
      needsApproval: false,
      execute: wrap((state) => jsonResult(buildFleetV29Dashboard({
        registry: state.registry,
        board: state.board,
        allowlist: state.allowlist,
        audit: state.audit,
        confirmations: state.confirmations,
      })), resolveState),
    },
  ];

  return defs as Tool[];
}

/** The runnable v29 tools, for ALL_TOOLS (unbound until the host wires state). */
export const FLEET_V29_TOOLS: Tool[] = createFleetV29Tools();
